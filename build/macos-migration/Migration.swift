import Foundation
import Darwin

/// Durations use a monotonic clock; nested spans must not be added together.
final class MigrationTimer {
    private static let lock = NSLock()
    private static var storage: [String] = []
    static var records: [String] { lock.lock(); defer { lock.unlock() }; return storage }
    private let start = DispatchTime.now().uptimeNanoseconds
    private let stage: String
    private let id = UUID().uuidString
    init(_ stage: String) {
        self.stage = stage
        emit("begin")
    }
    private func emit(_ event: String) {
        let milliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        let line = "[jiwo-timing] pid=\(getpid()) span=\(id) event=\(event) elapsed_ms=\(String(format: "%.3f", milliseconds)) stage=\(stage)"
        Self.lock.lock(); defer { Self.lock.unlock() }
        Self.storage.append(line)
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
    func finish() { emit("end") }
}

struct MigrationError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

struct AppIdentity: Codable, Equatable {
    let bundleID: String
    let teamID: String
    let version: String
    let build: Int
    let executable: String
    let appStore: Bool
}

protocol MigrationSystem {
    func inspect(_ url: URL) throws -> AppIdentity
    func inspectMany(_ urls: [URL]) throws -> [AppIdentity]
    func copyBundle(_ source: URL, to target: URL) throws
    func requireStopped(_ applications: [URL]) throws
    func freeBytes(at url: URL) throws -> UInt64
    func moveBundle(_ source: URL, to target: URL) throws
    func removeBundle(_ url: URL) throws
    func persistJournal(_ data: Data, at url: URL) throws
}

private func persistDirectory(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw MigrationError("Cannot open directory for persistence") }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw MigrationError("Cannot persist directory changes") }
}

extension MigrationSystem {
    func inspectMany(_ urls: [URL]) throws -> [AppIdentity] { try urls.map { try inspect($0) } }
    func moveBundle(_ source: URL, to target: URL) throws {
        let timer = MigrationTimer("move \(source.path) -> \(target.path)"); defer { timer.finish() }
        try FileManager.default.moveItem(at: source, to: target)
        try persistDirectory(source.deletingLastPathComponent())
        if source.deletingLastPathComponent() != target.deletingLastPathComponent() {
            try persistDirectory(target.deletingLastPathComponent())
        }
    }
    func removeBundle(_ url: URL) throws {
        let timer = MigrationTimer("remove \(url.path)"); defer { timer.finish() }
        try FileManager.default.removeItem(at: url)
        try persistDirectory(url.deletingLastPathComponent())
    }
    func persistJournal(_ data: Data, at url: URL) throws {
        let timer = MigrationTimer("persist-journal"); defer { timer.finish() }
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw MigrationError("Cannot open migration journal") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw MigrationError("Cannot persist migration journal") }
        try persistDirectory(url.deletingLastPathComponent())
    }
}

struct MigrationConfiguration {
    let target: URL
    let journal: URL
    let teamID: String
    let version: String
    let build: Int
    let appID: String
    init(target: URL, journal: URL, teamID: String, version: String, build: Int, appID: String = "cc.jiwo.arkme") {
        self.target = target
        self.journal = journal
        self.teamID = teamID
        self.version = version
        self.build = build
        self.appID = appID
    }
}

struct FileIdentity: Codable, Equatable {
    let device: Int32
    let inode: UInt64
    init(_ url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { throw MigrationError("Cannot stat \(url.path)") }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { throw MigrationError("Not a real directory: \(url.path)") }
        device = info.st_dev
        inode = info.st_ino
    }
}

struct MigrationEntry: Codable {
    let original: String
    let backup: String
    let identity: FileIdentity
    let app: AppIdentity
    // Persisted only after full validation of a committed cleanup. Recursive
    // deletion may destroy signature metadata before it removes the directory.
    var cleanupAuthorized: Bool = false
}

