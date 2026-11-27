// SIDETAB-LOOP-AGENTS-UNDER-SPACE (대표 11-26 07:3x · 07:5x «루프 에이전트 = 탭 · 실제 상호작용이 탭 안에 라이브로»): REL and RES
// were absorbed into loop-agent graph triggers owned by OP. Each trigger is one read-only els tab «↻ <id>» in the space of
// the seat that holds it now (loop-tabs reconciler · `eln loop trigger tabs`), and the tab runs `eln loop trigger watch
// <id>`: a header (id · stage · owner · next fire · last result) over a timeline of fires → run → card/error.
//
// Three faces: observe = the trigger registry fire log, re-read only when the registry file changes (mtime) · judge = the
// glyph (exception = red ✕) · repair/hand-off = the tab shows the error line and the card it raised.
import { clipCells, fitCells } from './attach-view.js';
import { nextRuns } from '../domains/schedule-state.js';
import { DEFAULT_ORG } from '../org/org-map.js';
import type { FireRow } from '../loops/trigger-registry.js';

export interface LoopAgent {
  readonly id: string;
  /** The declared owner seat (REL · RES · OP · TC …). */
  readonly owner: string;
  readonly stage: string;
  readonly lastStatus: string | null;
  readonly lastAt: string | null;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly error?: string | null;
  /** OUTCOME-DONE-ALARMS: the latest outcome reading (graph_trigger_outcomes) — bad = zero/stale outcome. */
  readonly outcome?: { readonly summary: string; readonly bad: boolean };
}

export type LoopTone = 'ok' | 'idle' | 'error';
export const LOOP_MARK = '↻';
export const LOOP_GLYPH: Readonly<Record<LoopTone, string>> = { ok: '●', idle: '○', error: '✕' };

/** Green = running or done · red = exception · grey = never fired, stale-skipped, retry wait, retired. */
export function loopTone(agent: Pick<LoopAgent, 'lastStatus' | 'stage' | 'outcome'>): LoopTone {
  // A retired (absorbed) loop is grey even when its last fire was an exception — it will never fire again (LOOP-AUDIT-APPLY).
  if (agent.stage === 'retired') return 'idle';
  if (agent.lastStatus === 'exception') return 'error';
  // OUTCOME-DONE-ALARMS: «done» with a zero/stale outcome is red too.
  if (agent.outcome?.bad) return 'error';
  return agent.lastStatus === 'running' || agent.lastStatus === 'dispatched' || agent.lastStatus === 'done' ? 'ok' : 'idle';
}

/**
 * The seat a trigger is shown under. A steward seat whose every default duty now sits with another seat (REL's
 * release-supervision → OP, RES's resource-supervision → OP) was absorbed: its triggers live under that seat.
 */
export function loopHomeSeat(owner: string, duties: Readonly<Record<string, string>>, defaults: Readonly<Record<string, string>> = DEFAULT_ORG.duties): string {
  const seat = owner.trim().toUpperCase();
  const own = Object.keys(defaults).filter((duty) => defaults[duty]!.toUpperCase() === seat);
  if (own.length === 0) return seat;
  const holders = new Set(own.map((duty) => (duties[duty] ?? defaults[duty]!).toUpperCase()));
  if (holders.has(seat) || holders.size !== 1) return seat;
  return [...holders][0]!;
}

/** Group triggers by home seat (UPPERCASE) — the key the side list matches against its space names. */
export function loopsBySeat(agents: readonly LoopAgent[], duties: Readonly<Record<string, string>>, defaults?: Readonly<Record<string, string>>): Map<string, LoopAgent[]> {
  const out = new Map<string, LoopAgent[]>();
  for (const agent of agents) {
    if (agent.stage === 'retired') continue;
    const seat = loopHomeSeat(agent.owner, duties, defaults);
    out.set(seat, [...(out.get(seat) ?? []), agent]);
  }
  return out;
}

const ago = (iso: string | null, now: number): string => {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '—';
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return min < 60 ? `${min}m` : min < 48 * 60 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
};
const hhmm = (iso: string, timeZone?: string): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));

