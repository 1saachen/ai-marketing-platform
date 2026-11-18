import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { CLONE_UUID_PATTERN } from '@ai-marketing/contracts';
import { defer, lastValueFrom } from 'rxjs';
import { ApiHttpException } from '../../../common/api-http-exception';
import { CloneService } from './clone.service';

export type CloneUploadRequest = {
  params: { projectId: string; runId: string };
  headers: Record<string, string | string[] | undefined>;
  cloneUpload?: Awaited<ReturnType<CloneService['beginUpload']>>;
};

/** Runs before Multer so a receiving upload already holds the project deletion gate. */
@Injectable()
export class CloneUploadInterceptor implements NestInterceptor {
  constructor(@Inject(CloneService) private readonly service: CloneService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    return defer(async () => {
      const req = context.switchToHttp().getRequest<CloneUploadRequest>();
      const { projectId, runId } = req.params;
      const key = req.headers['x-upload-key'] ?? randomUUID();
      const uuid = new RegExp(CLONE_UUID_PATTERN);
      if (!uuid.test(projectId) || !uuid.test(runId) || typeof key !== 'string' || !uuid.test(key))
        throw new ApiHttpException('上传作用域或请求标识无效', 400, 'VALIDATION_ERROR');
      const upload = await this.service.beginUpload(projectId, runId, key);
      req.cloneUpload = upload;
      try {
        return await lastValueFrom(next.handle());
      } finally {
        await this.service.failUpload(projectId, runId, upload.id, upload.attemptToken);
      }
    });
  }
}
