// ── ask 발사 «흐름» — 한 입구가 아니라 «한 함수»가 소유한다 ─────────────────────
//
// ⭐ 왜 있나(2026-08-11 72차 · B2 선결):
//   `dev --say/--ask` 의 ⓪예비검사 → ⑴저작 → ⑴b되묻기 → ⑵⑶전제검사 → ⑷발사 가
//   ***`src/index.ts` 안에 인라인 204줄***로 있었다. 그래서 「TUI 슬래시로도 같은 것을 하라」가
//   ***로직 복제 없이는 불가능***했다(72차 판이 복제를 금지했다).
//   ⇒ 흐름을 여기로 옮기고 ***I/O 는 전부 주입***한다. CLI 와 TUI 가 «같은 함수»를 부른다.
//
// ⛔ 이 판은 ***옮기기만*** 한다 — 판정 규칙·문면·관측 이름을 «하나도» 바꾸지 않는다.
//   (바꾸면 이 추출이 회귀인지 개선인지 사후에 못 가른다.)
// ⛔ 종료(`process.exit`)는 여기가 «안» 한다 — 호출자가 자기 표면에 맞게 끝낸다.
//   그래서 결과를 «세 값»으로 낸다: 발사 / 저작 전 중단 / 전제 검사 중단.
import { linesOutsideFencedCode } from '../self-implement/goal-author.js';
import { recordAuthoredGoal } from './authored-goal-trace.js';
import { findAskPathCandidates, type AskPathCandidateOptions } from './ask-path-candidates.js';
import { retiredEntranceNotice, type EntranceDeclaration } from './entrance-registry.js';
import {
  classifyConcurrentAuthoring,
  countRepeatedBlocks,
  decideAskPreflight,
  parseAskTargetPathHintsResult,
  parseBlockedChoice,
  planBlockedPrompt,
  renderBlockedInspection,
  renderConcurrentAuthoringNotice,
  renderLaunchPreflight,
  renderRepeatedBlockNotice,
  siblingTestPath,
  type AskPreflightDeps,
  type LaunchPreflightResult,
  type PriorBlockSample,
  type RecentAuthoringSample,
} from './launch-preflight.js';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute as isAbsolutePath, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import {
  applyClarificationReply,
  planClarificationIntake,
  selfAnswerGoalDocumentClarifications,
  type GoalClarificationSelfResolver,
} from '../self-implement/goal-author-clarification.js';
import { classifyReauthoredAsk, countMissingAuthoredConstraintMarkers, askGoalTypeDeclaration, declaredGoalType, parseGoalId } from '../self-implement/goal-author.js';
import { observeFrontNodeEntry } from './graph-front-nodes.js';
import { emitDecision } from '../live/detail-switch.js';
import { decomposeSelfDevGoal, type SelfDevDecomposeOptions, type SelfDevDecomposition } from './decompose.js';
import { observeDecomposerSelection, readFabricDecomposeConfig, selectFabricDecomposer } from './self-orchestrate-runtime.js';
import type { GoalDocumentClarification } from '../self-implement/goal-author-clarification.js';

export type SelfResolveClarificationsSource = 'flag' | 'default';

interface ResolvedSelfResolveClarifications {
  readonly value: boolean;
  readonly source: SelfResolveClarificationsSource;
}

// 설정 졸업 1-c(2026-09-26 · 대표 «기본으로 켜진 것은 옵션으로 두지 않는다»): 설정 키는 폐기됐다 — 읽지 않는다.
//   프로그램 인자(시험·내부 호출)만 끌 수 있다.
function resolveSelfResolveClarifications(explicit: boolean | undefined): ResolvedSelfResolveClarifications {
  return explicit !== undefined ? { value: explicit, source: 'flag' } : { value: true, source: 'default' };
}

/** 저작기 산출 — `runGoalAuthorCli` 의 반환에서 이 흐름이 «실제로 쓰는» 것만. */
export interface AskAuthoredGoal {
  readonly path: string;
  readonly authored?: { readonly document?: string; readonly grounded?: boolean | null; readonly authorRunId?: string } | null;
}

export type LaunchingTreeProbe =
  | { readonly kind: 'measured'; readonly ahead: number; readonly behind: number; readonly reference: string }
  | { readonly kind: 'unmeasurable'; readonly error: string };

type AskLaunchPreflightDeps = AskPreflightDeps & {
  readonly inspectLaunchingTree?: (cwd: string) => LaunchingTreeProbe;
};

/** ⛔ I/O 는 «전부» 여기로 들어온다 — 그래야 CLI·TUI·시험이 같은 흐름을 쓴다. */
export type InvokerBehindDefaultBranch =
  | { readonly state: 'measured'; readonly commits: number; readonly baseRef: string }
  | { readonly state: 'unmeasurable'; readonly reason: string };

