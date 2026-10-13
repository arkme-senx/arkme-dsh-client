const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

/** Bundle display names are signed resources; never rewrite an installed app. */
async function localizeMacosBundle(context) {
  if (!["darwin", "mas"].includes(context.electronPlatformName) || context.packager.config.appId !== "cc.jiwo.arkme") return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  for (const [locale, name] of Object.entries({
    en: "Arkme", "en-US": "Arkme",
    zh: "即我", "zh-CN": "即我", "zh-TW": "即我", "zh-Hans": "即我", "zh-Hant": "即我"
  })) {
    const directory = path.join(resources, `${locale}.lproj`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "InfoPlist.strings"),
      `"CFBundleName" = "${name}";\n"CFBundleDisplayName" = "${name}";\n`, "utf8");
  }
}

module.exports = localizeMacosBundle;
