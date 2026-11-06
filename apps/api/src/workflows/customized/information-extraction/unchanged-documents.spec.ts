import { describe, it, expect } from 'vitest';
import { unchangedDocumentIds } from './unchanged-documents';
describe('incremental document extraction cache', () => {
  const doc = {
    assetId: 'a',
    assetVersion: 1,
    storageKey: 'immutable',
    sizeBytes: 100,
    name: 'brief.docx',
  };
  it('retains only exact immutable document versions across two source changes', () => {
    const second = { ...doc, assetId: 'b' };
    expect(unchangedDocumentIds([doc], [doc, second])).toEqual(['a']);
    expect(unchangedDocumentIds([doc, second], [doc, { ...second, assetVersion: 2 }])).toEqual([
      'a',
    ]);
  });
  it.each(['assetId', 'assetVersion', 'storageKey', 'sizeBytes', 'name'] as const)(
    'does not reuse changed %s',
    (key) => {
      const current = { ...doc, [key]: typeof doc[key] === 'number' ? 2 : 'changed' };
      expect(unchangedDocumentIds([doc], [current as typeof doc])).toEqual([]);
    },
  );
});
