import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { observeModelInputTokens } from '../harness/model-input-observation.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { registerLogsCommands } from './logs-cli.js';
import { renderModelInput, runLogsModelInput, summarizeModelInput, type LogsModelInputDeps } from './logs-model-input.js';

const now = Date.parse('2026-10-04T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeStore(entries: Array<{ ts: number; data: unknown; category?: string; event?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-input-report-'));
  dirs.push(dir);
  const path = join(dir, 'logs.db');
  const store = new LogStore(path, { instance: 'test' });
  store.insertBatch(entries.map(({ ts, data, category = 'harness.model-input', event = 'recorded' }) => ({
    rec: { ts: new Date(ts).toISOString(), category, event, data }, surface: 'harness:self-implement',
  })));
  store.close();
  return path;
}
function record(scope: string, nodeKind: string, inputTokens: number | null, status = inputTokens === null ? 'unmeasured' : 'measured'): unknown {
  return { scope, nodeKind, inputTokens, status };
}
function deps(paths: string[], outputs: string[], errors: string[]): LogsModelInputDeps {
  return {
    exists: existsSync, openReadOnly: LogStore.openReadOnly,
    resolveTargets: () => ({ targets: paths.map((dbPath, index) => ({ dbPath, name: `store${index}` })) }),
    now: () => now, write: (line) => outputs.push(line), writeError: (line) => errors.push(line),
  };
}

