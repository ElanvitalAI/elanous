import { expect, test } from 'bun:test';
import { nextAssistantPreviewText } from '../chat/assistant-preview.js';
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

test('assistant provenance never promotes unclassified text and replace clears the preview', async () => {
  const previews: Array<{ text: string; source?: string }> = [];
  let clock = 40;
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'stream' }, {
    now: () => (clock += 40),
    run: async (_input, delta) => {
      delta('PRIVATE diagnostic');
      delta('공연 설계 ', false, 'assistant-text');
      delta('진행 중', false, 'assistant-text');
      delta('replacement is reconciled through history', true);
      delta('another diagnostic');
      delta('공개 답변', false, 'assistant-text');
    },
    onPreview: (text, _replace, source) => previews.push({ text, source }),
  });
  await turn.done;
  expect(previews.filter((preview) => preview.source === 'assistant-text').map((preview) => preview.text))
    .toEqual(['공연 설계 ', '공연 설계 진행 중', '공개 답변']);
  expect(previews.some((preview) => preview.text === '' && preview.source === undefined)).toBe(true);
});

test('abort immediately clears the preview even while the runner is still shutting down', async () => {
  const previews: string[] = [];
  let finish!: () => void;
  let emit!: (text: string, replace?: boolean, source?: 'assistant-text') => void;
  let settled = false;
  const turn = startNextTuiTurn({ sessionId: 's1', text: 'work' }, {
    run: (_input, delta) => new Promise<void>((resolve) => {
      finish = resolve;
      emit = delta;
      delta('공연 설계 중 ', false, 'assistant-text');
    }),
    onPreview: (text) => previews.push(text),
    onSettled: () => { settled = true; },
  });
  await Promise.resolve();
  expect(previews).toEqual(['공연 설계 중 ']);
  turn.controller.abort();
  expect(settled).toBe(false);
  expect(previews.at(-1)).toBe('');
  emit('late secret', false, 'assistant-text');
  expect(previews.at(-1)).toBe('');
  finish();
  expect((await turn.done).kind).toBe('cancelled');
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

test('every bounded preview preserves an open private-key marker across long split streams', async () => {
  const screens: string[] = [];
  let tick = 0;
  const turn = startNextTuiTurn({ sessionId: 'synthetic', text: 'long preview' }, {
    now: () => (tick += 100),
    run: async (_input, emit) => {
      emit('Safe heading ' + '\n-----BE', false, 'assistant-text');
      emit('GIN PRIVATE KEY-----\n', false, 'assistant-text');
      for (let i = 0; i < 40; i++) emit('SYNTHETIC-PRIVATE-BODY '.repeat(100) + '\n', false, 'assistant-text');
      emit('-----END PRIVATE KEY-----\npublic after block ', false, 'assistant-text');
      emit('', true);
      emit('Fresh safe preview ', false, 'assistant-text');
      return {};
    },
    onPreview: text => screens.push(nextAssistantPreviewText(text)),
    onSettled: () => {},
  });
  await turn.done;
  // 출처: #37813 security regression emits 40 chunks of 100 synthetic words, exceeding the 32768-character buffer.
  expect(screens.length).toBeGreaterThan(40);
  for (const screen of screens) expect(screen).not.toContain('SYNTHETIC-PRIVATE-BODY');
  expect(screens.at(-1)).toBe('');
});

test('PEM preview suppression survives provenance switches and replace without hiding a later turn', async () => {
  const screens: string[] = [];
  let tick = 0;
  const run = await startNextTuiTurn({ sessionId: 'synthetic', text: 'preview state' }, {
    now: () => (tick += 100),
    run: async (_input, emit) => {
      emit('Safe introduction ', false, 'assistant-text');
      emit('-----BE', false, 'assistant-text');
      emit('GIN PRIVATE KEY-----\n', false);
      emit('SYNTHETIC-PRIVATE-BODY\n', false, 'assistant-text');
      emit('', true);
      emit('SYNTHETIC-PRIVATE-BODY\n-----END PRIVATE KEY-----\n', false, 'assistant-text');
      return {};
    },
    onPreview: text => screens.push(nextAssistantPreviewText(text)),
    onSettled: () => {},
  }).done;
  expect(run.kind).toBe('completed');
  for (const screen of screens) expect(screen).not.toContain('SYNTHETIC-PRIVATE-BODY');
  const fresh: string[] = [];
  await startNextTuiTurn({ sessionId: 'synthetic', text: 'new turn' }, {
    run: async (_input, emit) => { emit('Visible normal text ', false, 'assistant-text'); return {}; },
    onPreview: text => fresh.push(text), onSettled: () => {},
  }).done;
  expect(fresh).toContain('Visible normal text ');
});

test('replacement frame text is scanned before reset and later assistant frames remain hidden', async () => {
  const screens: string[] = [];
  let tick = 0;
  await startNextTuiTurn({ sessionId: 'synthetic', text: 'replacement' }, {
    now: () => (tick += 100),
    run: async (_input, emit) => {
      emit('-----BEGIN PRIVATE KEY-----', true, 'assistant-text');
      emit('SYNTHETIC-PRIVATE-BODY ', false, 'assistant-text');
      emit('', true);
      emit('SYNTHETIC-PRIVATE-BODY ', false);
      emit('SYNTHETIC-PRIVATE-BODY ', false, 'assistant-text');
      return {};
    },
    onPreview: text => screens.push(nextAssistantPreviewText(text)), onSettled: () => {},
  }).done;
  expect(screens.every(screen => !screen.includes('SYNTHETIC-PRIVATE-BODY'))).toBe(true);
});

test('ordinary long responses continue showing newly streamed text beyond the preview window', async () => {
  const screens: string[] = [];
  let tick = 0;
  await startNextTuiTurn({ sessionId: 'synthetic', text: 'long ordinary response' }, {
    now: () => (tick += 100),
    run: async (_input, emit) => {
      // 출처: #37815 existing preview window is 32768 characters; this payload crosses it.
      emit('ordinary '.repeat(5000), false, 'assistant-text');
      emit('LATEST-ORDINARY-FRAME ', false, 'assistant-text');
      return {};
    },
    onPreview: text => screens.push(nextAssistantPreviewText(text)), onSettled: () => {},
  }).done;
  expect(screens.at(-1)).toContain('LATEST-ORDINARY-FRAME ');
});
