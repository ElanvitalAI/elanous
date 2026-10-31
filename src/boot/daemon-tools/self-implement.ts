// SelfImplement — 데몬/ACP 툴 서피스 어댑터 (2026-07-20 · P0 막 배선).
//
// `elanous --acp-server`(createDaemonRuntime → toolSurface('webterm'))가 노출하는 툴에 self-build 를
// 얹어, ACP 클라이언트(acpx·codex·다른 에이전트)도 elanous self-implement 를 트리거할 수 있게 한다.
// CLI(`elanous self implement`)·내부 SelfImplement 툴과 **같은 코어**(runSelfImplement)를 태운다.
//
// ★ P0(DESIGN-cross-surface-autonomy-membrane §10) — ctx 를 **막(SurfaceUx)** 으로 소비:
//   - approvePr ← ①operator 사전승인(user-config `tools.selfImplement.autoOpenPr`·**기본 ON**·
//     대표 결정 2026-07-26) → ②미승인이면 ux.confirm (PR open 승인 버튼·서피스 HITL 채널
//     없으면 false=fail-closed). CLI 의 `--open-pr`(사람이 친 플래그=명시 승인)에 대응하는
//     툴-경로 등가물이 없어 무인 시 완성 산출이 worktree 에 좌초하던 갭을 ①이 닫는다.
//     ⚠️ PR **개설**까지만 — 병합은 별도 게이트(autoMerge+리뷰 clean).
//   - onProgress ← ux.progress (각 스테이지 진행을 서피스로).
//   - 큰 gate log → ux.spillFile (파일 첨부).

import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { LLMToolSpec } from '../../llm.js';
import { childLifetimeSignal } from '../../turn-abort-scope.js';
import { buildSelfImplementSpec } from '../../self-implement/self-implement-runtime.js';
import { runSelfImplementCliCommand, type SelfImplementCliDeps, type SelfImplementCliOpts, type SelfImplementCliOutcome } from '../../self-implement/self-implement-cli.js';
import type { DevPipelineDeps } from '../../self-dev/dev-pipeline.js';
import type { SelfImplementResult, SelfImplementSeams, SelfImplementProgressStage } from '../../self-implement/orchestrator.js';
import { surfaceUxFromDispatchCtx } from '../../agent/surface-ux/build.js';
import type { SurfaceUx } from '../../agent/surface-ux/types.js';
import { resolveAutoOpenPrDecision } from '../../self-implement/auto-open-pr.js';
import { resolveObserveOnlyDecision, _setObserveOnlyConfigReaderForTesting as _setSharedObserveOnlyReaderForTesting } from '../../self-implement/observe-only.js';
import { debug } from '../../debug/log.js';
import { globalAgentRegistry, type AgentRegistry } from '../../agent/registry.js';
import type { TaskNotificationQueue } from '../../agent/task-notification.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { resolveGoalAuthorReviewerPrecheckEnabled, writeAuthoredGoal } from '../../self-implement/goal-author.js';
import { selfAnswerOrAssumeGoalDocumentClarifications, type GoalClarificationSelfResolver } from '../../self-implement/goal-author-clarification.js';
import { writeGoalDocumentAtomic } from '../../self-implement/goal-document-write.js';
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { createGoalAuthorDecomposeSteps, readRecentStepCountsFailOpen, readRecentStepCountsFromLogStore, type RecentStepCountReader } from '../../self-implement/goal-author-decompose.js';
import type { DaemonToolDispatchCtx } from './types.js';

// ⛔ 정의는 잎 모듈이 갖는다 — 순환 import 로 인한 TDZ 를 «구조적으로» 없앤다(그 파일 머리말이 사유).
//    여기서는 종전 소비자를 위해 «재수출»만 한다(경로를 바꾸지 않는다).
export { SELF_IMPLEMENT_TOOL_NAMES } from './self-implement-names.js';

/** Preserve conservative behavior for hand-built and non-LLM dispatch contexts. */
export function resolveDispatchEntry(ctx: DaemonToolDispatchCtx): import('../../agent-substrate/execution/ingestion-policy.js').IngestionEntry {
  return ctx.entry ?? 'external-verbatim';
}

/** 데몬 서피스용 스펙 — 내부 툴과 단일 출처(buildSelfImplementSpec) 공유. */
export function buildSelfImplementDaemonSpec(): LLMToolSpec {
  const spec = buildSelfImplementSpec();
  const properties = spec.parameters.properties as Record<string, Record<string, unknown>>;
  properties.goalFile = {
    type: 'string',
    description: '기존 SelfImplement 골 문서를 재개할 때만 지정한다. 문서에 결정을 반영한 뒤 같은 골을 다시 실행하며, 저장소 내부 GOAL-* 문서 경로만 허용된다.',
  };
  return spec;
}

