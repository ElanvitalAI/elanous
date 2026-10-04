import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tracedPathReferences, verbatimOriginalAsk } from './goal-author.js';
import { parseAskTargetPathHintsResult } from '../self-dev/launch-preflight.js';
import { isRunStatus } from './run-status-mapping.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { normalizeRunId } from '../harness/harness-space.js';
import { resolveLogTargets, type LogTarget } from '../cli/logs-cli.js';
import { LogStore, logsDbPath, type LogStoreRow } from '../mss/logging/log-store.js';
import { loadSelfDevRun, selfDevRunsDir } from '../self-dev/run-store.js';
import { extractHarnessReviewAcceptance } from '../harness/harness-seams.js';
import { resolveGoalDocumentsDir } from './goal-documents-dir.js';
import { debug } from '../debug/log.js';
import { withRunLedgerLock, restoreArchivedRunLedger } from './run-ledger-compact.js';

export interface RunLedgerEntry {
  timestamp?: string;
  runId: string;
  event: string;
  data: Record<string, unknown>;
  goalId?: string;
  orchestrationId?: string;
  shardId?: string;
  siblingShardIds?: string[];
  pieceIndex?: number;
  pieceTotal?: number;
  shardIdentityReadFailure?: RunShardIdentityReadFailure;
}

export type RunShardIdentityReadFailure = 'malformed-structure' | 'invalid-values';

export interface RunShardIdentity {
  orchestrationId?: string;
  shardId?: string;
  siblingShardIds?: string[];
  pieceIndex?: number;
  pieceTotal: number;
  shardIdentityReadFailure?: RunShardIdentityReadFailure;
}

const SHARD_IDENTITY_HEADING = '## Shard identity';
const SHARD_IDENTITY_HEADING_LINE = /^## Shard identity\r?$/gm;

/** Parse the optional shard identity suffix without making ledger production fail. */
export function parseRunShardIdentity(request: string): RunShardIdentity {
  let headingIndex = -1;
  for (const match of request.matchAll(SHARD_IDENTITY_HEADING_LINE)) headingIndex = match.index;
  if (headingIndex === -1) return { pieceTotal: 1 };

  try {
    const parsed: unknown = JSON.parse(request.slice(headingIndex + SHARD_IDENTITY_HEADING.length).trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' };
    }
    const identity = parsed as Record<string, unknown>;
    const totalShards = identity.totalShards;
    const position = identity.position;
    if (typeof totalShards !== 'number' || !Number.isInteger(totalShards) || totalShards < 1
      || typeof position !== 'number' || !Number.isInteger(position) || position < 1 || position > totalShards) {
      return { pieceTotal: 1, shardIdentityReadFailure: 'invalid-values' };
    }
    if (typeof identity.shardId !== 'string' || !identity.shardId.trim()) {
      return { pieceTotal: 1, shardIdentityReadFailure: 'invalid-values' };
    }
    const shardId = identity.shardId;
    const orchestrationId = typeof identity.orchestrationId === 'string' && identity.orchestrationId.trim()
      ? identity.orchestrationId
      : undefined;
    const siblings = identity.siblings;
    const siblingShardIds = Array.isArray(siblings)
      && siblings.every((sibling) => Boolean(sibling) && typeof sibling === 'object' && !Array.isArray(sibling)
        && typeof (sibling as Record<string, unknown>).shardId === 'string'
        && Boolean((sibling as Record<string, string>).shardId.trim()))
      ? siblings.map((sibling) => (sibling as Record<string, string>).shardId).filter((siblingId) => siblingId !== shardId)
      : undefined;
    return {
      ...(orchestrationId === undefined ? {} : { orchestrationId }),
      shardId,
      ...(siblingShardIds === undefined ? {} : { siblingShardIds }),
      pieceIndex: position - 1,
      pieceTotal: totalShards,
    };
  } catch {
    return { pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' };
  }
}

export interface RunOriginData extends Record<string, unknown> {
  hostId: string;
  hostname: string;
  platform: string;
  arch: string;
  substrate: string;
  instance: string;
  elanousVersion: string;
  podName?: string;
  nodeName?: string;
  podNamespace?: string;
  imageCommit?: string;
}

export type RunLedgerWriter = (entry: RunLedgerEntry) => void;
export type RunLedgerReader = (path: string, encoding?: 'utf8') => string | Buffer;

/** A live PTY lacks its producer correlation id, or that id lacks an observable JSONL ledger. */
export type RunLedgerGapKind = 'live-pty-run-id-missing' | 'live-pty-ledger-missing' | 'ledger-root-unreadable' | 'pty-manifest-root-unreadable';

export interface RunLedgerGap {
  kind: RunLedgerGapKind;
  root: string;
  ptyKind?: string;
  runId?: string;
}

export interface RunLedgerGapRoot {
  root: string;
  manifestStatus: 'read' | 'unreadable';
  ledgerStatus: 'read' | 'missing' | 'unreadable';
  /**
   * Run IDs this root's JSONL run-ledger store actually evidences.
   *
   * ⛔⭐ **탐지 범위는 JSONL 원장 «하나»다**(리뷰 지적 4 · 2026-08-12). 형제 저장소 둘은 «의도적으로» 뺐다:
   *   ⓐ self-dev checkpoint(`<root>/self-dev/runs/<runId>.json`) — resume 용 스냅샷이라 원장과 «수명·목적»이
   *      다르다. 체크포인트가 있는데 원장이 없는 상태가 바로 이 도구가 세려는 결손이므로, 합치면
   *      ***재려던 구멍을 스스로 메워 보이게 된다***(측정 대상이 측정자를 덮는다).
   *   ⓑ log-store(`logs.db`) — 관측 미러이지 원장이 아니다. 로그에 runId 가 보인다고 그 런의 «원장»이 있는 것이
   *      아니다. 같은 이유로 합치면 결손이 사라진 것처럼 «보인다».
   *   ⇒ 그 둘은 결손의 «후속 조사» 재료지 분모가 아니다(`describeMissingRunLedger` 가 ⓐ 를 그 용도로 낸다).
   * ⛔⭐ 그리고 이 집합은 «파일 이름»이 아니라 «레코드»로 채운다 — 수집기(`scanPtyLedgerScope`)가 각 파일을
   *   `loadRunLedger` 로 열어 «그 파일 이름과 같은 runId 를 가진 레코드가 하나 이상» 있을 때만 넣는다.
   *   빈 파일·손상 파일은 커버리지로 세지 않는다(이름만 맞는 껍데기를 「관측됨」이라 말하지 않는다).
   */
  ledgerRunIds?: ReadonlySet<string>;
  livePtys?: readonly { kind: string; runId: string | null }[];
}

export interface RunLedgerGapMeasurement {
  scope: 'self-implement-run-ledger-gaps';
  complete: boolean;
  rootsMeasured: number;
  livePtyCount: number;
  gaps: readonly RunLedgerGap[];
  counts: Readonly<Record<RunLedgerGapKind, number>>;
  note: string;
}

const RUN_LEDGER_GAP_NOTE = 'A missing ledger is distinct from an unreadable root. Live PTY rows are measured from every readable manifest, and a readable-but-missing ledger directory contributes live-pty-ledger-missing gaps rather than an incomplete measurement. An unreadable ledger directory still yields live-pty-run-id-missing gaps from its readable manifest, but never live-pty-ledger-missing, because ledger coverage for that root was not observed. Ledger coverage is evidenced by run-ledger records, not by file names alone; the separate self-dev checkpoint store and log-store are deliberately outside this measurement.';

/**
 * Classify run-ledger coverage from already-observed roots without reading or changing any store.
 * Callers own PTY liveness and filesystem collection; this keeps the detector testable and read-only.
 *
 * ⛔⭐ 두 축은 «따로» 흐른다(리뷰 must-fix 2026-08-12) — manifest 판독성과 ledger 판독성은 다른 자다.
 *   종전 판은 ledger 를 못 읽으면 그 뿌리를 통째로 `continue` 했다 ⇒ ***manifest 로 이미 수집한 live PTY 가
 *   사라져, runId 를 아예 «잃은» PTY(= ledger 와 무관하게 판정 가능한 결손)까지 조용히 0 이 됐다.***
 *   ⇒ 이제 ledger 판독 실패는 「원장 대조」만 막고, 「생산자 runId 부재」 판정은 계속 낸다.
 *   ⚠️ 반대로 manifest 를 못 읽은 뿌리는 live PTY 자체를 «안 본 것»이라 계속 통째로 뺀다.
 */
export function measureRunLedgerGaps(roots: readonly RunLedgerGapRoot[]): RunLedgerGapMeasurement {
  const gaps: RunLedgerGap[] = [];
  const counts: Record<RunLedgerGapKind, number> = {
    'live-pty-run-id-missing': 0,
    'live-pty-ledger-missing': 0,
    'ledger-root-unreadable': 0,
    'pty-manifest-root-unreadable': 0,
  };
  let livePtyCount = 0;
  const add = (gap: RunLedgerGap): void => { gaps.push(gap); counts[gap.kind] += 1; };
  for (const root of roots) {
    if (root.manifestStatus === 'unreadable') {
      add({ kind: 'pty-manifest-root-unreadable', root: root.root });
      continue;
    }
    // ⭐ 이 뿌리의 원장 대조가 가능한가 — «불가»여도 아래 live PTY 순회는 멈추지 않는다.
    const ledgerComparable = root.ledgerStatus !== 'unreadable';
    if (!ledgerComparable) add({ kind: 'ledger-root-unreadable', root: root.root });
    for (const pty of root.livePtys ?? []) {
      livePtyCount += 1;
      if (!pty.runId) {
        add({ kind: 'live-pty-run-id-missing', root: root.root, ptyKind: pty.kind });
      } else if (ledgerComparable && !root.ledgerRunIds?.has(pty.runId)) {
        add({ kind: 'live-pty-ledger-missing', root: root.root, ptyKind: pty.kind, runId: pty.runId });
      }
      // ⛔ runId 가 있는데 원장을 못 읽은 경우는 «결손이 아니라 미관측»이다 — `ledger-root-unreadable`
      //   하나로 이미 `complete=false` 를 만들었으므로, 여기서 「원장 없음」이라 말하지 않는다.
    }
  }
  return {
    scope: 'self-implement-run-ledger-gaps',
    complete: counts['ledger-root-unreadable'] === 0 && counts['pty-manifest-root-unreadable'] === 0,
    rootsMeasured: roots.length,
    livePtyCount,
    gaps,
    counts,
    note: RUN_LEDGER_GAP_NOTE,
  };
}

/** `<ELANOUS_STATE_DIR or ~/.elanous>/run-ledger`, separate from self-dev resume checkpoints. */
export function runLedgerDir(stateDir?: string): string {
  return join(stateDir ?? elanousStateRoot(), 'run-ledger');
}

export function runLedgerPath(runId: string, dir = runLedgerDir()): string {
  // ⛔⭐ 자기 정규식을 갖지 않는다 — runId 의 «정규화 계약»은 harness-space 의 normalizeRunId 하나다
  //    (pickRunId·mintRunId·전파 env·PTY 가 전부 그것을 통과한다).
  //    ⚠️ 종전 판은 여기서 «따로» 검사하고 던졌다. 관측 관문은 fail-soft 라 그 예외가 삼켜지므로,
  //      계약이 어긋나는 순간 그 런의 원장이 «통째로 조용히» 비었을 것이다(리뷰 should-fix).
  //    ⇒ 같은 함수를 쓰면 파일 이름이 다른 표면이 부르는 이름과 «항상» 같고, 던질 일이 없다.
  //    ⛔⭐ 그렇다고 «정규화해서 통과»시키지 않는다 — `../x` 가 조용히 `-x` 로 바뀌면 경로 탈출 방어가
  //      «값을 고쳐서» 사라진다. 거부는 유지하고, 「받아들이는 집합」만 그 함수의 «산출 집합»과 맞춘다.
  if (runId !== normalizeRunId(runId) || !runId) throw new Error(`invalid runId: ${runId}`);
  return join(dir, `${runId}.jsonl`);
}

const CANONICAL_RUN_LEDGER_FILE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

function runIdFromCanonicalLedgerFile(fileName: string): string | null {
  return CANONICAL_RUN_LEDGER_FILE.test(fileName) ? fileName.slice(0, -'.jsonl'.length) : null;
}

export interface MissingRunLedgerDescription {
  runLedgerPath: string;
  selfDevRunPath: string;
  checkedPaths: readonly string[];
  selfDevRunFound: boolean;
}

/** Describe the separate checkpoint store when no JSONL run ledger exists; checkpoint data stays unrendered. */
export function describeMissingRunLedger(runId: string, stateDir?: string): MissingRunLedgerDescription {
  const normalizedRunId = normalizeRunId(runId);
  const ledgerDir = runLedgerDir(stateDir);
  const checkpointDir = selfDevRunsDir(stateDir);
  const ledgerPath = runLedgerPath(normalizedRunId, ledgerDir);
  const checkpointPath = join(checkpointDir, `${normalizedRunId}.json`);
  return {
    runLedgerPath: ledgerPath,
    selfDevRunPath: checkpointPath,
    checkedPaths: [ledgerPath, checkpointPath],
    selfDevRunFound: loadSelfDevRun(normalizedRunId, checkpointDir) !== null,
  };
}

/** Reuse the `elanous logs --all/--include-test` target policy for physical run-ledger directories. */
export function runLedgerDirectoriesForLogTargets(targets: readonly LogTarget[]): string[] {
  return [...new Set(targets.map((target) => resolve(dirname(dirname(target.dbPath)), 'run-ledger')))];
}

export interface FederatedRunLedgerLookupOptions {
  includeTest?: boolean;
  targets?: readonly LogTarget[];
  read?: RunLedgerReader;
  loadCheckpoint?: (runId: string, directory: string) => boolean;
}

export interface RunLedgerLookupOptions extends FederatedRunLedgerLookupOptions {
  all?: boolean;
  list?: (path: string) => string[];
}

export interface RunLedgerMatch {
  runId: string;
  ledgerDirectory: string;
  ledgerPath: string;
  targetName: string | null;
  entries: readonly RunLedgerEntry[];
  skippedTrailingBytes?: number;
}

export interface RunLedgerLookup {
  matches: readonly RunLedgerMatch[];
}

interface RunLedgerLookupTarget {
  ledgerDirectory: string;
  targetName: string | null;
}

export function resolveFederatedRunLedgerTargets(options: Pick<FederatedRunLedgerLookupOptions, 'includeTest' | 'targets'>): RunLedgerLookupTarget[] {
  const resolved = options.targets ? { targets: [...options.targets] } : resolveLogTargets({ all: true, includeTest: options.includeTest });
  if (resolved.error) throw new Error(resolved.error);
  const targets = new Map<string, string>();
  for (const target of resolved.targets) {
    const ledgerDirectory = resolve(dirname(dirname(target.dbPath)), 'run-ledger');
    if (!targets.has(ledgerDirectory)) targets.set(ledgerDirectory, target.name);
  }
  return [...targets].map(([ledgerDirectory, targetName]) => ({ ledgerDirectory, targetName }));
}

export function resolveFederatedRunLedgerDirectories(options: Pick<FederatedRunLedgerLookupOptions, 'includeTest' | 'targets'>): string[] {
  return resolveFederatedRunLedgerTargets(options).map((target) => target.ledgerDirectory);
}

/** Read-only lookup across the same physical ledger directories as the federated unfinished-run query. */
export function loadFederatedRunLedger(runId: string, options: FederatedRunLedgerLookupOptions = {}): RunLedgerEntry[] | null {
  for (const directory of resolveFederatedRunLedgerDirectories(options)) {
    const ledger = loadRunLedger(runId, directory, options.read);
    if (ledger !== null) return ledger;
  }
  return null;
}

function lookupRunLedgerTargets(options: RunLedgerLookupOptions): RunLedgerLookupTarget[] {
  return options.all ? resolveFederatedRunLedgerTargets(options) : [{ ledgerDirectory: runLedgerDir(), targetName: null }];
}

/** Find exact canonical IDs first; otherwise scan canonical ledger filenames for a normalized unique prefix. */
export function lookupRunLedger(runId: string, options: RunLedgerLookupOptions = {}): RunLedgerLookup {
  const normalizedRunId = normalizeRunId(runId);
  const lookupTargets = lookupRunLedgerTargets(options);
  const read = options.read ?? readFileSync;
  const exactMatches: RunLedgerMatch[] = [];
  for (const { ledgerDirectory, targetName } of lookupTargets) {
    const ledger = loadRunLedgerWithMetadata(normalizedRunId, ledgerDirectory, read);
    if (ledger !== null) exactMatches.push({
      runId: normalizedRunId,
      ledgerDirectory,
      ledgerPath: runLedgerPath(normalizedRunId, ledgerDirectory),
      targetName,
      entries: ledger.entries,
      ...(ledger.skippedTrailingBytes === undefined ? {} : { skippedTrailingBytes: ledger.skippedTrailingBytes }),
    });
  }
  if (exactMatches.length > 0) return { matches: exactMatches };

  const list = options.list ?? readdirSync;
  const matches: RunLedgerMatch[] = [];
  for (const { ledgerDirectory, targetName } of lookupTargets) {
    let fileNames: string[];
    try {
      fileNames = list(ledgerDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`unable to list run ledger directory ${ledgerDirectory}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const fileName of fileNames) {
      const candidateRunId = runIdFromCanonicalLedgerFile(fileName);
      if (candidateRunId === null || !candidateRunId.startsWith(normalizedRunId)) continue;
      const ledger = loadRunLedgerWithMetadata(candidateRunId, ledgerDirectory, read);
      if (ledger === null) continue;
      matches.push({
        runId: candidateRunId,
        ledgerDirectory,
        ledgerPath: runLedgerPath(candidateRunId, ledgerDirectory),
        targetName,
        entries: ledger.entries,
        ...(ledger.skippedTrailingBytes === undefined ? {} : { skippedTrailingBytes: ledger.skippedTrailingBytes }),
      });
    }
  }
  return { matches };
}

/** Enumerate every durable run ledger in the selected current or federated targets, independent of its filename prefix. */
export function listRunLedgers(options: RunLedgerLookupOptions = {}): RunLedgerLookup {
  const list = options.list ?? readdirSync;
  const read = options.read ?? readFileSync;
  const matches: RunLedgerMatch[] = [];
  for (const { ledgerDirectory, targetName } of lookupRunLedgerTargets(options)) {
    let fileNames: string[];
    try {
      fileNames = list(ledgerDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`unable to list run ledger directory ${ledgerDirectory}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.jsonl')) continue;
      const runId = fileName.slice(0, -'.jsonl'.length);
      if (!runId || runId !== normalizeRunId(runId)) continue;
      const entries = loadRunLedger(runId, ledgerDirectory, read);
      if (entries !== null) matches.push({ runId, ledgerDirectory, ledgerPath: runLedgerPath(runId, ledgerDirectory), targetName, entries });
    }
  }
  return { matches };
}

/** Describe every physical ledger and checkpoint path inspected by a federated lookup. */
export function describeFederatedMissingRunLedger(runId: string, options: FederatedRunLedgerLookupOptions = {}): MissingRunLedgerDescription {
  const normalizedRunId = normalizeRunId(runId);
  const ledgerDirectories = resolveFederatedRunLedgerDirectories(options);
  const ledgerPaths = ledgerDirectories.map((directory) => runLedgerPath(normalizedRunId, directory));
  const checkpointDirectories = ledgerDirectories.map((directory) => selfDevRunsDir(dirname(directory)));
  const checkpointPaths = checkpointDirectories.map((directory) => join(directory, `${normalizedRunId}.json`));
  const checkedPaths = [...ledgerPaths];
  const loadCheckpoint = options.loadCheckpoint ?? ((id, directory) => loadSelfDevRun(id, directory) !== null);
  let selfDevRunFound = false;
  for (let index = 0; index < checkpointDirectories.length; index += 1) {
    checkedPaths.push(checkpointPaths[index]!);
    if (loadCheckpoint(normalizedRunId, checkpointDirectories[index]!)) {
      selfDevRunFound = true;
      break;
    }
  }
  return {
    runLedgerPath: ledgerPaths[0] ?? runLedgerPath(normalizedRunId),
    selfDevRunPath: checkpointPaths[0] ?? join(selfDevRunsDir(), `${normalizedRunId}.json`),
    checkedPaths,
    selfDevRunFound,
  };
}

/** Append one observer event. Callers own fail-soft handling. */
export function appendRunLedgerEntry(entry: RunLedgerEntry, dir = runLedgerDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const live = runLedgerPath(entry.runId, dir);
  withRunLedgerLock(dir, entry.runId, () => {
    const line = `${JSON.stringify(entry)}\n`;
    if (!restoreArchivedRunLedger(dir, entry.runId, line)) appendFileSync(live, line, 'utf8');
  });
}

export interface HumanStopRunLedgerOptions {
  stoppedBy: string;
  stoppedAt?: string;
  dir?: string;
}

/** Record that a human stopped a run; this records the fact and never stops a process itself. */
export function recordHumanStoppedRun(runId: string, options: HumanStopRunLedgerOptions): void {
  const stoppedAt = options.stoppedAt ?? new Date().toISOString();
  appendRunLedgerEntry({
    timestamp: stoppedAt,
    runId,
    event: 'human-stop',
    data: { stoppedBy: options.stoppedBy, stoppedAt },
  }, options.dir);
}

function parseRunLedgerEntry(line: string, lineNumber: number, expectedRunId: string): RunLedgerEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid run ledger JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid run ledger entry at line ${lineNumber}: expected an object`);
  }
  const entry = parsed as Partial<RunLedgerEntry>;
  if ((entry.timestamp !== undefined && typeof entry.timestamp !== 'string') || typeof entry.runId !== 'string' || typeof entry.event !== 'string'
    || !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)
    || (entry.goalId !== undefined && typeof entry.goalId !== 'string')
    || (entry.orchestrationId !== undefined && typeof entry.orchestrationId !== 'string')
    || (entry.shardId !== undefined && typeof entry.shardId !== 'string')
    || (entry.siblingShardIds !== undefined && (!Array.isArray(entry.siblingShardIds) || entry.siblingShardIds.some((shardId) => typeof shardId !== 'string')))
    || (entry.shardIdentityReadFailure !== undefined && entry.shardIdentityReadFailure !== 'malformed-structure' && entry.shardIdentityReadFailure !== 'invalid-values')
    || (entry.pieceIndex !== undefined && (!Number.isInteger(entry.pieceIndex) || entry.pieceIndex < 0))
    || (entry.pieceTotal !== undefined && (!Number.isInteger(entry.pieceTotal) || entry.pieceTotal < 1))) {
    throw new Error(`invalid run ledger entry at line ${lineNumber}: expected optional timestamp, goalId, shard identity, runId, event, and object data`);
  }
  if (entry.runId !== expectedRunId) {
    throw new Error(`invalid run ledger entry at line ${lineNumber}: runId does not match ${expectedRunId}`);
  }
  return entry as RunLedgerEntry;
}

export interface LoadedRunLedger {
  entries: RunLedgerEntry[];
  skippedTrailingBytes?: number;
}

/** Whether appending JSON source characters could turn this malformed source into a JSON value. */
function isIncompleteJsonPrefix(source: string): boolean {
  let index = 0;
  const skipWhitespace = () => {
    while (/[\t\n\r ]/.test(source[index] ?? '')) index += 1;
  };
  const incomplete = () => { throw new Error('incomplete'); };
  const invalid = () => { throw new Error('invalid'); };
  const parseString = () => {
    if (source[index++] !== '"') invalid();
    for (;;) {
      const char = source[index++];
      if (char === undefined) incomplete();
      if (char === '"') return;
      if (char === '\\') {
        const escape = source[index++];
        if (escape === undefined) incomplete();
        if (escape === 'u') {
          for (let digit = 0; digit < 4; digit += 1) {
            const hex = source[index++];
            if (hex === undefined) incomplete();
            if (!/[0-9a-f]/i.test(hex)) invalid();
          }
        } else if (!'"\\/bfnrt'.includes(escape)) invalid();
      } else if (char.charCodeAt(0) < 0x20) invalid();
    }
  };
  const parseLiteral = (literal: string) => {
    for (const expected of literal) {
      const actual = source[index++];
      if (actual === undefined) incomplete();
      if (actual !== expected) invalid();
    }
  };
  const parseNumber = () => {
    if (source[index] === '-') {
      index += 1;
      if (source[index] === undefined) incomplete();
    }
    if (source[index] === '0') index += 1;
    else if (/[1-9]/.test(source[index] ?? '')) {
      index += 1;
      while (/[0-9]/.test(source[index] ?? '')) index += 1;
    } else invalid();
    if (source[index] === '.') {
      index += 1;
      if (!/[0-9]/.test(source[index] ?? '')) {
        if (source[index] === undefined) incomplete();
        invalid();
      }
      while (/[0-9]/.test(source[index] ?? '')) index += 1;
    }
    if (source[index] === 'e' || source[index] === 'E') {
      index += 1;
      if (source[index] === '+' || source[index] === '-') index += 1;
      if (!/[0-9]/.test(source[index] ?? '')) {
        if (source[index] === undefined) incomplete();
        invalid();
      }
      while (/[0-9]/.test(source[index] ?? '')) index += 1;
    }
  };
  const parseValue = (): void => {
    skipWhitespace();
    const char = source[index];
    if (char === undefined) incomplete();
    if (char === '"') return parseString();
    if (char === '{') {
      index += 1;
      skipWhitespace();
      if (source[index] === undefined) incomplete();
      if (source[index] === '}') { index += 1; return; }
      for (;;) {
        if (source[index] !== '"') invalid();
        parseString();
        skipWhitespace();
        if (source[index] === undefined) incomplete();
        if (source[index++] !== ':') invalid();
        parseValue();
        skipWhitespace();
        if (source[index] === undefined) incomplete();
        if (source[index] === '}') { index += 1; return; }
        if (source[index++] !== ',') invalid();
        skipWhitespace();
        if (source[index] === undefined) incomplete();
      }
    }
    if (char === '[') {
      index += 1;
      skipWhitespace();
      if (source[index] === undefined) incomplete();
      if (source[index] === ']') { index += 1; return; }
      for (;;) {
        parseValue();
        skipWhitespace();
        if (source[index] === undefined) incomplete();
        if (source[index] === ']') { index += 1; return; }
        if (source[index++] !== ',') invalid();
        skipWhitespace();
        if (source[index] === undefined) incomplete();
      }
    }
    if (char === 't') return parseLiteral('true');
    if (char === 'f') return parseLiteral('false');
    if (char === 'n') return parseLiteral('null');
    if (char === '-' || /[0-9]/.test(char)) return parseNumber();
    invalid();
  };

  try {
    parseValue();
    return false;
  } catch (error) {
    return error instanceof Error && error.message === 'incomplete';
  }
}

/** Returns null only when the ledger file does not exist; malformed complete records and unreadable ledgers throw. */
export function loadRunLedgerWithMetadata(runId: string, dir = runLedgerDir(), read: RunLedgerReader = readFileSync): LoadedRunLedger | null {
  const path = runLedgerPath(runId, dir);
  let raw: Buffer;
  try {
    const contents = read(path);
    raw = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`unable to read run ledger ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lastNewline = raw.lastIndexOf(0x0a);
  const hasTrailingNewline = lastNewline === raw.length - 1;
  const completeRaw = hasTrailingNewline ? raw : raw.subarray(0, lastNewline + 1);
  const trailingFragment = hasTrailingNewline ? Buffer.alloc(0) : raw.subarray(lastNewline + 1);
  const completeLines = completeRaw.toString('utf8').split(/\r?\n/);
  const entries = completeLines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) => parseRunLedgerEntry(line, lineNumber, runId));
  if (trailingFragment.length === 0) return { entries };

  const trailingText = trailingFragment.toString('utf8');
  try {
    JSON.parse(trailingText);
  } catch (error) {
    if (isIncompleteJsonPrefix(trailingText)) return { entries, skippedTrailingBytes: trailingFragment.length };
    throw new Error(`invalid run ledger JSON at line ${completeLines.length}: ${error instanceof Error ? error.message : String(error)}`);
  }
  entries.push(parseRunLedgerEntry(trailingText, completeLines.length, runId));
  return { entries };
}

