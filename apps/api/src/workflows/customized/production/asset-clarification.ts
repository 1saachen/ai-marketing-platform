import {
  CUSTOMIZED_BRIEF_LABELS,
  isAssetClarificationProposal,
  isCustomizedBrief,
  type AssetClarificationProposal,
  type AssetClarificationReview,
  type CustomizedBrief,
  type ProductionInput,
} from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { assetReviewText } from './asset-execution-detail';

export type ClarificationOutput = {
  final?: AssetClarificationProposal;
  decision?: {
    state: 'ADOPTED' | 'DISMISSED';
    nextTaskId?: string;
    brief?: ProductionInput['sources'][number];
  };
};

export function assetBlockers(input: ProductionInput, output: unknown): string[] {
  if (input.assetUpdateVersion !== 1 || input.operation !== 'ASSETS') return [];
  const items = (output as { assetUpdatePlan?: { blockers?: unknown } } | null)?.assetUpdatePlan
    ?.blockers;
  return Array.isArray(items)
    ? items.filter((v): v is string => typeof v === 'string' && !!v.trim())
    : [];
}

export function clarificationChanges(brief: CustomizedBrief, proposal: AssetClarificationProposal) {
  return proposal.changes
    .map(({ field, value }) => ({
      field,
      before: brief[field],
      after: Array.isArray(value) ? value.map((v) => v.trim()) : value.trim(),
    }))
    .filter(({ before, after }) => workflowStateHash(before) !== workflowStateHash(after));
}

export function clarificationReview(
  input: ProductionInput,
  output: ClarificationOutput | null,
  completed: boolean,
): AssetClarificationReview | undefined {
  if (!input.assetClarification) return;
  const proposal = output?.final;
  const brief = input.brief;
  return {
    explanation: input.assetClarification.explanation,
    state: output?.decision?.state ?? 'PENDING',
    ...(completed && isAssetClarificationProposal(proposal) && isCustomizedBrief(brief)
      ? {
          proposal: {
            changes: clarificationChanges(brief, proposal).map(({ field, before, after }) => ({
              label: CUSTOMIZED_BRIEF_LABELS[field],
              before,
              after,
            })),
            productionNote: proposal.productionNote.trim(),
            questions: [...new Set(proposal.questions.map(assetReviewText))],
          },
        }
      : {}),
  };
}
