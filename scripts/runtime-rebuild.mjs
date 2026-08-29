export function buildElectronRebuildArgs({
  rebuildCli,
  electronVersion,
  platform,
  arch,
  moduleDir
}) {
  return [
    rebuildCli,
    "--version",
    electronVersion,
    "--platform",
    platform,
    "--arch",
    arch,
    "--module-dir",
    moduleDir,
    "--which-module",
    "node-pty",
    "--sequential",
    "--force"
  ];
}

export function buildRuntimeDeployArgs({ storePath, runtimeRoot }) {
  return [
    "--prefer-offline",
    "--store-dir",
    storePath,
    "--filter",
    "@jotmo/harness-runtime",
    "deploy",
    "--prod",
    "--legacy",
    runtimeRoot
  ];
}

export function isRuntimeFilePrunable(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/").toLowerCase();
  const basename = normalizedPath.split("/").at(-1) ?? "";
  const isGeneratedArtifact = [
    ".map",
    ".pdb",
    ".ipdb",
    ".iobj"
  ].some((extension) => normalizedPath.endsWith(extension));
  const isDocumentation = /^(readme|changelog|changes|history)(?:\.[a-z0-9_-]+)?\.(md|markdown)$/.test(basename);
  return isGeneratedArtifact || isDocumentation;
}

export function buildSpawnOptions({ platform, command }) {
  return platform === "win32" && command.toLowerCase().endsWith(".cmd")
    ? { shell: true }
    : {};
}

export function disableNodePtySpectreMitigation(contents) {
  return contents.replaceAll(
    "'SpectreMitigation': 'Spectre'",
    "'SpectreMitigation': 'false'"
  );
}
