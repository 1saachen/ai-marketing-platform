type Step = { nodeId: string; status: string; output: unknown; errorMessage?: string | null };
const legacyBatchFailure = '部分脚本未完成，已成功的脚本保留，可重试未完成部分';

export function scriptUpdateFailureMessage(steps: Step[]): string {
  const failure = steps.find((s) => s.nodeId === 'STORY' && s.status === 'FAILED');
  if (failure?.errorMessage) return failure.errorMessage;
  const succeeded = (node: string) =>
    steps.find((s) => s.nodeId === node && s.status === 'SUCCEEDED');
  const review = succeeded('REVIEW')?.output as { findings?: { severity?: string }[] } | undefined;
  if (review?.findings?.some((f) => f.severity === 'ERROR'))
    return '本次脚本更新候选未通过审校，原脚本保持不变。请查看更新候选中的问题。';
  const stage = !succeeded('SNAPSHOT')
    ? '读取更新依据'
    : !succeeded('STORY')
      ? '定向改稿'
      : !succeeded('REVIEW')
        ? '候选审校'
        : '候选保存';
  return `本次脚本局部更新在“${stage}”阶段未完成，原脚本保持不变。可继续本次更新，已完成步骤会保留。`;
}

/** Normalize old generic batch text at the read boundary; never rewrite historical task records. */
export function storyboardTaskError(task: {
  inputSnapshot: unknown;
  errorMessage: string | null;
  steps: Step[];
}): string | null {
  return (task.inputSnapshot as { incremental?: unknown })?.incremental &&
    task.errorMessage === legacyBatchFailure
    ? scriptUpdateFailureMessage(task.steps)
    : task.errorMessage;
}
