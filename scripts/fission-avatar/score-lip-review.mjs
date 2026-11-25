import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  AVATAR_RENDER_LIMITS,
  parseAvatarRenderReview,
} from '../../packages/contracts/dist/fission-avatar-render.js';
import { assessAnnotatedSync } from './check-sync.mjs';

const {
  minReviewCoveragePermille,
  minReviewConfidencePermille,
  maxReviewOffsetMs,
  maxDurationMs: maxShortDurationMs,
} = AVATAR_RENDER_LIMITS;
const minAccuracyPermille = 950;
const seamRadiusMs = 1000;
const minLongDurationMs = 61_000;
const maxLongDurationMs = 90_000;
const maxSeams = 11;
const maxUnits = 1800;
const maxEvidenceBytes = 2 * 1024 * 1024;
const maxCandidateBytes = 256 * 1024 * 1024;
const timelineFps = 30;
const pictureTicksPerSecond = 90_000;
const frameTicks = pictureTicksPerSecond / timelineFps;
const frameTimeMs = (frames) => Math.round((frames * 1000) / timelineFps);
const runExecutable = promisify(execFile);

const help = `用法：node scripts/fission-avatar/score-lip-review.mjs <最终候选 MP4> <独立标注 JSON> [--timeline <长片时间线 JSON>] [--review]

标注使用 schemaVersion、sha256、method、durationMs、seamTimesMs、units 字段。
schemaVersion 为 1。候选 SHA-256 须与标注 sha256 完全一致。
超过 30 秒时须传入长片合成生成的时间线报告。候选摘要、实际画面时长、各段边界及接缝顺序须一致。
使用 FISSION_AVATAR_FFPROBE_PATH 或 PATH 中的 ffprobe 检查本地 MP4 的画面时长。
最多 90 秒，11 处接缝和 1800 个发音单位。
每项单位包含 id、audioMs 和 measurement。独立清点全部可听发音单位，按 audioMs 严格升序给出。
无可靠口型测量时填 measurement: null。其余填 mouthMs、uncertaintyMs、confidencePermille、match。
match 仅可为 MATCHED 或 MISMATCHED，按可见口型是否匹配独立评分。
默认输出诊断。--review 仅在证据达标时输出可供 G3 提交的摘要。退出码 0 达标、1 暂缓、2 输入无效。
程序只计算提供的标注，无法独立鉴别实际口型或确认标注过程。合成时标测试仅验证计算逻辑。
`;

