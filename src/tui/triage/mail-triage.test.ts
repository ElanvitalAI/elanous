import { describe, expect, test } from 'bun:test';
import {
  classifyMailStructured,
  createMailTriageLedger,
  mailTriageInputOf,
  mailTriageKey,
  type MailTriageInput,
} from './mail-triage.js';

const mail = (msgId: number, fields: Partial<MailTriageInput> = {}): MailTriageInput => ({ msgId, from: 'TC', ...fields });

describe('MAIL-TRIAGE classification table (structured fields only)', () => {
  const rows: Array<[string, Partial<MailTriageInput>, boolean, 'A' | 'B' | 'C' | 'D' | 'E' | null]> = [
    ['crown directive', { kind: 'info', crownDirective: 'ship it today' }, false, 'E'],
    ['crown delegation', { kind: 'request', origin: { kind: 'agent', delegatedByCrown: true } }, false, 'E'],
    ['needs-human block ref', { kind: 'request', intent: 'decision', refs: ['block:b-77'] }, false, 'A'],
    ['decision intent', { kind: 'coord', intent: 'decision' }, false, 'A'],
    ['question kind', { kind: 'question' }, false, 'A'],
    ['decision kind (answer-expected)', { kind: 'decision' }, false, 'A'],
    ['HandRaise ✋ (block + reason refs)', { kind: 'request', refs: ['block:b-2', 'reason:waiting-person'] }, false, 'A'],
    ['request intent', { kind: 'coord', intent: 'request' }, false, 'B'],
    ['alert kind', { kind: 'alert' }, false, 'B'],
    ['done-condition only', { doneWhen: 'PR merged' }, false, 'B'],
    ['deadline only', { deadlineAt: '2026-11-25T12:00:00Z' }, false, 'B'],
    ['announce', { kind: 'announce', refs: ['announce:ann-1'] }, false, 'C'],
    ['coordination report', { kind: 'coord' }, false, 'C'],
    ['status on a new subject', { kind: 'status' }, false, 'C'],
    ['status on an open subject', { kind: 'status' }, true, 'D'],
    ['supersedes', { kind: 'request', supersedes: 9 }, false, 'D'],
    ['result envelope', { kind: 'coord', resultState: 'done' }, false, 'D'],
    ['request kind on an open subject stays an action', { kind: 'request' }, true, 'B'],
    ['kind-less, intent info by ledger default', { intent: 'info' }, false, null],
    ['nothing structured', {}, false, null],
  ];
  for (const [name, fields, open, expected] of rows) {
    test(name, () => { expect(classifyMailStructured(mail(1, fields), open)).toBe(expected); });
  }
  test('the body is never read: an urgent-looking body with no fields has no class', () => {
    expect(classifyMailStructured(mail(2, { body: '🔴 URGENT decision needed: please answer PR #40036' }))).toBe(null);
  });
});

describe('MAIL-TRIAGE keys', () => {
  test('pr ref wins, then cell, block, announce, correlation, thread, msg', () => {
    expect(mailTriageKey(mail(5, { refs: ['cell:mail-triage-taskqueue', 'pr:40036'] }))).toBe('pr:40036');
    expect(mailTriageKey(mail(5, { refs: ['PR#40051'] }))).toBe('pr:40051');
    expect(mailTriageKey(mail(5, { refs: ['cell:mail-triage-taskqueue'] }))).toBe('cell:MAIL-TRIAGE-TASKQUEUE');
    expect(mailTriageKey(mail(5, { refs: ['block:b-77'] }))).toBe('block:b-77');
    expect(mailTriageKey(mail(5, { refs: ['announce:ann-1'] }))).toBe('announce:ann-1');
    expect(mailTriageKey(mail(5, { correlationId: 'chain-4' }))).toBe('corr:chain-4');
    expect(mailTriageKey(mail(5, { replyTo: 3 }))).toBe('thread:3');
    expect(mailTriageKey(mail(5, { replyTo: 3 }), (id) => (id === 3 ? 'pr:1' : undefined))).toBe('pr:1');
    expect(mailTriageKey(mail(5))).toBe('msg:5');
  });
  test('a non-numeric pr ref is not a PR key', () => {
    expect(mailTriageKey(mail(6, { refs: ['pr:abc'] }))).toBe('msg:6');
  });
});

