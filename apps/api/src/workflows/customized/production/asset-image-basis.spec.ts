import { describe, it, expect } from 'vitest';
import type { ProductionAsset } from '@ai-marketing/contracts';
import { assetImageBasis, mergePreparedAssets } from './asset-preparation.domain';
const asset = (): ProductionAsset => ({
  id: 'product',
  kind: 'PRODUCT',
  name: '陶瓷杯',
  description: '白色杯身',
  knownFacts: '陶瓷',
  designNotes: '',
  sourceText: '原资料',
  imageRequirements: '同一对象多视角',
  image: { assetId: 'image', version: 1 },
  manualFields: [],
});
describe('adopted image basis', () => {
  it('does not treat a new image or provenance text as a new visual definition', () => {
    const original = asset();
    expect(
      assetImageBasis({
        ...original,
        image: { assetId: 'replacement', version: 2 },
        sourceText: '新来源位置',
        manualFields: ['description'],
      }),
    ).toBe(assetImageBasis(original));
  });
  it('detects a real appearance change and preserves the adopted image basis during AI asset updates', () => {
    const original = asset();
    original.imageBasis = assetImageBasis(original);
    const changed = { ...asset(), description: '蓝色杯身' };
    const merged = mergePreparedAssets([original], [changed])[0]!;
    expect(merged.image).toEqual(original.image);
    expect(merged.imageBasis).toBe(original.imageBasis);
    expect(assetImageBasis(merged)).not.toBe(original.imageBasis);
  });
});
