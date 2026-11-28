// FED-ANALYST-LOOP-AGENT — the live readers (each fails open to null = «?», never 0) ⊕ the analyst ledger / NOW file / cases.
// Inputs = the msg store window (the same rows the 30-min chat-log collector saves) ⊕ the fed-state ledger (fed kpi at the
// window end) ⊕ the throughput controller row ⊕ open ✋ ⊕ the trigger registry ⊕ the active board. A recorded chat-log
// folder (`--mail <dir>/mail.jsonl --panes <dir>/screens/panes.tsv`) replaces the live mail/pane readers — that is how the
// loop agent is checked against the Claude analyst's windows.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { type Analysis, type AnalystLists, type AnalystNumbers, DEFAULT_LISTS, DEFAULT_NUMBERS, type Inputs, type MailRow } from './analyze.js';

const req = <T>(p: string): T => require(p) as T;

export const POLICY_FILE = join(import.meta.dir, '..', '..', 'graphs', 'policies', 'fed-analyst.yaml');
export const AGENT_YAML = join(import.meta.dir, '..', '..', 'graphs', 'loop-agents', 'fed-analyst', 'agent.yaml');

/** Lists from graphs/policies/fed-analyst.yaml (missing keys → defaults in analyze.ts). */
export function loadLists(path = POLICY_FILE): AnalystLists & { collectorSeats: readonly string[] } {
  let j: Record<string, unknown> = {};
  try { j = (parse(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {}; } catch { /* defaults */ }
  const arr = (k: string, d: readonly string[]): readonly string[] => (Array.isArray(j[k]) ? (j[k] as unknown[]).filter((x): x is string => typeof x === 'string') : d);
  return {
    coordinators: arr('coordinators', DEFAULT_LISTS.coordinators),
    machineSenders: arr('machine_senders', DEFAULT_LISTS.machineSenders),
    agentSenders: arr('agent_senders', DEFAULT_LISTS.agentSenders),
    notDormant: arr('not_dormant', DEFAULT_LISTS.notDormant),
    handPrefixes: arr('hand_prefixes', DEFAULT_LISTS.handPrefixes),
    collectorSeats: arr('collector_seats', []),
  };
}

/** Numbers from agent.yaml `policies:` (the CLI path · the tick path reads them through pv()). */
export function loadNumbers(path = AGENT_YAML): AnalystNumbers {
  try {
    const p = ((parse(readFileSync(path, 'utf8')) as { policies?: Record<string, unknown> })?.policies ?? {});
    const out: Record<string, number> = { ...DEFAULT_NUMBERS };
    for (const k of Object.keys(DEFAULT_NUMBERS)) if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k] as number;
    return out as unknown as AnalystNumbers;
  } catch { return DEFAULT_NUMBERS; }
}

export function readMailJsonl(path: string): MailRow[] {
  return readFileSync(path, 'utf8').split('\n').flatMap(l => { if (!l.trim()) return []; try { return [JSON.parse(l) as MailRow]; } catch { return []; } });
}
/** screens/panes.tsv of a chat-log folder (workspace \t title \t state) → titles. */
export function readPanesTsv(path: string): Set<string> {
  return new Set(readFileSync(path, 'utf8').split('\n').map(l => l.split('\t')[1]?.trim() ?? '').filter(Boolean));
}

export interface GatherOpts {
  readonly at?: Date;
  readonly windowMin?: number;
  /** recorded chat-log rows instead of the msg store */
  readonly mailFile?: string;
  readonly panesFile?: string;
  readonly instanceRoot?: string;
  readonly hqRoot?: string;
  readonly lists?: AnalystLists & { collectorSeats: readonly string[] };
}

// the resolver only (test ↔ prod isolation): instance root, else the state-root resolver — never a literal home path
const instanceRootLive = (): string => { try { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').effectiveInstanceRoot(); } catch { return req<typeof import('../autopilot/state-paths.js')>('../autopilot/state-paths.js').elanousStateRoot(); } };

export async function gatherInputs(o: GatherOpts = {}): Promise<{ inputs: Inputs; unread: string[] }> {
  const end = o.at ?? new Date();
  const winMin = o.windowMin ?? DEFAULT_NUMBERS.window_min;
  const start = new Date(end.getTime() - winMin * 60_000);
  const root = o.instanceRoot ?? instanceRootLive();
  const lists = o.lists ?? loadLists();
  const unread: string[] = [];
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/gu, ' ').slice(0, 80);

  // panes (live = fed snapshot seats with a pane · recorded = panes.tsv)
  let panes: Set<string> | null = null;
  try {
    if (o.panesFile) panes = readPanesTsv(o.panesFile);
    else {
      const snap = JSON.parse(readFileSync(join(root, 'fed-state', 'snapshots', 'latest.json'), 'utf8')) as { seats?: Array<{ seat: string; pane?: string | null }> };
      panes = new Set((snap.seats ?? []).filter(s => s.pane && s.pane !== 'NO-PANE').map(s => s.seat));
    }
  } catch (e) { unread.push(`panes(${why(e)})`); }

  // mail rows — recorded window, else the msg store [start, end) restricted to what the collector reads (seats ∪ panes)
  let mails: MailRow[] = [];
  try {
    if (o.mailFile) mails = readMailJsonl(o.mailFile);
    else {
      const { openMsgStoreReadOnly, defaultMsgStorePath } = req<typeof import('../msg/msg-store.js')>('../msg/msg-store.js');
      const store = openMsgStoreReadOnly(defaultMsgStorePath());
      try {
        const want = new Set([...lists.collectorSeats, ...(panes ?? [])]);
        mails = store.listCreatedBetween(start.toISOString(), end.toISOString())
          .filter(m => !want.size || want.has(m.to))
          .map(m => ({ id: m.id, from: m.from, to: m.to, kind: m.kind ?? '', createdAt: m.createdAt, body: (m.body ?? '').slice(0, 600) }));
      } finally { store.close(); }
    }
  } catch (e) { unread.push(`mail(${why(e)})`); }

  // dormant table (kit/mail-route hand-routes.yaml dormant.routes ⊕ resourceAddresses)
  let dormantTable: string[] = [];
  try {
    const t = req<typeof import('../kit/mail-route/hand-routes.js')>('../kit/mail-route/hand-routes.js').readHandRoutes().dormant;
    dormantTable = [...new Set([...Object.keys(t.routes), ...t.resourceAddresses])];
  } catch (e) { unread.push(`dormant-table(${why(e)})`); }

  // fed kpi at the window end (1 h · and the window)
  let kpi1h: Inputs['kpi1h'] = null; let kpiWin: Inputs['kpiWin'] = null;
  try {
    const { fedKpi } = req<typeof import('../fed-state/kpi.js')>('../fed-state/kpi.js');
    const k1 = fedKpi({ window: '1h', now: end });
    kpi1h = { landedPerHour: k1.landedPerHour, idleWithWorkHands: k1.idleWithWorkHands, idleWithWorkSeats: k1.idleWithWorkSeats, greens: k1.aux.greens };
    const kw = fedKpi({ window: `${winMin}m`, now: end });
    kpiWin = { claims: kw.aux.claims, greens: kw.aux.greens };
  } catch (e) { unread.push(`fed-kpi(${why(e)})`); }

  // throughput controller — the newest row at or before the window end
  let throughput: Inputs['throughput'] = null;
  try {
    const p = join(root, 'loops', 'throughput-controller.jsonl');
    const rows = existsSync(p) ? tailLines(p, 256 * 1024) : [];
    // the row measured at the window end: the first one ≤ 5 min after it (a pulse measured at the window close — what the
    // Claude analyst quoted), else the newest one ≤ 20 min before it · older = stale → fed kpi numbers, lever unread
    type TpRow = { at: string; verdict: string; lever: string; lands?: number; greens?: number };
    const parsed = rows.flatMap(l => { try { const r = JSON.parse(l) as TpRow; return r && typeof r.verdict === 'string' && typeof r.lever === 'string' && Number.isFinite(Date.parse(r.at)) ? [r] : []; } catch { return []; } }); // action rows (key · do) are not verdicts
    const e = end.getTime();
    const after = parsed.filter(r => Date.parse(r.at) > e && Date.parse(r.at) - e <= 5 * 60_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    const before = parsed.filter(r => Date.parse(r.at) <= e && e - Date.parse(r.at) <= 20 * 60_000).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const best: TpRow | null = after ?? before ?? null;
    if (best) {
      const { LEVERS } = req<typeof import('../loops/throughput-controller.js')>('../loops/throughput-controller.js');
      const lever = Object.values(LEVERS).find(x => x.id === best!.lever);
      throughput = { verdict: best.verdict, lever: best.lever, owner: lever ? lever.owner.split(/\s*[·→]\s*/u)[0]!.trim() || null : null, lands: typeof best.lands === 'number' ? best.lands : null, greens: typeof best.greens === 'number' ? best.greens : null };
    } else unread.push('throughput(no row within 20 min of the window end)');
  } catch (e) { unread.push(`throughput(${why(e)})`); }

  // open ✋ (hand-raise-ladder openHands · `asOf` for a past window)
  let hands: Inputs['hands'] = null;
  try {
    const { openMsgStoreReadOnly, defaultMsgStorePath } = req<typeof import('../msg/msg-store.js')>('../msg/msg-store.js');
    const { openHands } = req<typeof import('../msg/hand-raise-ladder.js')>('../msg/hand-raise-ladder.js');
    const store = openMsgStoreReadOnly(defaultMsgStorePath());
    try {
      // point in time: a past window (--at) sees the hands as they stood then · now = the same as the world card
      hands = openHands(store, { now: end.getTime(), asOf: Date.now() - end.getTime() > 60_000 })
        .map(h => ({ id: h.id, from: h.sender, to: h.receiver, reason: h.reason, waitedMin: Math.round(h.waitedMs / 60_000) }));
    } finally { store.close(); }
  } catch (e) { unread.push(`hands(${why(e)})`); }

  // loops — trigger registry exceptions
  let loops: Inputs['loops'] = null;
  try {
    const reg = req<typeof import('../loops/trigger-registry.js')>('../loops/trigger-registry.js');
    const db = reg.openTriggerRegistry(root);
    try {
      const rows = reg.listLiveTriggers(db);
      loops = { total: rows.length, exceptions: rows.filter(t => t.lastStatus === 'exception').map(t => ({ id: t.graphId, owner: t.owner || null, at: t.lastAt })) };
    } finally { db.close(); }
  } catch (e) { unread.push(`loops(${why(e)})`); }

  // active board
  let board: Inputs['board'] = null;
  try {
    const hqRoot = o.hqRoot ?? join(homedir(), 'elanous-hq');
    const { resolveCurrentVersion } = req<typeof import('../ops-dashboard/current-version.js')>('../ops-dashboard/current-version.js');
    const { listChecklist } = req<typeof import('../release-loop/checklist.js')>('../release-loop/checklist.js');
    const ledgerRoot = (() => { try { return req<typeof import('../instance/resolve.js')>('../instance/resolve.js').releaseLedgerRoot(); } catch { return undefined; } })();
    const version = resolveCurrentVersion({ hqRoot, ...(ledgerRoot ? { ledgerRoot } : {}) }).version;
    const items = listChecklist(version, ledgerRoot).items;
    board = { version, total: items.length, green: items.filter(i => i.status === 'green').length, done: items.filter(i => i.status === 'done').length,
      p0Yellow: items.filter(i => i.priority === 'P0' && i.status === 'yellow').length };
  } catch (e) { unread.push(`board(${why(e)})`); }

  return { inputs: { windowStart: start, windowEnd: end, mails, panes, dormantTable, kpi1h, kpiWin, throughput, hands, loops, board }, unread };
}

function tailLines(path: string, bytes: number): string[] {
  const text = readFileSync(path, 'utf8');
  return text.slice(Math.max(0, text.length - bytes)).split('\n').filter(Boolean);
}

// ── outputs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const analystLedgerPath = (root: string): string => join(root, 'loops', 'fed-analyst.jsonl');
export const analystNowPath = (hqRoot: string = join(homedir(), 'elanous-hq')): string => join(hqRoot, 'seat-state', 'OP', 'pulse', 'FED-ANALYST-NOW.md');

export interface AnalystRow {
  readonly at: string; readonly windowStart: string; readonly windowEnd: string;
  readonly passed: number; readonly bottleneck: string;
  readonly numbers: Record<string, number | string | null>;
  readonly findings: Analysis['findings'];
  readonly lines: string[];
  readonly prose: { model: string | null; used: boolean; why: string };
  readonly unread: string[];
}

export function analystNumbers(a: Analysis): Record<string, number | string | null> {
  const t = a.topology;
  return {
    mails: t.mails, opInboundPerH: t.opInboundPerH, machineRatioPct: t.machineRatioPct, handToTcPerH: t.handToTcPerH,
    badEdges: t.badEdges.length, dormantEdges: t.dormantEdges.length, coordEigenMax: t.coordEigenMax ? `${t.coordEigenMax.seat} ${t.coordEigenMax.value}` : null,
    passed: a.passed,
  };
}

/** Append the row (JSONL) and rewrite the NOW file (atomic). Returns false when either write failed (fail-soft). */
export function writeAnalysis(root: string, row: AnalystRow, nowFile: string | null = analystNowPath()): boolean {
  let ok = true;
  try { mkdirSync(dirname(analystLedgerPath(root)), { recursive: true }); appendFileSync(analystLedgerPath(root), `${JSON.stringify(row)}\n`); } catch { ok = false; }
  if (nowFile) try {
    mkdirSync(dirname(nowFile), { recursive: true });
    const tmp = `${nowFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${row.lines.join('\n')}\n\n_written ${row.at} by loop:fed-analyst · prose ${row.prose.used ? `LLM ${row.prose.model}` : `template (${row.prose.why})`}${row.unread.length ? ` · unread: ${row.unread.join(', ')}` : ''}_\n`);
    renameSync(tmp, nowFile);
  } catch { ok = false; }
  return ok;
}

/** The newest analyst row (the OP world card line · the voice). */
export function latestAnalysis(root: string): AnalystRow | null {
  const p = analystLedgerPath(root);
  if (!existsSync(p)) return null;
  const lines = tailLines(p, 512 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]!) as AnalystRow; } catch { /* torn */ } }
  return null;
}

