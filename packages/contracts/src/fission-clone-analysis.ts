import {
  array,
  enumeration,
  fail,
  integer,
  nullable,
  object,
  parse,
  published,
  text,
  type Schema,
} from './fission-clone-schema';
import {
  CLONE_UUID_PATTERN,
  type CloneArtifactRef,
  type CloneInputDraft,
  type CloneUpload,
} from './fission-clone';

export const CLONE_ANALYSIS_ARTIFACT_KEY = 'clone-analysis';
export const CLONE_MAPPING_ARTIFACT_KEY = 'clone-mapping';
export const CLONE_ELEMENT_TYPES = [
  'product',
  'person',
  'scene',
  'subtitle',
  'bgm',
  'voiceover',
] as const;
export type CloneElementType = (typeof CLONE_ELEMENT_TYPES)[number];
export const CLONE_TASK_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type CloneTaskStatus = (typeof CLONE_TASK_STATUSES)[number];
export type CloneTaskOperation = 'ANALYZE' | 'MAP_SUGGEST';
export type CloneMappingPurpose = 'SMART_MATCH' | 'VALIDATE_KEEP_TEXT';
export type CloneTimeRange = { startMs: number; endMs: number };
export type CloneEvidence = CloneTimeRange & {
  kind: 'VISUAL' | 'TRANSCRIPT' | 'INFERENCE' | 'UNASSESSED';
  description: string;
  confidence: number;
};
export type CloneObservation = {
  status: 'OBSERVED' | 'NOT_DETECTED' | 'UNASSESSED' | 'NOT_APPLICABLE';
  summary: string;
  reason: string;
  confidence: number;
  evidence: CloneEvidence[];
};
export type CloneStage = CloneTimeRange & {
  stageId: string;
  role: string;
  summary: string;
  /** Fraction of the entire reference duration, 0–1. */
  proportion: number;
};
export type CloneShot = CloneTimeRange & {
  shotId: string;
  stageId: string;
  framing: string;
  cameraMovement: string;
  transition: string;
  composition: string;
  elementIds: string[];
  evidenceFramesMs: number[];
};
export type CloneElement = {
  elementId: string;
  type: CloneElementType;
  label: string;
  description: string;
  shotIds: string[];
  ranges: CloneTimeRange[];
  evidence: CloneEvidence[];
  /** Every product instance must be replaced, not only the first product. */
  required: boolean;
  transcriptText: string;
  sourceTrack: 'VISUAL' | 'BURNED_IN' | 'AUDIO_MIX' | 'INDEPENDENT' | 'UNKNOWN';
  confidence: number;
};
export type CloneAnalysisReport = {
  schemaVersion: 1;
  durationMs: number;
  frameWidth: number;
  frameHeight: number;
  structure: {
    overview: CloneObservation;
    stages: CloneStage[];
    hookRanges: CloneTimeRange[];
    conversionRanges: CloneTimeRange[];
    rhythm: { timeMs: number; intensity: number; description: string }[];
  };
  creativity: {
    overview: CloneObservation;
    concept: string;
    emotion: string;
    contrast: string;
    memoryPoints: string[];
  };
  product: {
    overview: CloneObservation;
    originalProductDescription: string;
    closeupRatio: number | null;
    transferAdvice: string;
  };
  shots: CloneShot[];
  audio: {
    overview: CloneObservation;
    hasAudio: boolean;
    voiceover: CloneObservation;
    bgm: CloneObservation;
    soundEffects: CloneObservation;
    transcript: (CloneTimeRange & { transcriptId: string; text: string; confidence: number })[];
    beatsMs: number[];
    soundEffectAnchorsMs: number[];
    silenceRanges: CloneTimeRange[];
  };
  visual: {
    overview: CloneObservation;
    subtitles: { elementId: string; text: string; style: string; burnedIn: boolean }[];
    color: string;
    stickers: string[];
    aspectRatio: string;
    safeArea: string;
  };
  elements: CloneElement[];
  transferSuggestions: string[];
  limitations: string[];
};
export type CloneAnalysisDraft = {
  schemaVersion: 1;
  sourceInput: CloneArtifactRef | null;
  /** Analysis revision on which this isolated human edit started. */
  baseAnalysisRevision: number;
  report: CloneAnalysisReport | null;
};
export type CloneAssetVersionRef = { assetId: string; version: number };
export type CloneMappingTarget = {
  asset: CloneAssetVersionRef | null;
  text: string;
  style: string;
  voice: string;
  contentStrategy: 'KEEP' | 'REPLACE' | 'NONE';
  presentationStrategy: 'KEEP' | 'REPLACE' | 'NONE';
  lockedAttributes: string[];
  allowedVariations: string[];
};
export type CloneMappingBinding = {
  elementId: string;
  type: CloneElementType;
  action: 'KEEP' | 'REPLACE';
  shotIds: string[];
  target: CloneMappingTarget | null;
};
export type CloneStructureLock = {
  durationMs: number;
  stages: CloneStage[];
  shots: (CloneTimeRange & { shotId: string; stageId: string })[];
  beatsMs: number[];
  soundEffectAnchorsMs: number[];
  hookRanges: CloneTimeRange[];
  conversionRanges: CloneTimeRange[];
};
export type CloneMappingDraft = {
  schemaVersion: 1;
  sourceInput: CloneArtifactRef | null;
  sourceAnalysis: CloneArtifactRef | null;
  bindings: CloneMappingBinding[];
  structureLock: CloneStructureLock | null;
};
export type CloneAnalysisConfirmed = {
  ref: CloneArtifactRef;
  sourceInput: CloneArtifactRef;
  report: CloneAnalysisReport;
  freshness: 'CURRENT' | 'STALE';
};
export type CloneMappingConfirmed = {
  ref: CloneArtifactRef;
  mapping: CloneMappingDraft;
  freshness: 'CURRENT' | 'STALE';
};
export type CloneKeepTextCheck = {
  elementId: string;
  passed: boolean;
  reason: string;
  evidence: string[];
};
export type CloneKeepTextEvidence = {
  taskId: string;
  sourceInput: CloneArtifactRef;
  sourceAnalysis: CloneArtifactRef;
  /** Hash of canonical mapping business content, never its editing revision. */
  mappingHash: string;
  checks: CloneKeepTextCheck[];
};
export type CloneTaskResult =
  | { operation: 'ANALYZE'; report: CloneAnalysisReport }
  | {
      operation: 'MAP_SUGGEST';
      purpose: 'SMART_MATCH';
      mapping: CloneMappingDraft;
      notes: string[];
    }
  | { operation: 'MAP_SUGGEST'; purpose: 'VALIDATE_KEEP_TEXT'; checks: CloneKeepTextCheck[] };