/** «next 07:45» for a cron trigger, «on cond» for a condition trigger. */
export function loopNext(agent: LoopAgent, now: number): string {
  if (!agent.cron) return 'on cond';
  const next = nextRuns(agent.cron, new Date(now), 1, agent.timeZone ? { timeZone: agent.timeZone } : undefined)[0];
  return next ? `next ${hhmm(next, agent.timeZone)}` : '';
}

/**
 * The loop-tabs reconciler's plan (대표 11-26 11:1x «OP 스페이스에 루프 탭이 너무 많다»): every space with live triggers gets ONE
 * read-only tab «↻ loops (N)» (the list view · Enter opens one loop's watch inside it). Per-loop tabs «↻ <id>» the reconciler
 * opened before are closed (it owns them); a list tab whose count is stale, whose space has no loops left, or that is a
 * duplicate is closed and the right one opened.
 */
export interface LoopTabPane { readonly tab: string; readonly title: string; readonly workspace: string }
export interface LoopTabsPlan { open: { ws: string; count: number }[]; close: { tab: string; id: string }[] }
export function planLoopTabs(bySeat: ReadonlyMap<string, readonly LoopAgent[]>, panes: readonly LoopTabPane[]): LoopTabsPlan {
  const want = new Map<string, number>();
  for (const [seat, agents] of bySeat) if (agents.length) want.set(seat.toUpperCase(), agents.length);
  const have = new Set<string>();
  const close: { tab: string; id: string }[] = [];
  const closing = new Set<string>();
  const drop = (tab: string, id: string): void => { if (!closing.has(tab)) { closing.add(tab); close.push({ tab, id }); } };
  for (const pane of panes) {
    const id = isLoopTabTitle(pane.title);
    if (id) { drop(pane.tab, id); continue; }
    const count = loopsListCount(pane.title);
    if (count === undefined) continue;
    const ws = pane.workspace.toUpperCase();
    if (want.get(ws) !== count || have.has(ws)) drop(pane.tab, 'loops');
    else have.add(ws);
  }
  return { open: [...want].filter(([ws]) => !have.has(ws)).map(([ws, count]) => ({ ws, count })), close };
}

export const loopTabTitle = (id: string): string => `${LOOP_MARK} ${id}`;
/** The one list tab of a space: «↻ loops (N)». */
export const loopsListTitle = (count: number): string => `${LOOP_MARK} loops (${count})`;
const stripBadge = (title: string): string => title.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
/** N of a list tab title «↻ loops (N)» (a trailing «[build …]» badge is ignored), else undefined. */
export const loopsListCount = (title: string): number | undefined => {
  const hit = /^↻ loops \((\d+)\)$/.exec(stripBadge(title));
  return hit ? Number(hit[1]) : undefined;
};
/** The trigger id of a per-loop tab title «↻ <id>» (a trailing «[build …]» badge the server adds is ignored), else undefined. The list tab is not a per-loop tab. */
export const isLoopTabTitle = (title: string): string | undefined => title.startsWith(`${LOOP_MARK} `) && loopsListCount(title) === undefined ? stripBadge(title.slice(LOOP_MARK.length + 1)) || undefined : undefined;

const RED = '\u001b[31m', GREEN = '\u001b[32m', DIM = '\u001b[2m', OFF = '\u001b[0m';
const toneColour: Readonly<Record<LoopTone, string>> = { ok: GREEN, idle: DIM, error: RED };
const clock = (iso: string | null, timeZone?: string): string => iso && Number.isFinite(Date.parse(iso)) ? hhmm(iso, timeZone) : '--:--';

/**
 * The loop tab's screen (each line at most `width` cells, CJK-safe): a header, then the newest fires first, each one
 * «● 07:44 done · run r-12 · checked 07:46» with its error / card on the line under it.
 */
/** One graph node step of a fire's run (from graph-runs/<graph>/<runId>.json `nodes`). */
export interface LoopRunNode { readonly nodeId: string; readonly ok?: boolean; readonly exit?: number; readonly seconds?: number; readonly output?: string; readonly running?: boolean }

