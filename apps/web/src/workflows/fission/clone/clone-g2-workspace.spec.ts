import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
  emptyCloneInputDraft,
  FISSION_CLONE_INPUT_LIMITS,
  parseCloneAnalysisReport,
  parseCloneMappingDraft,
  type ApiResponse,
  type CloneWorkspace,
  type CloneTask,
} from '@ai-marketing/contracts';
import { ApiClientError } from '../../../api/http-client';
import { cloneWorkspaceApi, createCloneWorkspace } from './clone-workspace';
import CloneRealReport from './CloneRealReport.vue';
import CloneRealMapping from './CloneRealMapping.vue';
import { cloneContentSignature, sameCloneContent } from './clone-content';

const projectA = '11111111-1111-4111-8111-111111111111';
const projectB = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const report = parseCloneAnalysisReport(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/contracts/fixtures/fission-clone-analysis.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);
const mapping = parseCloneMappingDraft(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/contracts/fixtures/fission-clone-mapping.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withProp = () => {
  const value = clone(report);
  value.elements.unshift({
    ...value.elements[0]!,
    elementId: 'orange_box',
    type: 'prop',
    label: '橙色盒子',
    description: '小瓶右上方的长方形橙色盒',
    required: false,
    evidence: [
      { startMs: 0, endMs: 200, kind: 'VISUAL', confidence: 0.9, description: '小瓶右侧可见' },
    ],
  });
  value.shots[0]!.elementIds.push('orange_box');
  return value;
};
const reverseKeys = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    ) as T;
  return value;
};
const response = <T>(data: T): ApiResponse<T> => ({ success: true, data: clone(data) });
function fixture(projectId = projectA): CloneWorkspace {
  return {
    run: {
      id: runId,
      projectId,
      parentWorkflowRunId: null,
      forkNodeId: null,
      forkTemplateId: null,
      branchLabel: null,
      workflow: 'FISSION',
      workflowSpace: 'FISSION_CLONE',
      status: 'ACTIVE',
      currentNodeId: 'CLONE_MAPPING',
      createdAt: '2026-11-11T00:00:00Z',
      updatedAt: '2026-11-11T00:00:00Z',
      lastActiveAt: '2026-11-11T00:00:00Z',
    },
    draft: {
      revision: 1,
      state: {
        ...emptyCloneInputDraft(),
        productName: '目标绿色包装',
        productFacts: '绿色方块包装',
        sourceRightsConfirmed: true,
      },
    },
    uploads: [],
    input: { ref: clone(mapping.sourceInput!), input: emptyCloneInputDraft(), files: [] },
    capabilities: {
      inputEnabled: true,
      analysisEnabled: true,
      generationEnabled: false,
      mappingEnabled: true,
      mappingSuggestionsEnabled: true,
      keepTextValidationEnabled: true,
      originalTrackKeepEnabled: false,
      burnedInKeepEnabled: false,
      audioTranscriptionEnabled: false,
      analysisMode: 'SAMPLED_FRAMES',
      unavailableReason: null,
      limits: { ...FISSION_CLONE_INPUT_LIMITS },
      referenceExtensions: ['mp4'],
      productExtensions: ['png'],
    },
    g2: {
      analysisDraft: {
        revision: 1,
        state: {
          schemaVersion: 1,
          sourceInput: clone(mapping.sourceInput),
          baseAnalysisRevision: 1,
          report: clone(report),
        },
      },
      mappingDraft: { revision: 1, state: clone(mapping) },
      analysis: {
        ref: clone(mapping.sourceAnalysis!),
        sourceInput: clone(mapping.sourceInput!),
        report: clone(report),
        freshness: 'CURRENT',
      },
      mapping: null,
      tasks: [],
      keepTextEvidence: [],
      analysisDraftDiverged: false,
    },
  };
}
const task = (patch: Partial<CloneTask> = {}): CloneTask => ({
  id: 'task-1',
  operation: 'ANALYZE',
  purpose: null,
  status: 'RUNNING',
  progress: 20,
  stage: 'ANALYZE',
  message: '正在分析画面',
  error: null,
  attemptCount: 1,
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
  canRetry: false,
  suggestionPending: false,
  appliedToDraft: false,
  result: null,
  ...patch,
});
function fakeApi() {
  return {
    ...cloneWorkspaceApi,
    initialize: vi.fn<typeof cloneWorkspaceApi.initialize>().mockResolvedValue(response(fixture())),
    workspace: vi.fn<typeof cloneWorkspaceApi.workspace>().mockResolvedValue(response(fixture())),
    save: vi.fn<typeof cloneWorkspaceApi.save>().mockImplementation(
      async (_p, _r, _n, body) =>
        response({
          unchanged: false,
          nodeState: { revision: (body.expectedRevision ?? 0) + 1 },
        }) as Awaited<ReturnType<typeof cloneWorkspaceApi.save>>,
    ),
    saveAnalysis: vi
      .fn<typeof cloneWorkspaceApi.saveAnalysis>()
      .mockImplementation(async (_p, _r, body) => {
        const value = fixture();
        value.g2!.analysisDraft = { revision: body.expectedRevision + 1, state: clone(body.state) };
        return response(value);
      }),
    activate: vi
      .fn<typeof cloneWorkspaceApi.activate>()
      .mockResolvedValue(response({}) as Awaited<ReturnType<typeof cloneWorkspaceApi.activate>>),
    confirmAnalysis: vi
      .fn<typeof cloneWorkspaceApi.confirmAnalysis>()
      .mockResolvedValue(response(fixture())),
    confirmMapping: vi
      .fn<typeof cloneWorkspaceApi.confirmMapping>()
      .mockResolvedValue(response(fixture())),
    createTask: vi.fn<typeof cloneWorkspaceApi.createTask>().mockResolvedValue(response(fixture())),
    changeTask: vi.fn<typeof cloneWorkspaceApi.changeTask>().mockResolvedValue(response(fixture())),
    adoptSuggestion: vi
      .fn<typeof cloneWorkspaceApi.adoptSuggestion>()
      .mockResolvedValue(response(fixture())),
    prepareMappingAsset: vi
      .fn<typeof cloneWorkspaceApi.prepareMappingAsset>()
      .mockResolvedValue(response(fixture())),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const controllers: ReturnType<typeof createCloneWorkspace>[] = [];
function create() {
  const api = fakeApi();
  const workspace = createCloneWorkspace(api);
  controllers.push(workspace);
  return { api, workspace };
}
afterEach(() => {
  controllers.splice(0).forEach((workspace) => workspace.dispose());
  vi.useRealTimers();
});

describe('clone G2 workspace editing and tasks', () => {
  it('defaults recognized props to KEEP when initializing the mapping draft', async () => {
    const { workspace, api } = create();
    const server = fixture();
    server.g2!.analysis!.report = withProp();
    api.initialize.mockResolvedValueOnce(response(server));
    await workspace.open(projectA);
    expect(workspace.resetMapping()).toBe(true);
    expect(
      workspace.state.mappingDraft.bindings.find((item) => item.elementId === 'orange_box'),
    ).toMatchObject({ type: 'prop', action: 'KEEP', target: null, shotIds: ['shot_a'] });
    expect(
      workspace.state.mappingDraft.bindings.find((item) => item.type === 'product')?.action,
    ).toBe('REPLACE');
  });
  it('keeps JSONB-reordered references current after preparing an asset without inventing draft changes', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const jsonb = fixture();
    jsonb.g2!.mappingDraft.state = reverseKeys(jsonb.g2!.mappingDraft.state);
    jsonb.g2!.analysisDraft.state = reverseKeys(jsonb.g2!.analysisDraft.state);
    api.prepareMappingAsset.mockResolvedValue(response(jsonb));
    expect(await workspace.prepareMappingAsset(projectB, 7)).toBe(true);
    expect(
      sameCloneContent(
        workspace.state.mappingDraft.sourceInput,
        workspace.state.workspace?.input?.ref,
      ),
    ).toBe(true);
    expect(
      sameCloneContent(
        workspace.state.mappingDraft.sourceAnalysis,
        workspace.state.workspace?.g2?.analysis?.ref,
      ),
    ).toBe(true);
    expect(sameCloneContent(workspace.state.mappingDraft, mapping)).toBe(true);
    workspace.beginAnalysisEdit();
    expect(workspace.analysisDirty()).toBe(false);
    expect(workspace.mappingDirty()).toBe(false);
    expect(api.saveAnalysis).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });
  it('restores a JSONB report without opening a false isolated edit, and preserves meaningful array order', async () => {
    const { workspace, api } = create();
    const jsonb = fixture();
    jsonb.g2!.analysisDraft.state = reverseKeys(jsonb.g2!.analysisDraft.state);
    api.initialize.mockResolvedValue(response(jsonb));
    await workspace.open(projectA);
    expect(workspace.state.analysisEditing).toBe(false);
    expect(cloneContentSignature(mapping)).toBe(cloneContentSignature(reverseKeys(mapping)));
    const changed = clone(mapping);
    changed.bindings.reverse();
    expect(sameCloneContent(mapping, changed)).toBe(false);
    const changedRef = {
      ...mapping.sourceAnalysis!,
      revision: mapping.sourceAnalysis!.revision + 1,
    };
    expect(sameCloneContent(mapping.sourceAnalysis, changedRef)).toBe(false);
  });
  it('keeps dirty mapping and its original CAS base while polling updates task and confirmed report', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const edited = clone(workspace.state.mappingDraft.bindings[0]!);
    edited.target!.text = '用户未保存的目标';
    workspace.editBinding(edited);
    const server = fixture();
    server.run.currentNodeId = 'CLONE_ANALYSIS';
    server.g2!.mappingDraft.revision = 2;
    server.g2!.mappingDraft.state.bindings[0]!.target!.text = '迟到建议';
    server.g2!.analysis!.ref.revision = 2;
    api.workspace.mockResolvedValue(response(server));
    await workspace.refresh();
    expect(workspace.state.mappingDraft.bindings[0]?.target?.text).toBe('用户未保存的目标');
    expect(workspace.state.workspace?.g2?.mappingDraft.revision).toBe(1);
    expect(workspace.state.workspace?.g2?.analysis?.ref.revision).toBe(2);
    expect(workspace.state.step).toBe(2);
  });
  it('does not roll a completed mapping save back with an older poll response', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<ApiResponse<CloneWorkspace>>();
    api.workspace.mockReturnValueOnce(pending.promise);
    const refresh = workspace.refresh();
    const edited = clone(workspace.state.mappingDraft.bindings[0]!);
    edited.target!.text = '已成功保存';
    workspace.editBinding(edited);
    await workspace.save();
    pending.resolve(response(fixture()));
    await refresh;
    expect(workspace.state.workspace?.g2?.mappingDraft.revision).toBe(2);
    expect(workspace.state.mappingDraft.bindings[0]?.target?.text).toBe('已成功保存');
    expect(workspace.mappingDirty()).toBe(false);
  });
  it('serializes human report drafts without committing until explicit save report', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    workspace.beginAnalysisEdit();
    const pending = deferred<ApiResponse<CloneWorkspace>>();
    api.saveAnalysis.mockReturnValueOnce(pending.promise);
    const first = clone(report);
    first.creativity.concept = '第一版人工创意';
    workspace.editReport(first);
    const saving = workspace.save();
    const second = clone(first);
    second.creativity.concept = '第二版人工创意';
    workspace.editReport(second);
    const result = fixture();
    result.g2!.analysisDraft = {
      revision: 2,
      state: { ...result.g2!.analysisDraft.state, report: first },
    };
    pending.resolve(response(result));
    expect(await saving).toBe(true);
    expect(api.saveAnalysis.mock.calls.map((args) => args[2].expectedRevision)).toEqual([1, 2]);
    expect(workspace.state.analysisDraft.report?.creativity.concept).toBe('第二版人工创意');
    expect(api.confirmAnalysis).not.toHaveBeenCalled();
    await workspace.confirmAnalysis();
    expect(api.confirmAnalysis.mock.calls[0]?.[2]).toEqual({
      expectedDraftRevision: 3,
      expectedAnalysisRevision: 1,
    });
  });
  it('restores polling and displays auto-committed analysis without a second confirmation', async () => {
    vi.useFakeTimers();
    const { workspace, api } = create();
    const running = fixture();
    running.g2!.analysis = null;
    running.g2!.analysisDraft.state.report = null;
    running.g2!.tasks = [task()];
    api.initialize.mockResolvedValue(response(running));
    await workspace.open(projectA);
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.workspace).toHaveBeenCalledTimes(1);
    expect(workspace.state.workspace?.g2?.analysis?.ref.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.workspace).toHaveBeenCalledTimes(1);
    expect(api.createTask).not.toHaveBeenCalled();
    expect(api.confirmAnalysis).not.toHaveBeenCalled();
  });
  it('discards an old project poll after switching scope', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<ApiResponse<CloneWorkspace>>();
    api.workspace.mockReturnValue(pending.promise);
    const refresh = workspace.refresh();
    api.initialize.mockResolvedValue(response(fixture(projectB)));
    await workspace.open(projectB);
    pending.resolve(response(fixture(projectA)));
    expect(await refresh).toBe(false);
    expect(workspace.state.workspace?.run.projectId).toBe(projectB);
  });
  it('does not erase a newly created task with a poll that started before the creation', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<ApiResponse<CloneWorkspace>>();
    api.workspace.mockReturnValueOnce(pending.promise);
    const refresh = workspace.refresh();
    const started = fixture();
    started.g2!.tasks = [task()];
    api.createTask.mockResolvedValue(response(started));
    await workspace.startTask();
    pending.resolve(response(fixture()));
    expect(await refresh).toBe(false);
    expect(workspace.state.workspace?.g2?.tasks[0]?.id).toBe('task-1');
  });
  it('flushes mapping before adopting a pending suggestion and does not confirm mapping', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const edited = clone(workspace.state.mappingDraft.bindings[0]!);
    edited.target!.text = '先保存我的编辑';
    workspace.editBinding(edited);
    await workspace.adoptSuggestion('suggestion-1');
    expect(api.adoptSuggestion.mock.calls[0]?.[3]).toEqual({ expectedDraftRevision: 2 });
    expect(api.save.mock.calls[0]?.[2]).toBe('CLONE_MAPPING');
    expect(api.confirmMapping).not.toHaveBeenCalled();
  });
  it('retains idempotency after a lost response and rotates it after a successful request', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    api.createTask.mockRejectedValueOnce(new ApiClientError('网络中断', 503));
    expect(await workspace.startTask()).toBe(false);
    expect(await workspace.startTask()).toBe(true);
    expect(await workspace.startTask()).toBe(true);
    expect(api.createTask.mock.calls[0]?.[3].idempotencyKey).toBe(
      api.createTask.mock.calls[1]?.[3].idempotencyKey,
    );
    expect(api.createTask.mock.calls[2]?.[3].idempotencyKey).not.toBe(
      api.createTask.mock.calls[1]?.[3].idempotencyKey,
    );
  });
  it('preserves mapping conflict and does not launch a model task after failed flush', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const edited = clone(workspace.state.mappingDraft.bindings[0]!);
    edited.target!.text = '保留本地目标';
    workspace.editBinding(edited);
    api.save.mockRejectedValue(new ApiClientError('版本冲突', 409));
    expect(await workspace.startTask('SMART_MATCH')).toBe(false);
    expect(workspace.state.conflict).toBe(true);
    expect(workspace.state.mappingDraft.bindings[0]?.target?.text).toBe('保留本地目标');
    expect(api.createTask).not.toHaveBeenCalled();
  });
  it('prepares an exact target asset without silently confirming or changing a binding', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const before = clone(workspace.state.mappingDraft);
    expect(await workspace.prepareMappingAsset(projectB, 7)).toBe(true);
    expect(api.prepareMappingAsset.mock.calls[0]?.[2]).toEqual({ assetId: projectB, version: 7 });
    expect(workspace.state.mappingDraft).toEqual(before);
    expect(api.confirmMapping).not.toHaveBeenCalled();
  });
  it('cancels a task even when an unrelated draft cannot be saved', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const edited = clone(workspace.state.mappingDraft.bindings[0]!);
    edited.target!.text = '保留冲突编辑';
    workspace.editBinding(edited);
    workspace.state.conflict = true;
    expect(await workspace.changeTask('task-1', 'cancel')).toBe(true);
    expect(api.changeTask).toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(workspace.state.mappingDraft.bindings[0]?.target?.text).toBe('保留冲突编辑');
  });
  it('cancels an isolated edit onto the latest confirmed report without committing or replacing mapping edits', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    workspace.beginAnalysisEdit();
    const human = clone(report);
    human.creativity.concept = '丢弃的人工草稿';
    workspace.editReport(human);
    const binding = clone(workspace.state.mappingDraft.bindings[0]!);
    binding.target!.text = '保留的映射草稿';
    workspace.editBinding(binding);
    const latest = fixture();
    latest.g2!.analysis!.ref.revision = 2;
    latest.g2!.analysis!.report.creativity.concept = '新自动报告';
    latest.g2!.analysisDraft.revision = 3;
    latest.g2!.analysisDraft.state = reverseKeys({
      schemaVersion: 1,
      sourceInput: clone(latest.g2!.analysis!.sourceInput),
      baseAnalysisRevision: 2,
      report: clone(latest.g2!.analysis!.report),
    });
    api.workspace.mockResolvedValue(response(latest));
    expect(await workspace.cancelAnalysisEdit()).toBe(true);
    expect(api.saveAnalysis).not.toHaveBeenCalled();
    expect(workspace.state.analysisDraft.report?.creativity.concept).toBe('新自动报告');
    expect(workspace.state.analysisEditing).toBe(false);
    expect(api.confirmAnalysis).not.toHaveBeenCalled();
    expect(workspace.state.mappingDraft.bindings[0]?.target?.text).toBe('保留的映射草稿');
  });
  it('does not use cancellation to overwrite a newer human draft from another window', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    workspace.beginAnalysisEdit();
    const local = clone(report);
    local.creativity.concept = '当前窗口草稿';
    workspace.editReport(local);
    const latest = fixture();
    latest.g2!.analysisDraft.revision = 2;
    latest.g2!.analysisDraft.state.report!.creativity.concept = '另一窗口新草稿';
    api.workspace.mockResolvedValue(response(latest));
    expect(await workspace.cancelAnalysisEdit()).toBe(false);
    expect(api.saveAnalysis).not.toHaveBeenCalled();
    expect(api.confirmAnalysis).not.toHaveBeenCalled();
    expect(workspace.state.conflict).toBe(true);
    expect(workspace.state.analysisDraft.report?.creativity.concept).toBe('当前窗口草稿');
  });
});

