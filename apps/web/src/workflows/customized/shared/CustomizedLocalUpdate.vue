<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { BaseButton } from '@ai-marketing/ui';
import type { CustomizedUpdateNode, CustomizedUpdatePreview } from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import { productionApi } from '../production/production.api';
import { isAbortError } from '../../../api/http-client';
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  nodes: CustomizedUpdateNode[];
  targetId?: string;
  subjectLabel?: string;
  executeLabel?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ execute: [preview: CustomizedUpdatePreview] }>();
const open = ref(false),
  loading = ref(false),
  error = ref(''),
  preview = ref<CustomizedUpdatePreview | null>(null),
  selected = ref<CustomizedUpdateNode>(props.nodes[0]!);
let controller = new AbortController();
const labels: Record<CustomizedUpdateNode, string> = {
  INFORMATION_EXTRACTION: '信息提炼',
  SCRIPT: '脚本',
  ASSETS: '资产定义',
  SHOTS: '分镜',
  PROMPT: '提示词',
  RENDER: '视频',
};
async function load() {
  controller.abort();
  controller = new AbortController();
  const current = controller;
  loading.value = true;
  error.value = '';
  preview.value = null;
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
  selected.value = props.nodes[0]!;
  open.value = true;
  void load();
}
function close() {
  controller.abort();
  open.value = false;
}
function execute() {
  if (!preview.value || preview.value.blockers.length || !preview.value.items.length) return;
  const value = preview.value;
  close();
  emit('execute', value);
}
watch(() => [props.projectId, props.workflowRunId, props.targetId], close);
onBeforeUnmount(() => controller.abort());
defineExpose({ show });
</script>
<template>
  <button class="customized-local-update" type="button" :disabled="disabled" @click="show">
    局部更新
  </button>
  <WorkflowInformationDialog
    :open="open"
    title="局部更新"
    description="查看来源变化与本次处理范围"
    @close="close"
  >
    <label v-if="nodes.length > 1"
      >更新内容
      <select v-model="selected" :disabled="loading" @change="load">
        <option v-for="node in nodes" :key="node" :value="node">{{ labels[node] }}</option>
      </select></label
    >
    <p v-if="loading" role="status">正在核对来源和更新范围…</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重试</button></p>
    <template v-if="preview">
      <p v-if="preview.node === 'ASSETS'">
        以下资产需要核对来源。语言模型会判断实际需要修改的资产和字段，其余定义与图片原样保留。
      </p>
      <p v-else>以下为依赖关系确定的可能影响范围，执行时核对必要修改，其他内容保留。</p>
      <slot name="context" :preview="preview" />
      <p v-for="blocker in preview.blockers" :key="blocker" role="alert">{{ blocker }}</p>
      <p v-if="!preview.items.length">{{ subjectLabel ?? '当前内容' }}无需更新。</p>
      <h3 v-if="preview.items.length">
        {{ preview.node === 'ASSETS' ? '待核对范围（并非全部修改）' : '本次处理范围' }}
      </h3>
      <ul>
        <li v-for="item in preview.items" :key="item.id">
          <strong>{{ item.name }}</strong
          >：{{ item.reason }}
        </li>
      </ul>
      <p v-if="preview.items.length">
        {{ preview.node === 'ASSETS' ? '待核对' : '本次' }} {{ preview.items.length }} 项；{{
          preview.calls.includes('VIDEO')
            ? '将调用视频生成服务'
            : preview.calls.includes('TEXT')
              ? '将调用文字模型核对与更新'
              : '仅同步信息'
        }}。执行可能产生费用。
      </p>
    </template>
    <div class="update-actions">
      <button class="secondary" type="button" @click="close">取消</button
      ><BaseButton
        type="button"
        :disabled="loading || !preview?.items.length || !!preview?.blockers.length || disabled"
        @click="execute"
      >
        {{ executeLabel ?? (preview?.node === 'ASSETS' ? '判断并更新关联资产' : '开始更新') }}
      </BaseButton>
    </div>
  </WorkflowInformationDialog>
</template>
<style scoped>
.customized-local-update {
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
  font: inherit;
}
.customized-local-update:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
ul {
  max-height: 340px;
  overflow: auto;
  padding-left: 24px;
}
li {
  margin: 8px 0;
}
select {
  padding: 6px;
  margin: 8px;
}
.update-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 14px;
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
</style>
