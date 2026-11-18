<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import CloneRealWorkspace from './CloneRealWorkspace.vue';

// Demo data is explicitly isolated; formal mode never loads the fixture workspace.
const mockEnabled = import.meta.env.VITE_FISSION_CLONE_MOCK === 'true';
const MockWorkspace = mockEnabled
  ? defineAsyncComponent(() => import('./CloneMockWorkspace.vue'))
  : null;
const workspace = ref<{
  flushPendingEdits: () => Promise<boolean>;
  resumeWorkflowNode?: (nodeId: string) => Promise<boolean>;
  workflowRunId: string;
  cloneDraftRevision?: number | null;
  cloneDraftRevisions?: Record<string, number> | null;
} | null>(null);
defineExpose({
  workflowRunId: computed(() => workspace.value?.workflowRunId ?? ''),
  cloneDraftRevision: computed(() => workspace.value?.cloneDraftRevision ?? null),
  cloneDraftRevisions: computed(() => workspace.value?.cloneDraftRevisions ?? null),
  flushPendingEdits: () => workspace.value?.flushPendingEdits() ?? Promise.resolve(true),
  resumeWorkflowNode: (nodeId: string) =>
    workspace.value?.resumeWorkflowNode?.(nodeId) ?? Promise.resolve(false),
});
</script>
<template>
  <component :is="MockWorkspace" v-if="mockEnabled && MockWorkspace" ref="workspace" />
  <CloneRealWorkspace v-else ref="workspace" />
</template>
