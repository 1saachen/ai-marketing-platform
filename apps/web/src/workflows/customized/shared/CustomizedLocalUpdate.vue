<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Check, CircleAlert, Image, LoaderCircle } from '@lucide/vue';
import { BaseButton } from '@ai-marketing/ui';
import type { CustomizedUpdateNode, CustomizedUpdatePreview } from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import { productionApi } from '../production/production.api';
import { isAbortError } from '../../../api/http-client';
import CustomizedUpdateTrigger from './CustomizedUpdateTrigger.vue';
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  nodes: CustomizedUpdateNode[];
  targetId?: string;
  subjectLabel?: string;
  executeLabel?: string;
  hideTrigger?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  execute: [preview: CustomizedUpdatePreview, imageAssetIds?: string[]];
  imagesRetained: [assetIds: string[]];
}>();
const open = ref(false),
  loading = ref(false),
  error = ref(''),
  preview = ref<CustomizedUpdatePreview | null>(null),
  selectedImages = ref<string[]>([]),
  retaining = ref(false),
  retentionError = ref(''),
  retainedCount = ref(0),
  selected = ref<CustomizedUpdateNode>(props.nodes[0]!);
let controller = new AbortController();
const labels: Record<CustomizedUpdateNode, string> = {
  INFORMATION_EXTRACTION: '信息提炼',
  SCRIPT: '脚本',
  ASSETS: '资产与图片',
  SHOTS: '分镜',
  PROMPT: '提示词',
  RENDER: '视频',
};
const hasImages = computed(() => !!preview.value?.calls.includes('IMAGE'));
const hasText = computed(() => !!preview.value?.calls.includes('TEXT'));
const imageOnly = computed(() => selected.value === 'ASSETS' && hasImages.value && !hasText.value);
const canExecute = computed(
  () =>
    !props.disabled &&
    !loading.value &&
    !retaining.value &&
    !!preview.value?.items.length &&
    !preview.value.blockers.length &&
    (!imageOnly.value || selectedImages.value.length > 0),
);
const confirmLabel = computed(
  () =>
    props.executeLabel ??
    (selected.value !== 'ASSETS'
      ? '开始更新'
      : hasImages.value
        ? hasText.value
          ? '更新资产和图片'
          : '更新所选图片'
        : '更新关联资产'),
);
const usageLabel = computed(() => {
  if (preview.value?.calls.includes('VIDEO')) return '本次将调用视频生成服务，可能产生费用。';
  if (hasImages.value)
    return hasText.value
      ? '本次将核对资产定义，并生成受影响的已有参考图，可能产生费用。'
      : '保留原图只保存你的选择。更新所选图片会调用生图服务，可能产生费用。';
  if (hasText.value) return '本次将调用文字模型，可能产生费用。';
  return '本次仅同步来源信息。';
});
async function load() {
  controller.abort();
  controller = new AbortController();
  const current = controller;
  loading.value = true;
  error.value = '';
  preview.value = null;
  selectedImages.value = [];
  retentionError.value = '';
  retainedCount.value = 0;
  try {
    const result = await productionApi.preview(
      props.projectId,
      props.workflowRunId,
      selected.value,
      props.targetId,
      current.signal,
    );
    if (current === controller) preview.value = result;
  } catch (e) {
    if (current === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '更新范围查询失败';
  } finally {
    if (current === controller) loading.value = false;
  }
}
function show() {
  if (props.disabled) return;
  selected.value = props.nodes[0]!;
  open.value = true;
  void load();
}
function close() {
  controller.abort();
  open.value = false;
  retaining.value = false;
}
function choose(node: CustomizedUpdateNode) {
  if (selected.value === node) return;
  selected.value = node;
  void load();
}
function execute() {
  if (!preview.value || !canExecute.value) return;
  const value = preview.value;
  const images = imageOnly.value ? [...selectedImages.value] : undefined;
  close();
  emit('execute', value, images);
}
async function retainImages() {
  if (!imageOnly.value || !canExecute.value || !preview.value) return;
  const current = controller;
  const assetIds = [...selectedImages.value];
  retaining.value = true;
  retentionError.value = '';
  try {
    const next = await productionApi.retainAssetImages(
      props.projectId,
      props.workflowRunId,
      { version: 1, fingerprint: preview.value.fingerprint, assetIds },
      current.signal,
    );
    if (current !== controller || current.signal.aborted) return;
    preview.value = next;
    selectedImages.value = [];
    retainedCount.value = assetIds.length;
    emit('imagesRetained', assetIds);
  } catch (e) {
    if (current === controller && !current.signal.aborted && !isAbortError(e))
      retentionError.value = e instanceof Error ? e.message : '暂时无法保存，请重试';
  } finally {
    if (current === controller) retaining.value = false;
  }
}
watch(() => [props.projectId, props.workflowRunId, props.targetId], close);
onBeforeUnmount(() => controller.abort());
defineExpose({ show });
</script>
<template>
  <CustomizedUpdateTrigger v-if="!hideTrigger" :disabled="disabled" @open="show" />
  <WorkflowInformationDialog
    :open="open"
    title="局部更新"
    description="按当前确认的资料查看更新范围"
    @close="!retaining && close()"
  >
    <div v-if="nodes.length > 1" class="update-choices" role="group" aria-label="选择更新内容">
      <button
        v-for="node in nodes"
        :key="node"
        type="button"
        :aria-pressed="selected === node"
        @click="choose(node)"
      >
        {{ labels[node] }}
      </button>
    </div>
    <p v-if="loading" class="update-state" role="status">
      <LoaderCircle class="update-spinner" :size="17" aria-hidden="true" />
      正在核对来源和更新范围…
    </p>
    <div v-else-if="error" class="update-state is-warning" role="alert">
      <CircleAlert :size="17" aria-hidden="true" />
      <span>{{ error }}</span>
      <BaseButton variant="secondary" @click="load">重新查询</BaseButton>
    </div>
    <div v-else-if="preview" class="update-preview">
      <slot name="context" :preview="preview" />
      <p v-if="retainedCount" class="update-state" role="status">
        <Check :size="17" aria-hidden="true" />已保留 {{ retainedCount }} 张原图
      </p>
      <div v-if="preview.blockers.length" class="update-state is-warning" role="alert">
        <CircleAlert :size="17" aria-hidden="true" />
        <ul class="update-blockers">
          <li v-for="blocker in preview.blockers" :key="blocker">{{ blocker }}</li>
        </ul>
      </div>
      <p v-if="!preview.items.length && !preview.blockers.length" class="update-state">
        <Check :size="17" aria-hidden="true" />
        {{ subjectLabel ?? '当前内容' }}无需更新
      </p>
      <template v-if="preview.items.length">
        <div class="update-scope">
          <h3>
            {{
              imageOnly
                ? '可核对的参考图'
                : preview.node === 'ASSETS' && hasText
                  ? '待核对的资产定义'
                  : '本次处理范围'
            }}
          </h3>
          <span>{{ preview.items.length }} 项</span>
        </div>
        <p v-if="preview.node === 'ASSETS' && hasText" class="update-description">
          系统会核对这些对象，找出实际需要修改的定义。
        </p>
        <p v-else-if="imageOnly" class="update-description">
          勾选需要处理的图片，再选择保留原图或更新所选图片。
        </p>
        <ul class="update-items">
          <li v-for="item in preview.items" :key="item.id">
            <label v-if="imageOnly" class="update-image-option">
              <input
                v-model="selectedImages"
                type="checkbox"
                :value="item.id"
                :disabled="retaining"
              />
              <strong>{{ item.name }}</strong>
            </label>
            <template v-else>
              <strong>{{ item.name }}</strong>
              <span>{{ item.reason }}</span>
            </template>
          </li>
        </ul>
        <div v-if="hasImages" class="update-state update-images">
          <Image :size="18" aria-hidden="true" />
          <div>
            <strong>{{ hasText ? '联动更新已有参考图' : '更新已有参考图' }}</strong>
            <p v-if="hasText">
              最多核对 {{ preview.assetImageCount }} 张。只在参考图实际要呈现的内容有变化时重做。
            </p>
            <p v-else>已选 {{ selectedImages.length }} 张。</p>
          </div>
        </div>
        <p class="update-description">{{ usageLabel }}</p>
      </template>
      <div v-if="retentionError" class="update-state is-warning" role="alert">
        <CircleAlert :size="17" aria-hidden="true" />
        <span>{{ retentionError }}</span>
        <BaseButton variant="secondary" @click="load">重新查看</BaseButton>
      </div>
    </div>
    <div class="update-actions">
      <BaseButton
        variant="secondary"
        :class="{ 'update-actions__dismiss': imageOnly }"
        :disabled="retaining"
        @click="close"
      >
        {{ preview && !preview.items.length ? '关闭' : '取消' }}
      </BaseButton>
      <BaseButton
        v-if="imageOnly"
        variant="secondary"
        :disabled="!canExecute"
        :loading="retaining"
        @click="retainImages"
        >保留原图</BaseButton
      >
      <BaseButton v-if="!preview || preview.items.length" :disabled="!canExecute" @click="execute">
        {{ confirmLabel }}
      </BaseButton>
    </div>
  </WorkflowInformationDialog>
</template>
<style scoped>
.update-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: fit-content;
  padding: 4px;
  margin-bottom: 18px;
  border: 1px solid #e1e9f3;
  border-radius: 10px;
  background: #f3f6fb;
}
.update-choices button {
  min-height: 36px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #536680;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.update-choices button[aria-pressed='true'] {
  border-color: #d9e5f5;
  background: #fff;
  color: #2455a4;
}
.update-choices button:focus-visible {
  outline: 2px solid #5388df;
  outline-offset: 2px;
}
.update-preview {
  display: grid;
  gap: 10px;
}
.update-state {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 12px;
  margin: 0;
  border-radius: 9px;
  background: #f3f7fd;
  color: #3b506b;
  font-size: 13px;
  line-height: 1.6;
}
.update-state svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.update-state.is-warning {
  background: #fff6e3;
  color: #7d4710;
}
.update-blockers {
  margin: 0;
  padding-inline-start: 16px;
}
.update-scope {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.update-scope h3 {
  margin: 0;
  font-size: 15px;
}
.update-scope span,
.update-description,
.update-images p {
  margin: 0;
  color: #5e7087;
  font-size: 13px;
  line-height: 1.55;
}
.update-items {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 0 12px;
  border: 1px solid #dfe8f4;
  border-radius: 10px;
  list-style: none;
}
.update-items li {
  display: grid;
  gap: 4px;
  padding: 10px 0;
  overflow-wrap: anywhere;
}
.update-items li + li {
  border-top: 1px solid #edf1f7;
}
.update-items strong {
  color: #23344d;
  font-size: 13px;
}
.update-items span {
  color: #5e7087;
  font-size: 12px;
}
.update-image-option {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
}
.update-image-option input {
  width: 16px;
  height: 16px;
  accent-color: #2563eb;
}
.update-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #e7edf6;
}
.update-actions__dismiss {
  margin-inline-end: auto;
}
.update-spinner {
  animation: update-spin 1s linear infinite;
}
@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .update-spinner {
    animation: none;
  }
}
</style>
