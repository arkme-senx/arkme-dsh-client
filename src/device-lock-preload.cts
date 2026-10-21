import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("deviceLock", Object.freeze({
  snapshot: () => ipcRenderer.invoke("arkme-device-lock:snapshot"),
  unlock: () => ipcRenderer.invoke("arkme-device-lock:unlock"),
  changed: (listener: (value: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("arkme-device-lock:changed", handler);
    return () => ipcRenderer.removeListener("arkme-device-lock:changed", handler);
  }
}));
