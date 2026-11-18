<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Asset, AssetType, CloneUploadRole } from '@ai-marketing/contracts';
import { LoaderCircle, Search } from '@lucide/vue';
import { listAssets } from '../../../platform/asset/api/asset.api';
import AssetPreview from '../../../platform/asset/components/AssetPreview.vue';
import { safeApiErrorMessage } from '../../../api/http-client';
import CloneDialog from './CloneDialog.vue';

const props = defineProps<{
  projectId: string;
  role?: CloneUploadRole;
  extensions?: string[];
  title?: string;
  assetTypes?: AssetType[];
  mimePrefixes?: string[];
  busy: boolean;
  operationError: string;
}>();
const emit = defineEmits<{ close: []; select: [assetId: string, version: number, asset: Asset] }>();
const assets = ref<Asset[]>([]);
const keyword = ref('');
const page = ref(1);
const pages = ref(1);
const loading = ref(false);
const error = ref('');
let controller: AbortController | undefined;
const items = computed(() =>
  assets.value.filter(
    (asset) =>
      asset.projectId === props.projectId &&
      asset.hasFile !== false &&
      (!props.assetTypes?.length || props.assetTypes.includes(asset.type)) &&
      (props.mimePrefixes?.length
        ? props.mimePrefixes.some((prefix) => asset.mimeType.startsWith(prefix))
        : props.role === 'REFERENCE'
          ? asset.mimeType.startsWith('video/')
          : props.role === 'PRODUCT'
            ? /^(image|video)\//.test(asset.mimeType)
            : true) &&
      (!props.extensions?.length ||
        props.extensions.some((extension) =>
          asset.originalFileName
            .toLowerCase()
            .endsWith('.' + extension.replace(/^\./, '').toLowerCase()),
        )),
  ),
);
async function load(reset = false) {
  if (reset) page.value = 1;
  controller?.abort();
  const request = new AbortController();
  controller = request;
  loading.value = true;
  error.value = '';
  try {
    const result = await listAssets(
      props.projectId,
      { keyword: keyword.value.trim(), status: 'AVAILABLE', page: page.value, pageSize: 24 },
      request.signal,
    );
    if (request.signal.aborted) return;
    assets.value = result.data.items;
    pages.value =
      result.data.pagination?.pageCount ?? Math.max(1, Math.ceil(result.data.total / 24));
  } catch (cause) {
    if (!request.signal.aborted)
      error.value = safeApiErrorMessage(cause, '项目资产加载失败，请重试');
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}
watch(
  () => [props.projectId, props.role, props.assetTypes, props.mimePrefixes],
  () => void load(true),
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <CloneDialog
    :title="
      title ||
      (role === 'REFERENCE'
        ? '选择项目参考视频'
        : role === 'PRODUCT'
          ? '选择项目商品素材'
          : '选择项目目标素材')
    "
    subtitle="引用所选资产的当前精确版本"
    wide
    @close="emit('close')"
  >
    <form class="clone-library-search" @submit.prevent="load(true)">
      <input
        v-model="keyword"
        aria-label="搜索项目素材"
        placeholder="搜索当前项目素材"
        :disabled="busy"
      /><button class="frg-btn" :disabled="loading || busy"><Search :size="15" />搜索</button>
    </form>
    <p class="clone-muted">仅显示当前项目可用素材；其他项目素材请先在项目资产库中导入。</p>
    <p v-if="operationError" class="clone-library-error" role="alert">{{ operationError }}</p>
    <p v-if="error" class="clone-library-error" role="alert">
      {{ error }}<button class="frg-btn" @click="load()">重试</button>
    </p>
    <div v-else-if="loading" class="clone-empty">
      <LoaderCircle class="clone-spin" />正在加载项目素材…
    </div>
    <div v-else-if="!items.length" class="clone-empty">
      此页没有可用的{{
        role === 'REFERENCE'
          ? '参考视频'
          : role === 'PRODUCT'
            ? '商品图片或视频'
            : '同类型目标素材'
      }}。
    </div>
    <div v-else class="clone-library-grid">
      <article v-for="asset in items" :key="asset.id">
        <div class="clone-library-preview">
          <audio
            v-if="asset.mimeType.startsWith('audio/')"
            controls
            preload="metadata"
            :src="asset.contentUrl"
            :aria-label="`试听${asset.name}`"
          />
          <AssetPreview v-else :asset="asset" compact file-preview />
        </div>
        <b>{{ asset.name }}</b
        ><small>{{
          asset.currentVersion ? `第 ${asset.currentVersion} 版` : '版本信息不可用'
        }}</small
        ><button
          class="frg-btn primary"
          :disabled="busy || !asset.currentVersion"
          @click="asset.currentVersion && emit('select', asset.id, asset.currentVersion, asset)"
        >
          {{ busy ? '正在引用…' : '使用此版本' }}
        </button>
      </article>
    </div>
    <template #footer
      ><span class="clone-muted">第 {{ page }} / {{ pages }} 页</span
      ><button
        class="frg-btn"
        :disabled="loading || busy || page <= 1"
        @click="
          page--;
          load();
        "
      >
        上一页</button
      ><button
        class="frg-btn"
        :disabled="loading || busy || page >= pages"
        @click="
          page++;
          load();
        "
      >
        下一页</button
      ><button class="frg-btn" @click="emit('close')">关闭</button></template
    >
  </CloneDialog>
</template>
<style scoped>
.clone-library-search {
  display: flex;
  gap: 10px;
}
.clone-library-search input {
  min-width: 0;
  flex: 1;
  padding: 9px 12px;
  border: 1px solid #dbe4f6;
  border-radius: 8px;
}
.clone-library-search button {
  display: flex;
  gap: 5px;
  align-items: center;
}
.clone-library-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.clone-library-grid article {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #dbe4f6;
  border-radius: 12px;
  min-width: 0;
}
.clone-library-grid b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.clone-library-grid small {
  color: #64748b;
}
.clone-library-preview {
  height: 140px;
  overflow: hidden;
  border-radius: 8px;
}
.clone-library-preview audio {
  width: 100%;
  margin-top: 42px;
}
.clone-library-error {
  color: #b42318;
}
@media (max-width: 720px) {
  .clone-library-grid {
    grid-template-columns: 1fr;
  }
}
</style>
