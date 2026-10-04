// 헤드리스 elanous 드라이버 (2026-07-19) — "내부 drive-tui".
//
// 대표 지시: 외부 scripts/drive-tui.ts 가 하듯 elanous TUI 를 PTY 로 띄워 구동하되, elanous 가
// **스스로**(TUI 안에서 SelfImplement 툴 → 이 드라이버) 자식 elanous 를 worktree cwd 에 띄워
// feature 를 구현시킨다. dispatchDriveCodingAgentHeadless 는 codex/claude 바이너리만 스폰하므로
// elanous 자기-스폰용 전용 드라이버가 필요.
//
// 흐름: startPty(bun <repo>/bin/elanous.mjs, cwd=worktree, goal-loop 아밍 config) → 부팅 대기
//   → feature 프롬프트 전송 → 완료(GOAL-COMPLETE 마커 / 화면 안정화)까지 대기 → 트랜스크립트 캡처.
// bin 은 repo 절대경로라 worktree 에 node_modules 없어도 main 것으로 해석(drive-tui 실증).

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { basename, dirname, join } from 'node:path';
import {
  CHILD_LIVENESS_HEARTBEAT_ENV,
  CHILD_LIVENESS_HEARTBEAT_FILE,
  mergeChildLivenessHeartbeat,
  readChildLivenessHeartbeatAt,
  resolveChildLivenessHeartbeatPath,
} from '../core-turn/child-liveness-heartbeat.js';
import { resolveNexusPwa, type NexusPwaResolution } from '../cli/nexus-show.js';
import { ptyWebAddress } from '../cli/pty-web-address.js';
import { startPty, mintPtyId, ptyAvailable } from '../pty-shell/registry.js';
import { probeControlStance, stanceBlocksWrite } from '../pty-shell/pty-control-stance.js';
import { externalWriteProvenance } from '../pty-shell/pty-write-provenance.js';
import { findCompletionMarkerLine, hasCompletionMarker, mentionsMarkerWithoutDeclaring } from './completion-marker.js';
import { harnessPolicyEnv } from './harness-policy.js';
// ⭐P3 (capture substrate) — forwarded-mode 화면을 pty-manifest frame 컬럼으로도 수렴.
//   startPty 가 이미 row+snapshot(원시 ANSI)을 매니페스트에 쓰지만 렌더 frame(사람이 보는 화면)은
//   harness-screen 파일에만 갔다 → 크로스-프로세스 소비자(/v1/terminals·PWA 미러·observatory)가
//   TUI self-report 와 같은 채널로 self-implement 자식을 라이브 관측. 파일은 존속(orchestrate/self screen 리더).
import { updatePtyManifestFrame } from '../pty-shell/pty-manifest.js';
import {
  claimHarnessScreen, releaseHarnessScreen, resolveHarnessScreenKey, writeHarnessScreen, writeHarnessHeartbeat } from '../harness/harness-screen.js';
import { controlInboxEnv, resolveControlInboxDir } from '../harness/control-inbox.js';
import { getHarnessSpace, harnessSpaceEnv, harnessBoundaryEnv, harnessBoundaryRequestsEnv, harnessBoundaryResponsesEnv, normalizeSpaceId, getHarnessRunId, resolveRunIdentity } from '../harness/harness-space.js';
import { publishSelfReportFrame } from '../capture/self-report-frame.js';
import { getChannelBus } from '../terminal-matrix/index.js';
import { resolveInstanceName } from '../instance-identity.js';
import { buildExecutorSelfReportFrame } from './executor-frame.js';
import { classifyFrameState, GOAL_LOOP_STATE_RULES, UNKNOWN_INPUT_MAX_LINE_LENGTH, UNKNOWN_INPUT_MAX_LINES } from '../capture/frame-state-detect.js';
import { isKeyframeMoment, keyframePath, writeKeyframePng } from '../capture/keyframe-capture.js';
import { observeFrame, finalizeFrameObservation, INITIAL_FRAME_OBSERVATION, type FrameObservationState, type FrameTransition, type FrameStall } from '../capture/frame-observation.js';
import { closeSelfDevRunParticipant, selfDevRunsDir } from '../self-dev/run-store.js';
import type { FrameState } from '../capture/frame-state-detect.js';
import type { ControlDecision, ControlObservation, ControlRoundContext, RunSupervisor } from '../autopilot/pty-control-loop.js';
import { brainTrigger } from './brain-consultation.js';
import { decideAutoAssist, decideAutoStop, decideBoundaryApproval, decideScreenStallSilenceTermination, hasNovelCompletionSignal, NO_STALL, parseBoundaryApprovalRequest, UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS, type AutoAssistInput, type AutoStopInput, type AutoStopVerdict, type BoundaryApprovalRequestKind, type DeterministicCompletionState, type ScreenStallSilenceInput } from './auto-intervene.js';
import { decideByRecipe, missingStateKeys, parseRecipe, type Recipe, type RecipeDecision } from '../decide/recipe.js';
import { callJev, gateAnswer, probeKey, type JevAnswer } from '../decide/jev.js';
import { shadowBoundaryDecision, type BoundaryShadowConfig, type BoundaryShadowDeps } from '../decide/boundary-shadow.js';
import { decideOutputArtifactWatchdog, type OutputArtifactSnapshot, type OutputWatchdogPolicy } from './output-artifact-watchdog.js';
import { mapBrainAction, mapControlStance, supervisionObservationFields } from './supervision-vocabulary.js';
import { decideInterventionStep, type InterventionStep } from './intervention-step.js';
import { childRunContextEnv, childProviderKeyEnv, childLlmSelectionEnv, type ChildLlmSelection } from '../agent/run-context.js';
import { childToolProfile } from '../agent/tool-profile.js';
import { escalationAllowedForProvider } from './rework-policy.js';
import { getUserConfig, resolveActiveProvider, resolveRoleLlm } from '../user-config.js';
import { goalDifficultySignals, classifyGoalDifficulty, resolveImplementDifficulty } from '../llm/difficulty.js';
import { childNestEnv } from '../agent/nest-depth.js';
import { childPtyIdentityEnv } from '../agent/pty-identity.js';
import { elanousTuiSpawnOptions } from './elanous-tui-spawn.js';
import { describeGrokCredentialFreshness, readGrokTokenFreshness, type GrokCredentialFreshnessSnapshot } from '../acp/grok-auth.js';
import { debug } from '../debug/log.js';
import { observeExternalEvent } from '../context-bus/external-events.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { formatPtyLinkMessage, readReportOrigin } from './report-origin.js';
import { DETACHED_PROGRESS_FRAME_PREFIX, decodeDetachedProgressFrame } from '../harness/dispatch-detached.js';
import { setEventLoopActivity } from '../debug/event-loop-watchdog.js';
import { resolveEscalateTarget, resolveExplicitChildEscalateTarget } from './rework-policy.js';
import { tailWithOmissionMarker } from './off-diff-evidence.js';
import type { EscalateTier } from './rework-policy.js';
import { readRunLifecycleFromStateDir } from '../signal/lifecycle-bridge.js';
import { lifecycleRootReportEnv, lifecycleRootReportPath, readLifecycleRootReport, removeLifecycleRootReport } from '../signal/lifecycle-root-report.js';
import { compareLifecycleToScreen, type LifecycleScreenComparison } from './lifecycle-screen-scoreboard.js';
import { publishLifecycleRecord, type LifecycleRecord } from '../signal/lifecycle-record.js';
import { nextLifecycleSequence } from '../signal/lifecycle-sequence.js';
import type { ChannelBus } from '../terminal-matrix/channel-bus.js';
import { federationObservation } from './orchestrator.js';
// ⛔ 배달 상태는 「정하는 쪽」(orchestrator)이 소유한다 — 여기는 받아서 찍기만 한다.
import type { SupervisorDeliveryLine, SupervisorDeliveryState } from './orchestrator.js';
import type { RunShardIdentity } from './run-ledger.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Boundary requests observed up to about 788 characters; preserve the complete request record.
const HARNESS_BOUNDARY_REQUEST_STRING_MAX = 1024;
const WAIT_SUPERVISION_PROGRESS_BATCH_SIZE = 5;

/** Renders untrusted boundary metadata as one inert terminal line for the parent surface. */
export function singleLineBoundarySurfaceValue(value: string): string {
  return value
    .replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[()#%][ -~]|[78=>])/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/** Keep the progress line single while leaving a newline metacharacter distinct from a space. */
function encodeObservedRawShellMetacharactersForSurface(value: string): string {
  return value.replaceAll('\n', '\\n');
}

/**
 * Short, path-free summary of one boundary mailbox record for the `request-received` observation.
 * Carries only fields that fit well under the observation string cap, so a truncated raw `request`
 * cannot turn a rejection into "no requestType" (= silently not a rejection). Absent fields are omitted.
 */
export function boundaryRequestSummary(
  parse: 'ok' | 'invalid-json' | 'invalid-schema',
  request: ReturnType<typeof parseBoundaryApprovalRequest>,
  parsedLine: unknown,
): Record<string, string> {
  const record = typeof parsedLine === 'object' && parsedLine !== null && !Array.isArray(parsedLine)
    ? parsedLine as Record<string, unknown>
    : {};
  const summary: Record<string, string> = { parse };
  if (request) summary.requestKind = request.requestKind;
  for (const key of ['requestId', 'commandFirstToken', 'decidingToken', 'commandAction', 'commandHash', 'observedRawShellMetacharacters'] as const) {
    const value = record[key];
    if (typeof value === 'string') summary[key] = value;
  }
  return summary;
}

/** Emits the parent decision candidate, enforcement state, child rejection, and raw metacharacter observation separately. */
export function formatBoundaryProgressLine(verdict: { requestId: string; wouldApprove: boolean; approve: boolean; shadowed?: boolean; evidenceWhy: string; observedRawShellMetacharacters?: string; commandFirstToken?: string; decidingToken?: string; commandAction?: string }): string {
  const parentWouldApprove = verdict.wouldApprove ? 'true' : 'false';
  const approvalEnforced = !verdict.shadowed && verdict.approve ? 'true' : 'false';
  // Shadow-mode approvals preserve the child request, so distinguish their parent candidate from an actual rejection.
  const childRejection = approvalEnforced === 'true'
    ? 'not-rejected'
    : verdict.wouldApprove
      ? 'would-have-been-approved'
      : 'preserved';
  const observedRawShellMetacharacters = verdict.observedRawShellMetacharacters === undefined
    ? UNKNOWN_OBSERVED_RAW_SHELL_METACHARACTERS
    : verdict.observedRawShellMetacharacters;
  // «무엇이» 막혔나 — verdict 가 이미 가진 안전한 칸만 싣는다(원문 명령·경로·인자는 싣지 않는다).
  //   없으면 칸을 생략한다(빈 값으로 채우지 않는다). `commandAction` 은 공백을 품을 수 있어 맨 끝에 둔다.
  const target = [
    verdict.commandFirstToken !== undefined ? ` commandFirstToken=${singleLineBoundarySurfaceValue(verdict.commandFirstToken)}` : '',
    verdict.decidingToken !== undefined ? ` decidingToken=${singleLineBoundarySurfaceValue(encodeObservedRawShellMetacharactersForSurface(verdict.decidingToken))}` : '',
    verdict.commandAction !== undefined ? ` commandAction=${singleLineBoundarySurfaceValue(verdict.commandAction)}` : '',
  ].join('');
  return `[boundary] requestId=${singleLineBoundarySurfaceValue(verdict.requestId)} reason=${singleLineBoundarySurfaceValue(verdict.evidenceWhy)} parentWouldApprove=${parentWouldApprove} approvalEnforced=${approvalEnforced} childRejection=${childRejection} observedRawShellMetacharacters=${singleLineBoundarySurfaceValue(encodeObservedRawShellMetacharactersForSurface(observedRawShellMetacharacters))}${target}\n`;
}

/** Renders a supervisor decision as one inert terminal line for the parent surface. */
export function formatSupervisionProgressLine(verdict: { action: string | undefined; reason: string | undefined; delivery?: SupervisorDeliveryLine; deliveryReason?: string; inputInstructionOccurrence?: number }): string {
  const delivery = verdict.delivery ? ` delivery=${verdict.delivery}${verdict.deliveryReason ? ` deliveryReason=${singleLineBoundarySurfaceValue(verdict.deliveryReason)}` : ''}` : '';
  const inputInstructionOccurrence = verdict.inputInstructionOccurrence && verdict.inputInstructionOccurrence > 1 ? ` inputInstructionOccurrence=${verdict.inputInstructionOccurrence}` : '';
  return `[supervision] action=${singleLineBoundarySurfaceValue(verdict.action ?? 'none')} reason=${singleLineBoundarySurfaceValue(verdict.reason ?? 'none')}${delivery}${inputInstructionOccurrence}\n`;
}

export function formatWaitSupervisionBatchReason(waitCount: number, latestJudgment: string | undefined): string {
  return `waitCount=${waitCount} latestJudgment=${singleLineBoundarySurfaceValue(latestJudgment ?? 'wait')}`;
}

/** The child's terminal URL, or `null` when no PWA base is resolvable.
 *  ⛔⭐ Reads `url` (what the resolver ALREADY chose), never `loopback` — the resolver may have
 *  picked a tailnet base, and reading `loopback` silently discarded that choice (`GOAL-T80`).
 *  ⛔ Exists so the structured observation is built from the SAME value the human line shows,
 *  instead of string-slicing that line (which glued ` source=…` into the URL). */
export function surfaceLinkUrlFor(ptyId: string, pwa: NexusPwaResolution): string | null {
  // 링크 모양은 한 곳(`src/cli/pty-web-address.ts`)에서만 만든다 — agent-mission `watch=` 줄·`pty list` 와 같은 값.
  return ptyWebAddress(ptyId, pwa).webUrl;
}

/** Renders the spawned child's PWA terminal link or the typed reason it is unavailable. */
export function formatSurfaceLinkProgressLine(ptyId: string, pwa: NexusPwaResolution): string {
  const url = surfaceLinkUrlFor(ptyId, pwa);
  if (url !== null && 'source' in pwa) return `[surface-link] url=${url} source=${pwa.source}\n`;
  return `[surface-link] unavailable=${'reason' in pwa ? pwa.reason : 'pwa-url-unknown'}\n`;
}

/** Renders a frame-stall ladder change as one inert terminal line for the parent surface. */
export function formatFrameStallProgressLine(stall: {
  previousRung: number | undefined;
  currentRung: number | undefined;
  lastCommandFirstToken?: string;
  toolCalls?: number;
  chars?: number;
  previousToolCalls?: number;
  previousChars?: number;
}): string {
  const rung = (value: number | undefined): string => value === undefined || value < 0 ? 'unknown' : String(value);
  const progress = (name: string, current: number | undefined, previous: number | undefined): string =>
    current === undefined ? '' : ` ${name}=${current}${previous === undefined ? '' : ` delta=${current - previous}`}`;
  return `[frame-stall] previousRung=${singleLineBoundarySurfaceValue(rung(stall.previousRung))} currentRung=${singleLineBoundarySurfaceValue(rung(stall.currentRung))}`
    + (stall.lastCommandFirstToken === undefined ? '' : ` command=${singleLineBoundarySurfaceValue(stall.lastCommandFirstToken)}`)
    + progress('toolCalls', stall.toolCalls, stall.previousToolCalls)
    + progress('chars', stall.chars, stall.previousChars)
    + '\n';
}

/**
 * Consecutive same-command `frame-stall`s before pointing at R-RUN11.
 * 2026-08-28 sample was 111 stalls, almost all `command=git`. One freeze emits
 * at most 3 rungs (15s/60s/5min). N=3 is small vs that sample and waits for the
 * last rung of a single freeze rather than firing at 60s (N=2).
 */
export const FRAME_STALL_SAME_COMMAND_RULE_HINT_THRESHOLD = 3;

/** One-line pointer only — never the rule body (nobody reads a dump). */
const FRAME_STALL_SAME_COMMAND_RULE_HINT =
  "R-RUN11: same-command loop may be outside the child's authority";

function ruleHintForSameCommandFrameStall(consecutiveCount: number): string | undefined {
  if (consecutiveCount < FRAME_STALL_SAME_COMMAND_RULE_HINT_THRESHOLD) return undefined;
  return FRAME_STALL_SAME_COMMAND_RULE_HINT;
}

/** Drop the consecutive-stall streak as soon as the command token changes. */
function resetSameCommandStallStreak(
  token: string | undefined,
  previousToken: string | undefined,
): { token: string | undefined; count: number } | undefined {
  if (token === previousToken) return undefined;
  return { token, count: 0 };
}

export type SurfaceProgressKind = 'boundary' | 'supervision' | 'frame-stall' | 'surface-link';
export type SurfaceProgressStatus = 'handed-to-callback' | 'surface-callback-unwired' | 'callback-failed';

export type SurfaceProgressCounts = {
  total: number;
  handedToCallback: number;
  unwired: number;
  callbackFailed: number;
};

/** Records a delivery outcome for the enclosing run without affecting delivery control flow. */
export function countSurfaceProgressOutcome(
  counts: SurfaceProgressCounts,
  outcome: { status: SurfaceProgressStatus },
): void {
  counts.total += 1;
  switch (outcome.status) {
    case 'handed-to-callback': counts.handedToCallback += 1; break;
    case 'surface-callback-unwired': counts.unwired += 1; break;
    case 'callback-failed': counts.callbackFailed += 1; break;
  }
}

/** Delivers sparse parent-surface progress independently from the raw per-poll execute-judge stream. */
export function deliverSurfaceProgress(
  line: string,
  kind: SurfaceProgressKind,
  onSurfaceProgress: ((line: string) => void) | undefined,
): { kind: SurfaceProgressKind; status: SurfaceProgressStatus; error?: string } {
  if (!onSurfaceProgress) return { kind, status: 'surface-callback-unwired' };
  try {
    onSurfaceProgress(line);
    return { kind, status: 'handed-to-callback' };
  } catch (error) {
    return { kind, status: 'callback-failed', error: String(error instanceof Error ? error.message : error).slice(0, 120) };
  }
}

/** Parent-side, append-only boundary-request mailbox observation. It reads only complete
 * lines after its byte offset so duplicate watch/poll notifications cannot duplicate logs. */
export interface BoundaryRequestWatchOptions {
  watchDirectory?: typeof watch;
  pollMs?: number;
  read?: typeof readSync;
  responsePath?: string;
  appendResponse?: typeof appendFileSync;
  /** ⭐ M5 — 경계 판정을 «런 슈퍼바이저 레코드»로 올리는 통로. 감시자는 로그를 남기고,
   *  이 콜백으로 같은 판정을 호출자에게 «값»으로도 준다. ⛔ 로그를 대체하지 않는다(둘 다 남는다).
   *  없으면 종전과 동일하고, 던져도 감시는 안 죽는다(fail-soft). */
  onVerdict?: (verdict: { requestId: string; requestKind: BoundaryApprovalRequestKind; wouldApprove: boolean; approve: boolean; evidenceWhy: string; decidingToken?: string; observedRawShellMetacharacters: string }) => void;
  /** Additive raw mailbox observation for command-start records; failures remain fail-soft. */
  onCommandStart?: (commandFirstToken: string) => void;
  /** Test seam for the behavior-axis shadow. Default reads recipes/tool-guard.json and calls Jev. */
  behaviorAxis?: BoundaryBehaviorAxis;
  /** Test seam for the Jev boundary shadow; production reads raw.decide.boundaryShadow. */
  boundaryShadow?: BoundaryShadowConfig;
  boundaryShadowDeps?: BoundaryShadowDeps;
}

const BEHAVIOR_AXIS_QUESTIONS = ['irreversible', 'outside_workdir', 'reaches_network'] as const;

export type BoundaryBehaviorAxisAnswers = Record<(typeof BEHAVIOR_AXIS_QUESTIONS)[number], { type: 'noul'; noul: number; confidence?: number }>;

/** Answers already measured, or a promise that must not be awaited by the token-axis path. */
export type BoundaryBehaviorAxisCaller = (
  state: { cmd: string; cwd: string },
  recipe: Recipe,
) => BoundaryBehaviorAxisAnswers | Promise<BoundaryBehaviorAxisAnswers>;

export interface BoundaryBehaviorAxis {
  recipePath?: string;
  readRecipe?: (path: string) => string | Buffer;
  env?: NodeJS.ProcessEnv;
  readCache?: () => string | undefined;
  call?: BoundaryBehaviorAxisCaller;
}

type BehaviorAxisRecord = {
  requestId: string;
  tokenWouldApprove: boolean;
  tokenEvidenceWhy: string;
  commandFirstToken?: string;
  skipped?: 'command-unknown' | 'credential-absent';
  answers?: BoundaryBehaviorAxisAnswers;
  recipeVerdict?: RecipeDecision['verdict'];
  recipeReasons?: string[];
  axesDiffer?: boolean;
  error?: string;
};

function behaviorAxisRecord(
  request: { requestId: string; command?: string; cwd: string; commandFirstToken?: string },
  verdict: { wouldApprove: boolean; evidenceWhy: string },
  rest: Omit<BehaviorAxisRecord, 'requestId' | 'tokenWouldApprove' | 'tokenEvidenceWhy' | 'commandFirstToken'>,
): BehaviorAxisRecord {
  return {
    requestId: request.requestId,
    tokenWouldApprove: verdict.wouldApprove,
    tokenEvidenceWhy: verdict.evidenceWhy,
    ...(request.commandFirstToken ? { commandFirstToken: request.commandFirstToken } : {}),
    ...rest,
  };
}

function logBehaviorAxis(context: { ptyId: string; runId: string }, data: BehaviorAxisRecord): void {
  try { debug.log('harness.boundary', 'behavior-axis', { ...context, ...data }); } catch { /* observation is fail-soft */ }
}

function defaultToolGuardPath(): string {
  return join(import.meta.dir, '../../recipes/tool-guard.json');
}

function readTypesafeCache(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const home = env.HOME ?? env.USERPROFILE;
    if (!home) return undefined;
    const path = join(home, '.cache', 'typesafe_api_key');
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shadow only. Starts after the token-axis log and response line are already written,
 * and never awaits its caller. A missing command is unknown, not an empty command.
 */
export function observeBoundaryBehaviorAxis(
  request: { requestId: string; command?: string; cwd: string; commandFirstToken?: string },
  verdict: { wouldApprove: boolean; evidenceWhy: string },
  context: { ptyId: string; runId: string },
  axis: BoundaryBehaviorAxis = {},
): void {
  if (typeof request.command !== 'string' || request.command.length === 0) {
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { skipped: 'command-unknown' }));
    return;
  }
  const env = axis.env ?? process.env;
  const readCache = axis.readCache ?? (axis.env ? () => undefined : () => readTypesafeCache(env));
  if (!probeKey(env, readCache).present) {
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { skipped: 'credential-absent' }));
    return;
  }
  const recipePath = axis.recipePath ?? defaultToolGuardPath();
  let recipe: Recipe;
  try {
    const raw = axis.readRecipe ? axis.readRecipe(recipePath) : readFileSync(recipePath, 'utf8');
    recipe = parseRecipe(typeof raw === 'string' ? raw : raw.toString('utf8'), 'tool-guard');
  } catch (error) {
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { error: errorMessage(error) }));
    return;
  }
  const missing = missingStateKeys(recipe, { cmd: request.command, cwd: request.cwd });
  if (missing.length > 0) {
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { error: `state-missing:${missing.join(',')}` }));
    return;
  }
  const caller = axis.call ?? (async (state, loaded) => {
    const key = (env.TYPESAFE_API_KEY ?? readCache() ?? '').trim();
    const response = await callJev({ state, questions: loaded.questions }, key);
    return response.answers as BoundaryBehaviorAxisAnswers;
  });
  let pending: BoundaryBehaviorAxisAnswers | Promise<BoundaryBehaviorAxisAnswers>;
  try {
    pending = caller({ cmd: request.command, cwd: request.cwd }, recipe);
  } catch (error) {
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { error: errorMessage(error) }));
    return;
  }
  void Promise.resolve(pending).then((answers) => {
    const shaped = {} as BoundaryBehaviorAxisAnswers;
    for (const name of BEHAVIOR_AXIS_QUESTIONS) {
      const answer = answers?.[name] as JevAnswer | undefined;
      if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number') {
        logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { error: `answer-missing:${name}` }));
        return;
      }
      shaped[name] = { type: 'noul', noul: answer.noul, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) };
    }
    const decision = decideByRecipe(recipe, shaped, gateAnswer as never);
    const behaviorEscalate = decision.verdict === 'escalate';
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, {
      answers: shaped,
      recipeVerdict: decision.verdict,
      recipeReasons: decision.reasons,
      axesDiffer: verdict.wouldApprove === behaviorEscalate,
    }));
  }).catch((error: unknown) => {
    logBehaviorAxis(context, behaviorAxisRecord(request, verdict, { error: errorMessage(error) }));
  });
}

