// TUI-ANSWER-VANISH-ON-TOOLCALL (0.3.35 P0) — synthetic universe, no real LLM.
//
// Live sample (OP seat 11-24 04:50–05:20 KST, session 6b0273ce): every turn starts with a forced turn-start
// compaction (`compact.session force`, chat.ts). The compactor rewrote the session store as
// [tool rows…, <context_summary>, preserved user rows…, tail] — assistant answers before the tail were deleted
// (1935 rows on disk: 1613 tool rows, 294 user rows, 3 assistant rows). The Next TUI reloads the store on the
// first tool event of the running turn (entry.ts onMessageBlock → loadSession), so the moment a tool call
// started, the answers on screen disappeared. These tests drive that sequence on the real store and the real
// basic-chat projection: answer shown → turn-start compaction (+ notice / steer / re-compaction variants) →
// tool event reload → the answer is still on screen, still in the saved transcript, and is never replayed to
// the model twice.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAutoCompactWindow } from '../compact/auto.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import { toLLM } from '../session/chat.js';
import { compactSessionHistory } from '../session/compact-session.js';
import { appendMessage, createSession, loadSession } from '../session/index.js';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import * as actualUserIntent from '../user-intent/index.js';
import { englishFooterText } from './chat/status-line.js';
import { nextTuiPublicHistory } from './core/public-history.js';
import { createNextTuiQueue } from './core/queue.js';
import { joinedSteerRows, liveSteerStatus } from './core/steer-status.js';
import { heldPreToolText } from './core/held-answer.js';
import { startNextTuiTurn } from './core/turn.js';

const MODEL = 'answer-vanish-synthetic';
const LONG_ANSWER = '**REL은 깨어서 발행 작업 중입니다.** 05:09 재실행한 preflight는 또 차단됐고, 컷은 아직 시작되지 않았습니다. 차단 원문과 수리 담당을 확인했습니다.';
const SECOND_ANSWER = '**0.3.34는 아직 발행되지 않았습니다.** REL에 재검과 컷 영수 보고를 요청했습니다.';

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'answer-vanish-'));
  for (const key of ['HOME', 'ELANOUS_SESSION_ROOT']) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});

