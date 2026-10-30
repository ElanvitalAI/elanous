import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { invokeResearch } from '../research-bridge/invoke.js';
import type { SkillIndexEntry } from '../skills/index.js';
import { getSkillIndex } from '../skills/index.js';
import { detectSkillTrigger } from '../skills/router.js';
import { discoverResearchPlugin, rerunInstalledPluginResearch } from './plugin-discovery.js';
import { debug } from '../debug/log.js';

export const MAX_GAP_FOLLOWUP_ROUNDS = 1;
export const MAX_GAP_FOLLOWUP_MS = 120_000;
/** Default research-only skills permitted to auto-fill one evidence gap. */
export const READ_ONLY_AUTO_FOLLOWUP_SKILLS: ReadonlySet<string> = new Set([
  'omni-market', 'kr-flow', 'omni-crawl', 'social-pulse', 'omni-digest',
]);
const MAX_GAP_TEXT = 8_000;

export interface ResearchGapFollowupInput {
  request: string;
  questions: readonly BloomResearchQuestion[];
  evidence: readonly ResearchEvidenceEnvelope[];
  signal?: AbortSignal;
  /** Optional remaining time supplied by the owning turn; omitted uses the fixed 2-minute cap. */
  remainingBudgetMs?: number;
  roundsUsed?: number;
  /** Test seam; production resolves the installed registry. */
  skills?: readonly SkillIndexEntry[];
  /** Production can widen/narrow the built-in read-only skill set. */
  readOnlySkillAllowlist?: ReadonlySet<string>;
}

export type ResearchGapAction = 'auto-fill' | 'followup';
export type ResearchGapReason =
  | 'auto-fill-eligible'
  | 'round-limit'
  | 'time-budget'
  | 'no-skill-match'
  | 'ambiguous-skill-match'
  | 'skill-not-read-only'
  | 'skill-not-allowlisted';

export interface ResearchGapClassification {
  questionId: string;
  gap: string;
  action: ResearchGapAction;
  reason: ResearchGapReason;
  skill?: string;
}

export interface ResearchGapFollowupCall {
  questionId: string;
  skill: string;
  query: string;
}

export interface ResearchGapFollowupPlan {
  /** Zero or one. The bound is part of the public contract. */
  rounds: 0 | 1;
  timeBudgetMs: number;
  classifications: ResearchGapClassification[];
  followups: ResearchGapFollowupCall[];
}

export interface ResearchGapFollowupResult extends ResearchGapFollowupPlan {
  followupEvidence: ResearchEvidenceEnvelope[];
  discoveryCards?: string[];
}

export interface ResearchGapFollowupDeps {
  runSkill?: (skill: string, query: string, signal: AbortSignal) => Promise<{ ok: boolean; output: string; error?: string }>;
  discoverPlugin?: typeof discoverResearchPlugin;
  rerunInstalled?: typeof rerunInstalledPluginResearch;
  now?: () => number;
}

/**
 * Use Bloom analyze/evaluate axes (4/5) to find explicit evidence gaps,
 * match those gaps against the installed skill registry, and auto-fill only from
 * the OP-approved research allowlist. Only explicit read-only declarations
 * are auto-run; missing, write, or spawn declarations remain ask-first
 * follow-ups. Cost metadata is not a gate.
 */
