import { CLONE_UUID_PATTERN } from './fission-clone';
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
import { AVATAR_LONG_LIMITS, type AvatarLongSyncSegmentResult } from './fission-avatar-long-sync';
import {
  AVATAR_SYNC_LIMITS,
  AVATAR_SYNC_PRESET_SPEAKER_PATTERN,
  FISSION_AVATAR_SYNC_COMPLETION_SCHEMA,
  parseAvatarSyncCompletion,
} from './fission-avatar-sync';

export const AVATAR_TAIL_CHAIN_MODEL = 'doubao-seedance-2-0-fast-260128';
export const AVATAR_TAIL_CHAIN_TASK_ID_PATTERN = '^cgt-[A-Za-z0-9_-]{1,120}$';
export const AVATAR_TAIL_CHAIN_LIMITS = {
  sampleRateHz: 24_000,
  minSegmentSeconds: 4,
  maxSegmentSeconds: 15,
  minSegments: 5,
  maxSegments: AVATAR_LONG_LIMITS.maxSegments,
} as const;

export type AvatarTailChainPlan = {
  masterSha256: string;
  sourceSamples: number;
  segments: {
    sourceStartSample: number;
    sourceEndSample: number;
    leadingSilenceSamples: number;
    durationSeconds: number;
  }[];
};

export type AvatarTailChainSegment = {
  ordinal: number;
  pictureStarted: boolean;
  pictureTaskId: string | null;
  lipSyncClientToken: string;
  lipSyncStarted: boolean;
  lipSyncTaskId: string | null;
  result: AvatarLongSyncSegmentResult | null;
};

export type AvatarTailChainWorkerInput = {
  schemaVersion: 3;
  voiceSpeaker: string;
  scriptText: string;
  sourceTaskId: string;
  model: typeof AVATAR_TAIL_CHAIN_MODEL;
  ttsOperationId: string;
  ttsStarted: boolean;
  plan: AvatarTailChainPlan | null;
  segments: AvatarTailChainSegment[];
};

export type AvatarTailChainCheckpoint =
  | { kind: 'TTS_STARTED' }
  | { kind: 'PLAN_READY'; plan: AvatarTailChainPlan }
  | { kind: 'PICTURE_STARTED'; ordinal: number }
  | { kind: 'PICTURE_ACCEPTED'; ordinal: number; providerTaskId: string };

const limits = AVATAR_TAIL_CHAIN_LIMITS;
const maxSamples = (AVATAR_LONG_LIMITS.maxDurationMs / 1000) * limits.sampleRateHz;
const sha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const arkTaskId = { type: 'string', pattern: AVATAR_TAIL_CHAIN_TASK_ID_PATTERN };
const uuid = { type: 'string', pattern: CLONE_UUID_PATTERN };
const boolean = { type: 'boolean' };
const ordinal = integer(1, limits.maxSegments);
const file = (maxBytes: number) => object({ sizeBytes: integer(1, maxBytes), sha256 });
const planSchema = object({
  masterSha256: sha256,
  sourceSamples: integer(1, maxSamples),
  segments: array(
    object({
      sourceStartSample: integer(0, maxSamples - 1),
      sourceEndSample: integer(1, maxSamples),
      leadingSilenceSamples: integer(0, limits.sampleRateHz - 1),
      durationSeconds: integer(limits.minSegmentSeconds, limits.maxSegmentSeconds),
    }),
    limits.maxSegments,
    limits.minSegments,
  ),
});

export const FISSION_AVATAR_TAIL_CHAIN_WORKER_INPUT_SCHEMA = published(
  'fission-avatar-tail-chain-worker-input.schema.json',
  object({
    schemaVersion: { const: 3 },
    voiceSpeaker: { type: 'string', pattern: AVATAR_SYNC_PRESET_SPEAKER_PATTERN },
    scriptText: {
      ...text(AVATAR_LONG_LIMITS.maxSegments * AVATAR_LONG_LIMITS.maxSegmentCharacters),
      minLength: 1,
    },
    sourceTaskId: arkTaskId,
    model: { const: AVATAR_TAIL_CHAIN_MODEL },
    ttsOperationId: uuid,
    ttsStarted: boolean,
    plan: nullable(planSchema),
    segments: array(
      object({
        ordinal,
        pictureStarted: boolean,
        pictureTaskId: nullable(arkTaskId),
        lipSyncClientToken: uuid,
        lipSyncStarted: boolean,
        lipSyncTaskId: nullable({
          type: 'string',
          pattern: '^amk-tool-lip-sync-[A-Za-z0-9_-]{1,120}$',
        }),
        result: nullable(
          object({
            media: object(FISSION_AVATAR_SYNC_COMPLETION_SCHEMA.properties!),
            audio: file(AVATAR_SYNC_LIMITS.maxAudioBytes),
            video: file(AVATAR_SYNC_LIMITS.maxVideoBytes),
          }),
        ),
      }),
      limits.maxSegments,
    ),
  }),
);

