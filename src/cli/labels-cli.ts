import type { Command } from 'commander';
import { PR_LABELS } from '../github/pr-labels.js';
import { runGhCliWithResult, type GhCliResult } from '../git-fs/gh-cli.js';

type RemoteLabel = { name: string; color: string; description: string };
const GH_LABEL_LIST_LIMIT = 1000;

export interface LabelsCliDeps {
  gh?: (args: string[]) => GhCliResult;
  out?: Pick<Console, 'log' | 'error'>;
}

function remoteLabels(result: GhCliResult): RemoteLabel[] {
  if (!result.ok || result.maybeTruncated) {
    throw new Error(result.maybeTruncated
      ? 'gh label list may be truncated; no labels were changed'
      : `gh label list failed (exit ${result.exitCode}): ${result.stderr.toString('utf8').trim()}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw new Error('gh label list returned invalid JSON; no labels were changed');
  }
  if (!Array.isArray(value) || !value.every((item): item is RemoteLabel =>
    item !== null && typeof item === 'object'
    && typeof item.name === 'string' && typeof item.color === 'string'
    && typeof item.description === 'string')) {
    throw new Error('gh label list returned invalid labels; no labels were changed');
  }
  if (value.length >= GH_LABEL_LIST_LIMIT) {
    throw new Error('gh label list reached its limit; completeness cannot be verified; no labels were changed');
  }
  return value;
}

export function registerLabelsCommands(program: Command, deps: LabelsCliDeps = {}): void {
  const gh = deps.gh ?? runGhCliWithResult;
  const out = deps.out ?? console;
  const labels = program.command('labels').description('PR 라벨 등록표 조회·GitHub 동기화');

  labels.command('list').description('등록표의 PR 라벨 목록 표시')
    .action(() => {
      for (const label of PR_LABELS) {
        out.log(`${label.name}\t${label.axis}\t#${label.color}\t${label.description}\tappliedBy=${label.appliedBy.join(',')}\tsweep=${JSON.stringify(label.sweep)}`);
      }
    });

  labels.command('sync').description('GitHub 라벨과 등록표 비교 (기본 dry-run)')
    .option('--apply', '없는 라벨 생성 및 색·설명 변경 적용')
    .action((options: { apply?: boolean }) => {
      const existing = remoteLabels(gh(['label', 'list', '--json', 'name,color,description', '--limit', String(GH_LABEL_LIST_LIMIT)]));
      const byName = new Map(existing.map(label => [label.name, label]));
      const known = new Set<string>(PR_LABELS.map(label => label.name));
      out.log(options.apply ? 'Labels sync (apply)' : 'Labels sync (dry-run; use --apply to change labels)');
      for (const label of existing) {
        if (label.name.startsWith('elanous:') && !known.has(label.name)) {
          out.log(`unknown (preserved): ${label.name}`);
        }
      }
      for (const label of PR_LABELS) {
        const current = byName.get(label.name);
        const operation = !current ? 'create' :
          current.color.toUpperCase() !== label.color.toUpperCase() || current.description !== label.description ? 'edit' : 'unchanged';
        out.log(`${operation}: ${label.name}`);
        if (!options.apply || operation === 'unchanged') continue;
        const args = operation === 'create'
          ? ['label', 'create', label.name, '--color', label.color, '--description', label.description]
          : ['label', 'edit', label.name, '--color', label.color, '--description', label.description];
        const result = gh(args);
        if (!result.ok) throw new Error(`gh label ${operation} failed for ${label.name} (exit ${result.exitCode}): ${result.stderr.toString('utf8').trim()}`);
      }
    });
}
