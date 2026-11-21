// COMPACT P0 — 대화 속 user 지시 구조적 보존(OP #123867 처방)
//
// 결함(조사 result f643d2b1): L3 압축이 앵커(첫 user)와 tail(preserveLastN)
// 사이의 모든 user 메시지를 <context_summary> 한 줄로 환원 — replay는 조건부·마지막
// 1개뿐이고 앵커가 user를 pin 하면 스킵되어, 요약 모델이 뺀 지시는 영구 소실.
//
// 처방(OP #123867): ① 압축은 assistant·tool 내용만 요약 — user 메시지는 원문 그대로
// 전부 보존(정규식·키워드 분류 금지·구조적 role 기준). ② user 원문 합이 예산을 넘을
// 때만 가장 오래된 user부터 요약으로 이관하되 그 사실을 요약에 명시. ③ 조건부 replay
// 경로는 이 보존으로 대체. ④ 시험 = 210턴 + 중간 user 지시 3개 → 압축 뒤 원문 3/3
// 존재 + 회상 3/3.
//
// 계약 마커 — 구현(src/compact)이 같은 문자열을 상수로 내보낸다.
export const USER_BUDGET_TRANSFER_MARKER = '[user-directive-budget]';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompactPipeline, type CompactProvider } from '../src/compact';
import type { LLMMessage } from '../src/llm';

function archDir(): string {
  return mkdtempSync(join(tmpdir(), 'compact-user-'));
}

const DIRECTIVES = [
  '지시① force push 전면 금지(force-with-lease 포함) — 조각 수리는 일반 push 만.',
  '지시② 영수증 통과 수는 명령 원문과 출력 줄을 그대로, 파일별로.',
  '지시③ 시험 결과는 실제 실행한 명령과 그 출력 그대로만 기술.',
] as const;

/** 210턴짜리 이력: 앵커(첫 user) + 70턴 + 지시① + 70턴 + 지시② + 70턴 + 지시③ + tail 여유 10턴.
 * 지시 셋은 모두 «앵커 밖·tail 안» — 현행 코드에서는 요약 슬라이스로 환원되는 구간이다. */
function buildHistory(): LLMMessage[] {
  const msgs: LLMMessage[] = [
    { role: 'user', content: 'PHASE-PROMPT: 좌석 업무 개시 — 이 첫 user 메시지가 앵커다.' },
  ];
  let turn = 0;
  const pushTurn = () => {
    turn += 1;
    msgs.push({ role: 'user', content: `턴 ${turn} 요청` });
    msgs.push({ role: 'assistant', content: `턴 ${turn} 응답` });
  };
  for (let i = 0; i < 70; i += 1) pushTurn();
  msgs.push({ role: 'user', content: DIRECTIVES[0] });
  msgs.push({ role: 'assistant', content: '지시① 수령 확인.' });
  for (let i = 0; i < 70; i += 1) pushTurn();
  msgs.push({ role: 'user', content: DIRECTIVES[1] });
  msgs.push({ role: 'assistant', content: '지시② 수령 확인.' });
  for (let i = 0; i < 70; i += 1) pushTurn();
  msgs.push({ role: 'user', content: DIRECTIVES[2] });
  msgs.push({ role: 'assistant', content: '지시③ 수령 확인.' });
  // tail 여유 — 마지막 6메시지가 지시와 무관한 평토래여야 «지시 보존이 tail 덕»이 아님을 증명.
  for (let i = 0; i < 10; i += 1) pushTurn();
  return msgs;
}

/** ③ 예산 이관 이력(21메시지): 앵커(1) + 채움 턴 + 지시 3건(모두 앵커 밖·tail 안) + tail 여유 3쌍.
 * 지시③(35자)는 슬라이스 안 마지막 user — 예산(=지시② 37자+10)이 지시③까지만 허용해서
 * ③는 원문 보존, 그보다 오래된 채움·①② 는 요약 이관 — «tail 덕»이 아님을 예산으로 증명. */
function buildBudgetHistory(): LLMMessage[] {
  const msgs: LLMMessage[] = [
    { role: 'user', content: 'PHASE-PROMPT: 좌석 업무 개시 — 이 첫 user 메시지가 앵커다.' },
  ];
  const pushPair = (text: string) => {
    msgs.push({ role: 'user', content: text });
    msgs.push({ role: 'assistant', content: '수령 확인.' });
  };
  pushPair('채움 1');
  pushPair('채움 2');
  pushPair('채움 3');
  msgs.push({ role: 'user', content: DIRECTIVES[0] });
  msgs.push({ role: 'assistant', content: '수령 확인.' });
  pushPair('채움 4');
  msgs.push({ role: 'user', content: DIRECTIVES[1] });
  msgs.push({ role: 'assistant', content: '수령 확인.' });
  msgs.push({ role: 'user', content: DIRECTIVES[2] });
  msgs.push({ role: 'assistant', content: '수령 확인.' });
  pushPair('채움 5');
  pushPair('채움 6');
  pushPair('채움 7');
  return msgs;
}

