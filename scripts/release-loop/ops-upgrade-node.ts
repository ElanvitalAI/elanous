#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { errorResult, finishNode, lastResult, nodeOutput, readGraphContext, runCommand, type CommandResult, type CommandRunner } from './node-verdict.js';
import { prereleaseKind } from './release-version.js';

interface HostResult { host: string; ok: boolean; before: string; after: string; error?: string; skipped?: string; hooks?: string; restart?: 'no-service' }
/** Where the internal feed is packed from: a checkout of the release tag, never the run's working tree. */
export interface FeedSource { checkout: string; commit: string; deps: 'linked' | 'installed'; cleanup: () => void }
interface OpsUpgradeDeps { exists?: (path: string) => boolean; installSource?: () => string | null; installCommit?: () => string | null; feedSource?: (version: string) => FeedSource }

/** Detached worktree at refs/tags/v<version> with the PWA built — the feed ships what was released (10-04 0.2.11:
 *  packing process.cwd() shipped main HEAD ee689ad2 as «0.2.11» to node-b·cloud-vm instead of the cut 31129c91). */
export function tagFeedSource(run: CommandRunner, repo: string = process.cwd()): (version: string) => FeedSource {
  return (version) => {
    const tag = run('git', ['rev-parse', '--verify', `refs/tags/v${version}^{commit}`], repo);
    const commit = tag.stdout.trim();
    if (tag.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`태그 없음: v${version}`);
    const dir = mkdtempSync(join(tmpdir(), 'ops-feed-'));
    const tree = join(dir, 'tree');
    const cleanup = () => {
      run('git', ['worktree', 'remove', '--force', tree], repo);
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      const added = run('git', ['worktree', 'add', '--detach', tree, commit], repo);
      if (added.status !== 0) throw new Error(`태그 체크아웃 실패: ${reason(added)}`);
      const sameDeps = ['bun.lock', 'apps/pwa/bun.lock', 'package.json', 'apps/pwa/package.json'].every((file) => {
        try { return readFileSync(join(repo, file), 'utf8') === readFileSync(join(tree, file), 'utf8'); }
        catch { return false; }
      });
      const deps: FeedSource['deps'] = sameDeps ? 'linked' : 'installed';
      if (sameDeps) {
        symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'));
        if (existsSync(join(repo, 'apps/pwa/node_modules'))) symlinkSync(join(repo, 'apps/pwa/node_modules'), join(tree, 'apps/pwa/node_modules'));
      } else {
        for (const cwd of [tree, join(tree, 'apps/pwa')]) {
          const installed = run('bun', ['install', '--frozen-lockfile'], cwd, 900_000);
          if (installed.status !== 0) throw new Error(`태그 의존성 설치 실패: ${reason(installed)}`);
        }
      }
      // The feed carries the PWA build (apps/pwa/out is ignored, so a fresh tag checkout has none until built).
      const built = run('bun', ['bin/elanous.mjs', 'nexus', 'build'], tree, 900_000);
      if (built.status !== 0) throw new Error(`태그 PWA 빌드 실패: ${reason(built)}`);
      return { checkout: tree, commit, deps, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

function installMetadata(text: string): { source: string | null; commit: string | null } {
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object') return { source: null, commit: null };
    return {
      source: 'source' in data && typeof data.source === 'string' ? data.source : null,
      commit: 'commit' in data && typeof data.commit === 'string' ? data.commit : null,
    };
  } catch { return { source: null, commit: null }; }
}

function localInstallMetadata(): { source: string | null; commit: string | null } {
  try { return installMetadata(readFileSync(join(homedir(), '.local/share/elanous/install.json'), 'utf8')); }
  catch { return { source: null, commit: null }; }
}

function installedMatches(installed: unknown, version: string): boolean {
  return installed === version;
}

function missingService(data: Record<string, unknown> | undefined): boolean {
  return typeof data?.reason === 'string'
    && /^재시작 실패:\s*(?:Could not find service\s+"?com\.elanous\.nexus\b|(?:Failed to restart elanous-nexus\.service:\s*)?Unit elanous-nexus(?:\.service)? not found\b)/i.test(data.reason);
}

function firstLine(text: string): string { return text.trim().split(/\r?\n/)[0]?.trim() ?? ''; }

function reason(result: CommandResult): string {
  const data = lastResult(result);
  const message = [data?.error, data?.reason, data?.message, result.stderr, result.stdout].find((part) => typeof part === 'string' && part.trim());
  const line = firstLine(String(message ?? `명령 실패 (rc=${result.status})`));
  return /\b404\b/.test(line) ? `공급원에 판 없음 (404): ${line}` : line;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function runOpsUpgrade(run: CommandRunner = runCommand, deps: OpsUpgradeDeps = {}) {
  const context = readGraphContext();
  const hosts = context.input.opsHosts;
  if (hosts === undefined || (Array.isArray(hosts) && hosts.length === 0)) {
    return { outcome: 'ok' as const, verdict: 'pass' as const, summary: '운영 대상 없음 — 건너뜀', hosts: [] as HostResult[] };
  }
  if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host))) throw new Error('input.opsHosts must be an array of host names');
  if (context.outputs.verify?.outcome !== 'ok') throw new Error('verify must pass before ops upgrade');
  const version = context.input.version;
  if (nodeOutput(context, 'publish', 'tag') !== `v${version}`) throw new Error('published tag/version mismatch');
  const internalDist = context.input.internalDist;
  if (internalDist !== undefined && (typeof internalDist !== 'string' || !internalDist.trim())) throw new Error('input.internalDist must be a path string');
  const defaultFeed = join(homedir(), '.local/share/elanous-ops/internal-dist');
  const feedPath = typeof internalDist === 'string'
    ? internalDist.startsWith('~/') ? `${homedir()}/${internalDist.slice(2)}` : internalDist
    : (deps.exists ?? existsSync)(defaultFeed) ? defaultFeed : undefined;
  let feedError = '';
  if (feedPath !== undefined) {
    let source: FeedSource | undefined;
    try {
      source = (deps.feedSource ?? tagFeedSource(run))(version);
      const released = context.outputs['version-release']?.commit;
      if (typeof released === 'string' && released && released !== source.commit) {
        feedError = `내부 피드 발행 실패: 태그 v${version}(${source.commit.slice(0, 12)})가 컷(${released.slice(0, 12)})과 다르다`;
      } else {
        const feed = run('bun', ['scripts/publish-internal-dist.ts', '--checkout', source.checkout, '--out', feedPath]);
        const data = lastResult(feed);
        if (feed.status !== 0 || data?.ok !== true || data.version !== version) feedError = `내부 피드 발행 실패: ${feed.status === 0 && data?.ok === true ? `판 불일치 (${String(data.version)})` : reason(feed)}`;
        else if (data.commit !== source.commit) feedError = `내부 피드 발행 실패: 묶은 커밋 ${String(data.commit).slice(0, 12)} ≠ 태그 ${source.commit.slice(0, 12)}`;
        debug.log('release-loop.ops-upgrade', 'feed-source', { version, commit: source.commit, source: `refs/tags/v${version}`, deps: source.deps, packed: data?.commit, pwaBuild: data?.pwaBuild });
      }
    } catch (error) { feedError = `내부 피드 발행 실패: ${firstLine(String(error))}`; }
    finally { source?.cleanup(); }
  }
  const results: HostResult[] = [];
  for (const host of hosts as string[]) {
    // Injected install metadata replaces the machine's install.json entirely — a test that injects only the source
    //   must not inherit this machine's real commit (that turned update cases into kept-ahead skips).
    const injected = deps.installSource !== undefined || deps.installCommit !== undefined;
    let metadata: { source: string | null; commit: string | null } = host !== 'local'
      ? { source: null, commit: null }
      : injected
        ? { source: deps.installSource?.() ?? null, commit: deps.installCommit?.() ?? null }
        : localInstallMetadata();
    let source = metadata.source;
    let railSource = false;
    let path: 'checkout' | 'release' = 'release';
    const record = (result: HostResult) => {
      results.push(result);
      debug.log('release-loop.ops-upgrade', 'host', { host, path, restart: result.restart ?? (context.input.opsRestart === true ? result.ok ? 'ok' : 'failed' : 'skipped'), ok: result.ok });
    };
    const command = (args: string[]): CommandResult => host === 'local'
      ? run('elanous', args)
      // The installer's own bin dir comes first — a --no-modify-path install (the bot VM) has elanous only there.
      : run('ssh', [host, `PATH="$HOME/.local/share/elanous/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"; export PATH; elanous ${args.map(quote).join(' ')}`]);
    let before = '';
    let after = '';
    try {
      if (host !== 'local') {
        const installed = run('ssh', [host, `cat "$HOME/.local/share/elanous/install.json" 2>/dev/null || true`]);
        if (installed.status === 0) metadata = installMetadata(installed.stdout);
      }
      source = metadata.source;
      if (source !== null && isAbsolute(source)) {
        const repository = host === 'local'
          ? run('git', ['rev-parse', '--is-inside-work-tree'], source)
          : run('ssh', [host, `git -C ${quote(source)} rev-parse --is-inside-work-tree`]);
        railSource = repository.status === 0 && firstLine(repository.stdout) === 'true';
      }
      path = railSource ? 'checkout' : 'release';
      const previous = command(['--version']);
      if (previous.status === 0) before = firstLine(previous.stdout);
      if (railSource) {
        record({ host, ok: true, before, after: before, skipped: 'rail-source' });
        continue;
      }
      const installedCommit = metadata.commit;
      if (installedCommit && /^[0-9a-f]{40,64}$/.test(installedCommit)) {
        const ahead = run('git', ['merge-base', '--is-ancestor', `refs/tags/v${version}`, installedCommit]);
        // Only exit 1 proves non-ancestry; missing local objects must not permit a potentially destructive downgrade.
        if (ahead.status !== 1) {
          record({ host, ok: true, before, after: before, skipped: 'kept-ahead' });
          continue;
        }
      }
      if (host !== 'local' && feedError) {
        record({ host, ok: false, before, after: '', skipped: '내부 피드 발행 실패', error: feedError });
        continue;
      }
      const updated = command(['update', ...(host !== 'local' && feedPath !== undefined ? [] : ['--version', version]), '--json', ...(context.input.opsRestart === true ? ['--restart'] : [])]);
      const updateResult = lastResult(updated);
      const noService = host !== 'local' && context.input.opsRestart === true && updateResult?.exitCode === 1 && missingService(updateResult);
      if ((!noService && (updated.status !== 0 || updateResult?.exitCode !== 0)) || !installedMatches(updateResult?.installedVersion, version)) {
        const error = (updated.status === 0 && updateResult?.exitCode === 0 || noService)
          ? `설치판 불일치 (기대 ${version}, 실제 ${String(updateResult?.installedVersion)})` : reason(updated);
        record({ host, ok: false, before, after, error });
        continue;
      }
      const current = command(['--version']);
      if (current.status !== 0) {
        record({ host, ok: false, before, after, error: reason(current) });
        continue;
      }
      after = firstLine(current.stdout);
      if (!installedMatches(after.split(/\s+/)[0], version)) {
        record({ host, ok: false, before, after, error: `올렸는데 판이 그대로 (기대 ${version}, 실제 ${after || '없음'})` });
        continue;
      }
      // The webhook receiver (`elanous hooks serve`, a user systemd unit on the bot VM) keeps the old code until it
      // restarts. try-restart touches it only where it runs; elsewhere the unit is absent and nothing happens.
      let hooks: string | undefined;
      if (host !== 'local' && context.input.opsRestart === true) {
        const restarted = run('ssh', [host, 'systemctl --user try-restart elanous-hooks.service 2>/dev/null && systemctl --user is-active elanous-hooks.service 2>/dev/null || echo absent']);
        hooks = firstLine(restarted.stdout) || 'absent';
      }
      record({ host, ok: true, before, after, ...(hooks ? { hooks } : {}), ...(noService ? { restart: 'no-service' as const } : {}) });
    } catch (error) {
      record({ host, ok: false, before, after, error: firstLine(String(error)) });
    }
  }
  const failures = results.filter((result) => !result.ok);
  return { outcome: failures.length || feedError ? 'fail' as const : 'ok' as const,
    verdict: failures.length || feedError ? 'fail' as const : 'pass' as const,
    summary: failures.length ? `운영 판올림 실패: ${failures.map(({ host, error }) => `${host}: ${error}`).join('; ')}${feedError && !failures.some((item) => item.skipped) ? `; ${feedError}` : ''}`
      : feedError || `운영 판올림 ${version} · ${results.length}대 확인`,
    feed: feedError ? 'failed' as const : feedPath === undefined ? 'skipped-no-path' as const : 'published' as const, hosts: results };
}

function main(): void {
  let version = '';
  try {
    version = readGraphContext().input.version;
    // RELEASE-REHEARSAL-RC: a prerelease never lands docs on main or upgrades the operating hosts.
    const result = prereleaseKind(version) !== null
      ? { outcome: 'ok' as const, verdict: 'pass' as const, summary: `ops-upgrade skipped — ${version} is a prerelease`, skipped: 'prerelease' }
      : runOpsUpgrade(runCommand);
    process.exitCode = finishNode('ops-upgrade', version, result);
  }
  catch (error) { process.exitCode = finishNode('ops-upgrade', version, errorResult(error)); }
}

if (import.meta.main) main();
