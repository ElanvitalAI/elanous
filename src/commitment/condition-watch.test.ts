// COND-WATCH 시험 — 가짜 시계 · 임시 디렉터리 영수 · 가짜 우편. 기대값은 독립 리터럴(제품 상수·렌더 함수 재사용 0).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from './ledger.js';
import { findPregateReceipt, pregateGreenDir } from './pregate-receipt-dir.js';
import { parseWatch, suggestWatch, watchBoardCounts, watchBoardLine, withWatchFooter } from './condition-watch.js';
import { armWaker, evaluateWaker, listWakers, parseWaitCondition, tickWakers, watchWaker, type SelfTimerDeps, type WaitProbes, type WatchTrigger } from '../msg/self-timer-watch.js';
import { armMessageFollowUp } from '../msg/msg-follow-up.js';
import { MsgStore } from '../msg/msg-store.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const T0 = Date.parse('2026-11-25T05:00:00.000Z');

function world(probe: Partial<WaitProbes> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cond-watch-')); roots.push(root);
  const greenDir = join(root, 'PREGATE-GREEN');
  mkdirSync(greenDir, { recursive: true });
  let nowMs = T0;
  let cid = 0, wid = 0;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const notices: { seat: string; body: string }[] = [];
  const now = () => new Date(nowMs);
  const emit = (_c: string, event: string, data: Record<string, unknown>) => { events.push({ event, data }); };
  const ledger = new CommitmentLedger({ root: join(root, 'ledger'), now, newId: () => `c-${++cid}`, emit });
  const probes: WaitProbes = {
    prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false,
    pregateReceipt: async (pr, head) => { const lane = findPregateReceipt(greenDir, pr, head); return lane ? `receipt ${lane}` : null; },
    ...probe,
  };
  const deps: SelfTimerDeps = {
    root: join(root, 'wakers'), ledger, now, emit, probes, newId: () => `w-${++wid}`,
    sleep: async (ms) => { nowMs += ms; },
    postNotice: async (seat, body) => { notices.push({ seat, body }); return 900 + notices.length; },
    pid: 77, isPidAlive: () => false,
  };
  return { root, greenDir, deps, ledger, events, notices, advance: (ms: number) => { nowMs += ms; } };
}

describe('condition grammar', () => {
  test('parses and canonicalises the outcome kinds', () => {
    expect(parseWaitCondition('pregate-receipt:#40062')).toEqual({ kind: 'pregate-receipt', pr: 40062 });
    expect(parseWaitCondition('pregate-receipt:40062@ABCDEF0123456789')).toEqual({ kind: 'pregate-receipt', pr: 40062, head: 'abcdef012345' });
    expect(parseWaitCondition('cell-status:LAND-QUEUE-1=green')).toEqual({ kind: 'cell-status', cell: 'LAND-QUEUE-1', status: 'green' });
    expect(parseWaitCondition('cell-status:LAND-QUEUE-1=owner=tc')).toEqual({ kind: 'cell-status', cell: 'LAND-QUEUE-1', owner: 'TC' });
    expect(parseWaitCondition('seat-idle:ux')).toEqual({ kind: 'seat-idle', seat: 'UX' });
    expect(parseWaitCondition('mail-from:jud')).toEqual({ kind: 'mail-from', seat: 'JUD' });
    expect(parseWaitCondition('file-exists:/tmp/x.json')).toEqual({ kind: 'file', path: '/tmp/x.json' });
    for (const bad of ['pregate-receipt:abc', 'pregate-receipt:1@zz', 'cell-status:X', 'cell-status:X=purple', 'seat-idle:', 'mail-from:a b']) {
      expect(() => parseWaitCondition(bad)).toThrow();
    }
  });

  test('--watch refuses timers and reply ids', () => {
    expect(() => parseWatch('time:30m')).toThrow();
    expect(() => parseWatch('mail-reply:5')).toThrow();
    expect(parseWatch('pr-merged:40070')).toEqual({ kind: 'pr-merged', pr: 40070 });
  });

  test('pregate dir comes from configuration, not a literal', () => {
    expect(pregateGreenDir({ ELANOUS_PREGATE_GREEN_DIR: '/x/green' })).toBe('/x/green');
    expect(pregateGreenDir({ ELANOUS_HQ_ROOT: '/hq' })).toBe('/hq/seat-state/RES/evidence/PREGATE-GREEN');
  });
});

