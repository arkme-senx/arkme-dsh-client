import Foundation
import AppKit
import Darwin
import CoreFoundation

@discardableResult
func command(_ executable: String, _ arguments: [String]) throws -> String {
        let timer = MigrationTimer("command \(URL(fileURLWithPath: executable).lastPathComponent)"); defer { timer.finish() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    // An installer helper must not consume a user's executable search path.
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw MigrationError("\(URL(fileURLWithPath: executable).lastPathComponent) failed (\(process.terminationStatus)): \(String(decoding: bytes, as: UTF8.self).prefix(8192))")
    }
    return String(decoding: bytes, as: UTF8.self)
}

struct SignatureVerificationRequest: Codable {
    let schema: Int
    let nonce: String
    let application: String
    let identity: FileIdentity
    let requirement: String
    var quitApplications: [String]? = nil
    init(nonce: String, application: String, identity: FileIdentity, requirement: String) {
        schema = 1
        self.nonce = nonce
        self.application = application
        self.identity = identity
        self.requirement = requirement
    }
}

struct SignatureVerificationResult: Codable {
    let schema: Int
    let nonce: String
    let identity: FileIdentity
    let application: AppIdentity?
    let error: String?
    var timings: [String]? = nil
}

struct SignatureVerificationJob: Equatable {
    let label: String
    let programArguments: [String]
}

enum OneShotSignatureVerification {
    private static let root = URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer")
    private static let helper = URL(fileURLWithPath: "/Library/PrivilegedHelperTools/cc.jiwo.arkme.signature-verifier")
    private static let labelPrefix = "cc.jiwo.arkme.signature-verifier."

    static func job(request: SignatureVerificationRequest, helper: URL, requestURL: URL, resultURL: URL) throws -> SignatureVerificationJob {
        guard UUID(uuidString: request.nonce) != nil, requestURL.isFileURL, resultURL.isFileURL,
              helper.isFileURL, requestURL.path.hasPrefix(root.path + "/"), resultURL.path.hasPrefix(root.path + "/") else {
            throw MigrationError("Invalid signature verification request")
        }
        return SignatureVerificationJob(label: labelPrefix + request.nonce, programArguments: [helper.path, requestURL.path, resultURL.path])
    }

