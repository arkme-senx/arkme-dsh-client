import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  startDesktopCapabilityBridge,
  type DesktopCapabilityBridge
} from "../src/desktop-capability-bridge.js";

const notificationPayload = {
  idempotencyKey: "event-1",
  kind: "chat.message",
  occurredAtMillis: 1_700_000_000_000,
  expiresAtMillis: 1_900_000_000_000,
  presentation: { title: "新用户群101", body: "你好" },
  activation: {
    kind: "chat-source",
    sourceRef: "opaque-source-ref",
    sourceKey: "group:stable-id"
  }
};

const bridges: DesktopCapabilityBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(async bridge => await bridge.close()));
});

async function fixture(options: { timeoutMs?: number; notificationSupported?: boolean } = {}) {
  const submit = vi.fn(() => ({ accepted: true, outcome: "accepted" } as const));
  const applySnapshot = vi.fn(() => ({ accepted: true, outcome: "accepted" } as const));
  const beginSession = vi.fn(() => ({ accepted: true, outcome: "accepted" } as const));
  const endSession = vi.fn(() => ({ accepted: true, outcome: "accepted" } as const));
  const accountScopes = {
    attest: vi.fn(async () => ({ status: "ready" as const })),
    prepare: vi.fn(async () => ({ transitionRef: "transition-1" })),
    commit: vi.fn(async () => ({ status: "relaunch" as const })),
    abort: vi.fn(async () => ({ status: "ready" as const }))
  };
  const bridge = await startDesktopCapabilityBridge({
    notifications: { submit },
    notificationSupported: () => options.notificationSupported ?? true,
    badges: { mode: "count", beginSession, endSession, applySnapshot },
    accountScopes,
    randomToken: () => "test_desktop_bridge_token_0123456789abcdef",
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs })
  });
  bridges.push(bridge);
  bridge.activateSession("session-1");
  return { accountScopes, applySnapshot, beginSession, bridge, endSession, submit };
}