/** Returns null only when the ledger file does not exist; malformed complete records and unreadable ledgers throw. */
export function loadRunLedger(runId: string, dir = runLedgerDir(), read: RunLedgerReader = readFileSync): RunLedgerEntry[] | null {
  return loadRunLedgerWithMetadata(runId, dir, read)?.entries ?? null;
}

/** A self-implement run projected onto a mission timeline through its producer-recorded goalId. */
export interface RunLedgerTimelineEntry {
  runId: string;
  /** Timestamp of the producer's explicit `start` event; later review and rework events never move execution placement. */
  executedAt: string;
  orchestrationId?: string;
  shardId?: string;
  pieceIndex?: number;
  pieceTotal?: number;
}

export interface RunLedgerTimelineQueryOptions {
  dir?: string;
  read?: RunLedgerReader;
  list?: (path: string) => string[];
}

/**
 * Read runs whose sole recorded goalId equals the historian missionId.
 * goalId is chosen because the producer already persists it on each observer event, while orchestrationId only groups shards.
 */
export function queryRunLedgerTimeline(missionId: string, options: RunLedgerTimelineQueryOptions = {}): RunLedgerTimelineEntry[] {
  const dir = resolve(options.dir ?? runLedgerDir());
  const list = options.list ?? readdirSync;
  let fileNames: string[];
  try {
    fileNames = list(dir);
  } catch {
    return [];
  }
  const entries: RunLedgerTimelineEntry[] = [];
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    try {
      const ledger = loadRunLedger(runId, dir, options.read);
      if (!ledger) continue;
      const goalIds = new Set(ledger.flatMap((entry) => entry.goalId ? [entry.goalId] : []));
      if (goalIds.size !== 1 || !goalIds.has(missionId)) continue;
      const execution = ledger.find((entry) => entry.event === 'start'
        && typeof entry.timestamp === 'string'
        && Number.isFinite(Date.parse(entry.timestamp)));
      if (!execution?.timestamp) continue;
      entries.push({
        runId,
        executedAt: execution.timestamp,
        ...(execution.orchestrationId === undefined ? {} : { orchestrationId: execution.orchestrationId }),
        ...(execution.shardId === undefined ? {} : { shardId: execution.shardId }),
        ...(execution.pieceIndex === undefined ? {} : { pieceIndex: execution.pieceIndex }),
        ...(execution.pieceTotal === undefined ? {} : { pieceTotal: execution.pieceTotal }),
      });
    } catch {
      // A corrupt or concurrently replaced ledger must not leak a partial run into another mission timeline.
    }
  }
  return entries.sort((left, right) => Date.parse(left.executedAt) - Date.parse(right.executedAt) || left.runId.localeCompare(right.runId));
}

export interface GoalSourceDistributionQuery {
  ledgerDirectory: string;
  runCount: number;
  authoredGoalFileCount: number;
  naturalLanguageDispatchCount: number;
  noGoalFileCount: number;
  goalSourceMissingCount: number;
  unreadableLedgerCount: number;
  ledgerDirectoryMissing: boolean;
  scope: 'self-implement-run-ledger';
  note: string;
}

export interface GoalSourceDistributionQueryOptions {
  dir?: string;
  read?: RunLedgerReader;
  list?: (path: string) => string[];
}

const GOAL_SOURCE_DISTRIBUTION_NOTE = 'Read-only scan of canonical JSONL run ledgers. Every discovered canonical ledger counts as a run; unreadable ledgers are reported separately. Each readable ledger contributes once according to its first start event, and only an absent goalSource counts as missing.';

/** Read canonical JSONL run ledgers and count their declared start-event goal sources without changing any store. */
export function queryGoalSourceDistribution(options: GoalSourceDistributionQueryOptions = {}): GoalSourceDistributionQuery {
  const dir = resolve(options.dir ?? runLedgerDir());
  const list = options.list ?? readdirSync;
  let fileNames: string[];
  try {
    fileNames = list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ledgerDirectory: dir,
        runCount: 0,
        authoredGoalFileCount: 0,
        naturalLanguageDispatchCount: 0,
        noGoalFileCount: 0,
        goalSourceMissingCount: 0,
        unreadableLedgerCount: 0,
        ledgerDirectoryMissing: true,
        scope: 'self-implement-run-ledger',
        note: GOAL_SOURCE_DISTRIBUTION_NOTE,
      };
    }
    throw error;
  }

  let runCount = 0;
  let authoredGoalFileCount = 0;
  let naturalLanguageDispatchCount = 0;
  let noGoalFileCount = 0;
  let goalSourceMissingCount = 0;
  let unreadableLedgerCount = 0;
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    runCount += 1;
    let ledger: RunLedgerEntry[] | null;
    try {
      ledger = loadRunLedger(runId, dir, options.read);
    } catch {
      unreadableLedgerCount += 1;
      continue;
    }
    if (ledger === null) {
      unreadableLedgerCount += 1;
      continue;
    }
    const goalSource = ledger.find((entry) => entry.event === 'start')?.data.goalSource;
    if (goalSource === 'authored-goal-file') authoredGoalFileCount += 1;
    else if (goalSource === 'natural-language-dispatch') naturalLanguageDispatchCount += 1;
    else if (goalSource === 'no-goal-file') noGoalFileCount += 1;
    else if (goalSource === undefined) goalSourceMissingCount += 1;
  }
  return {
    ledgerDirectory: dir,
    runCount,
    authoredGoalFileCount,
    naturalLanguageDispatchCount,
    noGoalFileCount,
    goalSourceMissingCount,
    unreadableLedgerCount,
    ledgerDirectoryMissing: false,
    scope: 'self-implement-run-ledger',
    note: GOAL_SOURCE_DISTRIBUTION_NOTE,
  };
}

export function renderGoalSourceDistribution(query: GoalSourceDistributionQuery): string {
  return [
    `ledger directory: ${query.ledgerDirectory}`,
    `runs: ${query.runCount}`,
    `authored-goal-file: ${query.authoredGoalFileCount}`,
    `natural-language-dispatch: ${query.naturalLanguageDispatchCount}`,
    `no-goal-file: ${query.noGoalFileCount}`,
    `goalSource missing: ${query.goalSourceMissingCount}`,
    `unreadable ledgers: ${query.unreadableLedgerCount}`,
    `ledger directory missing: ${query.ledgerDirectoryMissing}`,
    `note: ${query.note}`,
  ].join('\n');
}

export type InterruptedRunLedgerStatus = 'interrupted' | 'interruption-status-unknown' | 'ledger-unreadable';

/**
 * A terminal run is interrupted only when its own recorded rework budget says
 * UNCONVERGEABLE. A terminal ledger whose latest rework verdict is absent or
 * unusable remains observable as unknown; an explicit non-interruption verdict
 * is excluded rather than silently reclassified as unknown.
 */
export interface InterruptedRunLedgerEntry {
  runId: string;
  status: InterruptedRunLedgerStatus;
  terminal: RunLedgerEntry | null;
  interruptionVerdict: string | null;
  interruptionReason: string | null;
  reworkRound: number | null;
  reworkBudgetEntries: readonly RunLedgerEntry[];
  /** The already-read source ledger, retained for consumers that need recorded event values. */
  ledgerEntries: readonly RunLedgerEntry[];
  undeliveredSupervisorRepairEntries: readonly RunLedgerEntry[];
  decompositionEntries: readonly RunLedgerEntry[];
}

export interface InterruptedRunLedgerQuery {
  entries: readonly InterruptedRunLedgerEntry[];
  /** Terminal run facts collected during the same ledger scan for retry correlation. */
  terminalRuns: readonly { runId: string; runStatus: string; goalId: string | null; timestamp: string | null }[];
  ledgerDirectory: string;
  unreadableLedgerCount: number;
  ledgerDirectoryMissing: boolean;
  scope: 'self-implement-run-ledger-interrupted';
  note: string;
}

export interface InterruptedRunLedgerQueryOptions {
  dir?: string;
  read?: RunLedgerReader;
  list?: (path: string) => string[];
}

