import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { RawResponse } from '../../../common/raw-response.decorator';
import { AssetRangeNotSatisfiableError } from '../../../platform/asset/asset.service';
import { fileContentDisposition } from '../../../platform/file/content-disposition';
import { AvatarService } from './avatar.service';

const path = 'workflow-runs/:runId/fission-avatar';
const uuid = () => new ParseUUIDPipe({ version: '4' });

@Controller('projects/:projectId')
export class AvatarController {
  constructor(@Inject(AvatarService) private readonly service: AvatarService) {}

  @Post('fission-avatar/workspace')
  @HttpCode(200)
  initialize(
    @Param('projectId', uuid()) projectId: string,
    @Query('expectedWorkflowRunId', new ParseUUIDPipe({ version: '4', optional: true }))
    expectedWorkflowRunId?: string,
  ) {
    return this.service.initialize(projectId, expectedWorkflowRunId);
  }

  @Get(`${path}/workspace`)
  workspace(@Param('projectId', uuid()) projectId: string, @Param('runId', uuid()) runId: string) {
    return this.service.workspace(projectId, runId);
  }

  @Put(`${path}/draft`)
  saveDraft(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) runId: string,
    @Body() body: unknown,
  ) {
    return this.service.saveDraft(projectId, runId, body);
  }

  @Post(`${path}/confirm-binding`)
  @HttpCode(200)
  confirmBinding(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) runId: string,
    @Body() body: unknown,
  ) {
    return this.service.confirmBinding(projectId, runId, body);
  }

  @Post(`${path}/confirm-script`)
  @HttpCode(200)
  confirmScript(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) runId: string,
    @Body() body: unknown,
  ) {
    return this.service.confirmScript(projectId, runId, body);
  }

  @Get(`${path}/assets/:assetId/versions/:version/content`)
  @RawResponse()
  async preview(
    @Param('projectId', uuid()) projectId: string,
    @Param('runId', uuid()) runId: string,
    @Param('assetId', uuid()) assetId: string,
    @Param('version', ParseIntPipe) version: number,
    @Headers('range') range: string | undefined,
    @Res() response: ServerResponse,
  ) {
    let content;
    try {
      content = await this.service.preview(projectId, runId, { assetId, version }, range);
    } catch (error) {
      if (error instanceof AssetRangeNotSatisfiableError) {
        response.setHeader('content-range', `bytes */${error.sizeBytes}`);
        response.statusCode = 416;
      }
      throw error;
    }
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition('inline', content.originalFileName),
    );
    response.setHeader('accept-ranges', content.previewKind === 'IMAGE' ? 'none' : 'bytes');
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
