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

import { basename } from 'node:path';
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
import { writeAuthoredGoal } from '../../self-implement/goal-author.js';
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
  return buildSelfImplementSpec();
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
}) => Promise<{ path: string }>;

const GOAL_ORIGINAL_TEXT_LIMIT = null;

type GoalAuthorSummary = {
  authored: boolean;
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
    : `goal-author not authored (${summary.userTextState}; no goal source)`;
  ux.progress(message, { phase: 'delta' });
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
): Promise<unknown> {
  const feature = typeof args.feature === 'string' ? args.feature.trim() : '';
  if (!feature) return { error: 'SelfImplement: `feature` is required' };
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
    return { observed: true };
  }

  let goalFile: string | undefined;
  if (goalSourceText !== undefined) {
    const recentStepCounts = readRecentStepCountsFailOpen(recentStepCountReader);
    goalFile = (await authorGoal(goalSourceText, ctx.cwd, {
      goalTitle: feature,
      decomposeSteps: createDecomposeSteps(ctx.signal, {
        ...(adversarialReview !== undefined ? { adversarialReview } : {}),
        ...(recentStepCounts !== undefined ? { recentStepCounts } : {}),
      }),
      onProgress: (phase, event) => ux.progress(`goal-author ${phase} ${event === 'start' ? 'started' : 'ended'}`, { phase: 'delta' }),
    })).path;
  }
  const goalAuthorSummary: GoalAuthorSummary = {
    authored: goalFile !== undefined,
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
  const pipelineDeps: DevPipelineDeps = { buildSelfImplementSeams: () => seams };
  const result = run
    ? await run({
      feature,
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
  return result;
}
