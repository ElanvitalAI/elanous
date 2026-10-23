// 결함 주입 심 «TUI 턴 400 자동 회복» 시험 — 완료 경계(TUI-400-AUTOHEAL-FALLBACK · 대표 10-22):
// ① 400 → 새 백엔드 세션 ⊕ 직전 요약으로 재시도해 그 턴을 끝낸다
// ② 또 400 → llm.fallbackChain 다음 공급자(zai/glm)로 그 턴을 끝낸다
// ③ 둘 다 실패 → 2회 상한에서 멈추고 사람에게 이유 한 줄(무한 반복 0)
// 무대 = S1(프로세스 안) — 생산 classic TUI plain 턴 → in-process ACP → 다리 → runCoreTurn → streamLLMWithTools → 생산 codex/glm 공급자.
import { describe, expect, test } from 'bun:test';
import {
  TUI_400_AUTOHEAL_LEVEL, TUI_400_CODEX_ANSWER, TUI_400_SUMMARY, TUI_400_ZAI_ANSWER,
  renderTui400, simTui400Autoheal, tui400Receipt,
} from './fault-tui-400-autoheal.js';

describe('fault-tui-400-autoheal — L1 결함 주입 «TUI 턴 400 자동 회복»', () => {
  test('RED 재현: 자동 회복 배선이 없으면(수리 전) 400 한 번에 멈추고 사람에게 «/session new» 를 시킨다', async () => {
    const o = await simTui400Autoheal('heal-new-session', { autoheal: false });
    console.log(renderTui400(o).join('\n'));
    expect(o.status).toBe('failed');
    expect(o.result).toBe('stopped');
    expect(o.codexTurnCalls).toBe(2);
    expect(o.sessionRenewed).toBe(false);
    expect(o.screen.at(-1)).toContain('/session new');
    expect(o.autoheal).toEqual([]);
  });

  test('① codex 400 → 새 세션 ⊕ 요약 → 재시도 성공(사람 손 0)', async () => {
    const o = await simTui400Autoheal('heal-new-session');
    console.log(renderTui400(o).join('\n'));
    expect(o.level).toBe(TUI_400_AUTOHEAL_LEVEL);
    expect(o.status).toBe('completed');
    expect(o.result).toBe('recovered-new-session');
    expect(o.answer).toContain(TUI_400_CODEX_ANSWER);
    // 턴 한 번 실패 = codex 400 두 번(생산 재시도 정책) → 새 세션 재시도의 첫 호출이 정상.
    expect(o.codexTurnCalls).toBe(3);
    expect(o.sameProviderRetries).toBe(1);
    expect(o.codexSummaryCalls).toBe(1);
    expect(o.zaiCalls).toBe(0);
    expect(o.sessionRenewed).toBe(true);
    expect(o.historyRoles).toEqual(['system', 'assistant:summary', 'user']);
    expect(o.screen).toEqual(['자동 회복: 새 세션 ⊕ 요약으로 다시 시도 (1/2)']);
    expect(o.autoheal.find((r) => r.event === 'attempt')?.data)
      .toMatchObject({ step: 'new-session', sessionRenewed: true, summaryChars: TUI_400_SUMMARY.length });
    expect(tui400Receipt(o)).toContain(o.injectionId);
  });

  test('② 또 400 → fallbackChain 다음 공급자(glm)로 그 턴을 끝낸다', async () => {
    const o = await simTui400Autoheal('heal-provider');
    console.log(renderTui400(o).join('\n'));
    expect(o.status).toBe('completed');
    expect(o.result).toBe('recovered-provider');
    expect(o.answer).toContain(TUI_400_ZAI_ANSWER);
    expect(o.codexTurnCalls).toBe(4);
    expect(o.zaiCalls).toBe(1);
    expect(o.screen).toEqual([
      '자동 회복: 새 세션 ⊕ 요약으로 다시 시도 (1/2)',
      '자동 회복: 공급자 glm 로 다시 시도 (2/2)',
    ]);
    expect(o.autoheal.find((r) => r.event === 'provider-fallback-applied')?.data)
      .toMatchObject({ from: 'openai-codex', to: 'glm' });
  });

  test('③ 둘 다 실패 → 2회 상한 · 이유 한 줄 · 더 안 보낸다', async () => {
    const o = await simTui400Autoheal('exhausted');
    console.log(renderTui400(o).join('\n'));
    expect(o.status).toBe('failed');
    expect(o.result).toBe('stopped');
    // 상한(2) 뒤로는 더 안 보낸다 — codex 4(두 시도 × 재시도 정책 2) · zai 2(한 시도 × 2) 에서 끝.
    expect(o.codexTurnCalls).toBe(4);
    expect(o.zaiCalls).toBe(2);
    expect(o.screen.at(-1)).toBe('⚠ 자동 회복 2회 실패(새 세션 → 공급자 glm) → 잠시 뒤 다시 · eln usage · 원문 /detail open');
    expect(o.autoheal.at(-1)).toMatchObject({ event: 'exhausted', data: { attempts: 2, reason: 'max-attempts' } });
  });
});
