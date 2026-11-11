<script setup lang="ts">
import { ref, watch } from 'vue';
import type {
  ProductionAsset,
  ProductionTask,
  ProductionVideoDocument,
} from '@ai-marketing/contracts';
import { safeApiErrorMessage } from '../../../api/http-client';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import { imageSource } from './production-asset-images';

type Reference = NonNullable<ProductionTask['renderReferences']>[number];
const props = defineProps<{
  projectId: string;
  tasks: ProductionTask[];
  document: ProductionVideoDocument;
  disabled: boolean;
}>();
defineEmits<{
  'select-clip': [id: string];
  prepare: [asset: ProductionAsset];
  workflow: [task: ProductionTask];
}>();
const preview = ref<Pick<ProductionAsset, 'id' | 'name' | 'kind' | 'image'> | null>(null);
watch(
  () => props.projectId,
  () => {
    preview.value = null;
  },
);
const clip = (task: ProductionTask) =>
  props.document.videoPlan.clips.find((c) => c.id === task.target?.id);
const index = (task: ProductionTask) =>
  props.document.videoPlan.clips.findIndex((c) => c.id === task.target?.id) + 1;
const reason = (task: ProductionTask) =>
  safeApiErrorMessage(new Error(task.errorMessage ?? ''), '本次视频生成未完成，请查看任务详情。');
function references(task: ProductionTask) {
  const refs = task.renderReferences ?? [];
  return refs.filter(
    (ref, index) =>
      refs.findIndex((other) => other.assetId === ref.assetId && other.version === ref.version) ===
      index,
  );
}
function owner(reference: Reference) {
  const object = props.document.assets.find((asset) => asset.id === reference.objectId);
  const source = object && imageSource(props.document.assets, object);
  return source?.id === (reference.sourceObjectId ?? reference.objectId) ? source : null;
}
function changed(reference: Reference) {
  const current = owner(reference)?.image;
  return (
    current && (current.assetId !== reference.assetId || current.version !== reference.version)
  );
}
function show(reference: Reference) {
  const current = props.document.assets.find(
    (asset) => asset.id === (reference.sourceObjectId ?? reference.objectId),
  );
  preview.value = {
    id: reference.sourceObjectId ?? reference.objectId,
    name: reference.sourceName ?? reference.name,
    kind: current?.kind ?? 'PROP',
    image: { assetId: reference.assetId, version: reference.version },
  };
}
</script>

<template>
  <section v-if="tasks.length" class="failed-renders" aria-label="需要处理的分镜">
    <article v-for="task in tasks" :key="task.id" class="failed-render">
      <header>
        <strong
          >{{ index(task) ? '分镜 ' + String(index(task)).padStart(2, '0') : '原分镜' }} ·
          {{ clip(task)?.title ?? '已移除' }}</strong
        >
        <div class="actions">
          <button
            type="button"
            :disabled="disabled || !clip(task)"
            @click="$emit('select-clip', task.target!.id)"
          >
            查看分镜
          </button>
          <button type="button" @click="$emit('workflow', task)">查看失败详情</button>
        </div>
      </header>
      <p class="failure-reason">{{ reason(task) }}</p>
      <details>
        <summary>
          本次参考图{{ task.renderReferences ? ' · ' + references(task).length + ' 张' : '' }}
        </summary>
        <div
          v-for="reference in references(task)"
          :key="reference.assetId + ':' + reference.version"
          class="reference"
        >
          <div class="reference-name">
            <strong>{{ reference.sourceName ?? reference.name }}</strong>
            <small v-if="reference.sourceName && reference.name !== reference.sourceName"
              >本镜引用 {{ reference.name }}</small
            >
            <small v-if="changed(reference)">当前资产图片已更新</small>
            <small v-else-if="!owner(reference)">请在当前分镜核对这项素材的归属</small>
          </div>
          <div class="actions">
            <button type="button" @click="show(reference)">查看本次图片</button>
            <button
              type="button"
              :disabled="disabled || !owner(reference)"
              @click="$emit('prepare', owner(reference)!)"
            >
              更换图片
            </button>
          </div>
        </div>
        <p v-if="!task.renderReferences" class="empty">
          本次用图记录暂不可用，请打开分镜核对当前素材。
        </p>
        <p v-else-if="!task.renderReferences.length" class="empty">本次任务使用文字提示词。</p>
      </details>
    </article>
    <WorkflowInformationDialog
      :open="!!preview"
      :title="preview?.name ?? '本次参考图'"
      @close="preview = null"
    >
      <ProductionAssetVisual v-if="preview" :asset="preview" :project-id="projectId" />
    </WorkflowInformationDialog>
  </section>
</template>

<style scoped>
.failed-renders {
  flex: 1 0 100%;
  min-width: 0;
  display: grid;
  gap: 10px;
}
.failed-render {
  min-width: 0;
  padding: 14px;
  border: 1px solid #eadbc6;
  border-radius: 10px;
  background: #fff;
}
header,
.reference {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
header > strong {
  color: #3e4654;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}
button {
  border: 1px solid #d9dfeb;
  border-radius: 7px;
  padding: 6px 10px;
  background: #fff;
  color: #42658e;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid #597db3;
  outline-offset: 3px;
}
.failure-reason {
  margin: 9px 0 11px;
  color: #9a503e;
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
summary {
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
}
.reference {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid #edf0f4;
}
.reference-name {
  display: grid;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  color: #536175;
  overflow-wrap: anywhere;
}
.reference-name small,
.empty {
  color: #7c8798;
  font-size: 11px;
  line-height: 1.6;
}
@media (max-width: 640px) {
  header,
  .reference {
    align-items: flex-start;
    flex-direction: column;
    gap: 9px;
  }
  .actions {
    width: 100%;
  }
  .failed-render {
    padding: 12px;
  }
}
</style>
