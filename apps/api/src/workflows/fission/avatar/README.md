# 数字人口播 API

`FISSION_AVATAR_ENABLED` 默认关闭。启用后可创建或恢复当前项目的数字人口播 Run，编辑草稿、确认形象和口播稿，并预览有授权的形象和音色。需要执行语音合成和唇形驱动时，单独启用 `FISSION_AVATAR_SYNC_ENABLED`。

原生模式可选用项目音色。应用 `20261125170000_fission_avatar_seedance_voice_reference` 后，根据实际授权为当前项目的 MP3 或 WAV 音色版本登记方舟参考权限。单文件上限为 15 MiB，Worker 在提交前检查解码时长为 2–30 秒。

```powershell
node scripts/manage-avatar-asset-grant.mjs grant --project <项目UUID> --asset <音色UUID> --version <版本> --evidence <授权记录号> --seedance-voice-reference
node scripts/manage-avatar-asset-grant.mjs bind-seedance-voice-reference --project <项目UUID> --asset <音色UUID> --version <版本> --evidence <授权记录号>
```

已有有效授权且记录覆盖方舟参考用途时，使用第二条命令登记。此操作沿用现有授权 ID；撤销或过期后，引用该授权的原生口播及 G3 交付按授权规则处理。

## 资产登记

试点使用项目数字人库中状态可用的形象或音色版本。经业务授权核验的运维人员，在目标库应用对应迁移后，可使用受控数据库连接登记具体版本。登记参数仅使用授权记录号，实际证据保留在授权记录系统。省略 `--expires-at` 表示授权记录没有到期时间。

在 `apps/api` 目录运行下列命令，数据库连接通过 `DATABASE_URL` 提供。

```text
node scripts/manage-avatar-asset-grant.mjs grant --project <项目UUID> --asset <资产UUID> --version <版本号> --evidence <授权记录号> --expires-at <含时区的ISO时间>
node scripts/manage-avatar-asset-grant.mjs revoke --project <项目UUID> --asset <资产UUID> --version <版本号>
```

撤销后该版本从可选项移除，之前发出的工作台预览路径即时在下次请求时校验。重新登记同版本生成新的授权记录，已有确认结果须重新确认授权。

## 形象图原生口播

应用 `20261125110000_fission_avatar_native_sync` 后，可通过默认关闭的 `FISSION_AVATAR_NATIVE_ENABLED` 开启。原生任务可独立于 MediaKit 和长片开关运行。先启动使用方舟凭据的原生同步消费者。

工作台提交已确认的形象、提示词及现有草稿 revision，使用 `mode: 'NATIVE'` 和 4–30 整数秒的 `durationSeconds`。形象沿用当前项目有效授权的 JPEG 或 PNG 资产版本，大小上限为 8 MiB。通过方舟肖像授权流程的素材在登记项目授权时使用 `--seedance-portrait-asset-id asset-…`。Worker 从授权记录读取对应标识。

原生任务按项目和 Run 保存提交意图及原任务 ID。供应商已受理的任务按原 ID 续跑。受理不明时，核实目标任务的唯一方舟回执后，用 `reconcile-avatar-sync.mjs --native` 配合当前任务的客户端令牌登记回执。

同步通过媒体校验后可预览有声 MP4，视频地址加 `&download=1` 可下载原片。背景和手工字幕可继续使用现有包装及评审流程。

## 口播素材生成

在形象和文案确认后选择项目音色。音色授权登记命令使用 `--doubao-speaker <已批准的普通话预置音色 ID>` 绑定该版本的生成能力。已有只含预览权限的音色需要经核验后重新登记授权。试点接收 1–30 秒、64 MiB 以内的单人 SDR MP4 及最多 120 字的确认稿。

