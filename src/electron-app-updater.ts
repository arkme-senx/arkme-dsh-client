import { MacUpdater, NsisUpdater } from "electron-updater";
import { SemVer } from "semver";
import type { AppUpdaterPort } from "./app-update.js";

export function createElectronAppUpdater(
  platform: "darwin" | "win32",
  feedURL: string,
  targetVersion: string,
): AppUpdaterPort {
  const options = { provider: "generic" as const, url: feedURL };
  const updater = platform === "darwin"
    ? new MacUpdater(options)
    : new NsisUpdater(options);
  const target = new SemVer(targetVersion);
  // electron-updater normally compares SemVer before downloading. Version Code
  // has already authorized this exact release, so use a non-equal sentinel and
  // let allowDowngrade cover either direction without making SemVer authoritative.
  const sentinel = target.major === 0 ? "1.0.0" : "0.0.0-0";
  // electron-updater can carry its own nested semver dependency. Passing a
  // SemVer instance created by this package is therefore unsafe: the nested
  // copy treats it as a plain object and rejects it. A version string is the
  // stable boundary accepted by either copy.
  (updater as unknown as { currentVersion: string }).currentVersion = sentinel;
  return updater as unknown as AppUpdaterPort;
}
