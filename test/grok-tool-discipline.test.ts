// GROK_TOOL_DISCIPLINE — grok 계열에만 주입되는 선두 system 메시지.
//
// 대표 2026-08-14: *"커먼화 못 하는 부분은 grok 옵션으로 «구분해» 구현"* ⊕
//                *"다른 프로바이더까지 영향 주는 부분은 grok 일 때에만 돌게"*.
//
// ⛔⭐ 초판은 «소스 문자열»만 뒤졌다가 무인 리뷰(#9073)에 Goodhart 로 잡혔다:
//    주입문이 어느 분기 «안»으로 옮겨져도 정규식은 그대로 맞는다.
//    ⇒ 이 판은 ***실제 실행 경로***를 탄다 — 스크립트 프로바이더가 «전송된 messages» 를
//      그대로 붙잡으므로, 무엇이 실려 나갔는지로 판정한다.

import { describe, test, expect } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMMessage, LLMProvider } from '../src/llm';
import { CODEX_TOOL_DISCIPLINE, GROK_TOOL_DISCIPLINE } from '../src/llm';

/** 전송된 messages 를 그대로 붙잡는다 — 「무엇이 실려 나갔나」가 판정 대상이다. */
function capturingProvider() {
  const captured: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name: 'capturing',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(messages) {
      captured.push(messages.map((m) => ({ ...m })));
      yield { type: 'text', delta: 'done' } as const;
    },
    async *chat() {},
  };
  return { provider, firstTurn: () => captured[0] ?? [] };
}

async function systemTextsFor(model: string): Promise<string[]> {
  const { provider, firstTurn } = capturingProvider();
  await streamLLMWithTools(
    [{ role: 'user', content: 'go' }],
    { onText() {}, dispatchTool: async () => 'ok' },
    // ⛔ 툴이 «없으면» streamLLMWithTools 가 tool 루프에 들어가기 «전에»
    //    no-tools 폴백(streamLLM)으로 빠진다 — 규율 주입은 그 뒤에 있다.
    //    (초판 테스트가 tools: [] 를 줘서 codex 판까지 0건으로 나왔다.)
    { provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 2, model },
  );
  return firstTurn()
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

describe('GROK_TOOL_DISCIPLINE — 실행 경로로 판정한다', () => {
  test('grok 모델이면 그 규율이 «실제로 전송된다»', async () => {
    const systems = await systemTextsFor('grok-4.6');
    expect(systems.some((s) => s === GROK_TOOL_DISCIPLINE)).toBe(true);
  });

  // ⛔⭐ 핵심 — 다른 프로바이더엔 «도달하지 않는다». 소스가 아니라 전송분으로 판정한다.
  test('grok 이 아니면 그 규율이 «전송되지 않는다» (claude · other)', async () => {
    for (const model of ['claude-opus-5', 'gemma-4']) {
      const systems = await systemTextsFor(model);
      // 리뷰 should-fix(#9073 2라운드) — 표식 문자열 ⊕ «전문 일치» 둘 다 본다.
      // 표식만 보면 나중에 머리말을 고쳤을 때 이 단언이 조용히 무력해진다.
      expect(systems.some((s) => s.includes('[grok tool-use discipline]'))).toBe(false);
      expect(systems.some((s) => s === GROK_TOOL_DISCIPLINE)).toBe(false);
    }
  });

  test('codex 모델엔 codex 판만 가고 grok 판은 «안» 간다', async () => {
    const systems = await systemTextsFor('gpt-5.6-terra');
    expect(systems.some((s) => s === CODEX_TOOL_DISCIPLINE)).toBe(true);
    expect(systems.some((s) => s.includes('[grok tool-use discipline]'))).toBe(false);
  });

  test('grok 판에는 codex 판이 «같이» 실리지 않는다 — 두 분기가 겹치지 않는다', async () => {
    const systems = await systemTextsFor('grok-4.6');
    expect(systems.some((s) => s === CODEX_TOOL_DISCIPLINE)).toBe(false);
  });
});

describe('두 문면이 «양방향»으로 섞이지 않는다', () => {
  test('grok 전용 줄이 codex 판에 없고, codex 전용 줄이 grok 판에 없다', () => {
    expect(CODEX_TOOL_DISCIPLINE).not.toContain('[grok tool-use discipline]');
    expect(CODEX_TOOL_DISCIPLINE).not.toContain('grep 이 본진');
    expect(CODEX_TOOL_DISCIPLINE).not.toContain('한 턴에 함께');
    expect(GROK_TOOL_DISCIPLINE).not.toContain('[codex tool-use discipline]');
    expect(GROK_TOOL_DISCIPLINE).not.toContain('넓게 시작하라');
    expect(GROK_TOOL_DISCIPLINE).not.toContain('전체 `bun test`');
  });

  // ⭐ 리뷰 should-fix(#9073 2라운드) — 「대표 문구」가 아니라 «행 단위»로 본다.
  //   ⛔ 다만 「행이 하나도 안 겹친다」는 «틀린» 요구다 — 이 착지는 codex 판을 못 건드리므로
  //     겹치는 줄이 «일부러» 있다. ⇒ 겹치는 집합을 «못 박아» 둔다. 새 줄이 조용히 겹치거나
  //     의도한 겹침이 사라지면 이 테스트가 걸린다.
  test('겹치는 행은 «못 박힌 그 하나»뿐이다 — 나머지는 각자 전용', () => {
    const codexLines = new Set(CODEX_TOOL_DISCIPLINE.split('\n'));
    const grokLines = GROK_TOOL_DISCIPLINE.split('\n');
    const shared = grokLines.filter((line) => codexLines.has(line));
    expect(shared).toEqual([
      '- 충분한 근거가 모이면 도구 호출 없이 최종 답을 평문으로 써서 턴을 끝내라.',
    ]);
    // 그리고 grok 전용 줄이 «실제로» 남아 있다(전부 겹쳐 버리면 이 착지가 무의미하다).
    expect(grokLines.filter((line) => !codexLines.has(line)).length).toBeGreaterThan(3);
  });

  test('grok 실측이 낳은 세 줄을 담는다 — 병렬 · grep 본진 · 조사→편집 전환', () => {
    expect(GROK_TOOL_DISCIPLINE.startsWith('[grok tool-use discipline]')).toBe(true);
    expect(GROK_TOOL_DISCIPLINE).toContain('한 턴에 함께');
    expect(GROK_TOOL_DISCIPLINE).toContain('grep 이 본진');
    expect(GROK_TOOL_DISCIPLINE).toContain('편집으로 넘어가라');
  });
});
