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
interface OpsUpgradeDeps { exists?: (path: string) => boolean; installSource?: () => string | null; feedSource?: (version: string) => FeedSource }

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

function localInstallSource(): string | null {
  try {
    const data: unknown = JSON.parse(readFileSync(join(homedir(), '.local/share/elanous/install.json'), 'utf8'));
    return data && typeof data === 'object' && 'source' in data && typeof data.source === 'string' ? data.source : null;
  } catch { return null; }
}

function installedMatches(installed: unknown, version: string, checkout: boolean): boolean {
  return installed === version || checkout && typeof installed === 'string'
    && installed.startsWith(`${version}-`) && /^[0-9a-f]{12}$/.test(installed.slice(version.length + 1));
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
    const source = host === 'local' ? (deps.installSource ?? localInstallSource)() : null;
    const checkout = host === 'local' && source !== null && isAbsolute(source);
    const path = checkout ? 'checkout' as const : 'release' as const;
    const record = (result: HostResult) => {
      results.push(result);
      debug.log('release-loop.ops-upgrade', 'host', { host, path, restart: result.restart ?? (context.input.opsRestart === true ? result.ok ? 'ok' : 'failed' : 'skipped'), ok: result.ok });
    };
    if (host !== 'local' && feedError) {
      record({ host, ok: false, before: '', after: '', skipped: '내부 피드 발행 실패', error: feedError });
      continue;
    }
    const command = (args: string[]): CommandResult => host === 'local'
      ? run('elanous', args)
      // The installer's own bin dir comes first — a --no-modify-path install (the bot VM) has elanous only there.
      : run('ssh', [host, `PATH="$HOME/.local/share/elanous/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"; export PATH; elanous ${args.map(quote).join(' ')}`]);
    let before = '';
    let after = '';
    try {
      const previous = command(['--version']);
      if (previous.status === 0) before = firstLine(previous.stdout);
      if (checkout) {
        const git = (args: string[]) => run('git', args, source!);
        const dirty = git(['status', '--porcelain', '--untracked-files=all']);
        if (dirty.status !== 0 || dirty.stdout.trim()) {
          record({ host, ok: false, before, after, error: dirty.status === 0 ? '체크아웃 변경 있음' : `체크아웃 상태 확인 실패: ${reason(dirty)}` });
          continue;
        }
        const fetched = git(['fetch', '--tags']);
        if (fetched.status !== 0) {
          record({ host, ok: false, before, after, error: `태그 가져오기 실패: ${reason(fetched)}` });
          continue;
        }
        const tag = git(['rev-parse', '--verify', `refs/tags/v${version}^{commit}`]);
        if (tag.status !== 0 || !tag.stdout.trim()) {
          record({ host, ok: false, before, after, error: `태그 없음: v${version}` });
          continue;
        }
        const moved = git(['checkout', '--detach', `v${version}`]);
        if (moved.status !== 0) {
          record({ host, ok: false, before, after, error: `체크아웃 전환 실패: ${reason(moved)}` });
          continue;
        }
      }
      const updated = command(['update', ...(checkout || host !== 'local' && feedPath !== undefined ? [] : ['--version', version]), '--json', ...(context.input.opsRestart === true ? ['--restart'] : [])]);
      const updateResult = lastResult(updated);
      const noService = host !== 'local' && context.input.opsRestart === true && updateResult?.exitCode === 1 && missingService(updateResult);
      if ((!noService && (updated.status !== 0 || updateResult?.exitCode !== 0)) || !installedMatches(updateResult?.installedVersion, version, checkout)) {
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
      if (!installedMatches(after.split(/\s+/)[0], version, checkout)) {
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

if (import.meta.main) {
  let version = '';
  try {
    version = readGraphContext().input.version;
    // RELEASE-REHEARSAL-RC: a prerelease never lands docs on main or upgrades the operating hosts.
    process.exitCode = finishNode('ops-upgrade', version, prereleaseKind(version) !== null
      ? { outcome: 'ok', verdict: 'pass', summary: `ops-upgrade skipped — ${version} is a prerelease`, skipped: 'prerelease' }
      : runOpsUpgrade());
  }
  catch (error) { process.exitCode = finishNode('ops-upgrade', version, errorResult(error)); }
}
