import { expect, test } from 'bun:test';
import evidence from './coo-admin-dates.evidence.json';
import { compareCooEvidence } from '../../scripts/verify-coo-admin-evidence.js';
import { recheckCooAdminLeads } from '../../scripts/research-coo-admin-dates.js';
import type { LinearProjectIssue } from '../connectors/linear.js';

type Issue = LinearProjectIssue & { createdAt: string };
type RecordShape = Parameters<typeof compareCooEvidence>[0];
const recorded = evidence as RecordShape;
const liveFixture: Issue[] = [
  ...recorded.verifiedIssues.map(row => ({...row, dueDate: row.existingDueDate, state: {name:'Backlog',type:'backlog'}, assignee: null})),
  ...recorded.cohort.excludedCurrentIssues.map(row => ({...row, title: row.identifier, updatedAt: '', state: {name:'Backlog',type:'backlog'}, assignee: null})),
];

test('evidence has per-issue search results but no ungrounded dates', () => {
  expect(recorded.verifiedIssues).toHaveLength(29);
  expect(evidence.research.issueChecks.map(row => row.identifier)).toEqual(recorded.verifiedIssues.map(row => row.identifier));
  expect(evidence.research.issueChecks.every(row => row.query && row.engine === 'omni-crawl/firecrawl' && row.finding && row.officialDeadline === null)).toBe(true);
  expect(evidence.verifiedIssues.every(row => row.officialDeadline === null && row.preparationPeriod === null && row.representativeActionDate === null)).toBe(true);
  expect(evidence.unverified.some(reason => reason.includes('Historical request membership'))).toBe(true);
});

test('comparison rejects a changed Linear dueDate, priority, URL, identity, and cohort', () => {
  expect(compareCooEvidence(recorded, liveFixture, false)).toEqual([]);
  const mutate = (identifier: string, change: Partial<Issue>): Issue[] => liveFixture.map(row => row.identifier === identifier ? {...row, ...change} : row);
  expect(compareCooEvidence(recorded, mutate('ELA-22', {dueDate: '2026-10-24'}), false)).toContain('ELA-22 dueDate: recorded=2026-10-23 Linear=2026-10-24');
  expect(compareCooEvidence(recorded, mutate('ELA-23', {priority: 3}), false)).toContain('ELA-23 priority: recorded=1 Linear=3');
  expect(compareCooEvidence(recorded, mutate('ELA-22', {url: 'https://linear.app/fake'}), false).some(error => error.includes('ELA-22 url:'))).toBe(true);
  expect(compareCooEvidence(recorded, mutate('ELA-22', {identifier: 'ELA-999'}), false)).toContain('not in Linear: ELA-22');
  expect(compareCooEvidence(recorded, mutate('ELA-50', {createdAt: '2026-10-07T00:00:00Z'}), false)).toContain('recorded identifiers differ from oldest 29 currently open by createdAt');
  expect(compareCooEvidence(recorded, liveFixture, true)).toContain('Linear result truncated');
});

test('recheck counts only recorded URLs found, and reports missing URLs separately', async () => {
  const checks = evidence.research.issueChecks;
  const searched: string[] = [];
  const lines = await recheckCooAdminLeads(checks, async (query, options) => {
    expect(options.limit).toBe(3);
    searched.push(query);
    const check = checks.find(row => row.query === query)!;
    return { items: check.inspectedLead ? [{url: check.inspectedLead.url}] : [] };
  });
  const withUrl = checks.filter(row => row.inspectedLead !== null).length;
  const withoutUrl = checks.length - withUrl;
  expect(withUrl).toBe(16);
  expect(withoutUrl).toBe(13);
  expect(searched).toEqual(checks.map(row => row.query));
  expect(lines.filter(line => line.includes('recordedUrlVerified=true'))).toHaveLength(withUrl);
  expect(lines.filter(line => line.includes('recordedUrl=none (not verified)'))).toHaveLength(withoutUrl);
  expect(lines.at(-1)).toBe(`SEARCH checked=29 recordedUrlVerified=${withUrl}/${withUrl} noRecordedUrl=${withoutUrl} recordedUrlNotInCurrentTop3=0 (search rankings change; no official date inferred)`);

  const missing = await recheckCooAdminLeads(checks.slice(0, 2), async () => ({items: []}));
  expect(missing.at(-1)).toBe('SEARCH checked=2 recordedUrlVerified=0/2 noRecordedUrl=0 recordedUrlNotInCurrentTop3=2 (search rankings change; no official date inferred)');
});