function hasOnlyFields(value, fields) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isIntegerBetween(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function readLabels(labels) {
  if (
    !hasOnlyFields(labels, [
      'schemaVersion',
      'sha256',
      'method',
      'durationMs',
      'seamTimesMs',
      'units',
    ]) ||
    labels.schemaVersion !== 1 ||
    !isIntegerBetween(labels.durationMs, 3, maxLongDurationMs) ||
    !Array.isArray(labels.seamTimesMs) ||
    labels.seamTimesMs.length > maxSeams ||
    !Array.isArray(labels.units) ||
    labels.units.length > maxUnits
  ) {
    throw new TypeError('标注格式无效或超出时长、接缝、发音单位上限。');
  }
  parseAvatarRenderReview({
    sha256: labels.sha256,
    method: labels.method,
    coveragePermille: 0,
    confidencePermille: 0,
    maxAbsOffsetMs: 0,
  });

  const seen = new Set();
  let previousAudioMs = -1;
  for (const unit of labels.units) {
    if (
      !hasOnlyFields(unit, ['id', 'audioMs', 'measurement']) ||
      typeof unit.id !== 'string' ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(unit.id) ||
      seen.has(unit.id) ||
      !isIntegerBetween(unit.audioMs, previousAudioMs + 1, labels.durationMs)
    ) {
      throw new TypeError('发音单位 ID 须唯一，音频时标须按片内时间严格升序排列。');
    }
    seen.add(unit.id);
    previousAudioMs = unit.audioMs;

    const { measurement } = unit;
    if (measurement === null) continue;
    if (
      !hasOnlyFields(measurement, ['mouthMs', 'uncertaintyMs', 'confidencePermille', 'match']) ||
      !isIntegerBetween(measurement.mouthMs, 0, labels.durationMs) ||
      !isIntegerBetween(measurement.uncertaintyMs, 0, labels.durationMs) ||
      !isIntegerBetween(measurement.confidencePermille, 0, 1000) ||
      !['MATCHED', 'MISMATCHED'].includes(measurement.match)
    ) {
      throw new TypeError('口型测量须填完整时标、不确定度、置信度及匹配判定，或显式填 null。');
    }
  }
  return labels;
}

function assertTimeline(labels, candidateSha256, timeline) {
  if (timeline === undefined) {
    if (labels.durationMs > maxShortDurationMs)
      throw new TypeError('长片需要合成报告。请使用 --timeline 提供实际成片时间线。');
    return;
  }
  if (timeline?.schemaVersion === 2) {
    if (
      !hasOnlyFields(timeline, ['schemaVersion', 'candidateSha256', 'durationMs', 'seamTimesMs']) ||
      !isIntegerBetween(timeline.durationMs, minLongDurationMs, maxLongDurationMs) ||
      !Array.isArray(timeline.seamTimesMs) ||
      !isIntegerBetween(timeline.seamTimesMs.length, 2, maxSeams)
    )
      throw new TypeError('长片成片时间线格式无效。');
    if (timeline.candidateSha256 !== candidateSha256)
      throw new Error('长片时间线的候选 SHA-256 与成片不匹配。');
    if (timeline.durationMs !== labels.durationMs)
      throw new Error('标注时长与实际成片时长不匹配。');
    if (
      timeline.seamTimesMs.length !== labels.seamTimesMs.length ||
      timeline.seamTimesMs.some(
        (time, i) =>
          time !== labels.seamTimesMs[i] ||
          time !== frameTimeMs(Math.round((time * timelineFps) / 1000)),
      )
    )
      throw new Error('标注接缝时间与实际成片不匹配。');
    return;
  }
  if (
    !timeline ||
    timeline.schemaVersion !== 1 ||
    typeof timeline.manifestSha256 !== 'string' ||
    !/^[a-f\d]{64}$/.test(timeline.manifestSha256) ||
    !isIntegerBetween(timeline.durationMs, minLongDurationMs, maxLongDurationMs) ||
    timeline.fps !== timelineFps ||
    timeline.pictureTimeBase !== `1/${pictureTicksPerSecond}` ||
    !isIntegerBetween(timeline.frameCount, 1, (maxLongDurationMs * timelineFps) / 1000) ||
    timeline.durationMs !== frameTimeMs(timeline.frameCount) ||
    timeline.pictureFirstPts !== 0 ||
    timeline.pictureLastPts !== (timeline.frameCount - 1) * frameTicks ||
    !Array.isArray(timeline.segments) ||
    !isIntegerBetween(timeline.segments.length, 3, maxSeams + 1) ||
    !Array.isArray(timeline.seams) ||
    timeline.seams.length !== timeline.segments.length - 1
  ) {
    throw new TypeError('长片时间线报告格式或探测结果无效。');
  }
  if (timeline.candidateSha256 !== candidateSha256)
    throw new Error('长片时间线的候选 SHA-256 与成片不匹配。');
  if (timeline.durationMs !== labels.durationMs) throw new Error('标注时长与实际成片时长不匹配。');
  if (timeline.seams.length !== labels.seamTimesMs.length)
    throw new Error('标注接缝时间与实际成片不匹配。');

  let frames = 0;
  for (const [index, part] of timeline.segments.entries()) {
    if (!isIntegerBetween(part?.frameCount, 1, (maxShortDurationMs * timelineFps) / 1000))
      throw new TypeError('长片时间线中的段落长度无效。');
    if (index > 0) {
      const seam = timeline.seams[index - 1];
      if (
        seam?.frame !== frames ||
        seam.pts !== frames * frameTicks ||
        seam.timeMs !== frameTimeMs(frames)
      )
        throw new TypeError('长片时间线的接缝顺序或帧时标无效。');
      if (seam.timeMs !== labels.seamTimesMs[index - 1])
        throw new Error('标注接缝时间与实际成片不匹配。');
    }
    frames += part.frameCount;
  }
  if (frames !== timeline.frameCount) throw new TypeError('长片段落帧数与探测结果不匹配。');
}

function scoreWindows(durationMs, seamTimesMs, events) {
  const firstBoundary = Math.floor(durationMs / 3);
  const lastBoundary = Math.floor((2 * durationMs) / 3);
  const windows = [
    { id: 'head', startMs: 0, endMs: firstBoundary - 1 },
    { id: 'middle', startMs: firstBoundary, endMs: lastBoundary - 1 },
    { id: 'tail', startMs: lastBoundary, endMs: durationMs },
  ];
  for (const seam of seamTimesMs) {
    windows.push(
      { id: `seam-${seam}-before`, startMs: Math.max(0, seam - seamRadiusMs), endMs: seam - 1 },
      { id: `seam-${seam}-after`, startMs: seam, endMs: Math.min(durationMs, seam + seamRadiusMs) },
    );
  }
  return windows.map((window) => {
    const members = events.filter(
      ({ audioMs }) => audioMs >= window.startMs && audioMs <= window.endMs,
    );
    const trustCount = members.filter(({ trusted }) => trusted).length;
    const issueCounts = {};
    for (const { issues } of members) {
      for (const issue of issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    }
    return { ...window, audibleUnits: members.length, trustedUnits: trustCount, issueCounts };
  });
}

function permille(numerator, denominator) {
  return denominator ? Math.floor((1000 * numerator) / denominator) : 0;
}

export function scoreAnnotatedLipReview(input, candidateSha256, timeline, probedDurationMs) {
  const labels = readLabels(input);
  const { sha256, method, durationMs, seamTimesMs, units } = labels;
  if (candidateSha256 !== sha256) throw new Error('候选成片 SHA-256 与标注不匹配。');
  if (probedDurationMs !== undefined && probedDurationMs !== durationMs)
    throw new Error('标注时长与探测到的实际成片画面时长不匹配。');
  assertTimeline(labels, candidateSha256, timeline);
  const samples = units.flatMap(({ audioMs, measurement }) =>
    measurement ? [{ audioMs, ...measurement }] : [],
  );
  const annotated = assessAnnotatedSync({ durationMs, seamTimesMs, samples });
  if (annotated.thresholdMs !== maxReviewOffsetMs) throw new Error('评审与标注偏差门限不一致。');
  const measuredEvents = new Map(annotated.events.map((event) => [event.audioMs, event]));
  const events = units.map(({ id, audioMs, measurement }) => {
    const event = measuredEvents.get(audioMs);
    if (!measurement || !event) {
      return { id, audioMs, measurement: null, trusted: false, issues: ['UNMEASURED'] };
    }
    const trusted = measurement.confidencePermille >= minReviewConfidencePermille;
    const issues = [];
    if (!trusted) issues.push('LOW_CONFIDENCE');
    if (event.status === 'inconclusive') issues.push('OFFSET_INCONCLUSIVE');
    if (event.status === 'exceeds_limit') issues.push('OFFSET_EXCEEDS_LIMIT');
    if (measurement.match === 'MISMATCHED') issues.push('MISMATCHED');
    return {
      id,
      audioMs,
      measurement: {
        ...measurement,
        offsetMs: event.offsetMs,
        maxAbsOffsetMs: Math.abs(event.offsetMs) + measurement.uncertaintyMs,
      },
      trusted,
      issues,
    };
  });
  const scoredWindows = scoreWindows(durationMs, seamTimesMs, events);
  const measured = events.flatMap(({ measurement }) => (measurement ? [measurement] : []));
  const trustedUnits = events.filter(({ trusted }) => trusted).length;
  const matchedUnits = events.filter(
    ({ trusted, measurement }) => trusted && measurement?.match === 'MATCHED',
  ).length;
  const coveragePermille = permille(trustedUnits, events.length);
  const accuracyPermille = permille(matchedUnits, events.length);
  const confidencePermille = measured.reduce(
    (minimum, event) => Math.min(minimum, event.confidencePermille),
    measured.length ? 1000 : 0,
  );
  const maxAbsOffsetMs = measured.length
    ? measured.reduce((largest, event) => Math.max(largest, event.maxAbsOffsetMs), 0)
    : null;

  const blockers = [];
  if (coveragePermille < minReviewCoveragePermille) blockers.push('INSUFFICIENT_UNIT_COVERAGE');
  if (confidencePermille < minReviewConfidencePermille) blockers.push('INSUFFICIENT_CONFIDENCE');
  if (scoredWindows.some(({ trustedUnits }) => trustedUnits === 0))
    blockers.push('MISSING_INTERVAL_EVIDENCE');
  if (events.some(({ issues }) => issues.includes('OFFSET_EXCEEDS_LIMIT')))
    blockers.push('OFFSET_EXCEEDS_LIMIT');
  if (events.some(({ issues }) => issues.includes('OFFSET_INCONCLUSIVE')))
    blockers.push('OFFSET_INCONCLUSIVE');
  if (accuracyPermille < minAccuracyPermille) blockers.push('ACCURACY_BELOW_THRESHOLD');

  const review =
    !blockers.length && maxAbsOffsetMs !== null
      ? parseAvatarRenderReview({
          sha256,
          method,
          coveragePermille,
          confidencePermille,
          maxAbsOffsetMs,
          ...(durationMs > maxShortDurationMs
            ? { evidence: { durationMs, seamTimesMs, accuracyPermille } }
            : {}),
        })
      : null;
  return {
    diagnostics: {
      schemaVersion: 1,
      sha256,
      method,
      durationMs,
      probedDurationMs: probedDurationMs ?? null,
      timelineVerified: timeline !== undefined,
      status: review ? 'ELIGIBLE' : 'WITHHELD',
      blockers,
      thresholds: {
        minCoveragePermille: minReviewCoveragePermille,
        minConfidencePermille: minReviewConfidencePermille,
        maxOffsetMs: maxReviewOffsetMs,
        minAccuracyPermille,
        seamRadiusMs,
      },
      totals: {
        audibleUnits: events.length,
        measuredUnits: measured.length,
        trustedUnits,
        matchedUnits,
      },
      coveragePermille,
      accuracyPermille,
      confidencePermille,
      maxAbsOffsetMs,
      windows: scoredWindows,
      events,
    },
    review,
  };
}

async function readEvidenceJson(path, label) {
  const handle = await open(path, 'r');
  try {
    const source = await handle.stat();
    if (!source.isFile() || source.size < 1 || source.size > maxEvidenceBytes)
      throw new Error(`${label} JSON 须为 2 MiB 以内的普通文件。`);
    const bytes = Buffer.alloc(source.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== source.size) throw new Error(`${label}文件在读取时变化。`);
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)),
      );
    } catch {
      throw new TypeError(`${label} JSON 无效。`);
    }
  } finally {
    await handle.close();
  }
}

