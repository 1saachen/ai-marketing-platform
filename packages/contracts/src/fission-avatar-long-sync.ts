import type { AvatarNativeCompletion } from './fission-avatar-native';
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
import {
  AVATAR_SYNC_LIMITS,
  AVATAR_SYNC_PRESET_SPEAKER_PATTERN,
  FISSION_AVATAR_SYNC_COMPLETION_SCHEMA,
  parseAvatarSyncCompletion,
  parseAvatarSyncWorkerInput,
  type AvatarSyncCompletion,
  type AvatarSyncWorkerInput,
} from './fission-avatar-sync';

export const AVATAR_LONG_SYNC_QUEUE = 'fission.avatar.long-sync.requested';
export const AVATAR_LONG_RENDER_QUEUE = 'fission.avatar.long-render.requested';
export const AVATAR_LONG_LIMITS = {
  minDurationMs: 61_000,
  maxDurationMs: 90_000,
  minSegments: 3,
  maxSegments: 12,
  maxSegmentCharacters: 60,
  maxVideoBytes: 128 * 1024 * 1024,
  maxAudioBytes: 16 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxWordTimings: 2880,
  maxCaptionCount: 120,
  maxSubtitlesBytes: 64 * 1024,
} as const;

type SegmentFile = { sizeBytes: number; sha256: string };
export type AvatarLongSyncSegmentResult = {
  media: AvatarSyncCompletion;
  audio: SegmentFile;
  video: SegmentFile;
};
export type AvatarLongSyncSegment = Omit<
  AvatarSyncWorkerInput,
  'schemaVersion' | 'voiceSpeaker' | 'characterSizeBytes'
> & { ordinal: number; result: AvatarLongSyncSegmentResult | null };
export type AvatarLongSyncWorkerInput = {
  schemaVersion: 2;
  voiceSpeaker: string;
  characterSizeBytes: number;
  segments: AvatarLongSyncSegment[];
};
export type AvatarLongSyncCompletion = AvatarSyncCompletion & {
  schemaVersion: 2;
  seamTimesMs: number[];
};
export type AvatarSyncMedia =
  AvatarSyncCompletion | AvatarLongSyncCompletion | AvatarNativeCompletion;
export type AvatarSpeechSegment = {
  ordinal: number;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  characters: number;
};

const limits = AVATAR_LONG_LIMITS;
const short = AVATAR_SYNC_LIMITS;
const uuid = { type: 'string', pattern: CLONE_UUID_PATTERN };
const boolean = { type: 'boolean' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const shortMediaShape = object(FISSION_AVATAR_SYNC_COMPLETION_SCHEMA.properties!);
const file = (maxBytes: number) => object({ sizeBytes: integer(1, maxBytes), sha256: digest });
export const AVATAR_LONG_SEAMS_SCHEMA = array(
  integer(1, limits.maxDurationMs - 1),
  limits.maxSegments - 1,
  limits.minSegments - 1,
);
export const FISSION_AVATAR_LONG_SYNC_WORKER_INPUT_SCHEMA = published(
  'fission-avatar-long-sync-worker-input.schema.json',
  object({
    schemaVersion: { const: 2 },
    voiceSpeaker: { type: 'string', pattern: AVATAR_SYNC_PRESET_SPEAKER_PATTERN },
    characterSizeBytes: integer(1, short.maxCharacterBytes),
    segments: array(
      object({
        ordinal: integer(1, limits.maxSegments),
        scriptText: { ...text(limits.maxSegmentCharacters), minLength: 1 },
        ttsOperationId: uuid,
        ttsStarted: boolean,
        lipSyncClientToken: uuid,
        lipSyncStarted: boolean,
        lipSyncTaskId: nullable({
          type: 'string',
          pattern: '^amk-tool-lip-sync-[A-Za-z0-9_-]{1,120}$',
        }),
        result: nullable(
          object({
            media: shortMediaShape,
            audio: file(short.maxAudioBytes),
            video: file(short.maxVideoBytes),
          }),
        ),
      }),
      limits.maxSegments,
      limits.minSegments,
    ),
  }),
);

export const FISSION_AVATAR_LONG_SYNC_COMPLETION_SCHEMA = published(
  'fission-avatar-long-sync-completion.schema.json',
  object({
    schemaVersion: { const: 2 },
    audioDurationMs: integer(limits.minDurationMs - short.maxAudioLagMs, limits.maxDurationMs),
    videoDurationMs: integer(limits.minDurationMs, limits.maxDurationMs),
    audioLagMs: integer(-short.maxAudioLagMs, short.maxAudioLagMs),
    minimumAudioCorrelationPermille: integer(short.minAudioCorrelationPermille, 1000),
    wordTimings: array(
      object({
        text: { ...text(80), minLength: 1 },
        startMs: integer(0, limits.maxDurationMs - 1),
        endMs: integer(1, limits.maxDurationMs),
        confidencePermille: nullable(integer(0, 1000)),
      }),
      limits.maxWordTimings,
      1,
    ),
    seamTimesMs: AVATAR_LONG_SEAMS_SCHEMA,
  }),
);

export function validateAvatarLongSeams(seams: readonly number[], videoDurationMs: number) {
  let start = 0;
  for (const end of [...seams, videoDurationMs]) {
    if (end <= start || end - start > short.maxDurationMs + 1) {
      fail('分段接缝', '分段须按时间升序且单段不超过 30 秒');
    }
    start = end;
  }
}

export function parseAvatarLongSyncWorkerInput(value: unknown): AvatarLongSyncWorkerInput {
  const input = parse<AvatarLongSyncWorkerInput>(
    FISSION_AVATAR_LONG_SYNC_WORKER_INPUT_SCHEMA,
    value,
  );
  const operations = new Set<string>();
  let unfinished = false;
  for (const [index, segment] of input.segments.entries()) {
    const { ordinal, result, ...fields } = segment;
    if (ordinal !== index + 1 || (unfinished && result)) fail('分段', '段序或检查点顺序无效');
    if (!result) unfinished = true;
    for (const operation of [fields.ttsOperationId, fields.lipSyncClientToken]) {
      if (operations.has(operation)) fail('分段', '供应商操作标识重复');
      operations.add(operation);
    }
    parseAvatarSyncWorkerInput({
      ...fields,
      schemaVersion: 1,
      voiceSpeaker: input.voiceSpeaker,
      characterSizeBytes: input.characterSizeBytes,
    });
    if (result) {
      if (!fields.lipSyncTaskId) fail('分段', '检查点缺少供应商回执');
      parseAvatarSyncCompletion(result.media);
    }
  }
  return input;
}

export function parseAvatarLongSyncCompletion(value: unknown): AvatarLongSyncCompletion {
  const media = parse<AvatarLongSyncCompletion>(FISSION_AVATAR_LONG_SYNC_COMPLETION_SCHEMA, value);
  if (Math.abs(media.audioDurationMs - media.videoDurationMs) > short.maxAudioLagMs) {
    fail('长片媒体', '音轨与画面时长差超过限制');
  }
  validateAvatarLongSeams(media.seamTimesMs, media.videoDurationMs);
  let previousStart = -1;
  for (const cue of media.wordTimings) {
    if (
      cue.startMs < previousStart ||
      cue.startMs >= cue.endMs ||
      cue.endMs > media.audioDurationMs
    ) {
      fail('长片字幕', '字幕时标须在音轨范围内按时间顺序排列');
    }
    previousStart = cue.startMs;
  }
  return media;
}

export function isAvatarLongSyncMedia(media: AvatarSyncMedia): media is AvatarLongSyncCompletion {
  return 'schemaVersion' in media && media.schemaVersion === 2;
}

const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });
const spoken = /[\p{L}\p{N}]/u;

