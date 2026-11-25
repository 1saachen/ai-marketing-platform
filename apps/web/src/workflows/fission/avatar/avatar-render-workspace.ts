import { computed, ref, shallowRef } from 'vue';
import {
  AVATAR_SYNC_LIMITS,
  parseAvatarCompositionSettings,
  type AvatarArtifactRef,
  type AvatarCompositionDraft,
  type AvatarCompositionSettings,
  type AvatarRenderTask,
  type AvatarRenderWorkspace,
} from '@ai-marketing/contracts';
import { ApiClientError, safeApiErrorMessage } from '../../../api/http-client';
import { avatarRenderApi } from './avatar.api';

type EditableComposition = Omit<AvatarCompositionDraft, 'revision'>;
type RenderScope = {
  projectId: string;
  runId: string;
  controller: AbortController;
  readOrdinal: number;
  pollTimer?: ReturnType<typeof setTimeout>;
  saveTimer?: ReturnType<typeof setTimeout>;
  startAttempt?: { composition: AvatarArtifactRef; key: string };
};

export const sameAvatarRevision = (
  left: AvatarArtifactRef | null | undefined,
  right: AvatarArtifactRef | null | undefined,
) => !!left && !!right && left.artifactId === right.artifactId && left.revision === right.revision;

export const isAvatarLongRenderSource = (source: AvatarRenderWorkspace['source'] | undefined) =>
  (source?.durationMs ?? 0) > AVATAR_SYNC_LIMITS.maxDurationMs;

function sameSettings(left: AvatarCompositionSettings, right: AvatarCompositionSettings) {
  const background = left.background;
  const other = right.background;
  const sameBackground =
    background.kind === 'SOLID'
      ? other.kind === 'SOLID' && background.color.toUpperCase() === other.color.toUpperCase()
      : other.kind === 'IMAGE' &&
        background.assetId === other.assetId &&
        background.version === other.version;
  return (
    sameBackground &&
    left.insetPercent === right.insetPercent &&
    left.captionMode === right.captionMode &&
    left.captions.length === right.captions.length &&
    left.captions.every((cue, index) => {
      const candidate = right.captions[index];
      return (
        !!candidate &&
        cue.startMs === candidate.startMs &&
        cue.endMs === candidate.endMs &&
        cue.text === candidate.text
      );
    })
  );
}

function sameComposition(
  left: EditableComposition | null | undefined,
  right: EditableComposition | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return sameAvatarRevision(left.sync, right.sync) && sameSettings(left.settings, right.settings);
}

function defaultComposition(source: AvatarRenderWorkspace['source']): EditableComposition | null {
  if (!source) return null;
  return {
    sync: { artifactId: source.artifactId, revision: source.revision },
    settings: {
      background: { kind: 'SOLID', color: '#18263D' },
      insetPercent: 10,
      captionMode: source.captions.length ? 'BOTH' : 'OFF',
      captions: source.captions.map((cue) => ({ ...cue })),
    },
  };
}

export function isAvatarRenderActive(task: AvatarRenderTask | null | undefined) {
  return (
    task?.status === 'QUEUED' || task?.status === 'RUNNING' || task?.status === 'AWAITING_REVIEW'
  );
}

