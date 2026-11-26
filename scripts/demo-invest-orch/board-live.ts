// DEMO-1126-INVEST-ORCH — the Invest Research Board's live feed: runs graphs/demo/invest-orch in this process and turns
// the runner's node events (parent-addressed, parent-run-sources.ts), the panelists' progress notes, the cited items of
// the data nodes and the run's dashboard.json into BoardEvents (src/tui/widgets/scenes/invest-board.ts). The board is
// redrawn on every event and once a second for the clock. `record` writes the events as a pin that `--replay` plays
// back deterministically. Observation only: a viewer failure never changes the run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { InProcessHandler } from '../../src/graph-runner/in-process-registry.js';
import { drawInvestBoard } from '../../src/tui/widgets/scenes/invest-board-view.js';
import { type BoardMarket, boardResultFromDashboard, displayTicker, reduceInvestBoard, renderInvestBoard, tickerName, type BoardDashboard, type BoardEvent, type BoardMeta } from '../../src/tui/widgets/scenes/invest-board.js';
import type { InvestBoardPin } from '../../src/tui/widgets/scenes/invest-board-pin.js';

export interface LiveBoardOptions {
  readonly ticker: string;
  readonly question: string;
  /** Recorded data, simulated panes — no network, no model (rehearsal). */
  readonly dryRun?: boolean;
  readonly simDelayMs?: number;
  readonly record?: string;
  /** Open one els tab per child (data lanes as live log tabs, every panelist as its own CLI tab) in workspace «invest-demo». */
  readonly els?: boolean;
  /** Close the child tabs when the run ends (default: keep them). */
  readonly closeTabs?: boolean;
  /** Every board event as it happens (the conductor turns them into the els stage feed). */
  readonly onEvent?: (e: BoardEvent) => void;
  readonly write: (text: string) => void;
  readonly size: () => { columns: number; rows: number };
}

