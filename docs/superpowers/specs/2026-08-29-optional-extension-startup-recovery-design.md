# Arkme 可选扩展启动恢复设计

## 背景与根因

Electron 壳下载并激活新的 Harness release-set 后，Harness 仍会读取持久化 DSH Profile 中的全部 Bundle。开发阶段遗留的 `link:` 或 `file:` 扩展可能引用已经移动、损坏或依赖不完整的本地目录。DSH/Cordis 在组合 Profile 时只要有一个 Bundle 加载失败，整个 Harness 就会在 Arkme 主插件启动前退出。

现有恢复只覆盖由 Arkme 扩展管理器创建、带受管重启计划的安装和启停操作。历史 Profile 残留没有重启计划，异常会直接上抛给 runtime manager，导致刚下载的 Harness release 被错误标记为坏版本并回滚。Arkme 插件自身的扩展隔离逻辑要等 Arkme 已加载后才能运行，因此无法处理这类启动前失败。

## 目标

1. 可选扩展加载失败时，优先停用故障扩展并使用同一 Harness release 重试一次。
2. Arkme 主插件和 DSH 核心 Bundle 永远不得被自动停用。
3. 无法定位具体故障扩展时，只对当前启用的 `link:`/`file:` 本地开发扩展启用安全模式兜底。
4. 恢复成功时不得把 Harness release 标记为坏版本，也不得回滚整个 runtime。
5. 恢复重试仍失败时，必须恢复 Profile 原状，再进入现有 runtime 回滚或失败界面。
6. 被隔离扩展保持禁用，直到用户在扩展管理中手动重新启用并重启。
7. 生产与测试环境沿用各自独立的 DSH Home、Profile、扩展状态和隔离记录，不互相读取或修改。

## 非目标

- 不修改 Harness/Cordis 的 Bundle 加载语义。
- 不删除扩展依赖、插件文件或本地源码目录。
- 不自动修复第三方扩展源码或依赖。
- 不允许跳过 `@senguoyun/dsh-arkme` 后启动空白壳。
- 不为任意网络、端口、权限或 runtime 文件错误启用插件隔离。
- 不自动重新启用已经隔离的扩展。

## 总体架构

实现由两个边界清晰的部分组成：

1. `jotmo-harness` 在 Arkme 尚未运行时负责识别“可选 Bundle 启动失败”、原子修改 Profile、记录隔离事务并对同一 runtime 进行一次重试。
2. `arkme-dsh-plugin` 在恢复启动成功后读取隔离记录，把受管扩展的数据库状态收敛为 `enabled=false`、`active=false`，并向用户展示可理解的安全启动通知。

Electron 壳只处理 JSON Profile 和隔离记录，不直接打开或修改 Arkme 的 SQLite 数据库。Arkme 插件只同步已经由壳完成的 Profile 事实，不参与启动前判定。

## 核心保护策略

以下包均属于受保护 Bundle，任何日志内容都不能让恢复器自动停用它们：

- `@senguoyun/dsh-arkme`；
- 所有 `@deepseek-ai/*` 包；
- Profile 中由桌面壳固定提供的基础 Bundle。

候选包名必须同时满足：

- 是 Profile `dsh.profile.bundles` 中当前启用的字符串项；
- 是 Profile `dependencies` 中的直接依赖；
- 包名通过 npm 包名形状校验；
- 不在核心保护集合中。

恢复器仅允许修改固定的 `<DSH_HOME>/profiles/web/package.json`，不得接受日志或调用方传入任意文件路径。

## 故障识别与候选选择

恢复器只处理 Harness 在 ready 之前退出，并且启动尾日志包含 DSH/Cordis Bundle 导入、解析、应用或依赖加载失败信号的情况。超时、端口占用、进程创建失败、权限错误、runtime 文件缺失和工作区注册失败不属于扩展加载故障。

候选选择分两级：

1. **精确隔离**：如果日志明确出现一个当前启用的可选包名、其已安装目录或其 `link:`/`file:` 源路径，并伴随模块解析或 Bundle 加载失败信号，只隔离该包。该规则适用于 registry、tarball、`link:` 和 `file:` 依赖。日志可以同时提到“找不到受保护依赖”；只要导入方或堆栈路径唯一归属于可选扩展，隔离对象仍是该可选扩展，绝不把缺失的受保护依赖作为候选。
2. **本地安全模式**：如果日志能确认是 Bundle 加载失败，但无法唯一关联到包名，则隔离全部当前启用、依赖 spec 以 `link:` 或 `file:` 开头的非核心扩展。

如果日志只能定位到受保护包、候选集合为空，或者无法确认属于 Bundle 加载错误，恢复器不得改写 Profile。日志关联到多个可选包时不执行单包精确隔离；如果仍能确认是 Bundle 加载错误，则只能退回“本地安全模式”规则，隔离其中当前启用的 `link:`/`file:` 候选，不能顺带隔离 registry 或 tarball 扩展。

