// TURN-START-BLOCK-REST 2단계 — preamble 뒤 «무엇이» 막았나를 덩어리로 가른다(`tui.turn-start segments`).
//   ⭐ 반증: 경계 측정(markAt)을 빼면 segmentsMs 가 비어 칸 모양 시험이 실패한다.
import { afterEach, describe, expect, test } from 'bun:test';
import { createInputLagProbe } from '../tui/input-lag-probe.js';
import {
  TURN_START_CATEGORY,
  TURN_START_SEGMENTS_EVENT,
  TURN_START_TRACE_CAP_MS,
  beginTurnStartSegments,
  createTurnStartSegments,
  endTurnStartSegments,
  markTurnStartSegment,
  setTurnStartSegments,
  type TurnStartSegments,
} from './turn-start-segments.js';

afterEach(() => setTurnStartSegments(null));

/** 박동은 진짜 input-lag 프로브의 것(가짜 시계·타이머) — 덩어리 기록기는 그 창을 읽는다. */
function segRig(opts: { enabled?: boolean } = {}) {
  const flag = { enabled: opts.enabled };
  const lines: Array<{ category: string; event: string; data: TurnStartSegments }> = [];
  const clock = { t: 1000, reads: 0 };
  const timeouts: Array<() => void> = [];
  const timeoutMs: number[] = [];
  const handles: object[] = [];
  const cleared: object[] = [];
  let beat: () => void = () => {};
  const probe = createInputLagProbe({
    now: () => clock.t,
    isBusy: () => true,
    log: () => {},
    setIntervalFn: (fn) => { beat = fn; return {}; },
    clearIntervalFn: () => {},
    setTimeoutFn: () => ({}),
  });
  const rec = createTurnStartSegments({
    beats: probe.beats,
    now: () => { clock.reads += 1; return clock.t; },
    isBusy: () => true,
    ...(opts.enabled !== undefined ? { isEnabled: () => flag.enabled! } : {}),
    log: (category, event, data) => lines.push({ category, event, data }),
    setTimeoutFn: (fn, ms) => { const h = {}; timeouts.push(fn); timeoutMs.push(ms); handles.push(h); return h; },
    clearTimeoutFn: (h) => { cleared.push(h); },
  });
  return {
    rec, probe, lines, clock, flag, timeoutMs, handles, cleared,
    beat: () => beat(),
    flush: () => { for (const fn of timeouts.splice(0)) fn(); },
  };
}

