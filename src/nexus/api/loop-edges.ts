import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { listSeatRequests, type SeatRequestRow } from '../../seat-dispatch/seat-request-ledger.js';
import { listCoordEvents } from '../../context-bus/coord-events.js';
import { CardStore, cardIndexPath, type TaskCard } from '../../task-cards/card-store.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, type RunLedgerEntry } from '../../self-implement/run-ledger.js';
import { listLoops } from '../../loops/registry.js';
import { listSubSeatCharters } from './sub-seat-charters.js';
import { SEATS } from './ops-seats.js';
import { jsonResponse } from './json-response.js';
import { readTaskAgentState, type TaskCard as TaskAgentCard } from '../../task-agent/task-hand.js';
import { LogStore, logsDbPath } from '../../mss/logging/log-store.js';

/** `move` 칸에 실을 수 있는 값(allowlist) — 판단부 수 종류만, 문면은 싣지 않는다. */
export const LOOP_EDGE_MOVES = ['green-proposal'] as const;

export interface LoopEdge {
  at: string;
  kind: 'request' | 'decision' | 'report' | 'card' | 'run' | 'hand' | 'launch' | 'move';
  from: string;
  to: string;
  ref: string;
  /** 체크리스트 칸 id(ID 정규식) — hand 간선만. */
  cell?: string;
  /** LOOP_EDGE_MOVES 중 하나 — move 간선만. */
  move?: typeof LOOP_EDGE_MOVES[number];
  /** hand 간선만 — 원장 행 mode, 없으면 key 접두(`shadow:orch:` = shadow · `orch:` = live). 못 정하면 생략. */
  mode?: 'shadow' | 'live';
  /** hand 간선만 — 그 행을 쓴 오케스트레이터 틱 runId(ID 정규식). 없으면 생략. */
  tick?: string;
  /** live claimed 뒤 handed·released 없이 N분 지남 = 발사 실패(끊긴 넘김). ref = 오케스트레이터 카드 id. */
  broken?: true;
}

/** 노드 접두 — 조율 루프는 레지스트리 행 `loop:orchestrator` 그대로 쓴다. `queue:` 는 대기열 대체 간선 자리(조각 A 밖). */
export const TASK_AGENT_NODE = 'agent:task-agent';
export const ORCHESTRATOR_NODE = 'loop:orchestrator';

/** 한 런 원장에서 투영한 사실 — 문면은 feature(연결 비교 전용 · 응답에 싣지 않는다)뿐. */
export interface RunFact {
  runId: string;
  startAt?: string;
  seat?: string;
  feature?: string;
  goalId?: string;
  mergedAt?: string;
  prs: Array<{ at: string; number: number }>;
  children: string[];
}

/** handed.jsonl 행 투영 — status 가 없으면 handed 로 읽는다(조각 A 주입 호환). claimed·released 는 끊긴 간선 판정에만 쓴다. */
export interface HandedRow {
  at: string;
  cardId?: string;
  cell?: string;
  status?: 'claimed' | 'handed' | 'released';
  key?: string;
  mode?: 'shadow' | 'live';
  runId?: string;
}
export interface PodFinish { at: string; childRunId: string; prNumber: number }

