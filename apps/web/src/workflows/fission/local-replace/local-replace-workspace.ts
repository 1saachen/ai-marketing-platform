import { computed, reactive, ref } from 'vue';
import type {
  LocalReplaceDraft,
  LocalReplaceTask,
  LocalReplaceWorkspace,
} from '@ai-marketing/contracts';
import { ApiClientError, safeApiErrorMessage } from '../../../api/http-client';
import { localReplaceApi } from './local-replace.api';

function copyDraft(draft: LocalReplaceDraft): LocalReplaceDraft {
  return {
    ...draft,
    source: draft.source && { ...draft.source },
    target: draft.target && { ...draft.target },
  };
}

export const localReplaceTaskActive = (task: LocalReplaceTask) =>
  task.status === 'QUEUED' || task.status === 'RUNNING';

export function createLocalReplaceWorkspace(api = localReplaceApi) {
  const state = reactive({
    data: null as LocalReplaceWorkspace | null,
    draft: null as LocalReplaceDraft | null,
    loading: false,
    saving: false,
    acting: false,
    conflict: false,
    error: '',
    pollError: '',
  });
  const taskActive = computed(() => state.data?.tasks.some(localReplaceTaskActive) ?? false);
  const savedDraft = ref(JSON.stringify(null));
  const dirty = computed(() => JSON.stringify(state.draft) !== savedDraft.value);
  let projectId = '';
  let scope: AbortController | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSave: Promise<boolean> | undefined;
  let pendingPoll: Promise<void> | undefined;
  let taskMutation = 0;
  let attempt: { revision: number; key: string } | undefined;

  function stopTimers() {
    clearTimeout(saveTimer);
    clearTimeout(pollTimer);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (taskActive.value && !scope?.signal.aborted) {
      pollTimer = setTimeout(() => void refresh(), 2500);
    }
  }

  function apply(data: LocalReplaceWorkspace) {
    state.data = data;
    state.draft = copyDraft(data.draft);
    savedDraft.value = JSON.stringify(data.draft);
    schedulePoll();
  }

  async function open(id: string) {
    if (id === projectId && state.loading) return;
    stopTimers();
    scope?.abort();
    projectId = id;
    const requestScope = new AbortController();
    scope = requestScope;
    pendingSave = undefined;
    pendingPoll = undefined;
    attempt = undefined;
    Object.assign(state, {
      data: null,
      draft: null,
      loading: !!id,
      saving: false,
      acting: false,
      conflict: false,
      error: '',
      pollError: '',
    });
    savedDraft.value = JSON.stringify(null);
    if (!id) return;
    try {
      const { data } = await api.open(id, requestScope.signal);
      if (!requestScope.signal.aborted) apply(data);
    } catch (error) {
      if (!requestScope.signal.aborted)
        state.error =
          error instanceof ApiClientError && error.code === 'WORKFLOW_CAPABILITY_UNAVAILABLE'
            ? '局部元素替换暂未启用'
            : safeApiErrorMessage(error, '局部替换暂不可用，请重试');
    } finally {
      if (!requestScope.signal.aborted) state.loading = false;
    }
  }

  function refresh() {
    if (pendingPoll) return pendingPoll;
    const data = state.data;
    const signal = scope?.signal;
    if (!data || !signal || signal.aborted) return;
    const observedMutation = taskMutation;
    pendingPoll = (async () => {
      try {
        const response = await api.read(projectId, data.runId, signal);
        if (signal.aborted || observedMutation !== taskMutation || !state.data) return;
        state.data.tasks = response.data.tasks;
        state.pollError = '';
      } catch (error) {
        if (!signal.aborted) state.pollError = safeApiErrorMessage(error, '任务状态刷新失败');
      } finally {
        if (!signal.aborted) {
          pendingPoll = undefined;
          schedulePoll();
        }
      }
    })();
    return pendingPoll;
  }

  function save() {
    clearTimeout(saveTimer);
    if (pendingSave) return pendingSave;
    const data = state.data;
    const draft = state.draft;
    const signal = scope?.signal;
    if (!data || !draft || !signal || state.conflict) return Promise.resolve(false);
    if (!dirty.value) return Promise.resolve(true);
    const submitted = copyDraft(draft);
    const signature = JSON.stringify(submitted);
    state.saving = true;
    state.error = '';
    pendingSave = (async () => {
      try {
        const { data: saved } = await api.save(
          projectId,
          data.runId,
          { expectedRevision: data.draftRevision, draft: submitted },
          signal,
        );
        if (signal.aborted || !state.data) return false;
        state.data.draftRevision = saved.draftRevision;
        state.data.draft = saved.draft;
        savedDraft.value = JSON.stringify(saved.draft);
        if (signature === JSON.stringify(state.draft)) state.draft = copyDraft(saved.draft);
        schedulePoll();
        return true;
      } catch (error) {
        if (!signal.aborted) {
          state.conflict = error instanceof ApiClientError && error.status === 409;
          state.error = state.conflict
            ? '草稿已在其他窗口更新。当前编辑仍保留，请核对后重新加载。'
            : safeApiErrorMessage(error, '草稿保存失败，请重试');
        }
        return false;
      } finally {
        if (!signal.aborted) {
          state.saving = false;
          pendingSave = undefined;
        }
      }
    })();
    return pendingSave;
  }

  async function flushPendingEdits() {
    const signal = scope?.signal;
    while (pendingSave || dirty.value) {
      if (!(await save()) || signal?.aborted) return false;
    }
    return true;
  }

  function edit(patch: Partial<LocalReplaceDraft>) {
    if (!state.draft || state.acting) return;
    state.draft = { ...state.draft, ...patch };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushPendingEdits(), 450);
  }

  async function mutateTask(
    operation: (
      runId: string,
      revision: number,
      signal: AbortSignal,
    ) => ReturnType<typeof api.create>,
  ) {
    const signal = scope?.signal;
    if (!signal || state.acting || !state.data) return false;
    state.acting = true;
    try {
      if (!(await flushPendingEdits()) || signal.aborted) return false;
      const { runId, draftRevision } = state.data;
      state.error = '';
      const { data: result } = await operation(runId, draftRevision, signal);
      if (signal.aborted || !state.data) return false;
      taskMutation++;
      state.data.tasks = result.tasks;
      void refresh();
      schedulePoll();
      return true;
    } catch (error) {
      if (!signal.aborted) state.error = safeApiErrorMessage(error, '操作任务失败，请重试');
      return false;
    } finally {
      if (!signal.aborted) state.acting = false;
    }
  }

  async function create() {
    if (taskActive.value) return false;
    const created = await mutateTask((runId, revision, signal) => {
      if (attempt?.revision !== revision) attempt = { revision, key: crypto.randomUUID() };
      return api.create(
        projectId,
        runId,
        { expectedRevision: revision, idempotencyKey: attempt.key },
        signal,
      );
    });
    if (created) attempt = undefined;
    return created;
  }

  function change(taskId: string, action: 'cancel' | 'retry') {
    return mutateTask((runId, _revision, signal) =>
      api.change(projectId, runId, taskId, action, signal),
    );
  }

  function dispose() {
    stopTimers();
    scope?.abort();
  }

  return {
    state,
    taskActive,
    dirty,
    open,
    refresh,
    edit,
    flushPendingEdits,
    create,
    change,
    dispose,
  };
}
