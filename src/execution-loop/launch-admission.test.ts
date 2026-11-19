import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { decideLaunchAdmission, openLaunchRequestDoor, type LaunchAdmissionDeps } from './launch-gate.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'launch-admission-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
const TARGET = { card: 'card-1', cell: 'CELL-A', commit: SHA };

function receipt(overall: string, name = 'receipt.json', patch: Record<string, unknown> = {}): { path: string; sha: string } {
  const path = join(dir, name);
  const body = `${JSON.stringify({ kind: 'ta-preflight', createdAt: new Date().toISOString(), target: TARGET, report: { overall }, ...patch })}\n`;
  writeFileSync(path, body);
  return { path, sha: createHash('sha256').update(body).digest('hex') };
}
const door = (admission: LaunchAdmissionDeps) => openLaunchRequestDoor({ root: join(dir, 'root'), source: 'hand', admission });
const NONE = (): string => join(dir, 'no-hold');

test('OP hold file refuses a TA launch even with force, and does not consume the request', () => {
  const hold = join(dir, 'LAUNCH-HOLD');
  writeFileSync(hold, '전면 HOLD — MVP-B 무승인 발사\n');
  const r = receipt('READY');
  const d = door({ holdFile: hold, receiptPath: r.path, receiptSha256: r.sha });
  const id = d.requestId('ask-1');
  for (const opts of [{ ta: true, target: TARGET }, { ta: true, force: true, target: TARGET }, { ta: false, force: true }]) {
    const result = d.consume(id, opts);
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toContain('OP hold');
  }
  expect(d.rows(id).filter((row) => row.event === 'refused-admission')).toHaveLength(3);
  expect(d.rows(id).some((row) => row.event === 'consumed')).toBe(false);
  rmSync(hold);
  expect(d.consume(id, { ta: true, target: TARGET }).status).toBe('consumed');
});

test('TA launch without a READY PREFLIGHT receipt is refused, force included', () => {
  const missing = door({ holdFile: NONE() });
  const id = missing.requestId('ask-2');
  expect(missing.consume(id, { ta: true, force: true, target: TARGET })).toMatchObject({ status: 'refused' });

  const notReady = receipt('NOT_READY', 'nr.json');
  expect(door({ holdFile: NONE(), receiptPath: notReady.path, receiptSha256: notReady.sha }).consume(id, { ta: true, force: true, target: TARGET }))
    .toMatchObject({ status: 'refused', reason: expect.stringContaining('READY') });

  const ready = receipt('READY', 'ok.json');
  expect(door({ holdFile: NONE(), receiptPath: ready.path, receiptSha256: 'f'.repeat(64) }).consume(id, { ta: true, target: TARGET }))
    .toMatchObject({ status: 'refused', reason: expect.stringContaining('sha256') });
});

test('freshness is the createdAt inside the receipt, never the file mtime', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  // old createdAt + brand-new mtime (copied/touched file) → refused
  const old = receipt('READY', 'old.json', { createdAt: twoHoursAgo.toISOString() });
  utimesSync(old.path, new Date(), new Date());
  const id = door({ holdFile: NONE() }).requestId('ask-fresh');
  expect(door({ holdFile: NONE(), receiptPath: old.path, receiptSha256: old.sha }).consume(id, { ta: true, target: TARGET }))
    .toMatchObject({ status: 'refused', reason: expect.stringContaining('오래됨') });
  // fresh createdAt + ancient mtime → admitted
  const fresh = receipt('READY', 'fresh.json');
  utimesSync(fresh.path, twoHoursAgo, twoHoursAgo);
  expect(door({ holdFile: NONE(), receiptPath: fresh.path, receiptSha256: fresh.sha }).consume(id, { ta: true, target: TARGET }).status).toBe('consumed');
  // no createdAt / unparsable / future → refused
  for (const createdAt of [undefined, 'yesterday', new Date(Date.now() + 3600_000).toISOString()]) {
    const bad = receipt('READY', `bad-${String(createdAt).slice(0, 5)}.json`, { createdAt });
    expect(decideLaunchAdmission({ ta: true, now: new Date(), target: TARGET }, { holdFile: NONE(), receiptPath: bad.path, receiptSha256: bad.sha }).allowed).toBe(false);
  }
});

test('a receipt is valid only for the launch it names (card/cell/commit)', () => {
  const r = receipt('READY');
  const deps = { holdFile: NONE(), receiptPath: r.path, receiptSha256: r.sha };
  const now = new Date();
  expect(decideLaunchAdmission({ ta: true, now, target: TARGET }, deps).allowed).toBe(true);
  expect(decideLaunchAdmission({ ta: true, now, target: { ...TARGET, card: 'card-2' } }, deps)).toMatchObject({ allowed: false, reason: expect.stringContaining('card') });
  expect(decideLaunchAdmission({ ta: true, now, target: { ...TARGET, commit: 'b'.repeat(40) } }, deps)).toMatchObject({ allowed: false, reason: expect.stringContaining('commit') });
  expect(decideLaunchAdmission({ ta: true, now, target: { card: 'card-1', cell: 'OTHER', commit: SHA } }, deps)).toMatchObject({ allowed: false });
  // launch target unknown while the receipt names one → cannot verify → refused
  expect(decideLaunchAdmission({ ta: true, now }, deps)).toMatchObject({ allowed: false, reason: expect.stringContaining('미상') });
  // receipt bound to nothing → refused
  const unbound = receipt('READY', 'unbound.json', { target: {} });
  expect(decideLaunchAdmission({ ta: true, now, target: TARGET }, { holdFile: NONE(), receiptPath: unbound.path, receiptSha256: unbound.sha }))
    .toMatchObject({ allowed: false, reason: expect.stringContaining('묶이지') });
});

