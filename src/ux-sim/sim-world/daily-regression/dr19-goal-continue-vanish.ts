// DR19 · TUI-ANSWER-VANISH-GOAL-CONTINUE (대표 11-25 #1 frustration «answers vanish» · OP be2bc47e 16:57 · 17:06 · 17:22):
// a long OP-like turn ends with a pledge («…확인하겠습니다.»), the #40092 goal drive opens a goal-continue turn that
// carries the held-mail peek and a joined related mail, the continuation row is persisted, then the held mail is
// flushed as a notice turn at idle. Live, the answer the person was reading turned into one «· in progress — … (folded)»
// line the moment the continuation row arrived. Real public view + real log render + real held/joined block builders +
// the real vanish detector; only the clock is fixed. Expectations are literals (independent of product constants).
import type { SerializedMessage } from '../../../session/index.js';
import type { DailyRegressionScenario } from './scenarios.js';

const tid = (id: string) => id as NonNullable<SerializedMessage['turn_id']>;

const COLUMNS = 110;
const ROWS = 40;
const ANSWER_HEAD = 'DR19-ANSWER-MARK #39491 stays on remote HOLD.';
const ANSWER_TAIL = '16:59(w346)에 RES의 갱신을 확인하겠습니다.';
const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The OP-like exchange: a seat-mail turn with a long answer whose last sentence is a pledge. */
export function dr19Answered(): SerializedMessage[] {
  const bullets = Array.from({ length: 8 }, (_, i) => `- DR19 line ${i + 1}: TC·RES 기존 수정선 유지 · 영수 #16514${i} 확인.`).join('\n');
  return [
    { role: 'user', content: '[notice · seat-mail · 1 msg · from RES · #165140]\n\n#39491 정확한 장애 보고', ts: '2026-11-25T07:56:47.495Z', turn_id: tid('u-1') },
    { role: 'tool', content: '⚙️ MsgList', ts: '2026-11-25T07:56:50.000Z', toolName: 'MsgList' },
    { role: 'assistant', content: `**${ANSWER_HEAD}**\n\n${bullets}\n\n${ANSWER_TAIL}`, ts: '2026-11-25T07:57:04.418Z', replyFinal: true, turn_id: tid('a-1') },
  ];
}

