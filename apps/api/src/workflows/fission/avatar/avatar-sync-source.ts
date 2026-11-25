import {
  AVATAR_NATIVE_LIMITS,
  AVATAR_NATIVE_MODEL,
  AVATAR_NATIVE_PORTRAIT_ID_PATTERN,
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
  type AvatarNativeWorkerInput,
  type AvatarScriptContent,
  parseAvatarDraft,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import {
  findCurrentAvatarGrant,
  isAvatarNativeVoiceReference,
  nativeVoiceReferenceMimeType,
} from '../../../platform/workflow/fission-avatar-scope';
import { sameAvatarAssetRef } from './avatar.repository';

export type AvatarSyncScope = { projectId: string; workflowRunId: string };
type ArtifactOrigin = AvatarArtifactRef & { contentHash: string };
type AuthorizedAsset = AvatarAssetRef & { authorizationId: string; versionId: string };
type CharacterOrigin = AuthorizedAsset & { sizeBytes: number; storageKey: string };
type NativeReferenceAudio = NonNullable<AvatarNativeWorkerInput['referenceAudio']> & {
  storageKey: string;
};
type NativeReferenceSelection =
  | { nativeVoice?: undefined; referenceAudio?: undefined }
  | { nativeVoice: AuthorizedAsset; referenceAudio: NativeReferenceAudio };
type TailChainSource = { sourceTaskId: string; model: typeof AVATAR_TAIL_CHAIN_MODEL };
type BaseSources = {
  binding: ArtifactOrigin;
  script: ArtifactOrigin;
  character: CharacterOrigin;
  scriptText: string;
};
export type LegacyAvatarSyncSources = BaseSources & {
  voice: AuthorizedAsset;
  voiceSpeaker: string;
  tailChain?: TailChainSource;
  mode?: undefined;
};
export type NativeAvatarSyncSources = BaseSources & {
  voice: null;
  mode: 'NATIVE';
  tailChain?: undefined;
  native: Pick<AvatarNativeWorkerInput, 'model' | 'durationSeconds' | 'image'>;
} & NativeReferenceSelection;
export type AvatarSyncSources = LegacyAvatarSyncSources | NativeAvatarSyncSources;

export type AvatarSyncOrigin = Pick<BaseSources, 'binding' | 'script'> & {
  character: AuthorizedAsset;
} & (
    | { voice: AuthorizedAsset; mode?: undefined; tailChain?: TailChainSource }
    | { voice: null; mode: 'NATIVE'; tailChain?: undefined; nativeVoice?: AuthorizedAsset }
  );

const presetSpeaker = new RegExp(AVATAR_SYNC_PRESET_SPEAKER_PATTERN);
const seedanceTaskId = new RegExp(AVATAR_TAIL_CHAIN_TASK_ID_PATTERN);
const seedancePortraitId = new RegExp(AVATAR_NATIVE_PORTRAIT_ID_PATTERN);

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

export async function prepareAvatarNativeSources(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  selection: Awaited<ReturnType<typeof readAvatarSyncSelection>>,
  durationSeconds: number = AVATAR_NATIVE_LIMITS.maxDurationSeconds,
): Promise<
  { source: NativeAvatarSyncSources; blockedReason: null } | { source: null; blockedReason: string }
> {
  const { draft, binding, script, bindingContent, scriptContent } = selection;
  if (
    !draft ||
    !binding ||
    !bindingContent ||
    !sameAvatarAssetRef(draft.character, bindingContent.character)
  )
    return { source: null, blockedReason: '请先确认已授权的图片形象' };
  if (!script || !scriptContent || draft.scriptText !== scriptContent.text)
    return { source: null, blockedReason: '请先确认当前生成提示词' };
  if (Array.from(scriptContent.text).length > AVATAR_NATIVE_LIMITS.maxPromptCharacters)
    return {
      source: null,
      blockedReason: `生成提示词最多 ${AVATAR_NATIVE_LIMITS.maxPromptCharacters} 字`,
    };

  const [character, voiceReference] = await Promise.all([
    findCurrentAvatarGrant(tx, ids.projectId, bindingContent.character),
    draft.nativeVoice ? findCurrentAvatarGrant(tx, ids.projectId, draft.nativeVoice) : null,
  ]);
  if (
    !character ||
    character.id !== bindingContent.authorizationId ||
    !['AVATAR_REFERENCE', 'DIGITAL_HUMAN_CHARACTER'].includes(character.version.asset.type) ||
    !character.version.asset.hasFile ||
    !character.version.storageKey
  )
    return { source: null, blockedReason: '请使用当前项目的已授权图片形象' };

  const { mimeType, sizeBytes, storageKey } = character.version;
  if (
    (mimeType !== 'image/png' && mimeType !== 'image/jpeg') ||
    sizeBytes < 1 ||
    sizeBytes > AVATAR_NATIVE_LIMITS.maxImageBytes
  )
    return { source: null, blockedReason: '原生生成支持 8 MiB 以内的 JPEG 或 PNG 形象' };
  const portraitId = character.seedancePortraitAssetId;
  if (portraitId && !seedancePortraitId.test(portraitId))
    return { source: null, blockedReason: '所选形象的方舟肖像登记无效' };

  let reference: NativeReferenceSelection = {};
  if (draft.nativeVoice) {
    const voiceMime =
      voiceReference && nativeVoiceReferenceMimeType(voiceReference.version.mimeType);
    if (!voiceReference || !voiceMime || !isAvatarNativeVoiceReference(voiceReference))
      return { source: null, blockedReason: '请选择当前项目中已授权用于 Seedance 的参考音色' };
    reference = {
      nativeVoice: assetOrigin(voiceReference),
      referenceAudio: {
        mimeType: voiceMime,
        sizeBytes: voiceReference.version.sizeBytes,
        storageKey: voiceReference.version.storageKey,
        sha256: null,
      },
    };
  }

  return {
    source: {
      binding,
      script,
      character: { ...assetOrigin(character), sizeBytes, storageKey },
      scriptText: scriptContent.text,
      mode: 'NATIVE',
      voice: null,
      ...reference,
      native: {
        model: AVATAR_NATIVE_MODEL,
        durationSeconds,
        image: portraitId
          ? { kind: 'PORTRAIT', assetId: portraitId }
          : { kind: 'BYTES', mimeType, sizeBytes, sha256: null },
      },
    },
    blockedReason: null,
  };
}

export async function prepareAvatarSyncSources(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  selection: Awaited<ReturnType<typeof readAvatarSyncSelection>>,
  maxScriptCharacters: number = AVATAR_SYNC_LIMITS.maxScriptCharacters,
  continuity = false,
): Promise<
  { source: LegacyAvatarSyncSources; blockedReason: null } | { source: null; blockedReason: string }
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
  frozen: AvatarSyncOrigin | AvatarSyncSources,
) {
  const character = await findCurrentAvatarGrant(tx, projectId, frozen.character);
  if (!isMatchingGrant(character, frozen.character)) return false;
  if (frozen.mode === 'NATIVE') {
    if (frozen.voice !== null) return false;
    const hasSnapshot = 'native' in frozen;
    if (!frozen.nativeVoice) return !hasSnapshot || !frozen.referenceAudio;
    const reference = await findCurrentAvatarGrant(tx, projectId, frozen.nativeVoice);
    if (
      !reference ||
      !isMatchingGrant(reference, frozen.nativeVoice) ||
      !isAvatarNativeVoiceReference(reference)
    )
      return false;
    if (!hasSnapshot) return true;
    const file = frozen.referenceAudio;
    return (
      !!file &&
      file.storageKey === reference.version.storageKey &&
      file.sizeBytes === reference.version.sizeBytes &&
      file.mimeType === nativeVoiceReferenceMimeType(reference.version.mimeType)
    );
  }
  const voice = await findCurrentAvatarGrant(tx, projectId, frozen.voice);
  return (
    isMatchingGrant(voice, frozen.voice) &&
    (!frozen.tailChain || character?.seedanceSourceTaskId === frozen.tailChain.sourceTaskId)
  );
}

export async function isAvatarSyncCurrent(
  tx: Prisma.TransactionClient,
  ids: AvatarSyncScope,
  frozen: AvatarSyncOrigin | AvatarSyncSources,
  selection?: Awaited<ReturnType<typeof readAvatarSyncSelection>>,
) {
  const latest = selection ?? (await readAvatarSyncSelection(tx, ids));
  return (
    sameAvatarArtifactRef(latest.binding, frozen.binding) &&
    sameAvatarArtifactRef(latest.script, frozen.script) &&
    latest.binding?.contentHash === frozen.binding.contentHash &&
    latest.script?.contentHash === frozen.script.contentHash &&
    (frozen.mode === 'NATIVE'
      ? sameAvatarAssetRef(latest.draft?.nativeVoice ?? null, frozen.nativeVoice ?? null)
      : sameAvatarAssetRef(latest.draft?.voice ?? null, frozen.voice)) &&
    (await avatarSyncGrantsValid(tx, ids.projectId, frozen))
  );
}