export function planAvatarSpeechSegments(text: string, maxCharacters: number) {
  if (
    !Number.isInteger(maxCharacters) ||
    maxCharacters < 20 ||
    maxCharacters > short.maxScriptCharacters
  )
    throw new TypeError('单段字数上限须为 20–120。');
  const source = text.replace(/\r\n?/g, '\n').trim();
  if (
    !spoken.test(source) ||
    /[\p{Cc}\p{Cs}]/u.test(source.replace(/[\n\t]/gu, '')) ||
    Array.from(source).length > maxCharacters * limits.maxSegments
  )
    throw new TypeError('文案为空、含无效字符或超出 12 段总容量。');
  const stops = new Set(
    Array.from(sentences.segment(source), ({ index, segment }) => index + segment.length),
  );
  for (const match of source.matchAll(/[，、：；,:;][”’」』）》】\]]*|\n+/gu)) {
    const stop = match.index + match[0].length;
    if (
      match[0].startsWith('\n') ||
      !/\d/u.test(source[match.index - 1] ?? '') ||
      !/\d/u.test(source[stop] ?? '')
    )
      stops.add(stop);
  }
  const pauses = [...stops].sort((left, right) => left - right);
  const segments: AvatarSpeechSegment[] = [];
  let start = 0;
  let sourceStart = 0;
  while (start < source.length) {
    if (segments.length === limits.maxSegments) throw new TypeError('自然停顿分段超过 12 段。');
    let boundary: { index: number; slice: string; count: number } | undefined;
    for (const index of pauses) {
      if (index <= start) continue;
      const slice = source.slice(start, index).trim();
      const count = Array.from(slice).length;
      if (count > maxCharacters) break;
      if (spoken.test(slice)) boundary = { index, slice, count };
    }
    if (!boundary) throw new TypeError(`第 ${segments.length + 1} 段在字数上限内缺少可用停顿。`);
    const sourceEnd = sourceStart + Array.from(source.slice(start, boundary.index)).length;
    segments.push({
      ordinal: segments.length + 1,
      sourceStart,
      sourceEnd,
      text: boundary.slice,
      characters: boundary.count,
    });
    start = boundary.index;
    sourceStart = sourceEnd;
  }
  return { source, segments };
}

export function planAvatarLongSegments(script: string): AvatarSpeechSegment[] {
  const { segments } = planAvatarSpeechSegments(script, limits.maxSegmentCharacters);
  if (segments.length < limits.minSegments)
    throw new TypeError('长片文案至少需要 3 个可生成分段。');
  return segments;
}
