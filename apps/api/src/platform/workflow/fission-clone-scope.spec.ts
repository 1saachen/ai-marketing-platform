import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { emptyCloneInputDraft, type WorkflowPauseRunRequest } from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { lockCloneRun, validateCloneInputUploads } from './fission-clone-scope';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { WorkflowWorkingService } from './workflow-working.service';
import { WorkflowWorkingController } from './workflow-working.controller';
import { workflowStateHash } from './workflow-state-hash';

const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const referenceId = '33333333-3333-4333-8333-333333333333';
const enabled = { get: () => true } as unknown as ConfigService;
const run = {
  id: runId,
  projectId,
  workflow: 'FISSION',
  workflowSpace: 'FISSION_CLONE',
  status: 'ACTIVE',
  activeKey: 'ACTIVE',
};

function scopeFixture(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: projectId, deletionState: null }]),
    workflowRun: { findFirst: vi.fn().mockResolvedValue({ ...run, ...overrides }) },
    fissionCloneUpload: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('clone run and input isolation', () => {
  it('locks the project before the run and returns only the exact clone scope', async () => {
    const tx = scopeFixture();
    await expect(
      lockCloneRun(tx as unknown as Prisma.TransactionClient, projectId, runId, {
        writable: true,
        nodeId: 'CLONE_INPUT',
      }),
    ).resolves.toMatchObject(run);
    const calls = tx.$queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
    expect(calls[0]![0].join('')).toContain('FROM projects');
    expect(calls[1]![0].join('')).toContain('FROM workflow_runs');
    expect(tx.workflowRun.findFirst).toHaveBeenCalledWith({ where: { projectId, id: runId } });
  });

  it.each([
    { workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    { workflowSpace: 'FISSION_AVATAR' },
    { status: 'PAUSED' },
    { status: 'COMPLETED' },
    { activeKey: null },
  ])('rejects a non-writable or foreign run %j', async (overrides) => {
    await expect(
      lockCloneRun(
        scopeFixture(overrides) as unknown as Prisma.TransactionClient,
        projectId,
        runId,
        { writable: true },
      ),
    ).rejects.toThrow();
  });

  it('rejects deleting projects and foreign node IDs', async () => {
    const tx = scopeFixture();
    tx.$queryRaw.mockResolvedValueOnce([{ id: projectId, deletionState: 'QUEUED' }]);
    await expect(
      lockCloneRun(tx as unknown as Prisma.TransactionClient, projectId, runId),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PROJECT_DELETING' }) });
    expect(tx.workflowRun.findFirst).not.toHaveBeenCalled();
    await expect(
      lockCloneRun(scopeFixture() as unknown as Prisma.TransactionClient, projectId, runId, {
        nodeId: 'SOURCE_IMPORT',
      }),
    ).rejects.toThrow('复刻节点无效');
  });

  it('validates pinned uploads in project, run, availability and role', async () => {
    const tx = scopeFixture();
    const input = { ...emptyCloneInputDraft(), referenceUploadId: referenceId };
    await expect(
      validateCloneInputUploads(tx as unknown as Prisma.TransactionClient, projectId, runId, input),
    ).rejects.toThrow('选择的素材不可用');
    tx.fissionCloneUpload.findMany.mockResolvedValue([
      { id: referenceId, role: 'PRODUCT' },
    ] as never);
    await expect(
      validateCloneInputUploads(tx as unknown as Prisma.TransactionClient, projectId, runId, input),
    ).rejects.toThrow();
    tx.fissionCloneUpload.findMany.mockResolvedValue([
      { id: referenceId, role: 'REFERENCE' },
    ] as never);
    await expect(
      validateCloneInputUploads(tx as unknown as Prisma.TransactionClient, projectId, runId, input),
    ).resolves.toEqual(input);
    expect(tx.fissionCloneUpload.findMany).toHaveBeenLastCalledWith({
      where: {
        projectId,
        workflowRunId: runId,
        id: { in: [referenceId] },
        status: 'AVAILABLE',
        fileObject: { status: 'AVAILABLE' },
      },
      select: { id: true, role: true },
    });
  });

  it('fails closed before any new-table read when the feature is disabled', async () => {
    const tx = scopeFixture();
    const repository = new WorkflowWorkingRepository({
      $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaService);
    await expect(
      repository.saveNodeState(projectId, runId, 'CLONE_INPUT', '', emptyCloneInputDraft(), 0, 1),
    ).rejects.toThrow('尚未启用');
    expect(tx.fissionCloneUpload.findMany).not.toHaveBeenCalled();
  });
});

describe('clone draft compare-and-swap', () => {
  it.each([true, false])(
    'keeps other artifact and clone upload references when deleting a working copy (enabled=%s)',
    async (cloneEnabled) => {
      const updateMany = vi.fn();
      const record = { id: 'artifact', files: [{ fileObjectId: 'file' }] };
      const tx = {
        workingArtifact: { findUnique: vi.fn().mockResolvedValue(record), delete: vi.fn() },
        workflowRun: { findFirst: vi.fn().mockResolvedValue(run) },
        fileObject: { updateMany },
      };
      const repository = new WorkflowWorkingRepository(
        { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaService,
        { get: () => cloneEnabled } as unknown as ConfigService,
      );
      Object.assign(repository, { markArtifactDependentsStaleInTransaction: vi.fn() });
      await repository.deleteArtifact(projectId, runId, 'CLONE_INPUT', 'clone-input');
      expect(updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          projectId,
          artifactLinks: { none: {} },
          ...(cloneEnabled
            ? { cloneUploads: { none: { status: { in: ['UPLOADING', 'AVAILABLE'] } } } }
            : { NOT: { nodeId: 'CLONE_INPUT' } }),
        }),
        data: { status: 'ORPHANED', orphanedAt: expect.any(Date) },
      });
    },
  );

  it('serializes competing saves and does not invalidate confirmed artifacts', async () => {
    let state = {
      id: 'draft',
      revision: 1,
      state: emptyCloneInputDraft(),
      contentHash: workflowStateHash(emptyCloneInputDraft()),
      executionInputHash: 'old',
      executionInputSchemaVersion: 1,
    };
    let tail = Promise.resolve();
    const writeRun = vi.fn();
    const markDependents = vi.fn();
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        let release: (() => void) | undefined;
        const tx = {
          workflowRun: { findFirst: vi.fn().mockResolvedValue(run), update: writeRun },
          workflowNodeState: {
            findUnique: async () => state,
            update: async ({ data }: { data: Record<string, unknown> }) => {
              state = {
                ...state,
                ...data,
                revision: data.revision ? state.revision + 1 : state.revision,
              } as typeof state;
              return state;
            },
          },
          $queryRaw: async (strings: TemplateStringsArray) => {
            if (strings.join('').includes('FROM projects')) {
              const prior = tail;
              tail = new Promise<void>((resolve) => {
                release = resolve;
              });
              await prior;
            }
            return [{ id: projectId, deletionState: null }];
          },
        };
        try {
          return await fn(tx);
        } finally {
          release?.();
        }
      },
    };
    const repository = new WorkflowWorkingRepository(prisma as unknown as PrismaService, enabled);
    Object.assign(repository, { markNodeDependentsStaleInTransaction: markDependents });
    const [first, second] = await Promise.all(
      ['first', 'second'].map((productName) =>
        repository.saveNodeState(
          projectId,
          runId,
          'CLONE_INPUT',
          'ignored-client-hash',
          { ...emptyCloneInputDraft(), productName },
          1,
          1,
        ),
      ),
    );
    expect(first!.conflict).toBe(false);
    expect(second!.conflict).toBe(true);
    expect(state.revision).toBe(2);
    expect(state.state.productName).toBe('first');
    expect(markDependents).not.toHaveBeenCalled();
    expect(writeRun).toHaveBeenCalledTimes(1);
    const staleIdentical = await repository.saveNodeState(
      projectId,
      runId,
      'CLONE_INPUT',
      state.contentHash,
      state.state,
      1,
      1,
    );
    expect(staleIdentical.conflict).toBe(true);
    expect(state.revision).toBe(2);
  });
});

