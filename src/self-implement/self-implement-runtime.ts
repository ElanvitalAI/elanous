// SelfImplement 네이티브 툴 런타임 (2026-07-19 · P2) — elanous 가 TUI 대화의 자연어
// ("이 기능 구현하고 PR 올려줘")를 인식해 자율 호출하는 ToolRuntime. runSelfImplement
// 시퀀서(fork→worktree→구현→gate→PR)를 실 seam(defaultSeams)로 구동한다.
//
// HITL(제1원칙 · fail-closed): PR open 은 outward-facing 게이트다. approver 는 모듈 레벨
// ref 로 대시보드 부팅 때 주입(terminal-inject 동형 — ToolRuntimeContext.approver 는 PTY
// spawn 용 {cmd,args,cwd} 제네릭이라 PR 승인 shape 와 안 맞으므로 tool-specific ref 를 둔다).
// approver 가 없으면 orchestrator 가 approvePr seam 없이 돌아 PR 을 절대 열지 않는다(자동승인 금지).
//
// 미션 무접촉: 미션 plan/build 코드와 무결합인 재사용 seam 만 호출(세션-드라이브 흐름).

import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from '../tool-runtime/types.js';
import type { SelfImplementProgressStage, SelfImplementResult, SelfImplementSeams } from './orchestrator.js';
import { createSeqTracker, makeEnvelope } from '../feedback/envelope.js';
import { runSelfImplementCliCommand, type SelfImplementCliDeps, type SelfImplementCliOpts, type SelfImplementCliOutcome } from './self-implement-cli.js';
import type { DevPipelineDeps } from '../self-dev/dev-pipeline.js';
import { resolveAutoOpenPrDecision } from './auto-open-pr.js';
import { resolveObserveOnlyDecision } from './observe-only.js';
import { defaultSeams, type DefaultSeamsOptions } from './seams.js';
import { debug } from '../debug/log.js';
import { createRepositoryReferencedFileReader, type ReferencedFileReadResult } from './goal-file-reader.js';
import { parseArtifactLaunchDeclaration, writeAuthoredGoal } from './goal-author.js';
import type { OrchestrateSelfDevOptions, SelfDevJobResult } from '../self-dev/orchestrate.js';
import { runSelfOrchestrateCliCommand, type OrchestrateCliInput, type OrchestrateCliOutcome } from '../self-dev/orchestrate-cli.js';
import { decomposeSelfDevGoal, type SelfDevDecomposeOptions, type SelfDevDecomposition } from '../self-dev/decompose.js';
import { decomposeFabricRequest, type FabricDecomposeRequestOptions, type FabricDecomposeRequestResult } from '../self-dev/fabric-decompose-adapter.js';
import { normalizeTargetPaths, observeDecomposerSelection, selectFabricDecomposer } from '../self-dev/self-orchestrate-runtime.js';
import { parseAskProseTitle } from '../self-dev/launch-preflight.js';
import { getUserConfig } from '../user-config.js';
import { mintRunId } from '../harness/harness-space.js';

type SelfImplementApprover = NonNullable<SelfImplementSeams['approvePr']>;
type SelfImplementGoalAuthor = (ask: string, cwd: string, deps?: { goalTitle?: string }) => Promise<{ path: string }>;

// ── HITL approver (module ref · fail-closed) ──
let approverRef: SelfImplementApprover | null = null;

/** PR open 승인 게이트를 주입한다. 대시보드 부팅 때 1회(requestConfirmation 래핑). null =
 *  un-set(테스트에서 fail-closed 토글). 미주입 시 PR 은 열리지 않는다(자동승인 금지). */
export function setSelfImplementApprover(a: SelfImplementApprover | null): void {
  approverRef = a;
}

/** 테스트 헬퍼 — 현재 approver 바인딩 조회. */
export function _getSelfImplementApproverForTesting(): SelfImplementApprover | null {
  return approverRef;
}

// ── 자식 elanous 격리/대기 deps (부팅 때 주입 · 격리 테스트에서 config/state 분기) ──
interface SelfImplementRuntimeDeps {
  configDir?: string;
  stateDir?: string;
  implementMaxWaitSec?: number;
}
let runtimeDeps: SelfImplementRuntimeDeps = {};

// TUI-only observer. The tool call id is furnished by the actual dispatcher;
// other surfaces and calls without an id cannot register a stop target.
let softStopSpaceObserver: ((toolCallId: string, spaceId: string) => void) | null = null;
export function setSelfImplementSoftStopSpaceObserver(observer: typeof softStopSpaceObserver): void {
  softStopSpaceObserver = observer;
}

/** 자식 헤드리스 elanous 의 config/state 격리 + 구현 대기 상한을 주입. */
export function setSelfImplementRuntimeDeps(d: SelfImplementRuntimeDeps | null): void {
  runtimeDeps = d ?? {};
}

// ── seam factory (테스트 seam) ──
let seamsFactory: (o: DefaultSeamsOptions) => SelfImplementSeams = defaultSeams;

type RunSelfImplementCliFn = (
  feature: string,
  opts: SelfImplementCliOpts,
  deps: SelfImplementCliDeps,
) => Promise<SelfImplementCliOutcome>;
let runSelfImplementCliFn: RunSelfImplementCliFn = runSelfImplementCliCommand;

/** 테스트 seam — 실 fork/worktree/spawn/gate/PR 대신 fake seam 을 주입. null = 실 defaultSeams. */
export function _setSelfImplementSeamsFactoryForTesting(
  f: ((o: DefaultSeamsOptions) => SelfImplementSeams) | null,
): void {
  seamsFactory = f ?? defaultSeams;
}

