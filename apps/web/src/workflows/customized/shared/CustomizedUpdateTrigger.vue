<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import { BaseButton } from '@ai-marketing/ui';
defineProps<{ disabled?: boolean }>();
defineEmits<{ open: [] }>();
</script>

<template>
  <BaseButton variant="accent" aria-haspopup="dialog" :disabled="disabled" @click="$emit('open')">
    <RefreshCw :size="15" aria-hidden="true" />
    局部更新
  </BaseButton>
</template>
