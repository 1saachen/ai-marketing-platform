import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AVATAR_OUTPUT_NODE,
  AVATAR_LONG_LIMITS,
  AVATAR_RENDER_LIMITS,
  isAvatarLongRenderCompletion,
  isAvatarLongSyncMedia,
  parseAvatarCompositionConfirmRequest,
  parseAvatarCompositionDraftRequest,
  parseAvatarRenderCompletion,
  parseAvatarRenderCreateRequest,
  parseAvatarRenderReview,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { parseRangeHeader, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { canonicalAvatarSubtitles, inspectAvatarRenderResult } from './avatar-render-media';
import {
  AvatarRenderRepository,
  type RenderFileRole,
  type RenderInputRole,
} from './avatar-render.repository';
import type { AvatarSyncScope } from './avatar-sync-source';
import { avatarWorkerToken } from './avatar-sync.service';

export type RenderUpload = UploadedAssetFile & { fieldname: string };
const formats = {
  video: {
    name: '数字人口播成片.mp4',
    mime: 'video/mp4',
    maxBytes: AVATAR_RENDER_LIMITS.maxVideoBytes,
  },
  subtitles: {
    name: '数字人口播字幕.srt',
    mime: 'application/x-subrip',
    maxBytes: AVATAR_RENDER_LIMITS.maxSubtitlesBytes,
  },
};

export function avatarRenderBody<T>(parse: (body: unknown) => T, body: unknown): T {
  try {
    return parse(body);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiHttpException('背景、字幕或成片数据格式无效', 400, 'VALIDATION_ERROR');
  }
}

export function avatarRenderReviewToken(config: ConfigService) {
  const token = config.get<string>('FISSION_AVATAR_RENDER_REVIEW_TOKEN')?.trim();
  return token && token !== avatarWorkerToken(config) ? token : '';
}

function invalidMedia(message: string): never {
  throw new ApiHttpException(message, 422, 'VALIDATION_ERROR');
}

function inputFile(files: RenderUpload[], role: RenderFileRole, long: boolean) {
  const config = formats[role];
  const maxBytes = long
    ? role === 'video'
      ? AVATAR_LONG_LIMITS.maxVideoBytes
      : AVATAR_LONG_LIMITS.maxSubtitlesBytes
    : config.maxBytes;
  const input = files.find((file) => file.fieldname === role);
  if (
    !input?.path ||
    input.mimetype !== config.mime ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > maxBytes
  )
    invalidMedia('成片媒体或字幕文件无效');
  return input;
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function metadataValue(value: unknown) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096)
    invalidMedia('成片缺少媒体校验记录');
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    invalidMedia('成片媒体校验记录无效');
  }
  return avatarRenderBody(parseAvatarRenderCompletion, json);
}