    private static func persist(_ data: Data, at url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func propertyList(_ job: SignatureVerificationJob) throws -> Data {
        try PropertyListSerialization.data(fromPropertyList: ["Label": job.label, "ProgramArguments": job.programArguments,
                                                               "RunAtLoad": true, "ProcessType": "Background"], format: .xml, options: 0)
    }

    static func inspect(application: URL, requirement: String, quitApplications: [String]? = nil) throws -> AppIdentity {
        let timer = MigrationTimer("signature-service \(application.path)"); defer { timer.finish() }
        let canonical = try canonicalApplicationPath(application)
        guard canonical.path == application.path else { throw MigrationError("Unsafe signature verification path") }
        FileHandle.standardError.write(Data("Verifying application: \(application.path)\n".utf8))
        let identity = try FileIdentity(application)
        var request = SignatureVerificationRequest(nonce: UUID().uuidString, application: application.path, identity: identity,
                                                   requirement: requirement)
        request.quitApplications = quitApplications
        let requestURL = root.appendingPathComponent("signature-\(request.nonce)-request.json")
        let resultURL = root.appendingPathComponent("signature-\(request.nonce)-result.json")
        let jobURL = root.appendingPathComponent("signature-\(request.nonce).plist")
        let job = try job(request: request, helper: helper, requestURL: requestURL, resultURL: resultURL)
        guard FileManager.default.isExecutableFile(atPath: helper.path) else { throw MigrationError("Signature verification helper is unavailable") }
        try persist(JSONEncoder().encode(request), at: requestURL)
        try persist(try propertyList(job), at: jobURL)
        var bootstrapped = false
        defer {
            if bootstrapped { _ = try? command("/bin/launchctl", ["bootout", "system", jobURL.path]) }
            try? FileManager.default.removeItem(at: requestURL)
            try? FileManager.default.removeItem(at: resultURL)
            try? FileManager.default.removeItem(at: jobURL)
        }
        try command("/bin/launchctl", ["bootstrap", "system", jobURL.path])
        bootstrapped = true
        for _ in 0..<(quitApplications == nil ? 300 : 4200) {
            if FileManager.default.fileExists(atPath: resultURL.path) {
                let result = try JSONDecoder().decode(SignatureVerificationResult.self, from: Data(contentsOf: resultURL))
                guard result.schema == 1, result.nonce == request.nonce, result.identity == request.identity else {
                    throw MigrationError("Signature verification response did not match its request")
                }
                guard try FileIdentity(application) == request.identity else { throw MigrationError("Application changed during signature verification") }
                for line in result.timings ?? [] { FileHandle.standardError.write(Data((line + "\n").utf8)) }
                if let error = result.error { throw MigrationError("Application signature verification failed [\(application.path)]: \(error)") }
                guard let info = result.application else { throw MigrationError("Signature verification returned no application identity") }
                return info
            }
            usleep(100_000)
        }
        throw MigrationError("Signature verification service timed out")
    }
}

/// Workers only inspect. All jobs finish before any error is returned, so
/// rollback/cleanup cannot race a still-running verification service.
enum ParallelInspection {
    private final class Results {
        let lock = NSLock()
        var values: [Int: Result<AppIdentity, Error>] = [:]
        func set(_ index: Int, _ value: Result<AppIdentity, Error>) {
            lock.lock(); defer { lock.unlock() }; values[index] = value
        }
    }
    static func inspect(_ urls: [URL], using inspect: @escaping (URL) throws -> AppIdentity) throws -> [AppIdentity] {
        let timer = MigrationTimer("signature-batch count=\(urls.count) limit=2"); defer { timer.finish() }
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 2
        let results = Results()
        for (index, url) in urls.enumerated() {
            queue.addOperation { results.set(index, Result { try inspect(url) }) }
        }
        queue.waitUntilAllOperationsAreFinished()
        return try urls.indices.map { index in
            guard let result = results.values[index] else { throw MigrationError("Missing inspection result") }
            return try result.get()
        }
    }
}

enum ExitVerification {
    static func verify(paths: [String], anchor: URL, identity: AppIdentity,
                       inspect: ([URL]) throws -> [AppIdentity]) throws -> [URL] {
        let urls = try Set(paths).sorted().map { path -> URL in
            let url = URL(fileURLWithPath: path)
            guard try canonicalApplicationPath(url).path == path else { throw MigrationError("Unsafe exit request path") }
            return url
        }
        let others = urls.filter { $0.path != anchor.path }
        let identities = try inspect(others)
        guard identities.count == others.count else { throw MigrationError("Incomplete exit inspection") }
        for app in identities + (urls.contains { $0.path == anchor.path } ? [identity] : []) {
            guard ["com.senqisi.Jotmo", "com.senqisi.jotmo", "com.senx.arkme.harness", "cc.jiwo.arkme"].contains(app.bundleID), !app.appStore else {
                throw MigrationError("Untrusted exit request application")
            }
        }
        return urls
    }
}

enum DirectSignatureInspection {
    static func inspect(_ url: URL, requirement: String) throws -> AppIdentity {
        let timer = MigrationTimer("signature-check \(url.path)"); defer { timer.finish() }
        let files = FileManager.default
        try command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, url.path])
        let output = try command("/usr/bin/codesign", ["-dv", "--verbose=4", url.path])
        func field(_ key: String) -> String? {
            output.split(separator: "\n").first(where: { $0.hasPrefix(key + "=") }).map { String($0.dropFirst(key.count + 1)) }
        }
        guard field("Signature") != "adhoc", let team = field("TeamIdentifier"), team != "not set" else {
            throw MigrationError("Application requires an Apple team signature")
        }
        let infoURL = url.appendingPathComponent("Contents/Info.plist")
        guard let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), format: nil) as? [String: Any],
              let id = info["CFBundleIdentifier"] as? String, id == field("Identifier"),
              let version = info["CFBundleShortVersionString"] as? String,
              let executable = info["CFBundleExecutable"] as? String, !executable.contains("/"), !executable.isEmpty else {
            throw MigrationError("Invalid signed application metadata")
        }
        guard files.isExecutableFile(atPath: url.appendingPathComponent("Contents/MacOS/\(executable)").path) else {
            throw MigrationError("Main executable missing")
        }
        if ["com.senx.arkme.harness", "cc.jiwo.arkme"].contains(id) {
            guard files.fileExists(atPath: url.appendingPathComponent("Contents/Resources/app.asar").path),
                  files.fileExists(atPath: url.appendingPathComponent("Contents/Resources/app-update.yml").path) else {
                throw MigrationError("Incomplete Arkme application")
            }
        }
        let numericBuild = Int(String(describing: info["CFBundleVersion"] ?? ""))
        if id == "cc.jiwo.arkme", numericBuild == nil { throw MigrationError("Invalid release build number") }
        return AppIdentity(bundleID: id, teamID: team, version: version, build: numericBuild ?? 0, executable: executable,
                           appStore: files.fileExists(atPath: url.appendingPathComponent("Contents/_MASReceipt/receipt").path))
    }
}

