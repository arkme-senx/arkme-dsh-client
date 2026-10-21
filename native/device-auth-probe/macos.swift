import AppKit
import Foundation
import LocalAuthentication
import SystemConfiguration

// This helper is invoked exclusively by the desktop main-process owner.
// Passwords are entered exclusively into Apple's authentication UI.
// A successful owner-policy result does not identify the authentication method;
// password-path acceptance additionally requires the tester to select Password.
func finish(_ outcome: String, _ code: Int = 0) -> Never {
    let result: [String: Any] = [
        "schemaVersion": 1, "platform": "darwin",
        "strategy": "system-owner-policy", "outcome": outcome, "code": code
    ]
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(outcome == "authenticated" || outcome == "available" ? 0 : 1)
}

let mode = CommandLine.arguments.dropFirst()
guard mode.count == 1, mode.first == "--check" || mode.first == "--authenticate" else {
    finish("invalid-request")
}
var consoleUID: uid_t = 0
var consoleGID: gid_t = 0
guard SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID) != nil,
      getuid() > 0, getuid() == geteuid(), consoleUID == getuid() else {
    finish("unavailable")
}

let context = LAContext()
context.localizedCancelTitle = "取消"
context.localizedFallbackTitle = "使用电脑密码"
context.touchIDAuthenticationAllowableReuseDuration = 0
var capabilityError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &capabilityError) else {
    finish("unavailable", capabilityError?.code ?? 0)
}
if mode.first == "--check" { finish("available") }

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
DispatchQueue.main.async {
    application.activate(ignoringOtherApps: true)
    context.evaluatePolicy(.deviceOwnerAuthentication,
                          localizedReason: "验证电脑登录身份，以解锁即我。") { success, error in
        DispatchQueue.main.async {
            if success { finish("authenticated") }
            let code = (error as NSError?)?.code ?? 0
            if [LAError.userCancel.rawValue, LAError.appCancel.rawValue,
                LAError.systemCancel.rawValue].contains(code) {
                finish("cancelled", code)
            }
            finish("failed", code)
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
        context.invalidate()
        finish("timed-out")
    }
}
application.run()