/** 테스트 seam — 자연어 단일 실행의 중앙 CLI 심을 교체한다. null = 실 runSelfImplementCliCommand. */
export function _setSelfImplementCliCommandForTesting(command: RunSelfImplementCliFn | null): void {
  runSelfImplementCliFn = command ?? runSelfImplementCliCommand;
}

let goalAuthor: SelfImplementGoalAuthor = writeAuthoredGoal;
type OrchestrateFn = (options: OrchestrateSelfDevOptions & Pick<OrchestrateCliInput, 'deliverable' | 'supervise'>) => Promise<SelfDevJobResult[]>;
type RunSelfOrchestrateCliFn = (input: OrchestrateCliInput) => Promise<OrchestrateCliOutcome>;
type DecomposeFn = (feature: string, options?: Pick<SelfDevDecomposeOptions, 'arcHint' | 'observation'>) => Promise<SelfDevDecomposition>;
type FabricDecomposeFn = (feature: string, options?: FabricDecomposeRequestOptions) => Promise<FabricDecomposeRequestResult>;
type FabricDecomposeConfig = {
  enabled: boolean;
  autoPathThreshold: number | null;
};
type FabricDecomposeConfigReader = () => FabricDecomposeConfig;

function readFabricDecomposeConfig(): FabricDecomposeConfig {
  const config = getUserConfig().tools?.selfImplement;
  return {
    enabled: config?.fabricDecompose === true,
    autoPathThreshold: config?.fabricDecomposeAutoPathThreshold ?? null,
  };
}

let runSelfOrchestrateCliFn: RunSelfOrchestrateCliFn = runSelfOrchestrateCliCommand;
const centralOrchestrate: OrchestrateFn = async (options) => {
  const outcome = await runSelfOrchestrateCliFn({
    goals: options.goals,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.parentRequest === undefined ? {} : { parentRequest: options.parentRequest }),
    ...(options.deliverable === undefined ? {} : { deliverable: options.deliverable }),
    ...(options.supervise === undefined ? {} : { supervise: options.supervise }),
    runtime: {},
  });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.results;
};
let orchestrateFn: OrchestrateFn = centralOrchestrate;
let decomposeFn: DecomposeFn = decomposeSelfDevGoal;
let fabricDecomposeFn: FabricDecomposeFn = decomposeFabricRequest;
let fabricDecomposeConfigReader: FabricDecomposeConfigReader = readFabricDecomposeConfig;

function fabricResultToDecomposition(result: FabricDecomposeRequestResult): SelfDevDecomposition {
  switch (result.status) {
    case 'decomposed':
      return {
        goals: result.goals,
        decomposition: { recommendedMaxTasks: result.goals.length, actualTaskCount: result.goals.length, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: result.goals.length === 0 ? 'single-no-subtasks' : 'decomposed' },
      };
    case 'missing-research-context':
    case 'grounding-empty':
    case 'authored-empty':
      return {
        goals: [],
        decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: result.status },
      };
    case 'grounding-failed':
    case 'author-failed':
      return {
        goals: [],
        decomposition: { recommendedMaxTasks: 0, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'llm-failed', error: result.message },
      };
  }
}

export type FabricDecompositionOutcome = {
  status: FabricDecomposeRequestResult['status'];
  outcome: SelfDevDecomposition['decomposition']['outcome'];
  message?: string;
};

function fabricDecompositionOutcome(result: FabricDecomposeRequestResult): FabricDecompositionOutcome {
  const decomposition = fabricResultToDecomposition(result);
  return {
    status: result.status,
    outcome: decomposition.decomposition.outcome,
    ...(result.status === 'decomposed' ? {} : { message: result.status === 'authored-empty' ? 'fabric RFC authored no arcs' : result.message }),
  };
}

function observeFabricDecomposition(outcome: FabricDecompositionOutcome, surface: string, goals?: number): void {
  debug.log('self-implement', 'runtime.fabric-decomposition', {
    surface,
    ...outcome,
    ...(goals === undefined ? {} : { goals }),
  }, outcome.outcome === 'llm-failed' ? { level: 'warn' } : undefined);
}

function formatFabricDecompositionOutcome(outcome: FabricDecompositionOutcome): string {
  return `[self-implement] Fabric decomposition ${outcome.status} (${outcome.outcome})${outcome.message ? ` — ${outcome.message}` : ''}`;
}

// 기본 진행 정책 (이 런타임):
// MCP/ACP 호출자는 도구 응답을 기다리다 타임아웃하는 경우가 많아, 살아 있는
// 전송 싱크를 전제하지 않는다. 기존 DefaultSeamsOptions.onProgress 슬롯을
// «쓰는» 것이지 칸을 만들지 않는다.
// - 호출자 싱크(ctx.emitFeedback)가 있으면 그 슬롯으로 연결한다. 예외를 여기서
//   삼키지 않는다 — orchestrator 가 이미 try/catch 로 callbackFailed 를 세고
//   런을 계속하므로, 래퍼가 삼키면 실패가 delivered 로 위장된다.
// - 싱크가 없으면 슬롯을 비운다. no-op 을 넣으면 orchestrator 가
//   delivered>0 / unwired:0 으로 세어 실제 미전달을 성공처럼 기록한다.
//   정직한 기본값은 관측 전용(progress-delivery.unwired). 어느 쪽이든 논블로킹.
const RUNTIME_PROGRESS_END_STAGES: ReadonlySet<SelfImplementProgressStage> = new Set([
  'pr-opened', 'aborted', 'gate-failed', 'pr-declined',
]);

