import { Module } from '@nestjs/common';
import { AssetModule } from '../../../platform/asset/asset.module';
import { FileModule } from '../../../platform/file/file.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import {
  AvatarRenderController,
  AvatarRenderReviewController,
  AvatarRenderReviewGuard,
  AvatarRenderWorkerController,
} from './avatar-render.controller';
import { AvatarRenderRepository } from './avatar-render.repository';
import { AvatarRenderService } from './avatar-render.service';
import {
  AvatarSyncController,
  AvatarSyncWorkerController,
  AvatarSyncWorkerGuard,
} from './avatar-sync.controller';
import { AvatarSyncRepository } from './avatar-sync.repository';
import { AvatarSyncService } from './avatar-sync.service';
import { AvatarController } from './avatar.controller';
import { AvatarRepository } from './avatar.repository';
import { AvatarService } from './avatar.service';

@Module({
  imports: [AssetModule, FileModule, WorkflowModule],
  controllers: [
    AvatarController,
    AvatarSyncController,
    AvatarSyncWorkerController,
    AvatarRenderController,
    AvatarRenderWorkerController,
    AvatarRenderReviewController,
  ],
  providers: [
    AvatarRepository,
    AvatarService,
    AvatarSyncRepository,
    AvatarSyncService,
    AvatarSyncWorkerGuard,
    AvatarRenderRepository,
    AvatarRenderService,
    AvatarRenderReviewGuard,
  ],
})
export class AvatarModule {}
