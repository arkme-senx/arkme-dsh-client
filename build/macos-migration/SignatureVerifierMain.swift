import Foundation
import Darwin

func writeSignatureResult(_ result: SignatureVerificationResult, to url: URL) throws {
    var result = result
    result.timings = MigrationTimer.records
    try JSONEncoder().encode(result).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

@main
struct SignatureVerifierMain {
    static func main() {
        do {
            guard CommandLine.arguments.count == 3 else {
                throw MigrationError("Expected signature request and result paths")
            }
            let requestURL = URL(fileURLWithPath: CommandLine.arguments[1])
            let resultURL = URL(fileURLWithPath: CommandLine.arguments[2])
            let root = "/Library/Application Support/cc.jiwo.installer/"
            guard getuid() == 0, requestURL.path.hasPrefix(root), resultURL.path.hasPrefix(root),
                  requestURL.path.hasSuffix("-request.json"), resultURL.path.hasSuffix("-result.json") else {
                throw MigrationError("Unsafe signature verification paths")
            }
            let request = try JSONDecoder().decode(SignatureVerificationRequest.self, from: Data(contentsOf: requestURL))
            guard request.schema == 1, UUID(uuidString: request.nonce) != nil,
                  requestURL.lastPathComponent == "signature-\(request.nonce)-request.json",
                  resultURL.lastPathComponent == "signature-\(request.nonce)-result.json" else {
                throw MigrationError("Invalid signature verification request")
            }
            do {
                let application = URL(fileURLWithPath: request.application)
                guard try canonicalApplicationPath(application).path == application.path,
                      try FileIdentity(application) == request.identity else {
                    throw MigrationError("Application changed before signature verification")
                }
                let info = try DirectSignatureInspection.inspect(application, requirement: request.requirement)
                if let paths = request.quitApplications {
                    let applications = try ExitVerification.verify(paths: paths, anchor: application, identity: info) { urls in
                        try ParallelInspection.inspect(urls) { try DirectSignatureInspection.inspect($0, requirement: request.requirement) }
                    }
                    guard try FileIdentity(application) == request.identity else { throw MigrationError("Application changed before exit request") }
                    try GracefulExit.request(applications)
                }
                try writeSignatureResult(SignatureVerificationResult(schema: 1, nonce: request.nonce, identity: request.identity,
                                                                     application: info, error: nil), to: resultURL)
            } catch {
                try writeSignatureResult(SignatureVerificationResult(schema: 1, nonce: request.nonce, identity: request.identity,
                                                                     application: nil, error: String(describing: error)), to: resultURL)
            }
        } catch {
            FileHandle.standardError.write(Data("即我签名校验服务失败：\(error)\n".utf8))
            exit(1)
        }
}
}
