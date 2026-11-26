// GOAL-ORCHESTRATION-NL — `eln orchestrate validate | plan | run | source | control | stop | layout | status`.
// plan: goal → spec (LLM, heuristic fallback) → shows the plan → asks → runs (`--yes` skips the question).
// run: inside els → one tab per worker (+ the tile stage view in its own tab), else headless; Ctrl-C closes tabs.
// Each run owns <state>/orchestrations/<runId>/ : spec.yaml · feed.jsonl · control.jsonl · report.json · workers/.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { elsBackend, elnCli, headlessBackend, simBackend } from './backends.js';
import { applyLayout, feedWriter, parseLayoutCommand } from './layout.js';
import { describePlan, planFromGoal, type LlmText, type PlanResult } from './planner.js';
import { elevenLabsTts, goalLanguage, runVoice } from './voice.js';
import { runOrchestration, type ControlCommand, type RunReport, type WorkerBackend } from './runner.js';
import { normalizePattern, parseSpecYaml, specToYaml, type OrchestrationSpec, type WorkerKind } from './spec.js';

/** Runs live under the universe's state root (the isolation resolver; an explicit env — tests, the TUI tool — may name one). */
export const orchestrationsRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env !== process.env && env.ELANOUS_STATE_DIR?.trim() ? env.ELANOUS_STATE_DIR.trim() : elanousStateRoot(), 'orchestrations');
export const runDir = (runId: string, env: NodeJS.ProcessEnv = process.env): string => join(orchestrationsRoot(env), runId);
export const newRunId = (): string => `orch-${new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

/** The model eln is configured with, in-process (no session, no tools). */
export async function defaultLlm(): Promise<LlmText> {
  const { llmQuery } = await import('../cli/llm-cli.js');
  const llm = await import('../llm.js');
  const { getUserConfig } = await import('../user-config.js');
  const { trimToBudget } = await import('../tokens.js');
  return async (text) => (await llmQuery({ text, deps: { getUserConfig, decideProviderForConfig: llm.decideProviderForConfig, getProviderForConfig: llm.getProviderForConfig, streamLLM: llm.streamLLM, trimToBudget } })).reply;
}

/** Plain words → control command («stop» · «add 2 more workers» · «spotlight risk»), undefined when not one. */
export function parseControlText(text: string): ControlCommand | undefined {
  const t = text.trim().toLowerCase();
  if (/^(stop|cancel|abort|halt)\b|멈춰|중지|그만/u.test(t)) return { op: 'stop' };
  const add = /\badd\s+(\d+)\s*(?:more\s+)?(eln|codex|claude)?\s*(?:workers?|agents?|tabs?)?|(\d+)\s*(?:명|개)\s*(?:더|추가)/u.exec(t);
  if (add) { const kind = add[2] as WorkerKind | undefined; return { op: 'add-workers', count: Math.max(1, Number(add[1] ?? add[3])), ...(kind ? { kind } : {}) }; }
  const spot = /^(?:spotlight|focus(?:\s+on)?)\s+(.+)$/u.exec(t);
  if (spot?.[1]) return { op: 'spotlight', target: spot[1].trim() };
  return undefined;
}

export function postControl(runId: string, cmd: ControlCommand, env: NodeJS.ProcessEnv = process.env): void {
  const dir = runDir(runId, env);
  if (!existsSync(dir)) throw new Error(`unknown run ${runId}`);
  appendFileSync(join(dir, 'control.jsonl'), `${JSON.stringify(cmd)}\n`);
}

function controlReader(path: string): () => ControlCommand[] {
  let offset = 0;
  return () => {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    const fresh = text.slice(offset);
    offset = text.length;
    return fresh.split('\n').flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as ControlCommand] : []; } catch { return []; } });
  };
}

export interface RunOptions { readonly headless?: boolean; readonly sim?: number; readonly attach?: boolean; readonly workspace?: string; readonly runId?: string; readonly noLlm?: boolean; readonly log?: (line: string) => void; readonly env?: NodeJS.ProcessEnv }
export interface StartedRun { readonly runId: string; readonly dir: string; readonly feed: string; readonly backend: WorkerBackend['name']; readonly report: Promise<RunReport>; stop(): void }

export const insideEls = (env: NodeJS.ProcessEnv = process.env): boolean => !!(env.ELANOUS_ELS_SOCKET ?? '').trim();

/** Start a run (returns at once; `report` settles at the end). The stage view opens as its own els tab. */
export async function startRun(spec: OrchestrationSpec, o: RunOptions = {}): Promise<StartedRun> {
  const env = o.env ?? process.env;
  const runId = o.runId ?? newRunId();
  const dir = runDir(runId, env);
  mkdirSync(join(dir, 'workers'), { recursive: true });
  writeFileSync(join(dir, 'spec.yaml'), specToYaml(spec));
  const feedPath = join(dir, 'feed.jsonl');
  const feed = feedWriter(feedPath);
  if (spec.layout.grid !== 'auto') applyLayout(feedPath, { grid: spec.layout.grid });
  const workspace = o.workspace ?? spec.layout.workspace ?? `orch-${runId.slice(-4)}`;
  const timeoutSec = spec.limits.timeoutSec;
  const backend: WorkerBackend = o.sim !== undefined ? simBackend({ seed: o.sim, delayMs: 300 })
    : !o.headless && insideEls(env) ? elsBackend({ dir: join(dir, 'workers'), timeoutSec, workspace, env }) : headlessBackend({ dir: join(dir, 'workers'), timeoutSec, env });
  // Inside els the bare els window picks this run up from run.json (backend els + workspace) and switches to the staged
  // tile view of the workspace — the person's own window, with the owner's read of every worker tab. --no-attach opts out.
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId, pid: process.pid, backend: o.attach === false && backend.name === 'els' ? 'els-detached' : backend.name, workspace, startedAt: new Date().toISOString(), goal: spec.goal }, null, 2));
  const control = controlReader(join(dir, 'control.jsonl'));
  const llm = o.noLlm || o.sim !== undefined ? undefined : await defaultLlm().catch(() => undefined);
  // Voice (spec.voice): the mp3 lands next to report.json. The key is resolved inside elevenLabsTts (product sources only);
  // the sim world never calls a real TTS.
  const voice = spec.voice ? async (result: string, signal: AbortSignal) => runVoice(result, join(dir, 'brief.mp3'), o.sim !== undefined ? undefined : await elevenLabsTts(env), signal, { ...(goalLanguage(spec.goal) ? { language: goalLanguage(spec.goal)! } : {}) }) : undefined;
  const report = runOrchestration(spec, { backend, ...(llm ? { llm } : {}), feed: (e) => feed.emit(e), control, ...(o.log ? { log: o.log } : {}), ...(voice ? { voice } : {}) }).then((r) => {
    writeFileSync(join(dir, 'report.json'), JSON.stringify(r, null, 2));
    return r;
  });
  return { runId, dir, feed: feedPath, backend: backend.name, report, stop: () => postControl(runId, { op: 'stop' }, env) };
}

export function formatReport(r: RunReport): string {
  const head = { met: '✓ Goal met', 'not-met': '✗ Goal not met', stopped: '■ Stopped', budget: '$ Budget reached', failed: '✗ Failed' }[r.status];
  return [`${head} — ${r.pattern} · ${r.rounds.length} round(s) · est $${r.costUsd.toFixed(2)}${r.why ? ` · ${r.why}` : ''}`,
    ...r.notes.map((n) => `  note: ${n}`), '', r.result.trim() || '(no result)'].join('\n');
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function runAndReport(spec: OrchestrationSpec, opts: RunOptions & { json?: boolean }): Promise<number> {
  const started = await startRun(spec, { ...opts, log: opts.json ? undefined : (l) => console.log(l) });
  if (!opts.json) console.log(`run ${started.runId} · ${started.backend} · feed ${started.feed}`);
  const onInt = (): void => { console.log('\nStopping — closing worker tabs…'); started.stop(); };
  process.once('SIGINT', onInt);
  const report = await started.report;
  process.off('SIGINT', onInt);
  console.log(opts.json ? JSON.stringify({ runId: started.runId, ...report }) : `\n${formatReport(report)}`);
  return report.status === 'met' ? 0 : report.status === 'stopped' ? 130 : 1;
}

export function registerOrchestrationSpecCommands(program: Command): void {
  const group = program.commands.find((c) => c.name() === 'orchestrate') ?? program.command('orchestrate').description('Goal-driven orchestration: plan a goal into an orchestration/v1 spec, run it across eln/codex/claude workers in els tiles');
  group.command('validate <file>').description('Check an orchestration/v1 YAML spec (pattern, workers, reduce, layout, limits and safety caps)')
    .option('--json', 'JSON output')
    .action((file: string, o: { json?: boolean }) => {
      const r = parseSpecYaml(readFileSync(resolve(file), 'utf8'));
      if (o.json) console.log(JSON.stringify(r));
      else { console.log(r.ok ? `✓ valid ${r.spec!.pattern} spec · ${r.spec!.workers.length} workers` : '✗ invalid spec'); for (const e of r.errors) console.log(`  error: ${e}`); for (const w of r.warnings) console.log(`  warning: ${w}`); }
      process.exitCode = r.ok ? 0 : 1;
    });
  group.command('plan <goal...>').description('Turn a goal into a spec (the model picks the pattern), show it, ask, then run')
    .option('--out <file>', 'write the spec here (default: the run folder)')
    .option('--pattern <pattern>', 'force a pattern: map-reduce | pipeline | panel | supervisor-workers | loop-until')
    .option('--yes', 'run without asking')
    .option('--no-run', 'only write the plan')
    .option('--no-llm', 'rules only (no model call)')
    .option('--headless', 'never open els tabs')
    .option('--sim <seed>', 'sim world (no real workers)')
    .option('--json', 'JSON output')
    .action(async (words: string[], o: { out?: string; pattern?: string; yes?: boolean; run?: boolean; llm?: boolean; headless?: boolean; sim?: string; json?: boolean }) => {
      const goal = words.join(' ');
      const forced = o.pattern ? normalizePattern(o.pattern) : undefined;
      if (o.pattern && !forced) { console.error(`unknown pattern ${o.pattern}`); process.exitCode = 2; return; }
      let plan: PlanResult = await planFromGoal(goal, { ...(forced ? { pattern: forced } : {}), ...(o.llm === false ? {} : { llm: await defaultLlm().catch(() => undefined as unknown as LlmText) }) });
      const out = resolve(o.out ?? join(orchestrationsRoot(), 'plans', `${newRunId()}.yaml`));
      for (;;) {
        mkdirSync(join(out, '..'), { recursive: true });
        writeFileSync(out, specToYaml(plan.spec));
        if (o.json) console.log(JSON.stringify({ file: out, source: plan.source, reason: plan.reason, spec: plan.spec }));
        else console.log(`${describePlan(plan)}\nSpec: ${out}`);
        if (o.run === false) return;
        const answer = o.yes ? 'y' : await ask('Run this plan? [y]es · [n]o · [p] <pattern> to change it · [e]dit the file then y : ');
        const p = /^p(?:attern)?\s+(.+)$/iu.exec(answer);
        if (p) { const np = normalizePattern(p[1]); if (np) { plan = await planFromGoal(goal, { pattern: np }); continue; } console.log(`unknown pattern ${p[1]}`); continue; }
        if (/^e/iu.test(answer)) {
          spawnSync(process.env.EDITOR || 'vi', [out], { stdio: 'inherit' });
          const edited = parseSpecYaml(readFileSync(out, 'utf8'));
          if (!edited.ok) { console.log(`edited spec is invalid:\n  ${edited.errors.join('\n  ')}`); continue; }
          plan = { ...plan, spec: edited.spec!, source: plan.source, reason: 'edited by the user' };
          continue;
        }
        if (!/^y/iu.test(answer)) { console.log(`Not run. Start it later: eln orchestrate run ${out}`); return; }
        process.exitCode = await runAndReport(plan.spec, { ...(o.headless ? { headless: true } : {}), ...(o.sim !== undefined ? { sim: Number(o.sim) } : {}), ...(o.llm === false ? { noLlm: true } : {}), json: o.json });
        return;
      }
    });
  group.command('run <file>').description('Run an orchestration/v1 spec: els tabs when inside els (else headless), stage feed + tile view, success loop')
    .option('--headless', 'never open els tabs').option('--no-attach', 'do not open the tile stage view').option('--ws <name>', 'els workspace')
    .option('--sim <seed>', 'sim world (no real workers)').option('--no-llm', 'no model for reduce/judge').option('--json', 'JSON output')
    .option('--run-id <id>', 'use this run id (the TUI tool picks it so it can steer the run)')
    .action(async (file: string, o: { headless?: boolean; attach?: boolean; ws?: string; sim?: string; llm?: boolean; json?: boolean; runId?: string }) => {
      const r = parseSpecYaml(readFileSync(resolve(file), 'utf8'));
      if (!r.ok) { console.error(`invalid spec:\n  ${r.errors.join('\n  ')}`); process.exitCode = 1; return; }
      process.exitCode = await runAndReport(r.spec!, { ...(o.headless ? { headless: true } : {}), ...(o.attach === false ? { attach: false } : {}), ...(o.ws ? { workspace: o.ws } : {}),
        ...(o.sim !== undefined ? { sim: Number(o.sim) } : {}), ...(o.llm === false ? { noLlm: true } : {}), ...(o.runId && /^orch-[\w-]{1,60}$/u.test(o.runId) ? { runId: o.runId } : {}), json: o.json });
    });
  group.command('source <desk> [query...]').description('Fetch one real data desk (news | x | youtube | market) with keys from eln secret; each item carries its source record. Exit 3 = source unavailable')
    .option('--json', 'print the desk result as JSON')
    .action(async (desk: string, words: string[], o: { json?: boolean }) => {
      const { DESKS, fetchDesk, renderDesk } = await import('./sources.js');
      if (!(DESKS as readonly string[]).includes(desk)) { console.error(`unknown desk ${desk} — use ${DESKS.join(' | ')}`); process.exitCode = 2; return; }
      const r = await fetchDesk(desk as (typeof DESKS)[number], words.join(' ').trim() || 'KOSPI outlook');
      // The worker script reads this file: source records ride from the desk to the reduce and the 출처 section.
      const out = process.env.ORCH_SOURCES_FILE?.trim();
      if (out) writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
      console.log(o.json ? JSON.stringify(r, null, 2) : renderDesk(r));
      process.exitCode = r.status === 'ok' ? 0 : 3;
    });
  group.command('control <runId> <text...>').description('Steer a running orchestration in plain words: stop · add 2 more workers · spotlight <tab> · or a layout phrase')
    .action((runId: string, words: string[]) => {
      const text = words.join(' ');
      const cmd = parseControlText(text);
      if (cmd) { postControl(runId, cmd); console.log(`sent ${cmd.op}`); return; }
      const layout = parseLayoutCommand(text);
      if (layout) { console.log(`layout ${JSON.stringify(applyLayout(join(runDir(runId), 'feed.jsonl'), layout))}`); return; }
      console.error('not understood — try: stop · add 2 more workers · spotlight risk · tile 3x3 · next page · show all spaces'); process.exitCode = 2;
    });
  group.command('stop <runId>').description('Stop a run and close its worker tabs').action((runId: string) => { postControl(runId, { op: 'stop' }); console.log('stop sent'); });
  group.command('layout <runId> <text...>').description('Tile layout in plain words: «tile 3x3» · «zoom risk» · «next page» · «show all spaces»')
    .action((runId: string, words: string[]) => {
      const cmd = parseLayoutCommand(words.join(' '));
      if (!cmd) { console.error('not a layout command'); process.exitCode = 2; return; }
      console.log(JSON.stringify(applyLayout(join(runDir(runId), 'feed.jsonl'), cmd)));
    });
  group.command('status [runId]').description('Runs and their state (report when finished)').action((runId?: string) => {
    const root = orchestrationsRoot();
    const ids = runId ? [runId] : existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('orch-')).sort().slice(-10) : [];
    for (const id of ids) {
      const rp = join(root, id, 'report.json');
      const rep = existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) as RunReport : undefined;
      console.log(`${id} · ${rep ? rep.status : 'running'}${rep ? ` · ${rep.pattern} · ${rep.rounds.length} round(s)` : ''}`);
    }
  });
}

/** Spawn `eln orchestrate run` in the background (the TUI tool returns at once). */
export function spawnDetachedRun(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const cli = elnCli(env);
  // Not detached: the els server proves a tab request by the caller's live process ancestry back to this pane.
  const child = spawn(cli[0]!, [...cli.slice(1), 'orchestrate', 'run', file, ...args], { stdio: 'ignore', env });
  child.unref();
}
