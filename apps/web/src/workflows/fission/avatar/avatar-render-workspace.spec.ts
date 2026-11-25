import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvatarRenderTask, AvatarRenderWorkspace } from '@ai-marketing/contracts';
import type { avatarRenderApi } from './avatar.api';
import { createAvatarRenderWorkspace } from './avatar-render-workspace';

const currentSource = {
  artifactId: 'sync',
  revision: 1,
  durationMs: 1500,
  captions: [{ startMs: 50, endMs: 1000, text: '这是口播字幕。' }],
};

function projection(projectId = 'project', workflowRunId = 'run'): AvatarRenderWorkspace {
  return {
    projectId,
    workflowRunId,
    enabled: true,
    canRender: false,
    blockedReason: null,
    draft: null,
    composition: null,
    source: currentSource,
    backgrounds: [],
    task: null,
    output: null,
  };
}

const reply = (data: AvatarRenderWorkspace) => ({ success: true, data });

function fakeApi() {
  let data = projection();
  const api = {
    read: vi.fn<typeof avatarRenderApi.read>(async (projectId, runId) =>
      reply({ ...data, projectId, workflowRunId: runId }),
    ),
    save: vi.fn<typeof avatarRenderApi.save>(async (_, __, body) => {
      const { expectedRevision, ...draft } = body;
      data = { ...data, draft: { ...draft, revision: expectedRevision + 1 } };
      return reply(data);
    }),
    confirm: vi.fn<typeof avatarRenderApi.confirm>(async (_, __, revision) => {
      if (!data.draft || data.draft.revision !== revision) throw new Error('bad draft');
      data = {
        ...data,
        canRender: true,
        composition: { ...data.draft, artifactId: 'composition', revision: 1, stale: false },
      };
      return reply(data);
    }),
    create: vi.fn<typeof avatarRenderApi.create>(async () => reply(data)),
    change: vi.fn<typeof avatarRenderApi.change>(async () => reply(data)),
    archive: vi.fn<typeof avatarRenderApi.archive>(),
  };
  return { api, set: (next: AvatarRenderWorkspace) => (data = next) };
}

const task = (status: AvatarRenderTask['status']): AvatarRenderTask => ({
  id: 'render-task',
  status,
  phase: status === 'AWAITING_REVIEW' ? 'REVIEW' : 'COMPLETE',
  progress: status === 'AWAITING_REVIEW' ? 99 : 100,
  message: '',
  canRetry: status === 'FAILED',
  canCancel: status === 'RUNNING',
  stale: false,
});

