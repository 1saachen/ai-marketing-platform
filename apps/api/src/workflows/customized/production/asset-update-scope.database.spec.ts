import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  type ProductionAsset,
  type ProductionDocument,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';
import { updatePreview } from './update-preview';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'commits AI-selected fields in place across two rounds, preserves keep revisions and rejects late or out-of-scope results',
  async () => {
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
            await tx.project.create({ data: { id: p, name: '资产模型局部范围回归' } });
            const run = await tx.workflowRun.create({
              data: {
                projectId: p,
                workflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                forkScriptId: sid,
              },
            });
            const sibling = await tx.workflowRun.create({
              data: {
                projectId: p,
                workflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                forkScriptId: sid,
                status: 'PAUSED',
                activeKey: null,
              },
            });
            const brief = {
              ...emptyCustomizedBrief(),
              productName: '陶瓷杯',
              productAppearance: '黑色',
            };
            const script = {
              id: sid,
              name: '阅读',
              synopsis: '拿起杯子阅读',
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
            const make = (
              r: string,
              key: string,
              payload: object,
              freshness: 'CURRENT' | 'STALE' = 'CURRENT',
            ) =>
              tx.workingArtifact.create({
                data: {
                  projectId: p,
                  workflowRunId: r,
                  artifactKey: key,
                  nodeId: 'SHOT_PROMPT',
                  kind: 'STRUCTURED',
                  name: 'name' in payload ? String(payload.name) : key,
                  directory: 'SCRIPTS',
                  type: 'STORYBOARD_SCRIPT',
                  payload: payload as Prisma.InputJsonValue,
                  contentHash: workflowStateHash(payload),
                  freshness,
                },
              });
            await make(run.id, 'customized-brief', brief);
            const source = await make(run.id, `customized-script:${sid}`, script);
            const asset = (
              id: string,
              kind: ProductionAsset['kind'],
              name: string,
            ): ProductionAsset => ({
              id,
              kind,
              name,
              description: id === 'cup' ? '白色' : '原人物',
              knownFacts: '',
              designNotes: '',
              sourceText: '',
              manualFields: [],
              preparation: {
                aliases: [],
                usage: '出场',
                treatment: 'INDEPENDENT',
                parentId: null,
                sources: [
                  { source: 'BRIEF', path: '/productName', quote: '陶瓷杯', field: 'usage' },
                ],
                details: [],
                questions: [],
                images: [],
              },
            });
            const original: ProductionDocument = {
              assets: [asset('cup', 'PRODUCT', '杯子'), asset('person', 'CHARACTER', '人物')],
              shots: [],
            };
            await make(run.id, 'customized-asset-catalog', { assets: original.assets }, 'STALE');
            const objects = await Promise.all(
              original.assets.map((a) => make(run.id, `customized-object:${a.id}`, a, 'STALE')),
            );
            const untouched = await make(
              sibling.id,
              'customized-object:person',
              original.assets[1]!,
            );
            const transactional = {
              $transaction: (fn: (v: Prisma.TransactionClient) => unknown) => fn(tx),
            } as unknown as PrismaService;
            const repo = new ProductionRepository(transactional, new WorkflowWorkingRepository(db));
            const models = { creative: 'controlled', detail: 'controlled' };
            let adopted = original;
            const completed: { id: string; token: string; result: ProductionDocument }[] = [];
            for (const round of [1, 2]) {
              if (round === 2) {
                await tx.workingArtifact.update({
                  where: { id: source.id },
                  data: {
                    revision: { increment: 1 },
                    payload: { ...script, synopsis: '仅改台词' },
                    contentHash: workflowStateHash({ ...script, synopsis: '仅改台词' }),
                  },
                });
                await tx.workingArtifact.updateMany({
                  where: {
                    projectId: p,
                    workflowRunId: run.id,
                    artifactKey: {
                      in: [
                        'customized-asset-catalog',
                        'customized-object:cup',
                        'customized-object:person',
                      ],
                    },
                  },
                  data: { freshness: 'STALE' },
                });
              }
              const preview = await updatePreview(tx, p, run.id, 'ASSETS');
              const request = { version: 1 as const, fingerprint: preview.fingerprint };
              const key = randomUUID();
              const tasks = await repo.startUpdates(p, run.id, 'ASSETS', request, key, models, {});
              expect(
                (await repo.startUpdates(p, run.id, 'ASSETS', request, key, models, {}))[0]?.id,
              ).toBe(tasks[0]?.id);
              const task = tasks[0]!;
              const claim = await repo.claim(p, task.id, 'ASSETS');
              expect((claim.input as { assetUpdateVersion: number }).assetUpdateVersion).toBe(1);
              const plan = {
                decisions: original.assets.map((a) => ({
                  assetId: a.id,
                  fields: a.id === 'cup' && round === 1 ? ['description'] : [],
                  reason: a.id === 'cup' && round === 1 ? '配色改变' : '公共定义未变',
                })),
                additions: [],
                blockers: [],
              };
              const result = {
                assets: adopted.assets.map((a) =>
                  a.id === 'cup' ? { ...a, description: '黑色' } : a,
                ),
                shots: [],
              };
              for (const step of task.steps.filter((s) => s.id !== 'SAVE'))
                await repo.checkpoint(
                  p,
                  task.id,
                  claim.attemptToken!,
                  { ...step, status: 'SUCCEEDED' },
                  { assetUpdatePlan: plan, final: result },
                  'ASSETS',
                );
              const invalid = structuredClone(result);
              invalid.assets[1]!.description = '不能改的人物';
              await tx.customizedProductionTask.update({
                where: { id: task.id },
                data: {
                  output: {
                    assetUpdatePlan: plan,
                    final: invalid,
                  } as unknown as Prisma.InputJsonValue,
                },
              });
              await expect(
                repo.complete(p, task.id, claim.attemptToken!, invalid, 'ASSETS'),
              ).rejects.toThrow('范围外');
              await tx.customizedProductionTask.update({
                where: { id: task.id },
                data: {
                  output: {
                    assetUpdatePlan: plan,
                    final: result,
                  } as unknown as Prisma.InputJsonValue,
                },
              });
              await repo.complete(p, task.id, claim.attemptToken!, result, 'ASSETS');
              await repo.complete(p, task.id, claim.attemptToken!, result, 'ASSETS');
              expect((await updatePreview(tx, p, run.id, 'ASSETS')).items).toEqual([]);
              const stored = await tx.workingArtifact.findMany({
                where: {
                  projectId: p,
                  workflowRunId: run.id,
                  id: { in: objects.map((a) => a.id) },
                },
              });
              expect(stored.find((a) => a.artifactKey.endsWith(':person'))?.revision).toBe(1);
              expect(stored.find((a) => a.artifactKey.endsWith(':cup'))?.revision).toBe(2);
              expect(await tx.workflowRun.count({ where: { projectId: p } })).toBe(2);
              completed.push({ id: task.id, token: claim.attemptToken!, result });
              adopted = result;
            }
            await repo.complete(
              p,
              completed[0]!.id,
              completed[0]!.token,
              completed[0]!.result,
              'ASSETS',
            );
            expect((await repo.workspace(p, run.id)).document.assets).toEqual(adopted.assets);
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: untouched.id } })).payload,
            ).toEqual(original.assets[1]);
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: untouched.id } }))
                .revision,
            ).toBe(1);
            throw rollback;
          },
          { timeout: 30000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  45000,
);
