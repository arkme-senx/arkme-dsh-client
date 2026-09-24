import { describe, expect, it, vi } from "vitest";
import { createDesktopDeviceReader, macNetworkType } from "../src/desktop-device.js";

const ports = "Hardware Port: Ethernet Adapter\nDevice: en5\n\nHardware Port: Wi-Fi\nDevice: en7\n";
describe("desktop device snapshot", () => {
  it.each([
    ["en7", "wifi"], ["en5", "ethernet"], ["utun3", "vpn"], ["missing", "unknown"]
  ])("uses the active interface %s, not the first installed adapter", (device, expected) => {
    expect(macNetworkType(`  interface: ${device}\n`, ports)).toBe(expected);
  });
  it("preserves computer names with spaces, joins concurrent reads and refreshes next time", async () => {
    const read = vi.fn(async (file: string) => file.endsWith("scutil") ? "我的 MacBook Pro" : file.endsWith("route") ? "interface: en7" : ports);
    const snapshot = createDesktopDeviceReader("darwin", read, () => "fallback", () => undefined);
    const a = snapshot();
    expect(snapshot()).toBe(a);
    expect(await a).toEqual({ schemaVersion: 1, computerName: "我的 MacBook Pro", networkType: "wifi" });
    expect(read).toHaveBeenCalledTimes(3);
    await snapshot();
    expect(read).toHaveBeenCalledTimes(5);
    expect(read.mock.calls.filter(([file]) => file.endsWith("scutil"))).toHaveLength(1);
  });
  it("falls back without guessing when OS commands fail or the platform is unsupported", async () => {
    const read = vi.fn(async () => "");
    expect(await createDesktopDeviceReader("darwin", read, () => "My Computer")()).toEqual({
      schemaVersion: 1, computerName: "My Computer", networkType: "unknown"
    });
    read.mockClear();
    expect((await createDesktopDeviceReader("win32", read, () => "PC")()).computerName).toBe("PC");
    expect(read).not.toHaveBeenCalled();
  });
});

it("reads the SSID only for the active Wi-Fi interface and does not cache it", async () => {
  const read = vi.fn(async (file: string) => file.endsWith("scutil") ? "Mac" : file.endsWith("route") ? "interface: en7" : ports);
  const ssid = vi.fn(() => "senguoyun_5G");
  const snapshot = createDesktopDeviceReader("darwin", read, () => "Mac", ssid);
  expect((await snapshot()).wifiSsid).toBe("senguoyun_5G");
  expect(ssid).toHaveBeenCalledWith("en7");
  ssid.mockReturnValue("Guest WiFi");
  expect((await snapshot()).wifiSsid).toBe("Guest WiFi");
  const ethernet = createDesktopDeviceReader("darwin", async file => file.endsWith("route") ? "interface: en5" : ports, () => "Mac", ssid);
  ssid.mockClear();
  expect((await ethernet()).wifiSsid).toBeUndefined();
  expect(ssid).not.toHaveBeenCalled();
});
