import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("standalone Harness runtime", () => {
  test("pins the selected Harness release, the production Arkme plugin, and its package manager", async () => {
    const manifestPath = path.join(process.cwd(), "runtime", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(manifest.dependencies).toEqual({
      "@deepseek-ai/cordis": "4.0.1",
      "@deepseek-ai/cosmokit": "1.8.2",
      "@deepseek-ai/dsh": "0.1.1-rc.2",
      "@deepseek-ai/dsh-anonymous-user-id": "0.1.1-rc.2",
      "@deepseek-ai/dsh-app-boot": "0.1.1-rc.2",
      "@deepseek-ai/dsh-attachment": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-locale": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-runtime": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-ui-layout": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-ui-primitives": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-ui-settings": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-ui-sidebar": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-ui-slots": "0.1.1-rc.2",
      "@deepseek-ai/dsh-client-ui-theme": "0.1.1-rc.2",
      "@deepseek-ai/dsh-host-webserver": "0.1.1-rc.2",
      "@deepseek-ai/dsh-host-directory-picker-native": "0.1.1-rc.2",
      "@deepseek-ai/dsh-llm": "0.1.1-rc.2",
      "@deepseek-ai/dsh-llm-deepseek": "0.1.1-rc.2",
      "@deepseek-ai/dsh-system-prompt": "0.1.1-rc.2",
      "@deepseek-ai/dsh-tools": "0.1.1-rc.2",
      "@deepseek-ai/schemastery": "3.18.1",
      "@senguoyun/dsh-arkme": "catalog:production",
      "ali-oss": "6.23.0",
      "js-yaml": "4.2.0",
      "pnpm": "11.19.0",
      "qrcode-generator": "2.0.4",
      "react": "18.3.1",
      "react-dom": "18.3.1"
    });
    expect(manifest.scripts).toBeUndefined();
  });
});
