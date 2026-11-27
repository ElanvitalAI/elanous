// ELN-PLAN-WIRE-SEAT (#38016, absorbed into DECISION-GATE v2) — mail → decomposition → plan → next item, against the REAL
// prompt-queue adapter, the real queue and a real mail ledger (the first version only passed through test doubles).
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ACTIVE_PLAN_ITEMS } from '../seat/seat-task-decompose.js';
import { debug } from '../debug/log.js';
import { MsgStore } from '../msg/msg-store.js';
import type { Message } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { decideNextTuiAutoContinue } from './core/turn.js';
import {
  appendSeatPlan,
  createSeatMailPlanRuntime,
  createSeatPlanFileStore,
  createSeatPlanTurnLink,
  messageToTaskRequest,
  structuredPriority,
  supersedeAllowed,
  type PlanRevisedEvent,
  seatPlanLine,
  seatTaskQueueFromPromptQueue,
  wireSeatMailToPlan,
} from './seat-mail-boot.js';

const SEAT = 'OPC';

function mail(id: number, body: string, kind?: string): Message {
  return {
    id, from: 'OP', to: SEAT, body,
    createdAt: new Date(Date.UTC(2026, 10, 17, 6, 0, id)).toISOString(),
    ...(kind !== undefined ? { kind } : {}),
  } as unknown as Message;
}

function fakeLedger(messages: Message[], cursor = 0) {
  return {
    list: (recipient: string, after = 0) => messages.filter(m => m.to === recipient && m.id > after),
    getCursor: (_recipient: string) => cursor,
    getMessage: (id: number) => messages.find(m => m.id === id) ?? null,
  };
}

/** The real adapter over the real queue — what production uses. */
function realPort() {
  const queue = createNextTuiQueue();
  return { queue, port: seatTaskQueueFromPromptQueue(queue) };
}
const noticeTexts = (queue: ReturnType<typeof createNextTuiQueue>): string[] => queue.items.filter(item => item.kind === 'notice').map(item => item.text);