// ⭐ 판정은 `../../self-implement/observe-only.js` **한 자리**가 한다 — 이 스위치를 타는 경로가
//    둘(여기 ⊕ tool-runtime)이라 각자 읽으면 언젠가 갈린다(실측 2026-08-02: 여기만 있어서 TUI 가 샜다).
function resolveObserveOnly() {
  return resolveObserveOnlyDecision();
}

/** Test seam for config-read failure handling. 단일 출처의 seam 을 그대로 재노출한다. */
export function _setObserveOnlyConfigReaderForTesting(reader?: () => boolean): void {
  _setSharedObserveOnlyReaderForTesting(reader);
}

export { parseRecentStepCountsFromLogRows, readRecentStepCountsFromLogStore } from '../../self-implement/goal-author-decompose.js';
export type { RecentStepCountReader } from '../../self-implement/goal-author-decompose.js';

let recentStepCountReader: RecentStepCountReader = readRecentStepCountsFromLogStore;

/** Test seam so dispatch tests inject counts without touching real log files. */
export function _setRecentStepCountReaderForTesting(reader?: RecentStepCountReader): void {
  recentStepCountReader = reader ?? readRecentStepCountsFromLogStore;
}

type CreateGoalAuthorDecomposeSteps = typeof createGoalAuthorDecomposeSteps;
let createDecomposeSteps: CreateGoalAuthorDecomposeSteps = createGoalAuthorDecomposeSteps;

/** Test seam so dispatch tests observe the exact config passed to decompose-step creation. */
export function _setCreateGoalAuthorDecomposeStepsForTesting(fn?: CreateGoalAuthorDecomposeSteps): void {
  createDecomposeSteps = fn ?? createGoalAuthorDecomposeSteps;
}

/** 진행 종료 스테이지(phase='end') — 그 외는 delta(start 제외). */
const END_STAGES: readonly SelfImplementProgressStage[] = ['pr-opened', 'aborted', 'gate-failed', 'pr-declined'];

// ⭐ 결과 네 꼴(HARNESS-RESULT-CONTRACT · RFC-tui-tool-surface-on-graph-harness §4 · 0.2.26) —
//   종전 `{observed:true}` 한 비트는 모델이 «안 됐다 → 직접 편집»으로 읽었다(UX S1-02 · 47 도구).
//   ⇒ launched / pending / observed-only / failed 네 꼴로 구조화해 «다음 행동»을 문면으로 고정한다.
//   ⚠️ launched 꼴은 SelfImplementResult 필드를 **그대로 보존**한다 — runId 조인·원장 소비자 무손상.
export type SelfImplementLaunchedToolResult = SelfImplementResult & { runId: string; kind: 'launched'; message: string; next: string; missing: string[] };
export type SelfImplementPendingToolResult = Partial<SelfImplementResult> & { kind: 'pending'; message: string; next: string; missing: string[] };
export type SelfImplementObservedOnlyToolResult = { kind: 'observed-only'; observed: true; message: string; next: string; missing: ['runId', 'node'] };
export type SelfImplementFailedToolResult = Partial<SelfImplementResult> & { kind: 'failed'; reason: string; message: string; next: string; missing: string[]; goalFile?: string };
export type SelfImplementToolResult = SelfImplementLaunchedToolResult | SelfImplementPendingToolResult | SelfImplementObservedOnlyToolResult | SelfImplementFailedToolResult;

/** 하니스가 런을 맡았다 — 파일 편집은 하니스 몫이므로 모델의 직접 Write/Edit 을 문면으로 막는다. */
export function buildLaunchedToolResult(result: SelfImplementResult): SelfImplementLaunchedToolResult | SelfImplementPendingToolResult {
  if (!result.runId) return buildPendingToolResult(result);
  const runId = result.runId;
  const node = result.node || null;
  const missing = node ? [] : ['node'];
  const query = `eln self run ${runId}`;
  return {
    ...result,
    runId,
    kind: 'launched',
    next: query,
    missing,
    message: `하니스가 맡았습니다 · 런 ${runId} · 노드 ${node ?? '미관측'} · 다음 조회: ${query} · 이 턴에서 파일을 직접 편집하지 마세요`,
  };
}

/** 완료 또는 접수는 관측했지만 실제 런 ID가 없어 발사를 단언할 수 없다. */
export function buildPendingToolResult(result: SelfImplementResult): SelfImplementPendingToolResult {
  const { runId: _unconfirmedRunId, ...observed } = result;
  return {
    ...observed,
    kind: 'pending',
    next: 'eln self running-runs',
    missing: ['runId', ...(result.node ? [] : ['node'])],
    message: '하니스 응답을 받았지만 런 식별자는 아직 미관측입니다 · 진행 중 런 조회: eln self running-runs · 일치하는 런이 없으면 요청을 다시 보내세요 · 이 턴에서 파일을 직접 편집하지 마세요',
  };
}

