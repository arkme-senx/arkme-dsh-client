import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export function buildDirectoryPickerBridgeResponse(path: string | null): { canceled: true } | { canceled: false; path: string } {
  return path === null ? { canceled: true } : { canceled: false, path };
}

export interface DirectoryPickerBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}

export async function startDirectoryPickerBridge(
  chooseDirectory: (title: string) => Promise<string | null>
): Promise<DirectoryPickerBridge> {
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, chooseDirectory);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Directory picker bridge did not receive a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/choose-directory`,
    token,
    close: () => closeServer(server)
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  chooseDirectory: (title: string) => Promise<string | null>
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/choose-directory" || request.headers["x-arkme-picker-token"] !== token) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readBody(request);
    const title = typeof body.title === "string" && body.title.length > 0 ? body.title : "选择文件夹";
    const selected = await chooseDirectory(title);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(buildDirectoryPickerBridgeResponse(selected)));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function readBody(request: IncomingMessage): Promise<{ title?: unknown }> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  if (text.length > 4096) throw new Error("Directory picker request is too large");
  const parsed: unknown = JSON.parse(text || "{}");
  return parsed !== null && typeof parsed === "object" ? parsed as { title?: unknown } : {};
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
