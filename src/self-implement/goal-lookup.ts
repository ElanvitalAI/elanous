import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selfDevRunsDir, type SelfDevRunState } from '../self-dev/run-store.js';
import { isGoalAuthorFileName } from './goal-document.js';

export interface GoalLookupOptions {
  /** Defaults to the current repository's docs/goals directory. */
  goalsDir?: string;
  /** Defaults to the current instance's self-dev-runs directory. */
  runsDir?: string;
}

export interface GoalLookupRecord {
  runId: string;
  stage: string | null;
  outcome: string | null;
  prNumber: number | null;
}

/** The two sources are independent: null means that side did not match. */
export interface GoalLookupResult {
  goalBody: string | null;
  goalFile: string | null;
  kanId: string | null;
  runId: string | null;
  record: GoalLookupRecord | null;
  runState: SelfDevRunState | null;
}

function filesIn(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

type ValidResult = { runId: string; stage?: string | null; prNumber?: number | null };

function isValidResult(result: unknown): result is ValidResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const r = result as { runId?: unknown; stage?: unknown; prNumber?: unknown };
  return typeof r.runId === 'string' && r.runId.length > 0
    && (r.stage == null || typeof r.stage === 'string')
    && (r.prNumber == null || (typeof r.prNumber === 'number' && Number.isSafeInteger(r.prNumber) && r.prNumber > 0));
}

function prNumber(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function executionRecords(document: string): GoalLookupRecord[] {
  const sections = document.split(/^## 실행 기록\s*$/m).slice(1);
  return sections.flatMap((section) => {
    const block = section.split(/^#{1,2} /m, 1)[0] ?? '';
    const entries = block.split(/^- runId: /m).slice(1);
    return entries.flatMap((entry) => {
      const runId = entry.split(/\r?\n/, 1)[0]?.trim();
      if (!runId) return [];
      const field = (name: string): string | undefined =>
        new RegExp(`^  ${name}: ([^\\r\\n]*)$`, 'm').exec(entry)?.[1]?.trim();
      return [{ runId, stage: field('stage') ?? null, outcome: field('outcome') ?? null, prNumber: prNumber(field('prNumber')) }];
    });
  });
}

/** Local, read-only lookup. A bare positive integer (or #number) is a PR; all other input is an exact run ID. */
export function lookupGoal(reference: string, options: GoalLookupOptions = {}): GoalLookupResult {
  const input = reference.trim();
  const requestedPr = prNumber(input.replace(/^#/, ''));
  const requestedRunId = requestedPr === null ? input : null;
  const runsDir = options.runsDir ?? selfDevRunsDir();
  const findRun = (matches: (result: ValidResult) => boolean, wantedRunId: string | null) => {
    for (const name of filesIn(runsDir)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(name)) continue;
      let candidate: SelfDevRunState;
      try {
        candidate = JSON.parse(readFileSync(join(runsDir, name), 'utf8')) as SelfDevRunState;
      } catch { continue; }
      if (!candidate || candidate.runId !== name.slice(0, -'.json'.length) || !Array.isArray(candidate.results)) continue;
      const matchingResult = (candidate.results as unknown[]).find((result): result is ValidResult => isValidResult(result) && matches(result));
      if (matchingResult || (wantedRunId !== null && candidate.runId === wantedRunId)) {
        const runId = matchingResult?.runId ?? candidate.runId;
        const record: GoalLookupRecord | null = matchingResult
          ? { runId, stage: matchingResult.stage ?? null, outcome: null, prNumber: matchingResult.prNumber ?? null }
          : null;
        return { runState: candidate, runId, record };
      }
    }
    return null;
  };
  const found = findRun((result) => requestedPr !== null ? result.prNumber === requestedPr : result.runId === requestedRunId, requestedRunId);
  let runState: SelfDevRunState | null = found?.runState ?? null;
  const resultRunId: string | null = found?.runId ?? null;
  let runRecord: GoalLookupRecord | null = found?.record ?? null;

  const goalsDir = options.goalsDir ?? resolve(process.cwd(), 'docs', 'goals');
  let fallback: { goalFile: string; document: string; record: GoalLookupRecord } | null = null;
  let selected: { goalFile: string; document: string; record: GoalLookupRecord } | null = null;
  for (const name of filesIn(goalsDir)) {
    if (!isGoalAuthorFileName(name)) continue;
    const goalFile = join(goalsDir, name);
    let document: string;
    try { document = readFileSync(goalFile, 'utf8'); } catch { continue; }
    const records = executionRecords(document);
    const direct = records.find((candidate) => requestedPr !== null
      ? candidate.prNumber === requestedPr
      : candidate.runId === requestedRunId);
    if (direct) { selected = { goalFile, document, record: direct }; break; }
    if (requestedPr !== null && resultRunId !== null && fallback === null) {
      const record = records.find((candidate) => candidate.prNumber === null && candidate.runId === resultRunId);
      if (record) fallback = { goalFile, document, record };
    }
  }
  const match = selected ?? fallback;
  if (match) {
    const { goalFile, document, record } = match;
    // The returned run state must belong to the selected document record's run (review must-fix): re-resolve, or drop it.
    if (resultRunId !== record.runId) {
      const again = findRun((result) => result.runId === record.runId, record.runId);
      runState = again?.runState ?? null;
      runRecord = again?.record ?? null;
    }
    const body = document.split(/^## 실행 기록\s*$/m, 1)[0]!.replace(/\r?\n$/, '');
    // A kan ID is only reported when the authored document explicitly names one.
    const kanId = /^- Kan(?:Id|-ID):\s*(\S+)\s*$/im.exec(body)?.[1] ?? null;
    return {
      goalBody: body, goalFile, kanId, runId: record.runId,
      record: {
        ...record,
        ...(runRecord?.runId === record.runId ? {
          stage: record.stage ?? runRecord.stage,
          outcome: record.outcome ?? runRecord.outcome,
          prNumber: record.prNumber ?? runRecord.prNumber,
        } : {}),
      },
      runState,
    };
  }
  return { goalBody: null, goalFile: null, kanId: null, runId: resultRunId ?? requestedRunId, record: runRecord, runState };
}
