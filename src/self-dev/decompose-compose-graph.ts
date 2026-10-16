import { inspectPipelineGraph, type PipelineGraphDefect } from '../self-implement/pipeline-shape.js';
import type { GraphNodeKind, GraphTemplate } from '../self-implement/graph-templates.js';
import { orderPiecesTopologically, type DecomposePiece } from './decompose-proposal.js';

/** ⭐ RFC §5 «5단계» — `compose` 부모 그래프.
 *
 *  RFC §4.4 는 ***"compose 그래프가 «부모»가 되고, 조각마다 자식 그래프 인스턴스를 연다"*** 라고 적었다.
 *  ⛔ 겹침→간선 파생은 «없다»(2026-10-16 제거 · 대표 10-11 «겹침이라 미루는 현상 제거») — 순서 간선은 dependsOn 만 만든다.
 *  여기서 더하는 것은 둘이다:
 *
 *  ⓐ 그 순서를 ***`GraphTemplate` 로 세워*** 2단계 위상 검사를 «그대로» 걸 수 있게 한다.
 *  ⓑ RFC 가 요구한 두 분모를 ***정적으로*** 잰다(원장 타임스탬프 대신 그래프 «경로»로).
 *
 *  ⛔⭐ 여기서 한 가지가 걸린다 — **부모 그래프는 진입점이 «여럿»이다**(의존 0 인 조각이 여러 개다).
 *    2단계 검사는 진입점 «하나»를 전제한다. ⇒ 합성 노드 둘(`compose:start`·`compose:done`)을 세워
 *    모양을 맞춘다. 그 둘은 조각이 아니므로 `kind: 'judge'`(라우터 자리)로 둔다. */
export const COMPOSE_START = 'compose:start' as const;
export const COMPOSE_DONE = 'compose:done' as const;

const KIND_BY_GOAL_TYPE: Readonly<Record<string, GraphNodeKind>> = {
  implement: 'agent', research: 'agent', document: 'agent', operate: 'agent',
};

export type ComposeGraphResult =
  | { ok: true; template: GraphTemplate; defects: readonly PipelineGraphDefect[] }
  | { ok: false; reason: 'cycle'; cycle: readonly string[] }
  | { ok: false; reason: 'no-pieces' };

/** 조각들을 부모 그래프로 세운다. ⛔ 순환이면 그래프를 «만들지 않는다» — 「못 세웠다」를 값으로 낸다. */
export function composeGraphFromPieces(pieces: readonly DecomposePiece[], graphId = 'compose'): ComposeGraphResult {
  if (pieces.length === 0) return { ok: false, reason: 'no-pieces' };
  const ordering = orderPiecesTopologically(pieces);
  if (!ordering.ordered) return { ok: false, reason: 'cycle', cycle: ordering.cycle ?? [] };

  const edges: Record<string, string[]> = { [COMPOSE_START]: [], [COMPOSE_DONE]: [] };
  for (const piece of pieces) edges[piece.id] = [];

  const ids = new Set(pieces.map((p) => p.id));
  const hasIncoming = new Set<string>();
  for (const piece of pieces) {
    for (const dep of piece.dependsOn) {
      if (!ids.has(dep) || dep === piece.id) continue;   // 매달린 의존은 파생기와 같은 판단으로 버린다
      if (!edges[dep]!.includes(piece.id)) { edges[dep]!.push(piece.id); hasIncoming.add(piece.id); }
    }
  }
  // ⛔ hotPaths 겹침 간선은 만들지 않는다(2026-10-16 제거 · 대표 10-11 «겹침이라 미루는 현상 제거»).
  //    순서는 «의미 의존 dependsOn» 만 만든다 — 겹침은 pickDecomposeProposals 가 형제 겹침으로 따로 센다.

  for (const piece of pieces) {
    if (!hasIncoming.has(piece.id)) edges[COMPOSE_START]!.push(piece.id);
    if (edges[piece.id]!.length === 0) edges[piece.id]!.push(COMPOSE_DONE);
  }

  const template: GraphTemplate = {
    graphId,
    version: '1',
    entryNode: COMPOSE_START,
    terminalNodes: [COMPOSE_DONE],
    nodes: [
      { nodeId: COMPOSE_START, kind: 'judge', maxVisits: 1 },
      ...pieces.map((p) => ({ nodeId: p.id, kind: KIND_BY_GOAL_TYPE[p.goalType ?? 'implement'] ?? 'agent', maxVisits: 1 })),
      { nodeId: COMPOSE_DONE, kind: 'judge', maxVisits: 1 },
    ],
    edges,
  };
  return { ok: true, template, defects: inspectPipelineGraph(edges, COMPOSE_START) };
}

