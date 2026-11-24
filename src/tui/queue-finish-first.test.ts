import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createNextTuiQueue } from './core/queue.js';
import {
  classifySeatMail, createQueueFinishFirst, decideIdleQueue, heldChip, heldPeekBlock, midTurnMailAction, NO_WAITS,
  type QueueClassItem,
} from './queue-finish-first.js';
import { mailReplyId } from '../op-requirements/turn-end.js';
import { seatMailBundleText } from './seat-mail-digest.js';
import { buildInterjectionMessage } from '../chat/interjection.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../llm.js';

/**
 * QUEUE-FINISH-FIRST (대표 11-24 12:4x · 12:5x · 13:0x) — the seat's own work finishes before ordinary mail opens a turn.
 * Expectations are literals (rule 11): class names, reasons, counts and the wrap-up sentence are written out here.
 */

const MIN = 60_000; // 출처: #39946 one minute of the injected test clock
type Logged = { category: string; event: string; data: Record<string, unknown> };
/** QUEUE-P1-3MIN — every P1 join in this suite (except the documented long-tool case) is checked against 180 s at the end. */
const p1Waits: number[] = [];

// The queue stamps enqueuedAt with Date.now — the system clock is pinned to the injected clock so waits are exact.
afterEach(() => { setSystemTime(); });
function rig(start = Date.UTC(2026, 10, 24, 4, 0, 0)) {
  let t = start;
  setSystemTime(new Date(t));
  const logs: Logged[] = [];
  const ff = createQueueFinishFirst({ now: () => t, log: (category, event, data) => {
    logs.push({ category, event, data });
    if (event === 'p1-joined' && typeof data.waitedMs === 'number') p1Waits.push(data.waitedMs);
  } });
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const mail = (id: number, cls: 'P0' | 'P1' | 'P2', extra: { replyTo?: number; intent?: string } = {}) =>
    queue.enqueueNotice(`[seat mail #${id}] body of ${id}`, 'seat-mail', {
      msgId: id, mailClass: cls, digest: `#${id} · TC · ${cls === 'P1' ? 'request' : 'info'} · body of ${id}`,
      mailIntent: extra.intent ?? (cls === 'P1' ? 'request' : 'info'),
      occurredAt: t, ...(extra.replyTo === undefined ? {} : { replyTo: extra.replyTo }),
    });
  const queued = () => queue.items.filter((item) => item.status === 'queued');
  return { ff, queue, logs, mail, queued, advance: (ms: number) => { t += ms; setSystemTime(new Date(t)); }, now: () => t };
}

describe('QUEUE-FINISH-FIRST — classification is structured only', () => {
  test('intent / origin / crown decide the class; the body never does', () => {
    expect(classifySeatMail({ intent: 'info' })).toBe('P2');
    expect(classifySeatMail({ intent: 'request' })).toBe('P1');
    expect(classifySeatMail({ intent: 'decision' })).toBe('P1');
    expect(classifySeatMail({ intent: 'alert' })).toBe('P0');
    expect(classifySeatMail({ intent: 'info', origin: { kind: 'human' } })).toBe('P0');
    expect(classifySeatMail({ intent: 'info', crownDirective: 'D-12' })).toBe('P0');
    expect(classifySeatMail({ intent: 'info', origin: { kind: 'agent', delegatedByCrown: true } })).toBe('P0');
    expect(classifySeatMail({})).toBe('P2');
  });

  test('mail-reply:<id> waits parse to ids; anything else is no wait', () => {
    expect(mailReplyId('mail-reply:4242')).toEqual([4242]);
    expect(mailReplyId('mail-reply:#77')).toEqual([77]);
    expect(mailReplyId('pr-merged:12')).toEqual([]);
    expect(mailReplyId(undefined)).toEqual([]);
  });
});

