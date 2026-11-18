// ── `msg wait-for`·`wait-tick`·`wait-list` CLI 시험 — 가짜 시계·탐침·notice (ELN-SELF-TIMER-WATCH · I3) ──
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommitmentLedger } from '../dashboard/input/commitment-ledger.js';
import type { SelfTimerDeps } from '../msg/self-timer-watch.js';
import { registerMsgWaitForCommands, WAIT_FOR_EXIT_EXPIRED, WAIT_FOR_EXIT_REJECTED } from './msg-wait-for-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(merged: () => boolean = () => false) {
  const dir = mkdtempSync(join(tmpdir(), 'msg-wait-for-'));
  dirs.push(dir);
  let nowMs = Date.parse('2026-11-17T09:00:00.000Z');
  const now = () => new Date(nowMs);
  const ledger = new CommitmentLedger({ root: join(dir, 'ledger'), now, emit: () => {} });
  const entry = ledger.add({ seat: 'TC', sessionId: 's1', text: '리뷰 반영', evidence: '#38050 리뷰 결과 오면 반영하겠습니다.' }).entry;
  const notices: string[] = [];
  const timer: SelfTimerDeps = {
    root: join(dir, 'wakers'), ledger, now, emit: () => {},
    sleep: async (ms) => { nowMs += ms; },
    probes: { prMerged: async () => merged(), reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false },
    postNotice: async (_seat, body) => { notices.push(body); return notices.length; },
    isPidAlive: () => false,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command().exitOverride();
  registerMsgWaitForCommands(program.command('msg'), { timer, out: { log: l => stdout.push(l), error: l => stderr.push(l) }, setExitCode: c => exits.push(c), cwd: () => dir });
  const run = (...args: string[]) => program.parseAsync(['node', 'elanous', 'msg', ...args]);
  return { entry, notices, stdout, stderr, exits, run };
}

test('원장 항목 없이 걸면 거부(rc 2) · 아무것도 안 걸림', async () => {
  const f = fixture();
  await f.run('wait-for', 'pr-merged:1', '--notify', 'TC', '--commitment', 'c-none', '--arm-only');
  expect(f.exits).toEqual([WAIT_FOR_EXIT_REJECTED]);
  expect(f.stderr.join('\n')).toContain('ledger entry');
  await f.run('wait-list', '--seat', 'TC', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([]);
});

test('--arm-only 두 번 = 걸림 → 합침', async () => {
  const f = fixture();
  await f.run('wait-for', 'pr-merged:38050', '--notify', 'TC', '--commitment', f.entry.id, '--arm-only', '--json');
  await f.run('wait-for', 'pr-merged:38050', '--notify', 'TC', '--commitment', f.entry.id, '--arm-only', '--json');
  expect(f.stdout.map(l => JSON.parse(l).outcome)).toEqual(['armed', 'merged']);
  expect(f.exits).toEqual([]);
});

test('지켜보기 — 머지되면 발화 notice · rc 0', async () => {
  const f = fixture(() => true);
  await f.run('wait-for', 'pr-merged:38050', '--notify', 'TC', '--commitment', f.entry.id, '--json');
  expect(JSON.parse(f.stdout.at(-1)!).outcome).toBe('fired');
  expect(f.notices).toHaveLength(1);
  expect(f.exits).toEqual([]);
});

test('지켜보기 — 지평 안에 안 차면 expired notice · rc 3', async () => {
  const f = fixture();
  await f.run('wait-for', 'pr-merged:38050', '--notify', 'TC', '--commitment', f.entry.id, '--within', '10m', '--json');
  expect(JSON.parse(f.stdout.at(-1)!).outcome).toBe('expired');
  expect(f.notices[0]).toContain('expired');
  expect(f.exits).toEqual([WAIT_FOR_EXIT_EXPIRED]);
});

test('wait-tick = 한 번 재고 끝남', async () => {
  const f = fixture();
  await f.run('wait-for', 'pr-merged:38050', '--notify', 'TC', '--commitment', f.entry.id, '--arm-only');
  await f.run('wait-tick', '--seat', 'TC', '--json');
  expect(JSON.parse(f.stdout.at(-1)!).map((t: { outcome: string }) => t.outcome)).toEqual(['pending']);
});
