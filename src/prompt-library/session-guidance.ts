// Session-specific guidance addendum — Wave 3 (2026-05-04).
//
// Family-agnostic. When the active toolset is known at preamble-build
// time, emit per-tool one-liner directives so the model knows the
// affordances available in the current surface — without that
// guidance the model has to infer behavior from each tool's own
// description, which is less reliable for cross-tool patterns
// (deny-clarify, search-vs-Agent split, plan-mode discipline).
//
// Pattern source — ref/claude-code-fork
// `src/constants/prompts.ts:352-400` (`getSessionSpecificGuidanceSection`).
// Mirrored as family-agnostic so codex / claude / gemini / grok all
// benefit from the same per-tool framing. Each branch is a single
// short line; only emits when the corresponding tool is in
// `enabledTools`. When no relevant tool is active, the function
// returns an empty array (no system message added).
//
// Wired by `buildUniversalPreamble` AFTER family-specific addendums
// so it can override the family-default behavior when a specific tool
// is active. Returning empty when nothing applies keeps the prompt
// lean for surfaces with minimal tool exposure (sub-agents, REPL).

import type { LLMMessage } from '../llm.js';

/** Lookup helper — case-insensitive set check tolerates the alias /
 *  displayName variance in `nativeToolCatalog` (`AskUserQuestion` vs
 *  `ask_user_question` etc.). */
function hasTool(enabled: ReadonlySet<string>, ...names: string[]): boolean {
  for (const n of names) {
    if (enabled.has(n)) return true;
    if (enabled.has(n.toLowerCase())) return true;
  }
  return false;
}

/** Build the session guidance addendum. Returns 0 or 1 system message
 *  containing per-tool one-liner directives, gated on what's active.
 *  When `enabledTools` is undefined or every relevant tool is absent,
 *  returns an empty array — no system message is added. */
export function buildSessionGuidanceAddendum(
  enabledTools: readonly string[] | undefined,
): LLMMessage[] {
  if (!enabledTools || enabledTools.length === 0) return [];
  const active = new Set(enabledTools);
  const items: string[] = [];

  // Skill auto-trigger (BLOCKING REQUIREMENT pattern from ref's
  // SkillTool/prompt.ts:190). elanous's skill activation isn't a tool
  // call — it's slash-router driven (`/<skill-name>` → harness routes
  // to skill runner). The model never invokes skills directly. But
  // when the user's prompt MATCHES an available skill, the model
  // should suggest the slash form rather than answering inline with
  // anchor-only synthesis. This directive doesn't fire on tool match
  // (elanous has no SkillTool) — it fires whenever a Skill-aware
  // surface is in play (most elanous surfaces). Keep this concise; the
  // skill-route-runtime emits matched-skill hints in tool_results
  // when detection fires.
  items.push(
    'When the user types `/<skill-name>` (e.g., `/commit`, `/review`), the harness routes to the skill runner — you do not invoke skills directly. If you see a `<command-name>` tag in the current conversation turn, the skill has ALREADY been loaded; follow its instructions directly.',
  );

  // AskUserQuestion — ref pattern (prompts.ts:366). Active in
  // dashboard / skill surfaces; structured error in headless. When
  // active, instruct the model to use it for tool-deny clarification
  // and genuinely ambiguous decisions.
  if (hasTool(active, 'AskUserQuestion', 'ask_user_question')) {
    items.push(
      'If you do not understand why the user has denied a tool call, use `AskUserQuestion` to ask them. Do NOT use it as a first response to friction — only when you\'re genuinely stuck after investigation.',
    );
  }

  // Agent — sub-agent spawn. ref pattern (prompts.ts:378-379). When
  // the user's task is broad codebase exploration / multi-step
  // research, prefer the `Agent` tool over inline Grep/Read storms;
  // when it's a directed lookup, prefer direct search. Naming the
  // split helps cross-provider consistency (codex/opus/gemini all
  // benefit from the same heuristic).
  if (hasTool(active, 'Agent', 'agent')) {
    items.push(
      'Use the `Agent` tool with specialized agents when the task at hand matches the agent\'s description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.',
    );
  }

  // TaskCreate / UpdatePlan — multi-step planning discipline. ref
  // pattern (prompts.ts:308). When active, instruct the model to
  // break work into discrete tasks and mark each completed as soon
  // as done — don't batch.
  if (hasTool(active, 'TaskCreate', 'task_create', 'UpdatePlan', 'update_plan')) {
    items.push(
      'Use `TaskCreate` to plan and track work. Mark each task completed as soon as it\'s done; don\'t batch.',
    );
  }

  // EnterPlanMode / ExitPlanMode — plan mode discipline. elanous-
  // specific (no direct ref equivalent). When the user enters plan
  // mode, only the plan file is writable; investigation tools are
  // read-only. The model should draft a decision-complete plan
  // before ExitPlanMode rather than half-planning.
  if (hasTool(active, 'EnterPlanMode', 'ExitPlanMode', 'enter_plan_mode', 'exit_plan_mode')) {
    items.push(
      'In plan mode, only the plan file is writable. Use `Read` / `Grep` / `AskUserQuestion` to gather context, then draft a decision-complete plan before `ExitPlanMode` — don\'t exit with a half-formed plan and resolve open questions during execution.',
    );
  }

  // Self-conversation via `elanous chat` — only meaningful when Bash is
  // exposed (we shell out to the CLI). The capability is opt-in via
  // user judgement: the model should self-spawn when a multi-turn
  // refinement is genuinely useful (debugging its own response, log
  // analysis, sub-task delegation), not by default. Pattern docs:
  // 내부 문서 `MANUAL-llm-pipeline-validation` (Part B).
  if (hasTool(active, 'Bash', 'bash')) {
    items.push(
      'For self-driven multi-turn work (refining your own answer, analyzing your own forensic log, delegating a sub-task), you may shell out to the CLI: `elanous chat --new --json "<text>"` returns `{sessionId, ...}`; follow up with `elanous chat --session <id> --json "<text>"`. Provider rotation between turns is fine — same session id keeps the history. Use only when genuinely useful; do not self-spawn for ordinary single-turn answers. Full reference: `docs/manual/MANUAL-llm-pipeline-validation.md` (Part B).',
    );
  }

  if (items.length === 0) return [];
  // B4 — 파일 수 규칙. 명령을 실제로 돌릴 도구(Bash·PtyShellStart·WebTerminal*)가 있을 때만 `git ls-files` 로 세라고 하고,
  // Read 만 켜진 세션에선 셀 수 없으니 추측하지 말고 확인 불가라고 답하게 한다(EVAL q09 «959» vs 실측 778 · 리뷰 3라운드 must-fix).
  const canRunCommands = enabledTools.some(name => /^(Bash|PtyShellStart|WebTerminal)/.test(name));
  const fileCountRule = canRunCommands
    ? '저장소의 파일 수·목록은 저장소 루트에서 `git ls-files <경로>`로 추적 파일 기준으로 센다 — 하위 디렉터리에서 실행 중이면 저장소 루트로 이동해서 세고, 다른 기준이면 그 기준을 답에 적는다.'
    : '이 세션에는 명령을 실행할 도구가 없다 — 저장소의 파일 수는 추측하지 말고 «이 모드에서는 셀 수 없다»고 답한다(도구로 센 목록이 대화에 있으면 그 기준을 밝히고 쓴다).';
  return [{
    role: 'system',
    content: `${fileCountRule}\n\n` + '# Session-specific guidance\n\n' +
      items.map(s => `- ${s}`).join('\n'),
  }];
}
