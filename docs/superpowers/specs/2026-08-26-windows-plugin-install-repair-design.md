# Windows 核心插件安装修复设计

## 背景

Arkme 0.1.4 将 DSH Profile 中的 `@senguoyun/dsh-arkme` 创建为一个指向应用安装目录 `resources/app.asar.unpacked/node_modules/@senguoyun/dsh-arkme` 的 Windows NTFS junction。核心插件更新通过 DSH 调用 pnpm 执行 `remove` 再 `add`，但 pnpm 11.19.0 的 `remove` 只移除依赖记录，不保证解除这个外部 junction。后续替换操作可能沿仍存活的 junction 影响安装目录，最终使 `lib/index.js` 消失，并在桌面应用下次启动的运行时文件检查中触发 `ENOENT`。

问题由两个边界错误共同造成：可变 Profile 直接链接到不可变安装目录，以及更新事务假设包管理器会安全解除该链接。修复必须同时消除这两个条件，并让 Windows 安装包能够修复已经损坏的用户状态。

## 目标

1. DSH Profile 中的核心插件不得再通过 symlink 或 junction 指向应用安装目录。
2. 每次运行 Windows 安装包，包括同版本重复安装，都把核心插件运行态重置为安装包内置版本。
3. 安装或重置必须离线完成，不依赖插件更新服务。
4. 安装器必须验证关键运行文件和核心插件恢复制品存在；验证失败时不得静默完成安装。
5. 插件在线更新必须兼容遗留 junction，并在调用 pnpm 前只解除链接本身。
6. 重置不得删除账号、数据库、工作区、用户设置或其他 DSH 扩展。

## 非目标

- 不改变更新入口、状态页或其他 UI。
- 不删除整个 `%APPDATA%\Arkme Harness` 或整个 DSH Home。
- 不在安装后保留较新的核心插件版本；安装包内置版本拥有优先级。
- 不调整服务端插件版本发布规则。

## 方案

### 1. 构建独立恢复制品

`jotmo-harness` 在准备运行时阶段，从已校验的生产核心插件目录生成一个 `.tgz`。恢复制品与一个包含包名、版本、文件名和 SHA-512 的清单一起进入独立的 `resources/arkme-plugin-seed`，而不是放在 Profile 将要引用的安装目录中。

构建继续保留当前 `app.asar.unpacked/node_modules` 运行时布局，以兼容 DSH 和现有打包校验，但 Profile 不再链接其中的核心插件目录。恢复清单和 `.tgz` 是 Profile 初始化的唯一内置安装来源。

### 2. 安装器触发干净重置

Windows NSIS 使用 `build/installer.nsh` 的 `customInstall` 钩子。标准应用文件解包完成后，钩子执行两项操作：

1. 检查安装目录中的 DSH 入口、核心插件 `lib/index.js`、恢复清单和 `.tgz`。任一文件缺失时终止安装并提示安装包不完整。
2. 删除 `%APPDATA%\Arkme Harness\dsh\arkme-self\desktop-plugin-bootstrap.json`。

该标记只表示“当前安装已完成核心插件初始化”。安装器每次运行都删除它，因此同版本重复安装也会让下一次应用启动执行重置。安装器不直接删除 Profile 插件目录，避免 NSIS 或 shell 递归删除跟随遗留 junction。

### 3. 启动时重建核心插件运行态

应用启动先验证恢复清单和 `.tgz` 的包名、版本和 SHA-512，再检查初始化标记。

标记不存在时执行以下事务：

1. 将恢复 `.tgz` 原子复制到 DSH Home 下的受管种子缓存。
2. 对 `profiles/web/node_modules/@senguoyun/dsh-arkme` 使用 `lstat`：如果是 symlink/junction，只调用 `unlink`；如果是真实目录，才在确认路径位于目标 Profile 后递归删除。
3. 将 Profile `package.json` 中核心插件依赖改为受管种子 `.tgz` 的绝对 `file:` spec；保留其他依赖、bundle 和用户配置。
4. 删除核心插件专属的在线更新缓存、安装回执、安装状态和残留更新计划，不删除 `arkme-self/prod` 中的数据库、上传、OpenClaw 或其他业务数据。
5. 调用打包内置 pnpm 重新安装 Profile 依赖，使核心插件成为 Profile 内的真实目录。
6. 校验安装目录不是链接，并校验包名、版本、`cordis.patch.yml`、`lib/index.js`、`lib/client.js` 和内容指纹。
7. 原子写入初始化标记。任何步骤失败都不写标记，使下次启动或重复安装可以重试。

