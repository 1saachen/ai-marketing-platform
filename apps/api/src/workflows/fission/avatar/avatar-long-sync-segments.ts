import {
  AVATAR_SYNC_NODE,
  parseAvatarLongSyncWorkerInput,
  parseAvatarTailChainWorkerInput,
  type AvatarLongSyncCompletion,
  type AvatarSyncCompletion,
  type AvatarTailChainPlan,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import type {
  FissionAvatarSyncSegment,
  FissionAvatarSyncTask,
  Prisma,
} from '../../../generated/prisma/client';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type { AvatarSyncScope, AvatarSyncSources } from './avatar-sync-source';

export type AvatarSegmentRole = 'audio' | 'video';

export function isSegmented(task: FissionAvatarSyncTask) {
  return task.executionKind === 'SEGMENTED';
}

export function segmentsForTask(tx: Prisma.TransactionClient, task: FissionAvatarSyncTask) {
  return tx.fissionAvatarSyncSegment.findMany({
    where: { taskId: task.id, projectId: task.projectId, workflowRunId: task.workflowRunId },
    orderBy: { ordinal: 'asc' },
  });
}

export function unknownSegment(segments: FissionAvatarSyncSegment[]) {
  return segments.find(
    (segment) =>
      (segment.lipSyncStarted && !segment.lipSyncTaskId) ||
      (segment.pictureStarted && !segment.pictureTaskId),
  );
}

export function nextSegment(segments: FissionAvatarSyncSegment[]) {
  return segments.find((segment) => !segment.resultFingerprint);
}

export function segmentProgress(task: FissionAvatarSyncTask, segments: FissionAvatarSyncSegment[]) {
  const current = nextSegment(segments)?.ordinal ?? null;
  return {
    total: segments.length,
    completed: segments.filter((segment) => !!segment.resultFingerprint).length,
    activeOrdinal: task.status === 'RUNNING' ? current : null,
    failedOrdinal: task.status === 'FAILED' ? current : null,
  };
}

export function segmentMedia(segment: FissionAvatarSyncSegment) {
  return segment.media as AvatarSyncCompletion | null;
}

function invalidMedia(message: string): never {
  throw new ApiHttpException(message, 422, 'VALIDATION_ERROR');
}

export async function segmentFile(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  segment: FissionAvatarSyncSegment,
  role: AvatarSegmentRole,
) {
  const id = role === 'audio' ? segment.audioFileObjectId : segment.videoFileObjectId;
  if (!id || !segment.resultFingerprint) return null;
  return tx.fileObject.findFirst({
    where: { ...ids, id, nodeId: AVATAR_SYNC_NODE, status: 'AVAILABLE' },
  });
}

export async function longWorkerInput(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  segments: FissionAvatarSyncSegment[],
  source: AvatarSyncSources,
) {
  const descriptors = [];
  for (const segment of segments) {
    const {
      ordinal,
      scriptText,
      ttsOperationId,
      ttsStarted,
      lipSyncClientToken,
      lipSyncStarted,
      lipSyncTaskId,
    } = segment;
    descriptors.push({
      ordinal,
      scriptText,
      ttsOperationId,
      ttsStarted,
      lipSyncClientToken,
      lipSyncStarted,
      lipSyncTaskId,
      result: await segmentResult(tx, ids, segment),
    });
  }
  return parseAvatarLongSyncWorkerInput({
    schemaVersion: 2,
    voiceSpeaker: source.voiceSpeaker,
    characterSizeBytes: source.character.sizeBytes,
    segments: descriptors,
  });
}

async function segmentResult(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  segment: FissionAvatarSyncSegment,
) {
  if (!segment.resultFingerprint) return null;
  const audio = await segmentFile(tx, ids, segment, 'audio');
  const video = await segmentFile(tx, ids, segment, 'video');
  const media = segmentMedia(segment);
  if (!media || !audio || !video) invalidMedia('已完成的口播分段文件不可用');
  return {
    media,
    audio: { sizeBytes: audio.sizeBytes, sha256: audio.sha256 },
    video: { sizeBytes: video.sizeBytes, sha256: video.sha256 },
  };
}

export async function tailChainWorkerInput(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  task: FissionAvatarSyncTask,
  segments: FissionAvatarSyncSegment[],
  source: AvatarSyncSources,
) {
  const descriptors = [];
  for (const segment of segments) {
    descriptors.push({
      ordinal: segment.ordinal,
      pictureStarted: segment.pictureStarted,
      pictureTaskId: segment.pictureTaskId,
      lipSyncClientToken: segment.lipSyncClientToken,
      lipSyncStarted: segment.lipSyncStarted,
      lipSyncTaskId: segment.lipSyncTaskId,
      result: await segmentResult(tx, ids, segment),
    });
  }
  return parseAvatarTailChainWorkerInput({
    schemaVersion: 3,
    voiceSpeaker: source.voiceSpeaker,
    scriptText: source.scriptText,
    ...source.tailChain,
    ttsOperationId: task.ttsOperationId,
    ttsStarted: task.ttsStarted,
    plan: task.continuityPlan,
    segments: descriptors,
  });
}

export function validateTailChainSegment(
  task: FissionAvatarSyncTask,
  ordinal: number,
  media: AvatarSyncCompletion,
) {
  const plan = task.continuityPlan as AvatarTailChainPlan | null;
  const seconds = plan?.segments[ordinal - 1]?.durationSeconds;
  if (seconds === undefined || media.audioDurationMs !== seconds * 1000)
    invalidMedia('口播分段时长与已冻结的驱动计划不一致');
}

export function validateTailChainTimeline(
  task: FissionAvatarSyncTask,
  media: AvatarLongSyncCompletion,
) {
  const plan = task.continuityPlan as AvatarTailChainPlan | null;
  if (!plan) invalidMedia('长片尚未冻结完整音频分段计划');
  const boundaries = [...media.seamTimesMs, media.videoDurationMs];
  let end = 0;
  if (
    boundaries.length !== plan.segments.length ||
    plan.segments.some((segment, index) => {
      end += segment.durationSeconds * 1000;
      return boundaries[index] !== end;
    })
  )
    invalidMedia('长片接缝与已冻结的驱动计划不一致');
}

export function validateSegmentedTimeline(
  segments: FissionAvatarSyncSegment[],
  result: AvatarLongSyncCompletion,
) {
  const ends = [...result.seamTimesMs, result.videoDurationMs];
  if (ends.length !== segments.length || segments.some((segment) => !segment.resultFingerprint))
    invalidMedia('分段尚未全部完成');
  let startFrame = 0;
  const wordTimings: AvatarSyncCompletion['wordTimings'] = [];
  for (const [index, endpoint] of ends.entries()) {
    const endFrame = Math.round((endpoint * 30) / 1000);
    const duration = ((endFrame - startFrame) * 1000) / 30;
    const metadata = segmentMedia(segments[index]!);
    if (
      !metadata ||
      endFrame <= startFrame ||
      Math.round((endFrame * 1000) / 30) !== endpoint ||
      duration < metadata.audioDurationMs - 1 ||
      duration > metadata.audioDurationMs + 34
    ) {
      invalidMedia('长片接缝或分段长度与已确认媒体不一致');
    }
    const startMs = Math.round((startFrame * 1000) / 30);
    for (const word of metadata.wordTimings) {
      wordTimings.push({ ...word, startMs: startMs + word.startMs, endMs: startMs + word.endMs });
    }
    startFrame = endFrame;
  }
  if (workflowStateHash(wordTimings) !== workflowStateHash(result.wordTimings))
    invalidMedia('长片字幕时标与已确认分段不一致');
}

export async function clearSegmentMedia(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  task: FissionAvatarSyncTask,
) {
  const segments = await segmentsForTask(tx, task);
  const fileIds = segments
    .flatMap((segment) => [segment.audioFileObjectId, segment.videoFileObjectId])
    .filter((id): id is string => !!id);
  if (!fileIds.length) return;
  const scope = { ...ids, id: { in: fileIds }, nodeId: AVATAR_SYNC_NODE };
  const files = await tx.fileObject.findMany({ where: scope, select: { storageKey: true } });
  await tx.fissionAvatarSyncSegment.updateMany({
    where: { ...ids, taskId: task.id },
    data: { audioFileObjectId: null, videoFileObjectId: null },
  });
  await tx.fileObject.deleteMany({ where: scope });
  await tx.storageCleanupTask.createMany({
    data: files.map(({ storageKey }) => ({
      projectId: ids.projectId,
      storageKey,
      reason: 'AVATAR_SYNC_SEGMENT_MEDIA',
    })),
    skipDuplicates: true,
  });
}
