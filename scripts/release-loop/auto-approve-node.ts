#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { emitNodeResult, readGraphContext, type GraphContext } from './node-verdict.js';
import { regressWarning, validatedTuiRegress } from './tui-node-checks.js';

export type MetricVerdict = 'pass' | 'fail' | 'unmeasured';
export interface ApprovalMetric { name: string; value: string; verdict: MetricVerdict; reason?: string }

const outcomeMetric = (name: string, node: Record<string, unknown> | undefined): ApprovalMetric => ({
  name, value: node?.outcome === undefined ? 'missing' : String(node.outcome),
  verdict: node?.outcome === undefined ? 'unmeasured' : node.outcome === 'ok' ? 'pass' : 'fail',
});

/** Rows outside the original eight fixed metrics. TUI regressions have their own HITL gate below. */
export const WARNING_ONLY = new Set(['tui-regress', 'mac-smoke']);
export const BLOCKING_METRIC_NAMES = [
  'gate regressions and measurement', 'bun version', 'upgrade', 'tui', 'notes-check',
  'public leak and prepare completeness', 'docs notes page', 'installation files',
] as const;

/** `ok` · `warn` (a failure) · `unmeasured` (error or no output) — the macOS smoke never blocks publishing. */
function macSmokeLevel(node: Record<string, unknown> | undefined): 'ok' | 'warn' | 'unmeasured' {
  if (node?.outcome === 'ok') return 'ok';
  if (node?.outcome === 'fail') return 'warn';
  return 'unmeasured';
}

