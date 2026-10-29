// NL routing corpus screening measurement. Repro is a repeatable lower bound; live TUI is authoritative.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildEvalPromptToolSurface, EVAL_PROMPT_TOOL_SURFACES, isEvalPromptToolSurface, resolveReproModelId, runEvalPrompt, type EvalPromptToolSurface } from '../src/eval-prompt-cli.js';
import { getModelFamily } from '../src/models/prompts.js';
import { NoLlmProviderAvailableError, resolveDefaultProvider } from '../src/llm.js';
import { filterToolsByDeny } from '../src/tool-runtime/tool-deny.js';
import { getUserConfig } from '../src/user-config.js';
import { resolveObserveOnlyDecision, type ObserveOnlyDecision } from '../src/self-implement/observe-only.js';
import { selectCorpusItems, corpusFiltersFromEnv, passSummary, positiveInteger, positiveIntegerList, unavailableExpectedToolIds, wilsonInterval } from './lib/nl-routing-measurement.js';
import { machineLoad, measureScreeningRun, screeningFailureReason, type MachineLoad, type ScreeningRecord } from './lib/nl-routing-screening.js';

interface CorpusItem { id: string; tier: string; prompt: string; accept: string[]; context_dependent?: boolean; context?: string }
interface Corpus { description: string; surface: string; tiers: Record<string, string>; items: CorpusItem[] }

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function promptForItem(item: Pick<CorpusItem, 'prompt' | 'context_dependent' | 'context'>): string {
  return item.context_dependent && item.context ? `${item.context}\n\n${item.prompt}` : item.prompt;
}
export const NL_ROUTING_UNSAFE_RUN_ENV = 'ELANOUS_NL_ROUTING_ALLOW_UNSAFE_RUN';
const CORPUS_ALWAYS_MUTATING_TOOL_NAMES = ['Bash', 'Edit', 'Write'] as const;
const CORPUS_MUTATING_TOOL_NAMES = ['SelfImplement', ...CORPUS_ALWAYS_MUTATING_TOOL_NAMES] as const;

function readCorpusFromEnv(env: NodeJS.ProcessEnv = process.env): Corpus {
  const corpusPath = env.CORPUS_PATH;
  if (!corpusPath) throw new Error('CORPUS_PATH is required; provide the corpus JSON path to measure.');
  return JSON.parse(readFileSync(resolve(process.cwd(), corpusPath), 'utf8')) as Corpus;
}

function resolveCorpusCwdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const corpusCwd = env.CORPUS_CWD;
  if (!corpusCwd) throw new Error('CORPUS_CWD is required; provide the tool working directory for corpus measurement.');
  return resolve(process.cwd(), corpusCwd);
}

interface CorpusRunSafety {
  readonly observeOnly: ObserveOnlyDecision;
  readonly bypassed: boolean;
  readonly exposedMutatingTools: readonly string[];
}

export function resolveCorpusRunSafety(
  env: NodeJS.ProcessEnv = process.env,
  observeOnly = resolveObserveOnlyDecision(env),
  exposedToolNames: readonly string[],
): CorpusRunSafety {
  const exposedToolSet = new Set(exposedToolNames);
  const exposedMutatingTools = [
    ...CORPUS_ALWAYS_MUTATING_TOOL_NAMES.filter((name) => exposedToolSet.has(name)),
    ...(!observeOnly.enabled && exposedToolSet.has('SelfImplement') ? ['SelfImplement'] : []),
  ];
  const unsafeRunAllowed = env[NL_ROUTING_UNSAFE_RUN_ENV] === '1';
  const bypassed = exposedMutatingTools.length > 0 && unsafeRunAllowed;
  if (exposedMutatingTools.length > 0 && !unsafeRunAllowed) {
    const selfImplementGuidance = observeOnly.enabled
      ? `SelfImplement observe-only is enabled (source: ${observeOnly.source}). `
      : `tools.selfImplement.observeOnly is disabled (source: ${observeOnly.source}). `;
    const alwaysMutatingExposed = CORPUS_ALWAYS_MUTATING_TOOL_NAMES.filter((name) => exposedToolSet.has(name));
    const hostMutationGuidance = alwaysMutatingExposed.length > 0
      ? `Unprotected host mutating tools exposed: ${alwaysMutatingExposed.join(', ')}. `
      : '';
    throw new Error(
      `NL routing corpus runner stopped: exposed mutating tools can modify this worktree. `
      + selfImplementGuidance
      + hostMutationGuidance
      + `Exposed mutating tools: ${exposedMutatingTools.join(', ')}. `
      + `Known mutating tool surface: ${CORPUS_MUTATING_TOOL_NAMES.join(', ')}. `
      + `To deliberately accept this risk, set ${NL_ROUTING_UNSAFE_RUN_ENV}=1; the bypass is recorded in the startup log.`,
    );
  }
  return { observeOnly, bypassed, exposedMutatingTools };
}

