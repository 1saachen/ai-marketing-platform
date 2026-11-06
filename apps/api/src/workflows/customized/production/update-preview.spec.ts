import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { updatePreview } from './update-preview';
const row = (key: string, payload: unknown = {}, freshness = 'CURRENT') => ({
  id: key,
  artifactKey: key,
  projectId: 'p',
  workflowRunId: 'r',
  payload,
  freshness,
  availability: 'AVAILABLE',
  revision: 1,
  contentHash: key,
  name: key,
  dependencies: [],
});
function fixture() {
  const rows = [
    row('customized-script:s'),
    row('customized-brief'),
    row('customized-asset-catalog', {
      assets: [{ id: 'product', image: { assetId: 'new-image', version: 2 } }],
    }),
    row('customized-video-plan', {
      schemaVersion: 2,
      assets: [],
      videoPlan: {
        sources: [],
        clips: [
          { id: 'a', title: '产品镜头' },
          { id: 'b', title: '风景镜头' },
        ],
      },
    }),
    row('customized-video-clip:a'),
    row('customized-video-clip:b'),
    row('customized-clip-prompt:a'),
    row('customized-clip-prompt:b'),
    row('customized-clip-video:a', { taskId: 'ta' }),
    row('customized-clip-video:b', { taskId: 'tb' }),
  ];
  const tx = {
    workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'r', forkScriptId: 's' }) },
    project: { count: vi.fn().mockResolvedValue(0) },
    workingArtifact: { findMany: vi.fn().mockResolvedValue(rows) },
    workflowNodeState: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    customizedStoryboardTask: { findFirst: vi.fn().mockResolvedValue(null) },
    customizedProductionTask: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        inputSnapshot: {
          videoRender: {
            references:
              where.id === 'ta' ? [{ objectId: 'product', assetId: 'old-image', version: 1 }] : [],
          },
        },
      })),
    },
  };
  return {
    rows,
    latestScriptTask: tx.customizedStoryboardTask.findFirst,
    tx: tx as unknown as Prisma.TransactionClient,
  };
}
describe('read-only customized update preview', () => {
  it('identifies only videos that actually consumed the replaced image', async () => {
    const { tx } = fixture();
    const result = await updatePreview(tx, 'p', 'r', 'RENDER');
    expect(result.items.map((i) => i.id)).toEqual(['a']);
    expect(result.blockers).toEqual([]);
    expect(result.calls).toEqual(['VIDEO']);
  });
  it('resolves an upstream edit path from its own inherited script, without a fork marker', async () => {
    const { tx, rows } = fixture();
    vi.mocked(tx.workflowRun.findFirst).mockResolvedValue({ id: 'r', forkScriptId: null } as never);
    rows.find((r) => r.artifactKey === 'customized-brief')!.revision = 2;
    rows.find((r) => r.artifactKey === 'customized-script:s')!.freshness = 'STALE';
    const preview = await updatePreview(tx, 'p', 'r', 'SCRIPT', 's');
    expect(preview.items.map((i) => i.id)).toEqual(['s']);
    expect(preview.blockers).toEqual([]);
    rows.find((r) => r.artifactKey === 'customized-script:s')!.freshness = 'CURRENT';
    expect((await updatePreview(tx, 'p', 'r', 'ASSETS')).blockers).toEqual([]);
  });
  it('is stable across reads and changes when a second source revision arrives', async () => {
    const { tx, rows } = fixture();
    const first = await updatePreview(tx, 'p', 'r', 'RENDER');
    expect((await updatePreview(tx, 'p', 'r', 'RENDER')).fingerprint).toBe(first.fingerprint);
    rows[0]!.revision = 2;
    expect((await updatePreview(tx, 'p', 'r', 'RENDER')).fingerprint).not.toBe(first.fingerprint);
  });
  it('does not manufacture missing downstream work and identifies legacy baselines', async () => {
    const { tx, rows } = fixture();
    rows.splice(
      rows.findIndex((r) => r.artifactKey === 'customized-video-plan'),
      1,
    );
    const result = await updatePreview(tx, 'p', 'r', 'SHOTS');
    expect(result.items).toEqual([]);
    expect(result.blockers.join()).toContain('可靠');
  });
  it('keeps a current pending script candidate but allows another round after its source changes', async () => {
    const { tx, rows, latestScriptTask } = fixture();
    const brief = rows.find((r) => r.artifactKey === 'customized-brief')!;
    latestScriptTask.mockResolvedValue({
      id: 'pending',
      status: 'COMPLETED',
      inputSnapshot: {
        source: {
          artifactId: brief.id,
          revision: brief.revision,
          fingerprint: brief.contentHash,
        },
        incremental: { scriptId: 's', baselineRevision: 1 },
      },
      steps: [{ nodeId: 'SAVE', output: { applied: false } }],
    });
    expect((await updatePreview(tx, 'p', 'r', 'SCRIPT', 's')).blockers.join()).toContain('候选');
    brief.revision = 2;
    const second = await updatePreview(tx, 'p', 'r', 'SCRIPT', 's');
    expect(second.blockers).toEqual([]);
    expect(second.items.map((i) => i.id)).toEqual(['s']);
  });
  it('rejects an unavailable project before reading business content', async () => {
    const { tx } = fixture();
    vi.mocked(tx.workflowRun.findFirst).mockResolvedValue(null);
    await expect(updatePreview(tx, 'other', 'r', 'RENDER')).rejects.toThrow();
    expect(tx.workingArtifact.findMany).not.toHaveBeenCalled();
  });
});
