import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  avatarRenderReviewPasses,
  parseAvatarRenderReview,
} from '../../packages/contracts/dist/fission-avatar-render.js';
import { scoreAnnotatedLipReview } from './score-lip-review.mjs';

// Synthetic times and arbitrary SHA-bound bytes exercise scoring and CLI guards only.
// A separate annotator and calibrated measurement must supply real candidate evidence.
const durationMs = 66_000;
const sha256 = 'a'.repeat(64);
const times = [
  2000, 5000, 10_000, 11_000, 16_000, 19_800, 20_200, 23_000, 27_000, 30_000, 33_000, 37_000,
  39_000, 42_600, 43_400, 46_000, 50_000, 54_000, 59_000, 63_000,
];

function label({ timestamps = times, offsetMs = 0, uncertaintyMs = 0 } = {}) {
  return {
    schemaVersion: 1,
    sha256,
    method: 'human-reviewed-example-v1',
    durationMs,
    seamTimesMs: [20_000, 43_000],
    units: timestamps.map((audioMs, index) => ({
      id: `unit-${index + 1}`,
      audioMs,
      measurement: {
        mouthMs: audioMs + offsetMs,
        uncertaintyMs,
        confidencePermille: 950,
        match: 'MATCHED',
      },
    })),
  };
}

function timelineReport(candidateSha256 = sha256) {
  return {
    schemaVersion: 1,
    candidateSha256,
    manifestSha256: 'c'.repeat(64),
    durationMs,
    fps: 30,
    frameCount: 1980,
    pictureTimeBase: '1/90000',
    pictureFirstPts: 0,
    pictureLastPts: 1979 * 3000,
    segments: [{ frameCount: 600 }, { frameCount: 690 }, { frameCount: 690 }],
    seams: [
      { frame: 600, pts: 600 * 3000, timeMs: 20_000 },
      { frame: 1290, pts: 1290 * 3000, timeMs: 43_000 },
    ],
    audioWindows: [],
  };
}

const score = (input, hash = sha256, timeline = timelineReport(hash), duration = durationMs) =>
  scoreAnnotatedLipReview(input, hash, timeline, duration);

test('produces only the exact G3-ready summary for an adequately scored independent inventory', () => {
  const report = score(label({ offsetMs: -80, uncertaintyMs: 20 }));
  assert.equal(report.diagnostics.status, 'ELIGIBLE');
  assert.equal(report.diagnostics.timelineVerified, true);
  assert.equal(report.diagnostics.probedDurationMs, 66_000);
  assert.equal(report.diagnostics.accuracyPermille, 1000);
  assert.equal(report.diagnostics.events[0].measurement.offsetMs, -80);
  assert.equal(report.diagnostics.windows.length, 7);
  assert.ok(report.diagnostics.windows.every(({ trustedUnits }) => trustedUnits > 0));
  assert.deepEqual(report.review, {
    sha256,
    method: 'human-reviewed-example-v1',
    coveragePermille: 1000,
    confidencePermille: 950,
    maxAbsOffsetMs: 100,
    evidence: { durationMs: 66_000, seamTimesMs: [20_000, 43_000], accuracyPermille: 1000 },
  });
  assert.ok(avatarRenderReviewPasses(parseAvatarRenderReview(report.review)));
});

test('accepts the authoritative G4 rendered candidate timeline and rejects shifted seams', () => {
  const input = label();
  const timeline = {
    schemaVersion: 2,
    candidateSha256: sha256,
    durationMs,
    seamTimesMs: input.seamTimesMs,
  };
  assert.deepEqual(
    scoreAnnotatedLipReview(input, sha256, timeline, durationMs).review.evidence.seamTimesMs,
    input.seamTimesMs,
  );
  assert.throws(
    () =>
      scoreAnnotatedLipReview(
        input,
        sha256,
        { ...timeline, seamTimesMs: [20_000, 43_001] },
        durationMs,
      ),
    /接缝时间/,
  );
});

