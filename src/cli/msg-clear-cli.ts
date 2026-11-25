// ── `eln msg clear` (MSG-CLEAR · 11-25) ───────────────────────────────────────────────────────
//   msg clear --to <seat> --by <seat> [filters]          = DRY-RUN: count · grouped summary (top 10) · sample ids
//   msg clear --to <seat> --by <seat> [filters] --yes    = per-id ack + receipt + one info notice to the seat
//   msg clear --undo <receipt> --by <seat>               = remove exactly that receipt's ack rows
// Who: the seat itself · its coordinator (federation ladder) · OP · CLAUDE-OP.
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { canonicalMessageAddress, type MsgStore } from '../msg/msg-store.js';
import type { FederationLadder } from '../msg/hand-raise-ladder.js';

export interface MsgClearCliDeps {
  openStore: () => MsgStore;
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
  now?: () => Date;
  ladder?: () => Pick<FederationLadder, 'parentOf'>;
}

const ALWAYS_ALLOWED = ['OP', 'CLAUDE-OP'];

export function mayClear(by: string, to: string, ladder: Pick<FederationLadder, 'parentOf'> | null): boolean {
  const b = canonicalMessageAddress(by);
  const t = canonicalMessageAddress(to);
  if (b === t || ALWAYS_ALLOWED.includes(b)) return true;
  try { return ladder !== null && canonicalMessageAddress(ladder.parentOf(t)) === b; } catch { return false; }
}

interface ClearOpts {
  to?: string; by?: string; from?: string; kind?: string; match?: string; ref?: string; since?: string; until?: string;
  olderThan?: string; idsFile?: string; yes?: boolean; includeProtected?: boolean; foldIntoCard?: boolean; undo?: string; json?: boolean;
}

