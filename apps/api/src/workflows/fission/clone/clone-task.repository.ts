import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CLONE_ANALYSIS_ARTIFACT_KEY,
  CLONE_ANALYSIS_INSTRUCTION_VERSION,
  CLONE_INPUT_ARTIFACT_KEY,
  CLONE_MAPPING_ARTIFACT_KEY,
  CLONE_GENERATION_QUEUE,
  emptyCloneAnalysisDraft,
  emptyCloneMappingDraft,
  normalizeCloneInputDraft,
  parseCloneAnalysisDraft,
  parseCloneMappingDraft,
  parseCloneTaskResult,
  validateCloneMappingForReport,
  validateCloneVisualOnlyReport,
  type CloneAnalysisConfirmRequest,
  type CloneAnalysisDraft,
  type CloneAnalysisDraftSaveRequest,
  type CloneAnalysisReport,
  type CloneArtifactRef,
  type CloneG2Workspace,
  type CloneKeepTextEvidence,
  type CloneMappingCandidate,
  type CloneMappingConfirmRequest,
  type CloneMappingDraft,
  type CloneTask,
  type CloneTaskCheckpointRequest,
  type CloneTaskClaim,
  type CloneTaskCreateRequest,
  type CloneTaskFile,
  type CloneTaskOperation,
  type CloneTaskProgressRequest,
  type CloneTaskResult,
  type CloneTaskSnapshot,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma, FissionCloneTask } from '../../../generated/prisma/client';
import { ApiHttpException } from '../../../common/api-http-exception';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
  type WorkingArtifactUpsertInput,
} from '../../../platform/workflow/workflow-working.repository';
import { lockCloneRun } from '../../../platform/workflow/fission-clone-scope';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { loadCloneGenerationPlan } from './clone-generation-source';
import {
  generationChildren,
  hasUnknownCloneRender,
  pendingGenerationBatch,
  releaseCloneTaskFiles,
  verifyGenerationSources,
  verifyGenerationBatchSources,
} from './clone-generation-task-state';
import {
  assertNoActiveCloneTasks,
  cloneArtifactRef,
  cloneConflict,
  requireCloneSource,
  validateCloneG2DraftInTransaction,
  validateCloneMappingAssets,
  validateCloneMappingConfirmation,
} from './clone-task-scope';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const scope = (projectId: string, workflowRunId: string) => ({ projectId, workflowRunId });
const nodeFor = (operation: CloneTaskOperation) =>
  operation === 'ANALYZE' ? 'CLONE_ANALYSIS' : 'CLONE_MAPPING';
const keyFor = (operation: CloneTaskOperation) =>
  operation === 'ANALYZE' ? CLONE_ANALYSIS_ARTIFACT_KEY : CLONE_MAPPING_ARTIFACT_KEY;
const validateContract = (check: () => void) => {
  try {
    check();
  } catch (error) {
    throw new ApiHttpException(
      error instanceof Error ? error.message : '复刻结果格式无效',
      400,
      'VALIDATION_ERROR',
    );
  }
};
const validatePropSuggestions = (mapping: CloneMappingDraft, snapshot: CloneTaskSnapshot) => {
  const selected = new Map(
    snapshot.mapping?.bindings
      .filter((binding) => binding.type === 'prop')
      .map((binding) => [binding.elementId, binding]),
  );
  const suggested = new Map(mapping.bindings.map((binding) => [binding.elementId, binding]));
  for (const element of snapshot.analysis?.report.elements ?? []) {
    if (element.type !== 'prop') continue;
    const binding = suggested.get(element.elementId);
    const original = selected.get(element.elementId);
    if (
      !binding ||
      (original
        ? workflowStateHash(binding) !== workflowStateHash(original)
        : binding.action !== 'KEEP' || binding.target !== null)
    )
      cloneConflict('道具请按用户选择保留或替换，智能匹配不能擅自修改');
  }
};
const safeStages: Record<string, string> = {
  QUEUED: '等待处理',
  PREPARE: '准备参考资料',
  DOWNLOAD: '读取参考资料',
  SAMPLE: '提取画面证据',
  ANALYZE: '分析视频画面',
  SMART_MATCH: '匹配映射目标',
  VALIDATE_KEEP_TEXT: '核对保留文本',
  VALIDATE: '校验结果',
  SAVE: '保存处理结果',
  RENDER: '生成镜头',
  COMPOSE: '合成成片',
  REVIEW: '检查成片画面',
  PLAN: '规划成片差异',
  PLAN_REVIEW: '审核批次方案',
  SUCCEEDED: '处理完成',
  FAILED: '处理失败',
  CANCELLED: '任务已取消',
};

export function presentCloneTask(task: FissionCloneTask): CloneTask {
  const result = task.result ? parseCloneTaskResult(task.result) : null;
  return {
    id: task.id,
    operation: task.operation as CloneTaskOperation,
    purpose: task.purpose as CloneTask['purpose'],
    status: task.status as CloneTask['status'],
    progress: task.progress,
    stage: task.currentStage,
    message: safeStages[task.currentStage] ?? '正在处理',
    error: task.errorMessage,
    attemptCount: task.attemptCount,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    canRetry: task.status === 'FAILED' && task.errorCode !== 'PERMANENT_FAILURE',
    suggestionPending:
      task.status === 'SUCCEEDED' && task.purpose === 'SMART_MATCH' && !task.appliedToDraft,
    appliedToDraft: task.appliedToDraft,
    result,
  };
}

