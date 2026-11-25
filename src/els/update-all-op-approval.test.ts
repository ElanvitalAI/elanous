import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOpUpdate, readStandingApproval, standingApprovalPath, writeStandingApproval, type OpPrepareDeps } from './update-all-op-approval.js';

const TARGET = '0123456789abcdef0123456789abcdef01234567';
const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
const GRANT = { grantedBy: 'CEO' as const, grantedAt: '2026-11-25T11:45:00.000Z' };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function harness(over: Partial<OpPrepareDeps> & { catchUp?: OpPrepareDeps['runCatchUp'] } = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const errLines: string[] = [];
  let asked = 0;
  const deps: OpPrepareDeps = {
    target: TARGET,
    installedCommit: () => TARGET,
    desired: () => TARGET,
    standing: () => null,
    interactive: false,
    askTerminal: async () => { asked += 1; return true; },
    runCatchUp: over.catchUp ?? (async () => ({ exitCode: 0, reason: 'host current' })),
    log: (event, data) => { events.push({ event, data }); },
    stderr: line => { errLines.push(line); },
    ...over,
  };
  return { deps, events, errLines, asked: () => asked };
}

test('standing approval: non-TTY OP run migrates without a terminal prompt and logs approved-by-standing', async () => {
  const h = harness({ standing: () => GRANT });
  const status = await prepareOpUpdate(h.deps);
  expect(status).toBe('already up to date (skipped)');
  expect(h.asked()).toBe(0);
  expect(h.events).toEqual([{ event: 'els.update-all approved-by-standing', data: { grantedBy: 'CEO', grantedAt: '2026-11-25T11:45:00.000Z', target: '0123456789abcdef0123456789abcdef01234567' } }]);
  expect(h.errLines).toEqual(['els update-all: approved by standing approval (granted by CEO at 2026-11-25T11:45:00.000Z)']);
});

test('standing approval also answers a catch-up HITL raised while the target is installed', async () => {
  let approvals = 0;
  const h = harness({ standing: () => GRANT, catchUp: async (approveOp) => { if (await approveOp()) approvals += 1; return { exitCode: 0 }; } });
  expect(await prepareOpUpdate(h.deps)).toBe('already up to date (skipped)');
  expect(approvals).toBe(1);
  expect(h.asked()).toBe(0);
  expect(h.events.map(e => e.event)).toEqual(['els.update-all approved-by-standing']);
});

test('no standing approval + non-TTY fails fast with a clear message and never starts catch-up', async () => {
  let ran = false;
  const h = harness({ catchUp: async () => { ran = true; return { exitCode: 0 }; } });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('needs approval: run once in a terminal or grant standing approval (els update-all --grant-standing)');
  expect(ran).toBe(false);
  expect(h.events[0]?.event).toBe('els.update-all failed');
});

test('standing approval does not cover a target that is not installed on this host yet', async () => {
  const h = harness({ standing: () => GRANT, installedCommit: () => OLD });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('needs approval: run once in a terminal or grant standing approval (els update-all --grant-standing); standing approval covers migration only after 0123456789ab is installed on this host');
});

test('standing approval does not cover a target that is no longer desiredSha', async () => {
  const h = harness({ standing: () => GRANT, desired: () => OLD });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('needs approval: run once in a terminal or grant standing approval (els update-all --grant-standing)');
});

test('terminal stays the default: interactive run without standing approval asks once', async () => {
  const h = harness({ interactive: true });
  expect(await prepareOpUpdate(h.deps)).toBe('already up to date (skipped)');
  expect(h.asked()).toBe(1);
});

test('terminal denial cancels the migration', async () => {
  const h = harness({ interactive: true, askTerminal: async () => false });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('Migration cancelled');
});

test('catch-up failure reason is surfaced in the error, stderr and logs', async () => {
  const h = harness({ interactive: true, catchUp: async (_approve, out) => {
    out.error('self-update --catch-up failed: rail not allowed by current phase; gate closed');
    out.log('self-update --catch-up: rail not allowed by current phase; gate closed');
    return { exitCode: 1, reason: 'rail not allowed by current phase; gate closed' };
  } });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('Installation update failed: rail not allowed by current phase; gate closed');
  expect(h.errLines).toEqual(['els update-all: self-update --catch-up failed: rail not allowed by current phase; gate closed']);
  expect(h.events).toEqual([{ event: 'els.update-all failed', data: { reason: 'rail not allowed by current phase; gate closed', target: '0123456789abcdef0123456789abcdef01234567', exitCode: 1 } }]);
});

test('catch-up failure without a reason field falls back to the last logged line', async () => {
  const h = harness({ interactive: true, catchUp: async (_approve, out) => { out.log('self-update --catch-up: local checkout unknown — use --from'); return { exitCode: 1 }; } });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('Installation update failed: local checkout unknown — use --from');
});

test('invalid target is refused before anything else', async () => {
  const h = harness({ target: 'not-a-sha' });
  await expect(prepareOpUpdate(h.deps)).rejects.toThrow('Target build unavailable');
});

test('standing record round-trips and only a CEO grant with a valid time counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-standing-'));
  dirs.push(dir);
  const path = standingApprovalPath(dir);
  expect(path).toBe(join(dir, 'els', 'update-all-standing-approval.json'));
  expect(readStandingApproval(path)).toBeNull();
  writeStandingApproval(path, { ...GRANT, note: 'rail migrations' });
  expect(readStandingApproval(path)).toEqual({ grantedBy: 'CEO', grantedAt: '2026-11-25T11:45:00.000Z', note: 'rail migrations' });
  mkdirSync(join(dir, 'els'), { recursive: true });
  writeFileSync(path, JSON.stringify({ grantedBy: 'OP', grantedAt: '2026-11-25T11:45:00.000Z' }));
  expect(readStandingApproval(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ grantedBy: 'CEO', grantedAt: 'yesterday-ish' }));
  expect(readStandingApproval(path)).toBeNull();
  writeFileSync(path, '{not json');
  expect(readStandingApproval(path)).toBeNull();
});
