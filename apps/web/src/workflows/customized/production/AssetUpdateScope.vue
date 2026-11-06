<script setup lang="ts">
import type { ProductionTask } from '@ai-marketing/contracts';
defineProps<{ scope: NonNullable<ProductionTask['assetUpdateScope']> }>();
</script>
<template>
  <details class="asset-update-scope">
    <summary>
      本次资产更新判断：需修改 {{ scope.filter((a) => a.action === 'UPDATE').length }} 项，保留
      {{ scope.filter((a) => a.action === 'KEEP').length }} 项，新增
      {{ scope.filter((a) => a.action === 'ADD').length }} 项
      <template v-if="scope.some((a) => a.action === 'SYNC')"
        >，仅同步依据 {{ scope.filter((a) => a.action === 'SYNC').length }} 项</template
      >
    </summary>
    <p>根据本次任务的已保存判断展示；已有图片保留，需换图时请单独上传或生成。</p>
    <ul>
      <li v-for="(item, index) in scope" :key="index">
        <strong>{{ item.name }}</strong
        >：{{
          item.action === 'KEEP'
            ? '原样保留'
            : item.action === 'SYNC'
              ? '仅同步原文依据，定义保留'
              : item.action === 'ADD'
                ? '必要新增'
                : '定向修改'
        }}；{{ item.reason }}
      </li>
    </ul>
  </details>
</template>
<style scoped>
.asset-update-scope {
  margin: 12px 0;
  padding: 14px 18px;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  background: #fffbeb;
  color: #78350f;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  line-height: 1.7;
}
p,
li {
  font-size: 13px;
  line-height: 1.7;
}
ul {
  max-height: 320px;
  overflow: auto;
  padding-left: 20px;
}
</style>