describe('ELN-PLAN-WIRE-SEAT wiring', () => {
  test('unread mail → decomposition → ONE active item queued as a seat-mail notice → header piece', () => {
    const { queue, port } = realPort();
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '칸 ELN-PLAN-WIRE-SEAT 구현 후 시험하고 보고')]) });
    const status = rt.absorb();
    expect(rt.plan()).toHaveLength(status.open);
    expect(status.active).toBeLessThanOrEqual(MAX_ACTIVE_PLAN_ITEMS);
    expect(noticeTexts(queue)).toHaveLength(status.active);
    expect(queue.items.every(item => item.source === 'seat-mail')).toBe(true);
    expect(seatPlanLine(status)).toBe(`계획 ${status.active}/${status.open}`);
    expect(appendSeatPlan('OPC · mail 2', status)).toBe(`OPC · mail 2 · 계획 ${status.active}/${status.open}`);
  });

  test('invariants 7-8: receiving or an interrupt mail never stops or closes the active item', () => {
    expect(messageToTaskRequest(mail(9, '그냥 메모', 'note')).interrupt).toBeUndefined();
    expect(messageToTaskRequest(mail(10, '긴급 지시', 'interrupt')).interrupt).toBe(true);
    const { port } = realPort();
    const inbox: Message[] = [mail(1, '#5001 merge 시험 보고')];
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger(inbox) });
    rt.absorb();
    const active = rt.plan().find(t => t.status === 'active')!;
    inbox.push(mail(2, '#5002 merge 시험 보고', 'note'));
    rt.absorb();
    expect(rt.plan().find(t => t.id === active.id)!.status).toBe('active');
    inbox.push(mail(3, '#9900 merge 하고 시험 돌린 뒤 보고', 'interrupt'));
    rt.absorb();
    const paused = rt.plan().find(t => t.id === active.id)!;
    expect(paused.status).not.toBe('cancelled');
    expect(paused.status).not.toBe('superseded');
    expect(rt.plan().filter(t => t.status === 'active')).toHaveLength(MAX_ACTIVE_PLAN_ITEMS);
  });

  test('invariant 10: a «hold» utterance never cancels anything by itself', () => {
    const { port } = realPort();
    const inbox: Message[] = [mail(1, '#38007 merge 충돌 해소 시험 보고')];
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger(inbox) });
    rt.absorb();
    const target = rt.plan().find(t => (t.targets ?? []).includes('#38007'))!;
    inbox.push(mail(2, '#38007 보류'));
    rt.absorb();
    expect(rt.plan().find(t => t.id === target.id)!.status).not.toBe('cancelled');
  });

  test('invariant 9: evidence is required, closing one item promotes the next, the last close empties the plan', () => {
    const { port } = realPort();
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '#5001 merge 시험 보고'), mail(2, '#5002 merge 시험 보고')]) });
    rt.absorb();
    const first = rt.plan().find(t => t.status === 'active')!;
    expect(() => rt.complete(first.id, '   ')).toThrow();
    const mid = rt.complete(first.id, 'bun test passed');
    expect(rt.plan().find(t => t.id === first.id)).toMatchObject({ status: 'done', doneEvidence: 'bun test passed' });
    expect(mid.active).toBe(MAX_ACTIVE_PLAN_ITEMS);
    const next = rt.plan().find(t => t.status === 'active')!;
    const end = rt.complete(next.id, 'report receipt');
    expect(end).toMatchObject({ open: 0, active: 0 });
  });

  test('only the active item is queued, the next one is queued when it is promoted, and a closed item leaves the REAL queue', () => {
    const { queue, port } = realPort();
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '#5001 merge 시험 보고'), mail(2, '#5002 merge 시험 보고')]) });
    const first = rt.absorb();
    expect(first.open).toBeGreaterThan(first.active);
    expect(noticeTexts(queue)).toHaveLength(MAX_ACTIVE_PLAN_ITEMS);
    const firstNotice = noticeTexts(queue)[0]!;
    // Closing the active item retracts its undelivered notice and queues the promoted one — queue and plan stay in step.
    rt.complete(rt.plan().find(t => t.status === 'active')!.id, 'done');
    expect(noticeTexts(queue)).toHaveLength(MAX_ACTIVE_PLAN_ITEMS);
    expect(noticeTexts(queue)).not.toContain(firstNotice);
    // A second absorb never re-queues what is already there.
    const before = noticeTexts(queue);
    rt.absorb();
    expect(noticeTexts(queue)).toEqual(before);
  });

  test('a delivered notice cannot be retracted — closing its item does not throw', () => {
    const { queue, port } = realPort();
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '#5001 merge 시험 보고')]) });
    rt.absorb();
    expect(queue.dequeue().kind).toBe('submit');
    expect(() => rt.complete(rt.plan().find(t => t.status === 'active')!.id, 'done')).not.toThrow();
  });
});

