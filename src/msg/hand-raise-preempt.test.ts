// HAND-RAISE-LADDER preemption — a ✋ to a waiting seat ends its blocking wait early. Literals · fake clock · real temp ledger.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from '../commitment/ledger.js';
import { dispatchMsgAsk } from '../skills/tools/msg-ask.js';
import { handArrivedAfter, handPreemptLine } from './hand-raise-ladder.js';
import { MsgStore, type MessageEnvelope } from './msg-store.js';
import { armWaker, watchWaker, type SelfTimerDeps } from './self-timer-watch.js';

const root = mkdtempSync(join(tmpdir(), 'hand-preempt-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshStore = (): MsgStore => new MsgStore(join(root, `m${++n}.db`));

const handTo = (to: string): MessageEnvelope => ({ from: 'TC-H-CC-2', to, kind: 'request', intent: 'decision', correlationId: 'blk-p-1',
  body: '[✋ NEED HUMAN · TC-H-CC-2] PR #40050 merge conflict — which side wins?', refs: ['block:blk-p-1', 'seat:TC-H-CC-2', 'reason:HUMAN_DECISION'] });

test('watchWaker: a ✋ during a blocking wait-for returns early «✋ arrived: …»; the waker stays armed; polls ≤ 10s', async () => {
  let nowMs = Date.parse('2026-11-25T02:57:00.000Z');
  const sleeps: number[] = [];
  const events: string[] = [];
  const now = () => new Date(nowMs);
  const ledger = new CommitmentLedger({ root: join(root, 'ledger'), now, newId: () => 'c-1', emit: () => {} });
  const entry = ledger.add({ seat: 'TC', sessionId: 's1', text: 'TC-H-CX-7 및 MVP-B 후속 회신', evidence: '다음 스텝: TC-H-CX-7 및 MVP-B 후속 회신 대기.' }).entry;
  let asked = 0;
  const deps: SelfTimerDeps = {
    root: join(root, 'wakers'), ledger, now, newId: () => 'w-1', pid: 4242, isPidAlive: () => false,
    emit: (_c, event) => { events.push(event); },
    probes: { prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false },
    sleep: async (ms) => { sleeps.push(ms); nowMs += ms; },
    postNotice: async () => 1,
    preempt: () => (++asked >= 3 ? '✋ arrived: #161229 from TC-H-CC-2 — merge conflict' : null),
  };
  const armed = armWaker({ seat: 'TC', commitmentId: entry.id, condition: 'mail-reply:161100', withinMs: 30 * 60_000, cwd: root }, deps);
  const result = await watchWaker('TC', armed.waker.id, deps);
  expect(result.outcome).toBe('preempted');
  expect((result as { line: string }).line).toBe('✋ arrived: #161229 from TC-H-CC-2 — merge conflict');
  expect(result.waker.status).toBe('armed');
  expect(sleeps.length).toBe(2);
  expect(sleeps.every((ms) => ms <= 10_000)).toBe(true);
  expect(events).toContain('needhuman.preempted-wait');
});

test('handArrivedAfter: only a ✋ (block: ⊕ reason:) to this seat after the wait began; the preempt line literal', () => {
  const store = freshStore();
  try {
    const before = store.post(handTo('TC'));
    const startedAfter = before.id;
    store.post({ from: 'JUD', to: 'TC', body: 'plain mail is not a hand' });
    store.post(handTo('OP'));
    expect(handArrivedAfter(store, 'TC', startedAfter)).toBe(null);
    const hand = store.post(handTo('TC'));
    const found = handArrivedAfter(store, 'TC', startedAfter)!;
    expect(found.id).toBe(hand.id);
    expect(handPreemptLine(found)).toBe(`✋ arrived: #${hand.id} from TC-H-CC-2 — [✋ NEED HUMAN · TC-H-CC-2] PR #40050 merge conflict — which side wins? · give it one outcome first: eln msg hand ${hand.id} resolve|reject|escalate "<text>"`);
  } finally { store.close(); }
});

test('MsgAsk: a ✋ to the asking seat ends the wait early with the ✋ line (question kept)', async () => {
  const path = join(root, `ask-${++n}.db`);
  const side = new MsgStore(path);
  let mono = 0;
  let wall = Date.now();
  let posted = false;
  try {
    const result = await dispatchMsgAsk({ from: 'TC', to: 'TC-H-CX-7', question: 'Status of #40044?', waitSeconds: 60 }, {
      openStore: () => new MsgStore(path), monotonicNow: () => mono, wallNow: () => wall,
      sleep: async (ms) => { mono += Math.max(ms, 500); wall += Math.max(ms, 500); if (!posted) { posted = true; side.post(handTo('TC')); } },
    });
    expect(result.ok).toBe(false);
    expect(result.reply).toBe(null);
    expect(result.output.startsWith(`MsgAsk #${result.question.id} posted; ✋ arrived: #${result.question.id + 1} from TC-H-CC-2 — `)).toBe(true);
  } finally { side.close(); }
});
