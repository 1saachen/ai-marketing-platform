import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSettings, runSample } from './probe.mjs';
import { createVolcProbeClient } from './volc-probe-client.mjs';

const settings = {
  ttsKey: 'test-doubao-key',
  ttsSpeaker: 'test-speaker',
  ttsResource: 'seed-tts-2.0',
  mediaKitKey: 'test-mediakit-key',
};
const demoVideo = Buffer.from('video fixture');
const demoText = '测试文案';
const demoAudioUrl = 'https://tts.example.test/signed.mp3?secret=tts-fixture';
const demoOutputUrl = 'https://result.example.test/signed.mp4?secret=output-fixture';
const demoUploadUrl = 'https://test.volcvod.com/temporary?secret=upload-fixture';
const taskId = 'amk-tool-lip-sync-1234567';
const videoFileId = 'mediakit://opaque-video-id';

async function testDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'avatar-probe-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function setupFetch({ abortSubmit } = {}) {
  const calls = [];
  let ttsId;
  let hasSubmitted = false;
  return {
    calls,
    fetchImpl: async (rawUrl, init) => {
      const url = new URL(rawUrl);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({
        path: url.pathname,
        method: init.method,
        headers: new Headers(init.headers),
        body,
      });
      switch (url.pathname) {
        case '/api/v3/tts/submit':
          ttsId = body.unique_id;
          assert.equal(new Headers(init.headers).get('X-Api-Key'), settings.ttsKey);
          assert.match(body.user.uid, /^\d+$/);
          assert.deepEqual(body.req_params.audio_params, {
            format: 'mp3',
            sample_rate: 24000,
            enable_timestamp: true,
          });
          assert.equal(body.req_params.additions, '{}');
          if (abortSubmit === 'tts') throw new Error(demoAudioUrl);
          return Response.json({ code: 20_000_000, data: { task_id: ttsId } });
        case '/api/v3/tts/query':
          assert.equal(body.task_id, ttsId);
          return Response.json({
            code: 20_000_000,
            data: {
              task_id: ttsId,
              task_status: 2,
              audio_url: demoAudioUrl,
              sentences: [
                { words: [{ word: '试', startTime: 0.32, endTime: 0.46, confidence: 0.9 }] },
              ],
            },
          });
        case '/signed.mp3':
          assert.equal(new Headers(init.headers).has('X-Api-Key'), false);
          return new Response('mp3', { status: 200 });
        case '/api/v1/tools-sync/request-media-upload-url':
          assert.equal(
            new Headers(init.headers).get('Authorization'),
            `Bearer ${settings.mediaKitKey}`,
          );
          return Response.json({
            success: true,
            result: {
              file_id: videoFileId,
              method: 'PUT',
              upload_headers: [{ key: 'x-provider-header', value: 'example' }],
              upload_url: demoUploadUrl,
            },
          });
        case '/temporary': {
          const headers = new Headers(init.headers);
          assert.equal(headers.get('content-type'), 'video/mp4');
          assert.equal(headers.get('x-provider-header'), 'example');
          assert.equal(headers.has('authorization'), false);
          assert.deepEqual(body, demoVideo);
          return new Response(null, { status: 200 });
        }
        case '/api/v1/tools/lip-sync':
          assert.equal(body.audio_url, demoAudioUrl);
          assert.equal(body.video_url, videoFileId);
          assert.equal(body.enable_video_loop, false);
          assert.equal(hasSubmitted, false);
          hasSubmitted = true;
          if (abortSubmit === 'lip-sync') throw new Error(demoUploadUrl);
          return Response.json({ success: true, task_id: taskId });
        case `/api/v1/tasks/${taskId}`:
          return Response.json({
            success: true,
            task_id: taskId,
            task_type: 'lip-sync',
            status: 'completed',
            result: { video_url: demoOutputUrl, duration: 22 },
          });
        case '/signed.mp4':
          return new Response('mp4', { status: 200 });
        default:
          assert.fail('Unexpected provider request');
      }
    },
  };
}