/** The node steps of a run state file's JSON (unreadable = none); the node it is on now shows as running. */
export function runNodesOf(runJson: string): LoopRunNode[] {
  try {
    const run = JSON.parse(runJson) as { status?: unknown; path?: unknown; nodes?: unknown };
    const nodes = Array.isArray(run.nodes) ? run.nodes as Record<string, unknown>[] : [];
    const out: LoopRunNode[] = nodes.filter((node) => typeof node.nodeId === 'string').map((node) => ({ nodeId: String(node.nodeId),
      ...(typeof node.ok === 'boolean' ? { ok: node.ok } : {}), ...(typeof node.exit === 'number' ? { exit: node.exit } : {}),
      ...(typeof node.seconds === 'number' ? { seconds: node.seconds } : {}), ...(typeof node.output === 'string' ? { output: node.output } : {}) }));
    const path = Array.isArray(run.path) ? run.path.filter((one): one is string => typeof one === 'string') : [];
    const at = path[path.length - 1];
    if (run.status === 'running' && at && !out.some((node) => node.nodeId === at)) out.push({ nodeId: at, running: true });
    return out;
  } catch { return []; }
}

/** «outcome=turn · delivered=inbox» — the scalar fields of a node's JSON output (outcome first), or its first line. */
export function nodeOutputSummary(output: string | undefined): string {
  if (!output) return '';
  try {
    const value = JSON.parse(output) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .sort(([a], [b]) => (a === 'outcome' ? -1 : b === 'outcome' ? 1 : 0));
      return entries.map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ')}`).join(' · ');
    }
  } catch { /* plain text */ }
  return output.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** The fires that get their node steps drawn (the newest few — older ones stay one line each). */
export const LOOP_STEP_FIRES = 3;

export function loopTabLines(agent: LoopAgent, fires: readonly FireRow[], now: number, width: number, colour = true, runs: ReadonlyMap<string, readonly LoopRunNode[]> = new Map()): string[] {
  const fit = (text: string): string => clipCells(text, Math.max(1, width));
  const paint = (tone: LoopTone, text: string): string => colour ? `${toneColour[tone]}${text}${OFF}` : text;
  const tone = loopTone(agent);
  const out = [
    paint(tone, fit(`${LOOP_GLYPH[tone]} ${loopTabTitle(agent.id)} · ${agent.stage} · owner ${agent.owner}`)),
    fit(`  trigger ${agent.cron ?? 'condition'} · ${loopNext(agent, now) || 'next —'} · last ${agent.lastStatus ?? '—'} ${ago(agent.lastAt, now)}`),
    fit('  read-only · typing is ignored'),
    fit('─'.repeat(Math.max(1, width))),
  ];
  if (fires.length === 0) out.push(fit('  (no fires yet)'));
  for (const fire of fires) {
    const t = loopTone({ lastStatus: fire.status, stage: fire.stage });
    const parts = [fire.status, ...(fire.attempt > 1 ? [`attempt ${fire.attempt}`] : []), ...(fire.runId ? [`run ${fire.runId}`] : []), ...(fire.checkAt ? [`check ${clock(fire.checkAt, agent.timeZone)}`] : []), ...(fire.nextRetryAt ? [`retry ${clock(fire.nextRetryAt, agent.timeZone)}`] : [])];
    out.push(paint(t, fit(`${LOOP_GLYPH[t]} ${clock(fire.dispatchedAt ?? fire.window, agent.timeZone)} ${parts.join(' · ')}`)));
    const steps = fire.runId && fires.indexOf(fire) < LOOP_STEP_FIRES ? runs.get(fire.runId) ?? [] : [];
    steps.forEach((node, at) => {
      const branch = at === steps.length - 1 && !fire.error && !fire.card ? '└' : '├';
      const mark = node.running ? '…' : node.ok === false ? '✕' : '✓';
      const what = [node.nodeId, ...(node.running ? ['running'] : []), ...(node.ok === false && node.exit !== undefined ? [`exit ${node.exit}`] : []), ...(node.seconds !== undefined ? [`${node.seconds.toFixed(1)}s`] : [])].join(' ');
      const summary = nodeOutputSummary(node.output);
      out.push(paint(node.ok === false ? 'error' : node.running ? 'ok' : 'idle', fit(`    ${branch} ${mark} ${what}${summary ? ` · ${summary}` : ''}`)));
    });
    if (fire.error) out.push(paint('error', fit(`    ✕ ${fire.error}`)));
    if (fire.card) out.push(fit(`    ✉ card ${fire.card}`));
  }
  return out;
}

