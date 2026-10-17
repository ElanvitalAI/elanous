// TUI-TYPING-LAG-OBS — 타이핑 지연을 «재는» 관측(#28063 이 «실물 불가» 로 착지한 빈칸).
//
// 계약(UX SCENARIO-MOCK-RIG 와 합의 · ⛔ 이름·칸을 바꾸지 않는다):
//   debug.log('tui.input-lag', 'measured', {
//     phase: 'keystroke' | 'turn-start', keyToPaintMs?, loopDelayMs: { p99, max }, turnId?, busy, sampled })
//
// - keystroke: stdin 키 수신 → 그 뒤 첫 화면 칠(render · typeahead echo) 의 write 호출까지.
//   이벤트 루프가 막힌 동안 온 키는 막힘이 풀린 뒤에야 'data' 로 배달되므로, 배달 시각만 보면
//   막힌 시간이 빠진다. ⇒ 20ms 심장박동으로 «배달 전 기다린 시간» 을 추정해 더한다(상한 추정 ·
//   오차 ≤ 심장박동 간격). 기본 표본 = 10키 중 1(`sampled: 0.1`) · 50ms 이상은 항상 남긴다.
// - turn-start: turn-preamble 을 감싼 창(시작 → 끝 + 박동 두 번)의 루프 지연(`sampled: 1`) · busy 는 창 끝 값.
// - loopDelayMs: 그 창의 루프 지연 p99/max(ms) — 같은 20ms 심장박동의 드리프트 표본(최근 ~20초 고리).
//   ⚠️ perf_hooks.monitorEventLoopDelay 를 «안» 쓴다: Bun 1.4.2 에서 동작은 하지만 인스턴스들이
//   «히스토그램 하나를 공유» 하고 한 인스턴스의 disable() 이 전부를 멈춘다(node-c 실측 · 라이브에서
//   turn-start 창을 닫은 뒤 keystroke 창이 {p99:0,max:0} 만 찍었다). 창이 겹치는 이 프로브엔 못 쓴다.
//
// 키 경로 비용: 키 청크마다 시각 호출 1회 ⊕ 비교 몇 개 · 할당 0(대기 중 키는 숫자 둘로 쥔다).
// 화면 칠마다: 대기 키가 없으면 비교 1회. 로그 객체는 «남길 때만» 만든다.
// 프로브가 등록되지 않으면(대시보드 밖 · 시험) 모든 훅은 null 검사 한 번으로 끝난다.

export const INPUT_LAG_CATEGORY = 'tui.input-lag';
export const INPUT_LAG_EVENT = 'measured';
/** 표본 비율의 분모 — 측정한 키 N개 중 1개를 남긴다. */
export const INPUT_LAG_SAMPLE_EVERY = 10;
/** 이 ms 이상 걸린 키는 표본과 무관하게 항상 남긴다. */
export const INPUT_LAG_ALWAYS_MS = 50;
const HEARTBEAT_MS = 20;
/** 루프가 «안 막힌 채» 이만큼 지나도 칠이 없으면 그 키는 칠을 안 낳은 키(무시 키 등)로 보고 놓는다 —
 *  안 그러면 한참 뒤 다른 칠이 그 키에 붙어 수 분짜리 가짜 지연이 찍힌다(라이브 실측 150,963ms). */
export const INPUT_LAG_ABANDON_MS = 1000;
/** 루프 지연 표본 고리 크기 — 20ms 박동이면 ~20초. */
const LOOP_RING = 1024;

export interface LoopDelayMs { p99: number; max: number }

export interface InputLagMeasured {
  phase: 'keystroke' | 'turn-start';
  keyToPaintMs?: number;
  loopDelayMs: LoopDelayMs;
  turnId?: string;
  busy: boolean;
  sampled: number;
}

interface TimerLike { unref?: () => void }

export interface InputLagProbeOptions {
  log: (category: string, event: string, data: InputLagMeasured) => void;
  isBusy: () => boolean;
  now?: () => number;
  sampleEvery?: number;
  alwaysMs?: number;
  heartbeatMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => TimerLike;
  clearIntervalFn?: (timer: TimerLike) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerLike;
}

