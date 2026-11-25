import { AVATAR_NATIVE_LIMITS, type AvatarAssetRef } from '@ai-marketing/contracts';
import { ApiHttpException } from '../../common/api-http-exception';
import type { Prisma } from '../../generated/prisma/client';

export const AVATAR_WORKFLOW_SCOPE = {
  workflow: 'FISSION',
  workflowSpace: 'FISSION_AVATAR',
} as const;

export const AVATAR_SYNC_RECONCILE_MS = 30 * 24 * 60 * 60 * 1000;

export const AVATAR_RENDER_ACTIVE_STATUSES = ['QUEUED', 'RUNNING', 'AWAITING_REVIEW'];
export const AVATAR_CHARACTER_TYPES = ['DIGITAL_HUMAN_CHARACTER', 'AVATAR_REFERENCE'] as const;

export function currentAvatarGrantWhere(
  projectId: string,
  now: Date,
): Prisma.FissionAvatarAssetGrantWhereInput {
  return {
    projectId,
    grantedAt: { lte: now },
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    version: {
      projectId,
      status: 'AVAILABLE',
      asset: {
        projectId,
        archivedAt: null,
        status: 'AVAILABLE',
        storageWorkflow: AVATAR_WORKFLOW_SCOPE.workflow,
        workflowSpace: AVATAR_WORKFLOW_SCOPE.workflowSpace,
        type: { in: [...AVATAR_CHARACTER_TYPES, 'VOICE_PROFILE'] },
      },
    },
  };
}

export function findCurrentAvatarGrant(
  tx: Prisma.TransactionClient,
  projectId: string,
  asset: AvatarAssetRef,
) {
  return tx.fissionAvatarAssetGrant.findFirst({
    where: {
      ...currentAvatarGrantWhere(projectId, new Date()),
      assetId: asset.assetId,
      assetVersion: asset.version,
    },
    include: { version: { include: { asset: true } } },
  });
}

export function nativeVoiceReferenceMimeType(mimeType: string): 'audio/mpeg' | 'audio/wav' | null {
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return 'audio/mpeg';
  if (['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mimeType))
    return 'audio/wav';
  return null;
}

export function isAvatarNativeVoiceReference(
  grant: NonNullable<Awaited<ReturnType<typeof findCurrentAvatarGrant>>>,
) {
  const { version } = grant;
  return (
    grant.seedanceVoiceReference &&
    version.asset.type === 'VOICE_PROFILE' &&
    version.asset.hasFile &&
    Boolean(version.storageKey) &&
    version.sizeBytes > 0 &&
    version.sizeBytes <= AVATAR_NATIVE_LIMITS.maxReferenceAudioBytes &&
    nativeVoiceReferenceMimeType(version.mimeType) !== null
  );
}

export function avatarSyncReconciliationFilter(
  includeSegments = true,
  includePicture = includeSegments,
  includeNative = true,
): Prisma.FissionAvatarSyncTaskWhereInput {
  return {
    updatedAt: { gt: new Date(Date.now() - AVATAR_SYNC_RECONCILE_MS) },
    OR: [
      { lipSyncStarted: true, lipSyncTaskId: null },
      { errorCode: 'PROVIDER_CREATION_UNKNOWN' },
      ...(includeNative ? [{ nativeStarted: true, nativeTaskId: null }] : []),
      ...(includeSegments
        ? [{ segments: { some: { lipSyncStarted: true, lipSyncTaskId: null } } }]
        : []),
      ...(includeSegments && includePicture
        ? [{ segments: { some: { pictureStarted: true, pictureTaskId: null } } }]
        : []),
    ],
  };
}

export async function lockAvatarProject(tx: Prisma.TransactionClient, projectId: string) {
  const [project] = await tx.$queryRaw<{ deletionState: string | null }[]>`
    SELECT "deletionState" FROM "projects" WHERE id = ${projectId}::uuid FOR UPDATE`;
  if (!project) throw new ApiHttpException('项目不存在', 404, 'PROJECT_NOT_FOUND');
  if (project.deletionState) throw new ApiHttpException('项目正在删除', 409, 'PROJECT_DELETING');
}

export async function lockAvatarRun(
  tx: Prisma.TransactionClient,
  ids: { projectId: string; workflowRunId: string },
  writable = false,
) {
  await lockAvatarProject(tx, ids.projectId);
  const run = await tx.workflowRun.findFirst({
    where: { projectId: ids.projectId, id: ids.workflowRunId, ...AVATAR_WORKFLOW_SCOPE },
  });
  if (!run) throw new ApiHttpException('数字人口播工作流不存在', 404, 'VALIDATION_ERROR');
  if (writable && (run.status !== 'ACTIVE' || run.activeKey !== 'ACTIVE'))
    throw new ApiHttpException('工作流已暂停，请重新进入后编辑', 409, 'CONFLICT');
  return run;
}
