import type {
  ProductionDocument,
  ProductionInput,
  CustomizedVideoResult,
} from '@ai-marketing/contracts';
import {
  isVideoDocument,
  videoPromptReferences,
  resolveCustomizedAssetImageSource,
} from '@ai-marketing/contracts';
import type { Prisma, WorkingArtifact } from '../../../generated/prisma/client';
import { workingArtifactContentHash } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { lockCustomizedProject } from '../../../platform/workflow/customized-branches';
import { clipPayload } from './video-production.domain';
type Tx = Prisma.TransactionClient;
const equal = (a: unknown, b: unknown) => workflowStateHash(a) === workflowStateHash(b);
function visibleClip(value: unknown) {
  const payload = JSON.parse(JSON.stringify(value)) as {
    shots?: Record<string, unknown>[];
    cues?: Record<string, unknown>[];
  };
  payload.shots?.forEach((s) => delete s.sourceEventIds);
  payload.cues?.forEach((c) => delete c.sourceRef);
  return payload;
}
export const artifactDependency = (a: WorkingArtifact) => ({
  sourceType: 'WORKING_ARTIFACT' as const,
  sourceArtifactId: a.id,
  sourceNodeId: a.nodeId,
  sourceKey: a.artifactKey,
  sourceRevision: a.revision,
  sourceHash: a.contentHash,
});
/** Caller supplies an independently validated, byte-identical business payload. No content revision. */
export async function rebindUnchanged(
  tx: Tx,
  p: string,
  r: string,
  id: string,
  sources: WorkingArtifact[],
  metadata?: Prisma.InputJsonValue,
) {
  await lockCustomizedProject(tx, p);
  const row = await tx.workingArtifact.findFirst({
    where: { projectId: p, workflowRunId: r, id, availability: 'AVAILABLE' },
    include: { files: { include: { fileObject: true } } },
  });
  if (
    !row ||
    sources.some(
      (s) =>
        s.projectId !== p ||
        s.workflowRunId !== r ||
        s.freshness !== 'CURRENT' ||
        s.availability !== 'AVAILABLE',
    )
  )
    throw new Error('UNCHANGED_SOURCE_INVALID');
  if (row.files.some((f) => f.fileObject.status !== 'AVAILABLE'))
    throw new Error('UNCHANGED_FILE_UNAVAILABLE');
  const heads = await tx.workingArtifact.findMany({
    where: {
      projectId: p,
      workflowRunId: r,
      id: { in: sources.map((s) => s.id) },
      availability: 'AVAILABLE',
      freshness: 'CURRENT',
    },
  });
  if (
    new Set(sources.map((s) => s.id)).size !== sources.length ||
    sources.some(
      (s) =>
        !heads.some(
          (h) => h.id === s.id && h.revision === s.revision && h.contentHash === s.contentHash,
        ),
    )
  )
    throw new Error('UNCHANGED_SOURCE_CHANGED');
  const dependencies = sources.map(artifactDependency);
  const input = {
    kind: row.kind,
    name: row.name,
    directory: row.directory,
    type: row.type,
    tags: row.tags,
    payload: row.payload,
    metadata: metadata ?? row.metadata,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    fileChecksum: row.files.find((f) => f.role === 'PRIMARY')?.fileObject.sha256 ?? null,
    files: row.files.map((f) => ({
      fileObjectId: f.fileObjectId,
      role: f.role,
      sortOrder: f.sortOrder,
      originalFileName: f.fileObject.originalFileName,
      mimeType: f.fileObject.mimeType,
      sha256: f.fileObject.sha256,
    })),
    dependencies,
  };
  await tx.workingArtifactDependency.deleteMany({
    where: { projectId: p, dependentArtifactId: id },
  });
  if (dependencies.length)
    await tx.workingArtifactDependency.createMany({
      data: dependencies.map((d) => ({
        ...d,
        projectId: p,
        workflowRunId: r,
        dependentArtifactId: id,
      })),
    });
  return tx.workingArtifact.update({
    where: { id },
    data: {
      contentHash: workingArtifactContentHash(input),
      freshness: 'CURRENT',
      updatedAt: row.updatedAt,
      ...(metadata ? { metadata } : {}),
    },
  });
}
/** Only exact local clip content and exact provider inputs prove old media reusable. */
export async function reconcileUnchangedMedia(
  tx: Tx,
  p: string,
  r: string,
  document: ProductionDocument,
  before: WorkingArtifact[],
) {
  if (!isVideoDocument(document)) return;
  let current = await tx.workingArtifact.findMany({
    where: { projectId: p, workflowRunId: r, availability: 'AVAILABLE' },
    include: { dependencies: true },
  });
  for (const clip of document.videoPlan.clips) {
    const oldClip = before.find((a) => a.artifactKey === `customized-video-clip:${clip.id}`),
      nowClip = current.find((a) => a.artifactKey === `customized-video-clip:${clip.id}`);
    if (
      !oldClip ||
      !nowClip ||
      nowClip.freshness !== 'CURRENT' ||
      !equal(visibleClip(oldClip.payload), visibleClip(clipPayload(document, clip.id)))
    )
      continue;
    const prompt = current.find((a) => a.artifactKey === `customized-clip-prompt:${clip.id}`),
      oldPrompt = before.find((a) => a.artifactKey === `customized-clip-prompt:${clip.id}`);
    if (!prompt || !oldPrompt || !equal(prompt.payload, oldPrompt.payload)) continue;
    // A stale prompt from an earlier edit is never adopted merely because this update is small.
    const dependency = prompt.dependencies.find((d) => d.sourceArtifactId === oldClip.id);
    if (
      prompt.freshness !== 'CURRENT' &&
      (!dependency ||
        dependency.sourceRevision !== oldClip.revision ||
        dependency.sourceHash !== oldClip.contentHash)
    )
      continue;
    await rebindUnchanged(tx, p, r, prompt.id, [nowClip]);
    current = await tx.workingArtifact.findMany({
      where: { projectId: p, workflowRunId: r, availability: 'AVAILABLE' },
      include: { dependencies: true },
    });
    const video = current.find((a) => a.artifactKey === `customized-clip-video:${clip.id}`),
      oldVideo = before.find((a) => a.artifactKey === `customized-clip-video:${clip.id}`);
    if (!video || !oldVideo || !equal(video.payload, oldVideo.payload)) continue;
    const value = video.payload as unknown as CustomizedVideoResult;
    const task = await tx.customizedProductionTask.findFirst({
      where: { projectId: p, id: value.taskId, operation: 'RENDER', status: 'COMPLETED' },
    });
    const input = task?.inputSnapshot as unknown as ProductionInput | undefined,
      render = input?.videoRender;
    const currentPrompt = current.find((a) => a.id === prompt.id)!;
    const text = (currentPrompt.payload as { content?: string }).content;
    if (
      !render ||
      render.clipId !== clip.id ||
      text !== render.prompt ||
      !equal(render.settings, value.settings) ||
      render.seconds !==
        document.videoPlan.shots
          .filter((s) => clip.shotIds.includes(s.id))
          .reduce((n, s) => n + s.durationSeconds, 0)
    )
      continue;
    const refs = videoPromptReferences(text, document.assets).assetIds;
    if (
      refs.length !== render.references.length ||
      render.references.some((ref) => !refs.includes(ref.objectId))
    )
      continue;
    let valid = true;
    for (const ref of render.references) {
      const owner = resolveCustomizedAssetImageSource(document.assets, ref.objectId);
      if (
        !owner.ok ||
        owner.source.image?.assetId !== ref.assetId ||
        owner.source.image?.version !== ref.version
      ) {
        valid = false;
        break;
      }
      const file = await tx.fileObject.findFirst({
        where: {
          projectId: p,
          storageKey: ref.storageKey,
          status: 'AVAILABLE',
          sha256: ref.sha256,
          sizeBytes: ref.sizeBytes,
        },
      });
      const version = await tx.assetVersion.findFirst({
        where: {
          projectId: p,
          assetId: ref.assetId,
          version: ref.version,
          storageKey: ref.storageKey,
          status: { not: 'UNAVAILABLE' },
          asset: {
            archivedAt: null,
            storageWorkflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
          },
        },
      });
      if (!file || !version) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const originals = await tx.workingArtifact.findMany({
      where: { projectId: p, id: { in: input!.sources.map((s) => s.id) } },
    });
    const sourceRows = input!.sources.map(
      (s) =>
        current.find((a) => a.id === s.id) ??
        current.find((a) => a.artifactKey === originals.find((v) => v.id === s.id)?.artifactKey),
    );
    if (sourceRows.some((a) => !a || a.freshness !== 'CURRENT')) continue;
    // The render is proven identical; rebind only its existing source identities in this Run.
    await rebindUnchanged(
      tx,
      p,
      r,
      video.id,
      sourceRows.filter((a): a is NonNullable<typeof a> => !!a),
    );
  }
}
