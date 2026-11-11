// ── Autopilot Mission Registry (AL1 · 2026-07-09) ─────────────────────────
//
// 대표 지시: 오토파일럿으로 만들어진 잡이 기본 추적 가능해야 한다. 골 1건 = 미션.
// 미션에 안정 ID(apm_…)를 부여하고, 파생 크론/태스크/모니터/자율행동이 이 ID 를
// 심어(제자리 태깅) 단일 tool/PWA 로 fan-in 조회·모니터한다. 이 모듈은 계보의
// 뿌리(미션 레지스트리 · prospective memory 의 오토파일럿판).
//
// ── Mission Fabric 통합 U1b (2026-07-09) ──────────────────────────────────
// apm Mission 은 이제 별 table(autopilot_missions.db)이 아니라 **TOX Mission
// (tox_missions · tasks.db)** 위에 산다. 본 모듈은 그 위에 얹히는 얇은 **어댑터**:
// 소비자(engine·trace·lifecycle·tool·API·discovery)는 apm MissionRow/함수
// 시그니처 그대로 쓰고, 내부에서 TaskStore(TOX Mission)로 read/write 한다.
// apm_id 는 TOX Mission.id 로 직접 사용(사람가독 PK) + goalSlug 로도 보존해
// 계보 fan-in(schedule_registry.autopilot_id·tox_tasks.goal_slug)이 그대로 작동.
// 설계: 내부 문서 `DESIGN-mission-fabric-unification-2026-07-09` §4·§5(U1).

import { elanousStateRoot } from './state-paths.js';
import { addMissionEdge } from './mission-edges.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStore } from '../task-orchestrator/store.js';
import { createMission as createToxMission, type Mission } from '../task-orchestrator/mission.js';
import { apmSnapshotToMissionInit, apmStatusToMissionStatus, isAutopilotMission } from '../task-orchestrator/mission-autopilot.js';
import { recordOpsEventSafe } from '../domains/ops-log.js';
import { ensureMissionOrigin } from './mission-origin.js';

/** Legacy apm Mission db 경로 — U1b 이후 미사용(실 미션=TOX tasks.db·백업/참조용 보존).
 *  core = autopilot/ (conatus/ 는 투자 customer 네임스페이스·대표 정정 2026-07-11). */
/** [ISO-3] ELANOUS_STATE_DIR 존중(lazy) — 격리 테스트 데몬은 자기 미션 우주만 본다. */
export function autopilotMissionsDbPath(): string {
  return join(elanousStateRoot(), 'autopilot/autopilot_missions.db');
}

// ★ 'building'(대표 2026-07-21·조율자 상태소유) — 조율자가 골을 분해/구현(decompose·build)하는 몇 분간의
//   전이 상태. 종전엔 이 상태가 persist 안 돼 ops 가 빌드 중 미션을 계속 'proposed·승인대기'로 표시(대표:
//   "조율자가 상태관리를 안 한다"). deriveLifecycle 은 building 을 파생만 했고 registry 는 안 따라간 이원화.
//   이제 se-mission-prepare 가 build 진입 시 building 으로 전이(끝나면 이전 상태 복원)해 조율자가 실소유.
export const MISSION_STATUSES = ['proposed', 'building', 'armed', 'running', 'done', 'failed', 'disarmed', 'rejected'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];
// 미션 출처(provenance) — 누가 이 미션을 촉발했나. 'human-intent'(대표 지시 2026-07-10 리네임:
// 구 'intake' = 사람이 채널로 던진 의도·narrow-waist 게이트 통과) · 'discovery'(elanous 자율 발굴)
// · 'repo-watch'(레포 감시) · 'manual'(CLI 직접). 저장된 레거시 'intake' 는 read 시 normalizeMissionSource 로 흡수.
export type MissionSource = 'human-intent' | 'discovery' | 'repo-watch' | 'manual';

