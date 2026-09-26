import { describe, expect, test } from 'bun:test';
import type { RunEvent } from './intake-front-door-api';
import { summarizeRunEvents } from './intake-run-timeline';

const event = (name: string, ts: string, payload?: RunEvent['payload']): RunEvent => ({
  event: name, ts, runId: 'run-1', ...(payload ? { payload } : {}),
});

describe('summarizeRunEvents', () => {
  test('빈 사건 목록', () => {
    expect(summarizeRunEvents([])).toEqual({ stage: null, lastEventAt: null, done: false, outcome: null, error: null });
  });

  test('planned 다음 implementing 은 아직 진행 중', () => {
    expect(summarizeRunEvents([event('planned', 't1'), event('implementing', 't2')])).toEqual({
      stage: 'implementing', lastEventAt: 't2', done: false, outcome: null, error: null,
    });
  });

  test('실패 끝 사건의 상태와 에러', () => {
    expect(summarizeRunEvents([event('implemented', 't1'), event('run-terminal', 't2', { runStatus: 'failed', error: 'x' })])).toEqual({
      stage: '종료', lastEventAt: 't2', done: true, outcome: 'failed', error: 'x',
    });
  });

  test('상태 없는 끝 사건은 unknown, 이후 사건이 있어도 끝 상태 유지', () => {
    expect(summarizeRunEvents([event('run-terminal', 't1'), event('headless.done', 't2')])).toEqual({
      stage: '실행 종료', lastEventAt: 't2', done: true, outcome: 'unknown', error: null,
    });
    expect(summarizeRunEvents([event('unrecognized', 't1')]).stage).toBe('unrecognized');
  });
});
