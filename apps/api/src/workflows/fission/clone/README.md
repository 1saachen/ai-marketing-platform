# apps/api/src/workflows/fission/clone

`POST /projects/:projectId/workflow-runs/:runId/fission-clone/generation/preflight` 读取当前确认映射，校验精确来源和目标图片版本，返回单条帧计划、每镜参考帧数、全批参考帧数与全批请求渲染秒数。请求包含 `sourceMapping`（artifactId/revision/contentHash）、`count`（1–20）、`audioMode: "SILENT"`、`transitionMode: "CUT"`。新任务用 `acceptedReferenceFrames` 和 `acceptedRenderSeconds` 确认两种用量。三条及以上要求 `FISSION_CLONE_PLANNING_MODEL` 与允许变化的场景映射，创建时在锁内重验。列表返回当前配置允许的 `maxCount`。

爆款复刻输入、拆解、元素映射和成片生成。复用同一项目 Run、节点草稿和 WorkingArtifact。拆解与生成使用独立 Worker Token 和 Outbox 路由。

公开接口前缀为 `/projects/:projectId/workflow-runs/:runId/fission-clone`（省略全局 `/api`）：

- `GET workspace` / `GET capabilities`：读取输入、报告、映射草稿与确认产物、任务、核对证据和当前能力。
- `POST uploads` / `DELETE uploads/:uploadId`：磁盘临时上传与未使用文件移除。
- `POST assets`：读取当前项目指定资产版本，复制到当前 Run 工作区。
- `POST input/confirm`：校验草稿与目标 revision，规范化内容后提交 `clone-input`。
- `POST analysis/tasks`：冻结当前输入与目标版本，创建 `ANALYZE` 任务及 Outbox。完整成功后自动提交 `clone-analysis`。旧任务按各自冻结版本恢复。
- `PUT analysis/draft` / `POST analysis/confirm`：与通用节点接口操作同一份人工编辑草稿；显式确认校验来源、媒体规格与当前能力后提交。
- `POST mapping/tasks`：`SMART_MATCH` 只更新草稿，CAS 冲突保留待采用建议；`VALIDATE_KEEP_TEXT` 只保存绑定来源和映射哈希的证据。
- `POST mapping/assets`：校验当前项目精确版本并准备当前 Run 文件引用；候选元数据查询不复制全部资产。
- `POST mapping/suggestions/:taskId/adopt`：显式采用建议，重验来源及草稿版本，不确认映射。
- `POST mapping/confirm`：校验全部产品替换、目标、结构锁和必要文本证据，提交 `clone-mapping`。
- `GET tasks/:taskId` / `POST tasks/:taskId/cancel` / `POST tasks/:taskId/retry`：权威任务状态、取消和有界原快照重试。
- `GET generation/tasks` 按批分页返回条目、批次、归档状态和已发布批次的下载链接。`POST generation/tasks` 创建单条任务、两条的批次或三至二十条的规划任务。
- `POST generation/tasks/:taskId/retry` 恢复指定失败条目或尚未派发条目的规划。`POST generation/tasks/:taskId/cancel` 取消任务或所属批次。`POST generation/tasks/:taskId/archive` 根据已发布的精确成片版本归档。
- `GET generation/batches/:batchId/export?revision=…&hash=…` 验证同项目、同 Run 下已发布的批次清单。按清单顺序流式下载 MP4 和含文件哈希、版本与新旧状态的 `manifest.json`。

初始化入口为 `POST /projects/:projectId/workflow-runs/fission-clone/draft`。草稿保存与普通节点导航复用平台节点接口及作用域门禁。暂停使用 `expectedCloneDraftRevisions` 覆盖所有已存在节点；仅有输入草稿时兼容旧单 revision 字段。后台任务允许在合法 `PAUSED` Run 完成，取消与过期 attempt 不得写回。

受保护内部前缀为 `/internal/workers/fission-clone-analysis/tasks/:taskId`，提供 claim、heartbeat、progress、checkpoints、complete、fail 和受控文件读取。校验独立 Worker Token、projectId 和 attempt token；Worker 不访问数据库或任意文件 URL。

生成使用 `/internal/workers/fission-clone-generation/tasks/:taskId`，提供领取、心跳、进度、供应商检查点、受控媒体输入和上传、审片、完成和失败。媒体经 API 校验，最终成片与批次在同一事务提交。G3 默认关闭，启用要求 `FISSION_CLONE_G3_ENABLED`、生成操作与批次迁移、独立的 `FISSION_CLONE_GENERATION_WORKER_TOKEN`、`FISSION_CLONE_GENERATION_MODEL`、`FISSION_CLONE_REVIEW_MODEL`。

新生成任务冻结原片文件身份和逐镜头参考计划，需要私有 TOS。Worker 提交 `POST media/reference-N`，API 验证锁定时长和媒体规格，登记并保活参考片。Worker 在持有有效租约且尚未登记该镜头的供应商创建时可调用 `GET shot-reference/N/url` 获取对应剪片的 30 分钟读取地址。旧原片编辑任务沿用 `GET source-video-url`。签发响应禁止缓存，地址不进入快照或检查点。

供应商明确拒绝创建时，对应镜头或原片编辑段保存拒绝检查点并结束任务，可修正输入后发起新任务。创建结果不明时仍需核查原任务，避免重复提交。

三至二十条先在生成队列领取父任务。Worker 依次写 `PUT planning/draft`、`PUT planning/review` 和 `POST planning/complete`。完成操作校验两个冻结检查点并原子派发子任务。父任务以自身 ID 响应幂等请求。取消与技术重试支持父任务 ID，已有子任务时取消整批。启用该容量需应用位置迁移 `20261117120000_fission_clone_generation_slots`。

新批次快照中的 `sampleFirst` 表示先验证首条。规划完成后父任务进入 `SAMPLE`，API 只创建首条子任务及 Outbox，并持续保活批次图片。首条审片完成接口通过校验后，在同一事务中派发余项并进入 `PLANNED`。列表返回原批次 `count`，首条验证期间附 `sample.totalCount`。首条失败时重试入口属于该子任务，取消可使用父任务 ID。旧快照未携带该字段时沿用原派发方式。

`FISSION_CLONE_ENABLED`、`FISSION_CLONE_G2_ENABLED` 默认均为 `false`。依次完成 `20261111120000_fission_clone_uploads`、`20261111130000_fission_clone_g2_tasks` 后才开启对应能力。G2 配置 `FISSION_CLONE_ANALYSIS_MODEL`、`FISSION_CLONE_ANALYSIS_WORKER_TOKEN`；媒体工具使用 `FISSION_CLONE_FFMPEG_PATH` / `FISSION_CLONE_FFPROBE_PATH`，留空时从 PATH 查找。缺配置不回退 Mock，构建也不自动重启服务。能力限制见[业务指南](../../../../../../docs/workflows/fission/clone/agent-guide.md)，实际检查和未验范围见[G1 证据](../../../../../../docs/workflows/fission/clone/evidence/2026-11-11-G1真实输入实现与验证.md)、[G2 证据](../../../../../../docs/workflows/fission/clone/evidence/2026-11-11-G2拆解与映射实现验证.md)。
