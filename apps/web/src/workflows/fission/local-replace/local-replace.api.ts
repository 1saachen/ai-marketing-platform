import type {
  ApiResponse,
  LocalReplaceDraftSaveRequest,
  LocalReplaceTaskCreateRequest,
  LocalReplaceWorkspace,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const runPath = (projectId: string, runId: string) =>
  `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(runId)}/fission-local-replace`;

export const localReplaceApi = {
  open(projectId: string, signal: AbortSignal) {
    return requestJson<ApiResponse<LocalReplaceWorkspace>>(
      `${projectPath(projectId)}/fission-local-replace/workspace`,
      { method: 'POST', signal, operation: '打开局部元素替换' },
    );
  },
  read(projectId: string, runId: string, signal: AbortSignal) {
    return requestJson<ApiResponse<LocalReplaceWorkspace>>(
      `${runPath(projectId, runId)}/workspace`,
      {
        signal,
        operation: '读取局部替换状态',
      },
    );
  },
  save(projectId: string, runId: string, body: LocalReplaceDraftSaveRequest, signal: AbortSignal) {
    return requestJson<ApiResponse<LocalReplaceWorkspace>>(`${runPath(projectId, runId)}/draft`, {
      method: 'PUT',
      body,
      signal,
      operation: '保存局部替换草稿',
    });
  },
  create(
    projectId: string,
    runId: string,
    body: LocalReplaceTaskCreateRequest,
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<LocalReplaceWorkspace>>(`${runPath(projectId, runId)}/tasks`, {
      method: 'POST',
      body,
      signal,
      operation: '创建替换成片任务',
    });
  },
  change(
    projectId: string,
    runId: string,
    taskId: string,
    action: 'cancel' | 'retry',
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<LocalReplaceWorkspace>>(
      `${runPath(projectId, runId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
      { method: 'POST', signal, operation: action === 'cancel' ? '取消替换任务' : '重试替换任务' },
    );
  },
};
