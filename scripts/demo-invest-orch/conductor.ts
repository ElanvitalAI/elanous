// DEMO-1126-INVEST-ORCH conductor — `eln demo invest run --els`: the els window is the hero.
//   1. makes sure the target universe's els server answers (starts `side serve` when it does not)
//   2. opens workspace «invest-demo» with the board tab («INV·Board»), which runs the live graph with --els: the board
//      opens one tab per data lane (INV·News · INV·X · INV·DART · INV·Price) and the graph one tab per panelist (15)
//   3. with --capture: drives one attached els window in a private tmux (cols × rows) — tile view when the installed els
//      has it (`side attach --tile`), else ctrl+b n through the tabs every few seconds — and ends on the board tab with
//      최종 결론; every second the window is captured (ANSI) into a JSON frame list for the preview.
// Observation and focus keys only: the run itself is the same `demo invest board` live run.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { riskVerdictKo } from '../../src/tui/widgets/scenes/invest-board-view.js';

export interface ConductorOptions {
  readonly record?: string;
  readonly capture?: string;
  readonly cycleSec?: number;
  readonly cols?: number;
  readonly rows?: number;
  readonly ticker?: string;
  readonly log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runConductor(o: ConductorOptions): Promise<{ ok: boolean; frames: number }> {
  const log = o.log ?? ((l: string) => console.error(l));
  const { investElsTarget, investElsEnv } = await import('./handlers.js');
  const { effectiveInstanceRoot } = await import('../../src/instance/resolve.js');
  const env0 = { ...process.env, ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot() };
  process.env.ELANOUS_STATE_DIR = env0.ELANOUS_STATE_DIR;
  const target = investElsTarget(env0);
  const env = investElsEnv(env0, target);
  const cli = process.env.INVEST_DEMO_ELN ? [process.env.INVEST_DEMO_ELN] : [process.execPath, join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs')];
  const els = (...args: string[]) => spawnSync(cli[0]!, [...cli.slice(1), 'side', ...args], { env, encoding: 'utf8', timeout: 20_000 });
  if (!existsSync(target.socket)) {
    log('conductor: starting the els server for this universe');
    spawn(cli[0]!, [...cli.slice(1), 'side', 'serve'], { env, detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30 && !existsSync(target.socket); i++) await sleep(500);
  }
  els('workspace', 'close', 'invest-demo');
  const record = o.record ?? join(target.stateRoot, 'invest-demo', `board-pin-${Date.now()}.json`);
  // A pane may not open panes (els control door), so the run lives here, outside els: the board tab only shows the
  // board's frames (a tail of the screen stream this process writes), and the child tabs open from this process.
  const stream = join(target.stateRoot, 'invest-demo', `board-screen-${Date.now()}.ansi`);
  mkdirSync(dirname(stream), { recursive: true });
  writeFileSync(stream, '');
  const r = els('new', '--ws', 'invest-demo', '--title', 'INV·Board · 최종 결론', '--', 'tail', '-n', '+1', '-F', stream);
  if (r.status !== 0) { log(`conductor: could not open the board tab: ${String(r.stderr).trim().slice(0, 200)}`); return { ok: false, frames: 0 }; }
  const boardPane = (JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '{}') as { pane?: string }).pane ?? '';
  // the board draws at the size of its tab once a window is attached (until then a 160×50 default)
  let size = { cols: 160, rows: 50 };
  const sizeOfTab = () => { const m = /\[screen (\d+)x(\d+)/u.exec(String(els('read', boardPane).stdout ?? '')); if (m) size = { cols: Number(m[1]), rows: Number(m[2]) }; };
  const cols = o.cols ?? 200, rows = o.rows ?? 80;
  const sock = `invdemo${process.pid}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', sock, ...args], { env, encoding: 'utf8' });
  const attachHelp = String(els('attach', '--help').stdout ?? '');
  const tile = /--tile\b/u.test(attachHelp), stage = tile && /--stage\b/u.test(attachHelp);
  // Stage feed (JSONL snapshots) for `els attach --tile --stage --feed`; written from the run's real events.
  const feed = join(target.stateRoot, 'invest-demo', 'stage-feed.jsonl');
  writeFileSync(feed, '');
  if (o.capture) {
    const attach = [...cli, 'side', ...(tile ? ['attach', '--tile', ...(stage ? ['--stage', '--feed', feed] : []), '--ws', 'invest-demo'] : [])].map((a) => `'${a}'`).join(' ');
    tmux('new-session', '-d', '-s', 'v', '-x', String(cols), '-y', String(rows), `env ELANOUS_STATE_DIR='${target.stateRoot}' ${attach}`);
    await sleep(2500);
  }
  sizeOfTab();
  const { runInvestBoardLive } = await import('./board-live.js');
  const emit = (ev: Record<string, unknown>) => { try { appendFileSync(feed, `${JSON.stringify(ev)}\n`); } catch { /* viewer only */ } };
  const byTitle = (needle: string): string | undefined => {
    try { const d = JSON.parse(String(els('ls').stdout)) as { tabs: Array<{ label: string; focusPaneId: string }> }; return d.tabs.find((t) => t.label.includes(needle))?.focusPaneId; } catch { return undefined; }
  };
  const stageOf = stageFeed(emit, { board: boardPane, byTitle });
  const run = runInvestBoardLive({ onEvent: stageOf, ticker: o.ticker ?? '005930.KS', question: 'What is the 2027 outlook for Samsung Electronics: buy, hold or sell?', els: true, record,
    write: (text) => { try { appendFileSync(stream, text); } catch { /* viewer only */ } }, size: () => ({ columns: size.cols, rows: size.rows }) });
  log('conductor: board tab open — the run starts here, its children open as tabs');
  let done = false;
  void run.finally(() => { done = true; });
  if (!o.capture) { await run; return { ok: true, frames: 0 }; }
  log(`conductor: capturing the els window ${cols}×${rows} (${stage ? 'tile stage' : tile ? 'tile view' : 'tab cycling'})`);
  const frames: Array<{ t: number; ansi: string }> = [];
  const t0 = Date.now();
  const grab = () => { const c = tmux('capture-pane', '-e', '-p', '-t', 'v'); if (c.status === 0) frames.push({ t: Date.now() - t0, ansi: String(c.stdout) }); return String(c.stdout ?? ''); };
  const cycle = (o.cycleSec ?? 4) * 1000;
  let lastCycle = Date.now(), dir: 'n' | 'p' = 'n', step = 0;
  const tabCount = () => { try { return (JSON.parse(String(els('ls').stdout)) as { tabs: unknown[] }).tabs.length; } catch { return 5; } };
  while (!done && Date.now() - t0 < 15 * 60_000) {
    grab();
    if (frames.length % 10 === 0) sizeOfTab();
    // without tile: walk the tabs forward, then back (the tab list does not wrap)
    if (!tile && Date.now() - lastCycle >= cycle) {
      const n = tabCount();
      if (step >= n - 1) { dir = dir === 'n' ? 'p' : 'n'; step = 0; }
      tmux('send-keys', '-t', 'v', 'C-b', dir); step++; lastCycle = Date.now();
    }
    await sleep(1000);
  }
  // the end: the board tab with the Korean conclusion (zoom out of tile first when tile is on)
  if (!stage) {
    if (tile) tmux('send-keys', '-t', 'v', 'Escape');
    // the board is the first tab: step back until it shows
    for (let i = 0; i < 40; i++) {
      const text = grab().replace(/\x1b\[[0-9;]*m/gu, '');
      if (text.includes('Expert panel') && text.includes('Agents')) break;
      tmux('send-keys', '-t', 'v', 'C-b', 'p');
      await sleep(600);
    }
  }
  for (let i = 0; i < 6; i++) { grab(); await sleep(1000); }
  tmux('kill-server');
  writeFileSync(o.capture, JSON.stringify({ cols, rows, tile, frames }));
  log(`conductor: ${frames.length} window frames → ${o.capture}`);
  return { ok: true, frames: frames.length };
}

/**
 * Board events → els stage feed (`els attach --tile --stage --feed <file> --ws invest-demo`): one JSON snapshot per line
 * {phase, nodes[], evidence, votes[{id, vote}], consensus{label, value}, spotlightPane, spotlightMs, verdictPane, receipt}.
 * phase: prompt → spawn → work → spotlight → votes → verdict → receipt. Every field comes from a real graph event.
 */
export function stageFeed(emit: (ev: Record<string, unknown>) => void, panes: { board?: string; byTitle?: (needle: string) => string | undefined } = {}): (e: import('../../src/tui/widgets/scenes/invest-board.js').BoardEvent) => void {
  const nodes = new Map<string, { id: string; state: string; title?: string }>();
  const votes = new Map<string, string>();
  const models = new Set<string>();
  let evidence = 0, phase = 'prompt', t0 = 0, consensus: { label: string; value: number } | undefined;
  let spotlightPane: string | undefined, verdictPane: string | undefined, receipt: string | undefined, spotlightMs: number | undefined, spotlightCaption: string | undefined;
  let toolCalls = 0, now = 0, kospi: number | undefined;
  const ACT_KO: Record<string, string> = { BUY: '매수', HOLD: '보유', SELL: '매도' };
  const isAgent = (id: string) => /^(panel-(?!join)|mentor-)/u.test(id);
  const counters = () => ({ toolCalls, cited: evidence, agents: [...nodes.values()].filter((n) => isAgent(n.id)).length, models: models.size, elapsedMs: Math.max(0, now - t0) });
  const snap = () => emit({ phase, nodes: [...nodes.values()], evidence, counters: counters(), ...(spotlightCaption ? { spotlightCaption } : {}), votes: [...votes].map(([id, vote]) => ({ id, vote })),
    ...(consensus ? { consensus } : {}), ...(spotlightPane ? { spotlightPane, spotlightMs } : {}), ...(verdictPane ? { verdictPane } : {}), ...(receipt ? { receipt } : {}) });
  return (e) => {
    now = e.t;
    if (e.kind === 'market' && e.market.kospi) kospi = e.market.kospi.last;
    if (e.kind === 'run' && e.phase === 'start') { t0 = e.t; phase = 'prompt'; snap(); return; }
    if (e.kind === 'tab') { nodes.set(e.id, { id: e.id, state: 'running', title: e.title }); phase = 'spawn'; snap(); return; }
    if (e.kind === 'node') {
      const lane = ({ news: 'news', 'event-shock': 'news', 'x-pulse': 'x', 'conatus-research': 'dart', 'conatus-ops': 'dart', score: 'dart', market: 'price', flows: 'price' } as Record<string, string>)[e.id];
      const id = isAgent(e.id) ? e.id : lane;
      if (!id) return;
      const prev = nodes.get(id) ?? { id, state: 'waiting' };
      nodes.set(id, { ...prev, state: e.phase === 'start' ? 'running' : e.outcome === 'fail' ? 'failed' : (lane ? prev.state : 'done') });
      if (isAgent(e.id) && e.phase === 'start') phase = 'spawn';
      else if (phase === 'spawn' || phase === 'prompt') phase = 'work';
      snap(); return;
    }
    if (e.kind === 'call') { toolCalls += e.n; }
    if (e.kind === 'call') { const l = nodes.get(({ news: 'news', 'event-shock': 'news', 'x-pulse': 'x', 'conatus-research': 'dart', 'conatus-ops': 'dart', score: 'dart', market: 'price', flows: 'price' } as Record<string, string>)[e.id] ?? ''); if (l) l.state = 'done'; return; }
    if (e.kind === 'evidence') { evidence++; return; }
    if (e.kind === 'note') { if (e.model) models.add(e.model.split('/').at(-1)!); if (e.verdict) { votes.set(e.id, e.verdict); phase = 'votes'; snap(); } return; }
    if (e.kind === 'result') {
      const r = e.result;
      if (r.risk && !r.risk.pending) {
        spotlightPane = panes.byTitle?.('Jang'); spotlightMs = 3000;
        // two lines: who · role / the risk verdict applied to today's KOSPI (no number the run did not produce)
        spotlightCaption = `${r.ko?.riskExpert ?? '장우진'} · 리스크 / ${riskVerdictKo(r.risk)}${kospi !== undefined ? ` · KOSPI ${Math.round(kospi).toLocaleString('en-US')}` : ''}`;
        phase = 'spotlight'; snap();
      }
      consensus = { label: ACT_KO[r.action] ?? r.action, value: r.consensus?.score ?? 0 };
      verdictPane = panes.board; phase = 'verdict'; snap(); return;
    }
    if (e.kind === 'run' && e.phase === 'end') {
      const agents = [...nodes.values()].filter((n) => isAgent(n.id)).length;
      receipt = `${agents} agents · ${models.size} models · ${Math.round((e.t - t0) / 1000)}s · ${evidence} sources`;
      phase = 'receipt'; snap();
    }
  };
}
