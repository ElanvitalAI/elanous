// Track I+N — index ⊕ native tools. S5 = docs search first, native fallback when the index is empty/weak; the reverse;
// and RRF of the best of both.
import { productAdapter } from '../adapters.js';
import type { SearchKit } from '../kit.js';
import { DEFAULT_PIPELINE, rrf, runPipeline, termGroups, type PipelineOptions } from '../plan.js';
import type { SearchStrategy } from '../types.js';
import { tripleRanked } from './index-track.js';

const BEST_N: PipelineOptions = { ...DEFAULT_PIPELINE, expand: true, joinedName: true, definitionBoost: 3, readTopK: 5 };
const bestTool = productAdapter({ grepI: true, globCi: true });
const nativeBest = (q: string, kit: SearchKit) => runPipeline(q, kit, bestTool, BEST_N);

/** «weak» = the top index hit's path/title does not contain any query term group (the seat can tell this cheaply). */
function weak(q: string, top: string | undefined): boolean {
  if (!top) return true;
  const low = top.toLowerCase();
  return !termGroups(q, true).some((g) => g.some((t) => t.length >= 3 && low.includes(t.toLowerCase())));
}

function s5(id: string, label: string, mode: 'empty' | 'weak' | 'always'): SearchStrategy {
  return { id, version: 1, track: 'I+N', label, params: { fallback: mode }, async run(q, kit) {
    const idx = await tripleRanked(q, kit, 2);
    const fall = mode === 'always' || (mode === 'empty' ? idx.length === 0 : weak(q, idx[0]));
    if (!fall) return idx;
    return rrf([{ paths: idx, weight: 1 }, { paths: await nativeBest(q, kit), weight: 1.5 }]);
  } };
}

export const comboStrategies: SearchStrategy[] = [
  s5('C1-docs-then-native-empty', 'S5 docs(triple) → native only when 0 hits', 'empty'),
  s5('C1-docs-then-native-weak', 'S5 docs(triple) → native when top hit is weak', 'weak'),
  s5('C1-docs-plus-native', 'S5 docs(triple) ⊕ native always (RRF)', 'always'),
  { id: 'C2-native-then-index', version: 1, track: 'I+N', label: 'native best → index (triple ⊕ source) appended', async run(q, kit) {
    const n = await nativeBest(q, kit);
    if (n.length >= 5) return n;
    const more = rrf([{ paths: await tripleRanked(q, kit, 2), weight: 1 }, { paths: (await kit.codeIndex(q, 10, true)).map((h) => h.path), weight: 1 }]);
    return [...n, ...more.filter((p) => !n.includes(p))];
  } },
  { id: 'C3-rrf-all', version: 1, track: 'I+N', label: 'RRF(native best, triple docs, source index)', async run(q, kit) {
    return rrf([{ paths: await nativeBest(q, kit), weight: 1.5 }, { paths: await tripleRanked(q, kit, 2), weight: 1 }, { paths: (await kit.codeIndex(q, 10, true)).map((h) => h.path), weight: 1 }]);
  } },
];
