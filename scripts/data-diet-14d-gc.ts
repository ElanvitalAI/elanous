#!/usr/bin/env bun
/**
 * DATA-DIET-14D-GC
 *
 * Preview is the default. `--apply` deletes only terminal, unreferenced data
 * past the fixed retention window. Conversation, failed/HITL run-ledger, and
 * incident evidence archives are verified in the approved private bucket
 * before their source is removed.
 */
import {
  constants as fsConstants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { getActiveSessionId, sessionRoot } from '../src/session/index.js';
import { elanousStateRoot } from '../src/autopilot/state-paths.js';
import { hasTerminalRunStatus, loadRunLedgerWithMetadata, runLedgerDir, runLedgerPath } from '../src/self-implement/run-ledger.js';
import { withRunLedgerLock } from '../src/self-implement/run-ledger-compact.js';
import type { RunLedgerEntry } from '../src/self-implement/run-ledger.js';

const RETENTION_DAYS = 14;
const APPROVED_BUCKET = 'elanvital-elanous-ops';
const APPROVED_PREFIX = 'archive/data-diet';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DataDietRoots {
  state: string;
  sessions: string;
  runLedger: string;
  screens: string;
  backups: string;
  evidence: string;
}

export interface DataDietOptions {
  now?: number;
  roots?: Partial<DataDietRoots>;
  activeSessionId?: string | null;
  activeRunIds?: ReadonlySet<string>;
  apply?: boolean;
  bucket?: string;
  archivePrefix?: string;
  /** Test seams keep archive packaging and AWS available to isolated tests. */
  archiveWriter?: typeof createTarZst;
  awsCommand?: (args: readonly string[], expectJson: boolean) => string | void;
}

export interface ArchiveReceipt { key: string; sha256: string; bytes: number }

export interface DataDietSummary {
  cutoff: string;
  mode: 'dry-run' | 'apply';
  candidates: Record<string, number>;
  removed: Record<string, number>;
  archived: Record<string, number>;
  archives: Array<{ scope: string; key: string; sha256: string; bytes: number }>;
  bytes: Record<string, number>;
  held: Record<string, number>;
}

export interface FileCandidate { path: string; rel: string; size: number; mtimeMs: number; ino: number; dev: number; sourceSha256?: string }
interface LedgerCandidate extends FileCandidate { runId: string; disposition: 'delete' | 'archive'; sourceSha256: string }
interface SessionCandidate extends FileCandidate { sourceSha256: string }

function defaultRoots(overrides: Partial<DataDietRoots> = {}): DataDietRoots {
  const state = overrides.state ?? elanousStateRoot();
  const hq = join(homedir(), 'elanous-hq');
  return {
    state,
    sessions: overrides.sessions ?? sessionRoot(),
    runLedger: overrides.runLedger ?? runLedgerDir(state),
    screens: overrides.screens ?? join(state, 'harness-screens'),
    backups: overrides.backups ?? join(state, 'backups'),
    evidence: overrides.evidence ?? join(hq, 'seat-state', 'OP', 'evidence'),
  };
}

function cutoffFor(now: number): number { return now - RETENTION_DAYS * DAY_MS; }

function safeStat(path: string): FileCandidate | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { path, rel: '', size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
  } catch { return null; }
}

function walkFiles(root: string): FileCandidate[] {
  let rootStat;
  try { rootStat = lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`unsafe GC root: ${root}`);
  const out: FileCandidate[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const candidate = safeStat(path);
        if (candidate) out.push({ ...candidate, rel: relative(root, path) });
      }
    }
  };
  visit(root);
  return out;
}

function older(candidate: FileCandidate, cutoff: number): boolean { return candidate.mtimeMs < cutoff; }

function sameSnapshot(candidate: FileCandidate): boolean {
  try {
    const current = lstatSync(candidate.path);
    return current.isFile() && !current.isSymbolicLink()
      && current.dev === candidate.dev && current.ino === candidate.ino
      && current.size === candidate.size && current.mtimeMs === candidate.mtimeMs;
  } catch { return false; }
}

function sameContentSnapshot(candidate: FileCandidate & { sourceSha256: string }): boolean {
  if (!sameSnapshot(candidate)) return false;
  try { return createHash('sha256').update(readFileSync(candidate.path)).digest('hex') === candidate.sourceSha256; }
  catch { return false; }
}

