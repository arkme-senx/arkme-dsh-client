import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  reconcilePendingAppUpdateInstall,
  writePendingAppUpdateInstall,
} from "../src/app-update-install-receipt.js";

describe("app update install receipt", () => {
  test("keeps an incomplete install receipt and clears it once the target Version Code is running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-install-receipt-"));
    const receiptPath = path.join(root, "app-update-install.json");
    await writePendingAppUpdateInstall(receiptPath, { version: "1.1.0", versionCode: 3 });
    await expect(reconcilePendingAppUpdateInstall(receiptPath, 2)).resolves.toEqual({
      outcome: "incomplete",
      target: { version: "1.1.0", versionCode: 3 },
    });
    await expect(readFile(receiptPath, "utf8")).resolves.toContain('"versionCode": 3');
    await expect(reconcilePendingAppUpdateInstall(receiptPath, 3)).resolves.toEqual({
      outcome: "succeeded",
      target: { version: "1.1.0", versionCode: 3 },
    });
    await expect(reconcilePendingAppUpdateInstall(receiptPath, 3)).resolves.toEqual({ outcome: "none" });
    await rm(root, { recursive: true, force: true });
  });
});
