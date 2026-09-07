export interface AppUpdaterUpdateInfo {
  version: string;
  files: Array<{ url: string; sha512?: string; size?: number }>;
}

interface UpdateMetadataTarget {
  version: string;
  versionCode: number;
  feedURL: string;
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
}

// Shared by the desktop gate and the release verifier. The website download URL
// deliberately isn't an input: the update feed owns its own signed artifacts.
export function resolveAppUpdateMetadata(info: AppUpdaterUpdateInfo, target: UpdateMetadataTarget) {
  if (!Number.isSafeInteger(target.versionCode) || target.versionCode <= 0 || target.versionCode > 2_147_483_647) {
    throw new Error("自动更新 Version Code 无效");
  }
  if (info.version !== target.version) throw new Error("自动更新元数据版本与发布记录不一致");
  if (!Array.isArray(info.files) || info.files.length === 0) throw new Error("自动更新元数据缺少安装包");
  const feed = new URL(target.feedURL);
  if (feed.protocol !== "https:" || feed.username || feed.password || feed.search || feed.hash || !feed.pathname.endsWith("/")) {
    throw new Error("自动更新目录必须是 HTTPS 目录地址");
  }
  let files = info.files.map(file => {
    if (file === null || typeof file !== "object" || typeof file.url !== "string" || !file.url.trim()) {
      throw new Error("自动更新元数据安装包地址无效");
    }
    const url = new URL(file.url, feed);
    // An absolute URL is allowed only inside this release's immutable directory.
    if (url.origin !== feed.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(feed.pathname)) {
      throw new Error("自动更新元数据安装包地址不在自动更新目录内");
    }
    const segments = url.pathname.slice(feed.pathname.length).split("/").map(segment => decodeURIComponent(segment));
    if (segments.some(segment => !segment || segment === "." || segment === ".." || /[/\\]/.test(segment))) {
      throw new Error("自动更新元数据安装包地址无效");
    }
    return { file, url, filename: segments.at(-1)! };
  });

  // Match MacUpdater's arm64 filtering and Provider.findFile's arch preference.
  // Reject a missing platform payload instead of accepting updater fallbacks.
  if (target.platform === "darwin") {
    const isArm64 = (entry: typeof files[number]) => entry.url.pathname.includes("arm64") || entry.file.url.includes("arm64");
    const useArm64 = target.arch === "arm64" && files.some(isArm64);
    files = files.filter(entry => isArm64(entry) === useArm64);
  }
  const extension = target.platform === "darwin" ? ".zip" : ".exe";
  const candidates = files.filter(entry => entry.url.pathname.toLowerCase().endsWith(extension));
  const selected = candidates.find(entry => entry.url.pathname.includes(target.arch) || entry.file.url.includes(target.arch)) ?? candidates[0];
  if (selected === undefined) throw new Error(`自动更新元数据缺少 ${extension} 安装包`);
  if (!new RegExp(`(?:^|[-_.])vc${target.versionCode}(?:[-_.]|$)`, "i").test(selected.filename)) {
    throw new Error("安装包文件名缺少对应的 Version Code");
  }
  const digest = selected.file.sha512;
  if (typeof digest !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(digest) || Buffer.from(digest, "base64").toString("base64") !== digest) {
    throw new Error("自动更新元数据缺少有效 SHA-512");
  }
  if (!Number.isSafeInteger(selected.file.size) || (selected.file.size as number) <= 0) {
    throw new Error("自动更新元数据文件大小无效");
  }
  return selected;
}
