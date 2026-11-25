import { Inject, Injectable } from '@nestjs/common';
import {
  emptyAvatarDraft,
  estimateAvatarScriptDurationMs,
  FISSION_AVATAR_ARTIFACT_KEYS as ARTIFACT_KEYS,
  FISSION_AVATAR_DRAFT_NODE as DRAFT_NODE,
  FISSION_AVATAR_NODES as NODES,
  parseAvatarDraft,
  type AvatarAssetRef,
  type AvatarBindingContent,
  type AvatarConfirmed,
  type AvatarSaveDraftRequest,
  type AvatarScriptContent,
  type AvatarWorkspaceAsset,
  type AvatarWorkspaceData,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
  AVATAR_WORKFLOW_SCOPE,
  AVATAR_CHARACTER_TYPES,
  currentAvatarGrantWhere,
  findCurrentAvatarGrant,
  lockAvatarProject,
  lockAvatarRun,
} from '../../../platform/workflow/fission-avatar-scope';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

type Scope = { projectId: string; workflowRunId: string };
type AssetKind = 'character' | 'voice';

const grantIncludes = { version: { include: { asset: true } } } as const;
type Grant = Prisma.FissionAvatarAssetGrantGetPayload<{ include: typeof grantIncludes }>;

function previewKind(grant: Grant): AvatarWorkspaceAsset['previewKind'] {
  const { version } = grant;
  if (!version.asset.hasFile || !version.storageKey || version.sizeBytes <= 0) return null;
  if (version.asset.type === 'VOICE_PROFILE')
    return ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg'].includes(version.mimeType)
      ? 'AUDIO'
      : null;
  if (version.mimeType === 'video/mp4') return 'VIDEO';
  if (['image/jpeg', 'image/png', 'image/webp'].includes(version.mimeType)) return 'IMAGE';
  return null;
}

function grantKind(grant: Grant): AssetKind | null {
  if (grant.version.asset.type === 'VOICE_PROFILE') return 'voice';
  if (
    AVATAR_CHARACTER_TYPES.some((type) => type === grant.version.asset.type) &&
    previewKind(grant)
  )
    return 'character';
  return null;
}

export function sameAvatarAssetRef(
  left: AvatarAssetRef | null,
  right: AvatarAssetRef | null,
): boolean {
  return left?.assetId === right?.assetId && left?.version === right?.version;
}

function presentAsset(ids: Scope, grant: Grant): AvatarWorkspaceAsset {
  const kind = previewKind(grant);
  return {
    assetId: grant.assetId,
    version: grant.assetVersion,
    name: grant.version.asset.name,
    authorizationId: grant.id,
    previewKind: kind,
    previewUrl: kind
      ? `/api/projects/${ids.projectId}/workflow-runs/${ids.workflowRunId}/fission-avatar/assets/${grant.assetId}/versions/${grant.assetVersion}/content`
      : null,
  };
}

