import { expect, it, vi } from 'vitest';
import type {
  CustomizedProductionTask,
  Prisma,
  WorkingArtifact,
} from '../../../generated/prisma/client';
import { resolveLocalMediaBatch } from './local-media-batch';

const task = (id: string, status: string, time: number, operation = 'RENDER') =>
  ({
    id,
    projectId: 'project',
    workflowRunId: 'run',
    operation,
    status,
    createdAt: new Date(time),
    updatedAt: new Date(time),
    output: null,
    inputSnapshot: {
      target: { kind: 'CLIP', id: 'clip' },
      incremental: { version: 1, batchKey: 'batch', targetIds: ['clip'] },
    },
  }) as unknown as CustomizedProductionTask;
const artifact = (payload: object, freshness = 'CURRENT', operation = 'RENDER') =>
  ({
    artifactKey:
      operation === 'RENDER' ? 'customized-clip-video:clip' : 'customized-clip-prompt:clip',
    payload,
    availability: 'AVAILABLE',
    freshness,
  }) as WorkingArtifact;
const resolve = async (
  latest: CustomizedProductionTask,
  completed: CustomizedProductionTask | null,
  artifacts: WorkingArtifact[],
  original = task('original', 'FAILED', 100),
) => {
  const findFirst = vi.fn().mockResolvedValueOnce(latest).mockResolvedValueOnce(completed);
  const tx = { customizedProductionTask: { findFirst } } as unknown as Prisma.TransactionClient;
  return {
    result: await resolveLocalMediaBatch(tx, 'project', 'run', [original], artifacts),
    findFirst,
  };
};

it('counts a newer saved video without changing the failed history', async () => {
  const original = task('original', 'FAILED', 100);
  const saved = task('saved', 'COMPLETED', 200);
  const { result, findFirst } = await resolve(
    saved,
    saved,
    [artifact({ taskId: saved.id })],
    original,
  );
  expect(result?.batch.items).toEqual([
    { originalTaskId: original.id, taskId: saved.id, targetId: 'clip', status: 'COMPLETED' },
  ]);
  expect(original.status).toBe('FAILED');
  expect(findFirst.mock.calls[0]![0].where).toMatchObject({
    projectId: 'project',
    workflowRunId: 'run',
    operation: 'RENDER',
    inputSnapshot: { path: ['target', 'id'], equals: 'clip' },
  });
});

it('keeps a currently saved success when a later attempt fails', async () => {
  const failed = task('latest-failed', 'FAILED', 300);
  const saved = task('saved', 'COMPLETED', 200);
  const { result } = await resolve(failed, saved, [artifact({ taskId: saved.id })]);
  expect(result?.batch.items[0]?.status).toBe('COMPLETED');
  expect(result?.tasks.map((t) => t.id)).toContain(failed.id);
});

it.each(['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'])(
  'shows the actual %s attempt while no new result is saved',
  async (status) => {
    const latest = task('latest', status, 200);
    const { result } = await resolve(latest, null, [artifact({ taskId: 'older-video' })]);
    expect(result?.batch.items[0]).toMatchObject({ taskId: 'latest', status });
  },
);

it('does not count an older video or a stale output as a recovery', async () => {
  const old = task('old', 'COMPLETED', 50);
  const failed = task('new-failed', 'FAILED', 200);
  expect(
    (await resolve(failed, old, [artifact({ taskId: old.id })])).result?.batch.items[0]?.status,
  ).toBe('FAILED');
  const saved = task('saved', 'COMPLETED', 200);
  expect(
    (await resolve(saved, saved, [artifact({ taskId: saved.id }, 'STALE')])).result?.batch.items[0]
      ?.status,
  ).toBe('STALE');
});

it('recognizes a completed render that reused the identical saved video', async () => {
  const saved = task('same-video', 'COMPLETED', 200);
  const video = { taskId: 'older-file-task', fileObjectId: 'file', width: 1280 };
  saved.output = { video };
  expect((await resolve(saved, saved, [artifact(video)])).result?.batch.items[0]?.status).toBe(
    'COMPLETED',
  );
});

it('matches a new prompt with its confirmed current text', async () => {
  const original = task('original', 'FAILED', 100, 'PROMPT');
  const saved = task('saved', 'COMPLETED', 200, 'PROMPT');
  const prompt = { target: { kind: 'CLIP', id: 'clip' }, content: '新的提示词', assetIds: [] };
  saved.output = { final: prompt };
  expect(
    (await resolve(saved, saved, [artifact(prompt, 'CURRENT', 'PROMPT')], original)).result?.batch
      .items[0]?.status,
  ).toBe('COMPLETED');
  expect(
    (
      await resolve(
        saved,
        saved,
        [artifact({ ...prompt, content: '另一版' }, 'CURRENT', 'PROMPT')],
        original,
      )
    ).result?.batch.items[0]?.status,
  ).toBe('STALE');
});

it('skips legacy tasks without clip targets', async () => {
  const old = task('old', 'FAILED', 100);
  old.inputSnapshot = { incremental: { batchKey: 'batch' } };
  expect(
    await resolveLocalMediaBatch({} as Prisma.TransactionClient, 'project', 'run', [old], []),
  ).toBeUndefined();
});
