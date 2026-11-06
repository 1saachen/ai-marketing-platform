<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { BaseButton } from '@ai-marketing/ui';
import type {
  CustomizedScriptUpdateCandidate,
  CustomizedStoryboardScript,
  CustomizedUpdatePreview,
  StoryboardTask,
} from '@ai-marketing/contracts';
import CustomizedLocalUpdate from '../shared/CustomizedLocalUpdate.vue';
import ScriptUpdateStatus from './ScriptUpdateStatus.vue';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import { storyboardApi } from './storyboard.api';
import { isAbortError } from '../../../api/http-client';
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  scriptId: string;
  affectedScripts?: Pick<CustomizedStoryboardScript, 'id' | 'name'>[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ saved: [] }>();
const localUpdate = ref<InstanceType<typeof CustomizedLocalUpdate> | null>(null);
function affectedForPreview(preview: CustomizedUpdatePreview) {
  return (props.affectedScripts ?? []).filter(
    (script) => script.id !== props.scriptId || preview.items.some((item) => item.id === script.id),
  );
}
const candidate = ref<CustomizedScriptUpdateCandidate | null>(null),
  draft = ref<CustomizedStoryboardScript | null>(null),
  draftTaskId = ref<string | null>(null),
  open = ref(false),
  busy = ref(false),
  error = ref(''),
  task = ref<StoryboardTask | null>(null),
  syncError = ref(false),
  now = ref(Date.now());
const inProgress = computed(
  () => !!candidate.value && ['QUEUED', 'RUNNING'].includes(candidate.value.status),
);
const needsChanges = computed(
  () => candidate.value?.status === 'FAILED' && candidate.value.reviewStatus === 'NEEDS_CHANGES',
);
function repair() {
  if (!needsChanges.value || busy.value || props.disabled) return;
  open.value = false;
  localUpdate.value?.show();
}
const draftCurrent = computed(
  () => !!candidate.value && draftTaskId.value === candidate.value.taskId,
);
const saveLabel = computed(() => {
  if (!inProgress.value) return '保存修改';
  if (candidate.value?.status === 'QUEUED') return '排队中，请等待';
  if (task.value?.steps.some((s) => s.nodeId === 'REVIEW' && s.status === 'RUNNING'))
    return '审校中，完成后可保存';
  return '更新中，完成后可保存';
});
let controller = new AbortController(),
  timer: ReturnType<typeof setTimeout> | undefined,
  clock: ReturnType<typeof setInterval> | undefined,
  mounted = false,
  readVersion = 0;
