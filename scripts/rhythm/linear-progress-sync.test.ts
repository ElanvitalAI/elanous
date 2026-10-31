import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checklist } from '../../src/release-loop/checklist.js';
import type { DecisionEntry } from '../../src/decisions/decision-ledger.js';
import { renderProgressPreview, resolveExplicitProgressLinks, runLinearProgressSync, type ProgressIssue } from './linear-progress-sync.js';

const checklist = (items: Checklist['items']): Checklist => ({
  version: '0.2.43', released: '0.2.42', dev: '0.2.43-dev.0', items, history: [],
});
const item = (id: string, title: string, status: Checklist['items'][number]['status'] = 'yellow', evidence?: string): Checklist['items'][number] => ({
  id, title, status, updatedAt: '2026-10-30T00:00:00.000Z', updatedBy: 'OPT', ...(evidence ? { evidence } : {}),
});
const issue = (identifier: string, description = ''): ProgressIssue => ({
  id: `uuid-${identifier}`, identifier, title: `Issue ${identifier}`, url: `https://linear.example/${identifier}`,
  state: 'Todo', description,
});

describe('LINEAR-PROGRESS-SYNC explicit references', () => {
  test('links exact issue IDs from checklist fields and exact cell IDs from issue descriptions only', () => {
    const board = checklist([
      item('GOAL-CASCADE1', 'Review patent', 'yellow', 'linear-ref: ELA-53'),
      item('LINEAR-PROGRESS-SYNC', 'Daily summaries; unrelated PR #33494', 'yellow', 'Mentions ELA-23 as an example, not a link.'),
      item('DEMO1104-ABSORB-BRIEFING', 'Briefing integration'),
    ]);
    const links = resolveExplicitProgressLinks([
      issue('ELA-53'), issue('ELA-23'), issue('DEMO-1', 'Direct ref: DEMO1104-ABSORB-BRIEFING'),
    ], board);
    expect(links.map(link => link.issue.identifier)).toEqual(['ELA-53', 'DEMO-1']);
    expect(links[0]?.sources).toContainEqual({ cellId: 'GOAL-CASCADE1', field: 'checklist.evidence' });
    expect(links[1]?.sources).toContainEqual({ cellId: 'DEMO1104-ABSORB-BRIEFING', field: 'issue.description' });
  });

  test('marks a simulated green cell as green(sim) in the public preview', () => {
    const board = checklist([item('DEMO1104-ABSORB-BRIEFING', 'briefing', 'green', 'OP approved green(sim). Installed CLI E4 remains incomplete.')]);
    const link = resolveExplicitProgressLinks([issue('DEMO-1', 'DEMO1104-ABSORB-BRIEFING')], board)[0]!;
    const preview = renderProgressPreview(link, board, '2026-10-30');
    expect(preview.body).toContain('DEMO1104-ABSORB-BRIEFING — green(sim)');
    expect(preview.body).toContain('설치본 E4 미완');
  });

  test('exposes IDs and states but never cell, decision, issue, or next-task titles', () => {
    const board = checklist([
      item('CELL-LINKED', 'CONFIDENTIAL CELL TITLE: patent strategy', 'green', 'linear-ref: ELA-53 · PR #42 merged'),
      item('CELL-NEXT', 'CONFIDENTIAL NEXT TASK TITLE: source details', 'yellow', 'linear-ref: ELA-53'),
    ]);
    const decision: DecisionEntry = {
      id: 'D-PRIVATE-1', title: 'CONFIDENTIAL DECISION TITLE', category: 'scope',
      scqa: { s: 'private context', c: 'private details' }, options: [],
      recommendation: { skipped: true, reason: 'private rationale' },
      raisedBy: { agent: 'OP' }, refs: ['ELA-53'], status: 'decided',
      pendingQuestion: 'CONFIDENTIAL DECISION PROSE', decidedAt: '2026-10-30T02:00:00.000Z',
      history: [{ type: 'decided', at: '2026-10-30T02:00:00.000Z', by: 'OP' }],
    };
    const linkedIssue = { ...issue('ELA-53'), title: 'CONFIDENTIAL LINEAR ISSUE TITLE', description: 'CONFIDENTIAL ISSUE DESCRIPTION' };
    const link = resolveExplicitProgressLinks([linkedIssue], board, [decision])[0]!;
    const preview = renderProgressPreview(link, board, '2026-10-30');
    expect(preview.body).toContain('CELL-LINKED — green');
    expect(preview.body).toContain('CELL-NEXT — yellow');
    expect(preview.body).toContain('D-PRIVATE-1 — decided');
    expect(preview.body).toContain('#42');
    for (const privateText of [
      'CONFIDENTIAL CELL TITLE', 'CONFIDENTIAL NEXT TASK TITLE', 'CONFIDENTIAL DECISION TITLE',
      'CONFIDENTIAL DECISION PROSE', 'CONFIDENTIAL LINEAR ISSUE TITLE', 'CONFIDENTIAL ISSUE DESCRIPTION',
      'patent strategy', 'private rationale',
    ]) expect(preview.body).not.toContain(privateText);
  });

  test('does not post when the same-day marker already exists', async () => {
    const board = checklist([item('DEMO1104-ABSORB-BRIEFING', 'briefing')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-'));
    const postCalls: string[] = [];
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        issues: [issue('DEMO-1', 'DEMO1104-ABSORB-BRIEFING')], decisions: [],
        getApiKey: async () => 'test-key', countMarker: async () => 1,
        postComment: async candidate => { postCalls.push(candidate.identifier); },
        apply: true, allowIssueIdentifiers: ['DEMO-1'],
      });
      expect(result.alreadyPresent).toEqual(['DEMO-1']);
      expect(result.posted).toEqual([]);
      expect(postCalls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('posts only after an empty marker check and confirms exactly one marker afterward', async () => {
    const board = checklist([item('DEMO1104-ABSORB-BRIEFING', 'briefing')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-post-'));
    const checks: number[] = [];
    const posts: string[] = [];
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        issues: [issue('DEMO-1', 'DEMO1104-ABSORB-BRIEFING')], decisions: [],
        getApiKey: async () => 'test-key', countMarker: async () => { checks.push(0); return checks.length === 1 ? 0 : 1; },
        postComment: async (_candidate, body) => { posts.push(body); },
        apply: true, allowIssueIdentifiers: ['DEMO-1'],
      });
      expect(result.posted).toEqual(['DEMO-1']);
      expect(result.failures).toEqual([]);
      expect(checks).toHaveLength(2);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain('<!-- elanous-linear-progress:2026-10-30:DEMO-1 -->');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed on pre-existing duplicate markers without posting', async () => {
    const board = checklist([item('DEMO1104-ABSORB-BRIEFING', 'briefing')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-duplicate-'));
    let posts = 0;
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        issues: [issue('DEMO-1', 'DEMO1104-ABSORB-BRIEFING')], decisions: [],
        getApiKey: async () => 'test-key', countMarker: async () => 2,
        postComment: async () => { posts++; }, apply: true, allowIssueIdentifiers: ['DEMO-1'],
      });
      expect(result.failures).toEqual([{ identifier: 'DEMO-1', reason: 'duplicate-marker-count=2' }]);
      expect(posts).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records a failed post-verification when one marker is not observed', async () => {
    const board = checklist([item('DEMO1104-ABSORB-BRIEFING', 'briefing')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-verify-'));
    let checks = 0;
    let posts = 0;
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        issues: [issue('DEMO-1', 'DEMO1104-ABSORB-BRIEFING')], decisions: [],
        getApiKey: async () => 'test-key', countMarker: async () => { checks++; return 0; },
        postComment: async () => { posts++; }, apply: true, allowIssueIdentifiers: ['DEMO-1'],
      });
      expect(checks).toBe(2);
      expect(posts).toBe(1);
      expect(result.posted).toEqual([]);
      expect(result.failures).toEqual([{ identifier: 'DEMO-1', reason: 'post-verification-marker-count=0' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records an allowlisted issue missing from an injected issue inventory', async () => {
    const board = checklist([item('DEMO1104-ABSORB-BRIEFING', 'briefing')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-missing-'));
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        issues: [issue('DEMO-1', 'DEMO1104-ABSORB-BRIEFING')], decisions: [],
        getApiKey: async () => 'test-key', countMarker: async () => 1,
        apply: true, allowIssueIdentifiers: ['DEMO-1', 'ELA-53'],
      });
      expect(result.failures).toEqual([{ identifier: 'ELA-53', reason: 'allowlisted issue not found' }]);
      expect(result.alreadyPresent).toEqual(['DEMO-1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
