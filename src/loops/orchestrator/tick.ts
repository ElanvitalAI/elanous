import { withFileLockSync } from '../../storage/file-lock.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CardStore, taskCardsDir, type TaskCard } from '../../task-cards/card-store.js';
import { Database } from 'bun:sqlite';
import { type ChecklistItem } from '../../release-loop/checklist.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { getUserConfig, type OrchestratorLoopConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { listSelfDevRuns, runSummaryLine, selfDevRunsDir } from '../../self-dev/run-store.js';
import { planAction, runSeatLoopOnce, type SeatDeps, type SeatItem } from '../../seat-loop/seat-loop.js';
import { addHarnessQueue, harnessQueueOutcome, setQueuedPoolHint } from '../../harness/harness-queue.js';
import { placeOnGrid, type GridHost } from './grid-place.js';
import { checkPodPool, parsePodPool, resolvePodPoolSpec } from '../../task-orchestrator/surfaces/pod-pool.js';
import { leaseKubectl } from '../../task-orchestrator/surfaces/pod-lease.js';
import { readTaskAgentState, TASK_SEATS, type HandTaskOptions, type TaskCard as TaskAgentCard, type HandTaskResult, type TaskLauncher, type TaskSeat } from '../../task-agent/task-hand.js';

export type Window = '08' | '12' | '18';
export type Node = 'intake' | 'split' | 'place' | 'delegate' | 'launch' | 'reconcile' | 'report';
export type Mode = 'off' | 'shadow' | 'live';
const SEAT_LOOP_IDS: Readonly<Record<string, string>> = { OP: 'op-seat', MK: 'cmo-seat', TC: 'tc-seat', UX: 'ux-seat' };
export interface Cell { id: string; title: string; kind?: string; seat?: string; host?: string; gridHost?: boolean; version?: string; cardId: string; origin: 'candidate' | 'flow1a'; priority?: 'P0' | 'P1' | 'P2'; predecessors?: string[] }
export interface TickState {
  runId: string; window: Window; mode: Mode; day: string;
  cards: TaskCard[]; skippedCards: Array<{ id: string; reason: string }>; cells: Cell[]; placed: number; unplaced?: number; delegated: number; wouldDelegate: number; rebalanced?: number; rebalanceBlocked?: Array<{ id: string; reason: string }>;
  reconciled: { reached: number; progressing: number; blocked: number; unknown: number };
  runSummaries?: string[];
  launched?: Array<{ seat: string; status: string; key?: string; queueId?: string; runId?: string }>;
  /** ORCH-TA-HAND — cells handed to TASK-AGENT this run (card id · mode · launched). */
  handed?: Array<{ key: string; cell: string; cardId: string; mode: 'shadow' | 'live'; launched: boolean }>;
  queueOutcomes?: Array<{ queueId: string; key?: string; outcome: string }>;
  steps: Array<{ node: Node; reason: string; count: number; targetLoopId?: string }>;
  nodes: Partial<Record<Node, 'ok' | 'skipped'>>;
  missing: string[];
}
/** FLOW1a contract: with `{ shadow: true }` the splitter only proposes cells and writes nothing (cards, ledgers, LLM side effects excepted). */
export type SplitAdapter = (card: TaskCard, opts?: { shadow?: boolean }) => Promise<Array<{ id: string; title: string; kind?: string; seat?: string; host?: string }>> | Array<{ id: string; title: string; kind?: string; seat?: string; host?: string }>;
/** RELPLAN1 `placeCell(input: PlacementCell)` — owner·priority·predecessors are required; the result carries no seat. */
export type PlacementInput = { id: string; title: string; owner: string; priority: 'P0' | 'P1' | 'P2'; predecessors: string[] };
export type PlaceAdapter = (cell: PlacementInput, deps?: { dryRun?: boolean; now?: Date }) => Promise<{ version?: string } | null> | { version?: string } | null;
export type RebalanceAdapter = (version: string) => Promise<{ decisions: unknown[]; blocked: Array<{ id: string; reason: string }> }> | { decisions: unknown[]; blocked: Array<{ id: string; reason: string }> };
export interface TickDeps {
  root?: string; now?: Date; mode?: Mode; runId?: string; window?: Window;
  cards?: () => TaskCard[]; split?: SplitAdapter; placeCell?: PlaceAdapter;
  gridHosts?: readonly GridHost[];
  seatTurn?: (seat: string, root: string, host?: string, options?: Pick<SeatDeps, 'enqueue'>) => Promise<{ status: string; queueId?: string; runId?: string; item?: { source: string; id: string } }>;
  queueOutcome?: (queueId: string, root: string) => 'pending' | 'unknown' | 'retryable' | 'succeeded';
  /** 발사 전 대기열 항목의 풀 힌트 갱신(주입 안 하면 harness-queue `setQueuedPoolHint`). */
  setPoolHint?: (queueId: string, poolHint: string | undefined, root: string) => Promise<boolean>;
  loadAdapter?: (path: string, name: string) => Promise<unknown>;
  checklist?: (version: string) => Pick<ChecklistItem, 'id' | 'status'>[];
  observe?: (event: string, data: { loopId: string; runId: string; window: Window; node: Node; reason: string; count: number; targetLoopId?: string }) => void;
  print?: (line: string) => void;
  /** ORCH-TA-HAND seams — absent = config `loops.orchestrator.handToTaskAgent(Cell)` · real `handTask` · `defaultTaskLauncher`. */
  handToTaskAgent?: 'off' | 'shadow' | 'live';
  handToTaskAgentCell?: string;
  handTask?: (opts: HandTaskOptions) => Promise<HandTaskResult>;
  taskLauncher?: TaskLauncher;
}

