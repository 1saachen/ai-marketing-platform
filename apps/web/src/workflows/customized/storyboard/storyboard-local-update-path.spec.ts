import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { emptyCustomizedBrief, type StoryboardWorkspace } from '@ai-marketing/contracts';
import Workspace from './CustomizedStoryboardWorkspace.vue';
import { storyboardApi } from './storyboard.api';
import { createStoryboardScript, emptyStoryboardDraft } from './storyboard-state';

const capture = vi.hoisted(() => ({
  run: '',
  script: '',
  affected: [] as { id: string; name: string }[],
}));
vi.mock('./ScriptLocalUpdate.vue', () => ({
  default: {
    props: ['workflowRunId', 'scriptId', 'affectedScripts'],
    setup(props: {
      workflowRunId: string;
      scriptId: string;
      affectedScripts: { id: string; name: string }[];
    }) {
      capture.run = props.workflowRunId;
      capture.script = props.scriptId;
      capture.affected = props.affectedScripts;
      return () => null;
    },
  },
}));
vi.mock('./CustomizedStoryboardNodePage.vue', () => ({ default: { render: () => null } }));
vi.mock('./storyboard.api', () => ({
  storyboardApi: { workspace: vi.fn(), settings: vi.fn(), edit: vi.fn() },
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
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.resetAllMocks();
});
it('previews a saved information-card change on the current path while viewing its inherited script', async () => {
  const script = { ...createStoryboardScript('已有白色杯子故事'), id: 'script' };
  const data: StoryboardWorkspace = {
    sourceRunId: 'edited-brief-path',
    source: { artifactId: 'new-brief', revision: 2, fingerprint: 'new-brief-hash' },
    brief: { ...emptyCustomizedBrief(), productAppearance: '黑色杯子' },
    sourceReady: true,
    settings: emptyStoryboardDraft().settings,
    settingsRevision: 1,
    selectedScriptId: script.id,
    task: null,
    legacyDraft: null,
    scripts: [
      {
        id: script.id,
        workflowRunId: 'original-script-path',
        source: { artifactId: 'old-brief', revision: 1, fingerprint: 'old-brief-hash' },
        status: 'COMPLETED',
        origin: 'AI',
        revision: 1,
        confirmedRevision: 1,
        editing: false,
        stale: true,
        taskId: null,
        script,
      },
    ],
  };
  data.scripts.push(
    {
      ...data.scripts[0]!,
      id: 'other',
      script: { ...script, id: 'other', name: '另一个受影响方案' },
    },
    {
      ...data.scripts[0]!,
      id: 'current',
      stale: false,
      script: { ...script, id: 'current', name: '已更新方案' },
    },
  );
  data.task = {
    id: 'local-task',
    workflowRunId: 'edited-brief-path',
    status: 'FAILED',
    progress: 5,
    steps: [],
    errorMessage: '旧局部更新失败',
    createdAt: '',
    updatedAt: '',
    incremental: { version: 1, scriptId: script.id },
  };
  vi.mocked(storyboardApi.workspace).mockResolvedValue(data);
  const props = {
    projectId: 'project',
    workflowRunId: 'edited-brief-path',
    viewedRunId: 'original-script-path',
    briefConfirmed: true,
    scopeReadonly: false,
    activateScript: vi.fn().mockResolvedValue(true),
  };
  let state: Record<string, unknown> = {};
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
  cleanup.push(() => app.unmount());
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
    await nextTick();
  }
  await renderToString(createSSRApp({ ...Workspace, setup: () => state }, props));
  expect(capture).toEqual({
    run: 'edited-brief-path',
    script: 'script',
    affected: [
      { id: script.id, name: script.name },
      { id: 'other', name: '另一个受影响方案' },
    ],
  });
  expect(state.graphTask).toBeNull();
  expect(storyboardApi.edit).not.toHaveBeenCalled();
});
