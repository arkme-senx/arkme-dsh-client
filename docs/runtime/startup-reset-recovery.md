# 启动失败后的运行环境重置

## 来源与根因

当前提交基线为 2026-10-29 的 `origin/master`（`54536b8`，PR #53）；初次恢复基于 `c6605f2`，签名包验收基于 `8002bb0`（PR #52），提交前再次合并最新 master。从 Windows 测试机保留的 `arkme-runtime-reset-20261017` 源码找回 10 月 17–18 日的最终重置实现；其 `source-manifest.json` 记录原分支为 `zp-codex/reset-runtime-on-startup-failure`、基线为 `71541e8`。保留当前主干的设备认证、启动诊断、会话窗口和核心依赖隔离逻辑。

原故障是核心插件导入 `ali-oss` 时无法解析包入口，继而使插件树加载失败。截图本身无法确定包损坏发生于发布、解压还是后续本地操作。恢复机制不依赖猜测损坏来源，而是重新获取兼容的完整运行组件。

排查流程：其他分支及 reflog → 10 月 17–18 日会话记录 → SSH 找回最终源码和验收脚本 → 相对原基线生成差异 → 三方合并到当前 master → 本地回归 → Windows 普通权限复现及包验收。

## 行为和数据边界

用户已确认恢复失败页上的“重置环境”按钮及提示：“重置环境将重新下载运行组件，保留会话、附件、设置和工作区。”MAS 内置运行时不提供此入口。

重置顺序：

1. 预占一次重置操作，合并重复点击，暂停新的后台运行时更新检查。
2. 等待初始启动及失败回滚的操作队列结束。
3. 停止 Harness 并确认旧进程已经退出，等待在途安装，完成数据事务及 Profile 恢复。
4. 获取与当前客户端兼容的 release set，检查组件 Code 不回退，持久化下载目标。
5. 只清理当前环境、当前 cache epoch 的 `releases`、`downloads`、`staging` 和 release-set 状态，重新下载完整 Harness 与必需插件。
6. 沿用现有候选启动、健康检查、数据事务和提交流程启用运行时。

不会删除 `dsh-containers`、会话、附件、工作区、设置、账号范围注册表、市集插件、日志、数据事务记录、旧 epoch 或另一环境。停止进程、数据恢复、manifest 获取或防回退校验失败时中止，不进入缓存清理。缓存根为链接时拒绝重置；缓存中的链接只解除链接自身。

初始 bootstrap 也进入操作队列，防止失败页刚出现就点击重置与尚未完成的数据回滚并发操作 `restore-staging-dsh`。

## junction 补充边界

保留 master 的 `copySnapshot` 实现。在 Windows 普通权限、关闭开发者模式下，新增历史悬空 junction 回归仍复现 `EPERM`：原逻辑依赖 `stat` 判断目录类型，目标已删除时退回 `fs.cp`，后者尝试创建需要权限的普通符号链接。

仅在 `stat` 返回 `ENOENT` 的分支补充读取链接自身的 Win32 属性，确认目录后沿用现有 junction 重建逻辑；不遍历链接目标，不放宽文件链接权限。Unix 权限断言和普通符号链接测试保留在适用平台；Windows 使用真实 junction 验证相同数据保护和路径逃逸边界。

## 验证

合并后本地全量 Vitest：136 文件通过，3 文件跳过；1179 项通过，18 项跳过。TypeScript 检查及 smoke 脚本语法检查通过。Windows 普通权限、开发者模式关闭的 8 组专项回归：159 项通过，2 项 Unix 专项跳过。打包预检通过，包括 updater、preload、runtime-free 布局和新核心解析策略的 unpacked 模块。

重置候选通过新 master 的 `markProfileCandidateAttempted` 记录当前 Profile recovery key，新增专项回归，避免重置绕过新的重试记录。覆盖 prod/test 隔离、会话与附件内容、修改时间、旧缓存、另一环境、停止和恢复失败中止、manifest 失败保留旧状态、版本防回退、根链接拒绝、缓存链接目标保留、重复请求及后台安装互斥。

### 合并前完整 Windows 恢复验收

