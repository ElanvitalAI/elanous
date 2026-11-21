import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAimockLocal } from '../../../test/ux-sim/aimock-local.js';
import { buildPtyEnv, identityEnvKeys } from '../../agent/identity-env.js';
import { createInternalTurnGate, type StartTurnIfIdleOptions, type StartTurnIfIdleResult } from '../../dashboard/input/internal-turn.js';
import { PluginHost } from '../../plugins/core/host.js';
import { buildSessionRuntimeToolSpecs } from '../../session-runtime/index.js';
import { LogStore } from '../../mss/logging/log-store.js';
import { startPty, ptyAvailable } from '../../pty-shell/registry.js';
import {
  buildScheduleWakeupHostTool,
  createDashboardWakeupScheduler,
  createWakeupScheduler,
  WAKEUP_DEFER_MAX_MS,
  WAKEUP_RETRY_DELAY_MS,
  registerScheduleWakeupHostTool,
  resolveWakeupAt,
  WAKEUP_MAX_CALLS_PER_TURN,
  WAKEUP_MAX_ENTRIES,
  WAKEUP_REPEAT_INVALID_ERROR,
  WAKEUP_REPEAT_TTL_MS,
  type WakeupSchedulerDeps,
} from './schedule-wakeup.js';

/** 입력칸이 다시 떴다(턴 끝 · idle) — 스케줄러의 wrapPort 를 대시보드처럼 흔든다(가짜 port 는 아무것도 안 한다). */
function attachMounted(s: ReturnType<typeof createWakeupScheduler>): void {
  const port = { attach: (_requestYield: () => boolean) => {}, detach: (_opts?: { yielded?: boolean }) => {}, declined: (_detail: string) => {} };
  s.wrapPort(port).attach(() => true);
}

/** 가짜 시계 — 타이머를 손으로 돌린다(실시간 대기 0). */
function fakeClock(start = new Date(2026, 9, 17, 9, 0, 0, 0).getTime()) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    pending: () => timers.size,
    /** ms 만큼 시간을 흘리며 도래한 타이머를 시각 순으로 돌린다. */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

type Call = { input: string; opts: StartTurnIfIdleOptions };

function rig(opts: {
  results?: StartTurnIfIdleResult[];
  active?: (id: string) => boolean;
  maxEntries?: number;
  currentTurnId?: () => string | null;
  bus?: (e: { id: string; source: string; dedupeKey: string; arrivedAt: number; text: string }) => void;
} = {}) {
  const clock = fakeClock();
  const calls: Call[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const results = [...(opts.results ?? [])];
  let n = 0;
  const deps: WakeupSchedulerDeps = {
    startTurnIfIdle: (input, o) => {
      calls.push({ input, opts: o });
      return results.shift() ?? { opened: true, turnId: `auto-${++n}` };
    },
    isTurnActive: opts.active,
    ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
    ...(opts.bus ? { publishEvent: opts.bus as WakeupSchedulerDeps['publishEvent'] } : {}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    notify: (l) => lines.push(l),
    log: (c, event, data) => { expect(c).toBe('tui.wakeup'); logs.push({ event, data }); },
    ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
  };
  const s = createWakeupScheduler(deps);
  return { s, clock, calls, logs, lines, events: () => logs.map(l => `${l.event}:${String(l.data.reason ?? '')}`) };
}

describe('ScheduleWakeup — 예약 → 그 시각에 H2 문 1회', () => {
  test('delaySeconds 예약 → 시각 전엔 0회 · 시각에 startTurnIfIdle 1회(origin scheduled) ⊕ fired', () => {
    const r = rig();
    const res = r.s.schedule({ delaySeconds: 120, reason: 'PR #1 리뷰 결과 확인' });
    expect(res.ok).toBe(true);
    expect(r.lines[0]).toBe('⏰ 예약 깨움 09:02 (한 번): PR #1 리뷰 결과 확인');
    r.clock.advance(119_000);
    expect(r.calls).toHaveLength(0);
    r.clock.advance(1_000);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.opts).toEqual({ origin: 'scheduled', reason: 'PR #1 리뷰 결과 확인' });
    expect(r.calls[0]!.input).toContain('[예약 깨움 w1]');
    expect(r.events()).toEqual(['scheduled:PR #1 리뷰 결과 확인', 'fired:PR #1 리뷰 결과 확인']);
    // 일회성은 발화 뒤 사라진다 — 더 흘러도 다시 안 연다.
    expect(r.s.list()).toHaveLength(0);
    r.clock.advance(10 * 60_000);
    expect(r.calls).toHaveLength(1);
  });

  test('at «HH:MM» → 오늘 그 시각 · 지났으면 내일', () => {
    const base = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    expect(resolveWakeupAt('13:20', base)).toBe(new Date(2026, 9, 17, 13, 20).getTime());
    expect(resolveWakeupAt('08:59', base)).toBe(new Date(2026, 9, 18, 8, 59).getTime());
    expect(resolveWakeupAt('25:00', base)).toBeNull();
    expect(resolveWakeupAt('13시', base)).toBeNull();
    const r = rig();
    expect(r.s.schedule({ at: '09:30', reason: '다음 점검' }).ok).toBe(true);
    r.clock.advance(30 * 60_000);
    expect(r.calls).toHaveLength(1);
  });

  test('실제 H2 문과 이으면 입력칸이 비고 유휴일 때 내부 턴이 열린다(origin scheduled)', () => {
    const clock = fakeClock();
    let yields = 0;
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => '',
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      now: clock.now,
      log: () => {},
    });
    gate.port.attach(() => { yields++; return true; });
    const s = createWakeupScheduler({
      startTurnIfIdle: (i, o) => gate.startTurnIfIdle(i, o),
      isTurnActive: (id) => gate.isInternalTurnActive() && gate.lastTurnId() === id,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
    });
    s.schedule({ delaySeconds: 60, reason: '큐 점검' });
    clock.advance(60_000);
    expect(yields).toBe(1);
    const req = gate.takePending();
    expect(req).toMatchObject({ origin: 'scheduled', reason: '큐 점검' });
  });
});

