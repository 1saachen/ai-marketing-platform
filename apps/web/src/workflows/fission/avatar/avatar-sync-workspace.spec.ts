import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvatarSyncTask, AvatarSyncWorkspace } from '@ai-marketing/contracts';
import type { avatarSyncApi } from './avatar.api';
import {
  avatarSegmentProgress,
  avatarSyncMode,
  createAvatarSyncWorkspace,
} from './avatar-sync-workspace';

const reply = (data: AvatarSyncWorkspace) => ({ success: true, data });

function projection(projectId = 'project', workflowRunId = 'run'): AvatarSyncWorkspace {
  return {
    projectId,
    workflowRunId,
    enabled: true,
    canGenerate: true,
    blockedReason: null,
    task: null,
    result: null,
  };
}

function task(status: AvatarSyncTask['status']): AvatarSyncTask {
  return {
    id: 'sync-task',
    status,
    phase: status === 'QUEUED' ? 'QUEUED' : 'TTS',
    progress: status === 'QUEUED' ? 0 : 10,
    message: '',
    canRetry: status === 'FAILED',
    canCancel: status === 'QUEUED' || status === 'RUNNING',
    stale: false,
  };
}

function fakeApi() {
  return {
    read: vi.fn<typeof avatarSyncApi.read>(async (projectId, runId) =>
      reply(projection(projectId, runId)),
    ),
    create: vi.fn<typeof avatarSyncApi.create>(async (projectId, runId) =>
      reply({ ...projection(projectId, runId), task: task('QUEUED') }),
    ),
    change: vi.fn<typeof avatarSyncApi.change>(async (projectId, runId, _id, action) =>
      reply({
        ...projection(projectId, runId),
        task: task(action === 'cancel' ? 'CANCELLED' : 'QUEUED'),
      }),
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const inputs = {
  expectedDraftRevision: 2,
  binding: { artifactId: 'binding', revision: 1 },
  script: { artifactId: 'script', revision: 3 },
};

describe('native avatar generation', () => {
  const native = { enabled: true, canGenerate: true, blockedReason: null };

  it('defaults new sessions to native and restores the current task mode', () => {
    const available = { ...projection(), native };
    expect(avatarSyncMode(available, null)).toBe('NATIVE');
    expect(avatarSyncMode(available, 'SHORT')).toBe('SHORT');
    expect(avatarSyncMode({ ...available, task: task('RUNNING') }, 'NATIVE')).toBe('SHORT');
    expect(
      avatarSyncMode({ ...available, task: { ...task('SUCCEEDED'), mode: 'NATIVE' } }, null),
    ).toBe('NATIVE');
  });

  it('sends the confirmed inputs and duration with native capability alone', async () => {
    const api = fakeApi();
    api.read.mockResolvedValue(
      reply({ ...projection(), enabled: false, canGenerate: false, native }),
    );
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    expect(
      await state.generate(async () => ({ ...inputs, mode: 'NATIVE', durationSeconds: 30 })),
    ).toBe(true);
    expect(api.create.mock.calls[0]?.[2]).toMatchObject({
      ...inputs,
      mode: 'NATIVE',
      durationSeconds: 30,
    });
    state.dispose();
  });

  it('honors a revoked native source before submitting even when short generation is available', async () => {
    const api = fakeApi();
    api.read.mockResolvedValue(
      reply({
        ...projection(),
        native: { ...native, canGenerate: false, blockedReason: '形象图片授权已失效' },
      }),
    );
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    expect(
      await state.generate(async () => ({ ...inputs, mode: 'NATIVE', durationSeconds: 4 })),
    ).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
    expect(state.error.value).toBe('形象图片授权已失效');
    state.dispose();
  });
});

describe('segmented avatar synchronization', () => {
  it('projects server segment progress, failures and completion without selecting a new task', () => {
    const active = {
      ...task('RUNNING'),
      mode: 'SEGMENTED' as const,
      segments: { total: 4, completed: 2, activeOrdinal: 3, failedOrdinal: null },
    };
    expect(avatarSegmentProgress(active)).toBe('已完成 2/4 段 · 正在处理第 3 段');
    expect(
      avatarSegmentProgress({
        ...active,
        status: 'FAILED',
        segments: { ...active.segments, activeOrdinal: null, failedOrdinal: 3 },
      }),
    ).toBe('已完成 2/4 段 · 第 3 段失败');
    expect(
      avatarSegmentProgress({
        ...active,
        status: 'SUCCEEDED',
        segments: { ...active.segments, completed: 4, activeOrdinal: null },
      }),
    ).toBe('已完成 4/4 段');
    expect(avatarSegmentProgress(task('RUNNING'))).toBe('');
  });

  it('uses fresh scoped long availability and submits the full confirmed revision with explicit mode', async () => {
    const api = fakeApi();
    api.read.mockResolvedValue(
      reply({
        ...projection(),
        canGenerate: false,
        blockedReason: '文案超过短片字数',
        long: { enabled: true, canGenerate: true, blockedReason: null },
      }),
    );
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    expect(await state.generate(async () => ({ ...inputs, mode: 'SEGMENTED' }))).toBe(true);
    expect(api.create.mock.calls[0]?.[2]).toMatchObject({ ...inputs, mode: 'SEGMENTED' });
    state.dispose();
  });

  it('never falls back to paid short creation when the selected long mode is blocked', async () => {
    const api = fakeApi();
    api.read.mockResolvedValue(
      reply({
        ...projection(),
        long: { enabled: true, canGenerate: false, blockedReason: '当前素材不支持长片分段' },
      }),
    );
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    expect(await state.generate(async () => ({ ...inputs, mode: 'SEGMENTED' }))).toBe(false);
    expect(state.error.value).toBe('当前素材不支持长片分段');
    expect(api.create).not.toHaveBeenCalled();
    state.dispose();
  });
});

describe('avatar sync workspace', () => {
  afterEach(() => vi.useRealTimers());

  it('restores a running task, polls the same scope and releases the timer on disposal', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    api.read.mockResolvedValue(reply({ ...projection(), task: task('RUNNING') }));
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    expect(state.active.value).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(api.read.mock.calls[1]?.slice(0, 2)).toEqual(['project', 'run']);
    state.dispose();
    await vi.advanceTimersByTimeAsync(2500);
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(api.read.mock.calls[1]?.[2].aborted).toBe(true);
  });

  it('drops a delayed projection from a previous run of the same project', async () => {
    const api = fakeApi();
    const old = deferred<ReturnType<typeof reply>>();
    api.read.mockImplementationOnce(() => old.promise);
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'previous-run');
    state.setScope('project', 'new-run');
    await Promise.resolve();
    old.resolve(reply({ ...projection('project', 'previous-run'), task: task('RUNNING') }));
    await old.promise;
    expect(state.projection.value?.workflowRunId).toBe('new-run');
    expect(state.active.value).toBe(false);
    expect(api.read.mock.calls[0]?.[2].aborted).toBe(true);
    state.dispose();
  });

  it('sends only confirmed dependencies after draft flush, reusing the key for a lost reply', async () => {
    const api = fakeApi();
    api.create.mockRejectedValueOnce(new Error('network error'));
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    const prepared = deferred<typeof inputs>();
    const attempt = state.generate(() => prepared.promise);
    await Promise.resolve();
    expect(api.create).not.toHaveBeenCalled();
    prepared.resolve(inputs);
    expect(await attempt).toBe(false);
    expect(await state.generate(async () => inputs)).toBe(true);
    expect(api.create.mock.calls[0]?.[2]).toMatchObject(inputs);
    expect(api.create.mock.calls[1]?.[2]).toEqual(api.create.mock.calls[0]?.[2]);
    state.dispose();
  });

  it('blocks generation when the refreshed persisted inputs are unavailable', async () => {
    const api = fakeApi();
    api.read
      .mockResolvedValueOnce(reply(projection()))
      .mockResolvedValue(
        reply({ ...projection(), canGenerate: false, blockedReason: '音色不可用' }),
      );
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    expect(await state.generate(async () => inputs)).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
    expect(state.error.value).toBe('音色不可用');
    state.dispose();
  });

  it('does not let a poll started before cancellation restore the old task', async () => {
    const api = fakeApi();
    const old = deferred<ReturnType<typeof reply>>();
    api.read
      .mockResolvedValueOnce(reply({ ...projection(), task: task('RUNNING') }))
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(reply({ ...projection(), task: task('CANCELLED') }));
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    const pendingRead = state.refresh();
    expect(await state.change('cancel')).toBe(true);
    old.resolve(reply({ ...projection(), task: task('RUNNING') }));
    await pendingRead;
    expect(state.projection.value?.task?.status).toBe('CANCELLED');
    state.dispose();
  });

  it('withholds a result until its freshness is checked again after source changes', async () => {
    const api = fakeApi();
    const result = {
      artifactId: 'result',
      revision: 1,
      stale: false,
      durationMs: 500,
      audioUrl: '/api/audio',
      videoUrl: '/api/video',
      wordTimings: [],
    };
    const refresh = deferred<ReturnType<typeof reply>>();
    api.read
      .mockResolvedValueOnce(reply({ ...projection(), result }))
      .mockImplementationOnce(() => refresh.promise);
    const state = createAvatarSyncWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    expect(state.sourceVerified.value).toBe(true);
    const reading = state.refreshForSourceChange();
    expect(state.sourceVerified.value).toBe(false);
    refresh.resolve(reply({ ...projection(), result: { ...result, stale: true } }));
    await reading;
    expect(state.sourceVerified.value).toBe(true);
    expect(state.projection.value?.result?.stale).toBe(true);
    state.dispose();
  });
});
