import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { allocateLoopbackPort } from "../src/port.js";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

describe("allocateLoopbackPort", () => {
  test("returns a free TCP port on loopback", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);

    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });

    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
  });
});
