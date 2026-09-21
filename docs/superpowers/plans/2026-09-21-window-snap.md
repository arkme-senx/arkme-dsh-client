# 双平台截图窗口吸附 Implementation Plan

> 使用 executing-plans 在当前会话完成；用户已确认 UI 原型并明确授权 macOS/Windows 一起实现。沿用现有任务分支，不提交代码。

**Goal:** 悬浮高亮最前方窗口，单击选区，拖动自由框选，复用现有标注工具。
**Architecture:** 客户端在创建覆盖层前读取原生窗口快照，按每块显示器的坐标空间裁剪并映射为截图像素，作为可选 windows 字段随截图上下文返回。插件仅处理像素矩形和指针手势，不调用原生 API。
**Tech Stack:** Electron 43.2.0、现有 Koffi 3.1.5、CoreGraphics/CoreFoundation、Win32/DWM、React。
**Spec:** 用户已确认的本会话低保真图与 Windows/macOS 同步支持要求。

## Constraints and review focus
- 保留原始窗口可见、Dock 图标、macOS panel 不激活应用、原生像素采集。
- 只识别当前可见窗口，不读取窗口标题，不激活或移动窗口。
- 窗口按前后顺序命中；隐藏/最小化/桌面/任务栏/透明窗口不参与。
- 混合 DPI、负坐标、跨屏：按显示器坐标空间分别裁剪，跨屏仅选当前屏部分。
- 原生读取失败或旧客户端缺少窗口字段：仍可手动框选。
- 鼠标轻微抖动仍为点击；超过 4 CSS px 切换自由框选；已有选区编辑不受影响。

## Tasks
- [x] 客户端：新增 screenshot-window-geometry.ts，输入有序矩形和显示器 bounds/图片尺寸，输出裁剪后的像素矩形。先测试负坐标、Retina、混合 DPI、跨屏、非法矩形。
- [x] 客户端：新增 macos-screenshot-windows.ts、windows-screenshot-windows.ts 与 native-screenshot-windows.ts。Mac 使用 CGWindowListCopyWindowInfo + CF 读取；Windows 使用 EnumWindows + 可见/最小化/cloaked/桌面 class 过滤 + DWM bounds。原生失败返回空列表。
- [x] IPC：截图前获取窗口快照，windows 为向后兼容的可选字段。测试租约隔离、逐屏映射和读取失败降级。
- [x] 插件：native-screenshot.ts、ArkmeScreenshotWindow.tsx 传递窗口矩形；screenshot-editor-model.ts 实现有序 hit test。编辑器增加 hover 与 click/drag 分流，复用 selection/onSelect。
- [x] 验证：客户端和插件相关单测/类型检查/构建；Mac 原生枚举和 Electron 渲染/点击/框选烟测；Windows API 适配测试（无 Windows 主机，明确记录真机验收缺口）。
- [x] 更新截图文档与 OpenSpec sidecar，完成代码审查并重启 Dev。

验证记录：客户端 30 项、插件 76 项相关测试通过；两仓类型检查/构建通过；真实 Electron 交互与 macOS 原生枚举通过。Windows 真机验收待执行。独立审查 P2 全透明窗口过滤已修复，另补 pointerup 最终坐标回归。Dev 已重启，未提交/推送。
