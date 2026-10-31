// 하니스 skill 선택 — luna 의미매칭 주경로 (트랙 S1 · 2026-07-21)
//
// PLAN-execution-cycle-harness-expansion §트랙 S1 / §1c 교훈. 기존 execHarnessSkill(skill-exec.ts)은
// **substring 게이트**(detectSkillTrigger)만 써서 영어term↔한글 description·오타·동의어에 취약(1c #4839:
// "digram" 오타로 diagram-master 미스·2개→5~7개). 이 셀렉터는 **luna 의미매칭(pickSkillsViaLlm)을 주경로**로
// allowlist 실행형 skill 을 고르고, luna 무결과·실패 시 substring(execHarnessSkill)로 폴백한다("luna 주경로·
// 키워드 fallback" 불변식). 실행 격리(withResearchIsolation)·allowlist·fail-soft 는 execHarnessSkill 과 동일 규율 재사용.
//
// ⚠️ ground seam(groundMissionInCodebase)도 luna 를 1회 돌린다(skillFacts) — 이 셀렉터의 luna 는 **실행 선택**용
//    (grounding facts 와 목적이 다름). 둘 다 budgetModel(경량)이고 skillExec 은 gated 경로라 중복 비용 미미.
//    후속 최적화(ground 픽 재사용으로 1회화)는 S4/S5 정련 대상.
//
// ★ 제1원칙 관측(S4 carry 검증·PLAN S5) — 선택(when)·경로(luna/substring)·실행(carry)을 debug.log('harness.skill').
//   조회: elanous logs --category harness.skill.

import { pickSkillsViaLlm } from '../autopilot/mission-codebase-gate.js';
import { getSkillIndex } from '../skills/index.js';
import type { SkillIndexEntry } from '../skills/index.js';
import { invokeResearch } from '../research-bridge/invoke.js';
import { HARNESS_EXEC_ALLOWLIST, execHarnessSkill, type SkillExecResult } from './skill-exec.js';
import { debug } from '../debug/log.js';

export interface HarnessSkillSelection extends SkillExecResult {
  /** 선택 경로 — luna=의미매칭 주경로, substring=결정론 fallback. */
  source: 'luna' | 'substring';
  /** luna 가 고른 전체 skill 이름(S4 carry 관측). substring 폴백이거나 luna 무결과면 []. */
  picked: string[];
}

type InvokeFn = (objective: string, skill: string) => Promise<{ ok: boolean; output: string }>;

export interface SelectHarnessSkillDeps {
  /** skill 인덱스(테스트 우회·기본 getSkillIndex). */
  index?: readonly SkillIndexEntry[];
  /** luna 매칭 seam(테스트 우회·기본 pickSkillsViaLlm). null=실패(→fallback)·[]=관련없음. */
  pickSkills?: (goal: string, index: SkillIndexEntry[], limit: number) => Promise<string[] | null>;
  /** skill 실행기(격리·기본 invokeResearch). */
  invoke?: InvokeFn;
  /** substring fallback(테스트 우회·기본 execHarnessSkill). */
  execFallback?: (objective: string, index: readonly SkillIndexEntry[], invoke?: InvokeFn, allowlist?: ReadonlySet<string>) => Promise<SkillExecResult | null>;
  /** luna 상위 N(기본 8). */
  limit?: number;
  /** S2 — 자동실행 allowlist(config 확장 주입·기본 HARNESS_EXEC_ALLOWLIST). luna 픽·substring 폴백 양쪽에 적용. */
  allowlist?: ReadonlySet<string>;
}

const observe = (event: string, data: Record<string, unknown>): void => {
  try { debug.log('harness.skill', event, data); } catch { /* fail-soft */ }
};

const errMsg = (e: unknown): string => String((e as { message?: string })?.message ?? e).slice(0, 120);

/**
 * objective 에 관련한 **실행형 allowlist skill** 을 고른다 — luna 의미매칭이 주경로, 실패/무결과면 substring fallback.
 * 반환은 execHarnessSkill 과 동형({skill, output}) + source/picked 이라 하니스 skillExec seam 에 그대로 배선 가능.
 */
export async function selectHarnessSkill(
  objective: string,
  deps: SelectHarnessSkillDeps = {},
): Promise<HarnessSkillSelection | null> {
  if (!objective.trim()) return null;
  let index: SkillIndexEntry[];
  try { index = (deps.index ?? getSkillIndex()) as SkillIndexEntry[]; } catch { return null; }
  if (!index.length) return null;
  const invoke: InvokeFn = deps.invoke ?? ((obj, skill) => invokeResearch(obj, { skill }).then((r) => ({ ok: r.ok, output: r.output })));
  const allowlist = deps.allowlist ?? HARNESS_EXEC_ALLOWLIST;   // S2 — config 확장 주입(기본 승인 목록·무회귀)

  // 1) luna 의미매칭(주경로) — allowlist ∩ luna픽 을 격리 실행. null=luna 실패(→fallback)·[]=관련없음(fallback 도 시도).
  let picked: string[] = [];
  try {
    const lunaPick = await (deps.pickSkills ?? pickSkillsViaLlm)(objective, index, deps.limit ?? 8);
    if (lunaPick && lunaPick.length) {
      picked = lunaPick;
      const execName = lunaPick.find((n) => allowlist.has(n));
      if (execName) {
        try {
          const r = await invoke(objective, execName);
          if (r.ok && r.output.trim()) {
            observe('select', { source: 'luna', executed: execName, picked: lunaPick.slice(0, 8) });
            return { skill: execName, output: r.output, source: 'luna', picked: lunaPick };
          }
          observe('luna-exec-empty', { skill: execName });
        } catch (e) { observe('luna-exec-failed', { skill: execName, error: errMsg(e) }); }
      } else {
        observe('luna-no-allowlist', { picked: lunaPick.slice(0, 8) });   // luna 픽이 실행 가능 allowlist 밖 → substring 시도
      }
    }
  } catch (e) { observe('luna-failed', { error: errMsg(e) }); }

  // 2) substring fallback(결정론·무회귀) — 기존 execHarnessSkill 게이트(unambiguous+score≥2+명시트리거+allowlist).
  try {
    const sub = await (deps.execFallback ?? execHarnessSkill)(objective, index, invoke, allowlist);
    if (sub) {
      observe('select', { source: 'substring', executed: sub.skill, picked: picked.slice(0, 8) });
      return { ...sub, source: 'substring', picked };
    }
  } catch (e) { observe('substring-failed', { error: errMsg(e) }); }

  observe('none', { lunaPicked: picked.length });
  return null;
}
