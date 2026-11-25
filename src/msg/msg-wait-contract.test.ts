// MSG-WAIT-CONTRACT — expectations are independent literals (OP rule 11): seat names, ids, minutes and UI lines are typed
// out here, never rebuilt from the product's constants or line builders.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore, type MessageEnvelope } from './msg-store.js';
import {
  advanceWait, inferReplyTo, questionAnsweredOn, questionResurfaceLine, replyMatchLogged, sweepWaitContracts, withAutoReplyTo,
} from './msg-wait-contract.js';
import { buildFederationLadder } from './hand-raise-ladder.js';
import { armWaker, evaluateWaker, type SelfTimerDeps, type WaitContractPort } from './self-timer-watch.js';
import { CommitmentLedger } from '../commitment/ledger.js';
import { createHandRaiseReplyGate } from '../tui/hand-raise-reply-gate.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';
import { dispatchMsgAsk } from '../skills/tools/msg-ask.js';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { KNOWN_LOG_EVENT_NAMES } from '../cli/log-event-names.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(): { path: string; open: () => MsgStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'msg-wait-contract-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  return { path, dir, open: () => new MsgStore(path) };
}

const MIN = 60_000; // 출처: #40065 test clock unit — one minute in ms (the contract minutes below are literals in MIN)
const T0 = Date.parse('2026-11-25T04:00:00.000Z');
// TC-H-CX-1 is a hand in TC's space; TC is a space coordinator under HQ OP.
const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-H-CX-1'] }] });

describe('① reply threading', () => {
  test('MsgPost to a seat with an unanswered question from it gets replyTo = that question; noReplyTo opts out', async () => {
    const l = ledger();
    const seed = l.open();
    const question = seed.post({ from: 'OP', to: 'TC', kind: 'question', body: 'is #40061 still the lane?' });
    seed.close();
    expect(question.id).toBe(1);
    const reply = await dispatchMsgPost({ from: 'TC', to: 'OP', body: 'yes — still on it' }, { openStore: l.open, followUp: async () => { throw new Error('unused'); } });
    expect(reply.message!.replyTo).toBe(1);
    // A second post: #1 is answered now (TC already posted after it) → no threading.
    const second = await dispatchMsgPost({ from: 'TC', to: 'OP', body: 'unrelated status' }, { openStore: l.open });
    expect(second.message!.replyTo).toBeUndefined();
    const s = l.open();
    s.post({ from: 'OP', to: 'TC', kind: 'decision', body: 'pick A or B' });
    s.close();
    const optOut = await dispatchMsgPost({ from: 'TC', to: 'OP', body: 'side note', noReplyTo: true }, { openStore: l.open });
    expect(optOut.message!.replyTo).toBeUndefined();
  });

  test('msg post CLI threads the reply (the 11-25 #161967 case) and --no-reply-to leaves it empty', async () => {
    const l = ledger();
    const seed = l.open();
    seed.post({ from: 'TC', to: 'OP', kind: 'question', body: 'confirm the existing lane?' }); // #1
    seed.close();
    const out: string[] = [];
    const program = new Command();
    registerMsgCommands(program, {
      openStore: l.open, out: { log: (line) => out.push(line), error: () => {} }, readStdin: async () => '',
      setExitCode: () => {}, registerLogSink: async () => undefined, callerSeat: () => null, saveAckDigest: async () => {},
      wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    });
    await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'TC', '--body', 'keep the lane', '--kind', 'status', '--json'], { from: 'user' });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ id: 2, from: 'OP', to: 'TC', replyTo: 1 });
    const s = l.open();
    s.post({ from: 'TC', to: 'OP', kind: 'question', body: 'and the next one?' }); // #3
    s.close();
    await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'TC', '--body', 'fyi only', '--kind', 'info', '--no-reply-to', '--json'], { from: 'user' });
    const optedOut = JSON.parse(out.at(-1)!) as { id: number; replyTo?: number };
    expect(optedOut.id).toBe(4);
    expect(optedOut.replyTo).toBeUndefined();
  });

  test('a mail the counterpart waits on is threaded too; plain info and ✋ mails are not', () => {
    const l = ledger();
    const s = l.open();
    try {
      s.post({ from: 'UX', to: 'TC-H-CX-1', body: 'status: building' }); // #1 plain info
      expect(inferReplyTo(s, { from: 'TC-H-CX-1', to: 'UX' })).toBeNull();
      expect(inferReplyTo(s, { from: 'TC-H-CX-1', to: 'UX' }, { waitedOn: () => [1] })).toBe(1);
      s.post({ from: 'UX', to: 'TC-H-CX-1', body: 'blocked', refs: ['block:b-7', 'reason:HUMAN_DECISION'] }); // #2 ✋
      expect(inferReplyTo(s, { from: 'TC-H-CX-1', to: 'UX' })).toBeNull();
      const logs: string[] = [];
      const draft: MessageEnvelope = { from: 'TC-H-CX-1', to: 'UX', body: 'answer' };
      const env = withAutoReplyTo(s, draft, { waitedOn: () => [1], log: (e) => logs.push(e) });
      expect(env.replyTo).toBe(1);
      expect(logs).toEqual(['auto-reply-to']);
    } finally { s.close(); }
  });
});

