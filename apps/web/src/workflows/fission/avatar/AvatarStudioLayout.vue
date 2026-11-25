<script setup lang="ts">
defineOptions({ inheritAttrs: false });
defineProps<{ busy?: boolean }>();
</script>

<template>
  <div
    class="fas-studio"
    :class="{ 'fas-studio--with-status': !!$slots.status }"
    aria-label="数字人口播自由配置工作台"
    v-bind="$attrs"
  >
    <header class="fas-topbar"><slot name="header" /></header>
    <div v-if="$slots.status" class="fas-layout-status"><slot name="status" /></div>
    <section class="fas-workspace" :inert="busy">
      <aside class="fas-left-panel">
        <slot name="tools" />
        <div class="fas-resource-panel"><slot name="resources" /></div>
      </aside>
      <section class="fas-player-panel"><slot name="player" /></section>
      <aside class="fas-inspector"><slot name="inspector" /></aside>
    </section>
    <slot name="timeline" />
    <slot name="artifacts" />
    <footer class="fas-render-dock"><slot name="render" /></footer>
  </div>
</template>

<style src="./avatar-studio.css"></style>
<style src="./avatar-integration.css"></style>
