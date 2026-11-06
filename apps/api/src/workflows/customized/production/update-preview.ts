import type {
  CustomizedUpdateNode,
  CustomizedUpdatePreview,
  ProductionDocument,
  ProductionAsset,
  StoryboardInput,
} from '@ai-marketing/contracts';
import { isVideoDocument, resolveCustomizedAssetImageSource } from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  customizedScope,
  customizedConflict,
  customizedPathScriptId,
} from '../../../platform/workflow/customized-branches';
import {
  sharedCustomizedBrief,
  scriptUsesBrief,
} from '../../../platform/workflow/customized-shared-brief';

export async function updatePreview(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
  node: CustomizedUpdateNode,
  targetId: string | null = null,
): Promise<CustomizedUpdatePreview> {
  const run = await tx.workflowRun.findFirst({
    where: { ...customizedScope(projectId), id: runId, status: { in: ['ACTIVE', 'PAUSED'] } },
  });
  if (!run || (await tx.project.count({ where: { id: projectId, deletionState: { not: null } } })))
    return customizedConflict('当前项目或工作流不可用');
  const rows = await tx.workingArtifact.findMany({
    where: { projectId, workflowRunId: runId },
    include: { dependencies: true },
  });
  const localBrief = rows.find((a) => a.artifactKey === 'customized-brief') ?? null;
  const sharedBrief = await sharedCustomizedBrief(tx, projectId, runId, localBrief);
  if (sharedBrief && !rows.some((a) => a.id === sharedBrief.id))
    rows.push({ ...sharedBrief, dependencies: [] });
  const drafts = await tx.workflowNodeState.findMany({
    where: { projectId, workflowRunId: runId },
    select: { nodeId: true, revision: true, contentHash: true },
  });
  const active = await tx.customizedProductionTask.findMany({
    where: { projectId, workflowRunId: runId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true, operation: true, inputSnapshot: true },
  });
  const get = (key: string) =>
    key === 'customized-brief' && sharedBrief
      ? { ...sharedBrief, dependencies: [] }
      : rows.find((a) => a.artifactKey === key && a.availability === 'AVAILABLE');
  const catalog = get('customized-asset-catalog');
  const assets = (catalog?.payload as unknown as { assets?: ProductionAsset[] })?.assets ?? [];
  const document = get('customized-video-plan')?.payload as unknown as
    ProductionDocument | undefined;
  const scriptId = customizedPathScriptId(run, rows);
  const script = get(`customized-script:${targetId && node === 'SCRIPT' ? targetId : scriptId}`);
  const blockers: string[] = [];
  const scriptTask =
    node === 'SCRIPT' && targetId
      ? await tx.customizedStoryboardTask.findFirst({
          where: {
            projectId,
            workflowRunId: runId,
            inputSnapshot: { path: ['incremental', 'scriptId'], equals: targetId },
          },
          orderBy: { createdAt: 'desc' },
          include: { steps: true },
        })
      : null;
  if (scriptTask?.status === 'COMPLETED') {
    const save = scriptTask.steps.find((s) => s.nodeId === 'SAVE')?.output as
      { applied?: boolean } | undefined;
    const input = scriptTask.inputSnapshot as unknown as StoryboardInput;
    const brief = get('customized-brief');
    // A candidate frozen against an older source must not prevent the next update round.
    // Saving that old candidate still independently rejects its stale baseline.
    if (
      !save?.applied &&
      input.incremental?.baselineRevision === script?.revision &&
      input.source?.artifactId === brief?.id &&
      input.source?.revision === brief?.revision &&
      input.source?.fingerprint === brief?.contentHash
    )
      blockers.push('已有待采用的脚本更新候选，请先查看候选');
  }
  if (
    run.editSessionNodeId &&
    !(node === 'INFORMATION_EXTRACTION' && run.editSessionNodeId === 'INFORMATION_EXTRACTION')
  )
    blockers.push('请先保存或取消当前节点编辑');
  if (
    active.some(
      (t) =>
        !targetId ||
        !['PROMPT', 'RENDER'].includes(node) ||
        !['PROMPT', 'RENDER'].includes(t.operation) ||
        (t.inputSnapshot as { target?: { id?: string } }).target?.id === targetId,
    )
  )
    blockers.push('当前制作任务尚未结束，请稍后更新');
  const prefix =
    node === 'ASSETS'
      ? 'customized-object:'
      : node === 'SHOTS'
        ? 'customized-video-clip:'
        : node === 'PROMPT'
          ? 'customized-clip-prompt:'
          : 'customized-clip-video:';
  const items: CustomizedUpdatePreview['items'] = [];
  if (node === 'INFORMATION_EXTRACTION') {
    const source = get('customized-source-package'),
      brief = get('customized-brief');
    if (!source || source.freshness !== 'CURRENT') blockers.push('请先确认资料包');
    if (source && (!brief || brief.freshness !== 'CURRENT'))
      items.push({
        id: source.id,
        name: '视频创作信息卡',
        action: brief ? 'UPDATE' : 'GENERATE',
        reason: '已确认资料与信息卡消费的来源存在差异',
      });
  } else if (node === 'SCRIPT') {
    const brief = get('customized-brief');
    if (!brief || brief.freshness !== 'CURRENT') blockers.push('请先确认当前信息卡');
    if (!script) blockers.push('当前路径没有可更新的已确认脚本');
    if (
      script &&
      brief &&
      (script.freshness !== 'CURRENT' ||
        !script.dependencies.some(
          (d) => d.sourceArtifactId === brief.id && d.sourceRevision === brief.revision,
        ))
    )
      items.push({
        id: targetId ?? scriptId!,
        name: script.name,
        action: 'UPDATE',
        reason: '信息卡已变化，需要核对当前脚本',
      });
  } else {
    if (
      !script ||
      script.freshness !== 'CURRENT' ||
      (sharedBrief && sharedBrief.id !== localBrief?.id && !scriptUsesBrief(script, sharedBrief))
    )
      blockers.push('请先保存并确认当前脚本');
    if (node !== 'ASSETS' && (!catalog || catalog.freshness !== 'CURRENT'))
      blockers.push('请先局部更新并确认资产目录');
    if (node === 'ASSETS') {
      for (const asset of assets) {
        const row = get(prefix + asset.id);
        if (!row || row.freshness !== 'CURRENT')
          items.push({
            id: asset.id,
            name: asset.name,
            action: row ? 'UPDATE' : 'GENERATE',
            reason: '脚本或信息卡来源已变化，需判断是否影响此资产',
          });
      }
      if (catalog?.freshness !== 'CURRENT' && !items.length)
        items.push({
          id: 'CATALOG',
          name: '资产目录',
          action: 'UPDATE',
          reason: '核对新脚本中的新增对象及已有对象依据',
        });
    } else if (!document || !isVideoDocument(document))
      blockers.push('历史分镜缺少可靠的局部更新基线，请使用本节点重新生成');
    else {
      for (const clip of document.videoPlan.clips.filter((c) => !targetId || c.id === targetId)) {
        const row = get(prefix + clip.id),
          clipRow = get('customized-video-clip:' + clip.id);
        let changed = !row || row.freshness !== 'CURRENT';
        if (node === 'SHOTS')
          changed =
            changed ||
            document.videoPlan.sources.some(
              (s) =>
                !rows.some(
                  (a) =>
                    a.id === s.id &&
                    a.revision === s.revision &&
                    a.contentHash === s.hash &&
                    a.freshness === 'CURRENT',
                ),
            );
        if (node === 'RENDER' && row) {
          const result = row.payload as { taskId?: string };
          const task = result.taskId
            ? await tx.customizedProductionTask.findFirst({
                where: { projectId, id: result.taskId },
              })
            : null;
          const refs = (
            task?.inputSnapshot as {
              videoRender?: {
                references?: { objectId: string; assetId: string; version: number }[];
              };
            }
          )?.videoRender?.references;
          if (!refs) changed = true;
          else
            changed =
              changed ||
              refs.some((ref) => {
                const current = resolveCustomizedAssetImageSource(assets, ref.objectId);
                return (
                  !current.ok ||
                  current.source.image?.assetId !== ref.assetId ||
                  current.source.image.version !== ref.version
                );
              });
        }
        if (changed)
          items.push({
            id: clip.id,
            name: clip.title,
            action: row ? 'UPDATE' : 'GENERATE',
            reason:
              node === 'SHOTS'
                ? '分镜来源已变化，需要核对本镜及衔接'
                : node === 'PROMPT'
                  ? '分镜内容或提示词来源已变化'
                  : '提示词、参考图片或视频来源已变化',
          });
        if (
          node === 'RENDER' &&
          changed &&
          (!get('customized-clip-prompt:' + clip.id) ||
            get('customized-clip-prompt:' + clip.id)?.freshness !== 'CURRENT' ||
            clipRow?.freshness !== 'CURRENT')
        )
          blockers.push(`请先更新“${clip.title}”的分镜与提示词`);
      }
    }
  }
  return {
    version: 1,
    workflowRunId: runId,
    node,
    targetId,
    items,
    blockers: [...new Set(blockers)],
    calls: items.length ? [node === 'RENDER' ? 'VIDEO' : 'TEXT'] : [],
    scope: 'DEPENDENCIES',
    fingerprint: workflowStateHash({
      runId,
      node,
      targetId,
      rows: rows
        .map((a) => [
          a.id,
          a.revision,
          a.contentHash,
          a.freshness,
          [...a.dependencies].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      drafts: drafts.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      active: active.map((a) => a.id).sort(),
      scriptTask: scriptTask ? [scriptTask.id, scriptTask.status] : null,
    }),
  };
}