describe('ledger watch', () => {
  test('pregate receipt appears → commitment closes with evidence, owner woken once', async () => {
    const w = world();
    const entry = w.ledger.add({ seat: 'OP', sessionId: 'msg:1', text: 'Watch pregate-receipt:40062', evidence: 'MsgPost #1' }).entry;
    const armed = armWaker({ seat: 'OP', commitmentId: entry.id, condition: 'pregate-receipt:40062', withinMs: 7_200_000, autoClose: true }, w.deps);
    expect((await evaluateWaker('OP', armed.waker.id, w.deps)).outcome).toBe('pending');
    expect(w.notices).toHaveLength(0);

    mkdirSync(join(w.greenDir, '40062-0123456789ab-minim5'));
    const tick = await evaluateWaker('OP', armed.waker.id, w.deps);
    expect(tick.outcome).toBe('fired');
    expect(tick.waker.evidence).toBe('receipt 40062-0123456789ab-minim5');

    const closed = w.ledger.get('OP', entry.id)!;
    expect(closed.status).toBe('done');
    expect(closed.doneEvidence).toBe('watch pregate-receipt:40062: receipt 40062-0123456789ab-minim5');
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.seat).toBe('OP');
    expect(w.notices[0]!.body).toContain('✅ watch satisfied');
    expect(w.notices[0]!.body).toContain('40062-0123456789ab-minim5');

    // A later tick never wakes again.
    expect(await tickWakers('OP', w.deps)).toEqual([]);
    expect(w.notices).toHaveLength(1);
    const names = w.events.map(e => e.event);
    expect(names.filter(n => n === 'commitment.watch.armed')).toHaveLength(1);
    expect(names.filter(n => n === 'commitment.watch.satisfied')).toHaveLength(1);
    expect(w.events.find(e => e.event === 'commitment.watch.satisfied')!.data.kind).toBe('pregate-receipt');
  });

  test('head-pinned watch ignores a receipt for another head', async () => {
    const w = world();
    const entry = w.ledger.add({ seat: 'OP', sessionId: 's', text: 'Watch head', evidence: 'e' }).entry;
    const armed = armWaker({ seat: 'OP', commitmentId: entry.id, condition: 'pregate-receipt:40062@aaaaaaaaaaaa', withinMs: 3_600_000, autoClose: true }, w.deps);
    mkdirSync(join(w.greenDir, '40062-bbbbbbbbbbbb-minim5'));
    mkdirSync(join(w.greenDir, '40063-aaaaaaaaaaaa-minim5'));
    expect((await evaluateWaker('OP', armed.waker.id, w.deps)).outcome).toBe('pending');
    mkdirSync(join(w.greenDir, '40062-aaaaaaaaaaaa-node-b'));
    expect((await evaluateWaker('OP', armed.waker.id, w.deps)).outcome).toBe('fired');
  });

  test('expiry → exactly one wake, commitment stays open', async () => {
    const w = world();
    const entry = w.ledger.add({ seat: 'OP', sessionId: 's', text: 'Watch expire', evidence: 'e' }).entry;
    const armed = armWaker({ seat: 'OP', commitmentId: entry.id, condition: 'pregate-receipt:40099', withinMs: 600_000, autoClose: true }, w.deps);
    w.advance(600_000);
    expect((await evaluateWaker('OP', armed.waker.id, w.deps)).outcome).toBe('expired');
    w.advance(60_000);
    expect(await tickWakers('OP', w.deps)).toEqual([]);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.body).toContain('expired');
    expect(w.ledger.get('OP', entry.id)!.status).toBe('open');
    expect(w.events.filter(e => e.event === 'commitment.watch.expired')).toHaveLength(1);
  });

  test('unrelated events never wake: other PR receipts, other seat mail, other cell', async () => {
    const mails: Array<{ from: string; to: string; id: number }> = [];
    const cells: Record<string, { status: string; owner?: string }> = { 'LAND-QUEUE-1': { status: 'yellow', owner: 'TC' } };
    const w = world({
      cellStatus: async (id) => cells[id] ?? null,
      mailFrom: async (from, to) => mails.find(m => m.from === from && m.to === to)?.id ?? null,
    });
    const e1 = w.ledger.add({ seat: 'OP', sessionId: 's', text: 'a', evidence: 'e' }).entry;
    const e2 = w.ledger.add({ seat: 'OP', sessionId: 's', text: 'b', evidence: 'e' }).entry;
    const e3 = w.ledger.add({ seat: 'OP', sessionId: 's', text: 'c', evidence: 'e' }).entry;
    armWaker({ seat: 'OP', commitmentId: e1.id, condition: 'pregate-receipt:40062', withinMs: 3_600_000, autoClose: true }, w.deps);
    armWaker({ seat: 'OP', commitmentId: e2.id, condition: 'mail-from:JUD', withinMs: 3_600_000, autoClose: true }, w.deps);
    armWaker({ seat: 'OP', commitmentId: e3.id, condition: 'cell-status:LAND-QUEUE-1=green', withinMs: 3_600_000, autoClose: true }, w.deps);

    mkdirSync(join(w.greenDir, '40061-0123456789ab-minim5'));
    mails.push({ from: 'TC', to: 'OP', id: 5 }, { from: 'JUD', to: 'UX', id: 6 });
    cells['LAND-QUEUE-2'] = { status: 'green' };
    cells['LAND-QUEUE-1'] = { status: 'yellow', owner: 'UX' };
    const ticks = await tickWakers('OP', w.deps);
    expect(ticks.map(t => t.outcome)).toEqual(['pending', 'pending', 'pending']);
    expect(w.notices).toHaveLength(0);

    cells['LAND-QUEUE-1'] = { status: 'green', owner: 'UX' };
    mails.push({ from: 'JUD', to: 'OP', id: 7 });
    const second = await tickWakers('OP', w.deps);
    expect(second.map(t => t.outcome)).toEqual(['pending', 'fired', 'fired']);
    expect(w.ledger.get('OP', e2.id)!.doneEvidence).toBe('watch mail-from:JUD: mail #7 from JUD');
    expect(w.ledger.get('OP', e3.id)!.doneEvidence).toBe('watch cell-status:LAND-QUEUE-1=green: cell LAND-QUEUE-1 status=green owner=UX');
    expect(w.notices).toHaveLength(2);
  });

  test('event trigger re-measures at once instead of sleeping a poll', async () => {
    const w = world();
    const entry = w.ledger.add({ seat: 'OP', sessionId: 's', text: 'trig', evidence: 'e' }).entry;
    const armed = armWaker({ seat: 'OP', commitmentId: entry.id, condition: 'pregate-receipt:40070', withinMs: 3_600_000, autoClose: true }, w.deps);
    const waits: number[] = [];
    let closed = false;
    const trigger = (paths: readonly string[]): WatchTrigger => {
      expect(paths).toHaveLength(1);
      return { next: async (ms) => { waits.push(ms); mkdirSync(join(w.greenDir, '40070-0123456789ab-minim5')); }, close: () => { closed = true; } };
    };
    const result = await watchWaker('OP', armed.waker.id, { ...w.deps, trigger });
    expect(result.outcome).toBe('fired');
    expect(waits).toEqual([60_000]);
    expect(closed).toBe(true);
  });
});

