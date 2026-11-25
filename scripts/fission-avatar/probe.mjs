import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  assertProbe,
  createVolcProbeClient,
  isLipSyncTaskId,
  isMediaKitFileId,
  ProbeError,
  sampleDurationLimit,
  sampleVideoBytesLimit,
} from './volc-probe-client.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const ffprobe = promisify(execFile);
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const fingerprintPattern = /^[\da-f]{64}$/;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inputFingerprint(videoBytes, text, settings) {
  return hash(
    JSON.stringify([hash(videoBytes), hash(text), settings.ttsSpeaker, settings.ttsResource]),
  );
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomically(path, contents) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJson(path, value) {
  await writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function insideRepo(path, repoPath = repo) {
  const relativePath = relative(repoPath, path);
  return (
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !relativePath.startsWith('..\\')
  );
}

async function withStateDirectory(stateDir, run) {
  const directory = resolve(stateDir);
  assertProbe(!insideRepo(directory), '小样状态目录必须位于代码仓库之外。');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const resolvedDirectory = await realpath(directory);
  assertProbe(
    !insideRepo(resolvedDirectory, await realpath(repo)),
    '小样状态目录必须位于代码仓库之外。',
  );
  const lockPath = join(resolvedDirectory, 'probe.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new ProbeError('已有小样进程持有该状态目录。');
    throw error;
  }
  try {
    return await run(resolvedDirectory);
  } finally {
    await handle.close();
    await rm(lockPath);
  }
}

async function readState(path, fingerprint) {
  if (!(await fileExists(path))) {
    return {
      schemaVersion: 1,
      fingerprint,
      ttsOperationId: randomUUID(),
      mediaKitClientToken: randomUUID(),
      ttsStarted: false,
      lipSyncStarted: false,
      videoFileId: null,
      lipSyncTaskId: null,
      completed: false,
    };
  }
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ProbeError('小样记录不可读取，请先确认原任务状态。');
  }
  assertProbe(
    state?.schemaVersion === 1 &&
      fingerprintPattern.test(state.fingerprint) &&
      uuidPattern.test(state.ttsOperationId) &&
      uuidPattern.test(state.mediaKitClientToken) &&
      typeof state.ttsStarted === 'boolean' &&
      typeof state.lipSyncStarted === 'boolean' &&
      typeof state.completed === 'boolean' &&
      (state.videoFileId === null || isMediaKitFileId(state.videoFileId)) &&
      (state.lipSyncTaskId === null || isLipSyncTaskId(state.lipSyncTaskId)) &&
      (!state.lipSyncStarted || (state.ttsStarted && state.videoFileId)) &&
      (!state.lipSyncTaskId || state.lipSyncStarted) &&
      (!state.completed || state.lipSyncTaskId),
    '小样记录状态无效，请先核对服务商任务。',
  );
  assertProbe(
    state.fingerprint === fingerprint,
    '小样输入与此前记录不一致，请用同一视频、文案和音色恢复。',
  );
  return state;
}

export async function probeMedia(
  path,
  kind,
  command = process.env.FISSION_AVATAR_FFPROBE_PATH || 'ffprobe',
) {
  let details;
  try {
    const { stdout } = await ffprobe(
      command,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        kind === 'audio' ? 'mp3' : 'mov',
        '-show_entries',
        'format=duration:stream=codec_type,color_transfer',
        '-of',
        'json',
        path,
      ],
      { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true },
    );
    details = JSON.parse(stdout);
  } catch {
    throw new ProbeError('媒体无法探测。请检查文件格式和 ffprobe 是否可运行。');
  }
  const duration = Number(details.format?.duration);
  const streams = Array.isArray(details.streams) ? details.streams : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video');
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  assertProbe(
    Number.isFinite(duration) && duration > 0 && duration <= sampleDurationLimit,
    '小样的媒体时长必须大于 0 秒且不超过 30 秒。',
  );
  if (kind === 'audio') {
    assertProbe(
      audioStreams.length === 1 && videoStreams.length === 0,
      '合成语音缺少有效的 MP3 音轨。',
    );
  } else {
    assertProbe(videoStreams.length === 1, '小样 MP4 必须包含一路视频流。');
    const hasHdr = ['smpte2084', 'arib-std-b67'].includes(videoStreams[0].color_transfer);
    assertProbe(!hasHdr, '小样仅接受 SDR 视频。');
    if (kind === 'input') {
      assertProbe(streams.length === 1, '小样的原始 MP4 只保留授权画面，请先移除音轨和其他轨道。');
    } else {
      assertProbe(audioStreams.length === 1, '口型小样结果必须包含一路音轨。');
    }
  }
  return duration;
}

