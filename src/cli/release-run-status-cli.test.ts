import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { simCli } from '../ux-sim/in-process-cli.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerReleaseRunStatusCommand, renderReleaseRunStatus } from './release-run-status-cli.js';

test('release status reads immutable counts and reports missing or incompatible ledgers unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-snapshot-')); roots.push(root);
  const ledger = join(root, 'ledger');
  const app = new Command();
  registerReleaseRunStatusCommand(app.command('release'), { ledgerRoot: () => ledger, debugDir: () => join(root, 'logs') });
  const lines: string[] = [];
  const original = console.log; console.log = (line?: unknown) => { lines.push(String(line ?? '')); };
  const run = async () => { lines.length = 0; await app.parseAsync(['node', 'test', 'release', 'status', '0.3.7']); return lines.join('\n'); };
  try {
    const missing = await run();
    expect(missing).toContain('🟢unknown'); expect(missing).toContain('complete=false');
    expect(existsSync(ledger)).toBe(false);
    mkdirSync(join(ledger, 'release'), { recursive: true });
    const path = join(ledger, 'release', 'features.sqlite');
    const db = new Database(path);
    db.exec('CREATE TABLE imported_versions (version TEXT, json_hash TEXT); CREATE TABLE assignments (version TEXT, status TEXT);');
    db.exec("INSERT INTO imported_versions VALUES ('0.3.7', NULL); INSERT INTO assignments VALUES ('0.3.7','green'), ('0.3.7','yellow'), ('0.3.7','yellow'), ('0.3.7','red'), ('0.3.7','done');"); db.close();
    const known = await run();
    expect(known).toContain('🟢1 🟡2 🔴1 ✅1'); expect(known).toContain('snapshot 읽기');
    const invalidDb = new Database(path); invalidDb.exec('DROP TABLE assignments'); invalidDb.close();
    const invalid = await run(); expect(invalid).toContain('🟢unknown'); expect(invalid).toContain('complete=false');
    expect(existsSync(`${path}-wal`)).toBe(false); expect(existsSync(`${path}-shm`)).toBe(false);
  } finally { console.log = original; }
});

