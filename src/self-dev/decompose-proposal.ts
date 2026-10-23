// ── 분해 제안을 «읽는 자» — 폐루프의 마지막 칸 (2026-08-19) ──────────────────
//
// 대표 2026-08-19: *"하니스 힐링 폐루프 완료, 북극성 미션 트리아지가 진행되어야 합니다."*
//
// ⛔⭐ **무엇이 없었나 — 「하니스가 답을 냈는데 아무도 안 읽는다」의 아홉째 판본.**
//   자식이 수렴에 실패하면 하니스가 ***「이렇게 쪼개라」를 «구조화된 값»으로 낸다***:
//     📍 self-implement/orchestrator.ts:3746
//        observe('decomposition-shadow-goals', { round, pieceCount, pieces: visiblePieces })
//        pieces = [{ id, feature, dependsOn, goalType }]
//   그런데 그 값은 ⓐ 사람이 읽는 «문자열»로 접히고(:1643) ⓑ 원장에만 남는다.
//   📏 2026-08-19 실측: 자동 재발사 경로 전수 = **0건**.
//   ⇒ 📌 ***사람이 로그를 읽고 손으로 다시 쏜다.*** 113차에 내가 그 칸을 두 번 손으로 메웠고
//     그때 낸 재발사 «둘 다» must-fix 0 으로 병합됐다 — 즉 ***제안이 옳다는 것은 이미 증명됐고,
//     없는 것은 「판단」이 아니라 「잇는 한 줄」이다.***
//
// 🔑 **왜 원장에서 읽나** — 값이 부모에게 «안 오기» 때문이다(2026-08-19 실측).
//   자식 결과가 부모로 올 때 지나는 타입(`SelfImplementDisposition`)에 그 칸이 없다.
//   같은 날 `mergeReason` 도 같은 자리에서 끊긴 것을 확인했고, 🅣 의 정정된 권고가
//   ***"손에 없으면 원장이 «유일한» 손이다"*** 였다. 이 모듈은 그 처방의 실물이다.
//   ⛔ 새 «조회 경로»를 만드는 게 아니다 — 원장은 이미 이 값을 갖고 있고 읽는 형태도 있다.
//
// ⛔⭐ **「0건」과 「못 읽었다」를 «다른 값»으로 낸다.** 원장 디렉토리가 없는 것 · 파일을 못 읽은 것 ·
//   제안이 진짜 없는 것은 처방이 전부 다르다. 하나로 접으면 다음 사람이 「제안이 없다」고 오판한다.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { runLedgerDir } from '../self-implement/run-ledger.js';
import type { SelfDevGoal, SelfDevJobResult } from './orchestrate.js';

/** 하니스가 「이렇게 쪼개라」로 낸 조각 하나. ⛔ 값의 모양은 orchestrator.ts:3725 가 canonical. */
export interface DecomposePiece {
  id: string;
  feature: string;
  dependsOn: readonly string[];
  goalType?: string;
  hotPaths?: readonly string[];
}

/** 형제 겹침 한 쌍 — 같은 hotPaths 를 만지는 조각 «둘» (a 가 배열에서 앞선 조각이다). */
export interface HotPathOverlap {
  a: string;
  b: string;
  paths: readonly string[];
}

export interface DecomposeProposal {
  /** 이 제안을 소비할 키. shardId 가 있으면 그것, 없으면 원장 런의 runId 다. */
  shardId: string;
  pieces: DecomposePiece[];
  /**
   * 형제 겹침 — 같은 파일을 만지는 조각쌍 목록. ⓑ 겹침 간선 제거(2026-10-16) 후 겹침은
   * 직렬화하지 않고 «여기» 남는다(관측 `hot-path-overlap` — 형제 맥락 주입 ②·OVERLAP-SIBLING-CTX MK 가 읽는다).
   * 겹침이 없으면 빈 배열이다 — 키를 생략하지 않는다.
   */
  hotPathOverlaps: readonly HotPathOverlap[];
  /** 몇 번째 라운드의 제안인가(늦게 난 것이 이긴다). 없으면 모른다. */
  round?: number;
}

/** 이 이벤트가 구조화된 분해 제안을 싣는다. ⛔ 이름은 orchestrator.ts 가 canonical. */
const PROPOSAL_EVENTS = new Set(['decomposition-shadow-goals', 'decomposition-shadow-late-settled']);

type Ledgerish = { event?: unknown; data?: unknown; shardId?: unknown; runId?: unknown };