function resolveHarnessProgressSink(
  ctx: ToolRuntimeContext,
): SelfImplementSeams['onProgress'] {
  const emit = ctx.emitFeedback;
  if (!emit) return undefined;
  const seq = createSeqTracker();
  const sessionId = ctx.sessionId || 'self-implement';
  const blockId = `${sessionId}:self-implement:${ctx.toolCallId ?? 'run'}`;
  return (ev) => {
    const phase = ev.stage === 'start' ? 'start' : RUNTIME_PROGRESS_END_STAGES.has(ev.stage) ? 'end' : 'delta';
    emit(makeEnvelope({
      kind: 'tool.progress',
      sessionId,
      blockId,
      phase,
      payload: { stream: 'generic', lines: [ev.message] },
      asciiFallback: [`[${ev.stage}] ${ev.message}`],
      ...(ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {}),
    }, seq));
  };
}

/** 테스트 seam — 자연어 런의 골 문서 저작기를 교체한다. null = 실 writeAuthoredGoal. */
export function _setSelfImplementGoalAuthorForTesting(author: SelfImplementGoalAuthor | null): void {
  goalAuthor = author ?? writeAuthoredGoal;
}

/** 테스트 seam — 중앙 심을 거친 병렬 결과를 fake로 교체한다. null = 실 중앙 심. */
export function _setSelfImplementOrchestrateForTesting(orchestrate: OrchestrateFn | null): void {
  orchestrateFn = orchestrate ?? centralOrchestrate;
}

/** 테스트 seam — 다중 골 중앙 CLI 심을 가로챈다. null = 실 runSelfOrchestrateCliCommand. */
export function _setSelfImplementOrchestrateCliCommandForTesting(command: RunSelfOrchestrateCliFn | null): void {
  runSelfOrchestrateCliFn = command ?? runSelfOrchestrateCliCommand;
}

/** 테스트 seam — 복합 병렬 요청 분해기를 fake로 교체한다. null = 실 decomposeSelfDevGoal. */
export function _setSelfImplementDecomposeForTesting(decompose: DecomposeFn | null): void {
  decomposeFn = decompose ?? decomposeSelfDevGoal;
}

/** 테스트 seam — 명시적 Fabric 분해 경로를 fake로 교체한다. null = 실 decomposeFabricRequest. */
export function _setSelfImplementFabricDecomposeForTesting(decompose: FabricDecomposeFn | null): void {
  fabricDecomposeFn = decompose ?? decomposeFabricRequest;
}

/** 테스트 seam — 설정 snapshot을 fake로 대체한다. undefined = 실 user config. */
export function _setSelfImplementFabricDecomposeConfigReaderForTesting(reader?: FabricDecomposeConfigReader): void {
  fabricDecomposeConfigReader = reader ?? readFabricDecomposeConfig;
}