export function planGapFollowup(input: ResearchGapFollowupInput): ResearchGapFollowupPlan {
  const timeBudgetMs = Math.max(0, Math.min(MAX_GAP_FOLLOWUP_MS,
    input.remainingBudgetMs === undefined ? MAX_GAP_FOLLOWUP_MS
      : Number.isFinite(input.remainingBudgetMs) ? input.remainingBudgetMs : 0));
  const allowlist = input.readOnlySkillAllowlist ?? READ_ONLY_AUTO_FOLLOWUP_SKILLS;
  const skillIndex = [...(input.skills ?? getSkillIndex())];
  const questions = new Map(input.questions.map((question) => [question.id, question]));
  const gaps = findResearchGaps(input.questions, input.evidence);
  const classifications: ResearchGapClassification[] = [];
  const followups: ResearchGapFollowupCall[] = [];
  const roundAvailable = (input.roundsUsed ?? 0) < MAX_GAP_FOLLOWUP_ROUNDS;

  for (const gap of gaps) {
    const question = questions.get(gap.questionId);
    const routeText = [question?.prompt, gap.text].filter(Boolean).join('\n');
    const query = [input.request, question?.prompt, gap.text].filter(Boolean).join('\n');
    const match = detectSkillTrigger(routeText, skillIndex, { minScore: 1 });
    const top = match.top;
    const matchedSkill = top ? skillIndex.find((skill) => skill.name === top.name) : undefined;
    let reason: ResearchGapReason;
    if (!roundAvailable) reason = 'round-limit';
    else if (timeBudgetMs <= 0) reason = 'time-budget';
    else if (!top || top.matchedTriggers.length === 0) reason = 'no-skill-match';
    else if (!match.unambiguous) reason = 'ambiguous-skill-match';
    else if (matchedSkill?.sideEffects !== 'none') reason = 'skill-not-read-only';
    else if (!allowlist.has(top.name)) reason = 'skill-not-allowlisted';
    else reason = 'auto-fill-eligible';

    if (reason === 'auto-fill-eligible' && top) {
      followups.push({ questionId: gap.questionId, skill: top.name, query });
      classifications.push({ questionId: gap.questionId, gap: gap.text, action: 'auto-fill', reason, skill: top.name });
    } else {
      classifications.push({ questionId: gap.questionId, gap: gap.text, action: 'followup', reason, ...(top ? { skill: top.name } : {}) });
    }
  }

  return {
    rounds: followups.length > 0 ? 1 : 0,
    timeBudgetMs,
    classifications,
    followups,
  };
}