@Injectable()
export class AvatarRenderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvatarRenderService.name);
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AvatarRenderRepository) private readonly repository: AvatarRenderRepository,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private available() {
    return this.config.get<boolean>('FISSION_AVATAR_ENABLED') === true;
  }

  private enabled() {
    return (
      this.available() &&
      this.config.get<boolean>('FISSION_AVATAR_RENDER_ENABLED') === true &&
      !!avatarWorkerToken(this.config)
    );
  }

  private longEnabled() {
    return this.config.get<boolean>('FISSION_AVATAR_LONG_ENABLED') === true;
  }

  private assertAvailable() {
    if (!this.available())
      throw new ApiHttpException('数字人口播正式工作台暂未启用', 503, 'INTERNAL_ERROR');
  }

  private assertEnabled() {
    if (!this.enabled()) throw new ApiHttpException('成片渲染暂未启用', 503, 'INTERNAL_ERROR');
  }

  onModuleInit() {
    if (!this.available() || !avatarWorkerToken(this.config)) return;
    this.recoveryTimer = setInterval(() => void this.recover(), 30_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  private async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.repository.recoverExpired();
    } catch {
      this.logger.warn('数字人口播成片租约恢复未完成');
    } finally {
      this.recovering = false;
    }
  }

  workspace(ids: AvatarSyncScope) {
    this.assertAvailable();
    return this.repository.workspace(ids, this.enabled(), this.longEnabled());
  }

  saveDraft(ids: AvatarSyncScope, body: unknown) {
    this.assertEnabled();
    return this.repository.saveDraft(
      ids,
      avatarRenderBody((value) => parseAvatarCompositionDraftRequest(value, true), body),
      true,
      this.longEnabled(),
    );
  }

  confirm(ids: AvatarSyncScope, body: unknown) {
    this.assertEnabled();
    const { expectedRevision } = avatarRenderBody(parseAvatarCompositionConfirmRequest, body);
    return this.repository.confirm(ids, expectedRevision, true, this.longEnabled());
  }

  create(ids: AvatarSyncScope, body: unknown) {
    this.assertEnabled();
    return this.repository.create(
      ids,
      avatarRenderBody(parseAvatarRenderCreateRequest, body),
      true,
      this.longEnabled(),
    );
  }

  action(ids: AvatarSyncScope, taskId: string, action: 'cancel' | 'retry') {
    this.assertAvailable();
    if (action === 'retry') this.assertEnabled();
    return this.repository.action(ids, taskId, action, this.enabled(), this.longEnabled());
  }

  private async open(
    file: { sizeBytes: number; storageKey: string; mimeType: string },
    rangeHeader?: string,
  ) {
    const range = parseRangeHeader(rangeHeader, file.sizeBytes);
    const result = await this.storage.open(file.storageKey, range);
    if (
      result.sizeBytes !== file.sizeBytes ||
      result.contentLength !== (range ? range.end - range.start + 1 : file.sizeBytes)
    ) {
      result.stream.destroy();
      throw new ApiHttpException('渲染媒体文件不完整', 409, 'CONFLICT');
    }
    return { ...result, partial: !!range, mimeType: file.mimeType };
  }

  async source(ids: AvatarSyncScope, id: string, token: string, role: RenderInputRole) {
    const file = await this.repository.source(ids, id, token, role);
    return this.open(file);
  }

  async candidate(ids: AvatarSyncScope, id: string) {
    const file = await this.repository.candidate(ids, id);
    return {
      ...(await this.open(file)),
      sha256: file.sha256,
      originalFileName: file.originalFileName,
    };
  }

  candidateTimeline(ids: AvatarSyncScope, id: string) {
    return this.repository.candidateTimeline(ids, id);
  }

  review(ids: AvatarSyncScope, id: string, body: unknown) {
    const measured = avatarRenderBody(parseAvatarRenderReview, body);
    const method = this.config.get<string>('FISSION_AVATAR_RENDER_REVIEW_METHOD')?.trim();
    if (!method || measured.method !== method)
      throw new ApiHttpException('当前环境未配置该口型验收方法', 409, 'CONFLICT');
    return this.repository.review(ids, id, measured);
  }

  async output(ids: AvatarSyncScope, revision: number, role: RenderFileRole, range?: string) {
    this.assertAvailable();
    const file = await this.repository.output(ids, revision, role);
    return {
      ...(await this.open(file, role === 'video' ? range : undefined)),
      originalFileName: file.originalFileName,
    };
  }

  archive(ids: AvatarSyncScope, revision: number) {
    this.assertAvailable();
    return this.repository.archive(ids, revision);
  }

  async complete(
    ids: AvatarSyncScope,
    id: string,
    token: string,
    files: RenderUpload[],
    metadata: unknown,
  ) {
    const admission = await this.repository.resultAdmission(ids, id, token);
    const { frozen } = admission;
    const long = isAvatarLongSyncMedia(frozen.media);
    const { captionMode, captions } = frozen.settings;
    const sidecarRequired = captionMode === 'SIDECAR' || captionMode === 'BOTH';
    if (files.length !== (sidecarRequired ? 2 : 1)) invalidMedia('成片提交文件数量与方案不符');
    const video = inputFile(files, 'video', long);
    const subtitles = sidecarRequired ? inputFile(files, 'subtitles', long) : null;
    const proof = metadataValue(metadata);
    if (isAvatarLongSyncMedia(frozen.media)) {
      if (
        !isAvatarLongRenderCompletion(proof) ||
        proof.videoDurationMs !== frozen.media.videoDurationMs ||
        workflowStateHash(proof.seamTimesMs) !== workflowStateHash(frozen.media.seamTimesMs)
      )
        invalidMedia('成片时长或接缝与冻结口播素材不一致');
    } else if (isAvatarLongRenderCompletion(proof)) {
      invalidMedia('成片校验记录与短片渲染任务不一致');
    }
    const [videoSha, subtitlesSha] = await Promise.all([
      hashFile(video.path),
      subtitles ? hashFile(subtitles.path) : null,
    ]);
    const fingerprint = workflowStateHash({ proof, videoSha, subtitlesSha });
    if (admission.fingerprint) {
      if (admission.fingerprint !== fingerprint)
        throw new ApiHttpException('已提交其他渲染候选文件', 409, 'CONFLICT');
      return { accepted: true };
    }
    try {
      await inspectAvatarRenderResult(
        video.path,
        proof,
        frozen.media.videoDurationMs,
        this.config.get<string>('FISSION_AVATAR_FFPROBE_PATH') || 'ffprobe',
      );
    } catch {
      invalidMedia('成片画幅、轨道或时间线校验失败');
    }
    if (subtitles) {
      const actual = await readFile(subtitles.path);
      if (!actual.equals(Buffer.from(canonicalAvatarSubtitles(captions), 'utf8')))
        invalidMedia('字幕文件与确认方案不一致');
    }

    const stagedKeys: string[] = [];
    let bound = false;
    const put = async (role: RenderFileRole, file: UploadedAssetFile, sha256: string) => {
      const format = formats[role];
      const stored = await this.storage.put({
        projectId: ids.projectId,
        stream: createReadStream(file.path),
        sizeBytes: file.size,
        contentType: format.mime,
        keyContext: {
          projectName: admission.projectName,
          workflow: 'FISSION',
          lifecycle: 'staging',
          category: '数字人口播成片',
          originalFileName: format.name,
        },
      });
      stagedKeys.push(stored.key);
      if (stored.sizeBytes !== file.size)
        throw new ApiHttpException('成片保存不完整', 503, 'STORAGE_WRITE_FAILED');
      return {
        nodeId: AVATAR_OUTPUT_NODE,
        originalFileName: format.name,
        mimeType: format.mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.key,
        sha256,
      };
    };
    try {
      const storedVideo = await put('video', video, videoSha);
      const storedSubtitles =
        subtitles && subtitlesSha ? await put('subtitles', subtitles, subtitlesSha) : null;
      bound = await this.repository.complete(
        ids,
        id,
        token,
        proof,
        { video: storedVideo, ...(storedSubtitles ? { subtitles: storedSubtitles } : {}) },
        fingerprint,
      );
      return { accepted: true };
    } finally {
      if (!bound)
        await Promise.all(
          stagedKeys.map((key) =>
            this.working
              .enqueueCleanup(ids.projectId, key, 'AVATAR_RENDER_UNBOUND_MEDIA')
              .catch(() => undefined),
          ),
        );
    }
  }
}
