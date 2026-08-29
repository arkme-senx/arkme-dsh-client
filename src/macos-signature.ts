export interface MacCodeSigningDetails {
  identifier: string;
  teamIdentifier: string;
}

export function validateMacCodeSigningDetails(output: string): MacCodeSigningDetails {
  const identifier = detailValue(output, "Identifier");
  if (identifier !== "cc.jiwo.arkme") {
    throw new Error(
      `Signed Harness must use identifier cc.jiwo.arkme; received ${identifier ?? "none"}`
    );
  }

  const teamIdentifier = detailValue(output, "TeamIdentifier");
  if (
    detailValue(output, "Signature") === "adhoc"
    || teamIdentifier === undefined
    || teamIdentifier === "not set"
  ) {
    throw new Error("Harness requires a valid Apple code-signing identity with a TeamIdentifier");
  }

  return { identifier, teamIdentifier };
}

function detailValue(output: string, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}