export function buildSelfImplementSpec(): LLMToolSpec {
  return {
    name: 'SelfImplement',
    description:
      'Use this tool when the user mentions the harness: forms such as "하니스로 개발", "하니스:", "하니스로 구현해줘", "하니스 구현", English "harness", or "self dev" mean the same even with Korean particles or punctuation. ' +
      'Autonomously implement a requested feature or fix end-to-end and open a DRAFT pull request for ' +
      'review. Forks the current session, creates an isolated git worktree, drives a headless elanous ' +
      'coding agent to write the code + tests, runs the integrity gate (bun test/build), and — only ' +
      'after explicit HITL approval (대표) — pushes the branch and opens a draft PR. Use when the user ' +
      'asks elanous to build/implement/fix something itself and open a PR (e.g. "이 기능 구현하고 PR 올려줘", ' +
      '"add X and open a PR", "구현해서 draft PR 올려줘"). Coding + gate are autonomous; PR-open is a ' +
      'fail-closed human gate. Long-running (minutes). Not for edits you should do inline in this session.',
    parameters: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          description: '구현할 기능/수정의 자연어 요청. 무엇을 만들지 구체적으로. 브랜치명·PR 제목의 소스.',
        },
        base: {
          type: 'string',
          description: '분기 base 브랜치(선택). 생략 시 provider 기본값(보통 main).',
        },
        draft: {
          type: 'boolean',
          description: 'draft PR 여부(선택). 기본 true(안전).',
        },
        ground: {
          type: 'boolean',
          description: '코드베이스 grounding 프리패스(선택, 기본 off). 켜면 구현 전 관련 코드를 조사해 골을 정렬.',
        },
        adversarialReview: {
          type: 'boolean',
          description: '골 저작 뒤 적대적 계획 검토 사용 여부(선택, 기본 true). false면 분해 결과를 그대로 사용해 비교 실행한다.',
        },
        documentReferences: {
          type: 'array',
          items: { type: 'string' },
          description: '구현에 참고할 저장소 내부 문서의 상대 경로(선택). feature에 이름 댄 문서는 자동으로도 감지된다.',
        },
        goals: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'decompose=true이면 순서·의존 관계를 가진 복합 사용자 원문 요청 하나를 그대로 넣는다(분해기가 서브-DAG로 나눈다). false이면 이미 분리한 독립 기능/수정 항목들을 넣는 goal 목록이며, 각 항목은 각각 격리 worktree self-implement로 실행한다.',
        },
        auto_merge: {
          type: 'boolean',
          description: '리뷰 clean 시 자동 병합(main·outward-facing). 기본 false = worktree 만(검토 후 수동 승격·안전).',
        },
        concurrency: {
          type: 'integer',
          minimum: 1,
          description: '동시 실행 잡 수(선택·기본 2, 양의 정수).',
        },
        deliverable: {
          type: 'object',
          properties: {
            document: { type: 'string' },
            attribution: { enum: ['all', 'last'] },
          },
          required: ['document', 'attribution'],
          additionalProperties: false,
          description: '연합 런의 산출물 관측 선언 문서와 호출자가 고른 귀속 범위.',
        },
        decompose: {
          type: 'boolean',
          description: 'CLI --decompose와 동일: 서로 성격이 다른 일이 순서·의존 관계를 가진 하나의 원문 요청이면, 모델이 미리 쪼개지 말고 원문 하나를 goals로 넘겨 true로 켜서 의존성·hot-path 서브-DAG로 분해한 뒤 실행한다. 사용자가 이미 나열한 서로 독립인 목록이면 각 항목을 goals 배열로 넘기고 false로 둔다. 기본 false.',
        },
        arcHint: {
          type: 'integer',
          minimum: 2,
          maximum: 6,
          description: 'decompose=true인 복합 원문을 분류할 아크 수(선택, 2~6). 아크는 이름·순서 관측 메타데이터이며 실행 단위가 아니다.',
        },
        fabric_decompose: {
          type: 'boolean',
          description: 'decompose=true일 때만 Fabric grounding/RFC 어댑터를 명시적으로 사용한다. 기본 false는 기존 분해기를 보존한다.',
        },
        target_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'decompose=true 복합 요청의 정규화된 저장소 상대 대상 파일 경로. Fabric 자동 선택은 이 목록의 고유 경로 수만 사용하며, 자연어 goals 항목을 경로로 추정하지 않는다.',
        },
        observe_only: {
          type: 'boolean',
          description: 'CLI --observe-only와 동일: 호출을 기록하고 실제 self-implement 런을 시작하지 않는다. 기본은 기존 config/flag 판정을 따른다.',
        },
        plan: {
          type: 'boolean',
          description: 'CLI --plan은 은퇴했으며 지정하면 거부된다. 단일 feature 구현은 plan 없이 호출한다; goal-loop가 기본이다.',
        },
        open_pr: {
          type: 'boolean',
          description: 'CLI --open-pr와 동일: 단일 feature 런 완료 방식을 PR 개설로 요청한다. 기본은 기존 completion resolver 기본값을 따른다.',
        },
        max_wait: {
          type: 'integer',
          minimum: 1,
          description: 'CLI --max-wait와 동일: 단일 feature 구현 goal-loop wall-clock 상한(초). 생략하면 기존 기본값을 따른다.',
        },
        supervise: {
          type: 'boolean',
          description: '단일 런이 끝나면 실패를 트리아지해 재개 가능한 작업을 스스로 다시 실행한다. 진행이 없거나 착지가 늘지 않으면 멈춘다. 기본 false.',
        },
        supervise_rounds: {
          type: 'number',
          description: 'supervise=true일 때 재개 라운드 상한(선택). 생략하면 중앙 슈퍼바이저의 기존 기본값을 사용한다.',
        },
        non_blocking: {
          type: 'boolean',
          description: 'true면 런 식별자를 즉시 반환하고 구현은 서버에서 끝까지 돈다. 생략하거나 false면 지금과 같이 완료까지 대기한다.',
        },
      },
      additionalProperties: false,
    },
  };
}

export interface SelfImplementRuntimeRequest {
  /** 구현할 기능/수정의 원문 자연어 요청. */
  feature?: string;
  /** 분기 base 브랜치(선택). */
  base?: string;
  /** draft PR 여부(선택). */
  draft?: boolean;
  /** 코드베이스 grounding 프리패스(선택). */
  ground?: boolean;
  /** 구현에 참고할 저장소 내부 문서의 상대 경로(선택). */
  documentReferences?: readonly string[];
  /** 병렬 구현할 하나 이상의 독립 기능/수정 원문. */
  goals?: readonly string[];
  /** 리뷰 clean goal의 자동 병합 여부(기본 false). */
  auto_merge?: boolean;
  /** 동시 실행 잡 수(양의 정수, 기본 2). */
  concurrency?: number;
  /** 연합 런 산출물 관측의 선언 문서와 호출자가 선택한 귀속 범위. */
  deliverable?: Omit<NonNullable<OrchestrateCliInput['deliverable']>, 'goalPath'>;
  /** 복합 원문 goals를 의존성 DAG로 분해할지 여부(기본 false). */
  decompose?: boolean;
  /** decompose=true일 때 분류할 아크 수(선택, 2~6). */
  arcHint?: number;
  /** 명시 시 Fabric grounding/RFC 어댑터로 복합 요청을 분해한다(기본 false). */
  fabric_decompose?: boolean;
  /** decompose=true 복합 요청의 정규화된 저장소 상대 대상 파일 경로. */
  target_paths?: readonly string[];
  /** 호출을 기록하고 실제 self-implement 런을 시작하지 않을지 여부(기존 config/flag 판정 유지). */
  observe_only?: boolean;
  /** 단일 feature 런에서 staged harness plan 경로를 사용할지 여부(기본 false). */
  plan?: boolean;
  /** 단일 feature 런 완료 방식을 PR 개설로 요청할지 여부(생략 시 기존 기본값). */
  open_pr?: boolean;
  /** 단일 feature 구현 goal-loop wall-clock 상한(초, 생략 시 기존 기본값). */
  max_wait?: number;
  /** 단일 실행 후 실패를 트리아지해 재개할지 여부(기본 false). */
  supervise?: boolean;
  /** supervise=true일 때 재개 라운드 상한(생략 시 중앙 기본값). */
  supervise_rounds?: number;
  /** true면 런 식별자를 즉시 반환하고 구현은 호출과 무관하게 끝까지 돈다(기본 false=완료 대기). */
  non_blocking?: boolean;
}

