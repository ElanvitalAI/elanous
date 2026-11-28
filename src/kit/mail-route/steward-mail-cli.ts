// `eln msg steward-shadow` — replay any window of a coordinator's mail through steward:mail (STEWARD-MAIL · shadow).
// Read-only: the mail ledger is opened read-only and nothing is routed or written.
import type { Command } from 'commander';

export interface StewardShadowCliDeps {
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
}

export function registerStewardShadowCommand(msg: Command, deps: StewardShadowCliDeps = {}): void {
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  msg.command('steward-shadow')
    .description('Replay a window of a coordinator\'s mail through steward:mail (wake-now · digest · record-only) next to what the router did — shadow, read-only')
    .option('--to <seat>', 'Recipient (default: the policy recipients)')
    .option('--hours <n>', 'Window length in hours, ending now', '24')
    .option('--jev <n>', 'Ask Jev for up to n mails the structured fields could not decide (promote only)', '0')
    .option('--db <path>', 'Mail ledger path (default: this universe\'s msg/messages.db)')
    .option('--rows', 'Print one line per mail')
    .option('--json')
    .action(async (opts: { to?: string; hours: string; jev: string; db?: string; rows?: boolean; json?: boolean }) => {
      try {
        const hours = Number(opts.hours);
        const jevMax = Number(opts.jev);
        if (!(hours > 0) || hours > 24 * 14) throw new Error('--hours must be in (0, 336]');
        if (!Number.isInteger(jevMax) || jevMax < 0) throw new Error('--jev must be a non-negative integer');
        const { openMsgStoreReadOnly } = await import('../../msg/msg-store.js');
        const { readStewardMailPolicy, shadowReport, shadowRows } = await import('./steward-mail.js');
        const { askJevFor, defaultStewardDecide, ladderRelation, loadStewardMails } = await import('./steward-mail-shadow.js');
        const policy = readStewardMailPolicy();
        const recipients = opts.to ? [opts.to.trim().toUpperCase()] : [...policy.recipients];
        const now = new Date();
        const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
        const store = openMsgStoreReadOnly(opts.db);
        try {
          const senderAbove = await ladderRelation();
          const decide = jevMax > 0 ? await defaultStewardDecide() : null;
          const reports = [];
          for (const to of recipients) {
            const mails = loadStewardMails(store.db, to, since);
            const known = decide ? await askJevFor(mails, policy, decide, jevMax) : new Map();
            const rows = shadowRows(mails, { policy, ...(senderAbove ? { senderAbove } : {}), jevKnown: known });
            const report = shadowReport(rows, hours, policy);
            reports.push({ to, report, ...(opts.rows ? { rows } : {}), jevAsked: known.size });
            if (!opts.json) {
              out.log(`${to} · ${report.line}${decide ? ` · jev asked ${known.size}` : ''}`);
              for (const [k, n] of Object.entries(report.byReason).sort((a, b) => b[1] - a[1])) out.log(`  ${k} ${n}`);
              if (opts.rows) for (const r of rows) out.log(`  #${r.msgId} ${r.at} ${r.from} ${r.kind || '-'} → ${r.verdict}:${r.reason}${r.signal === 'jev' ? '(jev)' : ''} · router ${r.actual}:${r.actualReason}${r.answered ? ' · answered' : ''}`);
            }
          }
          if (opts.json) out.log(JSON.stringify(reports, null, 2));
        } finally { store.close(); }
      } catch (error) {
        out.error(`msg steward-shadow: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      }
    });
}
