import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLONE_SHOT_REFERENCE_MODE,
  cloneStructureLock,
  normalizeCloneInputDraft,
  parseCloneAnalysisReport,
  parseCloneGenerationPlan,
  type CloneMappingDraft,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { compileCloneGenerationPlan, summarizeCloneGenerationPlan } from './clone-generation-plan';

const readFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), '../../packages/contracts/fixtures', name), 'utf8'),
  );

function setup() {
  const { projectId, workflowRunId, images, sources } = parseCloneGenerationPlan(
    readFixture('fission-clone-generation-plan.json'),
  );
  const report = parseCloneAnalysisReport(readFixture('fission-clone-analysis.json'));
  report.durationMs = 4000;
  report.frameWidth = 720;
  report.frameHeight = 1280;
  report.structure.stages[0]!.proportion = 0.375;
  const stage = report.structure.stages[1]!;
  stage.endMs = 4000;
  stage.proportion = 0.625;
  report.shots[1]!.endMs = 4000;
  const person = report.elements[1]!;
  person.label = '画面中的手';
  person.type = 'person';
  person.required = false;
  report.elements.push({
    ...report.elements[0]!,
    elementId: 'prop_orange_box',
    type: 'prop',
    label: '橙色方盒',
    description: '画面左侧的直角橙色纸盒',
    ranges: [{ startMs: 0, endMs: 1500 }],
    evidence: [
      { kind: 'VISUAL', startMs: 0, endMs: 1500, description: '瓶旁的盒子', confidence: 0.9 },
    ],
    required: false,
  });
  report.shots[0]!.elementIds.push('prop_orange_box');

  const [image] = images;
  const reference = { assetId: image!.assetId, version: image!.version };
  const target = {
    asset: reference,
    text: '白盖绿色包装',
    style: '',
    voice: '',
    contentStrategy: 'NONE' as const,
    presentationStrategy: 'NONE' as const,
    lockedAttributes: [],
    allowedVariations: [],
  };
  const mapping: CloneMappingDraft = {
    schemaVersion: 1,
    sourceInput: sources.input,
    sourceAnalysis: sources.analysis,
    structureLock: cloneStructureLock(report),
    bindings: report.elements.map(({ elementId, type, shotIds }) => ({
      elementId,
      type,
      shotIds,
      action: type === 'product' ? 'REPLACE' : 'KEEP',
      target: type === 'product' ? target : null,
    })),
  };
  return {
    data: {
      projectId,
      workflowRunId,
      sources,
      report,
      mapping,
      images,
      sourceVideo: {
        fileObjectId: '51f2ec5c-3094-4027-a87f-a966c9d197ab',
        mimeType: 'video/mp4' as const,
        sha256: 'f'.repeat(64),
        sizeBytes: 1234,
      },
      input: normalizeCloneInputDraft({
        schemaVersion: 1,
        referenceUploadId: null,
        productUploadIds: [],
        productName: '测试商品',
        productFacts: '白色瓶盖与绿色瓶身',
        sourceRightsConfirmed: true,
      }),
    },
    target,
  };
}

describe('clone shot reproduction plan', () => {
  it('keeps the source cut points and counts every rendered shot per variant', () => {
    const { data } = setup();
    const plan = compileCloneGenerationPlan(data);
    expect(plan.mode).toBe(CLONE_SHOT_REFERENCE_MODE);
    expect(plan.sourceVideo).toEqual(data.sourceVideo);
    expect(plan.shots[0]!.targets).toMatchObject([
      { elementId: 'product_a', type: 'product', sourceDescription: expect.stringMatching(/\S/u) },
    ]);
    expect(plan.shots[1]!.targets).toEqual([]);
    expect(plan.timeline.frameCount).toBe(96);
    expect(plan.timeline.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 36],
      [36, 96],
    ]);
    expect(summarizeCloneGenerationPlan(plan, 2)).toMatchObject({
      shots: [
        { renderSeconds: 4, referenceFrames: 48 },
        { renderSeconds: 4, referenceFrames: 60 },
      ],
      totalRenderSeconds: 16,
      totalReferenceFrames: 216,
    });
  });

  it('freezes movement and relative action evidence with optional product text left empty', () => {
    const { data } = setup();
    data.input.productName = '';
    data.input.productFacts = '';
    const shot = data.report.shots[1]!;
    shot.cameraMovement = '缓慢向右横移';
    shot.composition = '手从左侧进入画面';
    shot.evidenceFramesMs = [1500, 2400];
    shot.motion = {
      status: 'OBSERVED',
      reason: '',
      openingState: '手位于画面左缘',
      closingState: '手停在画面中央',
      events: [
        {
          startMs: 2000,
          endMs: 2800,
          subjectAction: '手缓慢向画面中央移动',
          cameraAction: '缓慢向右横移',
          contact: '',
          productPose: '',
          evidenceFramesMs: [2400],
        },
      ],
    };
    const plan = compileCloneGenerationPlan(data);
    expect(plan.productName).toBe('');
    expect(plan.productFacts).toBe('');
    expect(plan.shots[0]!.targets[0]!.imageFileObjectId).toBe(data.images[0]!.fileObjectId);
    expect(plan.shots[1]).toMatchObject({
      framing: shot.framing,
      cameraMovement: shot.cameraMovement,
      composition: shot.composition,
      motion: { events: [{ startMs: 500, endMs: 1300, evidenceFramesMs: [900] }] },
    });
  });

  it('requires an explicit return to KEEP for a historical replaced prop', () => {
    const { data, target } = setup();
    const binding = data.mapping.bindings.find(({ type }) => type === 'prop')!;
    binding.action = 'REPLACE';
    binding.target = { ...target, text: '目标海蓝色包装盒' };
    expect(() => compileCloneGenerationPlan(data)).toThrow('将道具设为保留');
    expect(binding.action).toBe('REPLACE');
  });

  it('supports shorter reference cuts while keeping the minimum provider request per shot', () => {
    const { data } = setup();
    data.report.durationMs = 3999;
    data.report.shots[1]!.endMs = 3999;
    data.report.structure.stages[1]!.endMs = 3999;
    data.mapping.structureLock = cloneStructureLock(data.report);
    const plan = compileCloneGenerationPlan(data);
    expect(plan.timeline.durationMs).toBe(3999);
    expect(plan.shots.map(({ renderSeconds }) => renderSeconds)).toEqual([4, 4]);
  });
});
