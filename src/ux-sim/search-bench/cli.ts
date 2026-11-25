// `eln --test=<dir> sim search-bench …` — materialize the pinned corpus, run the strategies, store the dated scorecard
// in the run history (<test-state>/search-bench/runs/), print the one-screen table. `--history` / `--compare A B`
// read the history. Corpus temp dirs are removed afterwards unless --keep-corpus.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeCorpus, materializeRefCorpus, thawCorpus } from './corpus.js';
import { goldPath, loadGold, missingGoldPaths } from './gold.js';
import { CorpusContext } from './kit.js';
import { resolveRefRepos, resolveRepoSource } from './sources.js';
import { loadStrategies, selectStrategies } from './registry.js';
import { categoryTable, compareRuns, historyTable, loadScorecard, runBench, saveScorecard, scorecardTable } from './runner.js';
import { llmStrategy, replayStrategy, type DescriptionSet, type Exposure } from './agent-arm.js';
import type { SearchStrategy } from './types.js';

export interface SearchBenchCliOptions {
  corpus?: string; sha?: string; repo?: string; repoSource?: string; refRoot?: string; refSources?: string; strategies?: string; label?: string; json?: boolean; keepCorpus?: boolean;
  history?: boolean; compare?: string[]; replay?: string; llmArm?: boolean; llmModel?: string; llmExposures?: string; llmDescriptions?: string; llmMaxQueries?: string;
  categories?: boolean; out?: string;
}


export async function runSearchBenchCli(stateRoot: string, o: SearchBenchCliOptions, log: (line: string) => void = console.log): Promise<number> {
  if (o.history) { historyTable(stateRoot).forEach((l) => log(l)); return 0; }
  if (o.compare) {
    if (o.compare.length !== 2) throw new Error('--compare takes two run ids');
    compareRuns(loadScorecard(stateRoot, o.compare[0]!), loadScorecard(stateRoot, o.compare[1]!)).forEach((l) => log(l));
    return 0;
  }
  const corpusKind = (o.corpus ?? 'elanous') as 'elanous' | 'ref';
  if (corpusKind !== 'elanous' && corpusKind !== 'ref') throw new Error('--corpus must be elanous or ref');
  const { gold, sha256 } = loadGold(goldPath(corpusKind));
  const decoyOf = [...new Set(gold.items.flatMap((it) => it.expected))];
  const dir = mkdtempSync(join(tmpdir(), `search-bench-${corpusKind}-`));
  const corpusDir = join(dir, 'corpus');
  let ctx: CorpusContext | null = null;
  try {
    const t = performance.now();
    // Where each corpus comes from = the product's single source resolver (knowledge.sources / ELANOUS_SOURCES · #40044).
    const repoSrc = corpusKind === 'elanous' ? resolveRepoSource(o) : null;
    const refRepos = corpusKind === 'ref' ? resolveRefRepos(gold.repos ?? [], o) : null;
    const corpus = repoSrc
      ? materializeCorpus({ repoDir: repoSrc.path, sha: o.sha ?? 'origin/main', outDir: corpusDir, decoyOf })
      : materializeRefCorpus({ repos: refRepos!.repos, outDir: corpusDir, decoyOf });
    // The corpus itself, as sources the product DocsSearch tool resolves (repo: the snapshot · ref: one source per repo).
    const corpusSources = repoSrc ? [{ id: repoSrc.id, type: 'repo' as const, path: corpus.root }]
      : refRepos!.repos.map((r) => ({ id: r.repo, type: 'ref' as const, path: join(corpus.root, r.repo) }));
    log(`sources ${repoSrc ? `${repoSrc.type}:${repoSrc.id}=${repoSrc.path}` : refRepos!.repos.map((r) => `${r.sourceId}/${r.repo}`).join(' ')}`);
    log(`corpus ${corpusKind} @ ${corpus.sha.slice(0, 12)} · ${corpus.files} files · ${Math.round(performance.now() - t)} ms → ${corpus.root}`);
    const missing = missingGoldPaths(gold, corpus.root);
    if (missing.length) log(`WARN gold paths absent at this corpus: ${missing.join(', ')}`);
    let strategies: SearchStrategy[] = selectStrategies(await loadStrategies(), o.strategies);
    if (o.replay) strategies.push(replayStrategy(o.replay));
    let goldUsed = gold;
    if (o.llmArm) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error('--llm-arm needs OPENROUTER_API_KEY');
      const exposures = (o.llmExposures ?? 'A-native-first,B-docs-first,C-runshell-only,D-ops-ui-deferred').split(',') as Exposure[];
      const descs = (o.llmDescriptions ?? 'D1-current').split(',') as DescriptionSet[];
      const llm = exposures.flatMap((exposure) => descs.map((descriptions) => llmStrategy({ model: o.llmModel ?? 'openai/gpt-4.1-mini', exposure, descriptions, apiKey })));
      strategies = o.strategies ? [...strategies, ...llm] : llm;
      const max = Number(o.llmMaxQueries ?? 10);
      const balanced = [...gold.items.filter((it) => it.domain === 'docs').slice(0, Math.ceil(max / 2)), ...gold.items.filter((it) => it.domain === 'code').slice(0, Math.floor(max / 2))];
      goldUsed = { ...gold, items: balanced };
    }
    ctx = new CorpusContext(corpus.root, corpusSources);
    const sc = await runBench({ ctx, gold: goldUsed, goldSha256: sha256, corpusSha: corpus.sha, corpusFiles: corpus.files,
      strategies, ...(o.label ? { label: o.label } : {}), meta: { sources: repoSrc ? [repoSrc] : refRepos!.repos, ...('pins' in corpus ? { pins: corpus.pins } : {}) },
      onStrategy: (s) => log(`  ${s.id.padEnd(34)} r@5 ${s.all.recall5.toFixed(2)} · MRR ${s.all.mrr.toFixed(2)} · ${s.all.calls.toFixed(1)} calls · ${(s.all.bytes / 1024).toFixed(1)} KB`) });
    const path = saveScorecard(stateRoot, sc);
    if (o.out) writeFileSync(o.out, `${JSON.stringify(sc, null, 1)}\n`);
    if (o.json) log(JSON.stringify(sc));
    else { scorecardTable(sc).forEach((l) => log(l)); if (o.categories) categoryTable(sc).forEach((l) => log(l)); }
    log(`scorecard ${path}`);
    return 0;
  } finally {
    ctx?.dispose();
    if (!o.keepCorpus) { thawCorpus(dir); rmSync(dir, { recursive: true, force: true }); }
  }
}
