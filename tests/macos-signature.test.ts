import { describe, expect, it } from "vitest";
import { validateMacCodeSigningDetails } from "../src/macos-signature.js";

describe("validateMacCodeSigningDetails", () => {
  it("accepts a team-signed Harness bundle", () => {
    expect(validateMacCodeSigningDetails(`
Identifier=cc.jiwo.arkme
Authority=Developer ID Application: Jotmo (ABCDE12345)
TeamIdentifier=ABCDE12345
Sealed Resources version=2 rules=13 files=42
`)).toEqual({
      identifier: "cc.jiwo.arkme",
      teamIdentifier: "ABCDE12345"
    });
  });

  it("rejects the ad-hoc signature produced without an Apple signing identity", () => {
    expect(() => validateMacCodeSigningDetails(`
Identifier=cc.jiwo.arkme
Signature=adhoc
TeamIdentifier=not set
`)).toThrow(/Apple code-signing identity/);
  });

  it("rejects a signed bundle with the wrong application identifier", () => {
    expect(() => validateMacCodeSigningDetails(`
Identifier=Electron
Authority=Apple Development: Developer (ABCDE12345)
TeamIdentifier=ABCDE12345
`)).toThrow(/cc\.jiwo\.arkme/);
  });
});
