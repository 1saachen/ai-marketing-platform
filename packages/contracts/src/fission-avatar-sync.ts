import { CLONE_UUID_PATTERN } from './fission-clone';
import type { AvatarLongSyncWorkerInput } from './fission-avatar-long-sync';
import { AVATAR_NATIVE_LIMITS, type AvatarNativeWorkerInput } from './fission-avatar-native';
import type { AvatarTailChainWorkerInput } from './fission-avatar-tail-chain';
import {
  array,
  enumeration,
  fail,
  integer,
  nullable,
  object,
  parse,
  published,
  text,
} from './fission-clone-schema';

export const AVATAR_SYNC_NODE = 'AVATAR_LIP_SYNC';
export const AVATAR_SYNC_ARTIFACT_KEY = 'avatar-sync';
export const AVATAR_SYNC_QUEUE = 'fission.avatar.sync.requested';
export const AVATAR_SYNC_LIMITS = {
  maxScriptCharacters: 120,
  maxDurationMs: 30_000,
  maxCharacterBytes: 64 * 1024 * 1024,
  maxVideoBytes: 64 * 1024 * 1024,
  maxAudioBytes: 8 * 1024 * 1024,
  maxAudioLagMs: 100,
  minAudioCorrelationPermille: 980,
} as const;

export const AVATAR_SYNC_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export const AVATAR_SYNC_ACTIVE_PHASES = ['TTS', 'LIP_SYNC', 'VALIDATING'] as const;
export const AVATAR_SYNC_PHASES = ['QUEUED', ...AVATAR_SYNC_ACTIVE_PHASES, 'COMPLETE'] as const;
export const AVATAR_SYNC_FAILURE_CODES = [
  'MEDIA_INVALID',
  'PROVIDER_REJECTED',
  'PROVIDER_FAILED',
  'PROVIDER_CREATION_UNKNOWN',
  'INTERNAL_API_FAILED',
  'INVALID_TASK',
] as const;
export const AVATAR_SYNC_PRESET_SPEAKER_PATTERN = '^zh_[a-z0-9_]{1,80}_uranus_bigtts$';
const PROVIDER_TASK_ID_PATTERN = '^amk-tool-lip-sync-[A-Za-z0-9_-]{1,120}$';

type AvatarSyncTaskStatus = (typeof AVATAR_SYNC_STATUSES)[number];
type AvatarSyncPhase = (typeof AVATAR_SYNC_PHASES)[number];
export type AvatarSyncActivePhase = (typeof AVATAR_SYNC_ACTIVE_PHASES)[number];
export type AvatarSyncFailureCode = (typeof AVATAR_SYNC_FAILURE_CODES)[number];

export type AvatarArtifactRef = { artifactId: string; revision: number };
type AvatarSyncCreateSource = {
  idempotencyKey: string;
  expectedDraftRevision: number;
  binding: AvatarArtifactRef;
  script: AvatarArtifactRef;
};
export type AvatarSyncCreateRequest = AvatarSyncCreateSource &
  (
    | { mode?: 'SEGMENTED'; durationSeconds?: undefined }
    | { mode: 'NATIVE'; durationSeconds: number }
  );
export type AvatarSyncWordTiming = {
  text: string;
  startMs: number;
  endMs: number;
  confidencePermille: number | null;
};
export type AvatarSyncTask = {
  id: string;
  status: AvatarSyncTaskStatus;
  phase: AvatarSyncPhase;
  progress: number;
  message: string;
  canRetry: boolean;
  canCancel: boolean;
  stale: boolean;
  mode?: 'SEGMENTED' | 'NATIVE';
  segments?: {
    total: number;
    completed: number;
    activeOrdinal: number | null;
    failedOrdinal: number | null;
  };
};
export type AvatarSyncResult = {
  artifactId: string;
  revision: number;
  stale: boolean;
  durationMs: number;
  audioUrl: string | null;
  videoUrl: string | null;
  wordTimings: AvatarSyncWordTiming[];
  mode?: 'NATIVE';
};
export type AvatarSyncWorkspace = {
  projectId: string;
  workflowRunId: string;
  enabled: boolean;
  canGenerate: boolean;
  blockedReason: string | null;
  long?: { enabled: boolean; canGenerate: boolean; blockedReason: string | null };
  native?: { enabled: boolean; canGenerate: boolean; blockedReason: string | null };
  task: AvatarSyncTask | null;
  result: AvatarSyncResult | null;
};

export type AvatarSyncWorkerInput = {
  schemaVersion: 1;
  scriptText: string;
  voiceSpeaker: string;
  characterSizeBytes: number;
  ttsOperationId: string;
  ttsStarted: boolean;
  lipSyncClientToken: string;
  lipSyncStarted: boolean;
  lipSyncTaskId: string | null;
};
export type AvatarSyncClaim =
  | { status: 'BUSY' | 'INACTIVE' }
  | {
      status: 'CLAIMED';
      attemptToken: string;
      input:
        | AvatarSyncWorkerInput
        | AvatarLongSyncWorkerInput
        | AvatarTailChainWorkerInput
        | AvatarNativeWorkerInput;
    };
export type AvatarSyncHeartbeat = { phase: AvatarSyncActivePhase; progress: number };
export type AvatarSyncCheckpoint =
  | { kind: 'TTS_SUBMIT' | 'LIP_SYNC_SUBMIT' }
  | { kind: 'LIP_SYNC_ACCEPTED'; providerTaskId: string };
