import { expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ExtractionPage from '../information-extraction/CustomizedInfoExtractionNodePage.vue';
import StoryboardPage from '../storyboard/CustomizedStoryboardNodePage.vue';
import { emptyStoryboardDraft } from '../storyboard/storyboard-state';
import CustomizedUpdateTrigger from './CustomizedUpdateTrigger.vue';

it('keeps the update action in the node heading and the feedback immediately after it', async () => {
  const trigger = () => h(CustomizedUpdateTrigger);
  const status = () => h('p', { role: 'status' }, '局部更新进行中');
  const pages = [
    () =>
      h(
        ExtractionPage,
        { projectId: 'project', workflowRunId: 'run', sourceConfirmed: true, sources: [] },
        { 'local-update': trigger, notices: status },
      ),
    () =>
      h(
        StoryboardPage,
        {
          draft: emptyStoryboardDraft(),
          editing: false,
          sourceReady: true,
          readonly: false,
          saving: false,
          productName: '',
          saveMessage: '',
          error: '',
          stale: true,
          projectId: 'project',
          task: null,
          brief: null,
          sourceRevision: null,
          nextReady: false,
        },
        { 'local-update': trigger, 'local-update-status': status },
      ),
  ];
  for (const render of pages) {
    const html = await renderToString(createSSRApp({ render }));
    const header = html.match(/<header class="node-heading"[^>]*>[\s\S]*?<\/header>/)?.[0];
    expect(header).toMatch(/node-heading__actions[\s\S]*node-heading__update[\s\S]*局部更新/);
    expect(header).toContain('aria-haspopup="dialog"');
    expect(header).toContain('base-button--accent');
    expect(html.match(/base-button--accent/g)).toHaveLength(1);
    expect(html.indexOf('局部更新进行中')).toBeGreaterThan(html.indexOf('</header>'));
  }
});
