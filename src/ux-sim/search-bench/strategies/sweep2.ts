// Sweep 2 (11-25) — combinations suggested by sweep 1: keep what each ablation showed helps (case-insensitive NAME
// match, ko↔en expansion, structural defs/call sites, no Read re-rank), drop what hurt (Grep -i, Read top 10), and
// route by query shape: code-shaped queries → native + ast-grep, doc-shaped queries → triple index first.
import { astGrepCallers, astGrepDefinition, engineAdapter, productAdapter } from '../adapters.js';
import type { SearchKit } from '../kit.js';
import { CALLER_INTENT, DEFAULT_PIPELINE, isIdentifier, queryTerms, rrf, runPipeline, type PipelineOptions, type ToolAdapter } from '../plan.js';
import type { SearchStrategy } from '../types.js';
import { tripleRanked } from './index-track.js';

const P: PipelineOptions = { ...DEFAULT_PIPELINE, expand: true, joinedName: true, definitionBoost: 3 };
const productAst: ToolAdapter = { ...productAdapter({ globCi: true }), definition: astGrepDefinition, callers: astGrepCallers };
const engineAst = engineAdapter({ content: 'rg', name: 'rg-ci', astGrep: true });

/** Code-shaped: an identifier / dotted key / caller ask / «code»-word. Everything else is doc-shaped. */
export function isCodeQuery(q: string): boolean {
  return queryTerms(q).some((t) => isIdentifier(t) || /\./.test(t)) || CALLER_INTENT.test(q) || /코드|implement|구현|함수|function/i.test(q);
}
const n5 = (q: string, kit: SearchKit) => runPipeline(q, kit, productAst, P);
const e8 = (q: string, kit: SearchKit) => runPipeline(q, kit, engineAst, P);

export const sweep2Strategies: SearchStrategy[] = [
  { id: 'N5-globci-expand-astgrep', version: 1, track: 'N', label: 'Glob ci + expand + join + ast-grep defs/calls (product Grep, no -i, no Read)', params: { ...P, astGrep: true }, run: n5 },
  { id: 'N5-globci-expand-astgrep-read3', version: 1, track: 'N', label: 'N5 + Read top 3', params: { ...P, readTopK: 3 }, run: (q, kit) => runPipeline(q, kit, productAst, { ...P, readTopK: 3 }) },
  { id: 'E8-rg-ci-expand-astgrep', version: 1, track: 'E', label: 'RunShell rg (--iglob names) + expand + ast-grep', params: { ...P }, run: e8 },
  { id: 'C4-route', version: 1, track: 'I+N', label: 'route: code-shaped → N5 · doc-shaped → triple ⊕ N5 (RRF 2:1)', async run(q, kit) {
    if (isCodeQuery(q)) return n5(q, kit);
    return rrf([{ paths: await tripleRanked(q, kit, 2), weight: 2 }, { paths: await n5(q, kit), weight: 1 }]);
  } },
  { id: 'C5-route-plus-source-index', version: 1, track: 'I+N', label: 'route + source index: code → RRF(N5 2, code-bm25 1) · docs → RRF(triple 2, N5 1)', async run(q, kit) {
    if (isCodeQuery(q)) return rrf([{ paths: await n5(q, kit), weight: 2 }, { paths: (await kit.codeIndex(q, 10, false)).map((h) => h.path), weight: 1 }]);
    return rrf([{ paths: await tripleRanked(q, kit, 2), weight: 2 }, { paths: await n5(q, kit), weight: 1 }]);
  } },
  { id: 'C6-rrf-triple-n5', version: 1, track: 'I+N', label: 'RRF(triple 1, N5 1) — no routing', async run(q, kit) {
    return rrf([{ paths: await tripleRanked(q, kit, 2), weight: 1 }, { paths: await n5(q, kit), weight: 1 }]);
  } },
];
