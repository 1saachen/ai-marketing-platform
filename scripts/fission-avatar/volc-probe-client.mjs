import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ttsBase = 'https://openspeech.bytedance.com/api/v3/tts';
const mediaKitBase = 'https://mediakit.cn-beijing.volces.com/api/v1';
const mediaKitUploadHosts = ['volcvod.com', 'volces.com', 'volcengine.com'];
export const sampleDurationLimit = 30;
export const sampleVideoBytesLimit = 64 * 1024 * 1024;
const sampleAudioBytesLimit = 8 * 1024 * 1024;

export class ProbeError extends Error {}

export function assertProbe(condition, message) {
  if (!condition) throw new ProbeError(message);
}

export function isLipSyncTaskId(value) {
  return typeof value === 'string' && /^amk-tool-lip-sync-[A-Za-z0-9_-]{1,120}$/.test(value);
}

export function isMediaKitFileId(value) {
  return typeof value === 'string' && /^mediakit:\/\/[A-Za-z0-9_-]{1,1024}$/.test(value);
}

function isDuration(value) {
  return Number.isFinite(value) && value > 0 && value <= sampleDurationLimit;
}

function httpsUrl(value, purpose, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeError(`${purpose}缺少有效的 HTTPS 地址。`);
  }
  const hostAllowed =
    !allowedHosts ||
    allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  assertProbe(
    url.protocol === 'https:' && !url.username && !url.password && !url.port && hostAllowed,
    `${purpose}返回了不受支持的传输地址。`,
  );
  return url;
}

async function request(fetchImpl, url, action, init, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProbeError(`${action}连接失败或超时。`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeError(`${action}失败（HTTP ${response.status}）。`);
  }
  return response;
}

async function readBody(response, maxBytes, label) {
  assertProbe(
    response.body && Number(response.headers.get('content-length')) <= maxBytes,
    `${label}响应缺失或超过大小限制。`,
  );
  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytesRead += chunk.value.length;
      assertProbe(bytesRead <= maxBytes, `${label}超过大小限制。`);
      chunks.push(chunk.value);
    }
    assertProbe(bytesRead > 0, `${label}为空。`);
    return Buffer.concat(chunks, bytesRead);
  } finally {
    await reader.cancel();
  }
}