export function watchHarnessBoundaryRequests(
  path: string,
  context: { ptyId: string; runId: string },
  options: BoundaryRequestWatchOptions = {},
): () => void {
  if (!path) return () => {};
  const responsePath = options.responsePath ?? process.env.ELANOUS_HARNESS_BOUNDARY_RESPONSES;
  const appendResponse = options.appendResponse ?? appendFileSync;
  let offset = 0;
  let rest = '';
  let draining = false;
  let drainAgain = false;
  let closed = false;
  let watcher: FSWatcher | undefined;
  const decoder = new StringDecoder('utf8');
  const observeFailure = (error: unknown): void => {
    try { debug.log('harness.boundary', 'request-watch-fail', { ...context, error: errorMessage(error) }); } catch { /* observation is fail-soft */ }
  };
  const drain = (): void => {
    if (closed) return;
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do {
        drainAgain = false;
        if (!existsSync(path)) continue;
        const size = statSync(path).size;
        if (size < offset) { offset = 0; rest = ''; decoder.end(); }
        if (size <= offset) continue;
        const bytes = Buffer.alloc(size - offset);
        const fd = openSync(path, 'r');
        let bytesRead = 0;
        try {
          while (bytesRead < bytes.length) {
            const read = (options.read ?? readSync)(fd, bytes, bytesRead, bytes.length - bytesRead, offset + bytesRead);
            if (read === 0) break;
            bytesRead += read;
          }
        } finally { closeSync(fd); }
        offset += bytesRead;
        rest += decoder.write(bytes.subarray(0, bytesRead));
        let newline: number;
        while ((newline = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, newline);
          rest = rest.slice(newline + 1);
          if (line) {
            let parsedLine: unknown;
            let request: ReturnType<typeof parseBoundaryApprovalRequest>;
            let invalidRequestError: unknown;
            let parse: 'ok' | 'invalid-json' | 'invalid-schema' = 'ok';
            try {
              parsedLine = JSON.parse(line);
              request = parseBoundaryApprovalRequest(parsedLine);
              if (!request) {
                parse = 'invalid-schema';
                invalidRequestError = new Error('invalid boundary approval request schema');
              }
            } catch (error) {
              parse = 'invalid-json';
              invalidRequestError = error;
            }
            // ⭐ 원문 `request` 는 `stringMax` 에서 꼬리가 잘린다(2026-09-24 실측: 24h 거부 270 중 255 가
            //   JSON 으로 못 읽혔고 꼬리 칸 `decidingToken` 은 2건에만 살았다). 그래서 이미 한 해석으로
            //   경로·원문이 없는 짧은 `summary` 를 «앞» 칸에 싣는다 — 「거부」는 `requestKind` 로 세고,
            //   「못 읽음」은 `parse` 로 따로 남는다(잘린 행이 «거부 아님»으로 읽히지 않게).
            try {
              debug.log('harness.boundary', 'request-received', {
                ...context,
                summary: boundaryRequestSummary(parse, request, parsedLine),
                request: line,
              }, {
                compact: { stringMax: HARNESS_BOUNDARY_REQUEST_STRING_MAX },
              });
            }
            catch (error) { observeFailure(error); }
            const commandStart = parsedLine as { requestType?: unknown; commandFirstToken?: unknown } | undefined;
            if (commandStart?.requestType === 'command-start' && typeof commandStart.commandFirstToken === 'string') {
              try {
                options.onCommandStart?.(commandStart.commandFirstToken);
              } catch (error) { observeFailure(error); }
            }
            if (!request) {
              try { debug.log('harness.boundary', 'approval-shadow-unparsed', { ...context, request: line, error: errorMessage(invalidRequestError) }); }
              catch (logError) { observeFailure(logError); }
            } else {
              // ⛔⭐⭐ 판정 · 로그 · 콜백을 «독립»으로 fail-soft 한다(무인 리뷰 must-fix).
              //   초판은 셋을 한 try 에 넣어서, 로그가 던지면 `onVerdict` 가 «영영 안 불리고»
              //   슈퍼바이저 집계가 «조용히» 빠졌다. 그 로그가 던지는 경우는 가정이 아니라
              //   바로 아래 회귀가 이미 재현하고 있던 상태다.
              let verdict: ReturnType<typeof decideBoundaryApproval> | undefined;
              try {
                verdict = decideBoundaryApproval(request);
              } catch (error) {
                observeFailure(error);
              }
              if (verdict) {
                try {
                  debug.log('harness.boundary', 'approval-shadow', { ...context, requestId: request.requestId, ...verdict });
                } catch (error) { observeFailure(error); }
                if (responsePath) {
                  try {
                    appendResponse(responsePath, `${JSON.stringify({ requestId: request.requestId, requestKind: verdict.requestKind, wouldApprove: verdict.wouldApprove, evidenceWhy: verdict.evidenceWhy })}\n`);
                  } catch (error) { observeFailure(error); }
                }
                // ⭐ M5 — 같은 판정을 호출자에게 «값»으로도 올린다(로그와 «독립»이다).
                try {
                  options.onVerdict?.({ requestId: request.requestId, requestKind: verdict.requestKind, wouldApprove: verdict.wouldApprove, approve: verdict.approve, evidenceWhy: verdict.evidenceWhy, ...(verdict.decidingToken === undefined ? {} : { decidingToken: verdict.decidingToken }), observedRawShellMetacharacters: verdict.observedRawShellMetacharacters });
                } catch (callbackError) { observeFailure(callbackError); }
                // The response line and callback are already done. This observation must not be awaited.
                queueMicrotask(() => {
                  try {
                    observeBoundaryBehaviorAxis(request, verdict, context, options.behaviorAxis);
                  } catch (error) { observeFailure(error); }
                  try {
                    const rawDecide = getUserConfig().raw.decide;
                    const config = options.boundaryShadow ?? (rawDecide && typeof rawDecide === 'object'
                      ? (rawDecide as { boundaryShadow?: BoundaryShadowConfig }).boundaryShadow
                      : undefined);
                    void shadowBoundaryDecision(request, verdict, config, options.boundaryShadowDeps).catch(observeFailure);
                  } catch (error) { observeFailure(error); }
                });
              }
            }
          }
        }
      } while (drainAgain && !closed);
    } catch (error) {
      observeFailure(error);
    } finally {
      draining = false;
    }
  };
  try {
    watcher = (options.watchDirectory ?? watch)(dirname(path), (_event, filename) => {
      if (!filename || filename === basename(path)) drain();
    });
    watcher.on('error', (error) => {
      observeFailure(error);
      try { watcher?.close(); } catch { /* observation is fail-soft */ }
      watcher = undefined;
    });
    drain();
  } catch (error) {
    observeFailure(error);
  }
  // fs.watch can coalesce/miss events on some filesystems; drain is offset-idempotent.
  const poll = setInterval(drain, options.pollMs ?? 1000);
  return (): void => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    try { watcher?.close(); } catch { /* observation is fail-soft */ }
    watcher = undefined;
  };
}

type LifecycleReadTarget =
  | { readonly stateDir: string | undefined; readonly source: 'publisher-reported' | 'unresolved'; readonly emptyReason?: 'publisher-root-unreported' | 'resolution-failed' | 'directory-absent' | 'no-records' | 'read-failed' };

type LifecycleDirectoryStatus = 'present' | 'absent' | 'failed';

function lifecycleDirectoryStatus(stateDir: string): LifecycleDirectoryStatus {
  try {
    statSync(stateDir);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'failed';
  }
}

function resolveLifecycleReadTarget(
  reportPath: string,
  executionId: string,
  nonce: string,
  readPublisherStateDir: (reportPath: string, executionId: string, nonce: string) => string | undefined,
): LifecycleReadTarget {
  try {
    const stateDir = readPublisherStateDir(reportPath, executionId, nonce);
    if (!stateDir) return { stateDir: undefined, source: 'unresolved', emptyReason: 'publisher-root-unreported' };
    const directoryStatus = lifecycleDirectoryStatus(stateDir);
    if (directoryStatus === 'absent') return { stateDir, source: 'publisher-reported', emptyReason: 'directory-absent' };
    if (directoryStatus === 'failed') return { stateDir, source: 'publisher-reported', emptyReason: 'resolution-failed' };
    return { stateDir, source: 'publisher-reported' };
  } catch {
    return { stateDir: undefined, source: 'unresolved', emptyReason: 'resolution-failed' };
  }
}

/** 자주 상담하는 경로의 직전 실패 요약 상한. 절단 표시는 prompt·관측 모두에 남긴다. */
/** ⚠️ 비-export — 소비자는 이 파일 안 `boundRoundContext` 뿐이다(dead export 금지 규율
 *  `pty-control-ipc.ts:7`·`pty-takeover-cli.ts:8`). */
const ROUND_CONTEXT_FAILURE_MAX_CHARS = 600;

/** Maximum physical structured-progress line length, excluding its terminating newline. */
const PROGRESS_FRAME_REMAINDER_MAX_CHARS = 64 * 1024;

interface ProgressFrameLineBuffer {
  remainder: string;
  discardUntilNewline: boolean;
}

/**
 * Return complete physical lines that began at a real line boundary with the
 * structured-frame prefix. A discarded line never resynchronizes at an
 * internal prefix: only an actual newline can start another frame candidate.
 */