describe('avatar render workspace', () => {
  afterEach(() => vi.useRealTimers());

  it('validates more than 32 caption cues and terms beyond 60s only for a long source', async () => {
    const { api, set } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    const captions = Array.from({ length: 36 }, (_, index) => ({
      startMs: index * 1700,
      endMs: index * 1700 + 900,
      text: `第 ${index + 1} 条字幕`,
    }));
    set({ ...projection(), source: { ...currentSource, durationMs: 61_600, captions } });
    state.setScope('project', 'run');
    await Promise.resolve();
    expect(state.validationError.value).toBe('');
    expect(await state.confirm()).toBe(true);
    expect(api.save.mock.calls[0]?.[2].settings.captions).toEqual(captions);
    expect(api.save.mock.calls[0]?.[2].settings.captions.at(-1)?.endMs).toBe(60_400);
    state.dispose();

    set(projection());
    state.setScope('project', 'run');
    await Promise.resolve();
    state.edit({ captions });
    expect(state.validationError.value).not.toBe('');
    expect(await state.flushPendingEdits()).toBe(false);
    expect(api.save).toHaveBeenCalledTimes(1);
    state.dispose();
  });

  it('loads source captions as an editable default, saves once and confirms before rendering', async () => {
    const { api } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    expect(state.editable.value?.settings.captions).toEqual(currentSource.captions);
    expect(api.save).not.toHaveBeenCalled();
    expect(await state.generate()).toBe(false);
    state.edit({ insetPercent: 18 });
    expect(await state.confirm()).toBe(true);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0]?.[2]).toMatchObject({
      expectedRevision: 0,
      sync: { artifactId: 'sync', revision: 1 },
      settings: { insetPercent: 18 },
    });
    expect(api.confirm.mock.calls[0]?.[2]).toBe(1);
    expect(api.create).not.toHaveBeenCalled();
    expect(await state.generate()).toBe(true);
    expect(api.create.mock.calls[0]?.[2].composition).toEqual({
      artifactId: 'composition',
      revision: 1,
    });
    state.dispose();
  });

  it('does not allow invalid cue timing to save or leave the page', async () => {
    const { api } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    state.edit({ captions: [{ startMs: 0, endMs: 1600, text: '字幕' }] });
    expect(state.validationError.value).toContain('音轨时长');
    expect(await state.flushPendingEdits()).toBe(false);
    expect(await state.confirm()).toBe(false);
    expect(api.save).not.toHaveBeenCalled();
    state.dispose();
  });

  it('submits native render only with exact source acceptance and reuses its idempotency key', async () => {
    const { api, set } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    const accepted = { artifactId: currentSource.artifactId, revision: currentSource.revision };
    set({
      ...projection(),
      source: { ...currentSource, mode: 'NATIVE', captions: [] },
    });
    state.setScope('project', 'run');
    await Promise.resolve();
    expect(await state.confirm()).toBe(true);
    expect(await state.generate()).toBe(false);
    expect(await state.generate({ ...accepted, revision: 2 })).toBe(false);
    expect(api.create).not.toHaveBeenCalled();

    api.create.mockRejectedValueOnce(new Error('response unavailable'));
    expect(await state.generate(accepted)).toBe(false);
    expect(await state.generate(accepted)).toBe(true);
    const request = api.create.mock.calls[0]?.[2];
    expect(request?.nativeSourceAccepted).toEqual(accepted);
    expect(api.create.mock.calls[1]?.[2]).toEqual(request);
    state.dispose();
  });

  it('keeps old caption edits bound to their exact source until current timing is applied', async () => {
    const { api, set } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    state.edit({ captions: [{ startMs: 60, endMs: 950, text: '旧字幕修改' }], insetPercent: 16 });
    expect(await state.flushPendingEdits()).toBe(true);
    const nextSource = {
      ...currentSource,
      revision: 2,
      captions: [{ startMs: 100, endMs: 1300, text: '新版口播' }],
    };
    const saved = state.projection.value!;
    set({ ...saved, source: nextSource });
    await state.refresh();
    expect(state.sourceMatches.value).toBe(false);
    expect(state.editable.value?.settings.captions[0]?.text).toBe('旧字幕修改');
    expect(await state.confirm()).toBe(false);
    state.useCurrentSource();
    expect(state.sourceMatches.value).toBe(true);
    expect(state.editable.value?.settings.insetPercent).toBe(16);
    expect(state.editable.value?.settings.captions).toEqual(nextSource.captions);
    expect(await state.confirm()).toBe(true);
    expect(api.save.mock.calls[1]?.[2].sync.revision).toBe(2);
    state.dispose();
  });

  it('does not let a render poll overwrite unsubmitted edits after a remote draft revision', async () => {
    const { api, set } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    state.setScope('project', 'run');
    await Promise.resolve();
    state.edit({ insetPercent: 15 });
    await state.flushPendingEdits();
    state.edit({ insetPercent: 18 });
    const saved = state.projection.value!;
    set({ ...saved, draft: { ...saved.draft!, revision: 2 } });
    await state.refresh();
    expect(state.conflict.value).toBe(true);
    expect(state.editable.value?.settings.insetPercent).toBe(18);
    expect(await state.flushPendingEdits()).toBe(false);
    await state.resolveConflict(true);
    expect(await state.flushPendingEdits()).toBe(true);
    expect(api.save.mock.calls[1]?.[2]).toMatchObject({
      expectedRevision: 2,
      settings: { insetPercent: 18 },
    });
    state.dispose();
  });

  it('restores review state and exposes delivery only when the server publishes an output', async () => {
    vi.useFakeTimers();
    const { api, set } = fakeApi();
    const state = createAvatarRenderWorkspace(api);
    set({ ...projection(), task: task('AWAITING_REVIEW') });
    state.setScope('project', 'run');
    await Promise.resolve();
    expect(state.active.value).toBe(true);
    expect(await state.archive()).toBe(false);
    const archive = { assetId: 'asset', version: 1 };
    const output = {
      artifactId: 'output',
      revision: 2,
      durationMs: 1500,
      stale: false,
      videoUrl: '/api/video',
      subtitlesUrl: '/api/subtitles',
      archive: null,
    };
    api.archive.mockImplementation(async () => {
      set({ ...projection(), task: task('SUCCEEDED'), output: { ...output, archive } });
      return { success: true, data: archive };
    });
    set({ ...projection(), task: task('SUCCEEDED'), output });
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.active.value).toBe(false);
    expect(await state.archive()).toBe(true);
    expect(api.archive.mock.calls[0]?.slice(0, 3)).toEqual(['project', 'run', 2]);
    expect(state.projection.value?.output?.archive).toEqual(archive);
    expect(await state.archive()).toBe(false);
    state.dispose();
  });

  it('drops an in-flight previous project projection', async () => {
    const { api } = fakeApi();
    let resolve: (value: ReturnType<typeof reply>) => void = () => undefined;
    api.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const state = createAvatarRenderWorkspace(api);
    state.setScope('old-project', 'old-run');
    state.setScope('new-project', 'new-run');
    await Promise.resolve();
    resolve(reply({ ...projection('old-project', 'old-run'), task: task('AWAITING_REVIEW') }));
    await Promise.resolve();
    expect(state.projection.value?.workflowRunId).toBe('new-run');
    expect(state.active.value).toBe(false);
    expect(api.read.mock.calls[0]?.[2].aborted).toBe(true);
    state.dispose();
  });
});