describe('turn outcome drives completion (DECISION-GATE v2)', () => {
  const twoItems = () => {
    const { queue, port } = realPort();
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '#5001 merge 시험 보고'), mail(2, '#5002 merge 시험 보고')]) });
    rt.absorb();
    return { queue, rt };
  };
  const noticeId = (queue: ReturnType<typeof createNextTuiQueue>): string => queue.items.find(item => item.kind === 'notice')!.id;
  const finished = (version: number) => ({ version, versionAtTurnStart: version - 1, steps: [{ status: 'completed' as const, step: 'a' }, { status: 'completed' as const, step: 'b' }] });

  test('done closes the active item with the plan as evidence and promotes the next; every other outcome changes nothing', () => {
    const { queue, rt } = twoItems();
    const id = noticeId(queue);
    const activeBefore = rt.plan().find(t => t.status === 'active')!;
    for (const kind of ['continue', 'blocked', 'waiting'] as const) expect(rt.noteTurnOutcome(kind, 'x', id)).toBeNull();
    expect(rt.plan().find(t => t.id === activeBefore.id)!.status).toBe('active');
    const after = rt.noteTurnOutcome('done', 'update_plan: all steps completed', id)!;
    expect(rt.plan().find(t => t.id === activeBefore.id)).toMatchObject({ status: 'done', doneEvidence: 'update_plan: all steps completed' });
    expect(after.active).toBe(MAX_ACTIVE_PLAN_ITEMS);
    expect(noticeTexts(queue)).toHaveLength(MAX_ACTIVE_PLAN_ITEMS);
    // The notice the turn started from now belongs to a closed item: it can close nothing else.
    expect(rt.noteTurnOutcome('done', 'again', id)).toBeNull();
  });

  test('a queued input or a draft makes the auto-continue yield — the finished plan still closes its item (mf2-1)', () => {
    const { queue, rt } = twoItems();
    const link = createSeatPlanTurnLink(rt);
    const id = noticeId(queue);
    link.noticeDispatched(id, '[계획] x');
    const chain = link.turnStarted('[계획] x', false);
    expect(chain).toBe(id);
    const outcome = { kind: 'completed', goalComplete: false, compacted: false, planOutcome: finished(2) } as const;
    // The gate in entry.ts: with something queued or typed, the auto-continue decision is «yield» and never calls goal-continue …
    expect(decideNextTuiAutoContinue(outcome as never, 1, '')).toBe('yield');
    expect(decideNextTuiAutoContinue(outcome as never, 0, 'a draft')).toBe('yield');
    // … yet the plan bookkeeping runs on its own and closes the item.
    const activeBefore = rt.plan().find(t => t.status === 'active')!.id;
    expect(link.turnEnded(chain, true, outcome.planOutcome)).not.toBeNull();
    expect(rt.plan().find(t => t.id === activeBefore)!.status).toBe('done');
    // A cancelled or failed turn closes nothing.
    const { queue: q2, rt: rt2 } = twoItems();
    const link2 = createSeatPlanTurnLink(rt2);
    link2.noticeDispatched(noticeId(q2), 'n');
    expect(link2.turnEnded(link2.turnStarted('n', false), false, finished(2))).toBeNull();
  });

  test('a person\'s own finished plan never closes an unrelated active mail item (mf2-2); an automatic follow-up of the item\'s turn does', () => {
    const { queue, rt } = twoItems();
    const link = createSeatPlanTurnLink(rt);
    const active = rt.plan().find(t => t.status === 'active')!.id;
    // The person types a question; the model makes and finishes its own plan. No notice was dispatched: no chain.
    const personChain = link.turnStarted('refactor this function please', false);
    expect(personChain).toBeNull();
    expect(link.turnEnded(personChain, true, finished(2))).toBeNull();
    expect(rt.plan().find(t => t.id === active)!.status).toBe('active');
    // The item's own turn, then its automatic follow-up (internal): the chain survives and the finished plan closes the item.
    link.noticeDispatched(noticeId(queue), '[계획] item');
    expect(link.turnStarted('[계획] item', false)).not.toBeNull();
    const followUp = link.turnStarted('[plan] Open steps remain in your plan', true);
    expect(followUp).not.toBeNull();
    expect(link.turnEnded(followUp, true, finished(3))).not.toBeNull();
    expect(rt.plan().find(t => t.id === active)!.status).toBe('done');
    // A person's typed turn in the middle of a chain breaks it.
    const { queue: q3, rt: rt3 } = twoItems();
    const link3 = createSeatPlanTurnLink(rt3);
    link3.noticeDispatched(noticeId(q3), 'n');
    link3.turnStarted('n', false);
    expect(link3.turnStarted('something the person typed', false)).toBeNull();
  });
});

