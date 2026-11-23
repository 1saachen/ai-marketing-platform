import { Module } from '@nestjs/common';
import { FileModule } from '../../../platform/file/file.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import {
  LocalReplaceController,
  LocalReplaceWorkerController,
  LocalReplaceWorkerGuard,
} from './local-replace.controller';
import { LocalReplaceRepository } from './local-replace.repository';
import { LocalReplaceService } from './local-replace.service';

@Module({
  imports: [FileModule, ProjectModule, WorkflowModule],
  controllers: [LocalReplaceController, LocalReplaceWorkerController],
  providers: [LocalReplaceRepository, LocalReplaceService, LocalReplaceWorkerGuard],
})
export class LocalReplaceModule {}
