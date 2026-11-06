import { describe, it, expect, vi } from 'vitest';
import type { Prisma, WorkingArtifact } from '../../../generated/prisma/client';
import { rebindUnchanged } from './unchanged-media';
function fixture() {
  const source = {
    id: 'source',
    projectId: 'p',
    workflowRunId: 'r',
    artifactKey: 'customized-object:a',
    nodeId: 'SHOT_PROMPT',
    revision: 2,
    contentHash: 'new-hash',
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
  } as WorkingArtifact;
  const row = {
    id: 'target',
    projectId: 'p',
    workflowRunId: 'r',
    nodeId: 'SHOT_RENDER',
    kind: 'STRUCTURED',
    name: '镜头',
    directory: 'SCRIPTS',
    type: 'STORYBOARD_SCRIPT',
    tags: [],
    payload: { visual: '未改画面' },
    metadata: null,
    originalFileName: null,
    mimeType: null,
    sizeBytes: null,
    updatedAt: new Date(0),
    revision: 4,
    files: [],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workingArtifact: {
      findFirst: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([source]),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...row, ...data })),
    },
    workingArtifactDependency: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, source, row };
}
describe('verified unchanged content rebind', () => {
  it('changes only exact source links and fingerprint, preserving business revision and timestamp', async () => {
    const { tx, source, row } = fixture();
    const result = await rebindUnchanged(tx, 'p', 'r', 'target', [source]);
    expect(result.revision).toBe(4);
    expect(result.updatedAt).toEqual(row.updatedAt);
    expect(tx.workingArtifact.update).toHaveBeenCalledWith({
      where: { id: 'target' },
      data: expect.not.objectContaining({ revision: expect.anything() }),
    });
    expect(tx.workingArtifactDependency.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          projectId: 'p',
          workflowRunId: 'r',
          dependentArtifactId: 'target',
          sourceArtifactId: 'source',
          sourceRevision: 2,
          sourceHash: 'new-hash',
        }),
      ],
    });
  });
  it.each(['projectId', 'workflowRunId', 'freshness'] as const)(
    'rejects invalid %s before changing any links',
    async (field) => {
      const { tx, source } = fixture();
      Object.assign(source, { [field]: 'other' });
      await expect(rebindUnchanged(tx, 'p', 'r', 'target', [source])).rejects.toThrow();
      expect(tx.workingArtifactDependency.deleteMany).not.toHaveBeenCalled();
    },
  );
  it('rejects unavailable media instead of clearing stale', async () => {
    const { tx, row, source } = fixture();
    Object.assign(row, { files: [{ fileObject: { status: 'UNAVAILABLE' } }] });
    await expect(rebindUnchanged(tx, 'p', 'r', 'target', [source])).rejects.toThrow('UNAVAILABLE');
    expect(tx.workingArtifact.update).not.toHaveBeenCalled();
  });
});