export interface LoopEdgesDeps {
  listCoord?: typeof listCoordEvents;
  cardRoot?: string;
  ledgerDir?: string;
  listCards?: () => TaskCard[];
  listRunStarts?: (since: string) => Array<{ runId: string; at: string; seat: string; mergedAt?: string }>;
  listSeatRequests?: () => SeatRequestRow[];
  listOrchestratorLaunches?: () => Array<{ key: string; runId: string }>;
  listLoopOwners?: () => Array<{ id: string; owner?: string | null }>;
  seatIds?: () => string[];
  /** 기본 = `<root>/loop/orchestrator/handed.jsonl` · root = cardRoot ?? effectiveInstanceRoot(). */
  listHanded?: () => HandedRow[];
  /** live claimed 가 handed·released 없이 이만큼 지나면 끊긴 hand 간선(기본 10분). */
  handBrokenAfterMs?: number;
  /** 기본 = `<root>/task-agent-actions.json` 의 tasks(readTaskAgentState). */
  listTaskCards?: () => TaskAgentCard[];
  /** 기본 = ledgerDir(또는 연합 원장)에서 투영. listRunStarts 를 주입하고 이것을 안 주면 [] 다. */
  listRunFacts?: () => RunFact[];
  /** 대체 원천 — logs `self-implement.pod` `job-finished` 의 childRunId·prUrl(PR 번호만). */
  listPodFinishes?: (since: string) => PodFinish[];
}

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SURFACES = new Set(['telegram', 'pwa', 'linear', 'tui', 'discord', 'api', 'cli', 'voice', 'folder', 'wish']);
const KINDS: Record<string, LoopEdge['kind']> = { '요청': 'request', '결정': 'decision', '보고': 'report' };

function seat(value: unknown, seats: ReadonlySet<string>): value is string {
  return typeof value === 'string' && seats.has(value);
}
function surface(value: unknown): value is string {
  return typeof value === 'string' && SURFACES.has(value);
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(content: string): Record<string, unknown> | null {
  try { return object(JSON.parse(content) as unknown); } catch { return null; }
}
function inWindow(at: string, since: number, now: number): boolean {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= since && ms <= now;
}

type PlacedCell = { cardId: string; cellId: string; owner: string };

function cardEdges(card: TaskCard, since: number, now: number, seats: ReadonlySet<string>, placedCells: PlacedCell[]): LoopEdge[] {
  if (!card.goalId.startsWith('wish:') || !ID.test(card.id)) return [];
  const node = `card:${card.id}`;
  const ref = card.id;
  const edges: LoopEdge[] = [];
  const intake = card.sections.find(s => s.key === 'intake:wish:0');
  const intakeData = intake && parse(intake.content);
  if (intake && surface(intakeData?.source) && inWindow(intake.createdAt, since, now)) {
    edges.push({ at: intake.createdAt, kind: 'card', from: `surface:${intakeData.source}`, to: node, ref });
  }
  const split = card.sections.find(s => s.key === 'flow:split:0');
  const splitData = split && parse(split.content);
  const cells = Array.isArray(splitData?.cells) ? splitData.cells : [];
  const owners = new Map<string, string>();
  for (const item of cells) {
    const cell = object(item);
    if (typeof cell?.id === 'string' && ID.test(cell.id) && seat(cell.owner, seats)) owners.set(cell.id, cell.owner);
  }
  const placedOwners = new Set<string>();
  for (const section of card.sections) {
    if (!section.key.startsWith('flow:placed:')) continue;
    const cellId = section.key.slice('flow:placed:'.length);
    const saved = parse(section.content);
    const placement = object(saved?.decision);
    const owner = owners.get(cellId);
    if (!owner || !placement || placement.id !== cellId || !ID.test(cellId)
      || typeof placement.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(placement.version)) continue;
    placedOwners.add(owner);
    placedCells.push({ cardId: card.id, cellId, owner });
    if (inWindow(section.createdAt, since, now)) {
      const cellNode = `loop:${cellId}`;
      edges.push({ at: section.createdAt, kind: 'card', from: node, to: cellNode, ref });
      edges.push({ at: section.createdAt, kind: 'card', from: cellNode, to: owner, ref });
    }
  }
  const reply = card.sections.find(s => s.key === 'intake:reply:0');
  const replyData = reply && parse(reply.content);
  // The destination section alone is not a send; flow:result records a completed card flow.
  const result = card.sections.find(s => s.key === 'flow:result:0');
  if (result && reply && surface(replyData?.surface) && inWindow(result.createdAt, since, now)) {
    for (const owner of placedOwners) {
      edges.push({ at: result.createdAt, kind: 'card', from: owner, to: `surface:${replyData.surface}`, ref });
    }
  }
  return edges;
}

function runFacts(dir: string, owners: ReadonlyMap<string, string>, seats: ReadonlySet<string>): RunFact[] {
  if (!existsSync(dir)) return [];
  const result: RunFact[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!/^run-[a-zA-Z0-9-]+\.jsonl$/.test(name)) continue;
    const path = join(dir, name);
    try { if (!statSync(path).isFile() || statSync(path).size > 5 * 1024 * 1024) continue; }
    catch { continue; }
    const runId = name.slice(0, -6);
    let entries: RunLedgerEntry[] | null;
    try { entries = loadRunLedger(runId, dir); } catch { continue; }
    if (!entries) continue;
    const start = entries.find(entry => entry.event === 'start' && entry.runId === runId);
    const feature = typeof start?.data.feature === 'string' ? start.data.feature : '';
    const launchSeat = start?.data.launchSeat ?? start?.data.seat ?? owners.get(feature)
      ?? start?.data.originAgent ?? start?.data.controller;
    const merged = entries.find(entry => entry.event === 'merged' && entry.data.merged === true && typeof entry.timestamp === 'string');
    const goalId = [start, ...entries].map(entry => entry?.goalId ?? (typeof entry?.data.goalId === 'string' ? entry.data.goalId : undefined))
      .find((value): value is string => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value));
    // pr-opened data = {url, number, branch, …} (TC 실측 10-07) — 번호는 data.number(양의 정수)만 읽는다. 못 읽으면 간선 0.
    const prs = entries.filter(entry => entry.event === 'pr-opened' && typeof entry.timestamp === 'string'
      && Number.isSafeInteger(entry.data.number) && (entry.data.number as number) > 0)
      .map(entry => ({ at: entry.timestamp!, number: entry.data.number as number }));
    // `pod-ledger-incomplete` 첫 줄 원장은 시작이 없어도 버리지 않는다 — pr 근거로만 쓰고 run 단계는 만들지 않는다.
    const children = [...new Set(entries.filter(entry => entry.event === 'pod-child-run' && typeof entry.data.childRunId === 'string'
      && ID.test(entry.data.childRunId) && entry.data.childRunId !== runId).map(entry => entry.data.childRunId as string))];
    result.push({
      runId, prs, children,
      ...(start?.timestamp ? { startAt: start.timestamp } : {}),
      ...(start?.timestamp && seat(launchSeat, seats) ? { seat: launchSeat } : {}),
      ...(start?.timestamp && feature ? { feature } : {}),
      ...(goalId ? { goalId } : {}),
      ...(merged?.timestamp ? { mergedAt: merged.timestamp } : {}),
    });
  }
  return result;
}