// ⛔ 이 셋은 «내부» 타입이다 — 소비처가 생기기 «전»에 export 하면 speculative public surface 가 된다
//   (리뷰 지적 2026-08-21). 바깥은 SelfDevJobResult['goalPlanRevision'] 를 그대로 읽는다.
type GoalPlanRevisionObservation = NonNullable<SelfDevJobResult['goalPlanRevision']>;
type GoalPlanRevisionReadObservation = Extract<GoalPlanRevisionObservation, { status: 'read' }>;
type GoalPlanRevisionReadFailureObservation = Extract<GoalPlanRevisionObservation, { status: 'read-failed' }>;

/** 형제 겹침을 계산한다 — 같은 hotPaths 를 만지는 조각쌍(«배열 앞선 것»이 a 다). 순수 함수. */
function hotPathOverlapsOf(pieces: readonly DecomposePiece[]): HotPathOverlap[] {
  const pairs: HotPathOverlap[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i]!;
    if (!a.hotPaths?.length) continue;
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j]!;
      const paths = a.hotPaths.filter((path) => b.hotPaths?.includes(path));
      if (paths.length) pairs.push({ a: a.id, b: b.id, paths });
    }
  }
  return pairs;
}

/** 분해 제안 문서를 «읽은» 결과. ⛔ 혼합 문서를 조각 문서로 «다시 매기지» 않는다. */
export type DecomposeDocument =
  | { kind: 'pieces'; pieces: DecomposePiece[] }
  /** 단계꼴(`step`/문자열)과 조각꼴(`feature`)이 «섞인» 문서. 조용히 다시 매기지 않고 거부한다. */
  | { kind: 'rejected'; reason: 'mixed-document'; stepEntries: number; pieceEntries: number }
  /** 읽을 조각이 «하나도» 없다 — 빈 문서와 거부를 같은 값으로 접지 않는다. */
  | { kind: 'empty' };

/**
 * 분해 제안 문서(원장 `data.pieces`)를 조각 목록으로 읽는다.
 *
 * ⛔⭐ **혼합 문서를 «다시 매기지» 않는다** — 단계꼴 항목(`{ step }`·맨 문자열)은 `feature` 가 없어
 *   지금까지 «조용히» 버려졌고, 남은 조각 id 가 `String(pieces.length)` 로 **재번호**됐다.
 *   그 재번호가 `shadow → live` 선행 간선을 «매달린» 것으로 바꿔, shadow 관측 없이 live 가 나갔다.
 *   ⇒ 단계꼴이 «하나라도» 섞여 있으면 문서 전체를 거부하고 두 수를 값으로 남긴다(처방이 다르다).
 */
export function readDecomposeDocument(raw: unknown): DecomposeDocument {
  if (!Array.isArray(raw) || raw.length === 0) return { kind: 'empty' };
  const pieces: DecomposePiece[] = [];
  let stepEntries = 0;
  for (const entry of raw) {
    if (typeof entry === 'string') { stepEntries++; continue; }
    if (!entry || typeof entry !== 'object') continue;
    const piece = entry as {
      id?: unknown; feature?: unknown; dependsOn?: unknown; goalType?: unknown; hotPaths?: unknown; step?: unknown;
    };
    if (typeof piece.step === 'string' && piece.step.trim()) stepEntries++;
    if (typeof piece.feature !== 'string' || !piece.feature.trim()) continue;
    pieces.push({
      id: typeof piece.id === 'string' && piece.id ? piece.id : String(pieces.length),
      feature: piece.feature,
      dependsOn: Array.isArray(piece.dependsOn) ? piece.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      ...(typeof piece.goalType === 'string' ? { goalType: piece.goalType } : {}),
      ...(Array.isArray(piece.hotPaths) ? { hotPaths: piece.hotPaths.filter((path): path is string => typeof path === 'string') } : {}),
    });
  }
  if (pieces.length === 0) return { kind: 'empty' };
  if (stepEntries > 0) {
    return { kind: 'rejected', reason: 'mixed-document', stepEntries, pieceEntries: pieces.length };
  }
  return { kind: 'pieces', pieces };
}