export type DocumentReferenceStatus = {
  path: string;
  result: ReferencedFileReadResult;
};

/**
 * 자연어에 나온 repository-relative 문서 후보를 순서대로 걷는다. 확장자나 최상위 디렉터리를
 * 제한하지 않는다. 실제 허용 여부와 텍스트 여부는 repository reader가 판정한다.
 */
export function extractDocumentReferencePaths(feature: string): string[] {
  const paths = [...feature.matchAll(/(?<![\w.-])((?:\/[\w][\w .-]*(?:\/[\w .-]+)*)|(?:\.\.\/|\.\/)[\w][\w .-]*(?:\/[\w .-]+)*|(?:[\w][\w .-]*(?:\/[\w .-]+)+)|(?:[\w][\w .-]*\.[\w]+))(?![\w.-])/g)]
    .map(match => match[1].trim());
  return [...new Set(paths)];
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`SelfImplement: \`${name}\` must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name).trim() || undefined;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`SelfImplement: \`${name}\` must be a boolean`);
  return value;
}

function parseDocumentReferences(req: SelfImplementRuntimeRequest, feature: string): string[] {
  const rawReferences = req.documentReferences;
  if (rawReferences !== undefined && (!Array.isArray(rawReferences) || rawReferences.some(value => typeof value !== 'string'))) {
    throw new Error('SelfImplement: `documentReferences` must be an array of strings');
  }
  const supplied = rawReferences?.map(value => value.trim()).filter(Boolean) ?? [];
  return [...new Set([...supplied, ...extractDocumentReferencePaths(feature)])];
}

function parseGoals(req: SelfImplementRuntimeRequest): string[] | undefined {
  if (req.goals === undefined) return undefined;
  if (!Array.isArray(req.goals) || req.goals.some(goal => typeof goal !== 'string')) {
    throw new Error('SelfImplement: `goals` must be a non-empty array of strings');
  }
  const goals = req.goals.map(goal => goal.trim());
  if (goals.length === 0 || goals.some(goal => !goal)) {
    throw new Error('SelfImplement: `goals` must be a non-empty array of strings');
  }
  return goals;
}

function formatOrchestrationResults(results: readonly SelfDevJobResult[]): string {
  const done = results.filter(result => result.status === 'done').length;
  const merged = results.filter(result => result.merged).length;
  const failed = results.filter(result => result.status === 'failed').length;
  return `[self-implement] parallel ${results.length} goal · done ${done}${merged ? ` (병합 ${merged})` : ''}${failed ? ` · 실패 ${failed}` : ''}`;
}

export function resolveDocumentReferences(paths: readonly string[], repositoryRoot = process.cwd()): DocumentReferenceStatus[] {
  const reader = createRepositoryReferencedFileReader(repositoryRoot);
  return paths.map(path => ({ path, result: reader(path) }));
}

function documentReferenceStatusLines(references: readonly DocumentReferenceStatus[]): string[] {
  return references.map(({ path, result }) => result.kind === 'ok'
    ? `📄 참조 문서: ${path}`
    : `⚠️ 참조 문서 ${path}: ${result.kind}`);
}

