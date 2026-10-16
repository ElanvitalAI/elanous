// TUI-LOOP-COMMAND — `/loop <간격> <프롬프트>` 의 idle-gated 루프 스케줄러.
//
// 칸 문면의 판정선(src/dashboard/loop-scheduler.test.ts 로 증명):
//   idle 발사 1 — 간격 틱마다 대시보드가 «쉬는 동안»에만 프롬프트를 발사하고,
//                 한 틱에 정확히 한 번만 발사한다.
//   busy 미룸   — 틱이 바쁜 동안 오면 발사를 «버리지 않고» 한 개로 미뤄둔다
//                 (적체가 쌓이지 않는다 · 쉼이 돌아온 틱에 정확히 한 번 발사).
//   stop 0      — stop() 이후에는 어떤 틱도 발사하지 않는다.
//
// 호스트 의존이 없다 — isIdle · fire · schedule 만 주입받는다. 실제 타이머는
// 기본 setInterval/clearInterval 이고, 테스트는 tick() 시임으로 결정적으로
// 진행한다(가짜 타이머 불요).

export interface LoopSchedulerOptions {
  /** Interval between ticks. The /loop parser clamps this to ≥ 1s. */
  intervalMs: number;
  /** True when the dashboard is resting — the only state allowed to fire. */
  isIdle: () => boolean;
  /** The prompt launch action — called at most once per tick. */
  fire: () => void;
  /** Injectable tick scheduler; the default is setInterval/clearInterval. */
  schedule?: (callback: () => void, intervalMs: number) => { unsubscribe(): void };
}

export interface LoopScheduler {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** Fires deferred (not dropped) while busy — 0 or 1. */
  pendingFireCount(): number;
  /** One interval tick. The production timer and tests both call this. */
  tick(): void;
}

export function createLoopScheduler(options: LoopSchedulerOptions): LoopScheduler {
  const { isIdle, fire } = options;
  const schedule = options.schedule ?? ((callback: () => void, intervalMs: number) => {
    const timer = setInterval(callback, intervalMs);
    return { unsubscribe: () => clearInterval(timer) };
  });
  let running = false;
  let pending = false;
  let handle: { unsubscribe(): void } | null = null;

  const scheduler: LoopScheduler = {
    start(): void {
      if (running) return;
      running = true;
      pending = false;
      handle = schedule(() => scheduler.tick(), options.intervalMs);
    },
    stop(): void {
      if (!running) return;
      running = false;
      pending = false;
      handle?.unsubscribe();
      handle = null;
    },
    isRunning: () => running,
    pendingFireCount: () => (running && pending ? 1 : 0),
    tick(): void {
      if (!running) return;
      if (isIdle()) {
        pending = false;
        fire();
      } else {
        pending = true;
      }
    },
  };
  return scheduler;
}
