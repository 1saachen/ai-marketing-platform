import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planAvatarSegments } from './plan-segments.mjs';

test('plans repeatable natural speech spans without dropping characters or splitting surrogate pairs', () => {
  const phrase = '这里是🧪口播示例。现在继续介绍第二部分！';
  const source = [phrase, phrase, phrase].join('\r\n');
  const plan = planAvatarSegments(source, 23);
  assert.equal(plan.segments.length, 3);
  assert.deepEqual(plan, planAvatarSegments(source.replaceAll('\r\n', '\n'), 23));
  const points = Array.from(source.replaceAll('\r\n', '\n'));
  assert.equal(plan.segments.at(-1).sourceEnd, points.length);
  for (const { sourceStart, sourceEnd, text, characters } of plan.segments) {
    assert.equal(points.slice(sourceStart, sourceEnd).join('').trim(), text);
    assert.equal(characters, Array.from(text).length);
    assert.match(text, /！$/u);
  }
});

test('uses a clause pause and preserves decimals and grouped numbers', () => {
  const source = '请记录面板数值3.14和1,024，确认后继续录制，请保持自然清晰的语速。';
  const plan = planAvatarSegments(source, 21);
  assert.equal(plan.segments[0].text, '请记录面板数值3.14和1,024，');
  assert.equal(plan.segments.map(({ text }) => text).join(''), source);
});

test('keeps closing punctuation with its clause', () => {
  const source = '请说“今天已经准备好，可以开始录制”，接下来请按照镜头顺序介绍事项。';
  const plan = planAvatarSegments(source, 23);
  assert.match(plan.segments[0].text, /”，$/u);
});

test('rejects a segment with no pause and out-of-range input', () => {
  assert.throws(() => planAvatarSegments('口'.repeat(22), 21), /缺少可用停顿/u);
  assert.throws(() => planAvatarSegments('！。'), /文案为空/u);
  assert.throws(() => planAvatarSegments('正常口播。', 121), /20–120/u);
  assert.throws(() => planAvatarSegments('示例。'.repeat(81), 20), /12 段总容量/u);
});
