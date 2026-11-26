// OP-WAKE-COMMIT-BATCH sim (대표 11-26 04:5x «예약 깨움 묶음 · 6건 + 깨우개 발화 ×4 in one turn») — synthetic events on a
// fake clock against the REAL next-TUI wakeup factory (scheduler + door), the REAL OP queue batch (createQueueFinishFirst
// opBatch) and the REAL commitment ledger + wakers behind the pulse digest. Seeds ≥ 3; expectations are literals.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext } from '../plugins/core/types.js';
import { CommitmentLedger } from '../commitment/ledger.js';
import { armWaker, evaluateWaker, type SelfTimerDeps } from '../msg/self-timer-watch.js';
import { classifyDigest, formatPulseDigest, readPulseDigest } from '../op-control/pulse-digest.js';
import { createNextTuiWakeup } from '../tui-client/next-wakeup.js';
import { classifyOpBatchItem, createQueueFinishFirst, type QueueClassItem } from '../tui/queue-finish-first.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

function fakeTimers(start = Date.UTC(2026, 10, 25, 20, 0, 0)) {
  let now = start; let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
    },
  };
}

describe('OP-WAKE-COMMIT-BATCH — scheduled wakes ride the pulse', () => {
  test('a flood of 30 due wakes on the OP seat opens 0 turns: 30 held for the pulse', async () => {
    const clock = fakeTimers();
    const held: string[] = [];
    const w = createNextTuiWakeup({ isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0, requestYield: () => true,
      notify: () => {}, env: {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, lastHumanKeyAt: () => 0, pendingKeyCount: () => 0,
      log: () => {}, holdScheduledWake: (text) => { held.push(text); return true; } });
    w.gate.noteHumanTurn();
    // 10 schedule calls per turn (the per-turn call cap is 12) · 20 slots — three waves of 10, each delivered before the next.
    for (let wave = 0; wave < 3; wave++) {
      w.gate.noteHumanTurn();
      for (let i = wave * 10; i < wave * 10 + 10; i++) {
        const res = await w.tool!.handler({ action: 'schedule', delaySeconds: 60 + i * 7, reason: `check ${i}` }, {} as PluginContext) as { scheduled?: unknown; error?: string };
        expect(res.error).toBeUndefined();
      }
      clock.advance(10 * 60_000);
    }
    expect(w.gate.takePending()).toBeNull();
    // Every one of the 30 wakes is in a held text (past-due companions fold into one digest text); none is left armed.
    const ids = held.flatMap((h) => [...h.matchAll(/^- (w\d+)@/gmu)].map((m) => m[1]));
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    expect(w.scheduler.list().length).toBe(0);
    expect(held[0]).toContain('check 0');
    w.dispose();
  });

  test('without the hold (non-OP seat) the same due wake opens its turn as before', async () => {
    const clock = fakeTimers();
    const w = createNextTuiWakeup({ isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0, requestYield: () => true,
      notify: () => {}, env: {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, lastHumanKeyAt: () => 0, pendingKeyCount: () => 0, log: () => {} });
    w.gate.noteHumanTurn();
    await w.tool!.handler({ action: 'schedule', delaySeconds: 60, reason: 'plain seat' }, {} as PluginContext);
    clock.advance(61_000);
    expect(w.gate.takePending()?.input).toContain('plain seat');
    w.dispose();
  });

  test('classification: a scheduled wake and a waker notice wait (P2); crown and release-stop stay P0', () => {
    expect(classifyOpBatchItem({ id: 'a', text: 'x', kind: 'notice', source: 'scheduled-wake' })).toBe('P2');
    expect(classifyOpBatchItem({ id: 'b', text: 'x', kind: 'notice', source: 'seat-mail', mailClass: 'P1', mailKind: 'notice' })).toBe('P2');
    expect(classifyOpBatchItem({ id: 'c', text: 'x', kind: 'notice', source: 'seat-mail', mailClass: 'P0' })).toBe('P0');
    expect(classifyOpBatchItem({ id: 'd', text: 'x', kind: 'notice', source: 'seat-mail', mailClass: 'P2', mailKind: 'release-stop' })).toBe('P0');
    expect(classifyOpBatchItem({ id: 'e', text: 'x', kind: 'notice', source: 'ceo-ingress' })).toBe('P0');
  });

  for (const seed of [5, 17, 101]) {
    test(`seed ${seed}: 30 wakes + waker notices → one batch at the pulse; a crown mid-batch goes alone and at once`, () => {
      let t = 0;
      const ff = createQueueFinishFirst({ now: () => t, opBatch: true });
      const r = rng(seed);
      const items: QueueClassItem[] = Array.from({ length: 30 }, (_, i) => (r() < 0.5
        ? { id: `w${i}`, text: `wake ${i}`, kind: 'notice', source: 'scheduled-wake', enqueuedAt: i * 20_000 }
        : { id: `n${i}`, text: `⏰ 깨우개 발화 ${i}`, kind: 'notice', source: 'seat-mail', mailClass: 'P1', mailKind: 'notice', enqueuedAt: i * 20_000 }) as QueueClassItem);
      const crown: QueueClassItem = { id: 'crown', text: 'crown', kind: 'notice', source: 'seat-mail', mailClass: 'P0', enqueuedAt: 4 * 60_000 };
      const timeline = [...items, crown].sort((a, b) => a.enqueuedAt! - b.enqueuedAt!);
      const queue: QueueClassItem[] = [];
      const turns: string[] = [];
      for (t = 0; t <= 12 * 60_000; t += 10_000) {
        while (timeline.length && timeline[0]!.enqueuedAt! <= t) queue.push(timeline.shift()!);
        if (t === 11 * 60_000) ff.notePulse();
        const d = ff.decide(queue);
        if (d.kind === 'pass-unheld') {
          const keep = new Set(d.heldIds);
          const go = queue.filter((i) => !keep.has(i.id));
          turns.push(`unheld:${go.map((i) => i.id).join(',')}@${t}`);
          for (const i of go) queue.splice(queue.indexOf(i), 1);
        } else if (d.kind === 'release') {
          turns.push(`batch:${d.reason}:${queue.length}@${t}`);
          queue.length = 0;
        }
      }
      expect(turns).toEqual(['unheld:crown@240000', 'batch:pulse:30@660000']);
    });
  }

  test('a missed pulse: the batch still goes at the 30-minute max hold', () => {
    let t = 0;
    const ff = createQueueFinishFirst({ now: () => t, opBatch: true });
    const queue: QueueClassItem[] = [{ id: 'w0', text: 'wake', kind: 'notice', source: 'scheduled-wake', enqueuedAt: 0 }];
    const out: string[] = [];
    for (t = 0; t <= 31 * 60_000; t += 60_000) {
      const d = ff.decide(queue);
      if (d.kind === 'release') { out.push(`${d.reason}@${t / 60_000}m`); queue.length = 0; }
    }
    expect(out).toEqual(['starvation@30m']);
  });
});

describe('OP-WAKE-COMMIT-BATCH — pulse digest from facts', () => {
  test('done · overdue · needs action are pre-evaluated from the ledger and wakers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'op-pulse-digest-'));
    roots.push(root);
    let nowMs = Date.parse('2026-11-25T20:00:00.000Z');
    let cid = 0; let wid = 0;
    const now = () => new Date(nowMs);
    const ledger = new CommitmentLedger({ root: join(root, 'l'), now, newId: () => `c-${++cid}`, emit: () => {} });
    const cells: Record<string, string> = { A1: 'green', B2: 'yellow', C3: 'green' };
    const timer: SelfTimerDeps = { root: join(root, 'l', 'wakers'), ledger, now, newId: () => `w-${++wid}`, emit: () => {},
      probes: { prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false,
        cellStatus: async (c) => ({ status: cells[c] ?? 'red' }) },
      postNotice: async () => 1, isPidAlive: () => false, waitContract: null, trigger: null };
    const add = (text: string, cond: string, autoClose: boolean) => {
      const e = ledger.add({ seat: 'OP', sessionId: `s-${text}`, text, evidence: 'MsgPost' }).entry;
      armWaker({ seat: 'OP', commitmentId: e.id, condition: cond, withinMs: 30 * 60_000, ...(autoClose ? { autoClose: true } : {}) }, timer);
      return e;
    };
    add('land A1', 'cell-status:A1=green', true);   // holds → auto-closed done
    add('land B2', 'cell-status:B2=green', true);   // fails past check-at → overdue
    add('review C3', 'cell-status:C3=green', false); // holds, no auto-close → needs action
    const since = nowMs - 1;
    for (const w of ['w-1', 'w-3']) await evaluateWaker('OP', w, timer);
    nowMs += 31 * 60_000;
    const text = readPulseDigest('OP', since, 2, { ledger, timer, now: () => nowMs });
    expect(text).toBe([
      '[Pulse digest · done 1 · overdue 1 · needs action 1 · scheduled wakes 2] Outcomes are pre-evaluated from facts — act on overdue and needs-action only; done needs no reply.',
      '✅ Done (1)',
      '  - c-1 «land A1» · cell-status:A1=green · watch cell-status:A1=green: cell A1 status=green',
      '⏰ Overdue (1)',
      `  - c-2 «land B2» · cell-status:B2=green · not met by ${new Date('2026-11-25T20:30:00.000Z').getHours().toString().padStart(2, '0')}:30`,
      '▶ Needs action (1)',
      '  - c-3 «review C3» · cell-status:C3=green · condition held — continue or close',
      'Close an overdue commitment as reassigned or blocked with a reason when its outcome will not come; «request sent» or a reply is not done.',
    ].join('\n'));
  });

  test('facts missing (unreadable ledger) → the digest still names the wakes; nothing at all → no digest', () => {
    expect(readPulseDigest('OP', 0, 3, { ledger: { list: () => { throw new Error('locked'); } } as unknown as CommitmentLedger }))
      .toBe('[Pulse digest · done 0 · overdue 0 · needs action 0 · scheduled wakes 3] Outcomes are pre-evaluated from facts — act on overdue and needs-action only; done needs no reply.\nClose an overdue commitment as reassigned or blocked with a reason when its outcome will not come; «request sent» or a reply is not done.');
    expect(formatPulseDigest(classifyDigest([], [], 0, 0), 0)).toBeNull();
  });
});
