import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import type { CloneUploadRole } from '@ai-marketing/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiHttpException } from '../../../common/api-http-exception';
import type { StoragePutInput } from '../../../platform/file/storage.port';
import type { CloneRepository } from './clone.repository';
import { CloneService } from './clone.service';

type UploadRecord = Awaited<ReturnType<CloneRepository['beginUpload']>>;
const projectId = randomUUID(),
  runId = randomUUID(),
  assetId = randomUUID();
// These bytes test transport/hash/cleanup only. Media inspection is an explicit stub boundary.
const bytes = Buffer.from('synthetic transport bytes; not a video');
const mediaInfo = { durationMs: 10_000, width: 1080, height: 1920, frameRate: 30 };
const originalEnvironment = {
  FISSION_CLONE_ENABLED: process.env.FISSION_CLONE_ENABLED,
  MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES,
};

function pending(): UploadRecord {
  return {
    id: randomUUID(),
    projectId,
    workflowRunId: runId,
    fileObjectId: null,
    role: null,
    status: 'UPLOADING',
    media: null,
    clientUploadKey: randomUUID(),
    attemptToken: randomUUID(),
    sourceAssetId: null,
    sourceAssetVersion: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    fileObject: null,
  };
}

function completed(
  attempt: UploadRecord,
  role: CloneUploadRole = 'REFERENCE',
  source?: { assetId: string; version: number },
): UploadRecord {
  const fileId = randomUUID();
  return {
    ...attempt,
    status: 'AVAILABLE',
    role,
    media: mediaInfo,
    fileObjectId: fileId,
    sourceAssetId: source?.assetId ?? null,
    sourceAssetVersion: source?.version ?? null,
    fileObject: {
      id: fileId,
      projectId,
      workflowRunId: runId,
      nodeId: 'CLONE_INPUT',
      originalFileName: 'reference.mp4',
      mimeType: 'video/mp4',
      sizeBytes: bytes.length,
      storageKey: `test/${projectId}/${fileId}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'AVAILABLE',
      orphanedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

describe('clone input service failure and identity boundaries', () => {
  let directory: string;
  let attempt: UploadRecord;
  let config: ConfigService;
  let service: CloneService;
  const repository = {
    initialize: vi.fn(),
    workspace: vi.fn(),
    beginUpload: vi.fn(),
    finishUpload: vi.fn(),
    failUpload: vi.fn(),
    confirm: vi.fn(),
    removeUpload: vi.fn(),
  };
  const media = { inspect: vi.fn() };
  const projects = { get: vi.fn() };
  const assets = { getVersion: vi.fn(), content: vi.fn() };
  const working = { enqueueCleanup: vi.fn() };
  const storage = { put: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'clone-service-test-'));
    attempt = pending();
    config = new ConfigService({
      FISSION_CLONE_ENABLED: true,
      MAX_UPLOAD_BYTES: 256 * 1024 * 1024,
    });
    repository.beginUpload.mockResolvedValue(attempt);
    repository.finishUpload.mockImplementation(
      async (
        _p,
        _r,
        _id,
        _token,
        role: CloneUploadRole,
        _file,
        _media,
        source?: { assetId: string; version: number },
      ) => completed(attempt, role, source),
    );
    repository.failUpload.mockResolvedValue(undefined);
    projects.get.mockResolvedValue({ id: projectId, name: '受控传输测试' });
    media.inspect.mockResolvedValue({ mimeType: 'video/mp4', media: mediaInfo });
    assets.getVersion.mockResolvedValue({ status: 'AVAILABLE' });
    assets.content.mockImplementation(async () => ({
      originalFileName: 'reference.mp4',
      mimeType: 'video/mp4',
      sizeBytes: bytes.length,
      stream: Readable.from([bytes]),
    }));
    working.enqueueCleanup.mockResolvedValue(undefined);
    storage.put.mockImplementation(async (input: StoragePutInput) => {
      // Drain the stream like a storage adapter, so cleanup also works on Windows.
      let sizeBytes = 0;
      for await (const chunk of input.stream) sizeBytes += Buffer.byteLength(chunk as Buffer);
      return { key: `test/${projectId}/stored-object`, sizeBytes };
    });
    service = new CloneService(
      repository as never,
      media as never,
      config,
      projects as never,
      assets as never,
      working as never,
      storage as never,
    );
  });

  afterEach(async () => {
    try {
      // This is solely the directory returned by this test's mkdtemp call.
      await rm(directory, { recursive: true, force: true });
    } finally {
      // ConfigService.set also writes process.env; do not leak limits to other tests.
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  async function temporaryFile(content = bytes) {
    const path = join(directory, `${randomUUID()}.mp4`);
    await writeFile(path, content);
    return { path, originalname: 'reference.mp4', mimetype: 'video/mp4', size: content.length };
  }

  it('rejects missing configuration before any project, repository or storage operation', async () => {
    config.set('FISSION_CLONE_ENABLED', undefined);
    expect(service.capabilities()).toMatchObject({
      inputEnabled: false,
      analysisEnabled: false,
      generationEnabled: false,
    });
    await expect(service.initialize(projectId)).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'CLONE_CAPABILITY_UNAVAILABLE' }),
    });
    await expect(service.beginUpload(projectId, runId, randomUUID())).rejects.toMatchObject({
      status: 503,
    });
    expect(projects.get).not.toHaveBeenCalled();
    expect(repository.initialize).not.toHaveBeenCalled();
    expect(repository.beginUpload).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('removes rejected media before any storage write or file attachment', async () => {
    const file = await temporaryFile();
    media.inspect.mockRejectedValue(new ApiHttpException('媒体不可解码', 400, 'VALIDATION_ERROR'));
    await expect(
      service.upload(projectId, runId, attempt, 'REFERENCE', file),
    ).rejects.toMatchObject({ status: 400 });
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.finishUpload).not.toHaveBeenCalled();
    expect(working.enqueueCleanup).not.toHaveBeenCalled();
    await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])(
    'queues an unbound stored file and cleans local bytes even if queue failure is %s',
    async (queueFails) => {
      const file = await temporaryFile();
      repository.finishUpload.mockRejectedValue(
        new ApiHttpException('旧上传尝试已失效', 409, 'CONFLICT'),
      );
      if (queueFails) working.enqueueCleanup.mockRejectedValue(new Error('QUEUE_UNAVAILABLE'));
      await expect(service.upload(projectId, runId, attempt, 'REFERENCE', file)).rejects.toThrow();
      expect(repository.finishUpload).toHaveBeenCalledWith(
        projectId,
        runId,
        attempt.id,
        attempt.attemptToken,
        'REFERENCE',
        expect.objectContaining({ storageKey: `test/${projectId}/stored-object` }),
        mediaInfo,
        undefined,
      );
      expect(working.enqueueCleanup).toHaveBeenCalledExactlyOnceWith(
        projectId,
        `test/${projectId}/stored-object`,
        'CLONE_UPLOAD_UNBOUND',
      );
      await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('replays an available upload only for identical bytes, role and exact source version', async () => {
    const source = { assetId, version: 3 };
    const existing = completed(attempt, 'REFERENCE', source);
    const file = await temporaryFile();
    const result = await service.upload(projectId, runId, existing, 'REFERENCE', file, source);
    expect(result.fileObjectId).toBe(existing.fileObjectId);
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.finishUpload).not.toHaveBeenCalled();
    expect(working.enqueueCleanup).not.toHaveBeenCalled();
    await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['role', 'version', 'asset', 'bytes'])(
    'rejects a replay whose %s changes without replacing the original file',
    async (change) => {
      const source = { assetId, version: 3 };
      const existing = completed(attempt, 'REFERENCE', source);
      const file = await temporaryFile(change === 'bytes' ? Buffer.from('different') : bytes);
      const role = change === 'role' ? 'PRODUCT' : 'REFERENCE';
      const nextSource = {
        assetId: change === 'asset' ? randomUUID() : assetId,
        version: change === 'version' ? 4 : 3,
      };
      await expect(
        service.upload(projectId, runId, existing, role, file, nextSource),
      ).rejects.toMatchObject({ status: 409 });
      expect(storage.put).not.toHaveBeenCalled();
      expect(repository.finishUpload).not.toHaveBeenCalled();
      expect(working.enqueueCleanup).not.toHaveBeenCalled();
      await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('imports the selected asset version and persists its exact source identity', async () => {
    const request = {
      assetId,
      version: 7,
      role: 'REFERENCE' as const,
      clientUploadKey: randomUUID(),
    };
    const result = await service.importAsset(projectId, runId, request);
    expect(assets.getVersion).toHaveBeenCalledExactlyOnceWith(projectId, assetId, 7);
    expect(assets.content).toHaveBeenCalledExactlyOnceWith(projectId, assetId, undefined, 7);
    expect(repository.beginUpload).toHaveBeenCalledExactlyOnceWith(
      projectId,
      runId,
      request.clientUploadKey,
    );
    expect(repository.finishUpload).toHaveBeenCalledWith(
      projectId,
      runId,
      attempt.id,
      attempt.attemptToken,
      'REFERENCE',
      expect.objectContaining({ sha256: createHash('sha256').update(bytes).digest('hex') }),
      mediaInfo,
      { assetId, version: 7 },
    );
    expect(result.id).toBe(attempt.id);
    expect(working.enqueueCleanup).not.toHaveBeenCalled();
    const inspectedPath = media.inspect.mock.calls[0]![0].path as string;
    await expect(stat(dirname(inspectedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['REFERENCE', 'PRODUCT'] as const)(
    'stops a %s asset stream exceeding the actual byte limit despite a smaller declaration',
    async (role) => {
      config.set('MAX_UPLOAD_BYTES', 8);
      const stream = Readable.from([Buffer.alloc(6), Buffer.alloc(10)]);
      assets.content.mockResolvedValue({
        originalFileName: 'source.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 4,
        stream,
      });
      await expect(
        service.importAsset(projectId, runId, {
          assetId,
          version: 2,
          role,
          clientUploadKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
      });
      expect(stream.destroyed).toBe(true);
      expect(media.inspect).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(repository.finishUpload).not.toHaveBeenCalled();
      expect(repository.failUpload).toHaveBeenCalledExactlyOnceWith(
        projectId,
        runId,
        attempt.id,
        attempt.attemptToken,
      );
    },
  );

  it('cleans an imported temporary directory even if closing the upload attempt fails', async () => {
    repository.failUpload.mockRejectedValue(new Error('DATABASE_UNAVAILABLE'));
    await expect(
      service.importAsset(projectId, runId, {
        assetId,
        version: 5,
        role: 'REFERENCE',
        clientUploadKey: randomUUID(),
      }),
    ).rejects.toThrow('DATABASE_UNAVAILABLE');
    const inspectedPath = media.inspect.mock.calls[0]![0].path as string;
    await expect(stat(dirname(inspectedPath))).rejects.toMatchObject({ code: 'ENOENT' });
    // The successfully attached object must not be scheduled for deletion by cleanup failure.
    expect(repository.finishUpload).toHaveBeenCalledOnce();
    expect(working.enqueueCleanup).not.toHaveBeenCalled();
  });
});
