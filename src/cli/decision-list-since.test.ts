import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueryCache } from '../storage/short-lived-read-cache.js';
import { decisionListSince, filterDecisionListSince } from './decision-list-since.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('relative since queries reuse cached rows and reapply the moving cutoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-list-since-cache-'));
  roots.push(root);
  const source = join(root, 'ledger.jsonl');
  writeFileSync(source, 'stable');
  const originalNow = Date.now;
  const initialNow = Date.parse('2026-01-03T00:00:00.000Z');
  let clock = initialNow;
  let loads = 0;
  Date.now = () => clock;
  try {
    const recordAt = new Date(initialNow - 2 * 86400000).toISOString();
    const run = () => {
      const filters = { status: 'open', since: decisionListSince('2d') };
      const cachedRows = readQueryCache({ root: join(root, 'cache'), key: { command: 'decisions-list', filters: { status: filters.status, since: '2d' } },
        sourcePaths: [source], ttlMs: 500, now: () => initialNow,
        load: () => { loads += 1; return [{ id: 'boundary-row', raisedAt: recordAt }]; } });
      return filterDecisionListSince(cachedRows, filters.since).map(row => row.id);
    };

    expect(run()).toEqual(['boundary-row']);
    clock += 1;
    expect(run()).toEqual([]);
    expect(loads).toBe(1);
  } finally {
    Date.now = originalNow;
  }
});
