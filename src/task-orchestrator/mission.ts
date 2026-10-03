/**
 * Mission entity — the 5+1 시민 model's group host (Phase 1 I6).
 *
 * Origin: 내부 문서 `RESEARCH-intake-auto-task-graph-2026-05-11`
 *   §3.1 (Mission entity 의 정체) + §8.1 (schema).
 *
 * **Why a separate entity, not "Task with children"**: a mission is the
 * user-facing intent ("다이어그램 + 영상 생성 강화") that decomposes into
 * 1..N tasks. Tasks are thin execution pointers (D1 시각 5.1). Without a
 * Mission row, the system has no place to hang:
 *   - the original intake memo / raw text,
 *   - the cross-task rationale ("why these tasks were grouped"),
 *   - the user's "진짜 의도" (intent) — separate from the implementation surface,
 *   - status that summarises N-task progress in one glance.
 *
 * The Mission is **additive**: existing Task rows that never join a
 * mission stay unchanged. `Task.missionId` is optional — a thin reverse
 * pointer for O(1) lookups; the source of truth remains `Mission.taskIds`.
 */

// ──────────────────── Status ───────────────────────────────────────────

/**
 * Lifecycle of a Mission.
 *
 *   planning   → active | cancelled
 *   active     → paused | completed | cancelled
 *   paused     → active | cancelled
 *   completed  → (terminal)
 *   cancelled  → (terminal)
 *
 * Derivation hint (caller, not enforced here):
 *   - `planning` while every taskId is in `backlog`.
 *   - `active` when ≥1 task is in `ready|running|review`.
 *   - `completed` when *all* tasks are terminal AND ≥1 is `done`.
 *   - `cancelled` when the user cancels OR every task is `cancelled`.
 */
export type MissionStatus =
  | 'planning'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled';

