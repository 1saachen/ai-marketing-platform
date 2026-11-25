import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_TAIL_CHAIN_MODEL,
  FISSION_AVATAR_TAIL_CHAIN_CHECKPOINT_SCHEMA,
  FISSION_AVATAR_TAIL_CHAIN_WORKER_INPUT_SCHEMA,
  parseAvatarTailChainCheckpoint,
  parseAvatarTailChainWorkerInput,
} from './fission-avatar-tail-chain';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceLength = 306_000;
const slice = (index: number) => ({
  sourceStartSample: index * sourceLength,
  sourceEndSample: (index + 1) * sourceLength,
  leadingSilenceSamples: 3000,
  durationSeconds: 13,
});
const plan = {
  masterSha256: 'a'.repeat(64),
  sourceSamples: 5 * sourceLength,
  segments: Array.from({ length: 5 }, (_, index) => slice(index)),
};
const initial = {
  schemaVersion: 3,
  voiceSpeaker: 'zh_female_vv_uranus_bigtts',
  scriptText: '今天讲一件事。',
  sourceTaskId: 'cgt-native',
  model: AVATAR_TAIL_CHAIN_MODEL,
  ttsOperationId: uuid(0),
  ttsStarted: false,
  plan: null,
  segments: [],
};
const segment = (ordinal: number) => ({
  ordinal,
  pictureStarted: false,
  pictureTaskId: null,
  lipSyncClientToken: uuid(ordinal),
  lipSyncStarted: false,
  lipSyncTaskId: null,
  result: null,
});
const running = {
  ...initial,
  ttsStarted: true,
  plan,
  segments: Array.from({ length: 5 }, (_, index) => segment(index + 1)),
};

describe('avatar tail chain contracts', () => {
  it.each([
    FISSION_AVATAR_TAIL_CHAIN_WORKER_INPUT_SCHEMA,
    FISSION_AVATAR_TAIL_CHAIN_CHECKPOINT_SCHEMA,
  ])('publishes the Python schema ($id)', (schema) => {
    expect(
      JSON.parse(readFileSync(resolve(__dirname, '..', 'schemas', schema.$id!), 'utf8')),
    ).toEqual(schema);
  });

  it('accepts an initial claim, a frozen plan and the first native picture receipt', () => {
    expect(parseAvatarTailChainWorkerInput(initial)).toEqual(initial);
    expect(parseAvatarTailChainCheckpoint({ kind: 'PLAN_READY', plan })).toEqual({
      kind: 'PLAN_READY',
      plan,
    });
    const picture = { ...segment(1), pictureStarted: true, pictureTaskId: 'cgt-first' };
    expect(
      parseAvatarTailChainWorkerInput({
        ...running,
        segments: [picture, ...running.segments.slice(1)],
      }).segments[0],
    ).toEqual(picture);
  });

  it('rejects extra URLs, incomplete requests and unknown checkpoint kinds', () => {
    for (const value of [
      { kind: 'PICTURE_ACCEPTED', ordinal: 1 },
      { kind: 'PICTURE_ACCEPTED', ordinal: 1, providerTaskId: 'https://example.com/signed' },
      {
        kind: 'PICTURE_ACCEPTED',
        ordinal: 1,
        providerTaskId: 'cgt-1',
        tailUrl: 'https://example.com',
      },
      { kind: 'TTS_SUBMIT' },
    ]) {
      expect(() => parseAvatarTailChainCheckpoint(value)).toThrow();
    }
  });

  it('rejects sample gaps, excess silence and output duration below the G4 limit', () => {
    const shorter = Array.from({ length: 5 }, (_, index) => ({
      sourceStartSample: index * 12 * 24_000,
      sourceEndSample: (index + 1) * 12 * 24_000,
      leadingSilenceSamples: 0,
      durationSeconds: 12,
    }));
    for (const value of [
      {
        ...plan,
        segments: [{ ...slice(0), sourceEndSample: sourceLength - 1 }, ...plan.segments.slice(1)],
      },
      {
        ...plan,
        segments: [{ ...slice(0), leadingSilenceSamples: 6001 }, ...plan.segments.slice(1)],
      },
      { ...plan, sourceSamples: 60 * 24_000, segments: shorter },
    ]) {
      expect(() => parseAvatarTailChainCheckpoint({ kind: 'PLAN_READY', plan: value })).toThrow();
    }
  });

  it('rejects partial plans and receipts that skip a predecessor or reuse the seed ID', () => {
    for (const value of [
      { ...initial, segments: [segment(1)] },
      { ...running, ttsStarted: false },
      {
        ...running,
        segments: [
          segment(1),
          { ...segment(2), pictureStarted: true },
          ...running.segments.slice(2),
        ],
      },
      {
        ...running,
        segments: [
          { ...segment(1), pictureStarted: true, pictureTaskId: initial.sourceTaskId },
          ...running.segments.slice(1),
        ],
      },
      {
        ...running,
        segments: [{ ...segment(1), lipSyncStarted: true }, ...running.segments.slice(1)],
      },
    ]) {
      expect(() => parseAvatarTailChainWorkerInput(value)).toThrow();
    }
  });
});
