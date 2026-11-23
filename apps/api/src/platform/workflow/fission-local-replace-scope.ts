import { ApiHttpException } from '../../common/api-http-exception';
import type { Prisma } from '../../generated/prisma/client';

export const LOCAL_REPLACE_DRAFT_NODE = 'LOCAL_REPLACE_SOURCE';

export async function lockLocalReplaceProject(tx: Prisma.TransactionClient, projectId: string) {
  const [project] = await tx.$queryRaw<{ name: string; deletionState: string | null }[]>`
    SELECT name, "deletionState" FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
  if (!project) throw new ApiHttpException('项目不存在', 404, 'PROJECT_NOT_FOUND');
  if (project.deletionState) throw new ApiHttpException('项目正在删除', 409, 'PROJECT_DELETING');
  return project;
}

export async function lockLocalReplaceRun(
  tx: Prisma.TransactionClient,
  ids: { projectId: string; workflowRunId: string },
  writable = false,
) {
  const project = await lockLocalReplaceProject(tx, ids.projectId);
  const { projectId, workflowRunId } = ids;
  await tx.$queryRaw`
    SELECT id FROM workflow_runs WHERE "projectId" = ${projectId}::uuid AND id = ${workflowRunId}::uuid FOR UPDATE`;
  const run = await tx.workflowRun.findFirst({
    where: {
      projectId,
      id: workflowRunId,
      workflow: 'FISSION',
      workflowSpace: 'FISSION_LOCAL_REPLACE',
    },
  });
  if (!run) throw new ApiHttpException('局部替换工作流不存在', 404, 'VALIDATION_ERROR');
  if (writable && (run.status !== 'ACTIVE' || run.activeKey !== 'ACTIVE'))
    throw new ApiHttpException('工作流已暂停，请重新进入后编辑', 409, 'CONFLICT');
  return { project, run };
}
