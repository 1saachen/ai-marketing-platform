import { describe, expect, it } from 'vitest';
import type { AssetUpdatePlan, ProductionAsset, ProductionInput } from '@ai-marketing/contracts';
import { validateAssetUpdateScope, assetUpdateScope } from './asset-update-scope';
const product: ProductionAsset = {
  id: 'cup',
  kind: 'PRODUCT',
  name: '杯子',
  description: '白色',
  knownFacts: '陶瓷',
  designNotes: '',
  sourceText: '',
  image: { assetId: 'old-file', version: 1 },
};
const person: ProductionAsset = {
  ...product,
  id: 'person',
  kind: 'CHARACTER',
  name: '人物',
  description: '原有人物',
};
const input = {
  assetUpdateVersion: 1,
  identitySeed: 'task',
  document: { assets: [product, person], shots: [] },
} as unknown as ProductionInput;
const checkpoint: { assetUpdatePlan: AssetUpdatePlan } = {
  assetUpdatePlan: {
    decisions: [
      { assetId: 'cup', fields: ['description'], reason: '产品配色变更' },
      { assetId: 'person', fields: [], reason: '人物形象不受影响' },
    ],
    additions: [],
    blockers: [],
  },
};
describe('AI selected asset update commit boundary', () => {
  it('accepts a product-only patch and projects the actual decision without exposing internal fields', () => {
    expect(
      validateAssetUpdateScope(
        { assets: [{ ...product, description: '黑色' }, person], shots: [] },
        input,
        checkpoint,
      ),
    ).toBeNull();
    expect(assetUpdateScope(input, checkpoint)).toEqual([
      { name: '杯子', action: 'UPDATE', reason: '产品配色变更' },
      { name: '人物', action: 'KEEP', reason: '人物形象不受影响' },
    ]);
  });
  it.each(['description', 'image'] as const)(
    'rejects modification to preserved object %s',
    (field) => {
      const changed =
        field === 'image'
          ? { ...person, image: { assetId: 'new-file', version: 1 } }
          : { ...person, description: '新形象' };
      expect(
        validateAssetUpdateScope({ assets: [product, changed], shots: [] }, input, checkpoint),
      ).toContain('范围外');
    },
  );
  it('rejects deletion, hidden metadata edits, stale/duplicate identity plans, blockers and unplanned new assets', () => {
    expect(validateAssetUpdateScope({ assets: [product], shots: [] }, input, checkpoint)).toContain(
      '删除',
    );
    expect(
      validateAssetUpdateScope(
        { assets: [{ ...product, manualFields: [] }, person], shots: [] },
        input,
        checkpoint,
      ),
    ).toContain('范围外');
    const duplicate = structuredClone(checkpoint);
    duplicate.assetUpdatePlan.decisions[1]!.assetId = 'cup';
    expect(validateAssetUpdateScope(input.document, input, duplicate)).toContain('判断范围');
    const blocked = structuredClone(checkpoint);
    blocked.assetUpdatePlan.blockers.push('无法判断');
    expect(validateAssetUpdateScope(input.document, input, blocked)).toContain('人工');
    expect(
      validateAssetUpdateScope(
        { assets: [product, person, { ...person, id: 'asset-task-1' }], shots: [] },
        input,
        checkpoint,
      ),
    ).toContain('范围外');
  });
  it('allows an all-keep candidate and leaves historical tasks on their frozen policy', () => {
    const keep = structuredClone(checkpoint);
    keep.assetUpdatePlan.decisions[0]!.fields = [];
    expect(validateAssetUpdateScope(input.document, input, keep)).toBeNull();
    const historical = { ...input };
    delete historical.assetUpdateVersion;
    expect(validateAssetUpdateScope(input.document, historical, {})).toBeNull();
    expect(validateAssetUpdateScope(input.document, input, {})).toContain('判断范围');
  });
  it('distinguishes refreshed source quotes from an actual change to the asset definition', () => {
    const asset = {
      ...product,
      preparation: {
        aliases: [],
        usage: '出场',
        treatment: 'INDEPENDENT' as const,
        parentId: null,
        sources: [
          { source: 'SCRIPT' as const, path: '/story/content', quote: '旧原文', field: 'usage' },
        ],
        details: [],
        questions: [],
        images: [],
      },
    };
    const scopedInput = { ...input, document: { assets: [asset, person], shots: [] } };
    const quotePlan = structuredClone(checkpoint);
    quotePlan.assetUpdatePlan.decisions[0]!.fields = ['preparation'];
    const next = structuredClone(asset);
    next.preparation.sources[0]!.quote = '新原文';
    expect(
      assetUpdateScope(scopedInput, { ...quotePlan, final: { assets: [next, person] } })?.[0]
        ?.action,
    ).toBe('SYNC');
    expect(
      validateAssetUpdateScope({ assets: [next, person], shots: [] }, scopedInput, quotePlan),
    ).toBeNull();
  });
});
