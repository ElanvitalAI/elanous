#!/usr/bin/env bun
import { homedir } from 'node:os';
import { errorResult, finishNode, lastResult, nodeOutput, readGraphContext, runCommand, type CommandResult, type CommandRunner } from './node-verdict.js';

interface HostResult { host: string; ok: boolean; before: string; after: string; error?: string; skipped?: string }

function firstLine(text: string): string { return text.trim().split(/\r?\n/)[0]?.trim() ?? ''; }

function reason(result: CommandResult): string {
  const data = lastResult(result);
  const message = [data?.error, data?.reason, data?.message, result.stderr, result.stdout].find((part) => typeof part === 'string' && part.trim());
  const line = firstLine(String(message ?? `명령 실패 (rc=${result.status})`));
  return /\b404\b/.test(line) ? `공급원에 판 없음 (404): ${line}` : line;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function runOpsUpgrade(run: CommandRunner = runCommand) {
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
  const feedPath = typeof internalDist === 'string' && internalDist.startsWith('~/') ? `${homedir()}/${internalDist.slice(2)}` : internalDist;
  let feedError = '';
  if (typeof feedPath === 'string') {
    try {
      const feed = run('bun', ['scripts/publish-internal-dist.ts', '--checkout', process.cwd(), '--out', feedPath]);
      const data = lastResult(feed);
      if (feed.status !== 0 || data?.ok !== true || data.version !== version) feedError = `내부 피드 발행 실패: ${feed.status === 0 && data?.ok === true ? `판 불일치 (${String(data.version)})` : reason(feed)}`;
    } catch (error) { feedError = `내부 피드 발행 실패: ${firstLine(String(error))}`; }
  }
  const results: HostResult[] = [];
  for (const host of hosts as string[]) {
    if (host !== 'local' && feedError) {
      results.push({ host, ok: false, before: '', after: '', skipped: '내부 피드 발행 실패', error: feedError });
      continue;
    }
    const command = (args: string[]): CommandResult => host === 'local'
      ? run('elanous', args)
      : run('ssh', [host, `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; export PATH; elanous ${args.map(quote).join(' ')}`]);
    let before = '';
    let after = '';
    try {
      const previous = command(['--version']);
      if (previous.status === 0) before = firstLine(previous.stdout);
      const updated = command(['update', '--version', version, '--json', ...(context.input.opsRestart === true ? ['--restart'] : [])]);
      const updateResult = lastResult(updated);
      if (updated.status !== 0 || updateResult?.exitCode !== 0 || updateResult.installedVersion !== version) {
        const error = updated.status === 0 && updateResult?.exitCode === 0
          ? `설치판 불일치 (기대 ${version}, 실제 ${String(updateResult.installedVersion)})` : reason(updated);
        results.push({ host, ok: false, before, after, error });
        continue;
      }
      const current = command(['--version']);
      if (current.status !== 0) {
        results.push({ host, ok: false, before, after, error: reason(current) });
        continue;
      }
      after = firstLine(current.stdout);
      if (after.split(/\s+/)[0] !== version) {
        results.push({ host, ok: false, before, after, error: `올렸는데 판이 그대로 (기대 ${version}, 실제 ${after || '없음'})` });
        continue;
      }
      results.push({ host, ok: true, before, after });
    } catch (error) {
      results.push({ host, ok: false, before, after, error: firstLine(String(error)) });
    }
  }
  const failures = results.filter((result) => !result.ok);
  return { outcome: failures.length || feedError ? 'fail' as const : 'ok' as const,
    verdict: failures.length || feedError ? 'fail' as const : 'pass' as const,
    summary: failures.length ? `운영 판올림 실패: ${failures.map(({ host, error }) => `${host}: ${error}`).join('; ')}${feedError && !failures.some((item) => item.skipped) ? `; ${feedError}` : ''}`
      : feedError || `운영 판올림 ${version} · ${results.length}대 확인`, hosts: results };
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('ops-upgrade', version, runOpsUpgrade()); }
  catch (error) { process.exitCode = finishNode('ops-upgrade', version, errorResult(error)); }
}
