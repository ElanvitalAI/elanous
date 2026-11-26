// MSG-PENDING-QUESTION-STALE (OP 11-26 · #178447 banner stayed after #178703) — expectations are independent literals
// (OP rule 11). Each case runs on sim seeds 1–3: the seed sets how many unrelated filler mails precede the question and
// how late (in minutes past the 10m surface) the answer comes, so ids and minutes differ per seed.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from './msg-store.js';
import { dismissQuestion, questionAnsweredOn, questionClosedBy, questionDigestLine, questionResurfaceLine } from './msg-wait-contract.js';
import { createHandRaiseReplyGate } from '../tui/hand-raise-reply-gate.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';
import { registerMsgCommands } from '../cli/msg-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const MIN = 60_000; // 출처: #40065 test clock unit — one minute in ms
const T0 = Date.parse('2026-11-26T07:00:00.000Z');
const SEEDS = [1, 2, 3] as const;

function world(seed: number) {
  const dir = mkdtempSync(join(tmpdir(), 'msg-pq-stale-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const open = () => new MsgStore(path);
  const s = open();
  for (let i = 0; i < seed; i += 1) s.post({ from: 'TC', to: 'UX', body: `filler ${i}` });
  const q = s.post({ from: 'CLAUDE-OP', to: 'OP', kind: 'decision', body: 'three actions this turn' });
  s.close();
  let nowMs = T0;
  const surfaced: string[] = [];
  const retracted: string[] = [];
  const gate = createHandRaiseReplyGate({
    now: () => nowMs,
    closed: (x) => { const st = open(); try { return questionAnsweredOn(st, x); } finally { st.close(); } },
    surface: (line) => surfaced.push(line),
    retract: (line) => retracted.push(line),
  }, { surfaceAfterMs: 10 * MIN, bulk: false, eventPrefix: 'msg.question', surfaceLine: questionResurfaceLine });
  gate.noteUnanswered({ msgId: q.id, seat: 'OP', sender: 'CLAUDE-OP', arrivedAt: T0 });
  nowMs = T0 + (10 + seed) * MIN;
  gate.tick();
  const closedBy = () => { const st = open(); try { return questionClosedBy(st, { msgId: q.id, seat: 'OP', sender: 'CLAUDE-OP' }); } finally { st.close(); } };
  return { open, q, gate, surfaced, retracted, closedBy, tick: () => { nowMs += MIN; gate.tick(); } };
}

const banner: Record<number, string> = {
  1: '❓ CLAUDE-OP asked #2 11m ago and is waiting for your reply — answer: eln msg post --to CLAUDE-OP --reply-to 2 "<answer>"',
  2: '❓ CLAUDE-OP asked #3 12m ago and is waiting for your reply — answer: eln msg post --to CLAUDE-OP --reply-to 3 "<answer>"',
  3: '❓ CLAUDE-OP asked #4 13m ago and is waiting for your reply — answer: eln msg post --to CLAUDE-OP --reply-to 4 "<answer>"',
};
const qid: Record<number, number> = { 1: 2, 2: 3, 3: 4 };

describe('pending question closes and its banner is retracted', () => {
  for (const seed of SEEDS) {
    test(`(a) seed ${seed}: a later mail to the asker with a ref naming the id`, () => {
      const w = world(seed);
      expect(w.surfaced).toEqual([banner[seed]!]);
      const s = w.open();
      s.post({ from: 'UX', to: 'CLAUDE-OP', body: 'not OP' });
      s.close();
      w.tick();
      expect(w.closedBy()).toBeNull();
      const s2 = w.open();
      s2.post({ from: 'OP', to: 'CLAUDE-OP', kind: 'report', refs: [`answers:${qid[seed]}`], body: 'done' });
      s2.close();
      expect(w.closedBy()).toBe('ref');
      w.tick();
      expect(w.retracted).toEqual([banner[seed]!]);
      expect(w.gate.open()).toEqual([]);
    });

    test(`(b) seed ${seed}: any later mail to the asker, no reply-to (the #178703 case)`, () => {
      const w = world(seed);
      const s = w.open();
      s.post({ from: 'OP', to: 'CLAUDE-OP', kind: 'report', body: '#answer without --reply-to' });
      s.close();
      expect(w.closedBy()).toBe('sender');
      w.tick();
      expect(w.retracted).toEqual([banner[seed]!]);
    });

    test(`(c) seed ${seed}: the question acked at the seat`, () => {
      const w = world(seed);
      const s = w.open();
      s.ackMessage('OP', qid[seed]!);
      s.close();
      expect(w.closedBy()).toBe('acked');
      w.tick();
      expect(w.retracted).toEqual([banner[seed]!]);
    });

    test(`(d) seed ${seed}: /new drops the open banners and returns them for one digest line`, () => {
      const w = world(seed);
      const dropped = w.gate.dropAll();
      expect(w.retracted).toEqual([banner[seed]!]);
      expect(w.gate.open()).toEqual([]);
      expect(questionDigestLine(dropped)).toBe(`❓ 1 pending question from the last session dropped: CLAUDE-OP #${qid[seed]} — reopen with: eln msg thread <id>`);
      w.tick();
      expect(w.surfaced).toEqual([banner[seed]!]);
    });

    test(`dismiss seed ${seed}: eln msg question dismiss <id> --by CLAUDE-OP writes an audit row and closes it`, async () => {
      const w = world(seed);
      const out: string[] = [];
      const errors: string[] = [];
      const program = new Command();
      registerMsgCommands(program, {
        openStore: w.open, out: { log: (line) => out.push(line), error: (line) => errors.push(line) }, readStdin: async () => '',
        setExitCode: () => {}, registerLogSink: async () => undefined, callerSeat: () => null, saveAckDigest: async () => {},
        wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
      });
      await program.parseAsync(['msg', 'question', 'dismiss', String(qid[seed]), '--by', 'CLAUDE-OP', '--json'], { from: 'user' });
      expect(errors).toEqual([]);
      expect(JSON.parse(out.at(-1)!)).toEqual({ dismissed: qid[seed], seat: 'OP', asker: 'CLAUDE-OP', auditId: qid[seed]! + 1, fresh: true });
      const s = w.open();
      const audit = s.getMessage(qid[seed]! + 1)!;
      expect(audit.from).toBe('CLAUDE-OP');
      expect(audit.to).toBe('OP');
      expect(audit.refs).toEqual([`question-dismissed:${qid[seed]}`, 'dismissed-by:CLAUDE-OP']);
      expect(dismissQuestion(s, { id: qid[seed]!, by: 'CLAUDE-OP' }).fresh).toBe(false);
      s.close();
      expect(w.closedBy()).toBe('dismissed');
      w.tick();
      expect(w.retracted).toEqual([banner[seed]!]);
    });

    test(`auto-link seed ${seed}: MsgPost to the asker while its question is pending gets replyTo = the question`, async () => {
      const w = world(seed);
      const reply = await dispatchMsgPost({ from: 'OP', to: 'CLAUDE-OP', body: 'three actions done' }, { openStore: w.open });
      expect(reply.message!.replyTo).toBe(qid[seed]);
      expect(w.closedBy()).toBe('reply-to');
    });
  }

  test('dismiss refuses a non-question and a seat with no authority', async () => {
    const w = world(1);
    const s = w.open();
    expect(() => dismissQuestion(s, { id: 1, by: 'OP' })).toThrow('#1 is not a question/decision (kind -)');
    s.close();
    const errors: string[] = [];
    const program = new Command();
    registerMsgCommands(program, {
      openStore: w.open, out: { log: () => {}, error: (line) => errors.push(line) }, readStdin: async () => '',
      setExitCode: () => {}, registerLogSink: async () => undefined, callerSeat: () => null, saveAckDigest: async () => {},
      wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    });
    await program.parseAsync(['msg', 'question', 'dismiss', '2', '--by', 'UX'], { from: 'user' });
    expect(errors).toEqual(['msg question dismiss: UX may not dismiss a question to OP']);
  });
});
