import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner } from './gate-node';
import { parseFailures } from './gate-diff';
import { debug } from '../../src/debug/log.js';
import { PodPoolScheduler } from '../../src/task-orchestrator/surfaces/pod-pool.js';

// GATE-SKIP-KNOWN-RETRY (F1) ⊕ GATE-ISOLATE-FAILED-FILES (F2).
const CUT = 'a'.repeat(40);
const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const suite = (file: string, name: string, fail: boolean) =>
  `<testsuite name="${file}" file="${file}" tests="1" failures="${fail ? 1 : 0}">`
  + (fail ? `<testcase name="${name}" file="${file}"><failure message="x"/></testcase>` : `<testcase name="${name}" file="${file}"/>`)
  + '</testsuite>';
/** The whole shard: summary counts two failures but the console names only one (unattributed); junit names both. */
const rootJunit = `<testsuites>${suite(files[0]!, 'A', true)}${suite(files[1]!, 'B', true)}${suite(files[2]!, 'C', false)}${suite(files[3]!, 'D', false)}</testsuites>`;
const rootLog = 'src/a.test.ts:\n(fail) A [1.00ms]\n2 pass\n2 fail\nRan 4 tests across 4 files.\n';

function setup(withJunit: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'gate-retry-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const calls: string[][] = [];
  const events: Array<[string, unknown]> = [];
  const runner = createGateRunner(repo, undefined, async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: CUT };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: files.join('\n') };
    return { rc: 0, output: '' };
  }, async (o) => {
    const paths = files.filter((file) => o.command[2]!.includes(`'./${file}'`));
    calls.push(paths);
    const artifactsDir = join(root, `job-${calls.length}`);
    mkdirSync(artifactsDir);
    let log: string;
    if (paths.length === files.length) {
      log = rootLog;
      if (withJunit) writeFileSync(join(artifactsDir, 'junit.xml'), (globalThis as { __emptyJunit?: string }).__emptyJunit ?? rootJunit);
    } else {
      const failing = paths.filter((file) => file === files[0] || file === files[1]);
      log = failing.map((file) => `${file}:\n(fail) ${file === files[0] ? 'A' : 'B'} [1.00ms]`).join('\n')
        + `\n${paths.length - failing.length} pass\n${failing.length} fail\nRan ${paths.length} tests across ${paths.length} files.\n`;
    }
    writeFileSync(join(artifactsDir, 'shard.log'), log);
    writeFileSync(join(artifactsDir, 'shard.rc'), log.includes('(fail)') ? '1\n' : '0\n');
    return { exitCode: 0, artifactsDir, job: 'fake' };
  }, new PodPoolScheduler([{ context: 'pool-test', capacity: 4, k3dCluster: 'test' }]));
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release-loop.gate' && /^(retry-|pod-shard-split|pod-shard-cap-split)/.test(event)) events.push([event, data]);
  });
  return { runner, calls, events, restore: () => log.mockRestore() };
}

test('F1: a shard failing only with baseline-known ids starts no retry and keeps its failures for the verdict', async () => {
  const { runner, calls, events, restore } = setup(true);
  try {
    const result = await runner.sweep('/unused', undefined, { pool: 'pool-test', shards: 1, knownFailures: ['src/a.test.ts > A', 'src/b.test.ts > B', 'src/x.test.ts > X'] });
    expect(calls).toHaveLength(1);
    expect(result.rc).toBe(1);
    expect(parseFailures(result.output).sort()).toEqual(['src/a.test.ts > A', 'src/b.test.ts > B']);
    expect(result.output).toContain('2 fail');
    expect(events).toEqual([['retry-skipped-known', { shard: 0, failures: 2 }]]);
  } finally { restore(); }
});

test('F1: a shard with one new failure still retries', async () => {
  const { runner, calls, events, restore } = setup(true);
  try {
    const result = await runner.sweep('/unused', undefined, { pool: 'pool-test', shards: 1, knownFailures: ['src/a.test.ts > A'] });
    expect(calls.length).toBeGreaterThan(1);
    expect(events.map(([event]) => event)).not.toContain('retry-skipped-known');
    expect(parseFailures(result.output).sort()).toEqual(['src/a.test.ts > A', 'src/b.test.ts > B']);
  } finally { restore(); }
});

test('F2: with junit the retry re-runs only the files that failed, and the passed files keep their result', async () => {
  const { runner, calls, events, restore } = setup(true);
  try {
    const result = await runner.sweep('/unused', undefined, { pool: 'pool-test', shards: 1 });
    expect(calls).toEqual([files, [files[0], files[1]]]);
    expect(events).toEqual([['retry-narrowed', { shard: 0, before: 4, after: 2 }]]);
    expect(parseFailures(result.output).sort()).toEqual(['src/a.test.ts > A', 'src/b.test.ts > B']);
    expect(result.passedIds).toEqual(['src/c.test.ts > C', 'src/d.test.ts > D']);
    expect(result.output).toContain('Ran 4 tests across 4 files.');
  } finally { restore(); }
});

test('F2: without junit the shard falls back to the old split', async () => {
  const { runner, calls, events, restore } = setup(false);
  try {
    const result = await runner.sweep('/unused', undefined, { pool: 'pool-test', shards: 1, knownFailures: ['src/a.test.ts > A', 'src/b.test.ts > B'] });
    expect(calls).toEqual([files, [files[0], files[1]], [files[2], files[3]]]);
    expect(events.map(([event]) => event)).toEqual(['pod-shard-split']);
    expect(parseFailures(result.output).sort()).toEqual(['src/a.test.ts > A', 'src/b.test.ts > B']);
  } finally { restore(); }
});

test('F2: a file whose junit suite is empty (no testcase) counts as no result and is re-run', async () => {
  const { runner, calls, restore } = setup(true);
  const empty = rootJunit.replace(suite(files[2]!, 'C', false), `<testsuite name="${files[2]}" file="${files[2]}" tests="0" failures="0"></testsuite>`);
  const write = (globalThis as { __emptyJunit?: string });
  write.__emptyJunit = empty;
  try {
    const result = await runner.sweep('/unused', undefined, { pool: 'pool-test', shards: 1 });
    expect(calls[1]).toEqual([files[0], files[1], files[2]]);
    expect(parseFailures(result.output).sort()).toEqual(['src/a.test.ts > A', 'src/b.test.ts > B']);
  } finally { delete write.__emptyJunit; restore(); }
});
