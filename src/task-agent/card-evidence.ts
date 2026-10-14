/**
 * TA-CARD-RUN-LINK — 과제 카드의 런 id 로 그 런이 연 골 id · PR 을 런 원장에서 읽어 카드에 «한 번» 적는다.
 * - 순수 판정 `bindCardEvidence(card, snapshot)` — 호스트 원장 → Pod 자식 원장(`pod-child-run`) → 호스트 logs 의
 *   `self-implement.pod job-finished {childRunId, prUrl}` 순. 모르면 비운다(추측하지 않는다).
 * - `refreshCardRunBinding` 은 `tasks show`·`tasks advance` 가 부른다 — 읽기 조회이고, 찾았을 때만 잠금 안에서 카드의
 *   `goalId`·`pr {number,url}`(UX LOOP-INTERACT 계약 칸)을 비어 있을 때만 적는다 · 수동 근거(refSource manual)는 덮지 않는다.
 * - 관측: `debug.log('task-agent', 'card-pr-bound', {card, runId, pr})`.
 */
import { existsSync } from 'node:fs';
import { STOP_CLASS_POD_FAILURE, STOP_CLASS_NO_LAUNCH } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import { readLaunchBinding } from '../harness/launch-registry.js';
import { readRunExits, type RunExit } from '../harness/harness-incidents.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';
import { appendRunLedgerEntry, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { cardPrNumber, taskAgentStatePath, updateTaskCard, readTaskCard, type TaskCard } from './task-hand.js';
import { judgeNextMove, type TaskJudgeInput } from './judge.js';
import { remoteParentAlive, type SshRunner } from './parent-host.js';
import { notifyRemoteFailure, remoteFailureReason } from './failure-notify.js';

const GOAL_ID = /^[a-f0-9]{16}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const RUN_ID = /^run-[A-Za-z0-9_-]{4,64}$/;
const LATE_LAUNCH_FAILURE = 'failed/needs-relaunch — card-run-bound 뒤 10분 동안 Pod 발사 근거 없음';

/** 카드 런 하나의 원장 사진 — host = 카드 런 원장(없으면 null) · children = `pod-child-run` 자식 원장 · podFinishes = 호스트 logs. */
export interface CardRunSnapshot {
  host: readonly RunLedgerEntry[] | null;
  children: Readonly<Record<string, readonly RunLedgerEntry[] | null>>;
  podFinishes?: ReadonlyArray<{ childRunId: string; prUrl: string; state?: string; childError?: string }>;
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

/** DRAFT-NOT-ARCHIVE — 원장의 마지막 `salvaged`(self-implement.draft-not-archive) 줄이 남긴 수확 가지. 없으면 undefined. */
export function salvageBranchOf(entries: readonly RunLedgerEntry[] | null | undefined): string | undefined {
  return lastSalvaged(entries)?.branch;
}

function lastSalvaged(entries: readonly RunLedgerEntry[] | null | undefined): { branch: string; at: number; order: number } | undefined {
  for (let at = (entries?.length ?? 0) - 1; at >= 0; at--) {
    const entry = entries![at]!;
    const branch = entry.event === 'salvaged' ? entry.data?.salvageBranch : undefined;
    if (typeof branch === 'string' && branch.startsWith('salvage/')) return { branch, at: Date.parse(entry.timestamp ?? ''), order: at };
  }
  return undefined;
}

/** 카드 런(호스트 → 자식 나중 것부터)의 수확 가지. 원장을 못 읽었으면 `readErrors` 로 갈린다(⛔ «없음» 이 아니다). */
export async function readCardSalvageBranch(card: Pick<TaskCard, 'runId' | 'createdAt'>, deps: CardRunEvidenceDeps = {}): Promise<{ salvageBranch: string | null; readErrors?: readonly string[] }> {
  if (!card.runId) return { salvageBranch: null };
  const snapshot = await readCardRunSnapshot(card, { ...deps, podFinishes: () => [] });
  // 호스트 ⊕ Pod 자식 원장 전체에서 «가장 나중»(타임스탬프) 수확 가지. 시각이 같거나 못 읽으면 호스트가 이긴다.
  const candidates = [lastSalvaged(snapshot.host), ...podChildRunIds(snapshot.host, card.runId).map((id) => lastSalvaged(snapshot.children[id]))]
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  const latest = candidates.reduce<typeof candidates[number] | undefined>((best, row) => !best || (Number.isFinite(row.at) && (!Number.isFinite(best.at) || row.at > best.at)) ? row : best, undefined);
  return { salvageBranch: latest?.branch ?? null, ...(snapshot.readErrors?.length ? { readErrors: snapshot.readErrors } : {}) };
}

/** 원장·logs 읽기(시험 주입). */
export interface CardRunEvidenceDeps {
  loadLedger?: (runId: string) => RunLedgerEntry[] | null;
  podFinishes?: (childRunIds: readonly string[], sinceIso: string) => Array<{ childRunId: string; prUrl: string; state?: string; childError?: string }>;
  now?: () => Date;
  launchBound?: (runId: string) => boolean;
  dispatchPod?: (runId: string, sinceIso: string) => boolean;
  runExit?: (runId: string) => RunExit | undefined;
  ssh?: SshRunner;
  /** Isolated tests can put incident messages in their own mailbox; production uses the resolved default store. */
  incidentStorePath?: string;
}

async function defaultLoadLedger(): Promise<(runId: string) => RunLedgerEntry[] | null> {
  const { loadRunLedger, runLedgerDir, resolveFederatedRunLedgerDirectories } = await import('../self-implement/run-ledger.js');
  let dirs: string[] = [runLedgerDir()];
  // 연합 목록을 못 읽으면 이 우주만 읽되, 여기서 못 찾으면 «없음»이 아니라 실패로 올린다(card-bind-failed).
  let federationFailure: unknown;
  try { dirs = [...new Set([...dirs, ...resolveFederatedRunLedgerDirectories({})])]; } catch (error) { federationFailure = new Error(`federated run-ledger lookup failed: ${error instanceof Error ? error.message : String(error)}`); }
  // HARNESS-PARENT-ON-MSB1: 원격 부모 런의 원장 거울(`tasks show` 가 ssh 로 당긴다) — 이 우주 ⊕ 연합 «뒤»에만 붙는다.
  try {
    const { remoteLedgerMirrorDirs } = await import('./parent-host.js');
    dirs = [...new Set([...dirs, ...remoteLedgerMirrorDirs(effectiveInstanceRoot())])];
  } catch { /* 거울이 없으면 종전 그대로 */ }
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

function defaultDispatchPod(runId: string, sinceIso: string): boolean {
  const path = logsDbPath();
  if (!existsSync(path)) return false;
  const store = LogStore.openReadOnly(path);
  try {
    const sinceMs = Date.parse(sinceIso);
    return store.queryAll({ exactCategories: ['harness.substrate'], events: ['dispatch-pod'], ...(Number.isFinite(sinceMs) ? { sinceMs } : {}) })
      .some((row) => { try { return (JSON.parse(row.data ?? '{}') as { runId?: string }).runId === runId; } catch { return false; } });
  } finally { store.close(); }
}

async function defaultPodFinishes(): Promise<NonNullable<CardRunEvidenceDeps['podFinishes']>> {
  return (childRunIds, sinceIso) => {
    const path = logsDbPath();
    if (!childRunIds.length || !existsSync(path)) return [];
    const store = LogStore.openReadOnly(path);
    try {
      const wanted = new Set(childRunIds);
      const rows: Array<{ childRunId: string; prUrl: string; state?: string; childError?: string }> = [];
      const sinceMs = Date.parse(sinceIso);
      for (const row of store.queryAll({ exactCategories: ['self-implement.pod'], events: ['job-finished'], ...(Number.isFinite(sinceMs) ? { sinceMs } : {}) })) {
        let data: { childRunId?: unknown; prUrl?: unknown; state?: unknown; childError?: unknown } | null = null;
        try { data = row.data ? JSON.parse(row.data) : null; } catch { continue; }
        if (typeof data?.childRunId === 'string' && wanted.has(data.childRunId)) rows.push({ childRunId: data.childRunId, prUrl: typeof data.prUrl === 'string' ? data.prUrl : '', ...(typeof data.state === 'string' ? { state: data.state } : {}), ...(typeof data.childError === 'string' ? { childError: data.childError } : {}) });
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
  let podFinishes: NonNullable<CardRunSnapshot['podFinishes']> = [];
  if (childIds.length && (!host || !lastPr(host))) {
    try { podFinishes = (deps.podFinishes ?? await defaultPodFinishes())(childIds, card.createdAt); } catch (error) { readErrors.push(`logs: ${reason(error)}`); }
  }
  return { host, children, podFinishes, ...(readErrors.length ? { readErrors } : {}) };
}

/**
 * 카드에 런 근거를 채운다 — 런 id 가 있고 아직 비어 있는 칸(goalId·pr)만, 잠금 안에서 «한 번».
 * 찾지 못했으면 쓰지 않는다. 쓴(또는 그대로인) 카드를 돌려준다.
 */
export async function refreshCardRunBinding(cardId: string, statePath = taskAgentStatePath(), deps: CardRunEvidenceDeps = {}): Promise<{ card: TaskCard | undefined; evidence?: CardRunEvidence }> {
  let card = readTaskCard(cardId, statePath);
  // 수동 근거(refSource manual)는 아래 바인딩에서 덮지 않는다. 원격 부모의 확정 실패는
  // 수동 근거가 있어도 읽어야 하므로 여기서 반환하지 않는다.
  // 둘 다 차 있으면 다시 읽지 않는다(한 번만) — 단 «10분 발사 근거 없음»으로 failed 된 카드는
  // PR·골이 먼저 묶였어도 되살림 판정을 계속 받는다.
  const awaitingRevival = card?.status === 'failed' && [...card.history].reverse().find((item) => item.event === 'failed')?.detail === LATE_LAUNCH_FAILURE;
  if (!card?.runId || (card.pr !== undefined && card.goalId !== undefined && !awaitingRevival)) return { card };
  const runId = card.runId;
  // A stale HQ mirror cannot prove a terminal remote failure. Refresh it here as well as in `tasks show`,
  // since mission advance and direct callers also reach this function.
  if (card.parentHost && !deps.loadLedger) {
    try {
      const { mirrorRemoteRunLedgers } = await import('./parent-host.js');
      mirrorRemoteRunLedgers(card.parentHost, runId, effectiveInstanceRoot(), deps.ssh);
    } catch (error) {
      try { debug.log('task-agent', 'card-bind-failed', { card: cardId, runId, reason: `remote ledger refresh failed: ${error instanceof Error ? error.message : String(error)}` }); } catch { /* fail-soft */ }
      return { card };
    }
  }
  const snapshot = await readCardRunSnapshot(card, deps);
  if (snapshot.readErrors?.length) {
    try { debug.log('task-agent', 'card-bind-failed', { card: cardId, runId: card.runId, errors: snapshot.readErrors }); } catch { /* fail-soft */ }
  }
  const evidence = bindCardEvidence(card, snapshot);
  const remoteReason = remoteFailureReason(card, snapshot, evidence, deps.ssh);
  if (remoteReason && (card.status === 'launched' || card.status === 'failed')) {
    if (card.status === 'launched') {
      const at = (deps.now ?? (() => new Date()))().toISOString();
      card = updateTaskCard(statePath, cardId, (current) => current?.status === 'launched' && current.runId === runId && !current.pr
        ? { ...current, status: 'failed', history: [...current.history, { at, event: 'failed', detail: `failed/needs-owner — ${remoteReason}`, runId }] }
        : undefined) ?? card;
    }
    // An older generic Pod/no-launch failure may have closed this same run before its supervisor tail arrived.
    // The terminal evidence still warrants an incident; message provenance keeps retries at one row.
    const lastFailure = [...card.history].reverse().find((row) => row.event === 'failed');
    if (card.status === 'failed' && lastFailure?.runId === runId && !card.history.some((row) => row.event === 'closed-by-hand')) {
      try { notifyRemoteFailure(card, remoteReason, deps.incidentStorePath); }
      catch (error) { try { debug.log('task-agent', 'failure-notify-failed', { card: cardId, runId, reason: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ } }
      return { card, evidence };
    }
  }
  let revived = false;
  const lastFailure = [...card.history].reverse().find((item) => item.event === 'failed');
  if (card.status === 'failed' && lastFailure?.event === 'failed' && lastFailure.detail === LATE_LAUNCH_FAILURE
    && lastFailure.runId === runId && !snapshot.readErrors?.length) {
    const afterFailure = (entry: RunLedgerEntry) => entry.runId === runId && Date.parse(entry.timestamp ?? '') > Date.parse(lastFailure.at);
    const lateChild = (snapshot.host ?? []).some((entry) => entry.event === 'pod-child-run' && afterFailure(entry));
    const prRows = [...(snapshot.host ?? []), ...Object.values(snapshot.children).flatMap((entries) => entries ?? [])]
      .filter((entry) => entry.event === 'pr-opened' && entry.data?.number === evidence.pr?.number && (entry.runId === runId || entry.runId === evidence.childRunId));
    // PR 근거는 원장 `pr-opened`(실패 뒤 시각) 또는 호스트 logs 의 `job-finished`(podFinishes · 시각 없음) — 후자는
    // `pod-child-run` 자식에게만 붙고, failed 판정은 그 자식이 «없을 때»만 났으므로 지금 보이면 그 자체로 늦은 근거다.
    const prFromJobFinished = !!evidence.pr && !!evidence.childRunId && prRows.length === 0
      && (snapshot.podFinishes ?? []).some((row) => row.childRunId === evidence.childRunId && row.prUrl === evidence.pr?.url);
    const latePr = !!evidence.pr && (prFromJobFinished || prRows.some((entry) => Date.parse(entry.timestamp ?? '') > Date.parse(lastFailure.at)));
    let lateDispatch = false;
    try { lateDispatch = (deps.dispatchPod ?? defaultDispatchPod)(runId, new Date(Date.parse(lastFailure.at) + 1).toISOString()); } catch { /* 읽기 실패는 근거가 아니다 */ }
    if (lateChild || latePr || lateDispatch) {
      const at = (deps.now ?? (() => new Date()))().toISOString();
      const next = updateTaskCard(statePath, cardId, (current) => {
        const failed = [...(current?.history ?? [])].reverse().find((item) => item.event === 'failed');
        return current?.status === 'failed' && current.runId === runId && current.refSource !== 'manual'
          && failed?.event === 'failed' && failed.detail === LATE_LAUNCH_FAILURE && failed.runId === runId && failed.at === lastFailure.at
          ? { ...current, status: 'launched', history: [...current.history, { at, event: 'revived', detail: 'late launch evidence', runId }] } : undefined;
      });
      revived = next?.status === 'launched' && next.history.at(-1)?.event === 'revived' && next.history.at(-1)?.at === at;
      if (revived) {
        try { debug.log('task-agent', 'card-revived', { card: cardId, runId }); } catch { /* fail-soft */ }
      }
      card = next ?? card;
    }
  }
  if (!card) return { card, evidence };
  if (!revived && card.status === 'launched' && !card.pr && !evidence.pr && !snapshot.readErrors?.length) {
    const rows = [...(snapshot.host ?? []), ...Object.values(snapshot.children).flatMap((entries) => entries ?? [])];
    let exit: RunExit | undefined;
    let exitReadFailed = false;
    try { exit = (deps.runExit ?? ((id) => readRunExits(effectiveInstanceRoot()).find((row) => row.runId === id)))(runId); }
    catch { exitReadFailed = true; }
    const finished = [...(snapshot.podFinishes ?? [])].reverse().find((item) => item.state === 'failed');
    const parentTerminal = [...(snapshot.host ?? [])].reverse().find((item) => item.event === 'run-status');
    const parentFailed = parentTerminal?.data?.runStatus === 'failed';
    const boundAt = card.history.find((item) => item.event === 'run-bound')?.at;
    const elapsed = boundAt ? (deps.now ?? (() => new Date()))().getTime() - Date.parse(boundAt) : NaN;
    const launched = rows.some((entry) => entry.event === 'pod-child-run');
    let dispatched = false;
    let dispatchReadFailed = false;
    try { dispatched = (deps.dispatchPod ?? defaultDispatchPod)(runId, boundAt ?? card.createdAt); }
    catch { dispatchReadFailed = true; }
    let launchBound = false;
    let launchReadFailed = false;
    try { launchBound = (deps.launchBound ?? ((id) => !!readLaunchBinding(id)))(runId); }
    catch { launchReadFailed = true; }
    const missingLaunchTimedOut = !finished && !launched && !dispatched && !dispatchReadFailed && !exit && !exitReadFailed && !launchBound && !launchReadFailed && Number.isFinite(elapsed) && elapsed >= 600_000;
    let remoteState: ReturnType<typeof remoteParentAlive> | undefined;
    if (missingLaunchTimedOut && card.parentHost) {
      remoteState = remoteParentAlive({ ...card.parentHost, runId }, deps.ssh);
      if (remoteState !== 'dead') {
        try { debug.log('task-agent', 'card-remote-parent-alive', { card: cardId, runId: card.runId, host: card.parentHost.host, pid: card.parentHost.pid, state: remoteState }); } catch { /* fail-soft */ }
      }
    }
    const timedOut = missingLaunchTimedOut && (!card.parentHost || remoteState === 'dead');
    const hasPr = !!card.pr || !!evidence.pr;
    const exitHarvestBranch = exit?.lastLines?.some((line) => /(?:수확할 브랜치: |ELANOUS_POD_SALVAGE )(?:salvage\/|self-impl\/)[^\s]+/.test(line)) ?? false;
    const ledgerFailure = rows.find((entry) => entry.event === 'run-status' && entry.data?.runStatus === 'failed'
      && (entry.data?.failureKind === STOP_CLASS_POD_FAILURE || entry.data?.stop_class === STOP_CLASS_POD_FAILURE));
    const resultFailure = rows.find((entry) => entry.event === 'result-without-error' && entry.data?.ok === false);
    const noLaunchExit = exit?.reason === STOP_CLASS_NO_LAUNCH && exit.status !== null && exit.status !== 0 && !launched && !dispatched && !dispatchReadFailed;
    // 발사 근거가 있는 런이 nonzero 로 끝났고 분류기가 pod-failure 나 unknown(원인 미상)을 냈다 = 죽은 런(TA-JUDGE-DEAD-RUN ③ «exit 1 · unknown/pod-failure»).
    const deadExit = (exit?.reason === STOP_CLASS_POD_FAILURE || exit?.reason === 'unknown') && exit.status !== null && exit.status !== 0;
    const podFailure = !noLaunchExit && (launched || dispatched) && (parentFailed && (finished || !!ledgerFailure || !!resultFailure) || deadExit)
      && (finished || ledgerFailure || resultFailure || deadExit);
    const terminalRun: TaskJudgeInput['terminalRun'] = podFailure ? {
      kind: STOP_CLASS_POD_FAILURE,
      reason: finished?.childError || (exit?.status != null ? `exit ${exit.status} · ${exit.reason || STOP_CLASS_POD_FAILURE}` : resultFailure ? 'result-without-error · failed' : finished ? `job-finished failed · ${STOP_CLASS_POD_FAILURE}` : `run-status failed · ${STOP_CLASS_POD_FAILURE}`),
      hasPr,
      hasHarvestBranch: exitHarvestBranch || rows.some((entry) => typeof entry.data?.harvestBranch === 'string' && !!entry.data.harvestBranch) || !!salvageBranchOf(rows),
    } : noLaunchExit ? { kind: STOP_CLASS_NO_LAUNCH, reason: `exit ${exit!.status} · ${exit!.reason}`, hasPr, hasHarvestBranch: false }
      : timedOut ? { kind: STOP_CLASS_NO_LAUNCH, reason: 'card-run-bound 뒤 10분 동안 Pod 발사 근거 없음', hasPr: false, hasHarvestBranch: false } : undefined;
    const failure = judgeNextMove({ terminalRun });
    if (terminalRun && failure.reason.startsWith('failed/')) {
      const at = (deps.now ?? (() => new Date()))().toISOString();
      const next = updateTaskCard(statePath, cardId, (current) => current?.status === 'launched' && current.runId === card.runId && !current.pr && current.refSource !== 'manual' ? {
        ...current, status: 'failed', history: [...current.history, { at, event: 'failed', detail: failure.reason, runId: card.runId }],
      } : undefined);
      return { card: next, evidence };
    }
  }
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

/** TA-WIRING-CHECK — `live-verified` 원장 줄의 이벤트 이름 · 카드 런 원장에 적는다. */
export const WIRING_LIVE_VERIFIED_EVENT = 'live-verified';

export interface WiringLiveVerifiedInput { pr: number; ref: string; ok: boolean }
export interface WiringLiveVerifiedDeps { ledgerDir?: string; now?: () => Date }
export type WiringLiveVerifiedOutcome = { written: true; entry: RunLedgerEntry } | { written: false; reason: string };

/**
 * 실물 1회를 돌린 뒤 남기는 기록 — 카드 런 원장에 `live-verified {pr, ref, ok, card}` 한 줄.
 * `ref`(실물로 돌린 명령·화면 근거)가 비거나 카드에 런이 없거나 PR 번호가 자연수가 아니면 거부하고 쓰지 않는다.
 */
export function recordWiringLiveVerified(card: Pick<TaskCard, 'id' | 'runId'>, input: WiringLiveVerifiedInput, deps: WiringLiveVerifiedDeps = {}): WiringLiveVerifiedOutcome {
  const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
  if (!ref) return { written: false, reason: 'ref 가 비었다 — 실물로 돌린 명령·화면 근거 한 줄이 필요하다' };
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) return { written: false, reason: `pr 은 자연수다: ${input.pr}` };
  if (!card.runId) return { written: false, reason: `카드 ${card.id} 에 런(runId)이 없다 — 기록할 원장이 없다` };
  const entry: RunLedgerEntry = {
    timestamp: (deps.now ?? (() => new Date()))().toISOString(),
    runId: card.runId,
    event: WIRING_LIVE_VERIFIED_EVENT,
    data: { pr: input.pr, ref, ok: input.ok, card: card.id },
  };
  try {
    appendRunLedgerEntry(entry, deps.ledgerDir);
  } catch (error) {
    return { written: false, reason: `원장 쓰기 실패: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
  return { written: true, entry };
}

export interface WiringEvidence {
  /** 이 PR 이 배선(진입점·명령 등록·호출자 대입)을 바꿨나 — 그렇다면 실물 1회가 필요하다. */
  required: boolean;
  /** 카드 런 원장에 이 PR 의 `live-verified` ok 기록이 있나. */
  liveRunRecorded: boolean;
  /** 근거를 못 읽었다(gh 실패 · 원장 읽기 실패) — 관측만 하고 green 을 막지 않는다. */
  unknown: boolean;
}

export interface WiringEvidenceDeps {
  /** 카드 — 없으면 liveRunRecorded 는 false. */
  card?: Pick<TaskCard, 'id' | 'runId'>;
  /** `gh pr diff <pr>` 의 통합 diff 원문 — 한 번만 부른다(시험 주입). */
  prDiff?: (pr: number) => string | Promise<string>;
  loadLedger?: (runId: string) => RunLedgerEntry[] | null;
}

const WIRING_PATH = /(^|\/)(bin|scripts|cli)\/|(^|\/)[^/]*(install|auth|entrypoint)[^/]*$/i;
const NON_WIRING_PATH = /^docs\/|\.md$|\.test\.[cm]?[jt]sx?$/;
const WIRING_LINE = /\bregisterCommand\b|\.command\(|\.set\(|\.on\(|\bhandlers(?:\.\w+|\[[^\]]+\])\s*=(?!=)/;

async function defaultPrDiff(pr: number): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolveDiff, reject) => {
    execFile('gh', ['pr', 'diff', String(pr)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolveDiff(stdout)));
  });
}

/** 순수 — 통합 diff 가 배선을 바꾸나. 문서·시험 파일은 보지 않는다. */
export function diffTouchesWiring(diff: string): boolean {
  for (const chunk of diff.split(/^diff --git /m)) {
    const path = /^\S+ b\/(\S+)/.exec(chunk)?.[1] ?? '';
    if (path && NON_WIRING_PATH.test(path)) continue;
    if (path && WIRING_PATH.test(path)) return true;
    const added = chunk.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    if (added.some((line) => WIRING_LINE.test(line))) return true;
  }
  return false;
}

/**
 * 수집기 — 판단부(judge.ts) 밖에서만 gh 를 부른다. PR diff 는 «한 번» 읽고, gh·원장 읽기 실패는 던지지 않고 `unknown: true` 로 돌려준다.
 */
export async function collectWiringEvidence(pr: number, deps: WiringEvidenceDeps = {}): Promise<WiringEvidence> {
  let unknown = false;
  let required = false;
  try { required = diffTouchesWiring(await (deps.prDiff ?? defaultPrDiff)(pr)); } catch { unknown = true; }
  let liveRunRecorded = false;
  if (deps.card?.runId) {
    try {
      const entries = (deps.loadLedger ?? await defaultLoadLedger())(deps.card.runId) ?? [];
      liveRunRecorded = entries.some((entry) => entry.event === WIRING_LIVE_VERIFIED_EVENT && entry.data?.ok === true && entry.data?.pr === pr);
    } catch { unknown = true; }
  }
  return { required, liveRunRecorded, unknown };
}
