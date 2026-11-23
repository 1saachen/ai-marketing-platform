import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FISSION_CLONE_ANALYSIS_REPORT_SCHEMA,
  FISSION_CLONE_ANALYSIS_DRAFT_SCHEMA,
  FISSION_CLONE_MAPPING_DRAFT_SCHEMA,
  FISSION_CLONE_TASK_RESULT_SCHEMA,
  FISSION_CLONE_TASK_CREATE_SCHEMA,
  emptyCloneAnalysisDraft,
  emptyCloneMappingDraft,
  parseCloneAnalysisReport,
  parseCloneAnalysisDraft,
  parseCloneMappingDraft,
  parseCloneTaskResult,
  parseCloneTaskCreateRequest,
  validateCloneMappingForReport,
  validateCloneVisualOnlyReport,
  type CloneAnalysisReport,
  type CloneMappingDraft,
  type CloneShotMotion,
} from './fission-clone-analysis';

const read = (path: string) => JSON.parse(readFileSync(resolve(__dirname, '..', path), 'utf8'));
const report = () => read('fixtures/fission-clone-analysis.json') as CloneAnalysisReport;
const mapping = () => read('fixtures/fission-clone-mapping.json') as CloneMappingDraft;
const reportWithProp = () => {
  const value = report();
  value.elements.push({
    ...value.elements[0]!,
    elementId: 'orange_box',
    type: 'prop',
    required: false,
    label: '橙色盒',
    description: '主商品右上方的橙色长方形盒子，靠在圆形粉盒左侧',
    evidence: [
      {
        startMs: 0,
        endMs: 200,
        kind: 'VISUAL',
        description: '开场可见盒子边缘',
        confidence: 0.95,
      },
    ],
  });
  value.shots[0]!.elementIds.push('orange_box');
  return value;
};
const withObservedMotion = () => {
  const value = report();
  const shot = value.shots[1]!;
  shot.evidenceFramesMs = [1600, 2200, 2700];
  const event = {
    startMs: 1600,
    endMs: 2200,
    subjectAction: '手将商品从桌面提起',
    cameraAction: '机位固定',
    contact: '手指捏住包装上缘',
    productPose: '保持直立，正面仍朝向镜头',
    evidenceFramesMs: [1600, 2200],
  };
  const motion: CloneShotMotion = {
    status: 'OBSERVED',
    openingState: '商品在桌面',
    closingState: '商品悬空',
    reason: '',
    events: [event, { ...event, startMs: 2200, endMs: 2800, evidenceFramesMs: [2200, 2700] }],
  };
  shot.motion = motion;
  return { value, motion };
};

