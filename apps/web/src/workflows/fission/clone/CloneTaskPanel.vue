<script setup lang="ts">
import { computed } from 'vue';
import { WorkflowRunProgress } from '@ai-marketing/ui';
import { AlertTriangle, Check, RotateCw, X } from '@lucide/vue';
import type { CloneTask } from '@ai-marketing/contracts';
const props = defineProps<{ tasks: CloneTask[]; node: 'analysis' | 'mapping'; busy: boolean }>();
const emit = defineEmits<{
  change: [taskId: string, action: 'cancel' | 'retry'];
  adopt: [taskId: string];
}>();
const tasks = computed(() =>
  props.tasks
    .filter((task) =>
      props.node === 'analysis' ? task.operation === 'ANALYZE' : task.operation === 'MAP_SUGGEST',
    )
    .filter(
      (task, index) =>
        index < 4 ||
        task.suggestionPending ||
        task.status === 'QUEUED' ||
        task.status === 'RUNNING',
    ),
);
const active = (task: CloneTask) => task.status === 'QUEUED' || task.status === 'RUNNING';
const label = (task: CloneTask) =>
  task.operation === 'ANALYZE'
    ? '深度拆解'
    : task.purpose === 'SMART_MATCH'
      ? '智能匹配'
      : '保留文本核对';
const statusLabels = {
  QUEUED: '排队中',
  RUNNING: '处理中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
</script>
<template>
  <div v-if="tasks.length" class="clone-task-list" aria-label="复刻任务状态">
    <article
      v-for="(task, index) in tasks"
      :key="task.id"
      class="clone-task"
      :class="{ history: index > 0 }"
    >
      <header>
        <b>{{ label(task) }} · {{ statusLabels[task.status] }}</b
        ><span v-if="task.suggestionPending">建议待采用</span>
        <div>
          <button
            v-if="active(task) || task.status === 'FAILED'"
            class="frg-btn"
            :disabled="busy"
            @click="emit('change', task.id, 'cancel')"
          >
            <X :size="13" />{{ task.status === 'FAILED' ? '放弃任务' : '取消任务' }}</button
          ><button
            v-if="task.canRetry"
            class="frg-btn"
            :disabled="busy"
            @click="emit('change', task.id, 'retry')"
          >
            <RotateCw :size="13" />重试</button
          ><button
            v-if="task.suggestionPending"
            class="frg-btn primary"
            :disabled="busy"
            @click="emit('adopt', task.id)"
          >
            <Check :size="13" />采用建议
          </button>
        </div>
      </header>
      <WorkflowRunProgress
        v-if="active(task) || index === 0"
        :progress="task.progress"
        :summary="task.message || `${label(task)}${statusLabels[task.status]}`"
        :terminal="!active(task)"
        :warning="task.error || ''"
        action-label=""
      />
      <p v-if="task.suggestionPending" class="clone-task-note">
        <AlertTriangle
          :size="14"
        />任务期间映射草稿已有变化，当前编辑已保留。采用建议会替换当前映射草稿，不会自动确认映射。
      </p>
      <p v-else-if="task.appliedToDraft && task.purpose === 'SMART_MATCH'" class="clone-task-note">
        智能建议已写入映射草稿，请逐项核对后确认。
      </p>
      <details
        v-if="
          task.result?.operation === 'MAP_SUGGEST' && task.result.purpose === 'VALIDATE_KEEP_TEXT'
        "
      >
        <summary>查看本次文本核对结果</summary>
        <p class="clone-task-note">
          这是任务执行时的核对记录。确认映射时，服务端会核对商品事实和当前内容是否仍与该记录一致。
        </p>
        <ul>
          <li v-for="check in task.result.checks" :key="check.elementId">
            <strong>{{ check.passed ? '通过' : '未通过' }}</strong> · {{ check.reason }}
            <p v-for="(evidence, evidenceIndex) in check.evidence" :key="evidenceIndex">
              {{ evidence }}
            </p>
          </li>
        </ul>
      </details>
    </article>
  </div>
</template>
<style scoped>
.clone-task-list {
  display: grid;
  gap: 10px;
  margin: 16px 20px;
}
.clone-task {
  border: 1px solid #dbe5f5;
  border-radius: 12px;
  padding: 13px;
  background: #fbfdff;
}
.clone-task header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  color: #415773;
  font-size: 12px;
}
.clone-task header > div {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.clone-task header > span {
  color: #9b711d;
  font-size: 11px;
}
.clone-task header button {
  display: flex;
  gap: 5px;
  align-items: center;
}
.clone-task :deep(.workflow-run-progress) {
  margin: 0;
}
.clone-task.history {
  padding: 11px 13px;
}
.clone-task-note {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 10px 0 0;
  font-size: 11px;
  color: #7b879c;
  line-height: 1.75;
}
.clone-task-note svg {
  flex: 0 0 14px;
  margin-top: 2px;
}
details {
  margin-top: 10px;
  color: #60748e;
  font-size: 12px;
}
summary {
  cursor: pointer;
}
li {
  margin: 10px 0;
  line-height: 1.7;
}
li p {
  margin: 3px 0;
  font-size: 11px;
}
@media (max-width: 720px) {
  .clone-task-list {
    margin: 12px;
  }
  .clone-task header {
    flex-wrap: wrap;
  }
  .clone-task header > div {
    margin-left: 0;
    flex-wrap: wrap;
    width: 100%;
  }
}
</style>