describe('MAIL-TRIAGE ledger', () => {
  test('same key merges; a status delta merged into an open task costs no turn', () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const ledger = createMailTriageLedger({ now: () => 1000, log: (event, data) => events.push([event, data]) });
    const first = ledger.ingest(mail(10, { kind: 'request', refs: ['pr:40036'] }));
    expect(first).toMatchObject({ cls: 'B', key: 'pr:40036', merged: false, costsTurn: true, signal: 'structured' });
    const delta = ledger.ingest(mail(11, { kind: 'status', refs: ['pr:40036'] }));
    expect(delta).toMatchObject({ cls: 'D', key: 'pr:40036', merged: true, costsTurn: false });
    const reply = ledger.ingest(mail(12, { kind: 'progress', replyTo: 10 }));
    expect(reply).toMatchObject({ cls: 'D', key: 'pr:40036', merged: true, costsTurn: false });
    expect(ledger.open().length).toBe(1);
    expect(ledger.task('pr:40036')?.msgIds).toEqual([10, 11, 12]);
    expect(events.filter(([event]) => event === 'mail.triage').map(([, data]) => data)).toEqual([
      // SEAT-MAIL-PASSIVE-DEFAULT: each verdict also logs the router's decision (no ladder here → a request is a turn).
      { msgId: 10, class: 'B', key: 'pr:40036', merged: false, signal: 'structured', route: 'turn', reason: 'order-unknown-ladder', absorbed: false },
      { msgId: 11, class: 'D', key: 'pr:40036', merged: true, signal: 'structured', route: 'passive', reason: 'info', absorbed: true },
      { msgId: 12, class: 'D', key: 'pr:40036', merged: true, signal: 'structured', route: 'passive', reason: 'reply', absorbed: true },
    ]);
  });

  test('a person\'s status mail on an open subject is merged but still costs a turn', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    ledger.ingest(mail(25, { kind: 'request', refs: ['pr:25'] }));
    expect(ledger.ingest(mail(26, { kind: 'status', refs: ['pr:25'], origin: { kind: 'human' } }))).toMatchObject({ cls: 'D', merged: true, costsTurn: true });
  });

  test('a crown mail on an open subject escalates the task to E and still costs a turn', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    ledger.ingest(mail(20, { kind: 'request', refs: ['cell:X-1'] }));
    const crown = ledger.ingest(mail(21, { kind: 'info', refs: ['cell:X-1'], crownDirective: 'now' }));
    expect(crown).toMatchObject({ cls: 'E', merged: true, costsTurn: true });
    expect(ledger.task('cell:X-1')?.cls).toBe('E');
  });

  test('a task closes only on a result event — never on seen', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    ledger.ingest(mail(30, { kind: 'request', refs: ['pr:7'] }));
    expect(ledger.close('pr:7', { type: 'seen' })).toBe(false);
    expect(ledger.close('pr:7', { type: 'delivered' })).toBe(false);
    expect(ledger.task('pr:7')?.status).toBe('open');
    expect(ledger.close('pr:7', { type: 'pr-landed', pr: 7 })).toBe(true);
    expect(ledger.task('pr:7')).toMatchObject({ status: 'closed', closedBy: { type: 'pr-landed', pr: 7 } });
    expect(ledger.close('pr:7', { type: 'reply-sent' })).toBe(false);
    for (const type of ['reply-sent', 'decision-recorded'] as const) {
      const key = `cell:${type.toUpperCase()}`;
      ledger.ingest(mail(type.length + 100, { kind: 'request', refs: [key] }));
      expect(ledger.close(key, { type })).toBe(true);
    }
    ledger.ingest(mail(40, { kind: 'request', refs: ['cell:CAP'] }));
    expect(ledger.close('cell:CAP', { type: 'capsule-result', taskId: 't9', status: 'done' })).toBe(true);
  });

  test('a done result mail closes its open subject and is absorbed; a failed one closes but costs a turn', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    ledger.ingest(mail(50, { kind: 'request', refs: ['pr:50'] }));
    expect(ledger.ingest(mail(51, { kind: 'coord', refs: ['pr:50'], resultState: 'done' }))).toMatchObject({ cls: 'D', merged: true, costsTurn: false });
    expect(ledger.task('pr:50')).toMatchObject({ status: 'closed', closedBy: { type: 'result-mail', msgId: 51, state: 'done' } });
    ledger.ingest(mail(52, { kind: 'request', refs: ['pr:52'] }));
    expect(ledger.ingest(mail(53, { kind: 'coord', refs: ['pr:52'], resultState: 'failed' }))).toMatchObject({ cls: 'D', merged: true, costsTurn: true });
    expect(ledger.task('pr:52')?.status).toBe('closed');
  });

  test('after a close the same key opens a new task', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    ledger.ingest(mail(60, { kind: 'request', refs: ['pr:60'] }));
    ledger.close('pr:60', { type: 'pr-landed' });
    expect(ledger.ingest(mail(61, { kind: 'status', refs: ['pr:60'] }))).toMatchObject({ cls: 'C', merged: false });
    expect(ledger.task('pr:60')?.msgIds).toEqual([61]);
  });

  test('C batches into one digest item every 10 min; announce keeps its «적용:» reply line', () => {
    let clock = 0;
    const ledger = createMailTriageLedger({ now: () => clock });
    expect(ledger.ingest(mail(70, { from: 'OP', kind: 'announce', refs: ['announce:a1'], body: 'DocsSearch before grep' }))).toMatchObject({ cls: 'C', costsTurn: false });
    clock = 5 * 60_000;
    ledger.ingest(mail(71, { from: 'JUD', kind: 'coord', body: 'queue  is\nempty' }));
    expect(ledger.takeDigest()).toBe(null);
    clock = 9 * 60_000 + 59_999;
    expect(ledger.takeDigest()).toBe(null);
    clock = 10 * 60_000;
    const digest = ledger.takeDigest();
    expect(digest).toEqual({
      key: 'digest:1',
      msgIds: [70, 71],
      text: '[mail digest] 2 info items (batched every 10 min)\n#70 · OP · announce · DocsSearch before grep\n#71 · JUD · coord · queue is empty\nAnnounce: reply to each with one «적용:» line (#70).',
    });
    expect(ledger.takeDigest()).toBe(null);
    clock = 11 * 60_000;
    ledger.ingest(mail(72, { from: 'RES', kind: 'info', body: 'node-b up' }));
    expect(ledger.takeDigest()).toBe(null);
    expect(ledger.takeDigest(true)?.text).toBe('[mail digest] 1 info item (batched every 10 min)\n#72 · RES · info · node-b up');
  });

  test('no structured signal → passive C (no turn) before any model; the cheap model may only promote it (onPromote)', async () => {
    const asked: number[] = [];
    const promoted: number[] = [];
    const ledger = createMailTriageLedger({ now: () => 1, model: async (input) => { asked.push(input.msgId); return input.msgId === 82 ? 'B' : 'C'; },
      onPromote: (_task, input) => { promoted.push(input.msgId); } });
    const verdict = ledger.ingest(mail(80, { body: 'fyi the build is green' }));
    expect(verdict).toMatchObject({ cls: 'C', signal: 'default', costsTurn: false, route: 'passive', routeReason: 'no-kind' });
    expect(ledger.ingest(mail(81, { kind: 'request' })).signal).toBe('structured');
    expect(ledger.ingest(mail(82, { from: 'UX', body: 'please re-run the gate' }))).toMatchObject({ cls: 'C', costsTurn: false });
    await ledger.settled();
    expect(asked).toEqual([80, 82]);
    expect(ledger.task('msg:80')).toMatchObject({ cls: 'C', signal: 'model' });
    expect(ledger.task('msg:82')).toMatchObject({ cls: 'B', signal: 'model' });
    expect(promoted).toEqual([82]);
  });

  test('a failing model keeps the passive default', async () => {
    const ledger = createMailTriageLedger({ now: () => 1, model: async () => { throw new Error('rate limited'); } });
    ledger.ingest(mail(90));
    await ledger.settled();
    expect(ledger.task('msg:90')).toMatchObject({ cls: 'C', signal: 'default' });
  });

  test('class A is a hook point: the answer-needed hook fires, the ledger does not close it', () => {
    const hooked: number[] = [];
    const ledger = createMailTriageLedger({ now: () => 1, onAnswerNeeded: (verdict) => hooked.push(verdict.msgId) });
    ledger.ingest(mail(100, { kind: 'request', intent: 'decision', refs: ['block:b-1'] }));
    expect(hooked).toEqual([100]);
    expect(ledger.task('block:b-1')?.status).toBe('open');
  });

  test('ledger row → input keeps only structured fields', () => {
    expect(mailTriageInputOf({ id: 3, from: 'UX', body: 'b', kind: 'request', refs: ['pr:1'], result: { state: 'done' }, supersedes: 2 })).toEqual({
      msgId: 3, from: 'UX', body: 'b', kind: 'request', intent: null, crownDirective: null, origin: null, replyTo: null,
      refs: ['pr:1'], correlationId: null, supersedes: 2, resultState: 'done', doneWhen: null, deadlineAt: null,
    });
  });
});

