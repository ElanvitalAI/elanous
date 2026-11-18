import { describe, expect, test } from 'bun:test';
import {
  createNextTuiQueue, nextTuiPushNowDecision, NextTuiQueueConflictError,
  type NextTuiQueueDequeue,
} from './queue.js';

/** Collects `queue.*` events instead of writing them to the debug sink. */
function recordingQueue() {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const queue = createNextTuiQueue({ log: (event, data) => { events.push({ event, data }); } });
  return { queue, events, names: () => events.map((entry) => entry.event) };
}

function submitted(result: NextTuiQueueDequeue): { text: string; afterInterrupt: boolean } {
  if (result.kind !== 'submit') throw new Error('expected a submit');
  return { text: result.text, afterInterrupt: result.afterInterrupt };
}

describe('Next TUI busy-turn queue (fixed responses)', () => {
  test('submissions leave one per settled turn in FIFO order', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    const first = queue.enqueue('first');
    const help = queue.enqueue('/help');
    expect(queue.settle('draft')).toEqual({ kind: 'wake' });
    expect(queue.dequeue()).toEqual({ kind: 'submit', itemKind: 'user', id: first.id, text: 'first', remaining: 1, afterInterrupt: false });
    expect(queue.pendingTexts).toEqual(['/help']);
    expect(queue.settle('draft')).toEqual({ kind: 'wake' });
    expect(queue.dequeue()).toEqual({ kind: 'submit', itemKind: 'user', id: help.id, text: '/help', remaining: 0, afterInterrupt: false });
    expect(queue.settle('draft')).toEqual({ kind: 'none' });
  });

  test('A200: Esc with queued input auto-submits it as the next turn instead of restoring the draft', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    const first = queue.enqueue('first', 'steer-1');
    const second = queue.enqueue('second');
    queue.markInterrupted();
    // The draft is left alone: queued text never lands in the prompt.
    expect(queue.settle('')).toEqual({ kind: 'resubmit', count: 2 });
    expect(queue.steerCount).toBe(0);
    expect(queue.dequeue()).toEqual({ kind: 'submit', itemKind: 'user', id: first.id, text: 'first', remaining: 1, afterInterrupt: true });
    // Only the first turn after the cancel carries the interrupted-on-purpose line.
    expect(queue.dequeue()).toEqual({ kind: 'submit', itemKind: 'user', id: second.id, text: 'second', remaining: 0, afterInterrupt: false });
    expect(queue.settle('')).toEqual({ kind: 'none' });
  });

  test('A200: a steer the child applied leaves the queue; an unapplied one stays for the next turn', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueue('steer applied', 'steer-1');
    const carried = queue.enqueue('steer carried', 'steer-2');
    queue.enqueue('/help');
    expect(queue.steerIds).toEqual(['steer-1', 'steer-2']);
    expect(queue.markSteered(['steer-1'])).toBe(1);
    expect(queue.pendingTexts).toEqual(['steer carried', '/help']);
    expect(queue.settle('')).toEqual({ kind: 'wake' });
    expect(queue.dequeue()).toEqual({ kind: 'submit', itemKind: 'user', id: carried.id, text: 'steer carried', remaining: 1, afterInterrupt: false });
  });

  test('an empty interrupted queue does not replace the draft', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.markInterrupted();
    expect(queue.settle('draft')).toEqual({ kind: 'none' });
    expect(queue.interrupted).toBe(false);
  });

  test('Ctrl+Up recalls all queued submissions in order ahead of the unsent draft', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueue('first');
    queue.enqueue('second');
    expect(queue.recall('draft')).toEqual({ text: 'first\nsecond\ndraft', count: 2, steerIds: [] });
    expect(queue.count).toBe(0);
    expect(queue.settle('first\nsecond\ndraft')).toEqual({ kind: 'none' });
  });
});

