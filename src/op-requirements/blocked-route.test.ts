// REQ-BLOCK-ROUTE-TO-ASKEE — the D-20261125-01 scenario: OP asked CLAUDE-OP (#165447), no reply, continued twice →
// BLOCKED. It must end as ONE re-ask to CLAUDE-OP (then one exception line), and zero CEO cards.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStore, requirementStorePath, routeBlocked, type Requirement } from './requirement-loop.js';
import { runRequirementTurnEnd } from './turn-end.js';
import { DecisionLedger, automatedCeoCardRefusal } from '../decisions/decision-ledger.js';

const T0 = new Date('2026-11-25T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('REQ-BLOCK-ROUTE-TO-ASKEE', () => {
  test('#165447: OP question to CLAUDE-OP unanswered → re-ask to CLAUDE-OP, 30 min later one exception line to CLAUDE-OP, zero CEO cards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'req-route-'));
    const mails: Array<{ to: string; kind: string; body: string; refs: string[] }> = [];
    const cards: string[] = [];
    try {
      const turnEnd = (now: Date) => runRequirementTurnEnd({
        seat: 'OP', humanTurn: null, now: () => now, stateRoot: () => root, log: () => {},
        startTurnIfIdle: () => ({ opened: true, turnId: 't' }),
        gather: async () => ({ seed: { delegated: [{ commitmentId: 'c-165447', msgId: '165447', text: 'Which host runs the 0.3.37 hard rehearsal?', status: 'open', peer: 'CLAUDE-OP' }] }, waitState: () => 'none' as const }),
        raiseException: (r) => { cards.push(r.id); return 'D-20261125-01'; },
        postMail: (m) => { mails.push(m); return 165500 + mails.length; },
        coordinatorOf: () => 'OP',
      });
      await turnEnd(at(0));                       // continuation 1
      await turnEnd(at(1));                       // same gap → BLOCKED → re-ask
      expect(mails).toEqual([{ to: 'CLAUDE-OP', kind: 'question', refs: ['req-reask:req:msg:165447'],
        body: '[OP · re-ask · req:msg:165447] No reply yet to #165447: Which host runs the 0.3.37 hard rehearsal? — reply to #165447 with the result, or say what blocks it.' }]);
      await turnEnd(at(10));                      // inside the 30-min backoff → nothing
      await turnEnd(at(20));
      expect(mails.length).toBe(1);
      await turnEnd(at(32));                      // still silent → one exception line, to CLAUDE-OP (coach) not the CEO
      expect(mails.map((m) => [m.to, m.kind])).toEqual([['CLAUDE-OP', 'question'], ['CLAUDE-OP', 'exception']]);
      expect(mails[1]!.body).toBe('[OP · exception · req:msg:165447] CLAUDE-OP has not answered #165447 (re-asked 2026-11-25T10:01:00.000Z): Which host runs the 0.3.37 hard rehearsal?');
      await turnEnd(at(90));
      expect(mails.length).toBe(2);
      expect(cards).toEqual([]);
      const r = readStore(requirementStorePath(root, 'OP')).requirements[0]!;
      expect(r.status).toBe('blocked');
      expect(r.blockRoute).toEqual({ reaskAt: '2026-11-25T10:01:00.000Z', reaskTo: 'CLAUDE-OP', reaskMsgId: 165501, exceptionAt: '2026-11-25T10:32:00.000Z', exceptionTo: 'CLAUDE-OP' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a hand seat silent after the re-ask → exception line to its coordinator; no coordinator above → stale', () => {
    const base: Requirement = { id: 'req:msg:9', source: { kind: 'delegated-request', msgId: '9', commitmentId: 'c9' }, title: 'fix it', closeCondition: 'x', next: 'y',
      status: 'blocked', revision: 1, createdAt: T0.toISOString(), updatedAt: T0.toISOString(), peer: 'TC-H1', blockRoute: { reaskAt: '2026-11-25T10:00:00.000Z' } };
    expect(routeBlocked(base, { seat: 'OP', now: at(31), coordinatorOf: () => 'TC' })).toMatchObject({ kind: 'exception', to: 'TC' });
    expect(routeBlocked(base, { seat: 'OP', now: at(31), coordinatorOf: () => 'OP' })).toEqual({ kind: 'stale', note: 'TC-H1 silent after a re-ask on #9 and no coordinator above it' });
    expect(routeBlocked({ ...base, peer: undefined }, { seat: 'OP', now: at(1), coordinatorOf: () => 'TC' })).toEqual({ kind: 'stale', note: 'blocked on #9 with no recipient seat to ask' });
  });

  test('a CEO line: CEO card only with a CEO-only gap ref; otherwise stale', () => {
    const ceo: Requirement = { id: 'ceo:t1', source: { kind: 'ceo-directive', turnId: 't1' }, title: 'buy the GPU box', closeCondition: 'x', next: 'y',
      status: 'blocked', revision: 1, createdAt: T0.toISOString(), updatedAt: T0.toISOString(), refs: ['gap:money'] };
    expect(routeBlocked(ceo, { seat: 'OP', now: at(1), coordinatorOf: () => 'OP' })).toEqual({ kind: 'ceo-card', gap: 'money' });
    expect(routeBlocked({ ...ceo, refs: ['cell:X'] }, { seat: 'OP', now: at(1), coordinatorOf: () => 'OP' }))
      .toEqual({ kind: 'stale', note: 'CEO line t1 blocked with no CEO-only gap (money · security · irreversible · policy)' });
  });

  test('DecisionLedger refuses a requirements:* card unless CEO origin ⊕ CEO-only category ⊕ recommendation ⊕ Q/A', () => {
    const dir = mkdtempSync(join(tmpdir(), 'req-ledger-'));
    try {
      const ledger = new DecisionLedger({ stateDir: dir, resolveVersion: () => ({}) as never });
      const card = {
        title: '[OP · requirement blocked] OP asked CLAUDE-OP', category: 'scope' as const,
        scqa: { s: 'OP continued req:msg:165447 twice with no change', c: 'close condition: the delegated result verified by OP' },
        options: [{ key: 'r', label: 'Resolve', consequence: 'continue' }, { key: 'x', label: 'Reject', consequence: 'stop' }],
        recommendation: { skipped: true as const, reason: 'the leader judges the exception' },
        raisedBy: { agent: 'requirements:OP' }, refs: ['req-blocked:req:msg:165447', 'seat:OP'],
      };
      expect(() => ledger.raise(card)).toThrow('CEO card refused — requirements:OP: a requirement raises a CEO card only when it came from a CEO line');
      expect(automatedCeoCardRefusal({ ...card, refs: [...card.refs, 'origin:ceo'] })).toBe('requirements:OP: a CEO card needs a CEO-only category (money · security · secret · irreversible · gap:policy), got scope');
      expect(automatedCeoCardRefusal({ ...card, category: 'money', refs: ['origin:ceo'] })).toBe('requirements:OP: a CEO card needs a recommendation');
      expect(automatedCeoCardRefusal({ ...card, category: 'money', refs: ['origin:ceo'], recommendation: { option: 'x', why: 'hold' } })).toBe('requirements:OP: a CEO card needs filled S/C/Q/A');
      expect(automatedCeoCardRefusal({ ...card, category: 'money', refs: ['origin:ceo'], recommendation: { option: 'x', why: 'hold' }, scqa: { ...card.scqa, q: 'Buy it?', a: 'Hold until the quote.' } })).toBeNull();
      expect(automatedCeoCardRefusal({ ...card, raisedBy: { agent: 'OP' } })).toBeNull(); // a seat's own CLI raise is not this guard's
      expect(ledger.list({ status: 'all' }).length).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
