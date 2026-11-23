import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  emptyLocalReplaceDraft,
  LOCAL_REPLACE_LIMITS,
  LOCAL_REPLACE_SOURCE_MIME_TYPES,
  LOCAL_REPLACE_TARGET_MIME_TYPES,
  parseLocalReplaceDraft,
  parseLocalReplaceSourceProbe,
  parseLocalReplaceWorkerInput,
  validateLocalReplaceForRender,
  type LocalReplaceAssetRef,
  type LocalReplaceClaim,
  type LocalReplaceDraftSaveRequest,
  type LocalReplaceSourceProbe,
  type LocalReplaceTask,
  type LocalReplaceTaskCreateRequest,
  type LocalReplaceWorkerInput,
  type LocalReplaceWorkspace,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { PrismaService } from '../../../database/prisma.service';
import type { FissionLocalReplaceTask, Prisma } from '../../../generated/prisma/client';
import {
  LOCAL_REPLACE_DRAFT_NODE as DRAFT_NODE,
  lockLocalReplaceProject,
  lockLocalReplaceRun,
} from '../../../platform/workflow/fission-local-replace-scope';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

const PLAN_NODE = 'LOCAL_REPLACE_PROMPT';
const PLAN_KEY = 'local-replace-plan';
const OUTPUT_NODE = 'LOCAL_REPLACE_OUTPUT';
const QUEUE = 'fission.local_replace.requested';
const JOB_TYPE = 'FISSION_LOCAL_REPLACE';
const MAX_ATTEMPTS = 3;
const LEASE_MS = 90_000;
const UNKNOWN_CREATE = 'PROVIDER_CREATION_UNKNOWN';
const sourceMedia = {
  mime: LOCAL_REPLACE_SOURCE_MIME_TYPES,
  max: LOCAL_REPLACE_LIMITS.maxSourceBytes,
};
const targetMedia = {
  mime: LOCAL_REPLACE_TARGET_MIME_TYPES,
  max: LOCAL_REPLACE_LIMITS.maxTargetBytes,
};
const scope = (projectId: string, workflowRunId: string) => ({ projectId, workflowRunId });
type Scope = ReturnType<typeof scope>;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const conflict = (message: string): never => {
  throw new ApiHttpException(message, 409, 'CONFLICT');
};
const missing = (message: string): never => {
  throw new ApiHttpException(message, 404, 'VALIDATION_ERROR');
};
const invalidMedia = (message: string): never => {
  throw new ApiHttpException(message, 422, 'VALIDATION_ERROR');
};
const outputKey = (id: string) => `local-replace-video:${id}`;
const unknownCreation = (task: FissionLocalReplaceTask) =>
  task.providerCreationPending && !task.providerTaskId;
const activeStatus = ['QUEUED', 'RUNNING'];
const typeError400 = (error: unknown): never => {
  if (!(error instanceof TypeError)) throw error;
  throw new ApiHttpException(error.message, 400, 'VALIDATION_ERROR');
};

type FrozenMedia<T extends string> = LocalReplaceAssetRef & {
  versionId: string;
  storageKey: string;
  mimeType: T;
  sizeBytes: number;
};
type TaskSnapshot = {
  source: FrozenMedia<LocalReplaceWorkerInput['sourceMimeType']>;
  target: FrozenMedia<LocalReplaceWorkerInput['targetMimeType']>;
  input: LocalReplaceWorkerInput;
};
type PlanRef = { id: string; revision: number; contentHash: string };
type Reservation = { state: 'RESERVED' | 'UNKNOWN' } | { state: 'KNOWN'; providerTaskId: string };

const snapshot = (task: FissionLocalReplaceTask): TaskSnapshot =>
  task.inputSnapshot as unknown as TaskSnapshot;
const currentPlan = (task: FissionLocalReplaceTask, plan: PlanRef | null) =>
  plan?.id === task.planArtifactId &&
  plan.revision === task.planRevision &&
  plan.contentHash === task.planContentHash;
