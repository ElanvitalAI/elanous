// ── 결함 주입 심 — «Pod 사망» ────────────────────────────────────────────────
//
// 🚨 왜 이것이 있나 (SIM-VERIFY-KIT · 2026-10-12)
//   «PARTIAL 줄을 남긴 Pod 가 SIGTERM 으로 사라짐» 은 운영에서 카나리를 쏘고 Pod 를 지워야만 났다
//   (10-12 06:1x TC S3 카나리 run-4c6a70b1 — Pod 안에 PARTIAL 줄이 있었는데 호스트는 결손 줄만 남겼다).
//   이 심은 그 사건을 «기다리지 않고 일으킨다» — 호스트가 가진 입력(끝 로그 · 도는 동안 본 PARTIAL · 종료 정보)만 준다.
//
// ⛔ 흉내 내지 않는다: 호스트 Job 경로가 부르는 «같은» 순수 함수 podUsageReemitPlan 을 그대로 부른다
//    (METER-POD-ROLLUP-GAP-3 · self-implement-pod.ts). kubectl·Pod·네트워크는 없다.

import { podUsageReemitPlan, type PodUsageReemitInput, type PodUsageReemitPlan } from '../task-orchestrator/surfaces/self-implement-pod.js';

export type PodDeathScenario = PodUsageReemitInput;

export interface PodDeathRow {
  readonly category: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface PodDeathObservation {
  /** 어느 줄로 재방출했나(final · partial-log · partial-live · missing · unparsable). */
  readonly source: PodUsageReemitPlan['source'];
  /** 호스트가 남길 관측 줄 전부(순서 그대로). */
  readonly rows: readonly PodDeathRow[];
  /** 사용량 행(llm.usage/llm-usage) 중 PARTIAL 에서 다시 낸 것(partial:true). */
  readonly partialRows: readonly PodDeathRow[];
  /** 결손 행(site=pod-rollup:missing). */
  readonly missingRows: readonly PodDeathRow[];
}

/** Pod 안 부분 롤업 표본기가 내는 꼴 그대로의 PARTIAL 줄. */
export function simPartialLine(seq = 1): string {
  return `ELANOUS_USAGE_ROLLUP_PARTIAL ${JSON.stringify({
    measured: true, partial: true, seq, at: '2026-10-12T00:00:00.000Z', runId: 'run-sim-pod-death', podName: 'si-sim-pod-death',
    rows: [{ site: 'self-implement', provider: 'openrouter', model: 'z-ai/glm-5.3', calls: 3, inputTokens: 1200, outputTokens: 300 }],
  })}`;
}

/** «PARTIAL 한 줄을 남기고 SIGTERM 으로 지워진 Pod» 기본 시나리오 — 끝 로그는 비었고, 호스트는 도는 동안 PARTIAL 을 봤다. */
export function podDeathAfterPartialScenario(overrides: Partial<PodDeathScenario> = {}): PodDeathScenario {
  return {
    job: 'si-sim-pod-death',
    runId: 'run-sim-pod-death',
    logs: '',
    livePartialLine: simPartialLine(),
    exit: { state: 'failed', containerReason: 'Error', containerExitCode: 143 },
    ...overrides,
  };
}

/** 시나리오를 호스트 재방출 판정에 넣고 관측을 나눠 돌려준다. */
export function simPodDeath(scenario: PodDeathScenario = podDeathAfterPartialScenario()): PodDeathObservation {
  const plan = podUsageReemitPlan(scenario);
  const usage = plan.rows.filter((r) => r.category === 'llm.usage' && r.event === 'llm-usage');
  return {
    source: plan.source,
    rows: plan.rows,
    // 결손 행은 partial 꼬리표가 없지만, 꼬리표가 붙어도 «재방출»로 세지 않도록 site 로 한 번 더 뺀다.
    partialRows: usage.filter((r) => r.data.partial === true && r.data.site !== 'pod-rollup:missing'),
    missingRows: usage.filter((r) => r.data.site === 'pod-rollup:missing'),
  };
}

/** CLI 한 화면 — 사람이 읽는 요약. */
export function renderPodDeath(obs: PodDeathObservation): string[] {
  const missing = obs.missingRows[0]?.data;
  return [
    `pod-death · source=${obs.source} · 관측 줄 ${obs.rows.length}`,
    `  PARTIAL 재방출 행: ${obs.partialRows.length}`,
    `  결손 행: ${obs.missingRows.length}${missing ? ` · reason=${String(missing.reason)} · podExitClass=${String(missing.podExitClass ?? '-')}` : ''}`,
    ...obs.rows.map((r) => `  ${r.category} ${r.event} ${JSON.stringify(r.data)}`),
  ];
}
