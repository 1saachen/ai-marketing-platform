import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { CloneTaskService } from './clone-task.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });
@Controller('projects/:projectId/workflow-runs/:runId/fission-clone')
export class CloneTaskController {
  constructor(@Inject(CloneTaskService) private readonly service: CloneTaskService) {}
  @Post('generation/preflight') preflightGeneration(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.preflightGeneration(p, r, b);
  }
  @Post('analysis/tasks') createAnalysis(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.create(p, r, 'ANALYZE', b);
  }
  @Put('analysis/draft') saveAnalysis(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.saveAnalysis(p, r, b);
  }
  @Post('analysis/confirm') confirmAnalysis(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.confirmAnalysis(p, r, b);
  }
  @Post('mapping/tasks') createMapping(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.create(p, r, 'MAP_SUGGEST', b);
  }
  @Post('mapping/confirm') confirmMapping(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.confirmMapping(p, r, b);
  }
  @Post('mapping/assets') prepareMappingAsset(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Body() b: unknown,
  ) {
    return this.service.prepareMappingAsset(p, r, b);
  }
  @Post('mapping/suggestions/:taskId/adopt') adopt(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) t: string,
    @Body() b: unknown,
  ) {
    return this.service.adopt(p, r, t, b);
  }
  @Get('tasks/:taskId') task(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) t: string,
  ) {
    return this.service.task(p, r, t);
  }
  @Post('tasks/:taskId/cancel') cancel(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) t: string,
  ) {
    return this.service.cancel(p, r, t);
  }
  @Post('tasks/:taskId/retry') retry(
    @Param('projectId', uuid()) p: string,
    @Param('runId', uuid()) r: string,
    @Param('taskId', uuid()) t: string,
  ) {
    return this.service.retry(p, r, t);
  }
}
