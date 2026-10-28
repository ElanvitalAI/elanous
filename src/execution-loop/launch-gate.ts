import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { assertLedgerPathPolicy } from '../harness/launch-utterance-ledger.js';
import { extractVerbatimOriginalAsk } from '../self-implement/goal-author.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { queryRunningRuns, type QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { CODEX_PROVIDER, GROK_PROVIDER, decideLaunchBudget, type BudgetAction, type BudgetDecision, type BudgetInputs } from '../self-implement/budget-gate.js';
import { DEFAULT_FALLBACK_CHAIN } from '../oauth/fallback-chain.js';

export type ActiveRunsForGoal = readonly string[] | 'unknown';

/** Match an un-authored CLI request to the verbatim ask recorded in an authored run. */
export function launchRequestId(text: string): string {
  return `request-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
}

export interface ActiveRunsForGoalDeps {
  queryRuns?: () => QueriedRunningRunsResult;
  loadLedger?: typeof loadRunLedger;
  readGoalDocument?: (path: string) => string;
}

/** Only a live process with an exact goal ID or verbatim authored ask is a duplicate. Incomplete observation is not absence. */
export function activeRunsForGoal(goalId: string, deps: ActiveRunsForGoalDeps = {}): ActiveRunsForGoal {
  try {
    const observation = (deps.queryRuns ?? (() => queryRunningRuns({ includeTest: true, caller: 'execution-loop.launch-gate' })))();
    const loadLedger = deps.loadLedger ?? loadRunLedger;
    const readGoalDocument = deps.readGoalDocument ?? ((path: string) => readFileSync(path, 'utf8'));
    let unknown = observation.completeness !== 'complete' || observation.pty.unreadable.length > 0;
    const unknownReasons = new Set<string>();
    if (observation.completeness !== 'complete') unknownReasons.add(`ledger observation ${observation.completeness}`);
    for (const root of observation.pty.unreadable) unknownReasons.add(`unreadable PTY: ${root}`);
    const active = new Set<string>();
    let skippedTerminal = 0;
    for (const run of observation.entries) {
      if (run.status === 'ended-unclosed') { skippedTerminal += 1; continue; }
      const hasObservedPty = run.ptyRefs.length > 0;
      const live = run.status === 'running' && hasObservedPty;
      if (run.ledgerDirectories.length === 0) {
        if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: ledger directory absent`); }
        else skippedTerminal += 1;
        continue;
      }
      let identified = false;
      for (const directory of run.ledgerDirectories) {
        try {
          const ledger = loadLedger(run.runId, directory);
          if (ledger === null) {
            if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: ledger unavailable`); }
            continue;
          }
          const ids = new Set(ledger.flatMap((entry) => entry.goalId ? [entry.goalId] : []));
          if (ids.size !== 1) {
            if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: expected one goalId, found ${ids.size}`); }
            continue;
          }
          identified = true;
          let matches = ids.has(goalId);
          if (!matches && goalId.startsWith('request-') && live) {
            const document = ledger.find((entry) => entry.event === 'start')?.data.goalFile;
            if (typeof document === 'string') {
              try {
                const ask = extractVerbatimOriginalAsk(readGoalDocument(document));
                matches = ask?.range !== undefined && launchRequestId(ask.ask) === goalId;
              } catch { unknown = true; unknownReasons.add(`${run.runId}: goal document unreadable`); }
            }
          }
          if (matches) {
            if (live) active.add(run.runId);
            else { unknown = true; unknownReasons.add(`${run.runId}: matching ledger without live PTY`); }
          }
        } catch {
          if (hasObservedPty) { unknown = true; unknownReasons.add(`${run.runId}: ledger read failed`); }
        }
      }
      if (!identified && !hasObservedPty) skippedTerminal += 1;
    }
    // Positive evidence wins even if a different process or store is unreadable.
    const result: ActiveRunsForGoal = active.size > 0 ? [...active].sort() : unknown ? 'unknown' : [];
    try {
      debug.log('execution-loop.launch-gate', 'active-runs-result', { goalId, result, skippedTerminal });
      if (result === 'unknown') debug.log('execution-loop.launch-gate', 'active-runs-unknown', { goalId, reasons: [...unknownReasons], skippedTerminal });
    } catch { /* observation is fail-soft */ }
    return result;
  } catch (error) {
    try { debug.log('execution-loop.launch-gate', 'active-runs-unknown', { goalId, reasons: [error instanceof Error ? error.message : String(error)] }); } catch { /* observation is fail-soft */ }
    return 'unknown';
  }
}

