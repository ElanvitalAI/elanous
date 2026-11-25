// TUI-ANSWER-VANISH-GOAL-CONTINUE — OP seat 11-25 (session be2bc47e · build b681b8cb): answer-vanished 16:57:14 ·
// 17:06:40 · 17:22:19 each 0.6 s after a `[골 이어가기]` row was persisted (07:57:13.58 · 08:06:39.97 · 08:22:19.33 UTC).
// The answer before it ended in a pledge, and the log view re-drew that already shown final answer as one
// «· in progress — … (folded)» line. Expectations are literals (rule 11).
import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import { createNextTuiPublicHistoryView } from './entry.js';
import { renderNextTuiLogFrame } from './core/render.js';
import { logViewLines } from './chat/log-view.js';
import { planInterimDisplay } from './chat/goal-interim.js';
import { chatRowsOnScreen, createTranscriptVanishDetector, type TranscriptVanishEvent } from './core/transcript-vanish.js';

const tid = (id: string) => id as NonNullable<SerializedMessage['turn_id']>;

const COLUMNS = 100;
const ANSWER = '착지 목표는 시간당 10건으로 유지합니다.\n\n기존 JUD 요청 #165225의 결과는 17:16(w365) 점검에서 확인하겠습니다.';
const answered: SerializedMessage[] = [
  { role: 'user', content: '[notice · seat-mail · 1 msg · from CLAUDE-OP · #165205]\n\ngoal set', ts: '2026-11-25T08:06:29.120Z', turn_id: tid('u-1') },
  { role: 'assistant', content: ANSWER, ts: '2026-11-25T08:06:37.486Z', replyFinal: true, turn_id: tid('a-1') },
];
// The persisted continuation row, word for word from the live session (row 8001).
const continuation: SerializedMessage = {
  role: 'user', ts: '2026-11-25T08:06:39.975Z', turn_id: tid('u-2'),
  content: '[골 이어가기] 방금 답이 «확인하겠습니다.» 로 끝났다 — 약속만 하고 턴을 끝내지 말고, 그 일을 지금 도구로 실행해 결과물을 만든다. 원래 사용자 요청 범위 안에서만 이어간다. 정말 사람 판단·권한이 필요하면 무엇이 필요한지 한 줄로 묻고 멈춘다.',
} as SerializedMessage;

const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const body = (displayed: readonly SerializedMessage[]) => renderNextTuiLogFrame({
  messages: displayed, columns: COLUMNS, rows: 30, header: ['elanous'], footer: ['─'], promptLine: '› ',
  notices: [], activity: ['⠋ thinking'], scroll: 0, expandedToolIndexes: new Set<number>(),
}).body;

test('a shown final answer ending in a pledge is not folded when the goal-continue row arrives', () => {
  const events: TranscriptVanishEvent[] = [];
  const observe = createTranscriptVanishDetector((event) => events.push(event));
  const view = createNextTuiPublicHistoryView();
  const frameAt = (saved: readonly SerializedMessage[], busy: boolean, since?: number) => {
    const displayed = view(saved, busy, since);
    const lines = body(displayed);
    const { onScreen, evaluated } = chatRowsOnScreen({ saved, displayed, screenLines: lines, tail: 8, renderRow: (row) => logViewLines([row], COLUMNS) });
    observe({ sessionId: 's', saved, displayed, onScreen, evaluated, scroll: 0, userScrolled: false, busy, turnDoor: 'internal', turnSource: 'goal-continue' });
    return lines.map(plain);
  };
  const idle = frameAt(answered, false);
  expect(idle).toContain('착지 목표는 시간당 10건으로 유지합니다.');
  const since = Date.parse('2026-11-25T08:06:39.900Z');
  frameAt(answered, true, since);
  const after = frameAt([...answered, continuation], true, since);
  expect(after).toContain('착지 목표는 시간당 10건으로 유지합니다.');
  expect(after).toContain('기존 JUD 요청 #165225의 결과는 17:16(w365) 점검에서 확인하겠습니다.');
  expect(after.some((line) => line.includes('(folded)'))).toBe(false);
  expect(events).toEqual([]);
});

test('the raw log view keeps a replyFinal answer; a row saved as goalInterim still folds', () => {
  const plan = planInterimDisplay([...answered, continuation]);
  expect(plan.get(1)).toBeUndefined();
  expect(plan.get(2)).toEqual({ kind: 'internal-input', origin: 'goal-continue' });
  const interim = [{ role: 'assistant', content: '1단계 렌더했습니다.\n아직 못 했습니다.', goalInterim: true, ts: '2026-11-25T08:06:37.486Z' }];
  expect(planInterimDisplay(interim).get(0)).toEqual({ kind: 'folded', line: '· in progress — 1단계 렌더했습니다. (folded)' });
});

test('a typed line re-keyed from user@ts to its saved turn_id is not reported as vanished', () => {
  const events: TranscriptVanishEvent[] = [];
  const observe = createTranscriptVanishDetector((event) => events.push(event));
  const frameOf = (saved: readonly SerializedMessage[]) => {
    const lines = body(saved);
    const { onScreen, evaluated } = chatRowsOnScreen({ saved, displayed: saved, screenLines: lines, tail: 8, renderRow: (row) => logViewLines([row], COLUMNS) });
    observe({ sessionId: 's', saved, displayed: saved, onScreen, evaluated, scroll: 0, userScrolled: false, busy: true,
      reload: 'session-reload', turnDoor: 'human' });
  };
  frameOf([...answered, { role: 'user', content: '지금 바로 해주세요. 계속 더 나아가면 되는데 왜 멈췄죠', ts: '2026-11-25T07:08:38.243Z' }]);
  frameOf([...answered, { role: 'user', content: '지금 바로 해주세요. 계속 더 나아가면 되는데 왜 멈췄죠', ts: '2026-11-25T07:08:38.900Z', turn_id: tid('u-9') } as SerializedMessage]);
  expect(events).toEqual([]);
  // A row that is really gone is still reported.
  frameOf(answered);
  expect(events.map((event) => `${event.role}:${event.cause}`)).toEqual(['user:session-reload']);
});