## Profile 隔离事务

新增独立模块负责 Profile 事务，不把 JSON 解析和隔离判断塞入 supervisor。事务步骤如下：

1. 读取并验证 `<DSH_HOME>/profiles/web/package.json`。
2. 保存原始文件文本、原 Bundle 顺序和候选依赖 spec。
3. 从 `dsh.profile.bundles` 中移除候选包，保留 `dependencies`、lockfile、node_modules 和源码。
4. 通过同目录临时文件、`fsync` 和原子 `rename` 写入 Profile。
5. 在 `<DSH_HOME>/arkme-self/desktop-extension-quarantine/<quarantineId>/` 原子写入状态为 `pending` 的隔离记录和只读的 `profile-package.json.before` 原始文本备份。
6. supervisor 使用同一个 runtime、同一个工作区重新启动一次。

隔离记录使用以下契约：

```ts
interface DesktopExtensionQuarantineReceipt {
  schemaVersion: 1;
  quarantineId: string;
  environment: "prod" | "test";
  phase: "pending" | "active" | "restored" | "resolved";
  mode: "targeted" | "local-safe-mode";
  createdAtMillis: number;
  updatedAtMillis: number;
  runtimeReleaseId?: string;
  failureSummary: string;
  failureLogTail: string;
  entries: Array<{
    packageName: string;
    dependencySpec: string;
    originalBundleIndex: number;
    synchronizedAtMillis?: number;
    notificationDismissedAtMillis?: number;
    reenableRequestedAtMillis?: number;
    resolvedAtMillis?: number;
  }>;
}
```

`failureLogTail` 最多保存 16 KiB，并在写入前移除控制字符。用户界面默认显示 `failureSummary`，点击“查看详细原因”后在通知内展开经过清洗的日志尾部。

## Supervisor 恢复顺序

启动失败后的处理顺序固定为：

1. 如果存在受管扩展重启计划，继续执行现有 rollback；rollback 后的再次失败才允许进入通用恢复。
2. 对失败尾日志执行可选扩展恢复判定。
3. 有候选时执行 Profile 隔离事务，并只重试一次同一 runtime。
4. 重试成功时把隔离记录改为 `active`，向 runtime manager 返回正常启动结果。
5. 重试失败时按保存的原始文本恢复 Profile，把记录改为 `restored`，再抛出最初的启动异常，并附加恢复重试失败信息。
6. runtime manager 收到异常后继续执行既有 probation rollback 或失败流程。

`phase=active` 的 receipt 是持久隔离事实。每次启动 Harness 前，壳都重放全部未解决 entry：如果 Profile 被 runtime Profile 事务或其他流程恢复了旧 manifest，壳会再次移除这些 Bundle。受管 runtime/Profile rollback 完成后、再次 launch 前也执行同一重放，避免 rollback 悄悄恢复已隔离扩展。只有 entry 存在 `reenableRequestedAtMillis` 时才允许该包通过一次启动收敛门禁。

每次 `startInternal` 最多执行一次通用恢复，不允许递归触发或形成启动循环。恢复成功发生在异常离开 supervisor 之前，因此当前 runtime release 不会被登记为坏版本。

应用进程在 Profile 写入后意外退出时，下一次启动先处理 `pending` 记录：如果 Profile 中的候选仍然处于停用状态，则把本次正常 launch 视为该事务唯一一次恢复重试；成功后改为 `active`，失败后从 `profile-package.json.before` 恢复。如果 Profile 仍包含全部候选，说明隔离写入没有完成，恢复原始文本并把记录改为 `restored`。该规则保证进程崩溃不会留下无法解释的半事务或无限重试。

## Arkme 状态收敛

Arkme 扩展管理器初始化后扫描 `phase=active` 且尚未同步的隔离记录：

- 通过 `profilePackageName` 匹配受管安装记录；
- 将匹配项写为 `enabled=false`、`active=false`；
- 把中文失败摘要写入 `lastError`；
- 不匹配安装数据库的本地 Profile 扩展仍通过 Profile inventory 显示为未启用；
- 同步成功后在对应 entry 写入 `synchronizedAtMillis`，不删除记录。

用户在扩展管理中点击“重新启用并重启”时，插件先原子写入 `reenableRequestedAtMillis`，再恢复 Profile Bundle，并创建 schema 4 桌面隔离激活计划。新进程通过 `extensions.quarantine.health` 同时验证 Profile 已包含该包且 Loader inventory 为 active；只有两项均通过才写入 `resolvedAtMillis`。验证失败时受管 rollback 再次从 Profile 移除该包，并保留 `phase=active`；所有 entry 均已恢复时，receipt 的 phase 才更新为 `resolved`。应用冷启动不得自动恢复该扩展。