/** 원장 엔트리들에서 조각별 «가장 늦은» 분해 제안을 뽑는다. 형제 겹침이 있으면 hot-path-overlap 관측을 낸다(fail-open). */
export function pickDecomposeProposals(entries: readonly Ledgerish[]): Map<string, DecomposeProposal> {
  const out = new Map<string, DecomposeProposal>();
  for (const entry of entries) {
    if (typeof entry?.event !== 'string' || !PROPOSAL_EVENTS.has(entry.event)) continue;
    const shardId = typeof entry.shardId === 'string' && entry.shardId.trim()
      ? entry.shardId
      : typeof entry.runId === 'string' && entry.runId.trim() ? entry.runId : null;
    if (!shardId) continue;   // ⛔ 어느 조각인지도 어느 런인지도 모르는 제안은 «쓸 수 없다» — 조용히 아무 데나 붙이지 않는다
    const data = entry.data as { pieces?: unknown; round?: unknown } | undefined;
    const document = readDecomposeDocument(data?.pieces);
    if (document.kind === 'empty') continue;
    // ⛔ 혼합 문서는 «뽑지 않는다» — 다시 매기면 shadow→live 선행 간선이 매달린 것이 된다.
    if (document.kind === 'rejected') {
      try {
        debug.log('self-dev.decompose', 'mixed-decompose-document', {
          shardId,
          stepEntries: document.stepEntries,
          pieceEntries: document.pieceEntries,
        });
      } catch { /* fail-open */ }
      continue;
    }
    const pieces = document.pieces;
    // ⛔ 조각이 «하나»면 분해가 아니다 — 같은 골을 이름만 바꿔 다시 거는 셈이다.
    if (pieces.length < 2) continue;
    const round = typeof data?.round === 'number' ? data.round : undefined;
    const prior = out.get(shardId);
    // 늦은 라운드가 이긴다. 라운드를 모르면 나중에 온 것이 이긴다(원장은 append-only).
    if (prior && round !== undefined && prior.round !== undefined && prior.round > round) continue;
    // ⛔ 겹침은 «버리지 않는다» — 간선을 만들지 않는 대신 형제 겹침으로 따로 세어 관측한다.
    //    형제 맥락 주입(②·OVERLAP-SIBLING-CTX MK)이 이 목록을 읽는다. 관측이 실패해도 읽기는 막지 않는다.
    const hotPathOverlaps = hotPathOverlapsOf(pieces);
    if (hotPathOverlaps.length) {
      try { debug.log('self-dev.decompose', 'hot-path-overlap', { pairs: hotPathOverlaps }); } catch { /* fail-open */ }
    }
    out.set(shardId, {
      shardId,
      pieces,
      hotPathOverlaps,
      ...(round === undefined ? {} : { round }),
    });
  }
  return out;
}

/** 조각들을 «실행 순서»로 세운 결과. ⛔ 「정렬 실패」 하나로 접지 않는다 —
 *  순환 · 매달린 참조 · 간선 0 은 처방이 전부 다르다. */
export interface DecomposePieceOrdering {
  /** 위상 정렬된 조각. ⛔ 순환이면 `undefined` 다 — 빈 배열이 «아니다»(「없다」와 「못 세웠다」를 가른다). */
  ordered?: DecomposePiece[];
  /** `dependsOn` 에서 «실제로 이어진» 간선 수. */
  dependsOnEdges: number;
  /** `hotPaths` 겹침 간선 수. ⓑ 간선 제거(2026-10-16) 후에는 «항상 0» — 옛 독자를 위해 필드는 남는다. */
  hotPathEdges: number;
  /** `dependsOn` 이 «조각 목록에 없는 id» 를 가리켜 버린 수. 0 이 아니면 분해기 산출이 어긋난 것이다. */
  danglingDependsOn: number;
  /** 순환이면 그 안에 남은 조각 id 들. ⛔ 「정렬 실패」만 내면 다음 사람이 못 고친다. */
  cycle?: string[];
}

/**
 * ⭐⭐⭐ 조각을 «위상»으로 세운다 — RUN-T82 의 집행 칸 (2026-09-06).
 *
 * 🔑 ***분해기는 위상을 «만들고» 집행 관문은 위상이 있으면 «거부»했다.***
 *   옛 관문(`dev-cli.ts`): `pieces.every(p => p.dependsOn.length === 0)` — 모든 조각이 의존 0 이어야 승격.
 *   📏 실측(2026-09-06 · `decomposition-shadow-goals` 전수): 분해 표본 13건 중 의존 0 = **0건**
 *     ⇒ 승격 가능 **0/13 = 0%**. 원장 132건 중 `attempted=true` 21건이 «전부» 실패했다.
 *
 * ⛔ 간선은 «한 축»이다 — ⓐ `dependsOn`, 분해기가 «의미»로 명시한 것만 순서를 만든다.
 *   ⓑ `hotPaths` 겹침 간선은 «제거됐다»(2026-10-16 · 대표 10-11 «겹침이라 미루는 현상 제거») —
 *   겹침은 직렬화하지 않고 `DecomposeProposal.hotPathOverlaps` 로 형제 겹침으로 따로 남는다.
 *   덕분에 ⓐ 와 배열 위치가 반대 방향을 가리켜 가짜 순환을 만들던 충돌 자체가 사라졌다.
 *
 * ⛔ 매달린 `dependsOn`(조각 목록에 없는 id)은 «버리고 센다» — 이 순서 계산기는 승격을 막지 않는다
 *   (연합 경로의 `pruneDanglingDependencies` 와 같은 판단). 승격 «입구»는 다르다 —
 *   `planShadowFirstDispatch` 가 매달린 간선을 «거부»한다(shadow 선행 간선이 사라진 채 live 가 나가는 것을 막는다).
 *
 * 순수 함수다 — 시계·파일·프로세스를 안 만진다. 동률은 «원래 순서»로 깬다(같은 입력 → 같은 출력).
 */
