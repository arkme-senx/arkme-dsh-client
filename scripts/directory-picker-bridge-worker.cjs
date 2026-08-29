const title = process.env.DSH_DIALOG_TITLE || "选择文件夹";
const url = process.env.ARKME_DIRECTORY_PICKER_BRIDGE_URL;
const token = process.env.ARKME_DIRECTORY_PICKER_BRIDGE_TOKEN;

if (process.send === undefined) throw new Error("directory picker bridge worker requires IPC");
const send = process.send.bind(process);
const post = (message) => send(message, () => {
  if (process.connected) process.disconnect();
});

(async () => {
  try {
    if (!url || !token) throw new Error("directory picker bridge is not configured");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-arkme-picker-token": token
      },
      body: JSON.stringify({ title })
    });
    if (!response.ok) throw new Error(`directory picker bridge returned HTTP ${response.status}`);
    const result = await response.json();
    post({ kind: "done", path: result.canceled === true ? null : result.path });
  } catch (error) {
    post({ kind: "error", message: error instanceof Error ? error.stack || error.message : String(error) });
  }
})();
