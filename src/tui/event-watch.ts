import { createChildNoticeProducers, eventWatchNotice, eventWatchStatusLine, type ChildNoticeQueue } from './core/notice-producers.js';

/**
 * OP-EVENT-WATCH-WAKE — 감시 명령의 출력 한 줄이 입력 큐의 notice 가 된다.
 * 큐에 들어간 알림은 쉬는 경계에서 자기 턴을 연다(#38102 문 · dispatchQueued).
 * 이 파일은 «줄을 어떻게 받나»만 소유한다. 문구·중복 제거는 notice-producers.
 *
 * 시한: deadlineMs 가 지나면 다음 줄은 큐에 넣지 않고 만료 알림 한 줄을 한 번 넣는다.
 * 명령이 죽거나(ended) 읽기가 실패(read-failed)해도 감시 알림 한 줄로 남긴다.
 */

export type EventWatchLineOutcome =
  | { kind: 'queued'; text: string }
  | { kind: 'blank' }
  | { kind: 'duplicate' }
  | { kind: 'expired' }
  | { kind: 'stopped' };

export interface EventWatch {
  /** 출력 한 줄. 개행은 호출자가 이미 나눈 뒤라고 본다. */
  pushLine(line: string, nowMs: number): EventWatchLineOutcome;
  /** 명령이 끝났다 — 종료 코드가 있으면 알림에 싣는다. */
  ended(code: number | null, nowMs: number): EventWatchLineOutcome;
  /** 출력을 읽지 못했다. */
  readFailed(reason: string, nowMs: number): EventWatchLineOutcome;
  stop(): void;
  readonly stopped: boolean;
}

export function createEventWatch(
  queue: ChildNoticeQueue,
  opts: { command: string; deadlineMs?: number | null },
): EventWatch {
  const producers = createChildNoticeProducers(queue);
  const deadlineMs = opts.deadlineMs ?? null;
  let stopped = false;
  let expirySent = false;

  const expire = (): EventWatchLineOutcome => {
    stopped = true;
    if (expirySent) return { kind: 'stopped' };
    expirySent = true;
    const item = producers.eventWatchLine(eventWatchStatusLine('감시 만료: ', opts.command, '시한'));
    return item === null ? { kind: 'stopped' } : { kind: 'expired' };
  };

  const pushLine = (line: string, nowMs: number): EventWatchLineOutcome => {
    if (stopped) return { kind: 'stopped' };
    if (deadlineMs !== null && nowMs >= deadlineMs) return expire();
    const text = eventWatchNotice(line);
    if (text === null) return { kind: 'blank' };
    const item = producers.eventWatchLine(line);
    if (item === null) return { kind: 'duplicate' };
    return { kind: 'queued', text: item.text };
  };

  const ended = (code: number | null, nowMs: number): EventWatchLineOutcome => {
    if (stopped) return { kind: 'stopped' };
    if (deadlineMs !== null && nowMs >= deadlineMs) return expire();
    stopped = true;
    const suffix = code === null ? '종료' : `종료 코드 ${code}`;
    const item = producers.eventWatchLine(eventWatchStatusLine('감시 종료: ', opts.command, suffix));
    return item === null ? { kind: 'stopped' } : { kind: 'queued', text: item.text };
  };

  const readFailed = (reason: string, nowMs: number): EventWatchLineOutcome => {
    if (stopped) return { kind: 'stopped' };
    if (deadlineMs !== null && nowMs >= deadlineMs) return expire();
    stopped = true;
    const item = producers.eventWatchLine(eventWatchStatusLine('감시 읽기 실패: ', opts.command, reason));
    return item === null ? { kind: 'stopped' } : { kind: 'queued', text: item.text };
  };

  return {
    pushLine,
    ended,
    readFailed,
    stop: () => { stopped = true; },
    get stopped() { return stopped; },
  };
}
