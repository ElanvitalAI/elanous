// PLAN §4.4 · Phase 1.4 — Research invocation entry point.
//
// `invokeResearch(topic, opts)` runs the named skill (default
// `omni-crawl`) and returns a structured result. The actual skill
// execution is delegated to a pluggable invoker so:
//   - production wires it to the existing executeSkill() pipeline
//   - tests inject a mock that returns a canned response
//   - future surfaces (Bash escape, shell-out CLI) can swap the
//     invoker without touching call sites.
//
// The default invoker is the production path: parse SKILL.md →
// executeSkill() → buffer chunks. It only loads at first call so
// the rest of the bridge (slash, store, format) can be tested in
// isolation without standing up the LLM stack.

import type { ExternalResearchResult, InvokeResearchOpts } from './types.js';
import type { SkillManifest } from '../skills/runner.js';
import type { BloomResearchQuestion } from '../auto-research/question-ladder-contract.js';
import type { AxisFanoutDeps, AxisFanoutResult } from '../research/axis-fanout.js';
import { recordResult } from './store.js';

const DEFAULT_SKILL = 'omni-crawl';

// ★ research 격리(대표 2026-07-20) — 조사 스킬에서 파일-쓰기 도구를 deny.
//
// 버그: omni-crawl 등 검색 스킬이 full 도구셋(Write/Edit 포함)으로 실행되고 executeSkill 의
// skillCwd 가 process.cwd()=main 트리라, codex 가 조사 중 Write 도구로 `내부 문서 `*`` 를
// main 트리에 직접 write → 승인 전(proposed 미션) 부작용으로 main 트리 오염(walker main-tree
// pollution 의 research/prepare 판). recordResult 의 `.elanous/research/` archive(격리)와 별개.
//
// 수복: research 경로에서 Write/Edit/NotebookEdit 만 deny. Bash 는 manifest.skillDir cwd 라 main
// 트리 밖이고 omni-crawl 검색 CLI(npx tsx scripts/main.ts)에 필수라 유지 → 검색은 정상 작동,
// 조사 부작용만 원천 봉쇄. deny wins over allow(tool-policy). 순수·spread(원본 불변).
export const RESEARCH_DENIED_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;

const ANSI_CONTROL_SEQUENCES = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** Select the model's final answer, never the TUI-rendered tool transcript. */
export function researchOutputFromSkillRun(
  run: { finalResponse: string },
): string {
  return run.finalResponse.replace(ANSI_CONTROL_SEQUENCES, '');
}

export function withResearchIsolation(manifest: SkillManifest): SkillManifest {
  const deniedTools = [...new Set([...(manifest.deniedTools ?? []), ...RESEARCH_DENIED_TOOLS])];
  return { ...manifest, deniedTools };
}

/** A minimal skill-execution shape — `output` is the full markdown
 *  text the skill produced, `ok` reflects whether the skill
 *  declared a successful run. */
export interface ResearchInvocationOutcome {
  output: string;
  ok: boolean;
  error?: string;
}

/** A successful skill call with no final answer is an incomplete invocation. */
export function researchOutcomeFromSkillRun(
  run: { finalResponse: string },
): ResearchInvocationOutcome {
  const output = researchOutputFromSkillRun(run);
  if (output.length === 0) {
    return {
      output,
      ok: false,
      error: 'skill run finished without a final assistant response',
    };
  }
  return { output, ok: true };
}

export type ResearchInvoker = (
  skillName: string,
  args: string,
  onProgress?: (delta: string) => void,
  signal?: AbortSignal,
) => Promise<ResearchInvocationOutcome>;

let invoker: ResearchInvoker | null = null;

/** Register the production / test invoker. Pass null to revert to
 *  the lazy default (executeSkill-backed). */
export function setResearchInvoker(fn: ResearchInvoker | null): void {
  invoker = fn;
}

/** Research-turn entry once Bloom has supplied its question axes. This uses
 *  native search per axis; it never sends the entire request to a skill. */
export async function invokeResearchAxes(
  questions: readonly BloomResearchQuestion[],
  deps: AxisFanoutDeps = {},
): Promise<AxisFanoutResult> {
  // Keep the generic chat entry's static module closure unchanged; axis search
  // is loaded only for a Bloom research turn.
  const { fanOutAxisEvidence } = await import('../research/axis-fanout.js');
  return fanOutAxisEvidence(questions, deps);
}

async function defaultInvoker(
  skillName: string,
  args: string,
  onProgress?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ResearchInvocationOutcome> {
  const { parseSkillMd, executeSkill } = await import('../skills/runner.js');
  const manifest = parseSkillMd(skillName);
  if (!manifest) {
    return {
      output: '',
      ok: false,
      error: `skill "${skillName}" not found under ~/.claude/skills/`,
    };
  }
  try {
    // ★ research 격리 — 파일-쓰기 도구 deny 주입(main 트리 오염 차단). Bash·검색도구는 유지.
    const result = await executeSkill(withResearchIsolation(manifest), args, (delta) => {
      if (onProgress) onProgress(delta);
    }, { signal });
    return researchOutcomeFromSkillRun(result);
  } catch (err) {
    return {
      output: '',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run the named skill against `topic`, archive the outcome, return
 *  the full structured result. The topic is also the args string
 *  passed to the skill — omni-crawl treats it as the search query
 *  per its SKILL.md. */
export async function invokeResearch(
  topic: string,
  opts: InvokeResearchOpts = {},
): Promise<ExternalResearchResult> {
  const skillName = opts.skill || DEFAULT_SKILL;
  const startedAt = new Date();
  const outcome = await (invoker ?? defaultInvoker)(skillName, topic, opts.onProgress, opts.signal);
  const finishedAt = new Date();
  const result: ExternalResearchResult = {
    topic,
    skill: skillName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok: outcome.ok && outcome.output.length > 0,
    output: outcome.output,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  recordResult(result);
  return result;
}
