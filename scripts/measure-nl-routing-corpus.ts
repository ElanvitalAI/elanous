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
      + '설정은 환경변수다: CORPUS_CWD=<툴 작업 디렉토리> · CORPUS_PATH=<코퍼스 JSON 경로> · CORPUS_OUT=<원자료 JSON 경로> · CORPUS_TIERS · CORPUS_IDS · CORPUS_REPEATS · CORPUS_BUDGETS · CORPUS_CONCURRENCY');
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

  const errored = jobs.length - records.length;
  if (errored > 0) console.log(`⚠️ 실행 실패 ${errored}건은 측정 가능 표본의 누락 실행이며 관측된 k/n 분모에서 제외했다.`);
  const out = process.env.CORPUS_OUT;
  // ⛔⭐ 최상위 `machineLoad` 는 **런 시작 스냅샷**이고 이름은 그대로 둔다(기존 원자료가 그 뜻으로 쓰였다).
  //    레코드의 실제 부하는 `records[].loadAtStart`·`loadAtEnd` 다(`MEAS-T15` · 타입 주석에 표로 있다).
  //    ⛔ 별칭 필드를 나란히 두지 않는다 — 소비자 없는 중복은 **죽은 공개 필드**다(리뷰 must-fix 수용).
  if (out) writeFileSync(out, JSON.stringify({ surface, repeats, budgets, machineLoad: load, observeOnly: safety.observeOnly, unsafeBypass: safety.bypassed, exposedMutatingTools: safety.exposedMutatingTools, surfaceToolNames, unmeasurableIds, records }, null, 2));
}

if (import.meta.main) await main();
