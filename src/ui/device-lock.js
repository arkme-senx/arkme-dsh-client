"use strict";
const title = document.getElementById("title");
const message = document.getElementById("message");
const unlock = document.getElementById("unlock");
const surface = document.getElementById("surface");
const illustration = document.getElementById("illustration");
let busy = false;
let snapshot;
let revision = 0;
function render(value) {
  if (value === null || typeof value !== "object") return;
  snapshot = value;
  if (!value.locked) { surface.hidden = true; document.title = "即我"; return; }
  const platform = value.platform === "windows" ? "Windows" : "Mac";
  const ended = value.sessionEnded === true;
  title.textContent = ended ? "正在退出登录…" : `${platform} 即我已锁定`;
  document.title = title.textContent;
  illustration.toggleAttribute("hidden", ended);
  message.hidden = unlock.hidden = ended;
  message.textContent = ended ? "" : value.message || "你可以在手机即我首页的设备状态栏解锁。";
  unlock.disabled = busy || value.sessionEnded;
  unlock.textContent = busy ? "正在验证…" : value.operationState === "awaiting_confirmation" ? "使用电脑密码解锁" : "解锁以继续使用";
  surface.hidden = false;
}
// The initial IPC response or a pending unlock must not replace a newer logout
// event. Until the first native snapshot, the protected window stays neutral.
window.deviceLock.changed(value => { revision++; render(value); });
void window.deviceLock.snapshot().then(value => { if (revision === 0) render(value); });
unlock.addEventListener("click", async () => {
  if (busy || !snapshot?.locked || snapshot.sessionEnded) return;
  const requestedRevision = revision;
  busy = true; render(snapshot);
  try {
    const value = await window.deviceLock.unlock();
    if (revision === requestedRevision) render(value);
  }
  finally { busy = false; render(snapshot); }
});