async function probeDuration(path) {
  const tool = process.env.FISSION_AVATAR_FFPROBE_PATH?.trim() || 'ffprobe';
  try {
    const { stdout } = await runExecutable(
      tool,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-enable_drefs',
        '0',
        '-select_streams',
        'v',
        '-show_entries',
        'stream=time_base,duration_ts',
        '-of',
        'json',
        path,
      ],
      { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    const streams = JSON.parse(stdout).streams;
    const track = streams?.length === 1 ? streams[0] : undefined;
    const timeBase = /^(\d{1,9})\/(\d{1,9})$/.exec(track?.time_base ?? '');
    if (!timeBase || !isIntegerBetween(track?.duration_ts, 1, Number.MAX_SAFE_INTEGER))
      throw new Error();
    const numerator = BigInt(timeBase[1]);
    const denominator = BigInt(timeBase[2]);
    if (!numerator || !denominator) throw new Error();
    const duration = BigInt(track.duration_ts) * numerator * 1000n;
    const milliseconds = Number((2n * duration + denominator) / (2n * denominator));
    if (!isIntegerBetween(milliseconds, 3, maxLongDurationMs)) throw new Error();
    return milliseconds;
  } catch {
    throw new Error('无法探测 90 秒以内的候选 MP4。请核对文件和 FISSION_AVATAR_FFPROBE_PATH。');
  }
}

function sameCandidateFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function inspectCandidate(path) {
  const handle = await open(path, 'r');
  try {
    const source = await handle.stat();
    if (!source.isFile() || !isIntegerBetween(source.size, 1, maxCandidateBytes))
      throw new Error('候选成片须为 256 MiB 以内的非空普通文件。');
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > source.size) throw new Error('候选成片在读取时变化。');
      digest.update(chunk);
    }
    const absolutePath = resolve(path);
    if (bytes !== source.size || !sameCandidateFile(source, await stat(absolutePath)))
      throw new Error('候选成片在读取时变化。');
    const durationMs = await probeDuration(absolutePath);
    if (!sameCandidateFile(source, await stat(absolutePath)))
      throw new Error('候选成片在探测时变化。');
    return { sha256: digest.digest('hex'), durationMs };
  } finally {
    await handle.close();
  }
}

async function runCli(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      review: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      timeline: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (positionals.length !== 2) throw new Error('请提供最终候选成片和独立标注 JSON，参见 --help。');
  const [candidate, annotations] = positionals;
  const labels = await readEvidenceJson(annotations, '标注');
  const timeline =
    values.timeline === undefined
      ? undefined
      : await readEvidenceJson(values.timeline, '长片时间线');
  const media = await inspectCandidate(candidate);
  const { diagnostics, review } = scoreAnnotatedLipReview(
    labels,
    media.sha256,
    timeline,
    media.durationMs,
  );
  if (values.review && !review)
    process.stderr.write('证据暂缓，未输出评审摘要。查看诊断以核对原因。\n');
  else process.stdout.write(JSON.stringify(values.review ? review : diagnostics, null, 2) + '\n');
  if (!review) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2));
  } catch (reason) {
    process.stderr.write(`${reason.message}\n`);
    process.exitCode = 2;
  }
}
