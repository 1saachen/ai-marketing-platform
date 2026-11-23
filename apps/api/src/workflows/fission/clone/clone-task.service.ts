import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseCloneAnalysisConfirmRequest,
  parseCloneAnalysisDraftSaveRequest,
  parseCloneAssetVersionRef,
  parseCloneGenerationPreflightRequest,
  parseCloneMappingConfirmRequest,
  parseCloneSuggestionAdoptRequest,
  parseCloneTaskCheckpointRequest,
  parseCloneTaskCompleteRequest,
  parseCloneTaskCreateRequest,
  parseCloneTaskFailRequest,
  parseCloneTaskProgressRequest,
  type CloneMappingCandidate,
  type CloneTaskFile,
  type CloneTaskOperation,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { AssetService } from '../../../platform/asset/asset.service';
import { ProjectService } from '../../../platform/project/project.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { CloneService } from './clone.service';
import { CloneMediaService } from './clone-media.service';
import { CloneTaskRepository } from './clone-task.repository';
import { summarizeCloneGenerationPlan } from './clone-generation-plan';
import {
  assertCloneShotReferenceStorage,
  canSignCloneSourceVideo,
  cloneGenerationConfigured,
} from './clone-generation-config';
import { requireClonePlanningCapability } from './clone-generation-planning';

const execute = promisify(execFile);
const parse = <T>(fn: (value: unknown) => T, value: unknown): T => {
  try {
    return fn(value);
  } catch (error) {
    throw new ApiHttpException(
      error instanceof Error ? error.message : '请求格式不正确',
      400,
      'VALIDATION_ERROR',
    );
  }
};