describe('① sender match satisfies a wait', () => {
  test('any later mail from the counterpart counts, logged matched-by-sender', () => {
    const l = ledger();
    const s = l.open();
    try {
      s.post({ from: 'TC', to: 'OP', kind: 'question', body: 'existing lane reply?' }); // #1
      s.post({ from: 'OP', to: 'MK', body: 'not for TC' }); // #2 — other seat, does not count
      const logs: { event: string; data: Record<string, unknown> }[] = [];
      expect(replyMatchLogged(s, { id: 1, from: 'TC', to: 'OP' }, (event, data) => logs.push({ event, data }))).toBeNull();
      s.post({ from: 'OP', to: 'TC', body: 'go ahead' }); // #3 — no replyTo
      const match = replyMatchLogged(s, { id: 1, from: 'TC', to: 'OP' }, (event, data) => logs.push({ event, data }));
      expect(match?.reply.id).toBe(3);
      expect(match?.by).toBe('sender');
      expect(logs).toEqual([{ event: 'matched-by-sender', data: { question: 1, asker: 'TC', counterpart: 'OP', reply: 3 } }]);
    } finally { s.close(); }
  });

  test('MsgAsk accepts an unlinked later mail from the recipient as the reply', async () => {
    const l = ledger();
    let polls = 0;
    const result = await dispatchMsgAsk({ from: 'TC', to: 'OP', question: 'which lane?', waitSeconds: 30 }, {
      openStore: l.open,
      sleep: async () => {
        polls += 1;
        if (polls === 1) { const s = l.open(); try { s.post({ from: 'OP', to: 'TC', body: 'lane A' }); } finally { s.close(); } }
      },
    });
    expect(result.ok).toBe(true);
    expect(result.reply?.body).toBe('lane A');
    expect(result.question.kind).toBe('question');
    expect(result.question.refs?.some((r) => r.startsWith('wait-until:'))).toBe(true);
  });
});

