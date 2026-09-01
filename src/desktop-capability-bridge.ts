import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { TextDecoder } from "node:util";
import {
  parseDesktopNotificationSubmission,
  type DesktopNotificationCoordinator,
  type DesktopNotificationSubmissionResult
} from "./desktop-notification.js";
import {
  parseNativeBadgeSnapshot,
  type NativeBadgeApplyResult,
  type NativeBadgeCoordinator,
  type NativeBadgeMode
} from "./native-badge.js";

const BRIDGE_PATH = "/v1/actions";
const DEFAULT_MAX_BODY_BYTES = 16 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 16;

export type DesktopCapabilityAction =
  | "capabilities.get"
  | "notification.show"
  | "badge.applySnapshot";

export interface DesktopCapabilityBridge {
  readonly url: string;
  readonly token: string;
  readonly limits: Readonly<{
    maxBodyBytes: number;
    maxConnections: number;
    requestTimeoutMs: number;
  }>;
  activateSession(sessionId: string): void;
  deactivateSession(sessionId: string): void;
  close(): Promise<void>;
}

interface DesktopCapabilityBridgeOptions {
  notifications: Pick<DesktopNotificationCoordinator, "submit">;
  notificationSupported(): boolean;
  badges: Pick<NativeBadgeCoordinator, "mode" | "beginSession" | "endSession" | "applySnapshot">;
  randomToken?: () => string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConnections?: number;
}

interface BridgeRequest {
  schemaVersion: 1;
  sessionId: string;
  action: DesktopCapabilityAction;
  payload: Record<string, unknown>;
}

interface BridgeState {
  activeSessionId: string | null;
  authority: string;
  closed: boolean;
}

export async function startDesktopCapabilityBridge(
  options: DesktopCapabilityBridgeOptions
): Promise<DesktopCapabilityBridge> {
  const token = options.randomToken?.() ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    throw new Error("Desktop capability bridge token is invalid");
  }
  const maxBodyBytes = positiveLimit(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const requestTimeoutMs = positiveLimit(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const maxConnections = positiveLimit(options.maxConnections, DEFAULT_MAX_CONNECTIONS);
  const state: BridgeState = { activeSessionId: null, authority: "", closed: false };
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      token,
      maxBodyBytes,
      requestTimeoutMs,
      state
    });
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 24;
  server.maxConnections = maxConnections;

  await listenOnLoopback(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Desktop capability bridge did not receive a TCP address");
  }
  state.authority = `127.0.0.1:${address.port}`;

  return {
    url: `http://${state.authority}${BRIDGE_PATH}`,
    token,
    limits: Object.freeze({ maxBodyBytes, maxConnections, requestTimeoutMs }),
    activateSession(sessionId: string): void {
      if (state.closed) throw new Error("Desktop capability bridge is closed");
      if (!boundedString(sessionId, 128)) throw new Error("Desktop capability bridge session is invalid");
      if (state.activeSessionId === sessionId) return;
      state.activeSessionId = sessionId;
      options.badges.beginSession();
    },
    deactivateSession(sessionId: string): void {
      if (state.activeSessionId !== sessionId) return;
      state.activeSessionId = null;
      options.badges.endSession();
    },
    async close(): Promise<void> {
      if (state.closed) return;
      state.closed = true;
      if (state.activeSessionId !== null) options.badges.endSession();
      state.activeSessionId = null;
      await closeServer(server);
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: DesktopCapabilityBridgeOptions & {
    token: string;
    maxBodyBytes: number;
    requestTimeoutMs: number;
    state: BridgeState;
  }
): Promise<void> {
  setResponseSecurityHeaders(response);
  try {
    assertRequestEnvelope(request, context.state.authority, context.token);
    const body = await readJsonBody(request, context.maxBodyBytes, context.requestTimeoutMs);
    const action = parseBridgeRequest(body);
    const activeSessionId = context.state.activeSessionId;
    if (activeSessionId === null || action.sessionId !== activeSessionId) {
      throw new BridgeHttpError(409, "stale_session");
    }

    if (action.action === "capabilities.get") {
      assertExactKeys(action.payload, []);
      writeJson(response, 200, {
        ok: true,
        value: {
          schemaVersion: 1,
          sessionId: activeSessionId,
          capabilities: {
            notificationShow: context.notificationSupported(),
            badgeApplySnapshot: { mode: context.badges.mode }
          }
        }
      });
      return;
    }

    if (action.action === "notification.show") {
      const notification = parseDesktopNotificationSubmission(action.payload);
      if (notification === undefined) throw new BridgeHttpError(400, "invalid_request");
      writeActionResult(response, context.notifications.submit(notification));
      return;
    }

    const snapshot = parseNativeBadgeSnapshot(action.payload);
    if (snapshot === undefined) throw new BridgeHttpError(400, "invalid_request");
    writeActionResult(response, context.badges.applySnapshot(snapshot));
  } catch (error) {
    const status = error instanceof BridgeHttpError ? error.status : 500;
    const code = error instanceof BridgeHttpError ? error.code : "internal_error";
    writeJson(response, status, { ok: false, error: { code } });
  }
}

function assertRequestEnvelope(request: IncomingMessage, authority: string, token: string): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new BridgeHttpError(403, "forbidden");
  }
  if (request.method !== "POST" || request.url !== BRIDGE_PATH) {
    throw new BridgeHttpError(404, "not_found");
  }
  if (request.headers.host !== authority || request.headers.origin !== undefined) {
    throw new BridgeHttpError(403, "forbidden");
  }
  if (!authorized(request.headers.authorization, token)) {
    throw new BridgeHttpError(401, "unauthorized");
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new BridgeHttpError(415, "unsupported_media_type");
  }
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    throw new BridgeHttpError(415, "unsupported_media_type");
  }
}

