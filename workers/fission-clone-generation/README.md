# 爆款复刻成片生成 Worker

常驻入口 `fission-clone-generation-worker` 消费 `fission.clone.generation.requested`。新任务按 `SEEDANCE_2_0_SHOT_REFERENCE` 逐镜头生成。Worker 校验冻结原片并归一化，按锁定帧区间剪出每镜参考，结合景别、运镜、动作和目标图分别请求，再按锁定时间线进行 FFmpeg 静音合成。

- `plan.validate_plan` 读取 `packages/contracts/schemas/fission-clone-generation-plan.schema.json`，复核帧区间、镜头顺序、素材引用和渲染时长。镜像外可通过 `FISSION_CLONE_CONTRACTS_DIR` 指定发布契约目录。
- `provider.render_shot` 每次消费当前镜头的计划、目标图和对应视频片段。不到 2 秒的参考片用末帧补齐。已有参考剪片检查点可重签。请求前保存创建意图，接收供应商任务 ID 后先保存 ID 再轮询。已有 ID 时只续查。两种历史模式按既有请求和检查点恢复。
- 创建请求收到 HTTP 400、401、403、404、422 或 429 且未取得任务 ID 时，记录 `CREATE_REJECTED` 并结束本次任务。网络中断、服务端故障或响应缺少任务 ID 时，保留 `CREATE_PENDING` 供核查。
- 原片编辑分支按文件哈希校验并下载原片，归一化到锁定帧率和输出规格。合成按原片的绝对帧区间从原片或编辑结果取材。只在有替换目标的镜头使用编辑素材。输出为 H.264 MP4，无音轨。候选必须经过实际帧数、时间基、规格和完整解码检查才能移动到输出路径。
- 逐镜头参考与历史原片编辑都用同时间点的原片与成片帧审片，核对景别、运镜、接触、遮挡和目标。历史纯描述计划使用冻结镜头描述、成片采样帧和目标图。所有镜头通过才请求 API 提交，API 再校验来源、租约、文件和证据范围。
- `planning.BatchPlanner` 处理三至二十条的父任务。分别保存精确数量的场景草案和独立审查，审查通过后请求 API 派发冻结的逐条计划。恢复时读取两个检查点。

启用前先阅读 [业务指南](../../docs/workflows/fission/clone/agent-guide.md)。Compose profile 为 `fission-clone-generation`，服务名为 `fission-clone-generation-worker`。Worker 需要 `RABBITMQ_URL`、含 `/api` 的 `INTERNAL_API_BASE_URL`、`ARK_API_KEY`、与 API 一致的独立 `FISSION_CLONE_GENERATION_WORKER_TOKEN`。可设置 `ARK_BASE_URL` 和 `FISSION_CLONE_GENERATION_TIMEOUT_SECONDS`。

在本目录执行以下命令。媒体测试需要本地可执行的 FFmpeg 和 FFprobe，使用 PATH 或 `FISSION_CLONE_FFMPEG_PATH`、`FISSION_CLONE_FFPROBE_PATH`。HTTP 测试使用 MockTransport。

```powershell
uv run --frozen pytest -q
uv run --frozen mypy src
```

受限路径和提交边界见 [G3 单条成片闭环](../../docs/workflows/fission/clone/plans/2026-11-16-G3单条成片闭环.md) 与 [G4 差异化规划](../../docs/workflows/fission/clone/plans/2026-11-17-G4差异化规划.md)。
