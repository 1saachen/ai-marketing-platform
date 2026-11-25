import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_NATIVE_MODEL,
  FISSION_AVATAR_NATIVE_CHECKPOINT_SCHEMA,
  FISSION_AVATAR_NATIVE_COMPLETION_SCHEMA,
  FISSION_AVATAR_NATIVE_WORKER_INPUT_SCHEMA,
  parseAvatarNativeCheckpoint,
  parseAvatarNativeCompletion,
  parseAvatarNativeWorkerInput,
} from './fission-avatar-native';
import { parseAvatarSyncCreateRequest } from './fission-avatar-sync';

const ref = {
  artifactId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
};
const request = {
  idempotencyKey: '00000000-0000-4000-8000-000000000002',
  expectedDraftRevision: 1,
  binding: ref,
  script: ref,
};
const input = {
  schemaVersion: 4,
  model: AVATAR_NATIVE_MODEL,
  prompt: '人物直视镜头，微笑着用普通话说「欢迎来到我的小店」。',
  durationSeconds: 30,
  image: { kind: 'BYTES', mimeType: 'image/png', sizeBytes: 983, sha256: '1'.repeat(64) },
  nativeStarted: false,
  nativeTaskId: null,
};
const completion = {
  schemaVersion: 4,
  audioDurationMs: 30_000,
  videoDurationMs: 30_000,
  wordTimings: [],
};

describe('native avatar task contracts', () => {
  it.each([
    FISSION_AVATAR_NATIVE_WORKER_INPUT_SCHEMA,
    FISSION_AVATAR_NATIVE_CHECKPOINT_SCHEMA,
    FISSION_AVATAR_NATIVE_COMPLETION_SCHEMA,
  ])('publishes the shared Worker schema ($id)', (schema) => {
    expect(
      JSON.parse(readFileSync(resolve(__dirname, '..', 'schemas', schema.$id!), 'utf8')),
    ).toEqual(schema);
  });

  it('accepts 4 and 30 seconds and leaves older create requests intact', () => {
    for (const durationSeconds of [4, 30]) {
      const body = { ...request, mode: 'NATIVE', durationSeconds };
      expect(parseAvatarSyncCreateRequest(body)).toEqual(body);
    }
    expect(parseAvatarSyncCreateRequest(request)).toEqual(request);
    expect(parseAvatarSyncCreateRequest({ ...request, mode: 'SEGMENTED' })).toEqual({
      ...request,
      mode: 'SEGMENTED',
    });
  });

  it('requires an integral and supported duration for native generation', () => {
    for (const durationSeconds of [undefined, 3, 29.5, 31]) {
      expect(() =>
        parseAvatarSyncCreateRequest({ ...request, mode: 'NATIVE', durationSeconds }),
      ).toThrow();
    }
    expect(() => parseAvatarSyncCreateRequest({ ...request, durationSeconds: 30 })).toThrow();
  });

  it('accepts an authorized image or a registered portrait and a known receipt', () => {
    expect(parseAvatarNativeWorkerInput(input)).toEqual(input);
    const portrait = {
      ...input,
      image: { kind: 'PORTRAIT', assetId: 'asset-20261125090000-portrait' },
      nativeStarted: true,
      nativeTaskId: 'cgt-received-30',
    };
    expect(parseAvatarNativeWorkerInput(portrait)).toEqual(portrait);
    expect(
      parseAvatarNativeCheckpoint({ kind: 'NATIVE_ACCEPTED', providerTaskId: 'cgt-received-30' }),
    ).toEqual({ kind: 'NATIVE_ACCEPTED', providerTaskId: 'cgt-received-30' });
  });

  it('rejects raw URLs, unsupported image types and unreserved receipts', () => {
    for (const body of [
      { ...input, image: { kind: 'PORTRAIT', assetId: 'https://example.com/shape.png' } },
      { ...input, image: { ...input.image, mimeType: 'video/mp4' } },
      { ...input, image: { ...input.image, sizeBytes: 8 * 1024 * 1024 + 1 } },
      { ...input, nativeTaskId: 'cgt-unreserved' },
    ]) {
      expect(() => parseAvatarNativeWorkerInput(body)).toThrow();
    }
  });

  it('admits a native timeline with empty timings and enforces duration and drift bounds', () => {
    expect(parseAvatarNativeCompletion(completion)).toEqual(completion);
    expect(() => parseAvatarNativeCompletion({ ...completion, audioDurationMs: 29_899 })).toThrow();
    expect(() => parseAvatarNativeCompletion({ ...completion, videoDurationMs: 30_001 })).toThrow();
    expect(() =>
      parseAvatarNativeCompletion({ ...completion, wordTimings: [{ text: '词' }] }),
    ).toThrow();
  });
});