function syncClock() {
  clearInterval(clock);
  now.value = Date.now();
  if (mounted && inProgress.value)
    clock = setInterval(() => {
      now.value = Date.now();
    }, 1000);
}
watch(inProgress, syncClock);
onMounted(() => {
  mounted = true;
  syncClock();
});
function current(scope: AbortController) {
  return controller === scope && !scope.signal.aborted;
}
async function refresh() {
  clearTimeout(timer);
  const scope = controller;
  const version = ++readVersion;
  const latest = () => current(scope) && version === readVersion;
  try {
    const value = await storyboardApi.updateCandidate(
      props.projectId,
      props.workflowRunId,
      props.scriptId,
      scope.signal,
    );
    if (!latest()) return;
    candidate.value = value;
    if (!value || task.value?.id !== value.taskId) task.value = null;
    syncError.value = false;
    if (value) {
      try {
        const status = await storyboardApi.task(props.projectId, value.taskId, scope.signal);
        if (!latest()) return;
        if (
          status.id !== value.taskId ||
          status.workflowRunId !== props.workflowRunId ||
          status.incremental?.scriptId !== props.scriptId
        )
          throw Error('更新进度作用域不匹配');
        task.value = status;
      } catch (e) {
        if (!latest() || isAbortError(e)) return;
        syncError.value = true;
      }
    }
    if (latest() && (inProgress.value || syncError.value))
      timer = setTimeout(() => void refresh(), syncError.value ? 5000 : 1800);
  } catch (e) {
    if (latest() && !isAbortError(e)) {
      syncError.value = true;
      timer = setTimeout(() => void refresh(), 5000);
    }
  }
}
async function execute(preview: CustomizedUpdatePreview) {
  const scope = controller;
  busy.value = true;
  error.value = '';
  try {
    await storyboardApi.updateScript(
      props.projectId,
      props.workflowRunId,
      props.scriptId,
      { version: 1, fingerprint: preview.fingerprint },
      scope.signal,
    );
    if (current(scope)) await refresh();
  } catch (e) {
    if (current(scope) && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '更新未开始';
    if (current(scope)) await refresh();
  } finally {
    if (current(scope)) busy.value = false;
  }
}
function show() {
  if (!candidate.value?.after) return;
  if (!draft.value || !draftCurrent.value) {
    draft.value = JSON.parse(JSON.stringify(candidate.value.after));
    draftTaskId.value = candidate.value.taskId;
  }
  open.value = true;
}
async function save() {
  if (
    !draft.value ||
    !candidate.value ||
    !draftCurrent.value ||
    candidate.value.applied ||
    candidate.value.status !== 'COMPLETED'
  )
    return;
  const scope = controller;
  busy.value = true;
  error.value = '';
  try {
    await storyboardApi.saveUpdate(
      props.projectId,
      props.workflowRunId,
      candidate.value.taskId,
      draft.value,
      scope.signal,
    );
    if (current(scope)) {
      open.value = false;
      await refresh();
      emit('saved');
    }
  } catch (e) {
    if (current(scope) && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '保存未完成，修改仍保留';
  } finally {
    if (current(scope)) busy.value = false;
  }
}
async function retry() {
  if (needsChanges.value) {
    repair();
    return;
  }
  if (!candidate.value) return;
  const scope = controller;
  busy.value = true;
  try {
    await storyboardApi.retry(props.projectId, candidate.value.taskId, false, scope.signal);
    if (current(scope)) await refresh();
  } catch (e) {
    if (current(scope)) error.value = e instanceof Error ? e.message : '原任务暂时无法继续';
  } finally {
    if (current(scope)) busy.value = false;
  }
}
watch(
  () => [props.projectId, props.workflowRunId, props.scriptId],
  () => {
    controller.abort();
    clearTimeout(timer);
    controller = new AbortController();
    candidate.value = null;
    task.value = null;
    syncError.value = false;
    draft.value = null;
    draftTaskId.value = null;
    open.value = false;
    busy.value = false;
    error.value = '';
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  mounted = false;
  controller.abort();
  clearTimeout(timer);
  clearInterval(clock);
});
</script>
<template>
  <div class="script-local-update">
    <CustomizedLocalUpdate
      ref="localUpdate"
      :project-id="projectId"
      :workflow-run-id="workflowRunId"
      :target-id="scriptId"
      :nodes="['SCRIPT']"
      subject-label="当前方案"
      execute-label="更新当前方案"
      :disabled="
        disabled || busy || (!!candidate && ['QUEUED', 'RUNNING'].includes(candidate.status))
      "
      @execute="execute"
    >
      <template #context="{ preview }">
        <section
          v-if="affectedForPreview(preview).length"
          class="affected-scripts"
          aria-label="信息卡变化影响的脚本"
        >
          <h3>信息卡变化影响的脚本（{{ affectedForPreview(preview).length }}）</h3>
          <ul>
            <li v-for="script in affectedForPreview(preview)" :key="script.id">
              <strong>{{ script.name }}</strong
              >：{{ script.id === scriptId ? '当前方案 · 待更新' : '其他方案 · 待更新' }}
            </li>
          </ul>
          <p>本次只更新当前方案；其他方案需切换后分别更新，已有内容保留。</p>
        </section>
      </template>
    </CustomizedLocalUpdate>
    <ScriptUpdateStatus
      v-if="candidate && !open && !candidate.applied"
      :candidate="candidate"
      :task="task"
      :now="now"
      :sync-error="syncError"
    />
    <button v-if="candidate?.after && !candidate.applied" type="button" @click="show">
      查看更新候选
    </button>
    <button
      v-if="candidate?.status === 'FAILED'"
      type="button"
      :disabled="busy || disabled"
      @click="retry"
    >
      {{ needsChanges ? '按审核意见修正' : '继续本次更新' }}
    </button>
    <p v-if="syncError && !candidate" role="alert">
      暂时无法读取更新状态，正在重新查询。<button type="button" @click="refresh">重新查询</button>
    </p>
    <p v-if="error && !open" role="alert">{{ error }}</p>
  </div>
  <WorkflowInformationDialog
    :open="open"
    title="核对脚本局部更新"
    description="旧版本保持可用，保存后才更新当前路径"
    @close="!busy && (open = false)"
  >
    <ScriptUpdateStatus
      v-if="candidate && open"
      :candidate="candidate"
      :task="task"
      :now="now"
      :sync-error="syncError"
    />
    <section v-if="candidate?.reviewFindings?.length" class="review-findings" aria-label="审核意见">
      <h3>审核意见</h3>
      <article v-for="(finding, index) in candidate.reviewFindings" :key="index">
        <strong
          >{{ finding.severity === 'ERROR' ? '需要修正' : '优化建议' }}：{{
            finding.message
          }}</strong
        >
        <p v-if="finding.evidence">依据：{{ finding.evidence }}</p>
        <p v-if="finding.suggestion">建议：{{ finding.suggestion }}</p>
      </article>
    </section>
    <template v-else
      ><p v-for="issue in candidate?.issues ?? []" :key="issue" role="alert">
        {{ issue }}
      </p></template
    >
    <p v-if="open && !draftCurrent" role="alert">
      更新任务已变化，当前输入仍保留。请关闭窗口并重新打开最新候选后保存。
    </p>
    <div v-if="draft && candidate" class="script-comparison">
      <section>
        <h3>修改前</h3>
        <pre>{{ candidate.before.story?.content ?? candidate.before.synopsis }}</pre>
      </section>
      <section>
        <h3>修改后</h3>
        <textarea
          v-if="draft.story"
          v-model="draft.story.content"
          :disabled="busy"
          :readonly="needsChanges"
          aria-label="修改后脚本正文"
        /><textarea
          v-else
          v-model="draft.synopsis"
          :disabled="busy"
          :readonly="needsChanges"
          aria-label="修改后脚本概要"
        />
        <details>
          <summary>其他脚本信息</summary>
          <label
            >概要<textarea v-model="draft.synopsis" :disabled="busy" :readonly="needsChanges" />
          </label>
          <label v-if="typeof draft.structure === 'string'"
            >叙事结构说明<textarea
              v-model="draft.structure"
              :disabled="busy"
              :readonly="needsChanges"
            />
          </label>
          <template v-if="draft.story"
            ><label v-if="typeof draft.story.structure === 'string'"
              >故事结构说明<textarea
                v-model="draft.story.structure"
                :disabled="busy"
                :readonly="needsChanges"
              />
            </label>
            <label
              >开场<textarea
                v-model="draft.story.opening"
                :disabled="busy"
                :readonly="needsChanges"
              /></label
            ><label
              >发展<textarea
                v-model="draft.story.development"
                :disabled="busy"
                :readonly="needsChanges"
              /></label
            ><label
              >收束<textarea
                v-model="draft.story.ending"
                :disabled="busy"
                :readonly="needsChanges"
              /></label
            ><label
              >对白安排<textarea
                v-model="draft.story.dialoguePlan"
                :disabled="busy"
                :readonly="needsChanges"
              /></label
          ></template>
        </details>
      </section>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="script-update-actions">
      <button class="secondary" type="button" :disabled="busy" @click="open = false">
        {{ inProgress ? '关闭，后台继续' : '暂不采用' }}</button
      ><BaseButton v-if="needsChanges" :disabled="disabled || busy || !draftCurrent" @click="repair"
        >按审核意见修正</BaseButton
      ><BaseButton
        v-else
        :loading="busy"
        :disabled="
          disabled || !draftCurrent || candidate?.applied || candidate?.status !== 'COMPLETED'
        "
        @click="save"
        >{{ saveLabel }}</BaseButton
      >
    </div>
  </WorkflowInformationDialog>
</template>
<style scoped>
.script-local-update {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  margin: 12px 0;
}
.review-findings {
  margin: 16px 0;
  overflow-wrap: anywhere;
}
.review-findings h3 {
  font-size: 14px;
}
.review-findings article {
  padding: 12px;
  margin: 10px 0;
  border: 1px solid #fde68a;
  border-radius: 8px;
  background: #fffbeb;
  font-size: 13px;
  line-height: 1.7;
}
.review-findings p {
  margin: 6px 0 0;
}
.affected-scripts {
  padding: 12px 16px;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.affected-scripts h3 {
  margin: 0;
  font-size: 14px;
}
.affected-scripts ul {
  max-height: 220px;
  overflow: auto;
  padding-left: 20px;
}
.affected-scripts li {
  margin: 8px 0;
}
.affected-scripts p {
  color: #64748b;
  font-size: 13px;
}
.script-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.script-comparison pre {
  white-space: pre-wrap;
  font: inherit;
  line-height: 1.7;
  max-height: 420px;
  overflow: auto;
}
.script-comparison textarea {
  width: 100%;
  min-height: 100px;
  box-sizing: border-box;
  padding: 10px;
  font: inherit;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
}
.script-comparison section > textarea {
  min-height: 320px;
}
label {
  display: block;
  margin-top: 12px;
}
.script-update-actions {
  position: sticky;
  bottom: 0;
  background: white;
  padding: 14px 0;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
summary {
  cursor: pointer;
  padding: 10px 0;
  color: #64748b;
}
.secondary {
  padding: 0 16px;
  min-height: 42px;
  background: white;
  border: 1px solid #cbd8ea;
  border-radius: 10px;
  color: #3f5f8c;
  cursor: pointer;
  font: inherit;
}
@media (max-width: 680px) {
  .script-comparison {
    grid-template-columns: 1fr;
  }
}
</style>