/**
 * L6 발사 관문의 예산 입력 보정 — 발사 우주의 config 에 체인이 없으면(작업 트리 = 시험 우주) 막지 않고
 * 코드 기본 체인으로 판단한다. `--child-llm-provider` 를 명시했으면 그것이 체인이다(예산 판정 밖 provider 는 통과).
 */
export function harnessLaunchBudgetDecision(
  inputs: BudgetInputs,
  opts: { readonly childLlmProvider?: string; readonly childLlmModel?: string } = {},
): { readonly decision: BudgetDecision; readonly warning?: string; readonly unmeasuredProvider?: string } {
  // Resolve imported provider constants only when the launch gate is called.
  // This module participates in the CLI/tool catalog import cycle.
  const launchBudgetProvider: Readonly<Record<string, string>> = { 'codex-rotate': CODEX_PROVIDER, grok: GROK_PROVIDER };
  const explicit = opts.childLlmProvider?.trim();
  const judged = (selected: BudgetInputs) => {
    const { decision, unmeasuredProvider } = decideLaunchBudget(selected);
    return { decision, ...(unmeasuredProvider ? { unmeasuredProvider, warning: `budget: ${unmeasuredProvider} usage unmeasured — launching` } : {}) };
  };
  if (explicit) {
    if (explicit !== CODEX_PROVIDER && explicit !== GROK_PROVIDER) {
      return {
        decision: { action: 'proceed', provider: explicit, ...(opts.childLlmModel ? { model: opts.childLlmModel } : {}), reasons: [`${explicit}: 명시 provider — 예산 판정 밖`] },
        warning: `budget: ${explicit} is outside the budget gate — launched as requested`,
      };
    }
    const chain = [{ provider: explicit, ...(opts.childLlmModel ? { model: opts.childLlmModel } : {}) }];
    return judged({ ...inputs, preference: { ...inputs.preference, chain } });
  }
  if (inputs.preference.chain.length > 0) return judged(inputs);
  const chain = DEFAULT_FALLBACK_CHAIN.map((step) => ({ provider: launchBudgetProvider[step] ?? step }));
  const result = judged({ ...inputs, preference: { ...inputs.preference, chain } });
  return {
    ...result,
    warning: `budget: no chain in this universe's config — judged with the code default ${DEFAULT_FALLBACK_CHAIN.join(',')}${result.warning ? ` · ${result.warning}` : ''}`,
  };
}

/** Parent → Pod budget snapshot env. Numbers and names only — never a credential, never free-text reasons. */
export const BUDGET_SNAPSHOT_ENV = 'ELANOUS_BUDGET_SNAPSHOT';
export const BUDGET_SNAPSHOT_MAX_AGE_SEC = 15 * 60;
// Host and Pod clocks may differ slightly even when the Job carries a freshly measured verdict.
const BUDGET_SNAPSHOT_CLOCK_SKEW_SEC = 30;

/** The verdict the host's launch gate reached (chain ⊕ the user's caps) — the Pod follows it instead of judging again. */
export interface HostBudgetVerdict {
  action: BudgetAction;
  provider?: string;
  model?: string;
}

export interface BudgetSnapshot {
  /** The provider the host verdict picked, or the one asked for when nothing was picked. */
  provider: string;
  /** Percent of that provider's window still unspent (0–100) — observation only; absent when the host could not measure it. */
  remaining?: number;
  window: string;
  /** Epoch milliseconds on the measuring host. */
  measuredAt: number;
  host: string;
  /** The explicit child provider the host judged for (`--child-llm-provider`). Absent = the host's configured chain. */
  requested?: string;
  /** The host launch-gate verdict. Absent = the host reached none, and the Pod treats the budget as unmeasured. */
  decision?: HostBudgetVerdict;
}

export type BudgetSource = 'snapshot' | 'local' | 'unmeasured';

export interface ResolvedLaunchBudget {
  budget: BudgetDecision | 'unknown';
  budgetSource: BudgetSource;
  snapshotAgeSec?: number;
}

const BUDGET_ACTIONS: readonly BudgetAction[] = ['proceed', 'next-provider', 'wait-reset', 'stop'];

function canonicalBudgetProvider(name: string): string {
  const id = name.trim();
  return id === 'codex' || id === 'codex-rotate' ? 'openai-codex' : id;
}

