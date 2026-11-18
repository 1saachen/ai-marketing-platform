import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, type ApiErrorCode } from './asset';

import {
  CLONE_PRODUCT_FACTS_MAX_LENGTH,
  CLONE_PRODUCT_NAME_MAX_LENGTH,
  CLONE_UPLOAD_ROLES,
  FISSION_CLONE_IMPORT_ASSET_SCHEMA,
  FISSION_CLONE_INPUT_CONFIRM_SCHEMA,
  FISSION_CLONE_INPUT_DRAFT_SCHEMA,
  FISSION_CLONE_INPUT_LIMITS,
  FISSION_CLONE_NODES,
  emptyCloneInputDraft,
  normalizeCloneInputDraft,
  parseCloneImportAssetRequest,
  parseCloneInputConfirmRequest,
  parseCloneInputDraft,
  type CloneInputConfirmRequest,
  type CloneInputDraft,
  type CloneUpload,
} from './fission-clone';

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/fission-clone-input.json'), 'utf8'),
) as { draft: CloneInputDraft; confirm: CloneInputConfirmRequest; uploads: CloneUpload[] };
const validDraft = () => structuredClone(fixture.draft);

describe('fission clone G1 input contract', () => {
  it('shares the capability-unavailable error while preserving existing error codes', () => {
    const code: ApiErrorCode = 'CLONE_CAPABILITY_UNAVAILABLE';
    expect(API_ERROR_CODES).toContain(code);
    expect(API_ERROR_CODES).toContain('VALIDATION_ERROR');
    expect(API_ERROR_CODES).toContain('CONFLICT');
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it('restores incomplete input without fabricating confirmed media or facts', () => {
    expect(parseCloneInputDraft(emptyCloneInputDraft())).toEqual({
      schemaVersion: 1,
      referenceUploadId: null,
      productUploadIds: [],
      productName: '',
      productFacts: '',
      sourceRightsConfirmed: false,
    });
    const one = emptyCloneInputDraft();
    one.productUploadIds.push(fixture.draft.productUploadIds[0]!);
    expect(emptyCloneInputDraft().productUploadIds).toEqual([]);
    expect(FISSION_CLONE_NODES).toEqual([
      'CLONE_INPUT',
      'CLONE_ANALYSIS',
      'CLONE_MAPPING',
      'CLONE_GENERATION',
    ]);
  });

  it('keeps serialized schemas and input fixtures aligned with contract definitions', () => {
    for (const schema of [
      FISSION_CLONE_INPUT_DRAFT_SCHEMA,
      FISSION_CLONE_INPUT_CONFIRM_SCHEMA,
      FISSION_CLONE_IMPORT_ASSET_SCHEMA,
    ]) {
      const serialized = JSON.parse(
        readFileSync(resolve(__dirname, '../schemas', schema.$id), 'utf8'),
      );
      expect(serialized).toEqual(schema);
    }
    expect(parseCloneInputDraft(fixture.draft)).toEqual(fixture.draft);
    expect(parseCloneInputConfirmRequest(fixture.confirm)).toEqual(fixture.confirm);
    expect(Object.keys(fixture.draft).sort()).toEqual(
      [...FISSION_CLONE_INPUT_DRAFT_SCHEMA.required].sort(),
    );
    expect(fixture.uploads.map((upload) => upload.id)).toEqual([
      fixture.draft.referenceUploadId,
      ...fixture.draft.productUploadIds,
    ]);
    expect(fixture.uploads.every((upload) => CLONE_UPLOAD_ROLES.includes(upload.role))).toBe(true);
    expect(fixture.uploads[0]!.media.durationMs).toBe(10_000);
    expect(fixture.uploads[1]!.media.durationMs).toBeNull();
    expect(FISSION_CLONE_INPUT_LIMITS).toEqual({
      maxReferenceBytes: 268_435_456,
      maxProductBytes: 67_108_864,
      maxProductFiles: 20,
      minVideoDurationMs: 1000,
      maxVideoDurationMs: 120_000,
      maxPixels: 8_847_360,
    });
  });

  it('rejects missing/unknown fields and unsupported draft versions without data loss', () => {
    for (const key of FISSION_CLONE_INPUT_DRAFT_SCHEMA.required) {
      const draft: Record<string, unknown> = validDraft();
      delete draft[key];
      expect(() => parseCloneInputDraft(draft)).toThrow(TypeError);
    }
    for (const input of [
      null,
      [],
      'draft',
      { ...validDraft(), schemaVersion: 2 },
      { ...validDraft(), prompt: 'unexpected hidden field' },
      { ...validDraft(), sourceRightsConfirmed: 'true' },
    ]) {
      expect(() => parseCloneInputDraft(input)).toThrow(TypeError);
    }
  });

  it('rejects malformed IDs, duplicate identities and excessive product selections', () => {
    const id = fixture.draft.productUploadIds[0]!;
    for (const referenceUploadId of ['', 'fixture-reference', 42, id.replace('-4', '-0')]) {
      expect(() => parseCloneInputDraft({ ...validDraft(), referenceUploadId })).toThrow(TypeError);
    }
    for (const productUploadIds of [null, [null], ['invalid'], [id, id], [id, id.toUpperCase()]]) {
      expect(() => parseCloneInputDraft({ ...validDraft(), productUploadIds })).toThrow(TypeError);
    }
    const productUploadIds = Array.from(
      { length: FISSION_CLONE_INPUT_LIMITS.maxProductFiles },
      (_, index) => `12345678-1234-4123-8123-${String(index).padStart(12, '0')}`,
    );
    expect(
      parseCloneInputDraft({ ...validDraft(), productUploadIds }).productUploadIds,
    ).toHaveLength(20);
    productUploadIds.push('12345678-1234-4123-8123-999999999999');
    expect(() => parseCloneInputDraft({ ...validDraft(), productUploadIds })).toThrow(TypeError);
  });

  it('enforces code point limits without truncating product facts or rejecting valid emoji', () => {
    for (const [field, maximum] of [
      ['productName', CLONE_PRODUCT_NAME_MAX_LENGTH],
      ['productFacts', CLONE_PRODUCT_FACTS_MAX_LENGTH],
    ] as const) {
      const content = '🍚'.repeat(maximum);
      expect(parseCloneInputDraft({ ...validDraft(), [field]: content })[field]).toBe(content);
      expect(() => parseCloneInputDraft({ ...validDraft(), [field]: `${content}。` })).toThrow(
        TypeError,
      );
      expect(() => parseCloneInputDraft({ ...validDraft(), [field]: null })).toThrow(TypeError);
    }
  });

  it('canonicalizes equivalent input without mutating drafts or reordering references', () => {
    const input = {
      ...validDraft(),
      referenceUploadId: fixture.draft.referenceUploadId!.toUpperCase(),
      productUploadIds: [...fixture.draft.productUploadIds].reverse().map((id) => id.toUpperCase()),
      productName: '  示例商品  ',
      productFacts: '  包装规格为 500g。\r\n资料提供的原料为大米。\r  ',
    };
    const original = structuredClone(input);
    const normalized = normalizeCloneInputDraft(input);
    expect(normalized).toEqual({
      ...fixture.draft,
      productUploadIds: [...fixture.draft.productUploadIds].reverse(),
    });
    expect(normalizeCloneInputDraft(normalized)).toEqual(normalized);
    expect(input).toEqual(original);
    normalized.productUploadIds.pop();
    expect(input.productUploadIds).toHaveLength(2);
    expect(() => normalizeCloneInputDraft({ ...input, ignored: true })).toThrow(TypeError);
  });

  it('imports an exact positive asset version with a known role and stable upload key', () => {
    const request = {
      assetId: fixture.uploads[1]!.fileObjectId,
      version: 1,
      role: 'PRODUCT',
      clientUploadKey: fixture.uploads[0]!.id,
    };
    expect(parseCloneImportAssetRequest(request)).toEqual(request);
    expect(parseCloneImportAssetRequest({ ...request, role: 'REFERENCE' }).role).toBe('REFERENCE');
    expect(
      parseCloneImportAssetRequest({
        ...request,
        assetId: request.assetId.toUpperCase(),
        clientUploadKey: request.clientUploadKey.toUpperCase(),
      }),
    ).toEqual(request);
    for (const field of FISSION_CLONE_IMPORT_ASSET_SCHEMA.required) {
      const incomplete: Record<string, unknown> = { ...request };
      delete incomplete[field];
      expect(() => parseCloneImportAssetRequest(incomplete)).toThrow(TypeError);
    }
    for (const invalid of [
      { ...request, assetId: 'foreign-id' },
      { ...request, clientUploadKey: '' },
      { ...request, role: 'UNKNOWN' },
      { ...request, role: 'product' },
      { ...request, sourceProjectId: request.assetId },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1'].map((version) => ({
        ...request,
        version,
      })),
    ])
      expect(() => parseCloneImportAssetRequest(invalid)).toThrow(TypeError);
  });

  it('requires both optimistic versions and rejects lossy or coerced revisions', () => {
    expect(
      parseCloneInputConfirmRequest({ expectedDraftRevision: 0, expectedInputRevision: 0 }),
    ).toEqual({ expectedDraftRevision: 0, expectedInputRevision: 0 });
    for (const key of ['expectedDraftRevision', 'expectedInputRevision']) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '1', null]) {
        expect(() => parseCloneInputConfirmRequest({ ...fixture.confirm, [key]: value })).toThrow(
          TypeError,
        );
      }
      const missing: Record<string, unknown> = { ...fixture.confirm };
      delete missing[key];
      expect(() => parseCloneInputConfirmRequest(missing)).toThrow(TypeError);
    }
    expect(() => parseCloneInputConfirmRequest({ ...fixture.confirm, revision: 1 })).toThrow(
      TypeError,
    );
  });
});
