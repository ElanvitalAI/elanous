/**
 * `eln land rail-watch` — post-rail regression watch (src/land-graph/rail-watch.ts). The trigger graph
 * graphs/triggers/rail-watch.yaml runs it every 10 min; it does work only on the first tick after a new rail.
 * Read-only toward GitHub and git (one `git log` on the HQ clone): it never reverts — the card carries the revert command.
 */
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { landingOwner } from '../org/land-authority.js';
import { installJsonCommit, parseSuspects, SMOKES, tickRailWatch, type RailWatchDeps, type SmokeResult } from '../land-graph/rail-watch.js';
import { defaultInstallRoot } from './self-update.js';
import { resolveLandRepo } from './land-graph-cli.js';
import { homedir } from 'node:os';

/** Smokes run the CLI of THIS package (the installed build when the trigger runs it), each bounded to 60 s. */
export function runSmokesWith(bin: string, runtime = process.execPath, timeoutMs = 60_000): SmokeResult[] {
  return SMOKES.map(s => {
    const out = spawnSync(runtime, [bin, ...s.argv], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1' } }); // Source: each smoke < 2 s on mshq 11-26; 60 s = hung.
    const ok = out.status === 0;
    const timedOut = (out.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    const tail = `${out.stderr ?? ''}\n${out.stdout ?? ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' ⏎ ');
    const code = timedOut ? `timeout (${Math.round(timeoutMs / 1000)} s)` : out.status !== null ? String(out.status) : `signal ${out.signal ?? '?'}`;
    return { id: s.id, ok, detail: ok ? 'exit 0' : `exit ${code} · ${tail.slice(0, 200)}` };
  });
}

/** CLI of the installed build (<install root>/current/node_modules/elanous/bin/elanous.mjs). */
export const installedBin = (root = defaultInstallRoot()): string => join(root, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');

export function defaultRailWatchDeps(over: Partial<RailWatchDeps> = {}): RailWatchDeps {
  const repo = resolveLandRepo({ defaultRoot: join(homedir(), 'elanous-hq', 'repo.git') });
  return {
    now: () => new Date(),
    stateRoot: effectiveInstanceRoot(),
    installedSha: () => installJsonCommit(defaultInstallRoot()),
    // The installed build's own CLI (the commit install.json names), not this module's tree.
    runSmokes: () => runSmokesWith(installedBin()),
    landedBetween(from, to) {
      if (!repo.root) return null;
      spawnSync('git', ['-C', repo.root, 'fetch', '-q', 'origin', 'main'], { timeout: 60_000 }); // Source: one fetch so both rail commits are known.
      const out = spawnSync('git', ['-C', repo.root, 'log', '--first-parent', '--format=%H%x09%s', `${from}..${to}`], { encoding: 'utf8', timeout: 30_000 });
      return out.status === 0 ? parseSuspects(out.stdout ?? '') : null;
    },
    post(to, body) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStore();
      try { store.post({ from: 'rail-watch', to, kind: 'info', body } as Parameters<typeof store.post>[0]); } finally { store.close(); }
    },
    recipients: [...new Set([landingOwner(), 'OP'])],
    ...over,
  };
}

export function registerRailWatch(land: Command, deps: () => RailWatchDeps = () => defaultRailWatchDeps()): void {
  land.command('rail-watch').description('Post-rail regression watch: smoke the installed build once per rail · card suspects + revert commands (never reverts)')
    .option('--json').action((o: { json?: boolean }) => {
      try {
        const r = tickRailWatch(deps());
        console.log(o.json ? JSON.stringify(r) : `rail-watch · ${r.status} · ${r.prev?.slice(0, 12) ?? '—'} → ${r.sha?.slice(0, 12) ?? '?'}${r.regressed ? ` · regressed ${r.regressed.join(',')} · suspects ${(r.suspects ?? []).map(s => `#${s.pr}`).join(' ') || '—'}` : ''}`);
        if (r.status === 'unknown-sha') process.exitCode = 1;
      } catch (e) { console.error(`rail-watch: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
}