describe('SCHEDULE-WAKEUP-TURN-CAP — 상한 키는 «실제로 도는 턴»에 묶인다(실제 문 + 실제 스케줄러)', () => {
  const wired = () => {
    const clock = fakeClock();
    const gate = createInternalTurnGate({
      isEnabled: () => true, isTurnRunning: () => false, getBufferText: () => '',
      getTypeaheadCount: () => 0, pendingKeyCount: () => 0, lastHumanKeyAt: () => 0, now: clock.now, log: () => {},
    });
    gate.port.attach(() => true);
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const s = createWakeupScheduler({
      startTurnIfIdle: (i, o) => gate.startTurnIfIdle(i, o),
      isTurnActive: (id) => gate.isInternalTurnActive() && gate.lastTurnId() === id,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      log: (_c, event, data) => logs.push({ event, data }),
      currentTurnId: () => gate.lastTurnId(),
    });
    // 한 턴에서 상한까지 쓰고(전부 허용), 바로 다음 호출이 거부되는지 본다.
    const isCapped = (): boolean => {
      const r = s.tryCancel('nope');
      return !r.ok && r.capped === true;
    };
    const burn = (): { allowed: number; capped: boolean } => {
      let allowed = 0;
      for (let i = 0; i < WAKEUP_MAX_CALLS_PER_TURN; i++) {
        if (!isCapped()) allowed++;
      }
      return { allowed, capped: isCapped() };
    };
    return { gate, s, logs, burn };
  };

  test('같은 턴의 7번째 호출은 거부 · 알림/우편 턴(문을 안 거침)마다 새 예산', () => {
    const w = wired();
    w.gate.noteHumanTurn();
    w.gate.noteTurnStarted();
    expect(w.burn()).toEqual({ allowed: WAKEUP_MAX_CALLS_PER_TURN, capped: true });
    expect(w.logs.filter(l => l.event === 'loop-capped').map(l => l.data.turnId)).toEqual(['human-1']);
    // seat-mail 알림 턴: noteHumanTurn 도 startTurnIfIdle 도 없이 시작 — 예전엔 human-1 이 그대로라 영구 잠금.
    w.gate.noteTurnStarted();
    expect(w.gate.lastTurnId()).toBe('turn-2');
    expect(w.burn()).toEqual({ allowed: WAKEUP_MAX_CALLS_PER_TURN, capped: true });
    w.gate.noteTurnStarted();
    expect(w.gate.lastTurnId()).toBe('turn-3');
    expect(w.burn()).toEqual({ allowed: WAKEUP_MAX_CALLS_PER_TURN, capped: true });
  });

  test('깨움 구동 턴(auto-N)도 새 예산 · 같은 id 로 시작을 알려도 한 번만 묶는다', () => {
    const w = wired();
    w.gate.noteHumanTurn();
    w.gate.noteTurnStarted();
    expect(w.burn().capped).toBe(true);
    expect(w.gate.startTurnIfIdle('깨움', { origin: 'scheduled' })).toEqual({ opened: true, turnId: 'auto-2' });
    expect(w.gate.takePending()?.turnId).toBe('auto-2');
    expect(w.gate.noteTurnStarted()).toBe('auto-2');
    expect(w.burn()).toEqual({ allowed: WAKEUP_MAX_CALLS_PER_TURN, capped: true });
    expect(w.gate.lastTurnId()).toBe('auto-2');
  });
});