test('separates known signed offset failures from timing uncertainty at the boundary', () => {
  for (const offsetMs of [-120, -100, -80, 80, 100, 120]) {
    const { review, diagnostics } = score(label({ offsetMs }));
    assert.equal(
      review?.maxAbsOffsetMs ?? null,
      Math.abs(offsetMs) <= 100 ? Math.abs(offsetMs) : null,
    );
    assert.equal(diagnostics.blockers.includes('OFFSET_EXCEEDS_LIMIT'), Math.abs(offsetMs) > 100);
    assert.equal(diagnostics.accuracyPermille, 1000);
  }
  const { review, diagnostics } = score(label({ offsetMs: 90, uncertaintyMs: 11 }));
  assert.equal(review, null);
  assert.equal(diagnostics.maxAbsOffsetMs, 101);
  assert.deepEqual(diagnostics.blockers, ['OFFSET_INCONCLUSIVE']);
});

test('keeps exact missing units in the denominator, with independent match accuracy', () => {
  const oneMissing = label();
  oneMissing.units[1].measurement = null;
  const passing = score(oneMissing);
  assert.equal(passing.review.coveragePermille, 950);
  assert.equal(passing.diagnostics.accuracyPermille, 950);
  assert.deepEqual(passing.diagnostics.events[1].issues, ['UNMEASURED']);

  const missingInNineteen = { ...oneMissing, units: oneMissing.units.slice(0, 19) };
  const missing = score(missingInNineteen);
  assert.equal(missing.diagnostics.coveragePermille, 947);
  assert.equal(missing.review, null);

  const lowAccuracy = label();
  lowAccuracy.units[2].measurement.match = 'MISMATCHED';
  lowAccuracy.units[3].measurement.match = 'MISMATCHED';
  const accuracy = score(lowAccuracy);
  assert.equal(accuracy.review, null);
  assert.equal(accuracy.diagnostics.coveragePermille, 1000);
  assert.equal(accuracy.diagnostics.accuracyPermille, 900);
  assert.deepEqual(accuracy.diagnostics.blockers, ['ACCURACY_BELOW_THRESHOLD']);
});

test('requires evidence from the middle, both sides of each seam and the tail', () => {
  const halfSeam = label({ timestamps: [1000, 20_000, 33_000, 42_400, 43_200, 63_000] });
  const { diagnostics, review } = score(halfSeam);
  assert.equal(review, null);
  assert.equal(diagnostics.coveragePermille, 1000);
  assert.deepEqual(diagnostics.blockers, ['MISSING_INTERVAL_EVIDENCE']);
  assert.deepEqual(
    diagnostics.windows.filter(({ trustedUnits }) => !trustedUnits).map(({ id }) => id),
    ['seam-20000-before'],
  );
  const noTail = score(label({ timestamps: [1000, 19_900, 20_200, 33_000, 42_900, 43_100] }));
  assert.ok(
    noTail.diagnostics.windows.some(({ id, audibleUnits }) => id === 'tail' && !audibleUnits),
  );
  assert.equal(noTail.review, null);
});

test('does not average away a late drift, local seam failure, or weak evidence', () => {
  const late = label();
  late.units[19].measurement.mouthMs += 152;
  late.units[6].measurement.mouthMs -= 120;
  late.units[7].measurement.confidencePermille = 799;
  const { diagnostics, review } = score(late);
  assert.equal(review, null);
  assert.equal(diagnostics.confidencePermille, 799);
  assert.equal(diagnostics.maxAbsOffsetMs, 152);
  assert.ok(diagnostics.blockers.includes('INSUFFICIENT_CONFIDENCE'));
  assert.ok(diagnostics.blockers.includes('OFFSET_EXCEEDS_LIMIT'));
  assert.deepEqual(diagnostics.windows.find(({ id }) => id === 'seam-20000-after').issueCounts, {
    OFFSET_EXCEEDS_LIMIT: 1,
  });
  assert.deepEqual(diagnostics.events[19].issues, ['OFFSET_EXCEEDS_LIMIT']);
});

