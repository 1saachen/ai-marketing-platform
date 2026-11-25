import {
  array,
  fail,
  integer,
  nullable,
  object,
  parse,
  published,
  text,
} from './fission-clone-schema';

export const AVATAR_NATIVE_MODEL = 'doubao-seedance-2-5-flash-261115';
export const AVATAR_NATIVE_SYNC_QUEUE = 'fission.avatar.native-sync.requested';
export const AVATAR_NATIVE_PORTRAIT_ID_PATTERN = '^asset-[A-Za-z0-9_-]{1,120}$';
export const AVATAR_NATIVE_TASK_ID_PATTERN = '^cgt-[A-Za-z0-9_-]{1,120}$';
export const AVATAR_NATIVE_LIMITS = {
  minDurationSeconds: 4,
  maxDurationSeconds: 30,
  durationToleranceMs: 100,
  maxPromptCharacters: 500,
  maxImageBytes: 8 * 1024 * 1024,
  minReferenceAudioSeconds: 2,
  maxReferenceAudioSeconds: 30,
  maxReferenceAudioBytes: 15 * 1024 * 1024,
} as const;

export type AvatarNativeImage =
  | {
      kind: 'BYTES';
      mimeType: 'image/png' | 'image/jpeg';
      sizeBytes: number;
      sha256: string | null;
    }
  | { kind: 'PORTRAIT'; assetId: string };

export type AvatarNativeReferenceAudio = {
  mimeType: 'audio/mpeg' | 'audio/wav';
  sizeBytes: number;
  sha256: string | null;
};

export type AvatarNativeWorkerInput = {
  schemaVersion: 4;
  prompt: string;
  model: typeof AVATAR_NATIVE_MODEL;
  durationSeconds: number;
  image: AvatarNativeImage;
  referenceAudio?: AvatarNativeReferenceAudio;
  nativeStarted: boolean;
  nativeTaskId: string | null;
};

export type AvatarNativeCheckpoint =
  { kind: 'NATIVE_STARTED' } | { kind: 'NATIVE_ACCEPTED'; providerTaskId: string };

export type AvatarNativeCompletion = {
  schemaVersion: 4;
  audioDurationMs: number;
  videoDurationMs: number;
  wordTimings: [];
};

const limits = AVATAR_NATIVE_LIMITS;
const taskId = { type: 'string', pattern: AVATAR_NATIVE_TASK_ID_PATTERN };
const sha256 = nullable({ type: 'string', pattern: '^[a-f0-9]{64}$' });
const durationMs = integer(
  limits.minDurationSeconds * 1000 - limits.durationToleranceMs,
  limits.maxDurationSeconds * 1000,
);
export const FISSION_AVATAR_NATIVE_WORKER_INPUT_SCHEMA = published(
  'fission-avatar-native-worker-input.schema.json',
  {
    ...object({
      schemaVersion: { const: 4 },
      prompt: { ...text(limits.maxPromptCharacters), minLength: 1 },
      model: { const: AVATAR_NATIVE_MODEL },
      durationSeconds: integer(limits.minDurationSeconds, limits.maxDurationSeconds),
      image: {
        oneOf: [
          object({
            kind: { const: 'BYTES' },
            mimeType: { type: 'string', enum: ['image/png', 'image/jpeg'] },
            sizeBytes: integer(1, limits.maxImageBytes),
            sha256,
          }),
          object({
            kind: { const: 'PORTRAIT' },
            assetId: { type: 'string', pattern: AVATAR_NATIVE_PORTRAIT_ID_PATTERN },
          }),
        ],
      },
      referenceAudio: object({
        mimeType: { type: 'string', enum: ['audio/mpeg', 'audio/wav'] },
        sizeBytes: integer(1, limits.maxReferenceAudioBytes),
        sha256,
      }),
      nativeStarted: { type: 'boolean' },
      nativeTaskId: nullable(taskId),
    }),
    required: [
      'schemaVersion',
      'prompt',
      'model',
      'durationSeconds',
      'image',
      'nativeStarted',
      'nativeTaskId',
    ],
  },
);
export const FISSION_AVATAR_NATIVE_CHECKPOINT_SCHEMA = published(
  'fission-avatar-native-checkpoint.schema.json',
  {
    oneOf: [
      object({ kind: { const: 'NATIVE_STARTED' } }),
      object({ kind: { const: 'NATIVE_ACCEPTED' }, providerTaskId: taskId }),
    ],
  },
);
export const FISSION_AVATAR_NATIVE_COMPLETION_SCHEMA = published(
  'fission-avatar-native-completion.schema.json',
  object({
    schemaVersion: { const: 4 },
    audioDurationMs: durationMs,
    videoDurationMs: durationMs,
    wordTimings: array({}, 0),
  }),
);

export function parseAvatarNativeWorkerInput(value: unknown): AvatarNativeWorkerInput {
  const input = parse<AvatarNativeWorkerInput>(FISSION_AVATAR_NATIVE_WORKER_INPUT_SCHEMA, value);
  if (input.nativeTaskId && !input.nativeStarted) fail('原生口播', '画面任务未登记提交');
  return input;
}

export function parseAvatarNativeCheckpoint(value: unknown): AvatarNativeCheckpoint {
  return parse(FISSION_AVATAR_NATIVE_CHECKPOINT_SCHEMA, value);
}

export function parseAvatarNativeCompletion(value: unknown): AvatarNativeCompletion {
  const media = parse<AvatarNativeCompletion>(FISSION_AVATAR_NATIVE_COMPLETION_SCHEMA, value);
  if (Math.abs(media.videoDurationMs - media.audioDurationMs) > limits.durationToleranceMs)
    fail('原生口播', '音画文件时长差超过允许范围');
  return media;
}

export function isAvatarNativeSyncMedia(media: object): media is AvatarNativeCompletion {
  return 'schemaVersion' in media && media.schemaVersion === 4;
}
