/**
 * FU-I7a (2026-05-12) — production LLM adapter for the Phase 1 intake
 * pipeline.
 *
 * The 4 LLM-touching phases (decompose · categorize · goal_align ·
 * multi_spec) all accept injected callables so they stay hermetic under
 * test. This module builds the **production** versions, wrapping the
 * same `streamLLM` path the rest of elanous uses (matches R3 workflow-
 * synth wiring in `src/nexus/api/workflows.ts:90`):
 *
 *   decompose / categorize / align → thin `streamLLM` wrappers that
 *     buffer the stream into `{ text, ...usage }` (the shape every
 *     intake-plane callable expects).
 *
 *   synth → wraps `synthWorkflowFromIntent` (R3) which itself uses
 *     `WorkflowDeps.callLLM`. We hand it the same `callLLM` adapter
 *     so model/provider resolution is identical to R3 `elanous workflow
 *     synth`.
 *
 * Test seam: every dep is injectable. Production resolves them via
 * lazy `require` so the module graph stays lean when the endpoint is
 * called in skeleton mode (the FU3 e2e tests never instantiate this
 * module's lazy requires).
 *
 * Cross-ref:
 *   src/llm.ts (streamLLM · resolveDefaultProvider · PROVIDERS)
 *   src/workflow-synth/index.ts (synthWorkflowFromIntent · R3)
 *   src/nexus/api/workflows.ts (default WorkflowDeps wiring · R3)
 *   src/nexus/api/intake-pipeline-preview.ts (FU3 endpoint consumer)
 */
import type {
  DecomposeMemoCallable,
} from './decompose.js';
import { extractJsonBlock, skeletonFallback } from './decompose.js';
import type { CategorizeCallable } from './categorize.js';
import type { AlignCallable } from './goal-align.js';
import type { SingleSynthCallable } from './multi-spec.js';
import type { IntakeCompareCaller, IntakePreprocessCaller } from './check.js';
import type { ModelRole } from '../user-config.js';

// ──────────────────── Public surface ─────────────────────────────────

/** Bundle of the 4 LLM-touching callables consumed by the Phase 1
 *  pipeline. Built together so options (provider · model) resolve
 *  once and the four calls stay configuration-consistent. */
export interface IntakeRuntimeCallables {
  decompose: DecomposeMemoCallable;
  categorize: CategorizeCallable;
  align: AlignCallable;
  synth: SingleSynthCallable;
}

/** Per-call signature for the buffered streamLLM wrapper — matches the
 *  shape every intake-plane LLM phase expects. */
