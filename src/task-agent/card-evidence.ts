/**
 * TA-CARD-RUN-LINK — 과제 카드의 런 id 로 그 런이 연 골 id · PR 을 런 원장에서 읽어 카드에 «한 번» 적는다.
 * - 순수 판정 `bindCardEvidence(card, snapshot)` — 호스트 원장 → Pod 자식 원장(`pod-child-run`) → 호스트 logs 의
 *   `self-implement.pod job-finished {childRunId, prUrl}` 순. 모르면 비운다(추측하지 않는다).
 * - `refreshCardRunBinding` 은 `tasks show`·`tasks advance` 가 부른다 — 읽기 조회이고, 찾았을 때만 잠금 안에서 카드의
 *   `goalId`·`pr {number,url}`(UX LOOP-INTERACT 계약 칸)을 비어 있을 때만 적는다 · 수동 근거(refSource manual)는 덮지 않는다.
 * - 관측: `debug.log('task-agent', 'card-pr-bound', {card, runId, pr})`.
 */
import { existsSync } from 'node:fs';
import { debug } from '../debug/log.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import { cardPrNumber, taskAgentStatePath, updateTaskCard, readTaskCard, type TaskCard } from './task-hand.js';

const GOAL_ID = /^[a-f0-9]{16}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const RUN_ID = /^run-[A-Za-z0-9_-]{4,64}$/;

/** 카드 런 하나의 원장 사진 — host = 카드 런 원장(없으면 null) · children = `pod-child-run` 자식 원장 · podFinishes = 호스트 logs. */
export interface CardRunSnapshot {
  host: readonly RunLedgerEntry[] | null;
  children: Readonly<Record<string, readonly RunLedgerEntry[] | null>>;
  podFinishes?: ReadonlyArray<{ childRunId: string; prUrl: string }>;
  /** 읽기 «실패»(원장·logs) — 부재(null)와 갈린다. 있으면 refresh 가 card-bind-failed 를 남긴다. */
  readErrors?: readonly string[];
}

export interface CardRunEvidence {
  goalId?: string;
  pr?: { number: number; url?: string };
  childRunId?: string;
  /** 호스트 원장이 있었나 — 없으면 런이 아직 시작 전이거나 대기열로 갔다. */
  ledgerFound: boolean;
}

function entryGoal(entry: RunLedgerEntry): string | undefined {
  const value = entry.goalId ?? (typeof entry.data?.goalId === 'string' ? entry.data.goalId : undefined);
  return typeof value === 'string' && GOAL_ID.test(value) ? value : undefined;
}

/**
 * 그 PR 의 골 id — PR 의 `pr-opened` 줄 골이 먼저. 없으면 원장 전체의 골이 «하나뿐»이고 다른 PR 줄이 골을 싣지 않았을 때만
 * 그 골(대응이 모호하면 비운다 — set-once 라 틀린 짝은 못 고친다).
 */
function goalIdOf(entries: readonly RunLedgerEntry[], prNumber: number): string | undefined {
  const own = [...entries].reverse().find((entry) => entry.event === 'pr-opened' && entry.data?.number === prNumber && entryGoal(entry));
  if (own) return entryGoal(own);
  if (entries.some((entry) => entry.event === 'pr-opened' && entry.data?.number !== prNumber && entryGoal(entry))) return undefined;
  const goals = new Set(entries.map(entryGoal).filter((value): value is string => value !== undefined));
  return goals.size === 1 ? [...goals][0] : undefined;
}

function lastPr(entries: readonly RunLedgerEntry[]): { number: number; url?: string } | undefined {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at]!;
    if (entry.event !== 'pr-opened') continue;
    const number = entry.data?.number;
    if (!Number.isSafeInteger(number) || (number as number) <= 0) continue;
    const url = typeof entry.data.url === 'string' && PR_URL.exec(entry.data.url)?.[1] === String(number) ? entry.data.url : undefined;
    return { number: number as number, ...(url ? { url } : {}) };
  }
  return undefined;
}

/** 자식 런 id — 호스트 원장의 `pod-child-run` 만(호스트 런 자신은 빼고 · 순서 유지). */
export function podChildRunIds(host: readonly RunLedgerEntry[] | null, runId?: string): string[] {
  return [...new Set((host ?? []).filter((entry) => entry.event === 'pod-child-run' && typeof entry.data?.childRunId === 'string'
    && RUN_ID.test(entry.data.childRunId) && entry.data.childRunId !== runId).map((entry) => entry.data.childRunId as string))];
}

