#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { buildReleaseManifest, parseNextMdNotes, type NextMdNote, type ReleaseLanding } from '../../src/release-loop/manifest.js';
import { readReleaseNotes, releaseNotesDir } from '../../src/release-loop/release-note.js';
import { queryRunningRuns } from '../../src/self-implement/running-runs.js';
import { loadFederatedRunLedger } from '../../src/self-implement/run-ledger.js';

const SEED = 'c1cc37478';
const CLI_DOC = 'release/public/docs/cli.md';
const NEXT_MD = 'release/next.md';

function git(args: string[], optional = false): string | null {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return result.stdout.trimEnd();
  if (optional && result.status === 128) return null;
  throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error || 'unknown error').toString().trim()}`);
}

function requiredGit(args: string[]): string {
  return git(args)!;
}

function versionParts(value: string): number[] | null {
  if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
  return value.split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function baselineFor(version: string, cutoff: string, flag?: string): { ref: string; source: 'flag' | 'tag' | 'seed' } {
  if (flag) return { ref: flag, source: 'flag' };
  const current = versionParts(version)!;
  const tags = requiredGit(['tag', '--list', 'v[0-9]*', '--merged', cutoff]).split('\n')
    .filter((tag) => versionParts(tag.slice(1)) !== null && compareVersions(versionParts(tag.slice(1))!, current) < 0)
    .sort((a, b) => compareVersions(versionParts(b.slice(1))!, versionParts(a.slice(1))!));
  return tags.length ? { ref: tags[0]!, source: 'tag' } : { ref: SEED, source: 'seed' };
}

function commandsAt(sha: string): string[] {
  const doc = requiredGit(['show', `${sha}:${CLI_DOC}`]);
  // The generated reference defines public command surfaces at its section headings.
  return [...doc.matchAll(/^## `((?:elanous)(?: [^`]+))`\s*$/gm)].map((match) => match[1]!);
}

function landingAt(sha: string, title: string): ReleaseLanding {
  const changedFiles = requiredGit(['show', '-m', '--first-parent', '--format=', '--name-only', sha]).split('\n').filter(Boolean);
  const goalPath = changedFiles.find((file) => /^docs\/goals\/[^/]+\.md$/.test(file));
  const header = goalPath ? git(['show', `${sha}:${goalPath}`], true)?.split(/^##?\s/m, 1)[0] ?? '' : '';
  const releaseTarget = /^release-target:\s*(next|later)\s*$/m.exec(header)?.[1] as 'next' | 'later' | undefined;
  const pr = /\s*\(#(\d+)\)$/.exec(title);
  return {
    sha, title: pr ? title.slice(0, pr.index) : title,
    ...(pr ? { prNumber: Number(pr[1]) } : {}), changedFiles,
    ...(goalPath ? { goalPath } : {}), ...(releaseTarget ? { releaseTarget } : {}),
  };
}

/**
 * next.md lines added between the baseline and the cutoff, each tied to the last landing in range whose diff added that
 * exact line. Lines already in the file at the baseline shipped with an earlier release and are left out (REL7b).
 */
function nextMdNotes(baseline: string, cutoff: string, landings: ReleaseLanding[]): { notes: NextMdNote[]; carried: number } {
  const text = git(['show', `${cutoff}:${NEXT_MD}`], true);
  if (!text) return { notes: [], carried: 0 };
  const inRange = new Set(addedLines(requiredGit(['diff', '-U0', baseline, cutoff, '--', NEXT_MD])));
  const addedBy = new Map<string, string>();
  for (const landing of landings) {
    if (!landing.changedFiles.includes(NEXT_MD)) continue;
    const diff = requiredGit(['show', '-m', '--first-parent', '--format=', '-U0', landing.sha, '--', NEXT_MD]);
    for (const line of addedLines(diff)) addedBy.set(line, landing.sha);
  }
  const all = parseNextMdNotes(text);
  const notes = all.filter((note) => note.raw !== undefined && inRange.has(note.raw)).map((note) => {
    const sha = addedBy.get(note.raw!);
    return { kind: note.kind, line: note.line, ...(sha ? { sha } : {}) };
  });
  return { notes, carried: all.length - notes.length };
}

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1).trim());
}

