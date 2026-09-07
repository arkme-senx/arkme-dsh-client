const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { parse } = require("yaml");
const { assertAppUpdateConfig } = require("./ensure-app-update-config.cjs");

// Electron's ASAR-aware require loads the updater AND its dependencies from the
// delivered app, not the workspace. Only the app paths are redirected to a
// disposable profile; no download/install or existing application is touched.
async function verify() {
  const appAsar = process.argv[2];
  if (!appAsar || !path.isAbsolute(appAsar)) throw new Error("Usage: electron scripts/packaged-update-config-smoke.cjs <absolute-app.asar>");
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("Update smoke supports macOS/Windows only");
  const profile = mkdtempSync(path.join(os.tmpdir(), "arkme-updater-smoke-"));
  app.setPath("userData", profile);
  try {
    await app.whenReady();
    const configPath = path.join(path.dirname(appAsar), "app-update.yml");
    const config = assertAppUpdateConfig(parse(await readFile(configPath, "utf8")));
    const manifest = require(path.join(appAsar, "package.json"));
    const { MacUpdater, NsisUpdater } = require(path.join(appAsar, "node_modules/electron-updater"));
    const adapter = {
      version: manifest.version,
      name: manifest.name,
      isPackaged: true,
      appUpdateConfigPath: configPath,
      userDataPath: profile,
      baseCachePath: profile,
      whenReady: () => app.whenReady(),
    };
    const Updater = process.platform === "darwin" ? MacUpdater : NsisUpdater;
    const updater = new Updater({ provider: "generic", url: "https://updates.invalid/verification-only/" }, adapter);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.logger = { info() {}, warn() {}, error() {} };
    const helper = await updater.getOrCreateDownloadHelper();
    assert.equal(helper.cacheDir, path.join(profile, config.updaterCacheDirName));
    if (process.platform === "win32") {
      assert.ok(config.publisherName?.length > 0, "Signed Windows updater requires publisherName");
    }
    console.log(`packaged updater configuration and real download-cache initialization passed: ${manifest.version} / vc${manifest.versionCode}`);
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

verify().then(() => app.exit(0), error => {
  console.error(error.stack || error);
  app.exit(1);
});
