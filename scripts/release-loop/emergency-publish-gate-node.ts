#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { LIGHT_RC_ALWAYS_FILE, parseAlwaysIncludeList, runLightRc, type LightRcResult } from '../../src/release-loop/light-rc.js';
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export interface EmergencyPublishGateGit {
  resolveCommit(ref: string): string | undefined;
  isAncestor(ancestor: string, descendant: string): boolean;
  pathsChangedByCommit(commit: string): string[];
  treeEntryAt(commit: string, path: string): { mode: string; type: string; object: string } | null;
}

export function readGitTreeEntry(commit: string, path: string,
  runGit: (args: string[]) => { status: number | null; error?: Error; stdout: string; stderr: string } = (args) =>
    spawnSync('git', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })):
  { mode: string; type: string; object: string } | null {
  const result = runGit(['--literal-pathspecs', 'ls-tree', '-z', commit, '--', path]);
  if (result.status !== 0 || result.error) throw new Error(`cannot inspect ${commit.slice(0, 12)}:${path}: ${(result.stderr || result.error || 'no output').toString().trim()}`);
  const entry = result.stdout.split('\0').find((candidate) => {
    const tab = candidate.indexOf('\t');
    return tab >= 0 && candidate.slice(tab + 1) === path;
  });
  if (!entry) return null;
  const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t/.exec(entry);
  if (!match) throw new Error(`cannot parse tree entry for ${commit.slice(0, 12)}:${path}`);
  return { mode: match[1]!, type: match[2]!, object: match[3]! };
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  const git: EmergencyPublishGateGit = {
    resolveCommit(ref) {
      const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
    isAncestor(ancestor, descendant) {
      const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      return result.status === 0;
    },
    pathsChangedByCommit(commit) {
      const result = spawnSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', commit], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0 || result.error) throw new Error(`cannot inspect hotfix commit diff: ${(result.stderr || result.error || 'no output').toString().trim()}`);
      return result.stdout.split(/\r?\n/).filter(Boolean);
    },
    treeEntryAt(commit, path) {
      return readGitTreeEntry(commit, path);
    },
  };
  process.exitCode = await runEmergencyPublishGateNode(process.env,
    (version, options) => runLightRc(version, { ...options, legacySelfGate: true }), git);
}

export interface EmergencyPublishGateRunner {
  (version: string, options: { base: string; head: string; remote: string }): Promise<LightRcResult>;
}

function gateEvidenceFailure(result: LightRcResult, mandatoryTests: readonly string[]): string | undefined {
  if (!Array.isArray(result.changedFiles) || result.changedFiles.length === 0
    || !result.changedFiles.every((path) => typeof path === 'string' && path.trim().length > 0))
    return 'reduced gate changed-file evidence is missing';
  if (!Array.isArray(result.testFiles) || !result.testFiles.every((path) => typeof path === 'string' && path.trim().length > 0))
    return 'reduced gate test-file evidence is missing';
  if (!Number.isSafeInteger(result.alwaysInclude) || result.alwaysInclude !== mandatoryTests.length
    || !Array.isArray(result.alwaysIncludeMissing) || result.alwaysIncludeMissing.length > 0
    || mandatoryTests.some((path) => !result.testFiles!.includes(path)))
    return 'reduced gate mandatory release tests are missing';
  if (typeof result.introduced !== 'number' || typeof result.preexisting !== 'number' || result.unclassified !== 0)
    return 'reduced gate measurement evidence is incomplete';
  return undefined;
}

export async function runEmergencyPublishGateNode(env: NodeJS.ProcessEnv = process.env,
  runGate: EmergencyPublishGateRunner, git: EmergencyPublishGateGit): Promise<number> {
  try {
    const context = readGraphContext(env);
    const emergency = context.input.emergencyPublish && typeof context.input.emergencyPublish === 'object'
      ? context.input.emergencyPublish as Record<string, unknown> : {};
    const switched = context.outputs['emergency-switch'];
    const commits = emergency.hotfixCommits;
    const rawHotfixCommit = Array.isArray(commits) && commits.length === 1 && typeof commits[0] === 'string' ? commits[0] : '';
    const hotfixCommit = COMMIT_SHA.test(rawHotfixCommit) ? rawHotfixCommit.toLowerCase() : '';
    const releaseCommit = context.outputs['version-release']?.commit;
    const remote = emergency.remote;
    const previousVersion = context.input.previousVersion;
    if (switched?.action !== 'switch' || switched.promoted !== true || switched.normalRunId !== context.runId
      || !hotfixCommit || !COMMIT_SHA.test(hotfixCommit) || typeof switched.hotfixCommit !== 'string'
      || switched.hotfixCommit.toLowerCase() !== hotfixCommit)
      throw new Error('emergency switch decision or one-commit hotfix identity is missing');
    if (typeof releaseCommit !== 'string' || !COMMIT_SHA.test(releaseCommit) || typeof previousVersion !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(previousVersion))
      throw new Error('release cut or previous stable version is missing');
    const baseCommit = git.resolveCommit(`refs/tags/v${previousVersion}^{commit}`);
    if (!baseCommit) throw new Error(`previous stable tag v${previousVersion} is unavailable`);
    if (baseCommit.toLowerCase() === hotfixCommit || !git.isAncestor(baseCommit, hotfixCommit) || !git.isAncestor(hotfixCommit, releaseCommit))
      throw new Error('hotfix commit must be in the release range after the previous stable tag');
    const hotfixPaths = git.pathsChangedByCommit(hotfixCommit);
    if (hotfixPaths.length === 0) throw new Error('hotfix commit contains no changed paths');
    if (hotfixPaths.some((path) => {
      const hotfixEntry = git.treeEntryAt(hotfixCommit, path);
      const releaseEntry = git.treeEntryAt(releaseCommit, path);
      if (hotfixEntry === null || releaseEntry === null) return hotfixEntry !== releaseEntry;
      return hotfixEntry.mode !== releaseEntry.mode || hotfixEntry.type !== releaseEntry.type
        || hotfixEntry.object !== releaseEntry.object;
    })) throw new Error('hotfix commit changes are absent from the final release cut (reverted or superseded)');
    if (typeof remote !== 'string' || !remote.trim()) throw new Error('emergencyPublish.remote is required for the reduced gate');
    const result = await runGate(context.input.version, { base: baseCommit, head: releaseCommit, remote: remote.trim() });
    const mandatoryTests = parseAlwaysIncludeList(readFileSync(join(process.cwd(), LIGHT_RC_ALWAYS_FILE), 'utf8'));
    const evidenceFailure = gateEvidenceFailure(result, mandatoryTests)
      ?? (hotfixPaths.every((path) => result.changedFiles?.includes(path)) ? undefined : 'reduced gate did not measure every effective hotfix path');
    const passed = result.ok && !evidenceFailure;
    const outcome: 'ok' | 'fail' = passed ? 'ok' : 'fail';
    const summary = passed
      ? `emergency changed-file gate passed for release range ${baseCommit.slice(0, 12)}..${releaseCommit.slice(0, 12)} on ${result.remote ?? remote}`
      : `emergency changed-file gate did not pass: ${evidenceFailure ?? result.unmeasured ?? `introduced=${result.introduced ?? 'unmeasured'}`}`;
    const output = { ...result, runId: context.runId, hotfixCommit, releaseCommit, outcome,
      verdict: passed ? 'pass' as const : 'fail' as const, summary };
    emitNodeResult(output);
    return passed ? 0 : 1;
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    emitNodeResult({ outcome: 'error', verdict: 'fail', summary, hotfixCommit: null });
    return 2;
  }
}
