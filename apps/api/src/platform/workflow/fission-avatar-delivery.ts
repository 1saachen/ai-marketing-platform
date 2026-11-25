import {
  AVATAR_OUTPUT_ARTIFACT_KEY,
  AVATAR_OUTPUT_NODE,
  AVATAR_RENDER_LIMITS,
  type AvatarAssetRef,
} from '@ai-marketing/contracts';
import type { Asset, Prisma } from '../../generated/prisma/client';
import { AVATAR_WORKFLOW_SCOPE, findCurrentAvatarGrant } from './fission-avatar-scope';

type FrozenAsset = AvatarAssetRef & { authorizationId: string; versionId: string };

export type AvatarRenderOrigin = {
  character: FrozenAsset;
  voice: FrozenAsset;
  background: (AvatarAssetRef & { versionId: string }) | null;
};

export const AVATAR_BACKGROUND_MIMES = ['image/jpeg', 'image/png'];

export function avatarBackgroundVersionWhere(projectId: string): Prisma.AssetVersionWhereInput {
  return {
    projectId,
    status: 'AVAILABLE',
    mimeType: { in: AVATAR_BACKGROUND_MIMES },
    sizeBytes: { gte: 1, lte: AVATAR_RENDER_LIMITS.maxBackgroundBytes },
    storageKey: { not: '' },
    asset: {
      projectId,
      storageWorkflow: AVATAR_WORKFLOW_SCOPE.workflow,
      workflowSpace: AVATAR_WORKFLOW_SCOPE.workflowSpace,
      type: 'SCENE_BACKGROUND',
      status: 'AVAILABLE',
      archivedAt: null,
      hasFile: true,
    },
  };
}

export function findAvatarBackground(
  tx: Prisma.TransactionClient,
  projectId: string,
  ref: AvatarAssetRef,
) {
  return tx.assetVersion.findFirst({
    where: {
      ...avatarBackgroundVersionWhere(projectId),
      assetId: ref.assetId,
      version: ref.version,
    },
    select: {
      id: true,
      assetId: true,
      version: true,
      sizeBytes: true,
      storageKey: true,
      mimeType: true,
    },
  });
}

export async function avatarRenderOriginAuthorized(
  tx: Prisma.TransactionClient,
  projectId: string,
  origin: AvatarRenderOrigin,
) {
  const [character, voice, background] = await Promise.all([
    findCurrentAvatarGrant(tx, projectId, origin.character),
    findCurrentAvatarGrant(tx, projectId, origin.voice),
    origin.background ? findAvatarBackground(tx, projectId, origin.background) : null,
  ]);
  return (
    character?.id === origin.character.authorizationId &&
    character.version.id === origin.character.versionId &&
    voice?.id === origin.voice.authorizationId &&
    voice.version.id === origin.voice.versionId &&
    (!origin.background || background?.id === origin.background.versionId)
  );
}

export function avatarRenderRevision(
  tx: Prisma.TransactionClient,
  scope: { projectId: string; workflowRunId: string },
  revision: number,
) {
  return tx.workingArtifactRevisionSnapshot.findFirst({
    where: {
      ...scope,
      nodeId: AVATAR_OUTPUT_NODE,
      artifactKey: AVATAR_OUTPUT_ARTIFACT_KEY,
      revision,
      workflowRun: AVATAR_WORKFLOW_SCOPE,
    },
    include: { files: { include: { fileObject: true } } },
  });
}

export function avatarRenderArchiveKey(runId: string, artifactId: string, revision: number) {
  return `avatar-render:${runId}:${artifactId}:${revision}`;
}

export function isAvatarRenderArchive(record: Asset) {
  return (
    record.storageWorkflow === AVATAR_WORKFLOW_SCOPE.workflow &&
    record.workflowSpace === AVATAR_WORKFLOW_SCOPE.workflowSpace &&
    record.sourceNode === AVATAR_OUTPUT_NODE &&
    record.idempotencyKey?.startsWith('avatar-render:') === true
  );
}

export async function canReadAvatarRenderArchive(tx: Prisma.TransactionClient, record: Asset) {
  const { projectId, sourceRunId, sourceArtifactId, businessData, idempotencyKey } = record;
  const revision = (businessData as { outputRevision?: number } | null)?.outputRevision;
  if (
    !sourceRunId ||
    !sourceArtifactId ||
    !revision ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    idempotencyKey !== avatarRenderArchiveKey(sourceRunId, sourceArtifactId, revision)
  )
    return false;
  const confirmed = await avatarRenderRevision(
    tx,
    { projectId, workflowRunId: sourceRunId },
    revision,
  );
  const payload = (confirmed?.snapshot as { payload?: { origin?: AvatarRenderOrigin } } | null)
    ?.payload;
  return !!(
    confirmed &&
    confirmed.workingArtifactId === sourceArtifactId &&
    payload?.origin &&
    confirmed.files.some(
      (binding) =>
        binding.role === 'video' &&
        binding.fileObject.workflowRunId === sourceRunId &&
        binding.fileObject.storageKey === record.storageKey &&
        binding.fileObject.status === 'AVAILABLE',
    ) &&
    (await avatarRenderOriginAuthorized(tx, projectId, payload.origin))
  );
}
