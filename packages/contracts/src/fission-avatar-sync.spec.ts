import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_SYNC_LIMITS,
  FISSION_AVATAR_SYNC_CHECKPOINT_SCHEMA,
  FISSION_AVATAR_SYNC_COMPLETION_SCHEMA,
  FISSION_AVATAR_SYNC_WORKER_INPUT_SCHEMA,
  parseAvatarSyncCheckpoint,
  parseAvatarSyncCompletion,
  parseAvatarSyncCreateRequest,
  parseAvatarSyncFailure,
  parseAvatarSyncHeartbeat,
  parseAvatarSyncWorkerInput,
} from './fission-avatar-sync';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const completion = {
  audioDurationMs: 5592,
  videoDurationMs: 5600,
  audioLagMs: 0,
  minimumAudioCorrelationPermille: 999,
  wordTimings: [
    { text: '大', startMs: 0, endMs: 95, confidencePermille: 900 },
    { text: '家', startMs: 95, endMs: 215, confidencePermille: null },
  ],
};
const worker = {
  schemaVersion: 1,
  scriptText: '大家好。',
  voiceSpeaker: 'zh_female_vv_uranus_bigtts',
  characterSizeBytes: 1000,
  ttsOperationId: first,
  ttsStarted: true,
  lipSyncClientToken: second,
  lipSyncStarted: true,
  lipSyncTaskId: 'amk-tool-lip-sync-example',
};

describe('avatar sync contracts', () => {
  it.each([
    FISSION_AVATAR_SYNC_CHECKPOINT_SCHEMA,
    FISSION_AVATAR_SYNC_WORKER_INPUT_SCHEMA,
    FISSION_AVATAR_SYNC_COMPLETION_SCHEMA,
  ])('publishes the same schema used by the worker ($id)', (schema) => {
    expect(
      JSON.parse(readFileSync(resolve(__dirname, '..', 'schemas', schema.$id!), 'utf8')),
    ).toEqual(schema);
  });

  it('requires confirmed references and an editing revision for task creation', () => {
    const request = {
      idempotencyKey: first,
      expectedDraftRevision: 0,
      binding: { artifactId: first, revision: 2 },
      script: { artifactId: second, revision: 3 },
    };
    expect(parseAvatarSyncCreateRequest(request)).toEqual(request);
    expect(() => parseAvatarSyncCreateRequest({ ...request, script: { revision: 3 } })).toThrow();
    expect(() =>
      parseAvatarSyncCreateRequest({ ...request, voiceId: 'client-injected' }),
    ).toThrow();
  });

  it('keeps progress, paid submission reservation and failure shapes distinct', () => {
    expect(parseAvatarSyncHeartbeat({ phase: 'TTS', progress: 25 })).toEqual({
      phase: 'TTS',
      progress: 25,
    });
    expect(() => parseAvatarSyncHeartbeat({ phase: 'COMPLETE', progress: 99 })).toThrow();
    expect(parseAvatarSyncCheckpoint({ kind: 'TTS_SUBMIT' })).toEqual({ kind: 'TTS_SUBMIT' });
    const accepted = { kind: 'LIP_SYNC_ACCEPTED', providerTaskId: 'amk-tool-lip-sync-sample' };
    expect(parseAvatarSyncCheckpoint(accepted)).toEqual(accepted);
    expect(() =>
      parseAvatarSyncCheckpoint({ ...accepted, providerTaskId: 'remote/url' }),
    ).toThrow();
    expect(() => parseAvatarSyncFailure({ code: 'UNKNOWN_NEW_STATE', retryable: true })).toThrow();
  });

  it.each([
    { schemaVersion: 2 },
    { voiceSpeaker: 'S_cloned_voice' },
    { scriptText: '字'.repeat(AVATAR_SYNC_LIMITS.maxScriptCharacters + 1) },
    { characterSizeBytes: AVATAR_SYNC_LIMITS.maxCharacterBytes + 1 },
    { td: 'unexpected provider token' },
    { lipSyncStarted: false },
    { ttsStarted: false },
  ])('rejects invalid frozen input (%j)', (patch) => {
    expect(() => parseAvatarSyncWorkerInput({ ...worker, ...patch })).toThrow();
  });

  it('accepts a frozen input with already-known provider IDs', () => {
    expect(parseAvatarSyncWorkerInput(worker)).toEqual(worker);
  });

  it.each([
    { audioDurationMs: 30_001 },
    { videoDurationMs: 5693 },
    { audioLagMs: -101 },
    { minimumAudioCorrelationPermille: 979 },
    { wordTimings: [] },
    { wordTimings: [{ text: '大', startMs: 93, endMs: 20, confidencePermille: null }] },
    { wordTimings: [{ text: '大', startMs: 5590, endMs: 5593, confidencePermille: null }] },
    { wordTimings: [...completion.wordTimings].reverse() },
  ])('rejects invalid completed media metadata (%j)', (patch) => {
    expect(() => parseAvatarSyncCompletion({ ...completion, ...patch })).toThrow();
  });

  it('accepts the driving audio check and timestamps at valid bounds', () => {
    expect(parseAvatarSyncCompletion(completion)).toEqual(completion);
    expect(
      parseAvatarSyncCompletion({
        ...completion,
        audioLagMs: -100,
        minimumAudioCorrelationPermille: 980,
        audioDurationMs: 5500,
        videoDurationMs: 5600,
      }),
    ).toMatchObject({ minimumAudioCorrelationPermille: 980 });
  });
});
