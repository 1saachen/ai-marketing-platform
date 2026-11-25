import { CLONE_UUID_PATTERN } from './fission-clone';
import { enumeration, integer, nullable, object, parse, text } from './fission-clone-schema';
import type { WorkflowRunStatus } from './workflow-working';

export const FISSION_AVATAR_DRAFT_NODE = 'AVATAR_WORKSPACE';
export const FISSION_AVATAR_NODES = {
  binding: 'AVATAR_BINDING',
  script: 'AVATAR_SCRIPT',
} as const;
export const FISSION_AVATAR_ARTIFACT_KEYS = {
  binding: 'avatar-binding',
  script: 'avatar-script',
} as const;

export const AVATAR_SCRIPT_MAX_LENGTH = 10_000;
const SCRIPT_SOURCES = ['MANUAL', 'TXT'] as const;
export type AvatarScriptSource = (typeof SCRIPT_SOURCES)[number];

export type AvatarAssetRef = { assetId: string; version: number };
export type AvatarDraftData = {
  character: AvatarAssetRef | null;
  voice: AvatarAssetRef | null;
  nativeVoice?: AvatarAssetRef | null;
  scriptText: string;
  scriptSource: AvatarScriptSource;
};
export type AvatarDraft = { revision: number; data: AvatarDraftData };
export type AvatarSaveDraftRequest = { expectedRevision: number; draft: AvatarDraftData };
export type AvatarConfirmRequest = { expectedRevision: number };
export type AvatarWorkspaceAsset = AvatarAssetRef & {
  name: string;
  authorizationId: string;
  previewKind: 'IMAGE' | 'VIDEO' | 'AUDIO' | null;
  previewUrl: string | null;
  nativeReferenceAvailable?: boolean;
};
export type AvatarBindingContent = { character: AvatarAssetRef; authorizationId: string };
export type AvatarScriptContent = {
  text: string;
  source: AvatarScriptSource;
  language: 'zh-CN';
  estimatedDurationMs: number;
};
export type AvatarConfirmed<T> = { artifactId: string; revision: number; content: T };
export type AvatarWorkspaceData = {
  projectId: string;
  workflowRunId: string;
  runStatus: WorkflowRunStatus;
  draft: AvatarDraft;
  binding: AvatarConfirmed<AvatarBindingContent> | null;
  script: AvatarConfirmed<AvatarScriptContent> | null;
  characters: AvatarWorkspaceAsset[];
  voices: AvatarWorkspaceAsset[];
};

const maxPersistedInteger = 2_147_483_647;
const assetRef = object({
  assetId: { type: 'string', pattern: CLONE_UUID_PATTERN },
  version: integer(1, maxPersistedInteger),
});
const draftSchema = {
  ...object({
    character: nullable(assetRef),
    voice: nullable(assetRef),
    nativeVoice: nullable(assetRef),
    scriptText: text(AVATAR_SCRIPT_MAX_LENGTH),
    scriptSource: enumeration(...SCRIPT_SOURCES),
  }),
  required: ['character', 'voice', 'scriptText', 'scriptSource'],
};
const saveSchema = object({
  expectedRevision: integer(0, maxPersistedInteger),
  draft: draftSchema,
});
const confirmSchema = object({ expectedRevision: integer(0, maxPersistedInteger) });

export function emptyAvatarDraft(): AvatarDraftData {
  return { character: null, voice: null, scriptText: '', scriptSource: 'MANUAL' };
}

export function parseAvatarDraft(value: unknown): AvatarDraftData {
  return parse(draftSchema, value);
}

export function parseAvatarSaveDraftRequest(value: unknown): AvatarSaveDraftRequest {
  return parse(saveSchema, value);
}

export function parseAvatarConfirmRequest(value: unknown): AvatarConfirmRequest {
  return parse(confirmSchema, value);
}

export function estimateAvatarScriptDurationMs(script: string): number {
  // Estimate at four spoken characters per second. The sync result owns measured duration.
  const spokenCharacterCount = script.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return spokenCharacterCount * 250;
}