function takeProgressFrameLines(buffer: ProgressFrameLineBuffer, delta: string): string[] {
  let input = delta;
  if (buffer.discardUntilNewline) {
    const newline = input.indexOf('\n');
    if (newline < 0) return [];
    input = input.slice(newline + 1);
    buffer.discardUntilNewline = false;
  }

  const lines = `${buffer.remainder}${input}`.split('\n');
  buffer.remainder = '';
  const pending = lines.pop() ?? '';
  const completeLines = lines.filter((line) => line.length <= PROGRESS_FRAME_REMAINDER_MAX_CHARS);
  if (pending.length === 0) return completeLines;

  if (pending.length > PROGRESS_FRAME_REMAINDER_MAX_CHARS) {
    buffer.discardUntilNewline = true;
  } else if (DETACHED_PROGRESS_FRAME_PREFIX.startsWith(pending)) {
    buffer.remainder = pending;
  } else if (pending.startsWith(DETACHED_PROGRESS_FRAME_PREFIX)) {
    buffer.remainder = pending;
  } else {
    buffer.discardUntilNewline = true;
  }
  return completeLines;
}

/** ⭐ soft 초과 후 **연장이 걸릴 자격**을 정하는 무출력 허용 구간(초).
 *
 *  ⛔⛔ **이 수가 죽은 런과 산 런을 갈랐다**(2026-07-30 실측 · `poll.heartbeat.silentFor` 최대값):
 *  `134·112·107·100` → 전부 `soft-timeout` 사망 / `81·80·80·79·78·70` → 전부 생존.
 *  종전 `90` 에서 **임계가 완벽히 분리**됐다 — 표본 요동이 아니라 이 상수가 판정하고 있었다.
 *
 *  ⭐ 연장 정책의 의도는 *"살아있는 복잡 작업이 컷에 잘리는 것 방지"* 인데, 연장 조건이
 *  *"최근 **출력**활동"* 이라 ⛔ **조용히 일하는 것을 죽은 것으로 읽는다.** 우리가 자식에게
 *  요구하는 `self typecheck` 는 이 레포에서 **147초 무출력**(변경 5파일 실측)이라 구조적으로 넘었다.
 *
 *  ⚠️ **이 수를 줄이려면 무출력 구간을 먼저 재라** — 근거는 *"가장 긴 무출력 명령"* 이고
 *  그것이 늘면 이 수도 늘어야 한다(`hard` 절대상한은 별개이고 안 건드린다). */
export const DEFAULT_ACTIVITY_GRACE_SEC = 240;
/** 부모 구현 상한(2시간)보다 5분 먼저 끝내 자식이 결과를 들고 스스로 종료하게 한다. */
export const DEFAULT_MAX_HARD_WAIT_SEC = 6_900;
/** ⭐ 위 수의 근거 — 이 레포에서 가장 긴 **무출력** 명령의 실측 소요(ms). 테스트가 대소를 고정한다. */
export const LONGEST_SILENT_GATE_MS = 146_518;

export { CHILD_LIVENESS_HEARTBEAT_FILE, readChildLivenessHeartbeatAt, resolveChildLivenessHeartbeatPath };

/** ⚠️ 비-export — 호출부는 이 파일 안 한 곳이다. */
function boundRoundContext(context: ControlRoundContext | undefined): ControlRoundContext | undefined {
  if (!context) return undefined;
  const failure = context.previousRoundFailure;
  if (failure.length <= ROUND_CONTEXT_FAILURE_MAX_CHARS) return context;
  const omitted = failure.length - ROUND_CONTEXT_FAILURE_MAX_CHARS;
  return {
    ...context,
    previousRoundFailure: `${failure.slice(0, ROUND_CONTEXT_FAILURE_MAX_CHARS)}\n[truncated: ${omitted} chars omitted]`,
  };
}

/** 완료 정보량 계약은 세 상태만 허용한다. 다른 화면 상태는 완료를 추정하지 않도록 `unknown`으로 수렴한다. */
export function normalizeDeterministicCompletionState(state: FrameState): DeterministicCompletionState {
  if (state === 'done' || state === 'working' || state === 'unknown') return state;
  return 'unknown';
}

/** PTY snapshot 의 ANSI/제어 시퀀스 제거(drive-tui 와 동형). */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[P_^X][^\x1B]*\x1B\\/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-Z\\-_=>]/g, '');
}

const PTY_DELTA_TAIL_MAX_CHARS = 120;

/** Builds ANSI-free progress metadata without changing the existing raw character count or tail rendering. */
export function buildPtyDeltaProgressObservation(delta: string): {
  strippedChars: number;
  tailTruncated: boolean;
  tail: string;
} {
  const stripped = stripAnsi(delta);
  return {
    strippedChars: stripped.length,
    tailTruncated: stripped.length > PTY_DELTA_TAIL_MAX_CHARS,
    tail: stripped.replace(/\s+/g, ' ').slice(-PTY_DELTA_TAIL_MAX_CHARS),
  };
}

