const { createRequire } = require("node:module");
const { runCommand, notarytoolAuthArgs, createMacCiLogRedactor } = require("./macos-ci-signing.cjs");

module.exports = async function notarizeMacDmg(event) {
  if (!event.file.endsWith(".dmg")) return;
  const redact = createMacCiLogRedactor();
  const auth = notarytoolAuthArgs(process.env);
  runCommand("codesign", ["--verify", "--strict", event.file]);
  const submission = JSON.parse(runCommand("xcrun", [
    "notarytool", "submit", event.file, ...auth, "--wait", "--timeout", "20m", "--output-format", "json"
  ], process.env, true));
  console.log(redact(`DMG notarization ${submission.id || "unknown"}: ${submission.status || "unknown"}`));
  if (submission.status !== "Accepted") {
    if (submission.id) {
      try {
        const log = JSON.parse(runCommand("xcrun", ["notarytool", "log", submission.id, ...auth], process.env, true));
        for (const issue of log.issues || []) console.error(redact(`${issue.path || "DMG"}: ${issue.message}`));
      } catch {
        console.error("Unable to retrieve the notarization log; inspect the submission ID with notarytool");
      }
    }
    throw new Error("DMG notarization was not accepted");
  }
  runCommand("xcrun", ["stapler", "staple", event.file]);
  runCommand("xcrun", ["stapler", "validate", event.file]);
  runCommand("codesign", ["--verify", "--strict", event.file]);

  // Stapling changes DMG bytes. Refresh before artifactCreated lets the publisher
  // generate latest-mac.yml. ZIP already contains the stapled app and is unchanged.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
  event.updateInfo = await buildBlockMap(event.file, "gzip", `${event.file}.blockmap`);
};
