import type { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { writeStdoutJson } from '../cli/stdout-json.js';
import type { GraphVariantPlan } from '../self-implement/graph-variant.js';
import { debug } from '../debug/log.js';
import { decideGraphApproval, graphRunAlive, lastJsonObject, latestGraphRun, listGraphRuns, manageGraphRun, runGraph, type GraphRunState } from './runner.js';

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
  graph.command('variant <template>')
    .description('Validate and run a graph variant, preserving the resulting graph beside its run ledger')
    .requiredOption('--plan <json>', 'JSON variant plan (maxVisits, routes, or growth)')
    .option('--dry-run', 'Walk the variant without executing commands')
    .option('--run', 'Execute the validated variant')
    .option('--json', 'Print run state as JSON')
    .action(async (file: string, opts: { plan: string; dryRun?: boolean; run?: boolean; json?: boolean }) => {
      try {
        if (opts.dryRun === opts.run) throw new Error('choose exactly one of --dry-run or --run');
        let plan: unknown;
        try { plan = JSON.parse(opts.plan); } catch { throw new Error('--plan must be a JSON object'); }
        if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
          Object.keys(plan).some(key => !['maxVisits', 'routes', 'growth'].includes(key)) ||
          (plan as Record<string, unknown>).maxVisits !== undefined &&
            (typeof (plan as Record<string, unknown>).maxVisits !== 'object' || (plan as Record<string, unknown>).maxVisits === null || Array.isArray((plan as Record<string, unknown>).maxVisits)) ||
          (plan as Record<string, unknown>).routes !== undefined && (!Array.isArray((plan as Record<string, unknown>).routes) ||
            !(plan as { routes: unknown[] }).routes.every(route => route !== null && typeof route === 'object' && !Array.isArray(route) &&
              typeof (route as Record<string, unknown>).from === 'string' && typeof (route as Record<string, unknown>).to === 'string' &&
              typeof (route as Record<string, unknown>).outcome === 'string')) ||
          (plan as Record<string, unknown>).growth !== undefined &&
            (!(plan as Record<string, unknown>).growth || typeof (plan as Record<string, unknown>).growth !== 'object' ||
              Array.isArray((plan as Record<string, unknown>).growth) ||
              !(plan as { growth: Record<string, unknown> }).growth.node ||
              typeof (plan as { growth: Record<string, unknown> }).growth.from !== 'string' ||
              typeof (plan as { growth: Record<string, unknown> }).growth.outcome !== 'string')) {
          throw new Error('--plan must be a JSON variant plan');
        }
        await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        const state = await runGraph(file, { dryRun: opts.dryRun, variant: { goal: 'g_graph_variant', plan: plan as GraphVariantPlan }, deps: { root: runsDeps.root } });
        if (opts.json) await writeStdoutJson(JSON.stringify(state) + '\n');
        else console.log(`${state.graphId} ${state.runId}: ${state.status} (${state.path.join(' → ')}, executed: ${state.executed})`);
        if (state.status !== 'done' && state.status !== 'awaiting-approval') process.exitCode = 1;
      } catch (error) {
        console.error(`graph variant: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  graph.command('wizard <prompt>')
    .description('말 한 줄로 그래프 YAML 을 짓고 같은 검증기 ⊕ graph run --dry-run 으로 확인한다(저장하지 않는다) — --from 이면 그 그래프를 고친다')
    .option('--kind <kind>', 'harness | workflow', 'harness')
    .option('--from <file>', '고칠 그래프 YAML (편집 경로)')
    .option('--out <file>', 'YAML 을 이 파일에 쓰고, 하니스면 같은 폴더에 recipes.yaml 도 쓴다(있으면 덮지 않는다)')
    .option('--json', '결과를 JSON 으로')
    .option('--run', '생성된 그래프의 dry-run 경로를 보여 준다(--dry-run 과 함께만)')
    .option('--dry-run', '--run 과 함께: 명령을 실행하지 않고 경로만 걷는다')
    .action(async (prompt: string, opts: { kind: string; from?: string; out?: string; json?: boolean; run?: boolean; dryRun?: boolean }) => {
      try {
        if (opts.kind !== 'harness' && opts.kind !== 'workflow') throw new Error('--kind must be harness or workflow');
        if (opts.run && !opts.dryRun) throw new Error('--run is only supported with --dry-run (run the saved graph with `elanous graph run <file>`)');
        if (opts.run && opts.kind !== 'harness') throw new Error('--run --dry-run walks harness graphs only');
        await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
        const { generateGraphFromPrompt } = await import('../graph-wizard/generate.js');
        const currentYaml = opts.from ? readFileSync(opts.from, 'utf8') : undefined;
        const started = Date.now();
        const result = await generateGraphFromPrompt({ prompt, kind: opts.kind, ...(currentYaml ? { currentYaml } : {}) });
        const ms = Date.now() - started;
        let recipesNote: string | undefined;
        if (opts.out) {
          const { writeFileSync } = await import('node:fs');
          const { dirname } = await import('node:path');
          writeFileSync(opts.out, result.yaml);
          if (result.recipes) {
            const recipesPath = join(dirname(resolve(opts.out)), 'recipes.yaml');
            if (existsSync(recipesPath) && readFileSync(recipesPath, 'utf8') !== result.recipes) recipesNote = `recipes.yaml 이 이미 있어 덮지 않았다: ${recipesPath}`;
            else { writeFileSync(recipesPath, result.recipes); recipesNote = `recipes ${recipesPath}`; }
          }
        }
        if (opts.json) {
          await writeStdoutJson(JSON.stringify({ ...result, ms, ...(recipesNote ? { recipesNote } : {}) }) + '\n');
        } else {
          if (!opts.out) process.stdout.write(result.yaml);
          console.log(`# ${result.ok ? 'ok' : 'invalid'} · id ${result.id} · base ${result.base ?? '-'} · attempts ${result.attempts} · ${(ms / 1000).toFixed(1)}s${opts.out ? ` · saved ${opts.out}` : ''}`);
          console.log(`# ${result.summary}`);
          if (recipesNote) console.log(`# ${recipesNote}`);
          for (const issue of result.issues) console.log(`# issue: ${issue}`);
          if (result.dryRun && (opts.run || !result.ok)) console.log(`# dry-run ${result.dryRun.status}: ${result.dryRun.path.join(' → ')}`);
        }
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        console.error(`graph wizard: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  graph.command('step <step>')
    .description('그래프 마법사 단계 하나를 실행한다(graph run 의 cmd 노드가 부른다 · 마지막 줄 JSON {outcome})')
    .option('--arg <text>', '단계 인자')
    .option('--retries <n>', '실패하면 이 횟수만큼 다시 시도', '0')
    .action(async (step: string, opts: { arg?: string; retries: string }) => {
      const { runWizardStepWithRetries } = await import('../graph-wizard/steps.js');
      const result = runWizardStepWithRetries(step, opts.arg, Number.parseInt(opts.retries, 10) || 0);
      if (result.error) console.error(result.error);
      console.log(JSON.stringify({ outcome: result.outcome, tries: result.tries, ...(result.text ? { text: result.text.slice(0, 20_000) } : {}), ...(result.error ? { error: result.error } : {}) }));
      if (result.outcome === 'fail') process.exitCode = 1;
    });
  graph.command('tick <file>')
    .description('Advance one graph run, resuming a pending decision or starting only when requested')
    .option('--start', 'Start a new run when the graph is idle')
    .option('--schedule', 'Subscribe graph YAML triggers.schedule to the workflow scheduler and tick on each fire')
    .option('--input <json>', 'JSON object passed to a newly started run')
    .option('--json', 'Print the tick result as JSON')
    .action(async (file: string, opts: { start?: boolean; schedule?: boolean; input?: string; json?: boolean }) => {
      try {
        if (opts.schedule && (opts.start || opts.input !== undefined || opts.json)) throw new Error('--schedule cannot be combined with --start, --input or --json');
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
        if (opts.schedule) {
          const { createScheduleSource } = await import('../workflow-runtime/triggers/schedule-source.js');
          const graphFile = resolve(file);
          const source = createScheduleSource();
          // The CLI tick callback is the graph counterpart of the workflow scheduler's onEmit.
          const onScheduledTick = async () => {
            try {
              const { notifyGraphEvents } = await import('./graph-notify.js');
              const result = await graphTick(graphFile, { startIfIdle: true, deps: { notify: async () => { await notifyGraphEvents(); } } });
              if (result.status === 'refused') console.error(`graph tick: refused: ${result.reason}`);
              else if (result.status === 'failed') console.error(`graph tick: ${result.runId}: failed`);
            } catch (error) {
              debug.log('graph.runner', 'schedule-tick-failed', { file: graphFile, error: error instanceof Error ? error.message : String(error) });
              console.error(`graph tick: ${error instanceof Error ? error.message : String(error)}`);
            }
          };
          source.subscribeGraph(graphFile, onScheduledTick);
          if (!source.subscriptions().length) throw new Error('graph triggers.schedule is missing');
          await source.start();
          if (source.handle()?.skipped.length) {
            const reasons = source.handle()!.skipped.map(item => item.reason).join('; ');
            await source.stop();
            throw new Error(`graph schedule skipped: ${reasons}`);
          }
          console.log(`graph schedule: ${source.subscriptions().length} active`);
          const shutdown = () => { void source.stop().then(() => { process.exitCode = 0; }); };
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
          return;
        }
        const result = await graphTick(file, { startIfIdle: opts.start, ...(input === undefined ? {} : { input }),
          deps: { notify: async () => { const { notifyGraphEvents } = await import('./graph-notify.js'); await notifyGraphEvents(); } } });
        if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
        else console.log(`graph tick: ${result.action}${result.runId ? ` ${result.runId}: ${result.status}` : ''}`);
        if (result.status === 'failed' || result.status === 'refused') process.exitCode = 1;
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
  for (const action of ['stop', 'destroy'] as const) {
    runs.command(`${action} <run_id>`)
      .description(action === 'stop' ? 'Fail a running or orphaned run so it can be resumed' : 'Stop and delete a run and its owned artifacts')
      .action(async (runId: string) => {
        try {
          // Without the sink the stop/destroy observation lines never reach the log store (only `graph run` had it).
          await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('graph');
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') throw new Error(`invalid run id: ${runId}`);
          const { runs: all, unreadable } = listGraphRuns(runsDeps.root);
          const exact = all.filter(state => state.runId === runId);
          const matches = exact.length ? exact : all.filter(state => state.runId.startsWith(runId));
          if (matches.length !== 1) throw new Error(matches.length ? `ambiguous run id: ${runId}\n${matches.map(state => `${state.graphId}/${state.runId}`).join('\n')}` : `no run: ${runId}`);
          const saved = matches[0]!;
          const state = manageGraphRun(saved.graphId, saved.runId, action, runsDeps.root, runsDeps.processStartMs);
          console.log(`${state.graphId} ${state.runId}: ${action === 'stop' ? state.status : 'destroyed'}`);
          warning(unreadable);
        } catch (error) {
          console.error(`graph runs ${action}: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      });
  }
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
