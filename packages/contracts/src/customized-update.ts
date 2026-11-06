import type { CustomizedStoryboardScript } from './customized-storyboard';
import type { StoryboardFinding } from './customized-storyboard-generation';
export type CustomizedInformationMode = 'CURRENT' | 'HISTORICAL' | 'PRESERVE';
export type ActivateCustomizedBranchRequest = { informationMode?: CustomizedInformationMode };
/** Read-only impact projection. Creating a task must validate this fingerprint again. */
export type CustomizedUpdateNode =
  'INFORMATION_EXTRACTION' | 'SCRIPT' | 'ASSETS' | 'SHOTS' | 'PROMPT' | 'RENDER';
export type CustomizedUpdateRequest = { version: 1; fingerprint: string };
export type CustomizedUpdateItem = {
  id: string;
  name: string;
  action: 'UPDATE' | 'GENERATE' | 'REMOVE' | 'SYNC';
  reason: string;
};
export type CustomizedUpdatePreview = {
  version: 1;
  workflowRunId: string;
  node: CustomizedUpdateNode;
  targetId: string | null;
  fingerprint: string;
  items: CustomizedUpdateItem[];
  blockers: string[];
  calls: ('TEXT' | 'IMAGE' | 'VIDEO')[];
  /** Scope is a dependency-based upper bound; the model determines semantic changes. */
  scope: 'DEPENDENCIES';
};
export type CustomizedScriptTextPatch = {
  path: string;
  before: string;
  after: string;
  reason: string;
};
export type CustomizedScriptUpdateCandidate = {
  taskId: string;
  status: string;
  errorMessage: string | null;
  before: CustomizedStoryboardScript;
  after: CustomizedStoryboardScript | null;
  applied: boolean;
  issues?: string[];
  reviewStatus?: 'PENDING' | 'PASSED' | 'NEEDS_CHANGES';
  reviewFindings?: Pick<StoryboardFinding, 'severity' | 'message' | 'evidence' | 'suggestion'>[];
  baselineRevision: number;
};
/** Exact, unique replacement only. Paths never traverse identity, prototype, or arbitrary JSON. */
export function applyCustomizedScriptPatches<T>(
  script: T,
  patches: CustomizedScriptTextPatch[],
): T {
  if (!Array.isArray(patches) || patches.length > 100) throw new Error('脚本修改范围不正确');
  const result = JSON.parse(JSON.stringify(script)) as Record<string, unknown>;
  for (const patch of patches) {
    if (
      !patch ||
      typeof patch.path !== 'string' ||
      !patch.reason?.trim() ||
      typeof patch.before !== 'string' ||
      !patch.before ||
      typeof patch.after !== 'string' ||
      patch.after.length > 20000 ||
      !/^(name|synopsis|structure|productFocus|story\/(content|structure|opening|development|ending|dialoguePlan)|story\/beats\/\d+\/content)$/.test(
        patch.path,
      )
    )
      throw new Error('脚本修改路径或原文不正确');
    const parts = patch.path.split('/');
    let parent: Record<string, unknown> = result;
    for (const part of parts.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part))
        throw new Error('脚本原文已变化');
      parent = parent[part] as Record<string, unknown>;
    }
    const key = parts[parts.length - 1]!,
      value = parent?.[key];
    if (
      typeof value !== 'string' ||
      value.indexOf(patch.before) < 0 ||
      value.indexOf(patch.before) !== value.lastIndexOf(patch.before)
    )
      throw new Error('脚本原文已变化或无法唯一定位');
    parent[key] = value.replace(patch.before, () => patch.after);
    if ((parent[key] as string).length > 20000) throw new Error('脚本内容超过长度限制');
  }
  return result as T;
}