/** ORCH-TA-HAND ledger — one row per handed `orch:<card>:<cell>` key so a cell is handed once across ticks and processes. */
function handedLedger(root: string): string { return join(root, 'loop', 'orchestrator', 'handed.jsonl'); }
type HandedRow = { key: string; cell: string; cardId: string; mode: 'shadow' | 'live'; launched: boolean; runId?: string };
/** Completed hands (`status: 'handed'`) by ledger key — a re-entered run restores its `handed[]` from these. */
function handedRows(path: string): Map<string, HandedRow> {
  const rows = new Map<string, HandedRow>();
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: Partial<HandedRow> & { status?: unknown };
    try { row = JSON.parse(line) as typeof row; } catch { throw new Error('invalid orchestrator handed ledger'); }
    if (row.status === 'handed' && typeof row.key === 'string' && typeof row.cardId === 'string' && typeof row.cell === 'string'
      && (row.mode === 'shadow' || row.mode === 'live')) rows.set(row.key, { key: row.key, cell: row.cell, cardId: row.cardId, mode: row.mode, launched: row.launched === true, ...(typeof row.runId === 'string' ? { runId: row.runId } : {}) });
  }
  return rows;
}
function handedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: { key?: unknown; status?: unknown };
    try { row = JSON.parse(line) as typeof row; } catch { throw new Error('invalid orchestrator handed ledger'); }
    if (typeof row.key !== 'string') continue;
    // A released claim (a shadow hand that failed before its card) frees the key again — the last row decides.
    if (row.status === 'released') keys.delete(row.key); else keys.add(row.key);
  }
  return keys;
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
export function reconciliation(cells: readonly Cell[], requests: readonly { key: string; status: string }[], checklist: (version: string) => Pick<ChecklistItem, 'id' | 'status'>[],
  queue: readonly { key: string; outcome: string }[] = []): TickState['reconciled'] {
  // 체크리스트가 정본이고, 칸이 아직 체크리스트에 없을 때만 «그 칸의 의뢰 키»로 발사된 대기열 결과를 본다.
  const queueByKey = new Map(queue.map(row => [row.key, row.outcome]));
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
    else {
      const outcome = queueByKey.get(`orch:${cell.cardId}:${cell.id}`);
      if (outcome === 'pending' || outcome === 'succeeded') result.progressing++;
      else if (outcome === 'retryable') result.blocked++;
      else result.unknown++;
    }
  }
  return result;
}
export function reportLine(state: TickState): string {
  const r = state.reconciled;
  const line = `orchestrator ${state.window} cards=${state.cards.length} cells=${state.cells.length} placed=${state.missing.includes('relplan1-absent') ? 'missing' : state.placed} delegated=${state.mode === 'shadow' ? `would ${state.wouldDelegate}` : state.delegated} reconciled=${r.reached}/${r.progressing}/${r.blocked}/${r.unknown} mode=${state.mode}`;
  const details = [...(state.rebalanceBlocked ?? []).map(row => `⛔ 이월 거부 ${row.id}: ${row.reason}`), ...(state.runSummaries ?? [])];
  return details.length ? `${line}\n${details.join('\n')}` : line;
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
/** 명시 인벤토리: 없으면 undefined, «있는데 못 읽으면» null — null 은 풀 명부로 대체하지 않는다. */
function readGridHosts(): readonly GridHost[] | null | undefined {
  const supplied = process.env.ELANOUS_GRID_HOSTS;
  if (supplied === undefined) return undefined;
  try {
    const inventory: unknown = JSON.parse(supplied);
    if (!Array.isArray(inventory) || !inventory.every(row => row && typeof row === 'object' &&
      typeof row.name === 'string' && row.name.trim() !== '' && Array.isArray(row.capabilities) &&
      row.capabilities.every((capability: unknown) => typeof capability === 'string') &&
      typeof row.available === 'boolean')) return null;
    return inventory.map(row => ({ name: row.name as string, capabilities: new Set<string>(row.capabilities), available: row.available as boolean }));
  } catch { return null; }
}
/** 주입 > 명시 인벤토리 > 풀 명부. 명시 인벤토리를 못 읽으면 제안하지 않는다(기존 경로 그대로). */
function resolveGridHosts(deps: TickDeps, observe: (event: string, reason: string, count: number) => void): readonly GridHost[] | undefined {
  if (deps.gridHosts) return deps.gridHosts;
  const supplied = readGridHosts();
  if (supplied === null) { observe('node-missing', 'grid-inventory-unreadable', 0); return undefined; }
  return supplied ?? gridHostsFromPodPool();
}
function preferredPoolSpec(host: string): string | undefined {
  const config = getUserConfig();
  const spec = resolvePodPoolSpec(undefined, process.env, () => config.harness?.podPool ?? config.pod?.pool);
  if (!spec) return undefined;
  try {
    const members = parsePodPool(spec);
    const member = members.find(candidate => (candidate.sshHost ?? candidate.context) === host);
    if (!member) return undefined;
    const parts = spec.split(',').map(part => part.trim());
    const preferred = parts.find(part => part === member.context ||
      ['@', ':', '#'].some(separator => part.startsWith(`${member.context}${separator}`)));
    return preferred ? [preferred, ...parts.filter(part => part !== preferred)].join(',') : undefined;
  } catch { return undefined; }
}
function gridHostsFromPodPool(): readonly GridHost[] | undefined {
  try {
    const config = getUserConfig();
    const spec = resolvePodPoolSpec(undefined, process.env, () => config.harness?.podPool ?? config.pod?.pool);
    if (!spec) return undefined;
    const members = parsePodPool(spec);
    const checked = checkPodPool(members, leaseKubectl);
    const ready = new Set(checked.ready.map(member => member.context));
    return members.map(member => ({
      name: member.sshHost ?? member.context,
      capabilities: new Set(['pod']),
      available: ready.has(member.context),
    }));
  } catch { return undefined; }
}
function journal(root: string): string { return join(root, 'seat-requests', 'requests.jsonl'); }
function readRequests(root: string): Array<{ key: string; status: string; seat?: string; kind?: string; host?: string; gridHost?: boolean }> {
  const path = journal(root);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { key: string; status: string; seat?: string; kind?: string; host?: string; gridHost?: boolean }) : [];
}
function refreshGridHosts(cells: Cell[], hosts: readonly GridHost[] | undefined, mode: Mode,
  root: string, observe: (event: string, reason: string, count: number, targetLoopId?: string) => void): void {
  if (hosts === undefined) return;
  for (const cell of cells) {
    if (mode !== 'live' || cell.origin !== 'flow1a' || !cell.seat || !SEAT_LOOP_IDS[cell.seat]) {
      observe('exchange', `would-host:${cell.id}:${placeOnGrid(cell, hosts).host ?? 'null'}`, 1);
      continue;
    }
    const path = journal(root);
    const key = `orch:${cell.cardId}:${cell.id}`;
    // 의뢰가 이미 대기열을 떠났으면(발사·완료) 제안만 관측하고 칸의 호스트는 그 행의 확정 호스트로 되돌린다.
    const keepLaunched = (row: { host?: string; gridHost?: boolean }): void => {
      if (row.host) cell.host = row.host; else delete cell.host;
      if (row.gridHost) cell.gridHost = true; else delete cell.gridHost;
    };
    let changedFrom: string | undefined;
    mkdirSync(dirname(path), { recursive: true });
    // 상태 확인 · 칸 변경 · 행 갱신은 모두 같은 잠금 안의 한 결정이다 — 다른 틱이 그 사이 행을 만들거나 바꿔도 덮지 않는다.
    withFileLockSync(`${path}.lock`, () => {
      const current = readRequests(root).filter(row => row.key === key).at(-1);
      // 호스트 결정도 잠금 안 — 상태 확인과 같은 순간의 명부로 고른다.
      const choice = placeOnGrid(cell, hosts);
      observe('exchange', `would-host:${cell.id}:${choice.host ?? 'null'}`, 1);
      if (current && current.status !== 'queued') { keepLaunched(current); return; }
      if (choice.host) { cell.host = choice.host; cell.gridHost = true; }
      else if (cell.gridHost || current?.gridHost) { delete cell.host; delete cell.gridHost; }
      if (!current || (current.host === cell.host && current.gridHost === cell.gridHost && (current.kind === cell.kind || !cell.kind))) return;
      if (current.host !== cell.host) changedFrom = current.host;
      const updated = { ...current };
      delete updated.host;
      delete updated.gridHost;
      if (cell.host) updated.host = cell.host;
      if (cell.gridHost) updated.gridHost = true;
      if (cell.kind) updated.kind = cell.kind;
      appendFileSync(path, `${JSON.stringify(updated)}\n`);
    });
    if (changedFrom !== undefined) observe('exchange', `rehost:${cell.id}:${changedFrom}→${cell.host ?? 'none'}`, 1, SEAT_LOOP_IDS[cell.seat]);
  }
}
/**
 * 재배치된 의뢰가 앞 틱에서 이미 대기열에 들어갔다면(아직 발사 전) 그 항목의 풀 힌트도 의뢰 행의 새 호스트로 맞춘다.
 * 의뢰 키 ↔ 대기열 id 는 live 틱 상태들의 `launched` 에서 찾는다(날짜를 넘겨 대기 중인 항목도). 의뢰 행이 아직 queued 일 때만 옮긴다.
 */
