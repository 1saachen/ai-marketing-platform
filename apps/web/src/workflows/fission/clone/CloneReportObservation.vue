<script setup lang="ts">
import type { CloneObservation } from '@ai-marketing/contracts';
import { cloneEvidenceLabels, cloneObservationLabels, cloneTime } from './clone-presentation';
const props = defineProps<{ observation: CloneObservation; label: string; editing: boolean }>();
const emit = defineEmits<{ edit: [value: CloneObservation] }>();
function edit(patch: Partial<CloneObservation>) {
  emit('edit', { ...props.observation, ...patch });
}
</script>
<template>
  <div class="clone-observation">
    <div class="clone-observation-status">
      <b>{{ label }}</b
      ><span>{{ cloneObservationLabels[observation.status] }}</span
      ><small>置信度 {{ Math.round(observation.confidence * 100) }}%</small>
    </div>
    <label
      ><span>观察说明</span
      ><textarea
        :aria-label="`${label}观察说明`"
        :value="observation.summary"
        :readonly="!editing"
        @input="edit({ summary: ($event.target as HTMLTextAreaElement).value })"
      />
    </label>
    <label v-if="observation.reason || observation.status !== 'OBSERVED'"
      ><span>限制与原因</span
      ><textarea
        :aria-label="`${label}限制与原因`"
        :value="observation.reason"
        :readonly="!editing"
        @input="edit({ reason: ($event.target as HTMLTextAreaElement).value })"
      />
    </label>
    <details v-if="observation.evidence.length">
      <summary>查看 {{ observation.evidence.length }} 条依据</summary>
      <ul>
        <li v-for="(evidence, index) in observation.evidence" :key="index">
          <strong>{{ cloneEvidenceLabels[evidence.kind] }}</strong> ·
          {{ cloneTime(evidence.startMs) }}–{{ cloneTime(evidence.endMs) }}
          <p>{{ evidence.description }}</p>
        </li>
      </ul>
    </details>
  </div>
</template>
<style scoped>
.clone-observation {
  display: grid;
  gap: 10px;
  padding: 16px 20px;
  background: #f8faff;
  border-bottom: 1px solid #e5ecf7;
}
.clone-observation-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.clone-observation-status span {
  padding: 3px 8px;
  border-radius: 8px;
  background: #eaf0fc;
  color: #47618b;
}
.clone-observation-status small {
  color: #75839a;
  margin-left: auto;
}
label {
  display: grid;
  gap: 5px;
  color: #65748b;
  font-size: 11px;
}
textarea {
  width: 100%;
  min-height: 54px;
  padding: 9px 10px;
  border: 1px solid #dce5f2;
  border-radius: 7px;
  font: inherit;
  line-height: 1.6;
  color: #34435b;
  resize: vertical;
  background: white;
}
textarea[readonly] {
  background: #fbfcff;
}
details {
  color: #60718c;
  font-size: 11px;
}
summary {
  cursor: pointer;
}
ul {
  margin: 8px 0 0;
  padding-left: 18px;
}
p {
  margin: 4px 0 9px;
  line-height: 1.6;
}
</style>
