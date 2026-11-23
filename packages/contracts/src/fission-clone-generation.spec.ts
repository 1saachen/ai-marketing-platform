import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLONE_SHOT_REFERENCE_MODE,
  cloneShotReferenceFrames,
  compileCloneFrameTimeline,
  FISSION_CLONE_GENERATION_PLAN_SCHEMA,
  FISSION_CLONE_GENERATION_VARIANT_DRAFT_SCHEMA,
  FISSION_CLONE_GENERATION_VARIANT_REVIEW_SCHEMA,
  FISSION_CLONE_GENERATION_VARIANT_SHOT_DRAFT_SCHEMA,
  parseCloneGenerationCreateRequest,
  parseCloneGenerationPlan,
  parseCloneGenerationPreflightRequest,
  parseCloneGenerationRenderCheckpoint,
  parseCloneGenerationVariantDraft,
} from './fission-clone-generation';
import { parseCloneMappingDraft } from './fission-clone-analysis';

const readJson = (part: string) => JSON.parse(readFileSync(resolve(__dirname, part), 'utf8'));
const plan = parseCloneGenerationPlan(readJson('../fixtures/fission-clone-generation-plan.json'));
const lock = parseCloneMappingDraft(
  readJson('../fixtures/fission-clone-mapping.json'),
).structureLock!;

