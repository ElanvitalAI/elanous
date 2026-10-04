import type { Command } from 'commander';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { listAllLoops, listLoops, loopStatus, runLoop, setLoopEnabled, unregisteredCronLoops, type AllLoopEntry, type LoopRegistryOptions } from './registry.js';
import { checkLoops, countLoopStates, entriesFromRegistry, LOOP_STATES, notifyOwners, observeLoopCheck, type RegistryAdapterDeps } from './checker.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { verifyLoopPackage } from './package/verify.js';
import { loopActivity } from './activity.js';

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

function allLoopTable(entries: AllLoopEntry[]): void {
  console.log('id\t층\t주인 자리\t모드\t기대 주기\t호스트\t울타리 역할\t관측 카테고리\t마지막 실행');
  for (const entry of entries) {
    const interval = entry.expectEveryMinutes === undefined ? '모름'
      : entry.cronIrregular ? `불규칙 · 최대 ${entry.expectEveryMinutes}분` : `${entry.expectEveryMinutes}분`;
    console.log([entry.id, entry.kind, entry.owner ?? '모름', entry.mode ?? '모름', interval,
      entry.host ?? '모름', entry.fenceRole ?? '모름', entry.observationCategory ?? '모름', entry.lastRunAt ?? '모름'].join('\t'));
  }
}

export function registerLoopCommands(program: Command, checkerDeps: RegistryAdapterDeps & { root?: string; registryOptions?: LoopRegistryOptions } = {}): void {
  const loop = program.command('loop').description('Inspect and control graph-backed loop agents');
  loop.command('list').option('--all', 'Show the full loop registry').option('--json', 'Print JSON')
    .action((opts: { all?: boolean; json?: boolean }) => handle(async () => {
      if (!opts.all) { await output(listLoops(checkerDeps.registryOptions), !!opts.json); return; }
      const registryOpts = checkerDeps.registryOptions ?? {};
      const entries = listAllLoops(registryOpts);
      if (opts.json) { await output(entries, true); return; }
      allLoopTable(entries);
      const missing = unregisteredCronLoops(entries, registryOpts);
      if (missing.length) console.log(`미등록 ${missing.length}: ${missing.map(row => `${row.id} (${row.command})`).join(', ')}`);
    }));
  loop.command('activity').description('Read loop and seat activity in a time window (default: last 24h)')
    .option('--since <duration-or-date>', 'Start of window: duration (e.g. 24h) or ISO date', '24h')
    .option('--json', 'Print JSON')
    .action((opts: { since: string; json?: boolean }) => handle(async () => {
      const activity = loopActivity({ since: opts.since, root: checkerDeps.root ?? effectiveInstanceRoot() });
      if (opts.json) { await output(activity, true); return; }
      console.log(`Loop activity ${activity.since} → ${activity.until}`);
      console.log(`${activity.nodes.length} nodes · ${activity.edges.length} edges`);
      console.log('Nodes (id · state · events · last activity)');
      for (const node of activity.nodes) console.log(`${node.id} · ${node.state ?? '—'} · ${node.events} · ${node.lastAt ?? '—'}`);
      console.log('Edges (from → to · kind · count · last activity)');
      for (const edge of activity.edges) console.log(`${edge.from} → ${edge.to} · ${edge.kind} · ${edge.count} · ${edge.lastAt}`);
    }));
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
