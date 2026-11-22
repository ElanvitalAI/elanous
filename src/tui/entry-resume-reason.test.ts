import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNextTuiQueue } from './core/queue.js';
import { INTERRUPTED_ON_PURPOSE_NOTE, stripQueueModelContext, withInterruptedOnPurposeContext, withQueueNoticeContext } from '../chat/interjection.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { closeLocalChatSession, runLocalChatTurn } from '../tui-client/local-chat-turn.js';
import { setUserConfigOverlay } from '../user-config.js';
import { dispatchQueuedExternalEventOne } from './entry.js';
import { createEntryTurnDoor } from './turn-events/door-wire.js';
import { resetExternalEventOneWire } from './external-event-one-wire.js';

const notes = {
  interrupt: INTERRUPTED_ON_PURPOSE_NOTE,
  esc: '[사용자가 Esc로 직전 턴을 중단했습니다. 중단된 도구·명령의 현재 상태를 확인하십시오.]',
  'timeout-15m': '[직전 턴이 시간 제한으로 자동 중단됐습니다. 중단된 도구·명령의 현재 상태를 확인하십시오.]',
  'stream-stall': '[직전 턴이 응답 정체로 자동 중단됐습니다. 중단된 도구·명령의 현재 상태를 확인하십시오.]',
} as const;

test.each(Object.entries(notes) as Array<[keyof typeof notes, string]>)('queue and context preserve %s once', (reason, note) => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  q.enqueue('human'); q.enqueueNotice('notice', 'seat-mail');
  q.markInterrupted(reason); expect(q.settle('')).toEqual({ kind: 'resubmit', count: 2 });
  const first = q.dequeue(); const second = q.dequeue();
  expect(first).toMatchObject({ kind: 'submit', text: 'human', afterInterrupt: true });
  if (first.kind !== 'submit' || second.kind !== 'submit') throw new Error('missing queue item');
  expect(first.interruptReason ?? 'interrupt').toBe(reason);
  expect(second.afterInterrupt).toBe(false);
  const human = withInterruptedOnPurposeContext(first.text, first.interruptReason);
  expect(human).toBe(`${note}\n\nhuman`);
  expect(stripQueueModelContext(human)).toBe('human');
  const notice = withInterruptedOnPurposeContext(withQueueNoticeContext('notice', 'seat-mail'), reason);
  expect(stripQueueModelContext(notice)).toBe('notice');
});

test('successive dequeues retain the first unconsumed reason at entry handoff', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  expect(entry).toContain("if (handoff.afterInterrupt) interruptContextFor ??= handoff.interruptReason ?? 'interrupt';");
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  let pending: string | null = null;
  q.enqueue('first'); q.markInterrupted('stream-stall'); q.settle('');
  const first = q.dequeue();
  if (first.kind !== 'submit') throw new Error('missing first item');
  if (first.afterInterrupt) pending ??= first.interruptReason ?? 'interrupt';
  q.enqueue('second'); q.markInterrupted('esc'); q.settle('');
  const second = q.dequeue();
  if (second.kind !== 'submit') throw new Error('missing second item');
  if (second.afterInterrupt) pending ??= second.interruptReason ?? 'interrupt';
  expect(pending).toBe('stream-stall');
});