function parseBridgeRequest(candidate: unknown): BridgeRequest {
  if (!isRecord(candidate)) throw new BridgeHttpError(400, "invalid_request");
  assertExactKeys(candidate, ["schemaVersion", "sessionId", "action", "payload"]);
  if (
    candidate.schemaVersion !== 1
    || !boundedString(candidate.sessionId, 128)
    || !isDesktopCapabilityAction(candidate.action)
    || !isRecord(candidate.payload)
  ) throw new BridgeHttpError(400, "invalid_request");
  return {
    schemaVersion: 1,
    sessionId: candidate.sessionId,
    action: candidate.action,
    payload: candidate.payload
  };
}

function writeActionResult(
  response: ServerResponse,
  result: DesktopNotificationSubmissionResult | NativeBadgeApplyResult
): void {
  writeJson(response, 200, { ok: true, value: result });
}

function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  timeoutMs: number
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return Promise.reject(new BridgeHttpError(400, "invalid_request"));
    }
    if (declared > maxBodyBytes) {
      request.resume();
      return Promise.reject(new BridgeHttpError(413, "payload_too_large"));
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onError);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new BridgeHttpError(408, "request_timeout")));
      request.resume();
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxBodyBytes) {
        finish(() => reject(new BridgeHttpError(413, "payload_too_large")));
        request.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      finish(() => {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          resolve(JSON.parse(text));
        } catch {
          reject(new BridgeHttpError(400, "invalid_request"));
        }
      });
    };
    const onAborted = () => finish(() => reject(new BridgeHttpError(400, "invalid_request")));
    const onError = () => finish(() => reject(new BridgeHttpError(400, "invalid_request")));

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function setResponseSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("connection", "close");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text, "utf8")
  });
  response.end(text);
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function isDesktopCapabilityAction(value: unknown): value is DesktopCapabilityAction {
  return value === "capabilities.get"
    || value === "notification.show"
    || value === "badge.applySnapshot";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BridgeHttpError(400, "invalid_request");
  }
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export type { NativeBadgeMode };
