import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist', 'device-auth');
const temporary = path.join(root, '.runtime', 'device-auth-build');
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Native device authentication build failed: ${command}`);
}
if (process.platform === 'darwin') {
  const contents = path.join(output, '即我解锁验证.app', 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  const architectures = ['arm64', 'x86_64'];
  for (const architecture of architectures) {
    run('xcrun', ['swiftc', '-warnings-as-errors', '-target', `${architecture}-apple-macosx12.0`,
      path.join(root, 'native/device-auth-probe/macos.swift'), '-framework', 'AppKit', '-framework', 'LocalAuthentication',
      '-framework', 'SystemConfiguration', '-o', path.join(temporary, architecture)]);
  }
  run('lipo', ['-create', ...architectures.map(architecture => path.join(temporary, architecture)), '-output', path.join(contents, 'MacOS', 'device-auth-probe')]);
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cc.jiwo.arkme.device-auth</string>
<key>CFBundleName</key><string>即我解锁验证</string><key>CFBundleExecutable</key><string>device-auth-probe</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>\n`);
  // Local execution uses an ad-hoc signature; release packaging re-signs this
  // nested app with the release identity and includes it in signature checks.
  run('codesign', ['--force', '--sign', '-', path.dirname(contents)]);
} else if (process.platform === 'win32') {
  const args = ['/nologo', '/EHsc', '/W4', '/WX', '/std:c++17', '/utf-8',
    path.join(root, 'native/device-auth-probe/windows.cpp'), `/Fe:${path.join(output, 'device-auth-probe.exe')}`,
    '/link', 'Credui.lib', 'Advapi32.lib', 'Secur32.lib', 'Ole32.lib', 'User32.lib'];
  if (spawnSync('where.exe', ['cl.exe'], { stdio: 'ignore' }).status === 0) {
    run('cl.exe', args, temporary);
  } else {
    const finder = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!existsSync(finder)) throw new Error('Visual Studio C++ Build Tools are required for Windows device authentication');
    const found = spawnSync(finder, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
    const installation = found.stdout?.trim();
    if (found.status !== 0 || !installation) throw new Error('Visual Studio x64 compiler was not found');
    const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    // Only tool-generated local paths enter this batch; fail on shell expansion.
    const quote = value => { if (/["%!?^&|<>\r\n]/u.test(value)) throw new Error('Unsupported native build path'); return `"${value}"`; };
    const batch = path.join(temporary, 'build-native.cmd');
    await writeFile(batch, `@echo off\r\nsetlocal DisableDelayedExpansion\r\ncall ${quote(vcvars)} >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe ${args.map(quote).join(' ')}\r\nexit /b %errorlevel%\r\n`);
    run('cmd.exe', ['/d', '/c', batch], temporary);
  }
}
