/**
 * TASK-AGENT 과제 넘기기 문 — `elanous task hand "<한 줄>"` (RFC-task-agent-any-task-to-completion §A9 표 1행 · R3).
 *
 * - 과제 카드를 실행부와 «같은» 상태 파일(`effectiveInstanceRoot()/task-agent-actions.json`)의 `tasks` 칸에 적는다.
 *   종전 칸(landingDay·landingsToday·failureCounts)은 그대로 두고 덧붙이기만 한다(하위 호환 — 실행부 쓰기는 `...disk` 로 보존).
 * - 첫 수는 «launch» = `harness say [--seat <자리>] --substrate pod --merge-by-host "<원문>"`.
 * - 기본은 SHADOW: 카드와 명령만 남기고 아무것도 띄우지 않는다. `--live` 일 때만 주입된 launcher 로 띄운다.
 * - 관측: `debug.log('task-agent', 'handed', {taskId, seat, checklistId, mode, runPriority})`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { runGraph, validateUnitCalls, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { resolveDaemonHarnessTarget } from '../intake-plane/harness-target.js';
import { getUserConfig } from '../user-config.js';
import { readBudgetInputsLive, type BudgetInputs } from '../self-implement/budget-gate.js';
import { HARNESS_RUN_ID_ENV, mintRunId, normalizeRunId } from '../harness/harness-space.js';
import { newLaunchUtteranceId, recordLaunchUtterance } from '../harness/launch-utterance-ledger.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { checkCompletionEvidence, deliverableReceiptEvidence } from './completion-evidence.js';
import { judgeNextMove } from './judge.js';
import { checklistDevVersion, listChecklist } from '../release-loop/checklist.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
// Keep doctor-visit recording synchronous: updateTaskCard callers observe it before the transition returns.
import { recordTaskAgentNeedsOwnerVisit } from '../self-implement/doctor-visit.js';
import { applyRunIdentityTag, applyRunIdentityTags, deriveBirthIdentity, parseRunIdentityTag, runIdentityFieldText, runIdentityQueuePriority, runPriorityClass, validateRunIdentity, type RunIdentity, type RunIdentityCell, type RunIdentityOrigin } from './run-identity.js';
import { parseWorkOrder, renderWorkOrderGoal, WORK_ORDER_FILE_PATTERN, type WorkOrder } from './work-order.js';
import { inspectPrelaunchAlreadyDone, type AlreadyDoneDecision, type AlreadyDoneCandidate,
  type PrelaunchGitRunnerForTest } from './prelaunch-already-done.js';
import { draftClaimComment, draftClaimRecordLive, draftClaimState, draftReleaseComment } from '../self-dev/draft-triage-rules.js';
import { parseAskTargetPathHints, parseAskTargetPathHintsResult, type AskTargetPathHintsParseResult } from '../self-dev/launch-preflight-text.js';
import { draftMissingGoalDoneBoundary, inspectGoalDoneBoundary, linesOutsideFencedCode } from '../self-implement/goal-author.js';
import { selectKnowhowPack } from '../self-implement/knowhow-pack.js';
import { INFLIGHT_REGISTRY_FILE, registerInflight } from '../pr-tool/inflight-registry.js';
import { taskParentRoleEnv, taskParentRolePinsForChild } from './task-parent-role-llm.js';
import { runHarvestUnit, type ReviewInvocation } from './harvest-unit.js';
import { TASK_CARD_PREFIX } from './task-card-prefix.js';

export interface ResolveHandTextDeps {
  cwd: string;
  stat: (path: string) => Pick<Stats, 'isFile' | 'isDirectory'>;
  readFile: (path: string, encoding: 'utf8') => string;
}

export type ResolvedHandText =
  | { kind: 'unchanged'; text: string }
  | { kind: 'inlined'; text: string; path: string; chars: number; sha256: string }
  /** TA-WORK-ORDER — `.work-order.json` 골 파일이 검증을 통과해 지시서를 골 문면으로 펼친 것(`work-order.ts`). */
  | { kind: 'work-order'; text: string; path: string; order: WorkOrder }
  | { kind: 'rejected'; path: string; reason: string };

function missingOrReadFailure(error: unknown): '없다' | '읽기 실패' {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? '없다' : '읽기 실패';
}

/** 파일 판정만 한다. 카드 작성은 호출자가 결과에 따라 수행한다. */
export function resolveHandText(text: string, deps: ResolveHandTextDeps = { cwd: process.cwd(), stat: statSync, readFile: readFileSync }): ResolvedHandText {
  const workOrder = WORK_ORDER_FILE_PATTERN.test(text);
  if (!text || (/\s/.test(text) && !workOrder)) return { kind: 'unchanged', text };
  const path = resolve(deps.cwd, text);
  const extension = /\.(?:md|markdown|txt)$/i.test(text);
  const reject = (reason: string): ResolvedHandText => {
    if (workOrder) {
      try { debug.log('task-agent.work-order', 'rejected', { cellId: null, unknownFields: [] }); } catch { /* fail-soft */ }
    }
    return { kind: 'rejected', path, reason };
  };
  let file: Pick<Stats, 'isFile' | 'isDirectory'>;
  try { file = deps.stat(path); } catch (error) {
    if (!extension && !workOrder) return { kind: 'unchanged', text };
    return reject(missingOrReadFailure(error));
  }
  if (!file.isFile() && !extension && !workOrder && !file.isDirectory()) return { kind: 'unchanged', text };
  if (!file.isFile()) return reject(file.isDirectory() ? '디렉터리' : '읽기 실패');
  let content: string;
  // stat 과 read 사이에 지워지거나 경로가 바뀌어도 사유는 같은 규칙(없다/읽기 실패)으로 가른다.
  try { content = deps.readFile(path, 'utf8'); } catch (error) { return reject(missingOrReadFailure(error)); }
  // TA-WORK-ORDER — 지시서 골 파일은 인라인하지 않고 지시서로 검증해 골 문면으로 펼친다.
  if (workOrder) {
    const parsed = parseWorkOrder(content);
    if (!parsed.ok) return reject(parsed.reason);
    try { debug.log('task-agent.work-order', 'parsed', { cellId: parsed.order.cellId, unknownFields: parsed.order.unknownFields }); } catch { /* fail-soft */ }
    return { kind: 'work-order', text: renderWorkOrderGoal(parsed.order), path, order: parsed.order };
  }
  const carried = content.trim();
  if (!carried) return { kind: 'rejected', path, reason: '비었다' };
  return { kind: 'inlined', text: content, path, chars: carried.length, sha256: createHash('sha256').update(carried).digest('hex') };
}

export const TASK_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type TaskSeat = typeof TASK_SEATS[number];
/** 과제 카드 id 접두 — `task show <id>` 가 이 접두로 TOX 태스크와 갈린다(정본 = task-card-prefix.ts). */
export { TASK_CARD_PREFIX };
/** Pod Job 의 metadata.labels 에 붙일 카드 식별자 — 원장의 카드 id 와 정확히 같아야 한다. */
export const TASK_CARD_LABEL = 'elanous.task-card';
/**
 * TA-LIVE-LAND-2 — run-level marker set by `tasks hand --ta-land` on the launched `harness say`. The Pod surface
 * (`self-implement-pod.ts`) reads it: with `taskAgent.liveMoves` ∋ `propose-land` the host re-gates without merging so
 * the task agent's `executeLiveLand` → `pr land --expected-head` owns the land. Without propose-land it is ignored.
 */
export const TA_LAND_ENV = 'ELANOUS_TA_LAND';
export interface TaskCardLabelContext {
  cardId: string;
  labels: Record<typeof TASK_CARD_LABEL, string>;
}

/** 카드 원장을 변경하지 않는 Pod 라벨 맥락. 정규화하면 다른 카드와 충돌할 수 있으므로 유효하지 않은 id 는 거부한다. */
export function taskCardLabelContext(card: Pick<TaskCard, 'id'>): TaskCardLabelContext {
  const id = card.id;
  if (!id.startsWith(TASK_CARD_PREFIX) || id.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw new Error(`Pod 라벨에 쓸 수 없는 과제 카드 id: ${id}`);
  }
  return { cardId: id, labels: { [TASK_CARD_LABEL]: id } };
}

/**
 * 과제 종결 종류(RFC-loop-agent-map §A4b③) — 비면 code-pr(PR 병합)로 읽는다.
 * code-pr 밖의 종류는 «확인 증거»(`judge.ts` TaskJudgeInput.evidence)로 종결한다 — 증거를 만드는 일은 DEFAULT-HANDS 몫.
 */
export const COMPLETION_KINDS = ['code-pr', 'artifact', 'research-report', 'ops-action', 'content', 'watch-brief', 'decision-support', 'deliverable'] as const;
export type CompletionKind = typeof COMPLETION_KINDS[number];

/** «실행·조사» 손의 조합 — 종결 종류별 조합이 아직 없을 때 그 손이 기본으로 쓰는 판(조사 make-doc ⊕ 확인 verify). */
export const RUN_RESEARCH_COMPOSITION = 'graphs/work/run-research.yaml';

/** 기본 손 묶음 — «개발»(자식 구현 런·PR 착지 = 코드 하니스) 또는 «실행·조사»(비코드 종결 다섯 ⊕ 콘텐츠·전달). */
export type DefaultHand = 'develop' | 'run-research';

/**
 * DEFAULT-HANDS — 종결 종류마다 과제 담당이 기본으로 쥐는 손과 그 «확인 증거»(RFC-loop-agent-map §A4c).
 * 기본은 «개발»이 아니라 «실행·조사»다: 마케터·산업 현장·선생님·C 레벨이 자기 일을 그대로 맡긴다.
 * 코드 하니스(`harness-say` 자식 구현 런 · PR 착지)는 개발자 팩(`code-pr`)만 쓴다.
 */
export interface DefaultHandSpec {
  hand: DefaultHand;
  /** 확인 증거 — 종류별 판정 규칙의 이름(정본 = `completion-evidence.ts` `checkCompletionEvidence`). */
  evidence: string;
  /** 종류별 조합 파일이 없을 때 그 손이 기본으로 쓰는 조합. */
  composition: string;
  /** 코드 하니스(자식 구현 런·PR 병합)를 쓰나 — 개발자 팩 전용. */
  codeHarness: boolean;
}

export const DEFAULT_HANDS: Record<CompletionKind, DefaultHandSpec> = {
  'code-pr': { hand: 'develop', evidence: '구현 — PR 병합', composition: 'graphs/work/code-pr.yaml', codeHarness: true },
  'research-report': { hand: 'run-research', evidence: '조사 — 출처 인용 보고(출처 ⊕ 반대 근거)', composition: 'graphs/work/research-report.yaml', codeHarness: false },
  artifact: { hand: 'run-research', evidence: '산출물 — 파일 ⊕ 미리보기', composition: RUN_RESEARCH_COMPOSITION, codeHarness: false },
  content: { hand: 'run-research', evidence: '콘텐츠 — 파일 ⊕ 미리보기', composition: RUN_RESEARCH_COMPOSITION, codeHarness: false },
  'ops-action': { hand: 'run-research', evidence: '실행 — 실행 기록 ⊕ 되읽기', composition: RUN_RESEARCH_COMPOSITION, codeHarness: false },
  'watch-brief': { hand: 'run-research', evidence: '감시·브리핑 — 일정 ⊕ 도착', composition: RUN_RESEARCH_COMPOSITION, codeHarness: false },
  'decision-support': { hand: 'run-research', evidence: '결정 지원 — 카드 ⊕ 기록', composition: RUN_RESEARCH_COMPOSITION, codeHarness: false },
  deliverable: { hand: 'run-research', evidence: '전달 — 산출물 ⊕ 수신 확인', composition: RUN_RESEARCH_COMPOSITION, codeHarness: false },
};

/** 카드의 종결 종류가 기본으로 받는 손 — 비면 code-pr(=개발)다. */
export function defaultHandOf(completion: CompletionKind | undefined): DefaultHand {
  return DEFAULT_HANDS[completion ?? 'code-pr'].hand;
}

export interface TaskComposition {
  file: string;
  /** null = 파일은 있으나 파싱 실패로 판을 확인하지 못했다. */
  version: number | null;
}

export interface CompositionSelection {
  composition?: TaskComposition;
  unitsResolved: boolean;
  missingUnits: string[];
  launcher?: 'harness-say' | 'graph-run';
  error?: string;
}