describe('바쁨 → rejected ⊕ 버리지 않고 미룬다(TUI-WAKEUP-DEFER-NOT-DROP)', () => {
  test('일회성: 거부 → 60초 뒤 다시 → 열림', () => {
    const r = rig({ results: [{ opened: false, reason: 'NotIdle', detail: 'turn-running' }] });
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60_000);
    expect(r.calls).toHaveLength(1);
    expect(r.logs.at(-1)).toMatchObject({ event: 'rejected', data: { reason: 'NotIdle', detail: 'turn-running', retried: false } });
    r.clock.advance(59_000);
    expect(r.calls).toHaveLength(1);
    r.clock.advance(1_000);
    expect(r.calls).toHaveLength(2);
    expect(r.logs.at(-1)).toMatchObject({ event: 'fired', data: { retried: true, delaySec: 60 } }); // 늦게 깬 시간(지연 초) — 첫 예정(09:01)에서 60초
  });

  test('일회성: 턴이 길게 돌아도 버리지 않는다 — 바쁨이 끝난 뒤 첫 시도에 연다(10-22 OPT w7 02:38·02:39 NotIdle → dropped 사건)', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const r = rig({ results: [busy, busy, busy, busy, busy] });
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60_000 + 5 * 60_000);
    expect(r.calls).toHaveLength(6);
    expect(r.logs.at(-1)).toMatchObject({ event: 'fired', data: { retried: true } });
    expect(r.events()).not.toContain('skipped:retry-exhausted');
    expect(r.lines.some((l) => l.includes('놓침'))).toBe(false);
    expect(r.s.list()).toHaveLength(0);
  });

  test('② 상한 초과(장기 턴) — «대기» 한 줄 · 예약 생존(소실 0) · 턴 끝 배출 1회 ⊕ delaySec', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const tries = WAKEUP_DEFER_MAX_MS / WAKEUP_RETRY_DELAY_MS;
    const r = rig({ results: Array.from({ length: tries + 1 }, () => busy) });
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60_000 + WAKEUP_DEFER_MAX_MS + 60_000); // 장기 턴 — 미루기 상한을 훌쩍 넘는다
    expect(r.calls).toHaveLength(tries + 1);
    expect(r.calls.length).toBeLessThanOrEqual(WAKEUP_DEFER_MAX_MS / WAKEUP_RETRY_DELAY_MS + 2);
    // ⛔ 이전 계약(«놓침» 한 줄 ⊕ 소멸) 폐기(OP #88346) — 상한을 넘어도 drop 하지 않는다.
    expect(r.events().at(-1)).toBe('queued:NotIdle');
    expect(r.lines.at(-1)).toBe('⏰ 예약 깨움 대기(w1): 점검 — NotIdle · 턴이 끝나면 즉시 깨운다');
    expect(r.s.list()).toHaveLength(1); // 소실 0 — 예약이 살아 있다
    const before = r.calls.length;
    r.clock.advance(10 * 60_000); // 1분 재청 고리는 멈췄다 — 흐린(30분) 재청 전엔 더 안 청한다
    expect(r.calls).toHaveLength(before);
    attachMounted(r.s); // 장기 턴 끝 — 입력칸이 다시 떴다(마운트)
    r.clock.advance(1); // 0ms 미룬 배출
    expect(r.calls).toHaveLength(before + 1); // 정확히 1회 더
    const fired = r.logs.filter((l) => l.event === 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data.delaySec).toBeGreaterThanOrEqual(WAKEUP_DEFER_MAX_MS / 1000); // 출처: R-TST36 — 늦게 깬 시간(지연 초) 기록
    expect(r.s.list()).toHaveLength(0);
    attachMounted(r.s); // 다음 마운트 — 두 번째 배출은 없다
    r.clock.advance(1);
    expect(r.calls).toHaveLength(before + 1);
  });

  test('일회성: 상한 경계 — 30분 시점의 시도는 한다(그때 열리면 fired)', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const tries = WAKEUP_DEFER_MAX_MS / WAKEUP_RETRY_DELAY_MS;
    const r = rig({ results: Array.from({ length: tries }, () => busy) });
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60_000 + WAKEUP_DEFER_MAX_MS - 1);
    expect(r.calls).toHaveLength(tries);
    expect(r.events()).not.toContain('skipped:defer-exhausted');
    r.clock.advance(1);
    expect(r.calls).toHaveLength(tries + 1);
    expect(r.logs.at(-1)).toMatchObject({ event: 'fired' });
    expect(r.lines.some((l) => l.includes('놓침'))).toBe(false);
  });

  test('일회성: 상한 경계 — 30분 시점에도 바쁘면 «대기» 로 넘어간다(그 전엔 아님) · 소실 없음', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const tries = WAKEUP_DEFER_MAX_MS / WAKEUP_RETRY_DELAY_MS;
    const r = rig({ results: Array.from({ length: tries + 5 }, () => busy) });
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60_000 + WAKEUP_DEFER_MAX_MS - 1);
    expect(r.events()).not.toContain('queued:NotIdle'); // 그 전엔 대기 아님 — 아직 1분 재청 중
    r.clock.advance(1);
    expect(r.calls).toHaveLength(tries + 1);
    expect(r.events().at(-1)).toBe('queued:NotIdle');
    expect(r.lines.at(-1)).toBe('⏰ 예약 깨움 대기(w1): 점검 — NotIdle · 턴이 끝나면 즉시 깨운다');
    expect(r.s.list()).toHaveLength(1); // ⛔ 이전 계약(놓침 ⊕ 소멸) 폐기 — 상한을 넘겨도 살아 있다
  });

  test('일회성: 바쁨이 아닌 거부(Disabled)도 버리지 않는다 — 재청 1회 뒤 «턴 끝 배출» 대기(소실 0)', () => {
    const off: StartTurnIfIdleResult = { opened: false, reason: 'Disabled' };
    const r = rig({ results: [off, off, off] }); // 3번(60s 최초·120s 재청·1920s 흐린 재청)만 거부 — 4번째(마운트 배출)는 열림
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60 * 60_000); // 60s 최초 → 120s 1분 재청(소진) → 1920s 흐린(30분) 재청 — 셋 다 거부
    expect(r.calls).toHaveLength(3);
    expect(r.events().filter(e => e === 'rejected:Disabled')).toHaveLength(3);
    expect(r.events().at(-1)).toBe('queued:Disabled'); // K10 — 예전의 skipped:retry-exhausted ⊕ 소멸 폐기
    expect(r.events()).not.toContain('skipped:retry-exhausted');
    expect(r.s.list()).toHaveLength(1); // 소실 0
    expect(r.lines.filter(l => l.includes('대기'))).toHaveLength(1); // «대기» 고지는 구간마다 한 번
    attachMounted(r.s); // 턴 끝 — 마운트 배출 1회
    r.clock.advance(1);
    expect(r.calls).toHaveLength(4);
    expect(r.logs.filter(l => l.event === 'fired')).toHaveLength(1);
    expect(r.s.list()).toHaveLength(0);
  });

  test('반복: 바쁨이면 다음 회차 전까지 미루고, 회차와 겹치면 «턴 끝 배출» 대기 — 이후 원래 박자', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const r = rig({ results: Array.from({ length: 10 }, () => busy) });
    r.s.schedule({ repeatMinutes: 10, reason: '10분 점검' });
    r.clock.advance(10 * 60_000 + 9 * 60_000); // 09:10 틱 → 1분 재청으로 버티다 다음 회차(09:20) 와 겹친다
    expect(r.s.list()).toHaveLength(1);
    expect(r.events()).not.toContain('skipped:retry-exhausted');
    expect(r.events().at(-1)).toBe('queued:NotIdle'); // 예전엔 이 틱을 다음 회차로 접었다 — 이제 대기 큐로 간다(소실 0)
    r.clock.advance(2 * 60_000); // 턴이 아직 돈다 — 흐린(30분) 재청 외엔 조용
    expect(r.calls).toHaveLength(10);
    attachMounted(r.s); // 턴 끝 — 입력칸 마운트에 이번 회차를 마저 1회
    r.clock.advance(1);
    expect(r.logs.filter((l) => l.event === 'fired')).toHaveLength(1);
    expect(r.calls).toHaveLength(11);
    r.clock.advance(8 * 60_000);
    expect(r.calls).toHaveLength(11); // 다음 회차 전엔 조용
    r.clock.advance(1 * 60_000);
    expect(r.calls).toHaveLength(12); // 놓친 틱은 09:30 로 합쳐 원래 박자로 돌아간다
  });

  test('반복: 미룬 뒤 열리면 fired ⊕ 다음 회차는 원래 박자', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const r = rig({ results: [busy, busy] });
    r.s.schedule({ repeatMinutes: 10, reason: '10분 점검' });
    r.clock.advance(10 * 60_000 + 2 * 60_000);
    expect(r.calls).toHaveLength(3);
    expect(r.logs.at(-1)!.event).toBe('fired');
    r.clock.advance(8 * 60_000);
    expect(r.calls).toHaveLength(4);
  });

  describe('«턴 끝 배출» 대기 큐(ELN-SEAT-WAKEUP-SCHEDULE-FAIL · OP #88346 — 소실 0)', () => {
    test('① 턴 중 발화 → 입력칸 마운트(턴 끝)에 1회 배출 — 1분 재청을 기다리지 않는다 ⊕ delaySec', () => {
      const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
      const r = rig({ results: [busy] });
      r.s.schedule({ delaySeconds: 60, reason: '점검' });
      r.clock.advance(60_000); // 09:01 발화 — 턴이 돌아 거부
      expect(r.calls).toHaveLength(1);
      expect(r.events().at(-1)).toBe('rejected:NotIdle');
      r.clock.advance(30_000); // 아직 턴 중(09:02 재청 전)
      attachMounted(r.s); // 턴 끝 — 입력칸이 다시 떴다(agent-wake idle 감시와 같은 길)
      r.clock.advance(1); // 0ms 미룬 배출
      expect(r.calls).toHaveLength(2); // 재청 타이머를 기다리지 않고 곧바로 1회
      const fired = r.logs.filter((l) => l.event === 'fired');
      expect(fired).toHaveLength(1);
      expect(fired[0]!.data).toMatchObject({ delaySec: 30, retried: true }); // 늦게 깬 시간(지연 초) 기록
      expect(r.s.list()).toHaveLength(0); // 발화 뒤 소멸(일회성)
      attachMounted(r.s); // 다음 마운트 — 배출할 것 없음(1회 보장)
      r.clock.advance(1);
      expect(r.calls).toHaveLength(2);
    });

    test('③ 중복 — 재거부로 다시 실어도 · 마운트가 겹쳐도 배출은 1회', () => {
      const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
      const r = rig({ results: [busy, busy] });
      r.s.schedule({ delaySeconds: 60, reason: '점검' });
      r.clock.advance(60_000); // 09:01 발화 거부 → 큐 적재 + 09:02 재청
      expect(r.calls).toHaveLength(1);
      attachMounted(r.s); attachMounted(r.s); // 마운트 겹침 — 첫 attach 가 배출을 예약, 둘째는 빈 큐를 본다
      r.clock.advance(1);
      expect(r.calls).toHaveLength(2); // 배출 시도 — 아직 턴 중이어서 재거부(큐 재적재: 하나로)
      expect(r.logs.filter((l) => l.event === 'fired')).toHaveLength(0);
      attachMounted(r.s); // 그 턴도 끝났다 — 재적재된 큐 배출
      r.clock.advance(1);
      expect(r.calls).toHaveLength(3);
      expect(r.logs.filter((l) => l.event === 'fired')).toHaveLength(1); // 두 번 겹쳐 실려도 fired 는 1회
      expect(r.s.list()).toHaveLength(0);
    });
  });

  describe('R1(턴 근본 C4) — 도래·늦은 깨움이 버스 항목으로도 나온다(source wakeup)', () => {
    test('도래 → 버스 항목 1개: id·dedupeKey·deliverBy·text 원문 그대로(fail-open)', () => {
      const bus: Array<{ id: string; source: string; dedupeKey: string; arrivedAt: number; deliverBy?: number; text: string }> = [];
      const r = rig({ bus: e => bus.push(e) });
      r.s.schedule({ delaySeconds: 60, reason: '점검' });
      expect(bus).toHaveLength(0); // 예약 시점엔 버스 항목이 없다
      r.clock.advance(60_000);
      expect(bus).toHaveLength(1); // 도래 1회 = 항목 1개
      expect(bus[0]!.source).toBe('wakeup');
      expect(bus[0]!.id).toBe('wakeup-w1-0');
      expect(bus[0]!.dedupeKey).toBe('wakeup:w1:0');
      expect(bus[0]!.arrivedAt).toBe(new Date(2026, 9, 17, 9, 1, 0, 0).getTime());
      expect(bus[0]!.deliverBy).toBe(new Date(2026, 9, 17, 9, 31, 0, 0).getTime()); // dueAt + 30분(일회성)
      expect(bus[0]!.text).toContain('[예약 깨움 w1]');
      expect(bus[0]!.text).toContain('점검');
      expect(r.logs.filter(l => l.event === 'fired')).toHaveLength(1); // 문은 그대로 열렸다(버스는 보조)
    });

    test('반복 회차마다 dedupeKey 가 달라진다(회차별 항목) ⊕ publishEvent 가 throw 해도 발화는 산다(fail-open)', () => {
      const keys: string[] = [];
      const r = rig({ bus: e => { keys.push(e.dedupeKey); throw new Error('bus down'); } });
      r.s.schedule({ repeatMinutes: 1, reason: '1분 점검' });
      r.clock.advance(61_000); // 09:01 첫 회차
      expect(keys).toEqual(['wakeup:w1:0']);
      r.clock.advance(60_000); // 09:02 둘째 회차
      expect(keys).toEqual(['wakeup:w1:0', 'wakeup:w1:1']); // fireCount 로 회차가 갈린다
      expect(r.logs.filter(l => l.event === 'fired')).toHaveLength(2); // 버스가 죽어도 깨움은 열린다
    });

    test('재청 소진(일회성) → «늦은 깨움» 항목(dedupeKey :late) ⊕ 버스 없어도 대기·배출은 그대로', () => {
      const bus: Array<{ id: string; dedupeKey: string }> = [];
      const off: StartTurnIfIdleResult = { opened: false, reason: 'Disabled' };
      const r = rig({ results: [off, off, off], bus: e => bus.push({ id: e.id, dedupeKey: e.dedupeKey }) });
      r.s.schedule({ delaySeconds: 60, reason: '점검' });
      r.clock.advance(60 * 60_000); // 최초·재청·흐린 재청 — 셋 다 거부 → 소진
      // 도래 항목은 시도마다 같은 dedupeKey 로 나간다(버스가 중복으로 접는다) — 유니크로 판정.
      expect([...new Set(bus.map(e => e.dedupeKey))]).toEqual(['wakeup:w1:0', 'wakeup:w1:0:late']); // 도래 + 늦은 깨움
      expect(r.s.list()).toHaveLength(1); // 버스 항목과 무관 — 예약은 대기 큐에 살아 있다(소실 0)
      attachMounted(r.s);
      r.clock.advance(1);
      expect(r.logs.filter(l => l.event === 'fired')).toHaveLength(1);
    });
  });
});

