import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it } from 'vitest';
import type { ProductionTask } from '@ai-marketing/contracts';
import Panel from './AssetClarificationPanel.vue';

const base: ProductionTask = {
  id: 'asset-task',
  operation: 'ASSETS',
  shotId: null,
  status: 'FAILED',
  steps: [],
  errorMessage: null,
  progress: 0,
};
const render = (task: ProductionTask, sourceReady = true) =>
  renderToString(createSSRApp(Panel, { task, sourceReady, disabled: false }));

it('offers an explanation for an unresolved asset judgment and shows the real waiting state', async () => {
  const blocked = await render({ ...base, assetReviewQuestions: ['请确认产品颜色'] });
  expect(blocked).toContain('请确认产品颜色');
  expect(blocked).toContain('补充说明并重新判断');
  expect(blocked).not.toContain('继续本次更新');
  const running = await render({
    ...base,
    status: 'RUNNING',
    assetClarification: { state: 'PENDING', explanation: '杯身是黑色' },
  });
  expect(running).toContain('正在重新判断');
  expect(running).not.toContain('确认并保存到信息卡');
});

it('distinguishes fact confirmation from applying a production requirement', async () => {
  const ready = {
    ...base,
    status: 'COMPLETED' as const,
    assetClarification: {
      state: 'PENDING' as const,
      explanation: '杯身是黑色；本次不展示容量',
      proposal: {
        changes: [{ label: '产品外观', before: '燕麦白', after: '黑色' }],
        productionNote: '本次不展示容量',
        questions: [],
      },
    },
  };
  const fact = await render(ready);
  expect(fact).toContain('燕麦白');
  expect(fact).toContain('黑色');
  expect(fact).toContain('确认并保存到信息卡');
  expect(fact).not.toContain('采用要求并更新资产');
  const proposal = { ...ready.assetClarification.proposal, changes: [] };
  const note = await render({
    ...ready,
    assetClarification: { ...ready.assetClarification, proposal },
  });
  expect(note).toContain('采用要求并更新资产');
  expect(note).not.toContain('确认并保存到信息卡');
  const unresolved = await render({
    ...ready,
    assetClarification: {
      ...ready.assetClarification,
      proposal: { ...proposal, questions: ['请确认现有参数是否沿用'] },
    },
  });
  expect(unresolved).toContain('继续补充说明');
  expect(unresolved).not.toContain('采用要求并更新资产');
  const saved = await render(
    {
      ...ready,
      assetClarification: { ...ready.assetClarification, state: 'ADOPTED' },
    },
    false,
  );
  expect(saved).toContain('去更新脚本');
  expect(saved).not.toContain('确认并保存到信息卡');
});
