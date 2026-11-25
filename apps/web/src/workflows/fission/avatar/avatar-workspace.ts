import { computed, ref, shallowRef } from 'vue';
import type { AvatarAssetRef, AvatarDraftData, AvatarWorkspaceData } from '@ai-marketing/contracts';
import { ApiClientError, safeApiErrorMessage } from '../../../api/http-client';
import { avatarApi } from './avatar.api';

export function sameAvatarAsset(left: AvatarAssetRef | null, right: AvatarAssetRef | null) {
  return left?.assetId === right?.assetId && left?.version === right?.version;
}

function sameScript(left: AvatarDraftData, right: AvatarDraftData) {
  return left.scriptText === right.scriptText && left.scriptSource === right.scriptSource;
}

function sameDraft(left: AvatarDraftData, right: AvatarDraftData) {
  return (
    sameAvatarAsset(left.character, right.character) &&
    sameAvatarAsset(left.voice, right.voice) &&
    sameScript(left, right)
  );
}

function copyDraft(draft: AvatarDraftData): AvatarDraftData {
  return {
    ...draft,
    character: draft.character && { ...draft.character },
    voice: draft.voice && { ...draft.voice },
  };
}

export function createAvatarWorkspace(api = avatarApi) {
  const workspace = shallowRef<AvatarWorkspaceData | null>(null);
  const draft = shallowRef<AvatarDraftData | null>(null);
  const loading = ref(false);
  const unavailable = ref(false);
  const saving = ref(false);
  const confirming = ref(false);
  const conflict = ref(false);
  const error = ref('');
  const dirty = computed(
    () => !!draft.value && !!workspace.value && !sameDraft(draft.value, workspace.value.draft.data),
  );

  let controller: AbortController | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSave: Promise<boolean> | undefined;
  let pendingConfirmation: Promise<boolean> | undefined;

  function apply(next: AvatarWorkspaceData) {
    workspace.value = next;
    draft.value = copyDraft(next.draft.data);
    conflict.value = false;
    error.value = '';
  }

  function assertScope(next: AvatarWorkspaceData, actualProject: string, runId?: string) {
    if (next.projectId !== actualProject || (runId && next.workflowRunId !== runId)) {
      throw new Error('工作台响应的项目或运行范围不一致，请重新打开。');
    }
  }

  function handleError(reason: unknown, fallback: string) {
    if (
      reason instanceof ApiClientError &&
      reason.status === 409 &&
      (!reason.code || reason.code === 'CONFLICT')
    ) {
      conflict.value = true;
      error.value = '草稿已在其他窗口更新，当前编辑仍保留。';
      return;
    }
    error.value = safeApiErrorMessage(reason, fallback);
  }

  function dispose() {
    clearTimeout(saveTimer);
    controller?.abort();
    pendingSave = undefined;
    pendingConfirmation = undefined;
  }

  async function open(id: string) {
    dispose();
    const scope = new AbortController();
    controller = scope;
    workspace.value = null;
    draft.value = null;
    loading.value = !!id;
    unavailable.value = false;
    saving.value = false;
    confirming.value = false;
    conflict.value = false;
    error.value = '';
    if (!id) return;
    try {
      const { data } = await api.open(id, scope.signal);
      if (scope.signal.aborted) return;
      assertScope(data, id);
      apply(data);
    } catch (reason) {
      if (scope.signal.aborted) return;
      unavailable.value =
        reason instanceof ApiClientError &&
        (reason.code === 'WORKFLOW_CAPABILITY_UNAVAILABLE' || reason.status === 503);
      error.value = unavailable.value
        ? '当前项目的数字人口播工作台暂未启用。'
        : safeApiErrorMessage(reason, '数字人口播工作台加载失败，请重试。');
    } finally {
      if (!scope.signal.aborted) loading.value = false;
    }
  }

  function save() {
    clearTimeout(saveTimer);
    if (pendingSave) return pendingSave;
    const scope = controller;
    const previous = workspace.value;
    const submitted = draft.value;
    if (!scope || scope.signal.aborted || !previous || !submitted || conflict.value)
      return Promise.resolve(false);
    if (!dirty.value) return Promise.resolve(true);

    saving.value = true;
    error.value = '';
    pendingSave = Promise.resolve()
      .then(async () => {
        const { data } = await api.save(
          previous.projectId,
          previous.workflowRunId,
          { expectedRevision: previous.draft.revision, draft: copyDraft(submitted) },
          scope.signal,
        );
        if (scope.signal.aborted) return false;
        assertScope(data, previous.projectId, previous.workflowRunId);
        workspace.value = data;
        if (draft.value && sameDraft(draft.value, submitted)) {
          draft.value = copyDraft(data.draft.data);
        }
        return true;
      })
      .catch((reason: unknown) => {
        if (!scope.signal.aborted) handleError(reason, '草稿保存失败，请重试。');
        return false;
      })
      .finally(() => {
        if (!scope.signal.aborted) {
          saving.value = false;
          pendingSave = undefined;
        }
      });
    return pendingSave;
  }

  async function flushDraft() {
    const scope = controller;
    while (pendingSave || dirty.value) {
      if (!(await save()) || scope?.signal.aborted) return false;
    }
    return !conflict.value;
  }

  function edit(patch: Partial<AvatarDraftData>) {
    if (!draft.value || confirming.value) return;
    draft.value = { ...draft.value, ...patch };
    clearTimeout(saveTimer);
    if (!conflict.value) saveTimer = setTimeout(() => void flushDraft(), 450);
  }

  async function flushPendingEdits() {
    const scope = controller;
    if (pendingConfirmation) await pendingConfirmation;
    return scope?.signal.aborted ? false : flushDraft();
  }

  function confirm(node: 'binding' | 'script') {
    const scope = controller;
    const previous = workspace.value;
    if (!scope || !previous || pendingConfirmation || confirming.value || conflict.value) return;
    confirming.value = true;
    pendingConfirmation = (async () => {
      try {
        if (!(await flushDraft()) || scope.signal.aborted || !workspace.value) return false;
        const { data } = await api.confirm(
          previous.projectId,
          previous.workflowRunId,
          node,
          { expectedRevision: workspace.value.draft.revision },
          scope.signal,
        );
        if (scope.signal.aborted) return false;
        assertScope(data, previous.projectId, previous.workflowRunId);
        apply(data);
        return true;
      } catch (reason) {
        if (!scope.signal.aborted) handleError(reason, '确认失败，请重试。');
        return false;
      } finally {
        if (!scope.signal.aborted) {
          confirming.value = false;
          pendingConfirmation = undefined;
        }
      }
    })();
    return pendingConfirmation;
  }

  async function resolveConflict(keepLocal: boolean) {
    const scope = controller;
    const previous = workspace.value;
    const local = draft.value;
    if (!scope || !previous || !local || !conflict.value || confirming.value) return;
    confirming.value = true;
    try {
      const { data: current } = await api.read(
        previous.projectId,
        previous.workflowRunId,
        scope.signal,
      );
      if (scope.signal.aborted) return;
      assertScope(current, previous.projectId, previous.workflowRunId);
      const data =
        current.runStatus === 'PAUSED'
          ? (await api.open(previous.projectId, scope.signal, previous.workflowRunId)).data
          : current;
      if (scope.signal.aborted) return;
      assertScope(data, previous.projectId, previous.workflowRunId);
      if (data.runStatus !== 'ACTIVE') throw new Error('工作流当前不可编辑，当前修改已保留。');
      apply(data);
      if (keepLocal) {
        const saved = previous.draft.data;
        draft.value = {
          ...data.draft.data,
          ...(!sameAvatarAsset(saved.character, local.character)
            ? { character: local.character }
            : {}),
          ...(!sameAvatarAsset(saved.voice, local.voice) ? { voice: local.voice } : {}),
          ...(!sameScript(saved, local)
            ? { scriptText: local.scriptText, scriptSource: local.scriptSource }
            : {}),
        };
        await flushDraft();
      }
    } catch (reason) {
      if (!scope.signal.aborted)
        error.value = safeApiErrorMessage(reason, '读取当前草稿失败，请重试。');
    } finally {
      if (!scope.signal.aborted) confirming.value = false;
    }
  }

  return {
    workspace,
    draft,
    loading,
    unavailable,
    saving,
    confirming,
    conflict,
    error,
    dirty,
    open,
    edit,
    confirm,
    resolveConflict,
    flushPendingEdits,
    dispose,
  };
}
