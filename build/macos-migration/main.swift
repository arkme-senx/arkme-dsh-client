import Foundation

let diagnosticStart = DispatchTime.now().uptimeNanoseconds
var installerEngine: MacMigration?
var installerStage = "检查系统及安装权限"

do {
    let timer = MigrationTimer("installer-\(CommandLine.arguments.last ?? "unknown")"); defer { timer.finish() }
    guard CommandLine.arguments.count == 2, ["preflight", "install"].contains(CommandLine.arguments[1]) else {
        throw MigrationError("Expected preflight or install")
    }
    let minimumParts = ReleaseMetadata.minimumSystemVersion.split(separator: ".").compactMap { Int($0) }
    guard (1...3).contains(minimumParts.count) else { throw MigrationError("Invalid minimum system version") }
    let minimum = OperatingSystemVersion(majorVersion: minimumParts[0],
        minorVersion: minimumParts.count > 1 ? minimumParts[1] : 0,
        patchVersion: minimumParts.count > 2 ? minimumParts[2] : 0)
    guard ProcessInfo.processInfo.isOperatingSystemAtLeast(minimum) else {
        throw MigrationError("即我需要 macOS \(ReleaseMetadata.minimumSystemVersion) 或更新版本；原应用未修改。")
    }
    let root = URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer")
    try secureInstallerRoot(root)
    let lock = try MigrationLock(root.appendingPathComponent("migration.lock"))
    try withExtendedLifetime(lock) {
        let configuration = MigrationConfiguration(target: URL(fileURLWithPath: "/Applications/即我.app"),
            journal: root.appendingPathComponent("transaction.json"), teamID: ReleaseMetadata.teamID,
            version: ReleaseMetadata.version, build: ReleaseMetadata.build, appID: ReleaseMetadata.appID)
        let system = NativeMigrationSystem(teamID: ReleaseMetadata.teamID)
        let engine = MacMigration(configuration: configuration, system: system)
        installerEngine = engine
        installerStage = "检查上次安装恢复记录"
        try engine.recover()
        installerStage = "检查旧应用"
        let candidates = try system.discover(target: configuration.target)
        if CommandLine.arguments[1] == "preflight" {
            try engine.preflight(candidates: candidates)
        } else {
            let payload = root.appendingPathComponent("payload/即我.app")
            let updateOwner = ApplicationUpdateOwner.resolve(target: configuration.target)
            installerStage = "安装新应用"
            try engine.install(payload: payload, candidates: candidates)
            // Ownership is ancillary to the committed installation. A failure
            // leaves a valid installed app; native updating may still authorize.
            if let owner = updateOwner {
                do {
                    try owner.apply(to: configuration.target)
                    FileHandle.standardError.write(Data("[jiwo-update] application owner uid=\(owner.uid) gid=\(owner.gid)\n".utf8))
                } catch {
                    FileHandle.standardError.write(Data("[jiwo-update] ownership deferred; updates may require authorization: \(error)\n".utf8))
                }
            } else {
                FileHandle.standardError.write(Data("[jiwo-update] no eligible user; retaining system ownership\n".utf8))
            }
            // Registration is ancillary to the committed transaction. No GUI
            // app is launched as root and no user's preferences are rewritten.
            let register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
            for candidate in engine.migratedCandidates where candidate != configuration.target {
                _ = try? command(register, ["-u", candidate.path])
            }
            _ = try? command(register, ["-f", configuration.target.path])
            // The installed application is already committed; a leftover
            // staging payload must not report a false rollback-capable failure.
            try? FileManager.default.removeItem(at: payload)
        }
    }
    InstallerDiagnostics.complete(version: ReleaseMetadata.version, build: ReleaseMetadata.build,
        stage: CommandLine.arguments[1], result: "success", recovery: "not_needed", details: "",
        elapsed: Int((DispatchTime.now().uptimeNanoseconds - diagnosticStart) / 1_000_000), records: MigrationTimer.records)
} catch {
    let outcome = installerEngine?.recoveryStatus ?? "本次尚未修改原应用"
    let recovery = outcome.contains("未修改") ? "not_needed" : (outcome.contains("已完成恢复") ? "completed" : "unknown")
    InstallerDiagnostics.complete(version: ReleaseMetadata.version, build: ReleaseMetadata.build,
        stage: CommandLine.arguments.last == "preflight" ? "preflight" : "install", result: "failure", recovery: recovery,
        details: "Stage: \(installerEngine?.failureStage ?? installerStage)\nOutcome: \(outcome)\n\(error)",
        elapsed: Int((DispatchTime.now().uptimeNanoseconds - diagnosticStart) / 1_000_000), records: MigrationTimer.records)
    MigrationFailurePresentation.report(
        stage: installerStage == "安装新应用" ? (installerEngine?.failureStage ?? installerStage) : installerStage,
        outcome: installerEngine?.recoveryStatus ?? "本次尚未修改原应用",
        error: error, version: "\(ReleaseMetadata.version) / \(ReleaseMetadata.build)")
    exit(1)
}
