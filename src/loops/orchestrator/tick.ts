import { withFileLockSync } from '../../storage/file-lock.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CardStore, taskCardsDir, type TaskCard } from '../../task-cards/card-store.js';
import { Database } from 'bun:sqlite';
import { type ChecklistItem } from '../../release-loop/checklist.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { listSelfDevRuns, runSummaryLine, selfDevRunsDir } from '../../self-dev/run-store.js';

export type Window = '08' | '12' | '18';
export type Node = 'intake' | 'split' | 'place' | 'delegate' | 'reconcile' | 'report';
export type Mode = 'off' | 'shadow' | 'live';
const SEAT_LOOP_IDS: Readonly<Record<string, string>> = { OP: 'op-seat', MK: 'cmo-seat', TC: 'tc-seat', UX: 'ux-seat' };
export interface Cell { id: string; title: string; seat?: string; host?: string; version?: string; cardId: string; origin: 'candidate' | 'flow1a'; priority?: 'P0' | 'P1' | 'P2'; predecessors?: string[] }
export interface TickState {
  runId: string; window: Window; mode: Mode; day: string;
  cards: TaskCard[]; skippedCards: Array<{ id: string; reason: string }>; cells: Cell[]; placed: number; unplaced?: number; delegated: number; wouldDelegate: number; rebalanced?: number;
  reconciled: { reached: number; progressing: number; blocked: number; unknown: number };
  runSummaries?: string[];
  nodes: Partial<Record<Node, 'ok' | 'skipped'>>;
  missing: string[];
}
/** FLOW1a contract: with `{ shadow: true }` the splitter only proposes cells and writes nothing (cards, ledgers, LLM side effects excepted). */
export type SplitAdapter = (card: TaskCard, opts?: { shadow?: boolean }) => Promise<Array<{ id: string; title: string; seat?: string; host?: string }>> | Array<{ id: string; title: string; seat?: string; host?: string }>;
/** RELPLAN1 `placeCell(input: PlacementCell)` — owner·priority·predecessors are required; the result carries no seat. */
export type PlacementInput = { id: string; title: string; owner: string; priority: 'P0' | 'P1' | 'P2'; predecessors: string[] };
export type PlaceAdapter = (cell: PlacementInput) => Promise<{ version?: string } | null> | { version?: string } | null;
export type RebalanceAdapter = (version: string) => Promise<unknown[]> | unknown[];
export interface TickDeps {
  root?: string; now?: Date; mode?: Mode; runId?: string; window?: Window;
  cards?: () => TaskCard[]; split?: SplitAdapter; placeCell?: PlaceAdapter;
  loadAdapter?: (path: string, name: string) => Promise<unknown>;
  checklist?: (version: string) => Pick<ChecklistItem, 'id' | 'status'>[];
  observe?: (event: string, data: { loopId: string; runId: string; window: Window; node: Node; reason: string; count: number; targetLoopId?: string }) => void;
  print?: (line: string) => void;
}

