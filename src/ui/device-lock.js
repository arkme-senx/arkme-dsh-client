"use strict";
const title = document.getElementById("title");
const message = document.getElementById("message");
const unlock = document.getElementById("unlock");
let busy = false;
let snapshot;
function render(value) {
  if (value === null || typeof value !== "object") return;
  snapshot = value;
  const platform = value.platform === "windows" ? "Windows" : "Mac";
  title.textContent = value.sessionEnded ? "此电脑已退出登录" : `${platform} 即我已锁定`;
  message.textContent = value.message || "你可以在手机即我首页的设备状态栏解锁。";
  unlock.disabled = busy || value.sessionEnded;
  unlock.textContent = busy ? "正在验证…" : value.operationState === "awaiting_confirmation" ? "使用电脑密码解锁" : "解锁以继续使用";
}
window.deviceLock.changed(render);
void window.deviceLock.snapshot().then(render);
unlock.addEventListener("click", async () => {
  if (busy) return;
  busy = true; render(snapshot);
  try { render(await window.deviceLock.unlock()); }
  finally { busy = false; render(snapshot); }
});
