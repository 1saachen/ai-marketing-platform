<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  Download,
  Film,
  Library,
  LoaderCircle,
  Play,
  Upload,
} from '@lucide/vue';
import {
  LOCAL_REPLACE_LIMITS,
  LOCAL_REPLACE_NODES,
  LOCAL_REPLACE_SOURCE_MIME_TYPES,
  LOCAL_REPLACE_TARGET_MIME_TYPES,
  type Asset,
  type LocalReplaceAssetRef,
  type LocalReplaceNodeId,
  type LocalReplaceTask,
} from '@ai-marketing/contracts';
import { WorkflowRunProgress } from '@ai-marketing/ui';
import { safeApiErrorMessage } from '../../../api/http-client';
import { getAssetVersion, importAssets } from '../../../platform/asset/api/asset.api';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import LocalReplaceAssetLibrary from './LocalReplaceAssetLibrary.vue';
import LocalReplaceRange from './LocalReplaceRange.vue';
import { createLocalReplaceWorkspace, localReplaceTaskActive } from './local-replace-workspace';
import { localReplaceTime, seekLocalVideo } from './local-replace-media';
import './local-replace.css';

const props = defineProps<{ projectId: string; projectName: string }>();
const workspace = createLocalReplaceWorkspace();
const { state, taskActive, dirty } = workspace;
const draft = computed(() => state.draft);
const steps = ['选择成片', '选择时长范围', '范围解析与替换', '生成提示词', '渲染输出'];
const hints = [
  '选择当前项目中的成片，或导入一条短视频。',
  '拖动视频轨的入点和出点，选择要替换的区间。',
  '确认原片中要替换的对象并选择目标图片。',
  '检查替换说明，按需补充需要保留的细节。',
  '确认创建一条替换任务，完成后可播放和下载。',
];
const statuses = {
  QUEUED: '排队中',
  RUNNING: '处理中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
const stepIndex = computed(() =>
  draft.value ? LOCAL_REPLACE_NODES.indexOf(draft.value.nodeId) : 0,
);
const selectedTaskId = ref('');
const selectedTask = computed(
  () => state.data?.tasks.find((task) => task.id === selectedTaskId.value) ?? state.data?.tasks[0],
);
const sourceMetadata = ref({ durationMs: 0, width: 0, height: 0 });
const sourcePreviewError = ref(false);
const duration = computed(() => sourceMetadata.value.durationMs);
const picker = ref<'source' | 'target' | null>(null);
const importing = ref(false);
const importError = ref('');
const sourceInput = ref<HTMLInputElement>();
const targetInput = ref<HTMLInputElement>();
let importRequest: AbortController | undefined;

function useMedia(reference: () => LocalReplaceAssetRef | null | undefined) {
  const asset = ref<Asset | null>(null);
  const error = ref('');
  const refresh = ref(0);
  watch(
    [() => props.projectId, () => reference()?.assetId, () => reference()?.version, refresh],
    async ([projectId, assetId, version], _previous, onCleanup) => {
      const request = new AbortController();
      onCleanup(() => request.abort());
      asset.value = null;
      error.value = '';
      if (!projectId || !assetId || !version) return;
      try {
        const { data } = await getAssetVersion(projectId, assetId, version, request.signal);
        if (!request.signal.aborted) {
          if (
            data.id !== assetId ||
            data.projectId !== projectId ||
            data.currentVersion !== version
          )
            throw new Error('选定的文件版本暂不可读取');
          asset.value = data;
        }
      } catch (cause) {
        if (!request.signal.aborted) error.value = safeApiErrorMessage(cause, '文件版本暂不可读取');
      }
    },
    { immediate: true },
  );
  return {
    asset,
    error,
    reload: () => {
      refresh.value++;
    },
  };
}

const sourceMedia = useMedia(() => draft.value?.source);
const targetMedia = useMedia(() => draft.value?.target);
const original = useMedia(() => (selectedTask.value?.result ? selectedTask.value.source : null));
const source = sourceMedia.asset;
const target = targetMedia.asset;
const comparisonSource = original.asset;
const blocked = computed(() => state.acting || state.conflict || importing.value);
const mediaIssue = computed(() => {
  if (sourceMedia.error.value) return sourceMedia.error.value;
  if (sourcePreviewError.value) return '原片暂无法在浏览器预览，请更换可播放的视频。';
  const { durationMs, width, height } = sourceMetadata.value;
  if (!durationMs) return '';
  if (
    durationMs < LOCAL_REPLACE_LIMITS.minDurationMs ||
    durationMs > LOCAL_REPLACE_LIMITS.maxDurationMs
  )
    return '请选择 4–15 秒的参考视频。';
  if (width * 16 !== height * 9 && width * 9 !== height * 16)
    return '请选择 9:16 或 16:9 的参考视频。';
  return '';
});
const sourceReady = computed(
  () =>
    !!source.value &&
    duration.value > 0 &&
    !mediaIssue.value &&
    !!draft.value?.sourceRightsConfirmed,
);
const rangeValid = computed(
  () =>
    !!draft.value &&
    draft.value.endMs - draft.value.startMs >= LOCAL_REPLACE_LIMITS.minRangeMs &&
    draft.value.endMs <= duration.value,
);
const bindingReady = computed(() => !!target.value && !!draft.value?.objectDescription.trim());
const time = localReplaceTime;
const rangeLabel = computed(() =>
  draft.value ? `${time(draft.value.startMs)}–${time(draft.value.endMs)}` : '',
);
const canRender = computed(
  () =>
    sourceReady.value &&
    rangeValid.value &&
    bindingReady.value &&
    !blocked.value &&
    !taskActive.value,
);
const defaultInstruction = '保留原片的机位、运镜、主体动作、手部接触和其他物体。';
const objectLabels = { PRODUCT: '商品', PROP: '道具' } as const;

watch(
  () => props.projectId,
  (projectId) => {
    picker.value = null;
    importRequest?.abort();
    importing.value = false;
    importError.value = '';
    selectedTaskId.value = '';
    void workspace.open(projectId);
  },
  { immediate: true },
);
watch(source, () => {
  sourceMetadata.value = { durationMs: 0, width: 0, height: 0 };
  sourcePreviewError.value = false;
});
onBeforeUnmount(() => {
  importRequest?.abort();
  workspace.dispose();
});

function readSourceMetadata(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!Number.isFinite(video.duration)) {
    sourcePreviewError.value = true;
    return;
  }
  sourceMetadata.value = {
    durationMs: Math.round(video.duration * 1000),
    width: video.videoWidth,
    height: video.videoHeight,
  };
  if (!mediaIssue.value && draft.value?.startMs === 0 && draft.value.endMs === 0)
    workspace.edit({ endMs: duration.value });
}

