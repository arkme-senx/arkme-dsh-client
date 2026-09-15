import { macWifiSsid } from "./macos-wifi.js";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type DesktopNetworkType = "wifi" | "ethernet" | "cellular" | "vpn" | "bluetooth" | "unknown";
export interface DesktopDeviceSnapshot {
  schemaVersion: 1;
  computerName: string;
  networkType: DesktopNetworkType;
  wifiSsid?: string;
}

async function readSystemText(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf8", timeout: 600, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C" }
    });
    return stdout.trim();
  } catch { return ""; }
}

export function macNetworkType(route: string, ports: string): DesktopNetworkType {
  const device = /^\s*interface:\s*(\S+)\s*$/m.exec(route)?.[1];
  if (!device) return "unknown";
  if (/^(utun|ipsec|ppp)\d+$/.test(device)) return "vpn";
  for (const block of ports.split(/\r?\n\s*\r?\n/)) {
    if (/^Device:\s*(\S+)\s*$/m.exec(block)?.[1] !== device) continue;
    const port = /^Hardware Port:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    if (/^(Wi-Fi|AirPort)$/i.test(port)) return "wifi";
    if (/Ethernet|Thunderbolt/i.test(port)) return "ethernet";
    if (/Bluetooth/i.test(port)) return "bluetooth";
  }
  return "unknown";
}

export function createDesktopDeviceReader(
  platform = process.platform,
  readText = readSystemText,
  fallbackName = hostname,
  readSsid = macWifiSsid,
): () => Promise<DesktopDeviceSnapshot> {
  let pending: Promise<DesktopDeviceSnapshot> | undefined;
  return () => pending ??= (async (): Promise<DesktopDeviceSnapshot> => {
    if (platform !== "darwin") return {
      schemaVersion: 1, computerName: fallbackName().slice(0, 80), networkType: "unknown",
    };
    const [name, route, ports] = await Promise.all([
      readText("/usr/sbin/scutil", ["--get", "ComputerName"]),
      readText("/sbin/route", ["-n", "get", "default"]),
      readText("/usr/sbin/networksetup", ["-listallhardwareports"]),
    ]);
    const networkType = macNetworkType(route, ports);
    const interfaceName = /^\s*interface:\s*(\S+)\s*$/m.exec(route)?.[1];
    const wifiSsid = networkType === "wifi" && interfaceName ? readSsid(interfaceName) : undefined;
    return {
      schemaVersion: 1,
      ...(wifiSsid === undefined ? {} : { wifiSsid }),
      computerName: (name.trim() || fallbackName()).slice(0, 80),
      networkType,
    };
  })().finally(() => { pending = undefined; });
}
