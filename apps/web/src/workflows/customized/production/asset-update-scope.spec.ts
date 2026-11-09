import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it } from 'vitest';
import Scope from './AssetUpdateScope.vue';
it.each([true, false])(
  'shows the asset decision and the image follow-up (%s)',
  async (refreshImages) => {
    const html = await renderToString(
      createSSRApp(Scope, {
        refreshImages,
        scope: [
          { name: '杯子', action: 'UPDATE', reason: '产品配色已变更' },
          { name: '人物', action: 'KEEP', reason: '人物造型未变' },
          { name: '场景', action: 'KEEP', reason: '场景未变' },
        ],
      }),
    );
    expect(html).toContain('修改 1 项，保留 2 项，新增 0 项');
    expect(html).toContain('原样保留');
    expect(html).toContain('人物造型未变');
    expect(html).toContain(
      refreshImages
        ? '只有受影响的已有参考图会随本次更新处理'
        : '从页头的「局部更新」检查已有参考图',
    );
    expect(html).not.toContain('assetId');
  },
);
