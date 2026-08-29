import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("bundled DSH package-manager patch", () => {
  test("forwards spaced and shell-like plugin arguments without a shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arkme-dsh-pnpm-patch-"));
    temporaryDirectories.push(root);
    const dshRoot = path.join(root, "dsh");
    const pluginModule = path.join(dshRoot, "lib", "plugin-fixture.mjs");
    const pnpmCli = path.join(root, "pnpm-cli.cjs");
    const capturePath = path.join(root, "captured.json");
    await mkdir(path.dirname(pluginModule), { recursive: true });
    await writeFile(pluginModule, `
import { spawnSync } from "node:child_process";
const anchorPathSpec = (argument) => argument;
export function runPlugin(args) {
  const dir = process.cwd();
  const result = spawnSync("pnpm", args.map((argument) => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}
`);
    await writeFile(pnpmCli, `
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.ARKME_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
`);

    const patch = spawnSync(
      process.execPath,
      [path.resolve("scripts", "patch-dsh-bundled-pnpm.mjs"), dshRoot],
      { encoding: "utf8" }
    );
    expect(patch.status, patch.stderr).toBe(0);

    const argumentsToForward = [
      "add",
      "link:C:\\Users\\Test User\\Arkme Harness\\bundle",
      "literal;&value"
    ];
    const program = `
      import { runPlugin } from ${JSON.stringify(pathToFileURL(pluginModule).href)};
      process.exitCode = runPlugin(${JSON.stringify(argumentsToForward)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARKME_PNPM_CLI_PATH: pnpmCli,
        ARKME_CAPTURE_PATH: capturePath
      }
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual(argumentsToForward);
  });
});
