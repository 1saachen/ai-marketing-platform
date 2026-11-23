import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CLONE_MAPPING_ARTIFACT_KEY,
  CLONE_GENERATION_LIMITS,
  CLONE_SHOT_REFERENCE_MODE,
  cloneBatchArtifactKey,
  cloneVideoArtifactKey,
  parseCloneGenerationReview,
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
  type CloneGenerationReviewIssue,
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
import { cloneReferenceSlotIndex, summarizeCloneGenerationPlan } from './clone-generation-plan';
import { assertCloneShotReferenceStorage } from './clone-generation-config';
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
const REVIEW_STEP = 'REVIEW_V1';
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
const renderSlots = (plan: CloneGenerationPlan) =>
  plan.mode === 'SEEDANCE_2_0_SOURCE_EDIT' ? [0] : Array.from(plan.shots.keys());

function matchesAcceptedGeneration(plan: CloneGenerationPlan, input: CloneGenerationCreateRequest) {
  const totals = summarizeCloneGenerationPlan(plan, input.count);
  return (
    totals.totalRenderSeconds === input.acceptedRenderSeconds &&
    totals.totalReferenceFrames === input.acceptedReferenceFrames
  );
}

function reviewCoversFrozenShots(plan: CloneGenerationPlan, review: CloneGenerationReview) {
  const { shots, fpsNumerator, fpsDenominator } = plan.timeline;
  const timeUnits = 1000 * fpsDenominator;
  return (
    review.checks.length === shots.length &&
    review.checks.every((check, index) => {
      const shot = shots[index]!;
      const frames = new Set([
        shot.startFrame,
        Math.floor((shot.startFrame + shot.endFrame - 1) / 2),
        shot.endFrame - 1,
      ]);
      for (const event of plan.shots[index]?.motion?.events ?? []) {
        const time = event.evidenceFramesMs[Math.floor((event.evidenceFramesMs.length - 1) / 2)]!;
        const offset = Math.floor((2 * time * fpsNumerator + timeUnits) / (2 * timeUnits));
        frames.add(Math.min(shot.endFrame - 1, shot.startFrame + offset));
      }
      return (
        check.shotId === shot.shotId &&
        new Set(check.evidenceFrames).size === check.evidenceFrames.length &&
        check.evidenceFrames.every((frame) => frames.has(frame))
      );
    })
  );
}

