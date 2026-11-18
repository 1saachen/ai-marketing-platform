import type { ConfigService } from '@nestjs/config';

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