/** 조합 저장소 루트(기본) — `graphs/work/<completion>.yaml` 는 이 루트에서 읽는다. */
export const COMPOSITION_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 1판은 조합을 고르고 단위 해석 결과를 기록한다. 단위 실행은 2판의 몫이다. */
export function selectTaskComposition(completion: CompletionKind, root = COMPOSITION_ROOT): CompositionSelection {
  const requested = `graphs/work/${completion}.yaml`;
  // DEFAULT-HANDS — 종류별 조합이 없으면 그 손의 기본 조합(«실행·조사»)으로 내려간다.
  // 비개발 종결이 «조합 없음»으로 막히면 사람별 표본이 과제 담당에 닿지도 못한다.
  let file = requested;
  let path = join(root, file);
  let source: string;
  try { source = readFileSync(path, 'utf8'); } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (!missing) {
      return { composition: { file, version: null }, unitsResolved: false, missingUnits: [],
        error: `조합 읽기 오류: ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const fallback = DEFAULT_HANDS[completion].composition;
    if (fallback === requested) return { unitsResolved: false, missingUnits: [] };
    file = fallback;
    path = join(root, file);
    try { source = readFileSync(path, 'utf8'); } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException)?.code === 'ENOENT') return { unitsResolved: false, missingUnits: [] };
      return { composition: { file, version: null }, unitsResolved: false, missingUnits: [],
        error: `조합 읽기 오류: ${file}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` };
    }
  }
  const parsed = parseGraphTemplateYaml(source, path);
  if (!parsed.template || parsed.errors.length) {
    let version: number | null = null;
    try {
      const raw: unknown = parseYaml(source);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const candidate = (raw as Record<string, unknown>).version;
        if (typeof candidate === 'number' && Number.isInteger(candidate)) version = candidate;
      }
    } catch { /* 파싱 실패 자체를 아래 원장에 적는다. */ }
    return { composition: { file, version }, unitsResolved: false, missingUnits: [],
      error: `조합 오류: ${file}: ${parsed.errors.map(e => e.message).join('; ')}` };
  }
  const raw: unknown = parseYaml(source);
  const launcher = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).launcher : undefined;
  if (launcher !== undefined && launcher !== 'harness-say' && launcher !== 'graph-run') {
    return { composition: { file, version: parsed.template.version }, unitsResolved: false, missingUnits: [],
      error: `조합 오류: ${file}: 모르는 launcher` };
  }
  if (completion === 'code-pr' && launcher === undefined) {
    return { composition: { file, version: parsed.template.version }, unitsResolved: false, missingUnits: [],
      error: `조합 오류: ${file}: launcher 없음` };
  }
  const missingUnits: string[] = [];
  let unitError: string | undefined;
  try { validateUnitCalls(parsed.template, path, [], call => missingUnits.push(call)); }
  catch (error) { unitError = error instanceof Error ? error.message : String(error); }
  return {
    composition: { file, version: parsed.template.version },
    unitsResolved: missingUnits.length === 0 && !unitError,
    missingUnits,
    ...(launcher === 'harness-say' || launcher === 'graph-run' ? { launcher } : {}),
    ...(unitError ? { error: `조합 단위 해석 오류: ${file}: ${unitError}` } : {}),
  };
}

/**
 * `run-bound`·`goal-bound`·`pr-bound` 은 runId(⊕ pr)를 싣는다 — 옛 카드의 칸은 at·event·detail 뿐이다.
 * TA-LIVE-MOVE-CARD-HISTORY — `live-move` 줄만 kind·executed·ok·executorResult·head·effect 를 더 싣는다(`live-move-history.ts`).
 */
export interface TaskCardEvent {
  at: string; event: string; detail?: string; runId?: string; pr?: number;
  /** 원격 미결 수를 HQ 에 한 번만 회수하기 위한 원장 사건 id. */
  sourceId?: string;
  /** `closed-by-hand` 줄만 — 닫은 사유 · 닫은 자리(`closeTaskCard`). */
  reason?: string; by?: string;
  /** RUN-IDENTITY-TAGS — `run-tag-change` 줄만 — 바꾼 칸 값(from → to). */
  from?: string; to?: string;
  kind?: string; executed?: boolean; ok?: boolean; executorResult?: 'shadow' | 'live'; head?: string; effect?: string;
  /** TA-REVIEW-RESULT-CAPTURE — review live-move 줄 · 결과 줄(`live-move-result`)의 결과 파일 경로. */
  resultPath?: string;
  /** TA-REVIEW-RESULT-CAPTURE — `live-move-result` 줄만: 회수한 `self review --json` 의 칸(못 읽은 칸은 null). */
  verdict?: string | null; reviewed?: boolean | null; mustFix?: number | null; reviewRoute?: string | null;
  /** Exact bytes of the captured review stdout; repair must read the same resultPath and digest. */
  reviewSha256?: string;
  /** HARNESS-FULL-GRAPH-NEXTMOVE — next-move 결정 순간 만든 수 id(간선·발사와 같은 값). `repair-launched` · `relaunch-launched`(일반 재발사) ·
   *  `repair-result`(결과 파일의 값이 카드와 짝지어졌을 때만 · NEXTMOVE-GENERAL-RELAUNCH-MOVEID) 줄에 싣는다. */
  moveId?: string;
}
/** 카드 history 의 live-move 줄 이벤트 이름 — 상태 사유(«마지막 칸») 판정에서 뺀다. */
export const LIVE_MOVE_HISTORY_EVENT = 'live-move';
/** TA-REVIEW-RESULT-CAPTURE — 떼어 띄운 리뷰의 결과(또는 «결과 없음») 줄 — live-move 줄처럼 상태 사유 판정에서 뺀다. */
export const LIVE_MOVE_RESULT_EVENT = 'live-move-result';
/** HAND-MOVE-LEDGER — 자리가 손으로 마무리한 수 줄(`recordHandMove`) — 관측 기록이라 live-move 줄처럼 상태 사유 판정에서 뺀다. */
export const HAND_MOVE_HISTORY_EVENT = 'hand-move';
export interface TaskCardMove { kind: 'launch' | 'wait'; command?: string[]; reason: string }
export interface TaskCard {
  id: string;
  text: string;
  /** 첫 줄 대상 경로 라벨에서 확인한 저장소 상대 경로. 필드 부재는 경로를 모른다는 뜻이다. */
  targetPaths?: string[];
  seat?: TaskSeat;
  checklistId?: string;
  /** Explicit release version for an adopted PR; post-land still confirms the cell exists there. */
  checklistVersion?: string;
  /** 종결 종류 — 비면 code-pr. */
  completion?: CompletionKind;
  /** 선택된 일 조합 파일과 판(1판: 실행은 launcher 에 위임). */
  composition?: TaskComposition;
  graphSelectedBy?: 'completion';
  unitsResolved?: boolean;
  missingUnits?: string[];
  /** 과제 대상 프로젝트(§A4b②) — target 은 절대 경로(git 이 아닐 수 있다). id 는 `task hand --project` 가 싣는다(옛 카드엔 없을 수 있다). */
  project?: { id?: string; target: string };
  /** 보드(§A4b① `board.ts`) 소속 — 목표 id · 이정표 id(`task hand --goal/--milestone`). 조각 카드의 `goalId`(골 sha 16자)와 다른 칸이다. */
  goal?: string;
  milestone?: string;
  createdAt: string;
  /**
   * launch-failed = 발사기가 띄우기에 실패했다(사유는 history 마지막 칸) — 다음 수는 다시 발사.
   * failed = 발사된 런이 PR·수확 가지 없이 죽었거나 끝내 안 떴다(TA-JUDGE-DEAD-RUN · `card-evidence.ts`) — 사유
   * (`failed/needs-owner|needs-relaunch — …`)는 history 마지막 칸 · 자동 재발사하지 않는다(사람/판단부 몫).
   * landed-by-hand = 실패 카드에 묶인 PR을 사람이 손수 병합해 main 에 안착시켰다(TA-CARD-MERGE-RECONCILE ·
   * `postland-card.ts` `reconcileHandMergedCard`) — 이전 status·사유는 history `hand-move` 줄에 보존된다.
   * landed = 병합된 merge 커밋이 카드의 land attempt head 와 정확히 일치해 에이전트 착지로 확정했다(같은 정산 경로).
   */
  status: 'handed' | 'launched' | 'launch-failed' | 'failed' | 'landed-by-hand' | 'landed' | 'done';
  history: TaskCardEvent[];
  /** 미션 카드만 — 조각 카드 id(순서대로) · 쪼갠 출처(`mission.ts` splitMission). */
  pieces?: string[];
  splitSource?: string;
  /** 조각 카드만 — 소속 미션 카드 id · 먼저 착지해야 하는 조각 id(선후). */
  mission?: string;
  after?: string[];
  /**
   * 이 카드 런이 연 PR · 골 id(16자). 두 출처가 한 칸을 쓴다(UX LOOP-INTERACT 계약 — card.runId → goalId):
   * - 수동(② `tasks advance --pr|--goal` · 미션 조각만) — PR 은 번호(number) · `refSource: 'manual'`.
   * - 런 원장 묶기(TA-CARD-RUN-LINK `card-evidence.ts`) — PR 은 `{number, url}` · 비어 있을 때만 «한 번» 채운다 · 수동 근거를 덮지 않는다.
   * 번호는 `cardPrNumber` 로 읽는다(옛 카드의 number 도 그대로 읽힌다).
   */
  pr?: number | TaskCardPr;
  /** Host-verified existing OPEN PR adopted without launching a new implementation run. */
  adoptedPr?: { pr: number; url: string; head: string; at: string };
  /** Bound PR observed in a terminal GitHub state. Only applies while the card still binds the same PR and URL. */
  prTerminal?: { pr: number; url: string; head: string; state: 'MERGED' | 'CLOSED'; at: string };
  /** Component PR closed by a verified merged integration train. Source PR remains CLOSED. */
  trainLanding?: { componentPr: number; integrationPr: number; mergeSha: string; train: string; at: string };
  /** Post-land checklist judgement. A partial slice closes this card while leaving the checklist cell yellow. */
  postLand?: { pr: number; head: string; at: string; outcome: 'complete' | 'partial'; evidence: string[]; remaining: string[] };
  goalId?: string;
  /** `manual` = pr/goalId 를 사람이 적었다(`recordPieceRef`) — 런 묶기가 건드리지 않는다. */
  refSource?: 'manual';
  /**
   * DRAFT-CLAIM-AUTO-2-FU — 이 손이 그 draft 로 남긴 claim 기록. `body` 는 PR 에 달 «🔧 처리 중» 문면이고
   * claim 이 성립한 손만 갖는다(수확이 머리를 확정하지 못하면 `body` 없이 `harvest` 사유만 남는다).
   */
  draftClaim?: TaskCardDraftClaimRecord;
  /** 조각 카드만 — ② 가 선행 착지 뒤 넘겼다(한 번만 · 같은 잠금 안에서 먼저 적는다). */
  handed?: { at: string; mode: 'shadow' | 'live'; claim?: string; error?: string };
  /**
   * TA-CARD-RUN-LINK — `--live` 발사가 발사기에 넘긴 런 id(`ELANOUS_RUN_ID` 상속 → 하니스 런이 그 id 로 돈다) ⊕ 발사 토큰.
   * 발사기가 그 id 를 «받았다»고 돌려줄 때만 적는다(한 번만). 원장이 아직 없으면 그 런은 시작 전이거나 대기열로 갔다.
   */
  runId?: string;
  launchId?: string;
  /** Pod 런이면 PR 을 연 자식 런 id(런 묶기가 PR 과 함께 적는다). */
  runChildId?: string;
  /** HARNESS-PARENT-ON-MSB1 — 부모가 도는 원격 호스트(없으면 HQ 로컬). 원격 부모는 PR 까지만 간다(병합은 HQ). */
  parentHost?: { host: string; configDir?: string; pid?: number; log?: string };
  /** 미션 카드만 — 모든 조각 착지 → 칸 green «제안»(체크리스트는 손대지 않는다 · OP/주인이 뒤집는다). */
  greenProposal?: { at: string; checklistId: string | null; evidence: Record<string, string> };
  /** A passed explicit evidence command on current main only proposes green to an owner. No run or checklist change. */
  alreadyDoneCandidate?: AlreadyDoneCandidate & { at: string };
  /** TA-JUDGE-LIVE-SAFE — live `review` 수가 리뷰를 요청한 PR 머리들(머리마다 한 번 · 띄우기 실패면 error · 이력은 지우지 않는다). */
  reviewRequests?: Array<{ pr: number; head: string; at: string; error?: string; /** TA-REVIEW-RESULT-CAPTURE — 자식 `--json` stdout 을 받는 파일. */ resultPath?: string }>;
  /**
   * TA-REJUDGE-ON-HEAD — 런 멈춤 «뒤» 머리마다 한 번 돌린 호스트 재게이트(병합 없음 · 떼어 띄움). 결과는 `resultPath` 파일에서
   * 다음 틱이 회수해 passed·status·baseCommit·detail 을 채운다(비어 있으면 아직 도는 중 · 없는 칸을 «통과»로 읽지 않는다).
   */
  regates?: Array<{ pr: number; head: string; at: string; resultPath?: string; passed?: boolean; status?: string; baseCommit?: string; detail?: string;
    /** REJUDGE base-stale — 같은 머리를 새 base 위에서 다시 잰 재게이트면, land 가 낡았다고 거절한 앞 재게이트의 base(멱등 키 = 머리 ⊕ 이 base). */
    staleBase?: string;
    /** TA-READY-BEFORE-REGATE — draft 때문에 실패한 같은 머리를 ready 뒤 딱 한 번 다시 잰다. */
    readyRetry?: true }>;
  /**
   * Live land attempts, claimed before invocation, once per PR head even if the command fails.
   * TA-LAND-RETRY-ON-INFRA — a failed attempt carries `class`/`reason`: `infra` (TA-side, allow-listed) leaves one more attempt on
   * the same head (`LAND_ATTEMPTS_PER_HEAD_ON_INFRA`); `judgement` · unknown reason · no class (older record) closes the head.
   * REJUDGE base-stale — `base-stale` (overlap evidence gate base went stale with PR-file overlap) waits for a re-gate on a new base;
   * only after that re-gate passes is the attempt consumed (`openLandAttempts`) and the same head may land once more.
   */
  landAttempts?: Array<{ pr: number; head: string; at: string; ok?: boolean; detail?: string; class?: 'infra' | 'judgement' | 'base-stale' | 'recovery'; reason?: string }>;
  /** TA-LIVE-LAND-2 — `tasks hand --ta-land`: this card's run leaves the merge to the task agent (propose-land). */
  taLand?: true;
  /** TASKS-HAND-CHILD-LLM — `tasks hand --child-llm <provider>/<model> [--child-llm-effort <level>]` → 발사 인자 `--child-llm-provider/-model/-effort`. */
  childLlm?: TaskChildLlm;
  /** Explicit parent role pins; the implementation child remains controlled by childLlm. */
  parentRoleLlm?: string[];
  /** Dispatch difficulty, fixed at handoff so repair uses the same judgement. */
  tier?: '하' | '중' | '상' | '특';
  /**
   * TIER-SPLIT-BEFORE-LAUNCH — 상·특 hand 를 분해해 나온 조각 카드(`tier-split.ts`). group = 같은 hand 에서 나온 조각들의 묶음 id
   * (칸 연결은 `checklistId` 가 그대로 잇는다) · fromTier = 원래 난이도 · unavoidable = 상으로 남은 조각의 불가피 이유.
   */
  tierSplit?: { group: string; fromTier: '상' | '특'; index: number; total: number; unavoidable?: string };
  /** RUN-IDENTITY-TAGS — 출생 신분 묶음(`run-identity.js` 정본): 칸 우선순위·대표 표시에서 태어나고 `--tag k=v` 가 덮는다. 카드 상태 파일이 원장 정본이다. */
  identity?: RunIdentity;
  /** Same-PR repair launches; exact source head and worker result are retained for CAS and retry limits. */
  repairs?: Array<{ pr: number; head: string; branch: string; at: string; move: string; runId: string;
    resultPath: string; fromModel: string; toModel: string; status: 'requested' | 'unconfirmed' | 'failed' | 'applied';
    detail?: string; commit?: string; bundleSha256?: string; bundlePath?: string;
    /** Hash of exact review must-fix text at launch; old records have no comparable input. */
    reviewSignature?: string;
    /** Stable worker failure class; absent means retry policy remains unchanged. */
    failureSignature?: string;
    gateFailureTests?: string[];
    /** HARNESS-FULL-GRAPH-NEXTMOVE — next-move 결정 순간 만든 수 id. 이 칸 전 원장 줄엔 없다. */
    moveId?: string }>;
}

/** 구현 자식 LLM 선택 — 하니스 `--child-llm-provider/--child-llm-model/--child-llm-effort` 로 그대로 넘긴다(검증 권위는 하니스). */
export interface TaskChildLlm { provider: string; model: string; effort?: string }

/**
 * `<provider>/<model>` 을 «첫» `/` 에서만 가른다(모델 id 가 `/` 를 담을 수 있다).
 * openrouter 는 하니스의 모델 id 가 `openrouter/` 접두를 포함하므로(`openrouter/z-ai/glm-5.3`) 전체 문자열을 모델로 둔다
 * (`openrouter/openrouter/…` 처럼 접두를 이미 단 입력은 두 번 붙이지 않는다).
 */
export function parseChildLlm(value: string, effort?: string): TaskChildLlm {
  // 원 값 그대로 본다 — 앞뒤 공백·개행도 «잘못된 값»이다(조용히 다듬지 않는다).
  const slash = value.indexOf('/');
  const provider = slash < 0 ? '' : value.slice(0, slash);
  const rest = slash < 0 ? '' : value.slice(slash + 1);
  if (!provider || !rest || /[\s\p{Cc}]/u.test(value)) throw new Error(`--child-llm 은 <provider>/<model> 이다(예: grok/grok-4.7): ${JSON.stringify(value)}`);
  const model = provider === 'openrouter' && !rest.startsWith('openrouter/') ? `openrouter/${rest}` : rest;
  if (effort === undefined) return { provider, model };
  if (!effort || /[\s\p{Cc}]/u.test(effort)) throw new Error(`--child-llm-effort 가 비었거나 공백·제어 문자를 담았다: ${JSON.stringify(effort)}`);
  return { provider, model, effort };
}

/** 런 원장에서 묶은 PR — url 은 원장(pr-opened · Pod job-finished)에 있을 때만(지어내지 않는다). */
export interface TaskCardPr { number: number; url?: string }

/** 카드의 PR 번호 — 수동(number)·묶음(`{number,url}`) 둘 다. */
export function cardPrNumber(card: Pick<TaskCard, 'pr'>): number | undefined {
  return typeof card.pr === 'number' ? card.pr : card.pr?.number;
}

/** A stale terminal marker must never close a card after its PR binding changes. */
export function boundPrTerminal(card: Pick<TaskCard, 'pr' | 'prTerminal'>): TaskCard['prTerminal'] | undefined {
  const marker = card.prTerminal;
  return marker && typeof card.pr === 'object' && card.pr.number === marker.pr && card.pr.url === marker.url ? marker : undefined;
}

/**
 * DRAFT-CLAIM-AUTO-2 — 포기 경로(failed · launch-failed)로 끝난 카드가 PR 을 남겼으면 그 PR 에 달 «🔧 처리 끝» 문면.
 * 이 조각은 순수 함수만 — 실제 PR 코멘트(gh) · draft-sweep 배선은 다음 조각. launched · handed · PR 없음은 null.
 */
export function abandonedDraftReleaseNote(card: Pick<TaskCard, 'id' | 'status' | 'pr'>, at: Date): { pr: number; body: string } | null {
  if (card.status !== 'failed' && card.status !== 'launch-failed') return null;
  const pr = cardPrNumber(card);
  return pr === undefined ? null : { pr, body: draftReleaseComment(at, `${card.id} 포기 경로 — 자동`) };
}

/** A uniquely launched code-PR card may own a draft through its PR or its opening run. */
export function draftTaskOwner(cards: readonly TaskCard[], draft: { number: number; runId?: string | null }): TaskCard | undefined {
  const owners = draftTaskOwners(cards, draft);
  return owners.length === 1 ? owners[0] : undefined;
}

/**
 * DRAFT-CLAIM-AUTO-2-FU — 그 draft 를 쥐고 있다고 말하는 카드 «전부». `draftTaskOwner` 는 이 목록이 한 장일 때만
 * 주인을 돌려주므로, 두 장 이상이면 어느 쪽이 진짜인지 모른다 = 중복 claim.
 */
export function draftTaskOwners(cards: readonly TaskCard[], draft: { number: number; runId?: string | null }): TaskCard[] {
  return cards.filter((card) => card.status === 'launched' && (card.completion ?? 'code-pr') === 'code-pr'
    && card.seat && (card.runId || card.runChildId) && (cardPrNumber(card) === draft.number
      || (draft.runId && (card.runId === draft.runId || card.runChildId === draft.runId))));
}

/** DRAFT-CLAIM-AUTO-2-FU — 손이 draft 하나를 잡을 때의 «지금» 관측값(라벨·갱신 시각은 호출자가 관측해 넘긴다). */
export interface HandTaskDraftClaim {
  /** 관측한 draft PR 번호 — 손이 잡으려는 PR. 카드에 묶인 PR 과 같은 번호다. */
  pr: number;
  /** 그 PR 의 지금 라벨(claim·harvestable 판정 입력 · `draftClaimState`). */
  labels: readonly string[];
  /** 그 PR 의 마지막 갱신 시각 — 없으면 만료인지 아닌지 모르므로 claim 하지 않는다. */
  updatedAt?: string;
  /** 그 PR 을 연 런 id(카드 묶기 키 — `draftTaskOwner`). */
  runId?: string | null;
  /** 손 수확 — 리뷰 결과로 머리를 확정한 «뒤에만» claim 한다. */
  harvest?: HandTaskDraftHarvest;
  /** DRAFT-CLAIM-AUTO-2-FU — claim 문면을 «실제 PR 댓글»로 게시하는 포트. 생산 배선(`tasks hand --draft-claim <pr>`)이 gh 게시자를 준다. 없으면 `body` 를 카드에만 남긴다. */
  postComment?: (pr: number, body: string) => Promise<string | undefined>;
}

/**
 * DRAFT-CLAIM-AUTO-2-FU — 손 수확: 그 머리에서 리뷰를 다시 받아 수확이 성립할 때만 claim 한다.
 * 생산 배선(`handDraftClaim`)이 관측한 PR 머리(`expectedHead`) ⊕ 포트의 리뷰 러너(`invokeReview`)로 조립한다.
 */
export interface HandTaskDraftHarvest {
  /** 리뷰를 요청한 머리(40-hex) — 없거나 지금 머리와 다르면 수확은 성립하지 않는다(claim 0). */
  expectedHead?: string;
  /** 리뷰 의도 문면(없으면 손 문면을 쓴다). */
  reviewIntent?: string;
  /** `elanous self review <pr> --json` 를 부르는 자리 — 호출자(관측 포트)가 준다. */
  invokeReview: (args: { pr: string; intent: string }) => Promise<ReviewInvocation>;
}

/** DRAFT-CLAIM-AUTO-2-FU — 카드에 남는 claim 기록. */
export interface TaskCardDraftClaimRecord {
  pr: number;
  at: string;
  /** 만료된 claim 을 다시 잡았나(= 재claim). */
  reclaim: boolean;
  /** PR 에 달 «🔧 처리 중» 문면 — claim 이 성립한 손만. */
  body?: string;
  /** shadow 는 게시 예약이 아니므로 live claim 을 막지 않는다. 옛 기록은 live 로 취급한다. */
  mode?: 'shadow' | 'live';
  /** DRAFT-CLAIM-AUTO-2-FU — 게시한 PR 댓글 위치(댓글 url·id · `postComment` 포트가 있는 생산 경로만). */
  postedTo?: string;
  /** 쥐고 있던 카드 id(관측됐을 때). */
  ownerId?: string;
  /** 손 수확 증거 — 머리를 확정하지 못했으면 `outcome`·`reason` 만 있고 `body` 는 없다. */
  harvest?: { outcome: 'done' | 'rework' | 'needs-human' | 'failed'; headCommit?: string; reason?: string };
}

/** DRAFT-CLAIM-AUTO-2-FU — 이 손이 draft 를 잡아도 되나(중복 claim 거부 · 만료된 claim 만 재claim). */
export type DraftClaimJudgement =
  | { ok: true; body: string; reclaim: boolean; ownerId?: string }
  | { ok: false; reason: string; ownerId?: string };

/**
 * DRAFT-CLAIM-AUTO-2-FU — 판정선: ⑴ 두 장 이상의 카드가 같은 draft 를 쥐고 있으면 거부(어느 쪽이 진짜인지 모른다),
 * ⑵ 갱신 시각을 못 읽으면(`unobserved`) 만료인지 알 수 없으니 거부, ⑶ 살아 있는 claim 을 다른 카드가 쥐고 있으면 거부
 * (중복 claim), ⑷ 다른 카드에 남은 «살아 있는» claim 기록(카드 `draftClaim`)이 같은 PR 을 쥐고 있으면 거부 —
 * 연속된 손 호출이 «같은» draft 를 다시 claim 하지 못하게(launched 카드의 PR·런 소유권 가드만으는 부족하다),
 * ⑸ «만료»로 관측된 claim 만 다시 잡는다(재claim 문면).
 */
export function judgeDraftClaim(input: {
  draft: { number: number; labels: readonly string[]; updatedAt?: string; runId?: string | null };
  cards: readonly TaskCard[];
  cardId: string;
  seat?: TaskSeat;
  now: Date;
}): DraftClaimJudgement {
  const owners = draftTaskOwners(input.cards, input.draft);
  if (owners.length > 1) {
    return { ok: false, reason: `duplicate-claim: ${owners.map((card) => card.id).join(', ')} 가 같은 PR #${input.draft.number} 를 쥐고 있다` };
  }
  const owner = owners[0];
  const state = draftClaimState(input.draft, input.now);
  if (state === 'unobserved') {
    return { ok: false, ...(owner ? { ownerId: owner.id } : {}), reason: `claim-unobserved: PR #${input.draft.number} 의 claim 시각을 못 읽었다` };
  }
  if (state === 'claimed' && owner?.id !== input.cardId) {
    return {
      ok: false,
      ...(owner ? { ownerId: owner.id } : {}),
      reason: `duplicate-claim: ${owner ? owner.id : '카드 원장 밖 주인'} 가 PR #${input.draft.number} 를 처리 중이다`,
    };
  }
  const recordOwner = input.cards.find((card) => {
    const record = card.draftClaim;
    return card.id !== input.cardId && record !== undefined && record.pr === input.draft.number
      && record.body !== undefined && record.mode !== 'shadow' && draftClaimRecordLive(record.at, input.now);
  });
  if (recordOwner) {
    return { ok: false, ownerId: recordOwner.id, reason: `duplicate-claim: 카드 ${recordOwner.id} 가 PR #${input.draft.number} 의 claim 기록을 쥐고 있다` };
  }
  const reclaim = state === 'expired';
  return {
    ok: true,
    reclaim,
    ...(owner ? { ownerId: owner.id } : {}),
    body: draftClaimComment(input.seat ?? input.cardId, input.now, reclaim ? '만료 claim 재claim — 자동' : undefined),
  };
}

/** DRAFT-CLAIM-AUTO-2-FU — 그 draft 를 이미 다른 카드가 쥐고 있다(또는 만료인지 못 정한다). 이때 카드는 «쓰지 않는다». */
export class TaskDraftClaimRejectedError extends Error {
  readonly cardId: string;
  readonly reason: string;
  constructor(cardId: string, reason: string) {
    super(`draft claim 거부 (${cardId}): ${reason}`);
    this.name = 'TaskDraftClaimRejectedError';
    this.cardId = cardId;
    this.reason = reason;
  }
}

/**
 * DRAFT-CLAIM-AUTO-2-FU — 손 수확(있으면) → claim 판정을 생산 진입점 안에서 닫는다.
 *
 * ⑴ 수확이 머리를 확정하지 못하면(`needs-human`·`failed`) claim 문면(`body`)을 만들지 않고 사유만 남긴다 —
 * 다른 PR/낡은 머리 리뷰를 이 claim 에 붙이지 않는다. ⑵ 머리를 확정했으면 카드 원장(디스크)의 다른 카드와
 * 견줘 중복·만료를 판정하고, 거부면 던진다(호출자가 카드를 쓰기 «전»에 멈춘다).
 */
async function resolveHandDraftClaim(input: {
  claim: HandTaskDraftClaim;
  cards: readonly TaskCard[];
  cardId: string;
  seat?: TaskSeat;
  now: Date;
  ask: string;
}): Promise<TaskCardDraftClaimRecord> {
  const { claim } = input;
  const harvest = claim.harvest ? await runHarvestUnit({
    ask: input.ask,
    context: {
      pr: claim.pr,
      ...(claim.harvest.expectedHead !== undefined ? { expectedHead: claim.harvest.expectedHead } : {}),
      reviewIntent: claim.harvest.reviewIntent ?? input.ask,
    },
  }, claim.harvest.invokeReview) : undefined;
  const reason = harvest
    ? typeof harvest.result.reason === 'string' ? harvest.result.reason
      : typeof harvest.result.error === 'string' ? harvest.result.error : undefined
    : undefined;
  const harvestRecord: TaskCardDraftClaimRecord['harvest'] | undefined = harvest ? {
    outcome: harvest.outcome,
    ...(typeof harvest.result.headCommit === 'string' ? { headCommit: harvest.result.headCommit } : {}),
    ...(reason !== undefined ? { reason } : {}),
  } : undefined;
  const at = input.now.toISOString();
  if (harvest && harvest.outcome !== 'done' && harvest.outcome !== 'rework') {
    try { debug.log('task-agent.draft-claim', 'harvest-unconfirmed', { card: input.cardId, pr: claim.pr, outcome: harvest.outcome, reason: reason ?? null }); } catch { /* fail-soft */ }
    return { pr: claim.pr, at, reclaim: false, ...(harvestRecord ? { harvest: harvestRecord } : {}) };
  }
  const judgement = judgeDraftClaim({
    draft: { number: claim.pr, labels: claim.labels,
      ...(claim.updatedAt !== undefined ? { updatedAt: claim.updatedAt } : {}),
      ...(claim.runId !== undefined ? { runId: claim.runId } : {}) },
    cards: input.cards,
    cardId: input.cardId,
    ...(input.seat !== undefined ? { seat: input.seat } : {}),
    now: input.now,
  });
  if (!judgement.ok) {
    try { debug.log('task-agent.draft-claim', 'rejected', { card: input.cardId, pr: claim.pr, reason: judgement.reason }); } catch { /* fail-soft */ }
    throw new TaskDraftClaimRejectedError(input.cardId, judgement.reason);
  }
  try { debug.log('task-agent.draft-claim', judgement.reclaim ? 'reclaimed' : 'claimed', { card: input.cardId, pr: claim.pr, ownerId: judgement.ownerId ?? null }); } catch { /* fail-soft */ }
  return {
    pr: claim.pr, at, reclaim: judgement.reclaim, body: judgement.body,
    ...(judgement.ownerId !== undefined ? { ownerId: judgement.ownerId } : {}),
    ...(harvestRecord ? { harvest: harvestRecord } : {}),
  };
}

interface TaskAgentStateFile { tasks?: Record<string, TaskCard>; [key: string]: unknown }

/**
 * DRAFT-CLAIM-AUTO-2-FU — 손이 draft 를 잡을 때 필요한 관측·게시·수확 리뷰 포트(생산 기본값은 gh CLI ⊕ `elanous self
 * review` 러너 · 시험은 가짜 포트로 몽크). `handDraftClaim` 이 이 포트들로 `draftClaim`(⊕ 손 수확)을 조립한다.
 */
export interface DraftClaimGhPorts {
  /** PR 을 관측해 라벨·갱신 시각(·런 id)·머리(headRefOid · 손 수확 `expectedHead` 근거)을 읽는다. */
  observePr: (pr: number) => Promise<{ labels: readonly string[]; updatedAt?: string; runId?: string | null; head?: string }>;
  /** PR 댓글을 게시한다 — 게시 위치(댓글 url·id)를 돌려준다. */
  postComment: (pr: number, body: string) => Promise<string | undefined>;
  /**
   * DRAFT-CLAIM-AUTO-2-FU — 손 수확 리뷰 러너: `elanous self review <pr> --json` 관측 원문(stdout·stderr·exitCode)을
   * 돌려준다(판정은 `runHarvestUnit` 몫). 주면 생산 배선이 관측한 PR 머리와 함께 손 수확을 조립한다 — 없으면 수확 없이 claim 한다.
   */
  runReview?: (args: { pr: string; intent: string }) => Promise<ReviewInvocation>;
}

function ghExec(args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile('gh', [...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) fail(new Error(`gh ${args.join(' ')} 실패: ${error.message}`));
      else done(String(stdout));
    });
  });
}

