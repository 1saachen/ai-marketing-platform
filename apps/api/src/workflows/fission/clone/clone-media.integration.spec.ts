import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import {
  CLONE_SHOT_REFERENCE_MODE,
  FISSION_CLONE_INPUT_LIMITS,
  type CloneGenerationPlan,
} from '@ai-marketing/contracts';
import { expect, it } from 'vitest';
import { CloneMediaService } from './clone-media.service';
import { inspectGenerationFile } from './clone-generation-media';

const execute = promisify(execFile);

it.skipIf(process.env.FISSION_CLONE_MEDIA_TEST !== '1')(
  'decodes actual video and image bytes and rejects corrupt, disguised and out-of-bounds media',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clone-media-test-'));
    const ffmpeg = process.env.FISSION_CLONE_FFMPEG_PATH || 'ffmpeg';
    const ffprobe = process.env.FISSION_CLONE_FFPROBE_PATH || 'ffprobe';
    const media = new CloneMediaService(
      new ConfigService({
        FISSION_CLONE_FFMPEG_PATH: ffmpeg,
        FISSION_CLONE_FFPROBE_PATH: ffprobe,
      }),
    );
    const generate = (args: string[]) =>
      execute(ffmpeg, ['-v', 'error', '-nostdin', '-y', ...args], {
        timeout: 15_000,
        windowsHide: true,
      });
    const file = async (name: string, mimetype: string) => ({
      path: join(directory, name),
      originalname: name,
      mimetype,
      size: (await stat(join(directory, name))).size,
    });
    try {
      await generate([
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:r=10',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        join(directory, 'reference.mp4'),
      ]);
      const video = await file('reference.mp4', 'video/mp4');
      expect(await media.inspect(video, 'REFERENCE', FISSION_CLONE_INPUT_LIMITS)).toEqual({
        mimeType: 'video/mp4',
        media: { width: 64, height: 64, durationMs: 2000, frameRate: 10 },
      });
      const audioTailName = 'reference-with-audio-tail.mp4';
      await generate([
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:r=24:d=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4.042',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        join(directory, audioTailName),
      ]);
      const audioTailVideo = await file(audioTailName, 'video/mp4');
      const { stdout: audioTailProbe } = await execute(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'format=duration:stream=duration',
          '-of',
          'json',
          audioTailVideo.path,
        ],
        { timeout: 15_000, windowsHide: true },
      );
      const audioTail = JSON.parse(audioTailProbe) as {
        streams: [{ duration: string }];
        format: { duration: string };
      };
      expect(Number(audioTail.streams[0].duration)).toBe(4);
      expect(Number(audioTail.format.duration)).toBeGreaterThan(4);
      expect(
        await media.inspect(audioTailVideo, 'REFERENCE', {
          ...FISSION_CLONE_INPUT_LIMITS,
          maxVideoDurationMs: 4000,
        }),
      ).toEqual({
        mimeType: 'video/mp4',
        media: { width: 64, height: 64, durationMs: 4000, frameRate: 24 },
      });
      await generate(['-i', video.path, '-frames:v', '1', join(directory, 'product.png')]);
      const product = await file('product.png', 'image/png');
      expect(await media.inspect(product, 'PRODUCT', FISSION_CLONE_INPUT_LIMITS)).toEqual({
        mimeType: 'image/png',
        media: { width: 64, height: 64, durationMs: null, frameRate: null },
      });
      for (const [extension, mimeType] of [
        ['jpg', 'image/jpeg'],
        ['webp', 'image/webp'],
      ]) {
        const name = `product.${extension}`;
        await generate(['-i', video.path, '-frames:v', '1', join(directory, name)]);
        expect(
          await media.inspect(await file(name, mimeType!), 'PRODUCT', FISSION_CLONE_INPUT_LIMITS),
        ).toMatchObject({ mimeType, media: { width: 64, height: 64, durationMs: null } });
      }
      await generate(['-i', video.path, '-c', 'copy', join(directory, 'reference.mov')]);
      expect(
        await media.inspect(
          await file('reference.mov', 'video/quicktime'),
          'REFERENCE',
          FISSION_CLONE_INPUT_LIMITS,
        ),
      ).toMatchObject({ mimeType: 'video/quicktime', media: { durationMs: 2000, frameRate: 10 } });
      await expect(media.inspect(product, 'REFERENCE', FISSION_CLONE_INPUT_LIMITS)).rejects.toThrow(
        '参考素材必须是视频',
      );
      await expect(
        media.inspect({ ...video, mimetype: 'image/png' }, 'REFERENCE', FISSION_CLONE_INPUT_LIMITS),
      ).rejects.toThrow('视频类型与文件名不符');
      await expect(
        media.inspect(video, 'REFERENCE', {
          ...FISSION_CLONE_INPUT_LIMITS,
          maxReferenceBytes: video.size - 1,
        }),
      ).rejects.toThrow('文件大小');
      await expect(
        media.inspect(video, 'REFERENCE', { ...FISSION_CLONE_INPUT_LIMITS, maxPixels: 100 }),
      ).rejects.toThrow('媒体尺寸');
      await expect(
        media.inspect(video, 'REFERENCE', {
          ...FISSION_CLONE_INPUT_LIMITS,
          minVideoDurationMs: 3000,
        }),
      ).rejects.toThrow('视频时长');
      await expect(
        media.inspect(video, 'REFERENCE', {
          ...FISSION_CLONE_INPUT_LIMITS,
          maxVideoDurationMs: 1000,
        }),
      ).rejects.toThrow('视频时长');
      await writeFile(join(directory, 'disguised.mp4'), await readFile(product.path));
      await expect(
        media.inspect(
          await file('disguised.mp4', 'video/mp4'),
          'REFERENCE',
          FISSION_CLONE_INPUT_LIMITS,
        ),
      ).rejects.toThrow('视频实际格式');
      const bytes = await readFile(video.path);
      await writeFile(join(directory, 'truncated.mp4'), bytes.subarray(0, bytes.length - 200));
      await expect(
        media.inspect(
          await file('truncated.mp4', 'video/mp4'),
          'REFERENCE',
          FISSION_CLONE_INPUT_LIMITS,
        ),
      ).rejects.toThrow('媒体无法完整解码');
    } finally {
      // This directory is created by this test and contains only its flat generated media.
      for (const name of await readdir(directory)) await rm(join(directory, name), { force: true });
      await rmdir(directory);
    }
  },
  60_000,
);