/** 레거시 'intake' → 'human-intent' 정규화(back-compat·read 경계). 기존 저장 미션 무손상. */
export function normalizeMissionSource(raw: string | null | undefined): MissionSource {
  if (raw === 'intake' || raw === 'human-intent') return 'human-intent';
  if (raw === 'discovery' || raw === 'repo-watch' || raw === 'manual') return raw;
  return 'manual';
}

/** 미션 출처의 사람용 라벨(UI 표기). 값(휴먼 인텐트 의미) + 한글 설명. */
export function missionSourceLabel(source: string | null | undefined): string {
  switch (normalizeMissionSource(source)) {
    case 'human-intent': return '휴먼 인텐트 (내가 던진 골)';
    case 'discovery': return 'elanous 자율 발굴';
    case 'repo-watch': return '레포 감시';
    case 'manual': return '수동(CLI)';
    default: return String(source ?? 'manual');
  }
}

/** 어댑터 핸들 — 소비자는 open→(registry 함수 전달)→close 만 한다. */
export type MissionStore = TaskStore;

/** triage 결과(있으면) — 무엇을·어떻게 실행하려는가. */
export interface MissionTriage {
  executionModel?: string; domain?: string; tier?: string; engine?: string;
  rationale?: string; confidence?: string;
}
export interface MissionInput {
  goal: string;
  source: MissionSource;
  triage?: MissionTriage;
  status?: MissionStatus;   // 기본 'proposed'
  runId?: string;
  now?: Date;               // 시각 seam(테스트 결정론)
  slug?: string;            // LLM 요약 slug(id 가독성) — 없으면 휴리스틱. generateMissionSlug 로 미리 생성.
}
/** apm 표면 MissionRow — 소비자 계약(변경 없음). TOX Mission 에서 매핑해 반환. */
export interface MissionRow {
  id: string; goal: string; source: string;
  execution_model: string | null; domain: string | null; tier: string | null; engine: string | null;
  mode: string | null;                      // ★ 예약(RFC §3a) — substrate 실행 모드(HOW축). RFC(LG3~LG5) 이후 채움·그전 null.
  rationale: string | null; confidence: string | null;
  status: string; run_ids: string | null;   // JSON string[]
  created_at: string; updated_at: string;
  materialize_spec?: string | null;         // JSON {command?,cron?,prompt?} — HITL 승인 spec
  description?: string | null;              // 준비 맥락(외부조사·분해·중복) — 회상/추적용(2026-07-12)
  // ★ 프렌즈 링크 노출(대표 2026-07-16) — 조율↔하위 미션 관계를 어댑터에서도 보이게(가시성 갭 수정).
  //   앞서 이 필드 부재로 parentMissionId 를 registry getMission 으로 읽어 undefined 오진.
  parent_mission_id?: string | null;        // 상위 조율 미션 id(자식일 때)
  child_mission_ids?: string | null;        // JSON string[] — 하위 미션 id(부모일 때)
}

// ── 매핑 (TOX Mission ↔ apm MissionRow) ───────────────────────────────────

function toMissionRow(m: Mission): MissionRow {
  const a = m.autopilot;
  return {
    id: m.id,
    goal: m.intent ?? m.title,
    source: normalizeMissionSource(a?.origin), // 레거시 'intake' → 'human-intent' 흡수(back-compat)
    execution_model: a?.executionModel ?? null,
    domain: a?.domain ?? null,
    mode: a?.mode ?? null,   // ★ 예약(RFC §3a) — RFC 이후 채움. 그전까지 항상 null.
    tier: a?.tier ?? null,
    engine: a?.engine ?? null,
    rationale: a?.rationale ?? null,
    confidence: a?.confidence ?? null,
    status: a?.apmStatus ?? 'proposed',
    run_ids: a?.runIds && a.runIds.length > 0 ? JSON.stringify([...a.runIds]) : null,
    created_at: new Date(m.createdAt).toISOString(),
    updated_at: new Date(m.updatedAt).toISOString(),
    materialize_spec: a?.materializeSpec ? JSON.stringify(a.materializeSpec) : null,
    description: m.description ?? null,
    parent_mission_id: a?.parentMissionId ?? null,
    child_mission_ids: a?.childMissionIds && a.childMissionIds.length > 0 ? JSON.stringify([...a.childMissionIds]) : null,
  };
}

