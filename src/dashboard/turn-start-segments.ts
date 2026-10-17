// TURN-START-BLOCK-REST 2단계 — 턴 시작 덩어리 관측(`tui.turn-start segments`).
//
// 1단계(#28821)가 turn-preamble 빌더 전체 ≤10ms 인데 같은 창의 `tui.input-lag turn-start` loopDelayMs.max 는
// 21~112ms 임을 보였다 — 막는 것은 preamble «밖»이다. 이 모듈은 턴 시작(대시보드 턴 본문 첫 콜백)에 트레이스를
// 열고, 실제 호출 순서를 따라 심은 경계(`markTurnStartSegment`)마다 시계를 «한 번» 읽어 앞 경계와의 ms 를
// 덩어리로 쌓는다. 첫 스트림 요청 경계(`endTurnStartSegments`)에서 닫고, 박동 두 번 간격 뒤 같은 창의 루프
// 지연과 함께 debug.log('tui.turn-start', 'segments', …) 한 줄을 남긴다. 기존 `tui.input-lag` 줄은 창·칸 그대로다.
//
// - 턴 키: 경계는 트레이스를 연 «그 턴»의 키(ACP sessionId)를 같이 준다. 키가 다른 경계(다른 세션의 턴 ·
//   서브 에이전트)는 문자열 비교 한 번으로 버린다 — 시계를 안 읽고 덩어리도 안 섞는다. 한 번에 열린 트레이스는
//   하나(TUI 는 한 번에 한 턴)이고, 다른 키로 새로 열면 앞 것은 `superseded` 로 닫는다.
// - 박동: 덩어리 안에서 박동이 돌았으면(`yielded`) 루프가 돌았다 = 순수 동기 아님. 박동 없이 이어진 덩어리 합의
//   최대(`syncBlockMaxMs`)가 박동 하나가 본 막힘의 추정이다(오차 ≤ 박동 간격). 박동은 input-lag 프로브의 것을
//   읽는다(`InputLagBeatView` — 새 타이머 0).
// - debug 가 꺼진 턴은 트레이스를 안 연다 — 그 턴의 경계는 null 검사 한 번이고 시계를 안 읽는다.
// - 줄을 내는 시점은 기존 turn-start 와 같은 «박동 두 번 간격» 타이머다(두 줄의 창이 같은 규칙으로 닫힌다).
//   실제 박동 두 번을 센 뒤 내보내는 전환은 TURN-START-BLOCK-REST 3단계 앞 조각.
// - 결선(대시보드·ACP·코어 턴·LLM 경계 한 줄씩)은 후속 PR — 이 모듈은 등록이 없으면 아무 일도 안 한다.

import type { InputLagBeatView, LoopDelayMs } from '../tui/input-lag-probe.js';

export const TURN_START_CATEGORY = 'tui.turn-start';
export const TURN_START_SEGMENTS_EVENT = 'segments';
/** 첫 스트림 요청 경계가 끝내 안 오면(원격 데몬 세션 · 중단 · 실패) 이만큼 뒤 쌓인 덩어리로 닫는다. */
export const TURN_START_TRACE_CAP_MS = 15_000;

export interface TurnStartSegments {
  /** 덩어리 이름 → ms(0.1ms 반올림 · 앞 경계부터 이 경계까지의 벽시계). 같은 이름이 또 오면 `#2`… */
  segmentsMs: Record<string, number>;
  /** 경계가 온 순서. */
  order: string[];
  /** 그 덩어리 안에서 박동이 돌았다 — 루프가 돌았으니(await·I/O) 벽시계 ms 가 곧 막힘은 아니다. */
  yielded: string[];
  /** 덩어리 합(공개된 segmentsMs 값의 합 · 0.1ms). */
  totalMs: number;
  /** 트레이스 시작 → 닫힘. stream-open 이면 totalMs 와 같고, cap·superseded 면 마지막 경계 뒤 기다린 시간까지 든다
   *  (debug 가 꺼진 새 턴이 닫으면 시계를 안 읽으므로 마지막 경계까지). */
  closedAfterMs: number;
  /** 트레이스를 열 때 마지막 박동부터 흐른 ms — 열기 «전» 동기 일이 이미 루프를 막고 있었으면 크다(평상시 ≤ 박동 간격). */
  preTraceMs: number;
  /** 박동 없이 이어진 덩어리 합의 최대 — 루프를 한 번에 막은 동기 덩어리의 추정(박동이 돈 덩어리는 마지막 박동 뒤
   *  꼬리만 · 첫 덩어리까지 박동이 안 돌았으면 `preTrace` 를 머리로 포함). */
  syncBlockMaxMs: number;
  /** 그 최대 동기 덩어리를 이룬 덩어리 이름(순서대로). ⚠️ 첫 이름이 `yielded` 에 든 덩어리면 그 덩어리는 «마지막 박동 뒤
   *  꼬리만» syncBlockMaxMs 에 들었다 — 그 덩어리 segmentsMs 전체가 동기 블록이라는 뜻이 아니다. */
  syncBlockSegments: string[];
  /** 트레이스 시작 → 닫힘 ⊕ 박동 두 번 간격 창의 루프 지연. */
  loopDelayMs: LoopDelayMs;
  endedBy: 'stream-open' | 'cap' | 'superseded';
  /** 트레이스 키(ACP sessionId). */
  key: string;
  turnId?: string;
  busy: boolean;
}

