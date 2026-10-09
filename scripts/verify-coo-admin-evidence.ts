import { readFile } from 'node:fs/promises';
import { fetchLinearProjectIssues, type LinearProjectIssue } from '../src/connectors/linear.js';

type RecordedIssue = {
  identifier: string; title: string; url: string; createdAt: string; updatedAt: string;
  existingDueDate: string | null; priority: number;
};
type Evidence = {
  project: string;
  verifiedIssues: RecordedIssue[];
  cohort: { excludedCurrentIssues: Array<{identifier: string; url: string; dueDate: string | null; priority: number; createdAt: string}> };
};
type LiveIssue = LinearProjectIssue & { createdAt: string };

export function compareCooEvidence(record: Evidence, live: LiveIssue[], truncated: boolean): string[] {
  const errors: string[] = [];
  if (truncated) errors.push('Linear result truncated');
  if (live.length !== 33) errors.push(`current open count: ${live.length} != 33`);
  if (record.verifiedIssues.length !== 29) errors.push(`recorded count: ${record.verifiedIssues.length} != 29`);
  const sorted = [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const selected = sorted.slice(0, 29);
  const excluded = sorted.slice(29);
  const actual = new Map(live.map(issue => [issue.identifier, issue]));
  if (actual.size !== live.length) errors.push('duplicate Linear identifier');
  const seen = new Set<string>();
  for (const row of record.verifiedIssues) {
    if (seen.has(row.identifier)) errors.push(`duplicate recorded identifier: ${row.identifier}`);
    seen.add(row.identifier);
    const issue = actual.get(row.identifier);
    if (!issue) { errors.push(`not in Linear: ${row.identifier}`); continue; }
    for (const [field, expected, value] of [
      ['title', row.title, issue.title], ['url', row.url, issue.url],
      ['createdAt', row.createdAt, issue.createdAt], ['updatedAt', row.updatedAt, issue.updatedAt],
      ['dueDate', row.existingDueDate, issue.dueDate], ['priority', row.priority, issue.priority],
    ] as const) if (expected !== value) errors.push(`${row.identifier} ${field}: recorded=${String(expected)} Linear=${String(value)}`);
  }
  const selectedIds = selected.map(issue => issue.identifier).sort().join(',');
  if ([...seen].sort().join(',') !== selectedIds) errors.push('recorded identifiers differ from oldest 29 currently open by createdAt');
  if (selected.filter(issue => issue.dueDate !== null).length !== 4) errors.push('Linear selected dueDate count != 4');
  if (selected.filter(issue => issue.priority !== 0).length !== 7) errors.push('Linear selected priority count != 7');
  const excludedRecorded = record.cohort.excludedCurrentIssues;
  if (excludedRecorded.map(issue => issue.identifier).sort().join(',') !== excluded.map(issue => issue.identifier).sort().join(',')) errors.push('excluded identifiers differ from Linear');
  for (const row of excludedRecorded) {
    const issue = actual.get(row.identifier);
    if (!issue) continue;
    if (row.url !== issue.url || row.createdAt !== issue.createdAt || row.dueDate !== issue.dueDate || row.priority !== issue.priority) errors.push(`excluded ${row.identifier} differs from Linear`);
  }
  return errors;
}

// Linear GraphQL read-only fetchLinearProjectIssues resolves the project and paginates the open issues.
// createdAt is queried separately because the shared COO tool's projection does not include it.
export async function readLiveCooIssues(apiKey: string, project: string): Promise<{ issues: LiveIssue[]; truncated: boolean }> {
  const issues = await fetchLinearProjectIssues({apiKey, project});
  const identifiers = issues.map(issue => issue.identifier);
  if (new Set(identifiers).size !== identifiers.length) throw new Error('duplicate Linear identifier');
  const query = 'query CooIssueCreation($id: String!) { issue(id: $id) { identifier createdAt } }';
  const creations = await Promise.all(identifiers.map(async identifier => {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: {Authorization: apiKey, 'Content-Type': 'application/json'},
      body: JSON.stringify({query, variables: {id: identifier}}),
    });
    if (!response.ok) throw new Error(`Linear creation read HTTP ${response.status}`);
    const body = await response.json() as { errors?: unknown[]; data?: {issue?: {identifier: string; createdAt: string}} };
    if (body.errors?.length || body.data?.issue?.identifier !== identifier || !body.data.issue.createdAt) throw new Error(`Linear creation read failed: ${identifier}`);
    return body.data.issue.createdAt;
  }));
  return {issues: issues.map((issue, index) => ({...issue, createdAt: creations[index]!})), truncated: issues.truncated};
}

if (import.meta.main) {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) throw new Error('LINEAR_API_KEY absent; cannot compare recorded evidence to live Linear');
  const record = JSON.parse(await readFile(new URL('../src/domains/coo-admin-dates.evidence.json', import.meta.url), 'utf8')) as Evidence;
  const {issues, truncated} = await readLiveCooIssues(apiKey, record.project);
  const errors = compareCooEvidence(record, issues, truncated);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`PASS Linear live comparison: open=${issues.length} selected=${record.verifiedIssues.length} dueDates=${record.verifiedIssues.filter(issue => issue.existingDueDate !== null).length} priorities=${record.verifiedIssues.filter(issue => issue.priority !== 0).length} excluded=${record.cohort.excludedCurrentIssues.length}`);
  }
}
