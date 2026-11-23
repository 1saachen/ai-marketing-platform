import { CLONE_UUID_PATTERN } from './fission-clone';
import {
  enumeration,
  fail,
  integer,
  nullable,
  object,
  parse,
  published,
  text,
} from './fission-clone-schema';

export const LOCAL_REPLACE_NODES = [
  'LOCAL_REPLACE_SOURCE',
  'LOCAL_REPLACE_RANGE',
  'LOCAL_REPLACE_BINDING',
  'LOCAL_REPLACE_PROMPT',
  'LOCAL_REPLACE_OUTPUT',
] as const;
export type LocalReplaceNodeId = (typeof LOCAL_REPLACE_NODES)[number];

export const LOCAL_REPLACE_LIMITS = {
  minDurationMs: 4000,
  maxDurationMs: 15000,
  minRangeMs: 100,
  maxSourceBytes: 200_000_000,
  maxTargetBytes: 4 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxObjectDescriptionLength: 500,
  maxInstructionLength: 1200,
} as const;
export const LOCAL_REPLACE_SOURCE_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const LOCAL_REPLACE_TARGET_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type LocalReplaceObjectType = 'PRODUCT' | 'PROP';
export type LocalReplaceAssetRef = { assetId: string; version: number };
export type LocalReplaceDraft = {
  nodeId: LocalReplaceNodeId;
  source: LocalReplaceAssetRef | null;
  target: LocalReplaceAssetRef | null;
  startMs: number;
  endMs: number;
  objectType: LocalReplaceObjectType;
  objectDescription: string;
  instruction: string;
  sourceRightsConfirmed: boolean;
};
export type LocalReplaceDraftSaveRequest = { expectedRevision: number; draft: LocalReplaceDraft };
export type LocalReplaceTaskCreateRequest = { expectedRevision: number; idempotencyKey: string };
export type LocalReplaceTaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type LocalReplaceTask = {
  id: string;
  status: LocalReplaceTaskStatus;
  progress: number;
  message: string;
  canRetry: boolean;
  stale: boolean;
  source: LocalReplaceAssetRef;
  startMs: number;
  endMs: number;
  result: { contentUrl: string; downloadUrl: string } | null;
  createdAt: string;
};
export type LocalReplaceWorkspace = {
  runId: string;
  draftRevision: number;
  draft: LocalReplaceDraft;
  tasks: LocalReplaceTask[];
};
export type LocalReplaceWorkerInput = {
  schemaVersion: 1;
  model: string;
  sourceMimeType: (typeof LOCAL_REPLACE_SOURCE_MIME_TYPES)[number];
  targetMimeType: (typeof LOCAL_REPLACE_TARGET_MIME_TYPES)[number];
  sourceSizeBytes: number;
  targetSizeBytes: number;
  startMs: number;
  endMs: number;
  objectType: LocalReplaceObjectType;
  objectDescription: string;
  instruction: string;
};
export type LocalReplaceClaim =
  | { status: 'BUSY' | 'INACTIVE' }
  | {
      status: 'CLAIMED';
      attemptToken: string;
      input: LocalReplaceWorkerInput;
      providerTaskId: string | null;
      creationPending: boolean;
    };
export type LocalReplaceSourceProbe = {
  frameCount: number;
  ratio: '9:16' | '16:9';
  hasAudio: boolean;
};

const {
  maxDurationMs,
  minRangeMs,
  maxSourceBytes,
  maxTargetBytes,
  maxObjectDescriptionLength,
  maxInstructionLength,
} = LOCAL_REPLACE_LIMITS;
const uuid = { type: 'string', pattern: CLONE_UUID_PATTERN };
const mediaRef = object({ assetId: uuid, version: integer(1) });
const editFields = {
  startMs: integer(0, maxDurationMs - 1),
  endMs: integer(0, maxDurationMs),
  objectType: enumeration('PRODUCT', 'PROP'),
  objectDescription: text(maxObjectDescriptionLength),
  instruction: text(maxInstructionLength),
};
const draftSchema = object({
  nodeId: enumeration(...LOCAL_REPLACE_NODES),
  source: nullable(mediaRef),
  target: nullable(mediaRef),
  sourceRightsConfirmed: { type: 'boolean' },
  ...editFields,
});
const saveSchema = object({ expectedRevision: integer(), draft: draftSchema });
const createSchema = object({ expectedRevision: integer(), idempotencyKey: uuid });
const probeSchema = object({
  frameCount: integer(96, 360),
  ratio: enumeration('9:16', '16:9'),
  hasAudio: { type: 'boolean' },
});

export const FISSION_LOCAL_REPLACE_WORKER_INPUT_SCHEMA = published(
  'fission-local-replace-worker-input.schema.json',
  object({
    schemaVersion: { const: 1 },
    model: { ...text(160), minLength: 1 },
    sourceMimeType: enumeration(...LOCAL_REPLACE_SOURCE_MIME_TYPES),
    targetMimeType: enumeration(...LOCAL_REPLACE_TARGET_MIME_TYPES),
    sourceSizeBytes: integer(1, maxSourceBytes),
    targetSizeBytes: integer(1, maxTargetBytes),
    ...editFields,
    endMs: integer(minRangeMs, maxDurationMs),
    objectDescription: { ...editFields.objectDescription, minLength: 1 },
  }),
);

export function emptyLocalReplaceDraft(): LocalReplaceDraft {
  return {
    nodeId: 'LOCAL_REPLACE_SOURCE',
    source: null,
    target: null,
    startMs: 0,
    endMs: 0,
    objectType: 'PRODUCT',
    objectDescription: '',
    instruction: '',
    sourceRightsConfirmed: false,
  };
}

export function parseLocalReplaceDraft(value: unknown): LocalReplaceDraft {
  return parse(draftSchema, value);
}

export function parseLocalReplaceDraftSaveRequest(value: unknown): LocalReplaceDraftSaveRequest {
  return parse(saveSchema, value);
}

export function parseLocalReplaceTaskCreateRequest(value: unknown): LocalReplaceTaskCreateRequest {
  return parse(createSchema, value);
}

export function parseLocalReplaceSourceProbe(value: unknown): LocalReplaceSourceProbe {
  return parse(probeSchema, value);
}

function validateRange(startMs: number, endMs: number): void {
  if (endMs - startMs < minRangeMs) fail('替换区间', '至少选择 0.1 秒');
}

export function validateLocalReplaceForRender(draft: LocalReplaceDraft): void {
  if (!draft.source || !draft.target) fail('局部替换', '请先选择原片和目标图片');
  if (!draft.sourceRightsConfirmed) fail('局部替换', '请先确认原片使用权限');
  if (!draft.objectDescription) fail('局部替换', '请说明原片中要替换的对象');
  validateRange(draft.startMs, draft.endMs);
}

export function parseLocalReplaceWorkerInput(value: unknown): LocalReplaceWorkerInput {
  const input = parse<LocalReplaceWorkerInput>(FISSION_LOCAL_REPLACE_WORKER_INPUT_SCHEMA, value);
  validateRange(input.startMs, input.endMs);
  return input;
}