describe('restart and boot', () => {
  test('a restart re-queues only the saved active item and never adds the same mail twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-seat-plan-restart-'));
    try {
      const store = createSeatPlanFileStore(join(root, 'plan.json'));
      const inbox = [mail(1, '#5001 merge 시험 보고'), mail(2, '#5002 merge 시험 보고')];
      const boot1 = realPort();
      // The clock is the mail's day (PLAN-STALE-ON-BOOT expires items older than 48 h at boot).
      const now = () => Date.UTC(2026, 10, 17, 7, 0, 0);
      const rt1 = wireSeatMailToPlan(boot1.port, { seat: SEAT, ledger: fakeLedger(inbox), store, now });
      rt1.absorb();
      const planBefore = rt1.plan().map(t => t.id);
      // New process: a fresh queue, the same ledger (nothing was acked), the same plan file.
      const boot2 = realPort();
      const rt2 = wireSeatMailToPlan(boot2.port, { seat: SEAT, ledger: fakeLedger(inbox), store, now });
      expect(rt2.plan().map(t => t.id)).toEqual(planBefore);
      expect(noticeTexts(boot2.queue)).toHaveLength(MAX_ACTIVE_PLAN_ITEMS);
      rt2.absorb();
      expect(rt2.plan().map(t => t.id)).toEqual(planBefore);
      expect(noticeTexts(boot2.queue)).toHaveLength(MAX_ACTIVE_PLAN_ITEMS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('boot against a real ledger: header shows the plan, mail that arrives AFTER boot is absorbed, a non-seat cwd builds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-seat-plan-runtime-'));
    const home = join(root, 'home');
    const msgPath = join(root, 'messages.db');
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    const store = new MsgStore(msgPath);
    try {
      store.post({ from: 'OP', to: SEAT, body: '#5001 merge 시험 보고' });
      const { queue, port } = realPort();
      const booted = createSeatMailPlanRuntime({ cwd: join(root, 'seats', SEAT), deps: { home, msgPath, env: {} }, queue: port, planDir: join(root, 'plans') });
      const runtime = booted.runtime!;
      expect(runtime).not.toBeNull();
      expect(booted.header(null, null)).toContain(`계획 ${runtime.status().active}/`);
      expect(noticeTexts(queue)).toHaveLength(runtime.status().active);
      // The ledger is not closed for good: later mail reaches the plan on the next absorb.
      const openBefore = runtime.status().open;
      store.post({ from: 'OP', to: SEAT, body: '#5002 merge 시험 보고' });
      expect(runtime.absorb().open).toBeGreaterThan(openBefore);
      // Not a seat directory: no runtime, no plan.
      expect(createSeatMailPlanRuntime({ cwd: join(root, 'elsewhere'), deps: { home, msgPath, env: {} }, queue: realPort().port }).runtime).toBeNull();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('plan.revised ledger event (ELN-PLAN-WIRE-SEAT · JUD HOLD)', () => {
  type Ev = PlanRevisedEvent;
  const wire = (inbox: Message[]) => {
    const { queue, port } = realPort();
    const events: Ev[] = [];
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger(inbox), onPlanEvent: (name, data) => { expect(name).toBe('plan.revised'); events.push(data); } });
    return { queue, rt, events };
  };

  test('mail absorbed → one plan.revised{before, after, reason, reportLine, msgIds} · ids and states only, no mail text', () => {
    const inbox = [mail(1, '#5001 merge 시험 보고 비밀-본문'), mail(2, '#5002 merge 시험 보고')];
    const { rt, events } = wire(inbox);
    rt.absorb();
    expect(events).toHaveLength(1);
    const [first] = events;
    expect(first).toMatchObject({ seat: SEAT, reason: 'mail-absorbed', msgIds: [1, 2], before: { active: 0, open: 0, items: [] } });
    expect(first!.after.items).toEqual(rt.plan().map(item => ({ id: item.id, status: item.status })));
    expect(first!.after.open).toBe(rt.status().open);
    expect(typeof first!.reportLine).toBe('string');
    expect(JSON.stringify(first)).not.toContain('비밀-본문');
    // No new mail → no revision → no event.
    rt.absorb();
    expect(events).toHaveLength(1);
  });

  test('closing the active item (complete · turn done) emits before→after with the item id; a no-op outcome emits nothing', () => {
    const { queue, rt, events } = wire([mail(1, '#5001 merge 시험 보고'), mail(2, '#5002 merge 시험 보고')]);
    rt.absorb();
    const id = queue.items.find(item => item.kind === 'notice')!.id;
    const active = rt.plan().find(task => task.status === 'active')!;
    for (const kind of ['continue', 'blocked', 'waiting'] as const) rt.noteTurnOutcome(kind, 'x', id);
    expect(events).toHaveLength(1);
    rt.noteTurnOutcome('done', 'update_plan: all steps completed', id);
    expect(events).toHaveLength(2);
    const closed = events[1]!;
    expect(closed).toMatchObject({ seat: SEAT, reason: 'turn-done', itemId: active.id });
    expect(closed.before.items.find(item => item.id === active.id)!.status).toBe('active');
    expect(closed.after.items.find(item => item.id === active.id)!.status).toBe('done');
    const next = rt.plan().find(task => task.status === 'active')!;
    rt.complete(next.id, 'evidence');
    expect(events[2]).toMatchObject({ reason: 'item-done', itemId: next.id });
  });

  test('default sink writes eln logs category plan, event plan.revised', () => {
    const calls: Array<[string, string]> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event) => { calls.push([category, event]); });
    try {
      const { port } = realPort();
      wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '#5001 merge 시험 보고')]) }).absorb();
    } finally { spy.mockRestore(); }
    expect(calls).toContainEqual(['plan', 'plan.revised']);
  });
});

