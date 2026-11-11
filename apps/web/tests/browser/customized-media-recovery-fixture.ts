/** Isolated UI fixture. Synthetic business requests are handled here without model calls or writes. */
import { createApp, h, ref } from 'vue';
import type {
  ProductionTask,
  ProductionVideoDocument,
  ProductionWorkspace,
} from '@ai-marketing/contracts';
import fixture from '../../../../packages/contracts/fixtures/customized-video-plan-v2.json';
import Workspace from '../../src/workflows/customized/production/CustomizedProductionWorkspace.vue';
import '../../src/styles/global.css';

const project = 'browser-media-recovery-fixture',
  run = 'fixture-run';
const document = structuredClone(fixture.document) as ProductionVideoDocument;
document.assets[0]!.image = { assetId: 'cup-image', version: 2 };
document.assets[1]!.image = { assetId: 'room-image', version: 1 };
document.assets.push({
  id: 'lamp',
  kind: 'PROP',
  name: '台灯',
  description: '桌边台灯',
  knownFacts: '',
  designNotes: '',
  sourceText: '',
  preparation: {
    aliases: [],
    usage: '',
    treatment: 'SCENE_DETAIL',
    parentId: 'room',
    sources: [],
    details: [],
    questions: [],
    images: [],
  },
});
const originalTasks: ProductionTask[] = document.videoPlan.clips.map((clip, n) => ({
  id: `failed-${clip.id}`,
  operation: 'RENDER',
  status: 'FAILED',
  progress: 25,
  shotId: null,
  target: { kind: 'CLIP', id: clip.id },
  steps: [],
  errorMessage: '参考图未通过供应商审核，请核对本镜实际使用的图片。',
  renderInputRejected: true,
  incremental: { version: 1, batchKey: 'batch', targetIds: ['clip-a', 'clip-b'] },
  renderReferences: [
    { objectId: 'cup', name: '陶瓷杯', assetId: 'cup-image', version: 1 },
    {
      objectId: 'lamp',
      name: '台灯',
      sourceObjectId: 'room',
      sourceName: '阅读室',
      assetId: 'room-image',
      version: 1,
    },
    ...(n ? [{ objectId: 'room', name: '阅读室', assetId: 'room-image', version: 1 }] : []),
  ],
}));
const storageKey = 'customized-media-recovery-fixture-results';
const recovered = new Set<string>(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]'));
let pending: { task: ProductionTask; started: number } | null = null;
const params = new URLSearchParams(location.search),
  state = params.get('state');
const calls = ref<string[]>([]);
const record = (value: string) => {
  calls.value = [...calls.value.slice(-4), value];
};
function tasks() {
  if (pending && Date.now() - pending.started >= 2800) {
    recovered.add(pending.task.target!.id);
    sessionStorage.setItem(storageKey, JSON.stringify([...recovered]));
    pending = null;
  }
  return [
    ...(pending ? [pending.task] : []),
    ...[...recovered].map((id): ProductionTask => ({
      id: `saved-${id}`,
      operation: 'RENDER',
      status: 'COMPLETED',
      progress: 100,
      target: { kind: 'CLIP', id },
      shotId: null,
      steps: [],
      errorMessage: null,
    })),
    ...originalTasks,
  ];
}
function workspace(): ProductionWorkspace {
  const current = tasks();
  return {
    document,
    confirmedDocument: document,
    script: {
      id: 'script',
      name: '一杯清晨',
      synopsis: '',
      structure: '',
      productFocus: '',
      shots: [],
    },
    source: { artifactId: 'script', revision: 1, fingerprint: 'fixture' },
    sourceReady: true,
    draftRevision: 1,
    assetsConfirmed: true,
    shotsConfirmed: true,
    prompts: document.videoPlan.clips.map((clip) => ({
      value: {
        target: { kind: 'CLIP', id: clip.id },
        content: '@陶瓷杯 静置在桌面，侧光展示杯身。',
        assetIds: ['cup'],
      },
      revision: 1,
      stale: false,
    })),
    tasks: state === 'empty' ? [] : current,
    ...(state === 'empty'
      ? {}
      : {
          localMediaBatch: {
            key: 'batch',
            operation: 'RENDER',
            items: originalTasks.map((original) => {
              const task = current.find((t) => t.target?.id === original.target!.id)!;
              return {
                originalTaskId: original.id,
                taskId: task.id,
                targetId: original.target!.id,
                status: task.status,
              };
            }),
          },
        }),
  };
}
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (!url.pathname.includes('/api/projects/')) return originalFetch(input, init);
  if (!url.pathname.includes(`/projects/${project}/`))
    throw new Error('Fixture request escaped its project');
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: status === 200, data, message: '受控查询暂不可用' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  if (url.pathname.includes('/assets/')) {
    record(`查看固定图片 ${url.pathname.split('/assets/')[1]}`);
    if (state === 'image-loading') await new Promise((resolve) => setTimeout(resolve, 4000));
    if (state === 'image-error') return response(null, 400);
    return response({ contentUrl: '/tests/browser/customized-upload.png' });
  }
  if (url.pathname.endsWith('/tasks') && init?.method === 'POST') {
    const request = JSON.parse(String(init.body));
    if (request.operation !== 'RENDER') return response(null, 400);
    record(`重新生成 ${request.target.id}`);
    const task: ProductionTask = {
      id: `saved-${request.target.id}`,
      operation: 'RENDER',
      status: 'RUNNING',
      progress: 40,
      target: request.target,
      steps: [],
      shotId: null,
      errorMessage: null,
    };
    pending = { task, started: Date.now() };
    return response(task);
  }
  if (url.pathname.includes('/tasks/')) {
    const id = url.pathname.split('/tasks/')[1];
    return response(tasks().find((t) => t.id === id));
  }
  if (url.pathname.endsWith('/production')) {
    if (state === 'loading') await new Promise((resolve) => setTimeout(resolve, 4500));
    if (state === 'error') return response(null, 400);
    return response(workspace());
  }
  throw new Error('Unhandled fixture request');
};
createApp({
  setup() {
    const mode = ref<'SHOTS' | 'ASSETS'>('SHOTS'),
      focus = ref<string | null>(null);
    return () =>
      h('main', { style: 'padding:24px;background:#f7f8fa;min-height:100vh;' }, [
        h(
          'nav',
          { style: 'display:flex;gap:16px;align-items:center;margin-bottom:20px;flex-wrap:wrap;' },
          [
            h('strong', '视频失败恢复隔离回归'),
            h(
              'button',
              {
                onClick: () => {
                  sessionStorage.removeItem(storageKey);
                  location.reload();
                },
              },
              '重置失败批次',
            ),
            h(
              'button',
              {
                onClick: () => {
                  mode.value = 'SHOTS';
                },
              },
              '返回视频制作',
            ),
            h('output', calls.value.join(' · ')),
          ],
        ),
        h(Workspace, {
          projectId: project,
          workflowRunId: run,
          mode: mode.value,
          focusAssetId: focus.value,
          onPrepareAsset: (id: string) => {
            record(`已定位资产 ${id}`);
            focus.value = id;
            mode.value = 'ASSETS';
          },
          onAssetFocusHandled: () => {
            focus.value = null;
          },
        }),
      ]);
  },
}).mount('#app');
