<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertTriangle,
  Boxes,
  Check,
  LoaderCircle,
  ScanLine,
  Sparkles,
  RotateCw,
} from '@lucide/vue';
import {
  normalizeCloneInputDraft,
  type CloneUpload as CloneUploadFile,
  type CloneUploadRole,
} from '@ai-marketing/contracts';
import { useProjectContext } from '../../../platform/project/project-context';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import EffectWorkflowCanvas from '../../effect/source-import/components/EffectWorkflowCanvas.vue';
import CloneUpload from './CloneUpload.vue';
import CloneDialog from './CloneDialog.vue';
import CloneAssetPicker from './CloneAssetPicker.vue';
import CloneRealReport from './CloneRealReport.vue';
import CloneRealMapping from './CloneRealMapping.vue';
import CloneRealGeneration from './CloneRealGeneration.vue';
import CloneTaskPanel from './CloneTaskPanel.vue';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowEditingBanner from '../../../platform/workflow/components/WorkflowEditingBanner.vue';
import { createCloneWorkspace } from './clone-workspace';
import { sameCloneContent } from './clone-content';

const { currentProject } = useProjectContext();
const workspace = createCloneWorkspace();
const { state } = workspace;
const preview = ref<CloneUploadFile | null>(null);
const assetRole = ref<CloneUploadRole | null>(null);
const busy = computed(
  () => state.mutating || state.loading || !state.workspace?.capabilities.inputEnabled,
);
const inputCurrent = computed(
  () =>
    !!state.workspace?.input &&
    sameCloneContent(
      normalizeCloneInputDraft(state.draft),
      normalizeCloneInputDraft(state.workspace.input.input),
    ),
);
const g2 = computed(() => state.workspace?.g2);
const taskActive = computed(
  () =>
    !!g2.value?.generationActive ||
    (g2.value?.tasks.some((task) => task.status === 'QUEUED' || task.status === 'RUNNING') ??
      false),
);
const analysisCurrent = computed(() => g2.value?.analysis?.freshness === 'CURRENT');
const mappingSourceCurrent = computed(
  () =>
    analysisCurrent.value &&
    sameCloneContent(state.mappingDraft.sourceInput, state.workspace?.input?.ref) &&
    sameCloneContent(state.mappingDraft.sourceAnalysis, g2.value?.analysis?.ref),
);
const mappingCurrent = computed(
  () =>
    g2.value?.mapping?.freshness === 'CURRENT' &&
    sameCloneContent(g2.value.mapping.mapping, state.mappingDraft),
);
const hasOldPropReplacement = computed(() =>
  state.mappingDraft.bindings.some(
    (binding) => binding.type === 'prop' && binding.action === 'REPLACE',
  ),
);
const displayedReport = computed(() =>
  state.analysisEditing ? state.analysisDraft.report : g2.value?.analysis?.report,
);
const analysisEditDiverged = computed(
  () =>
    g2.value?.analysisDraftDiverged ||
    (state.analysisEditing &&
      !!g2.value?.analysis &&
      state.analysisDraft.baseAnalysisRevision !== g2.value.analysis.ref.revision),
);
const reference = computed(() =>
  state.workspace?.input?.files.find((file) => file.role === 'REFERENCE'),
);
const completedSteps = computed(() =>
  [
    inputCurrent.value ? 0 : -1,
    analysisCurrent.value ? 1 : -1,
    mappingCurrent.value ? 2 : -1,
  ].filter((step) => step >= 0),
);
const sourceBar = computed(() =>
  state.step === 1
    ? {
        title: '六维拆解报告',
        revision: g2.value?.analysis?.ref.revision,
        stale: g2.value?.analysis?.freshness === 'STALE',
        empty: '尚未生成报告',
      }
    : state.step === 2
      ? {
          title: '元素映射配置',
          revision: g2.value?.mapping?.ref.revision,
          stale: g2.value?.mapping?.freshness === 'STALE',
          empty: '尚未确认映射',
        }
      : {
          title: '参考视频',
          revision: state.workspace?.input?.ref.revision,
          stale: false,
          empty: '尚未确认输入',
        },
);
const nodeDefinitions = [
  ['上传素材', '选择参考视频并确认使用权'],
  ['深度拆解', '六维拆解，逐镜头记录景别、构图、运镜与动作'],
  ['元素映射', '绑定目标商品，沿用原片镜头顺序与节奏'],
  ['成片生成', '逐镜头复刻，按原片切点合成'],
];
const nodes = computed(() =>
  nodeDefinitions.map(([title, description], index) => ({
    label: title!,
    title: title!,
    description: description!,
    status:
      index === 0
        ? inputCurrent.value
          ? '已确认'
          : '待确认'
        : index === 1
          ? g2.value?.analysis?.freshness === 'STALE'
            ? '待更新'
            : analysisCurrent.value
              ? '已完成'
              : state.workspace?.capabilities.analysisEnabled
                ? '待拆解'
                : '待开放'
          : index === 2
            ? g2.value?.mapping?.freshness === 'STALE'
              ? '待更新'
              : mappingCurrent.value
                ? '已确认'
                : state.workspace?.capabilities.mappingEnabled
                  ? '待映射'
                  : '待开放'
            : g2.value?.generationActive
              ? '生成中'
              : state.workspace?.capabilities.generationEnabled
                ? '可生成'
                : '待开放',
  })),
);
const canConfirm = computed(
  () =>
    !busy.value &&
    !taskActive.value &&
    !!state.draft.referenceUploadId &&
    state.draft.sourceRightsConfirmed &&
    !state.conflict,
);
const canNext = computed(() =>
  state.step === 0
    ? canConfirm.value
    : state.step === 1
      ? analysisCurrent.value && !state.analysisEditing && !state.conflict && !busy.value
      : state.step === 2
        ? mappingSourceCurrent.value &&
          !hasOldPropReplacement.value &&
          !state.conflict &&
          !busy.value &&
          !taskActive.value
        : false,
);
const draftStatus = computed(() =>
  state.saving
    ? '正在保存草稿…'
    : state.conflict
      ? '保存冲突 · 编辑已保留'
      : workspace.dirty()
        ? '尚有未保存编辑'
        : '草稿已保存',
);
watch(
  () => currentProject.value?.id ?? '',
  (id) => {
    preview.value = null;
    assetRole.value = null;
    void workspace.open(id);
  },
  { immediate: true },
);
onBeforeUnmount(workspace.dispose);
async function reload() {
  if (
    workspace.dirty() &&
    !(await requestActionConfirmation({
      title: '重新加载服务端草稿？',
      description: '当前未保存的编辑将被服务端内容替换，请先保留需要的内容。',
      confirmLabel: '重新加载',
    }))
  )
    return;
  await workspace.open(currentProject.value?.id ?? '');
}
async function next() {
  if (state.step === 0 && (await workspace.confirm())) await workspace.go(1);
  else if (state.step === 1 && analysisCurrent.value) await workspace.go(2);
  else if (state.step === 2 && canNext.value && (await workspace.confirmMapping()))
    await workspace.go(3);
}
async function resetMapping() {
  if (
    state.mappingDraft.bindings.length &&
    !(await requestActionConfirmation({
      title: '按当前报告重置映射？',
      description: '当前映射草稿将替换为最新报告的元素与锁定结构；已确认映射仍保留至下次确认。',
      confirmLabel: '重置映射',
    }))
  )
    return;
  if (workspace.resetMapping()) await workspace.save();
}
async function adoptSuggestion(taskId: string) {
  if (
    !(await requestActionConfirmation({
      title: '采用这份映射建议？',
      description: '当前映射草稿将被建议替换。采用后仍需逐项检查并确认，不会直接生成成片。',
      confirmLabel: '采用建议',
    }))
  )
    return;
  await workspace.adoptSuggestion(taskId);
}
async function selectAsset(assetId: string, version: number) {
  const role = assetRole.value;
  if (role && (await workspace.importAsset(assetId, version, role))) assetRole.value = null;
}
defineExpose({
  flushPendingEdits: workspace.flushPendingEdits,
  workflowRunId: computed(() => state.workspace?.run.id ?? ''),
  cloneDraftRevision: computed(() => state.workspace?.draft.revision ?? null),
  cloneDraftRevisions: computed(() => (state.workspace ? workspace.draftRevisions() : null)),
  resumeWorkflowNode: workspace.resumeWorkflowNode,
});
</script>
<template>
  <div class="clone-studio" :aria-busy="state.loading || state.mutating">
    <div v-if="!currentProject" class="clone-empty">
      <Boxes :size="32" />
      <h3>请先绑定项目</h3>
      <p>从“项目与资产”进入项目，或新建项目后上传参考视频。</p>
    </div>
    <div v-else-if="state.loading" class="clone-empty">
      <LoaderCircle class="clone-spin" :size="30" />
      <h3>正在加载复刻工作区…</h3>
    </div>
    <div v-else-if="!state.workspace" class="clone-empty" role="alert">
      <AlertTriangle :size="30" />
      <h3>{{ state.error || '复刻工作区暂不可用' }}</h3>
      <button class="frg-btn" @click="reload">重新加载</button>
    </div>
    <template v-else>
      <EffectWorkflowCanvas
        :active-step="state.step"
        :completed-steps="completedSteps"
        :nodes="nodes"
        :stale-counts="[]"
        workflow-label="裂变类 · 爆款复刻"
        :workflow-number="String(state.step + 1).padStart(2, '0')"
        :show-branches="false"
        :disabled="state.mutating"
        @select="workspace.go"
      />
      <div class="clone-artifact-bar">
        <span class="clone-artifact-icon"><Boxes :size="22" /></span>
        <div>
          <b>{{ sourceBar.title }}</b
          ><small>{{ currentProject.name }} · 当前项目工作区</small>
        </div>
        <em class="clone-confirmation-status">{{
          sourceBar.revision
            ? `${sourceBar.stale ? '待更新' : '已确认'} · 第 ${sourceBar.revision} 版`
            : sourceBar.empty
        }}</em>
        <span class="clone-save-status" role="status">{{
          state.uploadProgress || draftStatus
        }}</span>
      </div>
      <div v-if="state.pollError" class="clone-alert" role="alert">
        <AlertTriangle :size="16" /><span>{{ state.pollError }}</span
        ><button :disabled="state.refreshing" @click="workspace.refresh">刷新任务状态</button>
      </div>
      <div v-if="state.error" class="clone-alert error" role="alert">
        <AlertTriangle :size="16" /><span>{{ state.error }}</span
        ><button :disabled="state.mutating" @click="reload">重新加载</button
        ><button
          v-if="!state.conflict && workspace.dirty()"
          :disabled="state.saving || state.mutating"
          @click="workspace.save"
        >
          重试保存
        </button>
      </div>
      <section class="frg-shell">
        <header class="frg-head">
          <span class="frg-step">{{ String(state.step + 1).padStart(2, '0') }}</span>
          <div class="frg-title">
            <h2>
              {{ state.step === 0 ? '上传参考视频' : nodeDefinitions[state.step]?.[0] }}
            </h2>
            <p>
              {{
                state.step === 0
                  ? '确认参考视频使用权后即可开始拆解。目标图片在元素映射时选择。'
                  : nodeDefinitions[state.step]?.[1]
              }}
            </p>
          </div>
          <div v-if="state.step === 0" class="frg-head-actions">
            <button
              class="frg-btn"
              :disabled="busy || state.conflict || state.saving"
              @click="workspace.save"
            >
              <Check :size="14" />保存草稿
            </button>
          </div>
          <div v-else-if="state.step === 1 && g2?.analysis" class="frg-head-actions">
            <WorkflowNodeEditActions
              :editing="state.analysisEditing"
              :temporary="true"
              :disabled="busy || state.conflict"
              :save-disabled="taskActive || !analysisCurrent || analysisEditDiverged"
              :saving="state.mutating"
              save-label="保存报告"
              saving-label="正在保存…"
              @begin="workspace.beginAnalysisEdit"
              @cancel="workspace.cancelAnalysisEdit"
              @save="workspace.confirmAnalysis"
            />
            <button
              class="frg-btn"
              :disabled="
                busy ||
                taskActive ||
                state.conflict ||
                !state.workspace.capabilities.analysisEnabled
              "
              @click="workspace.startTask()"
            >
              <RotateCw :size="14" />重新拆解
            </button>
          </div>
          <div
            v-else-if="state.step === 2 && g2 && state.workspace.capabilities.mappingEnabled"
            class="frg-head-actions"
          >
            <button
              class="frg-btn"
              :disabled="busy || taskActive || !analysisCurrent || state.conflict"
              @click="resetMapping"
            >
              {{ state.mappingDraft.sourceAnalysis ? '按当前报告重置' : '开始元素映射' }}
            </button>
            <button
              class="frg-btn primary"
              :disabled="
                busy ||
                taskActive ||
                !mappingSourceCurrent ||
                state.conflict ||
                !state.workspace.capabilities.mappingSuggestionsEnabled
              "
              @click="workspace.startTask('SMART_MATCH')"
            >
              <Sparkles :size="14" />智能匹配
            </button>
            <button
              class="frg-btn"
              :disabled="
                busy ||
                taskActive ||
                !mappingSourceCurrent ||
                state.conflict ||
                !state.workspace.capabilities.keepTextValidationEnabled
              "
              @click="workspace.startTask('VALIDATE_KEEP_TEXT')"
            >
              核对保留文本
            </button>
          </div>
        </header>
        <CloneUpload
          v-if="state.step === 0"
          :draft="state.draft"
          :uploads="state.workspace.uploads"
          :capabilities="state.workspace.capabilities"
          :busy="busy"
          @edit="workspace.edit"
          @reference="workspace.upload($event, 'REFERENCE')"
          @materials="workspace.upload($event, 'PRODUCT')"
          @remove="workspace.remove"
          @preview="preview = $event"
          @library="assetRole = $event"
        />
        <template v-else-if="state.step === 1 && g2">
          <CloneTaskPanel
            :tasks="g2.tasks"
            node="analysis"
            :busy="state.mutating"
            @change="workspace.changeTask"
            @adopt="adoptSuggestion"
          />
          <div v-if="g2.analysis?.freshness === 'STALE'" class="clone-g2-banner warn" role="status">
            <AlertTriangle :size="18" /><span
              >上游已确认输入发生变化，当前报告待更新。重新拆解后再进入元素映射。</span
            >
          </div>
          <div v-if="analysisEditDiverged" class="clone-g2-banner warn" role="status">
            <AlertTriangle :size="18" /><span
              >新报告已自动提交，先前人工编辑仍保留。请核对后取消旧编辑或按最新报告重新编辑。</span
            >
          </div>
          <WorkflowEditingBanner
            v-if="state.analysisEditing"
            class="clone-edit-banner"
            node-label="深度拆解"
            description="编辑自动保存到草稿。点击“保存报告”才更新确认报告；取消编辑保留已确认内容。"
          />
          <CloneRealReport
            v-if="displayedReport"
            :report="displayedReport"
            :product-name="
              analysisCurrent
                ? (state.workspace.input?.input.productName ?? '')
                : '来源商品信息已更新'
            "
            :reference-name="
              analysisCurrent ? (reference?.originalFileName ?? '') : '旧输入参考视频'
            "
            :reference-url="analysisCurrent ? (reference?.contentUrl ?? '') : ''"
            :editing="state.analysisEditing && !busy"
            @edit="workspace.editReport"
          />
          <div v-else class="frg-analysis-intro">
            <span class="clone-g2-intro-icon"><ScanLine :size="34" /></span>
            <h3>
              {{ state.workspace.input ? '已就绪，开始六维深度拆解' : '请先确认参考视频' }}
            </h3>
            <p>
              对参考视频抽帧，拆解结构、创意、产品、镜头和视觉。报告会逐镜头记录切点、景别、构图、运镜、动作与证据帧，并标明音频分析状态。拆解完成后自动保存。
            </p>
            <button
              v-if="state.workspace.input"
              class="frg-btn primary"
              :disabled="
                busy ||
                taskActive ||
                state.conflict ||
                !state.workspace.capabilities.analysisEnabled
              "
              @click="workspace.startTask()"
            >
              <ScanLine :size="16" />开始深度拆解</button
            ><button v-else class="frg-btn" @click="workspace.go(0)">返回上传素材</button
            ><small v-if="!state.workspace.capabilities.analysisEnabled">{{
              state.workspace.capabilities.unavailableReason || '拆解服务尚未启用'
            }}</small>
          </div>
        </template>
        <template v-else-if="state.step === 2 && g2 && state.workspace.capabilities.mappingEnabled">
          <CloneTaskPanel
            :tasks="g2.tasks"
            node="mapping"
            :busy="state.mutating"
            @change="workspace.changeTask"
            @adopt="adoptSuggestion"
          />
          <div
            v-if="
              g2.mapping?.freshness === 'STALE' ||
              (state.mappingDraft.sourceAnalysis && !mappingSourceCurrent)
            "
            class="clone-g2-banner warn"
            role="status"
          >
            <AlertTriangle :size="18" /><span
              >映射使用的输入或报告已更新。请先取得最新报告，再按当前报告重置映射；旧确认内容会继续保留。</span
            >
          </div>
          <div
            v-if="mappingSourceCurrent && hasOldPropReplacement"
            class="clone-g2-banner warn"
            role="status"
          >
            <AlertTriangle :size="18" /><span
              >此映射含旧道具替换。请选择对应道具并设为「保留为镜头参考」，再确认映射。</span
            >
          </div>
          <div v-if="!analysisCurrent" class="clone-empty">
            <ScanLine :size="30" />
            <h3>请先完成最新来源的深度拆解</h3>
            <p>映射消费已确认报告，不能用旧报告静默套用新输入。</p>
            <button class="frg-btn" @click="workspace.go(1)">返回深度拆解</button>
          </div>
          <div v-else-if="!state.mappingDraft.sourceAnalysis" class="clone-empty">
            <Boxes :size="30" />
            <h3>准备映射已识别元素</h3>
            <p>从拆解报告锁定镜头顺序与切点，再为每个必换商品绑定目标图片。</p>
            <button
              class="frg-btn primary"
              :disabled="busy || state.conflict"
              @click="resetMapping"
            >
              开始元素映射
            </button>
          </div>
          <CloneRealMapping
            v-else-if="g2.analysis && mappingSourceCurrent"
            :project-id="state.projectId"
            :draft="state.mappingDraft"
            :report="g2.analysis.report"
            :product-name="state.workspace.input?.input.productName ?? ''"
            :capabilities="state.workspace.capabilities"
            :disabled="busy || state.conflict || !mappingSourceCurrent"
            :error="state.error"
            :prepare-asset="workspace.prepareMappingAsset"
            @edit="workspace.editBinding"
          />
          <div v-else class="clone-empty">
            <Boxes :size="30" />
            <h3>旧映射草稿已保留</h3>
            <p>当前草稿的结构属于先前报告。按当前报告重置后，可继续配置最新元素。</p>
          </div>
        </template>
        <CloneRealGeneration
          v-else-if="state.step === 3 && state.workspace.capabilities.mappingEnabled"
          :key="`${state.projectId}:${state.workspace.run.id}`"
          :project-id="state.projectId"
          :run-id="state.workspace.run.id"
          :product-name="state.workspace.input?.input.productName ?? ''"
          :mapping-ref="g2?.mapping?.freshness === 'CURRENT' ? g2.mapping.ref : null"
          :enabled="state.workspace.capabilities.generationEnabled"
          @changed="workspace.refresh"
        />
        <div v-else class="clone-empty" role="status">
          <ScanLine :size="32" />
          <h3>{{ nodeDefinitions[state.step]?.[0] }}暂未开放</h3>
          <p>
            {{
              state.step === 3
                ? '当前已接通输入、深度拆解与元素映射；成片生成尚未开放。'
                : state.workspace.capabilities.unavailableReason || '当前处理能力尚未启用。'
            }}
          </p>
          <small v-if="state.workspace.input"
            >已确认输入会在此项目中保留，可返回上传素材继续编辑。</small
          ><button class="frg-btn" @click="workspace.go(0)">返回上传素材</button>
        </div>
      </section>
      <WorkflowNodeFooter
        :back-label="state.step > 0 ? '上一步' : ''"
        :show-validate="false"
        :show-next="state.step < 3"
        :next-disabled="!canNext"
        :next-label="
          state.mutating
            ? '正在确认…'
            : state.step === 1
              ? '进入元素映射'
              : state.step === 2
                ? '确认映射并下一步'
                : '确认并下一步'
        "
        @back="workspace.go(Math.max(0, state.step - 1))"
        @next="next"
      />
    </template>
    <CloneDialog v-if="preview" :title="preview.originalFileName" @close="preview = null"
      ><img
        v-if="preview.mimeType.startsWith('image/')"
        :src="preview.contentUrl"
        :alt="preview.originalFileName"
        class="clone-preview-image" /><video v-else :src="preview.contentUrl" controls autoplay
    /></CloneDialog>
    <CloneAssetPicker
      v-if="assetRole && state.workspace"
      :project-id="state.projectId"
      :role="assetRole"
      :extensions="
        assetRole === 'REFERENCE'
          ? state.workspace.capabilities.referenceExtensions
          : state.workspace.capabilities.productExtensions
      "
      :busy="state.mutating"
      :operation-error="state.error"
      @close="assetRole = null"
      @select="selectAsset"
    />
  </div>