describe('ELN-SEAT-WORK-QUEUE — 🔴/CROWN > P0 > normal from structured fields · stale reports dropped · depth and longest wait', () => {
  const withFields = (base: Message, fields: Partial<Message>): Message => ({ ...base, ...fields }) as Message;

  test('structured priority: crown delegation / priority 2 → urgent · priority 1 → p0 · words alone unchanged', () => {
    expect(structuredPriority({ crownDirective: 'd-1' })).toBe('urgent');
    expect(structuredPriority({ origin: { kind: 'agent', seat: 'OP', delegatedByCrown: true } })).toBe('urgent');
    expect(structuredPriority({ priority: 2 })).toBe('urgent');
    expect(structuredPriority({ priority: 1 })).toBe('p0');
    expect(structuredPriority({ priority: 0 })).toBeUndefined();
    expect(messageToTaskRequest(withFields(mail(5, '#5005 merge 시험 보고'), { crownDirective: 'd-9' })).priority).toBe('urgent');
  });

  test('a crown/urgent mail that arrives later becomes the active item ahead of normal work (no wording needed)', () => {
    const { port } = realPort();
    const inbox: Message[] = [mail(1, '#5001 merge 시험 보고'), mail(2, '#5002 merge 시험 보고')];
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger(inbox) });
    rt.absorb();
    inbox.push(withFields(mail(3, '#5003 merge 시험 보고'), { priority: 2 }));
    rt.absorb();
    const urgent = rt.plan().find(task => task.sourceRequestId === 'mail#3')!;
    expect(urgent.priority).toBe('urgent');
    const queued = rt.plan().filter(task => task.status === 'queued');
    expect(queued.every(task => task.priority !== 'urgent' || task.id === urgent.id)).toBe(true);
  });

  test('«낡은 정기 보고 생략»: a message that supersedes an older one closes the older items and is not doubled', () => {
    const { port } = realPort();
    const events: PlanRevisedEvent[] = [];
    const inbox: Message[] = [mail(1, '#5001 merge 시험 보고'), mail(2, '정기 보고: 칸 ELN-SEAT-WORK-QUEUE 진행 1')];
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger(inbox), onPlanEvent: (_n, data) => { events.push(data); } });
    rt.absorb();
    const older = rt.plan().filter(task => task.sourceRequestId === 'mail#2');
    expect(older).not.toHaveLength(0);
    inbox.push(withFields(mail(3, '정기 보고: 칸 ELN-SEAT-WORK-QUEUE 진행 2'), { supersedes: 2 }));
    rt.absorb();
    // #38288 REVIEW-2 must: across two batches the NEWER report stays (it is the host now) — nothing vanishes silently.
    const newer = rt.plan().filter(item => item.sourceRequestId === 'mail#3');
    expect(newer).not.toHaveLength(0);
    for (const task of newer) expect(['queued', 'active']).toContain(task.status);
    for (const task of rt.plan().filter(item => item.sourceRequestId === 'mail#2')) {
      expect(task.status).toBe('superseded');
      expect(newer.map(item => item.id)).toContain(task.supersededBy ?? "");
    }
    expect(events.at(-1)!.superseded).toEqual(older.map(task => ({ itemId: task.id, by: newer[0]!.id })));
    // Same batch: the replaced message is never decomposed at all — control first: without `supersedes` it would be.
    const { port: control } = realPort();
    const rt0 = wireSeatMailToPlan(control, { seat: SEAT, ledger: fakeLedger([mail(1, '정기 보고 1'), mail(2, '정기 보고 2')]) });
    rt0.absorb();
    expect(rt0.plan().some(task => task.sourceRequestId === 'mail#1')).toBe(true);
    const { port: port2 } = realPort();
    const rt2 = wireSeatMailToPlan(port2, { seat: SEAT, ledger: fakeLedger([mail(1, '정기 보고 1'), withFields(mail(2, '정기 보고 2'), { supersedes: 1 })]) });
    rt2.absorb();
    expect(rt2.plan().some(task => task.sourceRequestId === 'mail#1')).toBe(false);
    expect(events.at(-1)!.after.items.length).toBe(rt.plan().length);
  });

  test('queue depth and longest wait are observable (status ⊕ plan.revised), measured from when the mail arrived', () => {
    const { port } = realPort();
    const events: PlanRevisedEvent[] = [];
    const first = mail(1, '#5001 merge 시험 보고');
    const arrived = Date.parse(first.createdAt);
    const WAITED = 90_000; // Source: #38049 — a minute and a half; any positive gap shows the same rule
    const second = mail(2, '#5002 merge 시험 보고');
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([first, second]),
      now: () => arrived + WAITED, onPlanEvent: (_n, data) => { events.push(data); } });
    const status = rt.absorb();
    expect(status.open).toBe(rt.plan().length);
    // Exact: the oldest still-QUEUED item is the second mail (the first is active) → WAITED minus its later arrival.
    const queuedFrom = rt.plan().filter(task => task.status === 'queued').map(task => task.sourceRequestId);
    const oldestQueued = queuedFrom.includes('mail#1') ? arrived : Date.parse(second.createdAt);
    expect(status.oldestWaitMs).toBe(arrived + WAITED - oldestQueued);
    // Waiting since the first mail arrived: at most WAITED, and not zero.
    expect(status.oldestWaitMs ?? 0).not.toBe(0);
    expect(Math.min(WAITED, status.oldestWaitMs ?? 0)).toBe(status.oldestWaitMs ?? 0);
    expect(events.at(-1)!.after.oldestWaitMs).toBe(status.oldestWaitMs ?? null);
    expect(events.at(-1)!.before.oldestWaitMs).toBeNull();
  });
});

