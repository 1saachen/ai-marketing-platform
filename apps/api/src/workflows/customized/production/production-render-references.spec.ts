import { expect, it } from 'vitest';
import type { CustomizedProductionTask } from '../../../generated/prisma/client';
import { presentProductionTask } from './production.repository';

const task = (status: string, references?: object[]) =>
  ({
    id: 'render',
    operation: 'RENDER',
    status,
    shotId: null,
    steps: [],
    errorMessage: null,
    inputSnapshot: {
      videoRender: { clipId: 'clip', settings: {}, ...(references ? { references } : {}) },
    },
    output: null,
  }) as unknown as CustomizedProductionTask;
it('exposes exact image versions and their owner without storage fields', () => {
  const value = presentProductionTask(
    task('FAILED', [
      {
        objectId: 'detail',
        name: '杯盖',
        sourceObjectId: 'cup',
        sourceName: '杯子',
        assetId: 'asset',
        version: 2,
        storageKey: 'private-storage',
        sha256: 'private-hash',
        mimeType: 'private-mime',
        sizeBytes: 123,
      },
    ]),
  );
  expect(value.renderReferences).toEqual([
    {
      objectId: 'detail',
      name: '杯盖',
      sourceObjectId: 'cup',
      sourceName: '杯子',
      assetId: 'asset',
      version: 2,
    },
  ]);
  expect(JSON.stringify(value)).not.toContain('private-');
});
it('distinguishes text-only renders from unavailable historical reference records', () => {
  expect(presentProductionTask(task('FAILED', [])).renderReferences).toEqual([]);
  expect(presentProductionTask(task('FAILED')).renderReferences).toBeUndefined();
  expect(presentProductionTask(task('COMPLETED', [])).renderReferences).toBeUndefined();
});