// ── 사람가독 id helpers ────────────────────────────────────────────────────

/** slug 불용어 — 조사·주어·흔한 동사꼬리(핵심 명사만 남겨 id 가독성↑). 전부 걸리면 원본 유지. */
const SLUG_STOPWORDS = new Set([
  'elanous', '가', '이', '을', '를', '은', '는', '의', '에', '도', '로', '와', '과', '만', '에서', '에게',
  '해줘', '해', '하도록', '만들어', '만들어줘', '구현', '설계', '줘', '하는', '하고', '않도록', '되게', '있게', '좀', '그',
  'a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'in', 'on',
]);

/** 골에서 slug 재료 추출 — 따옴표("..." '...' 「」 『』)로 감싼 핵심어 우선(사용자 관용).
 *  없으면 골 전체(불용어는 slugify 가 걸러냄). LLM slug 실패 시 fallback 품질을 높인다. */
export function extractSlugSource(goal: string): string {
  const quoted = goal.match(/[""'「『]([^""'」』\n]{2,40})[""'」』]/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  return goal;
}

/** 사람가독 slug — 글자/숫자만 유지(한글 포함), 나머지 '-'. 불용어 토큰 제거(핵심 명사 우선)
 *  후 max 자름. 전부 불용어면 원본 유지(fallback). */
export function slugify(s: string, max = 48): string {
  const raw = s.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (!raw) return 'goal';
  const kept = raw.split('-').filter((t) => t && !SLUG_STOPWORDS.has(t));
  const base = (kept.length ? kept : raw.split('-')).join('-');
  return base.slice(0, max).replace(/-+$/g, '') || 'goal';
}

/** LLM 출력 → 안전한 영문 kebab slug(영숫자·하이픈). 시간값이 빠진 만큼 길이를 넉넉히
 *  (최대 8토큰·50자) 써서 설명적 title 을 담는다. 빈 결과 시 ''. */
function sanitizeLlmSlug(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')      // 영숫자·구분자만(설명문/기호 제거)
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 8).join('-')
    .slice(0, 50).replace(/-+$/g, '');
}

type MissionSlugStream = typeof import('../llm/role-stream.js').streamRoleLlm;

let missionSlugStreamForTest: MissionSlugStream | undefined;

/** Test seam for the LLM boundary used by the production mission slug generator. */
export function setMissionSlugStreamForTest(stream?: MissionSlugStream): void {
  missionSlugStreamForTest = stream;
}

/** ★ 미션 골 → LLM(luna·빠른 모델) 영문 요약 title(대표 지시 2026-07-12: id 만 봐도 뭘 하는지·
 *  시간값 자리를 title 에 양보해 최대한 설명적으로). luna 실패/타임아웃/비어있음 → 휴리스틱
 *  slugify fallback. 미션 생성 경로가 await 로 호출(테스트는 slugFn seam 으로 우회). */
export async function generateMissionSlug(goal: string): Promise<string> {
  const fallback = slugify(extractSlugSource(goal));
  try {
    const stream = missionSlugStreamForTest ?? (await import('../llm/role-stream.js')).streamRoleLlm;
    const prompt =
      'Summarize this mission into an English kebab-case title: lowercase words joined by hyphens, ' +
      'as descriptive as fits within ~50 characters (5-8 words is fine). Capture the core intent; ' +
      'drop filler ("system"/"implement"/"please"). Output ONLY the title, nothing else.\n\n' +
      'Example goal: 대화·기억을 무한히 쌓지 않도록 기억 생애주기(decay·압축·S3 아카이브) 설계·구현\n' +
      'Example title: memory-lifecycle-decay-consolidation-archive\n\n' +
      `Goal: ${goal.slice(0, 600)}\nTitle:`;
    let full = '';
    await stream('planning', [{ role: 'user', content: prompt }], (_d, all) => { full = all; });
    const slug = sanitizeLlmSlug(full);
    return slug || fallback;
  } catch { return fallback; }
}

