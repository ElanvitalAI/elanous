#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { emitNodeResult, readGraphContext, type GraphContext } from './node-verdict.js';
import { regressWarning, validatedTuiRegress } from './tui-node-checks.js';

export type MetricVerdict = 'pass' | 'fail' | 'unmeasured';
export interface ApprovalMetric { name: string; value: string; verdict: MetricVerdict; reason?: string }

const outcomeMetric = (name: string, node: Record<string, unknown> | undefined): ApprovalMetric => ({
  name, value: node?.outcome === undefined ? 'missing' : String(node.outcome),
  verdict: node?.outcome === undefined ? 'unmeasured' : node.outcome === 'ok' ? 'pass' : 'fail',
});

/** Rows shown in auto-approval.md but never counted toward the 8 blocking metrics. */
export const WARNING_ONLY = new Set(['tui-regress', 'mac-smoke']);

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
  const regressStatus = regressWarning(validatedTuiRegress(context.outputs.tui?.regress));
  const macSmoke = context.outputs['mac-smoke'];
  const metrics: ApprovalMetric[] = [
    { name: 'gate regressions and measurement', value: JSON.stringify({ outcome: gate?.outcome ?? null, introduced: gate?.introduced ?? null, error: gate?.error ?? null }),
      verdict: !gate || gate.outcome === undefined || !Array.isArray(gate.introduced) ? 'unmeasured'
        : gate.outcome === 'ok' && gate.introduced.length === 0 && gateErrorAbsent ? 'pass' : 'fail' },
    { name: 'bun version', value: `running=${bunVersion}; pinned=${pinned ?? 'missing'}`,
      verdict: !pinned ? 'unmeasured' : bunVersion === pinned ? 'pass' : 'fail' },
    outcomeMetric('upgrade', context.outputs.upgrade),
    outcomeMetric('tui', context.outputs.tui),
    outcomeMetric('notes-check', context.outputs['notes-check']),
    { name: 'public leak and prepare completeness', value: `prepare=${prepare?.outcome ?? 'missing'}`,
      verdict: prepare?.outcome === undefined ? 'unmeasured' : prepare.outcome === 'ok' ? 'pass' : 'fail' },
    { name: 'docs notes page', value: `docs=${context.outputs.docs?.outcome ?? 'missing'}; notes=${String(context.outputs.docs?.notes ?? 'missing')}`,
      verdict: context.outputs.docs?.outcome === undefined || context.outputs.docs.notes === undefined ? 'unmeasured'
        : context.outputs.docs.outcome === 'ok' && typeof context.outputs.docs.notes === 'string' && context.outputs.docs.notes.trim() ? 'pass' : 'fail' },
    { name: 'installation files', value: `dist files=${distCount ?? 'missing'}; prepare.out=${String(out ?? 'missing')}`,
      verdict: prepare?.outcome !== 'ok' ? prepare?.outcome === undefined ? 'unmeasured' : 'fail'
        : distCount === undefined ? 'unmeasured' : distCount === 5 ? 'pass' : 'fail' },
    // Warning-only and last, so the numbered rows 1–8 keep their places in auto-approval.md (V1g follow-up).
    { name: 'tui-regress', value: regressStatus.level, reason: regressStatus.line, verdict: 'pass' },
    // MAC1: the macOS smoke is warning-only too (ship with known issues) — shown, never counted.
    { name: 'mac-smoke', value: macSmokeLevel(macSmoke), reason: typeof macSmoke?.summary === 'string' ? macSmoke.summary : undefined, verdict: 'pass' },
  ];
  const outcome = metrics.filter((metric) => !WARNING_ONLY.has(metric.name)).every((metric) => metric.verdict === 'pass') ? 'ok' as const : 'fail' as const;
  const report = join(root, 'release', version, 'auto-approval.md');
  const lines = [`# v${version} auto-approval`, '', `Outcome: ${outcome}`, '', '| # | Metric | Value | Verdict |', '|---|---|---|---|',
    ...metrics.map((metric, i) => `| ${i + 1} | ${metric.name} | ${[metric.value, metric.reason].filter(Boolean).join(' — ').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')} | ${metric.verdict} |`),
    '', '## 되돌리는 법', `gh release edit v${version} --draft`, `git tag -d v${version} && git push origin :refs/tags/v${version}`, '해당 docs PR revert', ''];
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, lines.join('\n'));
  debug.log('release-loop.approve', 'auto-decision', { version, outcome, metrics });
  return { outcome, verdict: outcome === 'ok' ? 'pass' as const : 'fail' as const, summary: `auto approval ${outcome}: ${metrics.filter((metric) => !WARNING_ONLY.has(metric.name) && metric.verdict === 'pass').length}/8`,
    ...(outcome === 'ok' ? { decidedBy: 'release-loop metrics' as const } : {}), metrics, report };
}

if (import.meta.main) {
  try {
    const result = runAutoApprove();
    emitNodeResult(result);
    process.exitCode = result.outcome === 'ok' ? 0 : 1;
  } catch (error) {
    emitNodeResult({ outcome: 'fail', verdict: 'fail', summary: `auto approval unmeasured: ${error instanceof Error ? error.message : String(error)}` });
    process.exitCode = 1;
  }
}