const INTERRUPTED_RUN_LEDGER_NOTE = 'Read-only scan of terminal run ledgers. A run is interrupted only when its recorded rework-budget verdict is UNCONVERGEABLE; missing or unusable rework verdicts remain interruption-status-unknown, explicit non-interruption verdicts are excluded, and unreadable ledgers remain distinct from an empty result.';

const REWORK_BUDGET_VERDICTS = new Set(['CONTINUE', 'UNCONVERGEABLE']);

function terminalRunStatusEntry(ledger: readonly RunLedgerEntry[]): RunLedgerEntry | null {
  return [...ledger].reverse().find((entry) => entry.event === 'run-status' && isRunStatus(entry.data.runStatus)) ?? null;
}

function recordsUndeliveredSupervisorRepair(entry: RunLedgerEntry): boolean {
  if (entry.event !== 'rework-blocked-draft-pr' || !Array.isArray(entry.data.undeliveredSupervisorInputs)) return false;
  return entry.data.undeliveredSupervisorInputs.some((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const record = input as Record<string, unknown>;
    return typeof record.text === 'string' && record.text.trim().length > 0 && typeof record.reason === 'string' && record.reason.trim().length > 0;
  });
}

function interruptedRunLedgerEntry(runId: string, ledger: readonly RunLedgerEntry[]): InterruptedRunLedgerEntry | null {
  const terminal = terminalRunStatusEntry(ledger);
  if (!terminal || terminal.data.runStatus !== 'failed') return null;
  const reworkBudgetEntries = ledger.filter((entry) => entry.event === 'rework-budget');
  const latestReworkBudget = reworkBudgetEntries.at(-1);
  const recordedVerdict = typeof latestReworkBudget?.data.verdict === 'string' ? latestReworkBudget.data.verdict : null;
  const verdict = recordedVerdict !== null && REWORK_BUDGET_VERDICTS.has(recordedVerdict) ? recordedVerdict : null;
  if (verdict === 'CONTINUE') return null;
  return {
    runId,
    status: verdict === 'UNCONVERGEABLE' ? 'interrupted' : 'interruption-status-unknown',
    terminal,
    interruptionVerdict: verdict,
    interruptionReason: typeof latestReworkBudget?.data.reason === 'string' ? latestReworkBudget.data.reason : null,
    reworkRound: typeof latestReworkBudget?.data.round === 'number' && Number.isFinite(latestReworkBudget.data.round) ? latestReworkBudget.data.round : null,
    reworkBudgetEntries,
    ledgerEntries: ledger,
    undeliveredSupervisorRepairEntries: ledger.filter(recordsUndeliveredSupervisorRepair),
    decompositionEntries: ledger.filter((entry) => entry.event === 'decomposition-shadow' || entry.event === 'decomposition-shadow-goals'),
  };
}

/** Read terminal interruption records without modifying a run, ledger, or producer path. */
export function queryInterruptedRunLedgers(options: InterruptedRunLedgerQueryOptions = {}): InterruptedRunLedgerQuery {
  const ledgerDirectory = resolve(options.dir ?? runLedgerDir());
  const list = options.list ?? readdirSync;
  let fileNames: string[];
  try {
    fileNames = list(ledgerDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], terminalRuns: [], ledgerDirectory, unreadableLedgerCount: 0, ledgerDirectoryMissing: true, scope: 'self-implement-run-ledger-interrupted', note: INTERRUPTED_RUN_LEDGER_NOTE };
    }
    throw error;
  }
  const entries: InterruptedRunLedgerEntry[] = [];
  const terminalRuns: { runId: string; runStatus: string; goalId: string | null; timestamp: string | null }[] = [];
  let unreadableLedgerCount = 0;
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    let ledger: RunLedgerEntry[] | null;
    try {
      ledger = loadRunLedger(runId, ledgerDirectory, options.read);
    } catch {
      ledger = null;
    }
    if (ledger === null) {
      unreadableLedgerCount += 1;
      entries.push({ runId, status: 'ledger-unreadable', terminal: null, interruptionVerdict: null, interruptionReason: null, reworkRound: null, reworkBudgetEntries: [], ledgerEntries: [], undeliveredSupervisorRepairEntries: [], decompositionEntries: [] });
      continue;
    }
    const terminal = terminalRunStatusEntry(ledger);
    if (terminal) {
      const goalIds = new Set(ledger.flatMap((entry) => typeof entry.goalId === 'string' && entry.goalId.trim() ? [entry.goalId] : []));
      terminalRuns.push({ runId, runStatus: String(terminal.data.runStatus), goalId: goalIds.size === 1 ? [...goalIds][0] : null, timestamp: terminal.timestamp ?? null });
    }
    const entry = interruptedRunLedgerEntry(runId, ledger);
    if (entry) entries.push(entry);
  }
  entries.sort((left, right) => left.runId.localeCompare(right.runId));
  terminalRuns.sort((left, right) => left.runId.localeCompare(right.runId));
  return { entries, terminalRuns, ledgerDirectory, unreadableLedgerCount, ledgerDirectoryMissing: false, scope: 'self-implement-run-ledger-interrupted', note: INTERRUPTED_RUN_LEDGER_NOTE };
}

export interface FederatedInterruptedRunLedgerEntry extends InterruptedRunLedgerEntry {
  ledgerDirectory: string;
}

export interface FederatedInterruptedRunLedgerQuery {
  entries: readonly FederatedInterruptedRunLedgerEntry[];
  /** 요청한 상한. 반환 행 수가 이 값에 닿으면 소비자는 전체 조회가 아님을 안다. */
  limit?: number;
  /** 단일 경로 범위 조회의 호환 표면. */
  pathFilter?: string;
  /** 다중 경로 범위 조회일 때 요청한 중복 없는 경로 집합. */
  pathFilters?: readonly string[];
  /** 경로 범위 조회일 때 범위에서 제한 전 일치한 행 수. */
  matchingPathCount?: number;
  ledgerDirectories: readonly string[];
  unreadableLedgerCount: number;
  /** 원장은 읽혔으나 start.goalFile 이 가리키는 문서가 지금 없다. 원장 판독 불가와 다른 수다. */
  goalDocumentMissingCount: number;
  unreadableLedgerDirectoryCount: number;
  missingLedgerDirectoryCount: number;
  unreadableLedgerDirectoryAccessCount: number;
  indeterminateLedgerDirectoryCount: number;
  scope: 'self-implement-run-ledger-interrupted-federated';
  note: string;
}

export interface FederatedInterruptedRunLedgerQueryOptions extends Pick<FederatedRunLedgerLookupOptions, 'includeTest' | 'targets'> {
  /** 최대 반환 행 수. 상한 도달 사실은 `limit`으로 소비자에게 보존한다. */
  limit?: number;
  /** 있을 때만 원장 목표 문서의 traced path가 일치하는 행에 상한을 적용한다. */
  path?: string;
  /** 다중 경로 조회는 어느 한 traced path라도 일치하는 행에 한 번만 상한을 적용한다. */
  paths?: readonly string[];
  /** 테스트와 복구 가능한 원장 재판독을 위한 선택적 리더. */
  read?: RunLedgerReader;
}

type LedgerPathMatch = boolean | 'unreadable' | 'goal-document-missing';

/** 경로 일치 여부. 원장 판독 실패와 «가리키는 골 문서가 없음»은 다른 값이다. 이름 없는 goalFile 은 불일치. */
function ledgerMatchesPaths(runId: string, ledgerDirectory: string, paths: readonly string[], read?: RunLedgerReader): LedgerPathMatch {
  let ledger: RunLedgerEntry[] | null;
  try {
    ledger = loadRunLedger(runId, ledgerDirectory, read);
  } catch {
    return 'unreadable';
  }
  if (ledger === null) return 'unreadable';
  const goalFile = ledgerGoalDocument(ledger);
  if (goalFile === null) return false;
  const reader = read ?? readFileSync;
  let document: string | Buffer;
  try {
    document = reader(goalFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'goal-document-missing';
    return 'unreadable';
  }
  const text = typeof document === 'string' ? document : document.toString('utf8');
  const requestedPaths = new Set(paths);
  return tracedPathReferences(text).some((reference) => requestedPaths.has(reference.path));
}

/** Read terminal interruption records across the existing --all/--include-test target policy. */
export function queryFederatedInterruptedRunLedgers(options: FederatedInterruptedRunLedgerQueryOptions = {}): FederatedInterruptedRunLedgerQuery {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new Error(`federated interrupted-run limit must be a positive safe integer: ${String(options.limit)}`);
  }
  const entries: FederatedInterruptedRunLedgerEntry[] = [];
  const ledgerDirectories: string[] = [];
  let unreadableLedgerCount = 0;
  let goalDocumentMissingCount = 0;
  let missingLedgerDirectoryCount = 0;
  let unreadableLedgerDirectoryAccessCount = 0;
  let indeterminateLedgerDirectoryCount = 0;
  for (const ledgerDirectory of resolveFederatedRunLedgerDirectories(options)) {
    try {
      const result = queryInterruptedRunLedgers({ dir: ledgerDirectory, read: options.read });
      if (result.ledgerDirectoryMissing) {
        missingLedgerDirectoryCount += 1;
        continue;
      }
      ledgerDirectories.push(ledgerDirectory);
      unreadableLedgerCount += result.unreadableLedgerCount;
      entries.push(...result.entries.map((entry) => ({ ...entry, ledgerDirectory })));
    } catch (error) {
      const failure = classifyFederatedLedgerDirectoryReadFailure(error);
      if (failure === 'unreadable') unreadableLedgerDirectoryAccessCount += 1;
      else if (failure === 'indeterminate') indeterminateLedgerDirectoryCount += 1;
      else missingLedgerDirectoryCount += 1;
    }
  }
  const pathFilters = options.paths === undefined
    ? options.path === undefined ? undefined : [options.path]
    : [...new Set(options.paths)];
  const scopedEntries = pathFilters === undefined ? entries : entries.filter((entry) => {
    if (entry.status === 'ledger-unreadable') return false;
    const matches = ledgerMatchesPaths(entry.runId, entry.ledgerDirectory, pathFilters, options.read);
    if (matches === 'unreadable') unreadableLedgerCount += 1;
    else if (matches === 'goal-document-missing') goalDocumentMissingCount += 1;
    return matches === true;
  });
  scopedEntries.sort((left, right) => left.ledgerDirectory.localeCompare(right.ledgerDirectory) || left.runId.localeCompare(right.runId));
  const limit = options.limit;
  const limitedEntries = typeof limit === 'number' ? scopedEntries.slice(0, limit) : scopedEntries;
  const unreadableLedgerDirectoryCount = missingLedgerDirectoryCount + unreadableLedgerDirectoryAccessCount + indeterminateLedgerDirectoryCount;
  return {
    entries: limitedEntries,
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(pathFilters === undefined ? {} : {
      ...(pathFilters.length === 1 ? { pathFilter: pathFilters[0]! } : { pathFilters }),
      matchingPathCount: scopedEntries.length,
    }),
    ledgerDirectories,
    unreadableLedgerCount,
    goalDocumentMissingCount,
    unreadableLedgerDirectoryCount,
    missingLedgerDirectoryCount,
    unreadableLedgerDirectoryAccessCount,
    indeterminateLedgerDirectoryCount,
    scope: 'self-implement-run-ledger-interrupted-federated',
    note: INTERRUPTED_RUN_LEDGER_NOTE,
  };
}

export interface CompletedRunLedgerEntry {
  runId: string;
  terminal: RunLedgerEntry;
}

export interface CompletedRunLedgerQuery {
  entries: readonly CompletedRunLedgerEntry[];
  ledgerDirectory: string;
  unreadableLedgerCount: number;
  ledgerDirectoryMissing: boolean;
  scope: 'self-implement-run-ledger-completed';
  note: string;
}

export interface CompletedRunLedgerQueryOptions {
  dir?: string;
  read?: RunLedgerReader;
  list?: (path: string) => string[];
}

const COMPLETED_RUN_LEDGER_NOTE = 'Read-only scan of canonical run ledgers whose latest valid run-status is completed. Unreadable ledgers remain distinct from an empty result.';

/** Read completed terminal records without modifying a run, ledger, or producer path. */
export function queryCompletedRunLedgers(options: CompletedRunLedgerQueryOptions = {}): CompletedRunLedgerQuery {
  const ledgerDirectory = resolve(options.dir ?? runLedgerDir());
  const list = options.list ?? readdirSync;
  let fileNames: string[];
  try {
    fileNames = list(ledgerDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], ledgerDirectory, unreadableLedgerCount: 0, ledgerDirectoryMissing: true, scope: 'self-implement-run-ledger-completed', note: COMPLETED_RUN_LEDGER_NOTE };
    }
    throw error;
  }
  const entries: CompletedRunLedgerEntry[] = [];
  let unreadableLedgerCount = 0;
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    try {
      const ledger = loadRunLedger(runId, ledgerDirectory, options.read);
      if (ledger === null) {
        unreadableLedgerCount += 1;
        continue;
      }
      const terminal = terminalRunStatusEntry(ledger);
      if (terminal?.data.runStatus === 'completed') entries.push({ runId, terminal });
    } catch {
      unreadableLedgerCount += 1;
    }
  }
  entries.sort((left, right) => left.runId.localeCompare(right.runId));
  return { entries, ledgerDirectory, unreadableLedgerCount, ledgerDirectoryMissing: false, scope: 'self-implement-run-ledger-completed', note: COMPLETED_RUN_LEDGER_NOTE };
}

export interface FederatedCompletedRunLedgerEntry extends CompletedRunLedgerEntry {
  ledgerDirectory: string;
}

export interface FederatedCompletedRunLedgerQuery {
  entries: readonly FederatedCompletedRunLedgerEntry[];
  limit?: number;
  /** 원시 연합 조회가 상한에 닿았는지. 소비자가 후속 경로 추출 실패와 구별한다. */
  truncated?: boolean;
  /** 단일 경로 범위 조회의 호환 표면. */
  pathFilter?: string;
  /** 다중 경로 범위 조회일 때 요청한 중복 없는 경로 집합. */
  pathFilters?: readonly string[];
  /** 경로 범위 조회일 때 범위에서 제한 전 일치한 행 수. */
  matchingPathCount?: number;
  ledgerDirectories: readonly string[];
  unreadableLedgerCount: number;
  /** 원장은 읽혔으나 start.goalFile 이 가리키는 문서가 지금 없다. 원장 판독 불가와 다른 수다. */
  goalDocumentMissingCount: number;
  unreadableLedgerDirectoryCount: number;
  missingLedgerDirectoryCount: number;
  unreadableLedgerDirectoryAccessCount: number;
  indeterminateLedgerDirectoryCount: number;
  scope: 'self-implement-run-ledger-completed-federated';
  note: string;
}

export interface FederatedCompletedRunLedgerQueryOptions extends Pick<FederatedRunLedgerLookupOptions, 'includeTest' | 'targets'> {
  limit?: number;
  /** 있을 때만 원장 목표 문서의 traced path가 일치하는 행에 상한을 적용한다. */
  path?: string;
  /** 다중 경로 조회는 어느 한 traced path라도 일치하는 행에 한 번만 상한을 적용한다. */
  paths?: readonly string[];
  /** 테스트와 복구 가능한 원장 재판독을 위한 선택적 리더. */
  read?: RunLedgerReader;
}

/** Read completed terminal records across the existing --all/--include-test target policy. */
export function queryFederatedCompletedRunLedgers(options: FederatedCompletedRunLedgerQueryOptions = {}): FederatedCompletedRunLedgerQuery {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new Error(`federated completed-run limit must be a positive safe integer: ${String(options.limit)}`);
  }
  const entries: FederatedCompletedRunLedgerEntry[] = [];
  const ledgerDirectories: string[] = [];
  let unreadableLedgerCount = 0;
  let goalDocumentMissingCount = 0;
  let missingLedgerDirectoryCount = 0;
  let unreadableLedgerDirectoryAccessCount = 0;
  let indeterminateLedgerDirectoryCount = 0;
  for (const ledgerDirectory of resolveFederatedRunLedgerDirectories(options)) {
    try {
      const result = queryCompletedRunLedgers({ dir: ledgerDirectory, read: options.read });
      if (result.ledgerDirectoryMissing) {
        missingLedgerDirectoryCount += 1;
        continue;
      }
      ledgerDirectories.push(ledgerDirectory);
      unreadableLedgerCount += result.unreadableLedgerCount;
      entries.push(...result.entries.map((entry) => ({ ...entry, ledgerDirectory })));
    } catch (error) {
      const failure = classifyFederatedLedgerDirectoryReadFailure(error);
      if (failure === 'unreadable') unreadableLedgerDirectoryAccessCount += 1;
      else if (failure === 'indeterminate') indeterminateLedgerDirectoryCount += 1;
      else missingLedgerDirectoryCount += 1;
    }
  }
  const pathFilters = options.paths === undefined
    ? options.path === undefined ? undefined : [options.path]
    : [...new Set(options.paths)];
  const scopedEntries = pathFilters === undefined ? entries : entries.filter((entry) => {
    const matches = ledgerMatchesPaths(entry.runId, entry.ledgerDirectory, pathFilters, options.read);
    if (matches === 'unreadable') unreadableLedgerCount += 1;
    else if (matches === 'goal-document-missing') goalDocumentMissingCount += 1;
    return matches === true;
  });
  scopedEntries.sort((left, right) => left.ledgerDirectory.localeCompare(right.ledgerDirectory) || left.runId.localeCompare(right.runId));
  const limit = options.limit;
  const truncated = typeof limit === 'number' && scopedEntries.length >= limit;
  const limitedEntries = typeof limit === 'number' ? scopedEntries.slice(0, limit) : scopedEntries;
  const unreadableLedgerDirectoryCount = missingLedgerDirectoryCount + unreadableLedgerDirectoryAccessCount + indeterminateLedgerDirectoryCount;
  return {
    entries: limitedEntries,
    ...(typeof limit === 'number' ? { limit, truncated } : {}),
    ...(pathFilters === undefined ? {} : {
      ...(pathFilters.length === 1 ? { pathFilter: pathFilters[0]! } : { pathFilters }),
      matchingPathCount: scopedEntries.length,
    }),
    ledgerDirectories,
    unreadableLedgerCount,
    goalDocumentMissingCount,
    unreadableLedgerDirectoryCount,
    missingLedgerDirectoryCount,
    unreadableLedgerDirectoryAccessCount,
    indeterminateLedgerDirectoryCount,
    scope: 'self-implement-run-ledger-completed-federated',
    note: COMPLETED_RUN_LEDGER_NOTE,
  };
}

