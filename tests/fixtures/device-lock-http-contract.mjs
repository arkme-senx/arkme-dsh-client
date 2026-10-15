// Explicit test-only HTTP adapter: real main-process owner + real backend routes.
// No Electron window, OS credential prompt, user account or production traffic.
import assert from 'node:assert/strict';
import { DesktopDeviceLockOwner } from '../../dist/device-lock-owner.js';
const env = process.env;
const target = new URL(env.DEVICE_LOCK_TEST_SERVER);
assert.equal(target.hostname, '127.0.0.1');
let state;
let authentications = 0;
let nativeSuccess = false;
const owner = new DesktopDeviceLockOwner({
  store: { read: () => state, write: next => { state = structuredClone(next); } },
  baseURL: 'https://jotmo.senguo.me', platform: 'macos', name: 'Contract Mac',
  available: async () => true, authenticate: async () => { authentications++; return nativeSuccess; },
  changed: () => {}, fetch: (url, options) => fetch(new URL(new URL(url).pathname, target), options),
});
const phone = async (route, body = {}) => {
  const response = await fetch(new URL(`/api/v1/device-control/${route}`, target), {
    method: 'POST', headers: { Authorization: `Bearer ${env.DEVICE_LOCK_TEST_PHONE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`phone ${route}: ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.code, 200, JSON.stringify(envelope));
  return envelope.data;
};
const desktop = async () => (await phone('list')).items.find(d => d.client_id === 2);
await owner.initialize(); await owner.bind(env.DEVICE_LOCK_TEST_DESKTOP_TOKEN);
await phone('register', { platform: 'ios', name: 'Contract iPhone', capability: 'supported' });
await owner.lock();
assert.equal((await desktop()).actual_lock, 'locked');
assert.equal(owner.protected, true);
if (env.DEVICE_LOCK_TEST_MODE === 'unknown') {
  await assert.rejects(owner.requestUnlock());
  assert.equal(authentications, 0);
  assert.equal(owner.protected, true);
} else if (env.DEVICE_LOCK_TEST_MODE === 'unsupported') {
  await owner.requestUnlock();
  assert.equal(authentications, 1);
  assert.equal(owner.protected, true);
  assert.equal((await desktop()).actual_lock, 'locked');
  nativeSuccess = true;
  await owner.requestUnlock();
  assert.equal(authentications, 2);
  assert.equal(owner.protected, false);
  assert.equal((await desktop()).actual_lock, 'unlocked');
} else {
  await owner.requestUnlock();
  let d = await desktop();
  assert.equal(d.operation.state, 'awaiting_confirmation');
  assert.equal(d.can_confirm, true);
  assert.equal(d.actual_lock, 'locked');
  await phone('confirm', { client_id: 2, session_id: d.session_id, lock_cycle: d.lock_cycle,
    request_id: d.operation.id, kind: 'unlock', expires_at: d.operation.expires_at, approve: true });
  assert.equal((await desktop()).actual_lock, 'locked', 'approval is not applied lock state');
  await owner.synchronize();
  assert.equal(owner.protected, false);
  assert.equal((await desktop()).actual_lock, 'unlocked');
  assert.equal(authentications, 0);
  const previousCycle = d.lock_cycle;
  await owner.lock();
  assert.notEqual((await desktop()).lock_cycle, previousCycle);
  await owner.synchronize();
  assert.equal(owner.protected, true, 'old grant must not unlock the next cycle');
}
const d = await desktop();
await phone('command', { client_id: 2, session_id: d.session_id, lock_cycle: d.lock_cycle,
  request_id: 'logout_contract_request_0001', kind: 'logout', expires_at: Date.now() + 60000 });
await owner.synchronize();
assert.equal(owner.snapshot().sessionEnded, true);
assert.equal(owner.protected, true);
assert.equal((await desktop()).session, 'ended');
assert.equal((await desktop()).cleanup_acknowledged_at, undefined);
await owner.completeLocalLogout();
await owner.synchronize();
assert.ok((await desktop()).cleanup_acknowledged_at > 0);
assert.equal(owner.protected, false);
console.log(`HTTP contract passed: ${env.DEVICE_LOCK_TEST_MODE}`);
