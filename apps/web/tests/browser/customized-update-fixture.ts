/** Explicit isolated browser fixture. Every business request stays in this fixture; no AI or API writes. */
import { createApp, h, ref } from 'vue';
import LocalUpdate from '../../src/workflows/customized/shared/CustomizedLocalUpdate.vue';
import ScriptUpdate from '../../src/workflows/customized/storyboard/ScriptLocalUpdate.vue';
import Composer from '../../src/workflows/customized/production/ProductionImageComposer.vue';
import AssetUpdateScope from '../../src/workflows/customized/production/AssetUpdateScope.vue';
import type {
  ProductionAsset,
  CustomizedScriptUpdateCandidate,
  StoryboardTask,
} from '@ai-marketing/contracts';
import '../../src/styles/global.css';
const project = 'browser-local-update-fixture',
  run = 'fixture-run';
const original = window.fetch.bind(window),
  image =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#f8fafc"/><rect x="220" y="100" width="160" height="200" rx="24" fill="white" stroke="#94a3b8" stroke-width="8"/><path d="M380 140h40v110h-40" fill="none" stroke="#94a3b8" stroke-width="8"/></svg>',
    );
let state: 'ready' | 'empty' | 'error' | 'blocked' | 'loading' = 'ready';
const storageKey = 'customized-local-update-browser-fixture';
type ScriptPhase = 'queued' | 'drafting' | 'reviewing' | 'done' | 'failed';
let scriptPhase = (sessionStorage.getItem(storageKey + '-phase') ?? 'done') as ScriptPhase;
const fixtureStartedAt = new Date(Date.now() - 75000).toISOString();
let scriptCandidate: CustomizedScriptUpdateCandidate | null = JSON.parse(
  sessionStorage.getItem(storageKey) ?? 'null',
) as CustomizedScriptUpdateCandidate | null;
function fixtureTask(): StoryboardTask {
  const current = { queued: 0, drafting: 1, reviewing: 2, done: 4, failed: 2 }[scriptPhase];
  return {
    id: 'task',
    workflowRunId: run,
    status: scriptCandidate?.status as StoryboardTask['status'],
    progress: current * 25,
    incremental: { version: 1, scriptId: 'script' },
    createdAt: fixtureStartedAt,
    updatedAt: new Date().toISOString(),
    errorMessage: scriptCandidate?.errorMessage ?? null,
    steps: (['SNAPSHOT', 'STORY', 'REVIEW', 'SAVE'] as const).map((nodeId, index) => ({
      nodeId,
      scriptId: nodeId === 'SNAPSHOT' ? '' : 'script',
      status:
        index < current
          ? 'SUCCEEDED'
          : index === current && scriptPhase !== 'queued'
            ? scriptPhase === 'failed'
              ? 'FAILED'
              : 'RUNNING'
            : 'PENDING',
      errorMessage: null,
      updatedAt: fixtureStartedAt,
    })),
  };
}
function setPhase(phase: ScriptPhase) {
  scriptPhase = phase;
  if (scriptCandidate) {
    scriptCandidate.status =
      phase === 'done'
        ? 'COMPLETED'
        : phase === 'queued'
          ? 'QUEUED'
          : phase === 'failed'
            ? 'FAILED'
            : 'RUNNING';
    scriptCandidate.applied = false;
    scriptCandidate.errorMessage = phase === 'failed' ? '候选未通过审校，原脚本保持不变' : null;
    scriptCandidate.reviewStatus =
      phase === 'failed' ? 'NEEDS_CHANGES' : phase === 'done' ? 'PASSED' : 'PENDING';
    scriptCandidate.reviewFindings =
      phase === 'failed'
        ? [
            {
              severity: 'ERROR',
              message: '故事结构说明仍保留燕麦白，与黑色款设定冲突',
              evidence: '当前产品外观为黑色，正文已改为黑色',
              suggestion: '把故事结构说明中的旧配色同步为黑色',
            },
          ]
        : [];
  }
  sessionStorage.setItem(storageKey + '-phase', phase);
  sessionStorage.setItem(storageKey, JSON.stringify(scriptCandidate));
}
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes(`/projects/${project}/`)) return original(input, init);
  const data = (value: unknown, status = 200) =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: value, message: status === 200 ? 'ok' : '受控查询失败' }),
        { status, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  if (url.includes('update-preview')) {
    await new Promise((resolve) => setTimeout(resolve, state === 'loading' ? 1500 : 180));
    if (state === 'error') return data(null, 400);
    const node = new URL(url, location.origin).searchParams.get('node');
    return data({
      version: 1,
      workflowRunId: run,
      node,
      targetId: null,
      fingerprint: 'fixture',
      items:
        state === 'empty'
          ? []
          : [
              {
                id: node === 'SCRIPT' ? 'script' : 'clip-a',
                name:
                  node === 'SCRIPT' ? '雨夜的一杯' : node === 'ASSETS' ? '杯子' : '产品展示镜头',
                action: 'UPDATE',
                reason: '产品外观已更新，需核对实际引用',
              },
            ],
      blockers: state === 'blocked' ? ['请先保存或取消当前编辑'] : [],
      calls: ['TEXT'],
      scope: 'DEPENDENCIES',
    });
  }
  if (url.endsWith('/image-references'))
    return data({ id: 'uploaded-image', name: '上传图片', currentVersion: 1 });
  if (url.includes('/assets/')) return data({ contentUrl: image, currentVersion: 1 });
  if (url.endsWith('/tasks/task')) return state === 'error' ? data(null, 400) : data(fixtureTask());
  if (url.endsWith('/script-updates')) {
    const before = {
      id: 'script',
      name: '雨夜的一杯',
      synopsis: '拿起杯子继续阅读。',
      structure: '把燕麦白杯子放到桌边',
      productFocus: '陶瓷杯',
      shots: [],
      story: {
        content: '她拿起蓝色陶瓷杯。窗外下雨，继续阅读。',
        opening: '雨夜',
        development: '拿杯阅读',
        ending: '阅读',
        dialoguePlan: '无对白',
        beats: [{ id: 'p1', content: '拿杯', durationSeconds: 15 }],
      },
    };
    scriptCandidate = {
      taskId: 'task',
      status: 'COMPLETED',
      errorMessage: null,
      before,
      after: {
        ...structuredClone(before),
        story: { ...before.story, content: '她拿起白色陶瓷杯。窗外下雨，继续阅读。' },
      },
      applied: false,
      baselineRevision: 1,
    };
    setPhase(scriptPhase);
    sessionStorage.setItem(storageKey, JSON.stringify(scriptCandidate));
    return data({ id: 'task', status: 'COMPLETED' });
  }
  if (url.endsWith('/save')) {
    if (scriptCandidate) {
      scriptCandidate.applied = true;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        script?: typeof scriptCandidate.after;
      };
      if (body.script) scriptCandidate.after = body.script;
      sessionStorage.setItem(storageKey, JSON.stringify(scriptCandidate));
    }
    return data({ workflowRunId: run, unchanged: false });
  }
  if (url.includes('/script-updates/')) return data(scriptCandidate);
  return data(null);
};
createApp({
  setup() {
    const asset = ref<ProductionAsset>({
        id: 'object',
        kind: 'PRODUCT',
        name: '陶瓷杯',
        description: '白色陶瓷杯',
        knownFacts: '陶瓷',
        designNotes: '',
        sourceText: '隔离测试',
        image: { assetId: 'original-image', version: 1 },
      }),
      saved = ref('未保存'),
      draft = ref(false),
      event = ref('尚未启动任务');
    const scriptVersion = ref(0);
    return () =>
      h('main', { style: 'max-width:1100px;margin:24px auto;padding:20px' }, [
        h('h1', '定制类局部更新 · 隔离测试'),
        h('p', '真实组件与受控响应；本页不调用模型、不写业务数据。'),
        h(
          'nav',
          ['ready', 'empty', 'error', 'blocked', 'loading'].map((value) =>
            h(
              'button',
              {
                onClick: () => {
                  state = value as typeof state;
                  event.value = `状态：${value}`;
                },
              },
              value,
            ),
          ),
        ),
        h(LocalUpdate, {
          projectId: project,
          workflowRunId: run,
          nodes: ['SHOTS', 'PROMPT', 'RENDER'],
          onExecute: () => (event.value = '已确认更新范围'),
        }),
        h('p', event.value),
        h('h2', '资产局部更新测试'),
        h(LocalUpdate, {
          projectId: project,
          workflowRunId: run,
          nodes: ['ASSETS'],
          onExecute: () => (event.value = '受控资产判断已完成'),
        }),
        h(AssetUpdateScope, {
          scope: [
            { name: '杯子', action: 'UPDATE', reason: '产品配色改为黑色' },
            { name: '人物', action: 'KEEP', reason: '人物形象与归属未变' },
            { name: '会议室', action: 'KEEP', reason: '空间与陈设未变' },
          ],
        }),
        h(
          'nav',
          { 'aria-label': '脚本状态测试' },
          (['queued', 'drafting', 'reviewing', 'done', 'failed', 'auto-complete'] as const).map(
            (value) =>
              h(
                'button',
                {
                  onClick: async () => {
                    if (!scriptCandidate)
                      await window.fetch(`/projects/${project}/script-updates`, { method: 'POST' });
                    setPhase(value === 'auto-complete' ? 'reviewing' : value);
                    scriptVersion.value++;
                    if (value === 'auto-complete') setTimeout(() => setPhase('done'), 6000);
                  },
                },
                (
                  {
                    queued: '排队中',
                    drafting: '改稿中',
                    reviewing: '审校中',
                    done: '审校完成',
                    failed: '审校失败',
                    'auto-complete': '6秒后自动完成审校',
                  } as const
                )[value],
              ),
          ),
        ),
        h(ScriptUpdate, {
          key: scriptVersion.value,
          projectId: project,
          workflowRunId: run,
          scriptId: 'script',
          affectedScripts: [
            { id: 'script', name: '雨夜的一杯' },
            { id: 'scheme-b', name: '这一刻，轮到你' },
            { id: 'scheme-c', name: '杯子没有意见：一个很长的方案名称用于核对窄屏显示和自动换行' },
          ],
          onSaved: () => (saved.value = '脚本已保存'),
        }),
        h(Composer, {
          asset: asset.value,
          projectId: project,
          workflowRunId: run,
          onReplace: (value: { assetId: string; version: number }) => {
            asset.value = { ...asset.value, image: value };
            draft.value = true;
            saved.value = '图片替换草稿';
          },
          onGenerate: () => (event.value = '生成按钮仅记录测试事件'),
        }),
        h('div', [
          h(
            'button',
            {
              disabled: !draft.value,
              onClick: () => {
                saved.value = '图片已保存';
                draft.value = false;
              },
            },
            '保存修改',
          ),
          h(
            'button',
            {
              disabled: !draft.value,
              onClick: () => {
                asset.value = { ...asset.value, image: { assetId: 'original-image', version: 1 } };
                draft.value = false;
                saved.value = '已取消，原图保留';
              },
            },
            '取消编辑',
          ),
        ]),
        h('p', { role: 'status' }, saved.value),
      ]);
  },
}).mount('#app');
