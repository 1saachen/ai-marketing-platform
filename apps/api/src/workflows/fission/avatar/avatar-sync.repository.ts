import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AVATAR_LONG_LIMITS,
  isAvatarLongSyncMedia,
  AVATAR_LONG_SYNC_QUEUE,
  AVATAR_SYNC_ACTIVE_PHASES,
  AVATAR_SYNC_ARTIFACT_KEY,
  AVATAR_SYNC_NODE,
  AVATAR_SYNC_QUEUE,
  FISSION_AVATAR_ARTIFACT_KEYS,
  FISSION_AVATAR_NODES,
  planAvatarLongSegments,
  parseAvatarSyncWorkerInput,
  type AvatarSyncCheckpoint,
  type AvatarSyncClaim,
  type AvatarSyncCompletion,
  type AvatarSyncCreateRequest,
  type AvatarSyncFailure,
  type AvatarSyncHeartbeat,
  type AvatarSyncMedia,
  type AvatarSyncResult,
  type AvatarSyncTask,
  type AvatarSyncWorkspace,
  type AvatarTailChainCheckpoint,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { PrismaService } from '../../../database/prisma.service';
import type { FissionAvatarSyncTask, Prisma, WorkflowRun } from '../../../generated/prisma/client';
import {
  avatarSyncReconciliationFilter,
  lockAvatarRun,
} from '../../../platform/workflow/fission-avatar-scope';
import {
  WorkflowWorkingRepository,
  workingArtifactInclude,
  type FileObjectInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  avatarSyncGrantsValid,
  isAvatarSyncCurrent,
  prepareAvatarSyncSources,
  readAvatarSyncSelection,
  sameAvatarArtifactRef,
  type AvatarSyncOrigin,
  type AvatarSyncScope,
  type AvatarSyncSources,
} from './avatar-sync-source';
import {
  clearSegmentMedia,
  isSegmented,
  longWorkerInput,
  nextSegment,
  segmentFile,
  segmentProgress,
  segmentsForTask,
  tailChainWorkerInput,
  unknownSegment,
  validateSegmentedTimeline,
  validateTailChainSegment,
  validateTailChainTimeline,
} from './avatar-long-sync-segments';

const ACTIVE_STATUSES = ['QUEUED', 'RUNNING'];
const LEASE_MS = 90_000;
const SEGMENT_RETRY_RECHECK_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const JOB_TYPE = 'FISSION_AVATAR_SYNC';
const UNKNOWN_CREATION = 'PROVIDER_CREATION_UNKNOWN';
const LONG_SCRIPT_MAX = AVATAR_LONG_LIMITS.maxSegments * AVATAR_LONG_LIMITS.maxSegmentCharacters;
const LONG_SCRIPT_BLOCKED = `长片文案须能按停顿拆成 ${AVATAR_LONG_LIMITS.minSegments} 至 ${AVATAR_LONG_LIMITS.maxSegments} 段，每段最多 ${AVATAR_LONG_LIMITS.maxSegmentCharacters} 字`;

const phases = ['QUEUED', ...AVATAR_SYNC_ACTIVE_PHASES, 'COMPLETE'];
const messages: Record<string, string> = {
  MEDIA_INVALID: '同步媒体未通过时长、格式或音轨校验',
  PROVIDER_REJECTED: '供应商拒绝了本次生成请求',
  PROVIDER_FAILED: '语音、画面生成或口型驱动失败',
  PROVIDER_CREATION_UNKNOWN: '供应商任务创建结果未知，需要核对记录',
  INTERNAL_API_FAILED: '执行暂未完成，可按状态重试',
  INVALID_TASK: '任务输入无效',
  SOURCE_STALE: '已确认输入或授权已变化，请按当前配置生成',
  LEASE_EXPIRED: '执行超时，未提交结果',
};

type OutputRole = 'audio' | 'video';
type ResultPayload = {
  origin: AvatarSyncOrigin;
  media: AvatarSyncMedia;
};

function snapshot(task: FissionAvatarSyncTask) {
  return task.inputSnapshot as unknown as AvatarSyncSources;
}

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function conflict(message: string): never {
  throw new ApiHttpException(message, 409, 'CONFLICT');
}

function unavailable(message: string): never {
  throw new ApiHttpException(message, 404, 'VALIDATION_ERROR');
}

function unknownCreation(task: FissionAvatarSyncTask) {
  return task.lipSyncStarted && !task.lipSyncTaskId;
}

function runnable(run: WorkflowRun) {
  return (run.status === 'ACTIVE' || run.status === 'PAUSED') && run.activeKey === 'ACTIVE';
}

function ownsLease(task: FissionAvatarSyncTask, token: string) {
  return (
    !!token &&
    task.status === 'RUNNING' &&
    task.attemptToken === token &&
    !!task.leaseExpiresAt &&
    task.leaseExpiresAt > new Date()
  );
}

