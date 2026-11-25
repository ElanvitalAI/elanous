/**
 * DEMO-INVEST-SCENE-WIRE — data adapter only: the invest-orch graph run (scripts/demo-invest-orch) → InvestResearchModel.
 *   - `investRunLive(snapshot)`: while the run is going, from the node states the run observer sees (one row per panel
 *     node, the real runtime · model of each, the scene steps).
 *   - `fromInvestRun(dashboard)`: the run's `dashboard.json` (schema invest-orch.dashboard/1) → the end card.
 * The scene itself (invest-research.ts) stays composition; no I/O here. All copy is English.
 */
import type { FanoutAgent, FanoutState, Step, StepState } from '../index.js';
import type { InvestResearchModel } from './invest-research.js';

export const INVEST_DISCLAIMER = 'Research demo. Not investment advice. No order is placed.';
/** The data nodes of graphs/demo/invest-orch (they run in parallel after plan). */
export const INVEST_DATA_NODES = ['conatus-research', 'conatus-ops', 'news', 'x-pulse', 'event-shock', 'market', 'flows', 'score'] as const;

export type InvestNodeState = 'waiting' | 'running' | 'done' | 'failed';
export interface InvestLiveNode {
  readonly id: string;
  readonly state: InvestNodeState;
  readonly runtime?: string;
  readonly model?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly lastLine?: string;
}
export interface InvestLiveSnapshot {
  readonly ticker: string;
  readonly nodes: readonly InvestLiveNode[];
  readonly nowMs: number;
}

/** Short stage names of the demo's panel personas (the board's name column is 12 cells). */
const PERSONA_NAME: Readonly<Record<string, string>> = {
  'global-macro': 'Global macro', 'us-china-tech-geopol': 'US-China', 'fx-sensitivity': 'FX', 'korean-flow': 'Korea flows',
  'ai-ethics-sentiment': 'AI sentiment', 'climate-power': 'Power', 'memory-cycle': 'Memory cycle', 'hbm-ai': 'HBM / AI',
  'cross-asset-rotator': 'Cross-asset', 'dart-fundamentals': 'Fundamentals', 'soxx-flow': 'SOXX flows', 'tsmc-comparative': 'vs TSMC',
};
const ACRONYM: Readonly<Record<string, string>> = { us: 'US', fx: 'FX', ai: 'AI', hbm: 'HBM', dart: 'DART', soxx: 'SOXX', tsmc: 'TSMC', x: 'X' };
const isPanelNode = (id: string): boolean => id.startsWith('panel-') && id !== 'panel-join' || /^mentor-\d+$/u.test(id);