@Injectable()
export class CloneTaskService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private recovering = false;
  private readonly logger = new Logger(CloneTaskService.name);
  constructor(
    @Inject(CloneTaskRepository) private readonly repository: CloneTaskRepository,
    @Inject(CloneService) private readonly clone: CloneService,
    @Inject(CloneMediaService) private readonly media: CloneMediaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(AssetService) private readonly assets: AssetService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  enabled() {
    return (
      this.config.get<boolean>('FISSION_CLONE_ENABLED') === true &&
      this.config.get<boolean>('FISSION_CLONE_G2_ENABLED') === true
    );
  }
  private assertEnabled() {
    if (!this.enabled())
      throw new ApiHttpException(
        '深度拆解与元素映射尚未启用，请完成 G2 迁移与配置',
        503,
        'CLONE_CAPABILITY_UNAVAILABLE',
      );
  }
  onModuleInit() {
    if (!this.enabled()) return;
    this.timer = setInterval(() => {
      if (this.recovering) return;
      this.recovering = true;
      void this.repository
        .recoverExpired()
        .catch(() => this.logger.warn('复刻任务恢复检查失败'))
        .finally(() => {
          this.recovering = false;
        });
    }, 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private async access(projectId: string) {
    this.assertEnabled();
    await this.projects.get(projectId);
  }
  async preflightGeneration(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    const { sourceMapping, count } = parse(parseCloneGenerationPreflightRequest, body);
    const models = cloneGenerationConfigured(this.config);
    if (!models)
      throw new ApiHttpException(
        '成片生成服务尚未启用或配置不完整',
        503,
        'CLONE_CAPABILITY_UNAVAILABLE',
      );
    assertCloneShotReferenceStorage(canSignCloneSourceVideo(this.config, this.storage));
    try {
      const plan = await this.repository.generationPlan(projectId, runId, sourceMapping);
      requireClonePlanningCapability(plan, count, models.planningModel);
      return summarizeCloneGenerationPlan(plan, count);
    } catch (error) {
      if (error instanceof TypeError)
        throw new ApiHttpException(error.message, 400, 'VALIDATION_ERROR');
      throw error;
    }
  }
  async create(projectId: string, runId: string, operation: CloneTaskOperation, body: unknown) {
    await this.access(projectId);
    const request = parse(parseCloneTaskCreateRequest, body);
    if (await this.repository.existingTask(projectId, runId, operation, request))
      return this.clone.workspace(projectId, runId);
    const model = this.config.get<string>('FISSION_CLONE_ANALYSIS_MODEL');
    if (!model || !this.config.get<string>('FISSION_CLONE_ANALYSIS_WORKER_TOKEN'))
      throw new ApiHttpException(
        '拆解模型或独立执行服务尚未配置',
        503,
        'CLONE_CAPABILITY_UNAVAILABLE',
      );
    await this.repository.accessRun(projectId, runId);
    const candidates: CloneMappingCandidate[] = [];
    if (operation === 'MAP_SUGGEST' && request.purpose === 'SMART_MATCH') {
      for (const asset of await this.repository.candidateVersions(projectId)) {
        const version = await this.repository.assetVersion(
          projectId,
          asset.id,
          asset.currentVersion,
        );
        candidates.push({
          assetId: asset.id,
          version: asset.currentVersion,
          sourceVersionId: version.id,
          name: asset.name,
          type: asset.type,
          mimeType: version.mimeType,
          file: null,
        });
      }
    }
    await this.repository.create(projectId, runId, operation, request, candidates, model);
    return this.clone.workspace(projectId, runId);
  }
  async task(projectId: string, runId: string, id: string) {
    await this.access(projectId);
    return this.repository.task(projectId, runId, id);
  }
  async cancel(projectId: string, runId: string, id: string) {
    await this.access(projectId);
    await this.repository.cancel(projectId, runId, id);
    return this.clone.workspace(projectId, runId);
  }
  async retry(projectId: string, runId: string, id: string) {
    await this.access(projectId);
    await this.repository.retry(projectId, runId, id);
    return this.clone.workspace(projectId, runId);
  }
  async saveAnalysis(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    await this.repository.saveAnalysis(
      projectId,
      runId,
      parse(parseCloneAnalysisDraftSaveRequest, body),
    );
    return this.clone.workspace(projectId, runId);
  }
  async confirmAnalysis(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    await this.repository.confirmAnalysis(
      projectId,
      runId,
      parse(parseCloneAnalysisConfirmRequest, body),
    );
    return this.clone.workspace(projectId, runId);
  }
  async confirmMapping(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    await this.repository.confirmMapping(
      projectId,
      runId,
      parse(parseCloneMappingConfirmRequest, body),
    );
    return this.clone.workspace(projectId, runId);
  }
  async adopt(projectId: string, runId: string, id: string, body: unknown) {
    await this.access(projectId);
    await this.repository.adopt(
      projectId,
      runId,
      id,
      parse(parseCloneSuggestionAdoptRequest, body).expectedDraftRevision,
    );
    return this.clone.workspace(projectId, runId);
  }
  async prepareMappingAsset(projectId: string, runId: string, body: unknown) {
    await this.access(projectId);
    const input = parse(parseCloneAssetVersionRef, body);
    await this.prepare(projectId, runId, input.assetId, input.version);
    return this.clone.workspace(projectId, runId);
  }

  private async prepare(
    projectId: string,
    runId: string,
    assetId: string,
    version: number,
    worker?: { taskId: string; token: string; sourceVersionId: string },
  ): Promise<CloneMappingCandidate> {
    await this.repository.accessRun(projectId, runId, !worker);
    const source = await this.repository.assetVersion(projectId, assetId, version);
    if (worker && source.id !== worker.sourceVersionId)
      throw new ApiHttpException('冻结候选资产版本身份已变化', 409, 'CONFLICT');
    const previous = await this.repository.preparedAsset(projectId, runId, assetId, version);
    const present = (row: NonNullable<typeof previous>): CloneMappingCandidate => ({
      assetId,
      version,
      sourceVersionId: source.id,
      name: source.asset.name,
      type: source.asset.type,
      mimeType: row.fileObject.mimeType,
      file: {
        fileObjectId: row.fileObject.id,
        originalFileName: row.fileObject.originalFileName,
        mimeType: row.fileObject.mimeType,
        sizeBytes: row.fileObject.sizeBytes,
        sha256: row.fileObject.sha256,
        role: 'MAPPING',
        media: row.media as CloneTaskFile['media'],
      },
    });
    if (
      previous &&
      previous.sourceVersionId === source.id &&
      previous.fileObject.status === 'AVAILABLE'
    )
      return present(previous);
    const limit = this.clone.capabilities().limits.maxProductBytes;
    if (source.sizeBytes < 1 || source.sizeBytes > limit)
      throw new ApiHttpException('映射资产超过文件大小限制', 400, 'FILE_TOO_LARGE');
    const directory = await mkdtemp(join(tmpdir(), 'clone-mapping-'));
    const path = join(directory, 'source');
    let storedKey: string | undefined;
    try {
      const content = await this.assets.content(projectId, assetId, undefined, version);
      let received = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          done(received > limit ? new Error('SIZE_LIMIT') : null, chunk);
        },
      });
      await pipeline(content.stream, bounded, createWriteStream(path));
      if ((await stat(path)).size !== source.sizeBytes)
        throw new ApiHttpException('映射资产文件大小与版本记录不一致', 409, 'CONFLICT');
      let media: CloneTaskFile['media'];
      let mimeType = source.mimeType;
      if (/^(image|video)\//.test(source.mimeType)) {
        const result = await this.media.inspect(
          {
            path,
            originalname: source.originalFileName,
            mimetype: source.mimeType,
            size: source.sizeBytes,
          },
          'PRODUCT',
          this.clone.capabilities().limits,
        );
        media = result.media;
        mimeType = result.mimeType;
      } else if (source.mimeType.startsWith('audio/')) {
        try {
          const { stdout, stderr } = await execute(
            this.config.get<string>('FISSION_CLONE_FFPROBE_PATH') || 'ffprobe',
            [
              '-v',
              'error',
              '-protocol_whitelist',
              'file,pipe',
              '-show_entries',
              'format=duration:stream=codec_type',
              '-of',
              'json',
              path,
            ],
            { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
          );
          const probe = JSON.parse(stdout) as {
            streams?: { codec_type: string }[];
            format?: { duration?: string };
          };
          const durationMs = Math.round(Number(probe.format?.duration) * 1000);
          if (
            stderr.trim() ||
            !probe.streams?.some((stream) => stream.codec_type === 'audio') ||
            !Number.isFinite(durationMs) ||
            durationMs < 1000 ||
            durationMs > 120000
          )
            throw new Error('AUDIO_INVALID');
          await execute(
            this.config.get<string>('FISSION_CLONE_FFMPEG_PATH') || 'ffmpeg',
            [
              '-v',
              'error',
              '-nostdin',
              '-xerror',
              '-protocol_whitelist',
              'file,pipe',
              '-i',
              path,
              '-map',
              '0:a:0',
              '-f',
              'null',
              '-',
            ],
            { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true },
          );
          media = { durationMs, width: 0, height: 0, frameRate: null };
        } catch {
          throw new ApiHttpException('音频文件不可解码或超过 120 秒', 400, 'FILE_TYPE_UNSUPPORTED');
        }
      } else if (
        source.asset.type === 'SUBTITLE' &&
        ['.srt', '.vtt', '.txt'].includes(extname(source.originalFileName).toLowerCase()) &&
        source.sizeBytes <= 1024 * 1024
      ) {
        const bytes = await readFile(path);
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new ApiHttpException('字幕文件不是有效 UTF-8 文本', 400, 'FILE_TYPE_UNSUPPORTED');
        }
        mimeType =
          extname(source.originalFileName).toLowerCase() === '.vtt' ? 'text/vtt' : 'text/plain';
        media = { durationMs: null, width: 0, height: 0, frameRate: null };
      } else
        throw new ApiHttpException(
          '当前映射仅支持图片、视频、音频或 UTF-8 字幕文件',
          400,
          'FILE_TYPE_UNSUPPORTED',
        );
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      const project = await this.projects.get(projectId);
      const stored = await this.storage.put({
        projectId,
        stream: createReadStream(path),
        sizeBytes: source.sizeBytes,
        contentType: mimeType,
        keyContext: {
          projectName: project.name,
          workflow: 'FISSION',
          lifecycle: 'staging',
          category: `clone-mapping-${runId}`,
          originalFileName: source.originalFileName,
        },
      });
      storedKey = stored.key;
      const prepared = await this.repository.prepareAsset(
        projectId,
        runId,
        assetId,
        version,
        source.id,
        {
          nodeId: 'CLONE_MAPPING',
          originalFileName: source.originalFileName,
          mimeType,
          sizeBytes: source.sizeBytes,
          storageKey: stored.key,
          sha256,
        },
        media,
        worker,
      );
      if (prepared.fileObject.storageKey === storedKey) storedKey = undefined;
      return present(prepared);
    } finally {
      if (storedKey)
        await this.working.enqueueCleanup(projectId, storedKey, 'CLONE_MAPPING_PREPARE_UNBOUND');
      await rm(path, { force: true });
      await rmdir(directory);
    }
  }

  claim(projectId: string, taskId: string) {
    this.assertEnabled();
    return this.repository.claim(projectId, taskId);
  }
  heartbeat(projectId: string, taskId: string, token: string) {
    this.assertEnabled();
    return this.repository.heartbeat(projectId, taskId, token);
  }
  progress(projectId: string, taskId: string, token: string, body: unknown) {
    this.assertEnabled();
    return this.repository.progress(
      projectId,
      taskId,
      token,
      parse(parseCloneTaskProgressRequest, body),
    );
  }
  async checkpoint(projectId: string, taskId: string, token: string, body: unknown) {
    this.assertEnabled();
    const request = parse(parseCloneTaskCheckpointRequest, body);
    const selected = await this.repository.resultAssets(projectId, taskId, token, request.output);
    for (const asset of selected.assets)
      await this.prepare(projectId, selected.runId, asset.assetId, asset.version, {
        taskId,
        token,
        sourceVersionId: asset.sourceVersionId,
      });
    return this.repository.checkpoint(projectId, taskId, token, request);
  }
  async complete(projectId: string, taskId: string, token: string, body: unknown) {
    this.assertEnabled();
    const { result } = parse(parseCloneTaskCompleteRequest, body);
    const selected = await this.repository.resultAssets(projectId, taskId, token, result, true);
    for (const asset of selected.assets)
      await this.prepare(projectId, selected.runId, asset.assetId, asset.version, {
        taskId,
        token,
        sourceVersionId: asset.sourceVersionId,
      });
    return this.repository.complete(projectId, taskId, token, result);
  }
  fail(projectId: string, taskId: string, token: string, body: unknown) {
    this.assertEnabled();
    return this.repository.fail(
      projectId,
      taskId,
      token,
      parse(parseCloneTaskFailRequest, body).retryable,
    );
  }
  async source(projectId: string, taskId: string, token: string, fileId: string) {
    this.assertEnabled();
    const file = await this.repository.sourceFile(projectId, taskId, token, fileId);
    const content = await this.storage.open(file.storageKey);
    if (content.sizeBytes !== file.sizeBytes) {
      content.stream.destroy();
      throw new ApiHttpException('任务文件大小不一致', 409, 'CONFLICT');
    }
    return { ...content, mimeType: file.mimeType };
  }
}