function runStartsFrom(facts: readonly RunFact[], since: string): Array<{ runId: string; at: string; seat: string; mergedAt?: string }> {
  return facts.filter(fact => fact.startAt !== undefined && fact.seat !== undefined
    && (fact.startAt >= since || (fact.mergedAt !== undefined && fact.mergedAt >= since)))
    .map(fact => ({ runId: fact.runId, at: fact.startAt!, seat: fact.seat!, ...(fact.mergedAt ? { mergedAt: fact.mergedAt } : {}) }));
}

/** handed.jsonl(`tick.ts` ORCH-TA-HAND) — 행의 at·status·key·cardId·cell·mode·runId 만. 넘김은 handed 뿐이고 claimed·released 는 끊긴 간선 판정용이다. */
function handedRows(root: string): HandedRow[] {
  const path = join(root, 'loop', 'orchestrator', 'handed.jsonl');
  try { if (!existsSync(path) || statSync(path).size > 5 * 1024 * 1024) return []; } catch { return []; }
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const rows: HandedRow[] = [];
  for (const line of raw.split('\n')) {
    const row = line.trim() ? parse(line) : null;
    const status = row?.status;
    if ((status !== 'handed' && status !== 'claimed' && status !== 'released') || typeof row!.at !== 'string') continue;
    if (status === 'handed' && typeof row!.cardId !== 'string') continue;
    rows.push({
      at: row!.at as string, status,
      ...(typeof row!.cardId === 'string' ? { cardId: row!.cardId } : {}),
      ...(typeof row!.cell === 'string' ? { cell: row!.cell } : {}),
      ...(typeof row!.key === 'string' ? { key: row!.key } : {}),
      ...(row!.mode === 'shadow' || row!.mode === 'live' ? { mode: row!.mode } : {}),
      ...(typeof row!.runId === 'string' ? { runId: row!.runId } : {}),
    });
  }
  return rows;
}

