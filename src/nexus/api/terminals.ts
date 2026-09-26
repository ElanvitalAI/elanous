// NEXUS · /v1/terminals — read-only terminal inspection (CV-3 P4.2).
//
// Surfaces the live PTY process registry (`src/pty-shell/registry.ts`)
// over HTTP so PWA surfaces (Showroom · webterm pickers) can fetch a
// snapshot of any running shell without forcing the user to copy/paste
// from another window. Ships read-only — no spawn/kill via REST (those
// are session-scoped operations on the dashboard / webterm UI). Scope
// is bounded to the existing `pty-shell/registry` so MVP is a thin
// HTTP veneer over `listPty()` / `getPty()`.
//
// Endpoints:
//   GET /v1/terminals
//     → { terminals: [{ id, cmd, workdir, alive, exitCode, startedAt,
//                       outputBytes }] }
//   GET /v1/terminals/:id/scrollback?lines=N
//     → { id, lines: number, totalLines: number, scrollback: string }
//
// Auth: same checkAuth() gate as `/v1/tools` (same-origin or bearer).
// Default `lines` is 50 (matches Showroom RFC v4 D14 default · `frozen
// snapshot · last 50 lines`).

import { jsonResponse } from './http-server.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { getPty, listPty, type PtyHandle } from '../../pty-shell/registry.js';
import { listAllPreviewTerminals } from '../../web-terminal/preview-tap-registry.js';
import { debug } from '../../debug/log.js';
export { terminalTreeLabel, terminalTreeNames } from '../../pty-shell/terminal-tree.js';
import { terminalTreeLabel, terminalTreeNames } from '../../pty-shell/terminal-tree.js';
// ★ 크로스-프로세스 관측(2026-07-23) — in-process registry ∪ 공유 매니페스트(다른 elanous 프로세스의 헤드리스 PTY).
import { isProcessAlive, listPtyManifest, listPtyManifestRows, listPtyManifestRowsAt, getPtyManifest, ptyManifestDbPath, reapDeadPtyManifest, reapDeadPtyManifestAt, purgeClosedPtyManifest, reapOrphanedOwnedPtyManifest, reapStalePtyManifest, type PtyManifestExternalReapResult, type PtyManifestRow } from '../../pty-shell/pty-manifest.js';
import { ptyManifestTargets } from '../../domains/fleet.js';
import { readPtyEventsAfter } from '../../pty-shell/pty-event-log.js';
import { classifyPtyOwnerRunUsage, joinPtyLineage, resolveRunTermination, type PtyOwnerRunUsage, type RunTermination } from '../../cli/pty-takeover-cli.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, runLedgerDir } from '../../self-implement/run-ledger.js';
import { requestRemotePtyControl, type PtyControlAction, type PtyControlPayload, type PtyControlRequestOptions, type PtyControlResult } from '../../pty-shell/pty-control-ipc.js';
import { queryRunningRuns, type RunningRunAssessment, type RunningRunPresence, type RunningRunStatus, type RunningRunsResult } from '../../self-implement/running-runs.js';
// ⭐P4 §4-1 — 표시 폭(wide-char/CJK/emoji 인지) SSOT. PNG 캔버스 cols 파생용.
import { cellWidth } from '../../ui/printer.js';
import { relativeHistoryAge } from '../../acp/channel-browser-catalog.js';
import { loadSelfDevRun } from '../../self-dev/run-store.js';
import { getDefaultLogStore, LogStore, type LogStoreRow } from '../../mss/logging/log-store.js';
import { readProdInstances } from '../../mss/logging/instance-registry.js';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/** Default scrollback line count when ?lines is omitted (RFC v4 D14). */
const DEFAULT_LINES = 50;
/** Hard cap so a misbehaving caller cannot OOM the response. The pty
 *  registry trims its head/tail to ~512 KB total, so this cap is well
 *  above the realistic upper bound. */
const MAX_LINES = 5000;

/** ANSI escape sequence regex (P4.2 OQ-3 follow-up). Matches CSI/OSC/etc.
 *  Reference: ECMA-48 8.3.x · plus the common ESC] OSC variants and
 *  bare ESC + single-char (e.g. \x1b=, \x1b>). */