describe('거부 규칙', () => {
  test('60초 미만 거부 · 7일 초과 거부 · 꼴 틀림 거부 · reason 비면 거부', () => {
    const r = rig();
    expect(r.s.schedule({ delaySeconds: 59, reason: 'x' })).toMatchObject({ ok: false });
    // 반올림 전 값으로 잰다 — 59.9999초는 60초가 아니다.
    expect(r.s.schedule({ delaySeconds: 59.9999, reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ delaySeconds: 7 * 24 * 3600 + 0.0001, reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ delaySeconds: 8 * 24 * 3600, reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ repeatMinutes: 0.5, reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ at: '9:00pm', reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ at: '10:00', delaySeconds: 120, reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ delaySeconds: 120, reason: '  ' })).toMatchObject({ ok: false });
    expect(r.s.schedule({ reason: 'x' })).toMatchObject({ ok: false });
    expect(r.s.list()).toHaveLength(0);
    expect(r.clock.pending()).toBe(0);
    // 반증: 경계값 60초는 받는다.
    expect(r.s.schedule({ delaySeconds: 60, reason: 'x' }).ok).toBe(true);
  });

  test(`상한 ${WAKEUP_MAX_ENTRIES}개 초과 거부 · cancel 하면 다시 받는다`, () => {
    const r = rig();
    for (let i = 0; i < WAKEUP_MAX_ENTRIES; i++) expect(r.s.schedule({ delaySeconds: 120 + i, reason: `r${i}` }).ok).toBe(true);
    const over = r.s.schedule({ delaySeconds: 300, reason: 'over' });
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.error).toContain(`상한 ${WAKEUP_MAX_ENTRIES}`);
    expect(r.s.cancel('w1')).toBe(true);
    expect(r.s.cancel('w1')).toBe(false);
    expect(r.s.schedule({ delaySeconds: 300, reason: 'again' }).ok).toBe(true);
    // 취소한 예약은 안 깬다.
    r.clock.advance(121_000);
    expect(r.calls.map(c => c.opts.reason)).not.toContain('r0');
  });
});

