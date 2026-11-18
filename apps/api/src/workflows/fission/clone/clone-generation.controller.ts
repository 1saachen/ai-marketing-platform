import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  Inject,
  Injectable,
  Param,
  ParseIntPipe,
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
import { CLONE_GENERATION_MAX_FILE_BYTES } from '@ai-marketing/contracts';
import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
import { RawResponse } from '../../../common/raw-response.decorator';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { envelope } from './clone-worker.controller';
import { CloneGenerationService } from './clone-generation.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

@Controller('projects/:projectId/workflow-runs/:runId/fission-clone/generation')
export class CloneGenerationController {
  constructor(@Inject(CloneGenerationService) private readonly service: CloneGenerationService) {}
  @Get('tasks')
  list(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.service.list(p, r, page);
  }
  @Post('tasks')
  create(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() body: unknown,
  ) {
    return this.service.create(p, r, body);
  }
  @Post('tasks/:taskId/cancel')
  cancel(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) task: string,
  ) {
    return this.service.taskAction(p, r, task, 'cancel');
  }
  @Post('tasks/:taskId/retry')
  retry(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) task: string,
  ) {
    return this.service.taskAction(p, r, task, 'retry');
  }
  @Post('tasks/:taskId/archive')
  archive(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) task: string,
    @Body() body: unknown,
  ) {
    return this.service.archive(p, r, task, body);
  }
  @RawResponse()
  @Get('batches/:batchId/export')
  async batchExport(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('batchId', uuid()) batchId: string,
    @Query('revision', ParseIntPipe) revision: number,
    @Query('hash') hash: string,
    @Res() response: ServerResponse,
  ) {
    const archive = await this.service.batchExport(p, r, batchId, revision, hash);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="clone-${batchId}.zip"`);
    response.setHeader('Cache-Control', 'private, no-store');
    const sending = pipeline(archive, response);
    void archive.finalize().catch((error: Error) => archive.destroy(error));
    await sending;
  }
}

@Injectable()
export class CloneGenerationWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const expected = this.config.get<string>('FISSION_CLONE_GENERATION_WORKER_TOKEN');
    const actual = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-worker-token'];
    if (
      !expected ||
      expected === this.config.get<string>('FISSION_CLONE_ANALYSIS_WORKER_TOKEN') ||
      typeof actual !== 'string' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new UnauthorizedException('成片 Worker token 无效');
    return true;
  }
}

@Controller('internal/workers/fission-clone-generation/tasks')
@AuthAccess('independent')
@UseGuards(CloneGenerationWorkerGuard)
export class CloneGenerationWorkerController {
  constructor(@Inject(CloneGenerationService) private readonly service: CloneGenerationService) {}
  @Post(':taskId/claim')
  claim(@Param('taskId', uuid()) task: string, @Body() body: unknown) {
    return this.service.claim(envelope(body, true).projectId, task);
  }
  @Post(':taskId/heartbeat')
  heartbeat(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.service.heartbeat(envelope(body, true).projectId, task, token);
  }
  @Put(':taskId/progress')
  progress(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    const e = envelope(body);
    return this.service.progress(e.projectId, task, token, e.body);
  }
  @Put(':taskId/render/:index')
  render(
    @Param('taskId', uuid()) task: string,
    @Param('index', ParseIntPipe) index: number,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    const e = envelope(body);
    return this.service.render(e.projectId, task, token, index, e.body);
  }
  @Put(':taskId/review')
  review(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    const e = envelope(body);
    return this.service.review(e.projectId, task, token, e.body);
  }
  @Put(':taskId/planning/draft')
  planDraft(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    const e = envelope(body);
    return this.service.planDraft(e.projectId, task, token, e.body);
  }
  @Put(':taskId/planning/review')
  planReview(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    const e = envelope(body);
    return this.service.planReview(e.projectId, task, token, e.body);
  }
  @Post(':taskId/planning/complete')
  planComplete(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.service.planComplete(envelope(body, true).projectId, task, token);
  }
  @Post(':taskId/complete')
  complete(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.service.complete(envelope(body, true).projectId, task, token);
  }
  @Post(':taskId/fail')
  fail(
    @Param('taskId', uuid()) task: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    const e = envelope(body);
    return this.service.fail(e.projectId, task, token, e.body);
  }
  @Post(':taskId/media/:slot')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fields: 0, fileSize: CLONE_GENERATION_MAX_FILE_BYTES },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('taskId', uuid()) task: string,
    @Param('slot') slot: string,
    @Query('projectId', uuid()) p: string,
    @Headers('x-attempt-token') token: string,
    @UploadedFile() file?: UploadedAssetFile,
  ) {
    return this.service.upload(p, task, token, slot, file);
  }
  @RawResponse()
  @Get(':taskId/files/:fileId/content')
  async source(
    @Param('taskId', uuid()) task: string,
    @Param('fileId', uuid()) file: string,
    @Query('projectId', uuid()) p: string,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    const content = await this.service.source(p, task, token, file);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', content.contentLength);
    response.setHeader('Cache-Control', 'no-store');
    await pipeline(content.stream, response);
  }
}
