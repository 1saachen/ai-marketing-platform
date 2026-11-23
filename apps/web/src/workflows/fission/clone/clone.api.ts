import type {
  ApiResponse,
  CloneInputConfirmRequest,
  CloneImportAssetRequest,
  CloneUpload,
  CloneUploadRole,
  CloneWorkspace,
  CloneTask,
  CloneTaskCreateRequest,
  CloneAnalysisDraftSaveRequest,
  CloneAnalysisConfirmRequest,
  CloneMappingConfirmRequest,
  CloneSuggestionAdoptRequest,
  CloneAssetVersionRef,
  CloneArtifactRef,
  CloneGenerationPreflightRequest,
  CloneGenerationPreflight,
  CloneGenerationCreateRequest,
  CloneGenerationReceipt,
  CloneGenerationList,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const path = (projectId: string, runId: string) =>
  `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(runId)}/fission-clone`;
export const initializeCloneWorkspace = (projectId: string, signal?: AbortSignal) =>
  requestJson<ApiResponse<CloneWorkspace>>(
    `${projectPath(projectId)}/workflow-runs/fission-clone/draft`,
    { method: 'POST', signal, operation: '恢复爆款复刻工作区' },
  );
export const getCloneWorkspace = (projectId: string, runId: string, signal?: AbortSignal) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/workspace`, {
    signal,
    operation: '加载爆款复刻工作区',
  });
const uploadKeys = new WeakMap<File, Map<string, string>>();
export const uploadCloneFile = (
  projectId: string,
  runId: string,
  role: CloneUploadRole,
  file: File,
  signal?: AbortSignal,
) => {
  const body = new FormData();
  body.set('file', file);
  body.set('role', role);
  const keys = uploadKeys.get(file) ?? new Map<string, string>();
  uploadKeys.set(file, keys);
  const scope = `${projectId}:${runId}:${role}`;
  const key = keys.get(scope) ?? crypto.randomUUID();
  keys.set(scope, key);
  return requestJson<ApiResponse<CloneUpload>>(`${path(projectId, runId)}/uploads`, {
    method: 'POST',
    body,
    signal,
    headers: { 'X-Upload-Key': key },
    operation: '上传复刻素材',
  });
};
export const importCloneAsset = (
  projectId: string,
  runId: string,
  body: CloneImportAssetRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneUpload>>(`${path(projectId, runId)}/assets`, {
    method: 'POST',
    body,
    signal,
    operation: '引用项目资产版本',
  });
export const removeCloneUpload = (
  projectId: string,
  runId: string,
  id: string,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<unknown>>(`${path(projectId, runId)}/uploads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    operation: '移除复刻上传文件',
  });
export const confirmCloneInput = (
  projectId: string,
  runId: string,
  body: CloneInputConfirmRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/input/confirm`, {
    method: 'POST',
    body,
    signal,
    operation: '确认参考视频',
  });

export const createCloneTask = (
  projectId: string,
  runId: string,
  node: 'analysis' | 'mapping',
  body: CloneTaskCreateRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/${node}/tasks`, {
    method: 'POST',
    body,
    signal,
    operation: node === 'analysis' ? '开始深度拆解' : '创建映射任务',
  });
export const saveCloneAnalysisDraft = (
  projectId: string,
  runId: string,
  body: CloneAnalysisDraftSaveRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/analysis/draft`, {
    method: 'PUT',
    body,
    signal,
    operation: '保存报告编辑草稿',
  });
export const confirmCloneAnalysis = (
  projectId: string,
  runId: string,
  body: CloneAnalysisConfirmRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/analysis/confirm`, {
    method: 'POST',
    body,
    signal,
    operation: '保存拆解报告',
  });
export const confirmCloneMapping = (
  projectId: string,
  runId: string,
  body: CloneMappingConfirmRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/mapping/confirm`, {
    method: 'POST',
    body,
    signal,
    operation: '确认元素映射',
  });
export const adoptCloneSuggestion = (
  projectId: string,
  runId: string,
  taskId: string,
  body: CloneSuggestionAdoptRequest,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(
    `${path(projectId, runId)}/mapping/suggestions/${encodeURIComponent(taskId)}/adopt`,
    {
      method: 'POST',
      body,
      signal,
      operation: '采用映射建议',
    },
  );
export const getCloneTask = (
  projectId: string,
  runId: string,
  taskId: string,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneTask>>(
    `${path(projectId, runId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      signal,
      operation: '读取复刻任务',
    },
  );
export const changeCloneTask = (
  projectId: string,
  runId: string,
  taskId: string,
  action: 'cancel' | 'retry',
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(
    `${path(projectId, runId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
    {
      method: 'POST',
      signal,
      operation: action === 'cancel' ? '取消复刻任务' : '重试复刻任务',
    },
  );

export const prepareCloneMappingAsset = (
  projectId: string,
  runId: string,
  body: CloneAssetVersionRef,
  signal?: AbortSignal,
) =>
  requestJson<ApiResponse<CloneWorkspace>>(`${path(projectId, runId)}/mapping/assets`, {
    method: 'POST',
    body,
    signal,
    operation: '准备目标资产版本',
  });

export const getCloneGeneration = (p: string, r: string, page: number, signal: AbortSignal) =>
  requestJson<ApiResponse<CloneGenerationList>>(`${path(p, r)}/generation/tasks?page=${page}`, {
    signal,
    operation: '读取复刻成片',
  });
export const preflightCloneGeneration = (
  p: string,
  r: string,
  body: CloneGenerationPreflightRequest,
  signal: AbortSignal,
) =>
  requestJson<ApiResponse<CloneGenerationPreflight>>(`${path(p, r)}/generation/preflight`, {
    method: 'POST',
    body,
    signal,
    operation: '检查成片生成条件',
  });
export const createCloneGeneration = (
  p: string,
  r: string,
  body: CloneGenerationCreateRequest,
  signal: AbortSignal,
) =>
  requestJson<ApiResponse<CloneGenerationReceipt>>(`${path(p, r)}/generation/tasks`, {
    method: 'POST',
    body,
    signal,
    operation: '生成复刻成片',
  });
export const changeCloneGeneration = (
  p: string,
  r: string,
  task: string,
  action: 'cancel' | 'retry',
  signal: AbortSignal,
) =>
  requestJson<ApiResponse<{ accepted: boolean }>>(
    `${path(p, r)}/generation/tasks/${encodeURIComponent(task)}/${action}`,
    {
      method: 'POST',
      signal,
      operation: action === 'cancel' ? '取消生成任务' : '重试生成任务',
    },
  );
export const archiveCloneGeneration = (
  p: string,
  r: string,
  task: string,
  body: CloneArtifactRef,
  signal: AbortSignal,
) =>
  requestJson<ApiResponse<{ assetId: string }>>(
    `${path(p, r)}/generation/tasks/${encodeURIComponent(task)}/archive`,
    {
      method: 'POST',
      body,
      signal,
      operation: '保存成片到项目资产库',
    },
  );
