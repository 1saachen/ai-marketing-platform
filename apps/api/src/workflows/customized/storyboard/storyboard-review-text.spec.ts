import { expect, it } from 'vitest';
import { readableScriptReviewText } from './storyboard-review-text';
it('renders the real colour-review finding in ordinary language while preserving facts and quotations', () => {
  const value =
    '候选脚本的 story.structure 仍写为“主编把燕麦白咖啡杯移到会议桌中央”。当前简报 productName 为“黑色款”，productAppearance 明确“产品配色为黑”；beats、content、synopsis 已改为黑色。';
  const result = readableScriptReviewText(value);
  expect(result).toContain('故事结构说明');
  expect(result).toContain('燕麦白咖啡杯');
  expect(result).toContain('产品外观');
  expect(result).toContain('故事段落、正文、脚本概要');
  expect(result).not.toMatch(
    /story\.|productName|productAppearance|\bbeats\b|\bcontent\b|\bsynopsis\b/,
  );
  expect(readableScriptReviewText('story.beats[0].content 与 story/beats/1/content')).toBe(
    '第 1 段故事内容 与 第 2 段故事内容',
  );
  expect(readableScriptReviewText('Content Studio 与产品黑色')).toBe('Content Studio 与产品黑色');
});
