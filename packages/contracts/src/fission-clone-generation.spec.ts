import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileCloneFrameTimeline,
  FISSION_CLONE_GENERATION_PLAN_SCHEMA,
  FISSION_CLONE_GENERATION_VARIANT_DRAFT_SCHEMA,
  FISSION_CLONE_GENERATION_VARIANT_REVIEW_SCHEMA,
  FISSION_CLONE_GENERATION_VARIANT_SHOT_DRAFT_SCHEMA,
  parseCloneGenerationCreateRequest,
  parseCloneGenerationPlan,
  parseCloneGenerationPreflightRequest,
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
