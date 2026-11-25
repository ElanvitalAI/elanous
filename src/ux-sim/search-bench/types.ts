// SEARCH-BENCH — native tool search methodology simulation device (owner 11-25 «native tool 검색 방법론 시뮬레이션 장치»).
// Target: a seat must find the right doc/code like Claude Code does. Every strategy runs over the SAME pinned corpus
// (git sha) and the SAME gold set, and returns ranked corpus-relative paths plus the tool-call trace it paid for them.

/** Gold categories — doc and code queries are balanced (owner «소스와 문서 둘 다요»). */
export const GOLD_CATEGORIES = ['filename', 'nl-ko', 'nl-en', 'symbol', 'impl-where', 'call-site', 'config-key', 'relation'] as const;
export type GoldCategory = typeof GOLD_CATEGORIES[number];
export type GoldDomain = 'code' | 'docs';

export interface GoldItem {
  readonly id: string;
  readonly domain: GoldDomain;
  readonly category: GoldCategory;
  readonly query: string;
  /** Corpus-relative POSIX paths; any of them counts, recall is over min(|expected|, k). */
  readonly expected: readonly string[];
  readonly note?: string;
}
export interface GoldSet {
  readonly schema: 'search-bench.gold/1';
  /** Which corpus the expected paths live in: the elanous repo at a sha, or the sampled reference repos. */
  readonly corpus: 'elanous' | 'ref';
  readonly version: number;
  /** The commit (elanous) or the manifest hash (ref) the expected paths were checked against. */
  readonly pinnedSha: string;
  /** ref corpus only: the sampled repositories (directory names under the reference root). */
  readonly repos?: readonly string[];
  readonly items: readonly GoldItem[];
}

/** One tool call as the model would have paid for it. bytes = what comes back to the model after the tool's folding. */
export interface TraceEntry {
  readonly tool: string;
  readonly args: string;
  readonly bytes: number;
  readonly ms: number;
  readonly hits: number;
  readonly error?: string;
}

/** Track I = index (docs search) · N = native tools (Grep/Glob/Read) · I+N = combination · X = external agent
 *  tool semantics · E = engine via RunShell (grep/rg/git grep/ast-grep/fd) · A = agent arm (replay or LLM). */
export type StrategyTrack = 'I' | 'N' | 'I+N' | 'X' | 'E' | 'A';

export interface SearchStrategy {
  readonly id: string;
  /** Bump whenever behaviour changes — the run history compares by (id, version). */
  readonly version: number;
  readonly track: StrategyTrack;
  readonly label: string;
  /** Where the emulated behaviour comes from (doc / source path / URL). */
  readonly source?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  run(query: string, kit: import('./kit.js').SearchKit): Promise<readonly string[]>;
}

export interface QueryResult {
  readonly strategy: string;
  readonly queryId: string;
  readonly ranked: readonly string[];
  /** 1-based rank of the first expected path in `ranked`, null when absent. */
  readonly firstRank: number | null;
  readonly recall1: number;
  readonly recall5: number;
  readonly calls: number;
  readonly bytes: number;
  readonly ms: number;
  /** Ranked paths in the top 5 that live under an ignored decoy directory (ignore-rule noise). */
  readonly decoy5: number;
  readonly error?: string;
  readonly trace: readonly TraceEntry[];
}

export interface Aggregate {
  readonly n: number;
  readonly recall1: number;
  readonly recall5: number;
  readonly mrr: number;
  readonly calls: number;
  readonly bytes: number;
  readonly ms: number;
  readonly decoy5: number;
}

export interface StrategySummary {
  readonly id: string;
  readonly version: number;
  readonly track: StrategyTrack;
  readonly label: string;
  readonly source?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly all: Aggregate;
  readonly byDomain: Readonly<Record<string, Aggregate>>;
  readonly byCategory: Readonly<Record<string, Aggregate>>;
}

export interface Scorecard {
  readonly schema: 'search-bench.scorecard/1';
  readonly runId: string;
  readonly createdAt: string;
  readonly host: string;
  readonly corpus: 'elanous' | 'ref';
  readonly corpusSha: string;
  readonly corpusFiles: number;
  readonly goldVersion: number;
  readonly goldSha256: string;
  readonly label?: string;
  /** Index build costs (files · chunks · DB bytes · ms), ref repo pins, … */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly strategies: readonly StrategySummary[];
  readonly results: readonly QueryResult[];
}
