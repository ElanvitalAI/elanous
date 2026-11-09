import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CONDUCTOR_CELL_MAP_BEGIN = '<!-- BEGIN GENERATED CONDUCTOR CELL MAP -->';
export const CONDUCTOR_CELL_MAP_END = '<!-- END GENERATED CONDUCTOR CELL MAP -->';

export interface ConductorCellFragment {
  name: string;
  content: string;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function renderConductorCellMap(fragments: readonly ConductorCellFragment[]): string {
  const rows = [...fragments]
    .sort((left, right) => compareNames(left.name, right.name))
    .flatMap(({ name, content }) => {
      const lines = content.trim().split(/\r?\n/).filter((line) => Boolean(line) && !/^<!-- order: \d+ -->$/.test(line));
      for (const line of lines) {
        if (!line.startsWith('|') || !line.endsWith('|')) {
          throw new Error(`${name}: each fragment entry must be a markdown table row`);
        }
      }
      return lines;
    });

  return [
    CONDUCTOR_CELL_MAP_BEGIN,
    '> 이 표는 `docs/conductor/cells/*.md`에서 생성한다. 갱신: `bun scripts/generate-conductor-cell-map.ts`.',
    '',
    '| 판 | 칸 |',
    '|---|---|',
    ...rows,
    CONDUCTOR_CELL_MAP_END,
  ].join('\n');
}

export function replaceGeneratedConductorCellMap(document: string, generated: string): string {
  const beginAt = document.indexOf(CONDUCTOR_CELL_MAP_BEGIN);
  const endAt = document.indexOf(CONDUCTOR_CELL_MAP_END);
  if (
    beginAt < 0 || endAt < beginAt ||
    document.indexOf(CONDUCTOR_CELL_MAP_BEGIN, beginAt + 1) >= 0 ||
    document.indexOf(CONDUCTOR_CELL_MAP_END, endAt + 1) >= 0
  ) {
    throw new Error(`CONDUCTOR.md must contain one ordered cell-map marker pair`);
  }
  const afterEnd = endAt + CONDUCTOR_CELL_MAP_END.length;
  return `${document.slice(0, beginAt)}${generated}${document.slice(afterEnd)}`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const cellsDir = resolve(root, 'docs/conductor/cells');
  const conductorPath = resolve(root, 'docs/conductor/CONDUCTOR.md');
  const fragments = readdirSync(cellsDir)
    .filter((name) => name.endsWith('.md'))
    .sort(compareNames)
    .map((name) => ({ name, content: readFileSync(resolve(cellsDir, name), 'utf8') }));
  const current = readFileSync(conductorPath, 'utf8');
  const next = replaceGeneratedConductorCellMap(current, renderConductorCellMap(fragments));

  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('CONDUCTOR.md cell map is stale; run bun scripts/generate-conductor-cell-map.ts');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(conductorPath, next);
  }
}
