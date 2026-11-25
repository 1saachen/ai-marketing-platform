import { createHash } from 'node:crypto';
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { parseAvatarRenderReview } from '../../packages/contracts/dist/fission-avatar-render.js';
import { AVATAR_LONG_LIMITS } from '../../packages/contracts/dist/fission-avatar-long-sync.js';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sha256 = /^[a-f\d]{64}$/;

function reviewTarget(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      ['project', 'run', 'task', 'file', 'report'].map((name) => [name, { type: 'string' }]),
    ),
  });
  const [action] = positionals;
  const { project, run, task, file, report } = values;
  if (
    positionals.length !== 1 ||
    ![project, run, task].every((id) => uuid.test(id ?? '')) ||
    !(
      (['candidate', 'timeline'].includes(action) && file && !report) ||
      (action === 'submit' && report && !file)
    )
  ) {
    throw new Error(
      '用法为 candidate 或 timeline --project UUID --run UUID --task UUID --file 路径，或 submit --project UUID --run UUID --task UUID --report 路径',
    );
  }

  const token = process.env.FISSION_AVATAR_RENDER_REVIEW_TOKEN?.trim();
  const apiBase = process.env.INTERNAL_API_BASE_URL?.trim();
  if (!token || !apiBase) throw new Error('请设置评审凭据和内部 API 地址');
  const base = new URL(apiBase);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    !(base.protocol === 'https:' || (base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/\/api\/?$/.test(base.pathname)
  ) {
    throw new Error('内部 API 地址须以 /api 结尾，并使用 HTTPS 或本机 HTTP');
  }
  const path = `${base.href.replace(/\/$/, '')}/internal/workers/fission-avatar/${project}/${run}/render/tasks/${task}`;
  const request = (suffix, options = {}) =>
    fetch(`${path}/${suffix}`, {
      ...options,
      headers: { 'x-review-token': token, ...options.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  return { action, file, report, request };
}

async function saveCandidate(response, file) {
  if (!response.ok) throw new Error(`读取候选成片失败（HTTP ${response.status}）`);
  const expected = response.headers.get('x-content-sha256');
  if (!sha256.test(expected ?? '') || !response.body) throw new Error('候选成片缺少内容摘要');
  const handle = await open(file, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > AVATAR_LONG_LIMITS.maxVideoBytes) {
        callback(new Error('候选成片超过容量限制'));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verify, handle.createWriteStream());
    if (bytes === 0 || digest.digest('hex') !== expected) throw new Error('候选成片摘要不匹配');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw error;
  }
  process.stdout.write(`已保存评审候选成片，SHA-256 为 ${expected}\n`);
}

async function saveTimeline(response, file) {
  if (!response.ok) throw new Error(`读取候选接缝失败（HTTP ${response.status}）`);
  const timeline = (await response.json()).data;
  if (timeline?.schemaVersion !== 2) throw new Error('成片接缝回执格式无效');
  parseAvatarRenderReview({
    sha256: timeline.candidateSha256,
    method: 'timeline-validation',
    coveragePermille: 0,
    confidencePermille: 0,
    maxAbsOffsetMs: 0,
    evidence: {
      durationMs: timeline.durationMs,
      seamTimesMs: timeline.seamTimesMs,
      accuracyPermille: 0,
    },
  });
  await writeFile(file, JSON.stringify(timeline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write('已保存候选成片接缝记录\n');
}

async function submitReview(request, path) {
  const handle = await open(path, 'r');
  let report;
  try {
    const { size } = await handle.stat();
    if (size < 1 || size > 4096) throw new Error('评审报告超过容量限制或为空');
    report = parseAvatarRenderReview(JSON.parse(await readFile(handle, 'utf8')));
  } finally {
    await handle.close();
  }
  const response = await request('review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`提交口型校验报告失败（HTTP ${response.status}）`);
  const result = (await response.json()).data;
  if (result?.accepted !== true || typeof result.passed !== 'boolean') {
    throw new Error('评审响应缺少提交回执');
  }
  process.stdout.write(result.passed ? '已发布通过校验的成片\n' : '已记录校验未通过，成片未发布\n');
}

try {
  const target = reviewTarget(process.argv.slice(2));
  if (target.action === 'candidate')
    await saveCandidate(await target.request('candidate'), target.file);
  else if (target.action === 'timeline')
    await saveTimeline(await target.request('candidate/timeline'), target.file);
  else await submitReview(target.request, target.report);
} catch (error) {
  const message = error instanceof SyntaxError ? '内部 API 地址或评审报告格式无效' : error.message;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
