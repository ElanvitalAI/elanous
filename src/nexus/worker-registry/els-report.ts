// NEXUS · els 보고 경로 골격 — DRAFT, 정식 구현 아님 (OP #95243)
//
// els 가 pane 생성·상태 변화를 nexus 에 보고하는 길의 골격.
// els 쪽(src/els/core.ts·control.ts 등 핫파일)은 이 PR 에서 건드리지 않는다 —
// 정식 구현 PR 에서 els control 바인딩이 이 진입점을 부른다.
//
// 인가·감사·비밀 가림: 이 모듈이 원장 쓰기의 유일 진입점 구실을 하며,
// 비밀(creds)은 원장에 평문으로 넣지 않는다(OP 10:1x — 한곳).

import type { WorkerRegistryStore } from './store.js';

export interface ElsPaneSpawnReport {
  /** els pane id — 정체성 사슬의 뿌리. */
  readonly paneId: string;
  readonly eventId: string | null;
  readonly kind: 'pane-agent' | 'cli';
  readonly goal: string | null;
  readonly host: string | null;
  readonly owner: string | null;
}

export interface ElsStateChangeReport {
  readonly paneId: string;
  readonly eventId: string | null;
  /** OP 09:4x 어휘 밖이면 거절 — 좌석이 어휘를 맞춘다. */
  readonly state: string;
}

export function reportWorkerSpawned(store: WorkerRegistryStore, report: ElsPaneSpawnReport): string {
  const id = `worker-${report.paneId}`;
  store.registerWorker({
    id,
    kind: report.kind,
    goal: report.goal ?? undefined,
    host: report.host ?? undefined,
    owner: report.owner ?? undefined,
    paneId: report.paneId,
    eventId: report.eventId ?? undefined,
  });
  return id;
}

export function reportWorkerStateChange(store: WorkerRegistryStore, report: ElsStateChangeReport): string | null {
  return store.applyLegacyPaneState(report.paneId, report.eventId, report.state);
}