export async function runInvestBoardLive(opts: LiveBoardOptions): Promise<{ status: string; pin: InvestBoardPin }> {
  const { runGraph, onGraphNodeLifecycle, onGraphNodeProgress, onGraphRunIdleWake } = await import('../../src/graph-runner/runner.js');
  const { createInvestDemoHandlers, GRAPH_DIR } = await import('./handlers.js');
  const { graphBindings, parsePanelNote } = await import('./scene-feed.js');
  const { parentRunSources } = await import('./parent-run-sources.js');
  const graphPath = join(GRAPH_DIR, 'invest-orch.yaml');
  const bindings = graphBindings(graphPath);
  const { loadPanel, parseMentorPack, MENTOR_PACK_PATH } = await import('./handlers.js');
  // Named experts (the camp mentor pack, names only on screen) and the sector panel's covered weight.
  const experts: Record<string, string> = {};
  try { parseMentorPack(readFileSync(opts.dryRun ? join(GRAPH_DIR, 'fixtures', 'mentor-pack.fixture.md') : MENTOR_PACK_PATH, 'utf8')).forEach((m) => { experts[`mentor-${m.slot}`] = EXPERT_EN[m.name.split(' ')[0] ?? ''] ?? m.name.replace(/\s*\(.*$/u, ''); }); } catch { /* names unknown → Mentor n */ }
  let panelInfo: BoardMeta['panel'];
  try {
    const all = (JSON.parse(readFileSync(join(homedir(), '.claude/skills/attractiveness-panel/panels/semis.json'), 'utf8')) as { panel: Array<{ id: string; consensus_weight: number }> }).panel;
    const shown = new Set(loadPanel().personas.map((p) => p.id));
    panelInfo = { shown: shown.size, total: all.length, weight: Math.round(all.filter((p) => shown.has(p.id)).reduce((a, p) => a + p.consensus_weight, 0) * 100) / 100 };
  } catch { /* no skill file → counts only */ }
  const meta: BoardMeta = {
    ticker: displayTicker(opts.ticker), name: tickerName(opts.ticker), question: opts.question, mode: 'live', experts, startedAt: new Date().toISOString(), ...(panelInfo ? { panel: panelInfo } : {}),
    nodes: [...bindings.entries()].filter(([id]) => !['gather', 'panel-join', 'done', 'failed'].includes(id)).map(([id, b]) => ({ id, ...b })),
  };
  const t0 = Date.now();
  const events: BoardEvent[] = [];
  const at = () => Date.now() - t0;
  let dirty = true;
  let tapEvents: ((e: BoardEvent) => void) | undefined;
  let stopTabs: (() => Promise<void>) | undefined;
  const push = (e: BoardEvent) => { events.push(e); dirty = true; try { tapEvents?.(e); opts.onEvent?.(e); } catch { /* viewer only */ } };
  const draw = () => {
    const { columns, rows } = opts.size();
    const lines = drawInvestBoard(reduceInvestBoard(meta, events, at()), columns, rows).ansi();
    opts.write(`\x1b[H\x1b[2J${lines.join('\n')}`);
    dirty = false;
  };
  let ticks = 0;
  const timer = setInterval(() => { if (dirty || ++ticks % 4 === 0) { try { draw(); } catch { /* viewer only */ } } }, 250);
  const sources = parentRunSources('invest-orch-demo', 'plan', { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake });
  const offL = sources.onLifecycle((e) => {
    if (e.dryRun || e.phase !== 'start' && e.phase !== 'end') return;
    push({ t: at(), kind: 'node', id: e.nodeId, phase: e.phase, ...(e.phase === 'end' ? { outcome: e.outcome === 'fail' ? 'fail' : 'ok' } : {}) });
  });
  const offP = sources.onProgress((n) => {
    if (n.dryRun) return;
    const p = parsePanelNote(n.progress.note ?? '');
    if (p.runtime || p.model || p.verdict) push({ t: at(), kind: 'note', id: n.nodeId, ...p });
  });
  // Tap every data node: its tool calls (tool · count · start/end · ok) and its cited items (title · url) — the evidence.
  const handlers: Record<string, InProcessHandler> = { ...createInvestDemoHandlers() };
  for (const id of Object.keys(DATA_TOOLS)) {
    const inner = handlers[id];
    if (!inner) continue;
    handlers[id] = async (ctx) => {
      const startT = at();
      const r = await inner(ctx);
      try {
        const res = (r as { result?: DataResult }).result ?? {};
        for (const c of dataCalls(id, res, startT, at())) push({ t: at(), kind: 'call', id, ...c });
        const items = (res.items ?? []).filter((i) => i.url && i.title).slice(0, 6);
        for (const i of items) push({ t: at(), kind: 'evidence', source: id, title: String(i.title).slice(0, 120), url: String(i.url) });
        const m = marketOf(id, res as Record<string, unknown>);
        if (m) push({ t: at(), kind: 'market', market: m });
      } catch { /* viewer only */ }
      return r;
    };
  }
  const lanes = opts.els ? await openLaneTabs() : undefined;
  if (lanes) {
    const lane = (id: string) => LANE_OF[id];
    const offTab = sources.onLifecycle((e) => {
      const l = lane(e.nodeId);
      if (!l || e.dryRun) return;
      lanes.log(l, e.phase === 'start' ? `▶ ${e.nodeId} started` : e.phase === 'end' ? `${e.outcome === 'fail' ? '✗' : '✓'} ${e.nodeId} ${e.outcome === 'fail' ? 'failed' : 'done'}` : '');
    });
    const offEv = (ev: BoardEvent) => {
      if (ev.kind === 'call') { const l = lane(ev.id); if (l) lanes.log(l, `  ${ev.tool} ×${ev.n} · ${ev.items} items · ${((ev.endT - ev.startT) / 1000).toFixed(1)}s · ${ev.live ? 'live' : 'recorded'}`); }
      if (ev.kind === 'evidence') { const l = lane(ev.source); if (l) lanes.log(l, `  ↳ ${ev.title.slice(0, 90)}  ${ev.url}`); }
      if (ev.kind === 'market') { const m = ev.market; lanes.log('price', `  ${m.kospi ? `KOSPI ${Math.round(m.kospi.last)} ` : ''}${m.usdkrw ? `USD/KRW ${Math.round(m.usdkrw.last)} ` : ''}${m.foreign20dMillion !== undefined ? `foreign 20d ${(m.foreign20dMillion / 1e6).toFixed(1)}T ` : ''}${m.framework ? `score ${m.framework.total} ${m.framework.signal}` : ''}`); }
    };
    tapEvents = offEv;
    stopTabs = async () => { offTab(); await lanes.close(Boolean(opts.closeTabs)); };
    for (const [id, title] of Object.entries(lanes.titles)) push({ t: at(), kind: 'tab', id, title });
  }
  push({ t: at(), kind: 'run', phase: 'start' });
  // The graph asks in Korean (its prompts and the Conatus cache key); the board shows the English question.
  const { DEFAULT_QUESTION } = await import('./handlers.js');
  const input = { ...(opts.els ? { els: true, elsWorkspace: 'invest-demo' } : {}), question: DEFAULT_QUESTION, ticker: opts.ticker.replace(/\.KS$/u, '.KO'), fixtures: Boolean(opts.dryRun), ...(opts.simDelayMs !== undefined ? { simDelayMs: opts.simDelayMs } : {}) };
  let status = 'failed';
  try {
    const state = await runGraph(graphPath, { input, quiet: true, deps: { inProcessHandlers: handlers } });
    status = state.status === 'done' ? 'done' : 'failed';
    const report = state.nodes.find((n) => n.nodeId === 'report');
    try {
      const out = JSON.parse(String(report?.output)) as { result?: { dashboard?: string } };
      if (out.result?.dashboard) push({ t: at(), kind: 'result', result: boardResultFromDashboard(JSON.parse(readFileSync(out.result.dashboard, 'utf8')) as BoardDashboard, experts) });
    } catch { /* no report → no card */ }
  } finally {
    offL(); offP();
    await stopTabs?.().catch(() => undefined);
    push({ t: at(), kind: 'run', phase: 'end', status: status === 'done' ? 'done' : 'failed' });
    clearInterval(timer);
    try { draw(); } catch { /* viewer only */ }
    opts.write('\n');
  }
  const pin: InvestBoardPin = { schema: 'invest-board.pin/1', recordedAt: new Date().toISOString(), meta: { ...meta, mode: 'replay' }, events };
  if (opts.record) writeFileSync(opts.record, `${JSON.stringify(pin, null, 1)}\n`);
  return { status, pin };
}

interface DataResult { source?: string; items?: Array<{ title?: string; url?: string }>; queries?: unknown[]; series?: Record<string, unknown>; calls?: Array<{ tool: string; n: number; ok?: boolean; items?: number }> }
/** The skill each data node calls (scripts/demo-invest-orch/handlers.ts). */
export const DATA_TOOLS: Readonly<Record<string, string>> = {
  news: 'omni-crawl', 'event-shock': 'omni-crawl', 'x-pulse': 'apify tweet-scraper', 'conatus-research': 'Conatus research', 'conatus-ops': 'Conatus ops',
  market: 'omni-market EOD', flows: 'kr-flow', score: 'asset-attractiveness',
};
/** One call record per tool: from the handler's own `calls` when it reports them, else counted from the result's shape. */
export function dataCalls(id: string, res: DataResult, startT: number, endT: number): Array<{ tool: string; n: number; ok: boolean; items: number; startT: number; endT: number; live: boolean }> {
  const live = String(res.source ?? '').startsWith('live');
  if (res.calls?.length) return res.calls.map((c) => ({ tool: c.tool, n: c.n, ok: c.ok !== false, items: c.items ?? 0, startT, endT, live }));
  const n = id === 'event-shock' ? (res.queries?.length ?? 1) : id === 'market' ? Object.keys(res.series ?? {}).length || 1 : 1;
  return [{ tool: DATA_TOOLS[id] ?? id, n: live ? n : 0, ok: true, items: (res.items ?? []).length, startT, endT, live }];
}

/** Romanized names of the camp mentors (the pack is Korean; product text is English). */
const EXPERT_EN: Readonly<Record<string, string>> = { '빈센트': 'Vincent', '박병창': 'Park Byung-chang', '장우진': 'Jang Woo-jin (per CEO) · Risk' };

/** The board's market box from the market · flows · score results (their real fields; absent → nothing). */
export function marketOf(id: string, res: Record<string, unknown>): BoardMarket | undefined {
  type Series = { last?: number; chg1m?: number; chg3m?: number };
  if (id === 'market') {
    const s = (res.series ?? {}) as Record<string, Series>;
    const pick = (k: string) => (typeof s[k]?.last === 'number' ? s[k] : undefined);
    const k = pick('KOSPI'), u = pick('USDKRW'), t = pick('US10Y');
    return { ...(k ? { kospi: { last: k.last!, ...(k.chg1m !== undefined ? { chg1m: k.chg1m } : {}), ...(k.chg3m !== undefined ? { chg3m: k.chg3m } : {}) } } : {}),
      ...(u ? { usdkrw: { last: u.last!, ...(u.chg1m !== undefined ? { chg1m: u.chg1m } : {}) } } : {}), ...(t ? { us10y: { last: t.last! } } : {}) };
  }
  if (id === 'flows') {
    const k = (res.kospi ?? {}) as { foreign20dMillion?: number; days?: Array<{ date: string; foreign: number }> };
    const days = [...(k.days ?? [])].sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.foreign);
    return { ...(days.length ? { foreignDaily: days } : {}), ...(typeof k.foreign20dMillion === 'number' ? { foreign20dMillion: k.foreign20dMillion } : {}) };
  }
  if (id === 'score' && typeof res.total === 'number') return { framework: { total: res.total, signal: String(res.signal ?? '?') } };
  return undefined;
}

