import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessAnnotatedSync } from './check-sync.mjs';

const durationMs = 66_000;
const sample = (audioMs, offsetMs = 0, uncertaintyMs = 0) => ({
  audioMs,
  mouthMs: audioMs + offsetMs,
  uncertaintyMs,
});
const report = (samples, seamTimesMs = [20_000, 43_000]) =>
  assessAnnotatedSync({ durationMs, seamTimesMs, samples });

test('calibrates signed 80, 100 and 120 ms shifts at clip and seam windows', () => {
  for (const offsetMs of [-120, -100, -80, 80, 100, 120]) {
    const samples = [1_900, 19_950, 33_000, 43_100, 64_000].map((time) => sample(time, offsetMs));
    const result = report(samples);
    assert.equal(result.status, Math.abs(offsetMs) > 100 ? 'exceeds_limit' : 'within_limit');
    assert.equal(result.maxAbsOffsetMs, Math.abs(offsetMs));
    assert.equal(result.events[0].offsetMs, offsetMs);
    assert.ok(result.coverage.every((window) => window.sampleCount > 0));
  }
});

test('blocks a single late drift or seam error even if the other samples are aligned', () => {
  const atHead = sample(1_000);
  const atMiddle = sample(33_000);
  const atTail = sample(65_000);
  const atFirstSeam = sample(20_000);
  const atLastSeam = sample(43_000);

  assert.equal(
    report([atHead, atMiddle, sample(65_000, 130), atFirstSeam, atLastSeam]).status,
    'exceeds_limit',
  );
  assert.equal(
    report([atHead, atMiddle, atTail, atFirstSeam, sample(43_000, -110)]).status,
    'exceeds_limit',
  );
});

test('blocks missing seam coverage and ambiguous near-threshold measurements', () => {
  const samples = [sample(1_000), sample(33_000), sample(65_000), sample(20_500)];
  assert.equal(report(samples).status, 'inconclusive');
  assert.equal(report([...samples, sample(43_000, 90, 11)]).status, 'inconclusive');
  assert.equal(report([...samples, sample(43_000, -80, 20)]).status, 'within_limit');
  assert.equal(report([...samples, sample(43_000, 120, 19)]).status, 'exceeds_limit');
});

test('validates timestamps and seam order before measuring', () => {
  assert.throws(() => report([sample(10, -20)]), TypeError);
  assert.throws(() => report([], [43_000, 20_000]), TypeError);
});
