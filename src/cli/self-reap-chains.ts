// TUI-RESTART-NESTED-CHAIN — `elanous self reap-chains --dry-run|--yes [--json]`: one-shot cleanup of nested TUI
// restart chains left by the old spawn-and-wait restart. Exact pids only (no pkill). Default = dry run.
// Per chain: SIGSTOP the pane root, SIGKILL the waiting wrappers top-down, keep the leaf (see src/tui/restart-chain.ts
// for why terminating the wrappers directly would take the leaf's terminal with them).
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { applyChainPlan, formatReapPlans, planReap, readProcessTable } from '../tui/restart-chain.js';
import { writeStdoutJson } from './stdout-json.js';

export function registerSelfReapChainsCommand(selfCmd: Command): void {
  selfCmd.command('reap-chains')
    .description('Collapse nested TUI restart chains: freeze each pane root, end its idle waiting wrappers, keep the live leaf (default dry run)')
    .option('--dry-run', 'show the plan only (default)')
    .option('--yes', 'apply the plan (exact pids · SIGSTOP root · SIGKILL wrappers top-down · SIGCONT frozen roots whose leaf exited)')
    .option('--json', 'machine-readable plan and results')
    .action(async (opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const rows = readProcessTable();
      const plans = planReap(rows);
      const apply = opts.yes === true && opts.dryRun !== true;
      debug.log('tui.restart', 'reap-plan', { chains: plans.length, apply, plans: plans.map((plan) => ({ sessionId: plan.sessionId, depth: plan.depth, action: plan.action.kind })) });
      if (!apply) {
        if (opts.json) await writeStdoutJson(JSON.stringify({ apply: false, plans }, null, 2));
        else console.log(`${formatReapPlans(plans)}\n(dry run — rerun with --yes to apply)`);
        return;
      }
      const results = [];
      for (const plan of plans) {
        const result = await applyChainPlan(plan, rows);
        results.push({ sessionId: plan.sessionId, action: plan.action.kind, ...result });
        debug.log('tui.restart', 'reap-applied', { sessionId: plan.sessionId, action: plan.action.kind, ok: result.ok, detail: result.detail, killed: result.killed });
        if (!opts.json) console.log(`${result.ok ? 'ok ' : 'SKIP'} ${plan.sessionId ?? '-'} ${plan.action.kind}: ${result.detail}`);
      }
      if (opts.json) await writeStdoutJson(JSON.stringify({ apply: true, plans, results }, null, 2));
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    });
}
