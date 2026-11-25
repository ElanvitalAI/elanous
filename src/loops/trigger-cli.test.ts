import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerTriggerCommands, triggerTickCommand } from './trigger-cli.js';

let dir: string;
let logs: string[];
const origLog = console.log;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trigger-cli-')); logs = []; console.log = (...a: unknown[]) => { logs.push(a.join(' ')); }; });
afterEach(() => { console.log = origLog; rmSync(dir, { recursive: true, force: true }); });

function program(schedules: Array<{ id: string; command: string; command_full: string }>, calls: Array<Record<string, unknown>>): Command {
  const p = new Command().exitOverride();
  const loop = p.command('loop');
  registerTriggerCommands(loop, { root: '/repo/root', stateRoot: dir, configDir: '/cfg/u1', scheduleManage: async args => {
    calls.push(args);
    if (args.action === 'list') return { schedules };
    return { created: 'line' };
  } });
  return p;
}

test('tick command is one crontab line carrying the universe and the registry marker', () => {
  expect(triggerTickCommand('/repo/root', '/state/u1', '/bin/bun', '/cfg/u1'))
    .toBe('cd /repo/root && /bin/bun bin/elanous.mjs --config-dir /cfg/u1 loop trigger tick --state-root /state/u1 --json >/dev/null 2>&1 # elanous-loop=graph-trigger-tick');
});

test('install creates the tick entry once through the schedule CRUD; a second install is a no-op', async () => {
  const calls: Array<Record<string, unknown>> = [];
  await program([], calls).parseAsync(['loop', 'trigger', 'install', '--yes'], { from: 'user' });
  const create = calls.find(c => c.action === 'create')!;
  expect(create.cron).toBe('*/2 * * * *');
  expect(String(create.command)).toContain('--config-dir /cfg/u1 loop trigger tick');
  const again: Array<Record<string, unknown>> = [];
  await program([{ id: 'abc123', command: 'cd x && bun bin/elanous.mjs loop trigger tick', command_full: 'cd x && bun bin/elanous.mjs loop trigger tick # elanous-loop=graph-trigger-tick' }], again)
    .parseAsync(['loop', 'trigger', 'install', '--yes'], { from: 'user' });
  expect(again.map(c => c.action)).toEqual(['list']);
  expect(logs.at(-1)).toContain('"installed": false');
});

test('install without --yes only previews', async () => {
  const calls: Array<Record<string, unknown>> = [];
  await program([], calls).parseAsync(['loop', 'trigger', 'install'], { from: 'user' });
  expect(calls.map(c => c.action)).toEqual(['list']);
  expect(logs.at(-1)).toContain('"dryRun": true');
});
