import Foundation
import CryptoKit

let fm = FileManager.default
let suiteRoot = URL(fileURLWithPath: CommandLine.arguments[1])
let oldID = "com.senqisi.Jotmo"
let arkmeID = "com.senx.arkme.harness"
let newID = "cc.jiwo.arkme"

func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw MigrationError(message) }
}

final class FixtureSystem: MigrationSystem {
    var running = false
    var beforeMove: ((URL, URL) throws -> Void)?
    var afterMove: ((URL, URL) throws -> Void)?
    var beforeRemove: ((URL) throws -> Void)?
    var afterJournalWrite: ((Data, URL) throws -> Void)?
    var beforeJournalWrite: ((Data, URL) throws -> Void)?
    var failCopy = false
    func moveBundle(_ source: URL, to target: URL) throws {
        try beforeMove?(source, target)
        try fm.moveItem(at: source, to: target)
        try afterMove?(source, target)
    }
    func removeBundle(_ url: URL) throws {
        try beforeRemove?(url)
        try fm.removeItem(at: url)
    }
    func persistJournal(_ data: Data, at url: URL) throws {
        try beforeJournalWrite?(data, url)
        try data.write(to: url, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try afterJournalWrite?(data, url)
    }
    var failInstalledValidation = false
    var target: URL?
    var capacity: UInt64 = 100_000_000
    var replaceStaging = false
    var afterInspection: ((URL, AppIdentity) throws -> Void)?
    func inspect(_ url: URL) throws -> AppIdentity {
        if failInstalledValidation && url == target { throw MigrationError("installed signature invalid") }
        let identity = try JSONDecoder().decode(AppIdentity.self, from: Data(contentsOf: url.appendingPathComponent("identity.json")))
        try afterInspection?(url, identity)
        return identity
    }
    func copyBundle(_ source: URL, to target: URL) throws {
        if replaceStaging {
            try fm.moveItem(at: target, to: target.appendingPathExtension("moved"))
            try fm.createDirectory(at: target, withIntermediateDirectories: false)
            try Data("DO-NOT-DELETE".utf8).write(to: target.appendingPathComponent("unrelated"))
            throw MigrationError("concurrent staging replacement")
        }
        if failCopy { throw MigrationError("interrupted copy") }
        for file in try fm.contentsOfDirectory(at: source, includingPropertiesForKeys: nil) {
            try fm.copyItem(at: file, to: target.appendingPathComponent(file.lastPathComponent))
        }
    }
    func requireStopped(_ applications: [URL]) throws {
        if running { throw MigrationError("application still running") }
    }
    func freeBytes(at url: URL) throws -> UInt64 { capacity }
}

struct Fixture {
    let root: URL
    let target: URL
    let legacy: URL
    let payload: URL
    let journal: URL
    let system: FixtureSystem
    let configuration: MigrationConfiguration
    init(_ name: String) throws {
        root = suiteRoot.appendingPathComponent(name)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        target = root.appendingPathComponent("Applications/即我.app")
        legacy = root.appendingPathComponent("Custom Apps/arkme.app")
        payload = root.appendingPathComponent("payload/即我.app")
        journal = root.appendingPathComponent("installer/transaction.json")
        system = FixtureSystem()
        configuration = MigrationConfiguration(target: target, journal: journal, teamID: "TEAM", version: "3.0.0", build: 277)
        try app(payload, id: newID, version: "3.0.0", build: 277)
    }
    func app(_ url: URL, id: String, version: String, build: Int, team: String = "TEAM", store: Bool = false) throws {
        try fm.createDirectory(at: url, withIntermediateDirectories: true)
        let identity = AppIdentity(bundleID: id, teamID: team, version: version, build: build, executable: "arkme", appStore: store)
        try JSONEncoder().encode(identity).write(to: url.appendingPathComponent("identity.json"))
        try Data("binary".utf8).write(to: url.appendingPathComponent("program"))
    }
    func engine() -> MacMigration { MacMigration(configuration: configuration, system: system) }
}

func fails(_ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw MigrationError("expected failure")
}

// 1. A real same-name Flutter replacement plus custom-path Arkme retirement.
do {
    let f = try Fixture("both")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    try f.app(f.legacy, id: arkmeID, version: "0.3.0", build: 10)
    let data = f.root.appendingPathComponent("user-data/record.sqlite")
    try fm.createDirectory(at: data.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("UNSYNCED-RECORD".utf8).write(to: data)
    try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy])
    try check(f.system.inspect(f.target).build == 277, "new app missing")
    try check(!fm.fileExists(atPath: f.legacy.path), "old Arkme remains")
    try check(String(contentsOf: data, encoding: .utf8) == "UNSYNCED-RECORD", "old data changed")
    try f.engine().install(payload: f.payload, candidates: [f.target])
    try check(f.system.inspect(f.target).build == 277, "repeat install failed")
}

