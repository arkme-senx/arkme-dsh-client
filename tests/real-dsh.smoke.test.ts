import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { provisionArkmeWebProfile } from "../src/plugin-profile.js";
import { allocateLoopbackPort } from "../src/port.js";
import {
  developmentArkmePluginPath,
  developmentDshBinPath
} from "../src/runtime-path.js";

const runSmoke = process.env.RUN_REAL_DSH_SMOKE === "1";

describe.skipIf(!runSmoke)("real DeepSeek Harness integration", () => {
  test(
    "starts the Web UI with the embedded Arkme plugin and no system Node on PATH",
    async () => {
      const require = createRequire(import.meta.url);
      const electronBinary = path.resolve(
        process.env.PACKAGED_ELECTRON_BINARY ?? (require("electron") as string)
      );
      const root = await mkdtemp(path.join(tmpdir(), "jotmo-real-dsh-"));
      const workspace = await mkdtemp(path.join(tmpdir(), "jotmo-real-workspace-"));
      const port = await allocateLoopbackPort();
      const dshBinPath = path.resolve(
        process.env.PACKAGED_DSH_BIN ?? developmentDshBinPath(import.meta.url)
      );
      const arkmePluginPath = path.resolve(
        process.env.PACKAGED_ARKME_PLUGIN
          ?? developmentArkmePluginPath(import.meta.url, process.env)
      );
      const dshHome = path.join(root, "dsh");
      await provisionArkmeWebProfile({ dshHome, pluginDir: arkmePluginPath });
      const output: string[] = [];
      const child = spawn(
        electronBinary,
        [
          "--expose-internals",
          dshBinPath,
          "web",
          "--host",
          "127.0.0.1",
          "--port",
          String(port)
        ],
        {
          cwd: workspace,
          detached: true,
          env: {
            DSH_HOME: dshHome,
            ELECTRON_RUN_AS_NODE: "1",
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      child.stdout.on("data", (chunk) => output.push(chunk.toString()));
      child.stderr.on("data", (chunk) => output.push(chunk.toString()));

      try {
        const capabilities = await waitForArkmePlugin(
          `http://127.0.0.1:${port}/arkme-self/api`,
          child,
          output
        );
        expect(capabilities).toMatchObject({
          ok: true,
          value: {
            provider: "@senguoyun/dsh-arkme",
            environment: "prod"
          }
        });
        const response = await waitForServer(`http://127.0.0.1:${port}/`, child, output);
        expect(response.ok).toBe(true);
        expect(response.headers.get("content-type")).toContain("text/html");
      } finally {
        if (
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          process.kill(-child.pid, "SIGTERM");
          const stopped = await Promise.race([
            once(child, "exit").then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 7_000))
          ]);
          if (!stopped && child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid, "SIGKILL");
            await Promise.race([
              once(child, "exit"),
              new Promise((resolve) => setTimeout(resolve, 1_000))
            ]);
            throw new Error("dsh did not exit within 7 seconds after SIGTERM");
          }
        }
      }
    },
    45_000
  );
});

async function waitForServer(
  url: string,
  child: ReturnType<typeof spawn>,
  output: string[]
): Promise<Response> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited with code ${child.exitCode}\n${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.arrayBuffer();
        return response;
      }
    } catch {
      // The server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`dsh did not become ready\n${output.join("")}`);
}

async function waitForArkmePlugin(
  url: string,
  child: ReturnType<typeof spawn>,
  output: string[]
): Promise<unknown> {
  const deadline = Date.now() + 30_000;
  let lastResponse = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited before Arkme loaded with code ${child.exitCode}\n${output.join("")}`);
    }
    try {
      const response = await postJson(url, { operation: "provider.capabilities" });
      lastResponse = `${response.status} ${response.contentType} ${response.body.slice(0, 500)}`;
      if (response.contentType.includes("application/json")) {
        const body = JSON.parse(response.body) as {
          ok?: boolean;
          value?: { provider?: string };
        };
        if (body.ok === true && body.value?.provider === "@senguoyun/dsh-arkme") {
          return body;
        }
      }
    } catch {
      // The plugin route is not mounted yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Arkme plugin did not become ready\nlast response: ${lastResponse}\n${output.join("")}`);
}

async function postJson(url: string, body: unknown): Promise<{ status: number; contentType: string; body: string }> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        contentType: res.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
