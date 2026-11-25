import { computed, ref, shallowRef } from 'vue';
import type {
  AvatarSyncCreateRequest,
  AvatarSyncTask,
  AvatarSyncWorkspace,
} from '@ai-marketing/contracts';
import { safeApiErrorMessage } from '../../../api/http-client';
import { avatarSyncApi } from './avatar.api';

export function isAvatarSyncActive(task: AvatarSyncTask | null | undefined) {
  return task?.status === 'QUEUED' || task?.status === 'RUNNING';
}

export function avatarSegmentProgress(task: AvatarSyncTask | null | undefined) {
  const segments = task?.segments;
  if (!segments) return '';
  if (!segments.total) return isAvatarSyncActive(task) ? '正在准备分段' : '';
  const complete = `已完成 ${segments.completed}/${segments.total} 段`;
  if (segments.failedOrdinal !== null && task.status === 'FAILED')
    return `${complete} · 第 ${segments.failedOrdinal} 段失败`;
  if (segments.activeOrdinal !== null && isAvatarSyncActive(task))
    return `${complete} · 正在处理第 ${segments.activeOrdinal} 段`;
  return complete;
}

type SyncInput = Omit<AvatarSyncCreateRequest, 'idempotencyKey'>;
type Scope = {
  projectId: string;
  runId: string;
  controller: AbortController;
  readOrdinal: number;
  pollTimer?: ReturnType<typeof setTimeout>;
  startAttempt?: { input: string; key: string };
};

export function createAvatarSyncWorkspace(api = avatarSyncApi) {
  const projection = shallowRef<AvatarSyncWorkspace | null>(null);
  const active = computed(() => isAvatarSyncActive(projection.value?.task));
  const loading = ref(false);
  const sourceVerified = ref(false);
  const acting = ref(false);
  const error = ref('');
  const refreshError = ref('');
  let scope: Scope | undefined;
  let pendingAction: Promise<boolean> | undefined;

  function apply(current: Scope, data: AvatarSyncWorkspace, verifySource: boolean) {
    if (data.projectId !== current.projectId || data.workflowRunId !== current.runId)
      throw new Error('口播任务所属项目或运行范围已变化，请重新加载。');
    projection.value = data;
    if (verifySource) sourceVerified.value = true;
    refreshError.value = '';
  }

  function schedulePoll(current: Scope) {
    clearTimeout(current.pollTimer);
    if (scope === current && !acting.value && active.value)
      current.pollTimer = setTimeout(() => void refresh(), 2500);
  }

  async function load(current: Scope) {
    clearTimeout(current.pollTimer);
    const ordinal = ++current.readOrdinal;
    try {
      const { data } = await api.read(current.projectId, current.runId, current.controller.signal);
      if (scope !== current || ordinal !== current.readOrdinal) return null;
      apply(current, data, true);
      return data;
    } catch (reason) {
      if (scope === current && ordinal === current.readOrdinal)
        refreshError.value = safeApiErrorMessage(reason, '口播任务状态读取失败，请重试。');
      return null;
    } finally {
      if (scope === current && ordinal === current.readOrdinal) {
        loading.value = false;
        schedulePoll(current);
      }
    }
  }

  function refresh() {
    if (scope && !acting.value) return load(scope);
    return Promise.resolve(null);
  }

  function dispose() {
    const previous = scope;
    scope = undefined;
    clearTimeout(previous?.pollTimer);
    previous?.controller.abort();
    pendingAction = undefined;
    projection.value = null;
    sourceVerified.value = false;
    acting.value = false;
    loading.value = false;
    error.value = '';
    refreshError.value = '';
  }

  function setScope(projectId: string, runId: string) {
    if (scope?.projectId === projectId && scope.runId === runId) return;
    dispose();
    if (!projectId || !runId) return;
    scope = { projectId, runId, controller: new AbortController(), readOrdinal: 0 };
    loading.value = true;
    void refresh();
  }

  function refreshForSourceChange() {
    sourceVerified.value = false;
    if (scope) scope.readOrdinal++;
    return refresh();
  }

  function mutate(operation: (current: Scope) => Promise<AvatarSyncWorkspace | null>) {
    const current = scope;
    if (!current || acting.value) return Promise.resolve(false);
    acting.value = true;
    error.value = '';
    clearTimeout(current.pollTimer);
    current.readOrdinal++;
    pendingAction = Promise.resolve()
      .then(async () => {
        const data = await operation(current);
        if (scope !== current || !data) return false;
        apply(current, data, false);
        return true;
      })
      .catch((reason: unknown) => {
        if (scope === current)
          error.value = safeApiErrorMessage(reason, '口播任务操作失败，请重试。');
        return false;
      })
      .finally(() => {
        if (scope === current) {
          acting.value = false;
          pendingAction = undefined;
          // Resolve lost writes by reading task state. Writes are never retried by the poll.
          void refresh();
        }
      });
    return pendingAction;
  }

  function generate(prepare: () => Promise<SyncInput | null>) {
    if (active.value) return Promise.resolve(false);
    return mutate(async (current) => {
      const input = await prepare();
      if (!input || scope !== current) return null;
      const data = await load(current);
      if (!data || scope !== current) return null;
      if (isAvatarSyncActive(data.task)) return data;
      const segmented = input.mode === 'SEGMENTED';
      const availability = segmented ? data.long : data;
      if (!availability?.enabled || !availability.canGenerate) {
        error.value =
          availability?.blockedReason ??
          (segmented ? '当前素材无法生成口播长片。' : '当前素材无法生成口播视频。');
        return null;
      }
      const keyInput = JSON.stringify(input);
      if (current.startAttempt?.input !== keyInput)
        current.startAttempt = { input: keyInput, key: crypto.randomUUID() };
      const response = await api.create(
        current.projectId,
        current.runId,
        { ...input, idempotencyKey: current.startAttempt.key },
        current.controller.signal,
      );
      delete current.startAttempt;
      return response.data;
    });
  }

  function change(action: 'cancel' | 'retry') {
    const task = projection.value?.task;
    if (!task || !(action === 'cancel' ? task.canCancel : task.canRetry))
      return Promise.resolve(false);
    return mutate(async (current) => {
      const { data } = await api.change(
        current.projectId,
        current.runId,
        task.id,
        action,
        current.controller.signal,
      );
      return data;
    });
  }

  return {
    projection,
    active,
    loading,
    sourceVerified,
    acting,
    error,
    refreshError,
    setScope,
    refresh,
    refreshForSourceChange,
    generate,
    change,
    waitForAction: () => pendingAction,
    dispose,
  };
}
