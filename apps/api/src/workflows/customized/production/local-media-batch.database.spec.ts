import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  buildVideoSourceUnits,
  DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as settings,
  type ProductionVideoDocument,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'recovers batch progress from saved single-clip results across refresh and recent-task limits',
  async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))
      throw new Error('This controlled fixture requires a local database');
    const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    const p = randomUUID(),
      other = randomUUID(),
      scriptId = randomUUID();
    const working = new WorkflowWorkingRepository(db),
      repo = new ProductionRepository(db, working);
    const enqueue = vi
      .spyOn(repo as unknown as { enqueue(...args: unknown[]): Promise<unknown> }, 'enqueue')
      .mockResolvedValue({});
    try {
      await db.project.createMany({
        data: [
          { id: p, name: '受控批次恢复验证' },
          { id: other, name: '批次隔离验证' },
        ],
      });
      const r = (await working.initializeCustomizedRun(p)).id;
      const sibling = await db.workflowRun.create({
        data: {
          projectId: p,
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          activeKey: null,
          forkScriptId: scriptId,
        },
      });
      const otherRun = await working.initializeCustomizedRun(other);
      await db.workflowRun.update({ where: { id: r }, data: { forkScriptId: scriptId } });
      const fixture = JSON.parse(
        readFileSync(
          resolve(
            __dirname,
            '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
          ),
          'utf8',
        ),
      ) as {
        scriptText: string;
        document: ProductionVideoDocument;
      };
      const script = {
        id: scriptId,
        name: '一杯清晨',
        synopsis: '阅读日常',
        structure: 'AI编排',
        productFocus: '陶瓷杯',
        shots: [],
        assets: [],
        story: {
          content: fixture.scriptText,
          opening: '拿杯',
          development: '阅读',
          ending: '定版',
          dialoguePlan: '旁白',
          beats: [{ id: 'P1', content: fixture.scriptText, durationSeconds: 10 }],
        },
      };
      for (const [artifactKey, payload, nodeId] of [
        [`customized-script:${scriptId}`, script, 'STORYBOARD'],
        [
          'customized-brief',
          { productName: '陶瓷杯', sellingPoints: ['陶瓷'] },
          'INFORMATION_EXTRACTION',
        ],
        ['customized-asset-catalog', { assets: fixture.document.assets }, 'SHOT_PROMPT'],
      ] as [string, object, string][]) {
        await db.workingArtifact.create({
          data: {
            projectId: p,
            workflowRunId: r,
            artifactKey,
            name: artifactKey,
            nodeId,
            kind: 'STRUCTURED',
            directory: 'SCRIPTS',
            type: 'STORYBOARD_SCRIPT',
            payload,
            contentHash: workflowStateHash(payload),
          },
        });
      }
      fixture.document.videoPlan.sourceUnits = buildVideoSourceUnits(fixture.scriptText);
      fixture.document.videoPlan.sources = (
        await db.workingArtifact.findMany({ where: { projectId: p } })
      ).map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash }));
      await repo.save(p, r, 0, fixture.document, 'SHOTS', true);
      await repo.savePrompt(p, r, 0, {
        target: { kind: 'CLIP', id: 'clip-a' },
        content: '陶瓷杯的特写。',
        assetIds: [],
      });
      const batchKey = randomUUID(),
        originalTime = new Date(Date.now() - 120000);
      const failed = await Promise.all(
        ['clip-a', 'clip-b'].map((id) =>
          db.customizedProductionTask.create({
            data: {
              projectId: p,
              workflowRunId: r,
              operation: 'RENDER',
              idempotencyKey: randomUUID(),
              status: 'FAILED',
              steps: [],
              errorMessage: '受控参考图拒绝',
              createdAt: originalTime,
              inputSnapshot: {
                target: { kind: 'CLIP', id },
                incremental: { version: 1, batchKey, targetIds: ['clip-a', 'clip-b'] },
                videoRender: {
                  references: [
                    { objectId: 'cup', name: '陶瓷杯', assetId: randomUUID(), version: 1 },
                  ],
                },
              },
            },
          }),
        ),
      );
      const w = await repo.workspace(p, r);
      expect(w.localMediaBatch?.items.filter((i) => i.status === 'FAILED')).toHaveLength(2);
      const args = {
        target: { kind: 'CLIP' as const, id: 'clip-a' },
        render: { settings, model: 'controlled-seedance' },
      };
      const models = { creative: 'controlled', detail: 'controlled' };
      const files = {
        video: { storageKey: `test/${p}/video`, sizeBytes: 100, sha256: 'a'.repeat(64) },
        poster: { storageKey: `test/${p}/poster`, sizeBytes: 50, sha256: 'b'.repeat(64) },
      };
      const info = { durationSeconds: 10.04, width: 1280, height: 720 };
      const complete = async (key: string) => {
        const task = await repo.start(
          p,
          r,
          w.draftRevision,
          'RENDER',
          key,
          null,
          models,
          null,
          undefined,
          args,
        );
        const claim = await repo.claim(p, task.id, 'VIDEO');
        await repo.checkpoint(
          p,
          task.id,
          claim.attemptToken!,
          { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '受控供应商任务' },
          { providerTaskId: key, createStarted: true },
          'VIDEO',
        );
        await repo.acceptVideo(p, task.id, claim.attemptToken!, info, files);
        return task;
      };
      const saved = await complete('controlled-first');
      let refreshed = await repo.workspace(p, r);
      expect(refreshed.localMediaBatch?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetId: 'clip-a', taskId: saved.id, status: 'COMPLETED' }),
          expect.objectContaining({ targetId: 'clip-b', status: 'FAILED' }),
        ]),
      );
      const revision = refreshed.videos![0]!.revision;
      const dedup = await complete('controlled-same-file');
      refreshed = await repo.workspace(p, r);
      expect(refreshed.localMediaBatch?.items.find((i) => i.targetId === 'clip-a')?.taskId).toBe(
        dedup.id,
      );
      expect(refreshed.videos![0]!.revision).toBe(revision);
      // Newer successes in sibling runs and projects cannot resolve clip-b here.
      await db.customizedProductionTask.createMany({
        data: [
          { projectId: p, workflowRunId: sibling.id },
          { projectId: other, workflowRunId: otherRun.id },
        ].map((scope) => ({
          ...scope,
          operation: 'RENDER',
          status: 'COMPLETED',
          idempotencyKey: randomUUID(),
          steps: [],
          inputSnapshot: { target: { kind: 'CLIP', id: 'clip-b' } },
        })),
      });
      // Standalone history pushes both the original batch and its replacements past take:30.
      await db.customizedProductionTask.createMany({
        data: Array.from({ length: 35 }, (_, n) => ({
          projectId: p,
          workflowRunId: r,
          operation: 'PROMPT',
          status: 'COMPLETED',
          idempotencyKey: randomUUID(),
          steps: [],
          createdAt: new Date(Date.now() + n),
          inputSnapshot: { target: { kind: 'CLIP', id: 'unrelated' } },
        })),
      });
      refreshed = await repo.workspace(p, r);
      expect(refreshed.localMediaBatch?.key).toBe(batchKey);
      expect(refreshed.localMediaBatch?.items).toHaveLength(2);
      expect(refreshed.localMediaBatch?.items.find((i) => i.targetId === 'clip-a')?.status).toBe(
        'COMPLETED',
      );
      expect(refreshed.localMediaBatch?.items.find((i) => i.targetId === 'clip-b')?.status).toBe(
        'FAILED',
      );
      expect(refreshed.tasks.find((t) => t.id === failed[1]!.id)?.renderReferences).toHaveLength(1);
      expect(refreshed.tasks.some((t) => t.id === dedup.id)).toBe(true);
      expect(
        await db.customizedProductionTask.count({
          where: { id: { in: failed.map((t) => t.id) }, status: 'FAILED' },
        }),
      ).toBe(2);
      await db.workingArtifact.updateMany({
        where: { projectId: p, workflowRunId: r, artifactKey: 'customized-clip-video:clip-a' },
        data: { freshness: 'STALE' },
      });
      expect(
        (await repo.workspace(p, r)).localMediaBatch?.items.find((i) => i.targetId === 'clip-a')
          ?.status,
      ).toBe('STALE');
      expect((await repo.videoFile(p, r, 'clip-a')).sha256).toBe(files.video.sha256);
    } finally {
      enqueue.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: { in: [p, other] } } });
      await db.$disconnect();
    }
  },
  30000,
);
