const { build } = require("./package.json");

module.exports = {
  ...build,
  appId: "cc.jiwo.arkme.test",
  productName: "arkme Test",
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
