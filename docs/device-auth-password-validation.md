# 电脑密码原生验证

这是设备锁定功能的原生认证验收记录；原生 helper 已接入 Electron 主进程锁定 owner。

## 运行

- macOS：`node scripts/device-auth-probe.mjs --check`；交互验证使用 `--authenticate`。
- Windows：运行相同命令，需要 Node.js 与 Visual Studio C++ Build Tools/Windows SDK；普通终端会通过 vswhere 定位工具链。
- `--build` 只编译，不验证身份。生成物在忽略目录 `.runtime/device-auth-probe/<platform>`。
- 不通过命令参数、环境变量、标准输入或聊天提供密码。只在系统原生凭据窗口输入。

## 判定

`available` 只证明当前环境允许发起验证，`authenticated` 才表示系统验证成功。
Mac 使用 LocalAuthentication 的 deviceOwnerAuthentication；它允许密码回退，但不返回具体使用了密码还是生物识别。验收人员必须选择“使用电脑密码”并记录实际使用路径，不能把任意 authenticated 当作密码路径通过。
Windows 使用 CredUI 收集凭据，随后 LogonUser 验证并比较当前进程用户 SID。CredUI 返回成功本身不能作为解锁依据；其他账号的正确密码也必须拒绝。敏感缓冲区仅在原生进程中存在，并在退出路径清零。

只返回协议版本、平台、验证策略、结果和系统错误码，不返回账号、密码或登录 token。程序没有伪造成功开关，不写入应用登录数据，也不修改系统凭据。

## 必须分开记录的证据

| 平台 | 编译 | 能力探测 | 取消 | 密码成功 | 错误密码 | 其他账号 | 离线 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS | 通过 | available | 通过；cancelled / -2 | 通过；第二次由验收人员确认使用密码 | 待验证 | 系统绑定当前用户 | 待验证 |
| Windows | 通过；MSVC /W4 /WX | 交互桌面 available | 待验证 | 通过；当前用户密码与 SID 匹配 | 待验证 | 待验证 | 待验证 |

错误密码只在可控测试账号进行，不自动反复尝试真实账号，避免触发系统锁定策略。
网络关闭场景需在测试设备或用户手动操作下执行，不擅自断开当前开发机网络。

2026-10-15，本机 macOS 26.6.2 arm64 使用 Xcode Swift 编译通过，`--check` 返回 `available`，首次交互返回 `authenticated`。验收人员确认首次使用指纹或其他方式，因此仅记系统身份验证通过，不记密码路径通过。
同日第二次交互返回 `authenticated`，验收人员明确确认“电脑密码验证通过”，据此记录 Mac 密码成功路径通过。
同日通过原生“取消”按钮结束独立验证，返回 `cancelled`、系统错误码 `-2`、进程退出码 1。

Windows 11 专业工作站版 10.0.26200 x64 上使用现有 C++ Build Tools、Windows SDK 10.0.26100.0 编译通过（`/W4 /WX /std:c++17 /utf-8`）。独立一次性任务在已登录桌面 session 1 执行 `--check`，返回 `available`、任务结果 0；SSH 连接本身不计作交互验证。
同日交互桌面返回 `authenticated`、错误码 0、任务结果 0，验收人员确认“当前用户密码验证通过”。校验包含 LogonUser 与当前用户 SID 匹配。直接从 SSH 非交互会话执行 `--check` 返回 `unavailable`、退出码 1，验证未错误地使用 SSH 会话显示凭据窗口。一次性测试任务已注销，编译产物保留在本次独立临时目录。

## 集成约束

原生验证结果必须由主进程绑定账号、登录会话及当前 lockCycle，并由主进程消费一次；不能允许 renderer 提交 authenticated 布尔值。验证取消、失败或超时保持锁定；账号或锁定轮次改变后丢弃迟到成功。

本程序成功不等于生产验收完成。Electron owner 已接入 helper；Mac universal helper 编译和本地 ad-hoc 签名通过，主进程的认证取消、迟到结果、会话撤销/重锁、重启回执与实际多窗口隐藏/恢复已有测试。锁定使用独立可信原生窗口，业务窗口隐藏，Mac 辅助功能树已现场检查不暴露业务内容。

2026-10-15 合并前复核：192.168.3.114 恢复连接后，在新的临时目录使用普通 SSH 终端调用构建脚本，自动发现 MSVC 并以 /W4 /WX 编译成功；已登录桌面的独立任务再次返回 available。此轮没有再次索取或输入密码。

同轮 Mac 与 Windows 均执行 `tests/fixtures/device-lock-electron.cjs`：业务窗口隐藏、锁定后新建窗口隐藏、敏感标题保护、可信 preload 调用、解锁恢复，以及原有 content protection 保留全部通过。Windows 使用独立用户数据目录和官方 Electron 43.2.0，下载制品与 npm 包内 checksum 一致；一次性任务结果 0，完成后已注销。此项为源码构建的隔离原生窗口验收，仍不等于正式签名安装包验收。

正式签名安装包、错误密码/另一账户/断网的人工矩阵仍待验收。之前密码成功与 Mac 取消的实测记录保留；未将本轮 available 或窗口测试替代密码验证。

## 接口依据

- Apple LocalAuthentication：<https://developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication>
- Windows CredUI：<https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creduipromptforwindowscredentialsa>
- Windows credential packing：<https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credpackauthenticationbufferw>
- Windows LogonUser：<https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-logonuserw>
