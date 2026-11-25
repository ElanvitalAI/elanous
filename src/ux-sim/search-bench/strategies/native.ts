// Track N — native search-tool optimization over the seat's product Glob/Grep/Read. Each variant flips ONE choice
// (filename-first, ko/en expansion, case, caps, Glob→Grep→Read top-K, definition boost) so the sweep is an ablation.
import { productAdapter } from '../adapters.js';
import { DEFAULT_PIPELINE, runPipeline, type PipelineOptions } from '../plan.js';
import type { SearchStrategy } from '../types.js';

function native(id: string, label: string, adapter: Parameters<typeof productAdapter>[0], pipeline: Partial<PipelineOptions>, version = 1): SearchStrategy {
  const opts = { ...DEFAULT_PIPELINE, ...pipeline };
  const tool = productAdapter(adapter);
  return { id, version, track: 'N', label, params: { ...adapter, ...opts }, source: 'src/skills/tools/{glob,grep,read}.ts', run: (q, kit) => runPipeline(q, kit, tool, opts) };
}

export const nativeStrategies: SearchStrategy[] = [
  native('N1-grep', 'S1 Grep only (content, case-sensitive)', {}, { nameWeight: 0 }),
  native('N2-glob', 'S2 Glob only (**/*term*)', {}, { nameWeight: 2 }),
  native('N3-cc', 'S4 Glob names → Grep content (no Read)', {}, {}),
  native('N3-cc-read3', 'S4 + Read top 3 re-rank', {}, { readTopK: 3 }),
  native('N3-cc-read5', 'S4 + Read top 5 re-rank', {}, { readTopK: 5 }),
  native('N3-cc-read10', 'S4 + Read top 10 re-rank', {}, { readTopK: 10 }),
  native('N3-cc-expand', 'S4 + ko↔en expansion', {}, { expand: true }),
  native('N3-cc-grep-i', 'S4 + Grep -i', { grepI: true }, {}),
  native('N3-cc-glob-ci', 'S4 + case-insensitive Glob (proposed)', { globCi: true }, {}),
  native('N3-cc-join', 'S4 + joined-name fragment (a-b-c)', {}, { joinedName: true }),
  native('N3-cc-def', 'S4 + definition/call-site boost (Grep regex)', {}, { definitionBoost: 3 }),
  native('N3-cc-cap50', 'S4 with Grep head_limit 50', { cap: 50 }, {}),
  native('N3-cc-cap1000', 'S4 with Grep head_limit 1000', { cap: 1000 }, {}),
  native('N4-best', 'S4 full: expand + -i + Glob ci + join + def boost + Read 5', { grepI: true, globCi: true }, { expand: true, joinedName: true, definitionBoost: 3, readTopK: 5 }),
  native('N4-best-noexpand', 'N4 minus expansion', { grepI: true, globCi: true }, { joinedName: true, definitionBoost: 3, readTopK: 5 }),
  native('N4-best-noread', 'N4 minus Read', { grepI: true, globCi: true }, { expand: true, joinedName: true, definitionBoost: 3 }),
  native('N4-best-nodef', 'N4 minus def boost', { grepI: true, globCi: true }, { expand: true, joinedName: true, readTopK: 5 }),
  native('N4-best-noglobci', 'N4 minus Glob ci', { grepI: true }, { expand: true, joinedName: true, definitionBoost: 3, readTopK: 5 }),
  native('N4-best-nocase', 'N4 minus Grep -i', { globCi: true }, { expand: true, joinedName: true, definitionBoost: 3, readTopK: 5 }),
];
