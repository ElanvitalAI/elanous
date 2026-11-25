// DR18 · DR-DOCSEARCH — SEARCH-BENCH (owner 11-25 «native tool 검색 방법론 시뮬레이션 장치»): the search-methodology
// device runs daily on its literal fixture corpus (universe-local git repo + an ignored decoy dir) through the REAL
// product Glob/Grep/Read, the shipped docs-search index and RunShell engines. Holds: the conductor doc is found by
// docs search (stage 1) while the pre-#40031 stage 0 misses it, the Glob→Grep→Read pipeline finds every fixture query
// at rank 1, rg never surfaces the ignored decoy while BSD grep does, and the run is deterministic.
import { join } from 'node:path';
import type { DailyRegressionScenario } from './scenarios.js';

export const dr18: DailyRegressionScenario = {
  id: 'DR18', prs: [],
  title: 'DR-DOCSEARCH: search-bench fixture — docs stage 0 misses conductor, stage 1 finds it · Glob→Grep→Read rank 1 · rg skips ignored decoy · deterministic',
  async run(ctx) {
    const failures: string[] = [];
    const eq = (label: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)} · observed ${JSON.stringify(actual)}`);
    };
    const { fixtureCorpus, thawCorpus } = await import('../../search-bench/corpus.js');
    const { FIXTURE_DECOYS, FIXTURE_FILES, FIXTURE_GOLD } = await import('../../search-bench/fixture.js');
    const { CorpusContext } = await import('../../search-bench/kit.js');
    const { loadStrategies, selectStrategies } = await import('../../search-bench/registry.js');
    const { deterministicView, runBench, saveScorecard } = await import('../../search-bench/runner.js');
    const corpus = fixtureCorpus(join(ctx.universeRoot, 'corpus'), FIXTURE_FILES, FIXTURE_DECOYS);
    try {
      const pick = selectStrategies(await loadStrategies(), 'I0-docs-s0,I1-docs-s1,N4-best,E1-rg,E2-bsd-grep');
      const corpusCtx = new CorpusContext(corpus.root);
      const run = () => runBench({ ctx: corpusCtx, gold: FIXTURE_GOLD, goldSha256: 'fixture', corpusSha: corpus.sha, corpusFiles: corpus.files, strategies: pick, host: 'sim', runId: 'dr18' });
      const a = await run();
      const b = await run();
      const by = (id: string) => a.strategies.find((s) => s.id === id)!;
      eq('stage 0 docs recall@5', by('I0-docs-s0').byDomain.docs?.recall5, 0);
      eq('stage 1 docs recall@5', by('I1-docs-s1').byDomain.docs?.recall5, 1);
      eq('N4-best recall@1', by('N4-best').all.recall1, 1);
      eq('rg decoy@5', by('E1-rg').all.decoy5, 0);
      eq('BSD grep decoy@5 > 0', by('E2-bsd-grep').all.decoy5 > 0, true);
      eq('deterministic', JSON.stringify(deterministicView(a)) === JSON.stringify(deterministicView(b)), true);
      const path = saveScorecard(ctx.universeRoot, a);
      ctx.note('dr18-scorecard', { path, strategies: a.strategies.map((s) => `${s.id}:${s.all.recall5}`) });
      corpusCtx.dispose();
    } finally {
      thawCorpus(corpus.root);
    }
    return failures.length ? { ok: false, diff: failures.join('\n') } : { ok: true };
  },
};
