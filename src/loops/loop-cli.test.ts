import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { inventoryCrontab, listSchedules, openSchedulesDb } from '../domains/schedule-registry.js';
import { registerLoopCommands } from './loop-cli.js';
import { listAllLoops, listLoops } from './registry.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

function command(): Command {
  const program = new Command();
  const root = mkdtempSync(join(tmpdir(), 'loop-cli-activity-'));
  roots.push(root);
  registerLoopCommands(program, { root });
  return program;
}

describe('loop activity CLI', () => {
  test('help documents the window and JSON option on the registered command', () => {
    const activity = command().commands.find(item => item.name() === 'loop')?.commands.find(item => item.name() === 'activity');
    expect(activity).toBeDefined();
    expect(command().commands.find(item => item.name() === 'loop')!.commands.map(item => item.name())).toEqual([
      'list', 'activity', 'status', 'start', 'stop', 'run', 'package',
    ]);
    expect(activity!.helpInformation()).toContain('--since <duration-or-date>');
    expect(activity!.helpInformation()).toContain('24h');
    expect(activity!.helpInformation()).toContain('--json');
  });

  test('human summary shows time window, node and edge counts and column labels, with an empty read-only root', async () => {
    const program = command();
    const root = roots.at(-1)!;
    const printed: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args) => { printed.push(args.join(' ')); });
    try {
      await program.parseAsync(['loop', 'activity', '--since', '1h'], { from: 'user' });
    } finally { log.mockRestore(); }
    expect(process.exitCode).toBe(0);
    expect(printed[0]).toMatch(/^Loop activity .* → .*$/);
    expect(Date.parse(printed[0]!.split(' → ')[1]!) - Date.parse(printed[0]!.slice('Loop activity '.length).split(' → ')[0]!)).toBe(3_600_000);
    expect(printed[1]).toMatch(/^\d+ nodes · 0 edges$/);
    expect(printed).toContain('Nodes (id · state · events · last activity)');
    expect(printed).toContain('Edges (from → to · kind · count · last activity)');
    expect(readdirSync(root)).toEqual([]);
  });

  test('JSON output uses the default 24h window on the actual isolated CLI', () => {
    const run = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'loop', 'activity', '--json'], {
      cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(new TextDecoder().decode(run.stderr)).not.toContain('loop:');
    expect(run.exitCode).toBe(0);
    const activity = JSON.parse(new TextDecoder().decode(run.stdout)) as { since: string; until: string; nodes: unknown[]; edges: unknown[] };
    expect(Date.parse(activity.until) - Date.parse(activity.since)).toBe(86_400_000);
    expect(Array.isArray(activity.nodes)).toBe(true);
    expect(Array.isArray(activity.edges)).toBe(true);
  });
});


async function fixture(args: string[], extraCrons: string[] = []): Promise<{ lines: string[]; writes: string[]; entries: ReturnType<typeof listAllLoops>; legacy: ReturnType<typeof listLoops> }> {
  const root = mkdtempSync(join(tmpdir(), 'loop-cli-all-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  title: Daily\n  owner: OP\n  mode: watch\n  trigger:\n    cron: '0 9,17 * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `0 9,17 * * * cd ${root} && bun bin/elanous.mjs graph run graphs/daily.yaml`,
      '*/15 * * * * bun scripts/seat-loop.ts --seat TC',
      '*/20 * * * * sh scripts/refresh.sh',
      '*/30 * * * * bun scripts/loop-orchestrator.ts',
      '*/5 * * * * elanous future-loop',
      ...extraCrons,
    ].join('\n') + '\n' });
    db.run("UPDATE schedule_registry SET category = 'monitor' WHERE command LIKE '%--seat TC'");
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    const legacy = listLoops(opts);
    const lines: string[] = [];
    const writes: string[] = [];
    const previous = console.log;
    const stdout = process.stdout.write;
    console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
    process.stdout.write = ((chunk: string | Uint8Array, callback?: ((error?: Error | null) => void) | string) => {
      writes.push(String(chunk));
      if (typeof callback === 'function') callback();
      return true;
    }) as typeof process.stdout.write;
    try {
      const program = new Command();
      registerLoopCommands(program, { registryOptions: opts });
      await program.parseAsync(['loop', 'list', ...args], { from: 'user' });
    } finally { console.log = previous; process.stdout.write = stdout; }
    return { lines, writes, entries, legacy };
  } finally { db.close(); }
}

test('list --all renders every layer and unknown last run, then warns only missing elanous cron', async () => {
  const { lines, entries } = await fixture(['--all']);
  expect(lines[0]).toBe('id\t층\t주인 자리\t모드\t기대 주기\t호스트\t울타리 역할\t관측 카테고리\t마지막 실행');
  expect(lines).toHaveLength(entries.length + 2);
  expect(lines[1]).toBe(`daily\tgraph\tOP\twatch\t불규칙 · 최대 960분\t${hostname()}\t모름\tgraph.runner\t모름`);
  expect(lines.some(line => line.includes(`\tseat\tTC\t모름\t15분\t${hostname()}\t모름\tmonitor\t모름`))).toBe(true);
  expect(lines.some(line => line.includes('\tcron-shell\t'))).toBe(true);
  expect(lines.some(line => line.includes('\torchestrator\t'))).toBe(true);
  expect(lines.at(-1)).toMatch(/^미등록 1: .+ \(elanous future-loop\)$/);
});

test('list --all warns about flock -o wrapped unknown elanous cron', async () => {
  const { lines } = await fixture(['--all'], ['*/6 * * * * flock -o /tmp/lock elanous wrapped-loop']);
  expect(lines.at(-1)).toContain('미등록 2:');
  expect(lines.at(-1)).toContain('flock -o /tmp/lock elanous wrapped-loop');
});

test('list --all warning includes quoted env assignment and flock -c, but not registered flock -c', async () => {
  const { lines } = await fixture(['--all'], [
    '*/6 * * * * env FOO="bar" elanous future-loop',
    "*/7 * * * * flock /tmp/lock -c 'elanous future-loop'",
    "*/8 * * * * flock /tmp/lock -c 'bun scripts/seat-loop.ts --seat UX'",
    '*/9 * * * * elanous loop list --all',
    '*/10 * * * * env X=1 elanous config get roleLlm',
  ]);
  expect(lines.some(line => line.includes('\tseat\tUX\t'))).toBe(true);
  // LOOP-REG1E: an elanous-related cron line that is not a loop (config get) is warned, never silently dropped.
  expect(lines.at(-1)).toContain('미등록 4:');
  expect(lines.at(-1)).toContain('env X=1 elanous config get roleLlm');
  expect(lines.at(-1)).toContain('env FOO="bar" elanous future-loop');
  expect(lines.at(-1)).toContain("flock /tmp/lock -c 'elanous future-loop'");
  expect(lines.at(-1)).not.toContain('seat-loop.ts --seat UX');
});

test('list --all --json returns the exact AllLoopEntry array without warning', async () => {
  const { lines, writes, entries } = await fixture(['--all', '--json']);
  expect(lines).toEqual([]);
  expect(JSON.parse(writes.join(''))).toEqual(entries);
});

test('list without --all preserves graph-only JSON shape and non-JSON output', async () => {
  const json = await fixture(['--json']);
  expect(JSON.parse(json.writes.join(''))).toEqual(json.legacy);
  const plain = await fixture([]);
  expect(plain.lines).toEqual([JSON.stringify(plain.legacy, null, 2)]);
});
