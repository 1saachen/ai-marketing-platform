import {
  CLONE_SHOT_MOTION_SCHEMA,
  parseCloneArtifactRef,
  validateCloneShotMotion,
  type CloneShotMotion,
  type CloneStructureLock,
  type CloneTaskStatus,
  type CloneTimeRange,
} from './fission-clone-analysis';
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
import { CLONE_UUID_PATTERN, type CloneArtifactRef } from './fission-clone';

export const CLONE_GENERATION_LIMITS = {
  maxDurationMs: 15_000,
  maxShots: 4,
  maxCount: 20,
  maxUnplannedCount: 2,
  maxImagesPerShot: 4,
  maxSourceEditImages: 9,
  maxSourceVideoBytes: 200_000_000,
  maxImageBytes: 4 * 1024 * 1024,
  minImageSide: 300,
  maxImageSide: 6000,
  minRenderSeconds: 4,
  maxRenderSeconds: 15,
  minShotReferenceFrames: 48,
  fpsNumerator: 24,
  fpsDenominator: 1,
} as const;
export const CLONE_SHOT_REFERENCE_MODE = 'SEEDANCE_2_0_SHOT_REFERENCE';

export type CloneGenerationCount = number;
export type CloneGenerationPreflightRequest = {
  sourceMapping: CloneArtifactRef;
  count: CloneGenerationCount;
  audioMode: 'SILENT';
  transitionMode: 'CUT';
};
export type CloneGenerationCreateRequest = CloneGenerationPreflightRequest & {
  idempotencyKey: string;
  acceptedRenderSeconds: number;
  acceptedReferenceFrames?: number;
};
export type CloneGenerationReceipt = { taskId: string; batchId?: string };
export type CloneGenerationSnapshot = {
  plan: CloneGenerationPlan;
  variantId: string;
  model: string;
  reviewModel: string;
};
export type CloneGenerationReview = {
  checks: {
    shotId: string;
    verdict: 'PASSED' | 'WARNING' | 'FAILED';
    reason: string;
    evidenceFrames: number[];
  }[];
};
export type CloneGenerationRenderCheckpoint =
  | { state: 'CREATE_PENDING' }
  | { state: 'CREATE_REJECTED' }
  | { state: 'CREATED'; providerTaskId: string };
export type CloneGenerationFile = {
  fileObjectId: string;
  sizeBytes: number;
  sha256: string;
};
export type CloneGenerationCheckpoint =
  CloneGenerationRenderCheckpoint | CloneGenerationFile | CloneGenerationReview;
export type CloneGenerationClaim = {
  claimed: boolean;
  attemptToken: string | null;
  leaseExpiresAt: string | null;
  snapshot: CloneGenerationSnapshot | null;
  checkpoints: Record<string, CloneGenerationCheckpoint>;
  planning?: {
    plan: CloneGenerationPlan;
    model: string;
    variantIds: string[];
    version?: 2;
    draft: CloneGenerationVariantDraft | null;
    review: CloneGenerationVariantReview | null;
  };
};
export type CloneGenerationSceneDirection = {
  dimension: string;
  direction: string;
  scope?: 'SHOT';
};
type CloneGenerationVariantTarget = {
  variantId: string;
  elementId: string;
  dimension: string;
};
export type CloneGenerationVariantDraft =
  | { version?: never; variants: (CloneGenerationVariantTarget & { direction: string })[] }
  | {
      version: 2;
      variants: (CloneGenerationVariantTarget & {
        shotDirections: { shotId: string; direction: string }[];
      })[];
    };