export function orderPiecesTopologically(pieces: readonly DecomposePiece[]): DecomposePieceOrdering {
  const indexById = new Map<string, number>();
  pieces.forEach((piece, index) => { if (!indexById.has(piece.id)) indexById.set(piece.id, index); });

  const edges: Set<number>[] = pieces.map(() => new Set<number>());
  const indegree = pieces.map(() => 0);
  let dependsOnEdges = 0;
  let danglingDependsOn = 0;

  const addEdge = (from: number, to: number): boolean => {
    if (from === to || edges[from]!.has(to)) return false;
    edges[from]!.add(to);
    indegree[to]!++;
    return true;
  };

  // ⓐ dependsOn — «먼저» 전부 건다(위 주석의 이유).
  pieces.forEach((piece, index) => {
    for (const dep of piece.dependsOn) {
      const depIndex = indexById.get(dep);
      if (depIndex === undefined) { danglingDependsOn++; continue; }
      if (depIndex === index) continue;          // 자기 참조는 간선이 아니다
      if (addEdge(depIndex, index)) dependsOnEdges++;
    }
  });

  // ⓑ hotPaths 겹침 간선은 제거됐다(2026-10-16) — 순서는 ⓐ dependsOn 만 만든다.
  //    겹침은 pickDecomposeProposals 가 hotPathOverlaps 로 따로 세고, 여기서는 간선을 만들지 않는다.

  // Kahn — ready 는 «원래 index 오름차순»으로만 꺼낸다.
  const ordered: DecomposePiece[] = [];
  const done = pieces.map(() => false);
  for (;;) {
    let next = -1;
    for (let i = 0; i < pieces.length; i++) {
      if (!done[i] && indegree[i] === 0) { next = i; break; }
    }
    if (next < 0) break;
    done[next] = true;
    ordered.push(pieces[next]!);
    for (const to of edges[next]!) indegree[to]!--;
  }

  if (ordered.length !== pieces.length) {
    return {
      dependsOnEdges,
      hotPathEdges: 0,
      danglingDependsOn,
      cycle: pieces.filter((_, i) => !done[i]).map((piece) => piece.id),
    };
  }
  return { ordered, dependsOnEdges, hotPathEdges: 0, danglingDependsOn };
}

/** shadow 조각의 id — 관측만 하는 조각. ⛔ 이름은 하니스 산출이 canonical 이다. */
export const SHADOW_PIECE_ID = 'shadow';

/** shadow-first 집행 계획의 관측 값 — 무엇이 관측이고 어디에 선행 간선이 걸렸나. */
export interface ShadowFirstPlan {
  shadowId: string;
  /** shadow 뒤에 서는 «live» 조각 id — 제안 순서 그대로다. */
  liveIds: string[];
  /** 원 제안이 잃고 있어 «되살린» shadow 선행 간선 수. 0 이면 제안이 이미 shadow-first 였다. */
  restoredEdges: number;
}

/** shadow-first 집행 판정. ⛔ 「고칠 수 없음」과 「거부」를 같은 값으로 접지 않는다. */
export type ShadowFirstDispatch =
  | { kind: 'ok'; pieces: DecomposePiece[]; shadowFirst?: ShadowFirstPlan }
  | { kind: 'rejected'; reason: 'dangling-dependsOn'; danglingIds: string[] };

