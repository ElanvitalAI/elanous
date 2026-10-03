import type { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { debug } from '../debug/log.js';
import { decideGraphApproval, graphRunAlive, lastJsonObject, latestGraphRun, listGraphRuns, runGraph, type GraphRunState } from './runner.js';

function findGraphFile(graphId: string): string | undefined {
  const roots = [resolve('graphs'), resolve(import.meta.dir, '../../graphs')];
  for (const root of roots) {
    for (const dir of [root, ...['release', 'ops'].map((part) => join(root, part))]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.yaml') || name === 'recipes.yaml') continue;
        const file = join(dir, name);
        if (!existsSync(join(dir, 'recipes.yaml'))) continue;
        try {
          const parsed: unknown = parseYaml(readFileSync(file, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).graph_id === graphId) return file;
        } catch { continue; }
      }
    }
  }
  return undefined;
}

export function registerGraphCommands(program: Command, runsDeps: { root?: string; processStartMs?: (pid: number) => number | null } = {}): void {
  const graph = program.command('graph').description('Run a declared command graph or inspect its latest run');
  graph.command('run <file>')
    .option('--dry-run', 'Walk the success path without executing commands')
    .option('--json', 'Print run state as JSON')
    .option('--resume <run_id>', 'Resume a persisted run awaiting approval or restart a failed path with --from')
    .option('--from <node_id>', 'Restart a failed run at a node on its saved path (requires --resume)')
    .option('--use-current-graph', 'Use the installed graph rather than the run snapshot')
    .option('--input <json>', 'JSON object passed to the graph run')
    .action(async (file: string, opts: { dryRun?: boolean; json?: boolean; resume?: string; from?: string; input?: string; useCurrentGraph?: boolean }) => {
      try {
        await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        if (opts.resume && opts.dryRun) throw new Error('--resume cannot be combined with --dry-run');
        if (opts.from && !opts.resume) throw new Error('--from requires --resume');
        let input: Record<string, unknown> | undefined;
        if (opts.input !== undefined) {
          let parsed: unknown;
          try { parsed = JSON.parse(opts.input); }
          catch { throw new Error('--input must be a JSON object'); }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--input must be a JSON object');
          input = parsed as Record<string, unknown>;
        }
        const state = await runGraph(file, { ...(opts.resume ? { resumeRunId: opts.resume } : { dryRun: opts.dryRun }), ...(opts.from ? { fromNodeId: opts.from } : {}), useCurrentGraph: opts.useCurrentGraph, ...(input === undefined ? {} : { input }) });
        if (opts.json) await writeStdoutJson(JSON.stringify(state) + '\n');
        else console.log(`${state.graphId} ${state.runId}: ${state.status} (${state.path.join(' → ')}, executed: ${state.executed})${state.pending ? ` — ${state.pending.message}` : ''}`);
        if (state.status !== 'done' && state.status !== 'awaiting-approval') process.exitCode = 1;
      } catch (error) {
        console.error(`graph run: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  graph.command('tick <file>')
    .description('Advance one graph run, resuming a pending decision or starting only when requested')
    .option('--start', 'Start a new run when the graph is idle')
    .option('--input <json>', 'JSON object passed to a newly started run')
    .option('--json', 'Print the tick result as JSON')
    .action(async (file: string, opts: { start?: boolean; input?: string; json?: boolean }) => {
      try {
        if (opts.input !== undefined && !opts.start) throw new Error('--input requires --start');
        let input: Record<string, unknown> | undefined;
        if (opts.input !== undefined) {
          let parsed: unknown;
          try { parsed = JSON.parse(opts.input); }
          catch { throw new Error('--input must be a JSON object'); }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--input must be a JSON object');
          input = parsed as Record<string, unknown>;
        }
        await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        const { graphTick } = await import('./graph-tick.js');
        const result = await graphTick(file, { startIfIdle: opts.start, ...(input === undefined ? {} : { input }),
          deps: { notify: async () => { const { notifyGraphEvents } = await import('./graph-notify.js'); await notifyGraphEvents(); } } });
        if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
        else console.log(`graph tick: ${result.action}${result.runId ? ` ${result.runId}: ${result.status}` : ''}`);
        if (result.status === 'failed') process.exitCode = 1;
      } catch (error) {
        console.error(`graph tick: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  graph.command('notify')
    .description('Deliver graph run events not yet recorded in the notification ledger')
    .option('--dry-run', 'Preview notifications without sending or recording them')
    .action(async (opts: { dryRun?: boolean }) => {
      try {
        if (!opts.dryRun) await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        const { notifyGraphEvents } = await import('./graph-notify.js');
        const events = await notifyGraphEvents({ dryRun: opts.dryRun });
        if (opts.dryRun) for (const event of events) console.log(`${event.id} ${event.message}`);
        console.log(`${opts.dryRun ? 'pending' : 'sent'} graph notifications: ${events.length}`);
      } catch (error) {
        console.error(`graph notify: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  graph.command('approve <graph_id> <run_id>')
    .option('--reject', 'Reject instead of approving')
    .option('--by <name>', 'Record the approver name')
    .action((graphId: string, runId: string, opts: { reject?: boolean; by?: string }) => {
      try {
        const state = decideGraphApproval(graphId, runId, opts.reject ? 'rejected' : 'approved', opts.by);
        console.log(`${state.graphId} ${state.runId}: ${state.pending?.decision}`);
      } catch (error) {
        console.error(`graph approve: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  const runs = graph.command('runs').description('List and inspect persisted graph runs');
  const alive = (state: GraphRunState) => graphRunAlive(state, runsDeps.processStartMs);
  const row = (state: GraphRunState) => ({
    runId: state.runId, graphId: state.graphId, status: state.status,
    lastNode: state.path.at(-1) ?? null, startedAt: state.startedAt ?? null,
    finishedAt: state.finishedAt ?? null, alive: alive(state),
  });
  const warning = (unreadable: number) => { if (unreadable) console.error(`⚠ 못 읽은 원장 ${unreadable}`); };
  runs.command('list')
    .option('--graph <id>', 'Filter by graph id')
    .option('--state <status>', 'Filter by run status')
    .option('--limit <N>', 'Maximum number of runs')
    .option('--json', 'Print runs as JSON')
    .action(async (opts: { graph?: string; state?: string; limit?: string; json?: boolean }) => {
      try {
        if (opts.limit !== undefined && (!/^[1-9]\d*$/.test(opts.limit) || !Number.isSafeInteger(Number(opts.limit)))) throw new Error('--limit must be a positive integer');
        const { runs: all, unreadable } = listGraphRuns(runsDeps.root);
        const selected = all.filter((state) => (!opts.graph || state.graphId === opts.graph) && (!opts.state || state.status === opts.state))
          .slice(0, opts.limit === undefined ? undefined : Number(opts.limit)).map(row);
        debug.log('graph.runs', 'list', { count: selected.length, unreadable, alive: selected.filter((state) => state.alive === true).length });
        if (opts.json) await writeStdoutJson(JSON.stringify(selected) + '\n');
        else for (const state of selected) console.log(`${state.runId} · ${state.graphId} · ${state.status} · ${state.lastNode ?? '-'} · ${state.startedAt ?? '-'} · ${state.finishedAt ?? '-'} · alive=${state.alive}`);
        warning(unreadable);
      } catch (error) {
        console.error(`graph runs list: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  runs.command('resume <run_id>')
    .option('--from <node_id>', 'Restart at this node on the saved path')
    .option('--use-current-graph', 'Use the installed graph and enforce the original hash')
    .option('--file <path>', 'Graph file for a legacy run without a recorded graph path')
    .option('--json', 'Print run state as JSON')
    .action(async (runId: string, opts: { from?: string; useCurrentGraph?: boolean; file?: string; json?: boolean }) => {
      try {
        await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') throw new Error(`invalid run id: ${runId}`);
        const { runs: all, unreadable } = listGraphRuns(runsDeps.root);
        const exact = all.filter((state) => state.runId === runId);
        const matches = exact.length ? exact : all.filter((state) => state.runId.startsWith(runId));
        if (matches.length !== 1) {
          if (matches.length) console.error(`ambiguous run id: ${runId}\n${matches.map((state) => `${state.graphId}/${state.runId}`).join('\n')}`);
          else console.error(`no run: ${runId}`);
          warning(unreadable);
          process.exitCode = 1;
          return;
        }
        const saved = matches[0]!;
        if (saved.graphSnapshot && opts.file && (!saved.graphPath || resolve(opts.file) !== resolve(saved.graphPath))) {
          throw new Error('--file cannot change the graph path of a snapshot run (이 런은 시작 때 그래프 사본이 있다 — --file 대신 --use-current-graph)');
        }
        const from = opts.from ?? (saved.status === 'failed' ? [...saved.nodes].reverse().find((node) => !node.ok)?.nodeId : undefined);
        const file = saved.graphSnapshot
          ? saved.graphPath
          : opts.file ?? (saved.graphPath && existsSync(saved.graphPath) ? saved.graphPath : undefined) ?? findGraphFile(saved.graphId);
        if (!file) throw new Error(`graph file not found for ${saved.graphId}/${saved.runId}; provide --file`);
        const state = await runGraph(file, { resumeRunId: saved.runId, resumeGraphId: saved.graphId, fromNodeId: from,
          useCurrentGraph: opts.useCurrentGraph, deps: { root: runsDeps.root } });
        if (opts.json) await writeStdoutJson(JSON.stringify(state) + '\n');
        else console.log(`${state.graphId} ${state.runId}: ${state.status} (${state.path.join(' → ')}, executed: ${state.executed})`);
        if (state.status !== 'done' && state.status !== 'awaiting-approval') process.exitCode = 1;
        warning(unreadable);
      } catch (error) {
        console.error(`graph runs resume: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  runs.command('status <run_id>')
    .option('--json', 'Print run detail as JSON')
    .action(async (runId: string, opts: { json?: boolean }) => {
      try {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') throw new Error(`invalid run id: ${runId}`);
        const { runs: all, unreadable } = listGraphRuns(runsDeps.root);
        const exact = all.filter((state) => state.runId === runId);
        const matches = exact.length ? exact : all.filter((state) => state.runId.startsWith(runId));
        debug.log('graph.runs', 'status', { count: matches.length, unreadable, alive: matches.filter((state) => alive(state) === true).length });
        if (matches.length !== 1) {
          if (matches.length) console.error(`ambiguous run id: ${runId}\n${matches.map((state) => `${state.graphId}/${state.runId}`).join('\n')}`);
          else console.error(`no run: ${runId}`);
          warning(unreadable);
          process.exitCode = 1;
          return;
        }
        const state = matches[0]!;
        const detail = { ...row(state), nodes: state.nodes.map((node) => {
          const summary = lastJsonObject(node.output)?.summary;
          return { nodeId: node.nodeId, ok: node.ok, summary: typeof summary === 'string' ? summary.slice(0, 300) : null };
        }), pending: state.pending ?? null, resume: state.resume ?? null };
        if (opts.json) await writeStdoutJson(JSON.stringify(detail) + '\n');
        else {
          console.log(`${detail.runId} · ${detail.graphId} · ${detail.status} · alive=${detail.alive}`);
          for (const node of detail.nodes) console.log(`  ${node.nodeId} · ok=${node.ok} · ${node.summary ?? '-'}`);
          console.log(`pending: ${JSON.stringify(detail.pending)}`);
          console.log(`resume: ${JSON.stringify(detail.resume)}`);
        }
        warning(unreadable);
      } catch (error) {
        console.error(`graph runs status: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  graph.command('status <graph_id>')
    .option('--json', 'Print latest run state as JSON')
    .action(async (graphId: string, opts: { json?: boolean }) => {
      try {
        const state = latestGraphRun(graphId);
        if (opts.json) await writeStdoutJson(JSON.stringify(state) + '\n');
        else console.log(state ? `${state.graphId} ${state.runId}: ${state.status} (${state.path.join(' → ')})${state.pending ? ` — ${state.pending.message}` : ''}` : `no runs: ${graphId}`);
        if (!state) process.exitCode = 1;
      } catch (error) {
        console.error(`graph status: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