export const FISSION_AVATAR_TAIL_CHAIN_CHECKPOINT_SCHEMA = published(
  'fission-avatar-tail-chain-checkpoint.schema.json',
  {
    oneOf: [
      object({ kind: { const: 'TTS_STARTED' } }),
      object({ kind: { const: 'PLAN_READY' }, plan: planSchema }),
      object({ kind: { const: 'PICTURE_STARTED' }, ordinal }),
      object({ kind: { const: 'PICTURE_ACCEPTED' }, ordinal, providerTaskId: arkTaskId }),
    ],
  },
);

function validatePlan(plan: AvatarTailChainPlan) {
  let sourceEnd = 0;
  let totalMs = 0;
  for (const segment of plan.segments) {
    const sourceLength = segment.sourceEndSample - segment.sourceStartSample;
    const padding = segment.durationSeconds * limits.sampleRateHz - sourceLength;
    if (
      segment.sourceStartSample !== sourceEnd ||
      sourceLength <= 0 ||
      padding < segment.leadingSilenceSamples ||
      padding >= limits.sampleRateHz
    )
      fail('尾帧接续', '配音切片必须连续覆盖原音轨，单段补静音不足一秒');
    sourceEnd = segment.sourceEndSample;
    totalMs += segment.durationSeconds * 1000;
  }
  if (
    sourceEnd !== plan.sourceSamples ||
    totalMs < AVATAR_LONG_LIMITS.minDurationMs ||
    totalMs > AVATAR_LONG_LIMITS.maxDurationMs
  )
    fail('尾帧接续', '切片计划未覆盖原音轨或成片时长超出 61–90 秒');
}

export function parseAvatarTailChainPlan(value: unknown): AvatarTailChainPlan {
  const plan = parse<AvatarTailChainPlan>(planSchema, value);
  validatePlan(plan);
  return plan;
}

export function parseAvatarTailChainCheckpoint(value: unknown): AvatarTailChainCheckpoint {
  const checkpoint = parse<AvatarTailChainCheckpoint>(
    FISSION_AVATAR_TAIL_CHAIN_CHECKPOINT_SCHEMA,
    value,
  );
  if (checkpoint.kind === 'PLAN_READY') validatePlan(checkpoint.plan);
  return checkpoint;
}

export function parseAvatarTailChainWorkerInput(value: unknown): AvatarTailChainWorkerInput {
  const input = parse<AvatarTailChainWorkerInput>(
    FISSION_AVATAR_TAIL_CHAIN_WORKER_INPUT_SCHEMA,
    value,
  );
  if (!input.plan) {
    if (input.segments.length) fail('尾帧接续', '切片计划提交前不可建立口播分段');
    return input;
  }
  validatePlan(input.plan);
  if (!input.ttsStarted || input.segments.length !== input.plan.segments.length)
    fail('尾帧接续', '音频切片与分段状态不一致');
  const pictureIds = new Set([input.sourceTaskId]);
  const lipIds = new Set<string>();
  const operationIds = new Set([input.ttsOperationId]);
  let previousComplete = true;
  for (const [index, segment] of input.segments.entries()) {
    if (
      segment.ordinal !== index + 1 ||
      (segment.pictureStarted && !previousComplete) ||
      (segment.pictureTaskId && !segment.pictureStarted) ||
      (segment.lipSyncStarted && !segment.pictureTaskId) ||
      (segment.lipSyncTaskId && !segment.lipSyncStarted) ||
      (segment.result && !segment.lipSyncTaskId) ||
      operationIds.has(segment.lipSyncClientToken) ||
      (segment.pictureTaskId && pictureIds.has(segment.pictureTaskId)) ||
      (segment.lipSyncTaskId && lipIds.has(segment.lipSyncTaskId))
    )
      fail('尾帧接续', '分段顺序、提交状态或供应商回执无效');
    if (segment.pictureTaskId) pictureIds.add(segment.pictureTaskId);
    if (segment.lipSyncTaskId) lipIds.add(segment.lipSyncTaskId);
    operationIds.add(segment.lipSyncClientToken);
    if (segment.result) parseAvatarSyncCompletion(segment.result.media);
    previousComplete = !!segment.result;
  }
  return input;
}