function taskCards(root: string): TaskAgentCard[] {
  const tasks = object(readTaskAgentState<{ tasks?: unknown }>(join(root, 'task-agent-actions.json')).tasks);
  return tasks ? Object.values(tasks).filter((card): card is TaskAgentCard => object(card) !== null) : [];
}

/** 대체 원천: Pod 런은 도는 동안 원장이 Pod 안에만 있다 — 호스트 logs 의 job-finished 에서 childRunId·PR 번호만 읽는다. */
function podFinishes(since: string): PodFinish[] {
  const path = logsDbPath();
  if (!existsSync(path)) return [];
  const store = LogStore.openReadOnly(path);
  try {
    const result: PodFinish[] = [];
    for (const row of store.queryAll({ exactCategories: ['self-implement.pod'], events: ['job-finished'], sinceMs: Date.parse(since) })) {
      const data = row.data ? parse(row.data) : null;
      const pr = typeof data?.prUrl === 'string' ? /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/.exec(data.prUrl) : null;
      if (typeof data?.childRunId === 'string' && pr) result.push({ at: row.ts, childRunId: data.childRunId, prNumber: Number(pr[1]) });
    }
    return result;
  } finally { store.close(); }
}

/** Project only the key and runId of orchestrator launches, never their card snapshots or prose. */
function orchestratorLaunches(root: string): Array<{ key: string; runId: string }> {
  const dir = join(root, 'loop', 'orchestrator');
  if (!existsSync(dir)) return [];
  const launches: Array<{ key: string; runId: string }> = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile() || statSync(path).size > 5 * 1024 * 1024) continue;
      const state = parse(readFileSync(path, 'utf8'));
      if (state?.mode !== 'live' || !Array.isArray(state.launched)) continue;
      for (const item of state.launched) {
        const launch = object(item);
        if (typeof launch?.key === 'string' && typeof launch.runId === 'string') {
          launches.push({ key: launch.key, runId: launch.runId });
        }
      }
    } catch { /* An unreadable tick cannot establish a launch. */ }
  }
  return launches;
}

type JourneyLink = { from: string; to: string; both: boolean };
type Journey = { links: JourneyLink[]; pieces: Map<string, string[]> };

/** 런 원장 start.feature 는 `boundReadableText(feature, 120)` 로 잘린다(orchestrator.ts RUN_START_FEATURE_MAX_CHARS) —
 *  꼬리 표식 ` [truncated; originalChars=N]`·`[truncated]`·`…`(⊕ 손으로 쓴 `...`)을 떼고 공백을 정규화한다. */
const FEATURE_TRUNCATION_TAIL = /(?:\s*\[truncated(?:; originalChars=\d+)?\]|…|\.\.\.)$/;
const FEATURE_PREFIX_MIN = 40;
function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
/** 잘린 feature 의 비교 접두 — 표식이 없으면 undefined(완전 일치만). 끝의 짝 잃은 서로게이트도 뗀다(UTF-16 절단). */
function featurePrefix(feature: string): string | undefined {
  if (!FEATURE_TRUNCATION_TAIL.test(feature)) return undefined;
  const prefix = normalizeText(feature.replace(FEATURE_TRUNCATION_TAIL, '').replace(/[\ud800-\udbff]$/, ''));
  return prefix.length >= FEATURE_PREFIX_MIN ? prefix : undefined;
}
/** 카드 text ↔ 런 feature — 완전 일치, 또는 잘린 feature(≥40자)가 카드 text(공백 정규화)의 접두. */
function featureMatches(feature: string | undefined, text: string): boolean {
  if (!feature || !text) return false;
  if (feature === text) return true;
  const prefix = featurePrefix(feature);
  return prefix !== undefined && normalizeText(text).startsWith(prefix);
}

