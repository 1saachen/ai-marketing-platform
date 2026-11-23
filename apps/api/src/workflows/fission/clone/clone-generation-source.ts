import {
  CLONE_ANALYSIS_ARTIFACT_KEY,
  CLONE_GENERATION_LIMITS,
  CLONE_INPUT_ARTIFACT_KEY,
  CLONE_MAPPING_ARTIFACT_KEY,
  normalizeCloneInputDraft,
  parseCloneAnalysisReport,
  parseCloneMappingDraft,
  type CloneArtifactRef,
  type CloneGenerationImage,
  type CloneGenerationSourceFile,
  type CloneUpload,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { lockCloneRun } from '../../../platform/workflow/fission-clone-scope';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { assertNoClonePropReplacement, compileCloneGenerationPlan } from './clone-generation-plan';
import { cloneConflict, requireCloneSource, validateCloneMappingAssets } from './clone-task-scope';

/** Called within the same lock as future task creation, so preflight can be repeated at enqueue. */
export async function loadCloneGenerationPlan(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  sourceMapping: CloneArtifactRef,
) {
  await lockCloneRun(tx, projectId, workflowRunId, { writable: true, nodeId: 'CLONE_GENERATION' });
  const confirmedMapping = await requireCloneSource(
    tx,
    projectId,
    workflowRunId,
    CLONE_MAPPING_ARTIFACT_KEY,
    sourceMapping,
  );
  const mapping = parseCloneMappingDraft(confirmedMapping.payload);
  assertNoClonePropReplacement(mapping);
  const analysis = await requireCloneSource(
    tx,
    projectId,
    workflowRunId,
    CLONE_ANALYSIS_ARTIFACT_KEY,
    mapping.sourceAnalysis,
  );
  const confirmedInput = await requireCloneSource(
    tx,
    projectId,
    workflowRunId,
    CLONE_INPUT_ARTIFACT_KEY,
    mapping.sourceInput,
  );
  const analysisPayload = analysis.payload as { sourceInput?: unknown; report?: unknown } | null;
  if (
    !analysisPayload?.sourceInput ||
    workflowStateHash(analysisPayload.sourceInput) !== workflowStateHash(mapping.sourceInput)
  )
    cloneConflict('确认报告与映射没有使用同一确认输入');
  const report = parseCloneAnalysisReport(analysisPayload.report);
  const inputPayload = confirmedInput.payload as { input?: unknown; files?: CloneUpload[] } | null;
  const input = normalizeCloneInputDraft(inputPayload?.input);
  const reference = confirmedInput.files.find(({ role }) => role === 'REFERENCE')?.fileObject;
  const referenceMedia = inputPayload?.files?.find(
    (file) => file.fileObjectId === reference?.id,
  )?.media;
  if (
    !reference ||
    reference.status !== 'AVAILABLE' ||
    reference.projectId !== projectId ||
    reference.workflowRunId !== workflowRunId ||
    reference.nodeId !== 'CLONE_INPUT'
  )
    cloneConflict('确认输入的参考视频文件不可用');
  if (
    referenceMedia?.durationMs !== report.durationMs ||
    referenceMedia.width !== report.frameWidth ||
    referenceMedia.height !== report.frameHeight
  )
    cloneConflict('确认报告与参考视频时长或尺寸不一致');
  if (
    (reference.mimeType !== 'video/mp4' && reference.mimeType !== 'video/quicktime') ||
    reference.sizeBytes < 1 ||
    reference.sizeBytes > CLONE_GENERATION_LIMITS.maxSourceVideoBytes
  )
    throw new TypeError('逐镜头参考仅支持不超过 200 MB 的 MP4 或 MOV 原片');
  const sourceVideo: CloneGenerationSourceFile = {
    fileObjectId: reference.id,
    sha256: reference.sha256,
    sizeBytes: reference.sizeBytes,
    mimeType: reference.mimeType,
  };
  const scopedFiles = await validateCloneMappingAssets(tx, projectId, workflowRunId, mapping);
  const featureAssets = mapping.bindings.flatMap((binding) =>
    binding.target?.asset ? [binding.target.asset] : [],
  );
  const prepared = featureAssets.length
    ? await tx.fissionCloneMappingFile.findMany({
        where: { projectId, workflowRunId, OR: featureAssets },
      })
    : [];
  const files = new Map(scopedFiles.map((file) => [file.id, file]));
  const confirmedFileIds = new Set(confirmedMapping.files.map((file) => file.fileObjectId));
  const images: CloneGenerationImage[] = [];
  for (const { assetId, version, sourceVersionId, fileObjectId, media } of prepared) {
    const file = files.get(fileObjectId);
    if (!file || !confirmedFileIds.has(fileObjectId) || file.workflowRunId !== workflowRunId)
      cloneConflict('确认映射缺少对应项目版本的文件引用');
    const mimeType = file.mimeType;
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp')
      throw new TypeError('当前生成路径只接受 JPEG、PNG 或 WebP 图片');
    const metadata = media as {
      width?: number;
      height?: number;
      durationMs?: number | null;
    } | null;
    if (
      metadata?.durationMs !== null ||
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height)
    )
      throw new TypeError('目标图片缺少有效媒体规格');
    images.push({
      assetId,
      version,
      sourceVersionId,
      fileObjectId,
      mimeType,
      width: metadata.width!,
      height: metadata.height!,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    });
  }
  return compileCloneGenerationPlan({
    projectId,
    workflowRunId,
    sources: {
      input: mapping.sourceInput!,
      analysis: mapping.sourceAnalysis!,
      mapping: sourceMapping,
    },
    input,
    report,
    mapping,
    images,
    sourceVideo,
  });
}
