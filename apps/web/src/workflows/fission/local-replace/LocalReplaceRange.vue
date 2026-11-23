<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ArrowRight, Film, Play, RotateCcw, SlidersHorizontal } from '@lucide/vue';
import type { Asset } from '@ai-marketing/contracts';
import { LOCAL_REPLACE_LIMITS } from '@ai-marketing/contracts';
import { localReplaceTime, seekLocalVideo } from './local-replace-media';

const props = defineProps<{
  source: Asset;
  durationMs: number;
  startMs: number;
  endMs: number;
  rangeValid: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{
  change: [range: { startMs: number; endMs: number }];
  mediaError: [];
}>();
type Edge = 'startMs' | 'endMs';
type DragControl = Edge | 'playhead';
const video = ref<HTMLVideoElement>();
const lane = ref<HTMLDivElement>();
const playhead = ref(0);
const zoom = ref(1);
const drag = ref<{
  pointerId: number;
  control: DragControl;
  startX: number;
  initialMs: number;
  currentMs: number;
}>();
const displayStart = computed(() =>
  drag.value?.control === 'startMs' ? drag.value.currentMs : props.startMs,
);
const displayEnd = computed(() =>
  drag.value?.control === 'endMs' ? drag.value.currentMs : props.endMs,
);
const length = computed(() => Math.max(0, displayEnd.value - displayStart.value));
const ratio = (milliseconds: number) => `${(milliseconds / props.durationMs) * 100}%`;
const time = localReplaceTime;
const width = computed(() => Math.round(640 * zoom.value));
const handlesOverlap = computed(() => (length.value / props.durationMs) * width.value < 40);
const ticks = computed(() =>
  Array.from({ length: 6 }, (_, index) => Math.round((props.durationMs * index) / 5)),
);
const minRange = LOCAL_REPLACE_LIMITS.minRangeMs;
const maxStart = computed(() => Math.max(0, props.endMs - minRange));
const minEnd = computed(() => Math.min(props.durationMs, props.startMs + minRange));
let previewFrame: number | undefined;

function limitEdge(edge: Edge, milliseconds: number) {
  const min = edge === 'startMs' ? 0 : minEnd.value;
  const max = edge === 'startMs' ? maxStart.value : props.durationMs;
  return Math.max(min, Math.min(max, Math.round(milliseconds)));
}

function commitRange(startMs: number, endMs: number) {
  if (props.disabled) return;
  scrub(startMs);
  if (startMs !== props.startMs || endMs !== props.endMs) emit('change', { startMs, endMs });
}

function setEdge(edge: Edge, milliseconds: number) {
  if (!Number.isFinite(milliseconds)) return;
  const position = limitEdge(edge, milliseconds);
  if (edge === 'startMs') commitRange(position, props.endMs);
  else commitRange(props.startMs, position);
}

function changeTimeField(edge: Edge, event: Event) {
  const field = event.currentTarget as HTMLInputElement;
  const value = field.valueAsNumber * 1000;
  field.value = String((Number.isFinite(value) ? limitEdge(edge, value) : props[edge]) / 1000);
  setEdge(edge, value);
}

function seek(milliseconds: number) {
  playhead.value = Math.max(0, Math.min(props.durationMs, Math.round(milliseconds)));
  seekLocalVideo(video.value, playhead.value / 1000, 0);
}

function scrub(milliseconds: number) {
  video.value?.pause();
  seek(milliseconds);
}

function cancelPreviewFrame() {
  if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
  previewFrame = undefined;
}
onBeforeUnmount(cancelPreviewFrame);

function syncPlayhead() {
  const media = video.value;
  if (!media) return;
  if (!media.paused && props.rangeValid && media.currentTime * 1000 >= props.endMs) {
    scrub(props.endMs);
    return;
  }
  playhead.value = Math.round(media.currentTime * 1000);
}

function trackPreview() {
  syncPlayhead();
  previewFrame = video.value?.paused === false ? requestAnimationFrame(trackPreview) : undefined;
}

function onPlay() {
  cancelPreviewFrame();
  const position = (video.value?.currentTime ?? 0) * 1000;
  if (props.rangeValid && (position < props.startMs || position >= props.endMs))
    seek(props.startMs);
  trackPreview();
}

function playSelection() {
  const media = video.value;
  if (!props.rangeValid || !media) return;
  seek(props.startMs);
  void media.play().catch(() => undefined);
}

function timeAtPointer(event: MouseEvent) {
  const bounds = lane.value?.getBoundingClientRect();
  return bounds && bounds.width > 0
    ? ((event.clientX - bounds.left) / bounds.width) * props.durationMs
    : playhead.value;
}

function startDrag(event: PointerEvent, control: DragControl) {
  if (event.button !== 0 || drag.value || (props.disabled && control !== 'playhead')) return;
  const initialMs = control === 'playhead' ? playhead.value : props[control];
  video.value?.pause();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag.value = {
    pointerId: event.pointerId,
    control,
    startX: event.clientX,
    initialMs,
    currentMs: initialMs,
  };
}

function moveDrag(event: PointerEvent) {
  const current = drag.value;
  const pixels = lane.value?.getBoundingClientRect().width;
  if (!current || event.pointerId !== current.pointerId || !pixels) return;
  const position =
    current.initialMs + ((event.clientX - current.startX) / pixels) * props.durationMs;
  if (current.control === 'playhead') {
    seek(position);
    return;
  }
  current.currentMs = limitEdge(current.control, position);
  seek(current.currentMs);
}

function finishDrag(event: PointerEvent, commit: boolean) {
  const current = drag.value;
  if (!current || event.pointerId !== current.pointerId) return;
  if (commit) moveDrag(event);
  drag.value = undefined;
  if (current.control === 'playhead') return;
  if (commit) setEdge(current.control, current.currentMs);
  else seek(props.startMs);
}
</script>

<template>
  <div v-if="durationMs > 0" class="lr-trim-workbench">
    <header class="lr-trim-topbar">
      <div class="lr-trim-file">
        <i><Film :size="20" /></i>
        <span
          ><b>{{ source.name }}</b
          ><small>第 {{ source.currentVersion }} 版</small></span
        >
      </div>
      <strong :class="{ ready: rangeValid }"
        >{{ time(displayStart) }}–{{ time(displayEnd) }}</strong
      >
    </header>
    <div class="lr-trim-upper">
      <section class="lr-trim-player">
        <header>
          <b>原片预览</b><span>{{ time(durationMs) }}</span>
        </header>
        <div class="lr-trim-stage">
          <video
            ref="video"
            class="lr-local-video"
            :src="source.contentUrl"
            preload="metadata"
            controls
            playsinline
            @loadedmetadata="seek(startMs)"
            @play="onPlay"
            @pause="cancelPreviewFrame"
            @timeupdate="syncPlayhead"
            @error="emit('mediaError')"
          />
        </div>
      </section>
      <aside class="lr-trim-inspector">
        <header>
          <div>
            <SlidersHorizontal :size="18" /><span
              ><b>范围属性</b><small>播放头 {{ time(playhead) }}</small></span
            >
          </div>
          <button :disabled="disabled" @click="commitRange(0, durationMs)">选择整段</button>
        </header>
        <div class="lr-trim-mark-actions">
          <button :disabled="disabled" @click="setEdge('startMs', playhead)">
            <b>I</b><span>设为入点</span>
          </button>
          <button :disabled="disabled" @click="setEdge('endMs', playhead)">
            <b>O</b><span>设为出点</span>
          </button>
        </div>
        <div class="lr-trim-time-fields">
          <label
            >开始时间
            <div>
              <input
                type="number"
                aria-label="开始时间（秒）"
                min="0"
                :max="maxStart / 1000"
                step="0.001"
                :value="displayStart / 1000"
                :disabled="disabled"
                @change="changeTimeField('startMs', $event)"
              /><small>秒</small>
            </div>
          </label>
          <ArrowRight :size="16" />
          <label
            >结束时间
            <div>
              <input
                type="number"
                aria-label="结束时间（秒）"
                :min="minEnd / 1000"
                :max="durationMs / 1000"
                step="0.001"
                :value="displayEnd / 1000"
                :disabled="disabled"
                @change="changeTimeField('endMs', $event)"
              /><small>秒</small>
            </div>
          </label>
        </div>
        <div class="lr-trim-stats">
          <article>
            <small>范围时长</small
            ><b>{{ rangeValid ? `${(length / 1000).toFixed(3)} 秒` : '—' }}</b>
          </article>
          <article>
            <small>原片占比</small
            ><b>{{ rangeValid ? `${((length / durationMs) * 100).toFixed(1)}%` : '—' }}</b>
          </article>
        </div>
        <p v-if="!rangeValid" class="lr-trim-validation" role="status">
          入点和出点至少相隔 {{ LOCAL_REPLACE_LIMITS.minRangeMs / 1000 }} 秒，且都在视频时长内。
        </p>
      </aside>
    </div>
    <div class="lr-trim-timeline-panel">
      <header class="lr-trim-toolbar">
        <span><SlidersHorizontal :size="14" />范围选择</span>
        <button :disabled="!rangeValid" @click="playSelection"><Play :size="12" />播放选段</button>
        <button @click="scrub(startMs)"><RotateCcw :size="12" />回到入点</button><i />
        <p>拖动红色播放头预览，拖动蓝色手柄调整选段</p>
        <div>
          −
          <input
            v-model.number="zoom"
            aria-label="时间轴缩放"
            type="range"
            min="1"
            max="3"
            step="0.25"
          />
          ＋
        </div>
      </header>
      <div class="lr-trim-timeline-scroll">
        <div class="lr-trim-timeline-inner" :style="{ width: `${width + 104}px` }">
          <div class="lr-trim-ruler">
            <span>时间</span>
            <div :style="{ width: `${width}px` }" @click="scrub(timeAtPointer($event))">
              <button
                class="lr-playhead-grip"
                :style="{ left: ratio(playhead) }"
                type="button"
                role="slider"
                aria-label="播放头"
                aria-valuemin="0"
                :aria-valuemax="durationMs"
                :aria-valuenow="playhead"
                :aria-valuetext="time(playhead)"
                @click.stop
                @pointerdown.stop="startDrag($event, 'playhead')"
                @pointermove="moveDrag"
                @pointerup="finishDrag($event, true)"
                @lostpointercapture="finishDrag($event, false)"
                @keydown.left.prevent="scrub(playhead - 100)"
                @keydown.right.prevent="scrub(playhead + 100)"
                @keydown.home.prevent="scrub(0)"
                @keydown.end.prevent="scrub(durationMs)"
              />
              <i v-for="tick in ticks" :key="tick" :style="{ left: ratio(tick) }">{{
                time(tick)
              }}</i>
            </div>
          </div>
          <div class="lr-trim-track-row">
            <div class="lr-trim-track-label">
              <Film :size="18" /><span><b>视频轨</b><small>V1 · 原片</small></span>
            </div>
            <div
              ref="lane"
              class="lr-trim-track-lane"
              :style="{ width: `${width}px` }"
              @click="scrub(timeAtPointer($event))"
            >
              <div class="lr-trim-video-clip local-real-timeline-file">
                <small>{{ source.name }}</small>
              </div>
              <div
                v-if="rangeValid"
                class="lr-trim-selected"
                :style="{ left: ratio(displayStart), width: ratio(length) }"
              >
                <span>{{ (length / 1000).toFixed(3) }}s</span>
              </div>
              <button
                v-for="edge in ['startMs', 'endMs'] as const"
                :key="edge"
                class="lr-trim-handle"
                :class="[edge === 'startMs' ? 'start' : 'end', { overlapping: handlesOverlap }]"
                :style="{ left: ratio(edge === 'startMs' ? displayStart : displayEnd) }"
                :disabled="disabled"
                :aria-label="edge === 'startMs' ? '拖动入点' : '拖动出点'"
                @click.stop
                @pointerdown.stop="startDrag($event, edge)"
                @pointermove="moveDrag"
                @pointerup="finishDrag($event, true)"
                @lostpointercapture="finishDrag($event, false)"
                @keydown.left.prevent="setEdge(edge, (edge === 'startMs' ? startMs : endMs) - 100)"
                @keydown.right.prevent="setEdge(edge, (edge === 'startMs' ? startMs : endMs) + 100)"
              >
                <span>{{ edge === 'startMs' ? '入' : '出' }}</span
                >⋮
              </button>
              <i class="lr-playhead" :style="{ left: ratio(playhead) }" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.local-real-timeline-file {
  align-items: center;
  padding-inline: 12px;
  background: #e7effc;
  color: #395778;
}
.lr-trim-handle {
  touch-action: none;
}
.lr-trim-ruler {
  height: 44px;
}
.lr-trim-ruler i {
  padding-top: 24px;
}
.lr-playhead-grip {
  position: absolute;
  z-index: 4;
  top: 0;
  width: 36px;
  height: 32px;
  padding: 0;
  transform: translateX(-50%);
  border: 0;
  background: none;
  cursor: ew-resize;
  touch-action: none;
}
.lr-playhead-grip::before {
  position: absolute;
  inset: 5px 11px 13px;
  border-radius: 3px 3px 7px 7px;
  background: #dc2626;
  content: '';
}
.lr-playhead-grip::after {
  position: absolute;
  top: 18px;
  left: calc(50% - 1px);
  width: 2px;
  height: 26px;
  background: #ef4444;
  pointer-events: none;
  content: '';
}
</style>
