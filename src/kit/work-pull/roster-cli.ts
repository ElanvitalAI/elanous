// kit/work-pull — `eln work roster [ids...]` (WORK-PULL-REACHES-ROSTER): show or set OP's roster rank for a version.
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { listChecklist } from '../../release-loop/checklist.js';
import { readRoster, writeRoster } from './index.js';
/** `eln work roster [ids...]` — show or set OP's roster rank for a version (ids in rank order · `work next` claims roster
 *  cells in this order, then by priority). */
export function runWorkRosterCli(ids: readonly string[], opts: { version?: string; by?: string; json?: boolean }): number {
  const root = effectiveInstanceRoot();
  const version = opts.version ?? activeBoardVersion();
  const list = ids.flatMap((e) => e.split(/[,\s]+/u)).map((e) => e.trim()).filter(Boolean);
  if (list.length) {
    const known = new Set(listChecklist(version).items.map((i) => i.id));
    const missing = list.filter((id) => !known.has(id));
    if (missing.length) { console.error(`work roster: not on the ${version} board: ${missing.slice(0, 10).join(' · ')}`); return 2; }
    const row = writeRoster(root, { version, cells: list, by: opts.by ?? process.env.ELANOUS_TRACK ?? 'OP', nowMs: Date.now() });
    debug.log('pool', 'roster', { version: row.version, cells: row.cells.length, by: row.by });
  }
  const now = readRoster(root);
  if (opts.json) console.log(JSON.stringify(now ?? null));
  else console.log(now ? `roster ${now.version} (${now.by ?? '?'} · ${now.at ?? '?'}): ${now.cells.length} cells — ${now.cells.slice(0, 12).map((e, i) => `${i + 1}. ${e}`).join(' · ')}${now.cells.length > 12 ? ' …' : ''}` : 'roster: (none) — roster cells by priority');
  return 0;
}
