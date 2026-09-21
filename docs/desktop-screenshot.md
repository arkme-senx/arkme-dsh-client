# 原生截图桥接 v1

主进程实现：`src/desktop-screenshot-ipc.ts`，生命周期/PNG校验：`src/desktop-screenshot-session.ts`，受限桥接：`src/preload.cts`。

`arkmeScreenshot.capture(requestId)` 只接受受信任主窗口或有效会话窗口的顶层 frame，等待 `{status:'captured',contentBase64,mimeType:'image/png',fileName}` 或 `{status:'cancelled'}`。`cancel(requestId)` 仅取消该发起者的匹配请求。单次仅允许一个截图会话。

截图窗口通过 `context()` 获取本屏 `{contentBase64,width,height}`；`ready()` 表示原图已绘制；`select()` 锁定本屏；`save(png)` 打开系统保存对话框；`complete(png)` 返回图像并关闭；`close()` 取消。截图窗口始终使用原会话的 Electron session，但所有动作仍验证窗口身份、frame、origin 和账户 scope。

20秒捕获/加载期限，编辑不设期限。捕获完成前不创建覆盖窗口；窗口截图页面由插件专用入口渲染；新客户端与新插件一起启用功能。旧插件依旧使用旧截图服务。

异常处理：原窗口导航或销毁、scope 失效、显示器新增/移除/尺寸变化、渲染进程崩溃均结束截图并恢复窗口。保存期间取消/切换 scope 后不写选中的路径。原始图像及历史只在内存中，关闭清除。

测试：`tests/desktop-screenshot-session.test.ts`、`tests/desktop-screenshot-ipc.test.ts`。真实系统屏幕录制权限和 Windows/混合 DPI 多屏需在目标设备验收。

## Dock 与窗口可见性修正（2026-09-21）
用户确认截图无需隐藏原窗口，现直接捕获当前可见桌面；完成或取消只恢复仍可见窗口的焦点，不主动 show/hide 原窗口。跨工作区覆盖层设置 skipTransformProcessType=true，避免 Electron 默认 macOS 进程类型转换短暂隐藏 Dock。
排查过程：核查 hide/show 与 Dock 调用 → 对照 Electron 本地类型定义和官方文档 → 最小 Electron 窗口实验 → 回归用例先失败再修复。最小实验采样未复现持续消失，因此未把该实验声称为完整用户现场复现；修复移除了显式隐藏窗口和文档明确的进程转换副作用。

## 双屏清晰度修正（2026-09-21）
根因：此前所有屏幕共用最大 thumbnailSize。实测内置屏物理像素 3024×1964，统一请求 3840×2160 后返回 3326×2160，预览再缩回原尺寸，产生额外插值。外屏 3840×2160 无该尺寸差异。NativeImage 实测仅有 scaleFactor=1 表示，默认 PNG 与 getSize 一致，排除多表示选择错误。
排查：读取显示器逻辑尺寸/scaleFactor → 仅输出 getSources 返回 PNG 头尺寸（不存图）→ 对比按屏独立请求 → 双屏回归先失败再修复。按屏分别请求后实际返回 3024×1964 / 3840×2160，与目标一致。相同分辨率屏幕复用一次捕获，所有图像获取后才创建覆盖层。

### 外接屏 Space 切换排查（2026-09-21）

先核对物理屏幕枚举及取图结果（内屏 3024×1964、外屏 3840×2160），确认不是仅采集主屏；再沿 capture → 创建覆盖窗口 → ready → focus 跟踪。普通 BrowserWindow 的 focus 在 Electron 43.2.0 macOS 实现中调用 NSApplication activateIgnoringOtherApps，可能将其他显示器带回 Arkme 窗口所在 Space。退出时 owner.focus 也有同样风险。

macOS 覆盖窗口改为 type: panel，让键盘焦点不激活整个应用；退出时让系统自然恢复焦点，不显式聚焦主窗口。保留所有工作区可见、skipTransformProcessType、不隐藏原窗口和逐屏原生像素采集。依据：https://raw.githubusercontent.com/electron/electron/v43.2.0/shell/browser/native_window_mac.mm 的 NativeWindowMac::Focus。

自动化回归覆盖 panel 配置、编辑器获取焦点、关闭后不激活原窗口；外接屏新建 Space 的真实交互仍需实际复验，不能以 mock 测试代替。

### 双平台窗口吸附（2026-09-21）

