/**
 * Invest Research Board (DEMO-1126-INVEST-ORCH · DEMO-INVEST-SCREEN-POLISH) — one ticker, one graph run, one screen:
 * header (ticker · question · status · elapsed · agents) · FanoutBoard (news · X/social · filings/DART · price/flow ·
 * analyst panel) · StepList (graph nodes) · evidence ticker (cited sources as they arrive) · ResultCard (thesis · bull ·
 * bear · confidence gauge · key numbers · sources · disclaimer).
 *
 * Pure: `reduceInvestBoard(meta, events, tMs)` folds the run's events up to tMs into a state; `renderInvestBoard(state,
 * width, rows)` draws it, never wider than `width` nor taller than `rows`. Nothing moves without an event: the only
 * motion is a fresh evidence line sliding in and a «new» mark on a row whose state changed in the last second.
 * The same events come from a live run (scripts/demo-invest-orch/board-live.ts) or a pinned run (`--replay`).
 * All copy is English; no host names or paths.
 */
import { renderFanoutBoard, renderGauge, renderResultCard, renderStepList, STEP_GLYPH, type FanoutAgent, type FanoutState, type ResultCardProps, type Step, type StepState } from '../index.js';
import { cells, clean, elapsed, fit } from '../text.js';
import { INVEST_DISCLAIMER, panelName, shortModel } from './invest-run.js';
import { drawInvestBoard } from './invest-board-view.js';

export const BOARD_DISCLAIMER = INVEST_DISCLAIMER;

export type BoardEvent =
  | { readonly t: number; readonly kind: 'run'; readonly phase: 'start' | 'end'; readonly status?: 'done' | 'failed' }
  | { readonly t: number; readonly kind: 'node'; readonly id: string; readonly phase: 'start' | 'end'; readonly outcome?: 'ok' | 'fail' }
  | { readonly t: number; readonly kind: 'note'; readonly id: string; readonly runtime?: string; readonly model?: string; readonly verdict?: string }
  | { readonly t: number; readonly kind: 'evidence'; readonly source: string; readonly title: string; readonly url: string }
  | { readonly t: number; readonly kind: 'result'; readonly result: BoardResult }
  | BoardMarketEvent
  /** A child's els tab opened (lane id or node id → tab title). */
  | { readonly t: number; readonly kind: 'tab'; readonly id: string; readonly title: string }
  /** One real tool call record of a data node: tool · how many calls · ok · items · start/end (ms into the run) · live or recorded. */
  | { readonly t: number; readonly kind: 'call'; readonly id: string; readonly tool: string; readonly n: number; readonly ok: boolean; readonly items: number; readonly startT: number; readonly endT: number; readonly live: boolean };
export type BoardCall = Extract<BoardEvent, { kind: 'call' }>;
/** Market snapshot from the data nodes (omni-market EOD · kr-flow · asset-attractiveness); later events merge over earlier. */
export interface BoardMarket {
  readonly kospi?: { readonly last: number; readonly chg1m?: number; readonly chg3m?: number };
  readonly usdkrw?: { readonly last: number; readonly chg1m?: number };
  readonly us10y?: { readonly last: number };
  /** Foreign net buying per day on KOSPI, oldest first (million KRW). */
  readonly foreignDaily?: readonly number[];
  readonly foreign20dMillion?: number;
  readonly framework?: { readonly total: number; readonly signal: string };
}
export type BoardMarketEvent = { readonly t: number; readonly kind: 'market'; readonly market: BoardMarket };

export interface BoardResult {
  readonly action: string;
  readonly thesis: string;
  readonly bull: readonly string[];
  readonly bear: readonly string[];
  /** 0..1 */
  readonly confidence: number;
  readonly numbers: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly sources: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  /** The expert panel's weighted consensus (attractiveness-panel formula). */
  readonly consensus?: { readonly score: number; readonly action: string; readonly confidencePct: number; readonly answered: number; readonly of: number };
  /** Panelists who disagree with the consensus, heaviest first («Fundamentals BUY 7 · w 0.12»). */
  readonly divergences?: readonly string[];
  /** The risk expert's box: applied from his lecture summary, or pending when that source is absent. */
  readonly risk?: { readonly expert: string; readonly pending: boolean; readonly verdict?: string; readonly maxPositionPct?: number | null; readonly stop?: string; readonly hedge?: string };
  /** Korean copy of the verdict (대표 11-26: the final-conclusion panel is Korean; other panels stay English). */
  readonly ko?: { readonly thesis: string; readonly bull: readonly string[]; readonly bear: readonly string[]; readonly divergences: readonly string[]; readonly riskExpert?: string; readonly stop?: string; readonly hedge?: string };
}