export function kstWindow(now: Date): Window {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour < 12 ? '08' : hour < 18 ? '12' : '18';
}
function kstDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function activeNode(node: Node, window: Window): boolean {
  return node === 'report' || (window === '08' ? node !== 'reconcile' : node === 'reconcile');
}
function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version);
}
export function wishCards(cards: readonly TaskCard[]): TaskCard[] {
  return cards.filter(card => card.status === 'open' && card.goalId.startsWith('wish:') &&
    !card.sections.some(section => section.key === 'orch:split' || section.key.startsWith('orch:split:')));
}
export function reconciliation(cells: readonly Cell[], requests: readonly { key: string; status: string }[], checklist: (version: string) => Pick<ChecklistItem, 'id' | 'status'>[]): TickState['reconciled'] {
  const result = { reached: 0, progressing: 0, blocked: 0, unknown: 0 };
  const byVersion = new Map<string, Pick<ChecklistItem, 'id' | 'status'>[]>();
  const keys = new Set(requests.filter(row => row.status === 'queued').map(row => row.key));
  for (const cell of cells) {
    if (!keys.has(`orch:${cell.cardId}:${cell.id}`) || !cell.version) { result.unknown++; continue; }
    if (!byVersion.has(cell.version)) byVersion.set(cell.version, checklist(cell.version));
    const status = byVersion.get(cell.version)!.find(item => item.id === cell.id)?.status;
    if (status === 'green' || status === 'done') result.reached++;
    else if (status === 'yellow') result.progressing++;
    else if (status === 'red') result.blocked++;
    else result.unknown++;
  }
  return result;
}
export function reportLine(state: TickState): string {
  const r = state.reconciled;
  const line = `orchestrator ${state.window} cards=${state.cards.length} cells=${state.cells.length} placed=${state.missing.includes('relplan1-absent') ? 'missing' : state.placed} delegated=${state.mode === 'shadow' ? `would ${state.wouldDelegate}` : state.delegated} reconciled=${r.reached}/${r.progressing}/${r.blocked}/${r.unknown} mode=${state.mode}`;
  return state.runSummaries?.length ? `${line}\n${state.runSummaries.join('\n')}` : line;
}
function readCardSnapshot(root: string): { cards: TaskCard[]; skippedCards: TickState['skippedCards'] } {
  const dir = taskCardsDir(root);
  if (!existsSync(dir)) return { cards: [], skippedCards: [] };
  const cards: TaskCard[] = [];
  const skippedCards: TickState['skippedCards'] = [];
  for (const name of readdirSync(dir).filter(name => /^[a-zA-Z0-9_-]+\.jsonl$/.test(name))) {
    const id = name.slice(0, -'.jsonl'.length);
    try {
      let card: TaskCard | undefined;
      const raw = readFileSync(join(dir, name), 'utf8');
      if (raw && !raw.endsWith('\n')) throw new Error(`incomplete card journal: ${name}`);
      for (const line of raw.split('\n').filter(Boolean)) {
        const event = JSON.parse(line) as { type: string; id?: string; goalId?: string; title?: string; createdAt: string; key?: string; owner?: string; content?: string };
        if (event.type === 'created' && event.id && event.goalId && event.title) card = { id: event.id, goalId: event.goalId, title: event.title, createdAt: event.createdAt, status: 'open', sections: [] };
        else if (event.type === 'section' && card && event.key && event.owner && event.content) card.sections.push({ key: event.key, owner: event.owner, content: event.content, createdAt: event.createdAt });
        else if (event.type === 'closed' && card) card.status = 'closed';
      }
      if (card) {
        if (card.id !== id) throw new Error(`card journal id mismatch: ${name}`);
        cards.push(card);
      }
    } catch (error) { skippedCards.push({ id, reason: String(error) }); }
  }
  return { cards: cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)), skippedCards };
}
function readChecklist(root: string, version: string): Pick<ChecklistItem, 'id' | 'status'>[] {
  const path = join(root, 'release', 'features.sqlite');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, strict: true });
  try { return db.query('SELECT feature_id AS id, status FROM assignments WHERE version = ?').all(version) as Pick<ChecklistItem, 'id' | 'status'>[]; }
  finally { db.close(); }
}
function journal(root: string): string { return join(root, 'seat-requests', 'requests.jsonl'); }
function readRequests(root: string): Array<{ key: string; status: string }> {
  const path = journal(root);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { key: string; status: string }) : [];
}
function stateFile(root: string, runId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') throw new Error('Invalid orchestrator runId');
  return join(root, 'loop', 'orchestrator', `${runId}.json`);
}
function restorePrevious(root: string, day: string, mode: Mode): Pick<TickState, 'cards' | 'cells'> | null {
  const dir = join(root, 'loop', 'orchestrator');
  if (!existsSync(dir)) return null;
  const states = readdirSync(dir).filter(name => /^[a-zA-Z0-9._-]+\.json$/.test(name))
    .map(name => ({ name, state: JSON.parse(readFileSync(join(dir, name), 'utf8')) as TickState }))
    .filter(({ state }) => state.day === day && state.mode === mode && state.window === '08' && state.nodes.delegate === 'ok');
  if (!states.length) return null;
  states.sort((a, b) => a.name.localeCompare(b.name));
  const cards = new Map<string, TaskCard>();
  const cells = new Map<string, Cell>();
  for (const { state } of states) {
    for (const card of state.cards) cards.set(card.id, card);
    for (const cell of state.cells) cells.set(`${cell.cardId}:${cell.id}`, cell);
  }
  return { cards: [...cards.values()], cells: [...cells.values()] };
}
function initial(runId: string, window: Window, mode: Mode, day: string): TickState {
  return { runId, window, mode, day, cards: [], skippedCards: [], cells: [], placed: 0, delegated: 0, wouldDelegate: 0,
    reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 }, nodes: {}, missing: [] };
}
function graphRunId(): string | undefined {
  const context = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!context) return undefined;
  try {
    const value = JSON.parse(readFileSync(context, 'utf8')) as { graphId?: string; runId?: string };
    if (value.graphId !== 'orchestrator' || typeof value.runId !== 'string') throw new Error('invalid orchestrator graph context');
    return value.runId;
  } catch (error) { throw new Error(`orchestrator graph context unavailable: ${String(error)}`); }
}
async function optionalAdapter<T>(path: string, name: string): Promise<T | undefined> {
  try { return (await import(path) as Record<string, unknown>)[name] as T | undefined; }
  catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' || (error as { code?: string }).code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

/** A graph command invokes one node; only the per-run file carries data across processes. */
export async function runOrchestratorNode(node: Node, deps: TickDeps = {}): Promise<TickState> {
  const now = deps.now ?? new Date();
  const window = deps.window ?? kstWindow(now);
  const root = deps.root ?? effectiveInstanceRoot();
  const runId = deps.runId ?? graphRunId() ?? `${kstDay(now)}-${window}`;
  const path = stateFile(root, runId);
  const configured = deps.mode ?? getUserConfig().loops?.orchestrator?.mode;
  const mode: Mode = configured === 'off' || configured === 'live' ? configured : 'shadow';
  const state: TickState = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as TickState : initial(runId, window, mode, kstDay(now));
  if (state.window !== window || state.mode !== mode) throw new Error('orchestrator run window/mode changed');
  const predecessor: Partial<Record<Node, Node>> = { split: 'intake', place: 'split', delegate: 'place', reconcile: 'delegate', report: 'reconcile' };
  const preceding = predecessor[node];
  if (preceding && !state.nodes[preceding]) throw new Error(`orchestrator ${node}: missing ${preceding} result`);
  const loadAdapter = deps.loadAdapter ?? optionalAdapter;
  const adapter = async <T>(module: string, name: string): Promise<T | undefined> => {
    const value = await loadAdapter(module, name);
    return typeof value === 'function' ? value as T : undefined;
  };
  const observe = (event: string, reason = '', count = 0, targetLoopId?: string): void => {
    const data = { loopId: 'orchestrator', runId, window, node, reason, count, ...(targetLoopId ? { targetLoopId } : {}) };
    try { (deps.observe ?? ((name, payload) => debug.log('loop.orchestrator', name, payload)))(event, data); }
    catch { /* observation must not change the run */ }
  };
  if (mode !== 'off' && activeNode(node, window) && state.nodes[node] !== 'ok') {
    if (node === 'intake') {
      if (mode === 'live' && deps.cards) { state.cards = wishCards(deps.cards()); state.skippedCards = []; }
      else {
        const snapshot = readCardSnapshot(root);
        state.cards = wishCards(snapshot.cards);
        state.skippedCards = snapshot.skippedCards;
        state.skippedCards.forEach(() => observe('exchange', 'card-unreadable', 1));
      }
      observe('exchange', 'wish-cards', state.cards.length);
    } else if (node === 'split') {
      // Shadow also asks the splitter (it only proposes cells); only live records `orch:split` on the card.
      const split = deps.split ?? await adapter<SplitAdapter>('../../flow-loop/split.js', 'splitCard');
      if (!split) { state.missing.push('flow1a-absent'); observe('node-missing', 'flow1a-absent', state.cards.length); }
      state.cells = [];
      for (const card of state.cards) {
        const cells = split ? await split(card, { shadow: mode === 'shadow' }) : [{ id: card.id, title: card.title }];
        for (const cell of cells) {
          if (!cell.id?.trim() || !cell.title?.trim()) throw new Error('invalid split cell');
          state.cells.push({ cardId: card.id, id: cell.id, title: cell.title, origin: split ? 'flow1a' : 'candidate', ...(cell.seat ? { seat: cell.seat } : {}), ...(cell.host !== undefined ? { host: cell.host } : {}) });
        }
        if (split && cells.length && mode === 'live') {
          const store = new CardStore(root);
          try {
            store.appendSection(card.id, { key: 'orch:split', owner: 'orchestrator', content: JSON.stringify(cells) });
          } finally { store.close(); }
        }
      }
    } else if (node === 'place') {
      const place = deps.placeCell ?? await adapter<PlaceAdapter>('../../release-loop/placement.js', 'placeCell');
      const available = typeof place === 'function';
      if (!available) { state.missing.push('relplan1-absent'); observe('node-missing', 'relplan1-absent', state.cells.length); }
      else if (mode === 'shadow') observe('exchange', 'relplan1-shadow-not-invoked', state.cells.length);
      if (mode === 'live' && available) for (const cell of state.cells) {
        if (cell.origin !== 'flow1a') continue;
        // TC review must-fix ②: map to the placer's required shape; a cell without an owner is unplaced, not a crash.
        if (!cell.seat) { state.unplaced = (state.unplaced ?? 0) + 1; observe('exchange', 'unplaced-no-owner', 1); continue; }
        const placed = await place({ id: cell.id, title: cell.title, owner: cell.seat, priority: cell.priority ?? 'P2', predecessors: cell.predecessors ?? [] });
        if (validVersion(placed?.version)) {
          cell.version = placed.version;
          state.placed++;
        }
      }
    } else if (node === 'delegate') {
      const path = journal(root);
      const keys = new Set(readRequests(root).map(row => row.key));
      for (const cell of state.cells) {
        if (cell.origin !== 'flow1a' || !cell.seat) continue;
        const targetLoopId = SEAT_LOOP_IDS[cell.seat];
        if (!targetLoopId) continue;
        const key = `orch:${cell.cardId}:${cell.id}`;
        if (keys.has(key)) continue;
        // Shadow shows what it would hand over even before a release is chosen (placement is not invoked in shadow).
        if (mode === 'shadow') { keys.add(key); state.wouldDelegate++; observe('would-delegate', validVersion(cell.version) ? key : `${key} (unplaced)`, 1, targetLoopId); continue; }
        if (!validVersion(cell.version)) continue;
        keys.add(key);
        mkdirSync(dirname(path), { recursive: true });
        // TC review must-fix ①: the seat-requests journal contract needs receiptId, and appends are serialized under the
        // same lock as the traffic node — an invalid row stops request intake for every seat.
        const appended = withFileLockSync(`${path}.lock`, () => {
          const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
          if (existing.split('\n').some(line => {
            if (!line) return false;
            try { return (JSON.parse(line) as { key?: string }).key === key; } catch { throw new Error('invalid seat request journal'); }
          })) return false;
          appendFileSync(path, `${JSON.stringify({ key, receiptId: key, seat: cell.seat, ...(cell.host !== undefined ? { host: cell.host } : {}), loopId: targetLoopId, text: cell.title, status: 'queued', queuedAt: now.toISOString(), source: 'orchestrator', cell: cell.id, version: cell.version })}\n`);
          return true;
        });
        if (!appended) continue;
        state.delegated++;
        observe('exchange', 'queued', 1, targetLoopId);
      }
    } else if (node === 'reconcile') {
      if (window !== '08' && state.cells.length === 0) {
        const previous = restorePrevious(root, state.day, mode);
        if (previous) { state.cards = previous.cards; state.cells = previous.cells; }
      }
      const requests = readRequests(root);
      state.reconciled = reconciliation(state.cells, requests, mode === 'shadow' ? version => readChecklist(root, version) : (deps.checklist ?? (version => readChecklist(root, version))));
      const from = new Date(`${state.day}T00:00:00+09:00`).getTime();
      state.runSummaries = listSelfDevRuns(selfDevRunsDir(root))
        .filter(run => run.updatedAt >= from && run.updatedAt < from + 86_400_000)
        .map(run => runSummaryLine(run));
      observe('exchange', 'reconciled', state.cells.length);
      if (window === '18') {
        const rebalance = await adapter<RebalanceAdapter>('../../release-loop/placement.js', 'rebalance');
        if (!rebalance) { state.missing.push('k1b-absent'); observe('node-missing', 'k1b-absent', 1); }
        else {
          const versions = [...new Set(state.cells.map(cell => cell.version).filter(validVersion))];
          if (mode === 'shadow') observe('exchange', 'rebalance-shadow-not-invoked', versions.length);
          else {
            state.rebalanced = 0;
            for (const version of versions) state.rebalanced += (await rebalance(version)).length;
          }
        }
      }
    } else if (node === 'report') (deps.print ?? console.log)(reportLine(state));
    state.nodes[node] = 'ok';
  } else if (state.nodes[node] !== 'ok') {
    // A rerun of a node that already completed keeps its result (review round 3): only never-run nodes become skipped.
    state.nodes[node] = 'skipped';
  }
  observe('tick', state.nodes[node], state.cells.length);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
  return state;
}

if (import.meta.main) {
  const node = process.argv[2];
  const index = process.argv.indexOf('--window');
  const window = index < 0 ? undefined : process.argv[index + 1];
  if (!['intake', 'split', 'place', 'delegate', 'reconcile', 'report'].includes(node ?? '') ||
      (window !== undefined && !['08', '12', '18'].includes(window))) {
    console.error('orchestrator: expected <intake|split|place|delegate|reconcile|report> [--window 08|12|18]');
    process.exitCode = 2;
  } else {
    void (async () => {
      try { await (await import('../../domains/standalone-log-sink.js')).registerStandaloneLogSink('orchestrator'); }
      catch { /* local execution can still use the per-run file */ }
      await runOrchestratorNode(node as Node, { window: window as Window | undefined });
    })().catch(error => { console.error(`orchestrator ${node}: ${String(error)}`); process.exitCode = 1; });
  }
}
