/**
 * Autopilot REST surface (Phase B2 · 2026-07-09).
 * Endpoints (all under /v1/autopilot):
 *   POST  /triage-preview   goal -> execution model classification (heuristic)
 *   GET   /repo-watch       watched repo state (hermes/openclaw/codex)
 *   GET   /autonomy         autonomous action log (surface_events domain=elanous)
 *   GET   /arming           autonomy boundary gate status (booleans)
 */

import type { DaemonClient } from './daemon-client';

export type ExecutionModel =
  | 'task' | 'goal-loop' | 'scheduler' | 'monitor-trigger'
  | 'hybrid' | 'fanout' | 'single-shot' | 'hitl-delegate';

export interface TriageResult {
  executionModel: ExecutionModel;
  tier: 'light' | 'heavy';
  engine: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  refined: boolean;
}

export interface RepoWatchEntry {
  key: string;
  repo: string;
  note: string;
  lastSha: string | null;
  lastSeen: string | null;
  lastNew: number;
}

export interface AutonomyAction {
  ts: string;
  loop: string;
  summary: string;
  text: string;
  importance: number;
  tags: string | null;
}

export interface ArmingStatus {
  absorb: boolean;
  absorbBackend: string;
  merge: boolean;
  reboot: boolean;
  materialize?: boolean;
}

// ── 미션 계보(AL4) ──
export type DerivedStatus = 'ok' | 'stale' | 'error' | 'active' | 'done' | 'pending';
export interface MissionRollup {
  total: number; ok: number; stale: number; error: number; active: number; pending: number;
}
export interface MissionSummary {
  id: string; goal: string; source: string; status: string;
  model: ExecutionModel | null; tier: string | null; engine: string | null;
  kind?: 'finite' | 'continuous' | 'other';   // 수명 성격
  reviewDue?: boolean;                          // 상시 30일+ 드리프트 리뷰
  createdAt: string; derived?: MissionRollup;
  // ── U1d 통합 표면(/v1/missions) 확장 ──
  isAutopilot?: boolean;                        // false = 사람 intake 미션(autopilot 메타 없음)
  toxStatus?: string;                           // TOX 상태(planning/active/…) — 사람 미션 표시용
  taskCount?: number;                           // Task 개수(사람 미션 진행 표시)
  taskCounts?: Record<string, number>;          // Task 상태별 카운트(파생 rollup 대신)
}
export interface DerivedJob {
  kind: 'cron' | 'task' | 'action';
  /** 크론이면 스케줄 레지스트리 id(= `GET /v1/schedules` 카드 id) — Schedules 탭 링크에 쓴다. */
  id?: string;
  name: string; status: DerivedStatus; detail: string | null;
}

/** 이 미션을 부르는 스케줄 — 계보의 크론 id 로 Schedules 탭을 정확히 거른다(이름 부분 일치 아님). 없으면 null. */
export function missionSchedulesHref(derived: readonly DerivedJob[]): string | null {
  const ids = derived.filter((d) => d.kind === 'cron' && d.id).map((d) => d.id!);
  return ids.length ? `/scheduler?ids=${ids.map(encodeURIComponent).join(',')}` : null;
}
export interface MissionTrace {
  mission: MissionSummary; rollup: MissionRollup; derived: DerivedJob[]; note: string;
}

