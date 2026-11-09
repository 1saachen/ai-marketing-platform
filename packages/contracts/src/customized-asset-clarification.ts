import { CUSTOMIZED_BRIEF_LABELS, type CustomizedBriefField } from './customized-extraction';

export const ASSET_CLARIFICATION_MAX_LENGTH = 4000;
export type AssetClarificationRequest = {
  workflowRunId: string;
  explanation: string;
  idempotencyKey: string;
};
export type AssetClarificationDecision = {
  workflowRunId: string;
  adopt: boolean;
  refreshAssetImages?: true;
};
export type AssetClarificationInput = {
  version: 1;
  priorTaskId: string;
  explanation: string;
  questions: string[];
};
export type AssetClarificationProposal = {
  changes: { field: CustomizedBriefField; value: string | string[] }[];
  productionNote: string;
  questions: string[];
};
export type AssetClarificationReview = {
  explanation: string;
  state: 'PENDING' | 'ADOPTED' | 'DISMISSED';
  proposal?: Omit<AssetClarificationProposal, 'changes'> & {
    changes: { label: string; before: string | string[]; after: string | string[] }[];
  };
};

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const boundedText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;
export function isAssetClarificationProposal(v: unknown): v is AssetClarificationProposal {
  if (
    !record(v) ||
    Object.keys(v).length !== 3 ||
    !boundedText(v.productionNote, ASSET_CLARIFICATION_MAX_LENGTH) ||
    !Array.isArray(v.questions) ||
    v.questions.length > 12 ||
    !v.questions.every((q) => boundedText(q, 2000) && !!q.trim()) ||
    !Array.isArray(v.changes) ||
    v.changes.length > Object.keys(CUSTOMIZED_BRIEF_LABELS).length
  )
    return false;
  const seen = new Set<string>();
  for (const change of v.changes) {
    if (
      !record(change) ||
      Object.keys(change).length !== 2 ||
      typeof change.field !== 'string' ||
      !Object.hasOwn(CUSTOMIZED_BRIEF_LABELS, change.field) ||
      seen.has(change.field)
    )
      return false;
    seen.add(change.field);
    if (
      change.field === 'sellingPoints'
        ? !Array.isArray(change.value) ||
          change.value.length > 100 ||
          !change.value.every((s) => boundedText(s, 10000) && !!s.trim())
        : !boundedText(change.value, 50000)
    )
      return false;
  }
  return true;
}
