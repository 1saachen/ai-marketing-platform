import { pauseWorkflowRun } from '../workflow/api/workflow-working.api';

export type PausableWorkflowNode = {
  flushPendingEdits: () => Promise<boolean>;
  workflowRunId: string;
  cloneDraftRevision?: number | null;
  cloneDraftRevisions?: Record<string, number> | null;
  localReplaceDraftRevision?: number | null;
  avatarDraftRevision?: number | null;
  avatarCompositionDraftRevision?: number | null;
};

/** Read the pause precondition after every pending draft write has completed. */
export async function flushAndPauseWorkflowRun(projectId: string, node: PausableWorkflowNode) {
  if ((await node.flushPendingEdits()) === false)
    throw new Error('仍有编辑未能自动保存，请修复后重试退出');
  const workflowRunId = node.workflowRunId;
  if (!workflowRunId) return;
  const revision = node.cloneDraftRevision;
  const revisions = node.cloneDraftRevisions;
  const localRevision = node.localReplaceDraftRevision;
  const avatarRevision = node.avatarDraftRevision;
  const avatarCompositionRevision = node.avatarCompositionDraftRevision;
  await pauseWorkflowRun(
    projectId,
    workflowRunId,
    revisions
      ? { expectedCloneDraftRevisions: { ...revisions } }
      : typeof revision === 'number'
        ? { expectedCloneDraftRevision: revision }
        : typeof localRevision === 'number'
          ? { expectedLocalReplaceDraftRevision: localRevision }
          : typeof avatarRevision === 'number'
            ? {
                expectedAvatarDraftRevision: avatarRevision,
                ...(typeof avatarCompositionRevision === 'number' && {
                  expectedAvatarCompositionDraftRevision: avatarCompositionRevision,
                }),
              }
            : undefined,
  );
}
