import {
  CLONE_GENERATION_LIMITS,
  CLONE_UUID_PATTERN,
  CLONE_ANALYSIS_ARTIFACT_KEY,
  CLONE_INPUT_ARTIFACT_KEY,
  CLONE_MAPPING_ARTIFACT_KEY,
  type CloneGenerationSnapshot,
  type CloneGenerationPlan,
} from '@ai-marketing/contracts';
import type { Prisma, FissionCloneTask } from '../../../generated/prisma/client';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { cloneConflict, requireCloneSource } from './clone-task-scope';

export const generationSnapshot = (task: FissionCloneTask) =>
  task.inputSnapshot as unknown as CloneGenerationSnapshot;

type GenerationBatchSnapshot = Pick<CloneGenerationSnapshot, 'plan' | 'model' | 'reviewModel'> & {
  count: number;
  planningModel?: string;
  planningVersion?: 2;
  sampleFirst?: true;
  variantIds?: string[];
};
const variantIdPattern = new RegExp(CLONE_UUID_PATTERN);

export function generationBatchSnapshot(parent: FissionCloneTask): GenerationBatchSnapshot {
  const snapshot = parent.inputSnapshot as unknown as GenerationBatchSnapshot | null;
  if (
    parent.operation !== 'GENERATE_BATCH' ||
    !snapshot?.plan ||
    typeof snapshot.model !== 'string' ||
    typeof snapshot.reviewModel !== 'string' ||
    !Number.isInteger(snapshot.count) ||
    snapshot.count < 2 ||
    snapshot.count > CLONE_GENERATION_LIMITS.maxCount ||
    (snapshot.planningVersion !== undefined &&
      (snapshot.planningVersion !== 2 || !snapshot.planningModel)) ||
    (snapshot.sampleFirst !== undefined &&
      (snapshot.sampleFirst !== true || snapshot.planningVersion !== 2)) ||
    (snapshot.planningModel !== undefined || snapshot.variantIds !== undefined
      ? typeof snapshot.planningModel !== 'string' ||
        !snapshot.planningModel.trim() ||
        !Array.isArray(snapshot.variantIds) ||
        snapshot.variantIds.length !== snapshot.count ||
        new Set(snapshot.variantIds).size !== snapshot.count ||
        snapshot.variantIds.some((id) => typeof id !== 'string' || !variantIdPattern.test(id))
      : false) ||
    workflowStateHash(snapshot) !== parent.inputHash
  )
    cloneConflict('成片批次快照无效');
  return snapshot;
}

export const generationChildren = (tx: Prisma.TransactionClient, parent: FissionCloneTask) =>
  tx.fissionCloneTask.findMany({
    where: {
      projectId: parent.projectId,
      workflowRunId: parent.workflowRunId,
      generationParentId: parent.id,
      operation: 'GENERATE',
    },
    orderBy: { generationSlot: 'asc' },
  });

export async function requireGenerationChildren(
  tx: Prisma.TransactionClient,
  parent: FissionCloneTask,
  count: number,
) {
  const children = await generationChildren(tx, parent);
  if (
    children.length !== count ||
    children.some((item, index) => item.generationSlot !== index + 1)
  )
    cloneConflict('批次条目不完整');
  return children;
}

export const pendingGenerationBatch = (
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
) =>
  tx.fissionCloneTask.findFirst({
    where: {
      projectId,
      workflowRunId,
      operation: 'GENERATE_BATCH',
      currentStage: { in: ['SAMPLE', 'PLANNED'] },
    },
  });

export async function verifyGenerationSources(
  tx: Prisma.TransactionClient,
  task: FissionCloneTask,
) {
  const snapshot = generationSnapshot(task);
  if (workflowStateHash(snapshot) !== task.inputHash) cloneConflict('成片任务快照无效');
  await verifyGenerationPlanSources(tx, task, snapshot.plan);
  return snapshot;
}

