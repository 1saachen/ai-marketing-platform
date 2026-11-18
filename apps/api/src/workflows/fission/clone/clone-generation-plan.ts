import {
  CLONE_GENERATION_LIMITS,
  compileCloneFrameTimeline,
  parseCloneGenerationPlan,
  validateCloneMappingForReport,
  validateCloneVisualOnlyReport,
  type CloneAnalysisReport,
  type CloneGenerationCount,
  type CloneGenerationImage,
  type CloneGenerationPlan,
  type CloneGenerationPreflight,
  type CloneGenerationShot,
  type CloneInputDraft,
  type CloneMappingDraft,
} from '@ai-marketing/contracts';

type ConfirmedGenerationSources = Pick<
  CloneGenerationPlan,
  'projectId' | 'workflowRunId' | 'sources'
> & {
  input: CloneInputDraft;
  report: CloneAnalysisReport;
  mapping: CloneMappingDraft;
  images: CloneGenerationImage[];
};

export function compileCloneGenerationPlan({
  projectId,
  workflowRunId,
  sources,
  input,
  report,
  mapping,
  images,
}: ConfirmedGenerationSources): CloneGenerationPlan {
  const limits = CLONE_GENERATION_LIMITS;
  validateCloneVisualOnlyReport(report);
  validateCloneMappingForReport(mapping, report, true);
  if (!input.sourceRightsConfirmed || !input.productName || !input.productFacts)
    throw new TypeError('请先确认目标商品事实与素材使用权');
  if (report.durationMs > limits.maxDurationMs || report.shots.length > limits.maxShots)
    throw new TypeError('当前生成路径最多支持 15 秒、4 个镜头');
  if (report.visual.stickers.length || report.visual.subtitles.length)
    throw new TypeError('当前生成路径不支持字幕或贴纸');
  const { frameWidth, frameHeight } = report;
  const portrait = frameWidth * 16 === frameHeight * 9;
  if (!portrait && frameWidth * 9 !== frameHeight * 16)
    throw new TypeError('当前生成路径仅支持 9:16 或 16:9 参考画幅');
  if (!mapping.structureLock) throw new TypeError('确认映射缺少结构锁定');
  const timeline = compileCloneFrameTimeline(mapping.structureLock, {
    fpsNumerator: limits.fpsNumerator,
    fpsDenominator: limits.fpsDenominator,
  });
  if (!mapping.bindings.some((binding) => binding.type === 'product'))
    throw new TypeError('确认报告至少需要一个待替换商品元素');

  const byVersion = new Map(images.map((image) => [imageKey(image), image]));
  const used = new Map<string, CloneGenerationImage>();
  const targets = new Map<string, CloneGenerationShot['targets'][number]>();
  for (const binding of mapping.bindings) {
    const { elementId, type, action, target } = binding;
    if ((type !== 'product' && type !== 'scene') || action !== 'REPLACE' || !target)
      throw new TypeError('当前生成路径仅支持替换商品或场景元素');
    if (type === 'product' && !target.asset)
      throw new TypeError('每个商品元素都需绑定已确认的目标商品图片版本');
    const image = target.asset ? byVersion.get(imageKey(target.asset)) : undefined;
    if (target.asset && (!image || !validImage(image)))
      throw new TypeError('目标图片版本不可用或超出尺寸、画幅及 4 MiB 限制');
    if (image) used.set(image.fileObjectId, image);
    targets.set(elementId, {
      elementId,
      type,
      imageFileObjectId: image?.fileObjectId ?? null,
      description: target.text,
      style: target.style,
      lockedAttributes: target.lockedAttributes,
      allowedVariations: target.allowedVariations,
    });
  }
  const shots = timeline.shots.map((shot, index): CloneGenerationShot => {
    const detail = report.shots[index]!;
    const shotTargets = detail.elementIds.map((id) => targets.get(id)!);
    const imageCount = new Set(
      shotTargets.flatMap((target) => (target.imageFileObjectId ? [target.imageFileObjectId] : [])),
    ).size;
    if (imageCount > limits.maxImagesPerShot) throw new TypeError('单镜头最多支持 4 张目标参考图');
    const renderSeconds = Math.max(
      limits.minRenderSeconds,
      Math.ceil(
        ((shot.endFrame - shot.startFrame) * timeline.fpsDenominator) / timeline.fpsNumerator,
      ),
    );
    return {
      shotId: shot.shotId,
      renderSeconds,
      framing: detail.framing,
      cameraMovement: detail.cameraMovement,
      composition: detail.composition,
      targets: shotTargets,
    };
  });
  return parseCloneGenerationPlan({
    schemaVersion: 1,
    projectId,
    workflowRunId,
    sources,
    mode: 'SEEDANCE_2_0_SILENT_CUT',
    ratio: portrait ? '9:16' : '16:9',
    width: portrait ? 720 : 1280,
    height: portrait ? 1280 : 720,
    sourceHasAudio: report.audio.hasAudio,
    productName: input.productName,
    productFacts: input.productFacts,
    images: [...used.values()],
    timeline,
    shots,
  });
}

function imageKey(ref: { assetId: string; version: number }) {
  return `${ref.assetId}:${ref.version}`;
}

function validImage(image: CloneGenerationImage) {
  const limits = CLONE_GENERATION_LIMITS;
  return (
    ['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType) &&
    image.sizeBytes > 0 &&
    image.sizeBytes <= limits.maxImageBytes &&
    [image.width, image.height].every(
      (side) => side >= limits.minImageSide && side <= limits.maxImageSide,
    ) &&
    image.width * 5 >= image.height * 2 &&
    image.height * 5 >= image.width * 2
  );
}

export function summarizeCloneGenerationPlan(
  plan: CloneGenerationPlan,
  count: CloneGenerationCount = 1,
): CloneGenerationPreflight {
  const { mode, ratio, width, height, timeline, sourceHasAudio } = plan;
  const shots = plan.shots.map(({ shotId, renderSeconds }) => ({ shotId, renderSeconds }));
  return {
    mode,
    ratio,
    width,
    height,
    timeline,
    sourceHasAudio,
    shots,
    sourceMapping: plan.sources.mapping,
    count,
    totalRenderSeconds: count * shots.reduce((sum, shot) => sum + shot.renderSeconds, 0),
  };
}