export type UnfinishedRunLedgerStatus = 'terminal-status-missing' | 'ledger-unreadable';
export type PlannedPathStatus = 'found-ledger-goal-file' | 'found-branch-fallback' | 'branch-missing' | 'goal-document-not-found' | 'goal-document-ambiguous' | 'goal-directory-unreadable' | 'goal-document-unreadable' | 'no-traced-paths' | 'unknown';
/** Declared ask targets remain distinct from traced grounding references and never narrow them. */
export type DeclaredPathStatus = 'found' | 'no-declared-paths' | 'label-missing' | 'original-ask-missing' | 'goal-document-unreadable' | 'unknown';
export type UnfinishedRunPathMatchReason = 'declared' | 'traced' | 'both';
export type LastActivityStatus = 'available' | 'timestamp-missing' | 'timestamp-invalid' | 'ledger-unreadable';

export interface UnfinishedRunLedgerEntry {
  runId: string;
  branch: string | null;
  status: UnfinishedRunLedgerStatus;
  /** Grounding evidence paths; preserved under its existing compatibility name. */
  plannedPaths: readonly string[];
  plannedPathStatus: PlannedPathStatus;
  /** Targets declared in the goal's verbatim ask, independent from grounding references. */
  declaredPaths: readonly string[];
  declaredPathStatus: DeclaredPathStatus;
  /** Union of declared and traced paths, with the axis that caused each path to match. */
  pathMatchReasons: Readonly<Record<string, UnfinishedRunPathMatchReason>>;
  goalDocumentPath: string | null;
  /** Produced by ledger queries; optional for existing callers constructing projected entries. */
  goalLookupBasis?: 'ledger-target' | 'caller-cwd';
  /** Directory searched only when branch-suffix fallback was used. */
  goalDocumentSearchDirectory: string | null;
  lastActivityTimestamp: string | null;
  lastActivityAgeMs: number | null;
  lastActivityStatus: LastActivityStatus;
  /** ⭐ 「남은 것」을 «가려» 보여 주는 등급 — 종전엔 이 조회가 한 값뿐이라 회고에서 못 갈랐다. */
  lifecycle: UnfinishedRunLifecycle;
}

export interface UnfinishedRunLedgerQuery {
  entries: readonly UnfinishedRunLedgerEntry[];
  ledgerDirectory: string;
  goalsDirectory: string;
  unreadableLedgerCount: number;
  ledgerDirectoryMissing: boolean;
  /** Ledgers the last-line rule would miss and the trailing-bookkeeping rule counts as terminal. */
  terminalByTrailingRunStatus?: number;
  cacheHits?: number;
  cacheMisses?: number;
  pathFilter?: string;
  matchingPathCount?: number;
  unknownPathCount?: number;
  scope: 'self-implement-run-ledger';
  note: string;
}

export interface UnfinishedRunLedgerQueryOptions {
  dir?: string;
  goalsDir?: string;
  path?: string;
  read?: RunLedgerReader;
  list?: (path: string) => string[];
  noCache?: boolean;
  /** ⛔ 「도는 중」으로 볼 마지막 활동 나이(ms). 호출자가 준다 — 이 모듈이 새 수를 정하지 않는다. */
  liveWindowMs?: number;
}

const UNFINISHED_RUN_LEDGER_NOTE = 'Read-only scan of the specified run-ledger directory. A terminal-status-missing ledger is not the same as an unreadable ledger; planned paths are extracted only from a goal document matched by the final hyphen-separated branch segment.';

function branchFromLedger(ledger: readonly RunLedgerEntry[]): string | null {
  for (const entry of [...ledger].reverse()) {
    if (typeof entry.data.branch === 'string') return entry.data.branch;
  }
  return null;
}

type GoalDocumentLookup =
  | { status: 'found'; path: string }
  | { status: 'branch-missing' }
  | { status: 'not-found' }
  | { status: 'ambiguous-match' }
  | { status: 'directory-unreadable' };

function goalFileSuffix(fileName: string): string | null {
  if (!fileName.startsWith('GOAL-') || !fileName.endsWith('.txt')) return null;
  const datedStem = fileName.slice('GOAL-'.length, -'.txt'.length).match(/^(.*)-\d{4}-\d{2}-\d{2}$/)?.[1];
  return datedStem?.split('-').at(-1) ?? null;
}

function goalDocumentForBranch(branch: string | null, goalsDir: string, list: (path: string) => string[]): GoalDocumentLookup {
  if (!branch) return { status: 'branch-missing' };
  const suffix = branch.split('-').at(-1);
  if (!suffix) return { status: 'not-found' };
  let matches: string[];
  try {
    matches = list(goalsDir).filter((fileName) => goalFileSuffix(fileName) === suffix);
  } catch {
    return { status: 'directory-unreadable' };
  }
  if (matches.length === 0) return { status: 'not-found' };
  if (matches.length > 1) return { status: 'ambiguous-match' };
  return { status: 'found', path: join(goalsDir, matches[0]!) };
}

// self-implement/orchestrator.ts writes canonical `run-status`; harness/staged-harness.ts and
// harness/harness-membrane.ts write `terminal`, so readers accept both while preserving their distinction below.
function terminalRunStatusWasSuperseded(ledger: readonly RunLedgerEntry[]): boolean {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (entry.event === 'run-status' && isRunStatus(entry.data.runStatus)) {
      return ledger.slice(index + 1).some((later) => later.event === 'start');
    }
  }
  return false;
}

function hasCanonicalRunStatus(ledger: readonly RunLedgerEntry[]): boolean {
  return ledger.some((entry) => entry.event === 'run-status' && isRunStatus(entry.data.runStatus));
}

/** Events that may follow a terminal run-status without reopening the run. Anything else stays unfinished. */
export const TRAILING_BOOKKEEPING_EVENTS = ['pipeline-traversal-shadow', 'run-rollup', 'progress-delivery', 'progress-delivery-outcome'] as const;

const TRAILING_BOOKKEEPING_EVENT_SET = new Set<string>(TRAILING_BOOKKEEPING_EVENTS);

function lastValidRunStatusIndex(ledger: readonly RunLedgerEntry[]): number {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (entry.event === 'run-status' && isRunStatus(entry.data.runStatus)) return index;
  }
  return -1;
}

/** True when the last line is itself a valid run-status (the previous terminator). */
function lastLineIsValidRunStatus(ledger: readonly RunLedgerEntry[]): boolean {
  const lastEntry = ledger.at(-1);
  return lastEntry?.event === 'run-status' && isRunStatus(lastEntry.data.runStatus);
}

/**
 * Terminal when the last valid run-status is followed only by trailing bookkeeping,
 * or when a `terminal` / `human-stop` event is present anywhere.
 * A later event outside the bookkeeping list keeps the run unfinished.
 */
export function hasTerminalRunStatus(ledger: readonly RunLedgerEntry[]): boolean {
  const statusIndex = lastValidRunStatusIndex(ledger);
  const trailingOnly = statusIndex >= 0
    && ledger.slice(statusIndex + 1).every((entry) => TRAILING_BOOKKEEPING_EVENT_SET.has(entry.event));
  return trailingOnly
    || hasNonCanonicalTerminalEvent(ledger)
    || hasHumanStopEvent(ledger);
}

/** Last-line rule would miss this ledger, but the trailing-bookkeeping rule counts it terminal. */
function isTerminalOnlyByTrailingRunStatus(ledger: readonly RunLedgerEntry[]): boolean {
  return hasTerminalRunStatus(ledger) && !lastLineIsValidRunStatus(ledger)
    && !hasNonCanonicalTerminalEvent(ledger)
    && !hasHumanStopEvent(ledger);
}

/** ⛔⭐⭐⭐ 미완 항목의 «상태» — 종전엔 이 조회가 낸 것이 «한 값»(`terminal-status-missing`)뿐이었다.
 *  📏 2026-08-11 실측: 그 한 값 안에 서로 «다른 것»이 섞여 있었다 —
 *     실제로 도는 것 2 · 오래 전에 죽은 잔해 51(중앙 5.2일) · 종료를 «다른 이름»으로 적은 것 5.
 *  ⇒ 회고할 때 「무엇이 내 찌꺼기인가」를 이 산출로 가릴 수 없었다(대표: *"쉽게 판별 못 하면 설계 문제"*).
 *  ⭐ 등급 이름은 `harness worktrees` 의 사다리와 «같은 결»로 둔다 — 특히 `unjudgeable` 은 그대로 쓴다
 *    (사람이 두 어휘를 배우지 않게 · 「모른다」를 별도 등급으로 두는 그 자리가 이 저장소의 규율이다).
 *  ⛔ 이것은 «판별»이다 — 지우지 않고, 종결을 «쓰지도» 않는다(종결은 원장 축의 몫). */
export type UnfinishedRunLifecycle =
  /** 마지막 활동이 임계 «안» — 진짜 도는 중일 수 있다. */
  | 'live'
  /** 활동이 임계를 크게 넘겼고 어느 어휘로도 종결이 없다 — 죽었는데 아무도 안 적었다. */
  | 'orphaned'
  /** 사람이 중지를 기록했다 — 활동 나이와 무관하게 도는 중으로 세지 않는다. */
  | 'human-stopped'
  /** 종료를 «다른 이름»으로 적었다 — `terminal` 이벤트는 있는데 탐지기가 보는 `runStatus` 가 없다. */
  | 'terminal-other-vocabulary'
  /** Canonical run-status was followed by later ledger activity, so it is evidence rather than the ledger terminator. */
  | 'terminal-run-status-superseded'
  /** 원장을 못 읽었거나 나이를 몰라 «판정할 수 없다». ⛔ 위 셋 어디에도 섞지 않는다. */
  | 'unjudgeable';

export const TERMINATED_UNFINISHED_LIFECYCLES: ReadonlySet<UnfinishedRunLifecycle> = new Set([
  'human-stopped',
  'terminal-other-vocabulary',
  'terminal-run-status-superseded',
]);

export function isTerminatedUnfinishedLifecycle(lifecycle: UnfinishedRunLifecycle | undefined): boolean {
  return lifecycle !== undefined && TERMINATED_UNFINISHED_LIFECYCLES.has(lifecycle);
}

/** ⛔ 「종료를 뜻하는 다른 이름」이 있나 — 이 층은 그것을 «고치지» 않고 «말한다».
 *  📏 실측 문면: `{"event":"terminal","data":{"terminal":"escalated","ok":false,…}}` */
function hasNonCanonicalTerminalEvent(ledger: readonly RunLedgerEntry[]): boolean {
  return ledger.some((entry) => entry.event === 'terminal');
}

function hasHumanStopEvent(ledger: readonly RunLedgerEntry[]): boolean {
  return ledger.some((entry) => entry.event === 'human-stop');
}

/** ⛔ 임계는 호출자가 준다 — 이 모듈이 「최근」의 뜻을 새로 정하지 않는다. */
export const DEFAULT_UNFINISHED_LIVE_WINDOW_MS = 30 * 60_000;

export function classifyUnfinishedLifecycle(
  ledger: readonly RunLedgerEntry[],
  lastActivityAgeMs: number | null,
  liveWindowMs: number,
): UnfinishedRunLifecycle {
  // ⛔ 순서가 뜻을 가진다 — 종료성 어휘가 「오래됐다」보다 «먼저»다.
  //   그러지 않으면 중지를 적은 런이 나이 때문에 `live` 또는 `orphaned` 로 잘못 세어진다.
  if (hasHumanStopEvent(ledger)) return 'human-stopped';
  if (hasNonCanonicalTerminalEvent(ledger)) return 'terminal-other-vocabulary';
  if (hasCanonicalRunStatus(ledger) && !terminalRunStatusWasSuperseded(ledger)) return 'terminal-run-status-superseded';
  if (lastActivityAgeMs === null) return 'unjudgeable';
  return lastActivityAgeMs <= liveWindowMs ? 'live' : 'orphaned';
}

/** Reuses the conservative disposition vocabulary of the worktree axis without joining its implementation. */
export type RunLedgerDisposition = 'reclaim-safe' | 'needs-human' | 'do-not-touch' | 'unjudgeable';

export interface RunLedgerDispositionAssessment {
  entry: UnfinishedRunLedgerEntry;
  disposition: RunLedgerDisposition;
}

export interface RunLedgerCleanupOptions {
  /** The caller supplies the age threshold; this module does not define what counts as recent. */
  liveWindowMs: number;
  /** Defaults to false so planning never mutates a ledger directory accidentally. */
  remove?: boolean;
  dir?: string;
  list?: (path: string) => string[];
  read?: RunLedgerReader;
  unlink?: (path: string) => void;
}

export interface RunLedgerCleanupResult {
  assessments: readonly RunLedgerDispositionAssessment[];
  plannedRemoval: readonly string[];
  removed: readonly string[];
  preserved: readonly string[];
  /** A failed query or unlink is not the same as a successful plan with zero candidates. */
  unavailable: boolean;
  /** Invalid caller threshold is conservatively treated as unavailable and never permits removal. */
  invalidLiveWindow: boolean;
  counts: {
    disposition: Record<RunLedgerDisposition, number>;
    removed: Record<RunLedgerDisposition, number>;
    preserved: Record<RunLedgerDisposition, number>;
    /** Per-disposition entries whose removal could not be completed. */
    unavailable: Record<RunLedgerDisposition, number>;
    /** Query failure is separate from per-file unlink failure. */
    queryUnavailable: number;
  };
}

interface EmptyCleanupResultStatus {
  unavailable?: boolean;
  invalidLiveWindow?: boolean;
  queryUnavailable?: boolean;
}

function emptyCleanupResult({
  unavailable = false,
  invalidLiveWindow = false,
  queryUnavailable = false,
}: EmptyCleanupResultStatus = {}): RunLedgerCleanupResult {
  return {
    assessments: [], plannedRemoval: [], removed: [], preserved: [], unavailable, invalidLiveWindow,
    counts: {
      disposition: dispositionCounts(), removed: dispositionCounts(), preserved: dispositionCounts(),
      unavailable: dispositionCounts(), queryUnavailable: queryUnavailable ? 1 : 0,
    },
  };
}

export function dispositionUnfinishedRunLedger(entry: UnfinishedRunLedgerEntry): RunLedgerDisposition {
  if (entry.lifecycle === 'orphaned') return 'reclaim-safe';
  if (isTerminatedUnfinishedLifecycle(entry.lifecycle)) return 'needs-human';
  if (entry.lifecycle === 'live') return 'do-not-touch';
  return 'unjudgeable';
}

function dispositionCounts(): Record<RunLedgerDisposition, number> {
  return { 'reclaim-safe': 0, 'needs-human': 0, 'do-not-touch': 0, unjudgeable: 0 };
}

/** Plan deletion by default; explicit removal only unlinks orphaned ledger files and never writes terminal events. */
export function cleanupUnfinishedRunLedgers(options: RunLedgerCleanupOptions): RunLedgerCleanupResult {
  if (!Number.isFinite(options.liveWindowMs) || options.liveWindowMs < 0) {
    return emptyCleanupResult({ unavailable: true, invalidLiveWindow: true });
  }

  const dir = resolve(options.dir ?? runLedgerDir());
  let query: UnfinishedRunLedgerQuery;
  try {
    query = queryUnfinishedRunLedgers({ dir, liveWindowMs: options.liveWindowMs, list: options.list, read: options.read });
  } catch {
    return emptyCleanupResult({ unavailable: true, queryUnavailable: true });
  }
  // `queryUnfinishedRunLedgers` deliberately renders an unreadable ledger as an
  // unjudgeable entry for its read-only callers. Cleanup must not mistake that
  // fail-soft rendering for a complete query: it cannot safely remove from a
  // partially read directory.
  if (query.unreadableLedgerCount > 0) return emptyCleanupResult({ unavailable: true, queryUnavailable: true });

  const assessments = query.entries.map((entry) => ({ entry, disposition: dispositionUnfinishedRunLedger(entry) }));
  const plannedRemoval = assessments
    .filter((assessment) => assessment.disposition === 'reclaim-safe')
    .map((assessment) => runLedgerPath(assessment.entry.runId, dir));
  const removed: string[] = [];
  const preserved: string[] = [];
  const counts = {
    disposition: dispositionCounts(), removed: dispositionCounts(), preserved: dispositionCounts(),
    unavailable: dispositionCounts(), queryUnavailable: 0,
  };
  const unlink = options.unlink ?? unlinkSync;
  let unavailable = false;

  for (const assessment of assessments) {
    const { disposition } = assessment;
    const path = runLedgerPath(assessment.entry.runId, dir);
    counts.disposition[disposition] += 1;
    if (options.remove && disposition === 'reclaim-safe') {
      try {
        unlink(path);
        removed.push(path);
        counts.removed[disposition] += 1;
      } catch {
        unavailable = true;
        preserved.push(path);
        counts.preserved[disposition] += 1;
        counts.unavailable[disposition] += 1;
      }
    } else {
      preserved.push(path);
      counts.preserved[disposition] += 1;
    }
  }
  return { assessments, plannedRemoval, removed, preserved, unavailable, invalidLiveWindow: false, counts };
}

function ledgerGoalDocument(ledger: readonly RunLedgerEntry[]): string | null {
  for (const entry of ledger) {
    if (entry.event === 'start' && typeof entry.data.goalFile === 'string') return entry.data.goalFile;
  }
  return null;
}

function ledgerTargetRoot(ledger: readonly RunLedgerEntry[]): string | null {
  const targetRoot = ledger.find((entry) => entry.event === 'start')?.data.targetRoot;
  return typeof targetRoot === 'string' && isAbsolute(targetRoot) ? targetRoot : null;
}

function pathMatchReasons(declaredPaths: readonly string[], tracedPaths: readonly string[]): Readonly<Record<string, UnfinishedRunPathMatchReason>> {
  const declared = new Set(declaredPaths);
  const traced = new Set(tracedPaths);
  return Object.fromEntries([...new Set([...declaredPaths, ...tracedPaths])].map((path) => [
    path,
    declared.has(path) && traced.has(path) ? 'both' : declared.has(path) ? 'declared' : 'traced',
  ]));
}

