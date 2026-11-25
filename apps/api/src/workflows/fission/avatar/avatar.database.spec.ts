import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import {
  AVATAR_LONG_SYNC_QUEUE,
  AVATAR_NATIVE_MODEL,
  AVATAR_NATIVE_SYNC_QUEUE,
  AVATAR_OUTPUT_NODE,
  AVATAR_RENDER_QUEUE,
  AVATAR_SYNC_NODE,
  AVATAR_SYNC_QUEUE,
  AVATAR_TAIL_CHAIN_MODEL,
  emptyAvatarDraft,
  FISSION_AVATAR_DRAFT_NODE,
} from '@ai-marketing/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../../database/prisma.service';
import { AssetRepository } from '../../../platform/asset/asset.repository';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { AvatarRepository } from './avatar.repository';
import { AvatarRenderRepository } from './avatar-render.repository';
import { AvatarSyncRepository } from './avatar-sync.repository';

const enabled = process.env.FISSION_AVATAR_DATABASE_TEST === '1';
const characterType = 'DIGITAL_HUMAN_CHARACTER';
const voiceType = 'VOICE_PROFILE';
const grantScript = resolve(__dirname, '../../../../scripts/manage-avatar-asset-grant.mjs');
const runNode = promisify(execFile);

describe.skipIf(!enabled)('Avatar isolated database', () => {
  let db: PrismaService;
  let repository: AvatarRepository;
  let working: WorkflowWorkingRepository;
  let sync: AvatarSyncRepository;
  let render: AvatarRenderRepository;
  let assets: AssetRepository;
  let projects: string[];

  beforeEach(() => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/missing');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/fission_avatar_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error('Avatar tests require an isolated fission_avatar_ database');
    const config = new ConfigService({
      DATABASE_URL: url.toString(),
      FISSION_AVATAR_ENABLED: true,
    });
    db = new PrismaService(config);
    working = new WorkflowWorkingRepository(db, config);
    repository = new AvatarRepository(db, working);
    sync = new AvatarSyncRepository(db, working);
    assets = new AssetRepository(db);
    render = new AvatarRenderRepository(db, working, assets);
    projects = [];
  });

  afterEach(async () => {
    if (!db) return;
    const where = { projectId: { in: projects } };
    try {
      await db.workingArtifactDependency.deleteMany({ where });
      await db.workingArtifactRevisionFile.deleteMany({ where });
      await db.assetOperationReceipt.deleteMany({ where });
      await db.assetVersion.deleteMany({ where });
      await db.asset.deleteMany({ where });
      await db.project.deleteMany({ where: { id: { in: projects } } });
    } finally {
      await db.$disconnect();
    }
  }, 30_000);

  async function project() {
    const { id } = await db.project.create({ data: { name: '数字人口播隔离测试' } });
    projects.push(id);
    return id;
  }

  async function asset(
    projectId: string,
    type: typeof characterType | typeof voiceType,
    workflowSpace: 'FISSION_AVATAR' | 'FISSION_CLONE' = 'FISSION_AVATAR',
    image = false,
  ) {
    const isVoice = type === voiceType;
    const file = {
      originalFileName: isVoice ? 'fixture.wav' : image ? 'fixture.png' : 'fixture.mp4',
      mimeType: isVoice ? 'audio/wav' : image ? 'image/png' : 'video/mp4',
      sizeBytes: 512,
      storageKey: `avatar-test-fixtures/${randomUUID()}`,
    };
    const record = await db.asset.create({
      data: {
        projectId,
        ...file,
        name: file.originalFileName,
        storageWorkflow: 'FISSION',
        workflowSpace,
        directory: isVoice ? 'AUDIO_ASSETS' : 'VISUAL_ASSETS',
        type,
      },
    });
    await db.assetVersion.create({
      data: {
        projectId,
        assetId: record.id,
        version: 1,
        changeNote: '测试素材',
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ...file,
      },
    });
    return { assetId: record.id, version: 1 };
  }

  function grant(projectId: string, ref: Awaited<ReturnType<typeof asset>>, expiresAt?: Date) {
    return db.fissionAvatarAssetGrant.create({
      data: {
        projectId,
        assetId: ref.assetId,
        assetVersion: ref.version,
        evidenceReference: 'isolation-test-only',
        grantedAt: new Date(Date.now() - 60_000),
        expiresAt: expiresAt ?? null,
      },
    });
  }

  async function setup() {
    const projectId = await project();
    const initial = await repository.initialize(projectId);
    const workflowRunId = initial.workflowRunId;
    return {
      ids: { projectId, workflowRunId },
      positional: [projectId, workflowRunId] as const,
      initial,
    };
  }

  it('isolates projects, sibling workflow spaces and Run state and fences reopened drafts', async () => {
    const { ids, initial, positional } = await setup();
    const other = await setup();
    const sibling = await db.workflowRun.create({
      data: { projectId: ids.projectId, workflow: 'FISSION', workflowSpace: 'FISSION_CLONE' },
    });
    const historical = await db.workflowRun.create({
      data: {
        projectId: ids.projectId,
        workflow: 'FISSION',
        workflowSpace: 'FISSION_AVATAR',
        status: 'COMPLETED',
        activeKey: null,
      },
    });
    const draft = { ...emptyAvatarDraft(), scriptText: '先恢复我' };
    expect((await repository.initialize(ids.projectId)).workflowRunId).toBe(ids.workflowRunId);
    await expect(
      repository.workspace({ ...ids, workflowRunId: other.ids.workflowRunId }),
    ).rejects.toThrow('不存在');
    await expect(repository.workspace({ ...ids, workflowRunId: sibling.id })).rejects.toThrow(
      '不存在',
    );
    await expect(
      repository.saveDraft(
        { ...ids, workflowRunId: historical.id },
        { draft, expectedRevision: 1 },
      ),
    ).rejects.toThrow('请重新进入');
    await expect(working.activateNode(...positional, 'AVATAR_SCRIPT')).rejects.toThrow('工作台');
    await expect(
      working.saveNodeState(...positional, FISSION_AVATAR_DRAFT_NODE, '', draft, 1, 1),
    ).rejects.toThrow('工作台');
    const saved = await repository.saveDraft(ids, {
      draft,
      expectedRevision: initial.draft.revision,
    });
    await expect(
      repository.saveDraft(ids, { draft, expectedRevision: initial.draft.revision }),
    ).rejects.toThrow('已更新');
    await expect(
      working.pauseRun(...positional, { expectedAvatarDraftRevision: initial.draft.revision }),
    ).rejects.toThrow('草稿已变化');
    await working.pauseRun(...positional, { expectedAvatarDraftRevision: saved.draft.revision });
    expect(await repository.workspace(ids)).toMatchObject({
      runStatus: 'PAUSED',
      draft: saved.draft,
    });
    await expect(
      repository.saveDraft(ids, { draft, expectedRevision: saved.draft.revision }),
    ).rejects.toThrow('已暂停');
    await expect(repository.initialize(ids.projectId, historical.id)).rejects.toThrow(
      '当前工作流已切换',
    );
    expect((await repository.workspace(ids)).runStatus).toBe('PAUSED');
    const reopened = await repository.initialize(ids.projectId, ids.workflowRunId);
    expect(reopened).toMatchObject({ workflowRunId: ids.workflowRunId, runStatus: 'ACTIVE' });
    expect(reopened.draft).toEqual({ revision: saved.draft.revision + 1, data: draft });
    await expect(
      repository.saveDraft(ids, { draft, expectedRevision: saved.draft.revision }),
    ).rejects.toThrow('已更新');
    expect(reopened.script).toBeNull();
  }, 30_000);

  it('validates exact versions and live authorization and commits only on explicit confirmation', async () => {
    const { ids, initial } = await setup();
    const projectId = ids.projectId;
    const otherProjectId = await project();
    const character = await asset(projectId, characterType);
    const voice = await asset(projectId, voiceType);
    const foreign = await asset(otherProjectId, characterType);
    const sibling = await asset(projectId, characterType, 'FISSION_CLONE');
    await grant(otherProjectId, foreign);
    await grant(projectId, sibling);
    await grant(projectId, voice);
    const baseDraft = { ...emptyAvatarDraft(), voice, scriptText: '  测试文本  ' };
    const save = (ref: typeof character) =>
      repository.saveDraft(ids, {
        draft: { ...baseDraft, character: ref },
        expectedRevision: initial.draft.revision,
      });
    await expect(save(character)).rejects.toThrow('缺少数字人口播授权');
    await expect(save(foreign)).rejects.toThrow('缺少数字人口播授权');
    await expect(save(sibling)).rejects.toThrow('缺少数字人口播授权');
    const authorization = await grant(projectId, character);
    await expect(save({ ...character, version: 2 })).rejects.toThrow('缺少数字人口播授权');
    const saved = await save(character);
    expect(saved).toMatchObject({
      characters: [{ ...character, previewKind: 'VIDEO' }],
      voices: [{ ...voice, previewKind: 'AUDIO' }],
      binding: null,
      script: null,
    });
    expect(await db.workingArtifact.count({ where: ids })).toBe(0);
    await expect(repository.confirmScript(ids, saved.draft.revision)).rejects.toThrow('先确认');
    const bound = await repository.confirmBinding(ids, saved.draft.revision);
    expect(bound.binding).toMatchObject({
      revision: 1,
      content: { character, authorizationId: authorization.id },
    });
    expect((await repository.confirmBinding(ids, saved.draft.revision)).binding).toEqual(
      bound.binding,
    );
    const confirmed = await repository.confirmScript(ids, saved.draft.revision);
    expect(confirmed.script).toMatchObject({
      revision: 1,
      content: { text: '测试文本', source: 'MANUAL', language: 'zh-CN', estimatedDurationMs: 1000 },
    });
    const sameText = await repository.saveDraft(ids, {
      expectedRevision: saved.draft.revision,
      draft: { ...saved.draft.data, scriptText: '测试文本', scriptSource: 'TXT' },
    });
    expect((await repository.confirmScript(ids, sameText.draft.revision)).script).toEqual(
      confirmed.script,
    );
    const updated = await repository.saveDraft(ids, {
      expectedRevision: sameText.draft.revision,
      draft: { ...sameText.draft.data, scriptText: '新版文案' },
    });
    expect(updated.script).toEqual(confirmed.script);
    expect((await repository.confirmScript(ids, updated.draft.revision)).script).toMatchObject({
      revision: 2,
    });

    await repository.assertPreview(ids, character);
    await db.fissionAvatarAssetGrant.update({
      where: { id: authorization.id },
      data: { revokedAt: new Date() },
    });
    expect((await repository.workspace(ids)).characters).toEqual([]);
    await expect(repository.assertPreview(ids, character)).rejects.toThrow('缺少数字人口播授权');
    await expect(repository.confirmBinding(ids, updated.draft.revision)).rejects.toThrow(
      '缺少数字人口播授权',
    );
    await grant(projectId, character, new Date(Date.now() - 30_000));
    await expect(repository.assertPreview(ids, character)).rejects.toThrow('缺少数字人口播授权');
  }, 30_000);

  it('provisions and revokes an exact asset version through the operator command', async () => {
    const { ids } = await setup();
    const character = await asset(ids.projectId, characterType);
    const key = [
      '--project',
      ids.projectId,
      '--asset',
      character.assetId,
      '--version',
      String(character.version),
    ];
    const args = ['grant', ...key, '--evidence', 'operator-integration-test-only'];
    await runNode(process.execPath, [grantScript, ...args], { timeout: 8_000 });
    const workspace = await repository.workspace(ids);
    expect(workspace.characters).toMatchObject([
      { ...character, authorizationId: expect.any(String) },
    ]);
    await runNode(process.execPath, [grantScript, 'revoke', ...key], { timeout: 8_000 });
    expect((await repository.workspace(ids)).characters).toEqual([]);
    const sourceTaskId = 'cgt-operator-fixture';
    await runNode(
      process.execPath,
      [grantScript, ...args, '--seedance-source-task-id', sourceTaskId],
      {
        timeout: 8_000,
      },
    );
    const renewed = await repository.workspace(ids);
    expect(renewed.characters[0]?.authorizationId).not.toBe(
      workspace.characters[0]?.authorizationId,
    );
    expect(renewed.characters[0]).not.toHaveProperty('seedanceSourceTaskId');
    await expect(
      db.fissionAvatarAssetGrant.findUnique({
        where: { id: renewed.characters[0]!.authorizationId },
        select: { seedanceSourceTaskId: true },
      }),
    ).resolves.toEqual({ seedanceSourceTaskId: sourceTaskId });
  }, 30_000);

  async function readySync(scriptText = '测试数字人口播') {
    const { ids, initial } = await setup();
    const character = await asset(ids.projectId, characterType);
    const voice = await asset(ids.projectId, voiceType);
    const characterGrant = await grant(ids.projectId, character);
    const voiceGrant = await grant(ids.projectId, voice);
    const draft = await repository.saveDraft(ids, {
      expectedRevision: initial.draft.revision,
      draft: { ...emptyAvatarDraft(), character, voice, scriptText },
    });
    await repository.confirmBinding(ids, draft.draft.revision);
    const confirmed = await repository.confirmScript(ids, draft.draft.revision);
    const binding = {
      artifactId: confirmed.binding!.artifactId,
      revision: confirmed.binding!.revision,
    };
    const script = {
      artifactId: confirmed.script!.artifactId,
      revision: confirmed.script!.revision,
    };
    const request = {
      expectedDraftRevision: confirmed.draft.revision,
      binding,
      script,
      idempotencyKey: randomUUID(),
    };
    return { ids, request, draft, voiceGrant, characterGrant };
  }

  const allowSpeaker = (grantId: string) =>
    db.fissionAvatarAssetGrant.update({
      where: { id: grantId },
      data: { doubaoSpeaker: 'zh_female_vv_uranus_bigtts' },
    });

  const proof = {
    audioDurationMs: 2350,
    videoDurationMs: 2360,
    audioLagMs: 0,
    minimumAudioCorrelationPermille: 998,
    wordTimings: [{ text: '测', startMs: 0, endMs: 200, confidencePermille: 990 }],
  };

  function files() {
    return {
      audio: {
        nodeId: AVATAR_SYNC_NODE,
        originalFileName: 'speech.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 256,
        storageKey: `avatar-test/${randomUUID()}`,
        sha256: 'a'.repeat(64),
      },
      video: {
        nodeId: AVATAR_SYNC_NODE,
        originalFileName: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 512,
        storageKey: `avatar-test/${randomUUID()}`,
        sha256: 'b'.repeat(64),
      },
    };
  }

  it('generates a scoped native result without a voice, reconciling the original Ark receipt', async () => {
    const { ids, initial } = await setup();
    const character = await asset(ids.projectId, characterType, 'FISSION_AVATAR', true);
    const characterGrant = await grant(ids.projectId, character);
    const draft = await repository.saveDraft(ids, {
      expectedRevision: initial.draft.revision,
      draft: { ...emptyAvatarDraft(), character, scriptText: '固定机位，人物说：“你好。”' },
    });
    await repository.confirmBinding(ids, draft.draft.revision);
    const confirmed = await repository.confirmScript(ids, draft.draft.revision);
    const request = {
      mode: 'NATIVE' as const,
      durationSeconds: 30,
      binding: confirmed.binding!,
      script: confirmed.script!,
      expectedDraftRevision: confirmed.draft.revision,
      idempotencyKey: randomUUID(),
    };
    await expect(sync.create(ids, request)).rejects.toThrow('暂未启用');
    expect(await sync.workspace(ids, false, false, false, true)).toMatchObject({
      enabled: false,
      native: { enabled: true, canGenerate: true },
    });
    const options = [false, false, false, true] as const;
    const id = (await sync.create(ids, request, ...options)).task!.id;
    expect((await sync.create(ids, request, ...options)).task?.id).toBe(id);
    await expect(sync.create(ids, { ...request, durationSeconds: 29 }, ...options)).rejects.toThrow(
      '其他口播输入',
    );
    expect(
      await db.jobOutbox.count({
        where: { ...{ projectId: ids.projectId }, routingKey: AVATAR_NATIVE_SYNC_QUEUE },
      }),
    ).toBe(1);
    await expect(sync.claim((await setup()).ids, id)).rejects.toThrow('任务不存在');
    const first = await sync.claim(ids, id);
    if (first.status !== 'CLAIMED' || first.input.schemaVersion !== 4)
      throw new Error('Unable to claim native task');
    expect(first.input).toMatchObject({
      model: AVATAR_NATIVE_MODEL,
      durationSeconds: 30,
      image: { kind: 'BYTES', mimeType: 'image/png', sizeBytes: 512, sha256: null },
      nativeStarted: false,
      nativeTaskId: null,
    });
    expect(await sync.character(ids, id, first.attemptToken)).toMatchObject({
      mimeType: 'image/png',
    });
    await expect(
      sync.checkpoint(ids, id, first.attemptToken, { kind: 'TTS_SUBMIT' }),
    ).rejects.toThrow('模式不匹配');
    const start = { kind: 'NATIVE_STARTED' as const };
    await expect(sync.nativeCheckpoint(ids, id, first.attemptToken, start)).resolves.toEqual({
      allowed: true,
    });
    await expect(sync.nativeCheckpoint(ids, id, first.attemptToken, start)).resolves.toEqual({
      allowed: false,
    });
    await sync.fail(ids, id, first.attemptToken, {
      code: 'PROVIDER_CREATION_UNKNOWN',
      retryable: false,
    });
    await expect(
      sync.create(ids, { ...request, idempotencyKey: randomUUID() }, ...options),
    ).rejects.toThrow('需要核对');
    const savedTask = await db.fissionAvatarSyncTask.findUniqueOrThrow({ where: { id } });
    const providerTaskId = `cgt-${randomUUID()}`;
    await runNode(
      process.execPath,
      [
        resolve(__dirname, '../../../../scripts/reconcile-avatar-sync.mjs'),
        '--project',
        ids.projectId,
        '--run',
        ids.workflowRunId,
        '--task',
        id,
        '--client-token',
        savedTask.lipSyncClientToken,
        '--provider-task',
        providerTaskId,
        '--native',
        '--confirm-provider-match',
      ],
      { timeout: 8000 },
    );
    await sync.action(ids, id, 'retry', ...options);
    const resumed = await sync.claim(ids, id);
    if (resumed.status !== 'CLAIMED' || resumed.input.schemaVersion !== 4)
      throw new Error('Unable to resume native task');
    expect(resumed.input.nativeTaskId).toBe(providerTaskId);
    const accepted = { kind: 'NATIVE_ACCEPTED' as const, providerTaskId };
    await expect(sync.nativeCheckpoint(ids, id, first.attemptToken, accepted)).rejects.toThrow(
      '租约已失效',
    );
    await expect(sync.nativeCheckpoint(ids, id, resumed.attemptToken, accepted)).resolves.toEqual({
      allowed: true,
    });
    const proof = {
      schemaVersion: 4 as const,
      audioDurationMs: 30_000,
      videoDurationMs: 30_000,
      wordTimings: [] as [],
    };
    await expect(
      sync.complete(
        ids,
        id,
        resumed.attemptToken,
        { ...proof, videoDurationMs: 29_500, audioDurationMs: 29_500 },
        files(),
        'c'.repeat(64),
      ),
    ).rejects.toThrow('与所选规格不符');
    await expect(
      sync.complete(ids, id, resumed.attemptToken, proof, files(), 'd'.repeat(64)),
    ).resolves.toBe(true);
    const { result } = await sync.workspace(ids, false, false, false, true);
    expect(result).toMatchObject({
      mode: 'NATIVE',
      durationMs: 30_000,
      wordTimings: [],
      stale: false,
    });
    await expect(sync.output(ids, result!.artifactId, 'video')).resolves.toMatchObject({
      mimeType: 'video/mp4',
    });
    expect((await render.workspace(ids, true)).source).toMatchObject({
      mode: 'NATIVE',
      captions: [],
      durationMs: 30_000,
    });
    const syncRef = { artifactId: result!.artifactId, revision: result!.revision };
    const compositionDraft = await render.saveDraft(
      ids,
      {
        expectedRevision: 0,
        sync: syncRef,
        settings: {
          background: { kind: 'SOLID', color: '#243A35' },
          insetPercent: 8,
          captionMode: 'OFF',
          captions: [],
        },
      },
      true,
    );
    const { composition } = await render.confirm(ids, compositionDraft.draft!.revision, true);
    const create = {
      idempotencyKey: randomUUID(),
      composition: { artifactId: composition!.artifactId, revision: composition!.revision },
    };
    await expect(render.create(ids, create, true)).rejects.toThrow('当前版本的生成原片');
    await expect(
      render.create(ids, { ...create, nativeSourceAccepted: { ...syncRef, revision: 2 } }, true),
    ).rejects.toThrow('当前版本的生成原片');
    const acceptedCreate = { ...create, nativeSourceAccepted: syncRef };
    const renderId = (await render.create(ids, acceptedCreate, true)).task!.id;
    expect((await render.create(ids, acceptedCreate, true)).task?.id).toBe(renderId);
    await expect(render.create(ids, create, true)).rejects.toThrow('其他方案版本或原片确认');
    const renderClaim = await render.claim(ids, renderId);
    if (renderClaim.status !== 'CLAIMED' || renderClaim.input.schemaVersion !== 3)
      throw new Error('Unable to claim accepted native render');
    const renderProof = {
      schemaVersion: 3 as const,
      audioDurationMs: 30_000,
      videoDurationMs: 30_000,
      sourceVideoSha256: renderClaim.input.sourceVideoSha256,
      outputVideoSha256: 'e'.repeat(64),
      videoFrameCount: 720,
      audioPacketCount: 1408,
      maxTimelineDriftUs: 0,
    };
    const staged = () => ({
      video: {
        ...files().video,
        nodeId: AVATAR_OUTPUT_NODE,
        sha256: renderProof.outputVideoSha256,
      },
    });
    await expect(
      render.complete(ids, renderId, randomUUID(), renderProof, staged(), 'e'.repeat(64)),
    ).rejects.toThrow('租约');
    await expect(
      render.complete(
        ids,
        renderId,
        renderClaim.attemptToken,
        { ...renderProof, sourceVideoSha256: 'f'.repeat(64) },
        staged(),
        'e'.repeat(64),
      ),
    ).rejects.toThrow('摘要');
    await expect(render.output(ids, 1, 'video')).rejects.toThrow('不可用');
    const completion = await render.complete(
      ids,
      renderId,
      renderClaim.attemptToken,
      renderProof,
      staged(),
      'e'.repeat(64),
    );
    expect(completion).toBe(true);
    await expect(
      render.complete(
        ids,
        renderId,
        renderClaim.attemptToken,
        renderProof,
        staged(),
        'e'.repeat(64),
      ),
    ).resolves.toBe(false);
    const published = await render.workspace(ids, true);
    expect(published).toMatchObject({
      task: { status: 'SUCCEEDED', phase: 'COMPLETE' },
      output: { revision: 1, stale: false, videoUrl: expect.stringContaining('/outputs/1/video') },
    });
    const output = await db.workingArtifact.findUniqueOrThrow({
      where: { id: published.output!.artifactId },
    });
    expect(output.payload).toMatchObject({
      nativeValidation: { acceptedSource: syncRef, timeline: renderProof },
    });
    expect(await db.fissionAvatarRenderTask.findUnique({ where: { id: renderId } })).toMatchObject({
      review: null,
      candidate: null,
    });
    await expect(render.output(ids, 1, 'video')).resolves.toMatchObject({
      sha256: renderProof.outputVideoSha256,
    });
    const [archived, replayed] = await Promise.all([
      render.archive(ids, 1),
      render.archive(ids, 1),
    ]);
    expect(archived).toEqual(replayed);

    const rerender = (
      await render.create(ids, { ...acceptedCreate, idempotencyKey: randomUUID() }, true)
    ).task!;
    const secondClaim = await render.claim(ids, rerender.id);
    if (secondClaim.status !== 'CLAIMED') throw new Error('Unable to claim repeat render');
    await render.complete(
      ids,
      rerender.id,
      secondClaim.attemptToken,
      renderProof,
      staged(),
      'e'.repeat(64),
    );
    expect((await render.workspace(ids, true)).output?.revision).toBe(1);
    await expect(render.archive(ids, 1)).resolves.toEqual(archived);

    await db.fissionAvatarAssetGrant.update({
      where: { id: characterGrant.id },
      data: { revokedAt: new Date() },
    });
    await expect(sync.output(ids, result!.artifactId, 'video')).rejects.toThrow('不可用');
    await expect(render.output(ids, 1, 'video')).rejects.toThrow('不可用');
    await expect(render.archive(ids, 1)).rejects.toThrow('不可用');
  }, 30_000);

  it('gates generation on explicit provider grants and atomically deduplicates task plus outbox', async () => {
    const { ids, request, voiceGrant } = await readySync();
    expect(await sync.workspace(ids, true)).toMatchObject({
      enabled: true,
      canGenerate: false,
      blockedReason: '所选音色缺少有效的普通话生成授权',
    });
    await expect(sync.create(ids, request)).rejects.toThrow('生成授权');
    await allowSpeaker(voiceGrant.id);
    await expect(
      sync.create(ids, {
        ...request,
        binding: { ...request.binding, revision: request.binding.revision + 1 },
      }),
    ).rejects.toThrow('输入已更新');
    const [one, two] = await Promise.all([sync.create(ids, request), sync.create(ids, request)]);
    expect(one.task?.id).toBe(two.task?.id);
    expect(await db.fissionAvatarSyncTask.count({ where: ids })).toBe(1);
    const outbox = await db.jobOutbox.findMany({ where: { projectId: ids.projectId } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      routingKey: AVATAR_SYNC_QUEUE,
      payload: {
        schemaVersion: 1,
        projectId: ids.projectId,
        runId: ids.workflowRunId,
        requestId: one.task!.id,
      },
    });
    await expect(sync.create(ids, { ...request, idempotencyKey: randomUUID() })).rejects.toThrow(
      '正在执行',
    );
    const other = await setup();
    await expect(sync.claim(other.ids, one.task!.id)).rejects.toThrow('任务不存在');
    const clone = await db.workflowRun.create({
      data: { projectId: ids.projectId, workflow: 'FISSION', workflowSpace: 'FISSION_CLONE' },
    });
    await expect(sync.workspace({ ...ids, workflowRunId: clone.id }, true)).rejects.toThrow(
      '工作流不存在',
    );
  }, 30_000);

  it('recognizes repeated checkpoints, resumes the same operations and rejects old attempts', async () => {
    const { ids, request, voiceGrant } = await readySync();
    await allowSpeaker(voiceGrant.id);
    const { task } = await sync.create(ids, request);
    const id = task!.id;
    const first = await sync.claim(ids, id);
    expect(first.status).toBe('CLAIMED');
    if (first.status !== 'CLAIMED') throw new Error('Claim failed');
    const oldToken = first.attemptToken;
    await expect(sync.claim(ids, id)).resolves.toEqual({ status: 'BUSY' });
    await expect(sync.checkpoint(ids, id, oldToken, { kind: 'TTS_SUBMIT' })).resolves.toEqual({
      allowed: true,
    });
    await expect(sync.checkpoint(ids, id, oldToken, { kind: 'TTS_SUBMIT' })).resolves.toEqual({
      allowed: false,
    });
    await expect(sync.checkpoint(ids, id, oldToken, { kind: 'LIP_SYNC_SUBMIT' })).resolves.toEqual({
      allowed: true,
    });
    await expect(sync.action(ids, id, 'cancel', true)).rejects.toThrow('正在确认创建');
    const accepted = {
      kind: 'LIP_SYNC_ACCEPTED' as const,
      providerTaskId: `amk-tool-lip-sync-${randomUUID()}`,
    };
    await sync.checkpoint(ids, id, oldToken, accepted);
    await sync.checkpoint(ids, id, oldToken, accepted);
    await expect(
      sync.checkpoint(ids, id, oldToken, {
        ...accepted,
        providerTaskId: 'amk-tool-lip-sync-foreign',
      }),
    ).rejects.toThrow('已绑定');
    await sync.heartbeat(ids, id, oldToken, { phase: 'VALIDATING', progress: 75 });
    await sync.heartbeat(ids, id, oldToken, { phase: 'TTS', progress: 5 });
    expect((await sync.workspace(ids, true)).task).toMatchObject({
      phase: 'VALIDATING',
      progress: 75,
    });
    await db.fissionAvatarSyncTask.update({ where: { id }, data: { leaseExpiresAt: new Date(0) } });
    await sync.recoverExpired();
    const recovered = await sync.claim(ids, id);
    if (first.input.schemaVersion !== 1) throw new Error('Expected a short task');
    expect(recovered).toMatchObject({
      status: 'CLAIMED',
      input: {
        ttsOperationId: first.input.ttsOperationId,
        ttsStarted: true,
        lipSyncClientToken: first.input.lipSyncClientToken,
        lipSyncStarted: true,
        lipSyncTaskId: accepted.providerTaskId,
      },
    });
    if (recovered.status !== 'CLAIMED') throw new Error('Recovery failed');
    expect(recovered.attemptToken).not.toBe(oldToken);
    await expect(
      sync.heartbeat(ids, id, oldToken, { phase: 'VALIDATING', progress: 80 }),
    ).resolves.toEqual({ active: false });
    await expect(sync.complete(ids, id, oldToken, proof, files(), 'c'.repeat(64))).rejects.toThrow(
      '租约',
    );
    await sync.action(ids, id, 'cancel', true);
    await expect(
      sync.complete(ids, id, recovered.attemptToken, proof, files(), 'c'.repeat(64)),
    ).rejects.toThrow('租约');
  }, 30_000);

  async function acceptSync(ids: Awaited<ReturnType<typeof setup>>['ids'], id: string) {
    const claim = await sync.claim(ids, id);
    if (claim.status !== 'CLAIMED') throw new Error('Claim failed');
    await sync.checkpoint(ids, id, claim.attemptToken, { kind: 'TTS_SUBMIT' });
    await sync.checkpoint(ids, id, claim.attemptToken, { kind: 'LIP_SYNC_SUBMIT' });
    await sync.checkpoint(ids, id, claim.attemptToken, {
      kind: 'LIP_SYNC_ACCEPTED',
      providerTaskId: `amk-tool-lip-sync-${randomUUID()}`,
    });
    return claim.attemptToken;
  }

  it('commits one result while paused, preserves identical revision and guards old media grants', async () => {
    const { ids, request, voiceGrant, characterGrant, draft } = await readySync();
    await allowSpeaker(voiceGrant.id);
    const first = (await sync.create(ids, request)).task!.id;
    const token = await acceptSync(ids, first);
    await working.pauseRun(ids.projectId, ids.workflowRunId, {
      expectedAvatarDraftRevision: request.expectedDraftRevision,
    });
    await expect(sync.complete(ids, first, token, proof, files(), 'c'.repeat(64))).resolves.toBe(
      true,
    );
    await expect(sync.complete(ids, first, token, proof, files(), 'c'.repeat(64))).resolves.toBe(
      false,
    );
    const output = (await sync.workspace(ids, false)).result!;
    expect(output).toMatchObject({ stale: false, durationMs: proof.videoDurationMs, revision: 1 });
    expect(output.videoUrl).toContain('?revision=1');
    await expect(sync.output(ids, output.artifactId, 'audio', 1)).resolves.toMatchObject({
      mimeType: 'audio/mpeg',
    });
    await expect(sync.output(ids, output.artifactId, 'audio', 2)).rejects.toThrow('不可用');
    expect(
      await db.workingArtifactDependency.findMany({
        where: { dependentArtifactId: output.artifactId },
        select: { sourceArtifactId: true, sourceRevision: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { sourceArtifactId: request.binding.artifactId, sourceRevision: request.binding.revision },
        { sourceArtifactId: request.script.artifactId, sourceRevision: request.script.revision },
      ]),
    );

    const resumed = await repository.initialize(ids.projectId, ids.workflowRunId);
    const second = (
      await sync.create(ids, {
        ...request,
        expectedDraftRevision: resumed.draft.revision,
        idempotencyKey: randomUUID(),
      })
    ).task!.id;
    const secondToken = await acceptSync(ids, second);
    await expect(
      sync.complete(ids, second, secondToken, proof, files(), 'c'.repeat(64)),
    ).resolves.toBe(false);
    expect((await sync.workspace(ids, true)).result).toMatchObject({
      artifactId: output.artifactId,
      revision: 1,
    });
    expect(await db.fileObject.count({ where: ids })).toBe(2);

    const changed = await repository.saveDraft(ids, {
      expectedRevision: resumed.draft.revision,
      draft: { ...draft.draft.data, scriptText: '尚未确认的更新' },
    });
    expect((await sync.workspace(ids, true)).result?.stale).toBe(false);
    await repository.confirmScript(ids, changed.draft.revision);
    expect((await sync.workspace(ids, true)).result).toMatchObject({ stale: true, revision: 1 });
    await db.fissionAvatarAssetGrant.update({
      where: { id: characterGrant.id },
      data: { revokedAt: new Date() },
    });
    expect((await sync.workspace(ids, true)).result).toMatchObject({
      stale: true,
      audioUrl: null,
      videoUrl: null,
    });
    await expect(sync.output(ids, output.artifactId, 'video')).rejects.toThrow('不可用');
  }, 30_000);

  it('keeps an unknown MediaKit operation from being recreated until it can be reconciled', async () => {
    const { ids, request, voiceGrant } = await readySync();
    await allowSpeaker(voiceGrant.id);
    const id = (await sync.create(ids, request)).task!.id;
    const claim = await sync.claim(ids, id);
    if (claim.status !== 'CLAIMED') throw new Error('Claim failed');
    const token = claim.attemptToken;
    await sync.checkpoint(ids, id, token, { kind: 'TTS_SUBMIT' });
    await sync.checkpoint(ids, id, token, { kind: 'LIP_SYNC_SUBMIT' });
    await sync.fail(ids, id, token, { code: 'INTERNAL_API_FAILED', retryable: true });
    expect(await sync.workspace(ids, true)).toMatchObject({
      canGenerate: false,
      task: { status: 'FAILED', canRetry: false, canCancel: false },
    });
    await expect(sync.create(ids, { ...request, idempotencyKey: randomUUID() })).rejects.toThrow(
      '创建结果未知',
    );
    await db.fissionAvatarSyncTask.update({
      where: { id },
      data: { updatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    expect((await sync.workspace(ids, true)).canGenerate).toBe(true);
  }, 30_000);

  it('stops stale inputs before the next paid action and never replaces a prior result', async () => {
    const { ids, request, voiceGrant, draft } = await readySync();
    await allowSpeaker(voiceGrant.id);
    const first = (await sync.create(ids, request)).task!.id;
    const firstToken = await acceptSync(ids, first);
    await sync.complete(ids, first, firstToken, proof, files(), 'c'.repeat(64));
    const second = (await sync.create(ids, { ...request, idempotencyKey: randomUUID() })).task!.id;
    const claim = await sync.claim(ids, second);
    if (claim.status !== 'CLAIMED') throw new Error('Claim failed');
    const token = claim.attemptToken;
    await sync.checkpoint(ids, second, token, { kind: 'TTS_SUBMIT' });
    const next = await repository.saveDraft(ids, {
      expectedRevision: draft.draft.revision,
      draft: { ...draft.draft.data, scriptText: '确认后的文本变化' },
    });
    await repository.confirmScript(ids, next.draft.revision);
    await expect(sync.checkpoint(ids, second, token, { kind: 'LIP_SYNC_SUBMIT' })).rejects.toThrow(
      '授权已变化',
    );
    expect(await sync.heartbeat(ids, second, token, { phase: 'TTS', progress: 25 })).toEqual({
      active: false,
    });
    const workspace = await sync.workspace(ids, true);
    expect(workspace.result).toMatchObject({ stale: true, revision: 1, durationMs: 2360 });
    expect(workspace.task).toMatchObject({ status: 'FAILED', stale: true, canRetry: false });
  }, 30_000);

  it('recovers only the uncertain segment, reuses checkpoints, and commits a validated long media revision', async () => {
    const sentence = '这是用于验证项目隔离和分段恢复的测试稿件'.repeat(2) + '。';
    const { ids, request, voiceGrant } = await readySync(sentence.repeat(3));
    await allowSpeaker(voiceGrant.id);
    const long = { ...request, mode: 'SEGMENTED' as const };
    await expect(sync.create(ids, long)).rejects.toThrow('暂未启用');
    const created = await sync.create(ids, long, true);
    const id = created.task!.id;
    expect((await sync.create(ids, long, true)).task?.id).toBe(id);
    expect(created.task).toMatchObject({ mode: 'SEGMENTED', segments: { total: 3, completed: 0 } });
    expect(
      await db.jobOutbox.count({
        where: { projectId: ids.projectId, routingKey: AVATAR_LONG_SYNC_QUEUE },
      }),
    ).toBe(1);
    const first = await sync.claim(ids, id);
    if (first.status !== 'CLAIMED' || first.input.schemaVersion !== 2)
      throw new Error('Expected a segmented task');
    const token = first.attemptToken;
    await expect(sync.checkpoint(ids, id, token, { kind: 'TTS_SUBMIT' })).rejects.toThrow(
      '分段检查点',
    );
    await expect(sync.segmentCheckpoint(ids, id, token, 2, { kind: 'TTS_SUBMIT' })).rejects.toThrow(
      '当前',
    );
    await expect(sync.resultAdmission(ids, id, token)).rejects.toThrow('尚未全部完成');

    const segmentProof = { ...proof, audioDurationMs: 21000, videoDurationMs: 21000 };
    const complete = async (ordinal: number, attempt: string, withAccept = true) => {
      if (withAccept) {
        await sync.segmentCheckpoint(ids, id, attempt, ordinal, { kind: 'TTS_SUBMIT' });
        await sync.segmentCheckpoint(ids, id, attempt, ordinal, { kind: 'LIP_SYNC_SUBMIT' });
        await sync.segmentCheckpoint(ids, id, attempt, ordinal, {
          kind: 'LIP_SYNC_ACCEPTED',
          providerTaskId: `amk-tool-lip-sync-${randomUUID()}`,
        });
      }
      await sync.completeSegment(
        ids,
        id,
        attempt,
        ordinal,
        segmentProof,
        files(),
        String(ordinal).repeat(64),
      );
    };
    await complete(1, token);
    expect(
      await sync.completeSegment(ids, id, token, 1, segmentProof, files(), '1'.repeat(64)),
    ).toBe(false);
    await sync.segmentCheckpoint(ids, id, token, 2, { kind: 'TTS_SUBMIT' });
    await sync.segmentCheckpoint(ids, id, token, 2, { kind: 'LIP_SYNC_SUBMIT' });
    await sync.fail(ids, id, token, { code: 'INTERNAL_API_FAILED', retryable: true });
    expect((await sync.workspace(ids, true, true)).task).toMatchObject({
      status: 'FAILED',
      canRetry: false,
      segments: { total: 3, completed: 1, failedOrdinal: 2 },
    });
    await expect(sync.create(ids, { ...long, idempotencyKey: randomUUID() }, true)).rejects.toThrow(
      '需要核对',
    );
    const reconcile = resolve(__dirname, '../../../../scripts/reconcile-avatar-sync.mjs');
    const clientToken = first.input.segments[1]!.lipSyncClientToken;
    const acceptedId = `amk-tool-lip-sync-${randomUUID()}`;
    const args = [
      reconcile,
      '--project',
      ids.projectId,
      '--run',
      ids.workflowRunId,
      '--task',
      id,
      '--client-token',
      clientToken,
      '--provider-task',
      acceptedId,
      '--confirm-provider-match',
      '--ordinal',
    ];
    await expect(runNode(process.execPath, [...args, '1'], { timeout: 8000 })).rejects.toThrow(
      '未匹配',
    );
    await runNode(process.execPath, [...args, '2'], { timeout: 8000 });
    await sync.action(ids, id, 'retry', true, true);
    const retry = await sync.claim(ids, id);
    if (retry.status !== 'CLAIMED' || retry.input.schemaVersion !== 2)
      throw new Error('Unable to claim segmented retry');
    expect(retry.attemptToken).not.toBe(token);
    expect(retry.input.segments[0]?.result).toMatchObject({ media: segmentProof });
    expect(retry.input.segments[1]).toMatchObject({
      ttsOperationId: first.input.segments[1]?.ttsOperationId,
      ttsStarted: true,
      lipSyncTaskId: acceptedId,
      result: null,
    });
    await expect(sync.segmentContent(ids, id, token, 1, 'audio')).rejects.toThrow('租约');
    await expect(
      sync.segmentContent(ids, id, retry.attemptToken, 1, 'audio'),
    ).resolves.toMatchObject({ mimeType: 'audio/mpeg' });
    await complete(2, retry.attemptToken, false);
    await complete(3, retry.attemptToken);
    const result = {
      schemaVersion: 2 as const,
      seamTimesMs: [21000, 42000],
      ...proof,
      audioDurationMs: 63000,
      videoDurationMs: 63000,
      wordTimings: [0, 21000, 42000].flatMap((position) =>
        proof.wordTimings.map((word) => ({
          ...word,
          startMs: word.startMs + position,
          endMs: word.endMs + position,
        })),
      ),
    };
    await expect(
      sync.complete(
        ids,
        id,
        retry.attemptToken,
        { ...result, seamTimesMs: [20000, 41000] },
        files(),
        'a'.repeat(64),
      ),
    ).rejects.toThrow('接缝');
    await sync.complete(ids, id, retry.attemptToken, result, files(), 'a'.repeat(64));
    expect(await sync.workspace(ids, true, true)).toMatchObject({
      result: { revision: 1, durationMs: 63000 },
      task: { status: 'SUCCEEDED', segments: { completed: 3, total: 3 } },
    });
    expect(await db.fileObject.count({ where: { ...ids, nodeId: AVATAR_SYNC_NODE } })).toBe(2);
    expect(
      await db.storageCleanupTask.count({
        where: { projectId: ids.projectId, reason: 'AVATAR_SYNC_SEGMENT_MEDIA' },
      }),
    ).toBe(6);
  }, 30_000);

  it('freezes the tail chain and preserves picture receipts across reconciliation and retry', async () => {
    const { ids, request, voiceGrant, characterGrant } = await readySync(
      '确认整稿测试。'.repeat(40),
    );
    await allowSpeaker(voiceGrant.id);
    const long = { ...request, mode: 'SEGMENTED' as const };
    await expect(sync.create(ids, long, true, true, true)).rejects.toThrow('未登记');
    const sourceTaskId = `cgt-${randomUUID()}`;
    const nextSourceTaskId = `cgt-${randomUUID()}`;
    const bindSource = (source: string, evidence = characterGrant.evidenceReference) =>
      runNode(
        process.execPath,
        [
          grantScript,
          'bind-seedance-source',
          '--project',
          ids.projectId,
          '--asset',
          characterGrant.assetId,
          '--version',
          String(characterGrant.assetVersion),
          '--evidence',
          evidence,
          '--seedance-source-task-id',
          source,
        ],
        { timeout: 8000 },
      );
    await expect(bindSource(sourceTaskId, 'different-evidence')).rejects.toThrow('记录号匹配');
    await bindSource(sourceTaskId);
    expect(await repository.workspace(ids)).toMatchObject({ binding: request.binding });
    await expect(
      db.fissionAvatarAssetGrant.findUnique({ where: { id: characterGrant.id } }),
    ).resolves.toEqual({ ...characterGrant, seedanceSourceTaskId: sourceTaskId });
    const created = await sync.create(ids, long, true, true, true);
    const taskId = created.task!.id;
    expect(created.task).toMatchObject({ mode: 'SEGMENTED', status: 'QUEUED' });
    expect(created.task?.segments).toBeUndefined();
    await expect(bindSource(sourceTaskId)).resolves.toMatchObject({
      stdout: expect.stringContaining('相同'),
    });
    await expect(bindSource(nextSourceTaskId)).rejects.toThrow('运行或待对账');
    expect((await sync.create(ids, long, true, true, false)).task?.id).toBe(taskId);
    const claim = await sync.claim(ids, taskId);
    if (claim.status !== 'CLAIMED' || claim.input.schemaVersion !== 3)
      throw new Error('Expected a tail-chain task');
    expect(claim.input).toMatchObject({ model: AVATAR_TAIL_CHAIN_MODEL, sourceTaskId, plan: null });
    const token = claim.attemptToken;
    const checkpoint = (body: Parameters<typeof sync.continuityCheckpoint>[3], attempt = token) =>
      sync.continuityCheckpoint(ids, taskId, attempt, body);
    const plan = {
      masterSha256: 'a'.repeat(64),
      sourceSamples: 65 * 24_000,
      segments: Array.from({ length: 5 }, (_, index) => ({
        sourceStartSample: index * 13 * 24_000,
        sourceEndSample: (index + 1) * 13 * 24_000,
        leadingSilenceSamples: 0,
        durationSeconds: 13,
      })),
    };
    await expect(checkpoint({ kind: 'PLAN_READY', plan })).rejects.toThrow('尚未登记');
    await expect(checkpoint({ kind: 'TTS_STARTED' })).resolves.toEqual({ allowed: true });
    await expect(checkpoint({ kind: 'TTS_STARTED' })).resolves.toEqual({ allowed: false });
    const planned = await checkpoint({ kind: 'PLAN_READY', plan });
    expect(planned.input).toMatchObject({ plan, ttsOperationId: claim.input.ttsOperationId });
    expect(planned.input?.segments).toHaveLength(5);
    await expect(checkpoint({ kind: 'PLAN_READY', plan })).resolves.toEqual(planned);
    await expect(
      checkpoint({ kind: 'PLAN_READY', plan: { ...plan, masterSha256: 'b'.repeat(64) } }),
    ).rejects.toThrow('其他切分计划');
    await expect(checkpoint({ kind: 'PICTURE_STARTED', ordinal: 2 })).rejects.toThrow('当前');
    await expect(
      sync.segmentCheckpoint(ids, taskId, token, 1, { kind: 'LIP_SYNC_SUBMIT' }),
    ).rejects.toThrow('已受理画面');
    await expect(checkpoint({ kind: 'PICTURE_STARTED', ordinal: 1 })).resolves.toEqual({
      allowed: true,
    });
    await expect(checkpoint({ kind: 'PICTURE_STARTED', ordinal: 1 })).resolves.toEqual({
      allowed: false,
    });
    await expect(
      checkpoint({ kind: 'PICTURE_ACCEPTED', ordinal: 1, providerTaskId: sourceTaskId }),
    ).rejects.toThrow('不能使用');
    const firstPicture = `cgt-${randomUUID()}`;
    await expect(
      checkpoint({ kind: 'PICTURE_ACCEPTED', ordinal: 1, providerTaskId: firstPicture }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      checkpoint({ kind: 'PICTURE_ACCEPTED', ordinal: 1, providerTaskId: firstPicture }),
    ).resolves.toEqual({ allowed: true });

    const segmentProof = { ...proof, audioDurationMs: 13_000, videoDurationMs: 13_000 };
    const complete = async (ordinal: number, attempt: string) => {
      await sync.segmentCheckpoint(ids, taskId, attempt, ordinal, { kind: 'LIP_SYNC_SUBMIT' });
      await sync.segmentCheckpoint(ids, taskId, attempt, ordinal, {
        kind: 'LIP_SYNC_ACCEPTED',
        providerTaskId: `amk-tool-lip-sync-${randomUUID()}`,
      });
      if (ordinal === 1) {
        await expect(
          sync.completeSegment(
            ids,
            taskId,
            attempt,
            ordinal,
            { ...segmentProof, audioDurationMs: 12_999 },
            files(),
            '1'.repeat(64),
          ),
        ).rejects.toThrow('冻结的驱动计划');
      }
      return sync.completeSegment(
        ids,
        taskId,
        attempt,
        ordinal,
        segmentProof,
        files(),
        String(ordinal).repeat(64),
      );
    };
    await complete(1, token);
    await checkpoint({ kind: 'PICTURE_STARTED', ordinal: 2 });
    await sync.fail(ids, taskId, token, { code: 'INTERNAL_API_FAILED', retryable: true });
    expect((await sync.workspace(ids, true, true, true)).task).toMatchObject({
      status: 'FAILED',
      canRetry: false,
      segments: { completed: 1, failedOrdinal: 2 },
    });
    await expect(
      sync.create(ids, { ...long, idempotencyKey: randomUUID() }, true, true, true),
    ).rejects.toThrow('需要核对');
    await expect(bindSource(nextSourceTaskId)).rejects.toThrow('运行或待对账');
    const secondPicture = `cgt-${randomUUID()}`;
    const reconcile = resolve(__dirname, '../../../../scripts/reconcile-avatar-sync.mjs');
    await runNode(
      process.execPath,
      [
        reconcile,
        '--project',
        ids.projectId,
        '--run',
        ids.workflowRunId,
        '--task',
        taskId,
        '--client-token',
        planned.input!.segments[1]!.lipSyncClientToken,
        '--picture',
        '--ordinal',
        '2',
        '--provider-task',
        secondPicture,
        '--confirm-provider-match',
      ],
      { timeout: 8000 },
    );
    await sync.action(ids, taskId, 'retry', true, true, true);
    const resumed = await sync.claim(ids, taskId);
    if (resumed.status !== 'CLAIMED' || resumed.input.schemaVersion !== 3)
      throw new Error('Expected to resume the tail chain');
    expect(resumed.input).toMatchObject({
      plan,
      ttsOperationId: claim.input.ttsOperationId,
      segments: [
        expect.objectContaining({
          pictureTaskId: firstPicture,
          result: { media: segmentProof, audio: expect.any(Object), video: expect.any(Object) },
        }),
        expect.objectContaining({ pictureTaskId: secondPicture, result: null }),
        ...Array.from({ length: 3 }, () => expect.objectContaining({ pictureStarted: false })),
      ],
    });
    await expect(checkpoint({ kind: 'PICTURE_STARTED', ordinal: 3 })).rejects.toThrow('租约');
    await complete(2, resumed.attemptToken);
    for (const ordinal of [3, 4, 5]) {
      await checkpoint({ kind: 'PICTURE_STARTED', ordinal }, resumed.attemptToken);
      await checkpoint(
        { kind: 'PICTURE_ACCEPTED', ordinal, providerTaskId: `cgt-${randomUUID()}` },
        resumed.attemptToken,
      );
      await complete(ordinal, resumed.attemptToken);
    }
    const result = {
      schemaVersion: 2 as const,
      seamTimesMs: [13_000, 26_000, 39_000, 52_000],
      ...proof,
      audioDurationMs: 65_000,
      videoDurationMs: 65_000,
      wordTimings: [0, 13_000, 26_000, 39_000, 52_000].flatMap((position) =>
        proof.wordTimings.map((word) => ({
          ...word,
          startMs: word.startMs + position,
          endMs: word.endMs + position,
        })),
      ),
    };
    await sync.complete(ids, taskId, resumed.attemptToken, result, files(), 'a'.repeat(64));
    await bindSource(nextSourceTaskId);
    expect(await sync.workspace(ids, true, true, true)).toMatchObject({
      result: { revision: 1, durationMs: 65_000, stale: false, videoUrl: expect.any(String) },
      task: { status: 'SUCCEEDED', segments: { completed: 5 } },
    });
    await expect(
      db.fissionAvatarAssetGrant.findUnique({ where: { id: characterGrant.id } }),
    ).resolves.toEqual({ ...characterGrant, seedanceSourceTaskId: nextSourceTaskId });
  }, 30_000);

  it('fences composition drafts, approves only measured output, and archives a scoped immutable revision', async () => {
    const { ids, request, voiceGrant, characterGrant } = await readySync();
    await allowSpeaker(voiceGrant.id);
    const syncId = (await sync.create(ids, request)).task!.id;
    await sync.complete(ids, syncId, await acceptSync(ids, syncId), proof, files(), 'c'.repeat(64));
    const source = (await render.workspace(ids, true)).source!;
    expect(source.captions).toEqual([{ startMs: 0, endMs: 200, text: '测' }]);
    const syncRef = { artifactId: source.artifactId, revision: source.revision };
    const settings = {
      background: { kind: 'SOLID' as const, color: '#0f172a' },
      insetPercent: 12,
      captionMode: 'SIDECAR' as const,
      captions: source.captions,
    };
    const saved = await render.saveDraft(
      ids,
      { expectedRevision: 0, sync: syncRef, settings },
      true,
    );
    expect(saved.draft?.revision).toBe(1);
    await expect(
      working.pauseRun(ids.projectId, ids.workflowRunId, {
        expectedAvatarDraftRevision: request.expectedDraftRevision,
        expectedAvatarCompositionDraftRevision: 0,
      }),
    ).rejects.toThrow('背景与字幕草稿');
    const confirmed = await render.confirm(ids, 1, true);
    const ref = {
      artifactId: confirmed.composition!.artifactId,
      revision: confirmed.composition!.revision,
    };
    expect((await render.confirm(ids, 1, true)).composition).toMatchObject({
      revision: 1,
      stale: false,
    });
    const create = { composition: ref, idempotencyKey: randomUUID() };
    await expect(
      render.create(ids, { ...create, nativeSourceAccepted: syncRef }, true),
    ).rejects.toThrow('不支持原生原片确认');
    const [first, repeated] = await Promise.all([
      render.create(ids, create, true),
      render.create(ids, create, true),
    ]);
    const id = first.task!.id;
    expect(repeated.task?.id).toBe(id);
    expect(
      await db.jobOutbox.count({
        where: { projectId: ids.projectId, routingKey: AVATAR_RENDER_QUEUE },
      }),
    ).toBe(1);
    const claim = await render.claim(ids, id);
    if (claim.status !== 'CLAIMED') throw new Error('Render claim failed');
    await expect(render.source(ids, id, randomUUID(), 'audio')).rejects.toThrow('租约');
    await expect(render.source(ids, id, claim.attemptToken, 'audio')).resolves.toMatchObject({
      mimeType: 'audio/mpeg',
    });
    const media = {
      audioDurationMs: 2350,
      videoDurationMs: 2360,
      audioLagMs: 0,
      minimumAudioCorrelationPermille: 998,
    };
    const staged = () => ({
      video: { ...files().video, nodeId: AVATAR_OUTPUT_NODE },
      subtitles: {
        ...files().audio,
        nodeId: AVATAR_OUTPUT_NODE,
        mimeType: 'application/x-subrip',
        originalFileName: 'speech.srt',
      },
    });
    const stagedFiles = staged();
    expect(
      await render.complete(ids, id, claim.attemptToken, media, stagedFiles, 'd'.repeat(64)),
    ).toBe(true);
    expect(
      await render.complete(ids, id, claim.attemptToken, media, staged(), 'd'.repeat(64)),
    ).toBe(false);
    expect(await render.workspace(ids, true)).toMatchObject({
      task: { status: 'AWAITING_REVIEW' },
      output: null,
    });
    await expect(render.output(ids, 1, 'video')).rejects.toThrow('不可用');
    await expect(render.archive(ids, 1)).rejects.toThrow('不可用');
    await expect(render.candidate(ids, id)).resolves.toMatchObject({
      sha256: stagedFiles.video.sha256,
    });
    const pass = {
      sha256: stagedFiles.video.sha256,
      method: 'fixture-v1',
      coveragePermille: 970,
      confidencePermille: 900,
      maxAbsOffsetMs: 100,
    };
    await expect(render.review(ids, id, { ...pass, sha256: 'f'.repeat(64) })).rejects.toThrow(
      '摘要',
    );
    expect(await render.review(ids, id, pass)).toEqual({ accepted: true, passed: true });
    expect(await render.review(ids, id, pass)).toEqual({ accepted: true, passed: true });
    await expect(render.output(ids, 1, 'subtitles')).resolves.toMatchObject({
      mimeType: 'application/x-subrip',
    });
    const [archived, replayed] = await Promise.all([
      render.archive(ids, 1),
      render.archive(ids, 1),
    ]);
    expect(archived).toEqual(replayed);
    const archive = (await assets.find(ids.projectId, archived.assetId))!;
    expect(await assets.canReadAvatarRenderArchive(archive)).toBe(true);

    const secondDraft = await render.saveDraft(
      ids,
      {
        expectedRevision: 1,
        sync: syncRef,
        settings: { ...settings, captions: [{ ...source.captions[0]!, text: '二次修订' }] },
      },
      true,
    );
    expect(secondDraft.output?.stale).toBe(false);
    const secondConfirm = await render.confirm(ids, 2, true);
    expect(secondConfirm.output?.stale).toBe(true);
    const nextRef = { artifactId: ref.artifactId, revision: 2 };
    const second = (
      await render.create(ids, { composition: nextRef, idempotencyKey: randomUUID() }, true)
    ).task!.id;
    const next = await render.claim(ids, second);
    if (next.status !== 'CLAIMED') throw new Error('Second render claim failed');
    await render.complete(ids, second, next.attemptToken, media, staged(), 'e'.repeat(64));
    expect(await render.review(ids, second, { ...pass, maxAbsOffsetMs: 101 })).toEqual({
      accepted: true,
      passed: false,
    });
    expect(await render.workspace(ids, true)).toMatchObject({
      task: { status: 'FAILED' },
      output: { revision: 1, stale: true },
    });
    expect(await db.fissionAvatarSyncTask.count({ where: ids })).toBe(1);
    const third = (
      await render.create(ids, { composition: nextRef, idempotencyKey: randomUUID() }, true)
    ).task!.id;
    const thirdAttempt = await render.claim(ids, third);
    if (thirdAttempt.status !== 'CLAIMED') throw new Error('Third render claim failed');
    await render.heartbeat(ids, third, thirdAttempt.attemptToken, {
      phase: 'VALIDATING',
      progress: 97,
    });
    const thirdFiles = staged();
    await render.complete(ids, third, thirdAttempt.attemptToken, media, thirdFiles, 'f'.repeat(64));
    expect((await render.workspace(ids, true)).task).toMatchObject({
      status: 'AWAITING_REVIEW',
      progress: 97,
    });
    await db.fissionAvatarAssetGrant.update({
      where: { id: characterGrant.id },
      data: { revokedAt: new Date() },
    });
    await expect(render.output(ids, 1, 'video')).rejects.toThrow('不可用');
    await expect(render.archive(ids, 1)).rejects.toThrow('不可用');
    expect(await assets.canReadAvatarRenderArchive(archive)).toBe(false);
    await db.fissionAvatarRenderTask.update({
      where: { id: third },
      data: { leaseExpiresAt: new Date(1) },
    });
    await render.recoverExpired();
    expect(await db.fissionAvatarRenderTask.findUnique({ where: { id: third } })).toMatchObject({
      status: 'FAILED',
      errorCode: 'SOURCE_STALE',
      candidate: null,
    });
    expect(
      await db.storageCleanupTask.count({
        where: { projectId: ids.projectId, storageKey: thirdFiles.video.storageKey },
      }),
    ).toBe(1);
  }, 30_000);
});