/** 관측 전용 — 런이 발사되지 «않았다»는 사실과 «구현 실패가 아니다»를 함께 말한다. */
export function buildObservedOnlyToolResult(): SelfImplementObservedOnlyToolResult {
  return {
    kind: 'observed-only',
    observed: true,
    missing: ['runId', 'node'],
    next: '실제 발사를 원하면 관측 전용 모드를 끈 뒤 다시 요청하세요',
    message: '관측 전용이라 런을 발사하지 않았습니다 · 코드도 안 바꿨습니다 · 이 결과를 구현 실패로 읽고 직접 Write/Edit 하지 마세요 · 실제 발사를 원하면 관측 전용 모드를 끈 뒤 다시 요청하세요',
  };
}

/** 거부·실패 — 이유와 다음 행동을 구조화해 모델이 재시도·포기·인계를 판단하게 한다. */
export function buildFailedToolResult(reason: string, result?: SelfImplementResult): SelfImplementFailedToolResult {
  const next = result?.runId ? `eln self run ${result.runId}` : '요청과 실패 이유를 확인한 뒤 다시 요청하세요';
  return {
    ...(result ?? {}), kind: 'failed', reason, next,
    missing: [...(result?.runId ? [] : ['runId']), ...(result?.node ? [] : ['node'])],
    message: `하니스가 발사되지 않았거나 실패했습니다: ${reason} · 다음: ${next} · 이 턴에서 파일을 직접 편집하지 마세요`,
  };
}

/**
 * ★ base seam 에 막(SurfaceUx) 배선을 얹는다(P0·테스트 가능). approvePr=ux.confirm(fail-closed)·
 * onProgress=ux.progress. 코어(runSelfImplement)·다른 seam(worktree/implement/gate/openPr)은 무손상.
 */
export function buildSelfImplementSurfaceSeams(
  base: SelfImplementSeams,
  ux: SurfaceUx,
  /** operator 사전 승인(user-config `tools.selfImplement.autoOpenPr`·기본 ON).
   *  생략 시 config 를 읽는다(fail-soft: 못 읽으면 종전 대화형 확인). */
  autoOpenPr?: boolean,
): SelfImplementSeams {
  return {
    ...base,
    // ★ PR open 승인.
    //   ① operator 가 사전 승인(config autoOpenPr·기본 ON)했으면 묻지 않고 통과 —
    //      CLI `--open-pr` 플래그가 "사람의 명시 승인"인 것과 등가다. 툴 경로엔 그
    //      등가물이 없어 무인 시 **완성 산출이 worktree 에 좌초**하던 갭을 닫는다.
    //      승인 주체는 사람으로 유지되고 시점만 앞당겨진다(LLM 자기승인 아님).
    //   ② 아니면 막의 confirm(채널 없으면 fail-closed false·자동승인 금지·제1원칙).
    //   ⚠️ 어느 쪽이든 **PR 개설까지만**이다. 병합은 별도 게이트(autoMerge+리뷰 clean).
    approvePr: async (summary) => {
      const decision = autoOpenPr === undefined
        ? resolveAutoOpenPrDecision()
        : { enabled: autoOpenPr, source: 'injected' as const };
      if (decision.enabled) {
        debug.log('daemon-tools.self-implement', 'approve', {
          branch: summary.branch, answer: true, via: 'config:tools.selfImplement.autoOpenPr',
          autoOpenPr: decision.enabled, autoOpenPrSource: decision.source,
          interactive: ux.interactive, surface: ux.surface,
        });
        return true;
      }
      const ok = await ux.confirm({
        prompt: `self-implement PR 열까요? (${summary.branch})`,
        detail: summary.implSummary.slice(0, 300),
        yesLabel: 'PR 열기',
        noLabel: '보류',
      });
      debug.log('daemon-tools.self-implement', 'approve', { branch: summary.branch, answer: ok, via: 'hitl-confirm', interactive: ux.interactive, surface: ux.surface });
      return ok;
    },
    // ★ 진행 push — 각 스테이지를 서피스로(수분 침묵 완화).
    onProgress: (ev) => ux.progress(ev.message, { phase: ev.stage === 'start' ? 'start' : END_STAGES.includes(ev.stage) ? 'end' : 'delta' }),
  };
}

