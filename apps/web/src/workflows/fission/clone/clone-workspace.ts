import { reactive } from 'vue';
import {
  emptyCloneInputDraft,
  normalizeCloneInputDraft,
  FISSION_CLONE_NODES,
  emptyCloneAnalysisDraft,
  emptyCloneMappingDraft,
  cloneStructureLock,
  type CloneAnalysisReport,
  type CloneMappingBinding,
  type CloneMappingPurpose,
  type CloneTaskCreateRequest,
  type CloneInputDraft,
  type CloneWorkspace,
  type CloneUploadRole,
} from '@ai-marketing/contracts';
import { ApiClientError, safeApiErrorMessage } from '../../../api/http-client';
import { cloneContentSignature } from './clone-content';
import {
  activateWorkflowNode,
  putWorkflowNodeState,
} from '../../../platform/workflow/api/workflow-working.api';
import {
  confirmCloneInput,
  importCloneAsset,
  initializeCloneWorkspace,
  removeCloneUpload,
  uploadCloneFile,
  getCloneWorkspace,
  createCloneTask,
  saveCloneAnalysisDraft,
  confirmCloneAnalysis,
  confirmCloneMapping,
  adoptCloneSuggestion,
  changeCloneTask,
  prepareCloneMappingAsset,
} from './clone.api';

export const cloneWorkspaceApi = {
  initialize: initializeCloneWorkspace,
  save: putWorkflowNodeState,
  activate: activateWorkflowNode,
  upload: uploadCloneFile,
  remove: removeCloneUpload,
  confirm: confirmCloneInput,
  importAsset: importCloneAsset,
  workspace: getCloneWorkspace,
  createTask: createCloneTask,
  saveAnalysis: saveCloneAnalysisDraft,
  confirmAnalysis: confirmCloneAnalysis,
  confirmMapping: confirmCloneMapping,
  adoptSuggestion: adoptCloneSuggestion,
  changeTask: changeCloneTask,
  prepareMappingAsset: prepareCloneMappingAsset,
};
const copyDraft = (value: CloneInputDraft) => normalizeCloneInputDraft(value);
const signature = (value: CloneInputDraft) => cloneContentSignature(copyDraft(value));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const jsonSignature = cloneContentSignature;