// ── NL-UTTERANCE-PATTERNS v5 — 경로·복합 처리 채점 입구 ─────────────────────
//
// 칸의 판정선은 수가 아니라 «판정선»이다: 가림 예시 누출 0 · 패턴 ≥12 · v5 채점 문항 ≥25.
// 패턴은 발화 어휘 신호(경로 지정 / 복합 요청)이고, 문항은 그 패턴이 실제로 발화하는지
// 스스로 증명한다(선언 패턴이 프롬프트에서 안 잡히면 mismatch 로 판정 실패).
// ⛔ 가림 예시(masking examples)는 «채점되지 않는» 홀드아웃 발화다 — 문항·패턴에 새면 판정선이 무너진다.

export interface NlRoutingToolExpectation {
  readonly tool: string;
  readonly minCount?: number;
}

export interface NlUtterancePattern {
  readonly id: string;
  readonly handles: 'path' | 'compound';
  readonly signal: RegExp;
}

export const NL_UTTERANCE_PATTERNS: readonly NlUtterancePattern[] = [
  { id: 'path-single-read', handles: 'path', signal: /(?:읽어\s*줘|열어\s*줘)/u },
  { id: 'path-relative', handles: 'path', signal: /(?:상대\s*경로|\.\/)/u },
  { id: 'path-absolute', handles: 'path', signal: /(?:절대\s*경로|\/tmp\/|\/home\/)/u },
  { id: 'path-home-config', handles: 'path', signal: /(?:~\/\.elanous|홈\s*디렉터리)/u },
  { id: 'path-directory-scope', handles: 'path', signal: /(?:디렉터리\s*안에서|그\s*폴더\s*안)/u },
  { id: 'path-symbol-search', handles: 'path', signal: /어디서\s*쓰/u },
  { id: 'path-file-glob', handles: 'path', signal: /(?:목록|어떤\s*파일들)/u },
  { id: 'path-nested-file', handles: 'path', signal: /하위\s*디렉터리[\s\S]*파일/u },
  { id: 'compound-read-then-grep', handles: 'compound', signal: /읽고\s*나서[\s\S]*찾/u },
  { id: 'compound-grep-then-read', handles: 'compound', signal: /찾아서\s*그\s*파일/u },
  { id: 'compound-glob-then-read', handles: 'compound', signal: /목록[\s\S]*첫\s*파일/u },
  { id: 'compound-two-file-compare', handles: 'compound', signal: /두\s*파일[\s\S]*비교/u },
  { id: 'compound-three-way', handles: 'compound', signal: /읽고[\s\S]*찾고[\s\S]*목록/u },
  { id: 'compound-search-then-confirm', handles: 'compound', signal: /검색해서[\s\S]*전부\s*확인/u },
];

export interface NlRoutingV5Question {
  readonly id: string;
  readonly pattern: string;
  readonly prompt: string;
  readonly expects: readonly NlRoutingToolExpectation[];
}

const single = (tool: string): readonly NlRoutingToolExpectation[] => [{ tool }];

