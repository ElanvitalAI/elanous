// 결함 주입 심 «Pod 자식 공급자 폴백» 시험 — 503/401 모두 기본 체인에서 GLM 없이 끝나며 오류 증거는 구분된다.
// 무대 = S1(프로세스 안 · ux-sim) — 진짜 `streamLLMWithTools` ⊕ 재시도 정책 ⊕ `DEFAULT_FALLBACK_CHAIN`.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_FALLBACK_CHAIN } from '../oauth/fallback-chain.js';
import {
  POD_CODEX_503_EVIDENCE_COMMAND,
  POD_CODEX_503_LEVEL,
  podCodex503Receipt,
  podCodex503Scenario,
  renderPodCodex503,
  simPodCodex503,
} from './fault-pod-codex-503.js';

describe('fault-pod-codex-503 — L1 결함 주입 «Pod 자식 공급자 폴백»', () => {
  test('동작: codex 503(server_is_overloaded) 은 기본 체인에서 GLM 없이 끝난다 — 실제 503·retry·금지 경로 0회', async () => {
    const observation = await simPodCodex503(podCodex503Scenario({ zaiCredentialAvailable: true }));
    console.log(renderPodCodex503(observation).join('\n'));
    expect(observation.level).toBe(POD_CODEX_503_LEVEL);
    expect(POD_CODEX_503_LEVEL).toBe('L1');
    expect(DEFAULT_FALLBACK_CHAIN).not.toContain('zai');
    expect(observation.chain).toEqual([...DEFAULT_FALLBACK_CHAIN]);
    expect(observation.result).toBe('no-fallback');
    expect(observation.resultProvider).toBeNull();
    expect(observation.answer).toBeNull();
    expect(observation.error).toBeTruthy();
    expect(observation.forbiddenZaiAttempts).toBe(0);
    // Source: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23`; injected Codex 503 must reach production retries.
    expect(observation.scriptedResponses).toBeGreaterThan(0);
    expect(observation.retryRows.some((row) => row.event === 'retry' && row.data.status === 503)).toBe(true);
    expect(observation.events.some((row) => row.event === 'streamLLMWithTools' && row.data.provider === 'openai-codex')).toBe(true);
    expect(observation.events.some((row) => row.event === 'overload-failover'
      && (row.data as { fallbackProvider?: unknown }).fallbackProvider === 'glm')).toBe(false);
    expect(observation.zaiRows).toHaveLength(0);
    // 호스트 grok 자격이 섞이지 않았다 — codex 자식 Pod 처럼 grok 칸은 not-available 로 건너뛴다.
    expect(observation.events.some((row) => row.event === 'overload-failover' && row.data.fallbackProvider === 'grok')).toBe(false);
  }, 20_000);

  test('control: 자격 오류(401) 는 폴백 없이 끝난다 — 금지된 zai 호출 0 · overload-failover 이벤트 0', async () => {
    const observation = await simPodCodex503(podCodex503Scenario({ fault: 'auth-401' }));
    console.log(renderPodCodex503(observation).join('\n'));
    expect(observation.result).toBe('no-fallback');
    expect(observation.answer).toBeNull();
    expect(observation.resultProvider).toBeNull();
    expect(observation.forbiddenZaiAttempts).toBe(0);
    expect(observation.zaiRows).toHaveLength(0);
    expect(observation.error).toMatch(/\b401\b/);
    expect(observation.events.filter((row) => row.event === 'overload-failover')).toHaveLength(0);
  }, 20_000);

  test('관측 반례: 실제 Codex 503 뒤 성공 Grok 응답은 no-fallback 단언을 깨고 provider·answer를 영수증에 싣는다', async () => {
    const observation = await simPodCodex503(podCodex503Scenario({ grokFallbackResponds: true }));
    expect(observation.result).toBe('fallback-response');
    expect(observation.result).not.toBe('no-fallback');
    expect(observation.resultProvider).toBe('grok');
    expect(observation.answer).toBeTruthy();
    const receipt = podCodex503Receipt(observation);
    expect(receipt).toContain('fallback-response');
    expect(receipt).toContain('provider=grok');
    expect(receipt).toContain(`answer=${observation.answer}`);
  }, 20_000);

  test('관측 반례: failover 이벤트 없는 직접 Codex 성공도 실제 provider·answer를 영수증에 싣는다', async () => {
    const observation = await simPodCodex503(podCodex503Scenario({ codexResponds: true }));
    console.log(renderPodCodex503(observation).join('\n'));
    expect(observation.result).toBe('unexpected-response');
    expect(observation.result).not.toBe('no-fallback');
    expect(observation.resultProvider).toBe('openai-codex');
    expect(observation.answer).toContain('fake-codex-answer');
    const receipt = podCodex503Receipt(observation);
    expect(receipt).toContain('provider=openai-codex');
    expect(receipt).toContain(`answer=${observation.answer}`);
  }, 20_000);

  test('동작: 두 결함을 가른다 — 화면 줄에 층 L1·injectionId, 영수증은 명령 ⊕ injectionId ⊕ 결과', async () => {
    const overload = await simPodCodex503(podCodex503Scenario());
    const unauthorized = await simPodCodex503(podCodex503Scenario({ fault: 'auth-401' }));
    expect(overload.result).toBe('no-fallback');
    expect(unauthorized.result).toBe('no-fallback');
    expect(overload.fault).not.toBe(unauthorized.fault);
    // Source: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23`; distinguish actual 503 from fake-provider bypass.
    expect(overload.scriptedResponses).toBeGreaterThan(0);
    expect(overload.retryRows.some((row) => row.event === 'retry' && row.data.status === 503)).toBe(true);
    expect(unauthorized.error).toMatch(/401/);
    for (const observation of [overload, unauthorized]) {
      const lines = renderPodCodex503(observation);
      expect(lines[0]).toContain('층 L1');
      expect(lines[0]).toContain(observation.injectionId);
      const receipt = lines[lines.length - 1];
      expect(receipt).toBe(podCodex503Receipt(observation));
      expect(receipt).toBe(`영수증: ${POD_CODEX_503_EVIDENCE_COMMAND} ⊕ ${observation.injectionId} ⊕ ${observation.result} ⊕ provider=- ⊕ answer=-`);
    }
  }, 40_000);
});