enum GracefulExit {
    static func message(_ names: [String]) -> String {
        "安装前需要退出以下应用：\n" + names.map { "• " + $0 }.joined(separator: "\n") + "\n\n点击“退出并继续”将请求应用正常退出。"
    }
    static func run(confirm: () throws -> Bool, requestExit: () throws -> Void,
                    stopped: () throws -> Bool, wait: () -> Void) throws {
        let accepted: Bool
        do {
            let timer = MigrationTimer("user-confirmation"); defer { timer.finish() }
            accepted = try confirm()
        }
        guard accepted else { throw MigrationError("已取消安装，未请求应用退出。") }
        let timer = MigrationTimer("normal-exit-wait"); defer { timer.finish() }
        try requestExit()
        for _ in 0..<300 {
            if try stopped() { return }
            wait()
        }
        throw MigrationError("应用未能正常退出，安装已停止。请退出应用后重试。")
    }
    static func running(_ applications: [URL]) -> [NSRunningApplication] {
        let paths = Set(applications.map { $0.standardizedFileURL.path })
        return NSWorkspace.shared.runningApplications.filter {
            guard let url = $0.bundleURL else { return false }
            return paths.contains(url.standardizedFileURL.path) && !$0.isTerminated
        }
    }
    static func request(_ applications: [URL]) throws {
        let apps = running(applications)
        guard !apps.isEmpty else { return }
        let names = Array(Set(apps.map { $0.bundleIdentifier == "com.senx.arkme.harness" ? "Arkme" : "即我" })).sorted()
        try run(confirm: {
            var response: CFOptionFlags = 0
            let status = CFUserNotificationDisplayAlert(300, CFOptionFlags(kCFUserNotificationNoteAlertLevel), nil, nil, nil,
                (names.joined(separator: "和") + " 正在运行") as CFString, message(names) as CFString,
                "取消安装" as CFString, "退出并继续" as CFString, nil, &response)
            guard status == 0 else { throw MigrationError("无法显示退出确认，安装已停止。") }
            return response & 3 == CFOptionFlags(kCFUserNotificationAlternateResponse)
        }, requestExit: {
            for app in apps where !app.isTerminated {
                guard app.terminate() else { throw MigrationError("应用拒绝退出，安装已停止。") }
            }
        }, stopped: {
            if !running(applications).isEmpty { return false }
            let processes = try command("/bin/ps", ["-axo", "comm="])
            return !processes.split(separator: "\n").contains { line in
                let path = String(line).trimmingCharacters(in: .whitespaces)
                return applications.contains { path.hasPrefix($0.path + "/") } || path.contains("/Arkme Harness/")
            }
        }, wait: { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1)) })
    }
}

/// Discovery is not authorization: every retained candidate still requires
/// strict signature and identity validation. Never filter an occupied target.
enum MigrationDiscovery {
    static func isCandidate(_ url: URL, target: URL) -> Bool {
        if url.standardizedFileURL == target.standardizedFileURL { return true }
        let path = url.path
        if path.contains("/Library/Developer/Xcode/DerivedData/") { return false }
        var parent = url.deletingLastPathComponent()
        while parent.path != "/" {
            if FileManager.default.fileExists(atPath: parent.appendingPathComponent(".git").path) { return false }
            parent.deleteLastPathComponent()
        }
        let infoURL = url.appendingPathComponent("Contents/Info.plist")
        // iOS bundles keep their plist at the root, unlike macOS applications.
        if !FileManager.default.fileExists(atPath: infoURL.path),
           FileManager.default.fileExists(atPath: url.appendingPathComponent("Info.plist").path) { return false }
        if let data = try? Data(contentsOf: infoURL),
           let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
           let platforms = info["CFBundleSupportedPlatforms"] as? [String],
           !platforms.isEmpty, !platforms.contains("MacOSX") { return false }
        return true
    }
}

final class NativeMigrationSystem: MigrationSystem {
    private let files = FileManager.default
    private let teamID: String
    init(teamID: String) { self.teamID = teamID }

    func inspect(_ url: URL) throws -> AppIdentity {
        let requirement = "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\""
        return try OneShotSignatureVerification.inspect(application: url, requirement: requirement)
    }

    func inspectMany(_ urls: [URL]) throws -> [AppIdentity] {
        try ParallelInspection.inspect(urls) { try self.inspect($0) }
    }

