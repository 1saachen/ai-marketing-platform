import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, reactive, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type {
  CustomizedUpdatePreview,
  ProductionTask,
  ProductionWorkspace,
  ProductionVideoDocument,
} from '@ai-marketing/contracts';
import Workspace from './CustomizedProductionWorkspace.vue';
import LocalUpdate from '../shared/CustomizedLocalUpdate.vue';
import { productionApi } from './production.api';
import { ApiClientError } from '../../../api/http-client';
import { useActionConfirmation } from '../../../shared/composables/action-confirmation';
vi.mock('./production.api', () => ({
  productionApi: {
    workspace: vi.fn(),
    task: vi.fn(),
    retry: vi.fn(),
    retryLocalMedia: vi.fn(),
    start: vi.fn(),
    localUpdate: vi.fn(),
    preview: vi.fn(),
    retainAssetImages: vi.fn(),
    save: vi.fn(),
  },
}));
type Host = { children: Host[]; parent: Host | null };
const node = (): Host => ({ children: [], parent: null });
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  setText() {},
  setElementText() {},
  patchProp() {},
  insert(c, p) {
    c.parent = p;
    p.children.push(c);
  },
  remove(c) {
    if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
  },
  parentNode: (c) => c.parent,
  nextSibling: () => null,
});
const cleanups: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const task = (
  operation: 'PROMPT' | 'RENDER',
  status: ProductionTask['status'] = 'FAILED',
): ProductionTask => ({
  id: 'original',
  operation,
  status,
  progress: 25,
  shotId: null,
  target: { kind: 'CLIP', id: 'clip-a' },
  errorMessage: status === 'FAILED' ? '任务未完成' : null,
  steps: [],
});
const initial = (operation: 'PROMPT' | 'RENDER'): ProductionWorkspace => {
  const document = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).document as ProductionVideoDocument;
  return {
    script: { name: '测试' },
    document,
    confirmedDocument: document,
    prompts: [
      {
        value: { target: { kind: 'CLIP', id: 'clip-a' }, content: '原提示词', assetIds: [] },
        revision: 3,
        stale: false,
      },
    ],
    videos: [{ revision: 1, stale: false, value: { clipId: 'clip-a' } }],
    tasks: [task(operation)],
    draftRevision: 42,
    shotsConfirmed: true,
    assetsConfirmed: true,
  } as unknown as ProductionWorkspace;
};
async function mount(value: ProductionWorkspace, mode: 'ASSETS' | 'SHOTS' = 'SHOTS') {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(productionApi.workspace).mockResolvedValue(value);
  const props = reactive({ projectId: 'p', workflowRunId: 'r', mode });
  let state: Record<string, unknown> = {};
  const component = {
    ...Workspace,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  } as unknown as typeof Workspace;
  const app = renderer.createApp({ render: () => h(component, props) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanups.push(() => app.unmount());
  await settle();
  return {
    state,
    props,
    html: () => renderToString(createSSRApp({ ...Workspace, setup: () => state }, props)),
    retry: (id = 'original') => (state.retryTask as (id: string) => Promise<void>)(id),
  };
}
afterEach(() => {
  useActionConfirmation().cancel();
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it('starts the confirmed asset update and recovers the attached image stage after loading', async () => {
  const value = { ...initial('PROMPT'), tasks: [], sourceReady: true };
  const { state, html, retry } = await mount(value, 'ASSETS');
  const preview: CustomizedUpdatePreview = {
    version: 1,
    workflowRunId: 'r',
    node: 'ASSETS',
    targetId: null,
    fingerprint: 'preview',
    items: [{ id: 'cup', name: '随行杯', action: 'UPDATE', reason: '脚本更新' }],
    blockers: [],
    calls: ['TEXT', 'IMAGE'],
    assetImageCount: 1,
    scope: 'DEPENDENCIES',
  };
  const text: ProductionTask = {
    id: 'text',
    status: 'RUNNING',
    progress: 30,
    shotId: null,
    errorMessage: null,
    steps: [],
    operation: 'ASSETS',
    incremental: { version: 1, batchKey: 'batch', targetIds: ['cup'] },
    assetImageRefresh: { version: 1 },
  };
  const image: ProductionTask = {
    ...text,
    id: 'image',
    operation: 'IMAGE',
    imageSettings: {
      assetIds: ['cup'],
      model: 'doubao-seedream-5-0-pro-260628',
      resolution: '2K',
      ratio: '1:1',
    },
    assetImageRefresh: { version: 1, definitionTaskId: text.id },
  };
  const update = state.updateLocal as (value: CustomizedUpdatePreview) => Promise<void>;
  vi.mocked(productionApi.localUpdate).mockResolvedValue([text]);
  await update(preview);
  expect(productionApi.localUpdate).toHaveBeenCalledWith(
    'p',
    'r',
    'ASSETS',
    { version: 1, fingerprint: preview.fingerprint, refreshAssetImages: true },
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(state.localSummary).toBe('正在核对并更新资产定义');
  const confirmedText = { ...text, status: 'COMPLETED' as const };
  vi.mocked(productionApi.task).mockResolvedValue(confirmedText);
  vi.mocked(productionApi.workspace).mockResolvedValue({ ...value, tasks: [image, confirmedText] });
  await vi.advanceTimersByTimeAsync(1801);
  await settle();
  expect(state.localSummary).toContain('关联图片已生成 0 / 1 张');
  expect((await html()).match(/<header class="node-heading"[^>]*>[\s\S]*?<\/header>/)?.[0]).toMatch(
    /node-heading__update[\s\S]*局部更新/,
  );
  vi.mocked(productionApi.workspace).mockResolvedValue({
    ...value,
    tasks: [{ ...image, status: 'FAILED' }, confirmedText],
  });
  await (state.load as () => Promise<void>)();
  expect(await html()).toContain('继续图片更新');
  vi.mocked(productionApi.retry).mockResolvedValue({ ...image, status: 'QUEUED' });
  await retry(image.id);
  expect(state.localSummary).toBe('等待更新 1 张关联图片');
  expect(productionApi.retry).toHaveBeenCalledWith('p', image.id, expect.any(AbortSignal));
  expect(productionApi.localUpdate).toHaveBeenCalledTimes(1);
});
it('uses the same rightmost heading action on the video page', async () => {
  const { html } = await mount(initial('PROMPT'));
  const header = (await html()).match(/<header class="node-heading"[^>]*>[\s\S]*?<\/header>/)?.[0];
  expect(header).toMatch(/node-heading__actions[\s\S]*node-heading__update[\s\S]*局部更新/);
});
it('offers a fresh preview for a known invalid local storyboard and continues recoverable candidates', async () => {
  const failed: ProductionTask = {
    ...task('PROMPT'),
    operation: 'SHOTS',
    incremental: { version: 1, batchKey: 'local-batch', targetIds: ['clip-a'] },
    failureReason: 'INVALID_CANDIDATE',
  };
  const { state, html, retry } = await mount({ ...initial('PROMPT'), tasks: [failed] });
  expect(await html()).toContain('重新查看更新范围');
  expect(await html()).not.toContain('继续更新分镜');
  await retry(failed.id);
  expect(productionApi.retry).not.toHaveBeenCalled();
  const recoverable = { ...failed };
  delete recoverable.failureReason;
  (state.workspace as ProductionWorkspace).tasks = [recoverable];
  expect(await html()).toContain('继续更新分镜');
  const reviewed: ProductionTask = {
    ...failed,
    failureReason: 'REVIEW_UNRESOLVED',
    localStoryboard: { startedAt: new Date().toISOString(), attempt: 1, reviewAvailable: true },
  };
  (state.workspace as ProductionWorkspace).tasks = [reviewed];
  expect(await html()).toContain('继续审校');
  expect(await html()).not.toContain('重新查看更新范围');
  vi.mocked(productionApi.retry).mockResolvedValue({ ...reviewed, status: 'QUEUED' });
  await retry(reviewed.id);
  expect(productionApi.retry).toHaveBeenCalledWith('p', reviewed.id, expect.any(AbortSignal));
});
it('shows the actual storyboard stage, retry attempt, and elapsed time after loading', async () => {
  const active: ProductionTask = {
    ...task('PROMPT', 'RUNNING'),
    operation: 'SHOTS',
    incremental: { version: 1, batchKey: 'local-batch', targetIds: ['clip-a'] },
    localStoryboard: { startedAt: new Date(Date.now() - 125_000).toISOString(), attempt: 2 },
    steps: [{ id: 'GENERATE', status: 'RUNNING', title: '分镜局部更新', content: '' }],
  };
  const { state, html } = await mount({ ...initial('PROMPT'), tasks: [active] });
  expect(await html()).toContain('生成分镜候选 · 第 2 次尝试 · 已用时 2 分 5 秒');
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.localSummary).toContain('已用时 2 分 6 秒');
});
it('retains a media batch result and continues only the failed items after confirmation', async () => {
  const version = '2026-11-10T01:02:54.850Z';
  const item = (id: string, status: ProductionTask['status']): ProductionTask => ({
    ...task('PROMPT', status),
    id,
    target: { kind: 'CLIP', id },
    incremental: { version: 1, batchKey: 'batch', targetIds: [id] },
    ...(status === 'FAILED' ? { localMediaRetryVersion: version } : {}),
  });
  const done = item('clip-a', 'COMPLETED');
  const b = item('clip-b', 'FAILED');
  const c = item('clip-c', 'FAILED');
  const value = initial('PROMPT');
  const { state, html } = await mount({ ...value, tasks: [b, c, done] });
  expect(await html()).toContain('提示词更新部分完成');
  expect(await html()).toContain('已完成 1 / 3 条 · 2 条失败');
  expect(await html()).toContain('继续 2 条提示词更新');
  vi.mocked(productionApi.retryLocalMedia).mockResolvedValue([
    item('clip-b', 'QUEUED'),
    item('clip-c', 'QUEUED'),
    done,
  ]);
  const retry = (state.retryLocalBatch as () => Promise<void>)();
  expect(useActionConfirmation().state.open).toBe(true);
  expect(productionApi.retryLocalMedia).not.toHaveBeenCalled();
  useActionConfirmation().confirm();
  await retry;
  expect(productionApi.retryLocalMedia).toHaveBeenCalledWith(
    'p',
    'batch',
    {
      workflowRunId: 'r',
      tasks: [
        { id: b.id, version },
        { id: c.id, version },
      ],
    },
    expect.any(AbortSignal),
  );
  expect(state.localSummary).toContain('已完成 1 / 3 条');
  const completed = [done, item('clip-b', 'COMPLETED'), item('clip-c', 'COMPLETED')];
  vi.mocked(productionApi.task).mockImplementation(async (_project, id) =>
    completed.find((t) => t.id === id)!,
  );
  const savedPrompt = value.prompts[0]!;
  vi.mocked(productionApi.workspace).mockResolvedValue({
    ...value,
    tasks: completed,
    prompts: [
      savedPrompt,
      { ...savedPrompt, value: { ...savedPrompt.value, target: { kind: 'CLIP', id: 'clip-b' } } },
    ],
  });
  await vi.advanceTimersByTimeAsync(1801);
  await settle();
  expect(await html()).toContain('提示词更新完成');
  expect(await html()).toContain('已完成 3 / 3 条');
  expect(await html()).toContain('查看待更新视频');
  await (state.load as () => Promise<void>)();
  expect(await html()).toContain('提示词更新完成');
});
it('shows a video receipt that still needs checking without offering to resubmit it', async () => {
  const uncertain: ProductionTask = {
    ...task('RENDER'),
    incremental: { version: 1, batchKey: 'video-batch', targetIds: ['clip-a'] },
    renderCreateUnconfirmed: true,
  };
  const { state, html, retry } = await mount({ ...initial('RENDER'), tasks: [uncertain] });
  expect(await html()).toContain('1 条视频的接单结果待确认');
  expect(await html()).not.toContain('继续 1 条视频更新');
  await (state.retryLocalBatch as () => Promise<void>)();
  await retry();
  expect(productionApi.retryLocalMedia).not.toHaveBeenCalled();
  expect(productionApi.retry).not.toHaveBeenCalled();
});
it('offers input inspection for a rejected render and blocks resubmission of the frozen request', async () => {
  const rejected: ProductionTask = {
    ...task('RENDER'),
    incremental: { version: 1, batchKey: 'video-batch', targetIds: ['clip-a'] },
    renderInputRejected: true,
    localMediaRetryVersion: '2026-11-10T03:39:18.212Z',
  };
  const { state, html, retry } = await mount({ ...initial('RENDER'), tasks: [rejected] });
  expect(await html()).toContain('检查需调整的分镜');
  expect(await html()).not.toContain('继续 1 条视频更新');
  await (state.retryLocalBatch as () => Promise<void>)();
  await retry();
  expect(productionApi.retryLocalMedia).not.toHaveBeenCalled();
  expect(productionApi.retry).not.toHaveBeenCalled();
});
it('keeps only the selected original and refreshes the remaining image choices without generation', async () => {
  const preview: CustomizedUpdatePreview = {
    version: 1,
    workflowRunId: 'r',
    node: 'ASSETS',
    targetId: null,
    fingerprint: 'preview',
    items: [
      { id: 'cup', name: '杯子', action: 'UPDATE', reason: '制作说明变化' },
      { id: 'person', name: '人物', action: 'UPDATE', reason: '制作说明变化' },
    ],
    blockers: [],
    calls: ['IMAGE'],
    assetImageCount: 2,
    scope: 'DEPENDENCIES',
  };
  vi.mocked(productionApi.preview).mockResolvedValue(preview);
  const { state: workspace } = await mount(
    { ...initial('PROMPT'), tasks: [], imageReviewObjectIds: ['cup', 'person'] },
    'ASSETS',
  );
  const update = workspace.updateLocal as (value: CustomizedUpdatePreview, ids?: string[]) => void;
  const hideRetained = workspace.hideRetainedImages as (ids: string[]) => void;
  const next = {
    ...preview,
    fingerprint: 'after-retention',
    items: [preview.items[0]!],
    assetImageCount: 1,
  };
  vi.mocked(productionApi.retainAssetImages).mockResolvedValue(next);
  vi.mocked(productionApi.localUpdate).mockResolvedValue([]);
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...LocalUpdate,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    {
      projectId: 'p',
      workflowRunId: 'r',
      nodes: ['ASSETS'],
      onExecute: update,
      onImagesRetained: hideRetained,
    },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanups.push(() => app.unmount());
  (state.show as () => void)();
  await settle();
  expect(state.selectedImages).toEqual([]);
  expect(state.canExecute).toBe(false);
  const retain = state.retainImages as () => Promise<void>;
  await retain();
  expect(productionApi.retainAssetImages).not.toHaveBeenCalled();
  state.selectedImages = ['person'];
  await retain();
  expect(productionApi.retainAssetImages).toHaveBeenCalledWith(
    'p',
    'r',
    { version: 1, fingerprint: preview.fingerprint, assetIds: ['person'] },
    expect.any(AbortSignal),
  );
  expect((workspace.workspace as ProductionWorkspace).imageReviewObjectIds).toEqual(['cup']);
  expect(state.open).toBe(true);
  expect(state.preview).toEqual(next);
  expect(state.selectedImages).toEqual([]);
  expect(state.retainedCount).toBe(1);
  expect(productionApi.localUpdate).not.toHaveBeenCalled();
  state.selectedImages = ['cup'];
  expect(state.confirmLabel).toBe('更新所选图片');
  (state.execute as () => void)();
  expect(productionApi.localUpdate).toHaveBeenCalledWith(
    'p',
    'r',
    'ASSETS',
    {
      version: 1,
      fingerprint: next.fingerprint,
      refreshAssetImages: true,
      imageAssetIds: ['cup'],
    },
    expect.any(String),
    expect.any(AbortSignal),
  );
});
it.each(['PROMPT', 'RENDER'] as const)(
  'explicitly continues the same %s task, polls real status, preserves artifacts and never creates a new task',
  async (operation) => {
    const value = initial(operation),
      { state, retry } = await mount(value),
      document = structuredClone(value.document);
    expect(productionApi.retry).not.toHaveBeenCalled();
    vi.mocked(productionApi.retry).mockResolvedValue(task(operation, 'QUEUED'));
    vi.mocked(productionApi.task).mockResolvedValue(task(operation, 'RUNNING'));
    await retry();
    expect(productionApi.retry).toHaveBeenCalledWith('p', 'original', expect.any(AbortSignal));
    await retry();
    expect(productionApi.retry).toHaveBeenCalledTimes(1);
    expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('QUEUED');
    expect(state.document).toEqual(document);
    expect((state.workspace as ProductionWorkspace).prompts).toEqual(value.prompts);
    expect((state.workspace as ProductionWorkspace).videos).toEqual(value.videos);
    expect((state.workspace as ProductionWorkspace).draftRevision).toBe(42);
    await vi.advanceTimersByTimeAsync(1801);
    await settle();
    expect(productionApi.task).toHaveBeenCalledWith('p', 'original', expect.any(AbortSignal));
    expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('RUNNING');
    expect(productionApi.start).not.toHaveBeenCalled();
    expect(productionApi.save).not.toHaveBeenCalled();
  },
);
it('preserves the draft and old outputs on a stale-source 409', async () => {
  const value = initial('RENDER'),
    { state, retry } = await mount(value),
    before = structuredClone(value);
  vi.mocked(productionApi.retry).mockRejectedValue(
    new ApiClientError('任务来源已更新，请重新核对', 409),
  );
  await retry();
  expect(state.document).toEqual(before.document);
  expect((state.workspace as ProductionWorkspace).videos).toEqual(before.videos);
  expect((state.workspace as ProductionWorkspace).prompts).toEqual(before.prompts);
  expect((state.retryError as { message: string }).message).toContain('来源已更新');
  expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('FAILED');
  expect(productionApi.save).not.toHaveBeenCalled();
  expect(productionApi.start).not.toHaveBeenCalled();
});
it('does not discard or submit dirty local plan/prompt edits in order to resume an old snapshot', async () => {
  const { state, retry } = await mount(initial('PROMPT'));
  state.videoWorkbench = { hasDirty: true };
  await retry();
  expect(productionApi.retry).not.toHaveBeenCalled();
  state.videoWorkbench = null;
  (state.document as ProductionVideoDocument).videoPlan.shots[0]!.visual = '本地画面修改';
  await settle();
  await retry();
  expect((state.document as ProductionVideoDocument).videoPlan.shots[0]!.visual).toBe(
    '本地画面修改',
  );
  expect(productionApi.retry).not.toHaveBeenCalled();
  expect(productionApi.save).not.toHaveBeenCalled();
  expect((state.retryError as { message: string }).message).toContain('尚未保存');
});
it('deduplicates repeated clicks and ignores a response after the Run changes', async () => {
  const { state, props, retry } = await mount(initial('RENDER'));
  let resolve!: (value: ProductionTask) => void;
  vi.mocked(productionApi.retry).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = retry();
  await retry();
  expect(productionApi.retry).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(productionApi.retry).mock.calls[0]![2]!;
  const next = initial('RENDER');
  next.tasks = [];
  vi.mocked(productionApi.workspace).mockResolvedValue(next);
  props.workflowRunId = 'next-run';
  await settle();
  expect(signal.aborted).toBe(true);
  resolve(task('RENDER', 'QUEUED'));
  await pending;
  expect((state.workspace as ProductionWorkspace).tasks).toHaveLength(0);
  expect(state.retryingTaskId).toBe('');
});
it('reconciles an uncertain POST by reading the same task, never replaying the POST', async () => {
  const { state, retry } = await mount(initial('RENDER'));
  vi.mocked(productionApi.retry).mockRejectedValue(new TypeError('Failed to fetch'));
  vi.mocked(productionApi.task).mockResolvedValue(task('RENDER', 'RUNNING'));
  await retry();
  expect(productionApi.retry).toHaveBeenCalledTimes(1);
  expect(productionApi.task).toHaveBeenCalledWith('p', 'original', expect.any(AbortSignal));
  expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('RUNNING');
  expect(state.retryError).toBeNull();
  expect(productionApi.start).not.toHaveBeenCalled();
});
it('rejects a mismatched callback and a historical failure superseded by a newer attempt', async () => {
  const { state, retry } = await mount(initial('PROMPT'));
  vi.mocked(productionApi.retry).mockResolvedValue({
    ...task('PROMPT', 'QUEUED'),
    target: { kind: 'CLIP', id: 'clip-b' },
  });
  await retry();
  expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('FAILED');
  expect((state.retryError as { message: string }).message).toContain('范围不匹配');
  vi.mocked(productionApi.retry).mockClear();
  (state.workspace as ProductionWorkspace).tasks.unshift({
    ...task('PROMPT', 'COMPLETED'),
    id: 'new',
  });
  await retry();
  expect(productionApi.retry).not.toHaveBeenCalled();
});
it('uses the existing exact-ID retry endpoint without a new generation body', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: task('RENDER', 'QUEUED') })),
    );
  vi.stubGlobal('fetch', fetch);
  const actual = await vi.importActual<{ productionApi: typeof productionApi }>('./production.api');
  await actual.productionApi.retry('fixture', 'task/one');
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/tasks/task%2Fone/retry'),
    expect.objectContaining({ method: 'POST' }),
  );
  expect(fetch.mock.calls[0]![1].body).toBeUndefined();
});