test('reports zero coverage and no offset for an empty or occluded presentation', () => {
  const occluded = label();
  for (const unit of occluded.units) unit.measurement = null;
  for (const input of [label({ timestamps: [] }), occluded]) {
    const { diagnostics, review } = score(input);
    assert.equal(review, null);
    assert.equal(diagnostics.coveragePermille, 0);
    assert.equal(diagnostics.accuracyPermille, 0);
    assert.equal(diagnostics.confidencePermille, 0);
    assert.equal(diagnostics.maxAbsOffsetMs, null);
    assert.ok(diagnostics.blockers.includes('MISSING_INTERVAL_EVIDENCE'));
  }
});

test('rejects a changed candidate, unlabeled evidence, malformed syllables and invalid seams', () => {
  assert.throws(() => score(label(), 'b'.repeat(64)), /SHA-256/);
  assert.throws(() => score({ ...label(), schemaVersion: 2 }), /标注格式/);
  assert.throws(() => score({ ...label(), seamTimesMs: [43_000, 20_000] }), /接缝时间/);
  const duplicate = label();
  duplicate.units[1].id = duplicate.units[0].id;
  assert.throws(() => score(duplicate), /ID 须唯一/);
  const unmeasured = label();
  delete unmeasured.units[0].measurement;
  assert.throws(() => score(unmeasured), /音频时标/);
  const outOfRange = label();
  outOfRange.units[0].measurement.mouthMs = -1;
  assert.throws(() => score(outOfRange), /口型测量/);
});

test('rejects missing reports, impossible timebases, shortened duration and undeclared seams', () => {
  assert.throws(() => scoreAnnotatedLipReview(label(), sha256), /--timeline/);
  const report = timelineReport();
  assert.throws(() => score(label(), sha256, { ...report, fps: 25 }), /报告格式/);
  assert.throws(
    () => score(label(), sha256, { ...report, candidateSha256: 'b'.repeat(64) }),
    /时间线的候选 SHA-256/,
  );
  assert.throws(() => score(label(), sha256, report, 66_033), /探测到的实际成片/);
  assert.throws(
    () => score({ ...label(), durationMs: 65_999 }, sha256, report, 65_999),
    /实际成片时长/,
  );
  assert.throws(() => score({ ...label(), seamTimesMs: [20_000] }), /标注接缝时间/);
  const reordered = [...report.seams].reverse();
  assert.throws(() => score(label(), sha256, { ...report, seams: reordered }), /接缝顺序/);
  const conflictingSegments = [{ frameCount: 600 }, { frameCount: 690 }, { frameCount: 689 }];
  assert.throws(
    () => score(label(), sha256, { ...report, segments: conflictingSegments }),
    /段落帧数/,
  );
});

test('bounds duration, seam count and inventory size before producing diagnostics', () => {
  assert.throws(() => score({ ...label(), durationMs: 90_001 }), /上限/);
  assert.throws(() => score({ ...label(), seamTimesMs: Array(12).fill(1) }), /上限/);
  const rows = Array(1801).fill(label().units[0]);
  assert.throws(() => score({ ...label(), units: rows }), /上限/);
});