/**
 * DRAFT-CLAIM-AUTO-2-FU — 손 수확 리뷰 러너(생산 기본값): 지금 도는 진입점으로 같은 우주의
 * `elanous self review <pr> --json --intent <intent>` 를 «기다려» 관측 원문(stdout·stderr·exitCode)을 돌려준다
 * (argv 는 `liveReviewArgs` 정본 — `defaultRequestReview` 가 떼어 띄우는 것과 같다). 판정·파싱은 `runHarvestUnit` 몫이다.
 */
export async function defaultDraftClaimReviewRunner(args: { pr: string; intent: string }): Promise<ReviewInvocation> {
  const { ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { liveReviewArgs } = await import('./live-moves.js');
  const configDir = getElanousConfigDirOverride() ?? effectiveInstanceRoot();
  const argv = liveReviewArgs(ELANOUS_CLI_ENTRY, configDir, Number(args.pr), args.intent);
  return await new Promise<ReviewInvocation>((done) => {
    execFile(process.execPath, argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      done({ stdout: String(stdout), stderr: String(stderr), exitCode });
    });
  });
}

/** 생산 기본 포트 — gh CLI 로 PR 을 관측(라벨·갱신 시각·머리)하고 댓글을 게시하며, 손 수확 리뷰는 같은 우주의 `elanous self review` 러너로 돌린다(자격·원격 저장소는 각 설정을 따른다). */
export function defaultDraftClaimGhPorts(): DraftClaimGhPorts {
  return {
    async observePr(pr: number) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await ghExec(['pr', 'view', String(pr), '--json', 'labels,updatedAt,headRefOid'])) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`PR #${pr} 관측 실패(gh pr view): ${error instanceof Error ? error.message : String(error)}`);
      }
      const labels = Array.isArray(parsed.labels) ? parsed.labels
        .map((label) => typeof label === 'string' ? label : (label as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === 'string') : [];
      const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined;
      const head = typeof parsed.headRefOid === 'string' && /^[0-9a-f]{40}$/i.test(parsed.headRefOid) ? parsed.headRefOid : undefined;
      return { labels, ...(updatedAt !== undefined ? { updatedAt } : {}), ...(head !== undefined ? { head } : {}) };
    },
    async postComment(pr: number, body: string) {
      await ghExec(['pr', 'comment', String(pr), '--body', body]);
      return `PR #${pr} 댓글`;
    },
    // DRAFT-CLAIM-AUTO-2-FU — 손 수확 리뷰 러너(생산): handDraftClaim 이 관측한 머리와 함께 조립한다.
    runReview: defaultDraftClaimReviewRunner,
  };
}