// ── 통합 Missions 표면(U1d · GET /v1/missions) ────────────────────────────
// Mission Fabric 의 단일 미션 표면. 사람 intake 미션(autopilot=null) + 자율 미션
// (autopilot 메타)을 한 목록으로. autopilot 미션은 mission.id === apm_… 라서
// 기존 /v1/autopilot/trace?id= 계보 조회가 그대로 작동(mission-registry.ts:126).
export interface MissionAutopilotWire {
  apmId?: string;
  origin: 'intake' | 'discovery' | 'repo-watch' | 'manual';
  executionModel?: string; tier?: string; engine?: string;
  rationale?: string; confidence?: string; apmStatus?: string;
  materializeSpec?: { command?: string; cron?: string; prompt?: string };
  runIds?: readonly string[];
}
/** 미션 아크(2026-07-14) — Task Manager 미션 그룹 펼침에서 아크 배리어·통합검증 표시. */
export interface FrontMissionArc {
  arcId: string;
  name: string;
  intent: string;
  phaseIds: string[];
  dependsOnArcs: string[];
  acceptance: string[];
  status: string;
  verifyResult?: { ok: boolean; evidence: string; missing?: string };
  /** 정의 시점 grounded pre-flight 판정(A7-L2) — 허상/과대 아크를 Task Manager 에 표면화. */
  preflightVerdict?: { verdict: 'founded' | 'mirage' | 'over_scope'; reason: string; action: string };
}

export interface MissionCardWire {
  id: string; title: string; description: string | null;
  status: string; priority: string; goalSlug: string | null;
  taskCount: number;
  taskStatusCounts: Record<string, number>;
  surfaceKindCounts: Record<string, number>;
  autopilot: MissionAutopilotWire | null;
  createdAt: number; updatedAt: number; closedAt: number | null;
}

const FINITE_MODELS = ['task', 'goal-loop', 'single-shot'];
const CONTINUOUS_MODELS = ['scheduler', 'monitor-trigger'];
/** 실행모델 → 수명 성격(백엔드 missionKind 미러 · mission-lifecycle.ts). */
function missionKind(model: string | null): 'finite' | 'continuous' | 'other' {
  if (model && FINITE_MODELS.includes(model)) return 'finite';
  if (model && CONTINUOUS_MODELS.includes(model)) return 'continuous';
  return 'other';
}

/** MissionCardWire(/v1/missions) → 컴포넌트 표시 모델. 자율 미션은 autopilot
 *  메타에서, 사람 미션은 TOX 상태·Task 카운트에서 필드를 끌어온다. */
export function missionCardToSummary(w: MissionCardWire): MissionSummary {
  const a = w.autopilot;
  const model = (a?.executionModel ?? null) as ExecutionModel | null;
  return {
    id: w.id,
    goal: w.title || w.description || w.id,
    source: a?.origin ?? 'human',
    status: a?.apmStatus ?? w.status,
    model,
    tier: a?.tier ?? null,
    engine: a?.engine ?? null,
    kind: missionKind(a?.executionModel ?? null),
    reviewDue: false,
    createdAt: new Date(w.createdAt).toISOString(),
    isAutopilot: a != null,
    toxStatus: w.status,
    taskCount: w.taskCount,
    taskCounts: w.taskStatusCounts,
  };
}

export class AutopilotApi {
  constructor(private client: DaemonClient) {}

