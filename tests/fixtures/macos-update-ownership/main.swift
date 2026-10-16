import Foundation
import Darwin

func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw MigrationError(message) }
}
let fm = FileManager.default
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let owner = ApplicationUpdateOwner(uid: getuid(), gid: getgid())
let other = ApplicationUpdateOwner(uid: 502, gid: 20)
try check(ApplicationUpdateOwner.select(existing: other, console: owner) == other, "preserve existing user")
try check(ApplicationUpdateOwner.select(existing: nil, console: owner) == owner, "use console for root installation")
try check(ApplicationUpdateOwner.select(existing: nil, console: nil) == nil, "headless retains system ownership")
try check(ApplicationUpdateOwner.account(0) == nil, "never select root")
let app = root.appendingPathComponent("Test.app")
let contents = app.appendingPathComponent("Contents")
try fm.createDirectory(at: contents, withIntermediateDirectories: true)
let binary = contents.appendingPathComponent("binary")
try Data("signed bytes".utf8).write(to: binary)
try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: binary.path)
let external = root.appendingPathComponent("external")
try Data("untouched".utf8).write(to: external)
try fm.setAttributes([.posixPermissions: 0o400], ofItemAtPath: external.path)
try fm.createSymbolicLink(at: contents.appendingPathComponent("outside"), withDestinationURL: external)
try fm.createSymbolicLink(at: contents.appendingPathComponent("internal"), withDestinationURL: binary)
for _ in 0..<2 { try owner.apply(to: app) }
try check((try fm.attributesOfItem(atPath: binary.path)[.posixPermissions] as? NSNumber)?.intValue == 0o755, "owner writable, executable preserved")
try check((try fm.attributesOfItem(atPath: external.path)[.posixPermissions] as? NSNumber)?.intValue == 0o400, "external symlink untouched")
try check(try Data(contentsOf: binary) == Data("signed bytes".utf8), "signed content unchanged")
let alias = root.appendingPathComponent("Alias.app")
try fm.createSymbolicLink(at: alias, withDestinationURL: app)
do { try owner.apply(to: alias); throw MigrationError("accepted root symlink") }
catch let e as MigrationError { try check(e.description != "accepted root symlink", "reject root symlink") }
let hardApp = root.appendingPathComponent("Hard.app")
try fm.createDirectory(at: hardApp, withIntermediateDirectories: true)
try fm.linkItem(at: external, to: hardApp.appendingPathComponent("linked"))
do { try owner.apply(to: hardApp); throw MigrationError("accepted hard link") }
catch let e as MigrationError { try check(e.description != "accepted hard link", "reject hard links") }
try check((try fm.attributesOfItem(atPath: external.path)[.posixPermissions] as? NSNumber)?.intValue == 0o400, "hard link target untouched")
print("update ownership scenarios passed")

// A verified old application is reused across preparation, rename and cleanup.
// Changing bytes with the same size and restored mtime must invalidate reuse.
let cachedApp = root.appendingPathComponent("Cached.app")
try fm.createDirectory(at: cachedApp, withIntermediateDirectories: true)
let dataFile = cachedApp.appendingPathComponent("content")
try Data("original".utf8).write(to: dataFile)
let cache = SignatureInspectionCache()
let identity = AppIdentity(bundleID: "com.senqisi.Jotmo", teamID: "TEAM", version: "3.0.5", build: 282, executable: "arkme", appStore: false)
var validations = 0
func verifyCached() -> AppIdentity { validations += 1; return identity }
_ = try cache.inspect(cachedApp, verify: verifyCached)
_ = try cache.inspect(cachedApp, verify: verifyCached)
let backup = root.appendingPathComponent("Cached.backup")
try fm.moveItem(at: cachedApp, to: backup)
_ = try cache.inspect(backup, verify: verifyCached)
try check(validations == 1, "unchanged app and renamed backup must reuse verification")
let movedFile = backup.appendingPathComponent("content")
let originalDate = try fm.attributesOfItem(atPath: movedFile.path)[.modificationDate]!
usleep(10_000)
let handle = try FileHandle(forWritingTo: movedFile)
try handle.write(contentsOf: Data("modified".utf8)); try handle.close()
try fm.setAttributes([.modificationDate: originalDate], ofItemAtPath: movedFile.path)
_ = try cache.inspect(backup, verify: verifyCached)
try check(validations == 2, "same-size in-place change with restored mtime must reverify")
_ = try SignatureInspectionCache().inspect(backup, verify: verifyCached)
try check(validations == 3, "new process/cache must verify again")
try Data("new file".utf8).write(to: backup.appendingPathComponent("added"))
_ = try cache.inspect(backup, verify: verifyCached)
try check(validations == 4, "added file must reverify")
try fm.removeItem(at: backup.appendingPathComponent("added"))
_ = try cache.inspect(backup, verify: verifyCached)
try check(validations == 5, "deleted file must reverify")
let racingCache = SignatureInspectionCache()
do {
    _ = try racingCache.inspect(backup) {
        try Data("race".utf8).write(to: backup.appendingPathComponent("race"))
        return identity
    }
    throw MigrationError("accepted changed application")
} catch let error as MigrationError {
    try check(error.description != "accepted changed application", "mutation during signature check must reject reuse")
}
print("signature reuse scenarios passed")
