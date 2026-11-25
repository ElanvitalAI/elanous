import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { closeRequirement, decideTurnEnd, emptyStore, readStore, requirementStorePath, seedRequirements, setNext, writeStore, type Requirement, type WaitState } from './requirement-loop.js';
import { runRequirementTurnEnd } from './turn-end.js';
import { registerMsgRequirementCommands } from '../cli/msg-requirement-cli.js';

const T0 = new Date('2026-11-24T00:00:00.000Z');
const plus = (min: number) => new Date(T0.getTime() + min * 60_000);

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'op-req-'));
  const opened: Array<{ text: string; origin: string }> = [];
  const notices: string[] = [];
  const mails: Array<{ to: string; kind: string; body: string; refs: string[] }> = [];
  let doorOpen = true;
  const seed = {
    p0Cells: [{ version: '0.3.35', id: 'CELL-A', title: 'cell a', status: 'yellow' }],
    delegated: [] as Array<{ commitmentId: string; msgId: string; text: string; status: string; wait?: { commitmentId: string; condition: string; deadlineAt: string } }>,
  };
  let waits: Record<string, WaitState> = {};
  const turnEnd = (now: Date, humanTurn: { turnId: string; text: string; refs?: readonly string[] } | null = null, seat = 'OP') => runRequirementTurnEnd({
    seat, humanTurn, now: () => now, stateRoot: () => root,
    startTurnIfIdle: (text, opts) => { if (!doorOpen) return { opened: false, reason: 'NotIdle' }; opened.push({ text, origin: opts.origin }); return { opened: true, turnId: `t${opened.length}` }; },
    notify: (line) => notices.push(line),
    raiseException: (_r, line) => { notices.push(line); return `card-${notices.length}`; },
    postMail: (m) => { mails.push(m); return 900 + mails.length; },
    coordinatorOf: (s: string) => ({ TC: 'TC', UX: 'UX', 'CLAUDE-OP': 'OP' } as Record<string, string>)[s] ?? 'OP',
    gather: async () => ({ seed, waitState: (r: Requirement) => (r.waitFor ? waits[r.waitFor.commitmentId] ?? 'none' : 'none') }),
    log: () => {},
  });
  const path = requirementStorePath(root, 'OP');
  return { root, path, opened, notices, mails, seed, turnEnd, setWaits: (w: Record<string, WaitState>) => { waits = w; }, setDoor: (v: boolean) => { doorOpen = v; }, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe('OP-REQUIREMENT-LOOP', () => {
  test('two open requirements + OP turn end → exactly one continuation carrying the next step and close condition', async () => {
    const h = harness();
    try {
      const r = await h.turnEnd(T0, { turnId: 'turn-1', text: 'Land the router PR today', refs: ['cell:SIM-1'] });
      expect(r).toMatchObject({ opened: true, reason: 'requirement-open' });
      expect(h.opened.length).toBe(1);
      expect(readStore(h.path).requirements.filter((x) => x.status === 'open').length).toBe(2);
      // The CEO directive outranks the P0 cell.
      expect(h.opened[0]!.text).toContain('Requirement ceo:turn-1 is still open');
      expect(h.opened[0]!.text).toContain('Next step: Carry out the directive with tools, then close it with evidence');
      expect(h.opened[0]!.text).toContain('Close condition: evidence that the directive is done: a PR number, a checklist status green/done, or a measured number');
      expect(h.opened[0]!.text).toContain("git log origin/main --oneline --grep");
      expect(h.opened[0]!.text).toContain("gh pr list --search");
      expect(h.opened[0]!.origin).toBe('goal-continue');
    } finally { h.done(); }
  });

  test('a non-OP seat has no requirement loop', async () => {
    const h = harness();
    try {
      expect(await h.turnEnd(T0, null, 'TC')).toEqual({ opened: false, reason: 'not-op' });
      expect(h.opened.length).toBe(0);
    } finally { h.done(); }
  });

  test('evidence-less or uncertain «done» is refused and the requirement stays open', () => {
    const store = emptyStore();
    seedRequirements(store, { directives: [{ turnId: 'd1', text: 'ship it', refs: ['cell:SIM-1'] }] }, T0.toISOString());
    expect(closeRequirement(store, 'ceo:d1', null, T0.toISOString())).toEqual({ closed: false, reason: 'no-evidence' });
    expect(closeRequirement(store, 'ceo:d1', { kind: 'said-done' }, T0.toISOString())).toEqual({ closed: false, reason: 'unknown-evidence-kind' });
    expect(closeRequirement(store, 'ceo:d1', { kind: 'pr' }, T0.toISOString())).toEqual({ closed: false, reason: 'pr-number-required' });
    expect(closeRequirement(store, 'ceo:d1', { kind: 'pr', number: 39846, uncertain: true }, T0.toISOString())).toEqual({ closed: false, reason: 'uncertain' });
    expect(closeRequirement(store, 'ceo:d1', { kind: 'checklist', cellId: 'X', status: 'yellow' }, T0.toISOString())).toEqual({ closed: false, reason: 'checklist-not-green' });
    expect(store.requirements[0]!.status).toBe('open');
    expect(closeRequirement(store, 'ceo:d1', { kind: 'pr', number: 39846 }, T0.toISOString())).toEqual({ closed: true });
    expect(store.requirements[0]!.status).toBe('closed');
  });

  test('CLI close without evidence exits 2 and leaves the requirement open', async () => {
    const h = harness();
    try {
      await h.turnEnd(T0, { turnId: 'turn-1', text: 'x', refs: ['cell:SIM-1'] });
      const errors: string[] = [];
      let code = 0;
      const msg = new Command('msg').exitOverride();
      registerMsgRequirementCommands(msg, { out: { log: () => {}, error: (l: string) => errors.push(l) }, setExitCode: (c) => { code = c; }, stateRoot: () => h.root, now: () => T0 });
      await msg.parseAsync(['node', 'msg', 'req', 'close', 'ceo:turn-1']);
      expect(code).toBe(2);
      expect(errors[0]).toBe('msg req close refused: ceo:turn-1 stays open (no-evidence)');
      expect(readStore(h.path).requirements.find((r) => r.id === 'ceo:turn-1')!.status).toBe('open');
      await msg.parseAsync(['node', 'msg', 'req', 'close', 'ceo:turn-1', '--measured', 'landed=3']);
      expect(readStore(h.path).requirements.find((r) => r.id === 'ceo:turn-1')!.status).toBe('closed');
    } finally { h.done(); }
  });

  test('same gap twice → that requirement stops as BLOCKED with one bulletin line · a P0 cell goes to its owner\'s coordinator, not the CEO', async () => {
    const h = harness();
    try {
      h.seed.p0Cells = [{ version: '0.3.35', id: 'CELL-A', title: 'cell a', status: 'yellow', owner: 'TC' } as never];
      await h.turnEnd(T0);                       // continuation 1 for p0:0.3.35:CELL-A at r1
      expect(h.opened.length).toBe(1);
      const second = await h.turnEnd(plus(1));   // nothing changed → same fingerprint seen twice
      expect(second.opened).toBe(false);
      expect(h.opened.length).toBe(1);
      const store = readStore(h.path);
      expect(store.requirements[0]!.status).toBe('blocked');
      expect(store.bulletin.length).toBe(1);
      expect(store.bulletin[0]!.line.startsWith('🚨 BLOCKED p0:0.3.35:CELL-A · same gap twice (p0:0.3.35:CELL-A#r1)')).toBe(true);
      expect(h.notices.length).toBe(0);          // no CEO card
      expect(h.mails.map((m) => [m.to, m.kind])).toEqual([['TC', 'exception']]);
      await h.turnEnd(plus(2));                  // a blocked requirement is not repeated in the bulletin, nor re-mailed
      expect(readStore(h.path).bulletin.length).toBe(1);
      expect(h.mails.length).toBe(1);
    } finally { h.done(); }
  });

  test('REQ-BLOCK-ROUTE-TO-ASKEE: an OP-owned P0 cell with no one above it closes as stale with a note — no mail, no CEO card', async () => {
    const h = harness();
    try {
      h.seed.p0Cells = [{ version: '0.3.37', id: 'CELL-OWN', title: 'own cell', status: 'yellow', owner: 'OP' } as never];
      await h.turnEnd(T0);
      await h.turnEnd(plus(1));
      const r = readStore(h.path).requirements[0]!;
      expect(r.status).toBe('stale');
      expect(r.stale!.note).toBe('P0 cell CELL-OWN blocked and its owner has no coordinator other than OP');
      expect(h.mails.length).toBe(0);
      expect(h.notices.length).toBe(0);
    } finally { h.done(); }
  });

  test('progress (a new next step) is a new fingerprint; the hourly cap of 8 holds', () => {
    const store = emptyStore();
    seedRequirements(store, { directives: [{ turnId: 'd1', text: 'keep going', refs: ['cell:SIM-1'] }] }, T0.toISOString());
    const none = () => 'none' as WaitState;
    let opened = 0;
    for (let i = 0; i < 10; i++) {
      const now = plus(i);
      const d = decideTurnEnd(store, { now, waitState: none });
      if (d.continuation) {
        opened += 1;
        store.runs[d.continuation.requirementId]!.continuedAt.push(now.toISOString());
        store.runs[d.continuation.requirementId]!.lastFingerprint = d.continuation.fingerprint;
      } else expect(d.capped).toEqual(['ceo:d1']);
      setNext(store, 'ceo:d1', `step ${i}`, now.toISOString());
    }
    expect(opened).toBe(8);
    expect(decideTurnEnd(store, { now: plus(61), waitState: none }).continuation?.requirementId).toBe('ceo:d1');
  });

  test('a verified wait (armed, future deadline) is waiting, not a gap; a fired wait continues', async () => {
    const h = harness();
    try {
      h.seed.p0Cells = [];
      h.seed.delegated = [{ commitmentId: 'c-1', msgId: '500', text: 'Follow up on message #500 to TC', status: 'open', wait: { commitmentId: 'c-1', condition: 'mail-reply:500', deadlineAt: plus(30).toISOString() } }];
      h.setWaits({ 'c-1': 'armed' });
      expect((await h.turnEnd(T0)).opened).toBe(false);
      h.setWaits({ 'c-1': 'fired' });
      expect((await h.turnEnd(plus(5))).opened).toBe(true);
      expect(h.opened[0]!.text).toContain('Next step: Read the reply to message #500, verify the result, then close with evidence or re-delegate with a new wait');
    } finally { h.done(); }
  });

  test('a refused door does not count; a green P0 cell closes on its checklist status', async () => {
    const h = harness();
    try {
      h.setDoor(false);
      expect((await h.turnEnd(T0)).opened).toBe(false);
      h.setDoor(true);
      expect((await h.turnEnd(plus(1))).opened).toBe(true); // not blocked: the refused attempt left no fingerprint
      h.seed.p0Cells = [{ version: '0.3.35', id: 'CELL-A', title: 'cell a', status: 'green' }];
      await h.turnEnd(plus(2));
      const r = readStore(h.path).requirements[0]!;
      expect(r.status).toBe('closed');
      expect(r.evidence).toEqual({ kind: 'checklist', cellId: 'CELL-A', status: 'green' });
    } finally { h.done(); }
  });
});

describe('OP-REQUIREMENT-LOOP stale ledger (11-24: 392 open, CEO line drowned)', () => {
  const overdueMail = (n: number) => ({ commitmentId: `c-${n}`, msgId: String(n), text: `Follow up on message #${n} to JUD-B`, status: 'open', peer: 'JUD-B',
    wait: { commitmentId: `c-${n}`, condition: `mail-reply:${n}`, deadlineAt: '2026-11-23T21:33:26.227Z' } });

  test('3 overdue mail-reply waits + 1 fresh CEO item → the CEO item first and at most 3 items', () => {
    const store = emptyStore();
    seedRequirements(store, { delegated: [overdueMail(101), overdueMail(102), overdueMail(103)] }, '2026-11-23T21:03:26.000Z');
    seedRequirements(store, { directives: [{ turnId: 'ceo-new', text: 'Make 0.3.35 green today', refs: ['cell:SIM-1'] }] }, T0.toISOString());
    const d = decideTurnEnd(store, { now: T0, waitState: () => 'expired' });
    expect(d.escalated).toEqual(['req:msg:101', 'req:msg:102', 'req:msg:103']);
    expect(d.continuation!.items.map((i) => i.requirementId)).toEqual(['ceo:ceo-new', 'req:msg:103', 'req:msg:102']);
    expect(d.continuation!.requirementId).toBe('ceo:ceo-new');
    const text = d.continuation!.text;
    expect(text.split('\n')[0]).toBe('[requirement-loop] 3 of 4 open requirements, newest CEO items first:');
    expect(text).toContain('(1) Requirement ceo:ceo-new is still open');
    expect(text).toContain("Next step: no reply from JUD-B to #103 — read that seat's screen (ElsControl read), nudge it, or do it yourself; then close with evidence or attach a new wait (it expires at 2026-11-24T00:30:00.000Z)");
    expect(text).not.toContain('req:msg:101 is still open');
  });

  test('newest CEO item outranks an older CEO item', () => {
    const store = emptyStore();
    seedRequirements(store, { directives: [{ turnId: 'old', text: 'old line', refs: ['cell:SIM-1'] }] }, T0.toISOString());
    seedRequirements(store, { directives: [{ turnId: 'new', text: 'new line', refs: ['cell:SIM-1'] }] }, plus(5).toISOString());
    expect(decideTurnEnd(store, { now: plus(6), waitState: () => 'none' }).continuation!.items.map((i) => i.requirementId)).toEqual(['ceo:new', 'ceo:old']);
  });

  test('an overdue wait is escalated once; still open one interval later it closes as expired with a log line', async () => {
    const h = harness();
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    try {
      h.seed.p0Cells = [];
      h.seed.delegated = [overdueMail(200)];
      const turnEnd = (now: Date) => runRequirementTurnEnd({ seat: 'OP', humanTurn: null, now: () => now, stateRoot: () => h.root,
        startTurnIfIdle: () => ({ opened: true, turnId: 't' }), gather: async () => ({ seed: h.seed, waitState: () => 'expired' as WaitState }), raiseException: () => undefined, postMail: () => undefined, coordinatorOf: () => undefined,
        log: (_c, event, data) => logs.push({ event, data }) });
      await turnEnd(T0);
      let r = readStore(h.path).requirements[0]!;
      expect(r.status).toBe('open');
      expect(r.escalatedAt).toBe('2026-11-24T00:00:00.000Z');
      expect(logs.filter((l) => l.event === 'escalated').map((l) => l.data.requirementIds)).toEqual([['req:msg:200']]);
      await turnEnd(plus(10));                   // same gap → blocked, not escalated again
      expect(logs.filter((l) => l.event === 'escalated').length).toBe(1);
      await turnEnd(plus(30));                   // one interval after escalation
      r = readStore(h.path).requirements[0]!;
      expect(r.status).toBe('expired');
      expect(r.expired).toEqual({ at: '2026-11-24T00:30:00.000Z', reason: 'wait mail-reply:200 overdue since 2026-11-23T21:33:26.227Z, escalated 2026-11-24T00:00:00.000Z, no close' });
      expect(logs.filter((l) => l.event === 'expired').map((l) => l.data.line)).toEqual(['⌛ EXPIRED req:msg:200 · wait mail-reply:200 overdue since 2026-11-23T21:33:26.227Z, escalated 2026-11-24T00:00:00.000Z, no close']);
      await turnEnd(plus(40));                   // the same stale waker keeps it expired
      expect(readStore(h.path).requirements[0]!.status).toBe('expired');
      h.seed.delegated = [{ ...overdueMail(200), wait: { commitmentId: 'c-200', condition: 'mail-reply:200', deadlineAt: plus(90).toISOString() } }];
      await turnEnd(plus(50));                   // re-delegated with a new future wait → open again
      r = readStore(h.path).requirements[0]!;
      expect(r.status).toBe('open');
      expect(r.escalatedAt).toBeUndefined();
    } finally { h.done(); }
  });

  test('CLI: --superseded-by and --supersedes close older CEO items as superseded; list shows counts and hides expired', async () => {
    const h = harness();
    try {
      const store = emptyStore();
      seedRequirements(store, { directives: [{ turnId: 'a', text: 'topic v1', refs: ['cell:SIM-1'] }] }, T0.toISOString());
      seedRequirements(store, { directives: [{ turnId: 'b', text: 'topic v2', refs: ['cell:SIM-1'] }] }, plus(1).toISOString());
      seedRequirements(store, { directives: [{ turnId: 'c', text: 'topic v3', refs: ['cell:SIM-1'] }] }, plus(2).toISOString());
      seedRequirements(store, { delegated: [overdueMail(300)] }, T0.toISOString());
      store.requirements.find((r) => r.id === 'req:msg:300')!.status = 'expired';
      writeStore(h.path, store);
      const lines: string[] = [];
      const errors: string[] = [];
      let json = '';
      const msg = new Command('msg').exitOverride();
      registerMsgRequirementCommands(msg, { out: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) }, setExitCode: () => {}, stateRoot: () => h.root, now: () => plus(3), writeJson: (t) => { json = t; } });
      await msg.parseAsync(['node', 'msg', 'req', 'close', 'ceo:a', '--superseded-by', 'ceo:b']);
      await msg.parseAsync(['node', 'msg', 'req', 'close', 'ceo:c', '--pr', '39940', '--supersedes', 'ceo:b']);
      await msg.parseAsync(['node', 'msg', 'req', 'close', 'ceo:c', '--superseded-by', 'ceo:a']);
      expect(errors).toEqual(['msg req close: ceo:a is older than ceo:c']);
      const after = readStore(h.path).requirements;
      expect(after.map((r) => [r.id, r.status, r.supersededBy ?? null])).toEqual([
        ['ceo:a', 'superseded', 'ceo:b'], ['ceo:b', 'superseded', 'ceo:c'], ['ceo:c', 'closed', null], ['req:msg:300', 'expired', null]]);
      lines.length = 0;
      await msg.parseAsync(['node', 'msg', 'req', 'list']);
      expect(lines).toEqual(['open 0 · blocked 0 · expired 1 · superseded 2 · closed 1 (closed · expired · superseded hidden — --all shows them)']);
      lines.length = 0;
      await msg.parseAsync(['node', 'msg', 'req', 'list', '--all']);
      expect(lines[0]).toBe('open 0 · blocked 0 · expired 1 · superseded 2 · closed 1');
      expect(lines.length).toBe(5);
      await msg.parseAsync(['node', 'msg', 'req', 'list', '--json']);
      expect(JSON.parse(json).counts).toEqual({ open: 0, blocked: 0, closed: 1, expired: 1, superseded: 2, stale: 0 });
    } finally { h.done(); }
  });
});
