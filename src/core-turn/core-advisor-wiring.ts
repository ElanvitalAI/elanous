// HARNESS-ADVISOR-CHECKPOINTS 배선 — 고 루프가 모델 오케스트레이션 코어의 ADVISOR 를 얻는 한 곳.
// 하니스 런(ELANOUS_RUN_ID 가 있는 자식)에서만 켠다. 사람 TUI·일반 채팅은 종전 그대로(상담·기록 0).
// 모드는 `harness.difficultyRouter` 하나를 따른다: shadow(기본) = 상담했을 순간만 원장에 · on = 실제 강 모델 호출.

import { streamLLM } from '../llm.js';
import type { LLMUsage } from '../prompt-cache/types.js';
import { getUserConfig, resolveActiveProvider } from '../user-config.js';
import { debug } from '../debug/log.js';
import { modelOrchestrationCore } from '../model-tier/model-orchestration.js';
import { classifyWorkRisk, workRiskInputFromFields } from '../model-tier/work-risk-router.js';
import { createCoreAdvisor, type CoreAdvisor } from '../model-tier/advisor-checkpoints.js';
import type { AdvisorClient, AdvisorMoment } from '../model-tier/orchestration-core.js';
import { recordWorkRouteDecision, resolveWorkRouteMode } from '../self-implement/work-route-ledger.js';
import { readAccountWindowSnapshot } from '../model-tier/account-window-snapshot.js';

/** 조언 한 번의 전체 시간 상한 — 느린 조언은 기다리지 않고 건너뛴다(출처: 54f1174c89 advisor-checkpoints-llm 의 같은 값). */
const ADVISOR_TOTAL_TIMEOUT_MS = 90_000;

const SYSTEM_BY_MOMENT: Readonly<Record<AdvisorMoment, string>> = {
  plan: '너는 강한 조언자다. 구현 모델이 계획을 세우기 직전이다. 설계 요점·지켜야 할 불변식·실패 경로(죽음·동시성·재기동·권한)를 '
    + '짧은 목록으로만 답하라. 코드는 쓰지 마라. 400 토큰 이내.',
  'same-error': '너는 강한 조언자다. 구현 모델이 같은 오류를 두 번 냈다. 가장 그럴듯한 근본 원인 하나와 다음에 시도할 '
    + '다른 접근 하나를 짧게 답하라. 같은 시도의 반복을 권하지 마라. 400 토큰 이내.',
  'pre-complete': '너는 강한 판정자다. 구현 모델이 목표 완료를 선언하려 한다. 증거가 목표의 모든 요구를 덮는지 판정하라. '
    + '첫 줄은 정확히 «VERDICT: accept» 또는 «VERDICT: revise», 그다음 줄들에 빠진 항목만 짧게. 400 토큰 이내.',
};

/** 실제 강 모델 클라이언트(`on` 에서만 만든다). 사용량은 streamLLM 이 `llm-usage` 한 줄로 남기고,
 *  그 줄의 등급·계기 칸은 코어 문맥(강 · advisor:<순간>)에서 온다 — 원장은 하나다. */
export function streamLlmAdvisorClient(signal?: AbortSignal): AdvisorClient {
  return {
    async advise(request) {
      let usage: LLMUsage | undefined;
      const prompt = [
        SYSTEM_BY_MOMENT[request.moment],
        `목표:\n${request.prompt.objective.slice(0, 4000)}`,
        ...(request.prompt.detail ? [`${request.moment === 'pre-complete' ? '완료 증거' : '반복된 오류'}:\n${request.prompt.detail.slice(0, 4000)}`] : []),
      ].join('\n\n');
      const advice = await streamLLM([{ role: 'user', content: prompt }], () => undefined, {
        model: request.model,
        maxTokens: request.maxOutputTokens,
        maxTokensExplicit: true,
        streamTotalTimeoutMs: ADVISOR_TOTAL_TIMEOUT_MS,
        // role 은 비운다 — `usage runs --by role` 의 리뷰 행에 섞이지 않게(Opus 리뷰 sf2). 등급 몫은 workTier 칸이 센다.
        usageSite: `core-advisor:${request.moment}`,
        ...(signal ? { signal } : {}),
        onUsage: (next: LLMUsage) => { usage = next; },
      });
      return {
        advice,
        ...(typeof usage?.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage?.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
      };
    },
  };
}

export function coreAdvisorForGoalLoop(input: { readonly userText: string; readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv }): CoreAdvisor | undefined {
  const runId = (input.env ?? process.env).ELANOUS_RUN_ID?.trim();
  if (!runId) return undefined;
  try {
    const config = getUserConfig();
    const mode = resolveWorkRouteMode(config);
    const provider = resolveActiveProvider(config);
    return createCoreAdvisor({
      core: modelOrchestrationCore(),
      runId,
      provider,
      work: classifyWorkRisk(workRiskInputFromFields(input.userText)),
      mode,
      // COST-OPTIMIZER-WINDOW-AWARE 대칭 — 상담도 발사와 같은 창 선택기를 거친다. 상담 호출은 이 프로세스의 계정(발사가 정한 계정)으로
      // 나가므로 여기서는 계정을 바꿀 수 없다 ⇒ shadow 고정(고를 계정은 원장 이유에만).
      // 런마다 한 번 읽는다(상담 순간마다 다시 읽어 같은 건너뜀 이벤트를 되풀이하지 않게 · 리뷰 sf5).
      accounts: (() => { let read = false; let cached: ReturnType<typeof readAccountWindowSnapshot>;
        return () => { if (!read) { read = true; cached = readAccountWindowSnapshot(provider, { forceShadow: true }); } return cached; }; })(),
      ...(mode === 'on' ? { client: streamLlmAdvisorClient(input.signal) } : {}),
      record: (record) => { void recordWorkRouteDecision(record); },
      onError: (moment, error) => {
        debug.log('harness.route-decision', 'advisor-failed', { runId, moment, error: error instanceof Error ? error.name : 'unknown' }, { level: 'warn' });
      },
    });
  } catch { return undefined; }
}