export type CloneGenerationVariant = CloneGenerationVariantDraft['variants'][number];
export type CloneGenerationVariantReview = {
  checks: { variantId: string; verdict: 'PASSED' | 'FAILED'; reason: string }[];
};
export type CloneGenerationReviewIssue = {
  /** One-based shot position in the frozen output timeline. */
  shotNumber: number;
  verdict: 'WARNING' | 'FAILED';
  reason: string;
  /** Zero-based output frame numbers. */
  evidenceFrames: number[];
};
export type CloneGenerationTask = {
  id: string;
  variantId: string;
  status: CloneTaskStatus;
  progress: number;
  message: string;
  error: string | null;
  reviewIssues?: CloneGenerationReviewIssue[];
  canRetry: boolean;
  createdAt: string;
  artifact:
    | (CloneArtifactRef & {
        freshness: 'CURRENT' | 'STALE';
        archived: boolean;
        contentUrl: string;
        durationMs: number;
        ratio: CloneGenerationPlan['ratio'];
      })
    | null;
};
export type CloneGenerationBatch = {
  id: string;
  taskIds: string[];
  count?: number;
  status: CloneTaskStatus | 'PARTIAL';
  canCancel: boolean;
  planning?: { count: number; error: string | null; canRetry: boolean };
  sample?: { totalCount: number };
  downloadUrl?: string;
};
export type CloneGenerationList = {
  items: CloneGenerationTask[];
  batches: CloneGenerationBatch[];
  total: number;
  active: boolean;
  pendingBatch: boolean;
  maxCount?: number;
};
export const CLONE_GENERATION_QUEUE = 'fission.clone.generation.requested';
export const CLONE_GENERATION_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const cloneVideoArtifactKey = (variantId: string) => `clone-video:${variantId}`;
export const cloneBatchArtifactKey = (taskId: string) => `clone-batch:${taskId}`;

export type CloneFrameRange = CloneTimeRange & { startFrame: number; endFrame: number };
export const cloneShotReferenceFrames = (shot: Pick<CloneFrameRange, 'startFrame' | 'endFrame'>) =>
  Math.max(CLONE_GENERATION_LIMITS.minShotReferenceFrames, shot.endFrame - shot.startFrame);
export type CloneFrameRate = { fpsNumerator: number; fpsDenominator: number };
export type CloneFrameTimeline = CloneFrameRate & {
  durationMs: number;
  frameCount: number;
  stages: (CloneFrameRange & { stageId: string; role: string })[];
  shots: (CloneFrameRange & { shotId: string; stageId: string })[];
  hookRanges: CloneFrameRange[];
  conversionRanges: CloneFrameRange[];
};

export type CloneGenerationImage = {
  assetId: string;
  version: number;
  sourceVersionId: string;
  fileObjectId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
};
export type CloneGenerationSourceFile = {
  fileObjectId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: 'video/mp4' | 'video/quicktime';
};
export type CloneGenerationSourceVideo = CloneGenerationSourceFile & { renderSeconds: number };
export type CloneGenerationShot = {
  shotId: string;
  renderSeconds: number;
  framing: string;
  cameraMovement: string;
  composition: string;
  /** Number of input frames sent to the provider, including any repeated tail frames. */
  referenceFrames?: number;
  /** The compiled motion timestamps are relative to this shot's start. */
  motion?: CloneShotMotion;
  targets: {
    elementId: string;
    type: 'product' | 'scene' | 'prop';
    imageFileObjectId: string | null;
    /** Identifies the object in the source video, separately from the intended replacement. */
    sourceDescription?: string;
    description: string;
    style: string;
    lockedAttributes: string[];
    allowedVariations: string[];
    variation?: CloneGenerationSceneDirection;
  }[];
};
export type CloneGenerationPlan = {
  schemaVersion: 1;
  /** The render prompt is frozen with the plan. Omitted on historical plans. */
  renderInstructionVersion?: 2;
  projectId: string;
  workflowRunId: string;
  sources: { input: CloneArtifactRef; analysis: CloneArtifactRef; mapping: CloneArtifactRef };
  ratio: '9:16' | '16:9';
  width: number;
  height: number;
  sourceHasAudio: boolean;
  productName: string;
  productFacts: string;
  timeline: CloneFrameTimeline;
  images: CloneGenerationImage[];
  shots: CloneGenerationShot[];
} & (
  | { mode: 'SEEDANCE_2_0_SILENT_CUT'; sourceVideo?: never }
  | { mode: 'SEEDANCE_2_0_SOURCE_EDIT'; sourceVideo: CloneGenerationSourceVideo }
  | { mode: typeof CLONE_SHOT_REFERENCE_MODE; sourceVideo: CloneGenerationSourceFile }
);