describe('TUI-H5-ONESHOT-SCHEMA — repeatMinutes:0 = 일회성 · 한 턴 호출 상한', () => {
  test('repeatMinutes:0 ⊕ delaySeconds → 일회성 예약 1(반복 없음 · 화면 «(한 번)») → 한 번 깨우고 소멸', () => {
    const r = rig();
    const res = r.s.schedule({ delaySeconds: 60, repeatMinutes: 0, reason: '한 번만' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.entry.repeatMs).toBeUndefined();
    expect(res.ok && res.entry.expiresAt).toBeUndefined();
    expect(r.lines).toEqual(['⏰ 예약 깨움 09:01 (한 번): 한 번만']);
    expect(r.logs.filter(l => l.event === 'rejected')).toHaveLength(0);
    r.clock.advance(60_000);
    expect(r.calls).toHaveLength(1);
    r.clock.advance(10 * 60_000);
    expect(r.calls).toHaveLength(1);
    expect(r.s.list()).toHaveLength(0);
    expect(r.events().filter(e => e.startsWith('scheduled'))).toHaveLength(1);
  });

  test('도구 경로도 같다: repeatMinutes 0 → scheduled 에 repeatMinutes 없음', async () => {
    const r = rig();
    const tool = buildScheduleWakeupHostTool(r.s);
    const out = await tool.handler({ delaySeconds: 60, repeatMinutes: 0, reason: '한 번만' }, {} as never) as { scheduled: Record<string, unknown> };
    expect(out.scheduled).toMatchObject({ id: 'w1' });
    expect(out.scheduled.repeatMinutes).toBeUndefined();
    expect(tool.description).toContain('OMIT repeatMinutes');
  });

  test('repeatMinutes 0 만 있고 시각이 없으면 거부(일회성인데 언제인지 모른다)', () => {
    const r = rig();
    expect(r.s.schedule({ repeatMinutes: 0, reason: 'x' })).toMatchObject({ ok: false });
  });

  test('음수·NaN·1 미만 소수는 거부 — 문구가 «일회성은 repeatMinutes 생략» 을 가리킨다', () => {
    const r = rig();
    for (const bad of [-1, Number.NaN, 0.5, Number.POSITIVE_INFINITY]) {
      const res = r.s.schedule({ delaySeconds: 60, repeatMinutes: bad, reason: 'x' });
      expect(res).toEqual({ ok: false, error: WAKEUP_REPEAT_INVALID_ERROR });
    }
    expect(WAKEUP_REPEAT_INVALID_ERROR).toContain('repeatMinutes 를 빼거나 0');
    expect(r.s.list()).toHaveLength(0);
  });

  test(`한 턴 ${WAKEUP_MAX_CALLS_PER_TURN + 1}번째 schedule·cancel → 거부 ⊕ loop-capped 1 · 다음 턴엔 다시 허용`, () => {
    let turn: string | null = 'human-1';
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const clock = fakeClock();
    const s = createWakeupScheduler({
      startTurnIfIdle: () => ({ opened: true, turnId: 'auto-1' }),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      log: (_c, event, data) => logs.push({ event, data }),
      currentTurnId: () => turn,
    });
    // 라이브 꼴: 예약 → 취소 → 예약 → … (거부된 호출도 센다)
    expect(s.schedule({ delaySeconds: 60, repeatMinutes: -3, reason: '고리' }).ok).toBe(false);
    for (let i = 0; i < WAKEUP_MAX_CALLS_PER_TURN - 1; i++) {
      if (i % 2 === 0) expect(s.schedule({ delaySeconds: 60, reason: '고리' }).ok).toBe(true);
      else expect(s.tryCancel(s.list()[0]!.id)).toEqual({ ok: true });
    }
    const capped = s.schedule({ delaySeconds: 60, reason: '고리' });
    expect(capped.ok).toBe(false);
    expect(capped.ok ? '' : capped.error).toContain('다음 턴에');
    const cappedLogs = logs.filter(l => l.event === 'loop-capped');
    expect(cappedLogs).toHaveLength(1);
    expect(cappedLogs[0]!.data).toMatchObject({ turnId: 'human-1', count: WAKEUP_MAX_CALLS_PER_TURN + 1 });
    // 취소도 막힌다(값으로 사유).
    const pending = s.list()[0]!.id;
    expect(s.tryCancel(pending)).toMatchObject({ ok: false, capped: true });
    expect(s.list()).toHaveLength(1);
    // 다음 턴 — 다시 허용.
    turn = 'auto-2';
    expect(s.tryCancel(pending)).toEqual({ ok: true });
    expect(s.schedule({ delaySeconds: 60, reason: '다음 턴' }).ok).toBe(true);
    expect(logs.filter(l => l.event === 'loop-capped')).toHaveLength(2);
  });

  test('반증: 턴 경계를 모르면(currentTurnId 없음) 상한을 걸지 않는다 · 대시보드 배선은 lastTurnId 를 넘긴다', () => {
    const r = rig();
    for (let i = 0; i < WAKEUP_MAX_CALLS_PER_TURN + 3; i++) {
      expect(r.s.schedule({ delaySeconds: 60, reason: `r${i}` }).ok).toBe(true);
      expect(r.s.cancel(`w${i + 1}`)).toBe(true);
    }
    expect(r.logs.filter(l => l.event === 'loop-capped')).toHaveLength(0);
    let turnId: string | null = null;
    const nullableTurn = rig({ currentTurnId: () => turnId });
    const nullableConflict = { at: 9, delaySeconds: 60, reason: 'unknown turn conflict' };
    for (let i = 0; i < WAKEUP_MAX_CALLS_PER_TURN + 2; i++) {
      expect(nullableTurn.s.schedule(nullableConflict).ok).toBe(false);
    }
    expect(nullableTurn.logs.filter(l => l.event === 'loop-capped')).toHaveLength(0);
    expect(nullableTurn.logs.filter(l => l.event === 'rejected')).toHaveLength(WAKEUP_MAX_CALLS_PER_TURN + 2);
    turnId = 'human-1';
    const firstKnown = nullableTurn.s.schedule(nullableConflict);
    expect(firstKnown.ok).toBe(false);
    const duplicateKnown = nullableTurn.s.schedule(nullableConflict);
    expect(duplicateKnown.ok).toBe(false);
    if (!duplicateKnown.ok) expect(duplicateKnown.error).toContain('재시도는 억제했다');
    turnId = null;
    const afterUnknown = nullableTurn.s.schedule(nullableConflict);
    expect(afterUnknown.ok).toBe(false);
    if (!afterUnknown.ok) expect(afterUnknown.error).not.toContain('재시도는 억제했다');
    expect(nullableTurn.logs.filter(l => l.event === 'loop-capped')).toHaveLength(0);
    const conflict = { at: 9, delaySeconds: 60, reason: '턴 미상 충돌' };
    expect(r.s.schedule(conflict).ok).toBe(false);
    expect(r.s.schedule(conflict).ok).toBe(false);
    expect(r.logs.filter(l => l.event === 'rejected')).toHaveLength(2);
    // 대시보드 경로: 실제 H2 문 → 사람 턴이 바뀌면 카운트가 리셋된다.
    const gate = createInternalTurnGate({
      isEnabled: () => true, isTurnRunning: () => false, getBufferText: () => '',
      getTypeaheadCount: () => 0, pendingKeyCount: () => 0, lastHumanKeyAt: () => 0, log: () => {},
    });
    const clock = fakeClock();
    const capLogs: unknown[] = [];
    const s = createDashboardWakeupScheduler(gate, {
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      log: (_c, e, d) => { if (e === 'loop-capped') capLogs.push(d); },
    });
    gate.noteHumanTurn();
    for (let i = 0; i < WAKEUP_MAX_CALLS_PER_TURN; i++) s.cancel('none');
    expect(s.tryCancel('none')).toMatchObject({ capped: true });
    gate.noteHumanTurn();
    expect(s.tryCancel('none')).toMatchObject({ ok: false, error: expect.stringContaining('no pending') });
    expect(capLogs).toHaveLength(1);
  });
});

describe('반복', () => {
  test('반복은 7일 뒤 소멸 — 그 뒤 청하기 0', () => {
    const r = rig();
    r.s.schedule({ repeatMinutes: 60 * 24, reason: '하루 점검' });
    r.clock.advance(WAKEUP_REPEAT_TTL_MS);
    expect(r.calls).toHaveLength(7);
    expect(r.s.list()).toHaveLength(0);
    expect(r.logs.some(l => l.event === 'skipped' && l.data.reason === 'expired')).toBe(true);
    r.clock.advance(3 * 24 * 3600_000);
    expect(r.calls).toHaveLength(7);
  });

  test('직전 회차가 아직 돌면 건너뜀(청하기 0 · 재시도 0) · 끝나면 다음 회차는 연다', () => {
    let running = true;
    const r = rig({ active: () => running });
    r.s.schedule({ repeatMinutes: 5, reason: '5분 점검' });
    r.clock.advance(5 * 60_000);
    expect(r.calls).toHaveLength(1);
    r.clock.advance(5 * 60_000);
    expect(r.calls).toHaveLength(1);
    expect(r.logs.at(-1)).toMatchObject({ event: 'skipped', data: { reason: 'previous-running', turnId: 'auto-1' } });
    running = false;
    r.clock.advance(5 * 60_000);
    expect(r.calls).toHaveLength(2);
  });

  test('반증: 직전 회차 판정이 없으면(isTurnActive 없음) 매 회차 연다', () => {
    const r = rig();
    r.s.schedule({ repeatMinutes: 5, reason: '5분 점검' });
    r.clock.advance(15 * 60_000);
    expect(r.calls).toHaveLength(3);
  });
});

describe('LLM 도구', () => {
  test('schedule / list / cancel · 오류는 값으로', async () => {
    const r = rig();
    const tool = buildScheduleWakeupHostTool(r.s);
    expect(tool.name).toBe('ScheduleWakeup');
    expect(tool.parameters).not.toHaveProperty('oneOf');
    expect(tool.parameters).not.toHaveProperty('anyOf');
    expect(tool.parameters).not.toHaveProperty('allOf');
    expect(tool.description).toContain('schedule_manage');
    const ctx = {} as never;
    const ok = await tool.handler({ delaySeconds: 90, reason: '점검' }, ctx) as { scheduled: { id: string; at: string } };
    expect(ok.scheduled).toMatchObject({ id: 'w1', at: '09:01' });
    expect(await tool.handler({ action: 'list' }, ctx)).toMatchObject({ wakeups: [{ id: 'w1', reason: '점검' }] });
    expect(await tool.handler({ delaySeconds: 10, reason: '점검' }, ctx)).toMatchObject({ error: expect.stringContaining('최소 60') });
    expect(await tool.handler({ action: 'cancel', id: 'w1' }, ctx)).toEqual({ cancelled: 'w1' });
    expect(await tool.handler({ action: 'cancel', id: 'w1' }, ctx)).toMatchObject({ error: expect.any(String) });
    expect(await tool.handler({ action: 'nope' }, ctx)).toMatchObject({ error: expect.any(String) });
  });

  test('통합: 대시보드와 같은 함수로 실제 PluginHost·H2 문에 등록 → 도구로 예약 → 그 시각 pending origin scheduled · 입력 버퍼 불변', async () => {
    const clock = fakeClock();
    let buffer = '';
    let yields = 0;
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => buffer,
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      now: clock.now,
      log: () => {},
    });
    // textInput 의 몫: 버퍼가 비었을 때만 물러난다(버퍼는 읽기만).
    gate.port.attach(() => { yields++; return buffer.length === 0; });
    const scheduler = createDashboardWakeupScheduler(gate, {
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {},
    });
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    expect(registerScheduleWakeupHostTool(host, scheduler, {})).toBe(true);
    // essential TUI 카탈로그(rich:false)에 실린다.
    const specs = buildSessionRuntimeToolSpecs({
      userText: '13:20 에 다시 점검', hostTools: host.hostLLMTools(), rich: false,
    } as Parameters<typeof buildSessionRuntimeToolSpecs>[0]);
    const wakeupSpecs = specs.filter(spec => spec.name === 'ScheduleWakeup');
    expect(wakeupSpecs).toHaveLength(1);
    expect(JSON.stringify(wakeupSpecs)).not.toMatch(/"(?:anyOf|oneOf|allOf)"\s*:/);

    const res = await host.dispatchTool('ScheduleWakeup', { delaySeconds: 60, reason: '큐 점검' });
    expect(res).toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
    clock.advance(59_000);
    expect(yields).toBe(0);
    clock.advance(1_000);
    expect(yields).toBe(1);
    expect(gate.takePending()).toMatchObject({ origin: 'scheduled', reason: '큐 점검' });
    expect(buffer).toBe('');

    // 사람이 쳐 둔 글이 있으면 거부 — 버퍼는 그대로, 물러남 요청 0.
    gate.noteTurnSettled();
    buffer = '사람이 치는 중';
    await host.dispatchTool('ScheduleWakeup', { delaySeconds: 60, reason: '두 번째' });
    clock.advance(60_000);
    expect(yields).toBe(1);
    expect(gate.takePending()).toBeNull();
    expect(buffer).toBe('사람이 치는 중');
  });

  test('충돌 인자 거부 → 오류의 교정 인자로 예약·발화, 같은 인자 재시도는 억제', async () => {
    const clock = fakeClock();
    let yields = 0;
    const gate = createInternalTurnGate({
      isEnabled: () => true, isTurnRunning: () => false, getBufferText: () => '',
      getTypeaheadCount: () => 0, pendingKeyCount: () => 0, lastHumanKeyAt: () => 0,
      now: clock.now, log: () => {},
    });
    gate.port.attach(() => { yields++; return true; });
    const events: string[] = [];
    const scheduler = createDashboardWakeupScheduler(gate, {
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      log: (_category, event) => events.push(event),
    });
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    expect(registerScheduleWakeupHostTool(host, scheduler, {})).toBe(true);
    const parameters = host.hostLLMTools().find(tool => tool.name === 'ScheduleWakeup')?.parameters as Record<string, unknown>;
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters).not.toHaveProperty('anyOf');
    expect(parameters).not.toHaveProperty('allOf');

    const conflicting = { at: '09:30', delaySeconds: 60, reason: '교정 예약' };
    gate.noteHumanTurn();
    const first = await host.dispatchTool('ScheduleWakeup', conflicting);
    const firstError = JSON.stringify(first);
    expect(firstError.includes('at 을 빼고 delaySeconds 사용')).toBe(true);
    expect(firstError.includes('{\\"reason\\":\\"교정 예약\\",\\"delaySeconds\\":60}')).toBe(true);
    expect(firstError.includes('같은 인자를 다시 보내지 말고 이 교정 인자로 한 번만 재시도하라')).toBe(true);
    expect(scheduler.list()).toHaveLength(0);

    const duplicate = await host.dispatchTool('ScheduleWakeup', conflicting);
    expect(duplicate).toMatchObject({ ok: true, result: { error: expect.stringContaining('같은 충돌 인자의 재시도는 억제했다') } });
    expect(scheduler.list()).toHaveLength(0);
    expect(events).toEqual(['rejected']);

    const corrected = await host.dispatchTool('ScheduleWakeup', { delaySeconds: 60, reason: '교정 예약' });
    expect(corrected).toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
    expect(events).toEqual(['rejected', 'scheduled']);
    clock.advance(60_000);
    expect(yields).toBe(1);
    expect(gate.takePending()).toMatchObject({ origin: 'scheduled', reason: '교정 예약' });
    expect(events).toEqual(['rejected', 'scheduled', 'fired']);
    scheduler.dispose();
  });

  // UX #115497 — strict-mode 호스트는 optional 필드를 빈 값으로 채워 보낸다. 빈 값·0·null = 미지정.
  describe('빈 값 정규화(UX #115497)', () => {
    const mk = () => {
      const r = rig({ currentTurnId: () => 'turn-1' });
      const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
      host.registerHostTool(buildScheduleWakeupHostTool(r.s));
      return { r, host };
    };
    const errOf = (x: { ok: boolean; result?: unknown }) => String((x.result as { error?: unknown }).error ?? '');

    test('repeatMinutes 단독 30분(+ at:"" · delaySeconds:0) 은 예약되고 list 에 1건 보인다', async () => {
      const { r, host } = mk();
      const res = await host.dispatchTool('ScheduleWakeup', { reason: '30분 보고', at: '', delaySeconds: 0, repeatMinutes: 30 });
      expect(res).toMatchObject({ ok: true, result: { scheduled: { id: 'w1', repeatMinutes: 30 } } });
      const listed = await host.dispatchTool('ScheduleWakeup', { action: 'list' });
      expect((listed as { result: { wakeups: unknown[] } }).result.wakeups).toHaveLength(1);
      expect(r.s.list()).toHaveLength(1);
    });
    test('repeatMinutes 단독(생략) 30분도 예약된다', async () => {
      const { r, host } = mk();
      const res = await host.dispatchTool('ScheduleWakeup', { reason: '30분 보고', repeatMinutes: 30 });
      expect(res).toMatchObject({ ok: true, result: { scheduled: { repeatMinutes: 30 } } });
      expect(r.s.list()).toHaveLength(1);
    });
    test('at:null · at:"  " 도 미지정 — delaySeconds 단독으로 예약', async () => {
      for (const at of [null, '  ']) {
        const { r, host } = mk();
        const res = await host.dispatchTool('ScheduleWakeup', { reason: '빈 at', at, delaySeconds: 120 });
        expect(res).toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
        expect(r.s.list()).toHaveLength(1);
      }
    });
    test('at 실값 + delaySeconds:0 → at 로 예약 · delaySeconds 실값 + at:"" → delay 로 예약', async () => {
      const a = mk();
      expect(await a.host.dispatchTool('ScheduleWakeup', { reason: 'at', at: '23:59', delaySeconds: 0 }))
        .toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
      const b = mk();
      expect(await b.host.dispatchTool('ScheduleWakeup', { reason: 'delay', at: '', delaySeconds: 90 }))
        .toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
    });
    test('at 단독 · delaySeconds 단독 은 예약된다', async () => {
      const a = mk();
      expect(await a.host.dispatchTool('ScheduleWakeup', { reason: 'at only', at: '23:59' })).toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
      const b = mk();
      expect(await b.host.dispatchTool('ScheduleWakeup', { reason: 'delay only', delaySeconds: 60 })).toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });
    });
    test('at 실값 + delaySeconds 실값 은 계속 명시 오류로 거부한다', async () => {
      const { r, host } = mk();
      const res = await host.dispatchTool('ScheduleWakeup', { reason: '충돌', at: '23:59', delaySeconds: 60 }) as { ok: boolean; result?: unknown };
      expect(errOf(res)).toContain('at 과 delaySeconds 는 둘 중 하나만');
      expect(r.s.list()).toHaveLength(0);
    });
    test('전부 빈 값(at:"" · delaySeconds:0 · repeat 없음)은 «하나는 있어야 한다» 로 거부', async () => {
      const { r, host } = mk();
      const res = await host.dispatchTool('ScheduleWakeup', { reason: '빈', at: '', delaySeconds: 0 }) as { ok: boolean; result?: unknown };
      expect(errOf(res)).toContain('중 하나는 있어야 한다');
      expect(r.s.list()).toHaveLength(0);
    });
    test('list · cancel 회귀', async () => {
      const { r, host } = mk();
      await host.dispatchTool('ScheduleWakeup', { reason: 'x', delaySeconds: 60, at: '' });
      expect(await host.dispatchTool('ScheduleWakeup', { action: 'cancel', id: 'w1' })).toMatchObject({ ok: true, result: { cancelled: 'w1' } });
      expect(r.s.list()).toHaveLength(0);
    });
  });

  test('스케줄 handler 는 at·delaySeconds·repeatMinutes 모두 빠진 요청을 실행하지 않는다', async () => {
    const r = rig({ currentTurnId: () => 'turn-missing-time' });
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    host.registerHostTool(buildScheduleWakeupHostTool(r.s));

    const result = await host.dispatchTool('ScheduleWakeup', { reason: '누락 경계' });
    expect(result).toMatchObject({ ok: true, result: { error: expect.stringContaining('중 하나는 있어야 한다') } });
    expect(r.s.list()).toHaveLength(0);
    expect(r.logs).toContainEqual(expect.objectContaining({ event: 'rejected', data: expect.objectContaining({ reason: 'invalid' }) }));
  });

  test('타입이 틀린 at 존재를 보존하고 같은 인자도 턴 cap 예산을 소비한다', async () => {
    let turn: string | null = 'human-1';
    const clock = fakeClock();
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const scheduler = createWakeupScheduler({
      startTurnIfIdle: () => ({ opened: true, turnId: 'auto-1' }),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      currentTurnId: () => turn,
      log: (_category, event, data) => logs.push({ event, data }),
    });
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    host.registerHostTool(buildScheduleWakeupHostTool(scheduler));

    const malformed = { at: 9, delaySeconds: 60, reason: '타입 불일치' };
    const first = await host.dispatchTool('ScheduleWakeup', malformed);
    const firstError = String(first.ok ? (first.result as { error: unknown }).error : first.error);
    expect(firstError).toContain('{\"reason\":\"타입 불일치\",\"delaySeconds\":60}');
    expect(firstError).not.toContain('atProvided');
    expect(firstError).toContain('at 과 delaySeconds 는 둘 중 하나만');
    const corrected = await host.dispatchTool('ScheduleWakeup', { delaySeconds: 60, reason: '타입 불일치' });
    expect(corrected).toMatchObject({ ok: true, result: { scheduled: { id: 'w1' } } });

    const conflictB = { at: 10, delaySeconds: 60, reason: '다른 충돌 B' };
    const firstB = await host.dispatchTool('ScheduleWakeup', conflictB);
    expect(firstB).toMatchObject({ ok: true, result: { error: expect.stringContaining('at 과 delaySeconds 는 둘 중 하나만') } });
    const duplicateA = await host.dispatchTool('ScheduleWakeup', malformed);
    expect(duplicateA).toMatchObject({ ok: true, result: { error: expect.stringContaining('같은 충돌 인자의 재시도는 억제했다') } });

    for (const at of [11, 12]) {
      const conflict = await host.dispatchTool('ScheduleWakeup', { at, delaySeconds: 60, reason: '다른 충돌' });
      expect(conflict).toMatchObject({ ok: true, result: { error: expect.stringContaining('at 과 delaySeconds 는 둘 중 하나만') } });
    }
    const capped = await host.dispatchTool('ScheduleWakeup', { at: 14, delaySeconds: 60, reason: '상한 확인' });
    expect(capped).toMatchObject({ ok: true, result: { error: expect.stringContaining(`${WAKEUP_MAX_CALLS_PER_TURN}회 상한`) } });
    expect(logs.filter((row) => row.event === 'rejected')).toHaveLength(4);
    expect(logs.filter((row) => row.event === 'loop-capped')).toHaveLength(1);

    turn = 'human-2';
    const nextTurnConflict = await host.dispatchTool('ScheduleWakeup', malformed);
    const nextTurnError = String(nextTurnConflict.ok ? (nextTurnConflict.result as { error: unknown }).error : nextTurnConflict.error);
    expect(nextTurnError).toContain('at 과 delaySeconds 는 둘 중 하나만');
    expect(nextTurnError).not.toContain('재시도는 억제했다');
    const afterTurn = await host.dispatchTool('ScheduleWakeup', { delaySeconds: 60, reason: '다음 턴 예약' });
    expect(afterTurn).toMatchObject({ ok: true, result: { scheduled: { id: 'w2' } } });
    expect(logs.filter((row) => row.event === 'rejected')).toHaveLength(5);
    scheduler.dispose();
  });

  test('실제 격리 --test TUI: 충돌 거부 직후 교정 예약 · A→B→A 억제 · tui.wakeup 로그', async () => {
    if (!ptyAvailable()) throw new Error('PTY unavailable');
    const prompt = 'UX_WAKEUP_ARGS_REPAIR_29142: use ScheduleWakeup exactly as instructed';
    const conflict = { at: 9, delaySeconds: 60, reason: '29142 교정 시험' };
    const mockSession = await startAimockLocal((mock) => {
      mock.on({ userMessage: prompt, hasToolResult: false }, {
        toolCalls: [{ id: 'wakeup-conflict-1', name: 'ScheduleWakeup', arguments: JSON.stringify(conflict) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-conflict-1', toolResultContains: 'at 을 빼고 delaySeconds 사용' }, {
        toolCalls: [{ id: 'wakeup-corrected', name: 'ScheduleWakeup', arguments: JSON.stringify({ delaySeconds: 60, reason: conflict.reason }) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-corrected' }, {
        toolCalls: [{ id: 'wakeup-conflict-duplicate-a', name: 'ScheduleWakeup', arguments: JSON.stringify(conflict) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-conflict-duplicate-a' }, {
        toolCalls: [{ id: 'wakeup-conflict-2', name: 'ScheduleWakeup', arguments: JSON.stringify({ at: 10, delaySeconds: 60, reason: '다른 충돌 2' }) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-conflict-2' }, {
        toolCalls: [{ id: 'wakeup-conflict-duplicate-a-again', name: 'ScheduleWakeup', arguments: JSON.stringify(conflict) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-conflict-duplicate-a-again' }, {
        toolCalls: [{ id: 'wakeup-conflict-3', name: 'ScheduleWakeup', arguments: JSON.stringify({ at: 11, delaySeconds: 60, reason: '다른 충돌 3' }) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-conflict-3' }, {
        toolCalls: [{ id: 'wakeup-loop-capped', name: 'ScheduleWakeup', arguments: JSON.stringify({ at: 13, delaySeconds: 60, reason: '상한 호출' }) }],
      });
      mock.on({ userMessage: prompt, toolCallId: 'wakeup-loop-capped' }, { content: '교정된 예약이 한 번 등록됐고 추가 충돌은 턴 상한에서 멈췄습니다.' });
    });

    const root = mkdtempSync(join(tmpdir(), 'wakeup-tui-29142-'));
    const home = join(root, 'home');
    const testRoot = join(root, 'test-state');
    mkdirSync(home, { recursive: true });
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(join(testRoot, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      llm: { provider: 'local', model: 'test-model', baseUrl: `${mockSession.mock.url}/v1` },
      debug: { level: 'diag', file: true },
    }));

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const executable = join(repoRoot, 'bin/elanous.mjs');
    const allowedEnv = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR', 'LC_ALL', 'LC_CTYPE']);
    const unsetEnv = [...new Set([...Object.keys(buildPtyEnv()), ...Object.keys(process.env), ...identityEnvKeys()])]
      .filter((key) => !allowedEnv.has(key));
    let pty: ReturnType<typeof startPty> | undefined;
    const logPath = join(testRoot, 'logs/logs.db');
    const deadline = Date.now() + 60_000;
    let observed: ReturnType<LogStore['query']> = [];
    try {
      pty = startPty({
        cmd: process.execPath,
        args: [executable, `--test=${testRoot}`],
        workdir: repoRoot,
        cols: 120,
        rows: 40,
        env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm-256color', LANG: 'en', ELANOUS_DEBUG_LEVEL: 'diag' },
        unsetEnv,
      });
      const bootDeadline = Date.now() + 20_000;
      while (Date.now() < bootDeadline && pty.isAlive()) {
        const screen = await pty.renderScreen();
        if (screen.includes('❯')) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!pty.isAlive()) throw new Error(`TUI exited during boot: ${pty.snapshot().slice(-3000)}`);
      if (!pty.canWrite()) throw new Error(`TUI PTY is not writable (mode=${pty.accessMode})`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      pty.write(prompt);
      const inputDeadline = Date.now() + 5_000;
      let typedScreen = '';
      while (Date.now() < inputDeadline && pty.isAlive()) {
        typedScreen = await pty.renderScreen();
        if (typedScreen.includes('UX_WAKEUP_ARGS_REPAIR_29142')) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!typedScreen.includes('UX_WAKEUP_ARGS_REPAIR_29142')) throw new Error(`TUI did not echo typed prompt:\n${typedScreen}`);
      pty.write('\r');

      while (Date.now() < deadline && pty.isAlive()) {
        try {
          const store = LogStore.openReadOnly(logPath);
          try { observed = store.query({ categories: ['tui.wakeup'], limit: 100 }); }
          finally { store.close(); }
        } catch { /* log db is created during the isolated TUI boot */ }
        const events = observed.map((row) => row.event);
        if (events.includes('loop-capped') && events.includes('scheduled')) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      const raw = execFileSync(process.execPath, [executable, `--test=${testRoot}`, 'logs', '--exact-category', 'tui.wakeup', '--since', '10m', '--json'], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm-256color', LANG: 'en', ELANOUS_DEBUG_LEVEL: 'off' },
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const parsed = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; data: string | Record<string, unknown> });
      const wakeupEvents = parsed.filter((row) => row.event === 'rejected' || row.event === 'scheduled' || row.event === 'loop-capped');
      const decoded = wakeupEvents.map((row) => ({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) as Record<string, unknown> : row.data }));
      const typedConflict = decoded.find((row) => row.event === 'rejected' && String(row.data.error).includes('at 과 delaySeconds 는 둘 중 하나만'));
      expect(typedConflict).toBeDefined();
      expect(String(typedConflict?.data.error)).toContain('at 을 빼고 delaySeconds 사용');
      expect(String(typedConflict?.data.error)).toContain('"delaySeconds":60');
      expect(decoded.filter((row) => row.event === 'scheduled' && row.data.reason === conflict.reason)).toHaveLength(1);
      expect(decoded.filter((row) => row.event === 'loop-capped')).toHaveLength(1);
      expect(wakeupEvents.map((row) => row.event)).toEqual(['rejected', 'scheduled', 'rejected', 'rejected', 'loop-capped']);
      expect(JSON.stringify(mockSession.mock.getRequests())).toContain('at 을 빼고 delaySeconds 사용');
      expect(mockSession.mock.getRequests().length).toBeGreaterThanOrEqual(8);
      process.stdout.write(`[tui.wakeup raw logs]\n${raw}`);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nTUI screen:\n${await pty?.renderScreen()}\nAIMock requests=${JSON.stringify(mockSession.mock.getRequests())}`);
    } finally {
      if (pty?.isAlive()) pty.kill('SIGTERM');
      const stopDeadline = Date.now() + 5_000;
      while (pty?.isAlive() && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (pty?.isAlive()) pty.kill('SIGKILL');
      await mockSession.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test('하니스 자식(ELANOUS_HARNESS_ROLE)엔 등록 안 함 → 카탈로그에도 없음', () => {
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    const scheduler = createWakeupScheduler({ startTurnIfIdle: () => ({ opened: false, reason: 'Disabled' }), log: () => {} });
    expect(registerScheduleWakeupHostTool(host, scheduler, { ELANOUS_HARNESS_ROLE: 'executor' })).toBe(false);
    expect(host.hostLLMTools().map(t => t.name)).not.toContain('ScheduleWakeup');
    const specs = buildSessionRuntimeToolSpecs({
      userText: '점검', hostTools: host.hostLLMTools(), rich: false,
    } as Parameters<typeof buildSessionRuntimeToolSpecs>[0]);
    expect(specs.map(spec => spec.name)).not.toContain('ScheduleWakeup');
    scheduler.dispose();
  });

  test('대시보드는 위 두 함수로 잇는다(실물 경로 = 시험 경로)', () => {
    const src = readFileSync(join(import.meta.dir, '../../dashboard/index.ts'), 'utf8');
    expect(src).toContain('createDashboardWakeupScheduler(internalTurnGate, {');
    expect(src).toContain('registerScheduleWakeupHostTool(pluginHost, wakeupScheduler);');
    expect(src).toContain('wakeupScheduler.dispose();');
  });
});

describe('ELN-SEAT-TURN-PACING — a minimum-interval refusal defers the wakeup to retryAt, never drops it', () => {
  test('Cap with retryAt → one retry exactly at retryAt → fired', () => {
    const clock0 = new Date(2026, 9, 17, 9, 0, 0, 0).getTime();
    const GAP = 20_000; // Source: a gap shorter than WAKEUP_RETRY_DELAY_MS, to prove retryAt (not the 1-minute retry) is used
    const r = rig({ results: [{ opened: false, reason: 'Cap', detail: 'pacing:min-interval', retryAt: clock0 + 60_000 + GAP }] });
    r.s.schedule({ delaySeconds: 60, reason: 'heartbeat' });
    r.clock.advance(60_000);
    expect(r.calls).toHaveLength(1);
    r.clock.advance(GAP - 1);
    expect(r.calls).toHaveLength(1);
    r.clock.advance(1);
    expect(r.calls).toHaveLength(2);
    expect(r.events()).toEqual(['scheduled:heartbeat', 'rejected:Cap', 'fired:heartbeat']);
    expect(r.lines.some(line => line.includes('놓침'))).toBe(false);
  });
});