function userTextsOf(messages: readonly LLMMessage[]): string[] {
  return messages
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : ''));
}

function summaryTextOf(messages: readonly LLMMessage[]): string {
  const found = messages.find(
    m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('<context_summary>'),
  );
  return typeof found?.content === 'string' ? found.content : '';
}

describe('COMPACT P0 — user 지시 구조적 보존(OP #123867)', () => {
  test('210턴 + 중간 user 지시 3개 → 압축 뒤 원문 3/3 존재 + 회상 3/3(요약이 빼도)', async () => {
    // 요약 모델이 세 지시를 전부 «뺀» 요약을 돌려줘도, 원문은 구조적으로(role 기준) 남는다.
    const omittingProvider: CompactProvider = {
      summarize: async () => ({
        summary: '좌석 업무 210턴 진행 요약(지시 언급 없음).',
        modelUsed: 'mock-summarizer',
        sourceMessageCount: 300,
      }),
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const r = await runCompactPipeline(buildHistory(), {
      policy: { archiveDir: archDir(), preserveLastN: 6, preserveFirst: 1 },
      provider: omittingProvider,
    });
    expect(r.diagnostics.layer3SummaryApplied).toBe(1);

    const userTexts = userTextsOf(r.messages);
    // 회상 3/3 — 압축 뒤 맥락에서 세 지시 원문을 그대로 찾는다.
    for (const directive of DIRECTIVES) {
      expect(userTexts.includes(directive)).toBe(true);
    }
    expect(DIRECTIVES.filter(d => userTexts.includes(d))).toHaveLength(3);
    // 앵커도 원문 pin.
    expect(r.messages[0]?.role).toBe('user');
    expect(typeof r.messages[0]?.content === 'string' && (r.messages[0]?.content as string).includes('PHASE-PROMPT')).toBe(true);
    // 요약 system 메시지는 여전히 존재(assistant·tool 내용 요약).
    expect(summaryTextOf(r.messages).length).toBeGreaterThan(0);
  });

  test('예산 미지정(기본) → 이관 0·요약에 이관 명시 없음', async () => {
    const fakeProvider: CompactProvider = {
      summarize: async () => ({ summary: '요약.', modelUsed: 'mock', sourceMessageCount: 300 }),
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const r = await runCompactPipeline(buildHistory(), {
      policy: { archiveDir: archDir(), preserveLastN: 6, preserveFirst: 1 },
      provider: fakeProvider,
    });
    expect(summaryTextOf(r.messages).includes(USER_BUDGET_TRANSFER_MARKER)).toBe(false);
  });

  test('예산 초과 시에만 가장 오래된 user 부터 요약 이관 + 요약에 사실 명시(21메시지)', async () => {
    const fakeProvider: CompactProvider = {
      summarize: async () => ({ summary: '요약.', modelUsed: 'mock', sourceMessageCount: 21 }),
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    // 예산 = 지시② 한 건 길이(+10) → newest 누적이 지시③(35자)까지만 들어가고
    // 지시②(37자)부터 초과 → 채움+①②(오래된 순) 이관, ③만 원문 보존(=예산 덕·tail 아님).
    const budget = DIRECTIVES[1].length + 10;
    const r = await runCompactPipeline(buildBudgetHistory(), {
      policy: { archiveDir: archDir(), preserveLastN: 6, preserveFirst: 1, userPreserveBudgetChars: budget },
      provider: fakeProvider,
    });
    const userTexts = userTextsOf(r.messages);
    // 가장 새 지시는 원문 보존.
    expect(userTexts.includes(DIRECTIVES[2])).toBe(true);
    // 오래된 두 지시는 요약으로 이관(원문 부재).
    expect(userTexts.includes(DIRECTIVES[0])).toBe(false);
    expect(userTexts.includes(DIRECTIVES[1])).toBe(false);
    // 이관 사실이 요약에 명시된다.
    expect(summaryTextOf(r.messages).includes(USER_BUDGET_TRANSFER_MARKER)).toBe(true);
    // 진단 — 슬라이스 안 user 중 예산 내 최신(=지시③) 1건만 보존, 이관 발생.
    expect(r.diagnostics.userDirectivesPreserved).toBe(1);
    expect(r.diagnostics.userDirectivesBudgetTransferred).toBe(1);
    // 앵커 pin 유지 + 요약 system 존재.
    expect(r.messages[0]?.role).toBe('user');
    expect(typeof r.messages[0]?.content === 'string' && (r.messages[0]?.content as string).includes('PHASE-PROMPT')).toBe(true);
    expect(summaryTextOf(r.messages).length).toBeGreaterThan(0);
  });
});