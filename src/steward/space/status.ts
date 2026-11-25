// STEWARD-SPACE — `eln steward space status|tick`: last tick per scope (counts · rollup · age), and a one-shot run of the
// graph for one scope or all (`--shadow` = «would do» rows only).

import { recordFact } from '../../fed-state/ledger.js';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { spawnElanousSync } from '../../instance/spawn-elanous.js';
import { getUserConfig } from '../../user-config/reader.js';
import { resolveScope } from './config.js';
import type { ScopeState } from './model.js';
import { readScopeState } from './tick.js';

export const STEWARD_SPACE_GRAPH = resolve(import.meta.dir, '../../../graphs/steward/space.yaml');

export interface ScopeStatusRow { instance: string; mode: string; profile: string; lastTickAt: string | null; ageMin: number | null; counts: Record<string, number>; rollup: string; idleLeft: string[]; escalations: number }

export function stewardSpaceStatusRows(root: string, nowMs: number, hqGuess = 'OP'): ScopeStatusRow[] {
  const dir = join(root, 'steward', 'space');
  if (!existsSync(dir)) return [];
  const config = getUserConfig().loops?.stewardSpace;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[A-Z]/.test(d.name)).flatMap((d) => {
    const resolved = resolveScope(d.name, hqGuess, config);
    const states: Array<{ mode: 'shadow' | 'live'; state: ScopeState }> = (['live', 'shadow'] as const).map((mode) => ({ mode, state: readScopeState(root, d.name, mode) }));
    const latest = states.filter((s) => s.state.lastTick).sort((a, b) => Date.parse(b.state.lastTick!.at) - Date.parse(a.state.lastTick!.at))[0];
    const last = latest?.state.lastTick;
    return [{ instance: `steward:${d.name}`, mode: last ? `${resolved.mode} (last tick ${latest!.mode})` : resolved.mode, profile: resolved.profile,
      lastTickAt: last?.at ?? null, ageMin: last ? Math.floor((nowMs - Date.parse(last.at)) / 60_000) : null,
      counts: last?.counts ?? {}, rollup: last?.rollup ?? '', idleLeft: last?.idleLeft ?? [], escalations: last?.escalations.length ?? 0 }];
  });
}

export function renderStewardSpaceStatus(rows: readonly ScopeStatusRow[]): string {
  if (!rows.length) return 'steward space: no tick yet (eln steward space tick --shadow)';
  return rows.map((r) => {
    const counts = Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no rows';
    return `${r.instance} [${r.mode} · ${r.profile}] last ${r.lastTickAt ? `${r.ageMin}m ago` : 'never'} — ${counts}${r.escalations ? ` · escalated ${r.escalations}` : ''}\n  ${r.rollup || '-'}`;
  }).join('\n');
}

export function runStewardSpaceStatusCli(opts: { json?: boolean; scope?: string }): number {
  const rows = stewardSpaceStatusRows(effectiveInstanceRoot(), Date.now()).filter((r) => !opts.scope || r.instance === `steward:${opts.scope.toUpperCase()}`);
  console.log(opts.json ? JSON.stringify(rows, null, 2) : renderStewardSpaceStatus(rows));
  return 0;
}

/** One run of the graph now (same path the cron takes), for one scope or all. */
export function runStewardSpaceTickCli(opts: { scope?: string; shadow?: boolean; json?: boolean }): number {
  const input = JSON.stringify({ ...(opts.scope ? { scope: opts.scope.toUpperCase() } : {}), ...(opts.shadow ? { shadow: true } : {}) });
  const result = spawnElanousSync(['graph', 'run', STEWARD_SPACE_GRAPH, '--input', input, ...(opts.json ? ['--json'] : [])], { stdio: 'inherit' });
  if (!opts.shadow) recordFact({ type: 'steward', state: 'wake', seat: opts.scope?.toUpperCase(), ref: String(result.status ?? 1), source: 'steward-tick' });
  return result.status ?? 1;
}