export type CloneGenerationPreflight = Pick<
  CloneGenerationPlan,
  'mode' | 'ratio' | 'width' | 'height' | 'timeline' | 'sourceHasAudio'
> & {
  sourceMapping: CloneArtifactRef;
  count: CloneGenerationCount;
  shots: Pick<CloneGenerationShot, 'shotId' | 'renderSeconds' | 'referenceFrames'>[];
  totalRenderSeconds: number;
  totalReferenceFrames?: number;
};

const uuid: Schema = { type: 'string', pattern: CLONE_UUID_PATTERN };
const id: Schema = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_:-]{0,79}$' };
const ref = object({
  artifactId: uuid,
  revision: integer(1),
  contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
});
const request = object({
  sourceMapping: ref,
  count: integer(1, CLONE_GENERATION_LIMITS.maxCount),
  audioMode: enumeration('SILENT'),
  transitionMode: enumeration('CUT'),
});
const sceneDirection = {
  dimension: { ...text(500), minLength: 1 },
  direction: { ...text(240), minLength: 1 },
};
export const FISSION_CLONE_GENERATION_VARIANT_DRAFT_SCHEMA = published(
  'fission-clone-generation-variant-draft.schema.json',
  object({
    variants: array(
      object({ variantId: uuid, elementId: id, ...sceneDirection }),
      CLONE_GENERATION_LIMITS.maxCount,
      CLONE_GENERATION_LIMITS.maxUnplannedCount + 1,
    ),
  }),
);
export const FISSION_CLONE_GENERATION_VARIANT_SHOT_DRAFT_SCHEMA = published(
  'fission-clone-generation-variant-shot-draft.schema.json',
  object({
    version: { type: 'integer', const: 2 },
    variants: array(
      object({
        variantId: uuid,
        elementId: id,
        dimension: sceneDirection.dimension,
        shotDirections: array(
          object({ shotId: id, direction: { ...text(120), minLength: 1 } }),
          CLONE_GENERATION_LIMITS.maxShots,
          1,
        ),
      }),
      CLONE_GENERATION_LIMITS.maxCount,
      CLONE_GENERATION_LIMITS.maxUnplannedCount + 1,
    ),
  }),
);
export const FISSION_CLONE_GENERATION_VARIANT_REVIEW_SCHEMA = published(
  'fission-clone-generation-variant-review.schema.json',
  object({
    checks: array(
      object({
        variantId: uuid,
        verdict: enumeration('PASSED', 'FAILED'),
        reason: { ...text(400), minLength: 1 },
      }),
      CLONE_GENERATION_LIMITS.maxCount,
      CLONE_GENERATION_LIMITS.maxUnplannedCount + 1,
    ),
  }),
);
export const parseCloneGenerationVariantDraft = (value: unknown): CloneGenerationVariantDraft =>
  parse(
    {
      oneOf: [
        FISSION_CLONE_GENERATION_VARIANT_DRAFT_SCHEMA,
        FISSION_CLONE_GENERATION_VARIANT_SHOT_DRAFT_SCHEMA,
      ],
    },
    value,
  );
export const parseCloneGenerationVariantReview = (value: unknown): CloneGenerationVariantReview =>
  parse(FISSION_CLONE_GENERATION_VARIANT_REVIEW_SCHEMA, value);
export const FISSION_CLONE_GENERATION_REVIEW_SCHEMA = published(
  'fission-clone-generation-review.schema.json',
  object({
    checks: array(
      object({
        shotId: id,
        verdict: enumeration('PASSED', 'WARNING', 'FAILED'),
        reason: { ...text(600), minLength: 1 },
        evidenceFrames: array(integer(0, 359), 5, 1),
      }),
      CLONE_GENERATION_LIMITS.maxShots,
      1,
    ),
  }),
);