function declaredPathsFromGoalDocument(document: string): Pick<UnfinishedRunLedgerEntry, 'declaredPaths' | 'declaredPathStatus'> {
  const originalAsk = verbatimOriginalAsk(document);
  if (originalAsk === null) return { declaredPaths: [], declaredPathStatus: 'original-ask-missing' };
  const parsed = parseAskTargetPathHintsResult(originalAsk);
  if (parsed.labelMissing) return { declaredPaths: [], declaredPathStatus: 'label-missing' };
  const paths = [...new Set(parsed.paths)];
  return { declaredPaths: paths, declaredPathStatus: paths.length > 0 ? 'found' : 'no-declared-paths' };
}

function unknownDeclaredPaths(): Pick<UnfinishedRunLedgerEntry, 'declaredPaths' | 'declaredPathStatus'> {
  return { declaredPaths: [], declaredPathStatus: 'unknown' };
}

interface UnfinishedLedgerFacts {
  terminal: boolean;
  terminalByTrailingRunStatus: boolean;
  branch: string | null;
  lastActivityTimestamp: string | null;
  lastActivityStatus: LastActivityStatus;
  targetRoot: string | null;
  goalFile: string | null;
  fixedLifecycle: UnfinishedRunLifecycle;
}

const UNFINISHED_LEDGER_CACHE_LIMIT = 5_000;
const unfinishedLedgerCache = new Map<string, { size: number; mtimeMs: number; facts: UnfinishedLedgerFacts }>();
const unfinishedReaderIds = new WeakMap<RunLedgerReader, number>();
let nextUnfinishedReaderId = 1;

function unfinishedLedgerCacheKey(path: string, read?: RunLedgerReader): string {
  if (!read) return `${path}\u0000default`;
  let id = unfinishedReaderIds.get(read);
  if (id === undefined) {
    id = nextUnfinishedReaderId++;
    unfinishedReaderIds.set(read, id);
  }
  return `${path}\u0000reader:${id}`;
}

function unfinishedLedgerFacts(ledger: readonly RunLedgerEntry[]): UnfinishedLedgerFacts {
  const last = ledger.at(-1)?.timestamp;
  const lastActivityTimestamp = last !== undefined && Number.isFinite(Date.parse(last)) ? last : null;
  return {
    terminal: hasTerminalRunStatus(ledger),
    terminalByTrailingRunStatus: isTerminalOnlyByTrailingRunStatus(ledger),
    branch: branchFromLedger(ledger),
    lastActivityTimestamp,
    lastActivityStatus: last === undefined ? 'timestamp-missing' : lastActivityTimestamp === null ? 'timestamp-invalid' : 'available',
    targetRoot: ledgerTargetRoot(ledger),
    goalFile: ledgerGoalDocument(ledger),
    fixedLifecycle: classifyUnfinishedLifecycle(ledger, null, 0),
  };
}

function readUnfinishedLedgerFacts(runId: string, dir: string, read?: RunLedgerReader, noCache?: boolean): { facts: UnfinishedLedgerFacts; hit: boolean } {
  const path = runLedgerPath(runId, dir);
  const key = noCache ? null : unfinishedLedgerCacheKey(path, read);
  const stamp = noCache ? null : statSync(path);
  const cached = key === null ? undefined : unfinishedLedgerCache.get(key);
  if (cached && stamp && key !== null && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) {
    unfinishedLedgerCache.delete(key);
    unfinishedLedgerCache.set(key, cached);
    return { facts: cached.facts, hit: true };
  }
  if (key !== null) unfinishedLedgerCache.delete(key);
  try {
    const ledger = loadRunLedger(runId, dir, read);
    if (ledger === null && stamp !== null) throw new Error(`run ledger disappeared after stat: ${path}`);
    const facts = unfinishedLedgerFacts(ledger ?? []);
    if (stamp !== null && key !== null) {
      const after = statSync(path);
      if (after.size === stamp.size && after.mtimeMs === stamp.mtimeMs) {
        unfinishedLedgerCache.set(key, { size: stamp.size, mtimeMs: stamp.mtimeMs, facts });
        if (unfinishedLedgerCache.size > UNFINISHED_LEDGER_CACHE_LIMIT) unfinishedLedgerCache.delete(unfinishedLedgerCache.keys().next().value!);
      }
    }
    return { facts, hit: false };
  } catch (error) {
    if (key !== null) unfinishedLedgerCache.delete(key);
    throw error;
  }
}

function unfinishedActivity(facts: UnfinishedLedgerFacts): Pick<UnfinishedRunLedgerEntry, 'lastActivityTimestamp' | 'lastActivityAgeMs' | 'lastActivityStatus'> {
  return {
    lastActivityTimestamp: facts.lastActivityTimestamp,
    lastActivityStatus: facts.lastActivityStatus,
    lastActivityAgeMs: facts.lastActivityTimestamp === null ? null : Date.now() - Date.parse(facts.lastActivityTimestamp),
  };
}

/** Read non-terminal ledgers and their declared planned paths without changing any run, ledger, or goal document. */
export function queryUnfinishedRunLedgers(options: UnfinishedRunLedgerQueryOptions = {}): UnfinishedRunLedgerQuery {
  const startedAt = Date.now();
  const dir = resolve(options.dir ?? runLedgerDir());
  const goalsDir = resolve(options.goalsDir ?? resolveGoalDocumentsDir(process.cwd()).directory);
  const list = options.list ?? readdirSync;
  const liveWindowMs = options.liveWindowMs ?? DEFAULT_UNFINISHED_LIVE_WINDOW_MS;
  let fileNames: string[];
  try {
    fileNames = list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const missing: UnfinishedRunLedgerQuery = {
        entries: [],
        ledgerDirectory: dir,
        goalsDirectory: goalsDir,
        unreadableLedgerCount: 0,
        ledgerDirectoryMissing: true,
        terminalByTrailingRunStatus: 0,
        cacheHits: 0,
        cacheMisses: 0,
        ...(options.path === undefined ? {} : { pathFilter: options.path, matchingPathCount: 0, unknownPathCount: 0 }),
        scope: 'self-implement-run-ledger',
        note: UNFINISHED_RUN_LEDGER_NOTE,
      };
      debug.log('self-implement.run-ledger', 'goal-lookup-basis', { ledgerTarget: 0, callerCwd: 0 });
      debug.log('self-implement.run-ledger', 'unfinished-query', {
        scanned: 0,
        terminal: 0,
        unfinished: 0,
        terminalByTrailingRunStatus: 0,
        cacheHits: 0,
        cacheMisses: 0,
        ms: Date.now() - startedAt,
      });
      return missing;
    }
    throw error;
  }

  const entries: UnfinishedRunLedgerEntry[] = [];
  let unreadableLedgerCount = 0;
  let scanned = 0;
  let terminal = 0;
  let terminalByTrailingRunStatus = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let ledgerTargetCount = 0;
  let callerCwdCount = 0;
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    scanned += 1;
    let facts: UnfinishedLedgerFacts;
    try {
      const observed = readUnfinishedLedgerFacts(runId, dir, options.read, options.noCache);
      facts = observed.facts;
      if (observed.hit) cacheHits += 1;
      else cacheMisses += 1;
    } catch {
      cacheMisses += 1;
      unreadableLedgerCount += 1;
      entries.push({ runId, branch: null, status: 'ledger-unreadable', plannedPaths: [], plannedPathStatus: 'unknown', ...unknownDeclaredPaths(), pathMatchReasons: {}, goalDocumentPath: null, goalLookupBasis: 'caller-cwd', goalDocumentSearchDirectory: null, lastActivityTimestamp: null, lastActivityAgeMs: null, lastActivityStatus: 'ledger-unreadable', lifecycle: 'unjudgeable' });
      callerCwdCount += 1;
      continue;
    }
    if (facts.terminal) {
      terminal += 1;
      if (facts.terminalByTrailingRunStatus) terminalByTrailingRunStatus += 1;
      continue;
    }

    const branch = facts.branch;
    const activity = unfinishedActivity(facts);
    const lifecycle = facts.fixedLifecycle === 'unjudgeable' && activity.lastActivityAgeMs !== null
      ? activity.lastActivityAgeMs <= liveWindowMs ? 'live' : 'orphaned'
      : facts.fixedLifecycle;
    const targetRoot = facts.targetRoot;
    const goalLookupBasis = targetRoot === null ? 'caller-cwd' : 'ledger-target';
    if (targetRoot === null) callerCwdCount += 1;
    else ledgerTargetCount += 1;
    const ledgerGoalFile = facts.goalFile;
    const searchDirectory = ledgerGoalFile ? null : targetRoot === null ? goalsDir : resolveGoalDocumentsDir(targetRoot).directory;
    const goalDocument = ledgerGoalFile
      ? { status: 'found' as const, path: targetRoot !== null && !isAbsolute(ledgerGoalFile) ? resolve(targetRoot, ledgerGoalFile) : ledgerGoalFile, source: 'ledger' as const }
      : (() => {
        const fallback = goalDocumentForBranch(branch, searchDirectory ?? goalsDir, list);
        return fallback.status === 'found' ? { ...fallback, source: 'branch' as const } : fallback;
      })();
    if (goalDocument.status !== 'found') {
      const plannedPathStatus: PlannedPathStatus = goalDocument.status === 'branch-missing'
        ? 'branch-missing'
        : goalDocument.status === 'ambiguous-match'
          ? 'goal-document-ambiguous'
          : goalDocument.status === 'directory-unreadable'
            ? 'goal-directory-unreadable'
            : 'goal-document-not-found';
      entries.push({ runId, branch, status: 'terminal-status-missing', plannedPaths: [], plannedPathStatus, ...unknownDeclaredPaths(), pathMatchReasons: {}, goalDocumentPath: null, goalLookupBasis, goalDocumentSearchDirectory: searchDirectory, ...activity, lifecycle });
      continue;
    }
    try {
      const document = (options.read ?? readFileSync)(goalDocument.path, 'utf8');
      const text = typeof document === 'string' ? document : document.toString('utf8');
      const paths = [...new Set(tracedPathReferences(text).map((reference) => reference.path))];
      const declared = declaredPathsFromGoalDocument(text);
      entries.push({ runId, branch, status: 'terminal-status-missing', plannedPaths: paths, plannedPathStatus: paths.length > 0 ? goalDocument.source === 'ledger' ? 'found-ledger-goal-file' : 'found-branch-fallback' : 'no-traced-paths', ...declared, pathMatchReasons: pathMatchReasons(declared.declaredPaths, paths), goalDocumentPath: goalDocument.path, goalLookupBasis, goalDocumentSearchDirectory: searchDirectory, ...activity, lifecycle });
    } catch {
      entries.push({ runId, branch, status: 'terminal-status-missing', plannedPaths: [], plannedPathStatus: 'goal-document-unreadable', declaredPaths: [], declaredPathStatus: 'goal-document-unreadable', pathMatchReasons: {}, goalDocumentPath: goalDocument.path, goalLookupBasis, goalDocumentSearchDirectory: searchDirectory, ...activity, lifecycle });
    }
  }
  entries.sort((left, right) => left.runId.localeCompare(right.runId));
  debug.log('self-implement.run-ledger', 'goal-lookup-basis', { ledgerTarget: ledgerTargetCount, callerCwd: callerCwdCount });
  debug.log('self-implement.run-ledger', 'unfinished-query', {
    scanned,
    terminal,
    unfinished: entries.length,
    terminalByTrailingRunStatus,
    cacheHits,
    cacheMisses,
    ms: Date.now() - startedAt,
  });
  if (options.path === undefined) {
    return { entries, ledgerDirectory: dir, goalsDirectory: goalsDir, unreadableLedgerCount, ledgerDirectoryMissing: false, terminalByTrailingRunStatus, cacheHits, cacheMisses, scope: 'self-implement-run-ledger', note: UNFINISHED_RUN_LEDGER_NOTE };
  }
  const pathFilter = options.path;
  const unknownPathStatus = (entry: UnfinishedRunLedgerEntry): boolean => entry.plannedPathStatus !== 'found-ledger-goal-file'
    && entry.plannedPathStatus !== 'found-branch-fallback'
    && entry.plannedPathStatus !== 'no-traced-paths'
    || (entry.declaredPathStatus !== 'found' && entry.declaredPathStatus !== 'no-declared-paths');
  // The union is additive: every historic traced match remains a match, while declarations can only add rows.
  const hasPathMatchReason = (entry: UnfinishedRunLedgerEntry): boolean => Object.hasOwn(entry.pathMatchReasons, pathFilter);
  const matchingEntries = entries.filter(hasPathMatchReason);
  const unknownEntries = entries.filter((entry) => !hasPathMatchReason(entry) && unknownPathStatus(entry));
  return {
    entries: [...matchingEntries, ...unknownEntries],
    ledgerDirectory: dir,
    goalsDirectory: goalsDir,
    unreadableLedgerCount,
    ledgerDirectoryMissing: false,
    terminalByTrailingRunStatus,
    cacheHits,
    cacheMisses,
    pathFilter,
    matchingPathCount: matchingEntries.length,
    unknownPathCount: unknownEntries.length,
    scope: 'self-implement-run-ledger',
    note: UNFINISHED_RUN_LEDGER_NOTE,
  };
}

export interface FederatedUnfinishedRunLedgerEntry extends UnfinishedRunLedgerEntry {
  ledgerDirectory: string;
}

export type FederatedLedgerDirectoryFailureKind = 'missing' | 'unreadable' | 'indeterminate';

/** Classify only confirmed directory states; unknown errors remain observable instead of being guessed. */
export function classifyFederatedLedgerDirectoryReadFailure(error: unknown): FederatedLedgerDirectoryFailureKind {
  const code = error && typeof error === 'object' && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
  return 'indeterminate';
}

export interface FederatedUnfinishedRunLedgerQuery {
  entries: readonly FederatedUnfinishedRunLedgerEntry[];
  ledgerDirectories: readonly string[];
  goalsDirectory: string;
  unreadableLedgerCount: number;
  /** Backward-compatible total: missing + unreadable + indeterminate candidate directories. */
  unreadableLedgerDirectoryCount: number;
  missingLedgerDirectoryCount: number;
  unreadableLedgerDirectoryAccessCount: number;
  indeterminateLedgerDirectoryCount: number;
  /** ⭐ 가로 대조로 «미완에서 빠진» 런 수 — 다른 원장에 종결이 있어 제외된 것.
   *  ⛔ 「0 건」과 「대조를 안 했다」를 같은 값으로 두지 않으려고 «항상» 싣는다. */
  reconciledTerminatedElsewhereCount: number;
  cacheHits?: number;
  cacheMisses?: number;
  pathFilter?: string;
  matchingPathCount?: number;
  unknownPathCount?: number;
  scope: 'self-implement-run-ledger-federated';
  note: string;
}

export interface FederatedUnfinishedRunLedgerQueryOptions {
  path?: string;
  goalsDir?: string;
  includeTest?: boolean;
  targets?: readonly LogTarget[];
  /** Pre-collected directories let callers separately observe target collection from ledger reads. */
  ledgerDirectories?: readonly string[];
  list?: (path: string) => string[];
  noCache?: boolean;
  /**
   * When given, read only these run ledgers. Omitted means today's full scan of every
   * canonical *.jsonl plus the cross-directory unfinished-runId reconciliation.
   */
  runIds?: readonly string[];
}

const FEDERATED_UNFINISHED_RUN_LEDGER_NOTE = 'Read-only union of run-ledger directories selected by the same --all/--include-test target policy as elanous logs. Each row carries its physical ledger directory because instance names can identify multiple state roots.';

