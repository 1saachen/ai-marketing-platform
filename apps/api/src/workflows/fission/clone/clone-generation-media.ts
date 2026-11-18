import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ConfigService } from '@nestjs/config';
import { CLONE_GENERATION_MAX_FILE_BYTES, type CloneGenerationPlan } from '@ai-marketing/contracts';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { ApiHttpException } from '../../../common/api-http-exception';

const execute = promisify(execFile);
const mov = ['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0'];
const limits = { timeout: 60_000, maxBuffer: 256 * 1024, windowsHide: true };

export async function inspectGenerationFile(
  config: ConfigService,
  file: UploadedAssetFile,
  plan: CloneGenerationPlan,
  slot: string,
) {
  try {
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 12 ||
      file.size > CLONE_GENERATION_MAX_FILE_BYTES
    )
      throw new Error('SIZE');
    const handle = await open(file.path, 'r');
    try {
      const head = Buffer.alloc(12);
      await handle.read(head, 0, head.length, 0);
      if (head.toString('ascii', 4, 8) !== 'ftyp' || (await handle.stat()).size !== file.size)
        throw new Error('MP4');
    } finally {
      await handle.close();
    }
    const { stdout, stderr } = await execute(
      config.get<string>('FISSION_CLONE_FFPROBE_PATH') || 'ffprobe',
      [
        '-v',
        'error',
        ...mov,
        '-show_entries',
        'stream=codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,nb_frames,duration_ts,time_base',
        '-of',
        'json',
        file.path,
      ],
      limits,
    );
    const { streams } = JSON.parse(stdout) as {
      streams: {
        codec_type: string;
        codec_name: string;
        width: number;
        height: number;
        sample_aspect_ratio?: string;
        avg_frame_rate: string;
        nb_frames: string;
        duration_ts: number;
        time_base: string;
      }[];
    };
    const videos = streams.filter((stream) => stream.codec_type === 'video');
    const stream = videos[0];
    if (
      stderr.trim() ||
      videos.length !== 1 ||
      !stream ||
      stream.width !== plan.width ||
      stream.height !== plan.height ||
      ![undefined, 'N/A', '1:1'].includes(stream.sample_aspect_ratio)
    )
      throw new Error('DIMENSIONS');
    const [timeNumerator, timeDenominator] = stream.time_base.split('/').map(Number);
    const { fpsNumerator, fpsDenominator, frameCount } = plan.timeline;
    const duration = (stream.duration_ts * timeNumerator!) / timeDenominator!;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 15.1) throw new Error('DURATION');
    if (slot === 'final') {
      const [num, den] = stream.avg_frame_rate.split('/').map(Number);
      if (
        stream.codec_name !== 'h264' ||
        streams.length !== 1 ||
        Number(stream.nb_frames) !== frameCount ||
        num! * fpsDenominator !== fpsNumerator * den! ||
        stream.duration_ts * timeNumerator! * fpsNumerator !==
          frameCount * fpsDenominator * timeDenominator!
      )
        throw new Error('TIMELINE');
    } else {
      const shot = plan.timeline.shots[Number(slot)]!;
      if (duration < ((shot.endFrame - shot.startFrame) * fpsDenominator) / fpsNumerator)
        throw new Error('SHORT_CLIP');
    }
    const result = await execute(
      config.get<string>('FISSION_CLONE_FFMPEG_PATH') || 'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-xerror',
        '-err_detect',
        'explode',
        ...mov,
        '-threads',
        '1',
        '-i',
        file.path,
        '-map',
        '0:v:0',
        '-fps_mode',
        'passthrough',
        '-progress',
        'pipe:1',
        '-f',
        'null',
        '-',
      ],
      limits,
    );
    const counts = [...result.stdout.matchAll(/^frame=\s*(\d+)/gm)];
    const frames = Number(counts.at(-1)?.[1]);
    if (
      result.stderr.trim() ||
      !Number.isSafeInteger(frames) ||
      frames < 1 ||
      (slot === 'final' && frames !== frameCount)
    )
      throw new Error('DECODE');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    throw new ApiHttpException('成片或镜头未通过服务端媒体校验', 400, 'VALIDATION_ERROR');
  }
}
