// GOAL-ORCHESTRATION-NL — the model-callable Orchestrate tool (eln TUI · `/orch <goal>`). The person says a goal;
// the model calls plan → shows the plan and asks → run (detached, returns a runId at once) → status while it runs
// (progress in the chat) → control («stop», «add 2 more workers», «spotlight X») and layout («tile 3x3», «zoom risk»,
// «next page», «show all spaces») map onto the run's control file and stage feed, which els applies.
// Authorization: worker tabs open in els only for the OP seat or a person's own eln (no seat env); any other seat
// agent runs headless — the same rule ElsControl's `new` keeps.
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { effectiveStateRoot } from '../instance/resolve.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { elnCli } from './backends.js';
import { defaultLlm, insideEls, newRunId, orchestrationsRoot, parseControlText, postControl, runDir, spawnDetachedRun } from './cli.js';
import { applyLayout, parseLayoutCommand, type LayoutCommand } from './layout.js';
import { describePlan, planFromGoal, type LlmText } from './planner.js';
import type { RunReport } from './runner.js';
import { normalizePattern, parseSpecYaml, specToYaml, TILE_GRIDS } from './spec.js';
import { describeInvestPlan, INVEST_PANEL_PRESET, INVEST_PLAN_SUFFIX, investBoardArgv, parseInvestPanelGoal, readInvestConclusion, type InvestPanelGoal } from './invest-panel.js';

export const ORCHESTRATE_TOOL_NAME = 'Orchestrate';
export const ORCHESTRATE_ACTIONS = ['plan', 'run', 'status', 'control', 'layout', 'tile'] as const;

export function buildOrchestrateTool(): LLMToolSpec {
  return {
    name: ORCHESTRATE_TOOL_NAME,
    description: [
      'Goal-driven multi-agent orchestration across eln/codex/claude workers, shown as live els tiles. Use it when the person states a goal to be done by several agents, or types "/orch <goal>".',
      'Flow: plan(goal) → show the plan text to the person and ask to confirm (they may change the pattern) → run(file) → status(runId) to report progress until done → give the final result.',
      'While running: control(runId, text) for «stop», «add 2 more workers», «spotlight <tab>»; layout(runId, text or grid/page/level/zoom) for the tile view («tile 3x3», «zoom risk», «next page», «show all spaces»).',
      'An investment expert-panel request on a company («삼성전자 2027 전망 전문가 패널로 분석해줘», "/invest <company> [question]") plans as preset invest-panel: run it the same way (plan → confirm → run → status), and when status is done give the person its 최종 결론 text as is.',
      'tile(scope, grid) opens a tile view of all tabs/spaces without a run. Never starts paid VMs; budget and spawn caps are enforced by the runner.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ORCHESTRATE_ACTIONS], description: 'what to do' },
        goal: { type: 'string', description: 'plan: the goal in plain words' },
        pattern: { type: 'string', description: 'plan: force a pattern (map-reduce | pipeline | panel | supervisor-workers | loop-until) — when the person corrects the choice' },
        file: { type: 'string', description: 'run: the spec file plan returned' },
        runId: { type: 'string', description: 'status/control/layout: the run' },
        text: { type: 'string', description: 'control/layout: the person\'s words' },
        grid: { type: 'string', enum: [...TILE_GRIDS], description: 'layout/tile: grid' },
        page: { type: 'string', description: 'layout: next | prev | page number' },
        level: { type: 'string', enum: ['all', 'spaces', 'space'], description: 'layout: all tabs · one tile per space · this space' },
        zoom: { type: 'string', description: 'layout: tab title or worker id to enlarge ("" = back to the grid)' },
        scope: { type: 'string', enum: ['all', 'spaces', 'space'], description: 'tile: what to show' },
      },
      required: ['action'],
    },
  };
}

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
/** May this process open worker tabs in els? OP seat, or a person's own eln (no seat identity). */
export function mayOpenElsTabs(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!insideEls(env)) return false;
  const seat = (env.ELANOUS_TRACK || env.ELANOUS_SEAT || '').trim();
  return !seat || seat === 'OP';
}

export interface OrchestrateToolDeps {
  readonly llm?: LlmText; readonly env?: NodeJS.ProcessEnv; readonly spawnRun?: (file: string, args: string[]) => void;
  /** invest-panel: start the board with this argv (after the eln binary); `inEls` = open it as an els tab. */
  readonly spawnInvest?: (argv: string[], o: { inEls: boolean; logFile: string; env: NodeJS.ProcessEnv }) => void;
}