export async function verifyGenerationBatchSources(
  tx: Prisma.TransactionClient,
  task: FissionCloneTask,
) {
  const snapshot = generationBatchSnapshot(task);
  if (!snapshot.planningModel || !snapshot.variantIds) cloneConflict('批次无需再规划');
  await verifyGenerationPlanSources(tx, task, snapshot.plan);
  return { ...snapshot, planningModel: snapshot.planningModel, variantIds: snapshot.variantIds };
}

async function verifyGenerationPlanSources(
  tx: Prisma.TransactionClient,
  task: FissionCloneTask,
  plan: CloneGenerationPlan,
) {
  const p = task.projectId,
    r = task.workflowRunId;
  if (plan.projectId !== p || plan.workflowRunId !== r) cloneConflict('成片任务快照无效');
  await requireCloneSource(tx, p, r, CLONE_MAPPING_ARTIFACT_KEY, plan.sources.mapping);
  await requireCloneSource(tx, p, r, CLONE_ANALYSIS_ARTIFACT_KEY, plan.sources.analysis);
  const input = await requireCloneSource(tx, p, r, CLONE_INPUT_ARTIFACT_KEY, plan.sources.input);
  const holds = await tx.fissionCloneFileHold.findMany({
    where: { projectId: p, workflowRunId: r, taskId: task.id },
    include: { fileObject: true },
  });
  const byId = new Map(holds.map((hold) => [hold.fileObjectId, hold]));
  if (plan.mode !== 'SEEDANCE_2_0_SILENT_CUT') {
    const source = plan.sourceVideo;
    const hold = source && byId.get(source.fileObjectId);
    const file = hold?.fileObject;
    if (
      !source ||
      !hold ||
      !file ||
      !input.files.some(
        (entry) => entry.role === 'REFERENCE' && entry.fileObject.id === source.fileObjectId,
      ) ||
      hold.sha256 !== source.sha256 ||
      file.sha256 !== source.sha256 ||
      file.sizeBytes !== source.sizeBytes ||
      file.mimeType !== source.mimeType ||
      file.status !== 'AVAILABLE' ||
      file.projectId !== p ||
      file.workflowRunId !== r ||
      file.nodeId !== 'CLONE_INPUT'
    )
      cloneConflict('成片任务冻结原片不可用');
  }
  for (const item of plan.images) {
    const hold = byId.get(item.fileObjectId);
    if (
      !hold ||
      hold.sha256 !== item.sha256 ||
      hold.fileObject.sha256 !== item.sha256 ||
      hold.fileObject.sizeBytes !== item.sizeBytes ||
      hold.fileObject.status !== 'AVAILABLE'
    )
      cloneConflict('成片任务冻结图片不可用');
  }
}

export async function hasUnknownCloneRender(tx: Prisma.TransactionClient, task: FissionCloneTask) {
  return (
    (await tx.fissionCloneTaskStep.count({
      where: {
        projectId: task.projectId,
        workflowRunId: task.workflowRunId,
        taskId: task.id,
        inputHash: task.inputHash,
        stepKey: { startsWith: 'RENDER:' },
        output: { path: ['state'], equals: 'CREATE_PENDING' },
      },
    })) > 0
  );
}

export async function releaseCloneTaskFiles(tx: Prisma.TransactionClient, task: FissionCloneTask) {
  const where = { projectId: task.projectId, workflowRunId: task.workflowRunId, taskId: task.id };
  const outputs =
    task.operation === 'GENERATE'
      ? await tx.fissionCloneFileHold.findMany({
          where: { ...where, fileObject: { nodeId: 'CLONE_GENERATION' } },
          select: { fileObjectId: true },
        })
      : [];
  await tx.fissionCloneFileHold.deleteMany({ where });
  if (outputs.length)
    await tx.fileObject.updateMany({
      where: {
        projectId: task.projectId,
        workflowRunId: task.workflowRunId,
        id: { in: outputs.map((file) => file.fileObjectId) },
        status: 'AVAILABLE',
        cloneFileHolds: { none: {} },
        artifactLinks: { none: {} },
      },
      data: { status: 'ORPHANED', orphanedAt: new Date() },
    });
}
