# Harness 插件开发/生产来源隔离设计

## 背景

Harness 当前把 `@senguoyun/dsh-arkme` 声明为 `workspace:*`，并把
`vendor/arkme-dsh-plugin` 加入 pnpm workspace。开发人员需要先在插件仓库构建，
再手动执行同步脚本，将制品复制到 Harness 的 vendor 目录后才能运行。
生产打包也依赖同一个 vendor 入口，再由 `prepare-runtime.mjs` 二次复制到
Electron 的独立运行时。

该模型存在三个问题：

1. 开发联调包含显式的“构建 + 同步 + 启动”三步，容易运行到旧制品。
2. 开发和生产共用 vendor 来源，生产构建可能误打包本地制品，来源边界不够硬。
3. 插件版本在 Profile、测试和烟测中多处硬编码，切换插件版本时容易漂移。

## 目标

- 开发人员只执行 `pnpm dev`，Harness 自动构建并直接引用本地插件仓库。
- 允许通过 `ARKME_PLUGIN_PATH` 使用任意本地插件仓库路径；未设置时默认使用
  Harness 相邻的 `../arkme-dsh-plugin`。
- 生产依赖由 pnpm 从远端 Git 仓库获取和构建，并锁定完整 commit SHA。
- 打包后的应用只使用安装包内的插件，始终忽略本地路径覆盖。
- 生产安装包可追溯到插件仓库、commit 和 package version。
- 插件版本由实际插件 manifest 提供，不在 Harness 业务代码中硬编码。

## 非目标

- 本次不实现插件 Host/Client Bundle 的热替换。
- 本次不改变插件自身的发布流程、业务功能或 DSH 扩展协议。
- 本次不顺带升级生产插件版本。首次迁移保持 Harness 当前校验的插件版本
  `0.1.4`，并锁定该版本在插件仓库中的发布 commit
  `d29c844420016a22f40619c4bfe1f5719b0752ef`；后续升级通过独立变更完成。
- 本次不增加 UI 或设置页面。

## 方案选择

采用“开发路径覆盖 + 生产 Git 固定依赖”。

开发和生产不再通过同一份 vendor 内容决定来源：

- 开发来源属于 Harness 启动配置。开发启动器构建本地插件，并把绝对路径通过
  `ARKME_PLUGIN_PATH` 传给非打包 Electron 进程。
- 生产来源属于包管理配置。Harness 根 package 和独立 runtime package 都通过
  pnpm named catalog 引用同一个 Git commit，lockfile 记录解析结果。
- `app.isPackaged` 是最终安全边界。打包应用不读取 `ARKME_PLUGIN_PATH`。

未选择继续自动同步 vendor 的原因是它仍保留重复制品，并不能消除“当前运行的
到底是哪一份插件”的歧义。未选择 dev/prod 两套 package/lockfile，是因为两套
依赖图容易漂移，也会增加升级 Harness 和插件依赖时的维护成本。

## 包管理配置

`pnpm-workspace.yaml` 删除 `vendor/arkme-dsh-plugin` workspace，并增加名为
`production` 的 catalog：

```yaml
packages:
  - .
  - runtime

catalogs:
  production:
    '@senguoyun/dsh-arkme': >-
      git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#d29c844420016a22f40619c4bfe1f5719b0752ef
```

Harness 根 package 的开发依赖和 `runtime/package.json` 的生产依赖均声明为：

```json
"@senguoyun/dsh-arkme": "catalog:production"
```

根 package 保留该依赖有两个作用：开发路径未显式覆盖时可以提供可诊断的生产
回退包，同时单测和生产来源校验可以通过 Node 标准解析验证已安装包。真正的
生产打包依赖来自 runtime package，进入 `.runtime/dsh/node_modules`。

生产安装使用 `pnpm install --frozen-lockfile`。catalog 必须是完整 40 位 SHA；
分支和 tag 不作为最终 pin，因为它们可以移动。

## 开发启动流程

新增开发启动器 `scripts/run-development.mjs`，`pnpm dev` 只调用该入口。

启动器执行以下固定步骤：

1. 读取 `ARKME_PLUGIN_PATH`，记录它是否由用户显式提供；若为空，解析相邻目录
   `../arkme-dsh-plugin`。
