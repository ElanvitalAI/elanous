import { createHash } from 'node:crypto';
import { CardStore, redactSecrets, type AppendSectionInput, type CreateCardInput, type TaskCard } from '../task-cards/card-store.js';
import type { ScheduledDecision, TriageIssue } from './triage.js';
import type { HitlEntry } from './launch.js';

export interface StewardCardStore {
  createCard(input: CreateCardInput): TaskCard;
  appendSection(id: string, input: AppendSectionInput): TaskCard;
  close(): void;
}

export interface StewardCardDeps {
  store?: StewardCardStore;
  root?: string;
  now?: () => Date;
}

/** Record the first intake for each polled issue, independently of LLM triage. */
export function recordIntakeOnCards(store: StewardCardStore, issues: TriageIssue[], now: () => Date = () => new Date()): void {
  for (const issue of issues) {
    const card = store.createCard({ goalId: `linear:${issue.identifier}`, title: redactSecrets(issue.title) });
    const intakeKey = `intake:${issue.identifier}`;
    if (!card.sections.some(section => section.key === intakeKey)) {
      const directiveSource = /^출처: (telegram|pwa|tui|cli)$/m.exec(issue.body)?.[1];
      const directiveTime = /^시각: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/m.exec(issue.body)?.[1];
      store.appendSection(card.id, {
        key: intakeKey, owner: 'steward',
        content: JSON.stringify({ summary: redactSecrets(issue.title), source: directiveSource ?? `linear:${issue.identifier}`, at: directiveTime ?? now().toISOString() }),
      });
    }
  }
}

/** Record observe-only intake and the latest scheduled judgment without launching any work. */
export function recordTriageOnCards(decisions: ScheduledDecision[], issues: TriageIssue[], deps: StewardCardDeps = {}): void {
  const store = deps.store ?? new CardStore(deps.root);
  const byIssue = new Map(issues.map(issue => [issue.identifier, issue]));
  try {
    for (const decision of decisions) {
      const issue = byIssue.get(decision.issue);
      if (!issue) throw new Error(`Missing issue ${decision.issue}`);
      recordIntakeOnCards(store, [issue], deps.now);
      const card = store.createCard({ goalId: `linear:${issue.identifier}`, title: redactSecrets(issue.title) });
      const { rung, dependsOn, priority, disposition, hitlReason, why, owner } = decision;
      const judgment = { rung, dependsOn, priority, disposition: rung === 'hitl' || hitlReason ? 'hitl' : disposition, hitlReason: hitlReason ?? null, why: redactSecrets(why), ...(owner ? { owner } : {}), ...(decision.capability ? { capability: decision.capability } : {}) };
      const key = `triage:${createHash('sha256').update(JSON.stringify(judgment)).digest('hex')}`;
      if (!card.sections.some(section => section.key === key)) {
        store.appendSection(card.id, { key, owner: 'steward', content: JSON.stringify(judgment) });
      }
    }
  } finally {
    if (!deps.store) store.close();
  }
}

function recordOnCard(section: 'launch' | 'outcome' | 'hitl', issue: Pick<TriageIssue, 'identifier' | 'title'>, value: object, deps: StewardCardDeps): void {
  const store = deps.store ?? new CardStore(deps.root);
  try {
    const content = redactSecrets(JSON.stringify(value));
    const key = `${section}:${createHash('sha256').update(content).digest('hex')}`;
    const card = store.createCard({ goalId: `linear:${issue.identifier}`, title: redactSecrets(issue.title) });
    if (!card.sections.some(item => item.key === key)) {
      store.appendSection(card.id, { key, owner: 'steward', content });
    }
  } finally {
    if (!deps.store) store.close();
  }
}

/** Append a launch revision to the issue card; an identical retry keeps its original section. */
export function recordLaunchOnCard(issue: Pick<TriageIssue, 'identifier' | 'title'>, launch: object, deps: StewardCardDeps = {}): void {
  recordOnCard('launch', issue, launch, deps);
}

/** Append an outcome revision to the issue card without replacing earlier sections. */
export function recordOutcomeOnCard(issue: Pick<TriageIssue, 'identifier' | 'title'>, outcome: object, deps: StewardCardDeps = {}): void {
  recordOnCard('outcome', issue, outcome, deps);
}

/** Append a HITL handoff revision (pending → raised/unavailable) to the issue card. */
export function recordHitlOnCard(issue: Pick<TriageIssue, 'identifier' | 'title'>, entry: HitlEntry, deps: StewardCardDeps = {}): void {
  recordOnCard('hitl', issue, entry, deps);
}
