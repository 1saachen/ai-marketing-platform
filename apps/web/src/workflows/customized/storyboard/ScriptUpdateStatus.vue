<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle, CheckCircle2, CircleAlert } from '@lucide/vue';
import type { CustomizedScriptUpdateCandidate, StoryboardTask } from '@ai-marketing/contracts';
const props = defineProps<{
  candidate: CustomizedScriptUpdateCandidate;
  task: StoryboardTask | null;
  now: number;
  syncError: boolean;
}>();
const stages = [
  { id: 'SNAPSHOT', label: '读取依据' },
  { id: 'STORY', label: '定向改稿' },
  { id: 'REVIEW', label: '审校更新稿' },
  { id: 'SAVE', label: '准备候选' },
];
const active = computed(() => ['QUEUED', 'RUNNING'].includes(props.candidate.status));
const task = computed(() => (props.task?.id === props.candidate.taskId ? props.task : null));
const stage = computed(
  () =>
    stages.find((stage) =>
      task.value?.steps.some((s) => s.nodeId === stage.id && s.status === 'RUNNING'),
    )?.id ??
    stages.find(
      (stage) => !task.value?.steps.some((s) => s.nodeId === stage.id && s.status === 'SUCCEEDED'),
    )?.id,
);
const completed = computed(() => props.candidate.status === 'COMPLETED');
const title = computed(() => {
  if (props.candidate.applied) return '已保存当前方案';
  if (completed.value) return '审校已完成，可以保存修改';
  if (props.candidate.status === 'FAILED' && props.candidate.reviewStatus === 'NEEDS_CHANGES')
    return '审核未通过，需要修正';
  if (props.candidate.status === 'CANCELLED') return '本次更新已停止，原脚本保留';
  if (!active.value) return '本次更新未完成，原脚本保留';
  if (props.candidate.status === 'QUEUED') return '等待开始局部更新';
  if (!task.value) return '正在查询更新阶段';
  return (
    (
      {
        SNAPSHOT: '正在读取更新依据',
        STORY: '正在定向修改脚本',
        REVIEW: '正在审校更新稿',
        SAVE: '正在准备可保存的候选',
      } as Record<string, string>
    )[stage.value ?? ''] ?? '正在同步审校结果'
  );
});
const description = computed(() => {
  if (props.candidate.applied) return '当前方案已更新，其他方案保持原样。';
  if (completed.value) return '请核对修改前后内容；点击“保存修改”后才替换当前脚本。';
  if (props.candidate.status === 'FAILED' && props.candidate.reviewStatus === 'NEEDS_CHANGES')
    return '下一步：点击“按审核意见修正”，核对范围后重新改稿并审核。当前候选仅供核对，通过后可微调并保存。';
  if (!active.value) return '候选仅供核对，处理提示的问题后可继续本次更新。';
  if (stage.value === 'REVIEW')
    return '改稿已完成，正在核对商品事实及内容连贯性。审校通过后会自动启用“保存修改”。';
  if (stage.value === 'SAVE') return '改稿和审校已完成，正在准备最终候选。';
  return '已有脚本保持可用。候选需完成改稿与审校后才能保存。';
});
const elapsed = computed(() => {
  if (!active.value || !task.value) return '';
  const start = Date.parse(task.value.createdAt);
  if (!Number.isFinite(start) || start > props.now) return '';
  const seconds = Math.floor((props.now - start) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});
</script>
<template>
  <section
    class="script-update-status"
    :class="{
      'is-ready': completed || candidate.applied,
      'is-incomplete': !active && !completed && !candidate.applied,
    }"
    aria-label="脚本局部更新状态"
  >
    <div class="status-title" role="status" aria-live="polite">
      <LoaderCircle v-if="active" class="status-spinner" :size="18" aria-hidden="true" />
      <CheckCircle2 v-else-if="completed || candidate.applied" :size="18" aria-hidden="true" />
      <CircleAlert v-else :size="18" aria-hidden="true" />
      <strong>{{ title }}</strong>
    </div>
    <p>{{ description }}</p>
    <p
      v-if="
        !active &&
        !completed &&
        candidate.errorMessage &&
        candidate.reviewStatus !== 'NEEDS_CHANGES'
      "
      role="alert"
    >
      {{ candidate.errorMessage }}
    </p>
    <ol v-if="active" aria-label="更新步骤">
      <li
        v-for="item in stages"
        :key="item.id"
        :class="{
          done: task?.steps.some((s) => s.nodeId === item.id && s.status === 'SUCCEEDED'),
          current: item.id === stage && candidate.status === 'RUNNING',
        }"
      >
        {{ item.label
        }}<span v-if="task?.steps.some((s) => s.nodeId === item.id && s.status === 'SUCCEEDED')">
          · 已完成</span
        ><span v-else-if="item.id === stage && candidate.status === 'RUNNING'"> · 进行中</span>
      </li>
    </ol>
    <p v-if="active" class="status-wait">
      <span v-if="elapsed">本次更新已等待 {{ elapsed }}。 </span
      >剩余时间暂无法准确预估；可关闭窗口，任务会继续，完成后再打开保存。
    </p>
    <p v-if="syncError" class="status-sync" role="alert">
      进度暂未同步，正在重新查询，请勿重复发起更新。
    </p>
  </section>
</template>
<style scoped>
.script-update-status {
  width: 100%;
  box-sizing: border-box;
  padding: 14px 16px;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
  background: #eff6ff;
  color: #1e40af;
  overflow-wrap: anywhere;
}
.status-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-title strong {
  font-size: 14px;
}
.script-update-status p {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.65;
}
.script-update-status ol {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin: 12px 0 0;
  padding-left: 20px;
  color: #64748b;
  font-size: 12px;
}
.script-update-status li.current {
  color: #1d4ed8;
  font-weight: 700;
}
.script-update-status li.done {
  color: #15803d;
}
.status-wait {
  color: #64748b;
}
.is-ready {
  color: #166534;
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.is-incomplete {
  color: #92400e;
  background: #fffbeb;
  border-color: #fde68a;
}
.status-sync {
  color: #92400e;
}
.status-spinner {
  flex-shrink: 0;
  animation: status-spin 1.3s linear infinite;
}
@keyframes status-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .status-spinner {
    animation: none;
  }
}
</style>
