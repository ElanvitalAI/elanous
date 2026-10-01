import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineFromCutLogs } from './baseline-from-logs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'baseline-from-logs-'));
  dirs.push(root);
  const dir = join(root, 'gate-logs', 'cut');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const junit = (file: string, name: string, failed: boolean) => `<testsuites><testsuite file="${file}" name="${file}"><testcase name="${name}">${failed ? '<failure message="failed"/>' : ''}</testcase></testsuite></testsuites>`;

test('pod logs and junit form a deduplicated baseline with measured junit file count', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 2, rc: 1, files: ['src/a.test.ts'] }));
  writeFileSync(join(dir, 'pod-1.json'), JSON.stringify({ shardCount: 2, rc: 1, files: ['src/b.test.ts'] }));
  writeFileSync(join(dir, 'pod-0.log'), 'src/a.test.ts:\n(fail) A [1.00ms]\n1 fail\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-1.log'), 'src/b.test.ts:\n# Unhandled error between tests\n0 fail\n1 errors\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0.junit.xml'), junit('src/a.test.ts', 'A', true));
  writeFileSync(join(dir, 'pod-1.junit.xml'), junit('src/b.test.ts', 'B', false));
  const before = readFileSync(join(dir, 'pod-0.log'), 'utf8');
  expect(baselineFromCutLogs(dir)).toEqual({
    failures: ['src/a.test.ts > A'], errors: ['src/b.test.ts > [error]'], files: 2, complete: true,
  });
  expect(readFileSync(join(dir, 'pod-0.log'), 'utf8')).toBe(before);
  rmSync(join(dir, 'pod-1.json'));
  expect(baselineFromCutLogs(dir)).toMatchObject({ complete: false });
});

test('junit supplies a failure missing from the console and absent shard count is not complete', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ rc: 1, files: ['src/a.test.ts'] }));
  writeFileSync(join(dir, 'pod-0.log'), 'src/a.test.ts:\n1 fail\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0.junit.xml'), junit('src/a.test.ts', 'from junit', true));
  expect(baselineFromCutLogs(dir)).toEqual({ failures: ['src/a.test.ts > from junit'], errors: [], files: 1, complete: false });
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 1, rc: 1, files: ['src/a.test.ts'] }));
  expect(baselineFromCutLogs(dir)?.complete).toBe(true);
});

test('extra root shard contradicts the planned shard count', () => {
  const dir = fixture();
  for (const [index, file] of ['src/a.test.ts', 'src/b.test.ts'].entries()) {
    writeFileSync(join(dir, `pod-${index}.json`), JSON.stringify({ shardCount: 1, rc: 0, files: [file] }));
    writeFileSync(join(dir, `pod-${index}.log`), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
    writeFileSync(join(dir, `pod-${index}.junit.xml`), junit(file, 'passes', false));
  }
  expect(baselineFromCutLogs(dir)).toEqual({ failures: [], errors: [], files: 2, complete: false });
});

test('unreadable pod log or junit marks the cut incomplete instead of throwing', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 1, rc: 0, files: ['src/a.test.ts'] }));
  const log = join(dir, 'pod-0.log');
  const report = join(dir, 'pod-0.junit.xml');
  writeFileSync(log, '1 pass\n0 fail\nRan 1 test across 1 file.\n');
  writeFileSync(report, junit('src/a.test.ts', 'passes', false));
  expect(baselineFromCutLogs(dir)?.complete).toBe(true);
  rmSync(log);
  mkdirSync(log);
  expect(baselineFromCutLogs(dir)?.complete).toBe(false);
  rmSync(log, { recursive: true });
  writeFileSync(log, '1 pass\n0 fail\nRan 1 test across 1 file.\n');
  rmSync(report);
  mkdirSync(report);
  expect(baselineFromCutLogs(dir)?.complete).toBe(false);
});

test('nonzero exit without an observed failure or error cannot be a complete cut', () => {
  const dir = fixture();
  const path = join(dir, 'pod-0.json');
  writeFileSync(path, JSON.stringify({ shardCount: 1, rc: 1, files: ['src/a.test.ts'] }));
  writeFileSync(join(dir, 'pod-0.log'), '1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0.junit.xml'), junit('src/a.test.ts', 'passes', false));
  expect(baselineFromCutLogs(dir)).toEqual({ failures: [], errors: [], files: 1, complete: false });
  writeFileSync(path, JSON.stringify({ shardCount: 1, rc: 0, files: ['src/a.test.ts'] }));
  expect(baselineFromCutLogs(dir)?.complete).toBe(true);
  writeFileSync(join(dir, 'pod-0.log'), 'src/a.test.ts:\n(fail) A [1.00ms]\n1 fail\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0.junit.xml'), junit('src/a.test.ts', 'A', true));
  expect(baselineFromCutLogs(dir)?.complete).toBe(false);
});

