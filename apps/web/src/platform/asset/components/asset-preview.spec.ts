import type { Asset } from '@ai-marketing/contracts';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import AssetPreview from './AssetPreview.vue';

const fileAsset: Asset = {
  id: 'reference-a',
  projectId: 'project-a',
  name: '参考视频',
  directory: 'SOURCE_MATERIALS',
  type: 'REFERENCE_VIDEO',
  tags: [],
  notes: null,
  originalFileName: 'reference.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 4096,
  hasFile: true,
  previewKind: 'VIDEO',
  contentUrl: '/api/projects/project-a/assets/reference-a/content',
  downloadUrl: '/api/projects/project-a/assets/reference-a/download',
  createdAt: '',
  updatedAt: '',
};
const renderFile = (asset: Asset) =>
  renderToString(createSSRApp(AssetPreview, { asset, compact: true, filePreview: true }));

describe('project asset file preview', () => {
  it('renders the actual compact video without fabricated aspect, duration or resolution', async () => {
    const html = await renderFile(fileAsset);
    expect(html).toContain('<video');
    expect(html).toContain(`src="${fileAsset.contentUrl}"`);
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain('9:16');
    expect(html).not.toContain('00:15');
    expect(html).not.toContain('1080P');
    expect(html).not.toContain('版本记录');
  });

  it('uses file MIME for product videos instead of inventing image or structured previews', async () => {
    const html = await renderFile({ ...fileAsset, type: 'PRODUCT_ASSET' });
    expect(html).toContain('<video');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('preview-visual');
  });

  it('shows unavailable rather than fake media when no file exists', async () => {
    const html = await renderFile({ ...fileAsset, hasFile: false });
    expect(html).toContain('暂无可预览文件');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('00:15');
    expect(html).not.toContain('1080P');
  });

  it('continues to reuse the actual image preview for product images', async () => {
    const html = await renderFile({
      ...fileAsset,
      type: 'PRODUCT_ASSET',
      mimeType: 'image/png',
      previewKind: 'IMAGE',
    });
    expect(html).toContain('<img');
    expect(html).toContain(`src="${fileAsset.contentUrl}"`);
    expect(html).not.toContain('<video');
  });
});
