<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Archive,
  AudioLines,
  Check,
  Download,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Search,
  Sparkles,
  Upload,
  UserRound,
  Video,
} from '@lucide/vue';
import {
  AVATAR_COMPOSITION_NODE,
  AVATAR_LONG_LIMITS,
  AVATAR_NATIVE_LIMITS,
  AVATAR_OUTPUT_NODE,
  AVATAR_RENDER_LIMITS,
  AVATAR_SCRIPT_MAX_LENGTH,
  AVATAR_SYNC_NODE,
  AVATAR_SYNC_LIMITS,
  estimateAvatarScriptDurationMs,
  FISSION_AVATAR_NODES,
  type AvatarAssetRef,
} from '@ai-marketing/contracts';
import { WorkflowRunProgress } from '@ai-marketing/ui';
import { apiUrl, safeApiErrorMessage } from '../../../api/http-client';
import { importAsset } from '../../../platform/asset/api/asset.api';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import AvatarCompositionPanel from './AvatarCompositionPanel.vue';
import AvatarStudioLayout from './AvatarStudioLayout.vue';
import AvatarTimeline from './AvatarTimeline.vue';
import AvatarToolTabs, { type AvatarTool } from './AvatarToolTabs.vue';
import {
  createAvatarRenderWorkspace,
  isAvatarLongRenderSource,
  sameAvatarRevision,
} from './avatar-render-workspace';
import {
  avatarSegmentProgress,
  avatarSyncAvailability,
  avatarSyncMode,
  createAvatarSyncWorkspace,
  type AvatarSyncMode,
} from './avatar-sync-workspace';
import { createAvatarWorkspace, sameAvatarAsset } from './avatar-workspace';

const props = defineProps<{ projectId: string; projectName: string }>();
const store = createAvatarWorkspace();
const { workspace, draft, loading, unavailable, saving, confirming, conflict, dirty, error } =
  store;
const sync = createAvatarSyncWorkspace();
const {
  projection: syncProjection,
  active: syncActive,
  loading: syncLoading,
  acting: syncActing,
  error: syncError,
  refreshError: syncRefreshError,
} = sync;
const render = createAvatarRenderWorkspace();
const confirmingNativeRender = ref(false);
const {
  projection: renderProjection,
  editable: compositionDraft,
  loading: renderLoading,
  saving: compositionSaving,
  acting: renderActing,
  active: renderActive,
  dirty: compositionDirty,
  conflict: compositionConflict,
  alreadyConfirmed: compositionConfirmed,
  validationError: compositionValidation,
  error: renderError,
  refreshError: renderRefreshError,
} = render;
const tool = ref<AvatarTool>('avatar');
const selectedSyncMode = ref<AvatarSyncMode | null>(null);
const syncMode = computed<AvatarSyncMode>({
  get: () => avatarSyncMode(syncProjection.value, selectedSyncMode.value),
  set: (mode) => (selectedSyncMode.value = mode),
});
const nativeMode = computed(() => syncMode.value === 'NATIVE');
const nativeDuration = ref<number>(AVATAR_NATIVE_LIMITS.maxDurationSeconds);
const nativeDurations = Array.from(
  { length: AVATAR_NATIVE_LIMITS.maxDurationSeconds - AVATAR_NATIVE_LIMITS.minDurationSeconds + 1 },
  (_, index) => AVATAR_NATIVE_LIMITS.minDurationSeconds + index,
);
const editorLabel = computed(() => (nativeMode.value ? '生成提示词' : '口播文案'));
const editorLimit = computed(() =>
  nativeMode.value ? AVATAR_NATIVE_LIMITS.maxPromptCharacters : AVATAR_SCRIPT_MAX_LENGTH,
);
const editorLength = computed(() => Array.from(draft.value?.scriptText.trim() ?? '').length);
const query = ref('');
const page = ref(1);
const importError = ref('');
let importAttempt = 0;
const editor = ref<HTMLTextAreaElement>();
const scriptUploadInput = ref<HTMLInputElement>();
const characterUploadInput = ref<HTMLInputElement>();
const characterImporting = ref(false);
const characterRefreshing = ref(false);
const characterImportFeedback = ref('');
let characterImport: AbortController | undefined;
let characterRefreshAttempt = 0;
const previewChoice = ref<'video' | 'audio' | 'character' | 'output'>('video');
const backgroundImporting = ref(false);
const backgroundImportFeedback = ref('');
let backgroundImport: AbortController | undefined;
const player = ref<HTMLMediaElement>();
const playhead = ref(0);
const eligibleCharacters = computed(() =>
  (workspace.value?.characters ?? []).filter(
    (asset) => !nativeMode.value || asset.previewKind === 'IMAGE',
  ),
);
const visibleCharacters = computed(() =>
  eligibleCharacters.value.filter((character) =>
    character.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
  ),
);
const perPage = 6;
const pageCount = computed(() => Math.max(1, Math.ceil(visibleCharacters.value.length / perPage)));
const pageCharacters = computed(() =>
  visibleCharacters.value.slice((page.value - 1) * perPage, page.value * perPage),
);
const character = computed(() =>
  workspace.value?.characters.find((asset) =>
    sameAvatarAsset(asset, draft.value?.character ?? null),
  ),
);
const eligibleVoices = computed(() =>
  (workspace.value?.voices ?? []).filter(
    (asset) => !nativeMode.value || asset.nativeReferenceAvailable,
  ),
);
const voiceSelection = computed(() =>
  nativeMode.value ? draft.value?.nativeVoice : draft.value?.voice,
);
const voice = computed(() =>
  eligibleVoices.value.find((asset) => sameAvatarAsset(asset, voiceSelection.value)),
);
const characterConfirmed = computed(
  () =>
    !!character.value &&
    !!workspace.value?.binding &&
    sameAvatarAsset(character.value, workspace.value.binding.content.character) &&
    character.value.authorizationId === workspace.value.binding.content.authorizationId,
);
const scriptConfirmed = computed(
  () =>
    !!draft.value &&
    workspace.value?.script?.content.text === draft.value.scriptText.trim() &&
    workspace.value.script.content.source === draft.value.scriptSource,
);
const duration = computed(
  () => estimateAvatarScriptDurationMs(draft.value?.scriptText ?? '') / 1000,
);
const status = computed(() => {
  if (conflict.value) return '草稿有冲突';
  if (confirming.value) return '正在提交';
  if (saving.value) return '正在保存草稿';
  if (dirty.value) return '草稿未保存';
  return workspace.value?.draft.revision ? '草稿已保存' : '等待选择形象';
});
const syncTask = computed(() => syncProjection.value?.task);
const showSyncMode = computed(
  () =>
    !!syncProjection.value?.long?.enabled ||
    !!syncProjection.value?.native?.enabled ||
    syncMode.value !== 'SHORT',
);
const segmentProgress = computed(() => avatarSegmentProgress(syncTask.value));
const longModeLabel = `长片（${AVATAR_LONG_LIMITS.minDurationMs / 1000}–${AVATAR_LONG_LIMITS.maxDurationMs / 1000} 秒）`;
const shortModeLabel = `短片（最多 ${AVATAR_SYNC_LIMITS.maxDurationMs / 1000} 秒）`;
const maxLongScriptCharacters =
  AVATAR_LONG_LIMITS.maxSegments * AVATAR_LONG_LIMITS.maxSegmentCharacters;