function chooseAsset(role: 'source' | 'target', asset: Asset) {
  if (asset.projectId !== props.projectId || !asset.currentVersion || !draft.value) return;
  const reference = { assetId: asset.id, version: asset.currentVersion };
  const current = draft.value[role];
  importError.value = '';
  picker.value = null;
  if (reference.assetId === current?.assetId && reference.version === current.version) return;
  if (role === 'source') {
    workspace.edit({
      source: reference,
      startMs: 0,
      endMs: 0,
      sourceRightsConfirmed: false,
      target: null,
      objectType: 'PRODUCT',
      objectDescription: '',
      instruction: '',
    });
  } else {
    workspace.edit({ target: reference });
  }
}

async function importFile(role: 'source' | 'target', event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || blocked.value) return;
  const isSource = role === 'source';
  const allowed: readonly string[] = isSource
    ? LOCAL_REPLACE_SOURCE_MIME_TYPES
    : LOCAL_REPLACE_TARGET_MIME_TYPES;
  const max = isSource ? LOCAL_REPLACE_LIMITS.maxSourceBytes : LOCAL_REPLACE_LIMITS.maxTargetBytes;
  importError.value = '';
  if (!allowed.includes(file.type) || file.size < 1 || file.size > max) {
    importError.value = isSource
      ? '请选择限额内的 MP4 或 MOV 视频。'
      : '请选择 4 MiB 以内的 JPEG、PNG 或 WebP 图片。';
    return;
  }
  importRequest?.abort();
  const request = new AbortController();
  importRequest = request;
  importing.value = true;
  try {
    const { data } = await importAssets(
      props.projectId,
      [file],
      'FISSION',
      'FISSION_LOCAL_REPLACE',
      isSource ? 'SOURCE_VIDEO' : 'REFERENCE_SET',
      request.signal,
    );
    if (!request.signal.aborted) {
      if (!data[0]?.currentVersion) throw new Error('导入资产版本不可用');
      chooseAsset(role, data[0]);
    }
  } catch (cause) {
    if (!request.signal.aborted)
      importError.value = safeApiErrorMessage(cause, '导入项目资产失败，请重试');
  } finally {
    if (!request.signal.aborted) importing.value = false;
  }
}

