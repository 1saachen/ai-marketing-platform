import { describe, expect, it, vi } from 'vitest';
import { emptyAvatarDraft, type AvatarWorkspaceData } from '@ai-marketing/contracts';
import { ApiClientError } from '../../../api/http-client';
import { createAvatarWorkspace } from './avatar-workspace';
import type { avatarApi } from './avatar.api';

function workspace(projectId = 'project-one', revision = 0) {
  return {
    projectId,
    workflowRunId: `run-for-${projectId}`,
    runStatus: 'ACTIVE',
    draft: { revision, data: emptyAvatarDraft() },
    binding: null,
    script: null,
    characters: [],
    voices: [],
  } satisfies AvatarWorkspaceData;
}

const reply = (data: AvatarWorkspaceData) => ({ success: true, data });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeApi() {
  return {
    open: vi.fn<typeof avatarApi.open>(async (projectId) => reply(workspace(projectId))),
    read: vi.fn<typeof avatarApi.read>(async (projectId) => reply(workspace(projectId))),
    save: vi.fn<typeof avatarApi.save>(async (projectId, _runId, body) => {
      const data = workspace(projectId, body.expectedRevision + 1);
      return reply({ ...data, draft: { ...data.draft, data: body.draft } });
    }),
    confirm: vi.fn<typeof avatarApi.confirm>(async (projectId) => reply(workspace(projectId))),
  };
}

describe('avatar workspace', () => {
  it('ignores a late workspace response from a previous project', async () => {
    const api = fakeApi();
    const delayed = deferred<ReturnType<typeof reply>>();
    api.open.mockImplementationOnce(() => delayed.promise);
    const state = createAvatarWorkspace(api);
    const old = state.open('old-project');
    await state.open('new-project');
    delayed.resolve(reply(workspace('old-project')));
    await old;
    expect(api.open.mock.calls[0]?.[1].aborted).toBe(true);
    expect(state.workspace.value?.projectId).toBe('new-project');
    state.dispose();
  });

  it('saves edits made during an in-flight request before confirming against the latest revision', async () => {
    const api = fakeApi();
    const delayed = deferred<ReturnType<typeof reply>>();
    api.save.mockImplementationOnce(() => delayed.promise);
    const state = createAvatarWorkspace(api);
    await state.open('project-one');

    state.edit({ scriptText: '第一版' });
    const flushing = state.flushPendingEdits();
    await Promise.resolve();
    state.edit({ scriptText: '第二版' });
    const confirming = state.confirm('script');
    expect(api.confirm).not.toHaveBeenCalled();

    const previous = workspace('project-one', 1);
    delayed.resolve(
      reply({
        ...previous,
        draft: { ...previous.draft, data: { ...emptyAvatarDraft(), scriptText: '第一版' } },
      }),
    );
    expect(await flushing).toBe(true);
    expect(await confirming).toBe(true);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1]?.[2]).toMatchObject({
      expectedRevision: 1,
      draft: { scriptText: '第二版' },
    });
    expect(api.confirm.mock.calls[0]?.[3]).toEqual({ expectedRevision: 2 });
    state.dispose();
  });

  it('keeps local edits at a conflict and merges only edited fields after explicit recovery', async () => {
    const api = fakeApi();
    api.save.mockRejectedValueOnce(new ApiClientError('草稿版本冲突', 409, { code: 'CONFLICT' }));
    const server = workspace('project-one', 5);
    const serverVoice = { assetId: 'server-voice', version: 3 };
    server.draft.data.voice = serverVoice;
    api.read.mockResolvedValueOnce(reply(server));
    const state = createAvatarWorkspace(api);
    await state.open('project-one');

    state.edit({ scriptText: '我的文案', scriptSource: 'TXT' });
    expect(await state.flushPendingEdits()).toBe(false);
    expect(state.conflict.value).toBe(true);
    expect(state.draft.value?.scriptText).toBe('我的文案');

    await state.resolveConflict(true);
    expect(state.conflict.value).toBe(false);
    expect(state.draft.value).toMatchObject({ voice: serverVoice, scriptText: '我的文案' });
    expect(api.save.mock.calls[1]?.[2]?.expectedRevision).toBe(5);
    expect(state.workspace.value?.draft.revision).toBe(6);
    state.dispose();
  });

  it('only resumes a paused Run during explicit conflict recovery', async () => {
    const api = fakeApi();
    api.save.mockRejectedValueOnce(new ApiClientError('工作流已暂停', 409, { code: 'CONFLICT' }));
    api.read.mockResolvedValueOnce(reply({ ...workspace('project-one', 2), runStatus: 'PAUSED' }));
    const state = createAvatarWorkspace(api);
    await state.open('project-one');
    state.edit({ scriptText: '保留当前文案' });

    expect(await state.flushPendingEdits()).toBe(false);
    expect(api.open).toHaveBeenCalledTimes(1);
    api.open.mockResolvedValueOnce(reply(workspace('project-one', 3)));
    await state.resolveConflict(true);

    expect(api.open).toHaveBeenCalledTimes(2);
    expect(api.open.mock.calls[1]?.[2]).toBe('run-for-project-one');
    expect(api.save.mock.calls[1]?.[2]).toMatchObject({
      expectedRevision: 3,
      draft: { scriptText: '保留当前文案' },
    });
    expect(state.conflict.value).toBe(false);
    state.dispose();
  });

  it('keeps edits if the resumed Run no longer matches the draft scope', async () => {
    const api = fakeApi();
    api.save.mockRejectedValueOnce(new ApiClientError('工作流已暂停', 409, { code: 'CONFLICT' }));
    api.read.mockResolvedValueOnce(reply({ ...workspace('project-one', 2), runStatus: 'PAUSED' }));
    const state = createAvatarWorkspace(api);
    await state.open('project-one');
    state.edit({ scriptText: '保留当前文案' });

    expect(await state.flushPendingEdits()).toBe(false);
    api.open.mockResolvedValueOnce(reply({ ...workspace(), workflowRunId: 'another-run' }));
    await state.resolveConflict(true);

    expect(api.save).toHaveBeenCalledTimes(1);
    expect(state.draft.value?.scriptText).toBe('保留当前文案');
    expect(state.conflict.value).toBe(true);
    state.dispose();
  });

  it('distinguishes no project and disabled capability without restoring demo state', async () => {
    const api = fakeApi();
    const state = createAvatarWorkspace(api);
    await state.open('');
    expect(api.open).not.toHaveBeenCalled();

    api.open.mockRejectedValueOnce(new ApiClientError('暂未启用', 503));
    await state.open('project-one');
    expect(state.unavailable.value).toBe(true);
    expect(state.workspace.value).toBeNull();
    expect(state.draft.value).toBeNull();
    expect(await state.flushPendingEdits()).toBe(true);
    state.dispose();
  });
});
