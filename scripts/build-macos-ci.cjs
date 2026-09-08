const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { readFile, readdir, stat } = require("node:fs/promises");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { parse } = require("yaml");
const { withMacCiSigningEnvironment, runCommand, runLoggedCommand, createMacCiLogRedactor } = require("./macos-ci-signing.cjs");

async function verifyMacUpdateMetadata(output) {
  const metadata = parse(await readFile(path.join(output, "latest-mac.yml"), "utf8"));
  assert.equal(metadata.version, require("../package.json").version, "Incorrect update version");
  const names = await readdir(output);
  const artifacts = [];
  for (const extension of [".dmg", ".zip"]) {
    const matches = names.filter(name => name.endsWith(extension));
    assert.equal(matches.length, 1, `Expected one ${extension} artifact`);
    const name = matches[0];
    const file = path.join(output, name);
    const size = (await stat(file)).size;
    assert(size > 0, `Empty artifact: ${name}`);
    const entry = metadata.files?.find(item => decodeURIComponent(item.url) === name);
    assert(entry, `Missing update entry: ${name}`);
    assert.equal(entry.size, size, `Stale update size: ${name}`);
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(entry.sha512, hash.digest("base64"), `Stale update SHA-512: ${name}`);
    const blockmap = JSON.parse(gunzipSync(await readFile(`${file}.blockmap`)).toString());
    const blockmapSize = blockmap.files.reduce((total, item) => total + item.sizes.reduce((sum, value) => sum + value, 0), 0);
    assert.equal(blockmapSize, size, `Stale blockmap size: ${name}`);
    if (decodeURIComponent(metadata.path) === name) {
      assert.equal(metadata.sha512, entry.sha512, `Stale legacy update SHA-512: ${name}`);
    }
    artifacts.push(file);
  }
  assert(artifacts.some(file => path.basename(file) === decodeURIComponent(metadata.path)), "Invalid legacy update path");
  console.log("Verified final macOS installer sizes, update SHA-512 values and blockmaps");
  return artifacts;
}

function verifyApp(app, env) {
  runCommand(process.execPath, ["scripts/verify-macos-signature.mjs", app,
    "--app-id", "cc.jiwo.arkme.test", "--team-id", env.APPLE_TEAM_ID, "--distribution"], env);
  runCommand("xcrun", ["stapler", "validate", app], env);
  runCommand("spctl", ["--assess", "--type", "exec", "--verbose=2", app], env);
}

async function buildMacCi() {
  if (process.platform !== "darwin") throw new Error("Signed macOS CI builds require a macOS runner");
  await withMacCiSigningEnvironment(process.env, async (env, temporaryDirectory) => {
    await runLoggedCommand("pnpm", ["exec", "electron-builder", "--config", "electron-builder.ci-mac-test-config.cjs",
      "--mac", "dmg", "zip", "--universal", "--publish", "never"], env);
    const output = path.resolve("release-test-dynamic");
    verifyApp(path.join(output, "mac-universal", "arkme Test.app"), env);
    const artifacts = await verifyMacUpdateMetadata(output);
    const dmg = artifacts.find(file => file.endsWith(".dmg"));
    runCommand("xcrun", ["stapler", "validate", dmg], env);
    runCommand("codesign", ["--verify", "--strict", dmg], env);
    runCommand("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg], env);
    const zipDirectory = path.join(temporaryDirectory, "zip-validation");
    runCommand("ditto", ["-x", "-k", artifacts.find(file => file.endsWith(".zip")), zipDirectory], env);
    verifyApp(path.join(zipDirectory, "arkme Test.app"), env);
  });
}

module.exports = { verifyMacUpdateMetadata };
if (require.main === module) {
  buildMacCi().catch(error => {
    console.error(createMacCiLogRedactor()(error.message));
    process.exitCode = 1;
  });
}
