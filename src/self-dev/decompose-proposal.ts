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

export interface DecomposeProposal {
  /** 이 제안을 소비할 키. shardId 가 있으면 그것, 없으면 원장 런의 runId 다. */
  shardId: string;
  pieces: DecomposePiece[];
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

/** 순수: 원장 엔트리들에서 조각별 «가장 늦은» 분해 제안을 뽑는다. */
export function pickDecomposeProposals(entries: readonly Ledgerish[]): Map<string, DecomposeProposal> {
  const out = new Map<string, DecomposeProposal>();
  for (const entry of entries) {
    if (typeof entry?.event !== 'string' || !PROPOSAL_EVENTS.has(entry.event)) continue;
    const shardId = typeof entry.shardId === 'string' && entry.shardId.trim()
      ? entry.shardId
      : typeof entry.runId === 'string' && entry.runId.trim() ? entry.runId : null;
    if (!shardId) continue;   // ⛔ 어느 조각인지도 어느 런인지도 모르는 제안은 «쓸 수 없다» — 조용히 아무 데나 붙이지 않는다
    const data = entry.data as { pieces?: unknown; round?: unknown } | undefined;
    const raw = Array.isArray(data?.pieces) ? data!.pieces : null;
    if (!raw?.length) continue;
    const pieces: DecomposePiece[] = [];
    for (const p of raw) {
      const piece = p as { id?: unknown; feature?: unknown; dependsOn?: unknown; goalType?: unknown; hotPaths?: unknown };
      if (typeof piece?.feature !== 'string' || !piece.feature.trim()) continue;
      pieces.push({
        id: typeof piece.id === 'string' && piece.id ? piece.id : String(pieces.length),
        feature: piece.feature,
        dependsOn: Array.isArray(piece.dependsOn) ? piece.dependsOn.filter((d): d is string => typeof d === 'string') : [],
        ...(typeof piece.goalType === 'string' ? { goalType: piece.goalType } : {}),
        ...(Array.isArray(piece.hotPaths) ? { hotPaths: piece.hotPaths.filter((path): path is string => typeof path === 'string') } : {}),
      });
    }
    // ⛔ 조각이 «하나»면 분해가 아니다 — 같은 골을 이름만 바꿔 다시 거는 셈이다.
    if (pieces.length < 2) continue;
    const round = typeof data?.round === 'number' ? data.round : undefined;
    const prior = out.get(shardId);
    // 늦은 라운드가 이긴다. 라운드를 모르면 나중에 온 것이 이긴다(원장은 append-only).
    if (prior && round !== undefined && prior.round !== undefined && prior.round > round) continue;
    out.set(shardId, { shardId, pieces, ...(round === undefined ? {} : { round }) });
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
  /** `hotPaths` 겹침에서 파생된 간선 수. ⛔ 위와 «따로» 센다 — 합치면 어느 축이 일했는지 못 본다. */
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
 * ⛔ 간선은 «두 축»이고 둘 다 「거부」가 아니라 「순서」다:
 *   ⓐ `dependsOn` — 분해기가 «의미»로 명시한 것.
 *   ⓑ `hotPaths` 겹침 — 같은 파일을 만지는 조각은 «앞선 것 먼저». 새로 만든 규칙이 아니라
 *      연합 경로 `orchestrate.ts:1105` 가 이미 쓰던 이 저장소의 «기존 결정»을 단일 경로에도 잇는 것이다.
 *
 * ⛔⭐ **두 축은 방향을 «다른 근거»로 정한다** — ⓐ 는 의미, ⓑ 는 배열 위치다.
 *   그래서 «섞어 걸면 가짜 순환»이 난다(B 가 A 에 의존하는데 B 가 배열 앞이면 A→B ⊕ B→A).
 *   ⇒ ⓐ 를 «먼저 전부» 걸고, ⓑ 는 반대 방향으로 이미 길이 있으면 «건너뛴다».
 *     건너뛰어도 안전한 이유: 길이 있다는 것은 그 둘이 «이미 직렬»이라는 뜻이고, ⓑ 의 목적이 직렬화다.
 *
 * ⛔ 매달린 `dependsOn`(조각 목록에 없는 id)은 «버리고 센다» — 그것 때문에 승격 전체를 막지 않는다
 *   (연합 경로의 `pruneDanglingDependencies` 와 같은 판단).
 *
 * 순수 함수다 — 시계·파일·프로세스를 안 만진다. 동률은 «원래 순서»로 깬다(같은 입력 → 같은 출력).
 */
export function orderPiecesTopologically(pieces: readonly DecomposePiece[]): DecomposePieceOrdering {
  const indexById = new Map<string, number>();
  pieces.forEach((piece, index) => { if (!indexById.has(piece.id)) indexById.set(piece.id, index); });

  const edges: Set<number>[] = pieces.map(() => new Set<number>());
  const indegree = pieces.map(() => 0);
  let dependsOnEdges = 0;
  let hotPathEdges = 0;
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

  /** `from` 에서 `to` 로 «이미» 갈 수 있나. 조각 상한이 24(maxGoals)라 단순 DFS 로 충분하다. */
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>([from]);
    const stack = [from];
    while (stack.length) {
      const at = stack.pop()!;
      if (at === to) return true;
      for (const next of edges[at]!) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    return false;
  };

  // ⓑ hotPaths — 반대 방향으로 이미 길이 있으면 건너뛴다(가짜 순환 방지).
  pieces.forEach((piece, index) => {
    if (!piece.hotPaths?.length) return;
    for (let earlier = 0; earlier < index; earlier++) {
      const other = pieces[earlier]!;
      if (!other.hotPaths?.some((path) => piece.hotPaths!.includes(path))) continue;
      if (reaches(index, earlier)) continue;
      if (addEdge(earlier, index)) hotPathEdges++;
    }
  });

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
      hotPathEdges,
      danglingDependsOn,
      cycle: pieces.filter((_, i) => !done[i]).map((piece) => piece.id),
    };
  }
  return { ordered, dependsOnEdges, hotPathEdges, danglingDependsOn };
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

/** 조각 하나를 «쪼갠» 결과. ⛔ 「무엇을 무엇으로」가 값으로 남아야 다음 라운드가 중복하지 않는다. */
export interface DecomposeApplication {
  goals: SelfDevGoal[];
  /** 이번에 쪼갠 원래 goal 의 feature 들. 비면 아무것도 안 바뀌었다. */
  decomposed: string[];
}

/**
 * ⭐⭐⭐ 「쪼개서 다시 건다」의 «집행» — 단일이 연합으로 «승격»되는 자리 (2026-08-19).
 *
 * 대표 2026-08-19: 복합 미션이 단일 골로 들어와도 하니스가 스스로 쪼개야 한다.
 *   📏 지금 구조가 그쪽으로 기운다 — self_implement 는 alwaysLoad/shouldDefer=false 라 «항상 앞»이고
 *     self_orchestrate 는 shouldDefer=true 라 «찾아야» 보인다. 그래서 복합도 단일로 들어온다.
 *   ⇒ 📌 입구를 고치는 대신 ***「들어온 뒤 스스로 쪼개게」*** 한다.
 *
 * ⛔ **안전 장치 셋** — 다시 거는 것은 쉽고 «멈출 줄 아는 것»이 어렵다:
 *   ⓐ 같은 goal 을 «두 번» 쪼개지 않는다(alreadyDecomposed)
 *   ⓑ 조각이 둘 미만인 제안은 애초에 안 온다(pickDecomposeProposals 가 거른다)
 *   ⓒ 상한을 넘기면 «쪼개지 않는다» — 조각이 무한히 불어나는 것을 막는다
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
  if (byFeature.size === 0) return { goals: [...goals], decomposed: [] };

  const out: SelfDevGoal[] = [];
  const decomposed: string[] = [];
  for (const goal of goals) {
    const pieces = byFeature.get(goal.feature);
    if (!pieces) { out.push(goal); continue; }
    // ⛔ 상한을 넘기면 «쪼개지 않는다» — 조용히 자르지 않고 원본을 그대로 둔다.
    if (out.length + pieces.length + (goals.length - out.length - 1) > maxGoals) { out.push(goal); continue; }
    decomposed.push(goal.feature);
    // 원 골의 머리줄 선언 — 첫 줄이 «대상 경로:» 가 아니면 조각은 지금 그대로(바이트 불변)다.
    const goalLines = goal.feature.split('\n');
    const targetLine = TARGET_PATHS_LINE.exec(goalLines[0] ?? '');
    // «신설:» 상속은 머리줄 선언이 «있을 때만» — 첫 줄이 라벨이 아니면 조각은 바이트 불변이어야 한다.
    const newLine = targetLine ? goalLines.map((line) => NEW_PATHS_LINE.exec(line)).find((m) => m !== null) : null;
    for (const piece of pieces) {
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
        //   `orchestrate.ts` 가 전부를 직렬화한다(위상이 아니라 «한 줄»이 된다).
        //   ⇒ 조각 자신의 것이 있으면 그것으로 덮고, 없으면 «지운다»(부모 것을 상속하지 않는다).
        ...(piece.hotPaths?.length ? { hotPaths: [...piece.hotPaths] } : { hotPaths: undefined }),
      } as SelfDevGoal);
    }
  }
  return { goals: out, decomposed };
}
