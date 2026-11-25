<script setup lang="ts">
import {
  AVATAR_COMPOSITION_NODE,
  AVATAR_OUTPUT_NODE,
  AVATAR_SYNC_NODE,
  FISSION_AVATAR_NODES,
} from '@ai-marketing/contracts';
import { GitBranch, Replace, UserRound } from '@lucide/vue';
import { computed, defineAsyncComponent, inject, nextTick, ref, watch } from 'vue';
import { projectContextKey } from '../../../platform/project/project-context';
import LocalReplaceRealWorkspace from '../local-replace/LocalReplaceRealWorkspace.vue';
import FissionCloneWorkspace from '../clone/FissionCloneWorkspace.vue';
import AvatarRealWorkspace from '../avatar/AvatarRealWorkspace.vue';
const props = withDefaults(
  defineProps<{
    projectId?: string;
    projectName?: string;
    preview?: boolean;
    initialModule?: 'clone' | 'avatar' | 'replace' | '';
  }>(),
  {
    projectId: '',
    projectName: '',
    preview: false,
    initialModule: '',
  },
);
const savedModule = localStorage.getItem('ai-marketing.fission.active-module');
const developmentPreview = import.meta.env.DEV && props.preview;
const AvatarMockWorkspace = developmentPreview
  ? defineAsyncComponent(() => import('../avatar/AvatarWorkspace.vue'))
  : null;
const LocalReplaceMockWorkspace = developmentPreview
  ? defineAsyncComponent(() => import('../local-replace/LocalReplaceWorkspace.vue'))
  : null;