/** The els server proves a tab request by the caller's process ancestry, so the board is a child of this process
 *  (not detached) — in an els tab when this caller may open tabs, else headless with its screen in a log. */
export function spawnInvestBoard(argv: string[], o: { inEls: boolean; logFile: string; env: NodeJS.ProcessEnv }): void {
  const cli = elnCli(o.env);
  const root = o.env.ELANOUS_STATE_DIR?.trim() || effectiveStateRoot();
  const env = { ...o.env, ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(root, o.env) };
  const args = o.inEls ? [...cli.slice(1), 'side', 'new', '--ws', 'invest-demo', '--title', 'INV·Board', '--', ...cli, ...argv] : [...cli.slice(1), ...argv];
  const out = openSync(o.logFile, 'a');
  const child = spawn(cli[0]!, args, { stdio: ['ignore', out, out], env });
  child.unref();
}

export async function dispatchOrchestrate(args: unknown, deps: OrchestrateToolDeps = {}): Promise<Record<string, unknown>> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const env = deps.env ?? process.env;
  const action = str(a.action);
  try {
    switch (action) {
      case 'plan': {
        const goal = str(a.goal);
        if (!goal) return { ok: false, error: 'goal is required' };
        const invest = str(a.pattern) ? undefined : parseInvestPanelGoal(goal);
        if (invest) {
          const dir = join(orchestrationsRoot(env), 'plans');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${newRunId()}${INVEST_PLAN_SUFFIX}`);
          writeFileSync(file, `${JSON.stringify({ preset: INVEST_PANEL_PRESET, ...invest }, null, 1)}\n`);
          return { ok: true, file, preset: INVEST_PANEL_PRESET, ticker: invest.ticker, source: 'preset', plan: describeInvestPlan(invest),
            next: 'Show the person the plan summary and ask: run it? Then call run with this file.' };
        }
        const forced = str(a.pattern) ? normalizePattern(a.pattern) : undefined;
        if (str(a.pattern) && !forced) return { ok: false, error: `unknown pattern ${String(a.pattern)}` };
        const llm = deps.llm ?? await defaultLlm().catch(() => undefined);
        const plan = await planFromGoal(goal, { ...(forced ? { pattern: forced } : {}), ...(llm ? { llm } : {}) });
        const dir = join(orchestrationsRoot(env), 'plans');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${newRunId()}.yaml`);
        writeFileSync(file, specToYaml(plan.spec));
        return { ok: true, file, pattern: plan.spec.pattern, source: plan.source, plan: describePlan(plan), yaml: specToYaml(plan.spec),
          next: 'Show the person the orchestration/v1 YAML (a yaml code block) and the plan summary, then ask: run it, change the pattern, or edit? Then call run with this file.' };
      }
      case 'run': {
        const file = str(a.file);
        if (!file || !existsSync(file)) return { ok: false, error: 'file (from plan) is required' };
        if (file.endsWith(INVEST_PLAN_SUFFIX)) {
          const goal = JSON.parse(readFileSync(file, 'utf8')) as InvestPanelGoal;
          const runId = newRunId();
          const dir = runDir(runId, env);
          mkdirSync(dir, { recursive: true });
          const pin = join(dir, 'invest-board.pin.json');
          const tabs = mayOpenElsTabs(env);
          const argv = investBoardArgv(goal, pin);
          writeFileSync(join(dir, 'invest.json'), `${JSON.stringify({ preset: INVEST_PANEL_PRESET, goal, pin, argv, startedAt: new Date().toISOString() }, null, 1)}\n`);
          (deps.spawnInvest ?? spawnInvestBoard)(argv, { inEls: tabs, logFile: join(dir, 'board.log'), env });
          return { ok: true, runId, preset: INVEST_PANEL_PRESET, backend: tabs ? 'els' : 'headless',
            next: 'Tell the person the board is running live (about 3–4 minutes), then call status with this runId every 30–60 seconds; when done, give its conclusion text as is.' };
        }
        const checked = parseSpecYaml(readFileSync(file, 'utf8'));
        if (!checked.ok) return { ok: false, error: 'invalid spec', errors: checked.errors };
        const runId = newRunId();
        const tabs = mayOpenElsTabs(env);
        (deps.spawnRun ?? ((f, x) => spawnDetachedRun(f, x, env)))(file, ['--run-id', runId, ...(tabs ? [] : ['--headless'])]);
        return { ok: true, runId, backend: tabs ? 'els' : 'headless', ...(insideEls(env) && !tabs ? { note: 'this seat may not open els tabs; workers run headless' } : {}),
          next: 'Report that the run started, then call status with this runId every so often and tell the person the progress.' };
      }
      case 'status': {
        const runId = str(a.runId);
        if (!runId) return { ok: false, error: 'runId is required' };
        const dir = runDir(runId, env);
        const investMeta = join(dir, 'invest.json');
        if (existsSync(investMeta)) {
          const m = JSON.parse(readFileSync(investMeta, 'utf8')) as { pin: string; startedAt: string };
          const c = readInvestConclusion(m.pin);
          if (c) return { ok: true, done: true, preset: INVEST_PANEL_PRESET, status: c.status, conclusion: c.text };
          return { ok: true, done: false, preset: INVEST_PANEL_PRESET, phase: 'running', elapsedSec: Math.round((Date.now() - Date.parse(m.startedAt)) / 1000) };
        }
        const reportPath = join(dir, 'report.json');
        if (existsSync(reportPath)) {
          const r = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
          return { ok: true, done: true, status: r.status, rounds: r.rounds.length, why: r.why, notes: r.notes, costUsd: r.costUsd, result: r.result.slice(0, 4_000) };
        }
        const feedPath = join(dir, 'feed.jsonl');
        if (!existsSync(feedPath)) return { ok: existsSync(dir), done: false, phase: 'starting' };
        // The runner may be mid-write: the newest COMPLETE line wins.
        let f: { phase?: string; counters?: unknown; votes?: unknown; spotlightCaption?: string } = {};
        for (const line of readFileSync(feedPath, 'utf8').trim().split('\n').reverse()) { try { f = JSON.parse(line) as typeof f; break; } catch { /* partial */ } }
        return { ok: true, done: false, phase: f.phase, counters: f.counters, workers: f.votes, caption: f.spotlightCaption };
      }
      case 'control': {
        const runId = str(a.runId); const text = str(a.text);
        if (!runId || !text) return { ok: false, error: 'runId and text are required' };
        const cmd = parseControlText(text);
        if (cmd) { postControl(runId, cmd, env); return { ok: true, sent: cmd }; }
        const layout = parseLayoutCommand(text);
        if (layout) return { ok: true, layout: applyLayout(join(runDir(runId, env), 'feed.jsonl'), layout) };
        return { ok: false, error: 'not understood — stop · add N more workers · spotlight <tab> · or a layout phrase' };
      }
      case 'layout': {
        const runId = str(a.runId);
        if (!runId) return { ok: false, error: 'runId is required' };
        const page = str(a.page);
        const cmd: LayoutCommand = str(a.text) ? parseLayoutCommand(String(a.text)) ?? {} : {
          ...(str(a.grid) ? { grid: a.grid as LayoutCommand['grid'] } : {}),
          ...(page ? { page: page === 'next' || page === 'prev' ? page : Math.max(0, Number(page) - 1) } : {}),
          ...(str(a.level) ? { level: a.level as LayoutCommand['level'] } : {}),
          ...(typeof a.zoom === 'string' ? { zoom: a.zoom } : {}),
        };
        if (Object.keys(cmd).length === 0) return { ok: false, error: 'no layout change given' };
        return { ok: true, layout: applyLayout(join(runDir(runId, env), 'feed.jsonl'), cmd) };
      }
      case 'tile': {
        if (!mayOpenElsTabs(env)) return { ok: false, error: 'tile view needs els and the OP seat or a person\'s own eln' };
        const scope = str(a.scope) ?? 'all';
        const cli = elnCli(env);
        const r = spawnSync(cli[0]!, [...cli.slice(1), 'side', 'new', '--title', `TILE·${scope}`, '--raw', '--', ...cli, 'side', 'tile', ...(scope === 'all' ? ['--all'] : scope === 'spaces' ? ['--spaces'] : []),
          ...(str(a.grid) ? ['--grid', String(a.grid)] : [])], { encoding: 'utf8', env, timeout: 20_000 });
        return { ok: r.status === 0, ...(r.status === 0 ? {} : { error: (r.stderr || r.stdout || '').trim().slice(0, 200) }) };
      }
      default:
        return { ok: false, error: `unknown action ${JSON.stringify(a.action)} — ${ORCHESTRATE_ACTIONS.join(' · ')}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
