import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { APP_UPDATE_NOTICE_CSS } from "../src/app-update-notice.js";
import { RUNTIME_UPDATE_NOTICE_CSS } from "../src/runtime-update-notice.js";
import { installMacWindowDragRegion } from "../src/mac-window-drag.js";

test.skipIf(process.platform !== "darwin")("excludes update cards from native header dragging without excluding surrounding whitespace", async () => {
  let script = "";
  await installMacWindowDragRegion("darwin", {
    isDestroyed: () => false,
    webContents: { executeJavaScript: async value => { script = value; } }
  });
  const env: NodeJS.ProcessEnv = { ...process.env, ARKME_TEST_DRAG_SCRIPT: script,
    ARKME_TEST_UPDATE_CSS: RUNTIME_UPDATE_NOTICE_CSS + APP_UPDATE_NOTICE_CSS };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)("electron") as string;
  const { stdout } = await promisify(execFile)(electron, [
    fileURLToPath(new URL("./fixtures/update-notice-drag.cjs", import.meta.url))
  ], { env, timeout: 25_000 });
  expect(stdout).toContain("update notice drag passed");
}, 30_000);