/** 카드 → 런 연결: 카드 runId(있으면 최우선) → goalId 일치 → feature 일치(완전 또는 잘린 접두) ∧ start ≥ launch.at — 뒤 둘은 «유일할 때만»
 *  (같은 feature 에 닿는 발사 카드가 둘이면 잇지 않는다). 자식 런(pod-child-run)은 부모로 닿는다. */
function linkedRun(card: TaskAgentCard, launchAt: string | undefined, launchedTexts: readonly string[], facts: readonly RunFact[], childIds: ReadonlySet<string>): string | undefined {
  const explicitRun = (card as { runId?: unknown }).runId;
  if (typeof explicitRun === 'string' && ID.test(explicitRun)) return explicitRun;
  const pick = (candidates: RunFact[]): string | undefined => {
    const top = candidates.filter(fact => !childIds.has(fact.runId));
    return top.length === 1 ? top[0]!.runId : candidates.length === 1 ? candidates[0]!.runId : undefined;
  };
  if (typeof card.goalId === 'string' && card.goalId) {
    const byGoal = pick(facts.filter(fact => fact.goalId === card.goalId));
    if (byGoal) return byGoal;
  }
  const launchMs = launchAt === undefined ? NaN : Date.parse(launchAt);
  if (!Number.isFinite(launchMs) || typeof card.text !== 'string' || !card.text) return undefined;
  const runId = pick(facts.filter(fact => featureMatches(fact.feature, card.text) && fact.startAt !== undefined && Date.parse(fact.startAt) >= launchMs));
  if (!runId) return undefined;
  const feature = facts.find(fact => fact.runId === runId)!.feature;
  return launchedTexts.filter(text => featureMatches(feature, text)).length === 1 ? runId : undefined;
}

/** hand 행의 mode — 행의 mode 필드가 우선, 없으면 key 접두(`shadow:orch:` = shadow · `orch:` = live). */
function handMode(row: HandedRow): 'shadow' | 'live' | undefined {
  if (row.mode === 'shadow' || row.mode === 'live') return row.mode;
  if (typeof row.key !== 'string') return undefined;
  if (row.key.startsWith('shadow:orch:')) return 'shadow';
  if (row.key.startsWith('orch:')) return 'live';
  return undefined;
}