  async triagePreview(goal: string, category?: string): Promise<{ ok: boolean; triage: TriageResult; missionId?: string }> {
    return this.client.fetchJson('/v1/autopilot/triage-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, ...(category ? { category } : {}) }),
    });
  }

  /** 골을 오토파일럿 미션으로 커밋(계보 뿌리 생성) → missionId. */
  async commitMission(goal: string, source = 'intake', category?: string): Promise<{ ok: boolean; triage: TriageResult; missionId?: string }> {
    return this.client.fetchJson('/v1/autopilot/triage-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, commit: true, source, ...(category ? { category } : {}) }),
    });
  }

  async missions(status?: string, source?: string): Promise<{ ok: boolean; count: number; missions: MissionSummary[]; note: string }> {
    const q = new URLSearchParams({ ...(status ? { status } : {}), ...(source ? { source } : {}) });
    const qs = q.toString();
    return this.client.fetchJson(`/v1/autopilot/missions${qs ? `?${qs}` : ''}`);
  }

  /** 통합 미션 표면(U1d) — /v1/missions(fabric 전체: 사람 intake + 자율)를 읽어
   *  컴포넌트 표시 모델로 매핑. autopilot 미션은 계보/구체화, 사람 미션은 Task 진행. */
  async missionsUnified(status?: string): Promise<{ ok: boolean; total: number; missions: MissionSummary[] }> {
    const q = new URLSearchParams({ ...(status ? { status } : {}) });
    const qs = q.toString();
    const r = await this.client.fetchJson<{ total?: number; missions?: MissionCardWire[] }>(`/v1/missions${qs ? `?${qs}` : ''}`);
    const cards = r.missions ?? [];
    return { ok: true, total: r.total ?? cards.length, missions: cards.map(missionCardToSummary) };
  }

  async trace(id: string): Promise<{ ok: boolean } & MissionTrace> {
    return this.client.fetchJson(`/v1/autopilot/trace?id=${encodeURIComponent(id)}`);
  }

  /** 미션별 아크 상세(2026-07-14) — /v1/missions 의 autopilot 블롭에서 arcs 추려 map 반환.
   *  Task Manager 미션 그룹 펼침에서 아크 배리어·통합검증(verifyResult)·arc-revise 상태 표시용. */
  async missionArcMap(): Promise<Map<string, { apmStatus?: string; arcs: FrontMissionArc[] }>> {
    const r = await this.client.fetchJson<{ missions?: Array<{ id: string; autopilot?: { apmStatus?: string; arcs?: FrontMissionArc[] } | null }> }>('/v1/missions');
    const map = new Map<string, { apmStatus?: string; arcs: FrontMissionArc[] }>();
    for (const m of r.missions ?? []) {
      const arcs = m.autopilot?.arcs;
      if (arcs && arcs.length > 0) map.set(m.id, { apmStatus: m.autopilot?.apmStatus, arcs });
    }
    return map;
  }

  /** 미션 구체화(materialize)·승인(approve/arm)·종료(cancel) — HITL 쓰기. */
  async missionAction(id: string, action: 'materialize' | 'arm' | 'cancel' | 'approve', spec: { command?: string; cron?: string; prompt?: string } = {}): Promise<{ ok?: boolean; error?: string; engine?: string; cron?: string; taskId?: string; note?: string; releasedCrons?: number; activated?: number }> {
    return this.client.fetchJson('/v1/autopilot/mission-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action, ...spec }),
    });
  }

  async repoWatch(): Promise<{ ok: boolean; repos: RepoWatchEntry[] }> {
    return this.client.fetchJson('/v1/autopilot/repo-watch');
  }

  async autonomy(limit = 50, loop?: string): Promise<{ ok: boolean; actions: AutonomyAction[] }> {
    const q = new URLSearchParams({ limit: String(limit), ...(loop ? { loop } : {}) });
    return this.client.fetchJson(`/v1/autopilot/autonomy?${q.toString()}`);
  }

  async arming(): Promise<{ ok: boolean; arming: ArmingStatus; note: string }> {
    return this.client.fetchJson('/v1/autopilot/arming');
  }
}

/** 실행모델 → 한국어 라벨 + 색조(칩 표시용). */
export const EXECUTION_MODEL_META: Record<ExecutionModel, { label: string; tone: string }> = {
  task: { label: '작업 분해', tone: 'bg-sky-500/15 text-sky-200 ring-sky-500/30' },
  'goal-loop': { label: '목표 루프', tone: 'bg-violet-500/15 text-violet-200 ring-violet-500/30' },
  scheduler: { label: '스케줄러', tone: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30' },
  'monitor-trigger': { label: '감시 트리거', tone: 'bg-amber-500/15 text-amber-200 ring-amber-500/30' },
  hybrid: { label: '하이브리드', tone: 'bg-fuchsia-500/15 text-fuchsia-200 ring-fuchsia-500/30' },
  fanout: { label: '병렬 팬아웃', tone: 'bg-cyan-500/15 text-cyan-200 ring-cyan-500/30' },
  'single-shot': { label: '즉답', tone: 'bg-muted text-muted-foreground ring-border' },
  'hitl-delegate': { label: 'HITL 위임', tone: 'bg-rose-500/15 text-rose-200 ring-rose-500/30' },
};
