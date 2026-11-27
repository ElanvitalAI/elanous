// TUI-NEXT-QUEUE-AND-WAKE — next TUI keeps what is submitted while a turn runs (FIFO, one per settle)
// and opens a turn of its own when a ScheduleWakeup it scheduled comes due.
// The wakeup half is the classic scheduler (`createDashboardWakeupScheduler`) on the classic internal-turn
// door (`createInternalTurnGate`); only the REPL-child ↔ TUI hop (Bun IPC) is new, so the unit tests below
// drive that hop end to end, and the L3 tests drive the real `--tui next` of this tree on the fake LLM.
import { describe, expect, test } from 'bun:test';
import { createDraftKeyClock } from './input/draft-idle.js';
import { internalWakeBuffer } from './turn-events/door-wire.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScheduleWakeupHostTool, createWakeupScheduler, SCHEDULE_WAKEUP_TOOL_NAME } from '../skills/tools/schedule-wakeup.js';
import {
  NEXT_TUI_WAKEUP_IPC_ENV,
  answerWakeupCall,
  createNextTuiWakeup,
  createReplWakeupTool,
  isWakeupCallMessage,
} from '../tui-client/next-wakeup.js';
import { runNextTuiScenario } from '../ux-sim/next-tui-seat-scenarios.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

/** A fake clock + timer table so the scheduler's 60s minimum is crossed without waiting. */
function fakeTimers(start = Date.UTC(2026, 9, 22, 3, 0, 0)) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
      }
    },
  };
}