describe('ELN-QUEUE-ITEM-STATE — item lifecycle (CONDUCTOR §6)', () => {
  test('each item carries id · seq · delivery · status; ids are unique', () => {
    const { queue, events } = recordingQueue();
    const chat = queue.enqueue('chat line', 'steer-1');
    const slash = queue.enqueue('/help');
    expect(chat).toMatchObject({ delivery: 'steer', status: 'queued', text: 'chat line', steerId: 'steer-1' });
    expect(slash).toMatchObject({ delivery: 'queue', status: 'queued', text: '/help' });
    expect(chat.id).not.toBe(slash.id);
    expect(queue.items.map((item) => item.id)).toEqual([chat.id, slash.id]);
    expect(events.filter((entry) => entry.event === 'enqueued').map((entry) => entry.data.id)).toEqual([chat.id, slash.id]);
    // Observation carries length, never the typed text.
    expect(JSON.stringify(events)).not.toContain('chat line');
  });

  test('invariant 1: seq rises monotonically and is never renumbered by cancel/supersede/deliver', () => {
    const { queue } = recordingQueue();
    const a = queue.enqueue('a');
    const b = queue.enqueue('b');
    queue.cancel(a.id);
    const c = queue.enqueue('c');
    queue.supersede(b.id, c.id);
    queue.dequeue();
    const d = queue.enqueue('d');
    const seqs = [a, b, c, d].map((item) => item.seq);
    expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)).toBe(true);
    expect(queue.get(b.id)?.seq).toBe(b.seq);
    expect(queue.get(c.id)?.seq).toBe(c.seq);
  });

  test('invariant 1: at one boundary steer is consumed before queue, seq order inside one delivery', () => {
    const { queue } = recordingQueue();
    const slashFirst = queue.enqueue('/help');
    const steerA = queue.enqueue('steer a', 'steer-a');
    const shell = queue.enqueue('!ls');
    const steerB = queue.enqueue('steer b', 'steer-b');
    const order: string[] = [];
    for (let next = queue.dequeue(); next.kind === 'submit'; next = queue.dequeue()) order.push(next.id);
    expect(order).toEqual([steerA.id, steerB.id, slashFirst.id, shell.id]);
  });

  test('invariant 2: an item is delivered once — any op on a consumed item is a conflict and changes nothing', () => {
    const { queue, names } = recordingQueue();
    const steer = queue.enqueue('steer', 'steer-1');
    const waiting = queue.enqueue('waiting');
    expect(queue.markSteered(['steer-1'])).toBe(1);
    expect(queue.get(steer.id)?.status).toBe('delivered');
    // A duplicate child confirmation does not deliver again (reported, not thrown — it comes from IPC).
    expect(queue.markSteered(['steer-1'])).toBe(0);
    expect(names()).toContain('conflict');
    expect(() => queue.cancel(steer.id)).toThrow(NextTuiQueueConflictError);
    expect(() => queue.supersede(steer.id, waiting.id)).toThrow(NextTuiQueueConflictError);
    expect(queue.get(steer.id)?.status).toBe('delivered');

    const handoff = queue.dequeue();
    expect(handoff.kind === 'submit' && handoff.id).toBe(waiting.id);
    expect(queue.dequeue()).toEqual({ kind: 'none' });
    expect(() => queue.cancel(waiting.id)).toThrow(NextTuiQueueConflictError);
    expect(queue.get(waiting.id)?.status).toBe('delivered');
    expect(() => queue.cancel('never-enqueued')).toThrow(NextTuiQueueConflictError);
  });

  test('invariant 2: the conflict error names the item, the op and the status it found', () => {
    const { queue } = recordingQueue();
    const item = queue.enqueue('x');
    queue.cancel(item.id);
    let caught: unknown;
    try { queue.supersede(item.id, item.id); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NextTuiQueueConflictError);
    expect(caught).toMatchObject({ code: 'queue-lifecycle-conflict', itemId: item.id, op: 'supersede', status: 'cancelled' });
  });

  test('invariant 4: Esc keeps pending items queued, resubmits them in seq order, only the first carries the line', () => {
    const { queue, names } = recordingQueue();
    const queuedFirst = queue.enqueue('/help');
    const steer = queue.enqueue('steer', 'steer-1');
    const plain = queue.enqueue('plain');
    queue.markInterrupted();
    const settled = queue.settle('my draft');
    expect(settled.kind).toBe('resubmit');
    expect(queue.items.every((item) => item.status === 'queued')).toBe(true);
    // The dead child's steer leaves as plain input, so seq order holds across the whole resubmit.
    expect(queue.get(steer.id)?.delivery).toBe('queue');
    expect(names()).toContain('delivery-changed');
    const out = [submitted(queue.dequeue()), submitted(queue.dequeue()), submitted(queue.dequeue())];
    expect(out.map((entry) => entry.text)).toEqual([queuedFirst.text, steer.text, plain.text]);
    expect(out.filter((entry) => entry.afterInterrupt).map((entry) => entry.text)).toEqual([queuedFirst.text]);
  });

  test('transitions: queued → cancelled · queued → superseded keep the original text; recall cancels as recalled', () => {
    const { queue, events } = recordingQueue();
    const old = queue.enqueue('PR 1 착지');
    const fix = queue.enqueue('PR 1 착지 말고 보류');
    const gone = queue.enqueue('drop me');
    expect(queue.supersede(old.id, fix.id)).toMatchObject({ status: 'superseded', supersededBy: fix.id, text: old.text });
    expect(queue.cancel(gone.id)).toMatchObject({ status: 'cancelled', text: gone.text });
    expect(queue.items.map((item) => item.id)).toEqual([fix.id]);
    expect(queue.recall('')?.text).toBe(fix.text);
    expect(queue.get(fix.id)?.status).toBe('cancelled');
    expect(events.find((entry) => entry.event === 'superseded')?.data).toMatchObject({ id: old.id, by: fix.id });
    expect(events.filter((entry) => entry.event === 'cancelled').map((entry) => entry.data.reason)).toEqual(['user', 'recalled']);
  });

  test('supersede needs a known successor other than the item itself', () => {
    const { queue } = recordingQueue();
    const item = queue.enqueue('x');
    expect(() => queue.supersede(item.id, item.id)).toThrow(NextTuiQueueConflictError);
    expect(() => queue.supersede(item.id, 'missing')).toThrow(NextTuiQueueConflictError);
    expect(queue.get(item.id)?.status).toBe('queued');
  });

  test('delivered events name the boundary: tool-result for applied steers, idle for dequeue', () => {
    const { queue, events } = recordingQueue();
    const steer = queue.enqueue('s', 'steer-1');
    const idle = queue.enqueue('q');
    queue.markSteered(['steer-1']);
    queue.dequeue();
    const delivered = events.filter((entry) => entry.event === 'delivered').map((entry) => [entry.data.id, entry.data.boundary]);
    expect(delivered).toEqual([[steer.id, 'tool-result'], [idle.id, 'idle']]);
  });
});