describe('SEAT-MAIL-PASSIVE-DEFAULT — kind-less duplicates merge (D) and passive mail costs no turn', () => {
  test('notice is an info kind: a notice on a new subject is C and costs no turn', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    expect(ledger.ingest(mail(200, { kind: 'notice', body: 'landed #1' }))).toMatchObject({ cls: 'C', costsTurn: false, route: 'passive' });
  });

  test('same sender, same body, no kind, inside 10 min → merged as D and absorbed', () => {
    let clock = 0;
    const ledger = createMailTriageLedger({ now: () => clock });
    expect(ledger.ingest(mail(210, { from: 'TC-H3', body: '[TC-H3] 회신: PR 올림' }))).toMatchObject({ key: 'msg:210', merged: false, costsTurn: false });
    clock = 9 * 60_000;
    expect(ledger.ingest(mail(211, { from: 'TC-H3', body: '[TC-H3]  회신: PR 올림' }))).toMatchObject({ cls: 'D', key: 'msg:210', merged: true, costsTurn: false });
    expect(ledger.task('msg:210')?.msgIds).toEqual([210, 211]);
  });

  test('same body from another sender, or after the window, is not a duplicate', () => {
    let clock = 0;
    const ledger = createMailTriageLedger({ now: () => clock });
    ledger.ingest(mail(220, { from: 'TC-H1', body: 'same words' }));
    expect(ledger.ingest(mail(221, { from: 'TC-H2', body: 'same words' }))).toMatchObject({ key: 'msg:221', merged: false });
    clock = 10 * 60_000 + 1;
    expect(ledger.ingest(mail(222, { from: 'TC-H1', body: 'same words' }))).toMatchObject({ key: 'msg:222', merged: false });
  });

  test('a kind-less repeat on the same thread from the same sender is D; from another sender it only merges', () => {
    let clock = 0;
    const ledger = createMailTriageLedger({ now: () => clock });
    ledger.ingest(mail(230, { from: 'OP', kind: 'question', intent: 'decision', body: 'status?' }));
    clock = 60_000;
    expect(ledger.ingest(mail(231, { from: 'JUD', replyTo: 230, body: 'first answer' }))).toMatchObject({ cls: 'C', merged: true, costsTurn: false, routeReason: 'reply' });
    clock = 120_000;
    expect(ledger.ingest(mail(232, { from: 'JUD', replyTo: 230, body: 'second answer' }))).toMatchObject({ cls: 'D', merged: true, costsTurn: false });
  });

  test('a repeated question from the same sender still costs a turn (a question is never absorbed)', () => {
    let clock = 0;
    const ledger = createMailTriageLedger({ now: () => clock });
    ledger.ingest(mail(240, { from: 'UX', kind: 'question', refs: ['cell:Q-1'], body: 'go?' }));
    clock = 60_000;
    expect(ledger.ingest(mail(241, { from: 'UX', kind: 'question', refs: ['cell:Q-1'], body: 'go?' }))).toMatchObject({ cls: 'A', costsTurn: true });
  });

  test('the router sees the sender role: a request from below is passive, from above a turn', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    expect(ledger.ingest(mail(250, { from: 'TC-H4', kind: 'request', senderAbove: false, refs: ['pr:250'] }))).toMatchObject({ cls: 'B', costsTurn: false, routeReason: 'routine-request' });
    expect(ledger.ingest(mail(251, { from: 'TC', kind: 'request', senderAbove: true, refs: ['pr:251'] }))).toMatchObject({ cls: 'B', costsTurn: true, routeReason: 'order' });
  });

  test('a #40065 wait-cancel notice (intent alert) is passive', () => {
    const ledger = createMailTriageLedger({ now: () => 1 });
    expect(ledger.ingest(mail(260, { from: 'OP', kind: 'notice', intent: 'alert', refs: ['wait-cancelled-of:99', 'wait-counterpart:TC'] })))
      .toMatchObject({ costsTurn: false, route: 'passive', routeReason: 'wait-cancel' });
  });
});
