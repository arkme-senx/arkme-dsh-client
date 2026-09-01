import { describe, expect, test, vi } from "vitest";
import { inflateSync } from "node:zlib";
import {
  createWindowsBadgeDotImage,
  WINDOWS_BADGE_DOT_DATA_URL
} from "../src/windows-badge-icon.js";

describe("Windows badge dot", () => {
  test("owns a fixed 16x16 RGBA PNG rather than a platform-dependent raw bitmap", () => {
    const bytes = Buffer.from(WINDOWS_BADGE_DOT_DATA_URL.split(",")[1] ?? "", "base64");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(16);
    expect(bytes.readUInt32BE(20)).toBe(16);
    expect(bytes[25]).toBe(6);
    const rgba = decodeRgbaPng(bytes);
    expect(rgba.pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(rgba.pixel(15, 15)[3]).toBe(0);
    expect(rgba.pixel(8, 8)).toEqual([255, 59, 48, 255]);
    expect(rgba.pixel(5, 2)[3]).toBeGreaterThan(0);
    expect(rgba.pixel(5, 2)[3]).toBeLessThan(255);
  });

  test("accepts only a nonempty 16x16 native decode", () => {
    const image = { isEmpty: () => false, getSize: () => ({ width: 16, height: 16 }) };
    const createFromDataURL = vi.fn(() => image);
    expect(createWindowsBadgeDotImage({ createFromDataURL })).toBe(image);
    expect(createFromDataURL).toHaveBeenCalledWith(WINDOWS_BADGE_DOT_DATA_URL);

    expect(() => createWindowsBadgeDotImage({
      createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 16, height: 16 }) })
    })).toThrow(/could not be decoded/i);
  });
});

function decodeRgbaPng(bytes: Buffer): {
  pixel(x: number, y: number): [number, number, number, number];
} {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (stride + 1)]).toBe(0);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return {
    pixel(x: number, y: number) {
      const pixelOffset = (y * width + x) * 4;
      return [...rgba.subarray(pixelOffset, pixelOffset + 4)] as [number, number, number, number];
    }
  };
}
