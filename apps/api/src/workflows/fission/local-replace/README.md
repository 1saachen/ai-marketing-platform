# apps/api/src/workflows/fission/local-replace

局部元素替换使用独立的 `FISSION / FISSION_LOCAL_REPLACE` 工作流 Run。可选择同项目已有视频和目标图的精确版本，确认指定范围内的一个商品或道具，创建一次原片编辑任务。

可选当前项目的可用资产，也可使用从局部替换导入、处于待审核状态的素材。使用待审核素材时，资产的审核状态照原记录保留。

- `POST /projects/:projectId/fission-local-replace/workspace` 打开或恢复工作区。Run 级前缀为 `/projects/:projectId/workflow-runs/:runId/fission-local-replace`。
- `GET workspace` 读取草稿和任务。 `PUT draft` 按 `expectedRevision` 保存。 `POST tasks` 冻结方案并写入 Outbox。导航和草稿保存不创建任务。
- `POST tasks/:taskId/cancel` 停止本地任务并撤销写回租约。 `POST tasks/:taskId/retry` 使用当前确认方案和原任务快照恢复。 `GET tasks/:taskId/content` 支持范围播放与下载。

队列 `fission.local_replace.requested` 使用独立 Worker token。供应商创建前登记本次探测的原片时间线。相同任务号可幂等写回，创建请求结果不明时冻结当前 Run 的新任务，等待核查。已知供应商任务号随重试恢复。

完整成片通过媒体校验后提交 `local-replace-video:<taskId>`，绑定该任务消费的 `local-replace-plan` 精确版本。方案更新后既有成片仍可下载。

应用迁移 `20261120150000_fission_local_replace` 后再启用 `FISSION_LOCAL_REPLACE_ENABLED`，并配置 `FISSION_LOCAL_REPLACE_MODEL`、独立 `FISSION_LOCAL_REPLACE_WORKER_TOKEN`、私有 TOS 与 FFprobe。
