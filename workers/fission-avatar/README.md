# 数字人口播 Worker

## 原生有声视频模式

`native-sync` 消费 `fission.avatar.native-sync.requested`。任务输入是已授权的形象图、提示词和 4–30 秒的目标时长。Seedance 2.5 Flash 生成 480p 竖屏有声视频。Worker 在发起前记录提交意图，取得受理编号后保存。可重试任务沿用已受理的编号查询，受理不明时进入对账。

Worker 检查 H.264 视频、AAC 音轨、解码和实际时长，从同一视频提取 MP3 供预览。原生成果提供有声 MP4，字级时标为空。用户验收原片后可合成背景和手工字幕。原生模式使用 `ARK_API_KEY`、可选 `ARK_BASE_URL` 和默认 900 秒的 `FISSION_AVATAR_NATIVE_TIMEOUT_SECONDS`。

如选用了项目参考音色，Worker 在登记供应商提交前经内部授权接口读取冻结的 MP3 或 WAV，核对实际格式与 2–30 秒时长。合格文件以 `reference_audio` 与形象及当前提示词一起提交。

## 唇形驱动模式

此 Worker 处理数字人口播的唇形驱动节点。它消费 `fission.avatar.sync.requested`，向 API 领取限定在项目与 Run 的任务，用豆包合成普通话语音及字级时间标记，再用 MediaKit 生成口型素材。两个外部请求在发送前分别申请提交权限。TTS 使用冻结的操作编号查询已有结果，MediaKit 使用已保存的任务编号轮询。MediaKit 受理状态不明确且缺少任务编号时，停止本次执行。

形象使用 1–30 秒、至多 64 MiB 的 SDR MP4。运行时去掉原音轨，保留画面。最长口播 120 字，合成语音须落在原片时长内。输出校验覆盖 H.264 和 AAC 的轨道结构、时长和实际解码，并抽查首、中、尾三段波形与原 TTS 音轨一致。该检查用于确认产物实际使用驱动语音。对唇部事件的 100 毫秒验收属于生产成片导出。

Worker 通过 API 在一次有租约保护的回写中提交 MP4、MP3 和时间标记。Worker 的文件位于临时目录。下载凭据、API Key、文稿正文和外部响应不会进入日志。

## 成片渲染模式

设置 `FISSION_AVATAR_WORKER_MODE=render` 后消费 `fission.avatar.render.requested`。渲染从 API 获取冻结的 G2 音轨、视频及可选的 JPEG/PNG 背景。Worker 保留原视频的画面，居中放入 1080×1920 竖屏画布。画布支持纯色和居中裁切的图片，图片宽高各为 2–4096 像素。字幕支持硬嵌、独立 SRT、同时输出或关闭。渲染使用原口播音轨，保留口播时序。

原生 v3 渲染直接复制原片 AAC 音轨，保留视频帧的显示时点。Worker 校验每帧的时间、原音频包内容及时间线，验证通过后提交双文件摘要及时间线证据。该证据描述合成前后的媒体关系。

Worker 校验源素材和编码结果的媒体结构、实际解码和音轨一致性，随后提交待校验的成片及选定的字幕文件。实际唇形事件校验由 API 交付流程处理。

## G4 后台消费模式

`long-sync` 消费 `fission.avatar.long-sync.requested`。每段使用同一条已授权的短形象视频和冻结的普通话文案。单段通过媒体校验后立即上传音轨和视频。重试时按 SHA-256 核对已完成的片段，查询相同的供应商任务标识。全部片段可用后才提交 61–90 秒的口播合成结果，包含完整 MP4、驱动 MP3、字级时标和接缝时间。

尾帧接续任务由同一消费者处理。Worker 从已授权的方舟原始任务取得首段输入，整稿配音完成后冻结源音频摘要和切片计划。逐段取上一段方舟返回的原始尾帧，向 Seedance 提交画面，再用本段驱动 WAV 对齐口型。两次提交均有租约和回执保护，已确认的片段沿用已存媒体，未知受理按 API 对账方式处理。每次领取中的签名帧地址只保存在内存。变更摄制条件或受理失败时以实际末帧和成片评审为准。

`long-render` 消费 `fission.avatar.long-render.requested`，读取上述已确认合成素材。背景与字幕的渲染保留原有接缝帧和音轨时间线。FFmpeg 解码并检查每个接缝两侧的音轨。输出仍需通过 API 的口型事件校验才可交付。短形象在不同段落间可能出现可见剪接，评审需覆盖每处接缝。

