import { CLONE_UUID_PATTERN } from './fission-clone';
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
import { AVATAR_SYNC_LIMITS, type AvatarArtifactRef } from './fission-avatar-sync';
import {
  AVATAR_LONG_LIMITS,
  AVATAR_LONG_SEAMS_SCHEMA,
  validateAvatarLongSeams,
} from './fission-avatar-long-sync';

export const AVATAR_COMPOSITION_NODE = 'AVATAR_COMPOSITION';
export const AVATAR_OUTPUT_NODE = 'AVATAR_OUTPUT';
export const AVATAR_COMPOSITION_ARTIFACT_KEY = 'avatar-composition';
export const AVATAR_OUTPUT_ARTIFACT_KEY = 'avatar-output';
export const AVATAR_RENDER_QUEUE = 'fission.avatar.render.requested';

export const AVATAR_RENDER_LIMITS = {
  width: 1080,
  height: 1920,
  maxDurationMs: AVATAR_SYNC_LIMITS.maxDurationMs,
  maxBackgroundBytes: 12 * 1024 * 1024,
  maxVideoBytes: 96 * 1024 * 1024,
  maxSubtitlesBytes: 16 * 1024,
  maxCaptionCount: 32,
  maxCaptionCharacters: 60,
  minInsetPercent: 5,
  maxInsetPercent: 25,
  minReviewCoveragePermille: 950,
  minReviewConfidencePermille: 800,
  maxReviewOffsetMs: 100,
} as const;

