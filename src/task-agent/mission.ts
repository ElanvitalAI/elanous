/**
 * TASK-AGENT-MISSION ① — `elanous tasks hand --mission "<칸 문면>"`: 미션을 조각 카드 ⊕ 선후 간선으로 쪼개 적고,
 * 선행이 없는 조각만 기존 `handTask` 로 넘긴다(기본 shadow · `--live` 면 발사).
 *
 * - 쪼개기: 문면이 이미 조각을 줄로 나열하면(`- …` · `① …` · `1. …` + `after: 1, ②` 힌트) LLM 없이 결정론으로.
 *   아니면 기존 분해기 `decomposeSelfDevGoal`(self orchestrate --decompose 와 같은 것)을 주입 가능한 자리로 부른다.
 * - 저장: 과제 카드와 «같은» 상태 파일(`taskAgentStatePath()`) — 미션 카드(`pieces`) ⊕ 조각 카드(`mission`·`after`).
 * - ② `elanous tasks advance`: 조각의 착지 근거(카드의 PR 번호·골 id → PR 병합)로 착지를 가르고(`landedPieces`),
 *   새로 준비된 조각만 같은 `handTask` 로 «한 번» 넘긴다 · 모두 착지하면 미션 카드에 green «제안»만 적는다.
 * - 관측: `debug.log('task-agent', 'mission-split' | 'mission-piece' | 'mission-advance' | 'mission-piece-handed' | 'mission-green-proposed', …)`.
 */
import { randomBytes } from 'node:crypto';
import { debug } from '../debug/log.js';
import type { SelfDevDecomposition } from '../self-dev/decompose.js';
import { refreshCardRunBinding, type CardRunEvidenceDeps } from './card-evidence.js';
import {
  cardPrNumber,
  handTask,
  nextMoveFor,
  readTaskAgentState,
  readTaskCard,
  TaskCardSupersededError,
  TASK_CARD_PREFIX,
  TASK_SEATS,
  taskAgentStatePath,
  updateTaskCard,
  writeTaskCards,
  type TaskCard,
  type TaskCardMove,
  type TaskLauncher,
  type TaskSeat,
} from './task-hand.js';

/** 쪼갠 조각 — `after` 는 같은 목록 안의 0-기반 위치. */
export interface MissionPieceDraft { text: string; after: number[] }
export interface MissionSplit { pieces: MissionPieceDraft[]; source: string }

/** 주입 가능한 분해기 — 기본은 `decomposeSelfDevGoal`(LLM). 시험은 가짜를 준다. */
export type MissionDecompose = (text: string) => Promise<SelfDevDecomposition>;

const CIRCLED_FIRST = 0x2460; // ①
const CIRCLED_LAST = 0x2473; // ⑳
const ITEM = /^(\s*)(?:([-*•])|([①-⑳])|(\d{1,3})[.)])\s+(.*)$/u;
const AFTER_HINT = /\s*[([]?\s*(?:after|선행)\s*[:：]\s*([^)\]]*?)\s*[)\]]?\s*$/iu;
const EMPTY_ITEM = /^\s*(?:[-*•]|[\u2460-\u2473]|\d{1,3}[.)])\s*$/u;
const AFTER_LINE = /^\s*(?:after|선행)\s*[:：]\s*(.*?)\s*$/iu;

function circledNumber(ch: string): number | null {
  const code = ch.codePointAt(0) ?? 0;
  return code >= CIRCLED_FIRST && code <= CIRCLED_LAST ? code - CIRCLED_FIRST + 1 : null;
}