/** kit/case-ledger: a breached finding with an owner = an open case (idempotent) · a finding that reads ok = resolved. */
export const CASE_DOMAIN = 'fed-analyst';
export function syncCases(root: string, a: Analysis, now: Date, slaMin: number): { opened: string[]; resolved: string[] } {
  const ck = req<typeof import('../kit/case-ledger/index.js')>('../kit/case-ledger/index.js');
  const opened: string[] = []; const resolved: string[] = [];
  for (const f of a.findings) {
    const id = `fed:${f.key}`;
    if (f.status === 'breach' && f.action) {
      const c = ck.openCase(root, { domain: CASE_DOMAIN, id, subject: `${f.title}: ${f.facts}`.slice(0, 300), owner: f.action.who, slaMin, by: 'loop:fed-analyst', why: `${f.action.what} · 재확인 ${f.action.recheckAt}(${f.action.criterion})`.slice(0, 300) }, now);
      if (c && c.detectedAt === now.toISOString()) opened.push(id);
    } else if (f.status === 'ok') {
      const cur = ck.readCases(root, CASE_DOMAIN).find(x => x.id === id);
      if (cur && cur.state !== 'resolved' && ck.moveCase(root, CASE_DOMAIN, id, 'resolved', { by: 'loop:fed-analyst', why: `정상 관측: ${f.facts}`.slice(0, 300) }, now)) resolved.push(id);
    }
  }
  return { opened, resolved };
}
