// ELN-COMPACT-REAL(OP #135458) — 정본: ~/elanous-hq/seat-state/OP/research/ELN-OP-CONTEXT-AUDIT-1123.md §4-4.
// ① 턴 시작 트리거는 기록만 잰다(고정 접두 제외): 기록 16K 토큰 OR 전체 실측 입력 60K 토큰 — 먼저 오는 쪽.
// ② agent/system 전송원(`from`)을 가진 user 행(자리 우편 알림)은 원문 보존 대상이 아니다:
//    `[seat-mail <msgId> from <who>] <첫 줄>` 한 줄 스텁으로 응축된다. 사람(human/`from` 부재)만 원문 보존.
// ③ no-op force 뒤에는 기록이 +25% 자라기 전까지 재force를 보류한다.
// 시험 우주 = 합성(recorder chat provider · summarizer seam) — 전후 숫자 영수는 원격(node-b) 실행(§6).

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { estimateMessagesTokens } from '../tokens.js';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import { resolveAutoCompactWindow } from '../compact/auto.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import * as actualUserIntent from '../user-intent/index.js';
import { appendMessage, createSession, loadSession, type MessageSource, type SerializedMessage } from './index.js';
import { runTurn, toLLM } from './chat.js';
import { compactSessionHistory } from './compact-session.js';

// ── fixture parameters (not product constants) ───────────────────────────────
const MODEL = 'eln-compact-real'; // no catalog entry → the 32k fallback window (compact/auto.ts)
const REPLY_CHARS = 1_200; // 기존 시험 fixture(long-session-compact.test.ts)와 동일
const SYSTEM_PROMPT = 'ELN-COMPACT-REAL system prompt — you are the OP seat.';
const HISTORY_FIRE_TOKENS = 17_000; // 출처: §4-4① — 기록 16K 임계 위 / 전체 60K 아래 = 기록 기준 발화 우주
const BIG_PROMPT_CHARS = 120_000; // ≈30K 토큰 — 옛 트리거(24K)는 넘지만 기록 없이는 발화하지 않아야 한다(§4-4①)
const HUGE_PROMPT_CHARS = 240_000; // ≈60K 토큰 — 전체 실측 입력 60K 밸브가 기록이 작아도 발화해야 한다(§4-4①)
const MAIL_COUNT = 75; // 출처: §6 합성 우주 — 75 notice turns(OP 원문 재현)
const STUB_PREFIX = '[seat-mail';

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'eln-compact-real-'));
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
  async summarize(args) { return { summary: 'fake summary', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => resolveAutoCompactWindow(MODEL),
  getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
};
/** §4-4③ no-op 우주 — layer3 요약조차 null 이라 압축이 줄지 않는다. */
const nullSummarizer: CompactProvider = {
  async summarize() { return null; },
  getContextWindow: () => resolveAutoCompactWindow(MODEL),
  getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
};

const recorder = (name: string) => {
  const requests: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name, defaultModel: MODEL, available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages) {
      requests.push(structuredClone(messages));
      yield { type: 'text', delta: `reply ${requests.length} ${'r'.repeat(REPLY_CHARS)}` };
    },
  };
  return { requests, provider };
};

const turn = (provider: LLMProvider, sessionId: string, userText: string, extra: object = {}) => runTurn({
  userConfig: {
    chat: {},
    llm: { provider: provider.name, model: provider.defaultModel, memoryJudge: { enabled: false, crossRecall: false } },
  } as never,
  sessionId, userText, systemPrompt: SYSTEM_PROMPT, skipMemoryInjection: true, provider, compactProvider: summarizer, ...extra,
});

const conversation = (count: number, from: number, chars = REPLY_CHARS): SerializedMessage[] => Array.from({ length: count }, (_, i): SerializedMessage => ({
  role: i % 2 === 0 ? 'user' : 'assistant', content: `seeded ${from + i} ${'m'.repeat(chars)}`, ts: new Date(Date.UTC(2026, 10, 23, 0, from + i)).toISOString(),
}));

/** §4-4③ 우주 — 시드는 사람 user 행만 채운다: turn-1 force 시점엔 drop 후보(assistant·tool 캐리어)가
 *  없어 compact가 정확히 1회만 요약한다. 이후 turn 응답 assistant 행이 기록에 쌓이면 재force의
 *  drop-oldest 재시도(codex #1)가 캐리어를 흘려 재요약한다 — 아래 ③ 기대치(총 3회) 참조. */
const userRows = (count: number, from: number, chars = REPLY_CHARS): SerializedMessage[] => Array.from({ length: count }, (_, i): SerializedMessage => ({
  role: 'user', content: `seeded-u ${from + i} ${'u'.repeat(chars)}`, ts: new Date(Date.UTC(2026, 10, 23, 1, from + i)).toISOString(),
}));

/** §6 합성 우주 — OP 라이브 원장의 notice 우편(전송원 계층 포함). */
const mail = (i: number): string =>
  `[notice · seat-mail]\n\n[from JUD-3 · info]\nmsg:${135400 + i} · [판정] #3977${i % 10} 기능 PASS · mustFix 0 · judb-3977${i % 10}.json\n\n[미읽음 총 ${16 + i}통]`;