describe('② 10m reminder → 15m cancel', () => {
  test('advanceWait: pending, reminder at 10m, cancelled at 15m with the result, coordinator told once', () => {
    const l = ledger();
    const s = l.open();
    try {
      const q = s.post({ from: 'TC-H-CX-1', to: 'UX', kind: 'question', body: 'which token set?' }); // #1
      const logs: string[] = [];
      const base = { messageId: q.id, asker: 'TC-H-CX-1', counterpart: 'UX', startedAtMs: T0, withinMs: 10 * MIN, parentOf: ladder.parentOf, log: (e: string) => logs.push(e) };
      expect(advanceWait(s, { ...base, now: T0 + 9 * MIN }).state).toBe('pending');
      const retried = advanceWait(s, { ...base, now: T0 + 10 * MIN });
      expect(retried.state).toBe('retried');
      const reminder = s.getMessage(2)!;
      expect(reminder).toMatchObject({ from: 'TC-H-CX-1', to: 'UX', kind: 'reminder' });
      expect(reminder.body).toBe('[⏳ reminder] TC-H-CX-1 is still waiting for your reply to #1 (10m) — reply with: eln msg post --from UX --to TC-H-CX-1 --reply-to 1 "<answer>"');
      expect(advanceWait(s, { ...base, now: T0 + 12 * MIN }).state).toBe('pending');
      const cancelled = advanceWait(s, { ...base, now: T0 + 15 * MIN });
      expect(cancelled.state).toBe('cancelled');
      if (cancelled.state !== 'cancelled') throw new Error('unreachable');
      expect(cancelled.cancel.result).toBe('no reply in 15m — proceed with the part independent of the reply');
      expect(cancelled.cancel.coordinator).toBe('TC');
      // Run again later (another TUI, the CLI loop): nothing new is written.
      advanceWait(s, { ...base, now: T0 + 16 * MIN });
      const toTc = s.list('TC').filter((m) => m.from === 'TC-H-CX-1');
      expect(toTc).toHaveLength(1);
      expect(toTc[0]!.body).toBe('[⏳ wait cancelled · TC-H-CX-1 ↔ UX] TC-H-CX-1 got no reply to #1 from UX in 15m (one reminder sent) — the wait was cancelled; nudge UX or reassign the question.');
      const toSelf = s.list('TC-H-CX-1').filter((m) => m.from === 'TC-H-CX-1');
      expect(toSelf.map((m) => m.body)).toEqual(['[⏳ wait cancelled] no reply in 15m — proceed with the part independent of the reply · #1 to UX']);
      expect(s.list('UX').filter((m) => m.kind === 'reminder')).toHaveLength(1);
      expect(logs).toEqual(['retry', 'cancelled', 'coordinator-notified']);
    } finally { s.close(); }
  });

  test('a reply before the horizon ends the wait with no reminder', () => {
    const l = ledger();
    const s = l.open();
    try {
      s.post({ from: 'UX', to: 'TC-H-CX-1', kind: 'question', body: 'ETA?' }); // #1
      s.post({ from: 'TC-H-CX-1', to: 'UX', body: '20 min' }); // #2
      const step = advanceWait(s, { messageId: 1, asker: 'UX', counterpart: 'TC-H-CX-1', startedAtMs: T0, withinMs: 10 * MIN, now: T0 + 20 * MIN });
      expect(step.state).toBe('answered');
      expect(s.list('TC-H-CX-1').filter((m) => m.kind === 'reminder')).toHaveLength(0);
    } finally { s.close(); }
  });

  test('sweepWaitContracts drives a msg ask / MsgAsk question by its wait-until ref', () => {
    const l = ledger();
    const s = l.open();
    try {
      const startedIso = new Date(Date.now()).toISOString();
      const startedAt = Date.parse(startedIso);
      s.post({ from: 'TC', to: 'OP', kind: 'question', body: 'lane?', refs: [`wait-until:${new Date(startedAt + 10 * MIN).toISOString()}`] }); // #1
      expect(sweepWaitContracts(s, { now: startedAt + 5 * MIN, involving: 'TC', parentOf: ladder.parentOf })).toEqual([]);
      expect(sweepWaitContracts(s, { now: startedAt + 10 * MIN + 1000, involving: 'TC', parentOf: ladder.parentOf }))
        .toEqual([{ messageId: 1, asker: 'TC', counterpart: 'OP', state: 'retried' }]);
      expect(sweepWaitContracts(s, { now: startedAt + 16 * MIN, involving: 'OP', parentOf: ladder.parentOf }))
        .toEqual([{ messageId: 1, asker: 'TC', counterpart: 'OP', state: 'cancelled' }]);
      expect(sweepWaitContracts(s, { now: startedAt + 30 * MIN, parentOf: ladder.parentOf })).toEqual([]);
      // TC's coordinator is HQ OP — told once.
      expect(s.list('OP').filter((m) => m.from === 'TC' && (m.refs ?? []).includes('wait-pair:TC:OP'))).toHaveLength(1);
    } finally { s.close(); }
  });

  test('msg ask with no flags waits 10m, sends one reminder, and is cancelled at 15m with the result', async () => {
    const l = ledger();
    let nowMs = T0;
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    const program = new Command();
    registerMsgCommands(program, {
      openStore: l.open, out: { log: (line) => out.push(line), error: (line) => err.push(line) }, readStdin: async () => '',
      setExitCode: (code) => exits.push(code), registerLogSink: async () => undefined, callerSeat: () => null, saveAckDigest: async () => {},
      wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
      now: () => new Date(nowMs), sleep: async () => { nowMs += 30_000; }, signal: new AbortController().signal,
    });
    await program.parseAsync(['msg', 'ask', 'UX', 'which token set?', '--from', 'TC-H-CX-1'], { from: 'user' });
    expect(exits).toEqual([]);
    expect(out[0]).toBe('#1');
    expect(out.at(-1)).toBe('#1 wait cancelled: no reply in 15m — proceed with the part independent of the reply');
    expect(err.filter((line) => line.includes('reminder'))).toHaveLength(1);
    expect(nowMs - T0).toBe(15 * MIN);
    const s = l.open();
    try {
      expect(s.getMessage(1)).toMatchObject({ kind: 'question', refs: ['wait-until:2026-11-25T04:10:00.000Z'] });
      expect(s.list('UX').filter((m) => m.kind === 'reminder')).toHaveLength(1);
    } finally { s.close(); }
  });

  test('self-timer mail-reply waker: default horizon 10m, then reminder (+5m), then cancelled with the result', async () => {
    const l = ledger();
    let nowMs = T0;
    const now = () => new Date(nowMs);
    const commitments = new CommitmentLedger({ root: join(l.dir, 'ledger'), now, emit: () => {} });
    const entry = commitments.add({ seat: 'TC', sessionId: 's1', text: 'OP reply on #161967', evidence: 'waiting for OP on #161967' }).entry;
    const calls: string[] = [];
    const port: WaitContractPort = {
      retry: async (seat, id, waited) => { calls.push(`retry ${seat} #${id} ${waited / MIN}m`); return { mailId: 900 }; },
      cancel: async (seat, id, waited) => { calls.push(`cancel ${seat} #${id} ${waited / MIN}m`); return { result: 'no reply in 15m — proceed with the part independent of the reply', noticeId: 901 }; },
    };
    const deps: SelfTimerDeps = {
      root: join(l.dir, 'wakers'), ledger: commitments, now, emit: () => {}, newId: () => 'w-1', pid: 1, isPidAlive: () => false,
      probes: { prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false },
      postNotice: async () => { calls.push('expired-notice'); return 1; }, waitContract: port,
    };
    const { waker } = armWaker({ seat: 'TC', commitmentId: entry.id, condition: 'mail-reply:161967' }, deps);
    expect(Date.parse(waker.deadlineAt) - Date.parse(waker.armedAt)).toBe(600_000);
    nowMs = T0 + 10 * MIN;
    const first = await evaluateWaker('TC', 'w-1', deps);
    expect(first.outcome).toBe('pending');
    expect(first.waker.deadlineAt).toBe('2026-11-25T04:15:00.000Z');
    nowMs = T0 + 15 * MIN;
    const second = await evaluateWaker('TC', 'w-1', deps);
    expect(second.outcome).toBe('cancelled');
    expect(second.waker.cancelReason).toBe('no reply in 15m — proceed with the part independent of the reply');
    expect(calls).toEqual(['retry TC #161967 10m', 'cancel TC #161967 15m']);
  });
});

