import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushAndPauseWorkflowRun } from './project-workflow-pause';

afterEach(() => vi.unstubAllGlobals());

const ok = () =>
  new Response(JSON.stringify({ success: true, data: { paused: true } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('project workflow pause precondition', () => {
  it('captures all clone node revisions after flushing and does not share the mutable map', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const revisions = { CLONE_INPUT: 1, CLONE_ANALYSIS: 2, CLONE_MAPPING: 3 };
    await flushAndPauseWorkflowRun('project-a', {
      flushPendingEdits: async () => {
        revisions.CLONE_MAPPING = 4;
        return true;
      },
      workflowRunId: 'run-clone',
      cloneDraftRevision: 1,
      cloneDraftRevisions: revisions,
    });
    revisions.CLONE_MAPPING = 5;
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      expectedCloneDraftRevisions: { CLONE_INPUT: 1, CLONE_ANALYSIS: 2, CLONE_MAPPING: 4 },
    });
  });

  it('freezes the flushed clone revision in a delayed request after the Run resumes', async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const node = {
      flushPendingEdits: vi.fn(async () => true),
      workflowRunId: 'run/clone',
      cloneDraftRevision: 7,
    };
    const exiting = flushAndPauseWorkflowRun('project/one', node);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Restoring the same Run fences the pending exit with a new server draft revision.
    node.cloneDraftRevision = 8;
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/projects/project%2Fone/workflow-runs/run%2Fclone/pause',
    );
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      expectedCloneDraftRevision: 7,
    });
    complete(
      new Response(
        JSON.stringify({ success: false, error: { code: 'CONFLICT', message: '草稿版本已更新' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(exiting).rejects.toMatchObject({ status: 409 });
    expect(node.cloneDraftRevision).toBe(8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing request shape for other workflows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    await flushAndPauseWorkflowRun('project-a', {
      flushPendingEdits: async () => true,
      workflowRunId: 'run-effect',
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();
  });

  it('does not send pause before a failed flush or without a real Run', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      flushAndPauseWorkflowRun('project-a', {
        flushPendingEdits: async () => false,
        workflowRunId: 'run-clone',
        cloneDraftRevision: 3,
      }),
    ).rejects.toThrow('仍有编辑未能自动保存');
    await flushAndPauseWorkflowRun('project-a', {
      flushPendingEdits: async () => true,
      workflowRunId: '',
      cloneDraftRevision: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
