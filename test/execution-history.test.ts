import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionHistoryStore } from '../src/execution-history.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('execution history filters records that fail the record schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execution-history-guards-'));
  dirs.push(dir);
  const path = join(dir, 'history.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    records: [
      { id: 'good', startedAt: '2026-01-01T00:00:00.000Z', spec: {}, status: 'active' },
      { id: 'missing-spec', startedAt: '2026-01-01T00:00:00.000Z', status: 'active' },
    ],
  }));

  expect(new ExecutionHistoryStore(path).list().map((record) => record.id)).toEqual(['good']);
});
