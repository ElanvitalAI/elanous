/**
 * TASK-AGENT 과제 넘기기 문 — `elanous task hand "<한 줄>"` (RFC-task-agent-any-task-to-completion §A9 표 1행 · R3).
 *
 * - 과제 카드를 실행부와 «같은» 상태 파일(`effectiveInstanceRoot()/task-agent-actions.json`)의 `tasks` 칸에 적는다.
 *   종전 칸(landingDay·landingsToday·failureCounts)은 그대로 두고 덧붙이기만 한다(하위 호환 — 실행부 쓰기는 `...disk` 로 보존).
 * - 첫 수는 «launch» = `harness say [--seat <자리>] --substrate pod --merge-by-host "<원문>"`.
 * - 기본은 SHADOW: 카드와 명령만 남기고 아무것도 띄우지 않는다. `--live` 일 때만 주입된 launcher 로 띄운다.
 * - 관측: `debug.log('task-agent', 'handed', {taskId, seat, checklistId, mode, runPriority})`.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { validateUnitCalls } from '../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { resolveDaemonHarnessTarget } from '../intake-plane/harness-target.js';
import { HARNESS_RUN_ID_ENV, mintRunId, normalizeRunId } from '../harness/harness-space.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { checkCompletionEvidence, deliverableReceiptEvidence } from './completion-evidence.js';
import { judgeNextMove } from './judge.js';
import { checklistDevVersion, listChecklist } from '../release-loop/checklist.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { applyRunIdentityTag, applyRunIdentityTags, deriveBirthIdentity, parseRunIdentityTag, runIdentityFieldText, runIdentityQueuePriority, runPriorityClass, validateRunIdentity, type RunIdentity, type RunIdentityCell, type RunIdentityOrigin } from './run-identity.js';
import { parseWorkOrder, renderWorkOrderGoal, WORK_ORDER_FILE_PATTERN, type WorkOrder } from './work-order.js';
import { inspectPrelaunchAlreadyDone, type AlreadyDoneDecision, type AlreadyDoneCandidate,
  type PrelaunchGitRunnerForTest } from './prelaunch-already-done.js';
import { draftReleaseComment } from '../self-dev/draft-triage-rules.js';
import { parseAskTargetPathHints, parseAskTargetPathHintsResult } from '../self-dev/launch-preflight-text.js';
import { inspectGoalDoneBoundary } from '../self-implement/goal-author.js';
import { INFLIGHT_REGISTRY_FILE, registerInflight } from '../pr-tool/inflight-registry.js';

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

/**
 * TA-WORK-ORDER — `.work-order.json` 골 파일의 내용을 지시서로 검증한다.
 * 통과하면 골 문면으로 펼쳐 `work-order` 로, 깨진 JSON·칸 id 없음은 `rejected`(사유) 로 돌린다.
 * 관측: `debug.log('task-agent.work-order', 'parsed' | 'rejected', { cellId, unknownFields })`.
 */
function resolveWorkOrderFile(content: string, path: string): ResolvedHandText {
  const parsed = parseWorkOrder(content);
  if (!parsed.ok) {
    try { debug.log('task-agent.work-order', 'rejected', { cellId: null, unknownFields: [] }); } catch { /* fail-soft */ }
    return { kind: 'rejected', path, reason: parsed.reason };
  }
  try { debug.log('task-agent.work-order', 'parsed', { cellId: parsed.order.cellId, unknownFields: parsed.order.unknownFields }); } catch { /* fail-soft */ }
  return { kind: 'work-order', text: renderWorkOrderGoal(parsed.order), path, order: parsed.order };
}