export function parseCloneGenerationCreateRequest(value: unknown): CloneGenerationCreateRequest {
  const fields = {
    ...request.properties,
    idempotencyKey: uuid,
    acceptedRenderSeconds: integer(
      CLONE_GENERATION_LIMITS.minRenderSeconds,
      CLONE_GENERATION_LIMITS.maxCount *
        CLONE_GENERATION_LIMITS.maxShots *
        CLONE_GENERATION_LIMITS.maxRenderSeconds,
    ),
  };
  return parse(
    {
      ...object(fields),
      properties: {
        ...fields,
        acceptedReferenceFrames: integer(
          CLONE_GENERATION_LIMITS.minShotReferenceFrames,
          CLONE_GENERATION_LIMITS.maxCount * CLONE_GENERATION_LIMITS.maxShots * 360,
        ),
      },
    },
    value,
  );
}
export function parseCloneGenerationRenderCheckpoint(
  value: unknown,
): CloneGenerationRenderCheckpoint {
  return parse(
    {
      oneOf: [
        object({ state: enumeration('CREATE_PENDING', 'CREATE_REJECTED') }),
        object({
          state: enumeration('CREATED'),
          providerTaskId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' },
        }),
      ],
    },
    value,
  );
}
export function parseCloneGenerationReview(value: unknown): CloneGenerationReview {
  return parse(FISSION_CLONE_GENERATION_REVIEW_SCHEMA, value);
}
const frameRange = {
  startMs: integer(0, CLONE_GENERATION_LIMITS.maxDurationMs),
  endMs: integer(1, CLONE_GENERATION_LIMITS.maxDurationMs),
  startFrame: integer(0, 360),
  endFrame: integer(1, 360),
};
const generationTargetFields = {
  elementId: id,
  type: enumeration('product', 'scene', 'prop'),
  imageFileObjectId: nullable(uuid),
  description: text(20_000),
  style: text(),
  lockedAttributes: array(text(500), 30),
  allowedVariations: array(text(500), 30),
};
const generationTarget: Schema = {
  ...object(generationTargetFields),
  properties: {
    ...generationTargetFields,
    sourceDescription: text(5_000),
    variation: {
      ...object(sceneDirection),
      properties: { ...sceneDirection, scope: enumeration('SHOT') },
    },
  },
};
const generationShotFields = {
  shotId: id,
  renderSeconds: integer(
    CLONE_GENERATION_LIMITS.minRenderSeconds,
    CLONE_GENERATION_LIMITS.maxRenderSeconds,
  ),
  framing: text(),
  cameraMovement: text(),
  composition: text(),
  targets: array(generationTarget),
};
const generationShot: Schema = {
  ...object(generationShotFields),
  properties: {
    ...generationShotFields,
    motion: CLONE_SHOT_MOTION_SCHEMA,
    referenceFrames: integer(CLONE_GENERATION_LIMITS.minShotReferenceFrames, 360),
  },
};

const generationPlan = object({
  schemaVersion: { const: 1 },
  projectId: uuid,
  workflowRunId: uuid,
  sources: object({ input: ref, analysis: ref, mapping: ref }),
  mode: enumeration(
    'SEEDANCE_2_0_SILENT_CUT',
    'SEEDANCE_2_0_SOURCE_EDIT',
    CLONE_SHOT_REFERENCE_MODE,
  ),
  ratio: enumeration('9:16', '16:9'),
  width: { type: 'integer', enum: [720, 1280] },
  height: { type: 'integer', enum: [720, 1280] },
  sourceHasAudio: { type: 'boolean' },
  productName: text(200),
  productFacts: text(20_000),
  timeline: object({
    durationMs: integer(1000, CLONE_GENERATION_LIMITS.maxDurationMs),
    fpsNumerator: { const: CLONE_GENERATION_LIMITS.fpsNumerator },
    fpsDenominator: { const: CLONE_GENERATION_LIMITS.fpsDenominator },
    frameCount: integer(1, 360),
    stages: array(
      object({ stageId: id, role: text(200), ...frameRange }),
      CLONE_GENERATION_LIMITS.maxShots,
      1,
    ),
    shots: array(
      object({ shotId: id, stageId: id, ...frameRange }),
      CLONE_GENERATION_LIMITS.maxShots,
      1,
    ),
    hookRanges: array(object(frameRange)),
    conversionRanges: array(object(frameRange)),
  }),
  images: array(
    object({
      assetId: uuid,
      version: integer(1),
      sourceVersionId: uuid,
      fileObjectId: uuid,
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      sizeBytes: integer(1, CLONE_GENERATION_LIMITS.maxImageBytes),
      mimeType: enumeration('image/jpeg', 'image/png', 'image/webp'),
      width: integer(CLONE_GENERATION_LIMITS.minImageSide, CLONE_GENERATION_LIMITS.maxImageSide),
      height: integer(CLONE_GENERATION_LIMITS.minImageSide, CLONE_GENERATION_LIMITS.maxImageSide),
    }),
    CLONE_GENERATION_LIMITS.maxImagesPerShot * CLONE_GENERATION_LIMITS.maxShots,
    1,
  ),
  shots: array(generationShot, CLONE_GENERATION_LIMITS.maxShots, 1),
});
const sourceVideoFields = {
  fileObjectId: uuid,
  sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  sizeBytes: integer(1, CLONE_GENERATION_LIMITS.maxSourceVideoBytes),
  mimeType: enumeration('video/mp4', 'video/quicktime'),
} satisfies Record<string, Schema>;
export const FISSION_CLONE_GENERATION_PLAN_SCHEMA = published(
  'fission-clone-generation-plan.schema.json',
  {
    ...generationPlan,
    properties: {
      ...generationPlan.properties,
      renderInstructionVersion: { const: 2 },
      sourceVideo: {
        ...object(sourceVideoFields),
        properties: {
          ...sourceVideoFields,
          renderSeconds: integer(
            CLONE_GENERATION_LIMITS.minRenderSeconds,
            CLONE_GENERATION_LIMITS.maxRenderSeconds,
          ),
        },
      },
    },
  },
);

