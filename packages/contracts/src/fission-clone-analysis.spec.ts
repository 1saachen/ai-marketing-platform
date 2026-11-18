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
} from './fission-clone-analysis';

const read = (path: string) => JSON.parse(readFileSync(resolve(__dirname, '..', path), 'utf8'));
const report = () => read('fixtures/fission-clone-analysis.json') as CloneAnalysisReport;
const mapping = () => read('fixtures/fission-clone-mapping.json') as CloneMappingDraft;

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
