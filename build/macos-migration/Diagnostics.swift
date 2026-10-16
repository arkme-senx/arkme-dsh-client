import Foundation
import Darwin

/// Independent of the installation transaction. All callers must use best-effort delivery.
struct InstallerDiagnostic: Codable {
    var os_version: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }()
    var architecture: String = {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }()
    var schema = 1
    var event_id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    var platform = "macos"
    var version: String
    var build: Int
    var stage: String
    var result: String
    var error_code: String
    var recovery: String
    var scope = "system"
    var elapsed_ms: Int
    var details: String
    var log: String

    mutating func sanitize() {
        details = InstallerDiagnostics.scrub(details, limit: 4096)
        log = InstallerDiagnostics.scrub(log, limit: 12000)
    }
    var valid: Bool {
        os_version.range(of: "^\\d{1,5}(?:\\.\\d{1,8}){1,3}$", options: .regularExpression) != nil &&
        ["arm64", "x64"].contains(architecture) && schema == 1 && platform == "macos" && scope == "system" &&
        event_id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil &&
        version.range(of: "^\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}$", options: .regularExpression) != nil &&
        build > 0 && build <= 2147483647 && elapsed_ms >= 0 && elapsed_ms <= 604800000 &&
        ["preflight", "install"].contains(stage) && ["success", "failure", "cancelled"].contains(result) &&
        ["NONE", "INSTALL_FAILED", "SIGNATURE_CHECK_FAILED", "CANCELLED"].contains(error_code) &&
        ["not_needed", "completed", "failed", "unknown"].contains(recovery)
    }
}

private final class DiagnosticHTTPDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private final class DiagnosticHTTPResult: @unchecked Sendable {
    private let lock = NSLock()
    private var accepted = false
    func set(_ value: Bool) { lock.lock(); accepted = value; lock.unlock() }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return accepted }
}

enum InstallerDiagnostics {
    static let endpoint = URL(string: "https://api.jotmo.cc/api/public/v1/arkme/installer-reports")!
    static func scrub(_ text: String, limit: Int) -> String {
        let rules: [(String, String)] = [
            (#"(?i)(?:https?|file)://[^\s<>"\']+"#, #"[REDACTED]"#),
            (#"(?i)\b(Bearer|Basic)\s+[^\s,;"\']+"#, #"$1 [REDACTED]"#),
            (#"(?im)^([ \t]*(?:用户名|计算机|username|hostname|computer|machine|authorization|cookie|set-cookie|RunAs 用户|RunAs User)[ \t]*[:=][ \t]*)[^\r\n]*"#, #"$1[REDACTED]"#),
            (#"(?i)(\b(?:authorization|cookie|password|passwd|token|secret|api[_-]?key|access[_-]?key|access[_-]?secret|用户名|计算机|username|hostname|computer|RunAs 用户|RunAs User)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;\r\n]+)"#, #"$1[REDACTED]"#),
            (#"(?i)((?:[a-z]:)?[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\r\n"<>]+"#, #"$1<user>"#),
            (#"(?i)(/(?:Users|home)/)[^/\r\n"<>]+"#, #"$1<user>"#),
            (#"(?i)(/(?:mnt|media|Volumes)/)[^/\r\n"<>]+"#, #"$1<volume>"#),
            (#"(/var/folders/)[^/\s]+/[^/\s]+"#, #"$1<bucket>/<temp-id>"#),
            (#"\\\\[^\\\s]+\\[^\\\r\n"<>]+"#, #"\\\\<server>\\<share>"#),
            (#"(?m)(^|[ \t=(])[A-Za-z0-9_.\-]+\\[A-Za-z0-9_.\-]+($|[ \t\r\n])"#, #"$1<account>$2"#),
            (#"(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b"#, #"[REDACTED]"#),
            (#"\b(?:\d{1,3}\.){3}\d{1,3}\b"#, #"[REDACTED]"#)
        ]
        var value = text
        for (pattern, replacement) in rules { value = value.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression) }
        value = value.replacingOccurrences(of: #"[\x00-\x08\x0b\x0c\x0e-\x1f]"#, with: "", options: .regularExpression)
        while value.utf8.count > limit { value.removeLast(min(128, value.count)) }
        return value
    }
    static func send(_ data: Data) -> Bool {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.5; config.timeoutIntervalForResource = 1.5
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        let session = URLSession(configuration: config, delegate: DiagnosticHTTPDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"; request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let signal = DispatchSemaphore(value: 0), result = DiagnosticHTTPResult()
        let task = session.dataTask(with: request) { _, response, error in
            result.set(error == nil && (response as? HTTPURLResponse)?.statusCode == 202)
            signal.signal()
        }
        task.resume()
        guard signal.wait(timeout: .now() + 1.5) == .success else { task.cancel(); return false }
        return result.get()
    }
    static func deliver(_ report: InstallerDiagnostic, directory: URL, send: (Data) -> Bool) throws {
        let files = FileManager.default
        guard directory.resolvingSymlinksInPath().path == directory.path else { return }
        try files.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try files.attributesOfItem(atPath: directory.path)
        guard (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid(),
              let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0 else { return }
        var safe = report; safe.sanitize()
        guard safe.valid else { return }
        let data = try JSONEncoder().encode(safe)
        guard data.count <= 32768 else { return }
        let destination = directory.appendingPathComponent(safe.event_id + ".json")
        let fd = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do { try handle.write(contentsOf: data); try handle.synchronize(); try handle.close() }
        catch { try? handle.close(); throw error }
        let items = try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            .filter { $0.lastPathComponent.range(of: "^[a-f0-9]{32}\\.json$", options: .regularExpression) != nil }
            .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for (index, file) in items.enumerated() {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            if index >= 20 || (values.fileSize ?? 32769) > 32768 || (values.contentModificationDate ?? .distantPast) < Date().addingTimeInterval(-604800) {
                try? files.removeItem(at: file); continue
            }
            if index < 2, var queued = try? JSONDecoder().decode(InstallerDiagnostic.self, from: Data(contentsOf: file)), queued.valid,
               file.deletingPathExtension().lastPathComponent == queued.event_id {
                queued.sanitize()
                if let body = try? JSONEncoder().encode(queued), send(body) { try? files.removeItem(at: file) }
            }
        }
    }
    static func complete(version: String, build: Int, stage: String, result: String, recovery: String, details: String, elapsed: Int, records: [String]) {
        let code = result == "success" ? "NONE" : (details.localizedCaseInsensitiveContains("cancel") || details.contains("取消") ? "CANCELLED" : (details.localizedCaseInsensitiveContains("signature") || details.contains("签名") ? "SIGNATURE_CHECK_FAILED" : "INSTALL_FAILED"))
        let report = InstallerDiagnostic(version: version, build: build, stage: stage,
            result: code == "CANCELLED" ? "cancelled" : result, error_code: code, recovery: recovery,
            elapsed_ms: elapsed, details: details, log: details + "\n" + records.suffix(80).joined(separator: "\n"))
        // No diagnostic failure can change the installer's completion or rollback result.
        try? deliver(report, directory: URL(fileURLWithPath: "/Library/Application Support/cc.jiwo.installer/reports"), send: send)
    }
}
