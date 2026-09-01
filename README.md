# Arkme

Arkme 是一个面向 macOS、Windows 和 Linux 桌面客户端。它会在本机启动 DeepSeek Harness 服务，并在安全隔离的桌面窗口中打开 Harness Web UI。

生产应用采用“轻量桌面外壳 + 按需运行环境”的结构：安装包不内置 Harness、Arkme 插件或独立 Node.js 运行时。应用首次启动时会下载并校验与当前平台匹配的运行环境，后续可直接使用已验证的本地副本。

## 主要功能

- 自动启动、监控和重启本机 Harness 服务
- 自动创建默认工作区，并保存最近使用的项目目录
- 管理 Harness 与 Arkme 插件运行环境，支持后台更新、完整性校验和失败回滚
- 检查并下载 Arkme 桌面客户端更新
- 使用系统目录选择器、桌面通知和单实例窗口
- 支持通过 `arkme://` 深链打开扩展分享页面

## 支持平台

| 平台 | 架构 | 正式构建产物 |
| --- | --- | --- |
| macOS | Intel 与 Apple 芯片 | Universal `.app`、DMG、ZIP |
| Windows | x64 | NSIS 安装包、ZIP |
| Linux | x64 glibc | AppImage |

Harness 运行环境覆盖上述全部目标。桌面客户端内置的更新检查与安装包下载当前支持 macOS arm64、Windows x64 和 Linux x64。

## 使用方式

1. 安装并启动适合当前平台的 Arkme 发布包。
2. 首次启动时保持网络连接，等待应用下载并校验 Harness 与 Arkme 插件运行环境。
3. 如果没有已保存的项目目录，Arkme 会在应用数据目录中创建 `workspace/` 作为默认工作区；后续启动会继续使用最近一次有效的目录。
4. 在 Harness Web UI 的 **Settings → Models** 中配置模型和 API Key。

在 macOS 和 Linux 上，可以通过 **文件 → 选择项目…**（`CmdOrCtrl+O`）切换项目，通过 **文件 → 重新启动 Harness**（`CmdOrCtrl+Shift+R`）重启本地服务。启动状态页在需要时也会提供选择项目、重试、重新加载运行环境和打开日志等操作。

## 本地开发

### 环境要求

- Node.js 24 或更高版本
- pnpm 11.19.0
- macOS 开发与打包需要 Xcode Command Line Tools，用于构建系统通知权限查询模块
- 已配置 GitHub SSH 访问；生产插件依赖通过 Git SSH 固定到经过审查的 Commit

安装依赖并启动开发客户端：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发启动器会按以下顺序选择 Arkme 插件：

1. 使用 `ARKME_PLUGIN_PATH` 显式指定的本地仓库；
2. 使用同级目录中的 `../arkme-dsh-plugin`；
3. 如果前两者都不存在，使用已安装的固定版本依赖。

```bash
ARKME_PLUGIN_PATH=/absolute/path/to/arkme-dsh-plugin pnpm dev
```

当使用本地插件仓库时，每次执行 `pnpm dev` 都会先构建插件，再构建并启动桌面客户端。插件源码变化后需要重启开发客户端才能重新构建并加载。

## 测试与构建

提交改动前建议执行：

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

### 正式构建

| 平台 | 命令 | 主要输出 |
| --- | --- | --- |
| macOS 可运行目录 | `pnpm run pack` | `release/mac-universal/arkme.app` |
| macOS 分发包 | `pnpm run dist` | `release/` 下的 DMG 与 ZIP |
| Windows | `pnpm run dist:win` | `release/` 下的 NSIS 安装包与 ZIP |
| Linux | `pnpm run dist:linux` | `release/` 下的 AppImage |

macOS 和 Windows 正式构建需要可用的代码签名环境。Linux 构建生成 AppImage，不使用同一套代码签名流程。

所有正式应用包都只包含 Electron 外壳。打包冒烟测试会验证应用资源中没有内置 Harness、Arkme 插件或独立 Node.js 运行时，并使用全新的应用数据目录验证动态运行环境安装与启动流程。

### 测试环境构建

```bash
pnpm run dist:test:mac
pnpm run dist:test:win
pnpm run dist:test:linux
```

测试环境构建使用独立的应用名称、协议和数据目录，输出到 `release-test-dynamic/`，不会覆盖正式应用身份。

在 macOS 上，还可以构建直接使用本地插件仓库的未签名测试应用：

```bash
# 默认使用同级目录中的插件仓库
pnpm run pack:test

# 显式指定本地插件仓库
ARKME_PLUGIN_PATH=/absolute/path/to/arkme-dsh-plugin pnpm run pack:test
```

输出为 `release-test/mac-arm64/arkme Local Test.app`。该应用使用独立 Bundle ID 和协议，并直接引用当前机器上的插件仓库，因此不能作为分发包使用。

### 构建 Harness 运行环境

运行环境制品需要在各目标平台分别构建，并使用相同的构建标识：

```bash
ARKME_RUNTIME_BUILD_ID=example-build-1 pnpm run build:runtime:electron-harness
```

默认输出目录为 `artifacts/electron-harness/<buildId>/`。构建脚本会重新构建原生依赖，并验证 Electron 版本、Node Modules ABI、平台与架构信息后再生成压缩制品。

## 更新与安全机制

Arkme 包含两条相互独立的更新链路：

- **桌面客户端更新**：检查新的平台安装包，下载完成后由用户打开或安装。
- **运行环境更新**：同时管理 Harness 和必需的 Arkme 插件。更新会先下载到暂存目录，通过清单、平台、版本、文件大小、SHA-256 和关键路径校验后，才会在下次启动时启用。

新的运行环境会经过启动、工作区注册和插件健康检查。验证失败时，应用会回退到上一份可用环境；确定损坏或身份不一致的制品会被隔离，避免重复启动。稳定环境损坏时，应用会尝试从本地副本恢复或重新下载。

桌面窗口启用了上下文隔离和渲染进程沙箱，并关闭 Node.js 集成。Harness 页面只能从本机回环地址加载；外部 HTTPS 链接会在系统浏览器中打开。

## 本地数据

正式环境的默认数据目录：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/Arkme Harness/` |
| Windows | `%APPDATA%\Arkme Harness\` |
| Linux | `~/.config/Arkme Harness/` |

测试应用使用独立的 `Arkme Harness Test` 目录。开发或自动化测试也可以通过绝对路径环境变量 `ARKME_APP_DATA_PATH` 覆盖应用数据根目录。

主要内容包括：

- `workspace/`：没有已保存项目时自动创建的默认工作区
- `settings.json`：最近一次有效的项目目录
- `dsh/`：Harness 设置、凭据、Profile、会话及扩展数据
- `logs/desktop-startup.log`：桌面客户端启动与运行时诊断日志
- `logs/harness.log`：Harness 服务的标准输出和标准错误日志
- `runtime-manager/electron-v1/`：当前、候选、历史、暂存和下载的运行环境数据

这些文件属于本机用户数据，不应提交到源码仓库。仓库的 `.gitignore` 已排除根目录 `settings.json`、环境变量文件、常见凭据文件、数据库和构建产物。

## 参与贡献

1. Fork 仓库并创建功能分支。
2. 使用固定锁文件安装依赖：`pnpm install --frozen-lockfile`。
3. 完成改动后运行测试、类型检查和构建。
4. 提交 Pull Request，并说明变更目的、验证结果以及涉及的平台。

涉及依赖、打包、运行环境或安全边界的改动，应同时更新相关测试并在目标平台完成验证。

## 开源许可

本项目采用 [MIT License](LICENSE) 开源。
