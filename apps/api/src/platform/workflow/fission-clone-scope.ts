import {
  FISSION_CLONE_NODES,
  normalizeCloneInputDraft,
  type CloneInputDraft,
  type WorkflowPauseRunRequest,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { ApiHttpException } from '../../common/api-http-exception';

/** Same project -> run lock order for draft writes, confirmation, upload completion and pause. */
export async function lockCloneRun(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  options: { writable?: boolean; nodeId?: string } = {},
) {
  const projects = await tx.$queryRaw<{ id: string; deletionState: string | null }[]>`
    SELECT id, "deletionState" FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
  if (!projects.length) throw new ApiHttpException('项目不存在', 404, 'PROJECT_NOT_FOUND');
  if (projects[0]!.deletionState)
    throw new ApiHttpException('项目正在删除，暂时不能操作', 409, 'PROJECT_DELETING');
  await tx.$queryRaw`
    SELECT id FROM workflow_runs WHERE "projectId" = ${projectId}::uuid AND id = ${workflowRunId}::uuid FOR UPDATE`;
  const run = await tx.workflowRun.findFirst({ where: { projectId, id: workflowRunId } });
  if (!run || run.workflow !== 'FISSION' || run.workflowSpace !== 'FISSION_CLONE')
    throw new ApiHttpException('复刻工作流不存在或不属于当前项目', 404, 'VALIDATION_ERROR');
  if (options.nodeId && !FISSION_CLONE_NODES.some((node) => node === options.nodeId))
    throw new ApiHttpException('复刻节点无效', 400, 'VALIDATION_ERROR');
  if (options.writable && (run.status !== 'ACTIVE' || run.activeKey !== 'ACTIVE'))
    throw new ApiHttpException('复刻工作流已暂停或切换，请重新进入后再编辑', 409, 'CONFLICT');
  return run;
}

/** Validate the complete saved edit frontier while holding the project/run lock. */
export function assertClonePauseRevisions(
  input: WorkflowPauseRunRequest,
  drafts: { nodeId: string; revision: number }[],
) {
  const revisions = input?.expectedCloneDraftRevisions;
  if (revisions !== undefined) {
    if (
      !revisions ||
      typeof revisions !== 'object' ||
      Array.isArray(revisions) ||
      Object.entries(revisions).some(
        ([key, value]) =>
          !FISSION_CLONE_NODES.some((node) => node === key) ||
          !Number.isSafeInteger(value) ||
          value < 0,
      )
    )
      throw new ApiHttpException(
        '暂停复刻工作流需要有效的全部节点草稿版本',
        400,
        'VALIDATION_ERROR',
      );
    const actual = new Map(drafts.map((draft) => [draft.nodeId, draft.revision]));
    if (
      !actual.has('CLONE_INPUT') ||
      drafts.some((draft) => revisions[draft.nodeId] !== draft.revision) ||
      Object.entries(revisions).some(([key, value]) => !actual.has(key) && value !== 0)
    )
      throw new ApiHttpException(
        '复刻工作流已重新进入或其他节点草稿已更新，请刷新后重试',
        409,
        'CONFLICT',
      );
    return;
  }
  // A legacy G1 caller is only safe while no other node has editable state.
  const expected = input?.expectedCloneDraftRevision;
  if (
    drafts.some((draft) => draft.nodeId !== 'CLONE_INPUT') ||
    expected === undefined ||
    !Number.isSafeInteger(expected) ||
    expected < 0
  )
    throw new ApiHttpException('暂停复刻工作流需要当前全部节点草稿版本', 400, 'VALIDATION_ERROR');
  if (drafts.find((draft) => draft.nodeId === 'CLONE_INPUT')?.revision !== expected)
    throw new ApiHttpException('复刻工作流已重新进入或草稿已更新，请刷新后重试', 409, 'CONFLICT');
}

/** Incomplete drafts are valid, but every selected upload must belong to this exact run. */
export async function validateCloneInputUploads(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  value: unknown,
): Promise<CloneInputDraft> {
  let state: CloneInputDraft;
  try {
    state = normalizeCloneInputDraft(value);
  } catch {
    throw new ApiHttpException('复刻输入草稿格式不正确', 400, 'VALIDATION_ERROR');
  }
  const ids = [
    ...(state.referenceUploadId ? [state.referenceUploadId] : []),
    ...state.productUploadIds,
  ];
  if (!ids.length) return state;
  const uploads = await tx.fissionCloneUpload.findMany({
    where: {
      projectId,
      workflowRunId,
      id: { in: ids },
      status: 'AVAILABLE',
      fileObject: { status: 'AVAILABLE' },
    },
    select: { id: true, role: true },
  });
  if (
    uploads.length !== ids.length ||
    (state.referenceUploadId &&
      !uploads.some((row) => row.id === state.referenceUploadId && row.role === 'REFERENCE')) ||
    state.productUploadIds.some(
      (id) => !uploads.some((row) => row.id === id && row.role === 'PRODUCT'),
    )
  )
    throw new ApiHttpException('选择的素材不可用或不属于当前复刻工作流', 409, 'CONFLICT');
  return state;
}
