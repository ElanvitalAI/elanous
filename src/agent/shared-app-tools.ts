// 공통 앱 tool 단일 조립기 — turn 조립기 통일 Phase 0 (2026-07-22)
//
// 종전 3 조립기(telegram makeElanousAgentRunTurn · CLI buildCliAgentTools · daemon toolSurface)가
// L2 core(schedule_manage·memory_recall…) + L3 finance(코나투스 25종)를 **각자 조립**하던 파편화의
// 첫 단일화. 이 둘은 이미 단일 출처(core-tools.ts·finance-tools.ts)이나 조립을 3곳이 반복 → 서피스
// 게이팅 정리(#5080)에서 finance 를 3곳에 수동 배선한 게 바로 그 증상. 여기 한 곳으로 모은다.
//
// ⚠️ 코딩 코어(Read/Grep/Edit/Write)는 여기 없다 — (a)/(b)=skills/tools(file_path 스키마)·(c)=daemon-tools
//    (path 스키마+deny-list)로 물리 다른 구현이라 병합은 별도 아크(Phase 4). 여기는 서피스-무관 앱 tool 만.
//
// 반환 shape = {specs, names, dispatch} — buildCoreTools/buildFinanceTools 와 동형(drop-in). finance 는
//   financeEnabled(cfg) 게이트(operator opt-in·미enable/미cfg 시 core 만·무회귀).

import { buildCoreTools } from '../domains/core-tools.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { buildFinanceTools } from '../domains/finance-tools.js';
import { financeEnabled } from '../domains/finance.js';
import { skillExecRuntime } from '../tool-runtime/skill-exec-runtime.js';
import type { SkillExecArgs } from '../tool-runtime/skill-exec-runtime.js';
import { buildElanousSkillsListTool, dispatchElanousSkillsList } from '../tool-runtime/elanous-skills-list-runtime.js';
import type { ElanousSkillsListArgs } from '../tool-runtime/elanous-skills-list-runtime.js';
import type { UserConfig } from '../user-config.js';
import type { LLMToolSpec } from '../llm.js';

export interface SharedAppTools {
  specs: LLMToolSpec[];
  names: Set<string>;
  dispatch: (name: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
}

/** L2 core + L3 finance(gated) + skill discovery/execution 단일 조립. specs 순서 = core, finance, discovery, execution. */
export function buildSharedAppTools(cfg?: UserConfig): SharedAppTools {
  const core = buildCoreTools();
  const fin = cfg && financeEnabled(cfg) ? buildFinanceTools() : null;
  const skillsList = buildElanousSkillsListTool();
  const skill = skillExecRuntime;
  const specs: LLMToolSpec[] = [...core.specs, ...(fin ? fin.specs : []), skillsList, skill.spec];
  const names = new Set<string>([...core.names, ...(fin ? fin.names : []), skillsList.name, skill.id]);
  // context(B5) — 기억 조회 같은 긴 코어 도구가 진행 한 줄(emitFeedback)을 낼 수 있게 코어까지 넘긴다.
  const dispatch = async (name: string, args: Record<string, unknown>, context?: ToolRuntimeContext): Promise<unknown> =>
    name === skillsList.name ? dispatchElanousSkillsList(args as ElanousSkillsListArgs) :
      name === skill.id ? skill.run(args as unknown as SkillExecArgs, { surface: 'skill' }) :
        fin && fin.names.has(name) ? fin.dispatch(name, args) : core.dispatch(name, args, undefined, context);
  return { specs, names, dispatch };
}
