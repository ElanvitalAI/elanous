// 도구 프로필 — «기본(다이어트) ⊕ 추가 묶음»으로 조립한다 (BACKLOG L1 · 2026-09-25).
//
// 🩸 실측(09-25 node-b 앞 기록 프록시): `self implement` 코딩 자식이 매 턴 도구 56개 · 스키마 59,250자를 실었다
//    (29개가 `finance_*`/`conatus_position` · 몇 개는 운영 도구). 다이어트 뒤 21개 · 25,211자.
//
// ⭐⭐ 대표 09-25: 「다이어트와 별도의 전체 모드 · 이원화하면 스펙이 빠질 위험 · 기본 상태에서 ADD 가 되게」
//    ⇒ 목록은 «하나»(buildCliAgentTools)다. 프로필은 그 목록에서 «추가 묶음»을 빼거나 더할 뿐이다.
//      · `coding`(기본) = 목록 − 모든 추가 묶음
//      · `full`         = 목록 그대로(= 기본 ⊕ 모든 묶음)
//      · 묶음 지정       = 기본 ⊕ 고른 묶음(예: finance 만)
//    ⇒ 어느 모드든 «기본의 상위 집합»이다 — 앞 턴에서 쓴 기본 도구가 모드 때문에 사라지지 않는다(히스토리 안전).
//    ⛔ 새 도구는 목록에만 더하면 된다 — 묶음에 안 넣으면 «기본»으로 간다(두 목록을 따로 맞출 일이 없다).
//
// 켜는 법(부모 env → 구현 자식 spawn 이 `ELANOUS_TOOL_PROFILE` 로 넘긴다):
//   ELANOUS_CHILD_TOOL_PROFILE=full            전부
//   ELANOUS_CHILD_TOOL_PROFILE=finance,ops     기본 ⊕ 고른 묶음
//   (없음)                                   coding(기본)
//
// 🩸 CHILD-TOOL-PROFILE-TRIM(10-10 실측 · base 0317d73034 · Plan 켬): `coding` 이 33개 중 27개(스키마 26,742자)를
//    남겼다 — 판·자리 운영·회수·스킬·서브에이전트 도구가 «어느 묶음에도 안 들어서» 기본으로 갔을 뿐이다.
//    ⇒ 화이트리스트를 따로 두지 않고(09-25 설계 유지) 그것들을 새 묶음 넷(admin · recall · skills · subagent)으로 옮긴다.
//    ⇒ `coding` 의 기대 집합 = Read · Grep · Glob · ListDir · Edit · Write · Bash · Plan · MarkStepDone(9개).
//    빠진 묶음은 상황 신호(골 문면)와 ToolSearch(전체 목록에서 찾는다)로 계속 닿는다.

import { debug } from '../debug/log.js';

/** 추가 묶음 — 코딩 기본에서 빠지고 «고르면 더해지는» 도구들. 접두 ⊕ 정확한 이름. */
export const TOOL_EXTRA_GROUPS = {
  finance: { prefixes: ['finance_', 'conatus_'], names: [] as string[] },
  ops: { prefixes: [] as string[], names: ['schedule_manage', 'session_manage', 'autopilot_missions', 'ops_status', 'se_build', 'mission_decide'] },
  /** 판·자리·결정 운영 — 코딩 일에는 안 쓴다. */
  admin: { prefixes: ['release_'], names: ['coo_admin', 'ops_seats', 'decisions_pending', 'proact_meter'] },
  /** 기억·회수·관측 조회. */
  recall: { prefixes: [] as string[], names: ['memory_recall', 'fact_check', 'self_recall', 'context_now', 'logs_query'] },
  /** 스킬 목록·실행. */
  skills: { prefixes: [] as string[], names: ['elanous_skills_list', 'skill_exec'] },
  /** 서브에이전트 — ⚠️ 기본에서 빼도 완주율이 안 떨어지는지는 아직 안 쟀다(SMALL-MODEL-BENCH 가 잰다). 신호·ToolSearch 로 되살린다. */
  subagent: { prefixes: [] as string[], names: ['Agent', 'AgentOutput', 'AgentReply', 'AgentStop', 'AgentList'] },
} as const;
export type ToolExtraGroup = keyof typeof TOOL_EXTRA_GROUPS;
const ALL_GROUPS = Object.keys(TOOL_EXTRA_GROUPS) as ToolExtraGroup[];

/** 해석된 프로필 = 더할 묶음의 집합. coding = 빈 집합 · full = 전부. */
export interface ToolProfile { name: string; groups: ReadonlySet<ToolExtraGroup> }

export function parseToolProfile(raw: string | undefined): ToolProfile | null {
  const v = raw?.trim();
  if (!v) return null;
  if (v === 'coding') return { name: 'coding', groups: new Set() };
  if (v === 'full') return { name: 'full', groups: new Set(ALL_GROUPS) };
  const groups = v.split(',').map((g) => g.trim()).filter((g): g is ToolExtraGroup => (ALL_GROUPS as string[]).includes(g));
  return groups.length ? { name: groups.join(','), groups: new Set(groups) } : { name: 'coding', groups: new Set() };
}