test.each([false, true])('real door race: held notice inherits reason (queue has later notice: %s)', async (hasQueued) => {
  resetExternalEventOneWire();
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const door = createEntryTurnDoor({ humanFirst: () => null, onOffer: () => {}, now: () => 5 });
  const original = q.enqueueNotice('held first', 'seat-mail');
  const first = q.dequeue();
  if (first.kind !== 'submit') throw new Error('missing first notice');
  const reservation = door.reserveAuto()!;
  let resolveWire!: (wire: typeof import('./external-event-one-wire.js')) => void;
  const wire = new Promise<typeof import('./external-event-one-wire.js')>(resolve => { resolveWire = resolve; });
  const kept: string[] = [];
  const pending = dispatchQueuedExternalEventOne({
    notice: { id: original.id, text: first.text, source: 'seat-mail', remaining: 0 }, wire,
    injectKey: () => {}, keepOpen: () => {}, startChatTurn: () => { throw new Error('displaced notice started'); },
    log: () => {}, held: () => door.door.holds(reservation), onSuperseded: () => { kept.push(first.text); },
  });
  expect(door.reserveHuman()).not.toBeNull();
  expect(door.beginTurn()).toBe(true);
  resolveWire(await import('./external-event-one-wire.js'));
  await pending;
  expect(kept).toEqual(['held first']);
  if (hasQueued) q.enqueueNotice('queued second', 'seat-mail');
  q.markInterrupted('stream-stall');
  expect(q.settle('', { text: 'human', responded: true }, kept.length > 0)).toEqual(hasQueued ? { kind: 'resubmit', count: 1 } : { kind: 'none' });
  let context = q.takeResumeReason();
  expect(context).toBe('stream-stall');
  door.endTurn('cancelled');
  const retry = door.reserveAuto()!;
  const delivered: string[] = [];
  await dispatchQueuedExternalEventOne({
    notice: { id: original.id, text: kept[0]!, source: 'seat-mail', remaining: q.count },
    injectKey: () => {}, keepOpen: () => {}, log: () => {}, held: () => door.door.holds(retry),
    startChatTurn: text => { delivered.push(withInterruptedOnPurposeContext(text, context)); context = undefined; },
  });
  expect(delivered).toEqual([`${notes['stream-stall']}\n\nheld first`]);
  const later = q.dequeue();
  if (hasQueued) expect(later).toMatchObject({ kind: 'submit', text: 'queued second', afterInterrupt: false });
  else expect(later).toEqual({ kind: 'none' });
  expect(q.takeResumeReason()).toBeUndefined();
  expect(context).toBeUndefined();
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  expect(entry).toContain('const reason = queue.takeResumeReason();');
  expect(entry).toContain('if (reason !== undefined) interruptContextFor ??= reason;');
});

test('late superseded import keeps the first interruption until the notice is delivered', async () => {
  resetExternalEventOneWire();
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  // Check the production wiring as well as exercising the real queue and door below.
  expect(entry).toContain('const noticePending = heldNotices.length > 0 || noticesInFlight > 0;');
  expect(entry).toContain('queue.settle(input.editor.text, turn, noticePending)');
  expect(entry).toContain('if (noticePending) {');
  expect(entry).not.toContain("result.kind === 'resubmit' || noticePending");
  expect(entry).toContain('}).finally(() => { noticesInFlight--; });');
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const door = createEntryTurnDoor({ humanFirst: () => null, onOffer: () => {}, now: () => 5 });
  const notice = q.enqueueNotice('late notice', 'seat-mail');
  expect(q.dequeue().kind).toBe('submit');
  const reservation = door.reserveAuto()!;
  let resolveWire!: (wire: typeof import('./external-event-one-wire.js')) => void;
  const wire = new Promise<typeof import('./external-event-one-wire.js')>(resolve => { resolveWire = resolve; });
  const held: string[] = [];
  let inFlight = 1;
  const pending = dispatchQueuedExternalEventOne({ notice: { ...notice, text: 'late notice', source: 'seat-mail', remaining: 0 }, wire,
    injectKey: () => {}, keepOpen: () => {}, startChatTurn: () => { throw new Error('notice started too early'); }, log: () => {},
    held: () => door.door.holds(reservation), onSuperseded: () => { held.push('late notice'); },
  }).finally(() => { inFlight--; });
  expect(door.reserveHuman()).not.toBeNull(); expect(door.beginTurn()).toBe(true);
  q.markInterrupted('esc');
  const pendingAtSettle = held.length > 0 || inFlight > 0;
  const result = q.settle('', { text: 'human', responded: true }, pendingAtSettle);
  let context = pendingAtSettle ? q.takeResumeReason() : undefined;
  expect(context).toBe('esc');
  q.markInterrupted('stream-stall');
  q.settle('', { text: 'human again', responded: true }, pendingAtSettle);
  const laterReason = q.takeResumeReason();
  if (laterReason !== undefined) context ??= laterReason;
  expect(context).toBe('esc');
  door.endTurn('cancelled');
  resolveWire(await import('./external-event-one-wire.js')); await pending;
  expect(inFlight).toBe(0); expect(held).toEqual(['late notice']);
  const retry = door.reserveAuto()!; const delivered: string[] = [];
  await dispatchQueuedExternalEventOne({ notice: { ...notice, text: held[0]!, source: 'seat-mail', remaining: 0 },
    injectKey: () => {}, keepOpen: () => {}, log: () => {}, held: () => door.door.holds(retry),
    startChatTurn: text => { delivered.push(withInterruptedOnPurposeContext(text, context)); context = undefined; },
  });
  expect(delivered).toEqual([`${notes.esc}\n\nlate notice`]);
  expect(context).toBeUndefined();
});