/** ★ slug 보강 미션 생성 — slug 미지정이면 generateMissionSlug(luna 영문 title)를 await 후
 *  생성. 모든 진입 경로(nexus API·discovery·coordinator·intent-gate)의 id 일관성 단일 창구
 *  (대표 지적 2026-07-14: intent-gate 만 LLM slug 를 태워 나머지 경로가 한글 휴리스틱 id 로
 *  샜다). slugFn = 테스트 seam(luna 우회). */
export async function createMissionWithSlug(
  store: TaskStore, input: MissionInput,
  opts: { slugFn?: (goal: string) => Promise<string> } = {},
): Promise<MissionRow> {
  if (input.slug?.trim()) return createMission(store, input);
  const slug = await (opts.slugFn ?? generateMissionSlug)(input.goal);
  return createMission(store, { ...input, slug });
}

/** apm_<title>_<hash6> — title=사람가독 라벨(LLM 요약 또는 휴리스틱·최대한 설명적),
 *  hash6=골+ISO+salt 유일성. 시간값은 id 에 넣지 않는다(생성시각=createdAt 필드·hash6 가
 *  유일성 보장·대표 2026-07-12). now 는 여전히 hash 입력(분단위 충돌 회피). */
export function mintMissionId(goal: string, now: Date, salt = '', slugOverride?: string): string {
  const h = createHash('sha1').update(`${goal}|${now.toISOString()}|${salt}`).digest('hex').slice(0, 6);
  const slug = slugOverride?.trim() || slugify(extractSlugSource(goal));
  return `apm_${slug}_${h}`;
}

// ── 어댑터 CRUD (TaskStore 백드) ──────────────────────────────────────────

/** apm Mission 스토어 열기 — U1b 이후 TOX tasks.db(TaskStore). */
export function openAutopilotMissionsDb(path?: string): TaskStore {
  return new TaskStore(path ? { path } : {});
}

/** 미션 생성 — 골 진입(triage) 시 1건. 파생물이 이 id 를 심을 뿌리. */
export function createMission(store: TaskStore, input: MissionInput): MissionRow {
  const now = input.now ?? new Date();
  const id = mintMissionId(input.goal, now, '', input.slug);
  const t = input.triage ?? {};
  const init = apmSnapshotToMissionInit({
    id,
    goal: input.goal,
    source: input.source,
    executionModel: t.executionModel,
    domain: t.domain,
    tier: t.tier,
    engine: t.engine,
    rationale: t.rationale,
    confidence: t.confidence,
    status: input.status ?? 'proposed',
    runIds: input.runId ? [input.runId] : undefined,
  });
  const m = createToxMission(init, { now: now.getTime(), id });
  store.saveMission(m);
  // 기본 텔레그램 origin 자동 바인딩(대표 2026-07-16) — 프로그램/operator 제출도 알림이 홈채널로.
  // 텔레그램 intake 는 직후 saveMissionOrigin(실제 발신 채널)로 덮어써 우선(ensure=없을 때만).
  ensureMissionOrigin(id);
  // Ops 관측(P0) — 미션 탄생을 감사로그에 심는다(fail-soft). "왜 이 미션이 생겼나"(source·triage 근거).
  recordOpsEventSafe({
    entityType: 'mission', entityId: id, event: 'created',
    toState: input.status ?? 'proposed', actor: input.source === 'discovery' ? 'triage' : 'manual',
    rationale: t.rationale ?? input.goal.slice(0, 120),
    refs: { source: input.source, executionModel: t.executionModel, domain: t.domain, tier: t.tier, engine: t.engine },
    now: () => now.toISOString(),
  });
  return toMissionRow(m);
}

