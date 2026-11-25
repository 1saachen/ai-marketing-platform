import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AVATAR_COMPOSITION_ARTIFACT_KEY,
  AVATAR_COMPOSITION_NODE,
  AVATAR_LONG_RENDER_QUEUE,
  AVATAR_OUTPUT_ARTIFACT_KEY,
  AVATAR_OUTPUT_NODE,
  AVATAR_RENDER_PHASES,
  AVATAR_RENDER_QUEUE,
  avatarRenderReviewPasses,
  isAvatarLongRenderCompletion,
  isAvatarLongSyncMedia,
  isAvatarNativeRenderCompletion,
  parseAvatarCompositionSettings,
  type AvatarArtifactRef,
  type AvatarCompositionDraft,
  type AvatarCompositionDraftRequest,
  type AvatarRenderArchiveReceipt,
  type AvatarRenderClaim,
  type AvatarRenderCompletion,
  type AvatarRenderCreateRequest,
  type AvatarRenderFailure,
  type AvatarRenderHeartbeat,
  type AvatarRenderReview,
  type AvatarRenderTask,
  type AvatarRenderWorkspace,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { PrismaService } from '../../../database/prisma.service';
import {
  Prisma,
  type FileObject,
  type FissionAvatarRenderTask,
  type WorkflowRun,
} from '../../../generated/prisma/client';
import { AssetRepository } from '../../../platform/asset/asset.repository';
import {
  avatarBackgroundVersionWhere,
  avatarRenderArchiveKey,
  avatarRenderRevision,
  findAvatarBackground,
} from '../../../platform/workflow/fission-avatar-delivery';
import {
  AVATAR_RENDER_ACTIVE_STATUSES,
  lockAvatarRun,
} from '../../../platform/workflow/fission-avatar-scope';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  artifactDependency,
  artifactRef,
  captionDuration,
  compositionSources,
  matchesAvatarNativeRenderProof,
  outputAuthorized,
  publicOrigin,
  publicRef,
  renderArtifact,
  renderSource,
  suggestedCaptions,
  type CompositionPayload,
  type OutputPayload,
  type RenderSnapshot,
} from './avatar-render-source';
import { sameAvatarArtifactRef, type AvatarSyncScope } from './avatar-sync-source';

const LEASE_MS = 90_000;
const REVIEW_SOURCE_RECHECK_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const JOB_TYPE = 'FISSION_AVATAR_RENDER';
const runningStatuses = ['QUEUED', 'RUNNING'];
const messages: Record<string, string> = {
  MEDIA_INVALID: '成片未通过音视频或字幕校验',
  NATIVE_TIMELINE_INVALID: '成片未能保留原片音轨和音画时间关系',
  RENDER_FAILED: '成片渲染失败，可按任务状态重试',
  INTERNAL_API_FAILED: '成片保存暂未完成',
  INVALID_TASK: '渲染输入无效',
  SOURCE_STALE: '确认方案、口播素材或授权已变化，请确认后重新渲染',
  REVIEW_FAILED: '成片未通过口型同步验收，请复核后重新生成口播素材',
  LEASE_EXPIRED: '渲染任务执行超时',
};

export type RenderFileRole = 'video' | 'subtitles';
export type RenderInputRole = 'video' | 'audio' | 'background';
type Candidate = { media: AvatarRenderCompletion; video: string; subtitles: string | null };
type ReviewRecord = { measurement: AvatarRenderReview; passed: boolean; reviewedAt: string };
type Publication = { review: ReviewRecord } | { resultFingerprint: string };

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function unavailable(message: string): never {
  throw new ApiHttpException(message, 404, 'ASSET_NOT_FOUND');
}

function conflict(message: string): never {
  throw new ApiHttpException(message, 409, 'CONFLICT');
}

function runnable(run: WorkflowRun) {
  return (run.status === 'ACTIVE' || run.status === 'PAUSED') && run.activeKey === 'ACTIVE';
}

function snapshot(task: FissionAvatarRenderTask) {
  return task.inputSnapshot as unknown as RenderSnapshot;
}

function activeLease(task: FissionAvatarRenderTask, token: string) {
  return (
    !!token &&
    task.status === 'RUNNING' &&
    task.attemptToken === token &&
    !!task.leaseExpiresAt &&
    task.leaseExpiresAt > new Date()
  );
}

function replayableResult(task: FissionAvatarRenderTask, token: string) {
  return (
    !!token &&
    task.attemptToken === token &&
    !!task.resultFingerprint &&
    ['AWAITING_REVIEW', 'SUCCEEDED'].includes(task.status)
  );
}

