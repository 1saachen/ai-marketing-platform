import type { CustomizedInformationMode } from '@ai-marketing/contracts';
import type { Prisma, WorkingArtifact } from '../../generated/prisma/client';
import type { WorkflowWorkingRepository } from './workflow-working.repository';
import { workflowStateHash } from './workflow-state-hash';

export const INFORMATION_CONTEXT = 'CUSTOMIZED_INFORMATION_CONTEXT';
const scope = (projectId: string) => ({
  projectId,
  workflow: 'CUSTOMIZED' as const,
  workflowSpace: 'CUSTOMIZED_PROJECT' as const,
});

export async function setCustomizedInformationMode(
  tx: Prisma.TransactionClient,
  p: string,
  r: string,
  mode: CustomizedInformationMode,
) {
  const where = {
    projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId: INFORMATION_CONTEXT },
  };
  const old = await tx.workflowNodeState.findUnique({ where });
  if (mode === 'PRESERVE' && old) return;
  const state = { mode: mode === 'PRESERVE' ? 'CURRENT' : mode };
  const contentHash = workflowStateHash(state);
  if (old?.contentHash === contentHash) return;
  await tx.workflowNodeState.upsert({
    where,
    create: { projectId: p, workflowRunId: r, nodeId: INFORMATION_CONTEXT, state, contentHash },
    update: { state, contentHash, revision: { increment: 1 } },
  });
}

/** A viewing context, not a second business head. Only confirmed information in this root family is eligible. */
export async function sharedCustomizedBrief(
  tx: Prisma.TransactionClient,
  p: string,
  r: string,
  local?: WorkingArtifact | null,
  current = false,
): Promise<WorkingArtifact | null> {
  const own =
    local === undefined
      ? await tx.workingArtifact.findFirst({
          where: {
            projectId: p,
            workflowRunId: r,
            artifactKey: 'customized-brief',
            availability: 'AVAILABLE',
          },
        })
      : local;
  const context = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: {
        projectId: p,
        workflowRunId: r,
        nodeId: INFORMATION_CONTEXT,
      },
    },
  });
  if (!current && (context?.state as { mode?: string } | undefined)?.mode !== 'CURRENT') return own;
  const runs = await tx.workflowRun.findMany({ where: scope(p) });
  const byId = new Map(runs.map((run) => [run.id, run]));
  const requested = byId.get(r);
  if (
    requested?.editSessionNodeId ||
    (requested?.forkNodeId === 'SOURCE_IMPORT' && own?.freshness === 'STALE')
  )
    return own;
  const root = (id: string): string | null => {
    const seen = new Set<string>();
    let run = byId.get(id);
    while (run?.parentWorkflowRunId && !seen.has(run.id)) {
      seen.add(run.id);
      run = byId.get(run.parentWorkflowRunId);
    }
    return run && !seen.has(run.id) ? run.id : null;
  };
  const family = root(r);
  if (!family) return own;
  const ids = runs
    .filter(
      (run) =>
        root(run.id) === family &&
        !run.editSessionNodeId &&
        (!run.parentWorkflowRunId || run.branchPublishedAt) &&
        ['ACTIVE', 'PAUSED'].includes(run.status),
    )
    .map((run) => run.id);
  const briefs = await tx.workingArtifact.findMany({
    where: {
      projectId: p,
      workflowRunId: { in: ids },
      artifactKey: 'customized-brief',
      availability: 'AVAILABLE',
      freshness: 'CURRENT',
    },
  });
  const originals = briefs.filter(
    (a) => !(a.metadata as { sharedBriefSource?: unknown } | null)?.sharedBriefSource,
  );
  const confirmed = await tx.workingArtifactRevisionSnapshot.findMany({
    where: {
      projectId: p,
      artifactKey: 'customized-brief',
      workingArtifactId: { in: originals.map((a) => a.id) },
    },
    orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
  });
  // Mix old confirmations and immutable snapshots without letting a copied script/asset snapshot become an information head.
  const candidates = originals.flatMap((brief) => {
    const run = byId.get(brief.workflowRunId)!;
    const snapshot = confirmed.find(
      (s) =>
        s.workingArtifactId === brief.id &&
        s.revision === brief.revision &&
        s.contentHash === brief.contentHash,
    );
    if (
      !snapshot &&
      run.parentWorkflowRunId &&
      !['INFORMATION_EXTRACTION', 'SOURCE_IMPORT'].includes(run.forkNodeId ?? '')
    )
      return [];
    return [{ brief, at: (snapshot?.confirmedAt ?? brief.updatedAt).getTime() }];
  });
  return (
    candidates.sort((a, b) => b.at - a.at || a.brief.id.localeCompare(b.brief.id))[0]?.brief ?? own
  );
}

/** Called only when an explicitly adopted script must retain its confirmed information in this path. */
export async function adoptSharedCustomizedBrief(
  tx: Prisma.TransactionClient,
  working: WorkflowWorkingRepository,
  p: string,
  r: string,
  source: WorkingArtifact,
) {
  if (source.workflowRunId === r) return;
  await working.commitValidatedArtifactsInTransaction(tx, p, r, 'INFORMATION_EXTRACTION', [
    {
      artifactKey: 'customized-brief',
      input: {
        kind: source.kind,
        name: source.name,
        directory: source.directory,
        type: source.type,
        tags: source.tags,
        payload: source.payload as Prisma.InputJsonValue,
        metadata: { sharedBriefSource: { artifactId: source.id, revision: source.revision } },
        dependencies: [
          {
            sourceType: 'WORKING_ARTIFACT',
            sourceArtifactId: source.id,
            sourceNodeId: source.nodeId,
            sourceKey: 'customized-brief',
            sourceRevision: source.revision,
            sourceHash: source.contentHash,
          },
        ],
      },
    },
  ]);
}

export function scriptUsesBrief(
  script: WorkingArtifact & { dependencies: { sourceKey: string; sourceHash: string | null }[] },
  brief: WorkingArtifact,
): boolean {
  return (
    script.freshness === 'CURRENT' &&
    script.dependencies.some(
      (d) => d.sourceKey === 'customized-brief' && d.sourceHash === brief.contentHash,
    )
  );
}