@Injectable()
export class AvatarRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}

  private draft(tx: Prisma.TransactionClient, ids: Scope) {
    return tx.workflowNodeState.findUniqueOrThrow({
      where: { projectId_workflowRunId_nodeId: { ...ids, nodeId: DRAFT_NODE } },
    });
  }

  private artifact(tx: Prisma.TransactionClient, ids: Scope, type: keyof typeof NODES) {
    return tx.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          ...ids,
          nodeId: NODES[type],
          artifactKey: ARTIFACT_KEYS[type],
        },
      },
      select: { id: true, revision: true, payload: true },
    });
  }

  private presentArtifact<T>(artifact: Awaited<ReturnType<AvatarRepository['artifact']>>) {
    return artifact
      ? ({
          artifactId: artifact.id,
          revision: artifact.revision,
          content: artifact.payload as unknown as T,
        } satisfies AvatarConfirmed<T>)
      : null;
  }

  private async readWorkspace(
    tx: Prisma.TransactionClient,
    ids: Scope,
    runStatus: AvatarWorkspaceData['runStatus'] = 'ACTIVE',
  ): Promise<AvatarWorkspaceData> {
    const draft = await this.draft(tx, ids);
    const binding = await this.artifact(tx, ids, 'binding');
    const script = await this.artifact(tx, ids, 'script');
    const grants = await tx.fissionAvatarAssetGrant.findMany({
      where: currentAvatarGrantWhere(ids.projectId, new Date()),
      include: grantIncludes,
      orderBy: [{ version: { asset: { name: 'asc' } } }, { assetVersion: 'desc' }, { id: 'asc' }],
    });
    const assets = { character: [] as AvatarWorkspaceAsset[], voice: [] as AvatarWorkspaceAsset[] };
    for (const grant of grants) {
      const kind = grantKind(grant);
      if (kind) assets[kind].push(presentAsset(ids, grant));
    }
    return {
      ...ids,
      runStatus,
      draft: { revision: draft.revision, data: parseAvatarDraft(draft.state) },
      binding: this.presentArtifact<AvatarBindingContent>(binding),
      script: this.presentArtifact<AvatarScriptContent>(script),
      characters: assets.character,
      voices: assets.voice,
    };
  }

  initialize(projectId: string, expectedWorkflowRunId?: string) {
    return this.db.$transaction(async (tx) => {
      await lockAvatarProject(tx, projectId);
      const key = { projectId, ...AVATAR_WORKFLOW_SCOPE, activeKey: 'ACTIVE' };
      const where = { projectId_workflow_workflowSpace_activeKey: key };
      const expectedRun = expectedWorkflowRunId ? await tx.workflowRun.findUnique({ where }) : null;
      if (expectedWorkflowRunId && expectedRun?.id !== expectedWorkflowRunId)
        throw new ApiHttpException('当前工作流已切换，请重新打开', 409, 'CONFLICT');
      let run =
        expectedRun ??
        (await tx.workflowRun.upsert({
          where,
          create: { ...key, currentNodeId: NODES.binding },
          update: {},
        }));
      const ids = { projectId, workflowRunId: run.id };
      if (run.status === 'PAUSED') {
        await tx.workflowNodeState.updateMany({
          where: { ...ids, nodeId: DRAFT_NODE },
          data: { revision: { increment: 1 } },
        });
        run = await tx.workflowRun.update({
          where: { id: run.id },
          data: { status: 'ACTIVE', lastActiveAt: new Date() },
        });
      } else if (run.status !== 'ACTIVE') {
        throw new ApiHttpException('该工作流已经结束', 409, 'CONFLICT');
      }
      const draft = emptyAvatarDraft();
      await tx.workflowNodeState.upsert({
        where: { projectId_workflowRunId_nodeId: { ...ids, nodeId: DRAFT_NODE } },
        create: { ...ids, nodeId: DRAFT_NODE, state: draft, contentHash: workflowStateHash(draft) },
        update: {},
      });
      return this.readWorkspace(tx, ids, run.status);
    });
  }

  workspace(ids: Scope) {
    return this.db.$transaction(async (tx) => {
      const run = await lockAvatarRun(tx, ids);
      return this.readWorkspace(tx, ids, run.status);
    });
  }

  private async grant(
    tx: Prisma.TransactionClient,
    projectId: string,
    asset: AvatarAssetRef,
    kind?: AssetKind,
  ): Promise<Grant> {
    const grant = await findCurrentAvatarGrant(tx, projectId, asset);
    const actualKind = grant && grantKind(grant);
    if (!grant || !actualKind || (kind && actualKind !== kind))
      throw new ApiHttpException('素材版本不可用或缺少数字人口播授权', 422, 'VALIDATION_ERROR');
    return grant;
  }

  private async editableDraft(tx: Prisma.TransactionClient, ids: Scope, expectedRevision: number) {
    await lockAvatarRun(tx, ids, true);
    const current = await this.draft(tx, ids);
    if (expectedRevision !== current.revision)
      throw new ApiHttpException('草稿已更新，请刷新后重试', 409, 'CONFLICT');
    return current;
  }

  saveDraft(ids: Scope, request: AvatarSaveDraftRequest) {
    return this.db.$transaction(async (tx) => {
      const draft = await this.editableDraft(tx, ids, request.expectedRevision);
      const previous = parseAvatarDraft(draft.state);
      const next = request.draft;
      for (const kind of ['character', 'voice'] as const) {
        const asset = next[kind];
        if (asset && !sameAvatarAssetRef(asset, previous[kind]))
          await this.grant(tx, ids.projectId, asset, kind);
      }
      const contentHash = workflowStateHash(next);
      if (contentHash !== draft.contentHash) {
        await tx.workflowNodeState.update({
          where: { id: draft.id },
          data: {
            state: next,
            contentHash,
            revision: { increment: 1 },
            savedAt: new Date(),
          },
        });
        await tx.workflowRun.update({
          where: { id: ids.workflowRunId },
          data: { lastActiveAt: new Date() },
        });
      }
      return this.readWorkspace(tx, ids);
    });
  }

  confirmBinding(ids: Scope, expectedRevision: number) {
    return this.db.$transaction(async (tx) => {
      const draft = await this.editableDraft(tx, ids, expectedRevision);
      const { character } = parseAvatarDraft(draft.state);
      if (!character)
        throw new ApiHttpException('请先选择已授权的数字人形象', 400, 'VALIDATION_ERROR');
      const grant = await this.grant(tx, ids.projectId, character, 'character');
      const payload: AvatarBindingContent = { character, authorizationId: grant.id };
      await this.working.upsertArtifactInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        NODES.binding,
        ARTIFACT_KEYS.binding,
        {
          kind: 'STRUCTURED',
          name: '数字人形象绑定',
          directory: 'VISUAL_ASSETS',
          type: 'AVATAR_REFERENCE',
          payload,
        },
      );
      await tx.workflowRun.update({
        where: { id: ids.workflowRunId },
        data: { currentNodeId: NODES.script, lastActiveAt: new Date() },
      });
      return this.readWorkspace(tx, ids);
    });
  }

  confirmScript(ids: Scope, expectedRevision: number) {
    return this.db.$transaction(async (tx) => {
      const draft = await this.editableDraft(tx, ids, expectedRevision);
      const { character, scriptText, scriptSource } = parseAvatarDraft(draft.state);
      const binding = this.presentArtifact<AvatarBindingContent>(
        await this.artifact(tx, ids, 'binding'),
      );
      if (!binding || !sameAvatarAssetRef(character, binding.content.character))
        throw new ApiHttpException('请先确认数字人形象', 422, 'VALIDATION_ERROR');
      const grant = await this.grant(tx, ids.projectId, binding.content.character, 'character');
      if (grant.id !== binding.content.authorizationId)
        throw new ApiHttpException('形象授权已变更，请重新确认形象', 422, 'VALIDATION_ERROR');
      const text = scriptText.replace(/\r\n?/g, '\n').trim();
      const estimatedDurationMs = estimateAvatarScriptDurationMs(text);
      if (!estimatedDurationMs)
        throw new ApiHttpException('请输入有效的口播文案', 400, 'VALIDATION_ERROR');
      const priorScript = this.presentArtifact<AvatarScriptContent>(
        await this.artifact(tx, ids, 'script'),
      );
      if (priorScript?.content.text === text) return this.readWorkspace(tx, ids);
      const payload: AvatarScriptContent = {
        text,
        language: 'zh-CN',
        source: scriptSource,
        estimatedDurationMs,
      };
      await this.working.upsertArtifactInTransaction(
        tx,
        ids.projectId,
        ids.workflowRunId,
        NODES.script,
        ARTIFACT_KEYS.script,
        {
          kind: 'STRUCTURED',
          name: '数字人口播文案',
          directory: 'SCRIPTS',
          type: 'SCRIPT_COPY',
          payload,
        },
      );
      await tx.workflowRun.update({
        where: { id: ids.workflowRunId },
        data: { currentNodeId: NODES.script, lastActiveAt: new Date() },
      });
      return this.readWorkspace(tx, ids);
    });
  }

  async assertPreview(ids: Scope, asset: AvatarAssetRef) {
    await this.db.$transaction(async (tx) => {
      await lockAvatarRun(tx, ids);
      const grant = await this.grant(tx, ids.projectId, asset);
      if (!previewKind(grant))
        throw new ApiHttpException('素材预览文件不存在', 404, 'ASSET_NOT_FOUND');
    });
  }
}
