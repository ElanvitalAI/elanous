// SEARCH-BENCH tiny fixture corpus + gold — used by the focused tests and the DR18 daily-regression scenario.
// Literal content only (no product constants), so expectations stay independent of the code under test.
import type { GoldSet } from './types.js';

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'docs/conductor/CONDUCTOR.md': '# CONDUCTOR\n\n- [판정국 로드](JUDGE-LOAD-REDUCTION.md)\n- [착지](LAND-QUEUE-GRAPH.md)\n',
  'docs/conductor/JUDGE-LOAD-REDUCTION.md': '# 판정국 로드 줄이기 — 골 저작부터 착지까지\n\n> 🔗 우산 — [CONDUCTOR §6](CONDUCTOR.md)\n> 칸: SMART-MERGE-V2 · JUDGE-THROUGHPUT\n\n판정국 앞에 PR 이 쌓인다. judge load 를 줄인다.\n',
  'docs/conductor/LAND-QUEUE-GRAPH.md': '# 착지 줄을 그래프로\n\n> 🔗 우산 — [CONDUCTOR](CONDUCTOR.md) · 칸 = LAND-QUEUE-GRAPH\n\n착지 줄 규칙 일곱 개. src/tools/caller.ts 참고.\n',
  'docs/RFC-graph-runner-2026-01-01.md': '# Graph runner RFC\n\nThe graph runner schedules recipes. 판정국 은 다루지 않는다.\n',
  'src/tools/glob.ts': '// Glob tool\nexport function dispatchGlob(pattern: string): string[] {\n  return [pattern];\n}\n',
  'src/tools/caller.ts': "import { dispatchGlob } from './glob.js';\n\nexport const found = dispatchGlob('**/*.md');\n",
  'src/config.ts': "// LAND-QUEUE-GRAPH reads this\nexport const cfg = { knowledge: { docsRoots: ['docs'] } };\n",
};

export const FIXTURE_GOLD: GoldSet = {
  schema: 'search-bench.gold/1', corpus: 'elanous', version: 1, pinnedSha: 'fixture',
  items: [
    { id: 'f1', domain: 'docs', category: 'filename', query: 'JUDGE-LOAD-REDUCTION', expected: ['docs/conductor/JUDGE-LOAD-REDUCTION.md'] },
    { id: 'f2', domain: 'docs', category: 'nl-ko', query: '판정국 로드 줄이기', expected: ['docs/conductor/JUDGE-LOAD-REDUCTION.md'] },
    { id: 'f3', domain: 'code', category: 'symbol', query: 'dispatchGlob', expected: ['src/tools/glob.ts'] },
    { id: 'f4', domain: 'code', category: 'call-site', query: 'dispatchGlob 호출하는 곳', expected: ['src/tools/caller.ts'] },
    { id: 'f5', domain: 'docs', category: 'relation', query: 'SMART-MERGE-V2 칸을 만든 문서', expected: ['docs/conductor/JUDGE-LOAD-REDUCTION.md'] },
    { id: 'f6', domain: 'code', category: 'config-key', query: 'knowledge.docsRoots', expected: ['src/config.ts'] },
  ],
};
export const FIXTURE_DECOYS = ['docs/conductor/JUDGE-LOAD-REDUCTION.md', 'src/tools/glob.ts'];