async function rpc(
  bridge: DesktopCapabilityBridge,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(bridge.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.token}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function action(actionName: string, payload: unknown, sessionId = "session-1") {
  return { schemaVersion: 1, sessionId, action: actionName, payload };
}

describe("desktop capability bridge", () => {
  test("refuses weak or non-Base64URL bridge tokens", async () => {
    await expect(startDesktopCapabilityBridge({
      notifications: { submit: vi.fn() },
      notificationSupported: () => true,
      badges: {
        mode: "count",
        beginSession: vi.fn(() => ({ accepted: true, outcome: "accepted" } as const)),
        endSession: vi.fn(() => ({ accepted: true, outcome: "accepted" } as const)),
        applySnapshot: vi.fn(() => ({ accepted: true, outcome: "accepted" } as const))
      },
      randomToken: () => "weak token"
    })).rejects.toThrow(/token is invalid/i);
  });

  test("binds a token-authenticated loopback endpoint and exposes only bounded capabilities", async () => {
    const { beginSession, bridge } = await fixture();
    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
    expect(new URL(bridge.url).pathname).toBe("/v1/actions");
    expect(bridge.limits).toEqual({
      maxBodyBytes: 16 * 1_024,
      maxConnections: 16,
      requestTimeoutMs: 5_000
    });
    expect(Object.isFrozen(bridge.limits)).toBe(true);
    expect(beginSession).toHaveBeenCalledOnce();

    const result = await rpc(bridge, action("capabilities.get", {}));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        sessionId: "session-1",
        capabilities: {
          notificationShow: true,
          badgeApplySnapshot: { mode: "count" },
          accountScope: { version: 1 }
        }
      }
    });
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects missing credentials, browser origins, stale leases, and schema expansion", async () => {
    const { bridge, submit } = await fixture();
    const unauthorized = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action("capabilities.get", {}))
    });
    expect(unauthorized.status).toBe(401);

    expect((await rpc(bridge, action("capabilities.get", {}), { origin: "http://attacker.test" })).status)
      .toBe(403);
    expect((await rpc(bridge, action("notification.show", notificationPayload, "stale-session"))).status)
      .toBe(409);
    expect((await rpc(bridge, {
      ...action("notification.show", notificationPayload),
      token: "must-not-be-accepted-in-body"
    })).status).toBe(400);
    expect((await rpc(bridge, action("notification.show", {
      ...notificationPayload,
      accountId: "must-not-cross-native-boundary"
    }))).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  test("routes notification and badge actions without claiming native display", async () => {
    const { applySnapshot, bridge, submit } = await fixture();
    const notification = await rpc(bridge, action("notification.show", notificationPayload));
    expect(notification).toMatchObject({
      status: 200,
      body: { ok: true, value: { accepted: true, outcome: "accepted" } }
    });
    expect(submit).toHaveBeenCalledWith(notificationPayload);

    const badgePayload = { generation: 2, revision: 8, count: 4 };
    const badge = await rpc(bridge, action("badge.applySnapshot", badgePayload));
    expect(badge).toMatchObject({
      status: 200,
      body: { ok: true, value: { accepted: true, outcome: "accepted" } }
    });
    expect(applySnapshot).toHaveBeenCalledWith(badgePayload);
  });

  test("routes bounded account-scope transitions through the active Host lease", async () => {
    const { accountScopes, bridge } = await fixture();
    const identity = { kind: "account", userId: 42, claimCurrentGuest: false };

    expect(await rpc(bridge, action("account.scope.attest", identity))).toMatchObject({
      status: 200, body: { ok: true, value: { status: "ready" } }
    });
    expect(await rpc(bridge, action("account.scope.prepare", identity))).toMatchObject({
      status: 200, body: { ok: true, value: { transitionRef: "transition-1" } }
    });
    expect(await rpc(bridge, action("account.scope.commit", { transitionRef: "transition-1" }))).toMatchObject({
      status: 200, body: { ok: true, value: { status: "relaunch" } }
    });
    expect(await rpc(bridge, action("account.scope.abort", { transitionRef: "transition-1" }))).toMatchObject({
      status: 200, body: { ok: true, value: { status: "ready" } }
    });
    expect(accountScopes.attest).toHaveBeenCalledWith(identity);
    expect(accountScopes.prepare).toHaveBeenCalledWith(identity);
    expect(accountScopes.commit).toHaveBeenCalledWith("transition-1");
    expect(accountScopes.abort).toHaveBeenCalledWith("transition-1");

    expect((await rpc(bridge, action("account.scope.attest", { kind: "account", userId: 0 }))).status).toBe(400);
    expect((await rpc(bridge, action("account.scope.commit", { transitionRef: "../scope" }))).status).toBe(400);
  });

  test("rotates the active Harness lease and rejects the previous process", async () => {
    const { beginSession, bridge, endSession } = await fixture();
    bridge.activateSession("session-2");
    expect(beginSession).toHaveBeenCalledTimes(2);
    expect((await rpc(bridge, action("capabilities.get", {}, "session-1"))).status).toBe(409);
    expect((await rpc(bridge, action("capabilities.get", {}, "session-2"))).status).toBe(200);
    bridge.deactivateSession("session-1");
    expect(endSession).not.toHaveBeenCalled();
    expect((await rpc(bridge, action("capabilities.get", {}, "session-2"))).status).toBe(200);
    bridge.deactivateSession("session-2");
    expect(endSession).toHaveBeenCalledOnce();
    expect((await rpc(bridge, action("capabilities.get", {}, "session-2"))).status).toBe(409);
  });

  test("clears badge state when closing an active bridge session", async () => {
    const { bridge, endSession } = await fixture();
    await bridge.close();
    expect(endSession).toHaveBeenCalledOnce();
  });

  test("bounds UTF-8 request bytes and times out incomplete bodies", async () => {
    const { bridge } = await fixture({ timeoutMs: 30 });
    const oversized = await rpc(bridge, action("notification.show", {
      ...notificationPayload,
      presentation: { title: "群聊", body: "你".repeat(6_000) }
    }));
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ ok: false, error: { code: "payload_too_large" } });

    const timedOut = await incompleteRequest(bridge);
    expect(timedOut).toEqual({ status: 408, body: { ok: false, error: { code: "request_timeout" } } });
  });
});

function incompleteRequest(bridge: DesktopCapabilityBridge): Promise<{ status: number; body: unknown }> {
  const url = new URL(bridge.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
        "content-length": "100"
      }
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        });
      });
    });
    request.once("error", reject);
    request.flushHeaders();
  });
}
