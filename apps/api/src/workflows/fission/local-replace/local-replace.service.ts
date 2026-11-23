import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LOCAL_REPLACE_LIMITS,
  parseLocalReplaceDraftSaveRequest,
  parseLocalReplaceTaskCreateRequest,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { parseRangeHeader, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { inspectImportVideo } from '../../../platform/file/video-media';
import { ProjectService } from '../../../platform/project/project.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { LocalReplaceRepository } from './local-replace.repository';

const outputName = '局部元素替换成片.mp4';
const outputMime = 'video/mp4';
const otherWorkerTokens = [
  'FISSION_CLONE_ANALYSIS_WORKER_TOKEN',
  'FISSION_CLONE_GENERATION_WORKER_TOKEN',
  'EFFECT_EXTRACTION_WORKER_TOKEN',
  'EFFECT_PROMPT_WORKER_TOKEN',
  'EFFECT_SEGMENT_RENDER_WORKER_TOKEN',
  'EFFECT_TEMPLATE_MIX_WORKER_TOKEN',
  'CUSTOMIZED_EXTRACTION_WORKER_TOKEN',
  'CUSTOMIZED_STORYBOARD_WORKER_TOKEN',
  'CUSTOMIZED_ASSETS_WORKER_TOKEN',
  'CUSTOMIZED_PRODUCTION_WORKER_TOKEN',
];

export function localReplaceWorkerToken(config: ConfigService) {
  const token = config.get<string>('FISSION_LOCAL_REPLACE_WORKER_TOKEN');
  return token && !otherWorkerTokens.some((key) => config.get<string>(key) === token)
    ? token
    : undefined;
}

const parseRequest = <T>(parse: (value: unknown) => T, body: unknown): T => {
  try {
    return parse(body);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiHttpException(error.message, 400, 'VALIDATION_ERROR');
  }
};

@Injectable()
export class LocalReplaceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalReplaceService.name);
  private timer?: NodeJS.Timeout;
  private recovering = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(LocalReplaceRepository) private readonly repository: LocalReplaceRepository,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  onModuleInit() {
    if (this.config.get<boolean>('FISSION_LOCAL_REPLACE_ENABLED') !== true) return;
    this.timer = setInterval(() => void this.recover(), 20_000);
    this.timer.unref();
    void this.recover();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.repository.recoverExpired();
    } catch (error) {
      this.logger.warn(
        `局部替换租约回收失败（${error instanceof Error ? error.name : 'UNKNOWN'}）`,
      );
    } finally {
      this.recovering = false;
    }
  }

  private async access(projectId: string) {
    if (this.config.get<boolean>('FISSION_LOCAL_REPLACE_ENABLED') !== true)
      throw new ApiHttpException('局部元素替换暂未启用', 503, 'INTERNAL_ERROR');
    await this.projects.get(projectId);
  }

  async initialize(projectId: string) {
    await this.access(projectId);
    return this.repository.initialize(projectId);
  }

  async workspace(projectId: string, runId: string) {
    await this.access(projectId);
    return this.repository.workspace(projectId, runId);
  }

  async saveDraft(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    return this.repository.saveDraft(
      projectId,
      runId,
      parseRequest(parseLocalReplaceDraftSaveRequest, body),
    );
  }

  async create(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    const model = this.config.get<string>('FISSION_LOCAL_REPLACE_MODEL')?.trim();
    const workerToken = localReplaceWorkerToken(this.config);
    if (!model || model.length > 160 || !workerToken || !this.storage.signedReadUrl)
      throw new ApiHttpException(
        '请配置局部替换模型、独立 Worker 和私有 TOS 存储',
        503,
        'INTERNAL_ERROR',
      );
    return this.repository.create(
      projectId,
      runId,
      parseRequest(parseLocalReplaceTaskCreateRequest, body),
      model,
    );
  }

  async action(projectId: string, runId: string, taskId: string, action: 'cancel' | 'retry') {
    await this.access(projectId);
    return this.repository.action(projectId, runId, taskId, action);
  }

  async content(projectId: string, runId: string, taskId: string, rangeHeader?: string) {
    await this.access(projectId);
    const file = await this.repository.output(projectId, runId, taskId);
    const range = parseRangeHeader(rangeHeader, file.sizeBytes);
    const content = await this.storage.open(file.storageKey, range);
    if (content.sizeBytes !== file.sizeBytes) {
      content.stream.destroy();
      throw new ApiHttpException('成片文件不完整', 409, 'CONFLICT');
    }
    return {
      ...content,
      mimeType: file.mimeType,
      originalFileName: file.originalFileName,
      partial: !!range,
    };
  }

  async workerFile(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    role: 'source' | 'target',
  ) {
    const file = await this.repository.workerFile(projectId, runId, taskId, token, role);
    const bytes = await this.storage.open(file.storageKey);
    if (bytes.sizeBytes !== file.sizeBytes) {
      bytes.stream.destroy();
      throw new ApiHttpException('冻结素材文件大小已变化', 422, 'VALIDATION_ERROR');
    }
    return { ...bytes, mimeType: file.mimeType };
  }

  async sourceUrl(projectId: string, runId: string, taskId: string, token: string) {
    const file = await this.repository.workerFile(projectId, runId, taskId, token, 'source');
    const url = await this.storage.signedReadUrl?.(file.storageKey, 1800, file.sizeBytes);
    if (!url) throw new ApiHttpException('原片暂时无法签发访问地址', 503, 'INTERNAL_ERROR');
    return { url };
  }

  async uploadResult(
    projectId: string,
    runId: string,
    taskId: string,
    token: string,
    file?: UploadedAssetFile,
  ) {
    const admission = await this.repository.resultAdmission(projectId, runId, taskId, token);
    if (
      !file?.path ||
      file.mimetype !== outputMime ||
      file.size <= 0 ||
      file.size > LOCAL_REPLACE_LIMITS.maxOutputBytes
    )
      throw new ApiHttpException('请提交有效的 MP4 成片', 400, 'VALIDATION_ERROR');
    let metadata;
    const frameMs = 1000 / 24;
    try {
      metadata = await inspectImportVideo(
        file.path,
        outputName,
        {
          minSeconds: (LOCAL_REPLACE_LIMITS.minDurationMs - frameMs) / 1000,
          maxSeconds: (LOCAL_REPLACE_LIMITS.maxDurationMs + frameMs * 2) / 1000,
        },
        this.config.get<string>('FISSION_LOCAL_REPLACE_FFPROBE_PATH') || 'ffprobe',
      );
    } catch {
      throw new ApiHttpException('成片媒体校验失败', 400, 'VALIDATION_ERROR');
    }
    const { frameCount, ratio, hasAudio } = admission.sourceProbe;
    const [width, height] = ratio === '9:16' ? [720, 1280] : [1280, 720];
    if (
      metadata.width !== width ||
      metadata.height !== height ||
      metadata.frameRate !== 24 ||
      Math.abs(metadata.durationSeconds - frameCount / 24) > 0.001 ||
      metadata.hasAudio !== hasAudio
    )
      throw new ApiHttpException(
        '成片画幅、帧率、时长或音轨与原片时间线不符',
        400,
        'VALIDATION_ERROR',
      );
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (admission.resultSha256) {
      if (admission.resultSha256 !== sha256)
        throw new ApiHttpException('已提交不同成片', 409, 'CONFLICT');
      return { accepted: true };
    }
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: outputMime,
      keyContext: {
        projectName: admission.projectName,
        workflow: 'FISSION',
        lifecycle: 'staging',
        category: '局部元素替换',
        originalFileName: outputName,
      },
    });
    let bound = false;
    try {
      if (stored.sizeBytes !== file.size)
        throw new ApiHttpException('成片保存不完整', 503, 'STORAGE_WRITE_FAILED');
      bound = await this.repository.complete(projectId, runId, taskId, token, {
        nodeId: 'LOCAL_REPLACE_OUTPUT',
        originalFileName: outputName,
        mimeType: outputMime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.key,
        sha256,
      });
      return { accepted: true };
    } finally {
      if (!bound)
        await this.working
          .enqueueCleanup(projectId, stored.key, 'LOCAL_REPLACE_UNBOUND_OUTPUT')
          .catch(() => undefined);
    }
  }
}
