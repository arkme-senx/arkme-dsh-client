const childProcess = require("node:child_process");
const { createPrivateKey } = require("node:crypto");
const { mkdir, mkdtemp, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");

function assertMacCiDebugLoggingDisabled() {
  // Node's child_process debug logger prints the full env from the PARENT.
  // Removing these variables only from the child env cannot disable that logger.
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE"].some(name => process.env[name]?.trim())) {
    throw new Error("macOS CI debug logging must be disabled before starting Node (DEBUG, NODE_DEBUG, NODE_DEBUG_NATIVE)");
  }
}

function createMacCiLogRedactor(env = process.env) {
  const values = new Set();
  const add = value => {
    if (typeof value !== "string" || !value.trim()) return;
    for (const part of [value, value.trim(), ...value.split(/\r?\n/)]) {
      if (!part.trim()) continue;
      values.add(part);
      values.add(JSON.stringify(part).slice(1, -1));
    }
  };
  // Include the original environment too: the child receives a .p8 path after
  // its Base64 variable is removed, but the parent still needs to mask its body.
  for (const source of [process.env, env]) {
    for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_TEAM_ID",
      "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
      add(source[name]);
    }
    for (const name of ["CSC_LINK", "APPLE_API_KEY_BASE64"]) {
      if (source[name]) add(source[name].replace(/\s/g, ""));
    }
    if (source.APPLE_API_KEY_BASE64) add(Buffer.from(source.APPLE_API_KEY_BASE64, "base64").toString("utf8"));
  }
  const patterns = [...values].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = patterns.length ? new RegExp(patterns.join("|"), "g") : null;
  return value => pattern ? String(value).replace(pattern, "[REDACTED]") : String(value);
}

function required(env, name) {
  if (!env[name]?.trim()) throw new Error(`Missing macOS CI credential: ${name}`);
  return env[name];
}

function decodeBase64(value, name) {
  const normalized = value.replace(/\s/g, "");
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.toString("base64") !== normalized) {
    throw new Error(`${name} must contain a valid Base64-encoded file`);
  }
  return bytes;
}

function validateMacCiCredentials(env) {
  assertMacCiDebugLoggingDisabled();
  decodeBase64(required(env, "CSC_LINK"), "CSC_LINK");
  required(env, "CSC_KEY_PASSWORD");
  const team = required(env, "APPLE_TEAM_ID");
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error("APPLE_TEAM_ID must be a 10-character Team ID");
  const hasApiKey = ["APPLE_API_KEY_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].some(name => env[name]?.trim());
  const hasAppleId = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"].some(name => env[name]?.trim());
  if (hasApiKey && hasAppleId) throw new Error("Configure only one notarization authentication method, not both");
  if (hasApiKey) {
    required(env, "APPLE_API_KEY_ID");
    required(env, "APPLE_API_ISSUER");
    const key = decodeBase64(required(env, "APPLE_API_KEY_BASE64"), "APPLE_API_KEY_BASE64");
    try { createPrivateKey({ key, format: "pem", type: "pkcs8" }); }
    catch { throw new Error("APPLE_API_KEY_BASE64 must contain a valid .p8 private key"); }
    return "api-key";
  }
  required(env, "APPLE_ID");
  required(env, "APPLE_APP_SPECIFIC_PASSWORD");
  return "apple-id";
}

async function withMacCiSigningEnvironment(input, build) {
  const mode = validateMacCiCredentials(input);
  const directory = await mkdtemp(path.join(input.RUNNER_TEMP || os.tmpdir(), "arkme-macos-signing-"));
  const builderDirectory = path.join(directory, "builder");
  try {
    await mkdir(builderDirectory, { mode: 0o700 });
    const env = { ...input, CSC_IDENTITY_AUTO_DISCOVERY: "true", APP_BUILDER_TMP_DIR: builderDirectory };
    // Do not let inherited local/keychain credentials override the selected CI method.
    delete env.APPLE_KEYCHAIN;
    delete env.APPLE_KEYCHAIN_PROFILE;
    delete env.APPLE_API_KEY;
    delete env.DEBUG;
    delete env.NODE_DEBUG;
    delete env.NODE_DEBUG_NATIVE;
    if (mode === "api-key") {
      env.APPLE_API_KEY = path.join(directory, "AuthKey.p8");
      await writeFile(env.APPLE_API_KEY, decodeBase64(input.APPLE_API_KEY_BASE64, "APPLE_API_KEY_BASE64"), { mode: 0o600 });
    }
    delete env.APPLE_API_KEY_BASE64;
    return await build(env, directory);
  } finally {
    // Builder registers keychain disposal only after certificate import succeeds.
    // Handle partial imports too, including their keychain search-list entries.
    for (const name of await readdir(builderDirectory).catch(() => [])) {
      if (!name.endsWith(".keychain") && !name.endsWith(".keychain-db")) continue;
      childProcess.spawnSync("security", ["delete-keychain", path.join(builderDirectory, name)], { stdio: "ignore" });
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function runCommand(command, args, env = process.env, capture = false) {
  assertMacCiDebugLoggingDisabled();
  const redact = createMacCiLogRedactor(env);
  const result = childProcess.spawnSync(command, args, {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024
  });
  if (!capture) {
    if (result.stdout) process.stdout.write(redact(result.stdout));
    if (result.stderr) process.stderr.write(redact(result.stderr));
  }
  if (result.error || result.status !== 0) {
    // execFile-style errors include the entire argv, which can contain the Apple password.
    const detail = capture ? redact((result.stderr || result.stdout || "").trim()) : "";
    throw new Error(`${command} failed (${result.status ?? result.error?.code ?? "signal"})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout || "";
}

function runLoggedCommand(command, args, env = process.env) {
  assertMacCiDebugLoggingDisabled();
  const redact = createMacCiLogRedactor(env);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    // Assemble complete lines before redacting: a secret can cross data chunks.
    // readline also flushes a final line without a trailing newline on EOF.
    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      createInterface({ input, crlfDelay: Infinity }).on("line", line => output.write(`${redact(line)}\n`));
    }
    child.on("error", error => reject(new Error(`${command} failed (${error.code || "spawn error"})`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code ?? signal ?? "signal"})`));
    });
  });
}

function notarytoolAuthArgs(env) {
  if (env.APPLE_API_KEY) {
    return ["--key", required(env, "APPLE_API_KEY"), "--key-id", required(env, "APPLE_API_KEY_ID"),
      "--issuer", required(env, "APPLE_API_ISSUER")];
  }
  return ["--apple-id", required(env, "APPLE_ID"), "--password", required(env, "APPLE_APP_SPECIFIC_PASSWORD"),
    "--team-id", required(env, "APPLE_TEAM_ID")];
}

module.exports = { validateMacCiCredentials, withMacCiSigningEnvironment, runCommand, runLoggedCommand,
  createMacCiLogRedactor, notarytoolAuthArgs };

if (require.main === module) {
  try {
    const mode = validateMacCiCredentials(process.env);
    console.log(`macOS CI credentials are configured (${mode}); authentication is verified during signing/notarization`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