function removeIfUnchanged(candidate: FileCandidate): boolean {
  if (!sameSnapshot(candidate)) return false;
  unlinkSync(candidate.path);
  return true;
}

function bytesOf(candidates: readonly FileCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.size, 0);
}

function dateKey(now: number): string { return new Date(now).toISOString().slice(0, 10); }
function safeObjectName(name: string): string { return name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'archive'; }

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function createTarZst(root: string, relPaths: readonly string[], out: string): Promise<void> {
  if (relPaths.length === 0 || relPaths.some((p) => isAbsolute(p) || p.split(sep).includes('..'))) {
    throw new Error('archive paths must be non-empty and relative to the approved root');
  }
  const tar = spawn('tar', ['-cf', '-', '-C', root, '--', ...relPaths], { stdio: ['ignore', 'pipe', 'pipe'] });
  const zstd = spawn('zstd', ['-q', '-T0', '-o', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let tarErr = '';
  let zstdErr = '';
  tar.stderr.setEncoding('utf8').on('data', (chunk: string) => { tarErr += chunk; });
  zstd.stderr.setEncoding('utf8').on('data', (chunk: string) => { zstdErr += chunk; });
  tar.stdout.pipe(zstd.stdin);
  const status = (child: ReturnType<typeof spawn>): Promise<number> => new Promise((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveStatus(code ?? 1));
  });
  const [tarCode, zstdCode] = await Promise.all([status(tar), status(zstd)]);
  if (tarCode !== 0 || zstdCode !== 0) {
    throw new Error(`archive failed (tar=${tarCode}, zstd=${zstdCode}; ${tarErr.slice(0, 160)} ${zstdErr.slice(0, 160)})`);
  }
}

async function archiveAndVerify(
  root: string, candidates: readonly FileCandidate[], options: Required<Pick<DataDietOptions, 'bucket' | 'archivePrefix'>>,
  now: number, label: string, awsCommand?: DataDietOptions['awsCommand'], archiveWriter?: DataDietOptions['archiveWriter'],
): Promise<ArchiveReceipt> {
  const temp = mkdtempSync(join(tmpdir(), 'data-diet-gc-'));
  const archive = join(temp, `${safeObjectName(label)}.tar.zst`);
  try {
    await (archiveWriter ?? createTarZst)(root, candidates.map((c) => c.rel), archive);
    const digest = await sha256(archive);
    const size = statSync(archive).size;
    const key = `${options.archivePrefix}/${dateKey(now)}/${safeObjectName(label)}-${digest.slice(0, 12)}.tar.zst`;
    const expectedChecksum = Buffer.from(digest, 'hex').toString('base64');
    // PutObject accepts a caller-supplied full-object checksum; S3 rejects a
    // mismatched body before storing it. Oversized (>5 GiB) archives fail closed.
    const putArgs = [
      's3api', 'put-object', '--bucket', options.bucket, '--key', key, '--body', archive,
      '--storage-class', 'DEEP_ARCHIVE', '--server-side-encryption', 'AES256',
      '--checksum-algorithm', 'SHA256', '--checksum-sha256', expectedChecksum,
    ];
    const runAws = awsCommand ?? ((args: readonly string[], expectJson: boolean): string | void => {
      if (!expectJson) { execFileSync('aws', [...args], { stdio: 'ignore' }); return; }
      return execFileSync('aws', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    });
    runAws(putArgs, false);
    const headArgs = ['s3api', 'head-object', '--bucket', options.bucket, '--key', key, '--checksum-mode', 'ENABLED', '--output', 'json'];
    const response = runAws(headArgs, true);
    if (typeof response !== 'string') throw new Error(`archive head-object returned no JSON for ${key}`);
    const head = JSON.parse(response) as { ContentLength?: number; StorageClass?: string; ServerSideEncryption?: string; ChecksumSHA256?: string };
    if (head.ContentLength !== size || head.StorageClass !== 'DEEP_ARCHIVE' || head.ServerSideEncryption !== 'AES256'
      || head.ChecksumSHA256 !== expectedChecksum) {
      throw new Error(`archive verification failed for ${key}`);
    }
    return { key, sha256: digest, bytes: size };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function terminalLedgerStatus(entries: readonly RunLedgerEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.event === 'run-status' && typeof entries[i]?.data.runStatus === 'string') {
      return String(entries[i]!.data.runStatus);
    }
  }
  return entries.some((entry) => entry.event === 'terminal' || entry.event === 'human-stop') ? 'failed' : null;
}

function isHitlLedger(entries: readonly RunLedgerEntry[]): boolean {
  return entries.some((entry) => /hitl|human-stop|human-intervention/i.test(entry.event)
    || String(entry.data.kind ?? '').toLowerCase() === 'hitl');
}

type ScreenClaimState = 'absent' | 'alive' | 'dead' | 'unknown';
function screenClaimState(path: string): ScreenClaimState {
  let record: unknown;
  try { record = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'; }
  if (!record || typeof record !== 'object' || typeof (record as { pid?: unknown }).pid !== 'number'
    || !Number.isSafeInteger((record as { pid: number }).pid) || (record as { pid: number }).pid <= 0) return 'unknown';
  try { process.kill((record as { pid: number }).pid, 0); return 'alive'; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'dead';
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export function removeScreenIfUnchanged(candidate: FileCandidate, cutoff: number, activeRunIds: ReadonlySet<string>): boolean {
  if (!older(candidate, cutoff) || !sameSnapshot(candidate) || [...activeRunIds].some((id) => candidate.rel.includes(id))) return false;
  const claimPath = candidate.path.replace(/\.(?:claim|screen|hb)$/, '.claim');
  const state = screenClaimState(claimPath);
  if (state === 'alive' || state === 'unknown') return false;
  if (candidate.rel.endsWith('.claim') && state !== 'dead') return false;
  unlinkSync(candidate.path);
  return true;
}

function runLedgerInventory(root: string, cutoff: number, activeRunIds: ReadonlySet<string>): {
  candidates: LedgerCandidate[]; held: number; unavailable: boolean; unfinishedRunIds: ReadonlySet<string>;
} {
  const unfinished = new Set<string>();
  const candidates: LedgerCandidate[] = [];
  let held = 0;
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { candidates, held, unavailable: false, unfinishedRunIds: unfinished };
    return { candidates, held: 1, unavailable: true, unfinishedRunIds: unfinished };
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name.startsWith('.')) continue;
    const runId = name.slice(0, -'.jsonl'.length);
    let path: string;
    try { path = runLedgerPath(runId, root); } catch { held += 1; continue; }
    const candidate = safeStat(path);
    if (!candidate) continue;
    let loaded;
    try { loaded = loadRunLedgerWithMetadata(runId, root); }
    catch { return { candidates: [], held: held + 1, unavailable: true, unfinishedRunIds: unfinished }; }
    if (!loaded) return { candidates: [], held: held + 1, unavailable: true, unfinishedRunIds: unfinished };
    if (loaded.skippedTrailingBytes !== undefined) {
      unfinished.add(runId);
      if (older(candidate, cutoff)) held += 1;
      continue;
    }
    const entries = loaded.entries;
    if (!hasTerminalRunStatus(entries)) {
      unfinished.add(runId);
      if (older(candidate, cutoff)) held += 1;
      continue;
    }
    if (!older(candidate, cutoff)) continue;
    if (activeRunIds.has(runId)) { held += 1; continue; }
    const status = terminalLedgerStatus(entries);
    if (!status) { held += 1; continue; }
    let sourceSha256: string;
    try { sourceSha256 = createHash('sha256').update(readFileSync(path)).digest('hex'); }
    catch { held += 1; continue; }
    candidates.push({ ...candidate, runId, disposition: status === 'failed' || isHitlLedger(entries) ? 'archive' : 'delete', sourceSha256 });
  }
  return { candidates, held, unavailable: false, unfinishedRunIds: unfinished };
}

export function screenCandidates(root: string, cutoff: number, activeRunIds: ReadonlySet<string>): { candidates: FileCandidate[]; held: number } {
  const files = walkFiles(root);
  const activeClaimBases = new Set<string>();
  for (const claim of files.filter((file) => file.rel.endsWith('.claim'))) {
    if (!older(claim, cutoff)) { activeClaimBases.add(claim.path.slice(0, -'.claim'.length)); continue; }
    const state = screenClaimState(claim.path);
    if (state === 'alive' || state === 'unknown') activeClaimBases.add(claim.path.slice(0, -'.claim'.length));
  }
  const candidates: FileCandidate[] = [];
  let held = 0;
  for (const file of files) {
    if (!older(file, cutoff)) continue;
    const base = file.path.replace(/\.(?:claim|screen|hb)$/, '');
    if (activeClaimBases.has(base) || [...activeRunIds].some((id) => file.rel.includes(id))) { held += 1; continue; }
    if (file.rel.endsWith('.claim') && screenClaimState(file.path) !== 'dead') { held += 1; continue; }
    candidates.push(file);
  }
  return { candidates, held };
}

export function backupCandidates(root: string, cutoff: number): { candidates: FileCandidate[]; held: number } {
  const files = walkFiles(root);
  const families = new Map<string, FileCandidate[]>();
  for (const file of files) {
    const segments = file.rel.split(sep);
    // A flat backup has no trustworthy family identity; retain it for human classification.
    if (segments.length < 2) continue;
    const group = families.get(segments[0]!) ?? [];
    group.push(file);
    families.set(segments[0]!, group);
  }
  const candidates: FileCandidate[] = [];
  let held = files.length - [...families.values()].reduce((sum, group) => sum + group.length, 0);
  for (const group of families.values()) {
    const newest = group.reduce((left, right) => left.mtimeMs >= right.mtimeMs ? left : right);
    for (const file of group) {
      if (file.path === newest.path || !older(file, cutoff)) { held += 1; continue; }
      candidates.push(file);
    }
  }
  return { candidates, held };
}

export function removeBackupIfSuperseded(candidate: FileCandidate, root: string, cutoff: number): boolean {
  if (!older(candidate, cutoff) || !sameSnapshot(candidate)) return false;
  const family = candidate.rel.split(sep)[0];
  if (!family || !candidate.rel.includes(sep)) return false;
  const currentFamily = walkFiles(root).filter((file) => file.rel.split(sep)[0] === family);
  if (currentFamily.length === 0) return false;
  const newest = currentFamily.reduce((left, right) => left.mtimeMs >= right.mtimeMs ? left : right);
  if (newest.path === candidate.path) return false;
  return removeIfUnchanged(candidate);
}

function evidenceCandidates(root: string, cutoff: number, activeRunIds: ReadonlySet<string>): {
  remove: FileCandidate[]; archive: FileCandidate[]; held: number;
} {
  const files = walkFiles(root);
  const remove: FileCandidate[] = [];
  const archive: FileCandidate[] = [];
  let held = 0;
  for (const file of files) {
    if (!older(file, cutoff) || [...activeRunIds].some((id) => file.rel.includes(id))) { held += 1; continue; }
    // Evidence-path naming is not a reliable value classifier; archive every eligible
    // evidence file and remove its source only after the archive receipt is verified.
    archive.push(file);
  }
  return { remove, archive, held };
}

function sessionCandidates(root: string, cutoff: number, activeId: string | null): {
  candidates: SessionCandidate[]; ids: string[]; held: number; unavailable: boolean;
} {
  let index: unknown;
  try { index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { candidates: [], ids: [], held: 0, unavailable: false };
    return { candidates: [], ids: [], held: 1, unavailable: true };
  }
  if (!Array.isArray(index)) return { candidates: [], ids: [], held: 1, unavailable: true };
  const candidates: SessionCandidate[] = [];
  const ids: string[] = [];
  let held = 0;
  for (const meta of index) {
    if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string' || typeof meta.updatedAt !== 'string') { held += 1; continue; }
    const updatedAt = Date.parse(meta.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt >= cutoff || meta.id === activeId) { held += 1; continue; }
    const path = join(root, `${meta.id}.jsonl`);
    const candidate = safeStat(path);
    if (!candidate || !older(candidate, cutoff)) { held += 1; continue; }
    try {
      const sourceSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      candidates.push({ ...candidate, rel: `${meta.id}.jsonl`, sourceSha256 });
    } catch { held += 1; continue; }
    ids.push(meta.id);
  }
  return { candidates, ids, held, unavailable: false };
}

export async function runDataDietGc(options: DataDietOptions = {}): Promise<DataDietSummary> {
  const now = options.now ?? Date.now();
  const cutoff = cutoffFor(now);
  const roots = defaultRoots(options.roots);
  const activeSession = options.activeSessionId === undefined ? getActiveSessionId() : options.activeSessionId;
  const callerActiveRunIds = options.activeRunIds ?? new Set<string>();
  const bucket = options.bucket ?? APPROVED_BUCKET;
  const archivePrefix = options.archivePrefix ?? APPROVED_PREFIX;
  if (bucket !== APPROVED_BUCKET || archivePrefix !== APPROVED_PREFIX) throw new Error('archive target differs from the OP-approved private bucket');
  for (const [name, path] of Object.entries(roots)) {
    if (!isAbsolute(path) || path === '/' || path === homedir()) throw new Error(`unsafe ${name} root`);
  }

  const sessions = sessionCandidates(roots.sessions, cutoff, activeSession);
  const ledger = runLedgerInventory(roots.runLedger, cutoff, callerActiveRunIds);
  const activeRunIds = new Set([...callerActiveRunIds, ...ledger.unfinishedRunIds]);
  const screens = screenCandidates(roots.screens, cutoff, activeRunIds);
  const backups = backupCandidates(roots.backups, cutoff);
  const evidence = evidenceCandidates(roots.evidence, cutoff, activeRunIds);
  const candidates = {
    sessions: sessions.candidates.length,
    runLedger: ledger.candidates.length,
    screens: screens.candidates.length,
    backups: backups.candidates.length,
    evidenceDelete: evidence.remove.length,
    evidenceArchive: evidence.archive.length,
  };
  const summary: DataDietSummary = {
    cutoff: new Date(cutoff).toISOString(), mode: options.apply ? 'apply' : 'dry-run',
    candidates, removed: {}, archived: {}, archives: [],
    bytes: {
      sessions: bytesOf(sessions.candidates),
      runLedger: bytesOf(ledger.candidates),
      screens: bytesOf(screens.candidates),
      backups: bytesOf(backups.candidates),
      evidence: bytesOf([...evidence.remove, ...evidence.archive]),
    },
    held: {
      sessions: sessions.held + (sessions.unavailable ? 1 : 0),
      runLedger: ledger.held + (ledger.unavailable ? 1 : 0),
      screens: screens.held,
      backups: backups.held,
      evidence: evidence.held,
    },
  };
  if (!options.apply) return summary;

  if (sessions.unavailable || ledger.unavailable) throw new Error('session or run-ledger inventory incomplete; no apply performed');
  const archiveOptions = { bucket, archivePrefix };
  const archivedCounts: Record<string, number> = {};
  const removed: Record<string, number> = {};

  if (sessions.candidates.length && sessions.candidates.every(sameContentSnapshot)) {
    const receipt = await archiveAndVerify(roots.sessions, sessions.candidates, archiveOptions, now, 'sessions-older14d', options.awsCommand, options.archiveWriter);
    summary.archives.push({ scope: 'sessions', ...receipt });
    if (sessions.candidates.every(sameContentSnapshot) && (options.activeSessionId !== undefined || getActiveSessionId() === activeSession)) {
      const { deleteSessions } = await import('../src/session/index.js');
      const count = deleteSessions(sessions.ids, roots.sessions);
      archivedCounts.sessions = count;
      removed.sessions = count;
    }
  }

  const failedLedgers = ledger.candidates.filter((c) => c.disposition === 'archive');
  const plainLedgers = ledger.candidates.filter((c) => c.disposition === 'delete');
  for (const candidate of plainLedgers) {
    const count = withRunLedgerLock(roots.runLedger, candidate.runId, () => {
      const current = safeStat(candidate.path);
      const currentLedger = loadRunLedgerWithMetadata(candidate.runId, roots.runLedger);
      if (!current || !older(current, cutoff) || !currentLedger || currentLedger.skippedTrailingBytes !== undefined
        || !hasTerminalRunStatus(currentLedger.entries)
        || !sameContentSnapshot(candidate) || activeRunIds.has(candidate.runId)) return 0;
      unlinkSync(candidate.path);
      return 1;
    });
    if (count) removed.runLedger = (removed.runLedger ?? 0) + count;
  }
  if (failedLedgers.length && failedLedgers.every(sameContentSnapshot)) {
    const stagedRoot = mkdtempSync(join(tmpdir(), 'data-diet-ledger-'));
    try {
      const staged = failedLedgers.map((candidate) => {
        const target = join(stagedRoot, `${candidate.runId}.jsonl`);
        withRunLedgerLock(roots.runLedger, candidate.runId, () => {
          if (!sameContentSnapshot(candidate) || activeRunIds.has(candidate.runId)) throw new Error('run ledger changed during archive staging');
          copyFileSync(candidate.path, target, fsConstants.COPYFILE_EXCL);
        });
        return { ...candidate, path: target, rel: `${candidate.runId}.jsonl` };
      });
      const receipt = await archiveAndVerify(stagedRoot, staged, archiveOptions, now, 'run-ledger-failure-hitl-older14d', options.awsCommand, options.archiveWriter);
      summary.archives.push({ scope: 'runLedger', ...receipt });
      for (const candidate of failedLedgers) {
        const count = withRunLedgerLock(roots.runLedger, candidate.runId, () => {
          if (!sameContentSnapshot(candidate) || activeRunIds.has(candidate.runId)) return 0;
          unlinkSync(candidate.path);
          return 1;
        });
        if (count) { archivedCounts.runLedger = (archivedCounts.runLedger ?? 0) + count; removed.runLedger = (removed.runLedger ?? 0) + count; }
      }
    } finally { rmSync(stagedRoot, { recursive: true, force: true }); }
  }

  for (const [name, group] of [['screens', screens.candidates], ['backups', backups.candidates], ['evidence', evidence.remove]] as const) {
    for (const candidate of group) {
      const didRemove = name === 'screens'
        ? removeScreenIfUnchanged(candidate, cutoff, activeRunIds)
        : name === 'backups'
          ? removeBackupIfSuperseded(candidate, roots.backups, cutoff)
        : removeIfUnchanged(candidate);
      if (didRemove) removed[name] = (removed[name] ?? 0) + 1;
    }
  }
  if (evidence.archive.length && evidence.archive.every(sameSnapshot)) {
    const stagedRoot = mkdtempSync(join(tmpdir(), 'data-diet-evidence-'));
    try {
      const staged: FileCandidate[] = [];
      const sourceHashes = new Map<string, string>();
      for (const candidate of evidence.archive) {
        if (!sameSnapshot(candidate)) throw new Error('incident evidence changed before archive staging');
        const sourceSha256 = await sha256(candidate.path);
        if (!sameSnapshot(candidate)) throw new Error('incident evidence changed while hashing');
        const target = join(stagedRoot, candidate.rel);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(candidate.path, target);
        if (await sha256(target) !== sourceSha256) throw new Error('incident evidence changed while staging');
        sourceHashes.set(candidate.path, sourceSha256);
        staged.push({ ...candidate, path: target });
      }
      const receipt = await archiveAndVerify(stagedRoot, staged, archiveOptions, now, 'evidence-incidents-older14d', options.awsCommand, options.archiveWriter);
      summary.archives.push({ scope: 'evidence', ...receipt });
      for (const candidate of evidence.archive) {
        const expected = sourceHashes.get(candidate.path);
        if (!expected || !sameSnapshot(candidate) || await sha256(candidate.path) !== expected) continue;
        if (removeIfUnchanged(candidate)) { archivedCounts.evidence = (archivedCounts.evidence ?? 0) + 1; removed.evidence = (removed.evidence ?? 0) + 1; }
      }
    } finally { rmSync(stagedRoot, { recursive: true, force: true }); }
  }
  summary.removed = removed;
  summary.archived = archivedCounts;
  return summary;
}

function parseArgs(args: string[]): { apply: boolean } {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun scripts/data-diet-14d-gc.ts [--dry-run|--apply]\nDefault is dry-run. Apply uploads approved archives and verifies DEEP_ARCHIVE + AES256 before deleting source.');
    process.exit(0);
  }
  if (args.some((arg) => !['--dry-run', '--apply'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('usage: data-diet-14d-gc.ts [--dry-run|--apply]');
  }
  return { apply: args.includes('--apply') };
}

export async function runDataDietGcCli(
  args: string[],
  overrides: DataDietOptions & { receiptPath?: string; writeLine?: (line: string) => void } = {},
): Promise<DataDietSummary> {
  const parsed = parseArgs(args);
  const summary = await runDataDietGc({ ...overrides, apply: parsed.apply });
  (overrides.writeLine ?? console.log)(`[data-diet-14d-gc] ${JSON.stringify(summary)}`);
  if (parsed.apply) {
    const receiptPath = overrides.receiptPath ?? join(elanousStateRoot(), 'data-diet-14d-gc.jsonl');
    try {
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify({ at: new Date().toISOString(), ...summary })}\n`, { flag: 'a' });
    } catch { /* GC stdout remains available when local journaling fails. */ }
  }
  return summary;
}

if (import.meta.main) {
  runDataDietGcCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[data-diet-14d-gc] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