2. 如果用户显式提供路径，或者默认相邻目录存在，则将路径规范化为绝对路径并
   选择本地开发模式；如果用户未提供路径且默认目录不存在，则通过 Node 解析选择
   已安装的 production catalog 插件，并跳过本地构建。
3. 读取所选插件的 `package.json`，校验 package name 为
   `@senguoyun/dsh-arkme`，并校验
   `dsh.bundle.patch`、`cordis.patch.yml` 和构建入口要求。
4. 本地开发模式在插件目录执行 `pnpm run build`。构建失败时原样返回非零退出
   码，不启动 Harness；production catalog 回退模式不重新构建已安装包。
5. 校验构建结果至少包含 `lib/index.js` 和 `lib/client.js`。
6. 编译 Harness、复制静态资源，并启动 Electron；子进程环境中写入规范化后的
   `ARKME_PLUGIN_PATH`。
7. 开发启动日志明确打印本地插件绝对路径和 manifest version。

启动器不自动执行插件仓库的 `pnpm install`。如果插件依赖没有安装，构建错误应
提示开发者先在插件仓库安装依赖，避免每次启动隐式修改另一个仓库的 lockfile。

插件构建结果仍由插件仓库自身管理。Harness 不复制插件文件，也不修改插件仓库。
当前 DSH 在启动时加载 Host/Client Bundle，因此一次开发启动对应一次插件构建；
修改插件后重新执行 `pnpm dev` 或使用 Harness 的重启能力。

## 运行时路径解析

`resolveArkmePluginPath` 保留打包/非打包分支，但改变非打包分支的优先级：

```text
app.isPackaged = true
  -> app.asar.unpacked/node_modules/@senguoyun/dsh-arkme

app.isPackaged = false
  -> ARKME_PLUGIN_PATH（存在且非空）
  -> Node 解析到的生产依赖（仅作为回退）
```

开发覆盖路径必须在返回前规范化为绝对路径。路径是否有效、插件 manifest 是否
满足约束，由 Profile provision 阶段统一验证。

即使打包应用的进程环境包含 `ARKME_PLUGIN_PATH`，解析器也不得读取它。这保证
生产应用不能被外部环境变量替换插件代码。

## Profile 版本与校验

`provisionArkmeWebProfile` 在一次读取中解析插件 manifest，得到插件名、版本和
bundle patch：

- 名称必须为 `@senguoyun/dsh-arkme`。
- version 必须是非空字符串。
- `dsh.bundle.patch` 必须为 `./cordis.patch.yml`。
- `cordis.patch.yml`、`lib/index.js` 和 `lib/client.js` 必须存在。

Profile 的 dependencies 使用该 manifest 的实际 version。删除 Harness 中的
`PLUGIN_VERSION` 常量，测试也通过 fixture manifest 明确给出所需版本，而不依赖
当前生产版本。

该变化允许开发环境运行本地较新版本，同时生产环境继续运行被 Git commit 锁定的
版本，不会因为 Harness 中的硬编码版本不同而拒绝启动。

## 生产 runtime 和来源证明

`prepare-runtime.mjs` 继续通过 pnpm deploy 生成独立 runtime，但删除从
`vendor/arkme-dsh-plugin` 调用 `materializeWorkspacePackage` 的逻辑。部署完成后：

1. 校验 runtime 中存在插件 manifest、Host/Client 入口和 patch 文件。
2. 导入 runtime 中的 `lib/index.js`，保留现有加载烟测。
3. 从 `pnpm-workspace.yaml` 的 production catalog 和 `pnpm-lock.yaml` 读取仓库及
   resolved commit，并验证二者相同。
4. 在 runtime 插件目录写入 `PLUGIN_PROVENANCE.json`：

```json
{
  "schemaVersion": 1,
  "source": "git",
  "repository": "git@github.com:arkme-senx/arkme-dsh-plugin.git",
  "commit": "d29c844420016a22f40619c4bfe1f5719b0752ef",
  "packageName": "@senguoyun/dsh-arkme",
  "packageVersion": "0.1.4"
}
```

