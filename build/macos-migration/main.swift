import Foundation

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
        try engine.recover()
        let candidates = try system.discover(target: configuration.target)
        if CommandLine.arguments[1] == "preflight" {
            try engine.preflight(candidates: candidates)
        } else {
            let payload = root.appendingPathComponent("payload/即我.app")
            try engine.install(payload: payload, candidates: candidates)
            // Registration is ancillary to the committed transaction. No GUI
            // app is launched as root and no user's preferences are rewritten.
            let register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
            for candidate in candidates where candidate != configuration.target {
                _ = try? command(register, ["-u", candidate.path])
            }
            _ = try? command(register, ["-f", configuration.target.path])
            // The installed application is already committed; a leftover
            // staging payload must not report a false rollback-capable failure.
            try? FileManager.default.removeItem(at: payload)
        }
    }
} catch {
    FileHandle.standardError.write(Data("即我安装失败：\(error)\n".utf8))
    exit(1)
}