test('CLI requires an exact timeline for probed long media and separates diagnostics from review', async (t) => {
  const ffmpeg = process.env.FISSION_AVATAR_FFMPEG_PATH?.trim() || 'ffmpeg';
  const ffprobe = process.env.FISSION_AVATAR_FFPROBE_PATH?.trim() || 'ffprobe';
  if (
    [ffmpeg, ffprobe].some(
      (tool) => spawnSync(tool, ['-version'], { windowsHide: true }).status !== 0,
    )
  ) {
    t.skip(
      '需要 FFmpeg 和 FFprobe。请配置 FISSION_AVATAR_FFMPEG_PATH 和 FISSION_AVATAR_FFPROBE_PATH。',
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'avatar-lip-review-test-'));
  const candidate = join(root, 'candidate.mp4');
  const annotation = join(root, 'review.json');
  const timeline = join(root, 'timeline.json');
  t.after(async () => {
    for (const file of [candidate, annotation, timeline]) {
      await unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await rmdir(root);
  });
  const script = fileURLToPath(new URL('./score-lip-review.mjs', import.meta.url));
  const makeCandidate = (seconds, color) =>
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=32x32:r=30`,
        '-t',
        String(seconds),
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-video_track_timescale',
        '90000',
        candidate,
      ],
      { timeout: 15_000, windowsHide: true },
    );
  makeCandidate(66, 'navy');
  const bytes = await readFile(candidate);
  const labels = {
    ...label({ offsetMs: 30, uncertaintyMs: 17 }),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await writeFile(annotation, JSON.stringify(labels));
  const expectedTimeline = timelineReport(labels.sha256);
  await writeFile(timeline, JSON.stringify(expectedTimeline));
  const run = (...arguments_) =>
    spawnSync(process.execPath, [script, candidate, annotation, ...arguments_], {
      encoding: 'utf8',
    });
  const missingTimeline = run('--review');
  assert.equal(missingTimeline.status, 2);
  assert.match(missingTimeline.stderr, /--timeline/);
  assert.equal(missingTimeline.stdout, '');
  const review = run('--timeline', timeline, '--review');
  assert.equal(review.status, 0, review.stderr);
  assert.deepEqual(parseAvatarRenderReview(JSON.parse(review.stdout)), {
    sha256: labels.sha256,
    method: labels.method,
    coveragePermille: 1000,
    confidencePermille: 950,
    maxAbsOffsetMs: 47,
    evidence: { durationMs, seamTimesMs: labels.seamTimesMs, accuracyPermille: 1000 },
  });
  const diagnostic = JSON.parse(run('--timeline', timeline).stdout);
  assert.equal(diagnostic.status, 'ELIGIBLE');
  assert.equal(diagnostic.probedDurationMs, 66_000);
  await writeFile(timeline, '{ malformed');
  const malformed = run('--timeline', timeline, '--review');
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /长片时间线 JSON 无效/);
  assert.equal(malformed.stdout, '');
  await writeFile(
    timeline,
    JSON.stringify({ ...expectedTimeline, candidateSha256: 'd'.repeat(64) }),
  );
  const mismatched = run('--timeline', timeline, '--review');
  assert.equal(mismatched.status, 2);
  assert.match(mismatched.stderr, /时间线的候选 SHA-256/);
  assert.equal(mismatched.stdout, '');
  await writeFile(timeline, JSON.stringify(expectedTimeline));

  const shortened = {
    ...labels,
    durationMs: 25_000,
    seamTimesMs: [],
    units: labels.units.slice(0, 8),
  };
  await writeFile(annotation, JSON.stringify(shortened));
  const wrongDuration = run('--review');
  assert.equal(wrongDuration.status, 2);
  assert.match(wrongDuration.stderr, /探测到的实际成片/);
  assert.equal(wrongDuration.stdout, '');

  labels.units[0].measurement.confidencePermille = 10;
  await writeFile(annotation, JSON.stringify(labels));
  const blocked = run('--timeline', timeline, '--review');
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout, '');
  assert.match(blocked.stderr, /证据暂缓/);
  makeCandidate(66, 'red');
  const changed = run('--timeline', timeline);
  assert.equal(changed.status, 2);
  assert.equal(changed.stdout, '');
  assert.match(changed.stderr, /SHA-256/);
  makeCandidate(15, 'green');
  const shortSha = createHash('sha256')
    .update(await readFile(candidate))
    .digest('hex');
  const validShort = {
    ...label({ timestamps: [1000, 6000, 11_000] }),
    sha256: shortSha,
    durationMs: 15_000,
    seamTimesMs: [],
  };
  await writeFile(annotation, JSON.stringify(validShort));
  const short = run('--review');
  assert.equal(short.status, 0, short.stderr);
  assert.equal(parseAvatarRenderReview(JSON.parse(short.stdout)).sha256, shortSha);
  assert.match(
    execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }),
    /只计算提供的标注/,
  );
});
