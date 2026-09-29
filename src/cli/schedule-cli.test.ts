import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerScheduleCommands, runSchedule, runScheduleRuns, scheduleCreatePlan, type ScheduleDispatch } from './schedule-cli.js';
import { listScheduleRuns } from '../domains/schedule-runs.js';

const expectedActions = ['list', 'inspect', 'runs', 'create', 'update', 'enable', 'disable', 'delete', 'wrap', 'unwrap', 'migrate', 'adopt', 'release', 'retarget'];

function commands() {
  const program = new Command();
  registerScheduleCommands(program);
  const schedule = program.commands.find(command => command.name() === 'schedule');
  if (!schedule) throw new Error('schedule command not registered');
  return { program, schedule };
}

test('index registers the extracted schedule command tree once', async () => {
  const { program } = await import('../index.js');
  const schedule = program.commands.filter(command => command.name() === 'schedule');
  expect(schedule).toHaveLength(1);
  expect(schedule[0]!.commands.map(command => command.name())).toEqual(expectedActions);
});

test('registers the full schedule command tree and its option contracts', () => {
  const { program, schedule } = commands();
  expect(program.commands.filter(command => command.name() === 'schedule')).toHaveLength(1);
  expect(schedule.commands.map(command => command.name())).toEqual(expectedActions);
  const options = (action: string) => schedule.commands.find(command => command.name() === action)!.options.map(option => option.long);
  expect(options('list')).toEqual(['--category', '--json']);
  expect(options('inspect')).toEqual(['--json']);
  expect(options('runs')).toEqual(['--limit', '--before', '--json']);
  expect(schedule.commands.find(command => command.name() === 'runs')!.registeredArguments[0].required).toBe(true);
  expect(options('create')).toEqual(['--cron', '--command', '--dry-run', '--from', '--apm', '--json']);
  expect(options('update')).toEqual(['--cron', '--json']);
  expect(options('enable')).toEqual(['--json']);
  expect(options('disable')).toEqual(['--json']);
  expect(options('retarget')).toEqual(['--from', '--to', '--only', '--yes', '--json']);
  for (const action of ['delete', 'wrap', 'unwrap', 'migrate', 'adopt', 'release']) {
    expect(options(action)).toEqual(['--yes', '--json']);
  }
  expect(schedule.commands.find(command => command.name() === 'update')!.options[0].required).toBe(true);
  expect(schedule.commands.find(command => command.name() === 'wrap')!.registeredArguments[0].required).toBe(false);
  expect(schedule.commands.find(command => command.name() === 'unwrap')!.registeredArguments[0].required).toBe(false);
});

test('runs passes id and pagination options to reader and prints KST table', async () => {
  const calls: unknown[] = [];
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
  try {
    await runScheduleRuns('job-a', { limit: '2', before: '2026-09-27T12:00:00Z' }, (id, opts) => {
      calls.push({ id, opts });
      return [{ run_id: 'run-1', fired_at: '2026-09-27T00:30:00Z', status: 'error', exit: 2, duration_ms: 125, via: 'manual' }];
    });
    expect(calls).toEqual([{ id: 'job-a', opts: { limit: 2, before: '2026-09-27T12:00:00Z' } }]);
    expect(output.join('\n')).toContain('2026-09-27 09:30:00');
    expect(output.join('\n')).toContain('error');
    expect(output.join('\n')).toContain('2');
    expect(output.join('\n')).toContain('125ms');
    expect(output.join('\n')).toContain('manual');
    expect(output.join('\n')).toContain('run-1');
  } finally {
    console.log = originalLog;
  }
});