/** 파일 판정만 한다. 관측과 카드 작성은 호출자가 결과에 따라 수행한다. */
export function resolveHandText(text: string, deps: ResolveHandTextDeps = { cwd: process.cwd(), stat: statSync, readFile: readFileSync }): ResolvedHandText {
  if (!text || /\s/.test(text)) return { kind: 'unchanged', text };
  const path = resolve(deps.cwd, text);
  const extension = /\.(?:md|markdown|txt)$/i.test(text);
  let file: Pick<Stats, 'isFile' | 'isDirectory'>;
  try { file = deps.stat(path); } catch (error) {
    if (!extension) return { kind: 'unchanged', text };
    return { kind: 'rejected', path, reason: missingOrReadFailure(error) };
  }
  if (!file.isFile() && !extension && !file.isDirectory()) return { kind: 'unchanged', text };
  if (!file.isFile()) return { kind: 'rejected', path, reason: file.isDirectory() ? '디렉터리' : '읽기 실패' };
  let content: string;
  // stat 과 read 사이에 지워지거나 경로가 바뀌어도 사유는 같은 규칙(없다/읽기 실패)으로 가른다.
  try { content = deps.readFile(path, 'utf8'); } catch (error) { return { kind: 'rejected', path, reason: missingOrReadFailure(error) }; }
  // TA-WORK-ORDER — 지시서 골 파일은 인라인하지 않고 지시서로 검증해 골 문면으로 펼친다.
  if (WORK_ORDER_FILE_PATTERN.test(text)) return resolveWorkOrderFile(content, path);
  const carried = content.trim();
  if (!carried) return { kind: 'rejected', path, reason: '비었다' };
  return { kind: 'inlined', text: content, path, chars: carried.length, sha256: createHash('sha256').update(carried).digest('hex') };
}

export const TASK_SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type TaskSeat = typeof TASK_SEATS[number];
/** 과제 카드 id 접두 — `task show <id>` 가 이 접두로 TOX 태스크와 갈린다. */
export const TASK_CARD_PREFIX = 'ta-';
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

/** 1판은 조합을 고르고 단위 해석 결과를 기록한다. 단위 실행은 2판의 몫이다. */
export function selectTaskComposition(completion: CompletionKind, root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')): CompositionSelection {
  const file = `graphs/work/${completion}.yaml`;
  const path = join(root, file);
  let source: string;
  try { source = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { unitsResolved: false, missingUnits: [] };
    return { composition: { file, version: null }, unitsResolved: false, missingUnits: [],
      error: `조합 읽기 오류: ${file}: ${error instanceof Error ? error.message : String(error)}` };
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
  /** Dispatch difficulty, fixed at handoff so repair uses the same judgement. */
  tier?: '하' | '중' | '상' | '특';
  /** RUN-IDENTITY-TAGS — 출생 신분 묶음(`run-identity.js` 정본): 칸 우선순위·대표 표시에서 태어나고 `--tag k=v` 가 덮는다. 카드 상태 파일이 원장 정본이다. */
  identity?: RunIdentity;
  /** Same-PR repair launches; exact source head and worker result are retained for CAS and retry limits. */
  repairs?: Array<{ pr: number; head: string; branch: string; at: string; move: string; runId: string;
    resultPath: string; fromModel: string; toModel: string; status: 'requested' | 'unconfirmed' | 'failed' | 'applied';
    detail?: string; commit?: string; bundleSha256?: string; bundlePath?: string }>;
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
  const owners = cards.filter((card) => card.status === 'launched' && (card.completion ?? 'code-pr') === 'code-pr'
    && card.seat && (card.runId || card.runChildId) && (cardPrNumber(card) === draft.number
      || (draft.runId && (card.runId === draft.runId || card.runChildId === draft.runId))));
  return owners.length === 1 ? owners[0] : undefined;
}

interface TaskAgentStateFile { tasks?: Record<string, TaskCard>; [key: string]: unknown }

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

/** 카드 하나를 잠금 안에서 읽고 고쳐 쓴다 — `update` 가 undefined 를 돌려주면 쓰지 않는다. 쓴(또는 그대로인) 카드를 돌려준다. */
export function updateTaskCard(path: string, id: string, update: (card: TaskCard | undefined, tasks: Readonly<Record<string, TaskCard>>) => TaskCard | undefined): TaskCard | undefined {
  return withFileLockSync(`${path}.lock`, () => {
    const disk = readState(path);
    const current = disk.tasks?.[id];
    const next = update(current, disk.tasks ?? {});
    if (!next) return current;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...disk, tasks: { ...(disk.tasks ?? {}), [id]: next } }));
    return next;
  });
}

