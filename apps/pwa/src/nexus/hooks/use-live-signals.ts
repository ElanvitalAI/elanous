// Live 탭 데이터 — 기존 끝점 셋을 5초마다 모은다(새 서버 API 없음 · v1).
// ⛔ 폴링 빈도는 모니터·쇼 모드가 «같다» — 쇼 모드는 클라이언트 그리기만 무겁다(넥서스 부하 불변).

'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient } from './use-nexus-context';
import type { HarnessRunsResponse, LogInstancesResponse, LogsResponse } from '../client';

export const LIVE_POLL_MS = 5_000;
/** 화면이 보는 신호의 전부 — 성격별 셋으로 따로 묻는다. 한 조회에 섞으면 잦은 카테고리(`llm.router`)가
 *  상한을 먹어 런 신호가 잘린다(09-28 실측: 런 0 · 요청 4). */
// ⛔ 넓은 접두(`harness`·`self-implement`)는 쓰지 않는다 — 이 탭이 부르는 `/v1/harness/runs` 자신이
//    `self-implement.run-ledger`·`harness.goals-dir` 줄을 남겨 조회 창(서버 상한 1000)을 채웠다(09-28 실측:
//    1000줄 중 runId 있는 줄 0 · 관측자 효과). 판단 신호가 나오는 하위 카테고리만 묻는다.
export const LIVE_RUN_CATEGORIES = 'goal-author,harness.frontdoor,harness.substrate,harness.boundary,harness.role-llm,dev-pipeline,self-dev,self-gate,review-loop';
export const LIVE_USAGE_CATEGORIES = 'llm.usage';
// `harness.decision` = 하니스가 스스로 낸 판단(🅢 #21452 `emitDecision` · MAX 스위치가 켜져 있을 때만 쌓인다).
export const LIVE_DECISION_CATEGORIES = 'harness.decision,oauth.codex-account,harness.boundary';
/** 조사 장면 — 판단 조회와 «따로» 묻는다. 한 조회에 섞으면 연합의 판단 줄이 상한(300)을 먹어 조사 줄이 밀려났다(09-28 실측). */
export const LIVE_RESEARCH_CATEGORIES = 'research';

/** 네 조회가 연 저장소의 합집합 ⊕ 못 읽은 저장소 이름(중복 제거). */
export function storeCoverage(responses: ReadonlyArray<LogsResponse | undefined>): { stores: string[]; failedStores: string[]; registeredStores: number | null } {
  const stores = new Set<string>(); const failed = new Set<string>(); let registered: number | null = null;
  for (const r of responses) {
    for (const s of r?.stores ?? []) stores.add(s);
    for (const f of r?.failedStores ?? []) failed.add(f.name);
    if (typeof r?.registeredStores === 'number') registered = Math.max(registered ?? 0, r.registeredStores);
  }
  return { stores: [...stores], failedStores: [...failed], registeredStores: registered };
}

export function useLiveSignals(opts: { store?: string; windowMinutes: number }) {
  const client = useNexusClient();
  const logQuery = (category: string, limit: number) => ({
    queryKey: ['live', 'logs', category, opts.store ?? '', opts.windowMinutes],
    queryFn: () => client.getLogs({ category, since: `${opts.windowMinutes}m`, limit, store: opts.store }),
    refetchInterval: LIVE_POLL_MS,
  });
  const runLogs = useQuery<LogsResponse>(logQuery(LIVE_RUN_CATEGORIES, 1500));
  const usageLogs = useQuery<LogsResponse>(logQuery(LIVE_USAGE_CATEGORIES, 2000));
  const decisionLogs = useQuery<LogsResponse>(logQuery(LIVE_DECISION_CATEGORIES, 300));
  const researchLogs = useQuery<LogsResponse>(logQuery(LIVE_RESEARCH_CATEGORIES, 300));
  const merged = useMemo(
    () => [...(runLogs.data?.logs ?? []), ...(usageLogs.data?.logs ?? []), ...(decisionLogs.data?.logs ?? []), ...(researchLogs.data?.logs ?? [])],
    [runLogs.data, usageLogs.data, decisionLogs.data, researchLogs.data],
  );
  const mergedData = useMemo(() => ({ ok: true, logs: merged, count: merged.length }) as LogsResponse, [merged]);
  const logs = {
    data: mergedData,
    error: runLogs.error ?? usageLogs.error ?? decisionLogs.error ?? null,
    dataUpdatedAt: Math.max(runLogs.dataUpdatedAt, usageLogs.dataUpdatedAt, decisionLogs.dataUpdatedAt, researchLogs.dataUpdatedAt),
    truncated: [runLogs, usageLogs, decisionLogs].some((q) => q.data && q.data.count >= (q === usageLogs ? 2000 : q === runLogs ? 1500 : 300)),
    // 연합(`@active`)은 등록 저장소 전부가 아니라 «최근에 쓰인» 일부만 연다 — 몇 개를 열고 몇 개를 못 읽었는지 화면에 보인다(🅣 09-29: 우주 밖 런이 «판단 0»으로 보였다).
    ...storeCoverage([runLogs.data, usageLogs.data, decisionLogs.data, researchLogs.data]),
  };
  const runs = useQuery<HarnessRunsResponse>({
    queryKey: ['live', 'runs'],
    queryFn: () => client.getHarnessRuns(),
    // 런 원장 조회는 그 자체가 로그를 남긴다 — 느리게(60초).
    refetchInterval: 60_000,
  });
  const instances = useQuery<LogInstancesResponse>({
    queryKey: ['live', 'instances'],
    queryFn: () => client.getLogInstances(),
    staleTime: 60_000,
  });
  return { logs, runs, instances };
}