`c6605f2` 基线最终签名包已在 192.168.3.231 的普通权限、开发者模式关闭场景完整通过。使用带所有权标记的隔离目录 `C:\arkme-reset-TUXpCq`，只移除其中的 `ali-oss/package.json`，精确复现 `ali-oss/index.js` 解析失败。真实失败页双击重置只执行一次，完整 Harness 重新下载，依赖恢复，历史悬空 junction 保留，恢复与再次启动均通过；9 个受保护文件三阶段 SHA-256 一致。

范围覆盖会话、附件、设置、工作区、市集插件样本、账号 registry、外部项目、另一环境和旧 epoch。首轮探针在恢复末尾采集截图时 CDP 超时，未记为完整通过；改为等待实际页面稳定并刷新 CDP 目标后重新完成验收，保留首轮失败证据。报告位于忽略目录 `release/runtime-reset-20261027/evidence-final/`。

### 合并后 Code 300 的在线验收

最新 master 的版本为 3.0.22 / Code 300，保留该版本配置。此前生产兼容接口返回 HTTP 503 / `client_compatibility_missing`，按用户要求先交付签名包；用户上传并配置后，于 2026-10-27 17:31–17:44 完成在线验收。本任务未修改生产配置。

使用原交付安装器对应的 `release-master-8002bb0-installer/win-unpacked`，未重新构建或更改签名包。兼容接口返回 `electron-runtime-v1-e48b8d5a2d02fb7bfafe27f8cf935b93`，Harness `0.2.1-rc.2`、插件 `3.0.34`。在全新隔离目录 `C:\arkme-reset-hInJcO`、普通权限、开发者模式关闭的条件下：

- 首次完整下载、插件健康检查及页面就绪通过。
- 仅删除隔离运行组件的 `ali-oss/package.json`，复现底层 `ali-oss/index.js` 缺失；真实失败页按钮及数据保留提示通过。
- 连续点击两次只执行一次重置，重新下载完整 Harness，依赖哈希恢复，损坏标记消失。
- 两份实际事务快照保留历史悬空 junction；外部项目、另一环境和旧 epoch 保留。
- 9 个受保护文件在故障前、重置后、再次启动后三阶段 SHA-256 一致，样本修改时间在文件系统复制精度内保留。
- 恢复及退出后再次启动均通过，稳定页面到达登录界面；不代表已进行用户账号登录及会话交互验收。

报告和四阶段截图位于 `release/runtime-reset-master-8002bb0-vc300/evidence-vc300-r2/`。首轮 Code 300 探针只检查桌面日志，因新版 Harness 将导入错误写入底层 `harness.log`、桌面仅显示健康检查失败而提前停止；保留 `evidence-vc300/reset-acceptance.json` 失败记录。仅调整探针同时核对本次底层日志后，用原包和全新隔离目录重新完成验收，未弱化依赖错误断言。

已交付 Windows x64 签名 EXE、`latest.yml` 和 blockmap，位于忽略目录 `release/runtime-reset-master-8002bb0-vc300/`。安装器、主程序、设备认证辅助程序和 elevate 辅助程序四项签名有效；包内 11 个关键编译模块、unpacked 核心策略模块、53 个迁移清单文件、更新文件大小及 SHA-512 均核对通过。回传 EXE 的 SHA-256 为 `b80916ff11f70a5e449356dbf9ab74903c2d0c96274820474fbe29eb6d2dbf1d`，与测试机一致。开发者模式恢复原值 1，测试应用进程为 0。

验收只使用带所有权标记的隔离 appData，禁止对客户真实数据注入故障。安装器覆盖升级和客户全量数据迁移不属于该 smoke 的结论。

### 提交前同步 master 的回归

2026-10-29 合并 master `54536b8`，保留 MAS Universal 商店包启动与资源校验改动；与本次重置修改无文本冲突。全量 Vitest：138 文件通过、3 文件跳过，1186 项通过、18 项跳过；`pnpm run typecheck`、`tsc -p tsconfig.build.json --noEmit`、两份 smoke 脚本语法检查和 `git diff --check` 通过。

原依赖目录指向已失效的 worktree 链接，改为当前 worktree 独立按锁文件安装。首次跳过依赖构建导致一项开发插件入口测试失败；完整安装构建依赖后全量复验通过，未改测试断言或依赖版本。此次同步未重新构建原交付签名包，Windows 包级证据对应前述 `8002bb0`，本次 `54536b8` 的新增验证范围为源码回归和类型检查。
