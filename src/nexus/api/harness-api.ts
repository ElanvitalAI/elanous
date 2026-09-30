import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hasTerminalRunStatus, loadRunLedger, runLedgerDir, runLedgerPath, type RunLedgerEntry } from '../../self-implement/run-ledger.js';
import { summarizeTerminalLedger } from '../../self-implement/run-ledger-compact.js';
import { debug } from '../../debug/log.js';
import { enqueueSoftStop } from '../../harness/control-inbox.js';
import { listHarnessScreens, readHarnessScreenTail } from '../../harness/harness-screen.js';
import { queryRunScreenKey } from '../../self-implement/run-ledger.js';
import { logsDbPath } from '../../mss/logging/log-store.js';
import { redactSecretText } from '../../debug/log.js';
import { runAskLaunchFlow, type AskLaunchFlowResult } from '../../self-dev/ask-launch-flow.js';
import * as askIo from '../../self-dev/ask-launch-io.js';
import { DAEMON_HARNESS_ASK_ENTRANCE } from '../../self-dev/entrance-registry.js';
import { prepareAskLaunch } from '../../self-dev/launch-preflight.js';
import { launchDevGoalFileDetached } from '../../self-implement/seams.js';
import { encodeReportOriginEnv, readReportOrigin, REPORT_ORIGIN_ENV } from '../../self-implement/report-origin.js';
import { loadGoalRunQuery, type GoalRunRecord } from '../../self-implement/goal-run-store.js';
import { resolveHarnessTarget } from '../../self-implement/harness-target-options.js';
import { queryRunningRuns, type RunningRunsResult } from '../../self-implement/running-runs.js';
import { getDefaultLogStore, type LogStore } from '../../mss/logging/log-store.js';
import { createSeqTracker, makeEnvelope, type FeedbackEnvelope } from '../../feedback/envelope.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ASK_USAGE = 'usage: POST /v1/harness/ask with JSON body {"text":"<ask>"} — optional "target":"<path>" (홈 안의 git repo·디렉터리·파일)';
const ASK_STATUS_USAGE = 'usage: GET /v1/harness/ask-status?acceptanceId=<acceptanceId>';
const RUN_EVENTS_USAGE = 'usage: GET /v1/harness/run-events?runId=<runId>';
const STOP_USAGE = 'usage: POST /v1/harness/stop with JSON body {"spaceId":"<space>"}';
const ASK_STATUS_EVENT_TO_PHASE = {
  'ask-accepted': 'accepted',
  'ask-flow-settled': 'flow-settled',
  'ask-launch-started': 'launch-started',
  'ask-launch-settled': 'launch-settled',
  'ask-launch-failed': 'launch-failed',
} as const;
const ASK_STATUS_EVENTS = new Set<string>(Object.keys(ASK_STATUS_EVENT_TO_PHASE));
const ACCEPTED_ASK_REGISTRY_LIMIT = 1_000;
const acceptedAskIssuedAt = new Map<string, number>();

export function rememberAcceptedAsk(acceptanceId: string, issuedAt = Date.now()): void {
  acceptedAskIssuedAt.delete(acceptanceId);
  acceptedAskIssuedAt.set(acceptanceId, issuedAt);
  while (acceptedAskIssuedAt.size > ACCEPTED_ASK_REGISTRY_LIMIT) {
    acceptedAskIssuedAt.delete(acceptedAskIssuedAt.keys().next().value!);
  }
}

export const HARNESS_RUN_SKELETON_EVENTS = [
  'headless.spawn',
  'implemented',
  'gate.baseline',
  'review.diff-scope',
  'run-terminal',
  'headless.done',
] as const;
const HARNESS_RUN_SKELETON_EVENT_SET = new Set<string>(HARNESS_RUN_SKELETON_EVENTS);

type HarnessTerminalPayload = {
  runStatus?: 'completed' | 'failed';
  stage?: string;
  error?: string;
};

/** `implemented` emits this only when the source log records a boolean outcome. */
type HarnessImplementedPayload = {
  ok: boolean;
};

