import {
  AVATAR_COMPOSITION_ARTIFACT_KEY,
  AVATAR_COMPOSITION_NODE,
  AVATAR_OUTPUT_ARTIFACT_KEY,
  AVATAR_OUTPUT_NODE,
  AVATAR_LONG_LIMITS,
  AVATAR_RENDER_LIMITS,
  AVATAR_SYNC_ARTIFACT_KEY,
  AVATAR_SYNC_NODE,
  isAvatarLongSyncMedia,
  type AvatarArtifactRef,
  type AvatarCaptionCue,
  type AvatarCompositionDraft,
  type AvatarSyncMedia,
} from '@ai-marketing/contracts';
import type { FileObject, Prisma } from '../../../generated/prisma/client';
import { workingArtifactInclude } from '../../../platform/workflow/workflow-working.repository';
import {
  avatarRenderOriginAuthorized,
  findAvatarBackground,
  type AvatarRenderOrigin,
} from '../../../platform/workflow/fission-avatar-delivery';
import {
  isAvatarSyncCurrent,
  sameAvatarArtifactRef,
  type AvatarSyncOrigin,
  type AvatarSyncScope,
} from './avatar-sync-source';

type WithHash = AvatarArtifactRef & { contentHash: string };
type FrozenFile = Pick<FileObject, 'id' | 'storageKey' | 'mimeType' | 'sizeBytes' | 'sha256'>;
export type CompositionPayload = Pick<AvatarCompositionDraft, 'sync' | 'settings'> & {
  backgroundVersionId: string | null;
};
export type RenderSource = {
  sync: WithHash;
  origin: AvatarSyncOrigin;
  media: AvatarSyncMedia;
  video: FrozenFile;
  audio: FrozenFile;
};
export type RenderSnapshot = RenderSource & {
  composition: WithHash;
  settings: CompositionPayload['settings'];
  background: Awaited<ReturnType<typeof findAvatarBackground>>;
};
export type OutputPayload = {
  origin: AvatarRenderOrigin;
  composition: WithHash;
  sync: WithHash;
  durationMs: number;
};

const nodes = {
  sync: { nodeId: AVATAR_SYNC_NODE, artifactKey: AVATAR_SYNC_ARTIFACT_KEY },
  composition: { nodeId: AVATAR_COMPOSITION_NODE, artifactKey: AVATAR_COMPOSITION_ARTIFACT_KEY },
  output: { nodeId: AVATAR_OUTPUT_NODE, artifactKey: AVATAR_OUTPUT_ARTIFACT_KEY },
} as const;

export function renderArtifact(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  kind: keyof typeof nodes,
) {
  return tx.workingArtifact.findUnique({
    where: { projectId_workflowRunId_nodeId_artifactKey: { ...ids, ...nodes[kind] } },
    include: workingArtifactInclude,
  });
}

export function artifactRef(artifact: { id: string; revision: number; contentHash: string }) {
  return {
    artifactId: artifact.id,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  };
}

export function artifactDependency(kind: 'sync' | 'composition', artifact: WithHash) {
  return {
    sourceType: 'WORKING_ARTIFACT' as const,
    sourceNodeId: nodes[kind].nodeId,
    sourceArtifactId: artifact.artifactId,
    sourceKey: nodes[kind].artifactKey,
    sourceRevision: artifact.revision,
    sourceHash: artifact.contentHash,
  };
}

function frozenFile(file: FileObject): FrozenFile {
  const { id, storageKey, mimeType, sizeBytes, sha256 } = file;
  return { id, storageKey, mimeType, sizeBytes, sha256 };
}

export async function renderSource(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
  const row = await renderArtifact(tx, ids, 'sync');
  if (row?.availability !== 'AVAILABLE') return null;
  const payload = row.payload as unknown as {
    origin: AvatarSyncOrigin;
    media: AvatarSyncMedia;
  };
  if (!(await isAvatarSyncCurrent(tx, ids, payload.origin))) return null;
  const mediaFile = (role: 'audio' | 'video') =>
    row.files.find(
      (file) =>
        file.role === role &&
        file.fileObject.status === 'AVAILABLE' &&
        file.fileObject.workflowRunId === ids.workflowRunId &&
        file.fileObject.nodeId === AVATAR_SYNC_NODE,
    )?.fileObject;
  const video = mediaFile('video');
  const audio = mediaFile('audio');
  if (!video || !audio || video.mimeType !== 'video/mp4' || audio.mimeType !== 'audio/mpeg')
    return null;
  return {
    sync: artifactRef(row),
    origin: payload.origin,
    media: payload.media,
    video: frozenFile(video),
    audio: frozenFile(audio),
  } satisfies RenderSource;
}

export function publicRef(artifact: WithHash): AvatarArtifactRef {
  return { artifactId: artifact.artifactId, revision: artifact.revision };
}

export function captionDuration(source: RenderSource) {
  return Math.min(source.media.audioDurationMs, source.media.videoDurationMs);
}

export function suggestedCaptions(source: RenderSource): AvatarCaptionCue[] {
  const cues: AvatarCaptionCue[] = [];
  const duration = captionDuration(source);
  const cueLimit = isAvatarLongSyncMedia(source.media)
    ? AVATAR_LONG_LIMITS.maxCaptionCount
    : AVATAR_RENDER_LIMITS.maxCaptionCount;
  for (const word of source.media.wordTimings) {
    const text = Array.from(word.text, (character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
      .join('')
      .trim();
    const endMs = Math.min(word.endMs, duration);
    if (
      !text ||
      word.startMs >= endMs ||
      Array.from(text).length > AVATAR_RENDER_LIMITS.maxCaptionCharacters
    )
      continue;
    const last = cues.at(-1);
    const line = last ? `${last.text}${text}` : text;
    if (
      last &&
      (word.startMs < last.endMs ||
        (word.startMs - last.endMs <= 300 && endMs - last.startMs <= 2500)) &&
      Array.from(line).length <= AVATAR_RENDER_LIMITS.maxCaptionCharacters
    ) {
      last.endMs = Math.max(last.endMs, endMs);
      last.text = line;
    } else {
      const startMs = Math.max(word.startMs, last?.endMs ?? 0);
      if (startMs < endMs && cues.length < cueLimit) cues.push({ startMs, endMs, text });
    }
  }
  return cues;
}

export function publicOrigin(frozen: RenderSnapshot): AvatarRenderOrigin {
  const { character, voice } = frozen.origin;
  const background = frozen.background;
  return {
    character,
    voice,
    background: background
      ? { assetId: background.assetId, version: background.version, versionId: background.id }
      : null,
  };
}

export async function outputAuthorized(
  tx: Prisma.TransactionClient,
  projectId: string,
  output: OutputPayload,
) {
  return avatarRenderOriginAuthorized(tx, projectId, output.origin);
}

export async function compositionSources(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  row: NonNullable<Awaited<ReturnType<typeof renderArtifact>>>,
  source: RenderSource | null,
): Promise<RenderSnapshot | null> {
  if (row.availability !== 'AVAILABLE' || !source) return null;
  const payload = row.payload as unknown as CompositionPayload;
  if (!sameAvatarArtifactRef(source.sync, payload.sync)) return null;
  const { background } = payload.settings;
  const found =
    background.kind === 'IMAGE' ? await findAvatarBackground(tx, ids.projectId, background) : null;
  if (background.kind === 'IMAGE' && (!found || found.id !== payload.backgroundVersionId))
    return null;
  return {
    ...source,
    composition: artifactRef(row),
    settings: payload.settings,
    background: found,
  };
}
