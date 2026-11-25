import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OFFSET_MS = 100;
const SEAM_RADIUS_MS = 1000;

function isTimestamp(value, durationMs) {
  return Number.isSafeInteger(value) && value >= 0 && value <= durationMs;
}

export function assessAnnotatedSync(input) {
  const { durationMs, seamTimesMs = [], samples } = input ?? {};
  if (!Number.isSafeInteger(durationMs) || durationMs < 3 || !Array.isArray(samples)) {
    throw new TypeError('需要有效的成片时长和标注数组。');
  }
  if (
    !Array.isArray(seamTimesMs) ||
    seamTimesMs.some(
      (time, index) =>
        !isTimestamp(time, durationMs) ||
        time === 0 ||
        time === durationMs ||
        (index > 0 && time <= seamTimesMs[index - 1]),
    )
  ) {
    throw new TypeError('接缝时间须在片内并按时间升序排列。');
  }
  const firstBoundary = Math.floor(durationMs / 3);
  const lastBoundary = Math.floor((2 * durationMs) / 3);
  const windows = [
    { id: 'head', startMs: 0, endMs: firstBoundary - 1 },
    { id: 'middle', startMs: firstBoundary, endMs: lastBoundary - 1 },
    { id: 'tail', startMs: lastBoundary, endMs: durationMs },
    ...seamTimesMs.map((time) => ({
      id: `seam-${time}`,
      startMs: Math.max(0, time - SEAM_RADIUS_MS),
      endMs: Math.min(durationMs, time + SEAM_RADIUS_MS),
    })),
  ];

  const events = samples.map((sample) => {
    const { audioMs, mouthMs, uncertaintyMs } = sample ?? {};
    if (
      !isTimestamp(audioMs, durationMs) ||
      !isTimestamp(mouthMs, durationMs) ||
      !isTimestamp(uncertaintyMs, durationMs)
    ) {
      throw new TypeError('音频、口型时标和测量不确定度须为片内的整数毫秒。');
    }
    const offsetMs = mouthMs - audioMs;
    const magnitudeMs = Math.abs(offsetMs);
    const status =
      magnitudeMs - uncertaintyMs > MAX_OFFSET_MS
        ? 'exceeds_limit'
        : magnitudeMs + uncertaintyMs <= MAX_OFFSET_MS
          ? 'within_limit'
          : 'inconclusive';
    return { audioMs, offsetMs, uncertaintyMs, status };
  });
  const coverage = windows.map((window) => ({
    ...window,
    sampleCount: events.filter(
      ({ audioMs }) => audioMs >= window.startMs && audioMs <= window.endMs,
    ).length,
  }));
  const complete = coverage.every(({ sampleCount }) => sampleCount > 0);
  const status = events.some((event) => event.status === 'exceeds_limit')
    ? 'exceeds_limit'
    : complete && events.every((event) => event.status === 'within_limit')
      ? 'within_limit'
      : 'inconclusive';

  return {
    methodVersion: 'human-events-v1',
    status,
    thresholdMs: MAX_OFFSET_MS,
    maxAbsOffsetMs: events.length
      ? events.reduce((largest, { offsetMs }) => Math.max(largest, Math.abs(offsetMs)), 0)
      : null,
    coverage,
    events,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write('用法：node scripts/fission-avatar/check-sync.mjs <标注 JSON>\n');
    process.exit(2);
  }
  try {
    const report = assessAnnotatedSync(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.status !== 'within_limit') process.exitCode = 1;
  } catch {
    process.stderr.write('请传入有效的成片标注 JSON。\n');
    process.exitCode = 2;
  }
}