const ANSI_RE = /[][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Decode a URL path segment, returning null on malformed percent-encoding
 *  (e.g. `%ZZ`) instead of letting `decodeURIComponent`'s throw escape into
 *  the request dispatcher (review should-fix). A null → the route simply
 *  doesn't match → 404, never a 500/crash. */
function safeDecodeSegment(seg: string): string | null {
  try { return decodeURIComponent(seg); } catch { return null; }
}

export interface TerminalSummary {
  id: string;
  cmd: string;
  workdir?: string;
  nickname?: string;
  treeName: string;
  worktreeName: string;
  parentPtyId: string;
  parentPid: number;
  parentKind: string;
  runId: string;
  chainOrigin?: string;
  nestDepth?: number;
  originRoot?: string;
  originAgent?: string;
  /** Canonical manifest/CLI terminal provenance; always explicit for process rows. */
  terminalOriginCategory?: 'direct-human' | 'elanous' | 'external-tool' | 'unknown';
  terminalOriginReason?: string;
  externalToolName?: string;
  /** Omitted when absent; an empty string remains an explicit controller value. */
  controller?: string;
  /** Who requested this terminal according to row-local execution evidence. */
  origin: 'human' | 'system' | 'unknown';
  /** The producer that supplied this row to the terminal list. */
  producer: 'process' | 'web-registration';
  alive: boolean;
  /** null while still running, exit code (or signal-derived synthetic
   *  value) once the PTY exits. */
  exitCode: number | null;
  startedAt: number;
  /** Total bytes currently held in the head/tail buffer (after trim). */
  outputBytes: number;
  /** The owner-process access mode, or null when this row is manifest-only. */
  accessMode: 'read' | 'write' | 'auto' | null;
  /** Why accessMode is unavailable; null when an access mode is present. */
  accessModeUnavailableReason: 'owner-process-only' | 'not-applicable' | null;
  /** Whether this PTY owner's run is active; unknown means the evidence is unavailable. */
  ownerRunUsage: PtyOwnerRunUsage;
  /** Millisecond timestamp of the last external control request, when recorded by the manifest. */
  lastControlAt?: number;
  /** Present for rows read from a federated manifest root. */
  sourceRoot?: { name: string; dbPath: string };
}

export function terminalAgeBadge(startedAt: number, now = Date.now()): string {
  return relativeHistoryAge(startedAt, now);
}

export function terminalParentIdentity(row: Pick<TerminalSummary, 'parentPtyId' | 'parentPid' | 'parentKind'>): string {
  const kind = row.parentKind === 'pty' ? 'P' : row.parentKind === 'process' ? 'p' : '?';
  const parent = row.parentKind === 'pty' ? row.parentPtyId || '-' : row.parentPid ? String(row.parentPid) : '-';
  return `${kind}:${parent}`;
}

export function terminalOriginIdentity(row: Pick<TerminalSummary, 'originRoot' | 'originAgent' | 'nestDepth' | 'chainOrigin'>): string {
  return `출신: 루트 ${row.originRoot ?? '미상'} · 에이전트 ${row.originAgent ?? '미상'} · 깊이 ${row.nestDepth === undefined ? '미상' : row.nestDepth} · 체인 ${row.chainOrigin ?? '미상'}`;
}

export interface TerminalSgrStyle {
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  foreground: string | null;
  background: string | null;
}

export interface TerminalSgrSegment {
  text: string;
  style: TerminalSgrStyle;
}

/** Parse printable terminal text into runs sharing one supported SGR style.
 * The body is deliberately self-contained because its source is injected into
 * the observatory document with Function#toString(). */
export function parseTerminalSgr(frame: string): TerminalSgrSegment[] {
  var colors = ['var(--term-black)', 'var(--term-red)', 'var(--term-green)', 'var(--term-yellow)', 'var(--term-blue)', 'var(--term-magenta)', 'var(--term-cyan)', 'var(--term-white)'];
  var palette256 = function (index: number): string | null {
    if (!Number.isInteger(index) || index < 0 || index > 255) return null;
    if (index < 8) return colors[index]!;
    if (index < 16) return 'var(--term-bright-' + colors[index - 8]!.slice(11);
    if (index < 232) {
      var n = index - 16;
      var r = Math.floor(n / 36);
      var g = Math.floor(n % 36 / 6);
      var b = n % 6;
      var level = function (value: number): number { return value === 0 ? 0 : 55 + value * 40; };
      return 'rgb(' + level(r) + ', ' + level(g) + ', ' + level(b) + ')';
    }
    var gray = 8 + (index - 232) * 10;
    return 'rgb(' + gray + ', ' + gray + ', ' + gray + ')';
  };
  var rgb = function (r: number, g: number, b: number): string | null {
    if (![r, g, b].every(function (value) { return Number.isInteger(value) && value >= 0 && value <= 255; })) return null;
    return 'rgb(' + r + ', ' + g + ', ' + b + ')';
  };
  var style: TerminalSgrStyle = { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null };
  var segments: TerminalSgrSegment[] = [];
  var sgr = /\x1b\[[0-9;]*m/g;
  var cursor = 0;
  var match: RegExpExecArray | null;
  var control = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/g;
  var clone = function (current: TerminalSgrStyle): TerminalSgrStyle {
    return { bold: current.bold, faint: current.faint, italic: current.italic, underline: current.underline, inverse: current.inverse, foreground: current.foreground, background: current.background };
  };
  var append = function (text: string): void {
    text = text.replace(control, '');
    if (!text) return;
    var previous = segments[segments.length - 1];
    var next = clone(style);
    if (previous && previous.style.bold === next.bold && previous.style.faint === next.faint && previous.style.italic === next.italic && previous.style.underline === next.underline && previous.style.inverse === next.inverse && previous.style.foreground === next.foreground && previous.style.background === next.background) previous.text += text;
    else segments.push({ text, style: next });
  };
  while ((match = sgr.exec(frame))) {
    append(frame.slice(cursor, match.index));
    var params = match[0].slice(2, -1).split(';').map(function (value) { return value === '' ? 0 : Number(value); });
    for (var i = 0; i < params.length; i += 1) {
      var code = params[i];
      if (code === 0) style = { bold: false, faint: false, italic: false, underline: false, inverse: false, foreground: null, background: null };
      else if (code === 1) style.bold = true;
      else if (code === 2) style.faint = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 7) style.inverse = true;
      else if (code === 22) { style.bold = false; style.faint = false; }
      else if (code === 23) style.italic = false;
      else if (code === 24) style.underline = false;
      else if (code === 27) style.inverse = false;
      else if (code >= 30 && code <= 37) style.foreground = colors[code - 30]!;
      else if (code >= 40 && code <= 47) style.background = colors[code - 40]!;
      else if (code >= 90 && code <= 97) style.foreground = 'var(--term-bright-' + colors[code - 90]!.slice(11);
      else if (code >= 100 && code <= 107) style.background = 'var(--term-bright-' + colors[code - 100]!.slice(11);
      else if (code === 39) style.foreground = null;
      else if (code === 49) style.background = null;
      else if (code === 38 || code === 48) {
        var color: string | null = null;
        if (params[i + 1] === 5) {
          color = palette256(params[i + 2]!);
          i += 2;
        } else if (params[i + 1] === 2) {
          color = rgb(params[i + 2]!, params[i + 3]!, params[i + 4]!);
          i += 4;
        }
        if (color) {
          if (code === 38) style.foreground = color;
          else style.background = color;
        }
      }
    }
    cursor = match.index + match[0].length;
  }
  append(frame.slice(cursor));
  return segments;
}

/** Classifies a terminal row only from its explicit requester marker.
 * Parent topology and agent/controller metadata describe execution, not who
 * requested the terminal, so they must not turn an otherwise unknown row into
 * a guessed system row. */
export function terminalOrigin(row: Pick<TerminalSummary, 'originRoot' | 'originAgent' | 'controller' | 'parentKind'>): TerminalSummary['origin'] {
  if (row.originRoot === 'human-cli') return 'human';
  if (row.originRoot === 'external-agent') return 'system';
  return 'unknown';
}

function accessModeUnavailableReason(
  producer: TerminalSummary['producer'],
  accessMode: TerminalSummary['accessMode'],
): TerminalSummary['accessModeUnavailableReason'] {
  if (accessMode !== null) return null;
  return producer === 'process' ? 'owner-process-only' : 'not-applicable';
}

function ownerRunUsage(
  ownerProcessAlive: boolean | undefined,
  runId: string,
  resolveRunTerminationForRow: (runId: string) => RunTermination,
): PtyOwnerRunUsage {
  return classifyPtyOwnerRunUsage(ownerProcessAlive, resolveRunTerminationForRow(runId));
}

/** Matches `pty list --json`: malformed or legacy decisions remain explicitly unknown. */
function terminalOriginFields(row: Pick<PtyManifestRow, 'terminalOriginCategory' | 'terminalOriginReason' | 'externalToolName'>): Pick<TerminalSummary, 'terminalOriginCategory' | 'terminalOriginReason' | 'externalToolName'> {
  const category = row.terminalOriginCategory;
  const reason = row.terminalOriginReason;
  if ((category === 'direct-human' || category === 'elanous' || category === 'external-tool' || category === 'unknown') && reason) {
    return {
      terminalOriginCategory: category,
      terminalOriginReason: reason,
      ...(category === 'external-tool' && row.externalToolName ? { externalToolName: row.externalToolName } : {}),
    };
  }
  return { terminalOriginCategory: 'unknown', terminalOriginReason: 'legacy-or-malformed-origin-decision' };
}

function summarize(
  handle: PtyHandle,
  manifest: PtyManifestRow | null,
  resolveRunTerminationForRow: (runId: string) => RunTermination,
  isOwnerProcessAlive: (pid: number) => boolean,
): TerminalSummary {
  const names = terminalTreeNames(handle.workdir);
  const snapshot = handle.snapshot();
  return {
    id: handle.id,
    cmd: handle.cmd,
    ...(handle.workdir ? { workdir: handle.workdir } : {}),
    ...(manifest?.nickname ? { nickname: manifest.nickname } : {}),
    ...names,
    parentPtyId: manifest?.parentPtyId ?? '',
    parentPid: manifest?.parentPid ?? 0,
    parentKind: manifest?.parentKind ?? '',
    runId: manifest?.runId ?? '',
    ...(manifest?.originRoot === undefined ? {} : { originRoot: manifest.originRoot }),
    ...(manifest?.originAgent === undefined ? {} : { originAgent: manifest.originAgent }),
    ...(manifest ? terminalOriginFields(manifest) : {}),
    ...(manifest?.controller === undefined ? {} : { controller: manifest.controller }),
    origin: terminalOrigin({
      originRoot: manifest?.originRoot,
      originAgent: manifest?.originAgent,
      controller: manifest?.controller,
      parentKind: manifest?.parentKind ?? '',
    }),
    producer: 'process',
    alive: handle.isAlive(),
    exitCode: handle.exitCode,
    startedAt: handle.startedAt,
    outputBytes: snapshot.length,
    accessMode: handle.accessMode,
    accessModeUnavailableReason: accessModeUnavailableReason('process', handle.accessMode),
    ownerRunUsage: ownerRunUsage(manifest?.ownerPid !== undefined ? isOwnerProcessAlive(manifest.ownerPid) : undefined, manifest?.runId ?? '', resolveRunTerminationForRow),
    ...(manifest?.lastControlAt === undefined ? {} : { lastControlAt: manifest.lastControlAt }),
  };
}

/** GET /v1/terminals — list every PTY currently registered. Sorted by
 *  startedAt ascending (oldest first) so callers get a stable order
 *  for picker UIs. Empty registry returns `{ terminals: [] }` (not 404)
 *  — the absence of running terminals is not an error. */
/** 매니페스트 행(원격 PTY) → TerminalSummary. remote:true·instance 태깅으로 in-process 와 구분.
 *  ⭐P2 — `frameAt`(>0 이면 렌더 프레임 보유·S2)를 실어 관측소가 "원시 scrollback" 대신
 *  "사람이 보는 렌더 화면"(픽커/모달 포함)을 기본 표시하도록 신호한다. `kind` 는 tui/harness 구분용. */
function summarizeManifest(
  row: PtyManifestRow,
  resolveRunTerminationForRow: (runId: string) => RunTermination,
  isOwnerProcessAlive: (pid: number) => boolean,
  sourceRoot?: { name: string; dbPath: string },
): TerminalSummary & { remote: true; instance: string; kind: string; frameAt: number } {
  return {
    id: row.id, cmd: row.cmd,
    ...(row.workdir ? { workdir: row.workdir } : {}),
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...terminalTreeNames(row.workdir),
    parentPtyId: row.parentPtyId, parentPid: row.parentPid, parentKind: row.parentKind, runId: row.runId,
    ...(row.chainOrigin === undefined ? {} : { chainOrigin: row.chainOrigin }),
    ...(row.nestDepth === undefined ? {} : { nestDepth: row.nestDepth }),
    ...(row.originRoot === undefined ? {} : { originRoot: row.originRoot }),
    ...(row.originAgent === undefined ? {} : { originAgent: row.originAgent }),
    ...terminalOriginFields(row),
    ...(row.controller === undefined ? {} : { controller: row.controller }),
    origin: terminalOrigin(row),
    producer: 'process',
    alive: row.alive, exitCode: row.exitCode, startedAt: row.startedAt,
    outputBytes: Buffer.byteLength(row.snapshot, 'utf8'),
    // Access mode lives in the owner process, so manifest-only rows cannot know it without IPC.
    accessMode: null,
    accessModeUnavailableReason: accessModeUnavailableReason('process', null),
    ownerRunUsage: ownerRunUsage(isOwnerProcessAlive(row.ownerPid), row.runId, resolveRunTerminationForRow),
    ...(row.lastControlAt === undefined ? {} : { lastControlAt: row.lastControlAt }),
    remote: true, instance: row.instance, kind: row.kind, frameAt: row.frameAt,
    ...(sourceRoot ? { sourceRoot } : {}),
  };
}

/** GET /v1/terminals/lineage?key=... — join current manifest rows with the
 * lifecycle ledger without reaping or otherwise mutating either source. */
export function handleTerminalLineage(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return jsonResponse({ error: 'missing-key' }, 400);
  const sourceRoot = url.searchParams.get('sourceRoot');
  const sourceRows = sourceRoot === null ? undefined : isAllowedSourceRoot(sourceRoot)
    ? listPtyManifestRowsAt(sourceRoot)
    : null;
  if (sourceRows === null) return jsonResponse({ error: 'not-found', sourceRoot }, 404);
  const { groups, unreadablePayloads } = joinPtyLineage(
    sourceRows ?? listPtyManifest(),
    sourceRows ? [] : readPtyEventsAfter(0, { kind: 'lifecycle' }),
    key,
  );
  return jsonResponse({ key, groups, unreadablePayloads }, 200);
}

/** Exact matcher for the lineage collection route, kept separate from the
 * `:id` path matchers so `lineage` can never be interpreted as a PTY id. */
export function parseTerminalLineagePath(pathname: string): boolean {
  return pathname === '/v1/terminals/lineage';
}

/** GET /v1/terminals/runs/:runId/participants — participants registered for one
 * self-dev run. This answers participation within the run, not process
 * ancestry or descendency; use the terminal lineage endpoint for lineage. */
export function handleTerminalRunParticipants(
  req: Request,
  opts: MetaApiOpts,
  runId: string,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const run = loadSelfDevRun(runId);
  const scope = 'Answers who participated within this run. It does not answer process ancestry or descendency; use terminal lineage for that.';
  if (!run) return jsonResponse({ runId, status: 'not-found', participants: [], scope }, 200);
  if (run.participants === undefined) {
    return jsonResponse({ runId, status: 'pre-tracking', participants: [], scope }, 200);
  }
  return jsonResponse({
    runId,
    status: 'tracked',
    participants: run.participants.map(({ id, kind, transports, registeredAt, runIdSource }) => ({
      id,
      kind,
      transportCount: transports.length,
      registeredAt,
      runIdSource,
    })),
    scope,
  }, 200);
}

/** Path matcher for a run's participant collection. */
export function parseTerminalRunParticipantsPath(pathname: string): string | null {
  const match = /^\/v1\/terminals\/runs\/([^/]+)\/participants$/.exec(pathname);
  return match?.[1] ? safeDecodeSegment(match[1]) : null;
}

/** GET /v1/terminals/runs/:runId/goal — original goal text recorded when a run started. */
export function handleTerminalRunGoal(
  req: Request,
  opts: MetaApiOpts,
  runId: string,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const sourceRoot = new URL(req.url).searchParams.get('sourceRoot');
  if (sourceRoot !== null && !isAllowedSourceRoot(sourceRoot)) {
    return jsonResponse({ runId, status: 'source-root-not-found', sourceRoot }, 404);
  }
  const ledgerDirectory = sourceRoot === null ? runLedgerDir() : runLedgerDir(dirname(dirname(sourceRoot)));
  try {
    const ledger = loadRunLedger(runId, ledgerDirectory);
    if (ledger === null) return jsonResponse({ runId, ledgerDirectory, status: 'ledger-not-found' }, 200);
    const start = ledger.find((entry) => entry.event === 'start');
    if (!start) return jsonResponse({ runId, ledgerDirectory, status: 'start-not-found' }, 200);
    const feature = start.data.feature;
    if (typeof feature !== 'string' || !feature) return jsonResponse({ runId, ledgerDirectory, goalId: start.goalId ?? null, status: 'goal-not-found' }, 200);
    return jsonResponse({ runId, ledgerDirectory, goalId: start.goalId ?? null, goal: feature, status: 'found' }, 200);
  } catch {
    return jsonResponse({ runId, ledgerDirectory, status: 'ledger-unreadable' }, 200);
  }
}

/** Path matcher for a run's original-goal record. */
export function parseTerminalRunGoalPath(pathname: string): string | null {
  const match = /^\/v1\/terminals\/runs\/([^/]+)\/goal$/.exec(pathname);
  return match?.[1] ? safeDecodeSegment(match[1]) : null;
}

interface TerminalManifestScopeDeps {
  ptyManifestTargets(opts: { includeTest?: boolean }): Array<{ name: string; dbPath: string }>;
  /** 현재 뿌리의 매니페스트 경로. 연합 집계가 「어느 target 이 정리 대상이었나」를 가르는 데 쓴다. */
  ptyManifestDbPath?(): string;
  /** 물리 경로 비교 seam. 실패 시 원 경로를 보존한다. */
  realpath?(path: string): string;
}

interface TerminalsListDeps extends TerminalManifestScopeDeps {
  listPtyManifestRows?(): readonly PtyManifestRow[];
  listPtyManifestRowsAt(dbPath: string): readonly PtyManifestRow[];
  isProcessAlive(pid: number): boolean;
  listPty?(): PtyHandle[];
  reapDeadPtyManifest?(): number;
  purgeClosedPtyManifest?(now: number): number;
  reapStalePtyManifest?(now: number): number;
  reapOrphanedOwnedPtyManifest?(liveIds: Set<string>): number;
  getDefaultLogStore?(): HiddenSubAgentLogStore | null;
  /** 연합 서브에이전트 카운트용 등록 인스턴스 발견 seam. */
  logInstances?(opts: { includeTest?: boolean }): ReadonlyArray<{ name?: string; dbPath: string; dbExists: boolean }>;
  /** 원격 logs.db 는 읽기 전용으로만 열어 연합한다. */
  openLogStoreReadOnly?(dbPath: string): Pick<LogStore, 'query' | 'close'>;
  queryRunningRuns?(options: { includeTest?: boolean }): RunningRunsResult;
  /** Clock for the running-runs cache. Tests advance this instead of waiting out the TTL. */
  now?(): number;
  runTerminated?(runId: string, options: { includeTest: boolean }): RunTermination;
}

const SUB_AGENT_COUNT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TERMINALS_SCOPE_DOMAIN = '이 표면의 terminals 목록은 실체 PTY만 봅니다. 로그에서 수집한 PTY 없는 Agent 서브 에이전트는 subjects와 scope 집계에만 반영됩니다.';
const TERMINALS_SCOPE_SUB_AGENT_COUNT = '최근 24시간 현재 범위의 로그 스토어에서 센 PTY 없이 실행된 서브 에이전트';

/**
 * Process-wide single-flight cache. Two GET /v1/terminals calls with the same
 * includeTest inside the TTL share one queryRunningRuns result. A different
 * injector (tests) gets its own cache so one suite cannot poison another.
 */
interface RunningRunsCacheBinding {
  cache: (options: { includeTest?: boolean }) => CachedRunningRuns;
  now: () => number;
}

const runningRunsCaches = new WeakMap<object, RunningRunsCacheBinding>();

function runningRunsCacheFor(
  injector: (options: { includeTest?: boolean }) => RunningRunsResult,
  now: () => number,
): (options: { includeTest?: boolean }) => CachedRunningRuns {
  const existing = runningRunsCaches.get(injector);
  if (existing) {
    existing.now = now;
    return existing.cache;
  }
  const binding: RunningRunsCacheBinding = { cache: () => { throw new Error('uninitialized'); }, now };
  binding.cache = createRunningRunsCache({ now: () => binding.now(), queryRunningRuns: injector });
  runningRunsCaches.set(injector, binding);
  return binding.cache;
}

const liveTerminalsListDeps: TerminalsListDeps = {
  ptyManifestTargets,
  listPtyManifestRows,
  listPtyManifestRowsAt,
  isProcessAlive,
  ptyManifestDbPath,
  listPty,
  reapDeadPtyManifest,
  purgeClosedPtyManifest,
  reapStalePtyManifest,
  reapOrphanedOwnedPtyManifest,
  getDefaultLogStore,
  logInstances: readProdInstances,
  openLogStoreReadOnly: LogStore.openReadOnly,
  queryRunningRuns,
  runTerminated(runId, { includeTest }) {
    return resolveRunTermination(runId, resolveFederatedRunLedgerDirectories({ includeTest }), loadRunLedger);
  },
};

export interface TerminalManifestScope {
  readonly federated: boolean;
  readonly includeTest: boolean;
  readonly currentDbPath: string;
  readonly targets: ReadonlyArray<{ name: string; dbPath: string }>;
}

/** Resolves the read-only `all`/`includeTest` list protocol. Cleanup has a
 * separate resolver because expanding a read is not permission to delete. */
export function resolveTerminalManifestScope(req: Request, deps: TerminalManifestScopeDeps = liveTerminalsListDeps): TerminalManifestScope {
  const query = new URL(req.url).searchParams;
  const federated = query.get('all') === 'true';
  const includeTest = query.get('includeTest') === 'true';
  const realpath = deps.realpath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
  const currentDbPath = realpath((deps.ptyManifestDbPath ?? ptyManifestDbPath)());
  if (!federated) return { federated, includeTest, currentDbPath, targets: [{ name: 'current', dbPath: currentDbPath }] };
  const targets: Array<{ name: string; dbPath: string }> = [];
  const seenDbPaths = new Set<string>();
  for (const target of deps.ptyManifestTargets({ includeTest })) {
    const dbPath = realpath(target.dbPath);
    if (seenDbPaths.has(dbPath)) continue;
    seenDbPaths.add(dbPath);
    targets.push({ ...target, dbPath });
  }
  if (!seenDbPaths.has(currentDbPath)) targets.push({ name: 'current', dbPath: currentDbPath });
  return { federated, includeTest, currentDbPath, targets };
}

type HiddenSubAgentLogStore = Pick<LogStore, 'query'> & Partial<Pick<LogStore, 'path' | 'close'>>;

export type PtyLessSubAgentSummary = {
  id: string;
  name: string;
  startedAt: number;
  instance: string;
  sourceRoot: { name: string; dbPath: string };
  hasPty: false;
  alive: boolean | null;
  status: 'unknown' | 'finished' | 'failed' | 'aborted';
  correlationId: string;
  sessionId: string | null;
};

export type SubjectRunAssessment = Pick<RunningRunAssessment, 'status' | 'reason'> & {
  /** Independent observation axis; null means no reusable run assessment was available. */
  presence: RunningRunPresence | null;
};

export interface SubjectSummary {
  id: string;
  runId: string;
  origin: 'system' | 'human';
  screen: { ptyIds: string[]; liveCount: number };
  agent: { names: string[]; controllers: string[] };
  /** Reusable ledger-and-process run assessment, independent of screen.liveness. */
  run: SubjectRunAssessment;
  /** Reserved for a future session-to-execution link; always empty today. */
  talk: [];
}

const unknownSubjectRun = (reason: string): SubjectRunAssessment => ({ status: 'unknown', reason, presence: null });

/** Joins an existing running-runs result onto API subjects without inferring a status for unmatched runs. */
export function enrichSubjectRunAssessments(
  subjects: readonly Omit<SubjectSummary, 'run'>[],
  result: RunningRunsResult | null,
): SubjectSummary[] {
  const assessments = new Map<string, RunningRunAssessment>(result?.entries.map((entry) => [entry.runId, entry]) ?? []);
  return subjects.map((subject) => {
    const assessment = subject.runId ? assessments.get(subject.runId) : undefined;
    const run = assessment
      ? { status: assessment.status, reason: assessment.reason, presence: assessment.presence }
      : unknownSubjectRun(subject.runId ? 'run-assessment-not-found' : 'run-id-missing');
    return { ...subject, run };
  });
}

export type SubjectRunningRunsSummary = Pick<Record<RunningRunStatus, number>, 'running' | 'probable-running'> & {
  /** The only assessments included in this execution count; ended and unknown remain row-level evidence. */
  countedStatuses: readonly ['running', 'probable-running'];
};

/** Short TTL so a polling terminal list does not re-read every ledger on every request. */
export const RUNNING_RUNS_CACHE_TTL_MS = 15_000;

export interface CachedRunningRuns {
  readonly result: RunningRunsResult;
  /** Milliseconds since this result was computed. 0 on a fresh computation. */
  readonly ageMs: number;
}

export interface RunningRunsCacheDeps {
  now(): number;
  queryRunningRuns(options: { includeTest?: boolean }): RunningRunsResult;
}

/**
 * One computation at a time per includeTest.
 *
 * The list handler is synchronous, so two requests overlap only when the
 * second enters while the injector is still on the stack. That re-entrant
 * call shares the in-flight result and does not call the injector again.
 * A later call inside the TTL returns the stored result and its age.
 * A failed computation is not stored. Which runs are running is unchanged.
 */
export function createRunningRunsCache(
  deps: RunningRunsCacheDeps,
  ttlMs: number = RUNNING_RUNS_CACHE_TTL_MS,
): (options: { includeTest?: boolean }) => CachedRunningRuns {
  const slots = new Map<boolean, { at: number; result: RunningRunsResult }>();
  const flights = new Set<boolean>();
  return (options) => {
    const includeTest = options.includeTest === true;
    const now = deps.now();
    const cached = slots.get(includeTest);
    if (flights.has(includeTest)) {
      // Same includeTest is already on this stack. Return the one result
      // the owner publishes into the slot; never call the injector again.
      if (cached) return { result: cached.result, ageMs: 0 };
      const shared = {} as RunningRunsResult;
      slots.set(includeTest, { at: now, result: shared });
      return { result: shared, ageMs: 0 };
    }
    if (cached && now - cached.at < ttlMs) {
      return { result: cached.result, ageMs: now - cached.at };
    }
    flights.add(includeTest);
    try {
      const computed = deps.queryRunningRuns({ includeTest });
      const slot = slots.get(includeTest);
      const result = slot?.result ?? computed;
      if (slot) Object.assign(slot.result, computed);
      else slots.set(includeTest, { at: now, result });
      return { result, ageMs: 0 };
    } catch (error) {
      slots.delete(includeTest);
      throw error;
    } finally {
      flights.delete(includeTest);
    }
  };
}

export function summarizeSubjectRunningRuns(subjects: readonly SubjectSummary[]): SubjectRunningRunsSummary {
  const counts: SubjectRunningRunsSummary = { running: 0, 'probable-running': 0, countedStatuses: ['running', 'probable-running'] };
  for (const subject of subjects) {
    if (subject.run.status === 'running' || subject.run.status === 'probable-running') counts[subject.run.status] += 1;
  }
  return counts;
}

function subjectOrigin(terminal: TerminalSummary): 'system' | 'human' {
  if (terminal.originRoot === 'human') return 'human';
  return terminal.originRoot || terminal.parentKind || terminal.originAgent || terminal.controller ? 'system' : 'human';
}

/** Derives observation subjects from the existing read-only terminal sources. */
export function deriveSubjectSummaries(
  ptyTerminals: readonly TerminalSummary[],
  ptyLessSubAgents: readonly PtyLessSubAgentSummary[],
): Array<Omit<SubjectSummary, 'run'>> {
  type SubjectParts = Omit<SubjectSummary, 'run'> & { startedAt: number };
  const subjects = new Map<string, SubjectParts>();
  const ensure = (id: string, runId: string, origin: 'system' | 'human', startedAt: number): SubjectParts => {
    const existing = subjects.get(id);
    if (existing) {
      existing.startedAt = Math.max(existing.startedAt, startedAt);
      if (origin === 'system') existing.origin = 'system';
      return existing;
    }
    const subject: SubjectParts = {
      id, runId, origin,
      screen: { ptyIds: [], liveCount: 0 },
      agent: { names: [], controllers: [] },
      talk: [],
      startedAt,
    };
    subjects.set(id, subject);
    return subject;
  };
  const addUnique = (values: string[], value: string | undefined) => {
    if (value && !values.includes(value)) values.push(value);
  };
  for (const terminal of ptyTerminals) {
    const id = terminal.runId ? `subject:${terminal.runId}` : `pty:${terminal.id}`;
    const subject = ensure(id, terminal.runId, subjectOrigin(terminal), terminal.startedAt);
    addUnique(subject.screen.ptyIds, terminal.id);
    if (terminal.alive) subject.screen.liveCount += 1;
    addUnique(subject.agent.names, terminal.originAgent);
    addUnique(subject.agent.controllers, terminal.controller);
  }
  for (const agent of ptyLessSubAgents) {
    const runId = agent.correlationId;
    const subject = ensure(`subject:${runId}`, runId, 'system', agent.startedAt);
    addUnique(subject.agent.names, agent.name);
  }
  return [...subjects.values()]
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
    .map(({ startedAt: _startedAt, ...subject }) => subject);
}

const subAgentDispatchQuery = (now: number) => ({
  exactCategories: ['agent.spawn'],
  events: ['dispatch'],
  sinceMs: now - SUB_AGENT_COUNT_WINDOW_MS,
});

function parseLogData(row: LogStoreRow): Record<string, unknown> {
  if (!row.data) return {};
  try {
    const value: unknown = JSON.parse(row.data);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function queryAllLogRows(store: Pick<LogStore, 'query'>, query: Parameters<LogStore['query']>[0]): LogStoreRow[] {
  const rows: LogStoreRow[] = [];
  const seenRows = new Set<number>();
  const seenCursors = new Set<number>();
  let beforeId: number | undefined;
  do {
    const page = store.query({ ...query, ...(beforeId === undefined ? {} : { beforeId }) });
    for (const row of page) {
      if (!seenRows.has(row.id)) {
        seenRows.add(row.id);
        rows.push(row);
      }
    }
    const nextBeforeId = page.at(-1)?.id;
    if (page.length === 0 || nextBeforeId === undefined || seenCursors.has(nextBeforeId)) break;
    seenCursors.add(nextBeforeId);
    beforeId = nextBeforeId;
  } while (true);
  return rows;
}

function summarizePtyLessSubAgents(
  store: Pick<LogStore, 'query'>,
  now: number,
  sourceRoot: { name: string; dbPath: string },
): PtyLessSubAgentSummary[] {
  const sinceMs = now - SUB_AGENT_COUNT_WINDOW_MS;
  const dispatches = queryAllLogRows(store, { ...subAgentDispatchQuery(now) });
  const foregroundTerminalEvents = queryAllLogRows(store, {
    exactCategories: ['agent.done', 'agent.error'],
    events: ['finish', 'failed', 'aborted'],
    sinceMs,
  });
  const backgroundSpawns = queryAllLogRows(store, {
    exactCategories: ['agent.spawn'],
    events: ['background'],
    sinceMs,
  });
  const backgroundTerminalEvents = queryAllLogRows(store, {
    exactCategories: ['agent.task-routing'],
    events: ['auto-foreground-on-completion'],
    sinceMs,
  });
  const correlationByTaskId = new Map<string, string>();
  for (const row of backgroundSpawns) {
    const data = parseLogData(row);
    if (typeof data.cid === 'string' && data.cid && typeof data.taskId === 'string' && data.taskId) {
      correlationByTaskId.set(data.taskId, data.cid);
    }
  }
  const terminalEvents = foregroundTerminalEvents.concat(backgroundTerminalEvents);
  // ⛔ 상태는 «가장 최신» 종단 이벤트에서 온다. terminalEvents 는 저장소가
  //    ts_ms DESC 로 주지만(리뷰 3R 지적: 그 암묵 순서에 의존해 Map.set 으로
  //    덮으면 뒤에 오는 「더 오래된」 이벤트가 최신을 이긴다) 여기서는 ts_ms 를
  //    명시 비교해 순서 의존을 없앤다 — 같은 cid 에 종단 이벤트가 여럿이어도
  //    가장 최신 것만 상태로 남는다.
  const terminalByCorrelation = new Map<string, { status: 'finished' | 'failed' | 'aborted'; ts: number }>();
  for (const row of terminalEvents) {
    const data = parseLogData(row);
    const cid = row.category === 'agent.task-routing'
      ? (typeof data.taskId === 'string' ? correlationByTaskId.get(data.taskId) : undefined)
      : data.cid;
    if (typeof cid !== 'string') continue;
    let status: 'finished' | 'failed' | 'aborted' | undefined;
    if (row.category === 'agent.done' && row.event === 'finish') status = 'finished';
    else if (row.category === 'agent.error' && row.event === 'failed') status = 'failed';
    else if (row.category === 'agent.error' && row.event === 'aborted') status = 'aborted';
    else if (row.category === 'agent.task-routing' && row.event === 'auto-foreground-on-completion') {
      if (data.state === 'done') status = 'finished';
      else if (data.state === 'error') status = 'failed';
      else if (data.state === 'aborted') status = 'aborted';
    }
    if (!status) continue;
    const prior = terminalByCorrelation.get(cid);
    if (!prior || row.ts_ms > prior.ts) terminalByCorrelation.set(cid, { status, ts: row.ts_ms });
  }
  return dispatches.map((row) => {
    const data = parseLogData(row);
    const correlationId = typeof data.cid === 'string' && data.cid ? data.cid : `log:${row.id}`;
    const resolvedAgent = typeof data.resolvedAgent === 'string' ? data.resolvedAgent : 'sub-agent';
    const description = typeof data.description === 'string' ? data.description : '';
    const status = terminalByCorrelation.get(correlationId)?.status ?? 'unknown';
    const id = typeof data.cid === 'string' && data.cid
      ? `agent:${correlationId}`
      : `agent:log:${encodeURIComponent(sourceRoot.dbPath)}:${row.id}`;
    return {
      id,
      name: description ? `${resolvedAgent}: ${description}` : resolvedAgent,
      startedAt: row.ts_ms,
      instance: row.instance,
      sourceRoot,
      hasPty: false as const,
      alive: status === 'unknown' ? null : false,
      status,
      correlationId,
      sessionId: row.session_id,
    };
  });
}

type PtyLessSubAgentCollection = {
  summaries: PtyLessSubAgentSummary[];
  available: boolean;
};

function collectPtyLessSubAgents(
  getStore: () => HiddenSubAgentLogStore | null,
  federated: boolean,
  includeTest: boolean,
  logInstances: (opts: { includeTest?: boolean }) => ReadonlyArray<{ name?: string; dbPath: string; dbExists: boolean }>,
  openReadOnly: (dbPath: string) => HiddenSubAgentLogStore,
  now: number,
): PtyLessSubAgentCollection {
  let local: HiddenSubAgentLogStore | null;
  try {
    local = getStore();
    if (!local) return { summaries: [], available: false };
  } catch {
    return { summaries: [], available: false };
  }
  const summaries: PtyLessSubAgentSummary[] = [];
  const localDbPath = local.path ?? 'local';
  try {
    summaries.push(...summarizePtyLessSubAgents(local, now, { name: 'local', dbPath: localDbPath }));
  } catch {
    return { summaries: [], available: false };
  }
  if (!federated) return { summaries, available: true };
  const seen = new Set(local.path ? [local.path] : []);
  for (const instance of logInstances({ includeTest })) {
    if (!instance.dbExists || seen.has(instance.dbPath)) continue;
    seen.add(instance.dbPath);
    let store: HiddenSubAgentLogStore | undefined;
    try {
      store = openReadOnly(instance.dbPath);
      summaries.push(...summarizePtyLessSubAgents(store, now, { name: instance.name ?? instance.dbPath, dbPath: instance.dbPath }));
    } catch { /* one unreadable remote store must not hide other stores */ }
    finally {
      try { store?.close?.(); } catch { /* fail-soft */ }
    }
  }
  return { summaries, available: true };
}

function terminalsScope(roots: number, federated: boolean, hiddenDead: number, hiddenSubAgentRuns: number | undefined) {
  return {
    roots,
    federated,
    hiddenDead,
    domain: TERMINALS_SCOPE_DOMAIN,
    ...(hiddenSubAgentRuns === undefined ? {} : { hiddenSubAgentRuns }),
  };
}

/** 이 표면에 「보이는」 행의 단일 정의 — 라이브 플래그 ⊕ 소유 프로세스 생존.
 *  ⛔ 두 경로(비연합·연합)가 이것을 각자 다시 쓰면 자가 갈린다(리뷰 지적 2R·3R). */
function isVisibleManifestRow(row: PtyManifestRow, alive: (pid: number) => boolean): boolean {
  const pid = row.ptyPid > 0 ? row.ptyPid : row.ownerPid;
  return row.alive && pid > 0 && alive(pid);
}

function terminalKey(terminal: Pick<TerminalSummary, 'id' | 'sourceRoot'>): string {
  return `${terminal.sourceRoot?.dbPath ?? ptyManifestDbPath()}\u0000${terminal.id}`;
}

function webTerminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

function mergeWebPreviewTerminals(ptyTerminals: TerminalSummary[]): TerminalSummary[] {
  const webTerminals = listAllPreviewTerminals();
  const liveWebTerminals = webTerminals.filter((terminal) => terminal.isAlive);
  const seenWebTerminals = new Set<string>();
  const merged = [...ptyTerminals];
  let added = 0;
  for (const terminal of liveWebTerminals) {
    const key = webTerminalKey(terminal.sessionId, terminal.terminalId);
    if (seenWebTerminals.has(key)) continue;
    seenWebTerminals.add(key);
    merged.push({
      id: terminal.terminalId,
      cmd: 'web-terminal',
      treeName: '',
      worktreeName: '',
      parentPtyId: '',
      parentPid: terminal.pid,
      parentKind: '',
      runId: '',
      origin: 'unknown',
      producer: 'web-registration',
      alive: true,
      exitCode: null,
      startedAt: terminal.firstRegisteredAt,
      outputBytes: 0,
      accessMode: null,
      accessModeUnavailableReason: accessModeUnavailableReason('web-registration', null),
      ownerRunUsage: 'unknown',
      sourceRoot: { name: terminal.sessionId, dbPath: `web-terminal:${terminal.sessionId}` },
    });
    added += 1;
  }
  if (debug.enabled) {
    debug.log('webterm.tap', 'terminals.merge', {
      ptyCount: ptyTerminals.length,
      webPreviewCount: webTerminals.length,
      liveWebPreviewCount: liveWebTerminals.length,
      added,
    });
  }
  return sortTerminalsByRun(merged);
}

/** Keep known run participants together while retaining newest-first order
 * within each run. PTYs without a run ID are unknown, not one shared run. */
function sortTerminalsByRun(terminals: TerminalSummary[]): TerminalSummary[] {
  const newestByRun = new Map<string, number>();
  for (const terminal of terminals) {
    if (terminal.runId) {
      newestByRun.set(terminal.runId, Math.max(newestByRun.get(terminal.runId) ?? -Infinity, terminal.startedAt));
    }
  }
  return terminals.sort((a, b) => {
    if (!a.runId && !b.runId) return b.startedAt - a.startedAt;
    if (!a.runId) return 1;
    if (!b.runId) return -1;
    if (a.runId === b.runId) return b.startedAt - a.startedAt;
    const newestDifference = newestByRun.get(b.runId)! - newestByRun.get(a.runId)!;
    if (newestDifference) return newestDifference;
    return a.runId < b.runId ? -1 : 1;
  });
}

function isAllowedSourceRoot(dbPath: string): boolean {
  return ptyManifestTargets({ includeTest: true }).some((target) => target.dbPath === dbPath);
}

export type TerminalDetailTarget =
  | { status: 'current-root' }
  | { status: 'source-root-not-found'; sourceRoot: string }
  | { status: 'pty-not-found-in-source-root'; sourceRoot: string; dbPath: string }
  | { status: 'selected'; sourceRoot: string; dbPath: string; row: PtyManifestRow };

/** Resolve a detail request against the same manifest target catalogue used by
 * the federated list. An omitted selector intentionally retains the current-root
 * behavior; a supplied selector makes its root and missing-row failures explicit. */
export function resolveTerminalDetailTarget(
  id: string,
  url: URL,
  targets: Array<{ name: string; dbPath: string }> = ptyManifestTargets({ includeTest: true }),
  rowsAt: (dbPath: string) => PtyManifestRow[] = listPtyManifestRowsAt,
): TerminalDetailTarget {
  const sourceRoot = url.searchParams.get('sourceRoot');
  if (sourceRoot === null) return { status: 'current-root' };
  const currentDbPath = ptyManifestDbPath();
  const candidates = targets.some((target) => target.dbPath === currentDbPath)
    ? targets
    : [...targets, { name: 'current', dbPath: currentDbPath }];
  const target = candidates.find((candidate) => candidate.name === sourceRoot || candidate.dbPath === sourceRoot);
  if (!target) return { status: 'source-root-not-found', sourceRoot };
  const row = rowsAt(target.dbPath).find((candidate) => candidate.id === id);
  return row
    ? { status: 'selected', sourceRoot, dbPath: target.dbPath, row }
    : { status: 'pty-not-found-in-source-root', sourceRoot, dbPath: target.dbPath };
}

/** The one error body both detail endpoints emit for a selector failure. It always
 *  names the root that was asked for, and carries `dbPath` exactly when the root
 *  resolved but the row did not — so `frame` and `scrollback` cannot drift into
 *  different shapes for the same failure. Null means the request is servable. */
export function terminalDetailErrorBody(
  id: string,
  target: TerminalDetailTarget,
): { error: string; id: string; sourceRoot: string; dbPath?: string } | null {
  if (target.status === 'current-root' || target.status === 'selected') return null;
  return target.status === 'pty-not-found-in-source-root'
    ? { error: target.status, id, sourceRoot: target.sourceRoot, dbPath: target.dbPath }
    : { error: target.status, id, sourceRoot: target.sourceRoot };
}

/** 404 body for an id that resolved against no row at all. The two names are not
 *  cosmetic: `pty-in-another-source-root` tells the caller that retrying with
 *  `?sourceRoot=` can succeed, and `not-found` tells it that nothing will. */
export function terminalMissingBody(id: string, inAnotherRoot: boolean): { error: string; id: string } {
  return { error: inAnotherRoot ? 'pty-in-another-source-root' : 'not-found', id };
}

function isPtyInAnotherManifestRoot(id: string): boolean {
  return ptyManifestTargets({ includeTest: true })
    .some((target) => listPtyManifestRowsAt(target.dbPath).some((row) => row.id === id));
}

/** Shared by both detail endpoints. One resolution answers the selector question
 *  once — the previous split (`manifestDbPathForSourceRoot` + `manifestRowForSourceRoot`)
 *  let two independent lookups disagree.
 *
 *  ⛔ The seam is the resolver's INPUTS, not the resolver. Injecting the resolver
 *  itself let a test hand back `{ dbPath: A, row: <row from B> }` — a state the
 *  live code cannot reach, which would make a test green on a pairing that can
 *  never happen. Injecting the root catalogue and the per-root row reader instead
 *  keeps the binding inside `resolveTerminalDetailTarget`, so a row can only ever
 *  come from the root it was read from. */
interface TerminalDetailDeps {
  detailTargets?: Array<{ name: string; dbPath: string }>;
  rowsAt?(dbPath: string): PtyManifestRow[];
  isPtyInAnotherManifestRoot?(id: string): boolean;
}

function resolveDetail(id: string, url: URL, deps: TerminalDetailDeps): TerminalDetailTarget {
  return deps.detailTargets || deps.rowsAt
    ? resolveTerminalDetailTarget(id, url, deps.detailTargets ?? ptyManifestTargets({ includeTest: true }), deps.rowsAt ?? listPtyManifestRowsAt)
    : resolveTerminalDetailTarget(id, url);
}

export function handleTerminalsList(req: Request, opts: MetaApiOpts, deps: TerminalsListDeps = liveTerminalsListDeps): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const scope = resolveTerminalManifestScope(req, deps);
  const { federated, includeTest } = scope;
  const readLocalManifest = deps.listPtyManifestRows ?? listPtyManifestRows;
  const cleanupDead = deps.reapDeadPtyManifest ?? reapDeadPtyManifest;
  const cleanupClosed = deps.purgeClosedPtyManifest ?? purgeClosedPtyManifest;
  const cleanupStale = deps.reapStalePtyManifest ?? reapStalePtyManifest;
  const cleanupOrphans = deps.reapOrphanedOwnedPtyManifest ?? reapOrphanedOwnedPtyManifest;
  const getLogStore = deps.getDefaultLogStore ?? getDefaultLogStore;
  const logInstances = deps.logInstances ?? readProdInstances;
  const openLogStoreReadOnly = deps.openLogStoreReadOnly ?? LogStore.openReadOnly;
  const getRunningRuns = deps.queryRunningRuns ?? queryRunningRuns;
  const resolveRunTerminationForRow = (runId: string): RunTermination => deps.runTerminated
    ? deps.runTerminated(runId, { includeTest })
    : 'ledger-indeterminate';
  const runningRunsCache = runningRunsCacheFor(getRunningRuns, deps.now ?? Date.now);
  let runningRuns: RunningRunsResult | null = null;
  let runningRunsAgeMs = 0;
  let runningRunsQueryFailed = false;
  try {
    const cached = runningRunsCache({ includeTest });
    runningRuns = cached.result;
    runningRunsAgeMs = cached.ageMs;
  } catch {
    // Fail-soft and do not cache: subjects keep unknown assessments.
    runningRunsQueryFailed = true;
  }
  const ptyLessSubAgentCollection = collectPtyLessSubAgents(
    getLogStore,
    federated,
    includeTest,
    logInstances,
    openLogStoreReadOnly,
    Date.now(),
  );
  const ptyLessSubAgents = ptyLessSubAgentCollection.summaries;
  const hiddenSubAgentRuns = ptyLessSubAgentCollection.available ? ptyLessSubAgents.length : undefined;
  const manifestBeforeCleanup = readLocalManifest();
  // 정리는 항상 현재 뿌리만 대상으로 한다. 연합은 읽기 범위만 넓힌다.
  try { cleanupDead(); } catch { /* fail-soft */ }
  try { cleanupClosed(Date.now()); } catch { /* fail-soft */ }
  try { cleanupStale(Date.now()); } catch { /* fail-soft */ }
  const manifestAfterInitialCleanup = readLocalManifest();
  const manifestById = new Map(manifestAfterInitialCleanup.map((row) => [row.id, row]));
  const local = (deps.listPty ?? listPty)().map((handle) => summarize(
    handle,
    manifestById.get(handle.id) ?? null,
    resolveRunTerminationForRow,
    deps.isProcessAlive,
  ));
  const localIds = new Set(local.map((t) => t.id));
  try { cleanupOrphans(localIds); } catch { /* fail-soft */ }
  const isVisible = (row: PtyManifestRow): boolean => isVisibleManifestRow(row, deps.isProcessAlive);

  if (!federated) {
    const visibleRows = readLocalManifest().filter((row) => !localIds.has(row.id) && isVisible(row));
    const remote = visibleRows.map((row) => summarizeManifest(row, resolveRunTerminationForRow, deps.isProcessAlive));
    // ★ 관측소 = "사용자가 명시적으로 트리거한 살아있는 쉘"만 — local/remote 통틀어 live-only 표시.
    //   종료분은 db 에 남되(세션 별도 관리·scrollback by id 는 가능) 라이브 목록에서 제외.
    //   ⛔ 이 필터는 두 경로 «모두»에 있어야 한다 — 비연합에서만 빠지면 종료된 in-process PTY 가 되살아난다.
    const ptyTerminals = sortTerminalsByRun([...local, ...remote].filter((t) => t.alive));
    // Terminal rows are concrete PTYs only. Log-derived sub-agent summaries remain
    // available to subjects and scope, but are not terminal-list entries.
    const terminals = mergeWebPreviewTerminals(ptyTerminals);
    const subjects = enrichSubjectRunAssessments(deriveSubjectSummaries(ptyTerminals, ptyLessSubAgents), runningRuns);
    // ⭐ 「감춘 개수」는 «정리 전» 행에서 «실제로 보이는 PTY」를 뺀다 — 정리로 방금 사라진 행도 세어진다.
    // 웹 터미널은 목록에만 합치며, 동명 ID가 PTY 가시성·scope 집계를 바꾸면 안 된다.
    const visibleIds = new Set(ptyTerminals.map((terminal) => terminal.id));
    const hiddenDead = manifestBeforeCleanup.filter((row) => !visibleIds.has(row.id)).length;
    return jsonResponse({ terminals, subjects, runningRuns: summarizeSubjectRunningRuns(subjects), runningRunsAgeMs: runningRunsQueryFailed ? null : runningRunsAgeMs, scope: terminalsScope(1, false, hiddenDead, hiddenSubAgentRuns) }, 200);
  }

  const { currentDbPath, targets } = scope;
  let hiddenDead = 0;
  const remote = targets.flatMap((target) => {
    const rows = deps.listPtyManifestRowsAt(target.dbPath);
    const visibleRows = rows.filter(isVisible);
    // ⛔⭐ 현재 뿌리는 «정리 전» 행으로 센다 — 정리(reap dead/stale/orphan)가 이미 지운 행을
    //   정리 «후» 목록으로 세면 그 행들이 「감춘 개수」에서 조용히 빠지고, 같은 표면의
    //   비연합 경로와 «다른 자»가 된다(리뷰 지적 2R·3R). 다른 뿌리는 정리 대상이 아니라 그대로 센다.
    const counted = target.dbPath === currentDbPath ? manifestBeforeCleanup : rows;
    const visibleIds = new Set([
      ...visibleRows.map((row) => row.id),
      ...(target.dbPath === currentDbPath ? localIds : []),
    ]);
    hiddenDead += counted.filter((row) => !visibleIds.has(row.id)).length;
    return visibleRows.map((row) => summarizeManifest(
      row,
      resolveRunTerminationForRow,
      deps.isProcessAlive,
      { name: target.name, dbPath: target.dbPath },
    ));
  });
  const localKeys = new Set(local.map(terminalKey));
  const remoteByKey = new Map(remote.filter((terminal) => !localKeys.has(terminalKey(terminal))).map((terminal) => [terminalKey(terminal), terminal]));
  const ptyTerminals = sortTerminalsByRun([...local, ...remoteByKey.values()].filter((terminal) => terminal.alive));
  // Keep this aligned with the local path: the terminal list is PTY-only, while
  // log-derived agent summaries continue to feed subjects and scope independently.
  const terminals = mergeWebPreviewTerminals(ptyTerminals);
  const subjects = enrichSubjectRunAssessments(deriveSubjectSummaries(ptyTerminals, ptyLessSubAgents), runningRuns);
  return jsonResponse({ terminals, subjects, runningRuns: summarizeSubjectRunningRuns(subjects), runningRunsAgeMs: runningRunsQueryFailed ? null : runningRunsAgeMs, scope: terminalsScope(targets.length, true, hiddenDead, hiddenSubAgentRuns) }, 200);
}

export interface TerminalPruneDeps extends TerminalManifestScopeDeps {
  reapDeadPtyManifestAt(dbPath: string, opts: { apply: boolean; isProcessAlive: (pid: number) => boolean }): PtyManifestExternalReapResult;
  isProcessAlive(pid: number): boolean;
}

export type TerminalCleanupScope =
  | { mode: 'current'; targets: ReadonlyArray<{ name: string; dbPath: string }> }
  | { mode: 'all'; targets: ReadonlyArray<{ name: string; dbPath: string }> }
  | { error: 'invalid-cleanup-scope' };

/** Resolves destructive cleanup independently from the read-only list scope.
 * `cleanupScope=all` is the sole explicit opt-in to registered roots. */
export function resolveTerminalCleanupScope(req: Request, deps: TerminalManifestScopeDeps = liveTerminalsListDeps): TerminalCleanupScope {
  const query = new URL(req.url).searchParams;
  const cleanupScope = query.get('cleanupScope');
  if (cleanupScope !== null && cleanupScope !== 'current' && cleanupScope !== 'all') return { error: 'invalid-cleanup-scope' };
  const realpath = deps.realpath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
  const currentDbPath = realpath((deps.ptyManifestDbPath ?? ptyManifestDbPath)());
  if (cleanupScope !== 'all') return { mode: 'current', targets: [{ name: 'current', dbPath: currentDbPath }] };
  const targets: Array<{ name: string; dbPath: string }> = [];
  const seenDbPaths = new Set<string>();
  for (const target of deps.ptyManifestTargets({ includeTest: query.get('cleanupIncludeTest') === 'true' })) {
    const dbPath = realpath(target.dbPath);
    if (seenDbPaths.has(dbPath)) continue;
    seenDbPaths.add(dbPath);
    targets.push({ ...target, dbPath });
  }
  if (!seenDbPaths.has(currentDbPath)) targets.push({ name: 'current', dbPath: currentDbPath });
  return { mode: 'all', targets };
}

const liveTerminalPruneDeps: TerminalPruneDeps = {
  ptyManifestTargets,
  ptyManifestDbPath,
  reapDeadPtyManifestAt,
  isProcessAlive,
};

/** POST /v1/terminals/prune — reaps confirmed-dead owners in the current root
 * unless the caller explicitly opts into `cleanupScope=all`. */
export function handleTerminalsPrune(
  req: Request,
  opts: MetaApiOpts,
  deps: TerminalPruneDeps = liveTerminalPruneDeps,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const scope = resolveTerminalCleanupScope(req, deps);
  if ('error' in scope) return jsonResponse({ error: scope.error }, 400);
  let reaped = 0;
  let retained = 0;
  let unreadableRoots = 0;
  const retainedReasons: Record<string, number> = {};
  for (const target of scope.targets) {
    const result = deps.reapDeadPtyManifestAt(target.dbPath, { apply: true, isProcessAlive: deps.isProcessAlive });
    reaped += result.removed;
    retained += result.preserved;
    if (result.status === 'unreadable') unreadableRoots += 1;
    for (const decision of result.decisions) {
      if (decision.action !== 'preserve') continue;
      retainedReasons[decision.reason] = (retainedReasons[decision.reason] ?? 0) + 1;
    }
  }
  return jsonResponse({
    reaped,
    retained,
    retainedReasons,
    unreadableRoots,
    scope: { roots: scope.targets.length, federated: scope.mode === 'all', mode: scope.mode, rootNames: scope.targets.map((target) => target.name) },
  }, 200);
}

/** Exact matcher for the scoped prune collection route. */
export function parseTerminalsPrunePath(pathname: string): boolean {
  return pathname === '/v1/terminals/prune';
}

/** GET /v1/terminals/:id/scrollback?lines=N — return the trailing N
 *  lines of the PTY's accumulated output buffer. Lines beyond the
 *  buffer cap are silently trimmed (the registry's elided-middle
 *  marker shows up verbatim in the response so callers can detect
 *  the truncation). 404 when the id is unknown. */
interface TerminalScrollbackDeps extends TerminalDetailDeps {
  getPty?(id: string): PtyHandle | undefined;
  getPtyManifest?(id: string): PtyManifestRow | null;
}

const liveTerminalScrollbackDeps: TerminalScrollbackDeps = {};

export function handleTerminalScrollback(
  req: Request,
  opts: MetaApiOpts,
  id: string,
  url: URL,
  deps: TerminalScrollbackDeps = liveTerminalScrollbackDeps,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'missing-id' }, 400);
  const target = resolveDetail(id, url, deps);
  const detailError = terminalDetailErrorBody(id, target);
  if (detailError) return jsonResponse(detailError, 404);
  const sourceSnapshot = target.status === 'selected' ? target.row : undefined;
  // ⛔ A selected source root EXCLUDES the local handle. PTY ids are only unique
  // within a root, so a local handle can share an id with the foreign row that was
  // asked for — and preferring it would answer a "show me the other universe"
  // request with this universe's live output, silently and plausibly.
  const handle = sourceSnapshot === undefined ? (deps.getPty ?? getPty)(id) : undefined;
  const remoteSnapshot = sourceSnapshot === undefined ? (handle ? null : (deps.getPtyManifest ?? getPtyManifest)(id)) : sourceSnapshot;
  if (!handle && !remoteSnapshot) {
    return jsonResponse(terminalMissingBody(id, (deps.isPtyInAnotherManifestRoot ?? isPtyInAnotherManifestRoot)(id)), 404);
  }
  const linesParam = url.searchParams.get('lines');
  const requested = linesParam !== null ? Number.parseInt(linesParam, 10) : DEFAULT_LINES;
  if (!Number.isFinite(requested) || requested <= 0) {
    return jsonResponse({ error: 'invalid-lines', received: linesParam }, 400);
  }
  const lines = Math.min(requested, MAX_LINES);
  // P4.2 OQ-3 (FU) — `?ansi=strip` removes escape sequences so LLM 가
  // 깨끗한 텍스트만 봄. Default = preserve (raw output · htop/tmux 등
  // ANSI-driven UI 가 그대로 필요할 때 reference). Any other value
  // (ansi=keep · 미지정) 은 keep 동작.
  const ansiMode = url.searchParams.get('ansi');
  const stripAnsiSeqs = ansiMode === 'strip';
  const rawFull = handle ? handle.snapshot() : (remoteSnapshot?.snapshot ?? '');
  const full = stripAnsiSeqs ? stripAnsi(rawFull) : rawFull;
  // Compute trailing N lines without slicing each line individually —
  // a single split + slice keeps the implementation O(n) over the
  // buffer (already capped at ~512 KB by the registry).
  const allLines = full.split('\n');
  const totalLines = allLines.length;
  const start = Math.max(0, totalLines - lines);
  const tail = allLines.slice(start).join('\n');
  return jsonResponse({
    id,
    lines: totalLines - start,
    totalLines,
    scrollback: tail,
    ...(stripAnsiSeqs ? { ansiStripped: true } : {}),
  }, 200);
}

