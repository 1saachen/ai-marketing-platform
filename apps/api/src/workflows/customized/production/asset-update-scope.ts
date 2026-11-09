import {
  isAssetUpdatePlan,
  isProductionAsset,
  ASSET_FIELD_LABELS,
  type ProductionDocument,
  type ProductionInput,
  type ProductionTask,
} from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { picturedAssetOwners } from './asset-image-refresh';

export function assetUpdateScope(
  input: ProductionInput,
  output: unknown,
): ProductionTask['assetUpdateScope'] {
  if (input.assetUpdateVersion !== 1) return undefined;
  const plan = (output as { assetUpdatePlan?: unknown } | null)?.assetUpdatePlan;
  if (!isAssetUpdatePlan(plan)) return undefined;
  const before = new Map(input.document.assets.map((a) => [a.id, a]));
  if (
    plan.decisions.length !== before.size ||
    new Set(plan.decisions.map((d) => d.assetId)).size !== before.size ||
    plan.decisions.some((d) => !before.has(d.assetId))
  )
    return undefined;
  const saved = output as { final?: { assets?: unknown[] }; assetUpdateBase?: unknown[] };
  const rawCandidates = saved.final?.assets ?? saved.assetUpdateBase;
  const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
  const readable = (value: string) => {
    let result = value;
    for (const asset of before.values()) result = result.split(asset.id).join(asset.name);
    return result.replace(
      /\b(name|description|knownFacts|designNotes|sourceText|imageRequirements|preparation|sources)\b/g,
      (field) => ASSET_FIELD_LABELS[field] ?? '原文依据',
    );
  };
  const withoutQuotes = (a: ProductionInput['document']['assets'][number]) => ({
    ...a,
    ...(a.preparation ? { preparation: { ...a.preparation, sources: [] } } : {}),
  });
  const action = (
    d: (typeof plan.decisions)[number],
  ): NonNullable<ProductionTask['assetUpdateScope']>[number]['action'] => {
    const old = before.get(d.assetId)!;
    const next = candidates.find((a) => isProductionAsset(a) && a.id === old.id);
    if (isProductionAsset(next)) {
      if (workflowStateHash(old) === workflowStateHash(next)) return 'KEEP';
      if (workflowStateHash(withoutQuotes(old)) === workflowStateHash(withoutQuotes(next)))
        return 'SYNC';
    }
    return d.fields.length ? 'UPDATE' : 'KEEP';
  };
  return [
    ...plan.decisions.map((d) => ({
      name: before.get(d.assetId)!.name,
      action: action(d),
      reason: readable(d.reason),
    })),
    ...plan.additions.map((a) => ({
      name: a.name,
      action: 'ADD' as const,
      reason: readable(a.usage),
    })),
  ];
}

export function validateAssetUpdateScope(
  output: ProductionDocument,
  input: ProductionInput,
  checkpoint: unknown,
): string | null {
  if (input.assetUpdateVersion !== 1) return null;
  const plan = (checkpoint as { assetUpdatePlan?: unknown } | null)?.assetUpdatePlan;
  if (!isAssetUpdatePlan(plan) || !assetUpdateScope(input, checkpoint))
    return '资产更新缺少完整有效的模型判断范围';
  if (input.assetImageRefresh?.scopeVersion === 1) {
    const owners = picturedAssetOwners(input.document.assets);
    const ids = new Set(plan.imageDecisions?.map((decision) => decision.assetId));
    if (
      ids.size !== plan.imageDecisions?.length ||
      ids.size !== owners.length ||
      owners.some((asset) => !ids.has(asset.id))
    )
      return '图片判断缺少当前参考图主体，请重新核对范围';
  }
  if (plan.blockers.length) return '资产更新存在待人工核对的问题';
  const before = new Map(input.document.assets.map((a) => [a.id, a]));
  const expected = new Set([
    ...before.keys(),
    ...plan.additions.map((_, i) => `asset-${input.identitySeed}-${i + 1}`),
  ]);
  if (output.assets.length !== expected.size || output.assets.some((a) => !expected.has(a.id)))
    return '资产更新不能删除对象或新增范围外的对象';
  for (const decision of plan.decisions) {
    if (new Set(decision.fields).size !== decision.fields.length) return '资产更新字段重复';
    const old = before.get(decision.assetId)!;
    const next = output.assets.find((a) => a.id === old.id);
    if (!next) return '资产更新不能删除已有对象';
    const omit = (a: object) =>
      Object.fromEntries(
        Object.entries(a).filter(
          ([key]) => !decision.fields.includes(key as (typeof decision.fields)[number]),
        ),
      );
    if (workflowStateHash(omit(old)) !== workflowStateHash(omit(next)))
      return '资产更新改写了判断范围外的内容或图片';
  }
  for (const [index, addition] of plan.additions.entries()) {
    const value = output.assets.find((a) => a.id === `asset-${input.identitySeed}-${index + 1}`);
    if (!value || value.kind !== addition.kind || value.image != null || value.imageBasis != null)
      return '新增资产身份、类别或图片绑定不正确';
  }
  return null;
}
