import { describe, it, expect } from 'vitest';
import { applyCustomizedScriptPatches } from './customized-update';
import { storyboardStages } from './customized-storyboard-generation';
describe('customized local script patches', () => {
  it('updates root narrative description together with the story, preserving identity and type settings', () => {
    const script = {
      id: 'script',
      structure: '燕麦白杯子进入会议室。大家继续讨论。',
      synopsis: '她拿起燕麦白杯子',
      creation: { videoType: 'DRAMA' },
      settings: { structureMode: 'AI' },
      story: {
        content: '她把燕麦白杯子放到桌上。',
        beats: [{ id: 'b', durationSeconds: 15, content: '继续讨论' }],
      },
    };
    const changed = applyCustomizedScriptPatches(script, [
      ...['structure', 'synopsis', 'story/content'].map((path) => ({
        path,
        before: '燕麦白杯子',
        after: '黑色杯子',
        reason: '当前商品外观',
      })),
    ]);
    expect(changed.structure).toBe('黑色杯子进入会议室。大家继续讨论。');
    expect(changed.synopsis).toBe('她拿起黑色杯子');
    expect(changed.story.content).toBe('她把黑色杯子放到桌上。');
    expect(changed.story.beats).toEqual(script.story.beats);
    expect(changed.creation).toEqual(script.creation);
    expect(changed.settings).toEqual(script.settings);
    expect(changed.id).toBe(script.id);
    expect(script.structure).toContain('燕麦白');
    expect(() =>
      applyCustomizedScriptPatches({ story: { content: '正文' } }, [
        { path: 'story/structure', before: 'x', after: 'y', reason: '不能新造字段' },
      ]),
    ).toThrow();
  });
  const original = {
    id: 'script',
    name: '夜晚',
    synopsis: '一只蓝色杯子',
    story: {
      content: '他拿起蓝色杯子。窗外下雨。',
      beats: [{ id: 'b1', content: '蓝色杯子', durationSeconds: 10 }],
    },
  };
  it('changes only a unique requested fragment, with stable identity and other paragraphs', () => {
    const result = applyCustomizedScriptPatches(original, [
      { path: 'story/content', before: '蓝色杯子', after: '白色杯子', reason: '产品外观已确认' },
      { path: 'story/beats/0/content', before: '蓝色杯子', after: '白色杯子', reason: '同步篇章' },
    ]);
    expect(result.story.content).toBe('他拿起白色杯子。窗外下雨。');
    expect(result.id).toBe(original.id);
    expect(result.story.beats[0]?.id).toBe('b1');
    expect(original.story.content).toContain('蓝色');
  });
  it.each([
    'id',
    '__proto__/polluted',
    'story/beats/0/id',
    'story/missing',
    'creation/videoType',
    'settings/structureMode',
    'story/beats/0/durationSeconds',
  ])('rejects a forbidden path %s', (path) =>
    expect(() =>
      applyCustomizedScriptPatches(original, [
        { path, before: 'script', after: 'other', reason: 'x' },
      ]),
    ).toThrow(),
  );
  it('rejects stale and ambiguous originals and does not partially mutate the baseline', () => {
    expect(() =>
      applyCustomizedScriptPatches(original, [
        { path: 'story/content', before: '没有这段', after: 'x', reason: 'x' },
      ]),
    ).toThrow();
    expect(() =>
      applyCustomizedScriptPatches({ synopsis: '杯子与杯子' }, [
        { path: 'synopsis', before: '杯子', after: '瓶子', reason: 'x' },
      ]),
    ).toThrow();
    expect(applyCustomizedScriptPatches(original, [])).toEqual(original);
  });
  it('freezes local update stages without changing normal creation', () => {
    expect(storyboardStages({ incremental: { version: 1 } }).map((s) => s.id)).toEqual([
      'SNAPSHOT',
      'STORY',
      'REVIEW',
      'SAVE',
    ]);
    expect(storyboardStages({ outputMode: 'STORY_ONLY' }).some((s) => s.id === 'CONCEPT')).toBe(
      true,
    );
  });
});
