import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withMacReleaseLock } from './macos-release-lock.mjs';

export function migrationDistribution(componentName, manifest) {
  const minimumSystemVersion = minimumMacOSVersion(manifest);
  if (!/^[A-Za-z0-9._-]+\.pkg$/.test(componentName)) throw new Error("Unsafe component filename");
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>即我</title>
  <options customize="never" hostArchitectures="arm64,x86_64"/>
  <domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
  <installation-check script="checkSystem()"/>
  <script><![CDATA[
    function checkSystem() {
      if (system.compareVersions(system.version.ProductVersion, '${minimumSystemVersion}') < 0) {
        my.result.type = 'Fatal';
        my.result.message = '即我需要 macOS ${minimumSystemVersion} 或更新版本，原应用和数据未修改。';
        return false;
      }
      return true;
    }
  ]]></script>
  <choices-outline><line choice="migration"/></choices-outline>
  <choice id="migration" visible="false"><pkg-ref id="cc.jiwo.arkme.installer"/></choice>
  <pkg-ref id="cc.jiwo.arkme.installer">${componentName}</pkg-ref>
</installer-gui-script>\n`;
}

export function minimumMacOSVersion(manifest) {
  const value = manifest.build?.mac?.minimumSystemVersion;
  if (typeof value !== "string" || !/^\d{2}\.\d+(?:\.\d+)?$/.test(value) || Number(value.split(".")[0]) < 12) throw new Error("Set a valid minimum macOS version >= 12.0");
  return value;
}

export function assertMigrationRelease(manifest, info, signature) {
  if (manifest.build?.appId !== "cc.jiwo.arkme" || manifest.build?.productName !== "即我"
    || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1
    || info.CFBundleIdentifier !== manifest.build.appId || info.CFBundleName !== "即我"
    || info.CFBundleExecutable !== "arkme" || info.CFBundleShortVersionString !== manifest.version
    || info.CFBundleVersion !== String(manifest.versionCode)
    || info.LSMinimumSystemVersion !== minimumMacOSVersion(manifest)) throw new Error("Migration application identity/version does not match release manifest");
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(signature)?.[1];
  if (!team || !signature.includes("Authority=Developer ID Application:") || /^Signature=adhoc$/m.test(signature)) {
    throw new Error("Migration requires a Developer ID Application signed app");
  }
  return team;
}

export async function publishVerifiedPackage(source, destination) {
  // Keep an earlier output intact until the newly verified bytes are copied.
  // The temporary file is on the destination volume so replacement is atomic.
  const temporary = await mkdtemp(path.join(path.dirname(destination), '.jiwo-pkg-'));
  try {
    const staged = path.join(temporary, 'verified.pkg');
    await copyFile(source, staged);
    await rename(staged, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function stageMigrationPayload(appRoot, work) {
  // The component is rooted at the private installer directory. Never put
  // /Library or /Library/Application Support into the BOM: their permissions
  // belong to macOS, not this package.
  const root = path.join(work, "root");
  await mkdir(root, { mode: 0o700 });
  await mkdir(path.join(root, "payload"), { mode: 0o755 });
  const destination = path.join(root, "payload/即我.app");
  const result = spawnSync("/usr/bin/ditto", ["--rsrc", "--extattr", appRoot, destination], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`Staging signed payload failed: ${result.stderr || result.error?.message}`);
  return root;
}

export async function buildMigrationPackage({ appRoot, outputDirectory }) {
  if (process.platform !== "darwin") throw new Error("Build the migration PKG on macOS");
  const installerIdentity = process.env.JIWO_INSTALLER_IDENTITY?.trim();
  const appIdentity = process.env.CSC_NAME?.trim();
  const notaryProfile = process.env.JIWO_NOTARY_PROFILE?.trim();
  if (!installerIdentity?.startsWith("Developer ID Installer:") || !appIdentity?.startsWith("Developer ID Application:") || !notaryProfile) {
    throw new Error("Set CSC_NAME, JIWO_INSTALLER_IDENTITY and JIWO_NOTARY_PROFILE on the release host");
  }
  function run(tool, args) {
    const result = spawnSync(tool, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`${path.basename(tool)} failed: ${result.stderr || result.error?.message || result.status}`);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appRoot]);
  const info = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(appRoot, "Contents/Info.plist")]));
  const minimumSystemVersion = minimumMacOSVersion(manifest);
  const teamID = assertMigrationRelease(manifest, info, run("/usr/bin/codesign", ["-dv", "--verbose=4", appRoot]));
  run("/usr/bin/lipo", [path.join(appRoot, "Contents/MacOS/arkme"), "-verify_arch", "arm64", "x86_64"]);
  run("/usr/bin/lipo", [path.join(appRoot, "Contents/Frameworks/Electron Framework.framework/Electron Framework"), "-verify_arch", "arm64", "x86_64"]);
  const requirement = `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamID}"`;
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, appRoot]);
  run("/usr/bin/xcrun", ["stapler", "validate", appRoot]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", appRoot]);
  if (!appIdentity.endsWith(`(${teamID})`) || !installerIdentity.endsWith(`(${teamID})`)) throw new Error("App and Installer signing teams must match");
  const work = await mkdtemp(path.join(os.tmpdir(), "jiwo-migration-build-"));
  try {
    const scripts = path.join(work, "scripts");
    await mkdir(scripts);
    // This is the exact already-signed app used by the ZIP build.
    const payload = await stageMigrationPayload(appRoot, work);
    await writeFile(path.join(work, "ReleaseMetadata.swift"), `enum ReleaseMetadata {\nstatic let minimumSystemVersion = ${JSON.stringify(minimumSystemVersion)}\nstatic let appID = ${JSON.stringify(manifest.build.appId)}\nstatic let teamID = ${JSON.stringify(teamID)}\nstatic let version = ${JSON.stringify(manifest.version)}\nstatic let build = ${manifest.versionCode}\n}\n`);
    const binaries = [];
    const verifierBinaries = [];
    for (const architecture of ["arm64", "x86_64"]) {
      const binary = path.join(work, `migration-${architecture}`);
      run("/usr/bin/xcrun", ["swiftc", "-O", "-target", `${architecture}-apple-macos${minimumSystemVersion}`,
        "-module-cache-path", path.join(work, "modules"), "build/macos-migration/Migration.swift", "build/macos-migration/System.swift",
        "build/macos-migration/main.swift", path.join(work, "ReleaseMetadata.swift"), "-o", binary]);
      binaries.push(binary);
      const verifier = path.join(work, `signature-verifier-${architecture}`);
      run("/usr/bin/xcrun", ["swiftc", "-O", "-target", `${architecture}-apple-macos${minimumSystemVersion}`,
        "-module-cache-path", path.join(work, "modules"), "build/macos-migration/Migration.swift", "build/macos-migration/System.swift",
        "build/macos-migration/SignatureVerifierMain.swift", path.join(work, "ReleaseMetadata.swift"), "-o", verifier]);
      verifierBinaries.push(verifier);
    }
    const helper = path.join(scripts, "jiwo-migration");
    run("/usr/bin/lipo", ["-create", ...binaries, "-output", helper]);
    run("/usr/bin/codesign", ["--sign", appIdentity, "--identifier", "cc.jiwo.arkme.installer.helper", "--timestamp", "--options", "runtime", helper]);
    run("/usr/bin/codesign", ["--verify", "--strict", helper]);
    const verifier = path.join(scripts, "jiwo-signature-verifier");
    run("/usr/bin/lipo", ["-create", ...verifierBinaries, "-output", verifier]);
    run("/usr/bin/codesign", ["--sign", appIdentity, "--identifier", "cc.jiwo.arkme.signature-verifier", "--timestamp", "--options", "runtime", verifier]);
    run("/usr/bin/codesign", ["--verify", "--strict", verifier]);
    const verifierPath = "/Library/PrivilegedHelperTools/cc.jiwo.arkme.signature-verifier";
    await writeFile(path.join(scripts, "preinstall"), `#!/bin/sh\nset -eu\n[ "\${3:-/}" = / ] || { echo '只能安装到当前启动磁盘。' >&2; exit 1; }\n/usr/bin/install -d -o root -g wheel -m 755 /Library/PrivilegedHelperTools\n/usr/bin/install -o root -g wheel -m 755 "\${0%/*}/jiwo-signature-verifier" ${verifierPath}\nif ! "\${0%/*}/jiwo-migration" preflight; then\n  /bin/rm -f ${verifierPath}\n  exit 1\nfi\n`, { mode: 0o755 });
    await writeFile(path.join(scripts, "postinstall"), `#!/bin/sh\nset -eu\n[ "\${3:-/}" = / ] || { echo '只能安装到当前启动磁盘。' >&2; exit 1; }\ntrap '/bin/rm -f ${verifierPath}' EXIT\n"\${0%/*}/jiwo-migration" install\n`, { mode: 0o755 });
    const components = path.join(work, "components.plist");
    run("/usr/bin/pkgbuild", ["--analyze", "--root", payload, components]);
    const componentInfo = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", components]));
    for (const component of componentInfo) {
      component.BundleIsRelocatable = false;
      component.BundleIsVersionChecked = false; // helper enforces actual installed app version, staging is ephemeral
      component.BundleHasStrictIdentifier = true;
    }
    await writeFile(components, JSON.stringify(componentInfo));
    run("/usr/bin/plutil", ["-convert", "xml1", components]);
    const componentName = "jiwo-migration-component.pkg";
    run("/usr/bin/pkgbuild", ["--root", payload, "--component-plist", components, "--ownership", "recommended",
      "--scripts", scripts, "--install-location", "/Library/Application Support/cc.jiwo.installer", "--identifier", "cc.jiwo.arkme.installer",
      "--version", manifest.version, path.join(work, componentName)]);
    const distribution = path.join(work, "distribution.xml");
    await writeFile(distribution, migrationDistribution(componentName, manifest));
    await mkdir(outputDirectory, { recursive: true });
    const filename = `即我-${manifest.version}-vc${manifest.versionCode}-universal.pkg`;
    const artifact = path.join(work, filename);
    run("/usr/bin/productbuild", ["--distribution", distribution, "--package-path", work, "--sign", installerIdentity, artifact]);
    const notarization = JSON.parse(run("/usr/bin/xcrun", ["notarytool", "submit", artifact, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"]));
    if (notarization.status !== "Accepted") throw new Error("Migration PKG notarization was not accepted");
    run("/usr/bin/xcrun", ["stapler", "staple", artifact]);
    run("/usr/bin/xcrun", ["stapler", "validate", artifact]);
    run("/usr/sbin/pkgutil", ["--check-signature", artifact]);
    run("/usr/sbin/spctl", ["--assess", "--type", "install", artifact]);
    const destination = path.join(outputDirectory, filename);
    await publishVerifiedPackage(artifact, destination);
    return destination;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = await withMacReleaseLock(path.resolve('release'), () => buildMigrationPackage({
    appRoot: path.resolve(process.argv[2] ?? "release/mac-universal/即我.app"),
    outputDirectory: path.resolve("release"),
  }));
  console.log(`Verified migration PKG: ${artifact}`);
}
