import { describe, expect, test, vi } from "vitest";
import { NativeBadgeCoordinator } from "../src/native-badge.js";

describe("NativeBadgeCoordinator", () => {
  test("applies only increasing absolute snapshots and accepts zero as an explicit clear", () => {
    const apply = vi.fn(() => true);
    const coordinator = new NativeBadgeCoordinator({ mode: "count", apply });

    expect(coordinator.applySnapshot({ generation: 1, revision: 1, count: 7 }))
      .toEqual({ accepted: true, outcome: "accepted" });
    expect(coordinator.applySnapshot({ generation: 1, revision: 1, count: 7 }))
      .toEqual({ accepted: false, outcome: "duplicate" });
    expect(coordinator.applySnapshot({ generation: 1, revision: 0, count: 9 }))
      .toEqual({ accepted: false, outcome: "duplicate" });
    expect(coordinator.applySnapshot({ generation: 1, revision: 1, count: 8 }))
      .toEqual({ accepted: false, outcome: "duplicate" });
    expect(coordinator.applySnapshot({ generation: 2, revision: 0, count: 0 }))
      .toEqual({ accepted: true, outcome: "accepted" });

    expect(apply.mock.calls).toEqual([[7], [0]]);
  });

  test("keeps a failed snapshot retryable and replays it when a window becomes available", () => {
    const apply = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    const coordinator = new NativeBadgeCoordinator({ mode: "dot", apply });
    const snapshot = { generation: 4, revision: 8, count: 3 };

    expect(coordinator.applySnapshot(snapshot)).toEqual({ accepted: false, outcome: "native-failed" });
    expect(coordinator.applySnapshot(snapshot)).toEqual({ accepted: true, outcome: "accepted" });
    expect(coordinator.applySnapshot(snapshot)).toEqual({ accepted: false, outcome: "duplicate" });
    expect(coordinator.replay()).toEqual({ accepted: true, outcome: "accepted" });
    expect(apply.mock.calls).toEqual([[3], [3], [3]]);
  });

  test("clears the previous lease immediately and lets the new lease restart ordering", () => {
    const apply = vi.fn(() => true);
    const coordinator = new NativeBadgeCoordinator({ mode: "count", apply });

    coordinator.applySnapshot({ generation: 9, revision: 20, count: 12 });
    expect(coordinator.beginSession()).toEqual({ accepted: true, outcome: "accepted" });
    expect(coordinator.applySnapshot({ generation: 0, revision: 0, count: 2 }))
      .toEqual({ accepted: true, outcome: "accepted" });
    expect(apply.mock.calls).toEqual([[12], [0], [2]]);
  });

  test("clears native and pending snapshot state when a Harness lease ends", () => {
    const apply = vi.fn(() => true);
    const coordinator = new NativeBadgeCoordinator({ mode: "count", apply });
    coordinator.applySnapshot({ generation: 7, revision: 4, count: 6 });

    expect(coordinator.endSession()).toEqual({ accepted: true, outcome: "accepted" });
    expect(coordinator.replay()).toEqual({ accepted: true, outcome: "accepted" });
    expect(coordinator.applySnapshot({ generation: 0, revision: 0, count: 1 }))
      .toEqual({ accepted: true, outcome: "accepted" });
    expect(apply.mock.calls).toEqual([[6], [0], [0], [1]]);
  });

  test("reports unsupported and native exceptions explicitly", () => {
    const unsupported = new NativeBadgeCoordinator({ mode: "unsupported", apply: vi.fn() });
    expect(unsupported.applySnapshot({ generation: 1, revision: 1, count: 1 }))
      .toEqual({ accepted: false, outcome: "unsupported" });

    const failing = new NativeBadgeCoordinator({
      mode: "count",
      apply: () => { throw new Error("native API failed"); }
    });
    expect(failing.applySnapshot({ generation: 1, revision: 1, count: 1 }))
      .toEqual({ accepted: false, outcome: "native-failed" });
  });

  test("rejects malformed, oversized, and schema-expanded snapshots", () => {
    const coordinator = new NativeBadgeCoordinator({ mode: "count", apply: vi.fn(() => true) });
    expect(coordinator.applySnapshot({ generation: -1, revision: 0, count: 1 }).accepted).toBe(false);
    expect(coordinator.applySnapshot({ generation: 0, revision: 0, count: 1_000_000 }).accepted).toBe(false);
    expect(coordinator.applySnapshot({ generation: 0, revision: 0, count: 1, accountId: "leak" }).accepted)
      .toBe(false);
  });
});
