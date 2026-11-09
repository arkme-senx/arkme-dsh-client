import {expect, test} from "vitest";
import {activationFailurePackages} from "../src/web-boot-failure.js";

test("accepts only complete activation audit rows and preserves scoped names", () => {
  const header = "web boot: 2 entries did not activate\n";
  const first = "@local/arkme-arrangement-line: loading";
  expect(activationFailurePackages(header + first + "\n@local/calendar: pending (waiting for service: ui)"))
    .toEqual(["@local/arkme-arrangement-line", "@local/calendar"]);
  for (const message of [header + first, header + first + "\n" + first, first,
    "Harness plugin page readiness timed out", "web boot: 1 entry did not activate\n../outside: loading"]) {
    expect(activationFailurePackages(message)).toBeUndefined();
  }
});
