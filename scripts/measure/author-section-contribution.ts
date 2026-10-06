import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

export interface AuthorSummary {
  authorRunId: string;
  sectionChars: Record<string, number>;
}

export interface AssignedGoalEvent {
  category: string;
  event: string;
  ts: string;
  data: { authorRunId?: string; goalId?: string };
}

export interface ExecutionRun {
  runId: string;
  goalId: string;
  startedAt: string;
  outcome: string;
}

export interface SectionContribution {
  authorRunId: string;
  goalId: string;
  runId: string;
  section: string;
  chars: number;
  outcome: string;
}

/** Join an authored summary to the first execution starting after that author's assignment. */
export function measureAuthorSectionContribution(
  summaries: readonly AuthorSummary[],
  events: readonly AssignedGoalEvent[],
  runs: readonly ExecutionRun[],
): SectionContribution[] {
  const rows: SectionContribution[] = [];
  for (const summary of summaries) {
    const assignment = events.filter((event) => event.category === 'goal-author'
      && event.event === 'goal-id-assigned'
      && event.data?.authorRunId === summary.authorRunId
      && typeof event.data.goalId === 'string'
      && Number.isFinite(Date.parse(event.ts)))
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts)
        || left.data.goalId!.localeCompare(right.data.goalId!))[0];
    if (!assignment) continue;
    const assignedAt = Date.parse(assignment.ts);
    const run = runs.filter((candidate) => candidate.goalId === assignment.data.goalId
      && Number.isFinite(Date.parse(candidate.startedAt))
      && Date.parse(candidate.startedAt) >= assignedAt)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
        || left.runId.localeCompare(right.runId))[0];
    if (!run) continue;
    for (const [section, chars] of Object.entries(summary.sectionChars)) {
      rows.push({ authorRunId: summary.authorRunId, goalId: run.goalId, runId: run.runId, section, chars, outcome: run.outcome });
    }
  }
  return rows;
}

function readRunLedger(path: string): ExecutionRun[] {
  const db = new Database(path, { readonly: true });
  try {
    const records = db.query('SELECT run_id, goal_id, doc FROM goal_run').all() as Array<{ run_id: string; goal_id: string; doc: string }>;
    return records.map(({ run_id, goal_id, doc }) => {
      const record = JSON.parse(doc) as { startedAt: string; outcome: string };
      return { runId: run_id, goalId: goal_id, startedAt: record.startedAt, outcome: record.outcome };
    });
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [summaryFile, eventsFile, ledgerFile] = process.argv.slice(2);
  if (!summaryFile || !eventsFile || !ledgerFile) throw new Error('usage: bun scripts/measure/author-section-contribution.ts <summaries.json> <events.jsonl> <goal-runs.db>');
  const summaries = JSON.parse(readFileSync(summaryFile, 'utf8')) as AuthorSummary[];
  const events = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as AssignedGoalEvent);
  const rows = measureAuthorSectionContribution(summaries, events, readRunLedger(ledgerFile));
  console.log('| authorRunId | goalId | runId | section | chars | outcome |');
  console.log('| --- | --- | --- | --- | ---: | --- |');
  for (const row of rows) console.log(`| ${row.authorRunId} | ${row.goalId} | ${row.runId} | ${row.section} | ${row.chars} | ${row.outcome} |`);
}
