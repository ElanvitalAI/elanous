import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export interface SkillRun {
  skill: string;
  runId: string;
  outcome: 'success' | 'failure';
  failureKind?: string;
  userCorrected: boolean;
  retries: number;
  durationMs: number;
  at: string;
}

export interface SkillFixProposal {
  skill: string;
  failureKind: string;
  evidenceRunIds: string[];
  suggestion: string;
  expectedEffect: string;
}

/** Record one run at the caller-supplied ledger path; never touch a skill file. */
export function appendSkillRun(ledgerPath: string, run: SkillRun): void {
  appendFileSync(ledgerPath, `${JSON.stringify(run)}\n`, 'utf8');
}

/**
 * Ledger for skill runs: `<root>/skills/feedback.jsonl`, root defaulting to the
 * effective instance (state) root — never a skill folder. Creates the directory.
 */
export function skillFeedbackLedgerPath(root: string = effectiveInstanceRoot()): string {
  const dir = join(root, 'skills');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'feedback.jsonl');
}

/**
 * Fail-soft record of one skill run: resolving or writing the ledger never
 * throws to the caller; a failure leaves a single `record-failed` observation.
 */
export function recordSkillRunSafe(run: SkillRun, ledgerPath?: string): void {
  try {
    appendSkillRun(ledgerPath ?? skillFeedbackLedgerPath(), run);
  } catch (error) {
    try {
      debug.log('skill.feedback', 'record-failed', { skill: run.skill, error: String(error) }, { level: 'warn' });
    } catch { /* observation must not break the skill result either */ }
    return;
  }
  try {
    debug.log('skill.feedback', 'recorded', { skill: run.skill, outcome: run.outcome, durationMs: run.durationMs });
  } catch { /* fail-soft */ }
}

/** Read the JSONL ledger in append order; an absent ledger has no runs. */
export function readSkillRuns(ledgerPath: string): SkillRun[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as SkillRun);
}

/** Shadow-only suggestions for recurring failures within the same skill and failure kind. */
export function proposeSkillFixes(
  runs: readonly SkillRun[],
  { threshold = 3 }: { threshold?: number } = {},
): SkillFixProposal[] {
  const grouped = new Map<string, Map<string, Map<string, SkillRun>>>();
  for (const run of runs) {
    if (run.outcome !== 'failure' || !run.failureKind) continue;
    let kinds = grouped.get(run.skill);
    if (!kinds) { kinds = new Map(); grouped.set(run.skill, kinds); }
    let failures = kinds.get(run.failureKind);
    if (!failures) { failures = new Map(); kinds.set(run.failureKind, failures); }
    const previous = failures.get(run.runId);
    if (!previous || run.at >= previous.at) failures.set(run.runId, run);
  }

  const proposals: SkillFixProposal[] = [];
  for (const [skill, kinds] of grouped) {
    for (const [failureKind, failures] of kinds) {
      if (failures.size < threshold) continue;
      const evidenceRunIds = [...failures.values()]
        .map((run, index) => ({ run, index }))
        .sort((a, b) => a.run.at.localeCompare(b.run.at) || a.index - b.index)
        .slice(-3)
        .map(({ run }) => run.runId);
      proposals.push({
        skill,
        failureKind,
        evidenceRunIds,
        suggestion: `스킬 ${skill}의 ${failureKind} 실패 처리를 점검·개선하세요 — 같은 실패가 ${failures.size}번 반복됐습니다.`,
        expectedEffect: `${skill}의 ${failureKind} 재발 감소`,
      });
      debug.log('skill.feedback', 'proposal', { skill, failureKind, runs: failures.size });
    }
  }
  return proposals;
}