// 2–5. Never modify an untrusted, store, future-version or running application.
for (name, id, team, version, build, store, running) in [
    ("foreign", "org.example.other", "TEAM", "1.0.0", 1, false, false),
    ("store", oldID, "TEAM", "2.61.40", 276, true, false),
    ("future", newID, "TEAM", "3.1.0", 278, false, false),
    ("running", oldID, "TEAM", "2.61.40", 276, false, true)
] {
    let f = try Fixture(name)
    try f.app(f.target, id: id, version: version, build: build, team: team, store: store)
    let original = try Data(contentsOf: f.target.appendingPathComponent("identity.json"))
    f.system.running = running
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target]) }
    try check(Data(contentsOf: f.target.appendingPathComponent("identity.json")) == original, "rejected app changed")
}

// 6. A bad new signature after switching restores both prior applications.
do {
    let f = try Fixture("rollback")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    try f.app(f.legacy, id: arkmeID, version: "0.3.0", build: 10)
    f.system.target = f.target
    // Fail only once the new program has appeared at target.
    let engine = f.engine()
    try engine.prepare(payload: f.payload, candidates: [f.target, f.legacy])
    f.system.failInstalledValidation = true
    try fails { try engine.commit() }
    f.system.failInstalledValidation = false
    try check(f.system.inspect(f.target).bundleID == oldID, "Flutter not restored")
    try check(f.system.inspect(f.legacy).build == 10, "Arkme not restored")
}

// 7. Recover a power interruption between a journal write and an old-app move.
do {
    let f = try Fixture("interrupted")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    try f.engine().prepare(payload: f.payload, candidates: [f.target])
    let transaction = try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: f.journal))
    try fm.moveItem(atPath: transaction.entries[0].original, toPath: transaction.entries[0].backup)
    try f.engine().recover()
    try check(f.system.inspect(f.target).bundleID == oldID, "interrupted move not restored")
}

// 8. Low disk space is rejected before touching the existing application.
do {
    let f = try Fixture("space")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    f.system.capacity = 0
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target]) }
    try check(f.system.inspect(f.target).bundleID == oldID, "low disk changed old app")
}

// 9. Symlink target cannot redirect privileged writes into user data.
do {
    let f = try Fixture("symlink")
    try f.app(f.legacy, id: oldID, version: "2.61.40", build: 276)
    try fm.createDirectory(at: f.target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.createSymbolicLink(at: f.target, withDestinationURL: f.legacy)
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target]) }
    try check(f.system.inspect(f.legacy).bundleID == oldID, "symlink destination changed")
}

// 10. Target absence does not make an untrusted payload installable.
do {
    let f = try Fixture("payload")
    try fm.removeItem(at: f.payload)
    try f.app(f.payload, id: newID, version: "3.0.0", build: 277, team: "OTHER")
    try fails { try f.engine().install(payload: f.payload, candidates: []) }
    try check(!fm.fileExists(atPath: f.target.path), "untrusted payload installed")
}

// 11. A user replacement after an interrupted install must never be deleted.
do {
    let f = try Fixture("replacement")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    try f.engine().prepare(payload: f.payload, candidates: [f.target])
    let transaction = try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: f.journal))
    try fm.moveItem(atPath: transaction.entries[0].original, toPath: transaction.entries[0].backup)
    try f.app(f.target, id: "org.user.replacement", version: "1.0.0", build: 1)
    try fails { try f.engine().recover() }
    try check(f.system.inspect(f.target).bundleID == "org.user.replacement", "unrelated replacement deleted")
}

