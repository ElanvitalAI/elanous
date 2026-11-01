import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Checklist } from '../../src/release-loop/checklist.js';
import type { DecisionEntry } from '../../src/decisions/decision-ledger.js';
import { renderProgressPreview, resolveExplicitProgressLinks, runLinearProgressSync, type ProgressIssue } from './linear-progress-sync.js';

const checklist = (items: Checklist['items']): Checklist => ({
  version: '0.2.43', released: '0.2.42', dev: '0.2.43-dev.0', items, history: [],
});
const item = (id: string, title: string, status: Checklist['items'][number]['status'] = 'yellow', evidence?: string): Checklist['items'][number] => ({
  id, title, status, updatedAt: '2026-10-30T00:00:00.000Z', updatedBy: 'OPT', ...(evidence ? { evidence } : {}),
});
const issue = (identifier: string, description = '', teamKey = 'DEMO'): ProgressIssue => ({
  id: `uuid-${identifier}`, identifier, title: `Issue ${identifier}`, url: `https://linear.example/${identifier}`,
  state: 'Todo', description, teamKey,
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

  test('mock ELA progress transition requests one summary comment and emits a runId event', async () => {
    const runId = 'run-linear-progress-mock-e4-0244';
    const day = '2026-11-01';
    const cellId = 'LINEAR-PROGRESS-SYNC';
    const board = checklist([item(cellId, 'Daily progress sync', 'green', 'PR #33703 merged · green(sim)')]);
    board.history.push({ at: '2026-11-01T02:00:00.000Z', by: 'OPT', id: cellId, field: 'status',
      from: 'yellow', to: 'green', released: '0.2.43', dev: '0.2.43-dev.0' });
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-mock-e4-'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const requests: Array<{ identifier: string; body: string }> = [];
    const markerReads: number[] = [];
    const timeline: string[] = [];
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-11-01T03:00:00.000Z'), root, runId, checklist: board,
        issues: [issue('DEMO-1', cellId, 'DEMO')], decisions: [], getApiKey: async () => 'mock-only',
        countMarker: async () => {
          const count = markerReads.length === 0 ? 0 : 1;
          markerReads.push(count);
          timeline.push(`marker:${count}`);
          return count;
        },
        postComment: async (candidate, body) => {
          timeline.push('request');
          requests.push({ identifier: candidate.identifier, body });
        },
        apply: true, allowIssueIdentifiers: ['DEMO-1'],
        log: (event, data) => events.push({ event, data }),
      });
      expect(result.posted).toEqual(['DEMO-1']);
      expect(result.failures).toEqual([]);
      expect(markerReads).toHaveLength(2);
      expect(timeline).toEqual(['marker:0', 'request', 'marker:1']);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toContain('- 오늘 상태 변화: LINEAR-PROGRESS-SYNC yellow → green');
      expect(requests[0]?.body).toContain('- 연결 칸: LINEAR-PROGRESS-SYNC — green(sim)');
      expect(events).toContainEqual({ event: 'posted', data: expect.objectContaining({
        day, identifier: 'DEMO-1', markerCount: 1, runId,
      }) });
      const capture = { mode: 'mock-only', network: false, assertionsPassed: true, runId, result, markerReads, timeline, requests, events };
      const capturePath = process.env.ELANOUS_LINEAR_PROGRESS_E4_CAPTURE;
      if (capturePath) {
        mkdirSync(dirname(capturePath), { recursive: true });
        writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('live apply skips non-DEMO or unknown teams before marker reads and comments', async () => {
    const board = checklist([
      item('ELA-SCOPE', 'ELA source', 'yellow', 'linear-ref: ELA-53'),
      item('DEMO-SCOPE', 'DEMO source', 'yellow', 'linear-ref: DEMO-2'),
      item('UNKNOWN-SCOPE', 'Unknown source', 'yellow', 'linear-ref: DEMO-3'),
    ]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-team-scope-'));
    const markerReads: string[] = [];
    const posts: string[] = [];
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        issues: [issue('ELA-53', 'ELA-SCOPE', 'ELA'), issue('DEMO-2', 'DEMO-SCOPE'), issue('DEMO-3', 'UNKNOWN-SCOPE', '')],
        decisions: [], getApiKey: async () => 'test-key',
        countMarker: async candidate => { markerReads.push(candidate.identifier); return markerReads.length === 1 ? 0 : 1; },
        postComment: async candidate => { posts.push(candidate.identifier); },
        apply: true, allowIssueIdentifiers: ['ELA-53', 'DEMO-2', 'DEMO-3'],
      });
      expect(result.posted).toEqual(['DEMO-2']);
      expect(result.skipped.sort()).toEqual(['DEMO-3', 'ELA-53']);
      expect(result.failures).toEqual([]);
      expect(markerReads).toEqual(['DEMO-2', 'DEMO-2']);
      expect(posts).toEqual(['DEMO-2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('default preview queries DEMO only and parses the returned team key', async () => {
    const board = checklist([item('DEMO-CELL', 'Demo progress', 'yellow', 'linear-ref: DEMO-1')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-preview-team-'));
    const requestedTeams: string[] = [];
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        decisions: [], getApiKey: async () => 'test-key', countMarker: async () => 0,
        fetch: (async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as { variables: { teamKey: string } };
          requestedTeams.push(payload.variables.teamKey);
          return Response.json({ data: { issues: { nodes: [{ id: 'uuid-DEMO-1', identifier: 'DEMO-1', title: 'Demo',
            url: 'https://linear.example/DEMO-1', description: 'DEMO-CELL', state: { name: 'Todo' }, team: { key: 'DEMO' } }],
            pageInfo: { hasNextPage: false, endCursor: null } } } });
        }) as typeof fetch,
      });
      expect(requestedTeams).toEqual(['DEMO']);
      expect(result.candidates.map(candidate => candidate.identifier)).toEqual(['DEMO-1']);
      expect(result.skipped).toEqual(['DEMO-1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parsed DEMO team key reaches the injected apply path', async () => {
    const board = checklist([item('DEMO-CELL', 'Demo progress', 'yellow', 'linear-ref: DEMO-1')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-parsed-team-'));
    let markerReads = 0;
    let commentWrites = 0;
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        decisions: [], getApiKey: async () => 'test-key', apply: true, allowIssueIdentifiers: ['DEMO-1'],
        countMarker: async () => ++markerReads === 1 ? 0 : 1,
        postComment: async () => { commentWrites++; },
        fetch: (async () => Response.json({ data: { issue: { id: 'uuid-DEMO-1', identifier: 'DEMO-1', title: 'Demo',
          url: 'https://linear.example/DEMO-1', description: 'DEMO-CELL', state: { name: 'Todo' }, team: { key: 'DEMO' } } } })) as unknown as typeof fetch,
      });
      expect(result.posted).toEqual(['DEMO-1']);
      expect(result.failures).toEqual([]);
      expect(markerReads).toBe(2);
      expect(commentWrites).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('allowlisted ELA response is rejected before marker lookup or comment write', async () => {
    const board = checklist([item('ELA-CELL', 'ELA progress', 'yellow', 'linear-ref: ELA-53')]);
    const root = mkdtempSync(join(tmpdir(), 'linear-progress-sync-allowlist-team-'));
    let markerReads = 0;
    let commentWrites = 0;
    try {
      const result = await runLinearProgressSync({
        version: '0.2.43', now: new Date('2026-10-30T12:00:00.000Z'), root, checklist: board,
        decisions: [], getApiKey: async () => 'test-key', apply: true, allowIssueIdentifiers: ['ELA-53'],
        countMarker: async () => { markerReads++; return 0; }, postComment: async () => { commentWrites++; },
        fetch: (async () => Response.json({ data: { issue: { id: 'uuid-ELA-53', identifier: 'ELA-53', title: 'ELA',
          url: 'https://linear.example/ELA-53', description: 'ELA-CELL', state: { name: 'Todo' }, team: { key: 'ELA' } } } })) as unknown as typeof fetch,
      });
      expect(result.skipped).toEqual(['ELA-53']);
      expect(result.posted).toEqual([]);
      expect(markerReads).toBe(0);
      expect(commentWrites).toBe(0);
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