test('runs JSON leaves timestamps and nullable fields intact and uses default limit', async () => {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    output.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runScheduleRuns('job-b', { json: true }, (id, opts) => {
      expect(id).toBe('job-b');
      expect(opts).toEqual({ limit: 20 });
      return [{ run_id: 'run-2', fired_at: '2026-09-27T00:30:00Z', status: 'ok', exit: 0, duration_ms: null, via: 'tick' }];
    });
    expect(JSON.parse(output.join(''))).toEqual([{ run_id: 'run-2', fired_at: '2026-09-27T00:30:00Z', status: 'ok', exit: 0, duration_ms: null, via: 'tick' }]);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('runs returns an empty list when history table has not yet been created', () => {
  const db = new Database(':memory:');
  try {
    expect(listScheduleRuns(db, 'target')).toEqual([]);
  } finally {
    db.close();
  }
});

test('runs reads one id from schedule_runs through listScheduleRuns, with before and limit', async () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT, fired_at TEXT, status TEXT, exit INT, duration_ms INT, via TEXT, run_id TEXT, log_ref TEXT)`);
  db.run(`INSERT INTO schedule_runs VALUES ('r1', 'target', '2026-09-27T00:00:00Z', 'ok', 0, 0, 'tick', NULL, NULL)`);
  db.run(`INSERT INTO schedule_runs VALUES ('r2', 'target', '2026-09-27T01:00:00Z', 'error', 1, 8, 'manual', 'run-2', NULL)`);
  db.run(`INSERT INTO schedule_runs VALUES ('r3', 'other', '2026-09-27T00:30:00Z', 'ok', 0, 3, 'tick', NULL, NULL)`);
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    output.push(String(chunk)); callback?.(); return true;
  }) as typeof process.stdout.write;
  try {
    await runScheduleRuns('target', { limit: '1', before: '2026-09-27T01:00:00Z', json: true }, (id, opts) => listScheduleRuns(db, id, opts));
    expect(JSON.parse(output.join('')).map((row: { id: string }) => row.id)).toEqual(['r1']);
  } finally {
    process.stdout.write = originalWrite;
    db.close();
  }
});

test('runs before compares offset and fractional-second instants, excluding equal boundary', async () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT, fired_at TEXT, status TEXT, exit INT, duration_ms INT, via TEXT, run_id TEXT, log_ref TEXT)`);
  db.run(`INSERT INTO schedule_runs VALUES ('earlier', 'target', '2026-09-26T23:59:59.999Z', 'ok', 0, 1, 'tick', NULL, NULL)`);
  db.run(`INSERT INTO schedule_runs VALUES ('equal', 'target', '2026-09-27T00:00:00.000Z', 'ok', 0, 1, 'tick', NULL, NULL)`);
  db.run(`INSERT INTO schedule_runs VALUES ('later', 'target', '2026-09-27T00:00:00.001Z', 'ok', 0, 1, 'tick', NULL, NULL)`);
  db.run(`INSERT INTO schedule_runs VALUES ('fractional', 'target', '2026-09-27T00:00:00.0003Z', 'ok', 0, 1, 'tick', NULL, NULL)`);
  db.run(`INSERT INTO schedule_runs VALUES ('other', 'other', '2026-09-26T23:59:59.998Z', 'ok', 0, 1, 'tick', NULL, NULL)`);
  const read = (id: string, opts: { limit: number; before?: string }) => listScheduleRuns(db, id, opts);
  try {
    expect(read('target', { limit: 20, before: '2026-09-27T09:00:00+09:00' }).map(row => String(row.id))).toEqual(['earlier']);
    expect(read('target', { limit: 20, before: '2026-09-27T09:00:00.001+09:00' }).map(row => String(row.id))).toEqual(['fractional', 'equal', 'earlier']);
    expect(read('target', { limit: 1, before: '2026-09-27T09:00:00.001+09:00' }).map(row => String(row.id))).toEqual(['fractional']);
    expect(read('target', { limit: 20, before: '2026-09-27T00:00:00.000Z' }).map(row => String(row.id))).toEqual(['earlier']);
    expect(read('target', { limit: 20, before: '2026-09-27T00:00:00.0004Z' }).map(row => String(row.id))).toEqual(['fractional', 'equal', 'earlier']);
    expect(read('target', { limit: 20, before: '2026-09-27T00:00:00.0003Z' }).map(row => String(row.id))).toEqual(['equal', 'earlier']);
    expect(read('target', { limit: 20, before: '2026-09-27T00:00:00.0002Z' }).map(row => String(row.id))).toEqual(['equal', 'earlier']);
    expect(read('target', { limit: 20, before: '2026-09-27T00:00:00.0000Z' }).map(row => String(row.id))).toEqual(['earlier']);
  } finally {
    db.close();
  }
});

