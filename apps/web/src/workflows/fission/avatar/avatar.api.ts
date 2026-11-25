import type {
  ApiResponse,
  AvatarCompositionDraftRequest,
  AvatarConfirmRequest,
  AvatarRenderArchiveReceipt,
  AvatarRenderWorkspace,
  AvatarRenderCreateRequest,
  AvatarSaveDraftRequest,
  AvatarSyncCreateRequest,
  AvatarSyncWorkspace,
  AvatarWorkspaceData,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const runPath = (projectId: string, workflowRunId: string) =>
  `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/fission-avatar`;
const syncPath = (projectId: string, workflowRunId: string) =>
  `${runPath(projectId, workflowRunId)}/sync`;
const renderPath = (projectId: string, workflowRunId: string) =>
  `${runPath(projectId, workflowRunId)}/render`;

export const avatarApi = {
  open(projectId: string, signal: AbortSignal, expectedWorkflowRunId?: string) {
    const query = expectedWorkflowRunId
      ? `?expectedWorkflowRunId=${encodeURIComponent(expectedWorkflowRunId)}`
      : '';
    return requestJson<ApiResponse<AvatarWorkspaceData>>(
      `${projectPath(projectId)}/fission-avatar/workspace${query}`,
      { method: 'POST', signal, operation: '打开数字人口播工作台' },
    );
  },
  read(projectId: string, workflowRunId: string, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarWorkspaceData>>(
      `${runPath(projectId, workflowRunId)}/workspace`,
      { signal, operation: '读取数字人口播工作台' },
    );
  },
  save(
    projectId: string,
    workflowRunId: string,
    body: AvatarSaveDraftRequest,
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<AvatarWorkspaceData>>(
      `${runPath(projectId, workflowRunId)}/draft`,
      { method: 'PUT', body, signal, operation: '保存数字人口播草稿' },
    );
  },
  confirm(
    projectId: string,
    workflowRunId: string,
    node: 'binding' | 'script',
    body: AvatarConfirmRequest,
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<AvatarWorkspaceData>>(
      `${runPath(projectId, workflowRunId)}/confirm-${node}`,
      {
        method: 'POST',
        body,
        signal,
        operation: node === 'binding' ? '确认数字人形象' : '确认口播文案',
      },
    );
  },
};

export const avatarSyncApi = {
  read(projectId: string, workflowRunId: string, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarSyncWorkspace>>(syncPath(projectId, workflowRunId), {
      signal,
      operation: '读取数字人口播任务',
    });
  },
  create(
    projectId: string,
    workflowRunId: string,
    body: AvatarSyncCreateRequest,
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<AvatarSyncWorkspace>>(
      `${syncPath(projectId, workflowRunId)}/tasks`,
      {
        method: 'POST',
        body,
        signal,
        operation: '生成数字人口播视频',
      },
    );
  },
  change(
    projectId: string,
    workflowRunId: string,
    taskId: string,
    action: 'cancel' | 'retry',
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<AvatarSyncWorkspace>>(
      `${syncPath(projectId, workflowRunId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
      {
        method: 'POST',
        signal,
        operation: action === 'cancel' ? '取消口播生成' : '重试口播生成',
      },
    );
  },
};

export const avatarRenderApi = {
  read(projectId: string, runId: string, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarRenderWorkspace>>(renderPath(projectId, runId), {
      signal,
      operation: '读取数字人口播成片状态',
    });
  },
  save(projectId: string, runId: string, body: AvatarCompositionDraftRequest, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarRenderWorkspace>>(
      `${renderPath(projectId, runId)}/draft`,
      {
        method: 'PUT',
        body,
        signal,
        operation: '保存合成草稿',
      },
    );
  },
  confirm(projectId: string, runId: string, expectedRevision: number, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarRenderWorkspace>>(
      `${renderPath(projectId, runId)}/confirm`,
      { method: 'POST', body: { expectedRevision }, signal, operation: '确认合成方案' },
    );
  },
  create(projectId: string, runId: string, body: AvatarRenderCreateRequest, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarRenderWorkspace>>(
      `${renderPath(projectId, runId)}/tasks`,
      {
        method: 'POST',
        body,
        signal,
        operation: '渲染数字人口播成片',
      },
    );
  },
  change(
    projectId: string,
    runId: string,
    taskId: string,
    action: 'cancel' | 'retry',
    signal: AbortSignal,
  ) {
    return requestJson<ApiResponse<AvatarRenderWorkspace>>(
      `${renderPath(projectId, runId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
      {
        method: 'POST',
        signal,
        operation: action === 'cancel' ? '取消成片渲染' : '重试成片渲染',
      },
    );
  },
  archive(projectId: string, runId: string, revision: number, signal: AbortSignal) {
    return requestJson<ApiResponse<AvatarRenderArchiveReceipt>>(
      `${renderPath(projectId, runId)}/outputs/${revision}/archive`,
      { method: 'POST', signal, operation: '归档数字人口播成片' },
    );
  },
};
