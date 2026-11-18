import {
  CLONE_GENERATION_LIMITS,
  type CloneGenerationPlan,
  type CloneGenerationVariant,
  type CloneGenerationVariantDraft,
  type CloneGenerationVariantReview,
} from '@ai-marketing/contracts';

export function requireClonePlanningCapability(
  plan: CloneGenerationPlan,
  count: number,
  model?: string,
) {
  if (!Number.isInteger(count) || count < 1 || count > CLONE_GENERATION_LIMITS.maxCount)
    throw new TypeError('成片数量超出当前能力');
  if (count <= CLONE_GENERATION_LIMITS.maxUnplannedCount) return;
  if (!model) throw new TypeError('差异化规划尚未启用，当前最多生成两条');
  const available = plan.shots.some((shot) =>
    shot.targets.some(
      (target) =>
        target.type === 'scene' &&
        target.allowedVariations.some((dimension) => dimension.trim().length > 0),
    ),
  );
  if (!available) throw new TypeError('生成三条及以上前，请在元素映射中设置场景的可变化维度');
}

export function validateCloneVariantDraft(
  plan: CloneGenerationPlan,
  variantIds: readonly string[],
  draft: CloneGenerationVariantDraft,
  version?: 2,
) {
  if (draft.version !== version || draft.variants.length !== variantIds.length)
    throw new TypeError('差异化规划的契约版本或条目数量无效');
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const directions = new Set<string>();
  for (const [index, item] of draft.variants.entries()) {
    const affected = plan.shots.filter((shot) =>
      shot.targets.some((target) => target.elementId === item.elementId),
    );
    if (
      item.variantId !== variantIds[index] ||
      affected.length === 0 ||
      !item.dimension.trim() ||
      affected.some(({ targets }) => {
        const target = targets.find((entry) => entry.elementId === item.elementId);
        return target?.type !== 'scene' || !target.allowedVariations.includes(item.dimension);
      })
    )
      throw new TypeError('差异化规划的条目或场景变化维度无效');
    let key: string;
    if ('shotDirections' in item) {
      if (
        item.shotDirections.length !== affected.length ||
        item.shotDirections.some(
          (entry, slot) => entry.shotId !== affected[slot]?.shotId || !normalize(entry.direction),
        )
      )
        throw new TypeError('差异化规划需按顺序覆盖所选场景的全部镜头');
      key = JSON.stringify(
        item.shotDirections.map(({ shotId, direction }) => [shotId, normalize(direction)]),
      );
    } else {
      key = normalize(item.direction);
    }
    if (!key || directions.has(key)) throw new TypeError('差异化规划的场景安排无效或重复');
    directions.add(key);
  }
}

export function validateCloneVariantReview(
  variantIds: readonly string[],
  review: CloneGenerationVariantReview,
) {
  if (
    review.checks.length !== variantIds.length ||
    review.checks.some(
      (check, index) =>
        check.variantId !== variantIds[index] || check.verdict !== 'PASSED' || !check.reason.trim(),
    )
  )
    throw new TypeError('差异化审查未覆盖或未通过全部成片');
}

export function compileCloneVariant(
  plan: CloneGenerationPlan,
  variant: CloneGenerationVariant,
): CloneGenerationPlan {
  return {
    ...plan,
    shots: plan.shots.map((shot) => {
      const variation =
        'shotDirections' in variant
          ? variant.shotDirections.find((entry) => entry.shotId === shot.shotId)
          : variant;
      if (!variation) return shot;
      return {
        ...shot,
        targets: shot.targets.map((target) =>
          target.elementId === variant.elementId
            ? {
                ...target,
                variation: {
                  dimension: variant.dimension,
                  direction: variation.direction,
                  ...('shotDirections' in variant && { scope: 'SHOT' as const }),
                },
              }
            : target,
        ),
      };
    }),
  };
}