export interface BoardMeta {
  readonly ticker: string;
  readonly name: string;
  readonly question: string;
  readonly mode: 'live' | 'replay';
  /** Every agent node of the graph with the runtime · model the graph binds it to. */
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly runtime?: string; readonly model?: string }>;
  /** Wall clock of t = 0 (ISO) — evidence and calls show real times. */
  readonly startedAt?: string;
  /** The expert panel: personas on the board of the sector panel, and the consensus weight they carry. */
  readonly panel?: { readonly shown: number; readonly total: number; readonly weight: number };
  /** Display names of the named experts (mentor nodes), e.g. { 'mentor-1': 'Vincent' } — shown first in the panel lane. */
  readonly experts?: Readonly<Record<string, string>>;
}

export type BoardNodeState = 'waiting' | 'running' | 'done' | 'failed';
export interface BoardNode {
  readonly id: string;
  readonly state: BoardNodeState;
  readonly runtime?: string;
  readonly model?: string;
  readonly verdict?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** When its state last changed (ms into the run). */
  readonly changedAt?: number;
}
export interface BoardEvidence { readonly t: number; readonly source: string; readonly title: string; readonly url: string }
export interface InvestBoardState {
  readonly meta: BoardMeta;
  readonly tMs: number;
  readonly status: 'waiting' | 'running' | 'done' | 'failed';
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly nodes: ReadonlyMap<string, BoardNode>;
  /** Oldest first. */
  readonly evidence: readonly BoardEvidence[];
  readonly result?: BoardResult;
  readonly calls: readonly BoardCall[];
  readonly market: BoardMarket;
  /** Child els tabs by lane id (news · x · dart · price). */
  readonly tabs: Readonly<Record<string, string>>;
}

/** Display names for the tickers the demo knows; anything else shows the symbol. */
const TICKER_NAME: Readonly<Record<string, string>> = { '005930': 'Samsung Electronics', '000660': 'SK hynix', '035420': 'NAVER', '005380': 'Hyundai Motor' };
export const tickerName = (ticker: string): string => TICKER_NAME[ticker.split('.')[0] ?? ''] ?? ticker;
/** The graph speaks «.KO» (EODHD); the screen shows the exchange suffix people know («.KS»). */
export const displayTicker = (ticker: string): string => ticker.replace(/\.KO$/u, '.KS');

export const isPanelNode = (id: string): boolean => (id.startsWith('panel-') && id !== 'panel-join') || /^mentor-\d+$/u.test(id);
export const isExpertNode = (id: string): boolean => id.startsWith('panel-') && id !== 'panel-join';

/** The five child agents of the board and the graph nodes each one stands for. */
export const BOARD_GROUPS: ReadonlyArray<{ readonly name: string; readonly tail: string; readonly ids: readonly string[] | 'panel'; readonly sources: readonly string[] }> = [
  { name: 'News', tail: 'omni-crawl', ids: ['news', 'event-shock'], sources: ['news', 'event-shock'] },
  { name: 'X / social', tail: 'apify · grok-x', ids: ['x-pulse'], sources: ['x-pulse'] },
  { name: 'Filings/DART', tail: 'Conatus · DART', ids: ['conatus-research', 'conatus-ops', 'score'], sources: ['conatus-research', 'score'] },
  { name: 'Price / flow', tail: 'omni-market · kr-flow', ids: ['market', 'flows'], sources: ['market', 'flows'] },
  { name: 'Expert panel', tail: 'eln · codex · claude', ids: 'panel', sources: [] },
];

