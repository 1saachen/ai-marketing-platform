/** Sync workbench controls to the local media element without timeupdate feedback. */
export function seekLocalVideo(
  video: Pick<HTMLVideoElement, 'readyState' | 'duration' | 'currentTime'> | null | undefined,
  seconds: number,
  toleranceSeconds = 0.050001,
): void {
  if (
    !video ||
    video.readyState < 1 ||
    !Number.isFinite(video.duration) ||
    !Number.isFinite(seconds)
  )
    return;
  const target = Math.max(0, Math.min(seconds, video.duration));
  // Native timeupdate rounds to the 0.1-second inspector; do not seek on its echo.
  if (Math.abs(video.currentTime - target) > toleranceSeconds) video.currentTime = target;
}

export const localReplaceTime = (milliseconds: number) => {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
};
