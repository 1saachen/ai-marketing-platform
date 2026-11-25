import {
  AVATAR_LONG_LIMITS,
  AVATAR_NATIVE_LIMITS,
  AVATAR_NATIVE_RENDER_LIMITS,
  AVATAR_RENDER_LIMITS,
  isAvatarLongRenderCompletion,
  isAvatarNativeRenderCompletion,
  type AvatarCaptionCue,
  type AvatarRenderCompletion,
} from '@ai-marketing/contracts';
import { probeAvatarMedia } from './avatar-sync-media';

export function canonicalAvatarSubtitles(captions: AvatarCaptionCue[]) {
  const timestamp = (milliseconds: number) => {
    const minutes = String(Math.floor(milliseconds / 60_000)).padStart(2, '0');
    const seconds = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
    return `00:${minutes}:${seconds},${String(milliseconds % 1000).padStart(3, '0')}`;
  };
  return captions
    .map(
      (cue, i) =>
        `${i + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${cue.text}\n\n`,
    )
    .join('');
}

export async function inspectAvatarRenderResult(
  path: string,
  result: AvatarRenderCompletion,
  expectedDurationMs: number,
  ffprobe: string,
) {
  const media = await probeAvatarMedia(path, ffprobe);
  const video = media.streams?.find((stream) => stream.codec_type === 'video');
  const audio = media.streams?.find((stream) => stream.codec_type === 'audio');
  if (
    media.streams?.length !== 2 ||
    !media.format?.format_name?.split(',').includes('mp4') ||
    video?.codec_name !== 'h264' ||
    video.width !== AVATAR_RENDER_LIMITS.width ||
    video.height !== AVATAR_RENDER_LIMITS.height ||
    video.pix_fmt !== 'yuv420p' ||
    audio?.codec_name !== 'aac'
  )
    throw new Error('Invalid render tracks');

  const pts = [video.start_time, audio.start_time, video.duration, audio.duration].map((value) =>
    Math.round(Number(value) * 1000),
  );
  const [videoStart, audioStart, videoMs, audioMs] = pts;
  const native = isAvatarNativeRenderCompletion(result);
  // The probe reports decimal seconds and the Worker reports rounded milliseconds.
  const durationToleranceMs = native ? AVATAR_NATIVE_RENDER_LIMITS.durationToleranceMs + 1 : 40;
  const trackToleranceMs = native
    ? AVATAR_NATIVE_LIMITS.durationToleranceMs + durationToleranceMs
    : AVATAR_RENDER_LIMITS.maxReviewOffsetMs;
  const startToleranceMs = native ? trackToleranceMs : 50;
  const limit = isAvatarLongRenderCompletion(result)
    ? AVATAR_LONG_LIMITS.maxDurationMs
    : AVATAR_RENDER_LIMITS.maxDurationMs;
  if (
    !pts.every(Number.isFinite) ||
    videoStart === undefined ||
    audioStart === undefined ||
    videoMs === undefined ||
    audioMs === undefined ||
    Math.abs(videoStart) > startToleranceMs ||
    Math.abs(audioStart) > startToleranceMs ||
    videoMs < 1 ||
    audioMs < 1 ||
    videoMs > limit + durationToleranceMs ||
    audioMs > limit + durationToleranceMs ||
    Math.abs(videoMs - result.videoDurationMs) > durationToleranceMs ||
    Math.abs(audioMs - result.audioDurationMs) > durationToleranceMs ||
    Math.abs(videoMs - expectedDurationMs) > (native ? durationToleranceMs : trackToleranceMs) ||
    Math.abs(videoStart - audioStart) > trackToleranceMs
  )
    throw new Error('Invalid render timing');
  // Native input admission bounds per-track lengths separately from the start offset.
  // The receipt establishes that the render preserves both on the confirmed source.
  const trackDifferenceMs = native
    ? Math.abs(videoMs - audioMs)
    : Math.abs(videoStart + videoMs - (audioStart + audioMs));
  if (trackDifferenceMs > trackToleranceMs) throw new Error('Invalid render track length');
}
