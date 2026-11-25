import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  AVATAR_LONG_LIMITS,
  planAvatarSpeechSegments,
} from '../../packages/contracts/dist/fission-avatar-long-sync.js';
import { AVATAR_SYNC_LIMITS } from '../../packages/contracts/dist/fission-avatar-sync.js';

const MAX_CHARACTERS = AVATAR_SYNC_LIMITS.maxScriptCharacters;
const MAX_SCRIPT_BYTES = 4 * MAX_CHARACTERS * AVATAR_LONG_LIMITS.maxSegments + 3;

export function planAvatarSegments(text, maxCharacters = MAX_CHARACTERS) {
  const { source, segments } = planAvatarSpeechSegments(text, maxCharacters);
  return {
    schemaVersion: 1,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    maxCharacters,
    segments,
  };
}
function cli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'max-characters': { type: 'string' }, output: { type: 'string' } },
  });
  if (positionals.length !== 1 || !values.output)
    throw new Error(
      '用法为 node scripts/fission-avatar/plan-segments.mjs <UTF-8 文案> --output <私有 JSON> [--max-characters 120]',
    );
  if (statSync(positionals[0]).size > MAX_SCRIPT_BYTES) throw new Error('文案文件超出预检容量。');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(positionals[0]));
  const maxCharacters =
    values['max-characters'] === undefined ? undefined : Number(values['max-characters']);
  const plan = planAvatarSegments(source, maxCharacters);
  writeFileSync(values.output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(`已准备 ${plan.segments.length} 段口播文案。\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch (error) {
    const message = error instanceof Error && !('code' in error) ? error.message : '无法读取文案。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
