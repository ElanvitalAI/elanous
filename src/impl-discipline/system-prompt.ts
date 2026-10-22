// Phase-gated implementation-discipline system prompt.
//
// Emits 0 or 1 system message per turn, selected by the detector.
// Skipped entirely when plan-mode is active — plan-mode's own
// 4-phase system prompt already supersedes this guidance and the
// overlap would be noisy / potentially contradictory.

import type {
  NativeToolCatalogEntry,
  NativeToolKind,
} from '../native-tool-catalog.js';
import { detectImplPhase } from './detector.js';
import type { DetectInput, ImplPhase } from './types.js';

const PLAN_LOADED_PROMPT = `# 플랜/핸드오프 문서 참조 감지

사용자가 PLAN/HANDOFF/SPEC 문서를 참조했습니다. 구현을 시작하기 전 다음을 지키세요.

1. 먼저 Read 로 문서 전체를 읽으세요 (offset/limit 없이).
2. 2~3줄로 요지(목표·범위·개방된 결정) 를 정리해 사용자에게 제시.
3. 본문을 그대로 복사하거나 위젯/wd-scratch 에 덤프하지 마세요. 요약만 인라인으로 응답.
4. 요지가 이해된 뒤에도 scope 가 3+ 파일이거나 파괴적이면 AskUserQuestion 또는 EnterPlanMode 를 호출.
5. "should I proceed?" 같은 열린 질문 금지 — 확정된 선택지(2~4개) 로 묻거나 plan 을 제출.
6. 사용자 확인이 명확히 있을 때만 Edit/Write 로 진입.`;

const DESIGN_FIRST_PROMPT = `# 새 프로젝트 구현 요청 — RFC 먼저

사용자가 새 저장소나 새 프로젝트의 구현을 요청했습니다. 앱 코드·프로젝트 설정을 쓰거나 시험을 실행하기 전에 저장소 루트에 RFC.md 초안을 작성하고 명시적 승인을 요청하세요.

1. 요청에 PLAN/HANDOFF/SPEC 문서가 있으면 먼저 읽고 RFC 초안에 목표·범위·비목표·설계·수용 기준을 반영하세요.
2. RFC 초안과 결정이 필요한 항목을 제시하고 승인을 요청하세요.
3. 승인 전에는 애플리케이션 코드·설정을 만들거나 시험을 실행하지 마세요.
4. 승인 뒤 RFC와 대조해 구현을 시작하세요.`;

const IMPLEMENTATION_READY_PROMPT = `# 명시적 구현 요청 감지

사용자가 구현을 요청했습니다. **구현 요청 자체가 실행 승인입니다.** 계획을 설명한 뒤 멈추지 말고, 이번 턴 안에서 실제 코드 편집(Edit/Write)까지 진행하세요.

1. **열린 확인 질문 절대 금지.** "구현을 진행하시겠습니까?", "진행해도 될까요?", "이대로 할까요?" 같은 yes/no 되묻기로 턴을 끝내지 마세요 — 이미 요청받았습니다. 바로 실행하세요. (사용자가 같은 요청을 반복했다면 더더욱 재확인 없이 즉시 편집.)
2. 대상이 모호하면 Grep/Glob/Read 로 surface 를 먼저 조사 — 코드가 답할 수 있는 것은 코드에 먼저 물어보세요. 조사는 실행의 일부이지, 실행을 미루는 핑계가 아닙니다.
3. 1~2 파일의 명확한 수정은 Read → Edit 로 즉시 진행. 계획서를 응답으로 내보내지 말고 편집을 수행하세요.
4. scope 가 3+ 파일 또는 파괴적(대량 삭제·되돌리기 어려움)이라 정말 사전 정렬이 필요할 때만: 열린 "할까요?" 대신 **실질 산출물**을 내세요 — EnterPlanMode 로 구체 plan 을 제출하거나, 결정이 갈리는 지점을 AskUserQuestion 으로 **확정 선택지 2~4개**(각 옵션이 실제 구현 방향) 로 제시. 어느 쪽도 단순 승인 요청이어서는 안 됩니다.
5. 커밋은 사용자가 명시적으로 요청할 때만. push/merge 는 절대 자동으로 하지 않음. (단, 커밋 이전의 코드 편집은 위 승인 범위 안이므로 자유롭게 진행.)`;

export interface ImplDisciplinePromptOptions {
  nativeStructureEnabled?: boolean;
  enabledTools?: readonly NativeToolCatalogEntry[];
}

type ToolNamesByKind = Partial<Record<Exclude<NativeToolKind, 'other'>, string[]>>;

function namesForKinds(namesByKind: ToolNamesByKind, kinds: readonly Exclude<NativeToolKind, 'other'>[]): string | undefined {
  const names = [...new Set(kinds.flatMap(kind => namesByKind[kind] ?? []))];
  return kinds.every(kind => (namesByKind[kind]?.length ?? 0) > 0) ? names.join('/') : undefined;
}

function replaceDirective(prompt: string, directive: string, namesByKind: ToolNamesByKind, kinds: readonly Exclude<NativeToolKind, 'other'>[]): string {
  const names = namesForKinds(namesByKind, kinds);
  if (!names) return prompt.replace(`\n${directive}`, '');
  return prompt.replace(directive, directive.replace(/(?:Grep\/Glob\/Read|Edit\/Write|Read → Edit|Read)/, names));
}

