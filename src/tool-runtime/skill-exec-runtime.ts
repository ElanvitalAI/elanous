import { debug } from '../debug/log.js';
import * as harnessSkillExec from '../harness/skill-exec.js';
import { invokeResearch } from '../research-bridge/invoke.js';
import * as skillIndex from '../skills/index.js';
import type { SkillIndexEntry } from '../skills/index.js';
import { getUserConfig } from '../user-config.js';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime } from './types.js';

/** Whole nested-skill budget; the inner LLM idle timer only bounds one stream. */
export const SKILL_EXEC_TIMEOUT_MS = 300_000;

export interface SkillExecRunOptions {
  signal?: AbortSignal;
  /** Test seam for a short deterministic whole-skill deadline. */
  timeoutMs?: number;
}

export interface SkillExecArgs {
  /** Exact name of the skill to execute. */
  skill: string;
  /** Task text passed verbatim to the named skill. */
  task: string;
}

export interface SkillExecResult extends Record<string, unknown> {
  skill: string;
  output: string;
  ok: boolean;
  error?: string;
  discoveryCard?: string;
}

export interface SkillExecDiscoveryDeps {
  discoverPlugin?: (gap: string, deps?: { signal?: AbortSignal }) => Promise<{ card: string }>;
}

export type SkillExecIndexProvider = () => readonly SkillIndexEntry[];

let skillExecIndexProvider: SkillExecIndexProvider | null = null;

/** Test seam: inject a skill index (or a throwing getter) so this path never reads user skill dirs. */
export function setSkillExecIndexProvider(provider: SkillExecIndexProvider | null): void {
  skillExecIndexProvider = provider;
}

const REJECT_OUTPUT = (skill: string): string =>
  `자동 실행 대상 아님: ${skill}. 대신 skill-hint 경로를 사용하세요. 이 판정을 넓히려면 skillRouter.harnessExecAllowlist와 HARNESS_EXEC_BLOCK_PATTERNS를 검토하세요.`;

function observe(event: string, data: Record<string, unknown>): void {
  try {
    debug.log('tool-runtime.skill-exec', event, data);
  } catch {
    /* fail-soft — observation must not fail the tool */
  }
}

function obtainSkillIndex(): readonly SkillIndexEntry[] {
  try {
    return (skillExecIndexProvider ?? skillIndex.getSkillIndex)();
  } catch (error) {
    observe('index-unavailable', {
      error: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
    // Explicit empty index — never `undefined`. Passing undefined would
    // re-evaluate a default `index = getSkillIndex()` and read user skill dirs.
    return [];
  }
}

export function buildSkillExecTool(): LLMToolSpec {
  return {
    name: 'skill_exec',
    description: 'Execute one explicitly named allowlisted skill with the supplied task. If you do not know the exact skill name, call elanous_skills_list first. Does not infer a skill name.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Exact name of the skill to execute.',
        },
        task: {
          type: 'string',
          description: 'Task text passed to the named skill.',
        },
      },
      required: ['skill', 'task'],
      additionalProperties: false,
    },
  };
}

