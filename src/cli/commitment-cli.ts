// ── `eln commitment list|done|blocked|watches|watch-sweep` (COMMITMENT-CLOSE · beta · 2026-11-25 · COND-WATCH 11-28) ──
// Waker notices name this CLI as the twin of the CommitmentClose seat tool.
// Exit codes: 0 = ok · 1 = unknown id or lifecycle conflict (double close) · 2 = argument or ledger error.
import type { Command } from 'commander';
import { closeCommitmentChecked, type CloseCommitmentDeps, type CommitmentCloseStatus } from '../commitment/close.js';
import { CommitmentLedger, CommitmentLifecycleConflict, type CommitmentEntry, type CommitmentStatus } from '../commitment/ledger.js';

export interface CommitmentCliDeps extends CloseCommitmentDeps {
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
}

const LIST_STATUS: Readonly<Record<string, readonly CommitmentStatus[] | null>> = {
  open: ['open'], blocked: ['blocked'], done: ['done'], dropped: ['dropped'], reassigned: ['reassigned'], live: ['open', 'blocked'], all: null,
};

function formatEntry(e: CommitmentEntry): string {
  const tail = e.status === 'done' ? ` · evidence: ${e.doneEvidence ?? ''}` : e.reason ? ` · reason: ${e.reason}` : '';
  const wakers = e.wakers.length > 0 ? ` · wakers ${e.wakers.map(w => w.wakerId).join(',')}` : '';
  return `${e.id} ${e.seat} ${e.status} «${e.text}»${wakers}${tail}`;
}

export function registerCommitmentCommands(program: Command, deps: CommitmentCliDeps = {}): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const ledgerOf = (): CommitmentLedger => deps.ledger ?? new CommitmentLedger();
  const cmd = program.command('commitment').description('Commitment ledger (beta) — list commitments and close them done or blocked with evidence');

  cmd.command('list').description('List commitments (default: open and blocked) for one seat or all seats')
    .option('--seat <seat>', 'Only this seat')
    .option('--status <status>', 'open | blocked | done | dropped | live | all', 'live')
    .option('--json')
    .action((opts: { seat?: string; status: string; json?: boolean }) => {
      try {
        const key = opts.status.trim().toLowerCase();
        if (!(key in LIST_STATUS)) throw new Error(`--status must be one of ${Object.keys(LIST_STATUS).join(', ')}`);
        const statuses = LIST_STATUS[key];
        const ledger = ledgerOf();
        const seats = opts.seat ? [opts.seat.trim().toUpperCase()] : ledger.seats();
        const entries = seats.flatMap(seat => ledger.list(seat, statuses ? { status: statuses } : {}));
        if (opts.json) { out.log(JSON.stringify(entries, null, 2)); return; }
        if (entries.length === 0) { out.log('No commitments.'); return; }
        for (const e of entries) out.log(formatEntry(e));
      } catch (error) {
        out.error(`commitment list: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      }
    });

  // COND-WATCH — the open conditions every seat is waiting on (armed wakers), and one sweep by hand (the trigger runs it every 5 min).
  cmd.command('watches').description('List open conditions (armed watches) — what each seat waits on, oldest horizon first; stale = retired by the next live sweep')
    .option('--seat <seat>', 'Only this seat')
    .option('--state <state>', 'open | overdue | stale | all', 'all')
    .option('--json')
    .action(async (opts: { seat?: string; state: string; json?: boolean }) => {
      try {
        const want = opts.state.trim().toLowerCase();
        if (!['open', 'overdue', 'stale', 'all'].includes(want)) throw new Error('--state must be one of open, overdue, stale, all');
        const { listOpenConditions } = await import('../commitment/condition-sweep.js');
        const rows = listOpenConditions(opts.seat ? { seat: opts.seat } : {}, deps.timer ?? {}).filter(r => want === 'all' || r.state === want);
        if (opts.json) { out.log(JSON.stringify(rows, null, 2)); return; }
        if (rows.length === 0) { out.log('No open conditions.'); return; }
        const by = (s: string) => rows.filter(r => r.state === s).length;
        out.log(`Open conditions ${rows.length} · open ${by('open')} · overdue ${by('overdue')} · stale ${by('stale')}`);
        for (const r of rows) {
          const when = r.overdueMin < 0 ? `${-r.overdueMin}m left` : `${r.overdueMin}m past`;
          out.log(`${r.state} ${r.seat}/${r.wakerId} · ${r.condition} · awaits ${r.awaits} · ${when} · commitment ${r.commitmentId}${r.autoClose ? ' · auto-close' : ''}${r.watched ? ' · watched' : ''}`);
        }
      } catch (error) {
        out.error(`commitment watches: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      }
    });

  cmd.command('watch-sweep').description('Measure every armed condition once (met → close ⊕ one wake · expired → one wake · stale → retired silently)')
    .option('--seat <seat>', 'Only this seat')
    .option('--dry-run', 'Judge only: no ledger write, no wake')
    .option('--json')
    .action(async (opts: { seat?: string; dryRun?: boolean; json?: boolean }) => {
      try {
        const { sweepConditions } = await import('../commitment/condition-sweep.js');
        const report = await sweepConditions({ ...(opts.seat ? { seat: opts.seat } : {}), dryRun: opts.dryRun === true }, deps.timer ?? {});
        if (opts.json) { out.log(JSON.stringify(report, null, 2)); return; }
        out.log(report.line);
      } catch (error) {
        out.error(`commitment watch-sweep: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      }
    });

  for (const status of ['done', 'blocked', 'reassigned'] as const satisfies readonly CommitmentCloseStatus[]) {
    cmd.command(`${status} <id>`)
      .description(status === 'done'
        ? 'Mark a commitment done with one line of evidence and cancel its waker (refused unless its done-when predicate holds)'
        : status === 'reassigned' ? 'Mark a commitment reassigned with one line saying to whom and why, and cancel its waker'
          : 'Mark a commitment blocked with one line saying what blocks it and cancel its waker')
      .requiredOption('--evidence <line>', status === 'done' ? 'One line: test result, receipt path or PR' : status === 'reassigned' ? 'One line: to whom and why' : 'One line: what blocks it')
      .option('--seat <seat>', 'Owning seat (found by id when omitted)')
      .option('--json')
      .action(async (id: string, opts: { evidence: string; seat?: string; json?: boolean }) => {
        try {
          const { entry, cancelledWakers } = await closeCommitmentChecked({ id, status, evidence: opts.evidence, ...(opts.seat ? { seat: opts.seat } : {}) }, deps);
          const wakers = cancelledWakers.map(w => w.id);
          if (opts.json) out.log(JSON.stringify({ ok: true, entry, cancelledWakers: wakers }, null, 2));
          else out.log(`Commitment ${entry.id} (${entry.seat}) → ${entry.status} · wakers cancelled: ${wakers.length === 0 ? 'none' : wakers.join(', ')}`);
        } catch (error) {
          out.error(`commitment ${status}: ${error instanceof Error ? error.message : String(error)}`);
          setExitCode(error instanceof CommitmentLifecycleConflict ? 1 : 2);
        }
      });
  }
}
