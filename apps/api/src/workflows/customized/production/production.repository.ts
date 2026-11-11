import { createAssetBranch } from './production-asset-branch';
import { updatePreview } from './update-preview';
import { assetUpdateScope, validateAssetUpdateScope } from './asset-update-scope';
import { assetImageReviewItems, planAssetImageRefresh } from './asset-image-refresh';
import { retainedAssetImageFingerprints, saveAssetImageRetentions } from './asset-image-retention';
import {
  assetBlockers,
  clarificationChanges,
  clarificationReview,
  type ClarificationOutput,
} from './asset-clarification';
import { sharedCustomizedBrief } from '../../../platform/workflow/customized-shared-brief';
import { rebindUnchanged, reconcileUnchangedMedia } from './unchanged-media';
import type {
  CustomizedAssetImageRetentionRequest,
  CustomizedUpdateNode,
  CustomizedUpdateRequest,
} from '@ai-marketing/contracts';
import { applyImageOnlyPlanRebase } from './image-only-plan-rebase';
import { resolveLocalMediaBatch } from './local-media-batch';
import { beginPromptMechanicalRecovery } from './prompt-mechanical-recovery';
import {
  hasLocalShotReview,
  reusableLocalShotReview,
  sameLocalShotReviewScope,
} from './local-shot-review-recovery';
import {
  assertWorkerOperation,
  productionQueue,
  type ProductionWorkerNode,
} from './production-worker-policy';
import { randomUUID } from 'node:crypto';
import { assetExecutionDetail, assetReviewText } from './asset-execution-detail';
import { CustomizedExtractionRepository } from '../information-extraction/customized-extraction.repository';
import { videoExecutionDetail } from './video-execution-detail';
import { freezeVideoRender, renderSettingsNode, videoFileIssues } from './video-render.domain';
import {
  candidateDocument,
  candidateForPreview,
  clipPayload,
  mergeVideoSection,
  normalizeVideoPolicy,
  validateFinalVideo,
  validateFinalClipPrompt,
  validateVideoSnapshot,
  videoHash,
} from './video-production.domain';
import {
  recordAssetEdits,
  mergePreparedAssets,
  validatePreparedAssets,
  assetImageBasis,
  markLegacyImagesForReview,
} from './asset-preparation.domain';
import { Inject, Injectable } from '@nestjs/common';
import {
  isCustomizedStoryboardScript,
  ASSET_CLARIFICATION_MAX_LENGTH,
  isAssetClarificationProposal,
  isCustomizedBrief,
  type AssetClarificationDecision,
  type AssetClarificationRequest,
  type AssetUpdatePlan,
  type CustomizedBrief,
  type CustomizedBriefCandidate,
  isVideoDocument,
  productionShots,
  withProductionAssets,
  isProductionClipPrompt,
  validateClipPromptReferences,
  isVideoDurationPolicy,
  buildVideoSourceUnits,
  CUSTOMIZED_VIDEO_STRATEGY,
  CUSTOMIZED_VIDEO_LIMITS,
  videoReadableText,
  videoClipAssetIds,
  type ProductionClipPrompt,
  type ProductionPromptValue,
  type ProductionVideoDocument,
  type VideoDurationPolicy,
  type ProductionShot,
  type VideoAudit,
  type VideoCandidate,
  isProductionDocument,
  isProductionPrompt,
  isCustomizedImageSettings,
  customizedAssetImageSelectionIssue,
  resolveCustomizedAssetImageSource,
  isCustomizedVideoRenderSettings,
  type CustomizedVideoRenderSettings,
  type CustomizedVideoResult,
  type CustomizedVideoFileInfo,
  normalizeCustomizedImportDraft,
  CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES,
  CUSTOMIZED_DEFAULT_IMAGE_SETTINGS,
  type CustomizedImageSettings,
  productionStages,
  type ProductionDocument,
  type ProductionOperation,
  type ProductionLocalMediaRetryRequest,
  type ProductionWorkspace,
  type ProductionTask,
  type ProductionStep,
  type ProductionInput,
} from '@ai-marketing/contracts';
import type {
  Prisma,
  CustomizedProductionTask,
  WorkingArtifact,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AssetRepository } from '../../../platform/asset/asset.repository';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import {
  customizedScope,
  lockCustomizedProject,
  customizedConflict,
  customizedPathScriptId,
  activateCustomizedBranch,
  beginCustomizedEdit,
} from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ApiHttpException } from '../../../common/api-http-exception';