function ensureLease(task: FissionAvatarSyncTask, token: string) {
  if (!ownsLease(task, token)) conflict('口播任务租约已失效');
}

function cleanOrigin(source: AvatarSyncSources): AvatarSyncOrigin {
  const { storageKey: _storageKey, sizeBytes: _sizeBytes, ...character } = source.character;
  return { binding: source.binding, script: source.script, character, voice: source.voice };
}

function projectedTask(
  task: FissionAvatarSyncTask,
  stale: boolean,
  enabled: boolean,
  held: boolean,
  unknown: boolean,
  segments?: AvatarSyncTask['segments'],
  preparingPicture = false,
): AvatarSyncTask {
  const status = task.status as AvatarSyncTask['status'];
  const phase = task.phase as AvatarSyncTask['phase'];
  const message =
    status === 'FAILED'
      ? (messages[task.errorCode ?? ''] ?? '口播生成失败')
      : status === 'CANCELLED'
        ? '已取消口播生成'
        : status === 'SUCCEEDED'
          ? '口播素材已生成'
          : status === 'QUEUED'
            ? '口播任务排队中'
            : preparingPicture
              ? '正在生成接续画面'
              : phase === 'VALIDATING'
                ? '正在校验同步媒体'
                : phase === 'LIP_SYNC'
                  ? '正在驱动口型'
                  : '正在合成语音';
  return {
    id: task.id,
    status,
    phase,
    progress: task.progress,
    message,
    stale,
    ...(isSegmented(task) ? { mode: 'SEGMENTED' as const } : {}),
    ...(segments ? { segments } : {}),
    canCancel: ACTIVE_STATUSES.includes(status) && !unknown,
    canRetry:
      enabled &&
      !held &&
      !stale &&
      status === 'FAILED' &&
      task.retryable &&
      !unknown &&
      task.attemptCount < MAX_ATTEMPTS,
  };
}