// ── Side list heartbeat rows (대표 11-26 08:0x pick: «↻ pulse      ▁▃▁▅▁▇ 3m») ──────────────────────────────────────────

const SHORT: Readonly<Record<string, string>> = {
  'board-steward': 'board', 'res-burst-lease': 'res-lease', 'res-ready-pool': 'res-pool', 'space-advisor-tc': 'advisor',
};
/** The short side-list name (대표 11-26): pulse · bulletin · board · retro · idle-triage · release-rocket · res-lease · res-pool · advisor … */
export const loopShortName = (id: string): string => SHORT[id] ?? id.replace(/^op-/, '');

/** One loop's side-list facts: fires per 10-minute bucket over the last hour (oldest first), last fire, tone, firing now. */
export interface LoopFacts { readonly buckets: readonly number[]; readonly lastAt: string | null; readonly tone: LoopTone; readonly firing: boolean; /** Home seat (UPPERCASE) — the space whose «↻ loops (N)» tab lists it. */ readonly seat?: string }
export const SPARK_CELLS = 6;
const SPARK = '▁▂▃▄▅▆▇';

/** Bucket fire instants (ms) into SPARK_CELLS × 10 min ending at `now`. */
export function fireBuckets(fireAtMs: readonly number[], now: number): number[] {
  const out = Array.from({ length: SPARK_CELLS }, () => 0);
  for (const at of fireAtMs) {
    const back = Math.floor((now - at) / 600_000);
    if (back >= 0 && back < SPARK_CELLS) out[SPARK_CELLS - 1 - back]!++;
  }
  return out;
}
export function sparkline(buckets: readonly number[]): string {
  const top = Math.max(1, ...buckets);
  return buckets.map((n) => SPARK[n === 0 ? 0 : Math.max(1, Math.round((n / top) * (SPARK.length - 1)))]!).join('');
}

const RED_ON = '\u001b[31m', RED_OFF = '\u001b[39m';
/** SIDETAB-POLISH-1126 (대표 11-26 «하트비트 막대 없이»): the dot that marks a loop in exception — red when coloured. */
export const LOOP_ERROR_DOT = '●';
/**
 * One loop row of the side list, exactly `width` display cells: «  ↻ pulse            3m» — the name and the time since the
 * last fire («now» while firing, «—» never fired). No heartbeat bars. A loop in exception leads with a red dot instead of «↻».
 * The name gives way first.
 */
export function heartbeatRow(id: string, facts: LoopFacts | undefined, now: number, width: number, colour = true): string {
  const error = facts?.tone === 'error';
  const right = facts?.firing ? 'now' : ago(facts?.lastAt ?? null, now);
  const lead = error ? `  ${LOOP_ERROR_DOT} ` : `  ${LOOP_MARK} `;
  const tail = ` ${right.padStart(3)}`;
  const room = width - Bun.stringWidth(lead) - Bun.stringWidth(tail);
  if (room < 1) return fitCells(`${lead}${loopShortName(id)}`, width);
  const name = loopShortName(id);
  const shown = Bun.stringWidth(name) <= room ? name : `${clipCells(name, Math.max(0, room - 1))}…`;
  const gap = ' '.repeat(room - Bun.stringWidth(shown));
  if (!colour || !error) return `${lead}${shown}${gap}${tail}`;
  return `  ${RED_ON}${LOOP_ERROR_DOT}${RED_OFF} ${shown}${gap}${tail}`;
}

