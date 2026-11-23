<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { LockKeyhole, ArrowRight, Boxes, AlertTriangle, X } from '@lucide/vue';
import type {
  Asset,
  CloneAnalysisReport,
  CloneCapabilities,
  CloneGenerationImage,
  CloneMappingBinding,
  CloneMappingDraft,
  CloneMappingTarget,
} from '@ai-marketing/contracts';
import { getAssetVersion } from '../../../platform/asset/api/asset.api';
import AssetPreview from '../../../platform/asset/components/AssetPreview.vue';
import CloneAssetPicker from './CloneAssetPicker.vue';
import CloneIcon from './CloneIcon.vue';
import { cloneElementLabels, cloneTime } from './clone-presentation';

const props = defineProps<{
  projectId: string;
  draft: CloneMappingDraft;
  report: CloneAnalysisReport;
  productName: string;
  capabilities: CloneCapabilities;
  disabled: boolean;
  error: string;
  prepareAsset: (assetId: string, version: number) => Promise<boolean>;
}>();
const emit = defineEmits<{ edit: [binding: CloneMappingBinding] }>();
const selected = ref('');
const tab = ref<'assets' | 'impact'>('assets');
const library = ref(false);
const selectionError = ref('');
const targetAsset = ref<Asset | null>(null);
const assetError = ref('');
let assetRequest: AbortController | undefined;
const source = computed(
  () =>
    props.report.elements.find((element) => element.elementId === selected.value) ??
    props.report.elements[0],
);
const binding = computed(() =>
  props.draft.bindings.find((item) => item.elementId === source.value?.elementId),
);
const target = computed(() => binding.value?.target);
const isProp = computed(() => source.value?.type === 'prop');
const isTextElement = computed(
  () => source.value?.type === 'subtitle' || source.value?.type === 'voiceover',
);
const isAudio = computed(() => source.value?.type === 'bgm' || source.value?.type === 'voiceover');
const targetImageTypes: CloneGenerationImage['mimeType'][] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
const targetPrefixes = computed(() =>
  isAudio.value
    ? ['audio/']
    : source.value?.type === 'subtitle'
      ? ['text/', 'application/x-subrip']
      : source.value?.type === 'product' || source.value?.type === 'scene'
        ? targetImageTypes
        : ['image/', 'video/'],
);
const keepBlocked = computed(() => {
  if (!source.value) return '';
  if (source.value.type === 'product') return '每个必换商品都需要绑定一张目标图片。';
  if (isAudio.value) return '当前尚未验证独立原声轨道的保留能力，请使用替换配置。';
  if (source.value.type === 'subtitle')
    return source.value.sourceTrack === 'BURNED_IN'
      ? '当前不能可靠保留烧录字幕，请选择替换；已识别文字可在内容策略中单独保留并核对。'
      : '当前未开放原字幕表现保留，请选择替换；已识别文字可在内容策略中单独保留并核对。';
  return '';
});
function complete(item: CloneMappingBinding) {
  if (item.action === 'KEEP') return ['person', 'scene', 'prop'].includes(item.type);
  if (item.type === 'prop') return false;
  if (item.type === 'product') return !!item.target?.asset;
  return !!(item.target?.asset || item.target?.text.trim() || item.target?.style.trim());
}
const completed = computed(() => props.draft.bindings.filter(complete).length);
const required = computed(() =>
  props.report.elements.filter((element) => element.type === 'product'),
);
const requiredComplete = computed(
  () =>
    required.value.filter((element) => {
      const item = props.draft.bindings.find((entry) => entry.elementId === element.elementId);
      return item?.action === 'REPLACE' && complete(item);
    }).length,
);
const impact = computed(() =>
  props.report.shots.filter((shot) => binding.value?.shotIds.includes(shot.shotId)),
);
function newTarget(): CloneMappingTarget {
  return {
    asset: null,
    text: '',
    style: '',
    voice: '',
    contentStrategy: isTextElement.value ? 'REPLACE' : 'NONE',
    presentationStrategy: isTextElement.value ? 'REPLACE' : 'NONE',
    lockedAttributes: [],
    allowedVariations: [],
  };
}
function patchTarget(patch: Partial<CloneMappingTarget>) {
  if (binding.value?.action !== 'REPLACE' || props.disabled || isProp.value) return;
  emit('edit', {
    ...binding.value,
    target: { ...(binding.value.target ?? newTarget()), ...patch },
  });
}
function setAction(action: 'KEEP' | 'REPLACE') {
  if (!binding.value || props.disabled || (action === 'KEEP' ? keepBlocked.value : isProp.value))
    return;
  emit('edit', {
    ...binding.value,
    action,
    target: action === 'KEEP' ? null : (binding.value.target ?? newTarget()),
  });
}
function selectElement(elementId: string) {
  selected.value = elementId;
  tab.value = 'assets';
  library.value = false;
}
async function chooseAsset(assetId: string, version: number, asset: Asset) {
  selectionError.value = '';
  const elementId = source.value?.elementId;
  if (!elementId) return;
  if (!(await props.prepareAsset(assetId, version))) {
    selectionError.value = props.error || '目标素材准备失败，请重试';
    return;
  }
  if (source.value?.elementId !== elementId) return;
  patchTarget({ asset: { assetId, version } });
  targetAsset.value = asset;
  library.value = false;
}
watch(
  [
    () => props.projectId,
    isProp,
    () => target.value?.asset?.assetId,
    () => target.value?.asset?.version,
  ],
  async ([projectId, prop, assetId, version]) => {
    assetRequest?.abort();
    targetAsset.value = null;
    assetError.value = '';
    if (prop || !assetId || !version) return;
    const request = new AbortController();
    assetRequest = request;
    try {
      const response = await getAssetVersion(projectId, assetId, version, request.signal);
      if (!request.signal.aborted) targetAsset.value = response.data;
    } catch {
      if (!request.signal.aborted)
        assetError.value = '目标素材预览暂不可用；确认时仍会核对资产版本。';
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => assetRequest?.abort());
</script>
<template>
  <div class="frg-map-body clone-real-mapping">
    <section class="frg-lock-panel">
      <header class="frg-lock-head">
        <span><LockKeyhole :size="18" /></span>
        <div>
          <b>原视频结构时间线（锁定）</b
          ><small>按已确认报告锁定原片的镜头顺序、切点与阶段边界</small>
        </div>
        <div class="frg-lock-meta">
          <em>{{ cloneTime(report.durationMs) }}</em
          ><em>{{ report.structure.stages.length }} 个阶段</em
          ><em>{{ report.shots.length }} 个镜头</em
          ><strong class="frg-lock-status"><LockKeyhole :size="12" />结构已锁定</strong>
        </div>
      </header>
      <div class="frg-map-timeline">
        <div
          v-for="stage in report.structure.stages"
          :key="stage.stageId"
          class="frg-map-stage"
          :style="{ flex: Math.max(1, stage.endMs - stage.startMs) }"
        >
          <b>{{ stage.role }}</b
          ><span>{{ cloneTime(stage.startMs) }}–{{ cloneTime(stage.endMs) }}</span>
        </div>
      </div>
    </section>
    <div v-if="!source" class="clone-empty">
      <Boxes :size="28" />
      <h3>报告中没有可映射元素</h3>
      <p>可以返回深度拆解检查报告内容；映射确认仍由服务端校验。</p>
    </div>
    <section v-else class="fem-layout">
      <aside class="fem-sidebar">
        <header class="fem-sidebar-head">
          <b>原视频元素</b><small>按实际识别实例逐项映射</small>
        </header>
        <div class="fem-nav">
          <button
            v-for="element in report.elements"
            :key="element.elementId"
            class="fem-nav-card"
            :class="{ active: element.elementId === source.elementId }"
            @click="selectElement(element.elementId)"
          >
            <span class="fem-nav-icon"><CloneIcon :type="element.type" /></span
            ><span class="fem-nav-copy"
              ><strong>{{ element.label }}</strong
              ><span
                >{{ cloneElementLabels[element.type] }} · {{ element.shotIds.length }} 个镜头</span
              ></span
            ><span class="fem-nav-meta"
              ><em :class="{ required: element.type === 'product' }">{{
                element.type === 'product'
                  ? '必换'
                  : element.type === 'prop'
                    ? '镜头参考'
                    : '可配置'
              }}</em
              ><i
                :class="{
                  done: !!draft.bindings.find(
                    (item) => item.elementId === element.elementId && complete(item),
                  ),
                }"
                >{{
                  draft.bindings.find(
                    (item) => item.elementId === element.elementId && complete(item),
                  )
                    ? '已配置'
                    : '待配置'
                }}</i
              ></span
            >
          </button>
        </div>
        <div class="fem-summary">
          <div class="fem-summary-head">
            <span>映射配置完整度</span
            ><b>{{ Math.round((completed / Math.max(1, report.elements.length)) * 100) }}%</b>
          </div>
          <div class="fem-summary-track">
            <i :style="{ width: `${(completed / Math.max(1, report.elements.length)) * 100}%` }" />
          </div>
          <div class="fem-summary-grid">
            <span
              >必换完成 <b>{{ requiredComplete }}/{{ required.length }}</b></span
            ><span
              >待配置 <b>{{ Math.max(0, report.elements.length - completed) }}</b></span
            >
          </div>
          <p class="clone-mapping-note">配置完整度不替代服务端校验与保留文本核对。</p>
        </div>
      </aside>
      <div class="fem-workspace">
        <header class="fem-workspace-head">
          <div class="fem-workspace-title">
            <strong>{{ source.label }}映射工作区</strong
            ><span
              >{{ cloneElementLabels[source.type] }} · {{ source.shotIds.length }} 个关联镜头</span
            >
          </div>
          <span class="fem-confidence">识别置信度 {{ Math.round(source.confidence * 100) }}%</span>
          <div class="fem-strategy">
            <button
              v-if="!isProp"
              :class="{ active: binding?.action === 'REPLACE' }"
              :disabled="disabled || !binding"
              @click="setAction('REPLACE')"
            >
              替换</button
            ><button
              :class="{ active: binding?.action === 'KEEP' }"
              :disabled="disabled || !binding || !!keepBlocked"
              :title="keepBlocked"
              @click="setAction('KEEP')"
            >
              {{ isProp ? '保留为镜头参考' : '保留' }}
            </button>
          </div>
        </header>
        <section class="fem-flow">
          <article class="fem-flow-card">
            <span class="fem-flow-visual"><CloneIcon :type="source.type" /></span>
            <div class="fem-flow-copy">
              <span>原片识别元素</span><strong>{{ source.label }}</strong
              ><small>{{ source.description }}</small>
            </div>
          </article>
          <div class="fem-flow-arrow">
            <ArrowRight :size="19" /><small>{{
              isProp ? '参考' : binding?.action === 'KEEP' ? '保留' : '映射'
            }}</small>
          </div>
          <article class="fem-flow-card target" :class="{ empty: !binding || !complete(binding) }">
            <span class="fem-flow-visual"><CloneIcon :type="source.type" /></span>
            <div class="fem-flow-copy">
              <span>{{ isProp ? '镜头参考' : '目标配置' }}</span
              ><strong>{{
                isProp
                  ? source.label
                  : binding?.action === 'KEEP'
                    ? '保留已确认的视觉特征'
                    : targetAsset?.name || target?.text || '尚未配置目标'
              }}</strong
              ><small>{{
                isProp
                  ? '参考原片中的位置和构图关系'
                  : target?.asset
                    ? `已锁定资产第 ${target.asset.version} 版`
                    : binding?.action === 'KEEP'
                      ? '保留配置与外观目标，不承诺逐像素一致'
                      : source.type === 'product' && productName
                        ? `目标商品 ${productName}`
                        : '按当前元素选择目标素材'
              }}</small>
            </div>
          </article>
        </section>
        <nav class="fem-tabs">
          <button :class="{ active: tab === 'assets' }" @click="tab = 'assets'">
            {{ isProp ? '镜头参考' : '目标配置' }}</button
          ><button :class="{ active: tab === 'impact' }" @click="tab = 'impact'">镜头影响</button
          ><span class="grow" />
        </nav>
        <div v-if="tab === 'assets'" class="fem-pane">
          <div v-if="keepBlocked" class="clone-mapping-warning">
            <AlertTriangle :size="15" />{{ keepBlocked }}
          </div>
          <div v-if="!binding" class="frg-map-empty"><p>请先按当前报告初始化映射配置。</p></div>
          <div v-else-if="isProp" class="fem-retain-empty">
            <div v-if="binding.action === 'KEEP'">
              <b>已保留为镜头参考</b>
              <p>可在「镜头影响」查看这个道具出现的区间、运镜和构图。</p>
            </div>
            <div v-else>
              <b>此道具仍使用旧替换配置</b>
              <p>需要单独更换这个道具时，可以使用局部元素替换。</p>
            </div>
          </div>
          <div v-else-if="binding.action === 'KEEP'" class="fem-retain-empty">
            <div>
              <b>保留{{ source.label }}的配置与视觉特征</b>
              <p>结构时间线保持锁定。</p>
            </div>
          </div>
          <div v-else class="clone-target-editor">
            <div class="clone-target-asset">
              <div>
                <b>项目资产精确版本</b>
                <small v-if="source.type === 'product'">
                  请选择当前项目的 JPEG、PNG 或 WebP 目标商品图片。
                </small>
                <small v-else-if="source.type === 'scene'">
                  可以选择同项目参考图片，或填写明确的场景描述。
                </small>
                <small v-else>可以选择同项目素材，也可以填写明确的目标描述。</small>
              </div>
              <button
                class="frg-btn"
                :disabled="disabled"
                @click="
                  selectionError = '';
                  library = true;
                "
              >
                <Boxes :size="14" />选择项目资产
              </button>
            </div>
            <article v-if="target?.asset" class="clone-selected-asset">
              <div v-if="targetAsset" class="clone-selected-preview">
                <audio
                  v-if="targetAsset.mimeType.startsWith('audio/')"
                  controls
                  preload="metadata"
                  :src="targetAsset.contentUrl"
                /><AssetPreview v-else :asset="targetAsset" compact file-preview />
              </div>
              <div>
                <b>{{ targetAsset?.name || '已选择目标资产' }}</b
                ><small>锁定第 {{ target.asset.version }} 版</small>
                <p v-if="assetError">{{ assetError }}</p>
              </div>
              <button
                class="frg-btn"
                :disabled="disabled"
                aria-label="移除目标资产选择"
                @click="patchTarget({ asset: null })"
              >
                <X :size="14" />
              </button>
            </article>
            <template v-if="isTextElement"
              ><div class="clone-target-policies">
                <label
                  >内容策略<select
                    :value="target?.contentStrategy ?? 'REPLACE'"
                    :disabled="disabled"
                    @change="
                      patchTarget({
                        contentStrategy: ($event.target as HTMLSelectElement)
                          .value as CloneMappingTarget['contentStrategy'],
                        ...(($event.target as HTMLSelectElement).value === 'KEEP'
                          ? { text: source.transcriptText }
                          : {}),
                      })
                    "
                  >
                    <option value="REPLACE">替换为目标商品文案</option>
                    <option value="KEEP" :disabled="!source.transcriptText.trim()">
                      保留已识别文字（须核对）
                    </option>
                  </select></label
                ><label
                  >表现形式<select
                    :value="target?.presentationStrategy ?? 'REPLACE'"
                    :disabled="disabled"
                    @change="
                      patchTarget({
                        presentationStrategy: ($event.target as HTMLSelectElement)
                          .value as CloneMappingTarget['presentationStrategy'],
                      })
                    "
                  >
                    <option value="REPLACE">使用新的表现配置</option>
                    <option value="KEEP" disabled>保留原表现（暂不可用）</option>
                  </select></label
                >
              </div>
              <p v-if="target?.contentStrategy === 'KEEP'" class="clone-mapping-note">
                确认前请显式运行“核对保留文本”；商品事实或映射内容变化后须重新核对。
              </p></template
            >
            <label
              >{{ isTextElement ? '目标文字内容' : '目标元素描述与依据'
              }}<textarea
                :value="target?.text ?? ''"
                :disabled="disabled"
                :readonly="target?.contentStrategy === 'KEEP'"
                :aria-label="`${source.label}目标描述`"
                :placeholder="
                  source.type === 'product'
                    ? '根据已提供商品事实填写目标产品，不继承原商品功效'
                    : '明确描述需要替换的目标内容'
                "
                @input="patchTarget({ text: ($event.target as HTMLTextAreaElement).value })"
              />
            </label>
            <label
              >样式与表现要求<textarea
                :value="target?.style ?? ''"
                :disabled="disabled"
                :aria-label="`${source.label}样式要求`"
                @input="patchTarget({ style: ($event.target as HTMLTextAreaElement).value })"
              />
            </label>
            <p v-if="source.type === 'voiceover'" class="clone-mapping-note">
              任意音色克隆尚未开放，当前不承诺保留原说话者声音。
            </p>
            <div class="clone-target-policies">
              <label
                >需要保持的特征（每行一项）<textarea
                  :value="target?.lockedAttributes.join('\n') ?? ''"
                  :disabled="disabled"
                  :aria-label="`${source.label}锁定特征`"
                  @input="
                    patchTarget({
                      lockedAttributes: ($event.target as HTMLTextAreaElement).value
                        .split('\n')
                        .filter((line) => line.trim()),
                    })
                  "
                /></label
              ><label
                >允许调整的内容（每行一项）<textarea
                  :value="target?.allowedVariations.join('\n') ?? ''"
                  :disabled="disabled"
                  :aria-label="`${source.label}允许变化`"
                  @input="
                    patchTarget({
                      allowedVariations: ($event.target as HTMLTextAreaElement).value
                        .split('\n')
                        .filter((line) => line.trim()),
                    })
                  "
                />
              </label>
            </div>
          </div>
        </div>
        <div v-else class="fem-pane">
          <div class="fem-impact-label">
            <b>镜头影响与连续性</b><span>仅列此元素实际关联的镜头</span>
          </div>
          <p v-if="isProp" class="clone-mapping-note">
            出现区间
            {{
              source.ranges
                .map((range) => `${cloneTime(range.startMs)}–${cloneTime(range.endMs)}`)
                .join('、')
            }}
          </p>
          <div class="clone-impact-shots">
            <article v-for="shot in impact" :key="shot.shotId">
              <b>{{ cloneTime(shot.startMs) }}–{{ cloneTime(shot.endMs) }} · {{ shot.framing }}</b>
              <p>{{ shot.cameraMovement }} · {{ shot.composition }}</p>
              <small>{{
                isProp
                  ? '作为该镜头的画面参考'
                  : binding?.action === 'KEEP'
                    ? '保留已确认的视觉特征'
                    : '使用当前替换目标，结构与时序不变'
              }}</small>
            </article>
          </div>
        </div>
      </div>
    </section>
    <div v-if="requiredComplete < required.length" class="fem-gate-note">
      已绑定目标图片 {{ requiredComplete }} /
      {{ required.length }} 项。确认时还会检查来源与资产版本。
    </div>
    <CloneAssetPicker
      v-if="library && source && !isProp"
      :project-id="projectId"
      :title="`选择${cloneElementLabels[source.type]}目标素材`"
      :mime-prefixes="targetPrefixes"
      :busy="disabled"
      :operation-error="selectionError"
      @close="library = false"
      @select="chooseAsset"
    />
  </div>
</template>
<style scoped>
.clone-real-mapping .frg-map-stage {
  min-width: 90px;
}
.clone-real-mapping .frg-map-timeline {
  overflow-x: auto;
}
.clone-mapping-note {
  margin: 9px 0;
  color: #71819a;
  font-size: 11px;
  line-height: 1.75;
}
.clone-mapping-warning {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 10px 12px;
  margin-bottom: 14px;
  border-radius: 8px;
  background: #fff7e7;
  color: #94681c;
  font-size: 12px;
  line-height: 1.7;
}
.clone-mapping-warning svg {
  flex-shrink: 0;
  margin-top: 3px;
}
.clone-target-editor {
  display: grid;
  gap: 15px;
}
.clone-target-editor label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  color: #65768c;
}
.clone-target-editor textarea,
.clone-target-editor select {
  width: 100%;
  min-width: 0;
  border: 1px solid #dce5f1;
  border-radius: 8px;
  padding: 10px 12px;
  font: inherit;
  color: #3d4d66;
  background: white;
}
.clone-target-editor textarea {
  min-height: 82px;
  resize: vertical;
  line-height: 1.7;
}
.clone-target-asset {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.clone-target-asset div {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: #41546f;
}
.clone-target-asset small {
  color: #7d8aa0;
  font-size: 11px;
}
.clone-target-asset button {
  display: flex;
  gap: 6px;
  align-items: center;
}
.clone-selected-asset {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #c7daf7;
  border-radius: 10px;
  background: #f6f9ff;
}
.clone-selected-asset > div:not(.clone-selected-preview) {
  display: grid;
  gap: 6px;
  font-size: 12px;
  flex: 1;
  min-width: 0;
}
.clone-selected-asset small,
.clone-selected-asset p {
  color: #78879b;
  font-size: 11px;
}
.clone-selected-preview {
  width: 130px;
  height: 90px;
  overflow: hidden;
  border-radius: 7px;
}
.clone-selected-preview :deep(.v4-preview) {
  height: 90px;
}
.clone-selected-preview audio {
  width: 100%;
  height: 90px;
}
.clone-target-policies {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.clone-real-mapping .fem-flow-copy small {
  white-space: normal;
  line-height: 1.7;
}
.clone-real-mapping .fem-flow-copy strong {
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  .clone-target-asset {
    align-items: flex-start;
    flex-direction: column;
  }
  .clone-target-policies {
    grid-template-columns: 1fr;
  }
  .clone-selected-asset {
    flex-wrap: wrap;
  }
  .clone-real-mapping .fem-flow-copy small {
    display: block;
  }
}
</style>
