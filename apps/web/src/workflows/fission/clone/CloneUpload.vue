<script setup lang="ts">
import { computed } from 'vue';
import { Play, Upload, Plus, X, Info } from '@lucide/vue';
import type { CloneCapabilities, CloneInputDraft, CloneUpload } from '@ai-marketing/contracts';
import CloneIcon from './CloneIcon.vue';

const props = defineProps<{
  draft: CloneInputDraft;
  uploads: CloneUpload[];
  capabilities: CloneCapabilities;
  busy: boolean;
}>();
const emit = defineEmits<{
  reference: [files: File[]];
  materials: [files: File[]];
  remove: [id: string];
  preview: [file: CloneUpload];
  edit: [patch: Partial<CloneInputDraft>];
  library: [role: 'REFERENCE' | 'PRODUCT'];
}>();
const reference = computed(() =>
  props.uploads.find((file) => file.id === props.draft.referenceUploadId),
);
const materials = computed(() =>
  props.draft.productUploadIds.flatMap((id) => {
    const file = props.uploads.find((item) => item.id === id);
    return file ? [file] : [];
  }),
);
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const duration = (milliseconds: number | null) =>
  milliseconds === null ? '' : `${(milliseconds / 1000).toFixed(1)} 秒`;
function select(event: Event, role: 'reference' | 'materials') {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!props.busy && files.length) {
    if (role === 'reference') emit('reference', files);
    else emit('materials', files);
  }
}
function drop(event: DragEvent, role: 'reference' | 'materials') {
  if (!props.busy && event.dataTransfer?.files.length) {
    if (role === 'reference') emit('reference', Array.from(event.dataTransfer.files));
    else emit('materials', Array.from(event.dataTransfer.files));
  }
}
</script>
<template>
  <div class="frg-body">
    <div class="frg-source-grid">
      <section class="frg-card" @dragover.prevent @drop.prevent="drop($event, 'reference')">
        <header class="frg-card-head">
          <b>爆款参考视频</b><span class="frg-required">必填</span><span class="grow" /><button
            class="frg-btn"
            :disabled="busy"
            @click="emit('library', 'REFERENCE')"
          >
            项目资产
          </button>
        </header>
        <div v-if="reference" class="frg-video-card">
          <video
            class="clone-reference-preview"
            controls
            :src="reference.contentUrl"
            preload="metadata"
          />
          <div class="frg-video-meta">
            <div>
              <b>{{ reference.originalFileName }}</b
              ><small
                >{{ size(reference.sizeBytes) }} · {{ duration(reference.media.durationMs) }} ·
                {{ reference.media.width }} × {{ reference.media.height }}</small
              >
            </div>
            <label class="frg-btn file-button"
              >更换<input
                type="file"
                :disabled="busy"
                :accept="
                  capabilities.referenceExtensions
                    .map((ext) => '.' + ext.replace(/^\./, ''))
                    .join(',')
                "
                @change="select($event, 'reference')"
            /></label>
            <button class="frg-btn danger" :disabled="busy" @click="emit('remove', reference.id)">
              删除
            </button>
          </div>
        </div>
        <label
          v-else
          class="frg-drop"
          tabindex="0"
          @keydown.enter="($event.currentTarget as HTMLElement).querySelector('input')?.click()"
        >
          <input
            type="file"
            :disabled="busy"
            :accept="
              capabilities.referenceExtensions.map((ext) => '.' + ext.replace(/^\./, '')).join(',')
            "
            @change="select($event, 'reference')"
          />
          <span class="frg-drop-icon"><Upload /></span><b>上传爆款参考视频</b>
          <p>
            {{ capabilities.referenceExtensions.join(' / ').toUpperCase() }} ·
            {{ capabilities.limits.maxVideoDurationMs / 1000 }} 秒以内
          </p>
          <em>选择视频或拖拽至此 · 最大 {{ size(capabilities.limits.maxReferenceBytes) }}</em>
        </label>
        <div class="clone-source-rights">
          <label
            ><input
              type="checkbox"
              :checked="draft.sourceRightsConfirmed"
              :disabled="busy"
              @change="
                emit('edit', { sourceRightsConfirmed: ($event.target as HTMLInputElement).checked })
              "
            />我有权使用上传的参考视频与商品素材</label
          >
        </div>
      </section>
      <section class="frg-card" @dragover.prevent @drop.prevent="drop($event, 'materials')">
        <header class="frg-card-head">
          <b>商品原料</b><span class="frg-optional">当前商品</span><span class="grow" /><button
            class="frg-btn"
            :disabled="busy"
            @click="emit('library', 'PRODUCT')"
          >
            项目资产
          </button>
        </header>
        <div class="clone-product-fields">
          <label
            ><span>商品名称 <b>*</b></span
            ><input
              :value="draft.productName"
              maxlength="200"
              :disabled="busy"
              placeholder="填写本次复刻的目标商品"
              @input="emit('edit', { productName: ($event.target as HTMLInputElement).value })"
          /></label>
          <label
            ><span>商品事实与依据 <b>*</b></span
            ><textarea
              :value="draft.productFacts"
              rows="4"
              maxlength="20000"
              :disabled="busy"
              placeholder="填写有资料依据的特点、规格、原料或使用方式，注明对应素材。"
              @input="emit('edit', { productFacts: ($event.target as HTMLTextAreaElement).value })"
            />
          </label>
          <div class="clone-pid-unavailable">
            <span>商品链接 / PID 自动取材</span><button class="frg-btn" disabled>暂不可用</button
            ><small>尚未接入商品数据源，请上传商品素材。</small>
          </div>
        </div>
        <label
          class="frg-material-uploader"
          tabindex="0"
          @keydown.enter="($event.currentTarget as HTMLElement).querySelector('input')?.click()"
        >
          <input
            type="file"
            multiple
            :disabled="busy"
            :accept="
              capabilities.productExtensions.map((ext) => '.' + ext.replace(/^\./, '')).join(',')
            "
            @change="select($event, 'materials')"
          /><span><Plus :size="20" /></span>
          <div>
            <b>批量上传商品图片或展示视频</b
            ><small
              >最多 {{ capabilities.limits.maxProductFiles }} 份 · 单文件最大
              {{ size(capabilities.limits.maxProductBytes) }}</small
            >
          </div>
        </label>
        <div class="frg-materials">
          <article v-for="file in materials" :key="file.id" class="frg-material">
            <button
              class="frg-material-thumb"
              :class="{ video: file.mimeType.startsWith('video/') }"
              :aria-label="`预览${file.originalFileName}`"
              @click="emit('preview', file)"
            >
              <img
                v-if="file.mimeType.startsWith('image/')"
                :src="file.contentUrl"
                :alt="file.originalFileName"
              /><Play v-else :size="26" />
            </button>
            <button
              class="frg-material-remove"
              :disabled="busy"
              :aria-label="`移除${file.originalFileName}`"
              @click="emit('remove', file.id)"
            >
              <X :size="12" />
            </button>
            <div class="frg-material-info">
              <b :title="file.originalFileName">{{ file.originalFileName }}</b
              ><small
                >{{ file.media.width }} × {{ file.media.height }} ·
                {{ size(file.sizeBytes) }}</small
              >
              <div class="frg-material-tags">
                <span>{{ file.mimeType.startsWith('video/') ? '商品视频' : '商品图片' }}</span>
              </div>
            </div>
          </article>
          <div v-if="!materials.length" class="frg-note warn">
            <CloneIcon type="image" :size="16" />添加商品多角度素材，有助于后续准确替换。
          </div>
        </div>
      </section>
    </div>
    <div class="frg-note">
      <Info
        :size="15"
      />上传内容保存为当前项目的工作区文件；点击“确认并下一步”后提交输入，供后续拆解使用。
    </div>
  </div>
</template>
<style scoped>
.frg-video-card .clone-reference-preview {
  object-fit: contain;
  background: #172235;
}
.clone-product-fields {
  display: grid;
  gap: 14px;
  padding: 18px 20px 0;
}
.clone-product-fields label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  color: #475569;
}
.clone-product-fields label b {
  color: #dc2626;
}
.clone-product-fields input,
.clone-product-fields textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #dbe4f6;
  border-radius: 8px;
  padding: 10px 12px;
  font: inherit;
  color: #334155;
  background: white;
  resize: vertical;
}
.clone-pid-unavailable {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 12px;
  color: #64748b;
}
.clone-pid-unavailable small {
  width: 100%;
}
.clone-source-rights {
  padding: 0 20px 20px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.7;
}
.clone-source-rights label {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.clone-source-rights input {
  margin-top: 5px;
}
</style>