export const NL_ROUTING_V5_QUESTIONS: readonly NlRoutingV5Question[] = [
  { id: 'v5-01', pattern: 'path-single-read', prompt: 'src/domains/surface-events.ts 파일 읽어 줘', expects: single('Read') },
  { id: 'v5-02', pattern: 'path-single-read', prompt: 'scripts/measure-nl-routing-corpus.ts 읽어 줘', expects: single('Read') },
  { id: 'v5-03', pattern: 'path-relative', prompt: 'src/cli/self-utterances-cli.ts 상대 경로로 열어 줘', expects: single('Read') },
  { id: 'v5-04', pattern: 'path-relative', prompt: './scripts/lib/nl-routing-screening.ts 상대 경로 파일 보여줘', expects: single('Read') },
  { id: 'v5-05', pattern: 'path-absolute', prompt: '/home/ubuntu/.elanous/logs 절대 경로 확인해 줘', expects: single('Read') },
  { id: 'v5-06', pattern: 'path-absolute', prompt: '/tmp/nl-routing/corpus.json 절대 경로 읽어 줘', expects: single('Read') },
  { id: 'v5-07', pattern: 'path-home-config', prompt: '~/.elanous 아래 설정 파일 읽어 줘', expects: single('Read') },
  { id: 'v5-08', pattern: 'path-home-config', prompt: '홈 디렉터리의 elanous 설정 읽어 줘', expects: single('Read') },
  { id: 'v5-09', pattern: 'path-directory-scope', prompt: 'src/domains 디렉터리 안에서 발화 origin 찾아 줘', expects: single('Grep') },
  { id: 'v5-10', pattern: 'path-directory-scope', prompt: '그 폴더 안에서 querySurfaceUtterances 를 검색해 줘', expects: single('Grep') },
  { id: 'v5-11', pattern: 'path-symbol-search', prompt: 'recordInboundTurn 이 어디서 쓰이는지 알려 줘', expects: single('Grep') },
  { id: 'v5-12', pattern: 'path-symbol-search', prompt: 'classifyTier 어디서 쓰는지 찾아 줘', expects: single('Grep') },
  { id: 'v5-13', pattern: 'path-file-glob', prompt: 'scripts 아래 측정 스크립트 목록 뽑아 줘', expects: single('Glob') },
  { id: 'v5-14', pattern: 'path-file-glob', prompt: '어떤 파일들 *.test.ts 이 있는지 보여 줘', expects: single('Glob') },
  { id: 'v5-15', pattern: 'path-nested-file', prompt: 'src/domains 하위 디렉터리의 파일 하나 읽어 줘', expects: single('Read') },
  { id: 'v5-16', pattern: 'path-nested-file', prompt: 'scripts/lib 하위 디렉터리 파일 읽어 줘', expects: single('Read') },
  { id: 'v5-17', pattern: 'compound-read-then-grep', prompt: 'src/domains/surface-events.ts 읽고 나서 호출부 찾아 줘', expects: [{ tool: 'Read' }, { tool: 'Grep' }] },
  { id: 'v5-18', pattern: 'compound-read-then-grep', prompt: 'docs/goal-context README 읽고 나서 참조 찾아 줘', expects: [{ tool: 'Read' }, { tool: 'Grep' }] },
  { id: 'v5-19', pattern: 'compound-grep-then-read', prompt: 'recordInboundTurn 찾아서 그 파일 읽어 줘', expects: [{ tool: 'Grep' }, { tool: 'Read' }] },
  { id: 'v5-20', pattern: 'compound-grep-then-read', prompt: 'querySurfaceUtterances 찾아서 그 파일 열어 줘', expects: [{ tool: 'Grep' }, { tool: 'Read' }] },
  { id: 'v5-21', pattern: 'compound-glob-then-read', prompt: 'src/domains 목록 뽑고 첫 파일 읽어 줘', expects: [{ tool: 'Glob' }, { tool: 'Read' }] },
  { id: 'v5-22', pattern: 'compound-glob-then-read', prompt: 'scripts/lib 목록 보고 첫 파일 읽어 줘', expects: [{ tool: 'Glob' }, { tool: 'Read' }] },
  { id: 'v5-23', pattern: 'compound-two-file-compare', prompt: 'surface-events.ts 와 provenance.ts 두 파일 비교해 줘', expects: [{ tool: 'Read', minCount: 2 }] },
  { id: 'v5-24', pattern: 'compound-two-file-compare', prompt: 'measure-nl-routing-corpus.ts 와 nl-routing-measurement.ts 두 파일 비교해 줘', expects: [{ tool: 'Read', minCount: 2 }] },
  { id: 'v5-25', pattern: 'compound-three-way', prompt: 'surface-events.ts 읽고 지난 기록 찾고 폴더 목록도 뽑아 줘', expects: [{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'Glob' }] },
  { id: 'v5-26', pattern: 'compound-three-way', prompt: 'self-utterances-cli.ts 읽고 origin 찾고 scripts 목록도 뽑아 줘', expects: [{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'Glob' }] },
  { id: 'v5-27', pattern: 'compound-search-then-confirm', prompt: 'origin 표기를 검색해서 관련 파일 전부 확인해 줘', expects: [{ tool: 'Grep' }, { tool: 'Read' }] },
  { id: 'v5-28', pattern: 'compound-search-then-confirm', prompt: 'v5 문항을 검색해서 전부 확인해 줘', expects: [{ tool: 'Grep' }, { tool: 'Read' }] },
];

