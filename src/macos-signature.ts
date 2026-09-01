export interface MacCodeSigningDetails {
  identifier: string;
  teamIdentifier: string;
}

const requiredMainProcessEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.personal-information.location"
] as const;

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

export function validateMacMainProcessEntitlements(output: string): void {
  for (const entitlement of requiredMainProcessEntitlements) {
    const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`).test(output)) {
      throw new Error(`Signed Harness main process is missing entitlement ${entitlement}`);
    }
  }
}

export function validateMacLocationUsageDescriptions(values: {
  location: string;
  whenInUse: string;
}): void {
  if (values.location.trim() === "" || values.whenInUse.trim() === "") {
    throw new Error("Signed Harness requires non-empty macOS location usage descriptions");
  }
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