describe('ELN-SEAT-WORK-QUEUE supersede rule (OP decision on #38288)', () => {
  const as = (base: Message, fields: Partial<Message>): Message => ({ ...base, ...fields }) as Message;

  test('own mail · OP · CROWN may replace; a CROWN item only by CROWN; anyone else is refused', () => {
    const tc = { from: 'TC' }; const res = { from: 'RES' }; const op = { from: 'OP' }; const crown = { from: 'MK', crownDirective: 'd-1' };
    expect(supersedeAllowed(tc, tc)).toBe(true);
    expect(supersedeAllowed(res, tc)).toBe(false);
    expect(supersedeAllowed(op, tc)).toBe(true);
    expect(supersedeAllowed(crown, tc)).toBe(true);
    expect(supersedeAllowed(op, crown)).toBe(false); // even OP cannot replace a CROWN directive
    expect(supersedeAllowed({ from: 'RES', origin: { kind: 'agent', seat: 'RES', delegatedByCrown: true } }, crown)).toBe(true);
  });

  test('someone else\'s normal mail trying to replace a CROWN directive is refused: the CROWN item stays, an event says why', () => {
    const { port } = realPort();
    const refused: unknown[] = [];
    const inbox: Message[] = [as(mail(1, '칸 ELN-SEAT-WORK-QUEUE 진행 · CROWN 지시'), { from: 'OP', crownDirective: 'd-9' })];
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger(inbox), onSupersedeRefused: (d) => { refused.push(d); } });
    rt.absorb();
    const crownItems = rt.plan().filter(task => task.sourceRequestId === 'mail#1');
    expect(crownItems).not.toHaveLength(0);
    inbox.push(as(mail(2, '정기 보고: 칸 ELN-SEAT-WORK-QUEUE 진행 끝'), { from: 'RES', supersedes: 1 }));
    rt.absorb();
    for (const task of rt.plan().filter(item => item.sourceRequestId === 'mail#1')) expect(task.status).not.toBe('superseded');
    expect(refused).toEqual([{ seat: SEAT, msgId: 2, from: 'RES', target: 1, targetFrom: 'OP', reason: 'crown-item-needs-crown' }]);
  });
});

