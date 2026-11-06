/** Presentation only: translate known field references, never rewrite the stored finding or script. */
export function readableScriptReviewText(value: string): string {
  let result = value
    .replace(/\b(?:candidateScript|candidate|script)[./](?=story[./])/g, '')
    .replace(
      /\b(?:currentBrief|brief)[./](?=productName|productAppearance|sellingPoints)/g,
      '信息卡中的',
    )
    .replace(
      /\bstory[./]beats(?:\[(\d+)\]|[./](\d+))[./]content\b/g,
      (_match, bracket: string | undefined, path: string | undefined) =>
        `第 ${Number(bracket ?? path) + 1} 段故事内容`,
    );
  const labels: Record<string, string> = {
    'story.structure': '故事结构说明',
    'story.content': '脚本正文',
    'story.beats': '故事段落',
    'story.opening': '开场',
    'story.development': '故事发展',
    'story.ending': '收束',
    'story.dialoguePlan': '对白安排',
    productName: '产品名称',
    productAppearance: '产品外观',
    sellingPoints: '卖点',
    synopsis: '脚本概要',
    productFocus: '产品关联',
    beats: '故事段落',
    content: '正文',
    dialoguePlan: '对白安排',
    structure: '结构说明',
  };
  for (const [field, label] of Object.entries(labels)) {
    const pattern = field.split('.').join('[./]');
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_])${pattern}(?![A-Za-z0-9_])`, 'g'), label);
  }
  return result;
}
