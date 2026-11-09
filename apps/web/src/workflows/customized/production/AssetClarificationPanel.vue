<script setup lang="ts">
import { computed, ref } from 'vue';
import { ASSET_CLARIFICATION_MAX_LENGTH, type ProductionTask } from '@ai-marketing/contracts';
import { BaseButton } from '@ai-marketing/ui';

const props = defineProps<{
  task: ProductionTask;
  disabled: boolean;
  error?: string;
  sourceReady: boolean;
  refreshImages?: boolean;
}>();
const emit = defineEmits<{
  submit: [explanation: string, key: string];
  decide: [adopt: boolean];
  retry: [];
  script: [];
}>();

const review = computed(() => props.task.assetClarification);
const proposal = computed(() => review.value?.proposal);
const active = computed(() => ['QUEUED', 'RUNNING'].includes(props.task.status));
const applied = computed(() => review.value?.state === 'ADOPTED');
const pending = computed(() => review.value?.state === 'PENDING');
const canAdopt = computed(
  () =>
    pending.value &&
    !!proposal.value &&
    !proposal.value.questions.length &&
    (!!proposal.value.changes.length || !!proposal.value.productionNote),
);
const explanation = ref(props.task.assetClarification?.explanation ?? '');
const showForm = ref(
  !props.task.assetClarification || props.task.assetClarification.state === 'DISMISSED',
);
let previousRequest: { explanation: string; key: string } | undefined;
function submit() {
  const value = explanation.value.trim();
  if (props.disabled || !value) return;
  if (previousRequest?.explanation !== value)
    previousRequest = { explanation: value, key: crypto.randomUUID() };
  emit('submit', value, previousRequest.key);
}
function showValue(value: string | string[]) {
  return (Array.isArray(value) ? value.join('\n') : value) || '（空）';
}
</script>

<template>
  <section class="asset-clarification" :class="{ 'is-adopted': applied }" aria-label="资产人工核对">
    <h3>{{ applied ? '信息卡修改已保存' : '需要人工核对' }}</h3>
    <ul v-if="task.assetReviewQuestions?.length">
      <li v-for="question in task.assetReviewQuestions" :key="question">{{ question }}</li>
    </ul>
    <template v-if="!review">
      <p>在这里说明哪些商品事实已确认，或这次画面可以省略什么。判断完成后先看建议。</p>
    </template>
    <p v-else-if="active" role="status">
      {{
        task.status === 'QUEUED' ? '已提交补充说明，正在排队。' : '正在重新判断，原有内容会保留。'
      }}
    </p>
    <template v-else-if="task.status === 'FAILED'">
      <p>本次判断未完成，补充说明已保留。可以继续判断。</p>
      <p class="original-note">你的说明：{{ review.explanation }}</p>
      <BaseButton variant="secondary" :disabled="disabled" @click="emit('retry')"
        >继续判断</BaseButton
      >
    </template>
    <template v-else-if="applied">
      <p v-if="!sourceReady">
        下一步：去脚本创作局部更新当前方案，保存脚本后再回这里局部更新资产。旧资产和视频仍可查看。
      </p>
      <p v-else>当前脚本已就绪，可在本页发起资产局部更新。</p>
      <p v-if="proposal?.productionNote">下次资产局部更新将带上本次制作要求。</p>
      <BaseButton
        v-if="!sourceReady"
        variant="secondary"
        :disabled="disabled"
        @click="emit('script')"
      >
        去更新脚本
      </BaseButton>
    </template>
    <template v-else-if="proposal && pending">
      <p>这是根据补充说明整理的建议，尚未保存。</p>
      <article v-for="change in proposal.changes" :key="change.label">
        <strong>{{ change.label }}</strong>
        <dl>
          <div>
            <dt>修改前</dt>
            <dd>{{ showValue(change.before) }}</dd>
          </div>
          <div>
            <dt>修改后</dt>
            <dd>{{ showValue(change.after) }}</dd>
          </div>
        </dl>
      </article>
      <article v-if="proposal.productionNote">
        <strong>仅本次资产制作适用</strong>
        <p>{{ proposal.productionNote }}</p>
      </article>
      <template v-if="proposal.questions.length">
        <p>还有以下问题需要确认，请补充后再判断：</p>
        <ul>
          <li v-for="question in proposal.questions" :key="question">{{ question }}</li>
        </ul>
      </template>
      <p v-else-if="!canAdopt">没有找到需要应用的修改。可以补充更具体的说明，或暂不采用。</p>
      <p v-if="canAdopt && !proposal.changes.length && refreshImages" class="image-note">
        采用后会先保存资产文字，再生成受影响的已有参考图。生成可能产生费用。
      </p>
      <div class="actions">
        <BaseButton v-if="canAdopt" :disabled="disabled" @click="emit('decide', true)">
          {{
            proposal.changes.length
              ? '确认并保存到信息卡'
              : refreshImages
                ? '采用并更新资产和图片'
                : '采用要求并更新资产'
          }}
        </BaseButton>
        <BaseButton variant="secondary" :disabled="disabled" @click="showForm = !showForm">
          {{ showForm ? '收起说明' : '继续补充说明' }}
        </BaseButton>
        <BaseButton variant="secondary" :disabled="disabled" @click="emit('decide', false)"
          >暂不采用</BaseButton
        >
      </div>
    </template>
    <p v-else-if="review.state === 'DISMISSED'">
      已放弃本次建议，原内容保留。可以修改说明后重新判断。
    </p>
    <form v-if="showForm || review?.state === 'DISMISSED'" @submit.prevent="submit">
      <label>
        补充说明
        <textarea
          v-model="explanation"
          :maxlength="ASSET_CLARIFICATION_MAX_LENGTH"
          :disabled="disabled"
          placeholder="例如：杯身改为黑色，其他已确认规格沿用。容量还不确定，本次画面和口播不展示容量；背景继续用暖灰色。"
          rows="3"
        />
      </label>
      <BaseButton type="submit" :disabled="disabled || !explanation.trim()">
        补充说明并重新判断
      </BaseButton>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.asset-clarification {
  display: grid;
  gap: 12px;
  margin: 0 0 16px;
  padding: 16px 18px;
  border: 1px solid #e2e9f4;
  border-inline-start: 3px solid #d9a54c;
  border-radius: 10px;
  background: #f9fbff;
  color: #334861;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.asset-clarification.is-adopted {
  border-inline-start-color: #6e9cd3;
}
h3 {
  color: #23344d;
  font-size: 15px;
}
h3,
p,
dl,
ul,
dd {
  margin: 0;
}
ul {
  padding-inline-start: 1.4em;
}
li + li {
  margin-top: 6px;
}
form,
label,
article {
  display: grid;
  gap: 6px;
}
article {
  background: #fff;
  padding: 10px 12px;
  border: 1px solid #e2e9f4;
  border-radius: 8px;
}
dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
dt {
  color: #5e7087;
  font-size: 12px;
  font-weight: 600;
}
dd {
  white-space: pre-wrap;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.image-note {
  color: #5e7087;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  font: inherit;
  border: 1px solid #cddbeb;
  border-radius: 8px;
  resize: vertical;
}
.asset-clarification :deep(.base-button) {
  justify-self: start;
}
.error {
  color: #9e2424;
}
.original-note {
  white-space: pre-wrap;
}
@media (max-width: 600px) {
  dl {
    grid-template-columns: 1fr;
  }
}
</style>