function canEnter(index: number) {
  if (index === 4 && state.data?.tasks.length) return true;
  return (
    index === 0 ||
    (sourceReady.value && (index < 2 || (rangeValid.value && (index < 3 || bindingReady.value))))
  );
}

async function go(index: number) {
  const nodeId: LocalReplaceNodeId | undefined = LOCAL_REPLACE_NODES[index];
  if (!nodeId || blocked.value || !canEnter(index)) return;
  workspace.edit({
    nodeId,
    ...(index >= 3 &&
      bindingReady.value &&
      !draft.value?.instruction.trim() && {
        instruction: defaultInstruction,
      }),
  });
  await workspace.flushPendingEdits();
}

async function reload() {
  if (
    dirty.value &&
    !(await requestActionConfirmation({
      title: '重新加载草稿？',
      description: '当前编辑将用服务端保存的版本替换。',
      confirmLabel: '重新加载',
    }))
  )
    return;
  await workspace.open(props.projectId);
}

async function render() {
  if (!canRender.value) return;
  const snapshot = JSON.stringify(draft.value);
  const runId = state.data?.runId;
  if (
    !(await requestActionConfirmation({
      title: '开始局部替换？',
      description: `将替换 ${rangeLabel.value} 内选中的对象，提交一条视频生成任务。`,
      confirmLabel: '提交替换任务',
    }))
  )
    return;
  if (
    canRender.value &&
    runId === state.data?.runId &&
    snapshot === JSON.stringify(draft.value) &&
    (await workspace.create())
  )
    selectedTaskId.value = '';
}

async function changeTask(task: LocalReplaceTask, action: 'cancel' | 'retry') {
  if (
    action === 'retry' &&
    !(await requestActionConfirmation({
      title: '重试替换任务？',
      description: '重试沿用这条任务最初选择的原片、目标图片和区间。',
      confirmLabel: '确认重试',
    }))
  )
    return;
  if (state.data?.tasks.some((item) => item.id === task.id))
    await workspace.change(task.id, action);
}

defineExpose({
  flushPendingEdits: async () =>
    !importing.value && !state.acting && (await workspace.flushPendingEdits()),
  workflowRunId: computed(() => state.data?.runId ?? ''),
  draftRevision: computed(() => state.data?.draftRevision ?? null),
});
</script>