interface TimerLike { unref?: () => void }

export interface TurnStartSegmentsOptions {
  beats: InputLagBeatView;
  log: (category: string, event: string, data: TurnStartSegments) => void;
  isBusy: () => boolean;
  /** 트레이스를 열지 — 대시보드는 `debug.enabled` 를 준다. 없으면 연다. */
  isEnabled?: () => boolean;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerLike;
  clearTimeoutFn?: (timer: TimerLike) => void;
}

export interface TurnStartSegmentsRecorder {
  /** 키 `key` 의 턴 시작 트레이스를 연다(열린 것이 있으면 `superseded` 로 닫고). */
  begin(key: string, turnId?: string): void;
  /** 키가 같은 열린 트레이스에 덩어리 경계 하나 — 시계 한 번. 아니면 null 검사·비교뿐. */
  mark(key: string, name: string): void;
  /** 첫 스트림 요청 경계 — 마지막 덩어리를 찍고 닫는다(줄은 박동 두 번 간격 뒤). */
  end(key: string, name: string): void;
  dispose(): void;
}

const round1 = (ms: number): number => Math.round(Math.max(0, ms) * 10) / 10;

interface Trace {
  key: string;
  turnId: string | undefined;
  startAt: number;
  lastAt: number;
  preTraceMs: number;
  /** 공개 덩어리(반올림 값)의 누적 합 — totalMs 가 segmentsMs 의 합과 어긋나지 않게. */
  sumMs: number;
  segmentsMs: Record<string, number>;
  order: string[];
  yielded: string[];
  blockMs: number;
  blockSegments: string[];
  maxBlockMs: number;
  maxBlockSegments: string[];
  capTimer: TimerLike | null;
}

