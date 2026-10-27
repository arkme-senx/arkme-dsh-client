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

export async function readDesktopComputerName(
  platform = process.platform,
  readText = readSystemText,
  fallbackName = hostname,
): Promise<string> {
  const systemName = platform === "darwin"
    ? await readText("/usr/sbin/scutil", ["--get", "ComputerName"]).catch(() => "")
    : "";
  const name = systemName.trim() || fallbackName().trim();
  let result = "";
  for (const character of name) {
    // Device registration accepts 120 UTF-8 bytes; do not split Chinese or emoji.
    if (result.length + character.length > 80 || Buffer.byteLength(result + character, "utf8") > 120) break;
    result += character;
  }
  return result;
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
  // The machine name is stable for this reader's lifetime; network facts remain fresh.
  let computerName: Promise<string> | undefined;
  return () => pending ??= (async (): Promise<DesktopDeviceSnapshot> => {
    if (platform !== "darwin") return {
      schemaVersion: 1, computerName: await readDesktopComputerName(platform, readText, fallbackName), networkType: "unknown",
    };
    const [name, route, ports] = await Promise.all([
      computerName ??= readDesktopComputerName(platform, readText, fallbackName),
      readText("/sbin/route", ["-n", "get", "default"]),
      readText("/usr/sbin/networksetup", ["-listallhardwareports"]),
    ]);
    const networkType = macNetworkType(route, ports);
    const interfaceName = /^\s*interface:\s*(\S+)\s*$/m.exec(route)?.[1];
    const wifiSsid = networkType === "wifi" && interfaceName ? readSsid(interfaceName) : undefined;
    return {
      schemaVersion: 1,
      ...(wifiSsid === undefined ? {} : { wifiSsid }),
      computerName: name,
      networkType,
    };
  })().finally(() => { pending = undefined; });
}