describe('ELN-QUEUE-ITEM-STATE — CROWN addendum B·C (kind · drain · invariants 7·10)', () => {
  test('kind order: user before notice; inside one kind steer before queue, then seq', () => {
    const { queue } = recordingQueue();
    const mail = queue.enqueueNotice('seat mail arrived', 'seat-mail');
    const userQueued = queue.enqueue('/help');
    const child = queue.enqueueNotice('harness child finished', 'harness-child');
    const userSteer = queue.enqueue('steer', 'steer-1');
    const userLater = queue.enqueue('!ls');
    expect(mail).toMatchObject({ kind: 'notice', source: 'seat-mail', delivery: 'queue', status: 'queued' });
    expect(userQueued).toMatchObject({ kind: 'user', mode: 'command' });
    const order: string[] = [];
    for (let next = queue.dequeue(); next.kind === 'submit'; next = queue.dequeue()) order.push(next.id);
    expect(order).toEqual([userSteer.id, userQueued.id, userLater.id, mail.id, child.id]);
  });

  test('CAPSULE-C2-FU: peekKind reads the dequeue head kind without taking it', () => {
    const { queue } = recordingQueue();
    expect(queue.peekKind()).toBeNull();
    queue.enqueueNotice('seat mail arrived', 'seat-mail');
    expect(queue.peekKind()).toBe('notice');
    queue.enqueue('line A');
    expect(queue.peekKind()).toBe('user');
    expect(queue.count).toBe(2);
    expect(queue.dequeue()).toMatchObject({ kind: 'submit', itemKind: 'user', text: 'line A' });
    expect(queue.peekKind()).toBe('notice');
  });

  test('drain hands each utterance back as its own message — texts are never merged', () => {
    const { queue } = recordingQueue();
    const texts = ['first line', 'second line', 'third line'];
    const ids = texts.map((text) => queue.enqueue(text).id);
    const drained = queue.drain();
    if (drained.kind !== 'batch') throw new Error('expected a batch');
    expect(drained.items.map((item) => item.id)).toEqual(ids);
    expect(drained.items.map((item) => item.text)).toEqual(texts);
    expect(drained.items.every((item) => texts.includes(item.text))).toBe(true);
    expect(ids.every((id) => queue.get(id)?.status === 'delivered')).toBe(true);
    expect(queue.drain()).toEqual({ kind: 'none' });
  });

  test('drain: a mode boundary (slash · shell) or a kind change ends the batch; commands travel alone', () => {
    const { queue } = recordingQueue();
    const a = queue.enqueue('chat a');
    const b = queue.enqueue('chat b');
    const help = queue.enqueue('/help');
    const status = queue.enqueue('/status');
    const shell = queue.enqueue('!ls');
    const c = queue.enqueue('chat c');
    const notice = queue.enqueueNotice('sidetab result', 'sidetab');
    const batches: { mode: string; ids: string[] }[] = [];
    for (let next = queue.drain(); next.kind === 'batch'; next = queue.drain()) {
      expect(next.items.every((item) => item.kind === next.itemKind)).toBe(true);
      batches.push({ mode: next.mode, ids: next.items.map((item) => item.id) });
    }
    expect(batches).toEqual([
      { mode: 'chat', ids: [a.id, b.id] },
      { mode: 'command', ids: [help.id] },
      { mode: 'command', ids: [status.id] },
      { mode: 'shell', ids: [shell.id] },
      { mode: 'chat', ids: [c.id] },
      { mode: 'chat', ids: [notice.id] },
    ]);
  });

  test('invariant 7: enqueue never interrupts, cancels or supersedes anything', () => {
    const { queue, names } = recordingQueue();
    const before = queue.enqueue('keep going', 'steer-1');
    queue.enqueue('대신 이걸로 바꿔', 'steer-2');
    queue.enqueue('/help');
    queue.enqueueNotice('seat mail arrived', 'seat-mail');
    expect(queue.interrupted).toBe(false);
    expect(queue.items.every((item) => item.status === 'queued')).toBe(true);
    expect(queue.get(before.id)?.status).toBe('queued');
    expect(names().every((name) => name === 'enqueued')).toBe(true);
    expect(queue.settle('')).toEqual({ kind: 'wake' });
  });

  test('invariant 10: superseded only through the explicit API — a replacement candidate is a hint', () => {
    const { queue, names } = recordingQueue();
    const old = queue.enqueue('PR 1 착지해');
    const correction = queue.enqueue('PR 1 착지 말고 보류해');
    // Enqueueing a correction on the same target changes nothing by itself.
    expect(queue.get(old.id)?.status).toBe('queued');
    expect(queue.noteReplacementCandidate(correction.id, old.id)).toMatchObject({ replacementCandidateFor: old.id, status: 'queued' });
    expect(queue.get(old.id)?.status).toBe('queued');
    expect(names()).not.toContain('superseded');
    queue.supersede(old.id, correction.id);
    expect(queue.get(old.id)).toMatchObject({ status: 'superseded', supersededBy: correction.id, text: old.text });
    expect(names().filter((name) => name === 'superseded')).toEqual(['superseded']);
  });

  test('Esc: the interrupted-on-purpose line goes to the first item resubmitted, not to an earlier notice', () => {
    const { queue } = recordingQueue();
    queue.enqueueNotice('harness child finished', 'harness-child');
    const user = queue.enqueue('next step');
    queue.markInterrupted();
    expect(queue.settle('').kind).toBe('resubmit');
    const first = queue.dequeue();
    expect(first.kind === 'submit' && [first.id, first.afterInterrupt]).toEqual([user.id, true]);
    const second = queue.dequeue();
    expect(second.kind === 'submit' && second.afterInterrupt).toBe(false);
  });

  test('recall takes user utterances only; notices stay queued', () => {
    const { queue } = recordingQueue();
    const notice = queue.enqueueNotice('seat mail arrived', 'seat-mail');
    queue.enqueue('mine');
    expect(queue.recall('')?.text).toBe('mine');
    expect(queue.items.map((item) => item.id)).toEqual([notice.id]);
  });
});

