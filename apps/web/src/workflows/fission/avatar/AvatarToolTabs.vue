<script setup lang="ts">
import { AudioLines, Captions, FileText, Image as ImageIcon, UserRound } from '@lucide/vue';

export type AvatarTool = 'avatar' | 'voice' | 'background' | 'copy' | 'subtitle';

defineProps<{
  active: AvatarTool;
  busy?: boolean;
  unavailable?: Partial<Record<AvatarTool, string>>;
}>();
const emit = defineEmits<{ choose: [tool: AvatarTool] }>();

const tools = [
  { key: 'avatar', name: '数字人', icon: UserRound },
  { key: 'voice', name: '音色', icon: AudioLines },
  { key: 'background', name: '背景', icon: ImageIcon },
  { key: 'copy', name: '文案', icon: FileText },
  { key: 'subtitle', name: '字幕', icon: Captions },
] as const;
</script>

<template>
  <nav class="fas-tool-tabs" aria-label="数字人口播配置">
    <button
      v-for="tool in tools"
      :key="tool.key"
      :class="{ active: active === tool.key, locked: !!unavailable?.[tool.key] }"
      :disabled="busy || !!unavailable?.[tool.key]"
      :aria-pressed="active === tool.key"
      @click="emit('choose', tool.key)"
    >
      <component :is="tool.icon" :size="16" />
      <span>{{ tool.name }}</span>
      <i v-if="unavailable?.[tool.key]">{{ unavailable[tool.key] }}</i>
    </button>
  </nav>
</template>