const syncResult = computed(() =>
  sync.sourceVerified.value ? syncProjection.value?.result : null,
);
const videoUrl = computed(() => syncResult.value?.videoUrl);
const nativeVideoUrl = computed(() =>
  syncResult.value?.mode === 'NATIVE' ? videoUrl.value : null,
);
const audioUrl = computed(() => syncResult.value?.audioUrl);
const hasResultMedia = computed(() => !!videoUrl.value || !!audioUrl.value);
const output = computed(() => renderProjection.value?.output);
const outputUrl = computed(() => output.value?.videoUrl);
const renderTask = computed(() => renderProjection.value?.task);
const longRenderSource = computed(() => isAvatarLongRenderSource(renderProjection.value?.source));
const compositionTool = computed(() =>
  tool.value === 'background' || tool.value === 'subtitle' ? tool.value : null,
);
const compositionSourceCurrent = computed(
  () =>
    !!syncResult.value &&
    !syncResult.value.stale &&
    sameAvatarRevision(syncResult.value, renderProjection.value?.source),
);
const canEditComposition = computed(
  () =>
    !!renderProjection.value?.enabled &&
    compositionSourceCurrent.value &&
    render.sourceMatches.value &&
    !renderActing.value &&
    !compositionConflict.value &&
    !backgroundImporting.value,
);
const currentBackground = computed(() => {
  const selection = compositionDraft.value?.settings.background;
  if (selection?.kind !== 'IMAGE') return null;
  return (
    renderProjection.value?.backgrounds.find((item) => sameAvatarAsset(item, selection)) ?? null
  );
});
const compositionBlock = computed(() => {
  if (renderLoading.value) return '正在读取合成方案。';
  if (!renderProjection.value?.enabled) return '成片渲染暂未开放。';
  if (!compositionSourceCurrent.value) return '请先生成当前版本的口播视频。';
  if (!render.sourceMatches.value) return '草稿使用旧版口播时标，请应用当前时标后确认。';
  if (compositionDraft.value?.settings.background.kind === 'IMAGE' && !currentBackground.value)
    return '已选背景版本不可用，请重新选择。';
  if (compositionValidation.value) return compositionValidation.value;
  if (
    compositionDraft.value?.settings.captionMode !== 'OFF' &&
    !compositionDraft.value?.settings.captions.length
  )
    return '请添加字幕条目或关闭字幕。';
  return '';
});
const renderBlock = computed(() => {
  if (compositionBlock.value) return compositionBlock.value;
  if (!compositionConfirmed.value) return '请先在背景或字幕面板确认合成方案。';
  if (!renderProjection.value?.canRender)
    return renderProjection.value?.blockedReason ?? '当前无法渲染。';
  return '';
});
async function startRender() {
  if (renderBlock.value || renderActive.value || renderActing.value || confirmingNativeRender.value)
    return;
  const current = renderProjection.value;
  const source = current?.source;
  if (source?.mode !== 'NATIVE') {
    await render.generate();
    return;
  }
  confirmingNativeRender.value = true;
  try {
    const confirmed = await requestActionConfirmation({
      title: '确认原片音画效果',
      description: '请确认已预览原片，声音和人物口型符合预期。合成会保留原片的音画关系。',
      confirmLabel: '确认并渲染',
      cancelLabel: '返回预览',
    });
    const latest = renderProjection.value;
    if (
      confirmed &&
      latest?.projectId === current?.projectId &&
      latest?.workflowRunId === current?.workflowRunId &&
      sameAvatarRevision(latest?.source, source) &&
      sameAvatarRevision(latest?.composition, current?.composition)
    )
      await render.generate(source);
  } finally {
    confirmingNativeRender.value = false;
  }
}
const renderStatus = computed(() => {
  if (renderTask.value?.stale) return '此渲染任务使用的方案已更新。';
  if (renderTask.value?.status === 'AWAITING_REVIEW') return '编码完成，等待口型同步核验。';
  if (renderTask.value && renderTask.value.status !== 'SUCCEEDED') return renderTask.value.message;
  if (output.value?.stale) return '上一版成片可用，当前方案待重新渲染。';
  if (output.value && !outputUrl.value) return '当前授权下无法访问已发布成片。';
  if (outputUrl.value) return '成片可下载和归档。';
  if (nativeVideoUrl.value)
    return syncResult.value?.stale ? '上一版原片可用。' : '生成原片可预览和下载。';
  return renderBlock.value || '合成方案已确认。';
});
const preview = computed(() => {
  if (previewChoice.value === 'output' && outputUrl.value) return 'output';
  if (previewChoice.value === 'character' || !hasResultMedia.value) return 'character';
  if (previewChoice.value === 'audio' && audioUrl.value) return 'audio';
  return videoUrl.value ? 'video' : 'audio';
});
const compositionPreview = computed(
  () =>
    preview.value === 'video' &&
    compositionTool.value &&
    compositionSourceCurrent.value &&
    render.sourceMatches.value &&
    compositionDraft.value?.settings,
);
const visibleCaption = computed(() => {
  const settings = compositionPreview.value;
  if (!settings || (settings.captionMode !== 'BURN' && settings.captionMode !== 'BOTH')) return '';
  const timeMs = playhead.value * 1000;
  return settings.captions.find((cue) => cue.startMs <= timeMs && timeMs < cue.endMs)?.text || '';
});
const previewTitle = computed(() => {
  if (preview.value === 'output') return output.value?.stale ? '上一版成片' : '已核验成片';
  if (compositionPreview.value) return '9:16 · 1080P · 合成预览';
  if (preview.value === 'character') return '形象素材预览';
  const mediaTitle = preview.value === 'audio' ? '口播音轨' : '口播视频';
  return syncResult.value?.stale ? `待更新 · 上一版${mediaTitle}` : mediaTitle;
});
const resultDuration = computed(() => {
  if (preview.value === 'output') return (output.value?.durationMs ?? 0) / 1000;
  return hasResultMedia.value ? (syncResult.value?.durationMs ?? 0) / 1000 : 0;
});
const resultTracks = computed(() => {
  const clip = { start: 0, duration: resultDuration.value, text: '' };
  if (preview.value === 'output')
    return { video: [{ ...clip, id: 'output', title: '已核验成片' }], audio: [], subtitle: [] };
  const settings = compositionDraft.value?.settings;
  const captions =
    compositionSourceCurrent.value && render.sourceMatches.value && settings?.captionMode !== 'OFF'
      ? (settings?.captions ?? [])
      : [];
  return {
    video: videoUrl.value ? [{ ...clip, id: 'video', title: '口播视频' }] : [],
    audio: audioUrl.value ? [{ ...clip, id: 'audio', title: '口播音轨' }] : [],
    subtitle: captions.flatMap((cue, index) =>
      cue.startMs >= 0 &&
      cue.endMs > cue.startMs &&
      cue.endMs <= Math.round(resultDuration.value * 1000) &&
      cue.text.trim()
        ? [
            {
              id: `subtitle-${index}`,
              start: cue.startMs / 1000,
              duration: (cue.endMs - cue.startMs) / 1000,
              text: cue.text,
              title: cue.text,
            },
          ]
        : [],
    ),
  };
});
const generateBlock = computed(() => {
  if (syncLoading.value) return '正在读取口播任务状态…';
  const segmented = syncMode.value === 'SEGMENTED';
  const availability = avatarSyncAvailability(syncProjection.value, syncMode.value);
  if (!availability?.enabled)
    return availability?.blockedReason ?? (segmented ? '口播长片暂未开放。' : '口播生成暂未开放。');
  if (!characterConfirmed.value) return '请先采用已授权的数字人形象。';
  if (nativeMode.value && character.value?.previewKind !== 'IMAGE')
    return '请选择已授权的形象图片。';
  if (!scriptConfirmed.value) return `请先确认${editorLabel.value}。`;
  if (nativeMode.value && editorLength.value > AVATAR_NATIVE_LIMITS.maxPromptCharacters)
    return `提示词最多支持 ${AVATAR_NATIVE_LIMITS.maxPromptCharacters} 字。`;
  if (nativeMode.value && draft.value?.nativeVoice && !voice.value)
    return '参考音色已不可用，请重新选择或切换为模型自动配音。';
  if (!nativeMode.value) {
    const maxCharacters = segmented
      ? maxLongScriptCharacters
      : AVATAR_SYNC_LIMITS.maxScriptCharacters;
    if (editorLength.value > maxCharacters)
      return `口播${segmented ? '长片' : '短片'}最多支持 ${maxCharacters} 字。`;
    if (!voice.value) return '请选择项目音色。';
  }
  if (!dirty.value && !sync.sourceVerified.value) return '正在核对口播素材。';
  if (!dirty.value && !availability.canGenerate)
    return availability.blockedReason ?? `当前素材无法生成口播${segmented ? '长片' : '视频'}。`;
  return '';
});
const taskFallback = {
  QUEUED: '口播任务已排队',
  RUNNING: '正在生成数字人口播',
  SUCCEEDED: '口播生成完成',
  FAILED: '口播生成失败',
  CANCELLED: '口播任务已取消',
} as const;
const syncTaskSummary = computed(() => {
  const task = syncTask.value;
  if (!task) return '';
  const message = task.message || taskFallback[task.status];
  const progress = segmentProgress.value;
  return progress && !message.includes(progress) ? `${message} · ${progress}` : message;
});
const protectedMedia = (url: string) => apiUrl(url.startsWith('/api/') ? url.slice(4) : url);
const downloadMedia = (url: string) =>
  `${protectedMedia(url)}${url.includes('?') ? '&' : '?'}download=1`;