describe('REPL child ↔ next TUI wakeup hop', () => {
  test('empty editor after backspace does not block a scheduled wake after typing expires', async () => {
    const clock = fakeTimers();
    let text = 'x';
    let lastKey = clock.now();
    let yields = 0;
    const facts = { draft: () => text, unreadKeys: () => 0, lastHumanKeyAt: () => lastKey, now: clock.now };
    const wake = createNextTuiWakeup({
      isTurnRunning: () => false, getBufferText: () => internalWakeBuffer(facts),
      getQueuedCount: () => 0, requestYield: () => { yields++; return true; },
      notify: () => {}, env: {}, now: clock.now, setTimer: clock.setTimer,
      clearTimer: clock.clearTimer, lastHumanKeyAt: () => lastKey, pendingKeyCount: () => 0, log: () => {},
    });
    try {
      await answerWakeupCall(wake.tool!, { type: 'elanous.wakeup.call', callId: 'empty-retry', args: { action: 'schedule', delaySeconds: 60, reason: 'empty retry' } });
      clock.advance(59_000);
      text = ''; // Backspace: the final human key leaves no draft.
      lastKey = clock.now();
      clock.advance(1_000);
      expect(yields).toBe(0);
      clock.advance(60_000);
      expect(yields).toBe(1);
      expect(wake.takePendingIfIdle()?.origin).toBe('scheduled');
      expect(text).toBe('');
    } finally { wake.dispose(); }
  });
  test('scheduled wake retries a restored draft and preserves it after the idle window', async () => {
    const clock = fakeTimers();
    const draftClock = createDraftKeyClock();
    const editor = { text: 'unsent', cursor: 3 };
    let yields = 0;
    const facts = { draft: () => editor.text, unreadKeys: () => 0,
      lastHumanKeyAt: () => draftClock(editor.text, 0, clock.now()), now: clock.now };
    facts.lastHumanKeyAt(); // render observes the restored draft
    const wake = createNextTuiWakeup({
      isTurnRunning: () => false, getBufferText: () => internalWakeBuffer(facts),
      getQueuedCount: () => 0, requestYield: () => { yields++; return true; },
      notify: () => {}, env: {}, now: clock.now, setTimer: clock.setTimer,
      clearTimer: clock.clearTimer, lastHumanKeyAt: () => 0, pendingKeyCount: () => 0, log: () => {},
    });
    try {
      await answerWakeupCall(wake.tool!, { type: 'elanous.wakeup.call', callId: 'draft-retry', args: { action: 'schedule', delaySeconds: 60, reason: 'retry draft' } });
      clock.advance(60_000);
      expect(yields).toBe(0);
      clock.advance(60_000);
      expect(yields).toBe(1);
      expect(wake.takePendingIfIdle()?.origin).toBe('scheduled');
      expect(editor).toEqual({ text: 'unsent', cursor: 3 });
    } finally { wake.dispose(); }
  });
  test('the child advertises exactly the classic ScheduleWakeup spec, and only when the TUI opened the hop', () => {
    const classic = buildScheduleWakeupHostTool(createWakeupScheduler({ startTurnIfIdle: () => ({ opened: false, reason: 'Disabled' }) }));
    const proc = { send: () => true, on: () => {}, off: () => {} };
    expect(createReplWakeupTool(proc, {})).toBeNull();
    expect(createReplWakeupTool({ on: () => {}, off: () => {} }, { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' })).toBeNull();
    const tool = createReplWakeupTool(proc, { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' });
    expect(tool?.spec).toEqual({ name: SCHEDULE_WAKEUP_TOOL_NAME, description: classic.description, parameters: classic.parameters });
  });

  test('a tool call in the child schedules on the TUI scheduler; at the due time the door opens one internal turn', async () => {
    const clock = fakeTimers();
    let yields = 0;
    const lines: string[] = [];
    let busy = false;
    const wake = createNextTuiWakeup({
      isTurnRunning: () => busy,
      getBufferText: () => '',
      getQueuedCount: () => 0,
      requestYield: () => { yields += 1; return true; },
      notify: (line) => lines.push(line),
      env: {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      lastHumanKeyAt: () => 0,
      pendingKeyCount: () => 0,
      log: () => {},
    });
    expect(wake.tool?.name).toBe(SCHEDULE_WAKEUP_TOOL_NAME);
    expect(wake.headline(null)).toBe('건강 관측 전 · 깨움 없음');
    // child side: process.send → parent ipc handler → answer → child 'message'
    const listeners: ((m: unknown) => void)[] = [];
    const child = {
      send: (m: unknown) => {
        if (isWakeupCallMessage(m)) void answerWakeupCall(wake.tool!, m).then((r) => { for (const l of listeners) l(r); });
        return true;
      },
      on: (_e: 'message', l: (m: unknown) => void) => { listeners.push(l); },
      off: () => {},
    };
    const replTool = createReplWakeupTool(child, { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' })!;
    wake.gate.noteHumanTurn();
    const result = await replTool.dispatch({ action: 'schedule', delaySeconds: 60, reason: '점검' }) as { scheduled?: { id: string } };
    expect(result.scheduled?.id).toBe('w1');
    expect(wake.headline(null)).toContain('깨움 ');
    expect(wake.headline({
      sessionId: 'session', capturedAt: clock.now(), line: '', source: 'checkout',
      runningSha: null, installedSha: null, errorCount: 2,
      representativeError: 'fake error', creditSource: null, creditKnown: false,
    })).toContain('건강 오류 2 · 깨움 ');
    expect(lines.some((l) => l.startsWith('⏰ 예약 깨움') && l.includes('점검'))).toBe(true);
    // Busy at the due time → the classic defer rule (NotIdle → retry a minute later), not a drop.
    busy = true;
    clock.advance(60_000);
    expect(yields).toBe(0);
    busy = false;
    clock.advance(60_000);
    expect(yields).toBe(1);
    const request = wake.gate.takePending();
    expect(request?.origin).toBe('scheduled');
    expect(request?.input).toContain('[예약 깨움 w1] 점검');
    expect(wake.banner(request!)).toBe('↻ 자동 재개(scheduled): 점검');
    wake.dispose();
  });

  test('a harness child gets no wakeup tool (unattended runs keep the classic boundary)', () => {
    const wake = createNextTuiWakeup({
      isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0,
      requestYield: () => true, notify: () => {}, env: { ELANOUS_HARNESS_ROLE: 'child' }, log: () => {},
    });
    expect(wake.tool).toBeNull();
    wake.dispose();
  });

  test('an unanswered call resolves to an error instead of hanging the child turn', async () => {
    const replTool = createReplWakeupTool({ send: () => true, on: () => {}, off: () => {} }, { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' }, { timeoutMs: 20 })!;
    expect(await replTool.dispatch({ action: 'list' })).toEqual({ error: "ScheduleWakeup: next TUI did not answer within 20ms — it may still schedule this; run action:'list' before retrying" });
  });

  test('the accelerated fake clock skips only the wall-clock quiet window', () => {
    const makeWake = (env: NodeJS.ProcessEnv) => createNextTuiWakeup({
      isTurnRunning: () => false,
      getBufferText: () => '',
      getQueuedCount: () => 0,
      requestYield: () => true,
      notify: () => {},
      env,
      now: () => 10_000,
      lastHumanKeyAt: () => 9_999,
      log: () => {},
    });
    const fast = makeWake({ ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAST_WAKEUP_CLOCK: '1' });
    expect(fast.gate.startTurnIfIdle('scheduled test', { origin: 'scheduled', reason: 'test' }).opened).toBe(true);
    fast.dispose();

    for (const env of [
      { ELANOUS_TEST_FAKE_LLM: '1' },
      { ELANOUS_TEST_FAST_WAKEUP_CLOCK: '1' },
    ]) {
      const wake = makeWake(env);
      expect(wake.gate.startTurnIfIdle('scheduled test', { origin: 'scheduled', reason: 'test' }))
        .toMatchObject({ opened: false, reason: 'HumanTyping', detail: 'quiet-window' });
      wake.dispose();
    }
  });

  test('H2 keeps a wakeup behind log focus and withdraws a pending wakeup if a person takes focus', () => {
    let foreground = false;
    let queued = 0;
    let pendingKeys = 0;
    const wake = createNextTuiWakeup({
      isTurnRunning: () => false,
      isInputForeground: () => foreground,
      getBufferText: () => '',
      getQueuedCount: () => queued,
      requestYield: () => true,
      notify: () => {},
      lastHumanKeyAt: () => 0,
      pendingKeyCount: () => pendingKeys,
      log: () => {},
    });
    const opts = { origin: 'scheduled' as const, reason: '점검' };
    expect(wake.gate.startTurnIfIdle('예약 점검', opts)).toMatchObject({ opened: false, reason: 'NotIdle', detail: 'input-not-foreground' });
    foreground = true;
    expect(wake.gate.startTurnIfIdle('예약 점검', opts).opened).toBe(true);
    foreground = false;
    expect(wake.takePendingIfIdle()).toBeNull();
    expect(wake.gate.takePending()).toBeNull();
    foreground = true;
    expect(wake.gate.startTurnIfIdle('예약 점검', opts).opened).toBe(true);
    queued = 1;
    expect(wake.takePendingIfIdle()).toBeNull();
    queued = 0;
    expect(wake.gate.startTurnIfIdle('예약 점검', opts).opened).toBe(true);
    pendingKeys = 1;
    expect(wake.takePendingIfIdle()).toBeNull();
    pendingKeys = 0;
    expect(wake.gate.startTurnIfIdle('예약 점검', opts).opened).toBe(true);
    expect(wake.takePendingIfIdle()?.input).toBe('예약 점검');
    wake.dispose();
  });

  test('mail opt-in revoked after poll withdraws the pending H2 turn before consumption', async () => {
    const home = mkdtempSync(join(tmpdir(), 'next-mail-consume-'));
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'R-TICKET');
    const optIn = join(seatDir, 'autowake');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(optIn, 'on\n');
    let reads = 0;
    const wake = createNextTuiWakeup({
      enableSeatMailWake: true,
      mailWakeOptions: { home, seat: 'R-TICKET', intervalMs: 60_000,
        readUnread: () => { reads++; return { count: 1, maxId: 7 }; } }, // Source: #36648 pending fake mail fixture.
      isTurnRunning: () => false,
      getBufferText: () => '',
      getQueuedCount: () => 0,
      requestYield: () => true,
      notify: () => {},
      lastHumanKeyAt: () => 0,
      log: () => {},
    });
    try {
      await Promise.resolve(); // Source: next-mail-wake.ts schedules its first poll as a microtask.
      expect(reads).toBe(1);
      rmSync(optIn);
      expect(wake.takePendingIfIdle()).toBeNull();
      expect(wake.gate.takePending()).toBeNull();
      expect(wake.gate.startTurnIfIdle('later scheduled turn', { origin: 'scheduled' }).opened).toBe(true);
      expect(wake.takePendingIfIdle()?.input).toBe('later scheduled turn');
    } finally {
      wake.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('human withdrawal clears mail identity before a later scheduled turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'next-mail-human-withdraw-'));
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'R-TICKET');
    const optIn = join(seatDir, 'autowake');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(optIn, 'on\n');
    let buffer = '';
    const wake = createNextTuiWakeup({
      enableSeatMailWake: true,
      mailWakeOptions: { home, seat: 'R-TICKET', intervalMs: 60_000,
        readUnread: () => ({ count: 1, maxId: 7 }) }, // Source: #36648 pending fake mail fixture.
      isTurnRunning: () => false,
      getBufferText: () => buffer,
      getQueuedCount: () => 0,
      requestYield: () => true,
      notify: () => {},
      lastHumanKeyAt: () => 0,
      log: () => {},
    });
    try {
      await Promise.resolve();
      buffer = 'person typing';
      expect(wake.takePendingIfIdle()).toBeNull();
      buffer = '';
      expect(wake.gate.startTurnIfIdle('later scheduled turn', { origin: 'scheduled' }).opened).toBe(true);
      rmSync(optIn);
      expect(wake.takePendingIfIdle()?.input).toBe('later scheduled turn');
    } finally {
      wake.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('next TUI on N03 (this tree · fake LLM)', () => {
  test('next-queue: two sentences sent while busy run after settle, in order, nothing lost or merged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-queue-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-queue', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        queueShownWhileBusy: true, userTurnsInOrder: true, threeReplies: true, draftKept: true,
        escCancelsWithoutShellConfirmation: true, escKeepsUnsentDraft: true, // #38802 실측 계약 — Esc는 중단+미전송 초안 잔류(«복원» 아님)
        escWakesQueuedTurn: true, queueDispatchEventCarriesWake: true, // 깨움 경로는 queue-dispatched(entry.ts:1702) · queue-restored 폐기
        onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next empty editor: actual Backspace permits the deferred scheduled wake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'next-empty-backspace-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-empty-backspace-wakeup', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({ erased: true, notPremature: true, wakeTurnStored: true, onlyFakeProvider: true, exitedClean: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);

  test('next idle draft: real three-minute wait preserves draft and opens the scheduled turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'next-idle-draft-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-idle-draft-wakeup', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({ waitedThreeMinutes: true, draftPreserved: true, wakeTurnStored: true, onlyFakeProvider: true, exitedClean: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);

  test('next-wakeup: a ScheduleWakeup from a turn opens one internal turn later, deferred while busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-wake-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-wakeup', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        scheduledOnce: true, noticeHidden: true, deferredWhileBusy: true, firedOnce: true,
        internalTurnOpened: true, bannerHidden: true, wakeTurnStored: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);
});