const messages: Record<string, string> = {
  QUEUED: '等待处理',
  RUNNING: '正在处理原片',
  SUCCEEDED: '成片已完成，请对照原片检查',
  FAILED: '局部替换失败',
  CANCELLED: '任务已取消',
  [UNKNOWN_CREATE]: '供应商创建结果待核查，已暂停本项目当前局部替换任务的新请求',
  PROVIDER_REJECTED: '供应商拒绝创建任务，请核对原片、目标图和配置',
  PROVIDER_FAILED: '供应商编辑未成功',
  MEDIA_INVALID: '原片、目标图或成片的媒体规格不符合要求',
  INTERNAL_API_FAILED: '执行服务暂时无法取得素材或保存成片',
  INVALID_TASK: '局部替换任务的执行数据无效',
  LEASE_EXPIRED: '执行服务失联，任务达到恢复上限',
};

function presentTask(task: FissionLocalReplaceTask, plan: PlanRef | null): LocalReplaceTask {
  const { source, input } = snapshot(task);
  const stale = !currentPlan(task, plan);
  const contentUrl = `/api/projects/${task.projectId}/workflow-runs/${task.workflowRunId}/fission-local-replace/tasks/${task.id}/content`;
  return {
    id: task.id,
    status: task.status as LocalReplaceTask['status'],
    source: { assetId: source.assetId, version: source.version },
    startMs: input.startMs,
    endMs: input.endMs,
    progress: task.progress,
    message: messages[task.errorCode ?? ''] ?? messages[task.status] ?? '处理状态未知',
    canRetry: !stale && task.status === 'FAILED' && task.retryable,
    stale,
    result:
      task.status === 'SUCCEEDED' && task.resultSha256
        ? { contentUrl, downloadUrl: `${contentUrl}?download=true` }
        : null,
    createdAt: task.createdAt.toISOString(),
  };
}