export type CloneTask = {
  id: string;
  operation: CloneTaskOperation;
  purpose: CloneMappingPurpose | null;
  status: CloneTaskStatus;
  progress: number;
  stage: string;
  message: string;
  error: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  canRetry: boolean;
  suggestionPending: boolean;
  appliedToDraft: boolean;
  result: CloneTaskResult | null;
};
export type CloneG2Workspace = {
  generationActive?: boolean;
  analysisDraft: { revision: number; state: CloneAnalysisDraft };
  mappingDraft: { revision: number; state: CloneMappingDraft };
  analysis: CloneAnalysisConfirmed | null;
  mapping: CloneMappingConfirmed | null;
  tasks: CloneTask[];
  keepTextEvidence: CloneKeepTextEvidence[];
  /** True when a background report committed while an isolated human edit was kept. */
  analysisDraftDiverged: boolean;
};
export type CloneTaskCreateRequest = {
  idempotencyKey: string;
  sourceInput: CloneArtifactRef;
  sourceAnalysis: CloneArtifactRef | null;
  expectedDraftRevision: number;
  expectedArtifactRevision: number;
  purpose: CloneMappingPurpose | null;
};
export type CloneAnalysisDraftSaveRequest = { expectedRevision: number; state: CloneAnalysisDraft };
export type CloneMappingDraftSaveRequest = { expectedRevision: number; state: CloneMappingDraft };
export type CloneAnalysisConfirmRequest = {
  expectedDraftRevision: number;
  expectedAnalysisRevision: number;
};
export type CloneMappingConfirmRequest = {
  expectedDraftRevision: number;
  expectedMappingRevision: number;
};
export type CloneSuggestionAdoptRequest = { expectedDraftRevision: number };
/** Internal frozen identity. Content is read from the protected task endpoint, never an arbitrary URL. */
export type CloneTaskFile = Omit<CloneUpload, 'id' | 'contentUrl' | 'role'> & { role: string };
export type CloneMappingCandidate = {
  sourceVersionId: string;
  assetId: string;
  version: number;
  name: string;
  type: string;
  mimeType: string;
  file: CloneTaskFile | null;
};
export type CloneTaskSnapshot = {
  schemaVersion: 1;
  operation: CloneTaskOperation;
  purpose: CloneMappingPurpose | null;
  input: { ref: CloneArtifactRef; input: CloneInputDraft; files: CloneTaskFile[] };
  analysis: { ref: CloneArtifactRef; report: CloneAnalysisReport } | null;
  mapping: CloneMappingDraft | null;
  candidates: CloneMappingCandidate[];
  expectedDraftRevision: number;
  expectedArtifactRevision: number;
  model: string;
};
export type CloneTaskClaim = {
  claimed: boolean;
  taskId: string;
  projectId: string;
  workflowRunId: string;
  attemptToken: string | null;
  leaseExpiresAt: string | null;
  /** Computed by API; Worker echoes it, never independently rehashes JSON. */
  inputHash: string | null;
  snapshot: CloneTaskSnapshot | null;
  checkpoints: { key: string; inputHash: string; output: CloneTaskResult }[];
};
export type CloneTaskProgressRequest = { progress: number; stage: string; message: string };
export type CloneTaskCheckpointRequest = {
  key: string;
  inputHash: string;
  output: CloneTaskResult;
};
export type CloneTaskFailRequest = { code: string; message: string; retryable: boolean };
export type CloneTaskCompleteRequest = { result: CloneTaskResult };

