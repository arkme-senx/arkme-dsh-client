import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
const localize = createRequire(import.meta.url)("../scripts/localize-macos-bundle.cjs");

describe("signed macOS display-name resources", () => {
  it.each(["darwin", "mas"])("packages Chinese and English names before signing (%s)", async platform => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme brand with spaces "));
    try {
      await localize({ electronPlatformName: platform, appOutDir: root,
        packager: { config: { appId: "cc.jiwo.arkme" }, getResourcesDir: () => root } });
      for (const locale of ["en", "en-US", "zh", "zh-CN", "zh-TW", "zh-Hans", "zh-Hant"]) {
        const text = await readFile(path.join(root, `${locale}.lproj`, "InfoPlist.strings"), "utf8");
        const name = locale.startsWith("zh") ? "即我" : "Arkme";
        expect(text).toBe(`"CFBundleName" = "${name}";\n"CFBundleDisplayName" = "${name}";\n`);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not disguise test bundles as the production app", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme test brand "));
    try {
      await localize({ electronPlatformName: "darwin", appOutDir: root,
        packager: { config: { appId: "cc.jiwo.arkme.test" }, getResourcesDir: () => root } });
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