- macOS：通过现有 Koffi 调用 CGWindowListCopyWindowInfo/CoreFoundation，读取当前可见窗口矩形和顺序；保留正常及浮动应用窗口，过滤桌面、菜单层、全透明和不可见窗口。原生窗口列表在截图覆盖层创建前读取，不激活目标应用。
- Windows：EnumWindows 获取句柄快照，GW_HWNDPREV 计算前后顺序（带循环/次数限制），过滤隐藏、最小化、cloaked、全透明 layered 和桌面/任务栏窗口；DWM extended frame bounds 获取不含不可见调整边框的物理矩形，失败退到 GetWindowRect。
- 窗口信息只包含矩形，不返回标题/进程名。Windows 用 Electron dipToScreenRect 将显示器边界转为物理坐标，macOS 使用 Quartz 逻辑坐标；每屏分别裁剪并按实际截图尺寸映射像素。跨屏窗口只选择当前屏部分。
- 桥接 context 可选 windows 字段，旧版本缺少字段或原生 API 失败时继续手动框选。悬浮匹配最前方窗口；单击（4 CSS px 内抖动）设为选区，拖动自由框选；选中后可移动/调整/标注。重选回到窗口识别。
- 已验证：macOS 原生窗口边界、重叠顺序、隐藏过滤；真实 Electron 合成画面的原生鼠标悬浮、点击吸附、框选、标注、撤销重做、保存、完成。Windows 适配过滤/排序与几何逻辑通过模拟 API 测试，尚无 Windows 真机验收。
- 客户端可复验：构建后 `electron tests/fixtures/screenshot-window-native.cjs`，同一夹具支持 macOS/Windows，不捕获用户桌面像素。Windows 验收应额外覆盖 100%/125%/150% 双屏、负坐标、cloaked 虚拟桌面及全透明置顶窗口。
- 独立审查发现全透明 Windows 窗口过滤缺口，补 GetLayeredWindowAttributes 和回归后通过。手势复验发现 pointerup 最终坐标会被旧 selection 覆盖，已按实际释放坐标计算并补回归。

### 截图启动延迟排查与优化（2026-09-21）

排查流程：跟踪 capture → 原生窗口列表 → 各屏 getSources → toPNG → 编辑窗口创建/loadURL → context 解码 → ready/show；通过只加计时的原实现副本和同环境改进版本做对照。

根因：逐个取不同尺寸显示器，导致重复全屏采集等待串行叠加；主进程同步编码 PNG；编辑窗口也串行加载；渲染端 Uint8Array.from(atob(...), callback) 对每字节执行 JS 回调。新增的窗口吸附并非主要瓶颈（首次原生库初始化约 28ms，后续枚举约 0.7ms）。一次分段采样的两次 getSources 合计约 459ms，PNG 编码约 196ms。

已改为按尺寸缓存 pending Promise 并发取图（保留各屏原生尺寸、无重采样），所有帧采集完毕才创建覆盖层，再并行加载各编辑器。全部 ready 后才显示，取消/异常依然清理租约。渲染端采用 Chromium Uint8Array.fromBase64；旧版使用预分配数组+循环，保持精确字节，不用有损格式。

验证：同设备双屏3024×1964/3840×2160、同一个独立编辑器 HTTP 页面、真实桌面仅在内存读取且不落盘。旧版本从 invoke 到全部 overlay visible 的3次耗时983/683/657ms，新版576/544/547ms。该夹具隔离宿主业务初始化，不应作为完整客户端每次固定耗时的承诺。另以3MB合成数据验证旧解码87.6ms，原生解码1.3ms且逐字节一致。系统截图、PNG 编码和首次进程初始化仍有成本，尚未实现预热/驻留或原生低延迟渲染路径。

性能修复最终回归：客户端33项、插件79项相关测试通过，两仓类型检查和构建通过。独立审查发现后续窗口初始化同步失败时先前 loadURL 的 rejection 未接管；改为 Promise.all(async map) 并补故障注入回归，已验证无 unhandled rejection。Dev 已更新。

## 全局截图快捷键

`installScreenshotShortcut` 在主窗口初始化时注册设备级快捷键：macOS `Command+Shift+A`，Windows `Control+Shift+A`。优先通知当前聚焦且受信任的会话窗口，否则通知主窗口；插件复用可用会话的截图入口，不强制激活主窗口。未登录或没有可用截图输入框时不会开始截图。

设置保存在 `userData/screenshot-shortcut.json`，通过临时文件重命名写入。注册新组合成功且持久化成功后替换旧组合；失败保留旧值。录入期间暂停注册，关闭弹窗、导航和销毁窗口恢复；退出应用释放注册。只接受可信顶层主窗口/会话窗口 IPC。设置不跨设备同步。

新增验证覆盖默认值、无效组合、占用失败、持久化失败、暂停恢复、来源限制和设置广播。Windows 分支通过自动化测试，仍需 Windows 实机验证系统快捷键占用与多屏行为。
