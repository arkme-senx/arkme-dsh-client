import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORWARDER_PATTERN = /([ \t]*)const result = spawnSync\("pnpm", args\.map\(\(argument\) => anchorPathSpec\(argument, process\.cwd\(\)\)\), \{\r?\n[ \t]*cwd: dir,\r?\n[ \t]*stdio: "inherit",\r?\n[ \t]*shell: process\.platform === "win32"\r?\n[ \t]*\}\);/g;

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