export interface InputLagProbe {
  /** 키 `count` 개가 한 번에 도착했다(한 stdin 청크가 여러 키를 낳을 수 있다). */
  noteKey(count?: number): void;
  notePaint(): void;
  measureTurnStart<T>(fn: () => T, turnId?: string): T;
  /** 같은 심장박동을 다른 관측(턴 시작 덩어리 · `dashboard/turn-start-segments.ts`)이 읽는 창 — 시계·할당 0. */
  beats: InputLagBeatView;
  dispose(): void;
}

export interface InputLagBeatView {
  heartbeatMs: number;
  /** 마지막 박동 시각(같은 `now` 시계). */
  lastBeatAt(): number;
  /** `since` 뒤 박동들의 루프 지연 p99/max — 남길 때만 부른다. */
  loopDelaySince(since: number): LoopDelayMs;
}

const round1 = (ms: number): number => Math.round(Math.max(0, ms) * 10) / 10;

/** 드리프트 표본 고리에서 `since` «뒤»(초과) 표본의 p99/max. 남길 때만 부른다(그때만 할당). */
function readLoopDelay(drift: Float64Array, at: Float64Array, count: number, head: number, since: number): LoopDelayMs {
  const picked: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (head - 1 - i + LOOP_RING) % LOOP_RING;
    if (at[idx]! <= since) break;
    picked.push(drift[idx]!);
  }
  if (picked.length === 0) return { p99: 0, max: 0 };
  picked.sort((x, y) => x - y);
  return {
    // 최근순위(nearest-rank) p99 — 짧은 창([0, 300])에서도 큰 막힘을 내림으로 잃지 않는다.
    p99: round1(picked[Math.max(0, Math.ceil(picked.length * 0.99) - 1)]!),
    max: round1(picked[picked.length - 1]!),
  };
}