/** RFC §5 5단계의 두 분모 — ⛔ 타임스탬프가 아니라 그래프 «경로»로 잰다.
 *  A = 겹치는 조각쌍(선언된 의존 «외» 에는 직렬이어야 «하지 않는다») · B = 겹치지 않는 쌍(하나 이상이 «나란히 갈 수» 있어야 한다).
 *  ⛔ A=0 이거나 B=0 이면 «통과가 아니라» `unmeasured` 다. */
export interface ComposeConcurrencyReport {
  readonly overlappingPairs: number;
  /** 겹치는 쌍 중 «선언된 의존 외» 이유로 그래프에서 직렬로 남은 것 — 간선이 dependsOn 뿐이므로 구조적으로 0 이다(방어 관측). */
  readonly overlappingSerialized: number;
  readonly nonOverlappingPairs: number;
  readonly nonOverlappingConcurrent: number;
  readonly verdict: 'pass' | 'fail' | 'unmeasured';
}

export function analyzeComposeConcurrency(pieces: readonly DecomposePiece[]): ComposeConcurrencyReport {
  const built = composeGraphFromPieces(pieces);
  const empty = { overlappingPairs: 0, overlappingSerialized: 0, nonOverlappingPairs: 0, nonOverlappingConcurrent: 0, verdict: 'unmeasured' as const };
  if (!built.ok) return empty;

  const reachIn = (edges: Readonly<Record<string, readonly string[]>>, from: string, to: string): boolean => {
    const seen = new Set([from]); const stack = [from];
    while (stack.length) { const at = stack.pop()!; if (at === to) return true;
      for (const next of edges[at] ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); } }
    return false;
  };

  // ⛔⭐ 「선언된 의존」으로 직렬된 쌍은 결함이 «아니다» — 분해기가 dependsOn 으로 «의미로» 정한 순서다.
  //   겹침 간선이 사라진(2026-10-16) 그래프에서 남는 직렬은 전부 선언에서 오므로,
  //   overlappingSerialized 는 «선언 외 직렬»만 센다 — 0 이 아니면 새 간선 원천이 생겼다는 방어 관측이다.
  const ids = new Set(pieces.map((p) => p.id));
  const declared: Record<string, string[]> = Object.fromEntries(pieces.map((p) => [p.id, [] as string[]]));
  for (const piece of pieces) {
    for (const dep of piece.dependsOn) {
      if (ids.has(dep) && dep !== piece.id) declared[dep]!.push(piece.id);
    }
  }

  const { edges } = built.template;
  let overlappingPairs = 0, overlappingSerialized = 0, nonOverlappingPairs = 0, nonOverlappingConcurrent = 0;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i]!, b = pieces[j]!;
      const overlaps = Boolean(a.hotPaths?.some((p) => b.hotPaths?.includes(p)));
      const serial = reachIn(edges, a.id, b.id) || reachIn(edges, b.id, a.id);
      if (overlaps) {
        overlappingPairs++;
        // ⛔ 선언된 의존으로 직렬된 겹침은 결함이 아니다 — «선언 외» 직렬만 센다.
        if (!(reachIn(declared, a.id, b.id) || reachIn(declared, b.id, a.id)) && serial) overlappingSerialized++;
        continue;
      }
      // 선언된 의존으로 이미 순서가 있는 쌍은 분모 B 에서 «뺀다» — 나란히 갈 이유가 없는 쌍이다.
      if (reachIn(declared, a.id, b.id) || reachIn(declared, b.id, a.id)) continue;
      nonOverlappingPairs++;
      if (!serial) nonOverlappingConcurrent++;
    }
  }
  return {
    overlappingPairs, overlappingSerialized, nonOverlappingPairs, nonOverlappingConcurrent,
    verdict: composeConcurrencyVerdict({ overlappingPairs, overlappingSerialized, nonOverlappingPairs, nonOverlappingConcurrent }),
  };
}

/** RFC §5 5단계 판정식 — 파생 그래프에서 fail 이 구조적으로 안 나와도 식 자체는 살아 있다. */
export function composeConcurrencyVerdict(
  counts: Pick<ComposeConcurrencyReport, 'overlappingPairs' | 'overlappingSerialized' | 'nonOverlappingPairs' | 'nonOverlappingConcurrent'>,
): ComposeConcurrencyReport['verdict'] {
  return counts.overlappingPairs === 0 || counts.nonOverlappingPairs === 0 ? 'unmeasured'
    : counts.overlappingSerialized === 0 && counts.nonOverlappingConcurrent >= 1 ? 'pass'
      : 'fail';
}