/** Path matcher: `/v1/terminals/:id/scrollback`. Returns the id when
 *  the path matches, null otherwise. Exposed so http-server.ts can
 *  centralize all `/v1/terminals/*` dispatch via one regex check. */
export function parseScrollbackPath(pathname: string): string | null {
  const m = /^\/v1\/terminals\/([^/]+)\/scrollback$/.exec(pathname);
  return m && m[1] ? safeDecodeSegment(m[1]) : null;
}

/** Path matcher: `/v1/terminals/:id/control`. */
export function parseTerminalControlPath(pathname: string): string | null {
  const m = /^\/v1\/terminals\/([^/]+)\/control$/.exec(pathname);
  return m && m[1] ? safeDecodeSegment(m[1]) : null;
}

/** Path matcher: `/v1/terminals/:id/rename`. */
export function parseTerminalRenamePath(pathname: string): string | null {
  const m = /^\/v1\/terminals\/([^/]+)\/rename$/.exec(pathname);
  return m && m[1] ? safeDecodeSegment(m[1]) : null;
}

/** Path matcher: `/v1/terminals/:id/terminate`. */
export function parseTerminalTerminatePath(pathname: string): string | null {
  const m = /^\/v1\/terminals\/([^/]+)\/terminate$/.exec(pathname);
  return m && m[1] ? safeDecodeSegment(m[1]) : null;
}