export function queryFederatedUnfinishedRunLedgers(options: FederatedUnfinishedRunLedgerQueryOptions = {}): FederatedUnfinishedRunLedgerQuery {
  const goalsDirectory = resolve(options.goalsDir ?? resolveGoalDocumentsDir(process.cwd()).directory);
  const candidateLedgerDirectories = options.ledgerDirectories ?? resolveFederatedRunLedgerDirectories(options);
  const requestedRunIds = options.runIds === undefined ? undefined : new Set(options.runIds);
  const ledgerDirectories: string[] = [];
  const entries: FederatedUnfinishedRunLedgerEntry[] = [];
  let unreadableLedgerCount = 0;
  let missingLedgerDirectoryCount = 0;
  let unreadableLedgerDirectoryAccessCount = 0;
  let indeterminateLedgerDirectoryCount = 0;
  let matchingPathCount = 0;
  let unknownPathCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const recordDirectoryFailure = (kind: FederatedLedgerDirectoryFailureKind): void => {
    if (kind === 'missing') missingLedgerDirectoryCount += 1;
    else if (kind === 'unreadable') unreadableLedgerDirectoryAccessCount += 1;
    else indeterminateLedgerDirectoryCount += 1;
  };
  for (const ledgerDirectory of candidateLedgerDirectories) {
    try {
      const listDirectory = options.list ?? readdirSync;
      const list = requestedRunIds === undefined
        ? options.list
        : (directory: string) => listDirectory(directory).filter((fileName) => {
          const runId = runIdFromCanonicalLedgerFile(fileName);
          return runId !== null && requestedRunIds.has(runId);
        });
      const result = queryUnfinishedRunLedgers({ dir: ledgerDirectory, goalsDir: goalsDirectory, ...(options.path === undefined ? {} : { path: options.path }), ...(list === undefined ? {} : { list }), noCache: options.noCache });
      if (result.ledgerDirectoryMissing) {
        recordDirectoryFailure('missing');
        continue;
      }
      ledgerDirectories.push(ledgerDirectory);
      unreadableLedgerCount += result.unreadableLedgerCount;
      matchingPathCount += result.matchingPathCount ?? 0;
      unknownPathCount += result.unknownPathCount ?? 0;
      cacheHits += result.cacheHits ?? 0;
      cacheMisses += result.cacheMisses ?? 0;
      entries.push(...result.entries.map((entry) => ({ ...entry, ledgerDirectory })));
    } catch (error) {
      recordDirectoryFailure(classifyFederatedLedgerDirectoryReadFailure(error));
    }
  }
  const unreadableLedgerDirectoryCount = missingLedgerDirectoryCount + unreadableLedgerDirectoryAccessCount + indeterminateLedgerDirectoryCount;
  // ⛔⭐⭐ 가로 대조 — 원장 «하나»만 보고 「미완」이라 말하지 않는다 (2026-08-11 · 🅣 71차 실측).
  //   같은 runId 가 여러 원장에 흩어질 수 있다: 부모 우주엔 앞부분만 남고 자식 worktree 우주에
  //   종결이 남는 일이 실제로 있다(실측 `run-b922a4f2` — 부모에 run-status 0건, 자식에 cancelled·failed).
  //   ⇒ 원장마다 «독립»으로 판정하면 그 런은 영영 「도는 중」이고, 발사 전 검사가 실제 발사를 막는다.
  //   📏 실측(2026-08-11): 미완 57 중 ***7*** 이 다른 원장에 종결을 갖고 있었다.
  // ⛔ 판정 술어는 스캐너와 «같은 것»을 쓴다(`run-status` 또는 `terminal`) — 어휘를 새로 만들지 않는다.
  const terminatedElsewhere = new Set<string>();
  const unfinishedRunIds = requestedRunIds === undefined ? new Set(entries.map((entry) => entry.runId)) : new Set([...requestedRunIds].filter((runId) => entries.some((entry) => entry.runId === runId)));
  for (const runId of unfinishedRunIds) {
    for (const ledgerDirectory of ledgerDirectories) {
      try {
        if (readUnfinishedLedgerFacts(runId, ledgerDirectory, undefined, options.noCache).facts.terminal) { terminatedElsewhere.add(runId); break; }
      } catch { /* An absent or unreadable sibling cannot establish termination. */ }
    }
  }
  const reconciledEntries = entries.filter((entry) => !terminatedElsewhere.has(entry.runId));
  const reconciledTerminatedElsewhereCount = entries.length - reconciledEntries.length;
  entries.length = 0;
  entries.push(...reconciledEntries);
  entries.sort((left, right) => left.ledgerDirectory.localeCompare(right.ledgerDirectory) || left.runId.localeCompare(right.runId));
  return {
    entries,
    ledgerDirectories,
    goalsDirectory,
    unreadableLedgerCount,
    unreadableLedgerDirectoryCount,
    missingLedgerDirectoryCount,
    unreadableLedgerDirectoryAccessCount,
    indeterminateLedgerDirectoryCount,
    reconciledTerminatedElsewhereCount,
    cacheHits,
    cacheMisses,
    ...(options.path === undefined ? {} : { pathFilter: options.path, matchingPathCount, unknownPathCount }),
    scope: 'self-implement-run-ledger-federated',
    note: FEDERATED_UNFINISHED_RUN_LEDGER_NOTE,
  };
}

export function renderUnfinishedRunLedgers(result: UnfinishedRunLedgerQuery | FederatedUnfinishedRunLedgerQuery): string {
  const unfinishedRunCount = result.entries.filter((entry) => entry.status === 'terminal-status-missing').length;
  const federated = result.scope === 'self-implement-run-ledger-federated';
  const lines = federated
    ? [`ledger directories checked: ${result.ledgerDirectories.length + result.unreadableLedgerDirectoryCount}; unreadable ledger directories: ${result.unreadableLedgerDirectoryCount}`, ...result.ledgerDirectories.map((directory) => `ledger directory: ${directory}`), `missing ledger directories: ${result.missingLedgerDirectoryCount}`, `unreadable ledger directory access: ${result.unreadableLedgerDirectoryAccessCount}`, `indeterminate ledger directories: ${result.indeterminateLedgerDirectoryCount}`, `goals directory: ${result.goalsDirectory}`, `unfinished runs: ${unfinishedRunCount}`, `unreadable ledgers: ${result.unreadableLedgerCount}`, `terminated in another ledger (excluded): ${result.reconciledTerminatedElsewhereCount}`]
    : [`ledger directory: ${result.ledgerDirectory}`, `ledger directory status: ${result.ledgerDirectoryMissing ? 'missing (no run ledgers were scanned)' : 'present'}`, `goals directory: ${result.goalsDirectory}`, `unfinished runs: ${unfinishedRunCount}`, `unreadable ledgers: ${result.unreadableLedgerCount}`];
  if (result.pathFilter !== undefined) lines.push(`path filter: ${result.pathFilter}`, `matching paths: ${result.matchingPathCount ?? 0}`, `unknown paths: ${result.unknownPathCount ?? 0}`);
  // ⭐ 사람 출구가 «한 값»만 보던 것을 가른다 — `status` 는 미완 런에서 언제나 `terminal-status-missing`
  //   하나뿐이라 아무것도 안 가른다. 같은 조회의 `--json` 은 이미 `lifecycle` 로 갈라 낸다.
  //   ⛔ 새 판정·임계·자동 처분은 만들지 않는다. 이미 계산된 값을 «보여주기»만 한다.
  //   📏 실측 근거(2026-08-11): 미완 57건이 텍스트로는 전부 한 값이고, JSON 으로는
  //     orphaned 52 · terminal-other-vocabulary 5 로 갈렸다 — 사람은 자기가 친 출구만 본다.
  const lifecycleCounts = new Map<string, number>();
  for (const entry of result.entries) lifecycleCounts.set(entry.lifecycle, (lifecycleCounts.get(entry.lifecycle) ?? 0) + 1);
  if (lifecycleCounts.size > 0) {
    lines.push(`lifecycle: ${[...lifecycleCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `${name} ${count}`).join(' · ')}`);
  }
  for (const entry of result.entries) {
    const source = 'ledgerDirectory' in entry ? ` ledgerDirectory=${entry.ledgerDirectory}` : '';
    // ⛔ `lifecycle` 은 «맨 뒤»에 붙인다 — 기존 표기의 이름·순서를 바꾸지 않는다(소비 테스트가 앞부분을 문다).
    //   ⚠️ 새 필드는 `lifecycle` «앞»에 넣는다. 뒤에 붙이면 이 주석이 거짓이 되고, 줄 끝을 무는
    //   소비자(`awk '{print $NF}'` 류)가 조용히 다른 값을 읽는다. `#8711` 이 한 번 그렇게 붙였다.
    lines.push(`runId=${entry.runId}${source} status=${entry.status} branch=${entry.branch ?? 'unknown'} plannedPaths=${entry.plannedPathStatus} declaredPaths=${entry.declaredPathStatus} lastActivity=${entry.lastActivityTimestamp ?? 'null'} lastActivityAgeMs=${entry.lastActivityAgeMs ?? 'null'} lastActivityStatus=${entry.lastActivityStatus} lifecycle=${entry.lifecycle}`);
    if (entry.goalDocumentPath) lines.push(`  goal document: ${entry.goalDocumentPath}`);
    if (entry.goalDocumentSearchDirectory) lines.push(`  goal document search directory: ${entry.goalDocumentSearchDirectory}`);
    for (const path of Object.keys(entry.pathMatchReasons)) lines.push(`  ${path} (${entry.pathMatchReasons[path]})`);
  }
  if (result.entries.length === 0) lines.push('  none');
  lines.push(`note: ${result.note}`);
  return lines.join('\n');
}

export interface MergedRunLedgerEvent {
  prNumber: number;
  merged: boolean;
  runId: string;
  timestamp: string;
}

export interface MergedRunLedgerQuery {
  entries: readonly MergedRunLedgerEvent[];
  ledgerDirectory: string;
  excludedMergedEntryCount: number;
  excludedLedgerCount: number;
  unreadableLedgerCount: number;
  ledgerDirectoryMissing: boolean;
  scope: 'self-implement-run-ledger';
  note: string;
}

export interface MergedRunLedgerQueryOptions {
  dir?: string;
  from?: string;
  to?: string;
  read?: RunLedgerReader;
  list?: (path: string) => string[];
}

const MERGED_RUN_LEDGER_NOTE = 'Includes only merged events recorded by elanous self-implement pipeline run ledgers; excludes review-loop and merges performed outside elanous. Excludes every merged event from a ledger containing two or more merged events because one pipeline run merges at most once.';

/** Read merged self-implement pipeline events from all existing run ledgers without changing either store. */
interface MergedRunLedgerScan {
  query: MergedRunLedgerQuery;
  ledgersByRunId: ReadonlyMap<string, readonly RunLedgerEntry[]>;
}

function scanMergedRunLedgers(options: MergedRunLedgerQueryOptions = {}): MergedRunLedgerScan {
  const dir = resolve(options.dir ?? runLedgerDir());
  const list = options.list ?? readdirSync;
  let fileNames: string[];
  try {
    fileNames = list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        query: {
          entries: [],
          ledgerDirectory: dir,
          excludedMergedEntryCount: 0,
          excludedLedgerCount: 0,
          unreadableLedgerCount: 0,
          ledgerDirectoryMissing: true,
          scope: 'self-implement-run-ledger',
          note: MERGED_RUN_LEDGER_NOTE,
        },
        ledgersByRunId: new Map(),
      };
    }
    throw error;
  }

  const entries: MergedRunLedgerEvent[] = [];
  const ledgersByRunId = new Map<string, readonly RunLedgerEntry[]>();
  let excludedMergedEntryCount = 0;
  let excludedLedgerCount = 0;
  let unreadableLedgerCount = 0;
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    try {
      const ledger = loadRunLedger(runId, dir, options.read);
      if (ledger === null) {
        unreadableLedgerCount += 1;
        continue;
      }
      ledgersByRunId.set(runId, ledger);
      const mergedLedgerEntries = ledger.filter((entry) => entry.event === 'merged');
      if (mergedLedgerEntries.length >= 2) {
        excludedMergedEntryCount += mergedLedgerEntries.length;
        excludedLedgerCount += 1;
        continue;
      }
      const mergedEntries: MergedRunLedgerEvent[] = [];
      for (const entry of mergedLedgerEntries) {
        if (typeof entry.timestamp !== 'string' || typeof entry.data.number !== 'number' || typeof entry.data.merged !== 'boolean') continue;
        mergedEntries.push({ prNumber: entry.data.number, merged: entry.data.merged, runId: entry.runId, timestamp: entry.timestamp });
      }
      for (const entry of mergedEntries) {
        if ((options.from && entry.timestamp < options.from) || (options.to && entry.timestamp > options.to)) continue;
        entries.push(entry);
      }
    } catch {
      unreadableLedgerCount += 1;
    }
  }

  entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.runId.localeCompare(right.runId));
  return {
    query: {
      entries,
      ledgerDirectory: dir,
      excludedMergedEntryCount,
      excludedLedgerCount,
      unreadableLedgerCount,
      ledgerDirectoryMissing: false,
      scope: 'self-implement-run-ledger',
      note: MERGED_RUN_LEDGER_NOTE,
    },
    ledgersByRunId,
  };
}

/** Read merged self-implement pipeline events from all existing run ledgers without changing either store. */
export function queryMergedRunLedgers(options: MergedRunLedgerQueryOptions = {}): MergedRunLedgerQuery {
  return scanMergedRunLedgers(options).query;
}

export interface HandedToHumanMergeAttributionEntry {
  /** Undefined means this terminal run-status event did not retain a merge reason. */
  mergeReason?: string;
  /** Undefined means this run ledger did not retain a pr-opened event number. */
  prNumber?: number;
  runId: string;
  timestamp: string;
  branch: 'without-merge-attempt' | 'after-merge-attempt';
}

export interface MergeAttributionQueryOptions extends MergedRunLedgerQueryOptions {
  /** Total merged PRs from an independently queried cross-store; this query never reads that store itself. */
  crossStoreMergedTotal?: number;
}

export interface MergeAttributionQuery {
  elanousMergedEntries: readonly MergedRunLedgerEvent[];
  handedToHumanEntries: readonly HandedToHumanMergeAttributionEntry[];
  ledgerDirectory: string;
  handedToHumanWithoutMergeAttemptCount: number;
  handedToHumanAfterMergeAttemptCount: number;
  unattributable: {
    status: 'not-countable';
    reason: string;
  } | {
    status: 'counted';
    count: number;
  };
  excludedMergedEntryCount: number;
  excludedLedgerCount: number;
  unreadableLedgerCount: number;
  ledgerDirectoryMissing: boolean;
  scope: 'self-implement-run-ledger';
  note: string;
}

const MERGE_ATTRIBUTION_UNATTRIBUTABLE_REASON = 'Merges that did not pass through elanous cannot be counted from run ledgers alone.';
const MERGE_ATTRIBUTION_INVALID_CROSS_STORE_TOTAL_REASON = 'The cross-store merged total must be a finite non-negative integer that is not less than the elanous merged count.';
const MERGE_ATTRIBUTION_NOTE = 'Reads only self-implement run ledgers; it does not read the log-store observations for review-loop auto-merged events or MergePullRequest tool calls.';

function isMergeCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function unattributableMerges(crossStoreMergedTotal: number | undefined, elanousMergedCount: number): MergeAttributionQuery['unattributable'] {
  if (crossStoreMergedTotal === undefined) {
    return { status: 'not-countable', reason: MERGE_ATTRIBUTION_UNATTRIBUTABLE_REASON };
  }
  if (!isMergeCount(crossStoreMergedTotal) || !isMergeCount(elanousMergedCount) || crossStoreMergedTotal < elanousMergedCount) {
    return { status: 'not-countable', reason: MERGE_ATTRIBUTION_INVALID_CROSS_STORE_TOTAL_REASON };
  }
  return { status: 'counted', count: crossStoreMergedTotal - elanousMergedCount };
}

/** 사람 표기용 — `unattributable` 의 «두 팔»을 한 문자열로 접는다.
 *
 *  ⛔⭐ **이 함수는 리뷰 must-fix 에 대한 «반론»을 계약으로 고정한 것이다**(2026-08-06 ·
 *  `MANUAL-review-operations` §3 — *반론은 주석+회귀 테스트로 고정한다*).
 *  리뷰는 `src/index.ts` 의 이 출력 수정을 *"목표와 무관한 스코프 크리프"* 로 두 라운드 지적했으나,
 *  실측은 반대였다: `unattributable` 은 **판별 유니온**이라 `.reason` 을 무조건 꺼내면 `tsc` 가 막고,
 *  ***`index.ts` 를 건드리는 PR 은 touch-clean 게이트 때문에 그 수정을 «피할 수 없다».***
 *  ⇒ 그래서 되돌리지 «않고», 리뷰가 **옳게** 지적한 나머지 절반(*"테스트도 없다"*)을 닫는다. */
export function formatUnattributableDetail(unattributable: MergeAttributionQuery['unattributable']): string {
  return unattributable.status === 'not-countable' ? unattributable.reason : String(unattributable.count);
}

/** Attribute merge outcomes from run ledgers, with an optionally injected cross-store total for manual-merge candidates. */
export function queryMergeAttribution(options: MergeAttributionQueryOptions = {}): MergeAttributionQuery {
  const merged = queryMergedRunLedgers(options);
  const dir = merged.ledgerDirectory;
  const list = options.list ?? readdirSync;
  const elanousMergedEntries = merged.entries.filter((entry) => entry.merged);
  let fileNames: string[];
  try {
    fileNames = list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        elanousMergedEntries,
        handedToHumanEntries: [],
        ledgerDirectory: merged.ledgerDirectory,
        handedToHumanWithoutMergeAttemptCount: 0,
        handedToHumanAfterMergeAttemptCount: 0,
        unattributable: unattributableMerges(options.crossStoreMergedTotal, elanousMergedEntries.length),
        excludedMergedEntryCount: merged.excludedMergedEntryCount,
        excludedLedgerCount: merged.excludedLedgerCount,
        unreadableLedgerCount: merged.unreadableLedgerCount,
        ledgerDirectoryMissing: merged.ledgerDirectoryMissing,
        scope: 'self-implement-run-ledger',
        note: MERGE_ATTRIBUTION_NOTE,
      };
    }
    throw error;
  }

  const elanousMergedRunIds = new Set(elanousMergedEntries.map((entry) => entry.runId));
  const failedMergeAttemptRunIds = new Set(merged.entries.filter((entry) => !entry.merged).map((entry) => entry.runId));
  const handedToHumanEntries: HandedToHumanMergeAttributionEntry[] = [];
  for (const entry of merged.entries) {
    if (entry.merged) continue;
    try {
      const ledger = loadRunLedger(entry.runId, dir, options.read) ?? [];
      const prOpened = [...ledger].reverse().find((candidate) => candidate.event === 'pr-opened');
      const terminalStatus = [...ledger].reverse().find((candidate) => candidate.event === 'run-status');
      handedToHumanEntries.push({
        ...(typeof terminalStatus?.data.mergeReason === 'string' ? { mergeReason: terminalStatus.data.mergeReason } : {}),
        ...(typeof prOpened?.data.number === 'number' ? { prNumber: prOpened.data.number } : {}),
        runId: entry.runId,
        timestamp: entry.timestamp,
        branch: 'after-merge-attempt',
      });
    } catch {
      // The merged query already owns the unreadable-ledger count contract.
    }
  }
  for (const fileName of fileNames) {
    const runId = runIdFromCanonicalLedgerFile(fileName);
    if (!runId) continue;
    if (elanousMergedRunIds.has(runId) || failedMergeAttemptRunIds.has(runId)) continue;
    try {
      const ledger = loadRunLedger(runId, dir, options.read);
      if ((ledger ?? []).filter((entry) => entry.event === 'merged').length >= 2) continue;
      const terminalStatus = [...(ledger ?? [])].reverse().find((entry) => entry.event === 'run-status');
      if (!terminalStatus || terminalStatus.data.stage !== 'pr-opened') continue;
      const branch = terminalStatus.data.node === 'open-pr'
        ? 'without-merge-attempt'
        : terminalStatus.data.node === 'merge'
          ? 'after-merge-attempt'
          : undefined;
      if (!branch || typeof terminalStatus.timestamp !== 'string' || (options.from && terminalStatus.timestamp < options.from) || (options.to && terminalStatus.timestamp > options.to)) continue;
      const prOpened = [...(ledger ?? [])].reverse().find((entry) => entry.event === 'pr-opened');
      handedToHumanEntries.push({
        ...(typeof terminalStatus.data.mergeReason === 'string' ? { mergeReason: terminalStatus.data.mergeReason } : {}),
        ...(typeof prOpened?.data.number === 'number' ? { prNumber: prOpened.data.number } : {}),
        runId: terminalStatus.runId,
        timestamp: terminalStatus.timestamp,
        branch,
      });
    } catch {
      // The merged query already owns the unreadable-ledger count contract.
    }
  }
  handedToHumanEntries.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.runId.localeCompare(right.runId));
  const handedToHumanWithoutMergeAttemptCount = handedToHumanEntries.filter((entry) => entry.branch === 'without-merge-attempt').length;
  const handedToHumanAfterMergeAttemptCount = handedToHumanEntries.filter((entry) => entry.branch === 'after-merge-attempt').length;

  return {
    elanousMergedEntries,
    handedToHumanEntries,
    ledgerDirectory: merged.ledgerDirectory,
    handedToHumanWithoutMergeAttemptCount,
    handedToHumanAfterMergeAttemptCount,
    unattributable: unattributableMerges(options.crossStoreMergedTotal, elanousMergedEntries.length),
    excludedMergedEntryCount: merged.excludedMergedEntryCount,
    excludedLedgerCount: merged.excludedLedgerCount,
    unreadableLedgerCount: merged.unreadableLedgerCount,
    ledgerDirectoryMissing: merged.ledgerDirectoryMissing,
    scope: 'self-implement-run-ledger',
    note: MERGE_ATTRIBUTION_NOTE,
  };
}