export type SelfImplementRunner = (opts: import('../../self-implement/orchestrator.js').SelfImplementOptions) => Promise<SelfImplementResult>;
type RunSelfImplementCliFn = (
  feature: string,
  opts: SelfImplementCliOpts,
  deps: SelfImplementCliDeps,
) => Promise<SelfImplementCliOutcome>;
type SelfImplementSeamsFactory = (opts: import('../../self-implement/seams.js').DefaultSeamsOptions) => SelfImplementSeams | Promise<SelfImplementSeams>;
type DecisionLedgerFactory = () => DecisionLedger;

async function runSelfImplementViaCli(
  command: RunSelfImplementCliFn,
  feature: string,
  opts: SelfImplementCliOpts,
  deps: SelfImplementCliDeps,
): Promise<SelfImplementResult> {
  const outcome = await command(feature, opts, deps);
  if (!outcome.ok) throw new Error(outcome.message);
  if (outcome.kind !== 'self') throw new Error(`unexpected self-implement CLI outcome: ${outcome.kind}`);
  return outcome.result;
}

type SelfImplementGoalAuthor = (ask: string, cwd: string, deps?: {
  goalTitle?: string;
  decomposeSteps?: (objective: string, opts?: { context?: string }) => Promise<readonly string[]>;
  onProgress?: (phase: import('../../self-implement/goal-author.js').GoalAuthorPhase, event: 'start' | 'end') => void;
  reviewerPrecheckEnabled?: boolean;
}) => Promise<{ path: string }>;

const GOAL_ORIGINAL_TEXT_LIMIT = null;

type GoalAuthorSummary = {
  authored: boolean;
  reused: boolean;
  goalFile: string | null;
  userTextState: 'absent' | 'empty' | 'present';
  originalChars: number | null;
  storedChars: number | null;
  limitChars: null;
  truncated: boolean;
};

function emitGoalAuthorSummary(ux: SurfaceUx, summary: GoalAuthorSummary): void {
  const message = summary.authored
    ? `goal-author authored ${basename(summary.goalFile!)} (${summary.userTextState}; ${summary.storedChars} chars; truncated=${summary.truncated})`
    : summary.reused
      ? `goal-author resumed ${basename(summary.goalFile!)} (${summary.userTextState})`
      : `goal-author not authored (${summary.userTextState}; no goal source)`;
  ux.progress(message, { phase: 'delta' });
}

function resolveResumableGoalFile(requestedPath: string, cwd: string): string {
  const root = realpathSync(cwd);
  const candidate = realpathSync(isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath));
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
    || !/^GOAL-[^/\\]+\.(?:md|txt)$/i.test(basename(candidate))) {
    throw new Error('goalFile must point to an existing GOAL-*.md or GOAL-*.txt document inside the repository');
  }
  return candidate;
}

/** Observability only; tool selection remains model-led. */
function harnessMentionState(userText: string | undefined): 'absent' | 'matched' | 'not-matched' {
  if (userText === undefined) return 'absent';
  return /하니스|harness|self[\s_-]*dev/i.test(userText) ? 'matched' : 'not-matched';
}