describe('clone pause editing fence', () => {
  function pauseFixture(workflowSpace = 'FISSION_CLONE') {
    const tx = {
      ...scopeFixture({ workflowSpace }),
      workflowNodeState: {
        findMany: vi.fn().mockResolvedValue([{ nodeId: 'CLONE_INPUT', revision: 3 }]),
      },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    Object.assign(tx.workflowRun, { updateMany });
    const prisma = {
      workflowRun: { ...tx.workflowRun, updateMany },
      $transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    return {
      tx,
      prisma,
      updateMany,
      repository: new WorkflowWorkingRepository(prisma as unknown as PrismaService, enabled),
    };
  }

  it.each([undefined, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '3'])(
    'rejects a missing or invalid clone editing revision: %s',
    async (revision) => {
      const { repository, updateMany } = pauseFixture();
      await expect(
        repository.pauseRun(projectId, runId, {
          expectedCloneDraftRevision: revision,
        } as WorkflowPauseRunRequest),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VALIDATION_ERROR' }) });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('rejects a late pause after resume and permits the current editing revision', async () => {
    const { repository, tx, updateMany } = pauseFixture();
    await expect(
      repository.pauseRun(projectId, runId, { expectedCloneDraftRevision: 2 }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFLICT' }) });
    expect(updateMany).not.toHaveBeenCalled();
    await expect(
      repository.pauseRun(projectId, runId, { expectedCloneDraftRevision: 3 }),
    ).resolves.toEqual({ count: 1 });
    expect(tx.workflowNodeState.findMany).toHaveBeenCalledWith({
      where: { projectId, workflowRunId: runId },
      select: { nodeId: true, revision: true },
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { projectId, id: runId, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: { status: 'PAUSED', lastActiveAt: expect.any(Date) },
    });
  });

  it('preserves empty-body pause compatibility for other workflows', async () => {
    const { repository, prisma, tx, updateMany } = pauseFixture('EFFECT');
    await expect(repository.pauseRun(projectId, runId)).resolves.toEqual({ count: 1 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.workflowNodeState.findMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('passes the editing revision from the HTTP controller through the service', async () => {
    const repository = { pauseRun: vi.fn().mockResolvedValue({ count: 1 }) };
    const projectService = { get: vi.fn().mockResolvedValue({ id: projectId }) };
    const service = new WorkflowWorkingService(
      repository as never,
      projectService as never,
      {} as never,
    );
    const controller = new WorkflowWorkingController(service);
    const request: WorkflowPauseRunRequest = { expectedCloneDraftRevision: 3 };
    await expect(controller.pauseRun(projectId, runId, request)).resolves.toEqual({ paused: true });
    expect(repository.pauseRun).toHaveBeenCalledWith(projectId, runId, request);
  });

  it('requires all existing node revisions and rejects another node changed in a second tab', async () => {
    const { repository, tx, updateMany } = pauseFixture();
    tx.workflowNodeState.findMany.mockResolvedValue([
      { nodeId: 'CLONE_INPUT', revision: 3 },
      { nodeId: 'CLONE_MAPPING', revision: 5 },
    ]);
    await expect(
      repository.pauseRun(projectId, runId, { expectedCloneDraftRevision: 3 }),
    ).rejects.toThrow('全部节点');
    await expect(
      repository.pauseRun(projectId, runId, {
        expectedCloneDraftRevisions: { CLONE_INPUT: 3, CLONE_MAPPING: 4 },
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFLICT' }) });
    expect(updateMany).not.toHaveBeenCalled();
    await expect(
      repository.pauseRun(projectId, runId, {
        expectedCloneDraftRevisions: { CLONE_INPUT: 3, CLONE_ANALYSIS: 0, CLONE_MAPPING: 5 },
      }),
    ).resolves.toEqual({ count: 1 });
  });

  it('does not accept an invented or omitted node frontier', async () => {
    const { repository, updateMany } = pauseFixture();
    await expect(
      repository.pauseRun(projectId, runId, {
        expectedCloneDraftRevisions: { CLONE_INPUT: 3, EVIL: 0 },
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VALIDATION_ERROR' }) });
    await expect(
      repository.pauseRun(projectId, runId, { expectedCloneDraftRevisions: {} }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFLICT' }) });
    await expect(
      repository.pauseRun(projectId, runId, {
        expectedCloneDraftRevisions: { CLONE_INPUT: 3, CLONE_ANALYSIS: 1 },
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFLICT' }) });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