export const AVATAR_CAPTION_MODES = ['OFF', 'SIDECAR', 'BURN', 'BOTH'] as const;
export const AVATAR_RENDER_STATUSES = [
  'QUEUED',
  'RUNNING',
  'AWAITING_REVIEW',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export const AVATAR_RENDER_ACTIVE_PHASES = ['ENCODING', 'VALIDATING'] as const;
export const AVATAR_RENDER_PHASES = [
  'QUEUED',
  ...AVATAR_RENDER_ACTIVE_PHASES,
  'REVIEW',
  'COMPLETE',
] as const;
export const AVATAR_RENDER_FAILURE_CODES = [
  'MEDIA_INVALID',
  'RENDER_FAILED',
  'INTERNAL_API_FAILED',
  'INVALID_TASK',
] as const;

export type AvatarCaptionCue = { startMs: number; endMs: number; text: string };
export type AvatarCompositionSettings = {
  background:
    { kind: 'SOLID'; color: string } | { kind: 'IMAGE'; assetId: string; version: number };
  insetPercent: number;
  captionMode: (typeof AVATAR_CAPTION_MODES)[number];
  captions: AvatarCaptionCue[];
};
export type AvatarCompositionDraft = {
  revision: number;
  sync: AvatarArtifactRef;
  settings: AvatarCompositionSettings;
};
export type AvatarCompositionDraftRequest = Omit<AvatarCompositionDraft, 'revision'> & {
  expectedRevision: number;
};
export type AvatarCompositionConfirmRequest = { expectedRevision: number };
export type AvatarCompositionResult = AvatarArtifactRef &
  Omit<AvatarCompositionDraft, 'revision'> & { stale: boolean };
export type AvatarRenderCreateRequest = { idempotencyKey: string; composition: AvatarArtifactRef };
export type AvatarRenderTask = {
  id: string;
  status: (typeof AVATAR_RENDER_STATUSES)[number];
  phase: (typeof AVATAR_RENDER_PHASES)[number];
  progress: number;
  message: string;
  canRetry: boolean;
  canCancel: boolean;
  stale: boolean;
};
export type AvatarRenderArchiveReceipt = { assetId: string; version: number };
export type AvatarRenderOutput = AvatarArtifactRef & {
  durationMs: number;
  stale: boolean;
  videoUrl: string | null;
  subtitlesUrl: string | null;
  archive: AvatarRenderArchiveReceipt | null;
};
export type AvatarRenderWorkspace = {
  projectId: string;
  workflowRunId: string;
  enabled: boolean;
  canRender: boolean;
  blockedReason: string | null;
  draft: AvatarCompositionDraft | null;
  composition: AvatarCompositionResult | null;
  source:
    | (AvatarArtifactRef & {
        durationMs: number;
        captions: AvatarCaptionCue[];
        seamTimesMs?: number[];
      })
    | null;
  backgrounds: { assetId: string; version: number; name: string; previewUrl: string | null }[];
  task: AvatarRenderTask | null;
  output: AvatarRenderOutput | null;
};
type ShortAvatarRenderWorkerInput = {
  schemaVersion: 1;
  settings: AvatarCompositionSettings;
  videoSizeBytes: number;
  audioSizeBytes: number;
  backgroundSizeBytes: number | null;
  audioDurationMs: number;
  videoDurationMs: number;
};
type LongAvatarRenderWorkerInput = Omit<ShortAvatarRenderWorkerInput, 'schemaVersion'> & {
  schemaVersion: 2;
  seamTimesMs: number[];
};
export type AvatarRenderWorkerInput = ShortAvatarRenderWorkerInput | LongAvatarRenderWorkerInput;
export type AvatarRenderClaim =
  | { status: 'BUSY' | 'INACTIVE' }
  | { status: 'CLAIMED'; attemptToken: string; input: AvatarRenderWorkerInput };
export type AvatarRenderHeartbeat = {
  phase: (typeof AVATAR_RENDER_ACTIVE_PHASES)[number];
  progress: number;
};
export type AvatarRenderFailure = {
  code: (typeof AVATAR_RENDER_FAILURE_CODES)[number];
  retryable: boolean;
};
type ShortAvatarRenderCompletion = {
  audioDurationMs: number;
  videoDurationMs: number;
  audioLagMs: number;
  minimumAudioCorrelationPermille: number;
};
type LongAvatarRenderCompletion = ShortAvatarRenderCompletion & {
  schemaVersion: 2;
  seamTimesMs: number[];
};
export type AvatarRenderCompletion = ShortAvatarRenderCompletion | LongAvatarRenderCompletion;
export type AvatarRenderReview = {
  sha256: string;
  method: string;
  coveragePermille: number;
  confidencePermille: number;
  maxAbsOffsetMs: number;
  evidence?: { durationMs: number; seamTimesMs: number[]; accuracyPermille: number };
};

const limits = AVATAR_RENDER_LIMITS;
const maxRevision = 2_147_483_647;
const revision = integer(1, maxRevision);
const uuid = { type: 'string', pattern: CLONE_UUID_PATTERN };
const artifactRef = object({ artifactId: uuid, revision });
const duration = integer(1, limits.maxDurationMs);
const compositionShape = (maxDurationMs: number, maxCaptionCount: number) =>
  object({
    background: {
      oneOf: [
        object({
          kind: { const: 'SOLID' },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        }),
        object({ kind: { const: 'IMAGE' }, assetId: uuid, version: revision }),
      ],
    },
    insetPercent: integer(limits.minInsetPercent, limits.maxInsetPercent),
    captionMode: enumeration(...AVATAR_CAPTION_MODES),
    captions: array(
      object({
        startMs: integer(0, maxDurationMs - 1),
        endMs: integer(1, maxDurationMs),
        text: { ...text(limits.maxCaptionCharacters), minLength: 1 },
      }),
      maxCaptionCount,
    ),
  });
const settingsShape = compositionShape(limits.maxDurationMs, limits.maxCaptionCount);
const longSettingsShape = compositionShape(
  AVATAR_LONG_LIMITS.maxDurationMs,
  AVATAR_LONG_LIMITS.maxCaptionCount,
);
const draftShape = (settings: typeof settingsShape) =>
  object({
    expectedRevision: integer(0, maxRevision),
    sync: artifactRef,
    settings,
  });
const confirmShape = object({ expectedRevision: revision });
const createShape = object({ idempotencyKey: uuid, composition: artifactRef });
const heartbeatShape = object({
  phase: enumeration(...AVATAR_RENDER_ACTIVE_PHASES),
  progress: integer(1, 99),
});
const failureShape = object({
  code: enumeration(...AVATAR_RENDER_FAILURE_CODES),
  retryable: { type: 'boolean' },
});
const reviewShape = object({
  sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  method: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
  coveragePermille: integer(0, 1000),
  confidencePermille: integer(0, 1000),
  maxAbsOffsetMs: integer(0, limits.maxDurationMs),
});
const longVideoDuration = integer(
  AVATAR_LONG_LIMITS.minDurationMs,
  AVATAR_LONG_LIMITS.maxDurationMs,
);
const longAudioDuration = integer(
  AVATAR_LONG_LIMITS.minDurationMs - AVATAR_SYNC_LIMITS.maxAudioLagMs,
  AVATAR_LONG_LIMITS.maxDurationMs,
);
const longReviewShape = object({
  ...reviewShape.properties!,
  maxAbsOffsetMs: integer(0, AVATAR_LONG_LIMITS.maxDurationMs),
  evidence: object({
    durationMs: longVideoDuration,
    seamTimesMs: AVATAR_LONG_SEAMS_SCHEMA,
    accuracyPermille: integer(0, 1000),
  }),
});

export const FISSION_AVATAR_RENDER_WORKER_INPUT_SCHEMA = published(
  'fission-avatar-render-worker-input.schema.json',
  object({
    schemaVersion: { const: 1 },
    settings: settingsShape,
    videoSizeBytes: integer(1, AVATAR_SYNC_LIMITS.maxVideoBytes),
    audioSizeBytes: integer(1, AVATAR_SYNC_LIMITS.maxAudioBytes),
    backgroundSizeBytes: nullable(integer(1, limits.maxBackgroundBytes)),
    audioDurationMs: duration,
    videoDurationMs: duration,
  }),
);
export const FISSION_AVATAR_RENDER_COMPLETION_SCHEMA = published(
  'fission-avatar-render-completion.schema.json',
  object({
    audioDurationMs: duration,
    videoDurationMs: duration,
    audioLagMs: integer(-AVATAR_SYNC_LIMITS.maxAudioLagMs, AVATAR_SYNC_LIMITS.maxAudioLagMs),
    minimumAudioCorrelationPermille: integer(AVATAR_SYNC_LIMITS.minAudioCorrelationPermille, 1000),
  }),
);
export const FISSION_AVATAR_LONG_RENDER_WORKER_INPUT_SCHEMA = published(
  'fission-avatar-long-render-worker-input.schema.json',
  object({
    ...FISSION_AVATAR_RENDER_WORKER_INPUT_SCHEMA.properties!,
    schemaVersion: { const: 2 },
    settings: longSettingsShape,
    videoSizeBytes: integer(1, AVATAR_LONG_LIMITS.maxVideoBytes),
    audioSizeBytes: integer(1, AVATAR_LONG_LIMITS.maxAudioBytes),
    audioDurationMs: longAudioDuration,
    videoDurationMs: longVideoDuration,
    seamTimesMs: AVATAR_LONG_SEAMS_SCHEMA,
  }),
);
export const FISSION_AVATAR_LONG_RENDER_COMPLETION_SCHEMA = published(
  'fission-avatar-long-render-completion.schema.json',
  object({
    ...FISSION_AVATAR_RENDER_COMPLETION_SCHEMA.properties!,
    schemaVersion: { const: 2 },
    audioDurationMs: longAudioDuration,
    videoDurationMs: longVideoDuration,
    seamTimesMs: AVATAR_LONG_SEAMS_SCHEMA,
  }),
);

function validateComposition<T extends AvatarCompositionSettings>(settings: T): T {
  let previousEnd = 0;
  for (const cue of settings.captions) {
    if (cue.startMs < previousEnd || cue.startMs >= cue.endMs) {
      fail('字幕', '时间须顺序排列且不能重叠');
    }
    const lines = cue.text.split('\n');
    if (
      lines.length > 2 ||
      lines.some((line) => !line.trim() || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(line))
    ) {
      fail('字幕', '每条须包含一到两行有效文字');
    }
    previousEnd = cue.endMs;
  }
  if (settings.background.kind === 'SOLID') {
    settings.background.color = settings.background.color.toUpperCase();
  }
  return settings;
}

export function parseAvatarCompositionSettings(
  value: unknown,
  long = false,
): AvatarCompositionSettings {
  return validateComposition(
    parse<AvatarCompositionSettings>(long ? longSettingsShape : settingsShape, value),
  );
}

export function parseAvatarCompositionDraftRequest(
  value: unknown,
  long = false,
): AvatarCompositionDraftRequest {
  const draft = parse<AvatarCompositionDraftRequest>(
    draftShape(long ? longSettingsShape : settingsShape),
    value,
  );
  validateComposition(draft.settings);
  return draft;
}

export function parseAvatarCompositionConfirmRequest(
  value: unknown,
): AvatarCompositionConfirmRequest {
  return parse(confirmShape, value);
}

export function parseAvatarRenderCreateRequest(value: unknown): AvatarRenderCreateRequest {
  return parse(createShape, value);
}

export function parseAvatarRenderHeartbeat(value: unknown): AvatarRenderHeartbeat {
  return parse(heartbeatShape, value);
}

export function parseAvatarRenderFailure(value: unknown): AvatarRenderFailure {
  return parse(failureShape, value);
}

export function parseAvatarRenderWorkerInput(value: unknown): AvatarRenderWorkerInput {
  const input = parse<AvatarRenderWorkerInput>(
    {
      oneOf: [
        FISSION_AVATAR_RENDER_WORKER_INPUT_SCHEMA,
        FISSION_AVATAR_LONG_RENDER_WORKER_INPUT_SCHEMA,
      ],
    },
    value,
  );
  validateComposition(input.settings);
  const image = input.settings.background.kind === 'IMAGE';
  if (image !== (input.backgroundSizeBytes !== null)) fail('背景', '文件大小与背景类型不匹配');
  if (input.settings.captionMode !== 'OFF' && input.settings.captions.length === 0) {
    fail('字幕', '启用字幕时至少需要一条有效字幕');
  }
  if (input.settings.captions.some((cue) => cue.endMs > input.audioDurationMs)) {
    fail('字幕', '字幕结束时间超过已确认的音轨时长');
  }
  validateDurations(input);
  if (input.schemaVersion === 2) validateAvatarLongSeams(input.seamTimesMs, input.videoDurationMs);
  return input;
}

function validateDurations(
  media: Pick<AvatarRenderCompletion, 'audioDurationMs' | 'videoDurationMs'>,
) {
  if (Math.abs(media.audioDurationMs - media.videoDurationMs) > AVATAR_SYNC_LIMITS.maxAudioLagMs) {
    fail('媒体', '音轨与画面时长差超过限制');
  }
}

export function parseAvatarRenderCompletion(value: unknown): AvatarRenderCompletion {
  const output = parse<AvatarRenderCompletion>(
    {
      oneOf: [
        FISSION_AVATAR_RENDER_COMPLETION_SCHEMA,
        FISSION_AVATAR_LONG_RENDER_COMPLETION_SCHEMA,
      ],
    },
    value,
  );
  validateDurations(output);
  if (isAvatarLongRenderCompletion(output))
    validateAvatarLongSeams(output.seamTimesMs, output.videoDurationMs);
  return output;
}

export function isAvatarLongRenderCompletion(
  output: AvatarRenderCompletion,
): output is LongAvatarRenderCompletion {
  return 'schemaVersion' in output && output.schemaVersion === 2;
}

export function parseAvatarRenderReview(value: unknown): AvatarRenderReview {
  const review = parse<AvatarRenderReview>({ oneOf: [reviewShape, longReviewShape] }, value);
  if (review.evidence)
    validateAvatarLongSeams(review.evidence.seamTimesMs, review.evidence.durationMs);
  return review;
}

export function avatarRenderReviewPasses(review: AvatarRenderReview): boolean {
  return (
    review.coveragePermille >= limits.minReviewCoveragePermille &&
    review.confidencePermille >= limits.minReviewConfidencePermille &&
    review.maxAbsOffsetMs <= limits.maxReviewOffsetMs &&
    (!review.evidence || review.evidence.accuracyPermille >= 950)
  );
}
