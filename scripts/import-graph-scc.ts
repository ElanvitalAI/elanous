#!/usr/bin/env bun
// Read-only operator/train entry: bun scripts/import-graph-scc.ts --base <full SHA> [--repo <clean checkout>]
import { reportImportGraphSccForGate } from './release-loop/import-graph-scc-run.js';

function parse(args: readonly string[]): { base40: string; repo: string; format: 'json' | 'table' } | null {
  if (args.length % 2 !== 0) return null;
  const values = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at]!;
    const value = args[at + 1]!;
    if ((name !== '--base' && name !== '--repo' && name !== '--format') || !value || value.startsWith('-') || values.has(name)) return null;
    values.set(name, value);
  }
  const base40 = values.get('--base');
  const format = values.get('--format') ?? 'json';
  return base40 && (format === 'json' || format === 'table')
    ? { base40, repo: values.get('--repo') ?? process.cwd(), format } : null;
}

const input = parse(process.argv.slice(2));
if (!input) {
  process.stderr.write('usage: bun scripts/import-graph-scc.ts --base <full SHA> [--repo <clean checkout>] [--format json|table]\n');
  process.exitCode = 2;
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
