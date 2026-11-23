import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyLocalReplaceDraft,
  FISSION_LOCAL_REPLACE_WORKER_INPUT_SCHEMA,
  LOCAL_REPLACE_LIMITS,
  parseLocalReplaceDraftSaveRequest,
  parseLocalReplaceTaskCreateRequest,
  parseLocalReplaceWorkerInput,
  validateLocalReplaceForRender,
} from './fission-local-replace';

const asset = { assetId: '11111111-1111-4111-8111-111111111111', version: 3 };
const input = {
  schemaVersion: 1,
  model: 'video-edit-test',
  sourceMimeType: 'video/mp4',
  targetMimeType: 'image/png',
  sourceSizeBytes: 16384,
  targetSizeBytes: LOCAL_REPLACE_LIMITS.maxTargetBytes,
  startMs: 1000,
  endMs: 4000,
  objectType: 'PROP',
  objectDescription: '桌边的橙色纸盒',
  instruction: '',
};

describe('local replace contracts', () => {
  it('keeps the worker input schema synchronized and allows an empty instruction', () => {
    const schema = FISSION_LOCAL_REPLACE_WORKER_INPUT_SCHEMA;
    expect(
      JSON.parse(readFileSync(resolve(__dirname, '..', 'schemas', schema.$id!), 'utf8')),
    ).toEqual(schema);
    expect(parseLocalReplaceWorkerInput(input)).toEqual(input);
  });

  it.each([
    { startMs: 4000 },
    { endMs: 15001 },
    { targetMimeType: 'video/mp4' },
    { targetSizeBytes: LOCAL_REPLACE_LIMITS.maxTargetBytes + 1 },
    { objectType: 'PERSON' },
    { objectDescription: '   ' },
    { sourceSizeBytes: undefined },
    { sourceUrl: 'https://example.test/private' },
  ])('rejects worker input outside the edit contract (%j)', (patch) => {
    expect(() => parseLocalReplaceWorkerInput({ ...input, ...patch })).toThrow();
  });

  it('supports an incomplete draft and validates a complete configuration at render', () => {
    const draft = emptyLocalReplaceDraft();
    expect(parseLocalReplaceDraftSaveRequest({ draft, expectedRevision: 0 }).draft).toEqual(draft);
    expect(() => validateLocalReplaceForRender(draft)).toThrow();
    expect(() =>
      parseLocalReplaceDraftSaveRequest({
        expectedRevision: 2,
        draft: { ...draft, nodeId: 'CLONE_GENERATION' },
      }),
    ).toThrow();
    Object.assign(draft, {
      source: asset,
      target: { ...asset, assetId: '22222222-2222-4222-8222-222222222222' },
      endMs: 4000,
      sourceRightsConfirmed: true,
      objectDescription: '手里的小瓶',
    });
    expect(() => validateLocalReplaceForRender(draft)).not.toThrow();
    expect(() => validateLocalReplaceForRender({ ...draft, sourceRightsConfirmed: false })).toThrow(
      '原片使用权限',
    );
    expect(
      parseLocalReplaceTaskCreateRequest({
        idempotencyKey: asset.assetId,
        expectedRevision: 1,
      }),
    ).toEqual({ idempotencyKey: asset.assetId, expectedRevision: 1 });
  });
});