/** 현재 인보커 작업 트리의 HEAD를 이미 알려진 원격 기본 브랜치 ref와만 비교한다. */
export function measureInvokerBehindDefaultBranch(cwd: string): InvokerBehindDefaultBranch {
  try {
    // git-spawn-allow: Reads the known origin/HEAD remote-tracking ref without fetching or changing repository state.
    const baseRef = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!baseRef || baseRef === 'origin/HEAD') throw new Error('원격 기본 브랜치 ref를 해석하지 못했다');
    // git-spawn-allow: Counts commits reachable from the known remote default branch but not local HEAD without changing repository state.
    const raw = execFileSync('git', ['-C', cwd, 'rev-list', '--count', `HEAD..${baseRef}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commits = Number(raw);
    if (!Number.isSafeInteger(commits) || commits < 0) throw new Error(`뒤처진 커밋 수가 유효하지 않다: ${raw || '(빈 값)'}`);
    return { state: 'measured', commits, baseRef };
  } catch {
    // Git stderr may contain newlines; preserve the preflight's one-line rendering contract.
    return { state: 'unmeasurable', reason: '원격 기본 브랜치 대비를 측정하지 못했다' };
  }
}

/** git 최상위 경로(못 풀면 null). */
function gitTopLevel(dir: string): string | null {
  try {
    // git-spawn-allow: Reads the repository top-level path without changing repository state.
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch { return null; }
}

/**
 * 계보 키(`- AskFile:`)로 쓸 ask 파일 경로를 «저장소 기준 상대경로»로 정규화한다.
 * ⛔ 같은 파일을 `내부 문서 `X`` 로 치든 절대경로로 치든 «같은 키»여야 계보가 이어진다.
 * ⛔ 저장소 밖(예: 임시 디렉토리) · 저장소를 못 푸는 경로는 `undefined` — 사라질 경로를 키로 쓰면
 *   서로 다른 목표가 우연히 묶인다. 없음 = 「계보 모름」이다(자동 정리 대상 아님).
 */
export function lineageAskFile(askFile: string, cwd: string = process.cwd(), topLevel: (dir: string) => string | null = gitTopLevel): string | undefined {
  const absolute = resolvePath(cwd, askFile);
  const root = topLevel(dirname(absolute));
  if (!root) return undefined;
  const rel = relativePath(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolutePath(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * ⛔ 2026-09-23 (Phase 4 실측) — 남의 프로젝트를 몰 때 위 관측은 «그 프로젝트»를 잰다. 그런데 뒤처질 수 있는 것은
 *   ***elanous 도구 자신의 체크아웃***이다(개발 트리로 쓸 때). 오늘 벤더 A/B 세 판이 이미 착지한 수리 둘 «전» 트리로
 *   떴고 아무 경고도 없었다. ⇒ 도구 소스가 git 체크아웃이고 작업 디렉토리 저장소와 «다를» 때만 같은 방식으로 잰다.
 *   npm 설치(체크아웃 아님)·같은 저장소면 null(출력 없음).
 */
export function measureToolTreeBehindDefaultBranch(cwd: string, toolDir: string = import.meta.dir): { readonly toolRoot: string; readonly observation: InvokerBehindDefaultBranch } | null {
  const toolRoot = gitTopLevel(toolDir);
  if (!toolRoot) return null;
  if (gitTopLevel(cwd) === toolRoot) return null;
  return { toolRoot, observation: measureInvokerBehindDefaultBranch(toolRoot) };
}

function renderInvokerBehindDefaultBranch(observation: InvokerBehindDefaultBranch): string {
  return observation.state === 'measured'
    ? `[preflight] 인보커 작업 트리 원격 기본 브랜치 대비 — ${observation.commits === 0 ? '뒤처지지 않았다' : `${observation.commits}커밋 뒤처졌다`} (${observation.baseRef})`
    : `[preflight] 인보커 작업 트리 원격 기본 브랜치 대비 — ⚠️ 못 쟀다 (${observation.reason})`;
}

export interface AskLaunchFlowDeps {
  /** 사람에게 보이는 한 줄(현 CLI 는 stderr). */
  print(line: string): void;
  /** 관측 — 카테고리는 호출자가 `dev-pipeline` 으로 고정한다. */
  log(event: string, data: Record<string, unknown>, level: 'info' | 'warn'): void;
  readLine(prompt: string): Promise<string>;
  /** Optional structured clarification adapter. Omitted callers retain the
   * existing CLI line-input contract exactly. */
  readClarification?(clarification: GoalDocumentClarification): Promise<string>;
  selfResolveClarification?: GoalClarificationSelfResolver;
  /** Replaces the goal document after a self-answer; production entrances pass an atomic writer. */
  writeGoalDocument?(path: string, document: string): void;
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  cwd(): string;
  /** 인보커 작업 트리에서 읽는 비차단 관측. 생략하면 이 흐름의 기본 Git 비교를 쓴다. */
  measureInvokerBehindDefaultBranch?(): InvokerBehindDefaultBranch;
  /** elanous 도구 자신의 체크아웃 관측(시험 seam). null = 해당 없음(체크아웃 아님·같은 저장소). */
  measureToolTreeBehindDefaultBranch?(): { readonly toolRoot: string; readonly observation: InvokerBehindDefaultBranch } | null;
  now(): number;
  /** ⛔ 「대화형인가」는 표면이 안다 — 흐름이 `process` 를 직접 보지 않는다. */
  isInteractive(): boolean;
  buildPreflightDeps(): Promise<AskLaunchPreflightDeps>;
  /** ⛔ 못 얻으면 `null` — 「0번 막혔다」와 «못 셌다»를 다른 값으로. */
  priorBlockSamples(): PriorBlockSample[] | null;
  /** ⛔ 못 얻으면 `null` — 같은 이유. */
  recentAuthoringSamples(): RecentAuthoringSample[] | null;
  authorGoal(args: readonly string[], options: Record<string, unknown>): Promise<AskAuthoredGoal>;
  /** Code-search seam for the one automatic no-target-paths retry. */
  findPathCandidates?: (askText: string, options: AskPathCandidateOptions) => ReturnType<typeof findAskPathCandidates>;
  /** AUTHOR-TRACE seam (tests). */
  recordAuthoredGoal?: typeof recordAuthoredGoal;
  /** Pod launches reserve a host slot before goal authoring begins. */
  beforeAuthoring?(): Promise<void>;
  /** 발사 전 권고용 분해 seam. 생략하면 전용 관측명을 준 기존 분해기를 쓴다. */
  decomposeGoal?(goal: string): Promise<SelfDevDecomposition>;
  /**
   * ⭐ 「기본 경로」를 «실물로» 재기 위한 이음매 — 분해기를 통째로 갈아끼우지 않고 그 안의 LLM 만 준다.
   * ⛔ `decomposeGoal` 로 갈아끼우면 「이 자리가 어느 이름으로 관측하나」를 «원리상» 못 잰다(내가 그 이름을 정하므로).
   */
  decomposeOptions?: Partial<Pick<SelfDevDecomposeOptions, 'llm' | 'model' | 'maxTasks' | 'decomposer' | 'fabric'>>;
  /** 기본 15초. 시험은 0으로 줄여 timeout 결말을 검증한다. */
  decomposeTimeoutMs?: number;
  /** 골 문서 경로를 cwd 기준 상대 경로로 — `--from-clarification` 문법이 그것을 요구한다. */
  relativeToCwd(path: string): string;
  /** Optional config seam: failures resolve to default ON and remain observable. */
}

export interface AskLaunchFlowInput {
  /** 발사 요청을 이 공통 흐름으로 보낸 실제 입구 선언. */
  readonly entrance: EntranceDeclaration;
  /** `--ask <파일>` 인가 `--say <문장>` 인가. */
  readonly inputSource: 'ask' | 'say';
  /** ask 원문(파일이면 «이미 읽은» 내용). ⛔ 호출자가 빈 입력을 먼저 거른다. */
  readonly askText: string;
  /** `--ask` 일 때의 파일 경로(관측에만 쓴다). */
  readonly askFile?: string;
  /** Optional repository root used only for code grounding during goal authoring. */
  readonly groundingCwd?: string;
  readonly authorGrade?: import('../self-implement/goal-author.js').GoalAuthorGradeSelection;
  readonly liveRunWindowMinutes: number;
  readonly recentChangeWindowDays: number;
  readonly forceRequested: boolean;
  /** 기본 true. LLM 왕복을 피하려면 false로 사전 분해 권고를 끈다. */
  readonly decomposeBeforeLaunch?: boolean;
  /** CLI가 명시한 정식 골 종류. 있으면 ask 본문 선언보다 우선한다. */
  readonly goalType?: import('../self-implement/goal-author.js').GoalType;
  /** 런 식별자가 이미 있으면 앞단 관측을 그 키로 잇는다. 없으면 관측은 runId 없이 남는다. */
  readonly runId?: string;
  /** Explicit harness choice; false is distinct from omission. */
  readonly selfResolveClarifications?: boolean;
}

export type AskLaunchFlowResult =
  | { readonly kind: 'launch'; readonly goalFile: string }
  /** ⓪ 저작 «전»에 막혔다 — 100초를 안 썼다. */
  | { readonly kind: 'stopped-before-authoring'; readonly goalFile?: undefined }
  /** ⑵⑶⑷ 에서 막혔다 — 골은 «있다»(사람이 열어볼 수 있게 돌려준다). */
  | { readonly kind: 'stopped-by-preflight'; readonly goalFile: string };

/** 런 식별자가 흐름 뒤에 확정된 호출자는 이 관측으로 입구와 런을 조인한다. */
export function observeAskLaunchRunIdentity(
  input: Pick<AskLaunchFlowInput, 'entrance' | 'inputSource'>,
  deps: Pick<AskLaunchFlowDeps, 'log'>,
  runId: string,
): void {
  deps.log('harness.entrance', {
    entrance: input.entrance.id,
    entranceStatus: input.entrance.status,
    surface: input.entrance.surface,
    inputSource: input.inputSource,
    runId,
  }, 'info');
}

const OPEN_PR_LIMIT = 200;
/**
 * ⛔⭐⭐⭐ **15초는 「가장 필요한 경우에만」 이 관문을 껐다** (2026-08-16 · 🅣 라이브 전수 6발).
 * 📏 시간 초과한 «둘» = 그날 «실제로 죽은» 둘. 분해기는 «둘 다 답했다»(3개·4개) — 흐름이 먼저 포기했다.
 *   0ms 로 제때 답한 «넷» = 전부 살아서 착지했다.
 * ⇒ 📌 ***큰 골일수록 분해가 오래 걸리고, 오래 걸리는 것부터 타임아웃이 버린다*** — 역선택이다.
 * ⭐ 그리고 이 판정은 «발사를 막지 않는다»(권고일 뿐) ⇒ 오래 기다려도 안전하다.
 *   저작 자체가 ≈300초인 것에 비해 15초는 자릿수가 다르다.
 */
/** ⭐ 검사가 이 하한을 «직접» 단언한다 — 주입으로는 「기본값 자체」를 못 재고, 안 주입하면 실제로 그 시간을 기다린다. */
export const DEFAULT_DECOMPOSE_TIMEOUT_MS = 180_000;
/** 부검 분해기(`self-dev/decomposition`)와 «같은 이름을 쓰지 않는다» — 두 조회가 섞이면 둘 다 못 읽는다. */
const PRELAUNCH_DECOMPOSITION_OBSERVATION = { event: 'prelaunch-decomposition' } as const;

function prelaunchDecompositionObservation(document: string) {
  try {
    return { ...PRELAUNCH_DECOMPOSITION_OBSERVATION, goalId: parseGoalId(document), runId: null };
  } catch {
    return { ...PRELAUNCH_DECOMPOSITION_OBSERVATION, goalId: null, runId: null };
  }
}

type LaunchDecompositionRecord =
  | {
    readonly state: 'measured';
    readonly outcome: SelfDevDecomposition['decomposition']['outcome'];
    readonly actualTaskCount: number;
    readonly pieces: readonly string[];
    readonly reason: string;
  }
  | {
    readonly state: 'unmeasurable';
    readonly outcome: 'timed-out' | 'document-read-failed' | 'failed' | 'llm-failed' | 'inconsistent-result' | 'empty-piece-content' | 'document-write-failed';
    readonly reason: string;
  };

const LAUNCH_DECOMPOSITION_SECTION = '발사 전 분해 권고';

/** Render dynamic values as one indented JSON string, never as Markdown syntax. */
function serializeLaunchDecompositionValue(value: string): string {
  return `  ${JSON.stringify(value)}`;
}

function serializeLaunchDecomposition(record: LaunchDecompositionRecord): string {
  const lines = [
    `## ${LAUNCH_DECOMPOSITION_SECTION}`,
    `- 상태: ${record.state}`,
    `- 판정: ${record.outcome}`,
    '- 이유:',
    serializeLaunchDecompositionValue(record.reason),
  ];
  if (record.state === 'measured') {
    lines.push(`- 조각 수: ${record.actualTaskCount}`, '- 조각 내용:');
    record.pieces.forEach((piece, index) => lines.push(`  ${index + 1}.`, serializeLaunchDecompositionValue(piece)));
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * 기록을 «펜스 밖»이면서 «골의 정체 뒤»에 넣는다.
 *
 * ⛔ 초판은 문서 «맨 앞»에 붙였다(닫히지 않은 ask 펜스가 절을 가리는 것을 피하려고).
 *   그러면 절은 보이지만 ***골의 정체가 밀린다*** — `대상 경로:` 와 머리말이 첫 줄이 아니게 되고,
 *   실행기가 그 절 제목을 feature 로 읽는다(2026-08-20 실물: 워크트리 이름이
 *   `measured-decomposed-2-1-…` 가 되고 시작 줄이 「🔨 시작 — ## 발사 전 분해 권고」였다).
 * ✅ 그래서 첫 «절 제목» 바로 «앞»에 넣는다 — 원문 verbatim 펜스는 그보다 뒤에 오므로 여전히 펜스 밖이고,
 *   머리말(대상 경로·GoalId·RootIntent·GoalType)은 자기 자리에 남는다.
 * ⛔ 절 제목이 하나도 없으면 맨 앞에 붙인다(그때는 밀릴 정체가 없다).
 */
function recordLaunchDecomposition(document: string, record: LaunchDecompositionRecord): string {
  const block = serializeLaunchDecomposition(record);
  // ⭐ 펜스 판별을 «따로 만들지 않는다» — 골 문서를 실제로 읽는 그 파서의 규칙을 그대로 쓴다.
  //   ⛔ 내 약한 중복 규칙은 `~~~` 펜스와 마커 길이를 못 봤다(리뷰 must-fix 4차).
  const outside = linesOutsideFencedCode(document);
  const heading = outside.find((line) => /^#{1,6} /.test(line.text));
  if (heading === undefined) return `${block}${document}`;   // 밀릴 정체가 없다
  const head = document.slice(0, heading.start);
  const tail = document.slice(heading.start);
  return `${head}${block}${tail}`;
}

function logDecompositionObservation(
  deps: AskLaunchFlowDeps,
  legacyEvent: 'ask-launch-decomposition' | 'ask-launch-decomposition-skipped',
  data: Record<string, unknown>,
  level: 'info' | 'warn',
): void {
  deps.log(legacyEvent, data, level);
  deps.log('harness.decompose', { ...data, legacyEvent }, level);
}

export async function recommendLaunchDecomposition(
  goalFile: string,
  input: AskLaunchFlowInput,
  deps: AskLaunchFlowDeps,
  document?: string,
): Promise<LaunchDecompositionRecord | undefined> {
  if (input.decomposeBeforeLaunch === false) {
    deps.print('[ask] ⑷ 발사 전 분해 권고 — 꺼짐');
    logDecompositionObservation(deps, 'ask-launch-decomposition-skipped', { goalFile, reason: 'opt-out' }, 'info');
    return undefined;
  }

  const timeoutMs = deps.decomposeTimeoutMs ?? DEFAULT_DECOMPOSE_TIMEOUT_MS;
  const timedOut = Symbol('launch-decomposition-timed-out');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    // ⛔ 이름을 «안 주면» 재사용 분해기가 기본 이름 `self-dev/decomposition` 으로 찍는다 —
    //   그 이름은 「골이 죽은 뒤」 도는 부검 분해기의 것이다. 섞이면 두 조회가 «같은 모집단»을 보게 되고,
    //   「발사 전 판정이 도나」와 「부검이 몇 번 돌았나」를 영영 못 가른다.
    //   ⭐ 그래서 이 자리는 자기 이름을 준다. 시간 초과 «뒤에» 늦게 끝난 분해도 그 이름으로 내려앉으므로
    //     부검 집계를 오염시키지 않는다(늦은 사실 자체는 그 이름 아래 남아 관측 가능하다).
    const normalizedPathCount = undefined;
    const fabricDecomposeConfig = readFabricDecomposeConfig();
    const selection = selectFabricDecomposer(
      deps.decomposeOptions?.decomposer === 'fabric' ? true : undefined,
      fabricDecomposeConfig,
      normalizedPathCount,
    );
    observeDecomposerSelection(
      selection.decomposer,
      selection.source,
      input.entrance.surface,
      normalizedPathCount,
      fabricDecomposeConfig.autoPathThreshold,
    );
    const decomposeGoalType = input.goalType ?? declaredGoalType(input.askText);
    observeFrontNodeEntry('decompose', {
      provenance: 'authoring-decomposition-start',
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(decomposeGoalType === null ? {} : { goalType: decomposeGoalType }),
    });
    const result = await Promise.race([
      deps.decomposeGoal
        ? deps.decomposeGoal(document!)
        : decomposeSelfDevGoal(document!, {
          ...deps.decomposeOptions,
          decomposer: selection.decomposer,
          observation: prelaunchDecompositionObservation(document!),
        }),
      timeout,
    ]);
    if (result === timedOut) {
      // ⛔ 「시간 초과」를 「못 쟀다」로 뭉개지 않는다 — 분해기는 «아직 답하는 중»이고
      //   그 답은 `prelaunch-decomposition` 이름으로 «따로» 내려앉는다(위 주석).
      //   ⇒ 이 줄은 「흐름이 못 기다렸다」를 말하고, 「분해가 못 쟀다」를 말하지 않는다.
      //     그 둘을 같은 값으로 두면 「골이 작아서 1개」와 「커서 늦었다」가 구별되지 않는다(🅣 실측).
      deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⏳ 흐름이 못 기다렸다 (${Math.round(timeoutMs / 1000)}초 초과 · 분해는 계속된다)`);
      deps.print('[ask]    ▶ 늦게 온 답은 관측에 남는다: elanous logs --event prelaunch-decomposition --limit 5');
      logDecompositionObservation(deps, 'ask-launch-decomposition', {
        goalFile,
        outcome: 'timed-out',
        // ⭐ 「분해를 못 쟀다」가 «아니다» — 흐름이 그 답을 «못 기다린» 것이다.
        unmeasurable: false,
        flowWaitExceeded: true,
        timeoutMs,
        lateAnswerObservedAs: 'self-dev/prelaunch-decomposition',
      }, 'warn');
      return { state: 'unmeasurable', outcome: 'timed-out', reason: `흐름이 ${Math.round(timeoutMs / 1000)}초 안에 분해 답을 받지 못했다` };
    }
    const { decomposition, goals } = result;
    if (decomposition.outcome === 'llm-failed') {
      deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⚠️ 못 쟀다 (${decomposition.error ?? '분해기 실패'})`);
      logDecompositionObservation(deps, 'ask-launch-decomposition', {
        goalFile, outcome: decomposition.outcome, unmeasurable: true, error: decomposition.error ?? null,
      }, 'warn');
      return { state: 'unmeasurable', outcome: 'llm-failed', reason: decomposition.error ?? '분해기 실패' };
    }
    const { actualTaskCount } = decomposition;
    // ⭐ 「쪼갤 것이 없다」는 «측정된 답»이다 — 조각 «내용»이 0개인 것이 정상이므로 아래 대조를 지나지 않는다.
    if (decomposition.outcome === 'single-no-subtasks') {
      deps.print('[ask] ⑷ 발사 전 분해 권고 — 조각 1개');
      logDecompositionObservation(deps, 'ask-launch-decomposition', { goalFile, outcome: decomposition.outcome, actualTaskCount: 1, features: [] }, 'info');
      return { state: 'measured', outcome: decomposition.outcome, actualTaskCount: 1, pieces: [], reason: '서브태스크가 없다고 판정했다' };
    }
    // ⛔ 조각 «내용»이 비면 그것은 「빈 조각」이 아니라 ***못 쟀음***이다.
    //   `feature ?? ''` 로 접으면 없는 내용을 「길이 0인 실제 내용」으로 «단정»하게 된다(리뷰 must-fix).
    const piecesWithHotPaths = goals.map(({ feature, hotPaths }) => ({ feature, hotPaths: hotPaths ?? [] }));
    const rawPieces = piecesWithHotPaths.map(({ feature }) => feature);
    // ⛔ `[].some()` 은 false 다 — 빈 배열을 «명시적으로» 거부하지 않으면 「조각 0개」가 measured 로 샌다(리뷰 must-fix).
    if (rawPieces.length === 0 || rawPieces.some((feature) => typeof feature !== 'string' || feature.trim() === '')) {
      const reason = '분해기가 조각 내용을 비워 돌려줬다';
      deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⚠️ 못 쟀다 (${reason})`);
      logDecompositionObservation(deps, 'ask-launch-decomposition', {
        goalFile, outcome: 'empty-piece-content', unmeasurable: true, actualTaskCount, pieceCount: rawPieces.length,
      }, 'warn');
      return { state: 'unmeasurable', outcome: 'empty-piece-content', reason };
    }
    const pieces = rawPieces as readonly string[];
    const hotPaths = piecesWithHotPaths.map(({ hotPaths }) => hotPaths);
    if (actualTaskCount !== pieces.length) {
      const reason = `분해기 조각 수 ${actualTaskCount}와 조각 내용 ${pieces.length}개가 일치하지 않는다`;
      deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⚠️ 못 쟀다 (${reason})`);
      logDecompositionObservation(deps, 'ask-launch-decomposition', {
        goalFile, outcome: 'inconsistent-result', unmeasurable: true, actualTaskCount, pieceCount: pieces.length,
      }, 'warn');
      return { state: 'unmeasurable', outcome: 'inconsistent-result', reason };
    }
    deps.print(actualTaskCount > 1
      ? `[ask] ⑷ 발사 전 분해 권고 — 조각 ${actualTaskCount}개: ${pieces.join(' · ')}`
      : `[ask] ⑷ 발사 전 분해 권고 — 조각 ${actualTaskCount}개`);
    logDecompositionObservation(deps, 'ask-launch-decomposition', {
      goalFile, outcome: decomposition.outcome, actualTaskCount, features: pieces, hotPaths,
    }, 'info');
    return {
      state: 'measured',
      outcome: decomposition.outcome,
      actualTaskCount,
      pieces,
      reason: '분해기가 조각을 제안했다',
    };
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⚠️ 못 쟀다 (${message})`);
    logDecompositionObservation(deps, 'ask-launch-decomposition', {
      goalFile, outcome: 'failed', unmeasurable: true, error: message,
    }, 'warn');
    return { state: 'unmeasurable', outcome: 'failed', reason: message };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** 모든 차단 관측이 같은 상세 계약을 쓴다 — 없는 상세는 지어내지 않는다. */
function blockersForObservation(blockers: LaunchPreflightResult['blockers']) {
  return blockers.map((blocker) => ({
    kind: blocker.kind,
    name: blocker.name,
    ...(blocker.overlapPaths === undefined ? {} : {
      overlapPaths: blocker.overlapPaths.map(({ path, role }) => `${path} (${role})`),
      allOverlapPathsAreEvidence: blocker.allOverlapPathsAreEvidence ?? false,
    }),
  }));
}

function preflightAxesForObservation(result: LaunchPreflightResult) {
  const openPrMatchCount = result.warnings.filter(({ kind, name }) => kind === 'open-pr' && name.startsWith('#')).length;
  const liveRunMatchCount = result.warnings.filter(({ kind }) => kind === 'live-run').length;
  const recentChangeMatchCount = result.warnings.filter(({ kind, name }) => kind === 'recent-change' && result.paths.includes(name)).length;
  const axis = <T extends { readonly state: string }>(status: T, matchCount?: number) => ({
    ...status,
    ...(status.state === 'unknown' || matchCount === undefined ? {} : { matchCount }),
  });
  const preexistingFailures = result.preexistingFailures.state === 'unreadable'
    ? result.preexistingFailures
    : {
      state: result.preexistingFailures.state,
      count: result.preexistingFailures.files.length,
      ...(result.preexistingFailures.state === 'truncated' ? { limit: result.preexistingFailures.limit } : {}),
      matchCount: result.preexistingFailures.files.filter((file) => result.paths.includes(file) || result.paths.some((path) => siblingTestPath(path) === file)).length,
    };

  return {
    openPrs: axis(result.openPrs, openPrMatchCount),
    liveRuns: axis(result.liveRuns, liveRunMatchCount),
    completedRuns: axis(result.completedRuns, result.completedRunMatches.length),
    interruptedRuns: axis(result.interruptedRuns, result.interruptedRunMatches.length),
    activeUnfinishedRuns: axis(result.activeUnfinishedRuns),
    inactiveUnfinishedRuns: axis(result.inactiveUnfinishedRuns),
    unreadableUnfinishedRunAges: axis(result.unreadableUnfinishedRunAges),
    recentChanges: axis(result.recentChanges, recentChangeMatchCount),
    preexistingFailures,
    unreadableRuns: result.unreadableRuns,
  };
}

export function observeLaunchPreflight(
  deps: AskLaunchFlowDeps,
  phase: 'before-authoring' | 'before-launch',
  decision: ReturnType<typeof decideAskPreflight>,
  runId?: string,
): void {
  const blockers = blockersForObservation(decision.result.blockers);
  deps.log('harness.preflight', {
    phase,
    conclusion: decision.shouldLaunch ? 'launch' : 'blocked',
    paths: decision.result.paths,
    blockerReasons: blockers,
    axes: preflightAxesForObservation(decision.result),
  }, 'info');
  if (phase === 'before-authoring') {
    try { emitAuthoringPreflightDecision(decision, runId); }
    catch { /* Live detail cannot change the preflight outcome. */ }
  }
}

function emitAuthoringPreflightDecision(
  decision: ReturnType<typeof decideAskPreflight>,
  runId?: string,
): void {
  const firstBlocker = decision.result.blockers[0];
  if (firstBlocker && !decision.shouldLaunch) emitDecision({
    kind: 'ESCALATE',
    what: firstBlocker.detail.replace(/\s+/g, ' ').trim(),
    reason: `${firstBlocker.name} — 예비 검사에서 막는 것 ${decision.result.blockers.length}건`,
    purpose: '저작 전 막힘을 사람이 판단한다',
    target: '사람(되묻기)',
    ...(runId === undefined ? {} : { runId }),
  });
  else emitDecision({
    kind: 'PLAN',
    what: '저작 시작',
    reason: firstBlocker
      ? `예비 검사 통과 — --force-preflight 로 ${decision.result.blockers.length}건 우회; 저작 뒤 확정 재검사`
      : '예비 검사 통과 — 막는 것 없음; 저작 뒤 확정 재검사',
    purpose: '골을 저작하고 확정 재검사한다',
    target: '저작',
    ...(runId === undefined ? {} : { runId }),
  });
}

/** ⛔⭐⭐ 막힘 처리는 «한 곳»에서만 — ⓪(저작 전)과 ⑵⑶⑷(저작 후)가 같은 물음·같은 계수를 쓴다.
 *  🅣 라이브(2026-08-11): 종전엔 ⓪ 이 바로 끊어서 ***물음도 반복 계수도 안 돌았다***. */
async function resolveBlockedInteractively(
  result: LaunchPreflightResult,
  goalFileForLog: string,
  deps: AskLaunchFlowDeps,
): Promise<boolean> {
  if (result.blockers.length === 0) return true;
  // ⛔ 「이것이 N번째인가」를 «먼저» 말한다 — 🅣 전수: 막힌 뒤 사람이 실제로 한 행동은 「다시 치기」였다.
  const samples = deps.priorBlockSamples();
  const repeatedCount = samples === null
    ? null   // ⛔ 「0번 막혔다」가 아니라 «못 셌다»
    : countRepeatedBlocks(samples, result.paths, result.blockers.map((blocker) => blocker.kind));
  const notice = repeatedCount === null ? null : renderRepeatedBlockNotice(repeatedCount);
  if (notice) deps.print(notice);
  else if (repeatedCount === null) deps.print('[preflight] 🔁 ⚠️ 반복 여부를 «못 셌다»(관측 조회 실패) — 「처음」이라는 뜻이 아니다');
  deps.log('ask-blocked-repeat', {
    goalFile: goalFileForLog, repeatedCount,
    blockers: blockersForObservation(result.blockers),
  }, 'info');

  const mode = planBlockedPrompt(result, deps.isInteractive());
  if (mode !== 'ask') return false;   // ⛔ 무인 계약 — 비대화형이면 종전대로 막는다
  for (;;) {
    deps.print('\n[preflight] ❓ 막혔습니다 — 어떻게 할까요?');
    deps.print('[preflight]      f) 그래도 발사한다 (= --force-preflight · 우회는 관측에 남는다)');
    deps.print('[preflight]      i) 막은 것을 어떻게 보는지 알려줘');
    deps.print('[preflight]      (빈 줄 = 그만둔다)');
    const choice = parseBlockedChoice(await deps.readLine('[preflight]      > '));
    deps.log('ask-blocked-choice', {
      goalFile: goalFileForLog, choice, repeatedCount,
      blockers: blockersForObservation(result.blockers),
    }, 'info');
    if (choice === 'inspect') { deps.print(renderBlockedInspection(result)); continue; }
    if (choice === 'force') {
      deps.print('[preflight] ⚠️ 사람이 그 자리에서 뚫었다 — 그 사실은 관측에 남는다');
      return true;
    }
    return false;
  }
}

/** ⓪ 저작 «전» 예비 검사 — 「맹점 창」을 닫는다. `false` 면 저작을 시작하지 않는다. */
function renderRejectedAskTargetPathHints(
  rejected: readonly { readonly fragment: string; readonly reason: string }[],
): string {
  return rejected.map(({ fragment, reason }) => `${JSON.stringify(fragment)} (${reason})`).join(', ');
}

function observeLaunchingTree(deps: AskLaunchFlowDeps, preflightDeps: AskLaunchPreflightDeps): void {
  let probe: LaunchingTreeProbe | undefined;
  try {
    probe = preflightDeps.inspectLaunchingTree?.(deps.cwd());
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    deps.print(`[ask] ⓪ 발사 트리 검사 — ⚠️ 못 쟀다 (${message}; ⛔ 최신이라는 뜻이 아니다)`);
    deps.log('ask-launching-tree', { outcome: 'unmeasurable', reason: 'probe-threw', error: message }, 'warn');
    return;
  }
  if (probe === undefined) {
    deps.print('[ask] ⓪ 발사 트리 검사 — ⚠️ 못 쟀다 (발사 트리 비교기가 없다; ⛔ 최신이라는 뜻이 아니다)');
    deps.log('ask-launching-tree', { outcome: 'unmeasurable', reason: 'probe-unavailable' }, 'warn');
    return;
  }
  if (probe.kind === 'unmeasurable') {
    deps.print(`[ask] ⓪ 발사 트리 검사 — ⚠️ 못 쟀다 (${probe.error}; ⛔ 최신이라는 뜻이 아니다)`);
    deps.log('ask-launching-tree', { outcome: 'unmeasurable', error: probe.error }, 'warn');
    return;
  }
  if (probe.behind > 0) {
    const isDiverged = probe.ahead > 0;
    const divergence = isDiverged ? ` · 이 트리 고유 ${probe.ahead}커밋` : '';
    const updateCommand = isDiverged ? 'git rebase origin/main' : 'git pull --ff-only origin main';
    const updateLabel = isDiverged ? '고유 커밋을 재적용해 맞추기' : '맞추기';
    const pullSafety = 'git pull --ff-only origin main은 아래 예비 검사 출력의 「그중 지금 도는 것」이 0건일 때만 안전하다';
    deps.print(`[ask] ⓪ 발사 트리 검사 — ⚠️ 이 트리는 ${probe.reference}보다 ${probe.behind}커밋 뒤처졌다${divergence}: ${updateLabel}: ${updateCommand} — ${pullSafety}`);
    deps.log('ask-launching-tree', {
      outcome: isDiverged ? 'diverged' : 'behind', ahead: probe.ahead, behind: probe.behind, reference: probe.reference,
      updateCommand,
      pullFfOnlySafety: 'current-live-runs-must-be-zero-confirm-in-later-preflight',
    }, 'warn');
    return;
  }
  deps.log('ask-launching-tree', {
    outcome: probe.ahead > 0 ? 'ahead' : 'current', ahead: probe.ahead, behind: probe.behind, reference: probe.reference,
  }, 'info');
}

async function runPrePreflight(
  input: AskLaunchFlowInput,
  deps: AskLaunchFlowDeps,
): Promise<LaunchPreflightResult | false | undefined> {
  const parsedHints = parseAskTargetPathHintsResult(input.askText);
  const hints = parsedHints.paths;
  if (hints.length === 0) {
    deps.log('ask-pre-preflight-skipped', {
      reason: parsedHints.labelMissing ? 'label-missing' : 'all-fragments-rejected',
      rejectedCount: parsedHints.rejected.length,
      rejectedReasons: [...new Set(parsedHints.rejected.map(({ reason }) => reason))],
      askChars: input.askText.length,
      inputSource: input.inputSource,
    }, 'warn');
    if (parsedHints.labelMissing) {
      deps.print('[ask] ⓪ 저작 전 예비 검사 — ⚠️ 건너뜀: ask 첫 줄에 「대상 경로:」/「target paths:」 라벨이 없다 (⛔ 「충돌 없음」이 아니다)');
    } else {
      deps.print(`[ask] ⓪ 저작 전 예비 검사 — ⚠️ 건너뜀: 「대상 경로」 라벨 뒤 조각 ${parsedHints.rejected.length}개가 모두 버려졌다: ${renderRejectedAskTargetPathHints(parsedHints.rejected)} (⛔ 「충돌 없음」이 아니다)`);
    }
    return undefined;
  }
  if (parsedHints.rejected.length > 0) {
    deps.print(`[ask] ⓪ 저작 전 예비 검사 — ⚠️ 「대상 경로」 조각 ${parsedHints.rejected.length}개를 버렸다: ${renderRejectedAskTargetPathHints(parsedHints.rejected)}`);
  }
  const preflightDeps = await deps.buildPreflightDeps();
  const preDecision = decideAskPreflight(
    {
      goalFile: '', // ⛔ 아직 골이 «없다» — pathsOverride 를 주므로 읽지 않는다
      liveRunWindowMinutes: input.liveRunWindowMinutes,
      recentChangeWindowDays: input.recentChangeWindowDays,
      openPrsLimit: OPEN_PR_LIMIT,
      pathsOverride: hints,
      askText: input.askText,
      declaredPathsRoot: deps.cwd(),
    },
    preflightDeps,
    input.forceRequested,
  );
  deps.print(`[ask] ⓪ 저작 전 예비 검사 — ask 힌트 경로 ${hints.length}개(추정)`);
  deps.print(renderLaunchPreflight(preDecision.result, input.forceRequested && preDecision.result.blockers.length > 0, 'before-authoring'));
  observeLaunchPreflight(deps, 'before-authoring', preDecision, input.runId);
  // ⛔⭐ A2 「맹점 창」 — 원장에 «쓰지» 않고 이미 남는 관측을 «읽어» 같은 경로의 최근 저작을 본다.
  //   ⚠️ 순서: 내 `ask-pre-preflight` 를 «남기기 전에» 읽는다(자기 자신과 안 겹치게).
  const authoringSamples = deps.recentAuthoringSamples();
  if (authoringSamples === null) {
    deps.print('[preflight] ⚠️ 동시 저작 검사 «못 쟀다» — 관측 조회 실패 (⛔ 「없음」이 아니다)');
    deps.log('ask-concurrent-authoring', { paths: hints, unmeasurable: true }, 'warn');
  } else {
    const overlaps = classifyConcurrentAuthoring(hints, authoringSamples, deps.now());
    const notice = renderConcurrentAuthoringNotice(overlaps);
    if (notice) deps.print(notice);
    deps.log('ask-concurrent-authoring', {
      paths: hints, sampleCount: authoringSamples.length, overlapCount: overlaps.length,
      overlaps: overlaps.slice(0, 3).map(({ agoMinutes, sharedPaths }) => ({ agoMinutes, sharedPaths })),
    }, overlaps.length ? 'warn' : 'info');
  }
  deps.log('ask-pre-preflight', {
    inputSource: input.inputSource,
    // ⛔⭐ 필드 이름을 ⑵⑶⑷ 와 «같게» 둔다 — 2026-08-11 실측: 여기만 `hintPaths` 라서
    //   반복 계수가 ⓪ 막힘을 «영영 못 셌다»(같은 것에 두 이름을 준 그날의 다섯째 사례).
    paths: hints,
    pathsAreHints: true,   // ⭐ 「추정이었다」는 사실은 «따로» 남긴다(값을 지우지 않고 표시한다)
    blockers: blockersForObservation(preDecision.result.blockers),
    shouldLaunch: preDecision.shouldLaunch,
  }, preDecision.shouldLaunch ? 'info' : 'warn');
  if (preDecision.shouldLaunch) return preDecision.result;
  // ⛔ ⓪ 에서도 «묻는다» — 종전엔 여기서 바로 끊어서 물음도 반복 계수도 안 돌았다(🅣 라이브 지적).
  return (await resolveBlockedInteractively(preDecision.result, '(저작 전 · 골 없음)', deps))
    ? preDecision.result
    : false;
}

/** ⑴b 되묻기 «수신» — 답이 들어가면 «재저작»하고 그 새 골을 돌려준다.
 *  ⛔ 무인 계약은 그대로다 — 대화형이 «아니면» 종전처럼 지나가고, 그 사실을 관측에 남긴다. */
async function intakeClarifications(
  authored: AskAuthoredGoal,
  input: AskLaunchFlowInput,
  deps: AskLaunchFlowDeps,
  selfResolveClarifications: ResolvedSelfResolveClarifications,
): Promise<string> {
  let effectiveGoalFile = authored.path;
  let document = deps.readFile(effectiveGoalFile);
  const { pending, mode } = planClarificationIntake(document, deps.isInteractive());
  // ⛔⭐ 이 세 갈래를 «관측 스토어»에도 남긴다 — 종전엔 `print` 로 화면에만 갔다.
  //   📏 2026-08-11 73차 실측: `ask-authored` 83건인데 `ask-reauthored` 5건(6%)이고 그 5가 «전부 합성(SENTINEL)»이다.
  //     ⇒ 「실골에서 되묻기가 나는가」를 물었는데 ***분모를 만들 값이 로그에 없었다***.
  //   🎯 ⇒ 📌 「0」이 「ask 가 명확해서」인지 「탐지기가 안 무는지」를 가르려면 이 값이 «세어져야» 한다.
  //   ⛔ 새 계측기를 만들지 않는다 — 이 파일이 이미 쓰는 `deps.log` 하나를 쓴다.
  deps.log('ask-clarification-intake', {
    mode,                                   // none | deferred-noninteractive | ask
    pendingCount: pending.length,
    interactive: deps.isInteractive(),
    goalFile: effectiveGoalFile,
  }, 'info');
  if (mode === 'none') {
    deps.print('[ask] ⑴b 되묻기 없음 — 저작기가 물을 것이 없었다');
    return effectiveGoalFile;
  }
  if (mode === 'deferred-noninteractive') {
    // The resolver comes in through deps (I/O seam): production entrances pass the author
    // self-resolver; a caller that injects none keeps the previous deferred behaviour.
    if (selfResolveClarifications.value && deps.selfResolveClarification) try {
      const resolution = await selfAnswerGoalDocumentClarifications(document, {
        path: 'ask', ask: input.askText, resolver: deps.selfResolveClarification,
      });
      if (resolution.newlyAnswered > 0) {
        (deps.writeGoalDocument ?? deps.writeFile)(effectiveGoalFile, resolution.document);
        document = resolution.document;
      }
    } catch (error) {
      deps.log('ask-clarify', { goalFile: effectiveGoalFile, reason: 'self-answer-failed', error: error instanceof Error ? error.message : String(error) }, 'warn');
    }
    const remaining = planClarificationIntake(document, false).pending;
    // 미답으로 남은 문항만 기존 답변 창구를 안내한다.
    deps.print(`[ask] ⑴b ⚠️ 미답 되묻기 ${remaining.length}건 — 저작은 그대로 간다 · 구현 전에 LLM 릴레이가 먼저 답하고, 못 하면 미답으로 진행한다 (사람을 기다리지 않는다)`);
    for (const item of remaining) {
      deps.print(`[ask]    ❓ [${item.questionId}] ${item.question}`);
      item.options.forEach((option, index) => deps.print(`[ask]       ${index}) ${option.label}`));
    }
    if (remaining.length > 0) {
      const goalArg = deps.relativeToCwd(effectiveGoalFile);
      deps.print(`[ask]    ▶ 답하려면: elanous self clarify answer ${goalArg} <questionId> <옵션번호>   (자유 답은 --other "<문장>")`);
      deps.print(`[ask]    ▶ 답한 뒤 재저작: elanous self author --supersedes ${goalArg}`);
    }
    return effectiveGoalFile;
  }
  deps.print(`[ask] ⑴b 저작기가 ${pending.length}건 묻는다 — 빈 줄은 건너뛴다(그 건은 DEFERRED 로 남는다)`);
  let answeredCount = 0;
  let seedQuestionId = '';
  for (const item of pending) {
    deps.print(`\n[ask] ❓ ${item.question}`);
    item.options.forEach((option, index) => deps.print(`        ${index}) ${option.label} — ${option.description}`));
    if (item.includeOther) deps.print('        (숫자 = 위 옵션 · 그 밖의 입력 = 자유 답 · 빈 줄 = 건너뜀)');
    const reply = deps.readClarification
      ? await deps.readClarification(item)
      : await deps.readLine('        > ');
    // ⛔ 「옵션인가 자유 답인가 · 빈 줄인가」 판정도 순수 seam 이 한다.
    const applied = applyClarificationReply(document, item, reply);
    if (!applied.answered) continue;
    document = applied.document;
    if (answeredCount === 0) seedQuestionId = item.questionId;
    answeredCount += 1;
  }
  deps.log('ask-clarify', {
    inputSource: input.inputSource, goalFile: effectiveGoalFile,
    pendingCount: pending.length, answeredCount, interactive: deps.isInteractive(),
  }, 'info');
  if (answeredCount === 0) {
    deps.print('[ask] ⑴b 답이 없다 — 그대로 간다(미답은 골에 DEFERRED 로 남는다)');
    return effectiveGoalFile;
  }
  deps.writeFile(effectiveGoalFile, document);
  deps.print(`[ask] ⑴b ${answeredCount}건 답함 — 그 답을 시드로 «재저작»한다`);
  // ⭐ `--from-clarification` 은 답한 것 «전부»를 시드로 가져간다(하나만 지목해도 된다).
  const reauthored = await deps.authorGoal([], {
    cwd: deps.cwd(),
    ...(input.groundingCwd === undefined ? {} : { groundingCwd: input.groundingCwd }),
    ...(input.authorGrade === undefined ? {} : { authorGrade: input.authorGrade }),
    fromClarification: `${deps.relativeToCwd(effectiveGoalFile)}#${seedQuestionId}`,
    reauthorFromAnsweredClarification: true,
    selfResolveClarifications: selfResolveClarifications.value,
  });
  const parentDocument = document;
  effectiveGoalFile = reauthored.path;
  deps.print(`[ask] ⑴b 재저작됨: ${reauthored.path}`);
  // ⛔ 「재저작이 «났다»」와 「재저작이 «옳았다»」는 다른 물음이다(JDG-T35 3단 ⑶).
  const childDocument = reauthored.authored?.document ?? deps.readFile(reauthored.path);
  const askFidelity = classifyReauthoredAsk(parentDocument, childDocument);
  if (askFidelity !== 'preserved') {
    deps.print(`[ask] ⑴b ⚠️ 재저작 ask 판정: ${askFidelity} — ⛔ 「preserved」가 아니면 사람의 ask 가 살아남았는지 «확인하라»`);
  }
  deps.log('ask-reauthored', {
    inputSource: input.inputSource, fromGoalFile: authored.path,
    goalFile: reauthored.path, answeredCount,
    grounded: reauthored.authored?.grounded ?? null,
    askFidelity,
    selfResolveClarifications: selfResolveClarifications.value,
    selfResolveClarificationsSource: selfResolveClarifications.source,
  }, 'info');
  return effectiveGoalFile;
}