interface TerminalControlDeps {
  requestRemotePtyControl(id: string, action: PtyControlAction, payload?: PtyControlPayload, options?: PtyControlRequestOptions): Promise<PtyControlResult>;
}

const liveTerminalControlDeps: TerminalControlDeps = { requestRemotePtyControl };
const TERMINAL_CONTROL_TIMEOUT_MS = 2_000;

/** POST /v1/terminals/:id/control — ownership, terminal input, and screen snapshots.
 * Input and snapshot requests are forwarded to the owning process, whose arbiter
 * makes the final write decision. */
export async function handleTerminalControl(
  req: Request,
  opts: MetaApiOpts,
  id: string,
  deps: TerminalControlDeps = liveTerminalControlDeps,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'missing-id' }, 400);
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid-json', reason: 'JSON body required' }, 400); }
  const request = body !== null && typeof body === 'object' ? body as { action?: unknown; chars?: unknown; ansi?: unknown } : {};
  const action = request.action;
  if (action !== 'takeover' && action !== 'release' && action !== 'input-text' && action !== 'input-key' && action !== 'snapshot') {
    return jsonResponse({ error: 'invalid-action', reason: 'action must be takeover, release, input-text, input-key, or snapshot' }, 400);
  }
  const isInput = action === 'input-text' || action === 'input-key';
  if (isInput && (typeof request.chars !== 'string' || request.chars.length === 0)) {
    return jsonResponse({ error: 'invalid-payload', reason: 'chars must be a non-empty string' }, 400);
  }
  const payload = isInput ? { chars: request.chars as string }
    : action === 'snapshot' && request.ansi === true ? { ansi: true }
      : undefined;
  try {
    const result = await deps.requestRemotePtyControl(id, action, payload, { timeoutMs: TERMINAL_CONTROL_TIMEOUT_MS });
    const status = result.status === 'unknown-pty' ? 404
      : result.status === 'owner-unreachable' ? 504
      : result.status === 'failed' || result.status === 'write-failed' ? 502
      : result.status === 'denied' ? 409
      : 200;
    if (debug.enabled) {
      debug.log('nexus.terminals.control', 'dispatch', {
        id,
        action,
        status: result.status,
        ...(isInput ? { bytes: (payload as { chars: string }).chars.length } : {}),
      });
    }
    return jsonResponse({ id, action, ...result }, status);
  } catch {
    return jsonResponse({ error: 'control-failed', reason: 'remote-control-failed', id, action }, 502);
  }
}

