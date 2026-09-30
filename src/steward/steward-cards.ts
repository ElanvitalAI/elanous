import { createHash } from 'node:crypto';
import { CardStore, redactSecrets, type AppendSectionInput, type CreateCardInput, type TaskCard } from '../task-cards/card-store.js';
import type { ScheduledDecision, TriageIssue } from './triage.js';

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

/** Record observe-only intake and the latest scheduled judgment without launching any work. */
export function recordTriageOnCards(decisions: ScheduledDecision[], issues: TriageIssue[], deps: StewardCardDeps = {}): void {
  const store = deps.store ?? new CardStore(deps.root);
  const byIssue = new Map(issues.map(issue => [issue.identifier, issue]));
  try {
    for (const decision of decisions) {
      const issue = byIssue.get(decision.issue);
      if (!issue) throw new Error(`Missing issue ${decision.issue}`);
      const card = store.createCard({ goalId: `linear:${issue.identifier}`, title: redactSecrets(issue.title) });
      const intakeKey = `intake:${issue.identifier}`;
      if (!card.sections.some(section => section.key === intakeKey)) {
        const directiveSource = /^출처: (telegram|pwa|tui|cli)$/m.exec(issue.body)?.[1];
        const directiveTime = /^시각: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/m.exec(issue.body)?.[1];
        store.appendSection(card.id, {
          key: intakeKey, owner: 'steward',
          content: JSON.stringify({ summary: redactSecrets(issue.title), source: directiveSource ?? `linear:${issue.identifier}`, at: directiveTime ?? (deps.now ?? (() => new Date()))().toISOString() }),
        });
      }
      const { rung, dependsOn, priority, disposition, hitlReason, why, owner } = decision;
      const judgment = { rung, dependsOn, priority, disposition: rung === 'hitl' || hitlReason ? 'hitl' : disposition, hitlReason: hitlReason ?? null, why: redactSecrets(why), ...(owner ? { owner } : {}) };
      const key = `triage:${createHash('sha256').update(JSON.stringify(judgment)).digest('hex')}`;
      if (!card.sections.some(section => section.key === key)) {
        store.appendSection(card.id, { key, owner: 'steward', content: JSON.stringify(judgment) });
      }
    }
  } finally {
    if (!deps.store) store.close();
  }
}
