import { describe, expect, test } from "vitest";
import {
  ArkmeDeepLinkQueue,
  createProtocolClientRegistration,
  createExtensionShareHarnessUrl,
  findArkmeDeepLink,
  parseArkmeDeepLink
} from "../src/deep-link.js";

const SHARE_REF = "extshare_0123456789abcdef0123456789abcdef";
const LINK = `arkme://extensions/share/${SHARE_REF}`;
const AUTHOR_CHAT_LINK = `${LINK}/author-chat`;
const AUTHOR_WORLD_LINK = `${LINK}/author-world`;
const TEST_LINK = `arkme-test://extensions/share/${SHARE_REF}`;

describe("Arkme desktop deep links", () => {
  test("accepts only the exact extension share URL", () => {
    expect(parseArkmeDeepLink(LINK)).toEqual({ kind: "extension-share", shareRef: SHARE_REF });

    for (const invalid of [
      `arkme://extensions/share/${SHARE_REF}/`,
      `arkme://extensions/share/${SHARE_REF}?install=1`,
      `arkme://extensions/share/${SHARE_REF}#extra`,
      `arkme://user:password@extensions/share/${SHARE_REF}`,
      `arkme://extensions:99/share/${SHARE_REF}`,
      "arkme://extensions/share/extshare_BAD",
      `https://extensions/share/${SHARE_REF}`
    ]) {
      expect(parseArkmeDeepLink(invalid)).toBeUndefined();
    }
  });

  test("accepts the two supported author actions without exposing author data", () => {
    expect(parseArkmeDeepLink(AUTHOR_CHAT_LINK)).toEqual({
      kind: "extension-share",
      shareRef: SHARE_REF,
      action: "author-chat"
    });
    expect(parseArkmeDeepLink(AUTHOR_WORLD_LINK)).toEqual({
      kind: "extension-share",
      shareRef: SHARE_REF,
      action: "author-world"
    });

    for (const invalid of [
      `${LINK}/install`,
      `${AUTHOR_CHAT_LINK}/`,
      `${AUTHOR_WORLD_LINK}?user_id=1`,
      `${AUTHOR_WORLD_LINK}#extra`
    ]) {
      expect(parseArkmeDeepLink(invalid)).toBeUndefined();
    }
  });

  test("finds a valid protocol argument without accepting prefixed command options", () => {
    expect(findArkmeDeepLink(["arkme.exe", "--flag", LINK])).toEqual({
      kind: "extension-share",
      shareRef: SHARE_REF
    });
    expect(findArkmeDeepLink([`--url=${LINK}`])).toBeUndefined();
  });

  test("registers packaged apps directly and development apps through their entry point", () => {
    expect(createProtocolClientRegistration(false, "/Applications/arkme", undefined)).toEqual({
      scheme: "arkme"
    });
    expect(createProtocolClientRegistration(true, "C:\\Electron\\electron.exe", "C:\\src\\arkme")).toEqual({
      scheme: "arkme",
      executable: "C:\\Electron\\electron.exe",
      args: ["C:\\src\\arkme"]
    });
    expect(createProtocolClientRegistration(
      false,
      "/Applications/arkme Test",
      undefined,
      "arkme-test"
    )).toEqual({ scheme: "arkme-test" });
  });

  test("accepts the isolated test scheme only when the test application requests it", () => {
    expect(parseArkmeDeepLink(TEST_LINK)).toBeUndefined();
    expect(parseArkmeDeepLink(TEST_LINK, "arkme-test")).toEqual({
      kind: "extension-share",
      shareRef: SHARE_REF
    });
    expect(parseArkmeDeepLink(LINK, "arkme-test")).toBeUndefined();
    expect(findArkmeDeepLink(["arkme-test.exe", TEST_LINK], "arkme-test")).toEqual({
      kind: "extension-share",
      shareRef: SHARE_REF
    });
  });

  test("converts a desktop intent into the existing fragment-only DSH route", () => {
    expect(createExtensionShareHarnessUrl("http://127.0.0.1:41234/", {
      kind: "extension-share",
      shareRef: SHARE_REF
    })).toBe(`http://127.0.0.1:41234/#/arkme/extensions/share/${SHARE_REF}`);

    expect(createExtensionShareHarnessUrl("http://127.0.0.1:41234/", {
      kind: "extension-share",
      shareRef: SHARE_REF,
      action: "author-chat"
    })).toBe(`http://127.0.0.1:41234/#/arkme/extensions/share/${SHARE_REF}/author-chat`);
  });

  test("keeps the newest pending intent until that exact intent is delivered", () => {
    const queue = new ArkmeDeepLinkQueue();
    const first = parseArkmeDeepLink(LINK)!;
    const second = parseArkmeDeepLink("arkme://extensions/share/extshare_abcdefabcdefabcdefabcdefabcdefab")!;

    queue.push(first);
    queue.push(second);
    expect(queue.peek()).toEqual(second);
    queue.markDelivered(first);
    expect(queue.peek()).toEqual(second);
    queue.markDelivered(second);
    expect(queue.peek()).toBeUndefined();
  });

  test("keeps author actions for the same share reference as distinct intents", () => {
    const queue = new ArkmeDeepLinkQueue();
    const chat = parseArkmeDeepLink(AUTHOR_CHAT_LINK)!;
    const world = parseArkmeDeepLink(AUTHOR_WORLD_LINK)!;

    queue.push(chat);
    queue.push(world);
    queue.markDelivered(chat);
    expect(queue.peek()).toEqual(world);
    queue.markDelivered(world);
    expect(queue.peek()).toBeUndefined();
  });
});
