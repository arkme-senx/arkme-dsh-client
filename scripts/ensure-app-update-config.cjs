const { writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const { stringify } = require("yaml");

function assertAppUpdateConfig(config) {
  if (config?.provider !== "generic" || typeof config.url !== "string") {
    throw new Error("Packaged app-update.yml must configure a generic update provider");
  }
  const url = new URL(config.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")) {
    throw new Error("Packaged app-update.yml must use an HTTPS directory URL");
  }
  if (typeof config.updaterCacheDirName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.updaterCacheDirName)) {
    throw new Error("Packaged app-update.yml requires a safe updaterCacheDirName");
  }
  return config;
}

async function ensureAppUpdateConfig(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "win32") return;
  // electron-builder skips its own update-config hook for --dir builds. Write
  // the same builder-generated config for every desktop target, BEFORE signing.
  // --prepackaged must only consume an app already carrying this signed file.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { getAppUpdatePublishConfiguration } = builderRequire("app-builder-lib/out/publish/PublishManager.js");
  const config = assertAppUpdateConfig(await getAppUpdatePublishConfiguration(context.packager, null, context.arch, true));
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), "app-update.yml");
  await writeFile(destination, stringify(config), "utf8");
}

module.exports = ensureAppUpdateConfig;
module.exports.assertAppUpdateConfig = assertAppUpdateConfig;
