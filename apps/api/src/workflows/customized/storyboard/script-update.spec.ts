import { describe, it, expect, vi } from 'vitest';
import { completeScriptUpdate } from './script-update';
import {
  applyCustomizedScriptPatches,
  type CustomizedStoryboardScript,
} from '@ai-marketing/contracts';
import type { Prisma, CustomizedStoryboardTask } from '../../../generated/prisma/client';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
function fixture() {
  const before: CustomizedStoryboardScript = {
    id: 's',
    name: '一杯清晨',
    synopsis: '拿起蓝色杯子阅读',
    structure: 'AI',
    productFocus: '陶瓷杯',
    shots: [],
    story: {
      content: '她拿起蓝色杯子，继续阅读。',
      opening: '清晨',
      development: '拿起杯子',
      ending: '继续阅读',
      dialoguePlan: '没有对白',
      beats: [{ id: 'p', content: '拿起蓝色杯子阅读', durationSeconds: 15 }],
    },
  };
  const patches = [
      { path: 'story/content', before: '蓝色杯子', after: '白色杯子', reason: '新信息卡确认外观' },
    ],
    after = applyCustomizedScriptPatches(before, patches);
  const review = {
    summary: '事实与主线已核对',
    findings: [],
    candidateHash: workflowStateHash(after),
  };
  const steps = [
    { nodeId: 'SNAPSHOT', status: 'SUCCEEDED', output: {} },
    { nodeId: 'STORY', status: 'SUCCEEDED', output: { patches, script: after } },
    { nodeId: 'REVIEW', status: 'SUCCEEDED', output: review },
  ];
  const tx = {
    customizedStoryboardStep: { findMany: vi.fn().mockResolvedValue(steps), updateMany: vi.fn() },
    customizedStoryboardTask: { update: vi.fn() },
  };
  const task = {
    id: 't',
    projectId: 'p',
    workflowRunId: 'r',
    inputSnapshot: { incremental: { version: 1, scriptId: 's', baseline: before } },
  } as unknown as CustomizedStoryboardTask;
  return { tx: tx as unknown as Prisma.TransactionClient, task, before, after, review, steps };
}
describe('script update candidate commit boundary', () => {
  it('completes only a reviewed candidate and does not publish a script artifact', async () => {
    const { tx, task, after } = fixture();
    expect(await completeScriptUpdate(tx, task, after)).toEqual({
      workflowRunId: 'r',
      unchanged: true,
      candidate: true,
    });
    expect(tx.customizedStoryboardStep.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SUCCEEDED', output: { script: after } } }),
    );
  });
  it('rejects review from an earlier candidate', async () => {
    const { tx, task, after, review, before } = fixture();
    review.candidateHash = workflowStateHash(before);
    await expect(completeScriptUpdate(tx, task, after)).rejects.toThrow();
    expect(tx.customizedStoryboardTask.update).not.toHaveBeenCalled();
  });
  it('rejects changed or out-of-scope content even after successful model review', async () => {
    const { tx, task, after } = fixture();
    after.name = '偷偷换掉故事';
    await expect(completeScriptUpdate(tx, task, after)).rejects.toThrow();
    expect(tx.customizedStoryboardTask.update).not.toHaveBeenCalled();
  });
});
