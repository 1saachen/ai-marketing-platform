import {
  CLONE_ANALYSIS_ARTIFACT_KEY,
  CLONE_INPUT_ARTIFACT_KEY,
  CLONE_PROP_IMAGE_MIME_TYPES,
  validateCloneMappingForReport,
  parseCloneAnalysisDraft,
  parseCloneMappingDraft,
  type CloneAnalysisDraft,
  type CloneAnalysisReport,
  type CloneArtifactRef,
  type CloneMappingDraft,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { ApiHttpException } from '../../../common/api-http-exception';
import { assertNoClonePropReplacement } from './clone-generation-plan';

export function cloneConflict(message: string): never {
  throw new ApiHttpException(message, 409, 'CONFLICT');
}

export async function assertNoActiveCloneTasks(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  allowedGenerationParentId?: string | null,
) {
  if (
    await tx.fissionCloneTask.count({
      where: {
        projectId,
        workflowRunId,
        status: { in: ['QUEUED', 'RUNNING'] },
        ...(allowedGenerationParentId && {
          OR: [
            { generationParentId: null },
            { generationParentId: { not: allowedGenerationParentId } },
          ],
        }),
      },
    })
  )
    cloneConflict('复刻任务正在使用已确认来源，请先等待完成或取消任务；编辑草稿仍可保存');
}

export const cloneArtifactRef = (artifact: {
  id: string;
  revision: number;
  contentHash: string;
}): CloneArtifactRef => ({
  artifactId: artifact.id,
  revision: artifact.revision,
  contentHash: artifact.contentHash,
});

export async function requireCloneSource(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  key: string,
  ref: CloneArtifactRef | null,
) {
  const artifact = await tx.workingArtifact.findFirst({
    where: { projectId, workflowRunId, artifactKey: key },
    include: { files: { include: { fileObject: true }, orderBy: { sortOrder: 'asc' } } },
  });
  if (
    !ref ||
    !artifact ||
    artifact.id !== ref.artifactId ||
    artifact.revision !== ref.revision ||
    artifact.contentHash !== ref.contentHash ||
    artifact.freshness !== 'CURRENT' ||
    artifact.availability !== 'AVAILABLE'
  )
    cloneConflict('已确认来源已变化或不可用，请重新加载最新输入与报告');
  return artifact;
}

export async function validateCloneMappingAssets(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  mapping: CloneMappingDraft,
) {
  const files = [];
  for (const binding of mapping.bindings) {
    const target = binding.target?.asset;
    if (!target) continue;
    const version = await tx.assetVersion.findFirst({
      where: {
        projectId,
        assetId: target.assetId,
        version: target.version,
        status: 'AVAILABLE',
        asset: { archivedAt: null, status: 'AVAILABLE', hasFile: true },
      },
      include: { asset: true },
    });
    const prepared = await tx.fissionCloneMappingFile.findUnique({
      where: { projectId_workflowRunId_assetId_version: { projectId, workflowRunId, ...target } },
      include: { fileObject: true },
    });
    if (
      !version ||
      !prepared ||
      prepared.sourceVersionId !== version.id ||
      prepared.fileObject.status !== 'AVAILABLE' ||
      prepared.fileObject.sizeBytes !== version.sizeBytes
    )
      cloneConflict('映射资产版本不可用或尚未准备，请重新选择当前项目资产');
    // Use the inspected scoped copy, including normalized UTF-8 subtitle MIME.
    const mime = prepared.fileObject.mimeType;
    const visual = ['product', 'person', 'scene'].includes(binding.type);
    const audio = ['bgm', 'voiceover'].includes(binding.type);
    if (
      (visual && !/^(image|video)\//.test(mime)) ||
      (binding.type === 'prop' && !CLONE_PROP_IMAGE_MIME_TYPES.includes(mime)) ||
      (audio && !mime.startsWith('audio/')) ||
      (binding.type === 'subtitle' &&
        !['text/plain', 'text/vtt', 'application/x-subrip'].includes(mime))
    )
      throw new ApiHttpException('映射目标文件类型与元素不匹配', 400, 'VALIDATION_ERROR');
    files.push(prepared.fileObject);
  }
  return [...new Map(files.map((file) => [file.id, file])).values()];
}

/** Shared by the generic node-state writer and the domain draft endpoint. No external IO. */
export async function validateCloneG2DraftInTransaction(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  value: unknown,
): Promise<CloneAnalysisDraft | CloneMappingDraft> {
  try {
    if (nodeId === 'CLONE_ANALYSIS') {
      const state = parseCloneAnalysisDraft(value);
      if (state.sourceInput)
        await requireCloneSource(
          tx,
          projectId,
          workflowRunId,
          CLONE_INPUT_ARTIFACT_KEY,
          state.sourceInput,
        );
      if (state.report && !state.sourceInput) cloneConflict('报告草稿缺少已确认输入来源');
      return state;
    }
    if (nodeId !== 'CLONE_MAPPING') throw new TypeError('复刻节点不支持此草稿');
    const state = parseCloneMappingDraft(value);
    if (state.sourceInput)
      await requireCloneSource(
        tx,
        projectId,
        workflowRunId,
        CLONE_INPUT_ARTIFACT_KEY,
        state.sourceInput,
      );
    if (state.sourceAnalysis) {
      const analysis = await requireCloneSource(
        tx,
        projectId,
        workflowRunId,
        CLONE_ANALYSIS_ARTIFACT_KEY,
        state.sourceAnalysis,
      );
      const payload = analysis.payload as unknown as { report: CloneAnalysisReport };
      validateCloneMappingForReport(state, payload.report);
    }
    if (
      (state.bindings.length || state.structureLock) &&
      (!state.sourceInput || !state.sourceAnalysis)
    )
      cloneConflict('映射草稿缺少当前输入或报告来源');
    await validateCloneMappingAssets(tx, projectId, workflowRunId, state);
    return state;
  } catch (error) {
    if (error instanceof ApiHttpException) throw error;
    throw new ApiHttpException('复刻编辑草稿格式不正确', 400, 'VALIDATION_ERROR');
  }
}

export function validateCloneMappingConfirmation(
  mapping: CloneMappingDraft,
  report: CloneAnalysisReport,
) {
  try {
    assertNoClonePropReplacement(mapping);
    validateCloneMappingForReport(mapping, report, true);
  } catch (error) {
    throw new ApiHttpException(
      error instanceof Error ? error.message : '元素映射不完整',
      400,
      'VALIDATION_ERROR',
    );
  }
  return mapping.bindings
    .filter((item) => item.target?.contentStrategy === 'KEEP')
    .map((item) => item.elementId);
}