export interface StreamLlmFn {
  (
    messages: Array<{ role: string; content: string }>,
    onChunk: (delta: string) => void,
    opts?: {
      model?: string;
      provider?: { name: string } & Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

/** R3 synth seam — wraps `synthWorkflowFromIntent`. */
export interface SynthFromIntentFn {
  (
    opts: {
      intent: string;
      context?: string;
      preview?: boolean;
      scope?: 'project' | 'global';
      signal?: AbortSignal;
    },
    deps: {
      callLLM: (args: {
        prompt: string;
        systemPrompt?: string;
        signal?: AbortSignal;
      }) => Promise<string>;
    },
  ): Promise<{
    ok: boolean;
    yaml?: string;
    workflowName?: string;
    triggerSummary?: string;
    error?: string;
    repaired?: boolean;
  }>;
}

/** Provider+model resolver — matches `src/llm.ts.resolveDefaultProvider`
 *  shape. Optional in build options; defaults are wired lazily. */
export interface ResolveProviderFn {
  (model?: string): { name: string } & Record<string, unknown>;
}

/** Lookup table — matches `src/llm.ts.PROVIDERS`. */
export type ProviderRegistry = Record<string, { name: string } & Record<string, unknown>>;

/** 문서 모드 선가공·비교만. decompose 네 단계는 이 묶음에 넣지 않는다. */
export interface IntakeDocumentStageCallables {
  preprocess: IntakePreprocessCaller;
  compare: IntakeCompareCaller;
  /** 두 단계가 고른 provider 이름. 역할 LLM 이 grok 이면 둘 다 grok. */
  providerName: string;
}

export interface ResolveRoleProviderFn {
  (role: ModelRole): { provider: { name: string } & Record<string, unknown>; model?: string };
}

export interface BuildRuntimeCallablesOptions {
  /** Override the LLM provider by name (matches `src/llm.ts.PROVIDERS`
   *  keys: 'claude' · 'openai' · 'grok' · 'gemini' · 'local' · ...).
   *  When omitted, the resolver picks per user-config / env / model
   *  family heuristic. */
  provider?: string;
  /** Override the model id. When omitted, the resolved provider's
   *  default model is used. */
  model?: string;
  /** Test seams — wire deterministic stubs from unit tests. When all
   *  three are omitted, the lazy `require` path loads the real
   *  modules (`src/llm.ts` + `src/workflow-synth/index.ts`). */
  streamLLM?: StreamLlmFn;
  synthFromIntent?: SynthFromIntentFn;
  resolveProvider?: ResolveProviderFn;
  providers?: ProviderRegistry;
  /**
   * 문서 모드 두 단계 전용. 주면 resolveDefaultProvider 를 쓰지 않는다.
   * 생략하면 resolveRoleLlm('classify') 가 provider 를 고른다.
   */
  resolveRoleProvider?: ResolveRoleProviderFn;
}

function loadRoleProvider(): ResolveRoleProviderFn {
  const mod = require('../user-config.js') as {
    resolveRoleLlm: (role: ModelRole) => { provider: string; model: string };
  };
  const llm = require('../llm.js') as { PROVIDERS: ProviderRegistry };
  return (role) => {
    const resolved = mod.resolveRoleLlm(role);
    const provider = llm.PROVIDERS[resolved.provider] ?? { name: resolved.provider };
    return { provider, model: resolved.model };
  };
}

const DOCUMENT_STAGE_ROLE: ModelRole = 'classify';

/**
 * 선가공·비교·시너지 운영 호출자.
 * provider 는 resolveRoleLlm 이다. decompose·categorize·goal_align·multi_spec 은 여기로 옮기지 않는다.
 */
export function buildIntakeDocumentStageCallables(
  opts: BuildRuntimeCallablesOptions = {},
): IntakeDocumentStageCallables {
  const streamLLM = opts.streamLLM ?? loadProductionLlm().streamLLM;
  const resolveRole = opts.resolveRoleProvider ?? loadRoleProvider();
  const rolePick = resolveRole(DOCUMENT_STAGE_ROLE);
  const provider = rolePick.provider;
  const model = opts.model ?? rolePick.model;

  const ask = async (prompt: string): Promise<string> => {
    const text = await streamLLM(
      [{ role: 'user', content: prompt }],
      () => {},
      {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      },
    );
    if (extractJsonBlock(text) == null) {
      const fallback = skeletonFallback({ rawText: prompt });
      return JSON.stringify({
        claims: [],
        discards: [{ quote: fallback.missions[0]?.tasks[0]?.intent ?? prompt, reason: fallback.rationale }],
        proposals: [],
      });
    }
    return text;
  };

  // src/index.ts intake check .action → buildIntakeDocumentStageCallables → stages.preprocess → runIntakeCheckDocument.
  // src/nexus/api/meta-api.ts handleIntakePost → buildIntakeDocumentStageCallables → stages.preprocess → runIntakeCheckDocument.
  const preprocess: IntakePreprocessCaller = ({ document, lenses, anchors }) => {
    const lines = document.split('\n');
    let inCheck = false;
    const external = lines.filter((line) => {
      // 개명(2026-09-26) 전에 쓴 노트는 옛 제목을 그대로 갖고 있다 — 둘 다 빼야 자기 점검을 다시 읽지 않는다.
      if (/^##\s+🧭\s+(?:elanous|monad) 점검\s*$/.test(line.trim())) {
        inCheck = true;
        return false;
      }
      if (inCheck && /^#{1,2}\s+/.test(line.trim())) inCheck = false;
      return !inCheck;
    }).join('\n');
    return ask([
      'elanous 는 자기 자신을 개발·관측하는 코딩 에이전트 하니스다(CLI · 데몬 · 모델 카탈로그 · 하니스 런 · 관측 로그).',
      '아래 문서는 바깥 지식(영상 노트 · 글)이다. 문서의 각 사실을 렌즈로 보고 «elanous 에 대한 주장»으로 옮겨라.',
    '«elanous 에 대한 주장»의 조건:',
    '- 주어가 elanous 다(「elanous 는 …」「elanous 의 … 에 … 가 있다」). 영상 속 제품·모델·사람에 대한 평가는 주장이 아니다.',
    '- 각 주장마다 elanous 저장소·CLI 에서 실제로 검색할 수 있는 구체적인 이름(명령 · 옵션 · 설정 키 · 개념 등)을 하나 이상 반드시 백틱(`이름`)으로 적는다. 잴 이름을 특정할 수 없다면 주장을 만들지 말고 discards 에 원문과 이유를 남긴다.',
    '- 이름은 저장소에 드물게 나오는 구체적 식별자(명령 · 옵션 · 설정 키 · 파일 경로 · 함수 이름)로 고른다. `run` · `model` · `test` 같은 한 낱말 일반어는 너무 흔해 끝까지 잴 수 없다.',
    '- 문서의 사실이 elanous 에 «무엇을 묻게 하나»를 적는다 — 사실을 요약하지 않는다.',
    '- 대조할 주장은 반드시 긍정형 존재·능력 문장으로 쓴다(「elanous 에 X 가 있다」「elanous 는 X 를 기록한다」). 「0건 보유한다」「없다」「지원하지 않는다」「안 한다」「안 된다」처럼 부재를 단언하지 마라. 존재를 검사할 대상으로 바꾸지 못하면 discards 에 원문과 이유를 남긴다.',
    '렌즈별 질문: L1 능력=영상이 보여준 능력을 elanous 가 채우나 · L2 모델·가격=새 모델·가격이 elanous 카탈로그에 반영됐나 · L3 하니스 운영=영상이 겪은 병렬·격리·HITL·폴백 사고를 elanous 도 겪나 · L4 관측·측정=영상이 손으로 잰 것을 elanous 는 재나 · L5 라이선스·약관=무료 경로가 상업 사용에서 막히나 · L6 방법론=elanous 규율로 옮길 것이 있나',
    '예: ❌「두 에이전트가 같은 폴더에서 서로 파일을 고쳐 실험이 무효가 됐다」 → ✅「elanous 는 다른 에이전트가 같은 파일을 쓰는 것을 감지한다」(L3)',
    '예: ❌「새 모델이 입력 $4 · 출력 $20 으로 나왔다」 → ✅「elanous 모델 카탈로그에 그 새 모델의 id 가 있다」(L2 · id 는 문서에서 옮겨 백틱으로)',
    '예: ❌「과제별 비용을 손으로 집계했다」 → ✅「elanous 런 원장이 런 단위 `costUsd` 를 기록한다」(L4)',
    'elanous 에 물을 것이 없는 사실(영상 제품 홍보 · 개인 평가 · 날짜 · 이름)은 이유와 함께 버린다.',
    'FACT_LINE 불릿을 그대로 주장으로 쓰지 마라.',
    `렌즈: ${lenses.join(' · ')}`,
    ...(anchors && anchors.length > 0 ? [
      `elanous 에 이미 있는 명령·능력 이름: ${anchors.join(' · ')}`,
      '- 문서가 다루는 것에 대응하는 이름이 위 목록에 있으면 그 이름을 백틱으로 쓴다.',
      '- 대응이 이미 있어도 버리지 않는다. 문서가 보여 준 방법·패턴 가운데 elanous 쪽에 아직 없을 수 있는 것을 긍정형 주장으로 만든다 — 꼴: 「elanous 의 `<그 이름>` 은 <문서가 보여 준 방법> 을 한다」.',
    ] : []),
    'JSON: {"claims":[{"text":"elanous 는 …","quote":"원문 인용","lens":"L1 능력"}],"discards":[{"quote":"","reason":""}]}',
    '문서:',
    external,
  ].join('\n'));
  };

  const compare: IntakeCompareCaller = ({ items, ruler }) => ask([
    '대조 결과와 자에 있는 능력·입구를 보고 추가·보강·시너지만 제안하라.',
    '판정 「못 쟀다」로 종류를 만들지 마라.',
    '종류는 판정에서 정해진다: 「없음」→ 추가 · 「판단 필요」·「있음」→ 보강 · 시너지는 판정과 무관하게 기존 능력·입구 둘 이상을 결합할 때.',
    '⛔ fact 는 대조 결과의 fact 문자열을 «한 글자도 바꾸지 말고» 복사한다 — 바꿔 쓰면 근거 없음으로 버려진다.',
    '⛔ contrast 는 그 항목 evidence 의 `path:line` 하나를 «그대로» 복사한다(여러 개를 + 로 잇지 않는다). evidence 에 path 가 없는 항목(「없음」)은 contrast 를 비울 수 없으니 제안하지 않는다.',
    '⛔ 시너지의 surfaces 는 아래 능력·입구 목록에 «있는 이름만» 둘 이상 쓴다(elanous · git 같은 일반 낱말 금지).',
    `능력: ${ruler.capabilities.join(' · ')}`,
    `입구: ${ruler.surfaces.join(' · ')}`,
    `대조: ${JSON.stringify(items.map((item) => ({ fact: item.fact, verdict: item.verdict, evidence: item.evidence })))}`,
    'JSON: {"proposals":[{"kind":"추가|보강|시너지","fact":"","contrast":"path:line","surfaces":[]}]}',
  ].join('\n'));

  return { preprocess, compare, providerName: provider?.name ?? '' };
}

// ──────────────────── Lazy production deps ──────────────────────────

/** Production resolver — defers loading `src/llm.ts` until first use
 *  so the FU3 e2e tests (which never exercise real LLM mode) don't
 *  pull the multi-thousand-line LLM router into their module graph. */
function loadProductionLlm(): {
  streamLLM: StreamLlmFn;
  resolveDefaultProvider: ResolveProviderFn;
  PROVIDERS: ProviderRegistry;
} {
  // Cast is the unavoidable bridge between the heavy `src/llm.ts`
  // exports and the trimmed-down surface this module needs.
  const mod = require('../llm.js') as {
    streamLLM: StreamLlmFn;
    resolveDefaultProvider: ResolveProviderFn;
    PROVIDERS: ProviderRegistry;
  };
  return mod;
}

function loadProductionSynth(): { synthWorkflowFromIntent: SynthFromIntentFn } {
  return require('../workflow-synth/index.js') as {
    synthWorkflowFromIntent: SynthFromIntentFn;
  };
}

// ──────────────────── Builder ───────────────────────────────────────

export function buildRealIntakeCallables(
  opts: BuildRuntimeCallablesOptions = {},
): IntakeRuntimeCallables {
  // Resolve the streamLLM seam once + memoise the chosen provider so
  // the 4 callables stay consistent across one decompose round. The
  // resolver runs eagerly here (cheap — it reads user-config). The
  // streamLLM dispatch is per-call.
  const streamLLM = opts.streamLLM ?? loadProductionLlm().streamLLM;
  const synthFromIntent = opts.synthFromIntent ?? loadProductionSynth().synthWorkflowFromIntent;
  const resolveProvider = opts.resolveProvider
    ?? loadProductionLlm().resolveDefaultProvider;
  const providers = opts.providers ?? loadProductionLlm().PROVIDERS;

  // Provider resolution — explicit name wins; else heuristic.
  const provider = opts.provider && providers[opts.provider]
    ? providers[opts.provider]
    : resolveProvider(opts.model);
  const model = opts.model;

  /** Shared adapter: stream the LLM, buffer the full text, return the
   *  shape every {prompt → text} intake callable expects. */
  const promptCallable = async (
    args: { prompt: string; signal?: AbortSignal },
  ): Promise<{ text: string; modelId?: string }> => {
    const text = await streamLLM(
      [{ role: 'user', content: args.prompt }],
      () => {},
      {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
    return { text, modelId: provider?.name };
  };

  const decompose: DecomposeMemoCallable = (args) => promptCallable(args);
  const categorize: CategorizeCallable = (args) => promptCallable(args);
  const align: AlignCallable = (args) => promptCallable(args);

  /** Synth callable — wraps R3 `synthWorkflowFromIntent`. Hands it a
   *  `callLLM` adapter built on the same streamLLM seam so model /
   *  provider stay consistent with the other three phases. */
  const synth: SingleSynthCallable = async (input, callOpts) => {
    const callLLM = async (callArgs: {
      prompt: string;
      systemPrompt?: string;
      signal?: AbortSignal;
    }): Promise<string> => {
      const messages: Array<{ role: string; content: string }> = [];
      if (callArgs.systemPrompt) {
        messages.push({ role: 'system', content: callArgs.systemPrompt });
      }
      messages.push({ role: 'user', content: callArgs.prompt });
      return streamLLM(
        messages,
        () => {},
        {
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(callArgs.signal ? { signal: callArgs.signal } : {}),
        },
      );
    };
    const result = await synthFromIntent(
      {
        intent: input.intent,
        context: input.context,
        preview: true,
        ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
      },
      { callLLM },
    );
    if (result.ok && result.yaml) {
      const out: {
        ok: true;
        yaml: string;
        workflowName?: string;
        triggerSummary?: string;
        repaired?: boolean;
      } = { ok: true, yaml: result.yaml };
      if (result.workflowName !== undefined) out.workflowName = result.workflowName;
      if (result.triggerSummary !== undefined) out.triggerSummary = result.triggerSummary;
      if (result.repaired !== undefined) out.repaired = result.repaired;
      return out;
    }
    return { ok: false, error: result.error ?? 'synth-failed' };
  };

  return { decompose, categorize, align, synth };
}
