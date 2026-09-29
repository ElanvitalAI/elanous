import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
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

/** Return the structured shared running-runs observation without human rendering. */
export function handleHarnessRunsGet(_req: Request, _metaApi: HarnessMetaApi, deps: HarnessApiDeps = {}): Response {
  const runs: RunningRunsResult = (deps.queryRunningRuns ?? queryRunningRuns)({ includeTest: false });
  return json(runs);
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
