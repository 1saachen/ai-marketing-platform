<script setup lang="ts">
import type { ProductionTask } from '@ai-marketing/contracts';
defineProps<{
  scope: NonNullable<ProductionTask['assetUpdateScope']>;
  refreshImages?: boolean;
}>();
</script>
<template>
  <details class="asset-update-scope">
    <summary>
      资产更新明细 · 修改 {{ scope.filter((a) => a.action === 'UPDATE').length }} 项，保留
      {{ scope.filter((a) => a.action === 'KEEP').length }} 项，新增
      {{ scope.filter((a) => a.action === 'ADD').length }} 项
      <template v-if="scope.some((a) => a.action === 'SYNC')"
        >，仅同步依据 {{ scope.filter((a) => a.action === 'SYNC').length }} 项</template
      >
    </summary>
    <p v-if="refreshImages">这里列出资产定义的变化。只有受影响的已有参考图会随本次更新处理。</p>
    <p v-else>这里列出资产定义的变化。可从页头的「局部更新」检查已有参考图。</p>
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
        }}。{{ item.reason }}
      </li>
    </ul>
  </details>
</template>
<style scoped>
.asset-update-scope {
  margin: 12px 0;
  padding: 14px 18px;
  border: 1px solid #dce6f2;
  border-radius: 10px;
  background: #f8fafc;
  color: #34465e;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
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