// 12. Real fresh install works without a legacy directory.
do {
    let f = try Fixture("fresh")
    try f.engine().install(payload: f.payload, candidates: [])
    try check(f.system.inspect(f.target).bundleID == newID, "fresh install missing")
}
// 13. Preparation failure cannot remove a directory replaced during the copy.
do {
    let f = try Fixture("stage-replacement")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    f.system.replaceStaging = true
    try fails { try f.engine().prepare(payload: f.payload, candidates: [f.target]) }
    let transaction = try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: f.journal))
    let unrelated = URL(fileURLWithPath: transaction.stage).appendingPathComponent("unrelated")
    try check(String(contentsOf: unrelated, encoding: .utf8) == "DO-NOT-DELETE", "replaced staging was deleted")
    try check(f.system.inspect(f.target).bundleID == oldID, "old app changed during staging")
}
// 14. Cleanup failure after durable commit must retain the new app and recovery
// evidence, without falsely reporting an installation failure or deleting unknown files.
do {
    let f = try Fixture("cleanup-failure")
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    var unrelated: URL?
    f.system.afterInspection = { url, identity in
        if url == f.target && identity.bundleID == newID {
            f.system.afterInspection = nil
            let transaction = try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: f.journal))
            let backup = URL(fileURLWithPath: transaction.entries[0].backup)
            try fm.moveItem(at: backup, to: backup.appendingPathExtension("parked"))
            try fm.createDirectory(at: backup, withIntermediateDirectories: false)
            unrelated = backup.appendingPathComponent("unrelated")
            try Data("DO-NOT-DELETE".utf8).write(to: unrelated!)
        }
    }
    try f.engine().install(payload: f.payload, candidates: [f.target])
    f.system.afterInspection = nil
    try check(f.system.inspect(f.target).bundleID == newID, "committed app was rolled back")
    try check(String(contentsOf: unrelated!, encoding: .utf8) == "DO-NOT-DELETE", "cleanup deleted unrelated backup")
    let journal = try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: f.journal))
    try check(journal.committed, "committed recovery evidence was lost")
}


var extraCount = 0
var failures: [String] = []
func scenario(_ name: String, _ body: () throws -> Void) {
    do { try body(); extraCount += 1; print("PASS " + name) }
    catch { failures.append(name + ": " + String(describing: error)); print("FAIL " + failures.last!) }
}
func transaction(_ f: Fixture) throws -> MigrationJournal {
    try JSONDecoder().decode(MigrationJournal.self, from: Data(contentsOf: f.journal))
}
func switched(_ f: Fixture, committed: Bool) throws -> MigrationJournal {
    try f.engine().prepare(payload: f.payload, candidates: [f.target, f.legacy])
    var record = try transaction(f)
    for entry in record.entries { try fm.moveItem(atPath: entry.original, toPath: entry.backup) }
    try fm.moveItem(atPath: record.stage, toPath: record.target)
    record.committed = committed
    try JSONEncoder().encode(record).write(to: f.journal, options: .atomic)
    return record
}
func withOldApps(_ name: String) throws -> Fixture {
    let f = try Fixture(name)
    try f.app(f.target, id: oldID, version: "2.61.40", build: 276)
    try f.app(f.legacy, id: arkmeID, version: "0.3.0", build: 0)
    return f
}