/** ACP/데몬 dispatch — runSelfImplement 를 격리(configDir/stateDir)로 구동 + 막(SurfaceUx) 배선. */
export async function dispatchSelfImplement(
  args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx & { autoMerge?: boolean },
  run?: SelfImplementRunner,
  authorGoal: SelfImplementGoalAuthor = writeAuthoredGoal,
  runCli: RunSelfImplementCliFn = runSelfImplementCliCommand,
  seamsFactory?: SelfImplementSeamsFactory,
  clarificationResolver?: GoalClarificationSelfResolver,
  decisionLedgerFactory?: DecisionLedgerFactory,
): Promise<SelfImplementToolResult> {
  const feature = typeof args.feature === 'string' ? args.feature.trim() : '';
  if (!feature) return buildFailedToolResult('SelfImplement: `feature` is required');
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('SelfImplement aborted');
  try {
  const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
  const draft = typeof args.draft === 'boolean' ? args.draft : true;
  const entry = resolveDispatchEntry(ctx);
  const ground = typeof args.ground === 'boolean' ? args.ground : undefined;
  const adversarialReview = typeof args.adversarialReview === 'boolean' ? args.adversarialReview : undefined;
  const autoMerge = ctx.autoMerge;
  const autoReview = autoMerge === true ? true : undefined;

  // 막 — ctx 의 서피스 필드(surfaceHitlChannels/surfaceFileSink/emitFeedback)를 SurfaceUx 로.
  const ux = surfaceUxFromDispatchCtx(ctx);
  const userText = ctx.userText?.slice(0, 500) ?? null;
  debug.log('daemon-tools.self-implement', 'dispatch', {
    feature: feature.slice(0, 80),
    userText,
    userTextTruncated: (ctx.userText?.length ?? 0) > 500,
    harnessMention: harnessMentionState(ctx.userText),
    sessionId: ctx.sessionId ?? null,
    interactive: ux.interactive,
    surface: ux.surface,
    entry,
    ground,
    adversarialReview,
    autoReview,
  });
  const originalUserText = ctx.userText;
  const goalSourceText = originalUserText;
  const originalChars = originalUserText?.length ?? null;
  const storedChars = goalSourceText?.length ?? null;
  const goalTextTruncated = false;
  const observeOnly = resolveObserveOnly();
  debug.log('daemon-tools.self-implement', 'runtime.observe-only-decision', { surface: ux.surface, observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
  if (observeOnly.enabled) {
    debug.log('daemon-tools.self-implement', 'runtime.observed', { surface: ux.surface, observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
    return buildObservedOnlyToolResult();
  }

  let goalFile: string | undefined;
  let resumedGoal = false;
  if (args.goalFile !== undefined) {
    if (typeof args.goalFile !== 'string' || !args.goalFile.trim()) {
      return buildFailedToolResult('goalFile must be a non-empty path to an existing authored goal document');
    }
    try {
      goalFile = resolveResumableGoalFile(args.goalFile, ctx.cwd);
      resumedGoal = true;
    } catch (error) {
      return buildFailedToolResult(error instanceof Error ? error.message : String(error));
    }
  } else if (goalSourceText !== undefined) {
    const recentStepCounts = readRecentStepCountsFailOpen(recentStepCountReader);
    goalFile = (await authorGoal(goalSourceText, ctx.cwd, {
      goalTitle: feature,
      reviewerPrecheckEnabled: resolveGoalAuthorReviewerPrecheckEnabled(),
      decomposeSteps: createDecomposeSteps(ctx.signal, {
        repositoryRoot: ctx.cwd,
        ...(adversarialReview !== undefined ? { adversarialReview } : {}),
        ...(recentStepCounts !== undefined ? { recentStepCounts } : {}),
      }),
      onProgress: (phase, event) => ux.progress(`goal-author ${phase} ${event === 'start' ? 'started' : 'ended'}`, { phase: 'delta' }),
    })).path;
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('SelfImplement aborted');
  }
  if (goalFile) {
    let authoredDocument: string;
    try {
      authoredDocument = readFileSync(goalFile, 'utf8');
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
      const reason = errorCode === 'ENOENT'
        ? 'goal file missing before clarification'
        : 'goal file unreadable before clarification';
      debug.log('daemon-tools.self-implement', 'goal-clarification-file-read-failed', {
        goalFile,
        errorCode: errorCode ?? null,
        reason,
      });
      return buildFailedToolResult(reason);
    }
    const clarification = await selfAnswerOrAssumeGoalDocumentClarifications(authoredDocument, {
      path: 'say-first',
      ...(goalSourceText !== undefined ? { ask: goalSourceText } : {}),
      ...(typeof args.runId === 'string' ? { runId: args.runId } : {}),
      ...(clarificationResolver !== undefined ? { resolver: clarificationResolver } : {}),
    });
    if (clarification.document !== authoredDocument) writeGoalDocumentAtomic(goalFile, clarification.document);
    if (clarification.decisionRequired.length > 0) {
      const ledger = decisionLedgerFactory?.() ?? new DecisionLedger();
      const decisions = clarification.decisionRequired.map((item) => {
        const ref = `self-implement-clarification:${goalFile}:${item.questionId}`;
        return ledger.raiseOnce({
          title: `SelfImplement 확인 필요: ${item.header}`.slice(0, 120),
          category: item.category,
          scqa: {
            s: 'SelfImplement 골 저작 중 자동 답변이 끝나지 않은 확인 질문이 남았다',
            c: '금전·보안·되돌릴 수 없는 외부 효과는 정책 가정으로 승인하지 않는다',
            q: item.question.slice(0, 240),
          },
          pendingQuestion: item.question,
          options: [
            { key: 'a', label: '답을 골 문서에 반영 후 재실행', consequence: '결정 내용을 골 문서에 명시하고 SelfImplement을 다시 호출한다' },
            { key: 'b', label: '진행하지 않음', consequence: '이 범위는 실행하지 않는다' },
          ],
          recommendation: { skipped: true, reason: '금전·보안·되돌릴 수 없는 외부 효과는 자동으로 선택하지 않는다' },
          crossCheckSkipped: '안전상 대표 판단 필요',
          raisedBy: { agent: 'OPC', track: 'OP' },
          refs: [ref],
        }, ref);
      });
      debug.log('daemon-tools.self-implement', 'goal-clarification-no-launch', {
        goalFile,
        decisionIds: decisions.map((decision) => decision.id),
        unanswered: clarification.decisionRequired.length,
        reason: 'safety-critical-clarification-requires-recorded-decision',
      });
      const reason = `goal author clarification requires a recorded decision before launch (${decisions.map((decision) => decision.id).join(', ')})`;
      const next = `Edit ${goalFile} with the explicit answer, then rerun SelfImplement using the same feature and goalFile=${goalFile}; the decision card alone does not launch or resume work`;
      return {
        kind: 'failed', reason, goalFile, next, missing: ['runId', 'node'],
        message: `SelfImplement did not launch: ${reason}. Record the answer in ${goalFile}, then rerun the same feature with goalFile=${goalFile}. A decision-card choice alone does not resume the run.`,
      };
    }
    if (clarification.unanswered > 0) {
      debug.log('daemon-tools.self-implement', 'goal-clarification-assumption-incomplete', {
        goalFile,
        unanswered: clarification.unanswered,
        reason: 'no-launch-unanswered-clarification',
      });
      return buildFailedToolResult(`goal author clarification remains unanswered; launch withheld to prevent a human popup (${clarification.unanswered})`);
    }
  }
  const goalAuthorSummary: GoalAuthorSummary = {
    authored: goalFile !== undefined && !resumedGoal,
    reused: resumedGoal,
    goalFile: goalFile ?? null,
    userTextState: originalUserText === undefined ? 'absent' : originalUserText === '' ? 'empty' : 'present',
    originalChars,
    storedChars,
    limitChars: GOAL_ORIGINAL_TEXT_LIMIT,
    truncated: goalTextTruncated,
  };
  debug.log('daemon-tools.self-implement', 'goal-authored', goalAuthorSummary);
  emitGoalAuthorSummary(ux, goalAuthorSummary);

  const { defaultSeams } = await import('../../self-implement/seams.js');
  const { childInstanceScope } = await import('../../instance/child-scope.js');
  const childScope = childInstanceScope();
  const seams = buildSelfImplementSurfaceSeams(
    await (seamsFactory ?? defaultSeams)({
      ...childScope,
      // ⛔⭐⭐⭐ 2026-08-19 — `ctx.signal` 을 «그대로» 넘기지 않는다(대표 지시).
      //   종전: `signal: ctx.signal` — `#21` 이 «의도»로 배선한 「/cancel → 자식 goal-loop PTY 즉시 kill」.
      //   문제: 그 신호에 ***ESC 도 실려서***, 스트리밍을 멈추려는 키 하나가 몇 십 분짜리 하니스 런을 죽였다.
      //   ⇒ ***`#21` 의 의도는 보존한다*** — `/cancel`(뜻 없는 취소 = kill-children)은 여전히 죽인다.
      //     바뀌는 것은 ***ESC(turn-only)가 이 자식에 «구조적으로» 안 닿는다***는 것 하나뿐이다.
      ...(ctx.signal ? { signal: childLifetimeSignal(ctx.signal)! } : {}),
    }),
    ux,
  );

  const cliOpts: SelfImplementCliOpts = {
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    entry,
    ...(ctx.sessionId ? { parentSessionId: ctx.sessionId } : {}),
    ...(base ? { base } : {}),
    draft,
    ...(seams.approvePr ? { openPr: true } : {}),
    ...(ground !== undefined ? { ground } : {}),
    naturalLanguageDispatch: true,
    progress: ux.progress,
    ...(goalFile ? { goalFile } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}),
    ...(autoReview ? { autoReview } : {}),
  };
  // 승인 통로는 surface seams.approvePr 하나다. opts/pipelineDeps.approver를 보강하면
  // 중앙 심이 seams를 다시 조립해 fail-closed 승인 게이트를 우회할 수 있다.
  const pipelineDeps: DevPipelineDeps = { buildSelfImplementSeams: () => seams, signal: ctx.signal };
  const result = run
    ? await run({
      feature,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.sessionId ? { parentSessionId: ctx.sessionId } : {}),
      ...(base ? { base } : {}),
      draft,
      entry,
      naturalLanguageDispatch: true,
      ...(goalFile ? { goalFile } : {}),
      ...(ground !== undefined ? { ground } : {}),
      ...(autoMerge !== undefined ? { autoMerge } : {}),
      ...(autoReview ? { autoReview } : {}),
      seams,
    })
    : await runSelfImplementViaCli(runCli, feature, cliOpts, { pipelineDeps });

  // 큰 gate log → 서피스에 파일 첨부(관측·spill).
  if (result.gate?.log && result.gate.log.length > 500) {
    ux.spillFile({ content: result.gate.log, ext: 'txt', name: `self-implement-gate-${result.branch ?? 'log'}.txt`, caption: `self-implement gate (${result.stage})` });
  }
  // ⭐ runId 를 반드시 싣는다 — 관측이 전부 runId 로 키잉되므로(`self run <runId>`·`logs --grep`)
  //   이게 없으면 **이 경계에서 조인이 끊긴다**(N3 재측정 2026-07-28: 계약은 섰는데 로그가 못 따라갔다).
  debug.log('daemon-tools.self-implement', 'done', { runId: result.runId, stage: result.stage, ok: result.ok, pr: result.prUrl ?? null });
  return !result.ok
    ? buildFailedToolResult(result.detail ?? result.stage, result)
    : result.runId ? buildLaunchedToolResult(result) : buildPendingToolResult(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('daemon-tools.self-implement', 'failed', { reason, stage: 'dispatch' });
    return buildFailedToolResult(reason);
  }
}

export type SelfImplementQueuedToolResult = {
  kind: 'launched'; runId: string; taskId: string; state: 'queued' | 'running' | 'done' | 'error' | 'aborted'; ok: boolean;
  message: string; next: string; missing: [];
};

type ManagedAdmissionState = 'queued' | 'running' | 'done' | 'error' | 'aborted';
export interface ManagedTaskAdmission {
  version: 1;
  requestKey: string;
  runId: string;
  taskId: string;
  parentSessionId?: string;
  feature: string;
  state: ManagedAdmissionState;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
}

/** File-backed admission ledger. A hard-link claim makes duplicate tool-call admission atomic. */
export class ManagedTaskAdmissionStore {
  constructor(private readonly root = resolveManagedAdmissionRoot()) {}

  claim(input: Omit<ManagedTaskAdmission, 'version' | 'createdAt' | 'updatedAt'>): { record: ManagedTaskAdmission; created: boolean } {
    mkdirSync(this.root, { recursive: true });
    const path = this.pathFor(input.requestKey);
    const now = Date.now();
    const record: ManagedTaskAdmission = { ...input, version: 1, createdAt: now, updatedAt: now };
    const temp = join(this.root, `.claim-${randomUUID()}.tmp`);
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      linkSync(temp, path);
      return { record, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return { record: this.read(path), created: false };
    } finally { rmSync(temp, { force: true }); }
  }

  update(requestKey: string, patch: Partial<Pick<ManagedTaskAdmission, 'state' | 'result' | 'error'>>): ManagedTaskAdmission {
    const path = this.pathFor(requestKey);
    const record = { ...this.read(path), ...patch, updatedAt: Date.now() };
    const temp = join(this.root, `.update-${randomUUID()}.tmp`);
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    return record;
  }

  get(requestKey: string): ManagedTaskAdmission | undefined {
    const path = this.pathFor(requestKey);
    return existsSync(path) ? this.read(path) : undefined;
  }

  private pathFor(requestKey: string): string {
    const digest = createHash('sha256').update(requestKey).digest('hex');
    return join(this.root, `${digest}.json`);
  }

  private read(path: string): ManagedTaskAdmission {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || (value as ManagedTaskAdmission).version !== 1) {
      throw new Error(`invalid SelfImplement admission record: ${path}`);
    }
    return value as ManagedTaskAdmission;
  }
}

export function resolveManagedAdmissionRoot(instanceRoot = effectiveInstanceRoot()): string {
  const dataDir = process.env.ELANOUS_DATA_DIR?.trim() || join(instanceRoot, 'data');
  return join(dataDir, 'self-implement-admissions');
}

/** Return a durable-addressable registry identity before doing any goal authoring or child setup. */
export function dispatchSelfImplementManaged(
  args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx & { autoMerge?: boolean },
  run?: SelfImplementRunner,
  authorGoal: SelfImplementGoalAuthor = writeAuthoredGoal,
  runCli: RunSelfImplementCliFn = runSelfImplementCliCommand,
  seamsFactory?: SelfImplementSeamsFactory,
  admissionStore: ManagedTaskAdmissionStore = new ManagedTaskAdmissionStore(),
  runtime: { taskNotifications?: TaskNotificationQueue; registry?: AgentRegistry } = {},
): Promise<SelfImplementQueuedToolResult | SelfImplementToolResult> {
  const feature = typeof args.feature === 'string' ? args.feature.trim() : '';
  if (!feature) return Promise.resolve(buildFailedToolResult('SelfImplement: `feature` is required'));
  const runId = randomUUID();
  const taskId = randomUUID();
  const requestKey = ctx.sessionId && ctx.toolCallId
    ? `tool-call:${ctx.sessionId}:${ctx.toolCallId}`
    : `request:${runId}`;
  let claim: ReturnType<ManagedTaskAdmissionStore['claim']>;
  try {
    claim = admissionStore.claim({
      requestKey, runId, taskId, feature,
      ...(ctx.sessionId ? { parentSessionId: ctx.sessionId } : {}), state: 'queued',
    });
  } catch (error) {
    return Promise.resolve(buildFailedToolResult(`SelfImplement admission could not be persisted: ${error instanceof Error ? error.message : String(error)}`));
  }
  const registry = runtime.registry ?? globalAgentRegistry;
  if (!claim.created) {
    let record = claim.record;
    let existingTask = registry.get(record.taskId);
    if (!existingTask) {
      existingTask = registry.register(
        { name: 'self-implement', systemPrompt: 'Managed SelfImplement execution; do not invoke an LLM agent.' },
        record.feature, { id: record.taskId },
      );
      existingTask.runId = record.runId;
      existingTask.parentSessionId = record.parentSessionId;
      existingTask.label = `SelfImplement ${record.feature.slice(0, 80)}`;
      existingTask.background = true;
      if (record.state === 'queued' || record.state === 'running') {
        record = admissionStore.update(requestKey, { state: 'error', error: 'SelfImplement worker was interrupted by process restart; submit a new request to retry.' });
        existingTask.error = record.error;
        existingTask.result = record.error;
        existingTask.state = 'error';
        existingTask.finishedAt = Date.now();
        registry.notifyTaskDone(existingTask);
      } else {
        existingTask.state = record.state;
        existingTask.result = record.result;
        existingTask.error = record.error;
      }
    }
    return Promise.resolve({
      kind: 'launched', runId: record.runId, taskId: record.taskId, state: record.state,
      ok: record.state !== 'error' && record.state !== 'aborted',
      message: `SelfImplement prior admission · run ${record.runId} · task ${record.taskId}${record.error ? ` · ${record.error}` : ''}`,
      next: `AgentOutput(${record.taskId})`, missing: [],
    });
  }
  const task = registry.register(
    { name: 'self-implement', systemPrompt: 'Managed SelfImplement execution; do not invoke an LLM agent.' },
    feature, { id: taskId },
  );
  task.runId = runId;
  task.parentSessionId = ctx.sessionId;
  task.label = `SelfImplement ${feature.slice(0, 80)}`;
  task.background = true;
  const parentChildSignal = childLifetimeSignal(ctx.signal);
  const signal = parentChildSignal
    ? AbortSignal.any([task.controller.signal, parentChildSignal])
    : task.controller.signal;
  let unsubscribeRunStop = (): void => {};
  const runStopListenerReady = import('../../self-implement/run-stop.js').then(({ onRunStop, readRunStopRecord }) => {
    unsubscribeRunStop = onRunStop((entry) => {
      if (entry.runId !== runId) return;
      const stop = readRunStopRecord(entry);
      if (!stop) return;
      void import('../../agent/task-notification.js').then(({ enqueueSelfImplementRunStopNotification, globalTaskNotificationQueue }) => {
        enqueueSelfImplementRunStopNotification(
          { runId, taskId: task.id, feature, stop },
          runtime.taskNotifications ?? globalTaskNotificationQueue,
        );
        debug.log('daemon-tools.self-implement', 'run-stop-wake-enqueued', { runId, taskId: task.id, stopClass: stop.class, site: stop.site ?? null });
      });
      unsubscribeRunStop();
    });
  });
  // The task registry owns cancellation and terminal notification. All slow setup,
  // including goal authoring and seam construction, happens after this receipt.
  queueMicrotask(() => {
    void runStopListenerReady.then(() => registry.runManaged(task.id, async () => {
      admissionStore.update(requestKey, { state: 'running' });
      if (signal.aborted) throw signal.reason ?? new Error('SelfImplement aborted');
      const result = await dispatchSelfImplement(args, { ...ctx, runId, signal }, run, authorGoal, runCli, seamsFactory);
      if (signal.aborted) throw signal.reason ?? new Error('SelfImplement aborted');
      if (result.kind === 'failed') throw new Error(result.reason);
      admissionStore.update(requestKey, { state: 'done', result: JSON.stringify(result) });
      return result;
    }, (result) => JSON.stringify(result)).catch((error) => {
      try { admissionStore.update(requestKey, { state: task.controller.signal.aborted ? 'aborted' : 'error', error: error instanceof Error ? error.message : String(error) }); } catch { /* registry remains authoritative for this process */ }
      debug.log('daemon-tools.self-implement', 'managed-task-failed', {
        runId, taskId: task.id, reason: error instanceof Error ? error.message : String(error),
      }, { level: 'warn' });
    })).finally(unsubscribeRunStop);
  });
  debug.log('daemon-tools.self-implement', 'managed-admitted', { runId, taskId: task.id, parentSessionId: ctx.sessionId ?? null });
  return Promise.resolve({
    kind: 'launched', runId, taskId: task.id, state: claim.record.state, ok: true,
    message: `SelfImplement accepted · run ${runId} · task ${task.id}`,
    next: `AgentOutput(${task.id})`, missing: [],
  });
}