@Injectable()
export class AvatarSyncRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}

  private result(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
    return tx.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          ...ids,
          nodeId: AVATAR_SYNC_NODE,
          artifactKey: AVATAR_SYNC_ARTIFACT_KEY,
        },
      },
      include: workingArtifactInclude,
    });
  }

  private unresolvedTask(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
    return tx.fissionAvatarSyncTask.findFirst({
      where: {
        ...ids,
        ...avatarSyncReconciliationFilter(),
      },
      select: { id: true },
    });
  }

  private async read(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    run: WorkflowRun,
    enabled: boolean,
    longEnabled: boolean,
    continuity: boolean,
  ): Promise<AvatarSyncWorkspace> {
    const selection = await readAvatarSyncSelection(tx, ids);
    const active = await tx.fissionAvatarSyncTask.findFirst({
      where: { ...ids, status: { in: ACTIVE_STATUSES } },
    });
    const latest =
      active ??
      (await tx.fissionAvatarSyncTask.findFirst({
        where: ids,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }));
    const held = await this.unresolvedTask(tx, ids);
    const segments = latest && isSegmented(latest) ? await segmentsForTask(tx, latest) : undefined;
    const artifact = await this.result(tx, ids);
    let result: AvatarSyncResult | null = null;
    if (artifact?.availability === 'AVAILABLE') {
      const payload = artifact.payload as unknown as ResultPayload;
      const granted = await avatarSyncGrantsValid(tx, ids.projectId, payload.origin);
      const stale = !granted || !(await isAvatarSyncCurrent(tx, ids, payload.origin, selection));
      const url = (role: OutputRole) =>
        granted &&
        artifact.files.some((file) => file.role === role && file.fileObject.status === 'AVAILABLE')
          ? `/api/projects/${ids.projectId}/workflow-runs/${ids.workflowRunId}/fission-avatar/sync/results/${artifact.id}/${role}?revision=${artifact.revision}`
          : null;
      result = {
        artifactId: artifact.id,
        revision: artifact.revision,
        stale,
        durationMs: payload.media.videoDurationMs,
        audioUrl: url('audio'),
        videoUrl: url('video'),
        wordTimings: granted ? payload.media.wordTimings : [],
      };
    }
    const sharedBlocked =
      run.status !== 'ACTIVE' || run.activeKey !== 'ACTIVE'
        ? '请先恢复当前工作区'
        : active
          ? '已有口播任务正在执行'
          : held
            ? messages.PROVIDER_CREATION_UNKNOWN!
            : null;
    const blockedReason = !enabled
      ? '数字人口播生成暂未启用'
      : (sharedBlocked ?? (await prepareAvatarSyncSources(tx, ids, selection)).blockedReason);
    let longBlocked = !longEnabled ? '长片分段生成暂未启用' : sharedBlocked;
    if (!longBlocked) {
      const prepared = await prepareAvatarSyncSources(
        tx,
        ids,
        selection,
        LONG_SCRIPT_MAX,
        continuity,
      );
      longBlocked = prepared.blockedReason;
      if (prepared.source && !prepared.source.tailChain) {
        try {
          planAvatarLongSegments(prepared.source.scriptText);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          longBlocked = LONG_SCRIPT_BLOCKED;
        }
      }
    }
    return {
      ...ids,
      enabled,
      canGenerate: blockedReason === null,
      blockedReason,
      ...(longEnabled || segments
        ? { long: { enabled: longEnabled, canGenerate: !longBlocked, blockedReason: longBlocked } }
        : {}),
      task: latest
        ? projectedTask(
            latest,
            !(await isAvatarSyncCurrent(tx, ids, snapshot(latest), selection)),
            segments ? longEnabled : enabled,
            !!held && held.id !== latest.id,
            segments ? !!unknownSegment(segments) : unknownCreation(latest),
            segments?.length ? segmentProgress(latest, segments) : undefined,
            !!latest.continuityPlan && nextSegment(segments ?? [])?.lipSyncStarted === false,
          )
        : null,
      result,
    };
  }

  workspace(ids: AvatarSyncScope, enabled: boolean, longEnabled = false, continuity = false) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      return this.read(tx, ids, run, enabled, longEnabled, continuity);
    });
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    taskId: string,
    segmented: boolean,
  ) {
    const key = { projectId: ids.projectId, jobType: JOB_TYPE, aggregateId: taskId };
    await tx.jobOutbox.upsert({
      where: { projectId_jobType_aggregateId: key },
      create: {
        ...key,
        routingKey: segmented ? AVATAR_LONG_SYNC_QUEUE : AVATAR_SYNC_QUEUE,
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

  private async ensureNoConcurrent(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    reconcilingTaskId?: string,
  ) {
    if (
      await tx.fissionAvatarSyncTask.count({ where: { ...ids, status: { in: ACTIVE_STATUSES } } })
    )
      conflict('已有口播任务正在执行');
    const held = await this.unresolvedTask(tx, ids);
    if (held && held.id !== reconcilingTaskId) conflict(messages.PROVIDER_CREATION_UNKNOWN!);
  }

  create(
    ids: AvatarSyncScope,
    request: AvatarSyncCreateRequest,
    longEnabled = false,
    shortEnabled = true,
    continuity = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids, true);
      const segmented = request.mode === 'SEGMENTED';
      if (segmented ? !longEnabled : !shortEnabled)
        throw new ApiHttpException('所选口播生成模式暂未启用', 503, 'INTERNAL_ERROR');
      const prior = await tx.fissionAvatarSyncTask.findUnique({
        where: {
          projectId_workflowRunId_idempotencyKey: {
            ...ids,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (prior) {
        const frozen = snapshot(prior);
        if (
          prior.draftRevision !== request.expectedDraftRevision ||
          isSegmented(prior) !== segmented ||
          !sameAvatarArtifactRef(frozen.binding, request.binding) ||
          !sameAvatarArtifactRef(frozen.script, request.script)
        )
          conflict('请求标识已用于其他口播输入');
        return this.read(tx, ids, run, shortEnabled, longEnabled, continuity);
      }
      await this.ensureNoConcurrent(tx, ids);
      const selection = await readAvatarSyncSelection(tx, ids);
      if (
        selection.draftRevision !== request.expectedDraftRevision ||
        !sameAvatarArtifactRef(selection.binding, request.binding) ||
        !sameAvatarArtifactRef(selection.script, request.script)
      )
        conflict('口播输入已更新，请刷新后重试');
      const prepared = await prepareAvatarSyncSources(
        tx,
        ids,
        selection,
        segmented ? LONG_SCRIPT_MAX : undefined,
        segmented && continuity,
      );
      if (!prepared.source)
        throw new ApiHttpException(prepared.blockedReason, 422, 'VALIDATION_ERROR');
      let segments: ReturnType<typeof planAvatarLongSegments> | null = null;
      if (segmented && !prepared.source.tailChain) {
        try {
          segments = planAvatarLongSegments(prepared.source.scriptText);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          throw new ApiHttpException(LONG_SCRIPT_BLOCKED, 422, 'VALIDATION_ERROR');
        }
      }
      const task = await tx.fissionAvatarSyncTask.create({
        data: {
          ...ids,
          idempotencyKey: request.idempotencyKey,
          draftRevision: selection.draftRevision,
          inputSnapshot: json(prepared.source),
          ...(segmented ? { executionKind: 'SEGMENTED' } : {}),
          ttsOperationId: randomUUID(),
          lipSyncClientToken: randomUUID(),
        },
      });
      if (segments) {
        await tx.fissionAvatarSyncSegment.createMany({
          data: segments.map(({ ordinal, text }) => ({
            ...ids,
            taskId: task.id,
            ordinal,
            scriptText: text,
            ttsOperationId: randomUUID(),
            lipSyncClientToken: randomUUID(),
          })),
        });
      }
      await this.enqueue(tx, ids, task.id, segmented);
      return this.read(tx, ids, run, shortEnabled, longEnabled, continuity);
    });
  }

  private async task(tx: Prisma.TransactionClient, ids: AvatarSyncScope, taskId: string) {
    const record = await tx.fissionAvatarSyncTask.findFirst({ where: { ...ids, id: taskId } });
    if (!record) unavailable('口播任务不存在');
    return record;
  }

  action(
    ids: AvatarSyncScope,
    taskId: string,
    action: 'retry' | 'cancel',
    enabled: boolean,
    longEnabled = false,
    continuity = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids, action === 'retry');
      const task = await this.task(tx, ids, taskId);
      const segmented = isSegmented(task);
      const pending = await this.pendingCreation(tx, task);
      if (action === 'cancel') {
        if (task.status === 'CANCELLED')
          return this.read(tx, ids, run, enabled, longEnabled, continuity);
        if (!ACTIVE_STATUSES.includes(task.status)) conflict('当前任务无法取消');
        if (pending) conflict('供应商正在确认创建，请等待受理结果');
        if (segmented) await clearSegmentMedia(tx, ids, task);
        await tx.fissionAvatarSyncTask.update({
          where: { id: task.id },
          data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null, retryable: false },
        });
      } else {
        if (segmented ? !longEnabled : !enabled)
          throw new ApiHttpException('所选口播生成模式暂未启用', 503, 'INTERNAL_ERROR');
        if (ACTIVE_STATUSES.includes(task.status))
          return this.read(tx, ids, run, enabled, longEnabled, continuity);
        if (
          task.status !== 'FAILED' ||
          !task.retryable ||
          task.attemptCount >= MAX_ATTEMPTS ||
          pending
        )
          conflict('当前任务无法重试');
        if (!(await isAvatarSyncCurrent(tx, ids, snapshot(task))))
          conflict('已确认输入或授权已变化，请按当前配置生成');
        await this.ensureNoConcurrent(tx, ids, task.id);
        await tx.fissionAvatarSyncTask.update({
          where: { id: task.id },
          data: { status: 'QUEUED', errorCode: null, retryable: false, leaseExpiresAt: null },
        });
        await this.enqueue(tx, ids, task.id, segmented);
      }
      return this.read(tx, ids, run, enabled, longEnabled, continuity);
    });
  }

  private async pendingCreation(tx: Prisma.TransactionClient, task: FissionAvatarSyncTask) {
    return isSegmented(task)
      ? !!unknownSegment(await segmentsForTask(tx, task))
      : unknownCreation(task);
  }

  private async finishFailed(
    tx: Prisma.TransactionClient,
    task: FissionAvatarSyncTask,
    code: string,
    retryable = false,
    lipSyncStarted = task.lipSyncStarted,
  ) {
    const canRetry = retryable && task.attemptCount < MAX_ATTEMPTS;
    if (isSegmented(task) && !canRetry && code !== UNKNOWN_CREATION) {
      await clearSegmentMedia(
        tx,
        { projectId: task.projectId, workflowRunId: task.workflowRunId },
        task,
      );
    }
    await tx.fissionAvatarSyncTask.update({
      where: { id: task.id },
      data: {
        status: 'FAILED',
        retryable: canRetry,
        errorCode: code,
        lipSyncStarted,
        attemptToken: null,
        leaseExpiresAt:
          isSegmented(task) && canRetry ? new Date(Date.now() + SEGMENT_RETRY_RECHECK_MS) : null,
      },
    });
  }

  claim(ids: AvatarSyncScope, taskId: string): Promise<AvatarSyncClaim> {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      if (!ACTIVE_STATUSES.includes(task.status)) return { status: 'INACTIVE' };
      if (task.status === 'RUNNING' && task.leaseExpiresAt && task.leaseExpiresAt > new Date())
        return { status: 'BUSY' };
      const source = snapshot(task);
      const segments = isSegmented(task) ? await segmentsForTask(tx, task) : undefined;
      const pending = segments ? !!unknownSegment(segments) : unknownCreation(task);
      if (pending || task.attemptCount >= MAX_ATTEMPTS) {
        await this.finishFailed(tx, task, pending ? UNKNOWN_CREATION : 'LEASE_EXPIRED');
        return { status: 'INACTIVE' };
      }
      if (!runnable(run) || !(await isAvatarSyncCurrent(tx, ids, source))) {
        await this.finishFailed(tx, task, 'SOURCE_STALE');
        return { status: 'INACTIVE' };
      }
      const input = segments
        ? source.tailChain
          ? await tailChainWorkerInput(tx, ids, task, segments, source)
          : await longWorkerInput(tx, ids, segments, source)
        : parseAvatarSyncWorkerInput({
            schemaVersion: 1,
            scriptText: source.scriptText,
            voiceSpeaker: source.voiceSpeaker,
            characterSizeBytes: source.character.sizeBytes,
            ttsOperationId: task.ttsOperationId,
            ttsStarted: task.ttsStarted,
            lipSyncClientToken: task.lipSyncClientToken,
            lipSyncStarted: task.lipSyncStarted,
            lipSyncTaskId: task.lipSyncTaskId,
          });
      const attemptToken = randomUUID();
      await tx.fissionAvatarSyncTask.update({
        where: { id: task.id },
        data: {
          status: 'RUNNING',
          phase: task.phase === 'QUEUED' ? 'TTS' : task.phase,
          progress: Math.max(task.progress, 5),
          attemptCount: { increment: 1 },
          attemptToken,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        },
      });
      return {
        status: 'CLAIMED',
        attemptToken,
        input,
      };
    });
  }

  async recoverExpired() {
    const expired = await this.db.fissionAvatarSyncTask.findMany({
      where: {
        leaseExpiresAt: { lte: new Date() },
        OR: [
          { status: 'RUNNING' },
          { status: 'FAILED', executionKind: 'SEGMENTED', retryable: true },
        ],
      },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
      select: { id: true, projectId: true, workflowRunId: true },
    });
    for (const { id, ...ids } of expired) {
      await this.db.$transaction(async (tx) => {
        let run;
        try {
          run = await lockAvatarRun(tx, ids);
        } catch (error) {
          if (error instanceof ApiHttpException && [404, 409].includes(error.getStatus())) return;
          throw error;
        }
        const task = await tx.fissionAvatarSyncTask.findFirst({ where: { ...ids, id } });
        if (!task || !task.leaseExpiresAt || task.leaseExpiresAt > new Date()) return;
        if (task.status === 'FAILED' && task.retryable && isSegmented(task)) {
          if (!runnable(run) || !(await isAvatarSyncCurrent(tx, ids, snapshot(task)))) {
            await this.finishFailed(tx, task, 'SOURCE_STALE');
          } else {
            await tx.fissionAvatarSyncTask.update({
              where: { id },
              data: { leaseExpiresAt: new Date(Date.now() + SEGMENT_RETRY_RECHECK_MS) },
            });
          }
          return;
        }
        if (task.status !== 'RUNNING') return;
        const pending = await this.pendingCreation(tx, task);
        if (pending || task.attemptCount >= MAX_ATTEMPTS) {
          await this.finishFailed(tx, task, pending ? UNKNOWN_CREATION : 'LEASE_EXPIRED');
          return;
        }
        if (!runnable(run) || !(await isAvatarSyncCurrent(tx, ids, snapshot(task)))) {
          await this.finishFailed(tx, task, 'SOURCE_STALE');
          return;
        }
        await tx.fissionAvatarSyncTask.update({
          where: { id },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null },
        });
        await this.enqueue(tx, ids, id, isSegmented(task));
      });
    }
  }

  heartbeat(ids: AvatarSyncScope, taskId: string, token: string, body: AvatarSyncHeartbeat) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      if (!runnable(run) || !ownsLease(task, token)) return { active: false };
      if (
        !(await this.pendingCreation(tx, task)) &&
        !(await isAvatarSyncCurrent(tx, ids, snapshot(task)))
      ) {
        await this.finishFailed(tx, task, 'SOURCE_STALE');
        return { active: false };
      }
      const phase =
        phases.indexOf(body.phase) > phases.indexOf(task.phase) ? body.phase : task.phase;
      await tx.fissionAvatarSyncTask.update({
        where: { id: task.id },
        data: {
          phase,
          progress: Math.max(task.progress, body.progress),
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        },
      });
      return { active: true };
    });
  }

  private async withLease<T>(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    action: (tx: Prisma.TransactionClient, task: FissionAvatarSyncTask) => Promise<T>,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      if (!runnable(run)) conflict('当前口播运行已关闭');
      const task = await this.task(tx, ids, taskId);
      ensureLease(task, token);
      return action(tx, task);
    });
  }

  async checkpoint(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    body: AvatarSyncCheckpoint,
  ) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      if (isSegmented(task)) conflict('分段口播需使用分段检查点');
      if (body.kind === 'LIP_SYNC_ACCEPTED') {
        if (!task.lipSyncStarted) conflict('口型任务尚未登记提交');
        if (task.lipSyncTaskId) {
          if (task.lipSyncTaskId !== body.providerTaskId) conflict('已绑定其他供应商任务');
          return { allowed: true };
        }
        const segmentReceipt = await tx.fissionAvatarSyncSegment.findUnique({
          where: { lipSyncTaskId: body.providerTaskId },
          select: { taskId: true },
        });
        if (segmentReceipt) conflict('该供应商任务已绑定其他口播任务');
        await tx.fissionAvatarSyncTask.update({
          where: { id: task.id },
          data: { lipSyncTaskId: body.providerTaskId },
        });
        return { allowed: true };
      }
      const speech = body.kind === 'TTS_SUBMIT';
      if ((!speech && !task.ttsStarted) || (speech ? task.ttsStarted : task.lipSyncStarted))
        return { allowed: false };
      if (!(await isAvatarSyncCurrent(tx, ids, snapshot(task)))) conflict('已确认输入或授权已变化');
      await tx.fissionAvatarSyncTask.update({
        where: { id: task.id },
        data: speech
          ? { ttsStarted: true, phase: 'TTS' }
          : { lipSyncStarted: true, phase: 'LIP_SYNC' },
      });
      return { allowed: true };
    });
  }

  private async segmentRow(
    tx: Prisma.TransactionClient,
    task: FissionAvatarSyncTask,
    ordinal: number,
  ) {
    if (!isSegmented(task)) unavailable('分段口播任务不存在');
    const segments = await segmentsForTask(tx, task);
    const segment = segments.find((row) => row.ordinal === ordinal);
    if (!segment) unavailable('口播分段不存在');
    return { segment, current: nextSegment(segments)?.ordinal === ordinal };
  }

  continuityCheckpoint(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    body: AvatarTailChainCheckpoint,
  ) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const source = snapshot(task);
      if (!isSegmented(task) || !source.tailChain) conflict('该任务未启用尾帧接续');
      if (body.kind === 'PICTURE_ACCEPTED') {
        const { segment, current } = await this.segmentRow(tx, task, body.ordinal);
        if (segment.pictureTaskId === body.providerTaskId) return { allowed: true };
        if (!current || !segment.pictureStarted || segment.pictureTaskId)
          conflict('画面回执与当前口播分段不一致');
        if (body.providerTaskId === source.tailChain.sourceTaskId)
          conflict('画面回执不能使用已登记的原始形象任务');
        const assigned = await tx.fissionAvatarSyncSegment.findUnique({
          where: { pictureTaskId: body.providerTaskId },
          select: { taskId: true },
        });
        if (assigned) conflict('该画面已绑定其他口播分段');
        // Preserve an already-accepted receipt if the source changed while the POST was in flight.
        await tx.fissionAvatarSyncSegment.update({
          where: { taskId_ordinal: { taskId, ordinal: body.ordinal } },
          data: { pictureTaskId: body.providerTaskId },
        });
        return { allowed: true };
      }
      if (!(await isAvatarSyncCurrent(tx, ids, source))) conflict('已确认输入或授权已变化');
      if (body.kind === 'TTS_STARTED') {
        if (task.ttsStarted) return { allowed: false };
        await tx.fissionAvatarSyncTask.update({
          where: { id: taskId },
          data: { ttsStarted: true, phase: 'TTS' },
        });
        return { allowed: true };
      }
      if (body.kind === 'PLAN_READY') {
        if (!task.ttsStarted) conflict('尚未登记整稿配音');
        if (
          task.continuityPlan &&
          workflowStateHash(task.continuityPlan) !== workflowStateHash(body.plan)
        )
          conflict('当前任务已冻结其他切分计划');
        const planned = task.continuityPlan
          ? task
          : await tx.fissionAvatarSyncTask.update({
              where: { id: taskId },
              data: { continuityPlan: json(body.plan) },
            });
        if (!task.continuityPlan) {
          await tx.fissionAvatarSyncSegment.createMany({
            data: body.plan.segments.map((_, index) => ({
              ...ids,
              taskId,
              ordinal: index + 1,
              scriptText: '',
              ttsOperationId: randomUUID(),
              lipSyncClientToken: randomUUID(),
            })),
          });
        }
        return {
          allowed: true,
          input: await tailChainWorkerInput(
            tx,
            ids,
            planned,
            await segmentsForTask(tx, planned),
            source,
          ),
        };
      }
      const { segment, current } = await this.segmentRow(tx, task, body.ordinal);
      if (!current || !task.continuityPlan) conflict('仅可提交当前待生成的画面分段');
      if (segment.pictureStarted) return { allowed: false };
      await tx.fissionAvatarSyncSegment.update({
        where: { taskId_ordinal: { taskId, ordinal: body.ordinal } },
        data: { pictureStarted: true },
      });
      return { allowed: true };
    });
  }

  segmentCheckpoint(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    ordinal: number,
    body: AvatarSyncCheckpoint,
  ) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const { segment, current } = await this.segmentRow(tx, task, ordinal);
      const where = { taskId_ordinal: { taskId, ordinal } };
      const source = snapshot(task);
      if (source.tailChain && (body.kind === 'TTS_SUBMIT' || !segment.pictureTaskId))
        conflict('尾帧接续分段须使用整稿配音和已受理画面');
      if (body.kind === 'LIP_SYNC_ACCEPTED' && segment.lipSyncTaskId) {
        if (segment.lipSyncTaskId !== body.providerTaskId) conflict('该分段已绑定其他供应商任务');
        return { allowed: true };
      }
      if (!current) conflict('仅可执行当前待完成分段');
      if (body.kind === 'LIP_SYNC_ACCEPTED') {
        if (!segment.lipSyncStarted) conflict('该分段尚未登记口型提交');
        const shortReceipt = await tx.fissionAvatarSyncTask.findFirst({
          where: { lipSyncTaskId: body.providerTaskId },
          select: { id: true },
        });
        if (shortReceipt) conflict('该供应商任务已绑定其他口播任务');
        await tx.fissionAvatarSyncSegment.update({
          where,
          data: { lipSyncTaskId: body.providerTaskId },
        });
        return { allowed: true };
      }
      const speech = body.kind === 'TTS_SUBMIT';
      if (
        speech
          ? segment.ttsStarted
          : (!source.tailChain && !segment.ttsStarted) || segment.lipSyncStarted
      )
        return { allowed: false };
      if (!(await isAvatarSyncCurrent(tx, ids, source))) conflict('已确认输入或授权已变化');
      await tx.fissionAvatarSyncSegment.update({
        where,
        data: speech ? { ttsStarted: true } : { lipSyncStarted: true },
      });
      return { allowed: true };
    });
  }

  segmentContent(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    ordinal: number,
    role: OutputRole,
  ) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const { segment } = await this.segmentRow(tx, task, ordinal);
      if (!(await isAvatarSyncCurrent(tx, ids, snapshot(task)))) conflict('已确认输入或授权已变化');
      const file = await segmentFile(tx, ids, segment, role);
      if (!file) unavailable('口播分段媒体不可用');
      return file;
    });
  }

  segmentAdmission(ids: AvatarSyncScope, taskId: string, token: string, ordinal: number) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const { segment, current } = await this.segmentRow(tx, task, ordinal);
      if (
        !segment.resultFingerprint &&
        (!current ||
          !segment.lipSyncTaskId ||
          !(await isAvatarSyncCurrent(tx, ids, snapshot(task))))
      )
        conflict('口播分段、来源或授权状态已变化');
      const project = await tx.project.findUniqueOrThrow({
        where: { id: ids.projectId },
        select: { name: true },
      });
      return {
        projectName: project.name,
        resultFingerprint: segment.resultFingerprint,
        segmented: false,
      };
    });
  }

  completeSegment(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    ordinal: number,
    media: AvatarSyncCompletion,
    files: Record<OutputRole, FileObjectInput>,
    fingerprint: string,
  ) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const { segment, current } = await this.segmentRow(tx, task, ordinal);
      if (segment.resultFingerprint) {
        if (segment.resultFingerprint !== fingerprint) conflict('该分段已存档其他口播素材');
        return false;
      }
      const source = snapshot(task);
      if (
        !current ||
        !segment.lipSyncTaskId ||
        (source.tailChain && !segment.pictureTaskId) ||
        !(await isAvatarSyncCurrent(tx, ids, source))
      )
        conflict('口播分段、来源或授权状态已变化');
      if (source.tailChain) validateTailChainSegment(task, ordinal, media);
      const audio = await this.working.upsertFileObjectInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        files.audio,
      );
      const video = await this.working.upsertFileObjectInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        files.video,
      );
      await tx.fissionAvatarSyncSegment.update({
        where: { taskId_ordinal: { taskId, ordinal } },
        data: {
          resultFingerprint: fingerprint,
          media: json(media),
          audioFileObjectId: audio.id,
          videoFileObjectId: video.id,
        },
      });
      return true;
    });
  }

  character(ids: AvatarSyncScope, taskId: string, token: string) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const frozen = snapshot(task);
      if (!(await isAvatarSyncCurrent(tx, ids, frozen))) conflict('冻结形象或授权已变化');
      return frozen.character;
    });
  }

  fail(ids: AvatarSyncScope, taskId: string, token: string, body: AvatarSyncFailure) {
    return this.withLease(ids, taskId, token, async (tx, task) => {
      const pendingSegment = isSegmented(task)
        ? unknownSegment(await segmentsForTask(tx, task))
        : undefined;
      const pending = !!pendingSegment || unknownCreation(task);
      const rejected = pending && body.code === 'PROVIDER_REJECTED';
      const unknown = pending && !rejected;
      if (rejected && pendingSegment)
        await tx.fissionAvatarSyncSegment.update({
          where: { taskId_ordinal: { taskId, ordinal: pendingSegment.ordinal } },
          data:
            pendingSegment.pictureStarted && !pendingSegment.pictureTaskId
              ? { pictureStarted: false }
              : { lipSyncStarted: false },
        });
      await this.finishFailed(
        tx,
        task,
        unknown ? UNKNOWN_CREATION : body.code,
        body.retryable && !unknown,
        !rejected && task.lipSyncStarted,
      );
      return { accepted: true };
    });
  }

  private verifyCompletion(task: FissionAvatarSyncTask, token: string) {
    if (task.status === 'SUCCEEDED' && !!token && task.attemptToken === token) return;
    ensureLease(task, token);
    if (!isSegmented(task) && !task.lipSyncTaskId) conflict('缺少已受理的口型任务');
  }

  resultAdmission(ids: AvatarSyncScope, taskId: string, token: string) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      this.verifyCompletion(task, token);
      if (!task.resultFingerprint && !(await isAvatarSyncCurrent(tx, ids, snapshot(task))))
        conflict('已确认输入或授权已变化，无法提交结果');
      if (
        !task.resultFingerprint &&
        isSegmented(task) &&
        ((snapshot(task).tailChain && !task.continuityPlan) ||
          nextSegment(await segmentsForTask(tx, task)))
      )
        conflict('分段尚未全部完成');
      const project = await tx.project.findUniqueOrThrow({
        where: { id: ids.projectId },
        select: { name: true },
      });
      return {
        projectName: project.name,
        resultFingerprint: task.resultFingerprint,
        segmented: isSegmented(task),
      };
    });
  }

  async complete(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    media: AvatarSyncMedia,
    files: Record<OutputRole, FileObjectInput>,
    fingerprint: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.task(tx, ids, taskId);
      this.verifyCompletion(task, token);
      if (task.status === 'SUCCEEDED') {
        if (task.resultFingerprint !== fingerprint) conflict('已提交其他口播结果');
        return false;
      }
      const frozen = snapshot(task);
      if (!runnable(run) || !(await isAvatarSyncCurrent(tx, ids, frozen)))
        conflict('已确认输入或授权已变化，无法提交结果');
      if (isSegmented(task)) {
        if (!isAvatarLongSyncMedia(media)) conflict('长片结果需提供接缝校验记录');
        validateSegmentedTimeline(await segmentsForTask(tx, task), media);
        if (frozen.tailChain) validateTailChainTimeline(task, media);
      } else if (isAvatarLongSyncMedia(media)) conflict('短片结果数据与任务不符');
      const previous = await this.result(tx, ids);
      const stored = await Promise.all(
        (['video', 'audio'] as const).map(async (role, sortOrder) => {
          const file = await this.working.upsertFileObjectInTransaction(
            tx,
            ids.projectId,
            ids.workflowRunId,
            files[role],
          );
          const { id, originalFileName, mimeType, sha256 } = file;
          return { fileObjectId: id, role, sortOrder, originalFileName, mimeType, sha256 };
        }),
      );
      const [committed] = await this.working.commitValidatedArtifactsInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        AVATAR_SYNC_NODE,
        [
          {
            artifactKey: AVATAR_SYNC_ARTIFACT_KEY,
            input: {
              kind: 'FILE',
              name: '数字人口播同步素材',
              directory: 'VIDEO_MATERIALS',
              type: 'VIDEO_MATERIAL',
              ...(previous ? { expectedRevision: previous.revision } : {}),
              payload: { origin: cleanOrigin(frozen), media } satisfies ResultPayload,
              files: stored,
              dependencies: (['binding', 'script'] as const).map((key) => ({
                sourceType: 'WORKING_ARTIFACT',
                sourceNodeId: FISSION_AVATAR_NODES[key],
                sourceArtifactId: frozen[key].artifactId,
                sourceKey: FISSION_AVATAR_ARTIFACT_KEYS[key],
                sourceRevision: frozen[key].revision,
                sourceHash: frozen[key].contentHash,
              })),
            },
          },
        ],
      );
      const referenced =
        committed?.record.files.some((file) =>
          stored.some(({ fileObjectId }) => fileObjectId === file.fileObjectId),
        ) ?? false;
      if (!referenced) {
        await tx.fileObject.deleteMany({
          where: { ...ids, id: { in: stored.map(({ fileObjectId }) => fileObjectId) } },
        });
      }
      await tx.fissionAvatarSyncTask.update({
        where: { id: task.id },
        data: {
          status: 'SUCCEEDED',
          phase: 'COMPLETE',
          progress: 100,
          leaseExpiresAt: null,
          resultFingerprint: fingerprint,
        },
      });
      if (isSegmented(task)) await clearSegmentMedia(tx, ids, task);
      return referenced;
    });
  }

  output(ids: AvatarSyncScope, artifactId: string, role: OutputRole, revision?: number) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const artifact = await this.result(tx, ids);
      if (
        !artifact ||
        artifact.id !== artifactId ||
        artifact.availability !== 'AVAILABLE' ||
        (revision !== undefined && artifact.revision !== revision)
      )
        unavailable('口播结果不可用');
      const { origin } = artifact.payload as unknown as ResultPayload;
      if (!(await avatarSyncGrantsValid(tx, ids.projectId, origin))) unavailable('口播结果不可用');
      const file = artifact.files.find((item) => item.role === role);
      if (
        !file ||
        file.fileObject.status !== 'AVAILABLE' ||
        file.fileObject.workflowRunId !== ids.workflowRunId
      )
        unavailable('口播媒体不可用');
      return file.fileObject;
    });
  }
}