/** 채점에 쓰이지 않는 홀드아웃 발화 — 문항·패턴에 «한 글자도» 새면 안 된다. */
export const NL_ROUTING_MASKING_EXAMPLES: readonly string[] = [
  '이 저장소에서 라우팅 규칙이 어디에 적혀 있는지 알려 줘',
  '방금 만든 스크립트랑 예전 스크립트를 나란히 놓고 틀린 곳만 짚어 줘',
  '설정 폴더 아래 있는 재정의 항목만 훑어 줘',
  '테스트가 실제로 도는 파일과 그렇지 않은 파일을 갈라 줘',
  '복합 요청: 먼저 근거를 모으고 그다음에 요약을 만들어 줘',
  '이 변경이 어떤 진입점을 타는지 확인해 줘',
  '오늘 새로 생긴 산출물만 모아서 보여 줘',
  '지난 실행에서 실패한 문항을 다시 재 보고 싶어',
];

export const NL_ROUTING_V5_THRESHOLDS = { maskingLeaks: 0, patterns: 12, scored: 25 } as const;

function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** 발화에서 발화하는 패턴 id 목록(패턴 정의가 장식이 아님을 문항 단위로 확인하는 자). */
export function matchNlUtterancePatterns(prompt: string): string[] {
  return NL_UTTERANCE_PATTERNS.filter((pattern) => pattern.signal.test(prompt)).map((pattern) => pattern.id);
}

/** 가림 예시 누출 검사 — 문항 프롬프트·패턴 id 어디에도 홀드아웃 발화가 겹치면 누출이다. */
export function maskingExampleLeaks(): string[] {
  const prompts = NL_ROUTING_V5_QUESTIONS.map((question) => ({ id: question.id, text: normalizeUtterance(question.prompt) }));
  const patternIds = NL_UTTERANCE_PATTERNS.map((pattern) => normalizeUtterance(pattern.id));
  const leaks: string[] = [];
  NL_ROUTING_MASKING_EXAMPLES.forEach((example, index) => {
    const normalized = normalizeUtterance(example);
    if (!normalized) return;
    const hit = prompts.find((prompt) => prompt.text.includes(normalized) || normalized.includes(prompt.text));
    if (hit) { leaks.push(`example${index + 1}:${hit.id}`); return; }
    if (patternIds.some((id) => id.includes(normalized))) leaks.push(`example${index + 1}:pattern`);
  });
  return leaks;
}

export interface NlRoutingV5Score {
  readonly questions: number;
  readonly pathQuestions: number;
  readonly compoundQuestions: number;
  readonly patterns: number;
  readonly pathPatterns: number;
  readonly compoundPatterns: number;
  readonly scored: number;
  readonly passed: number;
  readonly failed: readonly string[];
  readonly failedRuns: number;
  readonly maskingLeaks: readonly string[];
  readonly patternMismatches: readonly string[];
  readonly thresholdsMet: boolean;
  readonly verdict: 'pass' | 'fail';
}

function expectationsMet(expects: readonly NlRoutingToolExpectation[], breakdown: Record<string, number>): boolean {
  return expects.every((expectation) => (breakdown[expectation.tool] ?? 0) >= (expectation.minCount ?? 1));
}

/**
 * v5 채점의 최소 실행 턴 — 코퍼스 예산(CORPUS_BUDGETS) 과 «독립»인 채점 턴 정책 상수.
 * 낮은 예산에서 복합 발화가 예산 부족만으로 거짓 실패하지 않게 한다.
 */
export const NL_ROUTING_V5_MIN_SCORING_TURNS = 6;

