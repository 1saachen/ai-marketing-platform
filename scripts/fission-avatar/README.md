# 数字人口播 G0 单条供应商小样

该脚本用于验证豆包异步语音和火山 AI MediaKit 口型对齐。它写入本地小样文件和任务标识。是否达到 100 毫秒同步阈值仍需测量并复核。生产接入与验收范围见 [实施计划](../../docs/workflows/fission/avatar/plans/2026-11-24-数字人口播真实生产链路接入计划.md)。

## 准备

- 使用 Node.js 22.12 或更高版本，并确保 `ffprobe` 在 PATH 中，也可在本地环境配置 `FISSION_AVATAR_FFPROBE_PATH`。
- 准备一条已授权交给火山引擎处理的单人 SDR MP4。建议 15–30 秒、正面出镜、光线稳定、无面部遮挡。脚本接受不超过 30 秒、64 MiB 且仅含一路画面的文件。源文件带声音时，先在本地生成只含画面的副本。
- 准备 1–120 字的普通话 UTF-8 文案文件。源视频应长于合成语音，脚本在实际口型提交前检查两者时长。
- 将 `VOLC_TTS_API_KEY`、已授权的普通话预置 `VOLC_TTS_SPEAKER` 和 `VOLC_MEDIAKIT_API_KEY` 配置在被 Git 忽略的本地 `.env` 或进程环境中。`VOLC_TTS_RESOURCE_ID` 默认为 `seed-tts-2.0`。在控制台核实豆包异步语音与北京 MediaKit 服务权限。