## G4 长片离线验证

本目录的长片命令接受 3–12 条已有短片。每条提供现有的口型 MP4、对应的独立驱动 MP3 和片内字级时标。短片适用现有 30 秒、视频 64 MiB、音频 8 MiB 限制。该命令使用本机 FFmpeg 和 FFprobe，可验证实测 61–90 秒的分段拼接。

建立 UTF-8 清单，设置 `schemaVersion` 为 `1`，`segments` 按成片顺序列出每段。`video` 和 `audio` 是文件路径，相对路径基于清单目录。`videoSha256` 和 `audioSha256` 分别是原始文件的 64 位小写十六进制摘要。`wordTimings` 的每一项包含 `text`、`startMs`、`endMs`、`confidencePermille` 四个字段。未知置信度使用 `null`。同一清单内各片段画面尺寸和像素比例必须一致。

```powershell
uv run --frozen python -m fission_avatar.long_form --manifest D:/private/avatar/long-input.json --state-dir D:/private/avatar/long-state
```

首次使用单独的空本地目录。用同一份清单和目录重跑时，工具会核对清单、输入、已通过的分段文件及最终候选的摘要。已验证的分段直接复用。首次运行每段分别校验媒体，将视频对齐到 30 fps 帧网格。每段解码后的语音只补足到下一帧边界，补静音不足 34 毫秒。最终将各段 PCM 拼接后统一编码 AAC。

成功后在状态目录生成 `candidate.mp4` 和 `report.json`。报告保存与候选绑定的 SHA-256、实际帧边界、接缝两侧音轨抽查、分段指标和全片字级时标。所有媒体、中间文件和报告均留在本地私有目录。此处的校验覆盖媒体可解码性、轨道与接缝时间线，以及驱动音轨一致性。真实唇形事件偏差及生产发布另行验收。

## 配置

- `INTERNAL_API_BASE_URL` 包含 `/api`。Worker 和 API 使用相同的 `FISSION_AVATAR_SYNC_WORKER_TOKEN`。
- `RABBITMQ_URL` 指向平台 RabbitMQ。
- `FISSION_AVATAR_WORKER_MODE` 默认 `sync`。`VOLC_TTS_API_KEY` 与 `VOLC_MEDIAKIT_API_KEY` 分别用于豆包语音和 MediaKit，只在 `sync` 和 `long-sync` 模式读取。音色来自任务的已授权版本。
- `FISSION_AVATAR_SYNC_TIMEOUT_SECONDS` 默认 900 秒，限制一次领取的执行时间。
- `FISSION_AVATAR_TTS_TIMEOUT_SECONDS` 和 `FISSION_AVATAR_LIP_SYNC_TIMEOUT_SECONDS` 分别默认为 120 和 600 秒。
- `FISSION_AVATAR_RENDER_TIMEOUT_SECONDS` 默认 180 秒，限制一次渲染领取的执行时间。
- `FISSION_AVATAR_LONG_SYNC_TIMEOUT_SECONDS` 和 `FISSION_AVATAR_LONG_RENDER_TIMEOUT_SECONDS` 分别默认为 2400 和 480 秒，限制长片任务单次领取的执行时间。
- 尾帧接续使用 `ARK_API_KEY` 及 `ARK_BASE_URL`。单段画面生成时限可由 `FISSION_AVATAR_TAIL_PICTURE_TIMEOUT_SECONDS` 调整，默认为 600 秒。
- `FISSION_AVATAR_FFMPEG_PATH` 和 `FISSION_AVATAR_FFPROBE_PATH` 可指定本机媒体工具路径。硬嵌字幕需要 FFmpeg 支持 `drawtext`。`FISSION_AVATAR_RENDER_FONT_PATH` 可指定中文字体文件。镜像内已安装 FFmpeg 和 Noto CJK 字体。
- `FISSION_AVATAR_CONTRACTS_DIR` 可指定生成的 JSON Schema 目录的上一级路径。镜像默认为 `/app/contracts`。

镜像使用仓库根目录为构建上下文。唇形驱动模式会调用付费服务，启用应配合对应环境的任务开关与授权。渲染模式在 Worker 本机执行 FFmpeg。

## 离线验证

在本目录使用 Python 3.12 和 uv 执行：

```powershell
uv sync --frozen
uv run --frozen pytest
uv run --frozen mypy src
```

媒体集成测试需要执行 FFmpeg 和 FFprobe。可以使用上述环境变量指定本地工具路径。Provider 测试使用内存 HTTP 响应。
