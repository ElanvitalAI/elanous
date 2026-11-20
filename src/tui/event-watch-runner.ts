import { createEventWatch, type EventWatch, type EventWatchLineOutcome } from './event-watch.js';
import { terminateTree } from '../shell-primitive/terminate-tree.js';
import type { ChildNoticeQueue } from './core/notice-producers.js';
import { emitTurnLife } from '../debug/turn-life.js';

/**
 * OP-EVENT-WATCH-WAKE 필수분 — createEventWatch 를 실제 큐·wake 경로에 붙인다.
 * 한 줄이 큐에 들어가거나 만료되면 onQueued 를 부른다. entry 는 그 콜백에서
 * 쉬는 경계의 queueWake 를 넣는다(dispatchQueued). 프로세스 실행 자체는
 * 호출자 몫이고, 이 파일은 «줄을 감시로 넘기고 큐가 차면 깨운다»만 소유한다.
 *
 * 조용한 감시: 출력이 없어도 deadlineMs 가 지나면 tick(now) 이 만료 알림을
 * 한 번 넣고 onQueued 를 부른다. 줄을 기다리지 않는다.
 */

export interface EventWatchRunner {
  /** 출력 한 줄. 큐에 들어간 결과(queued·expired)면 true. */
  pushLine(line: string, nowMs: number): boolean;
  ended(code: number | null, nowMs: number): boolean;
  readFailed(reason: string, nowMs: number): boolean;
  /** 출력이 없는 동안에도 부른다. 시한이 지났으면 만료 알림을 연다. */
  tick(nowMs: number): boolean;
  /**
   * 한 흐름의 덩어리. 줄이 덩어리 경계에서 잘리면 조각을 그 흐름에만 보관하고,
   * 다음 덩어리와 이어 붙인 뒤 한 줄로 넘긴다. close 때 남은 조각을 비운다.
   */
  feed(stream: 'stdout' | 'stderr', chunk: string, nowMs: number): void;
  close(stream: 'stdout' | 'stderr', nowMs: number): void;
  stop(): void;
  readonly stopped: boolean;
  readonly watch: EventWatch;
}

function wakes(outcome: EventWatchLineOutcome): boolean {
  return outcome.kind === 'queued' || outcome.kind === 'expired';
}

export function startEventWatchRunner(
  queue: ChildNoticeQueue,
  opts: { command: string; deadlineMs?: number | null; onQueued?: () => void },
): EventWatchRunner {
  const watch = createEventWatch(queue, { command: opts.command, deadlineMs: opts.deadlineMs ?? null });
  const note = (outcome: EventWatchLineOutcome): boolean => {
    const woke = wakes(outcome);
    if (woke) opts.onQueued?.();
    return woke;
  };
  const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const feed = (stream: 'stdout' | 'stderr', chunk: string, nowMs: number): void => {
    const parts = `${pending[stream]}${chunk}`.split(/\r?\n/u);
    pending[stream] = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) note(watch.pushLine(line, nowMs));
    }
  };
  const close = (stream: 'stdout' | 'stderr', nowMs: number): void => {
    const rest = pending[stream];
    pending[stream] = '';
    if (rest.length > 0) note(watch.pushLine(rest, nowMs));
  };
  return {
    watch,
    pushLine: (line, nowMs) => note(watch.pushLine(line, nowMs)),
    ended: (code, nowMs) => note(watch.ended(code, nowMs)),
    readFailed: (reason, nowMs) => note(watch.readFailed(reason, nowMs)),
    tick: (nowMs) => note(watch.pushLine('', nowMs)),
    feed,
    close,
    stop: () => { watch.stop(); },
    get stopped() { return watch.stopped; },
  };
}

export interface EventWatchProcess {
  stop(): void;
}

/**
 * 감시 명령을 띄우고 stdout·stderr 를 흐름별로 줄 버퍼에 넣는다.
 * entry 는 이 함수만 동적 import 한다. 만료·TUI 종료는 stop() 한 번.
 */
export interface EventWatchSpawned {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  stdout: { on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void): unknown } | null;
  on(event: 'error', cb: (error: Error) => void): unknown;
  on(event: 'close', cb: (code: number | null) => void): unknown;
}

export function attachEventWatchProcess(
  runner: EventWatchRunner,
  command: string,
  opts: {
    deadlineMs?: number | null;
    now?: () => number;
    spawnImpl?: (command: string) => EventWatchSpawned;
  } = {},
): EventWatchProcess {
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? null;
  let child: { pid?: number; kill: (signal?: NodeJS.Signals) => void } | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const killGroup = (): void => {
    const pid = child?.pid;
    if (pid === undefined) return;
    // shell:true 의 sh 만 죽이면 a|b · tail -f 손자가 남는다. 그룹째 끊는다(KILL-TREE-ONE 공용 루틴:
    // 그룹 SIGTERM → 유예 → SIGKILL · 그룹이 없으면 pid 자신).
    void terminateTree({ pid }, { group: true, pidFallback: true });
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (tick !== null) clearInterval(tick);
    tick = null;
    runner.stop();
    killGroup();
  };
  if (deadlineMs !== null) {
    tick = setInterval(() => {
      if (runner.tick(now())) stop();
    }, 1_000);
    tick.unref?.();
  }
  const start = opts.spawnImpl
    ? Promise.resolve(opts.spawnImpl)
    : import('node:child_process').then(({ spawn }) => (cmd: string): EventWatchSpawned => spawn(cmd, {
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as EventWatchSpawned);
  void start.then((spawnCommand) => {
    if (stopped || runner.stopped) return;
    const spawned = spawnCommand(command);
    child = spawned;
    const onData = (stream: 'stdout' | 'stderr') => (chunk?: Buffer | string): void => {
      runner.feed(stream, String(chunk ?? ''), now());
      // OBSERVE-TURN-EVENT-LIFECYCLE — 감시줄 출력 도착(한 청크; busy 여부는 큐 적입 뒤 문이 판정).
      try { emitTurnLife('turn-life:event-arrived', { source: 'event-watch', arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
      if (runner.stopped) stop();
    };
    spawned.stdout?.on('data', onData('stdout'));
    spawned.stderr?.on('data', onData('stderr'));
    spawned.stdout?.on('end', () => { runner.close('stdout', now()); });
    spawned.stderr?.on('end', () => { runner.close('stderr', now()); });
    spawned.on('error', (error: Error) => { runner.readFailed(error.message, now()); stop(); });
    spawned.on('close', (code: number | null) => { runner.ended(code, now()); stop(); });
  });
  return { stop };
}