/** 넘김(hand)·발사(launch)·런→PR·green 제안(move) 간선을 더하고, ?ref= 여정에 쓸 id 연결을 돌려준다. 문면은 싣지 않는다. */
function taskAgentEdges(deps: LoopEdgesDeps, facts: readonly RunFact[], seats: ReadonlySet<string>, since: number, now: number, sinceIso: string, edges: LoopEdge[]): Journey {
  // 주입된 카드 목록(시험)에 뿌리가 없으면 운영 뿌리를 읽지 않는다 — 공개본엔 bunfig preload 격리가 없다.
  const root = deps.cardRoot ?? (deps.listCards ? undefined : effectiveInstanceRoot());
  const journey: Journey = { links: [], pieces: new Map() };
  let handed: HandedRow[] = [];
  try { handed = (deps.listHanded ?? (() => root === undefined ? [] : handedRows(root)))(); } catch { /* An unreadable hand ledger hands nothing. */ }
  const settled = new Set<string>();
  for (const row of handed) if (row.key !== undefined && (row.status ?? 'handed') !== 'claimed') settled.add(row.key);
  const brokenAfter = deps.handBrokenAfterMs ?? 10 * 60 * 1000;
  const brokenKeys = new Set<string>();
  for (const row of handed) {
    const status = row.status ?? 'handed';
    const mode = handMode(row);
    const tick = typeof row.runId === 'string' && ID.test(row.runId) ? { tick: row.runId } : {};
    if (status === 'handed') {
      if (typeof row.cardId !== 'string' || !ID.test(row.cardId) || !inWindow(row.at, since, now)) continue;
      edges.push({ at: row.at, kind: 'hand', from: ORCHESTRATOR_NODE, to: TASK_AGENT_NODE, ref: row.cardId,
        ...(row.cell && ID.test(row.cell) ? { cell: row.cell } : {}), ...(mode ? { mode } : {}), ...tick });
      // 넘김 행의 cardId 는 TASK-AGENT 카드다 — 소원(wish) 카드는 key(`orch:<wish>:<칸>`)에만 있다. 둘을 잇지 않으면
      // `?ref=<wish>` 여정이 넘김에서 끊겨 데모 띠가 1단계 뒤로 «남음»에 멈춘다(10-07 리허설 2 실측 · JOURNEY-HAND-LINK).
      const wish = row.key === undefined ? undefined : /^orch:([^:]+):([^:]+)$/.exec(row.key)?.[1];
      if (wish !== undefined && ID.test(wish) && wish !== row.cardId) journey.links.push({ from: wish, to: row.cardId, both: true });
      continue;
    }
    // live claimed 만(handed·released 없음 · N분 지남) = 발사 실패 — 끊긴 간선 하나. shadow claimed→released 는 간선 0.
    if (status !== 'claimed' || mode !== 'live' || row.key === undefined || settled.has(row.key) || brokenKeys.has(row.key)) continue;
    const claimedMs = Date.parse(row.at);
    if (!Number.isFinite(claimedMs) || now - claimedMs < brokenAfter || !inWindow(row.at, since, now)) continue;
    const parts = /^orch:([^:]+):([^:]+)$/.exec(row.key);
    if (!parts || !ID.test(parts[1]!) || !ID.test(parts[2]!)) continue;
    brokenKeys.add(row.key);
    edges.push({ at: row.at, kind: 'hand', from: ORCHESTRATOR_NODE, to: TASK_AGENT_NODE, ref: parts[1]!, cell: parts[2]!, mode, ...tick, broken: true });
  }
  let cards: TaskAgentCard[] = [];
  try { cards = (deps.listTaskCards ?? (() => root === undefined ? [] : taskCards(root)))().filter(card => typeof card?.id === 'string' && ID.test(card.id)); }
  catch { /* An unreadable task-agent state launches nothing. */ }
  const launchesOf = (card: TaskAgentCard) => (Array.isArray(card.history) ? card.history : [])
    .filter(event => event?.event === 'launch' && typeof event.at === 'string');
  const launchedTexts: string[] = [];
  for (const card of cards) {
    if (launchesOf(card).length && typeof card.text === 'string') launchedTexts.push(card.text);
  }
  const childIds = new Set(facts.flatMap(fact => fact.children));
  for (const card of cards) {
    if (typeof card.mission === 'string' && ID.test(card.mission)) journey.links.push({ from: card.id, to: card.mission, both: false });
    if (Array.isArray(card.pieces)) journey.pieces.set(card.id, card.pieces.filter(piece => typeof piece === 'string' && ID.test(piece)));
    const launches = launchesOf(card);
    for (const launch of launches) {
      if (seat(card.seat, seats) && inWindow(launch.at, since, now)) edges.push({ at: launch.at, kind: 'launch', from: TASK_AGENT_NODE, to: card.seat, ref: card.id });
    }
    const runId = linkedRun(card, launches[0]?.at, launchedTexts, facts, childIds);
    if (runId) journey.links.push({ from: card.id, to: runId, both: true });
    const green = object(card.greenProposal);
    if (green && typeof green.at === 'string' && typeof green.checklistId === 'string' && ID.test(green.checklistId) && inWindow(green.at, since, now)) {
      edges.push({ at: green.at, kind: 'move', from: TASK_AGENT_NODE, to: `release:${green.checklistId}`, ref: card.id, move: 'green-proposal' });
    }
  }
  const prSeen = new Set<string>();
  const prEdge = (runId: string, at: string, number: number) => {
    const key = `${runId}:${number}`;
    if (!ID.test(runId) || !Number.isSafeInteger(number) || number < 1 || prSeen.has(key) || !inWindow(at, since, now)) return;
    prSeen.add(key);
    edges.push({ at, kind: 'run', from: `loop:${runId}`, to: `pr:${number}`, ref: runId });
  };
  for (const fact of facts) {
    for (const child of fact.children) journey.links.push({ from: fact.runId, to: child, both: true });
    for (const pr of fact.prs) prEdge(fact.runId, pr.at, pr.number);
  }
  let pods: PodFinish[] = [];
  // 대체 원천은 연합 원장(운영 기본)과 짝이다 — 원장을 주입했으면(시험·한 디렉터리) logs 를 읽지 않는다.
  const injectedLedger = deps.ledgerDir !== undefined || deps.listRunStarts !== undefined || deps.listRunFacts !== undefined;
  try { pods = (deps.listPodFinishes ?? (injectedLedger ? () => [] : podFinishes))(sinceIso); } catch { /* logs outage — the run ledger stays the primary source. */ }
  for (const pod of pods) prEdge(pod.childRunId, pod.at, pod.prNumber);
  return journey;
}