interface TerminalRenameDeps {
  requestRemotePtyControl(id: string, action: 'rename', payload: { nickname: string }, timeoutMs: number): Promise<PtyControlResult>;
}

interface TerminalTerminateDeps {
  requestRemotePtyControl(id: string, action: 'terminate', timeoutMs: number): Promise<PtyControlResult>;
}

const liveTerminalRenameDeps: TerminalRenameDeps = { requestRemotePtyControl };
const liveTerminalTerminateDeps: TerminalTerminateDeps = { requestRemotePtyControl };

/** POST /v1/terminals/:id/rename — names are not ownership, so this remains separate from ownership-only control. */
export async function handleTerminalRename(
  req: Request,
  opts: MetaApiOpts,
  id: string,
  deps: TerminalRenameDeps = liveTerminalRenameDeps,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'missing-id' }, 400);
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid-json', reason: 'JSON body required' }, 400); }
  const name = body && typeof body === 'object' ? (body as { name?: unknown }).name : undefined;
  if (typeof name !== 'string') return jsonResponse({ error: 'invalid-name', reason: 'name must be a string' }, 400);
  try {
    const result = await deps.requestRemotePtyControl(id, 'rename', { nickname: name }, TERMINAL_CONTROL_TIMEOUT_MS);
    const status = result.status === 'unknown-pty' ? 404
      : result.status === 'owner-unreachable' ? 504
      : result.status === 'failed' || result.status === 'write-failed' ? 502
      : result.status === 'denied' ? 409
      : 200;
    return jsonResponse({ id, name, ...result }, status);
  } catch {
    return jsonResponse({ error: 'rename-failed', reason: 'remote-control-failed', id, name }, 502);
  }
}