</template>
<style src="./clone-prototype.css"></style>
<style scoped>
.clone-save-status {
  font-size: 11px;
  color: #64748b;
  margin-left: auto;
}
.frg-head-actions button {
  display: flex;
  align-items: center;
  gap: 5px;
}
.frg-head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.clone-g2-banner {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 16px 20px;
  padding: 12px 14px;
  border: 1px solid #e9d39d;
  border-radius: 10px;
  background: #fff9ed;
  color: #98691a;
  font-size: 12px;
  line-height: 1.75;
}
.clone-g2-banner svg {
  flex: 0 0 18px;
  margin-top: 2px;
}
.clone-edit-banner {
  margin: 16px 20px;
}
.frg-analysis-intro {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 46px 24px;
  text-align: center;
}
.frg-analysis-intro p {
  max-width: 680px;
  color: #75839a;
  font-size: 13px;
  line-height: 1.8;
}
.frg-analysis-intro h3 {
  margin: 0;
  color: #2e4564;
}
.frg-analysis-intro small {
  color: #947023;
  font-size: 12px;
}
.frg-analysis-intro button {
  display: flex;
  align-items: center;
  gap: 7px;
}
.clone-g2-intro-icon {
  display: grid;
  place-items: center;
  width: 74px;
  height: 74px;
  color: #4c79d7;
  background: #edf3ff;
  border-radius: 18px;
}
.clone-empty p {
  max-width: 600px;
  line-height: 1.8;
}
@media (max-width: 720px) {
  .frg-head-actions {
    width: 100%;
  }
  .clone-g2-banner,
  .clone-edit-banner {
    margin: 12px;
  }
  .clone-artifact-bar {
    flex-wrap: wrap;
  }
  .clone-artifact-bar .clone-confirmation-status {
    display: inline-flex;
    flex: 0 0 auto;
    max-width: 100%;
    white-space: normal;
  }
  .clone-save-status {
    width: 100%;
    margin-left: 0;
  }
}
</style>
