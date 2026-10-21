import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORWARDER_PATTERN = /([ \t]*)const result = spawnSync\("pnpm", args\.map\(\(argument\) => anchorPathSpec\(argument, process\.cwd\(\)\)\), \{\r?\n[ \t]*cwd: dir,\r?\n[ \t]*stdio: "inherit",\r?\n[ \t]*shell: process\.platform === "win32"\r?\n[ \t]*\}\);/g;
const MANAGED_FORWARDER_PATTERN = /^([ \t]*)(async function runPlugin\(profile, args, packageManager\) \{)$/gm;
const MANAGED_MARKER = "const arkmeBundledPnpmCli = process.env.ARKME_PNPM_CLI_PATH;";

function replacement(indentation) {
  const nested = `${indentation}${indentation.includes("\t") ? "\t" : "  "}`;
  return [
    `${indentation}const packageManagerArgs = args.map((argument) => anchorPathSpec(argument, process.cwd()));`,
    `${indentation}const bundledPnpmCli = process.env.ARKME_PNPM_CLI_PATH;`,
    `${indentation}const result = bundledPnpmCli === void 0`,
    `${nested}? spawnSync("pnpm", packageManagerArgs, {`,
    `${nested}  cwd: dir,`,
    `${nested}  stdio: "inherit",`,
    `${nested}  shell: process.platform === "win32"`,
    `${nested}})`,
    `${nested}: spawnSync(process.execPath, [bundledPnpmCli, ...packageManagerArgs], {`,
    `${nested}  cwd: dir,`,
    `${nested}  stdio: "inherit",`,
    `${nested}  shell: false,`,
    `${nested}  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }`,
    `${nested}});`,
  ].join("\n");
}

export async function patchDshBundledPnpm(dshRoot) {
  const libDirectory = path.join(dshRoot, "lib");
  const candidates = (await readdir(libDirectory))
    .filter((name) => /^plugin-.*\.m?js$/.test(name))
    .map((name) => path.join(libDirectory, name));
  const matches = [];
  for (const candidate of candidates) {
    const source = await readFile(candidate, "utf8");
    if (source.includes(MANAGED_MARKER)) return candidate;
    // DSH 0.2.1 delegates package operations to the public plugin-manager API.
    // Supply its application-owned invocation; preserve explicit caller options.
    const managed = [...source.matchAll(MANAGED_FORWARDER_PATTERN)];
    if (managed.length === 1 && source.includes('from "@deepseek-ai/dsh-plugin-manager/operations"')) {
      const patched = source.replace(MANAGED_FORWARDER_PATTERN, (_line, indentation, declaration) => [
        `${indentation}${declaration}`,
        `${indentation}\t${MANAGED_MARKER}`,
        `${indentation}\tif (packageManager === void 0 && arkmeBundledPnpmCli !== void 0) packageManager = {`,
        `${indentation}\t\tcommand: process.execPath,`,
        `${indentation}\t\targs: [arkmeBundledPnpmCli],`,
        `${indentation}\t\tenv: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }`,
        `${indentation}\t};`,
      ].join("\n"));
      await writeFile(candidate, patched, "utf8");
      return candidate;
    }
    const occurrences = [...source.matchAll(FORWARDER_PATTERN)];
    if (occurrences.length > 0) matches.push({ candidate, source, occurrences });
  }
  const occurrenceCount = matches.reduce((count, entry) => count + entry.occurrences.length, 0);
  if (occurrenceCount !== 1 || matches.length !== 1) {
    throw new Error(`Expected one DSH pnpm forwarder, found ${occurrenceCount}`);
  }
  const [{ candidate, source, occurrences }] = matches;
  const indentation = occurrences[0][1] ?? "";
  const patched = source.replace(FORWARDER_PATTERN, replacement(indentation));
  const temporary = `${candidate}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, patched, { encoding: "utf8", flag: "wx" });
    await rename(temporary, candidate);
  } finally {
    await rm(temporary, { force: true });
  }
  return candidate;
}

async function main() {
  const dshRoot = process.argv[2];
  if (dshRoot === undefined || dshRoot.trim() === "") throw new Error("DSH package path is required");
  await patchDshBundledPnpm(path.resolve(dshRoot));
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
