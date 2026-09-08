import { createHash, generateKeyPairSync } from "node:crypto";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { validateMacCiCredentials, withMacCiSigningEnvironment } = require("../scripts/macos-ci-signing.cjs");
const notarizeDmg = require("../scripts/notarize-macos-dmg.cjs");
const { verifyMacUpdateMetadata } = require("../scripts/build-macos-ci.cjs");
const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  .export({ format: "pem", type: "pkcs8" }).toString();
const certificate = Buffer.from("test certificate fixture").toString("base64");
const appleIdEnv = {
  CSC_LINK: certificate, CSC_KEY_PASSWORD: "certificate-password", APPLE_TEAM_ID: "ABCDE12345",
  APPLE_ID: "ci@example.test", APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password"
};
const apiEnv = {
  CSC_LINK: certificate, CSC_KEY_PASSWORD: "certificate-password", APPLE_TEAM_ID: "ABCDE12345",
  APPLE_API_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
  APPLE_API_KEY_ID: "KEY1234567", APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000001"
};
const directories: string[] = [];
async function temporaryDirectory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arkme-ci-signing-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("macOS CI credentials", () => {
  it.each(["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_TEAM_ID", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"])(
    "rejects missing %s instead of silently producing an unsigned or unnotarized app", name => {
      expect(() => validateMacCiCredentials({ ...appleIdEnv, [name]: "" })).toThrow();
    }
  );
  it("requires one complete notarization method", () => {
    expect(validateMacCiCredentials(appleIdEnv)).toBe("apple-id");
    expect(validateMacCiCredentials(apiEnv)).toBe("api-key");
    expect(() => validateMacCiCredentials({ ...apiEnv, APPLE_API_ISSUER: "" })).toThrow(/APPLE_API_ISSUER/);
    expect(() => validateMacCiCredentials({ ...appleIdEnv, ...apiEnv })).toThrow(/one|both/i);
  });
  it("rejects invalid key data without including the secret in the error", () => {
    const secret = "this-is-not-a-private-key";
    expect(() => validateMacCiCredentials({ ...apiEnv, APPLE_API_KEY_BASE64: secret }))
      .toThrow(/APPLE_API_KEY_BASE64/);
    try { validateMacCiCredentials({ ...apiEnv, APPLE_API_KEY_BASE64: secret }); }
    catch (error) { expect(String(error)).not.toContain(secret); }
  });
  it.each([false, true])("removes the temporary API key after build failure=%s", async fail => {
    const root = await temporaryDirectory();
    let keyPath = "";
    const build = withMacCiSigningEnvironment({ ...apiEnv, RUNNER_TEMP: root,
      DEBUG: "*", NODE_DEBUG: "child_process", NODE_DEBUG_NATIVE: "*"
    }, async (env: NodeJS.ProcessEnv) => {
      keyPath = env.APPLE_API_KEY!;
      expect(await readFile(keyPath, "utf8")).toBe(privateKey);
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("true");
      expect(env.APPLE_API_KEY_BASE64).toBeUndefined();
      expect(env.DEBUG).toBeUndefined();
      expect(env.NODE_DEBUG).toBeUndefined();
      expect(env.NODE_DEBUG_NATIVE).toBeUndefined();
      if (fail) throw new Error("build failed");
    });
    if (fail) await expect(build).rejects.toThrow("build failed");
    else await build;
    await expect(stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([".keychain", ".keychain-db"])("cleans up %s left by a failed certificate import", async extension => {
    const root = await temporaryDirectory();
    let keychainPath = "";
    vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[]) => {
      if (command !== "security" || args[0] !== "delete-keychain" || args[1] !== keychainPath) {
        throw new Error("Unexpected cleanup command");
      }
      // Simulate removal of the search-list entry; the file cleanup remains real.
      return { pid: 1, status: 0, signal: null, stdout: "", stderr: "", output: [null, "", ""] };
    }) as typeof childProcess.spawnSync);
    const build = withMacCiSigningEnvironment({ ...appleIdEnv, RUNNER_TEMP: root }, async (env: NodeJS.ProcessEnv) => {
      expect(typeof env.APP_BUILDER_TMP_DIR).toBe("string");
      expect((await stat(env.APP_BUILDER_TMP_DIR!)).mode & 0o777).toBe(0o700);
      keychainPath = path.join(env.APP_BUILDER_TMP_DIR!, `certificate${extension}`);
      await writeFile(keychainPath, "imported private key fixture");
      throw new Error("key partition setup failed");
    });
    await expect(build).rejects.toThrow("key partition setup failed");
    expect(await readdir(root)).toEqual([]);
    expect(childProcess.spawnSync).toHaveBeenCalledWith("security", ["delete-keychain", keychainPath], expect.anything());
  });
});

describe("DMG notarization and update metadata", () => {
  function fakeAppleTools(status: string) {
    for (const [name, value] of Object.entries(appleIdEnv)) vi.stubEnv(name, value);
    vi.stubEnv("APPLE_API_KEY", "");
    vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[]) => {
      let stdout = "";
      if (command === "xcrun" && args[0] === "notarytool" && args[1] === "submit") {
        expect(args).toContain("--wait");
        expect(args).toContain("--team-id");
        expect(args).toContain("ABCDE12345");
        stdout = JSON.stringify({ id: "submission-id", status });
      } else if (command === "xcrun" && args[0] === "notarytool" && args[1] === "log") {
        stdout = JSON.stringify({ issues: [{ message: "Signature invalid" }] });
      } else if (command === "xcrun" && args[0] === "stapler" && args[1] === "staple") {
        appendFileSync(args[2]!, "stapled-ticket");
      } else if (!(command === "codesign" || (command === "xcrun" && args[0] === "stapler" && args[1] === "validate"))) {
        throw new Error(`Unexpected command: ${command} ${args[0]} ${args[1]}`);
      }
      return { pid: 1, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""] };
    }) as typeof childProcess.spawnSync);
  }

  it("regenerates hashes and blockmap from the stapled DMG bytes", async () => {
    fakeAppleTools("Accepted");
    const file = path.join(await temporaryDirectory(), "arkme Test.dmg");
    await writeFile(file, "signed-dmg");
    await writeFile(`${file}.blockmap`, "stale-blockmap");
    const event = { file, updateInfo: { size: 10, sha512: "stale-hash" } };
    await notarizeDmg(event);
    const finalBytes = await readFile(file);
    expect(finalBytes.toString()).toBe("signed-dmgstapled-ticket");
    expect(event.updateInfo.size).toBe(finalBytes.length);
    expect(event.updateInfo.sha512).toBe(createHash("sha512").update(finalBytes).digest("base64"));
    const blockmap = JSON.parse(gunzipSync(await readFile(`${file}.blockmap`)).toString());
    expect(blockmap.files[0].sizes.reduce((a: number, b: number) => a + b, 0)).toBe(finalBytes.length);
  });

  it.each(["Invalid", "In Progress"])("rejects notarization status %s without modifying the installer", async status => {
    fakeAppleTools(status);
    const file = path.join(await temporaryDirectory(), "rejected.dmg");
    await writeFile(file, "signed-dmg");
    const event = { file, updateInfo: { size: 10, sha512: "original-hash" } };
    await expect(notarizeDmg(event)).rejects.toThrow(/notarization/i);
    expect(await readFile(file, "utf8")).toBe("signed-dmg");
    expect(event.updateInfo.sha512).toBe("original-hash");
  });

  it("does not submit ZIP or blockmap artifacts for notarization", async () => {
    await notarizeDmg({ file: "unavailable.zip" });
    await notarizeDmg({ file: "unavailable.dmg.blockmap" });
  });
});

describe("final macOS update metadata", () => {
  it("rejects an installer modified after update metadata was generated", async () => {
    const dir = await temporaryDirectory();
    const contents = Buffer.from("final-installation-artifact");
    const sha512 = createHash("sha512").update(contents).digest("base64");
    const { gzipSync } = await import("node:zlib");
    const { stringify } = await import("yaml");
    const files = ["arkme Test.dmg", "arkme Test.zip"];
    for (const name of files) {
      await writeFile(path.join(dir, name), contents);
      await writeFile(path.join(dir, `${name}.blockmap`), gzipSync(JSON.stringify({
        version: "2", files: [{ name: "file", offset: 0, sizes: [contents.length], checksums: ["fixture"] }]
      })));
    }
    await writeFile(path.join(dir, "latest-mac.yml"), stringify({
      version: "0.2.9", path: "arkme Test.zip", sha512,
      files: files.map(url => ({ url, size: contents.length, sha512 }))
    }));
    await verifyMacUpdateMetadata(dir);
    await writeFile(path.join(dir, "arkme Test.dmg"), "different bytes after stapling");
    await expect(verifyMacUpdateMetadata(dir)).rejects.toThrow(/size|SHA-512/);
  });
});