/**
 * ⭐⭐⭐ shadow 관측이 live 발사보다 «앞선다» — AUTHOR-SHADOW-FIRST-SPLIT ② (#26884 수확).
 *
 * 🔑 ***실패 뒤 분해 제안에서 관측이 «사라지고» live 만 나갔다.*** shadow 조각은
 *   `dependsOn` 없이 제안에 실리고, live 조각이 그 선행 간선을 «잃은» 채 오면 위상 정렬이
 *   둘을 «동시에» 세운다 ⇒ 관측 없이 live 발사가 먼저 도착한다.
 *
 * ⛔ 판정은 «둘»로 가른다 — 접으면 다음 사람이 못 고친다:
 *   ⓐ 매달린 `dependsOn`(조각 목록에 없는 id) → `kind: 'rejected'`, 사유와 없는 id 를 값으로 남긴다.
 *     없는 조각을 선행으로 단 제안은 승격하지 않는다(`danglingDependsOn` 을 세는 것만으로는 live 발사를 못 막는다).
 *   ⓑ shadow 조각이 «둘» 이상 → `kind: 'ok'` 지만 «가드 없음» — 어느 쪽이 관측인지 모르는 제안은 고치지 않는다.
 *
 * ⭐ 선행 간선은 «실제 발사 지점»(다른 조각이 의존하지 않는 끝 조각)에만 건다 — 중간 조각은
 *   자기 선행 순서만 들고 있으면 되고, 그 것까지 shadow 에 매달면 계획이 사슬로 납작해진다.
 *   shadow 조각은 언제나 맨 앞으로 올라오고, 이미 shadow 를 선행으로 가진 조각은 건드리지 않는다.
 *
 * 순수 함수다 — 시계·파일·프로세스를 안 만진다. 입력 조각은 «변형하지 않는다».
 */
export function planShadowFirstDispatch(pieces: readonly DecomposePiece[]): ShadowFirstDispatch {
  const known = new Set(pieces.map((piece) => piece.id));
  const danglingIds: string[] = [];
  for (const piece of pieces) {
    for (const dep of piece.dependsOn) {
      if (dep === piece.id || known.has(dep) || danglingIds.includes(dep)) continue;
      danglingIds.push(dep);
    }
  }
  if (danglingIds.length) return { kind: 'rejected', reason: 'dangling-dependsOn', danglingIds };

  const shadowPieces = pieces.filter((piece) => piece.id === SHADOW_PIECE_ID);
  if (shadowPieces.length !== 1) return { kind: 'ok', pieces: [...pieces] };

  const shadow = shadowPieces[0]!;
  const rest = pieces.filter((piece) => piece !== shadow);
  const dependedUpon = new Set<string>();
  for (const piece of rest) for (const dep of piece.dependsOn) dependedUpon.add(dep);

  let restoredEdges = 0;
  const reordered = rest.map((piece) => {
    if (dependedUpon.has(piece.id) || piece.dependsOn.includes(SHADOW_PIECE_ID)) return piece;
    restoredEdges++;
    return { ...piece, dependsOn: [...piece.dependsOn, SHADOW_PIECE_ID] };
  });
  return {
    kind: 'ok',
    pieces: [shadow, ...reordered],
    shadowFirst: { shadowId: shadow.id, liveIds: rest.map((piece) => piece.id), restoredEdges },
  };
}

export interface DecomposeProposalScan {
  proposals: Map<string, DecomposeProposal>;
  goalPlanRevisions: Map<string, GoalPlanRevisionReadObservation>;
  readFailure?: GoalPlanRevisionReadFailureObservation;
  /** ⛔ 아래 셋은 「0건」을 읽기 «전»에 본다 — 처방이 각각 다르다. */
  scannedFiles: number;
  unreadableFiles: number;
  directoryMissing: boolean;
  ledgerDirectory: string;
}

const emptyGoalPlanRevision = (): GoalPlanRevisionReadObservation => ({
  status: 'read', attempted: 0, applied: 0, failureReasons: [],
});

function goalPlanRevisionFromEntry(entry: Ledgerish): GoalPlanRevisionReadObservation | undefined {
  if (entry.event !== 'rework-budget') return undefined;
  const data = entry.data as { verdict?: unknown; contractConflictRelaxation?: unknown } | undefined;
  if (data?.verdict !== 'CONTRACT-CONFLICT') return undefined;
  const relaxation = data.contractConflictRelaxation as { application?: unknown; detail?: unknown } | undefined;
  const application = relaxation?.application;
  const status = typeof application === 'string'
    ? application
    : typeof (application as { status?: unknown } | undefined)?.status === 'string'
      ? (application as { status: string }).status
      : undefined;
  if (!status) return emptyGoalPlanRevision();
  if (status === 'applied' || status === 'already-applied') {
    return { status: 'read', attempted: 1, applied: 1, failureReasons: [] };
  }
  const applicationDetail = (application as { detail?: unknown } | undefined)?.detail;
  const detail = typeof applicationDetail === 'string' && applicationDetail.trim()
    ? applicationDetail
    : typeof relaxation?.detail === 'string' && relaxation.detail.trim()
      ? relaxation.detail
      // ⛔ 사유를 «지어내지» 않는다 — 'failed' 는 상태이지 사유가 아니다(UNKNOWN-DEFAULT).
      //   원인 미상은 그 사실 자체를 이름으로 남긴다(리뷰 지적 2026-08-21).
      : 'unknown-failure-reason';
  return { status: 'read', attempted: 1, applied: 0, failureReasons: [detail] };
}