describe('plan path receipts (G1 — live eln-main 9e078bba: a plan-item turn left its mail «unseen» → false A217 overdue)', () => {
  test('boot absorb → delivered(plan) · unanswered turn → no seen · answered turn → seen(plan) · a 0-item mail is not the plan\'s (TURN-FIELD-BUG-3: the watcher carries it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-seat-plan-receipts-'));
    const home = join(root, 'home');
    const msgPath = join(root, 'messages.db');
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    const store = new MsgStore(msgPath);
    try {
      const work = store.post({ from: 'OP', to: SEAT, body: '칸 ELN-PROBE-ALPHA 진행', intent: 'request' });
      const chatter = store.post({ from: 'OP', to: SEAT, body: '상태줄 확인용 한 줄', intent: 'request' });
      const { queue, port } = realPort();
      const booted = createSeatMailPlanRuntime({ cwd: join(root, 'seats', SEAT), deps: { home, msgPath, env: {} }, queue: port, planDir: join(root, 'plans') });
      const link = createSeatPlanTurnLink(booted.runtime!);
      const states = (id: number) => store.listReceipts({ messageId: id }).map(r => `${r.state}:${r.source}`);
      expect(states(work.id)).toEqual(['posted:ledger', 'delivered:plan']);
      expect(states(chatter.id)).toEqual(['posted:ledger']); // 0 items: no plan receipt — the watcher still sees it
      const unseen = () => store.listUnseenRequests({ postedBefore: new Date(Date.now() + 60_000), postedAfter: new Date(0) }).map(row => `${row.message.id}:${row.current}`);
      expect(unseen().sort()).toEqual([`${chatter.id}:posted`, `${work.id}:delivered`].sort());

      const notice = queue.items.find(item => item.kind === 'notice')!;
      link.noticeDispatched(notice.id, notice.text);
      const chain = link.turnStarted(notice.text, true);
      expect(chain).toBe(notice.id);
      link.turnEnded(chain, false, undefined); // failed / cancelled: no answer
      expect(states(work.id)).not.toContain('seen:plan');
      link.turnEnded(link.turnStarted('계속', true), true, undefined); // the item's chain answered
      expect(states(work.id)).toEqual(['posted:ledger', 'delivered:plan', 'seen:plan']);
      expect(store.listReceipts({ messageId: work.id }).at(-1)!.queueItemId).toBe(notice.id);
      expect(unseen()).toEqual([`${chatter.id}:posted`]); // nobody worked the 0-item mail: still overdue-able
      // A person's own turn is not the item's: no receipt.
      link.turnEnded(link.turnStarted('사람이 친 질문', false), true, undefined);
      expect(states(chatter.id)).toEqual(['posted:ledger']);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a receipt writer that throws changes nothing in the plan and is never silent (msg.receipt-writer record-failed warn)', () => {
    const { queue, port } = realPort();
    const logSpy = spyOn(debug, 'log');
    try {
      const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(1, '#5001 merge 시험 보고')]), recordReceipts: () => { throw new Error('SQLITE_BUSY'); } });
      const status = rt.absorb();
      expect(status.active).toBe(1); // the plan absorbed the mail as if receipts were fine
      expect(noticeTexts(queue)).toHaveLength(1);
      const failed = logSpy.mock.calls.filter(call => call[0] === 'msg.receipt-writer' && call[1] === 'record-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]![2]).toMatchObject({ seat: SEAT, source: 'plan', msgIds: [1], state: 'delivered', error: 'SQLITE_BUSY' });
      expect(failed[0]![3]).toEqual({ level: 'warn' });
    } finally { logSpy.mockRestore(); }
  });
});

