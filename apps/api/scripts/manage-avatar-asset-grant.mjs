import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    asset: { type: 'string' },
    version: { type: 'string' },
    evidence: { type: 'string' },
    'expires-at': { type: 'string' },
    'doubao-speaker': { type: 'string' },
    'seedance-source-task-id': { type: 'string' },
    'seedance-portrait-asset-id': { type: 'string' },
    'seedance-voice-reference': { type: 'boolean' },
  },
});
const [operation] = positionals;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const projectId = values.project ?? '';
const assetId = values.asset ?? '';
const version = Number(values.version);
const evidenceReference = values.evidence?.trim();
const doubaoSpeaker = values['doubao-speaker']?.trim();
const seedanceSourceTaskId = values['seedance-source-task-id']?.trim();
const seedancePortraitAssetId = values['seedance-portrait-asset-id']?.trim();
const seedanceVoiceReference = values['seedance-voice-reference'];
const expiresAt = values['expires-at'] ? new Date(values['expires-at']) : null;
const bindsSeedanceSource = operation === 'bind-seedance-source';
const bindsSeedanceVoice = operation === 'bind-seedance-voice-reference';

if (
  positionals.length !== 1 ||
  !['grant', 'revoke', 'bind-seedance-source', 'bind-seedance-voice-reference'].includes(
    operation,
  ) ||
  !uuid.test(projectId) ||
  !uuid.test(assetId) ||
  !Number.isInteger(version) ||
  version < 1 ||
  version > 2_147_483_647 ||
  ((operation === 'grant' || bindsSeedanceSource || bindsSeedanceVoice) &&
    (!evidenceReference || evidenceReference.length > 240)) ||
  (bindsSeedanceSource &&
    (!seedanceSourceTaskId || doubaoSpeaker !== undefined || values['expires-at'] !== undefined)) ||
  (doubaoSpeaker !== undefined && !/^zh_[a-z0-9_]{1,80}_uranus_bigtts$/.test(doubaoSpeaker)) ||
  (seedanceSourceTaskId !== undefined &&
    !/^cgt-[A-Za-z0-9_-]{1,120}$/.test(seedanceSourceTaskId)) ||
  (seedancePortraitAssetId !== undefined &&
    (operation !== 'grant' || !/^asset-[A-Za-z0-9_-]{1,120}$/.test(seedancePortraitAssetId))) ||
  (seedanceVoiceReference && operation !== 'grant') ||
  (bindsSeedanceVoice &&
    (values['expires-at'] !== undefined ||
      doubaoSpeaker !== undefined ||
      seedanceSourceTaskId !== undefined)) ||
  (operation === 'revoke' &&
    (values.evidence !== undefined ||
      values['expires-at'] !== undefined ||
      doubaoSpeaker !== undefined ||
      seedanceSourceTaskId !== undefined)) ||
  (expiresAt &&
    (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(values['expires-at']) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= new Date()))
) {
  console.error(
    '用法：node scripts/manage-avatar-asset-grant.mjs grant|revoke|bind-seedance-source|bind-seedance-voice-reference --project UUID --asset UUID --version N [--evidence 记录号] [--expires-at ISO时间] [--doubao-speaker 已核验音色] [--seedance-source-task-id 已核验原始形象任务ID] [--seedance-portrait-asset-id 已授权方舟肖像资产ID] [--seedance-voice-reference]',
  );
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('请为目标数据库显式设置 DATABASE_URL。');
  process.exit(1);
}
const client = new pg.Client({ connectionString });

