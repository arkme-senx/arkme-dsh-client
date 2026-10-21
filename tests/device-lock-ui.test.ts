import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { DeviceLockSnapshot } from "../src/device-lock-owner.js";

const locked: DeviceLockSnapshot = { supported: true, locked: true, sessionEnded: false,
  needsCredentials: false, platform: "macos", message: "请在手机即我上确认解锁" };
const ended: DeviceLockSnapshot = { ...locked, sessionEnded: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function fixture() {
  const [html, script] = await Promise.all([
    readFile(new URL("../src/ui/device-lock.html", import.meta.url), "utf8"),
    readFile(new URL("../src/ui/device-lock.js", import.meta.url), "utf8")
  ]);
  const elements = new Map<string, { hidden: boolean; disabled: boolean; textContent: string;
    addEventListener: ReturnType<typeof vi.fn>; toggleAttribute: (name: string, value: boolean) => void }>();
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1]!, { hidden: /\shidden(?:\s|>|=)/.test(match[0]), disabled: false, textContent: "", addEventListener: vi.fn(),
      toggleAttribute(name, value) { if (name === "hidden") this.hidden = value; } });
  }
  const initial = deferred<DeviceLockSnapshot | null>();
  const proof = deferred<DeviceLockSnapshot>();
  const unlock = vi.fn(() => proof.promise);
  let changed!: (value: DeviceLockSnapshot) => void;
  const document = { title: "即我", getElementById: (id: string) => elements.get(id) };
  vm.runInNewContext(script, { document, window: { deviceLock: {
    snapshot: () => initial.promise, changed: (listener: typeof changed) => { changed = listener; }, unlock
  } } });
  return { elements, document, initial, proof, unlock, changed,
    click: () => elements.get("unlock")!.addEventListener.mock.calls[0]![1]() as Promise<void> };
}

describe("device protection presentation", () => {
  it("keeps the first frame neutral until the native owner supplies the real state", async () => {
    const f = await fixture();
    expect(f.elements.get("surface")?.hidden).toBe(true);
    f.initial.resolve(null); await f.initial.promise;
    expect(f.elements.get("surface")?.hidden).toBe(true);
  });
  it("shows only logout feedback while the ended session is still protected", async () => {
    const f = await fixture();
    f.initial.resolve(ended); await f.initial.promise;
    expect(f.elements.get("surface")?.hidden).toBe(false);
    expect(f.elements.get("title")?.textContent).toBe("正在退出登录…");
    expect(f.document.title).toBe("正在退出登录…");
    for (const id of ["illustration", "message", "unlock"]) expect(f.elements.get(id)?.hidden).toBe(true);
    await f.click();
    expect(f.unlock).not.toHaveBeenCalled();
  });
  it("does not let a late initial lock snapshot overwrite a newer logout event", async () => {
    const f = await fixture();
    f.changed(ended);
    f.initial.resolve(locked); await f.initial.promise;
    expect(f.elements.get("title")?.textContent).toBe("正在退出登录…");
    expect(f.elements.get("unlock")?.hidden).toBe(true);
  });
  it("never renders a lock page when native cleanup has already released protection", async () => {
    const f = await fixture();
    f.initial.resolve({ ...locked, locked: false }); await f.initial.promise;
    expect(f.elements.get("surface")?.hidden).toBe(true);
    await f.click(); expect(f.unlock).not.toHaveBeenCalled();
  });
  it.each(["macos", "windows"] as const)("preserves %s lock and password fallback interaction", async platform => {
    const f = await fixture();
    f.initial.resolve({ ...locked, platform, operationState: "awaiting_confirmation" }); await f.initial.promise;
    expect(f.elements.get("title")?.textContent).toBe(`${platform === "macos" ? "Mac" : "Windows"} 即我已锁定`);
    for (const id of ["illustration", "message", "unlock"]) expect(f.elements.get(id)?.hidden).toBe(false);
    expect(f.elements.get("unlock")?.textContent).toBe("使用电脑密码解锁");
    const click = f.click();
    expect(f.elements.get("unlock")?.disabled).toBe(true);
    expect(f.elements.get("unlock")?.textContent).toBe("正在验证…");
    await f.click(); expect(f.unlock).toHaveBeenCalledOnce();
    f.changed(ended);
    f.proof.resolve(locked); await click;
    expect(f.elements.get("title")?.textContent).toBe("正在退出登录…");
    expect(f.elements.get("unlock")?.hidden).toBe(true);
  });
});