/** POST /v1/terminals/:id/terminate — forwards termination to the PTY owner that supplies the terminal list. */
export async function handleTerminalTerminate(
  req: Request,
  opts: MetaApiOpts,
  id: string,
  deps: TerminalTerminateDeps = liveTerminalTerminateDeps,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'missing-id' }, 400);
  try {
    const result = await deps.requestRemotePtyControl(id, 'terminate', TERMINAL_CONTROL_TIMEOUT_MS);
    const status = result.status === 'unknown-pty' ? 404
      : result.status === 'owner-unreachable' ? 504
      : result.status === 'failed' || result.status === 'write-failed' ? 502
      : result.status === 'denied' ? 409
      : 200;
    return jsonResponse({ id, action: 'terminate', ...result }, status);
  } catch {
    return jsonResponse({ error: 'terminate-failed', reason: 'remote-control-failed', id, action: 'terminate' }, 502);
  }
}

/** GET /v1/terminals/:id/frame — ⭐P2 · S2. Return the *rendered screen
 *  frame* (post-ANSI grid from renderScreen · picker/modal 포함) that the
 *  surface self-reported into the manifest, NOT the raw scrollback. This
 *  is the "사람이 보는 화면 그대로" cross-process read that closes S1+S2.
 *
 *  Frames only exist in the shared manifest (a surface self-reports them);
 *  in-process registry PTYs are raw child shells with no rendered frame.
 *  So this reads `getPtyManifest(id)`:
 *    - known id with a stored frame → the stored frame
 *    - known id, no stored frame    → owner-process live snapshot when available
 *    - unknown id                   → 404
 *
 *  `?ansi=strip` mirrors the scrollback endpoint (renderScreen may embed
 *  color SGR). Default = preserve. */
interface TerminalFrameDeps extends TerminalDetailDeps {
  requestRemotePtyControl(id: string, action: 'snapshot', timeoutMs: number, options?: { manifestDbPath?: string }): Promise<PtyControlResult>;
  getPtyManifest?(id: string): PtyManifestRow | null;
}

const liveTerminalFrameDeps: TerminalFrameDeps = { requestRemotePtyControl, getPtyManifest };
const TERMINAL_FRAME_SNAPSHOT_TIMEOUT_MS = 2_000;

export async function handleTerminalFrame(
  req: Request,
  opts: MetaApiOpts,
  id: string,
  url: URL,
  deps: TerminalFrameDeps = liveTerminalFrameDeps,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'missing-id' }, 400);
  // One resolution answers both "which root" and "which row" — see TerminalDetailDeps.
  const target = resolveDetail(id, url, deps);
  const detailError = terminalDetailErrorBody(id, target);
  if (detailError) return jsonResponse(detailError, 404);
  const sourceRow = target.status === 'selected' ? target.row : undefined;
  const sourceManifestDbPath = target.status === 'selected' ? target.dbPath : undefined;
  const row = sourceRow ?? (deps.getPtyManifest ?? getPtyManifest)(id);
  if (!row) return jsonResponse(terminalMissingBody(id, (deps.isPtyInAnotherManifestRoot ?? isPtyInAnotherManifestRoot)(id)), 404);
  const stripAnsiSeqs = url.searchParams.get('ansi') === 'strip';
  let frame = row.frame;
  let frameAt = row.frameAt;
  let source: 'stored' | 'live' | 'unavailable' = 'stored';
  if (frameAt === 0) {
    try {
      const result = await deps.requestRemotePtyControl(id, 'snapshot', TERMINAL_FRAME_SNAPSHOT_TIMEOUT_MS, sourceRow && sourceManifestDbPath ? { manifestDbPath: sourceManifestDbPath } : undefined);
      if (result.status === 'success' && typeof result.screen === 'string' && result.screen.length > 0) {
        frame = result.screen;
        frameAt = Math.max(Date.now(), 1);
        source = 'live';
      } else source = 'unavailable';
    } catch {
      source = 'unavailable';
    }
  }
  return jsonResponse({
    id,
    frame: stripAnsiSeqs ? stripAnsi(frame) : frame,
    frameAt,
    frameSource: source,
    remote: true,
    instance: row.instance,
    kind: row.kind,
    ...(stripAnsiSeqs ? { ansiStripped: true } : {}),
  }, 200);
}

/** Path matcher: `/v1/terminals/:id/frame`. Sibling to
 *  `parseScrollbackPath` — one regex check per `/v1/terminals/*` route. */
export function parseFramePath(pathname: string): string | null {
  const m = /^\/v1\/terminals\/([^/]+)\/frame$/.exec(pathname);
  return m && m[1] ? safeDecodeSegment(m[1]) : null;
}

/** ⭐P4 §4-1 — the manifest stores no cols/rows, so derive terminal
 *  dimensions from the frame text. cols = widest line by DISPLAY width
 *  (`cellWidth` — counts CJK/emoji as 2, strips ANSI · a naive
 *  `line.length` miscounts them and clips the canvas). A single trailing
 *  newline's phantom empty row is dropped. Bounded (400×200) so a
 *  pathological frame can't blow up the SVG canvas. */
export function deriveFrameDims(frame: string): { cols: number; rows: number } {
  const lines = frame.split('\n');
  let cols = 1;
  for (const l of lines) { const w = cellWidth(l); if (w > cols) cols = w; }
  let rows = lines.length;
  if (frame.endsWith('\n') && rows > 1) rows -= 1; // trailing-newline phantom row
  return { cols: Math.min(cols, 400), rows: Math.min(Math.max(rows, 1), 200) };
}

/** ⭐P4 §4-1 — bound concurrent sharp renders. The endpoint is auth-gated
 *  and the frame is manifest-capped (64 KB) + dims-capped, but a burst of
 *  authed pulls could still pile up sharp workers → CPU/mem. Shed load
 *  (503) past the cap rather than queue unboundedly. */
let pngRendersInFlight = 0;
const MAX_PNG_RENDERS = 4;

/** GET /v1/terminals/:id/png — ⭐P4 · §4-1 on-demand PNG pull. Renders the
 *  surface's *rendered frame* (renderScreen grid · picker/modal 포함) to a
 *  PNG server-side (text → SVG → sharp PNG) so a vision LLM / human / share
 *  link can pull a pixel snapshot WITHOUT the surface holding its PTY (works
 *  cross-process for any framed surface — dashboard TUI + forwarded child).
 *  Text frames stay cheap on the bus/manifest; the PNG is generated only
 *  when pulled (상시 비용 0 · PLAN §4-1). 404 when the id has no frame,
 *  503 when the render pool is saturated. */
export async function handleTerminalPng(
  req: Request,
  opts: MetaApiOpts,
  id: string,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'missing-id' }, 400);
  const row = getPtyManifest(id);
  if (!row) return jsonResponse({ error: 'not-found', id }, 404);
  if (!row.frame) return jsonResponse({ error: 'no-frame', id }, 404);
  if (pngRendersInFlight >= MAX_PNG_RENDERS) {
    return jsonResponse({ error: 'render-busy', id, retryAfter: 1 }, 503);
  }
  pngRendersInFlight += 1;
  try {
    const { captureImage } = await import('../../capture/engine.js');
    const dims = deriveFrameDims(row.frame);
    const result = await captureImage({
      target: { kind: 'screen' },
      format: 'png',
      dims,
      title: id,
      source: () => row.frame,
    });
    return new Response(result.bodyBytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return jsonResponse({ error: 'render-failed', id, reason: String(err instanceof Error ? err.message : err) }, 500);
  } finally {
    pngRendersInFlight -= 1;
  }
}

/** Path matcher: `/v1/terminals/:id/png`. */
export function parsePngPath(pathname: string): string | null {
  const m = /^\/v1\/terminals\/([^/]+)\/png$/.exec(pathname);
  return m && m[1] ? safeDecodeSegment(m[1]) : null;
}

