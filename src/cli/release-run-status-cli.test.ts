import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerReleaseRunStatusCommand } from './release-run-status-cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('release status CLI selects the newest full run and scopes long-lived recheck events by runId', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-status-cli-'));
  roots.push(root);
  const ledger = join(root, 'ledger');
  const logs = join(root, 'logs');
  const runDir = join(ledger, 'graph-runs', 'release-loop');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(runDir, 'newest.json'), JSON.stringify({ runId: 'newest', status: 'failed', startedAt: '2026-11-08T01:00:00Z',
    input: { version: '0.3.7' }, nodes: [
      { nodeId: 'version-release', startedAt: '2026-11-08T01:00:01Z', endedAt: '2026-11-08T01:00:02Z', output: '{"commit":"cut"}' },
      { nodeId: 'export-check', startedAt: '2026-11-08T01:00:03Z', endedAt: '2026-11-08T01:00:04Z', output: '{"failureClassification":"regression","nextHitl":"approve export retry"}' },
    ] }));
  writeFileSync(join(runDir, 'older.json'), JSON.stringify({ runId: 'older', status: 'failed', startedAt: '2026-11-07T01:00:00Z',
    input: { version: '0.3.7' }, nodes: [{ nodeId: 'version-release', startedAt: '2026-11-07T01:00:01Z', endedAt: '2026-11-09T01:00:00Z' }] }));
  writeFileSync(join(runDir, 'aux.json'), JSON.stringify({ runId: 'aux', status: 'done', startedAt: '2026-11-09T01:00:00Z',
    input: { version: '0.3.7' }, nodes: [{ nodeId: 'rehearsal', startedAt: '2026-11-09T01:00:01Z' }] }));
  mkdirSync(join(runDir, 'newest.json.contexts'), { recursive: true });
  writeFileSync(join(runDir, 'newest.json.contexts', 'gate-progress.jsonl'), '{"completed":80,"total":80}\n');
  writeFileSync(join(logs, 'debug-20261109020000.log'), [
    { ts: '2026-11-09T02:00:00Z', category: 'release-loop.gate', event: 'isolated-recheck-progress', runId: 'newest', data: { runId: 'newest', index: 4, total: 4 } },
    { ts: '2026-11-09T02:00:01Z', category: 'release-loop.gate', event: 'isolated-recheck-progress', runId: 'other', data: { runId: 'other', index: 9, total: 9 } },
    { ts: '2026-11-09T02:00:02Z', category: 'release-loop.gate', event: 'isolated-recheck-progress', data: { index: 7, total: 7 } },
  ].map((row) => JSON.stringify(row)).join('\n'));

  const app = new Command();
  const release = app.command('release');
  registerReleaseRunStatusCommand(release, { ledgerRoot: () => ledger, debugDir: () => logs,
    checklist: () => ({ green: 3, yellow: 1, red: 0, done: 2 }) });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => { lines.push(String(line ?? '')); };
  try { await app.parseAsync(['node', 'test', 'release', 'status', '0.3.7']); }
  finally { console.log = originalLog; }
  expect(lines.join('\n')).toContain('run newest');
  expect(lines.join('\n')).not.toContain('run aux');
  expect(lines.join('\n')).toContain('recheck 4/4');
  expect(lines.join('\n')).toContain('실패 분류 regression');
  expect(lines.join('\n')).toContain('다음 HITL approve export retry');
});

test('release status CLI reports no full run instead of promoting an auxiliary run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-status-no-full-'));
  roots.push(root);
  const ledger = join(root, 'ledger');
  const logs = join(root, 'logs');
  const runDir = join(ledger, 'graph-runs', 'release-loop');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(runDir, 'aux.json'), JSON.stringify({ runId: 'aux', status: 'done', startedAt: '2026-11-09T01:00:00Z',
    input: { version: '0.3.7' }, nodes: [{ nodeId: 'rehearsal', startedAt: '2026-11-09T01:00:01Z' }] }));
  const app = new Command();
  registerReleaseRunStatusCommand(app.command('release'), { ledgerRoot: () => ledger, debugDir: () => logs,
    checklist: () => ({ green: 0, yellow: 0, red: 0, done: 0 }) });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => { lines.push(String(line ?? '')); };
  try { await app.parseAsync(['node', 'test', 'release', 'status', '0.3.7']); }
  finally { console.log = originalLog; }
  expect(lines.join('\n')).toContain('run 없음');
  expect(lines.join('\n')).not.toContain('run aux');
});
