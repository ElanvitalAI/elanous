import type { Command } from 'commander';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { listLoops, loopStatus, runLoop, setLoopEnabled } from './registry.js';
import { checkLoops, countLoopStates, entriesFromRegistry, LOOP_STATES, notifyOwners, observeLoopCheck, type RegistryAdapterDeps } from './checker.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { verifyLoopPackage } from './package/verify.js';

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

export function registerLoopCommands(program: Command, checkerDeps: RegistryAdapterDeps & { root?: string } = {}): void {
  const loop = program.command('loop').description('Inspect and control graph-backed loop agents');
  loop.command('list').option('--json', 'Print JSON')
    .action((opts: { json?: boolean }) => handle(() => output(listLoops(), !!opts.json)));
  loop.command('status [id]').option('--all', 'Check all registered loops')
    .option('--json', 'Print JSON').option('--notify', 'Queue late/failing loops for their owners')
    .action((id: string | undefined, opts: { all?: boolean; json?: boolean; notify?: boolean }) => handle(async () => {
      if (!opts.all) {
        if (!id) throw new Error('loop status requires an id or --all');
        await output(loopStatus(id), !!opts.json);
        return;
      }
      if (id) throw new Error('loop status --all does not take an id');
      const now = checkerDeps.now ?? new Date();
      const root = checkerDeps.root ?? effectiveInstanceRoot();
      const { entries, scope } = entriesFromRegistry({ ...checkerDeps, now });
      const results = checkLoops(entries, now);
      const counts = countLoopStates(results);
      observeLoopCheck(results, scope, { root, now });
      if (opts.notify) notifyOwners(results, { root, now });
      if (opts.json) { await output({ results, counts, scope }, true); return; }
      console.log('id\tstate\tlast run\texpected interval\towner\treason');
      for (const result of results) console.log(`${result.id}\t${result.state}\t${result.lastRunAt ?? '—'}\t${result.expectEveryMinutes === undefined ? '—' : `${result.expectEveryMinutes}m`}\t${result.owner ?? '—'}\t${result.reason}`);
      console.log(`${LOOP_STATES.map(state => `${state} ${counts[state]}`).join(' · ')} · scope ${scope}`);
    }));
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
  loop.command('package').description('Inspect a loop package without installing it')
    .command('verify <dir>').option('--json', 'Print JSON')
    .action((dir: string, opts: { json?: boolean }) => handle(async () => {
      const result = verifyLoopPackage(dir);
      if (opts.json) await output(result, true);
      else {
        if (result.ok) console.log('OK');
        else for (const error of result.errors) console.log(error);
        console.log(`loop-package ${String(result.merged?.id ?? '?')} ${String(result.merged?.version ?? '?')} ${result.ok ? 'ok' : 'refused'} errors=${result.errors.length}`);
      }
      if (!result.ok) process.exitCode = 1;
    }));
}