API 与独立 Worker 使用相同的 `FISSION_AVATAR_SYNC_WORKER_TOKEN`。API 需要 `ffprobe` 检查返回文件，工作机可指定 `FISSION_AVATAR_FFPROBE_PATH`。Worker 单独配置语音和 MediaKit 供应商凭据。启用步骤见[本地开发指南](../../../../../../docs/development/local-development.md#数字人口播项目工作台)。

正式工作台通过项目和 Run 内的 `GET .../fission-avatar/sync` 恢复任务，`POST .../sync/tasks` 创建，任务操作支持 `cancel` 和 `retry`。成功后自动提交音轨、MP4 和字幕时标到 `avatar-sync`，媒体按 revision 和现行授权读取。

MediaKit 提交状态未知时，由运维结合保存的操作令牌和供应商受理记录核对任务。确认两者唯一对应后，由有目标数据库权限的运维人员登记。用户在工作台重试时从该任务继续查询。

```text
node scripts/reconcile-avatar-sync.mjs --project UUID --run UUID --task UUID --client-token UUID --provider-task ID --confirm-provider-match
```

## 背景、字幕与成片交付

`FISSION_AVATAR_RENDER_ENABLED` 控制合成方案编辑、新建渲染和重试，默认关闭。确认背景和字幕时提交 `avatar-composition`，引用当前 Run 的同步素材 revision。图片使用项目 `SCENE_BACKGROUND` 的可用 PNG 或 JPEG 版本。渲染以 1080×1920 MP4 及可选 SRT 为交付格式。

正式工作台通过项目及 Run 内的 `GET .../fission-avatar/render` 恢复进度，`PUT .../render/draft` 按编辑 revision 保存草稿，`POST .../render/confirm` 确认方案，`POST .../render/tasks` 创建渲染。`GET .../render/outputs/:revision/video?download=1` 下载 MP4，`GET .../render/outputs/:revision/subtitles` 下载 SRT，`POST .../render/outputs/:revision/archive` 明确将 MP4 归档为项目资产。同一成片 revision 返回同一资产版本。

渲染与同步共用 Worker 凭据，走独立队列 `fission.avatar.render.requested`。原生口播请求带用户已验收的 `nativeSourceAccepted` 版本引用。服务端核对当前授权和来源，冻结该版本。Worker 通过帧时间与原音频包校验后返回来源和成片摘要，服务端复核并提交 `avatar-output`。

配音后改口型和分段候选通过 FFmpeg 媒体检查后进入独立口型校验，评审通过后提交成片。历史成片访问、下载和归档持续复核当前项目来源授权。 [候选读取与报告提交](../../../../../../scripts/fission-avatar/README.md#g3-成片评审)

## G4 长片试点

`FISSION_AVATAR_LONG_ENABLED` 默认关闭。应用长片迁移并启用相应同步与渲染能力后，工作台可在 `/sync/tasks` 的创建请求中使用 `mode: 'SEGMENTED'`。长稿冻结后分 3–12 段，每段最多 60 字，完整同步结果为 61–90 秒。同步和渲染分别使用 `fission.avatar.long-sync.requested` 和 `fission.avatar.long-render.requested`。原任务重试和文件访问入口继续沿用。

遇到某段 MediaKit 受理状态不明时，运维从供应商记录确认项目、Run、任务、段序、客户端令牌和已受理任务唯一对应，再在上文对账命令中添加 `--ordinal <段序>`。工作台重试将沿用已受理的供应商任务。

评审可通过 `candidate/timeline` 获取绑定候选 SHA-256 的成片时长和接缝。长片报告须提交一致的 `evidence.durationMs`、`evidence.seamTimesMs` 和 `evidence.accuracyPermille`，准确率门槛为 950‰。沿用短片的覆盖、置信度与 100 毫秒偏差门槛。 [长片评审命令](../../../../../../scripts/fission-avatar/README.md#g4-工作台长片评审)

### 尾帧接续试点

应用 `20261124140000_fission_avatar_continuity` 后，可启用默认关闭的 `FISSION_AVATAR_CONTINUITY_ENABLED`。启用后，同一长片入口的新任务要求已确认形象的确切授权版本登记原始 Seedance 任务 ID。登记前核对同一方舟账号可读取该任务的原始尾帧，并在授权记录中确认对应此项目的形象版本。

对于已授权的形象，使用同一授权记录号绑定或更新来源。更新保留授权 ID、已确认形象和已交付文件的访问。该授权有排队、运行或待对账的尾帧任务时，需要先处理任务才能更新来源。新登记授权可直接在 `grant` 命令传入 `--seedance-source-task-id`。

```powershell
node scripts/manage-avatar-asset-grant.mjs bind-seedance-source --project <项目UUID> --asset <资产UUID> --version <版本号> --evidence <现有授权记录号> --seedance-source-task-id <已核验原始任务ID>
```

长片 Worker 通过 `POST .../continuity/checkpoint` 登记整稿配音、冻结切片计划和写入逐段画面回执，继续使用已有分段媒体、成片和评审入口。原始尾帧地址随运行时查询使用。受理不明时，在方舟供应商记录确认同一项目、Run、任务和段序的唯一受理 ID 后，以 `reconcile-avatar-sync.mjs` 的 `--picture --ordinal <段序>` 进行对账。`--client-token` 使用该段已冻结的客户端令牌。工作台重试沿用已核对的任务 ID。
