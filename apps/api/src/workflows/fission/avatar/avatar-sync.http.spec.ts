import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AvatarSyncWorkerController, AvatarSyncWorkerGuard } from './avatar-sync.controller';
import { AvatarSyncRepository } from './avatar-sync.repository';
import { AvatarSyncService } from './avatar-sync.service';

const workerToken = randomUUID();
const submitResult = vi.fn().mockResolvedValue({ accepted: true });
const continuityCheckpoint = vi.fn().mockResolvedValue({ allowed: true });
const nativeCheckpoint = vi.fn().mockResolvedValue({ allowed: true });

@Module({
  controllers: [AvatarSyncWorkerController],
  providers: [
    AvatarSyncWorkerGuard,
    {
      provide: ConfigService,
      useValue: new ConfigService({
        FISSION_AVATAR_ENABLED: true,
        FISSION_AVATAR_SYNC_ENABLED: false,
        FISSION_AVATAR_SYNC_WORKER_TOKEN: workerToken,
      }),
    },
    { provide: AvatarSyncService, useValue: { submitResult } },
    { provide: AvatarSyncRepository, useValue: { continuityCheckpoint, nativeCheckpoint } },
  ],
})
class AvatarSyncHttpModule {}

describe('avatar sync worker result HTTP boundary', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AvatarSyncHttpModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts the two files and metadata while generation is disabled', async () => {
    const projectId = randomUUID();
    const workflowRunId = randomUUID();
    const taskId = randomUUID();
    const attemptToken = randomUUID();
    const metadata = JSON.stringify({ audioDurationMs: 2_000, wordTimings: [] });
    const body = new FormData();
    body.set('audio', new Blob(['speech'], { type: 'audio/mpeg' }), 'speech.mp3');
    body.set('video', new Blob(['mouth'], { type: 'video/mp4' }), 'mouth.mp4');
    body.set('metadata', metadata);

    const response = await fetch(
      `${base}/internal/workers/fission-avatar/${projectId}/${workflowRunId}/tasks/${taskId}/result`,
      {
        method: 'PUT',
        headers: { 'x-worker-token': workerToken, 'x-attempt-token': attemptToken },
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(submitResult).toHaveBeenCalledExactlyOnceWith(
      { projectId, workflowRunId },
      taskId,
      attemptToken,
      [
        expect.objectContaining({ fieldname: 'audio', originalname: 'speech.mp3' }),
        expect.objectContaining({ fieldname: 'video', originalname: 'mouth.mp4' }),
      ],
      metadata,
    );
  });

  it('admits only scoped continuation checkpoints and rejects URLs in a receipt', async () => {
    const projectId = randomUUID();
    const workflowRunId = randomUUID();
    const taskId = randomUUID();
    const attemptToken = randomUUID();
    const url = `${base}/internal/workers/fission-avatar/${projectId}/${workflowRunId}/tasks/${taskId}/continuity/checkpoint`;
    const request = (body: unknown, token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'x-worker-token': token,
          'x-attempt-token': attemptToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const checkpoint = { kind: 'PICTURE_ACCEPTED', ordinal: 1, providerTaskId: 'cgt-fixture' };
    expect((await request(checkpoint, randomUUID())).status).toBe(401);
    expect(
      (
        await request(
          { ...checkpoint, providerTaskId: 'https://example.com/temporary' },
          workerToken,
        )
      ).status,
    ).toBe(400);
    expect((await request(checkpoint, workerToken)).status).toBe(200);
    expect(continuityCheckpoint).toHaveBeenCalledExactlyOnceWith(
      { projectId, workflowRunId },
      taskId,
      attemptToken,
      checkpoint,
    );
  });

  it('accepts only a scoped native checkpoint with an opaque Ark task ID', async () => {
    const projectId = randomUUID();
    const workflowRunId = randomUUID();
    const taskId = randomUUID();
    const attemptToken = randomUUID();
    const url = `${base}/internal/workers/fission-avatar/${projectId}/${workflowRunId}/tasks/${taskId}/native/checkpoint`;
    const request = (body: unknown, token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'x-worker-token': token,
          'x-attempt-token': attemptToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const checkpoint = { kind: 'NATIVE_ACCEPTED', providerTaskId: 'cgt-native-fixture' };
    expect((await request(checkpoint, randomUUID())).status).toBe(401);
    expect(
      (
        await request(
          { ...checkpoint, providerTaskId: 'https://example.com/temporary' },
          workerToken,
        )
      ).status,
    ).toBe(400);
    expect((await request(checkpoint, workerToken)).status).toBe(200);
    expect(nativeCheckpoint).toHaveBeenCalledExactlyOnceWith(
      { projectId, workflowRunId },
      taskId,
      attemptToken,
      checkpoint,
    );
  });
});