    func copyBundle(_ source: URL, to target: URL) throws {
        let timer = MigrationTimer("copy-bundle"); defer { timer.finish() }
        try command("/usr/bin/ditto", ["--rsrc", "--extattr", source.path, target.path])
    }

    func requireStopped(_ applications: [URL]) throws {
        let timer = MigrationTimer("require-stopped"); defer { timer.finish() }
        let running = GracefulExit.running(applications)
        if !running.isEmpty, let anchor = applications.first(where: { files.fileExists(atPath: $0.path) }) {
            let requirement = "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\""
            _ = try OneShotSignatureVerification.inspect(application: anchor, requirement: requirement,
                quitApplications: Array(Set(applications.filter { files.fileExists(atPath: $0.path) }.map { $0.path })))
        }

        let processes = try command("/bin/ps", ["-axo", "comm="])
        for line in processes.split(separator: "\n") {
            let name = String(line).trimmingCharacters(in: .whitespaces)
            let executable = URL(fileURLWithPath: name).lastPathComponent
            if ["Jotmo-Kernel", "Jotmo-Kernel-arm64"].contains(executable)
                || applications.contains(where: { name.hasPrefix($0.path + "/") })
                || name.contains("/Arkme Harness/") {
                throw MigrationError("即我或 Arkme 的后台进程仍在运行，请退出后重试。")
            }
        }
    }

    func freeBytes(at url: URL) throws -> UInt64 {
        let attributes = try files.attributesOfFileSystem(forPath: url.path)
        guard let size = attributes[.systemFreeSize] as? NSNumber else { throw MigrationError("Cannot determine free disk space") }
        return size.uint64Value
    }

    func discover(target: URL) throws -> [URL] {
        let timer = MigrationTimer("discover"); defer { timer.finish() }
        var paths = Set([target.path, "/Applications/arkme.app", "/Applications/jotmo.app", "/Applications/Jotmo.app",
                         "/Applications/jotmo笔记.app", "/Applications/Jotmo笔记.app"])
        let ids = ["com.senqisi.Jotmo", "com.senqisi.jotmo", "com.senx.arkme.harness", "cc.jiwo.arkme"]
        for id in ids {
            // LaunchServices finds custom locations even when Spotlight is off.
            NSWorkspace.shared.urlsForApplications(withBundleIdentifier: id).forEach { paths.insert($0.path) }
            // Complement the Installer's root LaunchServices view with the
            // system metadata index, including applications registered by users.
            if let matches = try? command("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == '\(id)'"]) {
                matches.split(separator: "\n").forEach { paths.insert(String($0)) }
            }
        }
        // Only installed application bundles are candidates, never a mounted
        // download image, Trash, this installer's staging, or recovery copies.
        let candidates = paths.sorted().filter {
            files.fileExists(atPath: $0) && !$0.hasPrefix("/Volumes/") && !$0.contains("/.Trash/")
                && !$0.contains("/.jiwo-") && !$0.hasPrefix("/Library/Application Support/cc.jiwo.installer/")
                && $0.hasSuffix(".app")
        }
        let canonical = try Array(Set(candidates.map { try canonicalApplicationPath(URL(fileURLWithPath: $0)).path })).sorted().map { URL(fileURLWithPath: $0) }
        return canonical.filter { url in
            let include = MigrationDiscovery.isCandidate(url, target: target)
            FileHandle.standardError.write(Data("Discovery \(include ? "candidate" : "excluded development/non-macOS copy"): \(url.path)\n".utf8))
            return include
        }
    }
}

/// Installer runs as root. The journal and payload parents must not be links
/// or writable by unprivileged users. No user supplied path is a CLI argument.
func secureInstallerRoot(_ url: URL) throws {
    let files = FileManager.default
    guard getuid() == 0 else { throw MigrationError("Run through the macOS Installer") }
    guard url.resolvingSymlinksInPath().path == url.path else { throw MigrationError("Installer directory is a symbolic link") }
    try files.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let attributes = try files.attributesOfItem(atPath: url.path)
    guard (attributes[.ownerAccountID] as? NSNumber)?.intValue == 0,
          let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o022 == 0 else {
        throw MigrationError("Installer directory has unsafe ownership or permissions")
    }
}

final class MigrationLock {
    private var fd: Int32
    init(_ url: URL) throws {
        fd = open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw MigrationError("Cannot open installer lock") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw MigrationError("Another migration installer is running")
        }
    }
    deinit { flock(fd, LOCK_UN); close(fd) }
}
