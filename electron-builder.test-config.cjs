const { build } = require("./package.json");

module.exports = {
  ...build,
  extraMetadata: { ...build.extraMetadata, description: "A secure Electron desktop shell for DeepSeek Harness" },
  appId: "cc.jiwo.arkme.test",
  productName: "arkme Test",
  executableName: "arkme Test",
  nsis: {
    ...build.nsis,
    guid: "aad1fdde-2d32-5c18-bc3f-49489b96645d"
  },
  mac: {
    ...build.mac,
    executableName: "arkme Test",
    icon: "build/icon-test.icns",
    extendInfo: {
      ...(build.mac?.extendInfo ?? {}),
      CFBundleExecutable: "arkme Test",
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
      name: "Arkme Test Extension Share",
      schemes: ["arkme-test"]
    }
  ],
  directories: {
    ...(build.directories ?? {}),
    output: "release-test-dynamic"
  }
};
