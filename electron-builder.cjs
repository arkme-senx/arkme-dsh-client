const { versionCode } = require("./package.json");

if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || versionCode > 2_147_483_647) {
  throw new Error("package.json versionCode must be a positive int32 integer");
}

module.exports = {
  artifactName: `\${productName}-\${version}-vc${versionCode}-\${arch}.\${ext}`,
};
