import { expect, test } from 'vitest';
import * as readiness from '../src/harness-page-ready.js';

test('accepts only the armed webContents main frame and current navigation nonce', async () => {
  const gate = new readiness.HarnessPageReadiness();
  const probe = gate.arm(10, 'http://127.0.0.1:1234/', new AbortController().signal, 1000);
  const sender = {webContentsId:10,isMainFrame:true,url:'http://127.0.0.1:1234/'};
  const nonce = gate.nonce(sender);
  expect(typeof nonce).toBe('string');
  expect(gate.nonce({...sender,isMainFrame:false})).toBeNull();
  expect(gate.accept({...sender,webContentsId:11},nonce)).toBe(false);
  expect(gate.accept({...sender,url:'https://evil.test/'},nonce)).toBe(false);
  gate.navigation(10);
  expect(gate.accept(sender,nonce)).toBe(false);
  expect(gate.accept(sender,gate.nonce(sender))).toBe(true);
  await probe.ready;
  probe.dispose();
  expect(gate.accept(sender,nonce)).toBe(false);
});

test('readiness cancellation rejects pending probe and prevents stale reports', async () => {
  const gate = new readiness.HarnessPageReadiness();
  const abort = new AbortController();
  const probe = gate.arm(1, 'http://127.0.0.1:1234/', abort.signal, 1000);
  const rejected = expect(probe.ready).rejects.toThrow();
  abort.abort();
  await rejected;
  expect(gate.nonce({webContentsId:1,isMainFrame:true,url:'http://127.0.0.1:1234/'})).toBeNull();
});

test('probe timeout rejects without accepting a later document report', async () => {
  const gate = new readiness.HarnessPageReadiness();
  const probe = gate.arm(1, 'http://127.0.0.1:1234/', new AbortController().signal, 5);
  const sender = {webContentsId:1,isMainFrame:true,url:'http://127.0.0.1:1234/'};
  const nonce = gate.nonce(sender);
  await expect(probe.ready).rejects.toThrow('timed out');
  expect(gate.accept(sender,nonce)).toBe(false);
});

test('local slot mount failures veto readiness while offline fetch errors do not', () => {
  expect(readiness.localHarnessMountFailure(3, "slot entry crashed in 'conversation.input.model': Error: cannot get property \"remote.session\" without inject"))
    .toBeInstanceOf(Error);
  expect(readiness.localHarnessMountFailure(3, 'TypeError: Failed to fetch')).toBeUndefined();
  expect(readiness.localHarnessMountFailure(3, 'Failed to load resource: net::ERR_PROXY_CONNECTION_FAILED')).toBeUndefined();
  expect(readiness.localHarnessMountFailure(1, "slot entry crashed in 'test'" )).toBeUndefined();
});

test('frame settling remains cancellable after the plugin signals local readiness', async () => {
  const abort = new AbortController();
  const pending = readiness.settleHarnessPageRendering(async () => new Promise(() => undefined), abort.signal);
  const rejected = expect(pending).rejects.toThrow('cancelled');
  abort.abort();
  await rejected;
});

test('a stalled renderer cannot hang the trial after readiness', async () => {
  await expect(readiness.settleHarnessPageRendering(async () => new Promise(() => undefined),
    new AbortController().signal, 5)).rejects.toThrow('timed out');
});
