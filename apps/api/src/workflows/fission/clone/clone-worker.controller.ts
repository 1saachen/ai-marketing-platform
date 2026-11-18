import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLONE_UUID_PATTERN } from '@ai-marketing/contracts';
import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
import { RawResponse } from '../../../common/raw-response.decorator';
import { ApiHttpException } from '../../../common/api-http-exception';
import { CloneTaskService } from './clone-task.service';

@Injectable()
export class CloneWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const expected = this.config.get<string>('FISSION_CLONE_ANALYSIS_WORKER_TOKEN');
    const actual = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-worker-token'];
    if (
      !expected ||
      typeof actual !== 'string' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new UnauthorizedException('Worker token 无效');
    return true;
  }
}
const uuid = () => new ParseUUIDPipe({ version: '4' });
export function envelope(value: unknown, empty = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiHttpException('内部请求格式不正确', 400, 'VALIDATION_ERROR');
  const { projectId, ...body } = value as Record<string, unknown>;
  if (
    typeof projectId !== 'string' ||
    !new RegExp(CLONE_UUID_PATTERN).test(projectId) ||
    (empty && Object.keys(body).length)
  )
    throw new ApiHttpException('内部项目作用域无效', 400, 'VALIDATION_ERROR');
  return { projectId, body };
}
@Controller('internal/workers/fission-clone-analysis/tasks')
@AuthAccess('independent')
@UseGuards(CloneWorkerGuard)
export class CloneWorkerController {
  constructor(@Inject(CloneTaskService) private readonly service: CloneTaskService) {}
  @Post(':taskId/claim') claim(@Param('taskId', uuid()) id: string, @Body() b: unknown) {
    const e = envelope(b, true);
    return this.service.claim(e.projectId, id);
  }
  @Post(':taskId/heartbeat') heartbeat(
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: unknown,
  ) {
    const e = envelope(b, true);
    return this.service.heartbeat(e.projectId, id, token);
  }
  @Put(':taskId/progress') progress(
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: unknown,
  ) {
    const e = envelope(b);
    return this.service.progress(e.projectId, id, token, e.body);
  }
  @Put(':taskId/checkpoints') checkpoint(
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: unknown,
  ) {
    const e = envelope(b);
    return this.service.checkpoint(e.projectId, id, token, e.body);
  }
  @Post(':taskId/complete') complete(
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: unknown,
  ) {
    const e = envelope(b);
    return this.service.complete(e.projectId, id, token, e.body);
  }
  @Post(':taskId/fail') fail(
    @Param('taskId', uuid()) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: unknown,
  ) {
    const e = envelope(b);
    return this.service.fail(e.projectId, id, token, e.body);
  }
  @Get(':taskId/files/:fileId/content')
  @RawResponse()
  async source(
    @Param('taskId', uuid()) id: string,
    @Param('fileId', uuid()) file: string,
    @Query('projectId', uuid()) projectId: string,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    const content = await this.service.source(projectId, id, token, file);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', content.contentLength);
    response.setHeader('Cache-Control', 'no-store');
    await pipeline(content.stream, response);
  }
}