function pickVerdict(value: unknown): HostBudgetVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { action, provider, model } = value as Record<string, unknown>;
  if (typeof action !== 'string' || !(BUDGET_ACTIONS as readonly string[]).includes(action)) return undefined;
  if (provider !== undefined && (typeof provider !== 'string' || !provider.trim())) return undefined;
  if (model !== undefined && typeof model !== 'string') return undefined;
  return { action: action as BudgetAction, ...(provider ? { provider: canonicalBudgetProvider(provider) } : {}), ...(model ? { model } : {}) };
}

export function encodeBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const { provider, remaining, window, measuredAt, host, requested, decision } = snapshot;
  const verdict = pickVerdict(decision);
  return JSON.stringify({
    provider: canonicalBudgetProvider(provider),
    ...(typeof remaining === 'number' && Number.isFinite(remaining) ? { remaining } : {}),
    window, measuredAt, host,
    ...(requested?.trim() ? { requested: canonicalBudgetProvider(requested) } : {}),
    ...(verdict ? { decision: verdict } : {}),
  });
}

function parseBudgetSnapshot(raw: string | undefined): BudgetSnapshot | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return undefined;
    const { provider, remaining, window, measuredAt, host, requested, decision } = value;
    if (typeof provider !== 'string' || !provider.trim() || typeof window !== 'string' || typeof host !== 'string') return undefined;
    if (remaining !== undefined && (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100)) return undefined;
    if (typeof measuredAt !== 'number' || !Number.isFinite(measuredAt)) return undefined;
    if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) return undefined;
    const verdict = decision === undefined ? undefined : pickVerdict(decision);
    if (decision !== undefined && !verdict) return undefined;
    return {
      provider: canonicalBudgetProvider(provider), ...(remaining !== undefined ? { remaining } : {}), window, measuredAt, host,
      ...(requested ? { requested: canonicalBudgetProvider(requested) } : {}), ...(verdict ? { decision: verdict } : {}),
    };
  } catch { return undefined; }
}

/** The host's verdict as the Pod's decision — never re-judged with one provider or code-constant caps. */
function decisionFromSnapshot(snapshot: BudgetSnapshot, verdict: HostBudgetVerdict, ageSec: number): BudgetDecision {
  const target = verdict.provider ? ` → ${verdict.provider}` : '';
  const used = snapshot.remaining === undefined ? '' : ` · ${snapshot.provider} ${Math.round((100 - snapshot.remaining) * 100) / 100}% used (${snapshot.window})`;
  return {
    action: verdict.action,
    ...(verdict.provider ? { provider: verdict.provider } : {}),
    ...(verdict.model ? { model: verdict.model } : {}),
    reasons: [`host ${snapshot.host} verdict ${verdict.action}${target}${used} · ${ageSec}s ago`],
  };
}

export interface ResolveLaunchBudgetDeps {
  env?: Readonly<Record<string, string | undefined>> | undefined;
  now?: () => number;
  /** The provider this launch will use, when named explicitly. */
  provider?: string | undefined;
  /** Host-side measurement. Never called inside a Pod. */
  measureLocal: () => Promise<BudgetDecision | 'unknown'>;
}

/** A Pod has no subscription credential or usage cache, so it follows the parent's verdict ⊕ its age and never measures. */
export async function resolveLaunchBudget(deps: ResolveLaunchBudgetDeps): Promise<ResolvedLaunchBudget> {
  const env = deps.env ?? process.env;
  if (env.ELANOUS_SUBSTRATE !== 'pod') return { budget: await deps.measureLocal(), budgetSource: 'local' };
  const snapshot = parseBudgetSnapshot(env[BUDGET_SNAPSHOT_ENV]);
  if (!snapshot) return { budget: 'unknown', budgetSource: 'unmeasured' };
  const ageSec = Math.round(((deps.now ?? Date.now)() - snapshot.measuredAt) / 1000);
  const requested = deps.provider?.trim() ? canonicalBudgetProvider(deps.provider) : undefined;
  // The verdict holds only for the question the host answered: the same explicit provider, or both on the configured chain.
  if (!snapshot.decision || ageSec < -BUDGET_SNAPSHOT_CLOCK_SKEW_SEC || ageSec > BUDGET_SNAPSHOT_MAX_AGE_SEC || requested !== snapshot.requested) {
    return { budget: 'unknown', budgetSource: 'unmeasured', snapshotAgeSec: ageSec };
  }
  return { budget: decisionFromSnapshot(snapshot, snapshot.decision, Math.max(0, ageSec)), budgetSource: 'snapshot', snapshotAgeSec: ageSec };
}

