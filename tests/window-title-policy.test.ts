import { describe, expect, test } from "vitest";
import { lockWindowTitle } from "../src/window-title-policy.js";

class FakeWindow {
  title = "";
  private listener: ((event: { preventDefault(): void }) => void) | null = null;

  setTitle(title: string): void {
    this.title = title;
  }

  on(
    event: "page-title-updated",
    listener: (event: { preventDefault(): void }) => void
  ): void {
    if (event === "page-title-updated") this.listener = listener;
  }

  updatePageTitle(title: string): void {
    let prevented = false;
    this.listener?.({ preventDefault: () => { prevented = true; } });
    if (!prevented) this.title = title;
  }
}

describe("window title policy", () => {
  test("keeps the native window title branded when page titles change", () => {
    const window = new FakeWindow();
    lockWindowTitle(window, "arkme");

    window.updatePageTitle("DeepSeek Harness");

    expect(window.title).toBe("arkme");
  });
});
