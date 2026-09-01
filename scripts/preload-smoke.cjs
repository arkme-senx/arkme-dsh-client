const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { inflateSync } = require("node:zlib");

const preloadPath = process.argv[2];

if (!preloadPath) {
  throw new Error("Usage: electron scripts/preload-smoke.cjs <preload-path>");
}

app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    const { createWindowsBadgeDotImage } = await import(pathToFileURL(path.join(
      path.dirname(preloadPath),
      "windows-badge-icon.js"
    )).href);
    const badgeDot = createWindowsBadgeDotImage(nativeImage);
    const badgeDotSize = badgeDot.getSize();
    if (badgeDot.isEmpty() || badgeDotSize.width !== 16 || badgeDotSize.height !== 16) {
      throw new Error(`Windows badge dot is invalid: ${JSON.stringify(badgeDotSize)}`);
    }
    const decodedBadgeDot = decodeRgbaPng(badgeDot.toPNG());
    if (
      decodedBadgeDot.alphaAt(0, 0) !== 0
      || decodedBadgeDot.alphaAt(15, 15) !== 0
      || decodedBadgeDot.alphaAt(8, 8) === 0
    ) {
      throw new Error("Windows badge dot must decode as a red circle on a transparent canvas");
    }
    ipcMain.on("arkme-runtime:harness-version", event => {
      event.returnValue = "preload-smoke";
    });
    ipcMain.on("arkme-desktop:attention-capabilities", event => {
      event.returnValue = {
        schemaVersion: 1,
        notificationShow: true,
        notificationPermission: "granted",
        badgeMode: "count"
      };
    });
    ipcMain.on("arkme:desktop-notification:permission-state", event => {
      event.returnValue = true;
    });
    ipcMain.handle("arkme:runtime-update-notice:snapshot", () => null);
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        sandbox: true,
        webSecurity: true,
      },
    });

    const preloadErrors = [];
    window.webContents.on("preload-error", (_event, path, error) => {
      preloadErrors.push(`${path}: ${error.stack ?? error.message}`);
    });
    await window.loadURL("data:text/html,<title>Arkme preload smoke</title>");

    const result = await window.webContents.executeJavaScript(`({
      present: window.arkmeDesktop?.startupAuthGate === true,
      frozen: Object.isFrozen(window.arkmeDesktop),
      attentionFrozen: Object.isFrozen(window.arkmeDesktop?.attention),
      notificationFacadeFrozen: Object.isFrozen(window.arkmeDesktopNotifications),
      notificationPermission: window.arkmeDesktopNotifications?.permission?.(),
      notificationPermissionRequestAvailable: typeof window.arkmeDesktopNotifications?.requestPermission === "function",
      notificationPermissionRefreshAvailable: typeof window.arkmeDesktopNotifications?.refreshPermission === "function",
      notificationSettingsAvailable: typeof window.arkmeDesktopNotifications?.openSettings === "function",
      notificationPermissionSubscriptionAvailable: typeof window.arkmeDesktopNotifications?.onPermissionChanged === "function",
      badgeMode: window.arkmeDesktop?.attention?.badgeMode,
      harnessVersion: window.arkmeDesktop?.harnessVersion,
    })`);
    if (
      !result.present
      || !result.frozen
      || !result.attentionFrozen
      || !result.notificationFacadeFrozen
      || !["default", "granted", "denied", "unavailable"].includes(result.notificationPermission)
      || !result.notificationPermissionRequestAvailable
      || !result.notificationPermissionRefreshAvailable
      || !result.notificationSettingsAvailable
      || !result.notificationPermissionSubscriptionAvailable
      || result.badgeMode !== "count"
      || result.harnessVersion !== "preload-smoke"
    ) {
      const details = preloadErrors.length > 0 ? `\n${preloadErrors.join("\n")}` : "";
      throw new Error(`Arkme desktop capability was not exposed: ${JSON.stringify(result)}${details}`);
    }

    console.log(`preload smoke passed: ${JSON.stringify(result)}`);
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.stack : error);
  } finally {
    window?.destroy();
    app.exit(exitCode);
  }
});

function decodeRgbaPng(bytes) {
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Badge dot is not a PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) {
    throw new Error("Badge dot PNG must decode to non-interlaced 8-bit RGBA");
  }
  const idat = [];
  let chunkOffset = 8;
  while (chunkOffset < bytes.length) {
    const length = bytes.readUInt32BE(chunkOffset);
    const type = bytes.subarray(chunkOffset + 4, chunkOffset + 8).toString("ascii");
    if (type === "IDAT") idat.push(bytes.subarray(chunkOffset + 8, chunkOffset + 8 + length));
    chunkOffset += length + 12;
  }
  const filtered = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const rgba = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset++];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? rgba[y * stride + x - bytesPerPixel] : 0;
      const above = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? rgba[(y - 1) * stride + x - bytesPerPixel]
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : filter === 4
                ? paeth(left, above, upperLeft)
                : undefined;
      if (predictor === undefined) throw new Error(`Unsupported PNG filter ${filter}`);
      rgba[y * stride + x] = (filtered[sourceOffset++] + predictor) & 0xff;
    }
  }
  return {
    alphaAt(x, y) {
      return rgba[(y * width + x) * bytesPerPixel + 3];
    }
  };
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}
