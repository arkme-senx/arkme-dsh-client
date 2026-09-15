# Harness rc.2 强制升级：缓存代际设计

本设计以用户最终批准的缓存代际方案为准，替代此前的双协议及 Harness 最低 SemVer 方案。

## 兼容性与缓存选择

客户端内置 `RUNTIME_CACHE_EPOCH = 1`，只在运行时必须重新初始化时递增。正常兼容发版保持不变。

当前根目录是 `userData/runtime-manager/electron-v1/cache-epoch-1/`，包含 state、releases、downloads、staging 和 acquisition。历史根目录为第 0 代，不复制其 active/candidate/previous，不删除旧缓存或用户数据。旧代已提交 manifest 只在首次联网选版时作为组件 Code 防降级基线；不存在、损坏或不兼容的旧元数据可忽略，磁盘访问错误必须报告。

同代缓存继续校验环境、ABI、身份和完整性；缓存复用不要求 shellVersionCode 与上次相同。网络响应仍校验本次 shellVersionCode 的服务端兼容性凭据。客户端不增加 desktopProtocol、不比较 Harness 最低版本、不维护 Harness 版本白名单。

## 安装与手动重试

选择当前代目录后沿用 prepareForLaunch。完整有效 active 直接启动；完整候选试运行；新代首次安装中断且没有 active 时，可重新试运行本地候选。旧代不能作为失败回退来源。

开始下载前以临时文件同步并原子替换 acquisition.json，保存 schemaVersion、cacheEpoch、environment 和已校验 manifest。manifest 已包含两个制品的 URL、摘要、大小与版本 Code。重试先读取 acquisition 和当前代缓存。两个完整制品可以离线解压安装；部分文件保留为 .part 并在手动重试时 Range 续传。网络错误不列为坏制品。

任一下载失败时取消另一请求并等待其结束，再进入等待页。运行时安装不自动重试、不监听网络恢复触发安装；重复点击由现有串行操作队列和 manager 的共享进行中任务处理。

用户批准的等待页：

```text
需要联网完成运行环境升级

已下载进度和本地数据会保留。

[重试] [打开日志]

网络恢复后，请点击“重试”继续。
```

HTTP 拒绝、制品损坏、磁盘权限或空间不足保留各自失败原因，不统一伪装成断网。

## rc.2 启动协议

只实现 rc.2 的 token -> 手动 303 -> HttpOnly Cookie 认证。Node RPC 和 Electron 页面使用同一启动代际的 Cookie；重启和停止撤销旧代认证。RPC 使用 session/list 和 workspace/create 的新请求结构，删除点号协议路径。

候选由隐藏 BrowserWindow 使用真实 preload 试运行。就绪信号是无参数 notifyHarnessReady()，preload 绑定本次页面的主进程 nonce；主进程校验窗口、主 frame、origin 和页面代际。隐藏试运行窗口不能调用其他特权 IPC。

插件在本地模块、布局插槽和必要服务注册且 React 首次提交后发就绪通知，不等待云端登录、模型调用或更新服务器。认证业务门禁保持原逻辑。隐藏页面收到通知后继续验证两帧，并拒绝明确的本地插槽挂载失败；离线云请求错误不作为本地失败。主窗口在事务完成后才展示 Harness。

## 数据事务与账号容器

目标运行时完整且通过静态校验之后，才配置账号容器并为要启动的 DSH_HOME 创建快照。快照包括 Profile、会话目录、账号设置文件及账号目录映射注册表，符号链接保留为链接，避免复制用户项目外部目标。注册表原先不存在的状态也被记录。

事务位于 userData/runtime-data-transactions/<environment>/，独立于缓存代际。每个账号容器分别记录已提交的 releaseId 和 Harness 制品摘要。已提交容器不允许自动回退到另一 Harness 身份，只有明确候选升级可以改变身份。

提交顺序：本地认证和页面验证通过 -> 数据事务 commit-decided -> Profile 提交 -> Release Set 提交 -> 数据事务 completed -> 展示页面。

启动恢复先于 prepareForLaunch：prepared 恢复快照并保留失败试运行目录；commit-decided 必须完成同一个 Profile/Release Set 提交；completed 不回滚。缺失或冲突的已决定目标必须阻止启动，不能悄悄换旧版本。

账号认证可以在试运行期间更新注册表，但实际账号目录搬迁和进程切换延迟至提交完成；重复认证也不能触发搬迁。历史 pendingLegacy 在首次配置容器时同样延迟，目录搬迁前先持久化目标路径对应的已提交 Harness 身份。这样既不阻塞插件本地启动，也不在快照保护前搬走原目录。快照和失败目录暂不自动清理，后续可引入单独的保留策略。

## 崩溃后的进程与数据保护

检查发现现有 detached Web Harness 不会仅因 Electron 父进程退出而可靠终止；因此数据恢复不能只依赖上一次主进程已经退出。

新版 Harness 使用 IPC 启动门禁。父进程先持久化 userData/runtime-process.json 中的进程 PID 和随机代际，再允许 Harness 入口执行。父进程断开时，守护逻辑终止 Harness 进程组。新启动在任何数据/Profile/账号恢复前检查进程记录；记录中的进程仍存活时禁止恢复，等待其退出后手动重试。正常停止失败同样保留进程句柄和记录，不能继续恢复或回退。

进程记录位于缓存之外，不包含 token/Cookie。清理需要匹配进程代际。PID 存活检查仅阻止恢复，不能凭陈旧 PID 强行终止可能被操作系统复用的其他进程。

## 构建与发布边界

开发及构建运行图固定 @deepseek-ai/dsh@0.1.5-rc.2；Electron 43.2.0 / ABI 148、pnpm 11.19.0。安装包继续不捆绑 Harness。更新真实 rc.2 app-boot 补丁及配套插件，本地候选必须标为不可发布，不能伪造生产插件 commit。

缓存代际只控制复用。服务端必须给新的客户端 Code 配置已验证的 rc.2 + 就绪插件组合，不能继承包含旧 Harness 的范围。必须分配比已发布值更大的客户端 Code；当前仓库 versionCode 6 不能直接作为本次强制升级的发布身份。

发布顺序：发布并固定实际插件源 -> 验收四平台 rc.2 制品 -> 分配新客户端 Code 并配置专属兼容范围 -> 跨代与断网验收 -> 发布 epoch 1 客户端。实际生产配置和发布不属于本地实现自动执行的操作。
