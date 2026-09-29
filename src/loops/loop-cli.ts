import type { Command } from 'commander';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { listLoops, loopStatus, runLoop, setLoopEnabled } from './registry.js';

async function output(value: unknown, json: boolean): Promise<void> {
  if (json) await writeStdoutJson(JSON.stringify(value) + '\n');
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function handle(action: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(action).catch(error => {
    console.error(`loop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export function registerLoopCommands(program: Command): void {
  const loop = program.command('loop').description('Inspect and control graph-backed loop agents');
  loop.command('list').option('--json', 'Print JSON')
    .action((opts: { json?: boolean }) => handle(() => output(listLoops(), !!opts.json)));
  loop.command('status <id>').option('--json', 'Print JSON')
    .action((id: string, opts: { json?: boolean }) => handle(() => output(loopStatus(id), !!opts.json)));
  for (const [name, enabled] of [['start', true], ['stop', false]] as const) {
    loop.command(`${name} <id>`).option('--yes', 'Apply the crontab change (otherwise preview only)')
      .option('--json', 'Print JSON')
      .action((id: string, opts: { yes?: boolean; json?: boolean }) => handle(async () => {
        await output(await setLoopEnabled(id, enabled, !!opts.yes), !!opts.json);
      }));
  }
  loop.command('run <id>').option('--dry-run', 'Walk the graph without executing commands')
    .option('--json', 'Print JSON')
    .action((id: string, opts: { dryRun?: boolean; json?: boolean }) => handle(async () => {
      const state = await runLoop(id, !!opts.dryRun);
      await output(state, !!opts.json);
      if (state.status !== 'done' && state.status !== 'awaiting-approval') process.exitCode = 1;
    }));
}
