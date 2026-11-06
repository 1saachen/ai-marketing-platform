import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { it, expect } from 'vitest';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { rebindUnchanged } from './unchanged-media';
it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'local rebind handles two source rounds without changing sibling artifacts or content revision',
  async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Local isolated database required');
    const db = new PrismaService(new ConfigService({ DATABASE_URL: url })),
      p = randomUUID();
    try {
      await db.project.create({ data: { id: p, name: 'local-update isolated test' } });
      const working = new WorkflowWorkingRepository(db),
        run = await working.initializeCustomizedRun(p);
      const sibling = await db.workflowRun.create({
        data: {
          projectId: p,
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          status: 'PAUSED',
          activeKey: null,
          parentWorkflowRunId: run.id,
        },
      });
      const make = (r: string, key: string, payload: object) =>
        db.workingArtifact.create({
          data: {
            projectId: p,
            workflowRunId: r,
            nodeId: 'SHOT_RENDER',
            artifactKey: key,
            name: key,
            kind: 'STRUCTURED',
            directory: 'SCRIPTS',
            type: 'STORYBOARD_SCRIPT',
            payload,
            contentHash: workflowStateHash(payload),
          },
        });
      let source = await make(run.id, 'customized-shot:a', { visual: '第一轮' });
      const target = await make(run.id, 'customized-clip-prompt:a', { content: '保持的提示词' }),
        other = await make(sibling.id, 'customized-clip-prompt:a', { content: '兄弟版本' });
      for (const content of ['第二轮', '第三轮']) {
        source = await db.workingArtifact.update({
          where: { id: source.id },
          data: {
            payload: { visual: content },
            revision: { increment: 1 },
            contentHash: workflowStateHash(content),
          },
        });
        await db.$transaction((tx) => rebindUnchanged(tx, p, run.id, target.id, [source]));
        const saved = await db.workingArtifact.findUniqueOrThrow({
          where: { id: target.id },
          include: { dependencies: true },
        });
        expect(saved.revision).toBe(1);
        expect(saved.dependencies[0]?.sourceRevision).toBe(source.revision);
      }
      const oldSibling = await db.workingArtifact.findUniqueOrThrow({ where: { id: other.id } });
      expect(oldSibling.payload).toEqual({ content: '兄弟版本' });
      expect(oldSibling.revision).toBe(1);
    } finally {
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: p } });
      await db.$disconnect();
    }
  },
);
