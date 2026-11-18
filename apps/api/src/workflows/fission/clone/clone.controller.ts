import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parseCloneImportAssetRequest, FISSION_CLONE_INPUT_LIMITS } from '@ai-marketing/contracts';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { ApiHttpException } from '../../../common/api-http-exception';
import { CloneService } from './clone.service';
import { CloneUploadInterceptor, type CloneUploadRequest } from './clone-upload.interceptor';

const uuid = () => new ParseUUIDPipe({ version: '4' });
@Controller('projects/:projectId')
export class CloneController {
  constructor(@Inject(CloneService) private readonly service: CloneService) {}
  @Post('workflow-runs/fission-clone/draft')
  initialize(@Param('projectId', uuid()) p: string) {
    return this.service.initialize(p);
  }
  @Get('workflow-runs/:runId/fission-clone/workspace')
  workspace(@Param('projectId', uuid()) p: string, @Param('runId', uuid()) r: string) {
    return this.service.workspace(p, r);
  }
  @Get('workflow-runs/:runId/fission-clone/capabilities')
  async capabilities(@Param('projectId', uuid()) p: string, @Param('runId', uuid()) r: string) {
    return (await this.service.workspace(p, r)).capabilities;
  }
  @Post('workflow-runs/:runId/fission-clone/uploads')
  @UseInterceptors(
    CloneUploadInterceptor,
    FileInterceptor('file', {
      limits: { files: 1, fileSize: FISSION_CLONE_INPUT_LIMITS.maxReferenceBytes },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Req() request: CloneUploadRequest,
    @Body() body: { role?: unknown },
    @UploadedFile() file?: UploadedAssetFile,
  ) {
    if (!request.cloneUpload) throw new ApiHttpException('上传尚未初始化', 409, 'CONFLICT');
    return this.service.upload(p, r, request.cloneUpload, body?.role, file);
  }
  @Post('workflow-runs/:runId/fission-clone/assets')
  importAsset(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() body: Record<string, unknown>,
  ) {
    let request;
    try {
      request = parseCloneImportAssetRequest(body);
    } catch {
      throw new ApiHttpException('资产版本引用无效', 400, 'VALIDATION_ERROR');
    }
    return this.service.importAsset(p, r, request);
  }
  @Delete('workflow-runs/:runId/fission-clone/uploads/:uploadId')
  remove(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('uploadId', uuid()) id: string,
  ) {
    return this.service.remove(p, r, id);
  }
  @Post('workflow-runs/:runId/fission-clone/input/confirm')
  confirm(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() body: unknown,
  ) {
    return this.service.confirm(p, r, body);
  }
}
