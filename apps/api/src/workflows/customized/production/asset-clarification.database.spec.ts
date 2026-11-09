import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  emptyCustomizedImportDraft,
  type AssetClarificationProposal,
  type ProductionInput,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { activateCustomizedBranch } from '../../../platform/workflow/customized-branches';
import { sharedCustomizedBrief } from '../../../platform/workflow/customized-shared-brief';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';
import { updatePreview } from './update-preview';

it
  .skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')
  .each(['facts', 'note', 'stale', 'dismiss'] as const)(
  'handles clarification (%s) without replacing old work or leaking to another path',
  async (mode) => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw Error('Local isolated database required');
    const db = new PrismaService(new ConfigService({ DATABASE_URL: url }));
    const rollback = Error('Intentional rollback: no jobs become visible');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const p = randomUUID(),
              sid = randomUUID();
            const base = {
              projectId: p,
              workflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
            } as const;
            await tx.project.create({ data: { id: p, name: '补充说明验证' } });
            const run = await tx.workflowRun.create({ data: { ...base, forkScriptId: sid } });
            const r = run.id;
            const sibling = await tx.workflowRun.create({
              data: {
                ...base,
                forkScriptId: sid,
                status: 'PAUSED',
                activeKey: null,
                parentWorkflowRunId: r,
                branchPublishedAt: new Date(),
              },
            });
            const working = new WorkflowWorkingRepository(db);
            const repo = new ProductionRepository(
              {
                $transaction: (fn: (v: Prisma.TransactionClient) => unknown) => fn(tx),
              } as unknown as PrismaService,
              working,
            );
            const fields = {
              ...emptyCustomizedBrief(),
              productName: '陶瓷杯',
              productAppearance: '燕麦白',
              productSpecifications: '不锈钢内胆，480mL 或 430mL 待核实',
              sellingPoints: ['便于携带'],
            };
            const script = {
              id: sid,
              name: '阅读',
              synopsis: '拿杯阅读',
              structure: '拿杯、阅读',
              productFocus: '陶瓷杯',
              shots: [],
              story: {
                content: '她拿起杯子阅读。',
                opening: '',
                development: '',
                ending: '',
                dialoguePlan: '',
                beats: [],
              },
            };
            const assets = [
              {
                id: 'cup',
                kind: 'PRODUCT',
                name: '陶瓷杯',
                description: '燕麦白',
                knownFacts: '不锈钢内胆',
                designNotes: '',
                sourceText: '',
                image: { assetId: randomUUID(), version: 1 },
              },
            ] as const;
            const sourcePayload = emptyCustomizedImportDraft();
            const source = await tx.workingArtifact.create({
              data: {
                projectId: p,
                workflowRunId: r,
                artifactKey: 'customized-source-package',
                nodeId: 'SOURCE_IMPORT',
                kind: 'STRUCTURED',
                name: '资料包',
                directory: 'SOURCE_MATERIALS',
                type: 'SOURCE_MATERIAL',
                payload: sourcePayload,
                contentHash: workflowStateHash(sourcePayload),
              },
            });
            const [committed] = await working.commitValidatedArtifactsInTransaction(
              tx,
              p,
              r,
              'INFORMATION_EXTRACTION',
              [
                {
                  artifactKey: 'customized-brief',
                  input: {
                    kind: 'STRUCTURED',
                    name: '视频创作信息卡',
                    directory: 'INSIGHTS',
                    type: 'INSIGHT_RESULT',
                    payload: fields,
                    dependencies: [
                      {
                        sourceType: 'WORKING_ARTIFACT',
                        sourceArtifactId: source.id,
                        sourceNodeId: source.nodeId,
                        sourceKey: source.artifactKey,
                        sourceRevision: source.revision,
                        sourceHash: source.contentHash,
                      },
                    ],
                  },
                },
              ],
            );
            const brief = committed!.record;
            await tx.workingArtifactRevisionSnapshot.updateMany({
              where: { projectId: p, workingArtifactId: brief.id },
              data: { confirmedAt: new Date(0) },
            });
            const extraction = { fields, fieldSources: {}, issues: [] };
            await tx.customizedExtractionResult.create({
              data: {
                projectId: p,
                workflowRunId: r,
                taskId: randomUUID(),
                sourceFingerprint: workflowStateHash({
                  artifactId: source.id,
                  revision: source.revision,
                  payload: sourcePayload,
                }),
                generatedResult: extraction,
                draftResult: extraction,
              },
            });
            const scriptRow = await tx.workingArtifact.create({
              data: {
                projectId: p,
                workflowRunId: r,
                artifactKey: `customized-script:${sid}`,
                nodeId: 'STORYBOARD',
                kind: 'STRUCTURED',
                name: '阅读',
                directory: 'SCRIPTS',
                type: 'STORYBOARD_SCRIPT',
                payload: script,
                contentHash: workflowStateHash(script),
              },
            });
            const catalog = await tx.workingArtifact.create({
              data: {
                projectId: p,
                workflowRunId: r,
                artifactKey: 'customized-asset-catalog',
                nodeId: 'SHOT_PROMPT',
                kind: 'STRUCTURED',
                name: '资产目录',
                directory: 'SCRIPTS',
                type: 'STORYBOARD_SCRIPT',
                payload: { assets },
                contentHash: workflowStateHash({ assets }),
                freshness: 'STALE',
              },
            });
            const siblingBefore = await tx.workflowRun.findUniqueOrThrow({
              where: { id: sibling.id },
            });
            const model = { creative: 'controlled', detail: 'controlled' };
            const preview = await updatePreview(tx, p, r, 'ASSETS');
            const [blocked] = await repo.startUpdates(
              p,
              r,
              'ASSETS',
              preview,
              randomUUID(),
              model,
              {},
            );
            const old = await tx.customizedProductionTask.update({
              where: { id: blocked!.id },
              data: {
                status: 'FAILED',
                createdAt: new Date(1),
                output: { assetUpdatePlan: { blockers: ['请确认/productAppearance中的颜色'] } },
              },
            });
            expect((await repo.getTask(p, old.id)).assetReviewQuestions).toEqual([
              '请确认信息卡「产品外观」中的颜色',
            ]);
            await expect(repo.action(p, old.id, false)).rejects.toThrow('补充说明并重新判断');
            const request = {
              workflowRunId: r,
              idempotencyKey: randomUUID(),
              explanation: '容量本次不展示',
            };
            await expect(
              repo.clarifyAssets(p, old.id, { ...request, workflowRunId: sibling.id }, model),
            ).rejects.toThrow();
            const task = await repo.clarifyAssets(p, old.id, request, model);
            expect((await repo.clarifyAssets(p, old.id, request, model)).id).toBe(task.id);
            const claim = await repo.claim(p, task.id, 'ASSETS');
            if (!('attemptToken' in claim) || !claim.attemptToken) throw Error('claim expected');
            const proposal: AssetClarificationProposal = {
              changes: [
                { field: 'productAppearance', value: mode === 'note' ? ' 燕麦白 ' : '黑色' },
              ],
              productionNote: '本次不展示容量',
              questions: [],
            };
            await repo.checkpoint(
              p,
              task.id,
              claim.attemptToken,
              {
                id: 'INVENTORY',
                status: 'SUCCEEDED',
                title: '待确认',
                content: '',
              },
              { final: proposal },
              'ASSETS',
            );
            await repo.complete(p, task.id, claim.attemptToken, proposal, 'ASSETS');
            expect(
              (await repo.workspace(p, r)).tasks.find((t) => t.id === task.id)?.assetClarification
                ?.state,
            ).toBe('PENDING');
            expect((await sharedCustomizedBrief(tx, p, r, undefined, true))?.id).toBe(brief.id);
            const adopt = { workflowRunId: r, adopt: true };
            await activateCustomizedBranch(tx, p, sibling.id, 'SHOT_PROMPT');
            await expect(repo.decideAssetClarification(p, task.id, adopt)).rejects.toThrow(
              '路径或判断记录已变化',
            );
            await activateCustomizedBranch(tx, p, r, 'SHOT_PROMPT');
            if (mode === 'stale') {
              await tx.workingArtifact.update({
                where: { id: scriptRow.id },
                data: { revision: { increment: 1 } },
              });
              await expect(repo.decideAssetClarification(p, task.id, adopt)).rejects.toThrow(
                '信息卡、脚本或资产已变化',
              );
            } else if (mode === 'dismiss') {
              expect(
                (await repo.decideAssetClarification(p, task.id, { ...adopt, adopt: false }))
                  .assetClarification?.state,
              ).toBe('DISMISSED');
              await expect(repo.decideAssetClarification(p, task.id, adopt)).rejects.toThrow(
                '建议已处理',
              );
            } else {
              expect(
                (await repo.decideAssetClarification(p, task.id, adopt)).assetClarification?.state,
              ).toBe('ADOPTED');
              expect(
                (await repo.decideAssetClarification(p, task.id, adopt)).assetClarification?.state,
              ).toBe('ADOPTED');
            }
            const head = await sharedCustomizedBrief(tx, p, r, undefined, true);
            if (mode === 'facts') {
              expect(head?.revision).toBe(brief.revision + 1);
              expect(head?.payload).toEqual({ ...fields, productAppearance: '黑色' });
              expect((await repo.workspace(p, r)).sourceReady).toBe(false);
              expect((await updatePreview(tx, p, r, 'SCRIPT', sid)).items).toHaveLength(1);
              const dependency = await tx.workingArtifactDependency.findFirstOrThrow({
                where: { dependentArtifactId: head!.id },
              });
              expect(dependency.sourceRevision).toBe(source.revision);
              expect(await tx.customizedProductionTask.count({ where: { projectId: p } })).toBe(2);
              // Advance only the current script's consumed source, as on a confirmed script edit.
              await tx.workingArtifactDependency.create({
                data: {
                  projectId: p,
                  workflowRunId: r,
                  dependentArtifactId: scriptRow.id,
                  sourceType: 'WORKING_ARTIFACT',
                  sourceArtifactId: head!.id,
                  sourceNodeId: head!.nodeId,
                  sourceKey: head!.artifactKey,
                  sourceRevision: head!.revision,
                  sourceHash: head!.contentHash,
                },
              });
              const refreshed = await updatePreview(tx, p, r, 'ASSETS');
              const [next] = await repo.startUpdates(
                p,
                r,
                'ASSETS',
                refreshed,
                randomUUID(),
                model,
                {},
              );
              const frozen = await tx.customizedProductionTask.findUniqueOrThrow({
                where: { id: next!.id },
              });
              expect((frozen.inputSnapshot as unknown as ProductionInput).assetProductionNote).toBe(
                '本次不展示容量',
              );
            } else {
              expect(head?.id).toBe(brief.id);
              expect(head?.revision).toBe(brief.revision);
            }
            if (mode === 'note') {
              const next = await tx.customizedProductionTask.findUniqueOrThrow({
                where: {
                  projectId_idempotencyKey: {
                    projectId: p,
                    idempotencyKey: `asset-clarification:${task.id}:apply`,
                  },
                },
              });
              expect(next.status).toBe('QUEUED');
              expect((next.inputSnapshot as unknown as ProductionInput).assetProductionNote).toBe(
                '本次不展示容量',
              );
              expect(await tx.customizedProductionTask.count({ where: { projectId: p } })).toBe(3);
              await tx.customizedProductionTask.update({
                where: { id: next.id },
                data: {
                  status: 'FAILED',
                  createdAt: new Date(Date.now() + 1000),
                  output: { assetUpdatePlan: { blockers: ['旧图需替换'] } },
                },
              });
              const preview = await updatePreview(tx, p, r, 'ASSETS');
              const [retry] = await repo.startUpdates(
                p,
                r,
                'ASSETS',
                preview,
                randomUUID(),
                model,
                {},
              );
              const claimed = await repo.claim(p, retry!.id, 'ASSETS');
              expect(claimed).toMatchObject({
                input: { assetTextUpdateVersion: 1, assetProductionNote: '本次不展示容量' },
              });
            }
            expect(await tx.workingArtifact.findUnique({ where: { id: catalog.id } })).toEqual(
              catalog,
            );
            expect(await tx.customizedProductionTask.findUnique({ where: { id: old.id } })).toEqual(
              old,
            );
            expect(await tx.workflowRun.findUnique({ where: { id: sibling.id } })).toMatchObject({
              activeKey: siblingBefore.activeKey,
              status: siblingBefore.status,
            });
            throw rollback;
          },
          { timeout: 30000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  40000,
);
