import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordHitlOnCard, recordLaunchOnCard, recordOutcomeOnCard, recordTriageOnCards, type StewardCardStore } from './steward-cards.js';
import { scheduleTriage, triageIssues, type ScheduledDecision, type TriageIssue } from './triage.js';
import { CardStore, foldSections, type TaskCard } from '../task-cards/card-store.js';

const issues: TriageIssue[] = [
  { identifier: 'ELA-1', ref: 'one', title: 'Build', body: 'source detail' },
  { identifier: 'ELA-2', ref: 'two', title: 'Review', body: 'source detail' },
  { identifier: 'ELA-3', ref: 'three', title: '유료 판매', body: 'private-token' },
];
const decisions: ScheduledDecision[] = [
  { issue: 'ELA-1', rung: 4, dependsOn: [], priority: 1, disposition: 'now', why: 'build it' },
  { issue: 'ELA-2', rung: 4, dependsOn: ['ELA-1'], priority: 2, disposition: 'wait', why: 'after build' },
  { issue: 'ELA-3', rung: 'hitl', hitlReason: 'money', dependsOn: [], priority: 3, disposition: 'hitl', why: 'human approval' },
];

function fakeStore(): StewardCardStore & { cards: TaskCard[] } {
  const cards: TaskCard[] = [];
  return {
    cards,
    createCard({ goalId, title }) {
      let card = cards.find(item => item.goalId === goalId);
      if (!card) {
        card = { id: String(cards.length + 1), goalId, title, status: 'open', createdAt: '', sections: [] };
        cards.push(card);
      }
      return card;
    },
    appendSection(id, { key, owner, content }) {
      const card = cards.find(item => item.id === id)!;
      if (!card.sections.some(item => item.key === key)) card.sections.push({ key, owner, content, createdAt: '' });
      return card;
    },
    close() {},
  };
}

test('three judgments create three cards, two steward-owned sections each; retries keep their count and HITL status', () => {
  const store = fakeStore();
  const deps = { store, now: () => new Date('2026-09-28T00:00:00Z') };
  recordTriageOnCards(decisions, issues, deps);
  recordTriageOnCards(decisions, issues, deps);
  expect(store.cards).toHaveLength(3);
  for (const [index, card] of store.cards.entries()) {
    expect(card.goalId).toBe(`linear:ELA-${index + 1}`);
    expect(card.sections).toHaveLength(2);
    expect(card.sections.map(section => section.key.split(':')[0])).toEqual(['intake', 'triage']);
    expect(card.sections.every(section => section.owner === 'steward')).toBe(true);
    expect(JSON.parse(card.sections[0]!.content)).toEqual({ summary: issues[index]!.title, source: card.goalId, at: '2026-09-28T00:00:00.000Z' });
  }
  expect(JSON.parse(store.cards[2]!.sections[1]!.content)).toEqual({ rung: 'hitl', dependsOn: [], priority: 3, disposition: 'hitl', hitlReason: 'money', why: 'human approval' });
  expect(JSON.stringify(store.cards)).not.toContain('private-token');
});

test('changing a single factual judgment field yields a distinct triage key', () => {
  const store = fakeStore();
  recordTriageOnCards(decisions.slice(0, 1), issues, { store });
  recordTriageOnCards([{ ...decisions[0]!, why: 'Build it' }], issues, { store });
  expect(store.cards[0]!.sections.map(section => section.key.split(':')[0])).toEqual(['intake', 'triage', 'triage']);
});

test('intake preserves directive source and time without copying its private body', () => {
  const store = fakeStore();
  recordTriageOnCards(decisions.slice(0, 1), [{ ...issues[0]!, body: 'secret body\n\n출처: telegram\n시각: 2026-09-28T09:00:00.000Z\n[directive-hash:private]' }], { store });
  expect(JSON.parse(store.cards[0]!.sections[0]!.content)).toEqual({ summary: 'Build', source: 'telegram', at: '2026-09-28T09:00:00.000Z' });
  expect(JSON.stringify(store.cards)).not.toContain('secret body');
});

