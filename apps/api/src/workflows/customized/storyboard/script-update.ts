import { randomUUID } from 'node:crypto';
import {
  applyCustomizedScriptPatches,
  isCustomizedBrief,
  isCustomizedStoryboardScript,
  validateStoryboardPublication,
  storyboardStages,
  isStoryboardReview,
  type CustomizedStoryboardScript,
  type StoryboardInput,
  type CustomizedUpdateRequest,
  type CustomizedBrief,
  type CustomizedScriptTextPatch,
  type CustomizedScriptUpdateCandidate,
} from '@ai-marketing/contracts';
import type { Prisma, CustomizedStoryboardTask } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import {
  customizedScope,
  customizedConflict,
  lockCustomizedProject,
} from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { updatePreview } from '../production/update-preview';
import { storyboardTaskError } from './script-update-failure';
import { readableScriptReviewText } from './storyboard-review-text';
import { rebindUnchanged } from '../production/unchanged-media';
import {
  sharedCustomizedBrief,
  adoptSharedCustomizedBrief,
  INFORMATION_CONTEXT,
} from '../../../platform/workflow/customized-shared-brief';
type Tx = Prisma.TransactionClient;
const json = (v: unknown) => v as Prisma.InputJsonValue;
export async function createScriptUpdate(
  tx: Tx,
  p: string,
  r: string,
  sid: string,
  key: string,
  request: CustomizedUpdateRequest,
  models: StoryboardInput['models'],
) {
  await lockCustomizedProject(tx, p);
  const previous = await tx.customizedStoryboardTask.findUnique({
    where: { projectId_idempotencyKey: { projectId: p, idempotencyKey: key } },
    include: { steps: true },
  });
  if (previous) {
    const value = previous.inputSnapshot as unknown as StoryboardInput;
    if (
      previous.workflowRunId !== r ||
      value.incremental?.scriptId !== sid ||
      value.incremental.fingerprint !== request.fingerprint
    )
      return customizedConflict('请求标识已用于其他更新');
    return previous;
  }
  const preview = await updatePreview(tx, p, r, 'SCRIPT', sid);
  if (request.version !== 1 || request.fingerprint !== preview.fingerprint)
    return customizedConflict('更新范围已变化，请重新查看局部更新');
  if (preview.blockers.length || !preview.items.length)
    return customizedConflict(preview.blockers.join('；') || '当前脚本无需更新');
  const script = await tx.workingArtifact.findFirst({
    where: { projectId: p, workflowRunId: r, artifactKey: `customized-script:${sid}` },
  });
  const brief = await sharedCustomizedBrief(
    tx,
    p,
    r,
    await tx.workingArtifact.findFirst({
      where: {
        projectId: p,
        workflowRunId: r,
        artifactKey: 'customized-brief',
        freshness: 'CURRENT',
      },
    }),
  );
  const record = await tx.customizedStoryboardScript.findFirst({
    where: { projectId: p, id: sid },
  });
  if (
    !script ||
    !brief ||
    !record ||
    record.editing ||
    !isCustomizedStoryboardScript(script.payload) ||
    !isCustomizedBrief(brief.payload)
  )
    return customizedConflict('请先保存或取消当前脚本编辑');
  if (
    await tx.customizedStoryboardTask.count({
      where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
    })
  )
    return customizedConflict('当前脚本任务尚未结束');
  const oldTask = record.taskId
    ? await tx.customizedStoryboardTask.findFirst({ where: { projectId: p, id: record.taskId } })
    : null;
  const editing = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: {
        projectId: p,
        workflowRunId: r,
        nodeId: `CUSTOMIZED_SCRIPT_EDIT:${sid}`,
      },
    },
  });
  if ((editing?.state as { editing?: boolean })?.editing)
    return customizedConflict('请先保存或取消当前路径的脚本编辑');
  const oldBrief =
    (script.metadata as { confirmedBrief?: unknown } | null)?.confirmedBrief ??
    (oldTask?.inputSnapshot as unknown as StoryboardInput | undefined)?.brief;
  if (!isCustomizedBrief(oldBrief))
    return customizedConflict('历史脚本缺少可靠的信息卡基线，请手动修改或重新创作');
  const baseline = script.payload;
  const rejected = await tx.customizedStoryboardTask.findFirst({
    where: {
      projectId: p,
      workflowRunId: r,
      status: 'FAILED',
      inputSnapshot: { path: ['incremental', 'scriptId'], equals: sid },
    },
    orderBy: { createdAt: 'desc' },
    include: { steps: true },
  });
  const rejectedInput = rejected?.inputSnapshot as unknown as StoryboardInput | undefined;
  const rejectedStory = rejected?.steps.find(
    (s) => s.nodeId === 'STORY' && s.status === 'SUCCEEDED',
  )?.output as { script?: unknown } | undefined;
  const rejectedReview = rejected?.steps.find(
    (s) => s.nodeId === 'REVIEW' && s.status === 'SUCCEEDED',
  )?.output;
  const reviewFeedback =
    rejectedInput?.incremental?.baselineRevision === script.revision &&
    workflowStateHash(rejectedInput.incremental.baseline) === workflowStateHash(baseline) &&
    rejectedInput.source.artifactId === brief.id &&
    rejectedInput.source.revision === brief.revision &&
    rejectedInput.source.fingerprint === brief.contentHash &&
    isCustomizedStoryboardScript(rejectedStory?.script) &&
    rejectedStory.script.id === sid &&
    isStoryboardReview(rejectedReview) &&
    (rejectedReview as { candidateHash?: unknown }).candidateHash ===
      workflowStateHash(rejectedStory.script) &&
    rejectedReview.findings.some((f) => f.severity === 'ERROR')
      ? { candidate: rejectedStory.script, findings: rejectedReview.findings }
      : undefined;
  const context = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: {
        projectId: p,
        workflowRunId: r,
        nodeId: INFORMATION_CONTEXT,
      },
    },
  });
  const input: StoryboardInput = {
    schemaVersion: 1,
    outputMode: 'STORY_ONLY',
    source: { artifactId: brief.id, revision: brief.revision, fingerprint: brief.contentHash },
    brief: brief.payload,
    settings: {
      targetDurationSeconds: baseline.creation?.referenceDurationSeconds ?? 30,
      variantCount: 1,
      structureMode: 'AI',
      structure: '',
      instructions: '',
    },
    scriptIds: [sid],
    models,
    brandReferences: [],
    existingConcepts: [],
    incremental: {
      version: 1,
      scriptId: sid,
      baselineRevision: script.revision,
      baseline,
      previousBrief: oldBrief as CustomizedBrief,
      fingerprint: request.fingerprint,
      ...(reviewFeedback ? { reviewFeedback } : {}),
      ...((context?.state as { mode?: string } | undefined)?.mode === 'CURRENT'
        ? { informationMode: 'CURRENT' as const }
        : {}),
    },
  };
  const task = await tx.customizedStoryboardTask.create({
    data: {
      projectId: p,
      workflowRunId: r,
      idempotencyKey: key,
      inputHash: workflowStateHash(input),
      inputSnapshot: json(input),
    },
    include: { steps: true },
  });
  await tx.customizedStoryboardStep.createMany({
    data: storyboardStages(input).map((stage) => ({
      projectId: p,
      taskId: task.id,
      nodeId: stage.id,
      scriptId: stage.id === 'SNAPSHOT' ? '' : sid,
      status: 'PENDING',
    })),
  });
  await tx.jobOutbox.create({
    data: {
      projectId: p,
      jobType: 'CUSTOMIZED_STORYBOARD',
      aggregateId: task.id,
      routingKey: 'customized.storyboard.requested',
      payload: { schemaVersion: 1, projectId: p, runId: task.id, requestId: randomUUID() },
    },
  });
  return tx.customizedStoryboardTask.findUniqueOrThrow({
    where: { id: task.id },
    include: { steps: true },
  });
}
export async function completeScriptUpdate(
  tx: Tx,
  t: CustomizedStoryboardTask,
  script: CustomizedStoryboardScript,
) {
  const input = t.inputSnapshot as unknown as StoryboardInput,
    local = input.incremental!;
  if (
    script.id !== local.scriptId ||
    !isCustomizedStoryboardScript(script) ||
    validateStoryboardPublication(script)
  )
    return customizedConflict('脚本修改候选不完整');
  const steps = await tx.customizedStoryboardStep.findMany({
    where: { projectId: t.projectId, taskId: t.id },
  });
  const generated = steps.find((s) => s.nodeId === 'STORY')?.output as
    { patches?: CustomizedScriptTextPatch[]; script?: CustomizedStoryboardScript } | undefined;
  const review = steps.find((s) => s.nodeId === 'REVIEW')?.output as
    { findings?: { severity: string }[]; candidateHash?: string } | undefined;
  const reviewHash = review?.candidateHash;
  if (
    !['SNAPSHOT', 'STORY', 'REVIEW'].every((node) =>
      steps.some((s) => s.nodeId === node && s.status === 'SUCCEEDED'),
    ) ||
    !generated?.patches ||
    !isStoryboardReview(review) ||
    reviewHash !== workflowStateHash(script) ||
    review.findings.some((f) => f.severity === 'ERROR')
  )
    return customizedConflict('脚本审校尚未通过');
  let expected: CustomizedStoryboardScript;
  try {
    expected = applyCustomizedScriptPatches(local.baseline, generated.patches);
  } catch {
    return customizedConflict('脚本修改无法按原文应用');
  }
  if (
    workflowStateHash(expected) !== workflowStateHash(script) ||
    workflowStateHash(generated.script) !== workflowStateHash(script)
  )
    return customizedConflict('脚本候选与已审校内容不一致');
  await tx.customizedStoryboardStep.updateMany({
    where: { projectId: t.projectId, taskId: t.id, nodeId: 'SAVE' },
    data: { status: 'SUCCEEDED', output: json({ script }) },
  });
  await tx.customizedStoryboardTask.update({
    where: { id: t.id },
    data: { status: 'COMPLETED', leaseExpiresAt: null, errorMessage: null },
  });
  return { workflowRunId: t.workflowRunId, unchanged: true, candidate: true };
}
export async function scriptUpdateCandidate(
  db: PrismaService,
  p: string,
  r: string,
  sid: string,
): Promise<CustomizedScriptUpdateCandidate | null> {
  const run = await db.workflowRun.findFirst({
    where: { ...customizedScope(p), id: r, status: { in: ['ACTIVE', 'PAUSED'] } },
  });
  if (!run) return customizedConflict('工作流不可用');
  const task = await db.customizedStoryboardTask.findFirst({
    where: {
      projectId: p,
      workflowRunId: r,
      inputSnapshot: { path: ['incremental', 'scriptId'], equals: sid },
    },
    orderBy: { createdAt: 'desc' },
    include: { steps: true },
  });
  if (!task) return null;
  const input = task.inputSnapshot as unknown as StoryboardInput;
  const value = task.steps.find((s) => s.nodeId === 'SAVE' && s.status === 'SUCCEEDED')?.output as
    { script?: CustomizedStoryboardScript } | undefined;
  const unfinished = task.steps.find((s) => s.nodeId === 'STORY' && s.status === 'SUCCEEDED')
    ?.output as { script?: CustomizedStoryboardScript } | undefined;
  const reviewStep = task.steps.find((s) => s.nodeId === 'REVIEW');
  const review =
    reviewStep?.status === 'SUCCEEDED' && isStoryboardReview(reviewStep.output)
      ? reviewStep.output
      : null;
  const reviewFindings =
    review?.findings.map((f) => ({
      severity: f.severity,
      message: readableScriptReviewText(f.message),
      evidence: readableScriptReviewText(f.evidence),
      suggestion: readableScriptReviewText(f.suggestion),
    })) ?? [];
  return {
    taskId: task.id,
    status: task.status,
    errorMessage: storyboardTaskError(task),
    before: input.incremental!.baseline,
    after: value?.script ?? unfinished?.script ?? null,
    issues: reviewFindings.map((f) => `${f.message}${f.evidence ? `：${f.evidence}` : ''}`),
    reviewStatus: !review
      ? 'PENDING'
      : review.findings.some((f) => f.severity === 'ERROR')
        ? 'NEEDS_CHANGES'
        : 'PASSED',
    reviewFindings,
    applied: !!task.steps.find(
      (s) => s.nodeId === 'SAVE' && (s.output as { applied?: boolean })?.applied,
    ),
    baselineRevision: input.incremental!.baselineRevision,
  };
}
export async function saveScriptUpdate(
  tx: Tx,
  working: WorkflowWorkingRepository,
  p: string,
  r: string,
  id: string,
  script: CustomizedStoryboardScript,
) {
  await lockCustomizedProject(tx, p);
  const run = await tx.workflowRun.findFirst({
    where: { ...customizedScope(p), id: r, status: { in: ['ACTIVE', 'PAUSED'] } },
  });
  const task = await tx.customizedStoryboardTask.findFirst({
    where: { projectId: p, workflowRunId: r, id, status: 'COMPLETED' },
  });
  const input = task?.inputSnapshot as unknown as StoryboardInput | undefined,
    local = input?.incremental;
  if (
    !run ||
    run.editSessionNodeId ||
    !task ||
    !input ||
    !local ||
    !isCustomizedStoryboardScript(script) ||
    script.id !== local.scriptId ||
    validateStoryboardPublication(script)
  )
    return customizedConflict('脚本更新候选无效');
  const artifact = await tx.workingArtifact.findFirst({
    where: { projectId: p, workflowRunId: r, artifactKey: `customized-script:${script.id}` },
  });
  const brief = await tx.workingArtifact.findFirst({
    where: {
      projectId: p,
      id: input.source.artifactId,
      freshness: 'CURRENT',
      revision: input.source.revision,
      contentHash: input.source.fingerprint,
    },
  });
  const step = await tx.customizedStoryboardStep.findFirst({
    where: { projectId: p, taskId: id, nodeId: 'SAVE', status: 'SUCCEEDED' },
  });
  if ((step?.output as { applied?: boolean })?.applied) {
    if (
      workflowStateHash((step!.output as { adopted: unknown }).adopted) !==
      workflowStateHash(script)
    )
      return customizedConflict('此候选已经保存了其他内容');
    return { workflowRunId: r, unchanged: true };
  }
  if (!artifact || artifact.revision !== local.baselineRevision || !brief || !step)
    return customizedConflict('脚本或信息卡已变化，候选仍保留，请重新局部更新');
  const currentBrief =
    local.informationMode === 'CURRENT'
      ? await sharedCustomizedBrief(tx, p, r, undefined, true)
      : await tx.workingArtifact.findFirst({
          where: { projectId: p, workflowRunId: r, artifactKey: 'customized-brief' },
        });
  if (
    !currentBrief ||
    currentBrief.id !== brief.id ||
    currentBrief.revision !== brief.revision ||
    currentBrief.contentHash !== brief.contentHash
  )
    return customizedConflict('当前商品信息已变化，请重新局部更新');
  const edit = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: {
        projectId: p,
        workflowRunId: r,
        nodeId: `CUSTOMIZED_SCRIPT_EDIT:${local.scriptId}`,
      },
    },
  });
  const record = await tx.customizedStoryboardScript.findFirst({
    where: { projectId: p, id: local.scriptId },
  });
  if (record?.editing || (edit?.state as { editing?: boolean })?.editing)
    return customizedConflict('请先保存或取消当前脚本编辑');
  if (
    await tx.customizedProductionTask.count({
      where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
    })
  )
    return customizedConflict('制作任务执行中，暂不能保存脚本');
  let unchanged: boolean;
  await adoptSharedCustomizedBrief(tx, working, p, r, brief);
  const metadata = { localUpdate: true, confirmedBrief: input.brief };
  if (
    artifact.name === script.name &&
    workflowStateHash(artifact.payload) === workflowStateHash(script)
  ) {
    await rebindUnchanged(tx, p, r, artifact.id, [brief], json(metadata));
    unchanged = true;
  } else {
    const [result] = await working.commitValidatedArtifactsInTransaction(tx, p, r, 'STORYBOARD', [
      {
        artifactKey: artifact.artifactKey,
        input: {
          kind: 'STRUCTURED',
          name: script.name,
          directory: 'SCRIPTS',
          type: 'STORYBOARD_SCRIPT',
          payload: script,
          metadata,
          dependencies: [
            {
              sourceType: 'WORKING_ARTIFACT',
              sourceArtifactId: brief.id,
              sourceNodeId: brief.nodeId,
              sourceKey: brief.artifactKey,
              sourceRevision: brief.revision,
              sourceHash: brief.contentHash,
            },
          ],
        },
      },
    ]);
    unchanged = result!.unchanged;
  }
  if (edit)
    await tx.workflowNodeState.update({
      where: { id: edit.id },
      data: {
        state: json({ editing: false, script }),
        contentHash: workflowStateHash({ editing: false, script }),
        revision: { increment: 1 },
      },
    });
  await tx.workflowRun.update({ where: { id: r }, data: { forkScriptId: script.id } });
  await tx.customizedStoryboardStep.update({
    where: { id: step.id },
    data: { output: json({ ...(step.output as object), applied: true, adopted: script }) },
  });
  return { workflowRunId: r, unchanged };
}
/** Scoped edits of an adopted local script never mutate the shared script record. */
export async function editLocalScript(
  tx: Tx,
  working: WorkflowWorkingRepository,
  p: string,
  r: string,
  sid: string,
  action: string,
  revision: number,
  script?: CustomizedStoryboardScript,
) {
  const run = await tx.workflowRun.findFirst({
    where: { ...customizedScope(p), id: r, status: { in: ['ACTIVE', 'PAUSED'] } },
  });
  const artifact = await tx.workingArtifact.findFirst({
    where: { projectId: p, workflowRunId: r, artifactKey: `customized-script:${sid}` },
  });
  const context = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: {
        projectId: p,
        workflowRunId: r,
        nodeId: INFORMATION_CONTEXT,
      },
    },
  });
  if (
    !run ||
    run.editSessionNodeId ||
    !artifact ||
    ((artifact.metadata as { localUpdate?: boolean } | null)?.localUpdate !== true &&
      (context?.state as { mode?: string } | undefined)?.mode !== 'CURRENT')
  )
    return null;
  const nodeId = `CUSTOMIZED_SCRIPT_EDIT:${sid}`;
  const state = await tx.workflowNodeState.findUnique({
    where: { projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId } },
  });
  const value = state?.state as
    { editing: boolean; script: CustomizedStoryboardScript } | undefined;
  if (revision !== (state?.revision ?? artifact.revision))
    return customizedConflict('当前路径脚本已更新，本地修改仍保留');
  if (
    (await tx.customizedProductionTask.count({
      where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
    })) ||
    (await tx.customizedStoryboardTask.count({
      where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
    }))
  )
    return customizedConflict('当前路径仍有任务执行');
  if (action !== 'begin' && !value?.editing) return customizedConflict('请先进入脚本编辑');
  const candidate = action === 'begin' || action === 'cancel' ? artifact.payload : script;
  if (!isCustomizedStoryboardScript(candidate) || candidate.id !== sid)
    return customizedConflict('脚本内容不正确');
  const editing = action === 'begin' || action === 'draft';
  if (action === 'save') {
    if (validateStoryboardPublication(candidate)) return customizedConflict('脚本内容不完整');
    const brief = await sharedCustomizedBrief(
      tx,
      p,
      r,
      await tx.workingArtifact.findFirst({
        where: {
          projectId: p,
          workflowRunId: r,
          artifactKey: 'customized-brief',
          freshness: 'CURRENT',
        },
      }),
    );
    if (!brief) return customizedConflict('请先确认信息卡');
    await adoptSharedCustomizedBrief(tx, working, p, r, brief);
    if (
      artifact.name === candidate.name &&
      workflowStateHash(artifact.payload) === workflowStateHash(candidate)
    )
      await rebindUnchanged(
        tx,
        p,
        r,
        artifact.id,
        [brief],
        json({ localUpdate: true, confirmedBrief: brief.payload }),
      );
    else
      await working.commitValidatedArtifactsInTransaction(tx, p, r, 'STORYBOARD', [
        {
          artifactKey: artifact.artifactKey,
          input: {
            kind: 'STRUCTURED',
            name: candidate.name,
            directory: 'SCRIPTS',
            type: 'STORYBOARD_SCRIPT',
            payload: candidate,
            metadata: { localUpdate: true, confirmedBrief: brief.payload },
            dependencies: [
              {
                sourceType: 'WORKING_ARTIFACT',
                sourceArtifactId: brief.id,
                sourceKey: brief.artifactKey,
                sourceNodeId: brief.nodeId,
                sourceRevision: brief.revision,
                sourceHash: brief.contentHash,
              },
            ],
          },
        },
      ]);
  }
  const next = { editing, script: candidate };
  const saved = await tx.workflowNodeState.upsert({
    where: { projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId } },
    create: {
      projectId: p,
      workflowRunId: r,
      nodeId,
      state: json(next),
      contentHash: workflowStateHash(next),
    },
    update: { state: json(next), contentHash: workflowStateHash(next), revision: { increment: 1 } },
  });
  return { revision: saved.revision, workflowRunId: r };
}