/** Fold every event with t ≤ tMs into the board state (deterministic: same events → same state). */
export function reduceInvestBoard(meta: BoardMeta, events: readonly BoardEvent[], tMs: number): InvestBoardState {
  const nodes = new Map<string, BoardNode>(meta.nodes.map((n) => [n.id, { id: n.id, state: 'waiting' as BoardNodeState, ...(n.runtime ? { runtime: n.runtime } : {}), ...(n.model ? { model: n.model } : {}) }]));
  let status: InvestBoardState['status'] = 'waiting';
  let startedAt: number | undefined, endedAt: number | undefined, result: BoardResult | undefined;
  const evidence: BoardEvidence[] = [];
  const calls: BoardCall[] = [];
  let market: BoardMarket = {};
  const tabs: Record<string, string> = {};
  for (const e of events) {
    if (e.t > tMs) break;
    if (e.kind === 'run') {
      if (e.phase === 'start') { status = 'running'; startedAt = e.t; } else { status = e.status ?? 'done'; endedAt = e.t; }
    } else if (e.kind === 'node') {
      const prev = nodes.get(e.id) ?? { id: e.id, state: 'waiting' as BoardNodeState };
      if (e.phase === 'start') nodes.set(e.id, { ...prev, state: 'running', startedAt: e.t, changedAt: e.t });
      else nodes.set(e.id, { ...prev, state: e.outcome === 'fail' || prev.verdict === 'no answer' ? 'failed' : 'done', endedAt: e.t, changedAt: e.t });
    } else if (e.kind === 'note') {
      const prev = nodes.get(e.id) ?? { id: e.id, state: 'waiting' as BoardNodeState };
      nodes.set(e.id, { ...prev, ...(e.runtime ? { runtime: e.runtime } : {}), ...(e.model && e.model !== 'default' ? { model: e.model } : {}), ...(e.verdict ? { verdict: e.verdict } : {}) });
    } else if (e.kind === 'evidence') {
      if (!evidence.some((x) => x.url === e.url)) evidence.push({ t: e.t, source: e.source, title: e.title, url: e.url });
    } else if (e.kind === 'call') calls.push(e);
    else if (e.kind === 'market') market = { ...market, ...e.market };
    else if (e.kind === 'tab') tabs[e.id] = e.title;
    else result = e.result;
  }
  return { meta, tMs, status, ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}), nodes, evidence, calls, market, tabs, ...(result ? { result } : {}) };
}