function terminalPayloadFromLogData(data: string | null): HarnessTerminalPayload | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const runStatus = parsed.runStatus === 'completed' || parsed.runStatus === 'failed' ? parsed.runStatus : undefined;
    const stage = typeof parsed.stage === 'string' ? parsed.stage : undefined;
    const error = typeof parsed.error === 'string' ? parsed.error : undefined;
    return runStatus === undefined && stage === undefined && error === undefined ? undefined : { runStatus, stage, error };
  } catch {
    return undefined;
  }
}

function implementedPayloadFromLogData(data: string | null): HarnessImplementedPayload | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : undefined;
  } catch {
    return undefined;
  }
}

type HarnessMetaApi = unknown;

export interface HarnessApiDeps {
  readonly runAskLaunchFlow?: typeof runAskLaunchFlow;
  readonly launchDevGoalFileDetached?: typeof launchDevGoalFileDetached;
  readonly queryRunningRuns?: typeof queryRunningRuns;
  readonly queryGoalRunsByCorrelation?: (acceptanceId: string) => readonly GoalRunRecord[] | null;
  readonly logStore?: Pick<LogStore, 'queryByDataKeys'>;
  readonly askStatusLogStore?: Pick<LogStore, 'query'>;
  readonly askStatusRunLogStore?: Pick<LogStore, 'queryByDataKeys'>;
  readonly listHarnessScreens?: typeof listHarnessScreens;
  readonly enqueueSoftStop?: typeof enqueueSoftStop;
  readonly queryRunScreenKey?: (runId: string) => Pick<ReturnType<typeof queryRunScreenKey>, 'screenKey' | 'logStoreStatus' | 'lastEvent'>;
  readonly readHarnessScreenTail?: typeof readHarnessScreenTail;
  readonly createAcceptanceId?: () => string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  readonly createFeedbackEmitter?: (acceptanceId: string) => (env: FeedbackEnvelope) => void | Promise<void>;
  /** 시험 심 — `?finishedSince=` 가 읽는 원장 디렉터리(기본 `runLedgerDir()`). */
  readonly ledgerDir?: string;
  /** 시험 심 — `?finishedSince=` 의 `landed`(gh 실행기·저장소·시간 초과). */
  readonly landed?: LandedPrsDeps;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function queryHarnessAskLifecycle(store: Pick<LogStore, 'query'>, acceptanceId: string) {
  return store.query({
    exactCategories: ['harness-http'],
    events: [...ASK_STATUS_EVENTS],
    grep: acceptanceId,
    limit: 100,
  }).flatMap((row) => {
    try {
      const data = row.data ? JSON.parse(row.data) as Record<string, unknown> : null;
      return data?.acceptanceId === acceptanceId ? [{ row, data }] : [];
    } catch { return []; }
  }).sort((left, right) => left.row.ts_ms - right.row.ts_ms || left.row.id - right.row.id);
}

function queryHarnessAskStartRunId(store: Pick<LogStore, 'queryByDataKeys'>, acceptanceId: string): string | undefined {
  const runIds = new Set<string>();
  for (const row of store.queryByDataKeys({
    exactCategories: ['self-implement'],
    correlationIds: [acceptanceId],
  })) {
    if (row.event !== 'start') continue;
    try {
      const data = row.data ? JSON.parse(row.data) as Record<string, unknown> : null;
      if (data?.correlationId === acceptanceId && typeof data.runId === 'string' && data.runId) runIds.add(data.runId);
    } catch {
      continue;
    }
  }
  return runIds.size === 1 ? runIds.values().next().value : undefined;
}

export type HarnessCorrelationObservation =
  | { kind: 'ownership-unproven'; acceptanceId: string; reason: 'no-matching-run' | 'multiple-matching-runs'; candidateCount: number }
  | { kind: 'run-fixed'; acceptanceId: string; runId: string }
  | { kind: 'progress'; acceptanceId: string; runId: string; event: string; ts: string }
  | { kind: 'terminal'; acceptanceId: string; runId: string; outcome: GoalRunRecord['record']['outcome']; stage: GoalRunRecord['record']['stage']; ok: boolean }
  | { kind: 'poll-limit-reached'; acceptanceId: string; runId: string; maxPolls: number };

export interface HarnessCorrelationObserverDeps {
  readonly queryGoalRuns?: (acceptanceId: string) => readonly GoalRunRecord[] | null;
  readonly queryRunEvents: (runId: string) => readonly { id: number; event: string; ts: string }[];
}

function queryGoalRunsByCorrelation(acceptanceId: string): readonly GoalRunRecord[] | null {
  return loadGoalRunQuery({ docFilters: [{ path: '$.correlationId', value: acceptanceId }], limit: 2 })?.records ?? null;
}

/**
 * Observe only the persisted run whose correlationId exactly equals this request's acceptanceId.
 * This unit intentionally has no POST/HTTP wiring; the caller owns transport and delivery.
 */
export async function* observeHarnessCorrelation(
  acceptanceId: string,
  deps: HarnessCorrelationObserverDeps,
  maxPolls = 10,
): AsyncGenerator<HarnessCorrelationObservation> {
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1) throw new RangeError('maxPolls must be a positive safe integer');
  const candidates = (deps.queryGoalRuns ?? queryGoalRunsByCorrelation)(acceptanceId);
  if (candidates === null || candidates.length === 0) {
    yield { kind: 'ownership-unproven', acceptanceId, reason: 'no-matching-run', candidateCount: 0 };
    return;
  }
  if (candidates.length !== 1) {
    yield { kind: 'ownership-unproven', acceptanceId, reason: 'multiple-matching-runs', candidateCount: candidates.length };
    return;
  }