describe('clone generation timeline and schema', () => {
  it('publishes the exact contract consumed by the worker and validates the shared fixture', () => {
    expect(readJson('../schemas/fission-clone-generation-plan.schema.json')).toEqual(
      FISSION_CLONE_GENERATION_PLAN_SCHEMA,
    );
    expect(readJson('../schemas/fission-clone-generation-variant-draft.schema.json')).toEqual(
      FISSION_CLONE_GENERATION_VARIANT_DRAFT_SCHEMA,
    );
    expect(readJson('../schemas/fission-clone-generation-variant-review.schema.json')).toEqual(
      FISSION_CLONE_GENERATION_VARIANT_REVIEW_SCHEMA,
    );
    expect(readJson('../schemas/fission-clone-generation-variant-shot-draft.schema.json')).toEqual(
      FISSION_CLONE_GENERATION_VARIANT_SHOT_DRAFT_SCHEMA,
    );
    expect(plan.timeline).toEqual(
      compileCloneFrameTimeline(lock, { fpsNumerator: 24, fpsDenominator: 1 }),
    );
    expect(() => parseCloneGenerationPlan({ ...plan, mode: 'RETAIN_AUDIO' })).toThrow('枚举');
    expect(() => parseCloneGenerationPlan({ ...plan, timeline: {} })).toThrow('缺少字段');
  });

  it('recognizes historical drafts and requires shot assignments for version 2', () => {
    const variants = [0, 1, 2].map((index) => ({
      variantId: `10000000-0000-4000-8000-00000000000${index}`,
      elementId: 'scene_a',
      dimension: '背景色调',
    }));
    const legacy = { variants: variants.map((variant) => ({ ...variant, direction: '静态布景' })) };
    const shots = {
      version: 2,
      variants: variants.map((variant) => ({
        ...variant,
        shotDirections: [{ shotId: 'shot_a', direction: '浅蓝色墙' }],
      })),
    };
    expect(parseCloneGenerationVariantDraft(legacy)).toEqual(legacy);
    expect(parseCloneGenerationVariantDraft(shots)).toEqual(shots);
    expect(() => parseCloneGenerationVariantDraft({ ...legacy, version: 2 })).toThrow();
    expect(() => parseCloneGenerationVariantDraft({ ...shots, version: 3 })).toThrow();
    expect(() => parseCloneGenerationVariantDraft({ variants: shots.variants })).toThrow();
  });

  it('records a definite provider rejection without a provider task identity', () => {
    expect(parseCloneGenerationRenderCheckpoint({ state: 'CREATE_REJECTED' })).toEqual({
      state: 'CREATE_REJECTED',
    });
    expect(() =>
      parseCloneGenerationRenderCheckpoint({
        state: 'CREATE_REJECTED',
        providerTaskId: 'must-not-be-set',
      }),
    ).toThrow(TypeError);
  });

  it('preserves the optional rendering instruction version without backfilling old plans', () => {
    expect(plan).not.toHaveProperty('renderInstructionVersion');
    const current = { ...plan, renderInstructionVersion: 2 };
    expect(parseCloneGenerationPlan(current)).toEqual(current);
    for (const renderInstructionVersion of [1, 3, '2', null, undefined])
      expect(() => parseCloneGenerationPlan({ ...plan, renderInstructionVersion })).toThrow(
        TypeError,
      );
  });

  it('requires the immutable source video and identified targets for edit plans only', () => {
    const body = structuredClone(plan);
    const end = { endMs: 4000, endFrame: 96 };
    const timeline = {
      ...body.timeline,
      durationMs: 4000,
      frameCount: 96,
      stages: [body.timeline.stages[0]!, { ...body.timeline.stages[1]!, ...end }],
      shots: [body.timeline.shots[0]!, { ...body.timeline.shots[1]!, ...end }],
    };
    const product = { ...body.shots[0]!.targets[0]!, sourceDescription: '手中的白盖粉瓶' };
    const prop = {
      ...product,
      elementId: 'prop_a',
      type: 'prop',
      sourceDescription: '桌面右侧的方形橙盒',
    };
    const sourceVideo = {
      fileObjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sha256: 'f'.repeat(64),
      sizeBytes: 57_000,
      mimeType: 'video/mp4',
      renderSeconds: 4,
    };
    const edit = {
      ...body,
      mode: 'SEEDANCE_2_0_SOURCE_EDIT',
      renderInstructionVersion: 2,
      sourceVideo,
      timeline,
      shots: [
        { ...body.shots[0]!, targets: [product, prop] },
        { ...body.shots[1]!, targets: [] },
      ],
    };
    expect(parseCloneGenerationPlan(edit)).toEqual(edit);
    const { sourceVideo: _source, ...withoutSource } = edit;
    expect(() => parseCloneGenerationPlan(withoutSource)).toThrow('冻结原视频');
    expect(() =>
      parseCloneGenerationPlan({ ...edit, sourceVideo: { ...sourceVideo, renderSeconds: 5 } }),
    ).toThrow('冻结原视频');
    expect(() => parseCloneGenerationPlan({ ...edit, mode: plan.mode })).toThrow('编辑字段');
    const missingTargetImage = structuredClone(edit);
    missingTargetImage.shots[0]!.targets[1]!.imageFileObjectId = null;
    expect(() => parseCloneGenerationPlan(missingTargetImage)).toThrow('目标图片');
    const missingSourceDescription = structuredClone(edit);
    missingSourceDescription.shots[0]!.targets[1]!.sourceDescription = ' ';
    expect(() => parseCloneGenerationPlan(missingSourceDescription)).toThrow('源物件描述');
  });

  it('uses shot-relative motion with a compatible render instruction and matching timeline shot', () => {
    const current = structuredClone(plan);
    current.renderInstructionVersion = 2;
    const shot = current.shots[1]!;
    shot.motion = {
      status: 'OBSERVED',
      openingState: '商品在桌面',
      closingState: '商品悬空',
      reason: '',
      events: [
        {
          startMs: 0,
          endMs: 700,
          subjectAction: '手提起商品',
          cameraAction: '固定镜头',
          contact: '手指捏住包装上缘',
          productPose: '正面朝向镜头',
          evidenceFramesMs: [100, 700],
        },
      ],
    };
    expect(parseCloneGenerationPlan(current)).toEqual(current);
    const unsupported = structuredClone(current);
    delete unsupported.renderInstructionVersion;
    expect(() => parseCloneGenerationPlan(unsupported)).toThrow('渲染指令版本');
    const wrongShot = structuredClone(current);
    wrongShot.shots[1]!.shotId = 'foreign_shot';
    expect(() => parseCloneGenerationPlan(wrongShot)).toThrow('成片镜头');
    shot.motion.events[0]!.endMs = 1501;
    expect(() => parseCloneGenerationPlan(current)).toThrow('动作区间');
  });

  it('requires exactly the corresponding reference frames and immutable original on new plans', () => {
    const sourceVideo = {
      fileObjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sha256: 'f'.repeat(64),
      sizeBytes: 57_000,
      mimeType: 'video/mp4',
    };
    const referenced = {
      ...plan,
      mode: CLONE_SHOT_REFERENCE_MODE,
      sourceVideo,
      renderInstructionVersion: 2,
      shots: plan.shots.map((shot, index) => ({
        ...shot,
        referenceFrames: cloneShotReferenceFrames(plan.timeline.shots[index]!),
        targets: shot.targets.map((target) => ({ ...target, sourceDescription: '参考片的商品' })),
      })),
    };
    expect(parseCloneGenerationPlan(referenced)).toEqual(referenced);
    expect(referenced.shots[0]!.referenceFrames).toBe(48);
    expect(cloneShotReferenceFrames({ startFrame: 96, endFrame: 168 })).toBe(72);
    const noOriginal: Record<string, unknown> = { ...referenced };
    delete noOriginal.sourceVideo;
    expect(() => parseCloneGenerationPlan(noOriginal)).toThrow('冻结原片');
    expect(() =>
      parseCloneGenerationPlan({
        ...referenced,
        sourceVideo: { ...sourceVideo, renderSeconds: 4 },
      }),
    ).toThrow('逐镜头参考');
    const extraFrames = structuredClone(referenced);
    extraFrames.shots[0]!.referenceFrames++;
    expect(() => parseCloneGenerationPlan(extraFrames)).toThrow('参考帧数');
    const noFrames = structuredClone(referenced);
    Reflect.deleteProperty(noFrames.shots[0]!, 'referenceFrames');
    expect(() => parseCloneGenerationPlan(noFrames)).toThrow('参考帧数');
    const noTarget = structuredClone(referenced);
    noTarget.shots[0]!.targets[0]!.sourceDescription = '';
    expect(() => parseCloneGenerationPlan(noTarget)).toThrow('原元素描述');
    expect(() =>
      parseCloneGenerationPlan({
        ...plan,
        shots: [{ ...plan.shots[0]!, referenceFrames: 48 }, ...plan.shots.slice(1)],
      }),
    ).toThrow('参考帧数只能用于逐镜头参考');
  });

  it('rounds absolute boundaries at fractional FPS without accumulating per-shot rounding', () => {
    const shots = [
      { shotId: 'a', stageId: 'stage_a', startMs: 0, endMs: 1001 },
      { shotId: 'b', stageId: 'stage_a', startMs: 1001, endMs: 1035 },
      { shotId: 'c', stageId: 'stage_b', startMs: 1035, endMs: 3036 },
    ];
    const timeline = compileCloneFrameTimeline(
      {
        ...lock,
        durationMs: 3036,
        shots,
        stages: [
          { ...lock.stages[0]!, endMs: 1035 },
          { ...lock.stages[1]!, startMs: 1035, endMs: 3036 },
        ],
      },
      { fpsNumerator: 30000, fpsDenominator: 1001 },
    );
    expect(timeline.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 30],
      [30, 31],
      [31, 91],
    ]);
    expect(timeline.frameCount).toBe(91);
  });

  it('blocks zero-frame intervals, gaps and unconfirmed execution modes', () => {
    const fps = { fpsNumerator: 24, fpsDenominator: 1 };
    expect(() =>
      compileCloneFrameTimeline(
        {
          ...lock,
          shots: [
            { ...lock.shots[0]!, endMs: 1 },
            { ...lock.shots[0]!, shotId: 'extra', startMs: 1 },
            lock.shots[1]!,
          ],
        },
        fps,
      ),
    ).toThrow('完整输出帧');
    expect(() =>
      compileCloneFrameTimeline(
        { ...lock, shots: [{ ...lock.shots[0]!, endMs: 1501 }, lock.shots[1]!] },
        fps,
      ),
    ).toThrow('连续');
    const request = {
      sourceMapping: plan.sources.mapping,
      count: 1,
      audioMode: 'SILENT',
      transitionMode: 'CUT',
    };
    expect(parseCloneGenerationPreflightRequest(request)).toEqual(request);
    expect(parseCloneGenerationPreflightRequest({ ...request, count: 2 }).count).toBe(2);
    const two = {
      ...request,
      count: 2,
      idempotencyKey: plan.sources.mapping.artifactId,
      acceptedRenderSeconds: 120,
    };
    expect(parseCloneGenerationCreateRequest(two)).toEqual(two);
    expect(parseCloneGenerationCreateRequest({ ...two, acceptedReferenceFrames: 192 })).toEqual({
      ...two,
      acceptedReferenceFrames: 192,
    });
    for (const value of [-1, 47, 48.5, '192'])
      expect(() =>
        parseCloneGenerationCreateRequest({ ...two, acceptedReferenceFrames: value }),
      ).toThrow(TypeError);
    expect(parseCloneGenerationPreflightRequest({ ...request, count: 20 }).count).toBe(20);
    expect(() =>
      parseCloneGenerationCreateRequest({ ...two, acceptedRenderSeconds: 1201 }),
    ).toThrow(TypeError);
    for (const bad of [
      { ...request, count: 21 },
      { ...request, count: 1.5 },
      { ...request, count: undefined },
      { ...request, audioMode: 'KEEP' },
      { ...request, transitionMode: 'CROSSFADE' },
      { ...request, sourceMapping: undefined },
      { ...request, model: 'arbitrary' },
    ])
      expect(() => parseCloneGenerationPreflightRequest(bad)).toThrow(TypeError);
  });
});
