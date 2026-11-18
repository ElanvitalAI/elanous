/**
 * 🔗 우산 — SELF-IMPLEMENT-DECOMPOSE §2 «목표 모양» · W0 0a.
 *
 * 단계 봉투 — graph unit 계약(ask·context·prior → result·evidence·exit 4)과 1:1 이다.
 *   📍 unit 계약 근거(정본은 코드):
 *     - `graphs/units/verbs/make.yaml:5-8` — `unit: { inputs: [ask, context, prior], outputs: [result, evidence], exits: [done, rework, needs-human, failed] }`
 *     - `graphs/units/verbs/make.yaml:10` — 노드 contract `outputs: [outcome, result, evidence]` · `:16-18` `on: outcome` → `map:` 레이블이 exit 로 간다
 *     - `src/self-implement/graph-yaml.ts:163-164` — `GraphTemplateSpec.unit` 꼴(inputs·outputs·exits·entries)
 *     - `src/self-implement/graph-yaml.ts:756-768` — unit 로더 검증(exits ⇔ terminal_nodes 일치)
 *
 * 1:1 대응
 *   | unit 계약 | 봉투 |
 *   |---|---|
 *   | inputs.ask | StageInput.ask |
 *   | inputs.context | StageInput.context (StageContext · 읽기 전용) |
 *   | inputs.prior | StageInput.prior (StagePrior = 읽기 전용 RunState) |
 *   | outputs.result | StageOutput.result |
 *   | outputs.evidence | StageOutput.evidence |
 *   | 노드 outputs.outcome (edge `map:` 레이블) | StageOutput.outcome |
 *   | exits[4] | StageOutput.exit (StageExit) |
 *   | (봉투만) | StageOutput.patch — 단계는 상태를 직접 고치지 않고 patch 를 돌려준다 |
 *
 * ⛔ 0a 는 «형»만 정한다. 이 파일을 부르는 생산 코드는 아직 없다(호출부 = 0b 이후).
 */
import type { PipelineNodeId } from '../pipeline-shape.js';
import type { RunState, StageContext, StatePatch } from './context.js';

export type { StatePatch } from './context.js';

/** unit `exits` 4종과 같은 문자열이다(`graphs/units/verbs/make.yaml:8`). 형만 — 런타임 상수는 소비처가 생길 때 둔다. */
export type StageExit = 'done' | 'rework' | 'needs-human' | 'failed';

/**
 * 단계가 될 수 있는 노드 = 실행 파이프라인 8노드(`pipeline-shape.ts:4-12` `PipelineNodeId`).
 *   orchestrator 가 `onNodeEntry` 12곳으로 밟는 것은 이 8개뿐이다(HARNESS-DOCS-DRIFT-1118 N9).
 *   ⛔ implement-loop.yaml 32노드 중 나머지 24(여정 19 · 앞단 3 · 저작 출구 2)는 관측 지점 — 단계로 만들지 않는다.
 */
export type StageNode = PipelineNodeId;

/** unit `inputs.prior` — 앞선 단계까지 쌓인 런 상태를 «읽기 전용»으로 본다. */
export type StagePrior = DeepReadonly<RunState>;

export interface StageInput<A> {
  readonly ask: A;
  readonly context: StageContext;
  readonly prior: StagePrior;
}

export interface StageOutput<R> {
  readonly exit: StageExit;
  /** YAML edge `map:` 레이블 — `exit` 은 그 4종 요약이다. */
  readonly outcome: string;
  readonly result: R;
  readonly evidence: Record<string, unknown>;
  readonly patch: StatePatch;
}

export type Stage<A, R> = (input: StageInput<A>) => Promise<StageOutput<R>>;

export type DeepReadonly<T> = T extends (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
