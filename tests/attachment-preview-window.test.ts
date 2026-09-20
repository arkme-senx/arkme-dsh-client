import { describe, it, expect } from "vitest";
import { previewBounds, acceptsPreviewPopup } from "../src/attachment-preview-window.js";
describe("attachment preview native policy", () => {
  it("only accepts the named blank popup from the active harness", () => {
    expect(acceptsPreviewPopup("about:blank", "arkme-attachment-preview", "http://localhost:3000/chat", "http://localhost:3000")).toBe(true);
    for (const [url, name, source] of [["https://example.com", "arkme-attachment-preview", "http://localhost:3000"], ["about:blank", "other", "http://localhost:3000"], ["about:blank", "arkme-attachment-preview", "http://localhost:4000"]]) {
      expect(acceptsPreviewPopup(url!, name!, source!, "http://localhost:3000")).toBe(false);
    }
  });
  it("returns an entirely visible window after a display is disconnected", () => {
    expect(previewBounds({x:2100,y:200,width:900,height:700}, {x:0,y:24,width:800,height:576})).toEqual({x:0,y:24,width:800,height:576});
    expect(previewBounds(undefined, {x:-1920,y:0,width:1920,height:1080})).toEqual({x:-1360,y:240,width:800,height:600});
  });
});