watch(query, () => (page.value = 1));
watch(syncMode, () => {
  importAttempt++;
  importError.value = '';
  page.value = 1;
});
watch(pageCount, (count) => (page.value = Math.min(count, page.value)));
watch(
  () => props.projectId,
  (projectId) => {
    tool.value = 'avatar';
    previewChoice.value = 'video';
    query.value = '';
    importError.value = '';
    importAttempt++;
    backgroundImport?.abort();
    backgroundImporting.value = false;
    backgroundImportFeedback.value = '';
    void store.open(projectId);
  },
  { immediate: true },
);
watch(
  () => [workspace.value?.projectId ?? '', workspace.value?.workflowRunId ?? ''] as const,
  ([projectId, runId], [previousProjectId, previousRunId]) => {
    if (projectId === previousProjectId && runId === previousRunId) return;
    selectedSyncMode.value = null;
    nativeDuration.value = AVATAR_NATIVE_LIMITS.maxDurationSeconds;
    characterImport?.abort();
    characterRefreshAttempt++;
    characterImporting.value = false;
    characterRefreshing.value = false;
    characterImportFeedback.value = '';
    sync.setScope(projectId, runId);
    render.setScope(projectId, runId);
  },
  { flush: 'sync' },
);
watch(
  () =>
    workspace.value &&
    [
      workspace.value.binding?.artifactId,
      workspace.value.binding?.revision,
      workspace.value.script?.artifactId,
      workspace.value.script?.revision,
      workspace.value.draft.data.voice?.assetId,
      workspace.value.draft.data.voice?.version,
      workspace.value.draft.data.nativeVoice?.assetId,
      workspace.value.draft.data.nativeVoice?.version,
      workspace.value.characters.find((item) =>
        sameAvatarAsset(item, workspace.value?.binding?.content.character ?? null),
      )?.authorizationId,
      workspace.value.voices.find((item) =>
        sameAvatarAsset(item, workspace.value?.draft.data.voice ?? null),
      )?.authorizationId,
      workspace.value.voices.find(
        (item) =>
          item.nativeReferenceAvailable &&
          sameAvatarAsset(item, workspace.value?.draft.data.nativeVoice),
      )?.authorizationId,
    ].join('|'),
  (value, previous) => {
    if (value !== null && previous !== null) void sync.refreshForSourceChange();
  },
  { flush: 'sync' },
);
watch(
  () =>
    syncProjection.value?.result &&
    `${syncProjection.value.result.artifactId}:${syncProjection.value.result.revision}:${syncProjection.value.result.stale}`,
  () => {
    if (previewChoice.value !== 'output') previewChoice.value = 'video';
    void render.refresh();
  },
);
watch([preview, videoUrl, audioUrl, outputUrl], () => (playhead.value = 0));

function chooseTool(next: AvatarTool) {
  tool.value = next;
  if (next === 'background' || next === 'subtitle') {
    previewChoice.value = 'video';
    void render.refresh();
  }
}

async function uploadCharacter(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const current = workspace.value;
  if (
    !file ||
    input !== characterUploadInput.value ||
    !current ||
    !nativeMode.value ||
    characterImporting.value
  )
    return;
  if (
    !['image/png', 'image/jpeg'].includes(file.type) ||
    file.size < 1 ||
    file.size > AVATAR_NATIVE_LIMITS.maxImageBytes
  ) {
    characterImportFeedback.value = `请选择 ${AVATAR_NATIVE_LIMITS.maxImageBytes / 1048576} MiB 以内的 PNG 或 JPEG 形象图片。`;
    return;
  }
  const request = new AbortController();
  characterImport = request;
  characterImporting.value = true;
  characterImportFeedback.value = '';
  try {
    await importAsset(
      current.projectId,
      file,
      {
        name: file.name.slice(0, 120),
        directory: 'VISUAL_ASSETS',
        type: 'AVATAR_REFERENCE',
        tags: [],
        storageWorkflow: 'FISSION',
        workflowSpace: 'FISSION_AVATAR',
      },
      request.signal,
    );
    if (!request.signal.aborted)
      characterImportFeedback.value = '形象图已上传到项目资产，授权后可刷新形象列表。';
  } catch (reason) {
    if (!request.signal.aborted)
      characterImportFeedback.value = safeApiErrorMessage(reason, '形象图上传失败，请重试。');
  } finally {
    if (!request.signal.aborted) characterImporting.value = false;
  }
}

async function refreshCharacters() {
  const current = workspace.value;
  if (!current || characterRefreshing.value) return;
  const attempt = ++characterRefreshAttempt;
  characterRefreshing.value = true;
  const stillCurrent = () =>
    attempt === characterRefreshAttempt &&
    workspace.value?.projectId === current.projectId &&
    workspace.value.workflowRunId === current.workflowRunId;
  try {
    const updated = await store.refreshCharacters();
    if (stillCurrent())
      characterImportFeedback.value = updated
        ? '已刷新授权形象列表。'
        : '暂未更新形象列表，请再试一次。';
  } catch (reason) {
    if (stillCurrent())
      characterImportFeedback.value = safeApiErrorMessage(reason, '形象列表刷新失败，请重试。');
  } finally {
    if (stillCurrent()) characterRefreshing.value = false;
  }
}

