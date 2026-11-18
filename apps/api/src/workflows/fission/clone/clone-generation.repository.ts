import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CLONE_MAPPING_ARTIFACT_KEY,
  CLONE_GENERATION_LIMITS,
  cloneBatchArtifactKey,
  cloneVideoArtifactKey,
  parseCloneGenerationVariantDraft,
  parseCloneGenerationVariantReview,
  type CloneArtifactRef,
  type CloneGenerationBatch,
  type CloneGenerationClaim,
  type CloneGenerationCreateRequest,
  type CloneGenerationFile,
  type CloneGenerationList,
  type CloneGenerationReceipt,
  type CloneGenerationRenderCheckpoint,
  type CloneGenerationReview,
  type CloneGenerationSnapshot,
  type CloneGenerationTask,
  type CloneGenerationCheckpoint,
  type CloneGenerationPlan,
  type CloneGenerationVariantDraft,
  type CloneGenerationVariantReview,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { FissionCloneTask, Prisma } from '../../../generated/prisma/client';
import { ApiHttpException } from '../../../common/api-http-exception';
import { lockCloneRun } from '../../../platform/workflow/fission-clone-scope';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
  type WorkingArtifactUpsertInput,
} from '../../../platform/workflow/workflow-working.repository';
import { CloneTaskRepository } from './clone-task.repository';
import { loadCloneGenerationPlan } from './clone-generation-source';
import { summarizeCloneGenerationPlan } from './clone-generation-plan';
import { freezeCloneBatchExport } from './clone-generation-export';
import { assertNoActiveCloneTasks, cloneArtifactRef, cloneConflict } from './clone-task-scope';
import {
  generationSnapshot,
  hasUnknownCloneRender,
  pendingGenerationBatch,
  releaseCloneTaskFiles,
  verifyGenerationSources,
  generationBatchSnapshot,
  requireGenerationChildren,
  verifyGenerationBatchSources,
} from './clone-generation-task-state';
import {
  compileCloneVariant,
  requireClonePlanningCapability,
  validateCloneVariantDraft,
  validateCloneVariantReview,
} from './clone-generation-planning';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const PLAN_DRAFT = 'VARIANT_PLAN_V1';
const PLAN_REVIEW = 'VARIANT_REVIEW_V1';
export const cloneArchiveOperationKey = (artifact: { id: string; revision: number }) =>
  `clone-final:${artifact.id}:${artifact.revision}`;
const taskWhere = (task: FissionCloneTask) => ({
  projectId: task.projectId,
  workflowRunId: task.workflowRunId,
  taskId: task.id,
});
const NO_CLAIM: CloneGenerationClaim = {
  claimed: false,
  attemptToken: null,
  leaseExpiresAt: null,
  snapshot: null,
  checkpoints: {},
};
const STAGES: Record<string, string> = {
  QUEUED: '等待处理',
  PREPARE: '准备商品素材',
  RENDER: '生成镜头',
  COMPOSE: '合成成片',
  REVIEW: '检查成片画面',
  SAVE: '保存成片',
  SUCCEEDED: '成片已生成',
  FAILED: '处理失败',
  CANCELLED: '任务已取消',
};

