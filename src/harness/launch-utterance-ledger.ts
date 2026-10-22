import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';

/** Product ledger of the raw first text a launch entrance received (say · hand · ask-file).
 *  Auxiliary evidence: preparing or appending never refuses a launch — failures are observed. */
export interface LaunchUtteranceStart {
  readonly event: 'start';
  readonly launchId: string;
  readonly source: 'say' | 'hand' | 'ask-file';
  readonly utterance: string;
  /** sha256 of the UTF-8 bytes of `utterance` (or of the raw bytes when given). */
  readonly sha256: string;
  /** Present only when the raw source bytes are not lossless UTF-8 (ask-file). */
  readonly utteranceBase64?: string;
  /** Present for `say`: the exact argv words the process received. */
  readonly argv?: readonly string[];
  /** The entrance was asked for a plan only (`--dry-run`) — the text was received, nothing launched. */
  readonly dryRun?: true;
  readonly at: string;
}

export interface LaunchUtteranceInput {
  readonly source: LaunchUtteranceStart['source'];
  readonly utterance: string;
  readonly launchId: string;
  readonly rawBytes?: Uint8Array;
  readonly argv?: readonly string[];
  readonly dryRun?: boolean;
}

const LAUNCH_ID = /^tl-[0-9a-f]{12}$/;
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 86_400_000;

/** Env contract of the one explicit hand→say pair (set by the hand launcher, consumed once by say). */
export const HAND_LAUNCH_ID_ENV = 'ELANOUS_HAND_LAUNCH_ID';
export const HAND_LAUNCH_SHA256_ENV = 'ELANOUS_HAND_LAUNCH_SHA256';
export const HAND_LAUNCH_RUN_ENV = 'ELANOUS_HAND_LAUNCH_RUN';
/** base64 of the hand's exact original text (untrimmed), so the paired child can re-record it byte-exact. */
export const HAND_LAUNCH_ORIGINAL_ENV = 'ELANOUS_HAND_LAUNCH_ORIGINAL_B64';
const MAX_ORIGINAL_ENV_BYTES = 64 * 1024;

/** Same `tl-<12 hex>` shape the hand card contract already carries; minted fresh in every process. */
export function newLaunchUtteranceId(): string { return `tl-${randomBytes(6).toString('hex')}`; }
export function isLaunchUtteranceId(value: unknown): value is string { return typeof value === 'string' && LAUNCH_ID.test(value); }
export function utteranceSha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }

/** Env a hand launcher passes to its say child so that pair — and only that pair — shares the ID.
 *  `sentence` is the exact argv word the say child receives; `original` is the hand's untrimmed text. */
export function handLaunchPairEnv(launchId: string, sentence: string, runId: string, original?: string): Record<string, string> {
  const originalB64 = original === undefined ? undefined : Buffer.from(original, 'utf8').toString('base64');
  return {
    [HAND_LAUNCH_ID_ENV]: launchId, [HAND_LAUNCH_SHA256_ENV]: utteranceSha256(sentence), [HAND_LAUNCH_RUN_ENV]: runId,
    ...(originalB64 !== undefined && originalB64.length <= MAX_ORIGINAL_ENV_BYTES ? { [HAND_LAUNCH_ORIGINAL_ENV]: originalB64 } : {}),
  };
}

/** Hand launcher seam: only a `harness say <sentence>` launch with a launchId ⊕ runId gets the pair env
 *  (ID ⊕ sentence sha ⊕ runId ⊕ exact original). Any other launch context passes through unchanged. */
export function withHandLaunchPairContext<C extends { launchId?: string; runId?: string; env: Record<string, string>; launchUtterance?: string }>(
  args: readonly string[], context: C,
): C {
  const sayAt = args.indexOf('say');
  const sentence = args.at(-1);
  if (!context.launchId || !context.runId || sayAt < 1 || args[sayAt - 1] !== 'harness' || sentence === undefined || sayAt === args.length - 1) return context;
  return { ...context, env: { ...context.env, ...handLaunchPairEnv(context.launchId, sentence, context.runId, context.launchUtterance) } };
}

/** Resolve the say launchId: inherit only when the env pair matches this exact sentence and run, then
 *  remove the pair from `env` so no descendant or later say in this process can reuse the ID.
 *  When paired, `utterance` is the hand's exact original text (falls back to the sentence). */
export function consumeHandLaunchId(sentence: string, env: NodeJS.ProcessEnv = process.env, runIdEnv = 'ELANOUS_RUN_ID'): {
  launchId: string; inherited: boolean; utterance: string;
} {
  const inherited = env[HAND_LAUNCH_ID_ENV];
  const sha = env[HAND_LAUNCH_SHA256_ENV];
  const run = env[HAND_LAUNCH_RUN_ENV];
  const originalB64 = env[HAND_LAUNCH_ORIGINAL_ENV];
  for (const key of [HAND_LAUNCH_ID_ENV, HAND_LAUNCH_SHA256_ENV, HAND_LAUNCH_RUN_ENV, HAND_LAUNCH_ORIGINAL_ENV]) delete env[key];
  const paired = isLaunchUtteranceId(inherited) && sha === utteranceSha256(sentence)
    && typeof run === 'string' && run.length > 0 && env[runIdEnv] === run;
  if (inherited !== undefined && !paired) {
    try { debug.log('harness.launch-utterance', 'inherit-refused', { hasSha: sha !== undefined, hasRun: run !== undefined }); } catch { /* fail-soft */ }
  }
  if (!paired) return { launchId: newLaunchUtteranceId(), inherited: false, utterance: sentence };
  const original = originalB64 === undefined ? undefined : Buffer.from(originalB64, 'base64').toString('utf8');
  const utterance = original !== undefined && original.trim() === sentence.trim() ? original : sentence;
  return { launchId: inherited, inherited: true, utterance };
}