const mailSource = (i: number): MessageSource => ({ kind: 'agent', seat: 'JUD-3', msgId: `#${135400 + i}`, intent: 'info' });

/** 기록 토큰 수 — 저장된 행만(고정 접두·턴 휘발성 블록 제외). */
const historyTokens = (sessionId: string) => estimateMessagesTokens(toLLM(loadSession(sessionId)!.messages));
const stringChars = (sessionId: string) => loadSession(sessionId)!.messages
  .reduce((n, row) => n + (typeof row.content === 'string' ? row.content.length : JSON.stringify(row.content).length), 0);
const hasSummary = (sessionId: string) => loadSession(sessionId)!.messages
  .some(row => typeof row.content === 'string' && row.content.startsWith('<context_summary>'));

const turnStart = (log: { mock: { calls: unknown[][] } }) => log.mock.calls
  .filter((call: unknown[]) => call[0] === 'compact.session' && call[1] === 'turn-start')
  .map((call: unknown[]) => call[2] as { fired: boolean; reason: string; usedTokens: number; historyUsedTokens?: number });

describe('ELN-COMPACT-REAL ① — 턴 시작 트리거는 기록만 잰다(고정 접두 제외)', () => {
  test('큰 고정 접두(≈30K)만으로는 발화하지 않는다 — 기록 1.8K · 전체 31K 미달(§4-4①)', async () => {
    const { provider } = recorder('elc-big-prefix');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    for (const row of conversation(6, 1)) appendMessage(session.id, row); // 기록 ≈ 1.8K 토큰
    expect(historyTokens(session.id)).toBeLessThan(16_000); // 출처: §4-4① 기록 16K 임계
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'current request', { systemPrompt: 'P'.repeat(BIG_PROMPT_CHARS) });
      expect(turnStart(log)).toEqual([]); // 옛 트리거(24K)는 프롬프트만으로 매 턴 발화했다(감사 W3 원인)
      expect(hasSummary(session.id)).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('기록이 16K 를 넘으면 작은 프롬프트에서도 발화한다(전체 60K 미만 → 기록 기준, §4-4①)', async () => {
    const { provider } = recorder('elc-history-fire');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    let at = 1;
    while (historyTokens(session.id) < HISTORY_FIRE_TOKENS) {
      for (const row of conversation(2, at)) appendMessage(session.id, row);
      at += 2;
    }
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'current request');
      expect(turnStart(log).map(event => event.fired)).toEqual([true]); // 옛 트리거(전체 24K)는 이 기록을 못 본다
      expect(hasSummary(session.id)).toBe(true);
    } finally { log.mockRestore(); }
  });

  test('전체 실측 입력이 60K 를 넘으면 기록이 작아도 발화한다(전체 밸브, §4-4①)', async () => {
    const { provider } = recorder('elc-full-valve');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    for (const row of conversation(6, 1)) appendMessage(session.id, row);
    const log = spyOn(debug, 'log');
    try {
      // 프롬프트 단독으로 24K 트림 상한을 넘는 우주 — 발화 뒤 턴은 D1 계약대로 ✗ 로 멈춘다.
      await expect(turn(provider, session.id, 'current request', { systemPrompt: 'P'.repeat(HUGE_PROMPT_CHARS) }))
        .rejects.toThrow('문맥 예산 초과');
      expect(turnStart(log).map(event => event.fired)).toEqual([true]);
    } finally { log.mockRestore(); }
  });
});

