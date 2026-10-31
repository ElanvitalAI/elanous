// TUI-STALE-BUSY-MARKER(0.2.31) — 턴 마감이 어떤 단계에서 던져도 busy 표지가 지워지고, 갇힌 외부 입력이 다음에 나간다.
import { describe, expect, test } from 'bun:test';
import { createExternalInputQueue } from '../input/external-input-queue.js';
import { logTurnThrew, runTurnTeardownStep, type TurnThrewLog } from './turn-busy-teardown.js';
import { tuiSourceFileWith } from '../../test/helpers/dashboard-source.js';
import { createTurnThrowSim } from '../ux-sim/turn-throw-sim.js';

type Logged = { category: string; event: string; payload: Record<string, unknown>; level?: string };

function recorder(): { log: TurnThrewLog; events: Logged[] } {
  const events: Logged[] = [];
  return { events, log: (category, event, payload, opts) => { events.push({ category, event, payload, level: opts?.level }); } };
}

/**
 * 대시보드 `attachChatStreamingKeys` 의 마감 closure 와 «같은 조립»을 시험 안에 세운다 — 실물 배선은 아래 원문 시험이 문다.
 * 단계(키 리스너 떼기 · ESC 게이트 정리 · settle)마다 던질지 고른다.
 */
function createTurnHarness(opts: { throwIn?: ReadonlySet<string> } = {}) {
  const throwIn = opts.throwIn ?? new Set<string>();
  const { log, events } = recorder();
  const reported: string[] = [];
  let inFlight = false;
  const step = (phase: string) => () => { if (throwIn.has(phase)) throw new TypeError(`undefined is not an object (evaluating 'line.startsWith') @${phase}`); };
  const attach = (): (() => void) => {
    inFlight = true;
    reported.push('busy');
    return () => {
      runTurnTeardownStep('stream-keys-detach', step('stream-keys-detach'), log);
      runTurnTeardownStep('esc-gate-dispose', step('esc-gate-dispose'), log);
      try {
        step('settle-esc-lines')();
      } catch (err) {
        logTurnThrew('settle-esc-lines', err, log);
      } finally {
        inFlight = false;
        reported.push('idle');
      }
    };
  };
  return { attach, events, reported, isTurnActive: () => inFlight };
}

function queueOn(isTurnActive: () => boolean) {
  const submitted: string[] = [];
  const queue = createExternalInputQueue({ schedule: () => () => {}, log: () => {} });
  queue.register({
    isTurnActive,
    composerText: () => '',
    hasPendingKeys: () => false,
    submit: (text) => { submitted.push(text); return true; },
  });
  return { queue, submitted };
}