export async function dispatchSkillExec(
  args: SkillExecArgs,
  deps: SkillExecDiscoveryDeps = {},
  options: SkillExecRunOptions = {},
): Promise<SkillExecResult> {
  const { skill, task } = args;
  const extra = getUserConfig().skillRouter.harnessExecAllowlist;
  const index = obtainSkillIndex();
  const allowlist = harnessSkillExec.resolveHarnessExecAllowlist(
    extra,
    (rejected, reason) => observe('allowlist-reject', { skill: rejected, reason }),
    index,
  );

  const declaredSafeCandidates = index
    .filter((entry) => harnessSkillExec.isDeclaredAutoExecSafe(entry))
    .map((entry) => entry.name);
  const declaredSafeAdmitted = declaredSafeCandidates.filter((name) => allowlist.has(name));
  const admitted = allowlist.has(skill);
  const reason = !admitted
    ? 'not-allowlisted'
    : declaredSafeAdmitted.includes(skill)
      ? 'declared-safe'
      : extra.includes(skill)
        ? 'config'
        : 'builtin';
  observe('decision', {
    skill,
    admitted,
    reason,
    extra,
    indexSize: index.length,
    declaredSafeCandidates,
    declaredSafeAdmitted,
  });

  if (!admitted) {
    return {
      skill,
      ok: false,
      output: REJECT_OUTPUT(skill),
    };
  }

  if (options.signal?.aborted) {
    return { skill, ok: false, error: 'skill-exec-cancelled', output: '스킬 실행이 취소됐습니다. 현재 근거로 다음 단계를 결정하세요.' };
  }

  // Race the whole invocation so even a provider that ignores abort gives the
  // parent a failed tool result. Cooperative LLM and child tools get the same
  // signal and stop their own work.
  const child = new AbortController();
  const timeoutMs = options.timeoutMs ?? SKILL_EXEC_TIMEOUT_MS;
  let settled = false;
  let finishEarly: ((reason: 'skill-exec-timeout' | 'skill-exec-cancelled') => void) | undefined;
  const interrupted = new Promise<'skill-exec-timeout' | 'skill-exec-cancelled'>((resolve) => {
    finishEarly = (reason) => {
      if (settled) return;
      settled = true;
      resolve(reason);
      child.abort();
    };
  });
  const onParentAbort = () => finishEarly?.('skill-exec-cancelled');
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => finishEarly?.('skill-exec-timeout'), timeoutMs);
  observe('started', { skill, timeoutMs });
  let progressChunks = 0;
  let progressBytes = 0;
  let result: Awaited<ReturnType<typeof invokeResearch>> | undefined;
  let interruption: 'skill-exec-timeout' | 'skill-exec-cancelled' | undefined;
  try {
    const outcome = await Promise.race([
      invokeResearch(task, { skill, signal: child.signal, onProgress: (delta) => {
        progressChunks += 1;
        progressBytes += delta.length;
        if (progressChunks === 1 || progressChunks % 32 === 0) {
          observe('progress', { skill, progressChunks, progressBytes });
        }
      } }).then((value) => ({ result: value })),
      interrupted.then((reason) => ({ interruption: reason })),
    ]);
    settled = true;
    if ('interruption' in outcome) interruption = outcome.interruption;
    else result = outcome.result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
  if (interruption) {
    observe('interrupted', { skill, reason: interruption, timeoutMs });
    return {
      skill,
      ok: false,
      error: interruption,
      output: interruption === 'skill-exec-timeout'
        ? `스킬 실행 시간이 초과됐습니다 (${timeoutMs}ms). 범위를 좁혀 다시 시도하거나 현재 근거로 답하세요.`
        : '스킬 실행이 취소됐습니다. 현재 근거로 다음 단계를 결정하세요.',
    };
  }
  if (!result) throw new Error('skill_exec completed without a result');
  observe('completed', { skill, ok: result.ok, progressChunks, progressBytes, durationMs: result.durationMs });
  // A low-quality research result is a capability gap. Keep the original failure,
  // and attach a bounded discovery card rather than silently switching tools.
  let discoveryCard: string | undefined;
  if (!result.ok && /\b(?:no data|no evidence|missing|unavailable|not found|empty)\b|(?:자료가 없|데이터가 없|자료 부족|미확인|찾지 못)/i
    .test(`${result.output} ${result.error ?? ''}`)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('plugin discovery time budget exhausted')), 10_000);
    try {
      const discovery = deps.discoverPlugin ?? (await import('../research/plugin-discovery.js')).discoverResearchPlugin;
      const found = await discovery(task, { signal: controller.signal });
      discoveryCard = found.card;
    } catch { /* The skill failure remains the authoritative result. */ }
    finally { clearTimeout(timer); }
  }
  return {
    skill,
    ok: result.ok,
    output: discoveryCard ? `${result.output}\n\n${discoveryCard}` : result.output,
    ...(discoveryCard ? { discoveryCard } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

export const skillExecRuntime: ToolRuntime<SkillExecArgs, SkillExecResult> = {
  id: 'skill_exec',
  spec: buildSkillExecTool(),
  async run(req, ctx) {
    return dispatchSkillExec(req, {}, { signal: ctx.signal });
  },
};