test('resubmit alone leaves the reason in the queue for deliver() instead of taking it at settle', () => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  q.enqueue('human'); q.markInterrupted('esc');
  expect(q.settle('', undefined, false)).toEqual({ kind: 'resubmit', count: 1 });
  // settle() in entry.ts no longer calls takeResumeReason() here: the reason is still on the queue and rides the item.
  const item = q.dequeue();
  expect(item).toMatchObject({ kind: 'submit', text: 'human', afterInterrupt: true, interruptReason: 'esc' });
  expect(q.takeResumeReason()).toBeUndefined();
});

test('dispatch completion clears in-flight tracking on success, refusal and rejection', async () => {
  resetExternalEventOneWire();
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  expect(entry).toContain('noticesInFlight++;');
  expect(entry).toContain('}).finally(() => { noticesInFlight--; });');
  expect(entry).toContain('} catch (error) {\n      noticesInFlight--;');
  let inFlight = 0; let starts = 0;
  const run = (id: string, wire?: Promise<typeof import('./external-event-one-wire.js')>, failStart = false) => {
    inFlight++;
    return dispatchQueuedExternalEventOne({ notice: { id, text: id, source: 'seat-mail', remaining: 0 }, wire,
      injectKey: () => {}, keepOpen: () => {}, log: () => {},
      startChatTurn: () => { starts++; if (failStart) throw new Error('start failed'); },
    }).finally(() => { inFlight--; });
  };
  await run('tracking-success'); expect(inFlight).toBe(0); expect(starts).toBe(1);
  await run('tracking-success'); expect(inFlight).toBe(0); expect(starts).toBe(1); // duplicate
  await run('tracking-import-failure', Promise.reject(new Error('import failed'))); expect(inFlight).toBe(0);
  await expect(run('tracking-start-failure', undefined, true)).rejects.toThrow('start failed');
  expect(inFlight).toBe(0); expect(starts).toBe(2);
});

test('legacy no-argument mark and context keep the Ctrl+C default', () => {
  const q = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  q.enqueue('next'); q.markInterrupted(); q.settle('');
  const first = q.dequeue();
  expect(first).toMatchObject({ kind: 'submit', afterInterrupt: true });
  if (first.kind !== 'submit') throw new Error('missing item');
  expect(first.interruptReason).toBeUndefined();
  expect(withInterruptedOnPurposeContext(first.text)).toBe(`${INTERRUPTED_ON_PURPOSE_NOTE}\n\nnext`);
});