@Injectable()
export class CloneTaskRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  generationPlan(projectId: string, runId: string, sourceMapping: CloneArtifactRef) {
    return this.db.$transaction((tx) =>
      loadCloneGenerationPlan(tx, projectId, runId, sourceMapping),
    );
  }

  private leaseMs() {
    return (
      Math.min(
        600,
        Math.max(15, this.config.get<number>('FISSION_CLONE_TASK_LEASE_SECONDS') ?? 90),
      ) * 1000
    );
  }
  accessRun(projectId: string, runId: string, writable = true) {
    return this.db.$transaction((tx) => lockCloneRun(tx, projectId, runId, { writable }));
  }
  maxAttempts() {
    return Math.min(
      10,
      Math.max(1, this.config.get<number>('FISSION_CLONE_TASK_MAX_ATTEMPTS') ?? 3),
    );
  }
  private draft(tx: Prisma.TransactionClient, projectId: string, runId: string, nodeId: string) {
    return tx.workflowNodeState.findUnique({
      where: { projectId_workflowRunId_nodeId: { ...scope(projectId, runId), nodeId } },
    });
  }
  private artifact(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
    artifactKey: string,
  ) {
    return tx.workingArtifact.findFirst({ where: { ...scope(projectId, runId), artifactKey } });
  }
  private async saveDraft(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
    nodeId: string,
    state: unknown,
    expectedRevision: number,
  ) {
    const previous = await this.draft(tx, projectId, runId, nodeId);
    if ((previous?.revision ?? 0) !== expectedRevision)
      cloneConflict('草稿已在其他窗口更新，当前编辑已保留');
    const contentHash = workflowStateHash(state);
    if (previous?.contentHash === contentHash) return previous;
    return tx.workflowNodeState.upsert({
      where: { projectId_workflowRunId_nodeId: { ...scope(projectId, runId), nodeId } },
      create: { ...scope(projectId, runId), nodeId, state: json(state), contentHash },
      update: { state: json(state), contentHash, revision: { increment: 1 } },
    });
  }
  private async input(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
    ref: CloneArtifactRef,
  ) {
    const artifact = await requireCloneSource(tx, projectId, runId, CLONE_INPUT_ARTIFACT_KEY, ref);
    const payload = artifact.payload as unknown as {
      input: unknown;
      files: { fileObjectId: string; media: CloneTaskFile['media'] }[];
    };
    const files = artifact.files.map(({ fileObject, role }) => {
      if (fileObject.status !== 'AVAILABLE') cloneConflict('参考或商品文件不可用');
      const media = payload.files.find((file) => file.fileObjectId === fileObject.id)?.media;
      if (!media) cloneConflict('确认输入缺少媒体信息，请重新确认');
      return {
        fileObjectId: fileObject.id,
        originalFileName: fileObject.originalFileName,
        mimeType: fileObject.mimeType,
        sizeBytes: fileObject.sizeBytes,
        sha256: fileObject.sha256,
        role,
        media,
      };
    });
    if (!files.some((file) => file.role === 'REFERENCE')) cloneConflict('已确认输入缺少参考视频');
    return {
      ref: cloneArtifactRef(artifact),
      input: normalizeCloneInputDraft(payload.input),
      files,
    };
  }
  private async analysis(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
    ref: CloneArtifactRef | null,
  ) {
    const artifact = await requireCloneSource(
      tx,
      projectId,
      runId,
      CLONE_ANALYSIS_ARTIFACT_KEY,
      ref,
    );
    const payload = artifact.payload as unknown as {
      report: CloneAnalysisReport;
      sourceInput: CloneArtifactRef;
    };
    return { ref: cloneArtifactRef(artifact), report: payload.report };
  }

  async workspace(projectId: string, runId: string): Promise<CloneG2Workspace> {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId);
      const [ad, md, analysis, mapping, tasks] = await Promise.all([
        this.draft(tx, projectId, runId, 'CLONE_ANALYSIS'),
        this.draft(tx, projectId, runId, 'CLONE_MAPPING'),
        this.artifact(tx, projectId, runId, CLONE_ANALYSIS_ARTIFACT_KEY),
        this.artifact(tx, projectId, runId, CLONE_MAPPING_ARTIFACT_KEY),
        tx.fissionCloneTask.findMany({
          where: { ...scope(projectId, runId), operation: { in: ['ANALYZE', 'MAP_SUGGEST'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 40,
        }),
      ]);
      const analysisDraft = ad ? parseCloneAnalysisDraft(ad.state) : emptyCloneAnalysisDraft();
      const mappingDraft = md ? parseCloneMappingDraft(md.state) : emptyCloneMappingDraft();
      const ap = analysis?.payload as unknown as
        { sourceInput: CloneArtifactRef; report: CloneAnalysisReport } | undefined;
      const keepTextEvidence: CloneKeepTextEvidence[] = tasks.flatMap((task) => {
        if (task.status !== 'SUCCEEDED' || task.purpose !== 'VALIDATE_KEEP_TEXT') return [];
        const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
        const result = task.result as unknown as CloneTaskResult;
        if (
          result.operation !== 'MAP_SUGGEST' ||
          result.purpose !== 'VALIDATE_KEEP_TEXT' ||
          !snapshot.analysis ||
          !snapshot.mapping
        )
          return [];
        return [
          {
            taskId: task.id,
            sourceInput: snapshot.input.ref,
            sourceAnalysis: snapshot.analysis.ref,
            mappingHash: workflowStateHash(snapshot.mapping),
            checks: result.checks,
          },
        ];
      });
      return {
        ...(this.config.get<boolean>('FISSION_CLONE_G3_ENABLED')
          ? {
              generationActive: !!(await tx.fissionCloneTask.count({
                where: {
                  ...scope(projectId, runId),
                  operation: { in: ['GENERATE', 'GENERATE_BATCH'] },
                  status: { in: ['QUEUED', 'RUNNING'] },
                },
              })),
            }
          : {}),
        analysisDraft: { revision: ad?.revision ?? 0, state: analysisDraft },
        mappingDraft: { revision: md?.revision ?? 0, state: mappingDraft },
        analysis:
          analysis && ap
            ? { ref: cloneArtifactRef(analysis), ...ap, freshness: analysis.freshness }
            : null,
        mapping: mapping
          ? {
              ref: cloneArtifactRef(mapping),
              mapping: parseCloneMappingDraft(mapping.payload),
              freshness: mapping.freshness,
            }
          : null,
        tasks: tasks.map(presentCloneTask),
        keepTextEvidence,
        analysisDraftDiverged: Boolean(
          analysis &&
          analysisDraft.report &&
          analysisDraft.baseAnalysisRevision !== analysis.revision,
        ),
      };
    });
  }

  enqueue(tx: Prisma.TransactionClient, task: FissionCloneTask) {
    const generation = ['GENERATE', 'GENERATE_BATCH'].includes(task.operation);
    const jobType = generation ? 'FISSION_CLONE_GENERATION' : 'FISSION_CLONE_ANALYSIS';
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId: task.projectId,
          jobType,
          aggregateId: task.id,
        },
      },
      create: {
        projectId: task.projectId,
        jobType,
        aggregateId: task.id,
        routingKey: generation ? CLONE_GENERATION_QUEUE : 'fission.clone.analysis.requested',
        payload: {
          schemaVersion: 1,
          projectId: task.projectId,
          runId: task.id,
          requestId: randomUUID(),
        },
      },
      update: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        attempts: 0,
        publishedAt: null,
        dispatchToken: null,
      },
    });
  }

  private async existingRequest(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
    operation: CloneTaskOperation,
    request: CloneTaskCreateRequest,
  ) {
    const existing = await tx.fissionCloneTask.findUnique({
      where: {
        projectId_workflowRunId_operation_idempotencyKey: {
          ...scope(projectId, runId),
          operation,
          idempotencyKey: request.idempotencyKey,
        },
      },
    });
    if (existing) {
      const old = existing.inputSnapshot as unknown as CloneTaskSnapshot;
      const replay = {
        sourceInput: old.input.ref,
        sourceAnalysis: old.analysis?.ref ?? null,
        expectedDraftRevision: old.expectedDraftRevision,
        expectedArtifactRevision: old.expectedArtifactRevision,
        purpose: old.purpose,
      };
      const content = {
        sourceInput: request.sourceInput,
        sourceAnalysis: request.sourceAnalysis,
        expectedDraftRevision: request.expectedDraftRevision,
        expectedArtifactRevision: request.expectedArtifactRevision,
        purpose: request.purpose,
      };
      if (workflowStateHash(replay) !== workflowStateHash(content))
        cloneConflict('同一请求标识对应不同来源或编辑版本');
      return presentCloneTask(existing);
    }
    return null;
  }
  existingTask(
    projectId: string,
    runId: string,
    operation: CloneTaskOperation,
    request: CloneTaskCreateRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true });
      return this.existingRequest(tx, projectId, runId, operation, request);
    });
  }
  create(
    projectId: string,
    runId: string,
    operation: CloneTaskOperation,
    request: CloneTaskCreateRequest,
    candidates: CloneMappingCandidate[],
    model: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: nodeFor(operation) });
      const existing = await this.existingRequest(tx, projectId, runId, operation, request);
      if (existing) return existing;
      await assertNoActiveCloneTasks(tx, projectId, runId);
      if (
        (operation === 'ANALYZE' && (request.purpose || request.sourceAnalysis)) ||
        (operation === 'MAP_SUGGEST' && !request.purpose)
      )
        throw new ApiHttpException('任务类型与执行目的不匹配', 400, 'VALIDATION_ERROR');
      const input = await this.input(tx, projectId, runId, request.sourceInput);
      const analysis =
        operation === 'MAP_SUGGEST'
          ? await this.analysis(tx, projectId, runId, request.sourceAnalysis)
          : null;
      const draft = await this.draft(tx, projectId, runId, nodeFor(operation));
      if ((draft?.revision ?? 0) !== request.expectedDraftRevision)
        cloneConflict('编辑草稿已变化，请保存后重试');
      const previous = await this.artifact(tx, projectId, runId, keyFor(operation));
      if ((previous?.revision ?? 0) !== request.expectedArtifactRevision)
        cloneConflict('节点已确认版本发生变化');
      const mapping =
        operation === 'MAP_SUGGEST'
          ? parseCloneMappingDraft(draft?.state ?? emptyCloneMappingDraft())
          : null;
      if (mapping) {
        await validateCloneG2DraftInTransaction(tx, projectId, runId, 'CLONE_MAPPING', mapping);
        if (
          !mapping.sourceInput ||
          !mapping.sourceAnalysis ||
          workflowStateHash(mapping.sourceInput) !== workflowStateHash(input.ref) ||
          workflowStateHash(mapping.sourceAnalysis) !== workflowStateHash(analysis!.ref)
        )
          cloneConflict('请先按当前报告建立映射草稿');
        validateContract(() => validateCloneMappingForReport(mapping, analysis!.report));
        if (request.purpose === 'VALIDATE_KEEP_TEXT') {
          const ids = validateCloneMappingConfirmation(mapping, analysis!.report);
          if (!ids.length) cloneConflict('当前没有需要核对的保留文本');
        }
      }
      for (const candidate of candidates) {
        const row = await tx.assetVersion.findFirst({
          where: {
            projectId,
            assetId: candidate.assetId,
            version: candidate.version,
            id: candidate.sourceVersionId,
            status: 'AVAILABLE',
            asset: { archivedAt: null, status: 'AVAILABLE' },
          },
        });
        if (!row || candidate.file) cloneConflict('候选资产已发生变化，请重新匹配');
      }
      const frozenCandidates = [...candidates];
      if (request.purpose === 'SMART_MATCH') {
        for (const binding of mapping?.bindings ?? []) {
          const asset = binding.target?.asset;
          if (
            binding.type !== 'prop' ||
            !asset ||
            frozenCandidates.some(
              (item) => item.assetId === asset.assetId && item.version === asset.version,
            )
          )
            continue;
          const version = await tx.assetVersion.findFirst({
            where: {
              projectId,
              assetId: asset.assetId,
              version: asset.version,
              status: 'AVAILABLE',
              asset: { archivedAt: null, status: 'AVAILABLE', hasFile: true },
            },
            include: { asset: true },
          });
          if (!version) cloneConflict('已选道具图片版本不可用，请重新选择');
          frozenCandidates.push({
            ...asset,
            sourceVersionId: version.id,
            name: version.asset.name,
            type: version.asset.type,
            mimeType: version.mimeType,
            file: null,
          });
        }
      }
      const snapshot: CloneTaskSnapshot = {
        schemaVersion: 1,
        ...(operation === 'ANALYZE'
          ? { analysisInstructionVersion: CLONE_ANALYSIS_INSTRUCTION_VERSION }
          : {}),
        operation,
        purpose: request.purpose,
        input,
        analysis,
        mapping,
        candidates: frozenCandidates,
        expectedDraftRevision: request.expectedDraftRevision,
        expectedArtifactRevision: request.expectedArtifactRevision,
        model,
      };
      const task = await tx.fissionCloneTask.create({
        data: {
          ...scope(projectId, runId),
          operation,
          purpose: request.purpose,
          idempotencyKey: request.idempotencyKey,
          inputHash: workflowStateHash(snapshot),
          inputSnapshot: json(snapshot),
        },
      });
      const files = [
        ...input.files,
        ...candidates.flatMap((candidate) => (candidate.file ? [candidate.file] : [])),
      ];
      if (mapping) {
        for (const file of await validateCloneMappingAssets(tx, projectId, runId, mapping))
          files.push({
            ...file,
            fileObjectId: file.id,
            role: 'MAPPING',
            media: { durationMs: null, width: 0, height: 0, frameRate: null },
          });
      }
      for (const file of new Map(files.map((file) => [file.fileObjectId, file])).values())
        await tx.fissionCloneFileHold.create({
          data: {
            ...scope(projectId, runId),
            taskId: task.id,
            fileObjectId: file.fileObjectId,
            sha256: file.sha256,
          },
        });
      await this.enqueue(tx, task);
      return presentCloneTask(task);
    });
  }

  async taskScope(
    tx: Prisma.TransactionClient,
    projectId: string,
    taskId: string,
    runId?: string,
    writable = false,
    generation: boolean | 'all' = false,
  ) {
    const found = await tx.fissionCloneTask.findFirst({
      where: {
        projectId,
        id: taskId,
        ...(runId ? { workflowRunId: runId } : {}),
        operation:
          generation === 'all'
            ? { in: ['GENERATE', 'GENERATE_BATCH'] }
            : generation
              ? 'GENERATE'
              : { in: ['ANALYZE', 'MAP_SUGGEST'] },
      },
    });
    if (!found) throw new ApiHttpException('复刻任务不存在', 404, 'VALIDATION_ERROR');
    const run = await lockCloneRun(tx, projectId, found.workflowRunId, { writable });
    if (!['ACTIVE', 'PAUSED'].includes(run.status) || run.activeKey !== 'ACTIVE')
      cloneConflict('复刻工作流已终结');
    return (await tx.fissionCloneTask.findUnique({ where: { id: found.id } }))!;
  }
  private async sources(tx: Prisma.TransactionClient, task: FissionCloneTask) {
    const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
    if (workflowStateHash(snapshot) !== task.inputHash) cloneConflict('任务输入快照校验失败');
    await requireCloneSource(
      tx,
      task.projectId,
      task.workflowRunId,
      CLONE_INPUT_ARTIFACT_KEY,
      snapshot.input.ref,
    );
    if (snapshot.analysis)
      await requireCloneSource(
        tx,
        task.projectId,
        task.workflowRunId,
        CLONE_ANALYSIS_ARTIFACT_KEY,
        snapshot.analysis.ref,
      );
    const holds = await tx.fissionCloneFileHold.findMany({
      where: { projectId: task.projectId, taskId: task.id },
      include: { fileObject: true },
    });
    for (const hold of holds)
      if (hold.fileObject.status !== 'AVAILABLE' || hold.fileObject.sha256 !== hold.sha256)
        cloneConflict('任务冻结文件不可用');
    const frozenFiles = [
      ...snapshot.input.files,
      ...snapshot.candidates.flatMap((candidate) => (candidate.file ? [candidate.file] : [])),
    ];
    if (
      frozenFiles.some(
        (file) =>
          !holds.some(
            (hold) => hold.fileObjectId === file.fileObjectId && hold.sha256 === file.sha256,
          ),
      )
    )
      cloneConflict('任务来源文件引用不完整');
    return snapshot;
  }
  async lease(
    tx: Prisma.TransactionClient,
    projectId: string,
    taskId: string,
    token: string,
    generation: boolean | 'all' = false,
  ) {
    const task = await this.taskScope(tx, projectId, taskId, undefined, false, generation);
    if (
      task.status !== 'RUNNING' ||
      task.attemptToken !== token ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= new Date()
    )
      cloneConflict('任务执行租约已失效');
    if (task.operation === 'GENERATE_BATCH') await verifyGenerationBatchSources(tx, task);
    else if (generation) await verifyGenerationSources(tx, task);
    else await this.sources(tx, task);
    return task;
  }
  async task(projectId: string, runId: string, taskId: string) {
    return this.db.$transaction(async (tx) =>
      presentCloneTask(await this.taskScope(tx, projectId, taskId, runId)),
    );
  }
  claim(projectId: string, taskId: string): Promise<CloneTaskClaim> {
    return this.db.$transaction(async (tx) => {
      const task = await this.taskScope(tx, projectId, taskId);
      const noClaim: CloneTaskClaim = {
        claimed: false,
        taskId,
        projectId,
        workflowRunId: task.workflowRunId,
        attemptToken: null,
        leaseExpiresAt: null,
        inputHash: null,
        snapshot: null,
        checkpoints: [],
      };
      if (task.status !== 'QUEUED') return noClaim;
      if (task.attemptCount >= this.maxAttempts()) {
        await tx.fissionCloneTask.update({
          where: { id: taskId },
          data: {
            status: 'FAILED',
            currentStage: 'FAILED',
            errorCode: 'PERMANENT_FAILURE',
            errorMessage: '任务已达到自动执行次数上限，请检查配置后重新创建任务',
          },
        });
        await tx.fissionCloneFileHold.deleteMany({ where: { projectId, taskId } });
        return noClaim;
      }
      const snapshot = await this.sources(tx, task);
      const { attemptToken, leaseExpiresAt } = await this.startAttempt(tx, task);
      const checkpoints = await tx.fissionCloneTaskStep.findMany({
        where: { projectId, taskId, inputHash: task.inputHash },
        orderBy: { createdAt: 'asc' },
      });
      return {
        claimed: true,
        taskId,
        projectId,
        workflowRunId: task.workflowRunId,
        attemptToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        inputHash: task.inputHash,
        snapshot,
        checkpoints: checkpoints
          .filter((step) => workflowStateHash(step.output) === step.outputHash)
          .map((step) => ({
            key: step.stepKey,
            inputHash: step.inputHash,
            output: parseCloneTaskResult(step.output),
          })),
      };
    });
  }
  async startAttempt(tx: Prisma.TransactionClient, task: FissionCloneTask) {
    const attemptToken = randomUUID(),
      leaseExpiresAt = new Date(Date.now() + this.leaseMs());
    await tx.fissionCloneTask.update({
      where: { id: task.id },
      data: {
        status: 'RUNNING',
        attemptCount: { increment: 1 },
        attemptToken,
        leaseExpiresAt,
        currentStage: 'PREPARE',
        errorCode: null,
        errorMessage: null,
      },
    });
    return { attemptToken, leaseExpiresAt };
  }
  heartbeat(projectId: string, taskId: string, token: string, generation: boolean | 'all' = false) {
    return this.db.$transaction(async (tx) => {
      await this.lease(tx, projectId, taskId, token, generation);
      await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: { leaseExpiresAt: new Date(Date.now() + this.leaseMs()) },
      });
      return { accepted: true };
    });
  }
  progress(
    projectId: string,
    taskId: string,
    token: string,
    input: CloneTaskProgressRequest,
    generation: boolean | 'all' = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.lease(tx, projectId, taskId, token, generation);
      await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: {
          progress: Math.max(task.progress, Math.min(99, input.progress)),
          currentStage:
            Object.hasOwn(safeStages, input.stage) &&
            !['QUEUED', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(input.stage)
              ? input.stage
              : 'ANALYZE',
          leaseExpiresAt: new Date(Date.now() + this.leaseMs()),
        },
      });
      return { accepted: true };
    });
  }
  checkpoint(projectId: string, taskId: string, token: string, input: CloneTaskCheckpointRequest) {
    return this.db.$transaction(async (tx) => {
      if (input.key !== 'RESULT_V1')
        throw new ApiHttpException('不支持的任务检查点', 400, 'VALIDATION_ERROR');
      const task = await this.lease(tx, projectId, taskId, token);
      if (input.inputHash !== task.inputHash) cloneConflict('检查点来源与任务快照不一致');
      await this.validateResult(tx, task, input.output);
      const outputHash = workflowStateHash(input.output);
      await tx.fissionCloneTaskStep.upsert({
        where: {
          projectId_workflowRunId_taskId_stepKey: {
            projectId,
            workflowRunId: task.workflowRunId,
            taskId,
            stepKey: input.key,
          },
        },
        create: {
          projectId,
          workflowRunId: task.workflowRunId,
          taskId,
          stepKey: input.key,
          inputHash: task.inputHash,
          outputHash,
          output: json(input.output),
          attemptToken: token,
        },
        update: { outputHash, output: json(input.output), attemptToken: token },
      });
      return { accepted: true, outputHash };
    });
  }

  /** Fence metadata-only suggestions before external file preparation, then again on write. */
  resultAssets(
    projectId: string,
    taskId: string,
    token: string,
    result: CloneTaskResult,
    completing = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const previous = await this.taskScope(tx, projectId, taskId);
      if (
        completing &&
        previous.status === 'SUCCEEDED' &&
        previous.attemptToken === token &&
        previous.resultHash === workflowStateHash(result)
      )
        return { runId: previous.workflowRunId, assets: [] as CloneMappingCandidate[] };
      const task = await this.lease(tx, projectId, taskId, token);
      if (result.operation !== 'MAP_SUGGEST' || result.purpose !== 'SMART_MATCH')
        return { runId: task.workflowRunId, assets: [] as CloneMappingCandidate[] };
      if (task.operation !== result.operation || task.purpose !== result.purpose)
        cloneConflict('任务结果类型不一致');
      const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
      if (
        !snapshot.analysis ||
        workflowStateHash(result.mapping.sourceInput) !== workflowStateHash(snapshot.input.ref) ||
        workflowStateHash(result.mapping.sourceAnalysis) !==
          workflowStateHash(snapshot.analysis.ref)
      )
        cloneConflict('映射建议来源不一致');
      validateContract(() =>
        validateCloneMappingForReport(result.mapping, snapshot.analysis!.report),
      );
      validatePropSuggestions(result.mapping, snapshot);
      if (
        completing &&
        !(await tx.fissionCloneTaskStep.findFirst({
          where: {
            projectId,
            taskId,
            inputHash: task.inputHash,
            outputHash: workflowStateHash(result),
          },
        }))
      )
        cloneConflict('完整结果尚未写入检查点');
      const assets = new Map<string, CloneMappingCandidate>();
      for (const binding of result.mapping.bindings) {
        if (!binding.target?.asset) continue;
        const target = binding.target.asset;
        const candidate = snapshot.candidates.find(
          (item) => item.assetId === target.assetId && item.version === target.version,
        );
        if (!candidate) cloneConflict('映射建议引用了未冻结的候选资产');
        assets.set(`${target.assetId}:${target.version}`, candidate);
      }
      return { runId: task.workflowRunId, assets: [...assets.values()] };
    });
  }

  private async validateResult(
    tx: Prisma.TransactionClient,
    task: FissionCloneTask,
    result: CloneTaskResult,
  ) {
    const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
    if (
      result.operation !== task.operation ||
      (result.operation === 'MAP_SUGGEST' && result.purpose !== task.purpose)
    )
      cloneConflict('任务结果类型不一致');
    if (result.operation === 'ANALYZE') {
      validateContract(() => validateCloneVisualOnlyReport(result.report));
      const reference = snapshot.input.files.find((file) => file.role === 'REFERENCE')!;
      if (
        result.report.durationMs !== reference.media.durationMs ||
        result.report.frameWidth !== reference.media.width ||
        result.report.frameHeight !== reference.media.height
      )
        cloneConflict('分析结果与冻结参考片规格不一致');
      if (
        snapshot.analysisInstructionVersion !== undefined &&
        result.report.shots.some((shot) => !shot.motion)
      )
        cloneConflict('分析结果缺少镜头动作观察');
      if (
        (snapshot.analysisInstructionVersion ?? 0) < 4 &&
        result.report.elements.some((element) => element.type === 'prop')
      )
        cloneConflict('分析结果的道具与冻结拆解版本不一致');
    } else if (result.purpose === 'SMART_MATCH') {
      if (
        !snapshot.analysis ||
        workflowStateHash(result.mapping.sourceInput) !== workflowStateHash(snapshot.input.ref) ||
        workflowStateHash(result.mapping.sourceAnalysis) !==
          workflowStateHash(snapshot.analysis.ref)
      )
        cloneConflict('映射建议来源不一致');
      validateContract(() =>
        validateCloneMappingForReport(result.mapping, snapshot.analysis!.report),
      );
      validatePropSuggestions(result.mapping, snapshot);
      for (const binding of result.mapping.bindings)
        if (
          binding.target?.asset &&
          !snapshot.candidates.some(
            (candidate) =>
              candidate.assetId === binding.target!.asset!.assetId &&
              candidate.version === binding.target!.asset!.version,
          )
        )
          cloneConflict('映射建议引用了未冻结的候选资产');
      const files = await validateCloneMappingAssets(
        tx,
        task.projectId,
        task.workflowRunId,
        result.mapping,
      );
      for (const file of files) {
        const prepared = await tx.fissionCloneMappingFile.findFirst({
          where: { ...scope(task.projectId, task.workflowRunId), fileObjectId: file.id },
        });
        const candidate = snapshot.candidates.find(
          (item) => item.assetId === prepared?.assetId && item.version === prepared.version,
        );
        if (!prepared || !candidate || candidate.sourceVersionId !== prepared.sourceVersionId)
          cloneConflict('映射候选资产身份发生变化');
        await tx.fissionCloneFileHold.upsert({
          where: {
            projectId_workflowRunId_taskId_fileObjectId: {
              ...scope(task.projectId, task.workflowRunId),
              taskId: task.id,
              fileObjectId: file.id,
            },
          },
          create: {
            ...scope(task.projectId, task.workflowRunId),
            taskId: task.id,
            fileObjectId: file.id,
            sha256: file.sha256,
          },
          update: {},
        });
      }
    } else {
      const ids = snapshot
        .mapping!.bindings.filter((binding) => binding.target?.contentStrategy === 'KEEP')
        .map((binding) => binding.elementId)
        .sort();
      if (
        workflowStateHash(result.checks.map((check) => check.elementId).sort()) !==
          workflowStateHash(ids) ||
        result.checks.some((check) => !check.reason.trim() || !check.evidence.length)
      )
        cloneConflict('保留文本核对证据不完整');
    }
  }

  private async commitAnalysis(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
    sourceInput: CloneArtifactRef,
    report: CloneAnalysisReport,
    expectedRevision: number,
  ) {
    validateContract(() => validateCloneVisualOnlyReport(report));
    const input = await requireCloneSource(
      tx,
      projectId,
      runId,
      CLONE_INPUT_ARTIFACT_KEY,
      sourceInput,
    );
    const frozen = await this.input(tx, projectId, runId, sourceInput);
    const reference = frozen.files.find((file) => file.role === 'REFERENCE')!;
    if (
      report.durationMs !== reference.media.durationMs ||
      report.frameWidth !== reference.media.width ||
      report.frameHeight !== reference.media.height
    )
      cloneConflict('报告媒体规格与已确认参考视频不一致');
    const current = await this.artifact(tx, projectId, runId, CLONE_ANALYSIS_ARTIFACT_KEY);
    const payload = { sourceInput, report };
    if (
      (current?.revision ?? 0) !== expectedRevision &&
      workflowStateHash(current?.payload) !== workflowStateHash(payload)
    )
      cloneConflict('报告确认版已更新，请重新加载');
    const files = input.files.map(({ fileObject, role, sortOrder }) => ({
      fileObjectId: fileObject.id,
      role,
      sortOrder,
      originalFileName: fileObject.originalFileName,
      mimeType: fileObject.mimeType,
      sha256: fileObject.sha256,
    }));
    await this.working.commitValidatedArtifactsInTransaction(
      tx,
      projectId,
      runId,
      'CLONE_ANALYSIS',
      [
        {
          artifactKey: CLONE_ANALYSIS_ARTIFACT_KEY,
          input: {
            kind: 'STRUCTURED',
            name: '爆款复刻 · 六维拆解报告',
            directory: 'INSIGHTS',
            type: 'ANALYSIS_QUALITY_REPORT',
            payload,
            files,
            ...(current ? { expectedRevision: current.revision } : {}),
            dependencies: [
              {
                sourceType: 'WORKING_ARTIFACT',
                sourceNodeId: 'CLONE_INPUT',
                sourceArtifactId: sourceInput.artifactId,
                sourceKey: CLONE_INPUT_ARTIFACT_KEY,
                sourceRevision: sourceInput.revision,
                sourceHash: sourceInput.contentHash,
              },
            ],
          },
        },
      ],
    );
    return (await this.artifact(tx, projectId, runId, CLONE_ANALYSIS_ARTIFACT_KEY))!;
  }

  complete(projectId: string, taskId: string, token: string, result: CloneTaskResult) {
    return this.db.$transaction(async (tx) => {
      const prior = await this.taskScope(tx, projectId, taskId);
      const resultHash = workflowStateHash(result);
      if (prior.status === 'SUCCEEDED' && prior.attemptToken === token) {
        if (prior.resultHash !== resultHash) cloneConflict('已完成任务的回调内容不一致');
        return { accepted: true, taskId };
      }
      const task = await this.lease(tx, projectId, taskId, token);
      await this.validateResult(tx, task, result);
      const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
      const checkpoint = await tx.fissionCloneTaskStep.findFirst({
        where: { projectId, taskId, inputHash: task.inputHash, outputHash: resultHash },
      });
      if (!checkpoint) cloneConflict('完整结果尚未写入检查点');
      let appliedToDraft = false;
      const draft = await this.draft(tx, projectId, task.workflowRunId, nodeFor(result.operation));
      if (result.operation === 'ANALYZE') {
        const artifact = await this.commitAnalysis(
          tx,
          projectId,
          task.workflowRunId,
          snapshot.input.ref,
          result.report,
          snapshot.expectedArtifactRevision,
        );
        if ((draft?.revision ?? 0) === snapshot.expectedDraftRevision) {
          await this.saveDraft(
            tx,
            projectId,
            task.workflowRunId,
            'CLONE_ANALYSIS',
            {
              schemaVersion: 1,
              sourceInput: snapshot.input.ref,
              baseAnalysisRevision: artifact.revision,
              report: result.report,
            } satisfies CloneAnalysisDraft,
            snapshot.expectedDraftRevision,
          );
          appliedToDraft = true;
        }
      } else if (
        result.purpose === 'SMART_MATCH' &&
        (draft?.revision ?? 0) === snapshot.expectedDraftRevision
      ) {
        await this.saveDraft(
          tx,
          projectId,
          task.workflowRunId,
          'CLONE_MAPPING',
          result.mapping,
          snapshot.expectedDraftRevision,
        );
        appliedToDraft = true;
      }
      await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: {
          status: 'SUCCEEDED',
          currentStage: 'SUCCEEDED',
          progress: 100,
          result: json(result),
          resultHash,
          appliedToDraft,
          leaseExpiresAt: null,
          completedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.fissionCloneFileHold.deleteMany({ where: { projectId, taskId } });
      return { accepted: true, taskId };
    });
  }

  fail(
    projectId: string,
    taskId: string,
    token: string,
    retryable: boolean,
    generation: boolean | 'all' = false,
    generationReason?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const old = await this.taskScope(tx, projectId, taskId, undefined, false, generation);
      if (old.status === 'FAILED' && old.attemptToken === token) return { accepted: true };
      const active = await this.lease(tx, projectId, taskId, token, generation);
      const unknown = generation && (await hasUnknownCloneRender(tx, active));
      const canRetry = retryable && !unknown && active.attemptCount < this.maxAttempts();
      await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          currentStage: 'FAILED',
          leaseExpiresAt: null,
          errorCode: canRetry ? 'EXECUTION_FAILED' : 'PERMANENT_FAILURE',
          errorMessage: unknown
            ? '供应商创建结果未知，请先核查原任务'
            : (generationReason ??
              (canRetry
                ? '处理未完成，可重试；已确认内容保持不变'
                : '处理被阻断，请核对输入和服务配置后重新发起')),
        },
      });
      if (!canRetry) await releaseCloneTaskFiles(tx, active);
      return { accepted: true };
    });
  }
  cancel(projectId: string, runId: string, taskId: string, generation: boolean | 'all' = false) {
    return this.db.$transaction(async (tx) => {
      const task = await this.taskScope(tx, projectId, taskId, runId, true, generation);
      if (task.status === 'CANCELLED') return;
      if (
        task.generationParentId ||
        (task.operation === 'GENERATE_BATCH' && ['SAMPLE', 'PLANNED'].includes(task.currentStage))
      ) {
        const parent = await tx.fissionCloneTask.findFirst({
          where: {
            projectId,
            workflowRunId: runId,
            id: task.generationParentId ?? task.id,
            operation: 'GENERATE_BATCH',
          },
        });
        if (!parent || !['SAMPLE', 'PLANNED'].includes(parent.currentStage))
          cloneConflict('只有未交付的成片批次可以取消');
        const children = await generationChildren(tx, parent);
        await tx.fissionCloneTask.updateMany({
          where: {
            projectId,
            workflowRunId: runId,
            id: { in: [parent.id, ...children.map((item) => item.id)] },
          },
          data: {
            status: 'CANCELLED',
            currentStage: 'CANCELLED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorCode: null,
            errorMessage: null,
            completedAt: new Date(),
          },
        });
        for (const item of children) await releaseCloneTaskFiles(tx, item);
        await releaseCloneTaskFiles(tx, parent);
        return;
      }
      if (!['QUEUED', 'RUNNING', 'FAILED'].includes(task.status))
        cloneConflict('已成功任务不能取消');
      await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: {
          status: 'CANCELLED',
          currentStage: 'CANCELLED',
          attemptToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      await releaseCloneTaskFiles(tx, task);
    });
  }
  retry(projectId: string, runId: string, taskId: string, generation: boolean | 'all' = false) {
    return this.db.$transaction(async (tx) => {
      const task = await this.taskScope(tx, projectId, taskId, runId, true, generation);
      if (task.status === 'QUEUED') return;
      if (
        task.status !== 'FAILED' ||
        task.errorCode === 'PERMANENT_FAILURE' ||
        task.attemptCount >= this.maxAttempts()
      )
        cloneConflict('此任务不能重试，请核对来源和配置后重新创建');
      await assertNoActiveCloneTasks(tx, projectId, runId, task.generationParentId);
      if (generation) {
        const pending = await pendingGenerationBatch(tx, projectId, runId);
        if (pending?.id && pending.id !== task.generationParentId)
          cloneConflict('请先处理当前未完成的成片批次');
        if (task.operation === 'GENERATE_BATCH') await verifyGenerationBatchSources(tx, task);
        else await verifyGenerationSources(tx, task);
        if (await hasUnknownCloneRender(tx, task))
          cloneConflict('供应商创建结果未知，请先核查原任务');
      } else {
        await this.sources(tx, task);
        const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
        const target = await this.artifact(
          tx,
          projectId,
          runId,
          keyFor(task.operation as CloneTaskOperation),
        );
        if ((target?.revision ?? 0) !== snapshot.expectedArtifactRevision)
          cloneConflict('目标确认内容已更新，请创建新任务');
      }
      const next = await tx.fissionCloneTask.update({
        where: { id: taskId },
        data: {
          status: 'QUEUED',
          currentStage: 'QUEUED',
          errorCode: null,
          errorMessage: null,
          attemptToken: null,
          leaseExpiresAt: null,
        },
      });
      await this.enqueue(tx, next);
    });
  }

  async recoverExpired() {
    const tasks = await this.db.fissionCloneTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: new Date() } },
      take: 50,
      orderBy: { leaseExpiresAt: 'asc' },
    });
    for (const row of tasks)
      await this.db
        .$transaction(async (tx) => {
          const generation =
            row.operation === 'GENERATE_BATCH' ? 'all' : row.operation === 'GENERATE';
          const task = await this.taskScope(
            tx,
            row.projectId,
            row.id,
            undefined,
            false,
            generation,
          );
          if (task.status !== 'RUNNING' || !task.leaseExpiresAt || task.leaseExpiresAt > new Date())
            return;
          const unknown = generation && (await hasUnknownCloneRender(tx, task));
          let canRecover = !unknown && task.attemptCount < this.maxAttempts();
          try {
            if (task.operation === 'GENERATE_BATCH') await verifyGenerationBatchSources(tx, task);
            else if (generation) await verifyGenerationSources(tx, task);
            else await this.sources(tx, task);
          } catch {
            canRecover = false;
          }
          const next = await tx.fissionCloneTask.update({
            where: { id: task.id },
            data: {
              status: canRecover ? 'QUEUED' : 'FAILED',
              currentStage: canRecover ? 'QUEUED' : 'FAILED',
              attemptToken: null,
              leaseExpiresAt: null,
              errorCode: canRecover ? null : 'PERMANENT_FAILURE',
              errorMessage: canRecover
                ? null
                : unknown
                  ? '供应商创建结果未知，请先核查原任务'
                  : '任务租约过期且不能继续恢复，请核对来源与配置',
            },
          });
          if (canRecover) await this.enqueue(tx, next);
          else await releaseCloneTaskFiles(tx, task);
        })
        .catch(() => undefined);
  }

  async sourceFile(
    projectId: string,
    taskId: string,
    token: string,
    fileObjectId: string,
    generation = false,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.lease(tx, projectId, taskId, token, generation);
      const hold = await tx.fissionCloneFileHold.findFirst({
        where: { projectId, taskId, fileObjectId },
        include: { fileObject: true },
      });
      if (!hold || hold.fileObject.status !== 'AVAILABLE' || hold.fileObject.sha256 !== hold.sha256)
        cloneConflict('文件不属于当前执行快照');
      return hold.fileObject;
    });
  }

  saveAnalysis(projectId: string, runId: string, request: CloneAnalysisDraftSaveRequest) {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_ANALYSIS' });
      const state = await validateCloneG2DraftInTransaction(
        tx,
        projectId,
        runId,
        'CLONE_ANALYSIS',
        request.state,
      );
      await this.saveDraft(tx, projectId, runId, 'CLONE_ANALYSIS', state, request.expectedRevision);
    });
  }
  confirmAnalysis(projectId: string, runId: string, request: CloneAnalysisConfirmRequest) {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_ANALYSIS' });
      await assertNoActiveCloneTasks(tx, projectId, runId);
      const draft = await this.draft(tx, projectId, runId, 'CLONE_ANALYSIS');
      if (!draft) cloneConflict('报告草稿已变化，请重新核对');
      const state = parseCloneAnalysisDraft(draft.state);
      // A successful manual commit only advances the draft's baseline. Replaying a lost
      // response may acknowledge that exact transition, but never a later edited draft.
      if (
        draft.revision === request.expectedDraftRevision + 1 &&
        state.baseAnalysisRevision === request.expectedAnalysisRevision + 1
      ) {
        const current = await this.artifact(tx, projectId, runId, CLONE_ANALYSIS_ARTIFACT_KEY);
        if (
          current?.revision === state.baseAnalysisRevision &&
          workflowStateHash(current.payload) ===
            workflowStateHash({ sourceInput: state.sourceInput, report: state.report })
        )
          return;
      }
      if (draft.revision !== request.expectedDraftRevision)
        cloneConflict('报告草稿已变化，请重新核对');
      if (!state.report || !state.sourceInput) cloneConflict('尚无可提交的完整报告');
      if (state.baseAnalysisRevision !== request.expectedAnalysisRevision)
        cloneConflict('人工编辑基于旧报告，请重新进入编辑');
      const artifact = await this.commitAnalysis(
        tx,
        projectId,
        runId,
        state.sourceInput,
        state.report,
        request.expectedAnalysisRevision,
      );
      await this.saveDraft(
        tx,
        projectId,
        runId,
        'CLONE_ANALYSIS',
        { ...state, baseAnalysisRevision: artifact.revision },
        draft.revision,
      );
    });
  }
  confirmMapping(projectId: string, runId: string, request: CloneMappingConfirmRequest) {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: true, nodeId: 'CLONE_MAPPING' });
      await assertNoActiveCloneTasks(tx, projectId, runId);
      const draft = await this.draft(tx, projectId, runId, 'CLONE_MAPPING');
      if (!draft || draft.revision !== request.expectedDraftRevision)
        cloneConflict('映射草稿已变化，请重新核对');
      const state = parseCloneMappingDraft(draft.state);
      const input = await requireCloneSource(
        tx,
        projectId,
        runId,
        CLONE_INPUT_ARTIFACT_KEY,
        state.sourceInput,
      );
      const analysis = await this.analysis(tx, projectId, runId, state.sourceAnalysis);
      const needsEvidence = validateCloneMappingConfirmation(state, analysis.report);
      if (needsEvidence.length) {
        const evidence = await tx.fissionCloneTask.findMany({
          where: { ...scope(projectId, runId), status: 'SUCCEEDED', purpose: 'VALIDATE_KEEP_TEXT' },
        });
        const valid = evidence.some((task) => {
          const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
          const result = task.result as unknown as CloneTaskResult;
          return (
            workflowStateHash(snapshot.mapping) === workflowStateHash(state) &&
            workflowStateHash(snapshot.input.ref) === workflowStateHash(state.sourceInput) &&
            workflowStateHash(snapshot.analysis?.ref) === workflowStateHash(state.sourceAnalysis) &&
            result.operation === 'MAP_SUGGEST' &&
            result.purpose === 'VALIDATE_KEEP_TEXT' &&
            needsEvidence.every((id) =>
              result.checks.some((check) => check.elementId === id && check.passed),
            )
          );
        });
        if (!valid) cloneConflict('保留文本尚未通过当前商品事实核对，请先执行文本核对或改为替换');
      }
      const targetFiles = await validateCloneMappingAssets(tx, projectId, runId, state);
      const previous = await this.artifact(tx, projectId, runId, CLONE_MAPPING_ARTIFACT_KEY);
      if (
        (previous?.revision ?? 0) !== request.expectedMappingRevision &&
        workflowStateHash(previous?.payload) !== workflowStateHash(state)
      )
        cloneConflict('映射确认版已发生变化');
      const allFiles = [
        ...new Map(
          [...input.files.map((row) => row.fileObject), ...targetFiles].map((file) => [
            file.id,
            file,
          ]),
        ).values(),
      ];
      const dependencies: WorkingArtifactUpsertInput['dependencies'] = [
        [CLONE_INPUT_ARTIFACT_KEY, 'CLONE_INPUT', state.sourceInput!],
        [CLONE_ANALYSIS_ARTIFACT_KEY, 'CLONE_ANALYSIS', state.sourceAnalysis!],
      ].map(([key, node, ref]) => ({
        sourceType: 'WORKING_ARTIFACT',
        sourceKey: key as string,
        sourceNodeId: node as string,
        sourceArtifactId: (ref as CloneArtifactRef).artifactId,
        sourceRevision: (ref as CloneArtifactRef).revision,
        sourceHash: (ref as CloneArtifactRef).contentHash,
      }));
      await this.working.commitValidatedArtifactsInTransaction(
        tx,
        projectId,
        runId,
        'CLONE_MAPPING',
        [
          {
            artifactKey: CLONE_MAPPING_ARTIFACT_KEY,
            input: {
              kind: 'STRUCTURED',
              name: '爆款复刻 · 元素映射',
              directory: 'REPLACEMENT_PLANS',
              type: 'REPLACEMENT_MAPPING',
              payload: state,
              ...(previous ? { expectedRevision: previous.revision } : {}),
              dependencies,
              files: allFiles.map((file, index) => ({
                fileObjectId: file.id,
                role: 'MAPPING_SOURCE',
                sortOrder: index,
                originalFileName: file.originalFileName,
                mimeType: file.mimeType,
                sha256: file.sha256,
              })),
            },
          },
        ],
      );
    });
  }
  adopt(projectId: string, runId: string, taskId: string, expectedDraftRevision: number) {
    return this.db.$transaction(async (tx) => {
      const task = await this.taskScope(tx, projectId, taskId, runId, true);
      if (task.status !== 'SUCCEEDED' || task.purpose !== 'SMART_MATCH')
        cloneConflict('任务没有可采用的映射建议');
      if (task.appliedToDraft) return;
      const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
      await requireCloneSource(tx, projectId, runId, CLONE_INPUT_ARTIFACT_KEY, snapshot.input.ref);
      await requireCloneSource(
        tx,
        projectId,
        runId,
        CLONE_ANALYSIS_ARTIFACT_KEY,
        snapshot.analysis!.ref,
      );
      const result = parseCloneTaskResult(task.result);
      if (result.operation !== 'MAP_SUGGEST' || result.purpose !== 'SMART_MATCH')
        cloneConflict('建议结果类型不正确');
      await validateCloneG2DraftInTransaction(
        tx,
        projectId,
        runId,
        'CLONE_MAPPING',
        result.mapping,
      );
      await this.saveDraft(
        tx,
        projectId,
        runId,
        'CLONE_MAPPING',
        result.mapping,
        expectedDraftRevision,
      );
      await tx.fissionCloneTask.update({ where: { id: taskId }, data: { appliedToDraft: true } });
    });
  }

  async assetVersion(projectId: string, assetId: string, version: number) {
    const row = await this.db.assetVersion.findFirst({
      where: {
        projectId,
        assetId,
        version,
        status: 'AVAILABLE',
        asset: { archivedAt: null, status: 'AVAILABLE', hasFile: true },
      },
      include: { asset: true },
    });
    if (!row) throw new ApiHttpException('当前项目资产版本不可用', 404, 'ASSET_NOT_FOUND');
    return row;
  }
  async candidateVersions(projectId: string) {
    const assets = await this.db.asset.findMany({
      where: {
        projectId,
        archivedAt: null,
        status: 'AVAILABLE',
        hasFile: true,
        OR: [
          { mimeType: { startsWith: 'image/' } },
          { mimeType: { startsWith: 'video/' } },
          { mimeType: { startsWith: 'audio/' } },
          { type: 'SUBTITLE' },
        ],
      },
      take: 80,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return assets;
  }
  async preparedAsset(projectId: string, runId: string, assetId: string, version: number) {
    return this.db.fissionCloneMappingFile.findUnique({
      where: {
        projectId_workflowRunId_assetId_version: { ...scope(projectId, runId), assetId, version },
      },
      include: { fileObject: true },
    });
  }

  private async releaseUnusedPreparedFiles(
    tx: Prisma.TransactionClient,
    projectId: string,
    runId: string,
  ) {
    const rows = await tx.fissionCloneMappingFile.findMany({
      where: { ...scope(projectId, runId), createdAt: { lt: new Date(Date.now() - 10 * 60_000) } },
      include: { fileObject: true },
    });
    if (!rows.length) return;
    const protectedAssets = new Set<string>();
    const protect = (value: unknown) => {
      const mapping = value as {
        bindings?: { target?: { asset?: { assetId?: string; version?: number } } }[];
      } | null;
      for (const binding of mapping?.bindings ?? [])
        if (binding.target?.asset)
          protectedAssets.add(`${binding.target.asset.assetId}:${binding.target.asset.version}`);
    };
    const draft = await this.draft(tx, projectId, runId, 'CLONE_MAPPING');
    const artifact = await this.artifact(tx, projectId, runId, CLONE_MAPPING_ARTIFACT_KEY);
    protect(draft?.state);
    protect(artifact?.payload);
    const pending = await tx.fissionCloneTask.findMany({
      where: {
        ...scope(projectId, runId),
        OR: [
          { status: { in: ['QUEUED', 'RUNNING'] } },
          { status: 'FAILED', errorCode: { not: 'PERMANENT_FAILURE' } },
          { status: 'SUCCEEDED', purpose: 'SMART_MATCH', appliedToDraft: false },
        ],
      },
      include: { steps: true },
    });
    for (const task of pending) {
      protect((task.inputSnapshot as unknown as CloneTaskSnapshot).mapping);
      protect((task.result as { mapping?: unknown } | null)?.mapping);
      for (const step of task.steps)
        protect((step.output as { mapping?: unknown } | null)?.mapping);
    }
    const ids = rows.map((row) => row.fileObjectId);
    const holds = await tx.fissionCloneFileHold.findMany({
      where: { projectId, fileObjectId: { in: ids } },
      select: { fileObjectId: true },
    });
    const artifactFiles = await tx.workingArtifactFile.findMany({
      where: { projectId, fileObjectId: { in: ids } },
      select: { fileObjectId: true },
    });
    const protectedFiles = new Set([...holds, ...artifactFiles].map((item) => item.fileObjectId));
    for (const row of rows) {
      if (
        protectedAssets.has(`${row.assetId}:${row.version}`) ||
        protectedFiles.has(row.fileObjectId)
      )
        continue;
      await tx.fissionCloneMappingFile.delete({ where: { id: row.id } });
      await tx.storageCleanupTask.upsert({
        where: { projectId_storageKey: { projectId, storageKey: row.fileObject.storageKey } },
        create: {
          projectId,
          storageKey: row.fileObject.storageKey,
          reason: 'CLONE_MAPPING_UNUSED',
          nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
        update: {
          reason: 'CLONE_MAPPING_UNUSED',
          nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      });
    }
  }
  prepareAsset(
    projectId: string,
    runId: string,
    assetId: string,
    version: number,
    sourceVersionId: string,
    file: FileObjectInput,
    media: CloneTaskFile['media'],
    worker?: { taskId: string; token: string },
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCloneRun(tx, projectId, runId, { writable: !worker });
      if (worker) {
        const task = await this.lease(tx, projectId, worker.taskId, worker.token);
        const snapshot = task.inputSnapshot as unknown as CloneTaskSnapshot;
        if (
          task.workflowRunId !== runId ||
          !snapshot.candidates.some(
            (item) =>
              item.assetId === assetId &&
              item.version === version &&
              item.sourceVersionId === sourceVersionId,
          )
        )
          cloneConflict('映射文件不属于当前冻结候选');
      }
      const source = await tx.assetVersion.findFirst({
        where: {
          projectId,
          assetId,
          version,
          id: sourceVersionId,
          sizeBytes: file.sizeBytes,
          status: 'AVAILABLE',
          asset: { archivedAt: null, status: 'AVAILABLE' },
        },
      });
      if (!source) cloneConflict('所选资产版本发生变化，请重新选择');
      const old = await tx.fissionCloneMappingFile.findUnique({
        where: {
          projectId_workflowRunId_assetId_version: { ...scope(projectId, runId), assetId, version },
        },
        include: { fileObject: true },
      });
      if (old && old.sourceVersionId === sourceVersionId && old.fileObject.sha256 === file.sha256)
        return old;
      if (old) cloneConflict('该资产版本已被原位替换，请使用新的资产版本');
      await this.releaseUnusedPreparedFiles(tx, projectId, runId);
      if ((await tx.fissionCloneMappingFile.count({ where: scope(projectId, runId) })) >= 80)
        cloneConflict('映射引用已达 80 份上限，请先处理现有任务与待采用建议');
      const object = await this.working.upsertFileObjectInTransaction(tx, projectId, runId, file);
      return tx.fissionCloneMappingFile.create({
        data: {
          ...scope(projectId, runId),
          assetId,
          version,
          sourceVersionId,
          fileObjectId: object.id,
          media: json(media),
        },
        include: { fileObject: true },
      });
    });
  }
}