MediaKit 本地上传媒体原件的生命周期是 30 天。TTS 音频以短期签名 HTTPS 链接提供给口型任务，MediaKit 为处理拉取的输入副本按其服务存储策略清理。两项服务的输出都会下载到指定的本地私有目录。 [豆包异步任务提交](https://docs.volcengine.com/docs/doubao-voice/task-sub-mission?lang=zh) · [MediaKit 多源输入与上传](https://docs.volcengine.com/docs/intelligent-processing/media-input-and-upload?lang=zh) · [输入与输出存储策略](https://docs.volcengine.com/docs/intelligent-processing/storage-policy-update?lang=zh)

## 运行

在仓库根目录执行。预检只检查本地输入。

```powershell
node --env-file=.env scripts/fission-avatar/probe.mjs --video 'D:/private/avatar/source.mp4' --text-file 'D:/private/avatar/script.txt'
```

获得样片素材与费用授权后，显式执行一次付费小样，并为该样片指定一个仓库外、仅操作者可访问的状态目录。

```powershell
node --env-file=.env scripts/fission-avatar/probe.mjs --execute --video 'D:/private/avatar/source.mp4' --text-file 'D:/private/avatar/script.txt' --state-dir 'D:/private/avatar/g0-sample'
```

脚本提交一次 TTS 和一次最多 30 秒的口型任务。以文档公示价估算，120 字加 30 秒视频约 ¥0.536，账号具体资费及存储、网络费用以控制台账单为准。 [豆包计费](https://docs.volcengine.com/docs/doubao-voice/billing-instructions?lang=zh) · [MediaKit 计费](https://docs.volcengine.com/docs/intelligent-processing/video-tool-billing?lang=zh)

目录包含 `speech.mp3`、`word-timings.json`、`lip-sync.mp4`、未完成口型测量的 `report.json` 和用于恢复的 `state.json`。状态文件包含操作标识及输入指纹。短期链接、凭据和原文仅随当前网络请求使用。

## 中断恢复

- 在同一状态目录用相同输入和相同供应商账号再次执行。TTS 按提交前记录的操作标识查询，已知的口型任务按服务商任务标识查询。两个付费请求都不会被再次提交。 [豆包查询](https://docs.volcengine.com/docs/doubao-voice/result-query?lang=zh) · [MediaKit 查询](https://docs.volcengine.com/docs/intelligent-processing/query-task?lang=zh)
- 如果口型提交响应丢失并且任务 ID 未落盘，先在供应商侧以 `state.json` 中的 `mediaKitClientToken` 核对原任务。确认唯一对应关系后，在相同命令加上 `--recover-mediakit-task-id <已核对的任务ID>` 继续查询。找不到唯一任务时保留原记录。 [MediaKit 口型任务](https://docs.volcengine.com/docs/intelligent-processing/lip-sync?lang=zh)
- 强制终止进程可能留下 `probe.lock`。确认相关进程已退出后仅清理这个锁文件，保留已有状态及样片。MediaKit 默认输出链接只能在生成后 24 小时内使用，请及时下载。 [MediaKit 任务时效](https://docs.volcengine.com/docs/intelligent-processing/query-task?lang=zh)

离线回归使用固定响应和临时状态目录。

```powershell
node --test scripts/fission-avatar/probe.test.mjs
```

## 人工口型校准

从已解码的样片逐帧和波形中标出同一发音的声音与口型时刻。以同一个成片起点为零点，填写毫秒整数和包含帧间隔在内的测量不确定度。标注覆盖首段、中段、末段和每个拼接接缝前后 1 秒。用人工记录中的配对时标运行以下命令。

```powershell
node scripts/fission-avatar/check-sync.mjs 'D:/private/avatar/g0-sample/annotations.json'
node --test scripts/fission-avatar/check-sync.test.mjs
```

最小标注示例适用于一条无拼接的 15 秒短片。

```json
{
  "durationMs": 15000,
  "seamTimesMs": [],
  "samples": [
    { "audioMs": 2000, "mouthMs": 2033, "uncertaintyMs": 17 },
    { "audioMs": 7100, "mouthMs": 7117, "uncertaintyMs": 17 },
    { "audioMs": 13100, "mouthMs": 13066, "uncertaintyMs": 17 }
  ]
}
```

输出测量方法、每窗覆盖、最大绝对偏差和逐事件结果。可信区间完全落在 ±100 毫秒内且覆盖完整时返回 0。超标或缺测时返回 1，无效输入返回 2。这个命令只评估人工时标，实际口型检测和生产交付门禁将在后续阶段验收。

## G3 成片评审

从仓库根目录构建契约 `pnpm --filter @ai-marketing/contracts build`。授权评审人员在本地环境设置 `FISSION_AVATAR_RENDER_REVIEW_TOKEN` 和 `INTERNAL_API_BASE_URL`，地址含 `/api`，使用 HTTPS 或本机 HTTP。候选存入仓库外的私有目录，命令校验 SHA-256 并拒绝覆盖已有文件。

```powershell
node scripts/fission-avatar/review-render.mjs candidate --project <项目UUID> --run <RunUUID> --task <任务UUID> --file 'D:/private/avatar/g3-candidate.mp4'
```

以最终候选解码文件作为测量输入。按已校准方法测量实际有声区间，覆盖片头、中段、片尾和接缝。内部报告 JSON 包含 `sha256`、`method`、`coveragePermille`、`confidencePermille`、`maxAbsOffsetMs`。覆盖率与置信度以千分比记录，偏差为同一发音和唇形事件的最大绝对时间差，单位毫秒。服务端要求方法与配置一致，覆盖率至少 950‰、置信度至少 800‰、最大绝对偏差至多 100 毫秒。缺测时保留待校验状态。建议将逐事件与区间报告保存在原评审记录中。

```powershell
node scripts/fission-avatar/review-render.mjs submit --project <项目UUID> --run <RunUUID> --task <任务UUID> --report 'D:/private/avatar/g3-review.json'
```

通过后 API 发布成片工作副本，工作台可下载与归档。实际口型测量方法和样本须独立完成校准。上节基于少量人工时标的 G0 检查适用于准备标定样本。

## G4 离线长片预检

在仓库根目录先运行 `pnpm --filter @ai-marketing/contracts build`，然后用 UTF-8 口播稿生成分段计划。离线命令默认每段最多 120 个字符，可为较短的输入画面指定更低上限。计划沿句尾、停顿标点和换行切分，记录规范化文案摘要及字符区间，含原文的 JSON 保存到私有目录。工作台长片试点使用同一分段逻辑和每段 60 字上限。

```powershell
node scripts/fission-avatar/plan-segments.mjs 'D:/private/avatar/script.txt' --output 'D:/private/avatar/segment-plan.json' --max-characters 120
```

准备 3–12 段已驱动的短片与对应语音。合成清单包含 `schemaVersion: 1` 和有序 `segments`，每项包括 `video`、`audio` 路径、`videoSha256`、`audioSha256` 和 `wordTimings`。每个时标需包含 `text`、`startMs`、`endMs`、`confidencePermille`，以本段音频起点计时。媒体路径可相对清单。命令在 `workers/fission-avatar` 目录执行。

```powershell
uv run --frozen python -m fission_avatar.long_form --manifest 'D:/private/avatar/media-manifest.json' --state-dir 'D:/private/avatar/g4-state'
```

预检支持 61–90 秒。候选及报告保存为 `candidate.mp4` 和 `report.json`。中断后用同一份清单和状态目录执行原命令，重用摘要校验通过的已完成分段。报告记录帧位置、接缝、全片字级时间与音轨检查。

评估口型时，从候选成片独立清点全部可听发音单元。标注 JSON 包含 `schemaVersion: 1`、`sha256`、已校准的 `method`、`durationMs`、`seamTimesMs` 和 `units`。发音单元按 `audioMs` 升序记录 `id` 和 `measurement`，未测得口型时填 `null`。测得时填 `mouthMs`、`uncertaintyMs`、`confidencePermille` 和口型判定 `match`，取值 `MATCHED` 或 `MISMATCHED`。

```powershell
node scripts/fission-avatar/score-lip-review.mjs 'D:/private/avatar/g4-state/candidate.mp4' 'D:/private/avatar/annotations.json' --timeline 'D:/private/avatar/g4-state/report.json'
```

运行评分前执行 `pnpm --filter @ai-marketing/contracts build`，并在 PATH 中提供 FFprobe 或设置 `FISSION_AVATAR_FFPROBE_PATH`。命令核对实际片长、SHA-256 和接缝时标。缺测、低置信或阈值不明时输出诊断，保留待校验状态。证据达标时加 `--review` 可输出评审摘要。评分器基于人工标注计算。长片预检支持校准和试点验收。

## G4 工作台长片评审

以相同项目、Run 和渲染任务读取候选 MP4 及时间线，两者的摘要应一致。使用上文的独立评审凭据和内部 API 地址。

```powershell
node scripts/fission-avatar/review-render.mjs candidate --project <项目UUID> --run <RunUUID> --task <任务UUID> --file 'D:/private/avatar/g4-candidate.mp4'
node scripts/fission-avatar/review-render.mjs timeline --project <项目UUID> --run <RunUUID> --task <任务UUID> --file 'D:/private/avatar/g4-timeline.json'
```

独立标注以最终成片的时间线为准。运行 `score-lip-review.mjs` 时传入候选 MP4、标注 JSON 和 `--timeline` 下载的文件。覆盖、置信度、时间偏差和匹配准确率都达标时，`--review` 输出的摘要包含 `evidence`，记录实际片长、接缝与准确率。授权评审人员可将该摘要保存后通过 `review-render.mjs submit` 提交。测试方法和合成标注用于联调校验门槛。

## Seedance 尾帧接续对照

`continuity_probe.py` 用固定三段、每段 4 秒的独立样片测试画面接续。用 Avatar Worker 的 Python 环境运行，默认只输出规格。媒体工具 `continuity_media.py --help` 可独立执行切片、合成和接缝对照。 [本地预检结果](../../docs/workflows/fission/avatar/evidence/2026-11-24-Seedance尾帧接续对照预检.md)

```powershell
workers/fission-avatar/.venv/Scripts/python.exe scripts/fission-avatar/continuity_probe.py
workers/fission-avatar/.venv/Scripts/python.exe scripts/fission-avatar/test_continuity_probe.py
```

取得本次真实费用授权以后，使用同一账号和同一私有状态目录运行。进程读取本地 `ARK_API_KEY`、`VOLC_TTS_API_KEY`、`VOLC_TTS_SPEAKER` 和 `VOLC_MEDIAKIT_API_KEY`。FFmpeg 与 FFprobe 可在 PATH 中提供，也可通过原有 `FISSION_AVATAR_*` 二进制路径配置。真实试验使用 `--execute --state-dir <私有目录> --budget-yuan <批准上限>`；恢复时保留该目录和预算。脚本持久化提交意图和已受理 ID，受理不明时需核对状态。方舟原始尾帧地址仅用于下一段请求，不写入状态文件。