export function emptyCloneAnalysisDraft(): CloneAnalysisDraft {
  return { schemaVersion: 1, sourceInput: null, baseAnalysisRevision: 0, report: null };
}
export function emptyCloneMappingDraft(): CloneMappingDraft {
  return {
    schemaVersion: 1,
    sourceInput: null,
    sourceAnalysis: null,
    bindings: [],
    structureLock: null,
  };
}
export function cloneStructureLock(report: CloneAnalysisReport): CloneStructureLock {
  return {
    durationMs: report.durationMs,
    stages: structuredClone(report.structure.stages),
    shots: report.shots.map(({ shotId, stageId, startMs, endMs }) => ({
      shotId,
      stageId,
      startMs,
      endMs,
    })),
    beatsMs: [...report.audio.beatsMs],
    soundEffectAnchorsMs: [...report.audio.soundEffectAnchorsMs],
    hookRanges: structuredClone(report.structure.hookRanges),
    conversionRanges: structuredClone(report.structure.conversionRanges),
  };
}

const ratio: Schema = { type: 'number', minimum: 0, maximum: 1 };
const bool: Schema = { type: 'boolean' };
const uuid: Schema = { type: 'string', pattern: CLONE_UUID_PATTERN };
const id: Schema = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_:-]{0,79}$' };
const hash: Schema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const version = { const: 1 };
const range = object({ startMs: integer(0, 120000), endMs: integer(1, 120000) });
const artifactRef = object({ artifactId: uuid, revision: integer(1), contentHash: hash });
const evidence = object({
  ...range.properties,
  kind: enumeration('VISUAL', 'TRANSCRIPT', 'INFERENCE', 'UNASSESSED'),
  description: text(),
  confidence: ratio,
});
const observation = object({
  status: enumeration('OBSERVED', 'NOT_DETECTED', 'UNASSESSED', 'NOT_APPLICABLE'),
  summary: text(),
  reason: text(),
  confidence: ratio,
  evidence: array(evidence, 100),
});
const stage = object({
  stageId: id,
  ...range.properties,
  role: text(200),
  summary: text(),
  proportion: ratio,
});
const shot = object({
  shotId: id,
  stageId: id,
  ...range.properties,
  framing: text(),
  cameraMovement: text(),
  transition: text(),
  composition: text(),
  elementIds: array(id),
  evidenceFramesMs: array(integer(0, 120000), 100),
});
const element = object({
  elementId: id,
  type: enumeration(...CLONE_ELEMENT_TYPES),
  label: text(200),
  description: text(),
  shotIds: array(id),
  ranges: array(range),
  evidence: array(evidence),
  required: bool,
  transcriptText: text(20000),
  sourceTrack: enumeration('VISUAL', 'BURNED_IN', 'AUDIO_MIX', 'INDEPENDENT', 'UNKNOWN'),
  confidence: ratio,
});
const structureLock = object({
  durationMs: integer(1000, 120000),
  stages: array(stage, 120, 1),
  shots: array(object({ shotId: id, stageId: id, ...range.properties }), 240, 1),
  beatsMs: array(integer(0, 120000), 1000),
  soundEffectAnchorsMs: array(integer(0, 120000), 1000),
  hookRanges: array(range),
  conversionRanges: array(range),
});
const target = object({
  asset: nullable(object({ assetId: uuid, version: integer(1) })),
  text: text(20000),
  style: text(),
  voice: text(),
  contentStrategy: enumeration('KEEP', 'REPLACE', 'NONE'),
  presentationStrategy: enumeration('KEEP', 'REPLACE', 'NONE'),
  lockedAttributes: array(text(500), 30),
  allowedVariations: array(text(500), 30),
});
const binding = object({
  elementId: id,
  type: enumeration(...CLONE_ELEMENT_TYPES),
  action: enumeration('KEEP', 'REPLACE'),
  shotIds: array(id),
  target: nullable(target),
});
export const FISSION_CLONE_ANALYSIS_REPORT_SCHEMA = published(
  'fission-clone-analysis-report.schema.json',
  object({
    schemaVersion: version,
    durationMs: integer(1000, 120000),
    frameWidth: integer(1, 16384),
    frameHeight: integer(1, 16384),
    structure: object({
      overview: observation,
      stages: array(stage, 120, 1),
      hookRanges: array(range),
      conversionRanges: array(range),
      rhythm: array(
        object({ timeMs: integer(0, 120000), intensity: ratio, description: text() }),
        1000,
      ),
    }),
    creativity: object({
      overview: observation,
      concept: text(),
      emotion: text(),
      contrast: text(),
      memoryPoints: array(text(), 100),
    }),
    product: object({
      overview: observation,
      originalProductDescription: text(),
      closeupRatio: nullable(ratio),
      transferAdvice: text(),
    }),
    shots: array(shot, 240, 1),
    audio: object({
      overview: observation,
      hasAudio: bool,
      voiceover: observation,
      bgm: observation,
      soundEffects: observation,
      transcript: array(
        object({ transcriptId: id, ...range.properties, text: text(10000), confidence: ratio }),
        500,
      ),
      beatsMs: array(integer(0, 120000), 1000),
      soundEffectAnchorsMs: array(integer(0, 120000), 1000),
      silenceRanges: array(range),
    }),
    visual: object({
      overview: observation,
      subtitles: array(object({ elementId: id, text: text(10000), style: text(), burnedIn: bool })),
      color: text(),
      stickers: array(text(), 100),
      aspectRatio: text(50),
      safeArea: text(),
    }),
    elements: array(element),
    transferSuggestions: array(text(), 100),
    limitations: array(text(), 100),
  }),
);
export const FISSION_CLONE_ANALYSIS_DRAFT_SCHEMA = published(
  'fission-clone-analysis-draft.schema.json',
  object({
    schemaVersion: version,
    sourceInput: nullable(artifactRef),
    baseAnalysisRevision: integer(),
    report: nullable(FISSION_CLONE_ANALYSIS_REPORT_SCHEMA),
  }),
);
export const FISSION_CLONE_MAPPING_DRAFT_SCHEMA = published(
  'fission-clone-mapping-draft.schema.json',
  object({
    schemaVersion: version,
    sourceInput: nullable(artifactRef),
    sourceAnalysis: nullable(artifactRef),
    bindings: array(binding),
    structureLock: nullable(structureLock),
  }),
);
const keepCheck = object({
  elementId: id,
  passed: bool,
  reason: text(),
  evidence: array(text(), 100),
});
export const FISSION_CLONE_TASK_RESULT_SCHEMA = published('fission-clone-task-result.schema.json', {
  oneOf: [
    object({ operation: { const: 'ANALYZE' }, report: FISSION_CLONE_ANALYSIS_REPORT_SCHEMA }),
    object({
      operation: { const: 'MAP_SUGGEST' },
      purpose: { const: 'SMART_MATCH' },
      mapping: FISSION_CLONE_MAPPING_DRAFT_SCHEMA,
      notes: array(text(), 100),
    }),
    object({
      operation: { const: 'MAP_SUGGEST' },
      purpose: { const: 'VALIDATE_KEEP_TEXT' },
      checks: array(keepCheck),
    }),
  ],
});
export const FISSION_CLONE_TASK_CREATE_SCHEMA = published(
  'fission-clone-task-create.schema.json',
  object({
    idempotencyKey: uuid,
    sourceInput: artifactRef,
    sourceAnalysis: nullable(artifactRef),
    expectedDraftRevision: integer(),
    expectedArtifactRevision: integer(),
    purpose: nullable(enumeration('SMART_MATCH', 'VALIDATE_KEEP_TEXT')),
  }),
);

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) fail(label, '标识不能重复');
}
function rangeWithin(value: CloneTimeRange, durationMs: number) {
  if (value.startMs < 0 || value.startMs >= value.endMs || value.endMs > durationMs)
    fail('时间区间', '必须为参考时长内的有效左闭右开区间');
}
function validateRanges(value: unknown, durationMs: number) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => validateRanges(item, durationMs));
    return;
  }
  const obj = value as Record<string, unknown>;
  if ('startMs' in obj && 'endMs' in obj) rangeWithin(obj as CloneTimeRange, durationMs);
  Object.values(obj).forEach((item) => validateRanges(item, durationMs));
}
function coverage(rows: CloneTimeRange[], durationMs: number, label: string) {
  if (
    !rows.length ||
    rows[0]!.startMs !== 0 ||
    rows.at(-1)!.endMs !== durationMs ||
    rows.some((row, index) => index > 0 && row.startMs !== rows[index - 1]!.endMs)
  )
    fail(label, '必须有序、连续覆盖完整参考时长');
}
export function parseCloneAnalysisReport(value: unknown): CloneAnalysisReport {
  const report = parse<CloneAnalysisReport>(FISSION_CLONE_ANALYSIS_REPORT_SCHEMA, value);
  validateRanges(report, report.durationMs);
  unique(
    report.structure.stages.map((item) => item.stageId),
    '阶段',
  );
  unique(
    report.shots.map((item) => item.shotId),
    '镜头',
  );
  unique(
    report.elements.map((item) => item.elementId),
    '元素',
  );
  unique(
    report.audio.transcript.map((item) => item.transcriptId),
    '转录',
  );
  coverage(report.structure.stages, report.durationMs, '阶段');
  coverage(report.shots, report.durationMs, '镜头');
  for (const item of report.structure.stages)
    if (Math.abs(item.proportion - (item.endMs - item.startMs) / report.durationMs) > 0.00001)
      fail('阶段占比', '与实际时间不一致');
  const shots = new Map(report.shots.map((item) => [item.shotId, item]));
  const elements = new Map(report.elements.map((item) => [item.elementId, item]));
  for (const item of report.shots) {
    const parent = report.structure.stages.find((row) => row.stageId === item.stageId);
    if (!parent || item.startMs < parent.startMs || item.endMs > parent.endMs)
      fail('镜头阶段', '引用不存在或时间不在所属阶段内');
    unique(item.elementIds, '镜头元素');
    if (item.elementIds.some((key) => !elements.get(key)?.shotIds.includes(item.shotId)))
      fail('镜头元素', '双向引用不一致');
    if (item.evidenceFramesMs.some((time) => time < item.startMs || time >= item.endMs))
      fail('证据帧', '不在所属镜头内');
  }
  for (const item of report.elements) {
    unique(item.shotIds, '元素镜头');
    if (
      !item.shotIds.length ||
      !item.ranges.length ||
      item.shotIds.some((key) => !shots.get(key)?.elementIds.includes(item.elementId))
    )
      fail('元素镜头', '缺少有效出现区间或双向引用不一致');
    if (
      item.ranges.some(
        (range) =>
          !item.shotIds.some((key) => {
            const row = shots.get(key)!;
            return range.startMs < row.endMs && range.endMs > row.startMs;
          }),
      )
    )
      fail('元素区间', '未与引用镜头相交');
    if (item.type === 'product' && !item.required) fail('产品元素', '产品必须逐项替换');
  }
  for (const subtitle of report.visual.subtitles)
    if (elements.get(subtitle.elementId)?.type !== 'subtitle')
      fail('字幕', '元素引用不存在或类型无效');
  for (const values of [
    report.audio.beatsMs,
    report.audio.soundEffectAnchorsMs,
    report.structure.rhythm.map((item) => item.timeMs),
  ])
    if (
      values.some(
        (time, index) => time >= report.durationMs || (index > 0 && time <= values[index - 1]!),
      )
    )
      fail('节奏时间', '必须在参考片内严格递增');
  const observations = [
    report.structure.overview,
    report.creativity.overview,
    report.product.overview,
    report.audio.overview,
    report.audio.voiceover,
    report.audio.bgm,
    report.audio.soundEffects,
    report.visual.overview,
  ];
  for (const item of observations)
    if (item.status !== 'OBSERVED' && !item.reason) fail('识别状态', '缺项必须说明原因');
  return report;
}
export function validateCloneVisualOnlyReport(report: CloneAnalysisReport): void {
  for (const item of [report.audio.voiceover, report.audio.bgm, report.audio.soundEffects]) {
    if (!['UNASSESSED', 'NOT_APPLICABLE'].includes(item.status) || !item.reason)
      fail('音频能力', '未提供音频语义识别，不得声称已检测内容');
  }
  if (
    report.audio.transcript.length ||
    report.audio.beatsMs.length ||
    report.audio.soundEffectAnchorsMs.length ||
    report.audio.silenceRanges.length ||
    report.elements.some((item) => item.type === 'bgm' || item.type === 'voiceover')
  )
    fail('音频能力', '抽帧分析不能生成转录或音轨内容');
}
export function parseCloneAnalysisDraft(value: unknown): CloneAnalysisDraft {
  const draft = parse<CloneAnalysisDraft>(FISSION_CLONE_ANALYSIS_DRAFT_SCHEMA, value);
  if (draft.report) {
    draft.report = parseCloneAnalysisReport(draft.report);
    if (!draft.sourceInput) fail('报告草稿', '缺少来源');
  }
  return draft;
}
export function parseCloneMappingDraft(value: unknown): CloneMappingDraft {
  const draft = parse<CloneMappingDraft>(FISSION_CLONE_MAPPING_DRAFT_SCHEMA, value);
  unique(
    draft.bindings.map((item) => item.elementId),
    '映射元素',
  );
  for (const item of draft.bindings) unique(item.shotIds, '映射镜头');
  if (
    (draft.bindings.length || draft.structureLock) &&
    (!draft.sourceInput || !draft.sourceAnalysis)
  )
    fail('映射草稿', '缺少确认来源');
  if (draft.structureLock) {
    validateRanges(draft.structureLock, draft.structureLock.durationMs);
    coverage(draft.structureLock.stages, draft.structureLock.durationMs, '锁定阶段');
    coverage(draft.structureLock.shots, draft.structureLock.durationMs, '锁定镜头');
  }
  return draft;
}
export function parseCloneTaskCreateRequest(value: unknown): CloneTaskCreateRequest {
  return parse(FISSION_CLONE_TASK_CREATE_SCHEMA, value);
}
export function parseCloneAssetVersionRef(value: unknown): CloneAssetVersionRef {
  return parse(object({ assetId: uuid, version: integer(1) }), value);
}
export function parseCloneArtifactRef(value: unknown): CloneArtifactRef {
  return parse(artifactRef, value);
}
export function parseCloneTaskResult(value: unknown): CloneTaskResult {
  const result = parse<CloneTaskResult>(FISSION_CLONE_TASK_RESULT_SCHEMA, value);
  if (result.operation === 'ANALYZE') result.report = parseCloneAnalysisReport(result.report);
  else if (result.purpose === 'SMART_MATCH')
    result.mapping = parseCloneMappingDraft(result.mapping);
  else
    unique(
      result.checks.map((item) => item.elementId),
      '保留文本核对',
    );
  return result;
}
export function parseCloneAnalysisConfirmRequest(value: unknown): CloneAnalysisConfirmRequest {
  return parse(
    object({ expectedDraftRevision: integer(), expectedAnalysisRevision: integer() }),
    value,
  );
}
export function parseCloneMappingConfirmRequest(value: unknown): CloneMappingConfirmRequest {
  return parse(
    object({ expectedDraftRevision: integer(), expectedMappingRevision: integer() }),
    value,
  );
}
export function parseCloneSuggestionAdoptRequest(value: unknown): CloneSuggestionAdoptRequest {
  return parse(object({ expectedDraftRevision: integer() }), value);
}
export function parseCloneAnalysisDraftSaveRequest(value: unknown): CloneAnalysisDraftSaveRequest {
  const request = parse<CloneAnalysisDraftSaveRequest>(
    object({ expectedRevision: integer(), state: FISSION_CLONE_ANALYSIS_DRAFT_SCHEMA }),
    value,
  );
  request.state = parseCloneAnalysisDraft(request.state);
  return request;
}
export function parseCloneMappingDraftSaveRequest(value: unknown): CloneMappingDraftSaveRequest {
  const request = parse<CloneMappingDraftSaveRequest>(
    object({ expectedRevision: integer(), state: FISSION_CLONE_MAPPING_DRAFT_SCHEMA }),
    value,
  );
  request.state = parseCloneMappingDraft(request.state);
  return request;
}
export function parseCloneTaskProgressRequest(value: unknown): CloneTaskProgressRequest {
  return parse(object({ progress: integer(0, 100), stage: text(100), message: text(500) }), value);
}
export function parseCloneTaskCheckpointRequest(value: unknown): CloneTaskCheckpointRequest {
  const request = parse<CloneTaskCheckpointRequest>(
    object({ key: id, inputHash: hash, output: FISSION_CLONE_TASK_RESULT_SCHEMA }),
    value,
  );
  request.output = parseCloneTaskResult(request.output);
  return request;
}
export function parseCloneTaskFailRequest(value: unknown): CloneTaskFailRequest {
  return parse(object({ code: text(100), message: text(500), retryable: bool }), value);
}
export function parseCloneTaskCompleteRequest(value: unknown): CloneTaskCompleteRequest {
  const request = parse<CloneTaskCompleteRequest>(
    object({ result: FISSION_CLONE_TASK_RESULT_SCHEMA }),
    value,
  );
  request.result = parseCloneTaskResult(request.result);
  return request;
}