export function getMission(store: TaskStore, id: string): MissionRow | null {
  const m = store.getMission(id);
  return m ? toMissionRow(m) : null;
}

export interface ListMissionOpts { status?: MissionStatus; source?: MissionSource; limit?: number }
export function listMissions(store: TaskStore, opts: ListMissionOpts = {}): MissionRow[] {
  let rows = store.listMissions().filter(isAutopilotMission);
  // 정규화 비교 — 레거시 저장 'intake' 도 source='human-intent' 필터에 매칭.
  if (opts.source) rows = rows.filter((m) => normalizeMissionSource(m.autopilot?.origin) === opts.source);
  if (opts.status) rows = rows.filter((m) => (m.autopilot?.apmStatus ?? 'proposed') === opts.status);
  rows.sort((a, b) => b.createdAt - a.createdAt); // 최신순(DESC)
  const limit = opts.limit ?? 100;
  return rows.slice(0, limit).map(toMissionRow);
}

export function updateMissionStatus(store: TaskStore, id: string, status: MissionStatus, now: Date = new Date()): void {
  const m = store.getMission(id);
  if (!m) return;
  const prevStatus = m.autopilot?.apmStatus ?? 'proposed';
  const toxStatus = apmStatusToMissionStatus(status);
  const terminal = toxStatus === 'completed' || toxStatus === 'cancelled';
  store.saveMission({
    ...m,
    autopilot: { ...(m.autopilot ?? { origin: 'manual' }), apmStatus: status },
    status: toxStatus,
    updatedAt: now.getTime(),
    closedAt: terminal ? now.getTime() : m.closedAt,
  });
  // Ops 관측(P0) — 상태 전이(proposed→armed→running→done…)를 from/to 로 심는다(fail-soft).
  if (prevStatus !== status) {
    recordOpsEventSafe({
      entityType: 'mission', entityId: id, event: 'status_change',
      fromState: prevStatus, toState: status, actor: 'unknown',
      now: () => now.toISOString(),
    });
  }
}

/** 승인된 materialize spec 저장(command/cron/prompt) — 자율 arming 시 이걸로 자동 실행. */
export function setMissionSpec(store: TaskStore, id: string, spec: { command?: string; cron?: string; prompt?: string }, now: Date = new Date()): void {
  const m = store.getMission(id);
  if (!m) return;
  store.saveMission({
    ...m,
    autopilot: { ...(m.autopilot ?? { origin: 'manual' }), materializeSpec: spec },
    updatedAt: now.getTime(),
  });
}

/** 미션 상세 description 저장 — 외부조사(보강/교정)·분해 페이즈·중복 등 준비 맥락을 레코드에
 *  보존한다(goal 한 줄 너머). se-mission-prepare 가 준비 완료 시 채움 → 이후 회상/추적/재실행에
 *  풍부한 근거 제공(대표 지시 2026-07-12: 상세 description 기록 갭 정정). */
export function setMissionDescription(store: TaskStore, id: string, description: string, now: Date = new Date()): void {
  const m = store.getMission(id);
  if (!m) return;
  store.saveMission({ ...m, description, updatedAt: now.getTime() });
}

/** 미션에 실행 세션(runId) 연결 — 1 미션 : N runId(재시도/재개). 중복 무시. */
export function attachRunId(store: TaskStore, id: string, runId: string, now: Date = new Date()): void {
  const m = store.getMission(id);
  if (!m) return;
  const cur = m.autopilot?.runIds ?? [];
  if (cur.includes(runId)) return;
  store.saveMission({
    ...m,
    autopilot: { ...(m.autopilot ?? { origin: 'manual' }), runIds: [...cur, runId] },
    updatedAt: now.getTime(),
  });
}

