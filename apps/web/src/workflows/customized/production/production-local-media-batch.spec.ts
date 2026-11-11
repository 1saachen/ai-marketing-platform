import { expect, it } from 'vitest';
import type { ProductionTask, ProductionWorkspace } from '@ai-marketing/contracts';
import { localMediaBatchItems } from './production-local-media-batch';

const failed = {
  id: 'old',
  operation: 'RENDER',
  status: 'FAILED',
  progress: 25,
  target: { kind: 'CLIP', id: 'clip' },
  incremental: { version: 1, batchKey: 'batch', targetIds: ['clip'] },
} as ProductionTask;
const workspace = (status: ProductionTask['status'] | 'STALE' = 'COMPLETED') =>
  ({
    tasks: [{ ...failed, id: 'new', status: 'COMPLETED', progress: 100 }, failed],
    localMediaBatch: {
      key: 'batch',
      operation: 'RENDER',
      items: [{ originalTaskId: 'old', taskId: 'new', targetId: 'clip', status }],
    },
  }) as ProductionWorkspace;

it('uses the server-confirmed current outcome and preserves the old task', () => {
  const value = workspace();
  expect(localMediaBatchItems(value, failed)[0]).toMatchObject({
    task: { id: 'new' },
    status: 'COMPLETED',
    progress: 100,
  });
  expect(value.tasks[1]?.status).toBe('FAILED');
});
it('shows newly queued generation before the next workspace read', () => {
  const value = workspace('FAILED');
  value.tasks.unshift({ ...failed, id: 'newest', status: 'QUEUED', progress: 0 });
  expect(localMediaBatchItems(value, failed)[0]).toMatchObject({
    task: { id: 'newest' },
    status: 'QUEUED',
  });
});
it('keeps stale results pending and falls back for historical workspaces', () => {
  expect(localMediaBatchItems(workspace('STALE'), failed)[0]).toMatchObject({
    status: 'STALE',
    progress: 0,
  });
  const value = workspace();
  delete value.localMediaBatch;
  expect(localMediaBatchItems(value, failed).map((item) => item.status)).toEqual([
    'COMPLETED',
    'FAILED',
  ]);
});
it('keeps current completions when another generation is running', () => {
  const value = workspace();
  value.tasks.unshift({ ...failed, id: 'another', status: 'RUNNING' });
  expect(localMediaBatchItems(value, failed)[0]?.status).toBe('COMPLETED');
});
