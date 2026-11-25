import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseAvatarConfirmRequest,
  parseAvatarSaveDraftRequest,
  type AvatarAssetRef,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { AssetService } from '../../../platform/asset/asset.service';
import { AvatarRepository } from './avatar.repository';

function validate<T>(parse: (value: unknown) => T, body: unknown): T {
  try {
    return parse(body);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiHttpException(error.message, 400, 'VALIDATION_ERROR');
  }
}

@Injectable()
export class AvatarService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AvatarRepository) private readonly repository: AvatarRepository,
    @Inject(AssetService) private readonly assets: AssetService,
  ) {}

  private assertEnabled() {
    if (this.config.get<boolean>('FISSION_AVATAR_ENABLED') !== true)
      throw new ApiHttpException('数字人口播正式工作台暂未启用', 503, 'INTERNAL_ERROR');
  }

  initialize(projectId: string, expectedWorkflowRunId?: string) {
    this.assertEnabled();
    return this.repository.initialize(projectId, expectedWorkflowRunId);
  }

  workspace(projectId: string, workflowRunId: string) {
    this.assertEnabled();
    return this.repository.workspace({ projectId, workflowRunId });
  }

  saveDraft(projectId: string, workflowRunId: string, body: unknown) {
    this.assertEnabled();
    return this.repository.saveDraft(
      { projectId, workflowRunId },
      validate(parseAvatarSaveDraftRequest, body),
    );
  }

  confirmBinding(projectId: string, workflowRunId: string, body: unknown) {
    this.assertEnabled();
    const { expectedRevision } = validate(parseAvatarConfirmRequest, body);
    return this.repository.confirmBinding({ projectId, workflowRunId }, expectedRevision);
  }

  confirmScript(projectId: string, workflowRunId: string, body: unknown) {
    this.assertEnabled();
    const { expectedRevision } = validate(parseAvatarConfirmRequest, body);
    return this.repository.confirmScript({ projectId, workflowRunId }, expectedRevision);
  }

  async preview(projectId: string, workflowRunId: string, ref: AvatarAssetRef, range?: string) {
    this.assertEnabled();
    if (!Number.isSafeInteger(ref.version) || ref.version < 1 || ref.version > 2_147_483_647)
      throw new ApiHttpException('素材版本无效', 400, 'VALIDATION_ERROR');
    await this.repository.assertPreview({ projectId, workflowRunId }, ref);
    return this.assets.content(projectId, ref.assetId, range, ref.version);
  }
}
