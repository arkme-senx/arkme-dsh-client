import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.slice(2);
if (mode.length !== 1 || !['--check', '--authenticate', '--build'].includes(mode[0])) {
  throw new Error('Usage: node scripts/device-auth-probe.mjs --check|--authenticate|--build (never pass passwords)');
}
function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`Probe terminated: ${signal}`)) : resolve(code ?? 1));
  });
}
const output = path.join(root, '.runtime', 'device-auth-probe', process.platform);
await mkdir(output, { recursive: true });
let executable;
let buildCode;
if (process.platform === 'darwin') {
  const bundle = path.join(output, '即我解锁验证.app', 'Contents');
  await mkdir(path.join(bundle, 'MacOS'), { recursive: true });
  executable = path.join(bundle, 'MacOS', 'device-auth-probe');
  await writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>cc.jiwo.arkme.device-auth-probe</string>
<key>CFBundleName</key><string>即我解锁验证</string>
<key>CFBundleExecutable</key><string>device-auth-probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
  buildCode = await run('xcrun', ['swiftc', '-warnings-as-errors', path.join(root, 'native/device-auth-probe/macos.swift'),
    '-framework', 'AppKit', '-framework', 'LocalAuthentication', '-framework', 'SystemConfiguration', '-o', executable]);
} else if (process.platform === 'win32') {
  executable = path.join(output, 'device-auth-probe.exe');
  buildCode = await run('cl.exe', ['/nologo', '/EHsc', '/W4', '/WX', '/std:c++17', '/utf-8',
    path.join(root, 'native/device-auth-probe/windows.cpp'), `/Fe:${executable}`,
    '/link', 'Credui.lib', 'Advapi32.lib', 'Secur32.lib', 'Ole32.lib', 'User32.lib'], output);
} else {
  throw new Error('This acceptance probe supports macOS and Windows only');
}
if (buildCode !== 0) process.exit(buildCode);
if (mode[0] === '--build') console.log('Native probe built; no authentication attempted.');
else process.exitCode = await run(executable, [mode[0]]);
