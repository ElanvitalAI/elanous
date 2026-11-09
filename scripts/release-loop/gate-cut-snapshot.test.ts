import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAssignableTestsAtCommit, gateSourcePins } from './gate-baseline-receipt.js';
import { createCutSnapshot } from './gate-cut-snapshot.js';
import { gitClosureTree } from './gate-closure.js';
import { gateReceiptHashesByShard } from './gate-receipt-hash.js';
import { gateLockfileHashAtCommit, gateTestedFileHashesAtCommit } from './gate-reuse-identity.js';

const roots: string[] = [];
afterEach(() => { delete process.env.GIT_TRACE; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('GATE-CUT-SNAPSHOT sim: repeated planning consumers share one ls-tree and one cat-file batch', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-cut-snapshot-')); roots.push(repo);
  const trace = join(repo, 'git-trace.log');
  const cliEntryPath = ['bin', ['elanous', 'mjs'].join('.')].join('/');
  const files: Record<string, string> = {
    'scripts/example.test.ts': 'export const fixture = true;\n',
    [cliEntryPath]: 'export const cli = true;\n',
    'bun.lock': 'lock-root\n', 'apps/pwa/bun.lock': 'lock-pwa\n',
    'graphs/release/release-loop.yaml': 'node_id: gate\n', 'graphs/release/recipes.yaml': 'gate:\n  command: bun test\n  timeout_ms: 1000\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(repo, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, contents);
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Cut snapshot test'); git('config', 'user.email', 'cut-snapshot@example.invalid');
  git('add', '.'); git('commit', '-qm', 'seed cut snapshot');
  writeFileSync(join(repo, cliEntryPath), 'export const cli = false;');
  const commit = git('rev-parse', 'HEAD');
  process.env.GIT_TRACE = trace;
  const snapshot = createCutSnapshot(repo, commit, join(repo, 'artifacts'));
  expect(createCutSnapshot(repo, commit)).toBe(snapshot);
  expect(snapshot.read(cliEntryPath)).toContain('export const cli = true;');
  expect(gateAssignableTestsAtCommit(repo, commit)).toEqual(['scripts/example.test.ts']);
  expect(gateAssignableTestsAtCommit(repo, commit)).toEqual(['scripts/example.test.ts']);
  expect(gateLockfileHashAtCommit(repo, commit)).toBeTruthy();
  expect(gateLockfileHashAtCommit(repo, commit)).toBeTruthy();
  expect(gateSourcePins(repo, commit)).toBeTruthy();
  expect(gateTestedFileHashesAtCommit(repo, commit, ['scripts/example.test.ts'])).toBeTruthy();
  const hashes = gateReceiptHashesByShard(repo, commit, [{ files: ['scripts/example.test.ts'] }], snapshot);
  expect(hashes.hashesByShard['pod-0']?.['scripts/example.test.ts']).toBeTruthy();
  const calls = readFileSync(trace, 'utf8');
  expect((calls.match(/git ls-tree/g) ?? []).length).toBe(1);
  expect((calls.match(/git cat-file/g) ?? []).length).toBe(1);
});



test('GATE-CUT-SNAPSHOT sim: a legacy same-commit artifact is rebuilt with mjs and cjs entries', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-cut-snapshot-legacy-')); roots.push(repo);
  const files: Record<string, string> = {
    'bin/entry.mjs': 'export const mjsEntry = true;',
    'bin/entry.cjs': 'exports.cjsEntry = true;',
    'scripts/example.test.ts': 'export const fixture = true;',
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(repo, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, contents);
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Cut snapshot test'); git('config', 'user.email', 'cut-snapshot@example.invalid');
  git('add', '.'); git('commit', '-qm', 'seed legacy snapshot');
  const commit = git('rev-parse', 'HEAD');
  const artifactDir = join(repo, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, commit + '.json');
  writeFileSync(artifactPath, JSON.stringify({ commit, entries: {}, files: Object.keys(files).sort() }));
  const snapshot = createCutSnapshot(repo, commit, artifactDir);
  expect(snapshot.read('bin/entry.mjs')).toContain('mjsEntry');
  expect(snapshot.read('bin/entry.cjs')).toContain('cjsEntry');
  expect(JSON.parse(readFileSync(artifactPath, 'utf8')).formatVersion).toBe(2);
});

test('GATE-CUT-SNAPSHOT sim: 80 shard consumers use one snapshot, then same-commit planning spawns no Git', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-cut-snapshot-80-')); roots.push(repo);
  const baselineTrace = join(repo, 'git-before.trace'), snapshotTrace = join(repo, 'git-after.trace');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Cut snapshot test'); git('config', 'user.email', 'cut-snapshot@example.invalid');
  mkdirSync(join(repo, 'scripts', 'shards'), { recursive: true });
  mkdirSync(join(repo, 'graphs', 'release'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'pwa'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-root\n');
  writeFileSync(join(repo, 'apps/pwa/bun.lock'), 'lock-pwa\n');
  writeFileSync(join(repo, 'graphs/release/release-loop.yaml'), 'node_id: gate\n');
  writeFileSync(join(repo, 'graphs/release/recipes.yaml'), 'gate:\n  command: bun test\n');
  const shardFiles = Array.from({ length: 80 }, (_, index) => `scripts/shards/shard-${String(index).padStart(2, '0')}.test.ts`);
  for (const [index, file] of shardFiles.entries()) writeFileSync(join(repo, file), `export const shard${index} = ${index};\n`);
  git('add', '.'); git('commit', '-qm', 'seed 80 shard cut');
  const commit = git('rev-parse', 'HEAD');
  const legacyRead = () => {
    const listed = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', commit], { cwd: repo, encoding: 'utf8' });
    if (listed.status !== 0 || listed.error) throw new Error(String(listed.stderr || listed.error));
    const files = listed.stdout.split('\0').filter(Boolean);
    const wanted = files.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) || file === 'bunfig.toml' || /(?:^|\/)tsconfig[\w.-]*\.json$/.test(file));
    const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: wanted.map((file) => commit + ':' + file).join('\n') + '\n' });
    if (batch.status !== 0 || batch.error) throw new Error(String(batch.stderr || batch.error));
  };
  const startedBefore = performance.now();
  process.env.GIT_TRACE = baselineTrace;
  for (let index = 0; index < 80; index += 1) legacyRead();
  const beforeMs = performance.now() - startedBefore;
  const beforeCalls = (readFileSync(baselineTrace, 'utf8').match(/trace: (?:built-in|exec): git /g) ?? []).length;

  process.env.GIT_TRACE = snapshotTrace;
  const startedAfter = performance.now();
  const tree = gitClosureTree(repo, commit);
  expect(tree.files.filter((file) => file.endsWith('.test.ts'))).toHaveLength(80);
  expect(tree.read(shardFiles[0]!)).toBe('export const shard0 = 0;\n');
  expect(gateAssignableTestsAtCommit(repo, commit)).toEqual(shardFiles);
  const graphText = 'node_id: gate\n', recipeText = 'gate:\n  command: bun test\n';
  expect(gateSourcePins(repo, commit)).toEqual({
    graphSha: createHash('sha256').update(graphText).digest('hex'),
    recipeSha: createHash('sha256').update(recipeText).digest('hex'),
  });
  const expectedLockHash = createHash('sha256').update(Buffer.concat([Buffer.from('lock-root\n'), Buffer.from('\0'), Buffer.from('lock-pwa\n'), Buffer.from('\0')])).digest('hex');
  expect(gateLockfileHashAtCommit(repo, commit)).toBe(expectedLockHash);
  const expectedHashes = Object.fromEntries(shardFiles.map((file, index) => [file, createHash('sha256').update(`export const shard${index} = ${index};\n`).digest('hex')]));
  expect(gateTestedFileHashesAtCommit(repo, commit, shardFiles)).toEqual(expectedHashes);
  const snapshot = createCutSnapshot(repo, commit);
  const hashes = gateReceiptHashesByShard(repo, commit, shardFiles.map((file) => ({ files: [file] })), snapshot);
  expect(hashes.hashesByShard).toEqual(Object.fromEntries(shardFiles.map((file, index) => [`pod-${index}`, { [file]: expectedHashes[file] }])));
  const firstPlanCalls = (readFileSync(snapshotTrace, 'utf8').match(/trace: (?:built-in|exec): git /g) ?? []).length;
  for (let index = 0; index < 80; index += 1) gitClosureTree(repo, commit);
  const afterMs = performance.now() - startedAfter;
  const afterCalls = (readFileSync(snapshotTrace, 'utf8').match(/trace: (?:built-in|exec): git /g) ?? []).length;
  expect(beforeCalls).toBe(160);
  expect(firstPlanCalls).toBe(2);
  expect(afterCalls - firstPlanCalls).toBe(0);
  console.log(`GATE-CUT-SNAPSHOT 80-shard planning: legacy=${beforeMs.toFixed(1)}ms/${beforeCalls} Git commands; snapshot=${afterMs.toFixed(1)}ms/${afterCalls} Git commands; repeated same-commit closure calls=0 Git commands`);
});
