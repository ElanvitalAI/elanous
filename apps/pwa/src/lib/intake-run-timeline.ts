import type { RunEvent } from './intake-front-door-api';

export interface RunTimeline {
  stage: string | null;
  lastEventAt: string | null;
  done: boolean;
  outcome: 'completed' | 'failed' | 'unknown' | null;
  error: string | null;
}

const STAGES: Record<string, string> = {
  'headless.spawn': '실행 시작',
  'gate.baseline': '게이트 검사',
  'review.diff-scope': '리뷰 중',
  'headless.done': '실행 종료',
  'run-terminal': '종료',
};

/** 서버가 시간순으로 반환한 뼈대 사건을 화면에 표시할 한 줄로 요약한다. */
export function summarizeRunEvents(events: readonly RunEvent[]): RunTimeline {
  const last = events.at(-1);
  const terminal = events.find((event) => event.event === 'run-terminal');
  const runStatus = terminal?.payload?.runStatus;
  return {
    stage: last ? (STAGES[last.event] ?? last.event) : null,
    lastEventAt: last?.ts ?? null,
    done: terminal !== undefined,
    outcome: terminal ? (runStatus === 'completed' || runStatus === 'failed' ? runStatus : 'unknown') : null,
    error: terminal?.payload?.error ?? null,
  };
}
