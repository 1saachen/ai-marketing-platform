# 爆款复刻成片生成 Worker

常驻入口 `fission-clone-generation-worker` 消费 `fission.clone.generation.requested`。API 冻结 `SEEDANCE_2_0_SILENT_CUT` 计划、模型名称和精确图片版本，Worker 执行逐镜头渲染、FFmpeg 静音合成和抽帧审片。

- `plan.validate_plan` 读取 `packages/contracts/schemas/fission-clone-generation-plan.schema.json`，复核帧区间、镜头顺序、素材引用和渲染时长。镜像外可通过 `FISSION_CLONE_CONTRACTS_DIR` 指定发布契约目录。
- `provider.render_shot` 接收已授权任务的模型部署名、已校验的商品图和持久化检查点。代码向已有 `SeedanceTransport` 传入限定请求。调用方必须把检查点写入绑定任务、镜头、计划哈希和 attempt token 的事务。准备创建状态先于 HTTP POST，成功获取 ID 后先存 ID 再轮询。创建结果未知须核查；已有 ID 的网络或下载重试继续使用该 ID。
- `media.compose` 按锁定边界截取每个镜头的头部，逐镜头用同一有理输出帧率归一化，然后硬切合成。输出为 H.264 MP4，无音轨。候选必须经过实际帧数、时间基、规格和完整解码检查才能移动到输出路径。
- `review.Reviewer` 检查各镜头的采样帧和冻结商品图片。所有镜头通过才请求 API 提交，API 再校验来源、租约、文件和证据范围。
- `planning.BatchPlanner` 处理三至二十条的父任务。分别保存精确数量的场景草案和独立审查，审查通过后请求 API 派发冻结的逐条计划。恢复时读取两个检查点。

启用前先阅读 [业务指南](../../docs/workflows/fission/clone/agent-guide.md)。Compose profile 为 `fission-clone-generation`，服务名为 `fission-clone-generation-worker`。Worker 需要 `RABBITMQ_URL`、含 `/api` 的 `INTERNAL_API_BASE_URL`、`ARK_API_KEY`、与 API 一致的独立 `FISSION_CLONE_GENERATION_WORKER_TOKEN`。可设置 `ARK_BASE_URL` 和 `FISSION_CLONE_GENERATION_TIMEOUT_SECONDS`。

在本目录执行以下命令。媒体测试需要本地可执行的 FFmpeg 和 FFprobe，使用 PATH 或 `FISSION_CLONE_FFMPEG_PATH`、`FISSION_CLONE_FFPROBE_PATH`。HTTP 测试使用 MockTransport。

```powershell
uv run --frozen pytest -q
uv run --frozen mypy src
```

受限路径和提交边界见 [G3 单条成片闭环](../../docs/workflows/fission/clone/plans/2026-11-16-G3单条成片闭环.md) 与 [G4 差异化规划](../../docs/workflows/fission/clone/plans/2026-11-17-G4差异化规划.md)。
