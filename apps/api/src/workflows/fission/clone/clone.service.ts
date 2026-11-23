import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  emptyCloneInputDraft,
  FISSION_CLONE_INPUT_LIMITS,
  normalizeCloneInputDraft,
  parseCloneInputConfirmRequest,
  type CloneCapabilities,
  type CloneUpload,
  type CloneUploadRole,
  type CloneWorkspace,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { AssetService, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { normalizeMultipartFileName } from '../../../platform/file/file-name';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { ProjectService } from '../../../platform/project/project.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { CloneRepository } from './clone.repository';
import { CloneMediaService } from './clone-media.service';
import { CloneTaskRepository } from './clone-task.repository';
import { cloneGenerationConfigured } from './clone-generation-config';

type UploadRecord = Awaited<ReturnType<CloneRepository['beginUpload']>>;
@Injectable()
export class CloneService {
  constructor(
    @Inject(CloneRepository) private readonly repository: CloneRepository,
    @Inject(CloneMediaService) private readonly media: CloneMediaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(AssetService) private readonly assets: AssetService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Optional() @Inject(CloneTaskRepository) private readonly tasks?: CloneTaskRepository,
  ) {}

  capabilities(): CloneCapabilities {
    const enabled = this.config.get<boolean>('FISSION_CLONE_ENABLED') === true;
    const g2 = enabled && this.config.get<boolean>('FISSION_CLONE_G2_ENABLED') === true;
    const analysis =
      g2 &&
      Boolean(this.config.get<string>('FISSION_CLONE_ANALYSIS_MODEL')) &&
      Boolean(this.config.get<string>('FISSION_CLONE_ANALYSIS_WORKER_TOKEN'));
    const generation = g2 && Boolean(cloneGenerationConfigured(this.config));
    return {
      inputEnabled: enabled,
      analysisEnabled: analysis,
      mappingEnabled: g2,
      mappingSuggestionsEnabled: analysis,
      keepTextValidationEnabled: analysis,
      analysisMode: 'SAMPLED_FRAMES',
      audioTranscriptionEnabled: false,
      originalTrackKeepEnabled: false,
      burnedInKeepEnabled: false,
      generationEnabled: generation,
      unavailableReason: enabled
        ? g2
          ? analysis
            ? generation
              ? null
              : '逐镜头成片生成尚未启用，请核对生成和审片服务配置'
            : '拆解模型或独立执行服务尚未配置；可浏览已有报告和编辑映射'
          : '真实拆解与成片生成尚未开放'
        : '爆款复刻真实输入尚未启用，请完成数据库迁移及媒体服务配置',
      limits: {
        ...FISSION_CLONE_INPUT_LIMITS,
        maxReferenceBytes: Math.min(
          FISSION_CLONE_INPUT_LIMITS.maxReferenceBytes,
          this.config.get<number>('MAX_UPLOAD_BYTES') ??
            FISSION_CLONE_INPUT_LIMITS.maxReferenceBytes,
        ),
        maxProductBytes: Math.min(
          FISSION_CLONE_INPUT_LIMITS.maxProductBytes,
          this.config.get<number>('MAX_UPLOAD_BYTES') ?? FISSION_CLONE_INPUT_LIMITS.maxProductBytes,
        ),
      },
      referenceExtensions: ['.mp4', '.mov'],
      productExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'],
    };
  }
  private assertEnabled() {
    if (!this.capabilities().inputEnabled)
      throw new ApiHttpException(
        this.capabilities().unavailableReason!,
        503,
        'CLONE_CAPABILITY_UNAVAILABLE',
      );
  }

  async initialize(projectId: string): Promise<CloneWorkspace> {
    this.assertEnabled();
    await this.projects.get(projectId);
    return this.workspace(projectId, await this.repository.initialize(projectId));
  }
  async workspace(projectId: string, runId: string): Promise<CloneWorkspace> {
    this.assertEnabled();
    await this.projects.get(projectId);
    const result = await this.repository.workspace(projectId, runId);
    const run = result.run;
    const input = result.input?.payload as { input?: unknown } | null;
    const uploads = result.uploads.filter((u) => u.fileObject).map((u) => this.presentUpload(u));
    const confirmed = input?.input ? normalizeCloneInputDraft(input.input) : null;
    return {
      run: {
        id: run.id,
        projectId,
        workflow: run.workflow,
        workflowSpace: run.workflowSpace,
        status: run.status,
        parentWorkflowRunId: null,
        forkNodeId: null,
        forkTemplateId: null,
        branchLabel: null,
        currentNodeId: run.currentNodeId,
        lastActiveAt: run.lastActiveAt.toISOString(),
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      },
      draft: {
        revision: result.draft?.revision ?? 0,
        state: result.draft ? normalizeCloneInputDraft(result.draft.state) : emptyCloneInputDraft(),
      },
      uploads,
      input:
        confirmed && result.input
          ? {
              ref: {
                artifactId: result.input.id,
                revision: result.input.revision,
                contentHash: result.input.contentHash,
              },
              input: confirmed,
              files: [confirmed.referenceUploadId, ...confirmed.productUploadIds].flatMap(
                (id) => uploads.find((u) => u.id === id) ?? [],
              ),
            }
          : null,
      capabilities: this.capabilities(),
      ...(this.config.get<boolean>('FISSION_CLONE_G2_ENABLED') === true && this.tasks
        ? { g2: await this.tasks.workspace(projectId, runId) }
        : {}),
    };
  }
  presentUpload(upload: UploadRecord): CloneUpload {
    const file = upload.fileObject;
    if (!file || upload.status !== 'AVAILABLE' || !upload.role)
      throw new ApiHttpException('上传文件不可用', 404, 'ASSET_NOT_FOUND');
    return {
      id: upload.id,
      fileObjectId: file.id,
      role: upload.role as CloneUploadRole,
      originalFileName: file.originalFileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      media: upload.media as CloneUpload['media'],
      contentUrl: `/api/projects/${upload.projectId}/file-objects/${file.id}/content`,
    };
  }
  async beginUpload(projectId: string, runId: string, key: string) {
    this.assertEnabled();
    await this.projects.get(projectId);
    return this.repository.beginUpload(projectId, runId, key);
  }
  failUpload(projectId: string, runId: string, uploadId: string, attemptToken: string) {
    return this.repository.failUpload(projectId, runId, uploadId, attemptToken);
  }

  async upload(
    projectId: string,
    runId: string,
    upload: UploadRecord,
    role: unknown,
    file: UploadedAssetFile | undefined,
    source?: { assetId: string; version: number },
  ): Promise<CloneUpload> {
    this.assertEnabled();
    let storedKey: string | undefined;
    try {
      if (role !== 'REFERENCE' && role !== 'PRODUCT')
        throw new ApiHttpException('请选择有效的素材用途', 400, 'VALIDATION_ERROR');
      if (!file) throw new ApiHttpException('请选择文件', 400, 'FILE_REQUIRED');
      const originalname = normalizeMultipartFileName(file.originalname);
      if (originalname.length > 255)
        throw new ApiHttpException('文件名过长', 400, 'VALIDATION_ERROR');
      const inspected = await this.media.inspect(
        { ...file, originalname },
        role,
        this.capabilities().limits,
      );
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file.path)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      if (upload.status === 'AVAILABLE') {
        if (
          upload.role !== role ||
          upload.fileObject?.sha256 !== sha256 ||
          upload.sourceAssetId !== (source?.assetId ?? null) ||
          upload.sourceAssetVersion !== (source?.version ?? null)
        )
          throw new ApiHttpException('同一上传标识对应不同文件或来源版本', 409, 'CONFLICT');
        return this.presentUpload(upload);
      }
      const project = await this.projects.get(projectId);
      const stored = await this.storage.put({
        projectId,
        stream: createReadStream(file.path),
        sizeBytes: file.size,
        contentType: inspected.mimeType,
        keyContext: {
          projectName: project.name,
          workflow: 'FISSION',
          lifecycle: 'staging',
          category: 'clone-input',
          originalFileName: originalname,
        },
      });
      storedKey = stored.key;
      const result = await this.repository.finishUpload(
        projectId,
        runId,
        upload.id,
        upload.attemptToken,
        role,
        {
          nodeId: 'CLONE_INPUT',
          originalFileName: originalname,
          mimeType: inspected.mimeType,
          sizeBytes: file.size,
          storageKey: stored.key,
          sha256,
        },
        inspected.media,
        source,
      );
      storedKey = undefined;
      return this.presentUpload(result);
    } finally {
      try {
        if (storedKey)
          await this.working.enqueueCleanup(projectId, storedKey, 'CLONE_UPLOAD_UNBOUND');
      } finally {
        if (file) await rm(file.path, { force: true }).catch(() => undefined);
      }
    }
  }

  async importAsset(
    projectId: string,
    runId: string,
    input: { assetId: string; version: number; role: CloneUploadRole; clientUploadKey: string },
  ) {
    this.assertEnabled();
    const upload = await this.beginUpload(projectId, runId, input.clientUploadKey);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'clone-asset-'));
      const asset = await this.assets.getVersion(projectId, input.assetId, input.version);
      if (asset.status !== 'AVAILABLE')
        throw new ApiHttpException('所选资产版本不可用', 400, 'ASSET_NOT_FOUND');
      const content = await this.assets.content(projectId, input.assetId, undefined, input.version);
      const limit =
        input.role === 'REFERENCE'
          ? this.capabilities().limits.maxReferenceBytes
          : this.capabilities().limits.maxProductBytes;
      if (content.sizeBytes > limit) {
        content.stream.destroy();
        throw new ApiHttpException('所选资产超过文件大小限制', 400, 'FILE_TOO_LARGE');
      }
      const path = join(directory, 'source');
      let receivedBytes = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.length;
          if (receivedBytes > limit) {
            callback(new ApiHttpException('所选资产超过文件大小限制', 400, 'FILE_TOO_LARGE'));
          } else callback(null, chunk);
        },
      });
      await pipeline(content.stream, bounded, createWriteStream(path));
      return await this.upload(
        projectId,
        runId,
        upload,
        input.role,
        {
          path,
          originalname: content.originalFileName,
          mimetype: content.mimeType,
          size: (await stat(path)).size,
        },
        { assetId: input.assetId, version: input.version },
      );
    } finally {
      try {
        await this.failUpload(projectId, runId, upload.id, upload.attemptToken);
      } finally {
        if (directory) {
          try {
            await rm(join(directory, 'source'), { force: true });
          } finally {
            await rmdir(directory);
          }
        }
      }
    }
  }
  async remove(projectId: string, runId: string, uploadId: string) {
    this.assertEnabled();
    await this.repository.removeUpload(projectId, runId, uploadId);
    return { removed: true };
  }
  async confirm(projectId: string, runId: string, body: unknown) {
    this.assertEnabled();
    let request;
    try {
      request = parseCloneInputConfirmRequest(body);
    } catch {
      throw new ApiHttpException('确认请求格式无效', 400, 'VALIDATION_ERROR');
    }
    await this.repository.confirm(projectId, runId, request);
    return this.workspace(projectId, runId);
  }
}