export async function readSample(videoPath, textPath) {
  let videoBytes;
  let text;
  try {
    const video = await stat(videoPath);
    assertProbe(
      video.isFile() &&
        video.size > 0 &&
        video.size <= sampleVideoBytesLimit &&
        /\.mp4$/i.test(videoPath),
      '小样视频必须是本地 MP4 文件，大小不超过 64 MiB。',
    );
    videoBytes = await readFile(videoPath);
    const script = await stat(textPath);
    assertProbe(script.isFile() && script.size <= 2_048, '小样文案必须是本地 UTF-8 文本文件。');
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(textPath)).trim();
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('小样输入文件不可读取。');
  }
  const characters = Array.from(text);
  const hasControlCharacter = characters.some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && !'\t\r\n'.includes(character)) || code === 127;
  });
  assertProbe(
    characters.length > 0 && characters.length <= 120 && !hasControlCharacter,
    '小样文案须为 1–120 字的可读文本。',
  );
  return { videoBytes, text };
}

export function readSettings(environment) {
  const ttsKey = environment.VOLC_TTS_API_KEY?.trim();
  const ttsSpeaker = environment.VOLC_TTS_SPEAKER?.trim();
  const ttsResource = environment.VOLC_TTS_RESOURCE_ID?.trim() || 'seed-tts-2.0';
  const mediaKitKey = environment.VOLC_MEDIAKIT_API_KEY?.trim();
  assertProbe(
    ttsKey && ttsSpeaker && mediaKitKey,
    '请在本地配置 VOLC_TTS_API_KEY、VOLC_TTS_SPEAKER 与 VOLC_MEDIAKIT_API_KEY。',
  );
  assertProbe(ttsResource === 'seed-tts-2.0', '本次小样仅使用豆包语音合成 2.0 的普通话预置音色。');
  return { ttsKey, ttsSpeaker, ttsResource, mediaKitKey };
}