@Injectable()
export class CloneGenerationRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(CloneTaskRepository) private readonly tasks: CloneTaskRepository,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}

  create(
    projectId: string,
    workflowRunId: string,
    input: CloneGenerationCreateRequest,
    models: Pick<CloneGenerationSnapshot, 'model' | 'reviewModel'> & { planningModel?: string },
  ): Promise<CloneGenerationReceipt> {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, workflowRunId, { writable: true });
      const scope = { projectId, workflowRunId, operation: 'GENERATE' };
      const existing = await tx.fissionCloneTask.findFirst({
        where: {
          ...scope,
          operation: { in: ['GENERATE', 'GENERATE_BATCH'] },
          generationParentId: null,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (existing) {
        const batch =
          existing.operation === 'GENERATE_BATCH' ? generationBatchSnapshot(existing) : null;
        const { plan, count } = batch ?? { plan: generationSnapshot(existing).plan, count: 1 };
        if (
          count !== input.count ||
          workflowStateHash(plan.sources.mapping) !== workflowStateHash(input.sourceMapping) ||
          summarizeCloneGenerationPlan(plan, input.count).totalRenderSeconds !==
            input.acceptedRenderSeconds
        )
          cloneConflict('同一请求编号对应不同的生成条件');
        if (batch?.planningModel) return { taskId: existing.id, batchId: existing.id };
        if (batch) {
          const [first] = await requireGenerationChildren(tx, existing, count);
          return { taskId: first!.id, batchId: existing.id };
        }
        return { taskId: existing.id };
      }
      await assertNoActiveCloneTasks(tx, projectId, workflowRunId);
      if (await pendingGenerationBatch(tx, projectId, workflowRunId))
        cloneConflict('请先重试或取消未完成的成片批次');
      const unknown = await tx.fissionCloneTask.findFirst({
        where: {
          ...scope,
          steps: {
            some: {
              stepKey: { startsWith: 'RENDER:' },
              output: { path: ['state'], equals: 'CREATE_PENDING' },
            },
          },
        },
        select: { id: true },
      });
      if (unknown) cloneConflict('此工作流有供应商创建结果待核查，暂不能再次生成');
      const plan = await loadCloneGenerationPlan(tx, projectId, workflowRunId, input.sourceMapping);
      requireClonePlanningCapability(plan, input.count, models.planningModel);
      if (
        summarizeCloneGenerationPlan(plan, input.count).totalRenderSeconds !==
        input.acceptedRenderSeconds
      )
        cloneConflict('生成条件已变化，请重新检查并确认');
      const frozen = { plan, model: models.model, reviewModel: models.reviewModel };
      const planning = input.count > CLONE_GENERATION_LIMITS.maxUnplannedCount;
      const batchSnapshot = {
        ...frozen,
        count: input.count,
        ...(planning && {
          planningModel: models.planningModel!,
          planningVersion: 2,
          variantIds: Array.from({ length: input.count }, () => randomUUID()),
        }),
      };
      const parent =
        input.count > 1
          ? await tx.fissionCloneTask.create({
              data: {
                ...scope,
                operation: 'GENERATE_BATCH',
                idempotencyKey: input.idempotencyKey,
                inputSnapshot: json(batchSnapshot),
                inputHash: workflowStateHash(batchSnapshot),
                status: planning ? 'QUEUED' : 'SUCCEEDED',
                currentStage: planning ? 'QUEUED' : 'PLANNED',
                progress: planning ? 0 : 100,
                completedAt: planning ? null : new Date(),
              },
            })
          : null;
      if (planning && parent) {
        await this.holdImages(tx, parent, plan);
        await this.tasks.enqueue(tx, parent);
        return { taskId: parent.id, batchId: parent.id };
      }
      const ids = [];
      for (let slot = 1; slot <= input.count; slot++) {
        const snapshot: CloneGenerationSnapshot = { ...frozen, variantId: randomUUID() };
        const task = await this.dispatchItem(
          tx,
          snapshot,
          parent ? `batch:${parent.id}:${slot}` : input.idempotencyKey,
          parent ? { id: parent.id, slot } : null,
        );
        ids.push(task.id);
      }
      return { taskId: ids[0]!, ...(parent && { batchId: parent.id }) };
    });
  }

  private holdImages(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
    plan: CloneGenerationPlan,
  ) {
    return tx.fissionCloneFileHold.createMany({
      data: plan.images.map((file) => ({
        ...taskWhere(task),
        fileObjectId: file.fileObjectId,
        sha256: file.sha256,
      })),
    });
  }

  private async dispatchItem(
    tx: Prisma.TransactionClient,
    snapshot: CloneGenerationSnapshot,
    idempotencyKey: string,
    parent: { id: string; slot: number } | null,
  ) {
    const { plan } = snapshot;
    const task = await tx.fissionCloneTask.create({
      data: {
        projectId: plan.projectId,
        workflowRunId: plan.workflowRunId,
        operation: 'GENERATE',
        ...(parent && { generationParentId: parent.id, generationSlot: parent.slot }),
        idempotencyKey,
        inputSnapshot: json(snapshot),
        inputHash: workflowStateHash(snapshot),
      },
    });
    await this.holdImages(tx, task, plan);
    await this.tasks.enqueue(tx, task);
    return task;
  }

  list(
    projectId: string,
    workflowRunId: string,
    page: number,
    pageSize: number,
  ): Promise<CloneGenerationList> {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, workflowRunId);
      const where = {
        projectId,
        workflowRunId,
        generationParentId: null,
        operation: { in: ['GENERATE', 'GENERATE_BATCH'] },
      };
      const heads = await tx.fissionCloneTask.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { generationChildren: { orderBy: { generationSlot: 'asc' } } },
      });
      const rows = heads.flatMap((head) =>
        head.operation === 'GENERATE_BATCH' ? head.generationChildren : [head],
      );
      const manifests = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'CLONE_GENERATION',
          type: 'DELIVERY_MANIFEST',
          availability: 'AVAILABLE',
          artifactKey: {
            in: heads.map((head) => cloneBatchArtifactKey(head.id)),
          },
        },
        select: { artifactKey: true, revision: true, contentHash: true },
      });
      const byManifestKey = new Map(manifests.map((row) => [row.artifactKey, row]));
      const batches = heads.map((head): CloneGenerationBatch => {
        const items = head.operation === 'GENERATE_BATCH' ? head.generationChildren : [head];
        const planning = items.length === 0 ? generationBatchSnapshot(head) : null;
        const manifest = byManifestKey.get(cloneBatchArtifactKey(head.id));
        let status = head.status as CloneGenerationBatch['status'];
        if (head.currentStage === 'PLANNED') {
          if (items.some((item) => item.status === 'RUNNING')) status = 'RUNNING';
          else if (items.some((item) => item.status === 'QUEUED')) status = 'QUEUED';
          else status = items.some((item) => item.status === 'SUCCEEDED') ? 'PARTIAL' : 'FAILED';
        }
        return {
          id: head.id,
          taskIds: items.map((item) => item.id),
          status,
          canCancel:
            head.currentStage === 'PLANNED' ||
            (planning !== null && ['QUEUED', 'RUNNING', 'FAILED'].includes(head.status)),
          ...(manifest && {
            downloadUrl:
              `/api/projects/${projectId}/workflow-runs/${workflowRunId}/fission-clone/generation` +
              `/batches/${head.id}/export?revision=${manifest.revision}&hash=${manifest.contentHash}`,
          }),
          ...(planning && {
            planning: {
              count: planning.count,
              error: head.errorMessage,
              canRetry: head.status === 'FAILED' && head.errorCode !== 'PERMANENT_FAILURE',
            },
          }),
        };
      });
      const artifacts = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'CLONE_GENERATION',
          availability: 'AVAILABLE',
          artifactKey: {
            in: rows
              .filter((row) => row.status === 'SUCCEEDED')
              .map((row) => cloneVideoArtifactKey(generationSnapshot(row).variantId)),
          },
        },
      });
      const byKey = new Map(artifacts.map((row) => [row.artifactKey, row]));
      const receipts = artifacts.length
        ? await tx.assetOperationReceipt.findMany({
            where: {
              projectId,
              operationKey: { in: artifacts.map(cloneArchiveOperationKey) },
            },
            select: { operationKey: true },
          })
        : [];
      const archived = new Set(receipts.map((row) => row.operationKey));
      const items = rows.map((task): CloneGenerationTask => {
        const { variantId, plan } = generationSnapshot(task);
        const artifact = byKey.get(cloneVideoArtifactKey(variantId));
        return {
          id: task.id,
          variantId,
          status: task.status as CloneGenerationTask['status'],
          progress: task.progress,
          message: STAGES[task.currentStage] ?? '处理中',
          error: task.errorMessage,
          canRetry: task.status === 'FAILED' && task.errorCode !== 'PERMANENT_FAILURE',
          createdAt: task.createdAt.toISOString(),
          artifact: artifact
            ? {
                ...cloneArtifactRef(artifact),
                freshness: artifact.freshness,
                archived: archived.has(cloneArchiveOperationKey(artifact)),
                contentUrl: `/api/projects/${projectId}/working-artifacts/${artifact.id}/content`,
                durationMs: Math.round(
                  (plan.timeline.frameCount * 1000) / plan.timeline.fpsNumerator,
                ),
                ratio: plan.ratio,
              }
            : null,
        };
      });
      const total = await tx.fissionCloneTask.count({ where });
      const active = await tx.fissionCloneTask.count({
        where: { projectId, workflowRunId, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      return {
        items,
        batches,
        total,
        active: active > 0,
        pendingBatch: !!(await pendingGenerationBatch(tx, projectId, workflowRunId)),
      };
    });
  }

  claim(projectId: string, taskId: string): Promise<CloneGenerationClaim> {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.taskScope(tx, projectId, taskId, undefined, false, 'all');
      if (task.operation === 'GENERATE_BATCH') {
        if (!generationBatchSnapshot(task).planningModel)
          throw new ApiHttpException('复刻任务不存在', 404, 'VALIDATION_ERROR');
        if (task.status !== 'QUEUED') return NO_CLAIM;
        return this.claimPlanning(tx, task);
      }
      if (task.status !== 'QUEUED') return NO_CLAIM;
      let snapshot: CloneGenerationSnapshot;
      try {
        snapshot = await verifyGenerationSources(tx, task);
      } catch (error) {
        if (!(error instanceof ApiHttpException)) throw error;
        await this.block(tx, task, '成片任务的冻结来源已变化或文件已丢失');
        return NO_CLAIM;
      }
      if (await hasUnknownCloneRender(tx, task)) {
        await this.block(tx, task, '供应商创建结果未知，请先核查原任务');
        return NO_CLAIM;
      }
      if (task.attemptCount >= this.tasks.maxAttempts()) {
        await this.block(tx, task, '已达到成片任务最大尝试次数');
        return NO_CLAIM;
      }
      const { attemptToken, leaseExpiresAt } = await this.tasks.startAttempt(tx, task);
      const steps = await tx.fissionCloneTaskStep.findMany({
        where: { ...taskWhere(task), inputHash: task.inputHash },
      });
      if (steps.some((step) => workflowStateHash(step.output) !== step.outputHash))
        cloneConflict('成片检查点内容不一致');
      return {
        claimed: true,
        snapshot,
        attemptToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        checkpoints: Object.fromEntries(
          steps.map((step) => [step.stepKey, step.output as CloneGenerationCheckpoint]),
        ),
      };
    });
  }

  private async claimPlanning(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
  ): Promise<CloneGenerationClaim> {
    try {
      const frozen = await verifyGenerationBatchSources(tx, task);
      if (task.attemptCount >= this.tasks.maxAttempts())
        cloneConflict('已达到批次规划最大尝试次数');
      const saved = await this.step(tx, task, PLAN_DRAFT);
      const draft = saved ? parseCloneGenerationVariantDraft(saved.output) : null;
      if (draft)
        validateCloneVariantDraft(frozen.plan, frozen.variantIds, draft, frozen.planningVersion);
      const audited = await this.step(tx, task, PLAN_REVIEW);
      const review = audited ? parseCloneGenerationVariantReview(audited.output) : null;
      if (review) validateCloneVariantReview(frozen.variantIds, review);
      const { attemptToken, leaseExpiresAt } = await this.tasks.startAttempt(tx, task);
      return {
        ...NO_CLAIM,
        claimed: true,
        attemptToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        planning: {
          plan: frozen.plan,
          model: frozen.planningModel,
          variantIds: frozen.variantIds,
          ...(frozen.planningVersion && { version: frozen.planningVersion }),
          draft,
          review,
        },
      };
    } catch (error) {
      if (!(error instanceof ApiHttpException || error instanceof TypeError)) throw error;
      await this.block(tx, task, '批次规划的来源、检查点或尝试次数无效');
      return NO_CLAIM;
    }
  }

  saveVariantDraft(
    projectId: string,
    taskId: string,
    token: string,
    draft: CloneGenerationVariantDraft,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, 'all');
      const frozen = await verifyGenerationBatchSources(tx, task);
      validateCloneVariantDraft(frozen.plan, frozen.variantIds, draft, frozen.planningVersion);
      const previous = await this.step(tx, task, PLAN_DRAFT);
      if (previous && previous.outputHash !== workflowStateHash(draft))
        cloneConflict('批次已有不同的规划检查点');
      if (!previous) await this.createStep(tx, task, token, PLAN_DRAFT, draft);
      return { accepted: true };
    });
  }

  saveVariantReview(
    projectId: string,
    taskId: string,
    token: string,
    review: CloneGenerationVariantReview,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, 'all');
      const frozen = await verifyGenerationBatchSources(tx, task);
      if (!(await this.step(tx, task, PLAN_DRAFT))) cloneConflict('批次缺少规划检查点');
      validateCloneVariantReview(frozen.variantIds, review);
      const previous = await this.step(tx, task, PLAN_REVIEW);
      if (previous && previous.outputHash !== workflowStateHash(review))
        cloneConflict('批次已有不同的审查检查点');
      if (!previous) await this.createStep(tx, task, token, PLAN_REVIEW, review);
      return { accepted: true };
    });
  }

  completePlanning(projectId: string, taskId: string, token: string) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.taskScope(tx, projectId, taskId, undefined, false, 'all');
      if (
        task.operation === 'GENERATE_BATCH' &&
        task.status === 'SUCCEEDED' &&
        task.attemptToken === token
      )
        return { accepted: true };
      await this.tasks.lease(tx, projectId, taskId, token, 'all');
      const frozen = await verifyGenerationBatchSources(tx, task);
      const saved = await this.step(tx, task, PLAN_DRAFT);
      const audited = await this.step(tx, task, PLAN_REVIEW);
      if (!saved || !audited) cloneConflict('批次缺少已审查的规划');
      const draft = parseCloneGenerationVariantDraft(saved.output);
      validateCloneVariantDraft(frozen.plan, frozen.variantIds, draft, frozen.planningVersion);
      validateCloneVariantReview(
        frozen.variantIds,
        parseCloneGenerationVariantReview(audited.output),
      );
      for (const [index, variant] of draft.variants.entries()) {
        const slot = index + 1;
        await this.dispatchItem(
          tx,
          {
            plan: compileCloneVariant(frozen.plan, variant),
            variantId: variant.variantId,
            model: frozen.model,
            reviewModel: frozen.reviewModel,
          },
          `batch:${task.id}:${slot}`,
          { id: task.id, slot },
        );
      }
      await tx.fissionCloneTask.update({
        where: { id: task.id },
        data: {
          status: 'SUCCEEDED',
          currentStage: 'PLANNED',
          progress: 100,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      await releaseCloneTaskFiles(tx, task);
      return { accepted: true };
    });
  }

  private async block(tx: Prisma.TransactionClient, task: FissionCloneTask, message: string) {
    await tx.fissionCloneTask.update({
      where: { id: task.id },
      data: {
        status: 'FAILED',
        currentStage: 'FAILED',
        errorCode: 'PERMANENT_FAILURE',
        errorMessage: message,
        leaseExpiresAt: null,
      },
    });
    await releaseCloneTaskFiles(tx, task);
  }

  private async step(tx: Prisma.TransactionClient, task: FissionCloneTask, key: string) {
    const row = await tx.fissionCloneTaskStep.findUnique({
      where: { projectId_workflowRunId_taskId_stepKey: { ...taskWhere(task), stepKey: key } },
    });
    if (
      row &&
      (row.inputHash !== task.inputHash || workflowStateHash(row.output) !== row.outputHash)
    )
      cloneConflict('成片检查点内容不一致');
    return row;
  }

  private createStep(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
    token: string,
    stepKey: string,
    output: CloneGenerationCheckpoint | CloneGenerationVariantDraft | CloneGenerationVariantReview,
  ) {
    return tx.fissionCloneTaskStep.create({
      data: {
        ...taskWhere(task),
        stepKey,
        inputHash: task.inputHash,
        outputHash: workflowStateHash(output),
        output: json(output),
        attemptToken: token,
      },
    });
  }

  saveRender(
    projectId: string,
    taskId: string,
    token: string,
    index: number,
    value: CloneGenerationRenderCheckpoint,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      if (!generationSnapshot(task).plan.shots[index]) cloneConflict('镜头不属于当前任务');
      const key = `RENDER:${index}`;
      const previous = await this.step(tx, task, key);
      if (value.state === 'CREATE_PENDING') {
        if (previous) cloneConflict('镜头创建意图已登记，请核查原执行状态');
        await this.createStep(tx, task, token, key, value);
      } else {
        if (previous?.outputHash === workflowStateHash(value)) return { accepted: true };
        if (
          !previous ||
          previous.attemptToken !== token ||
          (previous.output as { state: string }).state !== 'CREATE_PENDING'
        )
          cloneConflict('不能替换已记录的供应商任务');
        await tx.fissionCloneTaskStep.update({
          where: { id: previous.id },
          data: { output: json(value), outputHash: workflowStateHash(value) },
        });
      }
      return { accepted: true };
    });
  }

  private async fileInput(tx: Prisma.TransactionClient, task: FissionCloneTask, slot: string) {
    const snapshot = generationSnapshot(task);
    if (slot === 'final') {
      for (const index of snapshot.plan.shots.keys()) {
        if (!(await this.step(tx, task, `FILE:${index}`))) cloneConflict('尚有镜头文件未保存');
      }
    } else {
      const index = Number(slot);
      if (!/^[0-3]$/.test(slot) || !snapshot.plan.shots[index])
        cloneConflict('镜头文件不属于当前任务');
      const render = await this.step(tx, task, `RENDER:${index}`);
      if ((render?.output as { state?: string } | undefined)?.state !== 'CREATED')
        cloneConflict('镜头尚未记录供应商任务');
    }
    const existing = await this.step(tx, task, `FILE:${slot}`);
    return { snapshot, existing: existing?.output as CloneGenerationFile | undefined };
  }

  fileAdmission(projectId: string, taskId: string, token: string, slot: string) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      return this.fileInput(tx, task, slot);
    });
  }

  saveFile(projectId: string, taskId: string, token: string, slot: string, input: FileObjectInput) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      const { existing } = await this.fileInput(tx, task, slot);
      if (existing) {
        if (existing.sha256 !== input.sha256 || existing.sizeBytes !== input.sizeBytes)
          cloneConflict('已有不同的媒体检查点');
        return { file: existing, inserted: false };
      }
      const row = await this.working.upsertFileObjectInTransaction(
        tx,
        projectId,
        task.workflowRunId,
        input,
      );
      const file = { fileObjectId: row.id, sha256: row.sha256, sizeBytes: row.sizeBytes };
      await tx.fissionCloneFileHold.create({
        data: { ...taskWhere(task), fileObjectId: row.id, sha256: row.sha256 },
      });
      await this.createStep(tx, task, token, `FILE:${slot}`, file);
      return { file, inserted: true };
    });
  }

  saveReview(projectId: string, taskId: string, token: string, review: CloneGenerationReview) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      if (!(await this.step(tx, task, 'FILE:final'))) cloneConflict('成片尚未保存');
      const shots = generationSnapshot(task).plan.timeline.shots;
      if (
        review.checks.length !== shots.length ||
        review.checks.some((check, index) => {
          const shot = shots[index]!;
          const frames = new Set([
            shot.startFrame,
            Math.floor((shot.startFrame + shot.endFrame - 1) / 2),
            shot.endFrame - 1,
          ]);
          return (
            check.shotId !== shot.shotId ||
            new Set(check.evidenceFrames).size !== check.evidenceFrames.length ||
            check.evidenceFrames.some((frame) => !frames.has(frame))
          );
        })
      )
        cloneConflict('审片证据未覆盖冻结镜头或引用了未抽样帧');
      const previous = await this.step(tx, task, 'REVIEW_V1');
      if (previous && previous.outputHash !== workflowStateHash(review))
        cloneConflict('审片检查点已保存');
      if (!previous) await this.createStep(tx, task, token, 'REVIEW_V1', review);
      return { accepted: true };
    });
  }

  private async readyVideo(tx: Prisma.TransactionClient, task: FissionCloneTask) {
    const { plan, variantId } = generationSnapshot(task);
    const file = (await this.step(tx, task, 'FILE:final'))?.output as
      CloneGenerationFile | undefined;
    const review = (await this.step(tx, task, 'REVIEW_V1'))?.output as
      CloneGenerationReview | undefined;
    if (
      !file ||
      !review ||
      review.checks.length !== plan.shots.length ||
      review.checks.some((check) => check.verdict !== 'PASSED')
    )
      cloneConflict('成片未通过全部镜头审片');
    const hold = await tx.fissionCloneFileHold.findFirst({
      where: { ...taskWhere(task), fileObjectId: file.fileObjectId, sha256: file.sha256 },
      include: { fileObject: true },
    });
    const stored = hold?.fileObject;
    if (
      !stored ||
      stored.status !== 'AVAILABLE' ||
      stored.sha256 !== file.sha256 ||
      stored.sizeBytes !== file.sizeBytes ||
      stored.nodeId !== 'CLONE_GENERATION'
    )
      cloneConflict('成片文件与校验记录不一致');
    const ref = plan.sources.mapping;
    const dependencies: NonNullable<WorkingArtifactUpsertInput['dependencies']> = [
      {
        sourceType: 'WORKING_ARTIFACT',
        sourceNodeId: 'CLONE_MAPPING',
        sourceKey: CLONE_MAPPING_ARTIFACT_KEY,
        sourceArtifactId: ref.artifactId,
        sourceRevision: ref.revision,
        sourceHash: ref.contentHash,
      },
    ];
    const facts = {
      taskId: task.id,
      variantId,
      ...(task.generationParentId && { batchId: task.generationParentId }),
      sources: plan.sources,
      timeline: plan.timeline,
      ratio: plan.ratio,
      review,
    };
    const name = `${Array.from(plan.productName).slice(0, 92).join('')} · 复刻成片${task.generationSlot ? ` ${task.generationSlot}` : ''}`;
    const input = {
      kind: 'FILE',
      name,
      directory: 'FINAL_VIDEOS',
      type: 'FINAL_VIDEO',
      originalFileName: stored.originalFileName,
      mimeType: stored.mimeType,
      storageKey: stored.storageKey,
      sizeBytes: stored.sizeBytes,
      payload: facts,
      dependencies,
      files: [
        {
          fileObjectId: stored.id,
          role: 'FINAL_VIDEO',
          sortOrder: 0,
          originalFileName: stored.originalFileName,
          mimeType: stored.mimeType,
          sha256: stored.sha256,
        },
      ],
    } satisfies WorkingArtifactUpsertInput;
    return { facts, artifact: { artifactKey: cloneVideoArtifactKey(variantId), input } };
  }

  private async publishBatch(tx: Prisma.TransactionClient, task: FissionCloneTask) {
    const parent = await pendingGenerationBatch(tx, task.projectId, task.workflowRunId);
    if (!parent || parent.id !== task.generationParentId) cloneConflict('成片批次已结束');
    const batch = generationBatchSnapshot(parent);
    const children = await requireGenerationChildren(tx, parent, batch.count);
    if (children.some((item) => item.status !== 'SUCCEEDED')) return;

    const planned = batch.planningModel ? await this.step(tx, parent, PLAN_DRAFT) : null;
    if (batch.planningModel && (!planned || !(await this.step(tx, parent, PLAN_REVIEW))))
      cloneConflict('成片批次缺少已审查的规划');
    const draft = planned ? parseCloneGenerationVariantDraft(planned.output) : null;
    if (draft)
      validateCloneVariantDraft(batch.plan, batch.variantIds!, draft, batch.planningVersion);
    const videos = [];
    for (const [index, item] of children.entries()) {
      const { plan, model, reviewModel } = await verifyGenerationSources(tx, item);
      const variant = draft?.variants[index];
      const matches = variant
        ? workflowStateHash({
            plan: compileCloneVariant(batch.plan, variant),
            variantId: variant.variantId,
            model: batch.model,
            reviewModel: batch.reviewModel,
          }) === item.inputHash
        : workflowStateHash({ plan, model, reviewModel, count: batch.count }) === parent.inputHash;
      if (!matches) cloneConflict('批次条目来源不一致');
      videos.push(await this.readyVideo(tx, item));
    }
    const { projectId, workflowRunId } = parent;
    const artifacts = await this.working.commitValidatedArtifactsInTransaction(
      tx,
      projectId,
      workflowRunId,
      'CLONE_GENERATION',
      videos.map(({ artifact }) => artifact),
    );
    await this.publishManifest(tx, projectId, workflowRunId, parent.id, artifacts);
    await tx.fissionCloneTask.update({
      where: { id: parent.id },
      data: { currentStage: 'SUCCEEDED', completedAt: new Date() },
    });
    for (const item of children) await releaseCloneTaskFiles(tx, item);
  }

  private async publishManifest(
    tx: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    batchId: string,
    artifacts: { artifactKey: string; record: Parameters<typeof cloneArtifactRef>[0] }[],
  ) {
    const manifest = artifacts.map(({ record, artifactKey }) => ({
      artifactKey,
      ...cloneArtifactRef(record),
    }));
    await this.working.commitValidatedArtifactsInTransaction(
      tx,
      projectId,
      workflowRunId,
      'CLONE_GENERATION',
      [
        {
          artifactKey: cloneBatchArtifactKey(batchId),
          input: {
            kind: 'STRUCTURED',
            name: '复刻成片批次',
            directory: 'REPORTS_DELIVERABLES',
            type: 'DELIVERY_MANIFEST',
            payload: { batchId, count: manifest.length, videos: manifest },
            dependencies: manifest.map((item) => ({
              sourceType: 'WORKING_ARTIFACT',
              sourceNodeId: 'CLONE_GENERATION',
              sourceKey: item.artifactKey,
              sourceArtifactId: item.artifactId,
              sourceRevision: item.revision,
              sourceHash: item.contentHash,
            })),
          },
        },
      ],
    );
  }

  complete(projectId: string, taskId: string, token: string) {
    return this.db.$transaction(async (tx) => {
      const previous = await this.tasks.taskScope(tx, projectId, taskId, undefined, false, true);
      if (previous.status === 'SUCCEEDED' && previous.attemptToken === token)
        return { accepted: true };
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      const {
        facts: { variantId },
        artifact,
      } = await this.readyVideo(tx, task);
      const completed = await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: {
          status: 'SUCCEEDED',
          currentStage: 'SUCCEEDED',
          progress: 100,
          completedAt: new Date(),
          leaseExpiresAt: null,
          result: json({ variantId }),
          resultHash: workflowStateHash({ variantId }),
        },
      });
      if (task.generationParentId) {
        await this.publishBatch(tx, completed);
      } else {
        const videos = await this.working.commitValidatedArtifactsInTransaction(
          tx,
          projectId,
          task.workflowRunId,
          'CLONE_GENERATION',
          [artifact],
        );
        await this.publishManifest(tx, projectId, task.workflowRunId, taskId, videos);
        await releaseCloneTaskFiles(tx, task);
      }
      return { accepted: true };
    });
  }

  archiveSource(projectId: string, workflowRunId: string, taskId: string, ref: CloneArtifactRef) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.taskScope(tx, projectId, taskId, workflowRunId, false, true);
      const { variantId, plan } = generationSnapshot(task);
      const artifact = await tx.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'CLONE_GENERATION',
          artifactKey: cloneVideoArtifactKey(variantId),
          id: ref.artifactId,
          revision: ref.revision,
          contentHash: ref.contentHash,
          availability: 'AVAILABLE',
        },
      });
      if (
        task.status !== 'SUCCEEDED' ||
        !artifact?.storageKey ||
        !artifact.sizeBytes ||
        !artifact.originalFileName ||
        !artifact.mimeType
      )
        cloneConflict('该版本成片不可归档');
      return { artifact, variantId, plan };
    });
  }

  batchExport(
    projectId: string,
    workflowRunId: string,
    batchId: string,
    revision: number,
    hash: string,
  ) {
    return this.db.$transaction((tx) =>
      freezeCloneBatchExport(tx, projectId, workflowRunId, batchId, revision, hash),
    );
  }
}