export function createInputLagProbe(opts: InputLagProbeOptions): InputLagProbe {
  const now = opts.now ?? (() => performance.now());
  const sampleEvery = Math.max(1, Math.floor(opts.sampleEvery ?? INPUT_LAG_SAMPLE_EVERY));
  const alwaysMs = opts.alwaysMs ?? INPUT_LAG_ALWAYS_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));

  // 칠을 기다리는 첫 키(뒤따르는 키는 같은 칠을 기다리므로 첫 키가 최악값이다).
  let pendingAt = -1;
  let pendingWaitMs = 0;
  // 심장박동 — 마지막 박동 시각 ⊕ 방금 끝난 막힘(같은 루프 회전에서 키가 배달되면 그만큼 기다렸다).
  let lastBeatAt = now();
  let stallMs = 0;
  let stallEndedAt = -Infinity;
  const ringDrift = new Float64Array(LOOP_RING);
  const ringAt = new Float64Array(LOOP_RING);
  let ringHead = 0;
  let ringCount = 0;
  let keyWindowStart = lastBeatAt;
  const loopDelaySince = (since: number): LoopDelayMs => readLoopDelay(ringDrift, ringAt, ringCount, ringHead, since);
  const beat = setIntervalFn(() => {
    const t = now();
    const drift = t - lastBeatAt - heartbeatMs;
    ringDrift[ringHead] = Math.max(0, drift);
    ringAt[ringHead] = t;
    ringHead = (ringHead + 1) % LOOP_RING;
    if (ringCount < LOOP_RING) ringCount += 1;
    if (drift > heartbeatMs) { stallMs = drift; stallEndedAt = t; }
    lastBeatAt = t;
    if (pendingAt >= 0 && t - Math.max(pendingAt, stallEndedAt) > INPUT_LAG_ABANDON_MS) pendingAt = -1;
  }, heartbeatMs);
  beat.unref?.();

  // 표본 줄 사이에 들어온 실제 키 수(측정 횟수가 아니다) — 표본 줄을 남기면 sampleEvery 의 나머지를 이월한다.
  let keysSinceLine = 0;
  let disposed = false;

  return {
    noteKey(count = 1): void {
      if (disposed) return;
      keysSinceLine += count;
      if (pendingAt >= 0) return;
      const t = now();
      // 박동이 밀려 있으면 루프가 아직 막혀 있었다. 마지막 박동이 막힘을 끝낸 박동이면(그 뒤 평상 박동이
      // 아직 없으면) 막힘 동안 쌓인 키가 이제 배달되는 중이다 — 막힘 ⊕ 그 뒤 흐른 시간(상한 추정).
      const overdue = t - lastBeatAt - heartbeatMs;
      const justStalled = stallEndedAt === lastBeatAt ? stallMs + (t - stallEndedAt) : 0;
      pendingAt = t;
      pendingWaitMs = Math.max(0, overdue, justStalled);
    },
    notePaint(): void {
      if (pendingAt < 0) return;
      const keyToPaintMs = now() - pendingAt + pendingWaitMs;
      pendingAt = -1;
      // 50ms↑ 강제 줄은 표본을 소비하지 않는다(표본이 때가 됐어도 다음 칠로 넘긴다) ·
      // 표본 줄은 넘친 키를 다음 표본으로 이월한다.
      const forced = keyToPaintMs >= alwaysMs;
      if (!forced) {
        if (keysSinceLine < sampleEvery) return;
        keysSinceLine %= sampleEvery;
      }
      const t = now();
      const loopDelayMs = loopDelaySince(keyWindowStart);
      keyWindowStart = t;
      opts.log(INPUT_LAG_CATEGORY, INPUT_LAG_EVENT, {
        phase: 'keystroke',
        keyToPaintMs: round1(keyToPaintMs),
        loopDelayMs,
        busy: opts.isBusy(),
        sampled: 1 / sampleEvery,
      });
    },
    measureTurnStart<T>(fn: () => T, turnId?: string): T {
      if (disposed) return fn();
      const windowStart = now();
      const finish = (): void => {
        // busy 는 창이 닫히는 «지금» 잡는다 — 박동 두 번 뒤 읽으면 그 사이 바뀐 상태가 창에 붙는다.
        const busy = opts.isBusy();
        // 동기 막힘은 루프가 풀린 «뒤» 첫 박동에 찍힌다 — 박동 두 번만큼 기다렸다 읽는다.
        const timer = setTimeoutFn(() => {
          if (disposed) return;
          const loopDelayMs = loopDelaySince(windowStart);
          opts.log(INPUT_LAG_CATEGORY, INPUT_LAG_EVENT, {
            phase: 'turn-start',
            loopDelayMs,
            ...(turnId !== undefined ? { turnId } : {}),
            busy,
            sampled: 1,
          });
        }, heartbeatMs * 2);
        timer.unref?.();
      };
      try {
        return fn();
      } finally {
        finish();
      }
    },
    beats: {
      heartbeatMs,
      lastBeatAt: () => lastBeatAt,
      loopDelaySince,
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pendingAt = -1;
      clearIntervalFn(beat);
    },
  };
}

// ── 등록 자리 — 대시보드가 하나 등록하고, 저수준 훅(tui.ts · chat · turn-preamble)은 부르기만 한다. ──
let activeProbe: InputLagProbe | null = null;

export function setInputLagProbe(probe: InputLagProbe | null): void {
  activeProbe = probe;
}

/** stdin(또는 주입) 키 `count` 개 수신 — 키 경로 훅. 등록이 없으면 null 검사 한 번. */
export function noteInputLagKey(count = 1): void {
  activeProbe?.noteKey(count);
}

/** 화면 칠(write 호출) 직후 — 칠 경로 훅. */
export function noteInputLagPaint(): void {
  activeProbe?.notePaint();
}

/** turn-preamble 창을 잰다. 등록이 없으면 fn 만 부른다. */
export function measureInputLagTurnStart<T>(fn: () => T, turnId?: string): T {
  return activeProbe ? activeProbe.measureTurnStart(fn, turnId) : fn();
}
