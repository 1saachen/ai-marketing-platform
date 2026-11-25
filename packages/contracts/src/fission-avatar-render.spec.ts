import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_RENDER_LIMITS as LIMITS,
  FISSION_AVATAR_RENDER_COMPLETION_SCHEMA,
  FISSION_AVATAR_RENDER_WORKER_INPUT_SCHEMA,
  avatarRenderReviewPasses,
  parseAvatarCompositionConfirmRequest,
  parseAvatarCompositionDraftRequest,
  parseAvatarCompositionSettings,
  parseAvatarRenderCompletion,
  parseAvatarRenderCreateRequest,
  parseAvatarRenderReview,
  parseAvatarRenderWorkerInput,
  type AvatarCompositionSettings,
} from './fission-avatar-render';

const id = '11111111-1111-4111-8111-111111111111';
const ref = { artifactId: id, revision: 3 };
const cue = { startMs: 0, endMs: 560, text: '你好\n欢迎' };
const settings: AvatarCompositionSettings = {
  background: { kind: 'SOLID', color: '#bBcCdD' },
  captionMode: 'BOTH',
  insetPercent: 10,
  captions: [cue],
};
const input = {
  schemaVersion: 1,
  settings,
  audioDurationMs: 600,
  videoDurationMs: 620,
  videoSizeBytes: 12_000,
  audioSizeBytes: 1200,
  backgroundSizeBytes: null,
};
const assessment = {
  sha256: 'a'.repeat(64),
  method: 'calibrated-method.fixture.1',
  coveragePermille: LIMITS.minReviewCoveragePermille,
  confidencePermille: LIMITS.minReviewConfidencePermille,
  maxAbsOffsetMs: LIMITS.maxReviewOffsetMs,
};

describe('avatar render contracts', () => {
  it.each([FISSION_AVATAR_RENDER_WORKER_INPUT_SCHEMA, FISSION_AVATAR_RENDER_COMPLETION_SCHEMA])(
    'publishes the schema read by the Worker ($id)',
    (schema) => {
      const raw = readFileSync(resolve(__dirname, '..', 'schemas', schema.$id!), 'utf8');
      expect(JSON.parse(raw)).toEqual(schema);
    },
  );

  it('keeps edit, confirm and render inputs separate', () => {
    const draft = parseAvatarCompositionDraftRequest({ expectedRevision: 0, sync: ref, settings });
    expect(draft).toMatchObject({ settings: { background: { color: '#BBCCDD' } } });
    expect(parseAvatarCompositionConfirmRequest({ expectedRevision: 1 })).toEqual({
      expectedRevision: 1,
    });
    expect(() => parseAvatarCompositionConfirmRequest({ expectedRevision: 0 })).toThrow();
    expect(parseAvatarRenderCreateRequest({ idempotencyKey: id, composition: ref })).toEqual({
      idempotencyKey: id,
      composition: ref,
    });
    expect(() => parseAvatarRenderCreateRequest({ idempotencyKey: id, settings })).toThrow();
  });

  it.each([
    { captions: [{ ...cue, startMs: 560 }] },
    { captions: [cue, { ...cue, startMs: 555, endMs: 900 }] },
    { captions: [{ ...cue, text: '甲\n乙\n丙' }] },
    { captions: [{ ...cue, text: '甲\n \n' + '乙' }] },
    { captions: [{ ...cue, text: '字'.repeat(LIMITS.maxCaptionCharacters + 1) }] },
    { background: { kind: 'IMAGE', assetId: id } },
    { background: { kind: 'URL', url: 'https://example.com/a.png' } },
    { captionMode: 'UNSUPPORTED' },
    { insetPercent: LIMITS.maxInsetPercent + 1 },
  ])('validates canonical composition settings (%j)', (patch) => {
    expect(() => parseAvatarCompositionSettings({ ...settings, ...patch })).toThrow();
  });

  it('checks the exact frozen timing and required files for the Worker', () => {
    expect(parseAvatarRenderWorkerInput(input)).toMatchObject({ schemaVersion: 1 });
    expect(() => parseAvatarRenderWorkerInput({ ...input, audioDurationMs: 559 })).toThrow();
    expect(() => parseAvatarRenderWorkerInput({ ...input, backgroundSizeBytes: 5 })).toThrow();
    expect(() =>
      parseAvatarRenderWorkerInput({ ...input, settings: { ...settings, captions: [] } }),
    ).toThrow();
    const image = { ...settings, background: { kind: 'IMAGE', assetId: id, version: 2 } };
    expect(() => parseAvatarRenderWorkerInput({ ...input, settings: image })).toThrow();
    expect(
      parseAvatarRenderWorkerInput({ ...input, settings: image, backgroundSizeBytes: 5 }),
    ).toMatchObject({
      backgroundSizeBytes: 5,
    });
  });

  it('rejects unpaired UTF-16 code units before handing captions to the Worker', () => {
    expect(() =>
      parseAvatarCompositionSettings({
        ...settings,
        captions: [{ ...cue, text: String.fromCharCode(0xd800) }],
      }),
    ).toThrow();
  });

  it('checks media structure metadata without granting review approval', () => {
    const completion = {
      audioDurationMs: 1000,
      videoDurationMs: 1100,
      audioLagMs: -100,
      minimumAudioCorrelationPermille: 980,
    };
    expect(parseAvatarRenderCompletion(completion)).toEqual(completion);
    expect(() => parseAvatarRenderCompletion({ ...completion, videoDurationMs: 1101 })).toThrow();
    expect(() => parseAvatarRenderCompletion({ ...completion, audioLagMs: 101 })).toThrow();
    expect(() => parseAvatarRenderCompletion({ ...completion, review: assessment })).toThrow();
  });

  it('checks the candidate hash and every independent review threshold', () => {
    expect(avatarRenderReviewPasses(parseAvatarRenderReview(assessment))).toBe(true);
    expect(avatarRenderReviewPasses({ ...assessment, maxAbsOffsetMs: 101 })).toBe(false);
    expect(avatarRenderReviewPasses({ ...assessment, coveragePermille: 949 })).toBe(false);
    expect(avatarRenderReviewPasses({ ...assessment, confidencePermille: 799 })).toBe(false);
    expect(() => parseAvatarRenderReview({ ...assessment, sha256: 'abridged' })).toThrow();
    expect(() => parseAvatarRenderReview({ ...assessment, method: '' })).toThrow();
  });
});
