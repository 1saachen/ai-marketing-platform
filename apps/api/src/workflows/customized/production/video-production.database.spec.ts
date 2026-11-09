import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { it, expect, vi } from 'vitest';
import {
  type ProductionVideoDocument,
  type ProductionInput,
  type ProductionTask,
  type VideoAudit,
  isVideoDocument,
  mergeVideoTaskShots,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';
import { videoHash } from './video-production.domain';
import { reusableLocalShotReview } from './local-shot-review-recovery';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'V2 persists only drafts, confirms clip dependencies, rejects old callbacks and preserves sibling scope',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const p = randomUUID(),
      other = randomUUID(),
      scriptId = randomUUID(),
      working = new WorkflowWorkingRepository(db),
      repo = new ProductionRepository(db, working);
    const outbox = vi
      .spyOn(repo as unknown as { enqueue(...args: unknown[]): Promise<unknown> }, 'enqueue')
      .mockResolvedValue({ id: randomUUID() });
    try {
      await db.project.createMany({
        data: [
          { id: p, name: 'V2制作隔离测试' },
          { id: other, name: 'V2跨项目隔离' },
        ],
      });
      const run = await working.initializeCustomizedRun(p),
        r = run.id;
      const f = JSON.parse(
        readFileSync(
          resolve(
            __dirname,
            '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
          ),
          'utf8',
        ),
      ) as { scriptText: string; document: ProductionVideoDocument };
      await db.workflowRun.update({ where: { id: r }, data: { forkScriptId: scriptId } });
      const script = {
        id: scriptId,
        name: '一杯清晨',
        synopsis: '阅读日常',
        structure: 'AI编排',
        productFocus: '陶瓷杯',
        shots: [],
        assets: [],
        story: {
          content: f.scriptText,
          opening: '拿杯',
          development: '阅读',
          ending: '定版',
          dialoguePlan: '旁白',
          beats: [{ id: 'P1', content: f.scriptText, durationSeconds: 10 }],
        },
      };
      for (const [key, payload, node] of [
        [`customized-script:${scriptId}`, script, 'STORYBOARD'],
        [
          'customized-brief',
          { productName: '陶瓷杯', sellingPoints: ['陶瓷'] },
          'INFORMATION_EXTRACTION',
        ],
        ['customized-asset-catalog', { assets: f.document.assets }, 'SHOT_PROMPT'],
        ...f.document.assets.map((a) => [`customized-object:${a.id}`, a, 'SHOT_PROMPT']),
      ] as [string, unknown, string][]) {
        await db.workingArtifact.create({
          data: {
            projectId: p,
            workflowRunId: r,
            nodeId: node,
            artifactKey: key,
            name: key,
            kind: 'STRUCTURED',
            directory: 'SCRIPTS',
            type: 'STORYBOARD_SCRIPT',
            payload: payload as object,
            contentHash: workflowStateHash(payload),
          },
        });
      }
      const models = { creative: 'controlled', detail: 'controlled' };
      const task = await repo.start(p, r, 0, 'SHOTS', 'once', null, models, null, undefined, {
        version: 2,
      });
      expect(task.shotWorkflowVersion).toBe(2);
      expect(
        (await repo.start(p, r, 0, 'SHOTS', 'once', null, models, null, undefined, { version: 2 }))
          .id,
      ).toBe(task.id);
      await expect(repo.getTask(other, task.id)).rejects.toThrow();
      const claim = await repo.claim(p, task.id, 'VIDEO'),
        input = claim.input as unknown as ProductionInput;
      expect(input.sources).toHaveLength(3);
      const d = structuredClone(f.document);
      d.videoPlan = mergeVideoTaskShots(d.videoPlan, 'clip-a');
      Object.assign(d.videoPlan, {
        sources: input.sources,
        sourceUnits: input.sourceUnits,
        durationPolicy: input.durationPolicy,
        capability: input.renderCapability,
      });
      const audit: VideoAudit = {
        summary: '受控内容逐项核对',
        checks: [
          '原稿兑现',
          '时间容量',
          '镜头表达',
          '产品事实',
          '动作与空间',
          '素材绑定',
          '模型能力',
        ].map((dimension) => ({ dimension, conclusion: '实际内容已核对' })),
        findings: [],
        resolutions: [],
      };
      const saved = { value: d, final: d, audit, auditHash: videoHash(d.videoPlan) };
      const finish = async (
        t: ProductionTask,
        token: string,
        output: unknown,
        checkpoint: unknown,
      ) => {
        for (const s of t.steps.filter((s) => s.id !== 'SAVE'))
          await repo.checkpoint(
            p,
            t.id,
            token,
            { ...s, status: 'SUCCEEDED', content: '受控真实结构' },
            checkpoint,
            'VIDEO',
          );
        await repo.complete(p, t.id, token, output, 'VIDEO');
      };
      await finish(task, claim.attemptToken!, d, saved);
      let w = await repo.workspace(p, r);
      expect(w.shotsConfirmed).toBe(false);
      expect(isVideoDocument(w.document)).toBe(true);
      expect(
        await db.workingArtifact.count({
          where: { projectId: p, artifactKey: { startsWith: 'customized-video-clip:' } },
        }),
      ).toBe(0);
      let revision = (await repo.save(p, r, w.draftRevision, d, 'SHOTS', true)).revision;
      w = await repo.workspace(p, r);
      expect(w.shotsConfirmed).toBe(true);
      const clips = await db.workingArtifact.findMany({
        where: { projectId: p, artifactKey: { startsWith: 'customized-video-clip:' } },
      });
      expect(clips).toHaveLength(2);
      await repo.save(p, r, revision, d, 'SHOTS', true);
      expect(
        (
          await db.workingArtifact.findMany({
            where: { projectId: p, artifactKey: { startsWith: 'customized-video-clip:' } },
          })
        ).map((a) => a.revision),
      ).toEqual(clips.map((a) => a.revision));
      const promptTask = await repo.start(
          p,
          r,
          revision,
          'PROMPT',
          'clip-prompt',
          null,
          models,
          null,
          undefined,
          { version: 2, target: { kind: 'CLIP', id: 'clip-a' } },
        ),
        pc = await repo.claim(p, promptTask.id, 'VIDEO');
      expect(promptTask.promptWorkflowVersion).toBe(3);
      const branchCount = await db.workflowRun.count({ where: { projectId: p } });
      const prompt = {
        target: { kind: 'CLIP' as const, id: 'clip-a' },
        content: '产品：@陶瓷杯；场景：@阅读室。完整原句按分镜连续表达。',
        assetIds: ['cup', 'room'],
      };
      await finish(promptTask, pc.attemptToken!, prompt, {
        value: prompt,
        final: prompt,
        audit: { ...audit, promptEvidence: [] },
        auditHash: videoHash(prompt),
      });
      w = await repo.workspace(p, r);
      expect(
        w.prompts.some((a) => 'target' in a.value && a.value.target.id === 'clip-a' && !a.stale),
      ).toBe(true);
      expect(await db.workflowRun.count({ where: { projectId: p } })).toBe(branchCount);
      expect((await repo.latestPromptTask(p, r, 'clip-a'))?.id).toBe(promptTask.id);
      expect(await repo.latestPromptTask(p, r, 'clip-b')).toBeNull();
      await expect(repo.latestPromptTask(other, r, 'clip-a')).rejects.toThrow();
      await repo.complete(p, promptTask.id, pc.attemptToken!, prompt, 'VIDEO');
      expect(await db.workflowRun.count({ where: { projectId: p } })).toBe(branchCount);
      const manualPrompt = { ...prompt, content: '@陶瓷杯近景', assetIds: ['cup'] };
      await expect(
        repo.savePrompt(p, r, 1, { ...manualPrompt, assetIds: ['cup', 'room'] }),
      ).rejects.toThrow();
      await repo.savePrompt(p, r, 1, manualPrompt);
      await repo.savePrompt(p, r, 2, manualPrompt);
      expect((await repo.workspace(p, r)).prompts[0]?.revision).toBe(2);
      expect(await db.workflowRun.count({ where: { projectId: p } })).toBe(branchCount);
      // A local storyboard update confirms its own result even if the page never polls.
      await db.workingArtifact.update({
        where: {
          id: clips.find((clip) => clip.artifactKey === 'customized-video-clip:clip-b')!.id,
        },
        data: { freshness: 'STALE' },
      });
      const shotPreview = await repo.preview(p, r, 'SHOTS');
      expect(shotPreview.items.map((item) => item.id)).toEqual(['clip-b']);
      const [local] = await repo.startUpdates(
        p,
        r,
        'SHOTS',
        { version: 1, fingerprint: shotPreview.fingerprint },
        randomUUID(),
        models,
        {},
      );
      const localClaim = await repo.claim(p, local!.id, 'VIDEO');
      const updated = structuredClone(d);
      updated.videoPlan.shots.find((s) => s.id === 'shot-c')!.visual =
        '杯身正面保持可见，光线略微抬亮';
      const changes = [{ clipId: 'clip-b', reason: '更新定版镜头光线' }];
      const localAudit: VideoAudit = {
        ...audit,
        findings: [
          {
            id: 'reference-warning',
            severity: 'WARNING',
            category: 'CAPACITY',
            title: '时长与参考值有差异',
            impact: '已保留确认过的镜头时长',
            evidence: [{ entity: 'TIMING', id: 'durationPolicy', field: 'seconds' }],
            affectedClipIds: ['clip-b'],
            affectedShotIds: ['shot-c'],
            suggestedFix: '保留本次分镜时长',
            repairKind: 'INPUT',
          },
        ],
      };
      const savedLocal = {
        value: updated,
        final: updated,
        audit: localAudit,
        auditHash: videoHash(updated.videoPlan),
        changes,
        localCandidate: { plan: updated.videoPlan, changes },
        failureReason: 'REVIEW_UNRESOLVED',
      };
      await repo.checkpoint(
        p,
        local!.id,
        localClaim.attemptToken!,
        { id: 'REVIEW', status: 'FAILED', title: '审校', content: '保留候选和审校结果' },
        savedLocal,
        'VIDEO',
      );
      await repo.fail(p, local!.id, localClaim.attemptToken!, false, 'VIDEO');
      expect((await repo.getTask(p, local!.id)).localStoryboard?.reviewAvailable).toBe(true);
      const localInput = localClaim.input as unknown as ProductionInput;
      expect(
        reusableLocalShotReview(localInput, localInput, { ...savedLocal, auditHash: 'different' }),
      ).toBeNull();
      expect(
        reusableLocalShotReview(
          { ...localInput, draftRevision: localInput.draftRevision + 1 },
          localInput,
          savedLocal,
        ),
      ).toBeNull();
      expect(
        reusableLocalShotReview(
          { ...localInput, incremental: { ...localInput.incremental!, targetIds: ['clip-a'] } },
          localInput,
          savedLocal,
        ),
      ).toBeNull();
      const [resumed] = await repo.startUpdates(
        p,
        r,
        'SHOTS',
        { version: 1, fingerprint: shotPreview.fingerprint },
        randomUUID(),
        models,
        {},
      );
      const resumedClaim = await repo.claim(p, resumed!.id, 'VIDEO');
      expect(resumedClaim.output).toMatchObject({
        localCandidate: savedLocal.localCandidate,
        audit: localAudit,
        auditHash: savedLocal.auditHash,
      });
      const { failureReason: _, ...validatedLocal } = savedLocal;
      await finish(resumed!, resumedClaim.attemptToken!, updated, validatedLocal);
      w = await repo.workspace(p, r);
      expect(w.shotsConfirmed).toBe(true);
      expect(w.confirmedDocument).toEqual(updated);
      expect(w.document).toEqual(w.confirmedDocument);
      expect(w.prompts[0]).toMatchObject({ revision: 2, stale: false });
      expect((await repo.preview(p, r, 'SHOTS')).items).toEqual([]);
      expect(await db.workflowRun.count({ where: { projectId: p } })).toBe(branchCount);
      await repo.complete(p, resumed!.id, resumedClaim.attemptToken!, updated, 'VIDEO');
      await expect(
        repo.complete(p, local!.id, localClaim.attemptToken!, updated, 'VIDEO'),
      ).rejects.toThrow();
      expect((await repo.workspace(p, r)).draftRevision).toBe(w.draftRevision);
      // Unrelated clip edit does not stale clip-a's prompt.
      d.videoPlan.shots.find((s) => s.id === 'shot-c')!.visual = '独立产品定版中杯身略向右侧';
      revision = (await repo.save(p, r, w.draftRevision, d, 'SHOTS', true)).revision;
      expect((await repo.workspace(p, r)).prompts[0]!.stale).toBe(false);
      d.videoPlan.shots[0]!.visual = '拿杯时明确左手持杯';
      revision = (await repo.save(p, r, revision, d, 'SHOTS', true)).revision;
      expect((await repo.workspace(p, r)).prompts[0]!.stale).toBe(true);
      const pending = await repo.start(
          p,
          r,
          revision,
          'SHOTS',
          'cancel',
          null,
          models,
          null,
          undefined,
          { version: 2 },
        ),
        pendingClaim = await repo.claim(p, pending.id, 'VIDEO');
      await repo.action(p, pending.id, true);
      await expect(
        repo.complete(p, pending.id, pendingClaim.attemptToken!, d, 'VIDEO'),
      ).rejects.toThrow();
      // A failed result can enter manual draft only with the exact viewed candidate hash.
      const failed = await repo.start(
          p,
          r,
          revision,
          'SHOTS',
          'review',
          null,
          models,
          null,
          undefined,
          { version: 2 },
        ),
        failedClaim = await repo.claim(p, failed.id, 'VIDEO');
      const failedInput = failedClaim.input as unknown as ProductionInput;
      const candidate = structuredClone(d);
      candidate.videoPlan.sources = failedInput.sources;
      await repo.checkpoint(
        p,
        failed.id,
        failedClaim.attemptToken!,
        { id: 'GENERATE', status: 'SUCCEEDED', title: '完整候选', content: '候选待核对' },
        { value: candidate, audit },
        'VIDEO',
      );
      await repo.fail(p, failed.id, failedClaim.attemptToken!, false, 'VIDEO');
      const preview = await repo.candidate(p, failed.id);
      expect(preview.document.videoPlan.clips).toHaveLength(2);
      await expect(repo.reviewDraft(p, failed.id, revision, 'wrong')).rejects.toThrow();
      const adopted = await repo.reviewDraft(p, failed.id, revision, preview.candidateHash);
      expect(adopted.revision).toBeGreaterThanOrEqual(revision);
      expect((await repo.getTask(p, failed.id)).status).toBe('FAILED');
      await expect(repo.save(p, r, revision + 99, d, 'SHOTS', true)).rejects.toThrow();
    } finally {
      outbox.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where: { projectId: p } });
      await db.assetVersion.deleteMany({ where: { projectId: p } });
      await db.asset.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: { in: [p, other] } } });
      await db.$disconnect();
    }
  },
);