/** ⭐ 한 문장/한 파일에서 «발사 직전»까지 — CLI 와 TUI 가 이 «한 함수»를 부른다.
 *  ⛔ 이 함수는 런을 «띄우지 않는다». 발사 여부와 최종 골 파일만 돌려준다. */
export async function runAskLaunchFlow(
  input: AskLaunchFlowInput,
  deps: AskLaunchFlowDeps,
): Promise<AskLaunchFlowResult> {
  const entrance = input.entrance;
  const askStartedAt = deps.now();
  const selfResolveClarifications = resolveSelfResolveClarifications(input.selfResolveClarifications);
  deps.log('harness.entrance', {
    entrance: entrance.id,
    entranceStatus: entrance.status,
    surface: entrance.surface,
    inputSource: input.inputSource,
    runId: null,
  }, 'info');
  const retirementNotice = retiredEntranceNotice(entrance);
  if (retirementNotice) deps.print(retirementNotice);
  deps.log('ask-start', {
    inputSource: input.inputSource,
    ...(input.askFile === undefined ? {} : { askFile: input.askFile }),
    askChars: input.askText.length,
    liveRunWindowMinutes: input.liveRunWindowMinutes,
    forceRequested: input.forceRequested,
    selfResolveClarifications: selfResolveClarifications.value,
    selfResolveClarificationsSource: selfResolveClarifications.source,
    // ⛔ 이 목록은 «광고»다 — 실제 단계와 어긋나면 조회하는 사람이 없는 단계를 찾거나 있는 단계를 안 찾는다.
    // ⛔ 분해 단계는 «두 이름 중 하나»로 난다 — 켜졌으면 `…-decomposition`, 꺼졌으면 `…-decomposition-skipped`.
    //   ⭐ 뒤엣것을 빼 두면 조회하는 사람이 「분해 관측이 0건이다」를 보고 «없어졌다»로 읽는다(실은 꺼진 것이다).
    steps: ['ask-start', 'ask-pre-preflight', 'ask-authored', 'ask-launching-tree', 'ask-preflight', 'ask-launch-decomposition', 'ask-launch-decomposition-skipped', 'ask-launch'],
  }, 'info');

  const launchPreflight = await runPrePreflight(input, deps);
  if (launchPreflight === false) return { kind: 'stopped-before-authoring' };

  await deps.beforeAuthoring?.();
  const authorAndPreflight = async (authorAskText: string = input.askText, machineSuggestedTargetPaths: readonly string[] = []): Promise<{
    readonly goalFile: string;
    readonly decision: ReturnType<typeof decideAskPreflight>;
  }> => {
    // ⛔ 수를 박지 않는다 — 「100~110초」가 박혀 있었고 2026-08-23 prod 실측은 «206초»(2배)였다.
    //    재는 명령: elanous logs --category goal-author --event phase-end --json --json-data
    deps.print('[ask] ⑴ 저작 — self author (수 분 걸린다 · 페이즈별 실측은 goal-author/phase-end)');
    // ⛔⭐ ask 가 골 종류를 «선언했으면» 저작기에 넘긴다.
    //   📏 2026-09-08 실측: 안 넘겨서 `- GoalType: research` 를 쓴 ask 가 `implement` 로 저작됐고
    //     연구 골이 `gate`·`rework` 를 밟았다. `--dry-run` 은 선언을 «읽고» 있어서 두 표면이 갈렸다.
    //   ⛔ 선언이 «없을 때» 넘기면 안 된다 — 저작기의 정식 기본값을 덮어쓰게 된다.
    const declaredAskGoalType = declaredGoalType(input.askText);
    const goalType = input.goalType ?? declaredAskGoalType;
    const frontObservation = {
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(goalType === null ? {} : { goalType }),
    };
    // ⭐ RFC §5 5단계 — 확인된 implement 저작만 활성 구현 그래프에 이름을 잇는다.
    observeFrontNodeEntry('author', { ...frontObservation, provenance: 'authoring-start' });
    const authored = await deps.authorGoal([authorAskText], {
      cwd: deps.cwd(),
      ...(input.groundingCwd === undefined ? {} : { groundingCwd: input.groundingCwd }),
      ...(input.authorGrade === undefined ? {} : { authorGrade: input.authorGrade }),
      ...(goalType === null ? {} : { goalType }),
      // ⛔ 인라인 ask(`harness say`)는 askFile 이 없다 — 그 칸을 넘기면 저작기가 빈 줄을 쓴다.
      ...(() => {
        if (input.inputSource !== 'ask' || input.askFile === undefined) return {};
        const askFile = lineageAskFile(input.askFile);
        return askFile === undefined ? {} : { askFile };
      })(),
      ...(launchPreflight === undefined ? {} : { launchPreflight }),
      selfResolveClarifications: selfResolveClarifications.value,
    });
    deps.print(`[ask] 저작됨: ${authored.path}`);
    // AUTHOR-TRACE: the authored goal file can be cleaned up later — keep path ⊕ sha256 ⊕ size in the run ledger and
    // archive the body, so authoring length is measurable after the fact (GOAL-BENCH · AUTHOR-LITE).
    const traceIds = {
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(authored.authored?.authorRunId === undefined ? {} : { authorRunId: authored.authored.authorRunId }),
    };
    if (authored.authored?.document !== undefined && (traceIds.runId !== undefined || traceIds.authorRunId !== undefined)) {
      try {
        const trace = (deps.recordAuthoredGoal ?? recordAuthoredGoal)(traceIds, authored.path, authored.authored.document);
        deps.log('goal-authored-trace', { ...traceIds, ...trace }, 'info');
      } catch (error) {
        deps.log('goal-authored-trace-failed', { ...traceIds, error: error instanceof Error ? error.message : String(error) }, 'warn');
      }
    } else {
      deps.log('goal-authored-trace-skipped', {
        reason: authored.authored?.document === undefined ? 'no-authored-document' : 'no-run-or-author-id', path: authored.path,
      }, 'warn');
    }
    const markerCounts = authored.authored?.document === undefined
      ? null
      : countMissingAuthoredConstraintMarkers(input.askText, authored.authored.document);
    if (markerCounts !== null && markerCounts.missingMarkers > 0) {
      deps.print(`[ask] ⑴ ⚠️ ask 제약 마커 ${markerCounts.missingMarkers}/${markerCounts.totalMarkers}개가 골 문서에 안 넘어갔다 — 확인: elanous self author --lint ${deps.relativeToCwd(authored.path)} · 형식을 고쳐 다시 저작: elanous self author --supersedes ${deps.relativeToCwd(authored.path)}`);
    }
    // ⛔ goalId 는 «저작된 문서»에서 읽는다 — AskAuthoredGoal 에 그 필드가 «없다»(계약을 지어내지 않는다).
    const authoredGoalId = authored.authored?.document === undefined
      ? undefined
      : parseGoalId(authored.authored.document) ?? undefined;
    observeFrontNodeEntry('plan', {
      ...frontObservation,
      provenance: 'authoring-plan',
      ...(authoredGoalId === undefined ? {} : { goalId: authoredGoalId }),
    });
    deps.log('ask-authored', {
      inputSource: input.inputSource,
      ...(input.askFile === undefined ? {} : { askFile: input.askFile }),
      goalFile: authored.path,
      elapsedMs: deps.now() - askStartedAt,
      grounded: authored.authored?.grounded ?? null,
      // ⛔⭐ 「ask 가 골 종류를 «선언했나»」 — 원장의 `goalTypeSource` 로는 «못 가르는» 값이다.
      //   그 축은 저작된 GOAL 문서를 읽는데 저작기가 «언제나» 그 줄을 써서 항상 `declared` 가 된다
      //   (2026-09-08 실측: 표본 7건 전부 declared · 다른 값 0). ⇒ 여기서 「사람이 썼나」를 따로 남긴다.
      askGoalTypeDeclaration: askGoalTypeDeclaration(input.askText),
      ...(input.goalType === undefined ? {} : { goalTypeOverride: input.goalType }),
      ...(input.goalType !== undefined && declaredAskGoalType !== null && input.goalType !== declaredAskGoalType
        ? { goalTypeMismatch: { override: input.goalType, declared: declaredAskGoalType } }
        : {}),
      ...(markerCounts ?? {}),
      selfResolveClarifications: selfResolveClarifications.value,
      selfResolveClarificationsSource: selfResolveClarifications.source,
    }, markerCounts !== null && markerCounts.missingMarkers > 0 ? 'warn' : 'info');

    // ⛔ 되묻기에 답하면 «새 골»이 나온다 — 아래 전제 검사·발사는 그 «최종» 골을 써야 한다.
    const goalFile = await intakeClarifications(authored, input, deps, selfResolveClarifications);
    const preflightDeps = await deps.buildPreflightDeps();
    observeLaunchingTree(deps, preflightDeps);
    const askOutsidePathHints = parseAskTargetPathHintsResult(input.askText).paths;
    const decision = decideAskPreflight(
      {
        goalFile,
        liveRunWindowMinutes: input.liveRunWindowMinutes,
        recentChangeWindowDays: input.recentChangeWindowDays,
        openPrsLimit: OPEN_PR_LIMIT,
        ...(askOutsidePathHints.length > 0 ? { askOutsidePathHints } : {}),
        // AUTO-TARGET: paths injected by the candidate search (not written in the ask) — a NOT-GROUNDED goal stops on them.
        ...(machineSuggestedTargetPaths.length > 0 ? { machineSuggestedTargetPaths } : {}),
        declaredPathsRoot: deps.cwd(),
      },
      preflightDeps,
      input.forceRequested,
    );
    const preflight = decision.result;
    deps.print(renderLaunchPreflight(preflight, input.forceRequested && preflight.blockers.length > 0, 'before-launch'));
    observeLaunchPreflight(deps, 'before-launch', decision);
    // ⛔ 자식 격리 worktree를 만들기 전, 이 흐름을 호출한 작업 트리에서만 센다.
    //    이 관측은 발사 판정의 입력이 아니다 — 의도적으로 옛 판에서 쏘는 경우도 있다.
    const invokerBehindDefaultBranch = deps.measureInvokerBehindDefaultBranch?.()
      ?? measureInvokerBehindDefaultBranch(deps.cwd());
    deps.print(renderInvokerBehindDefaultBranch(invokerBehindDefaultBranch));
    const toolTree = deps.measureToolTreeBehindDefaultBranch
      ? deps.measureToolTreeBehindDefaultBranch()
      : measureToolTreeBehindDefaultBranch(deps.cwd());
    // 최신이면 «말하지 않는다» — 남의 프로젝트 런마다 한 줄씩 늘지 않게. 뒤처졌거나 못 쟀을 때만 말한다.
    if (toolTree && !(toolTree.observation.state === 'measured' && toolTree.observation.commits === 0)) {
      deps.print(toolTree.observation.state === 'measured'
        ? `[preflight] ⚠️ elanous 도구 트리(${toolTree.toolRoot}) 가 원격 기본 브랜치보다 ${toolTree.observation.commits}커밋 뒤처졌다 — 이미 착지한 수리가 이 런에 «없다» (${toolTree.observation.baseRef})`
        : `[preflight] elanous 도구 트리(${toolTree.toolRoot}) 원격 기본 브랜치 대비 — ⚠️ 못 쟀다 (${toolTree.observation.reason})`);
    }
    const askHintPaths = parseAskTargetPathHintsResult(input.askText).paths;
    const addedPaths = preflight.paths.filter((path) => !askHintPaths.includes(path));
    deps.log('ask-preflight', {
      inputSource: input.inputSource,
      ...(input.askFile === undefined ? {} : { askFile: input.askFile }),
      goalFile,
      paths: preflight.paths,
      // ⭐ 화면에 찍은 증분을 관측에도 «같은 값»으로 남긴다 — 사후에 「얼마나 자주 넓어지나」를
      //   세려면 화면이 아니라 이 스토어를 봐야 한다(H-24 의 표본을 손으로 모은 이유).
      //   ⛔ ask 힌트가 0개면 증분을 «안 싣는다» — 0 에서 늘어난 것을 「넓혔다」로 세면 거짓이다.
      ...(askHintPaths.length > 0 ? { askHintPathCount: askHintPaths.length, widenedPaths: addedPaths } : {}),
      invokerBehindDefaultBranch,
      ...(toolTree ? { toolTreeBehindDefaultBranch: { toolRoot: toolTree.toolRoot, ...toolTree.observation } } : {}),
      blockers: blockersForObservation(preflight.blockers),
      // ⛔ 「지나갔다」와 「없었다」를 다른 값으로 — 경고도 차단과 같은 겹침 근거를 남긴다.
      warnings: blockersForObservation(preflight.warnings),
      // ⛔⭐ 「형제 0」과 「브랜치를 «못 구해» 안 봤다」를 «다른 값»으로 남긴다 — 접으면
      //   다음 사람이 「형제가 없다」로 읽고 이 자리를 다시 판다(2026-08-28 실측: 이 값이
      //   판정에는 있는데 «싣는 자리가 0곳»이라 원장에서 그 둘을 못 갈랐다).
      plannedBranchStatus: decision.plannedBranchResolution?.status ?? 'absent',
      siblingPrCount: preflight.warnings.filter((w) => w.kind === 'sibling-pr').length,
      openPrs: preflight.openPrs,
      liveRuns: preflight.liveRuns,
      unreadableRuns: preflight.unreadableRuns,
      liveRunWindowMs: preflight.liveRunWindowMs,
      // ⛔ 「플래그를 줬다」와 「실제로 뚫었다」는 다른 값이다(리뷰 should-fix).
      forceRequested: input.forceRequested,
      bypassed: input.forceRequested && preflight.blockers.length > 0,
    }, preflight.blockers.length > 0 ? 'warn' : 'info');
    return { goalFile, decision };
  };

  let authored = await authorAndPreflight();
  let reauthored = false;
  const retryableNoTargetPaths = !input.forceRequested
    && !authored.decision.shouldLaunch
    && authored.decision.result.blockers.length > 0
    && authored.decision.result.blockers.every((blocker) => blocker.kind === 'no-target-paths');
  if (retryableNoTargetPaths) {
    const first = authored;
    reauthored = true;
    deps.print('[ask] ⑴ ⚠️ 대상 경로를 못 찾아 자동 재저작 한 번을 시도한다');
    let candidates: ReturnType<typeof findAskPathCandidates> = { tokens: [], paths: [] };
    if (parseAskTargetPathHintsResult(input.askText).labelMissing) {
      try {
        candidates = (deps.findPathCandidates ?? findAskPathCandidates)(input.askText, { cwd: deps.cwd() });
      } catch (error) {
        candidates = { tokens: [], paths: [], error: error instanceof Error ? error.message : String(error) };
      }
      deps.log('ask-auto-target-candidates', {
        tokens: candidates.tokens, paths: candidates.paths,
        ...(candidates.error === undefined ? {} : { error: candidates.error }),
      }, candidates.error === undefined ? 'info' : 'warn');
    }
    const selectedPaths = candidates.paths.slice(0, 1);
    if (selectedPaths.length > 0) {
      deps.print(`[ask] ⑴ 코드에서 후보 경로 ${selectedPaths.length}개를 찾아 넣고 다시 저작한다: ${selectedPaths.join(' · ')}`);
    }
    authored = await authorAndPreflight(selectedPaths.length > 0
      ? `대상 경로: ${selectedPaths.join(' · ')}\n${input.askText}`
      : input.askText, selectedPaths);
    deps.log('ask-auto-reauthor', {
      candidatePathCount: candidates.paths.length,
      firstGoalFile: first.goalFile,
      secondGoalFile: authored.goalFile,
      firstPathCount: first.decision.result.paths.length,
      secondPathCount: authored.decision.result.paths.length,
      helped: authored.decision.shouldLaunch,
    }, authored.decision.shouldLaunch ? 'info' : 'warn');
  }

  const { goalFile: effectiveGoalFile, decision } = authored;
  const preflight = decision.result;
  // ⭐ 마지막 단계도 «결정»으로 남긴다 — 「막혀서 안 갔다」와 「뚫고 갔다」와 「깨끗해서 갔다」가 다른 값이다.
  const launchObservation = {
    inputSource: input.inputSource,
    entrance: entrance.id,
    entranceStatus: entrance.status,
    goalFile: effectiveGoalFile,
    decision: decision.shouldLaunch
      // ⛔ 「판정을 냈다」와 「그 판정이 실행됐다」는 다른 값이다 — 이 로그는 런 «진입 전»에 찍힌다.
      ? (preflight.blockers.length > 0 ? 'launching-bypassing-blockers' : 'launching-clean')
      : 'stopped-by-preflight',
    blockerCount: preflight.blockers.length,
    ...(reauthored ? { reauthored: true } : {}),
    totalElapsedMs: deps.now() - askStartedAt,
  };
  const launchLevel = decision.shouldLaunch && preflight.blockers.length > 0 ? 'warn' : 'info';
  deps.log('ask-launch', launchObservation, launchLevel);
  deps.log('harness.launch', { ...launchObservation, legacyEvent: 'ask-launch' }, launchLevel);

  // ⛔ 막힘 처리는 `resolveBlockedInteractively` «한 곳»이 소유한다(⓪ 과 같은 것을 쓴다).
  const launchDecision = decision.shouldLaunch
    ? true
    : await resolveBlockedInteractively(preflight, effectiveGoalFile, deps);
  // ⛔ 권고는 실제 launch 분기의 입력이 아니다. opt-out은 문서를 읽기 전에 끝내고,
  // 문서 읽기·분해 실패도 기존 결정을 바꾸지 않는다.
  if (launchDecision) {
    if (input.decomposeBeforeLaunch === false) {
      await recommendLaunchDecomposition(effectiveGoalFile, input, deps);
    } else {
      let document: string;
      let record: LaunchDecompositionRecord;
      try {
        document = deps.readFile(effectiveGoalFile);
        record = await recommendLaunchDecomposition(effectiveGoalFile, input, deps, document)
          ?? { state: 'unmeasurable', outcome: 'failed', reason: '분해 권고 결과가 없다' };
      } catch (error) {
        const message = String((error as { message?: unknown })?.message ?? error);
        deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⚠️ 못 쟀다 (골 문서 읽기 실패: ${message})`);
        logDecompositionObservation(deps, 'ask-launch-decomposition', {
          goalFile: effectiveGoalFile, outcome: 'document-read-failed', unmeasurable: true, error: message,
        }, 'warn');
        return { kind: 'launch', goalFile: effectiveGoalFile };
      }
      // ② ⛔ 기록은 «관측»이지 발사 조건이 아니다 — 쓰기 실패가 발사 흐름을 throw 로 끊으면 안 된다(리뷰 must-fix).
      try {
        deps.writeFile(effectiveGoalFile, recordLaunchDecomposition(document, record));
      } catch (error) {
        const message = String((error as { message?: unknown })?.message ?? error);
        deps.print(`[ask] ⑷ 발사 전 분해 권고 — ⚠️ 기록 못 남김 (골 문서 쓰기 실패: ${message})`);
        logDecompositionObservation(deps, 'ask-launch-decomposition', {
          goalFile: effectiveGoalFile, outcome: 'document-write-failed', unmeasurable: true, error: message,
        }, 'warn');
      }
    }
  }
  return launchDecision
    ? { kind: 'launch', goalFile: effectiveGoalFile }
    : { kind: 'stopped-by-preflight', goalFile: effectiveGoalFile };
}