test('split parent output is ignored and a missing measured leaf prevents reuse', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'pod-0.json'), JSON.stringify({ shardCount: 1, rc: 1, files: ['src/a.test.ts', 'src/b.test.ts'] }));
  writeFileSync(join(dir, 'pod-0.log'), 'src/a.test.ts:\n(fail) parent [1.00ms]\n1 fail\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0-0.json'), JSON.stringify({ rc: 1, files: ['src/a.test.ts'] }));
  writeFileSync(join(dir, 'pod-0-0.log'), 'src/a.test.ts:\n(fail) leaf [1.00ms]\n1 fail\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0-0.junit.xml'), junit('src/a.test.ts', 'leaf', true));
  writeFileSync(join(dir, 'pod-0-1.json'), JSON.stringify({ rc: 0, files: ['src/b.test.ts'] }));
  writeFileSync(join(dir, 'pod-0-1.log'), '1 pass\n0 fail\nRan 1 test across 1 file.\n');
  writeFileSync(join(dir, 'pod-0-1.junit.xml'), junit('src/b.test.ts', 'ok', false));
  expect(baselineFromCutLogs(dir)).toMatchObject({ failures: ['src/a.test.ts > leaf'], complete: true });
  writeFileSync(join(dir, 'pod-0-1.json'), '{invalid');
  expect(baselineFromCutLogs(dir)?.complete).toBe(false);
  writeFileSync(join(dir, 'pod-0-1.json'), JSON.stringify({ rc: 0, files: ['src/b.test.ts'] }));
  rmSync(join(dir, 'pod-0-1.log'));
  expect(baselineFromCutLogs(dir)).toMatchObject({ complete: false });
});

test('missing folder or zero logs supplies no baseline; missing root shard is incomplete', () => {
  const dir = fixture();
  expect(baselineFromCutLogs(join(dir, 'missing'))).toBeUndefined();
  writeFileSync(join(dir, 'pod-0.json'), '{}');
  expect(baselineFromCutLogs(dir)).toBeUndefined();
  writeFileSync(join(dir, 'pod-1.json'), '{}');
  writeFileSync(join(dir, 'pod-1.log'), '0 fail\nRan 1 test across 1 file.\n');
  rmSync(join(dir, 'pod-0.json'));
  expect(baselineFromCutLogs(dir)?.complete).toBe(false);
  expect(existsSync(join(dir, 'pod-0.json'))).toBe(false);
});

test('corrupt shard metadata, missing junit file count and mismatched commit each prevent reuse', () => {
  const dir = fixture();
  const commit = 'b'.repeat(40);
  const metadata = { shardCount: 1, rc: 1, files: ['src/a.test.ts'], commit };
  const path = join(dir, 'pod-0.json');
  writeFileSync(path, JSON.stringify(metadata));
  writeFileSync(join(dir, 'pod-0.log'), 'src/a.test.ts:\n(fail) A [1.00ms]\n1 fail\nRan 1 test across 1 file.\n');
  const junitPath = join(dir, 'pod-0.junit.xml');
  writeFileSync(junitPath, junit('src/a.test.ts', 'A', true));
  expect(baselineFromCutLogs(dir, commit)).toMatchObject({ files: 1, complete: true });
  expect(baselineFromCutLogs(dir, 'c'.repeat(40))?.complete).toBe(false);
  writeFileSync(path, JSON.stringify({ ...metadata, commit: undefined }));
  expect(baselineFromCutLogs(dir, commit)?.complete).toBe(false);
  writeFileSync(path, JSON.stringify(metadata));
  rmSync(junitPath);
  expect(baselineFromCutLogs(dir, commit)).toMatchObject({ files: 0, complete: false });
  writeFileSync(junitPath, junit('src/a.test.ts', 'A', true));
  writeFileSync(path, '{invalid');
  expect(baselineFromCutLogs(dir, commit)?.complete).toBe(false);
});
