import { describe, expect, test } from "vitest";
import { buildDirectoryPickerBridgeResponse, startDirectoryPickerBridge } from "../src/directory-picker-bridge.js";

describe("directory picker bridge", () => {
  test("returns a selected path response", () => {
    expect(buildDirectoryPickerBridgeResponse("C:\\Projects\\demo")).toEqual({
      canceled: false,
      path: "C:\\Projects\\demo"
    });
  });

  test("returns a canceled response for no selection", () => {
    expect(buildDirectoryPickerBridgeResponse(null)).toEqual({ canceled: true });
  });

  test("serves Electron's selected directory over a token-authenticated request", async () => {
    const bridge = await startDirectoryPickerBridge(async (title) => {
      expect(title).toBe("Pick a project");
      return "C:\\Projects\\demo";
    });
    try {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-arkme-picker-token": bridge.token },
        body: JSON.stringify({ title: "Pick a project" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ canceled: false, path: "C:\\Projects\\demo" });
    } finally {
      await bridge.close();
    }
  });
});