/** v5 28문항을 «생산 runEvalPrompt seam» 으로 그대로 돌려 경로·복합 처리를 채점한다. */
export async function scoreNlRoutingV5(opts: {
  runPrompt: typeof runEvalPrompt;
  surface: EvalPromptToolSurface;
  cwd: string;
  maxTurns?: number;
}): Promise<NlRoutingV5Score> {
  const maxTurns = opts.maxTurns ?? NL_ROUTING_V5_MIN_SCORING_TURNS;
  const matched = new Set<string>();
  const failed: string[] = [];
  const patternMismatches: string[] = [];
  let scored = 0;
  let passed = 0;
  let failedRuns = 0;
  for (const question of NL_ROUTING_V5_QUESTIONS) {
    if (!matchNlUtterancePatterns(question.prompt).includes(question.pattern)) {
      patternMismatches.push(question.id);
    }
    try {
      const result = await opts.runPrompt({ prompt: question.prompt, maxTurns, tools: opts.surface, silent: true, cwd: opts.cwd });
      scored += 1;
      if (expectationsMet(question.expects, result.toolBreakdown)) {
        passed += 1;
        matched.add(question.pattern);
      } else failed.push(question.id);
    } catch {
      failedRuns += 1;
    }
  }
  const matchedPatterns = NL_UTTERANCE_PATTERNS.filter((pattern) => matched.has(pattern.id));
  const leaks = maskingExampleLeaks();
  const thresholdsMet = scored >= NL_ROUTING_V5_THRESHOLDS.scored
    && passed >= NL_ROUTING_V5_THRESHOLDS.scored
    && matchedPatterns.length >= NL_ROUTING_V5_THRESHOLDS.patterns
    && leaks.length <= NL_ROUTING_V5_THRESHOLDS.maskingLeaks
    && patternMismatches.length === 0;
  return {
    questions: NL_ROUTING_V5_QUESTIONS.length,
    pathQuestions: NL_ROUTING_V5_QUESTIONS.filter((question) => NL_UTTERANCE_PATTERNS.find((pattern) => pattern.id === question.pattern)?.handles === 'path').length,
    compoundQuestions: NL_ROUTING_V5_QUESTIONS.filter((question) => NL_UTTERANCE_PATTERNS.find((pattern) => pattern.id === question.pattern)?.handles === 'compound').length,
    patterns: matchedPatterns.length,
    pathPatterns: matchedPatterns.filter((pattern) => pattern.handles === 'path').length,
    compoundPatterns: matchedPatterns.filter((pattern) => pattern.handles === 'compound').length,
    scored,
    passed,
    failed,
    failedRuns,
    maskingLeaks: leaks,
    patternMismatches,
    thresholdsMet,
    verdict: thresholdsMet ? 'pass' : 'fail',
  };
}

function formatMachineLoad(load: MachineLoad): string {
  return `부하 ${load.loadAverage.map((value) => value.toFixed(2)).join('/')}, ${load.coreCount}코어`;
}

function authoritativeSurfaceToolNames(surface: EvalPromptToolSurface): string[] {
  const cfg = getUserConfig();
  // ⛔ 안전 관문(노출된 변이 툴)은 «provider 해석보다 먼저» 닫혀야 한다 — 자격이 없는 기계(게이트 Pod)에서
  //   provider 해석이 먼저 던지면 관문이 안내 대신 「No LLM provider」로 끝났다(0.2.20 컷 pod-7·pod-22).
  //   provider 가 없으면 러너의 마지막 기본 모델로 서피스를 재서 관문을 그대로 판정한다(런은 어차피 못 돈다).
  let providerDefaultModel: string | undefined;
  try {
    providerDefaultModel = resolveDefaultProvider().defaultModel;
  } catch (error) {
    if (!(error instanceof NoLlmProviderAvailableError)) throw error;
  }
  const modelFamily = getModelFamily(resolveReproModelId(undefined, providerDefaultModel));
  const { specs } = buildEvalPromptToolSurface(surface, modelFamily, cfg);
  const tools = filterToolsByDeny(specs, cfg.chat.toolDeny) ?? specs;
  return tools.map((tool) => tool.name);
}

