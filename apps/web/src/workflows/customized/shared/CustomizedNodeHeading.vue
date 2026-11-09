<script setup lang="ts">
defineProps<{ index: string; title: string; description: string; titleId?: string }>();
</script>

<template>
  <header class="node-heading">
    <div class="node-heading__copy">
      <span class="node-heading__index" aria-hidden="true">{{ index }}</span>
      <div>
        <h2 :id="titleId">{{ title }}</h2>
        <p>{{ description }}</p>
      </div>
    </div>
    <div class="node-heading__tools">
      <div class="node-heading__actions"><slot name="actions" /></div>
      <div v-if="$slots.update" class="node-heading__update"><slot name="update" /></div>
    </div>
  </header>
</template>

<style scoped>
.node-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px 20px;
  margin-bottom: 22px;
}
.node-heading__copy {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.node-heading__index {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  place-items: center;
  border: 1px solid #d7e4fc;
  border-radius: 11px;
  background: #eaf1ff;
  color: #2563eb;
  font-size: 14px;
  font-weight: 750;
}
h2 {
  margin: 0 0 4px;
  color: #23344d;
  font-size: 22px;
  line-height: 1.3;
}
p {
  margin: 0;
  color: #5e7087;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.node-heading__tools {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  flex: 0 1 auto;
  gap: 8px;
  max-width: 100%;
  margin-inline-start: auto;
}
.node-heading__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.node-heading__actions :deep(.workflow-node-edit-actions) {
  flex-wrap: wrap;
  gap: 8px;
}
.node-heading__update {
  flex: 0 0 auto;
  padding-inline-start: 8px;
  border-inline-start: 1px solid #e1e9f4;
}
.node-heading__tools :deep(button) {
  height: 40px;
  min-height: 40px;
  padding: 0 13px;
  justify-content: center;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}
.node-heading__tools
  :deep(button:not(.base-button, .node-heading__save-action):not(:disabled):hover) {
  background: #f2f6fc;
  border-color: #a9bdd7;
}
.node-heading__tools :deep(.node-heading__save-action) {
  color: #fff;
  background: #155eef;
  border-color: #155eef;
}
.node-heading__tools :deep(.node-heading__save-action:not(:disabled):hover) {
  background: #004eeb;
  border-color: #004eeb;
}
.node-heading__tools :deep(button:focus-visible) {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
@media (max-width: 680px) {
  .node-heading__tools {
    flex: 1 1 100%;
    justify-content: space-between;
  }
  .node-heading__actions {
    justify-content: flex-start;
  }
  .node-heading__update {
    margin-inline-start: auto;
  }
  .node-heading__tools :deep(button) {
    padding: 0 10px;
    font-size: 11px;
  }
}
</style>
