import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { CustomizedScriptUpdateCandidate, StoryboardTask } from '@ai-marketing/contracts';
import Status from './ScriptUpdateStatus.vue';
import { createStoryboardScript } from './storyboard-state';
const now = Date.parse('2026-11-06T06:00:00Z');
const script = createStoryboardScript('一杯清晨');
function candidate(status = 'RUNNING'): CustomizedScriptUpdateCandidate {
  return {
    taskId: 'task',
    status,
    errorMessage: null,
    before: script,
    after: script,
    applied: false,
    baselineRevision: 1,
  };
}
function task(
  stage: 'SNAPSHOT' | 'STORY' | 'REVIEW' | 'SAVE',
  status: StoryboardTask['status'] = 'RUNNING',
): StoryboardTask {
  const ids = ['SNAPSHOT', 'STORY', 'REVIEW', 'SAVE'] as const;
  return {
    id: 'task',
    workflowRunId: 'run',
    status,
    progress: 40,
    createdAt: new Date(now - 75000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    errorMessage: null,
    steps: ids.map((nodeId, index) => ({
      nodeId,
      scriptId: nodeId === 'SNAPSHOT' ? '' : 's',
      status: index < ids.indexOf(stage) ? 'SUCCEEDED' : nodeId === stage ? 'RUNNING' : 'PENDING',
      errorMessage: null,
      updatedAt: new Date(now - 10000).toISOString(),
    })),
  };
}
const render = (
  value: CustomizedScriptUpdateCandidate,
  record: StoryboardTask | null,
  syncError = false,
) => renderToString(createSSRApp(Status, { candidate: value, task: record, now, syncError }));
describe('script update status explanation', () => {
  it.each([
    ['SNAPSHOT', '正在读取更新依据'],
    ['STORY', '正在定向修改脚本'],
    ['REVIEW', '正在审校更新稿'],
    ['SAVE', '正在准备可保存的候选'],
  ] as const)(
    'shows the actual %s phase and elapsed time, without an invented ETA',
    async (stage, label) => {
      const html = await render(candidate(), task(stage));
      expect(html).toContain(label);
      expect(html).toContain('1 分 15 秒');
      expect(html).toContain('剩余时间暂无法准确预估');
      expect(html).not.toContain('剩余 30 秒');
      if (stage === 'REVIEW') expect(html).toContain('审校通过后会自动启用');
    },
  );
  it('distinguishes queue, completion and stopped/failed results', async () => {
    expect(await render(candidate('QUEUED'), task('SNAPSHOT', 'QUEUED'))).toContain(
      '等待开始局部更新',
    );
    const html = await render(candidate('COMPLETED'), task('SAVE', 'COMPLETED'));
    expect(html).toContain('审校已完成，可以保存修改');
    expect(html).not.toContain('已等待');
    expect(await render(candidate('CANCELLED'), null)).toContain('更新已停止');
    expect(
      await render({ ...candidate('FAILED'), errorMessage: '候选有事实问题' }, null),
    ).toContain('候选有事实问题');
  });
  it('does not infer a phase or time from a mismatched or unavailable task', async () => {
    const html = await render(candidate(), { ...task('REVIEW'), id: 'other' }, true);
    expect(html).toContain('正在查询更新阶段');
    expect(html).toContain('进度暂未同步');
    expect(html).not.toContain('1 分 15 秒');
    expect(await render(candidate(), { ...task('REVIEW'), createdAt: 'invalid' })).not.toContain(
      '本次更新已等待',
    );
  });
});