test('changed judgment appends a new triage revision, not another intake', () => {
  const store = fakeStore();
  recordTriageOnCards(decisions.slice(0, 1), issues, { store });
  recordTriageOnCards([{ ...decisions[0]!, priority: 0 }], issues, { store });
  expect(store.cards[0]!.sections.map(section => section.key.split(':')[0])).toEqual(['intake', 'triage', 'triage']);
});

test('card content redacts secret-shaped titles and judgment rationale', () => {
  const store = fakeStore();
  const token = `sk-${'x'.repeat(20)}`;
  recordTriageOnCards([{ ...decisions[0]!, why: `why ${token}` }], [{ ...issues[0]!, title: `Build ${token}` }], { store });
  expect(JSON.stringify(store.cards)).not.toContain(token);
  expect(JSON.stringify(store.cards)).toContain('<redacted>');
});

test('money, public, security and irreversible judgments remain HITL on cards', async () => {
  const input: TriageIssue[] = ['유료 결제', '공개 발행', '키 교체', '영구 삭제'].map((title, index) => ({ identifier: `ELA-${index + 11}`, ref: String(index), title, body: '' }));
  const decisions = await triageIssues(input, async () => ({ rung: 4, dependsOn: [], priority: 1, why: 'execute' }), () => true);
  const store = fakeStore();
  recordTriageOnCards(scheduleTriage(decisions), input, { store });
  expect(store.cards).toHaveLength(4);
  expect(store.cards.map(card => JSON.parse(card.sections[1]!.content).hitlReason)).toEqual(['money', 'public', 'security', 'irreversible']);
  expect(store.cards.every(card => JSON.parse(card.sections[1]!.content).disposition === 'hitl')).toBe(true);
});

test('launch, outcome and HITL sections are steward-owned and idempotent', () => {
  const store = fakeStore();
  const entry = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'would launch', status: 'shadow' as const };
  recordLaunchOnCard(issues[0]!, entry, { store });
  recordLaunchOnCard(issues[0]!, entry, { store });
  recordOutcomeOnCard(issues[0]!, { ...entry, status: 'merged', prNumber: 42 }, { store });
  recordOutcomeOnCard(issues[0]!, { ...entry, status: 'merged', prNumber: 42 }, { store });
  recordHitlOnCard(issues[0]!, { issue: 'ELA-1', reason: 'money', raised: false }, { store });
  recordHitlOnCard(issues[0]!, { issue: 'ELA-1', reason: 'money', raised: false }, { store });
  expect(store.cards[0]!.sections.map(section => section.key.split(':')[0])).toEqual(['launch', 'outcome', 'hitl']);
  expect(store.cards[0]!.sections.every(section => section.owner === 'steward')).toBe(true);
});

test('shadow HITL pending then live raised appends one status transition, not duplicates', () => {
  const store = fakeStore();
  const pending = { issue: 'ELA-1', reason: 'security', raised: false };
  recordHitlOnCard(issues[0]!, pending, { store });
  recordHitlOnCard(issues[0]!, pending, { store });
  const raised = { ...pending, attempted: true, raised: true };
  recordHitlOnCard(issues[0]!, raised, { store });
  recordHitlOnCard(issues[0]!, raised, { store });
  expect(store.cards[0]!.sections).toHaveLength(2);
  expect(store.cards[0]!.sections.map(section => JSON.parse(section.content).raised)).toEqual([false, true]);
});