  const [{ runId }] = candidates;
  yield { kind: 'run-fixed', acceptanceId, runId };
  const seenEvents = new Set<string>();
  for (let poll = 0; poll < maxPolls; poll += 1) {
    for (const event of deps.queryRunEvents(runId)) {
      const key = String(event.id);
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      yield { kind: 'progress', acceptanceId, runId, event: event.event, ts: event.ts };
    }
    const terminal = (deps.queryGoalRuns ?? queryGoalRunsByCorrelation)(acceptanceId)?.find((candidate) => candidate.runId === runId)?.record;
    if (terminal?.completedAt !== undefined) {
      yield { kind: 'terminal', acceptanceId, runId, outcome: terminal.outcome, stage: terminal.stage, ok: terminal.ok };
      return;
    }
  }
  yield { kind: 'poll-limit-reached', acceptanceId, runId, maxPolls };
}

function defaultAskDeps(rows: Awaited<ReturnType<typeof askIo.readAskPreflightLogRows>>) {
  return {
    print: () => {},
    log: (event: string, data: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => debug.log('harness-http', event, data, { level }),
    readLine: async () => '',
    readClarification: async () => '',
    readFile: (file: string) => readFileSync(file, 'utf8'),
    writeFile: (file: string, data: string) => writeFileSync(file, data, 'utf8'),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    isInteractive: () => false,
    buildPreflightDeps: askIo.buildAskPreflightDeps,
    priorBlockSamples: () => askIo.priorBlockSamplesFrom(rows),
    recentAuthoringSamples: () => askIo.recentAuthoringSamplesFrom(rows),
    authorGoal: async (authorArgs: string[], options: object) => {
      const { runGoalAuthorCli } = await import('../../self-implement/goal-author-cli.js');
      return runGoalAuthorCli(authorArgs, options as never);
    },
    relativeToCwd: (file: string) => relative(process.cwd(), file),
  };
}

/** Accept a chat-surface ask immediately and author/launch it in the background. */
export async function handleHarnessAskPost(req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: ASK_USAGE }, 400); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: ASK_USAGE }, 400);
  const text = typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text.trim() : '';
  if (!text) return json({ error: ASK_USAGE }, 400);
  const sessionId = typeof (body as { sessionId?: unknown }).sessionId === 'string'
    ? (body as { sessionId: string }).sessionId
    : '';
  const hasTarget = Object.prototype.hasOwnProperty.call(body, 'target');
  const target = (body as { target?: unknown }).target;
  if (hasTarget && typeof target !== 'string') return json({ error: 'invalid harness target: target must be a string' }, 400);
  if (typeof target === 'string') {
    const resolution = resolveHarnessTarget(target);
    if (resolution.status !== 'git-repo' && resolution.status !== 'non-git-dir' && resolution.status !== 'file') {
      return json({ error: `invalid harness target: ${resolution.status}` }, 400);
    }
  }

  const acceptanceId = deps.createAcceptanceId?.() ?? crypto.randomUUID();
  const log = deps.log ?? ((event, data) => debug.log('harness-http', event, data));
  const suppliedOrigin = (body as { origin?: unknown }).origin;
  const origin = suppliedOrigin === undefined ? null
    : readReportOrigin({ [REPORT_ORIGIN_ENV]: JSON.stringify(suppliedOrigin) });
  if (suppliedOrigin !== undefined && !origin) log('ask-origin-ignored', { acceptanceId, reason: 'invalid-origin' });
  const ask = deps.runAskLaunchFlow ?? runAskLaunchFlow;
  const launch = deps.launchDevGoalFileDetached ?? launchDevGoalFileDetached;
  const emitFeedback = deps.createFeedbackEmitter?.(acceptanceId);
  const feedbackSeq = createSeqTracker();
  rememberAcceptedAsk(acceptanceId);
  const emitCompletion = (detail: string) => {
    if (!emitFeedback) return;
    try {
      void Promise.resolve(emitFeedback(makeEnvelope({
        kind: 'tool.progress',
        sessionId,
        blockId: `${acceptanceId}:harness-ask`,
        phase: 'end',
        payload: { stream: 'generic', lines: [detail] },
        asciiFallback: [detail],
      }, feedbackSeq))).catch((error) => {
        log('ask-feedback-failed', { acceptanceId, message: message(error) });
      });
    } catch (error) {
      log('ask-feedback-failed', { acceptanceId, message: message(error) });
    }
  };
  log('ask-accepted', { acceptanceId, textLength: text.length });
  void (async () => {
    try {
      const prep = prepareAskLaunch({ kind: 'say', value: text }, {});
      const rows = await askIo.readAskPreflightLogRows();
      const result: AskLaunchFlowResult = await ask({
        entrance: DAEMON_HARNESS_ASK_ENTRANCE,
        inputSource: 'say',
        askText: text,
        liveRunWindowMinutes: prep.liveRunWindowMinutes,
        recentChangeWindowDays: prep.recentChangeWindowDays,
        forceRequested: false,
        decomposeBeforeLaunch: true,
      }, defaultAskDeps(rows) as never);
      log('ask-flow-settled', { acceptanceId, kind: result.kind });
      if (result.kind === 'launch') {
        log('ask-launch-started', { acceptanceId, goalFile: result.goalFile });
        await launch({ goalFile: result.goalFile, correlation: acceptanceId, ...(typeof target === 'string' ? { target } : {}), ...(origin ? { env: encodeReportOriginEnv(origin) } : {}) });
        log('ask-launch-settled', { acceptanceId, goalFile: result.goalFile });
        emitCompletion(`Harness ask launched: ${result.goalFile}`);
      } else {
        emitCompletion('Harness ask stopped before launch');
      }
    } catch (error) {
      const failure = message(error);
      log('ask-launch-failed', { acceptanceId, message: failure });
      emitCompletion(`Harness ask failed: ${failure}`);
    }
  })();
  return json({ accepted: true, acceptanceId, entrance: DAEMON_HARNESS_ASK_ENTRANCE.id }, 202);
}