/** «panel-hbm-ai» → «HBM / AI» (known personas) · «panel-new-angle» → «New angle» · «mentor-2» → «Mentor 2». */
export function panelName(id: string): string {
  const known = PERSONA_NAME[id.replace(/^panel-/u, '')];
  if (known) return known;
  const words = id.replace(/^panel-/u, '').split('-').filter(Boolean).map((w) => ACRONYM[w] ?? w);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «openrouter/z-ai/glm-4.6» → «glm-4.6»; «default» and empty stay unknown. */
export function shortModel(model: string | undefined): string | undefined {
  const m = (model ?? '').trim();
  if (!m || m === 'default' || m === '-') return undefined;
  return m.split('/').filter(Boolean).at(-1);
}

const tail = (runtime: string | undefined, model: string | undefined): string | undefined => {
  const short = shortModel(model);
  return [runtime, short].filter(Boolean).join(' ') || undefined;
};

const stepState = (states: readonly InvestNodeState[]): StepState =>
  states.length > 0 && states.every((s) => s === 'done' || s === 'failed') ? 'done' : states.some((s) => s !== 'waiting') ? 'active' : 'todo';

function steps(byId: ReadonlyMap<string, InvestLiveNode>, panel: readonly InvestLiveNode[], notes: Partial<Record<string, string>> = {}): Step[] {
  const states = (ids: readonly string[]): InvestNodeState[] => ids.map((id) => byId.get(id)?.state ?? 'waiting');
  const data = states(INVEST_DATA_NODES);
  const answered = panel.filter((n) => n.state === 'done').length;
  const row = (label: string, s: InvestNodeState[], note?: string): Step => ({ label, state: stepState(s), ...(note ? { note } : {}) });
  return [
    row('Plan', states(['plan']), notes.plan),
    row('Data', data, notes.data ?? `${data.filter((s) => s === 'done' || s === 'failed').length} of ${INVEST_DATA_NODES.length} sources in parallel`),
    row('Panel', panel.map((n) => n.state), notes.panel ?? `${answered} of ${panel.length} answered in parallel`),
    row('Consensus', states(['consensus', 'conatus-judge']), notes.consensus),
    row('Decisions', states(['decision-triage']), notes.decisions),
    row('Report', states(['report']), notes.report),
  ];
}

const fanoutState = (s: InvestNodeState): FanoutState => s;

/** The scene while the run is going: panel rows with real runtime · model, the six steps, no card yet. */
export function investRunLive(snapshot: InvestLiveSnapshot): InvestResearchModel {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const panel = snapshot.nodes.filter((n) => isPanelNode(n.id));
  const running = snapshot.nodes.some((n) => n.state === 'running');
  const reportDone = byId.get('report')?.state === 'done';
  // Demo P0 (11-25 audit): a run where every agent failed must never read «✓ Graph run».
  const allFailed = panel.length > 0 && panel.every((n) => n.state === 'failed');
  return {
    title: `Investment research · ${snapshot.ticker} · ${panel.length} agents across eln, codex and claude`,
    fanout: {
      parent: { name: 'Graph run', modelTail: 'elanous graph runner', state: allFailed && !running ? 'failed' : reportDone ? 'done' : running || panel.some((n) => n.state !== 'waiting') ? 'running' : 'waiting' },
      children: panel.map((n): FanoutAgent => ({
        name: panelName(n.id),
        ...(tail(n.runtime, n.model) ? { modelTail: tail(n.runtime, n.model)! } : {}),
        state: fanoutState(n.state),
        progress: n.state === 'done' ? 1 : null,
        elapsedMs: n.startedAt === undefined ? 0 : Math.max(0, (n.endedAt ?? snapshot.nowMs) - n.startedAt),
        ...(n.lastLine ? { lastLine: n.lastLine } : {}),
      })),
    },
    steps: steps(byId, panel),
  };
}

// ── dashboard.json (invest-orch.dashboard/1) ─────────────────────────────────────────────────────────────────────────
interface DashAnswer { id: string; runtime?: string; model?: string; status?: string; action?: string | null; confidence?: number | null; durationMs?: number }
interface DashConsensusPart { score?: number; action?: string; n?: number; of?: number; votes?: { BUY?: number; HOLD?: number; SELL?: number } }
export interface InvestRunDashboard {
  readonly schema?: string;
  readonly ticker?: string;
  readonly mode?: string;
  readonly durationMs?: number;
  readonly sources?: Readonly<Record<string, string>>;
  readonly panel?: readonly DashAnswer[];
  readonly mentors?: readonly DashAnswer[];
  readonly consensus?: { panel?: DashConsensusPart; mentors?: DashConsensusPart; overall?: { score?: number; action?: string } };
  readonly framework?: { total?: number; signal?: string } | null;
  readonly decisions?: ReadonlyArray<{ id: string; mode: string }>;
  readonly events?: ReadonlyArray<{ title: string; url: string }>;
}

const num = (n: number | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '?');
const host = (url: string): string => url.replace(/^https?:\/\//u, '').replace(/^www\./u, '').replace(/\/.*$/u, '');

/** The finished run → the scene with every panel row, all six steps done, and the result card. */
export function fromInvestRun(d: InvestRunDashboard): InvestResearchModel {
  const answers = [...(d.panel ?? []), ...(d.mentors ?? [])];
  const nodes: InvestLiveNode[] = [
    { id: 'plan', state: 'done' },
    ...INVEST_DATA_NODES.map((id): InvestLiveNode => ({ id, state: d.sources?.[id] === 'missing' ? 'failed' : 'done' })),
    ...answers.map((a): InvestLiveNode => ({ id: a.id, state: a.status === 'ok' ? 'done' : 'failed',
      ...(a.runtime ? { runtime: a.runtime } : {}), ...(a.model ? { model: a.model } : {}), startedAt: 0, endedAt: a.durationMs ?? 0,
      ...(a.status === 'ok' && a.action ? { lastLine: `${a.action}${typeof a.confidence === 'number' ? ` ${a.confidence}/10` : ''}` } : { lastLine: 'no answer' }) })),
    ...['consensus', 'conatus-judge', 'decision-triage', 'report'].map((id): InvestLiveNode => ({ id, state: 'done' })),
  ];
  const live = investRunLive({ ticker: d.ticker ?? '?', nodes, nowMs: 0 });
  const p = d.consensus?.panel ?? {}, m = d.consensus?.mentors ?? {}, o = d.consensus?.overall ?? {};
  const decisions = d.decisions ?? [];
  const human = decisions.filter((x) => x.mode === 'human').length;
  const decisionNote = `${decisions.length} → ${decisions.length - human} auto · ${human} for you`;
  const sources = Object.values(d.sources ?? {});
  const recorded = sources.filter((s) => s === 'fixture' || s === 'fixture-fallback').length;
  const dataNote = `${sources.length - sources.filter((s) => s === 'missing').length} of ${INVEST_DATA_NODES.length} sources${recorded ? ` · ${recorded} recorded` : ''}`;
  const panelNote = `${answers.filter((a) => a.status === 'ok').length} of ${answers.length} answered in parallel`;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const panelNodes = nodes.filter((n) => isPanelNode(n.id));
  const v = p.votes ?? {};
  const evidence = (d.events ?? []).slice(0, 2).map((e, i) => ({ n: i + 1, label: e.title, url: host(e.url) }));
  return {
    ...live,
    fanout: { ...live.fanout, parent: { ...live.fanout.parent, state: answers.length > 0 && answers.every((a) => a.status !== 'ok') ? 'failed' : 'done' } },
    steps: steps(byId, panelNodes, {
      plan: d.mode === 'fixtures' ? 'recorded data (rehearsal)' : 'live data',
      data: dataNote,
      panel: panelNote,
      consensus: `${o.action ?? '?'} (${num(o.score)})`,
      decisions: decisionNote,
      report: d.durationMs !== undefined ? `${Math.round(d.durationMs / 100) / 10}s` : undefined,
    }),
    result: {
      title: `${d.ticker ?? '?'} · consensus ${o.action ?? '?'}`,
      subtitle: `Panel ${p.action ?? '?'} (${num(p.score)}) × mentors ${m.action ?? '?'} (${num(m.score)}) → ${o.action ?? '?'} (${num(o.score)})`,
      sections: [
        { heading: 'Panel', lines: [
          `${p.n ?? '?'} of ${p.of ?? '?'} panelists answered · BUY ${v.BUY ?? 0} · HOLD ${v.HOLD ?? 0} · SELL ${v.SELL ?? 0}`,
          ...(d.framework ? [`Framework score ${num(d.framework.total)}/100 · ${d.framework.signal ?? '?'}`] : []),
        ] },
        { heading: 'Decisions', lines: [`${decisionNote} · no order placed`] },
      ],
      ...(evidence.length ? { evidence } : {}),
      disclaimer: INVEST_DISCLAIMER,
    },
  };
}
