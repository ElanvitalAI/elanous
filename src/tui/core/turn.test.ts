import { expect, test } from 'bun:test';
import type { AgentDisplayEvent } from './agents.js';
import { decideNextTuiAutoContinue, startNextTuiTurn } from './turn.js';
import { NextTuiAuthError } from '../../tui-client/next-auth-preflight.js';

test('turn sim streams once, replaces preview, and settles after the runner', async () => {
  const events: string[] = [];
  let delta!: (text: string, replace?: boolean) => void;
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'hello' }, {
    run: async (_input, onDelta) => {
      delta = onDelta;
      onDelta('hel');
      onDelta('lo');
      onDelta('', true);
      return { goalComplete: true };
    },
    onStreamOpen: () => events.push('open'),
    onPreview: (text) => events.push(`preview:${text}`),
    onSettled: (result) => { events.push(`settled:${result.kind}:${result.goalComplete}`); },
  });
  await turn.done;
  delta('late');
  expect(events).toEqual(['open', 'preview:hel', 'preview:', 'settled:completed:true']);
});

test('Esc sim aborts the runner, ignores late stream, and blocks auto continuation', async () => {
  let signal!: AbortSignal;
  let emit!: (text: string) => void;
  let reject!: (error: Error) => void;
  const previews: string[] = [];
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'work' }, {
    run: (_input, onDelta) => new Promise((_, no) => {
      signal = _input.signal;
      emit = onDelta;
      reject = no;
    }),
    onPreview: (text) => previews.push(text),
  });
  await Promise.resolve();
  turn.abort();
  emit('ignored');
  reject(new Error('응답을 취소했습니다'));
  const result = await turn.done;
  expect(signal.aborted).toBe(true);
  expect(previews).toEqual([]);
  expect(result.kind).toBe('cancelled');
  expect(decideNextTuiAutoContinue(result, 0, '')).toBe('none');
});

test('automatic continuation waits for queued or draft input and stops at goal completion', () => {
  const completed = { kind: 'completed' as const, goalComplete: false, compacted: false };
  expect(decideNextTuiAutoContinue(completed, 0, '')).toBe('check');
  expect(decideNextTuiAutoContinue(completed, 1, '')).toBe('yield');
  expect(decideNextTuiAutoContinue(completed, 0, 'draft')).toBe('yield');
  expect(decideNextTuiAutoContinue({ ...completed, goalComplete: true }, 1, 'draft')).toBe('complete');
  expect(decideNextTuiAutoContinue({ ...completed, kind: 'failed' }, 0, '')).toBe('check');
});

test('compaction and runner failure reach settle with a failed auto-check', async () => {
  const events: string[] = [];
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'work' }, {
    run: async (_input, _onDelta, onCompact, onNotice) => {
      onCompact('압축 9→4 메시지');
      onNotice('tool active');
      throw new Error('provider unavailable');
    },
    onCompact: (status) => events.push(status),
    onNotice: (line) => events.push(line),
  });
  const result = await turn.done;
  expect(events).toEqual(['압축 9→4 메시지', 'tool active']);
  expect(result).toMatchObject({ kind: 'failed', error: 'provider unavailable', compacted: true, compactNote: '압축 9→4 메시지' });
  expect(decideNextTuiAutoContinue(result, 0, '')).toBe('check');
});

test('only the trusted preflight error carries a public auth failure kind', async () => {
  const unrelated = await startNextTuiTurn({ sessionId: 's1', text: 'work' }, {
    run: async () => { throw new Error('provider said Codex 인증이 준비되지 않았습니다. 주인 호스트에서 접근 미러를 갱신하세요.'); },
  }).done;
  expect(unrelated.kind).toBe('failed');
  expect(unrelated.authFailureKind).toBeUndefined();
  const trusted = await startNextTuiTurn({ sessionId: 's1', text: 'work' }, {
    run: async () => { throw new NextTuiAuthError('codex-auth-missing'); },
  }).done;
  expect(trusted.authFailureKind).toBe('codex-auth-missing');
});

test('Agent progress reaches the display only during the active turn', async () => {
  let emitAgent!: (event: AgentDisplayEvent) => void;
  const seen: AgentDisplayEvent[] = [];
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'delegate' }, {
    run: async (_input, _delta, _compact, _notice, onAgent) => {
      emitAgent = onAgent;
      onAgent({ phase: 'start', id: 'child', description: 'research' });
      return {};
    },
    onAgent: (event) => { seen.push(event); },
  });
  await turn.done;
  emitAgent({ phase: 'finish', id: 'child', status: 'done' });
  expect(seen).toEqual([{ phase: 'start', id: 'child', description: 'research' }]);
});

test('transient request-size status reaches status UI and never becomes a notice', async () => {
  let emitStatus!: (line: string) => void;
  const notices: string[] = [];
  const statuses: string[] = [];
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'large context' }, {
    run: async (_input, _delta, _compact, _notice, _agent, onStatus) => {
      emitStatus = onStatus;
      onStatus('ctx 410,000 chars / 400,000');
    },
    onNotice: (line) => notices.push(line),
    onStatus: (line) => statuses.push(line),
  });
  await turn.done;
  emitStatus('late status');
  expect(statuses).toEqual(['ctx 410,000 chars / 400,000']);
  expect(notices).toEqual([]);
});
