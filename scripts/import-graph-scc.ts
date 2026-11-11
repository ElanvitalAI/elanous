#!/usr/bin/env bun
// Read-only operator entry for either gate-selected SCC analysis or a simulated changed-file hub radius.
import { spawnSync } from 'node:child_process';
import { reportGateHubReach, reportImportGraphSccForGate } from './release-loop/import-graph-scc-run.js';

type Input =
  | { mode: 'scc'; base40: string; repo: string; format: 'json' | 'table' }
  | { mode: 'hub'; commitRef: string; changedFiles: string[]; repo: string; format: 'json' | 'table' };

function parse(args: readonly string[]): Input | null {
  if (args.length % 2 !== 0) return null;
  const values = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at]!;
    const value = args[at + 1]!;
    if (!['--base', '--commit', '--changed-files', '--repo', '--format'].includes(name)
      || !value || values.has(name) || (name !== '--commit' && value.startsWith('-'))) return null;
    values.set(name, value);
  }
  const format = values.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'table') return null;
  const repo = values.get('--repo') ?? process.cwd();
  const base40 = values.get('--base');
  const commitRef = values.get('--commit');
  const changed = values.get('--changed-files');
  if (base40 && !commitRef && !changed) return { mode: 'scc', base40, repo, format };
  if (!base40 && commitRef && changed) {
    const changedFiles = changed.split(',').map((file) => file.trim());
    if (!changedFiles.length || changedFiles.some((file) => !file) || new Set(changedFiles).size !== changedFiles.length) return null;
    return { mode: 'hub', commitRef, changedFiles, repo, format };
  }
  return null;
}

function resolveCommit(repo: string, ref: string): string {
  // git-spawn-allow: read-only commit resolution for a pinned import-tree measurement.
  const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  const commit = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`cannot resolve commit ${ref}: ${result.stderr.trim()}`);
  return commit;
}

const input = parse(process.argv.slice(2));
if (!input) {
  process.stderr.write('usage: bun scripts/import-graph-scc.ts --base <full SHA> [--repo <checkout>] [--format json|table]\n'
    + '   or: bun scripts/import-graph-scc.ts --commit <ref> --changed-files <path,path> [--repo <checkout>] [--format json|table]\n');
  process.exitCode = 2;
} else if (input.mode === 'hub') {
  try {
    const commit = resolveCommit(input.repo, input.commitRef);
    const report = reportGateHubReach(input.repo, commit, input.changedFiles);
    if (input.format === 'table') {
      const rows = [
        `HEAD ${report.commit}`,
        `Previous radius ${report.baseline.selectedTests}/${report.baseline.totalTestFiles} · half maximum ${report.baseline.halfMaximum}`,
        `Changed files: ${report.changedFiles.join(', ')}`,
        'Hub radius | Total test files | Definite reach | Opaque additional | Gate selection | ≤ half baseline',
        '---: | ---: | ---: | ---: | ---: | :---:',
        `${report.hubReach.selectedTests} (${report.hubReach.selectedTests}/${report.totalTestFiles}) | ${report.totalTestFiles} | ${report.hubReach.definiteTests} | ${report.hubReach.opaqueAdditionalTests} | ${report.conservativeGate.selectedTests} (${report.conservativeGate.mode}) | ${report.withinHalf ? 'yes' : 'no'}`,
      ];
      process.stdout.write(`${rows.join('\n')}\n`);
    } else process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
} else {
  const result = reportImportGraphSccForGate(input.repo, input.base40);
  if (input.format === 'table' && result.ok) {
    const { report } = result;
    const rows = [
      `HEAD ${result.head40}  BASE ${result.base40}`,
      `SCC ${report.cycleCount}  largest ${report.largestScc}  cut candidates ${report.cutCandidateTotal}  ${report.measured ? 'measured' : 'unmeasured'}`,
      'Changed file | Definite tests | Possible tests | Impact',
      '--- | ---: | ---: | ---',
      ...report.changedFileImpacts.map((impact) => `${impact.file} | ${impact.affectedTestCount} | ${impact.possibleTestCount} | ${impact.measured ? 'measured' : impact.issues.join('; ')}`),
    ];
    process.stdout.write(`${rows.join('\n')}\n`);
  } else process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = !result.ok ? 2 : result.report.measured ? 0 : 1;
}