/** Symlink policy over every component of `path`, parents included: a symlink owned by the system
 *  (uid 0 — e.g. macOS `/var` · `/tmp`) is an OS alias and allowed; any other symlink is refused, so a
 *  user-made link can never redirect one instance's ledger into another instance. */
export function assertLedgerPathPolicy(path: string): void {
  if (!path.trim()) throw new Error('ledger path must not be empty');
  const absolute = resolve(path);
  let part = parse(absolute).root;
  for (const segment of absolute.slice(part.length).split('/').filter(Boolean)) {
    part = join(part, segment);
    let stat;
    try { stat = lstatSync(part); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() && stat.uid !== 0) throw new Error(`ledger symlink refused: ${part}`);
  }
}

export function launchUtteranceDir(root: string = effectiveInstanceRoot()): string {
  return join(resolve(root), 'launch-utterances');
}

function observeFailure(operation: 'prepare' | 'append' | 'query', error: unknown, extra: Record<string, unknown> = {}): void {
  const reason = error instanceof Error ? error.message : String(error);
  try { debug.log('harness.launch-utterance', `${operation}-failed`, { operation, reason, ...extra }, { level: 'warn' }); } catch { /* logging must not block launch */ }
  try { console.error(`[launch-utterance] ${operation} failed: ${reason}`); } catch { /* fail-soft */ }
}

function buildRow(input: LaunchUtteranceInput, now: Date): LaunchUtteranceStart {
  const raw = input.rawBytes;
  const lossy = raw !== undefined && !Buffer.from(input.utterance, 'utf8').equals(Buffer.from(raw));
  return {
    event: 'start',
    launchId: input.launchId,
    source: input.source,
    utterance: input.utterance,
    sha256: utteranceSha256(raw ?? input.utterance),
    ...(lossy ? { utteranceBase64: Buffer.from(raw).toString('base64') } : {}),
    ...(input.argv ? { argv: [...input.argv] } : {}),
    ...(input.dryRun === true ? { dryRun: true as const } : {}),
    at: now.toISOString(),
  };
}

/** Append one start row to this instance's date file. Returns whether it landed; never throws. */
export function recordLaunchUtterance(
  input: LaunchUtteranceInput,
  root: string = effectiveInstanceRoot(),
  now: Date = new Date(),
): boolean {
  let dir: string;
  let row: string;
  try {
    if (!isLaunchUtteranceId(input.launchId)) throw new Error(`invalid launchId: ${String(input.launchId)}`);
    dir = launchUtteranceDir(root);
    assertLedgerPathPolicy(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertLedgerPathPolicy(dir);
    if (!lstatSync(dir).isDirectory()) throw new Error(`ledger dir is not a directory: ${dir}`);
    row = `${JSON.stringify(buildRow(input, now))}\n`;
  } catch (error) { observeFailure('prepare', error, { source: input.source, launchId: input.launchId }); return false; }
  try {
    const file = join(dir, `${now.toISOString().slice(0, 10)}.jsonl`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`ledger file is not a regular file: ${file}`);
      writeSync(fd, row);
    } finally { closeSync(fd); }
    try { debug.log('harness.launch-utterance', 'recorded', { source: input.source, launchId: input.launchId }); } catch { /* fail-soft */ }
    return true;
  } catch (error) { observeFailure('append', error, { source: input.source, launchId: input.launchId }); return false; }
}

function readNoFollow(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`ledger file is not a regular file: ${file}`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** Reads only this instance's date files that overlap [now - sinceMs, now], and rows inside that window. */
export function queryLaunchUtterances(options: { root?: string; sinceMs?: number; now?: Date } = {}): LaunchUtteranceStart[] {
  const now = options.now ?? new Date();
  const sinceMs = options.sinceMs ?? DAY_MS;
  if (!Number.isFinite(sinceMs) || sinceMs < 0 || sinceMs > 31 * DAY_MS) throw new Error('invalid ledger query window');
  const until = now.getTime();
  const from = until - sinceMs;
  const dir = launchUtteranceDir(options.root);
  let names: string[];
  try {
    assertLedgerPathPolicy(dir);
    if (!lstatSync(dir).isDirectory()) throw new Error(`ledger dir is not a directory: ${dir}`);
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') observeFailure('query', error);
    return [];
  }
  const rows: LaunchUtteranceStart[] = [];
  for (const name of names.filter((n) => DATE_FILE.test(n)).sort()) {
    const day = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
    if (!Number.isFinite(day) || day > until || day + DAY_MS <= from) continue;
    let text: string;
    try { text = readNoFollow(join(dir, name)); } catch (error) { observeFailure('query', error, { file: name }); continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as LaunchUtteranceStart;
        const at = Date.parse(row.at);
        if (row.event === 'start' && typeof row.utterance === 'string' && Number.isFinite(at) && at >= from && at <= until) rows.push(row);
      } catch { /* skip torn line */ }
    }
  }
  return rows;
}
