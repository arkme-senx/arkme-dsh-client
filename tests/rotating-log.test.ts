import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RotatingLog } from "../src/rotating-log.js";

test("rotates to three bounded files including a path with spaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arkme log test "));
  const file = join(directory, "harness.log");
  const log = new RotatingLog(file, 32);
  for (let i = 0; i < 8; i++) log.write(Buffer.alloc(20, 48 + i));
  await new Promise<void>(resolve => log.end(resolve));
  expect((await readdir(directory)).sort()).toEqual(["harness.log", "harness.log.1", "harness.log.2"]);
  expect(await readFile(file, "utf8")).toBe("7".repeat(20));
  for (const name of await readdir(directory)) expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(32);
});


test("accounts for lifecycle bytes appended by another writer before rotating", async () => {
  const { appendFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "arkme log external "));
  const file = join(directory, "harness.log");
  const log = new RotatingLog(file, 32);
  await new Promise<void>(resolve => log.write("a".repeat(10), () => resolve()));
  await appendFile(file, "b".repeat(20));
  await new Promise<void>(resolve => log.write("c".repeat(10), () => resolve()));
  await new Promise<void>(resolve => log.end(resolve));
  expect((await stat(file)).size).toBe(10);
  expect(await readFile(`${file}.1`, "utf8")).toBe("a".repeat(10)+"b".repeat(20));
});