/** Server revisions are authoritative; local edit state survives failed writes. */
export function createCloneWorkspace(api = cloneWorkspaceApi) {
  const state = reactive({
    projectId: '',
    workspace: null as CloneWorkspace | null,
    draft: emptyCloneInputDraft(),
    analysisDraft: emptyCloneAnalysisDraft(),
    mappingDraft: emptyCloneMappingDraft(),
    analysisEditing: false,
    refreshing: false,
    pollError: '',
    loading: false,
    saving: false,
    mutating: false,
    error: '',
    conflict: false,
    step: 0,
    uploadProgress: '',
  });
  let generation = 0;
  let successfulWrites = 0;
  let controller = new AbortController();
  let savedSignature = signature(state.draft);
  let savedAnalysisSignature = jsonSignature(state.analysisDraft);
  let savedMappingSignature = jsonSignature(state.mappingDraft);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshPromise: Promise<boolean> | null = null;
  let savePromise: Promise<boolean> | null = null;
  let mutation: Promise<boolean> | null = null;
  let navigation: Promise<boolean> | null = null;
  let initialization: Promise<void> = Promise.resolve();
  const assetImportKeys = new Map<string, string>();
  const assetImportScopes = new Map<string, string>();
  const taskKeys = new Map<string, string>();
  const current = (epoch: number) => epoch === generation && !controller.signal.aborted;
  const inputDirty = () => signature(state.draft) !== savedSignature;
  const analysisDirty = () => jsonSignature(state.analysisDraft) !== savedAnalysisSignature;
  const mappingDirty = () => jsonSignature(state.mappingDraft) !== savedMappingSignature;
  const dirty = () => inputDirty() || analysisDirty() || mappingDirty();
  const errorMessage = (error: unknown, fallback: string) =>
    error instanceof ApiClientError && error.code === 'CLONE_CAPABILITY_UNAVAILABLE'
      ? '爆款复刻尚未启用，请联系管理员完成配置。'
      : error instanceof ApiClientError && error.status === 409
        ? '草稿已在其他窗口更新。当前编辑已保留，请核对后重新加载服务端内容。'
        : safeApiErrorMessage(error, fallback);
  const apply = (workspace: CloneWorkspace, initial = false) => {
    const previous = state.workspace;
    const incoming = copy(workspace);
    // Polls only refresh authority. They never adopt a newer editing base behind a dirty editor.
    if (
      !initial &&
      previous &&
      (inputDirty() || incoming.draft.revision < previous.draft.revision)
    ) {
      incoming.draft = copy(previous.draft);
    } else {
      state.draft = copyDraft(incoming.draft.state);
      savedSignature = signature(state.draft);
    }
    if (incoming.g2) {
      const old = previous?.g2;
      if (
        !initial &&
        old &&
        (analysisDirty() ||
          state.analysisEditing ||
          incoming.g2.analysisDraft.revision < old.analysisDraft.revision)
      ) {
        incoming.g2.analysisDraft = copy(old.analysisDraft);
      } else {
        state.analysisDraft = copy(incoming.g2.analysisDraft.state);
        savedAnalysisSignature = jsonSignature(state.analysisDraft);
      }
      if (
        !initial &&
        old &&
        (mappingDirty() || incoming.g2.mappingDraft.revision < old.mappingDraft.revision)
      ) {
        incoming.g2.mappingDraft = copy(old.mappingDraft);
      } else {
        state.mappingDraft = copy(incoming.g2.mappingDraft.state);
        savedMappingSignature = jsonSignature(state.mappingDraft);
      }
      if (
        old?.analysis &&
        (!incoming.g2.analysis || incoming.g2.analysis.ref.revision < old.analysis.ref.revision)
      )
        incoming.g2.analysis = copy(old.analysis);
      if (
        old?.mapping &&
        (!incoming.g2.mapping || incoming.g2.mapping.ref.revision < old.mapping.ref.revision)
      )
        incoming.g2.mapping = copy(old.mapping);
    }
    if (
      previous?.input &&
      (!incoming.input || incoming.input.ref.revision < previous.input.ref.revision)
    )
      incoming.input = copy(previous.input);
    state.workspace = incoming;
    if (initial) {
      state.step = Math.max(
        0,
        FISSION_CLONE_NODES.findIndex((id) => id === incoming.run.currentNodeId),
      );
      state.analysisEditing =
        !!incoming.g2?.analysisDraft.state.report &&
        jsonSignature(incoming.g2.analysisDraft.state.report) !==
          jsonSignature(incoming.g2.analysis?.report);
    }
    schedulePoll();
  };
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (
      state.workspace?.g2?.generationActive ||
      state.workspace?.g2?.tasks.some(
        (task) => task.status === 'QUEUED' || task.status === 'RUNNING',
      )
    )
      pollTimer = setTimeout(() => void refresh(), 1500);
  }
  function refresh(): Promise<boolean> {
    if (refreshPromise) return refreshPromise;
    if (!state.workspace) return Promise.resolve(false);
    if (state.mutating || state.saving || navigation) {
      schedulePoll();
      return Promise.resolve(false);
    }
    const epoch = generation;
    const writesAtStart = successfulWrites;
    const projectId = state.projectId;
    const runId = state.workspace.run.id;
    state.refreshing = true;
    const operation = (async () => {
      try {
        const response = await api.workspace(projectId, runId, controller.signal);
        if (
          !current(epoch) ||
          writesAtStart !== successfulWrites ||
          state.mutating ||
          state.saving ||
          navigation
        )
          return false;
        apply(response.data);
        state.pollError = '';
        return true;
      } catch (error) {
        if (current(epoch))
          state.pollError = safeApiErrorMessage(error, '任务状态读取失败，当前编辑已保留');
        return false;
      } finally {
        if (current(epoch)) {
          state.refreshing = false;
          refreshPromise = null;
          schedulePoll();
        }
      }
    })();
    refreshPromise = operation;
    return operation;
  }
  function open(projectId: string): Promise<void> {
    generation++;
    controller.abort();
    controller = new AbortController();
    clearTimeout(timer);
    clearTimeout(pollTimer);
    refreshPromise = null;
    savePromise = null;
    mutation = null;
    navigation = null;
    state.projectId = projectId;
    state.workspace = null;
    state.draft = emptyCloneInputDraft();
    state.analysisDraft = emptyCloneAnalysisDraft();
    state.mappingDraft = emptyCloneMappingDraft();
    state.analysisEditing = false;
    state.pollError = '';
    state.refreshing = false;
    savedSignature = signature(state.draft);
    savedAnalysisSignature = jsonSignature(state.analysisDraft);
    savedMappingSignature = jsonSignature(state.mappingDraft);
    state.error = '';
    state.conflict = false;
    state.saving = false;
    state.mutating = false;
    state.step = 0;
    const epoch = generation;
    state.loading = !!projectId;
    initialization = (async () => {
      if (!projectId) return;
      try {
        const response = await api.initialize(projectId, controller.signal);
        if (current(epoch)) apply(response.data, true);
      } catch (error) {
        if (current(epoch)) state.error = errorMessage(error, '工作区加载失败，请重试');
      } finally {
        if (current(epoch)) state.loading = false;
      }
    })();
    return initialization;
  }
  function edit(patch: Partial<CloneInputDraft>) {
    if (!state.workspace || state.mutating || state.loading) return;
    state.draft = { ...state.draft, ...patch };
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 450);
  }
  function save(): Promise<boolean> {
    clearTimeout(timer);
    if (savePromise) return savePromise;
    if (!state.workspace) return Promise.resolve(true);
    if (!dirty()) return Promise.resolve(true);
    if (state.conflict) return Promise.resolve(false);
    const epoch = generation;
    const projectId = state.projectId;
    const signal = controller.signal;
    state.saving = true;
    const operation = (async () => {
      try {
        while (current(epoch) && dirty()) {
          const workspace = state.workspace!;
          if (analysisDirty() && workspace.g2) {
            const draft = copy(state.analysisDraft);
            const result = await api.saveAnalysis(
              projectId,
              workspace.run.id,
              {
                expectedRevision: workspace.g2.analysisDraft.revision,
                state: draft,
              },
              signal,
            );
            if (!current(epoch)) return false;
            successfulWrites++;
            apply(result.data);
            if (!state.workspace?.g2 || !result.data.g2) return false;
            state.workspace.g2.analysisDraft = copy(result.data.g2.analysisDraft);
            savedAnalysisSignature = jsonSignature(draft);
            continue;
          }
          if (mappingDirty() && workspace.g2) {
            const draft = copy(state.mappingDraft);
            const result = await api.save(
              projectId,
              workspace.run.id,
              'CLONE_MAPPING',
              {
                schemaVersion: 1,
                expectedRevision: workspace.g2.mappingDraft.revision,
                state: draft,
              },
              { signal },
            );
            if (!current(epoch)) return false;
            successfulWrites++;
            state.workspace!.g2!.mappingDraft = {
              revision: result.data.nodeState.revision,
              state: draft,
            };
            savedMappingSignature = jsonSignature(draft);
            continue;
          }
          if (!inputDirty()) break;
          const draft = copyDraft(state.draft);
          const result = await api.save(
            projectId,
            workspace.run.id,
            'CLONE_INPUT',
            {
              schemaVersion: 1,
              expectedRevision: workspace.draft.revision,
              state: draft,
            },
            { signal },
          );
          if (!current(epoch)) return false;
          successfulWrites++;
          state.workspace!.draft = { revision: result.data.nodeState.revision, state: draft };
          savedSignature = signature(draft);
        }
        if (current(epoch)) state.error = '';
        return current(epoch);
      } catch (error) {
        if (current(epoch)) {
          state.conflict = error instanceof ApiClientError && error.status === 409;
          state.error = errorMessage(error, '草稿保存失败，当前编辑已保留，请重试');
        }
        return false;
      } finally {
        if (current(epoch)) {
          state.saving = false;
          savePromise = null;
        }
      }
    })();
    savePromise = operation;
    return operation;
  }
  async function flushPendingEdits() {
    const epoch = generation;
    await initialization;
    if (!current(epoch)) return false;
    if (mutation && !(await mutation)) return false;
    if (navigation && !(await navigation)) return false;
    return save();
  }
  function mutate(
    action: (epoch: number, workspace: CloneWorkspace, signal: AbortSignal) => Promise<boolean>,
    flushDrafts = true,
  ) {
    if (mutation) return mutation;
    const workspace = state.workspace;
    if (!workspace || state.loading || navigation) return Promise.resolve(false);
    const epoch = generation;
    state.mutating = true;
    const signal = controller.signal;
    const operation = (async () => {
      try {
        if (flushDrafts && !(await save())) return false;
        if (!flushDrafts) clearTimeout(timer);
        if (!flushDrafts && savePromise) await savePromise;
        if (!current(epoch)) return false;
        state.error = '';
        const succeeded = await action(epoch, state.workspace!, signal);
        if (succeeded && current(epoch)) successfulWrites++;
        return succeeded;
      } catch (error) {
        if (current(epoch)) {
          state.error = errorMessage(error, '操作失败，请重试');
          state.conflict = error instanceof ApiClientError && error.status === 409;
        }
        return false;
      } finally {
        if (current(epoch)) {
          state.mutating = false;
          state.uploadProgress = '';
          mutation = null;
        }
      }
    })();
    mutation = operation;
    return operation;
  }
  function upload(files: readonly File[], role: CloneUploadRole) {
    return mutate(async (epoch, workspace, signal) => {
      if (!files.length) return true;
      if (role === 'REFERENCE' && files.length !== 1) throw new Error('每次请选择一条参考视频');
      if (
        role === 'PRODUCT' &&
        state.draft.productUploadIds.length + files.length >
          workspace.capabilities.limits.maxProductFiles
      )
        throw new Error(`商品素材最多 ${workspace.capabilities.limits.maxProductFiles} 份`);
      for (const [index, file] of files.entries()) {
        const max =
          role === 'REFERENCE'
            ? workspace.capabilities.limits.maxReferenceBytes
            : workspace.capabilities.limits.maxProductBytes;
        if (file.size > max) throw new Error('文件大小超过限制，请选择较小的文件');
        state.uploadProgress = `正在上传 ${index + 1} / ${files.length}`;
        const result = await api.upload(state.projectId, workspace.run.id, role, file, signal);
        if (!current(epoch)) return false;
        if (!workspace.uploads.some((item) => item.id === result.data.id))
          workspace.uploads.push(result.data);
        if (role === 'REFERENCE') state.draft.referenceUploadId = result.data.id;
        else if (!state.draft.productUploadIds.includes(result.data.id))
          state.draft.productUploadIds.push(result.data.id);
        if (!(await save())) return false;
      }
      return true;
    });
  }
  function remove(id: string) {
    return mutate(async (epoch, workspace, signal) => {
      if (state.draft.referenceUploadId === id) state.draft.referenceUploadId = null;
      state.draft.productUploadIds = state.draft.productUploadIds.filter((item) => item !== id);
      if (!(await save()) || !current(epoch)) return false;
      // An older confirmed input can still depend on this file until the next confirmation.
      if (!workspace.input?.files.some((file) => file.id === id)) {
        await api.remove(state.projectId, workspace.run.id, id, signal);
        if (!current(epoch)) return false;
        workspace.uploads = workspace.uploads.filter((file) => file.id !== id);
        const importedScope = assetImportScopes.get(id);
        if (importedScope) assetImportKeys.delete(importedScope);
        assetImportScopes.delete(id);
      }
      return true;
    });
  }
  function importAsset(assetId: string, version: number, role: CloneUploadRole) {
    return mutate(async (epoch, workspace, signal) => {
      if (
        role === 'PRODUCT' &&
        state.draft.productUploadIds.length >= workspace.capabilities.limits.maxProductFiles
      )
        throw new Error(`商品素材最多 ${workspace.capabilities.limits.maxProductFiles} 份`);
      const scope = `${state.projectId}:${workspace.run.id}:${role}:${assetId}:${version}`;
      const clientUploadKey = assetImportKeys.get(scope) ?? crypto.randomUUID();
      assetImportKeys.set(scope, clientUploadKey);
      const result = await api.importAsset(
        state.projectId,
        workspace.run.id,
        { assetId, version, role, clientUploadKey },
        signal,
      );
      if (!current(epoch)) return false;
      assetImportScopes.set(result.data.id, scope);
      if (!workspace.uploads.some((file) => file.id === result.data.id))
        workspace.uploads.push(result.data);
      if (role === 'REFERENCE') state.draft.referenceUploadId = result.data.id;
      else if (!state.draft.productUploadIds.includes(result.data.id))
        state.draft.productUploadIds.push(result.data.id);
      return save();
    });
  }
  function confirm() {
    return mutate(async (epoch, workspace, signal) => {
      const result = await api.confirm(
        state.projectId,
        workspace.run.id,
        {
          expectedDraftRevision: workspace.draft.revision,
          expectedInputRevision: workspace.input?.ref.revision ?? 0,
        },
        signal,
      );
      if (!current(epoch)) return false;
      apply(result.data);
      return true;
    });
  }
  function queueSave() {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 450);
  }
  function beginAnalysisEdit() {
    const analysis = state.workspace?.g2?.analysis;
    if (!analysis || state.mutating) return;
    if (!state.analysisEditing) {
      state.analysisDraft = {
        schemaVersion: 1,
        sourceInput: copy(analysis.sourceInput),
        baseAnalysisRevision: analysis.ref.revision,
        report: copy(analysis.report),
      };
    }
    state.analysisEditing = true;
  }
  function editReport(report: CloneAnalysisReport) {
    if (!state.workspace?.g2 || !state.analysisEditing || state.mutating) return;
    state.analysisDraft.report = copy(report);
    queueSave();
  }
  function cancelAnalysisEdit() {
    return mutate(async (epoch, workspace, signal) => {
      if (!workspace.g2) return false;
      // A newer automatic report can be adopted, but cancellation must never
      // advance the CAS base to overwrite another window's isolated human edit.
      const latest = await api.workspace(state.projectId, workspace.run.id, signal);
      if (!current(epoch) || !latest.data.g2?.analysis) return false;
      const analysis = latest.data.g2.analysis;
      const draft = {
        schemaVersion: 1 as const,
        sourceInput: copy(analysis.sourceInput),
        baseAnalysisRevision: analysis.ref.revision,
        report: copy(analysis.report),
      };
      if (jsonSignature(latest.data.g2.analysisDraft.state) === jsonSignature(draft)) {
        state.analysisDraft = copy(latest.data.g2.analysisDraft.state);
        savedAnalysisSignature = jsonSignature(state.analysisDraft);
        state.analysisEditing = false;
        apply(latest.data);
        if (!inputDirty() && !mappingDirty()) state.conflict = false;
        return true;
      }
      if (latest.data.g2.analysisDraft.revision !== workspace.g2.analysisDraft.revision)
        throw new ApiClientError('报告草稿已在其他窗口更新，请重新加载后核对', 409);
      const result = await api.saveAnalysis(
        state.projectId,
        workspace.run.id,
        {
          expectedRevision: workspace.g2.analysisDraft.revision,
          state: draft,
        },
        signal,
      );
      if (!current(epoch)) return false;
      state.analysisDraft = draft;
      savedAnalysisSignature = jsonSignature(draft);
      state.analysisEditing = false;
      apply(result.data);
      if (!inputDirty() && !mappingDirty()) state.conflict = false;
      return true;
    }, false);
  }
  function confirmAnalysis() {
    return mutate(async (epoch, workspace, signal) => {
      if (!workspace.g2) return false;
      const result = await api.confirmAnalysis(
        state.projectId,
        workspace.run.id,
        {
          expectedDraftRevision: workspace.g2.analysisDraft.revision,
          expectedAnalysisRevision: workspace.g2.analysis?.ref.revision ?? 0,
        },
        signal,
      );
      if (!current(epoch)) return false;
      state.analysisEditing = false;
      apply(result.data);
      return true;
    });
  }
  function resetMapping() {
    const workspace = state.workspace;
    const analysis = workspace?.g2?.analysis;
    if (!workspace?.input || !analysis || analysis.freshness !== 'CURRENT' || state.mutating)
      return false;
    state.mappingDraft = {
      schemaVersion: 1,
      sourceInput: copy(workspace.input.ref),
      sourceAnalysis: copy(analysis.ref),
      structureLock: cloneStructureLock(copy(analysis.report)),
      bindings: analysis.report.elements.map((element) => ({
        elementId: element.elementId,
        type: element.type,
        shotIds: [...element.shotIds],
        action: element.type === 'person' || element.type === 'scene' ? 'KEEP' : 'REPLACE',
        target: null,
      })),
    };
    queueSave();
    return true;
  }
  function editBinding(binding: CloneMappingBinding) {
    if (!state.workspace?.g2 || state.mutating) return;
    const index = state.mappingDraft.bindings.findIndex(
      (item) => item.elementId === binding.elementId,
    );
    if (index < 0) return;
    state.mappingDraft.bindings[index] = copy(binding);
    queueSave();
  }
  function confirmMapping() {
    return mutate(async (epoch, workspace, signal) => {
      if (!workspace.g2) return false;
      const result = await api.confirmMapping(
        state.projectId,
        workspace.run.id,
        {
          expectedDraftRevision: workspace.g2.mappingDraft.revision,
          expectedMappingRevision: workspace.g2.mapping?.ref.revision ?? 0,
        },
        signal,
      );
      if (!current(epoch)) return false;
      apply(result.data);
      return true;
    });
  }
  function startTask(purpose: CloneMappingPurpose | null = null) {
    return mutate(async (epoch, workspace, signal) => {
      if (!workspace.input || !workspace.g2) return false;
      const request: CloneTaskCreateRequest = {
        idempotencyKey: '',
        sourceInput: copy(workspace.input.ref),
        sourceAnalysis: purpose ? copy(workspace.g2.analysis?.ref ?? null) : null,
        expectedDraftRevision: purpose
          ? workspace.g2.mappingDraft.revision
          : workspace.g2.analysisDraft.revision,
        expectedArtifactRevision: purpose
          ? (workspace.g2.mapping?.ref.revision ?? 0)
          : (workspace.g2.analysis?.ref.revision ?? 0),
        purpose,
      };
      const scope = `${state.projectId}:${workspace.run.id}:${jsonSignature(request)}`;
      request.idempotencyKey = taskKeys.get(scope) ?? crypto.randomUUID();
      taskKeys.set(scope, request.idempotencyKey);
      const result = await api.createTask(
        state.projectId,
        workspace.run.id,
        purpose ? 'mapping' : 'analysis',
        request,
        signal,
      );
      if (!current(epoch)) return false;
      taskKeys.delete(scope);
      apply(result.data);
      return true;
    });
  }
  function changeTask(taskId: string, action: 'cancel' | 'retry') {
    return mutate(async (epoch, workspace, signal) => {
      const result = await api.changeTask(
        state.projectId,
        workspace.run.id,
        taskId,
        action,
        signal,
      );
      if (!current(epoch)) return false;
      apply(result.data);
      return true;
    }, action !== 'cancel');
  }
  function adoptSuggestion(taskId: string) {
    return mutate(async (epoch, workspace, signal) => {
      if (!workspace.g2) return false;
      const result = await api.adoptSuggestion(
        state.projectId,
        workspace.run.id,
        taskId,
        {
          expectedDraftRevision: workspace.g2.mappingDraft.revision,
        },
        signal,
      );
      if (!current(epoch)) return false;
      apply(result.data);
      return true;
    });
  }
  function prepareMappingAsset(assetId: string, version: number) {
    return mutate(async (epoch, workspace, signal) => {
      const result = await api.prepareMappingAsset(
        state.projectId,
        workspace.run.id,
        { assetId, version },
        signal,
      );
      if (!current(epoch)) return false;
      apply(result.data);
      return true;
    });
  }
  const draftRevisions = () => ({
    CLONE_INPUT: state.workspace?.draft.revision ?? 0,
    ...(state.workspace?.g2
      ? {
          CLONE_ANALYSIS: state.workspace.g2.analysisDraft.revision,
          CLONE_MAPPING: state.workspace.g2.mappingDraft.revision,
        }
      : {}),
  });
  function go(step: number): Promise<boolean> {
    if (navigation) return navigation;
    const nodeId = FISSION_CLONE_NODES[step];
    const workspace = state.workspace;
    if (!nodeId || !workspace || mutation) return Promise.resolve(false);
    const epoch = generation;
    const signal = controller.signal;
    const operation = (async () => {
      try {
        if (!(await save())) return false;
        await api.activate(state.projectId, workspace.run.id, nodeId, signal);
        if (!current(epoch)) return false;
        successfulWrites++;
        state.step = step;
        workspace.run.currentNodeId = nodeId;
        return true;
      } catch (error) {
        if (current(epoch)) state.error = errorMessage(error, '节点切换失败，请重试');
        return false;
      } finally {
        if (current(epoch)) navigation = null;
      }
    })();
    navigation = operation;
    return operation;
  }
  async function resumeWorkflowNode(nodeId: string) {
    await initialization;
    return go(FISSION_CLONE_NODES.findIndex((id) => id === nodeId));
  }
  function dispose() {
    generation++;
    clearTimeout(timer);
    clearTimeout(pollTimer);
    controller.abort();
  }
  return {
    state,
    open,
    edit,
    save,
    flushPendingEdits,
    upload,
    importAsset,
    remove,
    confirm,
    go,
    resumeWorkflowNode,
    dispose,
    dirty,
    analysisDirty,
    mappingDirty,
    draftRevisions,
    refresh,
    beginAnalysisEdit,
    cancelAnalysisEdit,
    editReport,
    confirmAnalysis,
    resetMapping,
    editBinding,
    confirmMapping,
    startTask,
    changeTask,
    adoptSuggestion,
    prepareMappingAsset,
  };
}