export type AvatarSyncCompletion = {
  audioDurationMs: number;
  videoDurationMs: number;
  audioLagMs: number;
  minimumAudioCorrelationPermille: number;
  wordTimings: AvatarSyncWordTiming[];
};
export type AvatarSyncFailure = { code: AvatarSyncFailureCode; retryable: boolean };

const maxRevision = 2_147_483_647;
const uuid = { type: 'string', pattern: CLONE_UUID_PATTERN };
const boolean = { type: 'boolean' };
const refs = object({ artifactId: uuid, revision: integer(1, maxRevision) });
const providerTask = { type: 'string', pattern: PROVIDER_TASK_ID_PATTERN };
const { maxDurationMs, maxAudioLagMs, minAudioCorrelationPermille } = AVATAR_SYNC_LIMITS;
const timing = object({
  text: { ...text(80), minLength: 1 },
  startMs: integer(0, maxDurationMs - 1),
  endMs: integer(1, maxDurationMs),
  confidencePermille: nullable(integer(0, 1000)),
});

const createSchema = object({
  idempotencyKey: uuid,
  expectedDraftRevision: integer(0, maxRevision),
  binding: refs,
  script: refs,
});
const segmentedCreateSchema = object({ ...createSchema.properties!, mode: { const: 'SEGMENTED' } });
const nativeCreateSchema = object({
  ...createSchema.properties!,
  mode: { const: 'NATIVE' },
  durationSeconds: integer(
    AVATAR_NATIVE_LIMITS.minDurationSeconds,
    AVATAR_NATIVE_LIMITS.maxDurationSeconds,
  ),
});

const heartbeatSchema = object({
  phase: enumeration(...AVATAR_SYNC_ACTIVE_PHASES),
  progress: integer(0, 99),
});

const failureSchema = object({
  code: enumeration(...AVATAR_SYNC_FAILURE_CODES),
  retryable: boolean,
});

export const FISSION_AVATAR_SYNC_WORKER_INPUT_SCHEMA = published(
  'fission-avatar-sync-worker-input.schema.json',
  object({
    schemaVersion: { const: 1 },
    scriptText: { ...text(AVATAR_SYNC_LIMITS.maxScriptCharacters), minLength: 1 },
    voiceSpeaker: { type: 'string', pattern: AVATAR_SYNC_PRESET_SPEAKER_PATTERN },
    characterSizeBytes: integer(1, AVATAR_SYNC_LIMITS.maxCharacterBytes),
    ttsOperationId: uuid,
    ttsStarted: boolean,
    lipSyncClientToken: uuid,
    lipSyncStarted: boolean,
    lipSyncTaskId: nullable(providerTask),
  }),
);

export const FISSION_AVATAR_SYNC_CHECKPOINT_SCHEMA = published(
  'fission-avatar-sync-checkpoint.schema.json',
  {
    oneOf: [
      object({ kind: enumeration('TTS_SUBMIT', 'LIP_SYNC_SUBMIT') }),
      object({ kind: { const: 'LIP_SYNC_ACCEPTED' }, providerTaskId: providerTask }),
    ],
  },
);

export const FISSION_AVATAR_SYNC_COMPLETION_SCHEMA = published(
  'fission-avatar-sync-completion.schema.json',
  object({
    audioDurationMs: integer(1, maxDurationMs),
    videoDurationMs: integer(1, maxDurationMs),
    audioLagMs: integer(-maxAudioLagMs, maxAudioLagMs),
    minimumAudioCorrelationPermille: integer(minAudioCorrelationPermille, 1000),
    wordTimings: array(timing, 240, 1),
  }),
);

export function parseAvatarSyncCreateRequest(value: unknown): AvatarSyncCreateRequest {
  return parse({ oneOf: [createSchema, segmentedCreateSchema, nativeCreateSchema] }, value);
}

export function parseAvatarSyncHeartbeat(value: unknown): AvatarSyncHeartbeat {
  return parse(heartbeatSchema, value);
}

export function parseAvatarSyncCheckpoint(value: unknown): AvatarSyncCheckpoint {
  return parse(FISSION_AVATAR_SYNC_CHECKPOINT_SCHEMA, value);
}

export function parseAvatarSyncFailure(value: unknown): AvatarSyncFailure {
  return parse(failureSchema, value);
}

export function parseAvatarSyncWorkerInput(value: unknown): AvatarSyncWorkerInput {
  const input = parse<AvatarSyncWorkerInput>(FISSION_AVATAR_SYNC_WORKER_INPUT_SCHEMA, value);
  if ((input.lipSyncStarted && !input.ttsStarted) || (input.lipSyncTaskId && !input.lipSyncStarted))
    fail('同步任务', '供应商执行记录不一致');
  return input;
}

export function parseAvatarSyncCompletion(value: unknown): AvatarSyncCompletion {
  const result = parse<AvatarSyncCompletion>(FISSION_AVATAR_SYNC_COMPLETION_SCHEMA, value);
  if (Math.abs(result.audioDurationMs - result.videoDurationMs) > maxAudioLagMs)
    fail('同步结果', '音画文件时长差超过允许范围');
  let previousStart = -1;
  for (const word of result.wordTimings) {
    if (
      word.startMs < previousStart ||
      word.endMs <= word.startMs ||
      word.endMs > result.audioDurationMs
    )
      fail('同步结果', '字级时间戳超出音轨范围或顺序无效');
    previousStart = word.startMs;
  }
  return result;
}