function runningGoalPaths(): string[] {
  const repo = process.cwd();
  const paths: string[] = [];
  for (const entry of queryRunningRuns().entries) {
    if (entry.status !== 'running' && entry.status !== 'probable-running') continue;
    const start = loadFederatedRunLedger(entry.runId)?.find((row) => row.event === 'start');
    const goalFile = start?.data.goalFile;
    if (typeof goalFile !== 'string') continue;
    const absolute = resolve(repo, goalFile);
    if (!isAbsolute(goalFile)) {
      const path = relative(repo, absolute).replaceAll('\\', '/');
      if (/^docs\/goals\/[^/]+\.md$/.test(path)) paths.push(path);
      continue;
    }
    const worktreeRoot = git(['-C', dirname(absolute), 'rev-parse', '--show-toplevel'], true);
    if (!worktreeRoot) continue;
    let path: string;
    try {
      path = relative(realpathSync(worktreeRoot), realpathSync(absolute)).replaceAll('\\', '/');
    } catch {
      continue;
    }
    if (/^docs\/goals\/[^/]+\.md$/.test(path)) paths.push(path);
  }
  return paths;
}

export function main(args: string[] = process.argv.slice(2)): void {
  let version: string | undefined;
  let baselineFlag: string | undefined;
  let cutoffFlag: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--version' || arg === '--baseline' || arg === '--cutoff') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`value required for ${arg}`);
      if (arg === '--version') version = value;
      else if (arg === '--baseline') baselineFlag = value;
      else cutoffFlag = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!version || !versionParts(version)) throw new Error('usage: bun scripts/release-loop/cutoff.ts --version <x.y.z> [--baseline <ref>] [--cutoff <ref>] [--json]');
  const cutoff = requiredGit(['rev-parse', '--verify', `${cutoffFlag ?? 'origin/main'}^{commit}`]);
  const baseline = baselineFor(version, cutoff, baselineFlag);
  const baselineSha = requiredGit(['rev-parse', '--verify', `${baseline.ref}^{commit}`]);
  const log = requiredGit(['log', '--first-parent', '--reverse', '--format=%H%x1f%s', `${baselineSha}..${cutoff}`]);
  const landings = log ? log.split('\n').map((line) => {
    const [sha, title] = line.split('\x1f');
    return landingAt(sha!, title!);
  }) : [];
  const instanceRoot = effectiveInstanceRoot();
  const notes = readReleaseNotes(releaseNotesDir(instanceRoot));
  debug.log('release.notes', 'read', { fragments: notes.size, problems: notes.problems });
  const nextMd = nextMdNotes(baselineSha, cutoff, landings);
  const manifest = buildReleaseManifest({
    version, baseline: { ref: baseline.ref, sha: baselineSha }, cutoff: { sha: cutoff }, landings, notes, nextMd: nextMd.notes,
    runningGoalPaths: runningGoalPaths(), publicCommandsBefore: commandsAt(baselineSha), publicCommandsAfter: commandsAt(cutoff),
  });
  const output = { ...manifest, baselineSource: baseline.source };
  debug.log('release-loop.notes', 'fragments', { version, ...manifest.fragments, carriedFromEarlier: nextMd.carried });
  const directory = join(instanceRoot, 'release', version);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(output, null, 2) + '\n');
  debug.log('release-loop.cutoff', 'manifest', {
    version, baselineSource: baseline.source, in: output.in.length, deferred: output.deferred.length, escalate: output.escalate.length,
  });
  console.error(`조각 있음 ${landings.filter((landing) => landing.prNumber !== undefined && notes.has(landing.prNumber)).length} / 착지 ${landings.length}`);
  if (json) console.log(JSON.stringify(output));
}

if (import.meta.main) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