// ── pieces ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const FRESH_MS = 1000;
const host = (url: string): string => url.replace(/^https?:\/\//u, '').replace(/^www\./u, '').replace(/[/?#].*$/u, '');
/** «06:31:02 » (KST) when the run's wall clock is known. */
export function clock(state: InvestBoardState, t: number): string {
  const base = Date.parse(state.meta.startedAt ?? '');
  if (!Number.isFinite(base)) return '';
  const d = new Date(base + t + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} `;
}
const SOURCE_LABEL: Readonly<Record<string, string>> = { news: 'News', 'event-shock': 'News', 'x-pulse': 'X', 'conatus-research': 'DART', score: 'DART', market: 'Price', flows: 'Flow' };

function groupIds(state: InvestBoardState, ids: readonly string[] | 'panel'): BoardNode[] {
  if (ids === 'panel') return [...state.nodes.values()].filter((n) => isPanelNode(n.id));
  return ids.map((id) => state.nodes.get(id) ?? { id, state: 'waiting' as BoardNodeState });
}

export function groupAgentFor(state: InvestBoardState, g: (typeof BOARD_GROUPS)[number]): FanoutAgent {
  const members = groupIds(state, g.ids);
  const ended = members.filter((m) => m.state === 'done' || m.state === 'failed');
  const failed = members.filter((m) => m.state === 'failed');
  const anyStarted = members.some((m) => m.state !== 'waiting');
  const fs: FanoutState = !anyStarted ? 'waiting' : ended.length < members.length ? 'running' : members.length > 0 && failed.length === members.length ? 'failed' : 'done';
  const starts = members.map((m) => m.startedAt).filter((t): t is number => t !== undefined);
  const ends = members.map((m) => m.endedAt ?? (m.state === 'running' ? state.tMs : undefined)).filter((t): t is number => t !== undefined);
  const elapsedMs = starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0;
  const fresh = members.some((m) => m.changedAt !== undefined && state.tMs - m.changedAt < FRESH_MS && state.tMs >= m.changedAt);
  let last: string;
  if (g.ids === 'panel') {
    const votes = { BUY: 0, HOLD: 0, SELL: 0 } as Record<string, number>;
    for (const m of members) { const a = /^(BUY|HOLD|SELL)\b/u.exec(m.verdict ?? '')?.[1]; if (a) votes[a] = (votes[a] ?? 0) + 1; }
    const tally = (['BUY', 'HOLD', 'SELL'] as const).filter((a) => votes[a]).map((a) => `${a} ${votes[a]}`).join(' · ');
    last = !anyStarted ? 'queued' : `${ended.length - failed.length} of ${members.length} answered${tally ? ` · ${tally}` : ''}${failed.length ? ` · ${failed.length} failed` : ''}`;
  } else {
    const cited = state.evidence.filter((e) => g.sources.includes(e.source)).length;
    const ids = g.ids as readonly string[];
    const calls = state.calls.filter((c) => ids.includes(c.id));
    const recorded = calls.some((c) => !c.live);
    last = !anyStarted ? 'queued'
      : fs === 'failed' ? 'no data'
        : fs === 'running' ? `fetching · ${ended.length} of ${members.length}`
          : `${cited ? `${cited} cited` : `${members.length - failed.length} of ${members.length} sources`}${failed.length ? ` · ${failed.length} failed` : ''}${calls.length ? (recorded ? ' · recorded' : ' · live') : ''}`;
  }
  const tail = g.ids === 'panel' ? panelTail(members) : callTail(state, g.ids, g.tail);
  return { name: g.name, modelTail: tail, state: fs, progress: members.length ? ended.length / members.length : null, elapsedMs, lastLine: `${fresh ? '• ' : ''}${last}` };
}

/** «omni-crawl ×5» from the real call records; the planned tool until a call lands. */
function callTail(state: InvestBoardState, ids: readonly string[], planned: string): string {
  const by = new Map<string, number>();
  for (const c of state.calls) if (ids.includes(c.id) && c.n > 0) by.set(c.tool.split(' ')[0]!, (by.get(c.tool.split(' ')[0]!) ?? 0) + c.n);
  return by.size ? [...by].map(([tool, n]) => `${tool} ×${n}`).join(' · ') : planned;
}

function panelTail(members: readonly BoardNode[]): string {
  const runtimes = [...new Set(members.map((m) => m.runtime).filter(Boolean))];
  return `${members.length} · ${runtimes.length ? runtimes.join(' · ') : 'eln · codex · claude'}`;
}

const stepState = (states: readonly BoardNodeState[]): StepState =>
  states.length > 0 && states.every((s) => s === 'done' || s === 'failed') ? 'done' : states.some((s) => s !== 'waiting') ? 'active' : 'todo';

export function boardSteps(state: InvestBoardState): Step[] {
  const s = (ids: readonly string[]): BoardNodeState[] => ids.map((id) => state.nodes.get(id)?.state ?? 'waiting');
  const data = ['conatus-research', 'conatus-ops', 'news', 'x-pulse', 'event-shock', 'market', 'flows', 'score'];
  const dataStates = s(data);
  const panel = [...state.nodes.values()].filter((n) => isPanelNode(n.id));
  const answered = panel.filter((n) => n.state === 'done').length;
  const row = (label: string, st: BoardNodeState[], note?: string): Step => ({ label, state: stepState(st), ...(note ? { note } : {}) });
  return [
    row('Plan', s(['plan']), state.meta.mode === 'replay' ? 'pinned run' : 'live run'),
    row('Collect', dataStates, `${dataStates.filter((x) => x === 'done' || x === 'failed').length} of ${data.length} sources in parallel`),
    row('Factsheet', s(['factsheet'])),
    row('Panel', panel.map((n) => n.state), `${answered} of ${panel.length} answered`),
    row('Consensus', s(['consensus']), state.result ? state.result.action : undefined),
    row('Judge', s(['conatus-judge', 'decision-triage']), 'no order placed'),
    row('Report', s(['report'])),
  ];
}

function header(state: InvestBoardState, width: number): string[] {
  const { meta } = state;
  const glyph = state.status === 'done' ? '✓' : state.status === 'failed' ? '✗' : state.status === 'running' ? '●' : '◌';
  const runMs = state.startedAt === undefined ? 0 : (state.endedAt ?? state.tMs) - state.startedAt;
  const right = `${glyph} ${state.status === 'waiting' ? 'ready' : state.status} · ${elapsed(Math.max(0, runMs))}${meta.mode === 'replay' ? ' · replay' : ''}`;
  const left = `Invest Research · ${clean(meta.name)} (${clean(displayTicker(meta.ticker))})`;
  const room = width - cells(right) - 2;
  const line1 = room >= 12 ? `${fit(left, room)}${' '.repeat(Math.max(2, width - cells(fit(left, room)) - cells(right)))}${right}` : fit(`${left} · ${right}`, width);
  const agents = [...state.nodes.values()].filter((n) => isPanelNode(n.id));
  const byRuntime = new Map<string, number>();
  for (const n of agents) { const k = n.runtime ?? 'agent'; byRuntime.set(k, (byRuntime.get(k) ?? 0) + 1); }
  const distinct = new Set(agents.map((n) => shortModel(n.model)).filter(Boolean)).size;
  const models = [...byRuntime].map(([k, c]) => `${k} ×${c}`).concat(distinct ? [`${distinct} model${distinct === 1 ? "" : "s"}`] : []);
  return [
    fit(line1, width),
    fit(`Q  ${clean(meta.question)}`, width),
    fit(`Graph run · ${agents.length} agents${models.length ? ` · ${models.join(' · ')}` : ''}`, width),
  ];
}

/** Evidence ticker: newest first, one source per line; the newest slides in while it is fresh. */
export function evidenceLines(state: InvestBoardState, width: number, max: number): string[] {
  if (max <= 0) return [];
  const head = fit(`Evidence · ${state.evidence.length} cited`, width);
  if (max === 1) return [head];
  if (!state.evidence.length) return [head, fit(state.status === 'waiting' ? '  waiting for sources' : state.status === 'running' ? '  no sources yet' : '  no sources cited', width)];
  const newest = [...state.evidence].reverse().slice(0, max - 1);
  return [head, ...newest.map((e, i) => {
    const text = `  ${clock(state, e.t)}${SOURCE_LABEL[e.source] ?? 'Web'} · ${clean(e.title)} — ${host(e.url)}`;
    const age = state.tMs - e.t;
    if (i === 0 && age >= 0 && age < FRESH_MS) {
      // slide in from the right over the first second after the event (frames of 250 ms)
      const frac = Math.min(1, (Math.floor(age / 250) + 1) / 4);
      const lead = Math.round((1 - frac) * Math.min(width, cells(text)));
      return fit(`${' '.repeat(lead)}${text}`, width);
    }
    return fit(text, width);
  })];
}

/** The result card at a detail level (0 = full … 3 = smallest); its last lines (disclaimer, border) are always kept. */
function card(result: BoardResult, width: number, level: number): string[] {
  const per = level === 0 ? 3 : level === 1 ? 2 : 1;
  const inner = Math.max(8, Math.min(100, width)) - 6;
  const gauge = renderGauge({ label: 'Confidence', value: Math.round(Math.min(1, Math.max(0, result.confidence)) * 100), max: 100 }, inner);
  const numbers = result.numbers.map((n) => `${n.label} ${n.value}`);
  if (level >= 3) {
    // smallest: gauge as the heading, the strongest bull and bear point, the disclaimer
    const riskLine = result.risk ? [`! Risk ${result.risk.pending ? 'source pending' : `${result.risk.verdict ?? '?'}${typeof result.risk.maxPositionPct === 'number' ? ` ≤${result.risk.maxPositionPct}%` : ''}`}`] : [];
    const lines = level === 3 ? [`+ ${result.bull[0] ?? 'none found'}`, `− ${result.bear[0] ?? 'none found'}`, ...riskLine] : [];
    return renderResultCard({ title: `Verdict · ${result.action}`, sections: [{ heading: gauge, lines }], disclaimer: BOARD_DISCLAIMER }, width);
  }
  const props: ResultCardProps = {
    title: `Verdict · ${result.action}`,
    ...(level < 3 ? { subtitle: result.thesis } : {}),
    sections: [
      ...(level < 3 ? [{ heading: 'Bull', lines: result.bull.length ? result.bull.slice(0, per).map((b) => `+ ${b}`) : ['+ none found'] },
        { heading: 'Bear', lines: result.bear.length ? result.bear.slice(0, per).map((b) => `− ${b}`) : ['− none found'] }] : []),
      ...(result.consensus ? [{ heading: 'Weighted panel consensus', lines: [
        `${result.consensus.action} · score ${result.consensus.score >= 0 ? '+' : ''}${result.consensus.score.toFixed(2)} · ${result.consensus.answered} of ${result.consensus.of} answered`,
        ...(result.divergences?.length ? [`Divergent: ${result.divergences.slice(0, level === 0 ? 3 : 1).join(' · ')}`] : []),
      ] }] : []),
      ...(result.risk ? [{ heading: `Risk · ${result.risk.expert}`, lines: result.risk.pending ? ['source pending (lecture summary not yet available)']
        : [`${result.risk.verdict ?? '?'}${typeof result.risk.maxPositionPct === 'number' ? ` · max position ${result.risk.maxPositionPct}%` : ''}`,
          ...(level < 2 ? [`Stop: ${result.risk.stop ?? '?'}`, `Hedge: ${result.risk.hedge ?? '?'}`] : [])] }] : []),
      { heading: level < 2 ? 'Confidence' : gauge, lines: level < 2 ? [gauge] : [] },
      ...(numbers.length ? [{ heading: 'Key numbers', lines: level < 2 ? [numbers.join(' · ')] : [numbers.slice(0, 3).join(' · ')] }] : []),
    ],
    ...(result.sources.length && level < 3 ? { evidence: result.sources.slice(0, level === 0 ? 3 : 1).map((s, i) => ({ n: i + 1, label: s.label, url: host(s.url) })) } : {}),
    disclaimer: BOARD_DISCLAIMER,
  };
  return renderResultCard(props, width);
}

function fitCard(result: BoardResult, width: number, room: number): string[] {
  for (let level = 0; level <= 4; level++) {
    const c = card(result, width, level);
    if (c.length <= room) return c;
  }
  const c = card(result, width, 4);
  if (room <= 0) return [];
  // hard cut: top border, then the last lines (disclaimer + border)
  return room >= 3 ? [c[0]!, ...c.slice(-(room - 1))] : c.slice(-room);
}

export const EXPERT_LABEL = 'Named experts: applied from lecture notes, not their statements.';
const expertName = (state: InvestBoardState, id: string): string => state.meta.experts?.[id] ?? panelName(id);

/** Expert panel lane: named experts first, then the sector personas — one chip each (glyph · name · action confidence). */
export function expertLines(state: InvestBoardState, width: number, maxRows: number): string[] {
  if (maxRows <= 0) return [];
  const all = [...state.nodes.values()].filter((n) => isPanelNode(n.id));
  const named = all.filter((n) => /^mentor-\d+$/u.test(n.id)), personas = all.filter((n) => isExpertNode(n.id));
  const p = state.meta.panel;
  const head = fit(`Expert panel · ${named.length} named experts + ${personas.length}${p ? ` of ${p.total} sector personas (weight ${p.weight.toFixed(2)})` : ' sector personas'}`, width);
  const cols = width >= 66 ? 3 : 2;
  const cw = Math.floor((width - (cols - 1) * 2) / cols);
  const chip = (n: BoardNode) => {
    const g = n.state === 'done' ? '✓' : n.state === 'failed' ? '✗' : n.state === 'running' ? '●' : '◌';
    const v = n.state === 'failed' ? 'no answer' : (n.verdict ?? '').replace(/\/10$/u, '');
    const name = expertName(state, n.id);
    const room = cw - cells(v) - 3;
    const label = `${g} ${fit(name, Math.max(4, room))}`;
    return `${label}${' '.repeat(Math.max(1, cw - cells(label) - cells(v)))}${v}`;
  };
  const chips = [...named, ...personas].map(chip);
  const rows: string[] = [];
  for (let i = 0; i < chips.length; i += cols) rows.push(chips.slice(i, i + cols).map((c, j, a) => (j < a.length - 1 ? c + ' '.repeat(Math.max(0, cw - cells(c))) : c)).join('  ').trimEnd());
  const tally = () => {
    const c = { BUY: 0, HOLD: 0, SELL: 0 } as Record<string, number>;
    for (const n of all) { const a = /^(BUY|HOLD|SELL)/u.exec(n.verdict ?? '')?.[1]; if (a) c[a]!++; }
    const failed = all.filter((n) => n.state === 'failed').length;
    return `  ${named.map((n) => `${expertName(state, n.id)} ${(/^(BUY|HOLD|SELL)/u.exec(n.verdict ?? '')?.[1]) ?? '…'}`).join(' · ')} · BUY ${c.BUY} · HOLD ${c.HOLD} · SELL ${c.SELL}${failed ? ` · ${failed} failed` : ''}`;
  };
  const body = rows.length <= maxRows - 2 ? rows : maxRows - 3 >= 1 ? [...rows.slice(0, maxRows - 3), `  … +${chips.length - (maxRows - 3) * cols} more`] : [tally()];
  return [head, ...body.map((r) => fit(r, width)), ...(maxRows >= 3 ? [fit(`  ${EXPERT_LABEL}`, width)] : [])].slice(0, maxRows);
}

const inlineSteps = (steps: readonly Step[], width: number): string =>
  fit(steps.map((s) => `${STEP_GLYPH[s.state]} ${s.label}`).join(' › '), width);

/** The board fitted to width × rows. Wide panes (≥ 100) put the card in a right column. */
/** The board as plain lines (width checks, tests); the terminal and the preview draw the same canvas in colour. */
export function renderInvestBoard(state: InvestBoardState, width: number, rows: number): string[] {
  return drawInvestBoard(state, width, rows).lines();
}

// ── dashboard.json → result ──────────────────────────────────────────────────────────────────────────────────────────
interface DashPart { score?: number; action?: string; n?: number; of?: number; confidencePct?: number; votes?: { BUY?: number; HOLD?: number; SELL?: number } }
export interface BoardDashboard {
  readonly ticker?: string;
  readonly panel?: ReadonlyArray<{ id: string; label?: string; status?: string; action?: string | null; confidence?: number | null; weight?: number }>;
  readonly mentors?: ReadonlyArray<{ id: string; name?: string; status?: string; action?: string | null; confidence?: number | null; riskSource?: string | null; risk?: { verdict?: string; maxPositionPct?: number | null; stop?: string; hedge?: string; stopKo?: string; hedgeKo?: string } | null }>;
  readonly consensus?: { panel?: DashPart; mentors?: DashPart; overall?: { score?: number; action?: string } };
  readonly framework?: { total?: number; signal?: string; tiers?: Record<string, { score?: number }> } | null;
  readonly market?: Record<string, { last?: number; chg1m?: number; chg3m?: number }> | null;
  readonly flows?: { foreign5dMillion?: number; foreign20dMillion?: number; inst5dMillion?: number } | null;
  readonly events?: ReadonlyArray<{ title: string; url: string }>;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${r1(Math.abs(n))}%`;
const trillion = (million: number): string => `₩${r1(Math.abs(million) / 1_000_000)}T`;
const TIER_NAME: Readonly<Record<string, string>> = { macro: 'Macro', cycle: 'Cycle', valuation: 'Valuation', flow: 'Flow', sentiment: 'Sentiment', cross_asset_regime: 'Cross-asset' };

/** The run's dashboard.json → the card, in English, from structured fields only (votes, tiers, prices, flows). */
export function boardResultFromDashboard(d: BoardDashboard, experts: Readonly<Record<string, string>> = {}): BoardResult {
  const p = d.consensus?.panel ?? {}, m = d.consensus?.mentors ?? {}, o = d.consensus?.overall ?? {};
  const answers = [...(d.panel ?? []), ...(d.mentors ?? [])].filter((a) => a.status === 'ok');
  const nameOf = (id: string) => experts[id] ?? panelName(id);
  const voters = (action: string) => answers.filter((a) => a.action === action).map((a) => nameOf(a.id));
  const list = (names: string[]) => names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  const bull: string[] = [], bear: string[] = [];
  const buy = voters('BUY'), sell = voters('SELL');
  if (buy.length) bull.push(`BUY from ${list(buy)}`);
  if (sell.length) bear.push(`SELL from ${list(sell)}`);
  for (const [k, v] of Object.entries(d.framework?.tiers ?? {})) {
    if (typeof v.score !== 'number') continue;
    if (v.score >= 65) bull.push(`${TIER_NAME[k] ?? k} tier ${Math.round(v.score)}/100`);
    else if (v.score <= 45) bear.push(`${TIER_NAME[k] ?? k} tier ${Math.round(v.score)}/100`);
  }
  const kospi = d.market?.KOSPI;
  if (kospi && typeof kospi.chg3m === 'number') (kospi.chg3m >= 0 ? bull : bear).push(`KOSPI ${signed(kospi.chg3m)} over 3 months`);
  const f20 = d.flows?.foreign20dMillion;
  if (typeof f20 === 'number' && f20 !== 0) (f20 > 0 ? bull : bear).push(`Foreign investors net ${f20 > 0 ? 'bought' : 'sold'} ${trillion(f20)} in 20 days`);
  const usdkrw = d.market?.USDKRW;
  if (usdkrw && typeof usdkrw.chg1m === 'number' && usdkrw.chg1m > 1) bear.push(`Won weaker: USD/KRW ${signed(usdkrw.chg1m)} in 1 month`);
  const confs = answers.map((a) => a.confidence).filter((c): c is number => typeof c === 'number');
  const confidence = typeof p.confidencePct === 'number' ? p.confidencePct / 100 : confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length / 10 : 0;
  const numbers: Array<{ label: string; value: string }> = [];
  if (kospi?.last !== undefined) numbers.push({ label: 'KOSPI', value: Math.round(kospi.last).toLocaleString('en-US') });
  if (usdkrw?.last !== undefined) numbers.push({ label: 'USD/KRW', value: Math.round(usdkrw.last).toLocaleString('en-US') });
  const us10 = d.market?.US10Y;
  if (us10?.last !== undefined) numbers.push({ label: 'US10Y', value: `${us10.last.toFixed(2)}%` });
  if (typeof d.framework?.total === 'number') numbers.push({ label: 'Framework', value: `${Math.round(d.framework.total)}/100` });
  const v = p.votes ?? {};
  numbers.push({ label: 'Votes', value: `${v.BUY ?? 0}/${v.HOLD ?? 0}/${v.SELL ?? 0}` });
  const action = o.action ?? p.action ?? '?';
  const num = (n: number | undefined) => (typeof n === 'number' ? String(Math.round(n * 100) / 100) : '?');
  const thesis = `${action}. The panel leans ${p.action ?? '?'} (${num(p.score)}, ${p.n ?? answers.length} of ${p.of ?? answers.length} answered) and the mentors ${m.action ?? '?'} (${num(m.score)})${d.framework?.signal ? `; the framework score says ${d.framework.signal}` : ''}.`;
  const sources = (d.events ?? []).slice(0, 5).map((e) => ({ label: clean(e.title), url: e.url }));
  const weightOf = (a: object) => { const w = (a as { weight?: unknown }).weight; return typeof w === "number" ? w : 0.1; };
  const divergences = answers.filter((a) => a.action && a.action !== action)
    .sort((a, b) => weightOf(b) * (b.confidence ?? 5) - weightOf(a) * (a.confidence ?? 5))
    .map((a) => `${nameOf(a.id)} ${a.action} ${a.confidence ?? '?'}${typeof (a as { weight?: number }).weight === 'number' ? ` (w ${(a as { weight: number }).weight.toFixed(2)})` : ''}`);
  const consensus = typeof p.score === 'number' ? { score: p.score, action: p.action ?? action, confidencePct: Math.round(confidence * 100), answered: p.n ?? answers.length, of: p.of ?? answers.length } : undefined;
  const riskM = (d.mentors ?? []).find((m) => m.riskSource);
  const risk = riskM ? { expert: nameOf(riskM.id), pending: riskM.riskSource !== 'lecture-summary' || !riskM.risk,
    ...(riskM.risk ? { verdict: clean(riskM.risk.verdict ?? ''), maxPositionPct: riskM.risk.maxPositionPct ?? null, stop: clean(riskM.risk.stop ?? ''), hedge: clean(riskM.risk.hedge ?? '') } : {}) } : undefined;
  // Korean copy — same structured fields, Korean wording.
  const koName = (id: string): string => {
    const mm = (d.mentors ?? []).find((x) => x.id === id);
    if (mm?.name) return mm.name.replace(/\s*\(.*$/u, '');
    const pp = (d.panel ?? []).find((x) => x.id === id);
    return (pp?.label ?? nameOf(id)).replace(/\s*\(.*$/u, '').replace(/\s*⭐.*$/u, '');
  };
  const koVoters = (act: string) => answers.filter((a) => a.action === act).map((a) => koName(a.id));
  const koList = (names: string[]) => names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}명`;
  const TIER_KO: Record<string, string> = { macro: '매크로', cycle: '사이클', valuation: '밸류에이션', flow: '수급', sentiment: '심리', cross_asset_regime: '크로스에셋' };
  const kb: string[] = [], kbr: string[] = [];
  if (koVoters('BUY').length) kb.push(`매수 의견: ${koList(koVoters('BUY'))}`);
  if (koVoters('SELL').length) kbr.push(`매도 의견: ${koList(koVoters('SELL'))}`);
  for (const [k, tv] of Object.entries(d.framework?.tiers ?? {})) {
    if (typeof tv.score !== 'number') continue;
    if (tv.score >= 65) kb.push(`${TIER_KO[k] ?? k} 티어 ${Math.round(tv.score)}/100`);
    else if (tv.score <= 45) kbr.push(`${TIER_KO[k] ?? k} 티어 ${Math.round(tv.score)}/100`);
  }
  if (kospi && typeof kospi.chg3m === 'number') (kospi.chg3m >= 0 ? kb : kbr).push(`KOSPI 3개월 ${signed(kospi.chg3m)}`);
  if (typeof f20 === 'number' && f20 !== 0) (f20 > 0 ? kb : kbr).push(`외국인 20일 순${f20 > 0 ? '매수' : '매도'} ${(Math.abs(f20) / 1_000_000).toFixed(1)}조 원`);
  if (usdkrw && typeof usdkrw.chg1m === 'number' && usdkrw.chg1m > 1) kbr.push(`원화 약세: USD/KRW 1개월 ${signed(usdkrw.chg1m)}`);
  const ACT_KO: Record<string, string> = { BUY: '매수', HOLD: '보유', SELL: '매도' };
  const ak = (a: string | undefined) => ACT_KO[a ?? ''] ?? '?';
  const koThesis = `${ak(action)}. 섹터 패널 ${p.n ?? '?'}/${p.of ?? '?'}명 응답 · 가중 점수 ${num(p.score)}(${ak(p.action)}) · 캠프 전문가 ${ak(m.action)}${d.framework?.signal ? ` · 프레임워크 ${Math.round(d.framework.total ?? 0)}점 ${ak(d.framework.signal)}` : ''}.`;
  const koDiv = answers.filter((a) => a.action && a.action !== action).sort((a, b) => weightOf(b) * (b.confidence ?? 5) - weightOf(a) * (a.confidence ?? 5)).map((a) => `${koName(a.id)} ${ak(a.action ?? undefined)} ${a.confidence ?? '?'}`);
  const ko = { thesis: koThesis, bull: kb, bear: kbr, divergences: koDiv,
    ...(riskM ? { riskExpert: koName(riskM.id) } : {}), ...(riskM?.risk?.stopKo ? { stop: clean(riskM.risk.stopKo) } : {}), ...(riskM?.risk?.hedgeKo ? { hedge: clean(riskM.risk.hedgeKo) } : {}) };
  return { action, thesis, bull, bear, confidence: Math.min(1, Math.max(0, confidence)), numbers, sources, ...(consensus ? { consensus } : {}), divergences, ...(risk ? { risk } : {}), ko };
}
