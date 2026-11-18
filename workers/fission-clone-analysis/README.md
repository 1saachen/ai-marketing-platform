# 爆款复刻拆解 Worker

此 Worker 处理 `FISSION / FISSION_CLONE` 的 `ANALYZE` 和 `MAP_SUGGEST`，不处理视频生成。队列固定为 `fission.clone.analysis.requested`，小消息 `runId` 是任务 ID；真实项目/Run、来源快照和租约从受保护 claim 响应取得。

## 当前能力

- `ANALYZE` 从任务冻结的 FileObject 身份下载参考片，核对大小和 SHA-256。FFprobe 读取时长、尺寸和音轨存在性。FFmpeg 按帧数上限采样，优先给明显画面变化候选补采前后帧，其余预算用于等距覆盖。候选探测超出资源限制或失败时继续等距采样。Ark Responses 基于带采样时点的原片图片生成六维报告。
- 候选表示画面变化，镜头边界仍由模型结合前后证据推断。原商品描述只读原片画面，目标商品事实在映射时使用。音频语义为 `UNASSESSED`，仅 `hasAudio` 来自媒体探测。未采样时刻不得用作证据帧。
- `SMART_MATCH` 基于确认报告、完整目标商品事实及当前项目候选精确版本的元数据提出映射。候选画面未进行视觉核对，结果明确提醒人工检查，不生成假匹配分数。产品逐项替换，冻结结构与来源不变。
- `VALIDATE_KEEP_TEXT` 仅返回逐项语义核对结果，不修改映射；通过文本核对不等于已支持保留原音色、音轨或烧录字幕。

结果直接消费 `packages/contracts/schemas` 的 JSON Schema，并以同目录 fixtures 做跨语言回归，不维护另一套 Python 业务 DTO。Docker 从仓库根构建，仅将必需的已发布 schema 复制到镜像；它们不是本目录维护的副本。

## 执行与恢复

claim 后根据剩余租约计算 heartbeat 间隔（剩余时间的三分之一，限制在 1–20 秒）；所有进度、文件访问、检查点和完成回调携带 attempt token。失去租约或收到取消对应的 404/409 时取消当前执行，不调用失败回调覆盖新状态。模型完整结果先保存 `RESULT_V1` 检查点，再完成任务；重试时匹配 API 的 `inputHash` 后恢复检查点，不重复调用已完成步骤。API 负责发布、确认、草稿 CAS、任务重领及来源互斥。

下载只访问同一受保护内部 API，不跟随重定向，不接受任意内容 URL。单文件最多 256 MiB，参考片最多 120 秒/4096×2160 像素，采样图每份最多 1 MiB、总计最多 12 MiB；子进程与模型调用有时间和尝试上限。临时目录在成功、失败、取消时均清理。进程崩溃且供应商已响应但检查点尚未持久化的窗口仍可能重复调用，不能承诺供应商严格一次计费。

## 配置与启动

必须配置 `FISSION_CLONE_ANALYSIS_WORKER_TOKEN`（与 API 一致）、`INTERNAL_API_BASE_URL`（含 `/api`）、`RABBITMQ_URL`、`ARK_API_KEY`。模型名由 API 冻结在任务快照中。缺失配置或 schema 时拒绝启动，无生产 Mock 回退。

| 配置                                                       | 默认值 / 范围                                       |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `ARK_BASE_URL`                                             | `https://ark.cn-beijing.volces.com/api/v3`          |
| `FISSION_CLONE_ANALYSIS_TIMEOUT_SECONDS`                   | 300 秒，30–600                                      |
| `FISSION_CLONE_ANALYSIS_MAX_ATTEMPTS`                      | 2，1–3                                              |
| `FISSION_CLONE_ANALYSIS_MAX_OUTPUT_TOKENS`                 | 16384，1024–32768                                   |
| `FISSION_CLONE_ANALYSIS_MAX_FRAMES`                        | 24，2–48                                            |
| `FISSION_CLONE_FFMPEG_PATH` / `FISSION_CLONE_FFPROBE_PATH` | PATH 中的媒体工具                                   |
| `FISSION_CLONE_CONTRACTS_DIR`                              | 本地自动定位共享 contracts；镜像为 `/app/contracts` |

消费者串行执行任务，RabbitMQ prefetch 为 1；模型单次请求重试与 API 的任务重领预算分别受控。Compose 使用独立可选 profile，默认不启动。

```powershell
docker compose --profile fission-clone-analysis build fission-clone-analysis-worker
# 仅在已确认付费范围、完成 API 配置/迁移后执行；启动会消费真实任务：
docker compose --profile fission-clone-analysis up -d fission-clone-analysis-worker
```

`uv sync --frozen`、`uv run --frozen pytest`、`uv run --frozen mypy src` 为本目录检查入口，不启动消费者或调用真实模型。媒体测试在发现本地 FFmpeg/FFprobe 时实际运行，未发现则明确跳过。Provider 测试使用 `httpx.MockTransport`；这不代表真实供应商理解质量或完整 G2 付费验收。