describe('MsgPost --watch', () => {
  test('watch replaces the reply-wait: footer, outcome waker, auto-close', async () => {
    const w = world();
    let launched = 0;
    const deps = {
      openStore: () => new MsgStore(join(w.root, 'messages.db')),
      followUp: (m: Parameters<typeof armMessageFollowUp>[0], pr: number | undefined, _d: unknown, watch?: string) =>
        armMessageFollowUp(m, pr, { ledger: w.ledger, timer: w.deps, launch: async () => { launched++; } }, watch),
    };
    const res = await dispatchMsgPost({ from: 'OP', to: 'TC', body: 'Run pregate on #40062', intent: 'request', watch: 'pregate-receipt:40062' }, deps);
    expect(res.message!.body).toContain('Run pregate on #40062');
    expect(res.message!.body).toContain('— no reply needed — produce a pregate GREEN receipt for PR #40062');
    expect(res.followUp).toMatchObject({ condition: 'pregate-receipt:40062', watch: true, merged: false });
    expect(res.output).toContain('watch pregate-receipt:40062');
    expect(launched).toBe(1);
    const [waker] = listWakers('OP', w.deps);
    expect(waker!.condition).toBe('pregate-receipt:40062');
    expect(waker!.autoClose).toBe(true);
    expect(Date.parse(waker!.deadlineAt) - Date.parse(waker!.armedAt)).toBe(7_200_000);

    mkdirSync(join(w.greenDir, '40062-fedcba987654-minim5'));
    expect((await evaluateWaker('OP', waker!.id, w.deps)).outcome).toBe('fired');
    const id = (res.followUp as { commitmentId: string }).commitmentId;
    expect(w.ledger.get('OP', id)!.status).toBe('done');
    expect(w.notices).toHaveLength(1);
  });

  test('bad watch stores nothing', async () => {
    const w = world();
    const store = () => new MsgStore(join(w.root, 'messages.db'));
    await expect(dispatchMsgPost({ from: 'OP', to: 'TC', body: 'x', watch: 'time:5m' }, { openStore: store })).rejects.toThrow();
    const s = store();
    try { expect(s.latestId()).toBe(0); } finally { s.close(); }
  });

  test('structured fields suggest a pregate watch; prose never does', async () => {
    expect(suggestWatch({ kind: 'pregate', waitForPr: 40062 })).toBe('pregate-receipt:40062');
    expect(suggestWatch({ refs: ['pr:#40063', 'await:영수'] })).toBe('pregate-receipt:40063');
    expect(suggestWatch({ kind: 'request', refs: ['pr:40063'] })).toBeNull();
    expect(suggestWatch({ kind: 'pregate' })).toBeNull();
    const w = world();
    const res = await dispatchMsgPost({ from: 'OP', to: 'TC', body: 'pregate 영수 #40064 회신해 달라', intent: 'request', kind: 'pregate', waitForPr: 40064 },
      { openStore: () => new MsgStore(join(w.root, 'messages.db')), followUp: async () => ({ commitmentId: 'c', wakerId: 'w', condition: 'pr-merged:40064', merged: false, watch: false }) });
    expect(res.suggestedWatch).toBe('pregate-receipt:40064');
    expect(res.output).toContain('suggest watch pregate-receipt:40064');
    const plain = await dispatchMsgPost({ from: 'REL', to: 'TC', body: 'pregate 영수 #40065 회신해 달라', intent: 'request' },
      { openStore: () => new MsgStore(join(w.root, 'messages.db')), followUp: async () => ({ commitmentId: 'c', wakerId: 'w', condition: 'mail-reply:9', merged: false, watch: false }) });
    expect(plain.suggestedWatch).toBeUndefined();
  });

  test('footer is appended once', () => {
    const c = parseWatch('seat-idle:UX');
    const once = withWatchFooter('do it', c);
    expect(withWatchFooter(once, c)).toBe(once);
    expect(once).toBe('do it\n\n— no reply needed — produce UX idle (work finished); the sender is watching for it (watch seat-idle:UX)');
  });
});

test('board line counts open watches, satisfied in the last hour, and reply-waits', () => {
  const at = (min: number) => new Date(T0 - min * 60_000).toISOString();
  const base = { seat: 'OP', commitmentId: 'c', armedAt: at(90), deadlineAt: at(-30), checks: 0 };
  const counts = watchBoardCounts([
    { ...base, id: '1', condition: 'pregate-receipt:1', status: 'armed', autoClose: true },
    { ...base, id: '2', condition: 'seat-idle:UX', status: 'armed', autoClose: true },
    { ...base, id: '3', condition: 'pr-merged:2', status: 'fired', autoClose: true, closedAt: at(10) },
    { ...base, id: '4', condition: 'pr-merged:3', status: 'fired', autoClose: true, closedAt: at(70) },
    { ...base, id: '5', condition: 'mail-reply:44', status: 'armed' },
    { ...base, id: '6', condition: 'pr-merged:4', status: 'armed' },
  ], T0);
  expect(counts).toEqual({ watchesOpen: 2, satisfiedLastHour: 1, replyWaits: 1 });
  expect(watchBoardLine(counts)).toBe('👁 Watches open 2 · satisfied/h 1 · reply-waits 1');
});
