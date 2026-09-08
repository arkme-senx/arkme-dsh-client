const testConfig = require("./electron-builder.test-config.cjs");

module.exports = {
  ...testConfig,
  mac: {
    ...(testConfig.mac ?? {}),
    identity: null,
    forceCodeSigning: false,
    notarize: false,
    hardenedRuntime: false
  },
  dmg: {
    ...(testConfig.dmg ?? {}),
    sign: false
  },
  win: {
    ...(testConfig.win ?? {}),
    forceCodeSigning: false,
    signtoolOptions: null
  }
};
