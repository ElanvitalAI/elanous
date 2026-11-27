// CONTEXT-BUDGET-ROTATION (0.3.34) — RED 시험 ②③④.
// ② 임계 도달(60K 초과 + no-op streak 2) → HANDOFF 자동 작성 · 새 세션 생성 · 첫 system 행 시드.
// ③ 진행 턴 중(turnInFlight=true) 교대 금지 — 훅은 no-op 로 전환만 하고 세션 교체 안 함.
// ④ #39491 마스킹 경계 회귀 — HANDOFF 입력·문서 양쪽 redactSecretText 1회, 원장 원문 무변경.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage } from '../llm.js';
import { estimateTokens } from '../tokens.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import * as actualUserIntent from '../user-intent/index.js';
import { appendMessage, createSession, loadSession, onSessionCreated } from './index.js';
import {
  attemptSessionRotation,
  buildHandoff,
  recordNoOpRotation,
  resetRotationStateForTest,
  type RotationSummarizeFn,
} from './session-rotation.js';
import { CONTEXT_HANDOFF_MAX_TOKENS } from './context-budget.js';

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-rotation-'));
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

afterEach(() => { resetAutoCompactStateForTest(); resetRotationStateForTest(); });

/** 60K 토큰 초과 기록: assistant 행 40건 × ~2K 토큰 + 마무리 assistant 행. */
function seedBigSession(): string {
  const session = createSession({ model: 'rotation-test-model' });
  appendMessage(session.id, { role: 'user', content: 'OP 지시: 큐를 돌려라', ts: new Date(1).toISOString() });
  for (let i = 0; i < 40; i++) {
    appendMessage(session.id, { role: 'assistant', content: 'R'.repeat(8_000), ts: new Date(2 + i).toISOString() });
  }
  appendMessage(session.id, { role: 'assistant', content: 'done', ts: new Date(100).toISOString() });
  return session.id;
}

const HANDOFF_DOC = '## Goal\n- 큐 회전\n## Instructions\n- push 금지\n## Discoveries\n- d\n## Accomplished\n- a\n## In progress / next steps\n- n\n## Commitments\n- none\n## Relevant files / directories\n- f';

function capturingSummarizer(captured: { history?: LLMMessage[]; systemPrompt?: string; model?: string }[]): RotationSummarizeFn {
  return async (history, opts) => {
    captured.push({ history, systemPrompt: opts.systemPrompt, model: opts.model });
    return HANDOFF_DOC;
  };
}

describe('CONTEXT-BUDGET-ROTATION ② 임계 도달 → HANDOFF 작성 · 새 세션 시드', () => {
  test('no-op streak 2 + 60K 초과 → 새 세션 생성 · 첫 system 행 시드 · ≤2K', async () => {
    const sessionId = seedBigSession();
    const before = JSON.stringify(loadSession(sessionId)!.messages);
    recordNoOpRotation(sessionId);
    recordNoOpRotation(sessionId);
    const captured: { history?: LLMMessage[]; systemPrompt?: string; model?: string }[] = [];

    const result = await attemptSessionRotation({
      sessionId,
      turnInFlight: false,
      modelId: 'rotation-test-model',
      summarizeFn: capturingSummarizer(captured),
    });

    expect(result.rotated).toBe(true);
    expect(result.newSessionId).toBeDefined();
    expect(result.newSessionId).not.toBe(sessionId);

    // COMPACT_SYSTEM_PROMPT 섹션이 요약기에 전달됐다(재사용 계약)
    expect(captured[0]!.systemPrompt).toContain('## Goal');
    expect(captured[0]!.systemPrompt).toContain('## Commitments');
    // «명시 > 셀프» — modelId 가 요약 모델로 전달
    expect(captured[0]!.model).toBe('rotation-test-model');

    // 새 세션의 첫 행 = system 행 시드 = HANDOFF 문서
    const seeded = loadSession(result.newSessionId!)!.messages;
    expect(seeded.length).toBeGreaterThan(0); // 출처: #39831 — 교대 시드 system 행 존재(0이면 시드 실패)
    expect(seeded[0]!.role).toBe('system');
    expect(seeded[0]!.content).toBe(HANDOFF_DOC);
    expect(estimateTokens(seeded[0]!.content)).toBeLessThanOrEqual(CONTEXT_HANDOFF_MAX_TOKENS);

    // 구세션 원장은 무변경
    expect(JSON.stringify(loadSession(sessionId)!.messages)).toBe(before);
    // 교대 후 streak 초기화 + 한 세션은 한 번만 교대(재시도 기각)
    const again = await attemptSessionRotation({ sessionId, turnInFlight: false, modelId: 'rotation-test-model', summarizeFn: capturingSummarizer([]) });
    expect(again.rotated).toBe(false);
    expect(again.reason).toBe('already-rotated');
  });

  test('HANDOFF 상한 — 요약이 2K 토큰을 넘으면 잘린다', async () => {
    const sessionId = seedBigSession();
    const oversized: RotationSummarizeFn = async () => 'X'.repeat(20_000);
    const doc = await buildHandoff(sessionId, { modelId: 'rotation-test-model', summarizeFn: oversized });
    expect(estimateTokens(doc)).toBeLessThanOrEqual(CONTEXT_HANDOFF_MAX_TOKENS);
    expect(doc.length).toBeGreaterThan(0); // 출처: #39831 — 잘린 HANDOFF 도 빈 문서 아님(상한 잘림 후 잔존 단언)
  });

  test('summarizerModel 오버라이드가 셀프 모델을 이긴다(명시 > 셀프)', async () => {
    const sessionId = seedBigSession();
    recordNoOpRotation(sessionId);
    recordNoOpRotation(sessionId);
    const captured: { model?: string }[] = [];
    const result = await attemptSessionRotation({
      sessionId,
      turnInFlight: false,
      modelId: 'rotation-test-model',
      summarizerModel: 'summarizer-override',
      summarizeFn: (async (_history, opts) => { captured.push({ model: opts.model }); return HANDOFF_DOC; }),
    });
    expect(result.rotated).toBe(true);
    expect(captured[0]!.model).toBe('summarizer-override');
  });
});