function mergeGoalPlanRevision(a: GoalPlanRevisionReadObservation, b: GoalPlanRevisionReadObservation): GoalPlanRevisionReadObservation {
  return {
    status: 'read',
    attempted: a.attempted + b.attempted,
    applied: a.applied + b.applied,
    failureReasons: [...new Set([...a.failureReasons, ...b.failureReasons])],
  };
}

/**
 * 원장 디렉토리를 훑어 관심 조각(shardIds)과 런(runIds)의 분해 제안을 모은다.
 *
 * ⛔ `shardId`가 있으면 부모 taskId로 잇고, 없는 단일 런은 원장 줄의 `runId`로만 잇는다.
 *   어느 키도 없는 제안은 계속 버린다.
 */
export function readDecomposeProposals(input: {
  shardIds: readonly string[];
  runIds?: readonly string[];
  dir?: string;
  list?: (dir: string) => string[];
  read?: (path: string) => string;
} = { shardIds: [] }): DecomposeProposalScan {
  const dir = resolve(input.dir ?? runLedgerDir());
  const list = input.list ?? ((d: string) => readdirSync(d));
  const read = input.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const wanted = new Set([...input.shardIds, ...(input.runIds ?? [])]);
  const base = {
    scannedFiles: 0, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: dir,
  };

  let fileNames: string[];
  try {
    fileNames = list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        proposals: new Map(),
        goalPlanRevisions: new Map(),
        readFailure: { status: 'read-failed', reason: 'directory-missing', scannedFiles: 0, unreadableFiles: 0, ledgerDirectory: dir },
        ...base,
        directoryMissing: true,
      };
    }
    return {
      proposals: new Map(),
      goalPlanRevisions: new Map(),
      readFailure: { status: 'read-failed', reason: 'unreadable-directory', scannedFiles: 0, unreadableFiles: 0, ledgerDirectory: dir },
      ...base,
    };
  }

  const collected: Ledgerish[] = [];
  const revisions = new Map<string, GoalPlanRevisionReadObservation>();
  let scanned = 0;
  let unreadable = 0;
  for (const name of fileNames) {
    if (!name.endsWith('.jsonl')) continue;
    scanned++;
    let text: string;
    try { text = read(join(dir, name)); } catch { unreadable++; continue; }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Ledgerish;
      try { parsed = JSON.parse(trimmed) as Ledgerish; } catch { continue; }
      // shardId가 있으면 그것으로, 없으면 runId로만 관심 대상을 판별한다.
      const key = typeof parsed?.shardId === 'string' && parsed.shardId.trim()
        ? parsed.shardId
        : typeof parsed?.runId === 'string' && parsed.runId.trim() ? parsed.runId : null;
      if (wanted.size && (!key || !wanted.has(key))) continue;
      collected.push(parsed);
      const revision = goalPlanRevisionFromEntry(parsed);
      if (revision && key) revisions.set(key, mergeGoalPlanRevision(revisions.get(key) ?? emptyGoalPlanRevision(), revision));
    }
  }
  return {
    proposals: pickDecomposeProposals(collected),
    goalPlanRevisions: revisions,
    ...(unreadable > 0 ? { readFailure: { status: 'read-failed' as const, reason: 'unreadable-files' as const, scannedFiles: scanned, unreadableFiles: unreadable, ledgerDirectory: dir } } : {}),
    ...base,
    scannedFiles: scanned,
    unreadableFiles: unreadable,
  };
}

/** 승격하지 «않은» 제안 하나 — ⛔ 조용히 원본만 두면 다음 라운드가 같은 제안을 다시 쓴다. */
export interface DecomposeRejection {
  feature: string;
  reason: 'dangling-dependsOn';
  /** 무엇이 매달렸나 — 조각 목록에 없는 선행 id 들. */
  detail: string[];
}

/** 조각 하나를 «쪼갠» 결과. ⛔ 「무엇을 무엇으로」가 값으로 남아야 다음 라운드가 중복하지 않는다. */
export interface DecomposeApplication {
  goals: SelfDevGoal[];
  /** 이번에 쪼갠 원래 goal 의 feature 들. 비면 아무것도 안 바뀌었다. */
  decomposed: string[];
  /** 거부한 제안들 — 사유와 매달린 id 를 «값»으로 남긴다. 거부가 없으면 빈 배열이다. */
  rejected: DecomposeRejection[];
}

