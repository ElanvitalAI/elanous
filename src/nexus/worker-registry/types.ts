// NEXUS · worker registry types — DRAFT, 정식 구현 아님 (OP #95243 / TC #95249)
//
// 제어면 = nexus · 데이터면 = els 직접 · 저장소 = nexus 원장(sqlite WAL) 그대로,
// 인터페이스만 추상화 (OP WORKER-MIGRATION-PHASE1-1119 10:1x).
//
// 작업자 상태 어휘(09:4x): working | idle | needs-approval | done | failed | stalled.
// HAND-ELN-ELS 좌석의 WORKER-CONTRACT-SPEC sha가 수신되면 좌석이 이 어휘를 맞춤 —
// draft 단계에서는 출처를 이 주석으로만 명시한다.

/** 명세 한 꼴 — OP 09:5x: { kind, goal|command, host?, budget, creds?, isolation, watch?, parent? } */
export const WORKER_KINDS = ['shell', 'inline-agent', 'pane-agent', 'cli'] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/** OP 09:4x — 작업자 생명주기 상태 어휘. */
export const WORKER_STATES = ['working', 'idle', 'needs-approval', 'done', 'failed', 'stalled'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** OP 10:0x — 바인딩(msg store · els control · ACP · MCP · CLI · HTTP · PTY) */
export const BINDING_KINDS = ['msg-store', 'els-control', 'acp', 'mcp', 'cli', 'http', 'pty'] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

/** TC #95745 — 작업자 위계 role 허용값. king(대표)·op·coord·peer·child. */
export const WORKER_ROLES = ['king', 'op', 'coord', 'peer', 'child'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** 능력 선언 — 이 작업자가 받는 바인딩 목록. */
export interface WorkerCapability {
  readonly bindings: readonly BindingKind[];
}

/** 정체성 = els pane id = eventId 사슬 (OP 09:4x). */
export interface WorkerIdentity {
  readonly paneId: string | null;
  readonly eventId: string | null;
}

export interface WorkerRow {
  /** 원장 id (uuid). 정체성 사슬은 paneId/eventId 필드로. */
  readonly id: string;
  /** OP 09:5x 명세 한 꼴. */
  readonly kind: WorkerKind;
  /** goal(에이전트) 또는 command(shell/cli). */
  readonly goal: string | null;
  readonly command: string | null;
  /** 호스트 = hosts 테이블의 machine 이름. */
  readonly host: string | null;
  /** 부모 작업자 id (무리/fanout 뿌리). */
  readonly parent: string | null;
  /** fanout 묶음 id — 같은 부모가 여러 자식을 뿌린 경우. */
  readonly fanout: string | null;
  /** 소유권 — 이 작업자를 소유한 좌석/seat 이름. */
  readonly owner: string | null;
  readonly budget: string | null;
  readonly isolation: string | null;
  /** r2 ⑤ — 재등록 세대. 같은 id 의 재등록(삭제 후)은 매번 새 generation. */
  readonly generation: number;
  /** TC #95745 — 위계 role. null = 미지정. */
  readonly role: WorkerRole | null;
  /** 위계 — 형제 작업자 id 목록(JSON 배열). */
  readonly siblingsJson: string | null;
  /** 위계 — 자식 작업자 id 목록(JSON 배열). */
  readonly childrenJson: string | null;
  /** 특성 — 추정 비용(ms). */
  readonly costMs: number | null;
  /** 특성 — 추정 지연(ms). */
  readonly latencyMs: number | null;
  /** 특성 — 위험 등기(free text). */
  readonly risk: string | null;
  /** 능력 선언(JSON) — 받는 바인딩 목록 포함. */
  readonly capabilitiesJson: string | null;
  /** 원하는 상태(사람/좌석이 지정) — OP 10:1x desired vs actual. */
  readonly desiredState: WorkerState | null;
  /** 실제 상태 — els 보고 경로가 갱신. */
  readonly actualState: WorkerState;
  readonly paneId: string | null;
  readonly eventId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 호스트(machine) 행 계약 — CC-4 칸(TC-H-CC-4, ELS-REMOTE-TAB-2 #38896)이 기다리는 필드.
 *  이 draft는 스키마·타입·수명 계약만 제안; 호스트 원장 투영은 CC-4 칸 소관. */
export interface HostRow {
  /** machine 이름 — 자원 원장(machine 등록 producer)과 같은 어휘. */
  readonly name: string;
  /** r2 — 인증 host principal(이 호스트를 대표하는 좌석/서비스 신원). 결속 필드:
   *  이 principal 이 달라지면 generation 이 +1 로 회전하고 이전 세대의 쓰기(heartbeat 등)는 거절. */
  readonly principal: string | null;
  /** r2 — principal 세대. 새 principal 등장 시 +1. 재생(replay) 방지 키. */
  readonly generation: number;
  /** r2 — 폐기(revocation) 시각(ISO). null = 폐기 아님. 폐기 행은 alive=false, 등록·박동 거절. */
  readonly revokedAt: string | null;
  /** els endpoint origin — tailnet/loopback URL 만 허용(src/els/hosts.ts 규칙과 동일). */
  readonly elsEndpoint: string | null;
  /** 판 sha — 이 호스트가 구동 중인 els 코드 버전.
   *  r2 계약(TC-H-CC-4): 자기보고(self-reported)·보존 성격 — artifact 증명 아님.
   *  호스트가 스스로 밝힌 값일 뿐이므로 소비자는 이를 증명으로 취급하지 않는다. */
  readonly elsVersionSha: string | null;
  /** 마지막 aliveAt(ISO). heartbeat가 갱신. */
  readonly aliveAt: string | null;
  /** heartbeat 수명 — 이 ms 안에 heartbeat가 없으면 stale로 판정. */
  readonly heartbeatTtlMs: number | null;
  /** 계산 필드 — 저장 안 함. 읽기 시점 alive 판정(만료 행도 보존, alive=false). */
  readonly alive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** watch 사건 — SSE/WS로 흘러나가는 한 건. */
export interface WorkerWatchEvent {
  readonly seq: number;
  /** 사건 주체. worker 사건은 worker id, host 사건(r2)은 `host:<name>` 규약. */
  readonly workerId: string;
  /** 사건 종류 — OP 09:4x 생명주기 사건 + 원장 등록/원하는 상태 변경
   *  + r2 host 사건: host-upserted(등록·갱신·세대 회전)·host-revoked(폐기).
   *  host 사건도 worker_watch 원장에 남아 revision(=MAX seq)을 단조 증가시킨다 —
   *  "모든 쓰기 앞문은 watch 사건으로 남는다"(api.ts 감사 계약) + 호스트만 바뀌어도
   *  스냅샷 캐시 무효화(revision)가 일어난다. heartbeat는 예외(아래 store.ts 참조). */
  readonly type: 'registered' | 'state' | 'steer' | 'output' | 'tool' | 'result' | 'stopped'
    | 'host-upserted' | 'host-revoked';
  /** 이전 값/새 값 — state 사건에만. */
  readonly fromState: WorkerState | null;
  readonly toState: WorkerState | null;
  /** 정체성 사슬 */
  readonly paneId: string | null;
  readonly eventId: string | null;
  readonly at: string;
}

/** r2 ③ — 완전 스냅샷 계약: 비페이징 전체 투영 + revision 와이어.
 *  읽기 도중 한 표라도 실패하면 스냅샷 전체 실패(fail-closed — 부분 투영 반환 금지).
 *  revision = worker_watch 최대 seq(단조 증가) — 쓰기마다 갱신되므로
 *  revision 이 변한 스냅샷은 만료된 캐시 전부를 무효화한다(⑤). */
export interface WorkerRegistrySnapshot {
  /** 단조 증가 — 캐시 무효화 판정 키. */
  readonly revision: number;
  /** 스냅샷 생성 시각(ISO, 주입 시계 기준). */
  readonly at: string;
  /** 최대 신선도 — 이 ms 이후 소비자는 스냅샷을 신선하지 않다고 간주해야 한다. */
  readonly maxFreshnessMs: number;
  readonly workers: readonly WorkerRow[];
  readonly hosts: readonly HostRow[];
}

export function isWorkerKind(value: string): value is WorkerKind {
  return (WORKER_KINDS as readonly string[]).includes(value);
}

export function isWorkerState(value: string): value is WorkerState {
  return (WORKER_STATES as readonly string[]).includes(value);
}

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}
