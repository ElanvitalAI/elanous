// MISSION-NAME-ONE (WORKER-UNIFY §6-6) — «mission» 이름·생명주기 하나.
//
// 정본 이름 = `agent-mission`. `codex` 는 옛 별칭(legacy-alias.ts), `mission` 은 `eln mission`(프로세스 러너·
// mission-out.ts) 문이다 — 둘 다 같은 정본 이름으로 풀리고, 모르는 이름은 사유와 함께 거부한다.
// 생명주기 정본 = 작업자 계약 상태 여섯(src/worker/contract.ts · WORKER-CONTRACT §2). 두 쪽의 옛 어휘는
// 얇은 어댑터로만 계약 상태에 닿는다 — 저장된 옛 값(`completed` 등)은 바꾸지 않는다.
import { WORKER_TERMINAL_STATES, type WorkerState } from '../worker/contract.js';
import type { MissionOutStatus } from './mission-out.js';

export const MISSION_CANONICAL_NAME = 'agent-mission' as const;
export type MissionSurface = 'pty' | 'process';

const MISSION_NAME_TABLE: Readonly<Record<string, { surface: MissionSurface; deprecated: boolean }>> = {
  'agent-mission': { surface: 'pty', deprecated: false },
  codex: { surface: 'pty', deprecated: true },
  mission: { surface: 'process', deprecated: false },
};

export type MissionNameResolution =
  | { ok: true; canonical: typeof MISSION_CANONICAL_NAME; surface: MissionSurface; deprecated: boolean }
  | { ok: false; reason: string };

/** 입력 이름을 정본 `agent-mission` 으로 푼다. 빈 값·모르는 이름은 조용히 넘기지 않고 사유와 함께 거부. */
export function resolveMissionName(name: string): MissionNameResolution {
  const key = name.trim().toLowerCase();
  if (!key) return { ok: false, reason: '미션 이름이 비었습니다' };
  const hit = Object.prototype.hasOwnProperty.call(MISSION_NAME_TABLE, key) ? MISSION_NAME_TABLE[key] : undefined;
  if (!hit) return { ok: false, reason: `알 수 없는 미션 이름: ${name} (정본 ${MISSION_CANONICAL_NAME})` };
  return { ok: true, canonical: MISSION_CANONICAL_NAME, ...hit };
}

export interface MissionWorkerView { state: WorkerState; reason?: string }

/** `eln mission` 저장 상태 → 계약 상태. 종결 사유(취소·시간 초과)는 failed 의 사유로 보존한다. */
export const MISSION_OUT_WORKER_STATE: Readonly<Record<MissionOutStatus, MissionWorkerView>> = {
  running: { state: 'working' },
  completed: { state: 'done' },
  cancelled: { state: 'failed', reason: 'cancelled' },
  failed: { state: 'failed', reason: 'failed' },
  timeout: { state: 'failed', reason: 'timeout' },
};

export function missionOutWorkerView(status: MissionOutStatus): MissionWorkerView {
  return MISSION_OUT_WORKER_STATE[status];
}

/** 공개 JSON 의 status 어휘: 저장값 `completed` 는 밖에서 `done`(계약 어휘)으로 말한다. */
export function missionOutPublicStatus(status: MissionOutStatus): Exclude<MissionOutStatus, 'completed'> | 'done' {
  return status === 'completed' ? 'done' : status;
}

/** agent-mission(PTY) 결과 → 계약 상태. ok=true 만 done, 나머지는 사유와 함께 failed. */
export function agentMissionResultWorkerView(result: { ok: boolean; reason?: string }): MissionWorkerView {
  if (result.ok) return { state: 'done' };
  return { state: 'failed', reason: result.reason ?? 'not-ok' };
}

export const isMissionWorkerTerminal = (state: WorkerState): boolean => WORKER_TERMINAL_STATES.includes(state);
