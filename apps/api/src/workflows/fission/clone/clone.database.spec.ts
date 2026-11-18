import { createHash, randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import {
  emptyCloneInputDraft,
  type CloneInputDraft,
  type CloneUpload,
  type CloneUploadRole,
} from '@ai-marketing/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../../database/prisma.service';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { CloneRepository } from './clone.repository';

const enabled = process.env.FISSION_CLONE_DATABASE_TEST === '1';

describe.skipIf(!enabled)('clone G1 database transaction boundaries', () => {
  let db: PrismaService;
  let working: WorkflowWorkingRepository;
  let repository: CloneRepository;
  let projectIds: string[];

  beforeEach(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (
      !databaseUrl ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
    ) {
      throw new Error(
        'FISSION_CLONE_DATABASE_TEST requires an explicitly configured local test database',
      );
    }
    const config = new ConfigService({ DATABASE_URL: databaseUrl, FISSION_CLONE_ENABLED: true });
    db = new PrismaService(config);
    working = new WorkflowWorkingRepository(db, config);
    repository = new CloneRepository(db, working);
    projectIds = [];
  }, 30_000);

  afterEach(async () => {
    if (!db) return;
    try {
      if (projectIds.length) {
        // Every deletion is limited to random projects created by this test.
        const where = { projectId: { in: projectIds } };
        await db.workingArtifactDependency.deleteMany({ where });
        await db.workingArtifactRevisionSnapshot.deleteMany({ where });
        await db.workingArtifactFile.deleteMany({ where });
        await db.fissionCloneUpload.deleteMany({ where });
        await db.project.deleteMany({ where: { id: { in: projectIds } } });
      }
    } finally {
      await db.$disconnect();
    }
  }, 30_000);

  async function project() {
    const id = randomUUID();
    await db.project.create({ data: { id, name: '复刻输入数据库隔离验证' } });
    projectIds.push(id);
    return id;
  }

  async function scope() {
    const projectId = await project();
    return { projectId, runId: await repository.initialize(projectId) };
  }

  const media: CloneUpload['media'] = {
    durationMs: 10_000,
    width: 1080,
    height: 1920,
    frameRate: 30,
  };

  function fileIdentity(projectId: string): FileObjectInput {
    const identity = randomUUID();
    // Repository-only identity fixture: no bytes, storage call, probe or media-validation claim.
    return {
      nodeId: 'CLONE_INPUT',
      originalFileName: 'repository-identity-only.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      storageKey: `clone-database-fixture/${projectId}/${identity}`,
      sha256: createHash('sha256').update(identity).digest('hex'),
    };
  }

  async function upload(projectId: string, runId: string, role: CloneUploadRole = 'REFERENCE') {
    const attempt = await repository.beginUpload(projectId, runId, randomUUID());
    return repository.finishUpload(
      projectId,
      runId,
      attempt.id,
      attempt.attemptToken,
      role,
      fileIdentity(projectId),
      media,
    );
  }

  async function save(projectId: string, runId: string, state: CloneInputDraft, revision?: number) {
    const expected = revision ?? (await repository.workspace(projectId, runId)).draft!.revision;
    return working.saveNodeState(
      projectId,
      runId,
      'CLONE_INPUT',
      workflowStateHash(state),
      state,
      expected,
      1,
    );
  }

  async function prepareInput(projectId: string, runId: string) {
    const reference = await upload(projectId, runId);
    const product = await upload(projectId, runId, 'PRODUCT');
    const state: CloneInputDraft = {
      ...emptyCloneInputDraft(),
      referenceUploadId: reference.id,
      productUploadIds: [product.id],
      productName: '示例大米',
      productFacts: '资料确认包装规格为 500g。',
      sourceRightsConfirmed: true,
    };
    const saved = await save(projectId, runId, state);
    expect(saved.conflict).toBe(false);
    return { reference, product, state, revision: saved.record.revision };
  }

  it('serializes concurrent initialization into one real run and input draft', async () => {
    const projectId = await project();
    const [first, second] = await Promise.all([
      repository.initialize(projectId),
      repository.initialize(projectId),
    ]);
    expect(first).toBe(second);
    expect(await db.workflowRun.count({ where: { projectId } })).toBe(1);
    expect(await db.workflowNodeState.count({ where: { projectId } })).toBe(1);
    const workspace = await repository.workspace(projectId, first);
    expect(workspace.draft!.state).toEqual(emptyCloneInputDraft());
    expect(workspace.uploads).toEqual([]);
    expect(workspace.input).toBeNull();
    expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
  }, 30_000);

  it('allows exactly one concurrent changed draft at the same expected revision', async () => {
    const { projectId, runId } = await scope();
    const original = (await repository.workspace(projectId, runId)).draft!;
    const candidates = ['草稿一', '草稿二'].map((productName) => ({
      ...emptyCloneInputDraft(),
      productName,
    }));
    const results = await Promise.all(
      candidates.map((state) => save(projectId, runId, state, original.revision)),
    );
    expect(results.filter((result) => result.conflict)).toHaveLength(1);
    const winner = results.findIndex((result) => !result.conflict);
    const current = (await repository.workspace(projectId, runId)).draft!;
    expect(current.revision).toBe(original.revision + 1);
    expect(current.state).toEqual(candidates[winner]);
    expect((await repository.workspace(projectId, runId)).input).toBeNull();
  }, 30_000);

  it('confirms idempotently and increments only for two rounds of changed confirmed content', async () => {
    const { projectId, runId } = await scope();
    const input = await prepareInput(projectId, runId);
    const request = { expectedDraftRevision: input.revision, expectedInputRevision: 0 };
    await Promise.all([
      repository.confirm(projectId, runId, request),
      repository.confirm(projectId, runId, request),
    ]);
    const first = (await repository.workspace(projectId, runId)).input!;
    expect(first.revision).toBe(1);
    expect(await db.workingArtifactFile.count({ where: { workingArtifactId: first.id } })).toBe(2);
    await repository.confirm(projectId, runId, request);
    expect((await repository.workspace(projectId, runId)).input!.revision).toBe(1);

    for (const [round, productFacts] of [
      '资料确认包装规格为 500g，原料为大米。',
      '资料确认包装规格为 500g，原料为大米，产地为中国。',
    ].entries()) {
      const saved = await save(projectId, runId, { ...input.state, productFacts });
      // Editing alone never overwrites the confirmed input.
      expect((await repository.workspace(projectId, runId)).input!.revision).toBe(round + 1);
      await expect(repository.confirm(projectId, runId, request)).rejects.toMatchObject({
        status: 409,
      });
      const confirm = {
        expectedDraftRevision: saved.record.revision,
        expectedInputRevision: round + 1,
      };
      await repository.confirm(projectId, runId, confirm);
      const current = (await repository.workspace(projectId, runId)).input!;
      expect(current.id).toBe(first.id);
      expect(current.revision).toBe(round + 2);
      await repository.confirm(projectId, runId, confirm);
      expect((await repository.workspace(projectId, runId)).input!.revision).toBe(round + 2);
    }
    const workspace = await repository.workspace(projectId, runId);
    const same = workspace.draft!.state as unknown as CloneInputDraft;
    const normalized = await save(projectId, runId, {
      ...same,
      productName: `  ${same.productName}  `,
      productFacts: `${same.productFacts}\r\n`,
    });
    expect(normalized.unchanged).toBe(true);
    await repository.confirm(projectId, runId, {
      expectedDraftRevision: normalized.record.revision,
      expectedInputRevision: workspace.input!.revision,
    });
    expect((await repository.workspace(projectId, runId)).input!.revision).toBe(3);
    expect(await db.workingArtifact.count({ where: { projectId } })).toBe(1);
    expect(await db.asset.count({ where: { projectId } })).toBe(0);
  }, 30_000);

  it('rejects foreign projects, foreign runs, workflows and upload roles', async () => {
    const first = await scope();
    const other = await scope();
    const foreignReference = await upload(other.projectId, other.runId);
    await expect(repository.workspace(first.projectId, other.runId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      save(first.projectId, first.runId, {
        ...emptyCloneInputDraft(),
        referenceUploadId: foreignReference.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const ownReference = await upload(first.projectId, first.runId);
    await expect(
      save(first.projectId, first.runId, {
        ...emptyCloneInputDraft(),
        productUploadIds: [ownReference.id],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await db.workflowRun.update({
      where: { id: first.runId },
      data: { activeKey: null, status: 'PAUSED' },
    });
    const nextRun = await repository.initialize(first.projectId);
    expect(nextRun).not.toBe(first.runId);
    await expect(
      save(first.projectId, nextRun, {
        ...emptyCloneInputDraft(),
        referenceUploadId: ownReference.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const effect = await db.workflowRun.create({
      data: { projectId: first.projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    });
    await expect(repository.workspace(first.projectId, effect.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await repository.workspace(first.projectId, nextRun)).draft!.state).toEqual(
      emptyCloneInputDraft(),
    );
    expect(
      (await repository.workspace(other.projectId, other.runId)).uploads.map((u) => u.id),
    ).toEqual([foreignReference.id]);
  }, 30_000);

  it('confirms a 200-code-point product name while bounding only the artifact display name', async () => {
    const { projectId, runId } = await scope();
    const input = await prepareInput(projectId, runId);
    const productName = `${'🌾'.repeat(199)}米`;
    expect(Array.from(productName)).toHaveLength(200);
    const saved = await save(projectId, runId, { ...input.state, productName });
    expect(saved.conflict).toBe(false);
    await repository.confirm(projectId, runId, {
      expectedDraftRevision: saved.record.revision,
      expectedInputRevision: 0,
    });
    const confirmed = (await repository.workspace(projectId, runId)).input!;
    expect(confirmed.revision).toBe(1);
    expect(Array.from(confirmed.name).length).toBeLessThanOrEqual(120);
    expect(confirmed.name.length).toBeGreaterThan(0);
    expect((confirmed.payload as unknown as { input: CloneInputDraft }).input.productName).toBe(
      productName,
    );
    expect(
      ((await repository.workspace(projectId, runId)).draft!.state as unknown as CloneInputDraft)
        .productName,
    ).toBe(productName);
    await repository.confirm(projectId, runId, {
      expectedDraftRevision: saved.record.revision,
      expectedInputRevision: 1,
    });
    expect((await repository.workspace(projectId, runId)).input!.revision).toBe(1);
  }, 30_000);

  it('excludes 80 expired uploads from quota and permits both same-key recovery and a new upload', async () => {
    const { projectId, runId } = await scope();
    const expired = Array.from({ length: 80 }, () => ({
      id: randomUUID(),
      projectId,
      workflowRunId: runId,
      clientUploadKey: randomUUID(),
      attemptToken: randomUUID(),
      status: 'UPLOADING',
      expiresAt: new Date(Date.now() - 60_000),
    }));
    await db.fissionCloneUpload.createMany({ data: expired });
    const original = expired[0]!;
    const recovered = await repository.beginUpload(projectId, runId, original.clientUploadKey);
    expect(recovered.status).toBe('UPLOADING');
    expect(recovered.attemptToken).not.toBe(original.attemptToken);
    expect(recovered.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const fresh = await repository.beginUpload(projectId, runId, randomUUID());
    expect(fresh.id).not.toBe(recovered.id);
    expect(fresh.status).toBe('UPLOADING');
    expect(
      await db.fissionCloneUpload.count({
        where: {
          projectId,
          workflowRunId: runId,
          status: 'UPLOADING',
          expiresAt: { gt: new Date() },
        },
      }),
    ).toBe(2);
    await expect(
      repository.finishUpload(
        projectId,
        runId,
        original.id,
        original.attemptToken,
        'REFERENCE',
        fileIdentity(projectId),
        media,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.fileObject.count({ where: { projectId } })).toBe(0);
  }, 30_000);

  it('fences old draft saves and confirmations after pause and resume, even for identical content', async () => {
    const { projectId, runId } = await scope();
    const input = await prepareInput(projectId, runId);
    await repository.confirm(projectId, runId, {
      expectedDraftRevision: input.revision,
      expectedInputRevision: 0,
    });
    await expect(working.pauseRun(projectId, runId)).rejects.toMatchObject({ status: 400 });
    await working.pauseRun(projectId, runId, { expectedCloneDraftRevision: input.revision });
    await expect(save(projectId, runId, input.state, input.revision)).rejects.toMatchObject({
      status: 409,
    });
    expect(await repository.initialize(projectId)).toBe(runId);
    const resumed = await repository.workspace(projectId, runId);
    expect(resumed.draft!.revision).toBe(input.revision + 1);
    expect(resumed.input!.revision).toBe(1);
    await expect(
      working.pauseRun(projectId, runId, { expectedCloneDraftRevision: input.revision }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repository.workspace(projectId, runId)).run.status).toBe('ACTIVE');
    expect((await save(projectId, runId, input.state, input.revision)).conflict).toBe(true);
    await expect(
      repository.confirm(projectId, runId, {
        expectedDraftRevision: input.revision,
        expectedInputRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await save(projectId, runId, input.state, resumed.draft!.revision)).unchanged).toBe(
      true,
    );
    expect((await repository.workspace(projectId, runId)).input!.revision).toBe(1);
  }, 30_000);

  it('blocks removal of draft and confirmed references and only orphans unreferenced files', async () => {
    const { projectId, runId } = await scope();
    const input = await prepareInput(projectId, runId);
    await expect(repository.removeUpload(projectId, runId, input.product.id)).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    await repository.confirm(projectId, runId, {
      expectedDraftRevision: input.revision,
      expectedInputRevision: 0,
    });
    await save(projectId, runId, emptyCloneInputDraft());
    await expect(
      repository.removeUpload(projectId, runId, input.reference.id),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await db.fileObject.findUnique({ where: { id: input.reference.fileObjectId! } }))!.status,
    ).toBe('AVAILABLE');
    const unused = await upload(projectId, runId, 'PRODUCT');
    await repository.removeUpload(projectId, runId, unused.id);
    await repository.removeUpload(projectId, runId, unused.id);
    expect((await db.fissionCloneUpload.findUnique({ where: { id: unused.id } }))!.status).toBe(
      'REMOVED',
    );
    expect((await db.fileObject.findUnique({ where: { id: unused.fileObjectId! } }))!.status).toBe(
      'ORPHANED',
    );
    expect(
      await db.storageCleanupTask.count({
        where: { projectId, storageKey: unused.fileObject!.storageKey },
      }),
    ).toBe(1);
    expect((await repository.workspace(projectId, runId)).input!.revision).toBe(1);
  }, 30_000);

  it('rejects late upload completion and failure across resume and same-key retry', async () => {
    const { projectId, runId } = await scope();
    const clientKey = randomUUID();
    const old = await repository.beginUpload(projectId, runId, clientKey);
    const oldFile = fileIdentity(projectId);
    const finishOld = () =>
      repository.finishUpload(
        projectId,
        runId,
        old.id,
        old.attemptToken,
        'REFERENCE',
        oldFile,
        media,
      );
    await working.pauseRun(projectId, runId, {
      expectedCloneDraftRevision: (await repository.workspace(projectId, runId)).draft!.revision,
    });
    await expect(finishOld()).rejects.toMatchObject({ status: 409 });
    await repository.initialize(projectId);
    await expect(finishOld()).rejects.toMatchObject({ status: 409 });
    const fresh = await repository.beginUpload(projectId, runId, clientKey);
    expect(fresh.attemptToken).not.toBe(old.attemptToken);
    await expect(finishOld()).rejects.toMatchObject({ status: 409 });
    await repository.failUpload(projectId, runId, old.id, old.attemptToken);
    expect((await db.fissionCloneUpload.findUnique({ where: { id: fresh.id } }))!.status).toBe(
      'UPLOADING',
    );
    const freshFile = fileIdentity(projectId);
    const completed = await repository.finishUpload(
      projectId,
      runId,
      fresh.id,
      fresh.attemptToken,
      'REFERENCE',
      freshFile,
      media,
    );
    const replay = await repository.finishUpload(
      projectId,
      runId,
      fresh.id,
      fresh.attemptToken,
      'REFERENCE',
      freshFile,
      media,
    );
    expect(replay.fileObjectId).toBe(completed.fileObjectId);
    await expect(finishOld()).rejects.toMatchObject({ status: 409 });
    expect(
      await db.fileObject.count({ where: { projectId, storageKey: oldFile.storageKey } }),
    ).toBe(0);
    expect(await db.fileObject.count({ where: { projectId } })).toBe(1);
    expect((await repository.workspace(projectId, runId)).uploads.map((u) => u.id)).toEqual([
      fresh.id,
    ]);
  }, 30_000);
});
