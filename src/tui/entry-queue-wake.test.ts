// TUI-NEXT-QUEUE-AND-WAKE — next TUI keeps what is submitted while a turn runs (FIFO, one per settle)
// and opens a turn of its own when a ScheduleWakeup it scheduled comes due.
// The wakeup half is the classic scheduler (`createDashboardWakeupScheduler`) on the classic internal-turn
// door (`createInternalTurnGate`); only the REPL-child ↔ TUI hop (Bun IPC) is new, so the unit tests below
// drive that hop end to end, and the L3 tests drive the real `--tui next` of this tree on the fake LLM.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(await replTool.dispatch({ action: 'list' })).toEqual({ error: 'ScheduleWakeup: next TUI did not answer' });
  });
});

describe('next TUI on N03 (this tree · fake LLM)', () => {
  test('next-queue: two sentences sent while busy run after settle, in order, nothing lost or merged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-queue-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-queue', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        queueShownWhileBusy: true, userTurnsInOrder: true, threeReplies: true, draftKept: true,
        escRestoresQueue: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-wakeup: a ScheduleWakeup from a turn opens one internal turn later, deferred while busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-wake-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-wakeup', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        scheduledOnce: true, noticeOnScreen: true, deferredWhileBusy: true, firedOnce: true,
        internalTurnOpened: true, bannerOnScreen: true, wakeTurnStored: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);
});