export function runAutoApprove(context: GraphContext = readGraphContext(), deps: { instanceRoot?: string; repo?: string; bunVersion?: string } = {}) {
  const { version } = context.input;
  const root = deps.instanceRoot ?? effectiveInstanceRoot();
  const repo = deps.repo ?? resolve(import.meta.dir, '../..');
  const gate = context.outputs.gate;
  const prepare = context.outputs.prepare;
  let pinned: string | undefined;
  try { pinned = readFileSync(join(repo, '.bun-version'), 'utf8').trim(); } catch { pinned = undefined; }
  const bunVersion = deps.bunVersion ?? Bun.version;
  const out = prepare?.out;
  let distCount: number | undefined;
  if (prepare?.outcome === 'ok' && typeof out === 'string' && isAbsolute(out)
    && resolve(out) === join(root, 'release', version, 'prepared')) {
    try { distCount = readdirSync(join(out, 'dist'), { withFileTypes: true }).filter((entry) => entry.isFile()).length; }
    catch { distCount = undefined; }
  }
  const gateErrorAbsent = gate && !Object.hasOwn(gate, 'error');
  const regress = validatedTuiRegress(context.outputs.tui?.regress);
  const regressStatus = regressWarning(regress);
  const failedCheckIds = 'unmeasured' in regress ? null : regress.results.filter((result) => !result.ok).map((result) => result.id);
  const failedLabel = failedCheckIds === null ? 'unmeasured' : `${failedCheckIds.length} [${failedCheckIds.join(', ') || '-'}]`;
  const regressNeedsApproval = regressStatus.level !== 'ok';
  const macSmoke = context.outputs['mac-smoke'];
  const metrics: ApprovalMetric[] = [
    { name: BLOCKING_METRIC_NAMES[0], value: JSON.stringify({ outcome: gate?.outcome ?? null, introduced: gate?.introduced ?? null, error: gate?.error ?? null }),
      verdict: !gate || gate.outcome === undefined || !Array.isArray(gate.introduced) ? 'unmeasured'
        : gate.outcome === 'ok' && gate.introduced.length === 0 && gateErrorAbsent ? 'pass' : 'fail' },
    { name: BLOCKING_METRIC_NAMES[1], value: `running=${bunVersion}; pinned=${pinned ?? 'missing'}`,
      verdict: !pinned ? 'unmeasured' : bunVersion === pinned ? 'pass' : 'fail' },
    outcomeMetric(BLOCKING_METRIC_NAMES[2], context.outputs.upgrade),
    outcomeMetric(BLOCKING_METRIC_NAMES[3], context.outputs.tui),
    outcomeMetric(BLOCKING_METRIC_NAMES[4], context.outputs['notes-check']),
    { name: BLOCKING_METRIC_NAMES[5], value: `prepare=${prepare?.outcome ?? 'missing'}`,
      verdict: prepare?.outcome === undefined ? 'unmeasured' : prepare.outcome === 'ok' ? 'pass' : 'fail' },
    { name: BLOCKING_METRIC_NAMES[6], value: `docs=${context.outputs.docs?.outcome ?? 'missing'}; notes=${String(context.outputs.docs?.notes ?? 'missing')}`,
      verdict: context.outputs.docs?.outcome === undefined || context.outputs.docs.notes === undefined ? 'unmeasured'
        : context.outputs.docs.outcome === 'ok' && typeof context.outputs.docs.notes === 'string' && context.outputs.docs.notes.trim() ? 'pass' : 'fail' },
    { name: BLOCKING_METRIC_NAMES[7], value: `dist files=${distCount ?? 'missing'}; prepare.out=${String(out ?? 'missing')}`,
      verdict: prepare?.outcome !== 'ok' ? prepare?.outcome === undefined ? 'unmeasured' : 'fail'
        : distCount === undefined ? 'unmeasured' : distCount === 5 ? 'pass' : 'fail' },
    // Kept after the eight fixed metrics; a failed or unmeasured subcheck requires the existing approve-publish HITL node.
    { name: 'tui-regress', value: regressStatus.level, reason: regressStatus.line,
      verdict: regressStatus.level === 'ok' ? 'pass' : regressStatus.level === 'warn' ? 'fail' : 'unmeasured' },
    // MAC1: the macOS smoke is warning-only too (ship with known issues) — shown, never counted.
    { name: 'mac-smoke', value: macSmokeLevel(macSmoke), reason: typeof macSmoke?.summary === 'string' ? macSmoke.summary : undefined, verdict: 'pass' },
  ];
  const outcome = metrics.filter((metric) => !WARNING_ONLY.has(metric.name)).every((metric) => metric.verdict === 'pass')
    && !regressNeedsApproval ? 'ok' as const : 'fail' as const;
  const report = join(root, 'release', version, 'auto-approval.md');
  const lines = [`# v${version} auto-approval`, '', `Outcome: ${outcome}`, '', '| # | Metric | Value | Verdict |', '|---|---|---|---|',
    ...metrics.map((metric, i) => `| ${i + 1} | ${metric.name} | ${[metric.value, metric.reason].filter(Boolean).join(' — ').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')} | ${metric.verdict} |`),
    '', `TUI subcheck: ${regressStatus.level} · failed ${failedLabel} · ${regressNeedsApproval ? 'HITL 수용/정지 필요' : '자동 판정 가능'}`,
    '', '## 되돌리는 법', `gh release edit v${version} --draft`, `git tag -d v${version} && git push origin :refs/tags/v${version}`, '해당 docs PR revert', ''];
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, lines.join('\n'));
  const tuiSubcheck = { runId: context.runId ?? null, level: regressStatus.level,
    fail: failedCheckIds?.length ?? null, failedCheckIds, approvalRequired: regressNeedsApproval };
  debug.log('release-loop.approve', 'auto-decision', { version, outcome, metrics, tuiSubcheck });
  return { outcome, verdict: outcome === 'ok' ? 'pass' as const : 'fail' as const,
    summary: `auto approval ${outcome}: ${metrics.filter((metric) => !WARNING_ONLY.has(metric.name) && metric.verdict === 'pass').length}/8${regressNeedsApproval ? ` · tui-regress ${regressStatus.level} failed ${failedLabel} → HITL` : ''}`,
    runId: context.runId ?? null, tuiSubcheck, ...(outcome === 'ok' ? { decidedBy: 'release-loop metrics' as const } : {}), metrics, report };
}

if (import.meta.main) {
  // GATE-OBS2-1 — the release graph spawns this node as its own process, which inherits no daemon sink. Without this the
  // `release-loop.approve / auto-decision` event (the one that says why a release was or was not published unattended)
  // stayed in the file trail and `elanous logs` read 0 rows. Same pattern as gate-node.ts.
  // Observability must never stop the release node from emitting its verdict — a failed sink registration is skipped.
  try { await registerStandaloneLogSink('release-loop'); } catch { /* fail-soft: the decision still goes to stdout */ }
  try {
    const result = runAutoApprove();
    emitNodeResult(result);
    process.exitCode = result.outcome === 'ok' ? 0 : 1;
  } catch (error) {
    emitNodeResult({ outcome: 'fail', verdict: 'fail', summary: `auto approval unmeasured: ${error instanceof Error ? error.message : String(error)}` });
    process.exitCode = 1;
  }
}
