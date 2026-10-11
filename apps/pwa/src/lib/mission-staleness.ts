const DAY_MS = 86_400_000;

/** «N일 멈춤» 판정 기준(일) — ⛔ **이 파일이 유일한 자리다**(칸 MISSIONS-STALE-MARK ·
 *  「기준은 상수 한 곳」). 카드(`components/autopilot/AutopilotMissions.tsx`)도 이 상수를
 *  import 해서 쓴다 — 판정선을 바꾸려면 여기 한 줄만 고친다. */
export const STALE_MISSION_DAYS = 14;

/** «더 이상 돌지 않는» 상태 — 두 lifecycle 이 한 목록에 산다:
 *  apm lifecycle(`done`·`failed`·`disarmed`·`rejected`) ⊕
 *  TOX Mission lifecycle(`completed`·`cancelled` = `src/task-orchestrator/mission.ts` 의
 *  `TERMINAL_MISSION_STATUSES`).
 *  ⛔ 카드의 «활성» 배지·«취소/닫기 제안» 버튼도 **이 집합**으로 판정한다 — 카드가
 *  apm 셋만 따로 들고 있었을 때 TOX `completed`/`cancelled` 미션이 «활성» + «취소»로
 *  렌더됐다(= 멈춘 미션이 «도는 중»으로 보이는 그 증상). */
export const MISSION_TERMINAL_STATUSES: readonly string[] = [
  'done', 'failed', 'disarmed', 'rejected', 'completed', 'cancelled',
];

const TERMINAL_STATUSES = new Set(MISSION_TERMINAL_STATUSES);

/** 상태가 «종료»인가(lifecycle 두 종류 모두). 미상·빈 문자열은 «종료 아님». */
export function isMissionTerminalStatus(status: string | undefined | null): boolean {
  return TERMINAL_STATUSES.has(status ?? '');
}

/** `missionStaleness()` 의 결과 — «며칠» ⊕ «마지막 갱신(YYYY-MM-DD)» ⊕ 판정. */
export type MissionStaleness = { stale: boolean; days: number; lastUpdated: string };

export function missionStaleness(
  updatedAtMs: number | undefined,
  nowMs: number,
  opts?: { thresholdDays?: number; timeZone?: string; status?: string },
): MissionStaleness | null {
  if (updatedAtMs === undefined || !Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return null;
  const updatedAt = new Date(updatedAtMs);
  if (!Number.isFinite(updatedAt.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: opts?.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(updatedAt);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const lastUpdated = `${part('year')}-${part('month')}-${part('day')}`;
  const days = Math.floor((nowMs - updatedAtMs) / DAY_MS);
  return {
    stale: !isMissionTerminalStatus(opts?.status) && days >= (opts?.thresholdDays ?? STALE_MISSION_DAYS),
    days,
    lastUpdated,
  };
}

/** 접힌 카드 앰버 칩의 «문구» — 문면의 단일 소유자(카드가 JSX 에서 조립하지 않는다). */
export function missionStaleChip(stale: MissionStaleness): string {
  return `${stale.days}일 멈춤 · 마지막 갱신 ${stale.lastUpdated}`;
}

/** 판정 기준(며칠)을 사람에게 읽히는 한 줄 — `STALE_MISSION_DAYS` 한 곳에서만 나온다.
 *  «닫기 제안»의 근거를 먼저 읽혀야 irreversible cancel 을 한 번 더 확인하게 된다. */
export function missionStaleHint(): string {
  return `갱신이 ${STALE_MISSION_DAYS}일 넘게 없으면 «멈춤»으로 본다 — 마지막 갱신 이후 진행 흔적이 없다는 뜻이다.`;
}

/** 파생 롤업 «미측정» hover 문면 — «0건»이 아니라는 사실만 말하고 원인은 단정하지 않는다. */
export const MISSION_ROLLUP_UNMEASURED_HINT =
  '서버가 파생 롤업을 싣지 않았다 — «파생 0»이 아니라 «못 잰» 값이다(구 서버 · 집계 실패).';

/** 파생 롤업 라벨 — ***«못 잤다»와 «0건이다»를 다른 문면으로 가른다***.
 *  `derived` 결손(`undefined`·`null`)은 서버가 롤업을 안 실은 것(구 서버 · 계산 실패)인데,
 *  그것을 «파생 0»으로 그리면 사람은 «파생이 없다»로 읽고 멈춘 미션을 닫는다. */
export function missionRollupLabel(derived?: { total: number } | null): string {
  if (derived === undefined || derived === null) return '파생 미측정';
  return `파생 ${derived.total}`;
}
