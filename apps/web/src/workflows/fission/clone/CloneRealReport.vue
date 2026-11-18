<script setup lang="ts">
import { ref } from 'vue';
import {
  BarChart3,
  Sparkles,
  Package,
  Film,
  Music,
  Palette,
  Play,
  AlertTriangle,
} from '@lucide/vue';
import type { CloneAnalysisReport, CloneObservation } from '@ai-marketing/contracts';
import CloneReportObservation from './CloneReportObservation.vue';
import { cloneElementLabels, cloneEvidenceLabels, cloneTime } from './clone-presentation';

const props = defineProps<{
  report: CloneAnalysisReport;
  productName: string;
  referenceName: string;
  referenceUrl: string;
  editing: boolean;
}>();
const emit = defineEmits<{ edit: [report: CloneAnalysisReport] }>();
const video = ref<HTMLVideoElement | null>(null);
const fields = {
  creativity: [
    ['concept', '核心创意'],
    ['emotion', '情绪共鸣'],
    ['contrast', '反差设计'],
    ['memoryPoints', '记忆锚点'],
  ],
  product: [
    ['originalProductDescription', '原产品与效果表达'],
    ['transferAdvice', '迁移建议与事实边界'],
  ],
  visual: [
    ['color', '色彩与滤镜'],
    ['stickers', '贴纸与装饰'],
    ['aspectRatio', '画幅'],
    ['safeArea', '构图安全区'],
  ],
} as const;
function update(path: (string | number)[], value: unknown) {
  const report = JSON.parse(JSON.stringify(props.report)) as CloneAnalysisReport;
  let object = report as unknown as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) object = object[key] as Record<string | number, unknown>;
  object[path.at(-1)!] = value;
  emit('edit', report);
}
function overview(
  section: 'structure' | 'creativity' | 'product' | 'visual',
  value: CloneObservation,
) {
  update([section, 'overview'], value);
}
function textValue(section: keyof typeof fields, key: string) {
  const value = (props.report[section] as unknown as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.join('\n') : String(value ?? '');
}
function textEdit(section: keyof typeof fields, key: string, value: string) {
  update(
    [section, key],
    ['memoryPoints', 'stickers'].includes(key)
      ? value.split('\n').filter((line) => line.trim())
      : value,
  );
}
function boundary(
  section: 'shots' | 'stages',
  index: number,
  edge: 'startMs' | 'endMs',
  value: string,
) {
  const milliseconds = Math.round(Number(value) * 1000);
  if (!Number.isFinite(milliseconds)) return;
  const report = JSON.parse(JSON.stringify(props.report)) as CloneAnalysisReport;
  const item = section === 'stages' ? report.structure.stages[index]! : report.shots[index]!;
  item[edge] = milliseconds;
  if (section === 'stages')
    report.structure.stages[index]!.proportion = (item.endMs - item.startMs) / report.durationMs;
  emit('edit', report);
}
function seek(milliseconds: number) {
  if (!video.value) return;
  video.value.currentTime = milliseconds / 1000;
  video.value.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
</script>
<template>
  <div class="frg-body clone-real-report">
    <div class="frg-report-meta">
      <div>
        <span>参考视频</span><b>{{ referenceName }}</b>
      </div>
      <div>
        <span>关联商品</span><b>{{ productName }}</b>
      </div>
      <div>
        <span>时长 / 画幅</span
        ><b
          >{{ cloneTime(report.durationMs) }} · {{ report.frameWidth }} ×
          {{ report.frameHeight }}</b
        >
      </div>
      <div><span>解析方式</span><b>抽帧视觉分析</b></div>
      <div>
        <span>报告状态</span><b>{{ editing ? '编辑草稿 · 尚未提交' : '已确认报告' }}</b>
      </div>
    </div>
    <div v-if="referenceUrl" class="clone-report-reference">
      <video ref="video" controls preload="metadata" :src="referenceUrl" />
      <p>点击镜头证据时间可定位参考画面。分析基于采样帧，短暂细节可能未被观察。</p>
    </div>
    <section class="frg-section">
      <header class="frg-section-head">
        <b>六维视频解析报告</b
        ><small>{{
          editing ? '编辑保存后才更新确认报告' : '画面观察、推断与识别限制分别记录'
        }}</small>
      </header>
      <div class="frg-dimensions">
        <article class="frg-dimension">
          <header>
            <span><BarChart3 :size="17" /></span><b>1. 结构</b><small>阶段与节奏</small>
          </header>
          <CloneReportObservation
            :observation="report.structure.overview"
            label="结构"
            :editing="editing"
            @edit="overview('structure', $event)"
          />
          <div class="frg-structure-track">
            <div
              v-for="stage in report.structure.stages"
              :key="stage.stageId"
              class="frg-structure-stage"
              :style="{ flex: Math.max(1, stage.endMs - stage.startMs) }"
            >
              <b>{{ stage.role }}</b
              ><span>{{ cloneTime(stage.startMs) }}–{{ cloneTime(stage.endMs) }}</span
              ><i />
            </div>
          </div>
          <div class="clone-stage-editors">
            <article v-for="(stage, index) in report.structure.stages" :key="stage.stageId">
              <strong>阶段 {{ index + 1 }} · {{ Math.round(stage.proportion * 1000) / 10 }}%</strong
              ><label
                >叙事作用<input
                  :value="stage.role"
                  :readonly="!editing"
                  :aria-label="`阶段${index + 1}叙事作用`"
                  @input="
                    update(
                      ['structure', 'stages', index, 'role'],
                      ($event.target as HTMLInputElement).value,
                    )
                  " /></label
              ><label
                >阶段说明<textarea
                  :value="stage.summary"
                  :readonly="!editing"
                  :aria-label="`阶段${index + 1}说明`"
                  @input="
                    update(
                      ['structure', 'stages', index, 'summary'],
                      ($event.target as HTMLTextAreaElement).value,
                    )
                  "
                />
              </label>
              <div class="clone-time-inputs">
                <label
                  >起点（秒）<input
                    type="number"
                    step="0.001"
                    min="0"
                    :value="stage.startMs / 1000"
                    :readonly="!editing"
                    :aria-label="`阶段${index + 1}起点秒`"
                    @input="
                      boundary(
                        'stages',
                        index,
                        'startMs',
                        ($event.target as HTMLInputElement).value,
                      )
                    " /></label
                ><label
                  >终点（秒）<input
                    type="number"
                    step="0.001"
                    min="0"
                    :value="stage.endMs / 1000"
                    :readonly="!editing"
                    :aria-label="`阶段${index + 1}终点秒`"
                    @input="
                      boundary('stages', index, 'endMs', ($event.target as HTMLInputElement).value)
                    "
                /></label>
              </div>
            </article>
          </div>
          <div class="clone-report-details">
            <p>
              钩子：{{
                report.structure.hookRanges
                  .map((range) => `${cloneTime(range.startMs)}–${cloneTime(range.endMs)}`)
                  .join('、') || '未识别'
              }}
            </p>
            <p>
              转化：{{
                report.structure.conversionRanges
                  .map((range) => `${cloneTime(range.startMs)}–${cloneTime(range.endMs)}`)
                  .join('、') || '未识别'
              }}
            </p>
            <p v-for="(point, index) in report.structure.rhythm" :key="index">
              {{ cloneTime(point.timeMs) }} · 节奏强度 {{ Math.round(point.intensity * 100) }}% ·
              {{ point.description }}
            </p>
          </div>
        </article>
        <article class="frg-dimension">
          <header>
            <span><Sparkles :size="17" /></span><b>2. 创意</b><small>创意与证据</small>
          </header>
          <CloneReportObservation
            :observation="report.creativity.overview"
            label="创意"
            :editing="editing"
            @edit="overview('creativity', $event)"
          />
          <div class="frg-dimension-fields">
            <div v-for="[key, label] in fields.creativity" :key="key" class="frg-dimension-field">
              <label :for="`clone-creative-${key}`">{{ label }}</label
              ><textarea
                :id="`clone-creative-${key}`"
                :value="textValue('creativity', key)"
                :readonly="!editing"
                @input="textEdit('creativity', key, ($event.target as HTMLTextAreaElement).value)"
              />
            </div>
          </div>
        </article>
        <article class="frg-dimension">
          <header>
            <span><Package :size="17" /></span><b>3. 产品</b
            ><small>原片观察不等于目标商品事实</small>
          </header>
          <CloneReportObservation
            :observation="report.product.overview"
            label="产品"
            :editing="editing"
            @edit="overview('product', $event)"
          />
          <div class="frg-dimension-fields">
            <div v-for="[key, label] in fields.product" :key="key" class="frg-dimension-field">
              <label :for="`clone-product-${key}`">{{ label }}</label
              ><textarea
                :id="`clone-product-${key}`"
                :value="textValue('product', key)"
                :readonly="!editing"
                @input="textEdit('product', key, ($event.target as HTMLTextAreaElement).value)"
              />
            </div>
            <div class="frg-dimension-field">
              <label for="clone-closeup">产品特写占比（%）</label
              ><input
                id="clone-closeup"
                type="number"
                min="0"
                max="100"
                step="0.1"
                :value="
                  report.product.closeupRatio === null ? '' : report.product.closeupRatio * 100
                "
                :readonly="!editing"
                placeholder="未识别"
                @input="
                  update(
                    ['product', 'closeupRatio'],
                    ($event.target as HTMLInputElement).value === ''
                      ? null
                      : Number(($event.target as HTMLInputElement).value) / 100,
                  )
                "
              />
            </div>
          </div>
        </article>
        <article class="frg-dimension">
          <header>
            <span><Film :size="17" /></span><b>4. 镜头</b
            ><small>{{ report.shots.length }} 个镜头 · 纵向时间线</small>
          </header>
          <div class="frg-shot-timeline">
            <article v-for="(shot, index) in report.shots" :key="shot.shotId" class="frg-shot-card">
              <div class="frg-shot-preview">
                <strong>镜头 {{ index + 1 }}</strong
                ><span class="frg-shot-time"
                  >{{ cloneTime(shot.startMs) }}–{{ cloneTime(shot.endMs) }}</span
                ><button class="frg-btn" :disabled="!referenceUrl" @click="seek(shot.startMs)">
                  <Play :size="13" />定位画面
                </button>
              </div>
              <div class="frg-shot-detail">
                <div class="clone-time-inputs">
                  <label
                    >起点（秒）<input
                      type="number"
                      min="0"
                      step="0.001"
                      :value="shot.startMs / 1000"
                      :readonly="!editing"
                      :aria-label="`镜头${index + 1}起点秒`"
                      @input="
                        boundary(
                          'shots',
                          index,
                          'startMs',
                          ($event.target as HTMLInputElement).value,
                        )
                      " /></label
                  ><label
                    >终点（秒）<input
                      type="number"
                      min="0"
                      step="0.001"
                      :value="shot.endMs / 1000"
                      :readonly="!editing"
                      :aria-label="`镜头${index + 1}终点秒`"
                      @input="
                        boundary('shots', index, 'endMs', ($event.target as HTMLInputElement).value)
                      "
                  /></label>
                </div>
                <label class="clone-stage-select"
                  >所属阶段<select
                    :value="shot.stageId"
                    :disabled="!editing"
                    :aria-label="`镜头${index + 1}所属阶段`"
                    @change="
                      update(
                        ['shots', index, 'stageId'],
                        ($event.target as HTMLSelectElement).value,
                      )
                    "
                  >
                    <option
                      v-for="stage in report.structure.stages"
                      :key="stage.stageId"
                      :value="stage.stageId"
                    >
                      {{ stage.role }}
                    </option>
                  </select></label
                >
                <div class="frg-shot-fields">
                  <div
                    v-for="[key, label] in [
                      ['framing', '景别'],
                      ['cameraMovement', '运镜'],
                      ['transition', '转场'],
                      ['composition', '构图'],
                    ] as const"
                    :key="key"
                    class="frg-shot-field"
                  >
                    <label :for="`real-shot-${index}-${key}`">{{ label }}</label
                    ><textarea
                      :id="`real-shot-${index}-${key}`"
                      :value="shot[key]"
                      :readonly="!editing"
                      @input="
                        update(['shots', index, key], ($event.target as HTMLTextAreaElement).value)
                      "
                    />
                  </div>
                </div>
                <p class="clone-shot-elements">
                  可见元素：{{
                    shot.elementIds
                      .map(
                        (id) =>
                          report.elements.find((element) => element.elementId === id)?.label ??
                          '未识别元素',
                      )
                      .join('、') || '无'
                  }}
                </p>
                <div class="clone-frame-points">
                  <span>证据帧</span
                  ><button
                    v-for="time in shot.evidenceFramesMs"
                    :key="time"
                    class="frg-btn"
                    :disabled="!referenceUrl"
                    @click="seek(time)"
                  >
                    {{ cloneTime(time) }}
                  </button>
                </div>
              </div>
            </article>
          </div>
        </article>
        <article class="frg-dimension">
          <header>
            <span><Music :size="17" /></span><b>5. 音频</b
            ><small
              >{{ report.audio.hasAudio ? '检测到音轨' : '未检测到音轨' }} · 内容识别受限</small
            >
          </header>
          <CloneReportObservation
            :observation="report.audio.overview"
            label="音频"
            :editing="editing"
            @edit="update(['audio', 'overview'], $event)"
          />
          <CloneReportObservation
            v-for="[key, label] in [
              ['voiceover', '口播'],
              ['bgm', '背景音乐'],
              ['soundEffects', '环境声与音效'],
            ] as const"
            :key="key"
            :observation="report.audio[key]"
            :label="label"
            :editing="editing"
            @edit="update(['audio', key], $event)"
          />
          <div class="clone-report-details">
            <p>节拍卡点：{{ report.audio.beatsMs.map(cloneTime).join('、') || '未识别' }}</p>
            <p>
              音效锚点：{{
                report.audio.soundEffectAnchorsMs.map(cloneTime).join('、') || '未识别'
              }}
            </p>
            <p>
              静音区间：{{
                report.audio.silenceRanges
                  .map((range) => `${cloneTime(range.startMs)}–${cloneTime(range.endMs)}`)
                  .join('、') || '未识别'
              }}
            </p>
            <p v-if="!report.audio.transcript.length">未提供可靠转录，原口播内容保留不可用。</p>
            <p v-for="line in report.audio.transcript" :key="line.transcriptId">
              {{ cloneTime(line.startMs) }}–{{ cloneTime(line.endMs) }} · {{ line.text }}（置信度
              {{ Math.round(line.confidence * 100) }}%）
            </p>
          </div>
        </article>
        <article class="frg-dimension">
          <header>
            <span><Palette :size="17" /></span><b>6. 视觉</b><small>字幕、色彩与安全区</small>
          </header>
          <CloneReportObservation
            :observation="report.visual.overview"
            label="视觉"
            :editing="editing"
            @edit="overview('visual', $event)"
          />
          <div class="frg-dimension-fields">
            <div v-for="[key, label] in fields.visual" :key="key" class="frg-dimension-field">
              <label :for="`clone-visual-${key}`">{{ label }}</label
              ><textarea
                :id="`clone-visual-${key}`"
                :value="textValue('visual', key)"
                :readonly="!editing"
                @input="textEdit('visual', key, ($event.target as HTMLTextAreaElement).value)"
              />
            </div>
          </div>
          <div class="clone-report-details">
            <article v-for="(subtitle, index) in report.visual.subtitles" :key="subtitle.elementId">
              <b>{{ subtitle.burnedIn ? '烧录字幕' : '独立字幕' }}</b
              ><label
                >文字<textarea
                  :value="subtitle.text"
                  :readonly="!editing"
                  :aria-label="`字幕${index + 1}文字`"
                  @input="
                    update(
                      ['visual', 'subtitles', index, 'text'],
                      ($event.target as HTMLTextAreaElement).value,
                    )
                  "
                /></label
              ><label
                >样式<input
                  :value="subtitle.style"
                  :readonly="!editing"
                  :aria-label="`字幕${index + 1}样式`"
                  @input="
                    update(
                      ['visual', 'subtitles', index, 'style'],
                      ($event.target as HTMLInputElement).value,
                    )
                  "
              /></label>
            </article>
            <p v-if="!report.visual.subtitles.length">未识别到可确认的字幕内容。</p>
          </div>
        </article>
      </div>
    </section>
    <section class="frg-section">
      <header class="frg-section-head">
        <b>识别元素与来源依据</b><small>{{ report.elements.length }} 个元素实例</small>
      </header>
      <div class="clone-element-evidence">
        <article v-for="(element, index) in report.elements" :key="element.elementId">
          <header>
            <b>{{ cloneElementLabels[element.type] }} · {{ element.label }}</b
            ><span
              >{{ element.type === 'product' ? '产品必换' : '可配置' }} ·
              {{ element.shotIds.length }} 个关联镜头</span
            >
          </header>
          <label
            >元素说明<textarea
              :value="element.description"
              :readonly="!editing"
              :aria-label="`元素${index + 1}说明`"
              @input="
                update(
                  ['elements', index, 'description'],
                  ($event.target as HTMLTextAreaElement).value,
                )
              "
            />
          </label>
          <p v-for="(evidence, evidenceIndex) in element.evidence" :key="evidenceIndex">
            {{ cloneEvidenceLabels[evidence.kind] }} · {{ cloneTime(evidence.startMs) }}–{{
              cloneTime(evidence.endMs)
            }}
            · {{ evidence.description }}
          </p>
        </article>
      </div>
    </section>
    <section class="frg-section">
      <header class="frg-section-head">
        <b>可迁移到当前商品的创作建议</b><small>目标商品事实优先</small>
      </header>
      <div class="frg-migrations">
        <article
          v-for="(suggestion, index) in report.transferSuggestions"
          :key="index"
          class="frg-migration"
        >
          <b>建议 {{ index + 1 }}</b
          ><textarea
            v-if="editing"
            :value="suggestion"
            :aria-label="`迁移建议${index + 1}`"
            @input="
              update(['transferSuggestions', index], ($event.target as HTMLTextAreaElement).value)
            "
          />
          <p v-else>{{ suggestion }}</p>
        </article>
      </div>
    </section>
    <section v-if="report.limitations.length" class="frg-section">
      <header class="frg-section-head">
        <b>识别限制与补充建议</b><small>未核实内容不能作为商品事实</small>
      </header>
      <div class="frg-warning-list">
        <article v-for="(limitation, index) in report.limitations" :key="index" class="frg-warning">
          <AlertTriangle :size="16" />
          <p>{{ limitation }}</p>
        </article>
      </div>
    </section>
  </div>
