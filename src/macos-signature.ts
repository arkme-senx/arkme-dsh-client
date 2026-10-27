export interface MacCodeSigningDetails {
  identifier: string;
  teamIdentifier: string;
}

export function validateMacHelperIdentifiers(identifiers: readonly string[]): void {
  const prefix = "com.senqisi.Jotmo.helper";
  if (identifiers.length === 0 || identifiers.some(id => id !== prefix && !id.startsWith(`${prefix}.`))) {
    throw new Error("Signed Helper identifiers must derive from com.senqisi.Jotmo.helper");
  }
}

const requiredRuntimeEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.device.audio-input"
] as const;

export function validateMacCodeSigningDetails(output: string): MacCodeSigningDetails {
  const identifier = detailValue(output, "Identifier");
  if (identifier !== "com.senqisi.Jotmo") {
    throw new Error(
      `Signed Harness must use identifier com.senqisi.Jotmo; received ${identifier ?? "none"}`
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
  validateEntitlements(output, [...requiredRuntimeEntitlements, "com.apple.security.personal-information.location"], "main process");
}

export function validateMacHelperProcessEntitlements(output: string): void {
  validateEntitlements(output, requiredRuntimeEntitlements, "Helper process");
}

function validateEntitlements(output: string, required: readonly string[], processName: string): void {
  for (const entitlement of required) {
    const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`).test(output)) {
      throw new Error(`Signed Harness ${processName} is missing entitlement ${entitlement}`);
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