export function activeToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile | null {
  return parseToolProfile(env.ELANOUS_TOOL_PROFILE);
}

/** «상황» 신호 — 골 문면이 그 묶음의 «일»을 말하면 더한다(대표 09-25 「config 가 아니라 상황별로」).
 *  ⛔ 틀려도 «더하는» 쪽으로만 틀린다(도구가 늘 뿐 사라지지 않는다) — 그래서 넓게 잡는다. */
export const SITUATIONAL_GROUP_SIGNALS: Record<ToolExtraGroup, RegExp> = {
  finance: /금융|주식|종목|주가|시세|매매|포트폴리오|포지션|투자|백테스트|13F|재무|finance_|conatus|stock|ticker|portfolio|backtest|trading/i,
  ops: /스케줄|크론|예약 실행|오토파일럿|미션 결정|운영 상태|schedule_manage|autopilot|ops_status|mission_decide|cron/i,
  admin: /release_(status|change)|coo_admin|ops_seats|decisions_pending|proact_meter|판 칸|칸 근거|칸 상태|체크리스트 칸|checklist (set|status)|결정 대기|자리 현황/i,
  recall: /memory_recall|fact_check|self_recall|context_now|logs_query|기억 조회|기억을 (찾|조회|회수)|자기 이력|사실 확인|팩트 ?체크/i,
  skills: /elanous_skills_list|skill_exec|스킬(을)? 실행|스킬 목록|run (a|the) skill/i,
  subagent: /서브\s?에이전트|하위\s?에이전트|sub-?agents?|에이전트를 (띄|병렬)|병렬 에이전트|Agent(Output|Reply|Stop|List)\b|Agent 도구/i,
};

export function situationalToolGroups(goalText: string | undefined): ToolExtraGroup[] {
  if (!goalText) return [];
  return ALL_GROUPS.filter((g) => SITUATIONAL_GROUP_SIGNALS[g].test(goalText));
}

/** 구현 자식 spawn 이 넘길 값.
 *  ① 부모 env `ELANOUS_CHILD_TOOL_PROFILE`(full · 묶음 · coding)이 있으면 그것 — 런 단위 명시가 이긴다
 *  ② 없으면 골 문면의 상황 신호로 묶음을 «더한다»
 *  ③ 둘 다 없으면 `coding`(다이어트) */
export function childToolProfile(env: NodeJS.ProcessEnv = process.env, goalText?: string): string {
  const explicit = env.ELANOUS_CHILD_TOOL_PROFILE?.trim();
  if (explicit) {
    const parsed = parseToolProfile(explicit);
    debug.log('agent.tool-profile', 'child-profile-chosen', { source: 'env', raw: explicit, profile: parsed?.name ?? 'coding', groups: parsed ? [...parsed.groups] : [] });
    return explicit;
  }
  const groups = situationalToolGroups(goalText);
  const profile = groups.length ? groups.join(',') : 'coding';
  debug.log('agent.tool-profile', 'child-profile-chosen', { source: groups.length ? 'situational' : 'default', profile, groups, goalChars: goalText?.length ?? 0 });
  return profile;
}

/** 기본 모드에서 뺀 묶음을 자식에게 «한 줄»로 알린다 — 필요하면 ToolSearch 로 불러 쓴다(스키마는 안 싣는다). */
export function omittedToolGroupsNote(removed: readonly string[]): string | null {
  if (removed.length === 0) return null;
  const byGroup = new Map<string, string[]>();
  for (const n of removed) { const g = toolGroupOf(n) ?? 'other'; byGroup.set(g, [...(byGroup.get(g) ?? []), n]); }
  const parts = [...byGroup].map(([g, ns]) => `${g}(${ns.length}: ${ns.slice(0, 4).join(', ')}${ns.length > 4 ? ', …' : ''})`);
  return `[추가 도구 묶음] 이 런은 기본 도구만 실었다. 빠진 묶음: ${parts.join(' · ')}. 일에 필요하면 ToolSearch 로 query 를 묶음 이름(예: "finance")이나 "select:<도구 이름>" 으로 불러 쓴다.`;
}

export function toolGroupOf(name: string): ToolExtraGroup | null {
  for (const g of ALL_GROUPS) {
    const def = TOOL_EXTRA_GROUPS[g];
    if (def.prefixes.some((p) => name.startsWith(p)) || (def.names as readonly string[]).includes(name)) return g;
  }
  return null;
}

/** 기본 ⊕ 고른 묶음. 묶음에 안 든 도구는 늘 남는다(= 기본). */
export function applyToolProfile<T extends { name: string }>(
  tools: T[] | undefined,
  profile: ToolProfile | null,
): { tools: T[] | undefined; removed: string[] } {
  if (!tools || !profile) return { tools, removed: [] };
  const removed: string[] = [];
  const kept = tools.filter((t) => {
    const g = toolGroupOf(t.name);
    if (g === null || profile.groups.has(g)) return true;
    removed.push(t.name);
    return false;
  });
  return { tools: kept, removed };
}
