// Opt-in TEST integration driver. Credentials stay in a private fixture file.
// Uses production desktop owner, HTTP bridge and plugin lifecycle adapter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { DesktopDeviceLockOwner } from '../../dist/device-lock-owner.js';
import { FileDeviceLockStore } from '../../dist/device-lock-store.js';
import { startDesktopCapabilityBridge } from '../../dist/desktop-capability-bridge.js';
const fixture = JSON.parse(readFileSync(process.env.DEVICE_LOCK_UI_FIXTURE, 'utf8'));
assert.equal(fixture.baseURL, 'https://jotmo.senguo.me');
const { DeviceLockService } = await import(pathToFileURL(process.env.DEVICE_LOCK_PLUGIN_MODULE).href);
let session = { userId: fixture.userId, accessToken: fixture.desktop.accessToken, refreshToken: fixture.desktop.refreshToken };
let authentications = 0;
const owner = new DesktopDeviceLockOwner({
  store: new FileDeviceLockStore(path.join(fixture.stateDirectory, 'desktop-lock.json')),
  baseURL: fixture.baseURL, platform: 'macos', name: 'Device lock acceptance Mac',
  available: async () => true,
  authenticate: async () => { authentications++; throw new Error('Unexpected native fallback for supported phone'); },
  changed: () => {},
});
await owner.initialize();
const bridge = await startDesktopCapabilityBridge({ deviceLock: owner,
  notifications: { submit: () => ({ accepted: false }) }, notificationSupported: () => false,
  badges: { mode: 'none', beginSession() {}, endSession() {}, applySnapshot() {} },
});
bridge.activateSession('device-lock-acceptance');
const service = new DeviceLockService({ config: { dshRemoteRealtimeBaseUrl: 'https://jotmo-realtime.senguo.me' },
  fetchImpl: fetch, accountScopedSession: async () => session,
  sessionStore: { read: async () => session }, refreshAccessToken: async () => { throw new Error('Fixture token expired'); },
}, async expected => { assert.equal(session, expected); session = undefined; },
{ endpoint: bridge.url, token: bridge.token, sessionId: 'device-lock-acceptance' });
await service.refresh();
console.log(JSON.stringify({ ready: true }));
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, action } = JSON.parse(line);
    try {
      if (action === 'lock') await service.lock();
      else if (action === 'unlock') await owner.requestUnlock();
      else if (action === 'sync') await service.refresh();
      else if (action !== 'status') throw new Error('Invalid driver action');
      console.log(JSON.stringify({ id, snapshot: owner.snapshot(), authentications }));
    } catch (error) { console.log(JSON.stringify({ id, error: error.message })); }
  }
} finally { service.dispose(); owner.close(); await bridge.close(); }
