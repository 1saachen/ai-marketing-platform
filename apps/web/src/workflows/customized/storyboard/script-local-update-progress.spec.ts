import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, ssrContextKey, type Slots } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { CustomizedScriptUpdateCandidate, StoryboardTask } from '@ai-marketing/contracts';
import Workspace from './ScriptLocalUpdate.vue';
import { storyboardApi } from './storyboard.api';
import { createStoryboardScript } from './storyboard-state';
vi.mock('./storyboard.api', () => ({
  storyboardApi: {
    updateCandidate: vi.fn(),
    task: vi.fn(),
    updateScript: vi.fn(),
    saveUpdate: vi.fn(),
    retry: vi.fn(),
  },
}));
vi.mock('../shared/CustomizedLocalUpdate.vue', () => ({ default: { render: () => null } }));
vi.mock('../../../platform/workflow/components/WorkflowInformationDialog.vue', () => ({
  default: {
    setup(_props: unknown, { slots }: { slots: Slots }) {
      return () => h('section', slots.default?.());
    },
  },
}));
type Host = { children: Host[]; parent: Host | null };
const node = (): Host => ({ children: [], parent: null });
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  },
  parentNode: (child) => child.parent,
  nextSibling: () => null,
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.resetAllMocks();
});
async function flush() {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function data() {
  const script = { ...createStoryboardScript('雨夜的一杯'), id: 's' };
  const candidate: CustomizedScriptUpdateCandidate = {
    taskId: 'task',
    status: 'RUNNING',
    before: script,
    after: script,
    errorMessage: null,
    applied: false,
    baselineRevision: 1,
  };
  const task: StoryboardTask = {
    id: 'task',
    workflowRunId: 'run',
    status: 'RUNNING',
    incremental: { version: 1, scriptId: 's' },
    progress: 45,
    createdAt: new Date(Date.now() - 75000).toISOString(),
    updatedAt: new Date().toISOString(),
    errorMessage: null,
    steps: [
      {
        nodeId: 'REVIEW',
        scriptId: 's',
        status: 'RUNNING',
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  return { candidate, task };
}
async function mount() {
  let state: Record<string, unknown> = {};
  const props = { projectId: 'project', workflowRunId: 'run', scriptId: 's' };
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    props,
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanups.push(() => app.unmount());
  await flush();
  return {
    state,
    app,
    html: () => renderToString(createSSRApp({ ...Workspace, setup: () => state }, props)),
  };
}
it('restores ongoing review, explains disabled save, then unlocks without losing manual draft or auto-saving', async () => {
  vi.useFakeTimers();
  const value = data();
  vi.mocked(storyboardApi.updateCandidate).mockImplementation(async () =>
    structuredClone(value.candidate),
  );
  vi.mocked(storyboardApi.task).mockImplementation(async () => structuredClone(value.task));
  const { state, html } = await mount();
  (state.show as () => void)();
  await flush();
  let output = await html();
  expect(output).toContain('正在审校更新稿');
  expect(output).toContain('审校中，完成后可保存');
  expect(output).toContain('关闭，后台继续');
  const button = (source: string, label: string) =>
    [...source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(
      (m) => m[2]!.replace(/<!--[\s\S]*?-->/g, '').trim() === label,
    );
  expect(button(output, '审校中，完成后可保存')?.[1]).toContain('disabled');
  await (state.save as () => Promise<void>)();
  expect(storyboardApi.saveUpdate).not.toHaveBeenCalled();
  const draft = state.draft as typeof value.candidate.before;
  draft.synopsis = '人工补充内容';
  state.open = false;
  (state.show as () => void)();
  expect((state.draft as typeof draft).synopsis).toBe('人工补充内容');
  value.candidate.status = 'COMPLETED';
  value.task.status = 'COMPLETED';
  value.task.steps[0]!.status = 'SUCCEEDED';
  await vi.advanceTimersByTimeAsync(1800);
  await flush();
  output = await html();
  expect(output).toContain('审校已完成，可以保存修改');
  expect(output).not.toContain('审校中，完成后可保存');
  expect(button(output, '保存修改')).toBeDefined();
  expect(button(output, '保存修改')?.[1]).not.toContain('disabled');
  expect((state.draft as typeof draft).synopsis).toBe('人工补充内容');
  expect(storyboardApi.saveUpdate).not.toHaveBeenCalled();
  expect(storyboardApi.updateScript).not.toHaveBeenCalled();
});
it('keeps polling in the background, exposes sync failures and releases both timers on unmount', async () => {
  vi.useFakeTimers();
  const value = data();
  vi.mocked(storyboardApi.updateCandidate).mockResolvedValue(value.candidate);
  vi.mocked(storyboardApi.task)
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValue(value.task);
  const { state, html, app } = await mount();
  expect(await html()).toContain('进度暂未同步');
  (state.show as () => void)();
  state.open = false;
  await vi.advanceTimersByTimeAsync(5000);
  await flush();
  expect(state.syncError).toBe(false);
  expect(state.task).toMatchObject({ id: 'task' });
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  app.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it('ignores an older task response after a newer refresh has completed', async () => {
  vi.useFakeTimers();
  const value = data();
  vi.mocked(storyboardApi.updateCandidate).mockResolvedValue(value.candidate);
  let resolveOld!: (value: StoryboardTask) => void;
  const old = new Promise<StoryboardTask>((resolve) => {
    resolveOld = resolve;
  });
  vi.mocked(storyboardApi.task)
    .mockReturnValueOnce(old)
    .mockResolvedValue({ ...value.task, progress: 85 });
  const { state } = await mount();
  await (state.refresh as () => Promise<void>)();
  expect((state.task as StoryboardTask).progress).toBe(85);
  resolveOld({ ...value.task, progress: 5 });
  await flush();
  expect((state.task as StoryboardTask).progress).toBe(85);
});

it('explains failed review in ordinary language and opens a scoped repair preview instead of replaying it', async () => {
  vi.useFakeTimers();
  const value = data();
  value.candidate.status = 'FAILED';
  value.candidate.reviewStatus = 'NEEDS_CHANGES';
  value.candidate.reviewFindings = [
    {
      severity: 'ERROR',
      message: '故事结构说明还保留旧配色',
      evidence: '当前产品外观为黑色',
      suggestion: '同步修改为黑色',
    },
  ];
  value.candidate.after!.story!.structure = '原有故事结构说明';
  value.task.status = 'FAILED';
  value.task.steps[0]!.status = 'SUCCEEDED';
  vi.mocked(storyboardApi.updateCandidate).mockResolvedValue(value.candidate);
  vi.mocked(storyboardApi.task).mockResolvedValue(value.task);
  const { state, html } = await mount();
  (state.show as () => void)();
  await flush();
  const output = await html();
  expect(output).toContain('按审核意见修正');
  expect(output).toContain('下一步');
  expect(output).toContain('故事结构说明');
  expect(output).toContain('建议：同步修改为黑色');
  expect(output).not.toContain('story.structure');
  const preview = vi.fn();
  state.localUpdate = { show: preview };
  await (state.retry as () => Promise<void>)();
  expect(preview).toHaveBeenCalledOnce();
  expect(state.open).toBe(false);
  expect(storyboardApi.retry).not.toHaveBeenCalled();
  expect(storyboardApi.updateScript).not.toHaveBeenCalled();
  expect(storyboardApi.saveUpdate).not.toHaveBeenCalled();
});
