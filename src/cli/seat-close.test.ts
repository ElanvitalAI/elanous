import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { planSeatClose, readKnownSeatIds, type SeatCloseDeps } from './seat-close.js';
import { registerSeatBootCommands } from './seat-cli.js';

const deps = (over: Partial<SeatCloseDeps> = {}): SeatCloseDeps => ({
  home: '/tmp/seat-close',
  knownSeats: ['OP', 'TC', 'MK', 'UX'],
  shares: [
    { kind: 'claim', id: 'APP-BUILD-SANDBOX', detail: 'yellow' },
    { kind: 'wakeup', id: '2026-11-17T16:00Z', detail: 'retro' },
  ],
  ...over,
});

test('seat close lists shares when the closing seat is outside the registry', () => {
  const result = planSeatClose({ seat: 'MVP-B', handoffTo: 'OP' }, deps());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.lines).toEqual([
    'claim\tAPP-BUILD-SANDBOX\tyellow',
    'wakeup\t2026-11-17T16:00Z\tretro',
  ]);
  expect(result.event).toContain('handoff=OP');
  expect(result.event).toContain('force=no');
});

test('seat close refuses a missing or unregistered handoff seat', () => {
  expect(planSeatClose({ seat: 'MVP-B' }, deps()).ok).toBe(false);
  const missing = planSeatClose({ seat: 'MVP-B', handoffTo: 'NOBODY' }, deps());
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.reason).toContain('not in the seat registry');
  const self = planSeatClose({ seat: 'RES', handoffTo: 'RES' }, deps({ knownSeats: ['RES', 'OP'] }));
  expect(self.ok).toBe(false);
  if (!self.ok) expect(self.reason).toContain('is the closing seat');
});

test('seat close --force still requires a reason and records the event', () => {
  const bare = planSeatClose({ seat: 'MVP-B', force: true }, deps());
  expect(bare.ok).toBe(false);
  if (!bare.ok) expect(bare.reason).toContain('requires a reason');
  const forced = planSeatClose({ seat: 'MVP-B', force: true, forceReason: 'owner gone', now: '2026-11-17T15:40:00Z' }, deps({ shares: [] }));
  expect(forced.ok).toBe(true);
  if (!forced.ok) return;
  expect(forced.lines).toEqual(['(none)']);
  expect(forced.event).toContain('force=yes');
  expect(forced.event).toContain('reason=owner gone');
});

test('close command accepts a real registry handoff and refuses an unknown one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-close-'));
  const home = join(root, 'home');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'RES'), { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'RES-INFRA'), { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OPS'), { recursive: true });
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'RES-INFRA', 'ROLE.md'), '# RES-INFRA\\n');
  writeFileSync(join(root, 'scripts', 'coord-tracks.json'), JSON.stringify({
    tracks: [{ id: 'OP' }, { id: 'TC' }, { id: 'MK' }, { id: 'UX' }, { id: 'E' }],
  }));
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'RES', 'harvest-claims.tsv'), 'pr\tclaimer\n');
  const logs: string[] = [];
  const errors: string[] = [];
  const previous = { log: console.log, error: console.error, code: process.exitCode };
  console.log = (line?: unknown) => { logs.push(String(line)); };
  console.error = (line?: unknown) => { errors.push(String(line)); };
  const run = async (handoff: string) => {
    logs.length = 0;
    errors.length = 0;
    process.exitCode = 0;
    const command = new Command().exitOverride();
    registerSeatBootCommands(command, { home: () => home, repoRoot: () => root });
    await command.parseAsync(['close', 'RES', '--handoff-to', handoff], { from: 'user' });
  };
  try {
    await run('RES-INFRA');
    expect(process.exitCode ?? 0).toBe(0);
    expect(logs).toContain('claim\tharvest-claims.tsv\tpresent');
    const event = readFileSync(join(home, 'elanous-hq', 'seat-state', 'events', 'seat-close.jsonl'), 'utf8');
    expect(event).toContain('seat=RES');
    expect(event).toContain('handoff=RES-INFRA');
    await run('NOBODY');
    expect(process.exitCode).toBe(2);
    expect(errors.join('\\n')).toContain('not in the seat registry');
    await run('OPS');
    expect(process.exitCode).toBe(2);
    expect(errors.join('\\n')).toContain('not in the seat registry');
    await run('RES');
    expect(process.exitCode).toBe(2);
    expect(errors.join('\\n')).toContain('is the closing seat');
    expect(readKnownSeatIds(home, root)).toContain('RES-INFRA');
    expect(readKnownSeatIds(home, root)).not.toContain('OPS');
  } finally {
    console.log = previous.log;
    console.error = previous.error;
    process.exitCode = previous.code ?? 0;
  }
});