describe('turn busy teardown (TUI-STALE-BUSY-MARKER)', () => {
  test('턴 본문이 throw 해도 caller finally 의 cleanup 이 idle 로 한 번 전이하고, 갇힌 외부 입력이 다음에 나간다', async () => {
    const turn = createTurnHarness();
    const { queue, submitted } = queueOn(turn.isTurnActive);
    const cleanupEsc = turn.attach();
    expect(queue.route('/quit\r')).toBe('queued');
    expect(queue.pump()).toBe(false);
    await expect((async () => {
      try { throw new Error('turn body exploded'); }
      finally { cleanupEsc(); }
    })()).rejects.toThrow('turn body exploded');
    expect(turn.reported).toEqual(['busy', 'idle']);
    expect(turn.isTurnActive()).toBe(false);
    expect(queue.pump()).toBe(true);
    expect(submitted).toEqual(['/quit']);
  });

  test('마감의 앞 단계(키 리스너 떼기·ESC 게이트)와 settle 이 모두 던져도 idle 전이 1회 ⊕ 대기열 배출 ⊕ turn-threw 로그', () => {
    const turn = createTurnHarness({ throwIn: new Set(['stream-keys-detach', 'esc-gate-dispose', 'settle-esc-lines']) });
    const { queue, submitted } = queueOn(turn.isTurnActive);
    const cleanup = turn.attach();
    queue.route('/session clear\r');
    queue.route('다음 지시\r');
    expect(queue.pump()).toBe(false);

    expect(() => cleanup()).not.toThrow();

    expect(turn.reported).toEqual(['busy', 'idle']);
    expect(turn.isTurnActive()).toBe(false);
    expect(queue.pump()).toBe(true);
    expect(queue.pump()).toBe(true);
    expect(submitted).toEqual(['/session clear', '다음 지시']);
    const threw = turn.events.filter((e) => e.category === 'tui.turn' && e.event === 'turn-threw');
    expect(threw.map((e) => e.payload.phase)).toEqual(['stream-keys-detach', 'esc-gate-dispose', 'settle-esc-lines']);
    expect(String(threw[0]!.payload.error)).toContain("line.startsWith");
    expect(threw.every((e) => e.level === 'warn')).toBe(true);
  });

  test('지연 throw 심 실행: turn-threw phase 기록 · idle 전이 · 대기 입력 1건 delivered', async () => {
    const stage = 'loadAttachments';
    const turn = createTurnHarness();
    const { queue, submitted } = queueOn(turn.isTurnActive);
    const cleanup = turn.attach();
    const delayedThrow = createTurnThrowSim({ stage, delayMs: 1 });
    queue.route('/help\r');
    expect(queue.pump()).toBe(false);

    try {
      await delayedThrow(stage);
    } catch (error) {
      logTurnThrew(`turn:${stage}`, error, (category, event, payload, opts) => {
        turn.events.push({ category, event, payload, level: opts?.level });
      });
    } finally {
      cleanup();
    }

    expect(turn.events.filter((event) => event.category === 'tui.turn' && event.event === 'turn-threw').map((event) => event.payload.phase)).toEqual([`turn:${stage}`]);
    expect(turn.reported).toEqual(['busy', 'idle']);
    expect(queue.pump()).toBe(true);
    expect(submitted).toEqual(['/help']);
  });

  test('정상 턴은 그대로 — 로그 0 · idle 1회', () => {
    const turn = createTurnHarness();
    const cleanup = turn.attach();
    cleanup();
    expect(turn.reported).toEqual(['busy', 'idle']);
    expect(turn.events).toEqual([]);
  });

  test('runTurnTeardownStep: 던진 단계는 false · 오류 앞부분만(200자) · 비-Error 도 문자열로', () => {
    const { log, events } = recorder();
    expect(runTurnTeardownStep('ok', () => {}, log)).toBe(true);
    expect(runTurnTeardownStep('long', () => { throw new Error('x'.repeat(500)); }, log)).toBe(false);
    expect(runTurnTeardownStep('raw', () => { throw 'plain string'; }, log)).toBe(false);
    expect(events).toHaveLength(2);
    expect(String(events[0]!.payload.error)).toHaveLength(200);
    expect(events[1]!.payload).toMatchObject({ error: 'plain string', phase: 'raw' });
  });

  test('관측 기록기가 던져도 마감은 계속된다', () => {
    const throwingLog: TurnThrewLog = () => { throw new Error('sink down'); };
    expect(() => logTurnThrew('p', new Error('e'), throwingLog)).not.toThrow();
    expect(runTurnTeardownStep('p', () => { throw new Error('e'); }, throwingLog)).toBe(false);
  });

  test('실물 배선: busy 는 키 리스너를 붙인 «뒤» 켜고, 마감 앞 단계는 runTurnTeardownStep 으로 격리한다', () => {
    const file = tuiSourceFileWith('const attachChatStreamingKeys =');
    const start = file.text.indexOf('const attachChatStreamingKeys =');
    const end = file.text.indexOf('// ── Working-directory workspace widgets', start);
    const body = file.text.slice(start, end);
    const busyAt = body.indexOf("reportTuiTurn('busy');");
    const inFlightOnAt = body.indexOf('streamingInFlight = true;');
    const listenerAt = body.indexOf('const cleanup = attachStreamingKeys(');
    const returnAt = body.lastIndexOf('return () => {');
    expect(listenerAt).toBeGreaterThan(-1);
    expect(busyAt).toBeGreaterThan(listenerAt);
    expect(inFlightOnAt).toBeGreaterThan(listenerAt);
    expect(returnAt).toBeGreaterThan(busyAt);
    expect(body.indexOf("reportTuiTurn('busy');", busyAt + 1)).toBe(-1);

    const teardown = body.slice(returnAt);
    const detachAt = teardown.indexOf("runTurnTeardownStep('stream-keys-detach', cleanup);");
    const disposeAt = teardown.indexOf("runTurnTeardownStep('esc-gate-dispose', () => { escGate.dispose(); });");
    const settleAt = teardown.indexOf('settleEscAbortPendingLines(chatLines, chatLinesStartIndex);');
    const threwAt = teardown.indexOf("logTurnThrew('settle-esc-lines', err);");
    const idleAt = teardown.indexOf("reportTuiTurn('idle');");
    expect(detachAt).toBeGreaterThan(-1);
    expect(disposeAt).toBeGreaterThan(detachAt);
    expect(settleAt).toBeGreaterThan(disposeAt);
    expect(threwAt).toBeGreaterThan(settleAt);
    expect(idleAt).toBeGreaterThan(threwAt);
    expect(/^\s*cleanup\(\);\s*$/m.test(teardown)).toBe(false);
  });
});