export type RunChainHopStatus = 'connected' | 'broken' | 'not-countable' | 'not-applicable';

type RunChainHop = 'fingerprint' | 'goalId' | 'runId' | 'pr' | 'merged';

export interface RunChainShardIdentity {
  orchestrationId?: string;
  shardId?: string;
  siblingShardIds?: readonly string[];
  pieceIndex?: number;
  pieceTotal: number;
  shardIdentityReadFailure?: RunShardIdentityReadFailure;
}

export interface RunChainShardSibling {
  runId: string;
  shardId?: string;
  pieceIndex?: number;
}

export interface RunChainEntry {
  fingerprint: string | null;
  goalId: string | null;
  runId: string;
  prNumber: number | null;
  merged: boolean;
  originRoot: string | null;
  originAgent: string | null;
  originSession: string | null;
  /**
   * The observed goal source for this run — the axis `daemonObservationApplicability`
   * splits `not-applicable` from `not-countable` on. Reported so a reader can tell a
   * *known* inapplicable source from one that merely fell through to the catch-all;
   * without it the two arrive at the surface wearing the same face.
   *
   * `null` means `goalSourceForRun` resolved no single string source, which folds three
   * distinct causes together: the run has no `self-implement` `start` event at all, its
   * start events carried no string `goalSource`, or they carried more than one distinct
   * value (deliberately not attributed to either). Splitting those needs producer-side
   * instrumentation, so this field narrows the ambiguity rather than removing it.
   */
  goalSource: string | null;
  hops: Readonly<Record<RunChainHop, RunChainHopStatus>>;
  /** The latest producer-emitted shard identity; legacy entries remain absent rather than inferred. */
  shardIdentity: RunChainShardIdentity | null;
  /** Readable siblings from the same producer-emitted orchestration, excluding this run. */
  shardSiblings: readonly RunChainShardSibling[];
}

export interface RunChainQuery {
  entries: readonly RunChainEntry[];
  ledgerDirectory: string;
  excludedMergedEntryCount: number;
  excludedLedgerCount: number;
  unreadableLedgerCount: number;
  logStorePath: string;
  logStoreStatus: 'read' | 'missing' | 'unreadable';
  scope: 'self-implement-run-chain';
  note: string;
}

export interface RunChainLogStore {
  query(query: Parameters<LogStore['query']>[0]): LogStoreRow[];
  queryAll?(query: Parameters<LogStore['queryAll']>[0]): LogStoreRow[];
  queryByDataKeys?(query: Parameters<LogStore['queryByDataKeys']>[0]): LogStoreRow[];
  queryRunChainRows?(runIds: readonly string[]): ReturnType<LogStore['queryRunChainRows']>;
}

export interface RunChainQueryOptions extends MergedRunLedgerQueryOptions {
  logStorePath?: string;
  /** Test seam for read-only query failures; production opens logStorePath itself. */
  logStore?: RunChainLogStore;
}

export interface RunScreenLastEvent {
  category: string;
  event: string;
  timestamp: string;
}

export type RunScreenMissingStatus = 'awaiting-start' | 'pipeline-failed' | 'cleaned' | 'not-found' | 'unclassified';

export interface RunScreenLogStoreStatus {
  path: string;
  status: 'read' | 'missing' | 'unreadable';
}

export interface RunScreenKeyQuery {
  runId: string;
  screenKey: string | null;
  matchedSpawnCount: number;
  lastEvent: RunScreenLastEvent | null;
  /** The primary path for explicit calls, or the current-universe path for federated defaults. */
  logStorePath: string;
  /** `read` when at least one target was read, preserving the existing CLI consumer contract. */
  logStoreStatus: 'read' | 'missing' | 'unreadable';
  /** Per-store outcomes distinguish a partially unreadable federation from an empty observation. */
  logStoreStatuses?: readonly RunScreenLogStoreStatus[];
  unreadableLogStoreCount?: number;
}

/** Classify why a run has not yet emitted its headless screen. */
export function classifyRunScreenMissing(lastEvent: Pick<RunScreenLastEvent, 'category' | 'event'> | null): RunScreenMissingStatus {
  if (!lastEvent) return 'not-found';
  const category = lastEvent.category.toLowerCase();
  const event = lastEvent.event.toLowerCase();
  const awaitingStartCategory = category === 'clarification'
    || category.startsWith('clarification.')
    || category === 'goal-author'
    || category.startsWith('goal-author.');
  if (awaitingStartCategory) return 'awaiting-start';
  if (category === 'dev-pipeline' && event === 'error') return 'pipeline-failed';
  if (category === 'harness.clean' || category.startsWith('harness.clean.')) return 'cleaned';
  return 'unclassified';
}

export interface RunScreenKeyQueryOptions {
  logStorePath?: string;
  /** Test seam shared with run-chain queries; production opens logStorePath itself. */
  logStore?: RunChainLogStore;
  /** Test seam for the shared all-instance target policy used by no-path production calls. */
  logTargets?: readonly LogTarget[];
  /** Test seam for per-target read failures without changing the production open policy. */
  openLogStore?: (path: string) => { store?: RunChainLogStore; close?: () => void; status: RunScreenLogStoreStatus['status'] };
}

const RUN_CHAIN_NOTE = 'Reads run ledgers and the separate log-store without writing either store; fingerprint→goalId→runId→PR→merged reports connected, broken, not-countable, or not-applicable for every observable run.';
const LOG_PAGE_SIZE = 1_000;

type LogPayload = Record<string, unknown>;
type DaemonObservationApplicability = 'applicable' | 'not-applicable' | 'not-countable';

function daemonObservationApplicability(goalSource: string | null): DaemonObservationApplicability {
  if (goalSource === 'natural-language-dispatch') return 'applicable';
  if (goalSource === 'authored-goal-file' || goalSource === 'no-goal-file') return 'not-applicable';
  return 'not-countable';
}

function goalSourceForRun(payloads: readonly { row: LogStoreRow; data: LogPayload | null }[], runId: string): string | null {
  const sources = new Set(payloads
    .filter(({ row, data }) => row.category === 'self-implement' && row.event === 'start' && stringField(data, 'runId') === runId)
    .map(({ data }) => stringField(data, 'goalSource'))
    .filter((goalSource): goalSource is string => goalSource !== null));
  return sources.size === 1 ? sources.values().next().value! : null;
}

function parseLogPayload(row: LogStoreRow): LogPayload | null {
  if (!row.data) return null;
  try {
    const value: unknown = JSON.parse(row.data);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as LogPayload : null;
  } catch {
    return null;
  }
}

