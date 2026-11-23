import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { LOCAL_REPLACE_LIMITS, parseLocalReplaceSourceProbe } from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { RawResponse } from '../../../common/raw-response.decorator';
import {
  AssetRangeNotSatisfiableError,
  type UploadedAssetFile,
} from '../../../platform/asset/asset.service';
import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
import { fileContentDisposition } from '../../../platform/file/content-disposition';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { LocalReplaceRepository } from './local-replace.repository';
import { LocalReplaceService, localReplaceWorkerToken } from './local-replace.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });
const path = 'workflow-runs/:runId/fission-local-replace';
const validationError = (): never => {
  throw new ApiHttpException('局部替换任务请求格式无效', 400, 'VALIDATION_ERROR');
};
const workerFailureCodes = new Set([
  'MEDIA_INVALID',
  'PROVIDER_REJECTED',
  'PROVIDER_FAILED',
  'PROVIDER_CREATION_UNKNOWN',
  'INTERNAL_API_FAILED',
  'INVALID_TASK',
]);

@Controller('projects/:projectId')
export class LocalReplaceController {
  constructor(@Inject(LocalReplaceService) private readonly service: LocalReplaceService) {}

  @Post('fission-local-replace/workspace')
  initialize(@Param('projectId', uuid()) project: string) {
    return this.service.initialize(project);
  }

  @Get(`${path}/workspace`)
  workspace(@Param('projectId', uuid()) project: string, @Param('runId', uuid()) run: string) {
    return this.service.workspace(project, run);
  }

  @Put(`${path}/draft`)
  save(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Body() body: unknown,
  ) {
    return this.service.saveDraft(project, run, body);
  }

  @Post(`${path}/tasks`)
  create(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Body() body: unknown,
  ) {
    return this.service.create(project, run, body);
  }

  @Post(`${path}/tasks/:taskId/cancel`)
  cancel(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
  ) {
    return this.service.action(project, run, task, 'cancel');
  }

  @Post(`${path}/tasks/:taskId/retry`)
  retry(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
  ) {
    return this.service.action(project, run, task, 'retry');
  }

  @Get(`${path}/tasks/:taskId/content`)
  @RawResponse()
  async content(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('range') range: string | undefined,
    @Query('download') download: string | undefined,
    @Res() response: ServerResponse,
  ) {
    let file;
    try {
      file = await this.service.content(project, run, task, range);
    } catch (error) {
      if (error instanceof AssetRangeNotSatisfiableError)
        response.setHeader('content-range', `bytes */${error.sizeBytes}`);
      throw error;
    }
    response.statusCode = file.partial ? 206 : 200;
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-type', file.mimeType);
    response.setHeader('content-length', file.contentLength);
    response.setHeader(
      'content-disposition',
      fileContentDisposition(download === 'true' ? 'attachment' : 'inline', file.originalFileName),
    );
    if (file.partial)
      response.setHeader('content-range', `bytes ${file.start}-${file.end}/${file.sizeBytes}`);
    await pipeline(file.stream, response);
  }
}

@Injectable()
export class LocalReplaceWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const expected = localReplaceWorkerToken(this.config);
    const actual = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-worker-token'];
    if (
      this.config.get<boolean>('FISSION_LOCAL_REPLACE_ENABLED') !== true ||
      !expected ||
      typeof actual !== 'string' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new UnauthorizedException('局部替换 Worker token 无效');
    return true;
  }
}

@Controller('internal/workers/fission-local-replace/:projectId/:runId/tasks/:taskId')
@AuthAccess('independent')
@UseGuards(LocalReplaceWorkerGuard)
export class LocalReplaceWorkerController {
  constructor(
    @Inject(LocalReplaceService) private readonly service: LocalReplaceService,
    @Inject(LocalReplaceRepository) private readonly repository: LocalReplaceRepository,
  ) {}

  @Post('claim')
  @HttpCode(200)
  claim(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
  ) {
    return this.repository.claim(project, run, task);
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body?: { progress?: number },
  ) {
    const progress = body?.progress;
    if (progress !== undefined && (!Number.isInteger(progress) || progress < 0 || progress > 99))
      return validationError();
    return this.repository.heartbeat(project, run, task, token, progress);
  }

  private async streamFile(
    project: string,
    run: string,
    task: string,
    token: string,
    role: 'source' | 'target',
    response: ServerResponse,
  ) {
    const file = await this.service.workerFile(project, run, task, token, role);
    response.setHeader('content-type', file.mimeType);
    response.setHeader('content-length', file.contentLength);
    response.setHeader('cache-control', 'private, no-store');
    await pipeline(file.stream, response);
  }

  @Get('source')
  @RawResponse()
  source(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    return this.streamFile(project, run, task, token, 'source', response);
  }

  @Get('target')
  @RawResponse()
  target(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    return this.streamFile(project, run, task, token, 'target', response);
  }

  @Get('source-url')
  @Header('cache-control', 'no-store')
  sourceUrl(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
  ) {
    return this.service.sourceUrl(project, run, task, token);
  }

  @Post('provider/create')
  @HttpCode(200)
  reserve(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    let sourceProbe;
    try {
      sourceProbe = parseLocalReplaceSourceProbe(body);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return validationError();
    }
    return this.repository.reserve(project, run, task, token, sourceProbe);
  }

  @Put('provider/task')
  bind(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: { providerTaskId?: unknown },
  ) {
    const id = body?.providerTaskId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return validationError();
    return this.repository.bindProvider(project, run, task, token, id);
  }

  @Put('result')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fields: 0, fileSize: LOCAL_REPLACE_LIMITS.maxOutputBytes },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  result(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @UploadedFile() file?: UploadedAssetFile,
  ) {
    return this.service.uploadResult(project, run, task, token, file);
  }

  @Post('fail')
  @HttpCode(200)
  fail(
    @Param('projectId', uuid()) project: string,
    @Param('runId', uuid()) run: string,
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: { retryable?: unknown; code?: unknown },
  ) {
    if (
      typeof body?.retryable !== 'boolean' ||
      typeof body.code !== 'string' ||
      !workerFailureCodes.has(body.code)
    )
      return validationError();
    return this.repository.fail(project, run, task, token, body.retryable, body.code);
  }
}
