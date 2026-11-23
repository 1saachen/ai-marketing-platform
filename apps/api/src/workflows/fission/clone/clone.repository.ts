import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CLONE_INPUT_ARTIFACT_KEY,
  emptyCloneInputDraft,
  normalizeCloneInputDraft,
  type CloneInputConfirmRequest,
  type CloneUpload,
  type CloneUploadRole,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { ApiHttpException } from '../../../common/api-http-exception';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
} from '../../../platform/workflow/workflow-working.repository';
import {
  lockCloneRun,
  validateCloneInputUploads,
} from '../../../platform/workflow/fission-clone-scope';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { assertNoActiveCloneTasks } from './clone-task-scope';

function conflict(message: string): never {
  throw new ApiHttpException(message, 409, 'CONFLICT');
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
const scope = (projectId: string, workflowRunId: string) => ({ projectId, workflowRunId });
const uploadInclude = { fileObject: true } as const;

@Injectable()
export class CloneRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService,
  ) {}

  async initialize(projectId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project) throw new ApiHttpException('项目不存在', 404, 'PROJECT_NOT_FOUND');
      if (project.deletionState)
        throw new ApiHttpException('项目正在删除', 409, 'PROJECT_DELETING');
      const key = {
        projectId,
        workflow: 'FISSION' as const,
        workflowSpace: 'FISSION_CLONE' as const,
        activeKey: 'ACTIVE',
      };
      let run = await tx.workflowRun.upsert({
        where: { projectId_workflow_workflowSpace_activeKey: key },
        create: { ...key, currentNodeId: 'CLONE_INPUT' },
        update: {},
      });
      if (run.status === 'COMPLETED') conflict('该工作流已结束');
      if (run.status === 'PAUSED') {
        // Fence requests from the previous editing session without changing confirmed revisions.
        await tx.workflowNodeState.updateMany({
          where: scope(projectId, run.id),
          data: { revision: { increment: 1 } },
        });
        await tx.fissionCloneUpload.updateMany({
          where: { ...scope(projectId, run.id), status: 'UPLOADING' },
          data: { status: 'FAILED' },
        });
        run = await tx.workflowRun.update({
          where: { id: run.id },
          data: { status: 'ACTIVE', lastActiveAt: new Date() },
        });
      }
      const state = emptyCloneInputDraft();
      await tx.workflowNodeState.upsert({
        where: {
          projectId_workflowRunId_nodeId: { ...scope(projectId, run.id), nodeId: 'CLONE_INPUT' },
        },
        create: {
          ...scope(projectId, run.id),
          nodeId: 'CLONE_INPUT',
          state: json(state),
          contentHash: workflowStateHash(state),
        },
        update: {},
      });
      return run.id;
    });
  }

  async workspace(projectId: string, runId: string) {
    return this.prisma.$transaction(async (tx) => {
      const run = await lockCloneRun(tx, projectId, runId);
      const [draft, uploads, input] = await Promise.all([
        tx.workflowNodeState.findUnique({
          where: {
            projectId_workflowRunId_nodeId: { ...scope(projectId, runId), nodeId: 'CLONE_INPUT' },
          },
        }),
        tx.fissionCloneUpload.findMany({
          where: { ...scope(projectId, runId), status: 'AVAILABLE' },
          include: uploadInclude,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        tx.workingArtifact.findUnique({
          where: {
            projectId_workflowRunId_nodeId_artifactKey: {
              ...scope(projectId, runId),
              nodeId: 'CLONE_INPUT',
              artifactKey: CLONE_INPUT_ARTIFACT_KEY,
            },
          },
        }),
      ]);
      return { run, draft, uploads, input };
    });
  }

  async beginUpload(projectId: string, runId: string, clientUploadKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_INPUT' });
      await tx.fissionCloneUpload.updateMany({
        where: {
          ...scope(projectId, runId),
          status: 'UPLOADING',
          expiresAt: { lte: new Date() },
        },
        data: { status: 'FAILED' },
      });
      const unique = { ...scope(projectId, runId), clientUploadKey };
      const existing = await tx.fissionCloneUpload.findUnique({
        where: { projectId_workflowRunId_clientUploadKey: unique },
        include: uploadInclude,
      });
      if (existing?.status === 'AVAILABLE') return existing;
      if (existing?.status === 'UPLOADING' && existing.expiresAt > new Date())
        conflict('该文件正在上传，请等待当前上传结束');
      if (existing?.status === 'REMOVED') conflict('该上传已移除，请重新选择文件');
      const count = await tx.fissionCloneUpload.count({
        where: { ...scope(projectId, runId), status: { in: ['UPLOADING', 'AVAILABLE'] } },
      });
      if (count >= 80) conflict('工作区暂存文件已达上限，请先移除未使用的文件');
      return tx.fissionCloneUpload.upsert({
        where: { projectId_workflowRunId_clientUploadKey: unique },
        create: { ...unique, status: 'UPLOADING', expiresAt: new Date(Date.now() + 30 * 60_000) },
        update: {
          status: 'UPLOADING',
          attemptToken: randomUUID(),
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
        include: uploadInclude,
      });
    });
  }

  async finishUpload(
    projectId: string,
    runId: string,
    uploadId: string,
    attemptToken: string,
    role: CloneUploadRole,
    file: FileObjectInput,
    media: CloneUpload['media'],
    source?: { assetId: string; version: number },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_INPUT' });
      const upload = await tx.fissionCloneUpload.findFirst({
        where: { id: uploadId, ...scope(projectId, runId) },
        include: uploadInclude,
      });
      if (!upload || upload.attemptToken !== attemptToken)
        conflict('该上传尝试已失效，请使用最新上传结果');
      if (upload?.status === 'AVAILABLE') {
        if (upload.role !== role || upload.fileObject?.sha256 !== file.sha256)
          conflict('同一上传标识对应不同文件');
        return upload;
      }
      if (!upload || upload.status !== 'UPLOADING' || upload.expiresAt <= new Date())
        conflict('上传已过期或当前编辑已退出，请重新上传');
      const object = await this.working.upsertFileObjectInTransaction(tx, projectId, runId, file);
      return tx.fissionCloneUpload.update({
        where: { id: uploadId },
        data: {
          status: 'AVAILABLE',
          role,
          fileObjectId: object.id,
          media: json(media),
          sourceAssetId: source?.assetId ?? null,
          sourceAssetVersion: source?.version ?? null,
        },
        include: uploadInclude,
      });
    });
  }

  async failUpload(projectId: string, runId: string, uploadId: string, attemptToken: string) {
    await this.prisma.fissionCloneUpload.updateMany({
      where: { ...scope(projectId, runId), id: uploadId, attemptToken, status: 'UPLOADING' },
      data: { status: 'FAILED' },
    });
  }

  async removeUpload(projectId: string, runId: string, uploadId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_INPUT' });
      const upload = await tx.fissionCloneUpload.findFirst({
        where: { ...scope(projectId, runId), id: uploadId },
        include: uploadInclude,
      });
      if (!upload || upload.status === 'REMOVED') return;
      const draft = await tx.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: { ...scope(projectId, runId), nodeId: 'CLONE_INPUT' },
        },
      });
      const state = draft ? normalizeCloneInputDraft(draft.state) : emptyCloneInputDraft();
      if (state.referenceUploadId === uploadId || state.productUploadIds.includes(uploadId))
        conflict('请先保存移除该文件后的草稿');
      if (
        upload.fileObjectId &&
        (await tx.fileObject.count({
          where: {
            projectId,
            id: upload.fileObjectId,
            OR: [
              { artifactLinks: { some: {} } },
              { revisionLinks: { some: {} } },
              { cloneUploads: { some: { id: { not: uploadId }, status: 'AVAILABLE' } } },
            ],
          },
        }))
      )
        conflict('已确认内容仍在使用该文件，暂时不能删除');
      await tx.fissionCloneUpload.update({
        where: { id: uploadId },
        data: { status: 'REMOVED', fileObjectId: null },
      });
      if (upload.fileObject) {
        await tx.fileObject.update({
          where: { id: upload.fileObject.id },
          data: { status: 'ORPHANED', orphanedAt: new Date() },
        });
        await tx.storageCleanupTask.upsert({
          where: { projectId_storageKey: { projectId, storageKey: upload.fileObject.storageKey } },
          create: {
            projectId,
            storageKey: upload.fileObject.storageKey,
            reason: 'CLONE_UPLOAD_REMOVED',
          },
          update: {},
        });
      }
    });
  }

  async confirm(projectId: string, runId: string, request: CloneInputConfirmRequest) {
    return this.prisma.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_INPUT' });
      if (this.config?.get<boolean>('FISSION_CLONE_G2_ENABLED') === true)
        await assertNoActiveCloneTasks(tx, projectId, runId);
      const draft = await tx.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: { ...scope(projectId, runId), nodeId: 'CLONE_INPUT' },
        },
      });
      if (!draft || draft.revision !== request.expectedDraftRevision)
        conflict('草稿已发生变化，请刷新后确认');
      const state = await validateCloneInputUploads(tx, projectId, runId, draft.state);
      if (!state.referenceUploadId || !state.sourceRightsConfirmed)
        throw new ApiHttpException('请选择参考视频并确认来源使用权限', 400, 'VALIDATION_ERROR');
      const ids = [state.referenceUploadId, ...state.productUploadIds];
      const uploads = await tx.fissionCloneUpload.findMany({
        where: { ...scope(projectId, runId), id: { in: ids }, status: 'AVAILABLE' },
        include: uploadInclude,
      });
      const ordered = ids.map((id) => uploads.find((u) => u.id === id)!);
      const previous = await tx.workingArtifact.findUnique({
        where: {
          projectId_workflowRunId_nodeId_artifactKey: {
            ...scope(projectId, runId),
            nodeId: 'CLONE_INPUT',
            artifactKey: CLONE_INPUT_ARTIFACT_KEY,
          },
        },
      });
      const files = ordered.map((u) => ({
        uploadId: u.id,
        fileObjectId: u.fileObjectId!,
        sha256: u.fileObject!.sha256,
        sizeBytes: u.fileObject!.sizeBytes,
        role: u.role,
        media: u.media,
        sourceAssetId: u.sourceAssetId,
        sourceAssetVersion: u.sourceAssetVersion,
      }));
      const payload = { input: state, files };
      // Permit a lost-success-response replay only when the confirmed content is identical.
      if (
        (previous?.revision ?? 0) !== request.expectedInputRevision &&
        workflowStateHash(previous?.payload ?? null) !== workflowStateHash(payload)
      )
        conflict('确认内容已更新，请刷新后重试');
      await this.working.commitValidatedArtifactsInTransaction(
        tx,
        projectId,
        runId,
        'CLONE_INPUT',
        [
          {
            artifactKey: CLONE_INPUT_ARTIFACT_KEY,
            input: {
              kind: 'STRUCTURED',
              name: state.productName
                ? `${Array.from(state.productName).slice(0, 113).join('')} · 复刻输入`
                : '复刻输入',
              directory: 'SOURCE_MATERIALS',
              type: 'SOURCE_MATERIAL',
              payload,
              ...(previous ? { expectedRevision: previous.revision } : {}),
              files: ordered.map((u, i) => ({
                fileObjectId: u.fileObjectId!,
                role: u.role!,
                sortOrder: i,
                originalFileName: u.fileObject!.originalFileName,
                mimeType: u.fileObject!.mimeType,
                sha256: u.fileObject!.sha256,
              })),
            },
          },
        ],
      );
    });
  }
}