function refLabel(raw: string): string | null {
  const ref = raw.trim().replace(/^#/, '');
  if (!ref) return null;
  if (/^\d{1,3}$/.test(ref)) return String(Number(ref));
  const circled = [...ref].length === 1 ? circledNumber(ref) : null;
  return circled === null ? ref : String(circled);
}

/** 문면이 이미 조각을 나열했을 때의 결정론 분해 — 조각이 2장 미만이면 null(분해기로 간다). */
export function parseListedMission(text: string): MissionSplit | null {
  interface Item { label: string; lines: string[]; afterRefs: string[] }
  const items: Item[] = [];
  let baseIndent = 0; // 첫 조각의 들여쓰기 — 같은 수준(±1칸)만 조각, 더 깊으면 그 조각의 하위 줄
  for (const line of text.split(/\r?\n/)) {
    if (EMPTY_ITEM.test(line)) throw new Error(`빈 조각 표식이 있다: «${line.trim()}»`);
    const item = line.match(ITEM);
    if (item && items.length === 0) baseIndent = item[1]!.length;
    if (item && (items.length === 0 || item[1]!.length <= baseIndent + 1)) {
      const marker = item[3] ? String(circledNumber(item[3])) : item[4] ? String(Number(item[4])) : String(items.length + 1);
      let body = item[5]!;
      const afterRefs: string[] = [];
      const hint = body.match(AFTER_HINT);
      if (hint) { afterRefs.push(...hint[1]!.split(/[,\s]+/).filter(Boolean)); body = body.slice(0, hint.index).trimEnd(); }
      items.push({ label: marker, lines: [body], afterRefs });
      continue;
    }
    const current = items.at(-1);
    if (!current) continue; // 머리말 — 미션 카드 원문에 남는다
    const afterLine = line.match(AFTER_LINE);
    if (afterLine) { current.afterRefs.push(...afterLine[1]!.split(/[,\s]+/).filter(Boolean)); continue; }
    if (line.trim()) current.lines.push(line.trim());
  }
  if (items.length < 2) return null;
  const byLabel = new Map<string, number>();
  items.forEach((item, index) => {
    if (byLabel.has(item.label)) throw new Error(`조각 번호가 겹친다: ${item.label}`);
    byLabel.set(item.label, index);
  });
  const pieces = items.map((item, index) => {
    const after = item.afterRefs.map((raw) => {
      const label = refLabel(raw);
      const target = label === null ? undefined : byLabel.get(label);
      if (target === undefined) throw new Error(`조각 ${item.label} 의 after 가 없는 조각을 가리킨다: ${raw}`);
      if (target === index) throw new Error(`조각 ${item.label} 이 자기 자신 뒤에 올 수 없다`);
      return target;
    });
    return { text: item.lines.join('\n').trim(), after: [...new Set(after)] };
  });
  if (pieces.some((piece) => !piece.text)) throw new Error('빈 조각이 있다');
  return { pieces, source: 'listed' };
}

/** 분해기 결과(`SelfDevGoal[]`)를 조각으로 — dependsOn 의 id 를 위치로 바꾼다. 없는 id·자기 참조는 버리지 않고 멈춘다. */
export function piecesFromDecomposition(result: SelfDevDecomposition): MissionSplit {
  const ids = result.goals.map((goal, index) => goal.id ?? String(index));
  if (new Set(ids).size !== ids.length) throw new Error(`분해기 조각 id 가 겹친다: ${ids.join(', ')}`);
  const pieces = result.goals.map((goal, index) => ({
    text: (goal.feature ?? '').trim(),
    after: [...new Set((goal.dependsOn ?? []).map((id) => {
      const at = ids.indexOf(id);
      if (at < 0) throw new Error(`분해기 조각 ${ids[index]} 의 dependsOn 이 없는 조각을 가리킨다: ${id}`);
      if (at === index) throw new Error(`분해기 조각 ${ids[index]} 이 자기 자신 뒤에 올 수 없다`);
      return at;
    }))],
  }));
  return { pieces, source: `decompose:${result.decomposition.outcome}` };
}

/** 선후에 고리가 있으면 던진다 — 고리 속 조각은 영영 발사되지 않는다. */
export function assertAcyclic(pieces: readonly MissionPieceDraft[]): void {
  const state = new Array<0 | 1 | 2>(pieces.length).fill(0);
  const visit = (at: number): void => {
    if (state[at] === 2) return;
    if (state[at] === 1) throw new Error(`조각 선후에 고리가 있다 (조각 ${at + 1})`);
    state[at] = 1;
    for (const before of pieces[at]!.after) visit(before);
    state[at] = 2;
  };
  pieces.forEach((_piece, at) => visit(at));
}

export async function defaultMissionDecompose(text: string): Promise<SelfDevDecomposition> {
  const { decomposeSelfDevGoal } = await import('../self-dev/decompose.js');
  return decomposeSelfDevGoal(text, { observation: { category: 'task-agent', event: 'mission-decompose' } });
}

export async function splitMission(text: string, decompose: MissionDecompose = defaultMissionDecompose): Promise<MissionSplit> {
  const split = parseListedMission(text) ?? piecesFromDecomposition(await decompose(text));
  if (split.pieces.length === 0) throw new Error('미션을 조각으로 쪼개지 못했다');
  const empty = split.pieces.findIndex((piece) => !piece.text.trim());
  if (empty >= 0) throw new Error(`조각 ${empty + 1} 의 문면이 비어 있다 (${split.source})`);
  assertAcyclic(split.pieces);
  return split;
}

/**
 * ② 의 자리(순수): 아직 착지하지 않았고 선행이 모두 착지한 조각 id.
 * `landed` 는 착지한 조각 id 집합 — 감지(PR 병합 등)는 이 함수 밖의 몫이다.
 */
export function readyPieces(pieces: readonly Pick<TaskCard, 'id' | 'after'>[], landed: ReadonlySet<string>): string[] {
  return pieces.filter((piece) => !landed.has(piece.id) && (piece.after ?? []).every((id) => landed.has(id))).map((piece) => piece.id);
}

/** 모든 조각이 착지했나 — 미션 칸 green 제안의 조건(② 이후에 쓴다). */
export function missionLanded(mission: Pick<TaskCard, 'pieces'>, landed: ReadonlySet<string>): boolean {
  return (mission.pieces ?? []).length > 0 && (mission.pieces ?? []).every((id) => landed.has(id));
}

export interface HandMissionOptions {
  text: string;
  seat?: TaskSeat;
  checklistId?: string;
  live?: boolean;
  statePath?: string;
  launcher?: TaskLauncher;
  decompose?: MissionDecompose;
  now?: () => Date;
  id?: string;
}

export interface MissionPieceResult { card: TaskCard; move: TaskCardMove; launched: boolean; error?: string }
export interface HandMissionResult {
  mission: TaskCard;
  pieces: MissionPieceResult[];
  edges: Array<[string, string]>;
  source: string;
  mode: 'shadow' | 'live';
}

export async function handMission(opts: HandMissionOptions): Promise<HandMissionResult> {
  const text = opts.text.trim();
  if (!text) throw new Error('미션 문면이 비어 있다');
  if (opts.seat !== undefined && !TASK_SEATS.includes(opts.seat)) throw new Error(`자리는 ${TASK_SEATS.join('|')} 중 하나다: ${opts.seat}`);
  const split = await splitMission(text, opts.decompose);
  const now = (opts.now ?? (() => new Date()))();
  const missionId = opts.id ?? `${TASK_CARD_PREFIX}${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
  const mode = opts.live ? 'live' : 'shadow';
  const path = opts.statePath ?? taskAgentStatePath();
  const pieceIds = split.pieces.map((_piece, index) => `${missionId}-${index + 1}`);
  const common = { ...(opts.seat ? { seat: opts.seat } : {}), ...(opts.checklistId ? { checklistId: opts.checklistId } : {}) };
  const mission: TaskCard = { id: missionId, text, ...common, createdAt: now.toISOString(), status: 'handed', history: [], pieces: pieceIds, splitSource: split.source };
  const drafts: TaskCard[] = split.pieces.map((piece, index) => ({
    id: pieceIds[index]!, text: piece.text, ...common, createdAt: now.toISOString(), status: 'handed', history: [],
    mission: missionId, after: piece.after.map((at) => pieceIds[at]!),
  }));
  const edges = drafts.flatMap((card) => (card.after ?? []).map((before) => [before, card.id] as [string, string]));
  // 미션 ⊕ 조각을 한 잠금 안에서 먼저 적는다 — 발사 도중 실패해도 선후 기록은 남는다.
  writeTaskCards(path, [mission, ...drafts]);
  try { debug.log('task-agent', 'mission-split', { missionId, pieces: drafts.length, edges: edges.map(([a, b]) => `${a}->${b}`), source: split.source, seat: opts.seat ?? null, checklistId: opts.checklistId ?? null, mode }); } catch { /* fail-soft */ }
  // 방금 만든 조각이다 — 착지한 것이 «없음»을 안다(모름이 아니다).
  const landedNone: ReadonlySet<string> = new Set();
  const ready = new Set(readyPieces(drafts, landedNone));
  const results: MissionPieceResult[] = [];
  for (const draft of drafts) {
    let result: MissionPieceResult;
    if (!ready.has(draft.id)) {
      result = { card: draft, move: nextMoveFor(draft, landedNone), launched: false };
    } else {
      try {
        const handed = await handTask({
          text: draft.text, id: draft.id, mission: missionId, after: draft.after ?? [],
          ...(opts.seat ? { seat: opts.seat } : {}), ...(opts.checklistId ? { checklistId: opts.checklistId } : {}),
          live: opts.live === true, statePath: path, ...(opts.launcher ? { launcher: opts.launcher } : {}), ...(opts.now ? { now: opts.now } : {}),
        });
        result = { card: handed.card, move: handed.move, launched: handed.launched };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const card = readTaskCard(draft.id, path) ?? draft; // launch-failed 면 handTask 가 이미 적었다
        result = { card, move: nextMoveFor(card, landedNone), launched: false, error: reason };
      }
    }
    results.push(result);
    try { debug.log('task-agent', 'mission-piece', { missionId, pieceId: draft.id, after: draft.after ?? [], ready: ready.has(draft.id), move: result.move.kind, reason: result.move.reason, launched: result.launched, mode, ...(result.error ? { error: result.error } : {}) }); } catch { /* fail-soft */ }
  }
  return { mission, pieces: results, edges, source: split.source, mode };
}


/**
 * ② 착지 근거 — 조각 하나의 PR 상태. `merged` 만 착지다.
 * pending = 열림·못 읽음·원장에 PR 없음 · closed = 병합 없이 닫힘 · no-ref = 카드에 PR 번호도 골 id 도 없다.
 */
export type PieceEvidence = 'merged' | 'pending' | 'closed' | 'no-ref';

/** ② 의 판정(순수): 근거가 `merged` 인 조각만 착지다 — 모름(근거 없음·no-ref·pending)은 «미착지»(착지를 추측하지 않는다). */
export function landedPieces(mission: Pick<TaskCard, 'pieces'>, evidence: Readonly<Record<string, PieceEvidence | undefined>>): Set<string> {
  return new Set((mission.pieces ?? []).filter((id) => evidence[id] === 'merged'));
}

/** 조각 근거 하나를 읽는 자리(시험 주입) — 기본은 `predecessorState`(PR 번호 → gh · 골 id → 런 원장 `pr-opened` → gh). */
export type PieceEvidenceReader = (ref: number | string) => Promise<'merged' | 'waiting' | 'blocked'>;

async function defaultEvidenceReader(ref: number | string): Promise<'merged' | 'waiting' | 'blocked'> {
  const { predecessorState } = await import('../pod-lease/dependency-state.js');
  return predecessorState(ref);
}

/**
 * 조각의 착지 근거 하나 — PR 번호 › 골 id. 수동(`--pr`/`--goal`)이든 런 원장 묶기든 같은 칸이다(TA-CARD-RUN-LINK) —
 * 수동이 적히면 `refSource: 'manual'` 이라 묶기가 다시 채우지 않는다(수동이 덮는다).
 */
export function pieceRef(piece: Pick<TaskCard, 'pr' | 'goalId'>): number | string | undefined {
  return cardPrNumber(piece) ?? piece.goalId;
}

/** 조각 카드마다 근거를 모은다 — `pieceRef` 순. 읽기 실패는 pending(미착지). */
export async function collectPieceEvidence(pieces: readonly TaskCard[], read: PieceEvidenceReader = defaultEvidenceReader): Promise<Record<string, PieceEvidence>> {
  const out: Record<string, PieceEvidence> = {};
  for (const piece of pieces) {
    const ref = pieceRef(piece);
    if (ref === undefined) { out[piece.id] = 'no-ref'; continue; }
    let state: 'merged' | 'waiting' | 'blocked';
    try { state = await read(ref); } catch { state = 'waiting'; }
    out[piece.id] = state === 'merged' ? 'merged' : state === 'blocked' ? 'closed' : 'pending';
  }
  return out;
}

const GOAL_ID = /^[a-f0-9]{16}$/;

/** `--pr <조각>=<N>` · `--goal <조각>=<골id>` — 조각 카드에 착지 근거를 잠금 안에서 적는다(미션 조각만 · 근거는 하나 · 새 것이 교체). */
export function recordPieceRef(pieceId: string, ref: { pr?: number; goalId?: string }, statePath = taskAgentStatePath(), expectedMission?: string): TaskCard {
  if ((ref.pr === undefined) === (ref.goalId === undefined)) throw new Error('근거는 PR 번호 «또는» 골 id 하나다');
  if (ref.pr !== undefined && !(Number.isSafeInteger(ref.pr) && ref.pr > 0)) throw new Error(`PR 번호가 아니다: ${ref.pr}`);
  if (ref.goalId !== undefined && !GOAL_ID.test(ref.goalId)) throw new Error(`골 id 는 16자 hex 다: ${ref.goalId}`);
  const refused: { reason?: string } = {};
  const card = updateTaskCard(statePath, pieceId, (current, tasks) => {
    if (!current?.mission) { refused.reason = `미션 조각 카드가 아니다: ${pieceId}`; return undefined; }
    // 미션을 지정했으면 그 미션(실재하는 미션 카드)의 조각에만 적는다 — 미션 A 호출이 미션 B 근거를 바꾸지 않게.
    if (expectedMission !== undefined && (current.mission !== expectedMission || !tasks[expectedMission]?.pieces?.includes(pieceId))) {
      refused.reason = `조각 ${pieceId} 은 미션 ${expectedMission} 의 조각이 아니다`; return undefined;
    }
    // green 제안 뒤 근거를 바꾸면 제안이 바뀐 근거와 어긋난다 — 제안된 미션의 조각 근거는 잠근다.
    if (tasks[current.mission]?.greenProposal) { refused.reason = `미션 ${current.mission} 은 이미 green 제안됐다 — 근거를 바꾸지 않는다`; return undefined; }
    // 근거는 하나만 — 새 근거가 옛 근거를 «교체»한다(정정한 골 id 뒤에 옛 PR 이 남아 우선되지 않게).
    // 런 묶기가 적은 자식 런도 함께 지운다 — 수동 근거를 옛 Pod 자식 런의 결과처럼 보이지 않게.
    const { pr: _oldPr, goalId: _oldGoal, runChildId: _oldChild, ...rest } = current;
    return { ...rest, ...(ref.pr !== undefined ? { pr: ref.pr } : { goalId: ref.goalId! }), refSource: 'manual' as const };
  });
  if (refused.reason || !card) throw new Error(refused.reason ?? `미션 조각 카드가 아니다: ${pieceId}`);
  try { debug.log('task-agent', 'mission-piece-ref', { pieceId, missionId: card.mission ?? null, pr: ref.pr ?? null, goalId: ref.goalId ?? null }); } catch { /* fail-soft */ }
  return card;
}

/** 이미 넘긴 조각인가 — live 는 live 넘김·발사·발사 실패면 다시 안 넘긴다 · shadow 는 어떤 넘김이든 있으면 안 넘긴다. */
function alreadyHanded(card: TaskCard, mode: 'shadow' | 'live'): boolean {
  if (card.status === 'launched' || card.status === 'launch-failed' || card.status === 'failed') return true;
  if (!card.handed) return false;
  return mode === 'shadow' || card.handed.mode === 'live';
}

export interface AdvanceMissionOptions {
  live?: boolean;
  statePath?: string;
  launcher?: TaskLauncher;
  readEvidence?: PieceEvidenceReader;
  /** 런 id 가 있는 조각의 런 근거(PR·골 id) 읽기(시험 주입) — `false` 면 묶지 않는다. */
  runEvidence?: CardRunEvidenceDeps | false;
  now?: () => Date;
}

export interface AdvancedPiece { pieceId: string; launched: boolean; move: TaskCardMove['kind']; error?: string }
export interface AdvanceMissionResult {
  missionId: string;
  mode: 'shadow' | 'live';
  evidence: Record<string, PieceEvidence>;
  landed: string[];
  ready: string[];
  handed: AdvancedPiece[];
  /** 준비됐지만 이미 넘겨서 건너뛴 조각(선행 없는 첫 조각 포함). */
  skipped: string[];
  green: 'proposed' | 'already-proposed' | 'not-yet';
}

/**
 * ② 한 걸음: 근거 → 착지 → 준비된 조각 → 새로 준비된 조각만 `handTask` 로 한 번 → 모두 착지면 green 제안.
 * 넘김은 같은 상태 파일 잠금 안에서 «먼저» 표지를 적고(claim) 넘긴다 — 동시에 두 번 불러도 한 번만 넘긴다.
 * 선행이 없는 조각은 `tasks hand --mission` 이 이미 넘겼다 — ② 는 다시 넘기지 않는다.
 */
export async function advanceMission(missionId: string, opts: AdvanceMissionOptions = {}): Promise<AdvanceMissionResult> {
  const started = Date.now();
  try {
    const result = await advanceMissionOnce(missionId, opts);
    try { debug.log('task-agent', 'mission-advance', { missionId, mode: result.mode, landed: result.landed, ready: result.ready, handed: result.handed.map((piece) => piece.pieceId), skipped: result.skipped, green: result.green, evidence: result.evidence, ms: Date.now() - started }); } catch { /* fail-soft */ }
    return result;
  } catch (error) {
    // 실패한 호출도 한 줄 — 관측이 «호출마다» 남는다.
    const reason = error instanceof Error ? error.message : String(error);
    try { debug.log('task-agent', 'mission-advance', { missionId, mode: opts.live ? 'live' : 'shadow', error: reason, ms: Date.now() - started }); } catch { /* fail-soft */ }
    throw new MissionAdvanceError(reason);
  }
}

/** `advanceMission` 이 실패했다 — `mission-advance` 관측은 이미 남겼다. */
export class MissionAdvanceError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MissionAdvanceError';
  }
}

async function advanceMissionOnce(missionId: string, opts: AdvanceMissionOptions): Promise<AdvanceMissionResult> {
  const path = opts.statePath ?? taskAgentStatePath();
  const mode = opts.live ? 'live' : 'shadow';
  const clock = opts.now ?? (() => new Date());
  // live 인데 발사기가 없으면 claim 을 적기 «전»에 멈춘다 — live 표지가 발사 없이 남아 영영 안 넘겨지지 않게.
  if (mode === 'live' && !opts.launcher) throw new Error('--live 인데 launcher 가 없다');
  const before = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(path).tasks ?? {};
  if (!before[missionId]?.pieces) throw new Error(`미션 카드가 아니다: ${missionId}`);
  // 런 id 가 있고 PR·골 id 중 빈 칸이 있는 조각 — 원장에서 묶어 둔다(제안 끝난 미션은 건드리지 않는다 · 실패는 근거 없음).
  if (opts.runEvidence !== false && !before[missionId]!.greenProposal) {
    for (const id of before[missionId]!.pieces!) {
      const piece = before[id];
      if (!piece?.runId || piece.refSource === 'manual' || (piece.pr !== undefined && piece.goalId !== undefined)) continue;
      try { await refreshCardRunBinding(id, path, opts.runEvidence ?? {}); } catch (error) {
        // 근거 없음으로 본다(미착지) — 원장 부재와 갈리게 실패는 남긴다.
        try { debug.log('task-agent', 'card-bind-failed', { card: id, runId: piece.runId, via: 'advance', error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
      }
    }
  }
  const all = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(path).tasks ?? {};
  const mission = all[missionId];
  if (!mission?.pieces) throw new Error(`미션 카드가 아니다: ${missionId}`);
  const missing = mission.pieces.filter((id) => !all[id]);
  if (missing.length) throw new Error(`조각 카드 없음: ${missing.join(', ')} — 선후 기록이 불완전하다`);
  const pieces = mission.pieces.map((id) => all[id]!);
  if (mission.greenProposal) {
    // 제안이 끝난 미션은 다시 조회하지도 넘기지도 않는다 — 재조회 실패(pending)가 착지한 조각을 재발사하게 하지 않는다.
    return { missionId, mode, evidence: {}, landed: [], ready: [], handed: [], skipped: [], green: 'already-proposed' };
  }
  const evidence = await collectPieceEvidence(pieces, opts.readEvidence);
  const landed = landedPieces(mission, evidence);
  const ready = readyPieces(pieces, landed);
  const handed: AdvancedPiece[] = [];
  const skipped: string[] = [];
  for (const pieceId of ready) {
    const card = all[pieceId]!;
    // 자기 PR·골 근거가 이미 있는 조각은 런이 있었다 — 재조회가 pending 이어도 다시 넘기지 않는다.
    if (!(card.after ?? []).length || alreadyHanded(card, mode) || card.pr !== undefined || card.goalId !== undefined) { skipped.push(pieceId); continue; }
    const mark: NonNullable<TaskCard['handed']> = { at: clock().toISOString(), mode, claim: randomBytes(6).toString('hex') };
    const claim: { card?: TaskCard } = {};
    updateTaskCard(path, pieceId, (current) => {
      if (!current || alreadyHanded(current, mode) || current.pr !== undefined || current.goalId !== undefined) return undefined;
      claim.card = { ...current, handed: mark };
      return claim.card;
    });
    const claimed = claim.card;
    if (!claimed) { skipped.push(pieceId); continue; }
    let result: AdvancedPiece;
    try {
      const out = await handTask({
        text: claimed.text, id: pieceId, mission: missionId, after: claimed.after ?? [], landed,
        ...(claimed.seat ? { seat: claimed.seat } : {}), ...(claimed.checklistId ? { checklistId: claimed.checklistId } : {}),
        cardFields: { handed: mark, ...(claimed.pr !== undefined ? { pr: claimed.pr } : {}), ...(claimed.goalId !== undefined ? { goalId: claimed.goalId } : {}) },
        live: mode === 'live', statePath: path, ...(opts.launcher ? { launcher: opts.launcher } : {}), ...(opts.now ? { now: opts.now } : {}),
        // claim 을 가진 동안만 쓴다 — 늦게 끝난 shadow 넘김이 live 표지·발사 기록을 덮지 않게.
        writeGuard: (current) => current?.handed?.claim === mark.claim,
      });
      result = { pieceId, launched: out.launched, move: out.move.kind };
    } catch (error) {
      if (error instanceof TaskCardSupersededError) { skipped.push(pieceId); continue; }
      const reason = error instanceof Error ? error.message : String(error);
      // 발사 실패면 handTask 가 launch-failed 로 적었다 — 표지에 사유를 덧붙여 다시 넘기지 않는다(판단부 몫).
      updateTaskCard(path, pieceId, (current) => current && current.handed?.claim === mark.claim ? { ...current, handed: { ...mark, error: reason } } : undefined);
      result = { pieceId, launched: false, move: 'launch', error: reason };
    }
    handed.push(result);
    try { debug.log('task-agent', 'mission-piece-handed', { missionId, pieceId, after: claimed.after ?? [], mode, launched: result.launched, ...(result.error ? { error: result.error } : {}) }); } catch { /* fail-soft */ }
  }
  let green: AdvanceMissionResult['green'] = 'not-yet';
  if (missionLanded(mission, landed)) {
    const proposal = {
      at: clock().toISOString(),
      checklistId: mission.checklistId ?? null,
      evidence: Object.fromEntries(pieces.map((piece) => { const ref = pieceRef(piece); return [piece.id, typeof ref === 'number' ? `#${ref}` : `goal:${ref}`]; })),
    };
    const wrote = { proposed: false, stale: false };
    updateTaskCard(path, missionId, (current, tasks) => {
      if (!current || current.greenProposal) return undefined;
      // 조회에 쓴 근거가 잠금 안에서도 그대로일 때만 — 조회 도중 근거가 바뀌었으면 다음 호출이 다시 본다.
      if (pieces.some((piece) => { const now = tasks[piece.id]; return (now ? cardPrNumber(now) : undefined) !== cardPrNumber(piece) || now?.goalId !== piece.goalId; })) { wrote.stale = true; return undefined; }
      wrote.proposed = true;
      return { ...current, greenProposal: proposal };
    });
    green = wrote.proposed ? 'proposed' : wrote.stale ? 'not-yet' : 'already-proposed';
    if (wrote.proposed) {
      try { debug.log('task-agent', 'mission-green-proposed', { missionId, checklist: mission.checklistId ?? null, evidence: proposal.evidence }); } catch { /* fail-soft */ }
    }
  }
  return { missionId, mode, evidence, landed: [...landed], ready, handed, skipped, green };
}

/** `--all` 의 대상 — green 제안이 아직 없는 미션 카드 id. */
export function openMissionIds(statePath = taskAgentStatePath()): string[] {
  const all = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
  return Object.values(all).filter((card) => card.pieces && !card.greenProposal).map((card) => card.id).sort();
}