test('push-now defers while any tool is active, including non-shell tools', () => {
  expect(nextTuiPushNowDecision([])).toBe('interrupt');
  expect(nextTuiPushNowDecision(['Bash'])).toBe('deferred');
  // Read/search tools are the interruptible class; their being cut short loses nothing.
  expect(nextTuiPushNowDecision(['Read'])).toBe('interrupt');
  expect(nextTuiPushNowDecision(['Grep', 'Glob', 'ListDir', 'WebSearch', 'WebFetch'])).toBe('interrupt');
  expect(nextTuiPushNowDecision(['Agent'])).toBe('deferred');
  expect(nextTuiPushNowDecision(['Read', 'Bash'])).toBe('deferred');
  // Writes, push, missions and unknown tools finish; one non-interruptible tool among reads defers the whole set.
  for (const name of ['Write', 'Edit', 'MultiEdit', 'RunShell', 'git_push', 'NextSidetab', 'SomethingNew']) {
    expect(nextTuiPushNowDecision([name])).toBe('deferred');
    expect(nextTuiPushNowDecision(['Read', name])).toBe('deferred');
  }
});

describe('ELN-QUEUE-SUPERSEDE — enqueue records a «대체 후보» hint only', () => {
  test('same PR + correction word: hint on the new item, both stay queued, one candidate event', () => {
    const { queue, events } = recordingQueue();
    const old = queue.enqueue('#38026 착지해');
    const correction = queue.enqueue('#38026 말고 #38030 으로 올려');
    expect(correction).toMatchObject({ status: 'queued', replacementCandidateFor: old.id, text: '#38026 말고 #38030 으로 올려' });
    expect(queue.get(old.id)).toMatchObject({ status: 'queued', text: '#38026 착지해' });
    expect(queue.replacementCandidate(correction.id)).toMatchObject({ candidateFor: old.id, targets: ['#38026'] });
    expect(events.filter((entry) => entry.event === 'replacement-candidate').map((entry) => entry.data))
      .toEqual([{ id: correction.id, seq: correction.seq, candidateFor: old.id, targets: ['#38026'], correctionWord: '말고' }]);
  });

  test('different targets or no correction word → nothing recorded', () => {
    const { queue, names } = recordingQueue();
    queue.enqueue('#1 착지해');
    const other = queue.enqueue('#2 말고 #3');
    const plain = queue.enqueue('#1 리뷰도 봐줘');
    expect(queue.get(other.id)?.replacementCandidateFor).toBeUndefined();
    expect(queue.get(plain.id)?.replacementCandidateFor).toBeUndefined();
    expect(names()).not.toContain('replacement-candidate');
  });

  test('a delivered item is never a candidate', () => {
    const { queue, names } = recordingQueue();
    queue.enqueue('ELN-QUEUE-SUPERSEDE 시작');
    queue.dequeue();
    expect(queue.previewReplacementCandidate('ELN-QUEUE-SUPERSEDE 취소')).toEqual({ kind: 'none', reason: 'no-overlap' });
    const late = queue.enqueue('ELN-QUEUE-SUPERSEDE 는 보류');
    expect(queue.replacementCandidate(late.id)).toBeUndefined();
    expect(names()).not.toContain('replacement-candidate');
  });

  test('preview matches what enqueue then records (steer path builds its context line first)', () => {
    const { queue } = recordingQueue();
    const old = queue.enqueue('src/tui/core/queue.ts 수정');
    const preview = queue.previewReplacementCandidate('src/tui/core/queue.ts 고쳐서 다시');
    const correction = queue.enqueue('src/tui/core/queue.ts 고쳐서 다시', 'steer-1');
    expect(preview).toEqual(queue.replacementCandidate(correction.id)!);
    expect(queue.get(old.id)?.status).toBe('queued');
  });

  test('invariant 10: explicit supersede() is still the only status change', () => {
    const { queue, names } = recordingQueue();
    const old = queue.enqueue('#38026 착지해');
    const correction = queue.enqueue('#38026 취소');
    expect(queue.items.map((item) => item.status)).toEqual(['queued', 'queued']);
    expect(names()).not.toContain('superseded');
    queue.supersede(old.id, correction.id);
    expect(queue.get(old.id)).toMatchObject({ status: 'superseded', supersededBy: correction.id, text: '#38026 착지해' });
    expect(names().filter((name) => name === 'superseded')).toEqual(['superseded']);
  });

  test('invariant 7: a correction enqueue interrupts and cancels nothing', () => {
    const { queue, names } = recordingQueue();
    queue.enqueue('#38026 착지해', 'steer-1');
    queue.enqueue('#38026 보류', 'steer-2');
    expect(queue.interrupted).toBe(false);
    expect(queue.items.every((item) => item.status === 'queued')).toBe(true);
    expect(names().every((name) => name === 'enqueued' || name === 'replacement-candidate')).toBe(true);
    expect(queue.settle('')).toEqual({ kind: 'wake' });
  });

  test('sim — 11-17 OP burst (ISSUES.md 01:3x·01:5x: #37983 matcher fix, duplicate #37992/#37995)', () => {
    const { queue, names } = recordingQueue();
    const matcher = queue.enqueue('#37983 toBeoneOf 매처 수리 → 새 head 로 OP 우편');
    const ping = queue.enqueue('운영 루트 openai-codex REPL 1분마다 상태 — 한 줄 회신');
    const diff = queue.enqueue('ELN-DIFF-RENDER 칸은 #37992 로 이어서 올려');
    const dedupe = queue.enqueue('#37992 말고 #37995 하나로 가 — 중복 PR 은 닫아');
    expect([matcher, ping, diff].map((item) => queue.get(item.id)?.replacementCandidateFor)).toEqual([undefined, undefined, undefined]);
    expect(queue.get(dedupe.id)?.replacementCandidateFor).toBe(diff.id);
    expect(queue.items.every((item) => item.status === 'queued')).toBe(true);
    expect(queue.items.map((item) => item.text)).toEqual([matcher.text, ping.text, diff.text, dedupe.text]);
    expect(names().filter((name) => name === 'replacement-candidate')).toEqual(['replacement-candidate']);
  });
});