/** Mechanical mapping checks; permissions, asset availability and AI text evidence remain server concerns. */
export function validateCloneMappingForReport(
  mapping: CloneMappingDraft,
  report: CloneAnalysisReport,
  requireComplete = false,
): void {
  const expected = cloneStructureLock(report);
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, ordered(item)]),
          )
        : value;
  if (
    !mapping.structureLock ||
    JSON.stringify(ordered(mapping.structureLock)) !== JSON.stringify(ordered(expected))
  )
    fail('结构锁定', '必须与确认报告的镜头、阶段和锚点一致');
  const elements = new Map(report.elements.map((item) => [item.elementId, item]));
  for (const binding of mapping.bindings) {
    const source = elements.get(binding.elementId);
    if (
      !source ||
      source.type !== binding.type ||
      binding.shotIds.length !== source.shotIds.length ||
      binding.shotIds.some((key, i) => key !== source.shotIds[i])
    )
      fail('映射元素', '类型或镜头引用与确认报告不一致');
    if (binding.type === 'product' && binding.action !== 'REPLACE')
      fail('产品映射', '所有产品元素都必须替换');
    if (!requireComplete) continue;
    if (binding.action === 'KEEP' && ['subtitle', 'bgm', 'voiceover'].includes(binding.type))
      fail('保留能力', '当前未提供可执行的原音轨或烧录字幕保留方案，请选择替换');
    if (
      binding.action === 'REPLACE' &&
      (!binding.target ||
        (!binding.target.asset && !binding.target.text.trim() && !binding.target.style.trim()))
    )
      fail('替换目标', '请为每项替换提供明确资产或内容');
    if (
      binding.target?.presentationStrategy === 'KEEP' &&
      ['subtitle', 'bgm', 'voiceover'].includes(binding.type)
    )
      fail('表现形式保留', '当前不支持保留原音色、音轨或烧录字幕样式');
    if (binding.target?.voice.trim()) fail('音色能力', '当前未启用指定音色或声音克隆');
    if (binding.type === 'product' && !binding.target?.asset && !binding.target?.text.trim())
      fail('产品映射', '产品替换不能只指定风格');
    if (
      binding.target?.contentStrategy === 'KEEP' &&
      (!['subtitle', 'voiceover'].includes(binding.type) || !source.transcriptText.trim())
    )
      fail('保留文本', '需要可核对的原字幕或转录内容');
    if (
      binding.target &&
      binding.target.lockedAttributes.some((item) =>
        binding.target!.allowedVariations.includes(item),
      )
    )
      fail('变化约束', '同一属性不能同时锁定和允许变化');
  }
  if (requireComplete && mapping.bindings.length !== report.elements.length)
    fail('映射完整性', '必须逐项配置全部识别元素');
}
