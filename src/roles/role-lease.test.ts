import { describe, expect, test } from 'bun:test';
import { nextAccept, nextClaim, nextHandoff, nextRevert, parseRoleLease } from './role-lease.js';

describe('control primary role lease', () => {
  test('claim, handoff, accept and revert advance document fencing generation', () => {
    const claim = nextClaim({ kind: 'absent' }, 'mbp', 100);
    expect(claim).toEqual({ holder: 'mbp', generation: 1, state: 'held', renewedAt: 100 });
    const handingOff = nextHandoff(claim, 'mbp', 'node-b', 200);
    expect(handingOff).toEqual({ holder: 'node-b', generation: 2, state: 'handing-off', from: 'mbp', renewedAt: 200 });
    expect(nextAccept(handingOff, 'node-b', 300)).toEqual({ holder: 'node-b', generation: 3, state: 'held', renewedAt: 300 });
    expect(nextRevert(handingOff, 300)).toEqual({ holder: 'mbp', generation: 3, state: 'held', renewedAt: 300 });
  });

  test('non-holder handoff and wrong recipient or already-held acceptance are rejected', () => {
    const held = nextClaim({ kind: 'absent' }, 'mbp', 100);
    const pending = nextHandoff(held, 'mbp', 'node-b', 200);
    expect(() => nextHandoff(held, 'node-b', 'mbp')).toThrow();
    expect(() => nextAccept(pending, 'mbp')).toThrow();
    expect(() => nextAccept(held, 'mbp')).toThrow();
    expect(() => nextClaim({ kind: 'present', doc: held }, 'node-b')).toThrow();
    expect(() => nextRevert(held)).toThrow();
  });

  test('malformed lease is unmeasured rather than absent; accepted document has no from', () => {
    expect(parseRoleLease('')).toEqual({ kind: 'unmeasured', why: 'empty lease body' });
    expect(parseRoleLease('{')).toMatchObject({ kind: 'unmeasured' });
    expect(parseRoleLease(JSON.stringify({ holder: 'node-b', generation: 3, state: 'held', from: 'mbp', renewedAt: 123 }))).toMatchObject({ kind: 'unmeasured' });
    expect(parseRoleLease(JSON.stringify(nextAccept(nextHandoff(nextClaim({ kind: 'absent' }, 'mbp'), 'mbp', 'node-b'), 'node-b')))).toMatchObject({ kind: 'present', doc: { holder: 'node-b', state: 'held', generation: 3 } });
  });
});