/** Which tab a data node's lines go to. */
const LANE_OF: Readonly<Record<string, string>> = { news: 'news', 'event-shock': 'news', 'x-pulse': 'x', 'conatus-research': 'dart', 'conatus-ops': 'dart', score: 'dart', market: 'price', flows: 'price' };
const LANE_TITLE: Readonly<Record<string, string>> = { news: 'INV·News · omni-crawl', x: 'INV·X · apify + grok-x', dart: 'INV·DART · Conatus', price: 'INV·Price · EOD + flows' };

/** One els tab per data lane: each tails that lane's live log (calls · items · cited URLs). */
async function openLaneTabs(): Promise<{ titles: Record<string, string>; log(lane: string, line: string): void; close(closeTabs: boolean): Promise<void> }> {
  const { investElsTarget, investElsEnv } = await import('./handlers.js');
  const { appendFileSync, mkdirSync, writeFileSync: wf } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const target = investElsTarget(process.env);
  const dir = join(target.stateRoot, 'invest-demo', `lanes-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const cli = process.env.INVEST_DEMO_ELN ? [process.env.INVEST_DEMO_ELN] : [process.execPath, join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs')];
  const env = investElsEnv(process.env, target);
  const panes: string[] = [];
  const titles: Record<string, string> = {};
  for (const [lane, title] of Object.entries(LANE_TITLE)) {
    const file = join(dir, `${lane}.log`);
    wf(file, `${title}\n${'─'.repeat(60)}\n`);
    const r = spawnSync(cli[0]!, [...cli.slice(1), 'side', 'new', '--ws', 'invest-demo', '--title', title, '--cwd', dir, '--', 'tail', '-n', '+1', '-F', file], { env, encoding: 'utf8', timeout: 15_000 });
    try { const a = JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '{}') as { pane?: string }; if (a.pane) panes.push(a.pane); } catch { /* tab not opened — the lane still logs */ }
    titles[lane] = title;
  }
  const stamp = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 19);
  return {
    titles,
    log(lane, line) { if (line) try { appendFileSync(join(dir, `${lane}.log`), `${stamp()} ${line}\n`); } catch { /* viewer only */ } },
    async close(closeTabs) { if (closeTabs) for (const p of panes) spawnSync(cli[0]!, [...cli.slice(1), 'side', 'pane', 'close', p], { env, timeout: 10_000 }); },
  };
}