// ── PTY 관측소 (실행 substrate 통합·2026-07-23) ──
// 헤드리스로 도는 모든 PTY 셸(로컬 데몬 + 크로스-프로세스 원격 self-implement/agent-mission)을 한 화면에서
// 라이브 관측하는 자립형 HTML. same-origin(fetch 인증 통과)·PWA 리빌드 불필요·접근성(semantic·ARIA·키보드·
// prefers-color-scheme). 데이터는 위 /v1/terminals + /:id/scrollback 재사용(read-only).
function terminalsViewHtml(): string { return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PTY 관측소 — 헤드리스 셸 라이브</title>
<style>
  :root { color-scheme:light dark; --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#ddd; --sel:#e8f0fe; --accent:#1a73e8; --term-bg:#0b0e14; --term-fg:#d6deeb; --ambiguous:#a66a00; --term-black:#4b5263; --term-red:#ff5874; --term-green:#5af78e; --term-yellow:#f3f99d; --term-blue:#57c7ff; --term-magenta:#ff6ac1; --term-cyan:#9aedfe; --term-white:#eff0eb; --term-bright-black:#7c8497; --term-bright-red:#ff8fa3; --term-bright-green:#8bffb0; --term-bright-yellow:#ffffb3; --term-bright-blue:#82d8ff; --term-bright-magenta:#ff92d0; --term-bright-cyan:#b8f4ff; --term-bright-white:#fff; }
  @media (prefers-color-scheme:dark){:root{--bg:#12141a;--fg:#e6e6e6;--muted:#9aa0aa;--line:#2a2e37;--sel:#1e2a44;--accent:#7aa2f7;--ambiguous:#f0b75e}}
  *{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap}header h1{font-size:16px;margin:0}header .meta{color:var(--muted);font-size:12px}.layout{display:flex;height:calc(100% - 49px)}.hidden{display:none!important}
  ul.list{list-style:none;margin:0;padding:0;width:340px;min-width:260px;overflow:auto;border-right:1px solid var(--line)}ul.list li button{width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);padding:10px 14px;color:var(--fg);cursor:pointer;font:inherit;display:block}ul.list li button:hover{background:var(--sel)}ul.list li button[aria-current="true"]{background:var(--sel);box-shadow:inset 3px 0 0 var(--accent)}ul.list li button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.row1{display:flex;align-items:center;gap:8px}.id{font-family:ui-monospace,Menlo,monospace;font-weight:600}.badge{font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--line);color:var(--muted)}.badge.remote{border-color:var(--accent);color:var(--accent)}
.badge.kind{border-color:var(--accent);color:var(--accent)}.badge.dead{opacity:.6;text-decoration:line-through}.badge.frame{border-color:#2ecc71;color:#2ecc71}.badge.ambiguous{border-color:var(--ambiguous);color:var(--ambiguous)}.dot{width:8px;height:8px;border-radius:50%;background:#2ecc71;display:inline-block}.dot.dead{background:#999}.sub{color:var(--muted);font-size:12px;margin-top:2px;font-family:ui-monospace,Menlo,monospace;white-space:normal;overflow-wrap:anywhere}
  .detail{flex:1;display:flex;flex-direction:column;min-width:0}.detail .head{padding:8px 14px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;font-family:ui-monospace,Menlo,monospace}pre.term{flex:1;margin:0;overflow:auto;background:var(--term-bg);color:var(--term-fg);padding:12px 14px;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}.empty{padding:24px;color:var(--muted)}
  .lineage-detail{flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden}.lineage-cards{flex:1;display:flex;flex-direction:column;min-height:0}.lineage-card{flex:1;min-height:0;display:flex;flex-direction:column;border-bottom:1px solid var(--line)}.lineage-card:last-child{border-bottom:0}.lineage-card h2{font:12px/1.4 ui-monospace,Menlo,monospace;margin:0;padding:6px 14px;border-bottom:1px solid var(--line);color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:8px}.lineage-maximize{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:2px 6px;cursor:pointer}.lineage-maximize:hover{background:var(--sel)}.lineage-maximize:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.lineage-card.maximized{flex:1;border-bottom:0}.lineage-meta{margin:0;padding:5px 14px;border-bottom:1px solid var(--line);color:var(--muted);font:11px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}.lineage-card pre{flex:1;margin:0;overflow:auto;background:var(--term-bg);color:var(--term-fg);padding:8px 14px;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}.more{padding:8px 14px;color:var(--muted);border-top:1px solid var(--line)}
</style></head><body>
<header>
  <h1>🖥 PTY 관측소</h1><span class="meta" id="summary" aria-live="polite">불러오는 중…</span><span class="meta" id="instances" aria-live="polite">인스턴스 범위: 확인 중…</span>
  <label class="meta"><input type="checkbox" id="lineageMode" aria-label="계보 모드"> 계보 모드</label><label class="meta" title="렌더 화면(픽커/모달 포함) ↔ 원시 출력(ANSI scrollback)"><input type="checkbox" id="frameMode" checked> 렌더 화면</label><label class="meta"><input type="checkbox" id="follow" checked> 자동 스크롤</label><label class="meta"><input type="checkbox" id="allRoots" aria-label="다른 인스턴스도"> 다른 인스턴스도</label><label class="meta"><input type="checkbox" id="includeTest" aria-label="테스트 인스턴스 포함" aria-describedby="scopeHint"> 테스트 인스턴스 포함</label><span class="meta" id="scopeHint" role="status" aria-live="polite"></span><button class="meta" id="originalGoal" type="button" aria-pressed="false">원래 골</button><span class="meta" id="clock" aria-hidden="true"></span>
</header>
<div class="layout">
  <ul class="list" id="list" aria-label="실행 중인 PTY 셸 목록"><li><div class="empty">불러오는 중…</div></li></ul>
  <section class="detail" id="flatDetail" aria-label="선택한 PTY 스크롤백"><div class="head" id="detailHead">← 왼쪽에서 셸을 선택하세요</div><pre class="term" id="scrollback" tabindex="0" aria-live="polite" aria-atomic="false">선택한 셸의 라이브 출력이 여기 표시됩니다.</pre></section>
  <ul class="list hidden" id="lineageList" aria-label="PTY 계보 목록"><li><div class="empty">계보를 불러오는 중…</div></li></ul>
  <section class="lineage-detail hidden" id="lineageDetail" aria-label="선택한 계보의 PTY 화면"><div class="head" id="lineageHead">← 왼쪽에서 계보를 선택하세요</div><button class="hidden" id="lineageDead" type="button" aria-expanded="false"></button><div class="empty hidden" id="lineageWarning" role="status" aria-live="polite"></div><div class="lineage-cards" id="lineageCards"></div></section>
</div>
<script>
${terminalTreeNames.toString()}
${terminalTreeLabel.toString()}
${relativeHistoryAge.toString()}
${terminalAgeBadge.toString()}
${terminalParentIdentity.toString()}
${terminalOriginIdentity.toString()}
${parseTerminalSgr.toString()}
(function(){
  var sel=null,hasSelectedInitialTerminal=false,lineageSel=null,lineageDeadVisible=false,lineageMaximizedKey=null,showingGoal=false,goalGeneration=0,listCache=[],lineageCache=[],unreadablePayloads=0,scopeQuery=typeof location==='undefined'?'':location.search;var el={list:document.getElementById('list'),sb:document.getElementById('scrollback'),head:document.getElementById('detailHead'),sum:document.getElementById('summary'),instances:document.getElementById('instances'),follow:document.getElementById('follow'),frameMode:document.getElementById('frameMode'),lineageMode:document.getElementById('lineageMode'),originalGoal:document.getElementById('originalGoal'),lineageList:document.getElementById('lineageList'),flatDetail:document.getElementById('flatDetail'),lineageDetail:document.getElementById('lineageDetail'),lineageHead:document.getElementById('lineageHead'),lineageWarning:document.getElementById('lineageWarning'),lineageDead:document.getElementById('lineageDead'),lineageCards:document.getElementById('lineageCards'),clock:document.getElementById('clock'),allRoots:document.getElementById('allRoots'),includeTest:document.getElementById('includeTest'),scopeHint:document.getElementById('scopeHint')};
  function isPtyLess(t){return !!(t&&t.hasPty===false)}function ptyLessStatus(t){return ({unknown:'상태 미상',finished:'완료',failed:'실패',aborted:'중단'})[t&&t.status]||'상태 미상'}function canRenderFrame(t){return !!(t&&!isPtyLess(t)&&(t.frameAt>0||(t.remote&&t.alive)))}function useFrame(t){return !!(el.frameMode.checked&&canRenderFrame(t))}function esc(s){return String(s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}function terminalKey(t){return (t&&t.sourceRoot&&t.sourceRoot.dbPath?t.sourceRoot.dbPath:'local')+'\\u0000'+(t&&t.id||'')}function renderTerminalFrame(target,frame){var segments=parseTerminalSgr(frame);target.textContent='';segments.forEach(function(segment){var span=document.createElement('span'),style=segment.style;span.textContent=segment.text;if(style.foreground)span.style.color=style.foreground;if(style.background)span.style.backgroundColor=style.background;if(style.bold)span.style.fontWeight='bold';if(style.faint)span.style.opacity='0.65';if(style.italic)span.style.fontStyle='italic';if(style.underline)span.style.textDecoration='underline';if(style.inverse){var foreground=span.style.color||'var(--term-fg)',background=span.style.backgroundColor||'var(--term-bg)';span.style.color=background;span.style.backgroundColor=foreground}target.appendChild(span)})}async function getJSON(u){var r=await fetch(u,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(r.status);return r.json()}
  function render(terms,scope){if(sel&&!terms.some(function(t){return terminalKey(t)===sel}))sel=null;var selectFirst=!sel&&terms.length;if(terms.length)hasSelectedInitialTerminal=true;if(selectFirst)sel=terminalKey(terms[0]);listCache=terms;el.sum.textContent=terms.length+'개 실행 · '+terms.filter(function(t){return t.alive===true}).length+' live · '+terms.filter(isPtyLess).length+' PTY 없음';scope=scope||{roots:1,federated:false,hiddenDead:0};el.instances.textContent=(scope.federated?'':'이 ')+scope.roots+'개 인스턴스에서 수집'+(scope.hiddenDead?' · 죽은 행 '+scope.hiddenDead+'개 숨김':' · 죽은 행 숨김 없음')+(scope.domain?' · '+scope.domain:'')+(scope.hiddenSubAgentRuns===undefined?'':' · '+scope.hiddenSubAgentRuns+'건 '+${JSON.stringify(TERMINALS_SCOPE_SUB_AGENT_COUNT)}+' 집계');if(!terms.length){el.list.innerHTML='<li><div class="empty">표시할 PTY 또는 서브 에이전트 실행이 없습니다.</div></li>';el.head.textContent='← 왼쪽에서 실행을 선택하세요';el.sb.textContent='선택한 실행의 상세가 여기 표시됩니다.';return selectFirst}el.list.innerHTML='';terms.forEach(function(t){var li=document.createElement('li'),b=document.createElement('button'),key=terminalKey(t),ptyLess=isPtyLess(t),status=ptyLess?ptyLessStatus(t):(t.alive?'실행중':'종료됨');b.setAttribute('data-terminal-key',key);b.setAttribute('aria-current',String(key===sel));b.setAttribute('aria-label',ptyLess?'PTY 없는 서브 에이전트 '+(t.name||t.id)+' '+status+(t.instance?' 인스턴스 '+t.instance:''):(t.kind?t.kind+' ':'')+'셸 '+t.id+' '+status+(t.instance?' 인스턴스 '+t.instance:''));var tree=terminalTreeLabel(t.workdir),age=terminalAgeBadge(t.startedAt),parent=terminalParentIdentity(t),origin=terminalOriginIdentity(t);if(ptyLess)b.innerHTML='<div class="row1"><span class="dot dead" aria-hidden="true"></span><span class="id">'+esc(t.name||t.id)+'</span><span class="badge kind">PTY 없음</span><span class="badge">'+esc(status)+'</span>'+(age?'<span class="badge">'+esc(age)+'</span>':'')+'</div><div class="sub">'+esc(t.id)+(t.instance?' · '+esc(t.instance):'')+(t.sessionId?' · 세션 '+esc(t.sessionId):'')+' · 상관 '+esc(t.correlationId||'-')+'</div>';else b.innerHTML='<div class="row1"><span class="dot '+(t.alive?'':'dead')+'" aria-hidden="true"></span><span class="id">'+esc(t.id)+'</span>'+(t.runId?'<span class="badge">런 '+esc(t.runId.slice(0,8))+'</span>':'')+(tree?'<span class="badge">'+esc(tree)+'</span>':'')+(age?'<span class="badge">'+esc(age)+'</span>':'')+(t.kind?'<span class="badge kind">'+esc(t.kind)+'</span>':'')+(canRenderFrame(t)?'<span class="badge frame">화면</span>':'')+(t.alive?'':'<span class="badge dead">종료</span>')+'</div><div class="sub">'+esc(t.cmd||'')+(t.instance?' · '+esc(t.instance):'')+' · 부모 '+esc(parent)+' · '+esc(origin)+' · '+(t.outputBytes||0)+'B · '+(t.runId?'런 '+esc(t.runId):'런 식별자가 없습니다')+'</div>';b.onclick=function(){clearOriginalGoal();sel=key;renderCurrent();refreshDetail()};li.appendChild(b);el.list.appendChild(li)});return selectFirst}
  function renderCurrent(){Array.prototype.forEach.call(el.list.querySelectorAll('button'),function(btn){btn.setAttribute('aria-current',String(btn.getAttribute('data-terminal-key')===sel))})}function syncPtyControls(t){var disabled=isPtyLess(t);el.frameMode.disabled=disabled;el.follow.disabled=disabled;if(el.originalGoal)el.originalGoal.disabled=disabled}function clearOriginalGoal(){showingGoal=false;goalGeneration+=1;if(el.originalGoal){el.originalGoal.setAttribute('aria-pressed','false');el.originalGoal.textContent='원래 골'}}function sourceQuery(t){return t&&t.sourceRoot&&t.sourceRoot.dbPath?'sourceRoot='+encodeURIComponent(t.sourceRoot.dbPath):''}function detailUrl(t,suffix,query){var root=sourceQuery(t),extra=query||'';return '/v1/terminals/'+encodeURIComponent(t.id)+'/'+suffix+(root||extra?'?'+[root,extra].filter(Boolean).join('&'):'')}function syncScopeControls(){if(!el.allRoots)return;var query=new URLSearchParams(scopeQuery),all=query.get('all')==='true',includeTest=query.get('includeTest')==='true';el.allRoots.checked=all;el.includeTest.checked=includeTest;el.includeTest.disabled=!all;el.scopeHint.textContent=includeTest&&!all?'테스트 인스턴스 포함은 「다른 인스턴스도」를 켰을 때만 적용됩니다.':''}function updateScope(){var query=new URLSearchParams(scopeQuery);if(el.allRoots.checked)query.set('all','true');else{query.delete('all');query.delete('includeTest');el.includeTest.checked=false}if(el.allRoots.checked&&el.includeTest.checked)query.set('includeTest','true');else query.delete('includeTest');scopeQuery=query.toString()?'?'+query.toString():'';syncScopeControls();refreshList()}async function refreshList(){try{var d=await getJSON('/v1/terminals'+scopeQuery),selectFirst=render(d.terminals||[],d.scope);if(selectFirst)refreshDetail();if(el.lineageMode.checked)refreshLineages()}catch(e){el.sum.textContent='목록 오류: '+e}}
  async function refreshDetail(){if(!sel||showingGoal)return;var selectedKey=sel,t=listCache.filter(function(x){return terminalKey(x)===selectedKey})[0];if(!t)return;syncPtyControls(t);if(isPtyLess(t)){el.head.textContent=(t.name||t.id)+' · PTY 없음 · '+ptyLessStatus(t);el.sb.textContent='이 서브 에이전트 실행에는 PTY와 스크롤백이 없습니다.\\n시작: '+(t.startedAt?new Date(t.startedAt).toLocaleString():'-')+'\\n인스턴스: '+(t.instance||'-')+'\\n세션: '+(t.sessionId||'-')+'\\n상관 ID: '+(t.correlationId||'-')+'\\n상태: '+ptyLessStatus(t);return}var frame=useFrame(t);el.head.textContent=t.id+' · '+(t.cmd||'')+(t.remote?' · 원격('+(t.instance||'')+')':' · 로컬')+(t.alive?'':' · 종료')+(frame?' · 🖼 렌더 화면':' · 원시');try{var top=el.sb.scrollTop,d=frame?await getJSON(detailUrl(t,'frame')):await getJSON(detailUrl(t,'scrollback','lines=400'));if(showingGoal||selectedKey!==sel)return;renderTerminalFrame(el.sb,(frame?d.frame:d.scrollback)||(frame?'(빈 프레임)':'(빈 출력)'));if(frame||!el.follow.checked)el.sb.scrollTop=top;else el.sb.scrollTop=el.sb.scrollHeight}catch(e){if(!showingGoal&&selectedKey===sel)el.sb.textContent=(frame?'프레임':'스크롤백')+' 오류: '+e}}
  async function toggleOriginalGoal(){if(showingGoal){clearOriginalGoal();refreshDetail();return}var t=sel&&listCache.filter(function(x){return terminalKey(x)===sel})[0],selectedKey=sel,generation=++goalGeneration;showingGoal=true;el.originalGoal.setAttribute('aria-pressed','true');el.originalGoal.textContent='원래 화면';if(!t||!t.runId){el.head.textContent='원래 골';el.sb.textContent='이 셀에는 런 식별자가 없습니다.';return}el.head.textContent=t.id+' · 원래 골';el.sb.textContent='원래 골을 불러오는 중…';try{var d=await getJSON('/v1/terminals/runs/'+encodeURIComponent(t.runId)+'/goal'+(sourceQuery(t)?'?'+sourceQuery(t):''));if(!showingGoal||generation!==goalGeneration||selectedKey!==sel)return;if(d.status==='found'){el.head.textContent=t.id+' · 원래 골'+(d.goalId?' · '+d.goalId:'');el.sb.textContent=d.goal+'\\n\\n조회 원장 디렉토리: '+(d.ledgerDirectory||'');return}var messages={'ledger-not-found':'이 런의 원장 파일이 없습니다.','start-not-found':'이 런 원장에는 시작 항목이 없습니다.','goal-not-found':'이 런의 시작 항목에 골 문면이 없습니다.','ledger-unreadable':'이 런 원장을 읽을 수 없습니다.'};el.sb.textContent=(messages[d.status]||'원래 골을 찾을 수 없습니다.')+(d.ledgerDirectory?'\\n조회 원장 디렉토리: '+d.ledgerDirectory:'')}catch(e){if(showingGoal&&generation===goalGeneration&&selectedKey===sel)el.sb.textContent='원래 골 조회 오류: '+e}}
  function lineageId(group){return JSON.stringify([group.sourceRoot&&group.sourceRoot.dbPath||'local',group.joinedBy,group.key])}function selectedLineage(){return lineageCache.filter(function(g){return lineageId(g)===lineageSel})[0]}function selectLineage(group){var next=group?lineageId(group):null;if(next!==lineageSel){lineageDeadVisible=false;lineageMaximizedKey=null}lineageSel=next;return group}function clearLineageDetail(message){selectLineage(null);el.lineageHead.textContent=message;el.lineageCards.innerHTML='';el.lineageDead.textContent='';el.lineageDead.classList.toggle('hidden',true);el.lineageDead.disabled=true;el.lineageDead.setAttribute('aria-expanded','false');el.lineageDead.onclick=null}function renderLineageWarning(){var hasWarning=unreadablePayloads>0;el.lineageWarning.textContent=hasWarning?'계보 원장 일부를 읽지 못함 · '+unreadablePayloads+'개': '';el.lineageWarning.classList.toggle('hidden',!hasWarning)}async function refreshLineages(){var anchors=listCache.length?listCache.filter(function(t){return !isPtyLess(t)}):lineageCache.map(function(group){return {id:group.rows[0]&&group.rows[0].ptyId,sourceRoot:group.sourceRoot}}).filter(function(t){return t.id});if(!anchors.length){lineageCache=[];unreadablePayloads=0;renderLineages();clearLineageDetail('표시할 계보가 없습니다.');return}try{var results=await Promise.all(anchors.map(function(t){return getJSON('/v1/terminals/lineage?key='+encodeURIComponent(t.id)+(sourceQuery(t)?'&'+sourceQuery(t):''))}));var groups={};unreadablePayloads=results.reduce(function(count,result){return Math.max(count,Number(result.unreadablePayloads)||0)},0);results.forEach(function(result,index){var sourceRoot=anchors[index]&&anchors[index].sourceRoot;(result.groups||[]).forEach(function(group){var rooted=Object.assign({},group,{sourceRoot:sourceRoot}),id=lineageId(rooted);if(!groups[id])groups[id]=rooted})});lineageCache=Object.keys(groups).map(function(key){return groups[key]});renderLineages();var group=selectedLineage();if(group)renderLineageCards(group);else clearLineageDetail('표시할 계보가 없습니다.')}catch(e){lineageCache=[];unreadablePayloads=0;renderLineageWarning();el.lineageList.innerHTML='<li><div class="empty">계보 목록 오류: '+esc(e)+'</div></li>';clearLineageDetail('계보 조회 오류: '+e)}}
  function renderLineages(){renderLineageWarning();if(!lineageCache.length){el.lineageList.innerHTML='<li><div class="empty">표시할 계보가 없습니다.</div></li>';return}if(!selectedLineage())selectLineage(lineageCache[0]);el.lineageList.innerHTML='';lineageCache.forEach(function(group){var li=document.createElement('li'),b=document.createElement('button'),ambiguous=group.joinedBy==='workdir-heuristic',id=lineageId(group);b.setAttribute('data-lineage-id',id);b.setAttribute('aria-current',String(id===lineageSel));b.setAttribute('aria-label','계보 '+group.key+', '+group.rows.length+'개 PTY, '+group.joinedBy+(ambiguous?' 모호':'')+(group.parentMissing?' 부모 행이 이 인스턴스에 없음':''));b.innerHTML='<div class="row1"><span class="id">'+esc(group.key)+'</span><span class="badge">'+group.rows.length+'개</span><span class="badge '+(ambiguous?'ambiguous':'')+'">'+esc(group.joinedBy)+(ambiguous?' · 모호':'')+'</span></div><div class="sub">'+(group.parentMissing?'부모 행이 이 인스턴스에 없음':'계보 묶음')+'</div>';b.onclick=function(){selectLineage(group);renderLineageCurrent();renderLineageCards(group)};li.appendChild(b);el.lineageList.appendChild(li)})}
  function renderLineageCurrent(){Array.prototype.forEach.call(el.lineageList.querySelectorAll('button'),function(btn){btn.setAttribute('aria-current',String(btn.getAttribute('data-lineage-id')===lineageSel))})}function lineageCardKey(row,group){return (group.sourceRoot&&group.sourceRoot.dbPath||'local')+'\\u0000'+row.ptyId}function findLineageCard(key){var cards=el.lineageCards.querySelectorAll('[data-pty-key]');for(var i=0;i<cards.length;i++)if(cards[i].getAttribute('data-pty-key')===key)return cards[i];return null}function liveTerm(id,sourceRoot){var key=(sourceRoot&&sourceRoot.dbPath||'local')+'\\u0000'+id;return listCache.filter(function(t){return terminalKey(t)===key})[0]||{id:id,frameAt:0,sourceRoot:sourceRoot}}
  function lineageMeta(row,group){var tree=terminalTreeLabel(row.workdir),age=terminalAgeBadge(row.startedAt),parent=terminalParentIdentity(row),origin=terminalOriginIdentity(row);return '시작: '+(row.startedAt?new Date(row.startedAt).toLocaleString():'-')+(age?' · 나이: '+age:'')+' · 종료: '+(row.closedAt?new Date(row.closedAt).toLocaleString():'-')+"\\n부모: "+parent+' · 부모 PTY: '+(row.parentPtyId||'-')+' · 부모 PID: '+(row.parentPid||'-')+' · 부모 종류: '+(row.parentKind||'-')+"\\n"+origin+"\\nrun: "+(row.runId||'-')+(tree?' · 트리: '+tree:'')+' · workdir: '+(row.workdir||'-')+' · code: '+(row.codeSha||'-')+' · 묶음: '+group.joinedBy}function renderLineageDeadToggle(group){var hidden=group.rows.filter(function(row){return !row.alive}).length;el.lineageDead.textContent=hidden?'종료된 기록 '+hidden+'개 '+(lineageDeadVisible?'감추기':'보기'):'';el.lineageDead.classList.toggle('hidden',hidden===0);el.lineageDead.disabled=hidden===0;el.lineageDead.setAttribute('aria-expanded',String(lineageDeadVisible));el.lineageDead.onclick=hidden?function(){if(lineageId(group)!==lineageSel)return;lineageDeadVisible=!lineageDeadVisible;renderLineageCards(group)}:null}function lineageRowsForDisplay(liveRows,deadRows){if(!lineageDeadVisible)return liveRows.slice(0,6);var shownDead=deadRows.slice(0,6);return liveRows.slice(0,6-shownDead.length).concat(shownDead)}async function renderLineageCards(group){var groupId=lineageId(group);if(groupId!==lineageSel)return;el.lineageHead.textContent=group.key+' · '+group.rows.length+'개 PTY · '+group.joinedBy+(group.parentMissing?' · 부모 행이 이 인스턴스에 없음':'');renderLineageDeadToggle(group);var liveRows=group.rows.filter(function(row){return row.alive}),deadRows=group.rows.filter(function(row){return !row.alive}),shown=lineageRowsForDisplay(liveRows,deadRows),seen={};if(lineageMaximizedKey!==null&&!shown.some(function(row){return lineageCardKey(row,group)===lineageMaximizedKey}))lineageMaximizedKey=null;shown.forEach(function(row){var cardKey=lineageCardKey(row,group),card=findLineageCard(cardKey),title,label,maximize,meta,screen,maximized=lineageMaximizedKey===cardKey;if(card){title=card.querySelector('h2');label=title.querySelector('.lineage-card-title');maximize=title.querySelector('button');meta=card.querySelector('.lineage-meta');screen=card.querySelector('pre')}else{card=document.createElement('article');title=document.createElement('h2');label=document.createElement('span');maximize=document.createElement('button');meta=document.createElement('p');screen=document.createElement('pre');card.className='lineage-card';card.setAttribute('data-pty-key',cardKey);card.setAttribute('aria-label','PTY '+row.ptyId+' 화면');label.className='lineage-card-title';maximize.className='lineage-maximize';maximize.type='button';meta.className='lineage-meta';screen.tabIndex=0;screen.setAttribute('aria-live','polite');screen.textContent=row.alive?'불러오는 중…':'종료됨 · 기록 불러오는 중…';title.appendChild(label);title.appendChild(maximize);card.appendChild(title);card.appendChild(meta);card.appendChild(screen);el.lineageCards.appendChild(card)}label.textContent=row.ptyId+' · '+(row.kind||'-')+' · '+(row.instance||'-')+' · '+(row.alive?'실행중':'종료됨');maximize.textContent=maximized?'복원':'최대화';maximize.setAttribute('aria-pressed',String(maximized));maximize.setAttribute('aria-label',row.ptyId+' 카드 '+(maximized?'복원':'최대화'));maximize.onclick=function(){if(shown.length<2)return;lineageMaximizedKey=lineageMaximizedKey===cardKey?null:cardKey;renderLineageCards(group)};title.appendChild(maximize);meta.textContent=lineageMeta(row,group);card.classList.toggle('maximized',maximized);card.classList.toggle('hidden',lineageMaximizedKey!==null&&!maximized);seen[cardKey]=1;refreshLineageScreen(row,group,screen,groupId)});if(lineageMaximizedKey!==null&&!seen[lineageMaximizedKey])lineageMaximizedKey=null;Array.prototype.forEach.call(el.lineageCards.querySelectorAll('[data-pty-key]'),function(card){if(!seen[card.getAttribute('data-pty-key')])card.remove()});var more=el.lineageCards.querySelector('.more'),available=lineageDeadVisible?liveRows.concat(deadRows):liveRows;if(available.length>6){if(!more){more=document.createElement('div');more.className='more';el.lineageCards.appendChild(more)}more.textContent='외 '+(available.length-6)+'개';more.classList.toggle('hidden',lineageMaximizedKey!==null)}else if(more)more.remove()}
  async function refreshLineageScreen(row,group,screen,groupId){var term=liveTerm(row.ptyId,group.sourceRoot),frame=row.alive&&useFrame(term),top=screen.scrollTop;try{var d=frame?await getJSON(detailUrl(term,'frame')):await getJSON(detailUrl(term,'scrollback','lines=400')),output=(frame?d.frame:d.scrollback)||'(빈 출력)';if(groupId!==lineageSel||findLineageCard(lineageCardKey(row,group))!==screen.parentNode)return;renderTerminalFrame(screen,row.alive?output:'종료됨 · 현재 화면이 아닌 기록\\n'+output);if(frame||!el.follow.checked)screen.scrollTop=top;else screen.scrollTop=screen.scrollHeight}catch(e){if(groupId!==lineageSel||findLineageCard(lineageCardKey(row,group))!==screen.parentNode)return;screen.textContent=row.alive?(frame?'프레임':'스크롤백')+' 오류: '+e:'종료됨 · 기록을 읽을 수 없음';screen.scrollTop=top}}
  function toggleMode(){var lineage=el.lineageMode.checked;el.list.classList.toggle('hidden',lineage);el.flatDetail.classList.toggle('hidden',lineage);el.lineageList.classList.toggle('hidden',!lineage);el.lineageDetail.classList.toggle('hidden',!lineage);if(lineage)refreshLineages()}if(el.originalGoal)el.originalGoal.onclick=toggleOriginalGoal;document.addEventListener('keydown',function(e){if(!['ArrowDown','ArrowUp'].includes(e.key))return;if(el.lineageMode.checked){if(!lineageCache.length)return;var li=lineageCache.findIndex(function(g){return lineageId(g)===lineageSel});li=e.key==='ArrowDown'?Math.min(lineageCache.length-1,li+1):Math.max(0,li-1);if(li<0)li=0;var group=lineageCache[li];selectLineage(group);renderLineageCurrent();renderLineageCards(group);var lineageBtn=el.lineageList.querySelectorAll('button')[li];if(lineageBtn)lineageBtn.focus();e.preventDefault();return}if(!listCache.length)return;var i=listCache.findIndex(function(t){return terminalKey(t)===sel});i=e.key==='ArrowDown'?Math.min(listCache.length-1,i+1):Math.max(0,i-1);if(i<0)i=0;clearOriginalGoal();sel=terminalKey(listCache[i]);renderCurrent();refreshDetail();var btn=el.list.querySelectorAll('button')[i];if(btn)btn.focus();e.preventDefault()});el.frameMode.addEventListener('change',function(){if(showingGoal)clearOriginalGoal();if(sel)refreshDetail();if(lineageSel){var group=selectedLineage();if(group)renderLineageCards(group)}});el.lineageMode.addEventListener('change',toggleMode);if(el.allRoots){el.allRoots.addEventListener('change',updateScope);el.includeTest.addEventListener('change',updateScope);syncScopeControls()}setInterval(function(){refreshList();if(sel&&!el.lineageMode.checked&&!showingGoal)refreshDetail();el.clock.textContent=new Date().toLocaleTimeString()},2000);refreshList();
})();
</script>
</body></html>`; }

/** GET /v1/terminals/view — 헤드리스 PTY 셸 라이브 관측소(자립형 HTML·same-origin·접근성). */
export function handleTerminalsView(): Response {
  return new Response(terminalsViewHtml(), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
