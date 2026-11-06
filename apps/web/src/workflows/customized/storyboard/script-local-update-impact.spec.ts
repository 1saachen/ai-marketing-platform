import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, type Slots } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ScriptLocalUpdate from './ScriptLocalUpdate.vue';
import { storyboardApi } from './storyboard.api';

const selected = vi.hoisted(() => ({ targetId: '', currentNeedsUpdate: true }));
vi.mock('../shared/CustomizedLocalUpdate.vue', () => ({
  default: {
    props: ['targetId'],
    setup(props: { targetId: string }, { slots }: { slots: Slots }) {
      selected.targetId = props.targetId;
      return () =>
        h(
          'section',
          slots.context?.({
            preview: { items: selected.currentNeedsUpdate ? [{ id: props.targetId }] : [] },
          }),
        );
    },
  },
}));
vi.mock('./storyboard.api', () => ({
  storyboardApi: {
    updateCandidate: vi.fn().mockResolvedValue(null),
    updateScript: vi.fn(),
    saveUpdate: vi.fn(),
  },
}));

describe('script update impact overview', () => {
  beforeEach(() => {
    selected.currentNeedsUpdate = true;
  });
  it.each(['a', 'b', 'c'])(
    'shows every affected scheme while targeting only the selected scheme %s',
    async (scriptId) => {
      const affectedScripts = ['a', 'b', 'c'].map((id) => ({ id, name: `受影响方案 ${id}` }));
      const html = await renderToString(
        createSSRApp(ScriptLocalUpdate, {
          projectId: 'project',
          workflowRunId: 'current-run',
          scriptId,
          affectedScripts,
        }),
      );
      for (const script of affectedScripts) expect(html).toContain(script.name);
      expect(html).toContain('信息卡变化影响的脚本（3）');
      expect(html.match(/当前方案 · 待更新/g)).toHaveLength(1);
      expect(html.match(/其他方案 · 待更新/g)).toHaveLength(2);
      expect(html).toContain('本次只更新当前方案');
      expect(selected.targetId).toBe(scriptId);
      expect(storyboardApi.updateScript).not.toHaveBeenCalled();
      expect(storyboardApi.saveUpdate).not.toHaveBeenCalled();
    },
  );
  it('does not invent affected schemes when no stale results exist', async () => {
    const html = await renderToString(
      createSSRApp(ScriptLocalUpdate, {
        projectId: 'project',
        workflowRunId: 'current-run',
        scriptId: 'a',
        affectedScripts: [],
      }),
    );
    expect(html).not.toContain('信息卡变化影响的脚本（');
  });
  it('uses the latest current-scheme preview while retaining other pending schemes', async () => {
    selected.currentNeedsUpdate = false;
    const html = await renderToString(
      createSSRApp(ScriptLocalUpdate, {
        projectId: 'project',
        workflowRunId: 'run',
        scriptId: 'a',
        affectedScripts: [
          { id: 'a', name: '刚完成的方案' },
          { id: 'b', name: '其他待更新方案' },
        ],
      }),
    );
    expect(html).toContain('信息卡变化影响的脚本（1）');
    expect(html).not.toContain('刚完成的方案');
    expect(html).toContain('其他待更新方案');
  });
});