test('budget skip then actual launch appends distinct revisions without duplicating either', () => {
  const store = fakeStore();
  const entry = { issue: 'ELA-1', title: 'Build', source: 'cli', command: 'say', status: 'skipped-budget' as const, reason: 'quota' };
  recordLaunchOnCard(issues[0]!, entry, { store });
  recordLaunchOnCard(issues[0]!, entry, { store });
  recordLaunchOnCard(issues[0]!, { ...entry, status: 'launched', runId: 'run-test' }, { store });
  recordLaunchOnCard(issues[0]!, { ...entry, status: 'launched', runId: 'run-test' }, { store });
  expect(store.cards[0]!.sections).toHaveLength(2);
  expect(store.cards[0]!.sections.map(section => JSON.parse(section.content).status)).toEqual(['skipped-budget', 'launched']);
});

test('a forced HITL rung cannot be written as now even from an inconsistent schedule', () => {
  const store = fakeStore();
  recordTriageOnCards([{ ...decisions[2]!, disposition: 'now' }], issues, { store });
  expect(JSON.parse(store.cards[0]!.sections[1]!.content).disposition).toBe('hitl');
});

test('launch and outcome updates preserve intake, triage and other content without duplicate keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-card-recorders-'));
  try {
    recordTriageOnCards(decisions.slice(0, 1), issues, { root });
    const store = new CardStore(root);
    try {
      const original = store.createCard({ goalId: 'linear:ELA-1', title: 'ignored on retry' });
      store.appendSection(original.id, { key: 'incidents:existing', owner: 'reviewer', content: 'keep this verbatim' });
      const before = store.getCard(original.id)!;
      const launch = { status: 'shadow', command: 'bun run something' };
      const outcome = { status: 'completed', runId: 'run-1' };
      recordLaunchOnCard(issues[0]!, launch, { root });
      recordLaunchOnCard(issues[0]!, launch, { store });
      recordOutcomeOnCard(issues[0]!, outcome, { root });
      recordOutcomeOnCard(issues[0]!, outcome, { store });
      const card = store.getCard(original.id)!;
      expect(card.title).toBe(before.title);
      expect(card.sections.slice(0, before.sections.length)).toEqual(before.sections);
      expect(card.sections.map(section => section.key.split(':')[0])).toEqual(['intake', 'triage', 'incidents', 'launch', 'outcome']);
      expect(new Set(card.sections.map(section => section.key)).size).toBe(card.sections.length);
      expect(JSON.parse(foldSections(card).launch!.content)).toEqual(launch);
      expect(JSON.parse(foldSections(card).outcome!.content)).toEqual(outcome);

      recordLaunchOnCard(issues[0]!, { status: 'live', runId: 'run-1' }, { store });
      recordOutcomeOnCard(issues[0]!, { status: 'failed', runId: 'run-1' }, { store });
      const revised = store.getCard(original.id)!;
      expect(revised.sections.slice(0, card.sections.length)).toEqual(card.sections);
      expect(new Set(revised.sections.map(section => section.key)).size).toBe(revised.sections.length);
      expect(JSON.parse(foldSections(revised).launch!.content)).toEqual({ status: 'live', runId: 'run-1' });
      expect(JSON.parse(foldSections(revised).outcome!.content)).toEqual({ status: 'failed', runId: 'run-1' });
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launch and outcome recorders redact secrets before storing and deduplicating sections', () => {
  const store = fakeStore();
  const token = `sk-${'x'.repeat(20)}`;
  const issue = { identifier: 'ELA-4', title: `Secret ${token}` };
  recordLaunchOnCard(issue, { command: `launch ${token}` }, { store });
  recordLaunchOnCard(issue, { command: `launch ${token}` }, { store });
  recordOutcomeOnCard(issue, { reason: `failed ${token}` }, { store });
  recordOutcomeOnCard(issue, { reason: `failed ${token}` }, { store });
  expect(store.cards).toHaveLength(1);
  expect(store.cards[0]!.sections.map(section => section.key.split(':')[0])).toEqual(['launch', 'outcome']);
  expect(JSON.stringify(store.cards)).not.toContain(token);
  expect(store.cards[0]!.title).toContain('<redacted>');
});
