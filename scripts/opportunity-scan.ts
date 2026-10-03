#!/usr/bin/env bun
// P5b — opportunity scan (PFC Layer-2 autonomous loop, DISARMED by default).
//
//   bun run scripts/opportunity-scan.ts            # scan + report (respects config)
//   bun run scripts/opportunity-scan.ts --dry      # report only, never send/analyze
//   bun run scripts/opportunity-scan.ts --arm-once # force-run ONE analysis (validate)
//
// Behaviour:
//   • finance.autoLoop.enabled = false (default) → REPORT candidates only.
//   • finance.autoLoop.enabled = true  → auto-run analysis for the top
//     `maxPerScan` high-severity candidates, append to the report.
//   • --arm-once overrides config to run exactly ONE analysis (operator
//     validation of the autonomous path without arming the cron).
// The report goes to the L5 report channel (unless --dry).

import { evaluateOpportunities, renderOpportunities } from '../src/domains/finance-opportunity.js';
import { runOpportunityAnalysis, renderOpportunityAnalysis } from '../src/domains/opportunity-analysis.js';
import { sendTelegramReport } from '../src/telegram-report.js';
import { getUserConfig } from '../src/user-config.js';

const dry = process.argv.includes('--dry');
const armOnce = process.argv.includes('--arm-once');

const cfg = getUserConfig();
const armed = cfg.finance.autoLoop?.enabled === true;
const maxPerScan = cfg.finance.autoLoop?.maxPerScan ?? 2;

const signals = evaluateOpportunities();
const candidates = signals.filter(s => s.warrantsAnalysis);

const parts: string[] = [
  `⚙️ *기회 스캔* — ${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' })}`,
  `_${signals.length} 신호 · ${candidates.length} 자율분석 후보 · autoLoop=${armed ? 'ARMED' : 'disarmed'}_`,
  '',
  renderOpportunities(signals),
];

// Decide how many analyses to run: armed → up to maxPerScan; --arm-once → 1;
// otherwise → 0 (report only).
const runN = armOnce ? Math.min(1, candidates.length) : armed ? Math.min(maxPerScan, candidates.length) : 0;

if (runN > 0) {
  console.error(`[opportunity-scan] running ${runN} autonomous ${runN === 1 ? 'analysis' : 'analyses'}…`);
  for (const signal of candidates.slice(0, runN)) {
    const a = await runOpportunityAnalysis(signal, cfg);
    parts.push(renderOpportunityAnalysis(a));
  }
} else if (candidates.length > 0) {
  parts.push(`\n_${candidates.length} 후보 대기 — autoLoop disarmed. arm: config finance.autoLoop.enabled=true 또는 --arm-once. 매매는 verify+HITL._`);
}

const report = parts.join('\n');

if (dry) {
  console.log(report);
} else {
  const sent = await sendTelegramReport(cfg, report, { markdown: true, kind: 'report' });
  console.error(sent
    ? '[opportunity-scan] sent to report channel ✓'
    : '[opportunity-scan] no report channel — printing:\n' + report);
}
