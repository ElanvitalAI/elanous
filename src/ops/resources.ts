/**
 * RES-FLOOR-API — «자원 지도» 접기(순수 층). I/O 0 · kubectl/ssh 0 · 새 수집 0.
 * 이미 도는 overview 캐시의 메모 스냅숏과 응답 때 얹는 Pod 점유를 PWA 자원 지도 꼴로 접는다.
 * 설계: 칸 RES-FLOOR-API(0.2.28) — 호스트별 load·mem · Pod 슬롯 · 칸마다 observedAt · 빠진 칸은 missing 사유.
 */
import type { Cell, MachineLoad, OverviewSnapshot, PodMemberRow } from './overview.js';

export interface ResourceCell<T> {
  value: T | null;
  observedAt: string | null;
  /** value 가 없는 칸의 사유 — 측정됐으면 null */
  missing: string | null;
}

export interface HostResourcesRow {
  name: string;
  load1: ResourceCell<number>;
  load5: ResourceCell<number>;
  load15: ResourceCell<number>;
  cpuCount: ResourceCell<number>;
  memFreeGb: ResourceCell<number>;
  memTotalGb: ResourceCell<number>;
}

export interface PodSlotRow {
  context: string;
  capacity: number;
  occupied: ResourceCell<number>;
}

export interface ResourcesMap {
  /** 접은 스냅숏의 시각(overview generatedAt) */
  generatedAt: string;
  /** 이 읽기 시각 */
  readAt: string;
  hosts: HostResourcesRow[];
  pods: PodSlotRow[];
  /** 구조적으로 통째로 빈 칸의 사유(호스트 원장 비어 있음 · 풀 설정 없음) */
  missing: string[];
}

const NO_REASON = '사유 없음';

function fold<T>(source: Cell<T>): ResourceCell<T> {
  const measured = source.status !== 'unmeasured' && source.value !== null;
  return { value: measured ? source.value : null, observedAt: source.observedAt, missing: measured ? null : source.reason ?? NO_REASON };
}

/** 호스트의 모든 숫자 칸은 같은 하트비트 cell 에서 나오니 observedAt·missing 도 함께 접힌다. */
function hostRow(host: OverviewSnapshot['machines']['hosts'][number]): HostResourcesRow {
  const load = fold(host.load);
  const num = (pick: (l: MachineLoad) => number): ResourceCell<number> => load.value !== null
    ? { value: pick(load.value), observedAt: load.observedAt, missing: null }
    : { value: null, observedAt: load.observedAt, missing: load.missing };
  return {
    name: host.name,
    load1: num((l) => l.load1),
    load5: num((l) => l.load5),
    load15: num((l) => l.load15),
    cpuCount: num((l) => l.cpuCount),
    memFreeGb: num((l) => l.freeGb),
    memTotalGb: num((l) => l.totalGb),
  };
}

export function resourcesFromOverview(snapshot: OverviewSnapshot, pods: readonly PodMemberRow[], now: number): ResourcesMap {
  const byContext = new Map(pods.map((pod) => [pod.context, pod]));
  const missing: string[] = [];
  if (snapshot.machines.hosts.length === 0) missing.push('hosts: 하트비트 원장 비어 있음');
  if (snapshot.machines.pods.length === 0) missing.push('pods: 풀 설정 없음');
  return {
    generatedAt: snapshot.generatedAt,
    readAt: new Date(now).toISOString(),
    hosts: snapshot.machines.hosts.map(hostRow),
    pods: snapshot.machines.pods.map((pod): PodSlotRow => ({
      context: pod.context,
      capacity: pod.capacity,
      occupied: fold((byContext.get(pod.context) ?? pod).occupied),
    })),
    missing,
  };
}
