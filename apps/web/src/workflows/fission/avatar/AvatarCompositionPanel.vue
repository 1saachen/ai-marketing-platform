<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, Image as ImageIcon, Plus, Trash2, Upload } from '@lucide/vue';
import {
  AVATAR_LONG_LIMITS,
  AVATAR_RENDER_LIMITS,
  type AvatarCaptionCue,
  type AvatarCompositionSettings,
  type AvatarRenderWorkspace,
} from '@ai-marketing/contracts';
import { apiUrl } from '../../../api/http-client';

const props = defineProps<{
  tool: 'background' | 'subtitle';
  settings: AvatarCompositionSettings;
  backgrounds: AvatarRenderWorkspace['backgrounds'];
  durationMs: number;
  longSource: boolean;
  disabled: boolean;
  importing: boolean;
  importFeedback: string;
}>();
const emit = defineEmits<{
  edit: [patch: Partial<AvatarCompositionSettings>];
  upload: [file: File];
}>();
const uploadInput = ref<HTMLInputElement>();
const modes: { value: AvatarCompositionSettings['captionMode']; label: string }[] = [
  { value: 'OFF', label: '关闭字幕' },
  { value: 'SIDECAR', label: '仅独立 SRT' },
  { value: 'BURN', label: '仅烧录到成片' },
  { value: 'BOTH', label: '烧录并导出 SRT' },
];
const { maxCaptionCharacters } = AVATAR_RENDER_LIMITS;
const maxCaptionCount = computed(() =>
  props.longSource ? AVATAR_LONG_LIMITS.maxCaptionCount : AVATAR_RENDER_LIMITS.maxCaptionCount,
);
const selected = (asset: { assetId: string; version: number }) =>
  props.settings.background.kind === 'IMAGE' &&
  props.settings.background.assetId === asset.assetId &&
  props.settings.background.version === asset.version;
const solidColor = computed(() =>
  props.settings.background.kind === 'SOLID' ? props.settings.background.color : '#18263D',
);
const nextCue = computed(() => {
  if (props.settings.captions.length >= maxCaptionCount.value) return null;
  let startMs = 0;
  for (const [index, cue] of props.settings.captions.entries()) {
    if (cue.startMs >= startMs + 250) {
      return { index, startMs, endMs: Math.min(cue.startMs, startMs + 1500), text: '' };
    }
    startMs = cue.endMs;
  }
  if (startMs >= props.durationMs) return null;
  return {
    index: props.settings.captions.length,
    startMs,
    endMs: Math.min(props.durationMs, startMs + 1500),
    text: '',
  };
});

function solid(color = solidColor.value) {
  emit('edit', { background: { kind: 'SOLID', color } });
}

function chooseImage(asset: { assetId: string; version: number }) {
  emit('edit', { background: { kind: 'IMAGE', assetId: asset.assetId, version: asset.version } });
}

function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) emit('upload', file);
}

function addCue() {
  if (!nextCue.value) return;
  const { index, ...cue } = nextCue.value;
  const captions = [...props.settings.captions];
  captions.splice(index, 0, cue);
  emit('edit', { captions });
}

function changeCue(index: number, patch: Partial<AvatarCaptionCue>) {
  const captions = props.settings.captions.map((cue, position) =>
    position === index ? { ...cue, ...patch } : cue,
  );
  emit('edit', { captions });
}

function changeTime(index: number, field: 'startMs' | 'endMs', event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  changeCue(index, { [field]: Number.isFinite(value) ? value : -1 });
}

function removeCue(index: number) {
  emit('edit', { captions: props.settings.captions.filter((_, position) => position !== index) });
}

function media(url: string) {
  return apiUrl(url.startsWith('/api/') ? url.slice(4) : url);
}
</script>

