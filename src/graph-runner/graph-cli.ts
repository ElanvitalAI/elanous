import type { Command } from 'commander';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { decideGraphApproval, latestGraphRun, runGraph } from './runner.js';

export function registerGraphCommands(program: Command): void {
  const graph = program.command('graph').description('Run a declared command graph or inspect its latest run');
  graph.command('run <file>')
    .option('--dry-run', 'Walk the success path without executing commands')
    .option('--json', 'Print run state as JSON')
    .option('--resume <run_id>', 'Resume a persisted run awaiting approval')
    .option('--input <json>', 'JSON object passed to the graph run')
    .action(async (file: string, opts: { dryRun?: boolean; json?: boolean; resume?: string; input?: string }) => {
      try {
        await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        if (opts.resume && opts.dryRun) throw new Error('--resume cannot be combined with --dry-run');
        let input: Record<string, unknown> | undefined;
        if (opts.input !== undefined) {
          let parsed: unknown;
          try { parsed = JSON.parse(opts.input); }
          catch { throw new Error('--input must be a JSON object'); }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--input must be a JSON object');
          input = parsed as Record<string, unknown>;
        }
        const state = await runGraph(file, { ...(opts.resume ? { resumeRunId: opts.resume } : { dryRun: opts.dryRun }), ...(input === undefined ? {} : { input }) });
        if (opts.json) await writeStdoutJson(JSON.stringify(state) + '\n');
        else console.log(`${state.graphId} ${state.runId}: ${state.status} (${state.path.join(' → ')}, executed: ${state.executed})${state.pending ? ` — ${state.pending.message}` : ''}`);
        if (state.status !== 'done' && state.status !== 'awaiting-approval') process.exitCode = 1;
      } catch (error) {
        console.error(`graph run: ${error instanceof Error ? error.message : String(error)}`);
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
