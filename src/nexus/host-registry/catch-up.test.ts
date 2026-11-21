import { describe, expect, test } from 'bun:test';
import { planCatchUp, shaMatches } from './catch-up.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const base = { host: 'host-a', installedSha: A, daemonSha: A as string | undefined, desiredSha: B, seatIsOp: false, railAllowed: true };
const current = { ...base, installedSha: B, daemonSha: B };
const plan = (o: object) => planCatchUp({ ...base, ...o });

describe('planCatchUp decision table', () => {
  test('installed == desired AND daemon runs desired -> none/open (12-char prefix equal; shaMatches needs 12+ hex)', () => {
    expect(plan(current)).toMatchObject({ action: 'none', assignGate: 'open' });
    expect(plan({ ...current, installedSha: B.slice(0, 12), daemonSha: B.slice(0, 12) })).toMatchObject({ action: 'none', assignGate: 'open' });
    expect(shaMatches(B, B.slice(0, 11))).toBe(false);
  });
  test('installed == desired but daemon unverified or stale -> gate never opens (restart-only install)', () => {
    expect(plan({ ...current, daemonSha: undefined })).toMatchObject({ action: 'install', assignGate: 'closed' });
    expect(plan({ ...current, daemonSha: A })).toMatchObject({ action: 'install', assignGate: 'closed' });
    expect(plan({ ...current, daemonSha: A, railAllowed: false })).toMatchObject({ action: 'none', assignGate: 'closed' });
  });
  test('behind: install (closed); rail=false non-OP: none/closed', () => {
    expect(plan({})).toMatchObject({ action: 'install', assignGate: 'closed' });
    expect(plan({ railAllowed: false })).toMatchObject({ action: 'none', assignGate: 'closed' });
  });
  test('OP seat behind -> hitl whatever the rail says; fully current OP -> none/open', () => {
    expect(plan({ seatIsOp: true })).toMatchObject({ action: 'hitl', assignGate: 'closed' });
    expect(plan({ seatIsOp: true, railAllowed: false })).toMatchObject({ action: 'hitl', assignGate: 'closed' });
    expect(plan({ ...current, seatIsOp: true, daemonSha: undefined })).toMatchObject({ action: 'hitl', assignGate: 'closed' });
    expect(plan({ ...current, seatIsOp: true })).toMatchObject({ action: 'none', assignGate: 'open' });
  });
  test('unknown or malformed sha never installs and keeps the gate closed', () => {
    for (const bad of ['', 'xyz', 'abc']) {
      expect(plan({ installedSha: bad })).toMatchObject({ action: 'none', assignGate: 'closed' });
      expect(plan({ desiredSha: bad })).toMatchObject({ action: 'none', assignGate: 'closed' });
    }
  });
});
