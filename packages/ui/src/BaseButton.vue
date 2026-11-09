<script setup lang="ts">
withDefaults(
  defineProps<{
    disabled?: boolean;
    loading?: boolean;
    variant?: 'primary' | 'secondary' | 'accent';
    type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    disabled: false,
    loading: false,
    variant: 'primary',
    type: 'button',
  },
);

defineEmits<{
  click: [event: MouseEvent];
}>();
</script>

<template>
  <button
    class="base-button"
    :class="`base-button--${variant}`"
    :type="type"
    :disabled="disabled || loading"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" class="base-button__spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.base-button {
  --button-fill: #155eef;
  --button-hover: #004eeb;
  --button-text: #fff;
  --button-border: transparent;
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 10px;
  padding: 0 18px;
  color: var(--button-text);
  background: var(--button-fill);
  font: inherit;
  font-weight: 650;
  cursor: pointer;
  transition:
    background 160ms ease,
    transform 160ms ease;
}

.base-button:hover:not(:disabled) {
  background: var(--button-hover);
  transform: translateY(-1px);
}

.base-button--secondary,
.base-button--accent {
  border: 1px solid var(--button-border);
}
.base-button--secondary {
  --button-fill: #fff;
  --button-hover: #f3f7fd;
  --button-text: #3b506b;
  --button-border: #d6e0ee;
}

.base-button--accent {
  --button-fill: #fff6e3;
  --button-hover: #ffedc6;
  --button-text: #7d4710;
  --button-border: #ebcc94;
}

.base-button:focus-visible {
  outline: 3px solid rgb(21 94 239 / 28%);
  outline-offset: 2px;
}

.base-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.base-button__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .base-button {
    transition: none;
  }
  .base-button:hover:not(:disabled) {
    transform: none;
  }
  .base-button__spinner {
    animation: none;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