async function bindSeedanceSource(key) {
  const { rows } = await client.query(
    `SELECT "id", "evidenceReference", "seedanceSourceTaskId" FROM "fission_avatar_asset_grants"
     WHERE "projectId" = $1::uuid AND "assetId" = $2::uuid AND "assetVersion" = $3
       AND "grantedAt" <= statement_timestamp() AND "revokedAt" IS NULL
       AND ("expiresAt" IS NULL OR "expiresAt" > statement_timestamp())
     FOR UPDATE`,
    key,
  );
  const grant = rows[0];
  if (!grant || grant.evidenceReference !== evidenceReference)
    throw new Error('GRANT_EVIDENCE_MISMATCH');
  if (grant.seedanceSourceTaskId === seedanceSourceTaskId) return '该授权已登记相同的尾帧来源。';
  const active = await client.query(
    `SELECT 1 FROM "fission_avatar_sync_tasks" t
     WHERE t."projectId" = $1::uuid AND t."executionKind" = 'SEGMENTED'
       AND (t."inputSnapshot" #>> '{character,authorizationId}') = $2::text
       AND (t."inputSnapshot" #>> '{tailChain,sourceTaskId}') IS NOT NULL
       AND (
         t."status" IN ('QUEUED', 'RUNNING')
         OR (t."updatedAt" > statement_timestamp() - INTERVAL '30 days' AND (
           t."errorCode" = 'PROVIDER_CREATION_UNKNOWN' OR EXISTS (
             SELECT 1 FROM "fission_avatar_sync_segments" s
             WHERE s."projectId" = t."projectId" AND s."workflowRunId" = t."workflowRunId" AND s."taskId" = t."id"
               AND ((s."pictureStarted" AND s."pictureTaskId" IS NULL)
                 OR (s."lipSyncStarted" AND s."lipSyncTaskId" IS NULL))
           )
         ))
       ) LIMIT 1`,
    [projectId, grant.id],
  );
  if (active.rowCount) throw new Error('SEEDANCE_SOURCE_IN_USE');
  await client.query(
    'UPDATE "fission_avatar_asset_grants" SET "seedanceSourceTaskId" = $1 WHERE "id" = $2::uuid',
    [seedanceSourceTaskId, grant.id],
  );
  return `已为现有授权 ${grant.id} 登记尾帧来源。`;
}