export interface PreLaunchGateInput {
  goalId: string;
  budget?: BudgetDecision | 'unknown';
  budgetSource?: BudgetSource;
  snapshotAgeSec?: number;
  forceLaunch?: boolean;
}

export interface PreLaunchGateDeps extends ActiveRunsForGoalDeps {
  activeRuns?: (goalId: string) => ActiveRunsForGoal;
  /** LAUNCH-SINGLE-DOOR-1C — 주입 우선 단일문: 시험 우주가 격리 루트의 문을 끼워 생산 배선을 그대로 검증한다. */
  launchDoor?: LaunchRequestDoor;
}

export interface PreLaunchGateDecision {
  action: 'proceed' | 'blocked-duplicate' | 'blocked-budget' | 'wait-reset';
  sameGoalActiveRuns: ActiveRunsForGoal;
  budget: BudgetDecision | 'unknown';
  reason: string;
}

/** Force bypasses only a duplicate observation, never an exhausted budget. */
export function preLaunchGate(input: PreLaunchGateInput, deps: PreLaunchGateDeps = {}): PreLaunchGateDecision {
  const decision = decidePreLaunch(input, deps);
  debug.log('execution-loop.launch-gate', 'decision', { goalId: input.goalId, action: decision.action, sameGoalActiveRuns: decision.sameGoalActiveRuns, budget: decision.budget === 'unknown' ? 'unknown' : decision.budget.action, forceLaunch: input.forceLaunch === true, reason: decision.reason, ...(input.budgetSource ? { budgetSource: input.budgetSource } : {}), ...(input.snapshotAgeSec !== undefined ? { snapshotAgeSec: input.snapshotAgeSec } : {}) });
  return decision;
}

