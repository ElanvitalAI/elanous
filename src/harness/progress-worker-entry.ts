import { parentPort } from 'node:worker_threads';
import { queryRunningRuns, type RunningRunsResult } from '../self-implement/running-runs.js';

/**
 * HARNESS-PROGRESS-HANG — `harness progress` 하위 조회의 «전용 워커 엔트리».
 * 이 모듈은 CLI 디스패치(`src/index.ts`·`bin/elanous.mjs`)를 거치지 않고 워커에 직접 적재되므로,
 * 번들·컴파일 산출물에서도 `parentPort` 핸들러가 반드시 이 스레드에 등록된다.
 * 그 전에는 워커가 `import.meta.url` 로 배포 엔트리를 재진입해 핸들러가 아예 안 올랐다.
 */
export interface ProgressQueryWorkerRequest {
  readonly kind?: 'query';
  readonly caller: string;
  readonly runIds?: readonly string[];
  readonly timeBudgetMs?: number;
}

/** 상한 도달 뒤 부모가 보내는 정지 요청 — 워커는 «현재 행» 을 회신하고 정상 종료한다. */
export interface ProgressQueryWorkerAbortRequest {
  readonly kind: 'abort';
}

export type ProgressQueryWorkerMessage = ProgressQueryWorkerRequest | ProgressQueryWorkerAbortRequest;

export interface ProgressQueryWorkerReply {
  readonly ok: boolean;
  readonly result?: RunningRunsResult;
  readonly error?: string;
  readonly stopped?: 'aborted';
}

/**
 * 워커의 `parentPort` 핸들러를 등록한다.
 * - `query`: 하위 조회를 실행해 결과를 회신한다.
 * - `abort`: 이 스레드가 마지막으로 계산한 행(`lastResult`)을 «보존 행» 으로 회신한다 —
 *   부모의 상한 뒤 유예 창 안에 도착하면 `progress-command-late` 관측으로 그대로 보존된다.
 */
export function installProgressWorkerEntry(port: NonNullable<typeof parentPort> | null | undefined = parentPort): void {
  if (!port) return;
  let lastResult: RunningRunsResult | undefined;
  port.on('message', (message: ProgressQueryWorkerMessage) => {
    if (message.kind === 'abort') {
      port.postMessage({ ok: true, result: lastResult, stopped: 'aborted' } satisfies ProgressQueryWorkerReply);
      return;
    }
    try {
      const result = queryRunningRuns({
        caller: message.caller,
        ...(message.timeBudgetMs === undefined ? {} : { timeBudgetMs: message.timeBudgetMs }),
        ...(message.runIds === undefined ? {} : { runIds: message.runIds }),
      });
      lastResult = result;
      port.postMessage({ ok: true, result } satisfies ProgressQueryWorkerReply);
    } catch (error) {
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ProgressQueryWorkerReply);
    }
  });
}

installProgressWorkerEntry();
