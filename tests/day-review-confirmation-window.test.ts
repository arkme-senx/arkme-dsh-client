import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { acceptsDayReviewConfirmation, acceptsRecordingDeletionConfirmation, installDayReviewConfirmationWindow, isDayReviewConfirmationReceipt } from "../src/day-review-confirmation-window.js";

const origin = "http://127.0.0.1:3000";
const target = `${origin}/arkme-self/api?dayReviewConfirmation=00000000-0000-4000-8000-000000000000&action=resume&intent=%7B%7D`;
function windowStub() {
  const contents = Object.assign(new EventEmitter(), { getURL: () => origin, setWindowOpenHandler: vi.fn() });
  return Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, destroy: vi.fn(), close: vi.fn(), setMenu: vi.fn(), show: vi.fn(), focus: vi.fn() });
}
describe("day review confirmation window", () => {
  it("recognizes only the same confirmation's receipt redirect", () => {
    const receipt = target.replace('&action=resume&intent=%7B%7D', '&receipt=complete');
    expect(isDayReviewConfirmationReceipt(receipt, target)).toBe(true);
    for (const url of [target, receipt.replace(':3000', ':4000'), receipt.replace('/api?', '/else?'), receipt.replace('00000000-', '10000000-')]) expect(isDayReviewConfirmationReceipt(url, target)).toBe(false);
  });
  it("accepts only the exact confirmation route on the active origin", () => {
    expect(acceptsDayReviewConfirmation(target, origin, origin)).toBe(true);
    for (const url of [target.replace(":3000", ":4000"), target.replace("/api?", "/api/other?"), target.replace("action=resume", "action=delete"), target.replace("intent=", "other="), target.replace("dayReviewConfirmation=000", "dayReviewConfirmation=xxx"), target + "#other", target.replace("127.0.0.1", "user@127.0.0.1")]) {
      expect(acceptsDayReviewConfirmation(url, origin, origin)).toBe(false);
    }
    expect(acceptsDayReviewConfirmation(target, "https://example.com", origin)).toBe(false);
    expect(acceptsDayReviewConfirmation(target, origin, null)).toBe(false);
  });
  it("has one script-free child, allows only its own form, and closes on scope navigation", () => {
    const main = windowStub(), child = windowStub();
    const owner = installDayReviewConfirmationWindow(main as unknown as BrowserWindow, () => origin);
    expect(owner.handle({ url: "https://example.com" })).toBeUndefined();
    expect(owner.handle({ url: target })).toMatchObject({ action: "allow", outlivesOpener: false,
      overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false,
        preload: expect.stringContaining("day-review-confirmation-preload.cjs") } } });
    main.webContents.emit("did-create-window", child, { url: target });
    expect(owner.handle({ url: target })).toEqual({ action: "deny" });
    expect(child.focus).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    child.webContents.emit("will-navigate", { preventDefault }, target);
    expect(preventDefault).not.toHaveBeenCalled();
    child.webContents.emit("will-navigate", { preventDefault }, origin);
    child.webContents.emit("will-redirect", { preventDefault }, target);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(child.close).not.toHaveBeenCalled();
    child.webContents.emit("will-redirect", { preventDefault }, target.replace('&action=resume&intent=%7B%7D', '&receipt=complete'));
    expect(child.close).toHaveBeenCalledOnce();
    expect(child.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" });
    main.webContents.emit("did-start-navigation", {}, origin, true, true);
    expect(child.destroy).not.toHaveBeenCalled();
    main.webContents.emit("did-start-navigation", {}, origin, false, true);
    expect(child.destroy).toHaveBeenCalledOnce();
    expect(owner.handle({ url: target })?.action).toBe("allow");
  });
});

describe("recording deletion confirmation window", () => {
  const first = `${origin}/arkme-self/api?recordingDeletionConfirmation=00000000-0000-4000-8000-000000000001`;
  const second = first.replace(/1$/, "2");

  it("accepts only a single recording plan ID on the active Harness origin", () => {
    expect(acceptsRecordingDeletionConfirmation(first, origin, origin)).toBe(true);
    for (const url of [
      target, first.replace("3000", "3001"), first.replace("/api?", "/other?"),
      first.replace("00000000-", "aaaaaaaaa-"), first + "#section", first + "&intent=%7B%7D",
      first + "&recordingDeletionConfirmation=00000000-0000-4000-8000-000000000002",
      first.replace("127.0.0.1", "user@127.0.0.1"),
    ]) expect(acceptsRecordingDeletionConfirmation(url, origin, origin)).toBe(false);
    expect(acceptsRecordingDeletionConfirmation(first, "https://example.com", origin)).toBe(false);
    expect(acceptsRecordingDeletionConfirmation(first, origin, null)).toBe(false);
  });

  it("focuses the same plan and opens the second plan in its own restricted confirmation window", () => {
    const main = windowStub(), firstWindow = windowStub(), secondWindow = windowStub();
    const showError = vi.fn();
    const owner = installDayReviewConfirmationWindow(main as unknown as BrowserWindow, () => origin, showError);
    expect(owner.handle({ url: `${target}&${new URL(first).searchParams}` })).toEqual({ action: "deny" });
    showError.mockClear();
    expect(owner.handle({ url: first, postBody: {} })).toEqual({ action: "deny" });
    expect(owner.handle({ url: first })).toMatchObject({
      action: "allow",
      overrideBrowserWindowOptions: { modal: true, title: "确认删除录音",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } },
    });
    main.webContents.emit("did-create-window", firstWindow, { url: first });
    expect(owner.handle({ url: first })).toEqual({ action: "deny" });
    expect(firstWindow.focus).toHaveBeenCalledOnce();
    expect(owner.handle({ url: second })?.action).toBe("allow");
    expect(firstWindow.destroy).toHaveBeenCalledOnce();
    main.webContents.emit("did-create-window", secondWindow, { url: second });
    firstWindow.emit("closed");
    firstWindow.webContents.emit("render-process-gone");
    expect(owner.handle({ url: second })?.action).toBe("deny");
    expect(secondWindow.destroy).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    secondWindow.webContents.emit("will-navigate", { preventDefault }, second);
    expect(preventDefault).not.toHaveBeenCalled();
    secondWindow.webContents.emit("will-navigate", { preventDefault }, first);
    expect(preventDefault).toHaveBeenCalledOnce();
    secondWindow.webContents.emit("did-navigate", {}, second, 403);
    expect(showError).toHaveBeenCalledExactlyOnceWith(secondWindow, true);
  });

  it("explains stale and malformed local plans while keeping the conversation open", () => {
    const main = windowStub();
    const showError = vi.fn();
    const owner = installDayReviewConfirmationWindow(main as unknown as BrowserWindow, () => origin, showError);
    for (const url of [first.replace("3000", "49999"), first + "#old", first + "&other=1"]) {
      expect(owner.handle({ url })?.action).toBe("deny");
    }
    expect(showError).toHaveBeenCalledTimes(3);
    expect(showError).toHaveBeenLastCalledWith(main, true);
    expect(main.close).not.toHaveBeenCalled();
    expect(main.destroy).not.toHaveBeenCalled();
    expect(owner.handle({ url: first })?.action).toBe("allow");
    expect(owner.handle({ url: first.replace(origin, "https://example.com") })).toBeUndefined();
  });
});
