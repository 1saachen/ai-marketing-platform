import type { ProductionInput, ProductionLocalMediaBatch } from '@ai-marketing/contracts';
import type {
  CustomizedProductionTask,
  Prisma,
  WorkingArtifact,
} from '../../../generated/prisma/client';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

type Task = CustomizedProductionTask;
const input = (task: Task) => task.inputSnapshot as unknown as ProductionInput;
const newestFirst = (a: Task, b: Task) =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

function savedResult(task: Task, artifacts: WorkingArtifact[]) {
  const target = input(task).target;
  if (!target || task.status !== 'COMPLETED') return false;
  const key =
    task.operation === 'RENDER'
      ? `customized-clip-video:${target.id}`
      : `customized-clip-prompt:${target.id}`;
  const artifact = artifacts.find(
    (a) => a.artifactKey === key && a.availability === 'AVAILABLE' && a.freshness === 'CURRENT',
  );
  if (!artifact) return false;
  const output = task.output as Record<string, unknown> | null;
  if (task.operation === 'RENDER') {
    const video = artifact.payload as { taskId?: string };
    return (
      video?.taskId === task.id ||
      (!!output?.video && workflowStateHash(output.video) === workflowStateHash(artifact.payload))
    );
  }
  const prompt = output?.final ?? output;
  return !!prompt && workflowStateHash(prompt) === workflowStateHash(artifact.payload);
}

export async function resolveLocalMediaBatch(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
  group: Task[],
  artifacts: WorkingArtifact[],
) {
  const head = [...group].sort(newestFirst)[0];
  const key = head && input(head).incremental?.batchKey;
  if (!key || (head.operation !== 'PROMPT' && head.operation !== 'RENDER')) return;
  const operation = head.operation;
  const originals = [
    ...new Map(
      [...group]
        .sort(newestFirst)
        .reverse()
        .filter(
          (task) =>
            task.projectId === projectId &&
            task.workflowRunId === runId &&
            task.operation === operation &&
            input(task).target?.kind === 'CLIP',
        )
        .map((task) => [input(task).target!.id, task]),
    ).values(),
  ];
  if (!originals.length) return;
  const tasks: Task[] = [...originals];
  const items = await Promise.all(
    originals.map(async (original) => {
      const targetId = input(original).target!.id;
      if (original.status === 'COMPLETED')
        return {
          originalTaskId: original.id,
          taskId: original.id,
          targetId,
          status: 'COMPLETED' as const,
        };
      const where = {
        projectId,
        workflowRunId: runId,
        operation,
        createdAt: { gte: original.createdAt },
        inputSnapshot: { path: ['target', 'id'], equals: targetId },
      };
      const [latest, completed] = await Promise.all([
        tx.customizedProductionTask.findFirst({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        tx.customizedProductionTask.findFirst({
          where: { ...where, status: 'COMPLETED' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      ]);
      const success =
        completed && newestFirst(completed, original) <= 0 && savedResult(completed, artifacts)
          ? completed
          : null;
      const observed = latest && newestFirst(latest, original) <= 0 ? latest : original;
      const effective = success ?? observed;
      tasks.push(observed, effective);
      const status = success
        ? 'COMPLETED'
        : effective.status === 'COMPLETED'
          ? 'STALE'
          : effective.status;
      return {
        originalTaskId: original.id,
        taskId: effective.id,
        targetId,
        status: status as ProductionLocalMediaBatch['items'][number]['status'],
      };
    }),
  );
  return {
    batch: { key, operation, items } satisfies ProductionLocalMediaBatch,
    tasks: [...new Map(tasks.map((task) => [task.id, task])).values()],
  };
}