function projectReviewIssues(
  plan: CloneGenerationPlan,
  inputHash: string,
  checkpoint?: { inputHash: string; outputHash: string; output: unknown },
): CloneGenerationReviewIssue[] {
  if (
    !checkpoint ||
    checkpoint.inputHash !== inputHash ||
    workflowStateHash(checkpoint.output) !== checkpoint.outputHash
  )
    return [];
  try {
    const review = parseCloneGenerationReview(checkpoint.output);
    if (!reviewCoversFrozenShots(plan, review)) return [];
    return review.checks.flatMap(({ verdict, reason, evidenceFrames }, index) =>
      verdict === 'PASSED' ? [] : [{ shotNumber: index + 1, verdict, reason, evidenceFrames }],
    );
  } catch (error) {
    if (error instanceof TypeError) return [];
    throw error;
  }
}

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
    models: Pick<CloneGenerationSnapshot, 'model' | 'reviewModel'> & {
      planningModel?: string;
      sourceVideoSigningAvailable: boolean;
    },
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
          !matchesAcceptedGeneration(plan, input)
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
      assertCloneShotReferenceStorage(models.sourceVideoSigningAvailable);
      requireClonePlanningCapability(plan, input.count, models.planningModel);
      if (!matchesAcceptedGeneration(plan, input))
        cloneConflict('生成条件已变化，请重新预检并确认视频参考和输出计量');
      const frozen = { plan, model: models.model, reviewModel: models.reviewModel };
      const planning = input.count > CLONE_GENERATION_LIMITS.maxUnplannedCount;
      const batchSnapshot = {
        ...frozen,
        count: input.count,
        ...(planning && {
          planningModel: models.planningModel!,
          planningVersion: 2,
          sampleFirst: true,
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
        await this.holdInputs(tx, parent, plan);
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

  private holdInputs(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
    plan: CloneGenerationPlan,
  ) {
    return tx.fissionCloneFileHold.createMany({
      data: [...plan.images, ...(plan.sourceVideo ? [plan.sourceVideo] : [])].map((file) => ({
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
    await this.holdInputs(tx, task, plan);
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
      const failedIds = rows
        .filter((row) => row.operation === 'GENERATE' && row.status === 'FAILED')
        .map((row) => row.id);
      const reviewSteps = failedIds.length
        ? await tx.fissionCloneTaskStep.findMany({
            where: { projectId, workflowRunId, taskId: { in: failedIds }, stepKey: REVIEW_STEP },
            select: { taskId: true, inputHash: true, outputHash: true, output: true },
          })
        : [];
      const reviewByTask = new Map(reviewSteps.map((step) => [step.taskId, step]));
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
        if (['SAMPLE', 'PLANNED'].includes(head.currentStage)) {
          if (items.some((item) => item.status === 'RUNNING')) status = 'RUNNING';
          else if (items.some((item) => item.status === 'QUEUED')) status = 'QUEUED';
          else status = items.some((item) => item.status === 'SUCCEEDED') ? 'PARTIAL' : 'FAILED';
        }
        return {
          id: head.id,
          taskIds: items.map((item) => item.id),
          count: head.operation === 'GENERATE_BATCH' ? generationBatchSnapshot(head).count : 1,
          status,
          canCancel:
            ['SAMPLE', 'PLANNED'].includes(head.currentStage) ||
            (planning !== null && ['QUEUED', 'RUNNING', 'FAILED'].includes(head.status)),
          ...(head.currentStage === 'SAMPLE' && {
            sample: { totalCount: generationBatchSnapshot(head).count },
          }),
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
        const reviewIssues = projectReviewIssues(plan, task.inputHash, reviewByTask.get(task.id));
        return {
          id: task.id,
          variantId,
          status: task.status as CloneGenerationTask['status'],
          progress: task.progress,
          message:
            task.currentStage === 'RENDER' && plan.mode === 'SEEDANCE_2_0_SOURCE_EDIT'
              ? '编辑原片'
              : (STAGES[task.currentStage] ?? '处理中'),
          error: task.errorMessage,
          ...(reviewIssues.length > 0 && { reviewIssues }),
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
      await this.dispatchPlannedItems(
        tx,
        task,
        frozen,
        draft,
        0,
        frozen.sampleFirst ? 1 : frozen.count,
      );
      await tx.fissionCloneTask.update({
        where: { id: task.id },
        data: {
          status: 'SUCCEEDED',
          currentStage: frozen.sampleFirst ? 'SAMPLE' : 'PLANNED',
          progress: 100,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      if (!frozen.sampleFirst) await releaseCloneTaskFiles(tx, task);
      return { accepted: true };
    });
  }

  private async dispatchPlannedItems(
    tx: Prisma.TransactionClient,
    parent: FissionCloneTask,
    batch: ReturnType<typeof generationBatchSnapshot>,
    draft: CloneGenerationVariantDraft,
    start: number,
    end: number,
  ) {
    for (let index = start; index < end; index++) {
      const variant = draft.variants[index]!;
      const slot = index + 1;
      await this.dispatchItem(
        tx,
        {
          plan: compileCloneVariant(batch.plan, variant),
          variantId: variant.variantId,
          model: batch.model,
          reviewModel: batch.reviewModel,
        },
        `batch:${parent.id}:${slot}`,
        { id: parent.id, slot },
      );
    }
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
      const { plan } = generationSnapshot(task);
      if (!renderSlots(plan).includes(index)) cloneConflict('生成区间不属于当前任务');
      const key = `RENDER:${index}`;
      const previous = await this.step(tx, task, key);
      if (value.state === 'CREATE_PENDING') {
        if (previous) cloneConflict('镜头创建意图已登记，请核查原执行状态');
        if (plan.mode === CLONE_SHOT_REFERENCE_MODE) await this.readShotReference(tx, task, index);
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
        if (value.state === 'CREATE_REJECTED')
          await this.block(
            tx,
            task,
            plan.mode === 'SEEDANCE_2_0_SOURCE_EDIT'
              ? '供应商拒绝创建原片编辑任务，请核对参考视频和服务配置后重新生成'
              : `供应商拒绝创建第 ${index + 1} 个镜头，请核对目标素材和服务配置后重新生成`,
          );
      }
      return { accepted: true };
    });
  }

  private async fileInput(tx: Prisma.TransactionClient, task: FissionCloneTask, slot: string) {
    const snapshot = generationSnapshot(task);
    const referenceIndex = cloneReferenceSlotIndex(slot);
    if (slot === 'final') {
      for (const index of renderSlots(snapshot.plan)) {
        if (!(await this.step(tx, task, `FILE:${index}`))) cloneConflict('尚有生成文件未保存');
      }
    } else if (referenceIndex !== null) {
      await this.assertShotReferenceAdmission(tx, task, referenceIndex);
    } else {
      const index = Number(slot);
      if (!/^[0-3]$/.test(slot) || !renderSlots(snapshot.plan).includes(index))
        cloneConflict('生成文件不属于当前任务');
      const render = await this.step(tx, task, `RENDER:${index}`);
      if ((render?.output as { state?: string } | undefined)?.state !== 'CREATED')
        cloneConflict('镜头尚未记录供应商任务');
    }
    const existing = await this.step(tx, task, `FILE:${slot}`);
    return { snapshot, existing: existing?.output as CloneGenerationFile | undefined };
  }

  private async assertShotReferenceAdmission(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
    index: number,
  ) {
    const { plan } = generationSnapshot(task);
    if (
      plan.mode !== CLONE_SHOT_REFERENCE_MODE ||
      !Number.isSafeInteger(index) ||
      !plan.shots[index]
    )
      cloneConflict('参考片段不属于当前任务');
    if (await this.step(tx, task, `RENDER:${index}`))
      cloneConflict('镜头创建意图已登记，请继续恢复已有任务');
  }

  private async readShotReference(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
    index: number,
  ) {
    const reference = (await this.step(tx, task, `FILE:reference-${index}`))?.output as
      CloneGenerationFile | undefined;
    if (!reference) cloneConflict('请先准备当前镜头的参考片段');
    const hold = await tx.fissionCloneFileHold.findFirst({
      where: { ...taskWhere(task), fileObjectId: reference.fileObjectId, sha256: reference.sha256 },
      include: { fileObject: true },
    });
    const file = hold?.fileObject;
    if (
      !file ||
      file.projectId !== task.projectId ||
      file.workflowRunId !== task.workflowRunId ||
      file.nodeId !== 'CLONE_GENERATION' ||
      file.mimeType !== 'video/mp4' ||
      file.status !== 'AVAILABLE' ||
      file.sha256 !== reference.sha256 ||
      file.sizeBytes !== reference.sizeBytes
    )
      cloneConflict('镜头参考片段的执行文件不可用');
    return file;
  }

  shotReferenceForSigning(projectId: string, taskId: string, token: string, index: number) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      await this.assertShotReferenceAdmission(tx, task, index);
      const { storageKey, sizeBytes } = await this.readShotReference(tx, task, index);
      return { storageKey, sizeBytes };
    });
  }

  fileAdmission(projectId: string, taskId: string, token: string, slot: string) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      return this.fileInput(tx, task, slot);
    });
  }

  sourceVideoForSigning(projectId: string, taskId: string, token: string) {
    return this.db.$transaction(async (tx) => {
      const task = await this.tasks.lease(tx, projectId, taskId, token, true);
      const { plan } = generationSnapshot(task);
      if (plan.mode !== 'SEEDANCE_2_0_SOURCE_EDIT' || !plan.sourceVideo)
        cloneConflict('当前任务不需要原片编辑签名');
      if (await this.step(tx, task, 'RENDER:0'))
        cloneConflict('原片编辑已登记创建，请继续恢复已有任务');
      const file = await tx.fileObject.findFirst({
        where: {
          id: plan.sourceVideo.fileObjectId,
          projectId,
          workflowRunId: task.workflowRunId,
        },
        select: { storageKey: true, sizeBytes: true },
      });
      if (!file) cloneConflict('成片任务冻结原片不可用');
      return file;
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
      if (!reviewCoversFrozenShots(generationSnapshot(task).plan, review))
        cloneConflict('审片证据未覆盖冻结镜头或引用了未抽样帧');
      const previous = await this.step(tx, task, REVIEW_STEP);
      if (previous && previous.outputHash !== workflowStateHash(review))
        cloneConflict('审片检查点已保存');
      if (!previous) await this.createStep(tx, task, token, REVIEW_STEP, review);
      return { accepted: true };
    });
  }

  private async readyVideo(tx: Prisma.TransactionClient, task: FissionCloneTask) {
    const { plan, variantId } = generationSnapshot(task);
    const file = (await this.step(tx, task, 'FILE:final'))?.output as
      CloneGenerationFile | undefined;
    const review = (await this.step(tx, task, REVIEW_STEP))?.output as
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
    const label = plan.productName
      ? `${Array.from(plan.productName).slice(0, 92).join('')} · `
      : '';
    const name = `${label}复刻成片${task.generationSlot ? ` ${task.generationSlot}` : ''}`;
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
    const sample = parent.currentStage === 'SAMPLE';
    if (sample && (!batch.sampleFirst || task.generationSlot !== 1))
      cloneConflict('首条验证的派发范围无效');
    const children = await requireGenerationChildren(tx, parent, sample ? 1 : batch.count);
    if (children.some((item) => item.status !== 'SUCCEEDED')) return;

    const planned = batch.planningModel ? await this.step(tx, parent, PLAN_DRAFT) : null;
    if (batch.planningModel && (!planned || !(await this.step(tx, parent, PLAN_REVIEW))))
      cloneConflict('成片批次缺少已审查的规划');
    const draft = planned ? parseCloneGenerationVariantDraft(planned.output) : null;
    if (draft)
      validateCloneVariantDraft(batch.plan, batch.variantIds!, draft, batch.planningVersion);
    if (sample) {
      if (!draft) cloneConflict('首条验证缺少批次规划');
      await verifyGenerationBatchSources(tx, parent);
      const variant = draft.variants[0]!;
      const expected: CloneGenerationSnapshot = {
        plan: compileCloneVariant(batch.plan, variant),
        variantId: variant.variantId,
        model: batch.model,
        reviewModel: batch.reviewModel,
      };
      if (workflowStateHash(expected) !== task.inputHash)
        cloneConflict('首条验证的执行快照与批次规划不一致');
      await this.dispatchPlannedItems(tx, parent, batch, draft, 1, batch.count);
      await tx.fissionCloneTask.update({
        where: { id: parent.id },
        data: { currentStage: 'PLANNED' },
      });
      await releaseCloneTaskFiles(tx, parent);
      return;
    }
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