test('actual release status does not import legacy JSON, create a ledger or migrate an old SQLite ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-status-legacy-')); roots.push(root);
  const release = join(root, 'release');
  const versionDir = join(release, '0.3.7');
  mkdirSync(versionDir, { recursive: true });
  const legacy = join(versionDir, 'checklist.json');
  writeFileSync(legacy, JSON.stringify({ version: '0.3.7', items: [{ id: 'LEGACY', title: 'legacy item', status: 'green', updatedAt: '2026-01-01', updatedBy: 'fixture' }], history: [] }));
  const ledger = join(release, 'features.sqlite');
  const file = (path: string) => ({ bytes: readFileSync(path).toString('base64'), mtime: statSync(path).mtimeMs });
  const run = () => simCli([`--test=${root}`, 'release', 'status', '0.3.7'], {
    mode: 'spawn', stateRoot: root, allowPaths: [['release', 'status']], timeoutMs: 60_000,
    env: { HOME: root, ELANOUS_STATE_DIR: root },
  });
  const legacyBefore = file(legacy);
  const missing = await run();
  expect(missing.exitCode, missing.stderr).toBe(0);
  expect(missing.stdout).toContain('🟢unknown');
  expect(missing.stdout).toContain('complete=false');
  expect(existsSync(ledger)).toBe(false);
  expect(readdirSync(release).sort()).toEqual(['0.3.7']);
  expect(file(legacy)).toEqual(legacyBefore);

  // Old schema has real rows but lacks the current imported_versions table: a writable
  // initializer would create/migrate tables and could import the legacy checklist.
  const db = new Database(ledger);
  db.exec("CREATE TABLE features (id TEXT PRIMARY KEY, title TEXT); INSERT INTO features VALUES ('OLD', 'existing'); CREATE TABLE assignments (feature_id TEXT, version TEXT, status TEXT); INSERT INTO assignments VALUES ('OLD', '0.3.7', 'yellow');");
  db.close();
  const rows = () => {
    const reader = new Database(ledger, { readonly: true });
    try { return { schema: reader.query("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), features: reader.query('SELECT COUNT(*) AS n FROM features').get(), assignments: reader.query('SELECT COUNT(*) AS n FROM assignments').get() }; }
    finally { reader.close(); }
  };
  const beforeRows = rows();
  expect(beforeRows.features).toEqual({ n: 1 });
  expect(beforeRows.assignments).toEqual({ n: 1 });
  const beforeDb = file(ledger);
  const beforeFiles = readdirSync(release).sort();
  const result = await run();
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain('🟢unknown');
  expect(result.stdout).toContain('complete=false');
  expect(file(legacy)).toEqual(legacyBefore);
  expect(file(ledger)).toEqual(beforeDb);
  expect(readdirSync(release).sort()).toEqual(beforeFiles);
  expect(rows()).toEqual(beforeRows);
}, 180_000);

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
      { nodeId: 'version-release', startedAt: '2026-11-08T01:00:01Z', endedAt: '2026-11-08T01:00:02Z', output: '{"commit":"cut","introduced":1}' },
      { nodeId: 'export-check', startedAt: '2026-11-08T01:00:03Z', endedAt: '2026-11-08T01:00:04Z', output: '{"failureClassification":"regression","nextHitl":"approve export retry","introduced":["a"],"preexisting":1,"unmeasured":1,"etaMinutes":30}' },
      { nodeId: 'gate-recheck-summary', startedAt: '2026-11-08T01:00:04Z', endedAt: '2026-11-08T01:00:04Z', output: '{"introduced":["b","a"]}' },
      { nodeId: 'receipt-audit', startedAt: '2026-11-08T01:00:05Z', endedAt: '2026-11-08T01:00:06Z', output: '{"measurement":{"totalFiles":10,"coveredFiles":8,"unmeasuredFiles":2}}' },
      { nodeId: 'residual-run', startedAt: '2026-11-08T01:00:07Z', output: '{"outcome":"running","measurement":{"totalFiles":99,"coveredFiles":0,"unmeasuredFiles":99}}' },
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
    checklist: () => ({ green: 3, yellow: 1, red: 0, done: 2 }),
    now: () => Date.parse('2026-11-09T02:00:00Z'),
    sweepCertificateMeasuredAt: () => Date.parse('2026-11-09T01:00:00Z') });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => { lines.push(String(line ?? '')); };
  try { await app.parseAsync(['node', 'test', 'release', 'status', '0.3.7']); }
  finally { console.log = originalLog; }
  expect(lines.join('\n')).toContain('run newest');
  expect(lines.join('\n')).not.toContain('run aux');
  expect(lines.join('\n')).toContain('recheck 4/4');
  expect(lines.join('\n')).toContain('미덮임 2/10');
  expect(lines.join('\n')).toContain('residual 실행 1');
  expect(lines.join('\n')).toContain('sweep 증명서 나이 60m');
  expect(lines.join('\n')).toContain('ETA 30m');
  expect(lines.join('\n')).toContain('실패 introduced 2 / preexisting 1 / 미판정 1');
  expect(lines.join('\n')).toContain('분류 regression');
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
  expect(lines.join('\n')).toContain('residual 실행 ?');
  expect(lines.join('\n')).toContain('실패 introduced ? / preexisting ? / 미판정 ?');
  expect(lines.join('\n')).toContain('ETA 미측정');
});

test('release status preserves a running release with no completed node records', () => {
  const run = { runId: '9fdb6534-3481-47ea-b428-a139152b2306', status: 'running', startedAt: '2026-11-17T19:42:08.912Z', input: { version: '0.3.28' }, currentNode: { nodeId: 'version-release', startedAt: '2026-11-17T19:42:08.912Z' }, nodes: [] };
  const checklist = { green: null, yellow: null, red: null, done: null };
  const output = renderReleaseRunStatus('0.3.28', [run], [], checklist, Date.parse('2026-11-17T19:43:08.912Z'));
  expect(output).toContain('run 9fdb6534-3481-47ea-b428-a139152b2306 · running · node version-release');
  expect(output).not.toContain('run 없음');
  const entry = { ...run, currentNode: { nodeId: 'traffic-prep' } };
  expect(renderReleaseRunStatus('0.3.28', [entry], [], checklist)).toContain('node traffic-prep');
  const entryComplete = { ...run, currentNode: { nodeId: 'cut-branch' }, nodes: [{ nodeId: 'traffic-prep', endedAt: '2026-11-17T19:42:09Z' }] };
  expect(renderReleaseRunStatus('0.3.28', [entryComplete], [], checklist)).toContain('run 9fdb6534');
  const auxiliary = { ...run, runId: 'aux', currentNode: { nodeId: 'rehearsal' } };
  expect(renderReleaseRunStatus('0.3.28', [auxiliary], [], checklist)).toContain('run 없음');
});
