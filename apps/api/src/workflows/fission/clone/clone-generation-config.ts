import type { ConfigService } from '@nestjs/config';
import { ApiHttpException } from '../../../common/api-http-exception';
import type { StoragePort } from '../../../platform/file/storage.port';

export const canSignCloneSourceVideo = (config: ConfigService, storage: StoragePort) =>
  config.get<string>('STORAGE_DRIVER') === 'tos' && typeof storage.signedReadUrl === 'function';

export function assertCloneShotReferenceStorage(available: boolean) {
  if (!available)
    throw new ApiHttpException(
      '逐镜头视频参考需要已配置的私有 TOS 存储',
      503,
      'CLONE_CAPABILITY_UNAVAILABLE',
    );
}

export function cloneGenerationConfigured(config: ConfigService) {
  const token = config.get<string>('FISSION_CLONE_GENERATION_WORKER_TOKEN');
  const model = config.get<string>('FISSION_CLONE_GENERATION_MODEL');
  const reviewModel = config.get<string>('FISSION_CLONE_REVIEW_MODEL');
  const planningModel = config.get<string>('FISSION_CLONE_PLANNING_MODEL');
  if (
    config.get<boolean>('FISSION_CLONE_G3_ENABLED') &&
    token &&
    token !== config.get<string>('FISSION_CLONE_ANALYSIS_WORKER_TOKEN') &&
    model &&
    reviewModel
  )
    return { model, reviewModel, ...(planningModel && { planningModel }) };
  return null;
}
