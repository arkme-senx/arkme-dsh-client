const path = require('node:path');
const os = require('node:os');
const {mkdtemp, rm} = require('node:fs/promises');
const {runCommand, notarytoolAuthArgs, stapleMacNotarizationTicket,
  validateMacNotarizationTicket} = require('../macos-ci-signing.cjs');

// Mandatory afterSign hook: electron-builder waits for this before ZIP creation.
// Keep notarization explicit so transient CloudKit stapling errors can recover
// without rebuilding or re-signing the application within this source batch.
module.exports = async function notarizeMacApp(context, {env = process.env} = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  if (!['test', 'prod'].includes(env.ARKME_CI_ENV)) throw new Error('CI environment required for app notarization');
  const auth = notarytoolAuthArgs(env);
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  runCommand('codesign', ['--verify', '--deep', '--strict', app], env);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'arkme-app-notarization-'));
  try {
    const archive = path.join(temporary, 'notarization.zip');
    runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], env);
    const submission = JSON.parse(runCommand('xcrun', ['notarytool', 'submit', archive, ...auth,
      '--wait', '--timeout', '20m', '--output-format', 'json'], env, true));
    if (submission.status !== 'Accepted') throw new Error('Application notarization was not accepted');
    console.log('Application notarization Accepted');
    stapleMacNotarizationTicket(app, env);
    validateMacNotarizationTicket(app, env);
    runCommand('codesign', ['--verify', '--deep', '--strict', app], env);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
};