func canonicalApplicationPath(_ url: URL) throws -> URL {
    guard url.isFileURL, !url.pathComponents.contains(".."), !url.pathComponents.contains("."), !url.path.contains("\n") else {
        throw MigrationError("Unsafe application path")
    }
    // Resolve filesystem spelling (case/Unicode aliases), but never accept a
    // symlink at the bundle or any ancestor as an installer destination.
    var ancestor = url
    while ancestor.path != "/" {
        var info = stat()
        if lstat(ancestor.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFLNK {
            throw MigrationError("Symlinked application path: \(url.path)")
        }
        ancestor = ancestor.deletingLastPathComponent()
    }
    var existing = url
    var missing: [String] = []
    var info = stat()
    while lstat(existing.path, &info) != 0 {
        guard errno == ENOENT, existing.path != "/" else { throw MigrationError("Cannot canonicalize application path") }
        missing.append(existing.lastPathComponent)
        existing = existing.deletingLastPathComponent()
    }
    guard let resolved = Darwin.realpath(existing.path, nil) else { throw MigrationError("Cannot resolve application spelling") }
    defer { free(resolved) }
    var canonical = URL(fileURLWithPath: String(cString: resolved))
    for component in missing.reversed() { canonical.appendPathComponent(component) }
    return canonical
}

struct MigrationJournal: Codable {
    let schema: Int
    let id: String
    let target: String
    let stage: String
    let payload: AppIdentity
    var stagedIdentity: FileIdentity?
    var committed: Bool
    var entries: [MigrationEntry]
}

/// Owns application bundle transactions only. Never enumerates, imports or
/// removes Application Support, Documents, preferences or credential stores.
final class MacMigration {
    private let configuration: MigrationConfiguration
    private let system: MigrationSystem
    private let files = FileManager.default
    init(configuration: MigrationConfiguration, system: MigrationSystem) {
        self.configuration = configuration
        self.system = system
    }

    private func exists(_ url: URL) -> Bool {
        (try? files.attributesOfItem(atPath: url.path)) != nil
    }

    private func safePath(_ url: URL) throws {
        guard url.isFileURL, url.path.hasPrefix("/"), !url.path.contains("\n"),
              try canonicalApplicationPath(url).path == url.path else {
            throw MigrationError("Unsafe or symlinked application path: \(url.path)")
        }
    }

    private func validateIdentity(_ info: AppIdentity) throws {
        guard info.teamID == configuration.teamID, !info.appStore, info.build >= 0 else {
            throw MigrationError("Untrusted signer, build or App Store application")
        }
        let components = info.version.split(separator: ".", omittingEmptySubsequences: false)
        guard (2...4).contains(components.count), components.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }) else {
            throw MigrationError("Unrecognized application version")
        }
        if [configuration.appID, "com.senx.arkme.harness"].contains(info.bundleID) {
            guard info.executable == "arkme" else { throw MigrationError("Unexpected application executable") }
        } else {
            guard ["com.senqisi.Jotmo", "com.senqisi.jotmo"].contains(info.bundleID), components.first == "2" else {
                throw MigrationError("Unknown legacy application")
            }
        }
    }

    private func inspect(_ app: URL) throws -> AppIdentity {
        try safePath(app)
        _ = try FileIdentity(app)
        let info = try system.inspect(app)
        try validateIdentity(info)
        return info
    }

    private func validate(_ app: URL, payload: Bool) throws -> AppIdentity {
        let info = try inspect(app)
        return try validateVersion(info, payload: payload)
    }

    private func validateVersion(_ info: AppIdentity, payload: Bool) throws -> AppIdentity {
        if payload {
            guard info.bundleID == configuration.appID, info.version == configuration.version,
                  info.build == configuration.build else { throw MigrationError("Payload identity or version mismatch") }
        } else {
            guard info.version.compare(configuration.version, options: .numeric) != .orderedDescending,
                  info.build <= configuration.build else { throw MigrationError("Refusing application downgrade") }
        }
        return info
    }

    private func validateOriginals(_ urls: [URL]) throws -> [AppIdentity] {
        for url in urls { try safePath(url); _ = try FileIdentity(url) }
        let identities = try system.inspectMany(urls)
        guard identities.count == urls.count else { throw MigrationError("Incomplete signature inspection batch") }
        for info in identities { try validateIdentity(info); _ = try validateVersion(info, payload: false) }
        return identities
    }

    private func save(_ journal: MigrationJournal) throws {
        try safePath(configuration.journal)
        try files.createDirectory(at: configuration.journal.deletingLastPathComponent(), withIntermediateDirectories: true,
                                  attributes: [.posixPermissions: 0o700])
        // The record is durable before any existing application can move.
        try system.persistJournal(JSONEncoder().encode(journal), at: configuration.journal)
    }

    private func load() throws -> MigrationJournal? {
        try safePath(configuration.journal)
        guard exists(configuration.journal) else { return nil }
        let journal = try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: configuration.journal))
        guard journal.schema == 1, UUID(uuidString: journal.id) != nil,
              journal.target == configuration.target.path,
              journal.stage == configuration.target.deletingLastPathComponent().appendingPathComponent(".jiwo-\(journal.id)-new.app").path else {
            throw MigrationError("Invalid migration journal; refusing recovery")
        }
        try validateIdentity(journal.payload)
        guard journal.payload.bundleID == configuration.appID, journal.stagedIdentity != nil else {
            throw MigrationError("Invalid recorded payload identity")
        }
        var paths = Set<String>()
        for (index, entry) in journal.entries.enumerated() {
            let original = URL(fileURLWithPath: entry.original)
            try safePath(original)
            guard original.pathExtension == "app", paths.insert(entry.original).inserted,
                  entry.backup == original.deletingLastPathComponent().appendingPathComponent(".jiwo-\(journal.id)-\(index).backup").path else {
                throw MigrationError("Invalid recovery application path")
            }
            try safePath(URL(fileURLWithPath: entry.backup))
            try validateIdentity(entry.app)
            guard journal.committed || !entry.cleanupAuthorized else { throw MigrationError("Uncommitted backup cannot authorize cleanup") }
        }
        return journal
    }

    @discardableResult
    func preflight(candidates: [URL]) throws -> [String: AppIdentity] {
        let timer = MigrationTimer("preflight"); defer { timer.finish() }
        try safePath(configuration.target)
        let paths = try Set((candidates + [configuration.target]).map { try canonicalApplicationPath($0).path })
        var identities: [String: AppIdentity] = [:]
        let existing = paths.sorted().map { URL(fileURLWithPath: $0) }.filter { exists($0) }
        let inspected = try validateOriginals(existing)
        for (url, info) in zip(existing, inspected) { identities[url.path] = info }
        try system.requireStopped(paths.sorted().map { URL(fileURLWithPath: $0) })
        return identities
    }

    func prepare(payload: URL, candidates: [URL]) throws {
        let timer = MigrationTimer("prepare"); defer { timer.finish() }
        try recover()
        let payloadIdentity = try validate(payload, payload: true)
        let canonical = try (candidates + [configuration.target]).map { try canonicalApplicationPath($0).path }
        let unique = Array(Set(canonical)).sorted().map { URL(fileURLWithPath: $0) }
        let verified = try preflight(candidates: unique)
        try files.createDirectory(at: configuration.target.deletingLastPathComponent(), withIntermediateDirectories: true)
        var bytes: UInt64 = 0
        if let entries = files.enumerator(at: payload, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in entries {
                let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                if values.isRegularFile == true { bytes += UInt64(values.fileSize ?? 0) }
            }
        }
        guard try system.freeBytes(at: configuration.target.deletingLastPathComponent()) > bytes + 16 * 1024 * 1024 else {
            throw MigrationError("Insufficient space to stage the new application")
        }
        let id = UUID().uuidString
        let stage = configuration.target.deletingLastPathComponent().appendingPathComponent(".jiwo-\(id)-new.app")
        var journal = MigrationJournal(schema: 1, id: id, target: configuration.target.path, stage: stage.path,
                                       payload: payloadIdentity, stagedIdentity: nil, committed: false, entries: [])
        for candidate in unique where exists(candidate) {
            let backup = candidate.deletingLastPathComponent().appendingPathComponent(".jiwo-\(id)-\(journal.entries.count).backup")
            guard let app = verified[candidate.path] else { throw MigrationError("Application appeared after preflight") }
            // Reuse metadata only within this preparation. Commit always performs
            // a fresh full inspection before moving any old application.
            journal.entries.append(MigrationEntry(original: candidate.path, backup: backup.path, identity: try FileIdentity(candidate), app: app))
        }
        // Record the staging inode before copying. An interrupted copy can be
        // removed safely without trusting a same-name replacement directory.
        try files.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        journal.stagedIdentity = try FileIdentity(stage)
        do {
            try save(journal)
            try system.copyBundle(payload, to: stage)
            _ = try validate(stage, payload: true)
            guard try FileIdentity(stage) == journal.stagedIdentity else { throw MigrationError("Staging directory replaced while copying") }
            try save(journal)
        } catch {
            // No old bundle has moved during preparation. Keep unknown objects
            // and the existing record intact, including a replaced stage.
            if exists(stage) {
                guard let identity = journal.stagedIdentity, (try? FileIdentity(stage)) == identity else {
                    throw MigrationError("Staging directory replaced; preserving it and the recovery journal")
                }
                try system.removeBundle(stage)
            }
            if exists(configuration.journal) { try system.removeBundle(configuration.journal) }
            throw error
        }
    }

    func commit() throws {
        let timer = MigrationTimer("commit"); defer { timer.finish() }
        guard var journal = try load(), let stagedIdentity = journal.stagedIdentity, !journal.committed else {
            throw MigrationError("No prepared migration")
        }
        let stage = URL(fileURLWithPath: journal.stage)
        do {
            guard try FileIdentity(stage) == stagedIdentity else { throw MigrationError("Staged application replaced") }
            _ = try validate(stage, payload: true)
            let applications = journal.entries.map { URL(fileURLWithPath: $0.original) }
            try system.requireStopped(applications + [configuration.target])
            // All recovery destinations are in the source's directory, so each
            // rename remains atomic even for custom paths on another volume.
            let originals = journal.entries.map { URL(fileURLWithPath: $0.original) }
            let inspected = try validateOriginals(originals)
            for (entry, info) in zip(journal.entries, inspected) {
                let original = URL(fileURLWithPath: entry.original)
                try safePath(original)
                guard try FileIdentity(original) == entry.identity else { throw MigrationError("Legacy application changed during install") }
                guard info == entry.app else { throw MigrationError("Original application identity changed") }
                guard !exists(URL(fileURLWithPath: entry.backup)) else { throw MigrationError("Recovery destination occupied") }
            }
            for entry in journal.entries {
                try system.moveBundle(URL(fileURLWithPath: entry.original), to: URL(fileURLWithPath: entry.backup))
            }
            try system.moveBundle(stage, to: configuration.target)
            _ = try validate(configuration.target, payload: true)
            journal.committed = true
            try save(journal)
        } catch {
            // An atomic record write may complete before persistence reports an
            // error. Never promise rollback after the committed record exists.
            if (try? load())?.committed == true {
                FileHandle.standardError.write(Data("即我已安装；提交记录持久化需复核，记录已保留：\(error)\n".utf8))
                return
            }
            do { try recover() } catch let recoveryError {
                throw MigrationError("Installation failed; retry this installer to recover: \(recoveryError)")
            }
            throw error
        }
        // A durable commit has succeeded. Report deferred cleanup separately;
        // claiming installation failure here would promise an impossible rollback.
        do { try recover() } catch {
            FileHandle.standardError.write(Data("即我已安装；临时程序副本未能清理，事务记录已保留：\(error)\n".utf8))
        }
    }

    func install(payload: URL, candidates: [URL]) throws {
        let timer = MigrationTimer("install-total"); defer { timer.finish() }
        try prepare(payload: payload, candidates: candidates)
        try commit()
    }

    private func verifyOriginal(_ url: URL, entry: MigrationEntry) throws {
        guard try FileIdentity(url) == entry.identity, try inspect(url) == entry.app else {
            throw MigrationError("Recorded application changed; recovery copies retained")
        }
    }

    func recover() throws {
        let timer = MigrationTimer("recover"); defer { timer.finish() }
        guard var journal = try load(), let stagedIdentity = journal.stagedIdentity else { return }
        let stage = URL(fileURLWithPath: journal.stage)
        try safePath(configuration.target)
        try safePath(stage)
        // Validate the entire remaining scene before the first destructive step.
        // A partial cleanup/rollback therefore cannot hide an unknown object.
        if exists(stage), try FileIdentity(stage) != stagedIdentity {
            throw MigrationError("Staging directory replaced")
        }
        let installedByThisAttempt = exists(configuration.target) && (try? FileIdentity(configuration.target)) == stagedIdentity
        if journal.committed {
            let current = try inspect(configuration.target)
            guard current.bundleID == journal.payload.bundleID,
                  current.version.compare(journal.payload.version, options: .numeric) != .orderedAscending,
                  current.build >= journal.payload.build else {
                throw MigrationError("Committed application changed; recovery copies retained")
            }
        } else {
            if installedByThisAttempt, let current = try? system.inspect(configuration.target), current != journal.payload {
                throw MigrationError("Uncommitted application content changed; preserving the external installation")
            }
            try system.requireStopped(journal.entries.map { URL(fileURLWithPath: $0.original) } + [configuration.target])
            if exists(configuration.target), !installedByThisAttempt,
               !journal.entries.contains(where: { $0.original == journal.target && (try? FileIdentity(configuration.target)) == $0.identity }) {
                // Even a trusted higher installation belongs to someone else.
                throw MigrationError("Recovery destination occupied; preserving the external installation")
            }
        }
        for entry in journal.entries {
            let original = URL(fileURLWithPath: entry.original)
            let backup = URL(fileURLWithPath: entry.backup)
            if exists(backup) {
                if entry.cleanupAuthorized {
                    guard try FileIdentity(backup) == entry.identity else { throw MigrationError("Cleanup backup replaced; preserving it") }
                } else { try verifyOriginal(backup, entry: entry) }
            }
            if journal.committed {
                if original.path != configuration.target.path, exists(original) {
                    throw MigrationError("Retired application path occupied; recovery copies retained")
                }
            } else if exists(backup) {
                guard !exists(original) || (original.path == configuration.target.path && installedByThisAttempt) else {
                    throw MigrationError("Recovery destination occupied; preserving both applications")
                }
            } else {
                try verifyOriginal(original, entry: entry)
            }
        }
        if journal.committed {
            for index in journal.entries.indices {
                let backup = URL(fileURLWithPath: journal.entries[index].backup)
                if exists(backup) {
                    if !journal.entries[index].cleanupAuthorized {
                        journal.entries[index].cleanupAuthorized = true
                        try save(journal)
                    }
                    try system.removeBundle(backup)
                }
            }
        } else {
            if installedByThisAttempt { try system.removeBundle(configuration.target) }
            for entry in journal.entries.reversed() {
                let backup = URL(fileURLWithPath: entry.backup)
                if exists(backup) { try system.moveBundle(backup, to: URL(fileURLWithPath: entry.original)) }
            }
        }
        if exists(stage) { try system.removeBundle(stage) }
        try system.removeBundle(configuration.journal)
    }
}
