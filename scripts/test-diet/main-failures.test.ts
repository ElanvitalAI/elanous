import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { mainFailures } from './node.js';
import { DEFAULT_MAIN_FAILURE_FILES, mainFailureFiles, mainFailureLedgerPath, mainFailureRow, writeMainFailureDay } from './lib.js';
import { runGraph } from '../../src/graph-runner/runner.js';

setDefaultTimeout(60_000);
const repo = join(import.meta.dir, '../..');
const graphPath = join(repo, 'graphs/test-diet/test-diet.yaml');

function capture(file: string, cwd: string) {
  const run = spawnSync('bun', ['test', `./${file}`], { cwd, encoding: 'utf8', timeout: 20_000 });
  return { file, rc: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

describe('main failures shadow node', () => {
  test('two real failing fake tests become two classified rows; passing file is absent, daily comparison changes on remeasurement', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-fakes-'));
    const names = ['test/old.test.ts', 'test/external.test.ts', 'test/pass.test.ts'];
    try {
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, names[0]!), "import {test, expect} from 'bun:test'; test('old', () => { throw new Error('Expected old snapshot'); });\n");
      writeFileSync(join(root, names[1]!), "import {test} from 'bun:test'; test('external', () => { throw new Error('codex --yolo unavailable'); });\n");
      writeFileSync(join(root, names[2]!), "import {test, expect} from 'bun:test'; test('pass', () => expect(2).toBe(2));\n");
      const first = writeMainFailureDay(root, names, names.map((file) => capture(file, root)), 'main-a', new Date('2026-10-02T12:00:00Z'));
      expect(first).toMatchObject({ date: '2026-10-02', owner: 'TC', mode: 'shadow', failingFiles: 2, previousFailingFiles: null, delta: null });
      expect(first.rows.map((row) => row.file)).toEqual(names.slice(0, 2));
      expect(first.rows[0]).toMatchObject({ failures: 1, classification: '시험이 낡음', draft: '고침' });
      expect(first.rows[0]?.firstError).toContain('Expected old snapshot');
      expect(first.rows[1]).toMatchObject({ failures: 1, classification: '외부 의존', draft: '격리' });
      expect(readFileSync(mainFailureLedgerPath(root, first.date), 'utf8')).toContain('"owner": "TC"');
      const second = writeMainFailureDay(root, names, names.map((file) => file === names[0] ? { ...capture(names[2]!, root), file } : capture(file, root)), 'main-b', new Date('2026-10-03T12:00:00Z'));
      expect(second).toMatchObject({ failingFiles: 1, previousFailingFiles: 2, delta: -1 });
      expect(second.rows.map((row) => row.file)).toEqual([names[1]]);
      const changedPopulation = writeMainFailureDay(root, names.slice(1), names.slice(1).map((file) => capture(file, root)), 'main-c', new Date('2026-10-04T12:00:00Z'));
      expect(changedPopulation).toMatchObject({ failingFiles: 1, previousFailingFiles: null, delta: null });
      expect(readdirSync(join(root, 'test-diet/main-failures')).sort()).toEqual(['2026-10-02.json', '2026-10-03.json', '2026-10-04.json']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('non-running files and runner errors remain unmeasured rather than becoming failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-unmeasured-'));
    const selected = ['test/missing.test.ts', 'test/runner.test.ts', 'test/zero.test.ts'];
    const results = [
      { file: selected[0]!, rc: 1, stdout: '', stderr: 'error: file not found' },
      { file: selected[1]!, rc: 1, stdout: '', stderr: '0 fail\nerror: bun crashed' },
      { file: selected[2]!, rc: 0, stdout: '', stderr: '0 pass\n0 fail\nRan 0 tests across 1 file' },
    ];
    try {
      expect(() => mainFailureRow(results[1]!)).toThrow('test not measured');
      const day = writeMainFailureDay(root, selected, results, 'main-x', new Date('2026-10-02T12:00:00Z'));
      expect(day.rows).toEqual([]);
      expect(day.unmeasured.map((item) => item.file)).toEqual(selected);
      expect(day).toMatchObject({ failingFiles: 0, previousFailingFiles: null, delta: null });
      expect(JSON.parse(readFileSync(mainFailureLedgerPath(root, day.date), 'utf8')).unmeasured).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('defaults to observed candidates, rejects paths outside the repo and refuses an incomplete measurement', () => {
    expect(mainFailureFiles(undefined)).toEqual([...DEFAULT_MAIN_FAILURE_FILES]);
    expect(() => mainFailureFiles(['../bad.test.ts'])).toThrow();
    expect(() => mainFailureFiles([])).toThrow();
    const root = mkdtempSync(join(tmpdir(), 'test-diet-incomplete-'));
    try {
      expect(() => writeMainFailureDay(root, ['test/a.test.ts'], [], 'abc')).toThrow('incomplete');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('unguarded mainFailures runs real Bun against a temporary main checkout and writes only two failing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-main-integration-'));
    const checkout = join(root, 'main');
    const names = ['test/old.test.ts', 'test/external.test.ts', 'test/pass.test.ts'];
    const previous = { NODE_ENV: process.env.NODE_ENV, ELANOUS_TEST_HOME: process.env.ELANOUS_TEST_HOME };
    try {
      mkdirSync(join(checkout, 'test'), { recursive: true });
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ scripts: { 'test:deterministic': 'bun test' } }));
      writeFileSync(join(checkout, names[0]!), "import {test} from 'bun:test'; test('old', () => { throw new Error('Expected old snapshot'); });\n");
      writeFileSync(join(checkout, names[1]!), "import {test} from 'bun:test'; test('external', () => { throw new Error('codex --yolo unavailable'); });\n");
      writeFileSync(join(checkout, names[2]!), "import {test, expect} from 'bun:test'; test('pass', () => expect(2).toBe(2));\n");
      const initialized = spawnSync('git', ['init', '-q', '-b', 'main', checkout], { encoding: 'utf8' });
      expect(initialized.status).toBe(0);
      expect(spawnSync('git', ['-C', checkout, 'add', '.'], { encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { encoding: 'utf8' }).status).toBe(0);
      delete process.env.NODE_ENV;
      delete process.env.ELANOUS_TEST_HOME;
      const at = new Date('2026-10-02T12:00:00Z');
      expect(mainFailures({ input: { files: names }, outputs: {} }, { root, checkout, now: at })).toBe(0);
      const day = JSON.parse(readFileSync(mainFailureLedgerPath(root, '2026-10-02'), 'utf8'));
      expect(day).toMatchObject({ selected: names, failingFiles: 2, unmeasured: [], owner: 'TC', mode: 'shadow' });
      expect(day.rows.map((row: { file: string }) => row.file)).toEqual(names.slice(0, 2));
      expect(day.rows.map((row: { failures: number }) => row.failures)).toEqual([1, 1]);
      expect(day.rows[0]).toMatchObject({ classification: '시험이 낡음', draft: '고침' });
      expect(day.rows[1]).toMatchObject({ classification: '외부 의존', draft: '격리' });
      expect(readdirSync(join(root, 'test-diet/main-failures'))).toEqual(['2026-10-02.json']);
    } finally {
      for (const key of ['NODE_ENV', 'ELANOUS_TEST_HOME'] as const) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('NODE_ENV=test and ELANOUS_TEST_HOME each record without executing or cloning; explicit injection measures only fake tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-guard-'));
    const previous = { NODE_ENV: process.env.NODE_ENV, ELANOUS_TEST_HOME: process.env.ELANOUS_TEST_HOME };
    try {
      for (const key of ['NODE_ENV', 'ELANOUS_TEST_HOME'] as const) {
        delete process.env.NODE_ENV;
        delete process.env.ELANOUS_TEST_HOME;
        process.env[key] = key === 'NODE_ENV' ? 'test' : root;
        expect(mainFailures({ input: { files: ['test/a.test.ts'] }, outputs: {} }, { root })).toBe(0);
        const receipt = JSON.parse(readFileSync(join(root, 'test-diet/main-failures', `${new Date().toISOString().slice(0, 10)}-guard.json`), 'utf8'));
        expect(receipt).toMatchObject({ measured: false, selected: ['test/a.test.ts'], owner: 'TC', mode: 'shadow' });
        expect(readdirSync(join(root, 'test-diet/main-failures'))).toHaveLength(1);
      }
    } finally {
      for (const key of ['NODE_ENV', 'ELANOUS_TEST_HOME'] as const) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('graph connects the executable node after record and actually visits it before done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-graph-'));
    try {
      const graph = parseYaml(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ node_id: string; recipe?: string }>; edges: Array<{ from: string; map: Record<string, string> }> };
      const recipes = parseYaml(readFileSync(join(repo, 'graphs/test-diet/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
      expect(graph.nodes.find((node) => node.node_id === 'main-failures')?.recipe).toBe('cmd:main-failures');
      expect(graph.edges.find((edge) => edge.from === 'record')?.map.ok).toBe('main-failures');
      expect(recipes['main-failures']?.command).toBe('bun scripts/test-diet/node.ts main-failures');
      const state = await runGraph(graphPath, { deps: { root, runBash: async (command) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ outcome: 'ok', summary: command }) + '\n' }) } });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(['pick', 'measure', 'record', 'main-failures', 'done']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
