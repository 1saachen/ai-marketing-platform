import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  type ProductionAsset,
  type ProductionDocument,
  type ProductionInput,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';
import { updatePreview } from './update-preview';
import { planAssetImageRefresh } from './asset-image-refresh';
import {
  ASSET_IMAGE_RETENTION_NODE,
  retainedAssetImageFingerprints,
} from './asset-image-retention';

it
  .skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')
  .each(['text', 'image', 'retain'] as const)(
  'handles scoped asset images in %s mode',
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
            await tx.project.create({ data: { id: p, name: '资产与图片联动回归' } });
            const run = await tx.workflowRun.create({
              data: {
                projectId: p,
                workflow: 'CUSTOMIZED',
                workflowSpace: 'CUSTOMIZED_PROJECT',
                forkScriptId: sid,
              },
            });
            const r = run.id;
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
            const put = (
              artifactKey: string,
              payload: object,
              freshness: 'CURRENT' | 'STALE' = 'CURRENT',
            ) =>
              tx.workingArtifact.create({
                data: {
                  projectId: p,
                  workflowRunId: r,
                  artifactKey,
                  nodeId: 'SHOT_PROMPT',
                  kind: 'STRUCTURED',
                  name: 'name' in payload ? String(payload.name) : artifactKey,
                  directory: 'SCRIPTS',
                  type: 'STORYBOARD_SCRIPT',
                  payload: payload as Prisma.InputJsonValue,
                  contentHash: workflowStateHash(payload),
                  freshness,
                },
              });
            const briefArtifact = await put('customized-brief', brief);
            await put(`customized-script:${sid}`, script);
            function asset(
              id: string,
              kind: ProductionAsset['kind'],
              description: string,
              parent?: string,
            ): ProductionAsset {
              return {
                id,
                kind,
                name: id,
                description,
                knownFacts: '',
                designNotes: '',
                sourceText: '',
                manualFields: [],
                ...(!parent ? { image: { assetId: randomUUID(), version: 1 } } : {}),
                ...(mode !== 'text' && !parent ? { imageBasis: 'a'.repeat(64) } : {}),
                preparation: {
                  aliases: [],
                  usage: '出场',
                  treatment: parent ? 'SCENE_DETAIL' : 'INDEPENDENT',
                  parentId: parent ?? null,
                  sources: [
                    { source: 'BRIEF', path: '/productName', quote: '陶瓷杯', field: 'usage' },
                  ],
                  details: [],
                  questions: [],
                  images: [],
                },
              };
            }
            const assets = [
              asset('cup', 'PRODUCT', mode === 'text' ? '白色' : '黑色'),
              asset('room', 'SCENE', '书房'),
              asset('curtain', 'PROP', '白色窗帘', 'room'),
              asset('reader', 'CHARACTER', '读者'),
            ];
            const originals = new Map(assets.map((a) => [a.id, a.image]));
            if (mode === 'text') {
              const relinked = structuredClone(assets);
              relinked[0]!.preparation!.sources[0]!.field = 'context';
              expect(planAssetImageRefresh(assets, relinked).assetIds).toEqual([]);
            }
            const freshness = mode === 'text' ? 'STALE' : 'CURRENT';
            const catalog = await put('customized-asset-catalog', { assets }, freshness);
            for (const a of assets) await put(`customized-object:${a.id}`, a, freshness);
            const repo = new ProductionRepository(
              {
                $transaction: (work: (dbTx: Prisma.TransactionClient) => unknown) => work(tx),
              } as unknown as PrismaService,
              new WorkflowWorkingRepository(db),
            );
            const models = { creative: 'controlled', detail: 'controlled' };
            const preview = await updatePreview(tx, p, r, 'ASSETS');
            expect(preview.calls).toEqual(mode === 'text' ? ['TEXT', 'IMAGE'] : ['IMAGE']);
            expect(preview.assetImageCount).toBe(3);
            if (mode === 'retain') {
              const workspace = await repo.workspace(p, r);
              const request = {
                version: 1 as const,
                fingerprint: preview.fingerprint,
                assetIds: ['cup', 'room'],
              };
              await expect(repo.retainAssetImages(p, r, request)).rejects.toThrow('原图已不可用');
              for (const id of request.assetIds) {
                const image = originals.get(id)!;
                const file = {
                  storageKey: `controlled/${image.assetId}.png`,
                  originalFileName: 'controlled.png',
                  sizeBytes: 100,
                  mimeType: 'image/png',
                };
                await tx.asset.create({
                  data: {
                    id: image.assetId,
                    projectId: p,
                    name: id,
                    directory: 'VISUAL_ASSETS',
                    type: 'PRODUCT_ASSET',
                    storageWorkflow: 'CUSTOMIZED',
                    workflowSpace: 'CUSTOMIZED_PROJECT',
                    ...file,
                  },
                });
                await tx.assetVersion.create({
                  data: {
                    projectId: p,
                    assetId: image.assetId,
                    version: image.version,
                    status: 'AVAILABLE',
                    qualityStatus: 'AVAILABLE',
                    changeNote: 'controlled',
                    ...file,
                  },
                });
              }
              const scriptPreview = await repo.preview(p, r, 'SCRIPT', sid);
              const saved = await repo.retainAssetImages(p, r, request);
              expect(saved.items.map((item) => item.id)).toEqual(['reader']);
              expect(await repo.retainAssetImages(p, r, request)).toEqual(saved);
              expect(await repo.preview(p, r, 'SCRIPT', sid)).toEqual(scriptPreview);
              const refreshed = await repo.workspace(p, r);
              expect(refreshed.imageReviewObjectIds).toEqual(['reader']);
              expect(refreshed.draftRevision).toBe(workspace.draftRevision);
              expect(refreshed.confirmedDocument).toEqual(workspace.confirmedDocument);
              expect(await tx.workingArtifact.findUnique({ where: { id: catalog.id } })).toEqual(
                catalog,
              );
              expect(await tx.customizedProductionTask.count({ where: { projectId: p } })).toBe(0);
              const state = await tx.workflowNodeState.findFirstOrThrow({
                where: { projectId: p, workflowRunId: r, nodeId: ASSET_IMAGE_RETENTION_NODE },
              });
              expect(state.revision).toBe(1);
              const sibling = await tx.workflowRun.create({
                data: {
                  projectId: p,
                  workflow: 'CUSTOMIZED',
                  workflowSpace: 'CUSTOMIZED_PROJECT',
                  forkScriptId: sid,
                  parentWorkflowRunId: r,
                  status: 'PAUSED',
                  activeKey: null,
                },
              });
              await tx.workflowNodeState.create({
                data: {
                  projectId: p,
                  workflowRunId: sibling.id,
                  nodeId: state.nodeId,
                  contentHash: state.contentHash,
                  state: state.state as Prisma.InputJsonValue,
                },
              });
              expect((await retainedAssetImageFingerprints(tx, p, sibling.id)).size).toBe(0);
              const revised = {
                assets: assets.map((a) =>
                  a.id === 'curtain' ? { ...a, description: '蓝色窗帘' } : a,
                ),
              };
              await tx.workingArtifact.update({
                where: { id: catalog.id },
                data: {
                  payload: revised as Prisma.InputJsonValue,
                  contentHash: workflowStateHash(revised),
                  revision: { increment: 1 },
                },
              });
              expect((await repo.preview(p, r, 'ASSETS')).items.map((item) => item.id)).toEqual([
                'room',
                'reader',
              ]);
              await expect(repo.retainAssetImages(p, r, request)).rejects.toThrow('更新范围已变化');
              throw rollback;
            }
            const key = randomUUID();
            const request = {
              version: 1 as const,
              fingerprint: preview.fingerprint,
              refreshAssetImages: true as const,
              ...(mode === 'image' ? { imageAssetIds: ['cup', 'room'] } : {}),
            };
            if (mode === 'image') {
              await expect(
                repo.startUpdates(
                  p,
                  r,
                  'ASSETS',
                  {
                    version: 1,
                    fingerprint: preview.fingerprint,
                  },
                  randomUUID(),
                  models,
                  {},
                ),
              ).rejects.toThrow('确认更新参考图片');
              await expect(
                repo.startUpdates(
                  p,
                  r,
                  'ASSETS',
                  { ...request, imageAssetIds: ['curtain'] },
                  key,
                  models,
                  {},
                ),
              ).rejects.toThrow('所选图片已变化');
            }
            const [started] = await repo.startUpdates(p, r, 'ASSETS', request, key, models, {});
            expect((await repo.startUpdates(p, r, 'ASSETS', request, key, models, {}))[0]?.id).toBe(
              started!.id,
            );
            expect(started!.operation).toBe(mode === 'text' ? 'ASSETS' : 'IMAGE');
            if (mode === 'image')
              await expect(
                repo.startUpdates(
                  p,
                  r,
                  'ASSETS',
                  { ...request, imageAssetIds: ['cup'] },
                  key,
                  models,
                  {},
                ),
              ).rejects.toThrow('请求标识已用于其他操作');

            if (mode === 'text') {
              const task = started!;
              const claim = await repo.claim(p, task.id, 'ASSETS');
              const final: ProductionDocument = {
                assets: assets.map((a) =>
                  a.id === 'cup'
                    ? { ...a, description: '黑色' }
                    : a.id === 'curtain'
                      ? { ...a, description: '浅灰色窗帘' }
                      : a.id === 'reader'
                        ? { ...a, knownFacts: '故事中使用黑色陶瓷杯。' }
                        : a,
                ),
                shots: [],
              };
              const assetUpdatePlan = {
                decisions: assets.map((a) => ({
                  assetId: a.id,
                  fields: ['cup', 'curtain'].includes(a.id)
                    ? ['description']
                    : a.id === 'reader'
                      ? ['knownFacts']
                      : [],
                  reason: '根据当前资料核对',
                })),
                imageDecisions: [
                  { assetId: 'cup', action: 'UPDATE', reason: '杯子本体配色变化' },
                  { assetId: 'room', action: 'UPDATE', reason: '场景参考图中的窗帘颜色变化' },
                  { assetId: 'reader', action: 'KEEP', reason: '杯色只用于人物剧情背景' },
                ],
                blockers: [],
                additions: [],
              };
              for (const step of task.steps.filter((s) => s.id !== 'SAVE'))
                await repo.checkpoint(
                  p,
                  task.id,
                  claim.attemptToken!,
                  { ...step, status: 'SUCCEEDED' },
                  { final, assetUpdatePlan },
                  'ASSETS',
                );
              await repo.complete(p, task.id, claim.attemptToken!, final, 'ASSETS');
              await repo.complete(p, task.id, claim.attemptToken!, final, 'ASSETS');
            }
            const task = await tx.customizedProductionTask.findFirstOrThrow({
              where: { projectId: p, workflowRunId: r, operation: 'IMAGE' },
            });
            expect(
              await tx.customizedProductionTask.count({
                where: { projectId: p, operation: 'IMAGE' },
              }),
            ).toBe(1);
            const input = task.inputSnapshot as unknown as ProductionInput;
            expect(input.incremental?.batchKey).toBe(key);
            expect(input.assetImageRefresh?.definitionTaskId).toBe(
              mode === 'text' ? started!.id : undefined,
            );
            expect(input.imageSettings?.assetIds).toEqual(['cup', 'room']);
            const workspace = () => repo.workspace(p, r);
            expect((await workspace()).confirmedDocument.assets[0]?.description).toBe('黑色');
            if (mode === 'text') {
              const current = await workspace();
              expect(
                current.confirmedDocument.assets.find((a) => a.id === 'reader')?.knownFacts,
              ).toBe('故事中使用黑色陶瓷杯。');
              expect(current.imageReviewObjectIds).toEqual(['cup', 'room']);
            }
            const claim = await repo.claim(p, task.id, 'ASSETS');
            await repo.checkpoint(
              p,
              task.id,
              claim.attemptToken!,
              { id: 'SNAPSHOT', status: 'SUCCEEDED', title: '图片依据', content: '' },
              undefined,
              'ASSETS',
            );
            const file = () => ({
              storageKey: `${p}/${randomUUID()}.png`,
              sizeBytes: 123,
              mimeType: 'image/png',
              originalFileName: 'controlled.png',
              sha256: workflowStateHash(randomUUID()),
            });
            await expect(
              repo.acceptImage(p, task.id, claim.attemptToken!, 'reader', file()),
            ).rejects.toThrow();
            const cup = await repo.acceptImage(p, task.id, claim.attemptToken!, 'cup', file());
            await repo.fail(p, task.id, claim.attemptToken!, false, 'ASSETS');
            expect((await repo.getTask(p, task.id)).completedImageAssetIds).toEqual(['cup']);
            expect((await workspace()).confirmedDocument.assets.map((a) => a.image)).toEqual(
              assets.map((a) => a.image),
            );
            expect((await updatePreview(tx, p, r, 'ASSETS')).blockers.join('')).toContain(
              '继续图片更新',
            );
            await tx.workingArtifact.update({
              where: { id: briefArtifact.id },
              data: { revision: briefArtifact.revision + 1 },
            });
            await expect(repo.action(p, task.id, false)).rejects.toThrow('任务来源已变化');
            await tx.workingArtifact.update({
              where: { id: briefArtifact.id },
              data: { revision: briefArtifact.revision },
            });
            await repo.action(p, task.id, false);
            const resume = await repo.claim(p, task.id, 'ASSETS');
            expect(resume.output).toMatchObject({ cup: cup.image });
            await expect(
              repo.acceptImage(p, task.id, claim.attemptToken!, 'room', file()),
            ).rejects.toThrow();
            const room = await repo.acceptImage(p, task.id, resume.attemptToken!, 'room', file());
            await repo.complete(p, task.id, resume.attemptToken!, {}, 'ASSETS');
            const done = await workspace();
            expect(done.assetsConfirmed).toBe(true);
            expect(done.confirmedDocument.assets.map((a) => [a.id, a.image])).toEqual([
              ['cup', cup.image],
              ['room', room.image],
              ['curtain', undefined],
              ['reader', originals.get('reader')],
            ]);
            expect(done.imageReviewObjectIds).toEqual(mode === 'text' ? [] : ['reader']);
            expect(done.tasks.find((t) => t.id === task.id)?.status).toBe('COMPLETED');
            expect(await tx.workflowRun.count({ where: { projectId: p } })).toBe(1);
            expect((await updatePreview(tx, p, r, 'ASSETS')).items.map((item) => item.id)).toEqual(
              mode === 'text' ? [] : ['reader'],
            );
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