export function createAvatarRenderWorkspace(api = avatarRenderApi) {
  const projection = shallowRef<AvatarRenderWorkspace | null>(null);
  const editable = shallowRef<EditableComposition | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const acting = ref(false);
  const conflict = ref(false);
  const error = ref('');
  const refreshError = ref('');
  const active = computed(() => isAvatarRenderActive(projection.value?.task));
  const baseline = computed(
    () => projection.value?.draft ?? defaultComposition(projection.value?.source ?? null),
  );
  const dirty = computed(() => !sameComposition(editable.value, baseline.value));
  const sourceMatches = computed(() =>
    sameAvatarRevision(editable.value?.sync, projection.value?.source),
  );
  const validationError = computed(() => {
    if (!editable.value || !sourceMatches.value) return '';
    try {
      const source = projection.value?.source;
      const { captions } = parseAvatarCompositionSettings(
        editable.value.settings,
        isAvatarLongRenderSource(source),
      );
      if (captions.some((cue) => cue.endMs > (source?.durationMs ?? 0)))
        return '字幕结束时间不能超过口播音轨时长。';
      return '';
    } catch {
      return '字幕每条须有一到两行文字，时间按顺序排列且不能重叠。';
    }
  });
  const alreadyConfirmed = computed(
    () =>
      !!projection.value?.composition &&
      !projection.value.composition.stale &&
      sameComposition(editable.value, projection.value.composition),
  );
  let scope: RenderScope | undefined;
  let pendingSave: Promise<boolean> | undefined;
  let pendingAction: Promise<boolean> | undefined;

  function apply(
    current: RenderScope,
    data: AvatarRenderWorkspace,
    submitted?: EditableComposition,
  ) {
    if (data.projectId !== current.projectId || data.workflowRunId !== current.runId)
      throw new Error('成片工作台所属项目或运行范围已变化，请重新加载。');
    const previousRevision = projection.value?.draft?.revision ?? 0;
    const hasLocalChanges = dirty.value;
    const local = editable.value;
    projection.value = data;
    refreshError.value = '';
    if (!hasLocalChanges || (submitted && sameComposition(submitted, local))) {
      editable.value = baseline.value;
      conflict.value = false;
    } else if (!submitted && previousRevision !== (data.draft?.revision ?? 0)) {
      conflict.value = true;
      error.value = '合成草稿已在其他窗口更新，当前编辑仍保留。';
    }
  }

  function stopPoll(current: RenderScope) {
    clearTimeout(current.pollTimer);
    current.readOrdinal++;
  }

  function schedulePoll(current: RenderScope) {
    clearTimeout(current.pollTimer);
    if (scope === current && !pendingSave && !pendingAction && active.value) {
      const delay = projection.value?.task?.status === 'AWAITING_REVIEW' ? 5000 : 2500;
      current.pollTimer = setTimeout(() => void refresh(), delay);
    }
  }

  function report(reason: unknown, fallback: string, draftOperation = false) {
    if (draftOperation && reason instanceof ApiClientError && reason.status === 409) {
      conflict.value = true;
      error.value = '合成草稿或口播素材已在其他窗口更新，当前编辑仍保留。';
    } else {
      error.value = safeApiErrorMessage(reason, fallback);
    }
  }

  async function load(current: RenderScope) {
    stopPoll(current);
    const ordinal = current.readOrdinal;
    try {
      const { data } = await api.read(current.projectId, current.runId, current.controller.signal);
      if (scope !== current || ordinal !== current.readOrdinal) return false;
      apply(current, data);
      return true;
    } catch (reason) {
      if (scope === current && ordinal === current.readOrdinal)
        refreshError.value = safeApiErrorMessage(reason, '成片状态读取失败，请重试。');
      return false;
    } finally {
      if (scope === current && ordinal === current.readOrdinal) {
        loading.value = false;
        schedulePoll(current);
      }
    }
  }

  function refresh() {
    return scope && !pendingAction && !pendingSave ? load(scope) : Promise.resolve(false);
  }

  function dispose() {
    const previous = scope;
    scope = undefined;
    clearTimeout(previous?.pollTimer);
    clearTimeout(previous?.saveTimer);
    previous?.controller.abort();
    pendingSave = undefined;
    pendingAction = undefined;
    projection.value = null;
    editable.value = null;
    loading.value = false;
    acting.value = false;
    saving.value = false;
    conflict.value = false;
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

  function save(force = false) {
    const current = scope;
    const data = projection.value;
    const submitted = editable.value;
    clearTimeout(current?.saveTimer);
    if (pendingSave) return pendingSave;
    if (
      !current ||
      !data?.enabled ||
      !submitted ||
      conflict.value ||
      !sourceMatches.value ||
      validationError.value
    )
      return Promise.resolve(false);
    if (!force && !dirty.value) return Promise.resolve(true);

    stopPoll(current);
    saving.value = true;
    error.value = '';
    pendingSave = Promise.resolve()
      .then(async () => {
        const response = await api.save(
          current.projectId,
          current.runId,
          { ...submitted, expectedRevision: data.draft?.revision ?? 0 },
          current.controller.signal,
        );
        if (scope !== current) return false;
        apply(current, response.data, submitted);
        return true;
      })
      .catch((reason: unknown) => {
        if (scope === current) report(reason, '合成草稿保存失败，请重试。', true);
        return false;
      })
      .finally(() => {
        if (scope !== current) return;
        pendingSave = undefined;
        saving.value = false;
        schedulePoll(current);
      });
    return pendingSave;
  }

  async function flushDraft() {
    const current = scope;
    while (pendingSave || dirty.value) {
      if (!(await save()) || scope !== current) return false;
    }
    return !conflict.value;
  }

  function scheduleSave(current: RenderScope) {
    clearTimeout(current.saveTimer);
    if (!conflict.value) current.saveTimer = setTimeout(() => void flushDraft(), 500);
  }

  function edit(patch: Partial<AvatarCompositionSettings>) {
    if (
      !scope ||
      !editable.value ||
      acting.value ||
      !projection.value?.enabled ||
      !sourceMatches.value
    )
      return;
    editable.value = { ...editable.value, settings: { ...editable.value.settings, ...patch } };
    error.value = '';
    scheduleSave(scope);
  }

  function useCurrentSource() {
    const next = defaultComposition(projection.value?.source ?? null);
    const previous = editable.value;
    if (!scope || !next || acting.value || conflict.value) return;
    editable.value = {
      ...next,
      settings: previous
        ? {
            ...previous.settings,
            captionMode: next.settings.captions.length ? previous.settings.captionMode : 'OFF',
            captions: next.settings.captions,
          }
        : next.settings,
    };
    scheduleSave(scope);
  }

  function runAction(operation: (current: RenderScope) => Promise<boolean>) {
    const current = scope;
    if (!current || pendingAction) return Promise.resolve(false);
    stopPoll(current);
    acting.value = true;
    error.value = '';
    pendingAction = Promise.resolve()
      .then(() => operation(current))
      .catch((reason: unknown) => {
        if (scope === current) report(reason, '成片操作失败，请重试。');
        return false;
      })
      .finally(() => {
        if (scope !== current) return;
        pendingAction = undefined;
        acting.value = false;
        void refresh();
      });
    return pendingAction;
  }

  async function flushPendingEdits() {
    const current = scope;
    if (pendingAction) await pendingAction;
    if (scope === current && current && !projection.value && !(await refresh())) return false;
    return scope === current && flushDraft();
  }

  function confirm() {
    const settings = editable.value?.settings;
    if (
      !sourceMatches.value ||
      alreadyConfirmed.value ||
      !settings ||
      (settings.captionMode !== 'OFF' && !settings.captions.length)
    )
      return Promise.resolve(false);
    return runAction(async (current) => {
      if (!(await flushDraft()) || scope !== current) return false;
      if (!projection.value?.draft && !(await save(true))) return false;
      const revision = projection.value?.draft?.revision;
      if (!revision || scope !== current) return false;
      try {
        const { data } = await api.confirm(
          current.projectId,
          current.runId,
          revision,
          current.controller.signal,
        );
        if (scope !== current) return false;
        apply(current, data);
        return true;
      } catch (reason) {
        if (scope === current) report(reason, '合成方案确认失败，请重试。', true);
        return false;
      }
    });
  }

  function generate() {
    const confirmed = projection.value?.composition;
    if (!alreadyConfirmed.value || !confirmed || !projection.value?.canRender || active.value)
      return Promise.resolve(false);
    const composition = { artifactId: confirmed.artifactId, revision: confirmed.revision };
    return runAction(async (current) => {
      if (!sameAvatarRevision(current.startAttempt?.composition, composition))
        current.startAttempt = { composition, key: crypto.randomUUID() };
      if (!current.startAttempt) return false;
      const { data } = await api.create(
        current.projectId,
        current.runId,
        { composition, idempotencyKey: current.startAttempt.key },
        current.controller.signal,
      );
      if (scope !== current) return false;
      delete current.startAttempt;
      apply(current, data);
      return true;
    });
  }

  function change(action: 'cancel' | 'retry') {
    const task = projection.value?.task;
    if (!task || !(action === 'cancel' ? task.canCancel : task.canRetry))
      return Promise.resolve(false);
    return runAction(async (current) => {
      const { data } = await api.change(
        current.projectId,
        current.runId,
        task.id,
        action,
        current.controller.signal,
      );
      if (scope !== current) return false;
      apply(current, data);
      return true;
    });
  }

  function archive() {
    const output = projection.value?.output;
    if (!output?.videoUrl || output.archive) return Promise.resolve(false);
    return runAction(async (current) => {
      const { data } = await api.archive(
        current.projectId,
        current.runId,
        output.revision,
        current.controller.signal,
      );
      const latest = projection.value;
      if (scope !== current || !latest?.output || !sameAvatarRevision(output, latest.output))
        return false;
      projection.value = { ...latest, output: { ...latest.output, archive: data } };
      return true;
    });
  }

  async function resolveConflict(keepLocal: boolean) {
    if (!scope || !conflict.value) return;
    const current = scope;
    const local = editable.value;
    if (!(await refresh()) || scope !== current) return;
    const canKeep = keepLocal && sameAvatarRevision(local?.sync, projection.value?.source);
    editable.value = canKeep ? local : baseline.value;
    conflict.value = false;
    error.value = '';
    if (canKeep) scheduleSave(current);
  }

  return {
    projection,
    editable,
    loading,
    saving,
    acting,
    active,
    dirty,
    sourceMatches,
    alreadyConfirmed,
    validationError,
    conflict,
    error,
    refreshError,
    setScope,
    refresh,
    edit,
    useCurrentSource,
    flushPendingEdits,
    confirm,
    generate,
    change,
    archive,
    resolveConflict,
    dispose,
  };
}