describe('tui.turn-start segments', () => {
  test('덩어리 칸 모양 — 순서·ms·박동이 돈 덩어리·최대 동기 덩어리·창 루프 지연', () => {
    const r = segRig();
    r.clock.t += 20; r.beat();
    r.rec.begin('s1', 'turn-1');
    r.clock.t += 5; r.rec.mark('s1', 'preambleTools');
    r.clock.t += 8; r.rec.mark('s1', 'preamble');
    r.clock.t += 30; r.rec.mark('s1', 'autoCompact');
    // 루프가 돈다(await) — 박동 하나. 다음 덩어리는 박동 뒤 꼬리만 동기로 센다.
    r.clock.t += 10; r.beat();
    r.clock.t += 4; r.rec.mark('s1', 'optionalSpecs');
    r.clock.t += 60; r.rec.mark('s1', 'route');
    r.clock.t += 2; r.rec.end('s1', 'streamOpen');
    expect(r.lines).toHaveLength(0);     // 막힘은 루프가 풀린 뒤 박동에 찍힌다 — 줄은 미룬다
    expect(r.timeoutMs.at(-1)).toBe(40); // 기존 turn-start 와 같은 박동 두 번 간격
    r.clock.t += 1; r.beat();            // 66ms 막힘이 풀린 첫 박동
    r.flush();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.category).toBe(TURN_START_CATEGORY);
    expect(r.lines[0]!.event).toBe(TURN_START_SEGMENTS_EVENT);
    expect(r.lines[0]!.data).toEqual({
      segmentsMs: { preambleTools: 5, preamble: 8, autoCompact: 30, optionalSpecs: 14, route: 60, streamOpen: 2 },
      order: ['preambleTools', 'preamble', 'autoCompact', 'optionalSpecs', 'route', 'streamOpen'],
      yielded: ['optionalSpecs'],
      totalMs: 119,
      closedAfterMs: 119,
      preTraceMs: 0,
      syncBlockMaxMs: 66,
      syncBlockSegments: ['optionalSpecs', 'route', 'streamOpen'],
      loopDelayMs: { p99: 47, max: 47 },
      endedBy: 'stream-open',
      key: 's1',
      turnId: 'turn-1',
      busy: true,
    });
    r.rec.dispose();
  });

  test('키가 다른 경계는 버린다 — 시계 0번 · 덩어리 안 섞임 · 남의 첫 요청이 트레이스를 안 닫는다', () => {
    const r = segRig();
    r.rec.begin('dash');
    r.clock.t += 3; r.rec.mark('dash', 'promptRuntime');
    const before = r.clock.reads;
    r.rec.mark('other', 'route');
    r.rec.end('other', 'streamOpen');
    expect(r.clock.reads).toBe(before);
    r.clock.t += 2; r.rec.end('dash', 'streamOpen');
    r.flush();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.data.key).toBe('dash');
    expect(r.lines[0]!.data.order).toEqual(['promptRuntime', 'streamOpen']);
    r.rec.dispose();
  });

  test('totalMs 는 공개된 덩어리 값의 합이다 — 소수 시각에서도 어긋나지 않는다', () => {
    const r = segRig();
    r.rec.begin('s');
    r.clock.t += 0.06; r.rec.mark('s', 'a');
    r.clock.t += 0.06; r.rec.mark('s', 'b');
    r.clock.t += 0.33; r.rec.end('s', 'streamOpen');
    r.flush();
    expect(r.lines[0]!.data.segmentsMs).toEqual({ a: 0.1, b: 0.1, streamOpen: 0.3 });
    expect(r.lines[0]!.data.totalMs).toBe(0.5);
    r.rec.dispose();
  });

  test('열기 전에 이미 막혀 있던 시간(preTrace)이 첫 동기 덩어리의 머리로 들어간다', () => {
    const r = segRig();
    r.clock.t += 20; r.beat();
    r.clock.t += 50;                     // 트레이스를 열기 전 동기 일(박동 없음)
    r.rec.begin('s');
    r.clock.t += 10; r.rec.mark('s', 'promptRuntime');
    r.rec.end('s', 'streamOpen');
    r.flush();
    expect(r.lines[0]!.data.preTraceMs).toBe(50);
    expect(r.lines[0]!.data.syncBlockMaxMs).toBe(60);
    expect(r.lines[0]!.data.syncBlockSegments).toEqual(['preTrace', 'promptRuntime', 'streamOpen']);
    expect(r.lines[0]!.data.totalMs).toBe(10);
    r.rec.dispose();
  });

  test('같은 이름이 또 오면 #2 — 턴마다 preamble 이 두 번(대시보드 ⊕ ACP)', () => {
    const r = segRig();
    r.rec.begin('s');
    r.clock.t += 3; r.rec.mark('s', 'preamble');
    r.clock.t += 1; r.rec.mark('s', 'acpHandoff');
    r.clock.t += 2; r.rec.mark('s', 'preamble');
    r.rec.end('s', 'streamOpen');
    r.flush();
    expect(r.lines[0]!.data.order).toEqual(['preamble', 'acpHandoff', 'preamble#2', 'streamOpen']);
    expect(r.lines[0]!.data.segmentsMs['preamble#2']).toBe(2);
    r.rec.dispose();
  });

  test('debug 가 꺼진 턴은 트레이스를 안 연다 — 경계가 시계를 0번 읽고 줄도 0', () => {
    const r = segRig({ enabled: false });
    const before = r.clock.reads;
    r.rec.begin('s');
    for (const name of ['preambleTools', 'messages', 'tools', 'route', 'model']) r.rec.mark('s', name);
    r.rec.end('s', 'streamOpen');
    expect(r.clock.reads).toBe(before);
    r.flush();
    expect(r.lines).toHaveLength(0);
    r.rec.dispose();
  });

  test('열린 트레이스 뒤 debug 를 끄고 새 턴이 오면 — 시계 0번으로 앞 트레이스를 superseded 로 닫는다', () => {
    const r = segRig({ enabled: true });
    r.rec.begin('a', 'ta');
    r.clock.t += 7; r.rec.mark('a', 'promptRuntime');
    r.flag.enabled = false;
    const before = r.clock.reads;
    r.rec.begin('b', 'tb');
    r.rec.mark('b', 'route');
    r.rec.end('b', 'streamOpen');
    expect(r.clock.reads).toBe(before);
    expect(r.lines.map((l) => [l.data.turnId, l.data.endedBy, l.data.closedAfterMs])).toEqual([['ta', 'superseded', 7]]);
    r.flush();
    expect(r.lines).toHaveLength(1);
    r.rec.dispose();
  });

  test('첫 스트림 요청이 끝내 안 오면 상한(cap)으로 · 새 턴이 오면 superseded 로 닫는다 · 닫으면 타이머를 푼다', () => {
    const r = segRig();
    r.rec.begin('a', 'ta');
    r.clock.t += 7; r.rec.mark('a', 'preambleTools');
    r.rec.begin('b', 'tb');
    expect(r.lines.map((l) => [l.data.turnId, l.data.endedBy])).toEqual([['ta', 'superseded']]);
    expect(r.lines[0]!.data.totalMs).toBe(7);
    expect(r.lines[0]!.data.closedAfterMs).toBe(7);
    expect(r.cleared).toEqual([r.handles[0]]);
    r.clock.t += 3; r.rec.mark('b', 'preambleTools');
    expect(r.timeoutMs).toEqual([TURN_START_TRACE_CAP_MS, TURN_START_TRACE_CAP_MS]);
    r.clock.t += TURN_START_TRACE_CAP_MS - 3;
    r.flush();                           // 상한 타이머 — 15초 뒤 닫힘
    expect(r.lines.map((l) => [l.data.turnId, l.data.endedBy])).toEqual([['ta', 'superseded'], ['tb', 'cap']]);
    expect(r.lines[1]!.data.segmentsMs).toEqual({ preambleTools: 3 });
    expect(r.lines[1]!.data.closedAfterMs).toBe(TURN_START_TRACE_CAP_MS);
    r.rec.mark('b', 'route');            // 닫힌 뒤 경계는 무시
    r.flush();
    expect(r.lines).toHaveLength(2);
    r.rec.dispose();
  });

  test('stream-open 으로 닫으면 상한 타이머를 푼다 · dispose 는 열린 트레이스의 타이머를 풀고 미뤄 둔 줄을 안 낸다', () => {
    const r = segRig();
    r.rec.begin('a');
    r.rec.end('a', 'streamOpen');
    expect(r.cleared).toEqual([r.handles[0]]);
    r.rec.begin('b');
    r.rec.dispose();
    expect(r.cleared).toEqual([r.handles[0], r.handles[2]]);
    r.flush();
    expect(r.lines).toHaveLength(0);
  });

  test('등록 자리 — 등록이 없거나 키가 없으면 아무 일도 안 한다 · 등록되면 같은 기록기로 간다', () => {
    expect(() => {
      beginTurnStartSegments('s');
      markTurnStartSegment('s', 'route');
      endTurnStartSegments('s', 'streamOpen');
    }).not.toThrow();
    const r = segRig();
    setTurnStartSegments(r.rec);
    beginTurnStartSegments('s', 't');
    const before = r.clock.reads;
    markTurnStartSegment(undefined, 'route');
    expect(r.clock.reads).toBe(before);
    r.clock.t += 4; markTurnStartSegment('s', 'messages');
    endTurnStartSegments('s', 'streamOpen');
    r.flush();
    expect(r.lines[0]!.data.order).toEqual(['messages', 'streamOpen']);
    r.rec.dispose();
  });
});

describe('input-lag 프로브의 박동 창(beats)', () => {
  test('마지막 박동 시각과 그 뒤 루프 지연을 같은 시계로 준다', () => {
    const r = segRig();
    expect(r.probe.beats.heartbeatMs).toBe(20);
    r.clock.t += 20; r.beat();
    r.clock.t += 50; r.beat();           // 드리프트 30
    expect(r.probe.beats.lastBeatAt()).toBe(1070);
    expect(r.probe.beats.loopDelaySince(1000)).toEqual({ p99: 30, max: 30 });
    expect(r.probe.beats.loopDelaySince(1070)).toEqual({ p99: 0, max: 0 });
    r.probe.dispose();
  });
});