<template>
  <div class="lr-shell local-real" :aria-busy="state.loading || importing || state.acting">
    <section v-if="!projectId" class="lr-panel lr-analysis-empty">
      <Boxes :size="34" />
      <h2>请先绑定项目</h2>
      <p>从项目与资产选择一个项目后，即可编辑成片。</p>
    </section>
    <section v-else-if="state.loading" class="lr-panel lr-analysis-empty" role="status">
      <LoaderCircle :size="34" />
      <h2>正在加载局部元素替换…</h2>
    </section>
    <section v-else-if="!draft" class="lr-panel lr-analysis-empty" role="alert">
      <AlertTriangle :size="30" />
      <h2>{{ state.error || '局部元素替换暂不可用' }}</h2>
      <button class="lr-btn" @click="reload">重新加载</button>
    </section>
    <template v-else>
      <section class="lr-flow uwf-flow-card">
        <header>
          <div>
            <span>裂变类 · 局部元素替换</span>
            <h2>{{ steps[stepIndex] }}</h2>
          </div>
          <span role="status">{{
            state.saving ? '正在保存草稿…' : dirty ? '草稿有更新' : '草稿已保存'
          }}</span>
        </header>
        <div class="lr-nodes uwf-flow-track">
          <template v-for="(step, index) in steps" :key="step">
            <article
              :class="[
                'clickable',
                'uwf-flow-node',
                index === stepIndex ? 'current' : index < stepIndex ? 'done' : '',
              ]"
            >
              <button
                :disabled="blocked || !canEnter(index)"
                :aria-current="index === stepIndex ? 'step' : undefined"
                @click="go(index)"
              >
                <i
                  ><Check v-if="index < stepIndex" :size="14" /><template v-else>{{
                    index + 1
                  }}</template></i
                >
                <span
                  ><b>{{ step }}</b
                  ><small v-if="index === 4 && taskActive">任务进行中</small></span
                >
              </button>
            </article>
            <span v-if="index < 4" class="lr-arrow"><ArrowRight :size="15" /></span>
          </template>
        </div>
      </section>
      <div v-if="state.error || importError" class="local-real-alert" role="alert">
        <AlertTriangle :size="16" />{{ state.error || importError }}
        <button v-if="state.conflict" class="lr-btn" @click="reload">重新加载</button>
        <button
          v-else-if="dirty && !importError"
          class="lr-btn"
          @click="workspace.flushPendingEdits"
        >
          重试保存
        </button>
      </div>
      <div v-if="state.pollError" class="local-real-alert" role="alert">
        <AlertTriangle :size="16" />{{ state.pollError
        }}<button class="lr-btn" @click="workspace.refresh">刷新任务状态</button>
      </div>
      <section class="lr-panel">
        <header class="lr-panel-head">
          <div>
            <span>{{ String(stepIndex + 1).padStart(2, '0') }}</span>
            <div>
              <h2>{{ steps[stepIndex] }}</h2>
              <p>{{ hints[stepIndex] }}</p>
            </div>
          </div>
          <button
            v-if="stepIndex === 4"
            class="lr-btn primary"
            :disabled="!canRender"
            @click="render"
          >
            <Play :size="14" />开始渲染成片
          </button>
        </header>

        <video
          v-if="source && stepIndex !== 0 && !duration && !sourcePreviewError"
          class="local-real-metadata"
          :src="source.contentUrl"
          preload="metadata"
          tabindex="-1"
          aria-hidden="true"
          @loadedmetadata="readSourceMetadata"
          @error="sourcePreviewError = true"
        />
        <div v-if="stepIndex === 0" class="lr-source-layout">
          <article v-if="source" class="lr-video-card">
            <video
              :key="source.contentUrl"
              class="local-real-source-player"
              :src="source.contentUrl"
              preload="metadata"
              controls
              playsinline
              @loadedmetadata="readSourceMetadata"
              @error="sourcePreviewError = true"
            />
            <div>
              <small>{{ projectName }} · 第 {{ draft.source?.version }} 版</small>
              <h3>{{ source.name }}</h3>
              <p v-if="duration">
                {{ time(duration) }} · {{ sourceMetadata.width }} × {{ sourceMetadata.height }}
              </p>
              <label class="local-real-rights"
                ><input
                  type="checkbox"
                  :checked="draft.sourceRightsConfirmed"
                  :disabled="blocked"
                  @change="
                    workspace.edit({
                      sourceRightsConfirmed: ($event.target as HTMLInputElement).checked,
                    })
                  "
                />我已获得该成片的编辑使用权</label
              >
              <p v-if="mediaIssue" role="alert">{{ mediaIssue }}</p>
            </div>
          </article>
          <div v-else class="lr-analysis-empty lr-source-empty">
            <Film :size="36" />
            <h3>{{ draft.source ? mediaIssue || '正在读取所选版本…' : '尚未选择原成片' }}</h3>
            <button v-if="sourceMedia.error.value" class="lr-btn" @click="sourceMedia.reload">
              重试读取
            </button>
            <p v-else-if="!draft.source">支持 4–15 秒、9:16 或 16:9 的 MP4 或 MOV。</p>
          </div>
          <aside class="lr-source-actions">
            <button class="lr-btn primary" :disabled="blocked" @click="picker = 'source'">
              <Library :size="16" />从资产库选择
            </button>
            <button class="lr-btn" :disabled="blocked" @click="sourceInput?.click()">
              <Upload :size="16" />导入视频到项目
            </button>
          </aside>
        </div>

        <template v-else-if="stepIndex === 1">
          <LocalReplaceRange
            v-if="source && duration > 0 && !mediaIssue"
            :source="source"
            :duration-ms="duration"
            :start-ms="draft.startMs"
            :end-ms="draft.endMs"
            :range-valid="rangeValid"
            :disabled="blocked"
            @change="workspace.edit"
            @media-error="sourcePreviewError = true"
          />
          <div v-else class="lr-analysis-empty">
            <Film :size="26" />
            <p>{{ mediaIssue || '正在读取原片播放信息…' }}</p>
            <button class="lr-btn" @click="go(0)">返回选择成片</button>
          </div>
        </template>

        <div v-else-if="stepIndex === 2" class="local-real-binding">
          <section class="local-real-field-panel">
            <h3>原片对象 · {{ rangeLabel }}</h3>
            <video
              v-if="source"
              :src="source.contentUrl"
              controls
              preload="metadata"
              playsinline
              @loadedmetadata="
                seekLocalVideo($event.currentTarget as HTMLVideoElement, draft.startMs / 1000, 0)
              "
            />
            <label
              >对象类型<select
                :disabled="blocked"
                :value="draft.objectType"
                @change="
                  workspace.edit({
                    objectType:
                      ($event.target as HTMLSelectElement).value === 'PROP' ? 'PROP' : 'PRODUCT',
                  })
                "
              >
                <option value="PRODUCT">商品</option>
                <option value="PROP">道具</option>
              </select></label
            >
            <label
              >原片中要替换的{{ objectLabels[draft.objectType] }}
              <textarea
                :disabled="blocked"
                :maxlength="LOCAL_REPLACE_LIMITS.maxObjectDescriptionLength"
                :value="draft.objectDescription"
                :placeholder="
                  draft.objectType === 'PROP' ? '例如桌上靠近小瓶的方盒' : '例如手里拿起的粉色小瓶'
                "
                aria-describedby="local-replace-object-help"
                @input="
                  workspace.edit({
                    objectDescription: ($event.target as HTMLTextAreaElement).value,
                  })
                "
              />
            </label>
            <p id="local-replace-object-help">
              写出它在原片中的位置、颜色或动作。替换后的外观以目标图片为准。
            </p>
          </section>
          <section class="local-real-field-panel">
            <h3>目标{{ objectLabels[draft.objectType] }}图片</h3>
            <img v-if="target" :src="target.contentUrl" :alt="target.name" />
            <p v-if="target">{{ target.name }} · 第 {{ draft.target?.version }} 版</p>
            <p v-else-if="targetMedia.error.value" role="alert">
              {{ targetMedia.error.value }}
              <button class="lr-btn" @click="targetMedia.reload">重试读取</button>
            </p>
            <p v-else-if="draft.target">正在读取图片版本…</p>
            <p v-else>选择一张项目图片作为替换后的外观参考。</p>
            <div class="local-real-buttons">
              <button class="lr-btn primary" :disabled="blocked" @click="picker = 'target'">
                <Library :size="16" />选择目标图片
              </button>
              <button class="lr-btn" :disabled="blocked" @click="targetInput?.click()">
                <Upload :size="16" />导入图片到项目
              </button>
            </div>
          </section>
        </div>

        <div v-else-if="stepIndex === 3" class="lr-prompts local-real-prompts">
          <section class="local-real-field-panel">
            <h3>替换说明</h3>
            <p>
              {{ rangeLabel }} 内，将{{ objectLabels[draft.objectType] }}「{{
                draft.objectDescription
              }}」替换为「{{ target?.name || '所选目标图片' }}」中的对象。
            </p>
            <label
              >补充说明<textarea
                :disabled="blocked"
                :maxlength="LOCAL_REPLACE_LIMITS.maxInstructionLength"
                :value="draft.instruction"
                @input="
                  workspace.edit({ instruction: ($event.target as HTMLTextAreaElement).value })
                "
              />
            </label>
          </section>
          <aside class="local-real-field-panel">
            <h3>保留内容</h3>
            <p>输出沿用原音轨和选区以外的原片画面。</p>
          </aside>
        </div>

        <div v-else class="local-real-output">
          <div v-if="!selectedTask" class="lr-analysis-empty">
            <Film :size="36" />
            <h3>等待提交替换任务</h3>
            <p>本次替换区间为 {{ rangeLabel }}。</p>
          </div>
          <template v-else>
            <div v-if="state.data && state.data.tasks.length > 1" class="local-real-task-picker">
              <label
                >任务记录
                <select
                  :value="selectedTask.id"
                  @change="selectedTaskId = ($event.target as HTMLSelectElement).value"
                >
                  <option v-for="item in state.data.tasks" :key="item.id" :value="item.id">
                    {{ new Date(item.createdAt).toLocaleString('zh-CN') }} ·
                    {{ statuses[item.status] }}{{ item.stale ? ' · 旧方案' : '' }}
                  </option>
                </select>
              </label>
            </div>
            <WorkflowRunProgress
              :progress="selectedTask.progress"
              :summary="statuses[selectedTask.status]"
              :terminal="!localReplaceTaskActive(selectedTask)"
              action-label=""
            />
            <p v-if="selectedTask.message" role="status">{{ selectedTask.message }}</p>
            <p v-if="selectedTask.stale" class="local-real-alert">该任务使用此前确认的替换方案。</p>
            <div class="local-real-buttons">
              <button
                v-if="localReplaceTaskActive(selectedTask)"
                class="lr-btn"
                :disabled="blocked"
                @click="changeTask(selectedTask, 'cancel')"
              >
                取消任务
              </button>
              <button
                v-if="selectedTask.canRetry"
                class="lr-btn"
                :disabled="blocked || taskActive"
                @click="changeTask(selectedTask, 'retry')"
              >
                重试任务
              </button>
              <a
                v-if="selectedTask.result"
                class="lr-btn primary"
                :href="selectedTask.result.downloadUrl"
                ><Download :size="15" />下载替换成片</a
              >
            </div>
            <div v-if="selectedTask.result" :key="selectedTask.id" class="local-real-comparison">
              <section class="local-real-field-panel">
                <h3>原片</h3>
                <video
                  v-if="comparisonSource"
                  :src="comparisonSource.contentUrl"
                  controls
                  playsinline
                  preload="metadata"
                  @loadedmetadata="
                    seekLocalVideo(
                      $event.currentTarget as HTMLVideoElement,
                      selectedTask!.startMs / 1000,
                    )
                  "
                />
                <p v-else>{{ original.error.value || '正在读取这条任务引用的原片…' }}</p>
              </section>
              <section class="local-real-field-panel">
                <h3>替换成片</h3>
                <video
                  :src="selectedTask.result.contentUrl"
                  controls
                  playsinline
                  preload="metadata"
                  @loadedmetadata="
                    seekLocalVideo(
                      $event.currentTarget as HTMLVideoElement,
                      selectedTask!.startMs / 1000,
                    )
                  "
                />
              </section>
              <p>替换区间 {{ time(selectedTask.startMs) }}–{{ time(selectedTask.endMs) }}</p>
            </div>
          </template>
        </div>

        <footer class="lr-footer">
          <span v-if="stepIndex === 1">{{ rangeLabel }}</span
          ><span v-else />
          <div>
            <button
              v-if="stepIndex > 0"
              class="lr-btn"
              :disabled="blocked"
              @click="go(stepIndex - 1)"
            >
              上一步
            </button>
            <button
              v-if="stepIndex < 4"
              class="lr-btn primary"
              :disabled="blocked || !canEnter(stepIndex + 1)"
              @click="go(stepIndex + 1)"
            >
              下一步<ArrowRight :size="15" />
            </button>
          </div>
        </footer>
      </section>
      <input
        ref="sourceInput"
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov"
        hidden
        @change="importFile('source', $event)"
      />
      <input
        ref="targetInput"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        @change="importFile('target', $event)"
      />
      <LocalReplaceAssetLibrary
        v-if="picker"
        :key="picker"
        :project-id="projectId"
        :title="picker === 'source' ? '选择项目成片' : '选择项目目标图片'"
        :mime-types="
          picker === 'source' ? LOCAL_REPLACE_SOURCE_MIME_TYPES : LOCAL_REPLACE_TARGET_MIME_TYPES
        "
        :max-bytes="
          picker === 'source'
            ? LOCAL_REPLACE_LIMITS.maxSourceBytes
            : LOCAL_REPLACE_LIMITS.maxTargetBytes
        "
        @close="picker = null"
        @select="picker && chooseAsset(picker, $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.local-real-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid #edd9a7;
  border-radius: 10px;
  background: #fff9eb;
  color: #805b12;
}
.local-real-rights {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.local-real-source-player {
  width: 100%;
  max-height: 170px;
  background: #1d2b40;
  border-radius: 10px;
}
.local-real-field-panel {
  display: grid;
  min-width: 0;
  gap: 10px;
  align-content: start;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: #f7faff;
}
.local-real-field-panel h3,
.local-real-field-panel p {
  margin: 0;
  overflow-wrap: anywhere;
}
.local-real-field-panel label,
.local-real-task-picker label {
  display: grid;
  gap: 6px;
}
.local-real-field-panel select,
.local-real-task-picker select,
.local-real-field-panel textarea {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: white;
}
.local-real-field-panel textarea {
  min-height: 100px;
  resize: vertical;
}
.local-real-field-panel img,
.local-real-field-panel video {
  width: 100%;
  height: 236px;
  object-fit: contain;
  border-radius: 9px;
  background: #17243a;
}
.local-real-binding,
.local-real-comparison {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.local-real-binding,
.local-real-output {
  padding: 18px 24px;
}
.local-real-comparison {
  margin-top: 14px;
}
.local-real-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.local-real-task-picker {
  max-width: 440px;
}
.local-real-metadata {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.lr-nodes button:disabled {
  cursor: default;
  opacity: 0.68;
}
@media (max-width: 720px) {
  .local-real-binding,
  .local-real-comparison {
    grid-template-columns: 1fr;
  }
  .local-real-binding,
  .local-real-output {
    padding: 12px 14px;
  }
  .local-real-field-panel img,
  .local-real-field-panel video {
    height: 190px;
  }
}
</style>