test('registered runs command reads history from isolated schedules.db', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-runs-cli-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  const { resetEffectiveInstanceRoot } = await import('../instance/resolve.js');
  try {
    process.env.ELANOUS_STATE_DIR = dir;
    resetEffectiveInstanceRoot();
    const { openSchedulesDb } = await import('../domains/schedule-registry.js');
    const db = openSchedulesDb();
    expect(listScheduleRuns(db, 'target')).toEqual([]);
    // openSchedulesDb 가 정본 이력 표(id 자동 증가)를 만든다 — 행 표지는 run_id 로 단다.
    const insert = db.prepare(`INSERT INTO schedule_runs (schedule_id, fired_at, status, exit, duration_ms, via, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('target', '2026-09-27T00:00:00Z', 'ok', 0, 0, 'tick', 'r1');
    insert.run('target', '2026-09-27T00:00:00.001Z', 'error', 1, 8, 'manual', 'r2');
    insert.run('other', '2026-09-26T23:59:59Z', 'ok', 0, 3, 'tick', 'r3');
    db.close();
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      output.push(String(chunk)); callback?.(); return true;
    }) as typeof process.stdout.write;
    const { program } = commands();
    await program.parseAsync(['schedule', 'runs', 'target', '--limit', '1', '--before', '2026-09-27T09:00:00.001+09:00', '--json'], { from: 'user' });
    expect(JSON.parse(output.join('')).map((row: { run_id: string }) => row.run_id)).toEqual(['r1']);
  } finally {
    process.stdout.write = originalWrite;
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    resetEffectiveInstanceRoot();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runs refuses invalid limit or non-ISO before without reading', async () => {
  const reader = () => { throw new Error('unexpected read'); };
  await expect(runScheduleRuns('job', { limit: '0' }, reader)).rejects.toThrow('--limit');
  await expect(runScheduleRuns('job', { limit: '1.2' }, reader)).rejects.toThrow('--limit');
  await expect(runScheduleRuns('job', { before: 'yesterday' }, reader)).rejects.toThrow('--before');
  await expect(runScheduleRuns('job', { before: '2026-02-30T00:00:00Z' }, reader)).rejects.toThrow('--before');
  await expect(runScheduleRuns('job', { before: '2025-02-29T00:00:00Z' }, reader)).rejects.toThrow('--before');
  let acceptedLeapDay = false;
  await runScheduleRuns('job', { before: '2024-02-29T00:00:00.0004Z', json: true }, (id, opts) => {
    acceptedLeapDay = true;
    expect(opts.before).toBe('2024-02-29T00:00:00.0004Z');
    return [];
  });
  expect(acceptedLeapDay).toBe(true);
  await expect(runScheduleRuns('job', { before: '' }, reader)).rejects.toThrow('--before에는 유효한 ISO 시각이 필요합니다.');
  const { program } = commands();
  await expect(program.parseAsync(['schedule', 'runs', 'job', '--before', ''], { from: 'user' })).rejects.toThrow('--before에는 유효한 ISO 시각이 필요합니다.');
});

test('create rejects absent cron/command', async () => {
  const { program } = commands();
  await expect(program.parseAsync(['schedule', 'create'], { from: 'user' })).rejects.toThrow('create에는 --cron과 --command가 필요합니다.');
  await expect(program.parseAsync(['schedule', 'create', '--command', 'scripts/foo.ts'], { from: 'user' })).rejects.toThrow('create에는 --cron과 --command가 필요합니다.');
});

test('dry-run and guarded destructive actions never dispatch', async () => {
  const calls: Record<string, unknown>[] = [];
  const dispatch: ScheduleDispatch = async args => { calls.push(args); return { applied: true }; };
  const exits: number[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    for (const action of ['migrate', 'adopt', 'release', 'delete']) {
      await runSchedule(action, { id: 'job', json: true }, dispatch, code => exits.push(code));
    }
    await runSchedule('create', { dryRun: true, json: true }, dispatch, code => exits.push(code));
    expect(calls).toEqual([]);
    expect(exits).toEqual([0, 0, 0, 0, 1]);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('create plan parses specification and dispatch forwards its values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-cli-'));
  const from = join(dir, 'spec.md');
  const exits: number[] = [];
  const calls: Record<string, unknown>[] = [];
  const originalWrite = process.stdout.write;
  try {
    await writeFile(from, '- **주기:** 매일 한 번.\ncron: `0 7 * * *`\nbun bin/elanous.mjs self parked --json\nreports/ops/once.json\n');
    const plan = await scheduleCreatePlan({ dryRun: true, from });
    expect(plan).toMatchObject({ dryRun: true, plan: { schedule: { found: '매일 한 번' }, cron: { found: '0 7 * * *' } } });
    process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    await runSchedule('create', { from, json: true, apm: 'mission' }, async args => {
      calls.push(args);
      return { created: true };
    }, code => exits.push(code));
    expect(calls).toEqual([{
      action: 'create', id: undefined, category: undefined, cron: '0 7 * * *',
      command: 'bun bin/elanous.mjs self parked --json', schedule: '매일 한 번',
      resultPath: 'reports/ops/once.json', yes: true, autopilotId: 'mission',
    }]);
    expect(exits).toEqual([0]);
  } finally {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

test('direct list and --yes dispatch preserve their original arguments', async () => {
  const calls: Record<string, unknown>[] = [];
  const exits: number[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    const dispatch: ScheduleDispatch = async args => { calls.push(args); return { ok: true }; };
    await runSchedule('list', { category: 'monitor', json: true }, dispatch, code => exits.push(code));
    await runSchedule('delete', { id: 'job', yes: true, json: true }, dispatch, code => exits.push(code));
    expect(calls).toEqual([
      { action: 'list', id: undefined, category: 'monitor', cron: undefined, command: undefined },
      { action: 'delete', id: 'job', category: undefined, cron: undefined, command: undefined, yes: true },
    ]);
    expect(exits).toEqual([0, 0]);
  } finally {
    process.stdout.write = originalWrite;
  }
});
