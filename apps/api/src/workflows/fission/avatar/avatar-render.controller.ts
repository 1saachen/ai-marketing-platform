import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  AVATAR_LONG_LIMITS,
  parseAvatarRenderFailure,
  parseAvatarRenderHeartbeat,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { RawResponse } from '../../../common/raw-response.decorator';
import { AssetRangeNotSatisfiableError } from '../../../platform/asset/asset.service';
import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
import { fileContentDisposition } from '../../../platform/file/content-disposition';
import type { StoredStream } from '../../../platform/file/storage.port';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { AvatarRenderRepository } from './avatar-render.repository';
import {
  avatarRenderBody,
  AvatarRenderService,
  avatarRenderReviewToken,
  type RenderUpload,
} from './avatar-render.service';
import { AvatarSyncWorkerGuard } from './avatar-sync.controller';

const uuid = () => new ParseUUIDPipe({ version: '4' });

async function sendMedia(
  response: ServerResponse,
  media: StoredStream & { mimeType: string; partial: boolean },
  options?: { fileName: string; attachment?: boolean },
) {
  response.statusCode = media.partial ? 206 : 200;
  response.setHeader('content-type', media.mimeType);
  response.setHeader('content-length', String(media.contentLength));
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (media.mimeType === 'video/mp4') response.setHeader('accept-ranges', 'bytes');
  if (options)
    response.setHeader(
      'content-disposition',
      fileContentDisposition(options.attachment ? 'attachment' : 'inline', options.fileName),
    );
  if (media.partial)
    response.setHeader('content-range', `bytes ${media.start}-${media.end}/${media.sizeBytes}`);
  await pipeline(media.stream, response);
}

@Controller('projects/:projectId/workflow-runs/:runId/fission-avatar/render')
export class AvatarRenderController {
  constructor(@Inject(AvatarRenderService) private readonly service: AvatarRenderService) {}

  @Get()
  workspace(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
  ) {
    return this.service.workspace({ projectId, workflowRunId });
  }

  @Put('draft')
  saveDraft(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Body() body: unknown,
  ) {
    return this.service.saveDraft({ projectId, workflowRunId }, body);
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Body() body: unknown,
  ) {
    return this.service.confirm({ projectId, workflowRunId }, body);
  }

  @Post('tasks')
  @HttpCode(200)
  create(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Body() body: unknown,
  ) {
    return this.service.create({ projectId, workflowRunId }, body);
  }

  @Post('tasks/:taskId/cancel')
  @HttpCode(200)
  cancel(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
  ) {
    return this.service.action({ projectId, workflowRunId }, id, 'cancel');
  }

  @Post('tasks/:taskId/retry')
  @HttpCode(200)
  retry(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
  ) {
    return this.service.action({ projectId, workflowRunId }, id, 'retry');
  }

  @Get('outputs/:revision/:role')
  @RawResponse()
  async content(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('revision', ParseIntPipe) revision: number,
    @Param('role') role: string,
    @Headers('range') range: string | undefined,
    @Query('download') download: string | undefined,
    @Res() response: ServerResponse,
  ) {
    if (
      revision < 1 ||
      !Number.isSafeInteger(revision) ||
      revision > 2_147_483_647 ||
      (role !== 'video' && role !== 'subtitles')
    )
      throw new ApiHttpException('成片文件不存在', 404, 'ASSET_NOT_FOUND');
    let content;
    try {
      content = await this.service.output({ projectId, workflowRunId }, revision, role, range);
    } catch (error) {
      if (error instanceof AssetRangeNotSatisfiableError)
        response.setHeader('content-range', `bytes */${error.sizeBytes}`);
      throw error;
    }
    return sendMedia(response, content, {
      fileName: content.originalFileName,
      attachment: role === 'subtitles' || download === '1' || download === 'true',
    });
  }

  @Post('outputs/:revision/archive')
  @HttpCode(200)
  archive(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('revision', ParseIntPipe) revision: number,
  ) {
    if (revision < 1 || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
      throw new ApiHttpException('成片版本不存在', 404, 'ASSET_NOT_FOUND');
    return this.service.archive({ projectId, workflowRunId }, revision);
  }
}

const workerRoute = 'internal/workers/fission-avatar/:projectId/:runId/render/tasks/:taskId';

@Controller(workerRoute)
@AuthAccess('independent')
@UseGuards(AvatarSyncWorkerGuard)
export class AvatarRenderWorkerController {
  constructor(
    @Inject(AvatarRenderService) private readonly service: AvatarRenderService,
    @Inject(AvatarRenderRepository) private readonly repository: AvatarRenderRepository,
  ) {}

  @Post('claim')
  @HttpCode(200)
  claim(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
  ) {
    return this.repository.claim({ projectId, workflowRunId }, id);
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.heartbeat(
      { projectId, workflowRunId },
      id,
      token,
      avatarRenderBody(parseAvatarRenderHeartbeat, body),
    );
  }

  @Get('files/:role')
  @RawResponse()
  async file(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Param('role') role: string,
    @Res() response: ServerResponse,
  ) {
    if (role !== 'video' && role !== 'audio' && role !== 'background')
      throw new ApiHttpException('渲染输入文件不存在', 404, 'ASSET_NOT_FOUND');
    return sendMedia(
      response,
      await this.service.source({ projectId, workflowRunId }, id, token, role),
    );
  }

  @Put('result')
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        files: 2,
        fields: 1,
        parts: 4,
        fieldSize: 4096,
        fileSize: AVATAR_LONG_LIMITS.maxVideoBytes,
      },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  result(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @UploadedFiles() files: RenderUpload[] | undefined,
    @Body('metadata') metadata: unknown,
  ) {
    return this.service.complete({ projectId, workflowRunId }, id, token, files ?? [], metadata);
  }

  @Post('fail')
  @HttpCode(200)
  fail(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.fail(
      { projectId, workflowRunId },
      id,
      token,
      avatarRenderBody(parseAvatarRenderFailure, body),
    );
  }
}

@Injectable()
export class AvatarRenderReviewGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const expected = avatarRenderReviewToken(this.config);
    const actual = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-review-token'];
    if (
      this.config.get<boolean>('FISSION_AVATAR_ENABLED') !== true ||
      !expected ||
      typeof actual !== 'string' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new UnauthorizedException('成片验收凭据无效');
    return true;
  }
}

@Controller(workerRoute)
@AuthAccess('independent')
@UseGuards(AvatarRenderReviewGuard)
export class AvatarRenderReviewController {
  constructor(@Inject(AvatarRenderService) private readonly service: AvatarRenderService) {}

  @Get('candidate')
  @RawResponse()
  async candidate(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
    @Res() response: ServerResponse,
  ) {
    const file = await this.service.candidate({ projectId, workflowRunId }, id);
    response.setHeader('x-content-sha256', file.sha256);
    return sendMedia(response, file, { fileName: file.originalFileName, attachment: true });
  }

  @Post('review')
  @HttpCode(200)
  review(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
    @Body() body: unknown,
  ) {
    return this.service.review({ projectId, workflowRunId }, id, body);
  }

  @Get('candidate/timeline')
  timeline(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) id: string,
  ) {
    return this.service.candidateTimeline({ projectId, workflowRunId }, id);
  }
}
