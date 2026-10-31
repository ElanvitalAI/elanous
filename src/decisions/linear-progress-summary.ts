import type { DecisionEntry } from './decision-ledger.js';
import type { Checklist, ChecklistHistory, ChecklistItem } from '../release-loop/checklist.js';

const LINEAR_ISSUE = /\bELA-[A-Z0-9]+\b/gi;
const PULL_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

export interface LinearProgressSummary {
  issue: string;
  day: string;
  body: string;
}

function issueRefs(text: string): string[] {
  return [...new Set(text.match(LINEAR_ISSUE) ?? [])].map(value => value.toUpperCase());
}

function eventIssues(item: ChecklistItem): string[] {
  return issueRefs(`${item.title}\n${item.evidence ?? ''}\n${item.refs?.join('\n') ?? ''}`);
}

function short(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) : '미상';
}

/** Build non-sensitive daily summaries from local ledgers; this function performs no network or file writes. */
export function buildLinearProgressSummaries(input: {
  checklist: Checklist;
  history: readonly ChecklistHistory[];
  decisions: readonly DecisionEntry[];
  since: string;
  now?: Date;
}): LinearProgressSummary[] {
  const since = Date.parse(input.since);
  if (!Number.isFinite(since)) throw new Error('since must be a valid timestamp');
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const cells = new Map(input.checklist.items.map(item => [item.id, item]));
  const grouped = new Map<string, string[]>();
  const add = (issue: string, line: string) => {
    const lines = grouped.get(issue) ?? [];
    if (!lines.includes(line)) lines.push(line);
    grouped.set(issue, lines);
  };

  for (const event of input.history) {
    if (Date.parse(event.at) < since) continue;
    const item = cells.get(event.id);
    if (!item || event.field !== 'status') continue;
    for (const issue of eventIssues(item)) add(issue, `칸 ${item.id}: ${short(event.from)} → ${short(event.to)}`);
  }

  for (const decision of input.decisions) {
    const changed = decision.history.filter(event => event.at && Date.parse(event.at) >= since);
    if (!changed.length) continue;
    for (const ref of decision.refs ?? []) for (const issue of issueRefs(ref)) {
      const latest = changed.at(-1)!;
      add(issue, `결정 ${decision.id}: ${latest.type === 'decided' ? `확정 ${short(latest.choice)}` : latest.type}`);
    }
  }

  for (const item of input.checklist.items) {
    if (item.status === 'green' || item.status === 'done') continue;
    for (const issue of eventIssues(item)) add(issue, `다음: ${item.id}`);
  }

  for (const event of input.history) {
    if (Date.parse(event.at) < since || !['evidence', 'evidence.add'].includes(event.field)) continue;
    const item = cells.get(event.id);
    if (!item) continue;
    const pulls = String(event.to ?? '').match(PULL_URL) ?? [];
    for (const issue of eventIssues(item)) for (const url of pulls) add(issue, `PR: ${url}`);
  }

  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([issue, lines]) => {
    const body = [`진행 요약 · ${day}`, ...lines].join('\n');
    return { issue, day, body };
  });
}