describe('④ receiver obligation', () => {
  test('an unanswered question is re-surfaced once at 10m; a post back closes it', () => {
    const l = ledger();
    const seed = l.open();
    seed.post({ from: 'UX', to: 'TC-H-CX-1', kind: 'question', body: 'which token set?' }); // #1
    seed.close();
    let nowMs = T0;
    const surfaced: string[] = [];
    const events: string[] = [];
    const gate = createHandRaiseReplyGate({
      now: () => nowMs,
      closed: (q) => { const s = l.open(); try { return questionAnsweredOn(s, q); } finally { s.close(); } },
      surface: (line) => surfaced.push(line),
      log: (event) => events.push(event),
    }, { surfaceAfterMs: 10 * MIN, bulk: false, eventPrefix: 'msg.question', surfaceLine: questionResurfaceLine });
    gate.noteUnanswered({ msgId: 1, seat: 'TC-H-CX-1', sender: 'UX', arrivedAt: T0 });
    nowMs = T0 + 9 * MIN;
    gate.tick();
    expect(surfaced).toEqual([]);
    nowMs = T0 + 10 * MIN;
    gate.tick();
    gate.tick();
    expect(surfaced).toEqual(['❓ UX asked #1 10m ago and is waiting for your reply — answer: eln msg post --to UX --reply-to 1 "<answer>"']);
    const s = l.open();
    try { s.post({ from: 'TC-H-CX-1', to: 'UX', body: 'tokens v2' }); } finally { s.close(); }
    gate.tick();
    expect(gate.open()).toEqual([]);
    expect(events).toEqual(['msg.question.open', 'msg.question.unanswered', 'msg.question.replied']);
  });
});

test('the wait-contract log lines are allowlisted for elanous logs', () => {
  for (const name of ['matched-by-sender', 'retry', 'cancelled', 'coordinator-notified', 'auto-reply-to', 'self-timer.retried', 'msg.question.unanswered']) {
    expect(KNOWN_LOG_EVENT_NAMES.has(name)).toBe(true);
  }
});