export function parseCloneGenerationPreflightRequest(
  value: unknown,
): CloneGenerationPreflightRequest {
  const result = parse<CloneGenerationPreflightRequest>(request, value);
  return { ...result, sourceMapping: parseCloneArtifactRef(result.sourceMapping) };
}

export function parseCloneGenerationPlan(value: unknown): CloneGenerationPlan {
  const plan = parse<CloneGenerationPlan>(FISSION_CLONE_GENERATION_PLAN_SCHEMA, value);
  const sourceEdit = plan.mode === 'SEEDANCE_2_0_SOURCE_EDIT';
  const shotReference = plan.mode === CLONE_SHOT_REFERENCE_MODE;
  const targets = plan.shots.flatMap((shot) => shot.targets);
  if (sourceEdit) {
    const durationMs = plan.timeline.durationMs;
    const minimumMs = CLONE_GENERATION_LIMITS.minRenderSeconds * 1000;
    if (
      !plan.sourceVideo ||
      plan.renderInstructionVersion !== 2 ||
      durationMs < minimumMs ||
      plan.sourceVideo.renderSeconds !== Math.ceil(durationMs / 1000)
    )
      fail('原片编辑', '缺少对应时长的冻结原视频或指令版本');
    if (plan.images.some((image) => image.fileObjectId === plan.sourceVideo.fileObjectId))
      fail('原片编辑', '原视频不能同时作为目标图片');
    if (
      !targets.some((target) => target.type === 'product') ||
      targets.some(
        (target) =>
          !target.sourceDescription?.trim() ||
          ((target.type === 'product' || target.type === 'prop') && !target.imageFileObjectId),
      )
    )
      fail('原片编辑', '缺少源物件描述或目标图片');
    if (plan.images.length > CLONE_GENERATION_LIMITS.maxSourceEditImages)
      fail('原片编辑', '目标参考图数量超出整段编辑上限');
  } else if (shotReference) {
    const source = plan.sourceVideo;
    if (
      !source ||
      'renderSeconds' in source ||
      plan.renderInstructionVersion !== 2 ||
      plan.images.some((image) => image.fileObjectId === source.fileObjectId)
    )
      fail('逐镜头参考', '缺少冻结原片或指令版本');
    if (
      !targets.some((target) => target.type === 'product') ||
      targets.some(
        (target) =>
          target.type === 'prop' ||
          !target.sourceDescription?.trim() ||
          (target.type === 'product' && !target.imageFileObjectId),
      )
    )
      fail('逐镜头参考', '缺少原元素描述或目标商品图片');
  } else if (
    plan.sourceVideo !== undefined ||
    targets.some((target) => target.type === 'prop' || target.sourceDescription !== undefined)
  ) {
    fail('成片模式', '原片编辑字段只能用于编辑任务');
  }
  for (const [index, shot] of plan.shots.entries()) {
    const range = plan.timeline.shots[index];
    if (shotReference) {
      if (range?.shotId !== shot.shotId || shot.referenceFrames !== cloneShotReferenceFrames(range))
        fail('逐镜头参考', '参考帧数与锁定镜头不一致');
    } else if (shot.referenceFrames !== undefined) {
      fail('成片模式', '参考帧数只能用于逐镜头参考');
    }
    if (shot.motion) {
      if (plan.renderInstructionVersion !== 2) fail('镜头动作', '缺少支持动作的渲染指令版本');
      const observed = plan.timeline.shots.find((item) => item.shotId === shot.shotId);
      if (!observed) fail('镜头动作', '找不到匹配的成片镜头');
      validateCloneShotMotion(shot.motion, {
        startMs: 0,
        endMs: observed.endMs - observed.startMs,
      });
    }
  }
  if (shotReference && plan.shots.length !== plan.timeline.shots.length)
    fail('逐镜头参考', '成片镜头未覆盖锁定时间线');
  return plan;
}

