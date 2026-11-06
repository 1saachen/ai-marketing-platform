import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  applyCustomizedScriptPatches,
  emptyCustomizedBrief,
  type CustomizedStoryboardScript,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { beginCustomizedEdit } from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from '../production/production.repository';
import { updatePreview } from '../production/update-preview';
import { StoryboardRepository } from './storyboard.repository';
import { createScriptUpdate, scriptUpdateCandidate } from './script-update';

it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DATABASE_TEST !== '1')(
  'keeps a changed brief on its current inherited script path across preview, tasks and production reads',
  async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw Error('Local isolated database required');
    const db = new PrismaService(new ConfigService({ DATABASE_URL: url }));
    const rolledBack = new Error('Intentional rollback: test jobs must never become visible');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const projectId = randomUUID(),
              sid = randomUUID();
            await tx.project.create({ data: { id: projectId, name: '信息卡改色路径回归' } });
            const sourceRun = await tx.workflowRun.create({
              data: {
                projectId,
                workflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                status: 'PAUSED',
                activeKey: null,
              },
            });
            const original = await tx.workflowRun.create({
              data: {
                projectId,
                workflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                status: 'PAUSED',
                activeKey: null,
                parentWorkflowRunId: sourceRun.id,
                forkNodeId: 'STORYBOARD',
                forkScriptId: sid,
              },
            });
            const current = await tx.workflowRun.create({
              data: {
                projectId,
                workflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                parentWorkflowRunId: original.id,
                forkNodeId: 'INFORMATION_EXTRACTION',
                forkScriptId: null,
                currentNodeId: 'STORYBOARD',
              },
            });
            const oldBrief = {
              ...emptyCustomizedBrief(),
              productName: '杯子',
              productAppearance: '白色杯子',
              sellingPoints: ['保温'],
            };
            const newBrief = { ...oldBrief, productAppearance: '黑色杯子' };
            const make = (
              runId: string,
              key: string,
              payload: object,
              revision = 1,
              freshness: 'CURRENT' | 'STALE' = 'CURRENT',
            ) =>
              tx.workingArtifact.create({
                data: {
                  projectId,
                  workflowRunId: runId,
                  nodeId: key === 'customized-brief' ? 'INFORMATION_EXTRACTION' : 'STORYBOARD',
                  artifactKey: key,
                  name: key,
                  kind: 'STRUCTURED',
                  directory: 'SCRIPTS',
                  type: 'STORYBOARD_SCRIPT',
                  payload: payload as Prisma.InputJsonValue,
                  contentHash: workflowStateHash(payload),
                  revision,
                  freshness,
                },
              });
            const oldSource = await make(sourceRun.id, 'customized-brief', oldBrief);
            const brief = await make(current.id, 'customized-brief', newBrief, 2);
            const script: CustomizedStoryboardScript = {
              id: sid,
              name: '原有杯子故事',
              synopsis: '拿起白色杯子阅读',
              structure: '白色杯子出现在会议桌',
              productFocus: '保温',
              shots: [],
              story: {
                content: '她拿起白色杯子，继续阅读。',
                opening: '清晨',
                development: '拿起杯子',
                ending: '继续阅读',
                dialoguePlan: '没有对白',
                beats: [{ id: 'beat', content: '拿起杯子', durationSeconds: 15 }],
              },
            };
            const source = {
              artifactId: oldSource.id,
              revision: 1,
              fingerprint: oldSource.contentHash,
            };
            await tx.customizedStoryboardScript.create({
              data: {
                id: sid,
                projectId,
                sourceRunId: sourceRun.id,
                workflowRunId: original.id,
                sourceSnapshot: source,
                status: 'COMPLETED',
                origin: 'MANUAL',
                draft: script as unknown as Prisma.InputJsonValue,
              },
            });
            const sibling = await make(original.id, `customized-script:${sid}`, script);
            const inherited = await make(
              current.id,
              `customized-script:${sid}`,
              script,
              1,
              'STALE',
            );
            await tx.workingArtifact.update({
              where: { id: inherited.id },
              data: { metadata: { confirmedBrief: oldBrief } },
            });
            await tx.workingArtifactDependency.create({
              data: {
                projectId,
                workflowRunId: current.id,
                dependentArtifactId: inherited.id,
                sourceType: 'WORKING_ARTIFACT',
                sourceArtifactId: brief.id,
                sourceKey: 'customized-brief',
                sourceRevision: 1,
                sourceHash: workflowStateHash(oldBrief),
              },
            });
            await make(current.id, 'customized-asset-catalog', { assets: [] }, 1, 'STALE');
            const transactionalDb = {
              $transaction: (fn: (value: Prisma.TransactionClient) => unknown) => fn(tx),
            } as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(db);
            const storyboard = new StoryboardRepository(transactionalDb, working);
            const production = new ProductionRepository(transactionalDb, working);
            for (const marker of [null, sid]) {
              await tx.workflowRun.update({
                where: { id: current.id },
                data: { forkScriptId: marker },
              });
              const workspace = await storyboard.workspace(projectId, current.id);
              expect(workspace.sourceRunId).toBe(current.id);
              expect(workspace.brief?.productAppearance).toBe('黑色杯子');
              const preview = await updatePreview(tx, projectId, current.id, 'SCRIPT', sid);
              expect(preview.items.map((item) => item.id)).toEqual([sid]);
              expect(preview.blockers).toEqual([]);
              const assets = await updatePreview(tx, projectId, current.id, 'ASSETS');
              expect(assets.blockers).toEqual(['请先保存并确认当前脚本']);
              const view = await production.workspace(projectId, current.id);
              expect(view.script.id).toBe(sid);
              expect(view.sourceReady).toBe(false);
            }
            for (const [index, colour] of ['黑色杯子', '哑光黑色杯子'].entries()) {
              const payload = { ...newBrief, productAppearance: colour };
              await tx.workingArtifact.update({
                where: { id: brief.id },
                data: { payload, revision: index + 2, contentHash: workflowStateHash(payload) },
              });
              const preview = await updatePreview(tx, projectId, current.id, 'SCRIPT', sid);
              const task = await createScriptUpdate(
                tx,
                projectId,
                current.id,
                sid,
                `test-${index}`,
                { version: 1, fingerprint: preview.fingerprint },
                { creative: 'controlled-test', detail: 'controlled-test' },
              );
              const input = task!.inputSnapshot as {
                brief: typeof oldBrief;
                incremental: { previousBrief: typeof oldBrief };
              };
              expect(task!.workflowRunId).toBe(current.id);
              expect(input.brief.productAppearance).toBe(colour);
              expect(input.incremental.previousBrief.productAppearance).toBe('白色杯子');
              expect(
                (task!.inputSnapshot as unknown as { incremental: { reviewFeedback?: unknown } })
                  .incremental.reviewFeedback,
              ).toBeUndefined();
              const claimed = await storyboard.claim(projectId, task!.id);
              if (!('attemptToken' in claimed) || !claimed.attemptToken)
                throw Error('Test task was not claimed');
              const patches = [
                { path: 'id', before: sid, after: 'changed-identity', reason: '禁止改身份' },
              ];
              const reason = '第 1 项脚本修改的位置不正确，未修改原脚本。';
              await storyboard.step(projectId, task!.id, claimed.attemptToken, {
                nodeId: 'STORY',
                scriptId: sid,
                status: 'RUNNING',
                output: { patches },
                errorMessage: null,
              });
              await storyboard.step(projectId, task!.id, claimed.attemptToken, {
                nodeId: 'STORY',
                scriptId: sid,
                status: 'FAILED',
                output: { patches },
                errorMessage: reason,
              });
              await storyboard.finish(projectId, task!.id, claimed.attemptToken, {});
              expect(
                (await tx.customizedStoryboardTask.findUniqueOrThrow({ where: { id: task!.id } }))
                  .errorMessage,
              ).toBe(reason);
              await storyboard.retry(projectId, task!.id);
              const resumed = await storyboard.claim(projectId, task!.id);
              if (!('checkpoints' in resumed) || !resumed.checkpoints || !resumed.attemptToken)
                throw Error('Test task did not resume');
              expect(resumed.checkpoints.find((step) => step.nodeId === 'STORY')?.output).toEqual({
                patches,
              });
              await expect(
                storyboard.step(projectId, task!.id, resumed.attemptToken, {
                  nodeId: 'STORY',
                  scriptId: sid,
                  status: 'SUCCEEDED',
                  output: { patches, script },
                  errorMessage: null,
                }),
              ).rejects.toThrow('脚本修改无法定位原文');
              const findings = [
                {
                  severity: 'ERROR' as const,
                  category: 'FACT' as const,
                  shotIds: [],
                  message: 'story.structure 仍有旧配色',
                  evidence: 'productAppearance 为黑色',
                  suggestion: '将故事结构说明中的配色同步为黑色',
                },
              ];
              await tx.customizedStoryboardStep.updateMany({
                where: { projectId, taskId: task!.id, nodeId: 'STORY' },
                data: { status: 'SUCCEEDED', output: { patches: [], script }, errorMessage: null },
              });
              await tx.customizedStoryboardStep.updateMany({
                where: { projectId, taskId: task!.id, nodeId: 'REVIEW' },
                data: {
                  status: 'SUCCEEDED',
                  output: { summary: '需修正', findings, candidateHash: workflowStateHash(script) },
                  errorMessage: null,
                },
              });
              await tx.customizedStoryboardTask.update({
                where: { id: task!.id },
                data: { status: 'FAILED', leaseExpiresAt: null },
              });
              await expect(storyboard.retry(projectId, task!.id)).rejects.toThrow('按审核意见修正');
              const display = await scriptUpdateCandidate(
                tx as unknown as PrismaService,
                projectId,
                current.id,
                sid,
              );
              expect(display?.reviewStatus).toBe('NEEDS_CHANGES');
              expect(display?.reviewFindings?.[0]?.message).toBe('故事结构说明 仍有旧配色');
              expect(display?.issues?.[0]).not.toContain('productAppearance');
              const repairPreview = await updatePreview(tx, projectId, current.id, 'SCRIPT', sid);
              const repairTask = await createScriptUpdate(
                tx,
                projectId,
                current.id,
                sid,
                `repair-${index}`,
                { version: 1, fingerprint: repairPreview.fingerprint },
                { creative: 'controlled-test', detail: 'controlled-test' },
              );
              const feedback = (
                repairTask!.inputSnapshot as unknown as {
                  incremental: {
                    reviewFeedback: {
                      candidate: CustomizedStoryboardScript;
                      findings: typeof findings;
                    };
                  };
                }
              ).incremental.reviewFeedback;
              expect(feedback.candidate).toEqual(script);
              expect(feedback.findings).toEqual(findings);
              expect(repairTask!.workflowRunId).toBe(current.id);
              const repairClaim = await storyboard.claim(projectId, repairTask!.id);
              if (!('attemptToken' in repairClaim) || !repairClaim.attemptToken)
                throw Error('Repair task was not claimed');
              const repairPatches = ['structure', 'synopsis', 'story/content'].map((path) => ({
                path,
                before: '白色杯子',
                after: '黑色杯子',
                reason: '当前产品外观与审核意见',
              }));
              const repaired = applyCustomizedScriptPatches(script, repairPatches);
              await storyboard.step(projectId, repairTask!.id, repairClaim.attemptToken, {
                nodeId: 'STORY',
                scriptId: sid,
                status: 'SUCCEEDED',
                output: { patches: repairPatches, script: repaired },
                errorMessage: null,
              });
              expect(repaired.structure).toBe('黑色杯子出现在会议桌');
              expect(repaired.story?.beats).toEqual(script.story?.beats);
              expect(
                (await tx.workingArtifact.findUniqueOrThrow({ where: { id: inherited.id } }))
                  .payload,
              ).toEqual(script);
              expect(
                (await tx.customizedStoryboardTask.findUniqueOrThrow({ where: { id: task!.id } }))
                  .status,
              ).toBe('FAILED');
              await tx.customizedStoryboardTask.update({
                where: { id: repairTask!.id },
                data: { status: 'CANCELLED' },
              });
              await tx.customizedStoryboardTask.update({
                where: { id: task!.id },
                data: { status: 'CANCELLED' },
              });
            }
            await tx.workflowRun.update({
              where: { id: current.id },
              data: { forkScriptId: null },
            });
            const child = await beginCustomizedEdit(
              tx,
              projectId,
              current.id,
              'INFORMATION_EXTRACTION',
            );
            expect(child.forkScriptId).toBe(sid);
            const preserved = await tx.workingArtifact.findUniqueOrThrow({
              where: { id: sibling.id },
            });
            expect(preserved.payload).toEqual(script);
            expect(preserved.revision).toBe(1);
            throw rolledBack;
          },
          { timeout: 30000 },
        ),
      ).rejects.toBe(rolledBack);
    } finally {
      await db.$disconnect();
    }
  },
);
