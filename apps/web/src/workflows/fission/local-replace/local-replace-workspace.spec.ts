import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyLocalReplaceDraft,
  type ApiResponse,
  type LocalReplaceTask,
  type LocalReplaceWorkspace,
} from '@ai-marketing/contracts';
import { ApiClientError } from '../../../api/http-client';
import type { localReplaceApi } from './local-replace.api';
import { createLocalReplaceWorkspace } from './local-replace-workspace';

const projectId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000001';
const source = { assetId: '30000000-0000-4000-8000-000000000001', version: 2 };
const target = { assetId: '30000000-0000-4000-8000-000000000002', version: 3 };
const draft = {
  ...emptyLocalReplaceDraft(),
  source,
  target,
  endMs: 7000,
  objectDescription: '粉色小瓶',
  sourceRightsConfirmed: true,
};
const result = <T>(data: T): ApiResponse<T> => ({ success: true, data: structuredClone(data) });
const task: LocalReplaceTask = {
  id: '40000000-0000-4000-8000-000000000001',
  status: 'QUEUED',
  progress: 0,
  source,
  startMs: 0,
  endMs: 7000,
  result: null,
  canRetry: false,
  stale: false,
  message: '等待处理',
  createdAt: '2026-11-20T00:00:00Z',
};
const data = (tasks: LocalReplaceTask[] = []): LocalReplaceWorkspace => ({
  runId,
  draftRevision: 2,
  draft,
  tasks,
});

function setup(tasks: LocalReplaceTask[] = []) {
  const api = {
    open: vi.fn<typeof localReplaceApi.open>().mockResolvedValue(result(data(tasks))),
    read: vi.fn<typeof localReplaceApi.read>().mockResolvedValue(result(data(tasks))),
    save: vi
      .fn<typeof localReplaceApi.save>()
      .mockImplementation(async (_p, _r, body) =>
        result({ ...data(tasks), draft: body.draft, draftRevision: body.expectedRevision + 1 }),
      ),
    create: vi.fn<typeof localReplaceApi.create>().mockResolvedValue(result(data([task]))),
    change: vi
      .fn<typeof localReplaceApi.change>()
      .mockResolvedValue(result(data([{ ...task, status: 'CANCELLED' }]))),
  };
  const workspace = createLocalReplaceWorkspace(api);
  disposals.push(workspace.dispose);
  return { api, workspace };
}

const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

describe('local replacement workspace', () => {
  it('saves navigation and exact draft versions before explicit generation', async () => {
    const { api, workspace } = setup();
    await workspace.open(projectId);
    workspace.edit({ nodeId: 'LOCAL_REPLACE_RANGE', startMs: 1000, endMs: 4000 });
    expect(await workspace.flushPendingEdits()).toBe(true);
    expect(api.save.mock.calls[0]?.[2]).toEqual({
      expectedRevision: 2,
      draft: { ...draft, nodeId: 'LOCAL_REPLACE_RANGE', startMs: 1000, endMs: 4000 },
    });
    expect(api.create).not.toHaveBeenCalled();
    workspace.edit({ nodeId: 'LOCAL_REPLACE_OUTPUT', instruction: '保持背景' });
    expect(await workspace.create()).toBe(true);
    expect(api.create.mock.calls[0]?.[2].expectedRevision).toBe(4);
    expect(api.save.mock.calls[1]?.[2].draft.source).toEqual(source);
    expect(api.save.mock.calls[1]?.[2].draft.target).toEqual(target);
  });

  it('keeps local edits during polling and uses the saved revision on the next write', async () => {
    vi.useFakeTimers();
    const { api, workspace } = setup([task]);
    api.read.mockResolvedValue(
      result({ ...data([{ ...task, status: 'RUNNING', progress: 60 }]), draftRevision: 20 }),
    );
    await workspace.open(projectId);
    workspace.edit({ objectDescription: '另一侧的亚光方盒' });
    await workspace.refresh();
    expect(workspace.state.data?.tasks[0]?.progress).toBe(60);
    expect(workspace.state.data?.draftRevision).toBe(2);
    expect(workspace.state.draft?.objectDescription).toBe('另一侧的亚光方盒');
    await workspace.flushPendingEdits();
    expect(api.save.mock.calls[0]?.[2].expectedRevision).toBe(2);
  });

  it('retains both old and newly typed changes across a delayed save', async () => {
    const { api, workspace } = setup();
    let finishFirst: ((response: ApiResponse<LocalReplaceWorkspace>) => void) | undefined;
    api.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    await workspace.open(projectId);
    workspace.edit({ startMs: 900 });
    const saving = workspace.flushPendingEdits();
    workspace.edit({ endMs: 4200 });
    finishFirst?.(result({ ...data(), draft: { ...draft, startMs: 900 }, draftRevision: 3 }));
    expect(await saving).toBe(true);
    expect(api.save.mock.calls[1]?.[2]).toEqual({
      expectedRevision: 3,
      draft: { ...draft, startMs: 900, endMs: 4200 },
    });
  });

  it('reuses the task key after an uncertain create response and keeps task data on refresh', async () => {
    const { api, workspace } = setup();
    api.create.mockRejectedValueOnce(new TypeError('connection reset'));
    api.read.mockResolvedValue(result(data([task])));
    await workspace.open(projectId);
    expect(await workspace.create()).toBe(false);
    expect(await workspace.create()).toBe(true);
    expect(api.create.mock.calls[0]?.[2]).toEqual(api.create.mock.calls[1]?.[2]);
    expect(workspace.state.data?.tasks[0]?.id).toBe(task.id);
    expect(await workspace.create()).toBe(false);
  });

  it('keeps an editing conflict and skips task creation until the draft is reconciled', async () => {
    const { api, workspace } = setup();
    api.save.mockRejectedValue(new ApiClientError('版本不一致', 409));
    await workspace.open(projectId);
    workspace.edit({ instruction: '当前位置希望留一列文字' });
    expect(await workspace.create()).toBe(false);
    expect(workspace.state.conflict).toBe(true);
    expect(workspace.state.draft?.instruction).toBe('当前位置希望留一列文字');
    expect(api.create).not.toHaveBeenCalled();
  });
});
