#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { emitNodeResult } from './node-verdict.js';
import { debug } from '../../src/debug/log.js';

type Kind = 'release' | 'dev-bump';
type Output = { outcome: 'ok' | 'error'; kind: Kind | null; version: string | null; commit: string | null; pr: number | null; files?: string[]; worktree?: string; error?: string };

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

function versionAt(repo: string, ref = 'origin/main'): string {
  const pkg = JSON.parse(git(repo, 'show', `${ref}:package.json`)) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error(`${ref} package.json has no version`);
  return pkg.version;
}

/** next.md list lines (trimmed) present at the cut commit, or null when the cut or its next.md cannot be read. */
function shippedNextMdLines(repo: string, cut: string | undefined): { lines: Set<string> } | { reason: string } {
  if (!cut) return { reason: 'cut-unknown' };
  // git-spawn-allow: reads the cut commit's next.md to learn which lines that release already carried.
  const shown = spawnSync('git', ['show', `${cut}:release/next.md`], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (shown.status !== 0 || shown.error) return { reason: 'cut-next-md-unreadable' };
  return { lines: new Set(shown.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '))) };
}

function landing(repo: string, kind: Kind, releaseVersion: string, cut?: string, cutCommit?: string, forceFreeze = false): Output {
  const target = kind === 'release' ? releaseVersion : nextDevVersion(releaseVersion);
  const source = kind === 'release' ? `${releaseVersion}-dev.N` : releaseVersion;
  fetchMain(repo);
  if (kind === 'release' && cutCommit !== undefined) {
    if (!/^[0-9a-f]{7,40}$/i.test(cutCommit)) throw new Error(`invalid cut commit SHA: ${cutCommit}`);
    const local = spawnSync('git', ['rev-parse', '--verify', `${cutCommit}^{commit}`], { cwd: repo, encoding: 'utf8' });
    let chosen = local.status === 0 ? local.stdout.trim() : '';
    const onMain = chosen ? spawnSync('git', ['merge-base', '--is-ancestor', chosen, 'origin/main'], { cwd: repo }) : null;
    if (onMain && onMain.status !== 0 && onMain.status !== 1) throw new Error(`git merge-base failed: ${onMain.error || onMain.stderr || 'unknown'}`);
    if (onMain?.status !== 0) {
      const remote = git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/release/${releaseVersion}`);
      const branchTip = remote.split(/\s+/)[0];
      if (!chosen && branchTip?.toLowerCase().startsWith(cutCommit.toLowerCase())) {
        git(repo, 'fetch', 'origin', `refs/heads/release/${releaseVersion}`);
        chosen = git(repo, 'rev-parse', '--verify', `${cutCommit}^{commit}`);
      }
      if (!chosen) chosen = git(repo, 'rev-parse', '--verify', `${cutCommit}^{commit}`);
      if (branchTip !== chosen) {
        throw new Error(`cut commit ${chosen} is neither an ancestor of origin/main nor the tip of release/${releaseVersion}`);
      }
    }
    const current = versionAt(repo, chosen);
    if (current !== target) throw new Error(`cut commit ${chosen} package.json version ${current} is not ${target}`);
    debug.log('release-loop.cut', 'chosen', { version: releaseVersion, source: 'cut-commit', commit: chosen });
    return { outcome: 'ok', kind, version: target, commit: chosen, pr: null };
  }
  const current = versionAt(repo);
  const before = git(repo, 'rev-parse', 'origin/main');
  if (current === target) {
    if (kind === 'release') debug.log('release-loop.cut', 'chosen', { version: releaseVersion, source: 'main', commit: before });
    return { outcome: 'ok', kind, version: target, commit: before, pr: null };
  }
  // An older chosen cut may finish after main has already advanced to the next stable release.
  // Keep that newer main untouched; a -dev.N mismatch is not evidence of a later release.
  if (kind === 'dev-bump' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current)) {
    const mainParts = current.split('.').map(BigInt);
    const nextParts = target.slice(0, -'-dev.0'.length).split('.').map(BigInt);
    const firstDifference = mainParts.findIndex((part, index) => part !== nextParts[index]);
    if (firstDifference === -1 || mainParts[firstDifference]! > nextParts[firstDifference]!) {
      return { outcome: 'ok', kind, version: current, commit: before, pr: null };
    }
  }
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
    const files = ['package.json'];
    const serverPath = join(worktree, 'server.json');
    if (existsSync(serverPath)) {
      const server = JSON.parse(readFileSync(serverPath, 'utf8')) as { version: string; packages: Array<{ version: string }> };
      server.version = target;
      server.packages[0]!.version = target;
      writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
      files.push('server.json');
    }
    const agentPath = join(worktree, 'integrations', 'acp-registry', 'elanous', 'agent.json');
    if (existsSync(agentPath)) {
      const agent = JSON.parse(readFileSync(agentPath, 'utf8')) as { version: string; distribution: { npx: { package: string } } };
      agent.version = target;
      agent.distribution.npx.package = `elanous@${target}`;
      writeFileSync(agentPath, `${JSON.stringify(agent, null, 2)}\n`);
      files.push('agent.json');
    }
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
    if (kind === 'dev-bump') {
      const nextPath = join(worktree, 'release', 'next.md');
      if (existsSync(nextPath)) {
        const original = readFileSync(nextPath, 'utf8');
        // OP 10-02: dev-bump runs on the then-current main, not the cut. Lines landed after the cut are not in this
        // release and #22745 carries only lines added by the next cut range — so remove only lines the cut carried.
        const shipped = shippedNextMdLines(repo, cut);
        if ('reason' in shipped) {
          console.error(`⚠ next.md 비우기 건너뜀(${shipped.reason}) — 컷 커밋의 next.md 를 못 읽어 «나간 줄»을 증명할 수 없다`);
          debug.log('release-loop.notes', 'next-md-reset-skipped', { reason: shipped.reason }, { level: 'warn' });
        }
        const shippedLines = 'lines' in shipped ? shipped.lines : new Set<string>();
        let keptAfterCut = 0;
        let removed = 0;
        let keptLater = 0;
        let inSection = false;
        let droppingItem = false;
        // Only shipped list items (and their indented continuation lines) go; headings, prose, `###` subheadings and
        // `Target: later` items stay — the reviewer's «preserve everything but the released lines».
        const reset = original.split(/(?<=\n)/).filter((line) => {
          if (/^## /.test(line)) { inSection = true; droppingItem = false; return true; }
          if (!inSection) return true;
          if (/^- /.test(line)) {
            if (/\bTarget:\s*later(?:\.|\s|$)/i.test(line)) { keptLater++; droppingItem = false; return true; }
            if (!shippedLines.has(line.trim())) { keptAfterCut++; droppingItem = false; return true; }
            removed++; droppingItem = true; return false;
          }
          if (droppingItem && /^[ \t]+\S/.test(line)) return false;
          droppingItem = false;
          return true;
        }).join('');
        if (reset !== original) writeFileSync(nextPath, reset);
        debug.log('release-loop.notes', 'next-md-reset', { removed, keptLater, keptAfterCut });
      }
    }
    const title = kind === 'release' ? `release: ${target}` : `version: ${target}`;
    const land = spawnSync('bun', ['bin/elanous.mjs', 'pr', 'land', '--commit-message', title, '--title', title, '--body', `Set package.json version to ${target}.`,
      ...(forceFreeze ? ['--force-freeze', `release run version bump ${target}`] : [])], {
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
    const output: Output = { outcome: 'ok', kind, version: target, commit, pr: pr ? Number(pr[1]) : null, files };
    if (kind === 'release') debug.log('release-loop.cut', 'chosen', { version: releaseVersion, source: 'main', commit });
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
  let cut: string | undefined;
  let cutCommit: string | undefined;
  let forceFreeze = false;
  try {
    if (args[0] !== 'release' && args[0] !== 'dev-bump') throw new Error('usage: version-node.ts <release|dev-bump> [--version <v>] [--cut <sha>] [--cut-commit <sha>] --json');
    kind = args[0];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (args[i] === '--version' && args[i + 1]) { version = args[++i]!; continue; }
      if (args[i] === '--cut' && args[i + 1]) { cut = args[++i]!; continue; }
      if (args[i] === '--cut-commit' && args[i + 1]) { cutCommit = args[++i]!; continue; }
      throw new Error(`unknown or incomplete argument: ${args[i]}`);
    }
    if (process.env.ELANOUS_GRAPH_CONTEXT) {
      const location = process.env.ELANOUS_GRAPH_CONTEXT;
      const context = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8')) as {
        input?: { version?: unknown; cutCommit?: unknown; forceFreeze?: unknown }; outputs?: Record<string, { commit?: unknown } | undefined> };
      if (!version && typeof context.input?.version === 'string') version = context.input.version;
      forceFreeze = context.input?.forceFreeze === true;
      if (kind === 'release' && cutCommit === undefined && context.input?.cutCommit !== undefined) {
        if (typeof context.input.cutCommit !== 'string') throw new Error('cutCommit must be a commit SHA');
        cutCommit = context.input.cutCommit;
      }
      // The cut = the commit version-release landed (what cutoff and the gate measured).
      const releasedCommit = context.outputs?.['version-release']?.commit;
      if (!cut && typeof releasedCommit === 'string' && releasedCommit) cut = releasedCommit;
    }
    if (!version) throw new Error('version required (--version or ELANOUS_GRAPH_CONTEXT.input.version)');
    nextDevVersion(version);
    if (kind === 'dev-bump' && cutCommit !== undefined) throw new Error('--cut-commit is only valid for release');
    return landing(resolve(repo), kind, version, cut, cutCommit, forceFreeze);
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
  debug.log(`release-loop.version-${output.kind ?? 'unknown'}`, 'result', { version: output.version, outcome: output.outcome, files: output.files ?? [] });
  emitNodeResult({ ...output, verdict: output.outcome === 'ok' ? 'pass' : 'fail', summary: output.outcome === 'ok' ? `${output.kind} ${output.version} · ${output.commit}` : `${output.kind ?? 'version'}: ${output.error ?? 'failed'}` });
  if (output.outcome === 'error') process.exitCode = 1;
}