async function syncQueuedPoolHints(root: string, current: NonNullable<TickState['launched']>, deps: TickDeps,
  observe: (event: string, reason: string, count: number) => void): Promise<void> {
  const dir = join(root, 'loop', 'orchestrator');
  const turns = [...current];
  if (existsSync(dir)) for (const name of readdirSync(dir).filter(file => /^[a-zA-Z0-9._-]+\.json$/.test(file))) {
    try {
      const other = JSON.parse(readFileSync(join(dir, name), 'utf8')) as TickState;
      if (other.mode === 'live') turns.push(...(other.launched ?? []));
    } catch { /* 깨진 상태 파일은 건너뛴다 */ }
  }
  const latest = new Map(readRequests(root).map(row => [row.key, row]));
  const seen = new Set<string>();
  for (const turn of turns) {
    if (!turn.queueId || !turn.key || seen.has(turn.queueId)) continue;
    seen.add(turn.queueId);
    const row = latest.get(turn.key);
    if (!row || row.kind !== 'pod' || row.status !== 'queued') continue;
    // GRID 가 고른 행이면 그 호스트 쪽 힌트로, GRID 가 호스트를 거둔 행(둘 다 막힘)이면 GRID 가 넣었던 힌트만 지운다.
    // GRID 와 무관한 기존 pod 의뢰의 힌트(ORCH1·명시 풀)는 건드리지 않는다.
    const gridChosen = !!(row.gridHost && row.host);
    if (!gridChosen && row.host) continue;
    const hint = gridChosen ? preferredPoolSpec(row.host!) : undefined;
    if (gridChosen && !hint) continue;
    const key = turn.key;
    // 갱신 직전 대기열 잠금 안에서: 의뢰가 아직 queued 이고 행의 호스트가 계산 때와 같으며,
    // 지우는 경우엔 지금 대기열 힌트가 GRID 가 만든 꼴일 때만.
    const stillQueued = (item: { poolHint?: string; poolHintSource?: 'grid' }): boolean => {
      const now = readRequests(root).filter(r => r.key === key).at(-1);
      if (now?.status !== 'queued' || now.host !== row.host || now.gridHost !== row.gridHost) return false;
      // 지우는 쪽은 GRID 가 소유한 힌트만(소유 기록 확인) — 같은 문자열이라도 사람이 넣은 힌트는 남긴다.
      return gridChosen || item.poolHintSource === 'grid';
    };
    if (await (deps.setPoolHint ?? ((id: string, value: string | undefined, stateRoot: string) => setQueuedPoolHint(id, value, { root: stateRoot }, stillQueued)))(turn.queueId, hint, root))
      observe('exchange', `rehost-queue:${turn.key}:${hint ?? 'none'}`, 1);
  }
}
function stateFile(root: string, runId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') throw new Error('Invalid orchestrator runId');
  return join(root, 'loop', 'orchestrator', `${runId}.json`);
}
function restorePrevious(root: string, day: string, mode: Mode): Pick<TickState, 'cards' | 'cells' | 'launched'> | null {
  const dir = join(root, 'loop', 'orchestrator');
  if (!existsSync(dir)) return null;
  const states = readdirSync(dir).filter(name => /^[a-zA-Z0-9._-]+\.json$/.test(name))
    .map(name => ({ name, state: JSON.parse(readFileSync(join(dir, name), 'utf8')) as TickState }))
    .filter(({ state }) => state.day === day && state.mode === mode && state.window === '08' && state.nodes.delegate === 'ok');
  if (!states.length) return null;
  states.sort((a, b) => a.name.localeCompare(b.name));
  const cards = new Map<string, TaskCard>();
  const cells = new Map<string, Cell>();
  const launched = new Map<string, NonNullable<TickState['launched']>[number]>();
  for (const { state } of states) {
    for (const card of state.cards) cards.set(card.id, card);
    for (const cell of state.cells) cells.set(`${cell.cardId}:${cell.id}`, cell);
    for (const turn of state.launched ?? []) if (turn.queueId) launched.set(turn.queueId, turn);
  }
  return { cards: [...cards.values()], cells: [...cells.values()], launched: [...launched.values()] };
}
function initial(runId: string, window: Window, mode: Mode, day: string): TickState {
  return { runId, window, mode, day, cards: [], skippedCards: [], cells: [], placed: 0, delegated: 0, wouldDelegate: 0,
    reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 }, steps: [], nodes: {}, missing: [] };
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
  state.steps ??= [];
  if (state.window !== window || state.mode !== mode) throw new Error('orchestrator run window/mode changed');
  const predecessor: Partial<Record<Node, Node>> = { split: 'intake', place: 'split', delegate: 'place', launch: 'delegate', reconcile: 'launch', report: 'reconcile' };
  const preceding = predecessor[node];
  if (preceding && !state.nodes[preceding]) throw new Error(`orchestrator ${node}: missing ${preceding} result`);
  const loadAdapter = deps.loadAdapter ?? optionalAdapter;
  const adapter = async <T>(module: string, name: string): Promise<T | undefined> => {
    const value = await loadAdapter(module, name);
    return typeof value === 'function' ? value as T : undefined;
  };
  const observe = (event: string, reason = '', count = 0, targetLoopId?: string): void => {
    const data = { loopId: 'orchestrator', runId, window, node, reason, count, ...(targetLoopId ? { targetLoopId } : {}) };
    if (event !== 'tick') state.steps.push({ node, reason, count, ...(targetLoopId ? { targetLoopId } : {}) });
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
          state.cells.push({ cardId: card.id, id: cell.id, title: cell.title, origin: split ? 'flow1a' : 'candidate', ...(cell.kind !== undefined ? { kind: cell.kind } : {}), ...(cell.seat ? { seat: cell.seat } : {}), ...(cell.host !== undefined ? { host: cell.host } : {}) });
        }
        observe('exchange', `split:${card.id}`, cells.length);
        if (split && cells.length && mode === 'live') {
          const store = new CardStore(root);
          try {
            store.appendSection(card.id, { key: 'orch:split', owner: 'orchestrator', content: JSON.stringify(cells) });
          } finally { store.close(); }
        }
      }
    } else if (node === 'place') {
      const gridHosts = resolveGridHosts(deps, observe);
      refreshGridHosts(state.cells, gridHosts, mode, root, observe);
      if (mode === 'live') await syncQueuedPoolHints(root, state.launched ?? [], deps, observe);
      const place = deps.placeCell ?? await adapter<PlaceAdapter>('../../release-loop/placement.js', 'placeCell');
      const available = typeof place === 'function';
      if (!available) { state.missing.push('relplan1-absent'); observe('node-missing', 'relplan1-absent', state.cells.length); }
      if (mode === 'shadow' && deps.placeCell) observe('exchange', 'relplan1-shadow-not-invoked', state.cells.length);
      // 담당 없는 칸은 배치를 부르든 안 부르든 센다 — 배치 호출 여부와 집계를 묶지 않는다.
      for (const cell of state.cells) {
        if (cell.origin === 'flow1a' && (!cell.seat || !SEAT_LOOP_IDS[cell.seat])) { state.unplaced = (state.unplaced ?? 0) + 1; observe('exchange', 'unplaced-no-owner', 1); }
      }
      if (available && (mode === 'live' || !deps.placeCell)) for (const cell of state.cells) {
        if (cell.origin !== 'flow1a' || !cell.seat || !SEAT_LOOP_IDS[cell.seat]) continue;
        // RELPLAN's dryRun calculates the same release without writing a checklist in shadow.
        try {
          const placed = await place({ id: cell.id, title: cell.title, owner: cell.seat, priority: cell.priority ?? 'P2', predecessors: cell.predecessors ?? [] }, { dryRun: mode === 'shadow', now });
          if (validVersion(placed?.version)) {
            cell.version = placed.version;
            state.placed++;
            observe('exchange', mode === 'shadow' ? `would-place:${cell.id}:${cell.version}` : `placed:${cell.id}:${cell.version}`, 1);
          } else { state.unplaced = (state.unplaced ?? 0) + 1; observe('exchange', 'unplaced-no-release', 1); }
        } catch (error) {
          state.unplaced = (state.unplaced ?? 0) + 1;
          observe('exchange', `unplaced:${cell.id}:${String(error).slice(0, 160)}`, 1);
        }
      }
    } else if (node === 'delegate') {
      const path = journal(root);
      // 모드와 칸 필터는 따로 푼다 — 주입으로 모드만 줘도 설정의 칸 필터는 그대로 먹는다.
      const handConfig: Partial<OrchestratorLoopConfig> = deps.handToTaskAgent !== undefined && deps.handToTaskAgentCell !== undefined ? {} : getUserConfig().loops?.orchestrator ?? {};
      // live 로 넘긴 칸은 지금 설정(off·칸 필터)과 무관하게 자리 경로로 다시 안 간다 — 발사 주체가 둘이 되지 않게.
      // ⭐ 넘김 claim 과 자리 저널 기록은 «같은 잠금»(자리 저널 잠금) 아래에서 서로를 다시 읽는다 — 동시 틱이 낡은 값을 보지 않게.
      const ledger = handedLedger(root);
      const liveHanded = handedKeys(ledger);
      const keys = new Set(readRequests(root).map(row => row.key));
      // 넘김 뒤 상태 저장 전에 죽은 같은 run 이 다시 돌면 원장에서 handed[] 를 되살린다.
      const ledgerHanded = handedRows(ledger);
      const restoreHanded = (handKey: string, key: string, rows: Map<string, HandedRow> = handedRows(ledger)): void => {
        const row = rows.get(handKey);
        // 이 run 이 넘긴 것만 되살린다 — 다른 run 의 넘김을 «이 run 에서 넘겼다»로 적지 않게.
        if (!row || row.runId !== runId || (state.handed ?? []).some(entry => entry.key === key && entry.mode === row.mode)) return;
        (state.handed ??= []).push({ key, cell: row.cell, cardId: row.cardId, mode: row.mode, launched: row.launched });
      };
      const journalHas = (key: string): boolean => {
        if (!existsSync(path)) return false;
        return readFileSync(path, 'utf8').split('\n').some(line => {
          if (!line) return false;
          try { return (JSON.parse(line) as { key?: string }).key === key; } catch { throw new Error('invalid seat request journal'); }
        });
      };
      for (const cell of state.cells) {
        if (cell.origin !== 'flow1a' || !cell.seat) continue;
        const targetLoopId = SEAT_LOOP_IDS[cell.seat];
        if (!targetLoopId) continue;
        const key = `orch:${cell.cardId}:${cell.id}`;
        // 저널 키로 건너뛰기 «전에» 원장에서 복구한다 — shadow 넘김 ⊕ 자리 기록 뒤 상태 저장 전에 죽은 run 도 handed[] 를 되찾게.
        restoreHanded(key, key, ledgerHanded);
        restoreHanded(`shadow:${key}`, key, ledgerHanded);
        if (keys.has(key)) continue;
        if (liveHanded.has(key)) { keys.add(key); observe('exchange', `handed-to-task-agent:${key}`, 1, 'task-agent'); continue; }
        // ORCH-TA-HAND: hand the picked cell to TASK-AGENT. shadow = card only (the seat path below is unchanged);
        // live (tick live ⊕ hand live) = launch through TASK-AGENT and skip the seat journal so the cell launches once.
        const handMode = deps.handToTaskAgent ?? handConfig.handToTaskAgent ?? 'off';
        const handCell = deps.handToTaskAgentCell ?? handConfig.handToTaskAgentCell;
        if (handMode !== 'off' && (!handCell || handCell === cell.id) && (TASK_SEATS as readonly string[]).includes(cell.seat)) {
          // live 는 tick 도 live 이고 배치(유효한 판)가 된 칸만 — 나머지는 카드만(shadow · 배치 전 칸도 표본이 된다).
          const handLive = handMode === 'live' && mode === 'live' && validVersion(cell.version);
          // shadow 표본은 따로 센다 — 자리 경로로 아직 안 간 칸(shadow 틱·배치 전)이 나중에 live 로 바뀌면 그때 뜬다.
          // ⚠️ 이미 자리 저널에 들어간 칸은 live 로 바꿔도 다시 안 넘긴다(keys.has 에서 끝) — 한 칸의 발사 주체는 하나다(의도).
          const handKey = handLive ? key : `shadow:${key}`;
          mkdirSync(dirname(ledger), { recursive: true });
          mkdirSync(dirname(path), { recursive: true });
          // Claim under the seat-journal lock — the same lock the seat append takes, so a live claim and a seat row never both land.
          const claimed = withFileLockSync(`${path}.lock`, () => {
            if (handedKeys(ledger).has(handKey)) return false;
            if (handLive && journalHas(key)) return false;
            appendFileSync(ledger, `${JSON.stringify({ key: handKey, cell: cell.id, seat: cell.seat, mode: handLive ? 'live' : 'shadow', status: 'claimed', runId, at: now.toISOString() })}\n`);
            return true;
          });
          if (claimed) {
            try {
              const result = await (deps.handTask ?? (async (opts: HandTaskOptions) => (await import('../../task-agent/task-hand.js')).handTask(opts)))({
                text: cell.title, seat: cell.seat as TaskSeat, checklistId: cell.id, live: handLive, now: () => now,
                statePath: join(root, 'task-agent-actions.json'),
                ...(handLive ? { launcher: deps.taskLauncher ?? (async (args: string[]) => (await import('../../cli/tasks-cli.js')).defaultTaskLauncher(args)) } : {}),
              });
              withFileLockSync(`${path}.lock`, () => appendFileSync(ledger, `${JSON.stringify({ key: handKey, cell: cell.id, cardId: result.card.id, mode: result.mode, launched: result.launched, status: 'handed', runId, at: now.toISOString() })}\n`));
              (state.handed ??= []).push({ key, cell: cell.id, cardId: result.card.id, mode: result.mode, launched: result.launched });
              observe('hand-to-task-agent', `${key}:${result.card.id}:${result.mode}${result.launched ? ':launched' : ''}`, 1, 'task-agent');
              if (handLive) { keys.add(key); continue; }
            } catch (error) {
              observe('hand-to-task-agent-failed', `${key}:${String(error).slice(0, 160)}`, 1, 'task-agent');
              // A failed live hand stays claimed (no relaunch loop) and does not fall back to the seat path — one launcher per cell.
              if (handLive) { keys.add(key); continue; }
              // A failed shadow hand launched nothing — release the claim so a later tick can write the card,
              // but only when no card for this cell was written (a failure after the card must not make a second one).
              let cardWritten = true;
              try {
                const storePath = join(root, 'task-agent-actions.json');
                if (!existsSync(storePath)) cardWritten = false;
                else {
                  // 상태를 믿을 수 있을 때만 «카드 0장»으로 읽는다 — tasks 가 없거나 꼴이 틀리면 claim 을 남긴다.
                  const tasks = readTaskAgentState<{ tasks?: unknown }>(storePath).tasks;
                  if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)
                    && Object.values(tasks).every(card => card && typeof card === 'object' && !Array.isArray(card))) {
                    cardWritten = Object.values(tasks as Record<string, TaskAgentCard>).some(card => card.checklistId === cell.id && card.text === cell.title);
                  }
                }
              } catch { cardWritten = true; /* unreadable store → keep the claim (never risk a duplicate) */ }
              if (!cardWritten) withFileLockSync(`${path}.lock`, () => appendFileSync(ledger, `${JSON.stringify({ key: handKey, cell: cell.id, status: 'released', runId, reason: String(error).slice(0, 160), at: now.toISOString() })}\n`));
            }
          } else {
            restoreHanded(handKey, key);
            if (handLive) { keys.add(key); continue; }
          }
        }
        if (!validVersion(cell.version)) {
          if (mode === 'shadow') { keys.add(key); state.wouldDelegate++; observe('would-delegate', `${key} (unplaced)`, 1, targetLoopId); }
          continue;
        }
        if (mode === 'shadow') { keys.add(key); state.wouldDelegate++; observe('would-delegate', key, 1, targetLoopId); continue; }
        keys.add(key);
        mkdirSync(dirname(path), { recursive: true });
        // TC review must-fix ①: the seat-requests journal contract needs receiptId, and appends are serialized under the
        // same lock as the traffic node — an invalid row stops request intake for every seat.
        const appended = withFileLockSync(`${path}.lock`, (): boolean | 'handed' => {
          if (journalHas(key)) return false;
          // 잠금 안에서 다시 본다 — 동시 틱이 이 칸을 방금 live 로 넘겼으면 자리 경로로 보내지 않는다.
          if (handedKeys(ledger).has(key)) return 'handed';
          appendFileSync(path, `${JSON.stringify({ key, receiptId: key, seat: cell.seat, ...(cell.kind !== undefined ? { kind: cell.kind } : {}), ...(cell.host !== undefined ? { host: cell.host } : {}), ...(cell.gridHost ? { gridHost: true } : {}), loopId: targetLoopId, text: cell.title, status: 'queued', queuedAt: now.toISOString(), source: 'orchestrator', cell: cell.id, version: cell.version })}\n`);
          return true;
        });
        if (appended === 'handed') { observe('exchange', `seat-suppressed-handed:${key}`, 1, 'task-agent'); continue; }
        if (!appended) continue;
        state.delegated++;
        observe('exchange', 'queued', 1, targetLoopId);
      }
    } else if (node === 'launch') {
      // shadow 는 저널을 읽지 않는다 — 깨진 live 저널이 관측 전용 틱을 넘어뜨리지 않게.
      const latestRequests = new Map(mode === 'live' ? readRequests(root).map(row => [row.key, row]) : []);
      const eligible = state.cells.filter(cell => cell.origin === 'flow1a' && cell.seat && SEAT_LOOP_IDS[cell.seat]
        && validVersion(cell.version) && (mode === 'shadow' || latestRequests.get(`orch:${cell.cardId}:${cell.id}`)?.status === 'queued'));
      const seats = [...new Set(eligible.map(cell => cell.seat!))];
      state.launched = [];
      for (const seat of seats) {
        if (mode === 'shadow') {
          const cell = eligible.find(row => row.seat === seat)!;
          const item: SeatItem = { source: 'request', id: `orch:${cell.cardId}:${cell.id}`, title: cell.title, text: cell.title };
          const action = planAction(item, seat);
          state.launched.push({ seat, key: item.id, status: action.kind === 'harness' ? 'would-launch' : `would-${action.kind}` });
          observe('exchange', `would-${action.kind}:${seat}`, 1, SEAT_LOOP_IDS[seat]);
        } else {
          const selected = eligible.find(cell => cell.seat === seat && latestRequests.get(`orch:${cell.cardId}:${cell.id}`)?.status === 'queued');
          const host = selected && latestRequests.get(`orch:${selected.cardId}:${selected.id}`)?.host;
          const pools = new Map<string, string>([...latestRequests].flatMap(([key, row]) => {
            if (row.status !== 'queued' || row.seat !== seat || row.kind !== 'pod' || !row.gridHost || !row.host || !key.startsWith('orch:')) return [];
            const pool = preferredPoolSpec(row.host);
            // 풀 힌트는 «설정된 풀»의 순서 바꾸기다 — 고른 호스트가 풀에 없으면 힌트를 지어내지 않고 그 사실을 남긴다.
            if (!pool) observe('exchange', `grid-host-unmapped:${key}:${row.host}`, 1, SEAT_LOOP_IDS[seat]);
            return pool ? [[key, pool] as const] : [];
          }));
          const enqueue: SeatDeps['enqueue'] | undefined = pools.size
            ? (queuedSeat, text, queuedRoot, idempotencyKey, item) => addHarnessQueue({ seat: queuedSeat, say: text, idempotencyKey,
              ...(item.source === 'request' && pools.has(item.id) ? { poolHint: pools.get(item.id), poolHintSource: 'grid' as const } : {}) }, { root: queuedRoot })
            : undefined;
          const options = enqueue ? { enqueue } : undefined;
          const turn = await (deps.seatTurn ?? ((assigned: string, stateRoot: string, _preferred?: string, overrides?: Pick<SeatDeps, 'enqueue'>) =>
            runSeatLoopOnce(assigned, { root: stateRoot,
              config: { ...getUserConfig().loops?.seat, mode: 'live-safe', seats: [assigned] }, ...overrides })))(seat, root, host, options);
          // 자리 턴이 «이 틱이 넣은 의뢰»를 처리했을 때만 칸에 잇는다 — 대기열의 다른 의뢰는 이 카드의 발사가 아니다.
          const targets = new Set(eligible.filter(row => row.seat === seat).map(row => `orch:${row.cardId}:${row.id}`));
          const handled = 'item' in turn && turn.item?.source === 'request' ? turn.item.id : undefined;
          const key = handled && targets.has(handled) ? handled : undefined;
          if (handled && !key) observe('exchange', `seat-turn-other-request:${seat}`, 1, SEAT_LOOP_IDS[seat]);
          state.launched.push({ seat, status: turn.status, ...(key ? { key } : {}),
            ...('queueId' in turn && turn.queueId ? { queueId: turn.queueId } : {}),
            ...('runId' in turn && turn.runId ? { runId: turn.runId } : {}) });
          observe('exchange', `seat-turn:${seat}:${turn.status}`, 1, SEAT_LOOP_IDS[seat]);
        }
      }
    } else if (node === 'reconcile') {
      if (window !== '08') {
        // 새 카드가 있어도 앞 틱의 의뢰·발사를 같이 대조한다 — 지금 틱 것이 같은 키를 이긴다.
        const previous = restorePrevious(root, state.day, mode);
        if (previous) {
          const merge = <T>(older: readonly T[], newer: readonly T[], key: (row: T) => string) =>
            [...new Map([...older, ...newer].map(row => [key(row), row])).values()];
          state.cards = merge(previous.cards, state.cards, card => card.id);
          state.cells = merge(previous.cells, state.cells, cell => `${cell.cardId}:${cell.id}`);
          state.launched = merge(previous.launched ?? [], state.launched ?? [], turn => turn.queueId ?? `${turn.seat}:${turn.key ?? ''}`);
        }
        if (mode === 'live') {
          refreshGridHosts(state.cells, resolveGridHosts(deps, observe), mode, root, observe);
          await syncQueuedPoolHints(root, state.launched ?? [], deps, observe);
        }
      }
      state.queueOutcomes = (state.launched ?? []).filter(turn => turn.queueId).map(turn => {
        const outcome = (deps.queueOutcome ?? ((id: string, stateRoot: string) => harnessQueueOutcome(id, { root: stateRoot })))(turn.queueId!, root);
        observe('exchange', `queue-outcome:${turn.queueId}:${outcome}`, 1, SEAT_LOOP_IDS[turn.seat]);
        return { queueId: turn.queueId!, ...(turn.key ? { key: turn.key } : {}), outcome };
      });
      const requests = readRequests(root);
      state.reconciled = reconciliation(state.cells, requests, mode === 'shadow' ? version => readChecklist(root, version) : (deps.checklist ?? (version => readChecklist(root, version))),
        state.queueOutcomes.flatMap(row => row.key ? [{ key: row.key, outcome: row.outcome }] : []));
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
            state.rebalanceBlocked = [];
            for (const version of versions) {
              const result = await rebalance(version);
              state.rebalanced += result.decisions.length;
              state.rebalanceBlocked.push(...result.blocked);
              for (const blocked of result.blocked) observe('exchange', `rebalance-blocked: ${blocked.id} ${blocked.reason}`, 1);
            }
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
  if (!['intake', 'split', 'place', 'delegate', 'launch', 'reconcile', 'report'].includes(node ?? '') ||
      (window !== undefined && !['08', '12', '18'].includes(window))) {
    console.error('orchestrator: expected <intake|split|place|delegate|launch|reconcile|report> [--window 08|12|18]');
    process.exitCode = 2;
  } else {
    void (async () => {
      try { await (await import('../../domains/standalone-log-sink.js')).registerStandaloneLogSink('orchestrator'); }
      catch { /* local execution can still use the per-run file */ }
      await runOrchestratorNode(node as Node, { window: window as Window | undefined });
    })().catch(error => { console.error(`orchestrator ${node}: ${String(error)}`); process.exitCode = 1; });
  }
}