describe('clone G2 real presentation', () => {
  it('renders report evidence and measured duration without prototype audio facts', async () => {
    const html = await renderToString(
      createSSRApp(CloneRealReport, {
        report: withProp(),
        productName: '目标包装',
        referenceName: 'reference.mp4',
        referenceUrl: '',
        editing: false,
      }),
    );
    expect(html).toContain('00:03.000');
    expect(html).toContain('360 × 640');
    expect(html).toContain('尚未分析');
    expect(html).toContain('画面观察');
    expect(html).toContain('运镜');
    expect(html).toContain('构图');
    expect(html).toContain('镜头参考');
    expect(html).toContain('查看画面证据');
    expect(html).not.toContain('112 BPM');
    expect(html).not.toContain('广式腊肠');
  });
  it('counts every required product instance rather than the first product only', async () => {
    const sample = clone(report);
    const source = sample.elements[0]!;
    sample.elements.push({
      ...clone(source),
      elementId: 'product_second',
      label: '第二个产品实例',
    });
    const value = clone(mapping);
    value.bindings[1]!.target!.asset = { assetId: projectA, version: 1 };
    value.bindings.push({
      ...clone(value.bindings[0]!),
      elementId: 'product_second',
      target: null,
    });
    const html = await renderToString(
      createSSRApp(CloneRealMapping, {
        projectId: projectA,
        draft: value,
        report: sample,
        productName: '目标包装',
        capabilities: fixture().capabilities,
        disabled: false,
        error: '',
        prepareAsset: async () => true,
      }),
    );
    expect(html).toContain('第二个产品实例');
    expect(html).toContain('1/3');
    expect(html).toContain('JPEG、PNG 或 WebP');
    expect(html).toContain('产品');
    expect(html).not.toContain('112 BPM');
  });
  it.each(['BURNED_IN', 'UNKNOWN', 'VISUAL'] as const)(
    'shows unsupported %s subtitle retention as unavailable without hiding text replacement',
    async (sourceTrack) => {
      const sample = clone(report);
      sample.elements = [
        {
          ...sample.elements[0]!,
          elementId: 'subtitle-1',
          type: 'subtitle',
          label: '原片字幕',
          required: false,
          sourceTrack,
          transcriptText: '画面字幕原文',
        },
      ];
      const value = clone(mapping);
      value.bindings = [{ ...value.bindings[0]!, elementId: 'subtitle-1', type: 'subtitle' }];
      const html = await renderToString(
        createSSRApp(CloneRealMapping, {
          projectId: projectA,
          draft: value,
          report: sample,
          productName: '目标包装',
          capabilities: fixture().capabilities,
          disabled: false,
          error: '',
          prepareAsset: async () => true,
        }),
      );
      expect(html).toContain(
        sourceTrack === 'BURNED_IN' ? '当前不能可靠保留烧录字幕' : '当前未开放原字幕表现保留',
      );
      expect(html).toContain('disabled');
      expect(html).toContain('目标文字内容');
    },
  );
  it('counts a non-product style-only replacement as configured', async () => {
    const sample = clone(report);
    sample.elements = [
      { ...sample.elements[0]!, elementId: 'scene-1', type: 'scene', required: false },
    ];
    const value = clone(mapping);
    value.bindings = [
      {
        ...value.bindings[0]!,
        elementId: 'scene-1',
        type: 'scene',
        target: { ...value.bindings[0]!.target!, asset: null, text: '', style: '柔和暖色背景' },
      },
    ];
    const html = await renderToString(
      createSSRApp(CloneRealMapping, {
        projectId: projectA,
        draft: value,
        report: sample,
        productName: '目标包装',
        capabilities: fixture().capabilities,
        disabled: false,
        error: '',
        prepareAsset: async () => true,
      }),
    );
    expect(html).toContain('100%');
    expect(html).toContain('已配置');
  });
  it('keeps historical props as shot references and prompts before changing old replacements', async () => {
    const value = clone(mapping);
    for (const item of value.bindings) item.target!.asset = { assetId: projectA, version: 1 };
    value.bindings.unshift({
      ...value.bindings[0]!,
      elementId: 'orange_box',
      type: 'prop',
      action: 'KEEP',
      target: null,
    });
    const props = {
      projectId: projectA,
      draft: value,
      report: withProp(),
      productName: '目标包装',
      capabilities: fixture().capabilities,
      disabled: false,
      error: '',
      prepareAsset: async () => true,
    };
    const keep = await renderToString(createSSRApp(CloneRealMapping, props));
    expect(keep).toContain('已保留为镜头参考');
    expect(keep).toContain('小瓶右上方的长方形橙色盒');
    expect(keep).toContain('100%');
    value.bindings[0]!.action = 'REPLACE';
    value.bindings[0]!.target = { ...value.bindings[1]!.target!, text: '换蓝盒' };
    const pending = await renderToString(createSSRApp(CloneRealMapping, props));
    expect(pending).toContain('此道具仍使用旧替换配置');
    expect(pending).toContain('保留为镜头参考');
    expect(pending).not.toContain('选择项目资产');
    expect(pending).not.toContain('>替换</button>');
    expect(pending).toContain('67%');
    expect(value.bindings[0]).toMatchObject({ action: 'REPLACE', target: { text: '换蓝盒' } });
  });
});
