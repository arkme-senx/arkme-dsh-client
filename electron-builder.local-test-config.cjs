const { build } = require("./package.json");

const runtimeArchitecture = process.env.ARKME_RUNTIME_ARCH || process.arch;
if (runtimeArchitecture !== "arm64" && runtimeArchitecture !== "x64") {
  throw new Error(`Unsupported local test runtime architecture: ${runtimeArchitecture}`);
}

module.exports = {
  ...build,
  appId: "cc.jiwo.arkme.local-test",
  productName: "arkme Local Test",
  protocols: [
    {
      name: "Arkme Local Test Extension Share",
      schemes: ["arkme-local-test"]
    }
  ],
  extraResources: [
    ...(build.extraResources ?? []),
    {
      from: `.runtime/dsh-${runtimeArchitecture}/node_modules`,
      to: "app.asar.unpacked/node_modules"
    }
  ]
};