async function uploadBackground(file: File) {
  const current = workspace.value;
  if (!current || !canEditComposition.value) return;
  backgroundImportFeedback.value = '';
  if (
    !['image/png', 'image/jpeg'].includes(file.type) ||
    file.size < 1 ||
    file.size > AVATAR_RENDER_LIMITS.maxBackgroundBytes
  ) {
    backgroundImportFeedback.value = '请选择 12 MiB 以内的 PNG 或 JPEG 图片。';
    return;
  }
  const request = new AbortController();
  backgroundImport = request;
  backgroundImporting.value = true;
  try {
    const { data } = await importAsset(
      current.projectId,
      file,
      {
        name: file.name.slice(0, 120),
        directory: 'VISUAL_ASSETS',
        type: 'SCENE_BACKGROUND',
        tags: [],
        storageWorkflow: 'FISSION',
        workflowSpace: 'FISSION_AVATAR',
      },
      request.signal,
    );
    if (request.signal.aborted) return;
    const loaded = await render.refresh();
    if (request.signal.aborted || workspace.value?.workflowRunId !== current.workflowRunId) return;
    const selected =
      loaded &&
      renderProjection.value?.backgrounds.find(
        (asset) => asset.assetId === data.id && asset.version === data.currentVersion,
      );
    if (selected && compositionSourceCurrent.value && render.sourceMatches.value) {
      render.edit({
        background: { kind: 'IMAGE', assetId: selected.assetId, version: selected.version },
      });
      backgroundImportFeedback.value = '背景图片已导入项目并选中。';
    } else {
      backgroundImportFeedback.value = '图片已导入项目资产，可刷新查看可用背景。';
    }
  } catch (reason) {
    if (!request.signal.aborted)
      backgroundImportFeedback.value = safeApiErrorMessage(reason, '背景导入失败，请重试。');
  } finally {
    if (!request.signal.aborted) backgroundImporting.value = false;
  }
}

function generate() {
  if (
    generateBlock.value ||
    confirming.value ||
    conflict.value ||
    backgroundImporting.value ||
    characterImporting.value
  )
    return;
  const mode = syncMode.value;
  const durationSeconds = nativeDuration.value;
  void sync.generate(async () => {
    if (compositionDirty.value && !(await render.flushPendingEdits())) return null;
    if (!(await store.flushPendingEdits())) return null;
    const current = workspace.value;
    if (!current?.binding || !current.script || !characterConfirmed.value || !scriptConfirmed.value)
      return null;
    const { binding, script } = current;
    const source = {
      expectedDraftRevision: current.draft.revision,
      binding: { artifactId: binding.artifactId, revision: binding.revision },
      script: { artifactId: script.artifactId, revision: script.revision },
    };
    if (mode === 'NATIVE') return { ...source, mode, durationSeconds };
    if (mode === 'SEGMENTED') return { ...source, mode };
    return source;
  });
}

async function confirmInput(node: 'binding' | 'script') {
  if (backgroundImporting.value) return;
  if (compositionDirty.value && !(await render.flushPendingEdits())) return;
  await store.confirm(node);
}

function seekResult(time: number) {
  if (player.value && player.value.readyState > 0) player.value.currentTime = time;
}

function selectAsset(kind: 'character' | 'voice' | 'nativeVoice', asset: AvatarAssetRef) {
  store.edit({ [kind]: { assetId: asset.assetId, version: asset.version } });
}

function updateScript(event: Event) {
  importAttempt++;
  importError.value = '';
  store.edit({ scriptText: (event.target as HTMLTextAreaElement).value, scriptSource: 'MANUAL' });
}

async function importScript(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !workspace.value || syncActing.value) return;
  const attempt = ++importAttempt;
  importError.value = '';
  if (!file.name.toLowerCase().endsWith('.txt') || file.size > editorLimit.value * 4 + 3) {
    importError.value = `请选择符合${editorLabel.value}长度限制的 UTF-8 TXT 文件。`;
    return;
  }
  try {
    const scriptText = new TextDecoder('utf-8', { fatal: true })
      .decode(await file.arrayBuffer())
      .replace(/\r\n?/g, '\n');
    if (attempt !== importAttempt || syncActing.value) return;
    if (
      !scriptText.trim() ||
      scriptText.length > AVATAR_SCRIPT_MAX_LENGTH ||
      (nativeMode.value && Array.from(scriptText.trim()).length > editorLimit.value) ||
      scriptText.includes('\0')
    ) {
      importError.value = `${editorLabel.value}须为 1–${editorLimit.value.toLocaleString()} 字的纯文本。`;
      return;
    }
    store.edit({ scriptText, scriptSource: 'TXT' });
  } catch {
    if (attempt === importAttempt)
      importError.value = `无法读取${editorLabel.value}，请使用 UTF-8 编码的 TXT 文件。`;
  }
}

async function openEditor() {
  tool.value = 'copy';
  await nextTick();
  editor.value?.focus();
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (
    !dirty.value &&
    !compositionDirty.value &&
    !backgroundImporting.value &&
    !characterImporting.value
  )
    return;
  event.preventDefault();
  event.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  importAttempt++;
  characterImport?.abort();
  characterRefreshAttempt++;
  backgroundImport?.abort();
  store.dispose();
  sync.dispose();
  render.dispose();
});
defineExpose({
  async flushPendingEdits() {
    if (backgroundImporting.value || characterImporting.value) return false;
    await sync.waitForAction();
    return (await render.flushPendingEdits()) && store.flushPendingEdits();
  },
  workflowRunId: computed(() => workspace.value?.workflowRunId ?? ''),
  draftRevision: computed(() => workspace.value?.draft.revision ?? null),
  compositionDraftRevision: computed(() => renderProjection.value?.draft?.revision ?? null),
  resumeWorkflowNode(nodeId: string) {
    if (nodeId === FISSION_AVATAR_NODES.binding || nodeId === AVATAR_SYNC_NODE)
      tool.value = 'avatar';
    else if (nodeId === FISSION_AVATAR_NODES.script) void openEditor();
    else if (nodeId === AVATAR_COMPOSITION_NODE) chooseTool('background');
    else if (nodeId === AVATAR_OUTPUT_NODE) previewChoice.value = 'output';
    else return false;
    return true;
  },
});
</script>

