import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const PRODUCTION_RUNTIME_SERVICE_ORIGIN = "https://api.jotmo.cc";
export const TEST_RUNTIME_SERVICE_ORIGIN = "https://jotmo.senguo.me";

export type RuntimeEnvironment = "prod" | "test";

export interface RuntimeServiceConfig {
  environment: RuntimeEnvironment;
  serviceBaseUrl: string;
}

const TRUSTED_RUNTIME_SERVICE_ORIGINS = new Set([
  PRODUCTION_RUNTIME_SERVICE_ORIGIN,
  TEST_RUNTIME_SERVICE_ORIGIN
]);

export function resolveRuntimeServiceOrigin(value: string | undefined): string {
  const candidate = value?.trim() || PRODUCTION_RUNTIME_SERVICE_ORIGIN;
  if (!TRUSTED_RUNTIME_SERVICE_ORIGINS.has(candidate)) {
    throw new Error(`Electron runtime service origin is not trusted: ${candidate}`);
  }
  return candidate;
}

export function resolveRuntimeEnvironment(serviceBaseUrl: string): RuntimeEnvironment {
  const origin = resolveRuntimeServiceOrigin(serviceBaseUrl);
  return origin === TEST_RUNTIME_SERVICE_ORIGIN ? "test" : "prod";
}

export function readPackagedRuntimeServiceConfig(distDirectory: string): RuntimeServiceConfig {
  return parsePackagedRuntimeServiceConfig(JSON.parse(
    readFileSync(path.join(distDirectory, "runtime-service-config.json"), "utf8")
  ) as unknown);
}

export async function readPackagedRuntimeServiceOrigin(distDirectory: string): Promise<string> {
  return parsePackagedRuntimeServiceConfig(JSON.parse(
    await readFile(path.join(distDirectory, "runtime-service-config.json"), "utf8")
  ) as unknown).serviceBaseUrl;
}

function parsePackagedRuntimeServiceConfig(value: unknown): RuntimeServiceConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Electron runtime packaged service config is invalid");
  }
  const document = value as { environment?: unknown; serviceBaseUrl?: unknown };
  const serviceBaseUrl = resolveRuntimeServiceOrigin(
    typeof document.serviceBaseUrl === "string" ? document.serviceBaseUrl : undefined
  );
  const environment = resolveRuntimeEnvironment(serviceBaseUrl);
  if (document.environment !== environment) {
    throw new Error(
      `Electron runtime packaged environment mismatch: expected ${environment}, received ${String(document.environment)}`
    );
  }
  return { environment, serviceBaseUrl };
}