@Injectable()
export class LocalReplaceRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}

  private draft(tx: Prisma.TransactionClient, ids: Scope) {
    return tx.workflowNodeState.findUniqueOrThrow({
      where: { projectId_workflowRunId_nodeId: { ...ids, nodeId: DRAFT_NODE } },
    });
  }

  private plan(tx: Prisma.TransactionClient, ids: Scope) {
    return tx.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          ...ids,
          nodeId: PLAN_NODE,
          artifactKey: PLAN_KEY,
        },
      },
      select: { id: true, revision: true, contentHash: true },
    });
  }

  private async readWorkspace(
    tx: Prisma.TransactionClient,
    ids: Scope,
  ): Promise<LocalReplaceWorkspace> {
    const [draft, plan, tasks] = await Promise.all([
      this.draft(tx, ids),
      this.plan(tx, ids),
      tx.fissionLocalReplaceTask.findMany({
        where: ids,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);
    return {
      runId: ids.workflowRunId,
      draftRevision: draft.revision,
      draft: parseLocalReplaceDraft(draft.state),
      tasks: tasks.map((task) => presentTask(task, plan)),
    };
  }

  initialize(projectId: string) {
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceProject(tx, projectId);
      const key = {
        projectId,
        workflow: 'FISSION' as const,
        workflowSpace: 'FISSION_LOCAL_REPLACE' as const,
        activeKey: 'ACTIVE',
      };
      const run = await tx.workflowRun.upsert({
        where: { projectId_workflow_workflowSpace_activeKey: key },
        create: { ...key, currentNodeId: DRAFT_NODE },
        update: {},
      });
      const ids = scope(projectId, run.id);
      if (run.status === 'PAUSED') {
        await tx.workflowNodeState.updateMany({
          where: { ...ids, nodeId: DRAFT_NODE },
          data: { revision: { increment: 1 } },
        });
        await tx.workflowRun.update({
          where: { id: run.id },
          data: { status: 'ACTIVE', lastActiveAt: new Date() },
        });
      } else if (run.status !== 'ACTIVE') {
        conflict('该工作流已经结束');
      }
      const draft = emptyLocalReplaceDraft();
      const draftKey = { ...ids, nodeId: DRAFT_NODE };
      await tx.workflowNodeState.upsert({
        where: { projectId_workflowRunId_nodeId: draftKey },
        create: { ...draftKey, state: json(draft), contentHash: workflowStateHash(draft) },
        update: {},
      });
      return this.readWorkspace(tx, ids);
    });
  }

  workspace(projectId: string, runId: string) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids);
      return this.readWorkspace(tx, ids);
    });
  }

  private async media<T extends string>(
    tx: Prisma.TransactionClient,
    projectId: string,
    ref: LocalReplaceAssetRef,
    spec: { mime: readonly T[]; max: number },
  ): Promise<FrozenMedia<T>> {
    const version = await tx.assetVersion.findFirst({
      where: {
        projectId,
        assetId: ref.assetId,
        version: ref.version,
        asset: { projectId, archivedAt: null, hasFile: true },
        OR: [
          { status: 'AVAILABLE', asset: { status: 'AVAILABLE' } },
          {
            status: 'PENDING_REVIEW',
            asset: {
              status: 'PENDING_REVIEW',
              storageWorkflow: 'FISSION',
              workflowSpace: 'FISSION_LOCAL_REPLACE',
            },
          },
        ],
      },
    });
    if (!version) return conflict('素材版本不可用或不属于当前项目');
    const mimeType = spec.mime.find((mime) => mime === version.mimeType);
    if (!mimeType || !version.storageKey || version.sizeBytes <= 0 || version.sizeBytes > spec.max)
      throw new ApiHttpException('选中素材不符合类型或大小要求', 400, 'VALIDATION_ERROR');
    return {
      ...ref,
      versionId: version.id,
      mimeType,
      storageKey: version.storageKey,
      sizeBytes: version.sizeBytes,
    };
  }

  saveDraft(projectId: string, runId: string, request: LocalReplaceDraftSaveRequest) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids, true);
      const previous = await this.draft(tx, ids);
      if (previous.revision !== request.expectedRevision) conflict('草稿已更新，请刷新后重试');
      const draft = {
        ...request.draft,
        objectDescription: request.draft.objectDescription.trim(),
        instruction: request.draft.instruction.trim(),
      };
      if (draft.source) await this.media(tx, projectId, draft.source, sourceMedia);
      if (draft.target) await this.media(tx, projectId, draft.target, targetMedia);
      const contentHash = workflowStateHash(draft);
      if (contentHash !== previous.contentHash) {
        await tx.workflowNodeState.update({
          where: { id: previous.id },
          data: { state: json(draft), contentHash, revision: { increment: 1 } },
        });
        await tx.workflowRun.update({
          where: { id: runId },
          data: { currentNodeId: draft.nodeId, lastActiveAt: new Date() },
        });
      }
      return this.readWorkspace(tx, ids);
    });
  }

  private async enqueue(tx: Prisma.TransactionClient, ids: Scope, taskId: string) {
    const key = { projectId: ids.projectId, jobType: JOB_TYPE, aggregateId: taskId };
    await tx.jobOutbox.upsert({
      where: { projectId_jobType_aggregateId: key },
      create: {
        ...key,
        routingKey: QUEUE,
        payload: {
          schemaVersion: 1,
          projectId: ids.projectId,
          runId: ids.workflowRunId,
          requestId: taskId,
        },
      },
      update: {
        status: 'PENDING',
        attempts: 0,
        dispatchToken: null,
        nextAttemptAt: new Date(),
        lastError: null,
        publishedAt: null,
      },
    });
  }

  private async preventConcurrent(tx: Prisma.TransactionClient, ids: Scope) {
    const tasks = tx.fissionLocalReplaceTask;
    if (await tasks.count({ where: { ...ids, status: { in: activeStatus } } }))
      conflict('已有局部替换任务正在执行');
    if (
      await tasks.count({ where: { ...ids, providerCreationPending: true, providerTaskId: null } })
    )
      conflict(messages[UNKNOWN_CREATE]!);
  }

  create(projectId: string, runId: string, request: LocalReplaceTaskCreateRequest, model: string) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids, true);
      const previous = await tx.fissionLocalReplaceTask.findUnique({
        where: {
          projectId_workflowRunId_idempotencyKey: {
            ...ids,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (previous) {
        if (previous.draftRevision !== request.expectedRevision)
          conflict('同一请求标识对应不同草稿版本');
        return this.readWorkspace(tx, ids);
      }
      await this.preventConcurrent(tx, ids);
      const row = await this.draft(tx, ids);
      if (row.revision !== request.expectedRevision) conflict('草稿已更新，请刷新后重试');
      const parsedDraft = parseLocalReplaceDraft(row.state);
      try {
        validateLocalReplaceForRender(parsedDraft);
      } catch (error) {
        return typeError400(error);
      }
      const { nodeId: _nodeId, ...draft } = parsedDraft;
      const source = await this.media(tx, projectId, draft.source!, sourceMedia);
      const target = await this.media(tx, projectId, draft.target!, targetMedia);
      const { startMs, endMs, objectType, objectDescription, instruction } = draft;
      const input = parseLocalReplaceWorkerInput({
        schemaVersion: 1,
        model,
        sourceMimeType: source.mimeType,
        targetMimeType: target.mimeType,
        sourceSizeBytes: source.sizeBytes,
        targetSizeBytes: target.sizeBytes,
        startMs,
        endMs,
        objectType,
        objectDescription,
        instruction,
      });
      const [confirmed] = await this.working.commitValidatedArtifactsInTransaction(
        tx,
        projectId,
        runId,
        PLAN_NODE,
        [
          {
            artifactKey: PLAN_KEY,
            input: {
              kind: 'STRUCTURED',
              name: '局部元素替换方案',
              directory: 'REPLACEMENT_PLANS',
              type: 'REPLACEMENT_MAPPING',
              payload: {
                ...draft,
                sourceVersionId: source.versionId,
                targetVersionId: target.versionId,
              },
            },
          },
        ],
      );
      const plan = confirmed!.record;
      const task = await tx.fissionLocalReplaceTask.create({
        data: {
          ...ids,
          idempotencyKey: request.idempotencyKey,
          draftRevision: row.revision,
          planArtifactId: plan.id,
          planRevision: plan.revision,
          planContentHash: plan.contentHash,
          inputSnapshot: json({ source, target, input } satisfies TaskSnapshot),
        },
      });
      await this.enqueue(tx, ids, task.id);
      return this.readWorkspace(tx, ids);
    });
  }

  private async task(tx: Prisma.TransactionClient, ids: Scope, id: string) {
    const task = await tx.fissionLocalReplaceTask.findFirst({ where: { ...ids, id } });
    if (!task) return missing('局部替换任务不存在');
    return task;
  }

  action(projectId: string, runId: string, taskId: string, action: 'cancel' | 'retry') {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids, true);
      const task = await this.task(tx, ids, taskId);
      if (action === 'cancel') {
        if (task.status === 'CANCELLED') return this.readWorkspace(tx, ids);
        if (!activeStatus.includes(task.status)) conflict('当前任务无法取消');
        if (unknownCreation(task)) conflict('供应商正在确认创建，得到任务号后即可取消');
        await tx.fissionLocalReplaceTask.update({
          where: { id: task.id },
          data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null, retryable: false },
        });
      } else {
        if (activeStatus.includes(task.status)) return this.readWorkspace(tx, ids);
        if (task.status !== 'FAILED' || !task.retryable || task.attemptCount >= MAX_ATTEMPTS)
          conflict('当前任务无法重试');
        if (!currentPlan(task, await this.plan(tx, ids)))
          conflict('替换方案已更新，请按当前方案生成');
        await this.preventConcurrent(tx, ids);
        await tx.fissionLocalReplaceTask.update({
          where: { id: task.id },
          data: { status: 'QUEUED', errorCode: null, retryable: false },
        });
        await this.enqueue(tx, ids, task.id);
      }
      return this.readWorkspace(tx, ids);
    });
  }

  private async finalizeExpired(tx: Prisma.TransactionClient, task: FissionLocalReplaceTask) {
    const errorCode = unknownCreation(task) ? UNKNOWN_CREATE : 'LEASE_EXPIRED';
    await tx.fissionLocalReplaceTask.update({
      where: { id: task.id },
      data: {
        status: 'FAILED',
        retryable: false,
        attemptToken: null,
        leaseExpiresAt: null,
        errorCode,
      },
    });
  }

  async claim(projectId: string, runId: string, taskId: string): Promise<LocalReplaceClaim> {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      const { run } = await lockLocalReplaceRun(tx, ids);
      if (!['ACTIVE', 'PAUSED'].includes(run.status) || run.activeKey !== 'ACTIVE')
        return { status: 'INACTIVE' };
      const task = await this.task(tx, ids, taskId);
      if (task.status === 'RUNNING' && task.leaseExpiresAt && task.leaseExpiresAt > new Date())
        return { status: 'BUSY' };
      if (!activeStatus.includes(task.status)) return { status: 'INACTIVE' };
      if (unknownCreation(task) || task.attemptCount >= MAX_ATTEMPTS) {
        await this.finalizeExpired(tx, task);
        return { status: 'INACTIVE' };
      }
      const attemptToken = randomUUID();
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: {
          status: 'RUNNING',
          progress: Math.max(task.progress, 5),
          attemptToken,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          attemptCount: { increment: 1 },
        },
      });
      return {
        status: 'CLAIMED',
        attemptToken,
        input: snapshot(task).input,
        providerTaskId: task.providerTaskId,
        creationPending: task.providerCreationPending,
      };
    });
  }

  private async recoverOne(ids: Scope, taskId: string) {
    await this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      if (task.status !== 'RUNNING' || !task.leaseExpiresAt || task.leaseExpiresAt > new Date())
        return;
      if (unknownCreation(task) || task.attemptCount >= MAX_ATTEMPTS) {
        await this.finalizeExpired(tx, task);
        return;
      }
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null },
      });
      await this.enqueue(tx, ids, task.id);
    });
  }

  async recoverExpired() {
    const expired = await this.db.fissionLocalReplaceTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: new Date() } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
    });
    for (const { projectId, workflowRunId, id } of expired)
      await this.recoverOne(scope(projectId, workflowRunId), id);
  }

  private assertLease(task: FissionLocalReplaceTask, token: string) {
    if (
      !token ||
      task.status !== 'RUNNING' ||
      task.attemptToken !== token ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= new Date()
    )
      conflict('执行租约已失效');
  }

  private async withLease<T>(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    action: (tx: Prisma.TransactionClient, task: FissionLocalReplaceTask) => Promise<T>,
  ) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      const { run } = await lockLocalReplaceRun(tx, ids);
      if (!['ACTIVE', 'PAUSED'].includes(run.status) || run.activeKey !== 'ACTIVE')
        conflict('局部替换工作流已经结束');
      const task = await this.task(tx, ids, taskId);
      this.assertLease(task, token);
      return action(tx, task);
    });
  }

  heartbeat(projectId: string, runId: string, taskId: string, token: string, progress?: number) {
    return this.withLease(projectId, runId, taskId, token, async (tx, task) => {
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: {
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          progress: Math.max(task.progress, progress ?? 0),
        },
      });
      return { accepted: true };
    });
  }

  workerFile(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    role: 'source' | 'target',
  ) {
    return this.withLease(projectId, runId, taskId, token, (tx, task) =>
      this.verifyFrozenMedia(tx, task, role),
    );
  }

  private async verifyFrozenMedia(
    tx: Prisma.TransactionClient,
    task: FissionLocalReplaceTask,
    role: 'source' | 'target',
  ) {
    const file = snapshot(task)[role];
    const current = await this.media(
      tx,
      task.projectId,
      { assetId: file.assetId, version: file.version },
      role === 'source' ? sourceMedia : targetMedia,
    ).catch((error: unknown) => {
      if (error instanceof ApiHttpException && [400, 409].includes(error.getStatus()))
        return invalidMedia('任务冻结素材版本不可用');
      throw error;
    });
    if (workflowStateHash(file) !== workflowStateHash(current)) invalidMedia('冻结素材版本已变化');
    return current;
  }

  reserve(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    sourceProbe: LocalReplaceSourceProbe,
  ): Promise<Reservation> {
    return this.withLease(projectId, runId, taskId, token, async (tx, task) => {
      if (
        task.sourceProbe &&
        workflowStateHash(task.sourceProbe) !== workflowStateHash(sourceProbe)
      )
        invalidMedia('原片探测结果与冻结时间线不一致');
      if (snapshot(task).input.endMs > ((sourceProbe.frameCount + 0.5) / 24) * 1000)
        invalidMedia('替换区间超出原片时长');
      if (task.providerTaskId) return { state: 'KNOWN', providerTaskId: task.providerTaskId };
      if (task.providerCreationPending) return { state: 'UNKNOWN' };
      await this.verifyFrozenMedia(tx, task, 'source');
      await this.verifyFrozenMedia(tx, task, 'target');
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: { providerCreationPending: true, progress: Math.max(task.progress, 35), sourceProbe },
      });
      return { state: 'RESERVED' };
    });
  }

  bindProvider(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    providerTaskId: string,
  ) {
    return this.withLease(projectId, runId, taskId, token, async (tx, task) => {
      if (task.providerTaskId) {
        if (task.providerTaskId !== providerTaskId) conflict('已绑定另一供应商任务');
        return { accepted: true };
      }
      if (!task.providerCreationPending) conflict('供应商创建尚未预约');
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: {
          providerTaskId,
          providerCreationPending: false,
          progress: Math.max(task.progress, 50),
        },
      });
      return { accepted: true };
    });
  }

  fail(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    retryable: boolean,
    code: string,
  ) {
    return this.withLease(projectId, runId, taskId, token, async (tx, task) => {
      const rejected = code === 'PROVIDER_REJECTED' && !task.providerTaskId;
      const pending = unknownCreation(task) && !rejected;
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: {
          status: 'FAILED',
          providerCreationPending: pending,
          errorCode: pending ? UNKNOWN_CREATE : code,
          retryable: !pending && retryable && task.attemptCount < MAX_ATTEMPTS,
          attemptToken: null,
          leaseExpiresAt: null,
        },
      });
      return { accepted: true };
    });
  }

  private checkResultTask(task: FissionLocalReplaceTask, token: string) {
    if (token && task.status === 'SUCCEEDED' && task.attemptToken === token) return;
    this.assertLease(task, token);
    if (!task.providerTaskId) conflict('成片缺少已绑定的供应商任务');
  }

  resultAdmission(projectId: string, runId: string, taskId: string, token: string) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      const { project } = await lockLocalReplaceRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      this.checkResultTask(task, token);
      return {
        projectName: project.name,
        sourceProbe: parseLocalReplaceSourceProbe(task.sourceProbe),
        resultSha256: task.resultSha256,
      };
    });
  }

  complete(projectId: string, runId: string, taskId: string, token: string, file: FileObjectInput) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      this.checkResultTask(task, token);
      if (task.status === 'SUCCEEDED') {
        if (task.resultSha256 !== file.sha256) conflict('已提交不同成片');
        return false;
      }
      if (!currentPlan(task, await this.plan(tx, ids))) conflict('已确认替换方案发生变化');
      await this.verifyFrozenMedia(tx, task, 'source');
      await this.verifyFrozenMedia(tx, task, 'target');
      const stored = await this.working.upsertFileObjectInTransaction(tx, projectId, runId, file);
      await this.working.commitValidatedArtifactsInTransaction(tx, projectId, runId, OUTPUT_NODE, [
        {
          artifactKey: outputKey(taskId),
          input: {
            kind: 'FILE',
            name: '局部元素替换成片',
            directory: 'FINAL_VIDEOS',
            type: 'FINAL_VIDEO',
            payload: { taskId },
            files: [
              {
                fileObjectId: stored.id,
                role: 'OUTPUT',
                sortOrder: 0,
                originalFileName: stored.originalFileName,
                mimeType: stored.mimeType,
                sha256: stored.sha256,
              },
            ],
            dependencies: [
              {
                sourceType: 'WORKING_ARTIFACT',
                sourceNodeId: PLAN_NODE,
                sourceArtifactId: task.planArtifactId,
                sourceKey: PLAN_KEY,
                sourceRevision: task.planRevision,
                sourceHash: task.planContentHash,
              },
            ],
          },
        },
      ]);
      await tx.fissionLocalReplaceTask.update({
        where: { id: task.id },
        data: {
          status: 'SUCCEEDED',
          progress: 100,
          leaseExpiresAt: null,
          resultSha256: file.sha256,
        },
      });
      return true;
    });
  }

  output(projectId: string, runId: string, taskId: string) {
    const ids = scope(projectId, runId);
    return this.db.$transaction(async (tx) => {
      await lockLocalReplaceRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      if (task.status !== 'SUCCEEDED') return missing('成片尚未可用');
      const file = await tx.workingArtifactFile.findFirst({
        where: {
          ...ids,
          role: 'OUTPUT',
          workingArtifact: {
            artifactKey: outputKey(taskId),
            nodeId: OUTPUT_NODE,
            availability: 'AVAILABLE',
          },
          fileObject: {
            workflowRunId: runId,
            status: 'AVAILABLE',
            sha256: task.resultSha256 ?? '',
          },
        },
        include: { fileObject: true },
      });
      if (!file) return missing('成片文件不可用');
      return file.fileObject;
    });
  }
}
