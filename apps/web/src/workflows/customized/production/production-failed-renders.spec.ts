import { expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type {
  ProductionAsset,
  ProductionTask,
  ProductionVideoDocument,
} from '@ai-marketing/contracts';
import FailedRenders from './ProductionFailedRenders.vue';

const person: ProductionAsset = {
  id: 'person',
  name: '老张',
  kind: 'CHARACTER',
  description: '',
  knownFacts: '',
  designNotes: '',
  sourceText: '',
  image: { assetId: 'person-image', version: 2 },
};
const detail: ProductionAsset = {
  ...person,
  id: 'scarf',
  name: '围巾',
  kind: 'PROP',
  image: null,
  preparation: {
    aliases: [],
    usage: '',
    treatment: 'CHARACTER_DETAIL',
    parentId: 'person',
    sources: [],
    details: [],
    questions: [],
    images: [],
  },
};
const failed = (references?: ProductionTask['renderReferences']): ProductionTask => ({
  id: 'failed',
  operation: 'RENDER',
  status: 'FAILED',
  target: { kind: 'CLIP', id: 'clip' },
  shotId: null,
  steps: [],
  progress: 25,
  errorMessage: '参考图需要调整',
  ...(references ? { renderReferences: references } : {}),
});
const reference = {
  objectId: 'scarf',
  name: '围巾',
  sourceObjectId: 'person',
  sourceName: '老张',
  assetId: 'person-image',
  version: 1,
};
async function html(task: ProductionTask, assets = [person, detail], hasClip = true) {
  return renderToString(
    createSSRApp(FailedRenders, {
      projectId: 'p',
      tasks: [task],
      disabled: false,
      document: {
        schemaVersion: 2,
        assets,
        videoPlan: { clips: hasClip ? [{ id: 'clip', title: '拿杯' }] : [] },
      } as unknown as ProductionVideoDocument,
    }),
  );
}
it('groups shared picture versions and shows their actual owning asset', async () => {
  const value = await html(
    failed([
      reference,
      { objectId: person.id, name: person.name, assetId: reference.assetId, version: 1 },
    ]),
  );
  expect(value).toContain('本次参考图 · 1 张');
  expect(value).toContain('本镜引用 围巾');
  expect(value).toContain('当前资产图片已更新');
  expect(value.match(/查看本次图片/g)).toHaveLength(1);
  expect(value).not.toContain('请在当前分镜核对这项素材的归属');
});
it('disables replacing an old reference whose object was removed or reparented', async () => {
  const removed = await html(failed([reference]), [person]);
  const moved = await html(failed([reference]), [
    person,
    { ...detail, preparation: undefined } as unknown as ProductionAsset,
  ]);
  for (const value of [removed, moved]) {
    expect(value).toContain('请在当前分镜核对这项素材的归属');
    expect(value).toMatch(/<button[^>]*disabled[^>]*>\s*更换图片/);
    expect(value).toContain('查看本次图片');
  }
  expect(await html(failed([reference]), [], false)).toMatch(
    /<button[^>]*disabled[^>]*>\s*查看分镜/,
  );
});
it('distinguishes missing historical records from a task that used no pictures', async () => {
  expect(await html(failed())).toContain('本次用图记录暂不可用');
  expect(await html(failed([]))).toContain('本次任务使用文字提示词');
});
