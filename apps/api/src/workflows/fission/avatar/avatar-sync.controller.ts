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
  AVATAR_SYNC_LIMITS,
  parseAvatarSyncCheckpoint,
  parseAvatarSyncFailure,
  parseAvatarSyncHeartbeat,
  parseAvatarTailChainCheckpoint,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { RawResponse } from '../../../common/raw-response.decorator';
import {
  AssetRangeNotSatisfiableError,
  type UploadedAssetFile,
} from '../../../platform/asset/asset.service';
import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
import { fileContentDisposition } from '../../../platform/file/content-disposition';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { AvatarSyncRepository } from './avatar-sync.repository';
import { avatarSyncBody, AvatarSyncService, avatarWorkerToken } from './avatar-sync.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });
const segmentOrdinal = (ordinal: number) => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > AVATAR_LONG_LIMITS.maxSegments)
    throw new ApiHttpException('口播分段不存在', 404, 'ASSET_NOT_FOUND');
  return ordinal;
};

const syncResultUpload = (maxMetadataBytes: number, maxVideoBytes: number) =>
  AnyFilesInterceptor({
    limits: { files: 2, fields: 1, parts: 4, fieldSize: maxMetadataBytes, fileSize: maxVideoBytes },
  });

@Controller('projects/:projectId/workflow-runs/:runId/fission-avatar/sync')
export class AvatarSyncController {
  constructor(@Inject(AvatarSyncService) private readonly service: AvatarSyncService) {}

  @Get()
  workspace(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
  ) {
    return this.service.workspace({ projectId, workflowRunId });
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
    @Param('taskId', uuid()) taskId: string,
  ) {
    return this.service.action({ projectId, workflowRunId }, taskId, 'cancel');
  }

  @Post('tasks/:taskId/retry')
  @HttpCode(200)
  retry(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
  ) {
    return this.service.action({ projectId, workflowRunId }, taskId, 'retry');
  }

  @Get('results/:artifactId/:role')
  @RawResponse()
  async content(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('artifactId', uuid()) artifactId: string,
    @Param('role') role: string,
    @Query('revision', new ParseIntPipe({ optional: true })) revision: number | undefined,
    @Headers('range') range: string | undefined,
    @Res() response: ServerResponse,
  ) {
    if (role !== 'audio' && role !== 'video')
      throw new ApiHttpException('无效的媒体类型', 404, 'ASSET_NOT_FOUND');
    let content;
    try {
      content = await this.service.content(
        { projectId, workflowRunId },
        artifactId,
        role,
        revision,
        range,
      );
    } catch (error) {
      if (error instanceof AssetRangeNotSatisfiableError)
        response.setHeader('content-range', `bytes */${error.sizeBytes}`);
      throw error;
    }
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition('inline', content.originalFileName),
    );
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    if (content.partial)
      response.setHeader(
        'content-range',
        `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
      );
    await pipeline(content.stream, response);
  }
}

@Injectable()
export class AvatarSyncWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const expected = avatarWorkerToken(this.config);
    const actual = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-worker-token'];
    if (
      this.config.get<boolean>('FISSION_AVATAR_ENABLED') !== true ||
      !expected ||
      typeof actual !== 'string' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new UnauthorizedException('数字人口播 Worker token 无效');
    return true;
  }
}

@Controller('internal/workers/fission-avatar/:projectId/:runId/tasks/:taskId')
@AuthAccess('independent')
@UseGuards(AvatarSyncWorkerGuard)
export class AvatarSyncWorkerController {
  constructor(
    @Inject(AvatarSyncService) private readonly service: AvatarSyncService,
    @Inject(AvatarSyncRepository) private readonly repository: AvatarSyncRepository,
  ) {}

  @Post('claim')
  @HttpCode(200)
  claim(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
  ) {
    return this.repository.claim({ projectId, workflowRunId }, taskId);
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.heartbeat(
      { projectId, workflowRunId },
      taskId,
      token,
      avatarSyncBody(parseAvatarSyncHeartbeat, body),
    );
  }

  @Post('checkpoint')
  @HttpCode(200)
  checkpoint(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.checkpoint(
      { projectId, workflowRunId },
      taskId,
      token,
      avatarSyncBody(parseAvatarSyncCheckpoint, body),
    );
  }

  @Post('continuity/checkpoint')
  @HttpCode(200)
  continuityCheckpoint(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.continuityCheckpoint(
      { projectId, workflowRunId },
      taskId,
      token,
      avatarSyncBody(parseAvatarTailChainCheckpoint, body),
    );
  }

  @Get('character')
  @RawResponse()
  async character(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    const file = await this.service.source({ projectId, workflowRunId }, taskId, token);
    response.setHeader('content-type', 'video/mp4');
    response.setHeader('content-length', file.contentLength);
    response.setHeader('cache-control', 'private, no-store');
    await pipeline(file.stream, response);
  }

  @Put('result')
  @UseInterceptors(
    syncResultUpload(AVATAR_LONG_LIMITS.maxMetadataBytes, AVATAR_LONG_LIMITS.maxVideoBytes),
    UploadTemporaryFileCleanupInterceptor,
  )
  result(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Headers('x-attempt-token') token: string,
    @UploadedFiles() files: (UploadedAssetFile & { fieldname: string })[] | undefined,
    @Body('metadata') metadata: unknown,
  ) {
    return this.service.submitResult(
      { projectId, workflowRunId },
      taskId,
      token,
      files ?? [],
      metadata,
    );
  }

  @Post('segments/:ordinal/checkpoint')
  @HttpCode(200)
  segmentCheckpoint(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Param('ordinal', ParseIntPipe) ordinal: number,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.segmentCheckpoint(
      { projectId, workflowRunId },
      taskId,
      token,
      segmentOrdinal(ordinal),
      avatarSyncBody(parseAvatarSyncCheckpoint, body),
    );
  }

  @Get('segments/:ordinal/files/:role')
  @RawResponse()
  async segmentContent(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Param('ordinal', ParseIntPipe) ordinal: number,
    @Param('role') role: string,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    if (role !== 'audio' && role !== 'video')
      throw new ApiHttpException('无效的分段媒体类型', 404, 'ASSET_NOT_FOUND');
    const file = await this.service.segmentSource(
      { projectId, workflowRunId },
      taskId,
      token,
      segmentOrdinal(ordinal),
      role,
    );
    response.setHeader('content-type', file.mimeType);
    response.setHeader('content-length', file.contentLength);
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    await pipeline(file.stream, response);
  }

  @Put('segments/:ordinal/result')
  @UseInterceptors(
    syncResultUpload(128 * 1024, AVATAR_SYNC_LIMITS.maxVideoBytes),
    UploadTemporaryFileCleanupInterceptor,
  )
  segmentResult(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Param('ordinal', ParseIntPipe) ordinal: number,
    @Headers('x-attempt-token') token: string,
    @UploadedFiles() files: (UploadedAssetFile & { fieldname: string })[] | undefined,
    @Body('metadata') metadata: unknown,
  ) {
    return this.service.submitResult(
      { projectId, workflowRunId },
      taskId,
      token,
      files ?? [],
      metadata,
      segmentOrdinal(ordinal),
    );
  }

  @Post('fail')
  @HttpCode(200)
  fail(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) workflowRunId: string,
    @Param('taskId', uuid()) taskId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: unknown,
  ) {
    return this.repository.fail(
      { projectId, workflowRunId },
      taskId,
      token,
      avatarSyncBody(parseAvatarSyncFailure, body),
    );
  }
}