export function registerMsgClearCommand(msg: Command, deps: MsgClearCliDeps): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  msg.command('clear').description('Bulk-ack (never delete) a seat inbox by filters — dry-run by default, --yes applies, --undo <receipt> reverts')
    .option('--to <seat>', 'the inbox to clear (required unless --undo)')
    .option('--by <seat>', 'acting seat: the seat itself, its coordinator, OP or CLAUDE-OP (required)')
    .option('--from <seat>').option('--kind <kind>', 'kind or intent')
    .option('--match <regex>', 'regex on the body head (first 200 chars)')
    .option('--ref <substring>', 'any ref containing this, e.g. hand-escalated-from:')
    .option('--since <idOrTime>').option('--until <idOrTime>')
    .option('--older-than <age>', 'e.g. 30m · 2h · 1d')
    .option('--ids-file <file>', 'only these ids (whitespace/comma separated)')
    .option('--yes', 'apply (default is dry-run)')
    .option('--include-protected', 'also clear crown-directive · alert · original ✋ mails (still needs --yes)')
    .option('--fold-into-card', 'post one summary card of the grouped causes to the seat, then ack')
    .option('--undo <receipt>', 'un-ack exactly the ids of a clear receipt')
    .option('--json')
    .action(async (opts: ClearOpts) => {
      const lib = await import('../msg/msg-clear.js');
      const fail = (line: string): void => { out.error(line); setExitCode(1); };
      if (!opts.by) return fail('msg clear: --by <seat> is required');
      const store = deps.openStore();
      try {
        const ladder = (): Pick<FederationLadder, 'parentOf'> | null => {
          if (deps.ladder) return deps.ladder();
          try { return (require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js')).loadFederationLadder(); } catch { return null; }
        };
        if (opts.undo) {
          const receipt = JSON.parse(readFileSync(opts.undo, 'utf8')) as { to?: string };
          if (!receipt.to || !mayClear(opts.by, receipt.to, ladder())) return fail(`msg clear: ${opts.by} may not undo a clear of ${receipt.to ?? '?'}`);
          const r = lib.undoClear(store, opts.undo);
          if (opts.json) out.log(JSON.stringify({ undone: true, restored: r.restored, belowCursor: r.belowCursor, to: r.receipt.to }));
          else out.log(`undo: ${r.restored} mails unread again at ${r.receipt.to}${r.belowCursor ? ` · ${r.belowCursor} stay read (cursor moved past)` : ''}`);
          return;
        }
        if (!opts.to) return fail('msg clear: --to <seat> is required');
        if (!mayClear(opts.by, opts.to, ladder())) return fail(`msg clear: ${opts.by} may not clear ${opts.to} (only the seat, its coordinator, OP, CLAUDE-OP)`);
        if (opts.match) { try { new RegExp(opts.match); } catch (e) { return fail(`msg clear: bad --match regex: ${(e as Error).message}`); } }
        const filters = {
          to: opts.to,
          ...(opts.from ? { from: opts.from } : {}), ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.match ? { match: opts.match } : {}),
          ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.since ? { since: opts.since } : {}), ...(opts.until ? { until: opts.until } : {}),
          ...(opts.olderThan ? { olderThanMs: lib.parseAge(opts.olderThan) } : {}),
          ...(opts.idsFile ? { ids: readFileSync(opts.idsFile, 'utf8').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isSafeInteger) } : {}),
          ...(opts.includeProtected ? { includeProtected: true } : {}),
        };
        const now = deps.now?.() ?? new Date();
        const plan = lib.planClear(store, filters, now);
        const sample = plan.selected.slice(0, 10).map(m => m.id);
        if (!opts.yes) {
          if (opts.json) { out.log(JSON.stringify({ dryRun: true, to: plan.to, count: plan.selected.length, protectedSkipped: plan.protectedSkipped.length, groups: plan.groups.slice(0, 10), sampleIds: sample })); return; }
          out.log(`DRY-RUN · ${plan.to} · ${plan.selected.length} mails match (${lib.filterLine(filters)}) · protected skipped ${plan.protectedSkipped.length}`);
          for (const g of plan.groups.slice(0, 10)) out.log(`  ${String(g.count).padStart(4)}× ${g.from} · ${g.kind} · «${g.head}»`);
          if (plan.groups.length > 10) out.log(`  … ${plan.groups.length - 10} more groups`);
          out.log(`  sample ids: ${sample.join(' ') || '-'}`);
          out.log('  apply with --yes');
          return;
        }
        if (opts.includeProtected) out.error(`⚠️ msg clear --include-protected: ${plan.selected.filter(lib.isProtectedMail).length} protected mails (crown/alert/✋) at ${plan.to} will be acked by ${opts.by}`);
        const r = lib.applyClear(store, plan, { filters, by: canonicalMessageAddress(opts.by), now, foldIntoCard: opts.foldIntoCard === true });
        if (opts.includeProtected) {
          try { (await import('../debug/log.js')).debug.log('msg.clear', 'include-protected', { to: plan.to, by: opts.by, ids: r.receipt.protectedIncluded, receipt: r.receiptPath }, { level: 'warn' }); } catch { /* fail-open */ }
        }
        if (opts.json) out.log(JSON.stringify({ applied: true, to: plan.to, cleared: r.receipt.ids.length, receipt: r.receiptPath, cardId: r.receipt.cardId ?? null, noticeId: r.receipt.noticeId }));
        else out.log(`cleared ${r.receipt.ids.length} mails at ${plan.to} · protected skipped ${plan.protectedSkipped.length} · receipt ${r.receiptPath}${r.receipt.cardId ? ` · card #${r.receipt.cardId}` : ''}`);
      } catch (e) {
        fail(`msg clear: ${(e as Error).message}`);
      } finally { store.close(); }
    });
}

interface ResetOpts { to?: string; space?: string; federation?: boolean; by?: string; yes?: boolean; includeProtected?: boolean; restore?: string; json?: boolean }