/** Round absolute boundaries once, using integer arithmetic for common fractional frame rates. */
export function compileCloneFrameTimeline(
  lock: CloneStructureLock,
  fps: CloneFrameRate,
): CloneFrameTimeline {
  const { fpsNumerator, fpsDenominator } = fps;
  if (
    ![fpsNumerator, fpsDenominator].every(
      (value) => Number.isInteger(value) && value > 0 && value <= 120_000,
    ) ||
    fpsNumerator / fpsDenominator > 120 ||
    fpsNumerator < fpsDenominator
  )
    throw new TypeError('输出帧率无效');
  const durationMs = lock.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 120_000)
    throw new TypeError('参考时间线时长无效');
  const units = 1000 * fpsDenominator;
  const frame = (timeMs: number) => Math.floor((2 * timeMs * fpsNumerator + units) / (2 * units));
  const span = ({ startMs, endMs }: CloneTimeRange): CloneFrameRange => {
    if (
      !Number.isInteger(startMs) ||
      !Number.isInteger(endMs) ||
      startMs < 0 ||
      endMs > durationMs ||
      startMs >= endMs
    )
      throw new TypeError('生成时间区间超出参考时间线');
    const startFrame = frame(startMs),
      endFrame = frame(endMs);
    if (endFrame <= startFrame) throw new TypeError('时间区间无法覆盖一个完整输出帧');
    return { startMs, endMs, startFrame, endFrame };
  };
  const coverage = (ranges: CloneTimeRange[]) => {
    let boundary = 0;
    for (const range of ranges) {
      if (range.startMs !== boundary) throw new TypeError('生成时间线必须连续且有序');
      boundary = range.endMs;
    }
    if (boundary !== durationMs) throw new TypeError('生成时间线未覆盖参考视频完整时长');
  };
  coverage(lock.stages);
  coverage(lock.shots);
  const stages = lock.stages.map(({ stageId, role, ...timing }) => ({
    stageId,
    role,
    ...span(timing),
  }));
  const stageMap = new Map(stages.map((stage) => [stage.stageId, stage]));
  if (
    stageMap.size !== stages.length ||
    new Set(lock.shots.map((shot) => shot.shotId)).size !== lock.shots.length
  )
    throw new TypeError('生成时间线存在重复标识');
  const shots = lock.shots.map(({ shotId, stageId, ...timing }) => {
    const parent = stageMap.get(stageId);
    if (!parent || timing.startMs < parent.startMs || timing.endMs > parent.endMs)
      throw new TypeError('生成镜头超出所属阶段');
    return { shotId, stageId, ...span(timing) };
  });
  return {
    ...fps,
    durationMs,
    frameCount: frame(durationMs),
    stages,
    shots,
    hookRanges: lock.hookRanges.map(span),
    conversionRanges: lock.conversionRanges.map(span),
  };
}