function formatResult(feature: string, r: SelfImplementResult, references: readonly DocumentReferenceStatus[] = []): string {
  const head = `[self-implement] ${r.stage}`;
  const lines: string[] = [head, ...documentReferenceStatusLines(references)];
  if (r.branch) lines.push(`branch: ${r.branch}`);
  if (r.worktreePath) lines.push(`worktree: ${r.worktreePath}`);
  if (r.stage === 'pr-opened' && r.prUrl) {
    lines.push(`✅ draft PR: ${r.prUrl}${r.prNumber ? ` (#${r.prNumber})` : ''}`);
  } else if (r.stage === 'pr-declined') {
    lines.push(`⛔ PR 미개설(HITL fail-closed): ${r.detail ?? ''}`);
  } else if (r.stage === 'gate-failed') {
    lines.push(`❌ gate 실패 — worktree 보존(검사용). ${r.detail ?? ''}`);
  } else if (r.stage === 'aborted') {
    lines.push(`❌ 구현 실패 — worktree 보존. ${r.detail ?? ''}`);
  }
  return lines.join('\n');
}

export interface SelfImplementRunResult {
  output: string;
  ok: boolean;
  // ⛔ 관측 전용 반환에는 **단계가 없다** — 아무 노드도 돌지 않았다. 없는 것을 있는 값으로 적으면
  //   «안 돌았다» 와 «어느 단계에서 끝났다» 가 같은 값이 된다(부재와 미지를 같은 값으로 적지 않는다).
  stage?: SelfImplementResult['stage'];
  node?: SelfImplementResult['node'];
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  worktreePath?: string;
  /** 관측 전용으로 호출만 기록했음을 나타낸다(런 미시작). */
  observed?: true;
  /** 명시적 Fabric 분해의 상태·기존 3결말·미산출 사유. */
  fabricDecomposition?: FabricDecompositionOutcome;
  /** 즉시 반환 모드에서 할당한 런 식별자. 블로킹 기본 경로에는 없어 기존 반환 모양을 보존한다. */
  runId?: string;
  /** 호출이 블로킹인지 비블로킹인지. 기본 경로에는 없어 기존 반환 모양을 보존한다. */
  invocationMode?: 'blocking' | 'non-blocking';
}

export const selfImplementRuntime: ToolRuntime<SelfImplementRuntimeRequest, SelfImplementRunResult> = {
  id: 'self_implement',
  spec: buildSelfImplementSpec(),
  async run(req, ctx: ToolRuntimeContext): Promise<SelfImplementRunResult> {
    const hasFeature = req.feature !== undefined;
    const hasGoals = req.goals !== undefined;
    if (hasFeature === hasGoals) {
      throw new Error('SelfImplement: exactly one of `feature` or `goals` is required');
    }
    const goals = parseGoals(req);
    if (goals !== undefined) {
      for (const field of ['base', 'draft', 'ground', 'documentReferences', 'observe_only', 'plan', 'open_pr', 'max_wait'] as const) {
        if (req[field] !== undefined) {
          throw new Error(`SelfImplement: \`${field}\` is only supported with \`feature\` because each parallel goal has its own execution context`);
        }
      }
    }
    const feature = hasFeature ? requireString(req.feature, 'feature').trim() : undefined;
    if (hasFeature && !feature) throw new Error('SelfImplement: `feature` is required');
    const base = optionalString(req.base, 'base');
    const draft = optionalBoolean(req.draft, 'draft') ?? true;
    const ground = optionalBoolean(req.ground, 'ground');
    const observeOnlyRequest = optionalBoolean(req.observe_only, 'observe_only');
    const plan = optionalBoolean(req.plan, 'plan') ?? false;
    const openPr = optionalBoolean(req.open_pr, 'open_pr');
    if (req.max_wait !== undefined && (typeof req.max_wait !== 'number' || !Number.isInteger(req.max_wait) || req.max_wait < 1)) {
      throw new Error('SelfImplement: `max_wait` must be a positive integer');
    }
    const maxWait = req.max_wait;
    const supervise = optionalBoolean(req.supervise, 'supervise') ?? false;
    if (req.supervise_rounds !== undefined && (typeof req.supervise_rounds !== 'number' || !Number.isInteger(req.supervise_rounds) || req.supervise_rounds < 1)) {
      throw new Error('SelfImplement: `supervise_rounds` must be a positive integer');
    }
    const superviseRounds = req.supervise_rounds;
    const nonBlocking = optionalBoolean(req.non_blocking, 'non_blocking') === true;
    const autoMerge = optionalBoolean(req.auto_merge, 'auto_merge') ?? false;
    const decompose = optionalBoolean(req.decompose, 'decompose') ?? false;
    const fabricDecompose = optionalBoolean(req.fabric_decompose, 'fabric_decompose');
    if (req.arcHint !== undefined && (typeof req.arcHint !== 'number' || !Number.isInteger(req.arcHint) || req.arcHint < 2 || req.arcHint > 6)) {
      throw new Error('SelfImplement: `arcHint` must be an integer from 2 to 6');
    }
    const arcHint = req.arcHint;
    if (req.concurrency !== undefined && (typeof req.concurrency !== 'number' || !Number.isInteger(req.concurrency) || req.concurrency < 1)) {
      throw new Error('SelfImplement: `concurrency` must be a positive integer');
    }
    const concurrency = req.concurrency;
    if (hasFeature && (req.auto_merge !== undefined || req.concurrency !== undefined || req.decompose !== undefined || req.arcHint !== undefined || req.fabric_decompose !== undefined || req.target_paths !== undefined)) {
      throw new Error('SelfImplement: `auto_merge`, `concurrency`, `decompose`, `arcHint`, `fabric_decompose`, and `target_paths` require `goals`');
    }
    if (req.target_paths !== undefined && !decompose) {
      throw new Error('SelfImplement: `target_paths` requires `decompose=true`');
    }
    const normalizedTargetPaths = decompose ? normalizeTargetPaths(req.target_paths) : undefined;
    if (decompose && goals && goals.length !== 1) {
      throw new Error('SelfImplement: `decompose=true` requires exactly one composite goal');
    }
    if (arcHint !== undefined && !decompose) {
      throw new Error('SelfImplement: `arcHint` requires `decompose=true`');
    }
    if (fabricDecompose && !decompose) {
      throw new Error('SelfImplement: `fabric_decompose` requires `decompose=true`');
    }
    const documentReferences = feature ? resolveDocumentReferences(parseDocumentReferences(req, feature)) : [];

    const forwardedSupervise = supervise ? (superviseRounds === undefined ? {} : { rounds: superviseRounds }) : undefined;
    debug.log('self-implement', 'runtime.invoke', {
      surface: ctx.surface, hasApprover: !!approverRef, ...(feature ? { feature: feature.slice(0, 120) } : {
        goals: goals!.length,
        autoMerge,
        concurrency: concurrency ?? 'default(2)',
        decompose,
        fabricDecompose,
        receivedSupervise: supervise,
        ...(superviseRounds === undefined ? {} : { receivedSuperviseRounds: superviseRounds }),
        forwardedSupervise: forwardedSupervise !== undefined,
        ...(forwardedSupervise?.rounds === undefined ? {} : { forwardedSuperviseRounds: forwardedSupervise.rounds }),
        ...(arcHint === undefined ? {} : { arcHint }),
      }),
      documentReferences: documentReferences.map(({ path, result }) => ({ path, status: result.kind })),
    });

    // ⛔⭐⭐⭐ 관측 전용 — 호출만 남기고 **런을 시작하지 않는다**(`tools.selfImplement.observeOnly`).
    //   ⚠️ 이 검사가 여기 **없어서** 코퍼스 측정이 진짜 런을 두 번 띄웠다(실측 2026-08-02).
    //   스위치는 daemon-tools 경로에만 있었고 **TUI 는 이 런타임을 탄다** — 만든 것이 닿지 않았다.
    //   ⛔ fail-closed: config 를 못 읽으면 던진다(조용히 실행 금지). 판정은 observe-only.ts 한 자리.
    const observeOnly = resolveObserveOnlyDecision(observeOnlyRequest === true
      ? { ...process.env, ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1' }
      : process.env);
    debug.log('self-implement', 'runtime.observe-only-decision', { surface: ctx.surface, observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
    if (observeOnly.enabled) {
      const requestSummary = feature ?? goals!.join(' · ');
      debug.log('self-implement', 'runtime.observed', { surface: ctx.surface, ...(feature ? { feature: feature.slice(0, 120) } : { goals: goals!.length }), observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
      return { output: `SelfImplement 관측 전용 측정 모드 — 호출이 접수되어 기록되었습니다. 이 세션에서는 구현을 진행하지 않습니다. 같은 요청을 이 턴에서 직접 구현하지 말고 응답을 마무리하세요: ${requestSummary.slice(0, 120)}${documentReferenceStatusLines(documentReferences).length ? `\n${documentReferenceStatusLines(documentReferences).join('\n')}` : ''}`, ok: true, observed: true };
    }

    const allocatedRunId = nonBlocking ? mintRunId() : undefined;
    debug.log('self-implement', 'runtime.invocation-mode', {
      surface: ctx.surface,
      mode: nonBlocking ? 'non-blocking' : 'blocking',
      ...(allocatedRunId ? { runId: allocatedRunId } : {}),
    });

    const drive = async (runId?: string): Promise<SelfImplementRunResult> => {
    if (goals) {
      let decomposition: SelfDevDecomposition | undefined;
      let fabricDecomposition: FabricDecompositionOutcome | undefined;
      if (decompose) {
        // Explicit request intent wins without reading config, matching SelfOrchestrate and CLI.
        const normalizedPathCount = normalizedTargetPaths?.length;
        const fabricDecomposeConfig = typeof fabricDecompose === 'boolean'
          ? { enabled: false, autoPathThreshold: null }
          : fabricDecomposeConfigReader();
        const selection = selectFabricDecomposer(fabricDecompose, fabricDecomposeConfig, normalizedPathCount);
        observeDecomposerSelection(
          selection.decomposer,
          selection.source,
          ctx.surface,
          normalizedPathCount,
          fabricDecomposeConfig.autoPathThreshold,
        );
        if (selection.decomposer === 'fabric') {
          const fabricResult = await fabricDecomposeFn(goals[0], { decomposeOptions: arcHint === undefined ? undefined : { arcHint } });
          fabricDecomposition = fabricDecompositionOutcome(fabricResult);
          observeFabricDecomposition(fabricDecomposition, ctx.surface, fabricResult.status === 'decomposed' ? fabricResult.goals.length : undefined);
          if (fabricResult.status !== 'decomposed') {
            return {
              output: formatFabricDecompositionOutcome(fabricDecomposition),
              ok: fabricDecomposition.outcome !== 'llm-failed',
              fabricDecomposition,
            };
          }
          decomposition = fabricResultToDecomposition(fabricResult);
        } else {
          decomposition = await decomposeFn(goals[0], {
            ...(arcHint === undefined ? {} : { arcHint }),
            observation: { goalId: undefined, runId: null },
          });
        }
      }
      const orchestrateGoals = decomposition
        ? decomposition.goals.map(goal => ({ ...goal, autoMerge }))
        : goals.map(feature => ({ feature, autoMerge }));
      let deliverable: OrchestrateCliInput['deliverable'] = req.deliverable ?? (decompose
        ? { document: goals[0], attribution: 'all' as const }
        : undefined);
      if (deliverable && parseArtifactLaunchDeclaration(deliverable.document)?.port !== undefined) {
        const authored = await goalAuthor(deliverable.document, process.cwd(), { goalTitle: 'SelfImplement deliverable' });
        deliverable = { ...deliverable, goalPath: authored.path };
      }
      const results = await orchestrateFn({
        goals: orchestrateGoals,
        // ⭐ 참고 구현(self-orchestrate-runtime.ts:375)과 «같은 문면»으로 둔다.
        //   ⚠️⛔ 정직하게 — ***이 경로에서는 goals[0] 과 «같은 값»이다.*** 바로 위 :444 가
        //     `decompose=true` 를 「골이 정확히 하나」로 강제하기 때문이다(참고 구현엔 그 가드가 «없다»).
        //   ⇒ 그러므로 이 줄은 「계보 유실을 막는 수리」가 «아니라» ***두 경로의 문면을 맞춘 것***이다.
        //     ⛔ 「두 원문 골로 단언하는 회귀」는 이 경로에서 ***원리상 쓸 수 없다*** — 가드가 먼저 거부한다.
        //     (리뷰 #10375 가 그 회귀를 요구했고, 그 요구는 이 경로의 계약과 어긋난다.)
        ...(decompose ? { parentRequest: goals.join(' ') } : {}),
        ...(concurrency ? { concurrency } : {}),
        ...(forwardedSupervise === undefined ? {} : { supervise: forwardedSupervise }),
        ...(deliverable === undefined ? {} : { deliverable }),
      });
      const failed = results.filter(result => result.status === 'failed').length;
      return {
        output: formatOrchestrationResults(results),
        ok: failed === 0,
        ...(fabricDecomposition ? { fabricDecomposition } : {}),
      };
    }
    if (!feature) throw new Error('SelfImplement: `feature` is required');

    let goalFile: string | undefined;
    let goalAuthorFailure: string | undefined;
    const proseTitle = parseAskProseTitle(feature);
    const goalTitlePassed = proseTitle !== undefined;
    try {
      goalFile = (await goalAuthor(
        feature,
        process.cwd(),
        proseTitle === undefined ? undefined : { goalTitle: proseTitle },
      )).path;
      debug.log('self-implement', 'runtime.goal-authored', { goalFile, authored: true, goalTitlePassed });
    } catch (error) {
      goalAuthorFailure = error instanceof Error ? error.message : String(error);
      debug.log('self-implement', 'runtime.goal-author-failed', { error: goalAuthorFailure, goalTitlePassed });
    }

    const withGoalAuthorFailure = (output: string): string => goalAuthorFailure
      ? `${output}\n⚠️ 골 문서 저작 실패(실행은 계속됨): ${goalAuthorFailure}`
      : output;

    const autoOpenPr = resolveAutoOpenPrDecision();
    debug.log('self-implement', 'runtime.auto-open-pr-decision', {
      surface: ctx.surface,
      autoOpenPr: autoOpenPr.enabled,
      autoOpenPrSource: autoOpenPr.source,
    });
    const approvePr: SelfImplementApprover | undefined = autoOpenPr.enabled
      ? async () => true
      : approverRef ?? undefined;
    const seams = seamsFactory({
      ...(runtimeDeps.configDir ? { configDir: runtimeDeps.configDir } : {}),
      ...(runtimeDeps.stateDir ? { stateDir: runtimeDeps.stateDir } : {}),
      ...(runtimeDeps.implementMaxWaitSec ? { implementMaxWaitSec: runtimeDeps.implementMaxWaitSec } : {}),
      ...(approvePr ? { approvePr } : {}),
      onProgress: resolveHarnessProgressSink(ctx),
      ...(ctx.surface === 'tui' && ctx.toolCallId && softStopSpaceObserver ? {
        onSoftStopSpaceReady: (spaceId: string) => {
          try { softStopSpaceObserver?.(ctx.toolCallId!, spaceId); } catch { /* UI observer cannot break harness */ }
        },
      } : {}),
    });

    const runnableDocumentReferences = documentReferences.filter(({ result }) => result.kind !== 'outside-repository');
    // ⛔⭐⭐ 승인 통로를 «중복»으로 넘기지 않는다 — 이 경로의 승인 심은 seams.approvePr «하나»다.
    //   📍 이 파일 머리말의 fail-closed 계약: "approver 가 없으면 orchestrator 가 approvePr seam
    //     없이 돌아 PR 을 절대 열지 않는다". 그 판정은 ***completion 과 무관하게 seams 로*** 난다.
    //   ⇒ 그래서 approver 를 opts/pipelineDeps 로 «따로» 넘기면 중앙 라인이 seams 를 보강해
    //     ***승인 심이 없어야 할 자리에 승인 심을 만든다***(전환 초판이 그랬고 기존 회귀가 잡았다).
    //   ⭐ opts.approver 칸(b1)은 ***seams 를 주지 않는 경로***(데몬/ACP)를 위해 열려 있다.
    const pipelineDeps: DevPipelineDeps = {
      buildSelfImplementSeams: () => seams,
    };
    const outcome = await runSelfImplementCliFn(feature, {
      ...(ctx.originSessionId ?? ctx.sessionId ? { parentSessionId: ctx.originSessionId ?? ctx.sessionId } : {}),
      ...(base ? { base } : {}),
      draft,
      ...(ground !== undefined ? { ground } : {}),
      ...(observeOnlyRequest !== undefined ? { observeOnly: observeOnlyRequest } : {}),
      ...(plan ? { plan: true } : {}),
      ...(openPr !== undefined ? { openPr } : {}),
      ...(maxWait !== undefined ? { maxWait: String(maxWait) } : {}),
      ...(supervise ? { supervise: superviseRounds === undefined ? {} : { rounds: superviseRounds } } : {}),
      naturalLanguageDispatch: true,
      ...(goalFile ? { goalFile } : {}),
      ...(runnableDocumentReferences.length ? { documentReferences: runnableDocumentReferences } : {}),
      ...(runId ? { runId } : {}),
    }, { pipelineDeps });
    if (!outcome.ok) {
      return { output: withGoalAuthorFailure(`[self-implement] failed: ${outcome.message}`), ok: false };
    }
    if (outcome.kind !== 'self') {
      return {
        output: withGoalAuthorFailure('[self-implement] observed by central CLI'),
        ok: true,
      };
    }

    const result = outcome.result;
    return {
      output: withGoalAuthorFailure(formatResult(feature, result, documentReferences)),
      ok: result.ok,
      stage: result.stage,
      node: result.node,
      ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      ...(result.prNumber ? { prNumber: result.prNumber } : {}),
      ...(result.branch ? { branch: result.branch } : {}),
      ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
    };
    };

    if (nonBlocking) {
      const runId = allocatedRunId ?? mintRunId();
      void drive(runId).then(
        (result) => {
          debug.log('self-implement', 'runtime.non-blocking-completed', {
            runId,
            ok: result.ok,
            ...(result.stage === undefined ? {} : { stage: result.stage }),
          });
        },
        (error) => {
          debug.log('self-implement', 'runtime.non-blocking-failed', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          }, { level: 'warn' });
        },
      );
      return {
        ok: true,
        runId,
        invocationMode: 'non-blocking',
        output: `[self-implement] non-blocking accepted\nrunId: ${runId}`,
      };
    }
    return drive();
  },
};