/** 문장 «안»의 툴 이름 참조 — 절을 통째로 지우면 그 문단의 «본뜻»이 사라지는 자리에 쓴다.
 *  종류가 있으면 이름으로 치환하고, 없으면 괄호 절만 뺀다.
 *  ⛔ 「편집 툴이 아예 없으면 이 phase 자체가 무의미하다」는 더 큰 결정이라 여기서 하지 않는다 —
 *     그것은 detector 축이고 이 착지 밖이다. */
function replaceInlineToolNames(
  prompt: string,
  withNames: string,
  withoutNames: string,
  namesByKind: ToolNamesByKind,
  kinds: readonly Exclude<NativeToolKind, 'other'>[],
): string {
  const names = namesForKinds(namesByKind, kinds);
  return prompt.replace(withNames, names ? withNames.replace('Edit/Write', names) : withoutNames);
}

function appendDelegateGuidance(prompt: string, namesByKind: ToolNamesByKind): string {
  const delegateNames = namesForKinds(namesByKind, ['delegate']);
  if (!delegateNames) return prompt;
  return `${prompt}\n\n## 위임 가능한 도구\n광범위한 탐색이나 독립적인 조사 작업은 작업 초반에 ${delegateNames}로 위임해, 직접 탐색 전에 병렬로 근거를 확보하세요.`;
}

function promptWithNativeStructure(phase: ImplPhase, enabledTools: readonly NativeToolCatalogEntry[]): string {
  // Catalog loading belongs exclusively to the enabled path: default prompt
  // rendering stays byte-identical and does not pay catalog initialization.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { listNativeToolDisplayNamesByKind } = require('../native-tool-catalog.js') as typeof import('../native-tool-catalog.js');
  const namesByKind = listNativeToolDisplayNamesByKind(enabledTools);
  switch (phase) {
    case 'design-first': return DESIGN_FIRST_PROMPT;
    case 'plan-loaded': {
      let prompt = PLAN_LOADED_PROMPT;
      prompt = replaceDirective(prompt, '1. 먼저 Read 로 문서 전체를 읽으세요 (offset/limit 없이).', namesByKind, ['read']);
      return replaceDirective(prompt, '6. 사용자 확인이 명확히 있을 때만 Edit/Write 로 진입.', namesByKind, ['edit', 'write']);
    }
    case 'implementation-ready': {
      let prompt = IMPLEMENTATION_READY_PROMPT;
      // 리뷰 must-fix(2026-08-14) — 도입부의 Edit/Write 도 «이름»이라 종류로 간다.
      prompt = replaceInlineToolNames(
        prompt,
        '실제 코드 편집(Edit/Write)까지 진행하세요',
        '실제 코드 편집까지 진행하세요',
        namesByKind,
        ['edit', 'write'],
      );
      prompt = replaceDirective(prompt, '2. 대상이 모호하면 Grep/Glob/Read 로 surface 를 먼저 조사 — 코드가 답할 수 있는 것은 코드에 먼저 물어보세요. 조사는 실행의 일부이지, 실행을 미루는 핑계가 아닙니다.', namesByKind, ['search', 'read']);
      prompt = replaceDirective(prompt, '3. 1~2 파일의 명확한 수정은 Read → Edit 로 즉시 진행. 계획서를 응답으로 내보내지 말고 편집을 수행하세요.', namesByKind, ['read', 'edit']);
      return appendDelegateGuidance(prompt, namesByKind);
    }
    case 'idle': return '';
  }
}

/** Map a phase to its prompt body (empty string for idle). Kept
 *  separate from the dashboard glue so tests can verify the texts
 *  without booting the whole pipeline. */
export function promptForPhase(phase: ImplPhase, options: ImplDisciplinePromptOptions = {}): string {
  if (options.nativeStructureEnabled) {
    return promptWithNativeStructure(phase, options.enabledTools ?? []);
  }
  switch (phase) {
    case 'plan-loaded': return PLAN_LOADED_PROMPT;
    case 'design-first': return DESIGN_FIRST_PROMPT;
    case 'implementation-ready': return IMPLEMENTATION_READY_PROMPT;
    case 'idle': return '';
  }
}

/** Dashboard-facing helper — returns a ready-to-inject LLMMessage[].
 *  Empty array when plan mode is active (plan-mode system prompt
 *  owns phase discipline in that context) or when the turn is idle. */
export function buildImplDisciplineSystemMessages(
  input: DetectInput,
  options?: ImplDisciplinePromptOptions,
): Array<{ role: 'system'; content: string }> {
  // Lazy require to avoid TDZ cycles if plan-mode ever imports this
  // module transitively. Mirrors the pattern in
  // src/ask-user-question/system-prompt.ts:76.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getPlanModeState } = require('../plan-mode/session.js') as typeof import('../plan-mode/session.js');
  if (getPlanModeState().active) return [];

  const phase = detectImplPhase(input);
  const body = promptForPhase(phase, options);
  if (!body) return [];
  return [{ role: 'system', content: body }];
}
