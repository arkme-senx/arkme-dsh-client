const { app, BrowserWindow, ipcMain } = require("electron");

const preloadPath = process.argv[2];

if (!preloadPath) {
  throw new Error("Usage: electron scripts/preload-smoke.cjs <preload-path>");
}

app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    ipcMain.on("arkme-runtime:harness-version", event => {
      event.returnValue = "preload-smoke";
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
      harnessVersion: window.arkmeDesktop?.harnessVersion,
    })`);
    if (!result.present || !result.frozen || result.harnessVersion !== "preload-smoke") {
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
