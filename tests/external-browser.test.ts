import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
vi.mock("electron", () => ({
  shell: { openExternal: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));
import { dialog, shell } from "electron";
import { openExternalBrowser } from "../src/external-browser.js";

beforeEach(() => vi.resetAllMocks());

it("hands the admitted URL to the default browser", async () => {
  const window = { isDestroyed: () => false } as BrowserWindow;
  await openExternalBrowser(window, "http://www.google.com/");
  expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("http://www.google.com/");
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
});

it("shows a failure message without an unhandled rejection", async () => {
  vi.mocked(shell.openExternal).mockRejectedValue(new Error("No default browser"));
  vi.mocked(dialog.showMessageBox).mockRejectedValue(new Error("Window closed"));
  const window = { isDestroyed: () => false } as BrowserWindow;
  await expect(openExternalBrowser(window, "https://example.com/")).resolves.toBeUndefined();
  expect(dialog.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({ message: "无法打开链接" }));
});

it("does not show a failure message after the source window closes", async () => {
  vi.mocked(shell.openExternal).mockRejectedValue(new Error("No default browser"));
  await openExternalBrowser({ isDestroyed: () => true } as BrowserWindow, "https://example.com/");
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
});
