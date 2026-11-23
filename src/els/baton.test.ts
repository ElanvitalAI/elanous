import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActiveBaton } from './baton.js';

describe('active baton snapshot', () => {
  test('reads only a valid unexpired baton at the agreed path', () => {
    const root = mkdtempSync(join(tmpdir(), 'els-baton-'));
    try {
      const baton = { owner: 'OP', acting: 'TC', expiresAt: '2026-11-23T07:30:00.000Z', reason: 'restart' };
      const expiry = Date.parse(baton.expiresAt);
      expect(readActiveBaton(root, expiry - 1)).toBeNull();
      writeFileSync(join(root, 'baton.json'), JSON.stringify(baton));
      expect(readActiveBaton(root, expiry - 1)).toEqual(baton);
      expect(readActiveBaton(root, expiry)).toBeNull();
      expect(readActiveBaton(root, NaN)).toBeNull();
      writeFileSync(join(root, 'baton.json'), '{');
      expect(readActiveBaton(root, expiry - 1)).toBeNull();
      writeFileSync(join(root, 'baton.json'), JSON.stringify({ ...baton, acting: 'OP' }));
      expect(readActiveBaton(root, expiry - 1)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { BatonLease, type BatonEvent } from './baton.js';

describe('server-only baton lease', () => {
  test('requires OP to issue, TC or OP to end, and audits transitions', () => {
    let now = Date.parse('2026-11-23T07:00:00Z');
    const events: BatonEvent[] = [];
    const lease = new BatonLease(event => events.push(event), () => now);
    expect(() => lease.hand({ kind: 'seat', seat: 'TC' }, 'OP', 'TC', 'restart', 1000)).toThrow();
    lease.hand({ kind: 'op' }, 'OP', 'TC', 'restart', 1000);
    expect(() => lease.hand({ kind: 'op' }, 'OP', 'TC', 'restart', 1000)).toThrow();
    expect(() => lease.end('return', { kind: 'seat', seat: 'OTHER' }, 'OP', 'done')).toThrow();
    expect(() => lease.end('take', { kind: 'seat', seat: 'TC' }, 'OP', 'done')).toThrow();
    lease.end('return', { kind: 'seat', seat: 'TC' }, 'OP', 'mail 42 handled');
    expect(lease.active()).toBeNull();
    lease.hand({ kind: 'op' }, 'OP', 'TC', 'restart', 1000);
    now += 1000;
    expect(lease.active()).toBeNull();
    expect(events.map(e => e.action)).toEqual(['hand', 'return', 'hand', 'expire']);
  });
  test('audit failure never grants and expiry revokes even if audit fails', () => {
    let now = 1_000;
    let fail = true;
    const lease = new BatonLease(() => { if (fail) throw new Error('disk'); }, () => now);
    expect(() => lease.hand({ kind: 'op' }, 'OP', 'TC', 'restart', 100)).toThrow();
    expect(lease.active()).toBeNull();
    fail = false;
    lease.hand({ kind: 'op' }, 'OP', 'TC', 'restart', 100);
    fail = true;
    now += 100;
    expect(() => lease.active()).toThrow();
    expect(lease.active()).toBeNull();
  });
});