## 用户界面

恢复启动成功后显示一次可关闭的安全启动通知。通知来源于最新的 `active` 隔离记录，已确认的文案和操作如下。

单个扩展：

```text
┌──────────────────────────────────────────────┐
│ 已安全启动                                   │
│                                              │
│ 扩展 @senguoyun/dsh-arkme-peer-portrait      │
│ 启动时加载失败，已自动停用。                  │
│ Arkme 其他功能可以继续使用。                  │
│                                              │
│ 原因：无法加载扩展依赖                        │
│                                              │
│ [查看详细原因] [打开扩展管理] [知道了]         │
└──────────────────────────────────────────────┘
```

多个本地扩展：

```text
┌──────────────────────────────────────────────┐
│ 已进入本地扩展安全模式                        │
│                                              │
│ 无法确定具体故障扩展，已停用多个本地开发扩展。 │
│ 修复后可在扩展管理中手动重新启用并重启。        │
│                                              │
│ [查看已停用扩展] [打开日志] [知道了]            │
└──────────────────────────────────────────────┘
```

扩展管理列表对匹配到安装记录的条目显示“已自动停用”、失败摘要、“查看原因”和“重新启用并重启”。关闭通知只给对应 entry 写入 `notificationDismissedAtMillis`，不改变隔离状态。

## 日志与错误处理

supervisor 日志增加结构化生命周期事件：

- `optional-extension-recovery-detected`；
- `optional-extension-recovery-quarantined`；
- `optional-extension-recovery-retry-succeeded`；
- `optional-extension-recovery-retry-failed`；
- `optional-extension-recovery-profile-restored`。

Profile 不合法、原子写入失败或隔离记录失败时，不启动恢复重试，也不留下半写入 Profile。重试失败且 Profile 恢复失败时，失败界面必须同时显示原始启动原因和“无法恢复扩展配置”，日志记录 Profile 路径及系统错误，但不得删除其他用户数据。

## 测试策略

### `jotmo-harness`

- 精确日志匹配只选择一个启用的可选扩展。
- 无法精确匹配时只选择启用的 `link:`/`file:` 可选扩展。
- registry 扩展不会进入本地安全模式候选。
- Arkme 主插件和任意 `@deepseek-ai/*` 永远不进入候选。
- 非 Bundle 加载错误、多个精确匹配、无候选和非法 Profile 不产生修改。
- 隔离保留 dependencies、文件、lockfile 和 Bundle 相对顺序。
- 原子事务成功时生成完整 receipt；失败时 Profile 保持字节级不变。
- 进程在 Profile 改写后退出时，下一次启动从 pending receipt 恢复唯一一次重试；再次失败按备份字节级恢复。
- supervisor 使用同一 runtime 只重试一次，成功后不抛错。
- 恢复重试失败时恢复原始 Profile，并继续原有 runtime 回滚。
- 受管重启计划 rollback 的优先级保持不变。
- active receipt 在 runtime Profile rollback 后、再次 launch 前会重新隔离对应 Bundle。
- 无重新启用授权的 active entry 即使被旧 Profile 恢复，也不能被静默标记 resolved。
- 生产与测试 DSH Home 中的 Profile 和 receipt 完全独立。

### `arkme-dsh-plugin`

- active receipt 能把匹配安装记录收敛为 disabled/inactive 并记录中文原因。
- 无安装记录的本地 Profile 扩展仍以 inactive 形式出现在 inventory。
- 已同步 receipt 不重复弹出；关闭通知不重新启用扩展。
- 手动重新启用仍产生受管重启计划，成功启动后 receipt 变为 resolved。
- schema 4 重启计划不伪造 install-store 元数据，并同时校验 Profile enabled 与 Loader active。
- 重新启用失败仍保持 disabled 和 active quarantine。
- 单扩展和本地安全模式通知按已确认文案展示，操作入口可用。

## 发布与回归边界

该能力需要同时发布包含 supervisor 恢复器的新 Electron 壳和包含 receipt 收敛/UI 的 Arkme 插件。旧壳不会执行启动前隔离；新壳搭配旧 Arkme 插件仍可完成启动恢复，但扩展数据库和通知只有升级到新 Arkme 插件后才会收敛。

发布前必须回归：

- 正常 Profile 启动不发生额外写入；
- 生产 release-set 动态更新和 probation 仍正常；
- 测试壳仅修改 `Arkme Harness Test` 对应 DSH Home；
- 生产登录态、数据库、设置和 Profile 时间戳在测试恢复场景中不变化；
- Windows、macOS 和 Linux 使用相同判定及事务逻辑。
