export type NativeBadgeMode = "count" | "dot" | "unsupported";

export interface NativeBadgeSnapshot {
  generation: number;
  revision: number;
  count: number;
}

export type NativeBadgeApplyResult =
  | { accepted: true; outcome: "accepted" }
  | { accepted: false; outcome: "duplicate" | "unsupported" | "native-failed" };

export interface NativeBadgeAdapter {
  readonly mode: NativeBadgeMode;
  apply(count: number): boolean;
}

/**
 * Owns only native presentation and ordering. The plugin remains the authority
 * for accounts, mute rules, unread projection, and the absolute badge count.
 */
export class NativeBadgeCoordinator {
  private latest: NativeBadgeSnapshot | undefined;
  private lastApplied: NativeBadgeSnapshot | undefined;

  constructor(private readonly adapter: NativeBadgeAdapter) {}

  get mode(): NativeBadgeMode {
    return this.adapter.mode;
  }

  beginSession(): NativeBadgeApplyResult {
    // Generations and revisions are scoped to a single Harness lease. Clear the
    // previous lease immediately so a failed restart cannot leave a stale badge
    // visible indefinitely.
    this.latest = undefined;
    this.lastApplied = undefined;
    return this.clearNative();
  }

  endSession(): NativeBadgeApplyResult {
    this.latest = undefined;
    this.lastApplied = undefined;
    return this.clearNative();
  }

  applySnapshot(candidate: unknown): NativeBadgeApplyResult {
    const snapshot = parseNativeBadgeSnapshot(candidate);
    if (snapshot === undefined) return { accepted: false, outcome: "native-failed" };
    if (this.adapter.mode === "unsupported") return { accepted: false, outcome: "unsupported" };
    if (this.latest !== undefined) {
      const order = compareSnapshots(snapshot, this.latest);
      if (order < 0) return { accepted: false, outcome: "duplicate" };
      if (order === 0) {
        if (snapshot.count !== this.latest.count || sameSnapshot(this.lastApplied, snapshot)) {
          return { accepted: false, outcome: "duplicate" };
        }
      }
    }

    // Keep a failed authoritative snapshot pending so an identical Host retry
    // or a recreated taskbar window can apply it. Only successfully applied
    // snapshots are deduplicated.
    this.latest = snapshot;
    const result = this.applyCount(snapshot.count);
    if (result.accepted) this.lastApplied = snapshot;
    return result;
  }

  replay(): NativeBadgeApplyResult {
    if (this.adapter.mode === "unsupported") return { accepted: false, outcome: "unsupported" };
    const result = this.applyCount(this.latest?.count ?? 0);
    if (result.accepted && this.latest !== undefined) this.lastApplied = this.latest;
    return result;
  }

  clearNative(): NativeBadgeApplyResult {
    if (this.adapter.mode === "unsupported") return { accepted: false, outcome: "unsupported" };
    return this.applyCount(0);
  }

  private applyCount(count: number): NativeBadgeApplyResult {
    try {
      return this.adapter.apply(count)
        ? { accepted: true, outcome: "accepted" }
        : { accepted: false, outcome: "native-failed" };
    } catch {
      return { accepted: false, outcome: "native-failed" };
    }
  }
}

export function parseNativeBadgeSnapshot(candidate: unknown): NativeBadgeSnapshot | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    !hasExactKeys(value, ["generation", "revision", "count"])
    || !nonNegativeSafeInteger(value.generation)
    || !nonNegativeSafeInteger(value.revision)
    || !nonNegativeSafeInteger(value.count)
    || value.count > 999_999
  ) return undefined;
  return {
    generation: value.generation,
    revision: value.revision,
    count: value.count
  };
}

function compareSnapshots(next: NativeBadgeSnapshot, current: NativeBadgeSnapshot): -1 | 0 | 1 {
  if (next.generation !== current.generation) return next.generation > current.generation ? 1 : -1;
  if (next.revision === current.revision) return 0;
  return next.revision > current.revision ? 1 : -1;
}

function sameSnapshot(
  left: NativeBadgeSnapshot | undefined,
  right: NativeBadgeSnapshot
): boolean {
  return left !== undefined
    && left.generation === right.generation
    && left.revision === right.revision
    && left.count === right.count;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
