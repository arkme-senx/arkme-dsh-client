const { build } = require("./package.json");

const runtimeArchitecture = process.env.ARKME_RUNTIME_ARCH || process.arch;
if (runtimeArchitecture !== "arm64" && runtimeArchitecture !== "x64") {
  throw new Error(`Unsupported local test runtime architecture: ${runtimeArchitecture}`);
}

module.exports = {
  ...build,
  extraMetadata: { ...build.extraMetadata, description: "A secure Electron desktop shell for DeepSeek Harness" },
  appId: "cc.jiwo.arkme.local-test",
  productName: "arkme Local Test",
  executableName: "arkme Local Test",
  nsis: {
    ...build.nsis,
    guid: "30ad6ae1-0db3-53d2-a93b-e75a460f88a2"
  },
  mac: {
    ...build.mac,
    executableName: "arkme Local Test",
    icon: "build/icon-test.icns",
    extendInfo: {
      ...(build.mac?.extendInfo ?? {}),
      CFBundleExecutable: "arkme Local Test",
      NSLocationUsageDescription: "Arkme 仅在你开启位置记录后，将当前位置写入你发送的快记快照。",
      NSLocationWhenInUseUsageDescription: "Arkme 仅在你开启位置记录后，将当前位置写入你发送的快记快照。"
    }
  },
  win: {
    ...build.win,
    icon: "build/icon-test.png"
  },
  linux: {
    ...build.linux,
    icon: "build/icon-test.png"
  },
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
