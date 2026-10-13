# 语言与产品品牌

客户端使用 `zh` → 即我、`en` → Arkme 两套展示。启动时按 Electron 应用语言归一化，所有 `zh-*`/`zh_*` 使用中文品牌，其他语言使用 Arkme。Harness 加载后，其公开 locale 偏好成为权威值；设置页切换语言会立即同步。没有新增语言设置文件。

`window.arkmeDesktop.branding` 提供 `schemaVersion: 1`、文档加载时的只读 `current` 快照和 `setLocale('zh'|'en'): Promise<boolean>`。只有当前 Harness 主窗口的主 frame 可以写，启动状态页只可读；其他窗口、子 frame、旧 origin 或任意路径/图片输入均拒绝。插件应先检测桥是否存在，旧客户端继续正常显示页面。

Electron 主进程负责主窗口标题、应用菜单、About 名称和运行中 macOS Dock 图标。图片来自包内 `dist/ui/branding/`；相同语言不重复加载图片或重建菜单。不改应用 ID、深链、可执行文件、用户数据目录或更新渠道。测试应用继续显示独立的 Test 名称。

中文图标复用本仓 `build/icon.png`；英文图标复用本仓正式 Arkme 图标（历史提交 `306b0081` 的 `build/icon.png`）。插件的 UI 素材由插件仓维护，桥只传语言，不传图片或文件路径。

macOS/MAS 的签名前 `afterPack` 钩子写入中文/英文 `InfoPlist.strings`，同时本地化 `CFBundleName` 和 `CFBundleDisplayName`。正式文件名保留 `即我.app`，Finder 可依据 macOS 应用语言显示本地化名称；测试包不覆盖名称。不要修改已经签名的应用包。

边界：`dock.setIcon` 只控制运行中的图标。退出后 Dock、Finder 的静态安装图标以及 App Store 商品页图标属于包/商店资源，不随应用内语言即时更新。本改动不代表 MAS 沙箱、签名、商店资料和审核已完成，也不发布或替换已安装客户端。

验证入口：`pnpm test`、`pnpm run typecheck`、`pnpm run build`。契约/资源测试为 `desktop-branding`、`preload-bridge`、`macos-brand-localization` 和 `status-ui`；真实验收需在隔离数据目录中通过 Harness 设置切换中英，核对页面与原生 Dock，不能仅凭构建成功认定。