test('ELN-CANCEL-RESTORE-RULE Esc table: queued input resubmits · empty queue and no response restores the sent text · otherwise nothing', () => {
  const sent = { text: '방금 보낸 원문', responded: false };
  // 1) something is waiting → it leaves as the next turn by itself; the original is not pushed back to the prompt.
  const waiting = createNextTuiQueue();
  waiting.enqueue('이어서 할 말');
  waiting.markInterrupted();
  const waitingCount = waiting.count;
  expect(waiting.settle('', sent)).toEqual({ kind: 'resubmit', count: waitingCount });
  // 2) nothing waits and nothing answered → give the sent text back.
  const silent = createNextTuiQueue();
  silent.markInterrupted();
  expect(silent.settle('', sent)).toEqual({ kind: 'restore-original', text: sent.text });
  // 3) nothing waits but the turn did answer (reply text or tool activity) → nothing to restore.
  const answered = createNextTuiQueue();
  answered.markInterrupted();
  expect(answered.settle('', { ...sent, responded: true })).toEqual({ kind: 'none' });
  // No Esc, no turn info (internal turn), blank text → never restores.
  const plain = createNextTuiQueue();
  expect(plain.settle('', sent)).toEqual({ kind: 'none' });
  const internal = createNextTuiQueue();
  internal.markInterrupted();
  expect(internal.settle('')).toEqual({ kind: 'none' });
  const blank = createNextTuiQueue();
  blank.markInterrupted();
  expect(blank.settle('', { text: '   ', responded: false })).toEqual({ kind: 'none' });
});

