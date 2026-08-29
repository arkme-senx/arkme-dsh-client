import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type Pnpmfile = {
  hooks: {
    readPackage: (manifest: Record<string, any>) => Record<string, any>;
  };
};

describe("pnpm DSH release pin", () => {
  test("pins every DSH dependency section to the runtime manifest release", () => {
    const require = createRequire(import.meta.url);
    let pnpmfile: Pnpmfile | undefined;
    try {
      pnpmfile = require("../.pnpmfile.cjs") as Pnpmfile;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }

    expect(pnpmfile).toBeDefined();
    if (pnpmfile === undefined) return;

    expect(pnpmfile.hooks.readPackage({
      dependencies: {
        "@deepseek-ai/dsh-llm-pi-ai": "^0.1.1-rc.1",
        "ordinary-package": "^1.0.0"
      },
      devDependencies: {
        "@deepseek-ai/dsh": "latest"
      },
      optionalDependencies: {
        "@deepseek-ai/dsh-attachment-local": ">=0.1.0"
      },
      peerDependencies: {
        "@deepseek-ai/dsh-llm": "^0.1.0-rc.5",
        "@deepseek-ai/dshark": "^1.0.0"
      }
    })).toEqual({
      dependencies: {
        "@deepseek-ai/dsh-llm-pi-ai": "0.1.1-rc.2",
        "ordinary-package": "^1.0.0"
      },
      devDependencies: {
        "@deepseek-ai/dsh": "0.1.1-rc.2"
      },
      optionalDependencies: {
        "@deepseek-ai/dsh-attachment-local": "0.1.1-rc.2"
      },
      peerDependencies: {
        "@deepseek-ai/dsh-llm": "0.1.1-rc.2",
        "@deepseek-ai/dshark": "^1.0.0"
      }
    });
  });
});