重建完成后，DSH 启动和桌面管理 helper 都从 Profile 中的物理插件目录解析；应用运行期不再使用安装目录内的核心插件路径。

标记存在时执行常规健康检查，不因普通应用重启回退一个已经在线更新成功的核心插件。只有再次运行安装包才删除标记并强制回到安装包内置版本。

### 4. 在线更新的遗留链接防护

`arkme-dsh-plugin` 的独立更新 helper 和受监督更新路径在执行 `remove` 前调用同一个 Profile 插件路径防护函数：

- `lstat` 判定为 symlink/junction 时只执行 `unlink`；
- 判定为真实目录时交给 pnpm 正常处理；
- 判定为其他文件类型时拒绝更新；
- 解析路径必须严格等于指定 DSH Home/Profile 下的核心插件路径，禁止接受调用方提供的任意删除目标。

新安装形成的物理目录不会进入 junction 分支；该防护仅用于迁移遗留用户和纵深防御。

## 数据保留边界

安装重置会替换或清理：

- `profiles/web/node_modules/@senguoyun/dsh-arkme`；
- Profile manifest/lockfile 中该包对应的依赖状态；
- `arkme-self/prod/plugin-cache`；
- 核心插件更新的 install state、install receipt 和残留 plan 文件；
- 桌面核心插件初始化标记。

安装重置必须保留：

- `settings.json` 和默认工作区；
- `arkme-self/prod` 中的业务数据库与业务状态；
- 登录态、账号资料和上传内容；
- Profile 的其他依赖、bundle、patch 和用户自定义项；
- 非核心插件的 node_modules 内容。

## 错误处理和恢复

- 安装器缺少关键文件：安装失败并显示明确错误，不启动应用。
- 恢复制品哈希或元数据错误：应用停止启动，记录恢复制品校验失败，不触碰现有 Profile。
- 解除遗留链接失败：停止重置，记录精确路径和系统错误，不调用 pnpm。
- pnpm 安装失败：不写完成标记；保留业务数据，下次启动或再次安装可以重试。
- 安装后健康检查失败：不写完成标记，并报告实际缺失文件或版本不一致。
- 在线更新失败：现有回滚流程继续工作，但回滚目标也必须是缓存 `.tgz`，不得重新创建指向安装目录的 junction。

## 测试策略

### Harness 单元与集成测试

- 恢复制品清单拒绝错误包名、版本、文件名、路径穿越和 SHA-512。
- 首次安装标记缺失时清理核心插件并从 `.tgz` 物理安装。
- 遗留 junction 只删除链接，目标目录中的哨兵文件保持不变。
- 真实旧插件目录被替换，其他 Profile 依赖和用户配置保持不变。
- 安装完成标记只在全部校验成功后写入。
- 标记存在的普通冷启动不强制回退在线更新版本。
- 再次删除标记模拟重复安装，核心插件回退到安装包内置版本。
- 清理列表不触及业务数据库、工作区、上传和其他扩展。

### 插件更新测试

- helper 与受监督更新在遗留 junction 上先 `unlink`，再执行 remove/add。
- junction 目标中的哨兵和 `lib/index.js` 在成功、失败、回滚三条路径中都保持不变。
- 非链接目录继续走现有更新与回滚流程。
- 非预期文件类型和越出 Profile 的路径被拒绝。

### Windows 打包验收

- 修复 `packaged-smoke.mjs`，实际解析 `--platform win32` 并使用 `win-unpacked` 布局。
- 校验 NSIS 配置包含自定义 include。
- 校验 Windows unpacked 目录包含核心插件运行文件、恢复清单和 `.tgz`。
- 在 Windows CI 上创建真实 NTFS junction，执行安装重置和一次在线更新，断言安装目录哨兵未变化。

## 涉及仓库

- `jotmo-harness`：恢复制品构建、NSIS 安装标记、启动重置、Profile 物理安装、Windows 打包验收。
- `arkme-dsh-plugin`：更新前 junction 防护及相应的独立 helper、受监督更新和回滚测试。

两个仓库的修改可以独立测试，但发布时必须一起交付：先产出带安全更新逻辑的新核心插件版本，将它固定为桌面安装包的内置版本，再发布包含干净重置和恢复制品的安装包。在旧桌面版本完成迁移前，服务端应停止向仍使用不安全 updater 的版本下发核心插件更新，避免旧 helper 执行第一次危险迁移。
