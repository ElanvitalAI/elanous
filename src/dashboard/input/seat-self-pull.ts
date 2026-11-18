// ── 계획이 비면 자기 칸에서 다음 일 집기 `seat-self-pull` (SEAT-SELF-PULL · P0 · 2026-11-17) ─────────────
//
// 🚨 무엇을 푸는가: 장기 자리가 받은 일을 다 끝내면(우편 0 · 큐 0 · 계획 0) 그대로 논다. 자리에는 자기
//   소유 칸(release checklist owner)과 WORK-QUEUE 가 남아 있어도, 사람이 «다음 칸» 을 쳐 줘야 움직였다
//   (OP PLAN-PROACTIVE-1117 §2 · ASK-LONG-SEAT-MODE-PROACTIVE-1117 §1).
// ⭐ 이 모듈 = 순수 선택기(`pickNextSelfWork`) ⊕ 작은 컨트롤러(`createSeatSelfPull`).
//   선택기는 «자리 · 계획이 비었나 · 소유 칸 · WORK-QUEUE 항목»을 받아 하나를 집거나, 왜 못 집었는지를 타입으로 낸다.
//   컨트롤러는 «남은 일 없음» 순간(autowake 의 nothing-pending · PLAN-WIRE-SEAT 의 계획 비움)에 불려
//   집은 일을 넘기고(handOff) · OP 에 한 줄 우편 · `seat.self-pull` 관측을 남긴다.
// ⛔ 다른 층을 자동으로 바꾸지 않는다(내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG` §6 «세 층»):
//   계획 목록에는 «비었을 때 새 항목 하나를 넣는 것»만 한다 — 기존 항목 개정·취소·대체 0(불변식 10).
//   체크리스트·WORK-QUEUE·handed·traffic 은 읽기만 한다(claim 0 · 상태 전이 0).
// ⛔ 기본 꺼짐: 자리마다 `~/elanous-hq/seat-state/<자리>/self-pull` 일반 파일이 있을 때만(autowake 와 같은 꼴).
//
// 세 얼굴:
//   관측 = debug.log('seat.self-pull', 'decided', { outcome: picked|none, reason, cellId, seat, … })
//          — 같은 none(사유·칸)이 연달아 나면 한 번만 남긴다.
//   판단 근거 = 계획 비움 ∧ 소유(주인 = 이 자리) ∧ 열림(yellow·red / WORK-QUEUE 열린 상태) ∧ hold·handed 아님
//          ∧ 남의 점유 아님 ∧ 선행 칸 끝남(모르면 막힘) ∧ 쿨다운·창 상한 안 → 우선순위 → 나이 → 출처 순서 → id.
//   수복과 인계 = 집으면 handOff(계획 층 또는 H2 내부 턴) ⊕ OP 우편 한 줄(쿨다운 안 재공지 0) ·
//          못 집으면 타입 사유만 남기고 조용히 멈춘다(사람·OP 는 `eln logs --category seat.self-pull` 로 본다).

import { debug } from '../../debug/log.js';
import type { DecomposedTask, DecomposePriority } from './seat-task-decompose.js';
import { DEFAULT_AUTOWAKE_CONSECUTIVE_CAP } from './seat-autowake.js';

export const SEAT_SELF_PULL_FILE = 'self-pull';

/**
 * 같은 칸을 다시 집거나 다시 알리기 전 쉬는 시간 ⊕ 상한을 세는 창.
 * 출처: OP PLAN-PROACTIVE-1117 §4 «OP 의 30분 손 점검» — OP 점검 한 번에 같은 칸 공지는 한 번이면 된다.
 */
export const SELF_PULL_COOLDOWN_MS = 30 * 60_000;
/** 출처: 위와 같은 30분 OP 점검 창(창 하나에 상한을 센다). */
export const SELF_PULL_WINDOW_MS = SELF_PULL_COOLDOWN_MS;
/** 창 하나에서 스스로 집는 최대 횟수. 출처: seat-autowake `DEFAULT_AUTOWAKE_CONSECUTIVE_CAP`(사람 입력 없이 연속 자동 턴 상한). */
export const SELF_PULL_WINDOW_CAP = DEFAULT_AUTOWAKE_CONSECUTIVE_CAP;

