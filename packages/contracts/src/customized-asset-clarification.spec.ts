import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMIZED_BRIEF_LABELS } from './customized-extraction';
import { isAssetClarificationProposal } from './customized-asset-clarification';

describe('asset clarification proposal', () => {
  it('matches the Worker fields and separates facts from scoped production requirements', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(__dirname, '../schemas/customized-assets-clarification.schema.json'),
        'utf8',
      ),
    );
    expect(schema.$defs.BriefChange.properties.field.enum.toSorted()).toEqual(
      Object.keys(CUSTOMIZED_BRIEF_LABELS).toSorted(),
    );
    expect(
      isAssetClarificationProposal({
        changes: [
          { field: 'productAppearance', value: '黑色' },
          { field: 'sellingPoints', value: ['便携'] },
        ],
        productionNote: '本次不展示容量',
        questions: [],
      }),
    ).toBe(true);
  });

  it.each([
    {},
    { changes: [], productionNote: '', questions: [''] },
    { changes: [{ field: 'productAppearance', value: [] }], productionNote: '', questions: [] },
    { changes: [{ field: 'sellingPoints', value: '便携' }], productionNote: '', questions: [] },
    { changes: [{ field: '__proto__', value: '黑色' }], productionNote: '', questions: [] },
    {
      changes: Array(2).fill({ field: 'productName', value: '黑色款' }),
      productionNote: '',
      questions: [],
    },
  ])('rejects malformed candidate %#', (value) => {
    expect(isAssetClarificationProposal(value)).toBe(false);
  });
});
