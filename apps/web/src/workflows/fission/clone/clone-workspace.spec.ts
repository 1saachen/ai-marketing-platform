import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyCloneInputDraft,
  FISSION_CLONE_INPUT_LIMITS,
  type ApiResponse,
  type CloneWorkspace,
  type CloneUpload,
} from '@ai-marketing/contracts';
import { ApiClientError } from '../../../api/http-client';
import { flushAndPauseWorkflowRun } from '../../../platform/project/project-workflow-pause';
import { createCloneWorkspace, cloneWorkspaceApi } from './clone-workspace';

const projectA = '11111111-1111-4111-8111-111111111111';
const projectB = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const uploadId = '44444444-4444-4444-8444-444444444444';
const response = <T>(data: T): ApiResponse<T> => ({ success: true, data });
function fixture(projectId = projectA): CloneWorkspace {
  return {
    run: {
      id: runId,
      projectId,
      parentWorkflowRunId: null,
      forkNodeId: null,
      forkTemplateId: null,
      branchLabel: null,
      workflow: 'FISSION',
      workflowSpace: 'FISSION_CLONE',
      status: 'ACTIVE',
      currentNodeId: 'CLONE_INPUT',
      createdAt: '2026-11-11T00:00:00Z',
      updatedAt: '2026-11-11T00:00:00Z',
      lastActiveAt: '2026-11-11T00:00:00Z',
    },
    draft: { revision: 1, state: emptyCloneInputDraft() },
    uploads: [],
    input: null,
    capabilities: {
      inputEnabled: true,
      analysisEnabled: false,
      generationEnabled: false,
      unavailableReason: '后续处理尚未开放',
      limits: { ...FISSION_CLONE_INPUT_LIMITS },
      referenceExtensions: ['mp4'],
      productExtensions: ['png', 'mp4'],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fakeApi() {
  return {
    ...cloneWorkspaceApi,
    initialize: vi.fn<typeof cloneWorkspaceApi.initialize>().mockResolvedValue(response(fixture())),
    save: vi.fn<typeof cloneWorkspaceApi.save>().mockImplementation(
      async (_p, _r, _n, body) =>
        response({
          unchanged: false,
          nodeState: { revision: (body.expectedRevision ?? 0) + 1 },
        }) as Awaited<ReturnType<typeof cloneWorkspaceApi.save>>,
    ),
    activate: vi
      .fn<typeof cloneWorkspaceApi.activate>()
      .mockResolvedValue(response({}) as Awaited<ReturnType<typeof cloneWorkspaceApi.activate>>),
    upload: vi.fn<typeof cloneWorkspaceApi.upload>(),
    remove: vi.fn<typeof cloneWorkspaceApi.remove>().mockResolvedValue(response(null)),
    confirm: vi.fn<typeof cloneWorkspaceApi.confirm>().mockResolvedValue(response(fixture())),
    importAsset: vi.fn<typeof cloneWorkspaceApi.importAsset>(),
  };
}
const controllers: ReturnType<typeof createCloneWorkspace>[] = [];
const create = (api = fakeApi()) => {
  const workspace = createCloneWorkspace(api);
  controllers.push(workspace);
  return { workspace, api };
};
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clone formal workspace persistence', () => {
  it('pauses with the latest server draft revision after the pending save finishes', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<Awaited<ReturnType<typeof api.save>>>();
    api.save.mockReturnValueOnce(pending.promise);
    workspace.edit({ productFacts: '退出前补充的商品事实' });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { paused: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const exiting = flushAndPauseWorkflowRun(projectA, {
      flushPendingEdits: workspace.flushPendingEdits,
      get workflowRunId() {
        return workspace.state.workspace?.run.id ?? '';
      },
      get cloneDraftRevision() {
        return workspace.state.workspace?.draft.revision ?? null;
      },
    });
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
    pending.resolve(
      response({ unchanged: false, nodeState: { revision: 5 } }) as Awaited<
        ReturnType<typeof api.save>
      >,
    );
    await exiting;
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      expectedCloneDraftRevision: 5,
    });
    expect(workspace.dirty()).toBe(false);
  });

  it('restores server draft, node and actual run without filling fixture data', async () => {
    const { workspace, api } = create();
    const saved = fixture();
    saved.draft.state.productName = '目标商品';
    saved.draft.revision = 9;
    saved.run.currentNodeId = 'CLONE_ANALYSIS';
    api.initialize.mockResolvedValue(response(saved));
    await workspace.open(projectA);
    expect(workspace.state.draft.productName).toBe('目标商品');
    expect(workspace.state.workspace?.draft.revision).toBe(9);
    expect(workspace.state.workspace?.run.id).toBe(runId);
    expect(workspace.state.step).toBe(1);
    expect(workspace.state.workspace?.uploads).toEqual([]);
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it('ignores a late initialization after changing projects', async () => {
    const { workspace, api } = create();
    const old = deferred<ApiResponse<CloneWorkspace>>();
    api.initialize
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(fixture(projectB)));
    const first = workspace.open(projectA);
    await workspace.open(projectB);
    old.resolve(response(fixture(projectA)));
    await first;
    expect(workspace.state.projectId).toBe(projectB);
    expect(workspace.state.workspace?.run.projectId).toBe(projectB);
  });

  it('serializes saves, preserving edits entered while a request is in flight', async () => {
    vi.useFakeTimers();
    const { workspace, api } = create();
    await workspace.open(projectA);
    const firstWrite = deferred<Awaited<ReturnType<typeof api.save>>>();
    api.save.mockReturnValueOnce(firstWrite.promise);
    workspace.edit({ productName: '第一稿' });
    const first = workspace.save();
    workspace.edit({ productName: '第二稿' });
    const joined = workspace.save();
    expect(joined).toBe(first);
    expect(api.save).toHaveBeenCalledTimes(1);
    firstWrite.resolve(
      response({ unchanged: false, nodeState: { revision: 2 } }) as Awaited<
        ReturnType<typeof api.save>
      >,
    );
    expect(await first).toBe(true);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls.map((args) => args[3].expectedRevision)).toEqual([1, 2]);
    expect(workspace.state.draft.productName).toBe('第二稿');
    expect(workspace.dirty()).toBe(false);
  });

  it('keeps local editing on conflict and prevents navigation or silent overwrite', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    workspace.edit({ productFacts: '我的新资料' });
    api.save.mockRejectedValue(new ApiClientError('版本冲突', 409));
    expect(await workspace.flushPendingEdits()).toBe(false);
    expect(workspace.state.draft.productFacts).toBe('我的新资料');
    expect(workspace.state.conflict).toBe(true);
    expect(await workspace.go(1)).toBe(false);
    expect(api.activate).not.toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated confirm clicks and uses server revisions', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<ApiResponse<CloneWorkspace>>();
    api.confirm.mockReturnValue(pending.promise);
    const first = workspace.confirm();
    const second = workspace.confirm();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.confirm.mock.calls[0]?.[2]).toEqual({
      expectedDraftRevision: 1,
      expectedInputRevision: 0,
    });
    pending.resolve(response(fixture()));
    expect(await first).toBe(true);
  });

  it('does not backfill a late confirm result into another project', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<ApiResponse<CloneWorkspace>>();
    api.confirm.mockReturnValue(pending.promise);
    const confirming = workspace.confirm();
    await Promise.resolve();
    api.initialize.mockResolvedValue(response(fixture(projectB)));
    await workspace.open(projectB);
    pending.resolve(response(fixture(projectA)));
    expect(await confirming).toBe(false);
    expect(workspace.state.workspace?.run.projectId).toBe(projectB);
  });

  it('removes a draft reference while preserving the old confirmed file', async () => {
    const { workspace, api } = create();
    const saved = fixture();
    const file: CloneUpload = {
      id: uploadId,
      fileObjectId: uploadId,
      role: 'REFERENCE',
      originalFileName: 'reference.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5000,
      sha256: 'a'.repeat(64),
      media: { durationMs: 1000, width: 320, height: 240, frameRate: 25 },
      contentUrl: '/api/safe-file',
    };
    saved.draft.state.referenceUploadId = uploadId;
    saved.uploads = [file];
    saved.input = {
      ref: { artifactId: uploadId, revision: 2, contentHash: 'b'.repeat(64) },
      input: { ...saved.draft.state },
      files: [file],
    };
    api.initialize.mockResolvedValue(response(saved));
    await workspace.open(projectA);
    expect(await workspace.remove(uploadId)).toBe(true);
    expect(workspace.state.draft.referenceUploadId).toBe(null);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.remove).not.toHaveBeenCalled();
    expect(workspace.state.workspace?.input?.files).toHaveLength(1);
  });

  it('navigation activates a node without confirming or creating a task', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    expect(await workspace.go(2)).toBe(true);
    expect(api.activate).toHaveBeenCalledWith(
      projectA,
      runId,
      'CLONE_MAPPING',
      expect.any(AbortSignal),
    );
    expect(api.save).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(workspace.state.step).toBe(2);
  });

  it('pins an explicitly chosen project asset version and reuses the import key', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const file: CloneUpload = {
      id: uploadId,
      fileObjectId: uploadId,
      role: 'PRODUCT',
      originalFileName: 'product.png',
      mimeType: 'image/png',
      sizeBytes: 1000,
      sha256: 'c'.repeat(64),
      media: { durationMs: null, width: 320, height: 240, frameRate: null },
      contentUrl: '/api/safe-file',
    };
    api.importAsset.mockResolvedValue(response(file));
    expect(await workspace.importAsset(uploadId, 7, 'PRODUCT')).toBe(true);
    expect(await workspace.importAsset(uploadId, 7, 'PRODUCT')).toBe(true);
    expect(api.importAsset.mock.calls[0]?.[2]).toMatchObject({
      assetId: uploadId,
      version: 7,
      role: 'PRODUCT',
    });
    expect(api.importAsset.mock.calls[0]?.[2].clientUploadKey).toBe(
      api.importAsset.mock.calls[1]?.[2].clientUploadKey,
    );
    expect(workspace.state.draft.productUploadIds).toEqual([uploadId]);
    expect(workspace.state.workspace?.uploads).toHaveLength(1);
  });

  it('allows exiting an unavailable workspace without inventing a draft write', async () => {
    const { workspace, api } = create();
    api.initialize.mockRejectedValue(
      new ApiClientError('复刻能力未启用', 503, { code: 'CLONE_CAPABILITY_UNAVAILABLE' }),
    );
    await workspace.open(projectA);
    expect(workspace.state.workspace).toBe(null);
    expect(workspace.state.error).toBe('爆款复刻尚未启用，请联系管理员完成配置。');
    expect(await workspace.flushPendingEdits()).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
  });

  it('waits for an active upload and its draft save before allowing a module exit', async () => {
    const { workspace, api } = create();
    await workspace.open(projectA);
    const pending = deferred<ApiResponse<CloneUpload>>();
    api.upload.mockReturnValue(pending.promise);
    const uploading = workspace.upload(
      [new File(['test'], 'product.png', { type: 'image/png' })],
      'PRODUCT',
    );
    let flushed = false;
    const exiting = workspace.flushPendingEdits().then((ok) => {
      flushed = ok;
      return ok;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    pending.resolve(
      response({
        id: uploadId,
        fileObjectId: uploadId,
        role: 'PRODUCT',
        originalFileName: 'product.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        sha256: 'd'.repeat(64),
        media: { durationMs: null, width: 1, height: 1, frameRate: null },
        contentUrl: '/api/file',
      }),
    );
    expect(await uploading).toBe(true);
    expect(await exiting).toBe(true);
    expect(workspace.state.draft.productUploadIds).toEqual([uploadId]);
    expect(api.save).toHaveBeenCalledTimes(1);
  });
});
