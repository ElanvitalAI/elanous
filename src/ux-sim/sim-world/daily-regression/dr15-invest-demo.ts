// DR15 · DEMO-1126-INVEST-ORCH — the invest demo graph's recorded (--dry-run) run completes through the real graph runner
// in this scenario's universe: 15 panel/mentor nodes (12 personas + 3 mentors) running in parallel, report first line =
// the disclaimer, Conatus execution disabled, decision triage line present. Fixtures only (no network, no model).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DailyRegressionScenario } from './scenarios.js';

export const dr15: DailyRegressionScenario = {
  id: 'DR15', prs: [39965],
  title: 'invest demo graph dry-run',
  async run(ctx) {
    const failures: string[] = [];
    const eq = (label: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)} · observed ${JSON.stringify(actual)}`);
    };
    const saved = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = ctx.universeRoot;
    try {
      const { runGraph } = await import('../../../graph-runner/runner.js');
      const { createInvestDemoHandlers } = await import('../../../../scripts/demo-invest-orch/handlers.js');
      const outDir = join(ctx.universeRoot, 'invest-demo');
      const graph = resolve(import.meta.dir, '../../../../graphs/demo/invest-orch/invest-orch.yaml');
      const state = await runGraph(graph, { input: { fixtures: true, simDelayMs: 800, outDir }, quiet: true,
        deps: { root: ctx.universeRoot, inProcessHandlers: createInvestDemoHandlers() } });
      eq('status', state.status, 'done');
      const branches = Object.entries(state.fanOuts?.['factsheet:ok']?.branches ?? {});
      const panel = branches.filter(([id]) => id.startsWith('panel-'));
      eq('panel branches done', panel.map(([, b]) => b.status), Array(12).fill('done'));
      eq('mentor branches', branches.filter(([id]) => id.startsWith('mentor-')).length, 3);
      const latestStart = Math.max(...panel.map(([, b]) => Date.parse(b.startedAt!)));
      const earliestEnd = Math.min(...panel.map(([, b]) => Date.parse(b.endedAt!)));
      eq('12 panel nodes overlap (parallel)', latestStart < earliestEnd, true);
      const report = readFileSync(join(outDir, 'report.md'), 'utf8');
      eq('report first line', report.split('\n')[0], '# 리서치 시연 · 투자 권유 아님');
      const d = JSON.parse(readFileSync(join(outDir, 'dashboard.json'), 'utf8')) as { conatus: { judge: { execution: string } }; decisionSummary: string };
      eq('Conatus execution', d.conatus.judge.execution, '집행: 비활성(mandate disarmed)');
      eq('decision line shape', /^결정 대기 \d+건 → 기준 자동 처리 \d+건 · 사람 결정 \d+건$/u.test(d.decisionSummary), true);
      ctx.note('dr15-run', { status: state.status, branches: branches.length, decisionSummary: d.decisionSummary });
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved;
    }
    return failures.length ? { ok: false, diff: failures.join('\n') } : { ok: true };
  },
};
