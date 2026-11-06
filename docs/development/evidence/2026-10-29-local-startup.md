# 本地环境启动记录

日期：2026-10-29。工作区：`D:\1Code\cyl\ai-marketing-platform`。本记录为本机实际启动结果，不代表供应商生成质量验收。

后续状态：2026-11-06 已导入用户选定的咖啡杯定制项目，并切换为本地文件存储；当前运行与验证结果见[项目本地副本记录](2026-11-06-local-project-copy.md)。下文保留首次启动时的观察范围。

## 已运行服务

- Web：`http://localhost:5173/`，正式 Vue 页面，Vite 仅监听本机地址。
- API：`http://localhost:3100/api/health`，运行本轮已构建的 `apps/api/dist/main.js`。前端 `/api` 代理指向该端口。
- PostgreSQL、Redis、RabbitMQ：沿用项目既有容器和数据卷，三个健康检查通过。
- 定制类提炼、脚本、资产、视频制作四个 Worker：分别在线且各有一个对应队列消费者。效果类消费者保持停止，本次未启动。

沿用本机被忽略的 `.env`，保留登录账号、密码哈希、TOS 配置和模型配置，没有覆盖凭据或把凭据写入记录。当前本地项目库为空，没有导入服务器业务数据。

## 实际处理

1. 启动 Docker Desktop。引擎自动恢复的旧消费者在消息队列启动前停止；确认数据库任务、Outbox 和队列均为空后，才接入本轮消费者。
2. `migrate status` 确认 51 个迁移均已应用，没有执行迁移或重建数据库。
3. Worker 并行构建中 Docker 引擎意外中断，三个新镜像出现不完整文件。后续逐个无缓存重建资产、脚本和制作镜像，并检查非 root 用户、入口文件、模块导入及 ffmpeg/ffprobe 后启动。
4. 提炼 Worker 复用原依赖镜像。镜像内 `uv.lock`、共享提炼依赖清单的 SHA-256 与仓库一致；通过只读挂载使用当前 `customized-extraction/src`、`shared/extraction-runtime` 和 `shared/ai-runtime`。128 个本地模型文件可见，Docling 及当前源码导入成功。
5. 宿主机视频工具安装在 `.tmp/local-tools/ffmpeg/bin`，仅追加到 API 启动进程 PATH，不改系统 PATH。来源为 [Gyan Windows 构建](https://www.gyan.dev/ffmpeg/builds/)，下载后与发布方 SHA-256 校验一致，保留 LICENSE 和 README；版本为 9.0.2。
6. 机器内存紧张，API 最终使用最新构建产物运行，停止本次创建的常驻 TypeScript 编译进程。Web/API 以隐藏后台进程运行，日志与 PID 位于 `.tmp/local-run`。

本机启动辅助文件位于被忽略的 `.tmp/local-run`，不进入版本库：

- `compose.override.yaml`：提炼 Worker 当前源码挂载。
- `start-web-api.ps1`：前端/API 启动与端口复用；API 使用现有构建产物，修改源码后应先构建。
- `start-local.ps1`：Docker 已启动时，启动基础设施、四个定制 Worker 和 Web/API。启动消费者会继续既有队列任务，后续运行时须注意任务状态。
- `processes.json`、`api-runtime.log`、`api-runtime.err.log`、`web.log`、`web.err.log`：本机进程与日志。

## 验证结果

- Web 页面、API 健康接口及 Web 代理健康接口均返回 200。
- 登录接口返回 200，使用验证会话访问项目接口返回 200；验证后已退出该会话。保留原账号配置。未登录项目接口返回 401。
- 四个定制队列的 ready/unacknowledged 均为 0，消费者数各为 1；启动日志和 Worker 到 API 健康访问正常。
- 制作 Worker 的运行时探针确认 ffmpeg/ffprobe 可用。宿主机生成一段 4 秒黑色视频后，实际调用构建后的 API `inspectImportVideo`，返回 4 秒、160×90、25 fps、video/mp4。
- 新增 `local-update.database.spec.ts` 实际连接本地 PostgreSQL 通过，验证两轮来源更新、内容 revision 保持及兄弟路径隔离。首次运行发现测试夹具中暂停分支未清空默认 `activeKey`，修正夹具为 `activeKey: null` 后通过；没有更改运行时分支规则。测试随机项目已清理。
- 该测试文件 Prettier、ESLint 和 `git diff --check` 通过。环境运行期间补跑 API typecheck 两次因宿主内存分配失败退出，未宣称该补跑通过；前轮实现阶段成功的类型/构建结果保留其原作用域。本次业务源码未再修改。

未创建真实模型、图像或视频生成任务，未验证供应商调用及真实画面质量。原轮次验证与其限制见[定制类验证记录](../../workflows/customized/evidence/2026-10-29-局部更新与资产替换验证.md)。本次只补跑上述一个数据库测试，没有将其余数据库场景一并计为通过。
