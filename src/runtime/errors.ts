import type { RuntimeFailurePhase, RuntimeFailureScope } from "./state.js";

export class RuntimeArtifactValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly phase: RuntimeFailurePhase = "verify",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RuntimeArtifactValidationError";
  }
}

export function isDeterministicRuntimeArtifactError(
  error: unknown
): error is RuntimeArtifactValidationError {
  return error instanceof RuntimeArtifactValidationError;
}

export function runtimeFailureScope(error: unknown): RuntimeFailureScope {
  const code = systemErrorCode(error);
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EIO") {
    return "environment";
  }
  return "unknown";
}

export function runtimeArtifactFailureCode(error: unknown): string {
  if (error instanceof RuntimeArtifactValidationError) return error.code;
  return "RELEASE_VALIDATION_FAILED";
}

export function runtimeArtifactFailurePhase(error: unknown): RuntimeFailurePhase {
  return error instanceof RuntimeArtifactValidationError ? error.phase : "verify";
}

function systemErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