/** 순수 — 카드 런의 골 id · PR. PR 은 호스트 → 자식(나중 자식 먼저) → job-finished 순으로 처음 찾은 것. */
export function bindCardEvidence(card: Pick<TaskCard, 'runId'>, snapshot: CardRunSnapshot): CardRunEvidence {
  if (!card.runId || !snapshot.host) return { ledgerFound: false };
  const children = podChildRunIds(snapshot.host, card.runId).reverse();
  const childLedgers = children.map((id) => [id, snapshot.children[id] ?? null] as const);
  let pr = lastPr(snapshot.host);
  let childRunId: string | undefined;
  for (const [id, entries] of childLedgers) {
    if (pr) break;
    const found = entries ? lastPr(entries) : undefined;
    if (found) { pr = found; childRunId = id; }
  }
  for (const id of children) {
    if (pr) break;
    const finish = [...(snapshot.podFinishes ?? [])].reverse().find((row) => row.childRunId === id && PR_URL.test(row.prUrl));
    const number = finish ? Number(PR_URL.exec(finish.prUrl)![1]) : NaN;
    if (finish && Number.isSafeInteger(number) && number > 0) { pr = { number, url: finish.prUrl }; childRunId = id; }
  }
  // 골 id 는 PR 을 낸 런의 것뿐이고 PR 과 함께만 — 자식이 냈으면 그 자식 원장의 골(아직 없으면 비움 · 나중 조회가 채운다),
  // 호스트가 냈으면 호스트 골. PR 전에는 누가 낼지 모르니 골도 묶지 않는다(set-once 라 섞이면 못 고친다).
  const childGoal = (id: string) => { const entries = snapshot.children[id]; return entries && pr ? goalIdOf(entries, pr.number) : undefined; };
  const goalId = pr ? (childRunId ? childGoal(childRunId) : goalIdOf(snapshot.host, pr.number)) : undefined;
  return { ledgerFound: true, ...(goalId ? { goalId } : {}), ...(pr ? { pr } : {}), ...(childRunId ? { childRunId } : {}) };
}

/** 원장·logs 읽기(시험 주입). */
export interface CardRunEvidenceDeps {
  loadLedger?: (runId: string) => RunLedgerEntry[] | null;
  podFinishes?: (childRunIds: readonly string[], sinceIso: string) => Array<{ childRunId: string; prUrl: string }>;
  now?: () => Date;
}

async function defaultLoadLedger(): Promise<(runId: string) => RunLedgerEntry[] | null> {
  const { loadRunLedger, runLedgerDir, resolveFederatedRunLedgerDirectories } = await import('../self-implement/run-ledger.js');
  let dirs: string[] = [runLedgerDir()];
  // 연합 목록을 못 읽으면 이 우주만 읽되, 여기서 못 찾으면 «없음»이 아니라 실패로 올린다(card-bind-failed).
  let federationFailure: unknown;
  try { dirs = [...new Set([...dirs, ...resolveFederatedRunLedgerDirectories({})])]; } catch (error) { federationFailure = new Error(`federated run-ledger lookup failed: ${error instanceof Error ? error.message : String(error)}`); }
  return ledgerLoader(dirs, (runId, dir) => loadRunLedger(runId, dir), federationFailure);
}

