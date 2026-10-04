import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectWorkflowDir } from '../../workflow-runtime/discovery.js';
import { getWorkflowHistoryVersion, listWorkflowHistory, snapshotBeforeSave } from './workflow-history.js';
import { handleWorkflowPut } from './workflows.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'workflow-history-'));
  roots.push(cwd);
  const dir = getProjectWorkflowDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'my-flow.yaml');
  return { cwd, dir, file };
}

test('snapshots the on-disk YAML before overwrite; consecutive identical content is skipped', () => {
  const { cwd, file } = fixture();
  expect(snapshotBeforeSave('my-flow', { cwd })).toBeNull();
  expect(listWorkflowHistory('my-flow', { cwd })).toEqual([]);
  writeFileSync(file, 'old: original\n');
  const original = snapshotBeforeSave('my-flow', { cwd });
  expect(original).not.toBeNull();
  expect(original!.size).toBe(Buffer.byteLength('old: original\n'));
  expect(original!.createdAt).toBe(new Date(Number(original!.id.slice(0, 13))).toISOString());
  expect(snapshotBeforeSave('my-flow', { cwd })).toBeNull();
  writeFileSync(file, 'new: draft\n');
  const next = snapshotBeforeSave('my-flow', { cwd });
  expect(next).not.toBeNull();
  expect(listWorkflowHistory('my-flow', { cwd }).map(version => version.id)).toEqual([next!.id, original!.id]);
  expect(getWorkflowHistoryVersion('my-flow', original!.id, { cwd })).toBe('old: original\n');
  expect(getWorkflowHistoryVersion('my-flow', next!.id, { cwd })).toBe('new: draft\n');
  expect(readFileSync(file, 'utf8')).toBe('new: draft\n');
  expect(readdirSync(join(getProjectWorkflowDir(cwd), '.history', 'my-flow'))).toHaveLength(2);
  writeFileSync(file, 'old: original\n');
  const repeatedAfterChange = snapshotBeforeSave('my-flow', { cwd });
  expect(repeatedAfterChange).not.toBeNull();
  expect(listWorkflowHistory('my-flow', { cwd }).map(version => version.id)).toEqual([
    repeatedAfterChange!.id, next!.id, original!.id,
  ]);
});

test('PUT snapshots the old YAML before an accepted overwrite, not after a rejected one', async () => {
  const { cwd, file } = fixture();
  const previousCwd = process.cwd();
  const oldYaml = 'name: my-flow\nnodes:\n  - id: start\n    manualTrigger: {}\n';
  const newYaml = `${oldYaml}description: edited\n`;
  const request = (yaml: string) => new Request('http://localhost/v1/workflows/my-flow', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml }),
  });
  try {
    process.chdir(cwd);
    writeFileSync(file, oldYaml);
    const rejected = await handleWorkflowPut(request('invalid: yaml\n'), 'my-flow', { noAuth: true });
    expect(rejected.status).toBe(422);
    expect(listWorkflowHistory('my-flow', { cwd })).toEqual([]);
    const accepted = await handleWorkflowPut(request(newYaml), 'my-flow', { noAuth: true });
    expect(accepted.status).toBe(200);
    const versions = listWorkflowHistory('my-flow', { cwd });
    expect(versions).toHaveLength(1);
    expect(getWorkflowHistoryVersion('my-flow', versions[0]!.id, { cwd })).toBe(oldYaml);
    expect(readFileSync(file, 'utf8')).toBe(newYaml);
  } finally {
    process.chdir(previousCwd);
  }
});

test('keeps only the newest 20 independent snapshots, ordered newest first', () => {
  const { cwd, file } = fixture();
  const ids: string[] = [];
  for (let n = 0; n < 23; n++) {
    writeFileSync(file, `revision: ${n}\n`);
    ids.push(snapshotBeforeSave('my-flow', { cwd })!.id);
  }
  const versions = listWorkflowHistory('my-flow', { cwd });
  expect(versions).toHaveLength(20);
  expect(versions.map(v => v.id)).toEqual(ids.slice(-20).reverse());
  expect(getWorkflowHistoryVersion('my-flow', ids[0]!, { cwd })).toBeNull();
  expect(getWorkflowHistoryVersion('my-flow', ids[22]!, { cwd })).toBe('revision: 22\n');
  expect(getWorkflowHistoryVersion('my-flow', `0000000000000-00000000-0000-0000-0000-000000000000`, { cwd })).toBeNull();
  expect(getWorkflowHistoryVersion('my-flow', 'unknown', { cwd })).toBeNull();
});

test('each project has isolated history and a missing name/version returns no data', () => {
  const first = fixture();
  const second = fixture();
  writeFileSync(first.file, 'only-in-first\n');
  const saved = snapshotBeforeSave('my-flow', { cwd: first.cwd });
  expect(listWorkflowHistory('my-flow', { cwd: second.cwd })).toEqual([]);
  expect(getWorkflowHistoryVersion('my-flow', saved!.id, { cwd: second.cwd })).toBeNull();
  expect(listWorkflowHistory('unknown-flow', { cwd: first.cwd })).toEqual([]);
});

test('rejects traversal in workflow name and version id before any filesystem access', () => {
  const { cwd, dir, file } = fixture();
  writeFileSync(file, 'safe content\n');
  const saved = snapshotBeforeSave('my-flow', { cwd });
  for (const name of ['../outside', '..', '.', 'a/../b', 'a\\..\\b', '/absolute', '%2e%2e%2foutside', 'a..b']) {
    expect(() => snapshotBeforeSave(name, { cwd })).toThrow('invalid workflow name');
    expect(() => listWorkflowHistory(name, { cwd })).toThrow('invalid workflow name');
    expect(() => getWorkflowHistoryVersion(name, saved!.id, { cwd })).toThrow('invalid workflow name');
  }
  for (const id of ['../outside', '..', '.', '/absolute', `${saved!.id}/../outside`, '%2e%2e', '']) {
    expect(() => getWorkflowHistoryVersion('my-flow', id, { cwd })).toThrow('invalid workflow history version id');
  }
  expect(readdirSync(join(dir, '.history', 'my-flow'))).toHaveLength(1);
});