describe('QUEUE-FINISH-FIRST — the literal scenarios', () => {
  test('open requirement after turn + 3 P2 mails → next idle runs the continuation, mails held', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(101, 'P2'); r.mail(102, 'P2'); r.mail(103, 'P2');
    const verdict = r.ff.decide(r.queued());
    expect(verdict.kind).toBe('continue');
    expect(r.queue.count).toBe(3);
    const held = r.logs.filter((l) => l.category === 'tui.queue' && l.event === 'held');
    expect(held.map((l) => l.data.msgId)).toEqual([101, 102, 103]);
    expect(held.every((l) => l.data.reason === 'work-in-progress' && l.data.class === 'P2')).toBe(true);
    expect(heldChip(r.ff.heldCount())).toBe('📩 3 held');
  });

  test('continuation completes (no open item) → ONE digest turn with the 3 mails', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(101, 'P2'); r.mail(102, 'P2'); r.mail(103, 'P2');
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.ff.noteContinuationOpened(); r.ff.noteTurnStarted();
    r.ff.noteTurnEnd({ workInProgress: false });
    const verdict = r.ff.decide(r.queued());
    expect(verdict).toEqual({ kind: 'release', reason: 'work-done' });
    const bundle = r.queue.drainNotices();
    expect(bundle.kind).toBe('notices');
    if (bundle.kind !== 'notices') return;
    expect(bundle.notices.map((n) => n.msgId)).toEqual([101, 102, 103]);
    expect(seatMailBundleText(bundle.notices).startsWith('[seat-mail digest] 3 mails')).toBe(true);
    expect(r.queue.count).toBe(0);
    expect(r.logs.find((l) => l.event === 'released')?.data.reason).toBe('work-done');
  });

  test('a P0 urgent arriving mid-hold starts at the next idle boundary; held mail stays queued', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(201, 'P2'); r.mail(202, 'P1');
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.mail(203, 'P0');
    const verdict = r.ff.decide(r.queued());
    expect(verdict.kind).toBe('pass-unheld');
    if (verdict.kind !== 'pass-unheld') return;
    const keep = new Set(verdict.heldIds);
    const bundle = r.queue.drainNotices((item) => keep.has(item.id));
    expect(bundle.kind === 'notices' ? bundle.notices.map((n) => n.msgId) : []).toEqual([203]);
    expect(r.queued().map((item) => item.msgId)).toEqual([201, 202]);
  });

  test('starvation: a P2 held 20 min is released; a P1 is due after 60 s (never the old 10 min)', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(301, 'P2');
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.ff.noteContinuationOpened(); r.ff.noteTurnStarted(); r.ff.noteTurnEnd({ workInProgress: true });
    r.advance(19 * MIN);
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.advance(1 * MIN);
    expect(r.ff.releaseDue(r.queued())).toBe(true);
    expect(r.ff.decide(r.queued())).toEqual({ kind: 'release', reason: 'starvation' });

    const p1 = decideIdleQueue({ items: [{ id: 'a', text: 'x', kind: 'notice', source: 'seat-mail', mailClass: 'P1', mailIntent: 'request', enqueuedAt: 0 }],
      waits: NO_WAITS, workInProgress: true, continuationsWhileHolding: 0, awaitingStartSince: null, continuationTried: false, now: 1 * MIN });
    expect(p1).toEqual({ kind: 'deliver-p1', ids: ['a'], paused: true, heldIds: [] });
  });

  test('no progress: after 3 continuations while holding the mail is released', () => {
    const r = rig();
    r.mail(401, 'P2');
    for (let i = 0; i < 3; i += 1) {
      r.ff.noteTurnEnd({ workInProgress: true });
      expect(r.ff.decide(r.queued()).kind).toBe('continue');
      r.ff.noteContinuationOpened(); r.ff.noteTurnStarted();
    }
    r.ff.noteTurnEnd({ workInProgress: true });
    expect(r.ff.decide(r.queued())).toEqual({ kind: 'release', reason: 'no-progress' });
  });

  test('a continuation that never starts releases the mail after the grace window', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(501, 'P1');
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.ff.noteContinuationOpened();
    expect(r.ff.decide(r.queued())).toMatchObject({ kind: 'hold', reason: 'continuation-starting' });
    r.advance(15_000);
    expect(r.ff.decide(r.queued())).toEqual({ kind: 'release', reason: 'continuation-not-started' });
  });

  test('coalescing: a mail turn less than 5 min after the last one waits; P0 is exempt', () => {
    const r = rig();
    r.ff.noteMailTurn();
    r.ff.noteTurnEnd({ workInProgress: false });
    r.advance(1 * MIN);
    r.mail(601, 'P2');
    expect(r.ff.decide(r.queued())).toMatchObject({ kind: 'hold', reason: 'coalescing' });
    r.mail(602, 'P0');
    expect(r.ff.decide(r.queued()).kind).toBe('pass-unheld');
    r.queue.drainNotices((item) => item.msgId === 601);
    r.advance(4 * MIN);
    expect(r.ff.releaseDue(r.queued())).toBe(true);
    expect(r.ff.decide(r.queued())).toEqual({ kind: 'release', reason: 'work-done' });
  });
});

