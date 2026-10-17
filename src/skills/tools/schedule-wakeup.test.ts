import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInternalTurnGate, type StartTurnIfIdleOptions, type StartTurnIfIdleResult } from '../../dashboard/input/internal-turn.js';
import { PluginHost } from '../../plugins/core/host.js';
import { buildSessionRuntimeToolSpecs } from '../../session-runtime/index.js';
import {
  buildScheduleWakeupHostTool,
  createDashboardWakeupScheduler,
  createWakeupScheduler,
  registerScheduleWakeupHostTool,
  resolveWakeupAt,
  WAKEUP_MAX_CALLS_PER_TURN,
  WAKEUP_MAX_ENTRIES,
  WAKEUP_REPEAT_INVALID_ERROR,
  WAKEUP_REPEAT_TTL_MS,
  type WakeupSchedulerDeps,
} from './schedule-wakeup.js';

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

function rig(opts: { results?: StartTurnIfIdleResult[]; active?: (id: string) => boolean; maxEntries?: number } = {}) {
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

describe('바쁨 → rejected ⊕ 1분 뒤 재시도 1회', () => {
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
    expect(r.logs.at(-1)).toMatchObject({ event: 'fired', data: { retried: true } });
  });

  test('일회성: 재시도도 거부 → 놓침 한 줄 ⊕ 소멸(세 번째 청하기 0)', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'HumanTyping', detail: 'buffer' };
    const r = rig({ results: [busy, busy, busy] });
    r.s.schedule({ delaySeconds: 60, reason: '점검' });
    r.clock.advance(60 * 60_000);
    expect(r.calls).toHaveLength(2);
    expect(r.events().slice(-2)).toEqual(['rejected:HumanTyping', 'skipped:retry-exhausted']);
    expect(r.lines.at(-1)).toBe('⏰ 예약 깨움 놓침(w1): 점검 — HumanTyping');
    expect(r.s.list()).toHaveLength(0);
  });

  test('반복: 재시도도 거부 → 다음 회차로 넘어간다', () => {
    const busy: StartTurnIfIdleResult = { opened: false, reason: 'NotIdle', detail: 'turn-running' };
    const r = rig({ results: [busy, busy] });
    r.s.schedule({ repeatMinutes: 10, reason: '10분 점검' });
    r.clock.advance(10 * 60_000 + 60_000);
    expect(r.calls).toHaveLength(2);
    expect(r.s.list()).toHaveLength(1);
    r.clock.advance(9 * 60_000);
    expect(r.calls).toHaveLength(3);
    expect(r.logs.at(-1)!.event).toBe('fired');
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
    });
    expect(specs.filter(spec => spec.name === 'ScheduleWakeup')).toHaveLength(1);

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

  test('하니스 자식(ELANOUS_HARNESS_ROLE)엔 등록 안 함 → 카탈로그에도 없음', () => {
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    const scheduler = createWakeupScheduler({ startTurnIfIdle: () => ({ opened: false, reason: 'Disabled' }), log: () => {} });
    expect(registerScheduleWakeupHostTool(host, scheduler, { ELANOUS_HARNESS_ROLE: 'executor' })).toBe(false);
    expect(host.hostLLMTools().map(t => t.name)).not.toContain('ScheduleWakeup');
    const specs = buildSessionRuntimeToolSpecs({ userText: '점검', hostTools: host.hostLLMTools(), rich: false });
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
