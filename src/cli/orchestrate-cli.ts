/**
 * `elanous orchestrate map` — fan one task out to N worker children and reduce their answers (ORCHESTRATE-MAP-GENERAL).
 * Product feature behind the invest demo's fan-out: any task, any items, a mix of eln · codex · claude workers.
 */
import type { Command } from 'commander';

export function registerOrchestrateCommand(program: Command): void {
  const orc = program.commands.find((c) => c.name() === 'orchestrate') ?? program.command('orchestrate').description('Orchestration patterns: fan a task out to worker children and reduce the answers');
  orc.command('map')
    .description('Map-reduce: one child per item (or shard), then a reducer. Writes result.md, receipt.json and a stage feed')
    .requiredOption('--task <prompt|file>', 'the task: a prompt, or a file holding it ({item} {n} {total} are filled in per child)')
    .requiredOption('--over <items-file|N>', 'items: a JSON array or one-per-line file, or a number N of shards')
    .option('--workers <list>', 'worker rotation: eln,codex,claude (or eln:2,claude:1 · sim for a simulated pane)', 'eln')
    .option('--reduce <reducer>', 'consensus | concat | vote | llm-summary', 'concat')
    .option('--max-parallel <k>', 'children at once (cap 6)', '3')
    .option('--timeout <sec>', 'per-child timeout in seconds (one retry on failure)', '180')
    .option('--els', 'run each child as a visible els tab «ORC·<id>·<n>» (falls back to headless when tabs are refused)')
    .option('--ws <workspace>', 'els workspace for the child tabs', 'orchestrate')
    .option('--out <dir>', 'where the run folder goes (default: <state>/orchestrate)')
    .option('--id <id>', 'run id (default: generated) — the run folder is <out>/orc-<id>')
    .option('--json', 'print the receipt as JSON')
    .action(async (o: { task: string; over: string; workers: string; reduce: string; maxParallel: string; timeout: string; els?: boolean; ws: string; out?: string; id?: string; json?: boolean }) => {
      const m = await import('../orchestrate/map.js');
      const { join } = await import('node:path');
      try {
        if (!m.REDUCERS.includes(o.reduce as never)) throw new Error(`--reduce: unknown reducer «${o.reduce}» (${m.REDUCERS.join(' · ')})`);
        const items = m.parseOver(o.over), workers = m.parseWorkers(o.workers), task = m.readTask(o.task);
        const { effectiveInstanceRoot } = await import('../instance/resolve.js');
        const stateRoot = process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot();
        let els: { cli: string[]; env: NodeJS.ProcessEnv; ws: string; fanout: boolean } | undefined;
        if (o.els) {
          const cli = [process.execPath, join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs')];
          // The els of this universe: an els credential or socket inherited from another els never decides.
          const { stateDirSourceForChild } = await import('../agent/identity-env.js');
          const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_STATE_DIR: stateRoot, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(stateRoot) };
          if (env.ELANOUS_ELS_SOCKET !== join(stateRoot, 'els', 'els.sock')) for (const k of ['ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_WS']) delete env[k];
          const fanout = await m.elsHasFanout(cli, env);
          els = { cli, env, ws: o.ws, fanout };
        }
        const controller = new AbortController();
        const onSig = () => { console.error('orchestrate: cancelling — closing the tabs this map opened'); controller.abort(); };
        process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
        const r = await m.runMap({ task, items, workers, reducer: o.reduce as never, maxParallel: Number(o.maxParallel) || m.DEFAULT_PARALLEL, timeoutMs: (Number(o.timeout) || 180) * 1000,
          outDir: o.out ?? join(stateRoot, 'orchestrate'), ...(o.id ? { id: o.id } : {}), signal: controller.signal, ...(els ? { els } : {}) });
        process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(r.reduce.output);
          console.log(`\n${r.ok}/${r.items} children answered · ${Math.round(r.durationMs / 1000)}s · ${r.mode}${r.modeNote ? ` (${r.modeNote})` : ''}${r.failed ? ` · failed: ${r.failures.map((f) => `${f.n} ${f.error}`).join('; ')}` : ''}`);
          console.log(`result ${r.paths.result}\nreceipt ${r.paths.receipt}\nstage feed ${r.paths.feed}`);
        }
        process.exitCode = r.cancelled ? 130 : r.ok === 0 ? 1 : 0;
      } catch (e) { console.error(`orchestrate map: ${(e as Error).message}`); process.exitCode = 2; }
    });
}