function matchingFrozen(frozen: RenderSnapshot, current: RenderSnapshot | null) {
  if (!current) return false;
  const { nativeSourceAccepted, ...source } = frozen;
  return (
    (!nativeSourceAccepted ||
      (current.origin.mode === 'NATIVE' &&
        sameAvatarArtifactRef(nativeSourceAccepted, current.sync))) &&
    workflowStateHash(source) === workflowStateHash(current)
  );
}

function sameNativeAcceptance(left?: AvatarArtifactRef, right?: AvatarArtifactRef) {
  return right ? sameAvatarArtifactRef(left ?? null, right) : left === undefined;
}

function publicTask(
  task: FissionAvatarRenderTask,
  stale: boolean,
  enabled: boolean,
  held: boolean,
): AvatarRenderTask {
  const status = task.status as AvatarRenderTask['status'];
  const phase = task.phase as AvatarRenderTask['phase'];
  const messageByStatus = {
    QUEUED: '成片渲染排队中',
    RUNNING: phase === 'VALIDATING' ? '正在校验成片媒体' : '正在合成背景和字幕',
    AWAITING_REVIEW: '成片已渲染，等待口型同步验收',
    SUCCEEDED: '成片已通过验收',
    FAILED: messages[task.errorCode ?? ''] ?? '成片渲染失败',
    CANCELLED: '成片渲染已取消',
  };
  return {
    id: task.id,
    status,
    phase,
    progress: task.progress,
    message: messageByStatus[status],
    stale,
    canCancel: AVATAR_RENDER_ACTIVE_STATUSES.includes(status),
    canRetry:
      enabled &&
      !held &&
      !stale &&
      status === 'FAILED' &&
      task.retryable &&
      task.attemptCount < MAX_ATTEMPTS,
  };
}

