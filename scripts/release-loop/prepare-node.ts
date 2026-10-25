#!/usr/bin/env bun
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { errorResult, finishNode, lastResult, nodeOutput, readGraphContext, runCommand, type CommandRunner } from './node-verdict.js';
import { isReleaseVersion } from './release-version.js';

/** Apparent bytes of the preserved archive; never follow a symlink out of its private directory. */
function archiveBytes(path: string): number {
  const entry = lstatSync(path);
  if (!entry.isDirectory()) return entry.size;
  return readdirSync(path).reduce((sum, name) => sum + archiveBytes(join(path, name)), 0);
}

function readRegularManifest(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`prepared manifest is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function releaseAttempt(root: string, version: string, runId: string): number {
  const path = join(root, 'release', version, 'resume-attempts', `${runId}.json`);
  if (!existsSync(path)) return 0;
  let value: { version?: unknown; runId?: unknown; attempts?: unknown };
  try { value = JSON.parse(readFileSync(path, 'utf8')) as typeof value; }
  catch { throw new Error(`invalid release resume attempts: ${path}`); }
  if (value.version !== version || value.runId !== runId || !Array.isArray(value.attempts)
    || value.attempts.some((at) => typeof at !== 'string' || !Number.isFinite(Date.parse(at))))
    throw new Error(`invalid release resume attempts: ${path}`);
  return value.attempts.length;
}

/** Old releases predate the owner receipt; their own graph ledger can still prove the prepared output. */
function preparedByRun(root: string, runId: string, out: string, commit: string): boolean {
  try {
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'release-loop', `${runId}.json`), 'utf8')) as
      { runId?: string; graphId?: string; nodes?: Array<{ nodeId?: string; ok?: boolean; output?: string }> };
    if (ledger.runId !== runId || ledger.graphId !== 'release-loop') return false;
    return ledger.nodes?.some((node) => {
      if (node.nodeId !== 'prepare' || !node.ok || typeof node.output !== 'string') return false;
      try {
        const output = JSON.parse(node.output.trim().split('\n').at(-1) ?? '') as { out?: string; commit?: string; outcome?: string };
        return output.outcome === 'ok' && output.out === out && output.commit === commit;
      } catch { return false; }
    }) ?? false;
  } catch { return false; }
}

export function runPrepare(run: CommandRunner = runCommand, move: typeof renameSync = renameSync) {
  const context = readGraphContext();
  const { version, previousVersion } = context.input;
  if (!isReleaseVersion(version)) throw new Error(`invalid release version: ${version}`);
  if (context.runId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context.runId)) throw new Error('invalid release runId');
  const commit = nodeOutput(context, 'version-release', 'commit');
  for (const node of ['gate', 'pwa']) if (context.outputs[node]?.outcome !== 'ok') throw new Error(`${node} did not pass`);
  const root = effectiveInstanceRoot();
  const attempt = context.runId ? releaseAttempt(root, version, context.runId) : undefined;
  const out = join(root, 'release', version, 'prepared');
  if ([join(root, 'release'), join(root, 'release', version)]
    .some((path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()))
    throw new Error(`prepare output escapes release root: ${out}`);
  let staleSource: string | undefined;
  let staleManifestBytes: Buffer | undefined;
  let staleParents: Array<{ path: string; dev: number; ino: number; real: string }> | undefined;
  const occupied = lstatSync(out, { throwIfNoEntry: false });
  if (occupied) {
    // Only a tip refresh can prove that this archive belongs to the prior commit. An incomplete or unknown
    // archive is left untouched for investigation; never erase it merely because the path is occupied.
    const old = context.outputs['version-release']?.refreshedFrom;
    const manifestPath = join(out, 'release.json');
    if (!occupied.isDirectory() || !existsSync(manifestPath) || !lstatSync(manifestPath).isFile())
      throw new Error(`prepare output already exists with unverified source: ${out}`);
    if (realpathSync(out) !== join(realpathSync(root), 'release', version, 'prepared'))
      throw new Error(`prepare output escapes release root: ${out}`);
    let manifest: { version?: unknown; sourceCommit?: unknown };
    try { staleManifestBytes = readRegularManifest(manifestPath); manifest = JSON.parse(staleManifestBytes.toString('utf8')) as typeof manifest; }
    catch { throw new Error(`prepare output already exists with unreadable manifest: ${out}`); }
    const manifestSource = manifest.sourceCommit;
    if (manifest.version !== version || typeof manifestSource !== 'string' || !/^[0-9a-f]{40}$/i.test(manifestSource)
      || (manifestSource !== commit && manifestSource !== old))
      throw new Error(`prepare output already exists for another source: ${out}`);
    const ownerPath = join(out, '.release-node-owner.json');
    let owner: { runId?: string; commit?: string } | undefined;
    if (existsSync(ownerPath)) {
      try { owner = JSON.parse(readRegularManifest(ownerPath).toString('utf8')) as typeof owner; }
      catch { throw new Error(`prepare output owner unreadable: ${out}`); }
    }
    const sameRun = !!context.runId && (owner?.runId === context.runId && owner.commit === manifestSource
      || !owner && preparedByRun(root, context.runId, out, manifestSource));
    if (manifestSource === commit && sameRun) {
      const candidate = join(out, 'dist', 'elanous.tgz');
      if (!existsSync(candidate)) throw new Error(`prepare output incomplete for same run: ${out}`);
      return { outcome: 'ok' as const, verdict: 'pass' as const,
        summary: `prepare ${version} · ${commit.slice(0, 12)} reused`, out, candidate, commit,
        artifactOwner: { runId: context.runId, attempt, reused: true } };
    }
    // A different run's complete archive is never consumed. Without a verified owner, an archive at the
    // current tip remains untouched; a refreshed old tip can still follow the existing guarded quarantine.
    if (manifestSource === commit && !owner?.runId)
      throw new Error(`prepare output already exists with unverified owner: ${out}`);
    if (manifestSource !== commit && (typeof old !== 'string' || !/^[0-9a-f]{40}$/i.test(old) || old === commit))
      throw new Error(`prepare output already exists with unverified source: ${out}`);
    staleParents = [join(root, 'release'), join(root, 'release', version)].map((path) => {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`prepare output escapes release root: ${out}`);
      return { path, dev: stat.dev, ino: stat.ino, real: realpathSync(path) };
    });
    staleSource = manifestSource;
  }
  const ref = `v${previousVersion}^{commit}`;
  const prev = run('git', ['rev-parse', '--verify', ref]);
  if (prev.status !== 0 || !/^[0-9a-f]{40}\s*$/i.test(prev.stdout)) throw new Error(`previous release ref unavailable: ${ref}`);
  if (staleSource) {
    const current = lstatSync(out, { throwIfNoEntry: false });
    const manifestPath = join(out, 'release.json');
    if (!current?.isDirectory() || current.dev !== occupied?.dev || current.ino !== occupied?.ino
      || !lstatSync(manifestPath, { throwIfNoEntry: false })?.isFile()
      || [join(root, 'release'), join(root, 'release', version)]
        .some((path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()))
      throw new Error(`prepared output changed before cleanup: ${out}`);
    if (realpathSync(out) !== join(realpathSync(root), 'release', version, 'prepared'))
      throw new Error(`prepare output escapes release root: ${out}`);
    let manifestBytes: Buffer;
    try { manifestBytes = readRegularManifest(manifestPath); }
    catch { throw new Error(`prepared manifest changed before cleanup: ${out}`); }
    if (!staleManifestBytes?.equals(manifestBytes))
      throw new Error(`prepared manifest changed before cleanup: ${out}`);
    // Rename is atomic on this filesystem. Preserve the moved inode even if it differs from the checked one;
    // no later operation deletes a quarantine directory or follows a link inside the archive.
    const quarantine = mkdtempSync(join(realpathSync(root), '.prepared-cleanup-'));
    const moved = join(quarantine, 'prepared');
    move(out, moved);
    const movedStat = lstatSync(moved);
    let movedManifestBytes: Buffer | undefined;
    try { movedManifestBytes = readRegularManifest(join(moved, 'release.json')); }
    catch { /* preserve the quarantined archive for inspection */ }
    if (!movedStat.isDirectory() || movedStat.dev !== occupied?.dev || movedStat.ino !== occupied?.ino
      || !staleManifestBytes || !movedManifestBytes?.equals(staleManifestBytes))
      throw new Error(`prepared output changed during cleanup; preserved at ${moved}`);
    const receipt = join(quarantine, 'receipt.json');
    const record = { version, old: staleSource, commit, from: out, to: moved, movedAt: new Date().toISOString(),
      bytes: null as number | null, sizeStatus: 'pending' as 'pending' | 'measured' | 'unmeasured', sizeError: undefined as string | undefined };
    try { writeFileSync(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { throw new Error(`prepared archive preserved at ${moved}; receipt write failed: ${String(error)}`); }
    try { record.bytes = archiveBytes(moved); record.sizeStatus = 'measured'; }
    catch (error) { record.sizeStatus = 'unmeasured'; record.sizeError = String(error).slice(0, 200); }
    const receiptNext = join(quarantine, 'receipt.next.json');
    try {
      writeFileSync(receiptNext, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(receiptNext, receipt);
    } catch (error) { throw new Error(`prepared archive preserved at ${moved}; receipt update failed: ${String(error)}`); }
    debug.log('release-loop.prepare', 'stale-prepared-quarantined', { version, old: staleSource, commit,
      from: out, to: moved, bytes: record.bytes, sizeStatus: record.sizeStatus, receipt });
    const parentsStable = staleParents?.every(({ path, dev, ino, real }) => {
      try {
        const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino
          && realpathSync(path) === real;
      } catch { return false; }
    });
    if (!parentsStable || lstatSync(out, { throwIfNoEntry: false }))
      throw new Error(`prepare parent changed after quarantine; preserved at ${moved}`);
  }
  const command = run('bun', ['bin/elanous.mjs', 'release', 'prepare', '--version', version, '--source', commit, '--notes-from', prev.stdout.trim(), '--out', out, '--json']);
  if (command.stderr) process.stderr.write(command.stderr);
  const manifest = lastResult(command)?.manifest as { version?: string; sourceCommit?: string; distDir?: string } | undefined;
  if (command.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `prepare failed: ${lastResult(command)?.error ?? command.stderr.trim()}` };
  if (command.status !== 0 || manifest?.version !== version || manifest.sourceCommit !== commit || manifest.distDir !== join(out, 'dist')) {
    throw new Error(`prepare incomplete (rc=${command.status}): ${lastResult(command)?.error ?? command.stderr.trim()}`);
  }
  const artifactOwner = context.runId ? { runId: context.runId, attempt, commit } : undefined;
  if (artifactOwner && existsSync(join(out, 'release.json')))
    writeFileSync(join(out, '.release-node-owner.json'), JSON.stringify(artifactOwner) + '\n', { flag: 'wx', mode: 0o600 });
  return { outcome: 'ok' as const, verdict: 'pass' as const, summary: `prepare ${version} · ${commit.slice(0, 12)}`, out, candidate: join(out, 'dist', 'elanous.tgz'), commit,
    ...(artifactOwner ? { artifactOwner } : {}) };
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('prepare', version, runPrepare()); }
  catch (error) { process.exitCode = finishNode('prepare', version, errorResult(error)); }
}
