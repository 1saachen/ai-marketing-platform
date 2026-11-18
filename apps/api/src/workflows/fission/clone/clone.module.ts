import { Module } from '@nestjs/common';
import { FileModule } from '../../../platform/file/file.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { AssetModule } from '../../../platform/asset/asset.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { CloneController } from './clone.controller';
import { CloneRepository } from './clone.repository';
import { CloneService } from './clone.service';
import { CloneMediaService } from './clone-media.service';
import { CloneUploadInterceptor } from './clone-upload.interceptor';
import { CloneTaskRepository } from './clone-task.repository';
import { CloneTaskService } from './clone-task.service';
import { CloneTaskController } from './clone-task.controller';
import { CloneWorkerController, CloneWorkerGuard } from './clone-worker.controller';
import {
  CloneGenerationController,
  CloneGenerationWorkerController,
  CloneGenerationWorkerGuard,
} from './clone-generation.controller';
import { CloneGenerationService } from './clone-generation.service';
import { CloneGenerationRepository } from './clone-generation.repository';

@Module({
  imports: [FileModule, ProjectModule, AssetModule, WorkflowModule],
  controllers: [
    CloneController,
    CloneTaskController,
    CloneWorkerController,
    CloneGenerationController,
    CloneGenerationWorkerController,
  ],
  providers: [
    CloneRepository,
    CloneService,
    CloneMediaService,
    CloneUploadInterceptor,
    CloneTaskRepository,
    CloneTaskService,
    CloneWorkerGuard,
    CloneGenerationWorkerGuard,
    CloneGenerationService,
    CloneGenerationRepository,
  ],
})
export class CloneModule {}