const projectContext = inject(projectContextKey, null);
const active = ref(
  props.initialModule ||
    (savedModule && ['clone', 'avatar', 'replace'].includes(savedModule) ? savedModule : 'clone'),
);
watch(active, (value) => localStorage.setItem('ai-marketing.fission.active-module', value));
const cloneWorkspace = ref<InstanceType<typeof FissionCloneWorkspace>>();
const avatarWorkspace = ref<InstanceType<typeof AvatarRealWorkspace>>();
const avatarPreview = ref<{ flushPendingEdits: () => Promise<boolean> }>();
const workspace = ref<{
  flushPendingEdits: () => Promise<boolean> | boolean;
  workflowRunId?: string;
  draftRevision?: number | null;
}>();
const switching = ref(false);
const switchError = ref('');
const activeWorkspace = computed(() =>
  active.value === 'clone'
    ? cloneWorkspace.value
    : active.value === 'avatar'
      ? (avatarWorkspace.value ?? avatarPreview.value)
      : workspace.value,
);
const flushPendingEdits = async () => {
  if (switching.value) return false;
  return (await activeWorkspace.value?.flushPendingEdits()) ?? true;
};
async function selectModule(target: 'clone' | 'avatar' | 'replace') {
  if (switching.value) return false;
  if (target === active.value) return true;
  switching.value = true;
  switchError.value = '';
  try {
    if ((await activeWorkspace.value?.flushPendingEdits()) === false) {
      switchError.value = '当前草稿尚未保存，请处理后再切换。';
      return false;
    }
    active.value = target;
    await nextTick();
    return true;
  } catch {
    switchError.value = '草稿保存失败，当前编辑已保留，请重试。';
    return false;
  } finally {
    switching.value = false;
  }
}
defineExpose({
  flushPendingEdits,
  selectModule,
  workflowRunId: computed(() =>
    active.value === 'clone'
      ? (cloneWorkspace.value?.workflowRunId ?? '')
      : active.value === 'replace'
        ? (workspace.value?.workflowRunId ?? '')
        : (avatarWorkspace.value?.workflowRunId ?? ''),
  ),
  cloneDraftRevision: computed(() =>
    active.value === 'clone' ? (cloneWorkspace.value?.cloneDraftRevision ?? null) : null,
  ),
  cloneDraftRevisions: computed(() =>
    active.value === 'clone' ? (cloneWorkspace.value?.cloneDraftRevisions ?? null) : null,
  ),
  localReplaceDraftRevision: computed(() =>
    active.value === 'replace' ? (workspace.value?.draftRevision ?? null) : null,
  ),
  avatarDraftRevision: computed(() =>
    active.value === 'avatar' ? (avatarWorkspace.value?.draftRevision ?? null) : null,
  ),
  avatarCompositionDraftRevision: computed(() =>
    active.value === 'avatar' ? (avatarWorkspace.value?.compositionDraftRevision ?? null) : null,
  ),
  resumeWorkflowNode: async (nodeId: string) => {
    if (
      nodeId === FISSION_AVATAR_NODES.binding ||
      nodeId === FISSION_AVATAR_NODES.script ||
      nodeId === AVATAR_SYNC_NODE ||
      nodeId === AVATAR_COMPOSITION_NODE ||
      nodeId === AVATAR_OUTPUT_NODE
    ) {
      if (!(await selectModule('avatar'))) return false;
      await nextTick();
      return avatarWorkspace.value?.resumeWorkflowNode(nodeId) ?? false;
    }
    if (!nodeId.startsWith('CLONE_') || !(await selectModule('clone'))) return false;
    await nextTick();
    return cloneWorkspace.value?.resumeWorkflowNode(nodeId) ?? false;
  },
});
</script>
<template>
  <div class="fission-page">
    <nav class="fission-module-tabs" aria-label="裂变功能">
      <button
        :class="{ active: active === 'clone' }"
        :disabled="switching"
        @click="selectModule('clone')"
      >
        <i><GitBranch :size="21" /></i
        ><span><b>爆款视频复刻</b><small>拆解结构 · 映射元素 · 批量裂变</small></span
        ><em>›</em>
      </button>
      <button
        :class="{ active: active === 'avatar' }"
        :disabled="switching"
        @click="selectModule('avatar')"
      >
        <i><UserRound :size="21" /></i
        ><span><b>数字人口播</b><small>定制形象 · 口播驱动 · 长视频输出</small></span
        ><em>›</em>
      </button>
      <button
        :class="{ active: active === 'replace' }"
        :disabled="switching"
        @click="selectModule('replace')"
      >
        <i><Replace :size="21" /></i
        ><span><b>局部元素替换</b><small>选择原片与时间范围 · 替换选中对象</small></span
        ><em>›</em>
      </button>
    </nav>
    <p v-if="switchError" class="fission-switch-error" role="alert">{{ switchError }}</p>
    <FissionCloneWorkspace
      v-if="active === 'clone' && projectContext"
      ref="cloneWorkspace"
      :key="projectId || 'clone-preview'"
    />
    <component
      :is="LocalReplaceMockWorkspace"
      v-else-if="active === 'replace' && LocalReplaceMockWorkspace"
      ref="workspace"
      :key="projectId || 'preview'"
      :project-id="projectId"
      :project-name="projectName"
      preview
    />
    <LocalReplaceRealWorkspace
      v-else-if="active === 'replace'"
      ref="workspace"
      :key="projectId || 'unbound'"
      :project-id="projectId"
      :project-name="projectName"
    />
    <component
      :is="AvatarMockWorkspace"
      v-else-if="active === 'avatar' && AvatarMockWorkspace"
      ref="avatarPreview"
      :project-id="projectId"
      :project-name="projectName"
      preview
    />
    <AvatarRealWorkspace
      v-else-if="active === 'avatar'"
      ref="avatarWorkspace"
      :key="projectId || 'avatar-preview'"
      :project-id="projectId"
      :project-name="projectName"
    />
    <section v-else class="fission-placeholder">
      <GitBranch :size="36" />
      <h2>爆款视频复刻</h2>
      <p>请从系统项目工作台打开此工作流。</p>
      <button class="lr-btn primary" @click="selectModule('replace')">返回局部元素替换</button>
    </section>
  </div>
</template>
<style scoped>
.fission-page {
  max-width: 1360px;
  margin: auto;
  padding: 24px 24px 64px;
}
.fission-switch-error {
  color: #b42318;
  background: #fff3f2;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 12px;
}
.fission-module-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-bottom: 20px;
}
.fission-module-tabs button {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 17px 18px;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  background: #fff;
  color: #475569;
  text-align: left;
}
.fission-module-tabs button.active {
  border-color: #dfd4e4;
  background: #eef3ff;
  box-shadow: 0 0 0 2px #f8e9ed;
}
.fission-module-tabs i {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: 14px;
  background: #f1f5f9;
  font-style: normal;
}
.fission-module-tabs .active i {
  background: #2563eb;
  color: #fff;
}
.fission-module-tabs span {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fission-module-tabs b {
  font-size: 14px;
  color: #172033;
}
.fission-module-tabs small {
  color: #94a3b8;
  font-size: 11px;
}
.fission-module-tabs em {
  margin-left: auto;
  color: #cbd5e1;
  font-style: normal;
}
.fission-placeholder {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 90px 20px;
  background: white;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  color: #64748b;
}
.fission-placeholder h2,
.fission-placeholder p {
  margin: 0;
}
@media (max-width: 720px) {
  .fission-page {
    padding: 14px 8px 30px;
  }
  .fission-module-tabs {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .fission-module-tabs button {
    padding: 10px 14px;
    border-radius: 16px;
  }
  .fission-module-tabs span {
    gap: 2px;
  }
}
</style>