async function jsonRequest(fetchImpl, url, action, headers, body) {
  const response = await request(
    fetchImpl,
    url,
    action,
    body === undefined
      ? { method: 'GET', headers }
      : {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
    30_000,
  );
  let value;
  try {
    value = JSON.parse((await readBody(response, 512 * 1024, action)).toString('utf8'));
  } catch {
    throw new ProbeError(`${action}返回了无法读取的数据。`);
  }
  assertProbe(value && typeof value === 'object', `${action}返回了无效的数据。`);
  return value;
}

function checkDoubao(response, action) {
  if (response.code === 20_000_000) return response.data;
  const code = Number.isSafeInteger(response.code) ? `，代码 ${response.code}` : '';
  throw new ProbeError(`${action}失败（豆包${code}）。`);
}

function checkMediaKit(response, action) {
  if (response.success === true) return response;
  const code = response.error?.code;
  const codeDetail =
    typeof code === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(code) ? `，${code}` : '';
  throw new ProbeError(`${action}失败（MediaKit${codeDetail}）。`);
}

async function poll(action, intervalMs, timeoutMs, wait, query) {
  const deadline = Date.now() + timeoutMs;
  do {
    const finished = await query();
    if (finished) return finished;
    await wait(intervalMs);
  } while (Date.now() < deadline);
  throw new ProbeError(`${action}轮询超时。保留状态目录后可继续查询。`);
}

function readWordTimings(sentences) {
  if (!Array.isArray(sentences)) return [];
  return sentences.flatMap((sentence) => {
    const words = sentence?.words;
    if (!Array.isArray(words)) return [];
    return words
      .filter(
        (word) =>
          Number.isFinite(word?.startTime) &&
          Number.isFinite(word.endTime) &&
          word.startTime >= 0 &&
          word.endTime >= word.startTime &&
          word.endTime <= sampleDurationLimit,
      )
      .map((word) => ({
        startMs: Math.round(word.startTime * 1000),
        endMs: Math.round(word.endTime * 1000),
        confidence:
          Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 1
            ? word.confidence
            : null,
      }));
  });
}

export function createVolcProbeClient(
  { ttsKey, ttsSpeaker, ttsResource, mediaKitKey },
  { fetchImpl = globalThis.fetch, wait = delay } = {},
) {
  const ttsHeaders = () => ({
    'X-Api-Key': ttsKey,
    'X-Api-Resource-Id': ttsResource,
    'X-Api-Request-Id': randomUUID(),
  });
  const mediaKitHeaders = { Authorization: `Bearer ${mediaKitKey}` };

  return {
    async submitTts(operationId, text) {
      const action = '提交豆包语音任务';
      const response = await jsonRequest(fetchImpl, `${ttsBase}/submit`, action, ttsHeaders(), {
        user: { uid: '20261124' },
        unique_id: operationId,
        req_params: {
          text,
          speaker: ttsSpeaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 24_000,
            enable_timestamp: true,
          },
          additions: '{}',
        },
      });
      const data = checkDoubao(response, action);
      assertProbe(data?.task_id === operationId, '豆包语音返回了与请求不一致的任务标识。');
    },

    async getTtsResult(operationId) {
      const action = '查询豆包语音任务';
      return poll(action, 2_000, 120_000, wait, async () => {
        const response = await jsonRequest(fetchImpl, `${ttsBase}/query`, action, ttsHeaders(), {
          task_id: operationId,
        });
        const data = checkDoubao(response, action);
        assertProbe(data?.task_id === operationId, '豆包语音查询结果的任务标识不一致。');
        if (data.task_status === 1) return null;
        assertProbe(data.task_status === 2, '豆包语音任务失败或返回未知状态。');
        const wordTimings = readWordTimings(data.sentences);
        assertProbe(wordTimings.length > 0, '豆包语音完成，但没有可用的字级时间戳。');
        return {
          audioUrl: httpsUrl(data.audio_url, '豆包语音结果'),
          wordTimings,
        };
      });
    },

    async downloadTts(audioUrl) {
      const action = '下载豆包语音结果';
      const response = await request(fetchImpl, audioUrl, action, { method: 'GET' }, 90_000);
      return readBody(response, sampleAudioBytesLimit, action);
    },

    async uploadVideo(videoBytes) {
      const action = '申请 MediaKit 视频上传地址';
      const response = await jsonRequest(
        fetchImpl,
        `${mediaKitBase}/tools-sync/request-media-upload-url`,
        action,
        mediaKitHeaders,
        {},
      );
      const result = checkMediaKit(response, action).result;
      assertProbe(
        result?.method === 'PUT' &&
          isMediaKitFileId(result.file_id) &&
          Array.isArray(result.upload_headers),
        'MediaKit 视频上传凭证格式无效。',
      );
      const headers = new Headers();
      for (const { key, value } of result.upload_headers) {
        assertProbe(
          typeof key === 'string' && typeof value === 'string',
          'MediaKit 视频上传请求头格式无效。',
        );
        headers.set(key, value);
      }
      if (!headers.has('content-type')) headers.set('content-type', 'video/mp4');
      const put = await request(
        fetchImpl,
        httpsUrl(result.upload_url, 'MediaKit 视频上传凭证', mediaKitUploadHosts),
        '上传授权视频',
        { method: 'PUT', headers, body: videoBytes },
        90_000,
      );
      await put.body?.cancel();
      return result.file_id;
    },

    async submitLipSync({ clientToken, videoFileId, audioUrl }) {
      const action = '提交 MediaKit 口型对齐任务';
      const response = await jsonRequest(
        fetchImpl,
        `${mediaKitBase}/tools/lip-sync`,
        action,
        mediaKitHeaders,
        {
          client_token: clientToken,
          video_url: videoFileId,
          audio_url: audioUrl.href,
          enable_video_loop: false,
        },
      );
      const taskId = checkMediaKit(response, action).task_id;
      assertProbe(isLipSyncTaskId(taskId), 'MediaKit 返回了无效的口型任务标识。');
      return taskId;
    },

    async getLipSyncResult(taskId) {
      const action = '查询 MediaKit 口型对齐任务';
      assertProbe(isLipSyncTaskId(taskId), '口型任务标识无效。');
      return poll(action, 5_000, 600_000, wait, async () => {
        const response = await jsonRequest(
          fetchImpl,
          `${mediaKitBase}/tasks/${taskId}`,
          action,
          mediaKitHeaders,
        );
        const result = checkMediaKit(response, action);
        assertProbe(
          result.task_id === taskId && (!result.task_type || result.task_type === 'lip-sync'),
          'MediaKit 查询结果的任务类型或标识不一致。',
        );
        if (result.status === 'running') return null;
        assertProbe(result.status === 'completed', 'MediaKit 口型任务失败或返回未知状态。');
        assertProbe(isDuration(result.result?.duration), 'MediaKit 返回的成片超出小样时长范围。');
        return {
          videoUrl: httpsUrl(result.result.video_url, 'MediaKit 口型对齐结果'),
          providerDuration: result.result.duration,
        };
      });
    },

    async downloadLipSync(videoUrl) {
      const action = '下载 MediaKit 口型对齐结果';
      const response = await request(fetchImpl, videoUrl, action, { method: 'GET' }, 90_000);
      return readBody(response, sampleVideoBytesLimit, action);
    },
  };
}
