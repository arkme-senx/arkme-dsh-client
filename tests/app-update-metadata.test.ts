import { describe, expect, test } from "vitest";
import { resolveAppUpdateMetadata, type AppUpdaterUpdateInfo } from "../src/app-update-metadata.js";

const sha512 = Buffer.alloc(64, 1).toString("base64");
const target = { version: "0.2.6", versionCode: 3, feedURL: "https://updates.example.test/0.2.6-vc3/", platform: "darwin", arch: "arm64" } as const;
const file = (url: string) => ({ url, sha512, size: 100 });
const metadata = (files: AppUpdaterUpdateInfo["files"]) => ({ version: target.version, files });

describe("update metadata payload selection", () => {
  test("uses the ZIP, not the first file or the legacy DMG path", () => {
    const info = { ...metadata([file("arkme.dmg"), file("arkme-0.2.6-vc3-universal.zip")]), path: "arkme.dmg" };
    expect(resolveAppUpdateMetadata(info, target).url.href).toBe(`${target.feedURL}arkme-0.2.6-vc3-universal.zip`);
  });

  test("selects the arm64 ZIP from a multi-architecture Mac feed", () => {
    const info = metadata([file("arkme-0.2.6-vc3-x64.zip"), file("arkme-0.2.6-vc3-arm64.zip")]);
    expect(resolveAppUpdateMetadata(info, target).filename).toBe("arkme-0.2.6-vc3-arm64.zip");
  });

  test("selects the x64 NSIS EXE instead of a portable ZIP or an ia32 EXE", () => {
    const info = metadata([file("arkme-portable-x64.zip"), file("arkme-0.2.6-vc3-ia32.exe"), file("arkme-0.2.6-vc3-x64.exe")]);
    expect(resolveAppUpdateMetadata(info, { ...target, platform: "win32", arch: "x64" }).filename).toBe("arkme-0.2.6-vc3-x64.exe");
  });

  test("accepts an absolute artifact URL inside its update directory", () => {
    const url = `${target.feedURL}arkme-0.2.6-vc3-universal.zip`;
    expect(resolveAppUpdateMetadata(metadata([file(url)]), target).url.href).toBe(url);
  });

  test.each([
    "http://updates.example.test/0.2.6-vc3/arkme-0.2.6-vc3.zip",
    "https://other.example.test/0.2.6-vc3/arkme-0.2.6-vc3.zip",
    "https://user:password@updates.example.test/0.2.6-vc3/arkme-0.2.6-vc3.zip",
    "../arkme-0.2.6-vc3.zip",
    "/0.2.6-vc30/arkme-0.2.6-vc3.zip",
    "%2e%2e/arkme-0.2.6-vc3.zip",
    "%2e%2e%2farkme-0.2.6-vc3.zip",
    "%5carkme-0.2.6-vc3.zip",
    "arkme-0.2.6-vc3.zip?redirect=1",
    "arkme-0.2.6-vc3.zip#fragment",
  ])("rejects unsafe or out-of-directory update URL %s", url => {
    expect(() => resolveAppUpdateMetadata(metadata([file(url)]), target)).toThrow(/地址/);
  });

  test.each(["arkme-0.2.6.zip", "arkme-0.2.6-vc2.zip", "arkme-0.2.6-vc30.zip"])("checks the selected payload Version Code: %s", url => {
    // A later valid candidate must not allow the updater's first candidate through.
    expect(() => resolveAppUpdateMetadata(metadata([file(url), file("arkme-0.2.6-vc3.zip")]), target)).toThrow(/Version Code/);
  });

  test.each(["darwin", "win32"] as const)("requires the actual %s payload type; no updater extension fallback", platform => {
    expect(() => resolveAppUpdateMetadata(metadata([file("arkme-0.2.6-vc3.dmg")]), { ...target, platform })).toThrow(/安装包/);
  });

  test.each([undefined, "", "digest", "a".repeat(128), "a".repeat(86) + "=="])("rejects malformed SHA-512: %s", digest => {
    const entry = { url: "arkme-0.2.6-vc3.zip", size: 100, ...(digest === undefined ? {} : { sha512: digest }) };
    expect(() => resolveAppUpdateMetadata(metadata([entry]), target)).toThrow(/SHA-512/);
  });

  test.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid declared size %s", size => {
    const entry = { url: "arkme-0.2.6-vc3.zip", sha512, ...(size === undefined ? {} : { size }) };
    expect(() => resolveAppUpdateMetadata(metadata([entry]), target)).toThrow(/大小/);
  });
});