describe('QUEUE-FINISH-FIRST — peek and related mail (12:5x)', () => {
  test('reply #X to the open wait mail-reply:X joins the next continuation in full while work is in progress', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true, waitingReplyTo: [7001] });
    r.mail(701, 'P2');
    r.mail(702, 'P1', { replyTo: 7001 });
    const verdict = r.ff.decide(r.queued());
    expect(verdict.kind).toBe('continue');
    const extras = r.ff.continuationExtras(r.queued());
    expect(extras.suffix).toContain('[joined to current work · 1 related]');
    expect(extras.suffix).toContain('[seat mail #702] body of 702');
    expect(extras.suffix).toContain('📩 #701 · TC · info · body of 701');
    expect(extras.suffix).not.toContain('[seat mail #701] body of 701');
    const joined = r.queue.takeNotices(extras.relatedIds);
    expect(joined.map((n) => n.msgId)).toEqual([702]);
    expect(r.queued().map((item) => item.msgId)).toEqual([701]);
  });

  test('peek block: at most 8 old lines then «+N more», and every not-yet-peeked mail is always listed', () => {
    const items: QueueClassItem[] = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, text: `t${i}`, kind: 'notice', source: 'seat-mail',
      mailClass: 'P2', digest: `#${900 + i} · UX · info · line ${i}` }));
    const allOld = heldPeekBlock(items, new Set(items.map((item) => item.id)))!.split('\n');
    expect(allOld).toHaveLength(1 + 8 + 1);
    expect(allOld[allOld.length - 1]).toBe('+2 more');
    const fresh = heldPeekBlock(items)!.split('\n');
    expect(fresh).toHaveLength(1 + 10);
    expect(fresh[1]).toBe('📩 #900 · UX · info · line 0');
  });

  test('20-mail burst during a 3-turn continuation: every mail peeked or delivered within 1 turn, 0 lost', () => {
    const r = rig();
    const replies = [8001, 8002, 8003];
    const seenAtTurn = new Map<number, number>();
    const delivered = new Set<number>();
    let next = 1;
    const arrive = (n: number, replyIndex: number) => {
      for (let i = 0; i < n; i += 1) {
        const id = 1000 + next; next += 1;
        if (i === 0) r.mail(id, 'P1', { replyTo: replies[replyIndex] }); else r.mail(id, i % 2 ? 'P2' : 'P1');
      }
    };
    r.ff.noteTurnEnd({ workInProgress: true, waitingReplyTo: replies });
    for (let turn = 1; turn <= 3; turn += 1) {
      arrive(turn === 3 ? 6 : 7, turn - 1);
      expect(r.ff.decide(r.queued()).kind).toBe('continue');
      const extras = r.ff.continuationExtras(r.queued());
      for (const item of r.queued()) {
        if (extras.suffix.includes(`#${item.msgId} `) && !seenAtTurn.has(item.msgId!)) seenAtTurn.set(item.msgId!, turn);
      }
      for (const one of r.queue.takeNotices(extras.relatedIds)) delivered.add(one.msgId!);
      r.ff.notePeeked(extras.heldIds);
      r.ff.noteContinuationOpened(); r.ff.noteTurnStarted();
      r.ff.noteTurnEnd({ workInProgress: turn < 3, waitingReplyTo: replies });
    }
    expect([...delivered]).toEqual([1001, 1008, 1015]);
    // Work done: the due P1s go first on their own (QUEUE-P1-3MIN · no pause), then the P2 digest.
    const p1 = r.ff.decide(r.queued());
    expect(p1).toMatchObject({ kind: 'deliver-p1', paused: false });
    if (p1.kind !== 'deliver-p1') return;
    const keep = new Set(p1.heldIds);
    const p1Bundle = r.queue.drainNotices((item) => keep.has(item.id));
    if (p1Bundle.kind === 'notices') for (const one of p1Bundle.notices) delivered.add(one.msgId!);
    expect(p1Bundle.kind === 'notices' ? p1Bundle.notices.length : 0).toBe(8);
    expect(r.ff.decide(r.queued())).toEqual({ kind: 'release', reason: 'work-done' });
    const bundle = r.queue.drainNotices();
    if (bundle.kind === 'notices') for (const one of bundle.notices) delivered.add(one.msgId!);
    expect(delivered.size).toBe(20);
    expect(r.queue.count).toBe(0);
    // Every held mail was seen in the continuation of the turn it arrived in.
    expect(seenAtTurn.size).toBe(17);
  });
});

