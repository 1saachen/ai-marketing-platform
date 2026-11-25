import { parseArgs } from 'node:util';
import pg from 'pg';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const providerTask = /^amk-tool-lip-sync-[A-Za-z0-9_-]{1,120}$/;
const pictureTask = /^cgt-[A-Za-z0-9_-]{1,120}$/;
const usage =
  '用法：node scripts/reconcile-avatar-sync.mjs --project UUID --run UUID --task UUID [--ordinal 段序] [--picture] --client-token UUID --provider-task ID --confirm-provider-match';

async function reconcile(client, ids, acceptedId, ordinal, picture) {
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const project = await client.query(
    'SELECT "id" FROM "projects" WHERE "id" = $1::uuid AND "deletionState" IS NULL FOR UPDATE',
    [ids[0]],
  );
  if (!project.rowCount) return null;
  const segmented = ordinal !== undefined;
  const startedColumn = picture ? 'pictureStarted' : 'lipSyncStarted';
  const taskColumn = picture ? 'pictureTaskId' : 'lipSyncTaskId';
  const result = segmented
    ? await client.query(
        `SELECT t."status", t."errorCode", s."${startedColumn}" AS "started", s."${taskColumn}" AS "providerTaskId"
     FROM "fission_avatar_sync_tasks" t
     JOIN "workflow_runs" r ON r."projectId" = t."projectId" AND r."id" = t."workflowRunId"
     JOIN "fission_avatar_sync_segments" s ON s."projectId" = t."projectId" AND s."workflowRunId" = t."workflowRunId" AND s."taskId" = t."id"
     WHERE t."projectId" = $1::uuid AND t."workflowRunId" = $2::uuid AND t."id" = $3::uuid
       AND s."lipSyncClientToken" = $4::uuid AND s."ordinal" = $5 AND t."executionKind" = 'SEGMENTED'
       ${picture ? `AND t."continuityPlan" IS NOT NULL AND t."inputSnapshot"#>>'{tailChain,sourceTaskId}' <> $6` : ''}
       AND r."workflow" = 'FISSION' AND r."workflowSpace" = 'FISSION_AVATAR'
       AND r."activeKey" = 'ACTIVE' AND r."status" IN ('ACTIVE', 'PAUSED')
     FOR UPDATE OF t, s`,
        [...ids, ordinal, ...(picture ? [acceptedId] : [])],
      )
    : await client.query(
        `SELECT t."status", t."errorCode", t."lipSyncStarted" AS "started", t."lipSyncTaskId" AS "providerTaskId"
     FROM "fission_avatar_sync_tasks" t
     JOIN "workflow_runs" r ON r."projectId" = t."projectId" AND r."id" = t."workflowRunId"
     WHERE t."projectId" = $1::uuid AND t."workflowRunId" = $2::uuid
       AND t."id" = $3::uuid AND t."lipSyncClientToken" = $4::uuid AND t."executionKind" = 'SHORT'
       AND r."workflow" = 'FISSION' AND r."workflowSpace" = 'FISSION_AVATAR'
       AND r."activeKey" = 'ACTIVE' AND r."status" IN ('ACTIVE', 'PAUSED')
     FOR UPDATE OF t`,
        ids,
      );
  const task = result.rows[0];
  if (!task) return null;
  if (task.providerTaskId === acceptedId) {
    await client.query('COMMIT');
    return '该供应商任务已登记。';
  }
  if (
    task.status !== 'FAILED' ||
    task.errorCode !== 'PROVIDER_CREATION_UNKNOWN' ||
    !task.started ||
    task.providerTaskId !== null
  )
    return null;
  const assigned = await client.query(
    `SELECT 1 FROM "fission_avatar_sync_segments" WHERE "${taskColumn}" = $1
     ${picture ? '' : 'UNION ALL SELECT 1 FROM "fission_avatar_sync_tasks" WHERE "lipSyncTaskId" = $1'}`,
    [acceptedId],
  );
  if (assigned.rowCount)
    throw Object.assign(new Error('Provider task already bound'), { code: '23505' });
  if (segmented) {
    await client.query(
      `UPDATE "fission_avatar_sync_segments" SET "${taskColumn}" = $6, "updatedAt" = clock_timestamp()
       WHERE "projectId" = $1::uuid AND "workflowRunId" = $2::uuid AND "taskId" = $3::uuid
         AND "lipSyncClientToken" = $4::uuid AND "ordinal" = $5`,
      [...ids, ordinal, acceptedId],
    );
    await client.query(
      `UPDATE "fission_avatar_sync_tasks" SET "errorCode" = 'INTERNAL_API_FAILED',
       "retryable" = ("attemptCount" < 3), "updatedAt" = clock_timestamp()
       WHERE "projectId" = $1::uuid AND "workflowRunId" = $2::uuid AND "id" = $3::uuid`,
      ids.slice(0, 3),
    );
  } else
    await client.query(
      `UPDATE "fission_avatar_sync_tasks"
     SET "lipSyncTaskId" = $5, "errorCode" = 'INTERNAL_API_FAILED',
         "retryable" = true, "updatedAt" = clock_timestamp()
     WHERE "projectId" = $1::uuid AND "workflowRunId" = $2::uuid
       AND "id" = $3::uuid AND "lipSyncClientToken" = $4::uuid`,
      [...ids, acceptedId],
    );
  await client.query('COMMIT');
  return '已登记供应商受理结果。可回到工作台重试原任务，继续查询已有结果。';
}

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      run: { type: 'string' },
      task: { type: 'string' },
      ordinal: { type: 'string' },
      'client-token': { type: 'string' },
      'provider-task': { type: 'string' },
      'confirm-provider-match': { type: 'boolean' },
      picture: { type: 'boolean' },
    },
  });
  const ids = [values.project, values.run, values.task, values['client-token']];
  const acceptedId = values['provider-task'];
  const ordinal = values.ordinal !== undefined ? Number(values.ordinal) : undefined;
  const picture = values.picture === true;
  if (
    !ids.every((value) => uuid.test(value ?? '')) ||
    !(picture ? pictureTask : providerTask).test(acceptedId ?? '') ||
    (picture && ordinal === undefined) ||
    (values.ordinal !== undefined && !/^(?:[1-9]|1[0-2])$/.test(values.ordinal)) ||
    !values['confirm-provider-match']
  ) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('请为目标数据库显式设置 DATABASE_URL。');
    process.exitCode = 1;
    return;
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const message = await reconcile(client, ids, acceptedId, ordinal, picture);
    if (message) {
      console.log(message);
      return;
    }
    await client.query('ROLLBACK');
    console.error('未匹配到可核对的数字人口播任务。');
    process.exitCode = 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      error.code === '23505'
        ? '该供应商任务已关联其他口播任务。'
        : '登记失败，请检查目标数据库、迁移和权限。',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error(usage);
  process.exitCode = 1;
});
