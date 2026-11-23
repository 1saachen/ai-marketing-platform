<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Archive, Download, Film, Play, RotateCcw, Sparkles } from '@lucide/vue';
import { WorkflowRunProgress } from '@ai-marketing/ui';
import {
  CLONE_GENERATION_LIMITS,
  CLONE_SHOT_REFERENCE_MODE,
  type CloneArtifactRef,
  type CloneGenerationCount,
  type CloneGenerationList,
  type CloneGenerationPreflight,
  type CloneGenerationTask,
} from '@ai-marketing/contracts';
import { safeApiErrorMessage } from '../../../api/http-client';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import CloneDialog from './CloneDialog.vue';
import { sameCloneContent } from './clone-content';
import {
  archiveCloneGeneration,
  changeCloneGeneration,
  createCloneGeneration,
  getCloneGeneration,
  preflightCloneGeneration,
} from './clone.api';

const props = defineProps<{
  projectId: string;
  runId: string;
  productName: string;
  mappingRef: CloneArtifactRef | null;
  enabled: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const page = ref(1);
const state = ref<CloneGenerationList>({
  items: [],
  batches: [],
  total: 0,
  active: false,
  pendingBatch: false,
});
const count = ref<CloneGenerationCount>(1);
const allowedCount = computed(
  () => state.value.maxCount ?? CLONE_GENERATION_LIMITS.maxUnplannedCount,
);
const loading = ref(true),
  mutating = ref(false);
const error = ref(''),
  notice = ref('');
const selected = ref('');
const preview = ref<CloneGenerationTask['artifact']>(null);
const chosen = computed(() => state.value.items.find((item) => item.id === selected.value));
const batches = computed(() => {
  const items = new Map(state.value.items.map((item) => [item.id, item]));
  return state.value.batches.map((batch) => ({
    ...batch,
    items: batch.taskIds.map((id) => items.get(id)!),
  }));
});
const pages = computed(() => Math.max(1, Math.ceil(state.value.total / 6)));
const alive = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let read = 0;
let pending:
  | {
      ref: CloneArtifactRef;
      count: CloneGenerationCount;
      mode: CloneGenerationPreflight['mode'];
      seconds: number;
      referenceFrames: number | undefined;
      id: string;
    }
  | undefined;
const statusLabel = {
  QUEUED: '排队中',
  RUNNING: '处理中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  PARTIAL: '部分完成',
};
const active = (task: CloneGenerationTask) => task.status === 'QUEUED' || task.status === 'RUNNING';
const downloadUrl = (url: string) => `${url}?download=true`;

async function load(requested = page.value) {
  clearTimeout(timer);
  const generation = ++read;
  page.value = requested;
  try {
    const result = await getCloneGeneration(props.projectId, props.runId, requested, alive.signal);
    if (generation !== read || alive.signal.aborted) return;
    if (state.value.active !== result.data.active) emit('changed');
    state.value = result.data;
    count.value = Math.min(count.value, allowedCount.value);
    if (!state.value.items.some((item) => item.id === selected.value)) selected.value = '';
  } catch (cause) {
    if (generation === read && !alive.signal.aborted)
      error.value = safeApiErrorMessage(cause, '无法读取成片任务');
  } finally {
    if (generation === read && !alive.signal.aborted) {
      loading.value = false;
      if (state.value.active) timer = setTimeout(() => void load(), 1500);
    }
  }
}
async function act(callback: () => Promise<void>) {
  if (mutating.value || alive.signal.aborted) return;
  mutating.value = true;
  error.value = '';
  notice.value = '';
  try {
    await callback();
  } catch (cause) {
    if (!alive.signal.aborted) error.value = safeApiErrorMessage(cause, '成片操作未完成');
  } finally {
    mutating.value = false;
  }
}
function generate() {
  if (!props.mappingRef || state.value.active || state.value.pendingBatch || !props.enabled) return;
  const sourceMapping = { ...props.mappingRef };
  void act(async () => {
    const request = {
      sourceMapping,
      count: count.value,
      audioMode: 'SILENT',
      transitionMode: 'CUT',
    } as const;
    const { data: plan } = await preflightCloneGeneration(
      props.projectId,
      props.runId,
      request,
      alive.signal,
    );
    if (alive.signal.aborted) return;
    const referenceFrames = plan.totalReferenceFrames;
    if (plan.mode === CLONE_SHOT_REFERENCE_MODE && !referenceFrames)
      throw new Error('预检未返回参考片段用量，请重新检查');
    const method =
      plan.mode === CLONE_SHOT_REFERENCE_MODE
        ? '每个镜头以对应原片片段为视频参考，按锁定切点合成，并对照同一时间点的原片和成片审片。'
        : plan.mode === 'SEEDANCE_2_0_SOURCE_EDIT'
          ? '按原片时间线编辑所选元素。'
          : '按确认报告的景别、构图、运镜与动作逐镜头生成，沿锁定切点合成。';
    const referenceUsage = referenceFrames
      ? `本批输入参考片段共 ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(
          (referenceFrames * plan.timeline.fpsDenominator) / plan.timeline.fpsNumerator,
        )} 秒。`
      : '';
    const batch =
      plan.count > CLONE_GENERATION_LIMITS.maxUnplannedCount
        ? '本批将规划并审核差异方案。首条通过审片后开始其余条目。'
        : '';
    const confirmed = await requestActionConfirmation({
      title: `生成 ${plan.count} 条复刻成片？`,
      description:
        `每条 ${plan.shots.length} 个镜头，输出 ${plan.ratio}、720p 静音成片。${method}` +
        referenceUsage +
        `本批请求渲染合计 ${plan.totalRenderSeconds} 秒。${batch}`,
      confirmLabel: '确认生成',
    });
    if (!confirmed || alive.signal.aborted || !sameCloneContent(props.mappingRef, sourceMapping))
      return;
    if (
      !pending ||
      pending.count !== request.count ||
      pending.mode !== plan.mode ||
      pending.seconds !== plan.totalRenderSeconds ||
      pending.referenceFrames !== referenceFrames ||
      !sameCloneContent(pending.ref, sourceMapping)
    )
      pending = {
        ref: sourceMapping,
        count: request.count,
        mode: plan.mode,
        seconds: plan.totalRenderSeconds,
        referenceFrames,
        id: crypto.randomUUID(),
      };
    await createCloneGeneration(
      props.projectId,
      props.runId,
      {
        ...request,
        idempotencyKey: pending.id,
        acceptedRenderSeconds: pending.seconds,
        ...(pending.referenceFrames !== undefined && {
          acceptedReferenceFrames: pending.referenceFrames,
        }),
      },
      alive.signal,
    );
    pending = undefined;
    emit('changed');
    await load(1);
  });
}
function change(taskId: string, action: 'cancel' | 'retry', wholeBatch = false) {
  void act(async () => {
    if (wholeBatch) {
      const confirmed = await requestActionConfirmation({
        title: '取消整批成片生成？',
        description: '本批待发布的结果将停止交付。此操作会取消整批任务。',
        confirmLabel: '取消批次',
      });
      if (!confirmed || alive.signal.aborted) return;
    }
    await changeCloneGeneration(props.projectId, props.runId, taskId, action, alive.signal);
    emit('changed');
    await load(action === 'retry' ? 1 : page.value);
  });
}
function archive(task: CloneGenerationTask) {
  const output = task.artifact;
  if (!output) return;
  void act(async () => {
    const { artifactId, revision, contentHash } = output;
    await archiveCloneGeneration(
      props.projectId,
      props.runId,
      task.id,
      { artifactId, revision, contentHash },
      alive.signal,
    );
    await load();
    notice.value = '成片已保存到当前项目资产库';
  });
}
onMounted(() => void load());
onBeforeUnmount(() => {
  alive.abort();
  clearTimeout(timer);
});
</script>

<template>
  <div class="clone-output">
    <section class="fco-summary">
      <div class="fco-summary-copy">
        <b>{{ productName || '复刻成片' }}</b>
        <span>720p · 静音硬切</span>
      </div>
      <div class="fco-summary-actions">
        <label class="clone-generation-count">
          生成数量
          <select
            v-model="count"
            class="fco-btn"
            :disabled="mutating || !enabled || state.active || state.pendingBatch"
          >
            <option v-for="option in allowedCount" :key="option" :value="option">
              {{ option }} 条
            </option>
          </select>
        </label>
        <button
          class="fco-btn primary"
          :disabled="
            loading || mutating || !mappingRef || !enabled || state.active || state.pendingBatch
          "
          @click="generate"
        >
          <Sparkles :size="14" />生成复刻成片
        </button>
        <a v-if="chosen?.artifact" class="fco-btn" :href="downloadUrl(chosen.artifact.contentUrl)"
          ><Download :size="14" />下载所选成片</a
        >
      </div>
    </section>
    <p v-if="!enabled" class="frg-note warn">成片生成服务尚未启用。</p>
    <p v-else-if="!mappingRef" class="frg-note warn">请先确认当前元素映射，再生成成片。</p>
    <p v-if="error" class="frg-note warn" role="alert">{{ error }}</p>
    <p v-if="notice" class="frg-note" role="status">{{ notice }}</p>
    <section class="fco-panel" aria-label="复刻成片任务">
      <div class="fco-toolbar">
        <b>成片任务</b><span class="count">{{ state.total }} 批</span>
        <span class="grow"></span>
        <button class="fco-btn" :disabled="mutating" @click="load()">
          <RotateCcw :size="14" />刷新
        </button>
      </div>
      <div v-if="loading" class="clone-empty" role="status">正在读取成片任务…</div>
      <div v-else-if="!batches.length" class="clone-empty">
        <Film :size="28" />
        <p>当前项目暂无成片任务。</p>
      </div>
      <template v-else>
        <section
          v-for="batch in batches"
          :key="batch.id"
          :aria-label="`成片批次 ${batch.count ?? batch.planning?.count ?? batch.items.length} 条`"
        >
          <div
            v-if="
              batch.planning ||
              batch.sample ||
              (batch.count ?? batch.items.length) > 1 ||
              batch.downloadUrl
            "
            class="fco-toolbar clone-generation-batch"
          >
            <b>同批 {{ batch.count ?? batch.planning?.count ?? batch.items.length }} 条</b>
            <span class="count">{{ statusLabel[batch.status] }}</span>
            <span class="grow"></span>
            <a v-if="batch.downloadUrl" class="fco-btn" :href="batch.downloadUrl">
              <Download :size="14" />下载整批 ZIP
            </a>
            <button
              v-if="batch.planning?.canRetry"
              class="fco-btn"
              :disabled="mutating || state.active"
              @click="change(batch.id, 'retry')"
            >
              重试规划
            </button>
            <button
              v-if="batch.canCancel"
              class="fco-btn"
              :disabled="mutating"
              @click="change(batch.id, 'cancel', true)"
            >
              取消批次
            </button>
          </div>
          <p v-if="batch.planning?.error" class="frg-note warn" role="alert">
            {{ batch.planning.error }}
          </p>
          <p
            v-else-if="batch.planning && (batch.status === 'QUEUED' || batch.status === 'RUNNING')"
            class="frg-note"
            role="status"
          >
            正在规划并审核批次差异，审核通过后开始生成镜头。
          </p>
          <p
            v-if="batch.sample"
            class="frg-note"
            :class="{ warn: batch.status === 'FAILED' }"
            role="status"
          >
            {{
              batch.status === 'FAILED'
                ? `首条验证未通过，其余 ${batch.sample.totalCount - 1} 条尚未开始。`
                : `正在生成并审核首条，通过后自动开始其余 ${batch.sample.totalCount - 1} 条。`
            }}
          </p>
          <div class="fco-list">
            <article v-for="(item, index) in batch.items" :key="item.id" class="fco-card">
              <input
                v-model="selected"
                type="radio"
                name="clone-generation-selection"
                :value="item.id"
                :disabled="!item.artifact"
                :aria-label="`选择复刻成片${batch.items.length > 1 ? ` ${index + 1}` : ''}`"
              />
              <button
                class="fco-thumb"
                :disabled="!item.artifact"
                aria-label="播放成片"
                @click="preview = item.artifact"
              >
                <span><Play :size="17" /></span
                ><small v-if="item.artifact"
                  >{{ (item.artifact.durationMs / 1000).toFixed(2) }} 秒</small
                >
              </button>
              <div class="fco-main">
                <div class="fco-name-row">
                  <strong>复刻成片{{ batch.items.length > 1 ? ` ${index + 1}` : '' }}</strong>
                  <span
                    class="fco-status"
                    :class="
                      item.artifact?.freshness === 'STALE' ? 'pending' : item.status.toLowerCase()
                    "
                  >
                    {{
                      item.artifact?.freshness === 'STALE'
                        ? '旧版本'
                        : item.status === 'SUCCEEDED' && !item.artifact && batch.items.length > 1
                          ? '通过 · 待整批完成'
                          : statusLabel[item.status]
                    }}
                  </span>
                </div>
                <div class="fco-meta">
                  {{ new Date(item.createdAt).toLocaleString('zh-CN') }}
                  <template v-if="item.artifact"> · {{ item.artifact.ratio }} · 720p</template>
                </div>
                <WorkflowRunProgress
                  v-if="active(item)"
                  :progress="item.progress"
                  :summary="item.message"
                  action-label=""
                />
                <details v-if="item.reviewIssues?.length" class="clone-generation-review">
                  <summary>
                    审片未通过 · 镜头
                    {{ item.reviewIssues.map((issue) => issue.shotNumber).join('、') }}
                  </summary>
                  <ul>
                    <li v-for="issue in item.reviewIssues" :key="issue.shotNumber">
                      <strong>
                        镜头 {{ issue.shotNumber }} ·
                        {{ issue.verdict === 'WARNING' ? '证据不足' : '未通过' }}
                      </strong>
                      <p>{{ issue.reason }}</p>
                      <small>成片帧号 {{ issue.evidenceFrames.join('、') }}</small>
                    </li>
                  </ul>
                </details>
                <p v-else-if="item.error" class="clone-generation-error">{{ item.error }}</p>
                <div class="fco-actions">
                  <button
                    v-if="batch.items.length === 1 && !batch.sample && active(item)"
                    :disabled="mutating"
                    @click="change(item.id, 'cancel')"
                  >
                    取消任务
                  </button>
                  <button
                    v-if="item.canRetry"
                    :disabled="
                      mutating ||
                      state.active ||
                      !enabled ||
                      (state.pendingBatch && batch.items.length === 1 && !batch.sample)
                    "
                    @click="change(item.id, 'retry')"
                  >
                    重试
                  </button>
                  <template v-if="item.artifact">
                    <a class="fco-btn" :href="downloadUrl(item.artifact.contentUrl)"
                      ><Download :size="13" />下载</a
                    >
                    <button :disabled="mutating || item.artifact.archived" @click="archive(item)">
                      <Archive :size="13" />{{
                        item.artifact.archived ? '已保存' : '保存到项目资产库'
                      }}
                    </button>
                  </template>
                </div>
              </div>
            </article>
          </div>
        </section>
      </template>
      <div v-if="pages > 1" class="fco-pagination">
        <button class="fco-btn" :disabled="page === 1 || mutating" @click="load(page - 1)">
          上一页
        </button>
        <span>第 {{ page }} / {{ pages }} 页</span>
        <button class="fco-btn" :disabled="page >= pages || mutating" @click="load(page + 1)">
          下一页
        </button>
      </div>
    </section>
    <CloneDialog v-if="preview" title="复刻成片预览" @close="preview = null">
      <video class="clone-generation-preview" :src="preview.contentUrl" controls playsinline />
    </CloneDialog>
  </div>
</template>

<style scoped>
.clone-generation-count {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.clone-generation-batch {
  border-top: 1px solid var(--line-soft, #e4eaf3);
}
.fco-actions a {
  text-decoration: none;
}
.clone-generation-error {
  color: #9f2a3a;
  margin: 8px 0;
  font-size: 12px;
}
.clone-generation-review {
  margin-top: 6px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.clone-generation-review summary {
  width: fit-content;
  padding: 4px 2px;
  color: #9f2a3a;
  cursor: pointer;
}
.clone-generation-review ul {
  display: grid;
  gap: 8px;
  margin: 4px 0 8px;
  padding: 0;
  list-style: none;
}
.clone-generation-review p {
  margin: 2px 0;
  line-height: 1.5;
}
.clone-generation-review small {
  color: var(--text-muted, #64748b);
}
.clone-generation-preview {
  display: block;
  margin: auto;
  max-width: 100%;
  max-height: 66vh;
}
.fco-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding: 12px;
}
</style>
