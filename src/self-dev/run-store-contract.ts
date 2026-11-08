import type { EmbodiedTransportKind } from '../agent/embodiment.js';
import type { RunIdSource } from '../harness/harness-space.js';
import type { SelfDevJobResult, SelfDevGoal, SupervisorStopReason, SupervisorNext } from './run-types.js';

export interface SelfDevRunParticipant {
  id: string;
  kind: 'agent' | 'pty' | 'acp' | 'process';
  transports: { kind: EmbodiedTransportKind; id: string }[];
  registeredAt: number;
  runIdSource: RunIdSource;
  closedAt?: number;
  closedBy?: 'self' | 'parent';
}

export interface SelfDevRunResolution {
  reason: string;
  resolvedAt: number;
}

export interface SelfDevRunState {
  runId: string;
  createdAt: number;
  updatedAt: number;
  results: SelfDevJobResult[];
  /** Redacted, bounded one-line projection for loop readers; legacy checkpoints omit it. */
  summaryLine?: string;
  /** Undefined means a legacy checkpoint has no dependency information; each key is a shard ID and its array lists predecessor shard IDs. */
  dependencies?: Record<string, string[]>;
  /**
   * ⭐⭐ 이 런을 «다시 걸려면» 필요한 goal 원형(id·feature·dependsOn·승격 플래그). 2026-08-19 신설.
   *
   * ⛔ **왜 필요한가 — 이것이 없으면 재개가 «원리상» 불가능하다.**
   *   실행 의존성은 `goal.dependsOn`(orchestrate.ts)에서 오는데, CLI 로 goal «텍스트»만 주면
   *   그 필드가 없어 조각이 «전부 동시»에 뜬다(상류 산출 없이 하류가 도는 것).
   *   되먹이려 해도 못 잇는다 — `dependencies` 키는 shard id 이고 `results` 는 taskId 라
   *   그 둘을 잇는 매핑이 어디에도 «없었다».
   *   📏 2026-08-19 북극성 런에서 실측: 재개하려면 사람이 순서를 «추론»해야 했다.
   *
   * ⚠️ undefined = 이 필드 «이전»에 저장된 체크포인트. 그때는 종전대로 인자 goals 를 쓴다(하위호환).
   */
  goals?: SelfDevGoal[];
  /** Undefined means a checkpoint predates participant tracking; [] means tracked with no participants. */
  participants?: SelfDevRunParticipant[];
  /** Human confirmation that the parked results have been handled. */
  parkedResolution?: SelfDevRunResolution;
  /** The closed supervisor termination reason, persisted independently from per-goal results. */
  supervisorStopReason?: SupervisorStopReason;
  /** Named next step at supervisor termination; legacy checkpoints omit it. */
  next?: SupervisorNext;
  /** Orchestrator process pid. */
  pid?: number;
  /** OS process birth identity, paired with pid to reject a recycled pid. */
  pidStart?: string;
  /** Seat fixed at launch; survives removal of the launch worktree. */
  seat?: 'OP' | 'TC' | 'MK' | 'UX';
}