test('non-TA launches need no receipt; inherited parent receipt skips the receipt check', () => {
  const bare = door({ holdFile: NONE() });
  expect(bare.consume(bare.requestId('ask-4')).status).toBe('consumed');
  const parent = bare.requestId('ask-5');
  expect(bare.consume(parent, { ta: false }).status).toBe('consumed');
  expect(bare.consume(parent, { ta: true, inheritedReceipt: parent }).status).toBe('consumed');
  expect(decideLaunchAdmission({ ta: true, now: new Date() }, { holdFile: NONE(), receiptPath: undefined, receiptSha256: undefined }).allowed).toBe(false);
});

// ③ `tasks preflight --out` 이 만든 실제 영수증 → 발사 관문 통과/거부, 두 쪽을 한 시험으로 묶는다.
const GOOD_EVIDENCE = {
  cardId: 'card-1',
  source: { requestedPin: SHA, childHead: SHA, privateRepo: true },
  image: { expectedDigest: `sha256:${'b'.repeat(64)}`, observedDigest: `sha256:${'b'.repeat(64)}` },
  workOrder: { cellId: 'CELL-A', boundary: 'src/a.ts', budget: '6900s', contract: 'c', escalation: 'OP', unknownFields: [],
    owner: 'TC', card: 'card-1', noAutoMerge: true, budgetLimits: { timeSec: 6900, usdCap: 5 } },
  launchArgv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge', 'synthetic goal'],
  mergePolicy: { taLandEnv: false, liveMovesProposeLand: false },
  owner: { card: 'TC', lease: 'TC', pod: 'TC' },
  limits: { wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: 5 },
  launch: { cardClaimed: false, activeSameGoalRuns: 0, opHoldActive: false },
  entrance: { name: 'hand', groundingPolicy: { off: true, reason: 'test policy' } },
};

async function runPreflight(evidence: unknown, args: string[], outName: string): Promise<{ path: string; sha: string; exit: number }> {
  const evidencePath = join(dir, `${outName}.evidence.json`);
  const out = join(dir, `${outName}.json`);
  const taskStatePath = join(dir, `${outName}.cards.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence));
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'card-1': { id: 'card-1', text: 'synthetic goal', status: 'handed', history: [] } } }));
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { output: () => {}, taskStatePath, preflightActiveRuns: () => [], preflightHoldActive: () => false });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidencePath, '--out', out, ...args]);
    const exit = Number(process.exitCode ?? 0);
    return { path: out, sha: existsSync(out) ? createHash('sha256').update(readFileSync(out, 'utf8')).digest('hex') : '', exit };
  } finally { process.exitCode = previous ?? 0; }
}

test('end to end: a receipt made by `tasks preflight --out` passes the launch door for its own launch and is refused otherwise', async () => {
  const ready = await runPreflight(GOOD_EVIDENCE, ['--card', 'card-1', '--cell', 'CELL-A', '--commit', `commit:${SHA}`], 'ready');
  expect(ready.exit).toBe(0);
  const d = door({ holdFile: NONE(), receiptPath: ready.path, receiptSha256: ready.sha });
  const id = d.requestId('e2e-1');
  // 다른 카드/commit 발사 → 거부(force 포함)
  expect(d.consume(id, { ta: true, force: true, target: { card: 'card-9', cell: 'CELL-A', commit: SHA } }).status).toBe('refused');
  expect(d.consume(id, { ta: true, target: { card: 'card-1', cell: 'CELL-A', commit: 'c'.repeat(40) } }).status).toBe('refused');
  // 자기 발사 → 통과
  expect(d.consume(id, { ta: true, target: { card: 'card-1', cell: 'CELL-A', commit: SHA } }).status).toBe('consumed');

  // NOT_READY 영수증(증거 일부 미측정) → exit 1 이고 관문도 거부
  const notReady = await runPreflight({ ...GOOD_EVIDENCE, image: undefined }, ['--card', 'card-1', '--cell', 'CELL-A'], 'notready');
  expect(notReady.exit).toBe(1);
  const d2 = door({ holdFile: NONE(), receiptPath: notReady.path, receiptSha256: notReady.sha });
  expect(d2.consume(d2.requestId('e2e-2'), { ta: true, force: true, target: { card: 'card-1', cell: 'CELL-A' } }))
    .toMatchObject({ status: 'refused', reason: expect.stringContaining('READY') });

  // 증거(pin=SHA, cell=CELL-A)와 다른 대상으로는 영수증을 만들지 않는다 — 우회 차단
  const wrongCommit = await runPreflight(GOOD_EVIDENCE, ['--card', 'card-1', '--commit', 'e'.repeat(40)], 'wrongcommit');
  expect(wrongCommit.exit).toBe(1);
  expect(existsSync(wrongCommit.path)).toBe(false);
  const wrongCell = await runPreflight(GOOD_EVIDENCE, ['--card', 'card-1', '--cell', 'CELL-Z'], 'wrongcell');
  expect(wrongCell.exit).toBe(1);
  expect(existsSync(wrongCell.path)).toBe(false);

  // 대상 없이는 영수증 자체를 만들지 않는다
  const noTarget = await runPreflight(GOOD_EVIDENCE, [], 'notarget');
  expect(noTarget.exit).toBe(1);
  expect(existsSync(noTarget.path)).toBe(false);
});
