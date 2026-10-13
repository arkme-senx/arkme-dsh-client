import { describe, expect, it, vi } from "vitest";
import { DesktopBranding, resolveBrandLocale, registerDesktopBrandingIpc, BRANDING_LOCALE_CHANNEL, BRANDING_SNAPSHOT_CHANNEL } from "../src/desktop-branding.js";
import { resolveArkmeAppIdentity } from "../src/app-identity.js";

describe("desktop branding", () => {
  it.each(["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH_hans"])("uses 即我 for %s", locale => {
    expect(resolveBrandLocale(locale)).toBe("zh");
  });
  it.each(["en", "en-GB", "ja", "fr-FR", "", "zho"])("uses Arkme for every other language (%s)", locale => {
    expect(resolveBrandLocale(locale)).toBe("en");
  });
  it("switches both ways, rejects paths/images, and does not repeat native work", () => {
    const apply = vi.fn();
    const branding = new DesktopBranding(resolveArkmeAppIdentity("prod"), apply);
    expect(branding.setLocale("zh")).toBe(true);
    expect(branding.setLocale("zh")).toBe(true);
    expect(branding.setLocale("../../icon.png")).toBe(false);
    expect(branding.setLocale({ locale: "en", icon: "https://example.com/icon" })).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(branding.snapshot()).toEqual({ locale: "zh", name: "即我", icon: "jiwo.png" });
    branding.setLocale("en");
    expect(branding.snapshot()).toEqual({ locale: "en", name: "Arkme", icon: "arkme.png" });
    branding.setLocale("zh");
    expect(apply).toHaveBeenCalledTimes(3);
  });
  it("keeps the prior presentation when native image validation fails and allows retry", () => {
    const apply = vi.fn();
    const branding = new DesktopBranding(resolveArkmeAppIdentity("prod"), apply);
    branding.setLocale("zh");
    apply.mockImplementationOnce(() => { throw new Error("missing icon"); });
    expect(() => branding.setLocale("en")).toThrow("missing icon");
    expect(branding.snapshot()?.name).toBe("即我");
    expect(branding.setLocale("en")).toBe(true);
  });
  it("retains distinct test application names", () => {
    const branding = new DesktopBranding(resolveArkmeAppIdentity("prod", true), () => {});
    branding.setLocale("zh");
    expect(branding.snapshot()?.name).toBe("arkme Local Test");
    branding.setLocale("en");
    expect(branding.snapshot()?.name).toBe("arkme Local Test");
  });
  it("checks authority before applying any value or returning the snapshot", () => {
    type Sender = { trusted: boolean; returnValue?: unknown };
    const handlers = new Map<string, (event: Sender, value: unknown) => unknown>();
    const reads = new Map<string, (event: Sender & { returnValue: unknown }) => void>();
    const apply = vi.fn();
    const branding = new DesktopBranding(resolveArkmeAppIdentity("prod"), apply);
    registerDesktopBrandingIpc<Sender>({ handle: (key, fn) => { handlers.set(key, fn); }, on: (key, fn) => { reads.set(key, fn); } },
      branding, event => event.trusted, () => {});
    const set = handlers.get(BRANDING_LOCALE_CHANNEL)!;
    expect(set({ trusted: false }, "zh")).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(set({ trusted: true }, "en")).toBe(true);
    const unauthorized = { trusted: false, returnValue: undefined as unknown };
    reads.get(BRANDING_SNAPSHOT_CHANNEL)!(unauthorized);
    expect(unauthorized.returnValue).toBeNull();
  });
});
