import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const host = option("--host") ?? "127.0.0.1";
const port = Number(option("--port"));
if (!Number.isInteger(port) || port <= 0) throw new Error("A valid --port is required");

const server = http.createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/host.describe") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: requestBody.rpcId,
      result: {
        ok: true,
        value: {
          version: "0.1.0-rc.8",
          cwd: process.cwd(),
          attachedSessions: 0,
          home: process.env.DSH_HOME ?? process.cwd(),
          canOpenPath: true
        }
      }
    }));
    return;
  }

  if (request.method === "POST" && request.url === "/api/workspace.create") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const workspacePath = requestBody.payload?.path;
    const registrationStatePath = process.env.DSH_HOME === undefined
      ? undefined
      : path.join(process.env.DSH_HOME, "mock-workspace-registrations.json");
    let registrationCount = 0;
    if (registrationStatePath !== undefined) {
      try {
        const state = JSON.parse(await readFile(registrationStatePath, "utf8"));
        if (typeof state.count === "number") registrationCount = state.count;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    registrationCount += 1;
    const created = registrationCount === 1;
    if (registrationStatePath !== undefined) {
      await writeFile(registrationStatePath, JSON.stringify({
        count: registrationCount,
        mostRecentCreated: created
      }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: requestBody.rpcId,
      result: {
        ok: true,
        value: {
          workspace: {
            workspaceId: "mock-workspace",
            path: workspacePath,
            title: path.basename(workspacePath),
            sessionIds: [],
            createdAt: "2026-08-20T00:00:00.000Z",
            updatedAt: "2026-08-20T00:00:00.000Z"
          },
          created
        }
      }
    }));
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Mock Harness</title>");
  if (request.url === "/managed-restart"
    && process.env.ARKME_DESKTOP_MANAGED_RESTART === "1") {
    server.close(() => process.exit(75));
  }
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen(port, host, async () => {
  if (process.env.DSH_HOME !== undefined) {
    await writeFile(path.join(process.env.DSH_HOME, "mock.ppid"), `${process.ppid}\n`);
    // PID is the readiness marker for integration tests, so publish it last.
    await writeFile(path.join(process.env.DSH_HOME, "mock.pid"), `${process.pid}\n`);
  }
  console.log(`mock harness ready at http://${host}:${port}/`);
});
