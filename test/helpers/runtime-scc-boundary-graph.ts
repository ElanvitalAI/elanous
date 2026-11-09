import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path/posix';
import ts from 'typescript';
import { buildClosureGraph, type ClosureGraph } from '../../scripts/release-loop/gate-closure.js';

export const RUNTIME_SCC_BOUNDARY_ROOTS: ReadonlySet<string> = new Set([
  'src/code-edit/apply.ts', 'src/code-edit/index.ts', 'src/code-edit/tools.ts',
  'src/plan-mode/index.ts', 'src/plan-mode/tool-enter.ts', 'src/plan-mode/tool-exit.ts',
  'src/domains/macro-store.ts', 'src/domains/regime-fetchers.ts', 'src/domains/regime-store.ts',
  'src/roles/machine-name.ts', 'src/roles/machine-profile.ts',
  'src/surface/index.ts', 'src/surface/llm-tools.ts',
  'apps/pwa/src/components/chat/SessionIdChip.tsx', 'apps/pwa/src/components/chat/SessionPill.tsx',
]);

const graphs = new Map<string, ClosureGraph>();

/** Follow the requested boundary's import closure while retaining all tracked files for resolution. */
export function runtimeSccBoundaryGraph(roots: readonly string[]): ClosureGraph {
  const key = [...roots].sort().join('\n');
  const cached = graphs.get(key);
  if (cached) return cached;
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  }).split('\n').filter(Boolean);
  const aliases: { scope: string; prefix: string; target: string }[] = [];
  for (const file of files.filter((path) => /(?:^|\/)tsconfig[\w.-]*\.json$/.test(path))) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch { continue; }
    const parsed = ts.parseConfigFileTextToJson(file, text);
    const options = parsed.config?.compilerOptions as { paths?: Record<string, unknown>; baseUrl?: string } | undefined;
    if (parsed.error || !options?.paths) continue;
    const scope = dirname(file) === '.' ? '' : dirname(file);
    const base = normalize(join(scope || '.', options.baseUrl ?? '.'));
    for (const [key, targets] of Object.entries(options.paths)) {
      if (key === '*' || !key.endsWith('*') || !Array.isArray(targets)
        || typeof targets[0] !== 'string' || !targets[0].endsWith('*')) continue;
      aliases.push({ scope, prefix: key.slice(0, -1), target: normalize(join(base, targets[0].slice(0, -1))).replace(/\/$/, '') });
    }
  }
  const graph = buildClosureGraph({
    files,
    roots: [...roots],
    preload: [],
    aliases,
    read: (path) => {
      try { return readFileSync(path, 'utf8'); }
      catch { return undefined; }
    },
  }, { staticImportsOnly: true });
  if (graph.opaque.size) throw new Error(`runtime SCC import graph is incomplete: ${[...graph.opaque].map(([file, why]) => `${file}: ${why}`).join('; ')}`);
  graphs.set(key, graph);
  return graph;
}
