// ── `eln commitment list|done|blocked` 시험 — 임시 원장 · 가짜 시계 (COMMITMENT-CLOSE) ──
// 기대값은 리터럴이다.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommitmentLedger } from '../commitment/ledger.js';
import { armWaker, listWakers, type SelfTimerDeps } from '../msg/self-timer-watch.js';
import { registerCommitmentCommands } from './commitment-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'commitment-cli-'));
  dirs.push(dir);
  const now = () => new Date('2026-11-25T03:00:00.000Z');
  let cid = 0;
  let wid = 0;
  const ledger = new CommitmentLedger({ root: join(dir, 'ledger'), now, emit: () => {}, newId: () => `c-${++cid}` });
  const timer: SelfTimerDeps = { root: join(dir, 'ledger', 'wakers'), ledger, now, emit: () => {}, newId: () => `w-${++wid}` };
  ledger.add({ seat: 'JUD', sessionId: 'msg:160695', text: 'Follow up on message #160695 to OP', evidence: 'MsgPost #160695' });
  armWaker({ seat: 'JUD', commitmentId: 'c-1', condition: 'mail-reply:160695', withinMs: 30 * 60_000 }, timer);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command().exitOverride();
  registerCommitmentCommands(program, { ledger, timer, out: { log: l => stdout.push(l), error: l => stderr.push(l) }, setExitCode: c => exits.push(c) });
  const run = (...args: string[]) => program.parseAsync(['node', 'elanous', 'commitment', ...args]);
  return { ledger, timer, stdout, stderr, exits, run };
}

test('list = 열린 약속 한 줄 · 깨우개 id 포함', async () => {
  const f = fixture();
  await f.run('list');
  expect(f.stdout).toEqual(['c-1 JUD open «Follow up on message #160695 to OP» · wakers w-1']);
});

test('done <id> --evidence = 닫고 깨우개 거둠', async () => {
  const f = fixture();
  await f.run('done', 'c-1', '--evidence', 'OP replied in #160701');
  expect(f.exits).toEqual([]);
  expect(f.stdout).toEqual(['Commitment c-1 (JUD) → done · wakers cancelled: w-1']);
  expect(f.ledger.get('JUD', 'c-1')?.doneEvidence).toBe('OP replied in #160701');
  expect(listWakers('JUD', f.timer).map(w => w.status)).toEqual(['cancelled']);
  await f.run('list', '--status', 'done');
  expect(f.stdout.at(-1)).toBe('c-1 JUD done «Follow up on message #160695 to OP» · wakers w-1 · evidence: OP replied in #160701');
});

test('blocked <id> --evidence = 근거가 reason 으로 남는다', async () => {
  const f = fixture();
  await f.run('blocked', 'c-1', '--evidence', 'OP away until 14:00', '--json');
  const parsed = JSON.parse(f.stdout.at(-1)!) as { ok: boolean; entry: { status: string; reason: string }; cancelledWakers: string[] };
  expect(parsed.ok).toBe(true);
  expect(parsed.entry.status).toBe('blocked');
  expect(parsed.entry.reason).toBe('OP away until 14:00');
  expect(parsed.cancelledWakers).toEqual(['w-1']);
});

test('없는 id = rc 1 · 이중 닫기 = rc 1 · 근거 없음 = commander 거부', async () => {
  const f = fixture();
  await f.run('done', 'c-404', '--evidence', 'x');
  expect(f.exits).toEqual([1]);
  expect(f.stderr.at(-1)).toBe('commitment done: commitment not found: c-404 (list open ones: eln commitment list)');
  await f.run('done', 'c-1', '--evidence', 'first');
  await f.run('done', 'c-1', '--evidence', 'second');
  expect(f.exits).toEqual([1, 1]);
  expect(f.ledger.get('JUD', 'c-1')?.doneEvidence).toBe('first');
  let refused = false;
  try { await f.run('done', 'c-1'); } catch { refused = true; }
  expect(refused).toBe(true);
});
