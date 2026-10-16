import Foundation

func require(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
let root=URL(fileURLWithPath:CommandLine.arguments[1]).resolvingSymlinksInPath()
let privateText="Authorization: Bearer secret-value\nPath=C:\\Users\\alice\\app.exe\n/Users/alice/Documents/file.txt\nemail alice@example.org\ncomputer: private-pc\nAAAA\\alice\n192.168.3.231\n签名校验失败\n{\"token\":\"json-secret\"}\n/mnt/private-owner/file"
let clean=InstallerDiagnostics.scrub(privateText,limit:12000)
for secret in ["secret-value","alice","private-pc","192.168","json-secret","private-owner"] {require(!clean.contains(secret),"privacy leak: \(secret)")}
require(clean.contains("签名校验失败"),"lost error context")
require(InstallerDiagnostics.scrub(String(repeating:"错",count:10000),limit:128).utf8.count<=128,"byte bound")
var report=InstallerDiagnostic(version:"3.0.12",build:290,stage:"install",result:"failure",error_code:"SIGNATURE_CHECK_FAILED",recovery:"completed",elapsed_ms:2345,details:privateText,log:privateText)
let directory=root.appendingPathComponent("queue")
var calls=0
try InstallerDiagnostics.deliver(report,directory:directory) {data in
 calls+=1
 let text=String(decoding:data,as:UTF8.self)
 require(!text.contains("alice") && !text.contains("secret-value"),"transport received raw log")
 return false
}
require(calls==1,"initial delivery missing")
let stored=try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil)
require(stored.count==1,"network failure lost queue")
let bytes=try Data(contentsOf:stored[0]);require(!String(decoding:bytes,as:UTF8.self).contains("alice"),"queue contains raw log")
report.event_id=UUID().uuidString.replacingOccurrences(of:"-",with:"").lowercased()
try InstallerDiagnostics.deliver(report,directory:directory) {_ in calls+=1;return true}
require(calls==3,"retry must send at most two reports")
require(try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil).isEmpty,"accepted reports not removed")
// A queue path replaced by a link must not write outside its directory.
let link=root.appendingPathComponent("link")
try FileManager.default.createSymbolicLink(at:link,withDestinationURL:directory)
try InstallerDiagnostics.deliver(report,directory:link) {_ in fatalError("followed symbolic queue")}
print("Installer diagnostic privacy and retry fixtures passed")

struct PathFixture: Decodable {let input:String;let keep:[String];let hide:[String]}
let pathFixture=try JSONDecoder().decode(PathFixture.self,from:Data(contentsOf:URL(fileURLWithPath:"tests/fixtures/installer-diagnostics/path-redaction.json")))
let scrubbed=InstallerDiagnostics.scrub(pathFixture.input,limit:12000)
for value in pathFixture.keep {require(scrubbed.contains(value),"lost context: \(value) in \(scrubbed)")}
for value in pathFixture.hide {require(!scrubbed.contains(value),"leaked: \(value)")}
require(InstallerDiagnostics.scrub(scrubbed,limit:12000)==scrubbed,"not idempotent")