function stringField(data: LogPayload | null, field: string): string | null {
  const value = data?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function fingerprint(userText: string | null): string | null {
  return userText === null ? null : userText.slice(0, 500);
}

function prNumberFromUrl(pr: string | null): number | null {
  const match = pr?.match(/\/pull\/(\d+)(?:$|[?#/])/);
  return match ? Number(match[1]) : null;
}

/** Page every matching row so an old dispatch is never classified broken merely because it falls beyond a first result page. */
function queryAll(store: RunChainLogStore, query: Parameters<LogStore['query']>[0]): LogStoreRow[] {
  const rows: LogStoreRow[] = [];
  let beforeId: number | undefined;
  do {
    const page = store.query({ ...query, ...(beforeId === undefined ? {} : { beforeId }), limit: LOG_PAGE_SIZE });
    rows.push(...page);
    if (page.length < LOG_PAGE_SIZE) return rows;
    beforeId = page.at(-1)?.id;
  } while (beforeId !== undefined);
  return rows;
}

function queryRunLogRows(store: RunChainLogStore, runId?: string): LogStoreRow[] {
  const query = {
    exactCategories: ['dev-pipeline', 'self-implement', 'daemon-tools.self-implement'],
    ...(runId === undefined ? {} : { grep: runId }),
  };
  if (runId === undefined && store.queryAll) return store.queryAll(query);
  return queryAll(store, query);
}

function rowsByRunId(rows: readonly LogStoreRow[]): ReadonlyMap<string, readonly LogStoreRow[]> {
  const byRunId = new Map<string, LogStoreRow[]>();
  for (const row of rows) {
    const runId = stringField(parseLogPayload(row), 'runId');
    if (!runId) continue;
    const existing = byRunId.get(runId);
    if (existing) existing.push(row);
    else byRunId.set(runId, [row]);
  }
  return byRunId;
}

function dispatchForSession(rows: readonly LogStoreRow[], sessionId: string): LogPayload | null {
  return rows
    .filter((row) => row.category === 'daemon-tools.self-implement' && row.event === 'dispatch')
    .map((row) => parseLogPayload(row))
    .find((data) => stringField(data, 'sessionId') === sessionId) ?? null;
}

/** Resolve a self-implement runId to the screen key emitted by its headless spawner without writing either store. */
/**
 * 로그 스토어를 «읽기 전용»으로 연다 — ⭐ `queryRunChain` 과 `queryRunScreenKey` 가 **같은 심을 쓴다**.
 *
 * ⛔⭐ 종전엔 둘이 각자 열었다(리뷰 must-fix). 한쪽은 `existsSync` 로 먼저 보고 다른 쪽은 `ENOENT`
 *   코드로 갈라, ***같은 「없음/못 읽음」을 두 방식으로 판정***했다. 상태 어휘가 같으니 겉으론 안 보이고,
 *   드리프트는 «둘 중 하나만 고칠 때» 조용히 생긴다.
 * ⚠️ 주입된 `logStore`(테스트 대역)가 있으면 아무것도 열지 않고 `read` 로 본다 — 종전 두 함수의 동작이다.
 */
function openRunLogStoreReadOnly(
  logStorePath: string,
  injected?: RunChainLogStore,
): { store?: RunChainLogStore; opened?: LogStore; status: 'read' | 'missing' | 'unreadable' } {
  if (injected) return { store: injected, status: 'read' };
  if (!existsSync(logStorePath)) return { status: 'missing' };
  try {
    const opened = LogStore.openReadOnly(logStorePath);
    return { store: opened, opened, status: 'read' };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function laterLogRow<T extends { row: LogStoreRow }>(current: T | null, candidate: T): T {
  if (!current) return candidate;
  const currentTime = Date.parse(current.row.ts);
  const candidateTime = Date.parse(candidate.row.ts);
  if (Number.isFinite(currentTime) && Number.isFinite(candidateTime) && candidateTime !== currentTime) return candidateTime > currentTime ? candidate : current;
  return candidate.row.id > current.row.id ? candidate : current;
}

/** Resolve a run screen across every registered log universe unless the caller explicitly scopes one store. */
export function queryRunScreenKey(runId: string, options: RunScreenKeyQueryOptions = {}): RunScreenKeyQuery {
  const primaryPath = resolve(options.logStorePath ?? logsDbPath());
  const explicitlyScoped = options.logStorePath !== undefined || options.logStore !== undefined;
  const targets = explicitlyScoped ? [{ name: 'explicit', dbPath: primaryPath }] : [{ name: 'current', dbPath: primaryPath }, ...(options.logTargets ?? resolveLogTargets({ all: true, includeTest: true }).targets)];
  const paths = [...new Set(targets.map((target) => resolve(target.dbPath)))];
  const statuses: RunScreenLogStoreStatus[] = [];
  const spawnRows: LogStoreRow[] = [];
  const eventRows: { row: LogStoreRow; data: LogPayload | null }[] = [];
  for (const path of paths) {
    const opened = options.openLogStore ? options.openLogStore(path) : openRunLogStoreReadOnly(path, explicitlyScoped ? options.logStore : undefined);
    const close = options.openLogStore
      ? (opened as { close?: () => void }).close
      : (opened as ReturnType<typeof openRunLogStoreReadOnly>).opened?.close.bind((opened as ReturnType<typeof openRunLogStoreReadOnly>).opened);
    if (!opened.store) { statuses.push({ path, status: opened.status }); continue; }
    try {
      spawnRows.push(...queryAll(opened.store, { exactCategories: ['self-implement'], events: ['headless.spawn'], grep: runId }));
      eventRows.push(...queryAll(opened.store, { grep: runId }).map((row) => ({ row, data: parseLogPayload(row) })));
      statuses.push({ path, status: 'read' });
    } catch { statuses.push({ path, status: 'unreadable' }); } finally { close?.(); }
  }
  const readable = statuses.filter(({ status }) => status === 'read').length;
  const unreadableLogStoreCount = statuses.filter(({ status }) => status === 'unreadable').length;
  const logStoreStatus: RunScreenKeyQuery['logStoreStatus'] = readable > 0 ? 'read' : unreadableLogStoreCount > 0 ? 'unreadable' : 'missing';
  const matches = spawnRows.map((row) => ({ row, data: parseLogPayload(row) })).filter(({ data }) => stringField(data, 'runId') === runId && stringField(data, 'screenKey') !== null);
  const latest = matches.reduce<typeof matches[number] | null>(laterLogRow, null);
  const screenKey = latest ? stringField(latest.data, 'screenKey') : null;
  if (screenKey) return { runId, screenKey, matchedSpawnCount: matches.length, lastEvent: null, logStorePath: primaryPath, logStoreStatus, logStoreStatuses: statuses, unreadableLogStoreCount };
  const fieldMatched = eventRows.filter(({ data }) => stringField(data, 'runId') === runId);
  const latestEvent = (fieldMatched.length > 0 ? fieldMatched : eventRows).reduce<{ row: LogStoreRow } | null>(laterLogRow, null);
  const primaryStatus = statuses.find(({ path }) => path === primaryPath)?.status;
  const noObservationStatus = eventRows.length === 0 && primaryStatus && primaryStatus !== 'read' ? primaryStatus : logStoreStatus;
  return { runId, screenKey: null, matchedSpawnCount: matches.length, lastEvent: latestEvent ? { category: latestEvent.row.category, event: latestEvent.row.event, timestamp: latestEvent.row.ts } : null, logStorePath: primaryPath, logStoreStatus: noObservationStatus, logStoreStatuses: statuses, unreadableLogStoreCount };
}

function latestRunShardIdentity(ledger: readonly RunLedgerEntry[] | undefined): RunChainShardIdentity | null {
  const entry = [...(ledger ?? [])].reverse().find((candidate) => candidate.pieceTotal !== undefined || candidate.shardIdentityReadFailure !== undefined);
  if (!entry || entry.pieceTotal === undefined) return null;
  return {
    ...(entry.orchestrationId === undefined ? {} : { orchestrationId: entry.orchestrationId }),
    ...(entry.shardId === undefined ? {} : { shardId: entry.shardId }),
    ...(entry.siblingShardIds === undefined ? {} : { siblingShardIds: entry.siblingShardIds }),
    ...(entry.pieceIndex === undefined ? {} : { pieceIndex: entry.pieceIndex }),
    pieceTotal: entry.pieceTotal,
    ...(entry.shardIdentityReadFailure === undefined ? {} : { shardIdentityReadFailure: entry.shardIdentityReadFailure }),
  };
}

function shardSiblingsForRun(
  runId: string,
  identity: RunChainShardIdentity | null,
  ledgersByRunId: ReadonlyMap<string, readonly RunLedgerEntry[]>,
): RunChainShardSibling[] {
  if (!identity?.orchestrationId) return [];
  const siblings: RunChainShardSibling[] = [];
  for (const [candidateRunId, ledger] of ledgersByRunId) {
    if (candidateRunId === runId) continue;
    const candidate = latestRunShardIdentity(ledger);
    if (candidate?.orchestrationId !== identity.orchestrationId) continue;
    siblings.push({ runId: candidateRunId, ...(candidate.shardId === undefined ? {} : { shardId: candidate.shardId }), ...(candidate.pieceIndex === undefined ? {} : { pieceIndex: candidate.pieceIndex }) });
  }
  return siblings.sort((left, right) => (left.pieceIndex ?? Number.MAX_SAFE_INTEGER) - (right.pieceIndex ?? Number.MAX_SAFE_INTEGER) || left.runId.localeCompare(right.runId));
}

const RUN_CHAIN_CACHE_LIMIT = 32;

type RunChainSourceStamp = readonly string[];
type RunChainCacheEntry = { stamp: RunChainSourceStamp; query: RunChainQuery };
const runChainCache = new Map<string, RunChainCacheEntry>();
const readFunctionIds = new WeakMap<RunLedgerReader, number>();
let nextReadFunctionId = 1;

function runChainCacheKey(options: RunChainQueryOptions, logStorePath: string): string | null {
  // An injected store has no filesystem freshness marker, so it must remain live.
  if (options.logStore || options.list) return null;
  const scope = `${options.from ?? ''}\u0000${options.to ?? ''}`;
  const read = options.read;
  if (!read) return `${resolve(options.dir ?? runLedgerDir())}\u0000${logStorePath}\u0000${scope}\u0000default`;
  let id = readFunctionIds.get(read);
  if (!id) { id = nextReadFunctionId++; readFunctionIds.set(read, id); }
  return `${resolve(options.dir ?? runLedgerDir())}\u0000${logStorePath}\u0000${scope}\u0000read:${id}`;
}

function sourceStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    return `${path}:${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'}`;
  }
}

function runChainSourceStamp(ledgerDirectory: string, logStorePath: string): RunChainSourceStamp {
  let ledgerFiles: string[];
  try { ledgerFiles = readdirSync(ledgerDirectory).filter((name) => name.endsWith('.jsonl')).sort(); }
  catch (error) { ledgerFiles = [(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-directory' : 'unreadable-directory']; }
  return [
    sourceStamp(ledgerDirectory),
    ...ledgerFiles.map((name) => sourceStamp(join(ledgerDirectory, name))),
    sourceStamp(logStorePath),
    sourceStamp(`${logStorePath}-wal`),
    sourceStamp(`${logStorePath}-shm`),
  ];
}

function cloneRunChain(query: RunChainQuery): RunChainQuery {
  return structuredClone(query);
}

function cacheRunChain(key: string | null, stamp: RunChainSourceStamp, query: RunChainQuery): RunChainQuery {
  if (key === null) return query;
  runChainCache.set(key, { stamp, query: cloneRunChain(query) });
  if (runChainCache.size > RUN_CHAIN_CACHE_LIMIT) runChainCache.delete(runChainCache.keys().next().value!);
  return cloneRunChain(query);
}

/** Join an observable run to existing observations without repairing missing wiring or writing either store. */
export function queryRunChain(options: RunChainQueryOptions = {}): RunChainQuery {
  const logStorePath = resolve(options.logStorePath ?? logsDbPath());
  const cacheKey = runChainCacheKey(options, logStorePath);
  const beforeStamp = runChainSourceStamp(resolve(options.dir ?? runLedgerDir()), logStorePath);
  const cached = cacheKey === null ? undefined : runChainCache.get(cacheKey);
  if (cached && cached.stamp.join('\u0000') === beforeStamp.join('\u0000')) return cloneRunChain(cached.query);
  const scan = scanMergedRunLedgers(options);
  const observed = scan.query;
  if (observed.entries.length === 0) {
    return cacheRunChain(cacheKey, beforeStamp, {
      entries: [], ledgerDirectory: observed.ledgerDirectory,
      excludedMergedEntryCount: observed.excludedMergedEntryCount, excludedLedgerCount: observed.excludedLedgerCount,
      unreadableLedgerCount: observed.unreadableLedgerCount, logStorePath, logStoreStatus: 'missing',
      scope: 'self-implement-run-chain', note: RUN_CHAIN_NOTE,
    });
  }
  // ⭐ `queryRunScreenKey` 와 «같은 심»을 쓴다 — 위 `openRunLogStoreReadOnly` 의 주석 참조.
  const opened = openRunLogStoreReadOnly(logStorePath, options.logStore);
  const openedStore = opened.opened;
  const store = opened.store;
  const logStoreStatus: RunChainQuery['logStoreStatus'] = opened.status;

  try {
    let observedRows: readonly LogStoreRow[] | null = null;
    let unreadableRunIds = new Set<string>();
    const unreadableDispatchSessions = new Set<string>();
    if (store?.queryRunChainRows) {
      try {
        const batch = store.queryRunChainRows([...new Set(observed.entries.map((entry) => entry.runId))]);
        observedRows = batch.rows;
        unreadableRunIds = new Set(batch.unreadableRunIds);
      } catch { observedRows = null; }
    } else if (store) {
      const directRows: LogStoreRow[] = [];
      const dispatchRows: LogStoreRow[] = [];
      for (const runId of new Set(observed.entries.map((entry) => entry.runId))) {
        try { directRows.push(...queryRunLogRows(store, runId)); }
        catch { unreadableRunIds.add(runId); }
      }
      for (const row of directRows) {
        const data = parseLogPayload(row);
        const originSession = row.category === 'dev-pipeline' && row.event === 'plan' ? stringField(data, 'originSession') : null;
        if (originSession === null) continue;
        try {
          dispatchRows.push(...queryAll(store, {
            exactCategories: ['daemon-tools.self-implement'], events: ['dispatch'], grep: originSession,
          }));
        } catch { unreadableDispatchSessions.add(originSession); }
      }
      observedRows = [...directRows, ...dispatchRows];
    }
    const rowsForObservedRun = observedRows === null ? new Map<string, readonly LogStoreRow[]>() : rowsByRunId(observedRows);
    const entries = observed.entries.map((ledgerEntry): RunChainEntry => {
      const rows = observedRows === null || unreadableRunIds.has(ledgerEntry.runId)
        ? null
        : rowsForObservedRun.get(ledgerEntry.runId) ?? [];
      const payloads = (rows ?? []).map((row) => ({ row, data: parseLogPayload(row) }));
      const plan = payloads.find(({ row, data }) => row.category === 'dev-pipeline' && row.event === 'plan' && stringField(data, 'runId') === ledgerEntry.runId)?.data ?? null;
      const originSession = stringField(plan, 'originSession');
      const goalSource = goalSourceForRun(payloads, ledgerEntry.runId);
      const daemonObservationStatus = daemonObservationApplicability(goalSource);
      let dispatch: LogPayload | null = null;
      let dispatchQueryFailed = false;
      if (daemonObservationStatus === 'applicable' && originSession !== null) {
        if (observedRows !== null) {
          dispatch = dispatchForSession(observedRows, originSession);
          dispatchQueryFailed = unreadableDispatchSessions.has(originSession);
        } else dispatchQueryFailed = true;
      }
      const done = payloads.find(({ row, data }) => row.category === 'daemon-tools.self-implement' && row.event === 'done' && stringField(data, 'runId') === ledgerEntry.runId)?.data ?? null;
      const directObservationsReadable = rows !== null && logStoreStatus === 'read';
      const donePrNumber = prNumberFromUrl(stringField(done, 'pr'));
      const planMatchesRun = plan !== null && stringField(plan, 'runId') === ledgerEntry.runId;
      const requestFingerprint = fingerprint(stringField(dispatch, 'userText'));
      const shardIdentity = latestRunShardIdentity(scan.ledgersByRunId.get(ledgerEntry.runId));
      return {
        fingerprint: requestFingerprint,
        goalId: stringField(plan, 'goalId'),
        runId: ledgerEntry.runId,
        prNumber: ledgerEntry.prNumber,
        merged: ledgerEntry.merged,
        originRoot: stringField(plan, 'originRoot'),
        originAgent: stringField(plan, 'originAgent'),
        originSession,
        goalSource,
        shardIdentity,
        shardSiblings: shardSiblingsForRun(ledgerEntry.runId, shardIdentity, scan.ledgersByRunId),
        hops: {
          fingerprint: !directObservationsReadable || daemonObservationStatus === 'not-countable' || dispatchQueryFailed ? 'not-countable' : daemonObservationStatus === 'not-applicable' ? 'not-applicable' : requestFingerprint !== null && plan !== null && originSession !== null ? 'connected' : 'broken',
          goalId: !directObservationsReadable ? 'not-countable' : planMatchesRun && stringField(plan, 'goalId') !== null ? 'connected' : 'broken',
          runId: !directObservationsReadable || daemonObservationStatus === 'not-countable' ? 'not-countable' : daemonObservationStatus === 'not-applicable' ? 'not-applicable' : planMatchesRun && done !== null ? 'connected' : 'broken',
          pr: !directObservationsReadable || daemonObservationStatus === 'not-countable' ? 'not-countable' : daemonObservationStatus === 'not-applicable' ? 'not-applicable' : donePrNumber === null ? 'broken' : donePrNumber === ledgerEntry.prNumber ? 'connected' : 'broken',
          merged: ledgerEntry.merged ? 'connected' : 'broken',
        },
      };
    });
    const query = {
      entries,
      ledgerDirectory: observed.ledgerDirectory,
      excludedMergedEntryCount: observed.excludedMergedEntryCount,
      excludedLedgerCount: observed.excludedLedgerCount,
      unreadableLedgerCount: observed.unreadableLedgerCount,
      logStorePath,
      logStoreStatus,
      scope: 'self-implement-run-chain' as const,
      note: RUN_CHAIN_NOTE,
    };
    const afterStamp = runChainSourceStamp(observed.ledgerDirectory, logStorePath);
    // A concurrent writer invalidates this read rather than letting it seed a stale cache entry.
    return beforeStamp.join('\u0000') === afterStamp.join('\u0000') ? cacheRunChain(cacheKey, afterStamp, query) : query;
  } finally {
    openedStore?.close();
  }
}

export function renderRunChain(query: RunChainQuery): string {
  const header = `ledger directory: ${query.ledgerDirectory}\nlog store: ${query.logStorePath} (${query.logStoreStatus})\nexcluded ledgers: ${query.excludedLedgerCount}; excluded merged entries: ${query.excludedMergedEntryCount}; unreadable ledgers: ${query.unreadableLedgerCount}`;
  const rows = query.entries.map((entry) => `fingerprint=${entry.fingerprint ?? 'unknown'} goalId=${entry.goalId ?? 'unknown'} runId=${entry.runId} PR=${entry.prNumber ?? 'unknown'} merged=${entry.merged} goalSource=${JSON.stringify(entry.goalSource)} hops=fingerprint:${entry.hops.fingerprint},goalId:${entry.hops.goalId},runId:${entry.hops.runId},PR:${entry.hops.pr},merged:${entry.hops.merged}`);
  return [header, ...(rows.length ? rows : ['none']), `note: ${query.note}`].join('\n');
}

export interface PrGoalAcceptanceLookup {
  acceptance?: string;
  goalLoaded: boolean;
  acceptanceChars: number;
}

export type LookupPrGoalAcceptanceOptions = RunChainQueryOptions;

const MISSING_PR_GOAL_ACCEPTANCE: PrGoalAcceptanceLookup = { goalLoaded: false, acceptanceChars: 0 };

function missingPrGoalAcceptance(): PrGoalAcceptanceLookup {
  return { ...MISSING_PR_GOAL_ACCEPTANCE };
}

function matchingRunChainEntry(entries: readonly RunChainEntry[], prNumber: number): RunChainEntry | undefined {
  return entries.find((entry) => entry.prNumber === prNumber);
}

function readGoalDocumentForRun(
  runId: string,
  options: LookupPrGoalAcceptanceOptions,
): { goalLoaded: false } | { goalLoaded: true; goalDocument: string } {
  const ledgerDirectory = resolve(options.dir ?? runLedgerDir());
  const read = options.read ?? readFileSync;
  const ledger = loadRunLedger(runId, ledgerDirectory, read);
  if (ledger === null) return { goalLoaded: false };
  const goalFile = ledgerGoalDocument(ledger);
  if (goalFile === null) return { goalLoaded: false };
  const goalDocument = read(goalFile, 'utf8');
  return { goalLoaded: true, goalDocument: typeof goalDocument === 'string' ? goalDocument : goalDocument.toString('utf8') };
}

/** PR 번호 → 그 PR 을 낳은 골의 「판정 신호」 절. 원장에 없거나 조회/읽기가 실패하면 값이 없다.
 *  추출 계보 = extractHarnessReviewAcceptance (supervisorGoalDigest → splitGoalSections → isSupervisorDecisionSection). */
export function lookupPrGoalAcceptance(
  prNumber: number,
  options: LookupPrGoalAcceptanceOptions = {},
): PrGoalAcceptanceLookup {
  try {
    const chain = queryRunChain(options);
    const entry = matchingRunChainEntry(chain.entries, prNumber);
    if (!entry) return missingPrGoalAcceptance();
    const loaded = readGoalDocumentForRun(entry.runId, options);
    if (!loaded.goalLoaded) return missingPrGoalAcceptance();
    const { acceptance } = extractHarnessReviewAcceptance(loaded.goalDocument);
    if (!acceptance) return { goalLoaded: true, acceptanceChars: 0 };
    return { acceptance, goalLoaded: true, acceptanceChars: acceptance.length };
  } catch {
    return missingPrGoalAcceptance();
  }
}

type LedgerRoundSummary = {
  round: number;
  blocking: number | null;
  findingIds: 'absent' | 'recorded';
  repeated: 'unknown' | 'none' | number;
  budgetBefore: number | null;
  budgetAfter: number | null;
  verdict: string | null;
  refutable: number | null;
  submitted: number | null;
  citedReviewSymbolRepeatCount: number | null;
  citedReviewSymbolBaseNameRepeatCount: number | null;
  reviewFindingComparableCount: number | null;
  reviewFindingKeyRepeatCount?: number | null;
  recurrenceDisagreementKind: string | null;
};

function finiteNumber(data: Record<string, unknown>, field: string): number | null {
  const value = data[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundNumber(entry: RunLedgerEntry): number | null {
  const round = finiteNumber(entry.data, 'round');
  return round !== null && Number.isInteger(round) && round >= 0 ? round : null;
}

/** Read-only display projection of producer events; it does not write derived values to the ledger. */
export function summarizeRunLedgerRounds(entries: readonly RunLedgerEntry[]): readonly LedgerRoundSummary[] {
  const rounds = new Map<number, LedgerRoundSummary>();
  const summaryFor = (round: number): LedgerRoundSummary => {
    const existing = rounds.get(round);
    if (existing) return existing;
    const created: LedgerRoundSummary = {
      round,
      blocking: null,
      findingIds: 'absent',
      repeated: 'unknown',
      budgetBefore: null,
      budgetAfter: null,
      verdict: null,
      refutable: null,
      submitted: null,
      citedReviewSymbolRepeatCount: null,
      citedReviewSymbolBaseNameRepeatCount: null,
      reviewFindingComparableCount: null,
      reviewFindingKeyRepeatCount: null,
      recurrenceDisagreementKind: null,
    };
    rounds.set(round, created);
    return created;
  };

  for (const entry of entries) {
    const round = roundNumber(entry);
    if (round === null) continue;
    if (!['reviewed', 'rework-budget', 'refute-not-submitted', 'refute-submitted'].includes(entry.event)) continue;
    const summary = summaryFor(round);
    if (entry.event === 'reviewed') {
      summary.blocking = finiteNumber(entry.data, 'mustFix');
      if (Array.isArray(entry.data.findingIds)) summary.findingIds = 'recorded';
    } else if (entry.event === 'rework-budget') {
      const repeated = finiteNumber(entry.data, 'repeatedBlockingFindingCount');
      summary.repeated = repeated === null ? 'unknown' : repeated === 0 ? 'none' : repeated;
      summary.budgetBefore = finiteNumber(entry.data, 'effectiveMaxBefore') ?? finiteNumber(entry.data, 'beforeBudget');
      summary.budgetAfter = finiteNumber(entry.data, 'effectiveMaxAfter') ?? finiteNumber(entry.data, 'afterBudget');
      summary.verdict = typeof entry.data.verdict === 'string' ? entry.data.verdict : entry.data.verdict === null ? 'none' : null;
      summary.citedReviewSymbolRepeatCount = finiteNumber(entry.data, 'citedReviewSymbolRepeatCount');
      summary.citedReviewSymbolBaseNameRepeatCount = finiteNumber(entry.data, 'citedReviewSymbolBaseNameRepeatCount');
      summary.reviewFindingComparableCount = finiteNumber(entry.data, 'reviewFindingComparableCount');
      summary.reviewFindingKeyRepeatCount = finiteNumber(entry.data, 'reviewFindingKeyRepeatCount');
      summary.recurrenceDisagreementKind = typeof entry.data.recurrenceDisagreementKind === 'string'
        ? entry.data.recurrenceDisagreementKind
        : entry.data.recurrenceDisagreementKind === null ? 'none' : null;
    } else {
      summary.refutable = finiteNumber(entry.data, 'refutableCount') ?? summary.refutable;
      // `submittedCount` is authoritative: findingIds may be absent or have a different length.
      summary.submitted = finiteNumber(entry.data, 'submittedCount') ?? summary.submitted;
    }
  }
  return [...rounds.values()].sort((left, right) => left.round - right.round);
}

function renderRoundSummary(summary: LedgerRoundSummary): string {
  const value = (number: number | null) => number === null ? 'absent' : String(number);
  const repeated = typeof summary.repeated === 'number' ? String(summary.repeated) : summary.repeated;
  const comparable = summary.reviewFindingComparableCount;
  const comparableMeasured = comparable !== null && comparable > 0;
  // comparable 0/missing means "could not compare", not "zero repeats". Keep that
  // off the numeric alphabet so it cannot be read as measured 0, and keep it off
  // the word `unmeasured` which is a distinct disagreement-kind value.
  const symbolRepeat = comparableMeasured ? value(summary.citedReviewSymbolRepeatCount) : 'incomparable';
  const symbolBaseRepeat = comparableMeasured ? value(summary.citedReviewSymbolBaseNameRepeatCount) : 'incomparable';
  const keyRepeat = comparableMeasured ? value(summary.reviewFindingKeyRepeatCount ?? null) : 'incomparable';
  const comparableLabel = comparable === null ? 'absent' : comparable === 0 ? 'incomparable' : String(comparable);
  return `rework-summary round=${summary.round} blocking=${value(summary.blocking)} repeated=${repeated} findingIds=${summary.findingIds} budget=${value(summary.budgetBefore)}->${value(summary.budgetAfter)} verdict=${summary.verdict ?? 'absent'} refutations=eligible:${value(summary.refutable)},submitted:${value(summary.submitted)} symbolRepeat=${symbolRepeat} symbolBaseRepeat=${symbolBaseRepeat} keyRepeat=${keyRepeat} comparable=${comparableLabel} disagreement=${summary.recurrenceDisagreementKind ?? 'absent'}`;
}

export function renderRunLedger(entries: readonly RunLedgerEntry[]): string {
  const rawRows = entries.map((entry) => {
    const goal = entry.goalId ? ` goalId=${entry.goalId}` : '';
    return `${entry.timestamp ?? ''} ${entry.event} runId=${entry.runId}${goal} ${JSON.stringify(entry.data)}`;
  });
  const summaries = summarizeRunLedgerRounds(entries).map(renderRoundSummary);
  return [...rawRows, ...(summaries.length ? summaries : ['rework-summary measured=none'])].join('\n');
}
