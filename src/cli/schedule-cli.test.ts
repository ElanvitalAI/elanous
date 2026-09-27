import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerScheduleCommands, runSchedule, scheduleCreatePlan, type ScheduleDispatch } from './schedule-cli.js';

const expectedActions = ['list', 'inspect', 'create', 'update', 'enable', 'disable', 'delete', 'wrap', 'unwrap', 'migrate', 'adopt', 'release', 'retarget'];

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
