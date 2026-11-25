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
  AVATAR_LONG_LIMITS,
  AVATAR_SYNC_LIMITS,
  AVATAR_SYNC_NODE,
  parseAvatarNativeCompletion,
  parseAvatarLongSyncCompletion,
  parseAvatarSyncCompletion,
  parseAvatarSyncCreateRequest,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { parseRangeHeader, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { inspectAvatarSyncResult } from './avatar-sync-media';
import { AvatarSyncRepository } from './avatar-sync.repository';
import type { AvatarSyncScope } from './avatar-sync-source';

type Role = 'audio' | 'video';
type ResultFile = UploadedAssetFile & { fieldname: string };
const media = {
  audio: {
    name: '数字人口播音轨.mp3',
    mime: 'audio/mpeg',
    limit: AVATAR_SYNC_LIMITS.maxAudioBytes,
  },
  video: {
    name: '数字人口播同步视频.mp4',
    mime: 'video/mp4',
    limit: AVATAR_SYNC_LIMITS.maxVideoBytes,
  },
};

export function avatarWorkerToken(config: ConfigService) {
  return config.get<string>('FISSION_AVATAR_SYNC_WORKER_TOKEN')?.trim() || '';
}

export function avatarSyncBody<T>(parse: (body: unknown) => T, body: unknown): T {
  try {
    return parse(body);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiHttpException('口播任务数据格式无效', 400, 'VALIDATION_ERROR');
  }
}

function validResultFile(
  input: ResultFile | undefined,
  role: Role,
  segmented: boolean,
): UploadedAssetFile {
  const config = media[role];
  const limit = !segmented
    ? config.limit
    : role === 'audio'
      ? AVATAR_LONG_LIMITS.maxAudioBytes
      : AVATAR_LONG_LIMITS.maxVideoBytes;
  if (
    !input?.path ||
    input.mimetype !== config.mime ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > limit
  )
    throw new ApiHttpException('同步媒体文件无效', 422, 'VALIDATION_ERROR');
  return input;
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function parseResultMetadata(metadata: unknown, segmented: boolean, native: boolean) {
  const limit = segmented ? AVATAR_LONG_LIMITS.maxMetadataBytes : 128 * 1024;
  if (typeof metadata !== 'string' || Buffer.byteLength(metadata) > limit)
    throw new ApiHttpException('同步结果缺少有效校验记录', 422, 'VALIDATION_ERROR');
  let data: unknown;
  try {
    data = JSON.parse(metadata);
  } catch {
    throw new ApiHttpException('同步结果校验记录无效', 422, 'VALIDATION_ERROR');
  }
  if (native) return avatarSyncBody(parseAvatarNativeCompletion, data);
  if (segmented) return avatarSyncBody(parseAvatarLongSyncCompletion, data);
  return avatarSyncBody(parseAvatarSyncCompletion, data);
}

@Injectable()
export class AvatarSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvatarSyncService.name);
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AvatarSyncRepository) private readonly repository: AvatarSyncRepository,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private workspaceEnabled() {
    return this.config.get<boolean>('FISSION_AVATAR_ENABLED') === true;
  }

  private taskCreationEnabled() {
    return (
      this.workspaceEnabled() &&
      this.config.get<boolean>('FISSION_AVATAR_SYNC_ENABLED') === true &&
      !!avatarWorkerToken(this.config)
    );
  }

  private longCreationEnabled() {
    return (
      this.taskCreationEnabled() && this.config.get<boolean>('FISSION_AVATAR_LONG_ENABLED') === true
    );
  }

  private continuityEnabled() {
    return this.config.get<boolean>('FISSION_AVATAR_CONTINUITY_ENABLED') === true;
  }

  private nativeCreationEnabled() {
    return (
      this.workspaceEnabled() &&
      this.config.get<boolean>('FISSION_AVATAR_NATIVE_ENABLED') === true &&
      !!avatarWorkerToken(this.config)
    );
  }

  onModuleInit() {
    // Keep recovering already-queued work when only the new-generation flag is closed.
    if (!this.workspaceEnabled() || !avatarWorkerToken(this.config)) return;
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
      this.logger.warn('数字人口播租约恢复未完成');
    } finally {
      this.recovering = false;
    }
  }

  private assertWorkspaceEnabled() {
    if (!this.workspaceEnabled())
      throw new ApiHttpException('数字人口播正式工作台暂未启用', 503, 'INTERNAL_ERROR');
  }

  workspace(ids: AvatarSyncScope) {
    this.assertWorkspaceEnabled();
    return this.repository.workspace(
      ids,
      this.taskCreationEnabled(),
      this.longCreationEnabled(),
      this.continuityEnabled(),
      this.nativeCreationEnabled(),
    );
  }

  create(ids: AvatarSyncScope, body: unknown) {
    this.assertWorkspaceEnabled();
    const nativeEnabled = this.nativeCreationEnabled();
    const shortEnabled = this.taskCreationEnabled();
    if (!shortEnabled && !nativeEnabled)
      throw new ApiHttpException('数字人口播生成暂未启用', 503, 'INTERNAL_ERROR');
    const request = avatarSyncBody(parseAvatarSyncCreateRequest, body);
    return this.repository.create(
      ids,
      request,
      this.longCreationEnabled(),
      shortEnabled,
      this.continuityEnabled(),
      nativeEnabled,
    );
  }

  action(ids: AvatarSyncScope, taskId: string, action: 'cancel' | 'retry') {
    this.assertWorkspaceEnabled();
    const nativeEnabled = this.nativeCreationEnabled();
    const shortEnabled = this.taskCreationEnabled();
    if (action === 'retry' && !shortEnabled && !nativeEnabled)
      throw new ApiHttpException('数字人口播生成暂未启用', 503, 'INTERNAL_ERROR');
    return this.repository.action(
      ids,
      taskId,
      action,
      shortEnabled,
      this.longCreationEnabled(),
      this.continuityEnabled(),
      nativeEnabled,
    );
  }

  async content(
    ids: AvatarSyncScope,
    artifactId: string,
    role: Role,
    revision?: number,
    rangeHeader?: string,
  ) {
    this.assertWorkspaceEnabled();
    const file = await this.repository.output(ids, artifactId, role, revision);
    const range = parseRangeHeader(rangeHeader, file.sizeBytes);
    const bytes = await this.storage.open(file.storageKey, range);
    if (bytes.sizeBytes !== file.sizeBytes) {
      bytes.stream.destroy();
      throw new ApiHttpException('同步媒体文件不完整', 409, 'CONFLICT');
    }
    return {
      ...bytes,
      mimeType: file.mimeType,
      originalFileName: file.originalFileName,
      partial: !!range,
      native: file.native,
    };
  }

  async source(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    role: 'character' | 'reference-audio' = 'character',
  ) {
    const source = await (role === 'character'
      ? this.repository.character(ids, taskId, token)
      : this.repository.referenceAudio(ids, taskId, token));
    const bytes = await this.storage.open(source.storageKey);
    if (bytes.sizeBytes !== source.sizeBytes || bytes.contentLength !== source.sizeBytes) {
      bytes.stream.destroy();
      throw new ApiHttpException(
        role === 'character' ? '冻结形象文件大小已变化' : '冻结音色文件大小已变化',
        422,
        'VALIDATION_ERROR',
      );
    }
    return { ...bytes, mimeType: source.mimeType };
  }

  async segmentSource(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    ordinal: number,
    role: Role,
  ) {
    const source = await this.repository.segmentContent(ids, taskId, token, ordinal, role);
    const bytes = await this.storage.open(source.storageKey);
    if (bytes.sizeBytes !== source.sizeBytes || bytes.contentLength !== source.sizeBytes) {
      bytes.stream.destroy();
      throw new ApiHttpException('冻结口播分段媒体大小已变化', 422, 'VALIDATION_ERROR');
    }
    return { ...bytes, mimeType: source.mimeType };
  }

  async submitResult(
    ids: AvatarSyncScope,
    taskId: string,
    token: string,
    files: ResultFile[],
    metadata: unknown,
    ordinal?: number,
  ) {
    const admission =
      ordinal === undefined
        ? await this.repository.resultAdmission(ids, taskId, token)
        : await this.repository.segmentAdmission(ids, taskId, token, ordinal);
    if (files.length !== 2)
      throw new ApiHttpException('请提交语音和同步视频两个文件', 422, 'VALIDATION_ERROR');
    const audio = validResultFile(
      files.find((file) => file.fieldname === 'audio'),
      'audio',
      admission.segmented,
    );
    const video = validResultFile(
      files.find((file) => file.fieldname === 'video'),
      'video',
      admission.segmented,
    );
    const proof = parseResultMetadata(metadata, admission.segmented, admission.native);
    const [audioSha, videoSha] = await Promise.all([hashFile(audio.path), hashFile(video.path)]);
    const fingerprint = workflowStateHash({ proof, audioSha, videoSha });
    if (admission.resultFingerprint) {
      if (admission.resultFingerprint !== fingerprint)
        throw new ApiHttpException('已提交其他口播结果', 409, 'CONFLICT');
      return { accepted: true };
    }
    try {
      await inspectAvatarSyncResult(
        audio.path,
        video.path,
        proof,
        this.config.get<string>('FISSION_AVATAR_FFPROBE_PATH') || 'ffprobe',
        admission.segmented ? AVATAR_LONG_LIMITS.maxDurationMs : undefined,
      );
    } catch {
      throw new ApiHttpException('实际音视频格式、轨道或时长校验失败', 422, 'VALIDATION_ERROR');
    }

    const stagingKeys: string[] = [];
    let bound = false;
    const put = async (
      role: Role,
      file: UploadedAssetFile,
      sha256: string,
    ): Promise<FileObjectInput> => {
      const format = media[role];
      const originalFileName =
        admission.native && role === 'video' ? '数字人口播生成原片.mp4' : format.name;
      const stored = await this.storage.put({
        projectId: ids.projectId,
        stream: createReadStream(file.path),
        sizeBytes: file.size,
        contentType: format.mime,
        keyContext: {
          projectName: admission.projectName,
          workflow: 'FISSION',
          lifecycle: 'staging',
          category: '数字人口播',
          originalFileName,
        },
      });
      stagingKeys.push(stored.key);
      if (stored.sizeBytes !== file.size)
        throw new ApiHttpException('同步媒体保存不完整', 503, 'STORAGE_WRITE_FAILED');
      return {
        nodeId: AVATAR_SYNC_NODE,
        originalFileName,
        mimeType: format.mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.key,
        sha256,
      };
    };
    try {
      const sourceAudio = await put('audio', audio, audioSha);
      const syncVideo = await put('video', video, videoSha);
      const stored = { audio: sourceAudio, video: syncVideo };
      if (ordinal === undefined) {
        bound = await this.repository.complete(ids, taskId, token, proof, stored, fingerprint);
      } else {
        if ('schemaVersion' in proof)
          throw new ApiHttpException('分段媒体校验记录无效', 422, 'VALIDATION_ERROR');
        bound = await this.repository.completeSegment(
          ids,
          taskId,
          token,
          ordinal,
          proof,
          stored,
          fingerprint,
        );
      }
      return { accepted: true };
    } finally {
      if (!bound) {
        await Promise.all(
          stagingKeys.map((key) =>
            this.working
              .enqueueCleanup(ids.projectId, key, 'AVATAR_SYNC_UNBOUND_MEDIA')
              .catch(() => undefined),
          ),
        );
      }
    }
  }
}