const json = (v: unknown) => v as Prisma.InputJsonValue;
const invalid = (m: string): never => {
  throw new ApiHttpException(m, 400, 'VALIDATION_ERROR');
};
const missing = (): never => {
  throw new ApiHttpException('制作记录不存在', 404, 'ASSET_NOT_FOUND');
};
type Tx = Prisma.TransactionClient;
type Snapshot = ProductionInput;
const snapshot = (t: CustomizedProductionTask) => t.inputSnapshot as unknown as Snapshot;
const unconfirmedVideoCreation = (task: CustomizedProductionTask) => {
  const output = task.output as { createStarted?: boolean; providerTaskId?: string } | null;
  return task.operation === 'RENDER' && !!output?.createStarted && !output.providerTaskId;
};
const rejectedVideoInput = (task: CustomizedProductionTask) => {
  const output = task.output as {
    createStarted?: boolean;
    createRejected?: boolean;
    createRejectedHttpStatus?: number;
    providerTaskId?: string;
  } | null;
  if (
    task.operation !== 'RENDER' ||
    !output?.createRejected ||
    output.createStarted ||
    output.providerTaskId
  )
    return false;
  const status = output.createRejectedHttpStatus;
  // The previous Worker recorded its HTTP status in this exact suffix.
  return (
    status === 400 ||
    status === 422 ||
    (status === undefined && /（HTTP (?:400|422)）。$/u.test(task.errorMessage ?? ''))
  );
};
const unconfirmedVideoMessage = '视频创建结果尚未确认，为避免重复计费已停止自动重试，已有视频保留';
const rejectedVideoMessage = '视频服务未受理请求，请检查模型权限与配置，已有视频保留';
const incompleteProductionMessage = '本次制作未完成，已保存的内容仍然保留';
const legacyVideoFailureDetails = new Map([
  [
    unconfirmedVideoMessage,
    '提交视频后未取得任务编号，视频平台是否接单待确认。此任务未保存具体错误码，请先核对视频平台的任务记录。',
  ],
  [
    rejectedVideoMessage,
    '视频服务明确拒绝了本次请求。此任务未保存具体错误码，请核对模型权限和生成参数。',
  ],
  [incompleteProductionMessage, '此步骤未能完成，原任务未保存具体错误信息。'],
]);
const assetEvidenceFailureMessage = (output: Record<string, unknown> | null) => {
  if (output?.assetUpdateEvidenceFailure === 'PROTECTED')
    return '请在资产编辑中核对受保护的资料引用，再发起局部更新。';
  if (output?.assetUpdateEvidenceFailure === 'INVALID')
    return '资料引用仍未通过核对，请重新发起局部更新。已保存的资产仍然保留。';
};
const localShotUpdateFailureMessage = (task: CustomizedProductionTask) => {
  if (task.operation !== 'SHOTS' || !snapshot(task).incremental) return;
  const reason = (task.output as { failureReason?: unknown } | null)?.failureReason;
  if (reason === 'INVALID_CANDIDATE')
    return '候选分镜的引用、时长或修改范围未通过核对。请重新查看更新范围，原分镜仍可使用。';
  if (reason === 'REVIEW_UNRESOLVED')
    return '分镜审校仍有待核对的内容。请查看原因后重新发起局部更新，原分镜仍可使用。';
};
export const presentProductionTask = (t: CustomizedProductionTask): ProductionTask => {
  const steps = t.steps as unknown as ProductionStep[];
  const saved = t.output as Record<string, unknown> | null;
  const updateScope = assetUpdateScope(snapshot(t), t.output);
  const review = clarificationReview(
    snapshot(t),
    saved as ClarificationOutput | null,
    t.status === 'COMPLETED',
  );
  const blockers = t.status === 'FAILED' ? assetBlockers(snapshot(t), saved) : [];
  const evidenceFailure = t.status === 'FAILED' ? assetEvidenceFailureMessage(saved) : undefined;
  const input = snapshot(t);
  const renderCreateUnconfirmed = t.status === 'FAILED' && unconfirmedVideoCreation(t);
  const renderInputRejected = t.status === 'FAILED' && rejectedVideoInput(t);
  const failedRenderStep =
    t.operation === 'RENDER' && t.status === 'FAILED'
      ? steps.findLast((step) => step.status === 'RUNNING' || step.status === 'FAILED')
      : undefined;
  const renderError = failedRenderStep
    ? t.errorMessage ||
      (renderCreateUnconfirmed ? unconfirmedVideoMessage : incompleteProductionMessage)
    : undefined;
  const localStoryboard = t.operation === 'SHOTS' && !!input.incremental;
  const reviewAvailable =
    localStoryboard && t.status === 'FAILED' && !!reusableLocalShotReview(input, input, saved);
  const shotUpdateFailure =
    t.status === 'FAILED'
      ? reviewAvailable
        ? '分镜候选和审校结果已保存。可继续核对这份结果，原分镜仍可使用。'
        : localShotUpdateFailureMessage(t)
      : undefined;
  return {
    id: t.id,
    operation: t.operation as ProductionOperation,
    shotId: t.shotId,
    status: t.status as ProductionTask['status'],
    errorMessage: evidenceFailure ?? shotUpdateFailure ?? t.errorMessage,
    ...(renderCreateUnconfirmed ? { renderCreateUnconfirmed: true as const } : {}),
    ...(renderInputRejected ? { renderInputRejected: true as const } : {}),
    ...(t.operation === 'RENDER' &&
    t.status === 'FAILED' &&
    Array.isArray(input.videoRender?.references)
      ? {
          renderReferences: input.videoRender.references.map((ref) => ({
            objectId: ref.objectId,
            name: ref.name,
            assetId: ref.assetId,
            version: ref.version,
            ...(ref.sourceObjectId
              ? { sourceObjectId: ref.sourceObjectId, sourceName: ref.sourceName }
              : {}),
          })),
        }
      : {}),
    ...(t.status === 'FAILED' &&
    input.incremental?.batchKey &&
    ['PROMPT', 'RENDER'].includes(t.operation) &&
    !renderCreateUnconfirmed &&
    !renderInputRejected
      ? { localMediaRetryVersion: t.updatedAt.toISOString() }
      : {}),
    ...(localStoryboard
      ? {
          localStoryboard: {
            startedAt: t.createdAt.toISOString(),
            attempt: t.attemptCount,
            ...(reviewAvailable ? { reviewAvailable: true as const } : {}),
          },
        }
      : {}),
    ...(evidenceFailure ? { assetEvidenceNeedsRestart: true } : {}),
    ...(updateScope ? { assetUpdateScope: updateScope } : {}),
    ...(review ? { assetClarification: review } : {}),
    ...(snapshot(t).assetImageRefresh ? { assetImageRefresh: snapshot(t).assetImageRefresh } : {}),
    ...(blockers.length
      ? { assetReviewQuestions: [...new Set(blockers.map(assetReviewText))] }
      : {}),
    ...(snapshot(t).incremental
      ? {
          incremental: {
            version: 1 as const,
            targetIds: snapshot(t).incremental!.targetIds,
            ...(snapshot(t).incremental!.batchKey
              ? { batchKey: snapshot(t).incremental!.batchKey! }
              : {}),
          },
        }
      : {}),
    ...(typeof saved?.publishedWorkflowRunId === 'string'
      ? { publishedWorkflowRunId: saved.publishedWorkflowRunId }
      : {}),
    ...(t.status === 'FAILED' && t.operation === 'ASSETS' && Array.isArray(saved?.revised)
      ? {
          reviewDraftState: saved.manualDraftAdoptedRevision
            ? ('ADOPTED' as const)
            : ('AVAILABLE' as const),
        }
      : {}),
    ...(snapshot(t).imageSettings ? { imageSettings: snapshot(t).imageSettings } : {}),
    ...(t.operation === 'IMAGE'
      ? {
          completedImageAssetIds: (snapshot(t).imageSettings?.assetIds ?? []).filter(
            (id) =>
              Object.hasOwn(saved ?? {}, id) &&
              typeof (saved![id] as { assetId?: unknown } | null)?.assetId === 'string' &&
              !!(saved![id] as { assetId: string }).assetId.trim() &&
              Number.isInteger((saved![id] as { version?: unknown } | null)?.version) &&
              Number((saved![id] as { version?: unknown }).version) > 0,
          ),
        }
      : {}),
    ...(snapshot(t).videoRender
      ? {
          renderSettings: snapshot(t).videoRender!.settings,
          target: { kind: 'CLIP' as const, id: snapshot(t).videoRender!.clipId },
        }
      : {}),
    ...(snapshot(t).shotWorkflowVersion
      ? {
          shotWorkflowVersion: snapshot(t).shotWorkflowVersion,
          ...(snapshot(t).promptWorkflowVersion
            ? { promptWorkflowVersion: snapshot(t).promptWorkflowVersion }
            : {}),
          hasCandidate: !!candidateForPreview(saved),
          target: snapshot(t).target,
          ...(saved?.failureReason
            ? { failureReason: saved.failureReason as NonNullable<ProductionTask['failureReason']> }
            : {}),
          ...(t.status === 'FAILED' && t.operation === 'SHOTS' && candidateDocument(saved)
            ? {
                reviewDraftState: saved?.manualDraftAdoptedRevision
                  ? ('ADOPTED' as const)
                  : ('AVAILABLE' as const),
              }
            : {}),
        }
      : {}),
    steps: steps.map((storedStep) => {
      const step =
        renderError && storedStep === failedRenderStep
          ? {
              ...storedStep,
              status: 'FAILED',
              content: legacyVideoFailureDetails.get(renderError) ?? renderError,
            }
          : storedStep;
      const detail =
        videoExecutionDetail(step, snapshot(t), t.output) ??
        assetExecutionDetail(step, snapshot(t), t.output);
      return detail ? { ...step, detail } : step;
    }),
    ...(snapshot(t).assetWorkflowVersion
      ? {
          assetWorkflowVersion: snapshot(t).assetWorkflowVersion,
          targetAssetId: snapshot(t).targetAssetId,
        }
      : {}),
    progress:
      t.status === 'COMPLETED'
        ? 100
        : snapshot(t).shotWorkflowVersion === 2
          ? Math.min(
              99,
              Math.round(
                steps.reduce(
                  (n, s) =>
                    n +
                    (s.status === 'SUCCEEDED'
                      ? ((
                          {
                            SNAPSHOT: 5,
                            PLAN: 20,
                            GENERATE: 40,
                            REVIEW: 20,
                            REPAIR: 10,
                            SAVE: 5,
                          } as Record<string, number>
                        )[s.id] ?? 0)
                      : s.id === 'GENERATE' &&
                          Array.isArray(saved?.completedBatches) &&
                          typeof saved?.batchCount === 'number'
                        ? (40 * saved.completedBatches.length) / Math.max(1, saved.batchCount)
                        : 0),
                  0,
                ),
              ),
            )
          : t.operation === 'IMAGE'
            ? Math.min(
                99,
                Math.round(
                  steps.filter((s) => s.id === 'SNAPSHOT' && s.status === 'SUCCEEDED').length * 10 +
                    (Object.keys((t.output ?? {}) as object).length /
                      Math.max(1, snapshot(t).imageSettings?.assetIds.length ?? 1)) *
                      85,
                ),
              )
            : Math.min(
                99,
                Math.round(
                  (steps.filter((s) => s.status === 'SUCCEEDED').length * 100) /
                    Math.max(1, steps.length),
                ),
              ),
  };
};
@Injectable()
export class ProductionRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}
  private async scope(tx: Tx, p: string, r: string) {
    const run = await tx.workflowRun.findFirst({
      where: { ...customizedScope(p), id: r, status: { in: ['ACTIVE', 'PAUSED'] } },
    });
    if (!run) return missing();
    if (
      run.editSessionNodeId ||
      (await tx.project.count({ where: { id: p, deletionState: { not: null } } }))
    )
      return customizedConflict('项目正在编辑或删除');
    const scriptId = customizedPathScriptId(
      run,
      run.forkScriptId
        ? []
        : await tx.workingArtifact.findMany({
            where: {
              projectId: p,
              workflowRunId: r,
              artifactKey: { startsWith: 'customized-script:' },
              availability: 'AVAILABLE',
            },
            select: { artifactKey: true },
          }),
    );
    if (!scriptId) return missing();
    return { ...run, forkScriptId: scriptId };
  }
  private async artifacts(tx: Tx, p: string, r: string) {
    const rows = await tx.workingArtifact.findMany({
      where: { projectId: p, workflowRunId: r, availability: 'AVAILABLE' },
    });
    const local = rows.find((a) => a.artifactKey === 'customized-brief');
    const shared = await sharedCustomizedBrief(tx, p, r, local ?? null);
    if (shared && shared.id !== local?.id)
      return [...rows.filter((a) => a.artifactKey !== 'customized-brief'), shared];
    return rows;
  }
  private async state(tx: Tx, p: string, r: string) {
    return tx.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId: p,
          workflowRunId: r,
          nodeId: 'CUSTOMIZED_PRODUCTION_DRAFT',
        },
      },
    });
  }
  private async read(tx: Tx, p: string, r: string): Promise<ProductionWorkspace> {
    const run = await this.scope(tx, p, r),
      artifacts = await this.artifacts(tx, p, r);
    const script = artifacts.find((a) => a.artifactKey === `customized-script:${run.forkScriptId}`);
    if (!script || !isCustomizedStoryboardScript(script.payload))
      return customizedConflict('请先选择已保存的完整脚本');
    const state = await this.state(tx, p, r),
      catalog = artifacts.find((a) => a.artifactKey === 'customized-asset-catalog'),
      plan = artifacts.find((a) => a.artifactKey === 'customized-video-plan');
    const data = state?.state as unknown as
      { sourceRevision: number; document: ProductionDocument } | undefined;
    const legacyAssets = (script.payload.assets ?? []).map((a) => ({
      id: a.id,
      kind: ({ products: 'PRODUCT', characters: 'CHARACTER', scenes: 'SCENE' } as const)[a.kind],
      name: a.name,
      description: a.description,
      knownFacts: '',
      designNotes: '',
      sourceText: '脚本资产定义，使用前请核对',
      // Script inputs are source material, not edits made in asset preparation.
      manualFields: [],
    }));
    const legacyShots = script.payload.shots.map((s) => ({
      id: s.id,
      title: s.title,
      shotType: s.shotType,
      cameraMovement: s.cameraMovement,
      durationSeconds: s.durationSeconds,
      visual: s.visual,
      dialogue: s.dialogues.map((d) => `${d.speaker}：${d.text}`).join('\n'),
      audio: s.audio,
      atmosphere: s.continuity,
      bindings: Object.values(s.assetRequirements ?? {}).flatMap((g) => g.items),
    }));
    const confirmedDocument: ProductionDocument =
      isProductionDocument({
        ...(plan?.payload as object),
        assets:
          (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
          legacyAssets,
      }) && (plan?.payload as Record<string, unknown>)?.schemaVersion === 2
        ? {
            ...(plan!.payload as unknown as ProductionVideoDocument),
            assets:
              (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
              legacyAssets,
          }
        : {
            assets:
              (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
              legacyAssets,
            shots: (plan?.payload as unknown as { shots: ProductionShot[] })?.shots ?? legacyShots,
          };
    const document =
      data?.sourceRevision === script.revision && isProductionDocument(data.document)
        ? data.document
        : confirmedDocument;
    const imageReviews = assetImageReviewItems(document.assets);
    const retainedImages = imageReviews.length
      ? await retainedAssetImageFingerprints(tx, p, r)
      : undefined;
    const creationTaskId = run.branchCreationKey?.startsWith('assets:')
      ? run.branchCreationKey.slice('assets:'.length)
      : null;
    const taskScope = {
      projectId: p,
      OR: [
        { workflowRunId: r },
        ...(creationTaskId ? [{ id: creationTaskId, operation: 'ASSETS' }] : []),
      ],
    };
    const tasks = await tx.customizedProductionTask.findMany({
      where: taskScope,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
    });
    const activeTasks = await tx.customizedProductionTask.findMany({
      where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    for (const task of activeTasks) if (!tasks.some((t) => t.id === task.id)) tasks.push(task);
    // Image iteration must not hide the extraction behind the sole workflow entry.
    if (!tasks.some((t) => t.operation === 'ASSETS')) {
      const head = await tx.customizedProductionTask.findFirst({
        where: { ...taskScope, operation: 'ASSETS' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (head) tasks.push(head);
    }
    const isAssetImageRefresh = (task: CustomizedProductionTask) =>
      task.operation === 'IMAGE' && !!snapshot(task).assetImageRefresh;
    if (!tasks.some(isAssetImageRefresh)) {
      const head = await tx.customizedProductionTask.findFirst({
        where: {
          projectId: p,
          workflowRunId: r,
          operation: 'IMAGE',
          inputSnapshot: { path: ['assetImageRefresh', 'version'], equals: 1 },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (head) tasks.push(head);
    }
    const newestFirst = (a: CustomizedProductionTask, b: CustomizedProductionTask) =>
      b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
    tasks.sort(newestFirst);
    const assetHead = tasks.find(
      (task) => task.operation === 'ASSETS' || isAssetImageRefresh(task),
    );
    const videoHead = await tx.customizedProductionTask.findFirst({
      where: {
        projectId: p,
        workflowRunId: r,
        operation: { in: ['SHOTS', 'PROMPT', 'RENDER'] },
        inputSnapshot: { path: ['incremental', 'batchKey'], string_starts_with: '' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    let localMediaBatch: ProductionWorkspace['localMediaBatch'];
    for (const head of [assetHead, videoHead]) {
      const batchKey = head && snapshot(head).incremental?.batchKey;
      if (!batchKey) continue;
      const group = await tx.customizedProductionTask.findMany({
        where: {
          projectId: p,
          workflowRunId: r,
          inputSnapshot: { path: ['incremental', 'batchKey'], equals: batchKey },
        },
      });
      for (const task of group) if (!tasks.some((t) => t.id === task.id)) tasks.push(task);
      if (head === videoHead) {
        const resolved = await resolveLocalMediaBatch(tx, p, r, group, artifacts);
        localMediaBatch = resolved?.batch;
        for (const task of resolved?.tasks ?? [])
          if (!tasks.some((t) => t.id === task.id)) tasks.push(task);
      }
    }
    tasks.sort(newestFirst);
    const brandMaterials = normalizeCustomizedImportDraft(
      artifacts.find((a) => a.artifactKey === 'customized-source-package')?.payload,
    ).materials.filter((m) => m.category === 'VISUAL_REFERENCE');
    const brandVersions = brandMaterials.length
      ? await tx.assetVersion.findMany({
          where: {
            projectId: p,
            OR: brandMaterials.map((m) => ({ assetId: m.assetId, version: m.assetVersion })),
            mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
            status: { not: 'UNAVAILABLE' },
            asset: {
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
              archivedAt: null,
            },
          },
        })
      : [];
    const brief = artifacts.find((a) => a.artifactKey === 'customized-brief');
    const scriptDependencies =
      brief && brief.workflowRunId !== r
        ? await tx.workingArtifactDependency.findMany({
            where: { projectId: p, dependentArtifactId: script.id, sourceKey: 'customized-brief' },
          })
        : null;
    return {
      ...(localMediaBatch ? { localMediaBatch } : {}),
      brandImageReferences: brandVersions
        .filter((v) => v.storageKey && v.sizeBytes <= CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES)
        .map((v) => ({ assetId: v.assetId, version: v.version, name: v.originalFileName })),
      script: script.payload,
      source: { artifactId: script.id, revision: script.revision, fingerprint: script.contentHash },
      sourceReady:
        script.freshness === 'CURRENT' &&
        (!scriptDependencies ||
          scriptDependencies.some((d) => d.sourceHash === brief?.contentHash)),
      imageReviewObjectIds: imageReviews
        .filter(({ asset, fingerprint }) => retainedImages?.get(asset.id) !== fingerprint)
        .map(({ asset }) => asset.id),
      document,
      confirmedDocument,
      draftRevision: state?.revision ?? 0,
      assetsConfirmed: catalog?.freshness === 'CURRENT',
      shotsConfirmed: plan?.freshness === 'CURRENT',
      prompts: artifacts
        .filter(
          (a) =>
            a.artifactKey.startsWith('customized-shot-prompt:') ||
            a.artifactKey.startsWith('customized-clip-prompt:'),
        )
        .map((a) => ({
          value: a.payload as unknown as ProductionPromptValue,
          stale: a.freshness !== 'CURRENT',
          revision: a.revision,
        })),
      videos: artifacts
        .filter((a) => a.artifactKey.startsWith('customized-clip-video:'))
        .map((a) => ({
          value: a.payload as unknown as CustomizedVideoResult,
          revision: a.revision,
          stale: a.freshness !== 'CURRENT',
        })),
      videoSettings: (
        await tx.workflowNodeState.findMany({
          where: {
            projectId: p,
            workflowRunId: r,
            nodeId: { startsWith: 'CUSTOMIZED_VIDEO_RENDER_SETTINGS:' },
          },
        })
      ).flatMap((s) => {
        const value = s.state as { clipId?: string; settings?: unknown };
        return typeof value.clipId === 'string' && isCustomizedVideoRenderSettings(value.settings)
          ? [{ clipId: value.clipId, revision: s.revision, settings: value.settings }]
          : [];
      }),
      tasks: tasks.map(presentProductionTask),
    };
  }
  workspace(p: string, r: string) {
    return this.db.$transaction((tx) => this.read(tx, p, r), { timeout: 15000 });
  }
  preview(p: string, r: string, node: CustomizedUpdateNode, targetId: string | null = null) {
    return this.db.$transaction((tx) => updatePreview(tx, p, r, node, targetId), {
      timeout: 15000,
    });
  }
  retainAssetImages(p: string, r: string, request: CustomizedAssetImageRetentionRequest) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const ids = new Set(request.assetIds);
        if (request.version !== 1 || !ids.size || ids.size !== request.assetIds.length)
          invalid('请选择要保留的原图');
        const w = await this.read(tx, p, r);
        if (
          !w.sourceReady ||
          !w.assetsConfirmed ||
          workflowStateHash(w.document.assets) !== workflowStateHash(w.confirmedDocument.assets)
        )
          return customizedConflict('请先保存并确认当前资产，再保留原图');
        const candidates = assetImageReviewItems(w.confirmedDocument.assets);
        const selected = candidates.filter(({ asset }) => ids.has(asset.id));
        if (selected.length !== ids.size)
          return customizedConflict('所选图片已变化，请重新查看局部更新范围');
        const retained = await retainedAssetImageFingerprints(tx, p, r);
        const preview = await updatePreview(tx, p, r, 'ASSETS');
        if (selected.every(({ asset, fingerprint }) => retained.get(asset.id) === fingerprint))
          return preview;
        if (preview.fingerprint !== request.fingerprint)
          return customizedConflict('更新范围已变化，请重新查看局部更新');
        if (preview.blockers.length || preview.calls.includes('TEXT'))
          return customizedConflict(preview.blockers[0] ?? '请先完成资产定义更新');
        const images = selected.map(({ asset }) => asset.image!);
        const available = await tx.assetVersion.findMany({
          where: {
            projectId: p,
            OR: images,
            status: { not: 'UNAVAILABLE' },
            mimeType: { startsWith: 'image/' },
            sizeBytes: { gt: 0 },
            asset: {
              archivedAt: null,
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
            },
          },
          select: { assetId: true, version: true, storageKey: true },
        });
        if (
          images.some(
            (ref) =>
              !available.some(
                (file) =>
                  file.assetId === ref.assetId && file.version === ref.version && file.storageKey,
              ),
          )
        )
          return customizedConflict('部分原图已不可用，请替换图片后再核对');
        const entries: [string, string][] = candidates
          .filter(
            ({ asset, fingerprint }) => ids.has(asset.id) || retained.get(asset.id) === fingerprint,
          )
          .map(({ asset, fingerprint }) => [asset.id, fingerprint]);
        await saveAssetImageRetentions(tx, p, r, entries);
        return updatePreview(tx, p, r, 'ASSETS');
      },
      { timeout: 15000 },
    );
  }
  identicalObjectImage(p: string, r: string, objectId: string, sha256: string) {
    return this.db.$transaction(async (tx) => {
      const w = await this.read(tx, p, r),
        owner = resolveCustomizedAssetImageSource(w.document.assets, objectId);
      if (!owner.ok || owner.source.id !== objectId) invalid('请在当前资产所属主体中替换图片');
      if (!owner.ok || !owner.source.image) return null;
      const version = await tx.assetVersion.findFirst({
        where: {
          projectId: p,
          assetId: owner.source.image.assetId,
          version: owner.source.image.version,
          status: { not: 'UNAVAILABLE' },
          asset: {
            archivedAt: null,
            storageWorkflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
          },
        },
      });
      if (!version?.storageKey) return null;
      const file = await tx.fileObject.findFirst({
        where: { projectId: p, storageKey: version.storageKey, sha256, status: 'AVAILABLE' },
      });
      return file ? owner.source.image : null;
    });
  }
  private latestAssetTask(tx: Tx, p: string, r: string) {
    return tx.customizedProductionTask.findFirst({
      where: { projectId: p, workflowRunId: r, operation: 'ASSETS' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
  private async assertClarificationContext(tx: Tx, task: CustomizedProductionTask) {
    const { projectId: p, workflowRunId: r } = task;
    const run = await this.scope(tx, p, r);
    if (run.activeKey !== 'ACTIVE' || (await this.latestAssetTask(tx, p, r))?.id !== task.id)
      return customizedConflict('当前制作路径或判断记录已变化，请重新加载资产准备');
    if (await this.hasTaskConflict(tx, p, r, { operation: 'ASSETS' }))
      return customizedConflict('已有制作任务执行中，请等待完成');
    const scriptDraft = await tx.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId: p,
          workflowRunId: r,
          nodeId: `CUSTOMIZED_SCRIPT_EDIT:${run.forkScriptId}`,
        },
      },
    });
    if ((scriptDraft?.state as { editing?: boolean } | undefined)?.editing)
      return customizedConflict('请先保存或取消当前脚本编辑');
  }
  private async assertClarificationBaseline(tx: Tx, task: CustomizedProductionTask) {
    const { projectId: p, workflowRunId: r } = task;
    const input = snapshot(task);
    const w = await this.read(tx, p, r);
    const brief = (await this.artifacts(tx, p, r)).find(
      (a) => a.artifactKey === 'customized-brief',
    );
    if (
      !w.sourceReady ||
      !brief ||
      brief.freshness !== 'CURRENT' ||
      !isCustomizedBrief(brief.payload) ||
      !input.sources.some(
        (s) => s.id === brief.id && s.revision === brief.revision && s.hash === brief.contentHash,
      ) ||
      !input.sources.some(
        (s) =>
          s.id === w.source.artifactId &&
          s.revision === w.source.revision &&
          s.hash === w.source.fingerprint,
      ) ||
      input.draftRevision !== w.draftRevision ||
      workflowStateHash(w.document.assets) !== workflowStateHash(input.document.assets) ||
      workflowStateHash(w.document.assets) !== workflowStateHash(w.confirmedDocument.assets)
    )
      return customizedConflict('信息卡、脚本或资产已变化，请基于当前内容重新发起局部更新');
    return { w, brief, fields: brief.payload };
  }
  clarifyAssets(
    p: string,
    id: string,
    request: AssetClarificationRequest,
    models: Snapshot['models'],
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const prior = await this.task(tx, p, id);
      const r = request.workflowRunId;
      if (prior.workflowRunId !== r || prior.operation !== 'ASSETS') return missing();
      const explanation = request.explanation.trim();
      if (!explanation || explanation.length > ASSET_CLARIFICATION_MAX_LENGTH)
        return invalid('请输入有效的补充说明');
      const key = `asset-clarification:${request.idempotencyKey}`;
      await this.scope(tx, p, r);
      const duplicate = await tx.customizedProductionTask.findUnique({
        where: { projectId_idempotencyKey: { projectId: p, idempotencyKey: key } },
      });
      if (duplicate) {
        const context = snapshot(duplicate).assetClarification;
        if (
          duplicate.workflowRunId !== r ||
          context?.priorTaskId !== id ||
          context.explanation !== explanation
        )
          return customizedConflict('请求标识已用于其他操作');
        return presentProductionTask(duplicate);
      }
      await this.assertClarificationContext(tx, prior);
      const base = snapshot(prior);
      const saved = prior.output as ClarificationOutput | null;
      const questions =
        prior.status === 'FAILED'
          ? assetBlockers(base, prior.output)
          : prior.status === 'COMPLETED' &&
              base.assetClarification &&
              saved?.decision?.state !== 'ADOPTED'
            ? [...base.assetClarification.questions, ...(saved?.final?.questions ?? [])]
            : [];
      if (!questions.length) return customizedConflict('此任务没有等待说明的人工核对事项');
      await this.assertClarificationBaseline(tx, prior);
      const task = await tx.customizedProductionTask.create({
        data: {
          projectId: p,
          workflowRunId: r,
          operation: 'ASSETS',
          idempotencyKey: key,
          inputSnapshot: json({
            operation: 'ASSETS',
            shotId: null,
            assetWorkflowVersion: 2,
            script: base.script,
            brief: base.brief,
            document: base.document,
            sources: base.sources,
            draftRevision: base.draftRevision,
            models,
            assetClarification: {
              version: 1,
              priorTaskId: id,
              explanation,
              questions: [...new Set(questions)].slice(0, 100),
            },
            ...(base.assetProductionNote ? { assetProductionNote: base.assetProductionNote } : {}),
          } satisfies Snapshot),
          steps: json([
            { id: 'INVENTORY', status: 'PENDING', title: '重新判断人工核对事项', content: '' },
          ]),
        },
      });
      await this.enqueue(tx, task);
      return presentProductionTask(task);
    });
  }
  decideAssetClarification(p: string, id: string, request: AssetClarificationDecision) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const task = await this.task(tx, p, id);
        const r = request.workflowRunId;
        const input = snapshot(task);
        const saved = task.output as ClarificationOutput | null;
        if (task.workflowRunId !== r || !input.assetClarification) return missing();
        await this.scope(tx, p, r);
        const state = request.adopt ? 'ADOPTED' : 'DISMISSED';
        if (saved?.decision) {
          if (saved.decision.state !== state) return customizedConflict('本次建议已处理');
          return presentProductionTask(task);
        }
        const proposal = saved?.final;
        if (task.status !== 'COMPLETED' || !isAssetClarificationProposal(proposal))
          return customizedConflict('请等待判断完成后再处理');
        await this.assertClarificationContext(tx, task);
        const decision: NonNullable<ClarificationOutput['decision']> = { state };
        if (request.adopt) {
          if (proposal.questions.length)
            return customizedConflict('仍有问题需要核对，请继续补充说明');
          const { w, brief, fields } = await this.assertClarificationBaseline(tx, task);
          const changes = clarificationChanges(fields, proposal);
          const note = proposal.productionNote.trim();
          if (!changes.length && !note) return customizedConflict('没有可以采用的修改');
          if (changes.length) {
            const next = {
              ...fields,
              ...Object.fromEntries(changes.map(({ field, after }) => [field, after])),
            };
            const revised = await this.confirmClarifiedBrief(tx, p, r, brief, next);
            decision.brief = {
              id: revised.id,
              revision: revised.revision,
              hash: revised.contentHash,
            };
          } else {
            const preview = await updatePreview(tx, p, r, 'ASSETS');
            const next = await this.start(
              p,
              r,
              w.draftRevision,
              'ASSETS',
              `asset-clarification:${id}:apply`,
              null,
              input.models,
              null,
              undefined,
              undefined,
              {
                version: 1,
                fingerprint: preview.fingerprint,
                ...(request.refreshAssetImages && preview.calls.includes('IMAGE')
                  ? { refreshAssetImages: true as const }
                  : {}),
              },
              tx,
              { productionNote: note, batchKey: id },
            );
            decision.nextTaskId = next.id;
          }
        }
        return presentProductionTask(
          await tx.customizedProductionTask.update({
            where: { id },
            data: { output: json({ ...saved, decision }) },
          }),
        );
      },
      { timeout: 30000 },
    );
  }
  private async confirmClarifiedBrief(
    tx: Tx,
    p: string,
    r: string,
    brief: WorkingArtifact,
    fields: CustomizedBrief,
  ) {
    if ((await sharedCustomizedBrief(tx, p, r, undefined, true))?.id !== brief.id)
      return customizedConflict(
        '当前查看的是历史信息卡，请切换到使用当前信息卡的方案后再保存商品事实',
      );
    if (
      (await tx.customizedProductionTask.count({
        where: { projectId: p, status: { in: ['QUEUED', 'RUNNING'] } },
      })) ||
      (await tx.customizedStoryboardTask.count({
        where: { projectId: p, status: { in: ['QUEUED', 'RUNNING'] } },
      }))
    )
      return customizedConflict('当前项目还有制作任务运行，请等待完成后再保存信息卡');
    const child = await beginCustomizedEdit(tx, p, r, 'INFORMATION_EXTRACTION');
    const result = await tx.customizedExtractionResult.findUnique({
      where: { projectId_workflowRunId: { projectId: p, workflowRunId: child.id } },
    });
    if (
      child.id === r ||
      !result ||
      workflowStateHash((result.draftResult as unknown as CustomizedBriefCandidate).fields) !==
        workflowStateHash(brief.payload)
    )
      return customizedConflict('信息卡没有可用的确认基线，请先核对当前信息卡');
    const extraction = new CustomizedExtractionRepository(this.db, this.working);
    const edited = await extraction.update(
      p,
      result.id,
      {
        expectedRevision: result.revision,
        fields,
        resolvedIssueIds: [],
      },
      tx,
    );
    const confirmed = await extraction.confirm(p, result.id, edited.revision, tx);
    if (confirmed.unchanged) return brief;
    await activateCustomizedBranch(tx, p, r, 'SHOT_PROMPT', 'CURRENT');
    return tx.workingArtifact.findFirstOrThrow({
      where: {
        projectId: p,
        workflowRunId: confirmed.workflowRunId,
        artifactKey: 'customized-brief',
      },
    });
  }
  startUpdates(
    p: string,
    r: string,
    node: 'ASSETS' | 'SHOTS' | 'PROMPT' | 'RENDER',
    request: CustomizedUpdateRequest,
    key: string,
    models: Snapshot['models'],
    renderModels: Record<string, string>,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        if (
          request.refreshAssetImages !== undefined &&
          (request.refreshAssetImages !== true || node !== 'ASSETS')
        )
          invalid('图片更新请求不正确');
        const selectedImages = request.imageAssetIds;
        if (
          selectedImages !== undefined &&
          (!request.refreshAssetImages ||
            !Array.isArray(selectedImages) ||
            !selectedImages.length ||
            selectedImages.length > 1000 ||
            selectedImages.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) ||
            new Set(selectedImages).size !== selectedImages.length)
        )
          invalid('请选择当前预览中的参考图');
        const existing = await tx.customizedProductionTask.findMany({
          where: { projectId: p, workflowRunId: r, idempotencyKey: { startsWith: key + ':' } },
        });
        if (existing.length) {
          if (
            existing.some(
              (t) =>
                (t.operation !== node &&
                  !(
                    node === 'ASSETS' &&
                    t.operation === 'IMAGE' &&
                    snapshot(t).assetImageRefresh
                  )) ||
                !!snapshot(t).assetImageRefresh !== (request.refreshAssetImages === true) ||
                (selectedImages !== undefined &&
                  (t.operation !== 'IMAGE' ||
                    workflowStateHash([...selectedImages].sort()) !==
                      workflowStateHash(
                        [...(snapshot(t).imageSettings?.assetIds ?? [])].sort(),
                      ))) ||
                snapshot(t).incremental?.requestFingerprint !== request.fingerprint,
            )
          )
            return customizedConflict('请求标识已用于其他操作');
          return existing.map(presentProductionTask);
        }
        const preview = await updatePreview(tx, p, r, node);
        if (request.version !== 1 || preview.fingerprint !== request.fingerprint)
          return customizedConflict('更新范围已变化，请重新查看局部更新');
        if (preview.blockers.length || !preview.items.length)
          return customizedConflict(preview.blockers.join('；') || '当前内容无需更新');
        const initial = await this.read(tx, p, r);
        if (node === 'ASSETS' && !preview.calls.includes('TEXT')) {
          if (!request.refreshAssetImages)
            return customizedConflict('请重新查看局部更新范围，确认更新参考图片');
          const offered = preview.items.map((item) => item.id);
          if (selectedImages?.some((id) => !offered.includes(id)))
            return customizedConflict('所选图片已变化，请重新查看局部更新范围');
          if (
            !initial.sourceReady ||
            !initial.assetsConfirmed ||
            workflowStateHash(initial.document.assets) !==
              workflowStateHash(initial.confirmedDocument.assets)
          )
            return customizedConflict('请先保存当前脚本及资产定义');
          const rows = await this.artifacts(tx, p, r);
          const story = rows.find((row) => row.id === initial.source.artifactId);
          const brief = rows.find((row) => row.artifactKey === 'customized-brief');
          const catalog = rows.find((row) => row.artifactKey === 'customized-asset-catalog');
          if (!story || !brief || !catalog || brief.freshness !== 'CURRENT')
            return customizedConflict('请先确认当前脚本、信息卡及资产目录');
          const task = await this.queueAssetImages(tx, p, r, {
            key: `${key}:asset-images`,
            document: initial.document,
            draftRevision: initial.draftRevision,
            script: initial.script,
            models,
            source: [story, catalog, brief],
            incremental: {
              version: 1,
              batchKey: key,
              fingerprint: preview.fingerprint,
              requestFingerprint: request.fingerprint,
              targetIds: selectedImages ?? offered,
            },
          });
          return [task];
        }
        if (selectedImages !== undefined) invalid('请先完成资产定义更新，再选择需要重做的参考图');
        const targets = ['ASSETS', 'SHOTS'].includes(node)
          ? [null]
          : preview.items.map((i) => i.id);
        const tasks: ProductionTask[] = [];
        for (const target of targets) {
          const current = await this.read(tx, p, r);
          const scoped = await updatePreview(tx, p, r, node, target);
          const settings =
            node === 'RENDER'
              ? initial.videoSettings?.find((v) => v.clipId === target)?.settings
              : undefined;
          if (node === 'RENDER' && (!settings || !renderModels[settings.capabilityKey]))
            return invalid('请先为待更新分镜保存视频模型、画幅和分辨率');
          const task = await this.start(
            p,
            r,
            current.draftRevision,
            node,
            `${key}:${workflowStateHash(target ?? node)}`,
            null,
            models,
            null,
            undefined,
            {
              version: 2,
              ...(target ? { target: { kind: 'CLIP' as const, id: target } } : {}),
              ...(settings
                ? { render: { settings, model: renderModels[settings.capabilityKey]! } }
                : {}),
            },
            {
              version: 1,
              fingerprint: scoped.fingerprint,
              ...(request.refreshAssetImages ? { refreshAssetImages: true as const } : {}),
            },
            tx,
          );
          const stored = await tx.customizedProductionTask.findUniqueOrThrow({
            where: { id: task.id },
          });
          const input = snapshot(stored);
          input.incremental = {
            ...input.incremental!,
            batchKey: key,
            requestFingerprint: request.fingerprint,
          };
          await tx.customizedProductionTask.update({
            where: { id: task.id },
            data: { inputSnapshot: json(input) },
          });
          tasks.push({ ...task, incremental: { ...task.incremental!, batchKey: key } });
        }
        return tasks;
      },
      { timeout: 30000 },
    );
  }
  saveVideoSettings(
    p: string,
    r: string,
    clipId: string,
    revision: number,
    settings: CustomizedVideoRenderSettings,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const w = await this.read(tx, p, r);
      if (
        !isCustomizedVideoRenderSettings(settings) ||
        !isVideoDocument(w.document) ||
        !w.document.videoPlan.clips.some((c) => c.id === clipId)
      )
        invalid('渲染设置或当前分镜无效');
      const nodeId = renderSettingsNode(clipId);
      const old = await tx.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId } },
      });
      if ((old?.revision ?? 0) !== revision)
        return customizedConflict('渲染设置已变化，请重新加载');
      const hash = workflowStateHash(settings);
      if (old?.contentHash === hash) return { clipId, revision: old.revision, settings };
      const state = await tx.workflowNodeState.upsert({
        where: { projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId } },
        create: {
          projectId: p,
          workflowRunId: r,
          nodeId,
          state: json({ clipId, settings }),
          contentHash: hash,
          revision: 1,
        },
        update: {
          state: json({ clipId, settings }),
          contentHash: hash,
          revision: { increment: 1 },
        },
      });
      return { clipId, revision: state.revision, settings };
    });
  }
  latestPromptTask(p: string, r: string, clipId: string): Promise<ProductionTask | null> {
    return this.db.$transaction(async (tx) => {
      await this.scope(tx, p, r);
      const artifacts = await this.artifacts(tx, p, r);
      const document = artifacts.find((a) => a.artifactKey === 'customized-video-plan')?.payload;
      if (
        !isProductionDocument(document) ||
        !isVideoDocument(document) ||
        !document.videoPlan.clips.some((c) => c.id === clipId)
      )
        return null;
      const task = await tx.customizedProductionTask.findFirst({
        where: {
          projectId: p,
          workflowRunId: r,
          operation: 'PROMPT',
          inputSnapshot: { path: ['target', 'id'], equals: clipId },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return task ? presentProductionTask(task) : null;
    });
  }
  private async writeDraft(
    tx: Tx,
    p: string,
    r: string,
    document: ProductionDocument,
    sourceRevision: number,
    expected: number,
  ) {
    const old = await this.state(tx, p, r);
    if ((old?.revision ?? 0) !== expected)
      return customizedConflict('内容已经更新，本地修改已保留，请重新加载后核对');
    const contentHash = workflowStateHash({ document, sourceRevision });
    if (old?.contentHash === contentHash) return old;
    return tx.workflowNodeState.upsert({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId: p,
          workflowRunId: r,
          nodeId: 'CUSTOMIZED_PRODUCTION_DRAFT',
        },
      },
      create: {
        projectId: p,
        workflowRunId: r,
        nodeId: 'CUSTOMIZED_PRODUCTION_DRAFT',
        state: json({ document, sourceRevision }),
        contentHash,
        revision: 1,
      },
      update: {
        state: json({ document, sourceRevision }),
        contentHash,
        revision: { increment: 1 },
      },
    });
  }
  private dependency(a: WorkingArtifact) {
    return {
      sourceType: 'WORKING_ARTIFACT' as const,
      sourceArtifactId: a.id,
      sourceNodeId: a.nodeId,
      sourceKey: a.artifactKey,
      sourceRevision: a.revision,
      sourceHash: a.contentHash,
    };
  }
  private async commit(
    tx: Tx,
    p: string,
    r: string,
    node: string,
    key: string,
    name: string,
    payload: unknown,
    sources: WorkingArtifact[],
  ) {
    const previous = await tx.workingArtifact.findFirst({
      where: { projectId: p, workflowRunId: r, artifactKey: key },
    });
    if (
      previous &&
      previous.name === name.slice(0, 120) &&
      previous.kind === 'STRUCTURED' &&
      workflowStateHash(previous.payload) === workflowStateHash(payload)
    ) {
      const record = await rebindUnchanged(tx, p, r, previous.id, sources);
      return [{ record, unchanged: true }];
    }
    return this.working.commitValidatedArtifactsInTransaction(tx, p, r, node, [
      {
        artifactKey: key,
        input: {
          kind: 'STRUCTURED',
          name: name.slice(0, 120),
          directory: 'SCRIPTS',
          type: 'STORYBOARD_SCRIPT',
          payload,
          dependencies: sources.map((a) => this.dependency(a)),
        },
      },
    ]);
  }
  private async commitAssets(
    tx: Tx,
    p: string,
    r: string,
    value: ProductionDocument,
    frozen?: WorkingArtifact[],
  ) {
    const artifacts = frozen ?? (await this.artifacts(tx, p, r));
    const run = await this.scope(tx, p, r);
    const story = artifacts.find((a) => a.artifactKey === `customized-script:${run.forkScriptId}`)!;
    const brief = artifacts.find((a) => a.artifactKey === 'customized-brief');
    const dependencies = brief ? [story, brief] : [story];
    if (!value.assets.some((a) => a.kind === 'PRODUCT')) invalid('请保留独立的产品资产定义');
    for (const a of value.assets)
      await this.commit(
        tx,
        p,
        r,
        'SHOT_PROMPT',
        `customized-object:${a.id}`,
        a.name,
        a,
        dependencies,
      );
    // Removed objects invalidate only their actual dependent shots/prompts.
    for (const a of artifacts.filter(
      (a) =>
        a.artifactKey.startsWith('customized-object:') &&
        !value.assets.some((v) => `customized-object:${v.id}` === a.artifactKey),
    ))
      await this.commit(tx, p, r, 'SHOT_PROMPT', a.artifactKey, a.name, { removed: true }, [story]);
    const [catalog] = await this.commit(
      tx,
      p,
      r,
      'SHOT_PROMPT',
      'customized-asset-catalog',
      '资产目录',
      { assets: value.assets },
      dependencies,
    );
    return catalog!.record;
  }
  private async confirmAssetDocument(
    tx: Tx,
    p: string,
    r: string,
    value: ProductionDocument,
    sourceRevision: number,
    draftRevision: number,
    before: WorkingArtifact[],
  ) {
    await this.commitAssets(tx, p, r, value, before);
    const rebased = await applyImageOnlyPlanRebase(tx, this.working, p, r, value);
    if (!rebased) return draftRevision;
    const state = await this.writeDraft(tx, p, r, rebased, sourceRevision, draftRevision);
    await reconcileUnchangedMedia(tx, p, r, rebased, before);
    return state.revision;
  }
  private async confirmShotDocument(
    tx: Tx,
    p: string,
    r: string,
    value: ProductionDocument,
    story: WorkingArtifact,
    artifacts: WorkingArtifact[],
  ) {
    const catalog = artifacts.find((a) => a.artifactKey === 'customized-asset-catalog');
    const savedShots = isVideoDocument(value) ? value.videoPlan.shots : value.shots;
    if (
      catalog?.freshness !== 'CURRENT' ||
      !savedShots.length ||
      savedShots.some((s) => !s.visual.trim())
    )
      return invalid('请确认资产目录并补齐分镜画面');
    if (workflowStateHash(catalog.payload) !== workflowStateHash({ assets: value.assets }))
      return customizedConflict('资产目录有未确认修改，请先保存资产准备');
    const brief = artifacts.find((a) => a.artifactKey === 'customized-brief');
    if (isVideoDocument(value) && (!brief || brief.freshness !== 'CURRENT'))
      return customizedConflict('信息卡已变化，请重新确认制作依据');
    for (const s of savedShots)
      await this.commit(tx, p, r, 'SHOT_RENDER', `customized-shot:${s.id}`, s.title || '镜头', s, [
        story,
        ...(isVideoDocument(value) && brief ? [brief] : []),
        ...s.bindings
          .map((b) => artifacts.find((a) => a.artifactKey === `customized-object:${b.assetId}`)!)
          .filter(Boolean),
      ]);
    for (const a of artifacts.filter(
      (a) =>
        a.artifactKey.startsWith('customized-shot:') &&
        !savedShots.some((s) => `customized-shot:${s.id}` === a.artifactKey),
    ))
      await this.commit(tx, p, r, 'SHOT_RENDER', a.artifactKey, a.name, { removed: true }, [story]);
    if (isVideoDocument(value)) {
      const current = await this.artifacts(tx, p, r);
      for (const clip of value.videoPlan.clips)
        await this.commit(
          tx,
          p,
          r,
          'SHOT_RENDER',
          `customized-video-clip:${clip.id}`,
          clip.title,
          clipPayload(value, clip.id),
          [
            story,
            ...(brief ? [brief] : []),
            ...clip.shotIds
              .map((id) => current.find((a) => a.artifactKey === `customized-shot:${id}`)!)
              .filter(Boolean),
            ...videoClipAssetIds(value.videoPlan, clip)
              .map((id) => current.find((a) => a.artifactKey === `customized-object:${id}`)!)
              .filter(Boolean),
          ],
        );
      for (const a of artifacts.filter(
        (a) =>
          a.artifactKey.startsWith('customized-video-clip:') &&
          !value.videoPlan.clips.some((c) => a.artifactKey === `customized-video-clip:${c.id}`),
      ))
        await this.commit(tx, p, r, 'SHOT_RENDER', a.artifactKey, a.name, { removed: true }, [
          story,
        ]);
    }
    await this.commit(
      tx,
      p,
      r,
      'SHOT_RENDER',
      'customized-video-plan',
      '分镜制作',
      isVideoDocument(value) ? value : { shots: value.shots },
      [story],
    );
    await reconcileUnchangedMedia(tx, p, r, value, artifacts);
  }
  async save(
    p: string,
    r: string,
    revision: number,
    document: ProductionDocument,
    section: 'ASSETS' | 'SHOTS',
    confirm: boolean,
  ) {
    if (!isProductionDocument(document)) invalid('资产或镜头结构不完整，请检查名称、时长和绑定');
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const w = await this.read(tx, p, r);
        if (!w.sourceReady) return customizedConflict('故事已经变化，请先确认当前脚本');
        if (
          await tx.customizedProductionTask.count({
            where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
          })
        )
          return customizedConflict('当前制作任务执行中，请等待或取消后再编辑');
        // Each editor owns its section only, never overwrite the other node's data.
        const value = mergeVideoSection(
          w.document,
          section === 'ASSETS'
            ? withProductionAssets(document, recordAssetEdits(w.document.assets, document.assets))
            : document,
          section,
        );
        if (!isProductionDocument(value)) invalid('镜头引用的资产已发生变化');
        if (section === 'ASSETS')
          value.assets = value.assets.map((a) => {
            const old = w.document.assets.find((v) => v.id === a.id);
            if (!a.image) {
              const { imageBasis: _basis, ...withoutBasis } = a;
              return withoutBasis;
            }
            const adopted =
              workflowStateHash(a.image) !== workflowStateHash(old?.image ?? null) ||
              (!a.imageBasis && !!old?.imageBasis);
            return {
              ...a,
              ...(adopted
                ? { imageBasis: assetImageBasis(a) }
                : old?.imageBasis
                  ? { imageBasis: old.imageBasis }
                  : {}),
            };
          });
        if (section === 'SHOTS' && isVideoDocument(value)) {
          const current = await this.artifacts(tx, p, r);
          if (
            videoHash(value.videoPlan.sourceUnits) !==
            videoHash(buildVideoSourceUnits(w.script.story?.content ?? w.script.synopsis))
          )
            return customizedConflict('分镜来源正文已变化');
          const required = [
            w.source.artifactId,
            ...current
              .filter((a) =>
                ['customized-brief', 'customized-asset-catalog'].includes(a.artifactKey),
              )
              .map((a) => a.id),
          ];
          if (
            required.some((id) => !value.videoPlan.sources.some((s) => s.id === id)) ||
            value.videoPlan.sources.some(
              (s) =>
                !current.some(
                  (a) =>
                    a.id === s.id &&
                    a.revision === s.revision &&
                    a.contentHash === s.hash &&
                    a.freshness === 'CURRENT',
                ),
            )
          )
            return customizedConflict('分镜制作依据已变化，请重新生成');
        }
        // Uploaded visual references must belong to this project and exact version.
        for (const a of value.assets)
          if (a.image) {
            const exists = await tx.assetVersion.findFirst({
              where: {
                projectId: p,
                assetId: a.image.assetId,
                version: a.image.version,
                status: { not: 'UNAVAILABLE' },
                mimeType: { startsWith: 'image/' },
                asset: {
                  projectId: p,
                  storageWorkflow: 'CUSTOMIZED',
                  workflowSpace: 'CUSTOMIZED_PROJECT',
                  archivedAt: null,
                },
              },
            });
            if (!exists?.storageKey || exists.sizeBytes <= 0)
              invalid('图片版本不存在、不可用或不属于当前项目');
            const owner = resolveCustomizedAssetImageSource(value.assets, a.id);
            if (!owner.ok || owner.source.id !== a.id)
              invalid('附属对象请替换所属人物或场景的图片');
          }
        const state = await this.writeDraft(tx, p, r, value, w.source.revision, revision);
        if (confirm) {
          const artifacts = await this.artifacts(tx, p, r),
            story = artifacts.find((a) => a.id === w.source.artifactId)!;
          if (section === 'ASSETS') {
            return {
              revision: await this.confirmAssetDocument(
                tx,
                p,
                r,
                value,
                w.source.revision,
                state.revision,
                artifacts,
              ),
            };
          }
          await this.confirmShotDocument(tx, p, r, value, story, artifacts);
        }
        return { revision: state.revision };
      },
      { timeout: 30000 },
    );
  }
  private enqueue(tx: Tx, t: CustomizedProductionTask, delay = 0) {
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId: t.projectId,
          jobType: 'CUSTOMIZED_PRODUCTION',
          aggregateId: t.id,
        },
      },
      create: {
        projectId: t.projectId,
        jobType: 'CUSTOMIZED_PRODUCTION',
        aggregateId: t.id,
        routingKey: productionQueue(t.operation),
        payload: { schemaVersion: 1, projectId: t.projectId, runId: t.id, requestId: randomUUID() },
        nextAttemptAt: new Date(Date.now() + delay),
      },
      update: {
        routingKey: productionQueue(t.operation),
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + delay),
        publishedAt: null,
      },
    });
  }
  savePrompt(p: string, r: string, revision: number, prompt: ProductionPromptValue) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const w = await this.read(tx, p, r),
          shot = productionShots(w.document).find(
            (s) => 'shotId' in prompt && s.id === prompt.shotId,
          );
        if ('target' in prompt) {
          if (!isVideoDocument(w.document) || !isProductionClipPrompt(prompt, w.document.videoPlan))
            return invalid('提示词与当前片段绑定不匹配');
          const referenceIssue = validateClipPromptReferences(prompt, w.document);
          if (referenceIssue) return invalid(referenceIssue);
          const artifacts = await this.artifacts(tx, p, r),
            source = artifacts.find(
              (a) => a.artifactKey === `customized-video-clip:${prompt.target.id}`,
            ),
            old = artifacts.find(
              (a) => a.artifactKey === `customized-clip-prompt:${prompt.target.id}`,
            );
          if (
            !w.sourceReady ||
            !source ||
            source.freshness !== 'CURRENT' ||
            workflowStateHash(source.payload) !==
              workflowStateHash(clipPayload(w.document, prompt.target.id))
          )
            return customizedConflict('请先保存当前片段及绑定');
          if ((old?.revision ?? 0) !== revision)
            return customizedConflict('提示词已更新，本地文字保留，请重新加载后核对');
          if (await this.hasTaskConflict(tx, p, r, { operation: 'PROMPT', target: prompt.target }))
            return customizedConflict('制作任务执行中，请稍后保存');
          await this.commit(
            tx,
            p,
            r,
            'SHOT_RENDER',
            `customized-clip-prompt:${prompt.target.id}`,
            '片段提示词',
            prompt,
            [source],
          );
          return { accepted: true };
        }
        if (!shot || !isProductionPrompt(prompt, shot)) invalid('提示词与当前镜头绑定不匹配');
        const artifacts = await this.artifacts(tx, p, r),
          source = artifacts.find((a) => a.artifactKey === `customized-shot:${prompt.shotId}`),
          old = artifacts.find((a) => a.artifactKey === `customized-shot-prompt:${prompt.shotId}`);
        if (
          !w.sourceReady ||
          !source ||
          source.freshness !== 'CURRENT' ||
          workflowStateHash(source.payload) !== workflowStateHash(shot)
        )
          return customizedConflict('请先保存当前镜头及绑定');
        if ((old?.revision ?? 0) !== revision)
          return customizedConflict('提示词已更新，本地文字保留，请重新加载后核对');
        if (
          await tx.customizedProductionTask.count({
            where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
          })
        )
          return customizedConflict('制作任务执行中，请等待或取消后再保存');
        await this.commit(
          tx,
          p,
          r,
          'SHOT_RENDER',
          `customized-shot-prompt:${prompt.shotId}`,
          `镜头提示词 · ${shot!.title}`,
          prompt,
          [
            source,
            ...shot!.bindings
              .map((b) =>
                artifacts.find((a) => a.artifactKey === `customized-object:${b.assetId}`)!,
              )
              .filter(Boolean),
          ],
        );
        return { accepted: true };
      },
      { timeout: 15000 },
    );
  }
  start(
    p: string,
    r: string,
    revision: number,
    operation: ProductionOperation,
    key: string,
    shotId: string | null,
    models: Snapshot['models'],
    targetAssetId: string | null = null,
    imageSettings?: CustomizedImageSettings,
    videoSettings?: {
      version?: 2;
      durationPolicy?: VideoDurationPolicy;
      target?: { kind: 'CLIP'; id: string };
      render?: { settings: CustomizedVideoRenderSettings; model: string };
    },
    incremental?: CustomizedUpdateRequest,
    transaction?: Tx,
    assetUpdate?: { productionNote: string; batchKey: string },
  ) {
    if (
      videoSettings?.durationPolicy !== undefined &&
      !isVideoDurationPolicy(videoSettings.durationPolicy)
    )
      invalid('请选择有效的制作时长');
    if (
      videoSettings?.target &&
      (!['PROMPT', 'RENDER'].includes(operation) ||
        videoSettings.target.kind !== 'CLIP' ||
        typeof videoSettings.target.id !== 'string' ||
        !videoSettings.target.id.trim() ||
        videoSettings.target.id.length > 200)
    )
      invalid('制作片段目标不正确');
    if (operation === 'IMAGE' && isCustomizedImageSettings(imageSettings) && imageSettings.inputs)
      imageSettings = {
        ...imageSettings,
        inputs: imageSettings.inputs.map((i) => ({
          ...i,
          references: i.references.map((reference) => ({
            ...reference,
            assetId: reference.assetId.toLowerCase(),
          })),
        })),
      };
    const perform = async (tx: Tx) => {
      await lockCustomizedProject(tx, p);
      let w = await this.read(tx, p, r);
      const refreshImages = operation === 'ASSETS' && incremental?.refreshAssetImages === true;
      if (incremental?.refreshAssetImages !== undefined && !refreshImages)
        invalid('图片更新请求不正确');
      const previous = await tx.customizedProductionTask.findUnique({
        where: { projectId_idempotencyKey: { projectId: p, idempotencyKey: key } },
      });
      if (previous) {
        if (
          previous.workflowRunId !== r ||
          previous.operation !== operation ||
          previous.shotId !== shotId ||
          workflowStateHash(snapshot(previous).target ?? null) !==
            workflowStateHash(videoSettings?.target ?? null) ||
          workflowStateHash(snapshot(previous).videoRender?.settings ?? null) !==
            workflowStateHash(videoSettings?.render?.settings ?? null) ||
          workflowStateHash(snapshot(previous).imageSettings ?? null) !==
            workflowStateHash(imageSettings ?? null) ||
          (snapshot(previous).targetAssetId ?? null) !== targetAssetId ||
          !!snapshot(previous).assetImageRefresh !== refreshImages
        )
          return customizedConflict('请求标识已用于其他操作');
        return presentProductionTask(previous);
      }
      if (revision !== w.draftRevision || !w.sourceReady)
        return customizedConflict('创作依据已变化，请重新加载');
      let updateTargets: string[] = [];
      if (incremental) {
        if (
          incremental.version !== 1 ||
          !['ASSETS', 'SHOTS', 'PROMPT', 'RENDER'].includes(operation)
        )
          invalid('局部更新类型不正确');
        const preview = await updatePreview(
          tx,
          p,
          r,
          operation as CustomizedUpdateNode,
          videoSettings?.target?.id ?? null,
        );
        if (preview.fingerprint !== incremental.fingerprint)
          return customizedConflict('更新范围已变化，请重新查看局部更新');
        if (preview.blockers.length) return customizedConflict(preview.blockers.join('；'));
        if (!preview.items.length) return customizedConflict('当前内容无需更新');
        if (operation === 'ASSETS' && !preview.calls.includes('TEXT'))
          return customizedConflict('请从局部更新入口确认更新参考图片');
        updateTargets = preview.items.map((i) => i.id);
        if (workflowStateHash(w.document.assets) !== workflowStateHash(w.confirmedDocument.assets))
          return customizedConflict('请先保存或取消资产修改');
      }
      const active = await this.hasTaskConflict(tx, p, r, {
        operation,
        target: videoSettings?.target,
      });
      if (active) return customizedConflict('已有制作任务执行中，请等待完成');
      if (operation === 'PROMPT' || operation === 'RENDER') {
        const rebased = await applyImageOnlyPlanRebase(tx, this.working, p, r, w.document);
        if (rebased) {
          const state = await this.writeDraft(tx, p, r, rebased, w.source.revision, revision);
          revision = state.revision;
          w = { ...w, document: rebased, draftRevision: revision };
        }
      }
      const artifacts = await this.artifacts(tx, p, r);
      const source = [artifacts.find((a) => a.id === w.source.artifactId)!];
      let assetProductionNote = assetUpdate?.productionNote;
      if (
        targetAssetId &&
        (operation !== 'ASSETS' || !w.document.assets.some((a) => a.id === targetAssetId))
      )
        invalid('选定资产不存在');
      const brief = artifacts.find((a) => a.artifactKey === 'customized-brief');
      if (operation === 'ASSETS') {
        if (!brief || brief.freshness !== 'CURRENT')
          return customizedConflict('信息卡已变化，请先确认创作依据');
        source.push(brief);
        if (incremental && !assetProductionNote) {
          const previousAssetTask = await this.latestAssetTask(tx, p, r);
          const previousInput = previousAssetTask ? snapshot(previousAssetTask) : null;
          if (previousAssetTask && previousInput?.assetClarification) {
            const saved = previousAssetTask.output as ClarificationOutput | null;
            const adopted = saved?.decision?.brief;
            if (
              saved?.decision?.state === 'ADOPTED' &&
              adopted?.id === brief.id &&
              adopted.revision === brief.revision &&
              adopted.hash === brief.contentHash
            )
              assetProductionNote = saved.final?.productionNote.trim();
          } else if (
            previousAssetTask?.status === 'FAILED' &&
            previousInput?.assetProductionNote &&
            previousInput.draftRevision === revision &&
            workflowStateHash(previousInput.document.assets) ===
              workflowStateHash(w.document.assets) &&
            workflowStateHash(previousInput.sources) ===
              workflowStateHash(
                source.map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash })),
              )
          ) {
            assetProductionNote = previousInput.assetProductionNote;
          }
        }
      }
      if (operation !== 'ASSETS') {
        const catalog = artifacts.find(
          (a) => a.artifactKey === 'customized-asset-catalog' && a.freshness === 'CURRENT',
        );
        if (
          !catalog ||
          workflowStateHash(catalog.payload) !== workflowStateHash({ assets: w.document.assets })
        )
          return customizedConflict('请先保存并确认资产目录');
        source.push(catalog);
      }
      const render =
        operation === 'RENDER'
          ? await freezeVideoRender(
              tx,
              p,
              w,
              artifacts,
              videoSettings?.target?.id ?? '',
              videoSettings?.render?.settings as CustomizedVideoRenderSettings,
              videoSettings?.render?.model ?? '',
            )
          : undefined;
      if (render) source.push(...render.sources);
      if (operation === 'IMAGE') {
        if (
          !isCustomizedImageSettings(imageSettings) ||
          imageSettings.assetIds.some(
            (id) => !w.document.assets.some((a) => a.id === id && a.description.trim()),
          )
        )
          invalid('请选择有效的生图模型、尺寸和已填写公共形象的资产');
        const selectionIssue = customizedAssetImageSelectionIssue(
          w.document.assets,
          imageSettings!.assetIds,
        );
        if (selectionIssue) invalid(selectionIssue);
        if (!brief || brief.freshness !== 'CURRENT')
          return customizedConflict('品牌信息已变化，请先确认创作依据');
        source.push(brief);
        for (const reference of imageSettings!.inputs?.flatMap((i) => i.references) ?? []) {
          const file = await tx.assetVersion.findFirst({
            where: {
              projectId: p,
              assetId: reference.assetId,
              version: reference.version,
              status: { not: 'UNAVAILABLE' },
              mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
              asset: {
                storageWorkflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                archivedAt: null,
              },
            },
          });
          if (
            !file?.storageKey ||
            file.sizeBytes <= 0 ||
            file.sizeBytes > CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES
          )
            invalid('参考图片版本不可用，请移除后重新选择');
        }
      } else if (imageSettings) invalid('此任务不接受图片设置');
      const videoV2 =
        (operation === 'SHOTS' && videoSettings?.version === 2) ||
        (operation === 'PROMPT' && isVideoDocument(w.document));
      if (videoV2) {
        if (!brief || brief.freshness !== 'CURRENT')
          return customizedConflict('请先确认当前信息卡');
        source.push(brief);
      }
      if (operation === 'PROMPT' && videoV2) {
        if (shotId || videoSettings?.target?.kind !== 'CLIP' || !isVideoDocument(w.document))
          invalid('请选择当前视频片段');
        const targetId = videoSettings!.target!.id;
        const a = artifacts.find(
          (a) => a.artifactKey === `customized-video-clip:${targetId}` && a.freshness === 'CURRENT',
        );
        if (
          !a ||
          workflowStateHash(a.payload) !==
            workflowStateHash(clipPayload(w.document as ProductionVideoDocument, targetId))
        )
          return customizedConflict('请先保存当前片段和分镜');
        source.push(a);
      } else if (operation === 'PROMPT') {
        if (videoSettings?.target) invalid('旧版镜头不接受片段目标');
        const shot = productionShots(w.document).find((s) => s.id === shotId),
          a = artifacts.find(
            (a) => a.artifactKey === `customized-shot:${shotId}` && a.freshness === 'CURRENT',
          );
        if (!shot || !a || workflowStateHash(a.payload) !== workflowStateHash(shot))
          return customizedConflict('请先保存当前镜头及资产绑定');
        source.push(a);
      }
      const input: Snapshot = {
        ...(incremental
          ? {
              incremental: {
                version: 1 as const,
                fingerprint: incremental.fingerprint,
                targetIds: updateTargets,
                ...(assetUpdate
                  ? { batchKey: assetUpdate.batchKey }
                  : refreshImages
                    ? { batchKey: key }
                    : {}),
              },
            }
          : {}),
        script: w.script,
        brief: artifacts.find((a) => a.artifactKey === 'customized-brief')?.payload,
        document: w.document,
        sources: source.map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash })),
        draftRevision: revision,
        models,
        operation,
        shotId,
        ...(videoV2
          ? {
              shotWorkflowVersion: 2 as const,
              ...(operation === 'SHOTS'
                ? { shotBenefitPolicyVersion: 1 as const, shotDurationStepMs: 1000 as const }
                : {}),
              ...(operation === 'PROMPT' ? { promptWorkflowVersion: 3 as const } : {}),
              strategyVersion: CUSTOMIZED_VIDEO_STRATEGY,
              requestLimits: { ...CUSTOMIZED_VIDEO_LIMITS },
              identitySeed: randomUUID(),
              durationPolicy:
                (operation === 'PROMPT' || !!incremental) && isVideoDocument(w.document)
                  ? w.document.videoPlan.durationPolicy
                  : normalizeVideoPolicy(
                      videoSettings?.durationPolicy,
                      w.script.creation?.referenceDurationSeconds ?? 30,
                    ),
              sourceUnits: buildVideoSourceUnits(w.script.story?.content ?? w.script.synopsis),
              renderCapability:
                (operation === 'PROMPT' || !!incremental) && isVideoDocument(w.document)
                  ? w.document.videoPlan.capability
                  : {
                      key: 'TEXT_PLAN',
                      status: 'PENDING_MODEL_CHECK' as const,
                      minClipMs: 4000,
                      maxClipMs: 15000,
                      version: 'configured-2026-10-19',
                    },
              ...(videoSettings?.target ? { target: videoSettings.target } : {}),
            }
          : {}),
        ...(imageSettings ? { imageSettings } : {}),
        ...(render
          ? {
              videoRender: render.input,
              target: { kind: 'CLIP' as const, id: render.input.clipId },
            }
          : {}),
        ...(operation === 'ASSETS'
          ? {
              assetWorkflowVersion: 2 as const,
              ...(incremental
                ? { assetUpdateVersion: 1 as const, assetTextUpdateVersion: 1 as const }
                : {}),
              ...(assetProductionNote ? { assetProductionNote } : {}),
              ...(refreshImages
                ? { assetImageRefresh: { version: 1 as const, scopeVersion: 1 as const } }
                : {}),
              targetAssetId,
              identitySeed: randomUUID(),
            }
          : {}),
      };
      return this.createTask(tx, p, r, key, input);
    };
    return transaction ? perform(transaction) : this.db.$transaction(perform, { timeout: 15000 });
  }
  private async findReusableShotReview(tx: Tx, p: string, r: string, input: Snapshot) {
    if (input.operation !== 'SHOTS' || !input.incremental || input.shotWorkflowVersion !== 2)
      return null;
    const history = await tx.customizedProductionTask.findMany({
      where: { projectId: p, workflowRunId: r, operation: 'SHOTS', status: 'FAILED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 12,
    });
    const prior = history.find(
      (task) => hasLocalShotReview(task.output) && sameLocalShotReviewScope(input, snapshot(task)),
    );
    return prior ? reusableLocalShotReview(input, snapshot(prior), prior.output) : null;
  }
  private async createTask(tx: Tx, p: string, r: string, key: string, input: Snapshot) {
    const savedReview = await this.findReusableShotReview(tx, p, r, input);
    const task = await tx.customizedProductionTask.create({
      data: {
        projectId: p,
        workflowRunId: r,
        operation: input.operation,
        shotId: input.shotId,
        idempotencyKey: key,
        inputSnapshot: json(input),
        ...(savedReview ? { output: json(savedReview) } : {}),
        steps: json(
          productionStages(
            input.operation,
            input.assetWorkflowVersion,
            input.shotWorkflowVersion,
            input.promptWorkflowVersion,
          ).map((step) => ({
            id: step.id,
            status: 'PENDING',
            title: step.label,
            content: '',
          })),
        ),
      },
    });
    await this.enqueue(tx, task);
    return presentProductionTask(task);
  }
  private queueAssetImages(
    tx: Tx,
    p: string,
    r: string,
    request: Pick<Snapshot, 'document' | 'draftRevision' | 'script' | 'models'> & {
      key: string;
      source: WorkingArtifact[];
      incremental: NonNullable<Snapshot['incremental']>;
      definitionTaskId?: string;
    },
  ) {
    const { key, source, definitionTaskId, ...input } = request;
    return this.createTask(tx, p, r, key, {
      ...input,
      brief: source.find((artifact) => artifact.artifactKey === 'customized-brief')!.payload,
      sources: source.map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash })),
      operation: 'IMAGE',
      shotId: null,
      imageSettings: {
        ...CUSTOMIZED_DEFAULT_IMAGE_SETTINGS,
        assetIds: input.incremental.targetIds,
      },
      assetImageRefresh: { version: 1, ...(definitionTaskId ? { definitionTaskId } : {}) },
    });
  }
  private async hasTaskConflict(
    tx: Tx,
    projectId: string,
    workflowRunId: string,
    requested: ProductionTaskScope,
    excludeId?: string,
  ) {
    const active = await tx.customizedProductionTask.findMany({
      where: {
        projectId,
        workflowRunId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
    return active.some((task) =>
      productionTasksConflict(requested, {
        operation: task.operation,
        target: snapshot(task).target,
      }),
    );
  }
  private async taskArtifacts(tx: Tx, t: CustomizedProductionTask) {
    const rows = await tx.workingArtifact.findMany({
      where: { projectId: t.projectId, workflowRunId: t.workflowRunId, availability: 'AVAILABLE' },
    });
    if (snapshot(t).sources.some((s) => !rows.some((a) => a.id === s.id))) {
      const head = await sharedCustomizedBrief(tx, t.projectId, t.workflowRunId, undefined, true);
      if (
        head &&
        snapshot(t).sources.some((s) => s.id === head.id) &&
        !rows.some((a) => a.id === head.id)
      )
        rows.push(head);
    }
    return rows;
  }
  private async valid(tx: Tx, t: CustomizedProductionTask) {
    await this.scope(tx, t.projectId, t.workflowRunId);
    const input = snapshot(t),
      artifacts = await this.taskArtifacts(tx, t);
    if (
      input.sources.some(
        (s) =>
          !artifacts.some(
            (a) =>
              a.id === s.id &&
              a.revision === s.revision &&
              a.contentHash === s.hash &&
              a.freshness === 'CURRENT',
          ),
      )
    )
      return customizedConflict('任务来源已变化，请基于当前内容重新生成');
    const state = await this.state(tx, t.projectId, t.workflowRunId);
    if (input.videoRender) {
      for (const reference of input.videoRender.references) {
        const version = await tx.assetVersion.findFirst({
          where: {
            projectId: t.projectId,
            assetId: reference.assetId,
            version: reference.version,
            storageKey: reference.storageKey,
            sizeBytes: reference.sizeBytes,
            status: { not: 'UNAVAILABLE' },
            asset: {
              archivedAt: null,
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
            },
          },
        });
        if (!version) return customizedConflict('本镜引用图片版本已不可用');
      }
    }
    if (input.operation === 'IMAGE') {
      const current = (await this.read(tx, t.projectId, t.workflowRunId)).document;
      if (input.assetImageRefresh) {
        if (
          (state?.revision ?? 0) !== input.draftRevision ||
          workflowStateHash(current) !== workflowStateHash(input.document)
        )
          return customizedConflict('资产或草稿已变化，请重新查看局部更新范围');
        return;
      }
      const withoutImages = (doc: ProductionDocument) => ({
        ...doc,
        assets: doc.assets.map(({ imageBasis: _basis, ...a }) => ({ ...a, image: null })),
      });
      if (
        workflowStateHash(withoutImages(current)) !==
        workflowStateHash(withoutImages(input.document))
      )
        return customizedConflict('资产定义已变化，请重新生成图片');
      const images = (t.output ?? {}) as Record<string, unknown>;
      if (
        current.assets.some(
          (a) =>
            workflowStateHash(a.image ?? null) !==
            workflowStateHash(
              (Object.hasOwn(images, a.id) ? images[a.id] : undefined) ??
                input.document.assets.find((v) => v.id === a.id)?.image ??
                null,
            ),
        )
      )
        return customizedConflict('资产图片已被替换，请创建新的制作任务');
    } else if ((state?.revision ?? 0) !== input.draftRevision)
      return customizedConflict('制作草稿已改变，请重新生成');
    if (input.assetClarification) await this.assertClarificationBaseline(tx, t);
  }
  private async task(tx: Tx, p: string, id: string) {
    const t = await tx.customizedProductionTask.findFirst({ where: { projectId: p, id } });
    if (!t) return missing();
    return t;
  }
  getTask(p: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.task(tx, p, id);
      await this.scope(tx, p, t.workflowRunId);
      return presentProductionTask(t);
    });
  }
  candidate(p: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.task(tx, p, id);
      await this.scope(tx, p, t.workflowRunId);
      const saved = t.output as Record<string, unknown> | null;
      const document = candidateForPreview(saved);
      if (!document) return missing();
      const original = candidateForPreview({ value: saved?.value });
      return {
        document,
        candidateHash: videoHash(document),
        adopted: !!saved?.manualDraftAdoptedRevision,
        validForDraft: !!candidateDocument(saved),
        ...(original && videoHash(original) !== videoHash(document)
          ? { originalDocument: original }
          : {}),
        issues: (((saved?.recheck ?? saved?.audit) as VideoAudit | undefined)?.findings ?? []).map(
          (issue) => ({
            ...issue,
            title: videoReadableText(document.videoPlan, document.assets, issue.title),
            impact: videoReadableText(document.videoPlan, document.assets, issue.impact),
            suggestedFix: videoReadableText(
              document.videoPlan,
              document.assets,
              issue.suggestedFix,
            ),
          }),
        ),
      } satisfies VideoCandidate;
    });
  }
  reviewDraft(p: string, id: string, expectedRevision: number, candidateHash?: string) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const t = await this.task(tx, p, id);
        const input = snapshot(t),
          saved = t.output as Record<string, unknown> | null;
        if (t.status === 'FAILED' && t.operation === 'SHOTS' && input.shotWorkflowVersion === 2) {
          const candidate = candidateDocument(saved);
          if (!candidate || saved?.manualDraftAdoptedRevision)
            return customizedConflict('没有可供核对的分镜草稿');
          if (!candidateHash || candidateHash !== videoHash(candidate))
            return customizedConflict('核对候选已经变化，请重新查看');
          await this.valid(tx, t);
          const issue = validateVideoSnapshot(candidate, input);
          if (issue) invalid(issue);
          if (
            await tx.customizedProductionTask.count({
              where: {
                projectId: p,
                workflowRunId: t.workflowRunId,
                status: { in: ['QUEUED', 'RUNNING'] },
              },
            })
          )
            return customizedConflict('已有制作任务执行中');
          const draft = await this.writeDraft(
            tx,
            p,
            t.workflowRunId,
            candidate,
            input.sources[0]!.revision,
            expectedRevision,
          );
          await tx.customizedProductionTask.update({
            where: { id },
            data: { output: json({ ...saved, manualDraftAdoptedRevision: draft.revision }) },
          });
          return { revision: draft.revision };
        }
        if (
          t.status !== 'FAILED' ||
          t.operation !== 'ASSETS' ||
          input.assetWorkflowVersion !== 2 ||
          !Array.isArray(saved?.revised) ||
          saved.manualDraftAdoptedRevision
        )
          return customizedConflict('没有可供人工核对的完整草稿');
        await this.valid(tx, t);
        const w = await this.read(tx, p, t.workflowRunId);
        if (
          await tx.customizedProductionTask.count({
            where: {
              projectId: p,
              workflowRunId: t.workflowRunId,
              status: { in: ['QUEUED', 'RUNNING'] },
            },
          })
        )
          return customizedConflict('已有制作任务执行中，请等待完成');
        if (w.draftRevision !== expectedRevision)
          return customizedConflict('草稿已改变，本地修改已保留');
        const value = { assets: saved.revised, shots: [] };
        if (!isProductionDocument(value)) invalid('人工核对草稿结构不完整');
        const document = value as ProductionDocument;
        if (!input.targetAssetId && !document.assets.some((a) => a.kind === 'PRODUCT'))
          invalid('资产草稿缺少产品定义');
        const issue = validatePreparedAssets(document, input);
        if (issue) invalid(issue);
        const inventory = saved.inventory as { id: string }[] | undefined;
        if (
          !Array.isArray(inventory) ||
          inventory.length !== document.assets.length ||
          new Set(inventory.map((a) => a.id)).size !== document.assets.length ||
          inventory.some((a) => !document.assets.some((v) => v.id === a.id)) ||
          !['PRODUCT', 'CHARACTER', 'SCENE', 'PROP', 'IMAGE_PLAN', 'REVIEW'].every((id) =>
            (t.steps as unknown as ProductionStep[]).some(
              (s) => s.id === id && s.status === 'SUCCEEDED',
            ),
          )
        )
          return customizedConflict('资产定义尚未完整生成，不能进入人工核对');
        const draft = await this.writeDraft(
          tx,
          p,
          t.workflowRunId,
          {
            ...withProductionAssets(
              input.document,
              mergePreparedAssets(input.document.assets, document.assets),
            ),
          },
          input.sources[0]!.revision,
          expectedRevision,
        );
        await tx.customizedProductionTask.update({
          where: { id },
          data: { output: json({ ...saved, manualDraftAdoptedRevision: draft.revision }) },
        });
        return { revision: draft.revision };
      },
      { timeout: 15000 },
    );
  }
  claim(p: string, id: string, node?: ProductionWorkerNode) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const t = await this.task(tx, p, id);
      assertWorkerOperation(t.operation, node);
      if (!['QUEUED', 'RUNNING'].includes(t.status)) return { terminal: true };
      if (t.status === 'RUNNING' && t.leaseExpiresAt && t.leaseExpiresAt > new Date())
        return { busy: true };
      try {
        await this.valid(tx, t);
      } catch (e) {
        if (!(e instanceof ApiHttpException)) throw e;
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'FAILED',
            errorMessage: '任务依据已变化，请重新生成',
            attemptToken: null,
            leaseExpiresAt: null,
          },
        });
        return { terminal: true };
      }
      const token = randomUUID();
      await tx.customizedProductionTask.update({
        where: { id },
        data: {
          status: 'RUNNING',
          attemptToken: token,
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 90000),
          errorMessage: null,
        },
      });
      return { attemptToken: token, input: t.inputSnapshot, output: t.output, steps: t.steps };
    });
  }
  rerouteLegacyAssets(p: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const t = await this.task(tx, p, id);
      if (t.operation !== 'ASSETS' || t.status !== 'QUEUED') return { forwarded: false };
      await this.enqueue(tx, t);
      return { forwarded: true };
    });
  }
  private async lease(tx: Tx, p: string, id: string, token: string, node?: ProductionWorkerNode) {
    await lockCustomizedProject(tx, p);
    const t = await this.task(tx, p, id);
    assertWorkerOperation(t.operation, node);
    if (
      t.status !== 'RUNNING' ||
      !token ||
      t.attemptToken !== token ||
      !t.leaseExpiresAt ||
      t.leaseExpiresAt <= new Date()
    )
      return customizedConflict('执行已取消或租约失效');
    await this.valid(tx, t);
    return t;
  }
  heartbeat(p: string, id: string, token: string, node?: ProductionWorkerNode) {
    return this.db.$transaction(async (tx) => {
      await this.lease(tx, p, id, token, node);
      await tx.customizedProductionTask.update({
        where: { id },
        data: { leaseExpiresAt: new Date(Date.now() + 90000) },
      });
      return { accepted: true };
    });
  }
  videoRenderScope(p: string, id: string, token: string, allowCompleted = false) {
    return this.db.$transaction(async (tx) => {
      const row = await this.task(tx, p, id);
      if (row.operation !== 'RENDER') invalid('不是视频渲染任务');
      const t =
        allowCompleted && row.status === 'COMPLETED' && row.attemptToken === token
          ? row
          : await this.lease(tx, p, id, token, 'VIDEO');
      const project = await tx.project.findUniqueOrThrow({ where: { id: p } });
      if (project.deletionState) return customizedConflict('项目正在删除');
      return {
        input: snapshot(t).videoRender!,
        projectName: project.name,
        result:
          t.status === 'COMPLETED'
            ? (t.output as { video?: CustomizedVideoResult })?.video
            : undefined,
      };
    });
  }
  async videoFile(p: string, r: string, clipId: string, poster = false) {
    return this.db.$transaction(async (tx) => {
      await this.scope(tx, p, r);
      const artifact = await tx.workingArtifact.findFirst({
        where: {
          projectId: p,
          workflowRunId: r,
          artifactKey: `customized-clip-video:${clipId}`,
          availability: 'AVAILABLE',
        },
      });
      const result = artifact?.payload as unknown as CustomizedVideoResult | undefined;
      if (!result) return missing();
      const file = await tx.fileObject.findFirst({
        where: {
          projectId: p,
          id: poster ? result.posterFileObjectId : result.fileObjectId,
          status: 'AVAILABLE',
          artifactLinks: { some: { workingArtifactId: artifact!.id } },
        },
      });
      if (!file) return missing();
      return file;
    });
  }
  acceptVideo(
    p: string,
    id: string,
    token: string,
    info: CustomizedVideoFileInfo,
    files: {
      video: { storageKey: string; sizeBytes: number; sha256: string };
      poster: { storageKey: string; sizeBytes: number; sha256: string };
    },
  ) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const row = await this.task(tx, p, id);
        if (row.operation !== 'RENDER') invalid('不是视频渲染任务');
        if (row.status === 'COMPLETED' && row.attemptToken === token)
          return { stored: false, video: (row.output as { video: CustomizedVideoResult }).video };
        const t = await this.lease(tx, p, id, token, 'VIDEO');
        const input = snapshot(t),
          render = input.videoRender!;
        const issue = videoFileIssues(render.settings, render.seconds, info);
        if (issue) invalid(issue);
        if (!(t.output as { providerTaskId?: string } | null)?.providerTaskId)
          invalid('缺少已保存的供应商任务');
        const existing = await tx.workingArtifact.findFirst({
          where: {
            projectId: p,
            workflowRunId: t.workflowRunId,
            artifactKey: `customized-clip-video:${render.clipId}`,
            availability: 'AVAILABLE',
            freshness: 'CURRENT',
          },
          include: { files: { include: { fileObject: true } }, dependencies: true },
        });
        const oldVideo = existing?.payload as unknown as CustomizedVideoResult | undefined;
        const identical =
          !!oldVideo &&
          workflowStateHash(oldVideo.settings) === workflowStateHash(render.settings) &&
          oldVideo.durationSeconds === info.durationSeconds &&
          oldVideo.width === info.width &&
          oldVideo.height === info.height &&
          existing!.files.some(
            (f) => f.role === 'PRIMARY' && f.fileObject.sha256 === files.video.sha256,
          ) &&
          existing!.files.some(
            (f) => f.role === 'POSTER' && f.fileObject.sha256 === files.poster.sha256,
          ) &&
          existing!.dependencies.length === input.sources.length &&
          input.sources.every((s) =>
            existing!.dependencies.some(
              (d) =>
                d.sourceArtifactId === s.id &&
                d.sourceRevision === s.revision &&
                d.sourceHash === s.hash,
            ),
          );
        if (identical) {
          await tx.customizedProductionTask.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              leaseExpiresAt: null,
              output: json({ ...((t.output as object) ?? {}), video: oldVideo }),
              steps: json(
                (t.steps as unknown as ProductionStep[]).map((s) => ({
                  ...s,
                  status: 'SUCCEEDED',
                  ...(s.id === 'SAVE'
                    ? { content: '视频内容与现有版本一致，已复用文件，不增加版本' }
                    : {}),
                })),
              ),
            },
          });
          return { stored: false, video: oldVideo! };
        }
        const records = await Promise.all(
          (['video', 'poster'] as const).map((kind) =>
            this.working.upsertFileObjectInTransaction(tx, p, t.workflowRunId, {
              ...files[kind],
              nodeId: 'SHOT_RENDER',
              originalFileName: `${render.clipId}${kind === 'poster' ? '-poster.jpg' : '.mp4'}`,
              mimeType: kind === 'poster' ? 'image/jpeg' : 'video/mp4',
            }),
          ),
        );
        const video: CustomizedVideoResult = {
          ...info,
          clipId: render.clipId,
          taskId: id,
          settings: render.settings,
          fileObjectId: records[0]!.id,
          posterFileObjectId: records[1]!.id,
        };
        const sources = (await this.taskArtifacts(tx, t)).filter((a) =>
          input.sources.some((s) => s.id === a.id),
        );
        await this.working.commitValidatedArtifactsInTransaction(
          tx,
          p,
          t.workflowRunId,
          'SHOT_RENDER',
          [
            {
              artifactKey: `customized-clip-video:${render.clipId}`,
              input: {
                kind: 'FILE',
                name: `${render.title} · 分镜视频`.slice(0, 120),
                directory: 'VIDEO_MATERIALS',
                type: 'VIDEO_MATERIAL',
                payload: video,
                storageKey: records[0]!.storageKey,
                mimeType: 'video/mp4',
                sizeBytes: records[0]!.sizeBytes,
                originalFileName: records[0]!.originalFileName,
                fileChecksum: records[0]!.sha256,
                files: records.map((f, i) => ({
                  fileObjectId: f.id,
                  role: i === 0 ? 'PRIMARY' : 'POSTER',
                  sortOrder: i,
                  originalFileName: f.originalFileName,
                  mimeType: f.mimeType,
                  sha256: f.sha256,
                })),
                dependencies: sources.map((a) => this.dependency(a)),
              },
            },
          ],
        );
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            leaseExpiresAt: null,
            output: json({ ...((t.output as object) ?? {}), video }),
            steps: json(
              (t.steps as unknown as ProductionStep[]).map((s) => ({
                ...s,
                status: 'SUCCEEDED',
                ...(s.id === 'REVIEW'
                  ? {
                      content: `视频已校验：${info.width}×${info.height}，${info.durationSeconds.toFixed(2)}秒`,
                    }
                  : s.id === 'SAVE'
                    ? { content: `${render.title}的视频已原位保存，可播放和下载` }
                    : {}),
              })),
            ),
          },
        });
        return { stored: true, video };
      },
      { timeout: 30000 },
    );
  }
  imageScope(p: string, id: string, token: string, objectId: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, 'ASSETS');
      const input = snapshot(t);
      if (t.operation !== 'IMAGE' || !input.imageSettings?.assetIds.includes(objectId))
        invalid('图片不属于本次选定资产');
      const asset = input.document.assets.find((a) => a.id === objectId)!;
      const project = await tx.project.findUniqueOrThrow({ where: { id: p } });
      return { name: asset.name, projectName: project.name };
    });
  }
  imageReferenceScope(p: string, id: string, token: string, assetId: string, version: number) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, 'ASSETS');
      if (
        t.operation !== 'IMAGE' ||
        !snapshot(t).imageSettings?.inputs?.some((i) =>
          i.references.some((r) => r.assetId === assetId && r.version === version),
        )
      )
        invalid('参考图片不属于本次任务');
      const file = await tx.assetVersion.findFirst({
        where: {
          projectId: p,
          assetId,
          version,
          status: { not: 'UNAVAILABLE' },
          mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
          asset: { storageWorkflow: 'CUSTOMIZED', workflowSpace: 'CUSTOMIZED_PROJECT' },
        },
      });
      if (!file?.storageKey || file.sizeBytes > CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES)
        return missing();
      return { storageKey: file.storageKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes };
    });
  }
  acceptImage(
    p: string,
    id: string,
    token: string,
    objectId: string,
    file: {
      storageKey: string;
      sizeBytes: number;
      mimeType: string;
      originalFileName: string;
      sha256: string;
    },
  ) {
    return this.db.$transaction(
      async (tx) => {
        const t = await this.lease(tx, p, id, token, 'ASSETS');
        const input = snapshot(t);
        if (t.operation !== 'IMAGE' || !input.imageSettings?.assetIds.includes(objectId))
          invalid('图片不属于本次选定资产');
        const images = Object.assign(
          Object.create(null) as Record<string, { assetId: string; version: number }>,
          t.output ?? {},
        );
        if (images[objectId]) return { image: images[objectId], stored: false };
        const definition = input.document.assets.find((a) => a.id === objectId)!;
        const { sha256, ...metadata } = file;
        const record = await new AssetRepository(this.db).createInTransaction(
          tx,
          p,
          {
            ...metadata,
            name: definition.name.slice(0, 120),
            directory: 'VISUAL_ASSETS',
            type: (
              {
                PRODUCT: 'PRODUCT_ASSET',
                CHARACTER: 'PERSON_ASSET',
                SCENE: 'SCENE_BACKGROUND',
                PROP: 'VISUAL_ASSET',
              } as const
            )[definition.kind],
            storageWorkflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
            status: 'PENDING_REVIEW',
            qualityStatus: 'PENDING_REVIEW',
            tags: [],
            notes: 'AI 生成公共形象，使用前请核对',
            sourceRunId: t.workflowRunId,
            sourceNode: 'SHOT_PROMPT',
            sourceArtifactId: `customized-object:${objectId}`,
            idempotencyKey: `customized-image:${id}:${objectId}`,
            businessData: json({ objectId, taskId: id, model: input.imageSettings!.model }),
            workflowFile: { workflowRunId: t.workflowRunId, nodeId: 'SHOT_PROMPT', sha256 },
          },
          '资产图片生成',
        );
        const image = { assetId: record.id, version: record.currentVersion };
        images[objectId] = image;
        if (!input.assetImageRefresh) {
          const w = await this.read(tx, p, t.workflowRunId);
          await this.writeDraft(
            tx,
            p,
            t.workflowRunId,
            {
              ...w.document,
              assets: w.document.assets.map((a) =>
                a.id === objectId ? { ...a, image, imageBasis: assetImageBasis(definition) } : a,
              ),
            },
            w.source.revision,
            w.draftRevision,
          );
        }
        const finished = input.imageSettings!.assetIds.every((assetId) => images[assetId]);
        const content = input.assetImageRefresh
          ? `已保存 ${Object.keys(images).length} / ${input.imageSettings!.assetIds.length} 张新图，全部完成后关联。`
          : input
              .imageSettings!.assetIds.map((assetId) => {
                const name = input.document.assets.find((a) => a.id === assetId)!.name;
                return `${name}：${images[assetId] ? '图片已保存并关联' : '等待生成'}`;
              })
              .join('\n');
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            output: json(images),
            steps: json(
              (t.steps as unknown as ProductionStep[]).map((s) =>
                s.id === 'GENERATE'
                  ? { ...s, status: finished ? 'SUCCEEDED' : 'RUNNING', content }
                  : s,
              ),
            ),
          },
        });
        return { image, stored: true };
      },
      { timeout: 30000 },
    );
  }
  private async publishRefreshedImages(
    tx: Tx,
    task: CustomizedProductionTask,
    input: Snapshot,
    results: Record<string, { assetId: string; version: number }>,
  ) {
    const { projectId: p, workflowRunId: r } = task;
    const images = new Map(input.imageSettings!.assetIds.map((id) => [id, results[id]!]));
    const versions = await tx.assetVersion.findMany({
      where: {
        projectId: p,
        OR: [...images.values()],
        status: { not: 'UNAVAILABLE' },
        mimeType: 'image/png',
        asset: {
          projectId: p,
          storageWorkflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          sourceRunId: r,
          sourceNode: 'SHOT_PROMPT',
          archivedAt: null,
        },
      },
    });
    if (
      [...images.values()].some(
        (image) =>
          !versions.some(
            (file) =>
              file.assetId === image.assetId &&
              file.version === image.version &&
              file.storageKey &&
              file.sizeBytes > 0,
          ),
      )
    )
      return customizedConflict('部分新图片已不可用，请重新制作关联图片');
    const before = (await this.taskArtifacts(tx, task)).filter(
      (a) =>
        a.artifactKey !== 'customized-brief' || input.sources.some((source) => source.id === a.id),
    );
    const value = withProductionAssets(
      input.document,
      input.document.assets.map((asset) => {
        const image = images.get(asset.id);
        return image ? { ...asset, image, imageBasis: assetImageBasis(asset) } : asset;
      }),
    );
    const sourceRevision = input.sources[0]!.revision;
    const state = await this.writeDraft(tx, p, r, value, sourceRevision, input.draftRevision);
    await this.confirmAssetDocument(tx, p, r, value, sourceRevision, state.revision, before);
  }
  checkpoint(
    p: string,
    id: string,
    token: string,
    step: ProductionStep,
    output?: unknown,
    node?: ProductionWorkerNode,
  ) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, node);
      if (
        !(t.steps as unknown as ProductionStep[]).some((s) => s.id === step.id) ||
        step.id === 'SAVE' ||
        !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(step.status)
      )
        invalid('执行步骤不正确');
      if (JSON.stringify(output ?? null).length > 2_000_000 || step.content.length > 100000)
        invalid('结果超过大小限制');
      if (t.operation === 'PROMPT' && output !== undefined) {
        const prior = (t.output ?? {}) as Record<string, unknown>;
        const next =
          output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
        if (
          workflowStateHash(prior.mechanicalRecovery ?? null) !==
          workflowStateHash(next.mechanicalRecovery ?? null)
        )
          return customizedConflict('机械恢复轮次不匹配，已有检查点保留');
      }
      if (t.operation === 'IMAGE' && (output !== undefined || step.id === 'GENERATE'))
        invalid('图片完成状态只能由已保存的文件更新');
      if (t.operation === 'RENDER' && output !== undefined) {
        const value = output as {
          providerTaskId?: unknown;
          createStarted?: unknown;
          rateLimited?: unknown;
          createRejected?: unknown;
          createRejectedHttpStatus?: unknown;
        };
        const saved = (t.output ?? {}) as { providerTaskId?: string; createStarted?: boolean };
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).some(
            (k) =>
              ![
                'providerTaskId',
                'createStarted',
                'rateLimited',
                'createRejected',
                'createRejectedHttpStatus',
              ].includes(k),
          ) ||
          (value.providerTaskId !== undefined &&
            (typeof value.providerTaskId !== 'string' ||
              !value.providerTaskId.trim() ||
              value.providerTaskId.length > 255)) ||
          (value.createStarted !== undefined && typeof value.createStarted !== 'boolean') ||
          (value.rateLimited !== undefined && typeof value.rateLimited !== 'boolean') ||
          (value.createRejected !== undefined && typeof value.createRejected !== 'boolean') ||
          (value.createRejectedHttpStatus !== undefined &&
            (typeof value.createRejectedHttpStatus !== 'number' ||
              !Number.isInteger(value.createRejectedHttpStatus) ||
              value.createRejectedHttpStatus < 400 ||
              value.createRejectedHttpStatus > 499 ||
              value.createRejectedHttpStatus === 429 ||
              value.createRejected !== true))
        )
          invalid('渲染检查点无效');
        if (
          saved.providerTaskId &&
          value.providerTaskId &&
          saved.providerTaskId !== value.providerTaskId
        )
          return customizedConflict('已提交的供应商任务不可替换');
        if (
          saved.createStarted &&
          value.createStarted === false &&
          value.rateLimited !== true &&
          value.createRejected !== true
        )
          invalid('不可清除已提交请求的保护状态');
        output = { ...saved, ...value };
      }
      const steps = t.steps as unknown as ProductionStep[];
      const old = steps.find((s) => s.id === step.id)!;
      if (old.status === 'SUCCEEDED') return { accepted: true };
      await tx.customizedProductionTask.update({
        where: { id },
        data: {
          steps: json(steps.map((s) => (s.id === step.id ? step : s))),
          ...(output === undefined ? {} : { output: json(output) }),
        },
      });
      return { accepted: true };
    });
  }
  complete(p: string, id: string, token: string, output: unknown, node?: ProductionWorkerNode) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const prior = await this.task(tx, p, id);
        assertWorkerOperation(prior.operation, node);
        if (prior.status === 'COMPLETED' && prior.attemptToken === token) return { accepted: true };
        const t = await this.lease(tx, p, id, token, node),
          input = snapshot(t),
          steps = t.steps as unknown as ProductionStep[];
        if (t.operation === 'RENDER') invalid('视频只能通过受保护的文件上传自动完成');
        if (t.operation === 'IMAGE') {
          const results = (t.output ?? {}) as Record<string, { assetId: string; version: number }>;
          if (
            !input.imageSettings?.assetIds.every((id) => Object.hasOwn(results, id)) ||
            !steps.filter((s) => s.id !== 'SAVE').every((s) => s.status === 'SUCCEEDED')
          )
            return customizedConflict('仍有资产图片未生成');
          if (input.assetImageRefresh) await this.publishRefreshedImages(tx, t, input, results);
          await tx.customizedProductionTask.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              leaseExpiresAt: null,
              steps: json(
                steps.map((s) =>
                  s.id === 'SAVE'
                    ? {
                        ...s,
                        status: 'SUCCEEDED',
                        content: input.assetImageRefresh
                          ? '新图片已关联并保存，可用于后续制作'
                          : '图片已关联到对应资产，保存修改后确认用于后续制作',
                      }
                    : s,
                ),
              ),
            },
          });
          return { accepted: true };
        }
        if (
          !steps.filter((s) => s.id !== 'SAVE').every((s) => s.status === 'SUCCEEDED') ||
          workflowStateHash(output) !==
            workflowStateHash((t.output as Record<string, unknown> | null)?.final ?? t.output)
        )
          return customizedConflict('内容尚未完成审校');
        if (input.assetClarification) {
          if (!isAssetClarificationProposal(output) || !isCustomizedBrief(input.brief))
            return invalid('人工核对建议格式无效');
          const candidate = {
            ...input.brief,
            ...Object.fromEntries(
              clarificationChanges(input.brief, output).map(({ field, after }) => [field, after]),
            ),
          };
          if (!candidate.productName.trim() || !candidate.sellingPoints.some((v) => v.trim()))
            return invalid('建议不能清空产品名称或全部核心卖点');
          await tx.customizedProductionTask.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              leaseExpiresAt: null,
              errorMessage: null,
              output: json({ final: output }),
            },
          });
          return { accepted: true };
        }
        let queuedAssetImages = false;
        if (input.operation === 'PROMPT') {
          if (input.shotWorkflowVersion === 2) {
            const issue = validateFinalClipPrompt(
              output,
              input,
              (t.output ?? {}) as Record<string, unknown>,
            );
            if (issue) invalid(issue);
            if (
              !isVideoDocument(input.document) ||
              !isProductionClipPrompt(output, input.document.videoPlan) ||
              output.target.id !== input.target?.id
            )
              invalid('片段提示词引用不匹配');
            const prompt = output as ProductionClipPrompt;
            const artifacts = await this.artifacts(tx, p, t.workflowRunId),
              source = artifacts.find(
                (a) => a.artifactKey === `customized-video-clip:${prompt.target.id}`,
              )!;
            if (!source) return customizedConflict('片段工作副本不存在');
            await this.commit(
              tx,
              p,
              t.workflowRunId,
              'SHOT_RENDER',
              `customized-clip-prompt:${prompt.target.id}`,
              '片段提示词',
              prompt,
              [source],
            );
          } else {
            const shot = productionShots(input.document).find((s) => s.id === input.shotId)!;
            if (!isProductionPrompt(output, shot)) invalid('提示词引用不匹配当前镜头');
            const artifacts = await this.artifacts(tx, p, t.workflowRunId);
            await this.commit(
              tx,
              p,
              t.workflowRunId,
              'SHOT_RENDER',
              `customized-shot-prompt:${shot.id}`,
              `镜头提示词 · ${shot.title}`,
              output,
              [
                artifacts.find((a) => a.artifactKey === `customized-shot:${shot.id}`)!,
                ...shot.bindings
                  .map((b) =>
                    artifacts.find((a) => a.artifactKey === `customized-object:${b.assetId}`)!,
                  )
                  .filter(Boolean),
              ],
            );
          }
        } else {
          const value = output as ProductionDocument;
          if (
            !isProductionDocument(value) ||
            (!input.targetAssetId && !value.assets.some((a) => a.kind === 'PRODUCT'))
          )
            invalid('资产或分镜结果不完整');
          if (input.assetWorkflowVersion === 2) {
            const issue = validatePreparedAssets(value, input);
            if (issue) invalid(issue);
            const scopeIssue = validateAssetUpdateScope(value, input, t.output);
            if (scopeIssue) invalid(scopeIssue);
          }
          if (
            input.operation === 'SHOTS' &&
            (!productionShots(value).length ||
              workflowStateHash(value.assets) !== workflowStateHash(input.document.assets))
          )
            invalid('分镜不得修改已确认的资产目录');
          if (input.operation === 'SHOTS') {
            if (input.shotWorkflowVersion === 2) {
              const issue = validateFinalVideo(
                value,
                input,
                (t.output ?? {}) as Record<string, unknown>,
              );
              if (issue) invalid(issue);
            } else {
              const target =
                input.script.story?.beats.reduce((n, b) => n + b.durationSeconds, 0) ||
                input.script.shots.reduce((n, s) => n + s.durationSeconds, 0);
              if (
                target &&
                Math.abs(
                  productionShots(value).reduce((n, s) => n + s.durationSeconds, 0) - target,
                ) > 1
              )
                invalid('分镜总时长与故事不一致');
            }
          }
          // Re-extracting the catalog must never erase existing storyboards.
          let preserved =
            input.operation === 'ASSETS'
              ? withProductionAssets(
                  input.document,
                  input.assetTextUpdateVersion === 1
                    ? markLegacyImagesForReview(input.document.assets, value.assets)
                    : input.assetUpdateVersion === 1
                      ? value.assets
                      : mergePreparedAssets(input.document.assets, value.assets),
                )
              : value;
          const imagePlan =
            input.operation === 'ASSETS' && input.assetImageRefresh
              ? planAssetImageRefresh(
                  input.document.assets,
                  preserved.assets,
                  input.assetImageRefresh.scopeVersion === 1
                    ? (t.output as { assetUpdatePlan: AssetUpdatePlan }).assetUpdatePlan
                        .imageDecisions
                    : undefined,
                  input.assetImageRefresh.scopeVersion === 1
                    ? await retainedAssetImageFingerprints(tx, p, t.workflowRunId)
                    : undefined,
                )
              : undefined;
          if (imagePlan) preserved = withProductionAssets(preserved, imagePlan.assets);
          let destination = t.workflowRunId;
          if (input.operation === 'ASSETS' && !input.targetAssetId && !input.incremental) {
            const catalog = (await this.artifacts(tx, p, destination)).find(
              (a) => a.artifactKey === 'customized-asset-catalog',
            );
            if (
              !catalog ||
              workflowStateHash(catalog.payload) !== workflowStateHash({ assets: preserved.assets })
            )
              destination = await createAssetBranch(tx, p, t.workflowRunId, t.id);
          }
          const branchDocument =
            destination === t.workflowRunId ? preserved : { assets: preserved.assets, shots: [] };
          const draft = await this.writeDraft(
            tx,
            p,
            destination,
            branchDocument,
            input.sources[0]!.revision,
            destination === t.workflowRunId ? input.draftRevision : 0,
          );
          if (input.operation === 'ASSETS') {
            const frozen = await this.taskArtifacts(tx, t);
            // The confirmed information consumed by this task survives a history-view switch.
            const source = frozen.find(
              (a) =>
                a.artifactKey === 'customized-brief' && input.sources.some((s) => s.id === a.id),
            );
            const catalog = await this.commitAssets(
              tx,
              p,
              destination,
              branchDocument,
              destination === t.workflowRunId
                ? source
                  ? [...frozen.filter((a) => a.artifactKey !== 'customized-brief'), source]
                  : frozen
                : undefined,
            );
            if (imagePlan?.assetIds.length && input.incremental && source) {
              const story = frozen.find((artifact) => artifact.id === input.sources[0]!.id)!;
              await this.queueAssetImages(tx, p, destination, {
                key: `asset-image-refresh:${id}`,
                definitionTaskId: id,
                document: branchDocument,
                draftRevision: draft.revision,
                script: input.script,
                models: input.models,
                source: [story, catalog, source],
                incremental: { ...input.incremental, targetIds: imagePlan.assetIds },
              });
              queuedAssetImages = true;
            }
            const saved = t.output as Record<string, unknown> | null;
            await tx.customizedProductionTask.update({
              where: { id },
              data: {
                output: json({
                  ...(saved ?? {}),
                  final: output,
                  publishedWorkflowRunId: destination,
                }),
              },
            });
          } else if (
            input.operation === 'SHOTS' &&
            input.shotWorkflowVersion === 2 &&
            input.incremental
          ) {
            // Finalize the same validated draft even if the user closed or refreshed the page.
            const frozen = await this.taskArtifacts(tx, t);
            const artifacts = frozen.filter(
              (artifact) =>
                artifact.artifactKey !== 'customized-brief' ||
                input.sources.some((source) => source.id === artifact.id),
            );
            const story = artifacts.find((artifact) => artifact.id === input.sources[0]!.id)!;
            await this.confirmShotDocument(tx, p, destination, branchDocument, story, artifacts);
          }
        }
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            leaseExpiresAt: null,
            steps: json(
              steps.map((s) =>
                s.id === 'SAVE'
                  ? {
                      ...s,
                      status: 'SUCCEEDED',
                      content:
                        input.operation === 'ASSETS'
                          ? queuedAssetImages
                            ? '资产定义已保存，关联图片正在排队更新'
                            : '资产目录已确认并保存，可继续准备图片或进入视频制作'
                          : '内容已保存，可在当前工作台查看和编辑',
                    }
                  : s,
              ),
            ),
          },
        });
        return { accepted: true };
      },
      { timeout: 30000 },
    );
  }
  fail(p: string, id: string, token: string, retryable: boolean, node?: ProductionWorkerNode) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, node),
        saved = (t.output ?? {}) as { createRejected?: boolean },
        uncertain = unconfirmedVideoCreation(t),
        retry = retryable && !uncertain && t.attemptCount < 3;
      const imageRefresh = t.operation === 'IMAGE' && snapshot(t).assetImageRefresh;
      const steps = t.steps as unknown as ProductionStep[];
      const failedImageStep = steps.some((s) => s.id === 'GENERATE' && s.status === 'SUCCEEDED')
        ? 'SAVE'
        : 'GENERATE';
      const incompleteMessage = imageRefresh
        ? '资产定义和旧图可继续使用。继续更新时会复用已生成的新图。'
        : (localShotUpdateFailureMessage(t) ?? incompleteProductionMessage);
      const renderFailure =
        t.operation === 'RENDER'
          ? (!steps.some((s) => s.status === 'RUNNING') &&
              steps.findLast((s) => s.status === 'FAILED')?.content) ||
            (uncertain
              ? unconfirmedVideoMessage
              : saved.createRejected
                ? rejectedVideoMessage
                : incompleteProductionMessage)
          : undefined;
      await tx.customizedProductionTask.update({
        where: { id },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          steps: json(
            steps.map((s) =>
              imageRefresh && !retry && s.id === failedImageStep
                ? {
                    ...s,
                    status: 'FAILED',
                    content: '关联图片未全部保存到资产。已生成的图片会在继续时复用。',
                  }
                : s.status === 'RUNNING'
                  ? { ...s, status: 'FAILED', ...(renderFailure ? { content: renderFailure } : {}) }
                  : s,
            ),
          ),
          attemptToken: null,
          leaseExpiresAt: null,
          errorMessage: retry
            ? '服务暂时繁忙，正在等待自动重试'
            : (renderFailure ?? incompleteMessage),
        },
      });
      if (retry) await this.enqueue(tx, t, t.attemptCount * 15000);
      return { accepted: true };
    });
  }
  action(p: string, id: string, cancel: boolean) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const t = await this.task(tx, p, id);
      await this.scope(tx, p, t.workflowRunId);
      return this.applyTaskAction(tx, t, cancel);
    });
  }
  retryLocalMedia(p: string, batchKey: string, request: ProductionLocalMediaRetryRequest) {
    const r = request.workflowRunId;
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        await this.scope(tx, p, r);
        const batch = await tx.customizedProductionTask.findMany({
          where: {
            projectId: p,
            workflowRunId: r,
            operation: { in: ['PROMPT', 'RENDER'] },
            inputSnapshot: { path: ['incremental', 'batchKey'], equals: batchKey },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const operation = batch[0]?.operation;
        if (operation !== 'PROMPT' && operation !== 'RENDER') return missing();
        if (batch.some((task) => task.operation !== operation))
          return customizedConflict('本次任务范围已变化，请重新查看局部更新');
        const versions = new Map(request.tasks.map(({ id, version }) => [id, version]));
        const requested = batch.filter((task) => versions.has(task.id));
        if (!requested.length || requested.length !== request.tasks.length)
          return customizedConflict('本次任务范围已变化，请重新查看局部更新');
        const failed = requested.filter((task) => task.status === 'FAILED');
        if (!failed.length) return batch.map(presentProductionTask);
        const preview = await updatePreview(tx, p, r, operation);
        const pending = new Set(preview.items.map((item) => item.id));
        const resumed = new Map<string, ProductionTask>();
        for (const task of failed) {
          if (task.updatedAt.toISOString() !== versions.get(task.id))
            return customizedConflict('有任务状态已变化，请重新查看后继续');
          const clipId = snapshot(task).target?.id;
          if (!clipId) return customizedConflict('分镜范围已变化，请重新查看局部更新');
          if (!pending.has(clipId))
            return customizedConflict('有分镜已有最新结果，请重新查看更新范围');
          const latest = await tx.customizedProductionTask.findFirst({
            where: {
              projectId: p,
              workflowRunId: r,
              operation: task.operation,
              inputSnapshot: { path: ['target', 'id'], equals: clipId },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true },
          });
          if (latest?.id !== task.id)
            return customizedConflict('有分镜已有更新的执行记录，请重新查看更新范围');
          resumed.set(task.id, await this.applyTaskAction(tx, task, false));
        }
        return batch.map((task) => resumed.get(task.id) ?? presentProductionTask(task));
      },
      { timeout: 30000 },
    );
  }
  private async applyTaskAction(tx: Tx, t: CustomizedProductionTask, cancel: boolean) {
    const { projectId: p, id } = t;
    if (t.status === 'COMPLETED' || (!cancel && ['QUEUED', 'RUNNING'].includes(t.status)))
      return presentProductionTask(t);
    if (!cancel) {
      if (unconfirmedVideoCreation(t))
        return customizedConflict('视频平台的接单结果待确认，请先查看任务详情');
      if (rejectedVideoInput(t))
        return customizedConflict(
          '视频平台已拒绝这份输入。请核对本镜的提示词、参考图或视频设置后重新生成',
        );
      const evidenceFailure = assetEvidenceFailureMessage(
        t.output as Record<string, unknown> | null,
      );
      if (evidenceFailure) return customizedConflict(evidenceFailure);
      const shotFailure = localShotUpdateFailureMessage(t);
      if (shotFailure && !reusableLocalShotReview(snapshot(t), snapshot(t), t.output))
        return customizedConflict(shotFailure);
      if (assetBlockers(snapshot(t), t.output).length)
        return customizedConflict('请补充说明并重新判断，继续旧任务不会解决人工核对事项');
      if (
        t.operation === 'ASSETS' &&
        (snapshot(t).assetClarification || snapshot(t).incremental) &&
        (await this.latestAssetTask(tx, p, t.workflowRunId))?.id !== t.id
      )
        return customizedConflict('已有更新的资产任务，请返回当前记录');
      await this.valid(tx, t);
      if (
        await this.hasTaskConflict(
          tx,
          p,
          t.workflowRunId,
          { operation: t.operation, target: snapshot(t).target },
          id,
        )
      )
        return customizedConflict('已有制作任务运行中');
    }
    let recoveryOutput: Record<string, unknown> | null = null;
    if (!cancel) {
      if (t.operation === 'SHOTS') {
        if (!(t.output as { localCandidate?: unknown } | null)?.localCandidate)
          recoveryOutput = await this.findReusableShotReview(tx, p, t.workflowRunId, snapshot(t));
      } else {
        try {
          recoveryOutput = beginPromptMechanicalRecovery(
            t.operation,
            t.status,
            t.steps as unknown as ProductionStep[],
            t.output,
          );
        } catch (error) {
          invalid(error instanceof Error ? error.message : '机械恢复记录不可用');
        }
      }
    }
    const updated = await tx.customizedProductionTask.update({
      where: { id },
      data: {
        status: cancel ? 'CANCELLED' : 'QUEUED',
        attemptToken: null,
        leaseExpiresAt: null,
        errorMessage: null,
        ...(!cancel ? { attemptCount: 0 } : {}),
        ...(recoveryOutput ? { output: json(recoveryOutput) } : {}),
      },
    });
    if (!cancel) await this.enqueue(tx, updated);
    return presentProductionTask(updated);
  }
  async recoverExpired() {
    const rows = await this.db.customizedProductionTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
    });
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        await lockCustomizedProject(tx, row.projectId);
        const t = await this.task(tx, row.projectId, row.id);
        if (t.status !== 'RUNNING' || !t.leaseExpiresAt || t.leaseExpiresAt > new Date()) return;
        const saved = (t.output ?? {}) as { createStarted?: boolean; providerTaskId?: string };
        const retry =
          t.attemptCount < 3 &&
          !(t.operation === 'RENDER' && saved.createStarted && !saved.providerTaskId);
        await tx.customizedProductionTask.update({
          where: { id: t.id },
          data: {
            status: retry ? 'QUEUED' : 'FAILED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorMessage: '执行连接中断，已保留检查点',
          },
        });
        if (retry) await this.enqueue(tx, t, 15000);
      });
  }
}
import { productionTasksConflict, type ProductionTaskScope } from '@ai-marketing/contracts';