@Injectable()
export class AvatarRenderRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(AssetRepository) private readonly assets: AssetRepository,
  ) {}

  private draft(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
    return tx.workflowNodeState.findUnique({
      where: { projectId_workflowRunId_nodeId: { ...ids, nodeId: AVATAR_COMPOSITION_NODE } },
    });
  }

  private active(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
    return tx.fissionAvatarRenderTask.findFirst({
      where: { ...ids, status: { in: AVATAR_RENDER_ACTIVE_STATUSES } },
    });
  }

  private async loadTask(tx: Prisma.TransactionClient, ids: AvatarSyncScope, id: string) {
    const task = await tx.fissionAvatarRenderTask.findFirst({ where: { ...ids, id } });
    if (!task) unavailable('成片渲染任务不存在');
    return task;
  }

  private async current(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
    const [composition, source] = await Promise.all([
      renderArtifact(tx, ids, 'composition'),
      renderSource(tx, ids),
    ]);
    return composition ? compositionSources(tx, ids, composition, source) : null;
  }

  private archiveReceipt(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    output: AvatarArtifactRef,
  ) {
    return tx.assetOperationReceipt.findUnique({
      where: {
        projectId_operationKey: {
          projectId: ids.projectId,
          operationKey: avatarRenderArchiveKey(
            ids.workflowRunId,
            output.artifactId,
            output.revision,
          ),
        },
      },
      select: { assetId: true, version: true },
    });
  }

  private async read(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    run: WorkflowRun,
    enabled: boolean,
    longEnabled = false,
  ): Promise<AvatarRenderWorkspace> {
    const [draft, composition, source, output, backgrounds] = await Promise.all([
      this.draft(tx, ids),
      renderArtifact(tx, ids, 'composition'),
      renderSource(tx, ids),
      renderArtifact(tx, ids, 'output'),
      tx.assetVersion.findMany({
        where: avatarBackgroundVersionWhere(ids.projectId),
        include: { asset: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 200,
      }),
    ]);
    const [available] = await tx.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('fission_avatar_render_tasks') IS NOT NULL AS "present"`;
    const active = available?.present ? await this.active(tx, ids) : null;
    const task =
      active ??
      (available?.present
        ? await tx.fissionAvatarRenderTask.findFirst({
            where: ids,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          })
        : null);
    const frozen = composition ? await compositionSources(tx, ids, composition, source) : null;
    const payload = composition?.payload as unknown as CompositionPayload | null;
    const taskStale = task ? !matchingFrozen(snapshot(task), frozen) : false;
    const outputPayload = output?.payload as unknown as OutputPayload | null;
    const outputGranted =
      !!outputPayload && (await outputAuthorized(tx, ids.projectId, outputPayload));
    const blockedReason = !enabled
      ? '成片渲染暂未启用'
      : !runnable(run) || run.status !== 'ACTIVE'
        ? '请先恢复当前工作区'
        : !source
          ? '请先生成当前口播素材'
          : !frozen
            ? '请先确认当前背景与字幕方案'
            : isAvatarLongSyncMedia(source.media) && !longEnabled
              ? '长片成片渲染暂未启用'
              : active && !taskStale
                ? '已有成片任务正在处理'
                : null;
    const base = `/api/projects/${ids.projectId}/workflow-runs/${ids.workflowRunId}/fission-avatar/render`;
    const url = (role: RenderFileRole) =>
      outputGranted &&
      output?.files.some((file) => file.role === role && file.fileObject.status === 'AVAILABLE')
        ? `${base}/outputs/${output.revision}/${role}`
        : null;
    return {
      ...ids,
      enabled,
      canRender: blockedReason === null,
      blockedReason,
      draft: draft
        ? {
            revision: draft.revision,
            ...(draft.state as unknown as Omit<AvatarCompositionDraft, 'revision'>),
          }
        : null,
      composition:
        composition && payload
          ? {
              ...publicRef(artifactRef(composition)),
              sync: payload.sync,
              settings: payload.settings,
              stale: !frozen,
            }
          : null,
      source: source
        ? {
            ...publicRef(source.sync),
            durationMs: captionDuration(source),
            captions: suggestedCaptions(source),
            ...(source.origin.mode === 'NATIVE' ? { mode: 'NATIVE' as const } : {}),
            ...(isAvatarLongSyncMedia(source.media)
              ? { seamTimesMs: source.media.seamTimesMs }
              : {}),
          }
        : null,
      backgrounds: backgrounds.map(({ asset, assetId, version }) => ({
        assetId,
        version,
        name: asset.name,
        previewUrl: `/api/projects/${ids.projectId}/assets/${assetId}/versions/${version}/content`,
      })),
      task: task
        ? publicTask(
            task,
            taskStale,
            enabled && (longEnabled || !isAvatarLongSyncMedia(snapshot(task).media)),
            !!active,
          )
        : null,
      output:
        output && outputPayload
          ? {
              ...publicRef(artifactRef(output)),
              durationMs: outputPayload.durationMs,
              stale:
                !outputGranted ||
                !frozen ||
                !sameAvatarArtifactRef(frozen.composition, outputPayload.composition) ||
                !sameAvatarArtifactRef(frozen.sync, outputPayload.sync),
              videoUrl: url('video'),
              subtitlesUrl: url('subtitles'),
              archive: outputGranted
                ? await this.archiveReceipt(tx, ids, publicRef(artifactRef(output)))
                : null,
            }
          : null,
    };
  }

  workspace(ids: AvatarSyncScope, enabled: boolean, longEnabled = false) {
    return this.db.$transaction(async (tx) =>
      this.read(tx, ids, await lockAvatarRun(tx, ids), enabled, longEnabled),
    );
  }

  private validateSettings(
    request: Pick<AvatarCompositionDraft, 'sync' | 'settings'>,
    source: Awaited<ReturnType<typeof renderSource>>,
    confirming: boolean,
  ) {
    if (!source || !sameAvatarArtifactRef(source.sync, request.sync))
      conflict('口播素材已变化，请按新时间轴复核字幕');
    try {
      parseAvatarCompositionSettings(request.settings, isAvatarLongSyncMedia(source.media));
    } catch {
      throw new ApiHttpException('背景或字幕超出当前成片规格', 422, 'VALIDATION_ERROR');
    }
    const { captions, captionMode } = request.settings;
    if (
      (confirming && captionMode !== 'OFF' && !captions.length) ||
      captions.some((cue) => cue.endMs > captionDuration(source))
    )
      throw new ApiHttpException('请填写有效的字幕并确认时间在口播范围内', 422, 'VALIDATION_ERROR');
    return source;
  }

  private async selectedBackground(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    settings: CompositionPayload['settings'],
  ) {
    const background = settings.background;
    if (background.kind === 'SOLID') return null;
    const image = await findAvatarBackground(tx, ids.projectId, background);
    if (!image) throw new ApiHttpException('当前项目背景图片版本不可用', 422, 'VALIDATION_ERROR');
    return image.id;
  }

  saveDraft(
    ids: AvatarSyncScope,
    request: AvatarCompositionDraftRequest,
    enabled: boolean,
    longEnabled = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids, true);
      const draft = await this.draft(tx, ids);
      if ((draft?.revision ?? 0) !== request.expectedRevision)
        conflict('背景与字幕草稿已变化，请刷新后再保存');
      const { sync, settings } = request;
      this.validateSettings(request, await renderSource(tx, ids), false);
      await this.selectedBackground(tx, ids, settings);
      const state = { sync, settings };
      const contentHash = workflowStateHash(state);
      if (draft?.contentHash !== contentHash)
        await tx.workflowNodeState.upsert({
          where: { projectId_workflowRunId_nodeId: { ...ids, nodeId: AVATAR_COMPOSITION_NODE } },
          create: { ...ids, nodeId: AVATAR_COMPOSITION_NODE, state: json(state), contentHash },
          update: {
            state: json(state),
            contentHash,
            revision: { increment: 1 },
            savedAt: new Date(),
          },
        });
      return this.read(tx, ids, run, enabled, longEnabled);
    });
  }

  confirm(ids: AvatarSyncScope, expectedRevision: number, enabled: boolean, longEnabled = false) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids, true);
      const draft = await this.draft(tx, ids);
      if (!draft || draft.revision !== expectedRevision)
        conflict('背景与字幕草稿已变化，请刷新后再确认');
      const state = draft.state as unknown as Omit<AvatarCompositionDraft, 'revision'>;
      const source = this.validateSettings(state, await renderSource(tx, ids), true);
      const backgroundVersionId = await this.selectedBackground(tx, ids, state.settings);
      const previous = await renderArtifact(tx, ids, 'composition');
      const [committed] = await this.working.commitValidatedArtifactsInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        AVATAR_COMPOSITION_NODE,
        [
          {
            artifactKey: AVATAR_COMPOSITION_ARTIFACT_KEY,
            input: {
              kind: 'STRUCTURED',
              name: '数字人口播背景与字幕方案',
              directory: 'EDITING_PROJECTS',
              type: 'EDITING_PROJECT',
              ...(previous ? { expectedRevision: previous.revision } : {}),
              payload: { ...state, backgroundVersionId } satisfies CompositionPayload,
              dependencies: [artifactDependency('sync', source.sync)],
            },
          },
        ],
      );
      if (committed && !committed.unchanged) {
        const active = await this.active(tx, ids);
        if (
          active &&
          !sameAvatarArtifactRef(snapshot(active).composition, artifactRef(committed.record))
        )
          await this.finish(tx, active, 'FAILED', 'SOURCE_STALE');
      }
      return this.read(tx, ids, run, enabled, longEnabled);
    });
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    id: string,
    frozen: RenderSnapshot,
  ) {
    const key = { projectId: ids.projectId, jobType: JOB_TYPE, aggregateId: id };
    await tx.jobOutbox.upsert({
      where: { projectId_jobType_aggregateId: key },
      create: {
        ...key,
        routingKey: isAvatarLongSyncMedia(frozen.media)
          ? AVATAR_LONG_RENDER_QUEUE
          : AVATAR_RENDER_QUEUE,
        payload: {
          schemaVersion: 1,
          projectId: ids.projectId,
          runId: ids.workflowRunId,
          requestId: id,
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

  create(
    ids: AvatarSyncScope,
    request: AvatarRenderCreateRequest,
    enabled: boolean,
    longEnabled = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids, true);
      const existing = await tx.fissionAvatarRenderTask.findUnique({
        where: {
          projectId_workflowRunId_idempotencyKey: {
            ...ids,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (existing) {
        const frozen = snapshot(existing);
        if (
          !sameAvatarArtifactRef(frozen.composition, request.composition) ||
          !sameNativeAcceptance(frozen.nativeSourceAccepted, request.nativeSourceAccepted)
        )
          conflict('渲染操作已用于其他方案版本或原片确认');
        return this.read(tx, ids, run, enabled, longEnabled);
      }
      const input = await this.current(tx, ids);
      if (!input || !sameAvatarArtifactRef(input.composition, request.composition))
        conflict('请先确认当前背景与字幕方案');
      if (isAvatarLongSyncMedia(input.media) && !longEnabled) conflict('长片成片渲染暂未启用');
      if (input.origin.mode === 'NATIVE') {
        if (
          !request.nativeSourceAccepted ||
          !sameAvatarArtifactRef(input.sync, request.nativeSourceAccepted)
        )
          conflict('请先确认当前版本的生成原片');
        if (!input.video.sha256) conflict('生成原片缺少媒体校验摘要');
      } else if (request.nativeSourceAccepted) {
        conflict('当前口播素材不支持原生原片确认');
      }
      const active = await this.active(tx, ids);
      if (active) {
        const frozen = snapshot(active);
        if (matchingFrozen(frozen, input)) {
          if (!sameNativeAcceptance(frozen.nativeSourceAccepted, request.nativeSourceAccepted))
            conflict('请先结束当前成片任务，再确认原片并重新渲染');
          return this.read(tx, ids, run, enabled, longEnabled);
        }
        await this.finish(tx, active, 'FAILED', 'SOURCE_STALE');
      }
      const frozen: RenderSnapshot = request.nativeSourceAccepted
        ? { ...input, nativeSourceAccepted: publicRef(input.sync) }
        : input;
      const task = await tx.fissionAvatarRenderTask.create({
        data: { ...ids, idempotencyKey: request.idempotencyKey, inputSnapshot: json(frozen) },
      });
      await this.enqueue(tx, ids, task.id, frozen);
      return this.read(tx, ids, run, enabled, longEnabled);
    });
  }

  action(
    ids: AvatarSyncScope,
    id: string,
    action: 'cancel' | 'retry',
    enabled: boolean,
    longEnabled = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids, action === 'retry');
      const task = await this.loadTask(tx, ids, id);
      if (action === 'cancel') {
        if (AVATAR_RENDER_ACTIVE_STATUSES.includes(task.status))
          await this.finish(tx, task, 'CANCELLED', null);
        else if (task.status !== 'CANCELLED') conflict('当前渲染任务无法取消');
      } else if (runningStatuses.includes(task.status)) {
        return this.read(tx, ids, run, enabled, longEnabled);
      } else {
        if (task.status !== 'FAILED' || !task.retryable || task.attemptCount >= MAX_ATTEMPTS)
          conflict('当前渲染任务无法重试');
        const frozen = snapshot(task);
        if (isAvatarLongSyncMedia(frozen.media) && !longEnabled) conflict('长片成片渲染暂未启用');
        if (await this.active(tx, ids)) conflict('已有成片任务正在处理');
        if (!matchingFrozen(frozen, await this.current(tx, ids)))
          conflict('确认方案、口播素材或授权已变化');
        await tx.fissionAvatarRenderTask.update({
          where: { id },
          data: {
            status: 'QUEUED',
            phase: 'QUEUED',
            progress: 0,
            errorCode: null,
            retryable: false,
          },
        });
        await this.enqueue(tx, ids, id, frozen);
      }
      return this.read(tx, ids, run, enabled, longEnabled);
    });
  }

  private async finish(
    tx: Prisma.TransactionClient,
    task: FissionAvatarRenderTask,
    status: 'FAILED' | 'CANCELLED',
    code: string | null,
    retryable = false,
    review?: ReviewRecord,
  ) {
    const files = task.candidate as unknown as Candidate | null;
    if (files) await this.dropCandidate(tx, task, files);
    await tx.fissionAvatarRenderTask.update({
      where: { id: task.id },
      data: {
        status,
        errorCode: code,
        retryable: retryable && task.attemptCount < MAX_ATTEMPTS,
        attemptToken: null,
        leaseExpiresAt: null,
        candidate: Prisma.DbNull,
        ...(review ? { review: json(review) } : {}),
      },
    });
  }

  private async dropCandidate(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    candidate: Candidate,
  ) {
    const keys = [candidate.video, ...(candidate.subtitles ? [candidate.subtitles] : [])];
    const files = await tx.fileObject.findMany({
      where: {
        projectId: ids.projectId,
        workflowRunId: ids.workflowRunId,
        nodeId: AVATAR_OUTPUT_NODE,
        id: { in: keys },
      },
    });
    await tx.fileObject.deleteMany({
      where: {
        projectId: ids.projectId,
        workflowRunId: ids.workflowRunId,
        nodeId: AVATAR_OUTPUT_NODE,
        id: { in: keys },
      },
    });
    await tx.storageCleanupTask.createMany({
      data: files.map(({ storageKey }) => ({
        projectId: ids.projectId,
        storageKey,
        reason: 'AVATAR_RENDER_UNPUBLISHED_MEDIA',
      })),
      skipDuplicates: true,
    });
  }

  claim(ids: AvatarSyncScope, id: string): Promise<AvatarRenderClaim> {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      if (!runningStatuses.includes(task.status)) return { status: 'INACTIVE' };
      if (task.status === 'RUNNING' && task.leaseExpiresAt && task.leaseExpiresAt > new Date())
        return { status: 'BUSY' };
      if (task.attemptCount >= MAX_ATTEMPTS) {
        await this.finish(tx, task, 'FAILED', 'LEASE_EXPIRED');
        return { status: 'INACTIVE' };
      }
      const frozen = snapshot(task);
      if (!runnable(run) || !matchingFrozen(frozen, await this.current(tx, ids))) {
        await this.finish(tx, task, 'FAILED', 'SOURCE_STALE');
        return { status: 'INACTIVE' };
      }
      const sourceVideoSha256 = frozen.nativeSourceAccepted ? frozen.video.sha256 : null;
      if (frozen.nativeSourceAccepted && !sourceVideoSha256) {
        await this.finish(tx, task, 'FAILED', 'NATIVE_TIMELINE_INVALID');
        return { status: 'INACTIVE' };
      }
      const attemptToken = randomUUID();
      await tx.fissionAvatarRenderTask.update({
        where: { id },
        data: {
          status: 'RUNNING',
          phase: task.phase === 'QUEUED' ? 'ENCODING' : task.phase,
          progress: Math.max(task.progress, 5),
          attemptCount: { increment: 1 },
          attemptToken,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        },
      });
      return {
        status: 'CLAIMED',
        attemptToken,
        input: {
          ...(sourceVideoSha256
            ? { schemaVersion: 3 as const, sourceVideoSha256 }
            : isAvatarLongSyncMedia(frozen.media)
              ? { schemaVersion: 2 as const, seamTimesMs: frozen.media.seamTimesMs }
              : { schemaVersion: 1 as const }),
          settings: frozen.settings,
          videoSizeBytes: frozen.video.sizeBytes,
          audioSizeBytes: frozen.audio.sizeBytes,
          backgroundSizeBytes: frozen.background?.sizeBytes ?? null,
          audioDurationMs: frozen.media.audioDurationMs,
          videoDurationMs: frozen.media.videoDurationMs,
        },
      };
    });
  }

  async recoverExpired() {
    const [available] = await this.db.$queryRaw<
      { present: boolean }[]
    >`SELECT to_regclass('fission_avatar_render_tasks') IS NOT NULL AS "present"`;
    if (!available?.present) return;
    const expired = await this.db.fissionAvatarRenderTask.findMany({
      where: {
        status: { in: ['RUNNING', 'AWAITING_REVIEW'] },
        leaseExpiresAt: { lte: new Date() },
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
        const task = await tx.fissionAvatarRenderTask.findFirst({ where: { ...ids, id } });
        if (
          !task ||
          !['RUNNING', 'AWAITING_REVIEW'].includes(task.status) ||
          !task.leaseExpiresAt ||
          task.leaseExpiresAt > new Date()
        )
          return;
        if (!runnable(run) || !matchingFrozen(snapshot(task), await this.current(tx, ids)))
          return this.finish(tx, task, 'FAILED', 'SOURCE_STALE');
        if (task.status === 'AWAITING_REVIEW') {
          // A healthy candidate stays pending. Recheck its source on a bounded cadence.
          await tx.fissionAvatarRenderTask.update({
            where: { id },
            data: { leaseExpiresAt: new Date(Date.now() + REVIEW_SOURCE_RECHECK_MS) },
          });
          return;
        }
        if (task.attemptCount >= MAX_ATTEMPTS)
          return this.finish(tx, task, 'FAILED', 'LEASE_EXPIRED');
        await tx.fissionAvatarRenderTask.update({
          where: { id },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null },
        });
        await this.enqueue(tx, ids, id, snapshot(task));
      });
    }
  }

  heartbeat(ids: AvatarSyncScope, id: string, token: string, body: AvatarRenderHeartbeat) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      if (!runnable(run) || !activeLease(task, token)) return { active: false };
      if (!matchingFrozen(snapshot(task), await this.current(tx, ids))) {
        await this.finish(tx, task, 'FAILED', 'SOURCE_STALE');
        return { active: false };
      }
      const phase =
        AVATAR_RENDER_PHASES.indexOf(body.phase) >
        AVATAR_RENDER_PHASES.indexOf(task.phase as AvatarRenderTask['phase'])
          ? body.phase
          : task.phase;
      await tx.fissionAvatarRenderTask.update({
        where: { id },
        data: {
          phase,
          progress: Math.max(task.progress, body.progress),
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        },
      });
      return { active: true };
    });
  }

  source(ids: AvatarSyncScope, id: string, token: string, role: RenderInputRole) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      const frozen = snapshot(task);
      if (
        !runnable(run) ||
        !activeLease(task, token) ||
        !matchingFrozen(frozen, await this.current(tx, ids))
      )
        conflict('渲染租约、输入或授权已变化');
      const file = frozen[role];
      if (!file) unavailable('渲染输入文件不存在');
      return file;
    });
  }

  fail(ids: AvatarSyncScope, id: string, token: string, body: AvatarRenderFailure) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      if (!activeLease(task, token)) conflict('渲染任务租约已失效');
      await this.finish(tx, task, 'FAILED', body.code, body.retryable);
      return { accepted: true };
    });
  }

  resultAdmission(ids: AvatarSyncScope, id: string, token: string) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      const frozen = snapshot(task);
      if (
        !replayableResult(task, token) &&
        (!runnable(run) ||
          !activeLease(task, token) ||
          !matchingFrozen(frozen, await this.current(tx, ids)))
      )
        conflict('渲染租约、输入或授权已变化');
      const { name } = await tx.project.findUniqueOrThrow({
        where: { id: ids.projectId },
        select: { name: true },
      });
      return { projectName: name, frozen, fingerprint: task.resultFingerprint };
    });
  }

  complete(
    ids: AvatarSyncScope,
    id: string,
    token: string,
    media: AvatarRenderCompletion,
    staged: { video: FileObjectInput; subtitles?: FileObjectInput },
    fingerprint: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      if (replayableResult(task, token)) {
        if (task.resultFingerprint !== fingerprint) conflict('已提交其他渲染候选文件');
        return false;
      }
      const frozen = snapshot(task);
      if (
        !runnable(run) ||
        !activeLease(task, token) ||
        !matchingFrozen(frozen, await this.current(tx, ids))
      )
        conflict('渲染租约、输入或授权已变化');
      if (!matchesAvatarNativeRenderProof(frozen, media, staged.video.sha256))
        conflict('原片或成片摘要与音画校验记录不一致');
      const video = await this.working.upsertFileObjectInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        staged.video,
      );
      const subtitles = staged.subtitles
        ? await this.working.upsertFileObjectInTransaction(
            tx,
            ids.projectId,
            ids.workflowRunId,
            staged.subtitles,
          )
        : null;
      const candidate = {
        media,
        video: video.id,
        subtitles: subtitles?.id ?? null,
      } satisfies Candidate;
      if (isAvatarNativeRenderCompletion(media)) {
        await this.publish(tx, task, frozen, candidate, video, subtitles, {
          resultFingerprint: fingerprint,
        });
        return true;
      }
      await tx.fissionAvatarRenderTask.update({
        where: { id },
        data: {
          status: 'AWAITING_REVIEW',
          phase: 'REVIEW',
          progress: Math.max(task.progress, 95),
          leaseExpiresAt: new Date(Date.now() + REVIEW_SOURCE_RECHECK_MS),
          candidate: json(candidate),
          resultFingerprint: fingerprint,
        },
      });
      return true;
    });
  }

  private async reviewFiles(
    tx: Prisma.TransactionClient,
    ids: AvatarSyncScope,
    task: FissionAvatarRenderTask,
  ) {
    const candidate = task.candidate as unknown as Candidate | null;
    if (!candidate || task.status !== 'AWAITING_REVIEW') unavailable('待验收成片不存在');
    const file = (id: string) =>
      tx.fileObject.findFirst({
        where: { ...ids, id, nodeId: AVATAR_OUTPUT_NODE, status: 'AVAILABLE' },
      });
    const [video, subtitles] = await Promise.all([
      file(candidate.video),
      candidate.subtitles ? file(candidate.subtitles) : null,
    ]);
    if (!video || (candidate.subtitles && !subtitles)) unavailable('待验收媒体不可用');
    return { candidate, video, subtitles };
  }

  candidate(ids: AvatarSyncScope, id: string) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      if (!matchingFrozen(snapshot(task), await this.current(tx, ids)))
        unavailable('待验收成片的来源或授权已变化');
      return (await this.reviewFiles(tx, ids, task)).video;
    });
  }

  candidateTimeline(ids: AvatarSyncScope, id: string) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      if (!matchingFrozen(snapshot(task), await this.current(tx, ids)))
        unavailable('待验收成片的来源或授权已变化');
      const { candidate, video } = await this.reviewFiles(tx, ids, task);
      if (!isAvatarLongRenderCompletion(candidate.media)) unavailable('候选成片没有长片接缝信息');
      return {
        schemaVersion: 2 as const,
        candidateSha256: video.sha256,
        durationMs: candidate.media.videoDurationMs,
        seamTimesMs: candidate.media.seamTimesMs,
      };
    });
  }

  review(ids: AvatarSyncScope, id: string, measurement: AvatarRenderReview) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      const task = await this.loadTask(tx, ids, id);
      const recorded = task.review as unknown as ReviewRecord | null;
      if (recorded) {
        if (workflowStateHash(recorded.measurement) !== workflowStateHash(measurement))
          conflict('该候选文件已有不同验收记录');
        return { accepted: true, passed: recorded.passed };
      }
      const { candidate, video, subtitles } = await this.reviewFiles(tx, ids, task);
      if (video.sha256 !== measurement.sha256) conflict('验收摘要与待验收成片不一致');
      if (isAvatarLongRenderCompletion(candidate.media)) {
        const evidence = measurement.evidence;
        if (
          !evidence ||
          evidence.durationMs !== candidate.media.videoDurationMs ||
          workflowStateHash(evidence.seamTimesMs) !== workflowStateHash(candidate.media.seamTimesMs)
        )
          conflict('请提供与当前长片时长及全部接缝匹配的验收记录');
      } else if (measurement.evidence) {
        conflict('当前成片使用短片验收记录');
      }
      const frozen = snapshot(task);
      const current = runnable(run) && matchingFrozen(frozen, await this.current(tx, ids));
      const review = {
        measurement,
        passed: current && avatarRenderReviewPasses(measurement),
        reviewedAt: new Date().toISOString(),
      };
      if (!review.passed) {
        await this.finish(
          tx,
          task,
          'FAILED',
          current ? 'REVIEW_FAILED' : 'SOURCE_STALE',
          false,
          review,
        );
        return { accepted: true, passed: false };
      }
      await this.publish(tx, task, frozen, candidate, video, subtitles, { review });
      return { accepted: true, passed: true };
    });
  }

  private async publish(
    tx: Prisma.TransactionClient,
    task: FissionAvatarRenderTask,
    frozen: RenderSnapshot,
    candidate: Candidate,
    video: FileObject,
    subtitles: FileObject | null,
    publication: Publication,
  ) {
    const ids = { projectId: task.projectId, workflowRunId: task.workflowRunId };
    const previous = await renderArtifact(tx, ids, 'output');
    const files = [video, ...(subtitles ? [subtitles] : [])].map((file, sortOrder) => ({
      fileObjectId: file.id,
      role: sortOrder === 0 ? 'video' : 'subtitles',
      sortOrder,
      originalFileName: file.originalFileName,
      mimeType: file.mimeType,
      sha256: file.sha256,
    }));
    const [committed] = await this.working.commitValidatedArtifactsInTransaction(
      tx,
      ids.projectId,
      ids.workflowRunId,
      AVATAR_OUTPUT_NODE,
      [
        {
          artifactKey: AVATAR_OUTPUT_ARTIFACT_KEY,
          input: {
            kind: 'FILE',
            name: '数字人口播成片',
            directory: 'FINAL_VIDEOS',
            type: 'FINAL_VIDEO',
            ...(previous ? { expectedRevision: previous.revision } : {}),
            payload: {
              origin: publicOrigin(frozen),
              composition: frozen.composition,
              sync: frozen.sync,
              durationMs: candidate.media.videoDurationMs,
              ...(frozen.nativeSourceAccepted && isAvatarNativeRenderCompletion(candidate.media)
                ? {
                    nativeValidation: {
                      acceptedSource: frozen.nativeSourceAccepted,
                      timeline: candidate.media,
                    },
                  }
                : {}),
            } satisfies OutputPayload,
            files,
            dependencies: [
              artifactDependency('composition', frozen.composition),
              artifactDependency('sync', frozen.sync),
            ],
          },
        },
      ],
    );
    if (committed?.unchanged) await this.dropCandidate(tx, ids, candidate);
    await tx.fissionAvatarRenderTask.update({
      where: { id: task.id },
      data: {
        status: 'SUCCEEDED',
        phase: 'COMPLETE',
        progress: 100,
        candidate: Prisma.DbNull,
        ...('review' in publication
          ? { review: json(publication.review) }
          : { resultFingerprint: publication.resultFingerprint }),
        leaseExpiresAt: null,
      },
    });
  }

  private async readOutput(tx: Prisma.TransactionClient, ids: AvatarSyncScope, revision: number) {
    const released = await avatarRenderRevision(tx, ids, revision);
    const payload = (released?.snapshot as { payload?: OutputPayload } | null)?.payload;
    if (!released || !payload || !(await outputAuthorized(tx, ids.projectId, payload)))
      unavailable('已发布成片不可用');
    return released;
  }

  output(ids: AvatarSyncScope, revision: number, role: RenderFileRole) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const output = await this.readOutput(tx, ids, revision);
      const file = output.files.find(
        (binding) =>
          binding.role === role &&
          binding.fileObject.status === 'AVAILABLE' &&
          binding.fileObject.workflowRunId === ids.workflowRunId,
      )?.fileObject;
      if (!file) unavailable('成片文件不可用');
      return file;
    });
  }

  archive(ids: AvatarSyncScope, revision: number): Promise<AvatarRenderArchiveReceipt> {
    return this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const output = await this.readOutput(tx, ids, revision);
      const file = output.files.find(
        (binding) =>
          binding.role === 'video' &&
          binding.fileObject.status === 'AVAILABLE' &&
          binding.fileObject.workflowRunId === ids.workflowRunId,
      )?.fileObject;
      if (!file) unavailable('成片文件不可用');
      const ref = { artifactId: output.workingArtifactId, revision };
      const previous = await this.archiveReceipt(tx, ids, ref);
      if (previous) return previous;
      const operationKey = avatarRenderArchiveKey(
        ids.workflowRunId,
        output.workingArtifactId,
        revision,
      );
      const asset = await this.assets.createInTransaction(
        tx,
        ids.projectId,
        {
          name: `数字人口播成片 · 第${revision}版`,
          directory: 'FINAL_VIDEOS',
          type: 'FINAL_VIDEO',
          tags: [],
          notes: null,
          originalFileName: file.originalFileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          storageKey: file.storageKey,
          storageWorkflow: 'FISSION',
          workflowSpace: 'FISSION_AVATAR',
          sourceArtifactId: output.workingArtifactId,
          sourceRunId: ids.workflowRunId,
          sourceNode: AVATAR_OUTPUT_NODE,
          idempotencyKey: operationKey,
          businessData: { outputRevision: revision },
        },
        '数字人口播成片归档',
        operationKey,
      );
      return { assetId: asset.id, version: asset.currentVersion };
    });
  }
}