/** Return the latest persisted lifecycle phase for an accepted harness ask. */
export function handleHarnessAskStatusGet(req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Response {
  const acceptanceId = new URL(req.url).searchParams.get('acceptanceId')?.trim();
  if (!acceptanceId) return json({ error: ASK_STATUS_USAGE }, 400);
  const store = deps.askStatusLogStore ?? getDefaultLogStore();
  if (!store) return json({ error: 'log-store-unavailable' }, 503);
  const events = queryHarnessAskLifecycle(store, acceptanceId);
  if (events.length === 0) {
    const issuedAt = acceptedAskIssuedAt.get(acceptanceId);
    if (issuedAt === undefined) return json({ error: 'harness ask not found', acceptanceId }, 404);
    return json({
      acceptanceId,
      phase: 'accepted',
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - issuedAt) / 1_000)),
    });
  }
  const latest = events.at(-1)!;
  const goalFile = events
    .filter(({ row }) => row.event === 'ask-launch-started')
    .map(({ data }) => data.goalFile)
    .find((value): value is string => typeof value === 'string');
  const candidates = (deps.queryGoalRunsByCorrelation ?? queryGoalRunsByCorrelation)(acceptanceId);
  const runStore = deps.askStatusRunLogStore ?? getDefaultLogStore();
  const runId = candidates?.length === 1
    ? candidates[0].runId
    : (candidates?.length === 0 || candidates === null) && runStore
      ? queryHarnessAskStartRunId(runStore, acceptanceId)
      : undefined;
  return json({
    acceptanceId,
    phase: ASK_STATUS_EVENT_TO_PHASE[latest.row.event as keyof typeof ASK_STATUS_EVENT_TO_PHASE],
    ...(goalFile ? { goalFile } : {}),
    ...(runId ? { runId } : {}),
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - events[0].row.ts_ms) / 1_000)),
  });
}