/**
 * DRAFT-CLAIM-AUTO-2-FU — 생산 진입점 배선: 관측 포트로 PR 을 읽어 `draftClaim` 을 «조립해» `handTask` 에 넘긴다
 * (`tasks hand --draft-claim <pr>` 가 부른다). 손 수확도 여기서 조립한다 — 관측한 PR 머리(`expectedHead`) ⊕ 포트의
 * 리뷰 러너(`invokeReview` · 생산 기본값 `elanous self review <pr> --json`)로 `runHarvestUnit` 을 거치게 한다.
 * 시험도 이 경로로 돌며 gh·리뷰 포트만 몽크한다 — `draftClaim` 을 직접 주입하지 않는다. 호출자가 직접 준 `harvest`
 * 가 우선(시험 주입)이고 리뷰 러너가 없는 포트는 종전대로 수확 없이 claim 한다(기본 동작 보존).
 */
export async function handDraftClaim(input: {
  pr: number;
  gh: DraftClaimGhPorts;
  /** DRAFT-CLAIM-AUTO-2-FU — 직접 주는 수확(시험 주입). 안 주면 배선이 관측한 머리 ⊕ 포트의 리뷰 러너로 조립한다. */
  harvest?: HandTaskDraftHarvest;
} & Omit<Parameters<typeof handTask>[0], 'draftClaim'>): Promise<Awaited<ReturnType<typeof handTask>>> {
  const { pr, gh, harvest, ...handOpts } = input;
  const observed = await gh.observePr(pr);
  // DRAFT-CLAIM-AUTO-2-FU — 손 수확 조립(생산): 관측한 PR 머리(expectedHead) + 포트의 리뷰 러너(invokeReview).
  const handHarvest: HandTaskDraftHarvest | undefined = harvest ?? (gh.runReview === undefined ? undefined : {
    ...(observed.head !== undefined ? { expectedHead: observed.head } : {}),
    invokeReview: gh.runReview,
  });
  return handTask({
    ...handOpts,
    draftClaim: {
      pr,
      labels: observed.labels,
      ...(observed.updatedAt !== undefined ? { updatedAt: observed.updatedAt } : {}),
      ...(observed.runId !== undefined ? { runId: observed.runId } : {}),
      ...(handHarvest !== undefined ? { harvest: handHarvest } : {}),
      postComment: gh.postComment,
    },
  });
}

function isGitWorkTree(path: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch { return false; }
}

export function taskAgentStatePath(): string {
  return join(effectiveInstanceRoot(), 'task-agent-actions.json');
}

