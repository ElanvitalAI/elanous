import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncLinearProgress } from './linear-progress-sync.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('syncLinearProgress team scope', () => {
  test('does not comment on ELA-53 when its actual team key is ELA', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'linear-progress-sync-'));
    roots.push(ledgerRoot);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ data: { issue: { id: 'issue-ela-53', team: { key: 'ELA' }, comments: { nodes: [] } } } });
    };

    const result = await syncLinearProgress({
      version: '0.2.43',
      live: true,
      now: new Date('2026-10-31T01:00:00.000Z'),
      ledgerRoot,
      getSecret: async () => 'test-token',
      fetch: fetchFn,
      buildSummaries: () => [{ issue: 'ELA-53', day: '2026-10-31', body: 'safe summary' }],
    });

    expect(result).toMatchObject({ planned: 1, posted: 0, skipped: 1, failed: 0 });
    expect(result.plan[0]).toMatchObject({ issue: 'ELA-53', action: 'team-mismatch' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.linear.app/graphql');
    expect(JSON.parse(String(calls[0]!.init?.body)).query).toContain('team { key }');
    expect(existsSync(join(ledgerRoot, 'release', 'linear-progress-sync.json'))).toBe(false);
  });
});