describe('QUEUE-FINISH-FIRST — the person joins at the step boundary (13:0x)', () => {
  test('mid-turn person input carries the wrap-up sentence; mail-only interjection does not', () => {
    const human = buildInterjectionMessage(['please also check X'], 'mid-turn')!;
    expect(human).toContain('Finish the immediate step you were on (record its result / update the requirement) in one move, then address this input.');
    const mailOnly = buildInterjectionMessage([{ kind: 'seat-mail', msgId: 1, from: 'TC', intent: 'info', text: 'fyi' }], 'mid-turn')!;
    expect(mailOnly).not.toContain('Finish the immediate step');
  });

  test('input typed while a 3-tool batch runs: all 3 results recorded, input joins the following model call after them', async () => {
    const pending: string[] = [];
    const requests: Array<Array<{ role: string; content: unknown }>> = [];
    let dispatched = 0;
    const provider: LLMProvider = {
      name: 'step-boundary-provider', defaultModel: 'step-boundary-model', available: () => true,
      async *chat() { yield 'unused'; },
      streamChat(messages) {
        requests.push(messages.map((m) => ({ role: m.role, content: m.content })));
        if (requests.length === 1) {
          return (async function* () {
            yield { type: 'tool_call', id: 'c1', name: 'probe', args: { n: 1 } } as LLMStreamEvent;
            yield { type: 'tool_call', id: 'c2', name: 'probe', args: { n: 2 } } as LLMStreamEvent;
            yield { type: 'tool_call', id: 'c3', name: 'probe', args: { n: 3 } } as LLMStreamEvent;
          })();
        }
        return (async function* () { yield { type: 'text', delta: 'done' } as LLMStreamEvent; })();
      },
    };
    const text = await streamLLMWithTools([{ role: 'user', content: 'initial work' }],
      { onText() {}, dispatchTool: async () => { dispatched += 1; if (dispatched === 2) pending.push('PERSON-LINE'); return `result-${dispatched}`; } },
      { provider, model: provider.defaultModel, maxTurns: 3, tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
        drainPendingUserInput: () => pending.splice(0) });
    expect(text).toContain('done');
    expect(dispatched).toBe(3);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).not.toContain('PERSON-LINE');
    const second = JSON.stringify(requests[1]);
    for (const r of ['result-1', 'result-2', 'result-3']) expect(second.indexOf(r)).toBeGreaterThan(-1);
    const steerAt = second.indexOf('PERSON-LINE');
    expect(steerAt).toBeGreaterThan(second.indexOf('result-3'));
    expect(second).toContain('Finish the immediate step you were on');
  });
});

