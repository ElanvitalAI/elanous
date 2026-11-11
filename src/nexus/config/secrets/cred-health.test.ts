import { expect, test } from 'bun:test';
import { createFakeCred } from '../../../ux-sim/fake-cred.js';
import { assessCredentialHealth, assessOAuthCredentialHealth } from './cred-health.js';

test('fake credential observation yields each health state without returning grant metadata', () => {
  // Source: fixture uses a 100 ms warning window around a fixed 1,000 ms simulation clock.
  let now = 1_000;
  const fake = createFakeCred({ now: () => now });
  const status = (slot: string) => assessCredentialHealth(fake.inspect(slot), 'read', now, 100);
  expect(status('cred:eodhd.api_key')).toBe('missing');
  fake.install('cred:eodhd.api_key', { permissions: ['read'], expiresAt: 2_000 });
  expect(status('cred:eodhd.api_key')).toBe('valid');
  fake.install('cred:krx.api_key', { permissions: ['read'], expiresAt: 1_100 });
  expect(status('cred:krx.api_key')).toBe('expiring');
  fake.install('cred:fds.api_key', { permissions: ['read'], expiresAt: 1_000 });
  expect(status('cred:fds.api_key')).toBe('expired');
  fake.install('cred:twelvedata.api_key', { permissions: ['write'], expiresAt: 2_000 });
  expect(status('cred:twelvedata.api_key')).toBe('insufficient-permission');
  now = 1_100;
  expect(status('cred:krx.api_key')).toBe('expired');
  expect(JSON.stringify(status('cred:eodhd.api_key'))).not.toContain('permissions');
  expect(JSON.stringify(status('cred:eodhd.api_key'))).not.toContain('expiresAt');
});

test('OAuth token metadata classifies expiry and required scope without returning tokens', () => {
  // Source: fixed simulation time and 100 ms warning window exercise both expiry boundaries.
  const now = 1_000;
  const token = { present: true, expiresAt: 2_000, scope: 'read write' };
  expect(assessOAuthCredentialHealth({ present: false }, ['read'], now, 100)).toBe('missing');
  expect(assessOAuthCredentialHealth(null, ['read'], now, 100)).toBe('missing');
  expect(assessOAuthCredentialHealth(token, ['read'], now, 100)).toBe('valid');
  expect(assessOAuthCredentialHealth({ ...token, expiresAt: 1_100 }, ['read'], now, 100)).toBe('expiring');
  expect(assessOAuthCredentialHealth({ ...token, expiresAt: 1_000 }, ['read'], now, 100)).toBe('expired');
  expect(assessOAuthCredentialHealth(token, ['admin'], now, 100)).toBe('insufficient-permission');
  expect(assessOAuthCredentialHealth({ ...token, expiresAt: null }, ['read'], now, 100)).toBe('unmeasured');
  expect(assessOAuthCredentialHealth({ ...token, scope: undefined }, ['read'], now, 100)).toBe('unmeasured');
  expect(assessOAuthCredentialHealth({ ...token, scope: '' }, ['read'], now, 100)).toBe('unmeasured');
  expect(assessOAuthCredentialHealth(token, null, now, 100)).toBe('unmeasured');
});