const probe = async () => 22;

test('executes a single sample and keeps volatile URLs, keys, and script out of state', async (t) => {
  const stateDir = await testDirectory(t);
  const { calls, fetchImpl } = setupFetch();
  const client = createVolcProbeClient(settings, { fetchImpl });
  const sample = { stateDir, settings, videoBytes: demoVideo, text: demoText, sourceDuration: 25 };
  await runSample(sample, client, probe);
  assert.equal(calls.length, 8);
  const state = await readFile(join(stateDir, 'state.json'), 'utf8');
  for (const secret of [
    demoAudioUrl,
    demoUploadUrl,
    demoOutputUrl,
    settings.ttsKey,
    settings.mediaKitKey,
    demoText,
  ]) {
    assert.equal(state.includes(secret), false);
  }
  assert.equal(JSON.parse(state).completed, true);
  assert.match(await readFile(join(stateDir, 'report.json'), 'utf8'), /PENDING_MANUAL_ANNOTATION/);
  await runSample(sample, client, probe);
  assert.equal(calls.length, 8);
  await assert.rejects(
    runSample({ ...sample, text: '另一段文案' }, client, probe),
    /与此前记录不一致/,
  );
});

test('a lost TTS submit response resumes by querying the frozen task only', async (t) => {
  const stateDir = await testDirectory(t);
  const { calls, fetchImpl } = setupFetch({ abortSubmit: 'tts' });
  const client = createVolcProbeClient(settings, { fetchImpl });
  const sample = { stateDir, settings, videoBytes: demoVideo, text: demoText, sourceDuration: 25 };
  await assert.rejects(runSample(sample, client, probe), {
    message: '提交豆包语音任务连接失败或超时。',
  });
  await runSample(sample, client, probe);
  assert.equal(calls.filter(({ path }) => path === '/api/v3/tts/submit').length, 1);
});

test('a lost lip-sync submit response only queries a manually reconciled task identifier', async (t) => {
  const stateDir = await testDirectory(t);
  const { calls, fetchImpl } = setupFetch({ abortSubmit: 'lip-sync' });
  const client = createVolcProbeClient(settings, { fetchImpl });
  const sample = { stateDir, settings, videoBytes: demoVideo, text: demoText, sourceDuration: 25 };
  await assert.rejects(runSample(sample, client, probe), {
    message: '提交 MediaKit 口型对齐任务连接失败或超时。',
  });
  await assert.rejects(runSample(sample, client, probe), /提交状态未知/);
  assert.equal(calls.length, 6);
  await runSample({ ...sample, recoveredTaskId: taskId }, client, probe);
  assert.equal(calls.filter(({ path }) => path === '/api/v1/tools/lip-sync').length, 1);
  assert.equal(calls.filter(({ path }) => path === `/api/v1/tasks/${taskId}`).length, 1);
});

test('does not send the source video if generated speech exceeds the video length', async (t) => {
  const stateDir = await testDirectory(t);
  const { calls, fetchImpl } = setupFetch();
  const client = createVolcProbeClient(settings, { fetchImpl });
  const sample = { stateDir, settings, videoBytes: demoVideo, text: demoText, sourceDuration: 20 };
  await assert.rejects(runSample(sample, client, probe), /源视频比驱动语音短/);
  assert.equal(
    calls.some(({ method }) => method === 'PUT'),
    false,
  );
});

test('fails before execution if MediaKit credentials are missing or a cloned speaker resource is selected', () => {
  const env = {
    VOLC_TTS_API_KEY: 'example',
    VOLC_TTS_SPEAKER: 'example',
    VOLC_TTS_RESOURCE_ID: 'seed-icl-2.0',
  };
  assert.throws(() => readSettings(env), /在本地配置/);
  assert.throws(() => readSettings({ ...env, VOLC_MEDIAKIT_API_KEY: 'example' }), /预置音色/);
});
