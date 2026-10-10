import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
builderRequire("app-builder-lib");
const { AppInfo } = builderRequire("app-builder-lib/out/appInfo.js");
const { MacPackager } = builderRequire("app-builder-lib/out/macPackager.js");
const metadata = require("../package.json");

describe("electron-builder macOS bundle and executable identity", () => {
  test.each([
    ["即我", "arkme", metadata.build],
    ["arkme Test", "arkme Test", require("../electron-builder.test-config.cjs")],
    ["arkme Local Test", "arkme Local Test", require("../electron-builder.local-test-config.cjs")],
  ])("separates the bundle filename from its executable (%s)", async (name, executable, config) => {
    const appInfo = new AppInfo({ metadata, config }, undefined, config.mac);
    expect(appInfo.productFilename).toBe(name);
    const plist: Record<string, unknown> = {};
    await MacPackager.prototype.applyCommonInfo.call({
      appInfo, config, platformSpecificBuildOptions: config.mac,
      getIconPath: async () => null,
    }, plist, "/unused/Contents");
    expect(plist.CFBundleName).toBe(name);
    expect(plist.CFBundleDisplayName).toBe(name);
    expect(plist.CFBundleExecutable).toBe(executable);
  });
});