export const MISSION_STATUSES: readonly MissionStatus[] = [
  'planning',
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;

export function isMissionStatus(v: unknown): v is MissionStatus {
  return typeof v === 'string' && (MISSION_STATUSES as readonly string[]).includes(v);
}

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = [
  'completed',
  'cancelled',
];

export function isTerminalMissionStatus(s: MissionStatus): boolean {
  return (TERMINAL_MISSION_STATUSES as readonly string[]).includes(s);
}

// ──────────────────── Mission ──────────────────────────────────────────

export type MissionPriority = 'low' | 'medium' | 'high';

export interface MissionSource {
  kind: 'intake' | 'manual';
  /** Source intake session id, when `kind === 'intake'`. */
  intakeId?: string;
  /** Raw memo / dump excerpt — useful for "why did we add these tasks?" UX. */
  raw?: string;
}

/**
 * PFC Layer2 (구 Autopilot) 자율 메타데이터 — Mission Fabric 통합 U1
 * (2026-07-09, DESIGN-mission-fabric-unification).
 *
 * apm Mission(`autopilot_missions` 별 table)이 병렬로 들고 있던 필드를
 * TOX Mission 위로 흡수한다. TOX 5-state(status)가 canonical lifecycle 이고,
 * 이 blob 은 그 위에 얹히는 **자율 뇌**의 부가 정보(어떤 실행모델로 굴릴지·
 * triage 근거·계보 키·구체화 spec)만 담는다.
 *
 * 없으면(=undefined) 그냥 사람이 만든 일반 Mission. 있으면 Layer2 가 다루는
 * 자율 Mission. `apmId` 는 계보 fan-in(schedule_registry.autopilot_id·
 * tox_tasks.goal_slug·surface_events.refs)에서 쓰는 안정 lineage 키로 보존.
 */
export interface MissionAutopilot {
  /** 안정 lineage 키 (apm_<yyyymmddHHmm>_<slug>_<hash6>). 계보 태깅 출처. */
  apmId?: string;
  /** 이 Mission 이 어디서 왔나 — 자율 발굴/감시/사람 intent 구분. 'human-intent'(구 'intake'
   *  리네임·사람 포착) · 'intake' 는 레거시 저장값 read 호환용 유지(정규화는 표시 경계에서). */
  origin: 'human-intent' | 'intake' | 'discovery' | 'repo-watch' | 'manual';
  /** triage 가 정한 실행모델 (task·goal-loop·scheduler·monitor-trigger 등). */
  executionModel?: string;
  /** triage 가 정한 도메인 (coding·investment·business·general) — WHAT 축·D1. */
  domain?: string;
  /**
   * ★ 예약(RFC-orchestration-framework-lifecycle-governance §3a) — agent-loop-substrate 실행 모드
   * (loop·react·team-leader·orchestrator·group). 실행 구조(HOW·에이전트 유형) 축으로 domain(WHAT)과 직교.
   * ⚠️ 필드만 예약 — 분류·각인 로직은 RFC(LG3~LG5) 구현 이후. 그전까지 undefined(표시=—).
   */
  mode?: 'loop' | 'react' | 'team-leader' | 'orchestrator' | 'group';
  /** triage tier (heavy·light). */
  tier?: string;
  /** 실행 엔진 힌트 (tox·cron·dig 등). */
  engine?: string;
  /** triage 근거 텍스트. */
  rationale?: string;
  /** triage 신뢰도. */
  confidence?: string;
  /**
   * apm 자율 lifecycle 상태(proposed·armed·running·done·failed·disarmed).
   * TOX status(planning/active/...)와 별개 축 — arming/mandate 게이트 상태.
   */
  apmStatus?: string;
  /** HITL 승인된 구체화 spec — arming 시 실제 cron/task 로 materialize. */
  materializeSpec?: { command?: string; cron?: string; prompt?: string };
  /** 파생 실행 세션 id 들 (계보 추적). */
  runIds?: readonly string[];
  /**
   * coordinator 실행모델(2026-07-10 · PLAN-trade-coordinator-mission) 계층 —
   * 조율 미션이 낳은 하위 계약/에이전트 미션 id 들(fan-in tree). 상위 조율 미션엔
   * childMissionIds, 하위엔 parentMissionId. coordinationModel=조율 방식.
   * optional — 비-coordinator 미션엔 부재(회귀 0).
   */
  childMissionIds?: readonly string[];
  parentMissionId?: string;
  coordinationModel?: 'risk-budget' | 'weighted-vote' | 'sequential';

  /**
   * 재실행 세대(대표 2026-07-12) — rerun/rebuild 마다 +1. undefined/0 = 최초 실행.
   * "재실행 중이라는 문맥"을 미션이 스스로 인지하는 단일 소스. 알림·중복가드가 참조한다.
   */
  rerunGeneration?: number;
  /**
   * 재실행 히스토리(삭제 아닌 보관·memory-lifecycle 철학 정합) — 각 세대 전환 직전의
   * 페이즈 상태 스냅샷. 최신이 배열 뒤. "깨끗하게 재구현"하되 이전 시도가 증발하지 않도록
   * 보존한다. 리셋(status→backlog)은 이 스냅샷을 남긴 뒤에만 일어난다.
   */
  rerunHistory?: readonly RerunGenerationSnapshot[];
  /**
   * ★ P3(대표 2026-07-13·캐스케이드 컨트롤) — 미션 일시정지 플래그. run-mission 이 다음 페이즈
   * 실행 전 이 값을 확인해 true 면 실행을 중단한다(상태 보존·삭제 아님). resume 시 재개(재spawn).
   */
  paused?: boolean;

  /**
   * ★ 미션 아크(RFC-mission-arcs-2026-07-14·A1) — 골→아크(응집 서브골)→페이즈 계층. 없으면 flat
   * (암묵적 단일 아크·하위호환·회귀 0). 아크는 순차 배리어로 실행되고, 아크 통합 acceptance 가
   * "페이즈는 green 인데 아크로는 dead-code" 를 잡는다. 아크 내 독립 페이즈는 병렬 실행(A3).
   */
  arcs?: readonly MissionArc[];
  /** 분류 게이트 결과(RFC §4) — single(flat·기본) 또는 multi. 보수적 기본=single(과계층화 방지). */
  arcModel?: 'single' | 'multi';
  /** #4498 3A coherence — 저장된 arcs 가 파생된 근거 arcHint(version). arcHint 갱신시 stale 탐지·재파생. */
  arcsArcHint?: number;

  /**
   * ★ 연관 미션(RFC §9) — parent/child(위 childMissionIds·parentMissionId)와 별개인 동급 관계.
   * friend=동일 골 계보 형제(재실행/변형), associate=자원·산출 공유(예: 같은 파일 — 충돌 경보).
   * optional·회귀 0. 관계 변경은 ops_events(event='mission_linked')로 추적.
   */
  associatedMissionIds?: readonly MissionRelationLink[];
}

/** 연관 미션 링크(RFC §9) — 동급(friend/associate) 관계 1건. */
export interface MissionRelationLink {
  id: string;
  relation: 'friend' | 'associate';
  note?: string;
}

/**
 * 미션 아크(RFC-mission-arcs-2026-07-14) — 골과 페이즈 사이의 응집 서브골 계층. deliverable 기준
 * 묶음(개수 아님). 아크 통합 acceptance 가 핵심 가치(페이즈 로컬이 놓치는 정합성).
 */
export interface MissionArc {
  /** arc_<slug>_<idx> — 미션 내 유일. */
  arcId: string;
  /** 서브골 이름(예: "관측 계약"). */
  name: string;
  /** 이 아크가 닫는 응집 서브골(1~2문장). */
  intent: string;
  /** 이 아크에 속한 페이즈 task.id[]. */
  phaseIds: readonly string[];
  /** 선행 아크 arcId[](순차 배리어). */
  dependsOnArcs: readonly string[];
  /** ★ 아크 통합 acceptance — 페이즈 로컬 acceptance 가 놓치는 통합 정합성(dead-code·미배선 검출). */
  acceptance: readonly string[];
  /** 이 아크가 재사용해야 할 경계(아크 스코프 워킹메모리 시드·A4). */
  reuseBoundaries?: readonly string[];
  /** 아크 생애주기 상태. descoped(2026-07-15) = 범위 제외(임베딩 arc2 선례) — done 과 동등하게 완주를
   *  막지 않는다(non-blocking). 'failed'(실검증 실패)와 구분: descoped 는 "의도적으로 안 함"이라 배리어
   *  통과·재실행 안 함. 전 페이즈 cancelled 인 아크 또는 preflight action==='descope' 에서 전이. */
  status: 'pending' | 'active' | 'verifying' | 'done' | 'failed' | 'descoped';
  /** ★ 아크별 예산 자동 산정(USD·B1·2026-07-15) — 멤버 페이즈 견적 합 or 관심사 기반 기본값.
   *  insert-arc/split 로 아크가 커지면 재산정(델타 HITL 카드). 미산정이면 undefined(하위호환). */
  estimatedCost?: number;
  /** ★ 이 아크 안에서 발생한 페이즈 split 누적 횟수(§5 drift 자기감지·2026-07-15). 임계(2)에 닿으면
   *  "아크 크기 오판" 신호 → insert-arc/성숙도 분리 역제안. 미기록이면 undefined(=0). */
  splitCount?: number;
  /** 아크 통합 검증 결과(A2). */
  verifyResult?: { ok: boolean; evidence: string; missing?: string };
  /**
   * ★ 정의 시점 grounded pre-flight 판정(RFC §14b·A7-L2) — 이 아크의 deliverable 이 실제 코드에
   * 근거를 두는가. founded=버전 가능·mirage=잘못된 파일/없는 전제·over_scope=이미 존재/과대. 허상
   * 아크(arc2 supersede 선례)를 materialize·빌드 전에 HITL 승인 게이트에 표면화한다(과계층화 방지).
   */
  preflightVerdict?: { verdict: 'founded' | 'mirage' | 'over_scope'; reason: string; action: 'keep' | 'narrow' | 'descope' | 'merge' };
}

/**
 * 재실행 세대 스냅샷(대표 2026-07-12) — 한 세대의 페이즈 산출물을 보관한다.
 * 원상태 dump 가 아니라 "무엇을 시도했고 어디까지 갔나"의 결정 입력(status·PR·notes).
 */
export interface RerunGenerationSnapshot {
  /** 이 스냅샷이 보관하는 세대 번호(리셋 직전 세대). */
  generation: number;
  /** 보관 시각(epoch ms). */
  archivedAt: number;
  /** ★ 이 세대의 골(대표 2026-07-13·생애주기 revision) — 골 수정(revise) 이력을 복원한다.
   *  요구사항이 바뀌면 골도 진화하므로 세대마다 골 스냅샷. 미지정=이전과 동일(골 불변). */
  goal?: string;
  /** 재실행 계기 — 전체 재실행(rerun)·특정 페이즈 재구현(rebuild)·골 수정(revise)·페이즈 추가(phase-add). */
  reason: 'rerun' | 'rebuild' | 'revise' | 'phase-add';
  /** 리셋 시작 페이즈 index(포함) — rerun=0, rebuild=해당 페이즈. */
  fromPhaseIndex: number;
  /** 각 페이즈의 보관 스냅샷(생성 순). */
  phases: readonly RerunPhaseSnapshot[];
}

/** 재실행 스냅샷의 페이즈 1건 — 결정 입력만(title·status·PR·notes). */
export interface RerunPhaseSnapshot {
  title: string;
  status: string;
  /** notes 에서 추출한 PR URL(있으면). */
  prUrl?: string;
  /** 이 페이즈의 실행 흔적(append-only notes). */
  notes: readonly string[];
}

export interface Mission {
  readonly id: string;             // `mission:<hex>`
  readonly createdAt: number;
  updatedAt: number;
  closedAt?: number;

  title: string;                   // ≤ 80 chars · imperative or NP
  description?: string;            // LLM 1-2 sentence summary
  intent?: string;                 // user's "real" intent (above the surface)

  source: MissionSource;

  status: MissionStatus;
  priority?: MissionPriority;

  /** Source-of-truth task list. `Task.missionId` is a denormalised
   *  reverse pointer — keep them in sync. */
  taskIds: readonly string[];

  /** Optional bind to an existing goal (S2 auto-research / PFC). */
  goalSlug?: string;
  /** Project association; absent on legacy and unassigned missions. */
  projectId?: string;

  /** Free-form notes (append-only). */
  notes: readonly string[];

  /** Cascade-zyu Z0 (2026-05-12) — optional anchor to an existing
   *  Showroom session. Mirrors `Task.showroomSessionId`; lets the PWA
   *  surface a "Open in showroom" jump from `/missions/<id>` and the
   *  inverse "Save as mission" round-trip. The Mission ↔ Showroom
   *  link is many-to-one (multiple missions can share a showroom
   *  session, e.g. the same brainstorm produced both a research and
   *  an implementation mission). */
  showroomSessionId?: string;

  /** PFC Layer2 자율 메타 (Mission Fabric 통합 U1). 없으면 일반 Mission. */
  autopilot?: MissionAutopilot;
}

export const MISSION_DEFAULTS = {
  titleMaxLen: 80,
  descriptionMaxLen: 2000,
  intentMaxLen: 1000,
} as const;

export interface MissionInit {
  title: string;
  description?: string;
  intent?: string;
  source: MissionSource;
  status?: MissionStatus;
  priority?: MissionPriority;
  taskIds?: readonly string[];
  goalSlug?: string;
  projectId?: string;
  notes?: readonly string[];
  /** Cascade-zyu Z0 — see {@link Mission.showroomSessionId}. */
  showroomSessionId?: string;
  /** PFC Layer2 자율 메타 (Mission Fabric 통합 U1) — see {@link Mission.autopilot}. */
  autopilot?: MissionAutopilot;
}

// ──────────────────── Id helpers ───────────────────────────────────────

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(arr);
  else for (let i = 0; i < bytes; i += 1) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newMissionId(): string {
  return `mission:${randomHex(6)}`;
}

export function isMissionId(v: unknown): v is string {
  return typeof v === 'string' && /^mission:[0-9a-f]{2,16}$/.test(v);
}

// ──────────────────── Factory ──────────────────────────────────────────

/**
 * Build a Mission with sensible defaults. Pure — no IO.
 *
 * Throws `RangeError` on constraint violations (title length etc.) so
 * callers fail fast rather than persist corrupt rows.
 */
export function createMission(
  init: MissionInit,
  opts?: { now?: number; id?: string },
): Mission {
  if (!init.title || init.title.length === 0) {
    throw new RangeError('Mission.title must be non-empty');
  }
  if (init.title.length > MISSION_DEFAULTS.titleMaxLen) {
    throw new RangeError(
      `Mission.title exceeds ${MISSION_DEFAULTS.titleMaxLen} chars`,
    );
  }
  if (init.description && init.description.length > MISSION_DEFAULTS.descriptionMaxLen) {
    throw new RangeError(
      `Mission.description exceeds ${MISSION_DEFAULTS.descriptionMaxLen} chars`,
    );
  }
  if (init.intent && init.intent.length > MISSION_DEFAULTS.intentMaxLen) {
    throw new RangeError(
      `Mission.intent exceeds ${MISSION_DEFAULTS.intentMaxLen} chars`,
    );
  }
  if (init.source.kind !== 'intake' && init.source.kind !== 'manual') {
    throw new RangeError(`Mission.source.kind must be 'intake' or 'manual'`);
  }
  if (init.status && !isMissionStatus(init.status)) {
    throw new RangeError(`Mission.status invalid: ${String(init.status)}`);
  }
  const now = opts?.now ?? Date.now();
  return {
    id: opts?.id ?? newMissionId(),
    createdAt: now,
    updatedAt: now,
    title: init.title,
    description: init.description,
    intent: init.intent,
    source: { ...init.source },
    status: init.status ?? 'planning',
    priority: init.priority,
    taskIds: Object.freeze([...(init.taskIds ?? [])]),
    goalSlug: init.goalSlug,
    ...(init.projectId !== undefined ? { projectId: init.projectId } : {}),
    notes: Object.freeze([...(init.notes ?? [])]),
    showroomSessionId: init.showroomSessionId,
    autopilot: init.autopilot ? { ...init.autopilot } : undefined,
  };
}

// ──────────────────── Transition guard ─────────────────────────────────

const LEGAL: Record<MissionStatus, ReadonlyArray<MissionStatus>> = {
  planning: ['active', 'cancelled'],
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransitionMission(
  from: MissionStatus,
  to: MissionStatus,
): boolean {
  return LEGAL[from].includes(to);
}

/**
 * Return a new Mission with `status` updated. Stamps `updatedAt` to
 * `now`, and `closedAt` when the target is terminal. Throws on illegal
 * transitions so storage layers can rely on `LEGAL` invariants.
 */
export function transitionMission(
  mission: Mission,
  to: MissionStatus,
  opts?: { now?: number },
): Mission {
  if (!canTransitionMission(mission.status, to)) {
    throw new Error(
      `Illegal mission transition: ${mission.status} → ${to} (mission=${mission.id})`,
    );
  }
  const now = opts?.now ?? Date.now();
  return {
    ...mission,
    status: to,
    updatedAt: now,
    closedAt: isTerminalMissionStatus(to) ? now : mission.closedAt,
  };
}

// ──────────────────── Task list mutation ───────────────────────────────

/**
 * Return a new Mission with the given taskId appended. Idempotent —
 * adding a taskId that already lives in the mission is a no-op.
 */
export function attachTaskToMission(
  mission: Mission,
  taskId: string,
  opts?: { now?: number },
): Mission {
  if (mission.taskIds.includes(taskId)) return mission;
  const now = opts?.now ?? Date.now();
  return {
    ...mission,
    taskIds: Object.freeze([...mission.taskIds, taskId]),
    updatedAt: now,
  };
}

/**
 * Return a new Mission with the given taskId removed. No-op when the
 * taskId is not in the mission.
 */
export function detachTaskFromMission(
  mission: Mission,
  taskId: string,
  opts?: { now?: number },
): Mission {
  if (!mission.taskIds.includes(taskId)) return mission;
  const now = opts?.now ?? Date.now();
  return {
    ...mission,
    taskIds: Object.freeze(mission.taskIds.filter((id) => id !== taskId)),
    updatedAt: now,
  };
}

// ──────────────────── Serialization ────────────────────────────────────

export function serializeMission(m: Mission): Record<string, unknown> {
  return {
    id: m.id,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    closedAt: m.closedAt,
    title: m.title,
    description: m.description,
    intent: m.intent,
    source: { ...m.source },
    status: m.status,
    priority: m.priority,
    taskIds: [...m.taskIds],
    goalSlug: m.goalSlug,
    ...(m.projectId !== undefined ? { projectId: m.projectId } : {}),
    notes: [...m.notes],
    showroomSessionId: m.showroomSessionId,
  };
}

// ──────────────────── Showroom anchor (cascade-zyu Z0) ────────────────

/**
 * Return a new Mission with `showroomSessionId` set to the given id.
 * Idempotent — re-linking to the same session is a no-op (no
 * `updatedAt` bump). PWA "Save as mission" + intake decomposition
 * use this to record where the mission was authored.
 */
export function linkShowroomSessionToMission(
  mission: Mission,
  showroomSessionId: string,
  opts?: { now?: number },
): Mission {
  if (!showroomSessionId || showroomSessionId.length === 0) {
    throw new RangeError('showroomSessionId must be non-empty');
  }
  if (mission.showroomSessionId === showroomSessionId) return mission;
  const now = opts?.now ?? Date.now();
  return { ...mission, showroomSessionId, updatedAt: now };
}

/**
 * Return a new Mission with `showroomSessionId` cleared. No-op when
 * the field is already unset (no `updatedAt` bump).
 */
export function unlinkShowroomSessionFromMission(
  mission: Mission,
  opts?: { now?: number },
): Mission {
  if (mission.showroomSessionId === undefined) return mission;
  const { showroomSessionId: _drop, ...rest } = mission;
  const now = opts?.now ?? Date.now();
  return { ...rest, updatedAt: now };
}
