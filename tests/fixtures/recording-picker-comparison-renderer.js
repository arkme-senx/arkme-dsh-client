const bridge = window.pickerComparison;
const panel = document.getElementById('upload');
const pick = document.getElementById('pick');
const input = document.getElementById('input');
const result = document.getElementById('result');
const judgment = document.getElementById('judgment');
const next = document.getElementById('next');
let backend, started, pending = false;
const emit = (event, details = {}) => bridge.log({ event, elapsedMillis: started === undefined ? 0 : Math.round(performance.now() - started),
  visibility: document.visibilityState, focused: document.hasFocus(), activation: navigator.userActivation?.isActive, ...details });
document.addEventListener('visibilitychange', () => { if (pending) emit('visibility-change'); });
for (const name of ['blur', 'focus', 'pagehide']) window.addEventListener(name, () => { if (pending) emit(name); });
bridge.method().then(method => {
  backend = method;
  document.getElementById('method').textContent = { input: '第 1 项：旧版文件输入框（3.0.13）', browser: '第 2 项：当前浏览器接口（3.0.14 起）', native: '第 3 项：修复后的桌面原生接口' }[method];
  pick.disabled = false;
  emit('ready', { secureContext: window.isSecureContext });
});
panel.showModal();
panel.addEventListener('cancel', event => event.preventDefault());
pick.addEventListener('click', async () => {
  if (pending) return;
  pending = true; pick.disabled = true; next.disabled = true; judgment.hidden = true;
  started = performance.now(); emit('requested');
  result.textContent = '请等待至少 8 秒，再手动取消系统选文件窗口。';
  const timer = setTimeout(() => { if (pending) { emit('pending-eight-seconds'); result.textContent = '已经过 8 秒，可以手动取消。'; } }, 8000);
  try {
    if (backend === 'input') {
      await new Promise((resolve, reject) => {
        const settle = event => { input.removeEventListener('change', settle); input.removeEventListener('cancel', settle); emit(`input-${event.type}`, { count: input.files.length }); input.value = ''; resolve(); };
        input.addEventListener('change', settle); input.addEventListener('cancel', settle);
        try { input.click(); } catch (error) { input.removeEventListener('change', settle); input.removeEventListener('cancel', settle); reject(error); }
      });
    } else if (backend === 'browser') {
      const files = await window.showOpenFilePicker({ multiple: true, types: [{ description: '录音', accept: { 'audio/*': ['.wav', '.mp3', '.m4a'] } }] });
      emit('selected', { count: files.length });
    } else {
      const response = await bridge.native();
      emit(response.canceled ? 'native-cancel' : 'selected', { count: response.count });
    }
    emit('resolved');
  } catch (error) { emit('rejected', { errorName: error.name }); }
  finally {
    clearTimeout(timer); pending = false; pick.disabled = false;
    result.textContent = `选择窗口已返回，经过 ${((performance.now() - started) / 1000).toFixed(1)} 秒。请选择实际表现：`;
    judgment.hidden = false;
  }
});
for (const button of judgment.querySelectorAll('button')) button.addEventListener('click', () => {
  emit('user-observation', { judgment: button.dataset.judgment });
  result.textContent = backend === 'native' ? '三项对照完成，结果已记录。可关闭此窗口。' : '结果已记录，请点击下方按钮进入下一项。';
  judgment.hidden = true;
  next.disabled = backend === 'native';
});
next.addEventListener('click', () => { next.disabled = true; void bridge.restart(); });
