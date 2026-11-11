import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

type GateGitSyncOptions = { encoding?: 'utf8' | 'buffer'; maxBuffer?: number; input?: string | Buffer };
export const GATE_GIT_SYNC_TIMEOUT_MS = 5_000;

const perlProcessGroupRunner = [
  'use strict; use warnings; use Time::HiRes qw(alarm);',
  'my $limit_ms = shift @ARGV; my $pid = fork(); die "fork failed: $!" unless defined $pid;',
  'if ($pid == 0) { setpgrp(0, 0); exec @ARGV; exit 127; }',
  '$SIG{ALRM} = sub { kill "KILL", -$pid; waitpid($pid, 0); exit 124; };',
  'alarm($limit_ms / 1000); waitpid($pid, 0); my $status = $?; kill "KILL", -$pid; alarm(0);',
  'exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);',
].join(' ');

/** Gate metadata reads must never trigger Git's promisor remote or wait without a deadline. */
export function gateGitSync(args: string[], cwd: string, options: GateGitSyncOptions & { encoding: 'utf8' }, timeoutMs?: number): SpawnSyncReturns<string>;
export function gateGitSync(args: string[], cwd: string, options: GateGitSyncOptions & { encoding: 'buffer' }, timeoutMs?: number): SpawnSyncReturns<Buffer>;
export function gateGitSync(args: string[], cwd: string, options?: GateGitSyncOptions, timeoutMs?: number): SpawnSyncReturns<Buffer>;
export function gateGitSync(args: string[], cwd: string, options: GateGitSyncOptions = {}, timeoutMs = GATE_GIT_SYNC_TIMEOUT_MS): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const { encoding, ...rest } = options;
  const spawnOptions = {
    ...rest,
    ...(encoding === 'utf8' ? { encoding: 'utf8' as const } : {}),
    cwd,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    timeout: timeoutMs + 2_000,
  };
  const timeoutCommand = process.platform === 'linux' ? 'timeout' : process.platform === 'darwin' ? 'gtimeout' : null;
  let result = timeoutCommand
    ? spawnSync(timeoutCommand, ['--kill-after=1s', `${timeoutMs / 1_000}s`, 'git', ...args], spawnOptions)
    : gateGitSyncPerlFallback(args, cwd, options, timeoutMs);
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT' && timeoutCommand) {
    result = gateGitSyncPerlFallback(args, cwd, options, timeoutMs);
  }
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') result = spawnSync('elanous-git-timeout-runner-unavailable', [], spawnOptions);
  return result as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;
}

export function gateGitSyncPerlFallback(args: string[], cwd: string, options: GateGitSyncOptions = {}, timeoutMs = GATE_GIT_SYNC_TIMEOUT_MS): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const { encoding, ...rest } = options;
  const result = spawnSync('perl', ['-e', perlProcessGroupRunner, String(timeoutMs), 'git', ...args], {
    ...rest,
    ...(encoding === 'utf8' ? { encoding: 'utf8' as const } : {}),
    cwd,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    timeout: timeoutMs + 2_000,
  });
  return result as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;
}

/** A receipt commit can outlive its source object (for example after PR squash); never diff it. */
export function gateCommitObjectExists(repo: string, commit: string): boolean {
  return gateCommitObjectsExist(repo, [commit]).has(commit.toLowerCase());
}

export function gateCommitObjectsExist(repo: string, commits: readonly string[]): Set<string> {
  const valid = [...new Set(commits.filter((commit) => /^[a-f0-9]{40}$/i.test(commit)).map((commit) => commit.toLowerCase()))];
  if (!valid.length) return new Set();
  const result = gateGitSync(['cat-file', '--batch-check=%(objectname) %(objecttype)'], repo,
    { input: `${valid.join('\n')}\n`, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return new Set();
  const found = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([a-f0-9]{40}) commit$/i.exec(line.trim());
    if (match) found.add(match[1]!.toLowerCase());
  }
  return found;
}