/** One terminated run for `GET /v1/harness/runs?finishedSince=` (iPhone «오늘 끝난 일» · 2026-09-30). */
export interface HarnessFinishedRun {
  runId: string;
  status: string;
  endedAt: string;
  /** 마지막 `run-status` 의 `stage`(예: `merged`·`pr-declined`) — 칩을 더 정확히 고를 때. */
  stage?: string;
  objective?: string;
  prUrl?: string;
  /** `merged` 이벤트의 값 — 이벤트가 없으면 칸이 없다(«병합 안 됨»으로 접지 않는다). */
  merged?: boolean;
  /** 마지막 `merge-decision` 의 `decision`(`auto`·`hitl`) — 병합 «결정»이지 병합 «사실»이 아니다. */
  mergeDecision?: string;
}

export const FINISHED_RUNS_LIMIT = 20;
export const FINISHED_RUNS_MAX_FILES = 300;
export const FINISHED_RUNS_MAX_FILE_BYTES = 5 * 1024 * 1024;
const FINISHED_OBJECTIVE_MAX_CHARS = 160;

/**
 * 원장 디렉터리에서 `sinceMs` 이후에 쓰인 «끝난» 런을 요약한다. 읽기는 묶여 있다 —
 * mtime 최신 {@link FINISHED_RUNS_MAX_FILES} 개만 보고, {@link FINISHED_RUNS_MAX_FILE_BYTES} 를 넘는 파일은 건너뛴다.
 */
