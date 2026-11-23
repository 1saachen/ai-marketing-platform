import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { emptyLocalReplaceDraft, type LocalReplaceSourceProbe } from '@ai-marketing/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../../database/prisma.service';
import { ProjectDeletionRepository } from '../../../platform/project/project-deletion.repository';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { LocalReplaceRepository } from './local-replace.repository';

const enabled = process.env.FISSION_LOCAL_REPLACE_DATABASE_TEST === '1';
const probe: LocalReplaceSourceProbe = { frameCount: 120, ratio: '9:16', hasAudio: true };
const output = {
  nodeId: 'LOCAL_REPLACE_OUTPUT',
  originalFileName: 'test-only.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 2000,
  sha256: 'a'.repeat(64),
};

describe.skipIf(!enabled)('local replace isolated database', () => {
  let db: PrismaService;
  let repository: LocalReplaceRepository;
  let working: WorkflowWorkingRepository;
  let deletion: ProjectDeletionRepository;
  let projects: string[];

  beforeEach(() => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/missing');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.startsWith('/local_replace_')
    )
      throw new Error('Local replace tests require an isolated local_replace_ database');
    const config = new ConfigService({
      DATABASE_URL: url.toString(),
      FISSION_LOCAL_REPLACE_ENABLED: true,
    });
    db = new PrismaService(config);
    working = new WorkflowWorkingRepository(db, config);
    repository = new LocalReplaceRepository(db, working);
    deletion = new ProjectDeletionRepository(db, config);
    projects = [];
  });

  afterEach(async () => {
    const where = { projectId: { in: projects } };
    try {
      await db.workingArtifactDependency.deleteMany({ where });
      await db.workingArtifactFile.deleteMany({ where });
      await db.assetVersion.deleteMany({ where });
      await db.asset.deleteMany({ where });
      await db.project.deleteMany({ where: { id: { in: projects } } });
    } finally {
      await db.$disconnect();
    }
  }, 30_000);

  async function media(projectId: string, mimeType: 'video/mp4' | 'image/png') {
    const video = mimeType === 'video/mp4';
    const data = {
      projectId,
      status: 'AVAILABLE' as const,
      qualityStatus: 'AVAILABLE' as const,
      originalFileName: video ? 'fixture.mp4' : 'fixture.png',
      mimeType,
      storageKey: `local-replace-fixtures/${randomUUID()}`,
      sizeBytes: 4096,
    };
    const asset = await db.asset.create({
      data: {
        ...data,
        name: data.originalFileName,
        storageWorkflow: 'FISSION',
        workflowSpace: 'FISSION_CLONE',
        directory: video ? 'VIDEO_MATERIALS' : 'VISUAL_ASSETS',
        type: video ? 'VIDEO_MATERIAL' : 'PRODUCT_ASSET',
        hasFile: true,
      },
    });
    const version = await db.assetVersion.create({
      data: { ...data, assetId: asset.id, version: 1, changeNote: '测试资产' },
    });
    return { ref: { assetId: asset.id, version: version.version }, versionId: version.id };
  }

  async function setup() {
    const project = await db.project.create({ data: { name: '局部替换隔离测试' } });
    projects.push(project.id);
    const { runId } = await repository.initialize(project.id);
    const scope = [project.id, runId] as const;
    const source = await media(project.id, 'video/mp4');
    const target = await media(project.id, 'image/png');
    const draft = {
      ...emptyLocalReplaceDraft(),
      nodeId: 'LOCAL_REPLACE_OUTPUT' as const,
      source: source.ref,
      target: target.ref,
      startMs: 1000,
      endMs: 4000,
      objectDescription: '手里的粉色小瓶',
      sourceRightsConfirmed: true,
    };
    return { projectId: project.id, runId, scope, source, target, draft };
  }

  async function enqueue(s: Awaited<ReturnType<typeof setup>>) {
    const initial = await repository.workspace(...s.scope);
    const saved = await repository.saveDraft(...s.scope, {
      draft: s.draft,
      expectedRevision: initial.draftRevision,
    });
    const request = { idempotencyKey: randomUUID(), expectedRevision: saved.draftRevision };
    const response = await repository.create(...s.scope, request, 'test-model');
    return { id: response.tasks[0]!.id, request };
  }

  async function claim(s: Awaited<ReturnType<typeof setup>>, taskId: string) {
    const result = await repository.claim(...s.scope, taskId);
    if (result.status !== 'CLAIMED') throw new Error(`Unexpected claim ${result.status}`);
    return result;
  }

  it('isolates the scope and enforces draft compare-and-swap through pause and reopen', async () => {
    const s = await setup();
    const other = await setup();
    const initial = await repository.workspace(...s.scope);
    expect((await repository.initialize(s.projectId)).runId).toBe(s.runId);
    await expect(repository.workspace(s.projectId, other.runId)).rejects.toThrow('工作流不存在');
    await expect(
      repository.saveDraft(...s.scope, {
        draft: { ...s.draft, source: other.source.ref },
        expectedRevision: initial.draftRevision,
      }),
    ).rejects.toThrow('不属于当前项目');
    const saved = await repository.saveDraft(...s.scope, {
      draft: s.draft,
      expectedRevision: initial.draftRevision,
    });
    await expect(
      repository.saveDraft(...s.scope, {
        draft: s.draft,
        expectedRevision: initial.draftRevision,
      }),
    ).rejects.toThrow('草稿已更新');
    await expect(working.activateNode(...s.scope, 'LOCAL_REPLACE_BINDING')).rejects.toThrow(
      '工作台',
    );
    await expect(
      working.pauseRun(...s.scope, {
        expectedLocalReplaceDraftRevision: initial.draftRevision,
      }),
    ).rejects.toThrow('草稿已变化');
    await working.pauseRun(...s.scope, { expectedLocalReplaceDraftRevision: saved.draftRevision });
    const reopened = await repository.initialize(s.projectId);
    expect(reopened).toMatchObject({
      runId: s.runId,
      draftRevision: saved.draftRevision + 1,
      draft: s.draft,
    });
    expect(await db.workingArtifact.count({ where: { projectId: s.projectId } })).toBe(0);
  }, 30_000);

  it('accepts this workspace’s pending imports without changing their review status', async () => {
    const s = await setup();
    const initial = await repository.workspace(...s.scope);
    const draftRequest = { draft: s.draft, expectedRevision: initial.draftRevision };
    const pending = { status: 'PENDING_REVIEW', qualityStatus: 'PENDING_REVIEW' } as const;
    for (const media of [s.source, s.target]) {
      await db.asset.update({ where: { id: media.ref.assetId }, data: pending });
      await db.assetVersion.update({ where: { id: media.versionId }, data: pending });
    }
    await expect(repository.saveDraft(...s.scope, draftRequest)).rejects.toThrow('素材版本不可用');
    for (const media of [s.source, s.target])
      await db.asset.update({
        where: { id: media.ref.assetId },
        data: { workflowSpace: 'FISSION_LOCAL_REPLACE' },
      });
    const saved = await repository.saveDraft(...s.scope, draftRequest);
    const result = await repository.create(
      ...s.scope,
      { expectedRevision: saved.draftRevision, idempotencyKey: randomUUID() },
      'test-model',
    );
    const id = result.tasks[0]!.id;
    const { attemptToken } = await claim(s, id);
    expect(await repository.reserve(...s.scope, id, attemptToken, probe)).toEqual({
      state: 'RESERVED',
    });
    const imported = await db.assetVersion.findUniqueOrThrow({ where: { id: s.source.versionId } });
    expect(imported.status).toBe('PENDING_REVIEW');
    await db.asset.update({
      where: { id: s.source.ref.assetId },
      data: { archivedAt: new Date() },
    });
    await expect(repository.workerFile(...s.scope, id, attemptToken, 'source')).rejects.toThrow(
      '冻结素材版本不可用',
    );
  }, 30_000);

  it('binds an idempotent task and resuming provider ID to an exact scoped plan and file', async () => {
    const s = await setup();
    const { id, request } = await enqueue(s);
    const replay = await repository.create(...s.scope, request, 'test-model');
    expect(replay.tasks.map((task) => task.id)).toEqual([id]);
    const job = await db.jobOutbox.findFirstOrThrow({ where: { projectId: s.projectId } });
    expect(job.routingKey).toBe('fission.local_replace.requested');
    expect(job.payload).toEqual({
      schemaVersion: 1,
      projectId: s.projectId,
      runId: s.runId,
      requestId: id,
    });
    await expect(
      repository.create(...s.scope, { ...request, expectedRevision: 0 }, 'test-model'),
    ).rejects.toThrow('同一请求标识');
    await expect(deletion.enqueue(s.projectId)).rejects.toThrow('生成或上传任务');
    const initial = await claim(s, id);
    expect(
      (await repository.workerFile(...s.scope, id, initial.attemptToken, 'source')).versionId,
    ).toBe(s.source.versionId);
    expect(await repository.claim(...s.scope, id)).toEqual({ status: 'BUSY' });
    expect(await repository.reserve(...s.scope, id, initial.attemptToken, probe)).toEqual({
      state: 'RESERVED',
    });
    expect(await repository.reserve(...s.scope, id, initial.attemptToken, probe)).toEqual({
      state: 'UNKNOWN',
    });
    await repository.bindProvider(...s.scope, id, initial.attemptToken, 'provider-job-1');
    await repository.bindProvider(...s.scope, id, initial.attemptToken, 'provider-job-1');
    await expect(
      repository.bindProvider(...s.scope, id, initial.attemptToken, 'other-job'),
    ).rejects.toThrow('另一供应商任务');
    await db.fissionLocalReplaceTask.update({
      where: { id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const resumed = await claim(s, id);
    expect(resumed.providerTaskId).toBe('provider-job-1');
    expect(resumed.attemptToken).not.toBe(initial.attemptToken);
    await expect(repository.heartbeat(...s.scope, id, initial.attemptToken)).rejects.toThrow(
      '租约',
    );
    expect(
      (await repository.resultAdmission(...s.scope, id, resumed.attemptToken)).sourceProbe,
    ).toEqual(probe);
    const stored = { ...output, storageKey: `verified-local-replace/${id}` };
    expect(await repository.complete(...s.scope, id, resumed.attemptToken, stored)).toBe(true);
    expect(await repository.complete(...s.scope, id, resumed.attemptToken, stored)).toBe(false);
    const file = await repository.output(...s.scope, id);
    expect(file).toMatchObject({
      workflowRunId: s.runId,
      sha256: stored.sha256,
      status: 'AVAILABLE',
    });
    const dependency = await db.workingArtifactDependency.findFirstOrThrow({
      where: { projectId: s.projectId },
    });
    expect(dependency).toMatchObject({ sourceKey: 'local-replace-plan', sourceRevision: 1 });
    const moved = await repository.saveDraft(...s.scope, {
      draft: { ...s.draft, nodeId: 'LOCAL_REPLACE_PROMPT' },
      expectedRevision: request.expectedRevision,
    });
    const next = await repository.create(
      ...s.scope,
      {
        idempotencyKey: randomUUID(),
        expectedRevision: moved.draftRevision,
      },
      'test-model',
    );
    expect(next.tasks.find((task) => task.id === id)?.stale).toBe(false);
    expect(
      (
        await db.workingArtifact.findFirstOrThrow({
          where: { projectId: s.projectId, artifactKey: 'local-replace-plan' },
        })
      ).revision,
    ).toBe(1);
    await repository.action(...s.scope, next.tasks[0]!.id, 'cancel');
    const changed = await repository.saveDraft(...s.scope, {
      draft: { ...s.draft, startMs: 2000 },
      expectedRevision: moved.draftRevision,
    });
    const latest = await repository.create(
      ...s.scope,
      {
        idempotencyKey: randomUUID(),
        expectedRevision: changed.draftRevision,
      },
      'test-model',
    );
    expect(latest.tasks.find((task) => task.id === id)).toMatchObject({
      stale: true,
      source: s.source.ref,
      startMs: 1000,
    });
    expect((await repository.output(...s.scope, id)).id).toBe(file.id);
  }, 30_000);

  it('allows a confirmed rejection retry and quarantines an expired unknown creation', async () => {
    const s = await setup();
    const { id, request } = await enqueue(s);
    const first = await claim(s, id);
    await repository.reserve(...s.scope, id, first.attemptToken, probe);
    const failed = await repository.fail(
      ...s.scope,
      id,
      first.attemptToken,
      true,
      'PROVIDER_REJECTED',
    );
    expect(failed.accepted).toBe(true);
    expect((await repository.workspace(...s.scope)).tasks[0]!.canRetry).toBe(true);
    await repository.action(...s.scope, id, 'retry');
    const second = await claim(s, id);
    expect(second.providerTaskId).toBeNull();
    await repository.reserve(...s.scope, id, second.attemptToken, probe);
    await expect(repository.action(...s.scope, id, 'cancel')).rejects.toThrow('供应商正在确认');
    await db.fissionLocalReplaceTask.update({
      where: { id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await repository.recoverExpired();
    expect(await repository.claim(...s.scope, id)).toEqual({ status: 'INACTIVE' });
    await expect(repository.action(...s.scope, id, 'retry')).rejects.toThrow('无法重试');
    await expect(
      repository.create(...s.scope, { ...request, idempotencyKey: randomUUID() }, 'test-model'),
    ).rejects.toThrow('结果待核查');
    await expect(deletion.enqueue(s.projectId)).rejects.toThrow('生成或上传任务');
  }, 30_000);
});