// ── 계약 ─────────────────────────────────────────────────────────────────────────────

export type SelfPullSource = 'checklist' | 'work-queue';

export interface SelfPullCandidate {
  source: SelfPullSource;
  /** 칸 id(체크리스트) 또는 WORK-QUEUE 항목 id. */
  id: string;
  title: string;
  /** 주인(«TC» · «TC/rel» 꼴) — 모르면 null(=남의 것으로 본다). */
  owner: string | null;
  /** 열린 일인가(체크리스트 yellow·red · WORK-QUEUE 열린 상태). */
  open: boolean;
  /** 우선순위 등급 — 작을수록 먼저. 없으면 null(맨 뒤). 체크리스트 P0=0·P1=1·P2=2 · TSV priority 숫자 그대로. */
  rank: number | null;
  /** 나이 기준 시각(ms) — 오래된 것 먼저. 모르면 null(맨 뒤). */
  addedAt: number | null;
  /** 출처 안 순서(파일 줄 순서 등) — 같은 등급·나이일 때. */
  ordinal: number;
  /** 선행 칸 — 모두 «끝남»이 확인돼야 집는다. */
  predecessors: readonly string[];
  /** 다른 손의 점유 표시(WORK-QUEUE claimed 등). null/없음 = 점유 없음. */
  claimedBy?: string | null;
  /** 출처가 «막힘»으로 적은 일(WORK-QUEUE blocked). */
  blocked?: boolean;
  /** 사람이 읽는 출처 한 줄(«checklist 0.3.28» · «WORK-QUEUE-1117.md»). */
  origin?: string;
}

export type SelfPullExclusion = 'foreign' | 'not-open' | 'hold' | 'handed' | 'claimed' | 'blocked' | 'predecessor';

export type SelfPullNoneReason =
  | 'disabled'
  | 'work-unknown'
  | 'plan-not-empty'
  | 'source-unreadable'
  | 'held'
  | 'cap'
  | 'nothing-owned'
  | 'all-blocked'
  | 'cooldown';

export interface SelfPullRecentPick { id: string; at: number }

export interface SelfPullInput {
  seat: string;
  /** 계획 목록이 비었나(종결 아닌 항목 0). */
  planEmpty: boolean;
  candidates: readonly SelfPullCandidate[];
  /** traffic.json hold 목록. */
  hold: ReadonlySet<string>;
  /** feeder handed 원장. */
  handed: ReadonlySet<string>;
  /** 선행 칸이 끝났나 — true 끝남 · false 열림 · null 모름(모름 = 막힘). */
  isDone: (id: string) => boolean | null;
  /** traffic 신호가 집기를 막을 때 그 사유(global≠green · 자리 정지 · 못 읽음). 없으면 열림. */
  signalStop?: string | null;
  recentPicks: readonly SelfPullRecentPick[];
  now: number;
  cooldownMs?: number;
  windowMs?: number;
  windowCap?: number;
}

export interface SelfPullExcluded { id: string; why: SelfPullExclusion }

export type SelfPullDecision =
  | { outcome: 'picked'; seat: string; item: SelfPullCandidate; reason: string; excluded: SelfPullExcluded[] }
  | { outcome: 'none'; seat: string; reason: SelfPullNoneReason; cellId: string | null; detail?: string; excluded: SelfPullExcluded[] };

// ── 순수 선택기 ───────────────────────────────────────────────────────────────────────

/** «TC/rel» → «TC». 비었으면 null. */
export function ownerSeat(owner: string | null | undefined): string | null {
  const seat = owner?.split('/')[0]?.trim().toUpperCase();
  return seat ? seat : null;
}

