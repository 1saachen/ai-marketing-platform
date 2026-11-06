import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  emptyCustomizedImportDraft,
  type CustomizedStoryboardScript,
  type StoryboardInput,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  WorkflowWorkingRepository,
  workingArtifactContentHash,
} from './workflow-working.repository';
import { workflowStateHash } from './workflow-state-hash';
import { sharedCustomizedBrief, setCustomizedInformationMode } from './customized-shared-brief';
import { beginCustomizedEdit } from './customized-branches';
import { StoryboardRepository } from '../../workflows/customized/storyboard/storyboard.repository';
import {
  createScriptUpdate,
  saveScriptUpdate,
} from '../../workflows/customized/storyboard/script-update';
import { updatePreview } from '../../workflows/customized/production/update-preview';
import { ProductionRepository } from '../../workflows/customized/production/production.repository';
import { CustomizedExtractionRepository } from '../../workflows/customized/information-extraction/customized-extraction.repository';

it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DATABASE_TEST !== '1')(
  'shares confirmed information across schemes while history, retries and candidate adoption stay isolated',
  async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw Error('Local isolated database required');
    const db = new PrismaService(new ConfigService({ DATABASE_URL: url }));
    const rollback = new Error('Controlled rollback: no model jobs may be published');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const p = randomUUID();
            await tx.project.create({ data: { id: p, name: '多方案共用商品信息回归' } });
            const run = (
              parent: string | null,
              node: string | null,
              scriptId: string | null = null,
              editing = false,
            ) =>
              tx.workflowRun.create({
                data: {
                  projectId: p,
                  workflow: 'CUSTOMIZED',
                  workflowSpace: 'CUSTOMIZED_PROJECT',
                  activeKey: null,
                  status: 'PAUSED',
                  parentWorkflowRunId: parent,
                  forkNodeId: node,
                  forkScriptId: scriptId,
                  branchPublishedAt: parent && !editing ? new Date() : null,
                  editSessionNodeId: editing ? 'INFORMATION_EXTRACTION' : null,
                },
              });
            const root = await run(null, null);
            const aId = randomUUID(),
              bId = randomUUID();
            const a = await run(root.id, 'STORYBOARD', aId),
              b = await run(root.id, 'STORYBOARD', bId);
            const headRun = await run(a.id, 'INFORMATION_EXTRACTION', aId);
            await tx.workflowRun.update({
              where: { id: headRun.id },
              data: { status: 'ACTIVE', activeKey: 'ACTIVE' },
            });
            const white = {
              ...emptyCustomizedBrief(),
              productName: '同一商品',
              productAppearance: '白色杯子',
              sellingPoints: ['保温'],
            };
            const black = { ...white, productAppearance: '黑色杯子' };
            const make = (
              r: string,
              key: string,
              payload: object,
              revision = 1,
              sourceArtifactId?: string,
            ) => {
              const input = {
                kind: 'STRUCTURED' as const,
                name:
                  key === 'customized-brief'
                    ? '视频创作信息卡'
                    : ((payload as { name?: string }).name ?? key),
                directory:
                  key === 'customized-brief' ? ('INSIGHTS' as const) : ('SCRIPTS' as const),
                type:
                  key === 'customized-brief'
                    ? ('INSIGHT_RESULT' as const)
                    : ('STORYBOARD_SCRIPT' as const),
                payload,
              };
              return tx.workingArtifact.create({
                data: {
                  projectId: p,
                  workflowRunId: r,
                  nodeId: key === 'customized-brief' ? 'INFORMATION_EXTRACTION' : 'STORYBOARD',
                  artifactKey: key,
                  ...input,
                  payload: payload as Prisma.InputJsonValue,
                  contentHash: workingArtifactContentHash(input),
                  revision,
                  sourceArtifactId: sourceArtifactId ?? null,
                },
              });
            };
            const packet = emptyCustomizedImportDraft();
            const rootPacket = await make(root.id, 'customized-source-package', packet);
            const originalBrief = await make(root.id, 'customized-brief', white);
            const aBrief = await make(a.id, 'customized-brief', white, 1, originalBrief.id);
            const bBrief = await make(b.id, 'customized-brief', white, 1, originalBrief.id);
            let head = await make(headRun.id, 'customized-brief', black, 2, originalBrief.id);
            for (const [value, at] of [
              [originalBrief, new Date(Date.now() - 10000)],
              [head, new Date()],
            ] as const) {
              await tx.workingArtifactRevisionSnapshot.create({
                data: {
                  projectId: p,
                  workflowRunId: value.workflowRunId,
                  workingArtifactId: value.id,
                  nodeId: value.nodeId,
                  artifactKey: value.artifactKey,
                  revision: value.revision,
                  contentHash: value.contentHash,
                  snapshot: { payload: value.payload },
                  confirmedAt: at,
                },
              });
            }
            for (const r of [a.id, b.id, headRun.id])
              await make(r, 'customized-source-package', packet, 1, rootPacket.id);
            const sourceFingerprint = workflowStateHash({
              artifactId: rootPacket.id,
              revision: 1,
              payload: packet,
            });
            for (const [r, fields] of [
              [root.id, white],
              [headRun.id, black],
            ] as const) {
              const candidate = { fields, fieldSources: {}, issues: [] };
              await tx.customizedExtractionResult.create({
                data: {
                  projectId: p,
                  workflowRunId: r,
                  taskId: randomUUID(),
                  sourceFingerprint,
                  generatedResult: candidate,
                  draftResult: candidate,
                },
              });
            }
            const story = (id: string, name: string): CustomizedStoryboardScript => ({
              id,
              name,
              synopsis: '拿起白色杯子阅读',
              structure: 'AI',
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
            });
            const sa = story(aId, '方案一'),
              sb = story(bId, '方案二');
            const aa = await make(a.id, `customized-script:${aId}`, sa),
              ba = await make(b.id, `customized-script:${bId}`, sb);
            for (const [r, id, script, artifact, brief] of [
              [a.id, aId, sa, aa, aBrief],
              [b.id, bId, sb, ba, bBrief],
            ] as const) {
              await tx.customizedStoryboardScript.create({
                data: {
                  id,
                  projectId: p,
                  sourceRunId: root.id,
                  workflowRunId: r,
                  sourceSnapshot: {
                    artifactId: originalBrief.id,
                    revision: 1,
                    fingerprint: originalBrief.contentHash,
                  },
                  status: 'COMPLETED',
                  origin: 'MANUAL',
                  draft: script as unknown as Prisma.InputJsonValue,
                },
              });
              await tx.workingArtifact.update({
                where: { id: artifact.id },
                data: { metadata: { confirmedBrief: white } },
              });
              await tx.workingArtifactDependency.create({
                data: {
                  projectId: p,
                  workflowRunId: r,
                  dependentArtifactId: artifact.id,
                  sourceType: 'WORKING_ARTIFACT',
                  sourceKey: 'customized-brief',
                  sourceArtifactId: brief.id,
                  sourceRevision: 1,
                  sourceHash: brief.contentHash,
                },
              });
              await setCustomizedInformationMode(tx, p, r, 'CURRENT');
            }
            const hidden = await run(a.id, 'INFORMATION_EXTRACTION', aId, true);
            await make(
              hidden.id,
              'customized-brief',
              { ...white, productAppearance: '未确认绿色' },
              9,
            );
            const unrelated = await run(null, null);
            const foreign = await make(
              unrelated.id,
              'customized-brief',
              { ...white, productAppearance: '其他资料来源紫色' },
              99,
            );
            const transactional = {
              $transaction: (fn: (value: Prisma.TransactionClient) => unknown) => fn(tx),
            } as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(db),
              repo = new StoryboardRepository(transactional, working),
              production = new ProductionRepository(transactional, working),
              extraction = new CustomizedExtractionRepository(transactional, working);
            await expect(
              working.commitValidatedArtifactsInTransaction(tx, p, b.id, 'STORYBOARD', [
                {
                  artifactKey: 'foreign-source-check',
                  input: {
                    kind: 'STRUCTURED',
                    name: '拒绝其他资料家族',
                    directory: 'SCRIPTS',
                    type: 'STORYBOARD_SCRIPT',
                    payload: sb,
                    dependencies: [
                      {
                        sourceType: 'WORKING_ARTIFACT',
                        sourceArtifactId: foreign.id,
                        sourceKey: 'customized-brief',
                        sourceRevision: foreign.revision,
                        sourceHash: foreign.contentHash,
                      },
                    ],
                  },
                },
              ]),
            ).rejects.toThrow('DEPENDENCY_CONFLICT');
            for (const [r, id] of [
              [a.id, aId],
              [b.id, bId],
              [a.id, aId],
            ] as const) {
              expect((await sharedCustomizedBrief(tx, p, r))?.id).toBe(head.id);
              const workspace = await repo.workspace(p, r);
              expect(workspace.selectedScriptId).toBe(id);
              expect(workspace.brief?.productAppearance).toBe('黑色杯子');
              expect(workspace.scripts.every((s) => s.stale)).toBe(true);
              expect((await extraction.workspace(p, r)).result?.fields.productAppearance).toBe(
                '黑色杯子',
              );
              expect(await extraction.workspaceSource(p, r)).toBe(headRun.id);
              const preview = await updatePreview(tx, p, r, 'SCRIPT', id);
              expect(preview.items.map((i) => i.id)).toEqual([id]);
              expect(preview.blockers).toEqual([]);
              expect((await production.workspace(p, r)).sourceReady).toBe(false);
            }
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: ba.id } })).revision,
            ).toBe(1);
            await setCustomizedInformationMode(tx, p, b.id, 'HISTORICAL');
            expect((await repo.workspace(p, b.id)).brief?.productAppearance).toBe('白色杯子');
            expect((await updatePreview(tx, p, b.id, 'SCRIPT', bId)).items).toEqual([]);
            await setCustomizedInformationMode(tx, p, b.id, 'PRESERVE');
            expect((await sharedCustomizedBrief(tx, p, b.id))?.id).toBe(bBrief.id);
            await setCustomizedInformationMode(tx, p, b.id, 'CURRENT');
            const preview = await updatePreview(tx, p, b.id, 'SCRIPT', bId);
            const task = await createScriptUpdate(
              tx,
              p,
              b.id,
              bId,
              'black-update',
              { version: 1, fingerprint: preview.fingerprint },
              { creative: 'controlled', detail: 'controlled' },
            );
            expect((task!.inputSnapshot as unknown as StoryboardInput).source.artifactId).toBe(
              head.id,
            );
            await setCustomizedInformationMode(tx, p, b.id, 'HISTORICAL');
            await (
              repo as unknown as {
                validSource(tx: Prisma.TransactionClient, t: typeof task): Promise<void>;
              }
            ).validSource(tx, task);
            const adopted = {
              ...sb,
              synopsis: '拿起黑色杯子阅读',
              story: { ...sb.story!, content: '她拿起黑色杯子，继续阅读。' },
            };
            const candidate = async (id: string, value: CustomizedStoryboardScript) => {
              await tx.customizedStoryboardTask.update({
                where: { id },
                data: { status: 'COMPLETED' },
              });
              await tx.customizedStoryboardStep.updateMany({
                where: { taskId: id, nodeId: 'SAVE' },
                data: {
                  status: 'SUCCEEDED',
                  output: { script: value } as unknown as Prisma.InputJsonValue,
                },
              });
            };
            await candidate(task!.id, adopted);
            await saveScriptUpdate(tx, working, p, b.id, task!.id, adopted);
            expect((await repo.workspace(p, b.id)).brief?.productAppearance).toBe('黑色杯子');
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: aa.id } })).payload,
            ).toEqual(sa);
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: aa.id } })).revision,
            ).toBe(1);
            expect((await sharedCustomizedBrief(tx, p, a.id))?.id).toBe(head.id);
            const blue = { ...black, productAppearance: '蓝色杯子' };
            head = await tx.workingArtifact.update({
              where: { id: head.id },
              data: {
                payload: blue,
                revision: 3,
                contentHash: workingArtifactContentHash({
                  kind: 'STRUCTURED',
                  name: head.name,
                  directory: head.directory,
                  type: head.type,
                  payload: blue,
                }),
              },
            });
            await tx.customizedExtractionResult.update({
              where: { projectId_workflowRunId: { projectId: p, workflowRunId: headRun.id } },
              data: {
                draftResult: { fields: blue, fieldSources: {}, issues: [] },
                generatedResult: { fields: blue, fieldSources: {}, issues: [] },
              },
            });
            await setCustomizedInformationMode(tx, p, b.id, 'CURRENT');
            expect((await repo.workspace(p, b.id)).scripts.every((s) => s.stale)).toBe(true);
            await expect(
              createScriptUpdate(
                tx,
                p,
                b.id,
                bId,
                'outdated-preview',
                { version: 1, fingerprint: preview.fingerprint },
                { creative: 'controlled', detail: 'controlled' },
              ),
            ).rejects.toThrow('更新范围已变化');
            const next = await updatePreview(tx, p, b.id, 'SCRIPT', bId);
            const second = await createScriptUpdate(
              tx,
              p,
              b.id,
              bId,
              'blue-update',
              { version: 1, fingerprint: next.fingerprint },
              { creative: 'controlled', detail: 'controlled' },
            );
            const blueScript = { ...adopted, synopsis: '拿起蓝色杯子阅读' };
            await candidate(second!.id, blueScript);
            await tx.workingArtifact.update({
              where: { id: head.id },
              data: {
                revision: 4,
                payload: { ...blue, productAppearance: '灰色杯子' },
                contentHash: 'changed-again',
              },
            });
            const grey = { ...blue, productAppearance: '灰色杯子' };
            await tx.customizedExtractionResult.update({
              where: { projectId_workflowRunId: { projectId: p, workflowRunId: headRun.id } },
              data: {
                draftResult: { fields: grey, fieldSources: {}, issues: [] },
                generatedResult: { fields: grey, fieldSources: {}, issues: [] },
              },
            });
            await expect(
              saveScriptUpdate(tx, working, p, b.id, second!.id, blueScript),
            ).rejects.toThrow('信息卡已变化');
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: ba.id } })).payload,
            ).toEqual(adopted);
            // Entering information edit seeds the current shared facts, not the selected scheme's frozen old copy.
            await tx.workflowRun.update({
              where: { id: headRun.id },
              data: { activeKey: null, status: 'PAUSED' },
            });
            await tx.workflowRun.update({
              where: { id: b.id },
              data: { activeKey: 'ACTIVE', status: 'ACTIVE' },
            });
            const edit = await beginCustomizedEdit(tx, p, b.id, 'INFORMATION_EXTRACTION');
            const seeded = await tx.workingArtifact.findFirstOrThrow({
              where: { projectId: p, workflowRunId: edit.id, artifactKey: 'customized-brief' },
            });
            expect((seeded.payload as typeof white).productAppearance).toBe('灰色杯子');
            const result = await tx.customizedExtractionResult.findUniqueOrThrow({
              where: { projectId_workflowRunId: { projectId: p, workflowRunId: edit.id } },
            });
            expect(
              (result.draftResult as unknown as { fields: typeof white }).fields.productAppearance,
            ).toBe('灰色杯子');
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
