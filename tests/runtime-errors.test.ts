import { describe, expect, test } from "vitest";
import {
  isDeterministicRuntimeArtifactError,
  RuntimeArtifactValidationError,
  runtimeArtifactFailureCode
} from "../src/runtime/errors.js";

describe("runtime artifact failure classification", () => {
  test("does not classify an unscoped ENOENT from startup as a deterministic artifact failure", () => {
    const error = Object.assign(new Error("workspace file missing"), { code: "ENOENT" });

    expect(isDeterministicRuntimeArtifactError(error)).toBe(false);
    expect(runtimeArtifactFailureCode(error)).toBe("RELEASE_VALIDATION_FAILED");
  });

  test("classifies only explicitly wrapped artifact validation failures as deterministic", () => {
    const error = new RuntimeArtifactValidationError(
      "REQUIRED_FILE_MISSING",
      "runtime entry is missing",
      "verify"
    );

    expect(isDeterministicRuntimeArtifactError(error)).toBe(true);
    expect(runtimeArtifactFailureCode(error)).toBe("REQUIRED_FILE_MISSING");
  });
});
