import {
  resolveCustomizedAssetImageSource,
  type AssetImageDecision,
  type ProductionAsset,
} from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { assetImageBasis } from './asset-preparation.domain';

export function picturedAssetOwners(assets: ProductionAsset[]) {
  return assets.filter((asset) => {
    if (!asset.image) return false;
    const owner = resolveCustomizedAssetImageSource(assets, asset.id);
    return owner.ok && owner.source.id === asset.id;
  });
}

function hasVisualDefinition(asset: ProductionAsset) {
  return typeof asset.description === 'string' && !!asset.description.trim();
}

export function pendingAssetImages(assets: ProductionAsset[]) {
  return picturedAssetOwners(assets).filter(
    (asset) =>
      hasVisualDefinition(asset) && asset.imageBasis && asset.imageBasis !== assetImageBasis(asset),
  );
}

function imageInputsByOwner(assets: ProductionAsset[]) {
  const byOwner = new Map<string, { id: string; basis: string }[]>();
  for (const asset of assets) {
    const owner = resolveCustomizedAssetImageSource(assets, asset.id);
    if (!owner.ok) continue;
    const items = byOwner.get(owner.source.id) ?? [];
    items.push({
      id: asset.id,
      basis: workflowStateHash([assetImageBasis(asset), asset.preparation?.questions ?? []]),
    });
    byOwner.set(owner.source.id, items);
  }
  for (const items of byOwner.values()) items.sort((a, b) => a.id.localeCompare(b.id));
  return byOwner;
}

export function assetImageReviewItems(
  assets: ProductionAsset[],
  retained?: ReadonlyMap<string, string>,
) {
  const pending = pendingAssetImages(assets);
  if (!pending.length) return [];
  const inputs = imageInputsByOwner(assets);
  return pending
    .map((asset) => ({
      asset,
      fingerprint: workflowStateHash([asset.image, asset.imageBasis, inputs.get(asset.id)]),
    }))
    .filter(({ asset, fingerprint }) => retained?.get(asset.id) !== fingerprint);
}

/** Match the image producer's ownership and exclude evidence-only metadata from visual changes. */
export function planAssetImageRefresh(
  previous: ProductionAsset[],
  updated: ProductionAsset[],
  decisions?: AssetImageDecision[],
  retained?: ReadonlyMap<string, string>,
) {
  const before = imageInputsByOwner(previous);
  const after = imageInputsByOwner(updated);
  const pending = new Set(pendingAssetImages(updated).map((asset) => asset.id));
  const alreadyPending = new Set(
    assetImageReviewItems(previous, retained).map(({ asset }) => asset.id),
  );
  const action = new Map(decisions?.map((decision) => [decision.assetId, decision.action]));
  const originals = new Map(previous.map((asset) => [asset.id, asset]));
  const assetIds: string[] = [];
  const changes = new Map<string, ProductionAsset>();
  for (const asset of picturedAssetOwners(updated).filter(hasVisualDefinition)) {
    const oldBasis = workflowStateHash(before.get(asset.id) ?? []);
    const changed = oldBasis !== workflowStateHash(after.get(asset.id) ?? []);
    if (decisions) {
      if (!changed) continue;
      const decision = action.get(asset.id);
      if (decision === 'KEEP') {
        // Preserve an older pending reason. Only discard a newly introduced false alarm.
        const original = originals.get(asset.id);
        if (pending.has(asset.id) && !alreadyPending.has(asset.id) && original) {
          const { imageBasis: _basis, ...retained } = asset;
          changes.set(
            asset.id,
            original.imageBasis ? { ...retained, imageBasis: assetImageBasis(asset) } : retained,
          );
        }
        continue;
      }
      if (decision === 'UPDATE') assetIds.push(asset.id);
    } else {
      if (!changed && !pending.has(asset.id)) continue;
      assetIds.push(asset.id);
    }
    // Included objects can change the parent image without changing its own definition.
    if (!pending.has(asset.id)) changes.set(asset.id, { ...asset, imageBasis: oldBasis });
  }
  return { assetIds, assets: updated.map((asset) => changes.get(asset.id) ?? asset) };
}