export const dr19: DailyRegressionScenario = {
  id: 'DR19', prs: [],
  title: 'answer ending in a pledge stays on screen through goal-continue (held peek + joined mail) and the held-mail flush',
  async run(ctx) {
    const failures: string[] = [];
    const ok = (label: string, condition: boolean, observed?: unknown) => {
      if (!condition) failures.push(`${label}${observed === undefined ? '' : ` · observed ${JSON.stringify(observed).slice(0, 300)}`}`);
    };
    const { createNextTuiPublicHistoryView } = await import('../../../tui/entry.js');
    const { renderNextTuiLogFrame } = await import('../../../tui/core/render.js');
    const { logViewLines } = await import('../../../tui/chat/log-view.js');
    const { chatRowsOnScreen, createTranscriptVanishDetector } = await import('../../../tui/core/transcript-vanish.js');
    const { formatGoalContinuePrompt } = await import('../../../tui/input/goal-continue.js');
    const { heldPeekBlock, relatedJoinBlock } = await import('../../../tui/queue-finish-first.js');
    const events: { role: string; cause: string; preview: string }[] = [];
    const observe = createTranscriptVanishDetector((event) => events.push({ role: event.role, cause: event.cause, preview: event.preview }));
    const view = createNextTuiPublicHistoryView();
    const frame = (saved: readonly SerializedMessage[], busy: boolean, since?: number) => {
      const displayed = view(saved, busy, since);
      const body = renderNextTuiLogFrame({ messages: displayed, columns: COLUMNS, rows: ROWS, header: ['elanous'], footer: ['─'],
        promptLine: '› ', notices: [], activity: busy ? ['⠋ thinking'] : [], scroll: 0, expandedToolIndexes: new Set<number>() }).body;
      const { onScreen, evaluated } = chatRowsOnScreen({ saved, displayed, screenLines: body, tail: 8, renderRow: (row) => logViewLines([row], COLUMNS) });
      observe({ sessionId: 'dr19', saved, displayed, onScreen, evaluated, scroll: 0, userScrolled: false, busy,
        turnDoor: 'internal', turnSource: 'goal-continue' });
      return body.map(plain);
    };
    const answerWhole = (screen: readonly string[]) => screen.some((line) => line.includes(ANSWER_HEAD))
      && screen.some((line) => line.includes('DR19 line 8')) && !screen.some((line) => line.includes('(folded)'));
    const answered = dr19Answered();
    // 1) idle — the person reads the whole answer.
    ok('idle: whole answer on screen', answerWhole(frame(answered, false)));
    // 2) goal-continue opened (busy, its row not persisted yet).
    const since = Date.parse('2026-11-25T07:57:11.618Z');
    ok('continuation started: whole answer on screen', answerWhole(frame(answered, true, since)));
    // 3) the continuation row persisted: pledge prompt + joined related mail + held-mail peek (the #40092 turn text).
    const related = relatedJoinBlock([{ id: 'q29', kind: 'notice', source: 'seat-mail', msgId: 165158,
      text: '[from RES · alert]\nmsg:165158 · DR19-JOINED compact 호출 경로 확인 결과' }]);
    const held = heldPeekBlock(Array.from({ length: 3 }, (_, i) => ({ id: `q3${i}`, kind: 'notice' as const, source: 'seat-mail' as const,
      msgId: 165160 + i, text: `DR19-HELD-${i} 진행 보고 ${i}` })));
    const continuation: SerializedMessage = { role: 'user', content: `${formatGoalContinuePrompt('확인하겠습니다.')}\n\n${related}\n\n${held}`,
      ts: '2026-11-25T07:57:13.583Z', turn_id: tid('u-2'), from: { kind: 'system', origin: 'goal-continue' } } as SerializedMessage;
    const withContinuation = [...answered, continuation];
    const afterRow = frame(withContinuation, true, since);
    ok('continuation row persisted: whole answer still on screen (not folded)', answerWhole(afterRow), afterRow.slice(-14));
    ok('continuation row persisted: drawn as one auto-resume line (no held/joined bodies)',
      !afterRow.some((line) => line.includes('DR19-HELD-0') || line.includes('DR19-JOINED')), afterRow.slice(-6));
    // 4) continuation answered, then the held mail is flushed as a notice turn at idle.
    const second: SerializedMessage = { role: 'assistant', content: 'DR19-SECOND RES 갱신을 확인했습니다. 차단은 유지합니다.',
      ts: '2026-11-25T07:57:40.000Z', replyFinal: true, turn_id: tid('a-2') };
    const flushed = [...withContinuation, second, { role: 'user', content: '[notice · seat-mail · 3 msg]\n\nDR19 held flush digest',
      ts: '2026-11-25T07:57:45.000Z', turn_id: tid('u-3') } as SerializedMessage];
    const afterFlush = frame(flushed, true, Date.parse('2026-11-25T07:57:44.000Z'));
    ok('held flush: first answer still whole', answerWhole(afterFlush), afterFlush.slice(-14));
    ok('held flush: second answer on screen', afterFlush.some((line) => line.includes('DR19-SECOND')));
    // 5) a typed line (pending echo · `user@ts`) re-keyed when the child persists it is not a vanish.
    const echoTs = '2026-11-25T07:58:00.000Z';
    frame([...flushed, { role: 'user', content: 'DR19-TYPED 지금 바로 해주세요', ts: echoTs }], true, Date.parse(echoTs));
    frame([...flushed, { role: 'user', content: 'DR19-TYPED 지금 바로 해주세요', ts: '2026-11-25T07:58:00.700Z', turn_id: tid('u-4') } as SerializedMessage], true, Date.parse(echoTs));
    ok('vanish detector: no events across the sequence', events.length === 0, events);
    ctx.note('dr19-sequence', { events: events.length });
    return failures.length === 0 ? { ok: true } : { ok: false, diff: failures.join('\n') };
  },
};
