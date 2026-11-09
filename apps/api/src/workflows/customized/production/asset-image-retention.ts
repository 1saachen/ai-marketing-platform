import type { Prisma } from '../../../generated/prisma/client';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

export const ASSET_IMAGE_RETENTION_NODE = 'CUSTOMIZED_ASSET_IMAGE_RETENTION';

const scope = (projectId: string, workflowRunId: string) => ({
  projectId,
  workflowRunId,
  nodeId: ASSET_IMAGE_RETENTION_NODE,
});

export async function retainedAssetImageFingerprints(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
) {
  const row = await tx.workflowNodeState.findUnique({
    where: { projectId_workflowRunId_nodeId: scope(projectId, workflowRunId) },
    select: { state: true },
  });
  const state = row?.state as { workflowRunId?: string; images?: [string, string][] } | undefined;
  // A state snapshot inherited by a new Run is not a decision made on that path.
  const images = state?.workflowRunId === workflowRunId ? state.images : undefined;
  return new Map(
    Array.isArray(images)
      ? images.filter(
          (entry) =>
            Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
        )
      : [],
  );
}

export async function saveAssetImageRetentions(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  images: [string, string][],
) {
  const state = { workflowRunId, images };
  const contentHash = workflowStateHash(state);
  const key = scope(projectId, workflowRunId);
  await tx.workflowNodeState.upsert({
    where: { projectId_workflowRunId_nodeId: key },
    create: { ...key, state, contentHash },
    update: { state, contentHash, revision: { increment: 1 } },
  });
}
