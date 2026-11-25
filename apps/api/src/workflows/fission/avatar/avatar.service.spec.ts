import { ConfigService } from '@nestjs/config';
import { emptyAvatarDraft } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AssetService } from '../../../platform/asset/asset.service';
import type { AvatarRepository } from './avatar.repository';
import { AvatarService } from './avatar.service';

const projectId = '123e4567-e89b-42d3-a456-426614174001';
const workflowRunId = '123e4567-e89b-42d3-a456-426614174002';
const assetId = '123e4567-e89b-42d3-a456-426614174003';

function fixture(active: boolean) {
  const repository = {
    initialize: vi.fn(),
    workspace: vi.fn(),
    saveDraft: vi.fn(),
    confirmBinding: vi.fn(),
    confirmScript: vi.fn(),
    assertPreview: vi.fn(),
  };
  const assets = { content: vi.fn() };
  const service = new AvatarService(
    new ConfigService({ FISSION_AVATAR_ENABLED: active }),
    repository as unknown as AvatarRepository,
    assets as unknown as AssetService,
  );
  return { service, repository, assets };
}

describe('AvatarService', () => {
  it('rejects opening the real workspace when disabled without writing any state', () => {
    const { service, repository } = fixture(false);
    expect(() => service.initialize(projectId)).toThrow('暂未启用');
    expect(repository.initialize).not.toHaveBeenCalled();
  });

  it('rejects unknown confirmation fields and forwards a checked draft with the full scope', () => {
    const { service, repository } = fixture(true);
    expect(() =>
      service.confirmBinding(projectId, workflowRunId, { expectedRevision: 1, grant: true }),
    ).toThrow();
    expect(repository.confirmBinding).not.toHaveBeenCalled();

    const request = { expectedRevision: 7, draft: emptyAvatarDraft() };
    service.saveDraft(projectId, workflowRunId, request);
    expect(repository.saveDraft).toHaveBeenCalledWith({ projectId, workflowRunId }, request);
  });

  it('checks current authorization before opening a versioned preview', async () => {
    const { service, repository, assets } = fixture(true);
    const ref = { assetId, version: 2 };
    repository.assertPreview.mockRejectedValueOnce(new Error('已撤销'));
    await expect(service.preview(projectId, workflowRunId, ref)).rejects.toThrow('已撤销');
    expect(assets.content).not.toHaveBeenCalled();

    await service.preview(projectId, workflowRunId, ref, 'bytes=0-31');
    expect(repository.assertPreview).toHaveBeenCalledWith({ projectId, workflowRunId }, ref);
    expect(assets.content).toHaveBeenCalledWith(projectId, assetId, 'bytes=0-31', 2);
  });
});
