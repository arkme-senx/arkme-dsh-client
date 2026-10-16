import Foundation

func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw MigrationError(message) }
}

func fails(_ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw MigrationError("expected failure")
}

let identityRoot = URL(fileURLWithPath: "/private/tmp/jiwo-signature-fixture-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: identityRoot, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: identityRoot) }

let request = SignatureVerificationRequest(
    nonce: "A9B4D0A9-1D2E-4C4F-A501-9EE302860C9D",
    application: "/Applications/arkme.app",
    identity: try FileIdentity(identityRoot),
    requirement: "=anchor apple generic and certificate leaf[subject.OU] = \"T6NSNA8LDZ\"")
let job = try OneShotSignatureVerification.job(
    request: request,
    helper: URL(fileURLWithPath: "/Library/PrivilegedHelperTools/cc.jiwo.arkme.signature-verifier"),
    requestURL: URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer/signature-request.json"),
    resultURL: URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer/signature-result.json"))
try check(job.label == "cc.jiwo.arkme.signature-verifier.A9B4D0A9-1D2E-4C4F-A501-9EE302860C9D", "job label must include the request nonce")
try check(job.programArguments == ["/Library/PrivilegedHelperTools/cc.jiwo.arkme.signature-verifier", "/Library/Application Support/cc.jiwo.installer/signature-request.json", "/Library/Application Support/cc.jiwo.installer/signature-result.json"], "system service must receive only root-owned request and result paths")

try fails {
    _ = try OneShotSignatureVerification.job(
        request: SignatureVerificationRequest(nonce: "unsafe/nonce", application: request.application, identity: request.identity, requirement: request.requirement),
        helper: URL(fileURLWithPath: "/Library/PrivilegedHelperTools/cc.jiwo.arkme.signature-verifier"),
        requestURL: URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer/signature-request.json"),
        resultURL: URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer/signature-result.json"))
}

print("2 signature verification scenarios passed")

let target = identityRoot.appendingPathComponent("Applications/即我.app")
func bundle(_ relative: String, platform: String = "MacOSX") throws -> URL {
    let url = identityRoot.appendingPathComponent(relative)
    try FileManager.default.createDirectory(at: url.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let data = try PropertyListSerialization.data(fromPropertyList: ["CFBundleSupportedPlatforms": [platform]], format: .xml, options: 0)
    try data.write(to: url.appendingPathComponent("Contents/Info.plist"))
    return url
}
let custom = try bundle("My Apps/即我.app")
try check(MigrationDiscovery.isCandidate(custom, target: target), "custom macOS installation must remain a candidate")
let project = identityRoot.appendingPathComponent("project")
try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
try Data("gitdir: elsewhere".utf8).write(to: project.appendingPathComponent(".git"))
let development = try bundle("project/release/即我.app")
try check(!MigrationDiscovery.isCandidate(development, target: target), "git worktree build must not be migrated")
let ios = try bundle("Mobile/Runner.app", platform: "iPhoneOS")
try check(!MigrationDiscovery.isCandidate(ios, target: target), "iOS bundle must not be migrated")
let derived = try bundle("Library/Developer/Xcode/DerivedData/Runner/Products/即我.app")
try check(!MigrationDiscovery.isCandidate(derived, target: target), "Xcode output must not be migrated")
try check(MigrationDiscovery.isCandidate(target, target: target), "target must never bypass identity validation")
do {
    try command("/bin/sh", ["-c", "echo diagnostic-fixture >&2; exit 3"])
    throw MigrationError("expected command failure")
} catch {
    try check(String(describing: error).contains("diagnostic-fixture"), "command failure must preserve diagnostic output")
}
print("discovery and diagnostic regressions passed")

var requestedExit = false
try fails {
    try GracefulExit.run(confirm: { false }, requestExit: { requestedExit = true }, stopped: { true }, wait: {})
}
try check(!requestedExit, "cancel must not request exit")
var polls = 0
try GracefulExit.run(confirm: { true }, requestExit: { requestedExit = true }, stopped: { polls += 1; return polls >= 3 }, wait: {})
try check(requestedExit && polls == 3, "must wait for normal exit")
try fails { try GracefulExit.run(confirm: { true }, requestExit: {}, stopped: { false }, wait: {}) }
try check(!GracefulExit.message(["即我", "Arkme"]).contains("同步"), "removed reminder must not appear")
print("graceful exit scenarios passed")

let timingStart = MigrationTimer.records.count
let timer = MigrationTimer("fixture-span")
timer.finish()
let timingRecords = Array(MigrationTimer.records.dropFirst(timingStart))
try check(timingRecords.count == 2 && timingRecords[0].contains("event=begin") && timingRecords[1].contains("event=end"), "timing must include span boundaries")
try check(timingRecords.allSatisfy { $0.contains("stage=fixture-span") && $0.contains("elapsed_ms=") && $0.contains("span=") }, "timing must be attributable and have a duration")

let firstStarted = DispatchSemaphore(value: 0)
let secondStarted = DispatchSemaphore(value: 0)
let lock = NSLock()
var active = 0
var peak = 0
let batchURLs = (0..<6).map { URL(fileURLWithPath: "/Applications/fixture-\($0).app") }
let batchIdentity = AppIdentity(bundleID: "com.senqisi.Jotmo", teamID: "TEAM", version: "3.0.0", build: 277, executable: "arkme", appStore: false)
let batch = try ParallelInspection.inspect(batchURLs) { url in
    lock.lock(); active += 1; peak = max(peak, active); lock.unlock()
    defer { lock.lock(); active -= 1; lock.unlock() }
    if url == batchURLs[0] { firstStarted.signal(); try check(secondStarted.wait(timeout: .now() + 2) == .success, "second inspection must run concurrently") }
    if url == batchURLs[1] { secondStarted.signal(); try check(firstStarted.wait(timeout: .now() + 2) == .success, "first inspection must run concurrently") }
    return batchIdentity
}
try check(batch.count == 6 && peak == 2 && active == 0, "inspection concurrency must be limited to two")
var finished = 0
try fails {
    _ = try ParallelInspection.inspect(batchURLs) { url in
        defer { lock.lock(); finished += 1; lock.unlock() }
        if url == batchURLs[1] { throw MigrationError("invalid signature") }
        return batchIdentity
    }
}
try check(finished == 6, "failed batch must drain all inspection jobs before returning")
var exitInspected: [String] = []
let exitPaths = [custom.path, development.path, custom.path]
_ = try ExitVerification.verify(paths: exitPaths, anchor: custom, identity: batchIdentity) { urls in
    exitInspected = urls.map { $0.path }
    return urls.map { _ in batchIdentity }
}
try check(exitInspected == [development.path], "exit verification must reuse the anchor and deduplicate paths")

let testCopy = try bundle("Applications/即我测试服.app")
let testInfo: [String: Any] = ["CFBundleIdentifier": "com.senqisi.Jotmo", "CFBundleDisplayName": "即我测试服"]
try PropertyListSerialization.data(fromPropertyList: testInfo, format: .xml, options: 0)
    .write(to: testCopy.appendingPathComponent("Contents/Info.plist"))
try check(!MigrationDiscovery.isCandidate(testCopy, target: target), "explicit test copy must remain untouched")
try check(MigrationDiscovery.isCandidate(testCopy, target: testCopy), "occupied target must never be excluded")
let namedOnly = try bundle("Other/即我测试服.app")
try check(MigrationDiscovery.isCandidate(namedOnly, target: target), "name alone must not bypass validation")
let unknown = try bundle("Unknown/即我测试服.app")
try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "unknown", "CFBundleDisplayName": "即我测试服"], format: .xml, options: 0)
    .write(to: unknown.appendingPathComponent("Contents/Info.plist"))
try check(MigrationDiscovery.isCandidate(unknown, target: target), "unknown identity must not be silently excluded")
let report = MigrationFailurePresentation.summary(stage: "检查旧应用", outcome: "恢复检查未完成", error: "Application signature verification failed", version: "3.0.1 / 278")
try check(report.contains("SIGNATURE_CHECK_FAILED") && report.contains("恢复检查未完成") && report.contains("3.0.1 / 278"), "failure report must preserve actual outcome and release")
try check(!report.contains("已恢复"), "unknown recovery state must not promise recovery")

// Reproduce the historical package: production plist name/ID, test filename,
// and ad-hoc signature. A normally named ad-hoc app must still be validated.
let adhocCopy = try bundle("Adhoc/即我测试服.app")
try FileManager.default.createDirectory(at: adhocCopy.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
try FileManager.default.copyItem(atPath: "/bin/echo", toPath: adhocCopy.appendingPathComponent("Contents/MacOS/fixture").path)
try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "com.senqisi.Jotmo", "CFBundleName": "即我", "CFBundleExecutable": "fixture", "CFBundlePackageType": "APPL"], format: .xml, options: 0)
    .write(to: adhocCopy.appendingPathComponent("Contents/Info.plist"))
try command("/usr/bin/codesign", ["--force", "--sign", "-", adhocCopy.path])
try check(!MigrationDiscovery.isCandidate(adhocCopy, target: target), "known historical ad-hoc test copy must be excluded")
let adhocProduction = adhocCopy.deletingLastPathComponent().appendingPathComponent("即我.app")
try FileManager.default.moveItem(at: adhocCopy, to: adhocProduction)
try check(MigrationDiscovery.isCandidate(adhocProduction, target: target), "ad-hoc signature alone must not skip a production candidate")
let script = identityRoot.appendingPathComponent("failure.applescript")
try MigrationFailurePresentation.dialogScript.write(to: script, atomically: true, encoding: .utf8)
try command("/usr/bin/osacompile", ["-o", identityRoot.appendingPathComponent("failure.scpt").path, script.path])
