// `eln hold add|ls|narrow|lift|expire` — the HOLD ledger's one door (HOLD-AS-LEDGER-OBJECT · see hold-ledger.ts).
import type { Command } from 'commander';
import { addHold, expireDue, liftHold, narrowHold, parseTtl, readHolds, renderHold, type Hold } from './hold-ledger.js';

export interface HoldCliDeps { /** fed-state fact sink (tests inject one so nothing reaches the live facts.jsonl). */ fact?: (e: import('./hold-ledger.js').HoldEvent) => void; stateRoot?: () => string; now?: () => Date; caller?: () => string | null; print?: (line: string) => void; error?: (line: string) => void }

const stateRootOf = (deps: HoldCliDeps): string => deps.stateRoot ? deps.stateRoot()
  : (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();
// JUD-GREEN-CREDENTIAL: default writer = the seat's normal identity (ELANOUS_TRACK → ELANOUS_SEAT → seats/<SEAT> cwd) — a JUD
// seat running in seats/JUD writes its HOLD as JUD without --by.
const byOf = (deps: HoldCliDeps, by?: string): string => {
  const who = (by ?? deps.caller?.() ?? (process.env.ELANOUS_TRACK?.trim() || (require('../kit/mail-route/sender.js') as typeof import('../kit/mail-route/sender.js')).callerSeat()) ?? '').trim();
  if (!who) throw new Error('who is writing? --by <seat> (or ELANOUS_TRACK · ELANOUS_SEAT · run from seats/<SEAT>)');
  return who;
};
const cellsOf = (raw?: string): string[] | undefined => (raw === undefined ? undefined : raw.split(',').map(c => c.trim()).filter(Boolean));

function act(deps: HoldCliDeps, fn: () => void): void {
  try { fn(); } catch (e) { (deps.error ?? console.error)(`hold: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
}

export function registerHoldCommands(program: Command, deps: HoldCliDeps = {}): void {
  const print = (line: string) => (deps.print ?? console.log)(line);
  const now = () => (deps.now ? deps.now() : new Date());
  const hold = program.command('hold').description('HOLD ledger — a HOLD is an object {id · owner · cells · reason · expiry · unlock}; unregistered HOLDs surface to OP after 30 min');
  hold.command('add').description('Register a HOLD (default expiry 2h · wildcard * capped at 2h · max 24h)')
    .requiredOption('--cells <csv>', 'scope: cell ids (A,B) — or * for everything the owner leads')
    .requiredOption('--reason <text>', 'why')
    .requiredOption('--unlock <cond>', 'what lifts it: merged:#N · green:CELL · or one line')
    .option('--owner <seat>', 'HOLD owner (default: --by)').option('--expires <dur>', '30m · 2h · 1d', '2h')
    .option('--from-msg <id>', 'the mail that first said it (registers a broadcast HOLD)').option('--by <seat>', 'writer (default ELANOUS_TRACK)').option('--json')
    .action((o: { cells: string; reason: string; unlock: string; owner?: string; expires: string; fromMsg?: string; by?: string; json?: boolean }) => act(deps, () => {
      const by = byOf(deps, o.by);
      const h = addHold(stateRootOf(deps), { owner: o.owner ?? by, cells: cellsOf(o.cells)!, reason: o.reason, unlock: o.unlock, ttlMs: parseTtl(o.expires),
        ...(o.fromMsg ? { sourceMsg: Number(o.fromMsg) } : {}), by }, { now: now(), ...(deps.fact ? { fact: deps.fact } : {}) });
      print(o.json ? JSON.stringify(h) : `added ${renderHold(h, now())}`);
    }));
  hold.command('ls').description('Active HOLDs (or --all) · --cell X = the HOLDs covering X')
    .option('--cell <id>').option('--owner <seat>').option('--all', 'include lifted / expired').option('--json')
    .action((o: { cell?: string; owner?: string; all?: boolean; json?: boolean }) => act(deps, () => {
      const t = now();
      const rows: Hold[] = readHolds(stateRootOf(deps), t).filter(h => (o.all || h.state === 'active')
        && (!o.owner || h.owner === o.owner.toUpperCase()) && (!o.cell || h.cells.includes('*') || h.cells.includes(o.cell.toUpperCase())));
      if (o.json) { print(JSON.stringify(rows)); return; }
      if (!rows.length) { print(o.cell ? `no active HOLD covers ${o.cell} — proceed` : 'no HOLD'); return; }
      for (const h of rows) print(renderHold(h, t));
    }));
  hold.command('narrow <id>').description('Narrow scope and/or expiry (owner · JUD · OP only — never widens)')
    .option('--cells <csv>').option('--expires <dur>').option('--reason <text>').option('--by <seat>').option('--json')
    .action((id: string, o: { cells?: string; expires?: string; reason?: string; by?: string; json?: boolean }) => act(deps, () => {
      const h = narrowHold(stateRootOf(deps), id, { ...(o.cells ? { cells: cellsOf(o.cells) } : {}), ...(o.expires ? { ttlMs: parseTtl(o.expires) } : {}),
        ...(o.reason ? { reason: o.reason } : {}), by: byOf(deps, o.by) }, { now: now(), ...(deps.fact ? { fact: deps.fact } : {}) });
      print(o.json ? JSON.stringify(h) : `narrowed ${renderHold(h, now())}`);
    }));
  hold.command('lift <id>').description('Lift a HOLD (owner · JUD · OP)').requiredOption('--reason <text>').option('--by <seat>').option('--json')
    .action((id: string, o: { reason: string; by?: string; json?: boolean }) => act(deps, () => {
      const h = liftHold(stateRootOf(deps), id, { by: byOf(deps, o.by), reason: o.reason }, { now: now(), ...(deps.fact ? { fact: deps.fact } : {}) });
      print(o.json ? JSON.stringify(h) : `lifted ${renderHold(h, now())}`);
    }));
  hold.command('expire').description('Sweep: auto-lift every HOLD whose expiry passed (one audit row each) — idempotent')
    .option('--dry-run').option('--by <seat>', 'sweeper id', 'HOLD-SWEEP').option('--json')
    .action((o: { dryRun?: boolean; by?: string; json?: boolean }) => act(deps, () => {
      const rows = expireDue(stateRootOf(deps), { by: o.by ?? 'HOLD-SWEEP', ...(o.dryRun ? { dryRun: true } : {}) }, { now: now(), ...(deps.fact ? { fact: deps.fact } : {}) });
      if (o.json) { print(JSON.stringify(rows)); return; }
      for (const r of rows) print(`${o.dryRun ? '(dry) ' : ''}${r.audit}`);
      print(`hold expire: ${rows.length} ${o.dryRun ? 'due' : 'lifted'}`);
    }));
}
