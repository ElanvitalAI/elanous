// OP-INBOX-PULSE-BATCH sim — synthetic mail events on a fake clock against the REAL createQueueFinishFirst(opBatch).
// Flood of 100 mails (RES/TC/REL/UX/JUD-3/GRAPH-TRIGGER mix) · crown during a batch → immediate · release-stop →
// immediate · pulse missing → released at 30 min. Seeds ≥ 3; expectations are literals.
import { describe, expect, test } from 'bun:test';
import { createQueueFinishFirst, type QueueClassItem } from '../tui/queue-finish-first.js';

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const SENDERS = ['RES', 'TC', 'REL', 'UX', 'JUD-3', 'GRAPH-TRIGGER'] as const;
const INTENTS = [
  { mailClass: 'P1', mailIntent: 'request' }, { mailClass: 'P1', mailIntent: 'decision' },
  { mailClass: 'P2', mailIntent: 'info' }, { mailClass: 'P2', mailIntent: 'report' }, { mailClass: 'P2', mailIntent: 'coord' },
] as const;

function flood(seed: number, n: number, spanMs: number): QueueClassItem[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const sender = SENDERS[Math.floor(r() * SENDERS.length)]!;
    const at = Math.floor((i / n) * spanMs);
    if (sender === 'GRAPH-TRIGGER' && r() < 0.5) return { id: `m${i}`, text: `stall ${i}`, kind: 'notice', source: 'graph-node', enqueuedAt: at };
    const intent = INTENTS[Math.floor(r() * INTENTS.length)]!;
    return { id: `m${i}`, text: `${sender} ${i}`, kind: 'notice', source: 'seat-mail', enqueuedAt: at, ...intent };
  });
}

function run(seed: number) {
  let t = 0;
  const ff = createQueueFinishFirst({ now: () => t, opBatch: true });
  const queue: QueueClassItem[] = [];
  const events: string[] = [];
  const all = flood(seed, 100, 20 * 60_000);
  const crown: QueueClassItem = { id: 'crown', text: 'crown', kind: 'notice', source: 'seat-mail', mailClass: 'P0', enqueuedAt: 5 * 60_000 };
  const stop: QueueClassItem = { id: 'stop', text: 'stop', kind: 'notice', source: 'seat-mail', mailClass: 'P2', mailKind: 'release-stop', enqueuedAt: 9 * 60_000 };
  const timeline = [...all, crown, stop].sort((a, b) => a.enqueuedAt! - b.enqueuedAt!);
  let delivered = 0;
  let batches = 0;
  // Idle boundary every 30 s for 40 min; no pulse ever arrives.
  for (t = 0; t <= 40 * 60_000; t += 30_000) {
    while (timeline.length && timeline[0]!.enqueuedAt! <= t) queue.push(timeline.shift()!);
    const d = ff.decide(queue);
    if (d.kind === 'pass-unheld') {
      const heldIds = new Set(d.heldIds);
      const go = queue.filter((i) => !heldIds.has(i.id));
      for (const i of go) events.push(`${i.id}@${t}`);
      delivered += go.length;
      for (const i of go) queue.splice(queue.indexOf(i), 1);
    } else if (d.kind === 'release') {
      events.push(`batch:${d.reason}:${queue.length}@${t}`);
      batches += 1;
      delivered += queue.length;
      queue.length = 0;
    } else if (d.kind === 'deliver-p1') throw new Error('OP batch must not deliver P1 alone');
  }
  return { events, delivered, batches, left: queue.length };
}

describe('OP-INBOX-PULSE-BATCH sim (fake clock)', () => {
  for (const seed of [1, 7, 42, 1126]) {
    test(`seed ${seed}: 100-mail flood → crown & release-stop immediate, one batch at 30 min, nothing dropped`, () => {
      const out = run(seed);
      expect(out.events).toContain('crown@300000');
      expect(out.events).toContain('stop@540000');
      expect(out.events.filter((e) => e.startsWith('batch:'))).toEqual(['batch:starvation:100@1800000']);
      expect(out.batches).toBe(1);
      expect(out.delivered).toBe(102);
      expect(out.left).toBe(0);
    });
  }

  test('pulse during the batch releases everything held as ONE turn', () => {
    let t = 0;
    const ff = createQueueFinishFirst({ now: () => t, opBatch: true });
    const queue = flood(3, 100, 10 * 60_000);
    t = 10 * 60_000;
    expect(ff.decide(queue).kind).toBe('hold');
    ff.notePulse();
    expect(ff.decide(queue)).toEqual({ kind: 'release', reason: 'pulse' });
  });
});