export function collectFinishedRuns(dir: string, sinceMs: number): { runs: HarnessFinishedRun[]; scannedFiles: number; skippedFiles: number } {
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return { runs: [], scannedFiles: 0, skippedFiles: 0 }; }
  const candidates: Array<{ runId: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile() && st.mtimeMs >= sinceMs) candidates.push({ runId: name.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* 사이에 지워졌다 */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = candidates.slice(0, FINISHED_RUNS_MAX_FILES);
  let skippedFiles = candidates.length - scanned.length;
  const runs: HarnessFinishedRun[] = [];
  for (const file of scanned) {
    if (file.size > FINISHED_RUNS_MAX_FILE_BYTES) { skippedFiles += 1; continue; }
    let entries: RunLedgerEntry[] | null;
    try { entries = loadRunLedger(file.runId, dir); }
    catch { skippedFiles += 1; continue; }
    if (!entries?.length || !hasTerminalRunStatus(entries)) continue;
    let summary: ReturnType<typeof summarizeTerminalLedger>;
    try { summary = summarizeTerminalLedger(file.runId, entries); }
    catch { skippedFiles += 1; continue; }
    if (!(Date.parse(summary.endedAt) >= sinceMs)) continue;
    const feature = entries.find((entry) => entry.event === 'start' && typeof entry.data.feature === 'string')?.data.feature as string | undefined;
    const objective = feature?.trim().slice(0, FINISHED_OBJECTIVE_MAX_CHARS);
    const mergedEvent = [...entries].reverse().find((entry) => entry.event === 'merged' && typeof entry.data.merged === 'boolean');
    const decision = [...entries].reverse().find((entry) => entry.event === 'merge-decision' && typeof entry.data.decision === 'string');
    const statusEntry = [...entries].reverse().find((entry) => entry.event === 'run-status' && typeof entry.data.stage === 'string');
    runs.push({
      runId: summary.runId,
      status: summary.status,
      endedAt: summary.endedAt,
      ...(statusEntry ? { stage: statusEntry.data.stage as string } : {}),
      ...(objective ? { objective } : {}),
      ...(summary.prUrl ? { prUrl: summary.prUrl } : {}),
      ...(mergedEvent ? { merged: mergedEvent.data.merged as boolean } : {}),
      ...(decision ? { mergeDecision: decision.data.decision as string } : {}),
    });
  }
  runs.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
  return { runs: runs.slice(0, FINISHED_RUNS_LIMIT), scannedFiles: scanned.length, skippedFiles };
}

/** 도는 런의 목표 — 그 런 원장의 첫 `start.data.feature`(≤160자). 원장 경로는 그 항목이 준 디렉터리들만 본다(런 수만큼만 읽는다). */
export function runObjectiveFromLedgers(runId: string, directories: readonly string[]): string | undefined {
  for (const dir of directories) {
    try {
      if (statSync(runLedgerPath(runId, dir)).size > FINISHED_RUNS_MAX_FILE_BYTES) continue;
      const feature = loadRunLedger(runId, dir)?.find((entry) => entry.event === 'start' && typeof entry.data.feature === 'string')?.data.feature;
      const objective = typeof feature === 'string' ? feature.trim().slice(0, FINISHED_OBJECTIVE_MAX_CHARS) : '';
      if (objective) return objective;
    } catch { /* 없거나 못 읽음 — 다음 디렉터리 */ }
  }
  return undefined;
}

// ── 오늘 착지(= main 에 병합된 PR) — 원장은 Pod·시험 우주의 런을 못 보므로 GitHub 이 정본이다 ──

/** `landed` 한 줄 — `gh pr list --json number,title,url,mergedAt` 모양 그대로. */
export interface HarnessLandedPr {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

export const LANDED_PRS_LIMIT = 30;
export const LANDED_PRS_TIMEOUT_MS = 4_000;
const LANDED_CACHE_MS = 60_000;
const landedCache = new Map<string, { at: number; prs: HarnessLandedPr[]; truncated: boolean }>();
let cachedRepoSlug: string | null | undefined;

export function _resetLandedPrsCacheForTest(): void {
  landedCache.clear();
  cachedRepoSlug = undefined;
}

export interface LandedPrsDeps {
  /** gh 실행기(기본 = `git-fs/gh-cli` 의 재시도 게이트웨이 · 비동기). */
  readonly runGh?: (args: string[]) => Promise<{ ok: boolean; exitCode: number; stdout: Buffer | string; stderr: Buffer | string }>;
  /** 저장소 `owner/name` — 기본은 데몬이 아는 저장소 뿌리(`harness.defaultRepo` → cwd)의 origin. */
  readonly repoSlug?: () => Promise<string | null>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

async function defaultRepoSlug(): Promise<string | null> {
  if (cachedRepoSlug !== undefined) return cachedRepoSlug;
  const [{ resolveWorktreesRepoRoot }, { slugFromRemote }] = await Promise.all([import('./worktrees.js'), import('./live-shipped.js')]);
  const root = resolveWorktreesRepoRoot();
  if (!root) return (cachedRepoSlug = null);
  const proc = Bun.spawn(['git', '-C', root, 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'ignore' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return (cachedRepoSlug = code === 0 ? slugFromRemote(out) : null);
}

async function defaultRunGh(args: string[]) {
  const { runGhCliWithResultAsync } = await import('../../git-fs/gh-cli.js');
  return runGhCliWithResultAsync(args);
}

function isLandedPr(value: unknown): value is HarnessLandedPr {
  const v = value as Partial<HarnessLandedPr> | null;
  return !!v && typeof v.number === 'number' && typeof v.title === 'string' && typeof v.url === 'string' && typeof v.mergedAt === 'string';
}

/** `sinceMs` 이후 main 에 병합된 PR(최신순 ≤30). 실패·시간 초과는 던지지 않고 `error` 로 돌려준다. 성공만 60초 캐시한다. */
export async function listLandedPrs(sinceMs: number, deps: LandedPrsDeps = {}): Promise<{ prs: HarnessLandedPr[]; error?: string; cached?: boolean; truncated?: boolean }> {
  const now = deps.now?.() ?? Date.now();
  const sinceIso = new Date(Math.floor(sinceMs / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hit = landedCache.get(sinceIso);
  if (hit && now - hit.at < LANDED_CACHE_MS) return { prs: hit.prs, cached: true, ...(hit.truncated ? { truncated: true } : {}) };
  const timeoutMs = deps.timeoutMs ?? LANDED_PRS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ prs: HarnessLandedPr[]; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ prs: [], error: `timeout ${timeoutMs}ms` }), timeoutMs);
  });
  const work = (async (): Promise<{ prs: HarnessLandedPr[]; error?: string; truncated?: boolean }> => {
    try {
      const slug = await (deps.repoSlug ?? defaultRepoSlug)();
      if (!slug) return { prs: [], error: 'no-repository' };
      const result = await (deps.runGh ?? defaultRunGh)([
        'pr', 'list', '--repo', slug, '--state', 'merged', '--base', 'main',
        '--search', `merged:>=${sinceIso}`,
        '--json', 'number,title,url,mergedAt', '--limit', String(LANDED_PRS_LIMIT),
      ]);
      if (!result.ok) {
        const stderr = String(result.stderr).trim().split('\n')[0] ?? '';
        return { prs: [], error: `gh failed rc=${result.exitCode}${stderr ? `: ${redactSecretText(stderr).slice(0, 120)}` : ''}` };
      }
      const parsed: unknown = JSON.parse(String(result.stdout));
      if (!Array.isArray(parsed)) return { prs: [], error: 'gh returned non-array' };
      const prs = parsed.filter(isLandedPr)
        .filter((pr) => Date.parse(pr.mergedAt) >= sinceMs)
        .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
      // gh 가 상한만큼 줬으면 더 있을 수 있다 — «전부»라고 말하지 않는다.
      const truncated = parsed.length >= LANDED_PRS_LIMIT;
      landedCache.set(sinceIso, { at: now, prs, truncated });
      return { prs, ...(truncated ? { truncated: true } : {}) };
    } catch (error) {
      return { prs: [], error: message(error).slice(0, 120) };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Return the structured shared running-runs observation without human rendering.
 *  `?finishedSince=<epoch ms>` 가 있으면(iPhone «오늘» · 2026-09-30) 셋을 더한다 —
 *  `finished`(이 우주 원장의 끝난 런 · 최신순 ≤20) · `landed`(그 시각 뒤 main 에 병합된 PR · ≤30 · 실패면 `[]` ⊕ `landedError`) ·
 *  도는 항목마다 `objective`(그 런 원장의 `start.feature`). 없으면 응답은 종전 그대로다(동기 응답). */
export function handleHarnessRunsGet(req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Response | Promise<Response> {
  const runs: RunningRunsResult = (deps.queryRunningRuns ?? queryRunningRuns)({ includeTest: false });
  const raw = new URL(req.url).searchParams.get('finishedSince');
  if (raw === null) return json(runs);
  const sinceMs = Number(raw);
  if (!raw.trim() || !Number.isFinite(sinceMs) || sinceMs < 0) {
    return json({ error: 'usage: GET /v1/harness/runs?finishedSince=<epoch ms>' }, 400);
  }
  return (async () => {
    const landedWork = listLandedPrs(sinceMs, deps.landed ?? {});
    const dir = deps.ledgerDir ?? runLedgerDir();
    const finished = collectFinishedRuns(dir, sinceMs);
    const entries = runs.entries.map((entry) => {
      const objective = runObjectiveFromLedgers(entry.runId, entry.ledgerDirectories?.length ? entry.ledgerDirectories : [dir]);
      return objective ? { ...entry, objective } : entry;
    });
    const landed = await landedWork;
    debug.log('harness-http', 'runs-finished', {
      sinceMs, count: finished.runs.length, scannedFiles: finished.scannedFiles, skippedFiles: finished.skippedFiles,
      landed: landed.prs.length, landedCached: landed.cached === true, ...(landed.error ? { landedError: landed.error } : {}),
    });
    return json({
      ...runs,
      entries,
      finished: finished.runs,
      finishedObservation: { sinceMs, scannedFiles: finished.scannedFiles, skippedFiles: finished.skippedFiles, limit: FINISHED_RUNS_LIMIT },
      landed: landed.prs,
      ...(landed.truncated ? { landedTruncated: true } : {}),
      ...(landed.error ? { landedError: landed.error } : {}),
    });
  })();
}

/** Return the human-readable skeleton events persisted for one harness run. */
function isHarnessProgressCopy(data: string | null | undefined): boolean {
  if (typeof data !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { message?: unknown }).message === 'string';
  } catch {
    return false;
  }
}

export function handleHarnessRunEventsGet(req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Response {
  const runId = new URL(req.url).searchParams.get('runId')?.trim();
  if (!runId) return json({ error: RUN_EVENTS_USAGE }, 400);
  const store = deps.logStore ?? getDefaultLogStore();
  if (!store) return json({ error: 'log-store-unavailable' }, 503);
  const events = store.queryByDataKeys({ exactCategories: ['self-implement'], runIds: [runId] })
    .filter((row) => HARNESS_RUN_SKELETON_EVENT_SET.has(row.event) && !isHarnessProgressCopy(row.data))
    .sort((left, right) => left.ts_ms - right.ts_ms || left.id - right.id)
    .map((row) => {
      const payload = row.event === 'run-terminal'
        ? terminalPayloadFromLogData(row.data)
        : row.event === 'implemented'
          ? implementedPayloadFromLogData(row.data)
          : undefined;
      return { ts: row.ts, event: row.event, runId, ...(payload === undefined ? {} : { payload }) };
    });
  return json(events);
}

/** GET /v1/harness/run-screen?runId=&lines= — 런의 «화면»(Live 탭 런 서랍 · 🅢 09-28 «런 클릭 → 화면·로그·멈춤»).
 *  runId → 화면 키는 `self screen --run` 과 같은 해석(`headless.spawn` 로그). ⛔ 이 인스턴스 로그만 본다 —
 *  전 우주 스캔은 GET 한 번에 수백 저장소를 연다. 못 찾으면 «이유»를 값으로 돌려준다(오류 아님).
 *  화면 글은 비밀처럼 보이는 조각을 가린다. `stoppable` = 그 화면이 살아 있어 `POST /v1/harness/stop` 이 받는다. */
export function handleHarnessRunScreenGet(req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Response {
  const url = new URL(req.url);
  const runId = url.searchParams.get('runId')?.trim() ?? '';
  if (!runId || /[\\/]|\.\./.test(runId)) return json({ error: 'usage: GET /v1/harness/run-screen?runId=<runId>[&lines=60]' }, 400);
  const lines = Math.min(200, Math.max(5, Number(url.searchParams.get('lines')) || 60));
  const q = (deps.queryRunScreenKey ?? ((id: string) => queryRunScreenKey(id, { logStorePath: logsDbPath() })))(runId);
  if (!q.screenKey) {
    return json({ runId, screenKey: null, text: null, stoppable: false, reason: q.logStoreStatus === 'read' ? 'no-screen-key' : `log-store-${q.logStoreStatus}`, lastEvent: q.lastEvent });
  }
  const tail = (deps.readHarnessScreenTail ?? readHarnessScreenTail)(q.screenKey, lines);
  const stoppable = (deps.listHarnessScreens ?? listHarnessScreens)().some((screen) => screen.spaceId === q.screenKey);
  if (!tail) return json({ runId, screenKey: q.screenKey, text: null, stoppable, reason: 'screen-missing', lastEvent: q.lastEvent });
  return json({ runId, screenKey: q.screenKey, text: redactSecretText(tail.text), outcome: tail.outcome, stoppable, lastEvent: q.lastEvent });
}

/** Queue a soft stop for an existing harness screen. */
export async function handleHarnessStopPost(req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: STOP_USAGE }, 400); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: STOP_USAGE }, 400);
  const spaceId = typeof (body as { spaceId?: unknown }).spaceId === 'string' ? (body as { spaceId: string }).spaceId.trim() : '';
  if (!spaceId) return json({ error: STOP_USAGE }, 400);
  const screens = (deps.listHarnessScreens ?? listHarnessScreens)();
  if (!screens.some((screen) => screen.spaceId === spaceId)) {
    return json({ error: 'harness screen not found', candidates: screens.map((screen) => screen.spaceId) }, 404);
  }
  (deps.enqueueSoftStop ?? enqueueSoftStop)(spaceId);
  return json({ stopped: spaceId });
}