/**
 * ⭐⭐⭐ 「쪼개서 다시 건다」의 «집행» — 단일이 연합으로 «승격»되는 자리 (2026-08-19).
 *
 * 대표 2026-08-19: 복합 미션이 단일 골로 들어와도 하니스가 스스로 쪼개야 한다.
 *   📏 지금 구조가 그쪽으로 기운다 — self_implement 는 alwaysLoad/shouldDefer=false 라 «항상 앞»이고
 *     self_orchestrate 는 shouldDefer=true 라 «찾아야» 보인다. 그래서 복합도 단일로 들어온다.
 *   ⇒ 📌 입구를 고치는 대신 ***「들어온 뒤 스스로 쪼개게」*** 한다.
 *
 * ⛔ **안전 장치 넷** — 다시 거는 것은 쉽고 «멈출 줄 아는 것»이 어렵다:
 *   ⓐ 같은 goal 을 «두 번» 쪼개지 않는다(alreadyDecomposed)
 *   ⓑ 조각이 둘 미만인 제안은 애초에 안 온다(pickDecomposeProposals 가 거른다)
 *   ⓒ 상한을 넘기면 «쪼개지 않는다» — 조각이 무한히 불어나는 것을 막는다
 *   ⓓ shadow 관측이 live 발사 «앞»에 선다(`planShadowFirstDispatch`) — 매달린 `dependsOn` 은
 *     승격하지 않고 사유와 id 를 `rejected` 로 남긴다. 관측은 조각을 내보내기 «전»에 남는다.
 *
 * ⭐ **조각은 원 골의 «대상 경로:» 머리줄을 물려받는다** (DECOMPOSE-PIECE-TARGET-LINE · 10-11 부검 run-76941fca):
 *   조각 feature 가 골을 «통째로» 갈아 끼우면 첫 줄 선언이 사라져 Pod 예비 검사가 «대상 경로 0» →
 *   재저작 NOT-GROUNDED 로 조각 전부가 exit 1 했다. 좁히는 규칙 = 원 선언 경로 중 조각 문장에
 *   나오는 것만(없으면 원 선언 전부) · «신설:» 줄도 같은 규칙 · 첫 줄이 라벨이 아니면 지금 그대로.
 */

// ── 머리줄 선언을 읽고 좁히는 순수 조각 (위 규칙의 실물) ──────────────────────────
const TARGET_PATHS_LINE = /^대상 경로:[ \t]*(.*)$/;
const NEW_PATHS_LINE = /^신설:[ \t]*(.*)$/;

/** 선언 줄의 경로를 나눈다 — « · »·쉼표(`goal-new-paths` 와 같은 분리 규칙). 유효성은 걸러내지 않는다: 선언 그대로다. */
function splitDeclaredPaths(payload: string): string[] {
  return payload.split(/[·,]/).map((token) => token.trim()).filter((token) => token.length > 0);
}

