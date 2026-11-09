import {
  isVideoAudit,
  type ProductionInput,
  type ProductionVideoDocument,
} from '@ai-marketing/contracts';
import {
  validateIncrementalVideoScope,
  validateVideoSnapshot,
  videoHash,
} from './video-production.domain';

type LocalReviewCheckpoint = {
  localCandidate?: { plan: unknown; changes: unknown };
  value?: unknown;
  audit?: unknown;
  auditHash?: unknown;
  failureReason?: unknown;
  localReviewPolicyVersion?: unknown;
  localSourceOffsetCount?: unknown;
};

export function hasLocalShotReview(output: unknown) {
  const saved = output as LocalReviewCheckpoint | null;
  return !!saved?.localCandidate && !!saved.audit;
}

function isLegacyLocalShotReview(output: unknown) {
  const saved = output as LocalReviewCheckpoint | null;
  return (
    saved?.failureReason === 'REVIEW_UNRESOLVED' &&
    saved.localReviewPolicyVersion === undefined &&
    hasLocalShotReview(saved)
  );
}

export function sameLocalShotReviewScope(current: ProductionInput, previous: ProductionInput) {
  if (
    current.operation !== 'SHOTS' ||
    previous.operation !== 'SHOTS' ||
    !current.incremental ||
    !previous.incremental ||
    current.shotWorkflowVersion !== 2 ||
    previous.shotWorkflowVersion !== 2 ||
    current.draftRevision !== previous.draftRevision
  )
    return false;
  const frozen = (input: ProductionInput) => [
    input.sources,
    input.script,
    input.brief,
    input.document,
    input.sourceUnits,
    input.durationPolicy,
    input.renderCapability,
    input.strategyVersion,
    input.shotDurationStepMs,
    [...input.incremental!.targetIds].sort(),
  ];
  return videoHash(frozen(current)) === videoHash(frozen(previous));
}

/** Reuse only the already checked candidate and its own review from this same frozen scope. */
export function reusableLocalShotReview(
  current: ProductionInput,
  previous: ProductionInput,
  output: unknown,
) {
  if (!isLegacyLocalShotReview(output) || !sameLocalShotReviewScope(current, previous)) return null;
  const saved = output as LocalReviewCheckpoint;
  const candidate = saved.localCandidate!;
  const document = { schemaVersion: 2, assets: current.document.assets, videoPlan: candidate.plan };
  if (
    !candidate.plan ||
    !saved.value ||
    !isVideoAudit(saved.audit) ||
    saved.auditHash !== videoHash(candidate.plan) ||
    videoHash(document) !== videoHash(saved.value) ||
    validateVideoSnapshot(document, current) ||
    validateIncrementalVideoScope(document as ProductionVideoDocument, current, candidate.changes)
  )
    return null;
  return {
    localCandidate: candidate,
    audit: saved.audit,
    auditHash: saved.auditHash,
    ...(Number.isInteger(saved.localSourceOffsetCount)
      ? { localSourceOffsetCount: saved.localSourceOffsetCount }
      : {}),
  };
}