describe('QUEUE-P1-3MIN — P1 hold-and-resume, never > 3 min (13:1x)', () => {
  test('P1 during a 3-turn continuation: held 60 s, joins at the step boundary, the next turn resumes with the checkpoint; P2 still held', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(1101, 'P2');
    r.mail(1102, 'P1');
    const p1 = r.queued().find((item) => item.msgId === 1102)!;
    // Arrival during the running continuation: not due yet → steer when it falls due (60 s).
    expect(midTurnMailAction(p1, 'P1', true, r.now())).toEqual({ kind: 'steer-at', inMs: 60_000 });
    expect(midTurnMailAction(r.queued().find((item) => item.msgId === 1101)!, 'P2', true, r.now())).toEqual({ kind: 'held' });
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.ff.noteContinuationOpened(); r.ff.noteTurnStarted();
    r.advance(60_000);
    expect(midTurnMailAction(p1, 'P1', true, r.now())).toEqual({ kind: 'steer-now' });
    // The turn ended before the steer landed: the idle door delivers the due P1 now, P2 stays held, the work pauses.
    r.ff.noteTurnEnd({ workInProgress: true });
    const verdict = r.ff.decide(r.queued());
    expect(verdict.kind).toBe('deliver-p1');
    if (verdict.kind !== 'deliver-p1') return;
    expect(verdict.paused).toBe(true);
    const keep = new Set(verdict.heldIds);
    const bundle = r.queue.drainNotices((item) => keep.has(item.id));
    expect(bundle.kind === 'notices' ? bundle.notices.map((n) => n.msgId) : []).toEqual([1102]);
    expect(r.queued().map((item) => item.msgId)).toEqual([1101]);
    expect(r.logs.find((l) => l.event === 'p1-joined')?.data.waitedMs).toBe(60_000);
    // The P1 turn ends with no open work of its own → the paused continuation resumes first.
    r.ff.noteTurnStarted();
    r.ff.noteTurnEnd({ workInProgress: false });
    expect(r.ff.resumePending()).toBe(true);
    expect(r.ff.decide(r.queued()).kind).toBe('continue');
    r.ff.noteResumed('auto-9');
    expect(r.ff.resumePending()).toBe(false);
    expect(r.logs.find((l) => l.event === 'resumed')?.data).toMatchObject({ checkpoint: 'model-recorded', turnId: 'auto-9' });
    expect(r.queued().map((item) => item.msgId)).toEqual([1101]);
  });

  test('a decision joins at once; any P1 joins at once when no work is open (no coalescing for P1)', () => {
    const r = rig();
    r.ff.noteTurnEnd({ workInProgress: true });
    r.mail(1201, 'P1', { intent: 'decision' });
    const decision = r.queued()[0]!;
    expect(midTurnMailAction(decision, 'P1', true, r.now())).toEqual({ kind: 'steer-now' });
    expect(r.ff.decide(r.queued())).toMatchObject({ kind: 'deliver-p1', ids: [decision.id], paused: true });
    r.queue.drainNotices();
    const s2 = rig();
    s2.ff.noteMailTurn();
    s2.ff.noteTurnEnd({ workInProgress: false });
    s2.mail(1202, 'P1');
    expect(s2.ff.decide(s2.queued())).toMatchObject({ kind: 'deliver-p1', paused: false });
  });

  test('P1 arriving while a 4-min tool runs joins when that tool returns — the tool is not cut, its result comes first', async () => {
    const pending: Array<string | { kind: 'seat-mail'; msgId: number; from: string; intent: string; text: string }> = [];
    const requests: string[] = [];
    let clock = 0;
    const provider: LLMProvider = {
      name: 'long-tool-provider', defaultModel: 'long-tool-model', available: () => true,
      async *chat() { yield 'unused'; },
      streamChat(messages) {
        requests.push(JSON.stringify(messages));
        if (requests.length === 1) return (async function* () { yield { type: 'tool_call', id: 'long', name: 'probe', args: {} } as LLMStreamEvent; })();
        return (async function* () { yield { type: 'text', delta: 'handled' } as LLMStreamEvent; })();
      },
    };
    await streamLLMWithTools([{ role: 'user', content: 'continue the work' }],
      { onText() {}, dispatchTool: async () => {
        clock = 60_000; // P1 due 60 s into the tool: the steer is offered now …
        pending.push({ kind: 'seat-mail', msgId: 1301, from: 'TC', intent: 'request', text: 'P1-REQUEST' });
        clock = 240_000; // … and the tool runs on to 4 min; it is never aborted.
        return 'LONG-TOOL-RESULT';
      } },
      { provider, model: provider.defaultModel, maxTurns: 3, tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
        drainPendingUserInput: () => pending.splice(0) });
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain('P1-REQUEST');
    expect(requests[1]!.indexOf('P1-REQUEST')).toBeGreaterThan(requests[1]!.indexOf('LONG-TOOL-RESULT'));
    expect(requests[1]).toContain('Pause the current work: record a one-line checkpoint of where you are (requirement stays open), handle this request/decision now, then resume the paused work.');
    // Documented exception to the 180 s bound: the P1 joined the moment the 4-min tool returned.
    expect(clock).toBe(240_000);
  });

  test('P1 never waited more than 180 s in any scenario of this suite', () => {
    expect(p1Waits.length).toBeGreaterThan(0);
    expect(Math.max(...p1Waits)).toBeLessThanOrEqual(180_000);
  });
});
