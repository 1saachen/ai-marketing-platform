import { createReadStream } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CLONE_GENERATION_LIMITS,
  parseCloneArtifactRef,
  parseCloneGenerationCreateRequest,
  parseCloneGenerationRenderCheckpoint,
  parseCloneGenerationReview,
  parseCloneGenerationVariantDraft,
  parseCloneGenerationVariantReview,
  parseCloneTaskFailRequest,
  parseCloneTaskProgressRequest,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { AssetService, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { ProjectService } from '../../../platform/project/project.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { CloneGenerationRepository, cloneArchiveOperationKey } from './clone-generation.repository';
import { CloneTaskRepository } from './clone-task.repository';
import { CloneService } from './clone.service';
import { cloneGenerationConfigured } from './clone-generation-config';
import { cloneConflict } from './clone-task-scope';
import { inspectGenerationFile } from './clone-generation-media';
import { streamCloneBatch } from './clone-generation-export';

const parse = <T>(parser: (input: unknown) => T, value: unknown): T => {
  try {
    return parser(value);
  } catch {
    throw new ApiHttpException('成片请求格式无效或超出当前能力', 400, 'VALIDATION_ERROR');
  }
};

@Injectable()
export class CloneGenerationService {
  constructor(
    @Inject(CloneGenerationRepository) private readonly repository: CloneGenerationRepository,
    @Inject(CloneTaskRepository) private readonly tasks: CloneTaskRepository,
    @Inject(CloneService) private readonly clone: CloneService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(AssetService) private readonly assets: AssetService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private async access(projectId: string) {
    if (!this.clone.capabilities().mappingEnabled)
      throw new ApiHttpException('复刻映射尚未启用', 503, 'CLONE_CAPABILITY_UNAVAILABLE');
    await this.projects.get(projectId);
  }

  private configured() {
    const models = cloneGenerationConfigured(this.config);
    if (!this.clone.capabilities().generationEnabled || !models)
      throw new ApiHttpException(
        '成片生成服务尚未启用或配置不完整',
        503,
        'CLONE_CAPABILITY_UNAVAILABLE',
      );
    return models;
  }

  async create(p: string, r: string, body: unknown) {
    await this.access(p);
    const models = this.configured();
    try {
      return await this.repository.create(
        p,
        r,
        parse(parseCloneGenerationCreateRequest, body),
        models,
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new ApiHttpException(error.message, 400, 'VALIDATION_ERROR');
      throw error;
    }
  }

  async list(p: string, r: string, page: number) {
    await this.access(p);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
      throw new ApiHttpException('成片页码无效', 400, 'VALIDATION_ERROR');
    return {
      ...(await this.repository.list(p, r, page, 6)),
      maxCount: cloneGenerationConfigured(this.config)?.planningModel
        ? CLONE_GENERATION_LIMITS.maxCount
        : CLONE_GENERATION_LIMITS.maxUnplannedCount,
    };
  }

  async batchExport(p: string, r: string, batchId: string, revision: number, hash: string) {
    await this.access(p);
    if (!Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(hash))
      throw new ApiHttpException('成片批次版本无效', 400, 'VALIDATION_ERROR');
    return streamCloneBatch(
      this.storage,
      await this.repository.batchExport(p, r, batchId, revision, hash),
    );
  }

  async taskAction(p: string, r: string, task: string, action: 'cancel' | 'retry') {
    await this.access(p);
    if (action === 'retry') this.configured();
    await this.tasks[action](p, r, task, 'all');
    return { accepted: true };
  }

  async archive(p: string, r: string, task: string, body: unknown) {
    await this.access(p);
    const { artifact, variantId, plan } = await this.repository.archiveSource(
      p,
      r,
      task,
      parse(parseCloneArtifactRef, body),
    );
    const archived = await this.assets.storeWorkflowFile(p, {
      name: artifact.name,
      directory: 'FINAL_VIDEOS',
      type: 'FINAL_VIDEO',
      originalFileName: artifact.originalFileName!,
      mimeType: artifact.mimeType!,
      sizeBytes: artifact.sizeBytes!,
      sourceStorageKey: artifact.storageKey!,
      workflow: 'FISSION',
      space: 'FISSION_CLONE',
      idempotencyKey: `clone-final:${r}:${variantId}`,
      operationKey: cloneArchiveOperationKey(artifact),
      sourceArtifactId: artifact.id,
      sourceNode: 'CLONE_GENERATION',
      businessData: { sources: plan.sources, workflowRunId: r, variantId, ratio: plan.ratio },
    });
    return { assetId: archived.asset.id };
  }

  claim(p: string, task: string) {
    this.configured();
    return this.repository.claim(p, task);
  }
  heartbeat(p: string, task: string, token: string) {
    return this.tasks.heartbeat(p, task, token, 'all');
  }
  progress(p: string, task: string, token: string, body: unknown) {
    return this.tasks.progress(p, task, token, parse(parseCloneTaskProgressRequest, body), 'all');
  }
  render(p: string, task: string, token: string, index: number, body: unknown) {
    return this.repository.saveRender(
      p,
      task,
      token,
      index,
      parse(parseCloneGenerationRenderCheckpoint, body),
    );
  }
  review(p: string, task: string, token: string, body: unknown) {
    return this.repository.saveReview(p, task, token, parse(parseCloneGenerationReview, body));
  }
  private async validatePlanning(callback: () => Promise<{ accepted: boolean }>) {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof TypeError)
        throw new ApiHttpException(error.message, 400, 'VALIDATION_ERROR');
      throw error;
    }
  }
  planDraft(p: string, task: string, token: string, body: unknown) {
    const draft = parse(parseCloneGenerationVariantDraft, body);
    return this.validatePlanning(() => this.repository.saveVariantDraft(p, task, token, draft));
  }
  planReview(p: string, task: string, token: string, body: unknown) {
    const review = parse(parseCloneGenerationVariantReview, body);
    return this.validatePlanning(() => this.repository.saveVariantReview(p, task, token, review));
  }
  planComplete(p: string, task: string, token: string) {
    return this.validatePlanning(() => this.repository.completePlanning(p, task, token));
  }
  complete(p: string, task: string, token: string) {
    return this.repository.complete(p, task, token);
  }
  fail(p: string, task: string, token: string, body: unknown) {
    const failure = parse(parseCloneTaskFailRequest, body);
    const reasons: Record<string, string> = {
      QUALITY_BLOCKED: '成片审片未通过或证据不足，请检查商品素材与映射',
      MEDIA_INVALID: '生成镜头或成片未通过媒体校验',
      PROVIDER_FAILED: '生成或审片服务未完成，请检查服务状态',
      PLANNING_BLOCKED: '未能在已确认的场景变化范围内形成足够差异，请检查元素映射',
      PLANNING_FAILED: '批次规划服务未完成，请检查服务状态',
    };
    const reason = Object.hasOwn(reasons, failure.code) ? reasons[failure.code] : undefined;
    return this.tasks.fail(p, task, token, failure.retryable, 'all', reason);
  }
  async source(p: string, task: string, token: string, fileId: string) {
    const file = await this.tasks.sourceFile(p, task, token, fileId, true);
    return this.storage.open(file.storageKey);
  }

  async upload(p: string, task: string, token: string, slot: string, file?: UploadedAssetFile) {
    if (!file) throw new ApiHttpException('缺少镜头或成片文件', 400, 'FILE_REQUIRED');
    const { existing, snapshot } = await this.repository.fileAdmission(p, task, token, slot);
    const sha256 = await inspectGenerationFile(this.config, file, snapshot.plan, slot);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.sizeBytes !== file.size)
        cloneConflict('已有不同的媒体检查点');
      return existing;
    }
    const project = await this.projects.get(p);
    const originalFileName = slot === 'final' ? '复刻成片.mp4' : `镜头-${Number(slot) + 1}.mp4`;
    const stored = await this.storage.put({
      projectId: p,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: 'video/mp4',
      keyContext: {
        projectName: project.name,
        workflow: 'FISSION',
        lifecycle: 'staging',
        category: `clone-generation-${task}`,
        originalFileName,
      },
    });
    let bound = false;
    try {
      const result = await this.repository.saveFile(p, task, token, slot, {
        nodeId: 'CLONE_GENERATION',
        originalFileName,
        mimeType: 'video/mp4',
        storageKey: stored.key,
        sizeBytes: stored.sizeBytes,
        sha256,
      });
      bound = result.inserted;
      return result.file;
    } finally {
      if (!bound)
        await this.working
          .enqueueCleanup(p, stored.key, 'CLONE_UNBOUND_GENERATION')
          .catch(() => undefined);
    }
  }
}