describe('Clone G2 contracts', () => {
  it('publishes exactly the schemas consumed by the Worker, and accepts both shared fixtures', () => {
    for (const schema of [
      FISSION_CLONE_ANALYSIS_REPORT_SCHEMA,
      FISSION_CLONE_ANALYSIS_DRAFT_SCHEMA,
      FISSION_CLONE_MAPPING_DRAFT_SCHEMA,
      FISSION_CLONE_TASK_RESULT_SCHEMA,
      FISSION_CLONE_TASK_CREATE_SCHEMA,
    ])
      expect(read(`schemas/${schema.$id}`)).toEqual(schema);
    expect(parseCloneAnalysisReport(report())).toEqual(report());
    expect(parseCloneMappingDraft(mapping())).toEqual(mapping());
    expect(parseCloneAnalysisDraft(emptyCloneAnalysisDraft())).toEqual(emptyCloneAnalysisDraft());
    expect(parseCloneMappingDraft(emptyCloneMappingDraft())).toEqual(emptyCloneMappingDraft());
    expect(() => validateCloneVisualOnlyReport(report())).not.toThrow();
  });
  it('preserves supported in-shot observations while accepting reports saved before motion existed', () => {
    const { value } = withObservedMotion();
    value.shots[0]!.motion = {
      status: 'INSUFFICIENT_EVIDENCE',
      openingState: '',
      closingState: '',
      reason: '镜头只有一个采样点',
      events: [],
    };
    expect(parseCloneAnalysisReport(value)).toEqual(value);
    expect(parseCloneTaskResult({ operation: 'ANALYZE', report: value })).toEqual({
      operation: 'ANALYZE',
      report: value,
    });
    expect(parseCloneAnalysisReport(report()).shots[0]).not.toHaveProperty('motion');
  });
  it('requires two distinct shot samples before reporting no visible motion', () => {
    const value = report();
    const shot = value.shots[0]!;
    shot.motion = {
      status: 'NO_VISIBLE_MOTION',
      openingState: '商品在桌面',
      closingState: '商品在桌面',
      reason: '两个样本中的位置和姿态一致',
      events: [],
    };
    shot.evidenceFramesMs = [0, 1200];
    expect(parseCloneAnalysisReport(value)).toEqual(value);
    shot.evidenceFramesMs = [0, 0];
    expect(() => parseCloneAnalysisReport(value)).toThrow('两个不同');
  });
  it.each<[string, (motion: CloneShotMotion) => void]>([
    ['unknown status', (motion) => (motion.status = 'READY' as never)],
    ['observed with no events', (motion) => (motion.events = [])],
    [
      'blank event observations',
      (motion) =>
        Object.assign(motion.events[0]!, {
          subjectAction: ' ',
          cameraAction: '',
          contact: '',
          productPose: '',
        }),
    ],
    ['no visible motion with events', (motion) => (motion.status = 'NO_VISIBLE_MOTION')],
    [
      'insufficient evidence without a reason',
      (motion) =>
        Object.assign(motion, { status: 'INSUFFICIENT_EVIDENCE', events: [], reason: ' ' }),
    ],
    ['interval outside the shot', (motion) => (motion.events[0]!.startMs = 1499)],
    ['overlapping events', (motion) => (motion.events[1]!.startMs = 2199)],
    ['empty event evidence', (motion) => (motion.events[0]!.evidenceFramesMs = [])],
    ['unlisted evidence frame', (motion) => (motion.events[0]!.evidenceFramesMs = [1600, 1900])],
    ['evidence outside the event', (motion) => (motion.events[0]!.evidenceFramesMs = [2700])],
    ['repeated evidence frame', (motion) => (motion.events[0]!.evidenceFramesMs = [1600, 1600])],
  ])('rejects %s in a motion report', (_label, mutate) => {
    const { value, motion } = withObservedMotion();
    mutate(motion);
    expect(() => parseCloneAnalysisReport(value)).toThrow();
  });
  it.each([
    [
      'missing dimension',
      (r: CloneAnalysisReport) => {
        delete (r as Partial<CloneAnalysisReport>).audio;
      },
    ],
    ['unknown property', (r: CloneAnalysisReport) => Object.assign(r, { fakeQuality: 100 })],
    [
      'unknown observation',
      (r: CloneAnalysisReport) => {
        r.audio.bgm.status = 'READY' as never;
      },
    ],
    [
      'duplicate shot',
      (r: CloneAnalysisReport) => {
        r.shots[1]!.shotId = r.shots[0]!.shotId;
      },
    ],
    [
      'gap in shots',
      (r: CloneAnalysisReport) => {
        r.shots[1]!.startMs++;
      },
    ],
    [
      'stage share',
      (r: CloneAnalysisReport) => {
        r.structure.stages[0]!.proportion = 0.8;
      },
    ],
    [
      'outside evidence',
      (r: CloneAnalysisReport) => {
        r.shots[0]!.evidenceFramesMs = [1500];
      },
    ],
    [
      'foreign element',
      (r: CloneAnalysisReport) => {
        r.shots[0]!.elementIds = ['missing'];
      },
    ],
    [
      'missing reverse link',
      (r: CloneAnalysisReport) => {
        r.elements[0]!.shotIds = ['shot_b'];
      },
    ],
    [
      'optional product',
      (r: CloneAnalysisReport) => {
        r.elements[0]!.required = false;
      },
    ],
    [
      'unknown without reason',
      (r: CloneAnalysisReport) => {
        r.audio.bgm.reason = ' ';
      },
    ],
    [
      'fractional milliseconds',
      (r: CloneAnalysisReport) => {
        r.shots[0]!.startMs = 0.5;
      },
    ],
    [
      'invalid confidence',
      (r: CloneAnalysisReport) => {
        r.product.overview.confidence = 1.1;
      },
    ],
    [
      'reversed interval',
      (r: CloneAnalysisReport) => {
        r.structure.hookRanges[0]!.endMs = 0;
      },
    ],
  ])('rejects %s instead of publishing a partial report', (_label, mutate) => {
    const value = report();
    (mutate as (r: CloneAnalysisReport) => void)(value);
    expect(() => parseCloneAnalysisReport(value)).toThrow();
  });
  it('rejects inferred audio presented as real analysis in sampled-frame mode', () => {
    const value = report();
    value.audio.bgm.status = 'OBSERVED';
    value.audio.bgm.summary = '112 BPM';
    expect(() => validateCloneVisualOnlyReport(value)).toThrow();
    value.audio.bgm.status = 'UNASSESSED';
    value.audio.beatsMs = [10];
    expect(() => validateCloneVisualOnlyReport(value)).toThrow();
  });
  it('accepts a separate optional prop only when its appearance has matching visual evidence', () => {
    const value = reportWithProp();
    expect(parseCloneAnalysisReport(value)).toEqual(value);
    const prop = value.elements.at(-1)!;
    prop.required = true;
    expect(() => parseCloneAnalysisReport(value)).toThrow('可选视觉元素');
    prop.required = false;
    prop.evidence.push({ ...prop.evidence[0]!, startMs: 500, endMs: 550 });
    expect(() => parseCloneAnalysisReport(value)).toThrow('画面证据');
    prop.evidence.pop();
    value.shots[0]!.evidenceFramesMs = [1000];
    expect(() => parseCloneAnalysisReport(value)).toThrow('画面证据');
  });
  it('keeps optional props without target assets and requires an image reference to confirm replacement', () => {
    const value = mapping();
    const replacement = value.bindings[0]!.target!;
    const prop: CloneMappingDraft['bindings'][number] = {
      elementId: 'orange_box',
      type: 'prop',
      action: 'KEEP',
      shotIds: ['shot_a'],
      target: null,
    };
    value.bindings.push(prop);
    expect(parseCloneMappingDraft(value)).toEqual(value);
    const source = reportWithProp();
    expect(() => validateCloneMappingForReport(value, source, true)).not.toThrow();
    prop.action = 'REPLACE';
    prop.target = { ...replacement, asset: null, text: '另一个圆盒' };
    expect(() => validateCloneMappingForReport(value, source)).not.toThrow();
    expect(() => validateCloneMappingForReport(value, source, true)).toThrow('目标道具图片');
    prop.target.asset = { assetId: '33333333-3333-4333-8333-333333333333', version: 2 };
    expect(() => validateCloneMappingForReport(value, source, true)).not.toThrow();
  });
  it('validates every product instance, and permits incomplete drafts without confirming them', () => {
    const value = mapping();
    value.bindings.pop();
    expect(() => parseCloneMappingDraft(value)).not.toThrow();
    expect(() => validateCloneMappingForReport(value, report(), false)).not.toThrow();
    expect(() => validateCloneMappingForReport(value, report(), true)).toThrow('全部');
    const kept = mapping();
    kept.bindings[1]!.action = 'KEEP';
    expect(() => validateCloneMappingForReport(kept, report(), true)).toThrow('必须替换');
  });
  it('locks exact structure but ignores object property insertion order', () => {
    const value = mapping();
    value.structureLock = Object.fromEntries(
      Object.entries(value.structureLock!).reverse(),
    ) as typeof value.structureLock;
    expect(() => validateCloneMappingForReport(value, report(), true)).not.toThrow();
    value.structureLock!.shots[0]!.endMs--;
    expect(() => validateCloneMappingForReport(value, report(), true)).toThrow('结构锁定');
  });
  it('rejects foreign shot scope, target-only style for product, and contradictory constraints', () => {
    const a = mapping();
    a.bindings[0]!.shotIds = ['shot_b'];
    expect(() => validateCloneMappingForReport(a, report(), true)).toThrow();
    const b = mapping();
    b.bindings[1]!.target!.text = '';
    b.bindings[1]!.target!.style = '暖色';
    expect(() => validateCloneMappingForReport(b, report(), true)).toThrow('产品');
    const c = mapping();
    c.bindings[0]!.target!.allowedVariations = ['商品外观'];
    expect(() => validateCloneMappingForReport(c, report(), true)).toThrow('同时');
  });
  it('blocks unsupported burned-in KEEP and requires transcribed text for content KEEP', () => {
    const r = report();
    r.elements[0]!.type = 'subtitle';
    r.elements[0]!.required = false;
    r.elements[0]!.sourceTrack = 'BURNED_IN';
    const m = mapping();
    m.bindings[0]!.type = 'subtitle';
    m.bindings[0]!.action = 'KEEP';
    expect(() => validateCloneMappingForReport(m, r, true)).toThrow('保留能力');
    m.bindings[0]!.action = 'REPLACE';
    m.bindings[0]!.target!.contentStrategy = 'KEEP';
    expect(() => validateCloneMappingForReport(m, r, true)).toThrow('保留文本');
  });
  it('keeps operation/purpose/result structures separate', () => {
    expect(parseCloneTaskResult({ operation: 'ANALYZE', report: report() }).operation).toBe(
      'ANALYZE',
    );
    expect(
      parseCloneTaskResult({
        operation: 'MAP_SUGGEST',
        purpose: 'SMART_MATCH',
        mapping: mapping(),
        notes: [],
      }).operation,
    ).toBe('MAP_SUGGEST');
    expect(
      parseCloneTaskResult({ operation: 'MAP_SUGGEST', purpose: 'VALIDATE_KEEP_TEXT', checks: [] })
        .operation,
    ).toBe('MAP_SUGGEST');
    expect(() =>
      parseCloneTaskResult({
        operation: 'MAP_SUGGEST',
        purpose: 'VALIDATE_KEEP_TEXT',
        mapping: mapping(),
        checks: [],
      }),
    ).toThrow();
  });
  it('requires exact sources and bounded integer revisions for task creation', () => {
    const request = {
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      sourceInput: mapping().sourceInput,
      sourceAnalysis: null,
      expectedDraftRevision: 0,
      expectedArtifactRevision: 0,
      purpose: null,
    };
    expect(parseCloneTaskCreateRequest(request)).toEqual(request);
    expect(() => parseCloneTaskCreateRequest({ ...request, expectedDraftRevision: -1 })).toThrow();
    expect(() =>
      parseCloneTaskCreateRequest({
        ...request,
        sourceInput: { ...request.sourceInput, contentHash: 'arbitrary' },
      }),
    ).toThrow();
  });
});
