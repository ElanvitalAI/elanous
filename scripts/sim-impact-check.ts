#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitClosureTree, type ClosureTree } from './release-loop/gate-closure.js';
import {
  runSimImpactCli,
  runSimImpactGoalCli,
  type GoalImpactReport,
  type SimImpactDependencies,
  type SimImpactReport,
} from './sim-impact.js';

export interface GoalImpactDependencies {
  repositoryRoot: string;
  readGoal(path: string): string;
  loadTree(): ClosureTree;
}

export interface SimImpactCheckDependencies {
  goal?: GoalImpactDependencies;
  pullRequest?: SimImpactDependencies;
}

export type SimImpactDecision = 'pass' | 'warning' | 'refuse' | 't2-hold';

export type SimImpactCheckResult = {
  mode: 'goal';
  decision: SimImpactDecision;
  exitCode: 0 | 2;
  impact: GoalImpactReport;
} | {
  mode: 'pr';
  decision: SimImpactDecision;
  exitCode: 0 | 2;
  impact: SimImpactReport;
};

function systemGoalDependencies(repositoryRoot = process.cwd()): GoalImpactDependencies {
  return {
    repositoryRoot,
    readGoal: (path) => readFileSync(path, 'utf8'),
    loadTree() {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: 15_000,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`git rev-parse HEAD failed: ${String(result.stderr ?? result.error ?? '').trim()}`);
      }
      return gitClosureTree(repositoryRoot, String(result.stdout).trim());
    },
  };
}

function decideGoal(report: GoalImpactReport, guardIntent: boolean): SimImpactDecision {
  if (report.gaps.length === 0) return 'pass';
  return report.entryPoints.length > 0 || report.guardTargets.length > 0
    || (guardIntent && report.unresolvedTargets.length > 0) ? 'refuse' : 'warning';
}

function decidePullRequest(report: SimImpactReport): SimImpactDecision {
  return report.gaps.length > 0 ? 't2-hold' : 'pass';
}

function requireNonemptyEvidenceRunIds(report: SimImpactReport): SimImpactReport {
  const verifiedScenarios = report.verifiedScenarios.filter((scenario) => scenario.runId.trim().length > 0);
  if (verifiedScenarios.length === report.verifiedScenarios.length) return report;

  const coveredGuardIds = new Set(verifiedScenarios.map((scenario) => scenario.guardId));
  const uncovered = report.guards.filter((guard) => !coveredGuardIds.has(guard.id));
  const gaps = uncovered.map((guard) => uncovered.length === 1
    ? '공백: 게이트 진입 가드 · 밟는 시나리오 없음'
    : `공백: 게이트 진입 가드 · 밟는 시나리오 없음 [${guard.id}]`);
  return { ...report, verifiedScenarios, gaps: [...new Set([...report.gaps, ...gaps])] };
}

function formatCheck(result: SimImpactCheckResult, details: string): string {
  return `SIM-IMPACT 판정: ${result.decision}\n${details.trimEnd()}\n`;
}

export async function runSimImpactCheckCli(
  args: string[],
  dependencies: SimImpactCheckDependencies = {},
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<SimImpactCheckResult> {
  const isGoal = args.includes('--goal');
  let details = '';
  let result: SimImpactCheckResult;

  if (isGoal) {
    const goalDependencies = dependencies.goal ?? systemGoalDependencies();
    const goalIndex = args.indexOf('--goal');
    const goalPath = args[goalIndex + 1];
    if (!goalPath) throw new Error('--goal requires a file path');
    const goalText = goalDependencies.readGoal(resolve(goalDependencies.repositoryRoot, goalPath));
    const guardIntent = /(?:가드|guard|진입점|entrypoint)/i.test(goalText);
    const impact = runSimImpactGoalCli(args, goalDependencies, (text) => { details += text; });
    const decision = decideGoal(impact, guardIntent);
    result = { mode: 'goal', decision, exitCode: decision === 'refuse' ? 2 : 0, impact };
  } else {
    const impact = requireNonemptyEvidenceRunIds(await runSimImpactCli(args, dependencies.pullRequest, (text) => { details += text; }));
    const decision = decidePullRequest(impact);
    result = { mode: 'pr', decision, exitCode: decision === 't2-hold' ? 2 : 0, impact };
  }

  if (args.includes('--json')) write(`${JSON.stringify(result, null, 2)}\n`);
  else write(formatCheck(result, details));
  return result;
}

if (import.meta.main) {
  runSimImpactCheckCli(process.argv.slice(2)).then((result) => {
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

