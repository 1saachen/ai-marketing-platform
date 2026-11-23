<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Library, LoaderCircle, Search } from '@lucide/vue';
import type { Asset } from '@ai-marketing/contracts';
import { safeApiErrorMessage } from '../../../api/http-client';
import { listAssets } from '../../../platform/asset/api/asset.api';
import AssetPreview from '../../../platform/asset/components/AssetPreview.vue';
import LocalReplaceDialog from './LocalReplaceDialog.vue';

const props = defineProps<{
  projectId: string;
  title: string;
  mimeTypes: readonly string[];
  maxBytes: number;
}>();
const emit = defineEmits<{ close: []; select: [asset: Asset] }>();
const assets = ref<Asset[]>([]);
const selectedId = ref('');
const selected = computed(() => assets.value.find((asset) => asset.id === selectedId.value));
const search = ref('');
const query = ref('');
const page = ref(1);
const pageCount = ref(1);
const loading = ref(false);
const error = ref('');
let request: AbortController | undefined;
const pageSize = 24;

async function load(nextPage: number) {
  request?.abort();
  const scope = new AbortController();
  request = scope;
  page.value = nextPage;
  loading.value = true;
  error.value = '';
  selectedId.value = '';
  assets.value = [];
  try {
    const result = await listAssets(
      props.projectId,
      { page: nextPage, pageSize, keyword: query.value },
      scope.signal,
    );
    if (scope.signal.aborted) return;
    pageCount.value =
      result.data.pagination?.pageCount ?? Math.max(1, Math.ceil(result.data.total / pageSize));
    assets.value = result.data.items.filter(
      (asset) =>
        asset.projectId === props.projectId &&
        (asset.status === 'AVAILABLE' ||
          (asset.status === 'PENDING_REVIEW' &&
            asset.storageWorkflow === 'FISSION' &&
            asset.workflowSpace === 'FISSION_LOCAL_REPLACE')) &&
        !!asset.currentVersion &&
        asset.hasFile &&
        asset.sizeBytes <= props.maxBytes &&
        props.mimeTypes.includes(asset.mimeType),
    );
  } catch (cause) {
    if (!scope.signal.aborted) error.value = safeApiErrorMessage(cause, '项目资产加载失败，请重试');
  } finally {
    if (!scope.signal.aborted) loading.value = false;
  }
}

function applySearch() {
  query.value = search.value.trim();
  void load(1);
}

watch(
  () => props.projectId,
  () => void load(1),
  { immediate: true },
);
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <LocalReplaceDialog
    :title="title"
    description="仅显示当前项目的可用文件，选用后会锁定该版本。"
    kind="local-real-library"
    @close="emit('close')"
  >
    <template #title-icon><Library :size="20" /></template>
    <div class="local-real-library-content">
      <form class="local-real-library-search" @submit.prevent="applySearch">
        <input v-model="search" aria-label="搜索项目资产" placeholder="搜索文件名称" />
        <button class="lr-btn" type="submit"><Search :size="15" />搜索</button>
      </form>
      <p v-if="loading" role="status"><LoaderCircle :size="17" />正在加载项目资产…</p>
      <p v-else-if="error" role="alert">
        {{ error }} <button class="lr-btn" @click="load(page)">重试</button>
      </p>
      <p v-else-if="!assets.length">此页没有符合条件的文件。可以搜索或切换页面。</p>
      <div v-else class="local-real-library-grid">
        <article
          v-for="asset in assets"
          :key="asset.id"
          :class="{ selected: selectedId === asset.id }"
        >
          <AssetPreview :asset="asset" compact file-preview />
          <button
            class="lr-btn"
            :aria-pressed="selectedId === asset.id"
            @click="selectedId = asset.id"
          >
            <b>{{ asset.name }}</b
            ><small>第 {{ asset.currentVersion }} 版</small>
          </button>
        </article>
      </div>
    </div>
    <template #footer>
      <span>第 {{ page }} / {{ pageCount }} 页</span>
      <button class="lr-btn" :disabled="loading || page <= 1" @click="load(page - 1)">
        上一页
      </button>
      <button class="lr-btn" :disabled="loading || page >= pageCount" @click="load(page + 1)">
        下一页
      </button>
      <button
        class="lr-btn primary"
        :disabled="!selected"
        @click="selected && emit('select', selected)"
      >
        使用所选文件
      </button>
    </template>
  </LocalReplaceDialog>
</template>

<style scoped>
.local-real-library-content {
  overflow: auto;
  padding: 16px 18px;
}
.local-real-library-search {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.local-real-library-search input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
}
.local-real-library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.local-real-library-grid article {
  display: grid;
  align-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.local-real-library-grid article.selected {
  border-color: var(--blue);
  background: #eff6ff;
}
.local-real-library-grid article > button {
  justify-content: space-between;
  gap: 5px;
  min-width: 0;
  width: 100%;
}
.local-real-library-grid article b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-real-library-grid article small {
  flex: none;
  color: var(--muted);
}
</style>
