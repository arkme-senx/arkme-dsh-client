import childProcess from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve("scripts/macos-ci-signing.cjs");
const keyBody = "ci-private-key-fixture-only-not-a-real-key";
const secrets = {
  CSC_LINK: Buffer.from("ci-certificate-fixture-only").toString("base64"),
  CSC_KEY_PASSWORD: `ci-password-with-"quotes"-and-\\slash`,
  APPLE_ID: "ci-secret-account@example.test",
  APPLE_TEAM_ID: "TESTTEAM01",
  APPLE_APP_SPECIFIC_PASSWORD: "ciap-pspe-cifi-cpwd",
  APPLE_API_KEY_BASE64: Buffer.from(`-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\n`).toString("base64"),
  APPLE_API_KEY_ID: "TESTKEY001",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000002"
};

// Use real child processes: reverting to inherited stdio must expose the fixture
// to this capturing parent and fail, even without GitHub's automatic masking.
function runFixture(method: string, failure: boolean, capture = false) {
  const child = `
    const names = ${JSON.stringify(Object.keys(secrets))};
    const values = names.map(name => process.env[name]);
    const output = 'normal build progress\\n' + values.join('\\n') + '\\n'
      + JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))) + '\\n'
      + Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64').toString();
    process.stdout.write(output.slice(0, 37));
    setTimeout(() => {
      process.stdout.write(output.slice(37));
      process.stderr.write('tool diagnostic\\n' + output.slice(0, 43));
      setTimeout(() => {
        process.stderr.write(output.slice(43) + 'final unterminated: ' + process.env.APPLE_APP_SPECIFIC_PASSWORD);
        process.exitCode = ${failure ? 7 : 0};
      }, 5);
    }, 5);
  `;
  const parent = `
    const helper = require(${JSON.stringify(helper)});
    (async () => {
      await helper[${JSON.stringify(method)}](process.execPath, ['-e', ${JSON.stringify(child)}], process.env, ${capture});
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  return childProcess.spawnSync(process.execPath, ["-e", parent], {
    env: { ...process.env, ...secrets }, encoding: "utf8", timeout: 10000
  });
}

describe("macOS CI log redaction", () => {
  it.each(["runCommand", "runLoggedCommand"])("rejects parent Node debug logging before %s can spawn", method => {
    const parent = `
      const helper = require(${JSON.stringify(helper)});
      const env = { ...process.env };
      delete env.NODE_DEBUG;
      (async () => {
        await helper[${JSON.stringify(method)}](process.execPath, ['-e', 'console.log("child ran")'], env);
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    const result = childProcess.spawnSync(process.execPath, ["-e", parent], {
      env: { ...process.env, ...secrets, NODE_DEBUG: "child_process" }, encoding: "utf8", timeout: 10000
    });
    expect(result.status).toBe(1);
    const log = result.stdout + result.stderr;
    expect(log).toContain("debug logging must be disabled");
    expect(log).not.toContain("child ran");
    for (const secret of Object.values(secrets)) expect(log).not.toContain(secret);
  });

  it.each([false, true])("filters synchronous stdout and stderr, failure=%s", failure => {
    const result = runFixture("runCommand", failure);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(failure ? 1 : 0);
    const log = result.stdout + result.stderr;
    expect(log).toContain("normal build progress");
    expect(log).toContain("tool diagnostic");
    for (const secret of [...Object.values(secrets), keyBody]) expect(log).not.toContain(secret);
    expect(log).not.toContain(JSON.stringify(secrets.CSC_KEY_PASSWORD).slice(1, -1));
    expect(log).toContain("[REDACTED]");
  });

  it.each([false, true])("filters streaming chunks and the final unterminated line, failure=%s", failure => {
    const result = runFixture("runLoggedCommand", failure);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(failure ? 1 : 0);
    const log = result.stdout + result.stderr;
    expect(log).toContain("normal build progress");
    expect(log).toContain("tool diagnostic");
    expect(log).toContain("final unterminated: [REDACTED]");
    for (const secret of [...Object.values(secrets), keyBody]) expect(log).not.toContain(secret);
    expect(log).not.toContain(JSON.stringify(secrets.CSC_KEY_PASSWORD).slice(1, -1));
  });

  it("filters captured error details without logging the command arguments", () => {
    const result = runFixture("runCommand", true, true);
    expect(result.status).toBe(1);
    const log = result.stdout + result.stderr;
    expect(log).toContain("failed (7)");
    expect(log).toContain("tool diagnostic");
    expect(log).not.toContain("process.stdout.write");
    for (const secret of [...Object.values(secrets), keyBody]) expect(log).not.toContain(secret);
  });

  it("keeps captured successful JSON intact and out of logs", () => {
    const parent = `
      const { runCommand } = require(${JSON.stringify(helper)});
      const result = JSON.parse(runCommand(process.execPath,
        ['-e', 'console.log(JSON.stringify({status: "Accepted", id: process.env.APPLE_TEAM_ID}))'], process.env, true));
      if (result.status !== 'Accepted' || result.id !== process.env.APPLE_TEAM_ID) process.exitCode = 1;
    `;
    const result = childProcess.spawnSync(process.execPath, ["-e", parent], {
      env: { ...process.env, ...secrets }, encoding: "utf8", timeout: 10000
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });
});