async function execute() {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const { rowCount } = await client.query(
    'SELECT "id" FROM "projects" WHERE "id" = $1::uuid AND "deletionState" IS NULL FOR UPDATE',
    [projectId],
  );
  if (!rowCount) throw new Error('PROJECT_UNAVAILABLE');
  const key = [projectId, assetId, version];
  if (operation === 'revoke') {
    const updated = await client.query(
      `UPDATE "fission_avatar_asset_grants" SET "revokedAt" = clock_timestamp()
       WHERE "projectId" = $1::uuid AND "assetId" = $2::uuid AND "assetVersion" = $3
         AND "revokedAt" IS NULL RETURNING "id"`,
      key,
    );
    await client.query('COMMIT');
    return updated.rows[0] ? `已撤销授权 ${updated.rows[0].id}` : '该版本当前无待撤销的授权。';
  }
  const asset = await client.query(
    `SELECT a."type", a."hasFile", v."mimeType", v."storageKey", v."sizeBytes" FROM "asset_versions" v
     JOIN "assets" a ON a."id" = v."assetId" AND a."projectId" = v."projectId"
     WHERE v."projectId" = $1::uuid AND v."assetId" = $2::uuid AND v."version" = $3
       AND a."storageWorkflow" = 'FISSION' AND a."workflowSpace" = 'FISSION_AVATAR'
       AND a."status" = 'AVAILABLE' AND a."archivedAt" IS NULL AND v."status" = 'AVAILABLE'
       AND a."type" IN ('DIGITAL_HUMAN_CHARACTER', 'AVATAR_REFERENCE', 'VOICE_PROFILE')
     FOR SHARE OF a, v`,
    key,
  );
  if (!asset.rowCount) throw new Error('ASSET_UNAVAILABLE');
  if (doubaoSpeaker && asset.rows[0].type !== 'VOICE_PROFILE')
    throw new Error('PRESET_MAPPING_ASSET_TYPE');
  if (seedanceSourceTaskId && asset.rows[0].type === 'VOICE_PROFILE')
    throw new Error('SEEDANCE_MAPPING_ASSET_TYPE');
  if (
    seedancePortraitAssetId &&
    (asset.rows[0].type === 'VOICE_PROFILE' ||
      !['image/jpeg', 'image/png'].includes(asset.rows[0].mimeType))
  )
    throw new Error('SEEDANCE_PORTRAIT_ASSET_TYPE');
  if (seedanceVoiceReference || bindsSeedanceVoice) {
    const { type, hasFile, mimeType, sizeBytes, storageKey } = asset.rows[0];
    if (
      type !== 'VOICE_PROFILE' ||
      !hasFile ||
      !storageKey ||
      ![
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/x-wav',
        'audio/wave',
        'audio/vnd.wave',
      ].includes(mimeType) ||
      sizeBytes < 1 ||
      sizeBytes > 15 * 1024 * 1024
    )
      throw new Error('SEEDANCE_VOICE_REFERENCE_ASSET_TYPE');
  }
  if (bindsSeedanceSource) {
    const message = await bindSeedanceSource(key);
    await client.query('COMMIT');
    return message;
  }
  if (bindsSeedanceVoice) {
    const { rows } = await client.query(
      `UPDATE "fission_avatar_asset_grants" SET "seedanceVoiceReference" = true
       WHERE "projectId" = $1::uuid AND "assetId" = $2::uuid AND "assetVersion" = $3
         AND "evidenceReference" = $4 AND "grantedAt" <= statement_timestamp() AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > statement_timestamp()) RETURNING "id"`,
      [...key, evidenceReference],
    );
    if (!rows[0]) throw new Error('GRANT_EVIDENCE_MISMATCH');
    await client.query('COMMIT');
    return `已为现有授权 ${rows[0].id} 登记方舟参考音色。`;
  }
  await client.query(
    `UPDATE "fission_avatar_asset_grants" SET "revokedAt" = clock_timestamp()
     WHERE "projectId" = $1::uuid AND "assetId" = $2::uuid AND "assetVersion" = $3
       AND "revokedAt" IS NULL AND "expiresAt" <= clock_timestamp()`,
    key,
  );
  const existing = await client.query(
    `SELECT "id" FROM "fission_avatar_asset_grants"
     WHERE "projectId" = $1::uuid AND "assetId" = $2::uuid AND "assetVersion" = $3 AND "revokedAt" IS NULL`,
    key,
  );
  if (existing.rowCount) throw new Error('ACTIVE_GRANT_EXISTS');
  const id = randomUUID();
  const mappings = [
    ...(seedanceSourceTaskId ? [['seedanceSourceTaskId', seedanceSourceTaskId]] : []),
    ...(seedancePortraitAssetId ? [['seedancePortraitAssetId', seedancePortraitAssetId]] : []),
    ...(seedanceVoiceReference ? [['seedanceVoiceReference', true]] : []),
  ];
  await client.query(
    `INSERT INTO "fission_avatar_asset_grants"
       ("id", "projectId", "assetId", "assetVersion", "evidenceReference", "grantedAt", "expiresAt", "doubaoSpeaker"${mappings.map(([column]) => ', "' + column + '"').join('')})
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, clock_timestamp(), $6, $7${mappings.map((_, index) => ', $' + (8 + index)).join('')})`,
    [
      id,
      ...key,
      evidenceReference,
      expiresAt,
      doubaoSpeaker ?? null,
      ...mappings.map(([, value]) => value),
    ],
  );
  await client.query('COMMIT');
  return `已登记授权 ${id}`;
}

try {
  console.log(await execute());
} catch (error) {
  const messages = {
    PROJECT_UNAVAILABLE: '项目不存在或正在删除。',
    ASSET_UNAVAILABLE: '仅支持当前项目数字人库中的可用形象或音色版本。',
    PRESET_MAPPING_ASSET_TYPE: '生成音色只能登记到已核验的音色资产版本。',
    SEEDANCE_MAPPING_ASSET_TYPE: '尾帧来源只能登记到已核验的形象资产版本。',
    SEEDANCE_PORTRAIT_ASSET_TYPE: '方舟肖像只能登记到已核验的 JPEG 或 PNG 形象版本。',
    SEEDANCE_VOICE_REFERENCE_ASSET_TYPE:
      '方舟参考音色须为当前项目内有文件的 MP3 或 WAV 音色，大小不超过 15 MiB。',
    GRANT_EVIDENCE_MISMATCH: '该版本缺少与记录号匹配的当前授权。',
    SEEDANCE_SOURCE_IN_USE: '该授权仍有尾帧接续任务运行或待对账，请处理后再更换来源。',
    ACTIVE_GRANT_EXISTS: '该版本已有授权。如需替换，请先撤销现有授权。',
  };
  console.error(messages[error.message] ?? '授权操作未完成，请检查目标数据库、迁移和权限。');
  process.exitCode = 1;
} finally {
  await client.end();
}