</template>
<style scoped>
.clone-report-reference {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 18px;
  align-items: center;
  margin-bottom: 20px;
  padding: 16px;
  border: 1px solid #e1e9f5;
  border-radius: 12px;
  background: #f7faff;
}
.clone-report-reference video {
  width: 100%;
  height: 170px;
  object-fit: contain;
  background: #172235;
  border-radius: 8px;
}
.clone-report-reference p {
  color: #718198;
  font-size: 12px;
  line-height: 1.8;
}
.clone-stage-editors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 0 20px 16px;
  gap: 12px;
}
.clone-stage-editors article {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e2e9f5;
  border-radius: 10px;
  font-size: 12px;
}
.clone-real-report label {
  display: grid;
  gap: 6px;
  color: #66768d;
  font-size: 11px;
}
.clone-real-report input,
.clone-real-report select,
.clone-real-report textarea {
  min-width: 0;
  max-width: 100%;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid #dce5f2;
  border-radius: 7px;
  font: inherit;
  color: #34435b;
  background: #fff;
}
.clone-real-report textarea {
  min-height: 60px;
  resize: vertical;
  line-height: 1.65;
}
.clone-real-report [readonly] {
  background: #fbfcff;
}
.clone-time-inputs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}
.clone-report-details {
  padding: 12px 20px 18px;
  color: #65748b;
  font-size: 12px;
  line-height: 1.8;
}
.clone-report-details article {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}
.clone-stage-select {
  margin-bottom: 12px;
}
.frg-shot-preview {
  padding: 18px 12px;
  gap: 8px;
  background: #eaf1ff;
  color: #3c6397;
}
.frg-shot-preview .frg-shot-time {
  position: static;
  color: #56718f;
  font-size: 10px;
}
.frg-shot-preview .frg-btn {
  color: #3c6397;
  background: #fff;
}
.clone-shot-elements {
  color: #65748b;
  font-size: 11px;
  line-height: 1.8;
}
.clone-frame-points {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  color: #73829a;
  font-size: 11px;
}
.clone-frame-points button {
  padding: 4px 7px;
}
.clone-element-evidence {
  display: grid;
  gap: 12px;
}
.clone-element-evidence article {
  padding: 14px;
  border: 1px solid #e1e9f5;
  border-radius: 10px;
}
.clone-element-evidence header {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: space-between;
  margin-bottom: 10px;
  font-size: 12px;
}
.clone-element-evidence span,
.clone-element-evidence p {
  font-size: 11px;
  color: #78889e;
  line-height: 1.7;
}
@media (max-width: 720px) {
  .clone-report-reference,
  .clone-stage-editors {
    grid-template-columns: 1fr;
  }
  .clone-report-reference video {
    height: 200px;
  }
  .clone-stage-editors {
    padding: 0 12px 12px;
  }
}
</style>