/** The «↻ loops» sub-header under a space's seats (⌄ open · › folded). */
export const loopsSubHead = (count: number, folded: boolean, errors = 0): string => ` ${folded ? '›' : '⌄'} ${LOOP_MARK} loops ${count}${errors ? ` ✖${errors}` : ''}`;
/** 대표 11-26: a group of more than three loops starts folded (its counts stay on the header); three or fewer stay open. */
export const loopsFoldedByDefault = (count: number): boolean => count > 3;
export const loopFoldKey = (ws: string): string => `loops:${ws}`;

export interface LoopFactsSource { readonly facts: () => ReadonlyMap<string, LoopFacts> }
/**
 * The side list's cached registry read: one read-only SELECT pair per ≥10 s, skipped when the registry file did not change
 * (mtime). Memory only between reads; a missing or locked registry = the last snapshot (or none), never a throw.
 */
export function createLoopFactsSource(registryPath: string, opts: { readonly ttlMs?: number; readonly now?: () => number; readonly duties?: () => Readonly<Record<string, string>> } = {}): LoopFactsSource {
  const duties = opts.duties ?? ((): Readonly<Record<string, string>> => {
    try { return (require('../org/org-map.js') as typeof import('../org/org-map.js')).loadOrgMap().org.duties; } catch { return DEFAULT_ORG.duties; }
  });
  const ttl = Math.max(10_000, opts.ttlMs ?? 10_000);
  const now = opts.now ?? Date.now;
  let at = -Infinity, stamp = '';
  let snapshot: ReadonlyMap<string, LoopFacts> = new Map();
  return {
    facts: () => {
      const t = now();
      if (t - at < ttl) return snapshot;
      at = t;
      try {
        const { statSync } = require('node:fs') as typeof import('node:fs');
        const next = [registryPath, `${registryPath}-wal`].map((one) => { try { return String(statSync(one).mtimeMs); } catch { return '-'; } }).join('|') + `|${Math.floor(t / 60_000)}`;
        if (next === stamp) return snapshot;
        stamp = next;
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(registryPath, { readonly: true });
        try {
          const since = new Date(t - SPARK_CELLS * 600_000).toISOString();
          const fires = db.query('SELECT graph_id, window, dispatched_at FROM graph_trigger_fires WHERE window >= ?').all(since) as { graph_id: string; window: string; dispatched_at: string | null }[];
          const rows = db.query(`SELECT r.graph_id AS graph_id, r.stage AS stage, r.decl_json AS decl_json,
              (SELECT status FROM graph_trigger_fires f WHERE f.graph_id = r.graph_id ORDER BY window DESC LIMIT 1) AS last_status,
              (SELECT updated_at FROM graph_trigger_fires f WHERE f.graph_id = r.graph_id ORDER BY window DESC LIMIT 1) AS last_at
            FROM graph_trigger_registry r`).all() as { graph_id: string; stage: string; decl_json: string | null; last_status: string | null; last_at: string | null }[];
          const out = new Map<string, LoopFacts>();
          const held = duties();
          const ownerOf = (decl: string | null): string | undefined => { try { const owner = (JSON.parse(decl ?? '') as { owner?: unknown }).owner; return typeof owner === 'string' && owner.trim() ? owner : undefined; } catch { return undefined; } };
          for (const row of rows) {
            const mine = fires.filter((fire) => fire.graph_id === row.graph_id).map((fire) => Date.parse(fire.dispatched_at ?? fire.window)).filter(Number.isFinite);
            const owner = ownerOf(row.decl_json);
            out.set(row.graph_id, { buckets: fireBuckets(mine, t), lastAt: row.last_at, tone: loopTone({ stage: row.stage, lastStatus: row.last_status }), firing: row.last_status === 'running' || row.last_status === 'dispatched',
              ...(owner && row.stage !== 'retired' ? { seat: loopHomeSeat(owner, held) } : {}) });
          }
          snapshot = out;
        } finally { db.close(); }
      } catch { /* keep the last snapshot */ }
      return snapshot;
    },
  };
}

