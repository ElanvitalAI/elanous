// Sweep 3 (11-25) — sweep 2 showed the product Grep head_limit (250) dropping right files on common terms and the
// doc router hurting natural-language CODE queries. N6 = N5 with a 1000 cap; C7 keeps native first and lets the
// triple index only break ties (low weight); C8 = docs-first for doc-shaped queries with the weak-hit fallback.
import { astGrepCallers, astGrepDefinition, productAdapter } from '../adapters.js';
import type { SearchKit } from '../kit.js';
import { DEFAULT_PIPELINE, rrf, runPipeline, termGroups, type PipelineOptions, type ToolAdapter } from '../plan.js';
import type { SearchStrategy } from '../types.js';
import { triple1bRanked, tripleRanked } from './index-track.js';
import { isCodeQuery } from './sweep2.js';

const P: PipelineOptions = { ...DEFAULT_PIPELINE, expand: true, joinedName: true, definitionBoost: 3 };
const tool: ToolAdapter = { ...productAdapter({ globCi: true, cap: 1000 }), definition: astGrepDefinition, callers: astGrepCallers };
const n6 = (q: string, kit: SearchKit) => runPipeline(q, kit, tool, P);
const weak = (q: string, top?: string) => !top || !termGroups(q, true).some((g) => g.some((t) => t.length >= 3 && top.toLowerCase().includes(t.toLowerCase())));

export const sweep3Strategies: SearchStrategy[] = [
  { id: 'N6-n5-cap1000', version: 1, track: 'N', label: 'N5 with Grep head_limit 1000', params: { ...P, cap: 1000 }, run: n6 },
  { id: 'C7-n6-plus-triple-low', version: 1, track: 'I+N', label: 'RRF(N6 1.5, triple 0.5) — index breaks ties', async run(q, kit) {
    return rrf([{ paths: await n6(q, kit), weight: 1.5 }, { paths: await tripleRanked(q, kit, 2), weight: 0.5 }]);
  } },
  { id: 'C7b-n6-plus-docs-tool-low', version: 1, track: 'I+N', label: 'RRF(N6 1.5, stage-1b triple 0.5) — after #40040/#40041/#40044', async run(q, kit) {
    return rrf([{ paths: await n6(q, kit), weight: 1.5 }, { paths: await triple1bRanked(q, kit, 2), weight: 0.5 }]);
  } },
  { id: 'C8-docsfirst-weak-n6', version: 1, track: 'I+N', label: 'doc-shaped → triple, fall back to N6 when weak · code-shaped → N6', async run(q, kit) {
    if (isCodeQuery(q)) return n6(q, kit);
    const idx = await tripleRanked(q, kit, 2);
    if (!weak(q, idx[0])) return rrf([{ paths: idx, weight: 1 }, { paths: await n6(q, kit), weight: 1 }]);
    return rrf([{ paths: await n6(q, kit), weight: 1.5 }, { paths: idx, weight: 1 }]);
  } },
];
