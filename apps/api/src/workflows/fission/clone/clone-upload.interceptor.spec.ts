import { randomUUID } from 'node:crypto';
import { lastValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpException } from '../../../common/api-http-exception';
import { CloneUploadInterceptor, type CloneUploadRequest } from './clone-upload.interceptor';

describe('clone upload reservation interceptor', () => {
  const service = { beginUpload: vi.fn(), failUpload: vi.fn() };
  let request: CloneUploadRequest;
  let attempt: { id: string; attemptToken: string };
  const interceptor = new CloneUploadInterceptor(service as never);
  const context = () => ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;

  beforeEach(() => {
    vi.resetAllMocks();
    request = {
      params: { projectId: randomUUID(), runId: randomUUID() },
      headers: { 'x-upload-key': randomUUID() },
    };
    attempt = { id: randomUUID(), attemptToken: randomUUID() };
    service.beginUpload.mockResolvedValue(attempt);
    service.failUpload.mockResolvedValue(undefined);
  });

  it('reserves the project-scoped upload before accepting bytes and closes only its own attempt', async () => {
    const handle = vi.fn(() => {
      expect(service.beginUpload).toHaveBeenCalledExactlyOnceWith(
        request.params.projectId,
        request.params.runId,
        request.headers['x-upload-key'],
      );
      expect(request.cloneUpload).toBe(attempt);
      return of({ uploaded: true });
    });
    expect(await lastValueFrom(interceptor.intercept(context(), { handle }))).toEqual({
      uploaded: true,
    });
    expect(service.failUpload).toHaveBeenCalledExactlyOnceWith(
      request.params.projectId,
      request.params.runId,
      attempt.id,
      attempt.attemptToken,
    );
  });

  it('releases the matching reservation after multipart or controller failure', async () => {
    const failure = new ApiHttpException('文件超出限制', 400, 'FILE_TOO_LARGE');
    const handle = vi.fn(() => throwError(() => failure));
    await expect(lastValueFrom(interceptor.intercept(context(), { handle }))).rejects.toBe(failure);
    expect(service.failUpload).toHaveBeenCalledExactlyOnceWith(
      request.params.projectId,
      request.params.runId,
      attempt.id,
      attempt.attemptToken,
    );
  });

  it('does not start receiving or close an unrelated attempt when reservation is rejected', async () => {
    service.beginUpload.mockRejectedValue(new ApiHttpException('工作流已暂停', 409, 'CONFLICT'));
    const handle = vi.fn(() => of({}));
    await expect(lastValueFrom(interceptor.intercept(context(), { handle }))).rejects.toMatchObject(
      { status: 409 },
    );
    expect(handle).not.toHaveBeenCalled();
    expect(service.failUpload).not.toHaveBeenCalled();
  });

  it.each(['project', 'run', 'key', 'duplicate-header'])(
    'rejects malformed %s before creating a hold',
    async (field) => {
      if (field === 'project') request.params.projectId = 'invalid';
      else if (field === 'run') request.params.runId = 'invalid';
      else
        request.headers['x-upload-key'] =
          field === 'duplicate-header' ? [randomUUID(), randomUUID()] : 'invalid';
      const handle = vi.fn(() => of({}));
      await expect(
        lastValueFrom(interceptor.intercept(context(), { handle })),
      ).rejects.toMatchObject({ status: 400 });
      expect(service.beginUpload).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();
    },
  );
});