/**
 * SIDETAB-LOOP-AGENTS-FU (red dot): a loop tab's pane state follows its trigger — exception = failed (red in the side list,
 * the tab row and tile mode), firing = working, otherwise idle. The space's «↻ loops (N)» tab is red when ANY loop of that
 * space is in exception, working when one is firing. Every other pane is untouched.
 */
export function withLoopStates<T extends { readonly title: string; readonly state: string; readonly workspace?: string }>(rows: readonly T[], facts: ReadonlyMap<string, LoopFacts> | undefined): T[] {
  if (!facts || facts.size === 0) return [...rows];
  return rows.map((row) => {
    if (row.state === 'exited') return row;
    if (loopsListCount(row.title) !== undefined) {
      const seat = row.workspace?.toUpperCase();
      const mine = seat ? [...facts.values()].filter((fact) => fact.seat === seat) : [];
      if (mine.length === 0) return row;
      return { ...row, state: mine.some((fact) => fact.tone === 'error') ? 'failed' : mine.some((fact) => fact.firing) ? 'working' : 'idle' };
    }
    const id = isLoopTabTitle(row.title);
    const fact = id ? facts.get(id) : undefined;
    if (!fact) return row;
    return { ...row, state: fact.tone === 'error' ? 'failed' : fact.firing ? 'working' : 'idle' };
  });
}

// ── The space's one loop tab «↻ loops (N)» (대표 11-26 11:1x · `eln loop trigger loops <space>`) ─────────────────────────

/** One row of the list tab: the loop, its last fire, and its fire instants (ms) for the heartbeat. */
export interface LoopListEntry { readonly agent: LoopAgent; readonly fireAtMs: readonly number[] }

/**
 * The list tab's screen (each line at most `width` cells): a header with a red dot when any loop is in exception, then one
 * line per loop «› ● op-pulse   ▁▃▁▅▁▇  3m · done · next 07:45» — the dot is red on exception. `selected` = the cursor row.
 */
export function loopsListLines(space: string, entries: readonly LoopListEntry[], selected: number, now: number, width: number, colour = true): string[] {
  const fit = (text: string): string => clipCells(text, Math.max(1, width));
  const paint = (tone: LoopTone, text: string): string => colour ? `${toneColour[tone]}${text}${OFF}` : text;
  const tones = entries.map((entry) => loopTone(entry.agent));
  const errors = tones.filter((tone) => tone === 'error').length;
  const headTone: LoopTone = errors ? 'error' : tones.includes('ok') ? 'ok' : 'idle';
  const out = [
    paint(headTone, fit(`● ${loopsListTitle(entries.length)} · ${space.toUpperCase()}${errors ? ` · ${errors} in exception` : ''}`)),
    fit('  read-only · ↑↓ select · Enter watch · Ctrl-C in a watch = back to this list'),
    fit('─'.repeat(Math.max(1, width))),
  ];
  if (entries.length === 0) out.push(fit('  (no loops in this space)'));
  const nameCells = Math.min(24, Math.max(0, ...entries.map((entry) => Bun.stringWidth(entry.agent.id))));
  entries.forEach((entry, at) => {
    const { agent } = entry;
    const tone = tones[at]!;
    const name = agent.id + ' '.repeat(Math.max(0, nameCells - Bun.stringWidth(agent.id)));
    const spark = sparkline(fireBuckets(entry.fireAtMs, now));
    const tail = [`${ago(agent.lastAt, now).padStart(3)}`, agent.lastStatus ?? 'never fired', ...(agent.outcome ? [`${agent.outcome.bad ? '⚠ ' : ''}${agent.outcome.summary}`] : []),
      ...(agent.stage !== 'live' ? [agent.stage] : []), loopNext(agent, now) || 'next —'].join(' · ');
    const cursor = at === selected ? '›' : ' ';
    const text = fit(`${cursor} ● ${name} ${spark} ${tail}`);
    if (!colour) { out.push(text); return; }
    // only the dot carries the tone (red = exception); the cursor «›» marks the selected row
    out.push(text.replace('●', `${toneColour[tone]}●${OFF}`));
  });
  return out;
}
