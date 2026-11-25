import {
  AVATAR_SYNC_LIMITS,
  AVATAR_SYNC_PRESET_SPEAKER_PATTERN,
  AVATAR_TAIL_CHAIN_MODEL,
  AVATAR_TAIL_CHAIN_TASK_ID_PATTERN,
  FISSION_AVATAR_ARTIFACT_KEYS as KEYS,
  FISSION_AVATAR_DRAFT_NODE as DRAFT_NODE,
  FISSION_AVATAR_NODES as NODES,
  type AvatarArtifactRef,
  type AvatarAssetRef,
  type AvatarBindingContent,
  type AvatarScriptContent,
  parseAvatarDraft,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { findCurrentAvatarGrant } from '../../../platform/workflow/fission-avatar-scope';
import { sameAvatarAssetRef } from './avatar.repository';

export type AvatarSyncScope = { projectId: string; workflowRunId: string };
type ArtifactOrigin = AvatarArtifactRef & { contentHash: string };
type AuthorizedAsset = AvatarAssetRef & { authorizationId: string; versionId: string };
type CharacterOrigin = AuthorizedAsset & { sizeBytes: number; storageKey: string };
type TailChainSource = { sourceTaskId: string; model: typeof AVATAR_TAIL_CHAIN_MODEL };
export type AvatarSyncSources = {
  binding: ArtifactOrigin;
  script: ArtifactOrigin;
  character: CharacterOrigin;
  voice: AuthorizedAsset;
  scriptText: string;
  voiceSpeaker: string;
  tailChain?: TailChainSource;
};

export type AvatarSyncOrigin = Pick<AvatarSyncSources, 'binding' | 'script' | 'voice'> & {
  character: AuthorizedAsset;
  tailChain?: TailChainSource;
};

const presetSpeaker = new RegExp(AVATAR_SYNC_PRESET_SPEAKER_PATTERN);
const seedanceTaskId = new RegExp(AVATAR_TAIL_CHAIN_TASK_ID_PATTERN);

export function sameAvatarArtifactRef(left: AvatarArtifactRef | null, right: AvatarArtifactRef) {
  return left?.artifactId === right.artifactId && left?.revision === right.revision;
}

function workingSource(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  type: 'binding' | 'script',
) {
  return tx.workingArtifact.findUnique({
    where: {
      projectId_workflowRunId_nodeId_artifactKey: {
        ...ids,
        nodeId: NODES[type],
        artifactKey: KEYS[type],
      },
    },
    select: { id: true, revision: true, contentHash: true, payload: true, availability: true },
  });
}

function origin(row: NonNullable<Awaited<ReturnType<typeof workingSource>>>) {
  return { artifactId: row.id, revision: row.revision, contentHash: row.contentHash };
}

function assetOrigin(
  grant: NonNullable<Awaited<ReturnType<typeof findCurrentAvatarGrant>>>,
): AuthorizedAsset {
  return {
    assetId: grant.assetId,
    version: grant.assetVersion,
    authorizationId: grant.id,
    versionId: grant.version.id,
  };
}

function isMatchingGrant(
  grant: Awaited<ReturnType<typeof findCurrentAvatarGrant>>,
  frozen: AuthorizedAsset,
) {
  return grant?.id === frozen.authorizationId && grant.version.id === frozen.versionId;
}

export async function readAvatarSyncSelection(tx: Prisma.TransactionClient, ids: AvatarSyncScope) {
  const [draftRow, bindingRow, scriptRow] = await Promise.all([
    tx.workflowNodeState.findUnique({
      where: { projectId_workflowRunId_nodeId: { ...ids, nodeId: DRAFT_NODE } },
      select: { revision: true, state: true },
    }),
    workingSource(tx, ids, 'binding'),
    workingSource(tx, ids, 'script'),
  ]);
  return {
    draftRevision: draftRow?.revision ?? 0,
    draft: draftRow ? parseAvatarDraft(draftRow.state) : null,
    binding: bindingRow?.availability === 'AVAILABLE' ? origin(bindingRow) : null,
    script: scriptRow?.availability === 'AVAILABLE' ? origin(scriptRow) : null,
    bindingContent: (bindingRow?.payload ?? null) as AvatarBindingContent | null,
    scriptContent: (scriptRow?.payload ?? null) as AvatarScriptContent | null,
  };
}

export async function prepareAvatarSyncSources(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  selection: Awaited<ReturnType<typeof readAvatarSyncSelection>>,
  maxScriptCharacters: number = AVATAR_SYNC_LIMITS.maxScriptCharacters,
  continuity = false,
): Promise<
  { source: AvatarSyncSources; blockedReason: null } | { source: null; blockedReason: string }
> {
  const { draft, binding, script, bindingContent, scriptContent } = selection;
  if (
    !draft ||
    !binding ||
    !bindingContent ||
    !sameAvatarAssetRef(draft.character, bindingContent.character)
  )
    return { source: null, blockedReason: '请先确认已授权的视频形象' };
  if (!script || !scriptContent || draft.scriptText !== scriptContent.text)
    return { source: null, blockedReason: '请先确认当前口播文案' };
  if (Array.from(scriptContent.text).length > maxScriptCharacters)
    return {
      source: null,
      blockedReason: `当前口播文案最多 ${maxScriptCharacters} 字`,
    };
  if (!draft.voice) return { source: null, blockedReason: '请选择已授权的普通话音色' };

  const character = await findCurrentAvatarGrant(tx, ids.projectId, bindingContent.character);
  if (
    !character ||
    character.id !== bindingContent.authorizationId ||
    !['AVATAR_REFERENCE', 'DIGITAL_HUMAN_CHARACTER'].includes(character.version.asset.type) ||
    character.version.mimeType !== 'video/mp4' ||
    !character.version.asset.hasFile ||
    !character.version.storageKey ||
    character.version.sizeBytes < 1 ||
    character.version.sizeBytes > AVATAR_SYNC_LIMITS.maxCharacterBytes
  )
    return { source: null, blockedReason: '所选形象需要有效授权和不超过 64 MiB 的 MP4 视频' };
  const sourceTaskId = character.seedanceSourceTaskId;
  if (continuity && (!sourceTaskId || !seedanceTaskId.test(sourceTaskId)))
    return { source: null, blockedReason: '所选形象未登记可用于尾帧接续的原始方舟任务' };
  const voice = await findCurrentAvatarGrant(tx, ids.projectId, draft.voice);
  if (
    !voice ||
    voice.version.asset.type !== 'VOICE_PROFILE' ||
    !voice.doubaoSpeaker ||
    !presetSpeaker.test(voice.doubaoSpeaker)
  )
    return { source: null, blockedReason: '所选音色缺少有效的普通话生成授权' };
  return {
    source: {
      binding,
      script,
      character: {
        ...assetOrigin(character),
        storageKey: character.version.storageKey,
        sizeBytes: character.version.sizeBytes,
      },
      voice: assetOrigin(voice),
      scriptText: scriptContent.text,
      voiceSpeaker: voice.doubaoSpeaker,
      ...(continuity && sourceTaskId
        ? { tailChain: { sourceTaskId, model: AVATAR_TAIL_CHAIN_MODEL } }
        : {}),
    },
    blockedReason: null,
  };
}

export async function avatarSyncGrantsValid(
  tx: Prisma.TransactionClient,
  projectId: string,
  frozen: AvatarSyncOrigin,
) {
  const character = await findCurrentAvatarGrant(tx, projectId, frozen.character);
  const voice = await findCurrentAvatarGrant(tx, projectId, frozen.voice);
  return (
    isMatchingGrant(character, frozen.character) &&
    isMatchingGrant(voice, frozen.voice) &&
    (!frozen.tailChain || character?.seedanceSourceTaskId === frozen.tailChain.sourceTaskId)
  );
}

export async function isAvatarSyncCurrent(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  frozen: AvatarSyncOrigin,
  selection?: Awaited<ReturnType<typeof readAvatarSyncSelection>>,
) {
  const latest = selection ?? (await readAvatarSyncSelection(tx, ids));
  return (
    sameAvatarArtifactRef(latest.binding, frozen.binding) &&
    sameAvatarArtifactRef(latest.script, frozen.script) &&
    latest.binding?.contentHash === frozen.binding.contentHash &&
    latest.script?.contentHash === frozen.script.contentHash &&
    sameAvatarAssetRef(latest.draft?.voice ?? null, frozen.voice) &&
    (await avatarSyncGrantsValid(tx, ids.projectId, frozen))
  );
}