test('real boot wiring: one message whose receipt write fails does not block the others · warn names seat and msgIds (#38376 Terra ①)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-seat-plan-partial-'));
  const home = join(root, 'home');
  const msgPath = join(root, 'messages.db');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
  const store = new MsgStore(msgPath);
  const logSpy = spyOn(debug, 'log');
  const original = MsgStore.prototype.recordReceipt;
  let failId = -1;
  const writeSpy = spyOn(MsgStore.prototype, 'recordReceipt').mockImplementation(function (this: MsgStore, input) {
    if (input.messageId === failId) throw new Error('SQLITE_BUSY');
    return original.call(this, input);
  });
  try {
    const first = store.post({ from: 'OP', to: SEAT, body: '칸 ELN-PROBE-A 진행', intent: 'request' });
    const broken = store.post({ from: 'OP', to: SEAT, body: '칸 ELN-PROBE-B 진행', intent: 'request' });
    const last = store.post({ from: 'OP', to: SEAT, body: '칸 ELN-PROBE-C 진행', intent: 'request' });
    failId = broken.id;
    const booted = createSeatMailPlanRuntime({ cwd: join(root, 'seats', SEAT), deps: { home, msgPath, env: {} }, queue: realPort().port, planDir: join(root, 'plans') });
    expect(booted.runtime).not.toBeNull();
    const delivered = (id: number) => store.listReceipts({ messageId: id }).some(r => r.state === 'delivered' && r.source === 'plan');
    expect([delivered(first.id), delivered(broken.id), delivered(last.id)]).toEqual([true, false, true]);
    const failed = logSpy.mock.calls.filter(call => call[0] === 'msg.receipt-writer' && call[1] === 'record-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]![2]).toMatchObject({ seat: SEAT, source: 'plan', msgIds: [broken.id], state: 'delivered', error: 'SQLITE_BUSY' });
    expect(failed[0]![3]).toEqual({ level: 'warn' });
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ELN-SEAT-INBOX-TURN-BOUNDARY (#121130) — a plan notice is the mail original, not a summary', () => {
  test('a mail absorbed as a plan item is injected at the turn boundary as its ORIGINAL (sender · msg:<id> · body verbatim)', () => {
    const { queue, port } = realPort();
    // «칸 … 시험 진행» — a request the decomposition actually absorbs as a plan item (a 0-item mail
    // is the watcher's, TURN-FIELD-BUG-3). Multi-line: the verbatim check must survive line breaks.
    const body = '칸 INBOX_BOUNDARY_MARKER 원문 주입 시험 진행\nINBOX_BOUNDARY_MARKER 원문 첫째 줄\n둘째 줄: 발신·msgId·본문 전체가 모델 입력에 그대로 들어가야 한다';
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([mail(7, body)]) });
    rt.absorb();
    const notice = queue.items.find(item => item.kind === 'notice');
    expect(notice).toBeDefined();
    // The queue tracks the mail identity on the notice (msgId meta — the wait/observation machinery keys on it).
    expect(notice?.msgId).toBe(7);
    // The next-turn model input is this notice text: it must carry the sender, the msg id and the body VERBATIM.
    expect(notice?.text).toContain('OP');
    expect(notice?.text).toContain('msg:7');
    expect(notice?.text).toContain(body);
  });

  test('r2 (JUD #121493) — the plan notice keeps the ledger\'s VERIFIED markers (origin · intent · crown) when they differ from legacy sender/kind', () => {
    const { queue, port } = realPort();
    // Legacy row: sender OP · transport kind 'note' → the legacy fallback header would be «[from OP · info]».
    // Verified columns (B1-A): origin { agent · TC-H-CC-1 } · intent 'decision' · crown 'd-9' — these must WIN.
    const verified = {
      ...mail(11, '칸 INBOX_VERIFIED_MARKER 진행 후 시험 보고'),
      kind: 'note',
      origin: { kind: 'agent', seat: 'TC-H-CC-1' },
      intent: 'decision',
      crownDirective: 'd-9',
    } as unknown as Message;
    // The request carries the verified fields alongside the legacy ones (header = headerFieldsOf of the message).
    expect(messageToTaskRequest(verified)).toMatchObject({
      sender: 'OP',
      kind: 'note',
      header: { fromKind: 'agent', fromSeat: 'TC-H-CC-1', intent: 'decision', crownDirective: 'd-9' },
    });
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([verified]) });
    rt.absorb();
    const notice = queue.items.find(item => item.kind === 'notice')!;
    // The next-turn model input prefers the VERIFIED header — the legacy «[from OP · …]» must not appear.
    expect(notice.text).toContain('[from TC-H-CC-1 · decision · crown]');
    expect(notice.text).not.toContain('[from OP');
    expect(notice.text).toContain('msg:11');
    expect(notice.text).toContain('칸 INBOX_VERIFIED_MARKER 진행 후 시험 보고');
  });

  test('r2 (JUD #121493) — a legacy-only row (no verified columns) keeps the sender/kind fallback header, unchanged', () => {
    const { queue, port } = realPort();
    const legacyOnly = mail(12, '#5101 merge 시험 보고', 'note');
    const rt = wireSeatMailToPlan(port, { seat: SEAT, ledger: fakeLedger([legacyOnly]) });
    rt.absorb();
    const notice = queue.items.find(item => item.kind === 'notice')!;
    // No verified columns → the header falls back exactly as before r2: [from OP · info(note)].
    expect(notice.text).toContain('[from OP · info]');
    expect(notice.text).toContain('msg:12');
  });
});
