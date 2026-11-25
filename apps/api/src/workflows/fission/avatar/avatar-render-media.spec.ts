import { describe, expect, it, vi } from 'vitest';
import { inspectAvatarRenderResult } from './avatar-render-media';
import { probeAvatarMedia } from './avatar-sync-media';

vi.mock('./avatar-sync-media', () => ({ probeAvatarMedia: vi.fn() }));

const native = {
  schemaVersion: 3 as const,
  audioDurationMs: 4090,
  videoDurationMs: 4000,
  sourceVideoSha256: 'a'.repeat(64),
  outputVideoSha256: 'b'.repeat(64),
  videoFrameCount: 96,
  audioPacketCount: 192,
  maxTimelineDriftUs: 0,
};

describe('Avatar render media inspection', () => {
  it('validates native track lengths independently of an allowed start offset', async () => {
    vi.mocked(probeAvatarMedia).mockResolvedValue({
      format: { format_name: 'mov,mp4' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1080,
          height: 1920,
          pix_fmt: 'yuv420p',
          start_time: '0',
          duration: '4.000',
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          start_time: '0.045',
          duration: '4.090',
        },
      ],
    });

    await expect(inspectAvatarRenderResult('output.mp4', native, 4000, 'ffprobe')).resolves.toBe(
      undefined,
    );
    await expect(
      inspectAvatarRenderResult(
        'output.mp4',
        {
          audioDurationMs: 4090,
          videoDurationMs: 4000,
          audioLagMs: 0,
          minimumAudioCorrelationPermille: 1000,
        },
        4000,
        'ffprobe',
      ),
    ).rejects.toThrow('Invalid render track length');
    await expect(
      inspectAvatarRenderResult(
        'output.mp4',
        { ...native, audioDurationMs: 4080 },
        4000,
        'ffprobe',
      ),
    ).rejects.toThrow('Invalid render timing');
  });
});
