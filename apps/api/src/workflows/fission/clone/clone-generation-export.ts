import { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import {
  CLONE_GENERATION_LIMITS,
  cloneBatchArtifactKey,
  type CloneArtifactRef,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import type { Prisma } from '../../../generated/prisma/client';
import type { StoragePort } from '../../../platform/file/storage.port';
import { lockCloneRun } from '../../../platform/workflow/fission-clone-scope';
import { cloneArtifactRef, cloneConflict } from './clone-task-scope';

type DeliveryEntry = CloneArtifactRef & { artifactKey: string };
type ExportEntry = DeliveryEntry & {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  freshness: 'CURRENT' | 'STALE';
  storageKey: string;
};

export async function freezeCloneBatchExport(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  batchId: string,
  revision: number,
  hash: string,
) {
  await lockCloneRun(tx, projectId, workflowRunId);
  const scope = {
    projectId,
    workflowRunId,
    nodeId: 'CLONE_GENERATION',
    availability: 'AVAILABLE' as const,
  };
  const manifest = await tx.workingArtifact.findFirst({
    where: { ...scope, type: 'DELIVERY_MANIFEST', artifactKey: cloneBatchArtifactKey(batchId) },
  });
  if (!manifest) throw new ApiHttpException('当前批次尚无可下载交付', 404, 'VALIDATION_ERROR');
  if (manifest.revision !== revision || manifest.contentHash !== hash)
    cloneConflict('成片批次版本已更新，请刷新后下载');
  const payload = manifest.payload as {
    batchId?: string;
    count?: number;
    videos?: DeliveryEntry[];
    taskId?: string;
    videoKey?: string;
  } | null;
  if (!payload) cloneConflict('成片清单的条目不完整');
  const legacyKey =
    payload.count === 1 && payload.taskId === batchId && typeof payload.videoKey === 'string'
      ? payload.videoKey
      : null;
  const refs = payload.batchId === batchId && Array.isArray(payload.videos) ? payload.videos : [];
  const keys = legacyKey ? [legacyKey] : refs.map((item) => item?.artifactKey);
  if (
    !keys.length ||
    keys.length !== payload.count ||
    keys.length > CLONE_GENERATION_LIMITS.maxCount ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => typeof key !== 'string' || !key.startsWith('clone-video:'))
  )
    cloneConflict('成片清单的条目不完整');
  const videos = await tx.workingArtifact.findMany({
    where: { ...scope, type: 'FINAL_VIDEO', artifactKey: { in: keys } },
    include: { files: { where: { role: 'FINAL_VIDEO' }, include: { fileObject: true } } },
  });
  const byKey = new Map(videos.map((video) => [video.artifactKey, video]));
  const entries = keys.map((key, index): ExportEntry => {
    const video = byKey.get(key);
    const file = video?.files[0]?.fileObject;
    const expected = refs[index];
    if (
      !video ||
      !file ||
      video.files.length !== 1 ||
      file.projectId !== projectId ||
      file.workflowRunId !== workflowRunId ||
      file.nodeId !== 'CLONE_GENERATION' ||
      file.status !== 'AVAILABLE' ||
      file.mimeType !== 'video/mp4' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.sizeBytes <= 0 ||
      (legacyKey
        ? video.revision !== 1
        : !expected ||
          video.id !== expected.artifactId ||
          video.revision !== expected.revision ||
          video.contentHash !== expected.contentHash)
    )
      cloneConflict('成片文件与已交付版本不一致，请刷新后下载');
    return {
      ...cloneArtifactRef(video),
      artifactKey: key,
      fileName: `videos/${String(index + 1).padStart(2, '0')}.mp4`,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      freshness: video.freshness,
      storageKey: file.storageKey,
    };
  });
  return { batchId, manifest: cloneArtifactRef(manifest), entries };
}

export function streamCloneBatch(
  storage: StoragePort,
  batch: Awaited<ReturnType<typeof freezeCloneBatchExport>>,
) {
  const archive = new ZipArchive({ store: true });
  const current = new Set<Readable>();
  archive.once('close', () => {
    for (const stream of current) stream.destroy();
  });
  archive.append(
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          batchId: batch.batchId,
          manifest: batch.manifest,
          videos: batch.entries.map(({ storageKey: _storageKey, ...entry }) => entry),
        },
        null,
        2,
      ),
      'utf8',
    ),
    { name: 'manifest.json' },
  );
  for (const entry of batch.entries) {
    const input = Readable.from(
      (async function* () {
        const opened = await storage.open(entry.storageKey);
        try {
          if (opened.contentLength !== entry.sizeBytes) throw new Error('成片文件长度已变化');
          yield* opened.stream;
        } finally {
          opened.stream.destroy();
        }
      })(),
    );
    current.add(input);
    input.once('close', () => current.delete(input));
    input.once('error', (error) => archive.destroy(error));
    archive.append(input, { name: entry.fileName, store: true });
  }
  return archive;
}