<template>
  <section v-if="!projectId" class="avatar-workspace-state">
    <UserRound :size="38" />
    <h2>数字人口播剪辑工作台</h2>
    <p>打开项目后，可选用项目内的已授权形象和音色。</p>
  </section>
  <section v-else-if="loading" class="avatar-workspace-state" role="status">
    <LoaderCircle class="avatar-workspace-spinner" :size="32" />
    <h2>正在加载数字人口播工作台…</h2>
  </section>
  <section v-else-if="!workspace || !draft" class="avatar-workspace-state" role="alert">
    <UserRound :size="38" />
    <h2>{{ unavailable ? '数字人口播暂未启用' : '工作台加载失败' }}</h2>
    <p>{{ error }}</p>
    <button v-if="!unavailable" class="fas-btn primary" @click="store.open(projectId)">
      重新加载
    </button>
  </section>
  <template v-else>
    <div v-if="error" class="avatar-error" role="alert">
      <span>{{ error }}</span>
      <template v-if="conflict">
        <button :disabled="confirming" @click="store.resolveConflict(true)">合并我的修改</button>
        <button :disabled="confirming" @click="store.resolveConflict(false)">载入服务器草稿</button>
      </template>
      <button v-else-if="dirty" :disabled="saving" @click="store.flushPendingEdits">
        重试保存
      </button>
    </div>
    <AvatarStudioLayout :class="{ 'avatar-long-mode-available': showSyncMode }">
      <template #header>
        <div class="fas-brand">
          <span>AI</span>
          <div>
            <b>数字人口播剪辑工作台</b><small>{{ projectName || '当前项目' }}</small>
          </div>
        </div>
        <div class="fas-output-name">
          <b>{{ character?.name ?? '未选择数字人' }}</b>
          <small v-if="nativeMode"
            >原生有声视频 ·
            {{ voice?.name ?? (voiceSelection ? '音色不可用' : '模型自动配音') }}</small
          >
          <small v-else
            >{{ voice?.name ?? '未选择音色'
            }}<template v-if="duration"> · 预计 {{ duration }} 秒</template></small
          >
        </div>
        <div class="fas-save-state" role="status">
          <i :class="saving ? 'rendering' : ''" />{{ status }}
        </div>
        <div class="fas-top-spacer" />
        <button class="fas-btn" :disabled="confirming || syncActing" @click="openEditor">
          编辑{{ editorLabel }}
        </button>
        <button
          class="fas-btn primary"
          :disabled="
            !!generateBlock ||
            syncActive ||
            syncActing ||
            confirming ||
            conflict ||
            backgroundImporting ||
            characterImporting
          "
          :title="generateBlock || undefined"
          @click="generate"
        >
          <Sparkles :size="14" />{{
            nativeMode
              ? '生成有声视频'
              : syncMode === 'SEGMENTED'
                ? '生成数字人口播长片'
                : '生成数字人口播视频'
          }}
        </button>
      </template>

      <template #status>
        <div class="avatar-sync-status">
          <div v-if="showSyncMode" class="avatar-sync-mode">
            <label>
              生成方式
              <select v-model="syncMode" :disabled="syncActive || syncActing">
                <option
                  v-if="
                    syncProjection?.native?.enabled || syncTask?.mode === 'NATIVE' || nativeMode
                  "
                  value="NATIVE"
                  :disabled="!syncProjection?.native?.enabled"
                >
                  形象图生成有声视频
                </option>
                <option value="SHORT" :disabled="!syncProjection?.enabled">
                  {{ shortModeLabel }}
                </option>
                <option value="SEGMENTED" :disabled="!syncProjection?.long?.enabled">
                  {{ longModeLabel }}
                </option>
              </select>
            </label>
            <label v-if="nativeMode && !syncActive">
              生成时长
              <select v-model.number="nativeDuration" :disabled="syncActing || confirming">
                <option v-for="seconds in nativeDurations" :key="seconds" :value="seconds">
                  {{ seconds }} 秒
                </option>
              </select>
            </label>
          </div>
          <WorkflowRunProgress
            v-if="syncTask"
            action-label=""
            :progress="syncTask.progress"
            :terminal="!syncActive"
            :summary="syncTaskSummary"
            :warning="syncTask.stale ? '此任务使用的来源已更新' : ''"
            :tone="syncTask.stale ? 'update' : 'default'"
          />
          <div v-if="syncTask?.canCancel || syncTask?.canRetry" class="avatar-sync-actions">
            <button
              v-if="syncTask.canCancel"
              type="button"
              class="fas-btn"
              :disabled="syncActing"
              @click="sync.change('cancel')"
            >
              取消任务
            </button>
            <button
              v-if="syncTask.canRetry"
              type="button"
              class="fas-btn"
              :disabled="syncActing"
              @click="sync.change('retry')"
            >
              {{ syncTask.segments?.failedOrdinal ? '重试失败分段' : '重试任务' }}
            </button>
          </div>
          <p
            v-if="generateBlock && !syncActive && !syncRefreshError && !syncError"
            class="fas-copy-note"
            role="status"
          >
            {{ generateBlock }}
          </p>
          <p v-if="syncError" class="fas-copy-note" role="alert">{{ syncError }}</p>
          <p v-if="syncRefreshError" class="fas-copy-note avatar-sync-refresh" role="alert">
            {{ syncRefreshError }}
            <button type="button" class="fas-btn" :disabled="syncActing" @click="sync.refresh">
              刷新任务状态
            </button>
          </p>
        </div>
        <div v-if="renderError" class="avatar-error" role="alert">
          <span>{{ renderError }}</span>
          <template v-if="compositionConflict">
            <button
              type="button"
              :disabled="renderActing || !render.sourceMatches.value"
              @click="render.resolveConflict(true)"
            >
              保留我的合成草稿
            </button>
            <button type="button" :disabled="renderActing" @click="render.resolveConflict(false)">
              载入服务器合成草稿
            </button>
          </template>
          <button
            v-else-if="compositionDirty"
            type="button"
            :disabled="compositionSaving || !!compositionValidation"
            @click="render.flushPendingEdits"
          >
            重试保存合成草稿
          </button>
        </div>
      </template>

      <template #tools>
        <AvatarToolTabs
          :active="tool"
          :busy="confirming || syncActing"
          :unavailable="{
            ...(!renderProjection?.enabled && { background: '待开放', subtitle: '待开放' }),
          }"
          @choose="chooseTool"
        />
      </template>

      <template #resources>
        <template v-if="tool === 'avatar'">
          <div class="fas-panel-head">
            <div>
              <b>项目数字人资产</b><small>{{ eligibleCharacters.length }} 个已授权版本</small>
            </div>
          </div>
          <label class="fas-search">
            <Search :size="14" /><input
              v-model="query"
              aria-label="搜索数字人"
              placeholder="按名称搜索数字人"
            />
          </label>
          <template v-if="nativeMode">
            <input
              ref="characterUploadInput"
              type="file"
              accept="image/png,image/jpeg"
              hidden
              @change="uploadCharacter"
            />
            <button
              type="button"
              class="fas-wide-import"
              :disabled="characterImporting || confirming || syncActing"
              @click="characterUploadInput?.click()"
            >
              <Upload :size="14" />{{ characterImporting ? '正在上传形象图…' : '上传形象图' }}
            </button>
            <button
              type="button"
              class="fas-btn avatar-refresh-characters"
              :disabled="characterImporting || characterRefreshing || confirming || syncActing"
              @click="refreshCharacters"
            >
              {{ characterRefreshing ? '正在刷新授权…' : '刷新授权列表' }}
            </button>
            <p v-if="characterImportFeedback" class="fas-copy-note" role="status">
              {{ characterImportFeedback }}
            </p>
          </template>
          <div class="fas-avatar-list">
            <button
              v-for="item in pageCharacters"
              :key="`${item.assetId}:${item.version}`"
              class="fas-avatar-item"
              :class="{ selected: sameAvatarAsset(draft.character, item) }"
              :aria-pressed="sameAvatarAsset(draft.character, item)"
              :disabled="confirming || syncActing"
              @click="selectAsset('character', item)"
            >
              <span class="fas-avatar-face">
                <img
                  v-if="item.previewUrl && item.previewKind === 'IMAGE'"
                  :src="protectedMedia(item.previewUrl)"
                  alt=""
                  loading="lazy"
                />
                <UserRound v-else :size="22" />
              </span>
              <span
                ><b>{{ item.name }}</b
                ><em>项目资产 · v{{ item.version }}</em></span
              >
              <i><Check v-if="sameAvatarAsset(draft.character, item)" :size="12" /></i>
            </button>
          </div>
          <p v-if="!pageCharacters.length" class="fas-empty">
            {{
              eligibleCharacters.length
                ? '没有匹配的数字人资产。'
                : nativeMode
                  ? '当前项目暂无已授权的形象图片。'
                  : '当前项目暂无已授权的数字人版本。'
            }}
          </p>
          <div v-if="pageCount > 1" class="fas-pager">
            <button aria-label="上一页" :disabled="page <= 1" @click="page--">
              <ChevronLeft :size="14" />
            </button>
            <span>{{ page }} / {{ pageCount }}</span>
            <button aria-label="下一页" :disabled="page >= pageCount" @click="page++">
              <ChevronRight :size="14" />
            </button>
          </div>
        </template>
        <template v-else-if="tool === 'voice'">
          <div class="fas-panel-head">
            <div>
              <b>{{ nativeMode ? '参考项目音色' : '项目音色' }}</b
              ><small>{{ eligibleVoices.length }} 个已授权版本</small>
            </div>
          </div>
          <div class="fas-choice-list">
            <button
              v-if="nativeMode"
              type="button"
              :class="{ selected: !voiceSelection }"
              :aria-pressed="!voiceSelection"
              :disabled="confirming || syncActing || syncActive"
              @click="store.edit({ nativeVoice: null })"
            >
              <i><Sparkles :size="16" /></i>
              <span><b>模型自动配音</b></span>
              <em><Check v-if="!voiceSelection" :size="14" /></em>
            </button>
            <button
              v-for="item in eligibleVoices"
              :key="`${item.assetId}:${item.version}`"
              type="button"
              :class="{ selected: sameAvatarAsset(voiceSelection, item) }"
              :aria-pressed="sameAvatarAsset(voiceSelection, item)"
              :disabled="confirming || syncActing || (nativeMode && syncActive)"
              @click="selectAsset(nativeMode ? 'nativeVoice' : 'voice', item)"
            >
              <i><AudioLines :size="16" /></i>
              <span
                ><b>{{ item.name }}</b
                ><small>项目资产 · v{{ item.version }}</small></span
              >
              <em><Check v-if="sameAvatarAsset(voiceSelection, item)" :size="14" /></em>
            </button>
          </div>
          <p v-if="!eligibleVoices.length" class="fas-empty">
            {{ nativeMode ? '当前项目暂无可用的参考音色。' : '当前项目暂无已授权的音色版本。' }}
          </p>
          <p v-if="nativeMode" class="fas-copy-note">
            支持 {{ AVATAR_NATIVE_LIMITS.minReferenceAudioSeconds }}–{{
              AVATAR_NATIVE_LIMITS.maxReferenceAudioSeconds
            }}
            秒的 MP3 或 WAV。
          </p>
        </template>
        <template v-else-if="compositionTool">
          <AvatarCompositionPanel
            v-if="compositionDraft"
            :tool="compositionTool"
            :settings="compositionDraft.settings"
            :backgrounds="renderProjection?.backgrounds ?? []"
            :duration-ms="renderProjection?.source?.durationMs ?? 0"
            :long-source="longRenderSource"
            :disabled="!canEditComposition"
            :importing="backgroundImporting"
            :import-feedback="backgroundImportFeedback"
            @edit="render.edit"
            @upload="uploadBackground"
          />
          <div v-else class="fas-panel-head">
            <div>
              <b>{{ compositionTool === 'background' ? '画布背景' : '字幕' }}</b>
            </div>
          </div>
          <p v-if="!compositionDraft" class="fas-copy-note">生成口播视频后即可调整合成方案。</p>
        </template>
        <template v-else>
          <div class="fas-panel-head">
            <div>
              <b>{{ editorLabel }}</b>
              <small
                >{{ editorLength }} 字<template v-if="duration && !nativeMode">
                  · 预计 {{ duration }} 秒</template
                ></small
              >
            </div>
          </div>
          <textarea
            ref="editor"
            :value="draft.scriptText"
            :maxlength="editorLimit"
            :disabled="confirming || syncActing"
            class="fas-copy-editor"
            :aria-label="editorLabel"
            :placeholder="nativeMode ? '描述场景、人物动作和要说的台词…' : '请输入数字人口播文案…'"
            @input="updateScript"
            @blur="store.flushPendingEdits"
          />
          <input
            ref="scriptUploadInput"
            type="file"
            accept=".txt,text/plain"
            hidden
            :disabled="confirming || syncActing"
            @change="importScript"
          />
          <button
            type="button"
            class="fas-wide-import"
            :disabled="confirming || syncActing"
            @click="scriptUploadInput?.click()"
          >
            <Upload :size="14" />导入{{ editorLabel }} TXT
          </button>
          <p v-if="importError" class="fas-copy-note" role="alert">{{ importError }}</p>
        </template>
      </template>

      <template #player>
        <header>
          <b>播放器（画面预览区）</b><span>{{ previewTitle }}</span>
        </header>
        <div class="fas-preview-stage">
          <div
            class="fas-video-frame avatar-project-frame"
            :class="{
              'avatar-sync-frame':
                preview !== 'character' && !compositionPreview && preview !== 'output',
              'avatar-composition-frame': compositionPreview || preview === 'output',
            }"
            :style="
              compositionPreview
                ? {
                    '--avatar-frame-inset': `${compositionPreview.insetPercent}%`,
                    backgroundColor:
                      compositionPreview.background.kind === 'SOLID'
                        ? compositionPreview.background.color
                        : '#18263D',
                  }
                : undefined
            "
          >
            <img
              v-if="compositionPreview && currentBackground?.previewUrl"
              class="avatar-composition-backdrop"
              :src="protectedMedia(currentBackground.previewUrl)"
              alt=""
            />
            <video
              v-if="preview === 'output' && outputUrl"
              :key="outputUrl"
              ref="player"
              :src="protectedMedia(outputUrl)"
              controls
              playsinline
              preload="metadata"
              :aria-label="previewTitle"
              @timeupdate="playhead = player?.currentTime ?? 0"
            />
            <video
              v-else-if="preview === 'video' && videoUrl"
              :key="videoUrl"
              ref="player"
              :class="{ 'avatar-composition-video': compositionPreview }"
              :src="protectedMedia(videoUrl)"
              controls
              playsinline
              preload="metadata"
              :aria-label="previewTitle"
              @timeupdate="playhead = player?.currentTime ?? 0"
            />
            <audio
              v-else-if="preview === 'audio' && audioUrl"
              :key="audioUrl"
              ref="player"
              class="avatar-project-audio"
              :src="protectedMedia(audioUrl)"
              :aria-label="previewTitle"
              controls
              preload="metadata"
              @timeupdate="playhead = player?.currentTime ?? 0"
            />
            <img
              v-else-if="character?.previewUrl && character.previewKind === 'IMAGE'"
              class="fas-background-media"
              :src="protectedMedia(character.previewUrl)"
              :alt="character.name"
            />
            <video
              v-else-if="character?.previewUrl && character.previewKind === 'VIDEO'"
              :key="character.previewUrl"
              :src="protectedMedia(character.previewUrl)"
              controls
              muted
              playsinline
              preload="metadata"
              :aria-label="character.name"
            />
            <span v-else>{{ character ? '暂无预览文件' : '选择形象后预览' }}</span>
            <span v-if="visibleCaption" class="avatar-composition-caption">{{
              visibleCaption
            }}</span>
          </div>
        </div>
        <div
          v-if="hasResultMedia || outputUrl"
          class="avatar-preview-options"
          aria-label="预览内容"
        >
          <button
            v-if="videoUrl"
            type="button"
            class="fas-btn"
            :aria-pressed="preview === 'video'"
            @click="previewChoice = 'video'"
          >
            口播视频
          </button>
          <button
            v-if="audioUrl"
            type="button"
            class="fas-btn"
            :aria-pressed="preview === 'audio'"
            @click="previewChoice = 'audio'"
          >
            口播音轨
          </button>
          <button
            v-if="character?.previewUrl"
            type="button"
            class="fas-btn"
            :aria-pressed="preview === 'character'"
            @click="previewChoice = 'character'"
          >
            形象素材
          </button>
          <button
            v-if="outputUrl"
            type="button"
            class="fas-btn"
            :aria-pressed="preview === 'output'"
            @click="previewChoice = 'output'"
          >
            {{ output?.stale ? '上一版成片' : '预览成片' }}
          </button>
        </div>
      </template>

      <template #inspector>
        <header><b>参数配置</b></header>
        <div class="fas-inspector-body">
          <template v-if="tool === 'avatar'">
            <div v-if="character" class="fas-selected-summary">
              <span class="fas-avatar-face"><UserRound :size="22" /></span>
              <div>
                <b>{{ character.name }}</b
                ><small>项目授权 · v{{ character.version }}</small>
              </div>
            </div>
            <p v-else class="fas-copy-note">
              {{
                draft.character ? '已选形象版本不可用，请重新选择。' : '请从左侧选择数字人形象。'
              }}
            </p>
            <button
              class="fas-btn primary"
              :disabled="
                !character ||
                characterConfirmed ||
                confirming ||
                conflict ||
                syncActing ||
                backgroundImporting
              "
              @click="confirmInput('binding')"
            >
              {{ characterConfirmed ? '已采用此形象' : '采用此形象' }}
            </button>
          </template>
          <template v-else-if="tool === 'voice'">
            <div v-if="voice" class="fas-selected-summary">
              <i class="audio"><AudioLines :size="18" /></i>
              <div>
                <b>{{ voice.name }}</b
                ><small>项目授权 · v{{ voice.version }}</small>
              </div>
            </div>
            <p v-else-if="!nativeMode || voiceSelection" class="fas-copy-note">
              {{ voiceSelection ? '已选音色版本不可用，请重新选择。' : '请从左侧选择音色。' }}
            </p>
            <audio
              v-if="voice?.previewUrl && voice.previewKind === 'AUDIO'"
              :key="voice.previewUrl"
              class="avatar-project-audio"
              :src="protectedMedia(voice.previewUrl)"
              :aria-label="`试听${voice.name}`"
              controls
              preload="none"
            />
            <p v-else-if="voice" class="fas-copy-note">该音色未提供试听文件。</p>
            <p v-if="nativeMode" class="fas-copy-note">
              {{
                voice
                  ? '模型会参考这段音频的声线，台词以当前文案为准。'
                  : '选择项目音色可引导模型生成的声线。'
              }}
            </p>
          </template>
          <template v-else-if="compositionTool">
            <div v-if="compositionDraft" class="avatar-composition-controls">
              <template v-if="compositionTool === 'background'">
                <label v-if="compositionDraft.settings.background.kind === 'SOLID'">
                  背景颜色
                  <input
                    type="color"
                    :value="compositionDraft.settings.background.color"
                    :disabled="!canEditComposition"
                    @input="
                      render.edit({
                        background: {
                          kind: 'SOLID',
                          color: ($event.target as HTMLInputElement).value,
                        },
                      })
                    "
                  />
                </label>
                <label>
                  画面边距 {{ compositionDraft.settings.insetPercent }}%
                  <input
                    type="range"
                    :min="AVATAR_RENDER_LIMITS.minInsetPercent"
                    :max="AVATAR_RENDER_LIMITS.maxInsetPercent"
                    :value="compositionDraft.settings.insetPercent"
                    :disabled="!canEditComposition"
                    @input="
                      render.edit({
                        insetPercent: ($event.target as HTMLInputElement).valueAsNumber,
                      })
                    "
                  />
                </label>
              </template>
              <p v-else class="fas-copy-note">字幕时间以确认的口播音轨为准。</p>
              <button
                v-if="compositionSourceCurrent && !render.sourceMatches.value"
                type="button"
                class="fas-btn"
                :disabled="renderActing || compositionConflict"
                @click="render.useCurrentSource"
              >
                应用当前口播时标
              </button>
            </div>
            <p v-if="compositionBlock" class="fas-copy-note" role="status">
              {{ compositionBlock }}
            </p>
            <p
              v-else-if="compositionSaving || compositionDirty"
              class="fas-copy-note"
              role="status"
            >
              {{ compositionSaving ? '正在保存合成草稿…' : '合成草稿尚未保存。' }}
            </p>
            <button
              type="button"
              class="fas-btn primary"
              :disabled="
                !!compositionBlock ||
                compositionConfirmed ||
                renderActing ||
                compositionConflict ||
                backgroundImporting
              "
              @click="render.confirm"
            >
              {{ compositionConfirmed ? '合成方案已确认' : '确认合成方案' }}
            </button>
          </template>
          <template v-else>
            <p class="fas-copy-note">
              {{
                !characterConfirmed
                  ? '请先在数字人面板采用已授权形象。'
                  : scriptConfirmed
                    ? `当前${editorLabel}已确认。`
                    : `确认后的${editorLabel}用于生成口播。`
              }}
            </p>
            <button
              class="fas-btn primary"
              :disabled="
                !characterConfirmed ||
                !draft.scriptText.trim() ||
                (nativeMode && editorLength > editorLimit) ||
                scriptConfirmed ||
                confirming ||
                conflict ||
                syncActing ||
                backgroundImporting
              "
              @click="confirmInput('script')"
            >
              {{ scriptConfirmed ? `${editorLabel}已确认` : `确认${editorLabel}` }}
            </button>
            <details
              v-if="hasResultMedia && syncResult?.wordTimings.length"
              class="avatar-word-timings"
            >
              <summary>{{ syncResult.stale ? '上一版字级时间点' : '字级时间点' }}</summary>
              <ol>
                <li v-for="(word, index) in syncResult.wordTimings" :key="index">
                  {{ word.text }} <span>{{ word.startMs }}–{{ word.endMs }} 毫秒</span>
                </li>
              </ol>
            </details>
          </template>
        </div>
      </template>

      <template #timeline>
        <AvatarTimeline
          :tracks="resultTracks"
          :duration="resultDuration"
          :playhead="playhead"
          :selection="[]"
          :can-undo="false"
          :can-redo="false"
          :generated="hasResultMedia || !!outputUrl"
          :unavailable="hasResultMedia || outputUrl ? '' : '生成后可在这里预览视频与口播音轨。'"
          read-only
          @seek="seekResult"
        />
      </template>

      <template #artifacts>
        <section class="fas-artifact-entry-bar">
          <span class="fas-artifact-entry-icon"><Archive :size="23" /></span>
          <div>
            <b>数字人口播项目产物</b><small>{{ projectName }} · 当前工作副本</small>
          </div>
          <em
            >已确认
            {{
              Number(!!workspace.binding) +
              Number(!!workspace.script) +
              Number(!!syncResult && !syncResult.stale) +
              Number(!!renderProjection?.composition && !renderProjection.composition.stale) +
              Number(!!output && !output.stale && !!outputUrl)
            }}
            项</em
          >
        </section>
      </template>

      <template #render>
        <div>
          <i
            :class="{
              rendering: renderActive,
              completed: !!(outputUrl || nativeVideoUrl) && !renderActive,
            }"
          />
          <span role="status"
            ><b>渲染输出</b><small>{{ renderStatus }}</small></span
          >
        </div>
        <div
          v-if="renderTask || outputUrl || nativeVideoUrl || renderRefreshError"
          class="avatar-render-actions"
        >
          <a v-if="nativeVideoUrl" class="fas-btn" :href="downloadMedia(nativeVideoUrl)" download
            ><Download :size="13" />{{ syncResult?.stale ? '下载上一版原片' : '下载生成原片' }}</a
          >
          <div
            v-if="renderTask?.status === 'QUEUED' || renderTask?.status === 'RUNNING'"
            class="fas-render-progress"
            role="progressbar"
            aria-label="成片渲染进度"
            :aria-valuenow="renderTask.progress"
          >
            <i :style="{ width: `${renderTask.progress}%` }" />
          </div>
          <button
            v-if="renderTask?.canCancel"
            type="button"
            class="fas-btn"
            :disabled="renderActing"
            @click="render.change('cancel')"
          >
            取消渲染
          </button>
          <button
            v-if="renderTask?.canRetry"
            type="button"
            class="fas-btn"
            :disabled="renderActing"
            @click="render.change('retry')"
          >
            重试渲染
          </button>
          <template v-if="outputUrl && output">
            <a class="fas-btn" :href="downloadMedia(outputUrl)" download
              ><Download :size="13" />下载 MP4</a
            >
            <a
              v-if="output.subtitlesUrl"
              class="fas-btn"
              :href="downloadMedia(output.subtitlesUrl)"
              download
              >下载 SRT</a
            >
            <button
              v-if="!output.archive"
              type="button"
              class="fas-btn"
              :disabled="renderActing"
              @click="render.archive"
            >
              <Archive :size="13" />归档到项目
            </button>
            <small v-else role="status">已归档到项目 · v{{ output.archive.version }}</small>
          </template>
          <div v-if="renderRefreshError" class="avatar-sync-refresh" role="alert">
            <small>{{ renderRefreshError }}</small>
            <button type="button" class="fas-btn" :disabled="renderActing" @click="render.refresh">
              刷新成片状态
            </button>
          </div>
        </div>
        <button
          type="button"
          :disabled="
            !!renderBlock ||
            renderActive ||
            renderActing ||
            confirmingNativeRender ||
            compositionConflict ||
            backgroundImporting
          "
          :title="renderBlock || undefined"
          @click="startRender"
        >
          <Video :size="14" />{{ outputUrl ? '重新渲染' : '渲染成片' }}
        </button>
      </template>
    </AvatarStudioLayout>
  </template>