it.skipIf(process.env.FISSION_CLONE_MEDIA_TEST !== '1')(
  'requires the only source edit checkpoint to cover the whole frozen 24 fps timeline',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clone-source-edit-media-test-'));
    const ffmpeg = process.env.FISSION_CLONE_FFMPEG_PATH || 'ffmpeg';
    const config = new ConfigService({
      FISSION_CLONE_FFMPEG_PATH: ffmpeg,
      FISSION_CLONE_FFPROBE_PATH: process.env.FISSION_CLONE_FFPROBE_PATH || 'ffprobe',
    });
    const plan = {
      mode: 'SEEDANCE_2_0_SOURCE_EDIT',
      width: 1280,
      height: 720,
      timeline: {
        fpsNumerator: 24,
        fpsDenominator: 1,
        frameCount: 96,
        shots: [
          { startFrame: 0, endFrame: 48 },
          { startFrame: 48, endFrame: 96 },
        ],
      },
    } as CloneGenerationPlan;
    async function encode(frameCount: number, options: { fps?: number; audio?: boolean } = {}) {
      const name = `edit-${frameCount}-${options.fps ?? 24}-${options.audio ?? false}.mp4`;
      const path = join(directory, name);
      await execute(
        ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-f',
          'lavfi',
          '-i',
          `color=c=blue:s=1280x720:r=${options.fps ?? 24}`,
          ...(options.audio
            ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000', '-t', '2', '-c:a', 'aac']
            : []),
          '-frames:v',
          String(frameCount),
          '-c:v',
          'libx264',
          '-threads',
          '1',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          path,
        ],
        { timeout: 15_000, windowsHide: true },
      );
      return {
        path,
        originalname: name,
        mimetype: 'video/mp4',
        size: (await stat(path)).size,
      };
    }
    try {
      const firstShotOnly = await encode(48);
      await expect(inspectGenerationFile(config, firstShotOnly, plan, '0')).rejects.toThrow(
        '媒体校验',
      );
      const withExtraTail = await encode(97);
      await expect(inspectGenerationFile(config, withExtraTail, plan, '0')).resolves.toMatch(
        /^[a-f0-9]{64}$/u,
      );
      await expect(inspectGenerationFile(config, withExtraTail, plan, '1')).rejects.toThrow(
        '媒体校验',
      );
      await expect(inspectGenerationFile(config, withExtraTail, plan, 'final')).rejects.toThrow(
        '媒体校验',
      );
      const exact = await encode(96);
      await expect(inspectGenerationFile(config, exact, plan, 'final')).resolves.toMatch(
        /^[a-f0-9]{64}$/u,
      );
      const referencePlan = {
        ...plan,
        mode: CLONE_SHOT_REFERENCE_MODE,
        shots: [{ referenceFrames: 48 }, { referenceFrames: 60 }],
      } as CloneGenerationPlan;
      await expect(
        inspectGenerationFile(config, firstShotOnly, referencePlan, 'reference-0'),
      ).resolves.toMatch(/^[a-f0-9]{64}$/u);
      await expect(
        inspectGenerationFile(config, firstShotOnly, plan, 'reference-0'),
      ).rejects.toThrow('媒体校验');
      await expect(
        inspectGenerationFile(config, firstShotOnly, referencePlan, 'reference-1'),
      ).rejects.toThrow('媒体校验');
      await expect(
        inspectGenerationFile(config, withExtraTail, referencePlan, 'reference-0'),
      ).rejects.toThrow('媒体校验');
      const withAudio = await encode(48, { audio: true });
      const wrongFps = await encode(48, { fps: 30 });
      for (const invalid of [withAudio, wrongFps])
        await expect(
          inspectGenerationFile(config, invalid, referencePlan, 'reference-0'),
        ).rejects.toThrow('媒体校验');
    } finally {
      for (const name of await readdir(directory)) await rm(join(directory, name), { force: true });
      await rmdir(directory);
    }
  },
  60_000,
);