/** Execute all eligible axes as one bounded round; timeout aborts each skill invocation. */
export async function runGapFollowup(
  input: ResearchGapFollowupInput,
  deps: ResearchGapFollowupDeps = {},
): Promise<ResearchGapFollowupResult> {
  const plan = planGapFollowup(input);
  if (input.signal?.aborted) return { ...plan, followupEvidence: [], discoveryCards: [] };
  const startedAt = (deps.now ?? Date.now)();
  const deadline = startedAt + plan.timeBudgetMs;
  const discover = async (failedQuestions: ReadonlySet<string>): Promise<{ cards: string[]; evidence: ResearchEvidenceEnvelope[] }> => {
    const gaps = plan.classifications.filter(item => item.reason === 'no-skill-match'
      || (item.reason === 'auto-fill-eligible' && failedQuestions.has(item.questionId)));
    const cards: string[] = [];
    const evidence: ResearchEvidenceEnvelope[] = [];
    for (const gap of gaps.slice(0, 2)) {
      const remainingMs = deadline - (deps.now ?? Date.now)();
      if (remainingMs <= 0) break;
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener('abort', abortFromParent, { once: true });
      if (input.signal?.aborted) abortFromParent();
      const timer = setTimeout(() => controller.abort(new Error('plugin discovery time budget exhausted')),
        Math.min(10_000, remainingMs));
      try {
        const result = await (deps.discoverPlugin ?? discoverResearchPlugin)(gap.gap, { signal: controller.signal });
        cards.push(result.card);
        if (result.installed && !controller.signal.aborted && deadline > (deps.now ?? Date.now)()) {
          const rerun = await (deps.rerunInstalled ?? rerunInstalledPluginResearch)(gap.gap, result.installed, controller.signal);
          const output = Array.from(rerun.output).slice(0, MAX_GAP_TEXT).join('');
          evidence.push({ questionId: gap.questionId, sourceKind: `plugin:${result.installed.name}`,
            source: result.installed.name, observedAt: new Date((deps.now ?? Date.now)()).toISOString(),
            content: output || rerun.error || 'installed plugin returned no research output',
            outcome: rerun.ok && output ? 'complete' : 'failed',
            truncated: Array.from(rerun.output).length > MAX_GAP_TEXT });
        }
      } catch (error) {
        debug.log('research.plugin-discovery', 'followup-unavailable', {
          questionId: gap.questionId, reason: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
        }, { level: 'warn' });
      }
      finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abortFromParent);
      }
    }
    return { cards, evidence };
  };
  if (plan.followups.length === 0) {
    const discovered = await discover(new Set());
    return { ...plan, followupEvidence: discovered.evidence, discoveryCards: discovered.cards };
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (input.signal?.aborted) abortFromParent();
  const timer = setTimeout(() => controller.abort(new Error('research gap follow-up time budget exhausted')),
    Math.max(1, deadline - (deps.now ?? Date.now)()));
  try {
    const outcomes = await Promise.all(plan.followups.map(async (call): Promise<ResearchEvidenceEnvelope> => {
      try {
        const result = await (deps.runSkill ?? defaultRunSkill)(call.skill, call.query, controller.signal);
        const output = Array.from(result.output).slice(0, MAX_GAP_TEXT).join('');
        return {
          questionId: call.questionId,
          sourceKind: `skill:${call.skill}`,
          source: call.skill,
          observedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          content: output || result.error || 'skill returned no research output',
          outcome: result.ok && output ? 'complete' : 'failed',
          truncated: Array.from(result.output).length > MAX_GAP_TEXT,
        };
      } catch (error) {
        return {
          questionId: call.questionId,
          sourceKind: `skill:${call.skill}`,
          source: call.skill,
          observedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          content: controller.signal.aborted ? 'follow-up exceeded its time budget' : errorText(error),
          outcome: 'failed',
          truncated: false,
        };
      }
    }));
    const discovered = await discover(new Set(outcomes.filter(item => item.outcome !== 'complete').map(item => item.questionId)));
    return { ...plan, followupEvidence: [...outcomes, ...discovered.evidence], discoveryCards: discovered.cards };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

function findResearchGaps(
  questions: readonly BloomResearchQuestion[],
  evidence: readonly ResearchEvidenceEnvelope[],
): Array<{ questionId: string; text: string }> {
  const byQuestion = new Map<string, ResearchEvidenceEnvelope[]>();
  for (const item of evidence) byQuestion.set(item.questionId, [...(byQuestion.get(item.questionId) ?? []), item]);
  const gaps: Array<{ questionId: string; text: string }> = [];
  const seen = new Set<string>();
  for (const question of questions) {
    if (question.level !== 4 && question.level !== 5) continue;
    const items = byQuestion.get(question.id) ?? [];
    const questionGaps = new Set<string>();
    if (items.length === 0) questionGaps.add(question.prompt);
    for (const item of items) {
      const sentences = item.content.split(/(?<=[.!?。！？])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
      const matches = sentences.filter(isExplicitGap);
      const candidates = matches.length ? matches : item.outcome === 'complete' ? [] : [item.content.trim() || question.prompt];
      for (const text of candidates) {
        const normalized = text.toLowerCase();
        if (text && !seen.has(`${question.id}\0${normalized}`)) {
          seen.add(`${question.id}\0${normalized}`);
          questionGaps.add(text);
        }
      }
    }
    if (questionGaps.size > 0) {
      gaps.push({ questionId: question.id, text: Array.from([...questionGaps].join(' ')).slice(0, MAX_GAP_TEXT).join('') });
    }
  }
  return gaps;
}

function isExplicitGap(text: string): boolean {
  return /\b(?:unavailable|not available|missing|not found|no data|no evidence|unknown|unverified|could not find|failed to find|not provided|blank|empty|not covered)\b|\bno\b.{0,80}\b(?:data|evidence|records|series)\b.{0,80}\b(?:found|available|verified)\b|(?:미확인|확인되지 않|자료가 없|데이터가 없|자료 부족|데이터 부족|빈값|값이 비|시계열.{0,20}없|공백|찾지 못|미제공|미수집|검증되지 않|수급 미확인)/i.test(text);
}

async function defaultRunSkill(skill: string, query: string, signal: AbortSignal): Promise<{ ok: boolean; output: string; error?: string }> {
  const result = await invokeResearch(query, { skill, signal });
  return { ok: result.ok, output: result.output, ...(result.error ? { error: result.error } : {}) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