</template>

<style scoped>
.avatar-workspace-state {
  display: flex;
  min-height: 420px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  border: 1px solid #dbe4f6;
  border-radius: 20px;
  background: #fff;
  text-align: center;
  color: #475569;
}

.avatar-workspace-state h2,
.avatar-workspace-state p {
  margin: 0;
}

.avatar-workspace-spinner {
  color: #2563eb;
  animation: avatar-workspace-spin 1s linear infinite;
}

@keyframes avatar-workspace-spin {
  to {
    transform: rotate(360deg);
  }
}

.avatar-project-frame {
  display: grid;
  min-height: 210px;
  place-items: center;
  background: #e2e8f0;
  color: #475569;
  font-size: 12px;
}

.avatar-project-frame > img,
.avatar-project-frame > video {
  object-fit: contain;
}

.avatar-project-audio {
  max-width: 100%;
  margin-top: 12px;
}

.avatar-sync-frame {
  width: min(95%, 620px);
  aspect-ratio: auto;
  min-height: 0;
}

.avatar-composition-frame {
  width: auto;
  max-width: 98%;
  min-height: 0;
  aspect-ratio: 9/16;
  background-color: #18263d;
}

.avatar-project-frame > .avatar-composition-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-project-frame > .avatar-composition-video {
  inset: var(--avatar-frame-inset);
  width: calc(100% - var(--avatar-frame-inset) * 2);
  height: calc(100% - var(--avatar-frame-inset) * 2);
}

