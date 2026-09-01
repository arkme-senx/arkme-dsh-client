import { describe, expect, it } from "vitest";
import {
  validateMacCodeSigningDetails,
  validateMacLocationUsageDescriptions,
  validateMacMainProcessEntitlements
} from "../src/macos-signature.js";

describe("validateMacCodeSigningDetails", () => {
  it("accepts a team-signed Harness bundle", () => {
    expect(validateMacCodeSigningDetails(`
Identifier=com.senx.arkme.harness
Authority=Developer ID Application: Jotmo (ABCDE12345)
TeamIdentifier=ABCDE12345
Sealed Resources version=2 rules=13 files=42
`)).toEqual({
      identifier: "com.senx.arkme.harness",
      teamIdentifier: "ABCDE12345"
    });
  });

  it("rejects the ad-hoc signature produced without an Apple signing identity", () => {
    expect(() => validateMacCodeSigningDetails(`
Identifier=com.senx.arkme.harness
Signature=adhoc
TeamIdentifier=not set
`)).toThrow(/Apple code-signing identity/);
  });

  it("rejects a signed bundle with the wrong application identifier", () => {
    expect(() => validateMacCodeSigningDetails(`
Identifier=Electron
Authority=Apple Development: Developer (ABCDE12345)
TeamIdentifier=ABCDE12345
`)).toThrow(/com\.senx\.arkme\.harness/);
  });
});

describe("validateMacMainProcessEntitlements", () => {
  const complete = `
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.personal-information.location</key><true/>
</dict></plist>`;

  it("accepts Electron runtime and main-process location entitlements", () => {
    expect(() => validateMacMainProcessEntitlements(complete)).not.toThrow();
  });

  it("rejects a signature that cannot own the CoreLocation permission", () => {
    expect(() => validateMacMainProcessEntitlements(
      complete.replace("com.apple.security.personal-information.location", "missing-location")
    )).toThrow(/personal-information\.location/);
  });

  it("rejects a location-only entitlement file that breaks Electron hardened runtime", () => {
    expect(() => validateMacMainProcessEntitlements(`
<plist><dict><key>com.apple.security.personal-information.location</key><true/></dict></plist>
    `)).toThrow(/allow-jit/);
  });
});

describe("validateMacLocationUsageDescriptions", () => {
  it("requires both legacy and when-in-use bundle descriptions", () => {
    expect(() => validateMacLocationUsageDescriptions({
      location: "Arkme location",
      whenInUse: "Arkme location"
    })).not.toThrow();
    expect(() => validateMacLocationUsageDescriptions({
      location: "",
      whenInUse: "Arkme location"
    })).toThrow(/location usage descriptions/);
  });
});
