#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { emitNodeResult } from './node-verdict.js';
import { debug } from '../../src/debug/log.js';

type Kind = 'release' | 'dev-bump';
type Output = { outcome: 'ok' | 'error'; kind: Kind | null; version: string | null; commit: string | null; pr: number | null; worktree?: string; error?: string };

export function nextDevVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`invalid release version: ${version}`);
  return `${match[1]}.${match[2]}.${BigInt(match[3]!) + 1n}-dev.0`;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args[0]} failed (rc=${result.status ?? 'unknown'}): ${(result.stderr || result.error || result.stdout || 'no output').toString().trim()}`);
  }
  return result.stdout;
}

// git-spawn-allow: this isolated release checkout must read origin/main and create/remove its own worktree.
function git(repo: string, ...args: string[]): string {
  return run('git', args, repo).trim();
}

// Retry only failures that can clear without changing the release checkout.
const TRANSIENT_FETCH_ERROR = /cannot lock ref|unable to create .*\.lock|another git process|could not resolve host|failed to connect|connection (?:timed out|reset)|network is unreachable|remote end hung up|early EOF|permission denied \(publickey\)|authentication failed|could not read Username/i;

function fetchMain(repo: string): void {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSync('git', ['fetch', 'origin', 'main'], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status === 0 && !result.error) return;
    const stderr = (result.stderr || result.error?.message || result.stdout || 'no output').trim();
    if (attempt < 3 && TRANSIENT_FETCH_ERROR.test(stderr)) {
      Bun.sleepSync(100 * 2 ** (attempt - 1));
      continue;
    }
    // Report the URL's transport, never its value (or the socket path).
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' });
    const url = remote.status === 0 ? remote.stdout.trim() : '';
    const remoteKind = /^(?:ssh:\/\/|[^\s@]+@[^\s:]+:)/i.test(url) ? 'ssh'
      : /^https:\/\//i.test(url) ? 'https' : 'unknown';
    throw new Error(`git fetch origin main failed after ${attempt} attempt(s) (rc=${result.status ?? 'unknown'}): ${stderr} [remote URL kind: ${remoteKind}; SSH_AUTH_SOCK present: ${Boolean(process.env.SSH_AUTH_SOCK)}]`);
  }
}

function versionAt(repo: string): string {
  const pkg = JSON.parse(git(repo, 'show', 'origin/main:package.json')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error('origin/main package.json has no version');
  return pkg.version;
}

function landing(repo: string, kind: Kind, releaseVersion: string): Output {
  const target = kind === 'release' ? releaseVersion : nextDevVersion(releaseVersion);
  const source = kind === 'release' ? `${releaseVersion}-dev.N` : releaseVersion;
  fetchMain(repo);
  const current = versionAt(repo);
  const before = git(repo, 'rev-parse', 'origin/main');
  if (current === target) return { outcome: 'ok', kind, version: target, commit: before, pr: null };
  if (kind === 'release' ? !new RegExp(`^${releaseVersion.replaceAll('.', '\\.')}\\-dev\\.(0|[1-9][0-9]*)$`).test(current) : current !== source) {
    throw new Error(`origin/main version ${current} is not ${source} (target ${target})`);
  }

  const temp = mkdtempSync(join(tmpdir(), 'release-version-node-'));
  const worktree = join(temp, 'tree');
  try {
    git(repo, 'worktree', 'add', '-b', `release-version-${kind}-${Date.now()}-${process.pid}`, worktree, 'origin/main');
    const path = join(worktree, 'package.json');
    const text = readFileSync(path, 'utf8');
    const old = `"version": "${current}"`;
    if (!text.includes(old)) throw new Error(`package.json version field not found: ${current}`);
    writeFileSync(path, text.replace(old, `"version": "${target}"`));
    const lockPath = join(worktree, 'bun.lock');
    const lock = readFileSync(lockPath, 'utf8');
    const root = /"workspaces"\s*:\s*\{\s*""\s*:\s*\{([\s\S]*?)(?=\s*"(?:dependencies|devDependencies|optionalDependencies)"\s*:)/.exec(lock);
    if (!root) throw new Error('bun.lock root workspace not found');
    const lockedVersion = /"version"\s*:\s*"([^"]+)"/.exec(root[1]!);
    if (lockedVersion) {
      if (lockedVersion[1] !== current) throw new Error(`bun.lock root version ${lockedVersion[1]} is not ${current}`);
      writeFileSync(lockPath, lock.replace(root[0], root[0].replace(lockedVersion[0], `"version": "${target}"`)));
    }
    run('bun', ['install', '--frozen-lockfile'], worktree);
    const title = kind === 'release' ? `release: ${target}` : `version: ${target}`;
    const land = spawnSync('bun', ['bin/elanous.mjs', 'pr', 'land', '--commit-message', title, '--title', title, '--body', `Set package.json version to ${target}.`], {
      cwd: worktree, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const transcript = `${land.stdout ?? ''}\n${land.stderr ?? ''}`;
    if (land.status !== 0 || land.error || !transcript.includes('✓ merge:')) {
      throw new Error(`pr land failed (rc=${land.status ?? 'unknown'}; merge marker ${transcript.includes('✓ merge:') ? 'present' : 'missing'}): ${transcript.trim() || land.error || 'no output'}`);
    }
    const mergeLine = transcript.split('\n').find((line) => line.includes('✓ merge:')) ?? '';
    const pr = /(?:#|\/pull\/)(\d+)\b/.exec(mergeLine);
    fetchMain(repo);
    const commit = git(repo, 'rev-parse', 'origin/main');
    if (versionAt(repo) !== target || commit === before) throw new Error(`origin/main did not advance to ${target} after merge`);
    const output: Output = { outcome: 'ok', kind, version: target, commit, pr: pr ? Number(pr[1]) : null };
    git(repo, 'worktree', 'remove', '--force', worktree);
    rmSync(temp, { recursive: true, force: true });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} [worktree: ${worktree}]`);
  }
}

