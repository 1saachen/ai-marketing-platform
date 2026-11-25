import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AVATAR_SYNC_LIMITS, type AvatarSyncCompletion } from '@ai-marketing/contracts';

const execute = promisify(execFile);
type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  start_time?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
};
type ProbeResult = {
  format?: { format_name?: string; duration?: string };
  streams?: ProbeStream[];
};

export async function probeAvatarMedia(path: string, ffprobe: string): Promise<ProbeResult> {
  const { stdout } = await execute(
    ffprobe,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name,duration,start_time,width,height,pix_fmt',
      '-of',
      'json',
      path,
    ],
    { timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true },
  );
  return JSON.parse(stdout) as ProbeResult;
}

function duration(
  stream: ProbeStream,
  media: ProbeResult,
  encoderPaddingMs: number,
  maximumDurationMs: number,
) {
  const value = Math.round(1000 * Number(stream.duration ?? media.format?.duration));
  if (!Number.isFinite(value) || value < 1 || value > maximumDurationMs + encoderPaddingMs + 1)
    throw new Error('Invalid media duration');
  return value;
}

export async function inspectAvatarSyncResult(
  audioPath: string,
  videoPath: string,
  result: AvatarSyncCompletion,
  ffprobe: string,
  maximumDurationMs: number = AVATAR_SYNC_LIMITS.maxDurationMs,
) {
  const [audio, video] = await Promise.all([
    probeAvatarMedia(audioPath, ffprobe),
    probeAvatarMedia(videoPath, ffprobe),
  ]);
  const speech = audio.streams?.[0];
  const picture = video.streams?.find((stream) => stream.codec_type === 'video');
  const muxed = video.streams?.find((stream) => stream.codec_type === 'audio');
  if (
    audio.streams?.length !== 1 ||
    speech?.codec_type !== 'audio' ||
    speech.codec_name !== 'mp3' ||
    !audio.format?.format_name?.split(',').includes('mp3') ||
    video.streams?.length !== 2 ||
    !video.format?.format_name?.split(',').includes('mp4') ||
    picture?.codec_name !== 'h264' ||
    muxed?.codec_name !== 'aac'
  )
    throw new Error('Invalid synchronization media streams');
  // MP3 frame headers can include priming/padding the decoder removes from the speech clock.
  const mp3PaddingMs = 100;
  const audioMs = duration(speech, audio, mp3PaddingMs, maximumDurationMs);
  const videoMs = duration(picture, video, 0, maximumDurationMs);
  const muxedMs = duration(muxed, video, 0, maximumDurationMs);
  const videoStartMs = Math.round(1000 * Number(picture.start_time ?? 0));
  const audioStartMs = Math.round(1000 * Number(muxed.start_time ?? 0));
  if (
    Math.abs(audioMs - result.audioDurationMs) > mp3PaddingMs ||
    Math.abs(videoMs - result.videoDurationMs) > 30 ||
    Math.abs(videoMs - muxedMs) > AVATAR_SYNC_LIMITS.maxAudioLagMs ||
    !Number.isFinite(videoStartMs) ||
    !Number.isFinite(audioStartMs) ||
    Math.abs(videoStartMs - audioStartMs) > AVATAR_SYNC_LIMITS.maxAudioLagMs
  )
    throw new Error('Synchronization media does not match reported durations');
}
