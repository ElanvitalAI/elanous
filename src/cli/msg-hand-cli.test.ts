// `eln msg hand` ⊕ `msg wait-for` preemption — CLI literals over a real temp ledger (HAND-RAISE-LADDER).
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommitmentLedger } from '../commitment/ledger.js';
import { buildFederationLadder, type CeoCard } from '../msg/hand-raise-ladder.js';
import { MsgStore } from '../msg/msg-store.js';
import { registerMsgHandCommands } from './msg-hand-cli.js';
import { registerMsgWaitForCommands } from './msg-wait-for-cli.js';

const root = mkdtempSync(join(tmpdir(), 'msg-hand-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-H-CX-4'] }, { coordinator: 'OP', seats: ['OP'] }] });

function fixture() {
  const path = join(root, `m${++n}.db`);
  const seed = new MsgStore(path);
  const raised = seed.post({ from: 'TC-H-CX-4', to: 'TC', kind: 'request', intent: 'decision', correlationId: 'blk-cx4',
    body: '[✋ NEED HUMAN · TC-H-CX-4] pregate RED on minim5 — rerun or waive?', refs: ['block:blk-cx4', 'seat:TC-H-CX-4', 'reason:HUMAN_DECISION'] });
  seed.close();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const cards: CeoCard[] = [];
  const program = new Command().exitOverride();
  registerMsgHandCommands(program.command('msg'), { openStore: () => new MsgStore(path), ladder: () => ladder, raiseDecision: (c) => { cards.push(c); },
    out: { log: (l) => stdout.push(l), error: (l) => stderr.push(l) }, setExitCode: (c) => exits.push(c) });
  const run = (...args: string[]) => program.parseAsync(['node', 'elanous', 'msg', ...args]);
  return { path, raised, stdout, stderr, exits, cards, run };
}

test('msg hand <id> reject "<reason>" → one reply to the blocked seat; a second outcome fails rc 1', async () => {
  const f = fixture();
  await f.run('hand', String(f.raised.id), 'reject', 'Rerun', 'on', 'node-b', 'first.');
  expect(f.stdout).toEqual([`✋ #${f.raised.id} rejected → TC-H-CX-4 #${f.raised.id + 1}`]);
  const store = new MsgStore(f.path);
  try { expect(store.getMessage(f.raised.id + 1)!.body).toBe('[✋ REJECTED · TC] reason: Rerun on node-b first.'); } finally { store.close(); }
  await f.run('hand', String(f.raised.id), 'resolve', 'go');
  expect(f.stderr).toEqual([`msg hand: #${f.raised.id} is already rejected`]);
  expect(f.exits).toEqual([1]);
});

test('msg hand <id> escalate → TC to OP · board shows the open ✋ at OP · bad verb fails', async () => {
  const f = fixture();
  await f.run('hand', String(f.raised.id), 'escalate', 'Release-scope call needed.');
  expect(f.stdout).toEqual([`✋ #${f.raised.id} escalated to OP as #${f.raised.id + 1}`]);
  await f.run('hand', 'board');
  expect(f.stdout[1]).toBe('✋ Open hands — OP 1 (oldest 0m) · CEO 0');
  await f.run('hand', String(f.raised.id), 'ignore', 'x');
  expect(f.stderr).toEqual(['msg hand: hand: action must be resolve, reject or escalate']);
});

test('msg wait-for: a ✋ arriving mid-wait prints «✋ arrived: …» and ends the wait (no fired/expired line)', async () => {
  const dir = mkdtempSync(join(root, 'wf-'));
  let nowMs = Date.parse('2026-11-25T02:57:00.000Z');
  const now = () => new Date(nowMs);
  const ledger = new CommitmentLedger({ root: join(dir, 'ledger'), now, emit: () => {} });
  const entry = ledger.add({ seat: 'TC', sessionId: 's1', text: 'MVP-B 후속 회신', evidence: 'MVP-B 후속 회신을 기다립니다.' }).entry;
  let polls = 0;
  const stdout: string[] = [];
  const program = new Command().exitOverride();
  registerMsgWaitForCommands(program.command('msg'), {
    timer: { root: join(dir, 'wakers'), ledger, now, emit: () => {}, isPidAlive: () => false,
      sleep: async (ms) => { nowMs += ms; },
      probes: { prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false },
      postNotice: async () => 1,
      preempt: () => (++polls >= 2 ? '✋ arrived: #161333 from TC-H-CC-1 — which rule applies?' : null) },
    out: { log: (l) => stdout.push(l), error: () => {} }, setExitCode: () => {}, cwd: () => dir,
  });
  await program.parseAsync(['node', 'elanous', 'msg', 'wait-for', 'mail-reply:161300', '--notify', 'TC', '--commitment', entry.id, '--within', '30m']);
  expect(stdout).toEqual(['✋ arrived: #161333 from TC-H-CC-1 — which rule applies?']);
});
