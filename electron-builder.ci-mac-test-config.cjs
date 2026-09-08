const testConfig = require("./electron-builder.test-config.cjs");

module.exports = {
  ...testConfig,
  mac: {
    ...(testConfig.mac ?? {}),
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true
  },
  dmg: {
    ...(testConfig.dmg ?? {}),
    sign: true
  },
  artifactBuildCompleted: require("./scripts/notarize-macos-dmg.cjs")
};
