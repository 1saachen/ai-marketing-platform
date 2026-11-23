# 局部元素替换 Worker

消费 `fission.local_replace.requested` 队列，按项目、工作流 Run 和任务领用租约。输入的媒体字节数、选区和对象描述来自冻结的共享契约；文件仅从带租约的内部 API 获取，原片临时地址用于一次 Seedance 2.0 请求。

FFprobe 核对原片 4–15 秒、24–60 fps、9:16 或 16:9，以及 Seedance 2.0 的参考视频尺寸和编码要求。编辑使用完整原片和一张目标图。FFmpeg 在 24 fps 时间线上只从编辑结果取用起止区间内的帧，区间外取原片帧，生成 720p MP4。原片含音频时保留第一条音轨，转码为 AAC，并与视频时间线对齐。发布前复核画面、帧数、时长和音轨状态。 [火山方舟视频生成说明](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh)

Worker 在供应商 POST 前预约创建。收到任务 ID 后先通过 API 保存 ID，再查询结果。已知 ID 的恢复继续查询原任务；收件状态未知且缺少 ID 时停止自动创建，由 API 标记待核查。取消或租约失效结束当前 Worker 执行，已创建的供应商任务由原 ID 追踪。

## 运行配置

必填 `INTERNAL_API_BASE_URL`（含 `/api`）、`FISSION_LOCAL_REPLACE_WORKER_TOKEN`、`RABBITMQ_URL` 和 `ARK_API_KEY`。可配置 `ARK_BASE_URL`、`FISSION_LOCAL_REPLACE_FFMPEG_PATH`、`FISSION_LOCAL_REPLACE_FFPROBE_PATH`、`FISSION_LOCAL_REPLACE_TIMEOUT_SECONDS`（默认 900）。本地运行从仓库读取共享契约，在镜像中由 `FISSION_LOCAL_REPLACE_CONTRACTS_DIR` 指向 `/app/contracts`。

本目录运行 `uv sync --frozen`、`uv run --frozen pytest` 和 `uv run --frozen mypy src` 可验证媒体合成和模拟 Provider 行为。FFmpeg/FFprobe 未发现时媒体测试会显示跳过。测试不会创建真实供应商任务。