/** 디렉터리들에서 첫 원장 — 어디서도 못 찾았고 읽기(또는 연합 목록) 실패가 있었으면 부재(null)가 아니라 던진다. */
export function ledgerLoader(dirs: readonly string[], load: (runId: string, dir: string) => RunLedgerEntry[] | null, priorFailure?: unknown): (runId: string) => RunLedgerEntry[] | null {
  return (runId) => {
    let failure: unknown = priorFailure;
    for (const dir of dirs) {
      try { const entries = load(runId, dir); if (entries) return entries; } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
    return null;
  };
}

async function defaultPodFinishes(): Promise<NonNullable<CardRunEvidenceDeps['podFinishes']>> {
  const { LogStore, logsDbPath } = await import('../mss/logging/log-store.js');
  return (childRunIds, sinceIso) => {
    const path = logsDbPath();
    if (!childRunIds.length || !existsSync(path)) return [];
    const store = LogStore.openReadOnly(path);
    try {
      const wanted = new Set(childRunIds);
      const rows: Array<{ childRunId: string; prUrl: string }> = [];
      const sinceMs = Date.parse(sinceIso);
      for (const row of store.queryAll({ exactCategories: ['self-implement.pod'], events: ['job-finished'], ...(Number.isFinite(sinceMs) ? { sinceMs } : {}) })) {
        let data: { childRunId?: unknown; prUrl?: unknown } | null = null;
        try { data = row.data ? JSON.parse(row.data) : null; } catch { continue; }
        if (typeof data?.childRunId === 'string' && wanted.has(data.childRunId) && typeof data.prUrl === 'string') rows.push({ childRunId: data.childRunId, prUrl: data.prUrl });
      }
      return rows;
    } finally { store.close(); }
  };
}

/** 카드 런의 원장 사진을 읽는다 — 읽기 실패는 «없음»(null)이다. */
export async function readCardRunSnapshot(card: Pick<TaskCard, 'runId' | 'createdAt'>, deps: CardRunEvidenceDeps = {}): Promise<CardRunSnapshot> {
  if (!card.runId) return { host: null, children: {} };
  const load = deps.loadLedger ?? await defaultLoadLedger();
  const readErrors: string[] = [];
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const safe = (runId: string) => { try { return load(runId); } catch (error) { readErrors.push(`ledger ${runId}: ${reason(error)}`); return null; } };
  const host = safe(card.runId);
  const childIds = podChildRunIds(host, card.runId);
  const children = Object.fromEntries(childIds.map((id) => [id, safe(id)]));
  let podFinishes: Array<{ childRunId: string; prUrl: string }> = [];
  const missing = childIds.filter((id) => !children[id] || !lastPr(children[id]!));
  if (missing.length && (!host || !lastPr(host))) {
    try { podFinishes = (deps.podFinishes ?? await defaultPodFinishes())(missing, card.createdAt); } catch (error) { readErrors.push(`logs: ${reason(error)}`); }
  }
  return { host, children, podFinishes, ...(readErrors.length ? { readErrors } : {}) };
}

/**
 * 카드에 런 근거를 채운다 — 런 id 가 있고 아직 비어 있는 칸(goalId·pr)만, 잠금 안에서 «한 번».
 * 찾지 못했으면 쓰지 않는다. 쓴(또는 그대로인) 카드를 돌려준다.
 */
export async function refreshCardRunBinding(cardId: string, statePath = taskAgentStatePath(), deps: CardRunEvidenceDeps = {}): Promise<{ card: TaskCard | undefined; evidence?: CardRunEvidence }> {
  const card = readTaskCard(cardId, statePath);
  // 수동 근거(refSource manual)는 덮지 않는다 · 둘 다 차 있으면 다시 읽지 않는다(한 번만).
  if (!card?.runId || card.refSource === 'manual' || (card.pr !== undefined && card.goalId !== undefined)) return { card };
  const snapshot = await readCardRunSnapshot(card, deps);
  if (snapshot.readErrors?.length) {
    try { debug.log('task-agent', 'card-bind-failed', { card: cardId, runId: card.runId, errors: snapshot.readErrors }); } catch { /* fail-soft */ }
  }
  const evidence = bindCardEvidence(card, snapshot);
  // 이미 묶인 PR 이 있으면 «같은» PR(번호 ⊕ 낸 자식)을 다시 찾았을 때만 뒤늦은 골을 채운다.
  const samePr = (current: TaskCard) => current.pr === undefined
    || (evidence.pr !== undefined && cardPrNumber(current) === evidence.pr.number && current.runChildId === evidence.childRunId);
  const wantsGoal = card.goalId === undefined && evidence.goalId && samePr(card);
  const wantsPr = card.pr === undefined && evidence.pr;
  if (!wantsGoal && !wantsPr) return { card, evidence };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const wrote = { pr: false };
  const next = updateTaskCard(statePath, cardId, (current) => {
    if (!current || current.runId !== card.runId || current.refSource === 'manual') return undefined;
    const goal = current.goalId === undefined && evidence.goalId && samePr(current) ? evidence.goalId : undefined;
    const pr = current.pr === undefined && evidence.pr ? evidence.pr : undefined;
    if (!goal && !pr) return undefined;
    wrote.pr = pr !== undefined;
    return {
      ...current,
      ...(goal ? { goalId: goal } : {}),
      ...(pr ? { pr, ...(evidence.childRunId && !current.runChildId ? { runChildId: evidence.childRunId } : {}) } : {}),
      history: [
        ...(current.history ?? []),
        ...(goal ? [{ at, event: 'goal-bound', detail: goal, runId: current.runId! }] : []),
        ...(pr ? [{ at, event: 'pr-bound', detail: pr.url ?? `#${pr.number}`, runId: current.runId!, pr: pr.number }] : []),
      ],
    };
  });
  if (wrote.pr && typeof next?.pr === 'object') {
    try { debug.log('task-agent', 'card-pr-bound', { card: cardId, runId: next.runId ?? null, pr: next.pr.number, url: next.pr.url ?? null, childRunId: next.runChildId ?? null }); } catch { /* fail-soft */ }
  }
  return { card: next, evidence };
}
