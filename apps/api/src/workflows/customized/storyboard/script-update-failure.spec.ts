import { describe, expect, it, vi } from 'vitest';
import { scriptUpdateFailureMessage, storyboardTaskError } from './script-update-failure';
import { scriptUpdateCandidate } from './script-update';
import type { PrismaService } from '../../../database/prisma.service';

const oldMessage = '部分脚本未完成，已成功的脚本保留，可重试未完成部分';
const snapshot = { nodeId: 'SNAPSHOT', status: 'SUCCEEDED', output: {} };
const story = { nodeId: 'STORY', status: 'SUCCEEDED', output: {} };
const review = { nodeId: 'REVIEW', status: 'SUCCEEDED', output: { findings: [] } };
describe('single-script update failure feedback', () => {
  it('uses the persisted patch failure reason instead of hiding it behind a phase summary', () => {
    const detail = '第 2 项脚本修改引用的原文出现多次，无法唯一定位，未修改原脚本。';
    expect(
      scriptUpdateFailureMessage([snapshot, { ...story, status: 'FAILED', errorMessage: detail }]),
    ).toBe(detail);
    expect(
      scriptUpdateFailureMessage([snapshot, { ...story, status: 'RUNNING', errorMessage: detail }]),
    ).not.toBe(detail);
  });
  it.each([
    [[], '读取更新依据'],
    [[snapshot, { ...story, status: 'RUNNING' }], '定向改稿'],
    [[snapshot, story], '候选审校'],
    [[snapshot, story, review], '候选保存'],
  ])('identifies unfinished checkpoints without claiming any script was lost', (steps, stage) => {
    const message = scriptUpdateFailureMessage(steps);
    expect(message).toContain(stage);
    expect(message).toContain('原脚本保持不变');
    expect(message).not.toContain('部分脚本');
  });
  it('distinguishes a rejected candidate from a transport failure without inventing a cause', () => {
    expect(
      scriptUpdateFailureMessage([
        snapshot,
        story,
        {
          ...review,
          output: { findings: [{ severity: 'ERROR' }] },
        },
      ]),
    ).toContain('候选未通过审校');
    expect(
      scriptUpdateFailureMessage([
        snapshot,
        story,
        {
          ...review,
          output: { findings: [{ severity: 'WARNING' }] },
        },
      ]),
    ).toContain('候选保存');
  });
  it('normalizes only the old incremental generic message and preserves specific and batch errors', () => {
    const task = {
      inputSnapshot: { incremental: { version: 1 } },
      errorMessage: oldMessage,
      steps: [snapshot],
    };
    expect(storyboardTaskError(task)).toContain('定向改稿');
    expect(task.errorMessage).toBe(oldMessage);
    expect(storyboardTaskError({ ...task, inputSnapshot: {} })).toBe(oldMessage);
    expect(storyboardTaskError({ ...task, errorMessage: '信息卡来源已经变化' })).toBe(
      '信息卡来源已经变化',
    );
    expect(storyboardTaskError({ ...task, errorMessage: null })).toBeNull();
  });
  it('returns corrected feedback for existing candidates without changing persisted task data', async () => {
    const task = {
      id: 'task',
      status: 'FAILED',
      errorMessage: oldMessage,
      inputSnapshot: { incremental: { baseline: { name: '原脚本' }, baselineRevision: 2 } },
      steps: [snapshot, { ...story, status: 'RUNNING' }],
    };
    const db = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run' }) },
      customizedStoryboardTask: { findFirst: vi.fn().mockResolvedValue(task) },
    };
    const result = await scriptUpdateCandidate(
      db as unknown as PrismaService,
      'project',
      'run',
      'script',
    );
    expect(result?.errorMessage).toContain('定向改稿');
    expect(result?.after).toBeNull();
    expect(result?.before.name).toBe('原脚本');
    expect(task.errorMessage).toBe(oldMessage);
  });
});
