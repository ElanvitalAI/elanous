import { join } from 'node:path';
import { createGraphUnitResolver } from './graph-unit-resolver.js';
import { flattenGraphUnits } from './graph-unit-flatten.js';
import {
  implementLoopUnitEquivalence,
  implementLoopUnitSpec,
  stageUnitSeamsForGraph,
  type ImplementLoopUnitEquivalence,
  type ImplementStageUnitId,
  type ImplementStageUnitSeam,
} from './graph-templates.js';
import type { GraphTemplateSpec } from './graph-yaml.js';

/** 한 부품이 «실제로» 어느 파일에서 해석됐나 — 원장·관측이 「어느 판의 부품으로 걸었나」를 답한다. */
export interface ResolvedStageUnit {
  readonly stage: ImplementStageUnitId;
  readonly call: string;
  readonly unitId: string;
  readonly version: number;
  readonly path: string;
  readonly hash: string;
  readonly entry: string;
  readonly nodes: readonly string[];
  readonly exits: readonly string[];
}

/** ⛔ 「부품이 없다」와 「부품을 못 읽었다」를 가른다 — 성공이면 reason 은 undefined 다. */
export interface StageUnitResolution {
  readonly units: readonly ResolvedStageUnit[];
  readonly flattened?: GraphTemplateSpec;
  readonly equivalence?: ImplementLoopUnitEquivalence;
  readonly reason?: string;
}

/** ⭐ 하나의 NodeContext — 골·근거·되먹임·예산·체크포인트가 저작→구현으로 «같은 객체»로 흐른다. */
export interface StageNodeContext {
  readonly goal: {
    readonly goalId?: string;
    readonly goalType?: string;
    readonly graphId: string;
    readonly graphVersion: string;
  };
  readonly grounding: {
    readonly units: readonly ResolvedStageUnit[];
    readonly flattenedNodeCount: number | null;
    /** null 이면 평탄화 자체를 못 했다 — 「불변」으로 읽지 않는다(reason 이 그 자리를 덮는다). */
    readonly equivalence: ImplementLoopUnitEquivalence | null;
    /** 부품 해석은 됐지만 합성 평탄화가 실패한 원인을 보존한다. */
    readonly resolutionReason?: string;
  };
  readonly feedback: { readonly attempts?: number };
  readonly budget: { readonly unitCount: number; readonly visitBudget: number | null };
  readonly checkpoint: { readonly runId: string; readonly round?: number };
}

/** 등록 부품을 graphs/units 에서 `id@version` 으로 해석하고, 합성 선언을 평탄화해 불변식을 값으로 낸다. */
export function resolveStageUnits(
  seams: readonly ImplementStageUnitSeam[],
  graphsDir: string,
): StageUnitResolution {
  if (seams.length === 0) return { units: [] };
  // ⛔ 호출자 경로가 곧 탐색 규약이다(graph-unit-resolver: dirname(caller)/units → dirname(caller) → repo/graphs/units).
  const callerPath = join(graphsDir, 'implement-loop.yaml');
  const resolver = createGraphUnitResolver();
  const units: ResolvedStageUnit[] = [];
  try {
    for (const seam of seams) {
      const unit = resolver(seam.call, callerPath);
      // 부품 «단독» 평탄화 — unit 계약(entries·exits·terminal_nodes)이 그 자리에서 성립하는지 검증한다.
      flattenGraphUnits(unit.template, unit.path, resolver);
      units.push({
        stage: seam.stage,
        call: seam.call,
        unitId: unit.template.graphId,
        version: unit.template.version,
        path: unit.path,
        hash: unit.hash,
        entry: seam.entry,
        nodes: seam.nodes,
        exits: unit.template.unit?.exits ?? [],
      });
    }
    const flattened = flattenGraphUnits(
      implementLoopUnitSpec(),
      join(graphsDir, 'self-implement-units.yaml'),
      resolver,
    );
    return { units, flattened, equivalence: implementLoopUnitEquivalence(flattened) };
  } catch (error) {
    return { units, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildStageNodeContext(input: {
  readonly resolution: StageUnitResolution;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly runId: string;
  readonly attempts?: number;
  readonly round?: number;
  readonly goalId?: string;
  readonly goalType?: string;
}): StageNodeContext {
  const { resolution } = input;
  const visitBudget = resolution.flattened === undefined
    ? null
    : resolution.flattened.nodes.reduce((total, node) => total + node.maxVisits, 0);
  return {
    goal: {
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      ...(input.goalType === undefined ? {} : { goalType: input.goalType }),
      graphId: input.graphId,
      graphVersion: input.graphVersion,
    },
    grounding: {
      units: resolution.units,
      flattenedNodeCount: resolution.flattened?.nodes.length ?? null,
      equivalence: resolution.equivalence ?? null,
      ...(resolution.reason === undefined ? {} : { resolutionReason: resolution.reason }),
    },
    feedback: input.attempts === undefined ? {} : { attempts: input.attempts },
    budget: { unitCount: resolution.units.length, visitBudget },
    checkpoint: { runId: input.runId, ...(input.round === undefined ? {} : { round: input.round }) },
  };
}

/** 원장 관측 payload — ⛔ 큰 구조(평탄화 그래프 전체)를 싣지 않고 «판정에 쓰는 값»만 싣는다. */
export function stageNodeContextObservation(context: StageNodeContext): Record<string, unknown> {
  const equivalence = context.grounding.equivalence;
  return {
    graphId: context.goal.graphId,
    graphVersion: context.goal.graphVersion,
    runId: context.checkpoint.runId,
    ...(context.checkpoint.round === undefined ? {} : { round: context.checkpoint.round }),
    ...(context.grounding.resolutionReason === undefined ? {} : { resolutionReason: context.grounding.resolutionReason }),
    units: context.grounding.units.map((unit) => ({
      stage: unit.stage, call: unit.call, unitId: unit.unitId, version: unit.version, hash: unit.hash,
      entry: unit.entry, nodes: unit.nodes, exits: unit.exits,
    })),
    flattenedNodeCount: context.grounding.flattenedNodeCount,
    kindMismatches: equivalence?.kindMismatches.length ?? null,
    missingEdges: equivalence?.missingEdges.length ?? null,
    extraEdges: equivalence?.extraEdges.length ?? null,
    visitBudget: context.budget.visitBudget,
  };
}

/** 라운드마다 같은 부품이 «여전히» 그 파일·그 판인가 — 파일이 도는 중에 바뀌면 걸음이 신원과 갈린다. */
export function stageUnitDrift(
  units: readonly ResolvedStageUnit[],
  graphsDir: string,
): { readonly missing: readonly string[]; readonly changed: readonly string[] } {
  if (units.length === 0) return { missing: [], changed: [] };
  const callerPath = join(graphsDir, 'implement-loop.yaml');
  const resolver = createGraphUnitResolver();
  const missing: string[] = [];
  const changed: string[] = [];
  for (const unit of units) {
    try {
      const current = resolver(unit.call, callerPath);
      if (current.hash !== unit.hash) changed.push(unit.call);
    } catch {
      missing.push(unit.call);
    }
  }
  return { missing, changed };
}

/** 그래프의 단계 부품을 «생산 진입점 문장» 하나로 — orchestrator 가 이 함수를 부른다. */
export function resolveGraphStageUnits(graphId: string, graphsDir: string): StageUnitResolution {
  return resolveStageUnits(stageUnitSeamsForGraph(graphId), graphsDir);
}
