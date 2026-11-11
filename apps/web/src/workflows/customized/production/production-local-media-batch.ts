import type {
  ProductionLocalMediaBatch,
  ProductionTask,
  ProductionWorkspace,
} from '@ai-marketing/contracts';

export type LocalMediaBatchItem = {
  task: ProductionTask;
  status: ProductionLocalMediaBatch['items'][number]['status'];
  progress: number;
};

export function localMediaBatchItems(
  workspace: ProductionWorkspace,
  head: ProductionTask,
): LocalMediaBatchItem[] {
  const key = head.incremental?.batchKey;
  const projected = workspace.localMediaBatch;
  if (!projected || projected.key !== key || projected.operation !== head.operation)
    return workspace.tasks
      .filter((task) => task.incremental?.batchKey === key && task.operation === head.operation)
      .map((task) => ({ task, status: task.status, progress: task.progress }));
  return projected.items.flatMap((item) => {
    const task =
      workspace.tasks.find((task) => task.id === item.taskId) ??
      workspace.tasks.find((task) => task.id === item.originalTaskId);
    if (!task) return [];
    const latest = workspace.tasks.find(
      (candidate) =>
        candidate.operation === projected.operation && candidate.target?.id === item.targetId,
    );
    // A new task response can arrive ahead of the next workspace read.
    if (
      item.status !== 'COMPLETED' &&
      latest &&
      workspace.tasks.indexOf(latest) < workspace.tasks.indexOf(task) &&
      ['QUEUED', 'RUNNING'].includes(latest.status)
    )
      return [{ task: latest, status: latest.status, progress: latest.progress }];
    return [
      {
        task,
        status: item.status,
        progress: item.status === 'COMPLETED' ? 100 : item.status === 'STALE' ? 0 : task.progress,
      },
    ];
  });
}