export async function runSample(
  { stateDir, videoBytes, text, sourceDuration, settings, recoveredTaskId },
  client = createVolcProbeClient(settings),
  probe = probeMedia,
) {
  return withStateDirectory(stateDir, async (directory) => {
    const statePath = join(directory, 'state.json');
    const state = await readState(statePath, inputFingerprint(videoBytes, text, settings));
    const change = async (changes) => {
      Object.assign(state, changes);
      await writeJson(statePath, state);
    };
    const audioPath = join(directory, 'speech.mp3');
    const captionsPath = join(directory, 'word-timings.json');
    const videoPath = join(directory, 'lip-sync.mp4');
    const reportPath = join(directory, 'report.json');
    const hasLocalOutputs =
      (await fileExists(videoPath)) &&
      (await fileExists(audioPath)) &&
      (await fileExists(captionsPath)) &&
      (await fileExists(reportPath));
    if (recoveredTaskId) {
      assertProbe(
        isLipSyncTaskId(recoveredTaskId) && state.lipSyncStarted && !state.lipSyncTaskId,
        '只可在口型任务提交状态未知时恢复人工核对过的任务标识。',
      );
    }
    if (state.completed && hasLocalOutputs) return;
    if (!state.ttsStarted) {
      await change({ ttsStarted: true });
      await client.submitTts(state.ttsOperationId, text);
    }

    let audioDuration;
    let audioUrl;
    if (
      (!state.lipSyncTaskId && !recoveredTaskId) ||
      !(await fileExists(audioPath)) ||
      !(await fileExists(captionsPath))
    ) {
      assertProbe(
        !state.lipSyncStarted || state.lipSyncTaskId || recoveredTaskId,
        '口型任务提交状态未知。请查服务商任务记录后恢复，脚本不会重新提交。',
      );
      const speech = await client.getTtsResult(state.ttsOperationId);
      audioUrl = speech.audioUrl;
      await writeAtomically(audioPath, await client.downloadTts(audioUrl));
      audioDuration = await probe(audioPath, 'audio');
      assertProbe(audioDuration <= sourceDuration, '源视频比驱动语音短，请核对本次样片输入。');
      await writeJson(captionsPath, { wordTimings: speech.wordTimings });
    } else {
      audioDuration = await probe(audioPath, 'audio');
    }

    if (recoveredTaskId) {
      // Check provider ownership and type before persisting the manually reconciled identifier.
      const result = await client.getLipSyncResult(recoveredTaskId);
      await change({ lipSyncTaskId: recoveredTaskId });
      return saveResult(result);
    }

    if (!state.lipSyncTaskId) {
      if (!state.videoFileId) {
        await change({ videoFileId: await client.uploadVideo(videoBytes) });
      }
      await change({ lipSyncStarted: true });
      const taskId = await client.submitLipSync({
        clientToken: state.mediaKitClientToken,
        videoFileId: state.videoFileId,
        audioUrl,
      });
      await change({ lipSyncTaskId: taskId });
    }
    await saveResult(await client.getLipSyncResult(state.lipSyncTaskId));

    async function saveResult(result) {
      await writeAtomically(videoPath, await client.downloadLipSync(result.videoUrl));
      const outputDuration = await probe(videoPath, 'output');
      await writeJson(reportPath, {
        ttsTaskId: state.ttsOperationId,
        lipSyncTaskId: state.lipSyncTaskId,
        sourceDurationSeconds: sourceDuration,
        ttsDurationSeconds: audioDuration,
        lipSyncProviderDurationSeconds: result.providerDuration,
        lipSyncOutputDurationSeconds: outputDuration,
        syncMeasurement: 'PENDING_MANUAL_ANNOTATION',
      });
      await change({ completed: true });
    }
  });
}

async function main() {
  const help =
    '用法：node --env-file=.env scripts/fission-avatar/probe.mjs --video <授权MP4> --text-file <TXT> [--execute --state-dir <仓库外私有目录>]';
  let args;
  try {
    args = parseArgs({
      options: {
        help: { type: 'boolean' },
        execute: { type: 'boolean' },
        video: { type: 'string' },
        'text-file': { type: 'string' },
        'state-dir': { type: 'string' },
        'recover-mediakit-task-id': { type: 'string' },
      },
    }).values;
  } catch {
    throw new ProbeError(help);
  }
  if (args.help) {
    console.log(help);
    return;
  }
  assertProbe(args.video && args['text-file'], help);
  const videoPath = resolve(args.video);
  const { videoBytes, text } = await readSample(videoPath, resolve(args['text-file']));
  const sourceDuration = await probeMedia(videoPath, 'input');
  if (!args.execute) {
    console.log(
      `本地预检通过。视频 ${sourceDuration.toFixed(2)} 秒，文案 ${Array.from(text).length} 字。`,
    );
    return;
  }
  assertProbe(args['state-dir'], '执行网络小样时须指定 --state-dir。');
  await runSample({
    stateDir: args['state-dir'],
    videoBytes,
    text,
    sourceDuration,
    settings: readSettings(process.env),
    recoveredTaskId: args['recover-mediakit-task-id'],
  });
  console.log('小样文件已保存到状态目录。请继续人工标注并测量口型偏差。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof ProbeError ? error.message : '小样执行中止。请检查本地素材和状态目录。',
    );
    process.exitCode = 1;
  });
}