/** 상태 파일을 읽을 수 없거나(ENOENT 제외) 해석할 수 없다 — 덮어쓰기 전에 멈춘다. */
export class TaskAgentStateError extends Error {
  constructor(path: string, cause: unknown) {
    super(`task-agent 상태 파일을 읽을 수 없다 — 덮어쓰지 않고 멈춘다: ${path} (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = 'TaskAgentStateError';
  }
}

/**
 * 실행부·과제 넘기기 문이 함께 쓰는 상태 파일(`task-agent-actions.json`)의 엄격한 읽기.
 * 파일이 «없음»(ENOENT)만 빈 상태다. 그 밖의 읽기·해석 오류(손상된 JSON · 객체 아님 · 권한)는
 * 던진다 — 빈 상태로 읽고 다시 쓰면 failureCounts·착지 기록·과제 카드가 지워진다.
 */
export function readTaskAgentState<T extends object = TaskAgentStateFile>(path: string): T {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {} as T;
    return stateError(path, error);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { return stateError(path, error); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return stateError(path, new Error('최상위가 객체가 아니다'));
  return parsed as T;
}

function stateError(path: string, cause: unknown): never {
  const error = new TaskAgentStateError(path, cause);
  try { debug.log('task-agent', 'state-unreadable', { path, reason: error.message }); } catch { /* fail-soft */ }
  throw error;
}

function readState(path: string): TaskAgentStateFile {
  return readTaskAgentState<TaskAgentStateFile>(path);
}

/** 카드 여럿을 한 잠금 안에서 적는다(미션 ⊕ 조각) — 종전 칸은 `...disk` 로 보존. */
export function writeTaskCards(path: string, cards: readonly TaskCard[]): void {
  withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    mkdirSync(dirname(path), { recursive: true });
    const tasks = { ...(disk.tasks ?? {}) };
    for (const card of cards) tasks[card.id] = card;
    writeFileSync(path, JSON.stringify({ ...disk, tasks }));
  });
}

/** 여러 카드의 관계 변경을 한 잠금 안에서 검사·기록한다(예: 기존 PR 결속 이동). */
export function updateTaskCardsAtomically(path: string,
  update: (tasks: Readonly<Record<string, TaskCard>>) => readonly TaskCard[] | undefined): TaskCard[] | undefined {
  return withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    const current = disk.tasks ?? {};
    const replacements = update(current);
    if (!replacements) return undefined;
    if (!replacements.length || replacements.some((card) => !card.id)) throw new Error('카드 원자 갱신은 id가 있는 카드가 필요하다');
    const tasks = { ...current };
    for (const card of replacements) tasks[card.id] = card;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks }));
    return [...replacements];
  });
}

/** 카드 하나를 잠금 안에서 읽고 고쳐 쓴다 — `update` 가 undefined 를 돌려주면 쓰지 않는다. 쓴(또는 그대로인) 카드를 돌려준다. */
export function updateTaskCard(path: string, id: string, update: (card: TaskCard | undefined, tasks: Readonly<Record<string, TaskCard>>) => TaskCard | undefined,
  options: { doctorLedgerDir?: string } = {}): TaskCard | undefined {
  let needsOwner: { runId: string; at: string; reason: string; transitionIndex: number } | undefined;
  const result = withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    const current = disk.tasks?.[id];
    const next = update(current, disk.tasks ?? {});
    if (!next) return current;
    const transitionIndex = next.history.length - 1;
    const last = next.history[transitionIndex];
    if (current?.status === 'launched' && next.status === 'failed' && next.runId
      && next.history.length > (current?.history.length ?? 0) && last?.event === 'failed'
      && last.detail?.startsWith('failed/needs-owner')) {
      needsOwner = { runId: next.runId, at: last.at, reason: last.detail, transitionIndex };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks: { ...(disk.tasks ?? {}), [id]: next } }));
    return next;
  });
  if (needsOwner) {
    try {
      const visit = recordTaskAgentNeedsOwnerVisit({ ...needsOwner, cardId: id, dir: options.doctorLedgerDir });
      debug.log('task-agent', 'doctor-visit', { card: id, runId: needsOwner.runId, status: visit.status });
    } catch (error) {
      debug.log('task-agent', 'doctor-visit-failed', { card: id, runId: needsOwner.runId,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function readTaskCard(id: string, path = taskAgentStatePath()): TaskCard | undefined {
  return readState(path).tasks?.[id];
}

/** TA-REVIEW-PASS — runId 기준 단일 카드 멱등 생성 결과. `ok: false` 는 임의 생성 없이 사유만 남긴 보류(fail-closed)다. */
export type IdempotentRunCardCreate =
  | { ok: true; card: TaskCard; created: boolean }
  | { ok: false; reason: string };

/**
 * TA-REVIEW-PASS — runId 기준 단일 카드 결속(멱등 생성). 단일 파일 잠금 안에서 원장을 읽어
 * (a) 같은 runId 카드가 정확히 1건이면 그대로 재사용, (b) 0건이면 runId 해시로 재진입에 안정적인 id 를 만들어
 * `card.runId` 를 검증된 부모 런 ID 와 정확히 일치시켜 원장에 추가한다(종전 칸·다른 카드·원장 기타 필드 보존),
 * (c) 복수 카드·원격 Pod 자식 런·불명 runId·읽기 실패는 임의 생성하지 않고 사유를 남겨 보류한다.
 */
export function idempotentCreateCardForRun(path: string, input: { runId: string; text: string; now?: () => Date; env?: NodeJS.ProcessEnv }): IdempotentRunCardCreate {
  const runId = input.runId.trim();
  if (!runId) return { ok: false, reason: 'runId 불명 — 고유한 런 소유를 검증할 수 없어 카드를 만들지 않는다' };
  const env = input.env ?? process.env;
  if (env.ELANOUS_POD_NAME) return { ok: false, reason: `원격 Pod 자식 런(${env.ELANOUS_POD_NAME}) — HQ 결속만 허용한다` };
  const at = (input.now ?? (() => new Date()))().toISOString();
  return withFileLockSync(`${path}.lock`, (): IdempotentRunCardCreate => {
    let disk: TaskAgentStateFile;
    try {
      disk = readState(path);
    } catch (error) {
      return { ok: false, reason: `원장 읽기 실패 — 임의 생성하지 않는다: ${error instanceof Error ? error.message : String(error)}` };
    }
    const tasks = { ...(disk.tasks ?? {}) };
    const bound = Object.values(tasks).filter((candidate) => candidate.runId === runId);
    if (bound.length === 1) return { ok: true, card: bound[0]!, created: false };
    if (bound.length > 1) return { ok: false, reason: `runId ${runId} 카드 ${bound.length}건(모호) — 고유한 런 소유가 아니므로 결속하지 않는다` };
    const id = `${TASK_CARD_PREFIX}run-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}`;
    if (tasks[id]) return { ok: false, reason: `카드 id ${id} 충돌 — 종전 카드를 덮어쓰지 않는다` };
    const card: TaskCard = {
      id, text: input.text, createdAt: at, status: 'launched', runId,
      history: [{ at, event: 'card-created-for-run', detail: `카드 없는 runId(${runId})의 리뷰 필요 판정 — 단일 카드 멱등 결속`, runId }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks: { ...tasks, [id]: card } }));
    return { ok: true, card, created: true };
  });
}

function canonicalTargetPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path): path is string => typeof path === 'string').map((path) => posix.normalize(path))
    .filter((path) => path !== '.' && path !== '..' && !posix.isAbsolute(path)
      && !path.startsWith('../') && !path.includes('\\') && !/^[A-Za-z]:\//.test(path)))].sort();
}

/** 같은 저장소 경로를 만지는 착지 전 카드만 돌려준다. 경로 미기록 카드는 추측하지 않는다. */
export function cardsTouchingPaths(cards: readonly TaskCard[], paths: readonly string[]): Array<{
  card: TaskCard; checklistId?: string; runId?: string; pr?: number; paths: string[];
}> {
  const wanted = new Set(canonicalTargetPaths(paths));
  if (wanted.size === 0) return [];
  return cards.filter((card) => card.status === 'launched' && !card.postLand && !card.trainLanding && !card.prTerminal)
    .map((card) => ({ card, paths: canonicalTargetPaths(card.targetPaths ?? []).filter((path) => wanted.has(path)) }))
    .filter((item) => item.paths.length > 0)
    .map(({ card, paths }) => ({ card, ...(card.checklistId ? { checklistId: card.checklistId } : {}),
      ...(card.runId ? { runId: card.runId } : {}), ...(cardPrNumber(card) !== undefined ? { pr: cardPrNumber(card) } : {}), paths }));
}

export const CLOSED_BY_HAND_EVENT = 'closed-by-hand';

/** 카드를 손으로 닫는다 — 상태를 `failed` 로 두고 history 에 한 줄(`closed-by-hand`)을 남긴다. 이미 손으로 닫은 카드는 그대로 돌려준다(멱등). */
export function closeTaskCard(card: TaskCard, input: { reason: string; by: string; at: string }): TaskCard {
  const reason = input.reason.trim();
  if (!reason) throw new Error('닫는 사유(reason)가 비어 있다');
  if (card.status === 'failed' && card.history.some((item) => item.event === CLOSED_BY_HAND_EVENT)) return card;
  return { ...card, status: 'failed', history: [...card.history, { at: input.at, event: CLOSED_BY_HAND_EVENT, kind: CLOSED_BY_HAND_EVENT, detail: reason, reason, by: input.by }] };
}

/** RUN-IDENTITY-TAGS — 카드 history 의 런 신분 태그 바꾸기 줄(`runTagChange`): 닫힌 목록 신분을 바꾼 감사 {from, to, by, reason}. */
export const RUN_TAG_CHANGE_EVENT = 'run-tag-change';

/** RUN-IDENTITY-TAGS — 칸 조회 seam 의 답(조회 실패·빠칸 = `undefined` = «모른다»). */
export type RunIdentityCellLookup = (checklistId: string) => RunIdentityCell | undefined;

/**
 * RUN-IDENTITY-TAGS-2 — 조회한 칸이 «기대한 판»의 칸일 때만 쓴다. 기대 판(카드 `checklistVersion`·호출자가 넘긴 판)을
 * 알면 칸의 `version` 이 그 판과 같아야 한다 — 다르거나 비면 다른 판의 같은 id 일 수 있으니 «모른다»(`undefined`).
 */
export function cellOnExpectedBoard(cell: RunIdentityCell | undefined, expectedVersion: string | undefined): RunIdentityCell | undefined {
  if (cell === undefined || expectedVersion === undefined) return cell;
  return cell.version === expectedVersion ? cell : undefined;
}

/**
 * RUN-IDENTITY-TAGS — 확인된 칸만 담은 신분: 조회에 성공한 칸이 있으면 그 출생값, 없으면 `{ origin }` 뿐이고
 * 명시 태그를 얹는다. ⛔ 칸을 못 읽었으면 나머지 칸(care·rights·protect·class)을 기본값으로 채우지 않는다(«미기록»).
 */
export function confirmedRunIdentity(cell: RunIdentityCell | undefined, origin: RunIdentityOrigin, tags: readonly string[]): RunIdentity {
  return applyRunIdentityTags(cell ? deriveBirthIdentity(cell, origin) : { origin }, tags);
}

/**
 * RUN-IDENTITY-TAGS — `tasks tag <card> k=v`: 카드 history 에 `run-tag-change` 줄 {from, to, by, reason} 을
 * 남기고 신분을 바꾼다(카드 상태 파일 = 원장 정본 — 같은 잠금 안에서 적는다). 목록 밖 값·모르는 칸은
 * 카드를 적기 전에 거부한다(`run-identity.js` 정본).
 * 신분 없는 옛 카드는 `checklistId` 로 칸을 «다시 조회»해 출생값을 세운다 — 못 읽으면 명시 태그만 담고 나머지는 «미기록».
 * 출생 자리(origin.launcher)는 그 카드가 어디서 났는지 원장이 모르므로 비운다(지어내지 않는다).
 */
export function runTagChange(id: string, input: { tag: string; by: string; reason?: string; checklistCell?: RunIdentityCellLookup }, path: string = taskAgentStatePath(), now: () => Date = () => new Date()): TaskCard | undefined {
  const tag = parseRunIdentityTag(input.tag);   // 목록 밖 값·모르는 칸은 여기서 거부한다.
  const at = now().toISOString();
  // 재조회는 잠금 밖에서 한 번 — 잠금 안에서 칸보드를 읽지 않는다.
  const before = readTaskCard(id, path);
  // RUN-IDENTITY-TAGS-2 — 카드의 판(checklistVersion)을 알 때만 «그 판»에서 다시 읽는다. 판을 모르면 «판 모름»:
  // 개발 판의 같은 id 를 그 칸이라 짐작하지 않고 명시 태그만 담는다(나머지 «미기록»).
  const boardVersion = before?.checklistVersion;
  const lookup: RunIdentityCellLookup | undefined = input.checklistCell
    ?? (boardVersion !== undefined ? (checklistId: string) => readChecklistCellForBirth(checklistId, boardVersion) : undefined);
  const relookup = before && !before.identity && before.checklistId && lookup ? lookup(before.checklistId) : undefined;
  return updateTaskCard(path, id, (current) => {
    if (!current) return undefined;
    // 잠금 밖에서 읽은 칸은 «같은 칸 ⊕ 같은 판»일 때만 쓴다 — 그 사이 판이 바뀌었으면 옛 판의 신분을 새 카드에 적지 않는다.
    const sameCell = current.checklistId !== undefined && current.checklistId === before?.checklistId && current.checklistVersion === before?.checklistVersion;
    const cell = !current.identity && sameCell ? cellOnExpectedBoard(relookup, current.checklistVersion) : undefined;
    const identity = current.identity ? validateRunIdentity(current.identity) : confirmedRunIdentity(cell, {
      ...(current.checklistId ? { checklistId: current.checklistId } : {}),
      ...(cell?.version ? { version: cell.version } : {}),
      ...(current.seat ? { seat: current.seat } : {}),
    }, []);
    const from = runIdentityFieldText(identity, tag.key);   // 확인 안 된 칸은 «미기록»
    const to = tag.key === 'protect' ? String(tag.value) : tag.value;
    return { ...current, identity: applyRunIdentityTag(identity, tag), history: [...current.history, { at, event: RUN_TAG_CHANGE_EVENT, kind: RUN_TAG_CHANGE_EVENT, detail: `${tag.key} ${from}→${to}`, from, to, by: input.by, ...(input.reason ? { reason: input.reason } : {}) }] };
  });
}

/** RUN-IDENTITY-TAGS — 칸 읽기(기본): 칸보드 `version`(기본 = 개발 판)에서 `checklistId` 로 읽는다. 읽기 실패·빠칸은 조용히 `undefined`(= «모른다») — 호출자는 기본 신분을 세우지 않고 명시 태그만 담는다(나머지 «미기록»). */
export function readChecklistCellForBirth(checklistId: string, boardVersion?: string): { title?: string; priority?: string; version?: string } | undefined {
  try {
    const version = boardVersion ?? checklistDevVersion();
    const cell = listChecklist(version).items.find((item) => item.id === checklistId);
    return cell ? { title: cell.title, priority: cell.priority, version } : undefined;
  } catch { return undefined; }
}

/** 첫 수의 elanous 인자(진입점·--config-dir 앞붙임은 launcher 몫). */
export function launchArgs(card: Pick<TaskCard, 'text' | 'seat' | 'childLlm' | 'identity'>): string[] {
  const child = card.childLlm
    ? ['--child-llm-provider', card.childLlm.provider, '--child-llm-model', card.childLlm.model, ...(card.childLlm.effort ? ['--child-llm-effort', card.childLlm.effort] : [])]
    : [];
  const runPriority = runIdentityQueuePriority(card.identity);
  // Exact role model pins travel in ELANOUS_ROLE_LLM_*: harness say's argv parser only accepts provider[/tier].
  return ['harness', 'say', ...(card.seat ? ['--seat', card.seat] : []), '--substrate', 'pod', '--merge-by-host', ...(runPriority !== undefined ? ['--run-priority', String(runPriority)] : []), ...child, card.text];
}

/**
 * `landed` = 착지한 조각 id(② 감지가 채운다). 안 주면 «모른다» — 선행은 미착지로 보고(fail-closed)
 * 이유에 «착지 미확인»을 단다(착지했다/안 했다를 단정하지 않는다).
 * 미션 카드는 스스로 발사하지 않는다 · 아직 안 뜬 조각의 선행이 덜 착지했으면 `wait after <id>`.
 */
export function nextMoveFor(card: TaskCard, landed?: ReadonlySet<string>, deps: { ledgerDir?: string } = {}): TaskCardMove {
  // Completion callbacks record a shadow decision; do not suggest the live CLI here.
  if (card.pieces) return { kind: 'wait', reason: `미션 — 조각 ${card.pieces.length}장이 선후대로 발사된다` };
  if (card.alreadyDoneCandidate) return { kind: 'wait', reason: `main ${card.alreadyDoneCandidate.mainSha.slice(0, 12)} (검사 시점) 증거 명령 통과 — green 후보 · 주인 판정 대기` };
  const unmet = (card.after ?? []).filter((id) => !landed?.has(id));
  if (card.status !== 'launched' && unmet.length > 0) return { kind: 'wait', reason: `after ${unmet.join(', ')}${landed ? '' : ' · 착지 미확인'}` };
  if (card.status === 'handed') return { kind: 'launch', command: launchArgs(card), reason: '넘겨받은 과제 — 첫 발사' };
  if (card.status === 'launch-failed') return { kind: 'launch', command: launchArgs(card), reason: '직전 발사 실패 — 다시 발사' };
  // live-move·hand-move 줄(관측 기록)은 실패 사유가 아니다 — 그 줄을 뺀 마지막 칸이 사유다(live-move 줄 없는 카드는 종전과 같다).
  if (card.status === 'failed') return { kind: 'wait', reason: card.history.filter((item) => item.event !== LIVE_MOVE_HISTORY_EVENT && item.event !== LIVE_MOVE_RESULT_EVENT && item.event !== HAND_MOVE_HISTORY_EVENT).at(-1)?.detail ?? '런 실패 — PR·수확 가지 없음' };
  if (card.status === 'launched' && card.runId) {
    try {
      const ledger = loadRunLedger(card.runId, deps.ledgerDir ?? runLedgerDir());
      const terminal = ledger?.filter((entry) => entry.event === 'run-status').at(-1);
      if (terminal && ['succeeded', 'failed', 'cancelled', 'abandoned'].includes(String(terminal.data.runStatus))) {
        if (cardPrNumber(card) === undefined) return { kind: 'wait', reason: `런 원장 종료 — ${terminal.data.runStatus} · PR 없음` };
        return { kind: 'wait', reason: `런 원장 종료 — ${terminal.data.runStatus} · 그림자 재판정은 완료 훅이 기록` };
      }
    } catch { /* 원장 결손·손상은 종료로 단정하지 않는다. */ }
  }
  return { kind: 'wait', reason: '발사됨 — 런 멈춤을 슈퍼바이저 그림자 판단(task-agent.shadow-move)이 받는다' };
}

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** 발사기에 넘기는 연결 — env(`ELANOUS_RUN_ID`)를 자식 환경에 얹으면 하니스 런이 `runId` 로 돈다(`resolveRunIdentity` 상속). launchId 는 카드에만 남는 발사 토큰이다. */
export interface TaskLaunchContext { runId: string; launchId: string; env: Record<string, string>; /** exact untrimmed hand text (launch-utterance ledger pair) */ launchUtterance?: string; cardLabelContext?: TaskCardLabelContext; substrate?: 'pod'; podGoal?: string; effectiveChildProvider?: string }
/** 발사기가 «이 런 id 로 띄웠다»고 돌려주는 영수증 — 없으면 카드에 런 id 를 적지 않는다(추측하지 않는다). */
export interface TaskLaunchReceipt {
  runId?: string;
  /** HARNESS-PARENT-ON-MSB1 — 부모를 원격 호스트에서 띄웠다(ssh). 카드에 적어 `tasks show` 가 그 호스트의 원장을 당긴다. */
  parentHost?: { host: string; configDir?: string; pid?: number; log?: string };
}
export type TaskLauncher = (args: string[], cwd?: string, context?: TaskLaunchContext) => void | TaskLaunchReceipt | Promise<void | TaskLaunchReceipt>;

export interface HandTaskOptions {
  text: string;
  seat?: TaskSeat;
  checklistId?: string;
  completion?: TaskCard['completion'];
  /** `--project <id> --target <dir>` — target 은 존재 확인 뒤 절대 경로로 바꿔 싣는다. */
  project?: { id: string; target: string };
  /** 보드 소속 목표·이정표 id — 카드에 그대로 싣는다. */
  goal?: string;
  milestone?: string;
  live?: boolean;
  /** Production `tasks hand --live` guard; test launchers opt in explicitly. */
  preflightGoalDoneBoundary?: boolean;
  /** TA-LIVE-LAND-2 — `--ta-land`: card field `taLand` ⊕ launch env `ELANOUS_TA_LAND=1`. */
  taLand?: boolean;
  /** TASKS-HAND-CHILD-LLM — `<provider>/<model>`(`parseChildLlm`) ⊕ 선택 추론 노력. effort 만 주면 거부. */
  childLlm?: string;
  childLlmEffort?: string;
  /** Injected budget facts for a mission child; production reads the live launch-budget inputs just before launch. */
  childBudgetInputs?: () => Promise<BudgetInputs> | BudgetInputs;
  parentRoleLlm?: string[];
  tier?: TaskCard['tier'];
  /** TIER-SPLIT-BEFORE-LAUNCH — 조각 카드에 싣는 분해 연결(`tier-split.ts` 만 준다). */
  tierSplit?: TaskCard['tierSplit'];
  /** TIER-SPLIT-BEFORE-LAUNCH — 분해 실패 사유. 주면 카드를 발사 없이 failed(history `tier-split-failed`)로 남기고 launched:false 로 돌아온다. */
  tierSplitBlocked?: string;
  /** RUN-IDENTITY-TAGS — `tasks hand --tag k=v`(반복): 출생 신분을 덮는다. 목록 밖 값은 거부한다(`run-identity.js`). */
  tags?: string[];
  /** RUN-IDENTITY-TAGS — 칸 읽기 seam(우선순위·대표 표시). 주면 그 답이 최종이다(«칸 없음» 포함). */
  checklistCell?: RunIdentityCellLookup;
  /**
   * RUN-IDENTITY-TAGS-2 — 칸을 찾은 칸보드 판. 주면 그 판에서 `checklistId` 로 칸을 읽는다(`checklistCell` 이 없을 때).
   * 안 주면 «판 모름» — 다른 판의 같은 id(우선순위가 다를 수 있다)를 그 칸이라 짐작하지 않으므로 칸에서 파생되는
   * 신분 칸(class·care·protect·rights)을 확정하지 않는다(명시 `--tag` 만 담고 나머지 «미기록»).
   */
  checklistVersion?: string;
  statePath?: string;
  /** 시험에서만 조합 저장소를 바꿔 해석·거부를 검증한다. */
  compositionRoot?: string;
  /** `--live` 일 때만 불린다. */
  launcher?: TaskLauncher;
  /**
   * 2판 — launcher 'graph-run' 조합을 실제 graph run 으로 발사한다(기본 = src/graph-runner/runner.ts runGraph).
   * 시험은 이 seam 을 주입해 발사 인자(선택된 조합 경로 ⊕ GraphRunOptions)를 'calls' capture 로 검증한다.
   */
  graphRunner?: (path: string, options: GraphRunOptions) => Promise<GraphRunState>;
  /** Deterministic contract seam; production uses the pinned-main verifier. */
  prelaunchInspector?: (text: string, projectTarget?: string) => AlreadyDoneDecision;
  /** Test-only: inject Git calls into the production verifier; no CLI/config surface. */
  prelaunchGitRunnerForTest?: PrelaunchGitRunnerForTest;
  now?: () => Date;
  id?: string;
  /** 미션 조각으로 넘길 때 — 카드에 소속 미션·선후를 싣는다. */
  mission?: string;
  after?: string[];
  /** 착지한 조각 id — `after` 가 모두 여기 있어야 발사한다(② 의 자리). */
  landed?: ReadonlySet<string>;
  /** 카드에 그대로 싣는 칸(② 의 넘김 표지·착지 근거) — handTask 가 카드를 새로 적을 때 지워지지 않게. */
  cardFields?: Pick<TaskCard, 'pr' | 'goalId' | 'handed'>;
  /**
   * DRAFT-CLAIM-AUTO-2-FU — 손이 잡으려는 draft(PR)의 «지금» 관측값(라벨·갱신 시각·리뷰 러너).
   * 주면 `handTask` 가 손 수확(있으면) → `judgeDraftClaim` 을 거쳐 카드 `draftClaim` 에 기록한다. 거부면
   * 카드를 쓰기 전에 `TaskDraftClaimRejectedError`. 안 주면 종전과 똑같이 claim 을 하지 않는다(기본 동작 보존).
   */
  draftClaim?: HandTaskDraftClaim;
  /**
   * 있으면 카드 쓰기마다 잠금 안에서 디스크 카드를 보고 참일 때만 쓴다(② 의 claim 소유 확인).
   * 거짓이면 쓰지 않고 `TaskCardSupersededError` — 다른 넘김이 그 카드를 가져갔다(발사 전이면 발사하지 않는다).
   */
  writeGuard?: (current: TaskCard | undefined) => boolean;
}

/** `writeGuard` 가 거짓 — 다른 넘김이 카드를 가져갔다. 카드는 건드리지 않았다. */
export class TaskCardSupersededError extends Error {
  constructor(id: string) {
    super(`과제 카드를 다른 넘김이 가져갔다 — 쓰지 않았다: ${id}`);
    this.name = 'TaskCardSupersededError';
  }
}

/** `--live` 발사가 실패했다 — 카드는 launch-failed 로 남았다. */
export class TaskLaunchError extends Error {
  constructor(card: TaskCard, reason: string) {
    super(`발사 실패 (${card.id} → launch-failed): ${reason}`);
    this.name = 'TaskLaunchError';
  }
}

export interface HandTaskResult { card: TaskCard; move: TaskCardMove; mode: 'shadow' | 'live'; launched: boolean; cwd?: string }

/** Dispatch evidence for a handed deliverable card; unlike handTask, this never launches work. */
export function dispatchDeliverableCompletion(id: string, input: { ref: string; receipt?: boolean }, path: string, now: () => Date = () => new Date()): boolean {
  const card = readTaskCard(id, path);
  if (card?.completion !== 'deliverable' || !card.project?.target || card.pr !== undefined || card.status === 'failed' || card.status === 'launch-failed') return false;
  const evidence = checkCompletionEvidence('deliverable', { dir: card.project.target, ...input });
  if (judgeNextMove({ completion: card.completion, evidence }).move !== 'propose-green') {
    try { debug.log('task-agent', 'deliverable-rejected', { taskId: id, ref: input.ref, missing: evidence.missing }); } catch { /* fail-soft */ }
    return false;
  }
  const receiptEvidence = deliverableReceiptEvidence(evidence.ref);
  const at = now().toISOString();
  let closed = false;
  updateTaskCard(path, id, (current) => {
    if (current?.completion !== 'deliverable' || current.pr !== undefined || current.greenProposal || !current.project || current.project.target !== card.project?.target || current.status === 'failed' || current.status === 'launch-failed') return undefined;
    const fresh = checkCompletionEvidence('deliverable', { dir: current.project.target, ...input });
    if (judgeNextMove({ completion: current.completion, evidence: fresh }).move !== 'propose-green') return undefined;
    closed = true;
    return { ...current, greenProposal: { at, checklistId: current.checklistId ?? null, evidence: { [id]: receiptEvidence } } };
  });
  try { debug.log('task-agent', closed ? 'deliverable-closed' : 'deliverable-rejected', { taskId: id, ref: evidence.ref, ...(closed ? {} : { missing: ['already-proposed-or-changed'] }) }); } catch { /* fail-soft */ }
  return closed;
}

/**
 * ENTRANCE-EVIDENCE-COMMAND-ONLY — 증거 명령 줄의 «형태» 판정. 기존 TA-HAND-PREFLIGHT 의 계약 줄 «존재» 검사
 * (`inspectGoalDoneBoundary`)와 구분된다: 세 경계 줄이 이미 갖춰진 골에서 증거 명령 줄의 값이 명령 원문인지만 본다.
 * 설명 접미(예: `→ 0 fail`)와 백틱 장식은 줄마다 이유를 붙여 거부한다. 빈 값·누락은 존재 검사 몫이다.
 */
const GOAL_EVIDENCE_COMMAND_LINE = /^\s*(?:[-*]\s*)?완료 경계 증거 명령\s*:\s*(.*?)\s*$/;
const GOAL_EVIDENCE_COMMAND_DESCRIPTION_SUFFIX = /->|→/;
const GOAL_EVIDENCE_COMMAND_BACKTICK_DECORATION = /`/;
const GOAL_EVIDENCE_COMMAND_TYPECHECK_DECORATION = /·\s*typecheck\b/i;

function goalEvidenceCommandFormViolations(document: string): string[] {
  const violations: string[] = [];
  for (const line of linesOutsideFencedCode(document)) {
    const value = GOAL_EVIDENCE_COMMAND_LINE.exec(line.text)?.[1];
    if (value === undefined || !value.trim()) continue;
    if (GOAL_EVIDENCE_COMMAND_BACKTICK_DECORATION.test(value)) violations.push(`백틱 장식: ${value}`);
    else if (GOAL_EVIDENCE_COMMAND_DESCRIPTION_SUFFIX.test(value)) violations.push(`설명 접미: ${value}`);
    else if (GOAL_EVIDENCE_COMMAND_TYPECHECK_DECORATION.test(value)) violations.push(`설명 접미: ${value}`);
  }
  return violations;
}

/**
 * FIRST-LINE-PATH-LIST-ONLY — 골 «첫 줄»의 형태 판정: `대상 경로:` 뒤의 «경로 조각» 에는 괄호·줄번호·덧말이 붙지 않는다.
 * 첫 줄만 보는 판정은 `parseAskTargetPathHintsResult` 가 이미 하므로 새 파서를 만들지 않고 그 결과에 얹는다:
 * 파서가 통과시킨 경로(`paths`)와 버린 조각(`rejected`)을 한 줄씩 보고, «경로 조각»(디렉터리 구분자·확장자가 있는 것)에
 * 장식이 붙었을 때만 이유를 붙여 거부한다. `· 동작: a 고침` 같은 «산문 조각» 은 경로 조각이 아니다 —
 * 조각 분해가 합성하는 손 문면(`handTaskWithTierSplit` 경로)이 그 모양으로 첫 줄을 만든다.
 * 라벨이 없는 문면(첫 줄이 대상 경로 목록이 아닌 손)은 이 축의 몫이 아니다 — 그 모양은 지금과 같다.
 */
const FIRST_LINE_PATH_DECORATIONS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: '괄호 장식', pattern: /[()[\]{}（）【】]/ },
  { label: '줄번호', pattern: /:\d/ },
  { label: '덧말', pattern: /->|→|—|–/ },
];