`packageVersion` 示例表示首次迁移所保持的现有版本；实际值从部署后的 manifest
读取。来源解析使用显式 YAML 解析依赖，不通过未约束的正则表达式解析 lockfile。

`packaged-smoke.mjs` 验证该 provenance、插件 manifest 与生产 pin 一致，同时继续
启动打包 runtime 验证能力接口。生产包中不再要求旧的 `UPSTREAM_COMMIT` 文件。

## 失败处理

开发失败均在 Electron 启动前终止：

- 本地路径不存在：输出最终解析路径和环境变量覆盖方式。
- manifest 名称或 bundle contract 不合法：输出具体字段，不自动回退到生产包。
- 插件构建失败：保留插件构建 stdout/stderr 和退出码。
- 构建入口缺失：提示构建完成但制品不完整。

只有完全未提供 `ARKME_PLUGIN_PATH` 且默认相邻仓库不存在时，开发启动器才允许
选择已安装的生产插件作为显式回退，并在日志中标记“using installed production
plugin”。如果用户提供了错误的覆盖路径，不静默回退。

生产失败均阻断打包：

- catalog 不是完整 commit SHA。
- lockfile resolved commit 与 catalog 不一致。
- runtime 插件路径是指向 runtime 外部的符号链接。
- manifest、构建入口或 provenance 不一致。
- 插件真实加载烟测失败。

## 测试策略

### 单元测试

- 打包环境固定返回 `app.asar.unpacked` 插件路径，并忽略开发覆盖变量。
- 非打包环境优先返回规范化后的 `ARKME_PLUGIN_PATH`。
- 非打包环境在无覆盖时回退到 Node 解析的安装依赖。
- Profile 接受任意合法非空版本，并把实际版本写入 dependencies。
- Profile 拒绝错误 package name、空版本、错误 patch 和缺失入口。
- production catalog 只接受完整 Git SHA。

### 脚本测试

- 使用临时插件 fixture 验证开发启动器的解析、构建顺序和错误传播。
- 验证错误的显式路径不会回退到生产插件。
- 验证 runtime 准备不读取 vendor，并写出正确 provenance。
- 验证 runtime 插件不是指向工作区外部的符号链接。

### 集成和打包测试

- 继续运行真实 DSH smoke，分别覆盖本地插件路径和 production runtime。
- packaged smoke 校验 commit、package version、关键文件和能力接口。
- `pnpm test`、`pnpm run typecheck`、`pnpm run build` 必须通过。
- 在具备 Electron 打包环境时运行 `pnpm run pack`；正式发布链路继续运行
  `pnpm run dist`。

## 迁移步骤

1. 先增加来源配置解析、运行时路径测试和 Profile 动态版本测试。
2. 实现开发启动器，将 `pnpm dev` 切换为本地路径覆盖流程。
3. 将根 package 和 runtime package 切换到 production catalog，更新 lockfile。
4. 删除 vendor workspace、同步脚本入口和 runtime 的 vendor 二次复制。
5. 增加 production source verifier、provenance 和打包烟测。
6. 更新 README，分别说明开发命令、路径覆盖和生产 pin 更新流程。
7. 运行全量测试、类型检查、构建及可用的打包验证。

迁移完成后，`vendor/arkme-dsh-plugin` 仍保留在 `.gitignore` 一段时间，以兼容开发者
机器上的旧目录；Harness 不再读取它。后续可在独立清理变更中移除该 ignore 项。

## 验收标准

- 全新开发环境在两个仓库相邻且各自已安装依赖时，执行一次 `pnpm dev` 即能构建
  本地插件并启动 Harness。
- 指定 `ARKME_PLUGIN_PATH` 后，运行日志和 DSH Profile 都指向该本地插件及其实际
  version。
- 开发不再生成或更新 `vendor/arkme-dsh-plugin`。
- `pnpm install --frozen-lockfile && pnpm run dist` 只使用 production catalog 锁定的
  Git commit。
- 打包应用不受 `ARKME_PLUGIN_PATH` 影响。
- 安装包内可以读取并验证插件 repository、commit 和 version。
- Harness 源码、测试和烟测中不再硬编码 `0.1.4` 作为运行时校验条件。