scenario("lowercase Flutter and old Arkme remain accepted sources") {
    let f = try withOldApps("lowercase")
    try f.app(f.target, id: "com.senqisi.jotmo", version: "2.61.40", build: 276)
    try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy])
    try check(f.system.inspect(f.target).bundleID == newID, "new identity not installed")
}
scenario("old Arkme ID cannot be a new release payload") {
    let f = try Fixture("old-payload")
    try f.app(f.payload, id: arkmeID, version: "3.0.0", build: 277)
    try fails { try f.engine().install(payload: f.payload, candidates: []) }
    try check(!fm.fileExists(atPath: f.target.path), "legacy payload accepted")
}
scenario("copy failure recovers synchronously") {
    let f = try withOldApps("copy-fault")
    f.system.failCopy = true
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy]) }
    try check(f.system.inspect(f.target).bundleID == oldID, "old app changed")
    try check(!fm.fileExists(atPath: f.journal.path), "copy failure not cleaned")
}
for phase in ["backup", "replacement", "commit-write"] {
    scenario("synchronous " + phase + " failure restores both apps") {
        let f = try withOldApps("sync-" + phase)
        var injected = false
        f.system.afterMove = { _, target in
            if !injected && ((phase == "backup" && target.pathExtension == "backup") || (phase == "replacement" && target == f.target)) {
                injected = true
                throw MigrationError("interrupted rename")
            }
        }
        f.system.beforeJournalWrite = { data, _ in
            if phase == "commit-write", try JSONDecoder().decode(MigrationJournal.self, from: data).committed {
                throw MigrationError("journal write failed")
            }
        }
        try fails { try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy]) }
        try check(f.system.inspect(f.target).bundleID == oldID, "Flutter not restored")
        try check(f.system.inspect(f.legacy).bundleID == arkmeID, "Arkme not restored")
        try check(!fm.fileExists(atPath: f.journal.path), "completed rollback journal retained")
    }
}
scenario("recovery interrupted during restore can run again") {
    let f = try withOldApps("recovery-interrupted")
    _ = try switched(f, committed: false)
    var injected = false
    f.system.afterMove = { _, _ in
        if !injected { injected = true; throw MigrationError("recovery interrupted") }
    }
    try fails { try f.engine().recover() }
    try check(fm.fileExists(atPath: f.journal.path), "recovery evidence lost")
    f.system.afterMove = nil
    try f.engine().recover()
    try f.engine().recover()
    try check(f.system.inspect(f.target).bundleID == oldID, "Flutter not restored on retry")
    try check(f.system.inspect(f.legacy).bundleID == arkmeID, "Arkme not restored on retry")
}
scenario("committed cleanup interrupted after one delete is repeatable") {
    let f = try withOldApps("cleanup-interrupted")
    var count = 0
    f.system.beforeRemove = { url in
        if url.pathExtension == "backup" { count += 1; if count == 2 { throw MigrationError("cleanup interruption") } }
    }
    try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy])
    try check(try transaction(f).committed, "commit lost during cleanup")
    f.system.beforeRemove = nil
    try f.engine().recover()
    try f.engine().recover()
    try check(f.system.inspect(f.target).bundleID == newID, "committed install rolled back")
}
for phase in [false, true] {
    scenario("all backups validated before " + (phase ? "cleanup" : "rollback")) {
        let f = try withOldApps("unknown-backup-\(phase)")
        let record = try switched(f, committed: phase)
        let first = URL(fileURLWithPath: record.entries[0].backup)
        let second = URL(fileURLWithPath: record.entries[1].backup)
        try fm.moveItem(at: second, to: second.appendingPathExtension("parked"))
        try f.app(second, id: "org.unrelated", version: "1.0.0", build: 1)
        try fails { try f.engine().recover() }
        try check(fm.fileExists(atPath: first.path), "valid backup removed before detecting unknown backup")
        try check(f.system.inspect(f.target).bundleID == newID, "installed app deleted before full validation")
        try check(f.system.inspect(second).bundleID == "org.unrelated", "unknown backup deleted")
        let journalBefore = try Data(contentsOf: f.journal)
        try fails { try f.engine().prepare(payload: f.payload, candidates: []) }
        try check(Data(contentsOf: f.journal) == journalBefore, "unresolved journal overwritten")
    }
}
scenario("unknown committed stage blocks cleanup of every backup") {
    let f = try withOldApps("unknown-committed-stage")
    let record = try switched(f, committed: true)
    let stage = URL(fileURLWithPath: record.stage)
    try f.app(stage, id: "org.unrelated", version: "1.0.0", build: 1)
    try fails { try f.engine().recover() }
    for entry in record.entries { try check(fm.fileExists(atPath: entry.backup), "backup removed before stage validation") }
}
for version in ["3.0.0", "3.1.0"] {
    scenario("committed ZIP replacement at " + version + " permits cleanup") {
        let f = try withOldApps("zip-" + version)
        let record = try switched(f, committed: true)
        try fm.moveItem(at: f.target, to: f.target.appendingPathExtension("zip-old"))
        try f.app(f.target, id: newID, version: version, build: version == "3.0.0" ? 277 : 278)
        try f.engine().recover()
        try check(f.system.inspect(f.target).version == version, "ZIP app replaced")
        for entry in record.entries { try check(!fm.fileExists(atPath: entry.backup), "stale backup retained") }
        try check(!fm.fileExists(atPath: f.journal.path), "committed journal retained")
    }
}
for (name, id, version, build, team) in [
    ("older", newID, "2.9.0", 276, "TEAM"),
    ("wrong-id", arkmeID, "3.1.0", 278, "TEAM"),
    ("wrong-team", newID, "3.1.0", 278, "OTHER")
] {
    scenario("committed " + name + " replacement retains recovery evidence") {
        let f = try withOldApps("committed-" + name)
        let record = try switched(f, committed: true)
        // Same inode is not sufficient proof of a still-valid installed bundle.
        try f.app(f.target, id: id, version: version, build: build, team: team)
        try fails { try f.engine().recover() }
        for entry in record.entries { try check(fm.fileExists(atPath: entry.backup), "backup deleted for invalid target") }
    }
}
scenario("uncommitted external higher install is never overwritten") {
    let f = try withOldApps("external-higher")
    let record = try switched(f, committed: false)
    try fm.moveItem(at: f.target, to: f.target.appendingPathExtension("parked"))
    try f.app(f.target, id: newID, version: "3.2.0", build: 280)
    try fails { try f.engine().recover() }
    try check(f.system.inspect(f.target).build == 280, "external higher installation overwritten")
    for entry in record.entries { try check(fm.fileExists(atPath: entry.backup), "backup lost during conflict") }
}
for committed in [false, true] {
    scenario("different new PKG recovers " + (committed ? "committed" : "uncommitted") + " prior release") {
        let f = try withOldApps("new-pkg-\(committed)")
        let record = try switched(f, committed: committed)
        if committed {
            try fm.moveItem(at: f.target, to: f.target.appendingPathExtension("zip-old"))
            try f.app(f.target, id: newID, version: "3.1.0", build: 278)
        }
        try f.app(f.payload, id: newID, version: "3.2.0", build: 280)
        let config = MigrationConfiguration(target: f.target, journal: f.journal, teamID: "TEAM", version: "3.2.0", build: 280)
        try MacMigration(configuration: config, system: f.system).install(payload: f.payload, candidates: [f.target, f.legacy])
        try check(f.system.inspect(f.target).build == 280, "new PKG failed after prior recovery")
        for entry in record.entries { try check(!fm.fileExists(atPath: entry.backup), "old recovery copy remains") }
    }
}
scenario("data bytes permissions and inode survive repeated upgrade and rejected downgrade") {
    let f = try withOldApps("data-preserved")
    var before: [URL: (Data, Int, UInt64)] = [:]
    for name in ["Library/Application Support/Arkme Harness/state.sqlite", "Library/Application Support/jotmo/unsynced.bin", "Library/Preferences/legacy.plist", "Documents/recording.raw"] {
        let url = f.root.appendingPathComponent(name)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(("private data " + name).utf8).write(to: url)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let attributes = try fm.attributesOfItem(atPath: url.path)
        before[url] = (Data(SHA256.hash(data: try Data(contentsOf: url))), 0o600, (attributes[.systemFileNumber] as! NSNumber).uint64Value)
    }
    for _ in 0..<3 { try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy]) }
    try f.app(f.target, id: newID, version: "3.1.0", build: 278)
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target]) }
    for (url, expected) in before {
        let attributes = try fm.attributesOfItem(atPath: url.path)
        try check(Data(SHA256.hash(data: Data(contentsOf: url))) == expected.0, "data hash changed")
        try check((attributes[.posixPermissions] as! NSNumber).intValue == expected.1, "data permissions changed")
        try check((attributes[.systemFileNumber] as! NSNumber).uint64Value == expected.2, "data inode changed")
    }
}
scenario("uncommitted higher valid app in the same directory is preserved") {
    let f = try withOldApps("same-inode-higher")
    let record = try switched(f, committed: false)
    try f.app(f.target, id: newID, version: "3.3.0", build: 281)
    try fails { try f.engine().recover() }
    try check(f.system.inspect(f.target).build == 281, "higher valid app was overwritten")
    for entry in record.entries { try check(fm.fileExists(atPath: entry.backup), "recovery evidence was removed") }
}
scenario("prepared payload changed in place triggers immediate rollback") {
    let f = try withOldApps("prepared-tamper")
    try f.engine().prepare(payload: f.payload, candidates: [f.target, f.legacy])
    let record = try transaction(f)
    try f.app(URL(fileURLWithPath: record.stage), id: newID, version: "4.0.0", build: 300)
    try fails { try f.engine().commit() }
    try check(f.system.inspect(f.target).bundleID == oldID, "old app changed")
    try check(!fm.fileExists(atPath: record.stage), "failed stage not recovered synchronously")
    try check(!fm.fileExists(atPath: f.journal.path), "rollback incomplete")
}
scenario("backup content changed in place is retained") {
    let f = try withOldApps("backup-content-changed")
    let record = try switched(f, committed: true)
    let backup = URL(fileURLWithPath: record.entries[1].backup)
    try f.app(backup, id: newID, version: "5.0.0", build: 400)
    try fails { try f.engine().recover() }
    for entry in record.entries { try check(fm.fileExists(atPath: entry.backup), "backup deleted before content validation") }
}
scenario("unknown record cannot be overwritten") {
    let f = try withOldApps("unknown-record")
    try f.engine().prepare(payload: f.payload, candidates: [f.target, f.legacy])
    var json = try JSONSerialization.jsonObject(with: Data(contentsOf: f.journal)) as! [String: Any]
    json["schema"] = 999
    let bytes = try JSONSerialization.data(withJSONObject: json)
    try bytes.write(to: f.journal)
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy]) }
    try check(Data(contentsOf: f.journal) == bytes, "unknown record overwritten")
    try check(f.system.inspect(f.target).bundleID == oldID, "unknown record changed app")
}
scenario("partial copy from interruption is removed by inode ownership") {
    let f = try withOldApps("partial-copy")
    try f.engine().prepare(payload: f.payload, candidates: [f.target, f.legacy])
    let record = try transaction(f)
    try fm.removeItem(at: URL(fileURLWithPath: record.stage).appendingPathComponent("identity.json"))
    try f.engine().recover()
    try check(!fm.fileExists(atPath: record.stage), "partial copy remains")
    try check(f.system.inspect(f.target).bundleID == oldID, "old app modified")
}
scenario("exception after persisted commit reports success with recovery evidence") {
    let f = try withOldApps("post-commit-write")
    f.system.afterJournalWrite = { data, _ in
        if try JSONDecoder().decode(MigrationJournal.self, from: data).committed { throw MigrationError("post-write persistence error") }
    }
    try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy])
    try check(f.system.inspect(f.target).bundleID == newID, "committed app rolled back")
    f.system.afterJournalWrite = nil
    try f.engine().recover()
    try check(!fm.fileExists(atPath: f.journal.path), "deferred recovery failed")
}
// Use production fsync/rename/remove implementations in addition to fault tests.
struct DurableFixtureSystem: MigrationSystem {
    let base: FixtureSystem
    func inspect(_ url: URL) throws -> AppIdentity { try base.inspect(url) }
    func copyBundle(_ source: URL, to target: URL) throws { try base.copyBundle(source, to: target) }
    func requireStopped(_ applications: [URL]) throws { try base.requireStopped(applications) }
    func freeBytes(at url: URL) throws -> UInt64 { try base.freeBytes(at: url) }
}
scenario("production durable filesystem operations preserve old apps on rollback") {
    let f = try withOldApps("durable-filesystem")
    let engine = MacMigration(configuration: f.configuration, system: DurableFixtureSystem(base: f.system))
    try engine.prepare(payload: f.payload, candidates: [f.target, f.legacy])
    let attributes = try fm.attributesOfItem(atPath: f.journal.path)
    try check((attributes[.posixPermissions] as! NSNumber).intValue == 0o600, "journal exposes recovery metadata")
    f.system.target = f.target
    f.system.failInstalledValidation = true
    try fails { try engine.commit() }
    f.system.failInstalledValidation = false
    try check(f.system.inspect(f.target).bundleID == oldID, "durable rollback failed")
    try engine.install(payload: f.payload, candidates: [f.target, f.legacy])
    try check(f.system.inspect(f.target).bundleID == newID, "durable install failed")
    try check(!fm.fileExists(atPath: f.journal.path), "durable cleanup failed")
}
scenario("committed partial backup deletion resumes with the same and newer PKG") {
    let f = try withOldApps("partial-backup-deletion")
    var interrupted = false
    f.system.beforeRemove = { url in
        if url.pathExtension == "backup", !interrupted {
            interrupted = true
            try fm.removeItem(at: url.appendingPathComponent("identity.json"))
            throw MigrationError("power lost during recursive cleanup")
        }
    }
    try f.engine().install(payload: f.payload, candidates: [f.target, f.legacy])
    try check(fm.fileExists(atPath: f.journal.path), "cleanup record missing")
    f.system.beforeRemove = nil
    let next = MacMigration(configuration: MigrationConfiguration(target: f.target, journal: f.journal, teamID: "TEAM", version: "3.2.0", build: 300), system: f.system)
    try next.recover()
    try next.recover()
    try check(!fm.fileExists(atPath: f.journal.path), "partial backup cleanup permanently blocked")
    try check(f.system.inspect(f.target).bundleID == newID, "committed target changed")
}
scenario("case aliases deduplicate while symlink candidates are rejected") {
    let f = try Fixture("case-aliases")
    let lower = f.root.appendingPathComponent("Applications/jotmo.app")
    let upper = f.root.appendingPathComponent("Applications/Jotmo.app")
    try f.app(lower, id: oldID, version: "2.61.40", build: 276)
    // On a case-sensitive filesystem these really are separate installations.
    if !fm.fileExists(atPath: upper.path) { try f.app(upper, id: oldID, version: "2.61.40", build: 276) }
    try f.engine().install(payload: f.payload, candidates: [lower, upper])
    try check(!fm.fileExists(atPath: lower.path) && !fm.fileExists(atPath: upper.path), "case aliases not retired")
    let link = f.root.appendingPathComponent("alias.app")
    try fm.createSymbolicLink(at: link, withDestinationURL: f.target)
    try fails { try f.engine().install(payload: f.payload, candidates: [link]) }
    try check(f.system.inspect(f.target).bundleID == newID, "symlink alias changed target")
}
scenario("Flutter build newer than this PKG cannot be retired") {
    let f = try Fixture("flutter-future-build")
    try f.app(f.target, id: oldID, version: "2.61.50", build: 300)
    try fails { try f.engine().install(payload: f.payload, candidates: [f.target]) }
    try check(f.system.inspect(f.target).build == 300, "newer Flutter build replaced")
}
if !failures.isEmpty {
    print("\(failures.count) migration scenarios failed")
    exit(1)
}
print("\(14 + extraCount) migration scenarios passed")

// A same-name target must be inspected once per preflight, even if repeated.
do {
    let f = try Fixture("deduplicated-preflight")
    try f.app(f.target, id: oldID, version: "2.0.0", build: 270)
    var inspections = 0
    f.system.afterInspection = { url, _ in if url.path == f.target.path { inspections += 1 } }
    try f.engine().preflight(candidates: [f.target, f.target])
    try check(inspections == 1, "preflight repeats full inspection of the same target")
}
do {
    let f = try Fixture("preparation-reuses-identity")
    try f.app(f.target, id: oldID, version: "2.0.0", build: 270)
    var inspections = 0
    f.system.afterInspection = { url, _ in if url.path == f.target.path { inspections += 1 } }
    let engine = f.engine()
    try engine.prepare(payload: f.payload, candidates: [f.target])
    try check(inspections == 1, "journal creation repeats preflight inspection")
    try f.app(f.target, id: "org.unrelated", version: "2.0.0", build: 270)
    try fails { try engine.commit() }
    try check(f.system.inspect(f.target).bundleID == "org.unrelated", "commit must reject changed content even with the same directory inode")
}
