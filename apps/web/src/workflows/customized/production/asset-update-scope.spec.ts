import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it } from 'vitest';
import Scope from './AssetUpdateScope.vue';
it('shows the model decision separately from the possible dependency range', async () => {
  const html = await renderToString(
    createSSRApp(Scope, {
      scope: [
        { name: '杯子', action: 'UPDATE', reason: '产品配色已变更' },
        { name: '人物', action: 'KEEP', reason: '人物造型未变' },
        { name: '场景', action: 'KEEP', reason: '场景未变' },
      ],
    }),
  );
  expect(html).toContain('需修改 1 项，保留 2 项，新增 0 项');
  expect(html).toContain('原样保留');
  expect(html).toContain('人物造型未变');
  expect(html).toContain('已有图片保留');
  expect(html).not.toContain('assetId');
});