function transcriptMetrics(snapshot: string): { transcript: string; toolCalls: number; chars: number } {
  const transcript = stripAnsi(snapshot);
  return {
    transcript,
    toolCalls: (transcript.match(/⏺\s+\w+\(/g) || []).length,
    chars: transcript.length,
  };
}

type IsolationAxisObservation = boolean | 'unknown';

/** Records only what this spawner was explicitly told for one isolation axis. */
function observeIsolationAxis(directory: string | undefined): IsolationAxisObservation {
  return directory === undefined ? 'unknown' : Boolean(directory);
}

export interface HeadlessElanousResult {
  /** 완료 마커(GOAL-COMPLETE) 또는 종료 안정화 도달. */
  reachedCompletion: boolean;
  /** 최종 트랜스크립트 tail(요약용). */
  summary: string;
  /** 전체 stripped 트랜스크립트. */
  transcript: string;
  /** 관측된 툴콜 수(Read/Grep/Edit 등 ⏺ 라인). */
  toolCalls: number;
}

export interface HeadlessElanousOptions {
  /** main repo 절대경로(bin/elanous.mjs·node_modules 해석용). */
  repoRoot: string;
  /** elanous 를 띄울 작업디렉토리(worktree). codex 편집이 여기 일어남. */
  cwd: string;
  /** 구동할 feature 프롬프트. */
  prompt: string;
  /** 격리 config/state 디렉토리(운영 무접촉). 생략 시 격리 인자 없이 구동. */
  configDir?: string;
  /** ★ K run-identity — 이 실행이 속한 per-run join anchor. 미지정 시 상속(env) → 없으면 canonical mint
   *  (`perCallRunId`). 호출자(runSelfImplement)가 지정하면 **리워크 라운드가 하나의 runId 를 공유**해
   *  `elanous self run <runId>` 가 그 self-implement 전체를 조인한다. */
  runId?: string;
  stateDir?: string;
  /** ⭐ 위 뿌리가 «파생»이면 자식에게 값으로 알린다(`OBS-T121`). */
  stateDirSource?: 'derived';
  bootSec?: number;      // 부팅 settle. 기본 8.
  maxWaitSec?: number;   // 프롬프트 후 최대 대기. 기본 600.
  cols?: number;
  rows?: number;
  /** 테스트 seam — startPty 주입(실 PTY 무접촉). */
  spawn?: typeof startPty;
  ptyAvailable?: () => boolean;
}

/**
 * worktree cwd 에서 헤드리스 elanous 를 띄워 feature 를 구동하고 완료까지 캡처한다.
 * SelfImplement 오케스트레이터의 ③구현 seam 이 이걸 호출한다.
 *
 * ⛔⭐⭐⭐ 이 파일에는 스포너가 **둘**이고 자식의 «모양»이 다르다 — 섞으면 안 된다(2026-08-07 · `[S]` 51차).
 *   ① 이 함수 `driveHeadlessElanous`  — `elanousTuiSpawnOptions` → `bun bin/elanous.mjs` (서브커맨드 없음 = **TUI 모양**)
 *      아래 `h.write(opts.prompt)` ⊕ `h.write('\r')` 로 **자식에게 타이핑해 넣는다** ⇒ 입력 소비자가 **있다**.
 *      ⚠️ 그런데 이 함수의 옵션(`HeadlessElanousOptions`)엔 `canReceiveInput` 도 `autoAssist` 도 **없다**(감독 미배선).
 *   ② `runHeadlessGoalLoopPty`(아래) — `bun bin/elanous.mjs chat --tools --goal-loop --new <prompt>`
 *      프롬프트가 **argv 위치 인자**라 타이핑이 없다 ⇒ 새 턴을 받을 stdin 소비자가 **없다**.
 *      `canReceiveInput?: false` 는 **②의** 옵션이고 `seams.ts` 의 self-implement 경로는 **②**를 부른다.
 * 🚨 50차 인계 §9 3차가 이 둘을 섞어 *"그 자식은 argv one-shot 이 아니다 — 같은 파일이 쓴다"* 고 적었는데,
 *   그 `h.write` 는 **①의 것**이다. 그 오독 위에서 `#5665` 의 전제가 낡았다는 판정이 섰다 ⇒ **그 판정은 무효다.**
 */
export async function driveHeadlessElanous(opts: HeadlessElanousOptions): Promise<HeadlessElanousResult> {
  const spawn = opts.spawn ?? startPty;
  const available = opts.ptyAvailable ?? ptyAvailable;
  // ★ 화면 릴레이 키(2026-08-15·X11 forwarding식) — 현재 cwd 소유인 공간 id만 우선해 수확 측과 같은 파일을 본다.
  // ★ 관측갭 수리(2026-07-21·제1원칙·트랙A) — 부모가 공간 밖(ACP `SelfImplement` daemon 진입 등)이면 worktree
  //   이름으로 self-implement 공간을 합성한다. 이 driver 는 모든 self-implement 엔트리(CLI/ACP/병렬)가 지나는
  //   초크포인트라, 여기서 공간을 보장하면 어떤 진입이든 자식 goal-loop 이 항상 self-recognize + sink 등록
  //   (chat --goal-loop 의 공간-게이트) → 엔트리 무관 균일 관측. CLI/detached 진입은 부모가 이미 심어 그대로 존중.
  const space = getHarnessSpace()
    ?? { inHarness: true as const, kind: 'self-implement' as const, id: normalizeSpaceId(basename(opts.cwd)), runId: getHarnessRunId() };
  // ★ K run-identity 공백 방어(2026-07-26 실측 갭) — space 가 있어도 runId 가 '' 일 수 있다(harness-space:92 는
  //   env 를 그대로 읽는다). 빈 runId 는 `elanous self run <runId>` 사후 join 을 **불가능**하게 만든다(관측 계약은
  //   있는데 값이 안 실린 사례). 호출자 지정 > 상속 > canonical mint 순으로 항상 비어있지 않게 확정한다.
  const { runId } = resolveRunIdentity({ explicit: opts.runId, inherited: space.runId });
  const controlInboxDir = resolveControlInboxDir(space.id);
  const { key: screenKey } = resolveHarnessScreenKey(space.id, opts.cwd);
  // ⭐⭐⭐ `B3`(2026-08-19 · 대표 지시) — 화면 «소유»를 주장한다.
  //   🚨 화면 버퍼는 ***공간 id 하나 = 파일 하나***다. 두 자가 같은 키로 쓰면 프레임이 «섞이고»,
  //     그 결과는 ***「틀린 화면을 자신 있게 보여 주는」*** 형태다(가장 나쁜 부류).
  //   📏 지금은 조각마다 워크트리가 달라 안 겹친다 — ***그러나 그건 «가정»이다.***
  //     가정은 언젠가 «조용히» 깨진다. 그래서 계약으로 바꾼다.
  //   ⛔ 막지 «않는다» — 값으로 낸다. 안 본 충돌을 근거로 실행을 막지 않는다(그 수가 0이 아니면 그때 결정).
  try {
    const claim = claimHarnessScreen(screenKey, { owner: runId });
    if (claim.kind !== 'claimed') {
      debug.log('self-implement', 'screen-claim', {
        screenKey, runId, kind: claim.kind,
        ...(claim.kind === 'conflict'
          ? { heldByPid: claim.heldBy.pid, heldByOwner: claim.heldBy.owner ?? null, heldSince: claim.heldBy.at }
          : { previousPid: claim.previous.pid, previousOwner: claim.previous.owner ?? null }),
      }, { level: claim.kind === 'conflict' ? 'warn' : 'info' });
    }
  } catch { /* fail-soft — 클레임이 구현을 막지 않는다 */ }
  let handle: ReturnType<typeof startPty> | undefined;
  let doneData: Record<string, unknown> | undefined;
  let phase: 'probe' | 'spawn' | 'initialization' | 'interaction' | 'render' | 'snapshot' = 'probe';
  try {
    if (!available()) {
      doneData = { reachedCompletion: false, exitReason: 'pty-unavailable', toolCalls: 0, chars: 0 };
      return { reachedCompletion: false, summary: 'PTY unavailable', transcript: '', toolCalls: 0 };
    }
    phase = 'initialization';
    // This observation records only which directories the spawner handed over. The child's
    // isolation outcome is emitted by its own instance.provision event and joins on cwd.
    debug.log('self-implement', 'headless.spawn', {
      runId,
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      configDirPassed: observeIsolationAxis(opts.configDir),
      stateDirPassed: observeIsolationAxis(opts.stateDir),
      screenKey,
    });
    phase = 'spawn';
    const h = spawn(elanousTuiSpawnOptions({
      repoRoot: opts.repoRoot,
      cwd: opts.cwd,
      configDir: opts.configDir,
      stateDir: opts.stateDir,
      controlInboxDir,
      // ⛔⭐ 뿌리와 «한 벌»(`OBS-T121`)
      ...(opts.stateDirSource ? { stateDirSource: opts.stateDirSource } : {}),
      space,
      runId,
      cols: opts.cols,
      rows: opts.rows,
    }));
    handle = h;
    phase = 'initialization';
    debug.log('run-identity', 'propagate', { runId, ptyId: h.id, via: 'headless-goal-loop' });
    phase = 'interaction';
    await sleep((opts.bootSec ?? 8) * 1000);
    h.write(opts.prompt);
    await sleep(300);
    h.write('\r');
    // 완료 대기 — GOAL-COMPLETE 마커 또는 화면 안정화(연속 동일 5회) 또는 maxWait.
    const maxI = opts.maxWaitSec ?? 600;
    let last = '';
    let stable = 0;
    let reached = false;
    let exitReason: 'completion-marker' | 'stable-screen' | 'max-wait-exhausted' = 'max-wait-exhausted';
    phase = 'render';
    for (let i = 0; i < maxI; i += 1) {
      await sleep(1000);
      const cur = await h.renderScreen();
      // ★ 화면 릴레이 프레임(2026-07-21) — full snapshot 을 공간 화면 버퍼에 써 프로세스 경계 넘어 `elanous self
      //   screen --space <id>` 로 라이브 관측(X11 forwarding식·프레임버퍼). fail-soft 내장.
      //   (P3 manifest frame 수렴은 라이브 executor runHeadlessGoalLoopPty 에만 배선 — 이 driveHeadlessElanous
      //    는 호출자 0 = legacy·수렴은 라이브 경로만.)
      writeHarnessScreen(screenKey, cur);
      if (hasCompletionMarker(stripAnsi(cur))) { reached = true; exitReason = 'completion-marker'; break; }
      if (cur === last) { stable += 1; if (stable >= 5) { exitReason = 'stable-screen'; break; } } else { stable = 0; }
      last = cur;
    }
    phase = 'snapshot';
    const { transcript, toolCalls, chars } = transcriptMetrics(h.snapshot());
    const completion = reached || hasCompletionMarker(transcript);
    doneData = { reachedCompletion: completion, exitReason, toolCalls, chars };
    return { reachedCompletion: completion, summary: tailWithOmissionMarker(transcript, 2000), transcript, toolCalls };
  } catch (error) {
    const exitReason: HeadlessDoneExitReason = phase === 'probe'
      ? 'pty-probe-error'
      : phase === 'spawn'
        ? 'spawn-error'
        : phase === 'initialization'
          ? 'initialization-error'
          : phase === 'render'
            ? 'render-error'
            : phase === 'snapshot'
              ? 'snapshot-error'
              : 'interaction-error';
    doneData = {
      ...(handle ? { ptyId: handle.id } : {}),
      reachedCompletion: false, exitReason, toolCalls: 0, chars: 0, error: errorMessage(error),
    };
    throw error;
  } finally {
    // ⭐ `B3` — 내 클레임을 놓는다(⛔ 남의 것은 «안» 지운다 — 지우면 그 자가 조용히 충돌 상태가 된다).
    try { releaseHarnessScreen(screenKey); } catch { /* fail-soft */ }
    try { handle?.kill(); } catch { /* fail-soft */ }
    if (doneData) debug.log('self-implement', 'headless.done', { runId, ...doneData });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// runHeadlessGoalLoopPty (2026-07-21 · task#22) — implement seam 의 spawnSync 를
// 대체하는 PTY 호스팅. `chat --tools --goal-loop`(subcommand·arg 프롬프트·exit 완료)를
// startPty 로 띄운다 — driveHeadlessElanous(=`legacy` TUI·부팅+프롬프트박스 write+화면스크레이프)와
// 달리 프롬프트는 arg, 완료는 프로세스 exit 이 1차 신호. 이득:
//   ① 부모 비블로킹(spawnSync 와 달리 이벤트루프 살아있음 → telegram 반응·로그 flush 유지)
//   ② registry 등록(PWA /v1/terminals 스크롤백 무배선 노출·snapshot/screenshot 가능)
//   ③ drainDelta 라이브 관측/onProgress(헤드리스 execute 의 "깜깜" 해소)
// PTY 불가/cap 초과는 호출측이 spawnSync 폴백(ok:false 반환).

/** POSIX 단일따옴표 이스케이프 — startPty 는 args 있으면 `sh -c "<cmd+args join>"`로 셸랩한다
 *  (registry resolveSpawnShape). featurePrompt(멀티라인·따옴표·특수문자)를 그냥 넘기면 셸이 파싱해
 *  깨지므로 각 arg 를 한 토큰으로 감싼다. spawnSync(직접 argv)엔 불필요했던 PTY 경로 전용 안전장치. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface HeadlessGoalLoopPtyOptions {
  /** main repo 절대경로(bin/elanous.mjs·node_modules 해석). */
  binRoot: string;
  /** worktree(구현 대상 cwd). */
  cwd: string;
  /** 이미 featurePrompt() 적용된 프롬프트(범위제한·클린빌드 앵커 포함). */
  featurePrompt: string;
  /** Original goal document before the execution prompt is decorated. */
  goalDocument?: string;
  configDir?: string;
  /** ★ K run-identity — 이 실행이 속한 per-run join anchor. 미지정 시 상속(env) → 없으면 canonical mint
   *  (`perCallRunId`). 호출자(runSelfImplement)가 지정하면 **리워크 라운드가 하나의 runId 를 공유**해
   *  `elanous self run <runId>` 가 그 self-implement 전체를 조인한다. */
  runId?: string;
  /** Optional producer-supplied federation identity; absence must not manufacture federation fields. */
  shardIdentity?: RunShardIdentity;
  stateDir?: string;
  /** ⭐ 위 뿌리가 «파생»이면 자식에게 값으로 알린다(`OBS-T121`). */
  stateDirSource?: 'derived';
  /** ★ #2 모델 escalation 이중 티어(2026-07-22 대표 결론) — 'sol'/'opus' 면 자식 goal-loop 을 해당 티어 모델로
   *  스폰(resolveEscalateTarget → ELANOUS_ESCALATE_* env → 자식 config override). base(terra) 소진 시 sol,
   *  sol 도 못 풀면 opus. 미지정/'none' = 종전 base 모델(미주입). */
  escalateTier?: EscalateTier;
  /** 호출 단위 구현 자식 두뇌. provider와 model은 함께, 공백 없는 값으로 지정해야 하며 명시 선택은 승격보다 우선한다. */
  childLlm?: ChildLlmSelection;
  maxWaitSec?: number;   // soft 데드라인(기본 600). 초과해도 최근 활동이 있으면 hard 까지 연장.
  /** ★ adaptive 타임아웃(dev-harness 정책) — soft(maxWaitSec) 초과 후에도 **최근 출력활동**이 있으면
   *  여기까지 연장(복잡/외부참조 작업이 살아있는데 잘리는 것 방지). 무활동이면 soft 에서 종료. 기본 5400. */
  maxHardWaitSec?: number;
  /** soft 초과 후 "무활동" 판정 유예(초·poll tick). 마지막 출력 이후 이만큼 조용하면 타임아웃. 기본 240. */
  activityGraceSec?: number;
  /** activityGraceSec의 구성 출처. caller는 `elanous dev --activity-grace`가 전달한 값이다. */
  activityGraceSource?: 'caller';
  pollMs?: number;       // 완료 폴 간격(기본 1000·테스트 축소용).
  cols?: number;
  rows?: number;
  /** Execute-judge hook for raw PTY deltas on every poll (including empty deltas). Never render this stream on a parent surface. */
  onProgress?: (delta: string) => void;
  /** Optional durable-output seam. When supplied, terminal success is rejected if required artifacts are absent. */
  outputArtifactWatchdog?: {
    readonly initial: OutputArtifactSnapshot;
    readonly policy: OutputWatchdogPolicy;
    readonly snapshot: () => OutputArtifactSnapshot;
  };
  /** Sparse parent-surface hook for boundary, supervision, frame-stall, and child-link lines. */
  onSurfaceProgress?: (line: string) => void;
  /** Current worktree's PWA resolver seam; it is resolved once after the child is spawned. */
  resolveNexusPwa?: (opts: { cwd: string }) => NexusPwaResolution;
  /** Outbound seam; the default retains quiet hours and origin routing. */
  sendOutbound?: typeof sendOutbound;
  /** Queues an argv child supervisor input for the orchestrator's next-round prompt; never writes stdin. */
  onSupervisorInput?: (text: string, updateDelivery: (delivery: SupervisorDeliveryState, reason?: string) => void) => void;
  /** ★ 턴 abort 신호(#21) — /cancel 이 이 신호를 abort 하면 호스팅 PTY 를 즉시 kill + 폴 루프 조기 종료
   *  (고아 자식 프로세스 방지). 미주입 시 종전대로 exit/GOAL-COMPLETE/타임아웃까지 폴. */
  signal?: AbortSignal;
  /** ★S4 P2b/P3 — 폴 tick 관측을 받아 판단을 돌리는 brain.
   *  미주입 또는 autoStop 비활성 = 종전 suggestion-only 동작. */
  brain?: RunSupervisor;
  /** 재투입 라운드 맥락. 미주입이면 brain 입력과 실행은 종전과 동일하다. */
  roundContext?: ControlRoundContext;
  /** S4 P3 — done 제안을 확증된 stall에서만 부모 대기 종료로 적용하는 설정. */
  autoStop?: Pick<AutoStopInput, 'enabled' | 'minRung'>;
  /** Input 제안의 delivery eligibility gate. 기본 OFF이며 이 argv goal-loop에는 입력 소비자가 없다. */
  autoAssist?: Pick<AutoAssistInput, 'enabled' | 'minRung'>;
  /** 화면 stall과 출력 무활동이 함께 확증됐을 때만 종료하는 설정. 기본 OFF는 shadow 관측만 남긴다. */
  screenStallTermination?: Pick<ScreenStallSilenceInput, 'enabled' | 'minRung'>;
  /** 이 child가 PTY 입력을 실제로 소비한다는 spawner의 명시 capability 선언. 부재도 false로 fail-closed.
   *  ⛔⭐⭐ **`?: false` 는 실수가 아니라 「아직 못 한다」를 «타입으로» 적은 것이다**(`#5665` 2026-07-28).
   *   이 옵션은 **`runHeadlessGoalLoopPty` 의 것**이고 그 자식은 `chat --tools --goal-loop --new <prompt>` —
   *   프롬프트가 **argv 위치 인자**라 새 턴을 받을 stdin 소비자가 없다.
   *   📏 전수 재확인(2026-08-07 · `[S]`⊕`[T]` 독립 2): `process.stdin.*` 호출 11곳 중 이 경로에 도달하는 것 **0**
   *   (`chat` action `index.ts:5519~5561` 구간에 리더 0 · `attachStreamingKeys` 는 **이름과 달리 TUI 키 핸들러**다).
   *  ⛔⭐⭐⭐ **여기를 `true` 로 넓히려면 「타입」이 아니라 「자식의 모양」을 먼저 바꿔야 한다.**
   *   그냥 넓히면 elanous 가 **없는 능력을 선언**하고, 그것이 `#5665` 가 막으려던 것이다 —
   *   *"닿지 않았는데 성공이라 보고한다."*
   *  ⚠️ **화면에 뜨는 것은 증거가 아니다** — 리스너가 하나도 없으면 tty 라인 디시플린이 **에코**하고 입력은
   *   큐에 쌓인 채 아무도 안 읽는다. 라이브로 가르려면 「그 입력이 **행동**을 바꿨나」를 봐라(`[T]` 기전 확정). */
  canReceiveInput?: false;
  /** 밖에서 쓴 이력 조회 심 — 기본은 실물(`pty-control-ipc`). ⭐ 테스트가 전역을 찌르지 않게
   *  `spawn`·`ptyAvailable` 과 **같은 방식**으로 주입한다(새 패턴 아님 · 테스트 전용 export 도 아님). */
  externalWriteProvenance?: (ptyId: string) => { externalWrites: number; externalWriteAgoMs: number; externalWriteActor: string } | undefined;
  /** ★S4 P2b — brain 상담 1회 최대 대기(ms·기본 15초). 초과 시 abort + fail-soft(`brain.fail`).
   *  ⚠️ **테스트 seam 겸용**(리뷰 must-fix — 이게 없으면 timeout fail-soft 경로를 15초 없이 검증할 수
   *  없다). 프로덕션은 기본값을 쓴다(호출부 미지정). */
  brainTimeoutMs?: number;
  /** ★S4 P3 **관측 시계 seam**(테스트 전용·기본 `Date.now`).
   *
   *  stall 사다리는 15s·60s·**5min** 이라, 자동 종료 배선을 *런타임으로* 검증하려면 그만큼 실제로
   *  기다려야 한다 — 테스트로는 불가능하다. 그래서 **프레임 관측 타임스탬프만** 주입 가능하게 한다.
   *  ⚠️ **타임아웃 축(soft/hard/grace)은 이 시계를 쓰지 않는다** — 가상 시간이 종료 판정을 흔들면
   *     테스트가 검증하려는 것과 다른 경로를 타게 된다. 프로덕션에선 둘 다 `Date.now` 로 동일하다. */
  nowMs?: () => number;
  /** Parent mailbox observation dependencies, injectable only for lifecycle tests. */
  boundaryRequestsWatchOptions?: BoundaryRequestWatchOptions;
  /** Lifecycle scoreboard reader seam. Missing or throwing readers are recorded as an empty signal. */
  readLifecycle?: (stateDir: string | undefined, runId: string) => readonly { id: number; record: LifecycleRecord }[];
  /** Additive round scoreboard observation forwarded to the owning run orchestrator. */
  onLifecycleScreenClassification?: (classification: LifecycleScreenComparison) => void;
  /** Lifecycle scoreboard seam: reads the state root explicitly reported by the current child execution. */
  readPublisherStateDir?: (reportPath: string, executionId: string, nonce: string) => string | undefined;
  /** Parent-side lifecycle publisher seam. The default is the process ChannelBus. */
  lifecycleBus?: ChannelBus;
  /** 부모 PID 관측 seam. 이 headless 자식 계층에서만 1은 부모 사망을 뜻한다. */
  readParentPid?: () => number;
  /** Grok auth-file reader seam; it is read-only and used only for an explicitly selected Grok child. */
  readGrokTokenFreshness?: typeof readGrokTokenFreshness;
  /** 테스트 seam. */
  spawn?: typeof startPty;
  ptyAvailable?: () => boolean;
}

/**
 * ⭐ poll 루프의 종료 갈래(안정 식별자 · `elanous logs --grep exitReason` 로 집계 가능).
 *
 * - `abort`            — 부모가 취소(/cancel·signal)
 * - `brain-stop`       — S4 자동 개입이 대기를 끊음(`brain.applied` 와 짝)
 * - `child-exit-success` — 자식 프로세스가 0으로 종료(1차 완료 신호)
 * - `child-exit-failure` — 자식 프로세스가 0 이외 코드로 종료
 * - `completion-marker`— 자식이 완료를 **선언**(단독 줄 마커)
 * - `soft-timeout`     — soft 상한 초과 ⊕ 무활동 grace 경과
 * - `screen-stall-silence` — rendered screen has not changed for the configured stall rung, no output arrived for the grace measure, the child is alive, and no completion was declared
 * - `wallclock-cap`    — 절대 경과시간 상한(상담 시간 포함)
 * - `loop-exhausted`  — hard 상한까지 소진(기존 공개 반환 계약)
 * - `not-started`      — poll 루프에 **진입조차 안 함**(PTY 미가용 → 호출측 spawnSync 폴백)
 *
 * ⚠️ `not-started` 를 따로 둔 이유(리뷰 must-fix) — 종전 초안은 미가용 조기 반환에도
 *   `loop-exhausted` 를 실었다. 루프가 돌지 않았는데 "상한까지 소진했다"고 적는 것은
 *   **거짓 관측**이고, 집계에서 진짜 소진과 섞인다. 관측은 값을 채우는 게 아니라 사실을 적는 것이다.
 */
export type PollExitReason =
  | 'abort'
  | 'brain-stop'
  | 'child-exit'
  | 'completion-marker'
  | 'soft-timeout'
  | 'screen-stall-silence'
  | 'wallclock-cap'
  | 'loop-exhausted'
  | 'not-started';

/** `headless.done`만 자식 종료 코드와 예외 양상을 보존하도록 세분화한다. */
type HeadlessDoneExitReason = Exclude<PollExitReason, 'child-exit' | 'loop-exhausted'>
  | 'child-exit-success'
  | 'child-exit-failure'
  | 'child-exit-code-unavailable'
  | 'completion-after-loop-exhaustion'
  | 'loop-exhausted-without-completion'
  | 'pty-probe-error'
  | 'spawn-error'
  | 'initialization-error'
  | 'interaction-error'
  | 'poll-error'
  | 'snapshot-error'
  | 'render-error';

function publicExitReason(exitReason: HeadlessDoneExitReason): PollExitReason {
  switch (exitReason) {
    case 'child-exit-success':
    case 'child-exit-failure':
    case 'child-exit-code-unavailable':
      return 'child-exit';
    case 'completion-after-loop-exhaustion':
    case 'loop-exhausted-without-completion':
      return 'loop-exhausted';
    case 'pty-probe-error':
    case 'spawn-error':
    case 'initialization-error':
    case 'interaction-error':
    case 'poll-error':
    case 'snapshot-error':
    case 'render-error':
      throw new Error(`exception-only headless.done reason has no public result: ${exitReason}`);
    default:
      return exitReason;
  }
}

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

function childLifecycleState(
  records: readonly { id: number; record: LifecycleRecord }[],
  childPtyId: string,
): { readonly hasTerminal: boolean; readonly terminalCount: number; readonly maxSequence: number } {
  let terminalCount = 0;
  let maxSequence = 0;
  for (const { record } of records) {
    if (record.ptyId !== childPtyId) continue;
    maxSequence = Math.max(maxSequence, record.seq);
    if (record.subjectPtyId === childPtyId && (record.name === 'complete' || record.name === 'failed')) {
      terminalCount += 1;
    }
  }
  return { hasTerminal: terminalCount > 0, terminalCount, maxSequence };
}

function publishParentTerminalLifecycle(
  bus: ChannelBus,
  input: { runId: string; childPtyId: string; reachedCompletion: boolean; exitReason: PollExitReason; hasTerminal: boolean; terminalCount: number; maxSequence: number },
): LifecycleRecord | undefined {
  if (input.hasTerminal) {
    debug.log('self-implement', 'headless.parent-terminal-suppressed', {
      runId: input.runId,
      ptyId: input.childPtyId,
      reason: 'child-already-declared-terminal',
      terminalCount: input.terminalCount,
      maxSequence: input.maxSequence,
    });
    return undefined;
  }
  const envelope = {
    runId: input.runId,
    ptyId: input.childPtyId,
    subjectPtyId: input.childPtyId,
    depth: 0,
    role: 'child' as const,
    seq: Math.max(nextLifecycleSequence(input.childPtyId), input.maxSequence + 1),
    at: Date.now(),
    truncated: false as const,
  };
  const record: LifecycleRecord = input.reachedCompletion
    ? { ...envelope, class: 'progress', name: 'complete', payload: { summary: 'parent-declared terminal after child polling ended', changedFiles: [], verification: 'parent-proxy' } }
    : { ...envelope, class: 'progress', name: 'failed', payload: { reason: `parent-declared terminal after child polling ended: ${input.exitReason}` } };
  publishLifecycleRecord(bus, record);
  debug.log('signal', 'lifecycle.published', {
    name: record.name, runId: record.runId, ptyId: record.ptyId, subjectPtyId: record.subjectPtyId,
    depth: record.depth, role: record.role, seq: record.seq, truncated: record.truncated, publisher: 'parent-proxy',
  });
  debug.log('self-implement', 'headless.parent-terminal-published', {
    runId: record.runId,
    ptyId: record.ptyId,
    reason: 'child-terminal-absent',
    terminalCount: input.terminalCount,
    maxSequence: input.maxSequence,
  });
  return record;
}

export interface HeadlessGoalLoopPtyResult {
  /** PTY 경로 실행됨(false = PTY 미가용 → 호출측 spawnSync 폴백). */
  ok: boolean;
  reachedCompletion: boolean;
  transcript: string;
  toolCalls: number;
  timedOut: boolean;
  /** poll 루프의 기존 공개 종료 계약. `headless.done` 이벤트만 세분화된 사유를 기록한다. */
  exitReason: PollExitReason;
  exitCode: number | null;
  /** registry PTY id(PWA 노출·snapshot 대상). */
  ptyId: string;
}

export function pickImplementRoleForGoal(document: string): ReturnType<typeof resolveRoleLlm> | undefined {
  try {
    const config = getUserConfig();
    const role = resolveRoleLlm('implement', { config });
    if (config.harness?.difficultyPlacement !== true || role.source !== 'default') return role;
    const signals = goalDifficultySignals(document);
    const level = classifyGoalDifficulty(signals);
    const picked = resolveImplementDifficulty(role, level);
    try {
      debug.log('llm.difficulty', 'pick', { level, tier: picked.tier ?? null, signals });
      debug.log('harness.role-llm', 'difficulty-placement', { difficulty: level, tier: picked.tier, source: role.source });
    } catch { /* observation is fail-soft */ }
    return picked;
  } catch { return undefined; }
}

export async function runHeadlessGoalLoopPty(opts: HeadlessGoalLoopPtyOptions): Promise<HeadlessGoalLoopPtyResult> {
  const childLlm = opts.childLlm;
  if (childLlm && (typeof childLlm.provider !== 'string' || typeof childLlm.model !== 'string' || !childLlm.provider.trim() || !childLlm.model.trim())) {
    throw new Error('childLlm.provider and childLlm.model must both be non-empty');
  }
  // ⭐ B14 — 명시 자식 LLM · 런 단위 모델이 없을 때 골 난이도에 따라 역할 `implement` 기본 등급을 고른다.
  const implementRole = !childLlm && !process.env.ELANOUS_LLM_MODEL?.trim()
    ? pickImplementRoleForGoal(opts.goalDocument ?? opts.featurePrompt)
    : undefined;
  // ⭐ B9 — 승급 판정에 쓸 «유효 provider»: 명시 자식 → 역할 → 런 env → config(auto 는 실제 결정으로).
  const effectiveChildProvider = childLlm?.provider ?? implementRole?.provider ?? process.env.ELANOUS_LLM_PROVIDER?.trim()
    ?? (() => { try { return resolveActiveProvider(getUserConfig()); } catch { return undefined; } })();
  if (implementRole) debug.log('self-implement.child-llm', 'implement-role', { provider: implementRole.provider, model: implementRole.model, tier: implementRole.tier ?? null, source: implementRole.source });
  const spawn = opts.spawn ?? startPty;
  const available = opts.ptyAvailable ?? ptyAvailable;
  const nexusPwaResolver = opts.resolveNexusPwa ?? resolveNexusPwa;
  const grokFreshnessReader = opts.readGrokTokenFreshness ?? readGrokTokenFreshness;
  const iso = opts.configDir ? ['--config-dir', opts.configDir] : [];
  const rawArgs = [`${opts.binRoot}/bin/elanous.mjs`, 'dev', '--implement', ...iso, opts.featurePrompt];
  // ⭐ No pre-quoting. `startPty` takes tokens and spawns directly (2026-07-29
  //    convergence), so a prompt with spaces/newlines/quotes survives as ONE
  //    argv entry. Pre-quoting here would now embed literal `'` characters.
  const args = rawArgs;
  // ★ 화면 릴레이 키(2026-07-21·X11 forwarding식) + 자식 공간 자기인지 전파 — 이 함수가 seams.implement 의
  //   실 executor(PtyShell 호스팅). 공간 id(있으면·병렬 per-run 분리)·없으면 worktree 이름 폴백=항상 viewable.
  // ★ 관측갭 수리(2026-07-21·제1원칙·트랙A) — 부모가 공간 밖(ACP `SelfImplement` daemon 진입 등)이면 worktree
  //   이름으로 self-implement 공간을 합성한다. 이 driver 는 모든 self-implement 엔트리(CLI/ACP/병렬)가 지나는
  //   초크포인트라, 여기서 공간을 보장하면 어떤 진입이든 자식 goal-loop 이 항상 self-recognize + sink 등록
  //   (chat --goal-loop 의 공간-게이트) → 엔트리 무관 균일 관측. CLI/detached 진입은 부모가 이미 심어 그대로 존중.
  const space = getHarnessSpace()
    ?? { inHarness: true as const, kind: 'self-implement' as const, id: normalizeSpaceId(basename(opts.cwd)), runId: getHarnessRunId() };
  // ★ K run-identity 공백 방어(2026-07-26 실측 갭) — space 가 있어도 runId 가 '' 일 수 있다(harness-space:92 는
  //   env 를 그대로 읽는다). 빈 runId 는 `elanous self run <runId>` 사후 join 을 **불가능**하게 만든다(관측 계약은
  //   있는데 값이 안 실린 사례). 호출자 지정 > 상속 > canonical mint 순으로 항상 비어있지 않게 확정한다.
  const { runId } = resolveRunIdentity({ explicit: opts.runId, inherited: space.runId });
  const controlInboxDir = resolveControlInboxDir(space.id);
  const { key: screenKey } = resolveHarnessScreenKey(space.id, opts.cwd);
  const executionId = mintPtyId('self');
  const contextSource = `elanous://harness/${encodeURIComponent(runId)}/${encodeURIComponent(executionId)}`;
  const boundaryRequestsEnv = harnessBoundaryRequestsEnv(executionId);
  const boundaryResponsesEnv = harnessBoundaryResponsesEnv(executionId);
  const boundaryRequestsPath = boundaryRequestsEnv.ELANOUS_HARNESS_BOUNDARY_REQUESTS ?? '';
  const boundaryResponsesPath = boundaryResponsesEnv.ELANOUS_HARNESS_BOUNDARY_RESPONSES ?? '';
  const lifecycleReportNonce = randomUUID();
  const lifecycleReportPath = lifecycleRootReportPath(executionId, lifecycleReportNonce);
  const surfaceProgressCounts: SurfaceProgressCounts = { total: 0, handedToCallback: 0, unwired: 0, callbackFailed: 0 };
  let doneEmitted = false;
  const emitDone = (data: Record<string, unknown>): void => {
    if (doneEmitted) return;
    doneEmitted = true;
    if (spawned) observeExternalEvent({ origin: 'harness-child', kind: 'finished',
      summary: `Harness child finished: ${String(data.exitReason ?? 'unknown').slice(0, 60)}`, source: contextSource });
    debug.log('self-implement', 'headless.done', {
      ptyId: executionId,
      runId,
      ...data,
      surfaceProgressTotal: surfaceProgressCounts.total,
      surfaceProgressHandedToCallback: surfaceProgressCounts.handedToCallback,
      surfaceProgressUnwired: surfaceProgressCounts.unwired,
      surfaceProgressCallbackFailed: surfaceProgressCounts.callbackFailed,
    });
  };
  let h!: ReturnType<typeof startPty>;
  let spawned = false;
  let grokCredentialFreshness: GrokCredentialFreshnessSnapshot | null = null;
  let stopBoundaryRequestsWatch: (() => void) | undefined;
  // ⭐ M5 — 경계 관문의 «최신 판정»과 «누적 수». 판정 레코드가 이 둘을 같이 싣는다.
  //   ⛔ 제어 흐름에 안 쓴다 — 관측 전용이다(그림자 계약 유지).
  let boundaryRequestCount = 0;
  let lastBoundaryVerdict: { requestId: string; wouldApprove: boolean; approve: boolean; evidenceWhy: string; observedRawShellMetacharacters: string } | undefined;
  let lastCommandFirstToken: string | undefined;
  let sameCommandStallToken: string | undefined;
  let sameCommandStallCount = 0;
  let pendingWaitSupervisionCount = 0;
  let pendingWaitLatestJudgment: string | undefined;
  // Repetition identity is exact full instruction-text equality after the existing delivery trim;
  // the first occurrence omits the surface marker, and later occurrences are only annotated.
  const inputInstructionOccurrences = new Map<string, number>();
  const countInputInstructionOccurrence = (instruction: string): number => {
    const occurrence = (inputInstructionOccurrences.get(instruction) ?? 0) + 1;
    inputInstructionOccurrences.set(instruction, occurrence);
    return occurrence;
  };
  const emitSurfaceProgress = (line: string, kind: SurfaceProgressKind): void => {
    const outcome = deliverSurfaceProgress(line, kind, opts.onSurfaceProgress);
    countSurfaceProgressOutcome(surfaceProgressCounts, outcome);
    debug.log('self-implement', 'headless.surface-progress', { ptyId: executionId, runId, ...outcome },
      outcome.status === 'callback-failed' ? { level: 'warn' } : undefined);
  };
  const flushWaitSupervisionProgress = (): void => {
    if (pendingWaitSupervisionCount === 0) return;
    emitSurfaceProgress(formatSupervisionProgressLine({
      action: 'wait',
      reason: formatWaitSupervisionBatchReason(pendingWaitSupervisionCount, pendingWaitLatestJudgment),
    }), 'supervision');
    pendingWaitSupervisionCount = 0;
    pendingWaitLatestJudgment = undefined;
  };
  let onAbort: (() => void) | undefined;
  let phase: 'probe' | 'spawn' | 'initialization' | 'poll' | 'snapshot' = 'probe';
  try {
    if (!available()) {
      emitDone({
        ptyId: '', reachedCompletion: false, timedOut: false, exitReason: 'not-started',
        exit: null, toolCalls: 0, chars: 0,
      });
      return { ok: false, reachedCompletion: false, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'not-started', exitCode: null, ptyId: '' };
    }
    phase = 'spawn';
    if (childLlm?.provider === 'grok') {
      try {
        grokCredentialFreshness = describeGrokCredentialFreshness(grokFreshnessReader());
      } catch {
        grokCredentialFreshness = describeGrokCredentialFreshness(undefined, { lookupFailed: true });
      }
      // Snapshot only: it never starts login, refresh, or changes whether the child spawns.
      debug.log('self-implement', 'headless.grok-credential-preflight', {
        runId,
        childProvider: 'grok',
        ...grokCredentialFreshness,
      }, grokCredentialFreshness.status === 'expired' ? { level: 'warn' } : undefined);
      emitSurfaceProgress(`[grok-credential-preflight] status=${grokCredentialFreshness.status} checkedAt=${grokCredentialFreshness.checkedAt} expiresAt=${grokCredentialFreshness.expiresAt ?? 'unknown'} action=${grokCredentialFreshness.action}\n`, 'supervision');
    }
    h = spawn({
    id: executionId,
    // ⭐ `kind` 는 `id` 와 **반드시 짝**이어야 한다. `startPty` 는 선할당 id 를 받으면
    //   `opts.kind`(없으면 'pty')로 형식을 검증하는데, 여기서 id 만 `self_…` 로 넘기고 kind 를
    //   생략하면 `invalid preallocated PTY id "self_…" — expected pty_<8 hex>` 로 **거부**되고
    //   조용히 spawnSync 폴백으로 떨어진다. 폴백이 fail-soft 라 로그 한 줄만 남고 계속 가므로
    //   ①`headless.progress` 라이브 관측 ②registry 등록(PWA 노출) ③부모 비블로킹
    //   ④자식의 `ELANOUS_PTY_ID`(=lifecycle 발행) 가 **전부 조용히 사라진다.**
    //   ⚠️ 선할당(`opts.id`)을 쓰는 호출자는 minter 와 validator 가 같은 kind 를 보게 하라.
    kind: 'self',
    cmd: 'bun', args,
    // ⭐ S4 P0-② 수리(대표 결정 2026-07-26 "agent write 는 허용해야 합니다") — 자율 self-dev PTY 의
    //   소유자는 **사람이 아니라 감독(brain)** 이다. 종전엔 accessMode 미지정 → 기본 'write'(사람 소유)라
    //   arbiter 가 agent write 를 거부했다(resolveWriteDecision('write','agent') = allow:false) → S4 개입이
    //   구조적으로 불가. 'auto' = brain 소유(자율)이고, transitionPolicy 기본 'open' 이라 **사람은 언제든
    //   takeover(auto→write)** 할 수 있다(안전 계약 유지·brain 은 hasControl 로 즉시 yield).
    //   선례 계승: agent-mission/driver.ts(accessMode:'auto') · cli/pty-drive-cli.ts(동일 주석).
    accessMode: 'auto',
    cols: opts.cols ?? 200, rows: opts.rows ?? 55,
    workdir: opts.cwd,
    env: {
      ...(opts.stateDir ? { ELANOUS_STATE_DIR: opts.stateDir } : {}),
      [CHILD_LIVENESS_HEARTBEAT_ENV]: resolveChildLivenessHeartbeatPath(opts.cwd),
      ...controlInboxEnv(controlInboxDir),
// ⛔⭐ 뿌리와 «한 벌»로 간다(`OBS-T121`) — 안 주면 자식이 「파생」을 「명시 격리」로 읽는다.
            ...(opts.stateDir && opts.stateDirSource ? { ELANOUS_STATE_DIR_SOURCE: opts.stateDirSource } : {}),
      ELANOUS_PARENT_SELF_DEV_RUNS_DIR: selfDevRunsDir(),
      ...childRunContextEnv('self-build'),
      // ⭐ 구현 자식은 코딩 도구 프로필로 — 도메인·운영 도구 스키마를 매 턴 싣지 않는다(BACKLOG L1 · tool-profile.ts).
      // 기본 coding(다이어트) · 부모가 `ELANOUS_CHILD_TOOL_PROFILE=full` 또는 묶음(`finance,ops`)을 주면 «더한다»(tool-profile.ts).
      ELANOUS_TOOL_PROFILE: childToolProfile(process.env, opts.featurePrompt),
      // ⭐ 로컬 모델 자식은 시스템 프롬프트도 «lean» 예산(AGENTS.md 앵커 8K · 트리 2K) — BACKLOG L2 · universal-preamble.ts.
      ...(((childLlm?.provider ?? process.env.ELANOUS_LLM_PROVIDER)?.trim() === 'local') ? { ELANOUS_PROMPT_BUDGET: 'lean' } : {}),
      ...childNestEnv(),
      ...childPtyIdentityEnv(executionId),
      ...lifecycleRootReportEnv(lifecycleReportPath, lifecycleReportNonce),
      ...boundaryRequestsEnv,
      ...boundaryResponsesEnv,
      ...harnessPolicyEnv(),
      ...(space ? harnessSpaceEnv(space.kind, space.id, runId) : {}),   // 자식 goal-loop 자기인지(#4948 프리앰블) + ★K runId 명시 전파(captured-env 경계)
      ...harnessBoundaryEnv(opts.cwd),   // ★ #4 명시 쓰기 경계 — worktree(cwd) 전파 → 자식 부팅 시 결정론 경계 활성(정본 오염 봉쇄)
      ...(opts.documentReferences?.length ? { ELANOUS_DOCUMENT_REFERENCES: JSON.stringify(opts.documentReferences) } : {}),
      // ⭐ B14/E2 — 명시 자식 LLM·런 단위 모델이 없으면 골 난이도를 적용한 구현 역할 모델을 릴레이한다.
      ...childLlmSelectionEnv(childLlm ?? (implementRole ? { provider: implementRole.provider, model: implementRole.model, source: 'config' } : undefined)),
      // 결정 2026-09-23 — 명시 childLlm 은 «같은 provider» 사다리 안에서만 한 칸 승급한다(없으면 승급 안 함).
      //   미지정 경로는 기존 티어(codex sol 등)를 그대로 쓴다.
      // 대표 2026-09-25 (B9) — 유효 provider 가 codex·anthropic 이면 승급하지 않는다.
      ...((): Record<string, string> => {
        const tier = opts.escalateTier ?? 'none';
        if (tier !== 'none' && !escalationAllowedForProvider(effectiveChildProvider)) {
          debug.log('self-implement.escalation', 'suppressed', { provider: effectiveChildProvider, tier, reason: 'codex-or-anthropic' });
          return {};
        }
        const target = childLlm
          ? resolveExplicitChildEscalateTarget(tier, process.env, { provider: childLlm.provider, model: childLlm.model, ...(childLlm.effort ? { effort: childLlm.effort } : {}) })
          : resolveEscalateTarget(tier);
        if (!target) return {};
        return {
          ELANOUS_ESCALATE_MODEL: target.model, ELANOUS_ESCALATE_PROVIDER: target.provider,
          ...(target.effort ? { ELANOUS_ESCALATE_EFFORT: target.effort } : {}),
          // ★ 릴레이 전달 — escalate provider 키를 자식에 명시 전파(spawn env=replace·config auth 폴백).
          ...childProviderKeyEnv(target.provider),
        };
      })(),
    },
    });
    spawned = true;
    observeExternalEvent({ origin: 'harness-child', kind: 'started', summary: 'Harness child started', source: contextSource });
    phase = 'initialization';
  const ptyId = h.id;
  // ⭐⭐ M5 — 그 판정을 «런 슈퍼바이저 레코드»로 올린다. 종전엔 경계 판정이 자기 로그에만 남아
  //   `run-supervision.verdict` 한 줄에서 «보이지 않았다»(그 줄이 autoStop·autoAssist·화면정체는 이미 담는다).
  //   ⛔ 호출자가 준 콜백을 밀어내지 않는다 — 내 집계를 먼저 하고 그다음 호출자 것을 부른다.
  stopBoundaryRequestsWatch = watchHarnessBoundaryRequests(boundaryRequestsPath, { ptyId, runId }, {
    ...opts.boundaryRequestsWatchOptions,
    responsePath: boundaryResponsesPath,
    onVerdict: (verdict) => {
      boundaryRequestCount += 1;
      lastBoundaryVerdict = verdict;
      // The mailbox record can contain command details; the parent surface gets only the
      // request identifier and decision reason. This is observation, not an approval UI:
      // the line reports the candidate, enforcement state, and child outcome.
      // 진행 줄은 «거부»만 — 명령 시작 통지(`command-start` 류)는 사람에게 거부처럼 보이면 안 된다.
      if (verdict.requestKind === 'rejected') emitSurfaceProgress(formatBoundaryProgressLine(verdict), 'boundary');
      opts.boundaryRequestsWatchOptions?.onVerdict?.(verdict);
    },
    onCommandStart: (commandFirstToken) => {
      const reset = resetSameCommandStallStreak(commandFirstToken, lastCommandFirstToken);
      if (reset) {
        sameCommandStallToken = reset.token;
        sameCommandStallCount = reset.count;
      }
      lastCommandFirstToken = commandFirstToken;
      opts.boundaryRequestsWatchOptions?.onCommandStart?.(commandFirstToken);
    },
  });
  let pwa: NexusPwaResolution;
  try {
    pwa = nexusPwaResolver({ cwd: opts.cwd });
  } catch {
    pwa = { status: 'absent', reason: 'pwa-query-failed' };
  }
  const surfaceLinkLine = formatSurfaceLinkProgressLine(ptyId, pwa);
  emitSurfaceProgress(surfaceLinkLine, 'surface-link');
  // ⛔ 사람이 읽는 줄을 «잘라서» 구조화 값을 만들지 않는다 — 줄 형식이 바뀌면 값이 조용히 오염된다
  //   (실제로 `source=` 를 더하자 그 슬라이스가 URL 에 그것을 붙였다). 같은 순수 함수에서 «둘 다» 뽑는다.
  const surfaceLinkUrl = surfaceLinkUrlFor(ptyId, pwa);
  const reportOrigin = readReportOrigin(process.env);
  if (surfaceLinkUrl !== null && reportOrigin?.channel === 'telegram') {
    try {
      const accepted = (opts.sendOutbound ?? sendOutbound)(formatPtyLinkMessage({ webUrl: surfaceLinkUrl, ptyId }), 'report', reportOrigin);
      debug.log('self-implement.surface-link', accepted ? 'reported' : 'report-failed', { ptyId, chatId: reportOrigin.chatId });
    } catch (error) {
      try { debug.log('self-implement.surface-link', 'report-failed', { ptyId, error: errorMessage(error) }, { level: 'warn' }); } catch { /* fail-soft */ }
    }
  }
  const surfaceLinkObservation: Record<string, string> = surfaceLinkUrl !== null && 'source' in pwa
    ? { surfaceLinkUrl, surfaceLinkSource: pwa.source }
    : { surfaceLinkUnavailableReason: 'reason' in pwa ? pwa.reason : 'pwa-url-unknown' };
  // This observation records only which directories the spawner handed over. The child's
  // isolation outcome is emitted by its own instance.provision event and joins on cwd.
  debug.log('self-implement', 'headless.spawn', {
    ptyId,
    runId,
    ...surfaceLinkObservation,
    cwd: opts.cwd,
    configDirPassed: observeIsolationAxis(opts.configDir),
    stateDirPassed: observeIsolationAxis(opts.stateDir),
    transport: 'pty',
    screenKey,
    // ⭐ 자식 «두뇌» 축 — 프로바이더 A/B 는 「어느 갈래가 어느 두뇌였나」를 «사후»에 되짚어야
    //   성립하는데, 종전엔 이 줄이 디렉토리 축만 담아 그 질문에 답할 수 없었다(2026-08-14 실측).
    //   ⛔ 명시 선택이 «없을» 때와 «있을» 때를 같은 값으로 적지 않는다 — 부재는 null 로 남긴다.
    childLlm: childLlm ? { provider: childLlm.provider, model: childLlm.model, source: childLlm.source } : null,
    // Read-only pre-spawn snapshot. No credential strings, refresh, login, or spawn policy are recorded here.
    grokCredentialFreshness,
    escalateTier: opts.escalateTier ?? 'none',
  });
  // ⭐ S4 P3 배선 관측(리뷰 should-fix) — `seams` 가 user-config 에서 읽어 넘긴 **실효 노브**를 run 당 1회
  //   남긴다. 이게 없으면 "설정을 켰는데 왜 안 멈추나"를 config 파일과 코드를 대조해야 알 수 있고,
  //   전달 경로가 끊겨도(seams 가 안 넘김) 파서 테스트·드라이버 테스트는 각각 통과한다.
  //   ⇒ 제1원칙: 조회로 확인 가능해야 한다. `elanous logs --category self-implement --grep autostop.config`
  debug.log('self-implement', 'autostop.config', {
    ptyId, runId,
    enabled: opts.autoStop?.enabled ?? false,
    minRung: opts.autoStop?.minRung ?? 2,
    wired: opts.autoStop !== undefined,   // false = 스포너가 노브를 아예 안 넘겼다(배선 끊김)
    brainWired: opts.brain !== undefined,
  });
  debug.log('self-implement', 'screen-stall-termination.config', {
    ptyId, runId,
    enabled: opts.screenStallTermination?.enabled ?? false,
    minRung: opts.screenStallTermination?.minRung ?? 2,
    wired: opts.screenStallTermination !== undefined,
  });
  // ★ K run-identity(2026-07-25) — 이 PTY(실 goal-loop executor)에 도달한 join anchor 를 관측. K3 pty_manifest
  //   스탬프가 이 runId↔ptyId 를 영속화(closed_at tombstone) → `elanous self run <runId>` 사후 join(K5).
  debug.log('run-identity', 'propagate', { runId, ptyId, via: 'headless-goal-loop-executor' });
  // ★ /cancel 대응(#21) — 턴 abort 시 호스팅 PTY 를 즉시 kill(고아 자식 방지). 관측(제1원칙): abort-kill.
  //   listener=즉시 kill · 루프 상단 aborted 체크=조기 종료(finally 가 idempotent kill).
  onAbort = (): void => {
    try { h.kill(); } catch { /* fail-soft */ }
    debug.log('self-implement', 'headless.abort-kill', { ptyId });
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const pollMs = opts.pollMs ?? 1000;
  const roundContext = boundRoundContext(opts.roundContext);
  const roundContextPresent = roundContext !== undefined;
  phase = 'poll';
  try {
    // ★ adaptive 타임아웃(dev-harness 정책·2026-07-21) — soft(maxWaitSec) 초과해도 **최근 출력활동**이 있으면
    //   hard 까지 연장(살아있는 복잡 작업이 600s 컷에 잘리는 것 방지) · 무활동이면 soft 에서 종료 · hard=절대상한.
    //   iteration 단위(=poll tick·prod pollMs≈1000ms 이라 ≈초). /cancel(#21) 이 hard 도 조기 종료 가능.
    const softI = opts.maxWaitSec ?? 600;
    const hardI = Math.max(softI, opts.maxHardWaitSec ?? DEFAULT_MAX_HARD_WAIT_SEC);
    // ⛔⛔⭐ 90 → 240 (2026-07-30 실측 · 대표 지시 *"자식의 상한이 너무 낮네요. 이제 매우 복잡한
    //   작업도 요구하고 있지 않나요"*). **90 은 우리가 요구를 늘리기 전에 정해진 수**다.
    //   ⭐ 위 연장 정책의 의도는 *"살아있는 복잡 작업이 컷에 잘리는 것 방지"* 인데,
    //   ⛔ **무출력 구간이 90초를 넘는 명령 하나로 그 의도가 무력화된다** — 연장 조건이
    //      *"최근 **출력**활동"* 이라서 **조용히 일하는 것을 죽은 것으로 읽는다.**
    //   실측: `bun bin/elanous.mjs self typecheck` = **147초 무출력**(변경 5파일) ⇒ 구조적으로 90 초과.
    //   ⛔ **`silentFor` 최대값이 죽은 런과 산 런을 정확히 갈랐다**(2026-07-30 · `poll.heartbeat`):
    //      134·112·107·100 → 전부 `soft-timeout` 사망 / 81·80·80·79·78·70 → 전부 생존.
    //      ⇒ 임계에서 **완벽히 분리**된다. 표본 요동이 아니라 이 상수가 판정하고 있었다.
    //   ⚠️ hard(1800)는 안 건드린다 — 절대상한은 그대로이고 **연장이 걸릴 자격**만 넓힌다.
    //   ⇒ 240 = 가장 긴 무출력 명령(147s)의 약 1.6배. 더 긴 무출력 명령이 생기면 이 수를 다시 잰다.
    const graceI = opts.activityGraceSec ?? DEFAULT_ACTIVITY_GRACE_SEC;
    const activityGraceSource = opts.activityGraceSource ?? 'default';
    let timedOut = true; // 루프 소진(exit/완료선언 없이) 시에만 타임아웃.
    // ⭐ **왜 나갔나**(2026-07-27 실측 갭) — 이 루프는 일곱 갈래로 나가는데 어느 갈래였는지가
    //   관측에 없었다. 그래서 실제 사고 하나를 진단하는 데 **다섯 개의 부재 증명**이 필요했다
    //   (brain.applied 없음 · abort-kill 없음 · wallclock-cap 없음 · timeout-extend 없음 ·
    //    isAlive/exitCode 계약상 모순). **다른 이벤트의 부재로 추론해야 하면 그건 관측이 아니다.**
    //   ⚠️ 종료 사유와 완료 여부는 **다른 축**이다 — 완료 선언으로 나가도 미완일 수 있고(실측이
    //   그랬다) 자식 종료로 나가도 완료일 수 있다. `reachedCompletion` 과 합치지 않는다.
    let exitReason: HeadlessDoneExitReason = 'loop-exhausted-without-completion';
    let lastActivityI = -1; // 출력·생존 하트비트 활동: soft-timeout 연장 근거.
    let lastOutputActivityI = -1; // PTY 출력만: 화면 정지 종료의 침묵 근거.
    let lastSeenLivenessAt: number | undefined;
    const childLivenessPath = resolveChildLivenessHeartbeatPath(opts.cwd);
    let extendedLogged = false;
    let parentOrphanedTransitionLogged = false;
    let lastFrameRenderMs = 0; // ⭐P3 — manifest frame 포워딩 throttle(renderScreen 비용 억제).
    let lastFrameState: FrameState | null = null; // ⭐키프레임 결정론 게이트 — 직전 화면-상태(전이 감지).
    let lastUnknownInput: readonly string[] | undefined;
    let lastOutOfRegionCandidates: readonly string[] | undefined;
    const progressFrameLineBuffer: ProgressFrameLineBuffer = { remainder: '', discardUntilNewline: false };
    let frameObs: FrameObservationState = INITIAL_FRAME_OBSERVATION; // ⭐S4 P1 — 화면-상태 관측(개입 없음).
    let previousIntervention: InterventionStep | null = null;
    let previousStallMetrics: { toolCalls: number; chars: number } | undefined;
    let keyframeSeq = 0; // 이 run 의 키프레임 순번(파일 키·seq 순 추출).
    // ⭐⭐ **wall-clock 상한**(리뷰 must-fix 2026-07-26) — 이 루프의 회계는 `i`(≈초·pollMs≈1000ms 가정)
    //   기반이다. S4 P2b brain 상담이 tick 당 최대 `brainTimeoutMs`(기본 15초)를 **직렬 await** 하므로
    //   전이가 반복되면 1 tick 이 ~16초가 되어 `maxWaitSec` 계약을 **최대 16배 초과**한다(600s → ~2.7h).
    //   ⇒ 기존 활동-grace 의미(i 기반)는 **그대로 두고** 절대 경과시간을 **추가 상한**으로만 얹는다.
    //   단조 안전: 더 **일찍** 멈출 뿐 늦게 멈추는 경우가 없다. brain 미주입이면 i≈초라 두 조건이 일치
    //   (무회귀). ROADMAP §2 P1(종료 지연)의 회계 구조를 재작성하지 않는 최소 개입이다.
    const loopStartedMs = Date.now();
    const elapsedSec = (): number => (Date.now() - loopStartedMs) / 1000;
    pollLoop: for (let i = 0; i < hardI; i += 1) {
      if (opts.signal?.aborted) { timedOut = false; exitReason = 'abort'; break; } // /cancel → 조기 종료(PTY 이미 kill)
      if (elapsedSec() >= hardI) { // 절대 상한(상담 시간 포함) — i 회계가 늘어져도 여기서 끊긴다
        debug.log('self-implement', 'headless.wallclock-cap', { ptyId, i, elapsedSec: Math.round(elapsedSec()), hardI }, { level: 'warn' });
        exitReason = 'wallclock-cap';
        break;
      }
      if (i >= softI || elapsedSec() >= softI) {
        const silentFor = lastActivityI < 0 ? Number.POSITIVE_INFINITY : i - lastActivityI;
        if (silentFor >= graceI) { exitReason = 'soft-timeout'; break; } // soft 초과 + 무활동(grace 경과 or 무활동) → 타임아웃(timedOut=true)
        if (!extendedLogged) { // soft 초과했지만 활동 지속 → 연장(관측 1회). 조회: logs --category self-implement
          debug.log('self-implement', 'headless.timeout-extend', { ptyId, softI, hardI, graceI, activityGraceSource, lastActivityI });
          extendedLogged = true;
        }
      }
      await sleep(pollMs);
      // ★ INC-1 근본특정 heartbeat(2026-07-21) — 매 tick **동기 writeFileSync** 로 루프 진행상태를 디스크에
      //   남긴다(버퍼드 debug.log 는 freeze 시 flush 못 하지만 이건 남는다). hang 재발 시 `.hb` 를 읽어 **i 고정
      //   (frozen·어느 op에 블록) vs i 증가(idle·타임아웃 로직 문제)** 를 결정적으로 판정. 뷰=`elanous self screen --hb`.
      const silentFor = lastActivityI < 0 ? -1 : i - lastActivityI;
      let parentPid: number | undefined;
      let parentStatus: 'alive' | 'orphaned' | 'unreadable';
      try {
        parentPid = (opts.readParentPid ?? (() => process.ppid))();
        parentStatus = parentPid === 1 ? 'orphaned' : 'alive';
      } catch {
        parentStatus = 'unreadable';
      }
      const parentOrphanedTransition = parentStatus === 'orphaned' && !parentOrphanedTransitionLogged;
      if (parentOrphanedTransition) parentOrphanedTransitionLogged = true;
      const parentObservation = { parentPid, parentStatus, ...(parentOrphanedTransition ? { parentOrphanedTransition: true } : {}) };
      writeHarnessHeartbeat(screenKey, { i, alive: h.isAlive(), lastActivityI, silentFor, softI, hardI, ...parentObservation });
      if (i % 30 === 0 || parentOrphanedTransition) {
        debug.log('self-implement', 'poll.heartbeat', { ptyId, runId, i, alive: h.isAlive(), lastActivityI, silentFor, ...parentObservation });
      }
      // #24 finer 마커 — stall 시 "poll 루프 안(자식 구동·정상)" vs "다른 동기 op" 구분.
      setEventLoopActivity(`headless:poll-${i}:alive-${h.isAlive() ? 1 : 0}`);
      const delta = h.drainDelta();
      phase = 'snapshot';
      const snap = h.snapshot();   // ★ 1회 캡처 — 화면 릴레이 + GOAL-COMPLETE 공용(중복 snapshot 제거)
      phase = 'poll';
      // ★ 화면 릴레이 프레임(X11 forwarding식) — `elanous self screen --space <id> -f` 로 라이브(hang 순간 화면도). fail-soft.
      writeHarnessScreen(screenKey, snap);
      // ⭐P3 — 렌더 프레임을 manifest 로 포워딩(크로스-프로세스 관측·PWA 미러가 자식 화면을 라이브로).
      //   snapshot(원시 ANSI)은 registry 가 이미 매니페스트에 쓴다 → 여기선 사람이 보는 렌더 화면을 추가.
      //   ⚠️ renderScreen() 은 async → updatePtyManifestFrame 의 sync lazy supplier 로 넘길 수 없다. 그래서
      //   비싼 render 자체를 **이 드라이버 throttle(lastFrameRenderMs·~1.5s)** 로 게이트한다(매니페스트 내부
      //   throttle 은 여기선 잉여). lastFrameRenderMs 는 **render 성공 후에만** 갱신 = 비용의 근원(render)을 기준.
      //   매니페스트 write 는 fail-soft(row 부재 시 no-op)지만 그건 관측할 게 없다는 뜻일 뿐 — render 비용
      //   게이팅과 무관. render 실패(throw)면 throttle 미갱신 → 다음 tick 즉시 재시도(1.5s 잠금 없음).
      const nowMs = (opts.nowMs ?? Date.now)();
      if (nowMs - lastFrameRenderMs >= 1500) {
        try {
          const rendered = await h.renderScreen();
          // ★ 두 관측 sink(manifest frame·프레임 버스)는 **독립 fail-soft 경계**(review) — 하나가 던져도 다른 하나는 발행.
          try { updatePtyManifestFrame(h.id, () => rendered, nowMs); }
          catch (e) { debug.log('self-implement', 'manifest-frame-fail', { ptyId: h.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
          // ⭐ 결정적-순간 키프레임 캡처(스마트 PNG 1차·결정론 게이트·2026-07-25) — 화면-상태 전이(idle→working
          //   →blocked→done 등)일 때만 renderScreenPng(무거운 sharp)를 뽑아 저장 → pngRef 스탬프. 매 프레임 아님
          //   (전이는 드묾)이라 비용 억제. fail-soft(캡처 실패가 goal-loop·프레임 발행 무해). [[keyframe-capture]].
          let pngRef: string | undefined;
          try {
            const frameVerdict = classifyFrameState(rendered, GOAL_LOOP_STATE_RULES);
            const curState = frameVerdict.state;
            const unknownInput = curState === 'unknown' ? frameVerdict.unknownInput : lastUnknownInput;
            lastUnknownInput = curState === 'unknown' ? frameVerdict.unknownInput : undefined;
            // ⭐ unknown 진단의 «둘째 축» — 「화면에 신호가 없었다」와 「신호가 «창 밖»이라 못 봤다」를 가른다.
            //   ⛔ `unknownInput` 과 «같은 결»로 나른다: unknown 일 때만 계산되고, 그 뒤 프레임까지 물고 간다.
            //   ⛔ 빈 배열도 «싣는다» — 「밖에도 없다」와 「안 쟀다」가 또 접히면 이 필드의 뜻이 사라진다.
            //   📏 이 배선이 없던 동안 `classifyFrameState` 는 값을 냈는데 관측이 «안 실어» 볼 사람이 없었다
            //     (`JDG-T35` ⑴ 이 잡은 실물 · 2026-08-11).
            const outOfRegionCandidates = curState === 'unknown' ? frameVerdict.outOfRegionCandidates : lastOutOfRegionCandidates;
            lastOutOfRegionCandidates = curState === 'unknown' ? frameVerdict.outOfRegionCandidates : undefined;
            const completionState = normalizeDeterministicCompletionState(curState);
            // ⭐ S4 P1 관측(2026-07-26·[[DESIGN-s4-react-l2-observes-l3-2026-07-26]]) — 분류를 **PNG 성공과
            //   무관하게** 기록한다. 종전엔 결과가 keyframe PNG 쓰기 성공에만 종속돼(아래 `if (moment)` 안),
            //   PNG 가 안 나오면 분류를 계산하고 버렸다 → 실 run 의 화면-상태 로그 0건 = "blocked 판정이
            //   신뢰할 만한가"를 데이터로 답할 수 없었다(P0-③). 개입은 하지 않는다(P1=관측만).
            //   전이·stall 문턱 통과 시에만 1건 → 렌더 노이즈 카테고리化 방지.
            const changed = frameObs.lastScreen !== null && frameObs.lastScreen !== rendered;
            const previousStallRung = frameObs.stallRung;
            const obs = observeFrame(frameObs, { state: curState, screen: rendered, atMs: nowMs });
            const tr: FrameTransition | undefined = obs.transition;
            const st: FrameStall | undefined = obs.stall;
            const tokenReset = resetSameCommandStallStreak(lastCommandFirstToken, sameCommandStallToken);
            if (tokenReset) {
              sameCommandStallToken = tokenReset.token;
              sameCommandStallCount = tokenReset.count;
            }
            if (tr) {
              debug.log('self-implement', 'frame-state', {
                ptyId: h.id, runId, from: tr.from, to: tr.to, heldMs: tr.heldMs,
                // ⭐ 「어느 규칙이 이 상태를 냈나」 — 생산은 되는데 «아무도 안 읽던» 값이다(끊긴 이음).
                //   📏 2026-08-11: 내가 D칸을 재면서 이 값이 필요했는데 필드 이름을 몰라 `-` 를 봤다.
                //   ⇒ 상태가 «왜» 그렇게 갈렸는지는 이 라벨 없이는 로그에서 복원할 수 없다.
                ...(frameVerdict.matchedLabel ? { matchedRule: frameVerdict.matchedLabel } : {}),
                ...((tr.from === 'unknown' || tr.to === 'unknown') && unknownInput ? { unknownInput } : {}),
                // ⛔ 빈 배열도 싣는다(위 주석) — `!== undefined` 로 재고 truthy 로 재지 않는다.
                ...((tr.from === 'unknown' || tr.to === 'unknown') && outOfRegionCandidates !== undefined ? { outOfRegionCandidates } : {}),
              }, { compact: { arrayMax: UNKNOWN_INPUT_MAX_LINES, stringMax: UNKNOWN_INPUT_MAX_LINE_LENGTH } });
            }
            if (st) {
              // `blocked` 규칙은 명시적 프롬프트만 잡는다 — 프롬프트 없는 정지(silent stall)는 이 신호가 잡는다.
              const { toolCalls, chars } = transcriptMetrics(snap);
              if (lastCommandFirstToken !== undefined) sameCommandStallCount += 1;
              const ruleHint = ruleHintForSameCommandFrameStall(sameCommandStallCount);
              debug.log('self-implement', 'frame-stall', {
                ptyId: h.id, runId, state: st.state, sameScreenMs: st.sameScreenMs, rung: st.rung,
                previousRung: previousStallRung >= 0 ? previousStallRung : null, toolCalls, chars,
                ...(lastCommandFirstToken === undefined
                  ? {}
                  : { lastCommandFirstToken, sameCommandStreak: sameCommandStallCount }),
                ...(ruleHint === undefined ? {} : { ruleHint }),
                // ⭐ 레벨 정책(리뷰 should-fix) — `idle`(빈 프롬프트)은 **정지가 정상**이다(자식이 턴을 끝내고
                //   입력을 기다리는 상태). warn 으로 올리면 운영 로그가 오염된다. 관측은 남기고(P1 데이터가
                //   목적) 레벨만 debug 로 낮춘다. 실제 이상 신호는 working/unknown/blocked 의 정지다.
              }, { level: st.state !== 'idle' && st.rung >= 1 ? 'warn' : 'debug' });
              if (previousStallRung !== st.rung) {
                emitSurfaceProgress(formatFrameStallProgressLine({
                  previousRung: previousStallRung, currentRung: st.rung, lastCommandFirstToken, toolCalls, chars,
                  previousToolCalls: previousStallMetrics?.toolCalls, previousChars: previousStallMetrics?.chars,
                }), 'frame-stall');
                previousStallMetrics = { toolCalls, chars };
              }
            }
            frameObs = obs.next;
            // ⚠️ 엣지 트리거만(리뷰 must-fix) — `blocked` 지속은 stall 사다리가 잡는다. brain-consultation.ts 헤더가 근거.
            // ⭐ 게이트 단일 소스(리뷰 should-fix) — 라벨 유무가 곧 판정이라 두 번 계산하지 않는다.
            const trigger = brainTrigger({ transition: Boolean(tr), stall: Boolean(st) });
            if (opts.brain && trigger) {
              // S4 P2b safety invariant: suggestions never write to this one-shot child and never end this loop.
              // ⭐공용 seam(P2b P-a′). 집행은 종전 그대로 **건너뛰기**다 — verdict 수렴은 P-b 의 몫.
              const stance = probeControlStance(h, 'agent', (e) =>
                debug.log('self-implement', 'hascontrol-error', { ptyId: h.id, runId, error: (e as Error)?.message ?? String(e) }));
              const blockedWrite = stanceBlocksWrite(stance);
              if (blockedWrite) {
                debug.log('self-implement', 'brain.skip', { ptyId: h.id, runId, step: i, stance,
                  reason: stance === 'unknown' ? 'control-stance-unverifiable' : 'lost-write-control',
                  ...supervisionObservationFields(mapControlStance(stance, 'skip')) });
              }
              {
              const intervention = decideInterventionStep({
                screen: rendered,
                previous: previousIntervention,
                stopAfterSameScreens: hardI + 1,
                descriptor: { controlStance: stance },
              });
              previousIntervention = intervention;
              const controlObs: ControlObservation = {
                  screen: rendered,
                  state: curState,
                  step: i,
                  intervention,
                  changed,
                  sameScreenMs: Math.max(0, nowMs - frameObs.screenSinceMs),
                  stallRung: frameObs.stallRung,
                  ...(roundContext ? { roundContext } : {}),
                };
                const controller = new AbortController();
                let rejectParentAbort: ((reason: Error) => void) | undefined;
                const parentAbort = opts.signal
                  ? new Promise<never>((_, reject) => { rejectParentAbort = reject; })
                  : undefined;
                const onBrainAbort = (): void => {
                  controller.abort();
                  rejectParentAbort?.(new Error('brain suggestion aborted'));
                };
                if (opts.signal?.aborted) onBrainAbort();
                else opts.signal?.addEventListener('abort', onBrainAbort, { once: true });
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  // Lost and unknown are the same ownership axis exercised by the stalled-screen
                  // tests, not separate stances. Preserve their measured ownership and observation
                  // pipeline with a synthetic wait, whose evidence is honestly `action-wait`; calling
                  // the brain would violate the no-consultation boundary, while weakening brainCalls
                  // would hide that boundary instead of preserving it.
                  const decision: ControlDecision = blockedWrite
                    ? { action: 'wait' }
                    : await Promise.race([
                    Promise.resolve(opts.brain.decide(controlObs, controller.signal)),
                    new Promise<ControlDecision>((_, reject) => {
                      // ⭐ **남은 절대 예산으로 clamp**(리뷰 must-fix 2R) — wall-clock 상한은 **tick 시작**에서만
                      //   검사하므로, deadline 직전에 시작된 상담이 그대로면 최대 brainTimeoutMs(기본 15초)만큼
                      //   hard deadline 을 **초과**한다. 상담 자체를 남은 예산 안으로 묶어 창을 닫는다.
                      //   최소 1ms(음수·0 이면 즉시 timeout → 다음 tick 상단 wall-clock 체크가 루프를 끊는다).
                      const remainMs = Math.max(1, hardI * 1000 - (Date.now() - loopStartedMs));
                      timer = setTimeout(() => { controller.abort(); reject(new Error('brain suggestion timeout')); },
                        Math.min(opts.brainTimeoutMs ?? 15_000, remainMs));
                    }),
                    ...(parentAbort ? [parentAbort] : []),
                  ]);
                  const actionDetail = decision.action === 'input'
                    ? decision.text.slice(0, 120)
                    : decision.action === 'done' || decision.action === 'no-progress' ? decision.reason.slice(0, 120) : '';
                  const novelCompletionSignal = hasNovelCompletionSignal({ state: completionState, action: decision.action });
                  const autoStop: AutoStopVerdict = decideAutoStop({
                    action: decision.action,
                    state: completionState,
                    stallRung: st?.rung ?? NO_STALL,   // stall 이 없는 tick = 확증 없음
                    childAlive: h.isAlive(),
                    enabled: opts.autoStop?.enabled ?? false,
                    minRung: opts.autoStop?.minRung ?? 2,
                  });
                  // ⚠️ **여기서는 꺼져 있어도 상담한다** — 루프(`pty-control-loop`)와 계약이 다르다.
                  //   루프의 legacy 동작은 *"input 을 주입한다"* 라 꺼진 게이트가 상담하면 그 주입을
                  //   막아 회귀가 된다. 이 경로의 legacy 동작은 *"input 을 조용히 버린다"* 이므로
                  //   상담은 **아무것도 바꾸지 않고 사유만 남긴다** — 그게 이 페이즈의 산출(정직한 드롭)이다.
                  //   ⇒ 계약을 통일하면 여기서는 침묵이 돌아온다.
                  const reachability = {
                    pty: opts.canReceiveInput ?? false,
                    supervisorQueue: opts.onSupervisorInput !== undefined,
                  };
                  const autoAssist = decideAutoAssist({
                    action: decision.action,
                    stallRung: st?.rung ?? NO_STALL,
                    minRung: opts.autoAssist?.minRung ?? 2,
                    childAlive: h.isAlive(),
                    ownership: stance,
                    reachability,
                    enabled: opts.autoAssist?.enabled ?? false,
                  });
                  const supervisionObservation = (() => {
                    try {
                      // ⚠️ 단언으로 union 을 뭉개지 않는다 — 판정은 타입이 보장하고, 어휘 목록은
                      //    supervision-vocabulary 한 곳에만 있어야 한다(복제 금지).
                      return supervisionObservationFields(mapBrainAction(decision.action, autoStop.stop));
                    } catch (error) {
                      return { supervisionMappingError: String(error instanceof Error ? error.message : error).slice(0, 120) };
                    }
                  })();
                  const supervisionVerdictPayload = {
                    // 관측 계약은 화면 분류 원문을 보존한다. 완료 정보량·자동 정지는 아래의
                    // `completionState` 폐쇄형 정규화만 소비하므로 blocked/idle 기록을 잃지 않는다.
                    ptyId: h.id, runId, moment: 'in-round', step: i, trigger, state: curState, action: decision.action,
                    // `delivery-outcome` is a follow-up observation, not another verdict. Consumers count
                    // either initial stage once per decision and can distinguish verdicts without input.
                    supervisionRecordStage: decision.action === 'input' ? 'verdict-input' : 'verdict-no-input',
                    // ⚠️ 이름 정정(리뷰 should-fix) — 길이가 아니라 **잘린 원문**이다(앞 120자·로그 비대 방지).
                    actionDetail, reason: decision.action === 'no-progress' ? decision.reason.slice(0, 120) : undefined,
                    stallRung: st?.rung ?? NO_STALL, novelCompletionSignal, applied: autoStop.stop, why: autoStop.why,
                    shadowed: autoStop.shadowed, wouldStop: autoStop.wouldStop, evidenceWhy: autoStop.evidenceWhy,
                    autoAssistShadowed: autoAssist.shadowed, autoAssistWouldAssist: autoAssist.wouldAssist,
                    autoAssistEvidenceWhy: autoAssist.evidenceWhy, autoAssistOwnership: stance,
                    autoAssistCanQueueSupervisorInput: opts.onSupervisorInput !== undefined,
                    roundContextPresent,
                    // ⭐⭐ M5 다섯째 관문 — 경계(자식이 무엇에 막혔나). 종전엔 이 줄에 «없어서»,
                    //   한 레코드로 「지금 이 런이 어디서 걸려 있나」를 보려 해도 경계만 다른 곳을 봐야 했다.
                    //   ⛔ 부재와 0 을 가른다: 요청이 하나도 없으면 판정 세 칸을 «안 싣는다»(수만 0 으로 남는다).
                    boundaryRequests: boundaryRequestCount,
                    ...(lastBoundaryVerdict ? {
                      boundaryWouldApprove: lastBoundaryVerdict.wouldApprove,
                      boundaryEvidenceWhy: lastBoundaryVerdict.evidenceWhy,
                      boundaryRequestId: lastBoundaryVerdict.requestId,
                    } : {}),
                    ...(roundContext ? { round: roundContext.round, effectiveMax: roundContext.effectiveMax, previousRoundFailureTruncated: roundContext.previousRoundFailure.includes('[truncated: ') } : {}),
                    ...(opts.shardIdentity ? federationObservation(opts.shardIdentity) : {}),
                    ...supervisionObservation,
                  };
                  debug.log('self-implement', 'brain.suggestion', supervisionVerdictPayload);
                  debug.log('self-implement', 'run-supervision.verdict', supervisionVerdictPayload);
                  if (decision.action === 'wait') {
                    pendingWaitSupervisionCount += 1;
                    pendingWaitLatestJudgment = decision.action;
                    if (pendingWaitSupervisionCount >= WAIT_SUPERVISION_PROGRESS_BATCH_SIZE) flushWaitSupervisionProgress();
                  } else {
                    flushWaitSupervisionProgress();
                    const input = decision.action === 'input' ? decision.text.trim() : '';
                    const inputInstructionOccurrence = input ? countInputInstructionOccurrence(input) : undefined;
                    const delivery = input ? (opts.onSupervisorInput ? 'queued' : 'not-delivered') : undefined;
                    const deliveryReason = input && !opts.onSupervisorInput ? 'next-round-callback-unwired' : undefined;
                    emitSurfaceProgress(formatSupervisionProgressLine({
                      action: decision.action,
                      reason: decision.action === 'input' ? decision.text
                        : 'reason' in decision ? decision.reason
                        : `${decision.action} ${JSON.stringify({ ...decision, action: undefined })}`,
                      ...(delivery ? { delivery } : {}),
                      ...(deliveryReason ? { deliveryReason } : {}),
                      ...(inputInstructionOccurrence ? { inputInstructionOccurrence } : {}),
                    }), 'supervision');
                    if (input) opts.onSupervisorInput?.(input, (nextDelivery, nextReason) => {
                      // Delivery is determined by the already-wired orchestrator callback after the
                      // initial verdict. Record that final state on the same machine-readable event;
                      // observation remains fail-soft and cannot alter delivery or surface progress.
                      try {
                        debug.log('self-implement', 'run-supervision.verdict', {
                          ...supervisionVerdictPayload,
                          supervisionRecordStage: 'delivery-outcome',
                          delivery: nextDelivery,
                          ...(nextReason ? { deliveryReason: nextReason } : {}),
                        });
                      } catch { /* fail-soft — delivery observation must not affect the goal loop */ }
                      emitSurfaceProgress(formatSupervisionProgressLine({
                        action: 'input', reason: input, delivery: nextDelivery,
                        ...(nextReason ? { deliveryReason: nextReason } : {}),
                        ...(inputInstructionOccurrence ? { inputInstructionOccurrence } : {}),
                      }), 'supervision');
                    });
                  }
                  debug.log('self-implement', 'brain.input-outcome', {
                    ptyId: h.id, runId, step: i, axis: 'assist', action: decision.action,
                    applied: autoAssist.assist, why: autoAssist.why,
                    shadowed: autoAssist.shadowed, wouldAssist: autoAssist.wouldAssist,
                    evidenceWhy: autoAssist.evidenceWhy,
                    canReceiveInput: opts.canReceiveInput ?? false,
                    canQueueSupervisorInput: opts.onSupervisorInput !== undefined,
                  });
                  // ⛔ 이 `!stanceBlocksWrite` 를 «죽은 코드»로 보고 지우지 마라.
                  //   위에서 blockedWrite 이면 decision 이 합성 `wait` 라 autoStop.stop 이 참이 될 수 «없어»,
                  //   지금은 «도달 불가»이고 그래서 이 가드를 열어도 시험이 «안 문다»(📏 2026-08-28 실측: 225p/0f 그대로).
                  //   ⇒ 그러나 그 도달 불가는 «합성 결정이 wait 라는 사실»에 기대고 있다. 그것이 바뀌는 순간
                  //     이 한 줄이 「lost/unknown 이면 집행 안 함」의 마지막 방어가 된다. 남긴다.
                  if (autoStop.stop && !stanceBlocksWrite(stance)) {
                    debug.log('self-implement', 'brain.applied', {
                      ptyId: h.id, runId, step: i, action: decision.action, why: autoStop.why, stallRung: st?.rung ?? NO_STALL,   // stall 이 없는 tick = 확증 없음
                    });
                    timedOut = false;
                    exitReason = 'brain-stop';
                    break pollLoop;
                  }
                } catch (e) {
                  // Parent cancel outranks suggestion observation: leave the poll loop immediately so PTY cleanup is not
                  // held by the 15s consultation timeout, even when a custom brain ignores its AbortSignal.
                  if (opts.signal?.aborted) {
                    timedOut = false;
                    exitReason = 'abort';
                    break pollLoop;
                  }
                  debug.log('self-implement', 'brain.fail', {
                    ptyId: h.id, runId, step: i, trigger, state: curState,
                    roundContextPresent,
                    error: String(e instanceof Error ? e.message : e).slice(0, 120),
                  });
                } finally {
                  if (timer) clearTimeout(timer);
                  opts.signal?.removeEventListener('abort', onBrainAbort);
                }
              }
            }
            const moment = isKeyframeMoment(lastFrameState, curState);
            // ★ 상태를 PNG 시도 **전에** 갱신(review must-fix) — renderScreenPng 실패해도 같은 전이를
            //   매 주기 재시도하지 않게(비싼 sharp 재시도 폭주 차단·전이-1회 계약 보존).
            lastFrameState = curState;
            if (moment) {
              const png = await h.renderScreenPng();
              if (png) {
                const kfPath = keyframePath(runId || space.id, h.id, keyframeSeq, curState);
                if (writeKeyframePng(kfPath, png)) {
                  pngRef = kfPath;
                  debug.log('self-implement', 'keyframe-capture', { ptyId: h.id, runId, seq: keyframeSeq, state: curState, path: kfPath });
                  keyframeSeq += 1;
                }
              }
            }
          } catch (e) {
            debug.log('self-implement', 'keyframe-fail', { ptyId: h.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
          }
          // ★ G9 P3b(2026-07-25) — executor 화면을 SelfReportFrame 버스로도 발행. surfaceId=exec:<ptyId>
          //   (P3a execSurfaceId 첫 실소비자·Q1 결정적 frame↔pty) + runId(K4·run 단위 join). TUI 와 동일
          //   버스라 fleet/observatory/G5 구독자가 executor 화면을 관측·검증 접합. fail-soft(관측이 goal-loop 무해).
          try {
            publishSelfReportFrame(getChannelBus(), buildExecutorSelfReportFrame({
              ptyId: h.id, runId, rendered, at: nowMs, instance: resolveInstanceName(), pngRef,
            }));
          } catch (e) {
            // fail-soft(executor 무영향) — 단 ★제1원칙: 지속적 버스 장애가 은폐되지 않게 관측은 남긴다.
            debug.log('self-implement', 'frame-publish-fail', { ptyId: h.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
          }
          lastFrameRenderMs = nowMs;
        }
        catch { /* fail-soft — renderScreen 실패는 자식 goal-loop 을 절대 안 깨뜨림 */ }
      }
      if (delta) {
        lastOutputActivityI = i;
        lastActivityI = i; // 출력활동 = adaptive 연장 근거(무활동이면 soft 컷)
        const progress = buildPtyDeltaProgressObservation(delta);
        debug.log('self-implement', 'headless.progress', { ptyId, runId, chars: delta.length, tail: progress.tail, strippedChars: progress.strippedChars, tailTruncated: progress.tailTruncated });
        const progressFrameLines = takeProgressFrameLines(progressFrameLineBuffer, delta);
        for (const line of progressFrameLines) {
          const frame = decodeDetachedProgressFrame(line.endsWith('\r') ? line.slice(0, -1) : line);
          if (!frame) continue;
          debug.log('self-implement', 'headless.progress-frame', {
            ptyId,
            runId,
            kind: frame.kind,
            seq: frame.seq,
            ...(frame.planId === undefined ? {} : { planId: frame.planId }),
            ...(frame.stepId === undefined ? {} : { stepId: frame.stepId }),
            ...(frame.humanLine === undefined ? {} : { humanLine: frame.humanLine }),
          });
        }
      }
      // Same-grade merge: a newer child liveness `at` is activity, equal to a screen delta.
      // A stopped/stale file keeps lastSeenLivenessAt so it cannot keep extending forever.
      const merged = mergeChildLivenessHeartbeat(lastSeenLivenessAt, readChildLivenessHeartbeatAt(childLivenessPath));
      lastSeenLivenessAt = merged.lastSeenAt;
      if (merged.refresh) lastActivityI = i;
      // onProgress 는 매 poll(빈 delta 포함) — judge(part2-B)가 무활동 stall 을 판정할 수 있게.
      try { opts.onProgress?.(delta); } catch { /* fail-soft */ }
      // `screen-stall-silence` means the rendered screen has not changed for the configured stall rung, no output arrived for the grace measure, the child is alive, and no completion was declared.
      const screenSilentFor = lastOutputActivityI < 0 ? Number.POSITIVE_INFINITY : i - lastOutputActivityI;
      const heartbeatInclusiveSilentFor = lastActivityI < 0 ? Number.POSITIVE_INFINITY : i - lastActivityI;
      const stallRung = frameObs.stallRung;
      const minimumRung = opts.screenStallTermination?.minRung ?? 2;
      const screenStallTermination = decideScreenStallSilenceTermination({
        stallRung,
        silentFor: screenSilentFor,
        activityGrace: graceI,
        childAlive: h.isAlive(),
        completionDeclared: findCompletionMarkerLine(stripAnsi(snap)) !== undefined,
        enabled: opts.screenStallTermination?.enabled ?? false,
        minRung: minimumRung,
      });
      if (Number.isFinite(stallRung) && stallRung >= Math.max(0, minimumRung)) {
        debug.log('self-implement', 'screen-stall-termination.shadow', {
          ptyId, runId, step: i, silentFor: screenSilentFor, outputOnlySilentFor: screenSilentFor,
          heartbeatInclusiveSilentFor, stallRung, activityGrace: graceI,
          terminate: screenStallTermination.terminate, why: screenStallTermination.why,
          evidenceSatisfied: screenStallTermination.evidenceSatisfied, evidenceWhy: screenStallTermination.evidenceWhy,
          enabled: opts.screenStallTermination?.enabled ?? false,
        });
      }
      if (screenStallTermination.terminate) {
        timedOut = false;
        exitReason = 'screen-stall-silence';
        break;
      }
      if (!h.isAlive()) {
        timedOut = false;
        exitReason = h.exitCode === 0
          ? 'child-exit-success'
          : h.exitCode === null
            ? 'child-exit-code-unavailable'
            : 'child-exit-failure';
        break;
      }
      // ⭐ 완료 **선언**(단독 줄)만 인정한다 — 종전 `includes` 는 소스·산문 속 마커 **언급**까지
      //   완료로 오인해, 자식이 살아 일하는 중에 부모가 나갔다(2026-07-27 실측·completion-marker.ts).
      const markerLine = findCompletionMarkerLine(stripAnsi(snap));
      if (markerLine !== undefined) {                                                    // 프로세스 잔존 대비(논리적 완료)
        // 끊은 근거를 남긴다 — 오탐이 재발하면 "무엇을 마커로 봤나"가 로그 한 줄로 드러난다.
        // ⭐⭐ 그리고 **밖에서 쓴 이력**을 같이 싣는다(`RUN-S25` · 거짓 성공의 둘째 채널).
        //   ⛔ 판정은 **안 바꾼다** — 이 값이 있어도 완료로 친다. 바꾸는 것은 「사후에 셀 수 있나」뿐이다.
        //   그러지 않으면 *"운영에서 실제로 났는지"* 를 영영 못 센다(`[S]` 미결 ⓶).
        //   ⚠️ 부재(`undefined`)는 「외부 쓰기가 없었다」가 아니라 「이 프로세스가 본 것이 없다」다.
        debug.log('self-implement', 'headless.completion-declared', {
          ptyId, i, line: markerLine.trim().slice(0, 120),
          ...((opts.externalWriteProvenance ?? externalWriteProvenance)(ptyId) ?? {}),
        });
        timedOut = false; exitReason = 'completion-marker'; break;
      }
    }
    flushWaitSupervisionProgress();
    if (surfaceProgressCounts.total === 0) {
      debug.log('self-implement', 'headless.surface-progress', {
        ptyId, runId, status: 'no-surface-line', callbackWired: opts.onSurfaceProgress !== undefined,
      });
    }
    closeSelfDevRunParticipant(runId, ptyId, 'parent', selfDevRunsDir(opts.stateDir));
    phase = 'snapshot';
    const { transcript, toolCalls, chars } = transcriptMetrics(h.snapshot());
    let reachedCompletion = hasCompletionMarker(transcript) || (h.exitCode === 0 && !timedOut);
    if (opts.outputArtifactWatchdog) {
      const artifactDecision = decideOutputArtifactWatchdog({
        previous: opts.outputArtifactWatchdog.initial,
        current: opts.outputArtifactWatchdog.snapshot(),
        policy: opts.outputArtifactWatchdog.policy,
        terminalSuccess: reachedCompletion,
      });
      if (artifactDecision.kind === 'escalate-terminal-success') {
        reachedCompletion = false;
        debug.log('self-implement', 'headless.output-artifact-intervention', {
          ptyId, runId, kind: artifactDecision.kind, missing: artifactDecision.missing,
          diagnostic: artifactDecision.diagnostic, restartPacket: artifactDecision.restartPacket,
        }, { level: 'warn' });
        opts.onSupervisorInput?.(artifactDecision.restartPacket, () => {});
      }
    }
    if (exitReason === 'loop-exhausted-without-completion' && reachedCompletion) {
      exitReason = 'completion-after-loop-exhaustion';
    }
    const resultExitReason = publicExitReason(exitReason);
    // ⭐ S4 P1 종료 관측(리뷰 should-fix) — observeFrame 은 **전이 시점**에만 heldMs 를 낸다. 그래서 run 의
    //   **마지막 상태**는 전이가 없어 지속시간이 기록되지 않고, P2 가 볼 상태-지속 분포가 **우측 절단**된다
    //   (특히 "마지막에 오래 멈춘 채 끝났다" 케이스가 통째로 빠진다 — 가장 보고 싶은 것이다). 여기서 1회 낸다.
    try {
      const fin = finalizeFrameObservation(frameObs, Date.now());
      if (fin) debug.log('self-implement', 'frame-state-final', { ptyId, runId, ...fin, timedOut, reachedCompletion });
    } catch { /* fail-soft — 관측이 결과를 안 바꾼다 */ }
    // ⚠️ `markerMentionedOnly` = 마커를 **담고는 있는데 선언은 아닌** 화면 — 이 결함의 서명이다.
    //    참인 채로 `exitReason:'completion-marker'` 가 나오면 부분일치 규칙이 어딘가 되살아난 것이다.
    const screenVerdict = { exitReason: resultExitReason, timedOut, reachedCompletion };
    try {
      const target = resolveLifecycleReadTarget(
        lifecycleReportPath,
        executionId,
        lifecycleReportNonce,
        opts.readPublisherStateDir ?? readLifecycleRootReport,
      );
      let records: readonly { id: number; record: LifecycleRecord }[] = [];
      let emptyReason = target.emptyReason;
      if (target.stateDir && !emptyReason) {
        try {
          records = (opts.readLifecycle ?? readRunLifecycleFromStateDir)(target.stateDir, runId);
        } catch {
          emptyReason = 'read-failed';
        }
      }
      if (records.length === 0 && !emptyReason) emptyReason = 'no-records';
      const childState = childLifecycleState(records, executionId);
      // ⛔ 발행은 «막지 않는다» — publishParentTerminalLifecycle 자체가 관측을 낸다
      //   (`headless.parent-terminal-published` / `…-suppressed`)이고, 타임아웃·중단 시의
      //   parent-proxy terminal 을 버스 소비자가 기다린다. 호출을 통째로 건너뛰면 그 관측이 사라진다
      //   (📏 2026-08-28 실측: 그렇게 좁혔더니 lifecycle-screen-scoreboard 의
      //    "publishes failed parent-proxy terminals for timeout and abort" 가 빨개졌다).
      // ✅ 막을 것은 «기록을 지어내는 것»뿐이다 — 자식을 0건으로 읽었으면 `no-records` 가 정직한 답이다.
      try {
        const parentTerminal = publishParentTerminalLifecycle(opts.lifecycleBus ?? getChannelBus(), {
          runId,
          childPtyId: executionId,
          reachedCompletion,
          exitReason: resultExitReason,
          hasTerminal: childState.hasTerminal,
          terminalCount: childState.terminalCount,
          maxSequence: childState.maxSequence,
        });
        if (parentTerminal && records.length > 0) records = [...records, { id: Number.MAX_SAFE_INTEGER, record: parentTerminal }];
      } catch (error) {
        debug.log('self-implement', 'headless.parent-terminal-publish-fail', {
          ptyId: executionId, runId, exitReason: resultExitReason, error: errorMessage(error),
        });
      }
      const lifecycleScoreboard = compareLifecycleToScreen(screenVerdict, records, {
        runId,
        subjectPtyId: executionId,
        availability: target.stateDir && (emptyReason === undefined || emptyReason === 'no-records') ? 'available' : 'unavailable',
        childExited: h.exitCode !== null,
      });
      debug.log('self-implement', 'headless.lifecycle-screen-scoreboard', {
        runId,
        ...lifecycleScoreboard,
        lifecycleRead: { source: target.source, emptyReason: emptyReason ?? null },
      });
      opts.onLifecycleScreenClassification?.(lifecycleScoreboard.classification);
    } catch {
      // A delivered classification changes orchestrator.ts effectiveOutcome in run-status and run-rollup,
      // and blocks canAuto; only scoreboard comparison, serialization, or logging failures are ignored here.
    }
    emitDone({
      ptyId, reachedCompletion, timedOut, exitReason, exit: h.exitCode, toolCalls, chars,
      markerMentionedOnly: mentionsMarkerWithoutDeclaring(transcript),
    });
    return { ok: true, reachedCompletion, transcript, toolCalls, timedOut, exitReason: resultExitReason, exitCode: h.exitCode, ptyId };
  } catch (error) {
    emitDone({
      ptyId, reachedCompletion: false, timedOut: false,
      exitReason: phase === 'snapshot' ? 'snapshot-error' : 'poll-error',
      exit: h.exitCode, toolCalls: 0, chars: 0, error: errorMessage(error),
    });
    throw error;
  }
  } catch (error) {
    const exitReason: HeadlessDoneExitReason = phase === 'probe'
      ? 'pty-probe-error'
      : phase === 'spawn'
        ? 'spawn-error'
        : phase === 'initialization'
          ? 'initialization-error'
          : 'poll-error';
    emitDone({
      reachedCompletion: false, timedOut: false, exitReason,
      exit: spawned ? h.exitCode : null, toolCalls: 0, chars: 0, error: errorMessage(error),
    });
    throw error;
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    try { stopBoundaryRequestsWatch?.(); } catch { /* observation is fail-soft */ }
    if (spawned) try { h.kill(); } catch { /* fail-soft */ }
    removeLifecycleRootReport(lifecycleReportPath);
  }
}
