/** Only fixture responses; no server writes or model requests. */
import { createApp, h } from 'vue';
import type { ProductionTask, ProductionWorkspace } from '@ai-marketing/contracts';
import Workspace from '../../src/workflows/customized/production/CustomizedProductionWorkspace.vue';
import '../../src/styles/global.css';

const projectId = 'controlled-clarification';
const workflowRunId = 'path-a';
const mode = new URLSearchParams(location.search).get('case') ?? 'facts';
const key = `asset-clarification-fixture:${mode}`;
const prior: ProductionTask = {
  id: 'previous',
  operation: 'ASSETS',
  shotId: null,
  status: 'FAILED',
  errorMessage: null,
  progress: 10,
  steps: [],
  incremental: { version: 1, targetIds: ['cup'], batchKey: 'previous' },
  assetReviewQuestions: ['产品外观与产品规格里的杯身颜色不一致，请确认本次配色。'],
};
let task = JSON.parse(sessionStorage.getItem(key) ?? 'null') as ProductionTask | null;
function save(value: ProductionTask) {
  task = value;
  sessionStorage.setItem(key, JSON.stringify(task));
  return task;
}
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({ data, message: status === 200 ? 'ok' : '当前说明暂未提交，请重试' }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
const document = { assets: [], shots: [] };
const upstream = {
  id: 'script',
  name: '候车时的一杯咖啡',
  synopsis: '候车时拿起随行杯',
  structure: '拿杯、阅读',
  productFocus: '随行杯',
  shots: [],
};
const fetchOriginal = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (!url.pathname.includes(`/projects/${projectId}/workflows/customized/production`))
    return fetchOriginal(input, init);
  const path = url.pathname;
  const completed = (value: ProductionTask) =>
    save({
      ...value,
      status: 'COMPLETED',
      progress: 100,
      assetClarification: {
        ...value.assetClarification!,
        proposal: {
          changes:
            mode === 'note' ? [] : [{ label: '产品外观', before: '燕麦白杯身', after: '黑色杯身' }],
          productionNote: '本次画面和口播不展示容量',
          questions: mode === 'questions' ? ['请确认杯身颜色。'] : [],
        },
      },
    });
  if (path.endsWith('/clarification')) {
    if (mode === 'error') return response(null, 409);
    const body = JSON.parse(String(init?.body));
    return response(
      save({
        id: 'judgment',
        operation: 'ASSETS',
        shotId: null,
        status: 'QUEUED',
        steps: [],
        progress: 0,
        errorMessage: null,
        assetClarification: { state: 'PENDING', explanation: body.explanation },
      }),
    );
  }
  if (path.endsWith('/tasks/judgment') && task) {
    if (task.status === 'QUEUED') return response(save({ ...task, status: 'RUNNING' }));
    if (task.status === 'RUNNING') return response(completed(task));
    return response(task);
  }
  if (path.endsWith('/clarification-decision') && task) {
    const adopt = JSON.parse(String(init?.body)).adopt;
    if (adopt && mode === 'note')
      return response(
        save({ ...prior, id: 'resumed', status: 'COMPLETED', assetReviewQuestions: [] }),
      );
    return response(
      save({
        ...task,
        assetClarification: { ...task.assetClarification!, state: adopt ? 'ADOPTED' : 'DISMISSED' },
      }),
    );
  }
  if (path.endsWith('/production'))
    return response({
      document,
      confirmedDocument: document,
      script: upstream,
      source: { artifactId: 'source', revision: 1, fingerprint: 'test' },
      sourceReady: task?.assetClarification?.state !== 'ADOPTED',
      draftRevision: 0,
      assetsConfirmed: false,
      shotsConfirmed: false,
      prompts: [],
      videos: [],
      tasks: task ? [task, prior] : [prior],
    } satisfies ProductionWorkspace);
  if (path.endsWith('/update-preview'))
    return response({ items: [], blockers: [], calls: [], fingerprint: 'test' });
  throw Error('Unexpected fixture route');
};

createApp({
  render: () =>
    h(Workspace, {
      projectId,
      workflowRunId,
      mode: 'ASSETS',
      onBack: () => {
        window.document.body.dataset.scriptNavigation = 'true';
      },
    }),
}).mount('#app');
