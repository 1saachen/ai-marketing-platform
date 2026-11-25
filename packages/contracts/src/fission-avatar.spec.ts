import { describe, expect, it } from 'vitest';
import {
  AVATAR_SCRIPT_MAX_LENGTH,
  emptyAvatarDraft,
  estimateAvatarScriptDurationMs,
  parseAvatarConfirmRequest,
  parseAvatarSaveDraftRequest,
} from './fission-avatar';

const character = { assetId: '11111111-1111-4111-8111-111111111111', version: 1 };

describe('avatar workspace contracts', () => {
  it('accepts an empty draft and normalizes line endings consistently for a confirmed script', () => {
    expect(
      parseAvatarSaveDraftRequest({ expectedRevision: 0, draft: emptyAvatarDraft() }).draft,
    ).toEqual(emptyAvatarDraft());
    const draft = {
      ...emptyAvatarDraft(),
      character,
      scriptText: ' 大家好\r\n欢迎观看 ',
      scriptSource: 'TXT',
    };
    expect(parseAvatarSaveDraftRequest({ expectedRevision: 4, draft })).toEqual({
      expectedRevision: 4,
      draft: { ...draft, scriptText: '大家好\n欢迎观看' },
    });
    expect(parseAvatarConfirmRequest({ expectedRevision: 4 })).toEqual({ expectedRevision: 4 });
  });

  it.each([
    { character: { ...character, version: 0 } },
    { voice: { assetId: 'mock-voice', version: 1 } },
    { scriptSource: 'GENERATED' },
    { scriptText: undefined },
    { scriptText: '测'.repeat(AVATAR_SCRIPT_MAX_LENGTH + 1) },
    { projectId: character.assetId },
    { authorized: true },
  ])('rejects unsupported or untrusted draft fields (%j)', (patch) => {
    expect(() =>
      parseAvatarSaveDraftRequest({
        expectedRevision: 0,
        draft: { ...emptyAvatarDraft(), ...patch },
      }),
    ).toThrow();
  });

  it('requires the caller to confirm the saved editing revision and only that revision', () => {
    expect(() => parseAvatarConfirmRequest({})).toThrow();
    expect(() => parseAvatarConfirmRequest({ expectedRevision: -1 })).toThrow();
    expect(() =>
      parseAvatarConfirmRequest({ expectedRevision: 2, scriptText: '绕过草稿' }),
    ).toThrow();
  });

  it('estimates from spoken characters and treats punctuation-only input as empty', () => {
    expect(estimateAvatarScriptDurationMs('大家好，今天。')).toBe(1250);
    expect(estimateAvatarScriptDurationMs('   ………。')).toBe(0);
  });
});