.avatar-composition-caption {
  position: absolute;
  pointer-events: none;
  right: 8%;
  bottom: 9%;
  left: 8%;
  color: #fff;
  text-align: center;
  text-shadow:
    0 1px 3px #000,
    0 0 2px #000;
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.avatar-composition-controls {
  display: grid;
  gap: 8px;
}

.avatar-composition-controls label {
  display: grid;
  gap: 4px;
  color: #475569;
  font-size: 11px;
}

.avatar-composition-controls input[type='range'] {
  width: 100%;
}

.avatar-render-actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.avatar-render-actions .fas-render-progress {
  flex: 1 1 60px;
  min-width: 45px;
}

.avatar-render-actions .fas-btn {
  min-width: 0;
  text-decoration: none;
}

.fas-render-dock > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

@media (max-width: 900px) {
  .avatar-render-actions {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-content: flex-start;
    padding-bottom: 5px;
  }
}

.avatar-preview-options,
.avatar-sync-actions,
.avatar-sync-refresh {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.avatar-preview-options {
  align-content: center;
  padding: 4px 8px;
  border-top: 1px solid var(--line);
}

.avatar-preview-options .fas-btn[aria-pressed='true'] {
  color: #1d4ed8;
  background: #eaf2ff;
  border-color: #93c5fd;
}

@media (max-width: 520px) {
  :deep(.fas-player-panel:has(.avatar-preview-options)) {
    grid-template-rows: 37px minmax(0, 1fr) auto;
  }

  .avatar-preview-options .fas-btn {
    min-height: 26px;
    padding: 0 5px;
    font-size: 11px;
  }
}

.avatar-sync-status {
  display: grid;
  gap: 6px;
}

.avatar-sync-status:empty {
  display: none;
}

.avatar-sync-mode {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding: 3px 10px;
  color: #475569;
  font-size: 11px;
}

.avatar-sync-mode label {
  display: flex;
  align-items: center;
  gap: 5px;
}

.avatar-refresh-characters {
  margin: 5px 0;
}

.avatar-sync-mode select {
  max-width: 100%;
  min-height: 28px;
  padding: 2px 5px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  font: inherit;
}

@media (min-width: 1181px) {
  .fas-studio.avatar-long-mode-available {
    min-height: 780px;
  }
}

.avatar-sync-status :deep(.workflow-run-progress) {
  margin: 0;
}

.avatar-sync-status .fas-copy-note {
  margin: 0;
}

.avatar-word-timings {
  margin-top: 12px;
  overflow: auto;
  color: #475569;
  font-size: 11px;
}

.avatar-word-timings summary {
  cursor: pointer;
}

.avatar-word-timings ol {
  max-height: 145px;
  margin: 6px 0 0;
  overflow: auto;
}

.avatar-word-timings span {
  margin-inline-start: 4px;
  color: #64748b;
}

.fas-inspector-body > .fas-btn {
  margin-top: 12px;
}

.avatar-error {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