describe('ELN-COMPACT-REAL ② — agent/system 알림은 한 줄 스텁, 사람만 원문', () => {
  test('75통 자리 우편: 원문은 소멸하고 msgId·from 스텁만 산다(§6 우주)', async () => {
    const session = createSession({});
    appendMessage(session.id, { role: 'user', content: 'OP 지시: 랜딩 큐를 계속 밀어라.', ts: new Date().toISOString() });
    for (let i = 0; i < MAIL_COUNT; i++) {
      appendMessage(session.id, { role: 'user', content: mail(i), ts: new Date().toISOString(), from: mailSource(i) });
      appendMessage(session.id, { role: 'assistant', content: `JUD-3 #3977${i % 10} PASS 확인(#${135400 + i}).`, ts: new Date().toISOString() });
    }
    const beforeRows = loadSession(session.id)!.messages.length;
    const beforeChars = stringChars(session.id);
    const result = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, modelId: MODEL, provider: summarizer });
    expect(result.fired).toBe(true);
    expect(result.layer3Applied).toBe(true);
    const after = loadSession(session.id)!.messages;
    // 원문 소멸 — 알림 본문·미읽음 꼬리는 어디에도 남지 않는다(옛 동작: 75통 전부 원문 보존).
    expect(after.some(row => typeof row.content === 'string' && row.content.includes('[미읽음 총'))).toBe(false);
    // 알림마다 msgId·from 한 줄 스텁이 산다.
    for (let i = 0; i < MAIL_COUNT; i++) {
      expect(after.some(row => typeof row.content === 'string' && row.content.includes(`[seat-mail #${135400 + i} from JUD-3]`))).toBe(true);
    }
    // 사람 입력(전송원 부재)은 원문 그대로.
    expect(after.some(row => row.content === 'OP 지시: 랜딩 큐를 계속 밀어라.')).toBe(true);
    // 스텁은 한 줄이다(줄바꿈 없음).
    for (const row of after) {
      if (typeof row.content === 'string' && row.content.startsWith(STUB_PREFIX)) expect(row.content.includes('\n')).toBe(false);
    }
    // 실제 감축 — 행 수·문자 수 모두 줄어든다.
    expect(after.length).toBeLessThan(beforeRows);
    expect(stringChars(session.id)).toBeLessThan(beforeChars);
  });

  test('system 전송원 알림도 스텁 대상 — 사람(human 명시)은 원문 보존(§4-4②)', async () => {
    const session = createSession({});
    // RED ②b 원인 — 3행(preserveLastN 4 이하)은 sliceForSummary가 공백이라 압축 자체가 무발화한다:
    // 요약 슬라이스가 생기도록 대화를 먼저 성장시키고 system/human 행을 꼬리에 얹는다.
    appendMessage(session.id, { role: 'user', content: 'OP 지시: 야간 창구를 지켜라.', ts: new Date().toISOString() });
    for (const row of conversation(12, 1)) appendMessage(session.id, row); // 12행 — slice(1, 12) 비공백(출처: #135458 §4-4② 픽스처)
    appendMessage(session.id, { role: 'user', content: '[system notice] 야간 정비 창구 03:00-03:20', ts: new Date().toISOString(), from: { kind: 'system', seat: 'SYS', msgId: '#9001' } });
    appendMessage(session.id, { role: 'user', content: '사람이 직접 친 지시문', ts: new Date().toISOString(), from: { kind: 'human' } });
    appendMessage(session.id, { role: 'assistant', content: '확인.', ts: new Date().toISOString() });
    const result = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, modelId: MODEL, provider: summarizer });
    expect(result.fired).toBe(true);
    const after = loadSession(session.id)!.messages;
    expect(after.some(row => typeof row.content === 'string' && row.content.includes('[seat-mail #9001 from SYS]'))).toBe(true);
    expect(after.some(row => row.content === '사람이 직접 친 지시문')).toBe(true);
  });
});

describe('ELN-COMPACT-REAL ③ — no-op force 뒤 +25% 자랄 때까지 재force 보류(§4-4③)', () => {
  test('no-op → 보류(재요약 없음) → +25% 성장 뒤 재force(null summarizer 우주)', async () => {
    const { provider } = recorder('elc-noop-backoff');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    let at = 1;
    while (historyTokens(session.id) < HISTORY_FIRE_TOKENS) {
      for (const row of userRows(2, at)) appendMessage(session.id, row);
      at += 2;
    }
    let summarizeCalls = 0;
    const countingNull: CompactProvider = {
      async summarize() { summarizeCalls++; return null; },
      getContextWindow: () => resolveAutoCompactWindow(MODEL),
      getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
    };
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'turn 1', { compactProvider: countingNull });
      expect(turnStart(log).at(-1)?.fired).toBe(false); // 발화했지만 no-op — 아무것도 줄지 않았다
      expect(turnStart(log).at(-1)?.reason).toBe('no-op');
      expect(summarizeCalls).toBe(1);
      const heldAt = historyTokens(session.id); // 백오프가 붙잡은 기록 수(응답 포함)

      await turn(provider, session.id, 'turn 2: continue', { compactProvider: countingNull });
      expect(turnStart(log).at(-1)?.reason).toBe('no-op-backoff'); // §4-4③ — +25% 미성장 → force 보류
      expect(summarizeCalls).toBe(1); // 재요약 없음

      // 기록을 +25% 넘게 성장시킨다(§4-4③ 배율 1.25 + 여유) — 사람 user 행으로만 채운다.
      while (historyTokens(session.id) < heldAt * 1.25 + 600) { // 출처: #135458 §4-4③ — 배율 1.25·여유 600tok
        for (const row of userRows(2, at)) appendMessage(session.id, row);
        at += 2;
      }
      await turn(provider, session.id, 'turn 3: grown', { compactProvider: countingNull });
      // 보류 해제 — 다시 force 한다(여전히 no-op). turn-3 재force의 요약 호출 = 2회:
      // pipeline 1회 + drop-oldest 재시도 1회(turn-1 응답 assistant 캐리어를 흘린 뒤 재요약).
      // 그다음 재시도는 Wave-5 브레이커(연속 null 3회 = turn-1 1회 + 재force 2회)가 이미
      // trip 되어 Layer 3 를 건너뛴다 → 총 3회 = 1(turn 1) + 2(turn 3).
      expect(summarizeCalls).toBe(3); // 출처: #135458 §4-4③ — 재force 1 + drop-oldest 재시도 1
      expect(turnStart(log).at(-1)?.reason).toBe('no-op');
    } finally { log.mockRestore(); }
  });
});