describe('logs model-input baseline', () => {
  test('read-only log window groups node kinds and scopes; p50/p90 exclude unmeasured but retain measured zero', () => {
    const path = makeStore([
      { ts: now - 4 * 86_400_000, data: record('harness-node', 'review', 99999) },
      ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((n) => ({ ts: now - 200_000 + n, data: record('harness-node', 'review', n) })),
      { ts: now - 1000, data: record('harness-node', 'review', null) },
      { ts: now - 1001, data: record('harness-node', 'review', null) },
      { ts: now - 500, data: record('loop-tick', 'review', 140) },
      { ts: now - 400, data: record('loop-tick', 'plan', null) },
      { ts: now - 300, data: record('harness-node', 'plan', 0, 'unmeasured') },
      { ts: now - 200, data: record('harness-node', 'plan', -1) },
      { ts: now - 100, data: record('harness-node', 'plan', 1), category: 'unrelated' },
    ]);
    const outputs: string[] = [];
    const errors: string[] = [];
    expect(runLogsModelInput({ json: true }, deps([path], outputs, errors))).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(outputs[0]!);
    expect(report).toEqual({
      since: new Date(now - 3 * 86_400_000).toISOString(), until: new Date(now).toISOString(),
      stores: ['store0'], records: 14,
      baselines: [
        { scope: 'harness-node', nodeKind: 'review', measured: 10, unmeasured: 2, median: 45, p90: 80 },
        { scope: 'loop-tick', nodeKind: 'plan', measured: 0, unmeasured: 1, median: null, p90: null },
        { scope: 'loop-tick', nodeKind: 'review', measured: 1, unmeasured: 0, median: 140, p90: 140 },
      ],
    });
    expect(renderModelInput(report)).toContain('loop-tick\tplan\t0\t—\t—\t1');
    const store = LogStore.openReadOnly(path);
    try { expect(store.query({ exactCategories: ['harness.model-input'], events: ['recorded'], sinceMs: now - 3 * 86_400_000, limit: 100 })).toHaveLength(16); }
    finally { store.close(); }
  });

  test('window scan continues beyond the normal most-recent 100 log rows', () => {
    const path = makeStore(Array.from({ length: 120 }, (_, index) => ({
      ts: now - 120_000 + index, data: record('harness-node', 'plan', index),
    })));
    const outputs: string[] = [], errors: string[] = [];
    expect(runLogsModelInput({ json: true }, deps([path], outputs, errors))).toBe(0);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ records: 120, baselines: [
      { measured: 120, unmeasured: 0, median: 59.5, p90: 107 },
    ] });
    expect(errors).toEqual([]);
  });

  test('all stores retain distinct executions even when timestamp and payload are identical', () => {
    const event = { ts: now - 1000, data: record('harness-node', 'implement', 25) };
    const first = makeStore([event, event]);
    const second = makeStore([event]);
    const outputs: string[] = [], errors: string[] = [];
    expect(runLogsModelInput({ all: true, includeTest: true, json: true }, deps([first, second], outputs, errors))).toBe(0);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ records: 3, stores: ['store0', 'store1'], baselines: [{ measured: 3, median: 25, p90: 25 }] });
    expect(errors).toEqual([]);
    outputs.length = 0;
    expect(runLogsModelInput({ since: '2d', json: true }, deps([first], outputs, errors))).toBe(0);
    expect(JSON.parse(outputs[0]!).since).toBe(new Date(now - 2 * 86_400_000).toISOString());
  });

  test('no measurements show unavailable percentile instead of zero; empty window is explicit', () => {
    const path = makeStore([{ ts: now - 1000, data: record('harness-node', 'review', null) }]);
    const output: string[] = [], errors: string[] = [];
    expect(runLogsModelInput({}, deps([path], output, errors))).toBe(0);
    expect(output[0]).toContain('harness-node\treview\t0\t—\t—\t1');
    output.length = 0;
    expect(runLogsModelInput({ since: new Date(now - 100).toISOString() }, deps([path], output, errors))).toBe(0);
    expect(output[0]).toContain('(관측 표본 없음)');
    expect(errors).toEqual([]);
  });

  test('invalid window and absent store reject, rather than publishing a misleading baseline', () => {
    const output: string[] = [], errors: string[] = [];
    expect(runLogsModelInput({ since: 'nonsense' }, deps([], output, errors))).toBe(1);
    expect(runLogsModelInput({}, deps(['/missing-logs.db'], output, errors))).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  test('registered logs model-input --json reports observations emitted to an isolated log store', () => {
    const root = mkdtempSync(join(tmpdir(), 'model-input-cli-'));
    dirs.push(root);
    const state = join(root, '.elanous-test');
    mkdirSync(state);
    const store = new LogStore(join(state, 'logs', 'logs.db'), { instance: 'test:model-input-cli' });
    const sink = new StoreSink(store, 'harness:self-implement', { installExitHandlers: false });
    const off = debug.registerSink(sink);
    try {
      for (const tokens of [10, 30, 50]) {
        observeModelInputTokens({ scope: 'harness-node', nodeKind: 'review', runId: `run-${tokens}` }, tokens);
      }
      observeModelInputTokens({ scope: 'harness-node', nodeKind: 'review', runId: 'run-unknown' });
      observeModelInputTokens({ scope: 'loop-tick', nodeKind: 'research', tickId: 'tick-unknown' });
      sink.flush();
    } finally {
      off();
      sink.close();
      store.close();
    }
    const cli = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
    const result = spawnSync('bun', [cli, 'logs', 'model-input', '--test', '--json', '--since', '1d'], {
      cwd: root, env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: state }, encoding: 'utf8', timeout: 120_000,
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.records).toBe(5);
    expect(report.baselines).toEqual([
      { scope: 'harness-node', nodeKind: 'review', measured: 3, unmeasured: 1, median: 30, p90: 50 },
      { scope: 'loop-tick', nodeKind: 'research', measured: 0, unmeasured: 1, median: null, p90: null },
    ]);
  });

  test('CLI registers model-input subcommand and scope/time/JSON flags', () => {
    const program = new Command();
    registerLogsCommands(program);
    const logs = program.commands.find((command) => command.name() === 'logs');
    const command = logs?.commands.find((item) => item.name() === 'model-input');
    expect(command).toBeDefined();
    expect(logs?.commands.map((item) => item.name())).toEqual(expect.arrayContaining(['durations', 'degenerate', 'fields']));
    expect(command!.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      '--since', '--json', '--test', '--instance', '--all', '--include-test',
    ]));
  });

  test('strict parser does not turn malformed input into a measured zero', () => {
    const path = makeStore([{ ts: now - 1000, data: record('harness-node', 'plan', 0, 'unmeasured') }]);
    const store = LogStore.openReadOnly(path);
    try {
      const report = summarizeModelInput(store.query({ limit: 100 }), new Date(now - 3000).toISOString(), new Date(now).toISOString(), ['store0']);
      expect(report).toMatchObject({ records: 0, baselines: [] });
    } finally { store.close(); }
  });
});