test('child-pipe callback fires only after successful write, not cancellation or failed write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reason-write-'));
  const cli = join(dir, 'fake-cli.ts');
  writeFileSync(cli, `import { createInterface } from 'node:readline';\nfor await (const line of createInterface({ input: process.stdin })) { const x = JSON.parse(line); console.log(JSON.stringify({ id: x.id, goalComplete: false })); }`);
  setUserConfigOverlay(config => ({ ...config, llm: { ...config.llm, provider: 'grok' }, chat: { ...config.chat, autoCompact: { ...config.chat.autoCompact, enabled: false } } }));
  let calls = 0;
  const run = (signal: AbortSignal, writer?: (payload: string) => Promise<void>) => runLocalChatTurn(
    'reason-write-test', 'hello', signal, cli, writer, undefined, {}, [], undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, () => { calls++; });
  try {
    const aborted = new AbortController(); aborted.abort();
    await expect(run(aborted.signal)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(run(new AbortController().signal, async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    expect(calls).toBe(0);
    await expect(run(new AbortController().signal)).resolves.toEqual({ goalComplete: false });
    expect(calls).toBe(1);
  } finally {
    await closeLocalChatSession('reason-write-test');
    setUserConfigOverlay(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ctrl+C queued human reaches actual fake provider with default interruption note', async () => {
  const base = mkdtempSync(join(tmpdir(), 'resume-reason-'));
  const root = join(base, 'seats', 'MX13REASON'); const home = join(base, 'home');
  const capture = join(root, 'requests.jsonl');
  mkdirSync(root, { recursive: true }); mkdirSync(join(home, 'elanous-hq', 'seat-state', 'MX13REASON'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false }, llm: { memoryJudge: { enabled: false, crossRecall: false } } }));
  let keep = false;
  try {
    const result = await mockSeatPtySequence({ executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 32, cols: 120,
      env: { HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TUI_GOAL_CONTINUE: '0', ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'REASON-REPLY', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture, ELANOUS_TEST_FAKE_LLM_DELAY_MS: '60000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow first' },
      ready: { label: 'ready', timeoutMs: 30000, until: s => s.includes('Ctrl+Q quit') && s.includes('❯') },
      steps: [
        { label: 'start', text: 'slow first', timeoutMs: 20000, until: () => existsSync(capture) && readFileSync(capture, 'utf8').includes('slow first') },
        { label: 'queue human', text: 'queued human', timeoutMs: 10000, until: s => s.includes('1 queued') },
        { label: 'interrupt', keys: '\x03', timeoutMs: 30000, until: () => existsSync(capture) && readFileSync(capture, 'utf8').includes(INTERRUPTED_ON_PURPOSE_NOTE) },
        { label: 'reply', timeoutMs: 30000, until: s => s.includes('REASON-REPLY') && !s.includes('Thinking') },
        { label: 'subsequent human', text: 'later human', timeoutMs: 30000, until: () => existsSync(capture) && readFileSync(capture, 'utf8').includes('later human') },
      ] });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const inputs = requests.map(req => req.messages.at(-1)?.content).filter((x): x is string => typeof x === 'string');
    console.log('provider inputs', JSON.stringify(inputs));
    expect(result.exitCode).toBe(0);
    expect(inputs.filter(x => x === `${INTERRUPTED_ON_PURPOSE_NOTE}\n\nqueued human`)).toHaveLength(1);
    expect(inputs.some(x => x.includes('Esc로') && x.includes('queued human'))).toBe(false);
    expect(inputs.filter(x => x === 'later human')).toHaveLength(1);
    // CHAT-GOAL-LOOP-DEFAULT-OFF — a seat turn is now the ordinary core turn (no seat goal loop), whose research
    // preparation call quotes the request; only the model turns (not that planning call) must carry the note once.
    const turnInputs = inputs.filter(x => !x.startsWith('Prepare the result contract'));
    expect(turnInputs.filter(x => x.includes(INTERRUPTED_ON_PURPOSE_NOTE))).toHaveLength(1);
  } catch (error) { keep = true; console.error('artifacts', base); throw error; }
  finally { if (!keep) rmSync(base, { recursive: true, force: true }); }
}, 100_000);