/** 조각 문장에 «나오는» 선언 경로만 남긴다. 하나도 안 나오면 원 선언 전부 — 선언 밖 경로는 지어내지 않는다. */
function narrowDeclaredPaths(declared: readonly string[], pieceFeature: string): string[] {
  const mentioned = declared.filter((path) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w./-])${escaped}(?=$|[^\\w./-]|\\.(?:\\s|$))`).test(pieceFeature);
  });
  return mentioned.length ? mentioned : [...declared];
}

export function applyDecomposeProposals(
  goals: readonly SelfDevGoal[],
  results: readonly SelfDevJobResult[],
  opts: { alreadyDecomposed?: ReadonlySet<string>; maxGoals?: number } = {},
): DecomposeApplication {
  const already = opts.alreadyDecomposed ?? new Set<string>();
  const maxGoals = opts.maxGoals ?? 24;
  // 어느 조각이 「쪼개서 다시」인가 — 판정은 트리아지가 이미 했다(classifyFailure).
  const byFeature = new Map<string, DecomposePiece[]>();
  for (const r of results) {
    const pieces = r.decomposeProposal?.pieces;
    if (!pieces || pieces.length < 2) continue;
    if (already.has(r.feature)) continue;
    byFeature.set(r.feature, pieces);
  }
  if (byFeature.size === 0) return { goals: [...goals], decomposed: [], rejected: [] };

  const out: SelfDevGoal[] = [];
  const decomposed: string[] = [];
  const rejected: DecomposeRejection[] = [];
  for (const goal of goals) {
    const pieces = byFeature.get(goal.feature);
    if (!pieces) { out.push(goal); continue; }
    // ⛔⭐ shadow-first 가드 — 매달린 선행 간선이 있는 제안은 «쪼개지 않는다»(원본을 그대로 둔다).
    const plan = planShadowFirstDispatch(pieces);
    if (plan.kind === 'rejected') {
      rejected.push({ feature: goal.feature, reason: plan.reason, detail: [...plan.danglingIds] });
      // ⛔⭐ 거부를 «로그와 값에 다» 남긴다 — 조용히 버리면 다음 라운드가 같은 제안을 다시 쓴다.
      //   혼합 문서 거부(mixed-decompose-document)와 같은 관측 채널·같은 fail-open 규율이다.
      try {
        debug.log('self-dev.decompose', 'decompose-rejected', {
          feature: goal.feature,
          reason: plan.reason,
          danglingIds: [...plan.danglingIds],
        });
      } catch { /* fail-open */ }
      out.push(goal);
      continue;
    }
    const planned = plan.pieces;
    // ⛔ 상한을 넘기면 «쪼개지 않는다» — 조용히 자르지 않고 원본을 그대로 둔다.
    if (out.length + planned.length + (goals.length - out.length - 1) > maxGoals) { out.push(goal); continue; }
    decomposed.push(goal.feature);
    // ⭐ 관측이 live 발사보다 «앞»에 남는다 — 조각을 out 에 넣기 전에 이 자리에서 찍는다.
    if (plan.shadowFirst) {
      try {
        debug.log('self-dev.decompose', 'shadow-first-dispatch', {
          feature: goal.feature,
          shadowId: plan.shadowFirst.shadowId,
          liveIds: [...plan.shadowFirst.liveIds],
          restoredEdges: plan.shadowFirst.restoredEdges,
        });
      } catch { /* fail-open */ }
    }
    // 원 골의 머리줄 선언 — 첫 줄이 «대상 경로:» 가 아니면 조각은 지금 그대로(바이트 불변)다.
    const goalLines = goal.feature.split('\n');
    const targetLine = TARGET_PATHS_LINE.exec(goalLines[0] ?? '');
    // «신설:» 상속은 머리줄 선언이 «있을 때만» — 첫 줄이 라벨이 아니면 조각은 바이트 불변이어야 한다.
    const newLine = targetLine ? goalLines.map((line) => NEW_PATHS_LINE.exec(line)).find((m) => m !== null) : null;
    for (const piece of planned) {
      const inherited: string[] = [];
      let paths: string[] = [];
      if (targetLine) {
        const declared = splitDeclaredPaths(targetLine[1]!);
        paths = declared.length ? narrowDeclaredPaths(declared, piece.feature) : declared;
        // 선언이 비어 있으면 원 줄을 그대로 실는다 — 라벨만이라도 예비 검사가 읽게 한다.
        inherited.push(declared.length ? `대상 경로: ${paths.join(' · ')}` : goalLines[0]!);
      }
      if (newLine) {
        const declaredNew = splitDeclaredPaths(newLine[1]!);
        const narrowedNew = declaredNew.length ? narrowDeclaredPaths(declaredNew, piece.feature) : declaredNew;
        inherited.push(declaredNew.length ? `신설: ${narrowedNew.join(' · ')}` : newLine[0]!);
      }
      out.push({
        ...goal,                       // 승격 플래그(openPr·autoReview·autoMerge·base)를 물려받는다
        id: piece.id,
        feature: inherited.length ? [...inherited, piece.feature].join('\n') : piece.feature,
        ...(piece.dependsOn.length ? { dependsOn: [...piece.dependsOn] } : {}),
        // ⛔⭐ `...goal` 이 «부모의» hotPaths 를 그대로 흘린다 — 그러면 조각 전부가 서로 겹쳐
        //   «가짜 형제 겹침» 관측을 낸다. 겹침 간선·직렬화는 제거됐다(2026-10-16) — hotPaths 는
        //   hot-path-overlap 관측의 원천이므로 부모 것을 물려주면 그 관측이 오염된다.
        //   ⇒ 조각 자신의 것이 있으면 그것으로 덮고, 없으면 «지운다»(부모 것을 상속하지 않는다).
        ...(piece.hotPaths?.length ? { hotPaths: [...piece.hotPaths] } : { hotPaths: undefined }),
      } as SelfDevGoal);
    }
  }
  return { goals: out, decomposed, rejected };
}
