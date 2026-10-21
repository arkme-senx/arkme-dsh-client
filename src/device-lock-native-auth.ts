import { spawn } from "node:child_process";
import path from "node:path";

export function deviceAuthExecutable(resources: string, platform = process.platform): string {
  if (platform === "darwin") return path.join(resources, "device-auth", "即我解锁验证.app", "Contents", "MacOS", "device-auth-probe");
  if (platform === "win32") return path.join(resources, "device-auth", "device-auth-probe.exe");
  throw new Error("当前平台暂不支持电脑密码解锁");
}

// Credentials stay inside the OS helper. Only its bounded result is accepted;
// neither renderer nor Host can supply an authenticated flag.
export async function runDeviceAuthentication(executable: string, mode: "--check" | "--authenticate", signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>(resolve => {
    const child = spawn(executable, [mode], { shell: false, windowsHide: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(success);
    };
    const abort = () => { child.kill(); finish(false); };
    const timer = setTimeout(abort, mode === "--check" ? 10_000 : 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 4_096) abort();
    });
    child.once("error", () => finish(false));
    // `exit` can precede the last stdout chunk; consume only after the pipe closes.
    child.once("close", code => {
      try {
        const value = JSON.parse(output) as Record<string, unknown>;
        finish(code === 0 && value.schemaVersion === 1 && value.platform === process.platform
          && value.outcome === (mode === "--check" ? "available" : "authenticated"));
      } catch { finish(false); }
    });
  });
}