function firstLinePathListViolations(hints: AskTargetPathHintsParseResult): string[] {
  if (hints.labelMissing) return [];
  const violations: string[] = [];
  for (const piece of [...hints.paths, ...hints.rejected.map((rejection) => rejection.fragment.trim())]) {
    if (!/[/.]/.test(piece)) continue;
    const decoration = FIRST_LINE_PATH_DECORATIONS.find((entry) => entry.pattern.test(piece));
    if (decoration) violations.push(`${decoration.label}: ${piece}`);
    // 공백만으로 거부하지 않는다 — «경로 자체에 공백»(`docs/foo bar.md`)은 지금처럼 통과한다.
    // 덧말은 공백 뒤에 «경로가 아닌 말»이 붙은 경우만이다(마지막 조각에 구분자·확장자가 없다).
    else {
      const trailing = piece.split(/\s+/).slice(1).join(' ').trim();
      if (trailing !== '' && !/[/.]/.test(trailing)) violations.push(`덧말(공백 섞임): ${piece}`);
    }
  }
  return violations;
}

export async function handTask(opts: HandTaskOptions): Promise<HandTaskResult> {
  const { normalizeEvidenceCommandLines } = await import('./evidence-command-normalize.js');
  const normalized = normalizeEvidenceCommandLines(opts.text.trim());
  let text = normalized.text;
  if (!text) throw new Error('과제 한 줄이 비어 있다');
  for (const warning of normalized.warnings) {
    console.error(`⚠ ${warning}`);
    try { debug.log('task-agent.hand', 'evidence-command-warning', { warning }); } catch { /* fail-soft */ }
  }
  const path = opts.statePath ?? taskAgentStatePath();
  const targetPathHints = parseAskTargetPathHintsResult(text);
  const targetPaths = canonicalTargetPaths(targetPathHints.paths);
  if (opts.seat !== undefined && !TASK_SEATS.includes(opts.seat)) throw new Error(`자리는 ${TASK_SEATS.join('|')} 중 하나다: ${opts.seat}`);
  if (opts.completion !== undefined && !COMPLETION_KINDS.includes(opts.completion)) throw new Error(`종결 종류는 ${COMPLETION_KINDS.join('|')} 중 하나다: ${opts.completion}`);
  for (const [flag, value] of [['--goal', opts.goal], ['--milestone', opts.milestone]] as const) {
    if (value !== undefined && (!value.trim() || /\p{Cc}/u.test(value))) throw new Error(`${flag} id 가 비었거나 제어 문자를 담았다: ${JSON.stringify(value)}`);
  }
  if (opts.childLlmEffort !== undefined && opts.childLlm === undefined) throw new Error('--child-llm-effort 는 --child-llm <provider>/<model> 과 함께 준다');
  if (opts.tier !== undefined && !['하', '중', '상', '특'].includes(opts.tier)) throw new Error(`--tier 는 하|중|상|특 중 하나다: ${opts.tier}`);
  const tierSplitBlocked = opts.tierSplitBlocked;
  // RUN-IDENTITY-TAGS — 출생 신분: 칸 우선순위(P0 = critical·special·protect · P1 = normal · 그 외 normal)·대표 표시에서 단다.
  // `--tag k=v`(반복) 이 덮는다 — 칸·태그 없는 손은 오늘 모양 그대로다(신분 없음). 목록 밖 값은 카드를 적기 전에 거부한다(`run-identity.js` 정본).
  const birthCell = opts.checklistId === undefined ? undefined
    // 주입한 칸 조회가 있으면 그 답(«칸 없음» 포함)이 최종이다 — 칸보드는 조회기가 없을 때만 읽는다.
    : opts.checklistCell !== undefined ? cellOnExpectedBoard(opts.checklistCell(opts.checklistId), opts.checklistVersion)
    // 판을 받았으면 «그 판»에서 읽는다 · 판을 모르면 읽지 않는다(개발 판의 같은 id 를 그 칸이라 짐작하지 않는다 — «미기록»).
    : opts.checklistVersion !== undefined ? readChecklistCellForBirth(opts.checklistId, opts.checklistVersion) : undefined;
  const birthTags = opts.tags ?? [];
  // 칸을 줬는데 칸보드에서 못 읽었으면(조회 실패·빠칸) 우선순위를 «모른다» — 기본 normal 을 사실처럼 적지 않고 신분을 비운다(화면은 «미기록»).
  // 명시 `--tag` 가 있으면 «그 태그만» 신분에 담는다 — 칸을 못 읽었으면 덮지 않은 칸(care·rights·protect…)은 «미기록»으로 남는다(기본값으로 확정하지 않는다).
  const identity = birthTags.length === 0 && (opts.checklistId === undefined || birthCell === undefined) ? undefined
    : confirmedRunIdentity(birthCell, {
      ...(opts.checklistId ? { checklistId: opts.checklistId } : {}),
      ...(birthCell?.version ? { version: birthCell.version } : {}),
      ...(opts.seat ? { seat: opts.seat } : {}),
      launcher: 'hand',
    }, birthTags);
  const childLlm = opts.childLlm !== undefined ? parseChildLlm(opts.childLlm, opts.childLlmEffort) : undefined;
  const parentRolePins = taskParentRolePinsForChild(opts.parentRoleLlm ?? [], childLlm);
  let parentRoleEnv = taskParentRoleEnv(parentRolePins); // validate before writing the card
  const completion = opts.completion ?? 'code-pr';
  const selected = selectTaskComposition(completion, opts.compositionRoot);
  // 2판 — launcher 'graph-run' 조합(단위 해석까지 완료)은 실제 graph run 으로 발사한다. 더 이상 거부하지 않는다.
  const graphRun = selected.composition && selected.launcher === 'graph-run' && !selected.error && selected.unitsResolved
    ? selected.composition : undefined;
  const graphRunPath = graphRun ? join(opts.compositionRoot ?? COMPOSITION_ROOT, graphRun.file) : undefined;
  const selectionFailure = graphRun ? undefined
    : !selected.composition ? `조합 없음: graphs/work/${completion}.yaml`
    : selected.error ?? (selected.launcher === 'graph-run' && !selected.unitsResolved
      ? `조합 단위 미해석: ${selected.composition.file} — 대상 unit: ${selected.missingUnits.length ? selected.missingUnits.join(', ') : '해석 실패'} (graph-run 발사는 단위 해석이 필요하다)`
      // DEFAULT-HANDS — 코드 하니스(harness-say 자식 구현 런)는 개발자 팩(code-pr)만 쓴다.
      : !DEFAULT_HANDS[completion].codeHarness && selected.launcher === 'harness-say'
        ? `조합 실행기 없음: ${selected.composition.file} — ${completion} 은 «실행·조사» 손이라 코드 하니스(harness-say)를 쓰지 않는다(개발자 팩 전용)`
        : selected.launcher === undefined
          ? `조합 실행기 없음: ${selected.composition.file} (발사 가능한 launcher: harness-say · graph-run)` : undefined);
  let project: TaskCard['project'];
  let targetIsGit: boolean | null = null;
  if (opts.project) {
    if (!opts.project.id.trim()) throw new Error('--project id 가 비어 있다');
    const target = resolve(opts.project.target);
    let isDir = false;
    try { isDir = statSync(target).isDirectory(); } catch { /* 없음 */ }
    if (!isDir) throw new Error(`대상 디렉터리가 없습니다: ${target}`);
    targetIsGit = isGitWorkTree(target);
    // 코드 종결(code-pr · 비면 code-pr)은 git 대상만 — 그 밖의 종결 종류는 git 이 아닌 폴더도 받는다(같은 판정을 harness-target 과 공유).
    const codeCompletion = (opts.completion ?? 'code-pr') === 'code-pr';
    const selection = resolveDaemonHarnessTarget({ configured: target, cwd: target, isGitRepo: () => targetIsGit === true, allowNonGit: !codeCompletion });
    if (!selection.ok) throw new Error(`코드 종결은 git 대상이 필요 — --completion 을 고르거나 git init: ${target}`);
    project = { id: opts.project.id, target: selection.repo };
  }
  const now = (opts.now ?? (() => new Date()))();
  const id = opts.id ?? `${TASK_CARD_PREFIX}${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
  const mode = opts.live ? 'live' : 'shadow';
  // DRAFT-CLAIM-AUTO-2-FU — claim 은 카드를 쓰기 «전»에 판정한다(거부면 원장에 아무것도 남기지 않는다).
  // 견줄 상대는 카드 원장(디스크)의 다른 카드다 — 손이 들고 있는 사본이 아니라 정본을 본다.
  const draftClaim = opts.draftClaim
    ? await resolveHandDraftClaim({
      claim: opts.draftClaim, cards: Object.values(readState(path).tasks ?? {}), cardId: id,
      ...(opts.seat !== undefined ? { seat: opts.seat } : {}), now, ask: text,
    })
    : undefined;
  let card: TaskCard = {
    id, text,
    ...(!targetPathHints.labelMissing ? { targetPaths } : {}),
    ...(opts.seat ? { seat: opts.seat } : {}),
    ...(opts.checklistId ? { checklistId: opts.checklistId } : {}),
    ...(opts.checklistVersion !== undefined ? { checklistVersion: opts.checklistVersion } : {}),
    ...(opts.completion ? { completion: opts.completion } : {}),
    ...(selected.composition ? { composition: selected.composition, graphSelectedBy: 'completion' as const } : {}),
    unitsResolved: selected.unitsResolved,
    missingUnits: selected.missingUnits,
    ...(project ? { project } : {}),
    ...(opts.goal ? { goal: opts.goal } : {}),
    ...(opts.milestone ? { milestone: opts.milestone } : {}),
    ...(opts.taLand === true ? { taLand: true as const } : {}),
    ...(childLlm ? { childLlm } : {}),
    ...(parentRolePins.length ? { parentRoleLlm: parentRolePins } : {}),
    ...(opts.tier ? { tier: opts.tier } : {}),
    ...(opts.tierSplit ? { tierSplit: opts.tierSplit } : {}),
    ...(identity ? { identity } : {}),
    createdAt: now.toISOString(),
    status: selectionFailure || tierSplitBlocked !== undefined ? 'failed' : 'handed',
    history: [
      ...(selectionFailure ? [{ at: now.toISOString(), event: !selected.composition ? 'composition-missing'
        : selected.error ? 'composition-invalid' : 'composition-launcher-unavailable', detail: selectionFailure }] : []),
      ...(tierSplitBlocked !== undefined ? [{ at: now.toISOString(), event: 'tier-split-failed', detail: `tier-split-failed: ${tierSplitBlocked}` }] : []),
    ],
    ...(opts.mission ? { mission: opts.mission, after: [...(opts.after ?? [])] } : {}),
    ...(opts.cardFields?.pr !== undefined ? { pr: opts.cardFields.pr } : {}),
    ...(opts.cardFields?.goalId !== undefined ? { goalId: opts.cardFields.goalId } : {}),
    ...(opts.cardFields?.handed !== undefined ? { handed: opts.cardFields.handed } : {}),
    ...(draftClaim ? { draftClaim } : {}),
  };
  // 2판 graph-run 조합의 다음 수는 실제 graph run — harness say 인자를 조립하지 않는다.
  let move = graphRun && graphRunPath ? { kind: 'launch' as const, command: ['graph', 'run', graphRunPath], reason: `조합 launcher graph-run — ${graphRun.file}` } satisfies TaskCardMove
    : selectionFailure ? undefined : nextMoveFor(card, opts.landed);
  // 분해 실패로 막은 카드는 wait(failed 사유)가 정답이다 — 던지지 않고 카드를 적은 뒤 발사 0 으로 돌아간다.
  if (move && move.kind !== 'launch' && tierSplitBlocked === undefined) throw new Error(`발사할 수 없는 과제다 — ${move.reason}`);
  const guard = opts.writeGuard;
  const writeCard = (target: string, next: TaskCard): void => {
    if (next.draftClaim?.body !== undefined && opts.draftClaim) {
      let written = false;
      const saved = updateTaskCard(target, next.id, (current, tasks) => {
        if (guard && !guard(current)) return undefined;
        // 같은 파일 잠금 안에서 판정과 기록을 마친다. 댓글은 잠금 밖에서 기록 성공 후 게시한다.
        const judgement = judgeDraftClaim({
          draft: { number: opts.draftClaim!.pr, labels: opts.draftClaim!.labels,
            ...(opts.draftClaim!.updatedAt !== undefined ? { updatedAt: opts.draftClaim!.updatedAt } : {}),
            ...(opts.draftClaim!.runId !== undefined ? { runId: opts.draftClaim!.runId } : {}) },
          cards: Object.values(tasks), cardId: next.id,
          ...(opts.seat !== undefined ? { seat: opts.seat } : {}), now,
        });
        if (!judgement.ok) throw new TaskDraftClaimRejectedError(next.id, judgement.reason);
        written = true;
        const claim: TaskCardDraftClaimRecord = { ...next.draftClaim!, body: judgement.body, reclaim: judgement.reclaim, mode,
          ...(judgement.ownerId !== undefined ? { ownerId: judgement.ownerId } : {}) };
        const { pr: _stalePr, goalId: _staleGoal, refSource: _staleSource, ...base } = next;
        const evidence = current ?? next;
        return { ...base, draftClaim: claim,
          ...(evidence.pr !== undefined ? { pr: evidence.pr } : {}),
          ...(evidence.goalId !== undefined ? { goalId: evidence.goalId } : {}),
          ...(evidence.refSource ? { refSource: evidence.refSource } : {}) };
      });
      if (!written) throw new TaskCardSupersededError(next.id);
      if (saved) card = saved;
      return;
    }
    if (!guard) { writeTaskCards(target, [next]); return; }
    const owned = { ok: false };
    // 착지 근거(pr·goalId)는 `recordPieceRef` 소유 — claim 뒤에 적힌 최신 근거를 디스크에서 이어 받는다.
    updateTaskCard(target, next.id, (current) => {
      if (!guard(current)) return undefined;
      owned.ok = true;
      // next 의 옛 근거는 버리고 디스크의 근거로 «교체»한다 — 정정된 근거 옆에 옛 근거가 되살아나지 않게.
      const { pr: _stalePr, goalId: _staleGoal, refSource: _staleSource, ...base } = next;
      return { ...base, ...(current?.pr !== undefined ? { pr: current.pr } : {}), ...(current?.goalId !== undefined ? { goalId: current.goalId } : {}), ...(current?.refSource ? { refSource: current.refSource } : {}) };
    });
    if (!owned.ok) throw new TaskCardSupersededError(next.id);
  };
  // Production Pod launches use the remote-parent lint's shared boundary judge.
  // Injected launchers are test seams and opt in explicitly at the contract test.
  if (opts.live && opts.preflightGoalDoneBoundary && !selectionFailure && tierSplitBlocked === undefined && move?.kind === 'launch') {
    readTaskAgentState(path);
    const drafted = draftMissingGoalDoneBoundary(text, targetPaths);
    if (drafted.added.length > 0) {
      text = drafted.document;
      card = { ...card, text };
      move = graphRun && graphRunPath ? { kind: 'launch' as const, command: ['graph', 'run', graphRunPath], reason: `조합 launcher graph-run — ${graphRun.file}` } : nextMoveFor(card, opts.landed);
      try { debug.log('task-agent.hand', 'boundary-autodrafted', { taskId: id, labels: drafted.added, targetPathCount: targetPaths.length }); } catch { /* fail-soft */ }
    }
    const { missing } = inspectGoalDoneBoundary(text);
    if (missing.length > 0) throw new Error(`goal-revision-required: 완료 경계 누락 ${missing.join(' · ')}`);
    // ENTRANCE-EVIDENCE-COMMAND-ONLY — 존재 검사와 구분된 형태 판정: 증거 명령 줄은 명령 원문만 받는다.
    const formViolations = goalEvidenceCommandFormViolations(text);
    if (formViolations.length > 0) {
      throw new Error(`goal-revision-required: 완료 경계 증거 명령은 명령 원문이어야 한다 ${formViolations.join(' · ')} — 증거 명령 줄에 설명 접미(예: → 0 fail)나 백틱 장식을 붙이지 말고 명령만 적은 뒤 다시 넘기세요`);
    }
    // FIRST-LINE-PATH-LIST-ONLY — 첫 줄 형태 판정(발사 전 거부): 괄호·줄번호·덧말이 붙은 골은 자식을 띄우지 않는다.
    // 카드 기록(writeCard)과 launcher 호출 뒤로 밀리면 «발사 전 거부·카드 0» 이 깨지므로 이 자리에서 던진다.
    const firstLineViolations = firstLinePathListViolations(targetPathHints);
    if (firstLineViolations.length > 0) {
      try { debug.log('task-agent.hand', 'first-line-path-list-rejected', { card: id, violations: firstLineViolations }); } catch { /* fail-soft */ }
      throw new Error(`goal-revision-required: 골 첫 줄은 «대상 경로:» 뒤에 경로 목록만 적어야 한다 ${firstLineViolations.join(' · ')} — 괄호·줄번호·덧말을 떼고 경로만 적은 뒤 다시 넘기세요`);
    }
  }
  writeCard(path, card);
  try { debug.log('task-agent.hand', 'target-paths', { card: id, count: targetPaths.length, labelMissing: targetPathHints.labelMissing }); } catch { /* fail-soft */ }
  try { debug.log('task-agent.graph-select', !selected.composition ? 'composition-missing' : selected.error ? 'composition-invalid' : 'composition-selected', {
    completion, file: selected.composition?.file ?? `graphs/work/${completion}.yaml`,
    // DEFAULT-HANDS — 어느 손으로 나가는지(«개발»/«실행·조사»)와 코드 하니스 여부를 선택 관측에 싣는다.
    hand: DEFAULT_HANDS[completion].hand, codeHarness: DEFAULT_HANDS[completion].codeHarness,
    unitsResolved: selected.unitsResolved, missingUnits: selected.missingUnits,
    ...(selected.error ? { error: selected.error } : {}),
  }); } catch { /* fail-soft */ }
  if (tierSplitBlocked !== undefined) return { card, move: move ?? nextMoveFor(card), mode, launched: false, ...(project ? { cwd: project.target } : {}) };
  if (selectionFailure) throw new Error(`${selectionFailure} (카드 ${id})`);
  if (!move || move.kind !== 'launch') throw new Error('조합 선택 뒤 발사 수가 없다');
  if (opts.live && opts.draftClaim?.postComment && card.draftClaim?.body !== undefined) {
    let postedTo: string | undefined;
    try {
      postedTo = await opts.draftClaim.postComment(opts.draftClaim.pr, card.draftClaim.body);
    } catch (error) {
      // 댓글이 없으면 «살아 있는» 예약도 남기지 않는다. 다음 손이 다시 claim 할 수 있다.
      card = updateTaskCard(path, card.id, (current) => current?.draftClaim
        ? { ...current, draftClaim: { ...current.draftClaim, body: undefined } } : undefined) ?? card;
      throw error;
    }
    if (postedTo !== undefined) {
      card = updateTaskCard(path, card.id, (current) => current?.draftClaim
        ? { ...current, draftClaim: { ...current.draftClaim, postedTo } } : undefined) ?? card;
    }
    try { debug.log('task-agent.draft-claim', 'comment-posted', { card: id, pr: opts.draftClaim.pr,
      ...(postedTo !== undefined ? { postedTo } : {}) }); } catch { /* fail-soft */ }
  }
  try { debug.log('task-agent', 'handed', { taskId: id, seat: card.seat ?? null, checklistId: card.checklistId ?? null, mode, projectId: project?.id ?? null, targetIsGit, taLand: card.taLand === true, runPriority: card.identity ? runPriorityClass(card.identity) : null }); } catch { /* fail-soft */ }
  if (childLlm) {
    try { debug.log('task-agent', 'child-llm', { taskId: id, input: opts.childLlm, provider: childLlm.provider, model: childLlm.model, effort: childLlm.effort ?? null, mode }); } catch { /* fail-soft */ }
  }
  if (mode === 'shadow') return { card, move, mode, launched: false, ...(project ? { cwd: project.target } : {}) };
  // 2판 — launcher 'graph-run' 조합은 launcher(harness say 발사기) 대신 실제 graph run 진입점(runGraph)으로 발사한다.
  if (graphRun && graphRunPath) {
    const runId = mintRunId();
    const launchId = newLaunchUtteranceId();
    recordLaunchUtterance({ source: 'hand', utterance: opts.text, launchId });
    let state: GraphRunState;
    try {
      state = await (opts.graphRunner ?? runGraph)(graphRunPath, { runId, input: { ask: text }, quiet: true });
    } catch (error) {
      // 조합 파일·대상 node가 없으면 runGraph 가 구체 사유로 던진다 — 임의 성공 처리하지 않는다.
      const reason = `graph run 실패: ${error instanceof Error ? error.message : String(error)}`;
      const failed: TaskCard = { ...card, status: 'launch-failed', runId, launchId,
        history: [...card.history, { at: (opts.now ?? (() => new Date()))().toISOString(), event: 'launch-failed', detail: reason, runId }] };
      writeCard(path, failed);
      try { debug.log('task-agent', 'launch-failed', { taskId: id, seat: card.seat ?? null, reason }); } catch { /* fail-soft */ }
      throw new TaskLaunchError(failed, reason);
    }
    const at = (opts.now ?? (() => new Date()))().toISOString();
    const ok = state.status === 'done';
    // 실패 종료도 구체 blocker(종료 상태·이유·마지막 node)를 기록한다 — 임의 성공 처리하지 않는다.
    const blocker = ok ? undefined : `graph run 종료 상태 ${state.status}${state.reason ? ` — ${state.reason}` : ''}`
      + `${state.nodes.length ? ` — 마지막 node ${state.nodes.at(-1)?.nodeId} (ok=${state.nodes.at(-1)?.ok})` : ' — node 없음'}`;
    const launchedGraph: TaskCard = { ...card, status: ok ? 'launched' : 'failed', runId: state.runId, launchId,
      history: [...card.history,
        { at, event: 'launch', detail: `graph run ${graphRunPath} (run ${state.runId})` },
        { at, event: 'run-bound', detail: state.runId, runId: state.runId },
        ...(blocker ? [{ at, event: 'graph-run-failed', detail: blocker, runId: state.runId }] : [])] };
    writeCard(path, launchedGraph);
    try { debug.log('task-agent', 'launched', { taskId: id, seat: card.seat ?? null, runId: state.runId }); } catch { /* fail-soft */ }
    return { card: launchedGraph, move, mode, launched: true, ...(project ? { cwd: project.target } : {}) };
  }
  if (!opts.launcher) throw new Error('--live 인데 launcher 가 없다');
  let prelaunch: AlreadyDoneDecision;
  try { prelaunch = completion === 'code-pr'
    ? (opts.prelaunchInspector ?? ((input, target) => inspectPrelaunchAlreadyDone(input, target,
      opts.prelaunchGitRunnerForTest ? { runGit: opts.prelaunchGitRunnerForTest } : {})))(text, project?.target)
    : { reason: 'completion-not-code-pr' }; }
  catch { prelaunch = { reason: 'prelaunch-unmeasured' }; }
  try { debug.log('task-agent', 'prelaunch-already-done', { taskId: id, result: prelaunch.reason,
    mainSha: prelaunch.candidate?.mainSha ?? null, command: prelaunch.candidate?.command ?? null }); } catch { /* fail-soft */ }
  if (prelaunch.candidate) {
    const candidate: TaskCard = { ...card, alreadyDoneCandidate: { ...prelaunch.candidate, at: (opts.now ?? (() => new Date()))().toISOString() },
      history: [...card.history, { at: (opts.now ?? (() => new Date()))().toISOString(), event: 'already-done-candidate',
        detail: `${prelaunch.candidate.repository} main ${prelaunch.candidate.mainSha} · rc=0 · ${prelaunch.candidate.command}` }] };
    writeCard(path, candidate);
    return { card: candidate, move: nextMoveFor(candidate), mode, launched: false, ...(project ? { cwd: project.target } : {}) };
  }
  // A mission parent can carry its original explicit child model into later pieces. Recheck that model
  // immediately before each launch; an exhausted provider must not pin every following child to the same stop.
  if (opts.mission && card.childLlm && (card.childLlm.provider === 'grok' || card.childLlm.provider === 'openai-codex')) {
    let inputs: BudgetInputs | undefined;
    try { inputs = await (opts.childBudgetInputs ?? readBudgetInputsLive)(); }
    catch (error) {
      try { debug.log('task-agent', 'child-model-reselect-unavailable', { taskId: id,
        reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
      catch { /* observation is fail-soft */ }
    }
    if (inputs) {
      const { harnessLaunchBudgetDecision } = await import('../execution-loop/launch-gate.js');
      const current = harnessLaunchBudgetDecision(inputs, { childLlmProvider: card.childLlm.provider,
        childLlmModel: card.childLlm.model }).decision;
      if (current.action === 'stop' || current.action === 'wait-reset') {
        const alternatives = inputs.preference.chain.filter((slot) => slot.provider !== card.childLlm!.provider);
        const next = alternatives.map((slot) => harnessLaunchBudgetDecision(inputs, {
          childLlmProvider: slot.provider, ...(slot.model ? { childLlmModel: slot.model } : {}),
        }).decision).find((decision) => decision.action === 'proceed' || decision.action === 'next-provider');
        if (next?.provider) {
          const from = card.childLlm;
          const model = next.model ?? (await import('../self-dev/dev-cli.js')).defaultChildLlmModel(next.provider);
          const to: TaskChildLlm = { provider: next.provider, model };
          const nextParentRoleEnv = taskParentRoleEnv(taskParentRolePinsForChild(opts.parentRoleLlm ?? [], to));
          const at = (opts.now ?? (() => new Date()))().toISOString();
          card = { ...card, childLlm: to, history: [...card.history, { at, event: 'child-model-reselected',
            detail: `${from.provider}/${from.model} → ${to.provider}/${to.model}: ${current.reasons.join(' · ')}` }] };
          parentRoleEnv = nextParentRoleEnv;
          move = { ...move!, command: launchArgs(card) };
          writeCard(path, card);
          try { debug.log('task-agent', 'child-model-reselected', { taskId: id, from, to, reason: current.reasons, mission: opts.mission }); }
          catch { /* observation is fail-soft */ }
        }
      }
    }
  }
  // Only the code-PR harness Pod consumes podGoal. Keep the card and other launchers unchanged.
  const podLaunch = completion === 'code-pr' && selected.launcher === 'harness-say';
  let childGoal = card.text;
  if (podLaunch) {
    const configuredRepo = project ? undefined : getUserConfig().harness?.defaultRepo;
    const knowhowRepo = project?.target ?? configuredRepo ?? resolve(import.meta.dir, '../..');
    const knowhow = selectKnowhowPack(knowhowRepo, card.text, targetPaths);
    if (knowhow.text) childGoal = `${knowhow.text}\n\n${card.text}`;
    let repoRevision: string | null = null;
    try {
      const head = execFileSync('git', ['-C', knowhowRepo, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^[0-9a-f]{40,64}$/i.test(head)) repoRevision = head;
    } catch { /* The source may be absent; reason=source-unreadable records that boundary. */ }
    try { debug.log('task-agent', 'knowhow-pack', { taskId: id, ids: knowhow.ids, bytes: knowhow.bytes, injected: knowhow.bytes > 0,
      reason: knowhow.reason, repoPath: knowhowRepo, repoRevision,
      repoSource: project ? 'project' : configuredRepo ? 'harness.defaultRepo' : 'package' }); } catch { /* fail-soft */ }
  }
  const runId = mintRunId();
  const launchId = newLaunchUtteranceId();
  recordLaunchUtterance({ source: 'hand', utterance: opts.text, launchId });
  const context: TaskLaunchContext = { runId, launchId, launchUtterance: opts.text, env: { [HARNESS_RUN_ID_ENV]: runId, ELANOUS_TASK_CARD_ID: card.id,
    ...parentRoleEnv,
    ...(cardPrNumber(card) ? { ELANOUS_TASK_BOUND_PR: String(cardPrNumber(card)) } : {}),
    ...(card.checklistId ? { ELANOUS_POD_SLOT_ID: card.checklistId } : {}),
    ...(card.seat ? { ELANOUS_POD_OWNER_KIND: 'seat', ELANOUS_POD_OWNER_ID: card.seat } : {}),
    ...(card.taLand ? { [TA_LAND_ENV]: '1' } : {}) }, cardLabelContext: taskCardLabelContext(card),
    // An omitted card provider uses the established Pod default. Carry the effective value explicitly so
    // remote-parent code never has to infer a provider from the serialized CLI argv.
    effectiveChildProvider: card.childLlm?.provider ?? 'openai-codex',
    ...(podLaunch ? { substrate: 'pod' as const, podGoal: childGoal } : {}) };
  let receipt: void | TaskLaunchReceipt;
  try {
    receipt = await opts.launcher(podLaunch ? [...move.command!.slice(0, -1), childGoal] : move.command!, project?.target, context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed: TaskCard = { ...card, status: 'launch-failed', history: [
      ...card.history.filter((entry) => entry.event === 'child-model-reselected'),
      { at: (opts.now ?? (() => new Date()))().toISOString(), event: 'launch-failed', detail: reason },
    ] };
    writeCard(path, failed);
    try { debug.log('task-agent', 'launch-failed', { taskId: id, seat: card.seat ?? null, reason }); } catch { /* fail-soft */ }
    throw new TaskLaunchError(failed, reason);
  }
  const launchedAt = (opts.now ?? (() => new Date()))().toISOString();
  const receivedRunId = receipt && typeof receipt.runId === 'string' ? receipt.runId.trim() : '';
  // 넘긴 런 id 와 «같은» 영수증만 — 다른 id 면 env 로 넘긴 런과 카드가 어긋난다(묶지 않는다).
  const boundRunId = receivedRunId && receivedRunId === runId && normalizeRunId(receivedRunId) === receivedRunId ? receivedRunId : undefined;
  if (receivedRunId && !boundRunId) {
    try { debug.log('task-agent', 'card-run-unbound', { card: id, launchId, expected: runId, received: receivedRunId }); } catch { /* fail-soft */ }
  }
  const launched: TaskCard = {
    ...card, status: 'launched',
    ...(boundRunId ? { runId: boundRunId, launchId } : {}),
    ...(receipt && receipt.parentHost && typeof receipt.parentHost.host === 'string' ? { parentHost: receipt.parentHost } : {}),
    history: [
      ...card.history.filter((entry) => entry.event === 'child-model-reselected'),
      { at: launchedAt, event: 'launch', detail: `${receipt && receipt.parentHost ? `[parent@${receipt.parentHost.host} · PR 까지만] ` : ''}${move.command!.join(' ')}` },
      ...(boundRunId ? [{ at: launchedAt, event: 'run-bound', detail: boundRunId, runId: boundRunId }] : []),
    ],
  };
  writeCard(path, launched);
  // INFLIGHT-REGISTRY — 출발 때 맥락을 남긴다(머지 때 같은 파일 줄의 의도를 스마트 머지가 읽는다 · 착지하면 지운다).
  try {
    const [head = '', ...rest] = text.split(/\r?\n/);
    const intentLines = (/^\s*(?:대상\s*경로|target\s*paths?)\s*[:：]/i.test(head) ? rest : [head, ...rest])
      .filter((line) => !/^\s*(?:[-*]\s*)?완료 경계 (?:코드|실물|증거 명령)\s*:/.test(line));
    registerInflight({
      runId: boundRunId ?? runId, cell: card.checklistId ?? card.id, cardId: card.id,
      intent: intentLines.join(' ').trim() || text,
      files: parseAskTargetPathHints(text),
    }, { path: join(dirname(path), INFLIGHT_REGISTRY_FILE), ...(opts.now ? { now: opts.now } : {}) });
  } catch (error) {
    try { debug.log('pr-tool.inflight', 'register-failed', { taskId: id, error: String((error as Error)?.message ?? error).slice(0, 200) }, { level: 'warn' }); } catch { /* fail-soft */ }
  }
  try { debug.log('task-agent', 'launched', { taskId: id, seat: card.seat ?? null, runId: boundRunId ?? null }); } catch { /* fail-soft */ }
  if (boundRunId) {
    try { debug.log('task-agent', 'card-run-bound', { card: id, runId: boundRunId, launchId }); } catch { /* fail-soft */ }
  }
  return { card: launched, move, mode, launched: true, ...(project ? { cwd: project.target } : {}) };
}
