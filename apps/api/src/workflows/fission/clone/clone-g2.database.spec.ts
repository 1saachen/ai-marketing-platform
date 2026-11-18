import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cloneStructureLock,
  emptyCloneInputDraft,
  parseCloneAnalysisReport,
  type CloneAnalysisReport,
  type CloneArtifactRef,
  type CloneMappingDraft,
  type CloneTaskCreateRequest,
  type CloneTaskResult,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { CloneRepository } from './clone.repository';
import { CloneTaskRepository } from './clone-task.repository';
import { cloneArtifactRef } from './clone-task-scope';
import { CloneGenerationRepository, cloneArchiveOperationKey } from './clone-generation.repository';

const enabled = process.env.FISSION_CLONE_G2_DATABASE_TEST === '1';
const reportFixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../packages/contracts/fixtures/fission-clone-analysis.json'),
    'utf8',
  ),
) as unknown;
describe.skipIf(!enabled)('clone G2 isolated database transaction boundaries', () => {
  let db: PrismaService;
  let working: WorkflowWorkingRepository;
  let inputRepo: CloneRepository;
  let tasks: CloneTaskRepository;
  let generation: CloneGenerationRepository;
  let projects: string[];
  beforeEach(() => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/missing');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.startsWith('/clone_g2_')
    )
      throw new Error('G2 tests require an explicitly isolated local clone_g2_ database');
    const config = new ConfigService({
      DATABASE_URL: url.toString(),
      FISSION_CLONE_ENABLED: true,
      FISSION_CLONE_G2_ENABLED: true,
      FISSION_CLONE_TASK_MAX_ATTEMPTS: 3,
      FISSION_CLONE_TASK_LEASE_SECONDS: 30,
    });
    db = new PrismaService(config);
    working = new WorkflowWorkingRepository(db, config);
    inputRepo = new CloneRepository(db, working, config);
    tasks = new CloneTaskRepository(db, working, config);
    generation = new CloneGenerationRepository(db, tasks, working);
    projects = [];
  });
  afterEach(async () => {
    if (!db) return;
    try {
      const where = { projectId: { in: projects } };
      await db.fissionCloneFileHold.deleteMany({ where });
      await db.fissionCloneMappingFile.deleteMany({ where });
      await db.workingArtifactDependency.deleteMany({ where });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where });
      await db.workingArtifactFile.deleteMany({ where });
      await db.fissionCloneUpload.deleteMany({ where });
      await db.assetOperationReceipt.deleteMany({ where });
      await db.assetVersion.deleteMany({ where });
      await db.asset.deleteMany({ where });
      await db.project.deleteMany({ where: { id: { in: projects } } });
    } finally {
      await db.$disconnect();
    }
  }, 30_000);
  const report = (): CloneAnalysisReport =>
    parseCloneAnalysisReport(structuredClone(reportFixture));
  async function setup() {
    const p = randomUUID();
    projects.push(p);
    await db.project.create({ data: { id: p, name: 'G2隔离数据库测试' } });
    const r = await inputRepo.initialize(p);
    const attempt = await inputRepo.beginUpload(p, r, randomUUID());
    // Identity-only repository fixture. No real media decoding or provider call is claimed.
    const upload = await inputRepo.finishUpload(
      p,
      r,
      attempt.id,
      attempt.attemptToken,
      'REFERENCE',
      {
        nodeId: 'CLONE_INPUT',
        originalFileName: 'identity-only.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 100,
        storageKey: `g2-test/${p}/${randomUUID()}`,
        sha256: createHash('sha256').update(p).digest('hex'),
      },
      { durationMs: 3000, width: 360, height: 640, frameRate: 24 },
    );
    const state = {
      ...emptyCloneInputDraft(),
      referenceUploadId: upload.id,
      productName: '绿色方块',
      productFacts: '包装为绿色方块，图片有依据。',
      sourceRightsConfirmed: true,
    };
    const saved = await working.saveNodeState(
      p,
      r,
      'CLONE_INPUT',
      workflowStateHash(state),
      state,
      1,
      1,
    );
    await inputRepo.confirm(p, r, {
      expectedDraftRevision: saved.record.revision,
      expectedInputRevision: 0,
    });
    const input = (await inputRepo.workspace(p, r)).input!;
    return { p, r, source: cloneArtifactRef(input), inputDraftRevision: saved.record.revision };
  }
  function request(
    source: CloneArtifactRef,
    overrides: Partial<CloneTaskCreateRequest> = {},
  ): CloneTaskCreateRequest {
    return {
      idempotencyKey: randomUUID(),
      sourceInput: source,
      sourceAnalysis: null,
      expectedDraftRevision: 0,
      expectedArtifactRevision: 0,
      purpose: null,
      ...overrides,
    };
  }
  async function runAnalysis(s: Awaited<ReturnType<typeof setup>>, value = report()) {
    const workspace = await tasks.workspace(s.p, s.r);
    const task = await tasks.create(
      s.p,
      s.r,
      'ANALYZE',
      request(s.source, {
        expectedDraftRevision: workspace.analysisDraft.revision,
        expectedArtifactRevision: workspace.analysis?.ref.revision ?? 0,
      }),
      [],
      'test-provider-never-called',
    );
    const claim = await tasks.claim(s.p, task.id);
    const result: CloneTaskResult = { operation: 'ANALYZE', report: value };
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    return { task, claim, result, workspace: await tasks.workspace(s.p, s.r) };
  }
  function mapping(
    source: CloneArtifactRef,
    analysis: CloneArtifactRef,
    value: CloneAnalysisReport,
  ): CloneMappingDraft {
    return {
      schemaVersion: 1,
      sourceInput: source,
      sourceAnalysis: analysis,
      structureLock: cloneStructureLock(value),
      bindings: value.elements.map((element) => ({
        elementId: element.elementId,
        type: element.type,
        action: 'REPLACE',
        shotIds: [...element.shotIds],
        target: {
          asset: null,
          text: element.type === 'product' ? '绿色方块包装' : '目标元素明确配置',
          style: '',
          voice: '',
          contentStrategy: 'REPLACE',
          presentationStrategy: 'REPLACE',
          lockedAttributes: ['商品身份'],
          allowedVariations: ['背景色调'],
        },
      })),
    };
  }
  async function saveMapping(
    s: Awaited<ReturnType<typeof setup>>,
    state: CloneMappingDraft,
    expected?: number,
  ) {
    const revision = expected ?? (await tasks.workspace(s.p, s.r)).mappingDraft.revision;
    const saved = await working.saveNodeState(
      s.p,
      s.r,
      'CLONE_MAPPING',
      workflowStateHash(state),
      state,
      revision,
      1,
    );
    expect(saved.conflict).toBe(false);
    return saved.record.revision;
  }

  it('creates task + small Outbox atomically and rejects duplicate-key drift or active-source changes', async () => {
    const s = await setup(),
      req = request(s.source);
    const [one, two] = await Promise.all([
      tasks.create(s.p, s.r, 'ANALYZE', req, [], 'model'),
      tasks.create(s.p, s.r, 'ANALYZE', req, [], 'model'),
    ]);
    expect(one.id).toBe(two.id);
    const outbox = await db.jobOutbox.findFirst({ where: { projectId: s.p } });
    expect(outbox?.routingKey).toBe('fission.clone.analysis.requested');
    expect(Object.keys(outbox!.payload as object).sort()).toEqual([
      'projectId',
      'requestId',
      'runId',
      'schemaVersion',
    ]);
    await expect(
      tasks.create(s.p, s.r, 'ANALYZE', { ...req, expectedDraftRevision: 9 }, [], 'model'),
    ).rejects.toThrow('同一请求');
    await expect(
      inputRepo.confirm(s.p, s.r, {
        expectedDraftRevision: s.inputDraftRevision,
        expectedInputRevision: 1,
      }),
    ).rejects.toThrow('任务正在使用');
    expect(await db.fissionCloneFileHold.count({ where: { projectId: s.p, taskId: one.id } })).toBe(
      1,
    );
  }, 30_000);
  it('automatically commits a complete analysis with exact dependency and completion replay stays revision 1', async () => {
    const s = await setup();
    const task = await tasks.create(s.p, s.r, 'ANALYZE', request(s.source), [], 'model');
    const claim = await tasks.claim(s.p, task.id),
      result: CloneTaskResult = { operation: 'ANALYZE', report: report() };
    expect((await tasks.claim(s.p, task.id)).claimed).toBe(false);
    await expect(tasks.complete(s.p, task.id, claim.attemptToken!, result)).rejects.toThrow(
      '检查点',
    );
    await expect(tasks.heartbeat(s.p, task.id, randomUUID())).rejects.toThrow('租约');
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    const current = await tasks.workspace(s.p, s.r);
    expect(current.analysis?.ref.revision).toBe(1);
    expect(current.analysisDraft.state.baseAnalysisRevision).toBe(1);
    expect(current.analysis?.sourceInput).toEqual(s.source);
    const dependency = await db.workingArtifactDependency.findFirst({
      where: { projectId: s.p, dependentArtifactId: current.analysis!.ref.artifactId },
    });
    expect(dependency).toMatchObject({
      sourceArtifactId: s.source.artifactId,
      sourceRevision: s.source.revision,
      sourceHash: s.source.contentHash,
    });
  }, 30_000);
  it('keeps concurrent human report draft while background analysis commits', async () => {
    const s = await setup();
    const task = await tasks.create(s.p, s.r, 'ANALYZE', request(s.source), [], 'model'),
      claim = await tasks.claim(s.p, task.id);
    const human = report();
    human.creativity.concept = '人工未采用创意';
    await tasks.saveAnalysis(s.p, s.r, {
      expectedRevision: 0,
      state: { schemaVersion: 1, sourceInput: s.source, baseAnalysisRevision: 0, report: human },
    });
    const result: CloneTaskResult = { operation: 'ANALYZE', report: report() };
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    const view = await tasks.workspace(s.p, s.r);
    expect(view.analysisDraftDiverged).toBe(true);
    expect(view.analysisDraft.state.report?.creativity.concept).toBe('人工未采用创意');
    expect(view.analysis?.report.creativity.concept).not.toBe('人工未采用创意');
  }, 30_000);
  it('replays manual report confirmation without duplicating revision or overwriting later edits', async () => {
    const s = await setup();
    await tasks.saveAnalysis(s.p, s.r, {
      expectedRevision: 0,
      state: { schemaVersion: 1, sourceInput: s.source, baseAnalysisRevision: 0, report: report() },
    });
    const view = await tasks.workspace(s.p, s.r);
    const confirmation = {
      expectedDraftRevision: view.analysisDraft.revision,
      expectedAnalysisRevision: 0,
    };
    await tasks.confirmAnalysis(s.p, s.r, confirmation);
    await tasks.confirmAnalysis(s.p, s.r, confirmation);
    const confirmed = await tasks.workspace(s.p, s.r);
    expect(confirmed.analysis?.ref.revision).toBe(1);
    const edited = structuredClone(confirmed.analysisDraft.state);
    edited.report!.creativity.concept = '后续尚未提交的人工编辑';
    await tasks.saveAnalysis(s.p, s.r, {
      expectedRevision: confirmed.analysisDraft.revision,
      state: edited,
    });
    await expect(tasks.confirmAnalysis(s.p, s.r, confirmation)).rejects.toThrow('草稿已变化');
    expect((await tasks.workspace(s.p, s.r)).analysisDraft.state.report?.creativity.concept).toBe(
      '后续尚未提交的人工编辑',
    );
  }, 30_000);
  it('permits paused-run completion but rejects cancelled attempts and cross-project task access', async () => {
    const s = await setup(),
      other = await setup();
    const task = await tasks.create(s.p, s.r, 'ANALYZE', request(s.source), [], 'model'),
      claim = await tasks.claim(s.p, task.id);
    await expect(tasks.task(other.p, other.r, task.id)).rejects.toThrow('不存在');
    await db.workflowRun.update({ where: { id: s.r }, data: { status: 'PAUSED' } });
    const result: CloneTaskResult = { operation: 'ANALYZE', report: report() };
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    expect((await tasks.workspace(s.p, s.r)).analysis?.ref.revision).toBe(1);
    await inputRepo.initialize(s.p);
    const current = await tasks.workspace(s.p, s.r);
    const next = await tasks.create(
      s.p,
      s.r,
      'ANALYZE',
      request(s.source, {
        expectedDraftRevision: current.analysisDraft.revision,
        expectedArtifactRevision: 1,
      }),
      [],
      'model',
    );
    const nextClaim = await tasks.claim(s.p, next.id);
    await tasks.cancel(s.p, s.r, next.id);
    await expect(tasks.complete(s.p, next.id, nextClaim.attemptToken!, result)).rejects.toThrow(
      '租约',
    );
  }, 30_000);
  it('recovers expired leases with a new attempt and preserves validated checkpoints on retry', async () => {
    const s = await setup(),
      task = await tasks.create(s.p, s.r, 'ANALYZE', request(s.source), [], 'model');
    const first = await tasks.claim(s.p, task.id),
      result: CloneTaskResult = { operation: 'ANALYZE', report: report() };
    await tasks.checkpoint(s.p, task.id, first.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: first.inputHash!,
      output: result,
    });
    await db.fissionCloneTask.update({
      where: { id: task.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await tasks.recoverExpired();
    const next = await tasks.claim(s.p, task.id);
    expect(next.attemptToken).not.toBe(first.attemptToken);
    expect(next.checkpoints).toHaveLength(1);
    await expect(tasks.complete(s.p, task.id, first.attemptToken!, result)).rejects.toThrow('租约');
    await tasks.fail(s.p, task.id, next.attemptToken!, true);
    await tasks.retry(s.p, s.r, task.id);
    const last = await tasks.claim(s.p, task.id);
    expect(last.checkpoints).toHaveLength(1);
    await tasks.complete(s.p, task.id, last.attemptToken!, result);
  }, 30_000);
  it('stops retries at the attempt budget and releases files that no future attempt can consume', async () => {
    const s = await setup();
    const task = await tasks.create(s.p, s.r, 'ANALYZE', request(s.source), [], 'model');
    const claim = await tasks.claim(s.p, task.id);
    await db.fissionCloneTask.update({ where: { id: task.id }, data: { attemptCount: 3 } });
    await tasks.fail(s.p, task.id, claim.attemptToken!, true);
    expect((await tasks.task(s.p, s.r, task.id)).canRetry).toBe(false);
    expect(
      await db.fissionCloneFileHold.count({ where: { projectId: s.p, taskId: task.id } }),
    ).toBe(0);
    await expect(tasks.retry(s.p, s.r, task.id)).rejects.toThrow('不能重试');
  }, 30_000);
  it('keeps late smart-match suggestions pending until explicit current-revision adoption', async () => {
    const s = await setup(),
      analyzed = await runAnalysis(s);
    const analysis = analyzed.workspace.analysis!;
    const base = mapping(s.source, analysis.ref, analysis.report);
    const revision = await saveMapping(s, base);
    const task = await tasks.create(
      s.p,
      s.r,
      'MAP_SUGGEST',
      request(s.source, {
        sourceAnalysis: analysis.ref,
        expectedDraftRevision: revision,
        purpose: 'SMART_MATCH',
      }),
      [],
      'model',
    );
    const claim = await tasks.claim(s.p, task.id);
    const human = structuredClone(base);
    human.bindings[0]!.target!.text = '人工新映射';
    const humanRevision = await saveMapping(s, human, revision);
    const suggestion = structuredClone(base);
    suggestion.bindings[0]!.target!.text = 'AI建议';
    const result: CloneTaskResult = {
      operation: 'MAP_SUGGEST',
      purpose: 'SMART_MATCH',
      mapping: suggestion,
      notes: ['测试建议'],
    };
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    let view = await tasks.workspace(s.p, s.r);
    expect(view.tasks.find((item) => item.id === task.id)?.suggestionPending).toBe(true);
    expect(view.mappingDraft.state.bindings[0]!.target!.text).toBe('人工新映射');
    expect(view.mapping).toBeNull();
    await expect(tasks.adopt(s.p, s.r, task.id, revision)).rejects.toThrow('草稿');
    await tasks.adopt(s.p, s.r, task.id, humanRevision);
    view = await tasks.workspace(s.p, s.r);
    expect(view.mappingDraft.state.bindings[0]!.target!.text).toBe('AI建议');
    expect(view.mapping).toBeNull();
  }, 30_000);
  it('confirms complete mappings idempotently and invalidates only existing downstream after two source changes', async () => {
    const s = await setup(),
      analyzed = await runAnalysis(s);
    const analysis = analyzed.workspace.analysis!;
    const base = mapping(s.source, analysis.ref, analysis.report),
      revision = await saveMapping(s, base);
    await tasks.confirmMapping(s.p, s.r, {
      expectedDraftRevision: revision,
      expectedMappingRevision: 0,
    });
    await tasks.confirmMapping(s.p, s.r, {
      expectedDraftRevision: revision,
      expectedMappingRevision: 0,
    });
    expect((await tasks.workspace(s.p, s.r)).mapping?.ref.revision).toBe(1);
    for (let round = 1; round <= 2; round++) {
      const current = await inputRepo.workspace(s.p, s.r);
      const draft = {
        ...(current.draft!.state as ReturnType<typeof emptyCloneInputDraft>),
        productFacts: `第${round}轮有依据的包装事实`,
      };
      const saved = await working.saveNodeState(
        s.p,
        s.r,
        'CLONE_INPUT',
        workflowStateHash(draft),
        draft,
        current.draft!.revision,
        1,
      );
      await inputRepo.confirm(s.p, s.r, {
        expectedDraftRevision: saved.record.revision,
        expectedInputRevision: current.input!.revision,
      });
      const view = await tasks.workspace(s.p, s.r);
      expect(view.analysis?.freshness).toBe('STALE');
      expect(view.mapping?.freshness).toBe('STALE');
      expect(await db.workingArtifact.count({ where: { projectId: s.p } })).toBe(3);
    }
  }, 30_000);
  it('rejects fake audio semantics and incomplete product replacements before commit', async () => {
    const s = await setup(),
      task = await tasks.create(s.p, s.r, 'ANALYZE', request(s.source), [], 'model'),
      claim = await tasks.claim(s.p, task.id);
    const bad = report();
    bad.audio.bgm.status = 'OBSERVED';
    await expect(
      tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
        key: 'RESULT_V1',
        inputHash: claim.inputHash!,
        output: { operation: 'ANALYZE', report: bad },
      }),
    ).rejects.toThrow('音频');
    await tasks.cancel(s.p, s.r, task.id);
    const analyzed = await runAnalysis(s),
      analysis = analyzed.workspace.analysis!;
    const base = mapping(s.source, analysis.ref, analysis.report);
    base.bindings[0]!.target = null;
    const revision = await saveMapping(s, base);
    await expect(
      tasks.confirmMapping(s.p, s.r, {
        expectedDraftRevision: revision,
        expectedMappingRevision: 0,
      }),
    ).rejects.toThrow('替换目标');
  }, 30_000);
  it('binds KeepText evidence to exact mapping content and source references', async () => {
    const s = await setup(),
      value = report();
    value.elements.push({
      ...structuredClone(value.elements[0]!),
      elementId: 'subtitle_a',
      type: 'subtitle',
      label: '可核对字幕',
      transcriptText: '包装为绿色方块',
      sourceTrack: 'BURNED_IN',
    });
    value.shots[0]!.elementIds.push('subtitle_a');
    const analysis = (await runAnalysis(s, value)).workspace.analysis!;
    const base = mapping(s.source, analysis.ref, analysis.report);
    base.bindings[2]!.target!.contentStrategy = 'KEEP';
    base.bindings[2]!.target!.text = '包装为绿色方块';
    const revision = await saveMapping(s, base);
    await expect(
      tasks.confirmMapping(s.p, s.r, {
        expectedDraftRevision: revision,
        expectedMappingRevision: 0,
      }),
    ).rejects.toThrow('文本尚未');
    const task = await tasks.create(
      s.p,
      s.r,
      'MAP_SUGGEST',
      request(s.source, {
        sourceAnalysis: analysis.ref,
        expectedDraftRevision: revision,
        purpose: 'VALIDATE_KEEP_TEXT',
      }),
      [],
      'model',
    );
    const claim = await tasks.claim(s.p, task.id);
    const result: CloneTaskResult = {
      operation: 'MAP_SUGGEST',
      purpose: 'VALIDATE_KEEP_TEXT',
      checks: [
        {
          elementId: 'subtitle_a',
          passed: true,
          reason: '该文案与确认商品事实一致',
          evidence: ['确认资料：包装为绿色方块'],
        },
      ],
    };
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    expect((await tasks.workspace(s.p, s.r)).mappingDraft.revision).toBe(revision);
    await tasks.confirmMapping(s.p, s.r, {
      expectedDraftRevision: revision,
      expectedMappingRevision: 0,
    });
    const changed = structuredClone(base);
    changed.bindings[2]!.target!.text = '改成另一句文案';
    const changedRevision = await saveMapping(s, changed);
    await expect(
      tasks.confirmMapping(s.p, s.r, {
        expectedDraftRevision: changedRevision,
        expectedMappingRevision: 1,
      }),
    ).rejects.toThrow('文本尚未');
    expect((await tasks.workspace(s.p, s.r)).mapping?.ref.revision).toBe(1);
  }, 30_000);
  it('rejects manually modified media identity and missing task file holds', async () => {
    const s = await setup(),
      bad = report();
    bad.frameWidth = 720;
    await tasks.saveAnalysis(s.p, s.r, {
      expectedRevision: 0,
      state: { schemaVersion: 1, sourceInput: s.source, baseAnalysisRevision: 0, report: bad },
    });
    const view = await tasks.workspace(s.p, s.r);
    await expect(
      tasks.confirmAnalysis(s.p, s.r, {
        expectedDraftRevision: view.analysisDraft.revision,
        expectedAnalysisRevision: 0,
      }),
    ).rejects.toThrow('媒体规格');
    expect((await tasks.workspace(s.p, s.r)).analysis).toBeNull();
    const task = await tasks.create(
      s.p,
      s.r,
      'ANALYZE',
      request(s.source, { expectedDraftRevision: view.analysisDraft.revision }),
      [],
      'model',
    );
    await db.fissionCloneFileHold.deleteMany({ where: { projectId: s.p, taskId: task.id } });
    await expect(tasks.claim(s.p, task.id)).rejects.toThrow('文件引用');
  }, 30_000);
  it('requires a scoped prepared asset copy and rejects cross-project or replaced version identity', async () => {
    const s = await setup(),
      other = await setup();
    const metadata = {
      originalFileName: 'green.png',
      mimeType: 'image/png',
      sizeBytes: 20,
      storageKey: `g2-test-assets/${s.p}`,
    };
    const asset = await db.asset.create({
      data: {
        projectId: s.p,
        name: '绿色方块图',
        directory: 'VISUAL_ASSETS',
        type: 'PRODUCT_ASSET',
        storageWorkflow: 'FISSION',
        workflowSpace: 'FISSION_CLONE',
        ...metadata,
      },
    });
    const version = await db.assetVersion.create({
      data: {
        projectId: s.p,
        assetId: asset.id,
        version: 1,
        changeNote: '隔离测试',
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ...metadata,
      },
    });
    await expect(tasks.assetVersion(other.p, asset.id, 1)).rejects.toThrow('不可用');
    const analysis = (await runAnalysis(s)).workspace.analysis!;
    const base = mapping(s.source, analysis.ref, analysis.report);
    base.bindings[0]!.target!.asset = { assetId: asset.id, version: 1 };
    await expect(saveMapping(s, base)).rejects.toThrow('尚未准备');
    const file = {
      nodeId: 'CLONE_MAPPING',
      ...metadata,
      storageKey: `g2-test-scoped/${s.p}/${s.r}`,
      sha256: 'b'.repeat(64),
    };
    const draft = mapping(s.source, analysis.ref, analysis.report);
    const draftRevision = await saveMapping(s, draft);
    const candidate = {
      assetId: asset.id,
      version: 1,
      sourceVersionId: version.id,
      name: asset.name,
      type: asset.type,
      mimeType: version.mimeType,
      file: null,
    };
    const task = await tasks.create(
      s.p,
      s.r,
      'MAP_SUGGEST',
      request(s.source, {
        sourceAnalysis: analysis.ref,
        expectedDraftRevision: draftRevision,
        purpose: 'SMART_MATCH',
      }),
      [candidate],
      'model',
    );
    const claim = await tasks.claim(s.p, task.id);
    expect(claim.snapshot?.candidates).toEqual([candidate]);
    expect(await db.fissionCloneMappingFile.count({ where: { projectId: s.p } })).toBe(0);
    const result: CloneTaskResult = {
      operation: 'MAP_SUGGEST',
      purpose: 'SMART_MATCH',
      mapping: base,
      notes: ['仅按元数据匹配，未进行素材视觉核对'],
    };
    expect((await tasks.resultAssets(s.p, task.id, claim.attemptToken!, result)).assets).toEqual([
      candidate,
    ]);
    await expect(
      tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
        key: 'RESULT_V1',
        inputHash: claim.inputHash!,
        output: result,
      }),
    ).rejects.toThrow('尚未准备');
    await db.workflowRun.update({ where: { id: s.r }, data: { status: 'PAUSED' } });
    const prepared = await tasks.prepareAsset(
      s.p,
      s.r,
      asset.id,
      1,
      version.id,
      file,
      {
        durationMs: null,
        width: 16,
        height: 16,
        frameRate: null,
      },
      { taskId: task.id, token: claim.attemptToken! },
    );
    await tasks.checkpoint(s.p, task.id, claim.attemptToken!, {
      key: 'RESULT_V1',
      inputHash: claim.inputHash!,
      output: result,
    });
    expect(
      await db.fissionCloneFileHold.count({ where: { projectId: s.p, taskId: task.id } }),
    ).toBe(2);
    await tasks.complete(s.p, task.id, claim.attemptToken!, result);
    await inputRepo.initialize(s.p);
    expect(
      (
        await tasks.prepareAsset(s.p, s.r, asset.id, 1, version.id, file, {
          durationMs: null,
          width: 16,
          height: 16,
          frameRate: null,
        })
      ).id,
    ).toBe(prepared.id);
    const revision = await saveMapping(s, base);
    await tasks.confirmMapping(s.p, s.r, {
      expectedDraftRevision: revision,
      expectedMappingRevision: 0,
    });
    expect(
      await db.workingArtifactFile.count({
        where: { projectId: s.p, fileObjectId: prepared.fileObjectId },
      }),
    ).toBe(1);
    // Aged unreferenced staging versions are reclaimed, while confirmed references survive.
    await db.fissionCloneMappingFile.update({
      where: { id: prepared.id },
      data: { createdAt: new Date(0) },
    });
    const media = { durationMs: null, width: 16, height: 16, frameRate: null };
    const v2 = await db.assetVersion.create({
      data: {
        projectId: s.p,
        assetId: asset.id,
        version: 2,
        changeNote: 'unused',
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ...metadata,
      },
    });
    const unused = await tasks.prepareAsset(
      s.p,
      s.r,
      asset.id,
      2,
      v2.id,
      { ...file, storageKey: `${file.storageKey}/v2` },
      media,
    );
    await db.fissionCloneMappingFile.update({
      where: { id: unused.id },
      data: { createdAt: new Date(0) },
    });
    const v3 = await db.assetVersion.create({
      data: {
        projectId: s.p,
        assetId: asset.id,
        version: 3,
        changeNote: 'next',
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ...metadata,
      },
    });
    await tasks.prepareAsset(
      s.p,
      s.r,
      asset.id,
      3,
      v3.id,
      { ...file, storageKey: `${file.storageKey}/v3` },
      media,
    );
    expect(await tasks.preparedAsset(s.p, s.r, asset.id, 1)).not.toBeNull();
    expect(await tasks.preparedAsset(s.p, s.r, asset.id, 2)).toBeNull();
    expect(
      await db.storageCleanupTask.count({
        where: {
          projectId: s.p,
          storageKey: `${file.storageKey}/v2`,
          reason: 'CLONE_MAPPING_UNUSED',
        },
      }),
    ).toBe(1);
    await db.assetVersion.delete({ where: { id: version.id } });
    await db.assetVersion.create({
      data: {
        projectId: s.p,
        assetId: asset.id,
        version: 1,
        changeNote: '同编号另一身份',
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ...metadata,
      },
    });
    await expect(saveMapping(s, base)).rejects.toThrow('不可用');
  }, 30_000);

  async function setupGeneration(withScene = false) {
    const s = await setup();
    const source = report();
    if (withScene) {
      source.elements.push({
        ...source.elements[0]!,
        type: 'scene',
        elementId: 'set',
        label: '棚拍背景',
        description: '可变化的背景色调',
        shotIds: source.shots.map((shot) => shot.shotId),
        ranges: [{ startMs: 0, endMs: source.durationMs }],
      });
      for (const shot of source.shots) shot.elementIds.push('set');
    }
    const analysis = (await runAnalysis(s, source)).workspace.analysis!;
    const state = mapping(s.source, analysis.ref, analysis.report);
    const metadata = {
      originalFileName: 'g3-image.png',
      mimeType: 'image/png',
      sizeBytes: 4000,
      storageKey: `g3-preflight/${s.p}/original`,
    };
    const asset = await db.asset.create({
      data: {
        projectId: s.p,
        name: 'G3 预检商品图',
        directory: 'VISUAL_ASSETS',
        type: 'PRODUCT_ASSET',
        storageWorkflow: 'FISSION',
        workflowSpace: 'FISSION_CLONE',
        ...metadata,
      },
    });
    const version = await db.assetVersion.create({
      data: {
        projectId: s.p,
        assetId: asset.id,
        version: 1,
        changeNote: '预检测试',
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ...metadata,
      },
    });
    const prepared = await tasks.prepareAsset(
      s.p,
      s.r,
      asset.id,
      1,
      version.id,
      {
        ...metadata,
        nodeId: 'CLONE_MAPPING',
        storageKey: `g3-preflight/${s.r}/copy`,
        sha256: 'b'.repeat(64),
      },
      { width: 400, height: 400, durationMs: null, frameRate: null },
    );
    for (const binding of state.bindings)
      if (binding.type === 'product') binding.target!.asset = { assetId: asset.id, version: 1 };
    const revision = await saveMapping(s, state);
    await tasks.confirmMapping(s.p, s.r, {
      expectedDraftRevision: revision,
      expectedMappingRevision: 0,
    });
    const ref = (await tasks.workspace(s.p, s.r)).mapping!.ref;
    return { s, analysis, version, prepared, ref };
  }

  it('fences generation tasks and atomically publishes the checked video batch once', async () => {
    const { s, analysis, ref } = await setupGeneration();
    const models = { model: 'fake-render', reviewModel: 'fake-review' };
    const input = {
      sourceMapping: ref,
      count: 1,
      audioMode: 'SILENT',
      transitionMode: 'CUT',
      idempotencyKey: randomUUID(),
      acceptedRenderSeconds: 8,
    } as const;
    await expect(
      generation.create(s.p, s.r, { ...input, acceptedRenderSeconds: 7 }, models),
    ).rejects.toThrow('生成条件');
    const { taskId } = await generation.create(s.p, s.r, input, models);
    expect(await generation.create(s.p, s.r, input, models)).toEqual({ taskId });
    expect(
      await db.jobOutbox.count({
        where: { aggregateId: taskId, routingKey: 'fission.clone.generation.requested' },
      }),
    ).toBe(1);
    await expect(tasks.claim(s.p, taskId)).rejects.toThrow('不存在');
    expect((await tasks.workspace(s.p, s.r)).tasks.some((task) => task.id === taskId)).toBe(false);
    const first = await generation.claim(s.p, taskId);
    const token = first.attemptToken!;
    await expect(generation.complete(s.p, taskId, token)).rejects.toThrow('未通过');
    const file = {
      nodeId: 'CLONE_GENERATION',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      originalFileName: 'test.mp4',
      sha256: 'a'.repeat(64),
      storageKey: 'fixture',
    };
    await generation.saveRender(s.p, taskId, token, 0, { state: 'CREATE_PENDING' });
    await expect(
      generation.saveRender(s.p, taskId, token, 0, { state: 'CREATE_PENDING' }),
    ).rejects.toThrow('已登记');
    await generation.saveRender(s.p, taskId, token, 0, {
      state: 'CREATED',
      providerTaskId: 'fake-first-job',
    });
    await generation.saveFile(s.p, taskId, token, '0', {
      ...file,
      storageKey: `qa/${taskId}/shot1`,
    });
    await tasks.fail(s.p, taskId, token, true, true);
    await tasks.retry(s.p, s.r, taskId, true);
    const resumed = await generation.claim(s.p, taskId);
    expect(resumed.checkpoints['RENDER:0']).toEqual({
      state: 'CREATED',
      providerTaskId: 'fake-first-job',
    });
    expect(resumed.checkpoints['FILE:0']).toBeDefined();
    await expect(
      generation.saveRender(s.p, taskId, token, 1, { state: 'CREATE_PENDING' }),
    ).rejects.toThrow('租约');
    const next = resumed.attemptToken!;
    await generation.saveRender(s.p, taskId, next, 1, { state: 'CREATE_PENDING' });
    await generation.saveRender(s.p, taskId, next, 1, {
      state: 'CREATED',
      providerTaskId: 'fake-second-job',
    });
    await generation.saveFile(s.p, taskId, next, '1', {
      ...file,
      storageKey: `qa/${taskId}/shot2`,
    });
    const final = await generation.saveFile(s.p, taskId, next, 'final', {
      ...file,
      storageKey: `qa/${taskId}/final`,
    });
    const checks = resumed.snapshot!.plan.timeline.shots.map((shot) => ({
      shotId: shot.shotId,
      verdict: 'PASSED' as const,
      reason: '隔离测试证据',
      evidenceFrames: [shot.startFrame],
    }));
    await expect(
      generation.saveReview(s.p, taskId, next, {
        checks: [{ ...checks[0]!, evidenceFrames: [355] }, checks[1]!],
      }),
    ).rejects.toThrow('未抽样');
    await generation.saveReview(s.p, taskId, next, { checks });
    await db.workflowRun.update({ where: { id: s.r }, data: { status: 'PAUSED' } });
    await generation.complete(s.p, taskId, next);
    await generation.complete(s.p, taskId, next);
    expect(
      await db.workingArtifact.count({
        where: { projectId: s.p, nodeId: 'CLONE_GENERATION', revision: 1 },
      }),
    ).toBe(2);
    expect(
      await db.fileObject.count({
        where: { projectId: s.p, nodeId: 'CLONE_GENERATION', status: 'ORPHANED' },
      }),
    ).toBe(2);
    expect(
      (await db.fileObject.findUnique({ where: { id: final.file.fileObjectId } }))?.status,
    ).toBe('AVAILABLE');
    const committed = (await generation.list(s.p, s.r, 1, 6)).items[0]!.artifact!;
    expect(committed.freshness).toBe('CURRENT');
    expect(committed.archived).toBe(false);
    await inputRepo.initialize(s.p);
    await runAnalysis(s, {
      ...analysis.report,
      creativity: { ...analysis.report.creativity, concept: '新的报告' },
    });
    expect((await generation.list(s.p, s.r, 1, 6)).items[0]!.artifact!.freshness).toBe('STALE');
    const delivery = await generation.archiveSource(s.p, s.r, taskId, {
      artifactId: committed.artifactId,
      revision: committed.revision,
      contentHash: committed.contentHash,
    });
    expect(delivery.artifact.id).toBe(committed.artifactId);
    const operationKey = cloneArchiveOperationKey(delivery.artifact);
    await db.assetOperationReceipt.create({
      data: {
        projectId: s.p,
        operationKey,
        assetId: randomUUID(),
        assetVersionId: randomUUID(),
        version: 1,
      },
    });
    expect((await generation.list(s.p, s.r, 1, 6)).items[0]!.artifact).toMatchObject({
      freshness: 'STALE',
      archived: true,
    });
  }, 30_000);

  it.each([2, 20])(
    'recovers and publishes a %i-slot batch with exact manifest dependencies',
    async (count) => {
      const planning = count > 2;
      const { s, ref, analysis } = await setupGeneration(planning);
      const models = {
        model: 'fake-render',
        reviewModel: 'fake-review',
        token: 'fixture-placeholder',
        ...(planning && { planningModel: 'fixture-planning' }),
      };
      const input = {
        sourceMapping: ref,
        count,
        audioMode: 'SILENT',
        transitionMode: 'CUT',
        idempotencyKey: randomUUID(),
        acceptedRenderSeconds: count * 8,
      } as const;
      await expect(
        generation.create(s.p, s.r, { ...input, acceptedRenderSeconds: 8 }, models),
      ).rejects.toThrow('生成条件');
      const [created, duplicate] = await Promise.all([
        generation.create(s.p, s.r, input, models),
        generation.create(s.p, s.r, input, models),
      ]);
      expect(created).toEqual(duplicate);
      const batchId = created.batchId;
      if (!batchId) throw new Error('Expected a persisted batch');
      const snapshots = await db.fissionCloneTask.findMany({
        where: { projectId: s.p, operation: { in: ['GENERATE', 'GENERATE_BATCH'] } },
        select: { inputSnapshot: true },
      });
      expect(snapshots).toHaveLength(planning ? 1 : 3);
      for (const row of snapshots) expect(row.inputSnapshot).not.toHaveProperty('token');
      if (planning) {
        expect(await generation.list(s.p, s.r, 1, 6)).toMatchObject({
          items: [],
          active: true,
          batches: [{ id: batchId, planning: { count } }],
        });
        const firstPlan = await generation.claim(s.p, batchId);
        const variantIds = firstPlan.planning!.variantIds;
        expect(firstPlan.planning?.version).toBe(2);
        const shotIds = firstPlan.planning!.plan.shots.map(({ shotId }) => shotId);
        const draft = {
          version: 2 as const,
          variants: variantIds.map((variantId, index) => ({
            variantId,
            elementId: 'set',
            dimension: '背景色调',
            shotDirections: shotIds.map((shotId, shotIndex) => ({
              shotId,
              direction: `第 ${shotIndex + 1} 镜布景色调 ${index + 1}`,
            })),
          })),
        };
        await expect(
          generation.saveVariantDraft(s.p, batchId, firstPlan.attemptToken!, {
            ...draft,
            variants: [
              { ...draft.variants[0]!, dimension: '未授权修改' },
              ...draft.variants.slice(1),
            ],
          }),
        ).rejects.toThrow('变化维度');
        await expect(
          generation.saveVariantDraft(s.p, batchId, firstPlan.attemptToken!, {
            variants: draft.variants.map(({ shotDirections, ...item }) => ({
              ...item,
              direction: `${shotDirections[0]!.direction}，第 3 秒切成近景`,
            })),
          }),
        ).rejects.toThrow('契约版本');
        for (const shotDirections of [
          draft.variants[0]!.shotDirections.slice(0, 1),
          [draft.variants[0]!.shotDirections[0]!, draft.variants[0]!.shotDirections[0]!],
          [...draft.variants[0]!.shotDirections].reverse(),
        ]) {
          await expect(
            generation.saveVariantDraft(s.p, batchId, firstPlan.attemptToken!, {
              ...draft,
              variants: [{ ...draft.variants[0]!, shotDirections }, ...draft.variants.slice(1)],
            }),
          ).rejects.toThrow('覆盖所选场景的全部镜头');
        }
        await generation.saveVariantDraft(s.p, batchId, firstPlan.attemptToken!, draft);
        await tasks.fail(s.p, batchId, firstPlan.attemptToken!, true, 'all');
        await tasks.retry(s.p, s.r, batchId, 'all');
        const resumed = await generation.claim(s.p, batchId);
        expect(resumed.planning).toMatchObject({ variantIds, draft, review: null });
        await expect(
          generation.completePlanning(s.p, batchId, firstPlan.attemptToken!),
        ).rejects.toThrow('租约');
        const review = {
          checks: variantIds.map((variantId) => ({
            variantId,
            verdict: 'PASSED' as const,
            reason: '离线审查替身',
          })),
        };
        await generation.saveVariantReview(s.p, batchId, resumed.attemptToken!, review);
        expect((await generation.list(s.p, s.r, 1, 6)).items).toHaveLength(0);
        await tasks.fail(s.p, batchId, resumed.attemptToken!, true, 'all');
        await tasks.retry(s.p, s.r, batchId, 'all');
        const approved = await generation.claim(s.p, batchId);
        expect(approved.planning).toMatchObject({ variantIds, draft, review });
        await generation.completePlanning(s.p, batchId, approved.attemptToken!);
        await generation.completePlanning(s.p, batchId, approved.attemptToken!);
        expect(await generation.create(s.p, s.r, input, models)).toEqual(created);
      }
      const pending = await generation.list(s.p, s.r, 1, 1);
      expect(pending.items).toHaveLength(count);
      const [first, second, ...otherItems] = pending.items;
      const taskIds = pending.items.map((item) => item.id);
      expect(pending).toMatchObject({
        total: 1,
        pendingBatch: true,
        batches: [{ id: batchId, status: 'QUEUED', taskIds }],
      });
      const [a, b] = [first!.id, second!.id];
      const outbox = () =>
        db.jobOutbox.findMany({
          where: {
            projectId: s.p,
            routingKey: 'fission.clone.generation.requested',
            aggregateId: { in: taskIds },
          },
          orderBy: { aggregateId: 'asc' },
        });
      const originalJobs = await outbox();
      expect(originalJobs.map((job) => job.aggregateId)).toEqual([...taskIds].sort());
      await expect(generation.claim(randomUUID(), a)).rejects.toThrow('不存在');
      if (planning) expect((await generation.claim(s.p, batchId)).claimed).toBe(false);
      else await expect(generation.claim(s.p, batchId)).rejects.toThrow('不存在');

      async function saveShot(id: string, token: string, index: number) {
        await generation.saveRender(s.p, id, token, index, { state: 'CREATE_PENDING' });
        await generation.saveRender(s.p, id, token, index, {
          state: 'CREATED',
          providerTaskId: `fixture-${id}-${index}`,
        });
        return saveFile(id, token, String(index));
      }
      function saveFile(id: string, token: string, slot: string) {
        return generation.saveFile(s.p, id, token, slot, {
          nodeId: 'CLONE_GENERATION',
          mimeType: 'video/mp4',
          sizeBytes: 100,
          originalFileName: 'test.mp4',
          sha256: 'a'.repeat(64),
          storageKey: `qa/${id}/${slot}`,
        });
      }
      async function finish(id: string, claim: Awaited<ReturnType<typeof generation.claim>>) {
        const token = claim.attemptToken!;
        for (const index of [0, 1])
          if (!claim.checkpoints[`FILE:${index}`]) await saveShot(id, token, index);
        await saveFile(id, token, 'final');
        await generation.saveReview(s.p, id, token, {
          checks: claim.snapshot!.plan.timeline.shots.map((shot) => ({
            shotId: shot.shotId,
            verdict: 'PASSED',
            reason: '隔离测试',
            evidenceFrames: [shot.startFrame],
          })),
        });
        await generation.complete(s.p, id, token);
      }
      const firstClaim = await generation.claim(s.p, a);
      if (planning)
        expect(
          firstClaim.snapshot?.plan.shots.map(
            (shot) => shot.targets.find((target) => target.elementId === 'set')?.variation,
          ),
        ).toEqual([
          { dimension: '背景色调', direction: '第 1 镜布景色调 1', scope: 'SHOT' },
          { dimension: '背景色调', direction: '第 2 镜布景色调 1', scope: 'SHOT' },
        ]);
      await finish(a, firstClaim);
      for (const item of otherItems) await finish(item.id, await generation.claim(s.p, item.id));
      const secondClaim = await generation.claim(s.p, b);
      await saveShot(b, secondClaim.attemptToken!, 0);
      await tasks.fail(s.p, b, secondClaim.attemptToken!, true, true);
      const partial = await generation.list(s.p, s.r, 1, 1);
      expect(partial.batches[0]?.downloadUrl).toBeUndefined();
      await expect(generation.batchExport(s.p, s.r, batchId, 1, 'a'.repeat(64))).rejects.toThrow(
        '尚无可下载交付',
      );
      expect(partial).toMatchObject({
        pendingBatch: true,
        active: false,
        batches: [{ status: 'PARTIAL', canCancel: true }],
        items: [
          { status: 'SUCCEEDED', artifact: null },
          { status: 'FAILED', canRetry: true, artifact: null },
          ...otherItems.map(() => ({ status: 'SUCCEEDED', artifact: null })),
        ],
      });
      const published = () =>
        db.workingArtifact.findMany({
          where: { projectId: s.p, workflowRunId: s.r, nodeId: 'CLONE_GENERATION' },
        });
      expect(await published()).toEqual([]);
      await expect(
        generation.create(s.p, s.r, { ...input, idempotencyKey: randomUUID() }, models),
      ).rejects.toThrow('未完成');
      await db.jobOutbox.updateMany({
        where: { aggregateId: { in: taskIds } },
        data: { status: 'PUBLISHED', publishedAt: new Date(), attempts: 1 },
      });
      await tasks.retry(s.p, s.r, b, true);
      expect((await outbox()).map((job) => [job.aggregateId, job.status])).toEqual(
        originalJobs.map((job) => [
          job.aggregateId,
          job.aggregateId === b ? 'PENDING' : 'PUBLISHED',
        ]),
      );
      const resume = await generation.claim(s.p, b);
      expect(resume.checkpoints['FILE:0']).toBeDefined();
      expect(resume.checkpoints['RENDER:0']).toMatchObject({ providerTaskId: `fixture-${b}-0` });
      await expect(generation.complete(s.p, b, secondClaim.attemptToken!)).rejects.toThrow('租约');
      await finish(b, resume);
      await generation.complete(s.p, b, resume.attemptToken!);
      const output = await published();
      expect(output).toHaveLength(count + 1);
      expect(output.every((artifact) => artifact.revision === 1)).toBe(true);
      const complete = await generation.list(s.p, s.r, 1, 1);
      expect(complete).toMatchObject({
        active: false,
        pendingBatch: false,
        batches: [{ status: 'SUCCEEDED', canCancel: false }],
      });
      const videos = complete.items.map((item) => item.artifact!.artifactId);
      const manifest = output.find(
        (artifact) => artifact.artifactKey === `clone-batch:${batchId}`,
      )!;
      expect(manifest.payload).toMatchObject({
        count,
        videos: videos.map((artifactId) => ({ artifactId, revision: 1 })),
      });
      expect(complete.batches[0]?.downloadUrl).toContain(
        `/batches/${batchId}/export?revision=1&hash=${manifest.contentHash}`,
      );
      const exportBatch = () =>
        generation.batchExport(s.p, s.r, batchId, manifest.revision, manifest.contentHash);
      expect((await exportBatch()).entries.map((entry) => entry.artifactId)).toEqual(videos);
      await expect(
        generation.batchExport(s.p, s.r, batchId, 2, manifest.contentHash),
      ).rejects.toThrow('批次版本已更新');
      await expect(generation.batchExport(s.p, s.r, batchId, 1, 'f'.repeat(64))).rejects.toThrow(
        '批次版本已更新',
      );
      await expect(tasks.cancel(s.p, s.r, a, true)).rejects.toThrow('未交付');
      const updated = await runAnalysis(s, {
        ...analysis.report,
        creativity: { ...analysis.report.creativity, concept: '第二版' },
      });
      expect((await published()).every((artifact) => artifact.freshness === 'STALE')).toBe(true);
      expect((await exportBatch()).entries.every((entry) => entry.freshness === 'STALE')).toBe(
        true,
      );
      if (planning) {
        async function confirmMappingFor(current: typeof updated) {
          const previous = current.workspace.mapping!;
          const expectedDraftRevision = await saveMapping(s, {
            ...previous.mapping,
            sourceAnalysis: current.workspace.analysis!.ref,
          });
          await tasks.confirmMapping(s.p, s.r, {
            expectedDraftRevision,
            expectedMappingRevision: previous.ref.revision,
          });
          return (await tasks.workspace(s.p, s.r)).mapping!.ref;
        }
        const secondMapping = await confirmMappingFor(updated);
        const second = await generation.create(
          s.p,
          s.r,
          { ...input, sourceMapping: secondMapping, idempotencyKey: randomUUID() },
          models,
        );
        if (!second.batchId) throw new Error('Expected a second batch');
        const secondClaim = await generation.claim(s.p, second.batchId);
        expect(secondClaim.planning?.plan.sources.mapping).toEqual(secondMapping);
        await tasks.cancel(s.p, s.r, second.batchId, 'all');
        const third = await runAnalysis(s, {
          ...analysis.report,
          creativity: { ...analysis.report.creativity, concept: '第三版' },
        });
        const thirdMapping = await confirmMappingFor(third);
        expect(thirdMapping.revision).toBe(secondMapping.revision + 1);
        const latest = await generation.create(
          s.p,
          s.r,
          { ...input, sourceMapping: thirdMapping, idempotencyKey: randomUUID() },
          models,
        );
        if (!latest.batchId) throw new Error('Expected a third batch');
        const latestClaim = await generation.claim(s.p, latest.batchId);
        expect(latestClaim.planning?.plan.sources.mapping).toEqual(thirdMapping);
        expect(latestClaim.planning?.variantIds).toHaveLength(count);
        expect(
          latestClaim.planning?.variantIds.some((id) =>
            secondClaim.planning?.variantIds.includes(id),
          ),
        ).toBe(false);
        expect((await exportBatch()).entries.map((entry) => entry.artifactId)).toEqual(videos);
      }
    },
    120_000,
  );

  it('blocks dispatch for unapproved plans and fences cancelled planning attempts', async () => {
    const { s, ref } = await setupGeneration(true);
    const models = { model: 'fake-render', reviewModel: 'fake-review' };
    const input = {
      sourceMapping: ref,
      count: 3,
      audioMode: 'SILENT',
      transitionMode: 'CUT',
      idempotencyKey: randomUUID(),
      acceptedRenderSeconds: 24,
    } as const;
    await expect(generation.create(s.p, s.r, input, models)).rejects.toThrow('差异化规划尚未启用');
    const { taskId } = await generation.create(s.p, s.r, input, {
      ...models,
      planningModel: 'fake-plan',
    });
    const claim = await generation.claim(s.p, taskId);
    const token = claim.attemptToken!;
    const variantIds = claim.planning!.variantIds;
    const draft = {
      version: 2 as const,
      variants: variantIds.map((variantId, index) => ({
        variantId,
        elementId: 'set',
        dimension: '背景色调',
        shotDirections: claim.planning!.plan.shots.map(({ shotId }) => ({
          shotId,
          direction: `色调 ${index}`,
        })),
      })),
    };
    await generation.saveVariantDraft(s.p, taskId, token, draft);
    const rejected = {
      checks: variantIds.map((variantId) => ({
        variantId,
        verdict: 'FAILED' as const,
        reason: '差异不足',
      })),
    };
    await expect(generation.saveVariantReview(s.p, taskId, token, rejected)).rejects.toThrow(
      '未通过',
    );
    await expect(generation.completePlanning(s.p, taskId, token)).rejects.toThrow('缺少已审查');
    await tasks.cancel(s.p, s.r, taskId, 'all');
    await expect(generation.completePlanning(s.p, taskId, token)).rejects.toThrow('租约');
    expect(await generation.list(s.p, s.r, 1, 6)).toMatchObject({
      active: false,
      items: [],
      batches: [{ id: taskId, status: 'CANCELLED', canCancel: false }],
    });
    expect(await db.fissionCloneTask.count({ where: { generationParentId: taskId } })).toBe(0);
    expect(
      await db.jobOutbox.count({ where: { projectId: s.p, jobType: 'FISSION_CLONE_GENERATION' } }),
    ).toBe(1);
  }, 30_000);

  it('resumes a historical batch with its original planning checkpoint format', async () => {
    const { s, ref } = await setupGeneration(true);
    const { taskId } = await generation.create(
      s.p,
      s.r,
      {
        sourceMapping: ref,
        count: 3,
        audioMode: 'SILENT',
        transitionMode: 'CUT',
        idempotencyKey: randomUUID(),
        acceptedRenderSeconds: 24,
      },
      { model: 'fake-render', reviewModel: 'fake-review', planningModel: 'fake-plan' },
    );
    const task = await db.fissionCloneTask.findUniqueOrThrow({ where: { id: taskId } });
    const { planningVersion, ...legacy } = task.inputSnapshot as Prisma.InputJsonObject;
    expect(planningVersion).toBe(2);
    await db.fissionCloneTask.update({
      where: { id: taskId },
      data: { inputSnapshot: legacy, inputHash: workflowStateHash(legacy) },
    });
    const claim = await generation.claim(s.p, taskId);
    const token = claim.attemptToken!;
    expect(claim.planning?.version).toBeUndefined();
    await generation.saveVariantDraft(s.p, taskId, token, {
      variants: claim.planning!.variantIds.map((variantId, index) => ({
        variantId,
        elementId: 'set',
        dimension: '背景色调',
        direction: `历史布景 ${index + 1}`,
      })),
    });
    await generation.saveVariantReview(s.p, taskId, token, {
      checks: claim.planning!.variantIds.map((variantId) => ({
        variantId,
        verdict: 'PASSED',
        reason: '隔离历史检查点',
      })),
    });
    await generation.completePlanning(s.p, taskId, token);
    const list = await generation.list(s.p, s.r, 1, 1);
    const child = await generation.claim(s.p, list.items[0]!.id);
    expect(
      child.snapshot?.plan.shots.map(
        (shot) => shot.targets.find((target) => target.elementId === 'set')?.variation,
      ),
    ).toEqual([
      { dimension: '背景色调', direction: '历史布景 1' },
      { dimension: '背景色调', direction: '历史布景 1' },
    ]);
  }, 30_000);

  it('cancels both pending batch tasks and blocks their old attempts', async () => {
    const { s, ref } = await setupGeneration();
    const models = { model: 'fake-render', reviewModel: 'fake-review' };
    const input = {
      sourceMapping: ref,
      count: 2,
      audioMode: 'SILENT',
      transitionMode: 'CUT',
      idempotencyKey: randomUUID(),
      acceptedRenderSeconds: 16,
    } as const;
    const { taskId } = await generation.create(s.p, s.r, input, models);
    const claim = await generation.claim(s.p, taskId);
    await tasks.cancel(s.p, s.r, taskId, true);
    await tasks.cancel(s.p, s.r, taskId, true);
    await expect(generation.complete(s.p, taskId, claim.attemptToken!)).rejects.toThrow('租约');
    expect(await generation.list(s.p, s.r, 1, 6)).toMatchObject({
      pendingBatch: false,
      active: false,
      batches: [{ status: 'CANCELLED' }],
      items: [
        { status: 'CANCELLED', artifact: null },
        { status: 'CANCELLED', artifact: null },
      ],
    });
    expect(await db.fissionCloneFileHold.count({ where: { projectId: s.p } })).toBe(0);
    await expect(
      generation.create(s.p, s.r, { ...input, idempotencyKey: randomUUID() }, models),
    ).resolves.toMatchObject({ batchId: expect.any(String) });
  }, 30_000);

  it('does not requeue or start another generation when provider creation is unresolved', async () => {
    const { s, ref } = await setupGeneration();
    const models = { model: 'fake-render', reviewModel: 'fake-review' };
    const input = {
      sourceMapping: ref,
      count: 1,
      audioMode: 'SILENT',
      transitionMode: 'CUT',
      idempotencyKey: randomUUID(),
      acceptedRenderSeconds: 8,
    } as const;
    const { taskId } = await generation.create(s.p, s.r, input, models);
    const current = await generation.claim(s.p, taskId);
    await generation.saveRender(s.p, taskId, current.attemptToken!, 0, { state: 'CREATE_PENDING' });
    await db.fissionCloneTask.update({
      where: { id: taskId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await tasks.recoverExpired();
    const item = (await generation.list(s.p, s.r, 1, 6)).items[0]!;
    expect(item).toMatchObject({ status: 'FAILED', canRetry: false, artifact: null });
    expect(item.error).toContain('结果未知');
    await expect(
      generation.create(s.p, s.r, { ...input, idempotencyKey: randomUUID() }, models),
    ).rejects.toThrow('待核查');
    expect(await db.fissionCloneFileHold.count({ where: { projectId: s.p, taskId } })).toBe(0);
  }, 30_000);

  it('preflights only current confirmed mapping files and leaves tasks, drafts and outbox unchanged', async () => {
    const { s, analysis, version, prepared, ref } = await setupGeneration();
    const other = await setup();
    const where = { projectId: s.p };
    const counts = () =>
      Promise.all([
        db.fissionCloneTask.count({ where }),
        db.jobOutbox.count({ where }),
        db.workflowNodeState.count({ where }),
        db.workingArtifact.count({ where }),
        db.fileObject.count({ where }),
      ]);
    const before = await counts();
    const plan = await tasks.generationPlan(s.p, s.r, ref);
    expect(plan).toMatchObject({
      projectId: s.p,
      workflowRunId: s.r,
      sources: { input: s.source, analysis: analysis.ref, mapping: ref },
      timeline: { frameCount: 72 },
      ratio: '9:16',
      images: [{ fileObjectId: prepared.fileObjectId, version: 1, sourceVersionId: version.id }],
      shots: [{ renderSeconds: 4 }, { renderSeconds: 4 }],
    });
    await expect(
      tasks.generationPlan(s.p, s.r, { ...ref, contentHash: '0'.repeat(64) }),
    ).rejects.toThrow('已变化');
    await expect(tasks.generationPlan(other.p, other.r, ref)).rejects.toThrow('已变化');
    await expect(tasks.generationPlan(other.p, s.r, ref)).rejects.toThrow('不属于');
    expect(await counts()).toEqual(before);
    await runAnalysis(s, {
      ...analysis.report,
      creativity: { ...analysis.report.creativity, concept: '新报告' },
    });
    await expect(tasks.generationPlan(s.p, s.r, ref)).rejects.toThrow('已变化');
  }, 30_000);
});