describe('CONTEXT-BUDGET-ROTATION ③ 진행 턴 중 교대 금지', () => {
  test('turnInFlight=true → 세션 교체 없음, 요약기도 호출 안 함', async () => {
    const sessionId = seedBigSession();
    recordNoOpRotation(sessionId);
    recordNoOpRotation(sessionId);
    let created: string | null = null;
    const off = onSessionCreated(meta => { created = meta.id; });
    let summarizeCalls = 0;
    const result = await attemptSessionRotation({
      sessionId,
      turnInFlight: true,
      modelId: 'rotation-test-model',
      summarizeFn: (async () => { summarizeCalls++; return HANDOFF_DOC; }),
    });
    off();
    expect(result.rotated).toBe(false);
    expect(result.reason).toBe('turn-in-flight');
    expect(summarizeCalls).toBe(0);
    expect(created).toBeNull();
  });
});

describe('CONTEXT-BUDGET-ROTATION ④ #39491 마스킹 경계', () => {
  test('HANDOFF 입력·문서 redactSecretText 1회, 원장 원문 무변경', async () => {
    const session = createSession({ model: 'rotation-test-model' });
    const SECRET_ROW = 'PRESERVE-ME 원문 지시: API 키는 OPENAI_API_KEY=sk-abcdefghijklmnopqrst 를 써라';
    appendMessage(session.id, { role: 'user', content: SECRET_ROW, ts: new Date(1).toISOString() });
    appendMessage(session.id, { role: 'assistant', content: '확인했다', ts: new Date(2).toISOString() });
    const before = JSON.stringify(loadSession(session.id)!.messages);
    const captured: LLMMessage[] = [];
    // 출력측 신선한 비밀: ghp_ 20자 — 요약이 비밀을 되살려도 문서에서 가려진다.
    recordNoOpRotation(session.id); // 교대 임계(streak 2) — 없으면 below-threshold 로 rotated=false
    recordNoOpRotation(session.id);
    const result = await attemptSessionRotation({
      sessionId: session.id,
      turnInFlight: false,
      modelId: 'rotation-test-model',
      summarizeFn: (async (history) => {
        captured.push(...history);
        return '요약: 지시 원문 ' + SECRET_ROW.slice(0, 30) + ' token=ghp_abcdefghijklmnopqr12';
      }),
    });
    expect(result.rotated).toBe(true);

    // 입력측 1회: 요약기에 전달된 사람 행은 지시 원문 유지 + 자격값만 마스크
    const humanInput = captured.find(m => m.role === 'user')!;
    expect(humanInput.content).toContain('PRESERVE-ME 원문 지시');
    expect(humanInput.content).toContain('OPENAI_API_KEY=sk-***');
    expect(humanInput.content).not.toContain('sk-abcdefghijklmnopqrst');

    // 문서측 1회: 출력에 실린 신선한 자격값이 마스크된다
    // 출처: redact-secret-text.test.ts:44 — `token=ghp_…` 는 규칙 사다리(github-token→generic-api-key)
    // 이중 마스크로 접두 없이 `token=***` 가 정본 계약. `ghp_***` 는 맨 토큰 노출 형태.
    const doc = loadSession(result.newSessionId!)!.messages[0]!.content;
    expect(doc).toContain('PRESERVE-ME 원문 지시');
    expect(doc).toContain('token=***');
    expect(doc).not.toContain('ghp_abcdefghijklmnopqr12');
    expect(doc).not.toContain('ghp_');

    // 원장 원문 무변경
    expect(JSON.stringify(loadSession(session.id)!.messages)).toBe(before);
  });
});
