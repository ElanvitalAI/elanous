import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideSeatMailTrust, declaredFederationSeats } from './seat-mail-trust.js';

const tmp = mkdtempSync(join(tmpdir(), 'seat-mail-trust-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('trust decision from structured fields only; the ledger stamp is required', () => {
  const seats = new Set(['TC']);
  expect(decideSeatMailTrust({ from: 'TC', viaLedger: true }, seats)).toEqual({ trusted: true, reason: 'declared-seat' });
  expect(decideSeatMailTrust({ from: 'tc', originKind: 'agent', viaLedger: true }, seats)).toEqual({ trusted: true, reason: 'declared-seat' });
  expect(decideSeatMailTrust({ from: 'NOBODY', crownDirective: '42', viaLedger: true }, seats)).toEqual({ trusted: true, reason: 'crown-directive' });
  expect(decideSeatMailTrust({ from: 'NOBODY', viaLedger: true }, seats)).toEqual({ trusted: false, reason: 'unknown-sender' });
  expect(decideSeatMailTrust({ from: 'TC', originKind: 'system', crownDirective: '42', viaLedger: true }, seats)).toEqual({ trusted: false, reason: 'external-origin' });
  expect(decideSeatMailTrust({ from: 'TC', originKind: 'invalid', viaLedger: true }, seats)).toEqual({ trusted: false, reason: 'external-origin' });
  expect(decideSeatMailTrust({ from: 'TC' }, seats)).toEqual({ trusted: false, reason: 'unauthenticated-path' });
  expect(decideSeatMailTrust({ from: 'TC', crownDirective: '42' }, seats)).toEqual({ trusted: false, reason: 'unauthenticated-path' });
});

test('declared seats are read from an injected isolated state root (never the real registry)', () => {
  const stateRoot = join(tmp, 'seat-state');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, 'seat-registry.json'), JSON.stringify({ version: 1, seats: [
    { address: 'JUD', host: 'local', wake: 'none', replyBody: 'agent', optIn: false },
  ] }));
  const seats = declaredFederationSeats({ stateRoot, cwd: tmp, home: tmp, now: Date.now() });
  expect([...seats]).toEqual(['JUD']);
  expect(declaredFederationSeats({ stateRoot: join(tmp, 'absent'), cwd: tmp, home: tmp, now: Date.now() }).size).toBe(0);
});