export function createTurnStartSegments(opts: TurnStartSegmentsOptions): TurnStartSegmentsRecorder {
  const now = opts.now ?? (() => performance.now());
  const isEnabled = opts.isEnabled ?? (() => true);
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const beats = opts.beats;
  let trace: Trace | null = null;
  let disposed = false;

  const markAt = (tr: Trace, name: string): void => {
    const t = now();
    let key = name;
    for (let n = 2; key in tr.segmentsMs; n++) key = `${name}#${n}`;
    const ms = round1(t - tr.lastAt);
    tr.segmentsMs[key] = ms;
    tr.sumMs += ms;
    tr.order.push(key);
    // 앞 경계 뒤에 박동이 돌았으면 루프가 돌았다 — 동기 덩어리는 마지막 박동 «뒤» 꼬리부터 다시 센다.
    const lastBeatAt = beats.lastBeatAt();
    if (lastBeatAt > tr.lastAt) {
      tr.yielded.push(key);
      tr.blockMs = t - lastBeatAt;
      tr.blockSegments = [key];
    } else {
      tr.blockMs += t - tr.lastAt;
      tr.blockSegments.push(key);
    }
    if (tr.blockMs >= tr.maxBlockMs) {
      tr.maxBlockMs = tr.blockMs;
      tr.maxBlockSegments = tr.blockSegments.slice();
    }
    tr.lastAt = t;
  };

  const close = (tr: Trace, endedBy: TurnStartSegments['endedBy'], closedAt: number): void => {
    if (trace === tr) trace = null;
    // 닫힌 트레이스를 상한 타이머가 붙잡지 않게 푼다.
    if (tr.capTimer !== null) { clearTimeoutFn(tr.capTimer); tr.capTimer = null; }
    const emit = (): void => {
      if (disposed) return;
      opts.log(TURN_START_CATEGORY, TURN_START_SEGMENTS_EVENT, {
        segmentsMs: tr.segmentsMs,
        order: tr.order,
        yielded: tr.yielded,
        totalMs: Math.round(tr.sumMs * 10) / 10,
        closedAfterMs: round1(closedAt - tr.startAt),
        preTraceMs: round1(tr.preTraceMs),
        syncBlockMaxMs: round1(tr.maxBlockMs),
        syncBlockSegments: tr.maxBlockSegments,
        loopDelayMs: beats.loopDelaySince(tr.startAt),
        endedBy,
        key: tr.key,
        ...(tr.turnId !== undefined ? { turnId: tr.turnId } : {}),
        busy: opts.isBusy(),
      });
    };
    // 방금 끝난 동기 막힘은 루프가 풀린 «뒤» 박동에 찍힌다 — 첫 스트림 요청이면 박동 두 번 간격 기다렸다 읽는다.
    if (endedBy === 'stream-open') setTimeoutFn(emit, beats.heartbeatMs * 2).unref?.();
    else emit();
  };

  return {
    begin(key: string, turnId?: string): void {
      if (disposed) return;
      const open = trace;
      if (!isEnabled()) {
        // debug 가 꺼진 턴은 시계를 안 읽는다 — 열려 있던 트레이스는 마지막 경계 시각으로 닫는다.
        if (open !== null) close(open, 'superseded', open.lastAt);
        return;
      }
      const t = now();
      if (open !== null) close(open, 'superseded', t);
      // 열기 전 마지막 박동 뒤 흐른 시간 — 열기 전 동기 일이 같은 막힘의 머리다(시계는 이 한 번).
      const preTraceMs = Math.max(0, t - beats.lastBeatAt());
      const tr: Trace = {
        key, turnId, startAt: t, lastAt: t, preTraceMs, sumMs: 0,
        segmentsMs: {}, order: [], yielded: [],
        blockMs: preTraceMs, blockSegments: ['preTrace'], maxBlockMs: preTraceMs, maxBlockSegments: ['preTrace'],
        capTimer: null,
      };
      trace = tr;
      tr.capTimer = setTimeoutFn(() => { tr.capTimer = null; if (trace === tr) close(tr, 'cap', now()); }, TURN_START_TRACE_CAP_MS);
      tr.capTimer.unref?.();
    },
    mark(key: string, name: string): void {
      const tr = trace;
      if (tr !== null && tr.key === key) markAt(tr, name);
    },
    end(key: string, name: string): void {
      const tr = trace;
      if (tr === null || tr.key !== key) return;
      markAt(tr, name);
      close(tr, 'stream-open', tr.lastAt);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (trace !== null && trace.capTimer !== null) { clearTimeoutFn(trace.capTimer); trace.capTimer = null; }
      trace = null;
    },
  };
}

// ── 등록 자리 — 대시보드가 하나 등록하고, 경계(대시보드·ACP·코어 턴·LLM)는 부르기만 한다. ──
let active: TurnStartSegmentsRecorder | null = null;

export function setTurnStartSegments(recorder: TurnStartSegmentsRecorder | null): void {
  active = recorder;
}

/** 키 `key`(ACP sessionId) 의 턴 시작 트레이스를 연다 — 대시보드 턴 본문의 첫 콜백. */
export function beginTurnStartSegments(key: string, turnId?: string): void {
  active?.begin(key, turnId);
}

/** 턴 시작 덩어리 경계 — 등록·트레이스가 없거나 키가 다르면 null 검사·비교뿐(시계를 안 읽는다). */
export function markTurnStartSegment(key: string | undefined, name: string): void {
  if (key !== undefined) active?.mark(key, name);
}

/** 첫 스트림 요청 경계 — 같은 키의 트레이스를 닫는다. */
export function endTurnStartSegments(key: string | undefined, name: string): void {
  if (key !== undefined) active?.end(key, name);
}
