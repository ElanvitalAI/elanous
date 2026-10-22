// 결함 주입 심 «Pod 자식 공급자 폴백» 시험 — 완료 경계(POD-CHILD-PROVIDER-FALLBACK · #29340):
// ① codex 응답 503(server_is_overloaded) 이면 생산 폴백 사다리(FALLBACK_STEPS)를 타고 zai(glm) 로 이어간다
// ② 503 아닌 오류(401) 는 폴백 없이 끝난다 — 두 경우를 가른다.
// 무대 = S1(프로세스 안 · ux-sim) — 진짜 `streamLLMWithTools` ⊕ 진짜 재시도 정책 ⊕ 진짜 `FALLBACK_STEPS`.
import { describe, expect, test } from 'bun:test';
import { FALLBACK_STEPS } from '../oauth/fallback-chain.js';
import {
  POD_CODEX_503_EVIDENCE_COMMAND,
  POD_CODEX_503_LEVEL,
  POD_CODEX_503_ZAI_ANSWER,
  podCodex503Receipt,
  podCodex503Scenario,
  renderPodCodex503,
  simPodCodex503,
} from './fault-pod-codex-503.js';

describe('fault-pod-codex-503 — L1 결함 주입 «Pod 자식 공급자 폴백»', () => {
  test('동작: codex 503(server_is_overloaded) 은 생산 폴백 사다리를 타고 zai(glm) 로 이어간다 — 결과 provider·retry 관측·이벤트', async () => {
    const observation = await simPodCodex503();
    console.log(renderPodCodex503(observation).join('\n'));
    expect(observation.level).toBe(POD_CODEX_503_LEVEL);
    expect(POD_CODEX_503_LEVEL).toBe('L1');
    expect(FALLBACK_STEPS).toContain('zai');
    expect(observation.chain).toEqual([...FALLBACK_STEPS]);
    expect(observation.result).toBe('zai-fallback');
    expect(observation.resultProvider).toBe('glm');
    expect(observation.answer).toBe(POD_CODEX_503_ZAI_ANSWER);
    expect(observation.error).toBeNull();
    expect(observation.glmCalls).toBe(1);
    expect(observation.scriptedResponses).toBeGreaterThanOrEqual(2);
    const switchRow = observation.retryRows.find((row) => row.event === 'switch-provider');
    expect(switchRow).toBeDefined();
    expect(Number(switchRow?.data.overloadStreak)).toBeGreaterThanOrEqual(3);
    expect(observation.retryRows.some((row) => row.event === 'retry' && row.data.status === 503)).toBe(true);
    const failover = observation.events.find((row) => row.event === 'overload-failover');
    expect(failover).toBeDefined();
    expect(failover?.data.blockedProvider).toBe('openai-codex');
    expect(failover?.data.fallbackProvider).toBe('glm');
    expect(failover?.data.status).toBe(503);
    // 폴백 대상은 생산 glm(zai 코딩 플랜) 공급자 그대로 — 그 공급자가 코딩 엔드포인트로 요청을 냈다.
    expect(observation.zaiRows.some((row) => row.event === 'request' && row.data.model === 'glm-5.3')).toBe(true);
    // 호스트 grok 자격이 섞이지 않았다 — codex 자식 Pod 처럼 grok 칸은 not-available 로 건너뛴다.
    expect(observation.events.some((row) => row.event === 'overload-failover' && row.data.fallbackProvider === 'grok')).toBe(false);
  }, 20_000);

  test('control: 503 아닌 오류(401) 는 폴백 없이 끝난다 — glm 호출 0 · overload-failover 이벤트 0', async () => {
    const observation = await simPodCodex503(podCodex503Scenario({ fault: 'auth-401' }));
    console.log(renderPodCodex503(observation).join('\n'));
    expect(observation.result).toBe('no-fallback');
    expect(observation.answer).toBeNull();
    expect(observation.resultProvider).toBeNull();
    expect(observation.glmCalls).toBe(0);
    expect(observation.zaiRows).toHaveLength(0);
    expect(observation.error).toMatch(/\b401\b/);
    expect(observation.events.filter((row) => row.event === 'overload-failover')).toHaveLength(0);
  }, 20_000);

  test('동작: 두 결함을 가른다 — 화면 줄에 층 L1·injectionId, 영수증은 명령 ⊕ injectionId ⊕ 결과', async () => {
    const overload = await simPodCodex503(podCodex503Scenario());
    const unauthorized = await simPodCodex503(podCodex503Scenario({ fault: 'auth-401' }));
    expect(overload.result).toBe('zai-fallback');
    expect(unauthorized.result).toBe('no-fallback');
    expect(overload.result).not.toBe(unauthorized.result);
    for (const observation of [overload, unauthorized]) {
      const lines = renderPodCodex503(observation);
      expect(lines[0]).toContain('층 L1');
      expect(lines[0]).toContain(observation.injectionId);
      const receipt = lines[lines.length - 1];
      expect(receipt).toBe(podCodex503Receipt(observation));
      expect(receipt).toBe(`영수증: ${POD_CODEX_503_EVIDENCE_COMMAND} ⊕ ${observation.injectionId} ⊕ ${observation.result}`);
    }
  }, 40_000);
});