/** 결정론 순서: 등급 → 나이 → 출처 순서 → 출처(checklist 먼저) → id. 모르는 등급·나이는 맨 뒤. */
export function compareSelfPullCandidates(a: SelfPullCandidate, b: SelfPullCandidate): number {
  const rank = (c: SelfPullCandidate) => c.rank ?? Number.POSITIVE_INFINITY;
  const age = (c: SelfPullCandidate) => c.addedAt ?? Number.POSITIVE_INFINITY;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  if (age(a) !== age(b)) return age(a) < age(b) ? -1 : 1;
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  if (a.source !== b.source) return a.source === 'checklist' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function pickReason(item: SelfPullCandidate, seat: string): string {
  const rank = item.rank === null ? '등급 없음' : item.source === 'checklist' ? `P${item.rank}` : `우선 ${item.rank}`;
  return `${item.origin ?? item.source} · ${rank} · 주인 ${seat}`;
}

export function pickNextSelfWork(input: SelfPullInput): SelfPullDecision {
  const seat = input.seat.trim().toUpperCase();
  const excluded: SelfPullExcluded[] = [];
  const none = (reason: SelfPullNoneReason, cellId: string | null = null, detail?: string): SelfPullDecision =>
    ({ outcome: 'none', seat, reason, cellId, ...(detail ? { detail } : {}), excluded });
  if (!input.planEmpty) return none('plan-not-empty');
  if (input.signalStop) return none('held', null, input.signalStop);
  const cooldownMs = input.cooldownMs ?? SELF_PULL_COOLDOWN_MS;
  const windowMs = input.windowMs ?? SELF_PULL_WINDOW_MS;
  const cap = input.windowCap ?? SELF_PULL_WINDOW_CAP;
  const inWindow = input.recentPicks.filter(p => input.now - p.at < windowMs);
  if (inWindow.length >= cap) return none('cap', inWindow.at(-1)?.id ?? null, `${inWindow.length}/${cap}`);

  // 소유 ∧ 열림 — 남의 칸은 어떤 출처에서 와도 집지 않는다.
  const ownedOpen: SelfPullCandidate[] = [];
  for (const c of input.candidates) {
    if (ownerSeat(c.owner) !== seat) { excluded.push({ id: c.id, why: 'foreign' }); continue; }
    if (!c.open) { excluded.push({ id: c.id, why: 'not-open' }); continue; }
    ownedOpen.push(c);
  }
  if (ownedOpen.length === 0) return none('nothing-owned');

  const blocked: SelfPullExcluded[] = [];
  const eligible: SelfPullCandidate[] = [];
  for (const c of ownedOpen) {
    const why: SelfPullExclusion | null = input.hold.has(c.id) ? 'hold'
      : input.handed.has(c.id) ? 'handed'
        : c.claimedBy && ownerSeat(c.claimedBy) !== seat ? 'claimed'
          : c.blocked ? 'blocked'
          : c.predecessors.some(p => input.isDone(p) !== true) ? 'predecessor'
            : null;
    if (why) blocked.push({ id: c.id, why });
    else eligible.push(c);
  }
  excluded.push(...blocked);
  // 한 출처라도 막았으면(hold·선행·점유 …) 다른 출처의 같은 id 도 집지 않는다 — 가장 조심스러운 쪽.
  const blockedIds = new Set(blocked.map(b => b.id));
  for (let i = eligible.length - 1; i >= 0; i--) if (blockedIds.has(eligible[i]!.id)) eligible.splice(i, 1);
  if (eligible.length === 0) {
    const onlyHeld = blocked.every(b => b.why === 'hold' || b.why === 'handed');
    return none(onlyHeld ? 'held' : 'all-blocked', blocked[0]?.id ?? null);
  }
  // 같은 id 가 두 출처에 있으면 앞선 하나만(체크리스트 칸을 WORK-QUEUE 가 다시 가리키는 꼴).
  const ordered = [...eligible].sort(compareSelfPullCandidates)
    .filter((c, i, all) => all.findIndex(o => o.id === c.id) === i);
  // 쿨다운 안에 집은 일이 아직 열려 있으면 그 일을 하는 중으로 본다 — 다른 칸으로 건너뛰지 않는다.
  const inflight = input.recentPicks.filter(p => input.now - p.at < cooldownMs)
    .find(p => ordered.some(c => c.id === p.id));
  if (inflight) return none('cooldown', inflight.id);
  const item = ordered[0]!;
  return { outcome: 'picked', seat, item, reason: pickReason(item, seat), excluded };
}

// ── 문면 ─────────────────────────────────────────────────────────────────────────────

/** OP 우편 한 줄. */
export function formatSelfPullMail(seat: string, item: SelfPullCandidate, reason: string): string {
  return `[자기 집기] ${seat} 계획이 비어 다음 일을 집었다: ${item.id} «${oneLine(item.title)}» (${reason})`;
}

/** 계획 층이 없을 때 H2 내부 턴에 넣는 지시 한 줄. */
export function formatSelfPullPrompt(seat: string, item: SelfPullCandidate, reason: string): string {
  return `[자기 집기] 계획·우편·큐가 비어 ${seat} 소유 칸에서 다음 일을 집었다: ${item.id} «${oneLine(item.title)}» (${reason}) `
    + '— 칸 문면을 읽고 진행 · 끝나면 근거와 함께 닫고 OP 에 한 줄 · 사람이 필요하면 그 사유를 한 줄로';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ── 계획 층 이음매(PLAN-WIRE-SEAT 용) ─────────────────────────────────────────────────

const TERMINAL_PLAN = new Set<DecomposedTask['status']>(['done', 'cancelled', 'superseded']);

/** 계획이 비었나 — 종결(done·cancelled·superseded) 아닌 항목이 0. */
export function isPlanEmpty(tasks: readonly Pick<DecomposedTask, 'status'>[]): boolean {
  return tasks.every(t => TERMINAL_PLAN.has(t.status));
}

/** 집은 일을 계획 항목 하나로(새 항목 · queued · 원문 = 우편 문면). seq 는 계획의 다음 번호. */
export function selfPullPlanTask(seat: string, item: SelfPullCandidate, reason: string, seq: number): DecomposedTask {
  const priority: DecomposePriority = item.rank === 0 ? 'p0' : 'normal';
  const text = formatSelfPullMail(seat, item, reason);
  return {
    id: `self-pull:${item.id}`,
    seq,
    title: `${item.id} «${oneLine(item.title)}»`,
    priority,
    deps: [],
    sourceRequestId: `self-pull:${item.id}`,
    sourceText: text,
    status: 'queued',
    targets: [item.id],
  };
}

// ── 컨트롤러 ─────────────────────────────────────────────────────────────────────────

export interface SelfPullSources {
  candidates: SelfPullCandidate[];
  hold: ReadonlySet<string>;
  handed: ReadonlySet<string>;
  isDone: (id: string) => boolean | null;
  signalStop?: string | null;
}

export interface SelfPullNoWorkContext {
  seat: string;
  /** autowake 가 본 안 읽은 우편 수 — null = 원장 모름(그땐 집지 않는다). */
  unread: number | null;
  queue: number | null;
}

export type SelfPullHandOffResult = { accepted: true } | { accepted: false; detail: string };

export interface SeatSelfPullDeps {
  /** 자리 opt-in(`self-pull` 파일). */
  isEnabled: (seat: string) => boolean;
  /** 계획이 비었나 — null = 계획 층이 아직 안 배선됨(autowake 가 «남은 일 없음»이라 했으니 빈 것으로 본다). */
  planEmpty?: () => boolean | null;
  gather: (seat: string, now: number) => SelfPullSources;
  /** 집은 일을 넘긴다(계획 층 enqueue 또는 H2 내부 턴). 받아들여졌을 때만 쿨다운·우편이 남는다. */
  handOff: (decision: Extract<SelfPullDecision, { outcome: 'picked' }>) => SelfPullHandOffResult;
  /** OP 우편 한 줄. */
  postToOp: (seat: string, line: string) => void;
  now?: () => number;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  cooldownMs?: number;
  windowMs?: number;
  windowCap?: number;
}

export interface SeatSelfPullController {
  /** «남은 일 없음» 순간에 부른다. 결정을 돌려준다(시험·관측용). */
  onNoWorkLeft(ctx: SelfPullNoWorkContext): SelfPullDecision & { handedOff?: boolean; mailed?: boolean };
}

export function createSeatSelfPull(deps: SeatSelfPullDeps): SeatSelfPullController {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  const cooldownMs = deps.cooldownMs ?? SELF_PULL_COOLDOWN_MS;
  const windowMs = deps.windowMs ?? SELF_PULL_WINDOW_MS;
  const recentPicks: SelfPullRecentPick[] = [];
  const announcedAt = new Map<string, number>();
  let lastNoneKey: string | null = null;

  const record = (decision: SelfPullDecision, extra: Record<string, unknown> = {}): void => {
    const cellId = decision.outcome === 'picked' ? decision.item.id : decision.cellId;
    if (decision.outcome === 'none') {
      const key = `${decision.reason}|${cellId ?? '-'}`;
      if (key === lastNoneKey) return; // 같은 none 연달아 = 한 줄만
      lastNoneKey = key;
    } else lastNoneKey = null;
    try {
      log('seat.self-pull', 'decided', {
        seat: decision.seat, outcome: decision.outcome, reason: decision.reason, cellId,
        ...(decision.outcome === 'none' && decision.detail ? { detail: decision.detail } : {}),
        excluded: decision.excluded.length, ...extra,
      });
    } catch { /* 관측 실패가 자리를 막지 않는다 */ }
  };

  return {
    onNoWorkLeft(ctx) {
      const seat = ctx.seat.trim().toUpperCase();
      // opt-in 아니면 아무것도 읽지 않고 남기지 않는다(지금 도는 자리 비용 0).
      if (!deps.isEnabled(seat)) return { outcome: 'none', seat, reason: 'disabled', cellId: null, excluded: [] };
      const t = now();
      if (ctx.unread === null) {
        const d: SelfPullDecision = { outcome: 'none', seat, reason: 'work-unknown', cellId: null, excluded: [] };
        record(d);
        return d;
      }
      const planEmpty = deps.planEmpty?.() ?? true;
      let sources: SelfPullSources;
      try { sources = deps.gather(seat, t); }
      catch (error) {
        const d: SelfPullDecision = { outcome: 'none', seat, reason: 'source-unreadable', cellId: null,
          detail: String(error).slice(0, 200), excluded: [] };
        record(d);
        return d;
      }
      // 오래된 기록은 버린다(창·쿨다운 중 긴 쪽까지만 필요).
      const keep = Math.max(cooldownMs, windowMs);
      while (recentPicks.length > 0 && t - recentPicks[0]!.at >= keep) recentPicks.shift();
      const decision = pickNextSelfWork({
        seat, planEmpty, ...sources, recentPicks, now: t,
        cooldownMs, windowMs, ...(deps.windowCap !== undefined ? { windowCap: deps.windowCap } : {}),
      });
      if (decision.outcome === 'none') { record(decision); return decision; }
      let handed: SelfPullHandOffResult;
      try { handed = deps.handOff(decision); }
      catch (error) { handed = { accepted: false, detail: String(error).slice(0, 200) }; }
      if (!handed.accepted) {
        // 넘기지 못하면 집은 것이 아니다 — 쿨다운·우편 0 · 다음 «남은 일 없음»에서 다시 잰다.
        lastNoneKey = null;
        record(decision, { handedOff: false, handOffDetail: handed.detail });
        return { ...decision, handedOff: false, mailed: false };
      }
      recentPicks.push({ id: decision.item.id, at: t });
      let mailed = false;
      const last = announcedAt.get(decision.item.id);
      if (last === undefined || t - last >= cooldownMs) {
        try {
          deps.postToOp(seat, formatSelfPullMail(seat, decision.item, decision.reason));
          announcedAt.set(decision.item.id, t);
          mailed = true;
        } catch (error) {
          try { log('seat.self-pull', 'mail-failed', { seat, cellId: decision.item.id, error: String(error).slice(0, 200) }); } catch { /* fail-soft */ }
        }
      }
      record(decision, { handedOff: true, mailed });
      return { ...decision, handedOff: true, mailed };
    },
  };
}
