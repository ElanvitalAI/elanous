// Track E — engines through the seat RunShell (argv · 30 s · 200 000-byte head capture · structured result):
// rg vs BSD grep vs git grep (content), rg/fd/find/git ls-files (names), ast-grep (structure) and their combinations.
import { engineAdapter } from '../adapters.js';
import { DEFAULT_PIPELINE, runPipeline, type PipelineOptions } from '../plan.js';
import type { SearchStrategy } from '../types.js';

function eng(id: string, label: string, a: Parameters<typeof engineAdapter>[0], p: Partial<PipelineOptions> = {}): SearchStrategy {
  const tool = engineAdapter(a);
  const opts = { ...DEFAULT_PIPELINE, ...p };
  return { id, version: 1, track: 'E', label, params: { ...a, ...opts }, source: 'src/skills/tools/shell.ts · src/shell-primitive/{types,runtime}.ts', run: (q, kit) => runPipeline(q, kit, tool, opts) };
}

export const engineStrategies: SearchStrategy[] = [
  eng('E1-rg', 'RunShell rg -l + rg --files', { content: 'rg', name: 'rg' }),
  eng('E1-rg-i', 'RunShell rg -l -i', { content: 'rg', name: 'rg', i: true }),
  eng('E2-bsd-grep', 'RunShell /usr/bin/grep -rlI + find', { content: 'bsd-grep', name: 'find' }),
  eng('E3-git-grep', 'RunShell git grep -l + git ls-files', { content: 'git-grep', name: 'git-grep' }),
  eng('E4-fd-rg', 'RunShell fd (names) + rg (content)', { content: 'rg', name: 'fd' }),
  eng('E5-astgrep-rg', 'ast-grep defs/calls + rg', { content: 'rg', name: 'rg', astGrep: true }, { definitionBoost: 3 }),
  eng('E5-astgrep-rg-read5', 'ast-grep defs/calls → rg → Read 5', { content: 'rg', name: 'rg', astGrep: true }, { definitionBoost: 3, readTopK: 5 }),
  eng('E6-rg-read5', 'rg → Read 5 (no ast-grep)', { content: 'rg', name: 'rg' }, { readTopK: 5 }),
  eng('E7-rg-i-expand-astgrep-read5', 'rg -i + expand + ast-grep + Read 5', { content: 'rg', name: 'rg', i: true, astGrep: true }, { expand: true, definitionBoost: 3, readTopK: 5, joinedName: true }),
];
