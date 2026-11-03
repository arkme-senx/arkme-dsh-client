import {test, expect} from 'vitest';
import {putImmutableObject} from '../scripts/ci/oss-upload.mjs';

test('lost response retries with renewed scoped credentials and accepts existing object for subsequent digest verification', async () => {
  let grants = 0;
  const bytes = Buffer.from('immutable');
  const result = await putImmutableObject({bytes, credentials: async () => ({object_key: 'fixed', generation: ++grants}), wait: async () => {},
    createClient: (grant, options) => {
      expect(options.timeout).toBe(300000);
      return {put: async (key, value, args) => {
        expect(key).toBe('fixed'); expect(value).toBe(bytes); expect(args.headers['x-oss-forbid-overwrite']).toBe('true');
        if (grant.generation === 1) throw {name: 'ResponseTimeoutError', message: 'secret request'};
        throw {code: 'FileAlreadyExists', status: 409};
      }};
    }});
  expect(grants).toBe(2); expect(result.generation).toBe(2);
});

test('permanent errors stop immediately and redact sensitive SDK diagnostics', async () => {
  let attempts = 0;
  await expect(putImmutableObject({bytes: Buffer.from('x'), credentials: async () => ({}), createClient: () => ({put: async () => {
    attempts++; throw {code: 'AccessDenied', status: 403, message: 'secret token', request: {authorization: 'secret'}};
  }})})).rejects.toThrow('OSS upload failed (AccessDenied; status=403; attempts=1)');
  expect(attempts).toBe(1);
});

test('transient retries are bounded', async () => {
  let attempts = 0;
  await expect(putImmutableObject({bytes: Buffer.from('x'), credentials: async () => ({}), wait: async () => {}, createClient: () => ({put: async () => {
    attempts++; throw {code: 'ETIMEDOUT'};
  }})})).rejects.toThrow('attempts=3');
  expect(attempts).toBe(3);
});