export function readTaskCard(id: string, path = taskAgentStatePath()): TaskCard | undefined {
  return readState(path).tasks?.[id];
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
export interface TaskLaunchContext { runId: string; launchId: string; env: Record<string, string>; cardLabelContext?: TaskCardLabelContext; substrate?: 'pod'; podGoal?: string; effectiveChildProvider?: string }
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
  /** TA-LIVE-LAND-2 — `--ta-land`: card field `taLand` ⊕ launch env `ELANOUS_TA_LAND=1`. */
  taLand?: boolean;
  /** TASKS-HAND-CHILD-LLM — `<provider>/<model>`(`parseChildLlm`) ⊕ 선택 추론 노력. effort 만 주면 거부. */
  childLlm?: string;
  childLlmEffort?: string;
  tier?: TaskCard['tier'];
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

export async function handTask(opts: HandTaskOptions): Promise<HandTaskResult> {
  const text = opts.text.trim();
  if (!text) throw new Error('과제 한 줄이 비어 있다');
  const targetPathHints = parseAskTargetPathHintsResult(text);
  const targetPaths = canonicalTargetPaths(targetPathHints.paths);
  if (opts.seat !== undefined && !TASK_SEATS.includes(opts.seat)) throw new Error(`자리는 ${TASK_SEATS.join('|')} 중 하나다: ${opts.seat}`);
  if (opts.completion !== undefined && !COMPLETION_KINDS.includes(opts.completion)) throw new Error(`종결 종류는 ${COMPLETION_KINDS.join('|')} 중 하나다: ${opts.completion}`);
  for (const [flag, value] of [['--goal', opts.goal], ['--milestone', opts.milestone]] as const) {
    if (value !== undefined && (!value.trim() || /\p{Cc}/u.test(value))) throw new Error(`${flag} id 가 비었거나 제어 문자를 담았다: ${JSON.stringify(value)}`);
  }
  if (opts.childLlmEffort !== undefined && opts.childLlm === undefined) throw new Error('--child-llm-effort 는 --child-llm <provider>/<model> 과 함께 준다');
  if (opts.tier !== undefined && !['하', '중', '상', '특'].includes(opts.tier)) throw new Error(`--tier 는 하|중|상|특 중 하나다: ${opts.tier}`);
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
  const completion = opts.completion ?? 'code-pr';
  const selected = selectTaskComposition(completion, opts.compositionRoot);
  const selectionFailure = !selected.composition ? `조합 없음: graphs/work/${completion}.yaml`
    : selected.error ?? (completion !== 'code-pr' || selected.launcher !== 'harness-say'
      ? `조합 실행기 없음: ${selected.composition.file} (1판은 code-pr harness-say만 발사)` : undefined);
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
  const path = opts.statePath ?? taskAgentStatePath();
  const card: TaskCard = {
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
    ...(opts.tier ? { tier: opts.tier } : {}),
    ...(identity ? { identity } : {}),
    createdAt: now.toISOString(),
    status: selectionFailure ? 'failed' : 'handed',
    history: selectionFailure ? [{ at: now.toISOString(), event: !selected.composition ? 'composition-missing'
      : selected.error ? 'composition-invalid' : 'composition-launcher-unavailable', detail: selectionFailure }] : [],
    ...(opts.mission ? { mission: opts.mission, after: [...(opts.after ?? [])] } : {}),
    ...(opts.cardFields?.pr !== undefined ? { pr: opts.cardFields.pr } : {}),
    ...(opts.cardFields?.goalId !== undefined ? { goalId: opts.cardFields.goalId } : {}),
    ...(opts.cardFields?.handed !== undefined ? { handed: opts.cardFields.handed } : {}),
  };
  const move = selectionFailure ? undefined : nextMoveFor(card, opts.landed);
  if (move && move.kind !== 'launch') throw new Error(`발사할 수 없는 과제다 — ${move.reason}`);
  const guard = opts.writeGuard;
  const writeCard = (target: string, next: TaskCard): void => {
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
  writeCard(path, card);
  try { debug.log('task-agent.hand', 'target-paths', { card: id, count: targetPaths.length, labelMissing: targetPathHints.labelMissing }); } catch { /* fail-soft */ }
  try { debug.log('task-agent.graph-select', !selected.composition ? 'composition-missing' : selected.error ? 'composition-invalid' : 'composition-selected', {
    completion, file: selected.composition?.file ?? `graphs/work/${completion}.yaml`,
    unitsResolved: selected.unitsResolved, missingUnits: selected.missingUnits,
    ...(selected.error ? { error: selected.error } : {}),
  }); } catch { /* fail-soft */ }
  if (selectionFailure) throw new Error(`${selectionFailure} (카드 ${id})`);
  if (!move || move.kind !== 'launch') throw new Error('조합 선택 뒤 발사 수가 없다');
  try { debug.log('task-agent', 'handed', { taskId: id, seat: card.seat ?? null, checklistId: card.checklistId ?? null, mode, projectId: project?.id ?? null, targetIsGit, taLand: card.taLand === true, runPriority: card.identity ? runPriorityClass(card.identity) : null }); } catch { /* fail-soft */ }
  if (childLlm) {
    try { debug.log('task-agent', 'child-llm', { taskId: id, input: opts.childLlm, provider: childLlm.provider, model: childLlm.model, effort: childLlm.effort ?? null, mode }); } catch { /* fail-soft */ }
  }
  if (mode === 'shadow') return { card, move, mode, launched: false, ...(project ? { cwd: project.target } : {}) };
  if (!opts.launcher) throw new Error('--live 인데 launcher 가 없다');
  if (completion === 'code-pr' && card.checklistId) {
    const { missing } = inspectGoalDoneBoundary(text);
    if (missing.length > 0) {
      const reason = `goal-revision-required: 완료 경계 누락 ${missing.join(' · ')} — 골 문면을 고친 뒤 다시 넘기세요`;
      const failed: TaskCard = { ...card, status: 'failed', history: [...card.history,
        { at: (opts.now ?? (() => new Date()))().toISOString(), event: 'goal-revision-required', detail: reason }] };
      writeCard(path, failed);
      try { debug.log('task-agent.hand', 'done-boundary-missing', { taskId: id, checklistId: card.checklistId ?? null, missing, reason }); } catch { /* fail-soft */ }
      throw new Error(`${reason} (카드 ${id})`);
    }
  }
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
  const runId = mintRunId();
  const launchId = `tl-${randomBytes(6).toString('hex')}`;
  const context: TaskLaunchContext = { runId, launchId, env: { [HARNESS_RUN_ID_ENV]: runId, ELANOUS_TASK_CARD_ID: card.id,
    ...(cardPrNumber(card) ? { ELANOUS_TASK_BOUND_PR: String(cardPrNumber(card)) } : {}),
    ...(card.checklistId ? { ELANOUS_POD_SLOT_ID: card.checklistId } : {}),
    ...(card.seat ? { ELANOUS_POD_OWNER_KIND: 'seat', ELANOUS_POD_OWNER_ID: card.seat } : {}),
    ...(card.taLand ? { [TA_LAND_ENV]: '1' } : {}) }, cardLabelContext: taskCardLabelContext(card),
    // An omitted card provider uses the established Pod default. Carry the effective value explicitly so
    // remote-parent code never has to infer a provider from the serialized CLI argv.
    effectiveChildProvider: card.childLlm?.provider ?? 'openai-codex',
    ...(completion === 'code-pr' && selected.launcher === 'harness-say' ? { substrate: 'pod' as const, podGoal: card.text } : {}) };
  let receipt: void | TaskLaunchReceipt;
  try {
    receipt = await opts.launcher(move.command!, project?.target, context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed: TaskCard = { ...card, status: 'launch-failed', history: [{ at: (opts.now ?? (() => new Date()))().toISOString(), event: 'launch-failed', detail: reason }] };
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