function decidePreLaunch(input: PreLaunchGateInput, deps: PreLaunchGateDeps): PreLaunchGateDecision {
  const sameGoalActiveRuns = (deps.activeRuns ?? ((goalId) => activeRunsForGoal(goalId, deps)))(input.goalId);
  const budget = input.budget ?? 'unknown';
  if (budget !== 'unknown' && (budget.action === 'stop' || budget.action === 'wait-reset')) {
    return { action: budget.action === 'stop' ? 'blocked-budget' : 'wait-reset', sameGoalActiveRuns, budget, reason: budget.reasons.join(' · ') || `budget: ${budget.action}` };
  }
  if (sameGoalActiveRuns !== 'unknown' && sameGoalActiveRuns.length > 0 && !input.forceLaunch) {
    return { action: 'blocked-duplicate', sameGoalActiveRuns, budget, reason: `same-goal active runs: ${sameGoalActiveRuns.join(', ')}` };
  }
  return { action: 'proceed', sameGoalActiveRuns, budget, reason: sameGoalActiveRuns === 'unknown' ? 'active runs unknown' : input.forceLaunch && sameGoalActiveRuns.length > 0 ? 'duplicate overridden by force-launch' : 'no confirmed duplicate' };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// LAUNCH-SINGLE-DOOR-1C — 발사 요청의 단일 문.
// ─────────────────────────────────────────────────────────────────────────────────────

/** Env contract: hand 가 소비한 requestId 를 자식 say 가 물려받아 같은 문을 다시 두드리지 않게 한다(한 번만 상속). */
export const LAUNCH_DOOR_RECEIPT_ENV = 'ELANOUS_LAUNCH_DOOR_RECEIPT';

/** append 전용 요청 원장의 행 종류 — 요청(중복 포함)·소비·거절·강제·실패·단일문 사용 불가 관측. */
export type LaunchRequestLedgerEvent = 'requested' | 'consumed' | 'refused-duplicate' | 'forced-duplicate' | 'launch-failed' | 'door-unavailable';

/** append 전용 요청 원장의 한 행 — 행은 지우거나 고치지 않는다(관측 전용). */
export interface LaunchRequestLedgerRow {
  readonly event: LaunchRequestLedgerEvent;
  readonly requestId: string;
  readonly at: string;
  readonly source?: string;
  readonly receiptId?: string;
  readonly reason?: string;
}

/** requestId 단위 소비 영수증 — 최초 1회만 발급된다(O_EXCL 파일이 곧 영수증이다). */
export interface LaunchRequestReceipt {
  readonly requestId: string;
  readonly receiptId: string;
  readonly at: string;
  readonly source?: string;
}

/** `consume` 의 답 — `refused` 는 기존 영수증을 읽어 사유와 함께 거절한 것이다. */
export type LaunchRequestConsumption =
  | { readonly status: 'consumed'; readonly requestId: string; readonly receiptId: string; readonly receiptAt: string; readonly inherited?: true }
  | { readonly status: 'forced'; readonly requestId: string; readonly receiptId: string | null; readonly receiptAt: string | null; readonly reason: string }
  | { readonly status: 'refused'; readonly requestId: string; readonly receiptId: string | null; readonly receiptAt: string | null; readonly reason: string }
  | { readonly status: 'unavailable'; readonly requestId: string; readonly reason: string };

/** 발사 요청의 단일 문 — 원장 append · 단일 소비 · 실패 기록 · 원장 조회. */
export interface LaunchRequestDoor {
  /** 요청 한 건을 원장에 append 하고 그 requestId 를 돌려준다(중복 재요청도 매번 append 된다). */
  requestId(ask: string): string;
  /** requestId 단위 단일 소비 — 영수증은 최초 1회만 발급된다(두 번째는 기존 영수증과 사유로 거절). */
  consume(requestId: string, opts?: { readonly force?: boolean; readonly inheritedReceipt?: string }): LaunchRequestConsumption;
  /** 발사 실패 사유를 원장에 append 한다(관측 — 발사를 막지 않는다). */
  fail(requestId: string, reason: string): void;
  /** 원장 조회 — 중복 거절·실패·재시도 사유를 읽는다(인자를 주면 그 requestId 의 행만). */
  rows(requestId?: string): readonly LaunchRequestLedgerRow[];
}

/** 단일문 deps — 원장 뿌리(기본 = 이 우주의 실효 인스턴스 루트)·시계·요청 출처 표지. */
export interface LaunchRequestDoorDeps {
  readonly root?: string;
  readonly now?: () => Date;
  readonly source?: string;
}

const LAUNCH_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LAUNCH_REQUEST_DATE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function launchRequestLedgerDir(root: string): string {
  return join(resolve(root), 'launch-requests');
}

/** 단일문을 연다 — 문 자체는 상태를 갖지 않고, 원장·영수증은 이 우주의 인스턴스 루트 아래 파일로 남는다. */
export function openLaunchRequestDoor(deps: LaunchRequestDoorDeps = {}): LaunchRequestDoor {
  const dir = launchRequestLedgerDir(deps.root ?? effectiveInstanceRoot());
  const receiptsDir = join(dir, 'receipts');
  const now = deps.now ?? (() => new Date());
  const source = deps.source;

  const observe = (event: string, data: Record<string, unknown>): void => {
    try { debug.log('execution-loop.launch-gate', event, data, { level: 'warn' }); } catch { /* 관측은 fail-soft */ }
  };

  const appendRow = (row: LaunchRequestLedgerRow): boolean => {
    try {
      assertLedgerPathPolicy(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      assertLedgerPathPolicy(dir);
      if (!lstatSync(dir).isDirectory()) throw new Error(`launch request ledger dir is not a directory: ${dir}`);
      const file = join(dir, `${row.at.slice(0, 10)}.jsonl`);
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error(`launch request ledger file is not a regular file: ${file}`);
        writeSync(fd, `${JSON.stringify(row)}\n`);
      } finally { closeSync(fd); }
      return true;
    } catch (error) {
      observe('request-ledger-unwritten', { event: row.event, requestId: row.requestId, reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const readReceipt = (requestId: string): LaunchRequestReceipt | null => {
    try {
      const fd = openSync(join(receiptsDir, `${requestId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile()) return null;
        const parsed = JSON.parse(readFileSync(fd, 'utf8')) as LaunchRequestReceipt;
        return parsed && typeof parsed === 'object' && parsed.requestId === requestId
          && typeof parsed.receiptId === 'string' && typeof parsed.at === 'string' ? parsed : null;
      } finally { closeSync(fd); }
    } catch { return null; }
  };

  const requestId = (ask: string): string => {
    const id = launchRequestId(ask);
    appendRow({ event: 'requested', requestId: id, at: now().toISOString(), ...(source ? { source } : {}) });
    return id;
  };

  const consume = (id: string, opts: { readonly force?: boolean; readonly inheritedReceipt?: string } = {}): LaunchRequestConsumption => {
    if (!LAUNCH_REQUEST_ID_PATTERN.test(id)) {
      return { status: 'unavailable', requestId: id, reason: `requestId 가 원장 키로 쓸 수 없다: ${JSON.stringify(id)}` };
    }
    const at = now().toISOString();
    // 부모(hand)가 같은 requestId 를 이미 소비했다면 상속 영수증으로 지나간다 — 새 영수증을 만들지 않는다.
    if (opts.inheritedReceipt !== undefined && opts.inheritedReceipt === id) {
      const inherited = readReceipt(id);
      if (inherited !== null) {
        try { debug.log('execution-loop.launch-gate', 'request-consumption-inherited', { requestId: id, receiptId: inherited.receiptId }); } catch { /* 관측은 fail-soft */ }
        return { status: 'consumed', requestId: id, receiptId: inherited.receiptId, receiptAt: inherited.at, inherited: true };
      }
    }
    const receipt: LaunchRequestReceipt = { requestId: id,
      receiptId: `receipt-${createHash('sha256').update(`${id}:${at}`).digest('hex').slice(0, 12)}`, at,
      ...(source ? { source } : {}) };
    let created = true;
    try {
      assertLedgerPathPolicy(receiptsDir);
      mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
      assertLedgerPathPolicy(receiptsDir);
      const fd = openSync(join(receiptsDir, `${id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error(`소비 영수증이 일반 파일이 아니다: ${id}`);
        writeSync(fd, JSON.stringify(receipt));
      } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        const reason = error instanceof Error ? error.message : String(error);
        observe('request-receipt-unavailable', { requestId: id, reason });
        appendRow({ event: 'door-unavailable', requestId: id, at, ...(source ? { source } : {}), reason });
        return { status: 'unavailable', requestId: id, reason: `소비 영수증을 만들지 못했다 — 발사를 막지 않는다: ${reason}` };
      }
      created = false;
    }
    if (created) {
      appendRow({ event: 'consumed', requestId: id, at, ...(source ? { source } : {}), receiptId: receipt.receiptId });
      return { status: 'consumed', requestId: id, receiptId: receipt.receiptId, receiptAt: receipt.at };
    }
    const existing = readReceipt(id);
    if (existing === null) {
      const reason = `requestId ${id} 의 소비 영수증이 이미 있지만 읽지 못했다 — 중복 발사 거절`;
      appendRow({ event: 'refused-duplicate', requestId: id, at, ...(source ? { source } : {}), reason });
      return { status: 'refused', requestId: id, receiptId: null, receiptAt: null, reason };
    }
    if (opts.force === true) {
      const reason = `requestId ${id} 는 영수증 ${existing.receiptId} (${existing.at}) 로 이미 소비됐다 — force 로 다시 띄운다`;
      appendRow({ event: 'forced-duplicate', requestId: id, at, ...(source ? { source } : {}), receiptId: existing.receiptId, reason });
      return { status: 'forced', requestId: id, receiptId: existing.receiptId, receiptAt: existing.at, reason };
    }
    const reason = `requestId ${id} 는 영수증 ${existing.receiptId} (${existing.at}) 로 이미 소비됐다 — 중복 발사 거절`;
    appendRow({ event: 'refused-duplicate', requestId: id, at, ...(source ? { source } : {}), receiptId: existing.receiptId, reason });
    return { status: 'refused', requestId: id, receiptId: existing.receiptId, receiptAt: existing.at, reason };
  };

  const fail = (id: string, reason: string): void => {
    appendRow({ event: 'launch-failed', requestId: id, at: now().toISOString(),
      ...(source ? { source } : {}), reason: reason.trim() || '사유 없음' });
  };

  const rows = (requestId?: string): readonly LaunchRequestLedgerRow[] => {
    const result: LaunchRequestLedgerRow[] = [];
    let names: string[];
    try {
      assertLedgerPathPolicy(dir);
      names = readdirSync(dir);
    } catch { return result; }
    for (const name of names.filter((candidate) => LAUNCH_REQUEST_DATE_FILE.test(candidate)).sort()) {
      let text: string;
      try {
        const fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!fstatSync(fd).isFile()) continue;
          text = readFileSync(fd, 'utf8');
        } finally { closeSync(fd); }
      } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line) as LaunchRequestLedgerRow;
          if (row && typeof row === 'object' && typeof row.event === 'string' && typeof row.requestId === 'string'
            && typeof row.at === 'string' && (requestId === undefined || row.requestId === requestId)) result.push(row);
        } catch { /* 찢어진 줄은 건너뛴다 */ }
      }
    }
    return result;
  };

  return { requestId, consume, fail, rows };
}
