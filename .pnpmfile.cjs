const path = require("node:path");

const runtimeManifest = require(path.join(__dirname, "runtime", "package.json"));
const targetVersion = runtimeManifest.dependencies["@deepseek-ai/dsh"];

function isDshPackage(name) {
  return name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
}

function pinDependencies(dependencies) {
  if (!dependencies) return;
  for (const name of Object.keys(dependencies)) {
    if (isDshPackage(name)) dependencies[name] = targetVersion;
  }
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      pinDependencies(pkg.dependencies);
      pinDependencies(pkg.devDependencies);
      pinDependencies(pkg.optionalDependencies);
      pinDependencies(pkg.peerDependencies);
      return pkg;
    }
  }
};
