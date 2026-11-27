// CONTEXT-BUDGET-ROTATION (0.3.34) — RED 시험 ① : 롤링 요약 후 기록 ≤16K · 사람 행 원문 보존 · 스텁 서식.
// stub 우편 75건 + 사람 행 혼합 기록에 compactSessionHistory(force) 를 돌리고,
// 재작성된 저장소의 기록 토큰이 CONTEXT_RECORD_TOKENS(16K) 이하인지, 사람 user 행 원문이
// 그대로 살아있는지, 기계 우편 행이 [seat-mail …] 한 줄 스텁으로 응축됐는지 단언한다.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactProvider } from '../compact/provider.js';
import { resolveAutoCompactWindow } from '../compact/auto.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import { CHAT_DEFAULTS, type ChatAutoCompactConfig } from '../user-config/chat.js';
import * as actualUserIntent from '../user-intent/index.js';
import { appendMessage, createSession, loadSession } from './index.js';
import { compactSessionHistory } from './compact-session.js';
import { TURN_COMPACT_HISTORY_TOKENS } from './long-session-compact.js';
import { estimateTokens } from '../tokens.js';
import {
  CONTEXT_FIXED_PREFIX_TOKENS,
  CONTEXT_RECORD_TOKENS,
  CONTEXT_REQUEST_INPUT_CEILING,
  CONTEXT_TURN_VOLATILE_TOKENS,
  shouldRotate,
} from './context-budget.js';

const MODEL = 'ctx-budget-test'; // 카탈로그·패밀리 룰에 걸리지 않는 이름 → 32k 폴백
const CONFIG: ChatAutoCompactConfig = { ...CHAT_DEFAULTS.autoCompact };

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-budget-'));
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
  async summarize(args) { return { summary: 'rolling summary body', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => resolveAutoCompactWindow(MODEL),
  getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
};

describe('CONTEXT-BUDGET-ROTATION ① rolling record ≤16K, human rows verbatim, stub mail format', () => {
  test('상수 재수출 — CONTEXT_RECORD_TOKENS === TURN_COMPACT_HISTORY_TOKENS(재선언 금지 계약)', () => {
    expect(CONTEXT_RECORD_TOKENS).toBe(TURN_COMPACT_HISTORY_TOKENS);
    expect(CONTEXT_RECORD_TOKENS).toBe(16_000);
    expect(CONTEXT_FIXED_PREFIX_TOKENS).toBe(14_000);
    expect(CONTEXT_TURN_VOLATILE_TOKENS).toBe(2_000);
    expect(CONTEXT_REQUEST_INPUT_CEILING).toBe(32_000);
  });

  test('shouldRotate — no-op 연속 2회 or 턴수 상한, 진행 턴/미응답 사람 턴 금지', () => {
    expect(shouldRotate({ noOpStreak: 0, turnCount: 0, turnInFlight: false, lastHumanTurnAnswered: true })).toBe(false);
    expect(shouldRotate({ noOpStreak: 1, turnCount: 0, turnInFlight: false, lastHumanTurnAnswered: true })).toBe(false);
    expect(shouldRotate({ noOpStreak: 2, turnCount: 0, turnInFlight: false, lastHumanTurnAnswered: true })).toBe(true);
    expect(shouldRotate({ noOpStreak: 2, turnCount: 0, turnInFlight: true, lastHumanTurnAnswered: true })).toBe(false);
    expect(shouldRotate({ noOpStreak: 2, turnCount: 0, turnInFlight: false, lastHumanTurnAnswered: false })).toBe(false);
  });

  test('75건 스텁 우편 + 사람 행 혼합 기록의 롤링 요약', async () => {
    const session = createSession({ model: MODEL });
    const HUMAN_TEXTS = [
      'HUMAN-ORIGINAL-1 좌석 지시: 랜딩 큐를 계속 돌려라',
      'HUMAN-ORIGINAL-2 보고는 3줄로',
      'HUMAN-ORIGINAL-3 push 금지',
      'HUMAN-ORIGINAL-4 pregate 는 sha 로',
      'HUMAN-ORIGINAL-5 mshq 로컬 시험 금지',
      'HUMAN-ORIGINAL-6 원문 보존 계약 #39491',
    ];
    for (let i = 0; i < 24; i++) {
      appendMessage(session.id, { role: 'assistant', content: 'A'.repeat(6_000), ts: new Date(1_700_000_000_000 + i).toISOString() });
      if (i % 4 === 0) {
        appendMessage(session.id, { role: 'user', content: HUMAN_TEXTS[i / 4]!, ts: new Date(1_700_000_000_200 + i).toISOString() });
      }
    }
    for (let i = 0; i < 75; i++) {
      appendMessage(session.id, {
        role: 'user',
        content: `MAIL-HEADER-${i} 첫 줄\n` + 'B'.repeat(400),
        ts: new Date(1_700_100_000_000 + i).toISOString(),
        from: { kind: 'agent', seat: 'TC-MAIL', msgId: `m${i}` },
      });
    }

    const result = await compactSessionHistory(session.id, { config: CONFIG, force: true, modelId: MODEL, provider: summarizer });
    expect(result.fired).toBe(true);
    expect(result.layer3Applied).toBe(true);

    const rows = loadSession(session.id)!.messages;
    // ① 기록 ≤ CONTEXT_RECORD_TOKENS(16K)
    const recordTokens = rows.reduce((acc, r) => acc + estimateTokens(r.content), 0);
    expect(recordTokens).toBeLessThanOrEqual(CONTEXT_RECORD_TOKENS);

    // ① 사람 user 행 원문 전부 보존(isHumanUserMessage 계약)
    for (const text of HUMAN_TEXTS) {
      expect(rows.some(r => r.role === 'user' && r.content === text)).toBe(true);
    }

    // ① 기계 우편 행은 [seat-mail <msgId> from <seat>] <첫줄> 한 줄 스텁
    const machineRows = rows.filter(r => r.from !== undefined && r.from.kind !== 'human');
    expect(machineRows.length).toBeGreaterThan(0);
    for (const row of machineRows) {
      expect(row.content).toMatch(/^\[seat-mail m\d+ from TC-MAIL\] MAIL-HEADER-\d+ /);
      expect(row.content.includes('\n')).toBe(false);
    }
    // 우편 원문 바디 전체는 더 이상 저장소에 없다 — main 의 스텁은 본문 앞 400자만 한 줄로 남긴다
    // (compact-session.ts MAIL_STUB_BODY_CHARS · 출처: 머리 줄 19자 + 본문 400자 = 419자 > 400 이라 꼬리가 잘린다)
    expect(rows.some(r => r.content.includes('B'.repeat(400)))).toBe(false);
  });
});
