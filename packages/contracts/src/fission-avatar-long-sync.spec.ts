import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FISSION_AVATAR_LONG_SYNC_COMPLETION_SCHEMA,
  FISSION_AVATAR_LONG_SYNC_WORKER_INPUT_SCHEMA,
  parseAvatarLongSyncCompletion,
  parseAvatarLongSyncWorkerInput,
  planAvatarLongSegments,
} from './fission-avatar-long-sync';
import {
  FISSION_AVATAR_LONG_RENDER_COMPLETION_SCHEMA,
  FISSION_AVATAR_LONG_RENDER_WORKER_INPUT_SCHEMA,
  avatarRenderReviewPasses,
  parseAvatarRenderCompletion,
  parseAvatarRenderReview,
} from './fission-avatar-render';
import { parseAvatarSyncCreateRequest } from './fission-avatar-sync';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const take = {
  videoDurationMs: 21_000,
  audioDurationMs: 21_000,
  audioLagMs: 0,
  minimumAudioCorrelationPermille: 999,
};
const file = { sizeBytes: 4096, sha256: 'a'.repeat(64) };
const timing = { text: '首段', startMs: 0, endMs: 1000, confidencePermille: 950 };
const clip = { media: { ...take, wordTimings: [timing] }, audio: file, video: file };
const seg = (ordinal: number) => ({
  ordinal,
  scriptText: `第 ${ordinal} 段`,
  ttsOperationId: uuid(ordinal),
  ttsStarted: ordinal === 1,
  lipSyncClientToken: uuid(ordinal + 10),
  lipSyncStarted: ordinal === 1,
  lipSyncTaskId: ordinal === 1 ? 'amk-tool-lip-sync-first-clip' : null,
  result: ordinal === 1 ? clip : null,
});
const worker = {
  schemaVersion: 2,
  voiceSpeaker: 'zh_female_vv_uranus_bigtts',
  characterSizeBytes: 1000,
  segments: [seg(1), seg(2), seg(3)],
};
const longMedia = {
  ...take,
  schemaVersion: 2,
  audioDurationMs: 63_000,
  videoDurationMs: 63_000,
  seamTimesMs: [21_000, 42_000],
};

describe('avatar segmented contracts', () => {
  it.each([
    FISSION_AVATAR_LONG_SYNC_WORKER_INPUT_SCHEMA,
    FISSION_AVATAR_LONG_SYNC_COMPLETION_SCHEMA,
    FISSION_AVATAR_LONG_RENDER_WORKER_INPUT_SCHEMA,
    FISSION_AVATAR_LONG_RENDER_COMPLETION_SCHEMA,
  ])('publishes Worker schema ($id)', (schema) => {
    expect(
      JSON.parse(readFileSync(resolve(__dirname, '..', 'schemas', schema.$id!), 'utf8')),
    ).toEqual(schema);
  });

  it('selects segmented work explicitly while admitting unchanged v1 inputs', () => {
    const short = {
      idempotencyKey: uuid(0),
      expectedDraftRevision: 1,
      binding: { artifactId: uuid(1), revision: 2 },
      script: { artifactId: uuid(2), revision: 3 },
    };
    expect(parseAvatarSyncCreateRequest(short)).toEqual(short);
    expect(parseAvatarSyncCreateRequest({ ...short, mode: 'SEGMENTED' })).toMatchObject({
      mode: 'SEGMENTED',
    });
    expect(() => parseAvatarSyncCreateRequest({ ...short, mode: 'OTHER' })).toThrow();
    expect(parseAvatarRenderCompletion(take)).toEqual(take);
  });

  it('retains one verified result and prevents duplicate provider operations or holes', () => {
    expect(parseAvatarLongSyncWorkerInput(worker)).toEqual(worker);
    expect(() =>
      parseAvatarLongSyncWorkerInput({
        ...worker,
        segments: [seg(1), seg(2), { ...seg(3), ttsOperationId: uuid(2) }],
      }),
    ).toThrow();
    expect(() =>
      parseAvatarLongSyncWorkerInput({
        ...worker,
        segments: [seg(1), seg(2), { ...seg(3), result: clip }],
      }),
    ).toThrow();
  });

  it('accepts segment-bounded seams and global word timings after one minute', () => {
    const media = {
      ...longMedia,
      wordTimings: [timing, { ...timing, startMs: 60_500, endMs: 61_200 }],
    };
    expect(parseAvatarLongSyncCompletion(media)).toEqual(media);
    expect(parseAvatarRenderCompletion(longMedia)).toEqual(longMedia);
    expect(() =>
      parseAvatarLongSyncCompletion({ ...media, seamTimesMs: [20_000, 19_000] }),
    ).toThrow();
    expect(() =>
      parseAvatarRenderCompletion({ ...longMedia, seamTimesMs: [31_000, 45_000] }),
    ).toThrow();
  });

  it('evaluates independent accuracy as a separate long review gate', () => {
    const review = {
      sha256: file.sha256,
      method: 'fixture.v1',
      coveragePermille: 1000,
      confidencePermille: 900,
      maxAbsOffsetMs: 100,
    };
    expect(avatarRenderReviewPasses(parseAvatarRenderReview(review))).toBe(true);
    const evidence = { durationMs: 63_000, seamTimesMs: [21_000, 42_000], accuracyPermille: 950 };
    expect(avatarRenderReviewPasses(parseAvatarRenderReview({ ...review, evidence }))).toBe(true);
    expect(
      avatarRenderReviewPasses(
        parseAvatarRenderReview({ ...review, evidence: { ...evidence, accuracyPermille: 949 } }),
      ),
    ).toBe(false);
  });

  it('uses the same natural boundaries for every repeated preparation', () => {
    const source = ['甲', '乙', '丙'].map((name) => name.repeat(45) + '。').join('\n');
    const plan = planAvatarLongSegments(source);
    expect(plan).toHaveLength(3);
    expect(plan.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3]);
    expect(planAvatarLongSegments(source.replaceAll('\n', '\r\n'))).toEqual(plan);
    expect(() => planAvatarLongSegments('短片。')).toThrow();
  });
});
