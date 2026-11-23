import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CloneTaskService } from './clone-task.service';
import { CloneWorkerGuard } from './clone-worker.controller';

function fixture(overrides: Record<string, unknown> = {}) {
  const repository = {
    existingTask: vi.fn().mockResolvedValue(null),
    accessRun: vi.fn(),
    candidateVersions: vi.fn().mockResolvedValue([]),
    generationPlan: vi.fn(),
    assetVersion: vi.fn(),
    create: vi.fn(),
    recoverExpired: vi.fn(),
  };
  const clone = { workspace: vi.fn().mockResolvedValue({ isolated: true }) };
  const projects = { get: vi.fn() };
  const config = new ConfigService({
    FISSION_CLONE_ENABLED: true,
    FISSION_CLONE_G2_ENABLED: true,
    FISSION_CLONE_ANALYSIS_MODEL: 'isolated-test-model',
    FISSION_CLONE_ANALYSIS_WORKER_TOKEN: 'isolated-test-token',
    ...overrides,
  });
  const service = new CloneTaskService(
    repository as never,
    clone as never,
    {} as never,
    config,
    projects as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const request = {
    idempotencyKey: randomUUID(),
    sourceInput: { artifactId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    sourceAnalysis: null,
    expectedDraftRevision: 0,
    expectedArtifactRevision: 0,
    purpose: null,
  };
  return { service, repository, clone, projects, request };
}

describe('clone G2 service boundaries', () => {
  it('uses project access and rejects unsupported generation before loading the sources', async () => {
    const f = fixture();
    const body = {
      sourceMapping: f.request.sourceInput,
      count: 1,
      audioMode: 'SILENT',
      transitionMode: 'CROSSFADE',
    };
    await expect(f.service.preflightGeneration('project', 'run', body)).rejects.toThrow('枚举');
    expect(f.projects.get).toHaveBeenCalledWith('project');
    expect(f.repository.generationPlan).not.toHaveBeenCalled();
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('requires private reference signing before loading generation sources', async () => {
    const f = fixture({
      FISSION_CLONE_G3_ENABLED: true,
      FISSION_CLONE_GENERATION_WORKER_TOKEN: 'isolated-generation-worker-token',
      FISSION_CLONE_GENERATION_MODEL: 'isolated-generation-model',
      FISSION_CLONE_REVIEW_MODEL: 'isolated-review-model',
      STORAGE_DRIVER: 'local',
    });
    await expect(
      f.service.preflightGeneration('project', 'run', {
        sourceMapping: f.request.sourceInput,
        count: 1,
        audioMode: 'SILENT',
        transitionMode: 'CUT',
      }),
    ).rejects.toThrow('私有 TOS');
    expect(f.repository.generationPlan).not.toHaveBeenCalled();
  });
  it('does not query new tables or recover tasks with G2 disabled', async () => {
    const f = fixture({ FISSION_CLONE_G2_ENABLED: false });
    f.service.onModuleInit();
    await expect(
      f.service.create(randomUUID(), randomUUID(), 'ANALYZE', f.request),
    ).rejects.toThrow('尚未启用');
    expect(f.repository.existingTask).not.toHaveBeenCalled();
    expect(f.repository.recoverExpired).not.toHaveBeenCalled();
    f.service.onModuleDestroy();
  });
  it('rejects missing real configuration without a fallback task', async () => {
    const f = fixture({ FISSION_CLONE_ANALYSIS_MODEL: undefined });
    await expect(
      f.service.create(randomUUID(), randomUUID(), 'ANALYZE', f.request),
    ).rejects.toThrow('尚未配置');
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('replays an existing idempotent request before candidate IO or changed model configuration', async () => {
    const f = fixture({ FISSION_CLONE_ANALYSIS_MODEL: undefined });
    f.repository.existingTask.mockResolvedValue({ id: randomUUID() });
    f.repository.candidateVersions.mockRejectedValue(
      new Error('must not list newly changed assets'),
    );
    await expect(
      f.service.create(randomUUID(), randomUUID(), 'MAP_SUGGEST', {
        ...f.request,
        sourceAnalysis: f.request.sourceInput,
        purpose: 'SMART_MATCH',
      }),
    ).resolves.toEqual({ isolated: true });
    expect(f.repository.candidateVersions).not.toHaveBeenCalled();
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('freezes bounded metadata candidates without opening or copying their files', async () => {
    const f = fixture(),
      assetId = randomUUID(),
      versionId = randomUUID();
    f.repository.candidateVersions.mockResolvedValue([
      { id: assetId, currentVersion: 2, name: '目标商品', type: 'PRODUCT_ASSET' },
    ]);
    f.repository.assetVersion.mockResolvedValue({ id: versionId, mimeType: 'image/png' });
    await f.service.create(randomUUID(), randomUUID(), 'MAP_SUGGEST', {
      ...f.request,
      sourceAnalysis: f.request.sourceInput,
      purpose: 'SMART_MATCH',
    });
    expect(f.repository.create.mock.calls[0]?.[4]).toEqual([
      {
        assetId,
        version: 2,
        sourceVersionId: versionId,
        name: '目标商品',
        type: 'PRODUCT_ASSET',
        mimeType: 'image/png',
        file: null,
      },
    ]);
  });
});

describe('clone independent worker authentication', () => {
  const context = (token: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-worker-token': token } }) }),
    }) as unknown as ExecutionContext;
  it('requires its dedicated token and does not inherit another worker credential', () => {
    const guard = new CloneWorkerGuard(
      new ConfigService({
        FISSION_CLONE_ANALYSIS_WORKER_TOKEN: 'clone-test-token',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'other-test-token',
      }),
    );
    expect(() => guard.canActivate(context(undefined))).toThrow();
    expect(() => guard.canActivate(context('other-test-token'))).toThrow();
    expect(() => guard.canActivate(context(['clone-test-token']))).toThrow();
    expect(guard.canActivate(context('clone-test-token'))).toBe(true);
  });
});