afterAll(() => {
  intentSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => { resetAutoCompactStateForTest(); });

const summarizer: CompactProvider = {
  async summarize(args) { return { summary: 'synthetic summary', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => resolveAutoCompactWindow(MODEL),
  getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
};

let clockSeconds = 0;
const at = () => new Date(Date.UTC(2026, 10, 23, 19, 0, clockSeconds++)).toISOString();
const user = (id: string, content: string) => appendMessage(id, { role: 'user', content, ts: at(), from: { kind: 'human' } });
const answer = (id: string, content: string) => appendMessage(id, { role: 'assistant', content, ts: at(), replyFinal: true });
const tool = (id: string, name: string) => appendMessage(id, {
  role: 'tool', content: `⚙️ ${name}`, ts: at(), toolName: name, toolCallId: `call-${clockSeconds}`, toolResult: { ok: true },
});
const notice = (id: string, msgId: string) => appendMessage(id, {
  role: 'user', content: `[notice · seat-mail]\n\n[from REL · info]\nmsg:${msgId} · preflight 차단`, ts: at(),
  from: { kind: 'agent', seat: 'REL', msgId, intent: 'info' },
});

/** The answers the basic chat shows (the screen model of the Next TUI transcript), in screen order. */
const screenAnswers = (id: string): string[] => nextTuiPublicHistory(loadSession(id)!.messages)
  .filter((row) => row.role === 'assistant').map((row) => row.content);
/** A turn whose earlier rounds already answered: a few question/answer pairs and their tool trace. */
const seedAnsweredTurns = (id: string): void => {
  user(id, '네 버전 발행 상태 잘 챙겨주세요');
  tool(id, 'MsgList');
  tool(id, 'RunShell');
  answer(id, LONG_ANSWER);
  user(id, '제가 요청을 하면 끝까지 확인을 해야죠.');
  tool(id, 'ElsControl');
  answer(id, SECOND_ANSWER);
  for (let i = 0; i < 4; i++) { user(id, `후속 지시 ${i}`); answer(id, `후속 답 ${i}`); }
};
/** chat.ts turn start: the forced compaction before the request (`compact.session force`). */
const turnStartCompaction = async (id: string) => {
  const result = await compactSessionHistory(id, { config: CHAT_DEFAULTS.autoCompact, force: true, modelId: MODEL, provider: summarizer });
  expect(result.fired).toBe(true);
  expect(result.layer3Applied).toBe(true);
};

describe('TUI-ANSWER-VANISH-ON-TOOLCALL — an answer on screen survives the turn-start compaction and the tool-event reload', () => {
  test('V1 plain: answer shown → next turn compacts → first tool event reloads → answer still shown, once', async () => {
    const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
    seedAnsweredTurns(id);
    expect(screenAnswers(id)).toContain(LONG_ANSWER);
    user(id, '다음 턴 시작');
    await turnStartCompaction(id);
    tool(id, 'MsgList'); // the tool event that makes the TUI reload the store mid-turn
    const shown = screenAnswers(id);
    expect(shown).toContain(LONG_ANSWER);
    expect(shown).toContain(SECOND_ANSWER);
    expect(shown.filter((text) => text === LONG_ANSWER)).toHaveLength(1);
    // saved transcript keeps it; the model gets it through the summary only, never as a replayed row.
    expect(loadSession(id)!.messages.some((row) => row.role === 'assistant' && row.content === LONG_ANSWER)).toBe(true);
    expect(toLLM(loadSession(id)!.messages).some((row) => row.content === LONG_ANSWER)).toBe(false);
  });

  test('V1 order: the kept answer stays under its own question, not above every question', async () => {
    const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
    seedAnsweredTurns(id);
    user(id, '다음 턴 시작');
    await turnStartCompaction(id);
    const rows = nextTuiPublicHistory(loadSession(id)!.messages).filter((row) => row.role === 'user' || row.role === 'assistant');
    const question = rows.findIndex((row) => row.role === 'user' && row.content === '네 버전 발행 상태 잘 챙겨주세요');
    const reply = rows.findIndex((row) => row.role === 'assistant' && row.content === LONG_ANSWER);
    const nextQuestion = rows.findIndex((row) => row.role === 'user' && row.content === '제가 요청을 하면 끝까지 확인을 해야죠.');
    expect(question).not.toBe(-1);
    expect(reply).toBeGreaterThan(question);
    expect(nextQuestion).toBeGreaterThan(reply);
  });

  test('V2 seat-mail notice during the stream: notice rows arrive, compaction runs, answer still shown', async () => {
    const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
    seedAnsweredTurns(id);
    notice(id, '#138133');
    notice(id, '#138134');
    await turnStartCompaction(id);
    tool(id, 'ScheduleWakeup');
    expect(screenAnswers(id)).toContain(LONG_ANSWER);
  });

  test('V3 steer joins at the tool boundary: the steer row lands mid-turn, answer still shown', async () => {
    const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
    seedAnsweredTurns(id);
    user(id, '발행 확인 턴');
    await turnStartCompaction(id);
    tool(id, 'RunShell');
    user(id, '모르겠습니다. 하면 되나요?'); // the steer delivered at the tool-result boundary
    tool(id, 'MsgPost');
    expect(screenAnswers(id)).toContain(LONG_ANSWER);
  });

  test('V4 retry / re-compaction: a second forced compaction keeps the already kept answer and never replays it', async () => {
    const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
    seedAnsweredTurns(id);
    user(id, '첫 압축 턴');
    await turnStartCompaction(id);
    for (let i = 0; i < 4; i++) { user(id, `재압축 전 지시 ${i}`); answer(id, `재압축 전 답 ${i}`); }
    await turnStartCompaction(id);
    tool(id, 'MsgList');
    const shown = screenAnswers(id);
    expect(shown).toContain(LONG_ANSWER);
    expect(shown).toContain('재압축 전 답 0');
    expect(shown.filter((text) => text === LONG_ANSWER)).toHaveLength(1);
    const wire = toLLM(loadSession(id)!.messages);
    expect(wire.some((row) => row.content === LONG_ANSWER)).toBe(false);
    expect(wire.filter((row) => row.role === 'system' && typeof row.content === 'string' && row.content.startsWith('<context_summary>'))).toHaveLength(1);
  });

  test('V5 steer echo: queued → joins at the tool boundary → the person line shows after the tool result and before the next answer', async () => {
    const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
    seedAnsweredTurns(id);
    user(id, '발행 확인 턴');
    await turnStartCompaction(id);
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueue('모르겠습니다. 하면 되나요?', 'steer-28');
    const sent = '조향 대기 1건 · 다음 도구 경계에 넣음 · Esc 취소';
    expect(englishFooterText(liveSteerStatus(sent, queue.steerCount, true).text)).toContain('1 steer pending');
    tool(id, 'RunShell'); // the tool result at whose boundary the steer joins
    const rows = joinedSteerRows(queue.items, ['steer-28'], at);
    expect(queue.markSteered(['steer-28'])).toBe(1);
    for (const row of rows) appendMessage(id, row);
    answer(id, '확인했습니다. 끝까지 추적하겠습니다.');
    const screen = nextTuiPublicHistory(loadSession(id)!.messages);
    const saved = loadSession(id)!.messages;
    const toolAt = saved.map((row) => row.role).lastIndexOf('tool');
    const echoAt = screen.findIndex((row) => row.role === 'user' && row.content === '모르겠습니다. 하면 되나요?\n(joined mid-turn)');
    const nextAnswerAt = screen.findIndex((row) => row.role === 'assistant' && row.content === '확인했습니다. 끝까지 추적하겠습니다.');
    expect(echoAt).not.toBe(-1);
    expect(echoAt).toBeGreaterThan(toolAt);
    expect(nextAnswerAt).toBeGreaterThan(echoAt);
    expect(englishFooterText(liveSteerStatus(sent, queue.steerCount, true).text)).not.toContain('steer pending');
    expect(screenAnswers(id)).toContain(LONG_ANSWER);
    // the next turn's model history carries the joined line once, as the person's words
    expect(toLLM(loadSession(id)!.messages).filter((row) => row.content === '모르겠습니다. 하면 되나요?')).toHaveLength(1);
  });

  test('V5 live preview: pre-tool streamed text survives the tool-round clear frame and keeps growing after the tool', async () => {
    const previews: string[] = [];
    await startNextTuiTurn({ sessionId: 'synthetic', text: 'stream' }, {
      now: (() => { let clock = 0; return () => (clock += 100); })(),
      run: async (_input, delta) => {
        delta('긴 답변 앞부분', false, 'assistant-text');
        delta('', false, 'assistant-text'); // llm.ts clearVisibleAssistantTextForToolRound frame
        delta(' · 도구 뒤 이어짐', false, 'assistant-text');
      },
      onPreview: (text) => previews.push(text),
    }).done;
    expect(previews.at(-1)).toBe('긴 답변 앞부분 · 도구 뒤 이어짐');
    expect(previews.includes('')).toBe(false);
  });

  test('V7 tool-round clear frame hands the shown pre-tool lines to the screen holder', async () => {
    const held: string[] = [];
    await startNextTuiTurn({ sessionId: 'synthetic', text: 'stream' }, {
      now: (() => { let clock = 0; return () => (clock += 100); })(),
      run: async (_input, delta) => {
        delta('답변 앞부분이 화면에 흘렀습니다', false, 'assistant-text');
        delta('', true); // llm.ts clearVisibleAssistantTextForToolRound frame
        delta('도구 뒤 마저 답합니다', false, 'assistant-text');
      },
      onHeldAnswer: (text) => held.push(text),
      onPreview: () => {},
    }).done;
    expect(held).toEqual(['답변 앞부분이 화면에 흘렀습니다']);
  });

  test('V7b a PEM-blocked clear hands nothing to the screen holder', async () => {
    const held: string[] = [];
    await startNextTuiTurn({ sessionId: 'synthetic', text: 'stream' }, {
      now: (() => { let clock = 0; return () => (clock += 100); })(),
      run: async (_input, delta) => {
        delta('-----BEGIN PRIVATE KEY-----\nsecret material', false, 'assistant-text');
        delta('', true);
      },
      onHeldAnswer: (text) => held.push(text),
      onPreview: () => {},
    }).done;
    expect(held).toEqual([]);
  });

  test('V8 real-wire settle: plain delta → tool event → empty-chunk clear → the holder keeps the pre-tool lines', async () => {
    // The real wire (llm.ts clearVisibleAssistantTextForToolRound → chat.ts → repl → local-chat-turn)
    // hands the tool-round clear down as an empty chunk, never a replace frame, so the live
    // onHeldAnswer hook never fires. The pre-tool lines live only in the preview until settle
    // (entry.ts) hands them to the screen holder from the preview + the tool-event offsets.
    const previews: string[] = [];
    const toolTextOffsets = new Map<string, number>();
    const preTool = 'AVTEXT-01 선도구 앞에 화면에 흘렀던 줄.\nAVTEXT-02 두 번째 줄.';
    const postTool = 'AVTEXT-F1 도구 결과를 받은 뒤 이어지는 마무리.';
    await startNextTuiTurn({ sessionId: 'synthetic', text: 'stream' }, {
      now: (() => { let clock = 0; return () => (clock += 100); })(),
      run: async (_input, delta) => {
        delta(preTool, false, 'assistant-text');
        // entry.ts onToolEvent: the flushed preview's length at the tool's start is the call's offset.
        toolTextOffsets.set('call-1', preTool.length);
        delta('', false, 'assistant-text'); // the real clear frame: an empty chunk, not a replace
        delta(postTool, false, 'assistant-text');
      },
      onPreview: (text) => previews.push(text),
    }).done;
    const settledPreview = previews.at(-1)!; // entry.ts streamPreview, discarded right after settle
    expect(settledPreview).toBe(preTool + postTool);
    expect(heldPreToolText({ sessionId: 'synthetic', text: settledPreview }, toolTextOffsets)).toBe(preTool);
  });

  test('V8b tool-first and PEM-blocked settles hand nothing to the holder', () => {
    expect(heldPreToolText(null, new Map<string, number>())).toBe(null);
    expect(heldPreToolText({ sessionId: 'synthetic', text: '도구 뒤에 바로 답을 이었습니다.' }, new Map<string, number>([['call-1', 0]]))).toBe(null);
    expect(heldPreToolText({ sessionId: 'synthetic', text: '-----BEGIN PRIVATE KEY-----\nsecret material' }, new Map<string, number>())).toBe(null);
  });

  // Every injection that enters or opens a turn lands as a saved user row; the vanish was the store reload that
  // follows the turn-start compaction, whichever event triggers it first — not the event kind itself.
  for (const [kind, from, content] of [
    ['seat-mail digest auto-submit', { kind: 'agent', seat: 'REL', msgId: '#138146', intent: 'alert' }, '[notice · seat-mail]  [seat-mail digest] 2 mails — 2 need action'],
    ['els stall alert', { kind: 'agent', seat: 'TA-ELS', msgId: '#138077', intent: 'alert' }, '[notice · seat-mail]  [from TA-ELS · alert] [els stall] w8171b7a4'],
    ['capsule-done notice', { kind: 'system', seat: 'SYS' }, '[capsule done] review capsule finished · 1 result'],
    ['watchdog / sweep wake', { kind: 'system', seat: 'SYS' }, '[자동 깨움 05:10 · 매시 회고] HOURLY-RETRO-TEMPLATE.md 순서대로'],
    ['person line queued while busy', { kind: 'human' }, '네 버전 발행 상태 잘 챙겨주세요'],
  ] as const) {
    test(`V6 ${kind}: injected row → turn-start compaction → reload → the earlier answer is still shown`, async () => {
      const id = createSession({ source: 'tui', provider: 'synthetic', model: MODEL }).id;
      seedAnsweredTurns(id);
      appendMessage(id, { role: 'user', content, ts: at(), from });
      await turnStartCompaction(id);
      tool(id, 'MsgList');
      expect(screenAnswers(id)).toContain(LONG_ANSWER);
      expect(screenAnswers(id)).toContain(SECOND_ANSWER);
    });
  }
});