export async function main(
  readCorpus: () => Corpus = readCorpusFromEnv,
  runPrompt: typeof runEvalPrompt = runEvalPrompt,
  resolveSafety: (surfaceToolNames: readonly string[]) => CorpusRunSafety = (surfaceToolNames) => resolveCorpusRunSafety(process.env, resolveObserveOnlyDecision(process.env), surfaceToolNames),
  resolveSurfaceTools: (surface: EvalPromptToolSurface) => readonly string[] = authoritativeSurfaceToolNames,
): Promise<void> {
  // ⛔⭐⭐⭐ 이 러너는 **인자를 안 받는다** — 설정은 전부 환경변수다. 그런데 그 전에는
  //   모르는 인자를 **조용히 무시하고 exit 0** 으로 끝났다. 그게 「조용한 실패」다.
  //   실측(2026-08-03 · `[T]` `GOAL-T27`): 골이 `--out <경로>` 를 시켰고 러너는 그 플래그를
  //   무시했다 ⇒ ***수는 나왔는데 원자료 JSON 이 없었고***, 리뷰가 세 라운드 동안
  //   *"원자료가 커밋되지 않아 재검증할 수 없다"* 를 반복했다. 아무도 「왜 없는지」를 못 봤다.
  //   ⇒ ⭐⭐ ***조용한 실패를 시끄러운 실패로 바꾼다*** — 그래야 「거부가 이름을 댄다」가 발화한다.
  const unknownArgs = process.argv.slice(2);
  if (unknownArgs.length) {
    throw new Error(`이 러너는 인자를 받지 않는다 — 모르는 인자 ${unknownArgs.join(' ')}. `
      + '설정은 환경변수다: CORPUS_CWD=<툴 작업 디렉토리> · CORPUS_PATH=<코퍼스 JSON 경로> · CORPUS_OUT=<원자료 JSON 경로> · CORPUS_TIERS · CORPUS_IDS · CORPUS_REPEATS · CORPUS_BUDGETS · CORPUS_CONCURRENCY · CORPUS_V5=1 (v5 28문항 경로·복합 처리 채점)');
  }
  const corpusCwd = resolveCorpusCwdFromEnv();
  const requestedSurface = process.env.CORPUS_SURFACE;
  if (requestedSurface !== undefined && !isEvalPromptToolSurface(requestedSurface)) {
    throw new Error(`Invalid CORPUS_SURFACE ${JSON.stringify(requestedSurface)}; valid values: ${EVAL_PROMPT_TOOL_SURFACES.join(', ')}.`);
  }
  const corpus = readCorpus();
  const surfaceCandidate = requestedSurface ?? corpus.surface;
  if (!isEvalPromptToolSurface(surfaceCandidate)) {
    throw new Error(`Invalid corpus surface ${JSON.stringify(surfaceCandidate)}; valid values: ${EVAL_PROMPT_TOOL_SURFACES.join(', ')}.`);
  }
  const surface = surfaceCandidate;
  const surfaceToolNames = [...resolveSurfaceTools(surface)];
  const safety = resolveSafety(surfaceToolNames);
  const repeats = positiveInteger(process.env.CORPUS_REPEATS, 'CORPUS_REPEATS', 3);
  const budgets = positiveIntegerList(process.env.CORPUS_BUDGETS, 'CORPUS_BUDGETS', [6]);
  const concurrency = positiveInteger(process.env.CORPUS_CONCURRENCY, 'CORPUS_CONCURRENCY', 4);
  // ★ MEAS-T8 — 문항 판단은 N≥10 집중 프로브로만 한다. 그것을 **같은 러너**에서 할 수 있게
  //   `CORPUS_IDS` 를 붙인다(다른 자로 재면 기준선과 비교 불가 · 형태 F3).
  const items = selectCorpusItems(corpus.items, corpusFiltersFromEnv(process.env));
  const unmeasurableIds = unavailableExpectedToolIds(items, surfaceToolNames);
  const isUnmeasurable = new Set(unmeasurableIds);
  const measurableItems = items.filter((item) => !isUnmeasurable.has(item.id));
  const load = machineLoad();

  console.log(`[corpus] ${items.length} 문항 × ${repeats}회 × 예산 ${budgets.join('/')} · 서피스 ${surface} (유효 목록 ${EVAL_PROMPT_TOOL_SURFACES.indexOf(surface) + 1}/${EVAL_PROMPT_TOOL_SURFACES.length}) · tool-cwd ${corpusCwd} · ${formatMachineLoad(load)} · observe-only ${safety.observeOnly.enabled} (${safety.observeOnly.source}) · exposed-mutating-tools ${safety.exposedMutatingTools.length > 0 ? safety.exposedMutatingTools.join(',') : '(none)'} · unsafe-bypass ${safety.bypassed}`);
  console.log('[corpus] 이 수는 LLM 실행 확률의 표본이라 런마다 움직인다. 문항·티어 모두 k/n 원자료와 95% Wilson 구간으로만 보고하며 티어 비교 결론은 내리지 않는다.\n');

  if (unmeasurableIds.length > 0) {
    console.log(`[corpus] 측정 불가 ${unmeasurableIds.length}문항 — 서피스 ${surface}에 기대 툴이 없어 실행·라우팅 실패·티어 분모에서 제외: ${unmeasurableIds.join(', ')}`);
  }

  const jobs = budgets.flatMap((budget) => Array.from({ length: repeats }, (_, rep) => measurableItems.map((item) => ({ item, budget, rep }))).flat());
  const records: ScreeningRecord[] = [];
  let done = 0;
  for (let index = 0; index < jobs.length; index += concurrency) {
    const settled = await Promise.all(jobs.slice(index, index + concurrency).map(async ({ item, budget, rep }) => {
      const record = await measureScreeningRun(item, budget, rep, async (candidate, maxTurns) => {
        const result = await runPrompt({ prompt: promptForItem(candidate), maxTurns, tools: surface, silent: true, cwd: corpusCwd });
        // ⭐ `I-16` — 답문을 버리지 않고 넘긴다. 보존 여부·상한은 심이 정하고, 여기서는 해석하지 않는다.
        return { toolBreakdown: result.toolBreakdown, turnCount: result.turnCount, durationMs: result.durationMs, text: result.text };
      }, load);
      // ⛔⭐ 실패는 **이유와 함께** 적는다(2026-07-30) — 종전엔 *"측정 불가"* 만 나와
      //    30/30 이 죽어도 원인을 사람이 처음부터 다시 찾아야 했다(실측: 워크트리 node_modules 누락).
      if (!record) {
        const why = screeningFailureReason(item.id, budget, rep) ?? '이유 미기록';
        console.error(`[corpus] ⛔ ${item.id} rep${rep} b${budget} 실행 실패: ${why}`);
      }
      return record;
    }));
    for (const record of settled) if (record) records.push(record);
    done += settled.length;
    process.stderr.write(`\r[corpus] ${done}/${jobs.length}`);
  }
  process.stderr.write('\n\n');

  const reportingTiers = [...new Set(items.map((item) => item.tier))];
  for (const budget of budgets) {
    const inBudget = records.filter((record) => record.budget === budget);
    console.log(`═══ 예산 max-turns=${budget} ═══`);
    for (const tier of reportingTiers) {
      const description = corpus.tiers[tier] ?? '(설명 없음)';
      const tierItems = items.filter((item) => item.tier === tier);
      if (tierItems.length === 0) continue;
      const measurableTierItems = tierItems.filter((item) => !isUnmeasurable.has(item.id));
      const itemSummaries = measurableTierItems.map((item) => ({
        item,
        summary: passSummary(inBudget.filter((record) => record.id === item.id), repeats),
      }));
      const aggregate = passSummary(inBudget.filter((record) => itemSummaries.some(({ item }) => item.id === record.id)));
      const interval = wilsonInterval(aggregate.passes, aggregate.runs);
      const fluctuating = itemSummaries.filter(({ summary }) => summary.passes > 0 && summary.passes < summary.runs).map(({ item }) => item.id);
      const itemResults = itemSummaries.map(({ item, summary }) => `${item.id} ${summary.passes}/${summary.runs}${summary.runs === summary.expectedRuns ? '' : ` (기대 ${summary.expectedRuns})`}`).join(' · ');
      console.log(`  ${tier} (${description})`);
      console.log(`    문항별 ${itemResults}`);
      const singletonRecords = inBudget.filter((record) => measurableTierItems.some((item) => item.id === record.id && item.accept.length === 1));
      const singleton = passSummary(singletonRecords);
      const singletonInterval = wilsonInterval(singleton.passes, singleton.runs);
      const acceptSizes = measurableTierItems.map((item) => item.accept.length);
      const unmeasurableTierCount = tierItems.length - measurableTierItems.length;
      console.log(`    티어 합계 ${aggregate.passes}/${aggregate.runs}${interval ? ` · 95% Wilson ${formatPercent(interval.lower)}–${formatPercent(interval.upper)}` : ' · 95% Wilson 산출 불가'}`);
      console.log(`    |accept| 평균 ${acceptSizes.length > 0 ? (acceptSizes.reduce((sum, size) => sum + size, 0) / acceptSizes.length).toFixed(1) : '산출 불가'} · |accept|=1 통제 ${singleton.passes}/${singleton.runs}${singletonInterval ? ` · 95% Wilson ${formatPercent(singletonInterval.lower)}–${formatPercent(singletonInterval.upper)}` : ' · 표본 없음'}`);
      if (unmeasurableTierCount > 0) console.log(`    측정 불가 ${unmeasurableTierCount}문항은 이 티어 분모에서 제외`);
      console.log(`    흔들린 문항 id ${fluctuating.length > 0 ? fluctuating.join(', ') : '(없음)'}`);
    }
    const measurableRecords = inBudget.filter((record) => !isUnmeasurable.has(record.id));
    const noFire = measurableRecords.filter((record) => record.outcome === 'no-fire').length;
    const wrong = measurableRecords.filter((record) => record.outcome === 'wrong-tool').length;
    // ⛔⭐ `rejected-tool` 을 «따로» 센다 — 종전엔 이 줄이 'wrong-tool' 만 봐서
    //   ***거부 목록의 툴이 실제로 발화해도 「툴 오선택 0」***이라고 보고했다.
    //   📏 2026-08-11 실측: HARNESS-N 넷이 코퍼스 최초로 `reject` 를 쓰자마자 드러났다 —
    //     HN-02 가 `SelfImplement` 를 발화(outcome=rejected-tool)했는데 요약은 「오선택 0」이었다.
    //   🎯 그리고 둘은 «다른 실패»다: `wrong-tool` = 기대 밖 툴 · `rejected-tool` = ***우리가 「이건 아니다」라고
    //     명시한 툴을 골랐다***. 뒤쪽이 더 무겁다(라우팅이 «반대로» 갔다는 뜻이므로).
    const rejected = measurableRecords.filter((record) => record.outcome === 'rejected-tool').length;
    console.log(`  실패 분류 — ①미발사 ${noFire} · ②툴 오선택 ${wrong} · ③거부툴 선택 ${rejected} (측정 가능 실행 ${measurableRecords.length})\n`);
  }

  // ★ v5 28문항 경로·복합 처리 채점 — 같은 러너·같은 runEvalPrompt seam 으로 채점한다
  //   (다른 자로 재면 판정선과 비교 불가 · 형태 F3). 임계 미달은 «조용한 0» 이 아니라 거부다.
  let v5: NlRoutingV5Score | undefined;
  if (process.env.CORPUS_V5 === '1') {
    // ⛔ 채점 턴 정책은 코퍼스 예산과 «독립»이다 — 예산은 코퍼스 생성 실행 횟수만 제어하고
    //   채점 maxTurns 는 NL_ROUTING_V5_MIN_SCORING_TURNS 기본(또는 명시적 opts)에서만 온다.
    v5 = await scoreNlRoutingV5({ runPrompt, surface, cwd: corpusCwd });
    console.log(`[v5] patterns ${v5.patterns} (path ${v5.pathPatterns} · compound ${v5.compoundPatterns}) · 문항 ${v5.questions} (path ${v5.pathQuestions} · compound ${v5.compoundQuestions}) · 채점 ${v5.scored} · 통과 ${v5.passed} · 실패 ${v5.failed.length ? v5.failed.join(',') : '(없음)'} · 실행 실패 ${v5.failedRuns} · masking-leak ${v5.maskingLeaks.length} ${v5.maskingLeaks.length ? v5.maskingLeaks.join(',') : '(없음)'} · pattern-mismatch ${v5.patternMismatches.length ? v5.patternMismatches.join(',') : '(없음)'} · 판정 ${v5.verdict}`);
    if (!v5.thresholdsMet) {
      throw new Error(
        `NL routing v5 entrance stopped: 채점 문항 ${v5.scored} < ${NL_ROUTING_V5_THRESHOLDS.scored}`
        + ` 또는 올바른 라우팅 ${v5.passed} < ${NL_ROUTING_V5_THRESHOLDS.scored}`
        + ` 또는 패턴 ${v5.patterns} < ${NL_ROUTING_V5_THRESHOLDS.patterns}`
        + ` 또는 가림 예시 누출 ${v5.maskingLeaks.length} > ${NL_ROUTING_V5_THRESHOLDS.maskingLeaks}`
        + ` 또는 패턴 미발화 ${v5.patternMismatches.length}.`,
      );
    }
  }

  const errored = jobs.length - records.length;
  if (errored > 0) console.log(`⚠️ 실행 실패 ${errored}건은 측정 가능 표본의 누락 실행이며 관측된 k/n 분모에서 제외했다.`);
  const out = process.env.CORPUS_OUT;
  // ⛔⭐ 최상위 `machineLoad` 는 **런 시작 스냅샷**이고 이름은 그대로 둔다(기존 원자료가 그 뜻으로 쓰였다).
  //    레코드의 실제 부하는 `records[].loadAtStart`·`loadAtEnd` 다(`MEAS-T15` · 타입 주석에 표로 있다).
  //    ⛔ 별칭 필드를 나란히 두지 않는다 — 소비자 없는 중복은 **죽은 공개 필드**다(리뷰 must-fix 수용).
  if (out) writeFileSync(out, JSON.stringify({ surface, repeats, budgets, machineLoad: load, observeOnly: safety.observeOnly, unsafeBypass: safety.bypassed, exposedMutatingTools: safety.exposedMutatingTools, surfaceToolNames, unmeasurableIds, ...(v5 ? { v5 } : {}), records }, null, 2));
}

if (import.meta.main) await main();
