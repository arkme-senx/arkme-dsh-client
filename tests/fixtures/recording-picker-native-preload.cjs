// Test-only bridge: the native chooser returns only cancellation/count/timing, never paths.
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('pick');
  const status = document.getElementById('status');
  if (!button || !status) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '系统选文件窗口已请求打开；请观察至少 8 秒后手动取消。';
    try {
      const result = await ipcRenderer.invoke('native-picker-smoke:pick');
      status.textContent = `选文件返回：${result.canceled ? '取消' : `选择了 ${result.count} 个文件（未读取）`}，经过 ${(result.elapsedMillis / 1000).toFixed(1)} 秒。请告诉 Codex 是否由你手动取消。`;
    } catch (error) {
      status.textContent = `验证失败：${error.message}`;
    } finally { button.disabled = false; }
  });
});
