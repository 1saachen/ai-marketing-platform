import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CloneCapabilities, CloneUpload, CloneUploadRole } from '@ai-marketing/contracts';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { validateImportFile } from '../../../platform/file/import-file-validation';
import { ApiHttpException } from '../../../common/api-http-exception';

const execute = promisify(execFile);
@Injectable()
export class CloneMediaService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async inspect(
    file: UploadedAssetFile,
    role: CloneUploadRole,
    limits: CloneCapabilities['limits'],
  ): Promise<{ mimeType: string; media: CloneUpload['media'] }> {
    const ext = extname(file.originalname).toLowerCase();
    const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    if (role === 'REFERENCE' && image)
      throw new ApiHttpException('参考素材必须是视频', 400, 'FILE_TYPE_UNSUPPORTED');
    if (!image && !['.mp4', '.mov'].includes(ext))
      throw new ApiHttpException(
        '仅支持 MP4、MOV 视频及 JPG、PNG、WebP 图片',
        400,
        'FILE_TYPE_UNSUPPORTED',
      );
    const maxBytes = role === 'REFERENCE' ? limits.maxReferenceBytes : limits.maxProductBytes;
    if (!Number.isSafeInteger(file.size) || file.size < 1)
      throw new ApiHttpException('请选择非空文件', 400, 'FILE_REQUIRED');
    if (file.size > maxBytes)
      throw new ApiHttpException('文件大小超过复刻输入限制', 400, 'FILE_TOO_LARGE');
    let mimeType: string;
    if (image) mimeType = (await validateImportFile(file, 'IMAGE', maxBytes)).mimetype;
    else {
      const handle = await open(file.path, 'r');
      try {
        const bytes = Buffer.alloc(12);
        await handle.read(bytes, 0, 12, 0);
        if ((await handle.stat()).size !== file.size || bytes.toString('ascii', 4, 8) !== 'ftyp')
          throw new ApiHttpException('视频实际格式与文件名不符', 400, 'FILE_TYPE_UNSUPPORTED');
      } finally {
        await handle.close();
      }
      mimeType = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
      if (![mimeType, 'application/octet-stream'].includes(file.mimetype.toLowerCase()))
        throw new ApiHttpException('视频类型与文件名不符', 400, 'FILE_TYPE_UNSUPPORTED');
    }
    try {
      const { stdout, stderr: probeErrors } = await execute(
        this.config.get<string>('FISSION_CLONE_FFPROBE_PATH') || 'ffprobe',
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_entries',
          'format=duration:stream=codec_type,width,height,duration,avg_frame_rate,nb_frames',
          '-of',
          'json',
          file.path,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      if (probeErrors.trim()) throw new Error('PROBE');
      const probe = JSON.parse(stdout) as {
        streams?: Array<{
          codec_type?: string;
          width?: number;
          height?: number;
          duration?: string;
          avg_frame_rate?: string;
          nb_frames?: string;
        }>;
        format?: { duration?: string };
      };
      const stream = probe.streams?.find((s) => s.codec_type === 'video');
      const width = stream?.width ?? 0,
        height = stream?.height ?? 0;
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width * height > limits.maxPixels
      )
        throw new Error('DIMENSIONS');
      const videoSeconds = Number(stream?.duration);
      const seconds =
        Number.isFinite(videoSeconds) && videoSeconds > 0
          ? videoSeconds
          : Number(probe.format?.duration);
      if (
        !image &&
        (!Number.isFinite(seconds) ||
          seconds * 1000 < limits.minVideoDurationMs ||
          seconds * 1000 > limits.maxVideoDurationMs)
      )
        throw new Error('DURATION');
      const [num, den = 1] = (stream?.avg_frame_rate ?? '').split('/').map(Number);
      const frameRate = num && den && Number.isFinite(num / den) ? num / den : null;
      // Decode under a bounded process, after resource admission; metadata alone is not evidence of readability.
      const { stdout: progress, stderr: decodeErrors } = await execute(
        this.config.get<string>('FISSION_CLONE_FFMPEG_PATH') || 'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-xerror',
          '-err_detect',
          'explode',
          '-protocol_whitelist',
          'file,pipe',
          '-threads',
          '1',
          '-i',
          file.path,
          '-map',
          '0:v:0',
          ...(image ? ['-frames:v', '1'] : ['-map', '0:a?']),
          '-threads',
          '1',
          '-filter_threads',
          '1',
          '-fps_mode',
          'passthrough',
          '-progress',
          'pipe:1',
          '-f',
          'null',
          '-',
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      if (decodeErrors.trim()) throw new Error('DECODE');
      const lastProgress = Object.fromEntries(
        progress
          .trim()
          .split(/\r?\n/)
          .map((line) => line.split('=')),
      );
      const decodedFrames = Number(lastProgress.frame);
      const expectedFrames = Number(stream?.nb_frames);
      if (
        lastProgress.progress !== 'end' ||
        !Number.isSafeInteger(decodedFrames) ||
        decodedFrames < 1 ||
        (!image &&
          Number.isSafeInteger(expectedFrames) &&
          expectedFrames > 0 &&
          decodedFrames !== expectedFrames)
      )
        throw new Error('INCOMPLETE_DECODE');
      return {
        mimeType,
        media: {
          width,
          height,
          durationMs: image ? null : Math.round(seconds * 1000),
          frameRate: image ? null : frameRate,
        },
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      throw new ApiHttpException(
        code === 'DIMENSIONS'
          ? '媒体尺寸超过限制或无法识别'
          : code === 'DURATION'
            ? '视频时长超出当前支持范围'
            : '媒体无法完整解码，请检查文件或媒体校验服务配置',
        400,
        'VALIDATION_ERROR',
      );
    }
  }
}