function main(args: string[] = process.argv.slice(2), repo = process.cwd()): Output {
  let kind: Kind | null = null;
  let version: string | null = null;
  try {
    if (args[0] !== 'release' && args[0] !== 'dev-bump') throw new Error('usage: version-node.ts <release|dev-bump> [--version <v>] --json');
    kind = args[0];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (args[i] === '--version' && args[i + 1]) { version = args[++i]!; continue; }
      throw new Error(`unknown or incomplete argument: ${args[i]}`);
    }
    if (!version) {
      if (process.env.ELANOUS_GRAPH_CONTEXT) {
        const location = process.env.ELANOUS_GRAPH_CONTEXT;
        const context = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8')) as { input?: { version?: unknown } };
        if (typeof context.input?.version === 'string') version = context.input.version;
      }
    }
    if (!version) throw new Error('version required (--version or ELANOUS_GRAPH_CONTEXT.input.version)');
    nextDevVersion(version);
    return landing(resolve(repo), kind, version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const worktree = /\[worktree: ([^\]]+)\]$/.exec(message)?.[1];
    const outputVersion = kind === 'dev-bump' && version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      ? nextDevVersion(version) : version;
    return { outcome: 'error', kind, version: outputVersion,
      commit: null, pr: null, ...(worktree ? { worktree } : {}), error: message };
  }
}

if (import.meta.main) {
  const output = main();
  debug.log(`release-loop.version-${output.kind ?? 'unknown'}`, 'result', { version: output.version, outcome: output.outcome });
  emitNodeResult({ ...output, verdict: output.outcome === 'ok' ? 'pass' : 'fail', summary: output.outcome === 'ok' ? `${output.kind} ${output.version} · ${output.commit}` : `${output.kind ?? 'version'}: ${output.error ?? 'failed'}` });
  if (output.outcome === 'error') process.exitCode = 1;
}