test('ELN-QUEUE-ITEM-CONTROLS: changeDelivery moves a waiting item between steer and queue and logs it', () => {
  const { queue, events } = recordingQueue();
  const chat = queue.enqueue('조향으로 보낸 말', 'steer-a');
  const command = queue.enqueue('/status');
  const moved = queue.changeDelivery(chat.id, 'queue');
  expect(moved.delivery).toBe('queue');
  expect(moved.steerId).toBeUndefined();
  expect(queue.steerCount).toBe(0);
  expect(queue.changeDelivery(chat.id, 'steer', 'steer-b')).toMatchObject({ delivery: 'steer', steerId: 'steer-b' });
  expect(queue.steerIds).toEqual(['steer-b']);
  expect(events.filter((entry) => entry.event === 'delivery-changed').map((entry) => [entry.data.from, entry.data.to]))
    .toEqual([['steer', 'queue'], ['queue', 'steer']]);
  // Commands wait for idle; a steer without a child handle is refused; status never changes on refusal.
  expect(() => queue.changeDelivery(command.id, 'steer', 'steer-c')).toThrow(NextTuiQueueConflictError);
  expect(() => queue.changeDelivery(chat.id, 'steer')).toThrow(NextTuiQueueConflictError);
  expect(queue.get(command.id)?.delivery).toBe('queue');
  // Invariant 2: a cancelled item cannot be moved again.
  queue.cancel(chat.id, 'edited');
  expect(() => queue.changeDelivery(chat.id, 'queue')).toThrow(NextTuiQueueConflictError);
  expect(queue.get(chat.id)?.status).toBe('cancelled');
});