<template>
  <template v-if="tool === 'background'">
    <div class="fas-panel-head">
      <div><b>画布背景</b><small>9:16 竖屏 · 1080P</small></div>
    </div>
    <div class="fas-choice-list">
      <button
        type="button"
        :class="{ selected: settings.background.kind === 'SOLID' }"
        :aria-pressed="settings.background.kind === 'SOLID'"
        :disabled="disabled"
        @click="solid()"
      >
        <i class="avatar-background-swatch" :style="{ backgroundColor: solidColor }" />
        <span
          ><b>纯色背景</b><small>{{ solidColor }}</small></span
        >
        <em><Check v-if="settings.background.kind === 'SOLID'" :size="14" /></em>
      </button>
      <button
        v-for="asset in backgrounds"
        :key="`${asset.assetId}:${asset.version}`"
        type="button"
        :class="{ selected: selected(asset) }"
        :aria-pressed="selected(asset)"
        :disabled="disabled"
        @click="chooseImage(asset)"
      >
        <i class="avatar-background-swatch">
          <img v-if="asset.previewUrl" :src="media(asset.previewUrl)" alt="" loading="lazy" />
          <ImageIcon v-else :size="16" />
        </i>
        <span
          ><b>{{ asset.name }}</b
          ><small>项目背景 · v{{ asset.version }}</small></span
        >
        <em><Check v-if="selected(asset)" :size="14" /></em>
      </button>
    </div>
    <p v-if="!backgrounds.length" class="fas-copy-note">当前项目暂无可用背景图片。</p>
    <input ref="uploadInput" type="file" accept="image/png,image/jpeg" hidden @change="upload" />
    <button
      type="button"
      class="fas-wide-import"
      :disabled="disabled || importing"
      @click="uploadInput?.click()"
    >
      <Upload :size="14" />{{ importing ? '正在导入背景图片…' : '导入背景图片' }}
    </button>
    <p v-if="importFeedback" class="fas-copy-note" role="status">{{ importFeedback }}</p>
  </template>

  <template v-else>
    <div class="fas-panel-head">
      <div>
        <b>字幕</b><small>{{ settings.captions.length }} 条 · 毫秒</small>
      </div>
    </div>
    <label class="avatar-caption-mode">
      字幕输出方式
      <select
        :value="settings.captionMode"
        :disabled="disabled"
        @change="
          emit('edit', {
            captionMode: ($event.target as HTMLSelectElement)
              .value as AvatarCompositionSettings['captionMode'],
          })
        "
      >
        <option v-for="mode in modes" :key="mode.value" :value="mode.value">
          {{ mode.label }}
        </option>
      </select>
    </label>
    <p v-if="!settings.captions.length" class="fas-copy-note">暂无字幕条目。</p>
    <ol class="avatar-caption-list">
      <li v-for="(cue, index) in settings.captions" :key="index">
        <div class="avatar-caption-time">
          <label>
            开始
            <input
              type="number"
              inputmode="numeric"
              min="0"
              :max="durationMs"
              :aria-label="`字幕 ${index + 1} 开始时间（毫秒）`"
              :value="cue.startMs < 0 ? '' : cue.startMs"
              :disabled="disabled"
              @input="changeTime(index, 'startMs', $event)"
            />
          </label>
          <label>
            结束
            <input
              type="number"
              inputmode="numeric"
              min="1"
              :max="durationMs"
              :aria-label="`字幕 ${index + 1} 结束时间（毫秒）`"
              :value="cue.endMs < 0 ? '' : cue.endMs"
              :disabled="disabled"
              @input="changeTime(index, 'endMs', $event)"
            />
          </label>
          <button
            type="button"
            class="fas-btn"
            :aria-label="`删除字幕 ${index + 1}`"
            :disabled="disabled"
            @click="removeCue(index)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
        <textarea
          :value="cue.text"
          :maxlength="maxCaptionCharacters"
          :aria-label="`字幕 ${index + 1} 文字`"
          :disabled="disabled"
          rows="2"
          @input="changeCue(index, { text: ($event.target as HTMLTextAreaElement).value })"
        />
      </li>
    </ol>
    <button type="button" class="fas-wide-import" :disabled="disabled || !nextCue" @click="addCue">
      <Plus :size="14" />添加字幕
    </button>
  </template>
</template>

<style scoped>
.avatar-background-swatch {
  overflow: hidden;
}
.avatar-background-swatch img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-caption-mode,
.avatar-caption-time label {
  display: grid;
  min-width: 0;
  gap: 4px;
  color: #475569;
  font-size: 11px;
}
.avatar-caption-mode select,
.avatar-caption-time input,
textarea {
  width: 100%;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid #dbe4f6;
  border-radius: 6px;
  background: #fff;
  color: #172033;
  font: inherit;
}
.avatar-caption-list {
  display: grid;
  gap: 6px;
  margin: 10px 0;
  padding: 0;
  list-style: none;
}
.avatar-caption-list li {
  display: grid;
  gap: 5px;
  padding: 6px;
  border: 1px solid #dbe4f6;
  border-radius: 8px;
}
.avatar-caption-time {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 4px;
}
.avatar-caption-time button {
  min-width: 0;
  padding: 0 5px;
}
textarea {
  resize: vertical;
  font-size: 12px;
}
</style>
