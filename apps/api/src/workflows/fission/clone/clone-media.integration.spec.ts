import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { FISSION_CLONE_INPUT_LIMITS } from '@ai-marketing/contracts';
import { expect, it } from 'vitest';
import { CloneMediaService } from './clone-media.service';

const execute = promisify(execFile);

it.skipIf(process.env.FISSION_CLONE_MEDIA_TEST !== '1')(
  'decodes actual video and image bytes and rejects corrupt, disguised and out-of-bounds media',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clone-media-test-'));
    const ffmpeg = process.env.FISSION_CLONE_FFMPEG_PATH || 'ffmpeg';
    const media = new CloneMediaService(
      new ConfigService({
        FISSION_CLONE_FFMPEG_PATH: ffmpeg,
        FISSION_CLONE_FFPROBE_PATH: process.env.FISSION_CLONE_FFPROBE_PATH || 'ffprobe',
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
