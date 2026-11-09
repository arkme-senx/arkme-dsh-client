import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('arkmeCallTransport', {
  attach: (receive: (command: string) => void) => {
    ipcRenderer.on('arkme-call:deliver', (_event, command: string) => receive(command));
    ipcRenderer.send('arkme-call:loaded');
  },
  emit: (message: string) => {
    // The SDK includes avatar data URLs and invitation metadata even on window actions.
    // Only forward the fields consumed by the desktop call controller.
    let event;
    try { event = JSON.parse(message); } catch { return; }
    if (!event || typeof event.type !== 'string') return;
    const { type, requestId, roomId, callId, mediaType, phase, statusText, message: detail,
      reason, hasActiveCall, camera, microphone, caller, callerName, label } = event;
    const payload = JSON.stringify({ type, requestId, roomId, callId, mediaType, phase,
      statusText, message: detail, reason, hasActiveCall, camera, microphone, callerName: callerName ?? caller?.name, label });
    if (payload.length <= 65536) ipcRenderer.send('arkme-call:message', payload);
  }
});

ipcRenderer.on('arkme-call:error', (_event, message: string) => {
  let panel = document.getElementById('arkme-call-error');
  if (!message) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'arkme-call-error';
    panel.style.cssText = 'position:fixed;inset:0;z-index:10;display:grid;align-content:center;justify-items:center;background:#101216;color:white;font:15px system-ui';
    const label = document.createElement('p');
    const close = document.createElement('button');
    close.textContent = '关闭';
    close.onclick = () => ipcRenderer.send('arkme-call:dismiss');
    panel.append(label, close);
    document.body.append(panel);
  }
  panel.querySelector('p')!.textContent = message;
});