/** `eln msg reset` — DELETE a seat · space · federation's mail (snapshot first · dry-run default · --restore). */
export function registerMsgResetCommand(msg: Command, deps: MsgClearCliDeps & { storePath?: () => string }): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  msg.command('reset').description('DELETE mail for a seat (--to) · space (--space <coordinator>) · whole federation — snapshot first, dry-run default, --restore <backup>')
    .option('--to <seat>').option('--space <coordinator>').option('--federation')
    .option('--by <seat>', 'acting seat (required): OP or CLAUDE-OP; a seat itself / its coordinator for --to; the coordinator for its --space')
    .option('--yes', 'apply (default is dry-run)')
    .option('--include-protected', 'also delete crown-directive · alert · original ✋ mails (required for --federation)')
    .option('--restore <backup>', 'restore a backup DB over the store (the current store is snapshotted first)')
    .option('--json')
    .action(async (opts: ResetOpts) => {
      const lib = await import('../msg/msg-reset.js');
      const fail = (line: string): void => { out.error(line); setExitCode(1); };
      if (!opts.by) return fail('msg reset: --by <seat> is required');
      const by = canonicalMessageAddress(opts.by);
      const now = deps.now?.() ?? new Date();
      const ladder = (): Pick<FederationLadder, 'parentOf'> | null => {
        if (deps.ladder) return deps.ladder();
        try { return (require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js')).loadFederationLadder(); } catch { return null; }
      };
      if (opts.restore) {
        if (!ALWAYS_ALLOWED.includes(by)) return fail('msg reset --restore: only OP or CLAUDE-OP');
        if (!opts.yes) { out.log(`DRY-RUN · would restore ${opts.restore} over the msg store (current store snapshotted first) · apply with --yes`); return; }
        const path = deps.storePath?.() ?? (() => { const s = deps.openStore(); try { return s.db.filename; } finally { s.close(); } })();
        try {
          const r = lib.restoreBackup(path, opts.restore, deps.openStore, now);
          out.log(opts.json ? JSON.stringify({ restored: opts.restore, preRestoreBackup: r.preRestoreBackup }) : `restored ${opts.restore} · previous store saved at ${r.preRestoreBackup}`);
        } catch (e) { fail(`msg reset: ${(e as Error).message}`); }
        return;
      }
      const picked = [opts.to ? 1 : 0, opts.space ? 1 : 0, opts.federation ? 1 : 0].reduce((a, b) => a + b, 0);
      if (picked !== 1) return fail('msg reset: pick exactly one of --to <seat> · --space <coordinator> · --federation');
      const scope: import('../msg/msg-reset.js').ResetScope = opts.to ? { kind: 'seat', seat: opts.to } : opts.space ? { kind: 'space', coordinator: opts.space } : { kind: 'federation' };
      const allowed = ALWAYS_ALLOWED.includes(by)
        || (scope.kind === 'seat' && mayClear(by, scope.seat, ladder()))
        || (scope.kind === 'space' && canonicalMessageAddress(scope.coordinator) === by);
      if (!allowed) return fail(`msg reset: ${opts.by} may not reset ${lib.scopeLabel(scope)}`);
      if (scope.kind === 'federation' && opts.yes && !opts.includeProtected) return fail('msg reset --federation needs --include-protected explicitly (crown/alert/✋ mail goes too)');
      const store = deps.openStore();
      try {
        const plan = lib.planReset(store, scope, ladder(), opts.includeProtected === true);
        if (!opts.yes) {
          if (opts.json) { out.log(JSON.stringify({ dryRun: true, scope: plan.label, deletable: plan.ids.length, protectedKept: plan.protectedKept, seats: plan.seats })); return; }
          out.log(`DRY-RUN · reset ${plan.label} · ${plan.ids.length} mails would be DELETED · protected kept ${plan.protectedKept}`);
          for (const s of plan.seats) out.log(`  ${s.seat.padEnd(14)} ${String(s.deletable).padStart(5)} delete · ${s.protectedKept} protected kept · ${s.total} total`);
          out.log('  a snapshot is taken before applying · apply with --yes');
          return;
        }
        const backup = lib.snapshotStore(store, plan.label, now);
        out.error(`snapshot: ${backup}`);
        if (opts.includeProtected) out.error(`⚠️ msg reset --include-protected · ${plan.label} · by ${by}`);
        const r = lib.applyReset(store, plan, { by, backupPath: backup });
        try { (await import('../debug/log.js')).debug.log('msg.reset', 'applied', { scope: plan.label, by, deleted: r.deleted, backup, includeProtected: opts.includeProtected === true }, { level: 'warn' }); } catch { /* fail-open */ }
        out.log(opts.json ? JSON.stringify({ applied: true, scope: plan.label, deleted: r.deleted, perSeat: r.perSeat, backup })
          : `reset ${plan.label} · ${r.deleted} mails deleted · backup ${backup} · undo: eln msg reset --restore ${backup} --by ${by} --yes`);
      } catch (e) { fail(`msg reset: ${(e as Error).message}`); } finally { store.close(); }
    });
}
