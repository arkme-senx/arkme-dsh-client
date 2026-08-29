import { describe, expect, test } from "vitest";
import { preparePackagedPluginForLaunch } from "../src/plugin-startup.js";

const profileDir = "/user/dsh/profiles/web";
const profilePluginDir = "/user/dsh/profiles/web/node_modules/@senguoyun/dsh-arkme";
const artifact = {
  artifactPath: "/user/dsh/arkme-self/plugin-seed/0.1.17/dsh-arkme.tgz",
  artifactSha512: "a".repeat(128),
  packageName: "@senguoyun/dsh-arkme" as const,
  version: "0.1.17"
};
const startupOptions = {
  resourcesPath: "/app/resources",
  dshHome: "/user/dsh",
  appVersion: "0.1.5",
  dshVersion: "0.1.0-rc.8",
  profileName: "web",
  packageManager: {
    executable: "/app/electron",
    prefixArgs: ["/app/pnpm.cjs"]
  }
};

describe("preparePackagedPluginForLaunch", () => {
  test("provisions the local plugin recorded by a packaged test app without running installer bootstrap", async () => {
    const events: string[] = [];
    const localPluginDir = "/workspace/arkme-dsh-plugin";

    const pluginDir = await preparePackagedPluginForLaunch(startupOptions, {
      readTestPluginPath: async () => localPluginDir,
      prepareBootstrap: async () => {
        events.push("prepare");
        return { artifact, profilePluginDir, resetRequired: true };
      },
      provisionProfile: async (options) => {
        events.push("provision");
        expect(options.pluginDir).toBe(localPluginDir);
        expect(options.embeddedArtifact).toBeUndefined();
        return { profileDir, pluginDir: profilePluginDir, source: "embedded", version: "0.1.22" };
      },
      completeBootstrap: async () => {
        events.push("complete");
      }
    });

    expect(pluginDir).toBe(profilePluginDir);
    expect(events).toEqual(["provision"]);
  });

  test("prepares, provisions, and completes the installer bootstrap in order", async () => {
    const events: string[] = [];

    const pluginDir = await preparePackagedPluginForLaunch(startupOptions, {
      prepareBootstrap: async () => {
        events.push("prepare");
        return { artifact, profilePluginDir, resetRequired: true };
      },
      provisionProfile: async () => {
        events.push("provision");
        return { profileDir, pluginDir: profilePluginDir, source: "embedded", version: "0.1.17" };
      },
      completeBootstrap: async () => {
        events.push("complete");
      }
    });

    expect(pluginDir).toBe(profilePluginDir);
    expect(events).toEqual(["prepare", "provision", "complete"]);
  });

  test("forces the embedded seed when the installer receipt needs refresh", async () => {
    let forceEmbedded: boolean | undefined;

    await preparePackagedPluginForLaunch(startupOptions, {
      prepareBootstrap: async () => ({ artifact, profilePluginDir, resetRequired: true }),
      provisionProfile: async (options) => {
        forceEmbedded = options.forceEmbedded;
        expect(options.embeddedArtifact).toEqual(artifact);
        return { profileDir, pluginDir: profilePluginDir, source: "embedded", version: "0.1.17" };
      },
      completeBootstrap: async () => undefined
    });

    expect(forceEmbedded).toBe(true);
  });

  test("records the embedded version selected during an installer refresh", async () => {
    let completedVersion: string | undefined;

    const pluginDir = await preparePackagedPluginForLaunch(startupOptions, {
      prepareBootstrap: async () => ({ artifact, profilePluginDir, resetRequired: true }),
      provisionProfile: async (options) => {
        expect(options.forceEmbedded).toBe(true);
        return {
          profileDir,
          pluginDir: profilePluginDir,
          source: "embedded",
          version: "0.1.17"
        };
      },
      completeBootstrap: async (options) => {
        completedVersion = options.selectedPluginVersion;
      }
    });

    expect(pluginDir).toBe(profilePluginDir);
    expect(completedVersion).toBe("0.1.17");
  });

  test("does not write the bootstrap receipt after provisioning fails", async () => {
    const events: string[] = [];

    await expect(preparePackagedPluginForLaunch(startupOptions, {
      prepareBootstrap: async () => {
        events.push("prepare");
        return { artifact, profilePluginDir, resetRequired: true };
      },
      provisionProfile: async () => {
        events.push("provision");
        throw new Error("pnpm failed");
      },
      completeBootstrap: async () => {
        events.push("complete");
      }
    })).rejects.toThrow("pnpm failed");

    expect(events).toEqual(["prepare", "provision"]);
  });

  test("completes bootstrap against the independently selected plugin version", async () => {
    let selectedPluginVersion: string | undefined;

    await preparePackagedPluginForLaunch(startupOptions, {
      prepareBootstrap: async () => ({ artifact, profilePluginDir, resetRequired: false }),
      provisionProfile: async () => ({
        profileDir,
        pluginDir: profilePluginDir,
        source: "independent",
        version: "0.1.23"
      }),
      completeBootstrap: async (options) => {
        selectedPluginVersion = options.selectedPluginVersion;
      }
    });

    expect(selectedPluginVersion).toBe("0.1.23");
  });
});