/** ?ref= 의 여정 id 집합 — 카드↔런·런↔자식 런은 양방향, 조각→미션은 위로만(형제 조각은 미션을 ref 로 줄 때만). */
function journeyIds(ref: string, journey: Journey): Set<string> {
  const ids = new Set([ref, ...(journey.pieces.get(ref) ?? [])]);
  const queue = [...ids];
  while (queue.length) {
    const id = queue.shift()!;
    for (const link of journey.links) {
      const next = link.from === id ? link.to : link.both && link.to === id ? link.from : undefined;
      if (next !== undefined && !ids.has(next)) { ids.add(next); queue.push(next); }
    }
  }
  return ids;
}

/** GET only; project an allowlist of fields from the ledgers. Never serialize ledger records. */
export function handleLoopEdgesGet(req: Request, deps: LoopEdgesDeps = {}): Response {
  const params = new URL(req.url).searchParams;
  const rawSince = params.get('since');
  const journeyRef = params.get('ref');
  // ?mode=live|shadow — hand 간선만 그 mode 로 거른다(다른 종류 간선은 그대로).
  const handModeFilter = params.get('mode');
  // ?ref= 는 한 카드·런의 여정 — 60분 창과 limit 에 잘리지 않게 since 를 안 주면 처음부터 본다.
  const since = rawSince === null ? (journeyRef === null ? Date.now() - 60 * 60 * 1000 : 0) : Date.parse(rawSince);
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  const now = Date.now();
  if (rawSince !== null && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rawSince)
    || !Number.isFinite(since) || since > now || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || (journeyRef !== null && !ID.test(journeyRef))
    || (handModeFilter !== null && handModeFilter !== 'live' && handModeFilter !== 'shadow')) {
    return jsonResponse({ error: 'usage: GET /v1/loops/edges?since=<ISO>&limit=<1..500>&ref=<card|run|mission id>' }, 400);
  }
  const sinceIso = new Date(since).toISOString();
  const seats = new Set((deps.seatIds ?? (() => [...SEATS.map(s => s.seat), ...listSubSeatCharters().map(s => s.id)]))());
  const edges: LoopEdge[] = [];
  for (const event of (deps.listCoord ?? listCoordEvents)({ since: sinceIso, channelOnly: true })) {
    if (!seat(event.refs.seat, seats) || !inWindow(event.at, since, now)) continue;
    const kind = KINDS[event.refs.kind ?? ''];
    if (!kind || !Array.isArray(event.refs.recipients)) continue;
    const ref = typeof event.refs.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+#issuecomment-\d+$/.test(event.refs.url)
      ? event.refs.url : event.id;
    if (!ID.test(ref) && !ref.startsWith('https://github.com/')) continue;
    for (const recipient of new Set(event.refs.recipients)) {
      if (seat(recipient, seats)) edges.push({ at: event.at, kind, from: event.refs.seat, to: recipient, ref });
    }
  }
  const placedCells: PlacedCell[] = [];
  if (deps.listCards) {
    for (const card of deps.listCards()) edges.push(...cardEdges(card, since, now, seats, placedCells));
  } else {
    const root = deps.cardRoot;
    if (existsSync(cardIndexPath(root))) {
      const store = new CardStore(root, true);
      try { for (const card of store.listCards()) edges.push(...cardEdges(card, since, now, seats, placedCells)); }
      finally { store.close(); }
    }
  }
  const readFacts = deps.listRunFacts ?? (deps.listRunStarts ? () => [] : () => {
    const owners = new Map<string, string>();
    try {
      for (const entry of (deps.listLoopOwners ?? (() => listLoops()))()) {
        if (seat(entry.owner, seats)) owners.set(entry.id, entry.owner);
      }
    } catch { /* A registry outage does not erase explicit launch-seat evidence. */ }
    return (deps.ledgerDir ? [deps.ledgerDir] : resolveFederatedRunLedgerDirectories({ includeTest: false }))
      .flatMap(dir => runFacts(dir, owners, seats));
  });
  let facts: RunFact[] = [];
  try { facts = readFacts().filter(fact => ID.test(fact.runId)); } catch { /* An unreadable ledger set links nothing. */ }
  const readStarts = deps.listRunStarts ?? ((from: string) => runStartsFrom(facts, from));
  const runs = readStarts(sinceIso).filter(run => seat(run.seat, seats) && ID.test(run.runId)
    && (inWindow(run.at, since, now) || (run.mergedAt !== undefined && inWindow(run.mergedAt, since, now))));
  for (const run of runs) {
    if (inWindow(run.at, since, now)) edges.push({ at: run.at, kind: 'run', from: run.seat, to: `loop:${run.runId}`, ref: run.runId });
  }
  if (placedCells.length && runs.length) {
    const root = deps.cardRoot ?? effectiveInstanceRoot();
    let requests: SeatRequestRow[] = [];
    let launches: Array<{ key: string; runId: string }> = [];
    try { requests = (deps.listSeatRequests ?? (() => listSeatRequests(root)))(); } catch { /* Missing request evidence is not a match. */ }
    try { launches = (deps.listOrchestratorLaunches ?? (() => orchestratorLaunches(root)))(); } catch { /* Missing launch evidence is not a match. */ }
    const confirmed = new Set(launches.filter(item => ID.test(item.runId) && runs.some(run => run.runId === item.runId))
      .map(item => JSON.stringify([item.key, item.runId])));
    for (const cell of placedCells) {
      const key = `orch:${cell.cardId}:${cell.cellId}`;
      if (!requests.some(row => row.key === key && row.cell === cell.cellId && row.source === 'orchestrator' && row.seat === cell.owner)) continue;
      for (const run of runs) {
        if (run.seat !== cell.owner || !confirmed.has(JSON.stringify([key, run.runId]))) continue;
        if (inWindow(run.at, since, now)) edges.push({ at: run.at, kind: 'card', from: cell.owner, to: `loop:${run.runId}`, ref: cell.cardId });
        if (run.mergedAt && inWindow(run.mergedAt, since, now)) {
          edges.push({ at: run.mergedAt, kind: 'card', from: `loop:${run.runId}`, to: `landed:${cell.cellId}`, ref: cell.cardId });
        }
      }
    }
  }
  const links = taskAgentEdges(deps, facts, seats, since, now, sinceIso, edges);
  const journey = journeyRef === null ? null : journeyIds(journeyRef, links);
  const out = edges.filter(edge => (!journey || journey.has(edge.ref))
    && (handModeFilter === null || edge.kind !== 'hand' || edge.mode === handModeFilter));
  out.sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return jsonResponse({ edges: out.slice(0, limit) });
}