// ── coordinator 계층 (2026-07-10 · PLAN-trade-coordinator-mission C0) ──────────
// 조율 미션(coordinator)이 낳은 하위 계약/에이전트 미션을 부모↔자식으로 연결한다.
// 부모엔 childMissionIds, 자식엔 parentMissionId 를 심어 mission-trace 가 fan-in.
// runIds 패턴 그대로 — autopilot 메타에 저장(별 table 없음·중복 무시).

/** 부모 조율 미션에 하위 미션 연결(부모.childMissionIds += · 자식.parentMissionId). 중복 무시. */
export function attachChildMission(store: TaskStore, parentId: string, childId: string, now: Date = new Date()): void {
  if (parentId === childId) return;
  const parent = store.getMission(parentId);
  const child = store.getMission(childId);
  if (!parent || !child) return;
  const cur = parent.autopilot?.childMissionIds ?? [];
  if (!cur.includes(childId)) {
    store.saveMission({
      ...parent,
      autopilot: { ...(parent.autopilot ?? { origin: 'manual' }), childMissionIds: [...cur, childId] },
      updatedAt: now.getTime(),
    });
  }
  if (child.autopilot?.parentMissionId !== parentId) {
    store.saveMission({
      ...child,
      autopilot: { ...(child.autopilot ?? { origin: 'manual' }), parentMissionId: parentId },
      updatedAt: now.getTime(),
    });
  }
  // ★ E2 계보 엣지(미션 생태계 RFC §4.1) — registry 필드(childMissionIds/parentMissionId)에 더해
  //   mission_edges 그래프에도 lineage 를 기록해 4종 관계를 통합 조회·시각화(E4)한다. addMissionEdge
  //   는 자체 fail-soft·비파괴(기존 필드 무손상). 순환 없음(mission-edges=state-paths·sqlite 만 import).
  addMissionEdge(parentId, childId, 'lineage', '파생(attachChildMission)', { now: now.getTime() });
}

/** 조율 미션의 하위 미션 id 목록(없으면 []). */
export function getChildMissionIds(store: TaskStore, id: string): string[] {
  const m = store.getMission(id);
  return m?.autopilot?.childMissionIds ? [...m.autopilot.childMissionIds] : [];
}

/** ★ E3 발견→파생 미션 카빙(미션 생태계 RFC §4.2 · 2026-07-18) — 구현 중 발견한 작업(현 미션 범위 밖·
 *  새 서브골)을 파생 미션(proposed·discovery)으로 이어간다. 완벽한 플랜은 불가하니 구현에서 발견한 것을
 *  휘발시키지 않고 미션으로 승격한다. **자동 실행 아님**(proposed·HITL·대표 승인 후 실행·미션 임의생성
 *  금지 존중). 계보(attachChildMission→lineage 엣지)에 더해 continuation 엣지(발견 흐름·evidence)를
 *  그래프에 남겨 E4 시각화·E5 공진화의 근거로 삼는다. 범위 **내** 발견은 insert-arc(insertArcIntoMission)를
 *  쓰고, 범위 **밖** 발견만 이 창구. 부모 없거나 빈 골이면 null. */
export function carveDiscoveryMission(
  store: TaskStore, parentId: string, discovery: { goal: string; evidence?: string },
  deps: { now?: Date; edgeDb?: import('bun:sqlite').Database } = {},
): string | null {
  const parent = store.getMission(parentId);
  const goal = (discovery.goal ?? '').trim();
  if (!parent || !goal) return null;
  const now = deps.now ?? new Date();
  const child = createMission(store, {
    goal, source: 'discovery', status: 'proposed',
    triage: { rationale: `구현 중 발견(부모 ${parentId})` },
    now,
  });
  attachChildMission(store, parentId, child.id, now); // 계보(lineage) 엣지 자동 기록(E2)
  addMissionEdge(parentId, child.id, 'continuation', (discovery.evidence ?? '구현 중 발견 이어가기').slice(0, 500),
    { now: now.getTime(), ...(deps.edgeDb ? { db: deps.edgeDb } : {}) });
  return child.id;
}
