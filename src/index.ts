#!/usr/bin/env bun
// cron/launchd 최소 PATH 에서도 내부 gh/git subprocess 를 찾도록 PATH 를 먼저 보강(무음실패 근본·2026-07-25).
import './ensure-bin-path.js';
import { WORKFLOW_NODE_VARIANT_KEYS } from './workflow-runtime/schema.js';
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import type { SelfDevRunParticipant, SelfDevRunState } from './self-dev/run-store.js';
import { applyConfigDirFlagFromArgv } from './cli/config-dir-flag.js';
import { LOGS_SINCE_OPTION, registerLogsCommands } from './cli/logs-cli.js';
import { registerDocsCommands } from './cli/docs-cli.js';
import { registerA2ACommands } from './cli/a2a-cli.js';
import { registerPluginCommands } from './cli/plugin-cli.js';
import { registerFleetCommands } from './cli/fleet-cli.js';
import { readPipedStdin } from './cli/piped-stdin.js';
import { writeStdoutJson } from './cli/stdout-json.js';
import { writeStdoutFully } from './cli/stdout-flush.js';
// ⛔ 도움말이 접두를 «다시 리터럴로» 복제하면 상수와 갈린다(무인 리뷰 should-fix) ⇒ 상수에서 만든다.
import { WORKTREE_BRANCH_PREFIX as WORKTREE_BRANCH_PREFIX_HELP } from './harness/worktree-branch-prefix.js';
import { ensureRunIdentity, getHarnessSpace, normalizeSpaceId } from './harness/harness-space.js';
// ★ B1 — ⛔ 가드는 dev 액션의 «첫 비동기 작업보다 앞»에 서야 한다. 동적 import 로 가져오면
//   그 import 자체가 첫 비동기 작업이 되어, 그것이 거부되면 가드 없이 끝난다(무인 리뷰 must-fix).
//   ⇒ «정적» import 로 올린다. 이 모듈은 부작용이 없어 부팅 비용이 사실상 0 이다.
import { installDevCompletionGuard } from './self-dev/dev-completion-guard.js';
import { buildOrchestrateDecomposePrepareArgs, normalizeOrchestrateRequest, splitOrchestrateGoalTexts } from './self-dev/self-orchestrate-runtime.js';
import { CLI_ENTRANCE_BASELINE, evaluateCommandEntranceBaseline } from './self-dev/entrance-baseline.js';
import { CLI_HARNESS_DOGFOOD_ENTRANCE, CLI_HARNESS_ORCHESTRATE_ENTRANCE, describeEntranceCommand, listEntrancesWithModelExposure, renderLaunchEntrances, summarizeEntrances, type EntranceId } from './self-dev/entrance-registry.js';
import { collectCommandEntrances, renderCommandEntrances } from './self-dev/entrance-inventory.js';
import { isGoalAuthorFileName } from './self-implement/goal-document.js';
import { DEV_PIPELINE_SINK_SURFACE } from './self-implement/self-cli-sink-surface.js';
import { registerPrivateLedgerCommands } from './cli/private-ledger-commands.js';
import { applyTestStateDirFlagFromArgv } from './cli/test-state-dir-flag.js';
import { applyTestFlagFromArgv, observeTestFlagOwnership, uncoveredTestFlagPaths, staleTestFlagPaths } from './cli/test-flag.js';
import { registerPtyTakeoverCommands } from './cli/pty-takeover-cli.js';
import { registerPtyRecordCommand } from './cli/pty-record-cli.js';
import { registerLeaderCommands } from './cli/leader-cli.js';
import { registerPrCommands } from './cli/pr-cli.js';
import { registerRepoCommands } from './cli/repo-cli.js';
import { registerAgentCommands, runChatTurnCli, emitDetachedProgress } from './cli/agent-cli.js';
export { runChatTurnCli, buildCliAgentTools, setCliAgentDispatchForTesting, emitDetachedProgress, emitHarnessFeedbackProgress } from './cli/agent-cli.js';
import { registerOpsCommands } from './cli/ops-cli.js';
import { registerPublishCommands } from './cli/publish-cli.js';
import { registerAutopilotCommands } from './cli/autopilot-cli.js';
import { registerRoleCommands } from './cli/role-cli.js';
import { registerMachineCommands } from './cli/machine-cli.js';
import { registerScheduleCommands } from './cli/schedule-cli.js';
export { runSchedule, scheduleCreatePlan } from './cli/schedule-cli.js';
export type { ScheduleDispatch } from './cli/schedule-cli.js';
import { registerReviewLoopOptions, buildReviewLoopOpts } from './agent-mission/review-loop-cli.js';
import { registerCapabilitiesCommand } from './agent-mission/capabilities-cli.js';
import { agentBackendNames } from './agent-mission/driver.js';
import { registerWhereCommand } from './cli/where-cli.js';
import { registerShadowCommand } from './cli/shadow-cli.js';
import { registerLlmDetectCommand } from './cli/llm-detect-cli.js';
import { registerStorageDetectCommand } from './cli/storage-cli.js';
import { registerPodCommands } from './cli/pod-cli.js';
import { registerBrowserAnnotateCommand } from './cli/browser-annotate-cli.js';
import { registerPendingQuestionsCommand } from './cli/pending-questions-cli.js';
import { registerUsageCommand } from './cli/usage-cli.js';
import { registerLiveCommands } from './cli/live-cli.js';
import { registerResearchCommand } from './cli/research-cli.js';
import { registerReleaseCommands } from './cli/release-cli.js';
import { registerModelWatchCommand } from './cli/model-watch-cli.js';
import { registerIntakeCommands } from './cli/intake-cli.js';
import { registerTasksCommands } from './cli/tasks-cli.js';
import { registerLabelsCommands } from './cli/labels-cli.js';
import { registerMsgCommands } from './cli/msg-cli.js';
import { registerDoctorCommand } from './cli/doctor-cli.js';
import { registerProviderCommands } from './cli/provider-cli.js';
export { buildCodexAccountImportGuidance, setCodexAccountLogSinkModuleForTesting } from './cli/provider-cli.js';
import { registerControlCommands } from './cli/control-cli.js';
import { registerHooksCommands } from './cli/hooks-cli.js';
import { registerSetupCommand } from './cli/setup-cli.js';
import { registerStartCommand } from './cli/start-cli.js';
import { registerGroundingSourcesCli } from './grounding/sources-cli.js';
import { registerGraphCommands } from './graph-runner/graph-cli.js';
import { registerLoopCommands } from './loops/loop-cli.js';
import { registerCardCommand } from './task-cards/card-cli.js';
import { registerLaunchHeadCommands } from './launch-head/launch-head-cli.js';
import { acpServerHelpText } from './boot/acp-server-help.js';
// IMPORTANT: parse `--config-dir <dir>` + `--test-state-dir <dir>`
// BEFORE Commander loads — the resolvers are read at module-init
// time by several config-touching imports below, so the override
// has to be live before they fire. `--test-state-dir` is an internal
// flag bg-launch'd children receive to inherit the parent's
// `setTestStateRoot()` (replaces the removed ELANOUS_NEXUS_DIR env
// inheritance · 2026-05-13 config-dir-unify).
applyTestStateDirFlagFromArgv();
// ★ 전역 `--test` (P2 · 2026-07-26) — 사람/에이전트용 공개 입구. 위 두 내부 플래그와 같은
//   격리 기계(applyIsolatedRoot)를 부른다. `--test` 를 스스로 선언한 명령은 그 명령이 계속
//   소유하므로 여기서 손대지 않는다(OWNED_TEST_FLAG_PATHS · ratchet 테스트가 강제).
applyTestFlagFromArgv();
// An explicit caller-supplied config directory must take precedence over the
// test-instance default so scoped storage commands stay inside that directory.
applyConfigDirFlagFromArgv();

import { Command, Option } from 'commander';
import type { AdPipelinePlan, AdPipelineResult } from './ad-pipeline/run.js';
import type { AcpPermissionApprover } from './acp/client.js';
import { runGitCommand } from './git-fs/runner.js';
import { debug, redactSecretText, redactSecrets } from './debug/log.js';
import { installHarnessCliCommand, type HarnessAskSayChildLlmOptions, type HarnessAskSayOptions, type HarnessPlanOptions } from './harness/harness-cli-command.js';
import { formatCliUserError, isCliUserError } from './cli/cli-user-error.js';
import { dispatchSolveMission } from './skills/tools/solve-mission.js';
import { performBrowserAction, type BrowserActionDeps, type BrowserActionResult } from './harness/browser-act.js';
import { decideTypeAction, type TypeActionDecision, type TypeTarget } from './harness/browser-act-type.js';
import { resolveSelfSendTarget } from './harness/self-send-target.js';
import { awaitGlobalPersonaLoad, describeMissingPersona, getGlobalPersonaRegistry } from './persona/global-registry.js';
import { HARNESS_RUN_DEPRECATION_HELP } from './self-dev/harness-run-cli.js';
import { DEV_PLAN_REPLACEMENT, formatDevPlanOptionHelp } from './self-dev/dev-cli.js';
import type { InventoryMeta, SortKey } from './llm/local-manager/benchmark/scores.js';
import { syncServers, SERVICE_NAMES } from './config.js';
import { getLocalSkills, executeSync } from './sync.js';
import { showSyncSelector, showSyncProgress } from './selector.js';  // kept for CLI sync subcommand
import { inspectRemote } from './inspect.js';
import { showRecentHistory, showSessionDetail, showSkillDetail, showTargetDetail, showStatus } from './history.js';
import { showDashboard } from './dashboard/index.js';
import { initTui, closeTui } from './tui.js';
import * as ui from './ui.js';
import { DEFAULT_REVIEW_BACKEND } from './agent-substrate/acp-reviewer.js';
import type { ReviewResult } from './agent-substrate/pr-reviewer.js';
import type { ReviewVerdict } from './agent-mission/review-loop.js';
import type { SyncMode } from './types.js';
import { runOnboarding, runOnboardingStep, runOnboardingNonInteractive, needsOnboarding, handleOnboardingRefusal, type OnboardingStepId } from './onboarding.js';
import {
  getUserConfig, reloadUserConfig, userConfigPath, saveUserConfig,
  backupUserConfig, backupConfigPath, addRotationEntry, type RotationEntry,
  resolveRoleLlm,
} from './user-config.js';
import { reviewReasoningEffort } from './model-tier/review-effort.js';
import { isKeylessProvider, resolveProviderCredential } from './llm/provider-credentials.js';
import {
  listSessions, loadSession, deleteSession, resolveSessionId,
  setActiveSessionId, getActiveSessionId,
  lastConversationMessage, isSessionSource,
} from './session/index.js';
import { requestSessionTurnControl } from './session/session-turn-control.js';
import { ensureCliSession, sessionBudget } from './session/chat.js';
import { botFromConfig, TelegramBot } from './telegram.js';
import { acquireTelegramLock, TelegramLockError, defaultLockPath, safeReadLock } from './telegram-lock.js';
import { basename, join as _joinPath, resolve } from 'node:path';
import * as nodeReadline from 'node:readline/promises';
import { stdin as procStdin, stdout as procStdout } from 'node:process';

/** ⛔⭐⭐ **되돌림 지뢰**(`[T]` 실측 2026-08-07) — 지금 **부르는 데가 없다**(정의 한 줄뿐).
 *  위험은 죽은 코드라는 점이 아니라, ***누군가 「이미 있으니」 하고 자식 경로 폴백에 배선하는 순간
 *  `canReceiveInput: false` 계약이 «조용히» 거짓이 된다***는 데 있다
 *  (`self-implement/headless-elanous-driver.ts` 의 `canReceiveInput` 주석이 그 계약의 canonical).
 *  ⇒ 배선하려면 그 계약을 «같이» 고쳐라. 아니면 지워라. */
async function readStdinLine(prompt: string = ''): Promise<string> {
  // Pass the prompt directly to rl.question so readline's terminal
  // initialization renders it atomically. Writing to stdout ourselves
  // before readline starts lets TTY mode repaint over it, which is how
  // a `Proceed? [y/N]` prompt ended up invisible to the caller.
  const rl = nodeReadline.createInterface({ input: procStdin, output: procStdout, terminal: procStdin.isTTY });
  try { return await rl.question(prompt); }
  finally { rl.close(); }
}
import { loginWithCodex, CODEX_DEVICE_LOGIN_URL } from './oauth/codex.js';
import { authStorePath, loadTokens, deleteTokens, saveTokens, listProviders as listAuthProviders, type CodexMirrorResult } from './oauth/store.js';
import { renderKeyHelp, CONTEXT_LABELS, type KeyContext } from './keybindings.js';
import { auditKeybindings, renderKeymapAudit } from './keymap-audit.js';
import { runCodexSetup } from './codex/setup.js';
import { renderAllModels } from './codex/models.js';
import { realIO } from './onboarding.js';
import { inspectActiveProvider, oneLineProvider } from './provider-summary.js';
import { renderStatusLines, renderPrimaryStatus, renderSecondaryStatus } from './status/bar.js';
import { initSessionWorkingDir } from './session/working-dir.js';
import { rewriteBareNexusToStatus } from './cli/nexus-entry.js';
import { registerIngestTokenCommands } from './cli/ingest-token-cli.js';
import { registerMcpGatewayCommands } from './cli/mcp-gateway-cli.js';
import { registerRelayCommand } from './relay/relay-cli.js';
import type { ReviewImage } from './agent-substrate/pr-reviewer.js';
import {
  describeMissionRouting,
  setMissionEntry,
  resetMissionEntry,
  setMissionMode,
} from './cli/mission-config.js';
import { DEFAULT_THEME_TOKENS, resolveThemeTokens } from './theme/tokens.js';
import { conatusPath } from './domains/conatus-data-dir.js';
import {
  saveMemory, loadMemory, listMemories, deleteMemory, searchMemories,
  readIndex, memoryRoot, memoryIndexPath,
  type MemoryType,
} from './memory.js';

/** 원본 전용 봇랩 도구 — 공개본엔 없다(release/public-export.yaml · scripts/botlab/**). */
const BOTLAB_STATE_PATHS_MODULE: string = '../scripts/botlab/botlab-state-paths.js';
const REPOSITORY_ROOT = resolve(import.meta.dir, '..');

function resolveCliDirOption(dir: string): string {
  return resolve(process.cwd(), dir);
}

import { cliVersion, setInstallMetadataRootForTesting } from './version/code-revision.js';
export { cliVersion, setInstallMetadataRootForTesting };

export const program = new Command();
program.enablePositionalOptions();

export { SELF_SEND_RECENT_FRAME_WINDOW_MS, SELF_SEND_STALE_HEARTBEAT_MS, formatSelfSendCandidateDisplay } from './harness/self-send-decide.js';
export type { SelfSendCandidate, SelfSendCandidateDisplay } from './harness/self-send-decide.js';
import { decideSelfSend, type SelfSendCandidate } from './harness/self-send-decide.js';
type RunDevAskBuildDevCliSpec = typeof import('./self-dev/dev-cli.js')['buildDevCliSpec'];
type RunDevAskExecuteDevSelfRun = typeof import('./self-dev/dev-cli.js')['executeDevSelfRun'];
type RunDevAskStartDraftTriage = typeof import('./self-dev/dev-cli.js')['startDraftTriage'];
type RunDevAskStartDraftTriageOptions = Parameters<RunDevAskStartDraftTriage>[1];
type RunDevAskAssertDevCliPathOptions = typeof import('./self-dev/dev-cli.js')['assertDevCliPathOptions'];
type RunDevAskSelectDevAuthorInput = typeof import('./self-dev/dev-cli.js')['selectDevAuthorInput'];
type RunDevAskRunDevPipeline = typeof import('./self-dev/dev-pipeline.js')['runDevPipeline'];
type RunDevAskDevResultOk = typeof import('./self-dev/dev-pipeline.js')['devResultOk'];
type RunDevAskFlowResult = Awaited<ReturnType<typeof import('./self-dev/ask-launch-flow.js')['runAskLaunchFlow']>>;
type RunDevAskRenderDevCompletionLine = typeof import('./self-dev/dev-cli.js')['renderDevCompletionLine'];
type RunDevAskDecideAskPreflight = typeof import('./self-dev/launch-preflight.js')['decideAskPreflight'];
type RunDevAskPrepareAskLaunch = typeof import('./self-dev/launch-preflight.js')['prepareAskLaunch'];
type RunDevAskRenderLaunchPreflight = typeof import('./self-dev/launch-preflight.js')['renderLaunchPreflight'];
type RunDevAskBuildAskPreflightDeps = typeof import('./self-dev/ask-launch-io.js')['buildAskPreflightDeps'];
type RunDevAskMeasureInvokerBehindDefaultBranch = typeof import('./self-dev/ask-launch-flow.js')['measureInvokerBehindDefaultBranch'];
type RunDevAskRecommendLaunchDecomposition = typeof import('./self-dev/ask-launch-flow.js')['recommendLaunchDecomposition'];

interface RunDevAskDevCliExports {
  buildDevCliSpec: RunDevAskBuildDevCliSpec;
  executeDevSelfRun?: RunDevAskExecuteDevSelfRun;
  startDraftTriage: RunDevAskStartDraftTriage;
  startDraftTriageOptions?: RunDevAskStartDraftTriageOptions;
  assertDevCliPathOptions: RunDevAskAssertDevCliPathOptions;
  selectDevAuthorInput: RunDevAskSelectDevAuthorInput;
  renderDevCompletionLine: RunDevAskRenderDevCompletionLine;
}

interface RunDevAskFromGoalFileDeps {
  loadDevCli: () => Promise<RunDevAskDevCliExports>;
  loadDevPipeline: () => Promise<{ runDevPipeline: RunDevAskRunDevPipeline; devResultOk: RunDevAskDevResultOk }>;
  loadLaunchPreflight: () => Promise<{
    decideAskPreflight: RunDevAskDecideAskPreflight;
    prepareAskLaunch: RunDevAskPrepareAskLaunch;
    renderLaunchPreflight: RunDevAskRenderLaunchPreflight;
  }>;
  loadAskLaunchIo: () => Promise<{ buildAskPreflightDeps: RunDevAskBuildAskPreflightDeps }>;
  loadAskLaunchFlow: () => Promise<{
    measureInvokerBehindDefaultBranch: RunDevAskMeasureInvokerBehindDefaultBranch;
    recommendLaunchDecomposition: RunDevAskRecommendLaunchDecomposition;
  }>;
  runSayLaunchFlow: (
    sayText: string,
    entrance?: import('./self-dev/entrance-registry.js').EntranceDeclaration,
    selection?: { readonly forcePreflight?: boolean; readonly goalType?: import('./self-implement/goal-author.js').GoalType; readonly groundingCwd?: string },
  ) => Promise<RunDevAskFlowResult>;
  runAskFileLaunchFlow: (
    askPath: string,
    selection?: { readonly forcePreflight?: boolean; readonly goalType?: import('./self-implement/goal-author.js').GoalType; readonly groundingCwd?: string },
  ) => Promise<RunDevAskFlowResult>;
  print: (line: string) => void;
  cwd: () => string;
  setExitCode: (code: number) => void;
}

/** 세 ask 발사 경로가 같이 쓰는 전제 검사·분해 정책.
 *  플래그 없음 = `dev` 기본과 같다: 전제 검사가 막으면 막히고, 발사 전 분해는 켜진다. */
export function assembleAskLaunchPolicy(selection: {
  readonly forcePreflight?: boolean;
  readonly launchDecomposition?: boolean;
} = {}): {
  readonly forceRequested: boolean;
  readonly decomposeBeforeLaunch: boolean;
} {
  return {
    forceRequested: selection.forcePreflight === true,
    decomposeBeforeLaunch: selection.launchDecomposition !== false,
  };
}

/** ⛔⭐⭐ 이 흐름은 ***`elanous harness say` 전용***이다(`dev --say` 는 :6199 의 «다른» 자리를 쓴다).
 *  📏 2026-08-23 실측: 그래서 한 발사가 ***두 이름***을 남겼다 —
 *    저작 단계(`ask-launch`·`harness.entrance`)는 `cli-dev-ask` · 발사 단계(`selection`)만 `cli-harness-say`.
 *  🔑 ⇒ ***「그 문이 몇 번 쓰였나」를 저작 축에서 세면 «남의 계정»으로 흐른다.***
 *  ⚠️ 각인이 «틀린 이름」이면 그 이름으로 능력 판정도 돈다(`OBS-T78`) — 여기선 저작 축이라
 *    권한에 안 닿지만, ***관측이 갈리지 않는 것 자체가 결손***이다. */
async function runDefaultSayLaunchFlow(
  sayText: string,
  entrance?: import('./self-dev/entrance-registry.js').EntranceDeclaration,
  selection: { readonly forcePreflight?: boolean; readonly goalType?: import('./self-implement/goal-author.js').GoalType; readonly groundingCwd?: string } = {},
): Promise<RunDevAskFlowResult> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const [flowMod, { runGoalAuthorCli }, { relative: relativeToCwdPath }, { CLI_HARNESS_SAY_ENTRANCE }] = await Promise.all([
    import('./self-dev/ask-launch-flow.js'),
    import('./self-implement/goal-author-cli.js'),
    import('node:path'),
    import('./self-dev/entrance-registry.js'),
  ]);
  const authoringEntrance = entrance ?? CLI_HARNESS_SAY_ENTRANCE;
  const askIo = await import('./self-dev/ask-launch-io.js');
  const askLogRows = await askIo.readAskPreflightLogRows();
  const askLaunchPrep = (await import('./self-dev/launch-preflight.js')).prepareAskLaunch(
    { kind: 'say', value: sayText },
    {},
  );
  return flowMod.runAskLaunchFlow({
    entrance: authoringEntrance,
    inputSource: 'say',
    askText: sayText,
    liveRunWindowMinutes: askLaunchPrep.liveRunWindowMinutes,
    recentChangeWindowDays: askLaunchPrep.recentChangeWindowDays,
    ...assembleAskLaunchPolicy(selection),
    ...(selection.goalType === undefined ? {} : { goalType: selection.goalType }),
    ...(selection.groundingCwd === undefined ? {} : { groundingCwd: selection.groundingCwd }),
  }, {
    print: (line) => console.error(line),
    log: (event, data, level) => debug.log('dev-pipeline', event, data, { level }),
    readLine: (prompt) => readStdinLine(prompt),
    readFile: (file) => readFileSync(file, 'utf8'),
    writeFile: (file, data) => writeFileSync(file, data, 'utf8'),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    buildPreflightDeps: askIo.buildAskPreflightDeps,
    priorBlockSamples: () => askIo.priorBlockSamplesFrom(askLogRows),
    recentAuthoringSamples: () => askIo.recentAuthoringSamplesFrom(askLogRows),
    authorGoal: (args, options) => runGoalAuthorCli([...args], options as never),
    relativeToCwd: (file) => relativeToCwdPath(process.cwd(), file),
  });
}

/** ⛔⭐ `harness ask` 의 저작 전 파일 갈래 — `dev --ask` 와 «같은» `runAskLaunchFlow` 를 쓴다.
 *  새 저작 경로가 아니다. I/O 조립만 `harness say` 기본 흐름과 대칭이다. */
async function runDefaultAskFileLaunchFlow(
  askPath: string,
  selection: { readonly forcePreflight?: boolean; readonly goalType?: import('./self-implement/goal-author.js').GoalType; readonly groundingCwd?: string } = {},
): Promise<RunDevAskFlowResult> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const [flowMod, { runGoalAuthorCli }, { relative: relativeToCwdPath }, { CLI_HARNESS_ASK_ENTRANCE }] = await Promise.all([
    import('./self-dev/ask-launch-flow.js'),
    import('./self-implement/goal-author-cli.js'),
    import('node:path'),
    import('./self-dev/entrance-registry.js'),
  ]);
  const askText = readFileSync(askPath, 'utf8');
  if (!askText.trim()) throw new Error('--ask 파일 입력이 비었다');
  const askIo = await import('./self-dev/ask-launch-io.js');
  const askLogRows = await askIo.readAskPreflightLogRows();
  const askLaunchPrep = (await import('./self-dev/launch-preflight.js')).prepareAskLaunch(
    { kind: 'ask', value: askPath },
    {},
  );
  return flowMod.runAskLaunchFlow({
    entrance: CLI_HARNESS_ASK_ENTRANCE,
    inputSource: 'ask',
    askText,
    askFile: askPath,
    liveRunWindowMinutes: askLaunchPrep.liveRunWindowMinutes,
    recentChangeWindowDays: askLaunchPrep.recentChangeWindowDays,
    ...assembleAskLaunchPolicy(selection),
    ...(selection.goalType === undefined ? {} : { goalType: selection.goalType }),
    ...(selection.groundingCwd === undefined ? {} : { groundingCwd: selection.groundingCwd }),
  }, {
    print: (line) => console.error(line),
    log: (event, data, level) => debug.log('dev-pipeline', event, data, { level }),
    readLine: (prompt) => readStdinLine(prompt),
    readFile: (file) => readFileSync(file, 'utf8'),
    writeFile: (file, data) => writeFileSync(file, data, 'utf8'),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    buildPreflightDeps: askIo.buildAskPreflightDeps,
    priorBlockSamples: () => askIo.priorBlockSamplesFrom(askLogRows),
    recentAuthoringSamples: () => askIo.recentAuthoringSamplesFrom(askLogRows),
    authorGoal: (args, options) => runGoalAuthorCli([...args], options as never),
    relativeToCwd: (file) => relativeToCwdPath(process.cwd(), file),
  });
}

const defaultRunDevAskFromGoalFileDeps: RunDevAskFromGoalFileDeps = {
  loadDevCli: async () => import('./self-dev/dev-cli.js'),
  loadDevPipeline: async () => import('./self-dev/dev-pipeline.js'),
  loadLaunchPreflight: async () => import('./self-dev/launch-preflight.js'),
  loadAskLaunchIo: async () => import('./self-dev/ask-launch-io.js'),
  loadAskLaunchFlow: async () => import('./self-dev/ask-launch-flow.js'),
  runSayLaunchFlow: runDefaultSayLaunchFlow,
  runAskFileLaunchFlow: runDefaultAskFileLaunchFlow,
  print: (line) => console.error(line),
  cwd: () => process.cwd(),
  setExitCode: (code) => { process.exitCode = code; },
};

let runDevAskFromGoalFileDeps: RunDevAskFromGoalFileDeps = defaultRunDevAskFromGoalFileDeps;

const passThroughHarnessSupervisorForTesting = (async (
  _input: string,
  _rerun: () => Promise<unknown>,
  _options: unknown,
  initial: unknown,
) => ({ result: initial })) as RunDevAskExecuteDevSelfRun;

type RunDevAskFromGoalFileTestDeps = Omit<Partial<RunDevAskFromGoalFileDeps>, 'loadDevCli'> & {
  readonly loadDevCli?: () => Promise<Partial<RunDevAskDevCliExports>>;
};

export function setRunDevAskFromGoalFileDepsForTesting(deps: RunDevAskFromGoalFileTestDeps | undefined): void {
  if (deps === undefined) {
    runDevAskFromGoalFileDeps = defaultRunDevAskFromGoalFileDeps;
    return;
  }
  const { loadDevCli: loadDevCliOverride, ...rest } = deps;
  runDevAskFromGoalFileDeps = {
        ...defaultRunDevAskFromGoalFileDeps,
        ...rest,
        ...(loadDevCliOverride === undefined ? {} : {
          loadDevCli: async (): Promise<RunDevAskDevCliExports> => {
            const defaults = await defaultRunDevAskFromGoalFileDeps.loadDevCli();
            const overrides = await loadDevCliOverride();
            return {
              ...defaults,
              executeDevSelfRun: passThroughHarnessSupervisorForTesting,
              ...overrides,
            };
          },
        }),
      };
}

export type DevPipelineInvocation =
  | { kind: 'initial' }
  | { kind: 'supervisor-relaunch'; relaunch?: boolean }
  | { kind: 'fragment-reexecution'; pieceFeature: string; base?: string };

export function executeDevPipelineInvocation<T>(
  executePipeline: (pieceFeature?: string, relaunch?: boolean, base?: string) => Promise<T>,
  invocation: DevPipelineInvocation,
): Promise<T> {
  if (invocation.kind === 'supervisor-relaunch') return executePipeline(undefined, invocation.relaunch);
  if (invocation.kind === 'fragment-reexecution') return executePipeline(invocation.pieceFeature, undefined, invocation.base);
  return executePipeline();
}

async function executeHarnessSelfRun(
  input: string,
  supervisor: Pick<HarnessAskSayOptions, 'supervise' | 'supervisorSource'>,
  executeDevSelfRun: RunDevAskExecuteDevSelfRun | undefined,
  executePipeline: (pieceFeature?: string, relaunch?: boolean, base?: string) => ReturnType<RunDevAskRunDevPipeline>,
  runId: string,
  startDraftTriage: typeof import('./self-dev/dev-cli.js')['startDraftTriage'],
  startDraftTriageOptions?: RunDevAskStartDraftTriageOptions,
): Promise<Awaited<ReturnType<RunDevAskRunDevPipeline>>> {
  startDraftTriage(runId, startDraftTriageOptions);
  // 정지 요청의 «신선도» 기준 — 첫 런 «전»에 잰다(첫 런 도중의 정지도 이 호출의 것이다).
  const invocationStartedAtMs = Date.now();
  const initial = await executeDevPipelineInvocation(executePipeline, { kind: 'initial' });
  if (initial.kind !== 'self') return initial;
  debug.log('harness.supervisor', 'resolved', {
    supervise: supervisor.supervise === true,
    supervisorSource: supervisor.supervisorSource,
  });
  const supervised = await executeDevSelfRun!(input, async (relaunch) => {
    const rerun = await executeDevPipelineInvocation(executePipeline, { kind: 'supervisor-relaunch', relaunch });
    if (rerun.kind !== 'self') throw new Error(`harness supervisor: self 재실행이 예상 밖 dispatch(kind=${rerun.kind})를 반환`);
    return rerun.result;
  }, supervisor.supervise === true
    ? {
        invocationStartedAtMs,
        completion: initial.plan.completion,
        executePiece: async (pieceFeature, opts) => {
          const rerun = await executeDevPipelineInvocation(executePipeline, {
            kind: 'fragment-reexecution', pieceFeature, ...(opts?.base === undefined ? {} : { base: opts.base }),
          });
          if (rerun.kind !== 'self') throw new Error(`harness supervisor: piece 재실행이 예상 밖 dispatch(kind=${rerun.kind})를 반환`);
          return rerun.result;
        },
      }
    : undefined, initial.result);
  return {
    ...initial,
    result: supervised.result,
    ...(supervised.supervisorStopReason ? { supervisorStopReason: supervised.supervisorStopReason } : {}),
  };
}

/** ⭐ 하니스 입구(`harness ask` · `harness say`)의 «완료 요약 한 줄».
 *
 *  ⛔⭐⭐ **왜 여기 있나 — 종전엔 이 줄이 «`dev` 명령 핸들러 안에만» 있었다.**
 *    📏 실측 2026-08-22: `renderDevCompletionLine` 의 프로덕션 호출자 «1»(src/index.ts, dev 핸들러).
 *    ⇒ 그래서 `harness ask` 로 돈 미션은 `[self-implement:pr-opened] …` 에서 «끝»났고,
 *      사람이 `outcome` · `merged-into` · `run id` · ***병합 생략 이유***를 하나도 못 봤다.
 *      그리고 그것이 실제로 막았다 — 리뷰 pass 뒤 draft PR 에서 멎은 런의 «이유»를 못 읽었다.
 *
 *  ⛔⭐ **던진 경우엔 이 줄을 «만들지 않는다».**
 *    골 초안은 *"실패해도 그 줄은 나온다"* 였는데, 그러려면 `runId: 'unknown'` 을 «지어내야» 한다.
 *    그것은 이 저장소가 금지하는 것이다 — ***못 얻은 값을 그럴듯한 기본값으로 접지 않는다.***
 *    ⊕ 던진 경우는 `harness-cli-command.ts` 의 `❌ <한 줄>`(#11437)이 이미 «덮는다».
 *    ⇒ 즉 결과가 «있을 때만» 요약하고, 없을 때는 이미 있는 오류 한 줄에 맡긴다.
 */
async function printHarnessCompletionLine(
  result: Awaited<ReturnType<RunDevAskRunDevPipeline>>,
  ok: boolean,
): Promise<void> {
  if (result.kind === 'plan-staged') {
    console.log(result.result.output);
    return;
  }
  // ⛔⭐ self 갈래만 «진짜 runId» 를 갖는다. 다른 갈래는 그 값이 «없고», 지어내지 않는다.
  if (result.kind !== 'self') return;
  const { renderDevCompletionLine } = await runDevAskFromGoalFileDeps.loadDevCli();
  console.log(renderDevCompletionLine({
    kind: result.kind,
    ok,
    runId: result.result.runId,
    base: result.plan.base,
    result: result.result,
  }));
}

function harnessAskSayOptionsToDevCliOpts(opts: HarnessAskSayOptions & {
  childLlmProvider?: string;
  childLlmModel?: string;
  childLlmEffort?: string;
  correlation?: string;
  roleLlm?: string[];
  graph?: boolean;
}): {
  json?: boolean;
  base?: string;
  autoMerge?: boolean;
  mergeByHost?: boolean;
  observeOnly?: boolean;
  supervise?: boolean;
  childLlmProvider?: string;
  childLlmModel?: string;
  childLlmEffort?: string;
  correlation?: string;
  target?: string;
  yes?: boolean;
  roleLlm?: string[];
  graph?: boolean;
} {
  return {
    ...(opts.json ? { json: true } : {}),
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.autoMerge === false ? { autoMerge: false } : {}),
    ...(opts.mergeByHost === true ? { mergeByHost: true } : {}),
    ...(opts.observeOnly ? { observeOnly: true } : {}),
    ...(opts.forcePreflight === true ? { forcePreflight: true } : {}),
    ...(opts.childLlmProvider !== undefined ? { childLlmProvider: opts.childLlmProvider } : {}),
    ...(opts.childLlmModel !== undefined ? { childLlmModel: opts.childLlmModel } : {}),
    // ⛔⭐⭐ 🩸 2026-09-12 — ***이 통로가 «둘째»였다.*** `#17765` 로 CLI 이음매를 고쳤는데도
    //    effort 가 «여전히» 안 실렸다 — ***같은 병이 한 칸 더 있었다.***
    //    🔑 [S] 의 ⑤(형태는 옳고 통로가 안 나른다)가 ***한 축에 «두 번»*** 있을 수 있다.
    //    ⇒ ⛔ 「통로를 고쳤다」가 아니라 ***「끝까지 흐르나」를 «실물»로 봐야 한다***(해석 줄).
    ...(opts.childLlmEffort !== undefined ? { childLlmEffort: opts.childLlmEffort } : {}),
    ...(opts.correlation !== undefined ? { correlation: opts.correlation } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.yes === true ? { yes: true } : {}),
    ...(Array.isArray(opts.roleLlm) && opts.roleLlm.length > 0 ? { roleLlm: opts.roleLlm } : {}),
  };
}

function resolveAskGroundingCwd(target: string | undefined, cwd: string): { groundingCwd?: string; warning?: string } {
  if (target === undefined || target === 'self') return {};
  const resolved = resolve(cwd, target);
  try {
    if (!statSync(resolved).isDirectory()) return { warning: `${resolved} is not a directory` };
    return { groundingCwd: resolved };
  } catch (error) {
    return { warning: error instanceof Error ? error.message : String(error) };
  }
}

function buildHarnessAskSayDevCliSpec(
  buildDevCliSpec: typeof import('./self-dev/dev-cli.js').buildDevCliSpec,
  input: { file: string },
  cliOpts: ReturnType<typeof harnessAskSayOptionsToDevCliOpts>,
  entranceId: EntranceId,
) {
  return {
    ...buildDevCliSpec(input, { kind: 'self' }, cliOpts, Object.keys(cliOpts), entranceId),
    ...(cliOpts.json ? { humanReadableOutput: false } : {}),
  };
}

async function runDevAskFromAskFile(askPath: string, opts: HarnessAskSayChildLlmOptions): Promise<void> {
  const [{ buildDevCliSpec, executeDevSelfRun, startDraftTriage, startDraftTriageOptions, assertDevCliPathOptions, selectDevAuthorInput }, { runDevPipeline, devResultOk }] = await Promise.all([
    runDevAskFromGoalFileDeps.loadDevCli(),
    runDevAskFromGoalFileDeps.loadDevPipeline(),
  ]);
  const selected = selectDevAuthorInput([], { ask: askPath });
  if (selected?.kind !== 'ask') return;
  const cliOpts = harnessAskSayOptionsToDevCliOpts(opts);
  try {
    assertDevCliPathOptions({ kind: 'self' }, cliOpts, Object.keys(cliOpts));
  } catch (error) {
    runDevAskFromGoalFileDeps.print(error instanceof Error ? error.message : String(error));
    runDevAskFromGoalFileDeps.setExitCode(1);
    return;
  }
  const grounding = resolveAskGroundingCwd(opts.target, runDevAskFromGoalFileDeps.cwd());
  if (grounding.warning) runDevAskFromGoalFileDeps.print(`[ask] ⚠️ --target 을 접지 루트로 못 풀었다 — 발사 트리로 접지한다: ${grounding.warning}`);
  const flowResult = await runDevAskFromGoalFileDeps.runAskFileLaunchFlow(
    selected.value,
    {
      ...(opts.forcePreflight === undefined ? {} : { forcePreflight: opts.forcePreflight }),
      ...(opts.goalType === undefined ? {} : { goalType: opts.goalType }),
      ...(grounding.groundingCwd === undefined ? {} : { groundingCwd: grounding.groundingCwd }),
    },
  );
  if (flowResult.kind !== 'launch') {
    runDevAskFromGoalFileDeps.setExitCode(1);
    return;
  }
  const { CLI_HARNESS_ASK_ENTRANCE } = await import('./self-dev/entrance-registry.js');
  const identity = ensureRunIdentity();
  const result = await executeHarnessSelfRun(
    flowResult.goalFile,
    opts,
    executeDevSelfRun,
    (pieceFeature, relaunch, base) => runDevPipeline({
      ...buildHarnessAskSayDevCliSpec(
        buildDevCliSpec,
        { file: flowResult.goalFile },
        cliOpts,
        CLI_HARNESS_ASK_ENTRANCE.id,
      ),
      ...(pieceFeature === undefined ? {} : { input: { text: pieceFeature } }),
      ...(base === undefined ? {} : { base }),
      runId: identity.runId,
      runIdSource: identity.source,
      ...(relaunch ? { relaunch: true } : {}),
    }),
    identity.runId,
    startDraftTriage,
    startDraftTriageOptions,
  );
  const ok = devResultOk(result);
  if (opts.json) {
    await writeStdoutJson(JSON.stringify({ ok, kind: result.kind, result: result.result }) + '\n');
  } else {
    await printHarnessCompletionLine(result, ok);
  }
  if (!ok) runDevAskFromGoalFileDeps.setExitCode(2);
}

async function runDevAskFromGoalFile(goalPath: string, opts: HarnessAskSayChildLlmOptions = {}): Promise<void> {
  // ⭐⛔ 런 신원은 «저작 «전»» 에 정한다 — `ensureRunIdentity` 는 mint-once 라 뒤의 호출은 `inherited` 를 받는다.
  //   기전: `debug.log` 는 `process.env.ELANOUS_RUN_ID` 가 «그 순간» 서 있을 때만 `data.runId` 를 찍는다
  //   (src/debug/log.ts enrichDebugRecord). 그래서 mint 가 늦으면 그 «앞» 로그가 런에 안 묶인다.
  //   📏 실측 2026-09-02 (prod 전수 · surface=harness): mint 뒤인 `self-implement` 1566/1640 · `harness.boundary`
  //      136/136 은 찍혔고, mint «앞»인 `goal-author` 0/120 · `llm.request` 0/133 은 «하나도» 안 찍혔다
  //      ⇒ 그 결과 「rework 자식이 어느 provider 로 갔나」를 아무도 못 물었다.
  ensureRunIdentity();
  if (!isGoalAuthorFileName(basename(goalPath))) {
    // stdout JSON 과 독립 — 애매한 입력을 ask-file 로 읽었다는 진단은 항상 stderr.
    runDevAskFromGoalFileDeps.print('[harness ask] 입력 종류: ask-file');
    await runDevAskFromAskFile(goalPath, opts);
    return;
  }
  const [
    { buildDevCliSpec, executeDevSelfRun, startDraftTriage, startDraftTriageOptions },
    { runDevPipeline, devResultOk },
    { decideAskPreflight, prepareAskLaunch, renderLaunchPreflight },
    { buildAskPreflightDeps },
    { measureInvokerBehindDefaultBranch, recommendLaunchDecomposition },
  ] = await Promise.all([
    runDevAskFromGoalFileDeps.loadDevCli(),
    runDevAskFromGoalFileDeps.loadDevPipeline(),
    runDevAskFromGoalFileDeps.loadLaunchPreflight(),
    runDevAskFromGoalFileDeps.loadAskLaunchIo(),
    runDevAskFromGoalFileDeps.loadAskLaunchFlow(),
  ]);
  const cliOpts = harnessAskSayOptionsToDevCliOpts(opts);
  const prep = prepareAskLaunch({ kind: 'ask', value: goalPath }, {});
  const preflightDeps = await buildAskPreflightDeps();
  const tree = measureInvokerBehindDefaultBranch(runDevAskFromGoalFileDeps.cwd());
  const launchPolicy = assembleAskLaunchPolicy({ forcePreflight: opts.forcePreflight });
  const decision = decideAskPreflight({
    goalFile: goalPath,
    liveRunWindowMinutes: prep.liveRunWindowMinutes,
    recentChangeWindowDays: prep.recentChangeWindowDays,
  }, preflightDeps, launchPolicy.forceRequested);
  if (!cliOpts.json) {
    runDevAskFromGoalFileDeps.print(tree.state === 'measured'
      ? `[preflight] 인보커 작업 트리 원격 기본 브랜치 대비 — ${tree.commits === 0 ? '뒤처지지 않았다' : `${tree.commits}커밋 뒤처졌다`} (${tree.baseRef})`
      : `[preflight] 인보커 작업 트리 원격 기본 브랜치 대비 — ⚠️ 못 쟀다 (${tree.reason}; ⛔ 최신이라는 뜻이 아니다)`);
    runDevAskFromGoalFileDeps.print(renderLaunchPreflight(decision.result, launchPolicy.forceRequested));
  }
  const { CLI_HARNESS_ASK_ENTRANCE } = await import('./self-dev/entrance-registry.js');
  if (!cliOpts.json) {
    let goalDocument = '';
    try {
      goalDocument = readFileSync(goalPath, 'utf8');
    } catch { /* 권고 산출 실패가 기존 harness ask 발사를 끊으면 안 된다. */ }
    await recommendLaunchDecomposition(goalPath, {
      entrance: CLI_HARNESS_ASK_ENTRANCE,
      inputSource: 'ask',
      askText: goalDocument,
      askFile: goalPath,
      liveRunWindowMinutes: prep.liveRunWindowMinutes,
      recentChangeWindowDays: prep.recentChangeWindowDays,
      ...launchPolicy,
    }, {
      print: runDevAskFromGoalFileDeps.print,
      log: (event, data, level) => debug.log('dev-pipeline', event, data, { level }),
      readLine: (prompt) => readStdinLine(prompt),
      readFile: () => goalDocument,
      writeFile: () => undefined,
      cwd: runDevAskFromGoalFileDeps.cwd,
      now: () => Date.now(),
      isInteractive: () => false,
      buildPreflightDeps: async () => preflightDeps,
      priorBlockSamples: () => [],
      recentAuthoringSamples: () => [],
      authorGoal: async () => { throw new Error('harness ask goal-file launch does not author during decomposition recommendation'); },
      relativeToCwd: (file) => file,
    }, goalDocument);
  }
  const identity = ensureRunIdentity();
  const result = await executeHarnessSelfRun(
    goalPath,
    opts,
    executeDevSelfRun,
    (pieceFeature, relaunch, base) => runDevPipeline({
      ...buildHarnessAskSayDevCliSpec(
        buildDevCliSpec,
        { file: goalPath },
        cliOpts,
        CLI_HARNESS_ASK_ENTRANCE.id,
      ),
      runId: identity.runId,
      runIdSource: identity.source,
      ...(pieceFeature === undefined ? {} : { input: { text: pieceFeature } }),
      ...(base === undefined ? {} : { base }),
      ...(relaunch ? { relaunch: true } : {}),
    }),
    identity.runId,
    startDraftTriage,
    startDraftTriageOptions,
  );
  const ok = devResultOk(result);
  if (opts.json) {
    await writeStdoutJson(JSON.stringify({ ok, kind: result.kind, result: result.result }) + '\n');
  } else {
    await printHarnessCompletionLine(result, ok);
  }
  if (!ok) runDevAskFromGoalFileDeps.setExitCode(2);
}

/** ⭐ `elanous harness plan` — `say` 와 «같은 저작 흐름»을 타고 ***plan-staged dispatch*** 로 간다.
 *  ⛔⭐ `say` 를 복제하지 «않는다» — 다른 것은 ***`plan: true` 한 칸***뿐이고 나머지는 그 함수를 그대로 쓴다.
 *    (오늘 접기 축이 계속 가르친 것: ***같은 판단의 두 번째 구현을 만들지 않는다***.)
 *  📏 각인은 흐름마다 자기 등기 식별자를 쓴다: `plan`은 `cli-harness-plan`, `say`는 `cli-harness-say`.
 *    저작 흐름은 공유하지만 런 귀속은 각 입구의 것이다. */
async function runDevPlanFromWords(words: string[], opts: HarnessPlanOptions = {}): Promise<void> {
  await runDevSayFromWords(words, opts, { planStaged: true });
}

async function runDevSayFromWords(
  words: string[],
  opts: HarnessAskSayChildLlmOptions | HarnessPlanOptions = {},
  /** ⛔ «내부» 인자다 — 공개 옵션(`HarnessAskSayOptions`)을 늘리지 않는다.
   *  `harness plan` 만 이것을 켠다. */
  internal: { readonly planStaged?: boolean } = {},
): Promise<void> {
  // ⭐⛔ 런 신원은 «저작 «전»» 에 정한다 — `ensureRunIdentity` 는 mint-once 라 뒤의 호출은 `inherited` 를 받는다.
  //   기전: `debug.log` 는 `process.env.ELANOUS_RUN_ID` 가 «그 순간» 서 있을 때만 `data.runId` 를 찍는다
  //   (src/debug/log.ts enrichDebugRecord). 그래서 mint 가 늦으면 그 «앞» 로그가 런에 안 묶인다.
  //   📏 실측 2026-09-02 (prod 전수 · surface=harness): mint 뒤인 `self-implement` 1566/1640 · `harness.boundary`
  //      136/136 은 찍혔고, mint «앞»인 `goal-author` 0/120 · `llm.request` 0/133 은 «하나도» 안 찍혔다
  //      ⇒ 그 결과 「rework 자식이 어느 provider 로 갔나」를 아무도 못 물었다.
  ensureRunIdentity();
  const sayText = words.join(' ');
  const cliOpts = {
    ...harnessAskSayOptionsToDevCliOpts(opts),
    // ⭐ `harness plan` 이 이 흐름을 «재사용»한다 — 다른 것은 이 한 칸뿐이다.
    ...(internal.planStaged ? { plan: true } : {}),
  };
  const [{ buildDevCliSpec, executeDevSelfRun, startDraftTriage, startDraftTriageOptions, assertDevCliPathOptions, selectDevAuthorInput }, { runDevPipeline, devResultOk }] = await Promise.all([
    runDevAskFromGoalFileDeps.loadDevCli(),
    runDevAskFromGoalFileDeps.loadDevPipeline(),
  ]);
  const selected = selectDevAuthorInput([], { say: sayText });
  if (selected?.kind !== 'say') return;
  try {
    assertDevCliPathOptions({ kind: 'self' }, cliOpts, Object.keys(cliOpts));
  } catch (error) {
    runDevAskFromGoalFileDeps.print(error instanceof Error ? error.message : String(error));
    runDevAskFromGoalFileDeps.setExitCode(1);
    return;
  }
  if (Array.isArray(cliOpts.roleLlm) && cliOpts.roleLlm.length > 0) {
    const { parseRoleLlmFlags } = await import('./llm/role-llm-cli.js');
    const { setLaunchRoleLlmOverrides } = await import('./user-config.js');
    const parsed = parseRoleLlmFlags(cliOpts.roleLlm);
    if (!parsed.ok) {
      runDevAskFromGoalFileDeps.print(`❌ --role-llm: ${parsed.message}`);
      runDevAskFromGoalFileDeps.setExitCode(1);
      return;
    }
    setLaunchRoleLlmOverrides(parsed.overrides);
    debug.log('harness.role-llm', 'launch-overrides', { roles: Object.keys(parsed.overrides), source: 'flag' });
  }
  const { CLI_HARNESS_PLAN_ENTRANCE, CLI_HARNESS_SAY_ENTRANCE } = await import('./self-dev/entrance-registry.js');
  const authoringEntrance = internal.planStaged ? CLI_HARNESS_PLAN_ENTRANCE : CLI_HARNESS_SAY_ENTRANCE;
  const grounding = resolveAskGroundingCwd(opts.target, runDevAskFromGoalFileDeps.cwd());
  if (grounding.warning) runDevAskFromGoalFileDeps.print(`[ask] ⚠️ --target 을 접지 루트로 못 풀었다 — 발사 트리로 접지한다: ${grounding.warning}`);
  const flowResult = await runDevAskFromGoalFileDeps.runSayLaunchFlow(
    selected.value,
    authoringEntrance,
    {
      ...(opts.forcePreflight === undefined ? {} : { forcePreflight: opts.forcePreflight }),
      ...(grounding.groundingCwd === undefined ? {} : { groundingCwd: grounding.groundingCwd }),
    },
  );
  if (flowResult.kind !== 'launch') {
    runDevAskFromGoalFileDeps.setExitCode(1);
    return;
  }
  const entrance = authoringEntrance.id;
  const identity = ensureRunIdentity();
  const result = await executeHarnessSelfRun(
    flowResult.goalFile,
    opts,
    executeDevSelfRun,
    (pieceFeature, relaunch, base) => runDevPipeline({
      ...buildHarnessAskSayDevCliSpec(
        buildDevCliSpec,
        { file: flowResult.goalFile },
        cliOpts,
        entrance,
      ),
      runId: identity.runId,
      runIdSource: identity.source,
      ...(pieceFeature === undefined ? {} : { input: { text: pieceFeature } }),
      ...(base === undefined ? {} : { base }),
      ...(relaunch ? { relaunch: true } : {}),
    }),
    identity.runId,
    startDraftTriage,
    startDraftTriageOptions,
  );
  const ok = devResultOk(result);
  if (opts.json) {
    await writeStdoutJson(JSON.stringify({ ok, kind: result.kind, result: result.result }) + '\n');
  } else {
    await printHarnessCompletionLine(result, ok);
  }
  if (!ok) runDevAskFromGoalFileDeps.setExitCode(2);
}

registerPtyTakeoverCommands(program);
registerPtyRecordCommand(program.commands.find((command) => command.name() === 'pty')!);
registerPrCommands(program);
registerRepoCommands(program);
registerRoleCommands(program);
registerMachineCommands(program);
// CLI entry: where action → resolveCurrentInstance → resolveInstance (instance universe).
registerWhereCommand(program);
registerShadowCommand(program);
registerLlmDetectCommand(program);
registerStorageDetectCommand(program);
registerLeaderCommands(program);
registerPodCommands(program);
// 🎨 봇이 모는 브라우저 페이지 «안»에 그린다 — `src/browser-annotate/` 원장의 «문»(42차).
registerBrowserAnnotateCommand(program);
registerPendingQuestionsCommand(program);
registerUsageCommand(program);
// main() → program.parseAsync() → live detail action; --test was applied before dispatch.
registerLiveCommands(program);
registerResearchCommand(program);
registerReleaseCommands(program);
registerModelWatchCommand(program);
registerDoctorCommand(program);
// runCli() → main() → program.parseAsync() dispatches control serve and resources where|list.
registerControlCommands(program);
registerHooksCommands(program);
registerSetupCommand(program);
program.commands.find(command => command.name() === 'setup')!
  .option('--terminal', 'Run the terminal onboarding wizard')
  .hook('preAction', async (_command, action) => {
    if (action.name() === 'setup' && action.opts().terminal) {
      const completed = await runOnboardingForCli();
      process.exit(completed ? 0 : (process.exitCode || 2));
    }
  });
registerStartCommand(program);
registerGroundingSourcesCli(program);
registerGraphCommands(program);
registerLoopCommands(program);
// RFC 실행·착지 루프 §3 — 태스크 컨텍스트 카드(`elanous card list|show` · ⛔ `task`/`tasks` 는 TOX 몫).
registerCardCommand(program);
registerLaunchHeadCommands(program);
registerA2ACommands(program);
registerPluginCommands(program);

const marketCmd = program.command('market').description('Signed plugin marketplace');
marketCmd.command('publish').description('Publish a local signed marketplace index and archives')
  .requiredOption('--dir <plugins>', 'Plugin folders')
  .requiredOption('--out <dir>', 'Output directory')
  .requiredOption('--key <pem>', 'Private signing key file')
  .requiredOption('--key-id <id>', 'Signing key id')
  .option('--market-name <name>', 'Marketplace name', 'elanous')
  .option('--display-name <name>', 'Marketplace display name', 'Elanous')
  .option('--source-repo <url>', 'Git source repository')
  .option('--source-sha <sha>', 'Git source commit')
  .option('--source-base <path>', 'Git source plugin base directory')
  .option('--bundle-root <dir>', 'Root that extensions["ai.elanous"].bundle paths resolve against (usually the repository root)')
  .option('--json', 'JSON result')
  .action(async (opts: { dir: string; out: string; key: string; keyId: string; marketName: string; displayName: string;
    sourceRepo?: string; sourceSha?: string; sourceBase?: string; bundleRoot?: string; json?: boolean }) => {
    try {
      const sourceOptions = [opts.sourceRepo, opts.sourceSha, opts.sourceBase];
      if (sourceOptions.some(Boolean) && !sourceOptions.every(Boolean)) throw new Error('source-repo, source-sha and source-base must be provided together');
      const { publishMarket } = await import('./market/publish.js');
      const result = publishMarket({ pluginsDir: opts.dir, outDir: opts.out,
        market: { name: opts.marketName, displayName: opts.displayName },
        key: { keyId: opts.keyId, privateKeyPem: readFileSync(opts.key, 'utf8') },
        ...(opts.bundleRoot ? { bundleRoot: opts.bundleRoot } : {}),
        ...(opts.sourceRepo && opts.sourceSha && opts.sourceBase
          ? { source: { repoUrl: opts.sourceRepo, sha: opts.sourceSha, basePath: opts.sourceBase } } : {}),
      });
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else {
        console.log(`Published ${result.published.length} plugins (sequence ${result.sequence}); skipped ${result.skipped.length}`);
        for (const warning of result.warnings) console.warn(`⚠ ${warning.dir}: ${warning.graph} uses recipes it does not ship (${warning.recipes.join(', ')}) — third-party graphs should use their own recipes.yaml or custom nodes`);
      }
      for (const item of result.skipped) {
        for (const hit of item.hits ?? []) console.error(`${item.dir}/${hit.file}:${hit.line}: ${hit.marker}`);
      }
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`market publish: ${error instanceof Error ? error.message : 'failed'}`);
      process.exitCode = 1;
    }
  });
marketCmd.command('keygen').description('Generate a local test index signing key')
  .requiredOption('--out <dir>', 'Key output directory')
  .action(async (opts: { out: string }) => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { generateIndexKeyPair } = await import('./market/signed-index.js');
    const pair = generateIndexKeyPair();
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(_joinPath(opts.out, 'index-key.pem'), pair.privateKeyPem, { mode: 0o600, flag: 'wx' });
    writeFileSync(_joinPath(opts.out, 'index-key.pub.json'), JSON.stringify({ keyId: pair.keyId, publicKey: pair.publicKey }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Generated local index key ${pair.keyId}`);
  });

program.command('directive').description('Turn instructions into Linear issues')
  .command('add <text>').option('--source <source>', 'telegram|pwa|tui|cli', 'cli')
  .option('--dry-run', 'Preview the normalized directive without contacting Linear')
  .action(async (text: string, opts: { source: 'telegram' | 'pwa' | 'tui' | 'cli'; dryRun?: boolean }) => {
    try { await (await import('./steward/directive.js')).runDirectiveCli(text, opts); }
    catch { console.error('directive add: unable to submit directive'); process.exitCode = 1; }
  });

const connectorCmd = program.command('connector').description('External task connectors');
const linearCmd = connectorCmd.command('linear').description('Linear issues to TOX tasks');
linearCmd.command('sync').requiredOption('--team <key>', 'Linear team key')
  .option('--prefix <text>', 'Issue title prefix or label').option('--dry-run', 'Do not post or record events').option('--json', 'JSON output')
  .action(async (opts: { team: string; prefix?: string; dryRun?: boolean; json?: boolean }) => {
    const { runLinearSync } = await import('./cli/connector-cli.js');
    try { process.exitCode = await runLinearSync(opts); }
    catch (error) { console.error(`connector linear sync: ${(error as Error).message}`); process.exitCode = 1; }
  });
linearCmd.command('receive').description('Internal signed webhook receiver; read raw payload from stdin')
  .requiredOption('--signature <hex>', 'Linear-Signature header')
  .requiredOption('--delivery <id>', 'Linear-Delivery header')
  .action(async (opts: { signature: string; delivery: string }) => {
    const { runLinearWebhook } = await import('./cli/connector-cli.js');
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      process.exitCode = await runLinearWebhook({ rawBody: Buffer.concat(chunks), signature: opts.signature, deliveryId: opts.delivery });
    } catch { console.error('connector linear receive: unable to apply event'); process.exitCode = 1; }
  });
linearCmd.command('set-webhook-secret').description('Read Linear webhook signing secret from stdin and store in secrets')
  .action(async () => {
    const { runLinearSetWebhookSecret } = await import('./cli/connector-cli.js');
    try { process.exitCode = await runLinearSetWebhookSecret(); }
    catch { console.error('connector.linear.webhookSecret: could not save secret'); process.exitCode = 1; }
  });
linearCmd.command('set-key').description('Read Linear API key from stdin and store in secrets')
  .action(async () => {
    const { runLinearSetKey } = await import('./cli/connector-cli.js');
    try { process.exitCode = await runLinearSetKey(); }
    catch { console.error('connector.linear.apiKey: could not save key'); process.exitCode = 1; }
  });

const pythonCmd = program.command('python').description('elanous 가 쓰는 파이썬(해석 · 점검 · elanous venv 셋업) — RFC-doctor-fix-build-toolchain-and-python-by-distro');
pythonCmd.command('where').description('어느 파이썬을 쓰나(ELANOUS_PYTHON > elanous venv > pyenv .python-version > PATH)').option('--json').option('--path', '경로만 한 줄(스크립트·스킬용)').action(async (o: { json?: boolean; path?: boolean }) => {
  const { runPythonWhere } = await import('./cli/python-cli.js'); process.exitCode = runPythonWhere(console, o.json, o.path);
});
pythonCmd.command('check').description('python-env 준비 상태(버전 · venv · 선언 모듈 import) — exit 0 ok · 10 fixable · 2 manual').option('--extra', '선택 의존성도 본다').option('--json').action(async (o: { extra?: boolean; json?: boolean }) => {
  const { runPythonCheck } = await import('./cli/python-cli.js'); process.exitCode = runPythonCheck(o);
});
pythonCmd.command('setup').description('elanous venv(~/.local/share/elanous/python/venv · --system-site-packages)를 만들고 선언 의존성을 설치 — 기본 = 계획만').option('--yes', '적용').option('--extra', '선택 의존성도 설치').action(async (o: { yes?: boolean; extra?: boolean }) => {
  const { runPythonSetup } = await import('./cli/python-cli.js'); process.exitCode = runPythonSetup(o);
});

program.command('self-update')
  .alias('update')
  .description('설치본은 릴리스로, 체크아웃은 깨끗한 체크아웃으로 갱신하고 승인 시 넥서스 재시작 · `elanous update` 와 같다 · `--auto on` 이면 매일 자동')
  .option('--from <checkout>', '설치할 체크아웃 (기본: 설치본은 릴리스, 체크아웃은 현재 체크아웃)')
  .option('--version <version>', '설치본에서 지정한 릴리스 버전 설치 (기본: latest)')
  .option('--restart', '넥서스 재시작 승인')
  .option('--json', '결과 JSON 출력')
  .option('--keep <n>', '설치 뒤 남길 최근 판 수(설치본은 current·직전 판, 체크아웃은 current·데몬 판 보호 · 0 이면 정리 안 함)', '3')
  .option('--alert', '실패(exit≠0)를 알림으로도 보냄 — 크론(무인) 실행용')
  .option('--skip-pwa-build', '체크아웃 설치 전 PWA 빌드를 명시적으로 건너뜀')
  .option('--auto <on|off|status>', '자동 갱신 — macOS launchd · Linux systemd 타이머가 매일 04:17 에 `self-update --restart --alert` (크론이 이미 부르면 켜지 않는다)')
  .action(async (opts: { from?: string; version?: string; restart?: boolean; json?: boolean; keep?: string; alert?: boolean; skipPwaBuild?: boolean; auto?: string }) => {
    if (opts.auto !== undefined) {
      if (!['on', 'off', 'status'].includes(opts.auto)) { console.error(`--auto 는 on · off · status 중 하나: ${opts.auto}`); process.exitCode = 2; return; }
      const { runAutoUpdate } = await import('./cli/update-auto.js');
      process.exitCode = (await runAutoUpdate(opts.auto as 'on' | 'off' | 'status')).exitCode;
      return;
    }
    const { runUpdateForInstallation } = await import('./cli/self-update.js');
    // ⭐ 한 번 도는 CLI 는 logs.db 싱크를 스스로 붙여야 `debug.log('self-update', …)` 가 저장된다(없으면 조용히 사라진다 · 09-24 실측).
    try { const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js'); await registerStandaloneLogSink('self-update'); } catch { /* 관측 실패가 갱신을 막지 않는다 */ }
    const keep = Number.parseInt(opts.keep ?? '3', 10);
    const result = await runUpdateForInstallation({ ...opts, skipPwaBuild: opts.skipPwaBuild, keep: Number.isFinite(keep) ? keep : 3 }, { cliRoot: REPOSITORY_ROOT });
    process.exitCode = result.exitCode;
  });

program
  .name('elanous')
  .description('말 한 줄로 시작: elanous harness say "…" — 끝까지 간다 · 다 보인다 · 스스로를 만들었다')
  .version(cliVersion())
  // Documentation-only entry — the flag is extracted from argv by
  // `applyConfigDirFlagFromArgv` at module init (above) so Commander
  // never actually sees it. The `.option()` call is here purely so
  // `elanous --help` surfaces it to users.
  .option(
    '--config-dir <dir>',
    'Override the elanous config / daemon root directory (default ~/.elanous). Pass at any position — works at the global or subcommand level. Replaces the legacy ELANOUS_DAEMON_DIR env var.',
  )
  // Documentation-only — `resolveRemoteAttach`/`stripRemoteFlags` 가 commander «전»에
  // argv 에서 걷어내므로 Commander 는 이 옵션을 «보지 못한다». 여기 선언하는 이유는
  // ⭐ ***`elanous --help` 에 «보이게» 하기 위해서***다(리뷰 지적: 새 진입점인데 발견 불가였다).
  // ⛔ `-r` 은 값을 받지 않는다 — 이름을 대려면 `--remote <name>`.
  //    (`[name]` 으로 선언하는 것은 도움말에 긴 형태의 값 자리를 보이기 위해서다.)
  .option(
    '-r, --remote [name]',
    '원격 북마크로 붙는다. `-r` 만 쓰면 default 북마크(값을 받지 않는다), 이름을 대려면 `--remote <name>`. 처음 1회 `elanous nexus connect <host> --default`.',
  )
  // Documentation-only — extracted from argv by `applyTestFlagFromArgv` at module
  // init (above) before Commander sees it. Commands that declare their own
  // `--test` keep owning it (see OWNED_TEST_FLAG_PATHS).
  .option(
    '--test',
    '격리 테스트 인스턴스로 실행 — cwd 의 git 트리(worktree 포함)에서 `<트리>/.elanous-test` 를 루트로 잡고 state·config 두 축을 함께 격리한다. config 사본이 없으면 자동 물질화. `--test=<dir>` 로 루트 직접 지정 가능(값 문법은 `=` 형태 하나 — 모호함 없음). ELANOUS_STATE_DIR/--config-dir 을 손으로 줄 필요가 없다.',
  );
program.addHelpText('after', acpServerHelpText());

program
  .command('measure-fabric-arc-ab')
  .description('Fabric 분해 아크의 축소/전체 그라운딩 A/B를 관측하고 표와 JSON 결과를 낸다')
  .action(async () => {
    const { main: measureFabricArcAb } = await import('../scripts/measure-fabric-arc-ab.js');
    await measureFabricArcAb(process.env, undefined, undefined, []);
  });

// ── mcp command — stdio MCP server / client integration (B 트랙 #2474) ──
//
// `elanous mcp serve` runs a stdio JSON-RPC 2.0 MCP server in this
// process so external MCP clients (Claude Code · Cursor · Codex)
// can call into elanous's ToolRuntime registry — including the
// proxy tools from the *active universe's* config `mcp.servers`
// (e.g. xcrun mcpbridge · getsentry/xcodebuildmcp).
//
// ⛔ NOT hardcoded to `~/.elanous/config.json`. `getUserConfig()` →
// `getElanousConfigDir()` → `effectiveInstanceRoot()`, so prod, test
// and tree-derived universes each resolve their own file. Measured
// 2026-08-20: a fake universe's canary server is the only one this
// command sees. The old wording named the prod path and made
// readers conclude — backwards — that MCP ignores isolation.
// This is the S-5
// (Relay) wire described in RFC §5.5: Claude Code → elanous → external
// MCP server → tool result back to Claude Code.
//
// Architecture (Phase 3 closure piece · 2026-05-13):
//   1. Read user-config (Path A's `mcp.servers` field — sparse)
//   2. Spawn child MCP servers via `registerMcpClients` (same boot
//      helper NEXUS daemon uses · idempotent dual-spawn OK since
//      external servers are stateless stdio child processes)
//   3. Register proxy ToolRuntimes with surfaces:['mcp']
//   4. Start the stdio JSON-RPC server (`startMcpStdioServer`) so
//      this process's stdin/stdout becomes the MCP transport
//   5. On SIGINT / SIGTERM: stop stdio, dispose all clients, exit
//
// Note: this spawns NEW child instances of every configured external
// server even if a NEXUS daemon is already running with its own
// copies. Resource overhead is small (external servers are short
// stdio JSON-RPC processes) but a future Post-3 follow-up may add
// a `--proxy-to-nexus` mode that relays through NEXUS HTTP API so
// the PFC capture seam observes every call.
const mcpCmd = program
  .command('mcp')
  .description('MCP (Model Context Protocol) server / client integration');
registerMcpGatewayCommands(mcpCmd);

registerRelayCommand(program);

mcpCmd
  .command('serve')
  .description('Run a stdio MCP server exposing the configured mcp.servers as proxy tools (used by `claude mcp add elanous -- elanous mcp serve`)')
  .action(async () => {
    const { getUserConfig } = await import('./user-config.js');
    const { registerMcpClients } = await import('./nexus/boot/register-mcp-clients.js');
    const { startMcpStdioServer } = await import('./mcp/server.js');
    const cfg = getUserConfig();
    const handle = await registerMcpClients({
      servers: cfg.mcp?.servers ?? [],
      handshakeTimeoutMs: cfg.mcp?.handshakeTimeoutMs,
      // Logger writes to stderr so it doesn't pollute the stdio
      // JSON-RPC channel on stdout — clients only see line-delimited
      // JSON.
      logger: {
        info: (line) => process.stderr.write(line + '\n'),
        warn: (line) => process.stderr.write(line + '\n'),
      },
    });
    const stdio = startMcpStdioServer({ origin: 'mcp-stdio' });
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { stdio.stop(); } catch { /* swallow */ }
      try { await handle.shutdown(); } catch { /* swallow */ }
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    // Block until SIG{INT,TERM}. stdin 'end' also signals end-of-input
    // from the client — treat as a graceful shutdown trigger so a
    // disconnecting Claude Code doesn't leave child processes behind.
    process.stdin.on('end', () => { void shutdown(); });
    await new Promise<void>(() => {
      /* never resolves — handler exits */
    });
  });

// `elanous mcp diagnose [id]` — PR3 (D · 2026-05-13). Single-shot
// reproduction of the boot-time `initialize` + `tools/list` handshake
// against one (or every enabled) MCP server in user-config. Useful
// when daemon-side boot hangs but a manual `echo … | <bin>` answers
// fine. Verbose stderr / timing / tool count makes the daemon-vs-shell
// env diff obvious. Lives under the MCP namespace (not the daemon).
mcpCmd
  .command('login <serverId>')
  .description('Acquire and persist OAuth credentials for one configured HTTP MCP server.')
  .option('--timeout <ms>', 'Authorization callback deadline in milliseconds.', (v) => Number.parseInt(v, 10))
  .action(async (serverId: string, opts: { timeout?: number }) => {
    const { runMcpLogin } = await import('./cli/mcp-login.js');
    const result = await runMcpLogin({
      serverId,
      ...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
    });
    process.exit(result.exitCode);
  });

mcpCmd
  .command('reload')
  .description('Re-read user-config and rebuild the running daemon\'s MCP clients — no daemon restart. Use after editing mcp.servers[] or `elanous mcp login`.')
  .option('--nexus-url <url>', 'NEXUS base URL. Default: the current daemon (elanous nexus show).')
  .option('--timeout <ms>', 'Deadline for the reload request.', (v) => Number.parseInt(v, 10))
  .action(async (opts: { nexusUrl?: string; timeout?: number }) => {
    const { runMcpReload } = await import('./cli/mcp-reload.js');
    const r = await runMcpReload({
      ...(opts.nexusUrl ? { nexusBaseUrl: opts.nexusUrl } : {}),
      ...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
    });
    process.exit(r.exitCode);
  });

mcpCmd
  .command('diagnose [serverId]')
  .description('Probe one (or every enabled) MCP server: spawn + initialize + tools/list, verbose. When `xcrun mcpbridge` hangs daemon-side, this reproduces under your shell env so you can diff.')
  .option('--timeout <ms>', 'Per-call deadline. Default 10000ms (slightly above the daemon boot guard).', (v) => Number.parseInt(v, 10))
  .action(async (serverId: string | undefined, opts: { timeout?: number }) => {
    const { runMcpDiagnose } = await import('./cli/mcp-diagnose.js');
    const r = await runMcpDiagnose({
      ...(serverId ? { serverId } : {}),
      ...(opts.timeout !== undefined ? { perCallTimeoutMs: opts.timeout } : {}),
    });
    process.exit(r.exitCode);
  });

mcpCmd
  .command('call <tool>')
  .description('Call one MCP tool on this machine\'s daemon (or a bookmarked remote) via POST /v1/mcp')
  .option('--arg <k=v>', 'Tool argument as a string (repeatable)', (value: string, previous: string[]) => {
    previous.push(value);
    return previous;
  }, [] as string[])
  .option('--arg-json <k=json>', 'Tool argument as JSON (repeatable; numbers, booleans, objects)', (value: string, previous: string[]) => {
    previous.push(value);
    return previous;
  }, [] as string[])
  .option('--args-json <json>', 'Tool arguments as a JSON object')
  .option('--json', 'Emit the JSON-RPC result')
  .option('-r', 'Use the default remote bookmark (does not take a value)')
  .option('--remote <name>', 'Use a named remote bookmark')
  .action(async (tool: string, opts: { arg?: string[]; argJson?: string[]; argsJson?: string; json?: boolean; r?: boolean; remote?: string }) => {
    const { runMcpCall } = await import('./cli/mcp-call.js');
    const result = await runMcpCall({
      tool,
      args: opts.arg ?? [],
      argJson: opts.argJson ?? [],
      ...(opts.argsJson !== undefined ? { argsJson: opts.argsJson } : {}),
      json: opts.json === true,
      ...(opts.remote !== undefined ? { remote: opts.remote } : opts.r === true ? { remote: true } : {}),
    });
    process.exit(result.exitCode);
  });

mcpCmd
  .command('list')
  .description('List MCP tools from this machine\'s daemon (or a bookmarked remote) via POST /v1/mcp tools/list')
  .option('--json', 'Emit the JSON-RPC result')
  .option('-r', 'Use the default remote bookmark (does not take a value)')
  .option('--remote <name>', 'Use a named remote bookmark')
  .action(async (opts: { json?: boolean; r?: boolean; remote?: string }) => {
    const { runMcpList } = await import('./cli/mcp-call.js');
    const result = await runMcpList({
      json: opts.json === true,
      ...(opts.remote !== undefined ? { remote: opts.remote } : opts.r === true ? { remote: true } : {}),
    });
    process.exit(result.exitCode);
  });

// ── sync command (interactive TUI) ──
program
  .command('telegram-test')
  .description('Standalone TEST telegram bot (separate token) — full Q&A/HITL/delegate path with ISOLATED state, WITHOUT touching the production daemon. Restart THIS process to test code changes; the live daemon stays up.')
  .option('--token <token>', 'override the config token (default: telegram.testChannel.botToken)')
  .option('--state-dir <dir>', 'isolated state dir (default ~/.elanous/telegram-test)')
  .option('--allow <ids>', 'comma-separated allowed telegram user ids (default: testChannel.allowedUsers or main allowlist)')
  .option('--reset', 'wipe the isolated state dir before starting (fresh test)')
  .action(async (opts: { token?: string; stateDir?: string; allow?: string; reset?: boolean }) => {
    const allowedUsers = opts.allow
      ? opts.allow.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : undefined;
    const { runTelegramTestMessenger } = await import('./telegram-test-runner.js');
    try {
      await runTelegramTestMessenger({ token: opts.token, stateDir: opts.stateDir, allowedUsers, reset: opts.reset });
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const telegramCmd = program
  .command('telegram')
  .description('텔레그램 봇 — 넥서스 밖에서 도는 정식 Q&A 폴러');
telegramCmd
  .command('run')
  .description('넥서스와 같은 Q&A 경로를 따로 떠 있는 프로세스로 돌린다 (토큰마다 폴링 잠금을 잡은 뒤에만 · 넥서스가 폴링 중이면 30초 기다린 뒤 그 토큰은 포기). 넥서스를 끄려면 telegram.poller=standalone.')
  .action(async () => {
    const { runTelegramPoller } = await import('./telegram-run.js');
    try {
      await runTelegramPoller();
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
telegramCmd
  .command('service')
  .description('`telegram run` 서비스 정의(launchd plist · systemd unit)를 보여 준다. --install 이면 쓰고 켠다(운영 telegram.poller=standalone 일 때만).')
  .option('--install', '서비스 파일을 쓰고 켠다 — telegram.poller=standalone 이 아니면 거부')
  .action(async (opts: { install?: boolean }) => {
    const { renderTelegramServiceFile, telegramRunCommand, installTelegramService } = await import('./telegram-service.js');
    const file = renderTelegramServiceFile({ platform: process.platform, command: telegramRunCommand(), uid: process.getuid?.() });
    if (!file) { ui.error(`telegram service: ${process.platform} 서비스 정의가 없다 (darwin·linux 만)`); process.exit(1); }
    if (opts.install) {
      const fs = await import('node:fs');
      const { spawnSync } = await import('node:child_process');
      const result = installTelegramService(file, getUserConfig().telegram.poller, process.getuid?.() ?? 0, {
        exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, 'utf8'), writeFile: (p, t) => fs.writeFileSync(p, t),
        mkdir: (p) => fs.mkdirSync(p, { recursive: true }), rename: fs.renameSync,
        run: (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8' }); return { status: r.status, stderr: r.stderr ?? String(r.error ?? '') }; },
      });
      debug.log('telegram.service', 'install', { ok: result.ok, path: result.path, backup: result.backup, steps: result.steps, reason: result.reason });
      for (const step of result.steps) console.log(`  ${step}`);
      if (!result.ok) { ui.error(`telegram service --install: ${result.reason}`); process.exit(1); }
      console.log(`✅ ${result.reason}`);
      return;
    }
    console.log(`# 놓을 자리: ${file.path}`);
    console.log('# ⛔ 이 명령은 파일을 쓰지 않았다. 켜기 전에 RFC-nexus-restart-minimization §R2 «켜기 전 볼 것»을 본다.');
    console.log(`# 켜는 명령(사람이 친다): ${file.enable.join(' && ')}  ⊕ elanous config set telegram.poller standalone`);
    console.log(file.content);
  });

program
  .command('discord-test')
  .description('Standalone TEST discord session (SAME app/token, scoped to discord.testChannel.channelId) with ISOLATED state, WITHOUT touching the production daemon. Restart THIS process to test code changes; the live daemon stays up.')
  .option('--token <token>', 'override the token (default: discord.testChannel.botToken → discord.botToken)')
  .option('--channel <id>', 'override the test channel snowflake (default: discord.testChannel.channelId)')
  .option('--state-dir <dir>', 'isolated state dir (default ~/.elanous/discord-test)')
  .option('--allow <ids>', 'comma-separated allowed discord user ids (default: testChannel.allowedUsers or main allowlist)')
  .option('--reset', 'wipe the isolated state dir before starting (fresh test)')
  .action(async (opts: { token?: string; channel?: string; stateDir?: string; allow?: string; reset?: boolean }) => {
    const allowedUsers = opts.allow
      ? opts.allow.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const { runDiscordTestMessenger } = await import('./discord-test-runner.js');
    try {
      await runDiscordTestMessenger({ token: opts.token, channelId: opts.channel, stateDir: opts.stateDir, allowedUsers, reset: opts.reset });
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync skills to local or remote machines')
  .option('--all', 'Sync ALL skills to ALL servers × ALL services (clean mode)')
  .option('--smart', 'Use smart mode (diff analysis, env delta detection)')
  .option('--clean', 'Use clean mode (delete + fresh copy)')
  .option('--merge', 'Use merge mode (update only older files)')
  .option('-s, --servers <servers...>', 'Target servers')
  .option('-v, --services <services...>', 'Target services')
  .option('-k, --skills <skills...>', 'Skills to sync')
  .action(async (opts) => {
    // --all mode (non-interactive)
    if (opts.all) {
      const allSkills = getLocalSkills();
      ui.info(`Syncing ${allSkills.length} skills to ${syncServers().length} servers × ${SERVICE_NAMES.length} services (clean)`);
      await executeSync({ servers: syncServers(), services: SERVICE_NAMES, skills: allSkills, mode: 'clean' });
      return;
    }

    // If all flags provided, skip TUI
    if (opts.servers && opts.services && opts.skills) {
      const mode: SyncMode = opts.smart ? 'smart' : opts.clean ? 'clean' : opts.merge ? 'merge' : 'merge';
      closeTui();
      await executeSync({ servers: opts.servers, services: opts.services, skills: opts.skills, mode });
      return;
    }

    // Interactive TUI selector
    await runSyncFlow(false);
  });

// ── status command ──
program
  .command('status')
  .description('Show current sync status and detect changes since last sync')
  .action(() => { showStatus(); });

program
  .command('git <args...>')
  .description('Run git through the git-fs gateway and append a pipe-visible exit status')
  .helpOption(false)
  .allowUnknownOption(true)
  .passThroughOptions()
  .action(async (args: string[]) => {
    try {
      const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
      await registerStandaloneLogSink('git-cli');
    } catch { /* fail-open — observation wiring must not block git */ }
    const { runGitCli } = await import('./git-fs/git-cli.js');
    runGitCli(args);
  });

program
  .command('gh <args...>')
  .description('Run gh with retry-safe reads and append a pipe-visible outcome')
  .helpOption(false)
  .allowUnknownOption(true)
  .passThroughOptions()
  .action(async (args: string[]) => {
    try {
      const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
      await registerStandaloneLogSink('gh-cli');
    } catch { /* fail-open — observation wiring must not block gh */ }
    const { runGhCli } = await import('./git-fs/gh-cli.js');
    runGhCli(args);
  });

// ── repro command — single-shot headless prompt evaluator ──
//
// Pipes a single user prompt through the same LLM stack the dashboard
// chat surface uses (universal preamble + native-tool catalog +
// streamLLMWithTools) and exits. Used for self-validating coding-
// pipeline fixes (codex stall / dedup / broad-spot) from the command
// line without restarting the daemon or asking a human to re-type the
// prompt. The complementary `ask` command above is session-based; this
// one is fully ephemeral with full preamble + tool stack.
//
// See src/eval-prompt-cli.ts and the design doc:
//   내부 문서 `RESEARCH-coding-pipeline-3refs-system-prompt-2026-05-03`
//
// Typical use:
//   bun run src/index.ts repro --model gpt-5.4 \
//     "이 프로젝트의 디버깅 파이프라인 분석해주세요"
//   then inspect log/latest for chat.universal-preamble /
//   chat.project-tree / tool-loop.* events.
// Parse `Tool=N` / `Tool:N` pairs into a record. promptfoo / inspect_ai
// convention — used by --assert-tool-min and --assert-tool-max.
function parseToolCountSpec(
  specs: string[] | undefined,
  invalidOption?: '--assert-tool-min' | '--assert-tool-max',
): Record<string, number> | undefined {
  if (!specs || specs.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const spec of specs) {
    const match = spec.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s*[=:]\s*(\d+)$/);
    if (!match) {
      if (invalidOption) {
        throw new Error(`invalid ${invalidOption} value ${JSON.stringify(spec)}; expected ToolName=N`);
      }
      continue;
    }
    out[match[1]!] = Number.parseInt(match[2]!, 10);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const REPRO_RETIREMENT_NOTICE = [
  'repro is retired and no longer runs an LLM evaluation loop.',
  'Use elanous attach --message <prompt> for live tool verification.',
  'Supported assertions: --assert-tool-min, --assert-tool-max, --assert-text-contains.',
].join('\n');

program
  .command('repro [prompt]', { hidden: true })
  .alias('eval-prompt')
  .description('Retired compatibility command')
  .action(() => {
    process.stderr.write(`${REPRO_RETIREMENT_NOTICE}\n`);
    process.exitCode = 1;
  });

const themeCmd = program.command('theme').description('Inspect and configure dashboard themes');

themeCmd
  .command('list')
  .description('List built-in theme ids')
  .action(() => {
    const raw = getUserConfig().dashboard.theme;
    const active = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).active
      : null;
    console.log(`${active === 'default' || !active ? '*' : ' '} default  ${DEFAULT_THEME_TOKENS.name}`);
    console.log('  plugin:<plugin-id>.<theme-id>  active plugin theme contribution');
  });

themeCmd
  .command('use <id>')
  .description('Set dashboard.theme.active')
  .action((id: string) => {
    const cfg = getUserConfig();
    cfg.dashboard.theme = { ...(cfg.dashboard.theme as object ?? {}), active: id } as never;
    saveUserConfig(cfg);
    ui.info(`theme active: ${id}`);
  });

themeCmd
  .command('preview')
  .description('Print resolved current theme tokens')
  .action(async () => {
    await writeStdoutJson(JSON.stringify(resolveThemeTokens(getUserConfig().dashboard.theme), null, 2) + '\n');
  });

themeCmd
  .command('export')
  .description('Export resolved current theme tokens as JSON')
  .action(async () => {
    await writeStdoutJson(JSON.stringify(resolveThemeTokens(getUserConfig().dashboard.theme), null, 2) + '\n');
  });

// ── history command ──
program
  .command('history')
  .description('Show sync history')
  .option('-n, --limit <n>', 'Number of sessions to show', '10')
  .option('--session <id>', 'Show detail for a specific session')
  .option('--skill <name>', 'Show history for a specific skill')
  .option('--server <name>', 'Filter by server')
  .option('--service <name>', 'Filter by service')
  .action((opts) => {
    if (opts.session) showSessionDetail(parseInt(opts.session));
    else if (opts.skill) showSkillDetail(opts.skill, opts.server, opts.service);
    else if (opts.server && opts.service) showTargetDetail(opts.server, opts.service);
    else showRecentHistory(parseInt(opts.limit));
  });

// ── inspect command ──
program
  .command('inspect')
  .description('Inspect remote targets without syncing')
  .option('-s, --servers <servers...>', 'Target servers')
  .option('-v, --services <services...>', 'Target services')
  .action(async (opts) => {
    const servers = opts.servers || syncServers();
    const services = opts.services || SERVICE_NAMES;
    const localSkills = new Set<string>(getLocalSkills());
    ui.header('Remote Inspection');
    for (const server of servers) {
      for (const service of services) {
        const inspection = await inspectRemote(server, service, localSkills);
        ui.showRemoteInspection(inspection);
        console.log();
      }
    }
  });

registerAutopilotCommands(program);

// ── memory ──
const memCmd = program.command('memory').description('Persistent memories injected into every chat turn (user / feedback / project / reference)');

memCmd
  .command('list [type]')
  .description('List memories (optionally filtered by type)')
  .option('-n, --limit <n>', 'Max entries to show', '30')
  .action((type?: string, opts?: { limit: string }) => {
    const t = type as MemoryType | undefined;
    const entries = listMemories({ type: t, limit: parseInt(opts?.limit ?? '30', 10) });
    if (entries.length === 0) {
      ui.info('No memories yet. Add one with `elanous memory add <type> "<name>" "<description>"`.');
      return;
    }
    ui.header(`memories (${entries.length})`);
    for (const e of entries) {
      console.log(`  ${e.id.slice(0, 8)}  [${e.type.padEnd(9)}]  ${e.name}`);
      if (e.description) console.log(`             ${e.description.slice(0, 100)}`);
    }
  });

memCmd
  .command('add <type> <name> [description...]')
  .description('Create a memory (type: user|feedback|project|reference). Body piped via stdin if available.')
  .action(async (type: string, name: string, descParts: string[]) => {
    if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
      ui.error(`invalid type "${type}". Use: user | feedback | project | reference`);
      process.exit(1);
    }
    const description = (descParts || []).join(' ');
    // Read body from stdin if piped; otherwise use description as body too.
    let body = description;
    const pipedBody = await readPipedStdin();   // ★ OBS-T3 — 비-TTY 는 파이프를 뜻하지 않는다(소켓이면 EOF 가 안 온다)
    if (pipedBody) body = pipedBody;
    const e = saveMemory({ type: type as MemoryType, name, description, body });
    ui.info(`saved ${e.id.slice(0, 8)} [${e.type}] "${e.name}"`);
  });

// 3번째 recall 레버(2026-07-19) — pin(항상주입) / priority(매칭 시 순위 부스트).
memCmd
  .command('pin <idPrefix>')
  .description('Pin a memory so it is ALWAYS injected (bypass keyword gate). Optionally set priority.')
  .option('-p, --priority <n>', 'priority boost (higher = ranked/kept first)', '5')
  .action((prefix: string, opts: { priority: string }) => {
    const e = loadMemory(prefix);
    if (!e) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    saveMemory({ type: e.type, name: e.name, description: e.description, body: e.body, id: e.id, pinned: true, priority: parseInt(opts.priority, 10) || 0 });
    ui.info(`📌 pinned ${e.id.slice(0, 8)} "${e.name}" (priority ${opts.priority})`);
  });

memCmd
  .command('unpin <idPrefix>')
  .description('Un-pin a memory (back to keyword-gated recall).')
  .action((prefix: string) => {
    const e = loadMemory(prefix);
    if (!e) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    saveMemory({ type: e.type, name: e.name, description: e.description, body: e.body, id: e.id, pinned: false, priority: e.priority });
    ui.info(`unpinned ${e.id.slice(0, 8)} "${e.name}"`);
  });

memCmd
  .command('priority <idPrefix> <n>')
  .description('Set a memory\'s injection priority boost (0 = default). Added to match score.')
  .action((prefix: string, n: string) => {
    const e = loadMemory(prefix);
    if (!e) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    saveMemory({ type: e.type, name: e.name, description: e.description, body: e.body, id: e.id, priority: parseInt(n, 10) || 0, pinned: e.pinned });
    ui.info(`priority ${e.id.slice(0, 8)} "${e.name}" → ${parseInt(n, 10) || 0}`);
  });

// 통합 관리 뷰(2026-07-19) — 2 시스템(큐레이션 파일메모리 + 에피소드 self-log)을 한 화면에.
memCmd
  .command('status')
  .description('Unified memory overview — ① curated file-memory + ② self-log (surface_events)')
  .action(async () => {
    const { memoryRoot } = await import('./memory.js');
    const mems = listMemories();
    const byType: Record<string, number> = {};
    let pinned = 0;
    for (const e of mems) { byType[e.type] = (byType[e.type] ?? 0) + 1; if (e.pinned) pinned += 1; }
    ui.header('memory (unified)');
    console.log(`① 큐레이션 파일메모리: ${mems.length}건  [${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}]  📌pinned ${pinned}`);
    console.log(`   ${memoryRoot()}  (LLM-judge/luna recall · MEMORY.md 항상주입)`);
    try {
      const { surfaceEventsDbPath, openSurfaceEventsDb } = await import('./domains/surface-events.js');
      const path = surfaceEventsDbPath();
      // 항상 open — legacy conatus/ → memory/ 자가치유 마이그레이션이 여기서 실행된다(존재 체크 먼저
      // 하면 신 경로 부재로 마이그레이션이 스킵됨). 없으면 빈 store 생성(무해).
      const db = openSurfaceEventsDb(path);
      const n = (db.prepare('SELECT count(*) c FROM events').get() as { c: number }).c;
      const recent = (db.prepare('SELECT ts FROM events ORDER BY ts DESC LIMIT 1').get() as { ts: string } | undefined)?.ts;
      db.close();
      console.log(`② 에피소드 self-log: ${n.toLocaleString()} events  (최근 ${recent?.slice(0, 16) ?? '-'})`);
      console.log(`   ${path}  (FTS5 bm25+recency+myelin rerank · ambient 회상)`);
    } catch (e) { console.log(`② self-log 조회 실패: ${(e as Error).message}`); }
    try {
      const { openKnowledgeDb, knowledgeDbPath } = await import('./domains/knowledge.js');
      const kdb = openKnowledgeDb(); // 기본 경로 → legacy conatus/ 자가치유 이전
      const kn = (kdb.prepare('SELECT count(*) c FROM docs').get() as { c: number }).c;
      const dom = (kdb.prepare("SELECT domain, count(*) c FROM docs GROUP BY domain ORDER BY c DESC LIMIT 3").all() as Array<{ domain: string | null; c: number }>);
      kdb.close();
      console.log(`③ 시맨틱 knowledge: ${kn.toLocaleString()} docs  [${dom.map(d => `${d.domain ?? 'null'}:${d.c}`).join(' ')}]`);
      console.log(`   ${knowledgeDbPath()}  (임베딩 벡터+BM25 하이브리드 · 의미 회상)`);
    } catch (e) { console.log(`③ knowledge 조회 실패: ${(e as Error).message}`); }
  });

memCmd
  .command('show <idPrefix>')
  .description('Print full memory body')
  .action((prefix: string) => {
    const entries = listMemories();
    const hit = entries.find(e => e.id.startsWith(prefix));
    if (!hit) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    const full = loadMemory(hit.id)!;
    ui.header(`${full.type}: ${full.name}`);
    console.log(`  id          ${full.id}`);
    console.log(`  created     ${full.createdAt}`);
    console.log(`  updated     ${full.updatedAt}`);
    console.log(`  description ${full.description}`);
    console.log('');
    console.log(full.body);
  });

memCmd
  .command('search <query...>')
  .description('Keyword search across all memories')
  .option('--type <t>', 'Filter by type')
  .option('-n, --limit <n>', 'Max results', '10')
  .action((parts: string[], opts) => {
    const hits = searchMemories(parts.join(' '), {
      type: opts.type as MemoryType | undefined,
      limit: parseInt(opts.limit, 10),
    });
    if (hits.length === 0) { ui.info('No matches.'); return; }
    ui.header(`matches (${hits.length})`);
    for (const h of hits) {
      console.log(`  ${h.entry.id.slice(0, 8)}  score ${h.score}  [${h.entry.type}]  ${h.entry.name}`);
      if (h.entry.description) console.log(`             ${h.entry.description.slice(0, 100)}`);
    }
  });

memCmd
  .command('delete <idPrefix>')
  .description('Delete a memory')
  .action((prefix: string) => {
    const entries = listMemories();
    const hit = entries.find(e => e.id.startsWith(prefix));
    if (!hit) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    deleteMemory(hit.id);
    ui.info(`deleted ${hit.id.slice(0, 8)}`);
  });

memCmd
  .command('index')
  .description('Print MEMORY.md index verbatim')
  .action(() => {
    const idx = readIndex();
    if (!idx) { ui.info('empty (no memories yet)'); return; }
    console.log(idx);
  });

memCmd
  .command('where')
  .description('Show the memory storage path')
  .action(() => {
    console.log(`memory dir   ${memoryRoot()}`);
    console.log(`index file   ${memoryIndexPath()}`);
  });

// ── self (self-awareness memory — 외부 도구가 elanous 구현 이력을 주입/회상) ──
// ── decide (Jev · System One — ⛔ 텍스트를 «생성하지 않는다». 확률이 붙은 판정만 받는다) ──
program
  .command('decide <question>')
  .description('Jev(System One)에게 «확률이 붙은» 판정 하나를 묻는다 — 기본 예/아니오. 📚 docs/manual/MANUAL-typesafe-jev-system-one-2026-09-20.md')
  .option('-s, --state <text>', '판단 근거가 되는 상황(글 또는 JSON 파일 경로)')
  .option('-c, --choice <a,b,c>', '선택지 — 주면 Choice 로 묻는다(⛔ options 가 아니라 criteria 로 나간다)')
  .option('-l, --scale <나쁨,...,좋음>', '레벨 2~10 — 주면 Score 로 묻는다. ⛔ 방향을 «나쁨→좋음»으로 고정하라')
  .option('--min-prob <n>', '자동 판정 임계(최상위 확률)', '0.9')
  .option('--min-conf <n>', '자동 판정 임계(신뢰도)', '0.7')
  .option('--json', 'JSON 그대로 출력')
  .option('-f, --file <questions.json>', '⭐ Fan-Out — {state, questions} 파일로 «여러 질문을 한 호출에». 이때 <question> 인자는 무시된다')
  .action(async (question: string, opts: { state?: string; choice?: string; scale?: string; minProb: string; minConf: string; json?: boolean; file?: string }) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { buildQuestion, callJev, describeScore, gateAnswer, probeKey } = await import('./decide/jev.js');

    const jevAccess = await loadJevAccessOrExit();
    const key = jevAccess.key;

    // ⭐ Fan-Out — 공식 패턴. 한 state 에 여러 질문을 «한 호출»에 보낸다.
    //   📏 실측: 질문 5개를 따로 부르면 2,080토큰·5.7초 · 한 번에 보내면 671토큰·0.8초(3.1배 싸다)
    if (opts.file) {
      const { parseFanOutFile } = await import('./decide/jev.js');
      // ⛔ 사용자 파일의 오류는 «스택 트레이스»로 내지 않는다 — 문면 하나 ⊕ rc 2.
      //   (`MANUAL-harness-entrance-live-verification`: *"스택 트레이스면 실패"*)
      let fan: import('./decide/jev.js').FanOutFile;
      try {
        fan = parseFanOutFile(readFileSync(opts.file, 'utf8'));
      } catch (error) {
        console.error(`⛔ ${opts.file}: ${error instanceof Error ? error.message : String(error)}`);
        console.error('   모양: {"state": <상황>, "questions": {"<이름>": {"type":"noul|choice|score","instructions":"…"}}}');
        process.exit(2);
      }
      const r = await callJev({ state: fan.state, questions: fan.questions, ...((fan.model ?? jevAccess.model) ? { model: fan.model ?? jevAccess.model } : {}) }, key, fetch, jevAccess.endpoint);
      if (opts.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
      console.log(`모델   ${r.model}`);
      let escalations = 0;
      for (const [name, ans] of Object.entries(r.answers)) {
        const g = gateAnswer(ans, Number(opts.minProb), Number(opts.minConf));
        if (g.verdict === 'escalate') escalations += 1;
        const body = ans.type === 'noul' ? `예일 확률 ${(ans.noul ?? 0).toFixed(2)}`
          : ans.type === 'choice' ? `${ans.choice} (신뢰도 ${(ans.confidence ?? 0).toFixed(2)})`
          : `${describeScore(ans)} (신뢰도 ${(ans.confidence ?? 0).toFixed(2)})`;
        console.log(`  ${g.verdict === 'act' ? '✅' : '⚠️'} ${name.padEnd(18)} ${body}`);
      }
      const n = Object.keys(r.answers).length;
      console.log(`\n질문 ${n}개 · 자동 가능 ${n - escalations} · 사람에게 ${escalations}`);
      if (r.usage) console.log(`비용   입력 ${r.usage.input_tokens} 토큰 (질문당 ≈ ${Math.round((r.usage.input_tokens ?? 0) / n)})`);
      // ⛔ 하나라도 에스컬레이션이면 3 — 「전부 자동 가능」일 때만 0 이다.
      process.exit(escalations === 0 ? 0 : 3);
    }

    let state: unknown = opts.state ?? '';
    if (typeof state === 'string' && state.endsWith('.json') && existsSync(state)) {
      state = JSON.parse(readFileSync(state, 'utf8'));
    }
    const split = (v?: string) => v?.split(',').map((x) => x.trim()).filter(Boolean);
    const kind = opts.choice ? 'choice' : opts.scale ? 'score' : 'noul';
    const q = buildQuestion(kind, question, split(opts.choice) ?? split(opts.scale));

    const res = await callJev({ state, questions: { q }, ...(jevAccess.model ? { model: jevAccess.model } : {}) }, key, fetch, jevAccess.endpoint);
    if (opts.json) { await writeStdoutJson(JSON.stringify(res, null, 2) + '\n'); return; }

    const a = res.answers.q!;
    const gate = gateAnswer(a, Number(opts.minProb), Number(opts.minConf));
    console.log(`모델   ${res.model}`);
    if (a.type === 'noul') console.log(`답     예일 확률 ${(a.noul ?? 0).toFixed(2)}`);
    if (a.type === 'choice') console.log(`답     ${a.choice}   (신뢰도 ${(a.confidence ?? 0).toFixed(2)})`);
    if (a.type === 'score') console.log(`답     ${describeScore(a)}   (신뢰도 ${(a.confidence ?? 0).toFixed(2)})`);
    if (a.probabilities) {
      console.log('분포');
      for (const [k, v] of Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])) {
        console.log(`  ${'█'.repeat(Math.round(v * 20)).padEnd(20, '·')} ${v.toFixed(2)}  ${k}`);
      }
    }
    console.log(`판정   ${gate.verdict === 'act' ? '✅ 자동 가능' : '⚠️ 사람에게'} — ${gate.why}`);
    if (res.usage) console.log(`비용   입력 ${res.usage.input_tokens} 토큰 (출력 무료)`);
    // ⛔ 종료 코드로도 갈린다 — 셸이 그대로 분기할 수 있게(0=자동 가능 · 3=에스컬레이션)
    process.exit(gate.verdict === 'act' ? 0 : 3);
  });

// ── ax-screen (기업 AX — 업무 목록을 «자동화 후보»로 거른다) ──
program
  .command('ax-screen <tasks.json>')
  .description('업무 목록을 Jev 로 스크리닝해 자동화 후보 순위를 낸다. 📚 docs/manual/MANUAL-ax-task-screening-2026-09-20.md')
  .option('--json', 'JSON 출력')
  .option('--concurrency <n>', '동시 호출 수', '8')
  .action(async (file: string, opts: { json?: boolean; concurrency: string }) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { callJev, probeKey } = await import('./decide/jev.js');
    const { AX_QUESTIONS, AX_TIER_ORDER, axVerdict, stateForModel } = await import('./decide/ax-screen.js');
    type AxTask = import('./decide/ax-screen.js').AxTask;
    type AxAnswers = import('./decide/ax-screen.js').AxAnswers;

    const jevAccess = await loadJevAccessOrExit();
    const key = jevAccess.key;
    const tasks = JSON.parse(readFileSync(file, 'utf8')) as AxTask[];

    const limit = Math.max(1, Number(opts.concurrency) || 8);
    const out: Array<{ t: AxTask; a: AxAnswers; tokens: number }> = [];
    for (let i = 0; i < tasks.length; i += limit) {
      const batch = await Promise.all(tasks.slice(i, i + limit).map(async (t) => {
        // ⛔ 사람의 칸(_설명 · 정답_*)을 «빼고» 보낸다 — 안 빼면 모델이 정답을 보고 답한다.
        const r = await callJev({ state: stateForModel(t), questions: AX_QUESTIONS, ...(jevAccess.model ? { model: jevAccess.model } : {}) }, key, fetch, jevAccess.endpoint);
        return { t, a: r.answers as unknown as AxAnswers, tokens: r.usage?.input_tokens ?? 0 };
      }));
      out.push(...batch);
    }
    const rows = out.map(({ t, a, tokens }) => ({ t, a, tokens, v: axVerdict(t, a) }))
      .sort((x, y) => AX_TIER_ORDER[x.v.tier] - AX_TIER_ORDER[y.v.tier] || y.v.score - x.v.score);

    if (opts.json) { await writeStdoutJson(JSON.stringify(rows.map((r) => ({ ...r.t, ...r.v })), null, 2) + '\n'); return; }
    console.log(`${'등급'.padEnd(11)}${'ID'.padEnd(5)}${'업무'.padEnd(34)}${'반복'.padStart(5)}${'닫힘'.padStart(6)}${'추출'.padStart(6)}${'되돌'.padStart(6)}  사유`);
    console.log('─'.repeat(112));
    for (const { t, a, v } of rows) {
      console.log(`${v.tier.padEnd(11)}${t.id.padEnd(5)}${t.업무.slice(0, 32).padEnd(34)}${a.repetition.score.toFixed(1).padStart(5)}${a.closed_set.noul.toFixed(2).padStart(6)}${a.extraction.noul.toFixed(2).padStart(6)}${a.reversible.noul.toFixed(2).padStart(6)}  ${v.why}`);
    }
    const tok = out.reduce((n, r) => n + r.tokens, 0);
    const unknown = rows.filter((r) => r.v.tier === '⛔ 못 잰다').length;
    console.log(`\n업무 ${rows.length}건 · 입력 ${tok.toLocaleString()} 토큰 · 비용 ≈ $${(tok * 0.042 / 1e6).toFixed(4)}`);
    if (unknown) console.log(`⛔ 「현재판단」 칸이 빈 업무 ${unknown}건 — 순위를 매기지 «않았다». 인터뷰로 채워라.`);
  });

// ── decide-recipe (⛔ 「Claude 없이 도는 결정」 — 질문이 파일에 «고정»되어 있다) ──
program
  .command('decide-recipe <name> <state.json>')
  .description('이름 붙은 레시피로 판정한다. 질문은 recipes/<name>.json 에 «고정»되어 있다 — 매번 짓지 않는다.')
  .option('--recipes-dir <dir>', '레시피 디렉토리', 'recipes')
  .option('--json', 'JSON 출력')
  .action(async (name: string, stateFile: string, opts: { recipesDir: string; json?: boolean }) => {
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { callJev, gateAnswer, probeKey } = await import('./decide/jev.js');
    const { decideByRecipe, missingStateKeys, parseRecipe } = await import('./decide/recipe.js');

    const file = join(opts.recipesDir, `${name}.json`);
    if (!existsSync(file)) {
      const have = existsSync(opts.recipesDir)
        ? readdirSync(opts.recipesDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
        : [];
      console.error(`⛔ 레시피 '${name}' 이 없다 (${file})`);
      console.error(`   있는 것: ${have.length ? have.join(' · ') : '(없음)'}`);
      process.exit(2);
    }
    let recipe: import('./decide/recipe.js').Recipe;
    try { recipe = parseRecipe(readFileSync(file, 'utf8'), name); }
    catch (e) { console.error(`⛔ ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }

    const state: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
    // ⛔⭐ 「모른다」를 접지 않는다 — 필수 칸이 비면 «돌리지 않는다».
    const missing = missingStateKeys(recipe, state);
    if (missing.length) {
      console.error(`⛔ ${stateFile} 에 필수 칸이 없다: ${missing.join(' · ')}`);
      console.error(`   ${recipe.name} 이 요구하는 것: ${recipe.requiredStateKeys.join(' · ')}`);
      process.exit(2);
    }

    const jevAccess = await loadJevAccessOrExit();
    const key = jevAccess.key;

    const r = await callJev({ state, questions: recipe.questions, ...(jevAccess.model ? { model: jevAccess.model } : {}) }, key, fetch, jevAccess.endpoint);
    const d = decideByRecipe(recipe, r.answers as never, gateAnswer as never);
    if (opts.json) { await writeStdoutJson(JSON.stringify({ recipe: recipe.name, ...r, verdict: d.verdict, reasons: d.reasons }, null, 2) + '\n'); }
    else {
      console.log(`레시피 ${recipe.name}  —  ${recipe.description}`);
      for (const [qn, a] of Object.entries(r.answers)) {
        const body = a.type === 'noul' ? `${(a.noul ?? 0).toFixed(2)}`
          : a.type === 'choice' ? `${a.choice} (${(a.confidence ?? 0).toFixed(2)})`
          : `${(a.score ?? 0).toFixed(2)} (${(a.confidence ?? 0).toFixed(2)})`;
        console.log(`  ${qn.padEnd(18)} ${body}`);
      }
      console.log(`판정   ${d.verdict === 'act' ? '✅ 자동 가능' : '⚠️ 사람에게'}`);
      for (const why of d.reasons) console.log(`       ${why}`);
      if (r.usage) console.log(`비용   입력 ${r.usage.input_tokens} 토큰`);
    }
    process.exit(d.verdict === 'act' ? 0 : 3);
  });

program
  .command('signals')
  .description('신호 파이프라인 퍼널(READ-ONLY) — 유입→분류→critical→2차→확정→집행 각 단계 수·통과율·갭. 게이트 튜닝 판단 근거.')
  .option('--json', 'JSON 출력')
  .action(async (opts: { json?: boolean }) => {
    const { SignalPool } = await import('./domains/signal-pool.js');
    const { buildFunnelReport } = await import('./domains/signal-funnel.js');
    const pool = new SignalPool();
    try {
      const report = buildFunnelReport(pool.metricsSnapshot());
      if (opts.json) { await writeStdoutJson(JSON.stringify({ snapshot: report.snapshot, metrics: report.metrics, gaps: report.gaps }, null, 2) + '\n'); return; }
      for (const line of report.lines) ui.info(line);
    } finally { pool.close(); }
  });

program
  .command('loops')
  .description('루프 에이전트 자산 원장(READ-ONLY) — 목표까지 반복하는 실행 주체(계약/자율/코디네이터)를 미션연관·독립·라이프사이클별로. 좀비(TTL 초과) 감지.')
  .option('--mission <id>', '미션 귀속만')
  .option('--standalone', '독립/시스템(미션무관)만')
  .option('--kind <k>', 'autonomous|contract|coordinator')
  .option('--zombies', 'TTL 초과 좀비만')
  .option('--json')
  .action(async (o: { mission?: string; standalone?: boolean; kind?: string; zombies?: boolean; json?: boolean }) => {
    const { openSurfaceEventsDb } = await import('./domains/surface-events.js');
    const { listLoopAgents, detectZombieLoops } = await import('./domains/loop-agent-registry.js');
    const db = openSurfaceEventsDb();
    try {
      const list = o.zombies ? detectZombieLoops(db, Date.now())
        : listLoopAgents(db, {
            ...(o.mission ? { missionId: o.mission } : {}),
            ...(o.standalone ? { standaloneOnly: true } : {}),
            ...(o.kind ? { loopKind: o.kind as 'autonomous' | 'contract' | 'coordinator' } : {}),
          });
      if (o.json) { await writeStdoutJson(JSON.stringify(list, null, 2) + '\n'); return; }
      ui.header(`루프 에이전트 원장 (${list.length}${o.zombies ? '·좀비' : ''})`);
      for (const l of list) {
        const link = l.missionId ? `미션 ${l.missionId.slice(0, 40)}` : '독립/시스템';
        const res = [...l.scheduleIds.map((s) => `크론:${s}`), ...l.taskIds.map((t) => `태스크:${t}`)].join(' ');
        console.log(`  ◆ [${l.loopKind}/${l.lifecycle}${l.ttlMin ? `·TTL${l.ttlMin}m` : ''}] ${l.name.slice(0, 40)}`);
        console.log(`     ${link}${res ? ` · ${res}` : ''}${l.createdByLoop ? ` · 상위루프 ${l.createdByLoop}` : ''}`);
      }
      if (!list.length) console.log('  (등록된 루프 에이전트 없음 — 크론 부트 시 자기등록)');
      // ★ 역방향 정합성(대표 2026-07-16) — schedule_registry 의 loop 사이클 크론(registerLoopAgentSafe
      //   호출)인데 루프 원장 미등록인 것 경고("도는데 미등록" 사각지대·market-posture 사건). READ-ONLY.
      if (!o.zombies && !o.mission && !o.standalone && !o.kind) {
        try {
          const { detectUnregisteredLoopCrons, isSelfRegisteringLoopScript, listLoopAgents: listAll } = await import('./domains/loop-agent-registry.js');
          const { openSchedulesDb, listSchedules } = await import('./domains/schedule-registry.js');
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const readSource = (p: string): string | null => { try { const f = join(process.cwd(), p); return existsSync(f) ? readFileSync(f, 'utf8') : null; } catch { return null; } };
          const sdb = openSchedulesDb();
          try {
            const loopCrons = listSchedules(sdb).filter((c) => c.command && isSelfRegisteringLoopScript(c.command, readSource));
            const unreg = detectUnregisteredLoopCrons(listAll(db, {}), loopCrons);
            if (unreg.length) {
              console.log(`\n  ⚠️ 미등록 루프 ${unreg.length} — loop 사이클 크론인데 루프 원장 미등록(자기등록 배선 누락 의심):`);
              for (const c of unreg) console.log(`     크론:${c.id} · ${(c.command ?? '').slice(0, 70)}`);
              console.log('     → 스크립트에 registerLoopAgentSafe 자기등록 추가(계약루프 패턴).');
            }
          } finally { sdb.close(); }
        } catch { /* fail-soft */ }
      }
    } finally { db.close(); }
  });

program
  .command('buzz')
  .description('커뮤니티 버즈 온디맨드 브리핑 — 수집분 조회 + stale(밤/주말)이면 실시간 그랩 폴백. 매매 아님(정성 신호).')
  .option('--live', 'stale 무관 실시간 그랩(fmkorea 라이브)')
  .option('--hours <n>', '수집분 조회 창(시간)', '8')
  .option('--json', 'JSON 출력')
  .action(async (opts: { live?: boolean; hours: string; json?: boolean }) => {
    const { assessFreshness, aggregateLiveBuzz, formatBuzzBriefing } = await import('./domains/buzz-briefing.js');
    const { Database } = await import('bun:sqlite');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const nowMs = Date.now();
    const buzzPath = conatusPath('community_buzz.db');
    let lastPostIso: string | null = null;
    try {
      const bdb = new Database(buzzPath, { readonly: true });
      try { lastPostIso = (bdb.prepare(`SELECT MAX(ts) AS t FROM buzz_posts`).get() as { t: string | null }).t; } finally { bdb.close(); }
    } catch { /* no db */ }
    const freshness = assessFreshness(lastPostIso, nowMs);
    const goLive = !!opts.live || freshness.stale;
    let briefing: import('./domains/buzz-briefing.js').BuzzBriefing;
    if (!goLive) {
      const { SignalPool } = await import('./domains/signal-pool.js');
      const pool = new SignalPool();
      try {
        const sinceIso = new Date(nowMs - (parseInt(opts.hours, 10) || 8) * 3_600_000).toISOString();
        const nar = pool.topCommunityNarratives(sinceIso, 10).map((n) => ({ narrative: n.narrative, count: n.count, sample: n.sample }));
        briefing = { mode: 'collected', freshness, narratives: nar };
      } finally { pool.close(); }
    } else {
      const { fetchFmkoreaList } = await import('./domains/community-buzz/fetch.js');
      const { parseFmkoreaPopular, parseFmkoreaList } = await import('./domains/community-buzz/parse-fmkorea.js');
      const { normalizeText } = await import('./domains/community-buzz/normalize.js');
      const { loadSlangEntries } = await import('./domains/community-buzz/slang-dict.js');
      let entries: Parameters<typeof normalizeText>[1] = [];
      try {
        const bdb = new Database(buzzPath, { readonly: true });
        try { entries = loadSlangEntries(bdb); } finally { bdb.close(); }
      } catch { /* seed 없음 → cashtag 만 */ }
      const POP = 'https://www.fmkorea.com/index.php?mid=stock&sort_index=pop&order_type=desc';
      const posts: Array<{ title: string; recommends?: number; url: string }> = [];
      try { posts.push(...parseFmkoreaPopular(await fetchFmkoreaList({ url: POP, waitFor: 4000 }), nowMs)); } catch { /* pop 실패 */ }
      try { posts.push(...parseFmkoreaList(await fetchFmkoreaList({ waitFor: 4000 }), nowMs)); } catch { /* firehose 실패 */ }
      const { narratives, hotPosts } = aggregateLiveBuzz(posts, (t) => normalizeText(t, entries).tickers);
      briefing = { mode: 'live', freshness, narratives, hotPosts };
    }
    if (opts.json) { await writeStdoutJson(JSON.stringify(briefing, null, 2) + '\n'); return; }
    process.stdout.write(formatBuzzBriefing(briefing) + '\n');
  });

// ── harness (dev-harness 유지보수) ──
type HarnessMissionLoopDeps = {
  runMissionSolveLoop: typeof import('./harness/mission-solve-loop.js').runMissionSolveLoop;
  openAutopilotMissionsDb: typeof import('./autopilot/mission-registry.js').openAutopilotMissionsDb;
  getMission: typeof import('./autopilot/mission-registry.js').getMission;
  defaultSeams: typeof import('./self-implement/seams.js').defaultSeams;
  childInstanceScope: typeof import('./instance/child-scope.js').childInstanceScope;
  surfaceUxFromDispatchCtx: typeof import('./agent/surface-ux/build.js').surfaceUxFromDispatchCtx;
  solveMissionViaHarness: typeof import('./harness/mission-harness.js').solveMissionViaHarness;
};

let harnessMissionLoopDepsForTesting: HarnessMissionLoopDeps | undefined;

export function setHarnessMissionLoopDepsForTesting(deps: HarnessMissionLoopDeps | undefined): void {
  harnessMissionLoopDepsForTesting = deps;
}

async function loadHarnessMissionLoopDeps(): Promise<HarnessMissionLoopDeps> {
  if (harnessMissionLoopDepsForTesting) return harnessMissionLoopDepsForTesting;
  const [
    { runMissionSolveLoop },
    { openAutopilotMissionsDb, getMission },
    { defaultSeams },
    { childInstanceScope },
    { surfaceUxFromDispatchCtx },
    { solveMissionViaHarness },
  ] = await Promise.all([
    import('./harness/mission-solve-loop.js'),
    import('./autopilot/mission-registry.js'),
    import('./self-implement/seams.js'),
    import('./instance/child-scope.js'),
    import('./agent/surface-ux/build.js'),
    import('./harness/mission-harness.js'),
  ]);
  return { runMissionSolveLoop, openAutopilotMissionsDb, getMission, defaultSeams, childInstanceScope, surfaceUxFromDispatchCtx, solveMissionViaHarness };
}

async function runHarnessMissionLoop(
  missionIds: readonly string[],
  opts: { executor?: 'self-implement' },
) {
  const {
    runMissionSolveLoop,
    openAutopilotMissionsDb,
    getMission,
    defaultSeams,
    childInstanceScope,
    surfaceUxFromDispatchCtx,
    solveMissionViaHarness,
  } = await loadHarnessMissionLoopDeps();
  const store = openAutopilotMissionsDb();
  try {
    return await runMissionSolveLoop({
      missionIds,
      readMission: (missionId) => getMission(store, missionId),
      seams: defaultSeams(childInstanceScope()),
      ux: surfaceUxFromDispatchCtx({}),
      solve: (input) => solveMissionViaHarness({ ...input, ...opts }),
    });
  } finally {
    store.close();
  }
}

const harnessCmd = installHarnessCliCommand(program, {
  registerSink: async (surface) => { await (await import('./domains/standalone-log-sink.js')).registerStandaloneLogSink(surface); },
  resolveSurface: async () => {
    const { getHarnessSpace, harnessSpaceSurface } = await import('./harness/harness-space.js');
    const space = getHarnessSpace();
    return space ? harnessSpaceSurface(space) : 'harness';
  },
  ask: runDevAskFromGoalFile,
  say: runDevSayFromWords,
  // ⛔⭐ `plan` 핸들러를 «주지 않는다» — 그러면 하위 명령이 RFC 문(`runHarnessPlanRfc`)으로 간다.
  //   🩸 여기에 `runDevPlanFromWords` 를 주면 그것이 «항상» 이겨서 RFC 문은 운영에서 «절대 안 돈다»
  //     (그 함수는 planStaged dispatch → 대표 2026-09-04 은퇴한 staged 하니스로 간다).
  //   ⇒ 즉 이 «한 줄»이 은퇴를 되돌린다. 주입 자리는 시험용으로 남는다.
  mission: async (missionId, opts) => {
    await dispatchSolveMission({ mission_id: missionId, ...opts });
  },
  missionLoop: runHarnessMissionLoop,
});

// (internal) 데몬이 dev-harness 를 subprocess 로 위임(#24 A) — 하니스 동기 op 가 데몬 이벤트루프를
//   굶기지 않게 별도 프로세스에서 실행. base64 JSON 인자·auto_drive on 전제(비인터랙티브)·결과는 RESULT: 라인.
harnessCmd
  .command('run-detached <payload>', { hidden: true })
  .description('(internal) 데몬 위임용 — dev-harness 를 이 프로세스에서 실행하고 결과를 RESULT: 로 출력')
  .action(async (payload: string) => {
    const { decodeDetachedPayload } = await import('./harness/dispatch-detached.js');
    const { createDetachedHitlChild } = await import('./harness/detached-hitl.js');
    const { dispatchRunDevHarness } = await import('./skills/tools/dev-harness.js');
    try {
      const rawArgs = decodeDetachedPayload(payload);
      // ★ 위임 종류 분기(P3) — 부모가 `_detachedKind` 로 어떤 자율툴을 격리 실행할지 지정. 기본=dev-harness.
      //   solve-mission = 기존 미션 read-only solve(SolveMission). 자식 ctx(HITL IPC 채널)는 공통.
      const detachedKind = typeof rawArgs._detachedKind === 'string' ? rawArgs._detachedKind : 'dev-harness';
      const runDetachedDispatch = detachedKind === 'solve-mission'
        ? (await import('./skills/tools/solve-mission.js')).dispatchSolveMission
        : dispatchRunDevHarness;
      // ★ 진행 릴레이 — 하니스 진행(ux.progress→emitFeedback)을 stdout `PROGRESS:` 로 내보내면 데몬이
      //   읽어 surface(telegram)로 relay(라이브 카드). ELANOUS_HARNESS_DETACHED=1 이라 재위임 안 함.
      // ★ #24 완결 — off/safe HITL 릴레이: 자식의 confirm/question 을 IPC-백드 채널로 만들어 ctx 에
      //   심는다. ux.confirm/question(surfaceUxFromDispatchCtx)이 무변경으로 이 채널을 race → stdout
      //   `HITLREQ:` emit → 부모가 진짜 채널로 물어 stdin `HITLRES:` 회신 → resolve. 부모가 relay 를
      //   안 넘기면 부모측이 fail-closed 회신(off/safe 비인터랙티브와 동일). auto_drive on 도 심어 두면
      //   apply-in-place diff 확인(항상 HITL)이 detached 에서도 정상 동작(기존엔 채널 없어 fail-closed).
      const hitl = createDetachedHitlChild((line) => process.stdout.write(`${line}\n`));
      process.stdin.on('data', (d: Buffer) => hitl.onStdinChunk(d.toString()));
      process.stdin.unref?.();
      // ⚠️ 한샷 subprocess 종료 보장 — RESULT 를 flush 한 뒤 **강제 종료**. off/safe HITL 은 자식이
      //   requestConfirmation/requestQuestion 을 쓰는데, 그 120s fallback 타임아웃 타이머가 답 도착
      //   후에도 clearTimeout/unref 없이 남아 자식 이벤트루프를 붙잡는다(데몬에선 무해하나 한샷 자식은
      //   exit 못 해 부모가 매달림 — 스모크 실측). 하니스는 이미 await 완료라 강제 종료가 안전.
      const finish = (line: string, code: number): void => {
        try { process.stdout.write(line, () => process.exit(code)); }
        catch { process.exit(code); }
      };
      const detachedCtx = {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        emitFeedback: emitDetachedProgress,
        surfaceHitlChannels: [hitl.confirmChannel],
        surfaceQuestionChannels: [hitl.questionChannel],
      } as unknown as Parameters<typeof dispatchRunDevHarness>[1];
      const res = await runDetachedDispatch(rawArgs, detachedCtx);
      finish(`\nRESULT:${res.output.replace(/\n/g, ' ⏎ ')}\n`, 0);
    } catch (e) {
      try { process.stdout.write(`\nRESULT:RunDevHarness ⚠️ run-detached 실패: ${String((e as { message?: string })?.message ?? e).slice(0, 200)}\n`, () => process.exit(1)); }
      catch { process.exit(1); }
    }
  });
harnessCmd
  .command('stop <runId>')
  .description('런 하나를 멈춘다 — pid.json 시작 시각 대조 ⊕ 런 발사 프로세스 표 조회 ⊕ 라벨 elanous.run=<runId> Pod Job')
  .option('--context <ctx...>', 'kube 문맥(여러 번 · 기본 = 알려진 문맥 전부)')
  .option('--json', 'JSON 출력')
  .option('--dry-run', '프로세스 후보만 보고 신호·Pod Job 삭제는 하지 않는다')
  .action(async (runId: string, opts: { context?: string[]; json?: boolean; dryRun?: boolean }) => {
    const { stopHarnessRun, defaultHarnessStopDeps, formatHarnessStop } = await import('./harness/harness-stop.js');
    try {
      const result = await stopHarnessRun(runId, defaultHarnessStopDeps(), opts.context, opts.dryRun === true);
      process.stdout.write(`${opts.json ? JSON.stringify(result) : formatHarnessStop(result)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  });
harnessCmd
  .command('clean')
  // ⛔ 접두를 문면에 «리터럴로» 적지 않는다 — #6984 로 기본 접두는 «만드는 쪽 상수»에서 온다.
  //    종전 설명은 옛 접두를 리터럴로 달고 있어 «도구가 자기가 무엇을 보는지 틀리게 말했다»(2026-08-04 실측).
  //    ⭐ 그리고 그 리터럴을 여기 주석으로 적었다가 harness-clean 회귀에 물렸다 — 규칙이 옳다.
  // ⛔ 이 문면에 접두 «옵션 이름»을 적지 않는다 — 회귀가 help 에서 그 이름이 든 줄을 찾아
  //    거기서 실제 접두를 확인하는데, 설명이 그 이름을 담으면 «설명 줄이 먼저 잡혀» 회귀가 운다(실측).
  .description('하니스 disposable worktree + 브랜치 정리(기본 접두는 만드는 쪽 상수에서 온다). ⚠️ 열린 PR 은 항상 보존. 기본 dry-run(계획만·--yes 로 실제 제거).')
  .option('--abandoned', 'PR 이력 없는 것(escalated/방치) 제거 [기본]')
  .option('--merged', 'PR 머지된 것 제거')
  .option('--all', '열린 PR 외 전부 제거')
  .option('--force', '열린 PR 브랜치도 제거(위험)')
  .option('--yes', '실제 제거(생략 시 dry-run)')
  .option('--prefix <p>', `브랜치 prefix(기본 ${WORKTREE_BRANCH_PREFIX_HELP})`)
  .option('--repo <repo>', 'gh repo(기본 origin 추론)')
  .option('--json', '구조화 출력')
  .action(async (opts: { abandoned?: boolean; merged?: boolean; all?: boolean; force?: boolean; yes?: boolean; prefix?: string; repo?: string; json?: boolean }) => {
    const { execHarnessClean } = await import('./harness/harness-clean.js');
    const mode = opts.all ? 'all' : opts.merged ? 'merged' : 'abandoned';
    const res = execHarnessClean({
      mode, dryRun: !opts.yes,
      ...(opts.force ? { force: true } : {}),
      ...(opts.prefix ? { branchPrefix: opts.prefix } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
    });
    if (opts.json) { await writeStdoutJson(JSON.stringify(res) + '\n'); return; }
    // ⭐ 화면 조립은 `harness-clean.ts` 의 순수 함수로 뺐다(무인 리뷰 must-fix) — CLI action 안에
    //   두면 이 PR 의 본체(관측 화면)를 테스트가 못 잰다. 관측을 고치는 변경이 관측 불가로 남으면 안 된다.
    const { renderHarnessCleanReport } = await import('./harness/harness-clean.js');
    const L = renderHarnessCleanReport(res, mode);
    console.log(L.join('\n'));
  });

harnessCmd
  .command('worktree')
  .description('하니스 worktree 생성 명령.')
  .command('add <branch>')
  .description('검증된 하니스 관문으로 worktree를 생성한다. 경로는 입력이 아니라 생성 결과다.')
  .option('--base <ref>', '분기할 base ref(기본 현재 HEAD)')
  .option('--owner <label>', '생성자를 worktree 스코프 Git config에 선언')
  .option('--json', '구조화 출력')
  .action(async (branch: string, opts: { base?: string; owner?: string; json?: boolean }) => {
    const [{ addHarnessWorktree, renderHarnessWorktreeAdd }, { resolveMainRepoRoot }, { spawnSync }] = await Promise.all([
      import('./harness/harness-worktree-add.js'),
      import('./git-fs/worktree.js'),
      import('node:child_process'),
    ]);
    const callerCwd = process.cwd();
    const callerHead = opts.base === undefined
      ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: callerCwd, encoding: 'utf8' })
      : undefined;
    if (callerHead && (callerHead.status !== 0 || !callerHead.stdout.trim())) {
      const message = (callerHead.stderr || callerHead.stdout || `git exited ${callerHead.status}`).trim();
      throw new Error(`harness worktree add could not resolve current HEAD — ${message}`);
    }
    const repoRoot = resolveMainRepoRoot(callerCwd);
    if (!repoRoot) throw new Error(`harness worktree add requires a Git repository — ${callerCwd}`);
    const result = addHarnessWorktree({ repoRoot, branch, ...(opts.base === undefined ? { base: callerHead!.stdout.trim() } : { base: opts.base }), ...(opts.owner !== undefined ? { owner: opts.owner } : {}) });
    if (opts.json) { await writeStdoutJson(JSON.stringify(result) + '\n'); return; }
    console.log(renderHarnessWorktreeAdd(result).join('\n'));
  });

harnessCmd
  .command('worktrees')
  .description('등록된 모든 worktree를 PR·더티·산출·세션 소유 축으로 read-only 판정한다. 기본 동작은 절대 제거하지 않는다.')
  .option('--remove', '회수 안전 외 대상을 거부하는 판정을 함께 출력한다. 이 착지에서는 실제 제거하지 않는다.')
  .option('--json', '구조화 출력')
  .option('-r', 'list worktrees on the default remote bookmark (does not take a value)')
  .option('--remote <name>', 'list worktrees on a named remote bookmark via GET /v1/worktrees')
  .action(async (opts: { remove?: boolean; json?: boolean; r?: boolean; remote?: string }) => {
    if (opts.remote !== undefined || opts.r === true) {
      const { runHarnessWorktreesRemote } = await import('./cli/harness-worktrees-remote.js');
      const result = await runHarnessWorktreesRemote({
        remote: opts.remote !== undefined ? opts.remote : true,
        json: opts.json === true,
        remove: opts.remove === true,
      });
      // ⛔ process.exit() here cuts piped JSON/rows before stdout flushes.
      process.exitCode = result.exitCode;
      return;
    }
    const { execHarnessWorktrees, renderHarnessWorktreesReport } = await import('./harness/harness-worktrees.js');
    const report = execHarnessWorktrees({ removeRequested: !!opts.remove });
    if (opts.json) { await writeStdoutJson(JSON.stringify(report) + '\n'); return; }
    console.log(renderHarnessWorktreesReport(report, !!opts.remove).join('\n'));
  });

harnessCmd
  .command('terminals-purge')
  .description('PTY 관측소(/v1/terminals) 잔존 종료(dead) 행 purge — reap(owner-pid liveness)이 못 지운 alive=0 엔트리 정리. alive=1(라이브) 무접촉.')
  .option('--all', '모든 종료 행 즉시 purge(grace TTL 무시)')
  .option('--ttl <minutes>', '이 분(min)보다 오래된 종료 행만 purge', '5')
  .option('--json', '구조화 출력 {purged}')
  .action(async (opts: { all?: boolean; ttl?: string; json?: boolean }) => {
    const { purgeClosedPtyManifest } = await import('./pty-shell/pty-manifest.js');
    const ttlMs = opts.all ? 0 : Math.max(0, parseFloat(opts.ttl ?? '5')) * 60_000;
    const purged = purgeClosedPtyManifest(Date.now(), ttlMs);
    if (opts.json) await writeStdoutJson(JSON.stringify({ purged }) + '\n');
    else console.log(`[terminals purge] ${purged}건 정리 (${opts.all ? 'all' : (opts.ttl ?? '5') + 'm'})`);
    process.exit(0);
  });

harnessCmd
  .command('dogfood <target> <objective...>', { hidden: true })
  // ⛔⭐ 은퇴 표시를 «손으로 적지 않는다» — 레지스트리 선언에서 온다(RFC P2).
  //   📏 2026-08-20 실측: 이 명령은 레지스트리가 «은퇴»로 선언했는데 --help 는 그 사실을
  //     ***한 글자도 말하지 않았다.*** 선언과 표면이 갈리면 선언은 늙고 표면은 거짓말한다.
  .description(describeEntranceCommand(
    CLI_HARNESS_DOGFOOD_ENTRANCE,
    // ⛔⭐ 은퇴 안내가 «검증된 문»을 지목해야 한다 — 2026-08-31 실측: 여기가 `dev --ask` 를 가리켰고
    //   레지스트리는 그 문의 legacyParity 를 ***'unknown'*** 으로, `harness ask` 는 ***'verified'*** 로 둔다.
    //   ⇒ 은퇴 안내가 「덜 검증된 문」으로 보내고 있었다. `harness ask` 가 골 문서를 받는 «대응 문»이다.
    'elanous harness ask <골문서>',
    'Telegram/TUI 없이 dev-harness P→E→R→D를 headless로 실행(auto-approve). ⚠️ target은 시스템 temp 하위(throwaway)만 — auto-approve가 apply-in-place HITL을 우회하므로 실경로는 거부(실 대상은 RunDevHarness로 HITL 유지). shadow-stage·gate·backup/apply 재사용·--config-dir 격리 상속.',
  ))
  .action(async () => {
    const { refuseHarnessDogfoodCli } = await import('./harness/dogfood.js');
    const outcome = refuseHarnessDogfoodCli();
    ui.error(outcome.message);
    process.exitCode = outcome.exitCode;
  });

// ★ Q2(A2 하니스 정합·2026-07-22) — staged 하니스 front door. `dogfood`(temp·auto-approve 전용)와 달리
//   실 objective 를 인프로세스로 구동한다. ctx 없음 → dispatchRunDevHarness 재귀가드 ③(직접 CLI=인프로세스).
//   관측 sink 등록(run-detached 선례) 없으면 harness.sequencer 로그가 logs.db 에 안 닿음.
harnessCmd
  .command('run <objective...>', { hidden: true })
  .description(HARNESS_RUN_DEPRECATION_HELP)
  .option('--target <path>', "타깃 repo/경로(기본 'self'=elanous 자신)")
  .option('--auto-drive <mode>', 'off|safe|on (기본 자연어 추론)')
  .option('--auto-review', '★ G8/G9 — 열린 PR 에 auto-review opt-in 라벨 부착(작업 위험도 자기판단·외부배포/실주문/설계분기/파괴/보안 거부). 붙으면 L3 폴러가 무인 완결(rework→심판→머지). 개발 라인(self implement/orchestrate --auto-review)과 대칭.')
  .option('--base <ref>', '분기 base ref')
  .option('--red-team', 'adversarial 계획 레드팀 강제')
  .option('--multi-angle', '다각도 계획 탐색')
  .option('--domain <kind>', '비-코드 도메인: web|publish(웹 게시)·invest|research|digest(read-only 리포트)·skill(범용—luna 발견 스킬 Write 실행: PPT/덱/이미지). 생략=코드 개발')
  .option('--carry-capsule', 'B1(§3k) — Capsule 설계 계약을 항상 전달(강제 on). 기본=auto(인터뷰가 nav 채우면 자동 carry)')
  .addOption(new Option('--sizing-mode <mode>', 'plan-time 크기 렌즈(C3·기본 observe·자르지 않음)').choices(['off', 'observe']))
  .addOption(new Option('--ledger-mode <mode>', '실패 조사 원장(C4·기본 observe·진단만)').choices(['off', 'observe']))
  .action(async (objectiveParts: string[], opts: { target?: string; autoDrive?: 'off' | 'safe' | 'on'; autoReview?: boolean; base?: string; redTeam?: boolean; multiAngle?: boolean; domain?: string; carryCapsule?: boolean; sizingMode?: 'off' | 'observe'; ledgerMode?: 'off' | 'observe' }) => {
    if (!objectiveParts.join(' ').trim()) { ui.error('harness run: objective 필요'); process.exitCode = 1; return; }
    try {
      const { runHarnessRunCliCommand, applyHarnessRunOutcomeExit } = await import('./self-dev/harness-run-cli.js');
      // ⭐ 스테이지 진행을 부모 stdout 으로 — 막이 내는 `[<stage>] <message>` 에 계보 접두만 붙인다.
      //   📏 이것이 없던 동안 `harness run` 은 8분 3초를 «0줄»로 돌았다(2026-08-11 실측).
      const outcome = await runHarnessRunCliCommand(objectiveParts, opts, {
        onProgress: (line) => console.log(line.startsWith('[') ? `[harness:${line.slice(1)}` : `[harness] ${line}`),
      });
      if (outcome.ok) console.log(outcome.output);
      else ui.error(`harness run 실패: ${outcome.message.slice(0, 300)}`);
      // 성공 시 exitCode 미설정 보존(원 액션 동형) · 실패면만 exitCode 설정.
      applyHarnessRunOutcomeExit(outcome);
    } catch (e: any) {
      ui.error(`harness run 실패: ${String(e?.message ?? e).slice(0, 300)}`);
      process.exitCode = 1;
    }
  });

const HARNESS_BROWSER_ACT_ENTRY_POINT = 'src/index.ts:harness browser-act';

export async function runHarnessBrowserAction(
  url: string,
  target: string,
  opts: { armed?: boolean; port?: string; persona?: string; entryPoint?: string; shot?: string; allow?: string; probe?: boolean },
  deps: BrowserActionDeps = {},
): Promise<BrowserActionResult> {
  const entryPoint = opts.entryPoint ?? HARNESS_BROWSER_ACT_ENTRY_POINT;
  if (opts.armed !== true) return performBrowserAction({ url, target, armed: false, entryPoint }, deps);
  const persona = opts.persona === undefined
    ? undefined
    : (await awaitGlobalPersonaLoad(), getGlobalPersonaRegistry().get(opts.persona));
  // ⛔⭐ 없는 페르소나를 «조용히» 기본 거처로 흘려보내지 않는다 —
  //    그러면 「봇 X 를 몰았다」고 믿으면서 «다른 브라우저»를 몬 것이 되고, 산출은 ok:true 라 아무도 못 본다.
  //    (32차 실물: 저장소의 personas/ 는 이 레지스트리가 «안 읽어서» 조회가 늘 비었고, 그래도 성공이 떴다.)
  if (opts.persona !== undefined && persona === undefined) {
    return {
      ok: false, url, target,
      reason: 'execution-failed',
      error: describeMissingPersona(opts.persona, getGlobalPersonaRegistry()),
    };
  }
  return performBrowserAction({ url, target, armed: true, entryPoint,
    // 🔬 ⛔ 「탐침이다」는 «귀속»만 바꾼다 — 경계·되돌림 정책은 그대로 아래에서 적용된다.
    ...(opts.probe === true ? { probe: true } : {}),
    ...(persona === undefined ? {} : { persona }) }, {
    ...deps,
    ...(opts.port === undefined ? {} : { port: Number(opts.port) }),
    ...(opts.shot === undefined ? {} : { shotPath: opts.shot }),
    // ⚖️ ⛔ 기본은 «엄격»이다 — 깜빡 잊으면 열리는 쪽으로 두지 않는다.
    reversibilityPolicy: opts.allow === 'any' ? 'any' : 'navigation-only',
  });
}

/** `--target-json` 이 실어 오는 관측된 칸. ⛔ 모양이 안 맞으면 `null` 로 떨어뜨린다 — 모르는 곳에는 안 친다. */
function parseBrowserTypeTargetJson(raw: string | undefined): TypeTarget | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.tag !== 'string') return null;
    if (record.type !== null && typeof record.type !== 'string') return null;
    if (record.name !== null && typeof record.name !== 'string') return null;
    if (record.id !== null && typeof record.id !== 'string') return null;
    if (typeof record.contentEditable !== 'boolean') return null;
    if (typeof record.inForm !== 'boolean') return null;
    return { tag: record.tag, type: record.type as string | null, name: record.name as string | null,
      id: record.id as string | null, contentEditable: record.contentEditable, inForm: record.inForm };
  } catch { return null; }
}

/**
 * ⌨️ 타이핑 «판정»의 CLI 표면. ⛔ 키 이벤트를 보내지 않고 폼을 제출하지 않는다 — 판정만 낸다.
 *
 * ⛔⭐⭐ **허용 호스트를 «호출자»에게서 받지 않는다.** 그러면 치려는 호스트를 스스로 선언해
 *   `decideTypeAction` 의 호스트 검사가 «자기충족»되고, 경계가 «있는 척»만 한다.
 *   ⇒ 형제 명령 `browser-act` 와 «같은 출처»를 쓴다 — persona registry 의 `actionHosts`.
 *   (`runHarnessBrowserAction` 이 `request.persona` 로 넘기고 `browser-act.ts:678` 이 그것을 읽는다.)
 *
 * ⛔ 없는 페르소나를 «조용히» 빈 허용목록으로 흘려보내지 않는다 — 그러면 「봇 X 의 경계로 쟀다」고
 *   믿으면서 «아무 경계도 없이» 잰 것이 되고, 산출은 그럴듯한 판정이라 아무도 못 본다.
 *   그 비대칭은 `runHarnessBrowserAction` 이 이미 못 박아 뒀다.
 */
export async function runHarnessBrowserType(
  url: string,
  selector: string,
  text: string,
  opts: { armed?: boolean; maxChars?: string; persona?: string; targetJson?: string } = {},
): Promise<TypeActionDecision> {
  const persona = opts.persona === undefined
    ? undefined
    : (await awaitGlobalPersonaLoad(), getGlobalPersonaRegistry().get(opts.persona));
  if (opts.persona !== undefined && persona === undefined) {
    return { allowed: false, reason: describeMissingPersona(opts.persona, getGlobalPersonaRegistry()) };
  }
  // ⛔ 숫자가 «아닌» --max-chars 를 «조용히» 버리고 기본 상한으로 가지 않는다 —
  //    그러면 「내가 100자로 좁혔다」고 믿는 채 기본값으로 판정이 나고, 산출은 그럴듯하다.
  //    ⇒ 「못 읽었다」와 「안 줬다」를 다른 값으로 둔다(이 저장소 상시 규율).
  let maxChars: number | undefined;
  if (opts.maxChars !== undefined) {
    const parsed = Number(opts.maxChars);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      return { allowed: false, reason: `--max-chars 를 «수»로 못 읽었다: ${JSON.stringify(opts.maxChars)} — 조용히 기본 상한으로 가지 않는다` };
    }
    maxChars = parsed;
  }
  return decideTypeAction({
    url, selector, text,
    actionHosts: persona?.actionHosts ?? [],
    armed: opts.armed === true,
    target: parseBrowserTypeTargetJson(opts.targetJson),
    ...(maxChars === undefined ? {} : { maxChars }),
  });
}

harnessCmd
  .command('browser-type <url> <selector> <text>')
  .description('⌨️ 타이핑 요청을 decideTypeAction 으로 «판정»한다. ⛔ 키를 보내지 않고 제출하지 않는다 — 실행은 별개 판이다.')
  .option('--armed', '이번 «한 번»의 타이핑 판정을 명시 무장')
  .option('--max-chars <n>', '칠 글 상한')
  // ⛔ `--action-hosts` 를 «의도적으로» 두지 않는다 — 위 머리말의 자기충족 이유.
  .option('--persona <personaId>', '허용 호스트(actionHosts)를 이 페르소나에서 «읽는다». ⛔ 호출자가 직접 못 준다')
  .option('--target-json <json>', '관측된 대상 칸 JSON(TypeTarget). 없으면 null — 모르는 곳에는 안 친다')
  .action(async (url: string, selector: string, text: string,
    opts: { armed?: boolean; maxChars?: string; persona?: string; targetJson?: string }) => {
    const decision = await runHarnessBrowserType(url, selector, text, opts);
    await writeStdoutJson(JSON.stringify(decision) + '\n');
    if (!decision.allowed) process.exitCode = 1;
  });

harnessCmd
  .command('browser-act <url> <target>')
  // ⛔ 옛 문면은 「사람이 --armed 로 «명시 무장»한 경우에만」이었다 — 2026-08-28 에 «거짓»이 됐다.
  //    대표 이 무인 루틴의 조작을 승인했고(「쓴다도 승인」), 봇 루틴·카나리아가 이 플래그를 «스스로» 준다.
  //    ⇒ 🔑 그러니 이 플래그는 「사람이 눌렀다」가 아니라 ***「이 한 번을 «명시로» 무장했다」***를 뜻한다.
  //    ⭐ 「누가 무장했나」는 관측의 attribution.kind 가 가른다(bot · run · entry-point).
  .description('명시로 무장(--armed)한 «한 번»만 attach CDP 페이지에서 대상 선택자를 클릭한다. ⛔ 누가 무장했는지는 관측 attribution 이 가른다(사람·봇 루틴·런).')
  .option('--armed', '이번 «한 번»의 브라우저 조작을 명시 무장(사람 또는 선언된 무인 루틴)')
  .option('--port <n>', 'CDP attach 포트(기본 9222)')
  .option('--persona <personaId>', 'persona registry에서 CDP 거처를 선택')
  .option('--shot <path>', '조작 «뒤» 화면을 이 경로에도 저장(png). ⛔ 첨부 저장소는 /tmp 라 사라진다')
  // 🔬⭐ **살아있음 탐침을 봇의 «자기 행동»과 가른다**(2026-08-30 · 37차 · RFC §23b-4 의 P3).
  //    ⛔ 이것은 «면제 플래그가 아니다» — 경계는 그대로 적용된다. 바뀌는 것은 관측의 귀속뿐이다.
  .option('--probe', '🔬 이 조작은 «살아있음 탐침»이다 — 관측 귀속이 probe 가 된다. ⛔ 경계를 «넓히지 않는다»(면제가 아니다)')
  // ⚖️ 대표 이 「쓴다」를 승인했지만(2026-08-28) ***되돌리기 장치가 «없다»*** —
  //    그래서 기본은 «이동»만 누른다. 제출·전송·구매를 누르려면 사람이 그 한 번을 «명시로» 연다.
  .addOption(new Option('--allow <kind>', '누를 수 있는 종류. ⛔ any 는 「안전을 끈다」가 아니라 「사람이 그 한 번을 열었다」다 — 무인 루틴은 쓰지 마라')
    .choices(['navigation', 'any']).default('navigation'))
  .action(async (url: string, target: string, opts: { armed?: boolean; port?: string; persona?: string; shot?: string; allow?: string; probe?: boolean }) => {
    const result = await runHarnessBrowserAction(url, target, opts);
    await writeStdoutJson(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  });

// 🎬 C2(녹화·재현 · 2026-08-28) — ⛔ 새 기록기를 «안 짓는다». 이미 남는 관측을 궤적으로 되읽는다.
//    RFC §4.2 가 그 결정을 못 박았다: 「C2 는 playwright 를 안 더한다」.
harnessCmd
  .command('trajectory')
  .description('🎬 이미 남은 browser-act 관측을 «궤적»으로 되읽는다(녹화). ⛔ 새 기록 형식을 만들지 않는다.')
  .option('--persona <personaId>', '그 봇의 걸음만')
  .option('--since <t>', '조회 창(30s|15m|2h|7d)', '2h')
  .option('--limit <n>', '조회 상한', '500')
  .option('--json', '궤적을 JSON 으로(재현에 그대로 먹인다)')
  // 🔬⭐ **「그 봇이 한 것」과 「카나리아 탐침」을 가른다**(2026-08-30 · 37차).
  //    📏 그 전까지 newsbot 궤적 104걸음 중 87 이 탐침이었다 — 궤적이 봇의 것이 «아니었다».
  //    ⛔ 「모르는 것」은 «봇 쪽»으로 둔다(귀속 칸이 생기기 «전»의 행이 그렇다).
  .addOption(new Option('--actor <who>', '🔬 누구의 걸음인가. bot=그 봇의 것(기본 · 모르는 것 포함) · probe=카나리아 탐침 · all=전부')
    .choices(['bot', 'probe', 'all']).default('bot'))
  // 📜 P⑦(RFC §23b) — 궤적을 «스킬»로 굳힌다. ⛔ 굳힐 때 C5 의 경계를 «같이» 박는다.
  .option('--as-skill <name>', '📜 이 궤적을 SKILL.md 로 굳혀 stdout 에 낸다(⛔ 파일로 쓰지 않는다)')
  .action(async (opts: { persona?: string; since: string; limit: string; json?: boolean; asSkill?: string; actor?: 'bot' | 'probe' | 'all' }) => {
    const { readTrajectory, describeTrajectory } = await import('./harness/browser-act-trajectory.js');
    const args = ['logs', '--category', 'harness.browser-act', '--all', '--include-test',
      '--since', opts.since, '--limit', opts.limit, '--json'];
    const proc = Bun.spawnSync([process.execPath, new URL('../bin/elanous.mjs', import.meta.url).pathname, ...args],
      { stdout: 'pipe', stderr: 'pipe' });
    const result = readTrajectory(new TextDecoder().decode(proc.stdout), {
      ...(opts.persona === undefined ? {} : { personaId: opts.persona }),
      ...(opts.actor === undefined ? {} : { actor: opts.actor }),
    });
    if (opts.json) { await writeStdoutJson(JSON.stringify(result, null, 2) + '\n'); return; }
    if (opts.asSkill !== undefined) {
      const { freezeTrajectoryAsSkill } = await import('./harness/browser-act-skill.js');
      // ⛔ 경계는 «그 봇의 선언»에서 읽는다 — 못 읽으면 「없다」로 두고, 그 사실이 경고로 나온다.
      let declared: readonly string[] = [];
      if (opts.persona !== undefined) {
        try {
          const [{ resolveBotlabStatePaths }, { parsePersonaYaml }] = await Promise.all([
            // 원본 전용 봇랩 도구(공개본엔 없다) — 경로를 변수로 둬 공개본 타입 검사가 «모듈 없음»으로 막히지 않게 한다. 없으면 아래 catch 가 「없다」로 둔다.
            import(BOTLAB_STATE_PATHS_MODULE) as Promise<{ resolveBotlabStatePaths(): { registryDir: string } }>,
            import('./persona/loader.js'),
          ]);
          const file = `${resolveBotlabStatePaths().registryDir}/${opts.persona}.yaml`;
          const parsed = parsePersonaYaml(await Bun.file(file).text(), file);
          if (parsed.ok) declared = parsed.profile.actionHosts ?? [];
        } catch { /* 못 읽으면 「없다」 — 아래 경고가 그 사실을 말한다 */ }
      }
      const frozen = freezeTrajectoryAsSkill({
        name: opts.asSkill, steps: result.steps,
        truncated: result.diagnostics.truncated, declaredActionHosts: declared,
      });
      if (!frozen.ok) { console.error(`⛔ 굳히지 않았다 — ${frozen.error}`); process.exitCode = 1; return; }
      // ⛔ 파일로 «쓰지 않는다» — 사람이 읽고 두는 것이 이 칸의 관문이다.
      for (const w of frozen.warnings) console.error(w);
      console.error(`📜 ${frozen.steps}걸음 · 경계 ${frozen.hosts.length}곳 — 아래를 skills/${opts.asSkill}/SKILL.md 로 두어라`);
      console.log(frozen.md);
      return;
    }
    // ⛔ 「걸음 N개」만 내지 않는다 — «무엇을 못 봤나»를 같이 낸다.
    console.log(`🎬 궤적 — ${describeTrajectory(result)}`);
    for (const [i, step] of result.steps.entries()) {
      const where = step.coordinates === null ? '(좌표 없음)' : `(${step.coordinates.x.toFixed(0)},${step.coordinates.y.toFixed(0)})`;
      const mark = step.ok ? '✅' : '⛔';
      console.log(`  ${mark} #${i} ${step.ts.slice(11, 19)} ${step.target} ${where} · 화면=${step.captureOutcome ?? '—'}` +
        (step.ok ? '' : ` · ${step.failureReason ?? ''}`) + ` · ${step.url}`);
    }
  });

harnessCmd
  .command('replay')
  .description('▶️ 녹화한 궤적을 «같은 순서로» 다시 밟는다(재현). ⛔ 「같은 결과」를 보장하지 않는다 — «어디서 갈렸나»를 낸다.')
  .option('--persona <personaId>', '그 봇의 궤적을 그 봇의 거처에서')
  .option('--since <t>', '궤적을 읽을 창', '2h')
  .option('--limit <n>', '조회 상한', '500')
  .option('--steps <n>', '마지막 N 걸음만 재현(기본 전부)')
  .option('--tolerance <px>', '좌표가 «같다」고 볼 오차(px)', '8')
  .option('--dry-run', '⛔ 아무것도 «안 누르고» 무엇을 밟을지만 보인다')
  .action(async (opts: { persona?: string; since: string; limit: string; steps?: string; tolerance: string; dryRun?: boolean }) => {
    const { readTrajectory, describeTrajectory } = await import('./harness/browser-act-trajectory.js');
    const { judgeReplayStep, summarizeReplay } = await import('./harness/browser-act-replay.js');
    const proc = Bun.spawnSync([process.execPath, new URL('../bin/elanous.mjs', import.meta.url).pathname,
      'logs', '--category', 'harness.browser-act', '--all', '--include-test',
      '--since', opts.since, '--limit', opts.limit, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const recorded = readTrajectory(new TextDecoder().decode(proc.stdout),
      opts.persona === undefined ? {} : { personaId: opts.persona });
    // ⛔ 재현 «전»에 궤적이 온전한지 먼저 말한다 — 잘린 궤적을 「전부 밟았다」로 읽지 않게.
    console.log(`🎬 궤적 — ${describeTrajectory(recorded)}`);
    const wanted = opts.steps === undefined ? recorded.steps : recorded.steps.slice(-Number(opts.steps));
    // ⛔ 재현은 «성공한 걸음»만 밟는다 — 실패했던 걸음은 「그때도 안 됐다」라 대조 기준이 없다.
    const plan = wanted.filter((step) => step.ok);
    console.log(`▶️ 재현 대상 ${plan.length}걸음 (실패였던 ${wanted.length - plan.length}걸음은 «뺀다» — 대조 기준이 없다)`);
    if (opts.dryRun) {
      for (const [i, step] of plan.entries()) console.log(`  [dry-run] #${i} ${step.target} · ${step.url}`);
      return;
    }
    const tolerance = Number(opts.tolerance);
    const results = [];
    for (const [i, step] of plan.entries()) {
      const now = await runHarnessBrowserAction(step.url, step.target,
        { armed: true, ...(step.personaId === null ? {} : { persona: step.personaId }), entryPoint: 'src/index.ts:harness replay' });
      // ⛔⭐⭐ 「지금」은 조작이 «자기가 본 것»으로 온다 — ***신원 조인***이다.
      //    옛 방식은 `elanous logs` 를 다시 spawn 해 «가장 최근 행»을 집었다: 그것은 조인이 아니라
      //    ***시간 근접***이라, 같은 창에 다른 봇(카나리아는 4대를 «동시에» 몬다)이 조작하면
      //    «남의 행»을 집었다(`personaId` 가 null 이면 아무 필터도 없었다). 400ms 잠은 «희망»이었다.
      //    ⇒ 덤: 걸음마다 하위 프로세스 2회와 그 잠이 사라진다.
      const fresh = now.ok ? now.observed : undefined;
      results.push(judgeReplayStep({
        index: i, url: step.url, target: step.target, tolerancePx: tolerance,
        // ⭐ 목적지를 «둘 다» 넘긴다 — 좌표는 배치로 흔들리지만 「어디로 갔나」는 의미다.
        //    ⛔ 옛 행에는 이 값이 «없다»(undefined) — 그때는 판정기가 좌표로 되돌아간다.
        then: { coordinates: step.coordinates, captureOutcome: step.captureOutcome, ok: step.ok, landedUrl: step.landedUrl },
        now: { coordinates: fresh?.coordinates ?? null, captureOutcome: fresh?.captureOutcome ?? null, ok: now.ok,
          landedUrl: fresh?.landedUrl,
          // ⛔ 실패는 «자기 이름을 대야» 한다 — 재현 산출이 「실패했다」로만 끝나면 고칠 자리가 없다.
          reason: now.ok ? null : `${now.reason}${now.error === undefined ? '' : `: ${now.error}`}` },
      }));
      const last = results.at(-1)!;
      const mark = last.outcome === 'same' ? '✅' : last.outcome === 'differs' ? '⚠️' : last.outcome === 'unobserved' ? '⚪' : '⛔';
      console.log(`  ${mark} #${i} ${step.target} — ${last.detail}`);
    }
    const verdict = summarizeReplay(results);
    console.log(`\n▶️ ${verdict.detail}`);
    if (verdict.failed > 0) process.exitCode = 1;
  });

// ★ B2(웹배포 렌더 검증·2026-07-22) — 배포/로컬 URL 을 CDP(기본) 또는 aside로 열어 렌더를
//   진단(스크린샷 + 본문/타이틀). 백엔드 부재는 검증을 막지 않는 fail-soft skip이다.
harnessCmd
  .command('verify-url <url>')
  .description('배포/로컬 URL 을 cdp(기본) 또는 aside 백엔드로 열어 렌더 검증(스크린샷+본문/타이틀 진단). CDP는 B1 attach(9222·브라우저 비귀속)를 재사용하며 백엔드 부재 시 skip.')
  .option('--port <n>', 'CDP attach 포트(기본 9222)')
  .option('--shot <path>', '스크린샷 저장 경로(png)')
  .addOption(new Option('--backend <backend>', '관측 백엔드(cdp=기본·aside=별도 브라우저 세션)').choices(['cdp', 'aside']).default('cdp'))
  .action(async (url: string, opts: { port?: string; shot?: string; backend: 'cdp' | 'aside' }) => {
    try {
      const { verifyDeployedPage, formatVerifyUrlReport } = await import('./harness/browser-verify.js');
      const { writeFileSync } = await import('node:fs');
      let shotWritten = false;
      const r = await verifyDeployedPage(url, {
        backend: opts.backend,
        ...(opts.port ? { port: Number(opts.port) } : {}),
        // ⛔ 「썼다」를 «셋»으로 — 안 시켰다 / 썼다 / 못 썼다. 뭉치면 없는 파일을 있다고 말한다.
        ...(opts.shot ? { onScreenshot: (b: Buffer) => { writeFileSync(opts.shot!, b); shotWritten = true; } } : {}),
      });
      if (r.skipped === 'no-cdp') {
        console.log(`⚠️ CDP 엔드포인트 없음(9222) — 검증 skip. browser-debug 스킬로 브라우저를 9222 에 먼저 띄우세요.`);
        return;
      }
      if (r.skipped === 'no-aside') {
        console.log(`⚠️ aside 실행 파일을 찾을 수 없음 — 검증 skip. aside 부재는 배포 검증을 막지 않습니다.`);
        return;
      }
      const L = formatVerifyUrlReport(url, r, opts.shot === undefined ? undefined : { path: opts.shot, written: shotWritten });
      console.log(L.join('\n'));
      if (!r.ok) process.exitCode = 1;
    } catch (e: any) {
      ui.error(`harness verify-url 실패: ${String(e?.message ?? e).slice(0, 200)}`);
      process.exitCode = 1;
    }
  });

// ★ Q2(A2·자기서술·2026-07-22) — 하니스가 자기 파이프라인/공간/종결상태를 스스로 서술(제1원칙 자기인지).
//   부작용 0(순수 read). HARNESS_STAGE_MAP(SSOT)·harness-space·HarnessTerminal 을 소비.
harnessCmd
  .command('map')
  .description('하니스 자기서술 — 스테이지 파이프라인(순서·역할)·실행 공간·종결상태를 출력(부작용 0).')
  .option('--json', '구조화 출력')
  .action(async (opts: { json?: boolean }) => {
    const { HARNESS_STAGE_MAP } = await import('./harness/staged-harness.js');
    const { HARNESS_SPACE_KINDS } = await import('./harness/harness-space.js');
    const stages = [...HARNESS_STAGE_MAP].sort((a, b) => a.order - b.order);
    const terminals: Array<{ terminal: string; note: string }> = [
      { terminal: 'pr-opened', note: '✅ draft PR 개설(리뷰 후 operator Ready→머지·fail-closed)' },
      { terminal: 'branch-prepared', note: '✅ 브랜치 커밋·준비(PR 승인 대기)' },
      { terminal: 'applied', note: '✅ #25 비-git/config 타깃 실위치 적용(백업됨)' },
      { terminal: 'apply-staged', note: '✅ #25 apply 승인 대기(그림자만·미적용)' },
      { terminal: 'executed', note: '✅ Q3 비-코드 집행 완료(투자 주문 등·부작용 executor)' },
      { terminal: 'published', note: '✅ Q3 비-코드 게시 완료(웹 배포 등·게시URL)' },
      { terminal: 'signaled', note: '✅ Q3 신호 산출(판단층·부작용0)' },
      { terminal: 'no-changes', note: '⚠️ 구현이 실 변경 0' },
      { terminal: 'plan-empty', note: '① 계획 산출 없음' },
      { terminal: 'execute-failed', note: '② 구현 실패' },
      { terminal: 'review-diverged', note: '③ review↔rework K라운드 초과' },
      { terminal: 'deploy-failed', note: '④ 배포 실패' },
      { terminal: 'escalated', note: 'HITL 필요(autoDrive off/safe)' },
    ];
    if (opts.json) { await writeStdoutJson(JSON.stringify({ stages, spaces: HARNESS_SPACE_KINDS, terminals }, null, 2) + '\n'); return; }
    const L: string[] = ['\n━━ 하니스 자기서술 (harness map) ━━', '', '▎스테이지 파이프라인 (실행 순서)'];
    for (const s of stages) L.push(`  ${s.order}. ${s.stage}${s.optional ? ' (opt-in)' : ''}  — ${s.role}`);
    L.push('', '▎실행 공간(space)', `  ${HARNESS_SPACE_KINDS.join(' · ')}  (role: coordinator | executor)`);
    L.push('', '▎종결상태(terminal)');
    for (const t of terminals) L.push(`  ${t.terminal.padEnd(16)} ${t.note}`);
    L.push('', '관측: elanous logs --category harness.sequencer|harness.seams|harness.frontdoor');
    console.log(L.join('\n'));
  });

export interface HarnessOrchestrateCliOpts {
  domain?: string;
  concurrency?: string;
  autoReview?: boolean;
  autoMerge?: boolean;
  openPr?: boolean;
  base?: string;
  decompose?: boolean;
  fabricDecompose?: boolean;
  maxTasks?: string;
  teardown?: boolean;
  resume?: string;
  board?: boolean;
  supervise?: boolean;
  superviseRounds?: string;
  json?: boolean;
}

export interface HarnessOrchestratePlanGoal {
  id?: string;
  feature: string;
  dependsOn?: string[];
  autoReview?: boolean;
  autoMerge?: boolean;
  openPr?: boolean;
  base?: string;
}

/** 정본 입구가 별칭과 같은 능력으로 만드는 실행 계획. ⛔ 받아 놓고 무시하지 않는다. */
export interface HarnessOrchestrateExecutionPlan {
  ok: true;
  goals: HarnessOrchestratePlanGoal[];
  concurrency?: number;
  autoReview?: boolean;
  autoMerge?: boolean;
  openPr?: boolean;
  base?: string;
  decompose?: boolean;
  fabricDecompose?: boolean;
  maxTasks?: number;
  runtime: { teardown?: boolean; resume?: string; board?: boolean };
  supervise?: { rounds?: number };
  json?: boolean;
  spec: {
    entrance: EntranceId;
    input: { text: string };
    executor: { kind: 'self' };
    parallel: { goals: HarnessOrchestratePlanGoal[]; concurrency?: number };
  };
}

export type HarnessOrchestratePlan =
  | HarnessOrchestrateExecutionPlan
  | { ok: false; error: string; exitCode: number };

export function buildHarnessOrchestratePlan(
  parts: readonly string[],
  opts: HarnessOrchestrateCliOpts,
): HarnessOrchestratePlan {
  if (opts.domain !== undefined) {
    return {
      ok: false,
      error: '`--domain`은 `harness orchestrate`에서 지원하지 않습니다. ⛔ `elanous self orchestrate` 도 받지 않습니다(unknown option). 실행 도메인 축은 NL 표면의 `RunDevHarness` 툴이 갖습니다 — web|publish|invest|research|digest|skill.',
      exitCode: 2,
    };
  }
  if (opts.fabricDecompose && !opts.decompose) {
    return {
      ok: false,
      error: '--fabric-decompose 는 --decompose 와 «함께» 쓴다 (분해를 켜야 어느 분해기를 쓸지가 의미를 갖는다)',
      exitCode: 2,
    };
  }
  const goalTexts = splitOrchestrateGoalTexts(parts);
  if (goalTexts.length === 0 && !opts.resume) {
    return { ok: false, error: 'goal 필요: elanous harness orchestrate "<goal1>" "<goal2>"', exitCode: 2 };
  }
  const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency) || 2) : undefined;
  const promoteDefaults = {
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.autoMerge ? { autoMerge: true } : {}),
    ...(opts.autoReview ? { autoReview: true } : {}),
    ...(opts.openPr ? { openPr: true } : {}),
  };
  const goals = goalTexts.map((feature) => ({ feature, ...promoteDefaults }));
  const runtime = {
    ...(opts.teardown ? { teardown: true as const } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts.board ? { board: true as const } : {}),
  };
  return {
    ok: true,
    goals,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(opts.autoReview ? { autoReview: true } : {}),
    ...(opts.autoMerge ? { autoMerge: true } : {}),
    ...(opts.openPr ? { openPr: true } : {}),
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.decompose ? { decompose: true } : {}),
    ...(opts.fabricDecompose ? { fabricDecompose: true } : {}),
    ...(opts.maxTasks ? { maxTasks: Math.max(1, Number(opts.maxTasks) || 6) } : {}),
    runtime,
    ...(opts.supervise
      ? { supervise: { ...(opts.superviseRounds ? { rounds: Math.max(1, Number(opts.superviseRounds) || 3) } : {}) } }
      : {}),
    ...(opts.json ? { json: true } : {}),
    spec: {
      entrance: CLI_HARNESS_ORCHESTRATE_ENTRANCE.id,
      input: { text: goals.map((goal) => goal.feature).join(' ;; ') },
      executor: { kind: 'self' },
      parallel: { goals, ...(concurrency === undefined ? {} : { concurrency }) },
    },
  };
}

export interface HarnessOrchestratePersistenceDiagnostic {
  readonly stage: 'checkpoint' | 'participant';
  readonly error: string;
}

type HarnessOrchestratePreparedGoals =
  | { ok: true; goals: HarnessOrchestratePlanGoal[] }
  | { ok: false; error: string; exitCode: number };

type HarnessOrchestrateRunResult = SelfDevRunState['results'][number];

type HarnessOrchestrateOutcome =
  | { ok: true; results: HarnessOrchestrateRunResult[]; exitCode: number }
  | { ok: false; message: string; exitCode: number };

export interface HarnessOrchestrateExecutionDeps {
  readonly prepareGoals?: (input: {
    request: string;
    goals: HarnessOrchestratePlanGoal[];
    decompose?: boolean;
    fabricDecompose?: boolean;
    maxTasks?: number;
    base?: string;
    autoMerge?: boolean;
    openPr?: boolean;
    autoReview?: boolean;
    onInfo?: (message: string) => void;
  }) => Promise<HarnessOrchestratePreparedGoals>;
  readonly loadRun?: (runId: string) => SelfDevRunState | null;
  readonly saveRun?: (state: SelfDevRunState) => void;
  readonly addParticipant?: (runId: string, participant: SelfDevRunParticipant) => void;
  readonly checkpointDependencies?: (
    prior: Pick<SelfDevRunState, 'dependencies'> | null,
    goals: readonly HarnessOrchestratePlanGoal[],
  ) => Record<string, string[]> | undefined;
  readonly classifyResumeDisposition?: (result: SelfDevRunState['results'][number]) => 'skip' | 'rerun' | 'rerun-duplicate-risk';
  readonly resolveRunIdentity?: (input: { explicit?: string; inherited?: string }) => { runId: string; source: SelfDevRunParticipant['runIdSource'] };
  readonly harnessRunIdEnv?: string;
  readonly runCommand?: (input: {
    goals: HarnessOrchestratePlanGoal[];
    concurrency?: number;
    runtime: { runId?: string; teardown?: boolean; resumeFrom?: HarnessOrchestrateRunResult[]; onSnapshot?: (tasks: unknown) => void; checkpoint?: (results: HarnessOrchestrateRunResult[]) => void };
    supervise?: { rounds?: number };
  }) => Promise<HarnessOrchestrateOutcome>;
  readonly resolveStart?: (input: {
    explicit: number | undefined;
    goalCount: number;
    promoteMode: string;
    teardown?: boolean;
    runId: string;
    resume?: { skipped: number; rerun: number };
  }) => { concurrency: number | undefined; announcement: string };
  readonly renderBoard?: (tasks: unknown) => string;
  readonly writeInfo?: (message: string) => void;
  readonly writeError?: (message: string) => void;
  readonly writeOutput?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly getEnv?: (key: string) => string | undefined;
  readonly setEnv?: (key: string, value: string) => void;
  readonly now?: () => number;
  readonly pid?: number;
  readonly onPersistenceDiagnostic?: (diagnostic: HarnessOrchestratePersistenceDiagnostic) => void;
}

function harnessPersistenceErrorMessage(stage: HarnessOrchestratePersistenceDiagnostic['stage'], error: unknown): string {
  const label = stage === 'checkpoint' ? 'run checkpoint' : 'run participant';
  const detail = error instanceof Error ? error.message : String(error);
  return `[self-dev] ⚠️ ${label} 저장 실패(non-fatal): ${detail}`;
}

export async function runHarnessOrchestrateExecution(
  plan: HarnessOrchestrateExecutionPlan,
  parts: readonly string[],
  deps: HarnessOrchestrateExecutionDeps = {},
): Promise<HarnessOrchestrateOutcome | null> {
  const writeInfo = deps.writeInfo ?? ((message) => ui.info(message));
  const writeError = deps.writeError ?? ((message) => ui.error(message));
  const writeOutput = deps.writeOutput ?? ((message) => console.log(message));
  const setExitCode = deps.setExitCode ?? ((code) => { process.exitCode = code; });
  const now = deps.now ?? (() => Date.now());
  const pid = deps.pid ?? process.pid;
  let goals = plan.goals;
  const runtime: { runId?: string; teardown?: boolean; resumeFrom?: HarnessOrchestrateRunResult[]; onSnapshot?: (tasks: unknown) => void; checkpoint?: (results: HarnessOrchestrateRunResult[]) => void } = {
    ...(plan.runtime.teardown ? { teardown: true } : {}),
  };
  const request = normalizeOrchestrateRequest(parts);
  const prepareGoals = deps.prepareGoals ?? (async (input) => {
    const { prepareOrchestrateDecomposeGoals } = await import('./self-dev/self-orchestrate-runtime.js');
    return prepareOrchestrateDecomposeGoals(input as never) as Promise<HarnessOrchestratePreparedGoals>;
  });
  const prepared = await prepareGoals(buildOrchestrateDecomposePrepareArgs({
    request,
    goals,
    decompose: plan.decompose,
    fabricDecompose: plan.fabricDecompose,
    maxTasks: plan.maxTasks,
    base: plan.base,
    autoMerge: plan.autoMerge,
    openPr: plan.openPr,
    autoReview: plan.autoReview,
    json: plan.json,
    onInfo: writeInfo,
  }));
  if (!prepared.ok) {
    writeError(prepared.error);
    setExitCode(prepared.exitCode);
    return null;
  }
  goals = prepared.goals;

  const runStore = await import('./self-dev/run-store.js');
  const loadRun = deps.loadRun ?? runStore.loadSelfDevRun;
  const ledgerDeps = {
    saveRun: deps.saveRun ?? runStore.saveSelfDevRun,
    addParticipant: deps.addParticipant ?? runStore.addSelfDevRunParticipant,
    checkpointDependencies: deps.checkpointDependencies ?? runStore.checkpointDependenciesForRun,
  };
  const { restoreOrchestrateCheckpointGoals, countOrchestrateResumeSkips } = await import('./self-dev/self-orchestrate-runtime.js');
  const restored = restoreOrchestrateCheckpointGoals({
    resume: plan.runtime.resume,
    goals,
    loadRun,
    json: plan.json,
    onInfo: writeInfo,
  });
  const prior = restored.prior;
  goals = restored.goals;
  const classifyResumeDisposition = deps.classifyResumeDisposition ?? (await import('./self-dev/orchestrate.js')).classifyResumeDisposition;
  const resumeCounts = prior ? (() => {
    const skipped = countOrchestrateResumeSkips(prior.results, classifyResumeDisposition);
    return { skipped, rerun: prior.results.length - skipped };
  })() : undefined;
  if (plan.runtime.resume && !prior && !plan.json) writeInfo(`[self-dev] ⚠️ resume run '${plan.runtime.resume}' 없음 — 전체 신규 실행`);
  const harnessSpace = await import('./harness/harness-space.js');
  const harnessRunIdEnv = deps.harnessRunIdEnv ?? harnessSpace.HARNESS_RUN_ID_ENV;
  const resolveRunIdentity = deps.resolveRunIdentity ?? harnessSpace.resolveRunIdentity;
  const { runId, source: runIdSource } = resolveRunIdentity({
    explicit: plan.runtime.resume,
    inherited: deps.getEnv ? deps.getEnv(harnessRunIdEnv) : process.env[harnessRunIdEnv],
  });
  if (deps.setEnv) deps.setEnv(harnessRunIdEnv, runId);
  else process.env[harnessRunIdEnv] = runId;
  const createdAt = prior?.createdAt ?? now();
  const persistenceDiagnostics: HarnessOrchestratePersistenceDiagnostic[] = [];
  const reportPersistenceFailure = (stage: HarnessOrchestratePersistenceDiagnostic['stage'], error: unknown): void => {
    const diagnostic = { stage, error: error instanceof Error ? error.message : String(error) };
    persistenceDiagnostics.push(diagnostic);
    deps.onPersistenceDiagnostic?.(diagnostic);
    writeError(harnessPersistenceErrorMessage(stage, error));
  };
  const { bindOrchestrateRunLedger } = await import('./self-dev/self-orchestrate-runtime.js');
  const { checkpoint } = bindOrchestrateRunLedger(ledgerDeps, {
    runId,
    createdAt,
    prior,
    goals,
    pid,
    runIdSource,
    now,
    onPersistenceFailure: reportPersistenceFailure,
  });
  runtime.checkpoint = checkpoint;
  runtime.runId = runId;
  if (prior) runtime.resumeFrom = prior.results;
  if (goals.length === 0) {
    writeError(`[self-dev] 돌릴 goal 이 없다 — ${plan.runtime.resume ? `체크포인트 '${plan.runtime.resume}' 에 goal 원형이 없고(옛 판) 인자도 안 줬다. goal 을 인자로 주십시오` : 'goal 을 인자로 주십시오'}`);
    setExitCode(2);
    return null;
  }
  let executionConcurrency = plan.concurrency;
  if (!plan.json) {
    const resolveStart = deps.resolveStart ?? (await import('./self-dev/orchestrate-cli.js')).resolveOrchestrateStart;
    const promoteMode = plan.autoMerge ? ' · auto-merge(리뷰노드)' : plan.openPr ? ' · draft PR(리뷰노드)' : ' · PR 없음(worktree만)';
    const start = resolveStart({
      explicit: plan.concurrency,
      goalCount: goals.length,
      promoteMode,
      ...(plan.runtime.teardown ? { teardown: true } : {}),
      runId,
      ...(resumeCounts ? { resume: resumeCounts } : {}),
    });
    executionConcurrency = start.concurrency;
    writeInfo(start.announcement);
  }
  if (plan.runtime.board && !plan.json) {
    const renderBoard = deps.renderBoard ?? (await import('./self-dev/board.js')).renderSelfDevBoard;
    runtime.onSnapshot = (tasks) => { try { process.stdout.write(`\x1b[2J\x1b[H${renderBoard(tasks as never)}\n`); } catch { /* fail-soft */ } };
  }
  const runCommand = deps.runCommand ?? (async (input) => {
    const { runSelfOrchestrateCliCommand } = await import('./self-dev/orchestrate-cli.js');
    return runSelfOrchestrateCliCommand(input);
  });
  const outcome = await runCommand({
    goals,
    ...(executionConcurrency === undefined ? {} : { concurrency: executionConcurrency }),
    runtime,
    ...(plan.supervise ? { supervise: plan.supervise } : {}),
  });
  if (plan.json) {
    const jsonPayload = outcome.ok
      ? (persistenceDiagnostics.length ? { results: outcome.results, persistenceDiagnostics } : outcome.results)
      : { error: outcome.message, ...(persistenceDiagnostics.length ? { persistenceDiagnostics } : {}) };
    writeOutput(JSON.stringify(jsonPayload));
  } else if (!outcome.ok) writeError(`harness orchestrate 실패: ${outcome.message.slice(0, 300)}`);
  else writeOutput(`[self-dev] 완료 — ${outcome.results.filter((result) => result.status === 'done').length}/${outcome.results.length} done`);
  if (outcome.exitCode !== 0) setExitCode(outcome.exitCode);
  return outcome;
}

function registerHarnessOrchestrateCapabilityOptions(command: Command): Command {
  return command
    .option('--concurrency <n>', '동시 실행 잡 수 (기본 2)')
    .option('--auto-merge', '각 잡: 리뷰 clean 시 자동 병합(각 self-implement 에 --auto-merge 전달·리뷰노드 경유)')
    .option('--auto-review', 'G8 — 각 잡 PR 에 auto-review opt-in 라벨 부착(각 self-implement 에 --auto-review·작업별 eligibility 자기판단·fail-safe). 붙은 PR 은 L3 폴러가 무인 완결.')
    .option('--open-pr', 'S3 — 각 잡: gate/리뷰 통과 시 draft PR 개설(각 self-implement 에 --open-pr·승격이 리뷰노드 경유→disposition 내부 각인)')
    .option('--base <branch>', '각 잡 PR base 브랜치')
    .option('--decompose', 'S2 — goal 1개를 LLM 으로 의존성 서브-DAG(위상 병렬 + hot-file 직렬)로 분해 후 실행')
    .option('--teardown', 'S3 — 실행 후 worktree 정리(PR 개설된 잡은 항상 보존·기본 off=산출물 검토 위해 보존)')
    .option('--resume <runId>', 'S3 — 이전 run(runId) 이어서 — done 된 goal 은 건너뛰고 미완만 재실행(체크포인트 자동)')
    .option('--board', 'S3 — 라이브 칸반 보드(잡 상태 실시간 렌더·매 사이클 리드로)')
    .option('--no-supervise', '⛔ 런 슈퍼바이저를 «끈다»(대표 2026-08-22: ***기본 ON***) — 켜져 있으면 런이 끝나면 실패를 «트리아지»해서 다시 걸 것이 있으면 «스스로» 재개한다(골루프처럼 끝까지). 정지 사유는 converged|needs-human|max-rounds|no-progress 로 각각 «다른 값»으로 말한다. 관측=elanous logs --category self-dev.supervisor')
    .option('--supervise-rounds <n>', '슈퍼바이저 재개 라운드 상한 (기본 3 · 끄려면 --no-supervise)')
    .option('--json', '구조화 출력');
}

// `harness orchestrate` 는 자기 파싱만 하고, self orchestrate 와 같은 실행 seam을 직접 한 번 부른다.
const harnessOrchestrateCmd = registerHarnessOrchestrateCapabilityOptions(
  harnessCmd
    .command('orchestrate <goals...>')
    .description('병렬 self-dev — 여러 goal 을 각자 격리 worktree self-implement 서브프로세스로 동시성캡 병렬 실행.')
    .option('--domain <kind>', '⛔ 이 입구는 `--domain` 을 받지 않습니다. 그 축은 NL 표면의 `RunDevHarness` 툴이 갖습니다(web|publish|invest|research|digest|skill) — CLI 어디에도 없습니다.'),
)
  .action(async (parts: string[], opts: HarnessOrchestrateCliOpts) => {
    if (opts.domain !== undefined) {
      ui.error('`--domain`은 `harness orchestrate`에서 지원하지 않습니다. ⛔ `elanous self orchestrate` 도 받지 않습니다(unknown option). 실행 도메인 축은 NL 표면의 `RunDevHarness` 툴이 갖습니다 — web|publish|invest|research|digest|skill.');
      process.exitCode = 2;
      return;
    }
    const plan = buildHarnessOrchestratePlan(parts, opts);
    if (!plan.ok) {
      ui.error(plan.error);
      process.exitCode = plan.exitCode;
      return;
    }
    await runHarnessOrchestrateExecution(plan, parts);
  });

const selfCmd = program.command('self').description('Self-awareness memory — 외부 도구(Claude Code/Codex)가 구현/변경 이력을 elanous 기억에 주입·회상');

// M12 Claude Code 의존도 계기판 — `elanous self dependence [--since] [--until] [--json]`(읽기만).
{ const { registerDependenceCommand } = await import('./cli/dependence-gauge.js'); registerDependenceCommand(selfCmd); }

function printExtendedOrchestrateHelp(command: Command, positional = '[goals...]'): void {
  const optionLines = command.options
    .filter((option) => option.long !== '--help-all')
    .map((option) => `  ${option.flags.padEnd(28)} ${option.description}`);
  console.log([
    `Usage: ${command.name()} ${positional} [options]`,
    '',
    'All options:',
    ...optionLines,
  ].join('\n'));
}

function foldCommandHelpBehindHelpAll(
  command: Command,
  primaryOptionNames: readonly string[],
  positional: string,
  helpAllDescription: string,
): void {
  if (!command.options.some((option) => option.long === '--help-all')) {
    command.option('--help-all', helpAllDescription);
  }
  command.on('option:help-all', () => {
    printExtendedOrchestrateHelp(command, positional);
    process.exit(0);
  });
  const primary = new Set(primaryOptionNames);
  for (const option of command.options) {
    if (primary.has(option.long ?? '') || primary.has(option.short ?? '')) continue;
    option.hideHelp();
  }
}

const HARNESS_ORCHESTRATE_PRIMARY_HELP_OPTIONS = [
  '--concurrency', '--auto-merge', '--auto-review', '--open-pr', '--base', '--decompose', '--json', '--domain', '--help-all', '-h', '--help',
] as const;
foldCommandHelpBehindHelpAll(
  harnessOrchestrateCmd,
  HARNESS_ORCHESTRATE_PRIMARY_HELP_OPTIONS,
  '<goals...>',
  '모든 orchestrate 옵션 표시',
);

// ⭐⭐ 제1원칙 관측 — `self` **전 서브커맨드**에 logs.db 싱크를 중앙 배선(preAction 훅).
//   ⛔ 종전엔 액션마다 손으로 등록했고 **15개 중 6개만** 붙어 있었다(실측 2026-07-30 · main
//   1c527191a): `implement`·`typecheck`·`screen`·`run`·`log`·`provision`·`recall`·`capability`
//   ·`capabilities` **9개**가 빠져 있었다. `self implement` 는 문서가 가리키는 self-build 진입점인데, 같은 파이프라인을
//   `elanous dev` 로 타면 관측되고 `self implement` 로 타면 **관측이 통째로 유실**됐다.
//   ⇒ 같은 결함이 이 레포에서 세 번째다(`self review` sink 가 분기 안 · `self author` #5930).
//   **하나씩 고치는 대신 빼먹을 수 없게** 만든다. 선례 = `agentCmd.hook('preAction')`.
//   surface 결정·중복 회피는 `selfCliSinkSurface` 가 소유하고 테스트가 잠근다.
selfCmd.hook('preAction', async (_thisCommand, actionCommand) => {
  // origin은 sink가 부팅 관측을 발화하기 전에 정해져야 한다. sink 위치는 유지한다.
  const { establishExecutionOrigin } = await import('./agent/identity-env.js');
  establishExecutionOrigin();
  // ⛔ **훅 전체가 try 안이다**(리뷰 must-fix) — surface 결정 모듈의 동적 import 가 실패하면
  //   그것만으로 **모든 `self` 명령이 죽는다**. 관측 배선은 fail-open 이어야 한다:
  //   로그가 logs.db 에 못 닿는 것보다 명령이 안 도는 것이 훨씬 나쁘다(파일 트레일이 진실원).
  try {
    const { selfCliSinkSurface } = await import('./self-implement/self-cli-sink-surface.js');
    const surface = selfCliSinkSurface(actionCommand.name());
    if (surface === null) return;   // review 는 자기 seam 이 등록한다(중복 싱크 방지)
    await (await import('./domains/standalone-log-sink.js')).registerStandaloneLogSink(surface);
  } catch { /* fail-open — 관측 배선 실패가 명령을 막지 않는다 */ }
});

export interface EntrancesActionDependencies {
  baseline: readonly string[];
  actualEntrances?: ReturnType<typeof collectCommandEntrances>;
  writeOutput: (output: string) => void;
  writeError: (output: string) => void;
  setExitCode: (exitCode: 0 | 1) => void;
}

const ENTRANCE_DRIFT_DETAIL_LIMIT = 5;

function renderEntranceDriftNames(label: 'missing' | 'added', names: readonly string[]): string {
  const shown = names.slice(0, ENTRANCE_DRIFT_DETAIL_LIMIT);
  const hidden = names.length - shown.length;
  const values = shown.length === 0 ? '(empty)' : shown.join(', ');
  const suffix = hidden > 0 ? ` (showing ${shown.length} of ${names.length}; truncated ${hidden})` : '';
  return `${label}: ${values}${suffix}`;
}

export function runEntrancesAction(
  opts: { json?: boolean },
  dependencies: EntrancesActionDependencies,
): ReturnType<typeof evaluateCommandEntranceBaseline> {
  const entrances = dependencies.actualEntrances ?? collectCommandEntrances(program);
  const evaluation = evaluateCommandEntranceBaseline(dependencies.baseline, entrances);
  const comparison = {
    missingCount: evaluation.missing.length,
    addedCount: evaluation.added.length,
    missing: evaluation.missing,
    added: evaluation.added,
  };
  // ⭐⭐ 「발사 입구」는 CLI 명령과 «다른 축»이다 — 같은 명령이 여러 발사 입구를 갖고,
  //   NL·슬래시·데몬 입구는 Commander 에 «아예 안 뜬다».
  //   ⛔ 그래서 이 자리에서 «둘 다» 낸다. 종전엔 RFC 문서의 표가 유일한 목록이었고 그 표는 늙었다
  //     (2026-08-17: 「입구가 넷인 줄 알았는데 열셋」).
  const launchSummary = summarizeEntrances();
  const result = {
    rootCommandCount: program.commands.length,
    entrances,
    comparison,
    launchEntrances: { ...launchSummary, declarations: listEntrancesWithModelExposure() },
  };
  const inventory = renderCommandEntrances(entrances, result.rootCommandCount);
  const comparisonOutput = [
    `baseline comparison completed: missing ${comparison.missingCount}, added ${comparison.addedCount}`,
    renderEntranceDriftNames('missing', evaluation.missing),
    renderEntranceDriftNames('added', evaluation.added),
  ].join('\n');
  const output = opts.json
    ? JSON.stringify(result, null, 2)
    : `${inventory}\n\n${renderLaunchEntrances()}\n\n${comparisonOutput}`;
  dependencies.writeOutput(output);

  if (evaluation.missing.length > 0) {
    dependencies.writeError(`missing CLI entrances from baseline: ${renderEntranceDriftNames('missing', evaluation.missing)}`);
  }
  dependencies.setExitCode(evaluation.exitCode);
  return evaluation;
}

selfCmd
  .command('entrances')
  .description('현재 조립된 Commander CLI 입구 목록을 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  .action(async (opts: { json?: boolean }) => {
    let output = '';
    runEntrancesAction(opts, {
      baseline: CLI_ENTRANCE_BASELINE,
      writeOutput: (text) => { output = text; },
      writeError: console.error,
      setExitCode: (exitCode) => { process.exitCode = exitCode; },
    });
    await writeStdoutJson(`${output}\n`);
  });

selfCmd
  .command('run-ledger <runId>')
  .description('self-implement 런의 JSONL 관측 원장을 출력한다')
  // ⛔ 「원문 그대로」라고 말하지 않는다 — 읽어서 파싱한 뒤 다시 직렬화하므로 공백·빈 줄이 보존되지 않는다.
  //    도구가 «자기가 무엇을 하는지» 틀리게 말하면 그 위에서 내린 판정이 틀린다(리뷰 should-fix).
  .option('--json', '한 줄에 한 항목으로 재직렬화해 출력한다(원문 공백·빈 줄은 보존되지 않는다)')
  .option('--all', 'logs와 같은 전 인스턴스 연합 원장 조회를 한다')
  .option('--include-test', '--all 연합에 격리 test 인스턴스도 포함한다')
  .action(async (runId: string, opts: { json?: boolean; all?: boolean; includeTest?: boolean }) => {
    const { describeFederatedMissingRunLedger, describeMissingRunLedger, lookupRunLedger, renderRunLedger } = await import('./self-implement/run-ledger.js');
    try {
      const lookup = lookupRunLedger(runId, { all: opts.all, ...(opts.includeTest === undefined ? {} : { includeTest: opts.includeTest }) });
      if (lookup.matches.length === 0) {
        const missing = opts.all
          ? describeFederatedMissingRunLedger(runId, opts.includeTest === undefined ? {} : { includeTest: opts.includeTest })
          : describeMissingRunLedger(runId);
        console.error(`run ledger not found: ${missing.runLedgerPath}`);
        console.error(`checked ${missing.checkedPaths.length} paths: ${missing.checkedPaths.join('; ')}`);
        if (missing.selfDevRunFound) {
          console.error(`self-dev run checkpoint found: ${missing.selfDevRunPath}`);
          console.error(`inspect it with: elanous self participants ${runId}`);
        } else {
          console.error(`self-dev run checkpoint not found: ${missing.selfDevRunPath}`);
        }
        process.exitCode = 1;
        return;
      }
      if (lookup.matches.length > 1) {
        console.error(`run ledger lookup is ambiguous for ${runId}: ${lookup.matches.length} candidates`);
        for (const match of lookup.matches) console.error(`candidate runId=${match.runId} universe=${match.targetName ?? 'current'}; ledger directory: ${match.ledgerDirectory}; path: ${match.ledgerPath}`);
        process.exitCode = 1;
        return;
      }
      const match = lookup.matches[0]!;
      if (opts.json && match.skippedTrailingBytes !== undefined) console.error(`skipped incomplete trailing run ledger line: ${match.skippedTrailingBytes} bytes`);
      if (opts.all && !opts.json) console.log(`run ledger found in universe: ${match.targetName ?? 'current'} (${match.ledgerDirectory})`);
      if (opts.json) await writeStdoutJson(match.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      else console.log(renderRunLedger(match.entries));
    } catch (error) {
      console.error(`unable to load run ledger: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-status <goalId>')
  .description('원장에 기록된 골의 마지막 상태 전이를 읽기 전용으로 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  // ⛔⭐ 연합 조회를 «인자로» 받는다 — 종전 판은 옵션 없이 queryGoalStatus(goalId) 를 불렀고,
  //   그 경로는 격리 test 인스턴스를 «안 본다». 그런데 goal-loop 이 내는 `goal-status` 이벤트는
  //   실측(2026-08-17 · 우주 셋 전수)에서 prod 0 · test 63 이라, ***라이브에서 항상 not-found 였다.***
  //   ⇒ 「없다」와 「안 봤다」가 같은 산출로 나오던 것을 가른다(`self run-ledger` 와 같은 형태).
  .option('--all', 'logs와 같은 전 인스턴스 연합 원장 조회를 한다')
  .option('--include-test', '--all 연합에 격리 test 인스턴스도 포함한다')
  .action(async (goalId: string, opts: { json?: boolean; all?: boolean; includeTest?: boolean }) => {
    try {
      const { queryGoalStatus, renderGoalStatus } = await import('./goals/resume-supervisor.js');
      const result = queryGoalStatus(goalId, {
        ...(opts.all === undefined ? {} : { all: opts.all }),
        ...(opts.includeTest === undefined ? {} : { includeTest: opts.includeTest }),
      });
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else if (!result.found) console.error(renderGoalStatus(result));
      else console.log(renderGoalStatus(result));
      if (!result.found) process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (opts.json) await writeStdoutJson(JSON.stringify({ found: false, goalId, kind: 'error', error: message }) + '\n');
      else console.error(`unable to query goal status: ${message}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-source-distribution')
  .description('self-implement 런 원장의 start goalSource 분포를 읽기 전용으로 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  .action(async (opts: { json?: boolean }) => {
    try {
      const { queryGoalSourceDistribution, renderGoalSourceDistribution } = await import('./self-implement/run-ledger.js');
      const result = queryGoalSourceDistribution();
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else console.log(renderGoalSourceDistribution(result));
    } catch (error) {
      console.error(`unable to query goal source distribution: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-runs <runId>')
  .description('run ID로 SQLite에 이중 기록된 goal 실행 기록을 출력한다')
  .option('--json', '구조화된 JSON 한 줄씩 출력한다')
  .action(async (runId: string, opts: { json?: boolean }) => {
    try {
      const { loadGoalRunRecordsByRunId, renderGoalRunRecords } = await import('./self-implement/goal-run-store.js');
      const records = loadGoalRunRecordsByRunId(runId);
      if (opts.json) await writeStdoutJson(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      else console.log(renderGoalRunRecords(records));
    } catch (error) {
      console.error(`unable to load goal runs: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-run <runId>')
  .description('한 goal 실행 런의 원장과 연합 로그 요약을 읽기 전용으로 부검한다')
  .option('--json', '원장·로그 요약과 읽지 못한 인스턴스를 구조화된 JSON으로 출력한다')
  .action(async (runId: string, opts: { json?: boolean }) => {
    try {
      const [{ inspectGoalRun, renderGoalRunInspection }, { resolveLogTargets }, { getTestStateRoot }, { dirname }] = await Promise.all([
        import('./self-implement/goal-run-store.js'),
        import('./cli/logs-cli.js'),
        import('./nexus/paths.js'),
        import('node:path'),
      ]);
      const testStateRoot = getTestStateRoot();
      const resolved = resolveLogTargets(
        testStateRoot === undefined ? { all: true, includeTest: true } : { test: true },
        testStateRoot === undefined ? {} : { cwd: dirname(testStateRoot) },
      );
      const result = inspectGoalRun(runId, undefined, { targets: resolved.targets });
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else console.log(renderGoalRunInspection(result));
    } catch (error) {
      console.error(`unable to inspect goal run: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-run-search')
  .description('goal 실행 원장을 조건으로 읽기 전용 검색한다')
  .option('--goal <goalId>', 'GoalId로 필터한다')
  .option('--started-at <timestamp>', '시작 시각 하한(ISO 8601)으로 필터한다')
  .option('--outcome <outcome>', 'outcome으로 필터한다')
  .option('--stage <stage>', 'stage로 필터한다')
  // ⭐ 칸마다 플래그를 늘리지 않는다 — 원장 레코드에 칸이 계속 느는데 생성 컬럼은 넷뿐이라
  //   「값은 굳었는데 세는 길이 없다」가 반복됐다(`F12` 셋째 자리). 이 한 플래그가 그것을 닫는다.
  .option('--doc <경로=값>', 'doc JSON 의 아무 칸으로 필터한다(예: completionIntent=auto-merge · quotaAccountAvailability.to=team). 여러 번 주면 AND', (v: string, prev: string[]) => [...prev, v], [] as string[])
  // ⭐ 「그 칸이 «있나»」는 값 필터로 못 묻는다 — 착지한 칸이 실제로 «흐르나»(F12)를 세는 자리다.
  .option('--doc-present <경로>', 'doc JSON 에 그 칸이 «있는» 기록만 센다(예: orchestrationId). 여러 번 주면 AND', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--limit <count>', '반환할 최대 기록 수', '50')
  .option('--json', '검색 메타데이터와 기록을 구조화된 JSON으로 출력한다')
  .action(async (opts: { goal?: string; startedAt?: string; outcome?: string; stage?: string; doc?: string[]; docPresent?: string[]; limit: string; json?: boolean }) => {
    try {
      const { loadGoalRunQuery, renderGoalRunQuery, parseGoalRunDocFilter, parseGoalRunDocPath } = await import('./self-implement/goal-run-store.js');
      const parsedLimit = Number.parseInt(opts.limit, 10);
      // ⛔ 못 읽는 필터는 «던진다» — 조용히 무시하면 사용자가 「걸었다」고 믿고 전수를 본다.
      const docFilters = (opts.doc ?? []).map(parseGoalRunDocFilter);
      const docPresent = (opts.docPresent ?? []).map(parseGoalRunDocPath);
      const result = loadGoalRunQuery({
        goalId: opts.goal,
        startedAt: opts.startedAt,
        outcome: opts.outcome as never,
        stage: opts.stage as never,
        ...(docFilters.length ? { docFilters } : {}),
        ...(docPresent.length ? { docPresent } : {}),
        limit: Number.isSafeInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 50,
      });
      if (result === null) throw new Error('goal run ledger could not be read');
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else console.log(renderGoalRunQuery(result));
    } catch (error) {
      console.error(`unable to search goal runs: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-asks')
  .description('CLI 저작 ask 원장을 goal 또는 author run 기준으로 읽기 전용 조회한다')
  .option('--goal <goalId>', 'GoalId로 필터한다')
  .option('--run <authorRunId>', 'author run ID로 필터한다')
  .option('--text <text>', 'ask 또는 goal file 문면으로 필터한다')
  .option('--limit <count>', '반환할 최대 기록 수', '50')
  .option('--json', 'ask 전문을 포함한 JSON 한 줄씩 출력한다')
  .action(async (opts: { goal?: string; run?: string; text?: string; limit: string; json?: boolean }) => {
    try {
      const { loadGoalAskRecords, renderGoalAskRecords } = await import('./self-implement/goal-ask-store.js');
      const parsedLimit = Number.parseInt(opts.limit, 10);
      const records = loadGoalAskRecords({
        goalId: opts.goal,
        authorRunId: opts.run,
        text: opts.text,
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
      });
      if (opts.json) await writeStdoutJson(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      else console.log(renderGoalAskRecords(records));
    } catch (error) {
      console.error(`unable to load goal asks: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('goal-test-scenarios')
  .description('최근 골 문서의 ## 검증 시나리오 절을 읽기 전용 표본으로 조회한다')
  .option('--dir <path>', '조회할 골 문서 디렉터리', 'docs/goals')
  .option('--limit <count>', '조회할 최신 골 문서 수', '3')
  .option('--json', '조회 결과와 절 상태를 구조화된 JSON으로 출력한다')
  .action(async (opts: { dir: string; limit: string; json?: boolean }) => {
    try {
      const { sampleGoalTestScenarios, renderGoalTestScenarioQuery } = await import('./self-implement/goal-test-scenarios.js');
      const parsedLimit = Number.parseInt(opts.limit, 10);
      const query = sampleGoalTestScenarios(resolveCliDirOption(opts.dir), Number.isSafeInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 3);
      if (opts.json) await writeStdoutJson(JSON.stringify(query) + '\n');
      else console.log(renderGoalTestScenarioQuery(query));
    } catch (error) {
      console.error(`unable to sample goal test scenarios: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('unfinished-runs')
  .description('종결 기록이 없는 self-implement 런과 골의 예정 경로를 읽기 전용으로 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  .option('--path <path>', '예정 경로가 일치하거나 읽을 수 없는 런만 출력한다')
  .option('--all', 'logs와 같은 전 인스턴스 연합 원장 조회를 한다')
  .option('--include-test', '--all 연합에 격리 test 인스턴스도 포함한다')
  .action(async (opts: { json?: boolean; path?: string; all?: boolean; includeTest?: boolean }) => {
    try {
      const { queryFederatedUnfinishedRunLedgers, queryUnfinishedRunLedgers, renderUnfinishedRunLedgers } = await import('./self-implement/run-ledger.js');
      const result = opts.all
        ? queryFederatedUnfinishedRunLedgers({ ...(opts.path === undefined ? {} : { path: opts.path }), ...(opts.includeTest === undefined ? {} : { includeTest: opts.includeTest }) })
        : queryUnfinishedRunLedgers(opts.path === undefined ? undefined : { path: opts.path });
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + '\n');
      else console.log(renderUnfinishedRunLedgers(result));
    } catch (error) {
      console.error(`unable to query unfinished runs: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('unfinished-runs-cleanup')
  .description('종결 증거가 있는 오래된 미완료 self-implement 런 원장을 계획하거나 명시적으로 정리한다')
  .option('--age <minutes>', '이 분(min)보다 오래된 종료 증거 런만 정리 대상으로 판정한다')
  .option('--remove', '계획만 하지 않고 정리 대상으로 판정된 원장 파일을 실제로 삭제한다')
  .option('--json', '계획·삭제·보존 수와 조회 불완전 상태를 구조화된 JSON으로 출력한다')
  .action(async (opts: { age?: string; remove?: boolean; json?: boolean }) => {
    try {
      const { DEFAULT_UNFINISHED_LIVE_WINDOW_MS, cleanupUnfinishedRunLedgers } = await import('./self-implement/run-ledger.js');
      const age = opts.age;
      if (age !== undefined && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(age)) {
        throw new Error(`--age must be a non-negative number of minutes: ${age}`);
      }
      const liveWindowMs = age === undefined
        ? DEFAULT_UNFINISHED_LIVE_WINDOW_MS
        : Number(age) * 60_000;
      const result = cleanupUnfinishedRunLedgers({ liveWindowMs, remove: opts.remove === true });
      if (opts.json) {
        await writeStdoutJson(JSON.stringify(result) + '\n');
        return;
      }
      await writeStdoutJson(JSON.stringify({
        planned: result.plannedRemoval.length,
        removed: result.removed.length,
        preserved: result.preserved.length,
        queryUnavailable: result.counts.queryUnavailable > 0,
        unavailable: result.unavailable,
        invalidLiveWindow: result.invalidLiveWindow,
      }) + '\n');
    } catch (error) {
      console.error(`unable to clean up unfinished runs: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('running-runs')
  .description('원장과 살아 있는 PTY를 함께 읽어 현재 자율 런 판정을 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  .option('--include-test', '연합 관측에 격리 test 인스턴스도 포함한다')
  .action(async (opts: { json?: boolean; includeTest?: boolean }) => {
    try {
      const { queryRunningRuns, renderRunningRuns } = await import('./self-implement/running-runs.js');
      const result = queryRunningRuns({ includeTest: opts.includeTest, caller: 'cli' });
      const output = `${opts.json ? JSON.stringify(result) : renderRunningRuns(result)}\n`;
      await writeStdoutJson(output);
    } catch (error) {
      console.error(`unable to query running runs: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('merge-attribution')
  .description('self-implement 런 원장에서 관측 가능한 머지 주체 사실을 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  .action(async (opts: { json?: boolean }) => {
    try {
      const { queryMergeAttribution, formatUnattributableDetail } = await import('./self-implement/run-ledger.js');
      const result = queryMergeAttribution();
      if (opts.json) {
        await writeStdoutJson(JSON.stringify(result) + '\n');
        return;
      }
      console.log(`ledger directory: ${result.ledgerDirectory}`);
      console.log(`elanous merged: ${result.elanousMergedEntries.length}`);
      console.log(`handed to human (no merge attempt): ${result.handedToHumanWithoutMergeAttemptCount}`);
      for (const entry of result.handedToHumanEntries.filter((entry) => entry.branch === 'without-merge-attempt')) {
        console.log(`  PR ${entry.prNumber ?? 'unknown'} runId=${entry.runId} timestamp=${entry.timestamp} mergeReason=${entry.mergeReason ?? 'none'}`);
      }
      if (!result.handedToHumanEntries.some((entry) => entry.branch === 'without-merge-attempt')) console.log('  none');
      console.log(`handed to human (merge attempted): ${result.handedToHumanAfterMergeAttemptCount}`);
      for (const entry of result.handedToHumanEntries.filter((entry) => entry.branch === 'after-merge-attempt')) {
        console.log(`  PR ${entry.prNumber ?? 'unknown'} runId=${entry.runId} timestamp=${entry.timestamp} mergeReason=${entry.mergeReason ?? 'none'}`);
      }
      if (!result.handedToHumanEntries.some((entry) => entry.branch === 'after-merge-attempt')) console.log('  none');
      console.log(`unattributable: ${result.unattributable.status} — ${formatUnattributableDetail(result.unattributable)}`);
      console.log(`excluded merged entries: ${result.excludedMergedEntryCount}`);
      console.log(`excluded ledgers: ${result.excludedLedgerCount}`);
      console.log(`note: ${result.note}`);
    } catch (error) {
      console.error(`unable to query merge attribution: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('run-chain')
  .description('머지된 self-implement 런의 원장·로그 사슬과 다섯 홉 상태를 한 줄씩 출력한다')
  .option('--json', '구조화된 JSON으로 출력한다')
  .action(async (opts: { json?: boolean }) => {
    try {
      const { queryRunChain, renderRunChain } = await import('./self-implement/run-ledger.js');
      const result = queryRunChain();
      console.log(opts.json ? JSON.stringify(result) : renderRunChain(result));
    } catch (error) {
      console.error(`unable to query run chain: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

const selfLedgerCmd = selfCmd.command('ledger').description('하니스 원장 검사 및 보관');
selfLedgerCmd
  .command('compact')
  .description('오래된 종료 런 원장을 월별 gzip 보관소로 옮긴다')
  .option('--dry-run', '변경 없이 계획만 출력한다')
  .option('--min-age-hours <hours>', '마지막 기록 후 최소 경과 시간', '24')
  .option('--json', '계획과 결과를 JSON으로 출력한다')
  .action(async (opts: { dryRun?: boolean; minAgeHours: string; json?: boolean }) => {
    try {
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(opts.minAgeHours) || !Number.isFinite(Number(opts.minAgeHours))) {
        throw new Error(`--min-age-hours must be a finite non-negative number: ${opts.minAgeHours}`);
      }
      const { planLedgerCompaction, applyLedgerCompaction } = await import('./self-implement/run-ledger-compact.js');
      const plan = planLedgerCompaction({ minAgeHours: Number(opts.minAgeHours) });
      const result = opts.dryRun ? {
        moved: plan.move.length, kept: plan.keep.length,
        bytesBefore: plan.move.reduce((sum, item) => sum + statSync(item.from).size, 0),
        bytesAfter: 0, failures: [],
      } : applyLedgerCompaction(plan);
      if (opts.json) await writeStdoutJson(JSON.stringify({ dryRun: Boolean(opts.dryRun), plan, ...result }) + '\n');
      else {
        const counts = (reason: string) => plan.keep.filter((item) => item.reason === reason).length;
        console.log(`옮김 ${result.moved} · 남김 ${result.kept}(미완 ${counts('unfinished')} · 최근 ${counts('too-recent')} · 못 읽음 ${counts('unreadable')}${counts('restore-conflict') ? ` · 복귀 충돌 ${counts('restore-conflict')}` : ''}) · 크기 ${result.bytesBefore}→${opts.dryRun ? '미측정' : result.bytesAfter}${opts.dryRun ? ' (dry-run)' : ''}`);
        if (result.failures.length) console.error(`압축 실패: ${JSON.stringify(result.failures)}`);
      }
      if (result.failures.length) process.exitCode = 1;
    } catch (error) {
      console.error(`❌ ledger compact failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });
selfLedgerCmd
  .command('lint')
  .description('docs/harness 원장 항목의 status-vocab·four-lines·linkage 위반을 보고한다')
  .option('--dir <path>', '검사할 원장 디렉터리 또는 ISSUES.md 파일', 'docs/harness')
  .option('--strict', '위반이 있으면 종료 코드 1')
  .action(async (opts: { dir: string; strict?: boolean }) => {
    try {
      const { runLedgerLint } = await import('./harness/ledger-lint.js');
      const outcome = runLedgerLint(resolveCliDirOption(opts.dir), opts.strict ?? false);
      console.log(outcome.output);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      console.error(`❌ ledger lint failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('git-discipline')
  .description('src와 scripts에서 git 프로세스를 src/git-fs 관문 밖에서 띄우는 자리를 세고 기준선과 비교한다(I-T4 래칫)')
  // ⛔ `--root` 를 두지 않는다(리뷰 should-fix) — 기준선 키가 `src/…` 상대경로라 다른 루트를 주면
  //    키가 안 맞고 `src/git-fs/` 관문 판정도 깨진다. **미지원 옵션을 노출하는 것보다 없는 게 낫다.**
  .option('--strict', '기준선 대비 회귀가 있으면 종료 코드 1')
  .action(async (opts: { strict?: boolean }) => {
    try {
      const { runGitSpawnDiscipline } = await import('./git-fs/spawn-discipline.js');
      const { GIT_SPAWN_BASELINE } = await import('./git-fs/spawn-discipline-baseline.js');
      const outcome = runGitSpawnDiscipline(undefined, GIT_SPAWN_BASELINE, opts.strict ?? false);
      console.log(outcome.output);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      console.error(`❌ git-discipline failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

selfCmd
  .command('author [ask...]')
  .description('자연어 ask 또는 미결 clarification을 grounding한 여덟 절 goal 파일로만 작성하거나, --lint로 기존 골 파일을 검사한다.')
  .option('--cwd <path>', 'goal을 ground하고 docs/goals/ 아래에 쓸 repository root', process.cwd())
  .option('--lint <goalFile>', '골 파일을 읽기 전용으로 검사한다; 다른 author 인자와 함께 쓸 수 없다')
  .option('--print-template', 'canonical 골 절 골격과 필수 수준을 읽기 전용으로 출력한다; 다른 author 인자와 함께 쓸 수 없다')
  .option('--inspect-decision-signal <text>', '판정 신호 표지가 배포 마커 정규식에 매치되는지 즉시 검사한다; goal을 작성하지 않는다')
  .option('--inspect-invariant <text>', '불변식 표지·파싱과 실제 repository 접지 근거를 즉시 검사한다; goal은 작성하지 않는다')
  .option('--inspect-boundary <text>', '경계 표지와 파싱을 즉시 검사한다; goal을 작성하지 않는다')
  .option('--inspect-artifact-launch <goalFile>', '골 문서의 선택적 산출물 기동 선언을 즉시 검사한다; goal을 작성하지 않는다')
  .option('--inspect-test-scenario <scenarioFile>', '테스트 시나리오 문서의 산출물 종류와 라이브 검사 계약을 즉시 검사한다; goal을 작성하지 않는다')
  .option('--inspect-target-paths <text>', 'ask 첫 비어 있지 않은 줄의 대상 경로 힌트를 즉시 검사한다; goal을 작성하지 않는다')
  .option('--parent-goal-file <path>', '이 골을 낳은 부모 골 문서의 repository-relative path')
  .option('--parent-question-id <id>', '이 골을 낳은 부모 골의 미결 질문 ID')
  .option('--from-clarification <goalFile#questionId>', '미결 clarification에서 ask와 부모 출처를 자동으로 채운다')
  .option('--supersedes <goalFile>', '이전 골 문서의 GoalId를 계승하고 Superseded-By 역링크를 기록한다')
  .option('--root-intent <text>', '새 루트 또는 RootIntent 없는 레거시 부모에 기록할 단일 행 루트 목적')
  .option('--goal-type <type>', '골 종류 (implement, research, document, operate)')
  .option('--adversarial-review', '골 분해의 adversarial review를 문턱과 무관하게 실행한다')
  .option('--disable-adversarial-review', '골 분해의 adversarial review를 실행하지 않는다')
  // ⭐ 저작한 골을 **상주 루프의 큐**에 넣는다(옵트인). ⛔ 종료 규칙은 저작기가 만들 수 없어(골 문서에
  //   그 개념이 없다) 사람이 명시한다 — 없으면 넣지 않는다(fail-closed).
  .option('--enqueue', '저작한 골을 데몬 상주 루프의 골 큐에 넣는다 (--termination-command 필요)')
  .option('--termination-command <cmd>', '큐에 넣을 때 쓸 종료 판정 명령 (exit 0 이면 그 골은 끝난 것)')
  .option('--termination-timeout <ms>', '종료 판정 명령의 제한 시간(ms)', '5000')
  .action(async (parts: string[], opts: { cwd: string; lint?: string; printTemplate?: boolean; inspectDecisionSignal?: string; inspectInvariant?: string; inspectBoundary?: string; inspectArtifactLaunch?: string; inspectTestScenario?: string; inspectTargetPaths?: string; parentGoalFile?: string; parentQuestionId?: string; fromClarification?: string; supersedes?: string; rootIntent?: string; goalType?: string; adversarialReview?: boolean; disableAdversarialReview?: boolean; enqueue?: boolean; terminationCommand?: string; terminationTimeout?: string }, command?: { getOptionValueSource?: (key: string) => string | undefined }) => {
    if (opts.printTemplate) {
      const timeoutFromCli = command?.getOptionValueSource?.('terminationTimeout') === 'cli';
      if (opts.lint || parts.length || opts.inspectDecisionSignal !== undefined || opts.inspectInvariant !== undefined || opts.inspectBoundary !== undefined || opts.inspectArtifactLaunch !== undefined || opts.inspectTestScenario !== undefined || opts.inspectTargetPaths !== undefined
        || opts.parentGoalFile || opts.parentQuestionId || opts.fromClarification || opts.supersedes || opts.rootIntent || opts.goalType || opts.adversarialReview || opts.disableAdversarialReview
        || opts.enqueue || opts.terminationCommand || timeoutFromCli) {
        console.error('❌ --print-template cannot be combined with author arguments');
        process.exitCode = 2;
        return;
      }
      const { formatGoalTemplate } = await import('./self-implement/goal-author.js');
      console.log(formatGoalTemplate());
      return;
    }
    const inspection = opts.inspectDecisionSignal !== undefined
      ? { text: opts.inspectDecisionSignal, kind: 'decision-signal' as const }
      : opts.inspectInvariant !== undefined
        ? { text: opts.inspectInvariant, kind: 'invariant' as const }
        : opts.inspectBoundary !== undefined
          ? { text: opts.inspectBoundary, kind: 'boundary' as const }
          : opts.inspectArtifactLaunch !== undefined
            ? { text: opts.inspectArtifactLaunch, kind: 'artifact-launch' as const }
            : opts.inspectTestScenario !== undefined
              ? { text: opts.inspectTestScenario, kind: 'test-scenario' as const }
              : opts.inspectTargetPaths !== undefined
                ? { text: opts.inspectTargetPaths, kind: 'target-paths' as const }
                : null;
    if (inspection) {
      const cwdFromCli = command?.getOptionValueSource?.('cwd') === 'cli';
      const timeoutFromCli = command?.getOptionValueSource?.('terminationTimeout') === 'cli';
      // 불변식 inspection은 실제 repository grounding을 조회하므로 --cwd로 그 root를 명시할 수 있다.
      // 다른 순수 marker inspection은 cwd를 소비하지 않으므로 여전히 조용히 무시하지 않고 거부한다.
      const inspectionAcceptsCwd = inspection.kind === 'invariant';
      if (opts.lint || parts.length || opts.parentGoalFile || opts.parentQuestionId || opts.fromClarification || opts.supersedes || opts.rootIntent || opts.goalType || opts.adversarialReview || opts.disableAdversarialReview
        || opts.enqueue || opts.terminationCommand || (!inspectionAcceptsCwd && cwdFromCli) || timeoutFromCli
        || [opts.inspectDecisionSignal, opts.inspectInvariant, opts.inspectBoundary, opts.inspectArtifactLaunch, opts.inspectTestScenario, opts.inspectTargetPaths].filter((value) => value !== undefined).length !== 1) {
        console.error('❌ inspection options cannot be combined with author arguments or each other');
        process.exitCode = 2;
        return;
      }
      const { groundInvariantInspection, inspectArtifactLaunchDeclaration, inspectAskBoundaryMarker, inspectAskDecisionSignalMarker, inspectAskInvariantMarker, inspectTestScenarioDeclaration } = await import('./self-implement/goal-author.js');
      const result = inspection.kind === 'decision-signal'
        ? inspectAskDecisionSignalMarker(inspection.text)
        : inspection.kind === 'invariant'
          ? inspectAskInvariantMarker(inspection.text, await groundInvariantInspection(inspection.text, opts.cwd))
          : inspection.kind === 'artifact-launch'
            ? inspectArtifactLaunchDeclaration(readFileSync(inspection.text, 'utf8'))
            : inspection.kind === 'test-scenario'
              ? inspectTestScenarioDeclaration(readFileSync(inspection.text, 'utf8'))
              : inspection.kind === 'target-paths'
                ? (await import('./self-dev/launch-preflight.js')).parseAskTargetPathHintsResult(inspection.text)
                : inspectAskBoundaryMarker(inspection.text);
      const decision = 'paths' in result ? result.paths.length > 0 : result.extracted;
      debug.log('goal-author.inspect', 'result', { kind: inspection.kind, decision });
      await writeStdoutJson(JSON.stringify(result) + '\n');
      return;
    }
    if (opts.lint) {
      // ⛔ 큐 옵션도 상호배타에 넣는다 — 빠져 있었더니 `--lint X --enqueue …` 가 큐 옵션을 **조용히
      //   무시**했다(리뷰 should-fix). `--lint` 는 읽기 전용이라 넣을 골 자체가 없다.
      // ⚠️ `--termination-timeout` 은 **기본값이 있어** 항상 truthy 다 ⇒ 값이 아니라 **출처**를 본다.
      //   출처를 못 얻는 경우(테스트의 직접 호출 등)는 검사하지 않는다 — 없는 정보로 막지 않는다.
      const timeoutFromCli = command?.getOptionValueSource?.('terminationTimeout') === 'cli';
      if (parts.length || opts.parentGoalFile || opts.parentQuestionId || opts.fromClarification || opts.supersedes || opts.rootIntent || opts.goalType || opts.adversarialReview || opts.disableAdversarialReview
        || opts.enqueue || opts.terminationCommand || timeoutFromCli) {
        console.error('❌ --lint cannot be combined with author arguments');
        process.exitCode = 2;
        return;
      }
      try {
        const [{ readFileSync }, { runGitCommand }, { lintGoalFile, formatGoalFileLintFinding, planGateSignals }, { createRepositoryReferencedFileReader }] = await Promise.all([
          import('node:fs'),
          import('./git-fs/runner.js'),
          import('./self-implement/goal-author.js'),
          import('./self-implement/goal-file-reader.js'),
        ]);
        const readReferencedFile = createRepositoryReferencedFileReader(opts.cwd);
        const branchResult = runGitCommand(opts.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
        if (branchResult.status !== 0) throw new Error(branchResult.stderr || 'git branch resolution failed');
        const branch = branchResult.stdout.trim();
        const document = readFileSync(opts.lint, 'utf8');
        const findings = lintGoalFile(document, branch, { readReferencedFile });
        for (const finding of findings) console.log(formatGoalFileLintFinding(finding));
        await writeStdoutJson(JSON.stringify(planGateSignals(document, findings)) + '\n');
        if (findings.some((finding) => finding.level === 'ERROR')) process.exitCode = 1;
      } catch (error) {
        console.error(`❌ goal lint failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }
    // ⛔ 원문을 **변형하지 않는다.** `.trim()` 은 선행·후행 공백을 지워 verbatim 계약을 입구에서
    //   깨뜨린다(리뷰 실측). 빈 입력 판정에만 trim 을 쓰고, 저작기에는 결합한 원문을 그대로 넘긴다.
    //   ⚠️ 셸이 인자를 이미 나눠 주므로 단어 사이 공백은 여기서 복원할 수 없다 — 정확한 원문이
    //   필요하면 따옴표로 감싸 한 인자로 준다.
    if (!parts.join(' ').trim() && !opts.fromClarification && !opts.supersedes) { console.error('❌ ask 필요: elanous self author "<goal>" 또는 --from-clarification <goalFile>#<questionId> 또는 --supersedes <goalFile>'); process.exit(2); }
    // ⭐ 관측 sink 등록(2026-07-30) — ⛔ 이것이 없으면 저작기가 남기는 발화가 **logs.db 에 닿지
    //   않는다**. 실측: `elanous self author` 직후 `grounding.persistent`·`grounding.search` 가
    //   **양쪽 인스턴스에서 0건**이었는데, 같은 창의 A/B 는 탐색이 실제로 돈 것을 보여 줬다
    //   (정답 파일이 없음→1·2위). ⇒ "안 탔다" 가 아니라 **"관측이 안 닿았다"** 였다.
    //   같은 결함이 `self review` 에서 이미 한 번 났다(sink 등록이 분기 안에 있어 기본 경로 0건).
    //   ⚠️ fail-open — 관측 배선 실패가 저작 자체를 막지 않는다.
    try {
      const { runGoalAuthorCli, formatGoalAuthorSelfInspection, formatGoalInterviewRound } = await import('./self-implement/goal-author-cli.js');
      // 설정 졸업 1-c(2026-09-26): 되묻기 자동 답변은 늘 켠다 — `harness ask/say` 와 같은 동작(옵션 없음).
      const result = await runGoalAuthorCli(parts, { ...opts, selfResolveClarifications: true });
      console.log(result.path);
      // ⭐ grounding 상태를 함께 알린다 — 이 장치의 알려진 약점이 여기서 드러나야 한다.
      //   (dead surface 로 두지 말고 연결하라 · 리뷰 2026-07-28)
      const { grounded, facts } = result.authored;
      // ⛔ `facts` 는 집계기 산출(CodebaseGrounding)이다 — 배열이 아니다.
      //   실측(2026-07-28): 반쪽 마이그레이션 뒤 `facts.length` 가 **`undefined` 를 찍었다**.
      //   ⇒ 종류별로 센다. 코드 후보와 참조 지식은 등급이 다르므로 **뭉쳐 세지 않는다**.
      console.error(grounded && facts
        ? `grounded: 코드 후보 ${facts.files.length} · 참조 지식 ${facts.skillFacts.length + facts.memoryFacts.length + facts.refFacts.length + facts.ptyFacts.length}건`
          + ' — 후보이지 목표가 아니다. 착수 전에 경로를 추적하라.'
        : 'not grounded: 저장소 근거를 못 찾았다. PROBLEM 블록은 미검증이다.');
      // ⛔⭐⭐⭐ 「코드 후보 0」이 «침묵»하지 않게 한다(`goal-grounding-warning.ts` 헤더).
      //   참조 지식은 그대로 나와서 산출이 「접지됐다」처럼 보인다 ⇒ 0 이 「없다」로 읽힌다.
      //   ⛔ 초판은 「링크된 worktree 면 «항상» 0」을 근거로 트리를 트리거에 넣었는데 그것이 반증됐다.
      //      ⇒ 트리 조건을 지웠다. ⚠️ 다만 「트리가 전혀 무관하다」는 «증명되지 않았다»(GOAL-T56 · R-CLM5).
      //   ⚠️ fail-open — 이 경고를 못 내는 것이 저작을 막지 않는다(관측은 결론을 막지 않는다).
      try {
        const { groundingWarning } = await import('./self-implement/goal-grounding-warning.js');
        // ⛔ `facts` 가 없으면 «못 쟀다»이지 「0 으로 관측됐다」가 아니다 — `?? 0` 을 쓰지 않는다
        //    (무인 리뷰 must-fix: 그러면 미관측 상태에 «거짓 경고»가 나간다).
        const warning = groundingWarning({
          codeCandidates: facts ? facts.files.length : undefined,
          referenceFacts: facts
            ? facts.skillFacts.length + facts.memoryFacts.length + facts.refFacts.length + facts.ptyFacts.length
            : 0,
          stopReason: facts?.persistentStopReason,
        });
        if (warning) console.error(warning);
      } catch { /* fail-soft */ }
      const [{ lintGoalFile }, { createRepositoryReferencedFileReader }, { runGitCommand }] = await Promise.all([
        import('./self-implement/goal-author.js'),
        import('./self-implement/goal-file-reader.js'),
        import('./git-fs/runner.js'),
      ]);
      const branchResult = runGitCommand(opts.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
      const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
      const findings = lintGoalFile(result.authored.document, branch, {
        readReferencedFile: createRepositoryReferencedFileReader(opts.cwd),
      });
      console.log(formatGoalAuthorSelfInspection(result.authored.document, findings));
      if (result.interviewRound) {
        const lintErrorCount = findings.filter((finding) => finding.level === 'ERROR').length;
        console.log(formatGoalInterviewRound(result.interviewRound, lintErrorCount));
      }
      if (opts.enqueue) {
        if (!opts.terminationCommand) {
          console.error('❌ --enqueue 에는 --termination-command 가 필요하다 — 종료 판정 없이 큐에 넣으면 그 골은 영영 안 끝난다');
          process.exitCode = 2;
          return;
        }
        const { enqueueAuthoredGoal, authoredGoalSlugFromFile } = await import('./dispatch/authored-goal-queue.js');
        const { relative } = await import('node:path');
        const goalFile = relative(opts.cwd, result.path);
        const queued = await enqueueAuthoredGoal({
          goalSlug: authoredGoalSlugFromFile(goalFile),
          goalFile,
          terminationRule: { kind: 'custom', command: opts.terminationCommand, timeoutMs: Number(opts.terminationTimeout ?? 5000) },
        }, { repositoryRoot: opts.cwd });
        console.error(`queued: ${queued.id} — 상주 루프가 유휴일 때 집는다`);
      }
    } catch (error) {
      console.error(`❌ goal author write failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

const clarifyCmd = selfCmd.command('clarify').description('Authored goal 문서의 미결 clarification을 조회하고 비대화형으로 답을 주입한다.');

clarifyCmd
  .command('list <path>')
  .description('골 문서에 남은 clarification과 옵션을 조회한다.')
  .action(async (path: string) => {
    try {
      const [{ readFileSync }, { parseGoalDocumentClarifications }] = await Promise.all([
        import('node:fs'),
        import('./self-implement/goal-author-clarification.js'),
      ]);
      const pending = parseGoalDocumentClarifications(readFileSync(path, 'utf8')).filter((clarification) => !clarification.answered);
      for (const clarification of pending) {
        console.log(`id: ${clarification.questionId}`);
        console.log(`header: ${clarification.header}`);
        console.log(`question: ${clarification.question}`);
        console.log(`includeOther: ${clarification.includeOther}`);
        for (const option of clarification.options) console.log(`option: ${option.label} — ${option.description}`);
      }
    } catch (error) {
      console.error(`❌ goal clarification list failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

clarifyCmd
  .command('pending')
  .description('디렉터리의 골 문서 가운데 미결 clarification이 남은 문서만 한 줄씩 조회한다.')
  .option('--dir <path>', '조회할 골 문서 디렉터리', 'docs/goals')
  .action(async (opts: { dir: string }) => {
    try {
      const [{ existsSync, readFileSync, readdirSync, realpathSync }, { isAbsolute, join, relative }, { parseGoalDocumentClarifications }, { GoalRunStore, goalRunDbPath, loadLatestGoalRunStatusByGoalFile }, { queryUnfinishedRunLedgers }, { formatClarifyPendingPopulationScope, parseClarifyPendingCreatedAt, triageClarifyPending }] = await Promise.all([
        import('node:fs'),
        import('node:path'),
        import('./self-implement/goal-author-clarification.js'),
        import('./self-implement/goal-run-store.js'),
        import('./self-implement/run-ledger.js'),
        import('./self-implement/clarify-pending-triage.js'),
      ]);
      const { findElanousRepoRoot } = await import('./code-edit/system-file-guard.js');
      const dir = resolveCliDirOption(opts.dir);
      const hasRelativeDirOption = !isAbsolute(opts.dir) && process.argv.some((arg) => arg === '--dir' || arg.startsWith('--dir='));
      const dirRepoRoot = findElanousRepoRoot(dir);
      const dirIsWithinCwd = !relative(process.cwd(), dir).startsWith('..');
      // Goal-run records and pending-row paths share the repository-root basis so nested cwd and --dir invocations remain stable.
      const goalRunBaseDirectory = dirRepoRoot ?? findElanousRepoRoot(process.cwd()) ?? process.cwd();
      const paths = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^GOAL-.*\.md$/.test(entry.name))
        .map((entry) => join(dir, entry.name))
        .sort();
      let runStore: InstanceType<typeof GoalRunStore> | null = null;
      let unfinishedRunLedgers: ReturnType<typeof queryUnfinishedRunLedgers> | null = null;
      let runStoreUnavailable = false;
      try {
        unfinishedRunLedgers = queryUnfinishedRunLedgers({ goalsDir: dir });
      } catch {}
      try {
        runStore = new GoalRunStore(goalRunDbPath(), true);
      } catch {
        if (existsSync(goalRunDbPath())) runStoreUnavailable = true;
      }
      try {
        const unfinishedRunLedger = unfinishedRunLedgers === null
          ? { directory: null, entryCount: null, unreadableLedgerCount: null, directoryMissing: null, readFailed: true }
          : {
            directory: unfinishedRunLedgers.ledgerDirectory,
            entryCount: unfinishedRunLedgers.entries.length,
            unreadableLedgerCount: unfinishedRunLedgers.unreadableLedgerCount,
            directoryMissing: unfinishedRunLedgers.ledgerDirectoryMissing,
            readFailed: false,
          };
        let documentsWithPendingClarifications = 0;
        const rows: Array<{ line: string; status: { kind: 'finished'; outcome: string } | { kind: 'unfinished' } | { kind: 'no-record' } | { kind: 'unavailable' }; createdAt?: Date }> = [];
        const inspectRows = (population: { path: string; recordCount: number | null; readFailed: boolean; missing: boolean }) => {
          for (const path of paths) {
            const document = readFileSync(path, 'utf8');
            const pending = parseGoalDocumentClarifications(document)
              .filter((clarification) => !clarification.answered);
            if (pending.length === 0) continue;
            documentsWithPendingClarifications += 1;
            const status = unfinishedRunLedgers === null || runStoreUnavailable || population.readFailed
              ? { kind: 'unavailable' } as const
              : runStore
                ? runStore.latestStatusByGoalFile(path, { unfinishedRunLedgers, ...(goalRunBaseDirectory ? { baseDirectory: goalRunBaseDirectory } : {}) })
                : loadLatestGoalRunStatusByGoalFile(path, goalRunDbPath(), { unfinishedRunLedgers, ...(goalRunBaseDirectory ? { baseDirectory: goalRunBaseDirectory } : {}) });
            const statusLabel = status.kind === 'unavailable'
              ? 'run: unavailable'
              : status.kind === 'finished'
                ? `run: finished (${status.outcome})`
                : status.kind === 'unfinished'
                  ? 'run: unfinished'
                  : 'run: no-record';
            const displayedGoalPath = dirRepoRoot
              ? relative(goalRunBaseDirectory, path) || '.'
              : hasRelativeDirOption && dirIsWithinCwd
                ? path
                : relative(process.cwd(), path) || '.';
            rows.push({
              line: `${displayedGoalPath}: ${pending.length} pending — ${pending.map((clarification) => clarification.questionId).join(', ')} — ${statusLabel}`,
              status,
              createdAt: parseClarifyPendingCreatedAt(document),
            });
          }
          return formatClarifyPendingPopulationScope({ goalRunStore: population, unfinishedRunLedger });
        };
        let populationScope: string;
        try {
          populationScope = runStore
            ? runStore.withPopulationSnapshot(inspectRows)
            : inspectRows(runStoreUnavailable
              ? { path: goalRunDbPath(), recordCount: null, readFailed: true, missing: false }
              : { path: goalRunDbPath(), recordCount: 0, readFailed: false, missing: true });
        } catch {
          // ⛔ 여기서 rows 를 «지우지 않는다» — 모집단 스냅숏이 실패해도 사람이 볼 되묻기는 그대로 남는다.
          //    (실측 2026-08-28: 지우기를 빼도 시험 14/14 가 그대로 통과한다 — 어떤 시험도 그 지우기를 안 문다.
          //     그리고 지우면 내부 오류가 「되묻기 0건」이라는 «거짓 화면»이 된다.)
          populationScope = inspectRows({ path: goalRunDbPath(), recordCount: null, readFailed: true, missing: false });
        }
        const triage = triageClarifyPending(rows);
        console.log('now answerable:');
        for (const row of triage.nowAnswerable) console.log(row.line);
        console.log('past:');
        for (const row of triage.past) console.log(row.line);
        const noRecordScope = rows.some((row) => row.status.kind === 'no-record') ? ` — ${populationScope}` : '';
        console.log(`summary: ${paths.length} goal documents scanned; ${documentsWithPendingClarifications} with unanswered clarifications — this lists records written in goal documents, not live waits; live waits: questions pending${noRecordScope}`);
      } finally {
        runStore?.close();
      }
    } catch (error) {
      console.error(`❌ goal clarification pending failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

clarifyCmd
  .command('closure <goalFile>')
  .description('시작 골에서 갈라져 나온 후속 골들의 미결 clarification과 종결 상태를 한 번에 조회한다.')
  .option('--dir <path>', '조회할 후속 골 문서 디렉터리', 'docs/goals')
  .action(async (goalFile: string, opts: { dir: string }) => {
    try {
      const { collectGoalClarificationClosure } = await import('./self-implement/goal-author-closure.js');
      const closure = collectGoalClarificationClosure(goalFile, resolveCliDirOption(opts.dir));
      console.log(`start: ${closure.start.path}: ${closure.start.pending} pending (excluded from follow-up closure)`);
      for (const entry of closure.descendants) console.log(`${entry.path}: ${entry.pending} pending`);
      console.log(`total: ${closure.documents} documents (1 start, ${closure.descendants.length} follow-ups), ${closure.pending} pending — ${closure.status}`);
    } catch (error) {
      console.error(`❌ goal clarification closure failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

clarifyCmd
  .command('answer <path> <questionId> [optionIndex]')
  .description('미결 clarification 하나의 0-based 옵션 또는 --other 자유형 답을 문서 내부 answer 줄로 주입한다.')
  .option('--other <answer>', 'includeOther: true인 clarification에 주입할 자유형 답')
  .action(async (path: string, questionId: string, optionIndex: string | undefined, opts: { other?: string }) => {
    try {
      if (optionIndex !== undefined && opts.other !== undefined) throw new Error('specify either an option index or --other, not both');
      if (optionIndex === undefined && opts.other === undefined) throw new Error('provide an option index or --other <answer>');
      if (opts.other !== undefined && !opts.other.trim()) throw new Error('free-form clarification answer must be non-empty');
      const [{ readFileSync, writeFileSync }, { injectGoalDocumentClarificationOption, injectGoalDocumentClarificationOtherAnswer }] = await Promise.all([
        import('node:fs'),
        import('./self-implement/goal-author-clarification.js'),
      ]);
      const document = readFileSync(path, 'utf8');
      const updated = opts.other !== undefined
        ? injectGoalDocumentClarificationOtherAnswer(document, questionId, opts.other)
        : injectGoalDocumentClarificationOption(document, questionId, optionIndex!);
      writeFileSync(path, updated);
      console.log(`answered: ${questionId}`);
    } catch (error) {
      console.error(`❌ goal clarification answer failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// 사람이 낸 커밋/PR에도 self-build와 같은 변경파일 범위 판정을 노출한다. --base/--pr는 커밋된 깨끗한
// 작업 트리에서 변경이 0으로 보이는 문제를 피하고, 실패 시 baseline과 대조해 PR 책임만 종료 코드 1로 만든다.
selfCmd
  .command('gate')
  .description('변경 파일 범위 게이트를 실행한다. 기본=미커밋 변경, --base=커밋된 로컬 변경, --pr=열린 PR 변경. 새 회귀만 exit 1.')
  .option('--changed', '변경 파일 범위 게이트임을 명시한다')
  .option('--base <ref>', '커밋됐지만 PR 없는 변경의 비교 기준(ref...HEAD)')
  .option('--pr <number>', '열린 PR 번호에서 gh pr view files로 변경 파일을 읽는다')
  .action((opts: { changed?: boolean; base?: string; pr?: string }) => {
    if (!opts.changed) { ui.error('self gate requires --changed'); process.exitCode = 2; return; }
    try {
      const { runSelfGateCli } = require('./self-implement/gate-cli.js') as typeof import('./self-implement/gate-cli.js');
      const result = runSelfGateCli(process.cwd(), { base: opts.base, pr: opts.pr });
      console.log(result.lines.join('\n'));
      process.exitCode = result.exitCode;
    } catch (error) {
      ui.error(`self gate failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// 🕰️ 정기 전수 — 게이트는 «변경 파일 범위»라 「아무도 안 건드리는 구석」을 원리상 못 본다.
// ⛔ 관문이 «아니다»(🅣 A2 정책): 빨강이 있어도 exit 0 이고, exit 1 은 «스스로 못 쟀을 때»만이다.
selfCmd
  .command('orphan-sweep')
  .description('⛔ 관문 아님(보고형) — 어떤 변경으로도 안 닿는 «어두운» 시험을 세고, --run 이면 돌려 「수 ⊕ 어제 값」을 낸다. 게이트가 원리상 못 보는 갈래(달력 부패·환경 변화)를 잡는 유일한 자.')
  .option('--run', '어두운 시험을 «실제로» 돌린다(분 단위). 기본=세기만 — red 는 «미측정»으로 표시된다.')
  .option('--timeout <ms>', '파일당 상한. 넘으면 red 가 아니라 timeout 이라는 «다른 값»으로 센다', '90000')
  .action((opts: { run?: boolean; timeout?: string }) => {
    try {
      const { runOrphanSweepCli } = require('./self-implement/orphan-sweep-cli.js') as typeof import('./self-implement/orphan-sweep-cli.js');
      const result = runOrphanSweepCli(process.cwd(), { run: opts.run, timeoutMs: Number(opts.timeout) || undefined });
      console.log(result.lines.join('\n'));
      process.exitCode = result.exitCode;
    } catch (error) {
      ui.error(`self orphan-sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// self implement — 외부(Claude Code/Codex/ACP)가 elanous self-build 를 CLI 로 구동하는 창구.
// runSelfImplement(내부 SelfImplement 툴과 동일 코어)를 감싼다: fork→worktree→헤드리스 goal-loop
// (+클린빌드 앵커)→gate(bun test)→PR(HITL). PR-open 은 --open-pr(명시 승인)일 때만·기본 fail-closed.
selfCmd
  .command('implement <feature...>')
  .description('자율 구현(self-build) — feature 를 격리 worktree 에서 goal-loop + 클린빌드 앵커로 끝까지 구현하고 gate(bun test) 통과까지. --config-dir 의 provider 로 모델 선택(gemma 등). PR-open 은 --open-pr(HITL 명시승인)일 때만. 수분 소요.')
  .option('--base <branch>', 'PR base 브랜치(생략 시 provider 기본)')
  .option('--no-draft', 'non-draft PR (기본 draft)')
  .option('--open-pr', 'gate 통과 후 push + draft PR open (기본: PR 안 열고 worktree 보존·fail-closed). 이 플래그가 HITL 명시 승인.')
  .option('--auto-merge', '★ 내부 리뷰가 clean(실제 리뷰 완료·verdict≠fail)이면 자동 병합(squash). must-fix 있으면 무시(hold·rework). outward-facing(main 병합)이라 명시 opt-in. 미지정=리뷰 후 HITL/draft.')
  .option('--merge-by-host', 'Pod 자식: 병합 직전 merge-ready 로 끝내 호스트가 재게이트한 뒤 병합')
  .option('--child-llm-provider <id>', '구현 자식 LLM provider(--child-llm-model 과 함께 · Pod 의 grok 폴백이 쓴다)')
  .option('--child-llm-model <id>', '구현 자식 LLM model(--child-llm-provider 와 함께)')
  .option('--auto-review', '★ G8 자기판단 — PR 에 auto-review opt-in 라벨 부착(저위험·객관게이트 통과 작업만·fail-safe 거부권). 붙으면 L3 폴러(agent-mission review-watch)가 이후 리뷰를 무인 완결(rework→심판→머지). 외부배포·실주문·설계분기·파괴·보안·리뷰 must-fix 면 플래그 있어도 안 붙음.')
  .option('--max-wait <sec>', '구현(goal-loop) 최대 대기 초')
  .option('--enhance', '★ elanous 내부 프롬프트 인핸싱 ON(원문 verbatim 보존 + 커버리지 체크리스트·anti-drift). 기본 off — CLI 는 외부 창구라 external-verbatim(외부가 프롬프트 엔지니어) 존중. 켜면 elanous-apparatus 로 인핸싱.')
  .option('--ground', 'round-0 goal-loop 전에 codebase-only grounding을 실행해 관련 파일·export 계약을 objective에 추가(기본 off·fail-soft).')
  .option('--observe-only', 'SelfImplement 호출을 기록만 하고 self-build를 시작하지 않는다.')
  .option('--plan', '은퇴한 staged 하니스 옵션 — 호환 파싱만 유지하며 지정하면 명시적으로 거부됨.')
  .option('--no-supervise', '⛔ 런 슈퍼바이저를 «끈다»(대표 2026-08-22: ***기본 ON***) — 켜져 있으면 실행이 끝나면 실패를 «트리아지»해서 다시 걸 수 있으면 스스로 재개한다(끝까지). 정지 사유는 converged|needs-human|max-rounds|no-progress 로 각각 «다른 값». 관측=elanous logs --category self-dev.supervisor')
  .option('--supervise-rounds <n>', '슈퍼바이저 재개 라운드 상한 (기본 3 · 끄려면 --no-supervise)')
  .option('--json', '구조화 출력 {stage, ok, branch, worktree, prUrl?, merged?}')
  .action(async (parts: string[], opts: { base?: string; draft?: boolean; openPr?: boolean; autoMerge?: boolean; autoReview?: boolean; maxWait?: string; json?: boolean; plan?: boolean; enhance?: boolean; ground?: boolean; observeOnly?: boolean }) => {
    const feature = parts.join(' ').trim();
    if (!feature) { ui.error('feature 필요: elanous self implement "<무엇을 구현할지>"'); process.exit(2); }
    // Retired entry points must fail before run identity or log-sink setup creates observable execution state.
    if (opts.plan) { ui.error('self implement --plan is retired and rejected'); process.exit(1); return; }
    // ★ 액션레벨 셋업 substrate(U4b 추출·[[standalone-run-context]]) — harness-space 자기인지 마커 +
    //   K run-identity mint-once + 독립 프로세스 logs.db sink(제1원칙 관측·fail-open)를 한 번에 진입한다.
    //   병렬 self-dev 자식이면 이미 심긴 space/runId 를 존중(재mint 금지).
    const { enterStandaloneHarnessRun } = await import('./harness/standalone-run-context.js');
    await enterStandaloneHarnessRun({ kind: 'self-implement', spaceSeed: feature.slice(0, 48), via: 'cli' });
    // ★ U4b 재라우팅 — 액션은 pre-info·결과 표시·process.exit(I/O)만 하고,
    //   중앙 seam(runSelfImplementCliCommand)이 goal-loop의 옵션 해석과 exit-code를 소유한다.
    if (!opts.json) {
      // ⭐ 사람이 읽는 줄이다 — 원재료를 보면 트리 파생 격리에서 아무것도 안 뜨고 **prod 로 오해**한다.
      const { childInstanceScope: childScopeForDisplay } = await import('./instance/child-scope.js');
      const { configDir } = childScopeForDisplay();
      const mode = opts.autoMerge ? '리뷰 clean 시 자동 병합(--auto-merge)' : opts.openPr ? 'PR open(HITL 승인됨)' : 'PR 미개설(코딩+gate+리뷰만 · --open-pr/--auto-merge 로 개설)';
      ui.info(`[self-implement] "${feature.slice(0, 80)}"${configDir ? ` · config-dir=${configDir}` : ''} · ${mode}`);
    }
    const { runSelfImplementCliCommand } = await import('./self-implement/self-implement-cli.js');
    // ⭐ 입구는 «번역»만 한다 — 루프·판정·관측은 중앙 심(self-implement-cli)이 갖는다.
    const superviseOpts = (opts as { supervise?: boolean; superviseRounds?: string });
    const outcome = await runSelfImplementCliCommand(feature, {
      ...opts,
      ...(superviseOpts.supervise
        ? {
          supervise: {
            ...(superviseOpts.superviseRounds ? { rounds: Math.max(1, Number(superviseOpts.superviseRounds) || 3) } : {}),
            ...((opts as { json?: boolean }).json ? {} : {
              onDecision: (d: import('./self-dev/run-supervisor.js').SupervisorDecision) => {
                ui.info(`[supervisor] ${d.action === 'stop' ? `정지(${d.stopReason})` : '재개'} — ${d.why}`);
              },
            }),
          },
        }
        : {}),
    } as never);
    if (!outcome.ok) {
      // 예외경로 — json/human 모두 exit 1(원 액션 catch 동형).
      if (opts.json) await writeStdoutJson(JSON.stringify({ stage: 'error', ok: false, error: outcome.message }) + '\n');
      else ui.error(`self-implement 실패: ${outcome.message.slice(0, 300)}`);
      process.exit(outcome.exitCode);
    }
    if (outcome.kind === 'observed') {
      const observed = { stage: 'observed', ok: true, observed: true, observeOnlySource: outcome.source };
      if (opts.json) { await writeStdoutJson(`${JSON.stringify(observed)}\n`); process.exit(0); }
      ui.info(`[self-implement] 관측 전용 · source=${outcome.source}`);
      process.stdout.write('', () => process.exit(0)); return;
    }
    const r = outcome.result;
    // ★ json 은 stage 무관 exit 0(오케스트레이터는 stage 를 파싱·exit 코드 아님) — 원 액션 quirk 보존(무회귀).
    if (opts.json) { await writeStdoutJson(`${JSON.stringify(r)}\n`); process.exit(0); }
    const L: string[] = [`[self-implement] ${r.stage}${r.ok ? ' ✅' : ''}`];
    if (r.branch) L.push(`branch: ${r.branch}`);
    if (r.worktreePath) L.push(`worktree: ${r.worktreePath}`);
    if (r.review) L.push(`리뷰: ${r.review.verdict}${r.review.reviewed ? '' : '(fail-soft·미실행)'} · must-fix ${r.review.mustFix.length}·should-fix ${r.review.shouldFix.length}`);
    if (r.stage === 'merged') L.push(`✅✅ 자동 병합 완료 — ${r.prUrl}${r.prNumber ? ` (#${r.prNumber})` : ''} (리뷰 clean·squash)`);
    else if (r.prUrl) L.push(`✅ PR: ${r.prUrl}${r.prNumber ? ` (#${r.prNumber})` : ''}${r.merged === false ? ' (자동병합 실패 — 수동 병합)' : ''}`);
    if (r.stage === 'gate-failed') L.push(`❌ gate 실패 — worktree 보존(검사용). ${r.detail ?? ''}`);
    else if (r.stage === 'review-blocked') L.push(`❌ 리뷰 must-fix 미해소 — worktree 보존. ${r.detail ?? ''}`);
    else if (r.stage === 'merge-conflict') L.push(`⚠️ main 정합 충돌(LLM 미해결) — 자동병합 차단·worktree 보존(수동 정합 필요·HITL 결정). ${r.detail ?? ''}`);
    else if (r.stage === 'aborted') L.push(`❌ 구현 실패 — worktree 보존. ${r.detail ?? ''}`);
    else if (r.stage === 'pr-declined') L.push(`⛔ PR 미개설(fail-closed) — --open-pr/--auto-merge 로 개설. ${r.detail ?? ''}`);
    else if (r.stage === 'timed-out') L.push(`⏱️ 자율 단계 wall-clock 초과 — hang 방지 종결·worktree 보존(6h 좀비 차단·B 근본수리). ${r.detail ?? ''}`);
    // ★ P1 ROOT 1(2026-07-26) — 실패 stage(non-zero) 뿐 아니라 exit 0 경로(pr-declined 등)도 무조건
    //   force-exit. leaked handle(review LLM 소켓·confirm 타이머 등)이 이벤트루프 자연 drain 을 막아
    //   one-shot CLI 가 안 죽는 것 방지(run-detached finish() parity·재현 종료지연 ~105s 근본). ⚠️ stdout
    //   drain 후 exit(write 콜백에서 exit) — 파이프(non-TTY) 출력이 flush 전 잘리지 않게(PR#5439 리뷰 must-fix).
    process.stdout.write(`${L.join('\n')}\n`, () => process.exit(outcome.exitCode));
  });

// self reduce — 플릿 reduce(로드맵 09-26 #4): 여러 조각 PR 브랜치를 통합 브랜치 하나로 · 게이트 한 번 · PR 하나.
selfCmd
  .command('reduce')
  .description('플릿 reduce — 열린 조각 PR 들을 기준 위에 차례로 merge --no-ff → 충돌이면 조각·파일을 대고 멈춤 → 변경 범위 게이트 → 통합 PR 하나(조각 PR 은 닫지 않음)')
  .requiredOption('--prs <numbers>', '합칠 열린 PR 번호(쉼표 · 적은 순서대로 합친다)')
  .option('--base <branch>', '기준 브랜치', 'main')
  .option('--branch <name>', '통합 브랜치 이름(기본 reduce/<시각>)')
  .option('--title <text>', '통합 PR 제목')
  .option('--dry-run', '병합·게이트까지만 — 푸시·PR·코멘트 안 함')
  .option('--skip-gate', '게이트를 건너뛴다(권하지 않음)')
  .action(async (o: { prs: string; base: string; branch?: string; title?: string; dryRun?: boolean; skipGate?: boolean }) => {
    const { reduceShards, shardsFromPrs } = await import('./self-dev/fleet-reduce.js');
    try {
      const prs = o.prs.split(',').map((x) => Number.parseInt(x.trim().replace(/^#/, ''), 10)).filter(Number.isFinite);
      const shards = shardsFromPrs(prs, process.cwd());
      const r = await reduceShards({ repoRoot: process.cwd(), shards, base: o.base, branch: o.branch, title: o.title, dryRun: o.dryRun, skipGate: o.skipGate });
      process.exitCode = r.kind === 'pr-opened' || r.kind === 'dry-run' ? 0 : 1;
    } catch (e) { console.error(`⛔ ${(e as Error).message}`); process.exitCode = 1; }
  });

// self orchestrate — 병렬 self-dev(S1·2026-07-21) — N개 독립 goal 을 각자 `elanous self implement` 서브프로세스로
//   TOX 디스패처 위에서 동시성캡 병렬 실행. 각 잡=자기 프로세스=자기 harness-space(병렬안전). 엔진(그래프/
//   디스패처)은 기존 재사용·새 조각=self-implement surface 어댑터. [[PLAN-parallel-self-dev-orchestrator-2026-07-21]].
let selfOrchestrateSpawnForTesting: import('./task-orchestrator/surfaces/self-implement.js').SelfImplementJobSpawn | undefined;
export function setSelfOrchestrateSpawnForTesting(spawn: typeof selfOrchestrateSpawnForTesting): void {
  selfOrchestrateSpawnForTesting = spawn;
}

const selfOrchestrateCmd = selfCmd
  .command('orchestrate [goals...]')
  .description('병렬 self-dev — 여러 goal 을 각자 격리 worktree self-implement 서브프로세스로 동시성캡 병렬 실행. goal 은 `;;` 로 구분(또는 각 인자 1 goal). --concurrency 로 동시 잡 수(기본 2).')
  .option('--concurrency <n>', '동시 실행 잡 수 (기본 2)')
  .option('--auto-merge', '각 잡: 리뷰 clean 시 자동 병합(각 self-implement 에 --auto-merge 전달·리뷰노드 경유)')
  .option('--auto-review', 'G8 — 각 잡 PR 에 auto-review opt-in 라벨 부착(각 self-implement 에 --auto-review·작업별 eligibility 자기판단·fail-safe). 붙은 PR 은 L3 폴러가 무인 완결.')
  .option('--open-pr', 'S3 — 각 잡: gate/리뷰 통과 시 draft PR 개설(각 self-implement 에 --open-pr·승격이 리뷰노드 경유→disposition 내부 각인)')
  .option('--base <branch>', '각 잡 PR base 브랜치')
  .option('--decompose', 'S2 — goal 1개를 LLM 으로 의존성 서브-DAG(위상 병렬 + hot-file 직렬)로 분해 후 실행')
  .addOption(new Option('--pod-skill-env', 'pod: 필수 스킬(설정 pod-skills.txt)의 키(.env)를 이 런의 Secret 으로 넘긴다 — 명시 opt-in(유료 크레딧) · 이미지엔 안 들어간다').hideHelp())
  .addOption(new Option('--pod-pool <spec>', 'pod 풀 — 컨텍스트[@ssh호스트][:상한] 을 쉼표로, 앞이 우선(예 pool-node-b@node-b:12,pool-node-c@node-c:3) · 없으면 ELANOUS_POD_POOL · 그것도 없으면 현재 컨텍스트 하나').hideHelp())
  .addOption(new Option('--reduce', '끝에 PR 을 연 조각들을 통합 브랜치 하나로 모아(게이트 한 번) PR 하나 — `--open-pr` 과 짝 · `--auto-merge` 와는 함께 못 쓴다(elanous self reduce)').hideHelp())
  .option('--substrate <kind>', '실행 칸: local(기본 · 격리 워크트리) | pod(k8s Job · docker/harness 이미지 · MANUAL-pods-for-elanous-ops-and-dev)')
  .option('--pod-account <name>', 'pod: codex 계정(~/.elanous/auth.json openai-codex:<name> · refresh 제외 사본) · 없으면 브로커가 Job 마다 잔량 많은 계정을 돌려 준다')
  .option('--no-pod-rebuild', 'pod: 이미지 판(elanous.commit)이 HEAD 와 달라도 다시 굽지 않는다 — 측정은 «이미지 판»을 잰다')
  .option('--pod-pass-env <keys>', 'pod: 호스트 env 에서 Pod 로 넘길 키(쉼표) — 예 OPENROUTER_API_KEY,ANTHROPIC_API_KEY(벤치마크 과금 경로)')
  .option('--bench-arms <spec>', 'pod 벤치마크: 골 1개를 팔마다 «라벨 한 줄만 다르게» 복제해 동시에 — "id=provider[:model][@KEY+KEY];…" (예 codex=openai-codex;or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY) · --auto-merge 거부 · RFC fleet 슈퍼바이저 §A3')
  .option('--help-all', '모든 orchestrate 옵션 표시')
  .action(function (this: Command, parts: string[], opts: { concurrency?: string; autoMerge?: boolean; autoReview?: boolean; openPr?: boolean; base?: string; teardown?: boolean; resume?: string; board?: boolean; decompose?: boolean; fabricDecompose?: boolean; maxTasks?: string; supervise?: boolean; superviseRounds?: string; json?: boolean }) {
    return (async () => {
    // goal 분리: 단일 인자에 `;;` 가 있으면 그걸로 split, 아니면 각 positional = 1 goal.
    const joined = parts.join(' ');
    let goalTexts = splitOrchestrateGoalTexts(parts);
    if ((opts as { reduce?: boolean }).reduce && opts.autoMerge) { ui.error('--reduce 는 --auto-merge 와 함께 못 쓴다 — 조각을 하나씩 main 에 병합하는 것과 하나로 모으는 것은 반대다(--open-pr 과 짝)'); process.exit(2); }
    // ☸️ 벤치 팔 — 골 1개를 팔마다 라벨 한 줄만 다르게(A/B 매뉴얼 ②) · pod 전용 · 자동 머지 금지(한 팔이 머지되면 다른 팔의 밑 땅이 바뀐다).
    const benchSpec = (opts as { benchArms?: string }).benchArms;
    let benchArms: import('./task-orchestrator/surfaces/self-implement-pod.js').BenchArm[] | undefined;
    if (benchSpec) {
      const { parseBenchArms, benchGoals } = await import('./task-orchestrator/surfaces/self-implement-pod.js');
      if ((opts as { substrate?: string }).substrate !== 'pod') { ui.error('--bench-arms 는 --substrate pod 와 함께'); process.exit(2); }
      if (opts.autoMerge) { ui.error('--bench-arms 는 --auto-merge 를 거부한다(한 팔의 머지가 다른 팔의 밑 땅을 바꾼다 · A/B 매뉴얼 ①)'); process.exit(2); }
      if (goalTexts.length !== 1) { ui.error(`--bench-arms: 골은 정확히 1개(받은 ${goalTexts.length}개)`); process.exit(2); }
      try { benchArms = parseBenchArms(benchSpec); } catch (e) { ui.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
      goalTexts = benchGoals(goalTexts[0]!, benchArms!);
      debug.log('self-dev.orchestrate', 'bench-arms', { arms: benchArms!.map((a) => ({ id: a.id, provider: a.provider, model: a.model ?? null, passEnv: a.passEnv })) });
    }
    // ⭐ --resume 이면 goal 을 다시 안 줘도 된다 — 체크포인트가 goal 원형을 갖는다(2026-08-19).
    //   ⛔ 그래도 «옛 체크포인트»면 아래에서 goals 가 비어 있을 수 있어, 그 경우를 뒤에서 다시 막는다.
    if (goalTexts.length === 0 && !opts.resume) { ui.error('goal 필요: elanous self orchestrate "<goal1>" "<goal2>" (또는 "g1 ;; g2" · --decompose 로 1 goal 자동분해 · --resume <runId> 면 goal 불요)'); process.exit(2); }
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency) || 2) : undefined;
    let reportRunId = 'unknown';
    const reportRun = async (results: readonly import('./self-dev/orchestrate.js').SelfDevJobResult[], failure?: string): Promise<void> => {
      const data = { runId: reportRunId, chatId: undefined as number | undefined, done: results.filter((r) => r.status === 'done').length, total: results.length };
      try {
        const { readReportOrigin } = await import('./self-implement/report-origin.js');
        const origin = readReportOrigin(process.env);
        if (!origin) { debug.log('self-implement.run-report', 'no-origin', data); return; }
        data.chatId = origin.chatId;
        const { formatRunReport } = await import('./self-implement/run-report.js');
        const { sendOutbound } = await import('./domains/outbound-alert.js');
        if (!sendOutbound(formatRunReport({ runId: reportRunId, results, ...(failure !== undefined ? { failure } : {}) }), 'report', origin)) {
          debug.log('self-implement.run-report', 'report-failed', data);
          return;
        }
        debug.log('self-implement.run-report', 'reported', data);
      } catch (error) {
        try {
          debug.log('self-implement.run-report', 'report-failed', { ...data, error: error instanceof Error ? error.message : String(error) });
        } catch { /* logging failure must not affect the run exit */ }
      }
    };
    try {
      debug.log('self-dev.orchestrate', 'cli', { goals: goalTexts.length, concurrency: concurrency ?? 'default', decompose: !!opts.decompose });
    } catch { /* fail-open */ }
    try {
      // S2 — --decompose: joined 을 1 goal 로 보고 LLM 이 의존성 DAG 로 분해. 아니면 각 텍스트=독립 goal.
      const promoteDefaults = {
        ...(opts.base ? { base: opts.base } : {}),
        ...(opts.autoMerge ? { autoMerge: true } : {}),
        ...(opts.autoReview ? { autoReview: true } : {}),
        ...(opts.openPr ? { openPr: true } : {}),
      };
      let goals;
      let parentRequest: string | undefined;
      const request = normalizeOrchestrateRequest(joined);
      if (opts.decompose) parentRequest = request;
      const { prepareOrchestrateDecomposeGoals } = await import('./self-dev/self-orchestrate-runtime.js');
      const prepared = await prepareOrchestrateDecomposeGoals(buildOrchestrateDecomposePrepareArgs({
        request,
        goals: goalTexts.map((feature) => ({ feature, ...promoteDefaults })),
        decompose: opts.decompose,
        fabricDecompose: opts.fabricDecompose,
        maxTasks: opts.maxTasks,
        base: opts.base,
        autoMerge: opts.autoMerge,
        openPr: opts.openPr,
        autoReview: opts.autoReview,
        json: opts.json,
        onInfo: (message) => ui.info(message),
      }));
      if (!prepared.ok) {
        ui.error(prepared.error);
        process.exit(prepared.exitCode);
      }
      goals = prepared.goals;
      // S3 resume/checkpoint — 새 runId 생성(또는 --resume 이어받기). 매 잡 종결마다 체크포인트
      //   파일에 상태 저장 → 크래시/중단 후 --resume <runId> 로 done goal 스킵하고 미완만 재실행.
      const { loadSelfDevRun, saveSelfDevRun, addSelfDevRunParticipant, checkpointDependenciesForRun } = await import('./self-dev/run-store.js');
      const { restoreOrchestrateCheckpointGoals, countOrchestrateResumeSkips } = await import('./self-dev/self-orchestrate-runtime.js');
      const restored = restoreOrchestrateCheckpointGoals({
        resume: opts.resume,
        goals,
        loadRun: loadSelfDevRun,
        json: opts.json,
        onInfo: (message) => ui.info(message),
      });
      const prior = restored.prior;
      const { withOrchestrateGoalKey } = await import('./self-dev/orchestrate.js');
      goals = restored.goals.map(withOrchestrateGoalKey);
      // ⛔ 「스킵」 수를 status 로 세면 «리뷰에 막혀 아무것도 착지 못 한» 조각까지 스킵이라 말한다.
      //   실제 재개 판정은 classifyResumeDisposition 이 한다 — 화면도 «같은 판정»을 쓴다(재발명 0).
      const { classifyResumeDisposition } = await import('./self-dev/orchestrate.js');
      const resumeCounts = prior ? (() => {
        const skipped = countOrchestrateResumeSkips(prior.results, classifyResumeDisposition);
        return { skipped, rerun: prior.results.length - skipped };
      })() : undefined;
      if (opts.resume && !prior && !opts.json) ui.info(`[self-dev] ⚠️ resume run '${opts.resume}' 없음 — 전체 신규 실행`);
      const { resolveRunIdentity, HARNESS_RUN_ID_ENV } = await import('./harness/harness-space.js');
      // ★ K run-identity(2026-07-25·[[PLAN §K]]) — canonical per-run join anchor. resume is explicit;
      // otherwise inherit the parent run ID or mint a new outer run.
      const { runId, source: runIdSource } = resolveRunIdentity({
        explicit: opts.resume,
        inherited: process.env[HARNESS_RUN_ID_ENV],
      });
      process.env[HARNESS_RUN_ID_ENV] = runId;
      reportRunId = runId;
      const createdAt = prior?.createdAt ?? Date.now();
      const { bindOrchestrateRunLedger } = await import('./self-dev/self-orchestrate-runtime.js');
      const { checkpoint } = bindOrchestrateRunLedger({
        saveRun: saveSelfDevRun,
        addParticipant: addSelfDevRunParticipant,
        checkpointDependencies: checkpointDependenciesForRun,
      }, {
        runId,
        createdAt,
        prior,
        goals,
        pid: process.pid,
        runIdSource,
        now: () => Date.now(),
      });

      // ⛔ 여기까지 와서 goal 이 하나도 없으면 «조용히 0개를 돌리지» 않는다 — 왜 없는지를 말한다.
      if (goals.length === 0) {
        ui.error(`[self-dev] 돌릴 goal 이 없다 — ${opts.resume ? `체크포인트 '${opts.resume}' 에 goal 원형이 없고(옛 판) 인자도 안 줬다. goal 을 인자로 주십시오` : 'goal 을 인자로 주십시오'}`);
        process.exit(2);
      }
      const promoteMode = opts.autoMerge ? ' · auto-merge(리뷰노드)' : opts.openPr ? ' · draft PR(리뷰노드)' : ' · PR 없음(worktree만)';
      // ⭐ 시작 안내가 «추측»을 찍지 않는다 — 엔진이 쓸 값을 여기서 «한 번» 해석해 그대로 넘긴다.
      //   ⛔ 정적 import 를 더하지 않는다 — 그러면 모든 CLI 시작 경로에 self-orchestrate 의존이 붙는다.
      const { runSelfOrchestrateCliCommand, resolveOrchestrateStart } = await import('./self-dev/orchestrate-cli.js');
      // ⭐ 안내와 실행값이 «한 객체»에서 나온다 — 둘이 갈릴 자리를 만들지 않는다.
      const start = resolveOrchestrateStart({
        explicit: concurrency,
        goalCount: goals.length,
        promoteMode,
        ...(opts.teardown ? { teardown: true } : {}),
        runId,
        ...(resumeCounts ? { resume: resumeCounts } : {}),
      });
      if (!opts.json) ui.info(start.announcement);
      // S3 --board — 라이브 칸반: 매 사이클 clear+리드로(재발명0·기존 board 렌더러 재사용).
      const boardRender = opts.board && !opts.json
        ? (await import('./self-dev/board.js')).renderSelfDevBoard
        : null;
      const onSnapshot = boardRender
        ? (tasks: any) => { try { process.stdout.write(`\x1b[2J\x1b[H${boardRender(tasks)}\n`); } catch { /* fail-soft */ } }
        : undefined;
      // ★ U4b 재라우팅 — 실행부(orchestrateSelfDev)를 runDevPipeline parallel dispatch 로 통일(호출부만·재발명 0).
      //   coordinator 해석(decompose·run-identity·checkpoint·board)은 액션에 유지·감독 콜백은 runtime 으로 주입.
      // ☸️ 실행 칸 — pod 면 self-implement 자식을 k8s Job 으로(계약 동일 · 슈퍼바이저 무수정).
      const substrate = (opts as { substrate?: string }).substrate ?? 'local';
      let podSpawn: import('./task-orchestrator/surfaces/self-implement.js').SelfImplementJobSpawn | undefined;
      let podTargets: { context: string; namespace: string }[] | undefined;
      if (substrate === 'pod') {
        const { podSelfImplementSpawn, podSubstrateReady, defaultKubectl } = await import('./task-orchestrator/surfaces/self-implement-pod.js');
        const poolMod = await import('./task-orchestrator/surfaces/pod-pool.js');
        const poolSpec = poolMod.resolvePodPoolSpec((opts as { podPool?: string }).podPool);
        let pool: import('./task-orchestrator/surfaces/pod-pool.js').PodPoolScheduler | undefined;
        let poolMembers: import('./task-orchestrator/surfaces/pod-pool.js').PodPoolMember[] = [];
        let ready: { ok: boolean; reason: string };
        if (poolSpec) {
          let members: import('./task-orchestrator/surfaces/pod-pool.js').PodPoolMember[];
          try { members = poolMod.parsePodPool(poolSpec); } catch (e) { ui.error(String((e as Error).message)); process.exit(2); }
          const checked = poolMod.checkPodPool(members!, (args) => defaultKubectl(args));
          for (const d of checked.dropped) ui.warn(`[pod-pool] ${d.context} 뺌 — ${d.reason}`);
          debug.log('self-implement.pod', 'pool-check', { spec: poolSpec, ready: checked.ready.map((m) => m.context), dropped: checked.dropped });
          if (!checked.ok) { ui.error('--substrate pod: 풀의 노드가 하나도 준비되지 않았다'); process.exit(2); }
          poolMembers = checked.ready;
          pool = new poolMod.PodPoolScheduler(poolMembers);
          ready = { ok: true, reason: `pool ${poolMembers.map((m) => `${m.context}:${m.capacity}`).join(',')}` };
        } else {
          ready = podSubstrateReady();
        }
        if (!ready.ok) { ui.error(`--substrate pod: ${ready.reason}`); process.exit(2); }
        // ⛔ Pod 의 elanous 는 이미지 판이다 — HEAD 와 다르면 다시 굽는다(BACKLOG E6 · 09-25 세 판이 옛 판을 쟀다).
        const { podImageFreshness } = await import('./task-orchestrator/surfaces/self-implement-pod.js');
        // ☸️ 풀이 «원격 노드뿐»이면 이 기계의 이미지는 아무도 안 쓴다 — 로컬 판정·굽기를 건너뛰고 기준 판 = HEAD 로 노드 동기화만 한다.
        //   🩸 2026-09-26 실측: 원격 전용 풀인데 로컬 이미지가 없다고 로컬에서 굽다가 로컬 클러스터(elanous-h1)가 없어 런이 시작도 전에 죽었다.
        const remoteOnlyPool = poolMembers.length > 0 && poolMembers.every((m) => Boolean(m.sshHost));
        const headCommit = remoteOnlyPool ? ((await import('node:child_process')).spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || null) : null;
        let image = remoteOnlyPool
          ? { imageCommit: headCommit, headCommit, fresh: true, reason: 'remote-only pool — 노드 쪽에서 맞춘다' }
          : podImageFreshness();
        if (!image.fresh) {
          if ((opts as { podRebuild?: boolean }).podRebuild === false) {
            ui.warn(`--substrate pod: 이미지가 낡았다(${image.reason}) — --no-pod-rebuild 라 그대로 쓴다. 측정은 «이미지 판»을 잰다.`);
          } else {
            if (!opts.json) ui.info(`[pod] 이미지 다시 굽기 — ${image.reason} (~1분)`);
            const { spawnSync } = await import('node:child_process');
            const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() || process.cwd();
            // bun 1.4 applies the 1 MiB default maxBuffer: a docker build log past it kills the child (ENOBUFS · status null).
            const b = spawnSync('bash', [`${top}/docker/harness/build.sh`], { encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
            if (b.status !== 0) { ui.error(`--substrate pod: 이미지 굽기 실패 rc=${b.status}${b.error ? ` (${(b.error as NodeJS.ErrnoException).code ?? b.error.message})` : ''}: ${(b.stdout + b.stderr).slice(-400)}`); process.exit(2); }
            image = podImageFreshness();
          }
        }
        debug.log('self-implement.pod', 'image-freshness', { ...image });
        // ☸️ 원격 노드도 «같은 판»이어야 한다 — 다르면 보내서 넣는다. 못 맞춘 노드는 풀에서 뺀다.
        if (pool) {
          const synced: typeof poolMembers = [];
          // ⭐ 노드들을 «동시에» — 노드 쪽 빌드(바뀐 층만) 1순위 · 실패하면 통째 전송.
          const { podSkillsDigest, resolvePodSkills } = await import('./task-orchestrator/surfaces/pod-skills.js');
          const syncs = await poolMod.syncPoolImages(poolMembers, 'elanous-harness:local', image.imageCommit, { localSkillsDigest: podSkillsDigest(resolvePodSkills().skills).digest });
          for (const m of poolMembers) {
            const r = syncs.get(m.context)!;
            debug.log('self-implement.pod', 'pool-image-sync', { context: m.context, ...r });
            if (r.ok) synced.push(r.imageRef ? { ...m, imageRef: r.imageRef } : m); else ui.warn(`[pod-pool] ${m.context} 뺌 — 이미지 판을 못 맞췄다: ${r.detail}`);
            if (!opts.json && (r.action === 'shipped' || r.action === 'built')) ui.info(`[pod-pool] ${m.context} 이미지 ${r.action === 'built' ? '노드 쪽 빌드' : '보냄'} ${r.detail} · ${Math.round(r.ms / 1000)}초`);
          }
          if (synced.length === 0) { ui.error('--substrate pod: 이미지를 맞춘 풀 노드가 없다'); process.exit(2); }
          pool = new poolMod.PodPoolScheduler(synced);
          poolMembers = synced;
        }
        const requestedPassEnv = String((opts as { podPassEnv?: string }).podPassEnv ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        const grokKeyNames = ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'];
        // 명시 계정은 사람의 선택 — 공급자 폴백과 계정 브로커를 우회한다.
        const explicitPodAccount = (opts as { podAccount?: string }).podAccount;
        let accountBroker: (() => string) | undefined;
        let rotationAccounts: readonly string[] | undefined;
        let podProvider: 'openai-codex' | 'grok' = 'openai-codex';
        let grokApiKeyOptIn = false;
        if (!explicitPodAccount && !benchArms) {
          const { inspectCodexRotation } = await import('./oauth/codex-account-store.js');
          const { planPodProvider, makePodAccountBroker } = await import('./task-orchestrator/surfaces/pod-account-broker.js');
          const { resolveGrokCredential } = await import('./grok/credential.js');
          const { getUserConfig } = await import('./user-config.js');
          const { defaultGrokModel } = await import('./grok/models.js');
          grokApiKeyOptIn = getUserConfig().harness?.pod?.grokApiKeyOptIn === true;
          const credential = resolveGrokCredential();
          const { resolveCodexQuotaPolicy, codexPolicyAllowsCredits, codexPolicyAllowsFallback } = await import('./oauth/codex-quota-policy.js');
          const quotaPolicy = resolveCodexQuotaPolicy(getUserConfig().llm).policy;
          const plan = planPodProvider({
            codexCandidates: inspectCodexRotation().candidates,
            // Per-account caps (대표 default:97) override the Pod default cap — without them default was dropped at 60%.
            thresholdPercentByAccount: getUserConfig().llm?.codexAccountRotationThresholdPercentByAccount,
            // 대표 한도 정책 한 값(`llm.codexQuotaPolicy`) — 크레딧·폴백을 같이 정한다.
            creditsAllowed: codexPolicyAllowsCredits(quotaPolicy),
            grokSubscription: codexPolicyAllowsFallback(quotaPolicy) && credential?.kind === 'subscription',
            grokApiKey: codexPolicyAllowsFallback(quotaPolicy) && credential?.kind === 'api_key',
            grokApiKeyOptIn,
          });
          if (plan.provider === null) { ui.error(`pod: 쓸 codex 계정이 없다 — ${plan.reasons.join(' · ')} · 계정을 명시하려면 --pod-account <이름>`); process.exit(2); }
          podProvider = plan.provider;
          if (plan.provider === 'openai-codex') {
            accountBroker = makePodAccountBroker({ usable: plan.accounts, excluded: plan.excluded });
            rotationAccounts = plan.accounts;
            debug.log('self-implement.pod', 'account-plan', { usable: plan.accounts, excluded: plan.excluded });
            { const { emitDecision } = await import('./live/detail-switch.js');
              emitDecision({ kind: 'ROUTE', what: `Pod 계정 배분 ${plan.accounts.join(' → ')}`, reason: plan.excluded.length ? `뺌 ${plan.excluded.map((x) => `${x.name}(${x.why})`).join(', ')}` : '모든 계정 여유', purpose: plan.creditAccounts ? '구독 잔량 0 — 정책상 크레딧으로 병렬 조각을 돌린다' : '병렬 조각이 한 계정에 몰리지 않게 잔량 순으로 돌려 준다', phase: 'dispatch', target: `Pod ${plan.accounts.length}계정`, paths: plan.accounts.length + plan.excluded.length }); }
            if (!opts.json) ui.info(`[pod] 계정 배분(잔량 순 · 돌려 가며): ${plan.accounts.join(' → ')}${plan.creditAccounts ? ' · 💳 크레딧(구독 잔량 0 · 허가됨)' : ''}${plan.excluded.length ? ` · 뺌 ${plan.excluded.map((x) => `${x.name}(${x.why})`).join(', ')}` : ''}`);
          } else {
            const model = defaultGrokModel().id;
            debug.log('self-implement.pod', 'provider-fallback', { from: 'openai-codex', to: 'grok', excluded: plan.excluded, model });
            { const { emitDecision } = await import('./live/detail-switch.js');
              emitDecision({ kind: 'ROUTE', what: `Pod 공급자 codex → grok(${model})`, reason: `쓸 codex 계정 없음 · ${plan.excluded.map((x) => `${x.name}: ${x.why}`).join(' · ')}`, purpose: '작업을 멈추지 않고 이어 간다', phase: 'dispatch', target: `grok/${model}`, paths: plan.excluded.length + 1 }); }
            if (!opts.json) ui.info(`[pod] 쓸 codex 계정 없음(${plan.excluded.map((x) => `${x.name}: ${x.why}`).join(' · ')}) → grok 으로(모델 ${model})`);
          }
        }
        const passEnv = podProvider === 'grok' ? requestedPassEnv.filter((key) => !grokKeyNames.includes(key)) : requestedPassEnv;
        const podSourceSpec = (opts as { podSource?: string }).podSource;
        let podSource: import('./task-orchestrator/surfaces/pod-source-receive.js').PodSource | undefined;
        if (podSourceSpec) {
          const { parsePodSourceSpec, resolvePodSource } = await import('./task-orchestrator/surfaces/pod-source-spec.js');
          const { elanousStateRoot } = await import('./autopilot/state-paths.js');
          const { join } = await import('node:path');
          let parsed: ReturnType<typeof parsePodSourceSpec>;
          try { parsed = parsePodSourceSpec(podSourceSpec); }
          catch (e) { ui.error(`--pod-source: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
          const outDir = join(elanousStateRoot(), 'pod-sources', runId);
          const baseRef = opts.base ?? 'origin/HEAD';
          try { podSource = resolvePodSource(parsed, { base: baseRef, outDir }); }
          catch (e) { ui.error(`--pod-source: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
          debug.log('self-implement.pod', 'source', {
            kind: podSource.kind,
            ...(podSource.kind === 'bundle' ? { headCommit: podSource.headCommit, sizeBytes: podSource.sizeBytes } : {}),
          });
        }
        const podBase = { hostSupervised: opts.supervise === true, ...(remoteOnlyPool ? { imageCommit: image.imageCommit } : {}), account: podProvider === 'grok' ? 'grok' : explicitPodAccount ?? 'team', ...(accountBroker ? { accountBroker, rotationAccounts } : {}), ...(podProvider === 'grok' ? { provider: 'grok' as const, grokApiKeyOptIn } : {}), passEnv, ...(pool ? { pool } : {}), ...((opts as { podSkillEnv?: boolean }).podSkillEnv ? { skillEnv: true } : {}), ...(podSource ? { source: podSource } : {}) };
        if (benchArms) {
          const { benchPodSpawn } = await import('./task-orchestrator/surfaces/self-implement-pod.js');
          podSpawn = benchPodSpawn(benchArms, podBase);
        } else {
          podSpawn = podSelfImplementSpawn(podBase);
        }
        podTargets = poolMembers.length > 0
          ? poolMembers.map(({ context }) => ({ context, namespace: 'elanous-test' }))
          : [{ context: defaultKubectl(['config', 'current-context']).stdout.trim(), namespace: 'elanous-test' }];
        // ⭐ 팔 선언은 «runId 가 붙는» 이 줄에 싣는다 — 위의 `bench-arms` 줄은 runId 해석 «전»이라 비어 있다(09-25 실측) · 보고서(scripts/bench-report.ts)가 이 줄로 잇는다.
        debug.log('self-dev.orchestrate', 'substrate', { substrate, account: podProvider === 'grok' ? 'grok' : (opts as { podAccount?: string }).podAccount ?? 'team', passEnv, context: ready.reason, imageCommit: image.imageCommit, imageFresh: image.fresh, ...(benchArms ? { benchArms: benchArms.map((a) => ({ id: a.id, provider: a.provider, model: a.model ?? null, modelSource: a.modelSource ?? null, passEnv: a.passEnv })) } : {}) });
      } else if (substrate !== 'local') {
        ui.error(`--substrate: local | pod (받은 값: ${substrate})`); process.exit(2);
      }
      const runtime: import('./self-dev/dev-pipeline.js').OrchestrateRuntime = {
        runId,
        ...(podTargets ? { podTargets } : {}),
        ...(selfOrchestrateSpawnForTesting ? { spawn: selfOrchestrateSpawnForTesting } : podSpawn ? { spawn: podSpawn } : {}),
        ...(opts.teardown ? { teardown: true } : {}),
        ...(prior ? { resumeFrom: prior.results } : {}),
        ...(onSnapshot ? { onSnapshot } : {}),
        checkpoint,
        ...(opts.json ? {} : { onEvent: (ev) => { if (ev.kind === 'task-started') ui.info(`  ▶ 시작 ${ev.taskId}`); } }),
      };
      // ⭐ 입구는 «번역»만 한다 — supervise 스위치를 값으로 넘기고, 루프·판정·관측은 중앙 심이 갖는다.
      //   ⛔ 초판은 이 루프를 여기(CLI 액션)에 두었고 그러면 CLI «한 입구»만 능력을 가졌다.
      //     대표 2026-08-06: "능력은 「갈래」가 아니라 「스위치」다 · 슈퍼바이저가 그 스위치를 소유한다"
      let deliverable: { document: string; attribution: 'all'; goalPath?: string } | undefined = parentRequest === undefined
        ? undefined
        : { document: parentRequest, attribution: 'all' };
      if (deliverable) {
        const { parseArtifactLaunchDeclaration, writeAuthoredGoal } = await import('./self-implement/goal-author.js');
        if (parseArtifactLaunchDeclaration(deliverable.document)?.port !== undefined) {
          const authored = await writeAuthoredGoal(deliverable.document, process.cwd(), { goalTitle: 'SelfOrchestrate deliverable' });
          deliverable = { ...deliverable, goalPath: authored.path };
        }
      }
      const outcome = await runSelfOrchestrateCliCommand({
        goals,
        ...(start.concurrency !== undefined ? { concurrency: start.concurrency } : {}),
        ...(parentRequest === undefined ? {} : { parentRequest }),
        ...(deliverable === undefined ? {} : { deliverable }),
        runtime,
        ...(opts.supervise
          ? {
            supervise: {
              ...(opts.superviseRounds ? { rounds: Math.max(1, Number(opts.superviseRounds) || 3) } : {}),
              ...(opts.json
                ? {}
                : {
                  onDecision: (d: import("./self-dev/run-supervisor.js").SupervisorDecision) => {
                    ui.info(`[supervisor] ${d.action === "stop" ? `정지(${d.stopReason})` : "재개"} — ${d.why}`);
                  },
                }),
            },
          }
          : {}),
      });

      if (!outcome.ok) {
        if (opts.json) await writeStdoutJson(JSON.stringify({ error: outcome.message }) + '\n');
        else ui.error(`self-dev orchestrate 실패: ${outcome.message.slice(0, 300)}`);
        await reportRun([], outcome.message);
        process.exit(outcome.exitCode);
      }
      const results = outcome.results;
      // 플릿 reduce(로드맵 09-26 #4) — PR 을 연 조각이 둘 이상이면 통합 브랜치 하나로.
      if ((opts as { reduce?: boolean }).reduce) {
        const { reduceShards, shardsFromResults } = await import('./self-dev/fleet-reduce.js');
        const shards = shardsFromResults(results);
        if (shards.length < 2) ui.warn(`[reduce] PR 을 연 조각이 ${shards.length}개 — 합칠 것이 없다(둘 이상일 때만)`);
        else {
          const r = await reduceShards({ repoRoot: process.cwd(), shards, ...(opts.base ? { base: opts.base } : {}) });
          debug.log('self-dev.reduce', 'orchestrate-reduce', { runId, shards: shards.length, kind: r.kind });
        }
      }
      if (opts.json) { await writeStdoutJson(JSON.stringify(results) + '\n'); await reportRun(results); return; }
      const done = results.filter((r) => r.status === 'done').length;
      const promoted = results.filter((r) => r.prUrl).length;
      const incomplete = results.length - done;
      console.log([
        `[self-dev] 완료 — ${done}/${results.length} done${promoted ? ` · ${promoted} PR 승격` : ''}${incomplete ? ` · 이어서: elanous self orchestrate <goals> --resume ${runId}` : ''}`,
        ...results.map((r) => {
          const icon = r.status === 'done' ? '✅' : r.status === 'cancelled' ? '⛔' : '❌';
          const disp = r.merged ? ` → merged ${r.prUrl}` : r.prUrl ? ` → PR ${r.prUrl}` : r.stage ? ` [${r.stage}]` : '';
          return `  ${icon} ${r.status} · ${r.feature.slice(0, 56)}${disp}${r.error ? ` — ${r.error.code}${r.error.code === 'pod-job-failed' ? `: ${r.error.message}` : ''}` : ''}`;
        }),
      ].join('\n'));
      await reportRun(results);
      if (outcome.exitCode !== 0) process.exit(outcome.exitCode); // seam 이 done<total→1 매핑(원 규약 보존)
    } catch (e: any) {
      if (opts.json) await writeStdoutJson(JSON.stringify({ error: String(e?.message ?? e) }) + '\n');
      else ui.error(`self-dev orchestrate 실패: ${String(e?.message ?? e).slice(0, 300)}`);
      await reportRun([], String(e?.message ?? e));
      process.exit(1);
    }
    })();
  });

selfOrchestrateCmd.on('option:help-all', () => {
  printExtendedOrchestrateHelp(selfOrchestrateCmd);
  process.exit(0);
});

selfOrchestrateCmd
  .addOption(new Option('--teardown', 'S3 — 실행 후 worktree 정리(PR 개설된 잡은 항상 보존·기본 off=산출물 검토 위해 보존)').hideHelp())
  .addOption(new Option('--resume <runId>', 'S3 — 이전 run(runId) 이어서 — done 된 goal 은 건너뛰고 미완만 재실행(체크포인트 자동)').hideHelp())
  .addOption(new Option('--board', 'S3 — 라이브 칸반 보드(잡 상태 실시간 렌더·매 사이클 리드로)').hideHelp())
  .addOption(new Option('--max-tasks <n>', '--decompose 시 최대 서브-goal 수 (기본 6)').hideHelp())
  .addOption(new Option('--fabric-decompose', '--decompose 와 «함께» — 기본 분해기 대신 Fabric grounding/RFC 어댑터로 분해한다(ACP 툴 인자 `fabric_decompose` 와 동형)').hideHelp())
  .addOption(new Option('--no-supervise', '⛔ 런 슈퍼바이저를 «끈다»(대표 2026-08-22 ***기본 ON***) — 켜져 있으면 런이 끝나면 실패를 «트리아지»해서 다시 걸 것이 있으면 «스스로» 재개한다(골루프처럼 끝까지). 정지 사유는 converged|needs-human|max-rounds|no-progress 로 각각 «다른 값»으로 말한다. 관측=elanous logs --category self-dev.supervisor').hideHelp())
  .addOption(new Option('--supervise-rounds <n>', '슈퍼바이저 재개 라운드 상한 (기본 3 · 끄려면 --no-supervise)').hideHelp())
  .addOption(new Option('--json', '구조화 출력 [{taskId, feature, status, stage?, prUrl?, merged?, error?}]').hideHelp())
  .addOption(new Option('--pod-source <spec>', 'pod: 원천 — commit:<40자 sha> | pr:<정수> | worktree:<경로> | files:<경로>[,<경로>…] · 없으면 기본 clone').hideHelp());

function formatRelativeAge(updatedAt: number, now = Date.now()): string {
  const seconds = Math.floor(Math.max(0, now - updatedAt) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// self parked — G4(1b·2026-07-21) — 무인 self-dev 루프에서 실패(gate-failed/review-blocked/merge-conflict/
//   cancelled)한 goal 을 per-failure 로 부르지 않고 **parked 백로그**로 모아 배치 결정(재정의/포기/직접)을 받는다.
//   run-store 스캔·각 feature 최신 run 이 done 아니면 parked. 재실행은 `elanous self orchestrate <goal> --resume <runId>`.
//   [[ROADMAP-elanous-is-all-pty-unified-autonomy-2026-07-21]] G4.
selfCmd
  .command('parked')
  .description('G4 — 무인 self-dev 루프에서 막힌(실패/취소) goal 백로그(배치 결정용). --resolve <runId> --reason <이유>로 처리 표시. --json 구조화.')
  // ⛔⭐ 봉투«와» 원소 모양을 «둘 다» 적는다 — 2026-08-26 회귀: `--json` 이 배열에서
  //   봉투형으로 바뀌면서 도움말이 ***원소 모양을 아예 안 말하게*** 됐다. 그러면 도구를 쓰는
  //   사람이 parked[] 안에 무엇이 있는지(특히 어느 «모집단»에서 왔는지) 알 길이 없다.
  //   📌 `source` 가 그 축이다 — self-dev-run 이냐 self-implement-ledger 냐가
  //      「무엇이 안 보이나」를 가르는 값이고, 오늘 수리 신호 축이 갈린 자리도 그것이다.
  .option('--json', '구조화 출력 {parked, counts, displayLimit, omittedCount, population, stores, limitation} · parked 원소 = [{feature, status, stage?, error?, runId, branch?, updatedAt, source}]')
  .option('--limit <count>', '표시할 parked 항목 최대 건수', (value) => {
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`parked limit must be a positive safe integer: ${value}`);
    return limit;
  })
  .option('--resolve <runId>', '특정 parked run을 사람이 처리 완료로 표시')
  .option('--reason <reason>', '처리 완료 표시의 짧은 이유')
  .action(async (opts: { json?: boolean; limit?: number; resolve?: string; reason?: string }) => {
    const { listCombinedParkedGoals, countRunningGoals, countUnconvergeableRunLedgers, parkedGoalsListingScopeNotice, parkedGoalsPopulationNotice, resolveParkedSelfDevRun } = await import('./self-dev/run-store.js');
    if (opts.resolve || opts.reason) {
      if (!opts.resolve || !opts.reason) throw new Error('self parked resolution requires both --resolve <runId> and --reason <reason>');
      const parkedResolution = resolveParkedSelfDevRun(opts.resolve, opts.reason);
      if (opts.json) await writeStdoutJson(JSON.stringify({ runId: opts.resolve, parkedResolution }) + '\n');
      else ui.info(`[self-dev] parked run 처리 완료 표시: ${opts.resolve} — ${opts.reason}`);
      return;
    }
    const { recordHitlEvent } = await import('./self-dev/hitl-log.js');
    const listing = listCombinedParkedGoals({ limit: opts.limit });
    const { parked } = listing;
    const running = countRunningGoals();   // ★ C — 라이브 잡(막힌 게 아님)은 별도 정황으로
    if (opts.json) { await writeStdoutJson(JSON.stringify(listing) + '\n'); return; }
    const ledgerSummary = countUnconvergeableRunLedgers();
    if (parked.length === 0) {
      ui.info(`[self-dev] parked goal 없음 — 막힌 자율 작업 없음.${running > 0 ? ` (실행중 ${running}건 — 라이브·막힌 것 아님)` : ''}`);
      ui.info(parkedGoalsListingScopeNotice(listing));
      ui.info(parkedGoalsPopulationNotice(ledgerSummary));
      return;
    }
    console.log([
      `[self-dev] parked ${listing.counts.total}건 (self-dev ${listing.counts.selfDevRun}건 · self-implement 원장 ${listing.counts.selfImplementLedger}건 · 배치 결정 대기 · 재실행=orchestrate <goal> --resume <runId>)${running > 0 ? ` · 실행중 ${running}건(라이브·막힌 것 아님)` : ''}`,
      ...(listing.omittedCount > 0 ? [`[self-dev] 표시 제한 ${listing.displayLimit}건으로 ${listing.omittedCount}건 생략`] : []),
      parkedGoalsListingScopeNotice(listing),
      parkedGoalsPopulationNotice(ledgerSummary),
      ...parked.flatMap((g) => {
        const age = typeof g.updatedAt === 'number' && Number.isFinite(g.updatedAt)
          ? ` · ${formatRelativeAge(g.updatedAt)}`
          : '';
        const head = `  ⚠️ [${g.source}] ${g.status}${g.stage ? `/${g.stage}` : ''} · ${g.feature.slice(0, 60)}${g.error ? ` — ${g.error.code}` : ''}  [run ${g.runId}]${age}`;
        const lines = [head];
        // ⭐ 관측(2026-07-21) — 재현 없이 진단: 자식 goal-loop 화면 종결상태 + false-failure 조정 경고
        //   + 전체 전사 재생 포인터("docker logs" 등가). exit-code 만 보던 맹점 제거.
        if (g.reconcileMismatch) lines.push(`     ⚑ false-failure 의심 — 화면 outcome=GOAL-COMPLETE 인데 exit=failed (스폰 신호 단절)`);
        else if (g.screenOutcome) lines.push(`     goal-loop 화면 outcome: ${g.screenOutcome}`);
        if (g.screenSpace) lines.push(`     전사 재생: elanous self screen --space ${g.screenSpace}`);
        if (g.goalFile) lines.push(`     골 문서: ${basename(g.goalFile)}`);
        return lines;
      }),
    ].join('\n'));
    // G7 HITL 계측(회고) — parked 리뷰가 올라온 사실을 남긴다.
    recordHitlEvent({ kind: 'decision-surfaced', action: 'parked-review', detail: { count: listing.counts.total } });
  });

// self repair-signals — G7(1d·2026-07-21) — parked 실패를 패턴으로 클러스터해 harness 시스템 이슈(수리 후보)
//   vs 단일 goal 이슈를 구분 surface. 1d 는 raw 실패가 아니라 "무엇을 수리할지" 결정 신호를 본다.
//   [[ROADMAP-elanous-is-all-pty-unified-autonomy-2026-07-21]] G7.
selfCmd
  .command('repair-signals')
  .description('G7 — parked 실패를 패턴 클러스터로 분석(system 수리 후보 vs 단일 goal 이슈). 관측→시스템 수리.')
  .option('--json', '구조화 출력 [{pattern, count, runCount, kind, hypothesis, affectedFeatures}]')
  .option('--json-envelope', '구조화 출력 {signals, scanned, windowExcluded}; --json 단독의 raw 배열 계약은 보존')
  .option(...LOGS_SINCE_OPTION)
  .action(async (opts: { json?: boolean; jsonEnvelope?: boolean; since?: string }) => {
    // ★ HITL 관측이 logs.db 에 닿게 sink 등록(#4945 교훈 — standalone 프로세스는 데몬 StoreSink 미상속).
    const { listCombinedParkedGoals } = await import('./self-dev/run-store.js');
    const { parseSince } = await import('./cli/logs-cli.js');
    const { analyzeRepairSignals } = await import('./self-dev/repair-signals.js');
    const { recordHitlEvent, recordHitlToMemory } = await import('./self-dev/hitl-log.js');
    const listing = listCombinedParkedGoals();
    const sinceMs = opts.since === undefined ? undefined : parseSince(opts.since);
    if (sinceMs === null) throw new Error(`--since 파싱 불가: '${opts.since}' (30s/15m/2h/7d 또는 ISO)`);
    const parked = sinceMs === undefined ? listing.parked : listing.parked.filter((goal) => goal.updatedAt >= sinceMs);
    const windowExcluded = listing.parked.length - parked.length;
    const signals = analyzeRepairSignals(parked);
    const scanned = {
      total: parked.length,
      selfDevRun: parked.filter((goal) => goal.source === 'self-dev-run').length,
      selfImplementLedger: parked.filter((goal) => goal.source === 'self-implement-ledger').length,
    };
    if (opts.jsonEnvelope) { await writeStdoutJson(JSON.stringify({ signals, scanned, windowExcluded }) + '\n'); return; }
    if (opts.json) { await writeStdoutJson(JSON.stringify(signals) + '\n'); return; }
    const denominator = `훑은 ${scanned.total}건 (self-dev ${scanned.selfDevRun}건 · self-implement 원장 ${scanned.selfImplementLedger}건${sinceMs === undefined ? '' : ` · 창 밖 제외 ${windowExcluded}건`})`;
    if (signals.length === 0) {
      ui.info(`[self-dev] 수리 신호 없음 — ${denominator}.`);
      return;
    }
    const sys = signals.filter((s) => s.kind === 'system');
    console.log([
      `[self-dev] 수리 신호 ${signals.length}건${sys.length ? ` · ⚙️ 시스템 수리 후보 ${sys.length}건` : ''} · ${denominator}`,
      ...signals.map((s) => `  ${s.kind === 'system' ? '⚙️ SYSTEM' : '·  goal'} [${s.pattern}×${s.count} items/${s.runCount} runs] ${s.hypothesis}`),
    ].join('\n'));
    // G7 HITL 계측 — 회고(logs.db) + 패턴 학습(기억). system 수리 후보는 significant → 기억 주입.
    for (const s of signals) recordHitlEvent({ kind: 'decision-surfaced', action: 'repair-signals', pattern: `${s.pattern}×${s.count}`, detail: { kind: s.kind, runCount: s.runCount } });
    if (sys.length) {
      await recordHitlToMemory(
        `self-dev 시스템 수리 후보 ${sys.length}건 — ${sys.map((s) => `${s.pattern}×${s.count} items/${s.runCount} runs(${s.hypothesis.slice(0, 40)})`).join(' · ')}`,
        { patterns: sys.map((s) => s.pattern), category: 'self-dev-repair-signal' },
      );
    }
  });

// self typecheck — B2(2026-07-21) — self-build goal-loop 이 완료 前 **자기 변경 파일의 타입에러만** 확인하는
//   clean 신호. 구조 근본: goal-loop 은 bun test(타입-블라인드)·Lsp(diagnostics 없음)·tsc(baseline 80 노이즈)로
//   자기 타입에러를 못 본다 → 미완성 코드(F1 refFacts 소비만·미정의)를 거짓 green 으로 넘김. 이 명령이 gate 와
//   **동일 로직**(changedFileTypecheck·gitChangedFiles)으로 변경 파일 에러만 걸러 보여줘 선제 수렴을 돕는다.
selfCmd
  .command('typecheck')
  .description('변경 파일(git diff HEAD + untracked)의 타입에러만 검사 — repo baseline 은 숨김. self-build goal-loop 이 완료 前 자기 타입 확인용(gate 와 동일 로직).')
  .action(async () => {
    const { changedFileTypecheck, gitChangedFiles } = await import('./self-implement/seams.js');
    const cwd = process.cwd();
    const changed = gitChangedFiles(cwd);
    const r = changedFileTypecheck(cwd, changed);
    // ⛔⭐⭐⭐ 「0개 검사」를 «통과»라 말하지 않는다 — 그건 «안 쟀다»이지 «괜찮다»가 아니다.
    //   근거(2026-08-04 `[S]` 실측 · `MEAS-S42`): 이 자는 gitChangedFiles = `git diff HEAD` ⊕ untracked 라
    //   **커밋 «뒤»에 돌리면 볼 것이 없다.** 그때도 종전 문면은 `✅ … 통과 (0개 파일 검사)` 였고,
    //   그것을 착지 판정으로 읽으면 ***한 번도 안 잰 변경을 「통과」로 착각한다***(실제로 두 번 속을 뻔했다).
    //   ⇒ `harness clean` 이 `#6984` 에서 닫은 「0건과 «안 봤다»를 가른다」와 **같은 병**이다.
    //   ⚠️ 종료 코드는 «그대로 0» 이다 — 이 명령을 부르는 자동 경로가 「변경 없음」에서 깨지면 안 된다.
    //      바꾸는 것은 «사람이 읽는 문면»이고, 그것이 이 결함의 실제 표면이다.
    if (r.passed && r.checked === 0) {
      ui.info('⚠️ 변경 파일 타입 검사 — «안 쟀다» (검사 대상 0개)');
      ui.info('   이 자는 커밋되지 «않은» 변경만 본다(git diff HEAD ⊕ untracked). 커밋 뒤엔 볼 것이 없다.');
      ui.info('   ⇒ 커밋한 변경을 재려면: TSC_BASE_REF=<base> bun run scripts/ci-typecheck-changed.ts');
      process.exit(0);
    }
    // ⛔⭐⭐ 스코프를 «0개일 때만» 말하면 안 된다 — `[S]` 가 실제로 속은 경로는 «0개가 아니었다»(`MEAS-S42`).
    //   미커밋 «1» ⊕ 커밋 «4» 인 상태에서 `✅ … (1개 파일 검사 통과)` 가 나왔고, 잰 것처럼 읽혀
    //   ***커밋된 넷을 한 번도 안 잰 채 올릴 뻔했다.*** ⇒ 「몇 개를 봤나」와 「무엇을 보는 자인가」를 항상 같이 낸다.
    if (r.passed) { ui.info(`✅ 변경 파일 타입 검사 통과 (${r.checked}개 파일 검사·baseline 무시·스코프: git diff HEAD ⊕ untracked — 커밋된 변경은 «안 본다»)`); process.exit(0); }
    ui.error(`❌ 변경 파일 타입 에러 ${r.errors}건 — 통과까지 고쳐라(참조 심볼/필드는 정의·선언 완성):\n${r.log}`);
    process.exit(1);
  });

// self send — 같은 state-dir를 공유하는 하니스/TUI에 loop-boundary soft control을 전달한다.
selfCmd
  .command('send [space]')
  .description('실행 중인 하니스/TUI 공간에 soft control을 보낸다. space 생략 시 후보가 정확히 하나일 때만 대상으로 하며, 모호하면 최근 후보와 마지막 프레임 시각을 보여주고 실패한다. --include-stale은 오래된 후보도 함께 표시한다. --stop은 현재 iteration 뒤 종료하도록 inbox에 기록하고, --memo는 다음 iteration에 읽을 감독 메모를 기록한다.')
  .option('--stop', '현재 iteration 완료 뒤 soft stop')
  .option('--memo <sentence>', '다음 iteration에 읽을 한 줄 감독 메모')
  .option('--run <runId>', 'runId에서 headless.spawn 로그의 현재 화면 키를 해석')
  .option('--include-stale', '모호한 대상 목록에 오래된 마지막 프레임 후보도 표시')
  .option('--read-wait <seconds>', '--memo·--stop 뒤 자식이 읽을 때까지 기다리는 최대 초(0 = 기다리지 않음)', '10')
  .action(async (space: string | undefined, opts: { stop?: boolean; memo?: string; run?: string; includeStale?: boolean; readWait?: string }) => {
    const { classifyRunScreenMissing, queryRunScreenKey, listRunLedgers } = await import('./self-implement/run-ledger.js');
    const { getPtyManifest, listPtyManifestRows } = await import('./pty-shell/pty-manifest.js');
    const { readPodFragment, podFragmentFinished, listPodFragmentsForRun, dispatchPodSelfSend } = await import('./harness/self-send-target.js');
    const { listHarnessScreens, readHarnessHeartbeat } = await import('./harness/harness-screen.js');
    const decision = decideSelfSend({ space, opts, now: Date.now() }, {
      resolveRunScreen: (runId) => {
        const resolved = queryRunScreenKey(runId);
        return { ...resolved, missingStatus: resolved.screenKey ? undefined : classifyRunScreenMissing(resolved.lastEvent) };
      },
      resolveTarget: (target) => resolveSelfSendTarget(target, { getPtyManifest, listPtyManifestRows }),
      podFragmentsForRun: (runId) => listPodFragmentsForRun(runId),
      isPodFragment: (spaceId) => Boolean(readPodFragment(spaceId) || podFragmentFinished(spaceId)),
      screens: () => listHarnessScreens().map((screen): SelfSendCandidate => {
        const heartbeat = readHarnessHeartbeat(screen.spaceId);
        let liveness: SelfSendCandidate['liveness'] = 'unknown';
        let heartbeatAtMs: number | undefined;
        if (heartbeat !== null) {
          try {
            const parsed: unknown = JSON.parse(heartbeat);
            if (typeof parsed === 'object' && parsed !== null && 'alive' in parsed) {
              const heartbeatState = parsed as { alive?: unknown; at?: unknown };
              liveness = heartbeatState.alive === true ? 'alive' : heartbeatState.alive === false ? 'dead' : 'unknown';
              if (heartbeatState.alive === true && typeof heartbeatState.at === 'number' && Number.isFinite(heartbeatState.at)) heartbeatAtMs = heartbeatState.at;
            }
          } catch { /* malformed heartbeat is unknown */ }
        }
        return { ...screen, liveness, heartbeatAtMs };
      }),
      ledgers: () => listRunLedgers().matches,
      runScreenKey: (runId) => queryRunScreenKey(runId).screenKey,
    });
    if (decision.kind === 'refuse') {
      process.stderr.write(decision.message);
      process.exit(decision.exitCode);
    }
    const target = decision.spaceId;
    const hasMemo = opts.memo !== undefined;
    if (decision.channel === 'pod') {
      const record = readPodFragment(target);
      try {
        if (hasMemo) {
          if (!opts.memo || /[\r\n]/.test(opts.memo)) throw new Error('control inbox memo must be a non-empty single line');
          const urgent = opts.memo.startsWith('[urgent] ');
          dispatchPodSelfSend(target, { memo: { version: 1, kind: 'supervisor', urgency: urgent ? 'urgent' : 'normal', body: urgent ? opts.memo.slice('[urgent] '.length) : opts.memo } });
        } else dispatchPodSelfSend(target, { stop: true });
        ui.info(`Pod 조각에 ${hasMemo ? '감독 메모' : 'soft stop'} 기록: ${target} (${record?.job ?? 'finished'})`);
        return;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    }
    for (const warning of decision.warnings) process.stderr.write(warning);
    const { controlInboxPath, enqueueControlMemo, enqueueSoftStop } = await import('./harness/control-inbox.js');
    const explicitInboxDir = controlInboxPath(target);
    if (hasMemo) {
      let memoRecordPath = '';
      try {
        if (opts.memo!.length === 0 || /[\r\n]/.test(opts.memo!)) {
          throw new Error('control inbox memo must be a non-empty single line');
        }
        const urgent = opts.memo!.startsWith('[urgent] ');
        memoRecordPath = enqueueControlMemo(target, {
          version: 1,
          kind: 'supervisor',
          urgency: urgent ? 'urgent' : 'normal',
          body: urgent ? opts.memo!.slice('[urgent] '.length) : opts.memo!,
        }, { explicitInboxDir });
      } catch (error) {
        process.stderr.write(`감독 메모를 기록할 수 없습니다: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(2);
      }
      ui.info(`감독 메모 기록: ${memoRecordPath}`);
      // ⭐ 「기록했다」와 「읽혔다」는 다른 값이다 — 자식은 기록을 집어(rename) 지운다. 그래서 읽힌 뒤의
      //   `.inbox.ready` 는 «빈 디렉토리»다(2026-09-24: 그 빈 디렉토리를 «안 닿았다»로 오판한 사례).
      const readWaitSeconds = Number(opts.readWait ?? '10');
      const readWaitMs = Number.isFinite(readWaitSeconds) && readWaitSeconds > 0 ? readWaitSeconds * 1000 : 0;
      const verifyHint = 'bun bin/elanous.mjs logs --all --include-test --category control-inbox --event drain --json --json-data';
      const startedAt = Date.now();
      while (readWaitMs > 0 && existsSync(memoRecordPath) && Date.now() - startedAt < readWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (readWaitMs > 0 && !existsSync(memoRecordPath)) {
        ui.info(`자식이 읽음 (${((Date.now() - startedAt) / 1000).toFixed(1)}초)`);
      } else {
        ui.info(`아직 안 읽힘${readWaitMs > 0 ? ` (${readWaitSeconds}초 기다림)` : ''} — 확인: ${verifyHint}`);
      }
      ui.info('참고: 읽힌 뒤의 `.inbox.ready` 는 빈 디렉토리다(기록 파일이 사라진 것 = 자식이 집었다).');
      return;
    }
    enqueueSoftStop(target, { explicitInboxDir });
    ui.info(`soft stop 요청 기록: ${target}`);
    // ⭐ 「기록했다」와 「읽혔다」는 다른 값이다(🅕 2026-09-25) — 쓴 자리를 «절대 경로»로 보이고 읽힘을 기다린다.
    //   래치(`<inbox>.ready/stop`)는 자식 골루프가 집어 지운다. 지속 표식(`stop-requested.json`)은 부모가
    //   다음 관문·재발사 앞에서 읽으려고 «남긴다» — 그 파일이 남아 있는 것은 정상이다.
    const stopLatchPath = _joinPath(`${explicitInboxDir}.ready`, 'stop');
    ui.info(`  래치: ${stopLatchPath}`);
    ui.info(`  지속 표식(부모가 읽는다 · 남는 것이 정상): ${_joinPath(explicitInboxDir, 'stop-requested.json')}`);
    const stopWaitSeconds = Number(opts.readWait ?? '10');
    const stopWaitMs = Number.isFinite(stopWaitSeconds) && stopWaitSeconds > 0 ? stopWaitSeconds * 1000 : 0;
    const stopWaitStartedAt = Date.now();
    while (stopWaitMs > 0 && existsSync(stopLatchPath) && Date.now() - stopWaitStartedAt < stopWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (stopWaitMs > 0 && !existsSync(stopLatchPath)) {
      ui.info(`자식이 읽음 (${((Date.now() - stopWaitStartedAt) / 1000).toFixed(1)}초) — 이번 반복을 마치고 멈추며, 부모는 다음 관문·재발사를 건너뛴다.`);
    } else {
      ui.info(`아직 안 읽힘${stopWaitMs > 0 ? ` (${stopWaitSeconds}초 기다림)` : ''} — 자식은 «도구 결과마다·반복 경계»에서만 확인한다(긴 도구 호출 중이면 늦다). 확인: bun bin/elanous.mjs logs --all --include-test --category goal.loop --event soft-stop-after-tool-result --json --json-data`);
    }
  });

// self screen — 격리 하니스 공간(self-dev goal-loop)의 child 화면 뷰어(X11 forwarding식·2026-07-21 대표 co-design).
//   구조: PtyShell 레지스트리는 프로세스-로컬이라 self-implement CLI(별도 스폰)의 PTY 는 데몬 PWA 로 안 보인다.
//   → 공유 드라이버(driveHeadlessElanous)가 full snapshot 을 공간 화면 버퍼(file)에 쓰고 이 뷰어가 읽는다. 어느
//   진입점(self-implement·dev-harness)이든 커버. 격리는 ELANOUS_STATE_DIR 스코프(테스트는 같은 env 로 실행).
selfCmd
  .command('screen')
  .description('격리 하니스 공간(self-dev goal-loop)의 child 화면을 본다(X11 forwarding식). --space 또는 --run으로 지정·생략 시 최신/목록. -f 라이브(1s·Ctrl-C 종료).')
  .option('--space <id>', '공간 id/키 (생략 시 최신 화면·매칭은 부분일치 허용)')
  .option('--run <runId>', 'runId에서 headless.spawn 로그의 화면 키를 해석')
  .option('-f, --follow', '라이브 갱신 (1s·Ctrl-C 종료)')
  .option('--hb', 'poll-루프 heartbeat 표시 (INC-1 hang 진단 — i 고정=frozen vs 증가=idle)')
  .action(async (opts: { space?: string; run?: string; follow?: boolean; hb?: boolean }) => {
    // ⛔⭐ **truthy 가 아니라 «지정 여부»로 본다**(리뷰 must-fix) — 종전엔 `opts.space && opts.run`
    //   이라 `--run '' --space foo` 처럼 «빈 문자열»을 준 조합이 «안 걸렸다».
    //   ⇒ 모호한 입력을 조용히 한쪽으로 정하지 않는다는 이 명령의 계약이 빈 값에서 뚫렸다.
    if (opts.space !== undefined && opts.run !== undefined) {
      process.stderr.write('--run 과 --space 는 함께 사용할 수 없습니다.\n');
      process.exit(2);
    }
    const { readHarnessScreen, readHarnessHeartbeat, listHarnessScreens, stripScreenAnsi } = await import('./harness/harness-screen.js');
    let requestedKey = opts.space;
    // ⛔⭐⭐ **여기도 «지정 여부»다**(리뷰 must-fix · 위 충돌 검사와 «같은 결함의 한 층 아래»).
    //   종전 `if (opts.run)` 은 truthy 라 ***`--run ''` 단독이면 해석을 통째로 건너뛰고
    //   «조용히 최신 화면»(= 남의 런일 수 있다)을 냈다*** — 이 옵션이 막으려던 바로 그 사고다.
    if (opts.run !== undefined && opts.run.trim() === '') {
      process.stderr.write('--run 에 빈 runId 를 줄 수 없습니다.\n');
      process.exit(2);
    }
    if (opts.run !== undefined) {
      const { classifyRunScreenMissing, queryRunScreenKey } = await import('./self-implement/run-ledger.js');
      const resolved = queryRunScreenKey(opts.run);
      // ⛔⭐⭐ **해석 실패는 «0 이 아니다»**(리뷰 should-fix). 종전엔 두 실패 경로가 모두
      //   `process.exit(0)` 이라 ***자동화가 「화면을 봤다」로 읽었다*** — 사람은 문장을 읽지만
      //   스크립트는 종료 코드만 본다. 사유는 계속 갈라서 낸다(무엇이 없는지가 다르다).
      //   ⚠️ `2` 는 위 「--run 과 --space 동시 지정」이 쓰는 «사용법 오류»다. 해석 실패는 `1` 이다.
      if (resolved.logStoreStatus !== 'read') {
        process.stderr.write(`run 화면 해석 불가: 로그 스토어 ${resolved.logStoreStatus} (${resolved.logStorePath})\n`);
        process.exit(1);
      }
      if (!resolved.screenKey) {
        const last = resolved.lastEvent;
        const lastDetail = last
          ? ` 마지막 이벤트: ${last.category}/${last.event} (${Number.isFinite(Date.parse(last.timestamp)) ? `${Math.max(0, Math.floor((Date.now() - Date.parse(last.timestamp)) / 60_000))}분 전` : '시각 알 수 없음'})`
          : ' 마지막 이벤트: 없음';
        const status = classifyRunScreenMissing(last);
        const guidance = status === 'awaiting-start'
          ? '아직 화면을 띄우기 전입니다. 되묻기에 답하거나 저작이 끝날 때까지 기다리세요.'
          : status === 'pipeline-failed'
            ? '파이프라인이 오류로 멈췄습니다. 해당 error를 읽어 원인을 수리하세요.'
            : status === 'cleaned'
              ? '하니스가 정리되어 화면이 없습니다. 필요하면 새 런을 시작하세요.'
              : status === 'not-found'
                ? '이 runId의 이벤트가 없습니다. runId와 인스턴스 우주를 확인하세요.'
                : '화면을 아직 분류할 수 없습니다. 마지막 이벤트를 조사하세요.';
        process.stderr.write(`run 화면 해석 불가: ${guidance}${lastDetail} (${opts.run})\n`);
        process.exit(1);
      }
      requestedKey = resolved.screenKey;
    }
    const list = listHarnessScreens();
    // --run은 원장에서 해석한 화면 키와 정확히 일치해야 한다. --space의 기존 부분일치 편의는 보존한다.
    const key = opts.run !== undefined
      ? requestedKey
      : requestedKey
        ? (list.find((e) => e.spaceId === requestedKey)?.spaceId ?? list.find((e) => e.spaceId.includes(requestedKey))?.spaceId ?? requestedKey)
        : list[0]?.spaceId;
    if (opts.run === undefined && opts.space === undefined && key) process.stderr.write(`경고: --run/--space 미지정으로 최신 화면을 선택했습니다: ${key}\n`);
    // ★ --hb — heartbeat 진단(INC-1): i 고정+staleness 크면 frozen(어느 op 블록)·i 증가면 idle(타임아웃 로직).
    if (opts.hb && key) {
      const hb = readHarnessHeartbeat(key);
      if (!hb) { ui.info(`heartbeat 없음: ${key} (poll 루프 미진입 or 완료)`); process.exit(0); }
      try { const s = JSON.parse(hb); const staleMs = Date.now() - (s.at ?? 0); ui.info(`하니스 heartbeat [${key}]\n  i=${s.i} · alive=${s.alive} · lastActivityI=${s.lastActivityI} · silentFor=${s.silentFor} tick\n  마지막 갱신: ${Math.round(staleMs / 1000)}s 전${staleMs > 5000 ? '  ⚠️ STALE(루프 정지 의심 — i 고정이면 frozen)' : ''}`); } catch { ui.info(hb); }
      process.exit(0);
    }
    if (!key) {
      if (list.length === 0) ui.info('활성 하니스 화면 없음 (self-implement/dev-harness 구동 중이어야·같은 ELANOUS_STATE_DIR 로 실행).');
      else ui.info('활성 화면 목록:\n' + list.map((e) => `  ${e.spaceId}  (${Math.round((Date.now() - e.mtimeMs) / 1000)}s 전·${e.bytes}B)`).join('\n'));
      process.exit(0);
    }
    const render = (): boolean => {
      const frame = readHarnessScreen(key);
      if (frame === null) return false;
      if (opts.follow && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(`━━ 하니스 화면: ${key}${opts.run ? ` · runId=${opts.run}` : ''}${opts.follow ? ' (라이브·Ctrl-C 종료)' : ''} ━━\n`);
      const screen = stripScreenAnsi(frame);
      process.stdout.write(screen.endsWith('\n') ? screen : `${screen}\n`);
      return true;
    };
    if (!opts.follow) { if (!render()) ui.info(`화면 버퍼 없음: ${key}${opts.run ? ` (runId=${opts.run} 해석됨·아직 프레임 미기록)` : ' (아직 프레임 미기록)'}`); process.exit(0); }
    let alive = true;
    process.on('SIGINT', () => { alive = false; });
    while (alive) { render(); await new Promise((r) => setTimeout(r, 1000)); }
    process.stdout.write('\n');
    process.exit(0);
  });

// self participants — self-dev run checkpoint에 기록된 참여 주체만 읽는다. PTY 계보는 별도 `self run` 표면의 정의역이다.
selfCmd
  .command('participants <runId>')
  .description('run-participation 조회 — self-dev run checkpoint에 기록된 참가자의 id·kind·runIdSource를 출력한다. 프로세스 조상/후손은 `elanous pty lineage`가 답한다.')
  .action(async (runId: string) => {
    const { loadSelfDevRun } = await import('./self-dev/run-store.js');
    const run = loadSelfDevRun(runId);
    process.stdout.write('scope: run-participation\n');
    process.stdout.write('note: 프로세스 조상과 후손은 elanous pty lineage가 답합니다.\n');
    if (!run) {
      process.stdout.write(`run 없음: ${runId}\n`);
      return;
    }
    if (run.participants === undefined) {
      process.stdout.write('participants 축 없음: 옛 기록은 participant tracking을 사용하지 않았습니다.\n');
      return;
    }
    if (run.participants.length === 0) {
      process.stdout.write('참가자 없음: participant tracking은 사용했지만 기록된 참가자가 없습니다.\n');
      return;
    }
    for (const participant of run.participants) {
      process.stdout.write(`id=${participant.id} kind=${participant.kind} runIdSource=${participant.runIdSource}\n`);
    }
  });

// ★ self run — K5 run-identity join 뷰(2026-07-25·[[PLAN §K/K5]]). 한 self-dev run(runId)에 속한 모든 PTY 를
//   통째로 본다(runId≡spaceId≡sessionId≡ptyId 수동 상관 불필요·K1~K3 이 심은 join anchor 를 pty_manifest 로 소비).
selfCmd
  .command('run <runId>')
  .description('run-identity join 뷰 — 한 run(runId)의 전 PTY(space/session/종료행 포함)를 통째로 조회. runId 는 self orchestrate/implement 의 run 값(elanous logs --category run-identity 로 확인). --json 구조화. --png <dir> 로 결정적-순간 키프레임 PNG 추출.')
  .option('--json', '구조화 출력 [{ptyId, kind, spaceId, sessionId, instance, alive, closedAt, startedAt, cmd}]')
  .option('--png [dir]', '⭐ 이 run 의 결정적-순간 키프레임 PNG 를 <dir>(생략 시 현재 디렉터리)로 추출·나열')
  .option('--mp4 [path]', '⭐ 이 run 의 결정적-순간 키프레임들을 MP4 하이라이트릴로 조립(생략 시 <cwd>/run-<runId>.mp4·ffmpeg 필요)')
  .action(async (runId: string, opts: { json?: boolean; png?: string | boolean; mp4?: string | boolean }) => {
    // ★ --png / --mp4 / --json 은 상호 배타(리뷰 should-fix) — 분기 순서상 앞 옵션이 먼저 exit 해 뒤 옵션이 조용히
    //   무시되므로 명시 거부. 각각 키프레임추출 / 하이라이트릴 / 구조화조회로 출력 모드가 다르다.
    if ([opts.png !== undefined, opts.mp4 !== undefined, !!opts.json].filter(Boolean).length > 1) {
      process.stderr.write('--png / --mp4 / --json 은 한 번에 하나만 (키프레임 추출 / 하이라이트릴 조립 / 구조화 조회).\n');
      process.exit(2);
    }
    const { listPtyManifestByRun } = await import('./pty-shell/pty-manifest.js');
    const rows = listPtyManifestByRun(runId);
    // ⭐ --png — 결정적-순간 키프레임 PNG 추출(스마트 PNG 1차·[[keyframe-capture]]). runId 키로 저장된 전이 스냅샷을 outDir 로 복사.
    if (opts.png !== undefined) {
      const { listKeyframes } = await import('./capture/keyframe-capture.js');
      const { mkdirSync, copyFileSync } = await import('node:fs');
      const { join, basename } = await import('node:path');
      const outDir = typeof opts.png === 'string' && opts.png.trim() ? opts.png.trim() : process.cwd();
      const kfs = listKeyframes(runId);
      if (kfs.length === 0) {
        ui.info(`run '${runId}' 에 키프레임 PNG 없음 (전이 미발생·미스폰·다른 ELANOUS_STATE_DIR·grace TTL). executor(goal-loop PTY) run 만 캡처됨.`);
        process.exit(0);
      }
      let mkOk = true;
      try { mkdirSync(outDir, { recursive: true }); } catch (e) { mkOk = false; process.stderr.write(`outDir 생성 실패: ${String(e instanceof Error ? e.message : e).slice(0, 100)}\n`); }
      process.stdout.write(`━━ run ${runId} 키프레임 ${kfs.length}개 → ${outDir} ━━\n`);
      let failed = 0;
      for (const kf of kfs) {
        const dest = join(outDir, basename(kf.path));
        try {
          copyFileSync(kf.path, dest);
          process.stdout.write(`  #${String(kf.seq).padStart(3, '0')}  ${kf.state.padEnd(8)}  pty=${kf.ptyId}  ${(kf.bytes / 1024).toFixed(1)}KB  → ${dest}\n`);
        } catch (e) {
          failed += 1;
          process.stderr.write(`  #${String(kf.seq).padStart(3, '0')}  ${kf.state}  복사 실패: ${String(e instanceof Error ? e.message : e).slice(0, 80)}\n`);
        }
      }
      // ★ 추출 실패를 호출자가 감지 가능하게 non-zero exit(review should-fix: 실패해도 exit 0 이면 은폐).
      process.exit(!mkOk || failed > 0 ? 1 : 0);
    }
    // ⭐ --mp4 — 결정적-순간 키프레임을 MP4 하이라이트릴로 조립([[run-highlight-reel]]·encodeMp4 재사용). 얇은 배선:
    //   순수 DI 조립기 buildRunHighlightReel 이 수집·인코딩·판정(ffmpeg 없음/keyframe 0개)을 담당.
    if (opts.mp4 !== undefined) {
      const { buildRunHighlightReel } = await import('./self-dev/run-highlight-reel.js');
      const { listKeyframes } = await import('./capture/keyframe-capture.js');
      const { encodeMp4, probeFfmpeg } = await import('./capture/encoders/mp4.js');
      const { debug } = await import('./debug/log.js');
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const outPath = typeof opts.mp4 === 'string' && opts.mp4.trim() ? opts.mp4.trim() : join(process.cwd(), `run-${runId}.mp4`);
      const reel = await buildRunHighlightReel(runId, { listKeyframes, encodeMp4, probeFfmpeg });
      // no-keyframes 는 MP4 파일을 못 만든 것 → 자동화가 성공 오인 않게 non-zero(리뷰 should-fix·--png 정보성 exit 0 과 달리 산출물 없음).
      if (reel.kind === 'no-keyframes') { ui.info(reel.message); process.exit(1); }
      if (reel.kind === 'ffmpeg-unavailable') { ui.info(`${reel.message} (키프레임 ${reel.frames}개는 --png 로 추출 가능)`); process.exit(1); }
      try {
        writeFileSync(outPath, reel.mp4);
        debug.log('self-run', 'mp4-reel', { runId, frames: reel.frames, path: outPath });
        process.stdout.write(`━━ run ${runId} 하이라이트릴 ${reel.frames} 프레임 → ${outPath} (${(reel.mp4.length / 1024).toFixed(1)}KB) ━━\n`);
        process.exit(0);
      } catch (e) {
        process.stderr.write(`MP4 쓰기 실패: ${String(e instanceof Error ? e.message : e).slice(0, 100)}\n`);
        process.exit(1);
      }
    }
    if (opts.json) {
      await writeStdoutJson(JSON.stringify(rows.map((r) => ({ ptyId: r.id, kind: r.kind, spaceId: r.spaceId, sessionId: r.sessionId, instance: r.instance, alive: r.alive, closedAt: r.closedAt, startedAt: r.startedAt, cmd: r.cmd }))) + '\n');
      process.exit(0);
    }
    if (rows.length === 0) {
      ui.info(`run '${runId}' 에 속한 PTY 없음 (미스폰·다른 ELANOUS_STATE_DIR·grace TTL 경과·runId 오타). 'elanous logs --category run-identity' 로 run 확인.`);
      process.exit(0);
    }
    const live = rows.filter((r) => r.alive).length;
    process.stdout.write(`━━ run ${runId} ━━  PTY ${rows.length}개 (라이브 ${live}·종료 ${rows.length - live})\n`);
    for (const r of rows) {
      const status = r.alive ? '● 라이브' : `○ 종료${r.closedAt ? `(${new Date(r.closedAt).toISOString().slice(11, 19)})` : ''}`;
      process.stdout.write(`  ${status}  ${r.id}  [${r.kind}]  space=${r.spaceId || '-'}  session=${r.sessionId || '-'}  inst=${r.instance}\n`);
      process.stdout.write(`      cmd: ${r.cmd.slice(0, 100)}\n`);
    }
    process.exit(0);
  });

// self review — 외부/대표가 임의 GitHub PR 을 elanous 의 자율 PR 리뷰어(substrate·sol)로 리뷰하는 창구.
// gh pr diff → reviewPullRequest(agent-substrate/pr-reviewer·미션/하니스와 동일 엔진) → verdict/must-fix/
// should-fix. read-only(머지 안 함·머지=HITL 불변). self implement(구현)와 짝: 구현→PR→review.
selfCmd
  .command('review <pr...>')
  .description('자율 PR 리뷰 — GitHub PR(번호/URL/여러개)을 elanous 리뷰어(substrate·codex 사다리 best 칸)가 correctness/미배선/수용기준/설계 검증. gh pr diff → verdict(pass/warn/fail)+must-fix/should-fix. read-only(머지 안 함). --intent 로 리뷰 의도 지정(생략 시 PR 본문 → 제목 → `PR <번호>` 순 폴백).')
  .option('--intent <text>', '리뷰 의도/수용기준(생략 시 PR 본문 → 제목 → `PR <번호>` 순 폴백)')
  .option('--model <model>', '리뷰어 모델(기본 = codex 사다리 best 칸·ELANOUS_PR_REVIEW_MODEL)')
  .option('--acp', '⭐ ACP(독립 프로세스)로 리뷰 — API 대신 선택한 ACP 백엔드로 독립 리뷰')
  .option('--acp-model <alias>', 'ACP 모델 tier (지정 시 고정, 생략 시 선택한 백엔드 기본값)')
  .option('--acp-backend <id>', 'ACP 백엔드 id (기본: 설정 acp.reviewBackend, 없으면 공유 기본값)')
  .option('--acp-timeout <sec>', 'ACP 리뷰 1턴 최대 대기 초(초과 시 cancel·기본 300)', '300')
  .option('--context <path>', '리뷰어가 함께 판단할 레포 상대 파일 경로(반복 가능)', (value: string, previous: string[] = []) => [...previous, value])
  .option('--context-text <text>', '리뷰어가 함께 판단할 텍스트(반복 가능)', (value: string, previous: string[] = []) => [...previous, value])
  .option('--json', '구조화 출력 {pr, verdict, mustFix, shouldFix, reviewed}')
  .action(async (prParts: string[], opts: { intent?: string; model?: string; acp?: boolean; acpModel?: string; acpBackend?: string; acpTimeout?: string; context?: string[]; contextText?: string[]; json?: boolean }) => {
    const prArgs = prParts.flatMap((p) => String(p).split(/[,\s]+/).filter(Boolean)); // 번호/#번호/URL·콤마목록.
    if (!prArgs.length) { ui.error('PR 필요: elanous self review <번호|URL> [..]'); process.exit(2); }
    // ⭐ 본문은 seam(`runSelfReviewCliCommand`)에 있다 — 이 액션은 **의존 배선만** 한다.
    //   이유: 이 트랙이 고친 결함이 payload 가 아니라 **배선**(sink 가 --acp 분기 안에 있었다)이라,
    //   소스 문자열 검사가 아니라 **런타임 호출**로 잠가야 했다. index.ts 클로저 안에서는 그게
    //   불가능했으므로 원인을 없앴다(`runSelfImplementCliCommand` 선례).
    const { spawnSync } = await import('node:child_process');
    const { reviewPullRequest, renderReview } = await import('./agent-substrate/pr-reviewer.js');
    const { createRepositoryReferencedFileReader } = await import('./self-implement/goal-file-reader.js');
    const { streamLLM } = await import('./llm.js');
    const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
    const { debug } = await import('./debug/log.js');
    const { runSelfReviewCliCommand, reviewerContextArgs } = await import('./agent-substrate/self-review-cli.js');
    const contextOrder = reviewerContextArgs(process.argv.slice(2));
    const configuredAcpBackend = getUserConfig().acp.reviewBackend;
    const { results } = await runSelfReviewCliCommand(prArgs, {
      ...opts,
      ...(configuredAcpBackend ? { configuredAcpBackend } : {}),
      ...(contextOrder.length > 0 ? { contextOrder } : {}),
    }, {
      gh: (args, timeoutMs) => {
        const r = spawnSync('gh', args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
      // ⭐ S2 — 리뷰 증거를 이 PR 이 저작한 변경으로 좁히기 위한 git seam. 배선이 빠지면
      //   이미 머지된 남의 작업이 이 PR 것으로 보여 거짓 scope-creep 판정이 되돌아온다.
      git: (args, timeoutMs) => {
        // git-spawn-allow: This is the injected low-level runner consumed by self-review's direct runGitWithRetry path; routing it through runGitCommand would recurse through the retry seam.
        const r = spawnSync('git', args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
      reviewPullRequest,
      readReferencedFile: createRepositoryReferencedFileReader(process.cwd()),
      renderReview,
      // ⛔⭐ 하드코딩 금지(🩸 2026-09-23 실측: 여기 'medium' 이 박혀 있었다) — 무인 리뷰와 «같은» 규칙.
      //   대표 결정: 리뷰는 high. 역할 티어의 effort 를 쓰고, 티어가 없으면 high.
      makeApiLlm: (model) => {
        const effort = reviewReasoningEffort(resolveRoleLlm('review'));
        return (prompt: string) =>
          streamLLM([{ role: 'user', content: prompt }], () => {}, { model, ...(effort ? { reasoningEffort: effort } : {}) });
      },
      makeAcpLlm: (o) => {
        // ⚠️ 동기 팩토리라 여기서 동적 import 를 쓸 수 없다 — 지연 로드해 첫 호출에 붙인다.
        // ⭐ 본문은 `makeLazyAcpReviewLLM` 이 갖는다 — 여기 익명 화살표로 두면 «인자 유실 회귀»를
        //   막을 테스트 자리가 없다(`#7486` 이 실제로 그렇게 한 번 샜다).
        let made: ((prompt: string, images?: readonly ReviewImage[]) => Promise<string>) | null = null;
        return async (prompt: string, images?: readonly ReviewImage[]) => {
          if (!made) {
            const { makeLazyAcpReviewLLM } = await import('./agent-substrate/acp-reviewer.js');
            made = makeLazyAcpReviewLLM({ cwd: process.cwd(), backend: o.backend, model: o.model, timeoutMs: o.timeoutMs });
          }
          return made(prompt, images);
        };
      },
      registerSink: async (surface) => { await registerStandaloneLogSink(surface); },
      log: (event, data, o) => debug.log('self-review', event, data, o ?? {}),
      info: (t) => ui.info(t),
      error: (t) => ui.error(t),
      print: (t) => console.log(t),
      now: () => Date.now(),
      envModel: () => process.env.ELANOUS_PR_REVIEW_MODEL,
    });
    if (opts.json) await writeStdoutJson(JSON.stringify(results.length === 1 ? results[0] : results) + '\n');
  });

selfCmd
  .command('log')
  .description('구현/변경 이벤트를 elanous 자기인지 기억에 주입(surface_events domain=elanous + 선택 문서 벡터)')
  .requiredOption('-s, --summary <text>', '1-2줄 요약(무엇을 구현/변경했나)')
  .option('-t, --tool <name>', '주입한 도구', 'claude-code')
  .option('-k, --kind <kind>', 'impl|change|fix|design|refactor', 'impl')
  .option('-d, --doc <path>', '함께 인제스트할 문서(HANDOFF/REPORT/PLAN md)')
  .option('--pr <n>', '연관 PR 번호(refs)')
  .option('--branch <name>', '연관 branch(refs)')
  .option('--mission <apm_id>', '미션 귀속(apm_id) — 외부 변경을 미션 종합 히스토리에 합류')
  .option('-i, --importance <n>', '0-10 현저성', '7')
  .action(async (opts: { summary: string; tool: string; kind: string; doc?: string; pr?: string; branch?: string; mission?: string; importance: string }) => {
    const { injectSelfMemory } = await import('./domains/self-awareness.js');
    // stdin 파이프 시 상세 본문으로.
    let text: string | undefined;
    const piped = await readPipedStdin();   // ★ OBS-T3 — 종전엔 하니스 stdin(소켓)에서 영원히 대기했다
    if (piped) text = piped;
    const refs: Record<string, unknown> = {};
    if (opts.pr) refs.pr = opts.pr;
    if (opts.branch) refs.branch = opts.branch;
    const r = await injectSelfMemory({
      tool: opts.tool, summary: opts.summary, kind: opts.kind,
      importance: parseInt(opts.importance, 10) || 7,
      ...(text ? { text } : {}), ...(opts.doc ? { docPath: opts.doc } : {}),
      ...(Object.keys(refs).length ? { refs } : {}),
      ...(opts.mission ? { missionId: opts.mission } : {}),
    });
    ui.info(`self-event ${r.eventId.slice(0, 8)} 기록(${opts.tool}·${opts.kind})${opts.mission ? ` · 미션 ${opts.mission} 귀속` : ''}${opts.doc ? ` · 문서 ${r.docChunks} 청크 인제스트${r.docSkipped ? ` (${r.docSkipped} skip)` : ''}` : ''}`);
  });

// ★ self provision — L3 역량 프로비저닝(P4·#7-5) 데모/구동 surface. discoverCapability(발굴)+buildSelfProvision
//   (설치)를 실제로 배선한 첫 소비자. **기본 dry-run**(정책 판정만·부작용 0)·--apply 로만 실제 설치. self 대상
//   (elanous repo pkg / 활성 레지스트리 skill·subagent·in-process reload). skill/subagent 는 --source 로 allowlist
//   등록해야 설치(없으면 deny-all=안전 기본). --discover 로 먼저 web 발굴(⭐Grok x_search 커뮤니티 + web registry).
selfCmd
  .command('provision <layer> <spec>')
  .description('L3 역량 프로비저닝 — elanous-self 에 pkg/skill/subagent 설치. 기본 dry-run(정책 판정)·--apply 로 실제 설치. --discover 로 web 발굴 먼저. skill/subagent 는 --source 필요(allowlist).')
  .option('--source <path>', 'skill/subagent 설치 소스 경로 — allowlist 등록(없으면 deny-all=거부)')
  .option('--discover', '먼저 web 발굴 후보 출력(Grok x_search 커뮤니티 + web-search registry·단일 seam)')
  .option('--apply', '실제 설치 실행(기본 dry-run=정책 판정만·부작용 없음)')
  .option('--reason <text>', '설치 사유(관측에 기록)')
  .action(async (layer: string, spec: string, opts: { source?: string; discover?: boolean; apply?: boolean; reason?: string }) => {
    const { discoverCapability } = await import('./agent-mission/discover-capability.js');
    const { buildSelfProvision, planSelfProvision } = await import('./agent-mission/provision.js');
    const { resolveMainRepoRoot } = await import('./git-fs/worktree.js');
    // self = elanous 저장소 대상 — raw cwd(하위 디렉토리/타 프로젝트)가 아니라 repo 루트로 못박음(리뷰 should-fix).
    const repoRoot = resolveMainRepoRoot(process.cwd()) ?? process.cwd();
    // ① --discover: 발굴(읽기·부작용 0) — 대표 지목 Grok+web 열쇠 시연.
    if (opts.discover) {
      ui.info(`🔎 발굴: "${spec}" (layer=${layer})…`);
      const cands = await discoverCapability(spec, { layer });
      if (!cands.length) ui.info('  후보 없음 — provider 키/네트워크 확인(grounding 외부티어와 동일 경로).');
      for (const c of cands) ui.info(`  · [${c.source}] ${c.title}${c.url ? ` — ${c.url}` : ''}\n    ${c.snippet.slice(0, 160)}`);
    }
    // ② 정책 판정(dry-run) 또는 설치(--apply). skill/subagent 는 --source 로만 allowlist 개방(안전 기본=deny-all).
    const plan = planSelfProvision(layer, spec, opts.source, repoRoot);
    if (!opts.apply) {
      const d = plan.decision;
      ui.info(`\n[dry-run] ${d.allow ? `✅ 허용 (kind=${d.kind})` : `⛔ 거부: ${d.reason}`}`);
      if (d.allow) ui.info('  → --apply 로 실제 설치 (skill/subagent 는 --source <경로> 필요)');
      process.exit(plan.exitCode); // ★ 거부=1(자동화가 성공으로 오인 방지·must-fix)
    }
    const req = { layer, spec, ...(opts.reason ? { reason: opts.reason } : {}) };
    const res = await buildSelfProvision({ repoRoot, resolve: plan.resolve })(req);
    ui.info(`\n${res.ok ? '✅' : '⛔'} ${res.action}: ${res.detail}`);
    process.exit(res.ok ? 0 : 1);
  });

// 발화 ingress(2026-07-19) — 외부 도구(Claude Code/Codex/Gemini)의 사용자 발화를 elanous 기억에
// provenance 태그(origin·git·branch·cwd·시간)와 함께 편입. hook 이 이걸 호출. text 는 --text 또는 stdin.
selfCmd
  .command('utterance')
  .description('외부 도구 발화를 elanous 기억에 주입 — origin/git/branch/cwd/시간 태그(회상이 "누가 언제 어디서" 구분). text=--text 또는 stdin')
  .option('-s, --text <text>', '발화 원문(생략 시 stdin)')
  .option('--source <origin>', 'claude-code|codex|gemini|…', 'claude-code')
  .option('--session <id>', '세션 id')
  .option('--git-hash <hash>', '발화 시점 git HEAD(short)')
  .option('--branch <name>', 'git 브랜치')
  .option('--cwd <dir>', '작업 디렉토리')
  .option('--ts <iso>', 'ISO 시간(기본 now)')
  .option('-i, --importance <n>', '0-10 현저성', '5')
  .action(async (opts: { text?: string; source: string; session?: string; gitHash?: string; branch?: string; cwd?: string; ts?: string; importance: string }) => {
    let text = opts.text;
    if (!text) text = await readPipedStdin();   // ★ OBS-T3
    if (!text || !text.trim()) { ui.error('utterance: --text 또는 stdin 필요'); process.exit(1); }
    // 독립 CLI 프로세스 — 데몬 StoreSink 를 상속 안 하므로 logs.db 싱크를 붙여야
    // injectUtterance 의 `debug.log('memory.utterance','ingress')` 가 logs.db 에 닿음(제1원칙 관측).
    const { injectUtterance } = await import('./domains/self-awareness.js');
    const r = injectUtterance({
      text: text.trim(),
      origin: opts.source,
      ...(opts.session ? { sessionId: opts.session } : {}),
      ...(opts.gitHash ? { gitHash: opts.gitHash } : {}),
      ...(opts.branch ? { branch: opts.branch } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.ts ? { ts: opts.ts } : {}),
      importance: parseInt(opts.importance, 10) || 5,
    });
    ui.info(`utterance ${r.eventId.slice(0, 8)} 기록(origin=${opts.source}${opts.branch ? `·${opts.branch}` : ''}${opts.gitHash ? `·${opts.gitHash}` : ''})`);
  });

selfCmd
  .command('recall <query...>')
  .description('elanous 자기인지 기억 회상 — "내가 최근 뭘 구현했지"(surface_events domain=elanous)')
  .option('-n, --limit <n>', '반환 건수', '8')
  .option('--since-hours <n>', '조회 기간(시간)', '720')
  .option('--all-instances', '등록 elanous 인스턴스 전체의 기억을 연합 회상(fleet · read-only union · §10)')
  .option('--include-test', '연합에 격리 test 인스턴스도 포함(기본 제외)')
  .option('--include-observer-output', '관측기가 생성한 출력도 회상에 포함(기본 제외)')
  .action(async (queryParts: string[], opts: { limit: string; sinceHours: string; allInstances?: boolean; includeTest?: boolean; includeObserverOutput?: boolean }) => {
    const { recallSelfEvents } = await import('./domains/self-awareness.js');
    const { openSurfaceEventsDb } = await import('./domains/surface-events.js');
    const query = queryParts.join(' ');
    const limitN = parseInt(opts.limit, 10) || 8;
    const sinceH = parseInt(opts.sinceHours, 10) || 720;
    // fleet 연합 — 각 인스턴스의 surface_events 를 연 뒤 회상, 인스턴스 라벨 달아 score 순 union.
    if (opts.allInstances) {
      const { buildFleetView, instanceStorePaths } = await import('./domains/fleet.js');
      // 격리 test 인스턴스는 기본 제외(회상 코퍼스 오염 방지 · Phase A) — --include-test 로 opt-in.
      const view = buildFleetView().filter((v) => v.stores.memory && (opts.includeTest === true || v.kind !== 'test'));
      const all: Array<{ inst: string; ts: string; surface: string; score: number; text: string }> = [];
      for (const i of view) {
        const idb = openSurfaceEventsDb(instanceStorePaths(i.stateDir).memory);
        try {
          for (const h of recallSelfEvents(idb, query, { limit: limitN, sinceHours: sinceH, excludeObserverOutput: opts.includeObserverOutput !== true })) {
            all.push({ inst: i.name, ts: h.ts, surface: h.surface, score: h.score, text: (h.summary ?? h.text) });
          }
        } catch { /* skip 손상 db */ } finally { idb.close?.(); }
      }
      all.sort((a, b) => b.score - a.score);
      const capped = all.slice(0, limitN);
      if (capped.length === 0) { ui.info(`"${query}" 관련 기억 없음(${view.length}개 인스턴스 연합).`); return; }
      ui.header(`self-awareness 회상 · fleet (${capped.length} · ${view.length} instances)`);
      for (const h of capped) {
        console.log(`  [${h.ts.slice(0, 16).replace('T', ' ')} ${h.inst}/${h.surface}] (score ${h.score.toFixed(2)})`);
        console.log(`    ${h.text.slice(0, 160)}`);
      }
      return;
    }
    const db = openSurfaceEventsDb();
    try {
      const hits = recallSelfEvents(db, query, { limit: limitN, sinceHours: sinceH, excludeObserverOutput: opts.includeObserverOutput !== true });
      if (hits.length === 0) { ui.info(`"${query}" 관련 구현 기억 없음(domain=elanous).`); return; }
      ui.header(`self-awareness 회상 (${hits.length})`);
      for (const h of hits) {
        console.log(`  [${h.ts.slice(0, 16).replace('T', ' ')} ${h.surface}] (score ${h.score.toFixed(2)})`);
        console.log(`    ${(h.summary ?? h.text).slice(0, 160)}`);
      }
    } finally { db.close(); }
  });

selfCmd
  .command('capability')
  .alias('cap')
  .description('미션/외부가 만든 능력(자원)을 self-awareness 에 정식 등록·update·remove(status). 자원 핸들(크론·태스크·CLI)로 라이프사이클 라우팅.')
  .requiredOption('--name <name>', '능력 이름(라이프사이클 키·같은 name=같은 능력)')
  .option('-s, --summary <text>', '무엇을 하는 능력인가')
  .option('--mission <id>', '귀속 미션 id')
  .option('--pr <urls>', 'PR URL(쉼표구분)')
  .option('--files <paths>', '핵심 파일(쉼표구분)')
  .option('--schedule <ids>', '만든 크론 id(쉼표구분·elanous schedule 핸들)')
  .option('--task <ids>', '만든 태스크 id(쉼표구분)')
  .option('--cli <cmd>', '노출한 CLI(예: "elanous local inventory")')
  .option('--status <status>', 'active|superseded|removed', 'active')
  .option('--source <s>', "'mission' | 'external:<tool>'", 'external:claude-code')
  .option('--doc <path>', '함께 인제스트할 문서(FEATURE/HANDOFF)')
  .action(async (opts: { name: string; summary?: string; mission?: string; pr?: string; files?: string; schedule?: string; task?: string; cli?: string; status: string; source: string; doc?: string }) => {
    const { recordCapability } = await import('./domains/self-awareness.js');
    const split = (s?: string): string[] | undefined => { const a = s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []; return a.length ? a : undefined; };
    const status = (opts.status === 'removed' || opts.status === 'superseded') ? opts.status : 'active';
    const r = await recordCapability({
      name: opts.name, summary: opts.summary || opts.name,
      ...(opts.mission ? { missionId: opts.mission } : {}),
      ...(split(opts.pr) ? { prUrls: split(opts.pr) } : {}),
      ...(split(opts.files) ? { files: split(opts.files) } : {}),
      ...(split(opts.schedule) ? { scheduleIds: split(opts.schedule) } : {}),
      ...(split(opts.task) ? { taskIds: split(opts.task) } : {}),
      ...(opts.cli ? { cliCommand: opts.cli } : {}),
      status, source: opts.source,
      ...(opts.doc ? { docPath: opts.doc } : {}),
    });
    ui.info(`능력 등록(${status}) — ${opts.name} · self-event ${r.eventId.slice(0, 8)}${opts.mission ? ` · 미션 ${opts.mission}` : ''}`);
  });

selfCmd
  .command('capabilities')
  .alias('caps')
  .description('등록된 능력(자원) 조회 — 미션이 만든 자원 목록(크론·태스크·CLI·PR 핸들 포함). --mission 필터·--all(removed 포함)·--json.')
  .option('--mission <id>', '미션 필터')
  .option('--all', 'removed 포함')
  .option('--json', 'JSON')
  .option('-n, --limit <n>', '건수', '100')
  .action(async (opts: { mission?: string; all?: boolean; json?: boolean; limit: string }) => {
    const { listCapabilities } = await import('./domains/self-awareness.js');
    const { openSurfaceEventsDb } = await import('./domains/surface-events.js');
    const db = openSurfaceEventsDb();
    try {
      const caps = listCapabilities(db, { ...(opts.mission ? { missionId: opts.mission } : {}), includeRemoved: !!opts.all, limit: parseInt(opts.limit, 10) || 100 });
      if (opts.json) { await writeStdoutJson(JSON.stringify(caps, null, 2) + '\n'); return; }
      if (!caps.length) { ui.info('등록된 능력 없음(domain=elanous·kind=capability).'); return; }
      ui.header(`등록된 능력 (${caps.length})${opts.mission ? ` · 미션 ${opts.mission}` : ''}`);
      for (const c of caps) {
        const mark = c.status === 'active' ? '●' : c.status === 'superseded' ? '◐' : '○';
        console.log(`\n${mark} ${c.name}  [${c.status}·${c.source}]${c.missionId ? ` · ${c.missionId.slice(0, 44)}` : ''}`);
        console.log(`    ${c.summary.slice(0, 120)}`);
        if (c.cliCommand) console.log(`    CLI: ${c.cliCommand}`);
        if (c.prUrls.length) console.log(`    PR: ${c.prUrls.join(', ')}`);
        if (c.scheduleIds.length) console.log(`    크론: ${c.scheduleIds.join(', ')} (elanous schedule 로 관리)`);
        if (c.taskIds.length) console.log(`    태스크: ${c.taskIds.join(', ')} (elanous autopilot/task 로 관리)`);
        if (c.files.length) console.log(`    파일: ${c.files.slice(0, 5).join(', ')}`);
      }
    } finally { db.close(); }
  });

// ── factcheck (팩트체크 캐스케이드 — 내부 발송원장 → 외부 X/레딧/웹) ──
program
  .command('factcheck <query...>')
  .description('팩트체크 — 내부(발송 리포트/대화) 먼저 검색 → 없으면 외부(X/레딧/웹) 에스컬레이션')
  .option('--no-external', '외부 에스컬레이션 끄기(내부만)')
  .option('-k, --kind <kind>', '내부 종류 필터 — alert|report|digest(리포트 채널만: report/alert)')
  .option('--since-hours <n>', '내부 조회 기간(시간)', '168')
  .option('-n, --limit <n>', '내부 반환 건수', '6')
  .action(async (queryParts: string[], opts: { external: boolean; kind?: string; sinceHours: string; limit: string }) => {
    const { factCheck } = await import('./domains/fact-check.js');
    const query = queryParts.join(' ');
    const r = await factCheck({
      query, external: opts.external,
      sinceHours: parseInt(opts.sinceHours, 10) || 168,
      limit: parseInt(opts.limit, 10) || 6,
      ...(opts.kind ? { kind: opts.kind } : {}),
    });
    const badge = r.verdict === 'found-internal' ? '✅ 내부확인' : r.verdict === 'found-external' ? '🌐 외부발견' : '❌ 미확인';
    ui.header(`팩트체크 "${query}" — ${badge}`);
    console.log(`  ${r.note}`);
    if (r.internal.length) {
      console.log(`\n  [내부 ${r.internal.length}건]`);
      for (const h of r.internal) {
        console.log(`   · [${h.when.slice(0, 16).replace('T', ' ')} ${h.surface}/${h.kind ?? '?'} score ${h.score}] ${h.text.slice(0, 120)}`);
      }
    }
    if (r.external && r.external.totalHits > 0) {
      console.log(`\n  [외부 뉴스 ${r.external.totalHits}건]`);
      console.log(r.external.output.split('\n').map(l => `   ${l}`).join('\n'));
    }
    if (r.community?.length) {
      console.log(`\n  🔥 [펨코 인기글 ${r.community.length}건 · crowd 추천·참고(검증은 뉴스)]`);
      for (const h of r.community) console.log(`   · ${h.text.slice(0, 120)}`);
    }
  });

registerProviderCommands(program);

// ── status-bar (one-shot Claude-Code-style status line) ──
program
  .command('status-bar')
  .description('Print the status pills (working dir + git + model) — pipe into shell prompt or preview')
  .option('--secondary', 'Also print the (stubbed) secondary line')
  .action((opts: { secondary?: boolean }) => {
    const state = {
      cwd: process.cwd(),
      providerInfo: inspectActiveProvider(),
    };
    console.log(renderPrimaryStatus(state));
    if (opts.secondary) {
      const sec = renderSecondaryStatus(state);
      if (sec) console.log(sec);
    }
  });

registerScheduleCommands(program);

/** `elanous decide*` 공통 — 보낼 곳과 자격을 정한다(설정 decide.endpoint > ELANOUS_JEV_ENDPOINT > Typesafe). 없으면 안내하고 rc 2. */
async function loadJevAccessOrExit(): Promise<import('./decide/jev.js').JevAccess> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveJevAccess } = await import('./decide/jev.js');
  const expand = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const raw = getUserConfig().raw.decide;
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const resolved = resolveJevAccess({
    ...(config ? { config } : {}),
    env: process.env,
    readFile: (path) => { const file = expand(path); return existsSync(file) ? readFileSync(file, 'utf8') : undefined; },
    typesafeCachePath: join(homedir(), '.cache', 'typesafe_api_key'),
  });
  if (!resolved.ok) {
    // ⛔ 금지만 주지 않는다 — 치는 법을 같이 낸다.
    console.error(resolved.message);
    process.exit(2);
  }
  debug.log('decide.access', 'resolved', { endpointSource: resolved.access.endpointSource, hasKey: Boolean(resolved.access.key), model: resolved.access.model });
  return resolved.access;
}

registerIntakeCommands(program);

registerLogsCommands(program);

// ── ad (marketing-ad pipeline entrance) ──
/** ⛔ 「있다」와 「읽을 수 있는 파일이다」는 다른 값 — 디렉토리·권한 없는 파일을 실사로 읽지 않는다. */
function isReadableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function formatAdProductionWarnings(
  value: Pick<AdPipelinePlan, 'unwiredProduction'> | AdPipelineResult,
): readonly string[] {
  const unwiredProduction = 'unwiredProduction' in value ? value.unwiredProduction : value.plan.unwiredProduction;
  return unwiredProduction.length > 0
    ? [`⚠️ 이 실행은 마스터를 만들 수 없습니다 — 미배선 제작 단계: ${unwiredProduction.join(', ')}`]
    : [];
}

program.command('ad [input...]')
  .description('판매 URL, 텍스트 브리프 또는 실사 이미지로 광고 제작 파이프라인을 시작')
  // ⛔⭐ «가변»(`<path...>`)으로 두지 않는다 — 그러면 뒤따르는 URL·텍스트까지 삼켜서
  //    사람이 「경로를 못 읽는다」는 «틀린 이유»를 받는다(실측으로 두 번 밟았다).
  //    ⇒ 반복 가능한 «단일 값»으로 둔다: --image a.png --image b.png
  .option('--image <path>', '실사 이미지 경로 (반복 가능)', (value: string, acc: string[]) => [...acc, value], [] as string[])
  .option('--brief <text>', '이미지에 덧붙일 텍스트 브리프')
  .option('--facts <path>', '접지 사실 JSON (aside 로 수집한 PageFacts — 매뉴얼 §H① 참조)')
  // ⛔⭐ 앞쪽 칸(조사·구상)은 «옵트인»이다 — `--category` 를 준 사람만 돈다.
  //    🩸 이 둘을 «필수»로 두면 ⑴ 기존 입구 셋이 전부 blocked 가 되고
  //       ⑵ 게이트를 «묻기 전»에 과금 크롤(omni-crawl)이 나간다. 실측으로 둘 다 났다.
  .option('--category <category>', '⭐ 앞쪽 칸을 «켠다» — 확인된 상품 카테고리로 조사·구상을 돌리고 CONCEPT_OK 를 묻는다')
  .option('--selection <id>', '조사 후보 중 사람이 고른 후보 ID (없으면 후보를 보여 주고 한 줄 묻는다)')
  .option('--plan', '실행 또는 승인 없이 입력 출처와 파이프라인 계획 출력')
  .action(async (input: string[], options: { image?: string[]; brief?: string; facts?: string; category?: string; selection?: string; plan?: boolean }) => {
    const { classifyIntake } = await import('./ad-pipeline/intake.js');
    const { createAdPipelineDeps, createAdPipelinePlan, parseGroundingFacts, runAdPipeline } = await import('./ad-pipeline/run.js');
    type PageFacts = Parameters<typeof parseGroundingFacts>[0] extends unknown
      ? Extract<ReturnType<typeof parseGroundingFacts>, { ok: true }>['facts'] : never;
    const imagePaths = options.image ?? [];
    const classified = classifyIntake({
      values: input,
      imagePaths,
      ...(options.brief ? { brief: options.brief } : {}),
      unreadableImagePaths: imagePaths.filter((path) => !isReadableFile(path)),
    });
    if (!classified.ok) {
      ui.error(classified.message);
      process.exitCode = 1;
      return;
    }
    // ⭐ 접지는 aside(사람의 실제 브라우저)가 모은다 — 매뉴얼 §H①. 그 산출을 여기로 «건네준다».
    //    ⛔ 안 주면 파이프라인이 blocked 로 멈춘다(조용히 통과하지 않는다).
    let facts: PageFacts | undefined;
    if (options.facts) {
      if (classified.intake.kind !== 'url') {
        ui.error('--facts 는 판매 URL 갈래에서만 쓴다.');
        process.exitCode = 1;
        return;
      }
      if (!isReadableFile(options.facts)) {
        ui.error(`접지 사실 파일을 읽을 수 없다: ${options.facts}`);
        process.exitCode = 1;
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(options.facts, 'utf8'));
      } catch (error) {
        ui.error(`접지 사실 JSON 을 못 읽었다: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const checked = parseGroundingFacts(raw, classified.intake.url);
      if (!checked.ok) {
        ui.error(checked.reason);
        process.exitCode = 1;
        return;
      }
      facts = checked.facts;
    }
    // ⛔ 검증은 «모든 실행 모드»에 적용된다 — --plan 이 그것을 건너뛰면
    //    사람이 계획을 보고 「이 facts 로 되겠구나」 오해한 채 실행에서 처음 거절당한다.
    if (options.plan) {
      await writeStdoutJson(JSON.stringify(createAdPipelinePlan(classified.intake, { hasGroundingFacts: facts !== undefined }), null, 2) + '\n');
      return;
    }
    // ⛔ `--category` 가 «없으면» 조사·구상은 아예 «안 부른다» — 과금 경로가 열리지 않는다.
    const category = options.category?.trim();
    type AdFrontOpts = Pick<Parameters<typeof createAdPipelineDeps>[0], 'frontStage' | 'collectSurvey' | 'selectSurveyCandidate' | 'generateConcept'>;
    let front: AdFrontOpts = {};
    if (category) {
      const { createOmniCrawlSurveyCollector } = await import('./ad-pipeline/survey.js');
      const { createDefaultConceptGenerator } = await import('./ad-pipeline/concept.js');
      const brand = classified.intake.kind === 'text' ? classified.intake.brief
        : classified.intake.kind === 'url' ? classified.intake.url : classified.intake.brief;
      const request = { category, ...(brand ? { brand } : {}) };
      front = {
        frontStage: { survey: request, ...(options.selection?.trim() ? { selection: options.selection.trim() } : {}) },
        collectSurvey: createOmniCrawlSurveyCollector(),
        selectSurveyCandidate: async (survey) => {
          await writeStdoutJson(JSON.stringify({ survey }, null, 2) + '\n');
          return readStdinLine('조사 후보 중 고른 ID 한 줄: ');
        },
        generateConcept: createDefaultConceptGenerator(),
      };
    }
    const deps = createAdPipelineDeps({
      ask: async (gate) => (await readStdinLine(`Approve ${gate}? [y/N] `)).trim().toLowerCase() === 'y',
      report: (line) => { console.log(line); },
      ...(facts ? { collectPageFacts: () => facts } : {}),
      ...front,
    });
    const result = await runAdPipeline(classified.intake, deps);
    for (const line of formatAdProductionWarnings(result)) console.log(line);
    await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
    if (result.status === 'rejected' || result.status === 'blocked') process.exitCode = 1;
  });

registerDocsCommands(program);
registerPrivateLedgerCommands(program);
registerFleetCommands(program);

// ── ops (운영 관측 — 지금 뭐 도나·이상 없나·상태 전이) ──
registerOpsCommands(program);

registerPublishCommands(program);

program.command('env').description('환경 감지')
  .command('profile').description('환경 프로파일 표시 (조회 전용)')
  .option('--json', 'JSON 출력')
  .action(async (opts: { json?: boolean }) => {
    const { collectEnvProfile } = await import('./agent-mission/env-profile.js');
    const profile = collectEnvProfile();
    if (opts.json) await writeStdoutJson(JSON.stringify(profile) + '\n');
    else console.log([
      `OS: ${profile.os} · shell: ${profile.shell ?? 'unknown'}`,
      `Package managers: ${profile.packageManagers.join(', ') || 'none'}`,
      `Tools: ${profile.tools.join(', ') || 'none'}`,
      `Credentials available: ${Object.entries(profile.credentials).filter(([, available]) => available).map(([name]) => name).join(', ') || 'none'}`,
      `Network: ${profile.network} · disk free: ${profile.disk?.availableKb ?? 'unknown'} KB`,
    ].join('\n'));
  });

// ── agent-mission (외부 에이전트 backend 미션·리뷰·셋업) — `codex` 는 deprecated alias(하위호환) ──
//   U2(명명 중립화): U1 이 backend 를 애그노스틱화했으므로 CLI 이름도 codex-특정 → 중립으로.
//   등록 backend가 바뀌면 사람용 설명도 source-of-truth에서 따라간다. canonical 은 `agent-mission`(모듈
//   src/agent-mission/·관측 카테고리 agent-mission·U1 핸드오프 용어와 정합) — 최상위 `agent`(single-turn
//   chat-with-tools)가 이미 점유해 충돌하므로 그 이름은 못 쓴다. 기존 cron/스크립트(`elanous codex review-watch`
//   등)는 commander alias 로 그대로 resolvable(하위호환 불변). 상태경로 codex-mission 은 별도로 보존(아래 락/DB).
const agentBackendHelpNames = agentBackendNames();
const agentBackendHelpList = agentBackendHelpNames.map((name, index) => index === 0 ? `${name}[디폴트]` : name).join('·');
const agentCmd = program
  .command('agent-mission')
  .alias('codex')
  .description(`Agent-mission CLI — 외부 에이전트 backend(${agentBackendHelpList}) 미션·리뷰 워치·셋업. \`codex\` 는 deprecated alias(하위호환).`);

// ★ 제1원칙 관측 — agent-mission 전 서브커맨드에 logs.db 싱크를 중앙 배선(preAction 훅)하고, 레거시
//   `codex` alias 진입이면 브레드크럼(명명 중립화 이행률 추적 → alias 제거 안전시점 판정 근거).
//   • 균일 커버리지: 훅은 mission/review-*/setup/models/config-migrate 모든 액션 앞에 1회 실행 →
//     각 액션의 개별 registerStandaloneLogSink 를 대체(중복 싱크 방지·전 서브커맨드가 logs.db 도달).
//   • surface 보존: 기존에 싱크를 등록하던 서브커맨드는 옛 surface 를 그대로 유지(관측 attribution 계약
//     불변 — 명명 PR 이 대시보드/조회 소비자를 건드리지 않음). 신규 커버 서브커맨드만 'agent-mission'.
//   • robust 판정: isLegacyCodexInvocation(argv 첫 positional 스캔) — argv[2] 브리틀함 회피.
//   관측=elanous logs --category agent-cli.alias · sink 실패는 fail-open(파일트레일이 진실원).
// 기존 surface(리네임 전 각 액션이 등록하던 값) — attribution 보존용. 나머지는 'agent-mission'.
const AGENT_MISSION_SURFACE_BY_SUB: Record<string, string> = {
  mission: 'agent-mission',
  'review-loop': 'review-loop',
  'review-watch': 'review-watch',
};
agentCmd.hook('preAction', async (_thisCommand, actionCommand) => {
  const surface = AGENT_MISSION_SURFACE_BY_SUB[actionCommand.name()] ?? 'agent-mission';
  try {
    const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
    await registerStandaloneLogSink(surface);
  } catch { /* fail-open */ }
  try {
    const { isLegacyCodexInvocation, AGENT_ALIAS_LOG_CATEGORY } = await import('./agent-mission/legacy-alias.js');
    if (isLegacyCodexInvocation(process.argv)) {
      const { debug } = await import('./debug/log.js');
      debug.log(AGENT_ALIAS_LOG_CATEGORY, 'legacy-codex-invoked', { sub: actionCommand.name() });
      // 사용자 폐기 안내(should-fix) — 대화형(TTY)일 때만 stderr 한 줄. cron/파이프(non-TTY)는
      // 침묵(스팸·로그오염 방지)하고 브레드크럼만 남긴다 → 하위호환 불변, cron 안 깨짐.
      if (process.stderr.isTTY) {
        process.stderr.write(`ℹ️  \`elanous codex\` 는 deprecated alias 입니다 — \`elanous agent-mission ${actionCommand.name()}\` 로 이행하세요(현재는 동일 동작).\n`);
      }
    }
  } catch { /* fail-soft — 관측 실패가 명령 실행을 막지 않음 */ }
});

registerCapabilitiesCommand(agentCmd);

agentCmd.command('install-from-docs <tool>')
  .description('공식 설치 문서를 읽고 안전한 설치 줄을 선택한다 — sudo는 사람에게 넘긴다')
  .requiredOption('--smoke <cmd>', '설치 후 PTY에서 실행할 확인 명령')
  .option('--pty <ref>', '설치할 셸 PTY 참조')
  .option('--dry-run', '문서와 후보 줄만 읽고 설치하지 않음')
  .option('--json', 'JSON 출력')
  .action(async (tool: string, opts: { smoke: string; pty?: string; dryRun?: boolean; json?: boolean }) => {
    if (!opts.dryRun && !opts.pty) {
      console.error('install-from-docs: --pty required unless --dry-run');
      process.exitCode = 2;
      return;
    }
    const { installFromDocs } = await import('./agent-mission/doc-guided-install.js');
    const result = await installFromDocs({ tool, smoke: opts.smoke, ptyRef: opts.pty, dryRun: opts.dryRun });
    if (opts.json) await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
    else console.log(`Outcome: ${result.outcome}\nSource: ${result.url ?? 'none'}\nCandidates: ${result.candidates.join(' · ') || 'none'}\nChosen: ${result.line ?? 'none'}\nReason: ${result.reason}\nDecisions: ${result.decisions.map((d) => `${d.kind}: ${d.what} (${d.reason})`).join(' → ')}`);
    if (result.outcome === 'failed') process.exitCode = 1;
    else if (result.outcome === 'escalate') process.exitCode = 2;
  });

// CLI dispatch: Commander agentCmd browser-login → loginViaBrowser (no card sent here).
agentCmd.command('browser-login')
  .requiredOption('--pty <ref>', 'existing PTY reference')
  .requiredOption('--provider <name>', 'codex or claude')
  .option('--dry-run', 'inspect PTY without changing browser or PTY')
  .description('Approve a CLI login using a pre-authenticated local browser session')
  .action(async (opts: { pty: string; provider: string; dryRun?: boolean }) => {
    if (opts.provider !== 'codex' && opts.provider !== 'claude') {
      console.error('browser-login: --provider must be codex or claude');
      process.exitCode = 2;
      return;
    }
    const { loginViaBrowser } = await import('./agent-mission/browser-login.js');
    const result = await loginViaBrowser(opts.pty, opts.provider, opts.dryRun ? {
      connect: async () => { throw new Error('dry-run'); },
      profileExists: () => false,
    } : {});
    await writeStdoutJson(JSON.stringify(result) + '\n');
    if (result.outcome === 'ask-human') process.exitCode = 1;
  });

// A separate visible Chrome login seeds the persistent profile without debugging flags.
const browserProfileCmd = program.commands.find(command => command.name() === 'browser')!.command('profile').description('Browser profile management');
browserProfileCmd.command('login').description('Open visible Chrome to sign in once')
  .action(async () => {
    const { launchBrowserProfileLogin } = await import('./agent-mission/browser-login.js');
    if (!launchBrowserProfileLogin()) { console.error('Chrome binary not found'); process.exitCode = 1; }
  });
browserProfileCmd.command('status').description('Show only profile directory existence and last use')
  .action(async () => {
    const { browserProfileStatus } = await import('./agent-mission/browser-login.js');
    await writeStdoutJson(JSON.stringify(browserProfileStatus()) + '\n');
  });

agentCmd.command('plan <mission>')
  .description('환경을 감지해 도구 사다리 시작 칸 표시 (설치·미션 실행 없음)')
  .option('--json', 'JSON 출력')
  .action(async (mission: string, opts: { json?: boolean }) => {
    const { collectEnvProfile } = await import('./agent-mission/env-profile.js');
    const { chooseRung } = await import('./agent-mission/tool-ladder.js');
    const profile = collectEnvProfile();
    const choice = chooseRung(mission, profile);
    if (opts.json) await writeStdoutJson(JSON.stringify({ mission, profile, ...choice }) + '\n');
    else console.log([
      `Mission: ${mission}`,
      `Starting rung: ${choice.rung} · tool: ${choice.tool ?? 'Elanous'}`,
      `Why: ${choice.reason}`,
      `Missing tool (not installed): ${choice.install.join(', ') || 'none'}`,
    ].join('\n'));
  });

// ★ elanous→codex PTY RFC 미션 (ROADMAP 3차 역전) — codex --yolo 를 PTY 로 열어
// worktree 에서 미션을 자율 완주(구독 모드·브레인=elanous LLM·omni-crawl 폴백·증거 게이트).
agentCmd
  .command('mission [text...]')
  .alias('run')
  .description(`★ 선택 backend(디폴트 ${agentBackendHelpNames[0]} --yolo·--backend 로 ${agentBackendHelpNames.slice(1).join('/')})를 PTY 로 열어 worktree 에서 미션을 RFC(입력→결과→재입력)로 자율 완주. 구독 모드·omni-crawl 폴백·증거 게이트(doc|tsc|test). 원문은 verbatim(외부 재해석 금지)·elanous 내부에서 가산 인핸싱(기본 on·anti-drift). 관측=elanous logs --category agent-mission`)

  .option('--mission-file <path>', '★ verbatim 진입 — 원문을 파일에서 정확한 바이트로 읽음(줄바꿈 보존). 외부 에이전트는 원문을 이 파일로 넘겨 재해석 없이 전달(<text...> 대신)')
  .option('--no-enhance', 'elanous 내부 인핸싱 끄기(순수 verbatim 전송)')
  .option('--deliverable <hint>', '인핸싱 산출물 유형 힌트(예: "PPT 발표덱")')
  .requiredOption('--branch <name>', '새 worktree 브랜치명')
  .option('--base <branch>', '분기 base (기본 HEAD · 이전 미션 산출 위에 쌓으려면 그 브랜치)')
  .option('--evidence <mode>', 'doc|tsc|test (기본 tsc)', 'tsc')
  .option('--doc-dir <rel>', 'doc 모드: 문서 디렉토리 (기본 docs/plans)', 'docs/plans')
  .option('--doc-glob <re>', 'doc 모드: 파일명 정규식 (기본 ^PLAN-.*\\.md$)')
  .option('--test-path <p>', 'test 모드: bun test 대상 경로')
  .option('--file <rel>', 'test 모드: 존재 확인할 산출 파일(rel)')
  .option('--max-rounds <n>', 'RFC 최대 라운드 (기본 16)', '16')
  .option('--no-commit', '완료 시 자동 commit 생략')
  .option('--screens <dir>', '스크린 캡처 디렉토리')
  .option('--backend <id>', `외부 에이전트 backend (${agentBackendHelpList}). 각 CLI auto-approve 모드로 PTY 구동. 미등록 지정 시 명시 에러(조용한 codex 폴백 없음·애그노스틱)`)
  .option('--chain <backends>', '한 미션의 backend 사슬 (예: codex,claude,elanous)')
  .option('--plugin <name@market>', '에이전트 화면 안에서 플러그인을 설치하고 그 스킬로 미션 실행 (codex/claude)')
  .addOption(new Option('--resources <mode>', '미션 전 자원 판단 사다리 (on|off, 기본 on)').choices(['on', 'off']).default('on'))
  .option('--headless', 'Claude 구독 CLI를 비대화형 stream-json 모드로 실행 (claude backend 전용)')
  .action(async (textParts: string[], opts: Record<string, any>) => {
    // 구독 모드 보장 — 브레인(streamLLM)·codex 둘 다 ChatGPT 구독으로 (API 과금 회피).
    delete process.env.OPENAI_API_KEY;
    // logs.db 싱크·레거시 alias 관측은 agentCmd preAction 훅에서 중앙 배선(위).
    // ★ U4b — 액션 글루(backend 검증·mission-file/text·evidence·spec 빌드·통일 진입점 실행)는
    //   runAgentMissionCliCommand(테스트 가능 seam)로 추출. 액션은 I/O(print/exit)만 담당.
    const { resolveBackend } = await import('./agent-mission/driver.js');
    const { runAgentMissionCliCommand } = await import('./agent-mission/mission-cli.js');
    const outcome = await runAgentMissionCliCommand(textParts, opts as import('./agent-mission/mission-cli.js').MissionCliOpts, { resolveBackend });
    if (!outcome.ok) { console.error(`❌ ${outcome.message}`); process.exit(outcome.exitCode); }
    await writeStdoutJson(JSON.stringify(outcome.result, null, 2) + '\n');
    process.exit(outcome.exitCode);
  });

// ★ 리뷰 반응 완결 루프 (L1) — PR 리뷰(OK/보강/거절)를 트리거로 codex 가 자율 rework→재제출.
// ⭐ 옵션 정의·opts 조립은 `agent-mission/review-loop-cli.ts`(테스트 가능 seam) — 액션은 I/O 만 한다.
registerReviewLoopOptions(
  agentCmd
    .command('review-loop <pr>')
    .description('★ PR 리뷰(OK/보강/거절)를 읽어 반응 — 보강이면 에이전트(디폴트 codex)가 지적을 자율 반영(제1원칙 렌즈)+re-push, 거절이면 HITL 표면화. 관측=elanous logs --category review-loop'),
)
  .action(async (pr: string, opts: Record<string, any>) => {
    delete process.env.OPENAI_API_KEY; // 구독 모드
    // logs.db 싱크·레거시 alias 관측은 agentCmd preAction 훅에서 중앙 배선(위).
    const [{ runReviewLoop }, { reviewerContextArgs }] = await Promise.all([
      import('./agent-mission/review-loop.js'),
      import('./agent-substrate/self-review-cli.js'),
    ]);
    const contextOrder = reviewerContextArgs(process.argv.slice(2));
    const config = getUserConfig();
    const configuredJudgeBackend = config.acp.reviewBackend;
    const configuredReworkBackend = config.acp.reworkBackend;
    const configuredReviewDepth = config.autoReview?.depth;
    const built = buildReviewLoopOpts(opts as import('./agent-mission/review-loop-cli.js').ReviewLoopCliOpts, {
      ...(configuredJudgeBackend ? { configuredJudgeBackend } : {}),
      ...(configuredReworkBackend ? { configuredReworkBackend } : {}),
      ...(configuredReviewDepth ? { depthConfig: configuredReviewDepth } : {}), // 2계층 무게 임계
      ...(contextOrder.length > 0 ? { contextOrder } : {}),
    });
    if (!built.ok) { console.error(`❌ ${built.message}`); process.exit(1); }
    const r = await runReviewLoop(pr, built.opts);
    await writeStdoutJson(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.action === 'parked' || (r.action === 'reworked' && r.reworkOk === false) ? 2 : 0);
  });

export interface AutoInitialReviewerDeps {
  reviewPullRequest: (
    input: { prDiff: string; phaseIntent: string; acceptance?: string },
    llm: (prompt: string) => Promise<string>,
  ) => Promise<Pick<ReviewResult, 'verdict' | 'mustFix' | 'shouldFix' | 'reviewed' | 'diffBudget'>>;
  reviewDiffBudgetObservation: (review: Pick<ReviewResult, 'diffBudget'>) => object;
  mapReviewToInjected: (r: Pick<ReviewResult, 'verdict' | 'mustFix' | 'shouldFix' | 'reviewed'>) => { verdict: ReviewVerdict; asks: string[] };
  log: (category: string, event: string, data?: Record<string, unknown>) => void;
  execFileSync: (file: string, args: readonly string[], options: { encoding: 'utf8'; timeout: number; maxBuffer?: number }) => string;
  lookupPrGoalAcceptance: (prNumber: number) => { acceptance?: string; goalLoaded: boolean; acceptanceChars: number };
}

function parseAutoInitialReviewPrNumber(pr: string): number | undefined {
  const trimmed = pr.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** L3 auto-initial-review — PR 문자열을 정수로 바꿀 수 있을 때만 공용 골 조회 심을 태운다. */
export async function runAutoInitialReview(
  pr: string,
  acpLLM: (prompt: string) => Promise<string>,
  deps: AutoInitialReviewerDeps,
): Promise<{ verdict: ReviewVerdict; asks: string[] } | null> {
  let diff = '';
  try {
    diff = deps.execFileSync('gh', ['pr', 'diff', pr], { encoding: 'utf8', timeout: 25000, maxBuffer: 12 * 1024 * 1024 });
  } catch {
    return null;
  }
  if (!diff.trim()) return null;
  let intent = `PR ${pr}`;
  try {
    intent = deps.execFileSync('gh', ['pr', 'view', pr, '--json', 'title', '-q', '.title'], { encoding: 'utf8', timeout: 15000 }).trim() || intent;
  } catch { /* noop */ }

  let goalAcceptance: { acceptance?: string; goalLoaded: boolean; acceptanceChars: number } = {
    goalLoaded: false,
    acceptanceChars: 0,
  };
  const prNumber = parseAutoInitialReviewPrNumber(pr);
  if (prNumber !== undefined) {
    try {
      goalAcceptance = deps.lookupPrGoalAcceptance(prNumber);
    } catch {
      goalAcceptance = { goalLoaded: false, acceptanceChars: 0 };
    }
  }

  const rr = await deps.reviewPullRequest({
    prDiff: diff,
    phaseIntent: intent,
    ...(goalAcceptance.acceptance ? { acceptance: goalAcceptance.acceptance } : {}),
  }, acpLLM);
  deps.log('review-watch', 'review.done', {
    pr, source: 'auto-initial-review', verdict: rr.verdict, reviewed: rr.reviewed ?? false,
    mustFix: rr.mustFix.length, shouldFix: rr.shouldFix.length,
    ...deps.reviewDiffBudgetObservation(rr),
    goalLoaded: goalAcceptance.goalLoaded,
    acceptanceChars: goalAcceptance.acceptanceChars,
  });
  if (!rr.reviewed) return null; // 1차 리뷰 실패(fail-soft) → 발동 안 함(오판 방지)
  return deps.mapReviewToInjected(rr);
}

/**
 * `review-stats` 사람용 출력은 안전한 수치 0과 표본 부재를 구별한다.
 * 퍼널과 같은 규율을 따르되, 해당 포매터를 옮기면 도메인 결합이 생기므로 이 렌더 경로에 둔다.
 * 두 사본은 한쪽만 고쳐질 수 있는 위험이 있지만, 이번 변경 범위를 렌더링으로 한정하기 위해 받아들인다.
 */
export function formatReviewStatsPercentage(rate: number, denominator: number): string {
  return denominator > 0 ? `${(rate * 100).toFixed(0)}%` : '미측정';
}

agentCmd
  .command('review-stats')
  .description('★ G9 학습루프 — 무인 리뷰 결정 결과 통계(무게별 회귀율) + 무게 경계 보정 제안. 관측=elanous logs --category review-loop')
  .option('--json', '구조화 출력')
  .action(async (opts: Record<string, any>) => {
    const { openReviewOutcomeDb, queryReviewStats, detectFollowups } = await import('./agent-mission/review-outcomes.js');
    const db = openReviewOutcomeDb();
    // ★ FU 감지 최신화 — 무인 머지 후 같은 파일 수정 PR 이 나왔으면 followup-fixed 로 갱신(회귀율 정확도↑).
    let fuNote = '';
    try {
      const { execFileSync } = await import('node:child_process');
      const ghRun = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
      const fus = detectFollowups(db, { gh: ghRun, now: new Date().toISOString() });
      if (fus.length > 0) fuNote = `  (FU 감지: ${fus.length}건 followup-fixed 갱신 — #${fus.join(', #')})`;
    } catch { /* fail-soft — gh 실패 시 기존 데이터로 통계 */ }
    const s = queryReviewStats(db);
    db.close();
    if (opts.json === true) { await writeStdoutJson(JSON.stringify(s, null, 2) + '\n'); return; }
    const lightN = s.light.merged + s.light.bad;
    const heavyN = s.heavy.merged + s.heavy.bad;
    console.log(`[review-stats · G9 학습루프] 무인 리뷰 결정 결과 (총 ${s.total}건)`);
    if (fuNote) console.log(fuNote);
    console.log(`  light(1차+tsc): 머지 ${s.light.merged} · 회귀 ${s.light.bad} · 회귀율 ${formatReviewStatsPercentage(s.light.regressionRate, lightN)}`);
    console.log(`  heavy(2차 심판): 머지 ${s.heavy.merged} · 회귀 ${s.heavy.bad} · 회귀율 ${formatReviewStatsPercentage(s.heavy.regressionRate, heavyN)}`);
    // 보정 제안 — 위험 방향은 HITL(제안만), 안전 방향은 review-loop 이 자동 승격.
    const suggestions: string[] = [];
    if (lightN >= 5 && s.light.regressionRate > 0.3) suggestions.push(`⚠️ light 회귀율 높음(${formatReviewStatsPercentage(s.light.regressionRate, lightN)}) — 무게 임계를 낮춰 더 많이 heavy 로(config autoReview.depth.maxLightFiles/Lines↓). review-loop 이 이미 안전 방향 자동 승격 중.`);
    if (heavyN >= 5 && s.heavy.regressionRate > 0.2) suggestions.push(`⚠️ heavy(2차 심판)도 회귀(${formatReviewStatsPercentage(s.heavy.regressionRate, heavyN)}) — 심판/게이트 근본 검토 필요(대표 결정).`);
    if (lightN >= 10 && s.light.regressionRate < 0.05) suggestions.push(`💡 light 회귀 거의 없음(${formatReviewStatsPercentage(s.light.regressionRate, lightN)}) — G8 자동부착(autoReview.mode=auto) 확대 검토 가능(대표 결정·위험 방향이라 HITL).`);
    if (suggestions.length === 0) console.log(`  제안: 없음(데이터 부족 또는 안정).`);
    else { console.log(`  보정 제안:`); for (const x of suggestions) console.log(`    - ${x}`); }
  });

agentCmd
  .command('review-watch')
  .description('★ L3 standing 폴러 — opt-in 라벨(auto-review) 붙은 열린 PR 을 주기 폴링, 새 사람 리뷰 감지 시 review-loop 무인 발동. 관측=elanous logs --category review-watch')
  .option('--label <name>', 'opt-in 감시 라벨 (기본 auto-review)', 'auto-review')
  .option('--once', '1사이클만 실행하고 종료 (기본: interval 폴링 루프)')
  .option('--interval <sec>', '폴링 주기 초 (기본 300)', '300')
  .option('--max-triggers <n>', '사이클당 최대 발동 건수 (기본 1·codex rate limit)', '1')
  .option('--final-judge', '발동 시 ACP Claude Code 독립 심판(L2)까지', false)
  .option('--auto-merge', '심판 merge 판정 시 자동 squash-merge (opt-in 라벨 PR 한정)', false)
  .option('--no-verify-merge', 'G10 안전봉투 해제 — 자율머지 후 통합 회귀검증(tsc→revert PR) 안 함 (기본: 검증 on)')
  .option('--judge-rounds <n>', '심판 rework 최대 라운드 (기본 3)', '3')
  .option('--rework-backend <id>', 'rework 에이전트 백엔드 (기본: 설정 acp.reworkBackend, 없으면 codex)')
  .option('--auto-initial-review', '자동 초기리뷰어(§2b) — 리뷰 없는 라벨 PR 에 1차 리뷰(ACP Opus) 발동(사람 0 파이프라인)', false)
  .option('--dry-run', '발동 대신 감지만 로그 (안전 시연·커서 갱신 안 함)', false)
  .option('--context <path>', 'review-loop 리뷰어에게 그대로 전달할 저장소 내부 참고 자료 경로(반복 가능)', (value: string, previous: string[] = []) => [...previous, value])
  .option('--context-text <text>', 'review-loop 리뷰어에게 그대로 전달할 인라인 참고 자료(반복 가능)', (value: string, previous: string[] = []) => [...previous, value])
  .action(async (opts: Record<string, any>) => {
    delete process.env.OPENAI_API_KEY; // 구독 모드
    // logs.db 싱크·레거시 alias 관측은 agentCmd preAction 훅에서 중앙 배선(위).
    const { debug: watchDebug } = await import('./debug/log.js');
    // ★ in-flight lock(G10 안전봉투·2026-07-23·[[ROADMAP-elanous-is-all §2b]]) — cron/수동으로 review-watch
    //   프로세스가 겹쳐 뜨면 각자 runReviewLoop(codex rework+ACP 심판·수분 소요)을 동시 발동 → codex 미션
    //   rate limit 충돌·중복 rework. 파일락+pid liveness(mission-run-lock 재사용·stale 자동청소)로
    //   single-flight 보장. dry-run 은 발동 안 하므로(읽기만) 제외. release=exit 훅 + --once finally.
    let releaseWatchLock: (() => void) | null = null;
    if (opts.dryRun !== true) {
      const { acquireRunLock, releaseRunLock } = await import('./autopilot/mission-run-lock.js');
      const { elanousStateRoot } = await import('./autopilot/state-paths.js');
      // 상태 경로는 안정 식별자로 codex-mission 유지(코드는 agent-mission 로 리네임했으나 기존 락/DB 고아화 방지).
      const lockOpts = { baseDir: _joinPath(elanousStateRoot(), 'codex-mission', 'locks') };
      if (!acquireRunLock('review-watch', lockOpts)) {
        console.log('[review-watch] 이전 폴러가 진행 중 — skip (in-flight lock)');
        watchDebug.log('review-watch', 'lock-held', {});
        process.exit(0);
      }
      watchDebug.log('review-watch', 'lock-acquired', { pid: process.pid });
      releaseWatchLock = () => releaseRunLock('review-watch', lockOpts);
      process.once('exit', releaseWatchLock);
    }
    const [{ runPrReviewWatchCycle }, { reviewerContextArgs }] = await Promise.all([
      import('./agent-mission/pr-review-watch.js'),
      import('./agent-substrate/self-review-cli.js'),
    ]);
    const contextOrder = reviewerContextArgs(process.argv.slice(2));
    // ⛔ 한 사이클의 config는 이 스냅샷 하나만 쓴다 — judge·rework·depth가 같은 시점 값을 본다.
    const config = getUserConfig();
    const configuredJudgeBackend = config.acp.reviewBackend;
    const configuredReworkBackend = config.acp.reworkBackend;
    const configuredReviewDepth = config.autoReview?.depth;
    const reviewLoopOpts = {
      finalJudge: opts.finalJudge === true,
      autoMerge: opts.autoMerge === true,
      verifyMerge: opts.verifyMerge !== false, // G10 안전봉투 기본 on(--no-verify-merge 로 해제)
      judgeRounds: parseInt(opts.judgeRounds, 10),
      // ⛔ 같은 스냅샷을 다시 읽지 않는다 — 두 번 읽으면 사이에 config 가 바뀌었을 때 «한 사이클 안에서»
      //   서로 다른 값이 쓰인다(리뷰 should-fix · 2026-08-06).
      ...(configuredJudgeBackend ? { configuredJudgeBackend } : {}),
      ...(opts.reworkBackend ? { reworkBackend: opts.reworkBackend as string } : {}),
      ...(configuredReworkBackend ? { configuredReworkBackend } : {}),
      // 2계층 리뷰 무게 임계(config autoReview.depth) — heavy→2차 심판 강제.
      ...(configuredReviewDepth ? { depthConfig: configuredReviewDepth } : {}),
      ...(contextOrder.length > 0 ? { contextOrder } : {}),
    };
    // ★ 자동 초기리뷰어(§2b) — 리뷰 없는 라벨 PR 에 선택한 ACP 백엔드의 기본 모델로 1차 리뷰를 발동해
    //   injectedReview 로 review-loop 을 시작(사람이 첫 리뷰조차 안 함=사람 0). dry-run 이면 구성 안 함.
    let initialReviewer: ((pr: string) => Promise<{ verdict: import('./agent-mission/review-loop.js').ReviewVerdict; asks: string[] } | null>) | undefined;
    if (opts.autoInitialReview === true && opts.dryRun !== true) {
      const { reviewDiffBudgetObservation, reviewPullRequest } = await import('./agent-substrate/pr-reviewer.js');
      const { makeAcpReviewLLM } = await import('./agent-substrate/acp-reviewer.js');
      const { mapReviewToInjected } = await import('./agent-mission/pr-review-watch.js');
      const { execFileSync } = await import('node:child_process');
      const { lookupPrGoalAcceptance } = await import('./self-implement/run-ledger.js');
      const acpLLM = makeAcpReviewLLM({ cwd: process.cwd(), backend: configuredJudgeBackend ?? DEFAULT_REVIEW_BACKEND });
      initialReviewer = async (pr: string) => runAutoInitialReview(pr, acpLLM, {
        reviewPullRequest,
        reviewDiffBudgetObservation,
        mapReviewToInjected,
        log: (category, event, data) => watchDebug.log(category, event, data),
        execFileSync,
        lookupPrGoalAcceptance,
      });
    }
    const base = {
      label: opts.label as string,
      maxTriggers: parseInt(opts.maxTriggers, 10),
      reviewLoopOpts,
      ...(opts.autoInitialReview === true && initialReviewer ? { autoInitialReview: true, initialReviewer } : {}),
      // dry-run: 발동 대신 감지 로그만(커서 미갱신 위해 db 없이 no-op trigger 를 쓰되, 여기선 감지 관측이 목적).
      ...(opts.dryRun === true
        ? { trigger: async (pr: string) => { console.log(`[dry-run] 발동 대상 PR #${pr}`); return null; } }
        : {}),
    };
    const runCycle = async (): Promise<void | { error: import('./agent-mission/pr-review-watch.js').ReviewWatchGhErrorKind }> => {
      try {
        const out = await runPrReviewWatchCycle(base);
        const triggered = out.filter(o => o.status === 'triggered').length;
        console.log(`[review-watch] label=${opts.label} scanned=${out.length} triggered=${triggered}${opts.dryRun ? ' (dry-run)' : ''}`);
        for (const o of out) if (o.status === 'triggered') console.log(`  → #${o.pr}: ${o.result?.action ?? 'error'}`);
      } catch (e) {
        const { ReviewWatchGhError } = await import('./agent-mission/pr-review-watch.js');
        if (!(e instanceof ReviewWatchGhError)) throw e;
        const guidance = {
          auth: 'gh auth login 으로 GitHub 인증을 확인하세요.',
          'not-found': 'gh repo view 로 저장소 접근 권한과 현재 디렉터리를 확인하세요.',
          'missing-binary': 'gh CLI 설치와 PATH 를 확인하세요.',
          other: 'gh pr list 와 네트워크 상태를 확인하세요.',
        }[e.kind];
        console.error(`[review-watch] 목록 조회 실패 (${e.kind}): ${guidance}`);
        return { error: e.kind };
      }
    };
    if (opts.once === true) {
      let result: Awaited<ReturnType<typeof runCycle>>;
      try { result = await runCycle(); } finally { releaseWatchLock?.(); }
      process.exit(result ? 1 : 0);
    }
    // interval 폴링 루프 (standing). Ctrl-C 로 종료. 운영 cron 배선은 대표 몫. lock=exit 훅으로 해제.
    const intervalMs = parseInt(opts.interval, 10) * 1000;
    console.log(`[review-watch] standing 폴링 시작 — ${opts.interval}s 주기 (Ctrl-C 종료)`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await runCycle(); } catch (e) { console.error(`[review-watch] 사이클 오류: ${(e as Error).message}`); }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  });

agentCmd
  .command('setup')
  .description('One command: OAuth / API-key auth + model picker + save config')
  .action(async () => {
    const io = realIO();
    try {
      await runCodexSetup({ io });
    } catch (err: any) {
      ui.error(`codex setup failed: ${err?.message ?? err}`);
      process.exit(1);
    }
    // runCodexSetup closes the readline interface in its finally, but
    // Bun can still keep the loop alive on background fetch timers.
    // A hard exit is the same pattern the dashboard uses after the
    // TUI tears down.
    process.exit(0);
  });

agentCmd
  .command('models')
  .description('Print the curated Codex model catalog')
  .action(() => {
    ui.header('Codex model catalog');
    console.log('');
    console.log(renderAllModels());
    console.log('');
    console.log('Run `elanous agent-mission setup` to pick one. Any id from the OpenAI /v1/models');
    console.log('list works — type "Custom" at the picker and paste a model id.');
  });

// PLAN-codex-app-server-hermes-parity §5 Phase H3·3 (2026-05-16) —
// write a managed `[mcp_servers.elanous-tools]` block into
// `~/.codex/config.toml` so codex spawns `elanous mcp serve` and gets
// the 5 elanous_* tools (skills_list / obsidian_search / obsidian_info /
// fs_list / fs_read · H1·5a-e). User content outside the markers is
// byte-equivalent preserved.
agentCmd
  .command('config-migrate')
  .description(
    'Write/refresh the managed [mcp_servers.elanous-tools] block in ~/.codex/config.toml. Idempotent · creates a .bak snapshot · `--remove` strips the block.',
  )
  .option('--remove', 'Strip the managed monad-agent section instead of writing it')
  .option('--dry-run', 'Print the regenerated file to stdout without writing')
  .action(async (opts?: { remove?: boolean; dryRun?: boolean }) => {
    const { migrateCodexConfig } = await import('./codex-config/migrate.js');
    if (opts?.dryRun) {
      // dry-run skips backup + write. We render the same content via a
      // tmp path the real fs never sees, then print + bail.
      const res = await migrateCodexConfig({
        ...(opts?.remove ? { remove: true } : {}),
        skipBackup: true,
        configPath: '/dev/null-elanous-dry-run',
      });
      console.log(res.content);
      return;
    }
    try {
      const res = await migrateCodexConfig({
        ...(opts?.remove ? { remove: true } : {}),
      });
      ui.header(`codex config-migrate (${res.action})`);
      console.log(`  config:  ${res.configPath}`);
      if (res.backupPath) console.log(`  backup:  ${res.backupPath}`);
      if (res.action === 'no-op') {
        console.log('  nothing changed.');
      } else {
        console.log('  done. Restart codex to pick up the new MCP server.');
      }
    } catch (err) {
      ui.error(`codex config-migrate failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ── dev (U4 실험) — 통합 self-dev 진입점 runDevPipeline(spec) ──
//   경로(self/plan-staged/external+pty/acp)별 지원 옵션만 배선하고 나머지는 NotYetUnified 로 명시 거부한다.
//   기존 명령(chat·self implement·self orchestrate·agent-mission)은 무접촉 — 이 엔트리는 통일 계약의 도그푸드 창구.
let devRunPipelineForTesting: typeof import('./self-dev/dev-pipeline.js')['runDevPipeline'] | undefined;
let devExecuteSelfRunForTesting: typeof import('./self-dev/dev-cli.js')['executeDevSelfRun'] | undefined;
let startDraftTriageOptionsForTesting: RunDevAskStartDraftTriageOptions | undefined;
let devAskLaunchFlowForTesting: typeof import('./self-dev/ask-launch-flow.js')['runAskLaunchFlow'] | undefined;
let startHoldOwnerPollerForTesting: (() => void) | undefined;
let waitForHoldOwnerForTesting: (() => Promise<void>) | undefined;
let holdOwnerChildAliveForTesting: (() => { readonly alive: boolean; readonly exitCode: number | null }) | undefined;
let holdOwnerWatchMsForTesting: number | undefined;
let holdOwnerWatchTimeoutMsForTesting: number | undefined;

const HOLD_OWNER_WATCH_MS = 100;

function resolveHoldOwnerWatchTimeout(): { readonly timeoutMs: number | null; readonly source: 'test-seam' | 'env' | 'none' } {
  if (holdOwnerWatchTimeoutMsForTesting !== undefined) {
    return { timeoutMs: holdOwnerWatchTimeoutMsForTesting, source: 'test-seam' };
  }
  const configured = process.env.ELANOUS_HOLD_OWNER_TIMEOUT_MS;
  if (configured !== undefined && /^\d+$/.test(configured)) {
    const timeoutMs = Number(configured);
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) return { timeoutMs, source: 'env' };
  }
  return { timeoutMs: null, source: 'none' };
}

export async function waitForHoldOwnerChild(ptyId: string): Promise<number | null> {
  const watchMs = holdOwnerWatchMsForTesting ?? HOLD_OWNER_WATCH_MS;
  const { timeoutMs, source } = resolveHoldOwnerWatchTimeout();
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  debug.log('dev-pipeline', 'hold-owner-watch-start', { ptyId, timeoutMs, source });
  while (true) {
    const observed = holdOwnerChildAliveForTesting
      ? holdOwnerChildAliveForTesting()
      : await (async () => {
        const { getPty } = await import('./pty-shell/registry.js');
        const pty = getPty(ptyId);
        return { alive: pty?.isAlive() === true, exitCode: pty?.exitCode ?? null };
      })();
    if (!observed.alive) {
      debug.log('dev-pipeline', 'hold-owner-child-died', { ptyId, exitCode: observed.exitCode });
      return observed.exitCode;
    }
    if (deadline !== null && Date.now() >= deadline) {
      debug.log('dev-pipeline', 'hold-owner-watch-timeout', { ptyId, timeoutMs });
      return null;
    }
    const sleepMs = deadline === null ? watchMs : Math.min(watchMs, deadline - Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
}

export function setDevLaunchControlTestSeams(seams: {
  readonly runDevPipeline?: typeof import('./self-dev/dev-pipeline.js')['runDevPipeline'];
  readonly executeDevSelfRun?: typeof import('./self-dev/dev-cli.js')['executeDevSelfRun'];
  readonly startDraftTriageOptions?: RunDevAskStartDraftTriageOptions;
  readonly runAskLaunchFlow?: typeof import('./self-dev/ask-launch-flow.js')['runAskLaunchFlow'];
  readonly startHoldOwnerPoller?: () => void;
  readonly waitForHoldOwner?: () => Promise<void>;
  readonly holdOwnerChildAlive?: () => { readonly alive: boolean; readonly exitCode: number | null };
  readonly holdOwnerWatchMs?: number;
  readonly holdOwnerWatchTimeoutMs?: number;
} | undefined): void {
  devRunPipelineForTesting = seams?.runDevPipeline;
  devExecuteSelfRunForTesting = seams?.executeDevSelfRun;
  startDraftTriageOptionsForTesting = seams?.startDraftTriageOptions;
  devAskLaunchFlowForTesting = seams?.runAskLaunchFlow;
  startHoldOwnerPollerForTesting = seams?.startHoldOwnerPoller;
  waitForHoldOwnerForTesting = seams?.waitForHoldOwner;
  holdOwnerChildAliveForTesting = seams?.holdOwnerChildAlive;
  holdOwnerWatchMsForTesting = seams?.holdOwnerWatchMs;
  holdOwnerWatchTimeoutMsForTesting = seams?.holdOwnerWatchTimeoutMs;
}

const RETIRED_DEV_OPTION_DEFAULTS = {
  '--open-pr': 'PR 개설 활성',
  '--auto-merge': '리뷰 clean 시 자동 병합 활성',
  '--auto-review': 'auto-review 활성',
  '--enhance': '입구 정책이 인핸싱 여부 결정',
  '--no-enhance': '입구 정책이 인핸싱 여부 결정',
  '--ground': 'codebase grounding 비활성',
  '--activity-grace': '240초',
  '--supervise-rounds': '3 라운드',
  '--live-run-window': '30분',
  '--recent-change-window': '7일',
  '--no-launch-decomposition': '발사 전 분해 활성',
  '--max-wait': '시스템 대기 상한',
  '--cols': '160',
  '--rows': '40',
} as const;

function retiredDevOptionNotice(error: string): string | undefined {
  const option = Object.keys(RETIRED_DEV_OPTION_DEFAULTS).find((name) => error.includes(`unknown option '${name}'`)) as keyof typeof RETIRED_DEV_OPTION_DEFAULTS | undefined;
  return option ? `⚠️ ${option} 은퇴; 적용 기본값: ${RETIRED_DEV_OPTION_DEFAULTS[option]}.\n` : undefined;
}

// 은퇴 안내 줄 길이(표시)와 `--ask` 경로 거부(판정)는 다른 자. 표시는 한 줄로 읽히게만 자른다.
const DEV_HARNESS_NOTICE_ARG_MAX = 400;
const POSIX_NAME_MAX_BYTES = 255;
// PATH_MAX 는 플랫폼 헤더 값(NUL 포함). 지원 플랫폼만 명시하고, 나머지는 보수적 1024.
// darwin: sys/syslimits.h=1024 · linux/android: 전형적으로 4096 ·
// freebsd/openbsd/netbsd/sunos/aix/haiku 등: 1024 (Linux 4096을 일반화하지 않는다).
const POSIX_PATH_MAX_BYTES_DARWIN = 1024;
const POSIX_PATH_MAX_BYTES_LINUX = 4096;
const POSIX_PATH_MAX_BYTES_CONSERVATIVE = 1024;
// NTFS 구성요소는 255 UTF-16 코드 유닛(WCHAR). Win32 유니코드 경로 상한은 32767 WCHAR.
const WIN32_NAME_MAX_UTF16 = 255;
const WIN32_PATH_MAX_UTF16 = 32767;

function posixPathMaxBytes(platform: typeof process.platform): number {
  switch (platform) {
    case 'linux':
    case 'android':
      return POSIX_PATH_MAX_BYTES_LINUX;
    case 'darwin':
      return POSIX_PATH_MAX_BYTES_DARWIN;
    case 'freebsd':
    case 'openbsd':
    case 'netbsd':
    case 'sunos':
    case 'aix':
    case 'haiku':
      return POSIX_PATH_MAX_BYTES_CONSERVATIVE;
    default:
      return POSIX_PATH_MAX_BYTES_CONSERVATIVE;
  }
}

// 플랫폼에 맞는 단위·한계로 「경로로 쓰기엔 명백히 긴」 값을 판정한다.
// Windows = UTF-16 코드 유닛(JS string.length) · POSIX = UTF-8 바이트.
// 예: `😀`.repeat(100) 은 UTF-8 400바이트라 POSIX NAME_MAX 초과지만, UTF-16 200이라 NTFS 구성요소로 유효하다.
export function isObviouslyLongAskPath(
  value: string,
  platform: typeof process.platform = process.platform,
): boolean {
  if (platform === 'win32') {
    if (value.length >= WIN32_PATH_MAX_UTF16) return true;
    for (const part of value.split(/[/\\]/)) {
      if (part !== '' && part.length > WIN32_NAME_MAX_UTF16) return true;
    }
    return false;
  }
  if (Buffer.byteLength(value, 'utf8') >= posixPathMaxBytes(platform)) return true;
  // POSIX 파일명에 `\` 는 유효 문자다. Windows 만 `\` 도 구분자로 본다.
  for (const part of value.split('/')) {
    if (part !== '' && Buffer.byteLength(part, 'utf8') > POSIX_NAME_MAX_BYTES) return true;
  }
  return false;
}

function slicePreservingCodePoints(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return '';
  if (value.length <= maxCodeUnits) return value;
  let end = 0;
  for (const ch of value) {
    const next = end + ch.length;
    if (next > maxCodeUnits) break;
    end = next;
  }
  return value.slice(0, end);
}

function escapeDevHarnessDisplayChars(value: string): string {
  // 줄바꿈·구분자 먼저 가시화한 뒤, 남은 C0/DEL 은 \xNN · C1 은 \u{...} 로 남긴다.
  // VT/FF/ESC/ANSI 가 은퇴 안내에서 커서를 옮기거나 화면을 지우지 못하게 한다.
  const newlineNormalized = value
    .replaceAll('\r\n', '\\n')
    .replaceAll('\r', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  let out = '';
  for (const ch of newlineNormalized) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      out += `\\x${cp.toString(16).padStart(2, '0')}`;
    } else if (cp >= 0x80 && cp <= 0x9f) {
      out += `\\u{${cp.toString(16)}}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function quoteDevHarnessArgument(value: string, opts?: { obviouslyLong?: boolean }): string {
  // 한 줄 표시: 제어문자를 가시적 escape 로 치환한 뒤, 자를 때는 코드 포인트 경계에서만 자른다.
  // UTF-16 인덱스로 자르면 😀 같은 값이 고립 surrogate → U+FFFD 가 된다.
  const singleLine = escapeDevHarnessDisplayChars(value);
  const shouldTruncate = Boolean(opts?.obviouslyLong) || singleLine.length > DEV_HARNESS_NOTICE_ARG_MAX;
  const cap = Math.min(DEV_HARNESS_NOTICE_ARG_MAX, Math.max(0, singleLine.length - 1));
  const truncated = shouldTruncate ? slicePreservingCodePoints(singleLine, cap) : singleLine;
  const display = shouldTruncate ? `${truncated}…` : truncated;
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(display) ? display : `'${display.replaceAll("'", "'\\''")}'`;
}

function devHarnessRetirementNotice(
  input: { kind: 'ask' | 'say' | 'file' | 'text'; value: string } | undefined,
  plan: boolean,
): string | undefined {
  const quoted = input
    ? quoteDevHarnessArgument(input.value, {
        obviouslyLong: input.kind === 'ask' && isObviouslyLongAskPath(input.value),
      })
    : '';
  const replacement = input?.kind === 'ask' || input?.kind === 'file'
    ? `elanous harness ask ${quoted}`
    : input?.kind === 'say'
      ? `elanous harness say ${quoted}`
      : plan && input?.kind === 'text'
        ? `${DEV_PLAN_REPLACEMENT} ${quoteDevHarnessArgument(input.value)}`
        : undefined;
  return replacement ? `⚠️ 이 dev 골-구동 문은 은퇴 예정입니다; 대응 문: ${replacement}\n` : undefined;
}

const selfDevCmd = program
  .command('dev [text...]')
  .alias('drive')
  // ⛔⭐⭐ 아래 첫 줄(별칭 계약)은 **거짓 도움말을 없애는 자리**다(2026-08-03 · `[S]` 제보 `OBS-S26`).
  //   `dev` 와 `drive` 는 **한 Commander 명령의 두 이름**이라 도움말이 하나뿐인데, 계약은 이름마다
  //   갈린다(`drive` 는 다섯 옵션만 · `assertDriveAliasOptions`). 그래서 아래 옵션 목록 전체가
  //   `drive --help` 에도 그대로 보이고 자식이 그것을 계약으로 읽는다.
  //   ⇒ 별칭을 없애지 않는다([[RFC-two-command-convergence-dev-and-pty-2026-07-28]] §6-2 = 층이 다르니
  //     `drive` 는 프리미티브로 **유지**한다) — 대신 **도움말이 그 갈림을 먼저 말하게** 한다.
  .description('⛔ `drive` 별칭으로 부르면 옵션은 여덟뿐 (--goal · --attach · --max-steps · --poll-ms · --model · --cwd · --worktree · --json) — `--attach <ref>` 는 이미 있는 PTY 를 몬다(생략하면 셸 명령을 새로 띄운다). 나머지는 전부 `dev` 전용이고 `drive` 에서는 거부된다. dev 와 drive 는 한 명령이라 이 도움말을 공유하므로, 아래 목록은 `dev` 기준이다. ⚠️ 실험 — 통합 self-dev 파이프라인 runDevPipeline. --backend self(디폴트·elanous-chat 자체구현)|codex/claude/gemini/grok(외부). --transport pty(디폴트·worktree·--branch 필수)|acp(cwd 세션·U6·capability 미검증). 미배선 조합은 NotYetUnified 명시 거부. ★self 는 무인 완결이 기본(PR 개설→auto-review 라벨→리뷰 clean 시 병합) — 끄려면 --no-open-pr/--no-auto-review/--no-auto-merge. 관측=elanous logs --category dev-pipeline · 상세=docs/manual/MANUAL-frontdoor-selfdev-dogfood-mechanism-2026-07-25.md')
  .option('--file <path>', 'input 파일(verbatim 바이트·<text...> 대신)')
  // ⭐ 대표 2026-08-11 — 발사 절차 «넷»을 한 명령으로. ask 파일을 주면 ⑴저작 → ⑵열린 PR ⊕ ⑶도는 런 검사 → ⑷발사.
  //   ⛔ 걸리면 «이름을 대며» 멈춘다(조용히 진행하지 않는다). 우회는 --force-preflight 이고 그 사실이 관측에 남는다.
  .option('--ask <path>', 'ask 파일로 골을 저작하고, 발사 전 전제 검사(열린 PR·도는 런)를 통과하면 그대로 발사한다')
  .addOption(new Option('--substrate <kind>', 'dev --ask 실행 칸 — local(기본) | pod').choices(['local', 'pod']))
  .option('--pod-pool <spec>', 'dev --ask Pod 풀 — 인자 > ELANOUS_POD_POOL > harness.podPool > 기존 pod.pool > 현재 컨텍스트')
  .option('--say <text>', '문장으로 골을 저작하고 --ask와 같은 전제 검사·발사 경로를 탄다')
  .option('--force-preflight', '--ask/--say 전제 검사에서 막혀도 발사한다(우회 사실을 관측에 남긴다)')
  .option('--allow-no-evidence', 'file 골의 REQUIRED EVIDENCE 태그 0개 사전 거부를 명시적으로 우회(관측 기록)')
  .option('--allow-superseded-goal', 'file 골의 Superseded-By 사전 거부를 명시적으로 우회(관측 기록)')
  .option('--allow-goal-lint-errors', 'file 골의 goal lint ERROR 사전 거부를 명시적으로 우회(관측 기록)')
  .addOption(new Option('--backend <id>', 'self(디폴트·자체구현)|codex|claude|gemini|grok(외부 PTY)').choices(['self', 'codex', 'claude', 'gemini', 'grok']).default('self'))
  .addOption(new Option('--transport <t>', 'external backend 구동 방식(pty 디폴트·acp=JSON-RPC 세션·cwd 실행·U6·capability 미검증)').choices(['pty', 'acp']).default('pty'))
  .option('--branch <name>', 'external+pty worktree 브랜치(외부 backend·pty 필수·acp 는 불요)')
  .option('--base <branch>', '분기 base')
  // ── T7: 재라우팅 경로별 핵심 옵션 노출(통합 도그푸드) ──
  .option('--plan', formatDevPlanOptionHelp(DEV_PLAN_REPLACEMENT))
  .option('--implement', 'self: headless implementation chat turn(--new·--tools·--goal-loop·interactive dispatch)')
  .option('--elanous', 'self: 격리 bare elanous TUI child를 LLM 제어 루프로 목표까지 구동')
  .option('--hold', 'elanous: brain 없이 띄우고 elanous pty 로 밖에서 몬다(--elanous 전용·--goal과 동시 사용 불가)')
  .option('--ready-timeout-ms <ms>', 'elanous hold: PTY readiness 대기 상한(ms·양의 정수·기본 30000)')
  .option('-g, --goal <goal>', 'elanous 또는 셸 drive: child가 달성할 목표(--elanous 또는 <command> 또는 --attach와 함께)')
  .option('-n, --max-steps <n>', 'elanous 또는 셸 drive: 최대 제어 스텝(기본 30)')
  .option('-p, --poll-ms <ms>', 'elanous 또는 셸 drive: 제어 스텝 간 폴 간격(ms·0 허용·기본 800)')
  .option('--attach <ref>', 'drive: 이미 있는 PTY 를 몬다(생략하면 셸 명령을 새로 띄운다·pty auto 와 같은 루프)')
  .option('-m, --model <id>', 'elanous 또는 셸 drive: 제어 brain LLM 모델(기본 config)')
  .option('--observe-only', 'elanous: child boot부터 SelfImplement 호출을 기록만 한다')
  .option('--isolated-root <path>', 'elanous: child config/state 격리 루트(설정 실패 시 fail-closed)')
  .option('-d, --cwd <path>', 'elanous 또는 셸 drive: child 작업 디렉토리')
  .option('-w, --worktree', 'elanous 또는 셸 drive: harness 관문으로 새 child 작업 워크트리를 자동 생성(--cwd와 동시 사용 불가)')
  .addOption(new Option('--no-open-pr', 'self: PR 개설을 끄고 worktree-only로 종료(--auto-merge와 동시 사용 불가)').default(undefined))
  .addOption(new Option('--no-auto-merge', 'self: PR 생성 후 자동 병합을 끔').default(undefined))
  .addOption(new Option('--no-auto-review', 'self: auto-review 라벨을 붙이지 않음').default(undefined))
  .option('--no-draft', 'self: non-draft PR (기본 draft)')
  .option('--no-supervise', 'self: 런 슈퍼바이저를 «끈다» — 대표 2026-08-22 로 ***기본 ON***(완료 뒤 실패를 트리아지해 같은 goal을 재실행)')
  .option('--child-llm-provider <id>', 'self: 구현 자식 LLM provider(--child-llm-model과 함께)')
  .option('--child-llm-model <id>', 'self: 구현 자식 LLM model(--child-llm-provider와 함께)')
  .option('--child-llm-effort <level>', 'self: 구현 자식 추론 노력 minimal|low|medium|high|xhigh|max — 모델 상한을 넘으면 «거부»한다(--child-llm-provider와 함께)')
  .option('--correlation <id>', 'self: 요청과 런 기록을 조인하는 불투명 correlation ID')
  .option('--target <path>', 'self: harness가 작업할 레포 또는 디렉터리(self-mission 전용)')
  .option('--yes', 'self: git 아닌 프로젝트에 git init 및 첫 커밋을 만들도록 동의')
  .option('--context <path>', '내부 리뷰어가 함께 판단할 레포 상대 파일 경로(반복 가능)')
  .option('--context-text <text>', '내부 리뷰어가 함께 판단할 텍스트(반복 가능)')
  .option('--evidence <mode>', 'external+pty: tsc|doc|test (기본 tsc)')
  .option('--doc-dir <rel>', 'external+pty: evidence doc 디렉토리(기본 docs/plans)')
  .option('--doc-glob <re>', 'external+pty: evidence doc 파일 정규식')
  .option('--test-path <p>', 'external+pty: evidence test 대상 경로(--evidence test 필수)')
  .option('--max-rounds <n>', 'external+pty: 최대 라운드(기본 16)')
  .option('--no-commit', 'external+pty: 완료 시 자동 commit 생략')
  .option('--deliverable <hint>', 'external+pty: 산출물 유형 힌트')
  .option('--screens <dir>', 'external+pty: 스크린 캡처 디렉토리')
  .option('--json', 'hold 결과를 한 줄 JSON으로 · --hold 전용')
  // ⭐ 역할별 LLM — 「한 번 정하고 아래로는 인자로만」(RFC-role-scoped-llm-selection-2026-08-18 §4e).
  //   ⛔ 모르는 역할·provider·tier 는 «거부»한다 — 110차에 `--acp-backend` 가 조용히 무시돼
  //   API 로 새어 나간 것이 이 플래그가 fail-closed 인 이유다.
  .option(
    '--role-llm <role=provider[/tier]>',
    '⭐ 역할별 LLM (반복 가능 · implement|review|research|planning|audit|classify) 예: implement=grok/best · review=anthropic · planning=/best',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .configureOutput({
    writeErr: (error) => {
      process.stderr.write(error);
      const notice = retiredDevOptionNotice(error);
      if (notice) process.stderr.write(notice);
    },
  })
  .action(async (textParts: string[], opts: Record<string, any>, command: Command) => {
    // ★ B1 — ⛔⭐⭐⭐ 가드를 **액션의 «첫 문장»**으로 둔다 — 앞에 `await` 가 «하나도» 없다
    //   (무인 리뷰 must-fix 2회). 2차 판본은 `await import(...)` 로 가져왔는데, ***그 import 자신이
    //   첫 비동기 작업***이라 그것이 거부되면 여전히 가드 없이 끝났다. ⇒ 정적 import 로 올렸다.
    //   초판은 `registerStandaloneLogSink()` 와 동적 import 넷 «뒤»에 설치했다. 그 준비 단계가
    //   거부되면 완료 줄도, 가드 산출도, 종료 코드 보정도 «없이» 액션이 끝난다 —
    //   ***부모 경계가 자기 시작점을 못 덮는 형태였다.***
    //   ⚠️ 그래서 로거를 «지연 바인딩»한다: 여기서는 아직 `debug` 를 못 가져왔다.
    //   ⛔ 그리고 아직 없을 때 **logs.db 에는 못 남긴다** — 동적 import 를 «시도하지 않는다».
    //      (초판 주석은 *"산출 시점에 동적 import 를 시도한다"* 고 적었는데 **코드는 그러지 않았다** —
    //       무인 리뷰가 잡았다. ⛔ 주석이 코드를 거짓 서술하면 다음 사람이 없는 동작을 믿는다.)
    //      ⇒ 대신 **그 사실 자체를 stderr 로 말한다**(`R-GIT11` — 침묵하지 않는다).
    let devDebug: typeof import('./debug/log.js')['debug'] | undefined;
    const completionGuard = installDevCompletionGuard({
      on: (event, listener) => process.on(event, listener),
      getExitCode: () => typeof process.exitCode === 'number' ? process.exitCode : undefined,
      setExitCode: (code) => { process.exitCode = code; },
      writeStderr: (line) => process.stderr.write(line),
      // ⛔ `debug` 가 아직 없으면 «조용히 버리지 않고» 그 사실을 stderr 로 말한다(`R-GIT11`).
      log: (event, data) => {
        if (devDebug) devDebug.log('dev-pipeline', event, data, { level: 'error' });
        else process.stderr.write(`⚠️ [dev] 관측 sink 준비 전이라 logs.db 에 못 남긴다: ${event} ${JSON.stringify(data)}\n`);
      },
      flush: () => { devDebug?.flush(); },
    });
    // ⛔⭐⭐⭐ **테스트 전용 seam** — 「결론 없이 액션이 끝나는」 상황을 «강제»한다.
    //   왜 필요한가: 이 착지의 내용이 *"모든 종료 경로가 결론을 낸다"* 라서, **가드가 발화하는
    //   실물 경로가 CLI 에 «없다».** 그래서 배선을 «양성»으로 증명할 방법이 없었고, 회귀는
    //   「미결론 문구의 부재」만 보는 Goodhart 였다(무인 리뷰가 두 번 짚었다).
    //   ⇒ 이 seam 하나로 «가드를 지우면 실패하는» 회귀가 선다.
    //   ⚠️ 정확히 '1' 일 때만 · `return` 이라 `process.exit` 도 `conclude` 도 «안» 부른다
    //      ⇒ 이벤트 루프가 스스로 비고 `beforeExit` 가 뜬다 = 42차 사망의 정확한 형태.
    //   ⭐ 선례 = `src/git-fs/runner.ts` 의 `setGitCommandRunnerForTesting`(테스트용 주입 seam).
    if (process.env.ELANOUS_DEV_TEST_UNCONCLUDED_EXIT === '1') return;

    // ⭐ 여기부터가 「가드가 덮는 구간」이다 — 위로 올릴 것은 아무것도 없다.
    const invokedAsDrive = command.parent?.args[0] === 'drive';
    if (opts.json === true && opts.hold !== true && (opts.target === undefined || opts.backend !== 'self' || opts.elanous === true || opts.implement === true || opts.goal !== undefined || opts.plan === true || opts.ask !== undefined || opts.say !== undefined || opts.attach !== undefined)) {
      console.error('❌ --json은 --hold 전용입니다');
      completionGuard.conclude();
      process.exit(2);
    }
    const { establishExecutionOrigin } = await import('./agent/identity-env.js');
    establishExecutionOrigin();
    const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
    await registerStandaloneLogSink(DEV_PIPELINE_SINK_SURFACE);
    const { runDevPipeline, DevPipelineError } = await import('./self-dev/dev-pipeline.js');
    const { debug } = await import('./debug/log.js');
    devDebug = debug;
    const hasText = Array.isArray(textParts) && textParts.length > 0;
    // ⭐대표 「구독이 있으면 «항상» 구독」(2026-08-18 지시) — 발사 시점에 «한 번» 과금 경로를 좁힌다.
    //   ⛔ 구독이 «없으면» 아무것도 안 지운다(지우면 호출이 아예 못 간다) — 그 사실도 관측에 남는다.
    //   ⚠️ 여기서 말할 수 있는 것은 「API 키 경로를 막았다」까지다. 실제 청구는 이 축이 안 잰다.
    try {
      const { enforceSubscriptionFirst, observeSubscriptionEnforcement } = await import('./llm/subscription-first.js');
      const { getUserConfig: readConfig } = await import('./user-config.js');
      const enforcement = enforceSubscriptionFirst(readConfig().llm.provider);
      observeSubscriptionEnforcement(enforcement, 'dev');
      if (enforcement.enforced && enforcement.removed.length > 0) {
        console.error(`[llm] 구독 우선 — 과금 env ${enforcement.removed.join(', ')} 제거 (구독 확인: ${enforcement.source})`);
      }
    } catch (e) {
      // fail-open: 구독 강제가 실패해도 발사를 막지 않되 «침묵하지 않는다»(R-GIT11).
      console.error(`[llm] 구독 우선 적용 실패(무시하고 진행): ${(e as Error).message}`);
    }
    // self 는 transport-free 특수 갈래(§2b) — --transport 는 external 전용. self+비디폴트 transport 는 거부(silent-ignore 금지).
    if (!invokedAsDrive && opts.backend === 'self' && opts.transport && opts.transport !== 'pty') {
      console.error('❌ --transport 는 external backend 전용 — self 는 transport-free(§2b). --backend codex/claude/… 와 함께 쓰세요');
      completionGuard.conclude();
      process.exit(1);
    }
    const executor = opts.backend === 'self'
      ? { kind: 'self' as const }
      : { kind: 'external' as const, backend: opts.backend as 'codex' | 'claude' | 'gemini' | 'grok', transport: opts.transport as 'pty' | 'acp' };
    // ★ T7 — 옵션→spec 라우팅(plan/self?/mission?/completion/autoReview)은 테스트 가능 seam(buildDevCliSpec)으로.
    const { buildDevCliSpec } = await import('./self-dev/dev-cli.js');
    const { devResultOk } = await import('./self-dev/dev-pipeline.js');
    // ⭐ 실행 식별자 확정 — `elanous dev` 는 **가장 바깥 진입점**이라 여기서 runId·출처를 정하고 env 에 심어
    //   아래 전 계층(orchestrator·헤드리스 자식)이 같은 값을 상속하게 한다(`ensureRunIdentity` = mint-once).
    //   동시에 여러 dev 를 띄우면 각자 별개 프로세스라 서로 다른 runId 를 갖는다 = 조회에서 갈린다.
    //   ⚠️ 이 진입점은 1회성 CLI(끝나면 exit)라 env 를 심어도 dispatch 간 identity bleed 가 없다
    //      (장수 데몬 경로가 `resolveRunIdentity`(env 무변경)를 쓰는 것과 구분되는 이유).
    //   ⚠️ mint 는 **try 안**에서 한다(리뷰 should-fix) — 밖에 두면 mint 실패가 기존 dev 오류 처리·관측을
    //      통째로 우회해 스택만 뱉고 죽는다. 안에 두면 아래 catch 가 받아 **`rejected|error` 관측을 남기고
    //      exit(1)** 로 정직하게 끝난다(fail-soft 아님 — 식별자 없이 도는 것보다 정직한 실패가 낫다).
    let devRunId = '';
    let devRunIdSource: import('./harness/harness-space.js').RunIdSource | undefined;
    let preparedWorktree: import('./harness/harness-worktree-auto.js').PreparedDevWorktree | undefined;
    try {
      // ⛔ raw 입력 배타성 검증은 try 안의 selectDevAuthorInput 하나가 소유한다 — 실패도 아래 catch가 관측한다.
      const { buildDevCommandInput, selectDevAuthorInput } = await import('./self-dev/dev-cli.js');
      // ⭐ `--ask`/`--say` — 발사 절차 넷을 «한 로직»으로. 저작 → 전제 검사 → 발사.
      //   ⛔ 여기서 저작한 골 파일을 아래 `--file` 자리에 그대로 넘긴다(새 실행 경로를 만들지 않는다).
      let askAuthoredFile: string | undefined;
      const retirementInput = opts.ask !== undefined
        ? { kind: 'ask' as const, value: opts.ask }
        : opts.say !== undefined
          ? { kind: 'say' as const, value: opts.say }
          : opts.file !== undefined
            ? { kind: 'file' as const, value: opts.file }
            : hasText
              ? { kind: 'text' as const, value: textParts.join(' ') }
              : undefined;
      if (!opts.json) {
        const notice = devHarnessRetirementNotice(retirementInput, opts.plan === true);
        if (notice) console.error(notice.trimEnd());
      }
      // ⛔ 네 입력 소스의 배타성과 종속 인자는 저작보다 먼저 순수 seam에서 검증한다.
      const selectedInput = selectDevAuthorInput(textParts, opts as import('./self-dev/dev-cli.js').DevCliOpts);
      if (opts.ask === undefined && (opts.substrate !== undefined || opts.podPool !== undefined)) {
        throw new DevPipelineError('--substrate/--pod-pool 는 dev --ask 와 함께');
      }
      const devAskSubstrate = opts.ask === undefined ? undefined : (await import('./harness/harness-substrate-default.js')).resolveHarnessSubstrate({
        flag: { substrate: opts.substrate, podPool: opts.podPool },
        config: (await import('./user-config.js')).getUserConfig(), env: process.env,
      });
      if (devAskSubstrate) {
        debug.log('harness.substrate', 'resolved', devAskSubstrate);
        console.error(`[harness] substrate=${devAskSubstrate.substrate}${devAskSubstrate.substrate === 'pod' ? ` pool=${devAskSubstrate.pool}` : ''} (${devAskSubstrate.source})`);
      }
      if (devAskSubstrate?.substrate === 'pod' && opts.target !== undefined) {
        throw new DevPipelineError('`--target` 은 Pod 경로에서 아직 지원하지 않는다 — `--substrate local` 로 명시하거나 `--target` 을 빼라');
      }
      if (devAskSubstrate?.substrate === 'pod' && opts.branch !== undefined) {
        throw new DevPipelineError('`--branch` 는 Pod 경로에서 아직 지원하지 않는다 — `--substrate local` 로 명시하거나 `--branch` 를 빼라');
      }
      const authorInput = selectedInput?.kind === 'ask' || selectedInput?.kind === 'say' ? selectedInput : undefined;
      if (authorInput?.kind === 'ask' && isObviouslyLongAskPath(authorInput.value)) {
        throw new DevPipelineError('--ask 는 파일 경로를 받는다 — 준 값은 경로로 쓰기엔 명백히 길다. 문장은 --say 로 전달하라');
      }
      const askLaunchPrep = (await import('./self-dev/launch-preflight.js')).prepareAskLaunch(authorInput, opts);
      // ⛔⭐ 조회 «구현»은 한 곳에서만 만든다 — 저작 «전» 예비 검사와 발사 «직전» 검사가 같은 것을 쓴다.
      //   (판정은 launch-preflight 모듈이 하고, 여기는 I/O 만 준다. 로직을 두 벌 쓰면 둘이 갈린다.)
      // ⛔ 조회 «구현»은 `self-dev/ask-launch-io.ts` 가 «한 벌»로 갖는다 — TUI 슬래시도 같은 것을 쓴다.
      //   (2026-08-11 72차: 표면이 둘이 되는 순간 이 클로저는 «복제 아니면 추출»이었고, 판이 복제를 금지했다.)
      const { buildAskPreflightDeps } = await import('./self-dev/ask-launch-io.js');
      if (authorInput) {
        // ⭐ ask 발사 «흐름»은 `self-dev/ask-launch-flow.ts` 가 소유한다(2026-08-11 72차 B2 선결).
        //   ⛔ 여기는 I/O 만 준다 — 판정·문면·관측 이름은 그 모듈이 «한 곳»에서 갖는다.
        //   그래야 TUI 슬래시가 같은 흐름을 «복제 없이» 부를 수 있다.
        const { readFileSync, writeFileSync } = await import('node:fs');
        const askText = authorInput.kind === 'ask'
          ? readFileSync(authorInput.value, 'utf8')
          : authorInput.value;
        // ⛔ raw 값의 「빈 입력」은 selectDevAuthorInput 이 «이미» 같은 문면으로 막는다(dev-cli.ts).
        //   여기서 볼 것은 seam 이 «구조적으로 볼 수 없는» 것 하나뿐이다 — `--ask` 의 «파일 내용».
        if (authorInput.kind === 'ask' && !askText.trim()) throw new DevPipelineError('--ask 파일 입력이 비었다');
        const [flowMod, { runGoalAuthorCli }, { relative: relativeToCwdPath }, { CLI_DEV_ASK_ENTRANCE }] = await Promise.all([
          import('./self-dev/ask-launch-flow.js'),
          import('./self-implement/goal-author-cli.js'),
          import('node:path'),
          import('./self-dev/entrance-registry.js'),
        ]);
        const askIo = await import('./self-dev/ask-launch-io.js');
        const askLogRows = await askIo.readAskPreflightLogRows();
        const flowResult = await (devAskLaunchFlowForTesting ?? flowMod.runAskLaunchFlow)({
          entrance: CLI_DEV_ASK_ENTRANCE,
          inputSource: authorInput.kind,
          askText,
          ...(authorInput.kind === 'ask' ? { askFile: authorInput.value } : {}),
          liveRunWindowMinutes: askLaunchPrep.liveRunWindowMinutes,
          recentChangeWindowDays: askLaunchPrep.recentChangeWindowDays,
          ...assembleAskLaunchPolicy({
            forcePreflight: opts.forcePreflight,
            launchDecomposition: opts.launchDecomposition,
          }),
        }, {
          print: (line) => console.error(line),
          log: (event, data, level) => devDebug?.log('dev-pipeline', event, data, { level }),
          readLine: (prompt) => readStdinLine(prompt),
          readFile: (file) => readFileSync(file, 'utf8'),
          writeFile: (file, data) => writeFileSync(file, data, 'utf8'),
          cwd: () => process.cwd(),
          now: () => Date.now(),
          // ⛔ 「대화형인가」는 «두 쪽»을 본다 — 파이프로 몰면 물어도 답이 안 온다.
          isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
          buildPreflightDeps: buildAskPreflightDeps,
          priorBlockSamples: () => askIo.priorBlockSamplesFrom(askLogRows),
          recentAuthoringSamples: () => askIo.recentAuthoringSamplesFrom(askLogRows),
          authorGoal: (args, options) => runGoalAuthorCli([...args], options as never),
          relativeToCwd: (file) => relativeToCwdPath(process.cwd(), file),
        });
        // ⛔ 종료는 «표면»이 한다 — 흐름은 세 값만 낸다.
        if (flowResult.kind === 'stopped-before-authoring') {
          // ⭐ 저작 «전»에 끊는다 — 100초를 쓰지 않는다. 우회는 --force-preflight 로 그대로 열려 있다.
          throw new DevPipelineError('저작 전 예비 검사에서 막혔다 — 위 이름을 확인하라 (우회: --force-preflight)');
        }
        askAuthoredFile = flowResult.goalFile;
        if (flowResult.kind === 'stopped-by-preflight') {
          completionGuard.conclude();
          process.exit(1);
        }
      }
      const pipelineInput = authorInput
        ? { kind: 'file' as const, value: askAuthoredFile! }
        : selectedInput?.kind === 'file' || selectedInput?.kind === 'text'
          ? selectedInput
          : undefined;
      const input = buildDevCommandInput(pipelineInput);
      if (devAskSubstrate?.substrate === 'pod') {
        const { dispatchHarnessOnPod } = await import('./harness/harness-pod-dispatch.js');
        const { devAskPodDispatchInput } = await import('./harness/harness-substrate-default.js');
        const status = await dispatchHarnessOnPod(devAskPodDispatchInput(opts, askAuthoredFile!, devAskSubstrate.pool!));
        if (status !== 0) console.error('Pod 실행에 닿지 못했다 — 풀·컨텍스트·SSH 연결을 확인하거나 `--substrate local` 로 명시하라');
        completionGuard.conclude();
        process.exit(status);
      }
      const { ensureRunIdentity } = await import('./harness/harness-space.js');
      const identity = ensureRunIdentity();
      if (authorInput) {
        const [flowMod, { CLI_DEV_ASK_ENTRANCE }] = await Promise.all([
          import('./self-dev/ask-launch-flow.js'),
          import('./self-dev/entrance-registry.js'),
        ]);
        flowMod.observeAskLaunchRunIdentity({
          entrance: CLI_DEV_ASK_ENTRANCE,
          inputSource: authorInput.kind,
        }, {
          log: (event, data, level) => devDebug?.log('dev-pipeline', event, data, { level }),
        }, identity.runId);
      }
      devRunId = identity.runId;
      devRunIdSource = identity.source;
      const devOpts = opts as import('./self-dev/dev-cli.js').DevCliOpts;
      const devCli = await import('./self-dev/dev-cli.js');
      if (invokedAsDrive) {
        devCli.assertDriveAliasOptions(command.options
          .map((option) => option.attributeName())
          .filter((name) => command.getOptionValueSource(name) === 'cli'));
      }
      if (invokedAsDrive && typeof devOpts.attach === 'string' && devOpts.attach.trim()) {
        const { runDriveCliCommand } = await import('./cli/pty-drive-cli.js');
        await runDriveCliCommand(hasText ? textParts.join(' ') : undefined, {
          goal: devOpts.goal ?? '',
          ...(devOpts.maxSteps !== undefined ? { maxSteps: devOpts.maxSteps } : {}),
          ...(devOpts.pollMs !== undefined ? { pollMs: devOpts.pollMs } : {}),
          ...(devOpts.model ? { model: devOpts.model } : {}),
          ...(devOpts.cwd ? { cwd: devOpts.cwd } : {}),
          ...(devOpts.worktree === true ? { worktree: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          attach: devOpts.attach,
        }, {
          exit: ((code: number): never => {
            completionGuard.conclude();
            process.exit(code);
          }) as (code: number) => never,
        });
        return;
      }
      const explicitOptions = devCli.explicitDevOptionNames(command);
      if (!opts.json && !invokedAsDrive && typeof devOpts.attach === 'string' && devOpts.attach.trim()) {
        const attach = `'${devOpts.attach.replaceAll("'", "'\\''")}'`;
        console.error(`[dev] --attach 갈래는 \`elanous pty auto\` 와 같은 루프입니다; 대응 명령: elanous pty auto ${attach}`);
      }
      if (!opts.json && !invokedAsDrive && explicitOptions.includes('backend') && executor.kind === 'external') {
        console.error(`[dev] 외부 backend 미션의 자기 명령은 \`elanous agent-mission mission\` 입니다; 대응 명령: elanous agent-mission mission --backend ${executor.backend}`);
      }
      let spec = invokedAsDrive
        ? devCli.buildDriveAliasDevSpec(hasText ? textParts.join(' ') : undefined, devOpts, devCli.explicitDevOptionNames(command))
        : buildDevCliSpec(input, executor, devOpts, devCli.explicitDevOptionNames(command));
      if (!opts.json && spec.notice) console.error(spec.notice);
      // 역할별 LLM은 현재 프로세스 설정이다. self-mission 구현 자식에 전달되지 않는 조합은 위 검증이 먼저 거부한다.
      if (Array.isArray(opts.roleLlm) && opts.roleLlm.length > 0) {
        const { parseRoleLlmFlags } = await import('./llm/role-llm-cli.js');
        const { setLaunchRoleLlmOverrides } = await import('./user-config.js');
        const parsed = parseRoleLlmFlags(opts.roleLlm as string[]);
        if (!parsed.ok) {
          console.error(`❌ --role-llm: ${parsed.message}`);
          completionGuard.conclude();
          process.exit(1);
        }
        setLaunchRoleLlmOverrides(parsed.overrides);
        debug.log('harness.role-llm', 'launch-overrides', { roles: Object.keys(parsed.overrides), source: 'flag' });
      }
      const argv = process.argv.slice(2);
      const hasExplicitReviewerContext = argv.some((arg) => arg === '--context' || arg.startsWith('--context=') || arg === '--context-text' || arg.startsWith('--context-text='));
      const derivedContextOrder = !invokedAsDrive && !hasExplicitReviewerContext && 'file' in input
        ? await (async () => {
          const [{ readFileSync }, { tracedPathReferences }] = await Promise.all([
            import('node:fs'),
            import('./self-implement/goal-author.js'),
          ]);
          return tracedPathReferences(readFileSync(input.file, 'utf8'))
            .map(({ path }) => ({ kind: 'file' as const, value: path }));
        })()
        : [];
      if (!invokedAsDrive && (hasExplicitReviewerContext || derivedContextOrder.length > 0)) {
        const [{ reviewerContextArgs, loadReviewerContext, renderReviewerContextStatus }, { createRepositoryReferencedFileReader }] = await Promise.all([
          import('./agent-substrate/self-review-cli.js'),
          import('./self-implement/goal-file-reader.js'),
        ]);
        const contextOrder = hasExplicitReviewerContext ? reviewerContextArgs(argv) : derivedContextOrder;
        const loaded = loadReviewerContext({ contextOrder }, createRepositoryReferencedFileReader(process.cwd()));
        const contextStatus = renderReviewerContextStatus(loaded);
        if (!opts.json) console.log(contextStatus);
        if (hasExplicitReviewerContext && loaded.failed.length > 0) throw new DevPipelineError(contextStatus);
        if (loaded.items.length > 0) spec = { ...spec, reviewerContext: loaded.items };
      }
      if (devOpts.worktree === true) {
        const { prepareDevWorktree, renderPreparedDevWorktree } = await import('./harness/harness-worktree-auto.js');
        const goal = 'file' in input
          ? await (async () => {
              const { parseGoalId } = await import('./self-implement/goal-author.js');
              const goalId = parseGoalId(readFileSync(input.file, 'utf8'));
              if (!goalId) throw new DevPipelineError(`--worktree goal file is missing a GoalId — ${input.file}`);
              return { id: goalId, file: input.file };
            })()
          : undefined;
        const prepared = prepareDevWorktree(process.cwd(), devRunId, invokedAsDrive ? 'drive' : 'dev', goal);
        preparedWorktree = prepared;
        if (spec.elanous) spec = { ...spec, elanous: { ...spec.elanous, cwd: prepared.worktree.path } };
        else if (spec.drive) spec = { ...spec, drive: { ...spec.drive, cwd: prepared.worktree.path } };
        else throw new DevPipelineError('--worktree 는 elanous 또는 셸 drive child에만 유효');
        if (!opts.json) console.log(renderPreparedDevWorktree(prepared).join('\n'));
        debug.log('dev-pipeline', 'auto-worktree-prepared', { runId: devRunId, ...prepared.environment, worktree: prepared.worktree });
      }
      // ⛔ 종전의 `const plan = planDevPipeline(spec)` 를 지운다(무인 리뷰 must-fix) — 쓰이지 않는
      //    데다 **잔여 조회보다 먼저 던질 수 있어** 관측 자체를 건너뛰게 만든다. 계획은 어차피
      //    `runDevPipeline` 안에서 다시 세워지고, 그 행이 관측을 낸다.
      const executeRunDevPipeline = devRunPipelineForTesting ?? runDevPipeline;
      const gitResiduePath = process.cwd();
      const { gateWorktreeBehindMain } = await import('./self-implement/seams.js');
      const behind = gateWorktreeBehindMain(gitResiduePath);
      if (behind !== undefined && behind > 0) {
        console.warn(`⚠️ 이 작업 트리는 origin/main보다 ${behind}개 커밋 뒤처져 있습니다 — 이미 병합된 수리를 확인하세요.`);
        debug.log('dev-pipeline', 'worktree-behind-main', { runId: devRunId, behind });
      }
      const [{ observeGitResidue }, { mintRunId }] = await Promise.all([
        import('./git-fs/worktree.js'),
        import('./harness/harness-space.js'),
      ]);
      let pipelineRuns = 0;
      const executePipeline = async (pieceFeature?: string, relaunch?: boolean, base?: string) => {
        const runId = pipelineRuns === 0 ? devRunId : mintRunId();
        const runIdSource = pipelineRuns === 0 ? devRunIdSource : 'explicit' as const;
        pipelineRuns += 1;
        const gitResidue = await observeGitResidue(gitResiduePath);
        return executeRunDevPipeline({
          ...spec,
          ...(pieceFeature === undefined ? {} : { input: { text: pieceFeature } }),
          ...(base === undefined ? {} : { base }),
          runId,
          runIdSource,
          ...(relaunch ? { relaunch: true } : {}),
          humanReadableOutput: !opts.json,
          gitResidueSnapshot: { path: gitResiduePath, observation: gitResidue },
        }, {
          runChatTurn: (text, chat) => runChatTurnCli({
            cfg: reloadUserConfig(),
            userText: text,
            explicitSessionId: chat.session,
            reuseActive: !chat.forceNew,
            forceNew: chat.forceNew === true,
            json: chat.json === true,
            enableTools: chat.enableTools,
            goalLoop: chat.goalLoop,
          }),
        });
      };
      const child = await devCli.executeDevChild(async () => {
        devCli.startDraftTriage(devRunId, startDraftTriageOptionsForTesting);
        const initial = await executeDevPipelineInvocation(executePipeline, { kind: 'initial' });
        if (initial.kind !== 'self') return initial;
        const supervised = await (devExecuteSelfRunForTesting ?? devCli.executeDevSelfRun)(
          'file' in spec.input ? spec.input.file : spec.input.text,
          async (relaunch) => {
            const rerun = await executeDevPipelineInvocation(executePipeline, { kind: 'supervisor-relaunch', relaunch });
            if (rerun.kind !== 'self') throw new DevPipelineError(`dev supervisor: self 재실행이 예상 밖 dispatch(kind=${rerun.kind})를 반환`);
            return rerun.result;
          },
          devOpts.supervise
            ? {
                ...(devOpts.superviseRounds === undefined ? {} : { rounds: devCli.parsePositiveInt(devOpts.superviseRounds, '--supervise-rounds') }),
                completion: initial.plan.completion,
                deliverableDocument: await (async () => {
                  const { resolveDevInputText, applyManualGoalEvidenceRequirement } = await import('./self-dev/dev-pipeline.js');
                  const { readFileSync } = await import('node:fs');
                  return applyManualGoalEvidenceRequirement(spec.input, resolveDevInputText(spec.input, (path) => readFileSync(path, 'utf8')));
                })(),
                executePiece: async (pieceFeature, opts) => {
                  const rerun = await executeDevPipelineInvocation(executePipeline, {
                    kind: 'fragment-reexecution', pieceFeature, ...(opts?.base === undefined ? {} : { base: opts.base }),
                  });
                  if (rerun.kind !== 'self') throw new DevPipelineError(`dev supervisor: piece 재실행이 예상 밖 dispatch(kind=${rerun.kind})를 반환`);
                  return rerun.result;
                },
              }
            : undefined,
          initial.result,
        );
        return {
          ...initial,
          result: supervised.result,
          ...(supervised.supervisorStopReason ? { supervisorStopReason: supervised.supervisorStopReason } : {}),
        };
      }, preparedWorktree);
      if (!child.ok) {
        const msg = child.failure.error;
        // ⛔⭐ 바깥 catch 는 `DevPipelineError` 를 «rejected», 그 밖을 «error» 로 갈라 왔다.
        //    이 래퍼가 «먼저» 삼키므로 여기서 그 구분을 «그대로» 재현하지 않으면 관측 의미가 바뀐다
        //    (무인 리뷰 must-fix — 계약 변경이지 개선이 아니다).
        const failureEvent = child.error instanceof DevPipelineError ? 'rejected' : 'error';
        try { debug.log('dev-pipeline', failureEvent, { runId: devRunId, msg }, { level: 'error' }); } catch { /* fail-soft */ }
        if (opts.json) await writeStdoutJson(JSON.stringify(child.failure, null, 2) + '\n');
        else console.error(`❌ ${msg}`);
        completionGuard.conclude();
        process.exit(child.error instanceof DevPipelineError ? child.error.exitCode : 1);
      }
      const r = child.result;
      const ok = devResultOk(r); // ★ T7 — kind 별 정직 판정(parallel/interactive/plan-staged 는 .ok 없음)
      const outcome = r.kind === 'self' ? r.result.outcome : undefined;
      const supervisorWantedContinue = r.kind === 'self' ? r.result.supervisorWantedContinue : undefined;
      const supervisorStopReason = r.kind === 'self' ? r.supervisorStopReason : undefined;
      const mergeSkipReason = r.kind === 'self' ? r.result.mergeReason : undefined;
      const completionRunId = devCli.resolveDevCompletionRunId(
        devRunId,
        r.kind === 'self' ? r.result : undefined,
        supervisorStopReason,
      );
      debug.log('dev-pipeline', 'done', {
        runId: completionRunId,
        kind: r.kind,
        ok,
        ...(outcome ? { outcome } : {}),
        ...(supervisorWantedContinue ? { supervisorWantedContinue } : {}),
        ...(supervisorStopReason ? { supervisorStopReason } : {}),
        // ⭐ auto-merge 를 건너뛴 이유는 «사람이 보는 줄»에도, «관측»에도 실린다.
        //    ⛔ 종전 커밋에서 이 상수가 선언만 되고 안 쓰여 dead 였다(리뷰 must-fix 4R).
        ...(mergeSkipReason ? { mergeSkipReason } : {}),
      });
      // ⭐ 두 착지가 «상보»다 — JSON 은 자동 워크트리 정보를(#6999), 사람 줄은 auto-merge 생략 이유를(#7001).
      //    조립은 순수 함수(dev-cli)로 둔다 — 소스 정규식이 아니라 «행동»을 무는 테스트가 가능해진다.
      const { renderDevCompletionLine } = await import('./self-dev/dev-cli.js');
      const jsonResult = r.kind === 'self' && supervisorStopReason
        ? { ...r.result, supervisorStopReason }
        : r.result;
      const suppressHoldJsonWrapper = devCli.shouldSuppressDevJsonWrapper({
        elanous: devOpts.elanous,
        hold: devOpts.hold,
        json: opts.json,
      });
      if (!suppressHoldJsonWrapper) {
        if (opts.json) await writeStdoutFully(JSON.stringify(preparedWorktree ? { result: jsonResult, autoWorktree: preparedWorktree } : jsonResult, null, 2));
        else console.log(renderDevCompletionLine({
          kind: r.kind, ok, runId: completionRunId, base: r.plan.base, result: r.kind === 'self' ? r.result : undefined,
          supervisorStopReason,
        }));
      }
      // ⛔ 종전엔 CLI 가 `planDevPipeline(spec)` 를 따로 불러 이 값을 얻었는데, 그 호출이
      //   **잔여 관측보다 먼저 던질 수 있어** 관측을 건너뛰게 했다(무인 리뷰 must-fix).
      //   ⚠️ 리뷰는 그 호출을 *"사용되지 않는다"* 고 했으나 **틀렸다** — 여기서 쓰였다.
      //   ⇒ 지우는 대신 **결과가 실어 오는 `r.plan`** 을 쓴다. 계획은 한 번만 세워지고,
      //     그 계산은 이제 관측을 감싼 `runDevPipeline` **안**에 있다.
      const planHold = r.plan.elanous?.hold;
      const holdOwnerValue = process.env.ELANOUS_HOLD_OWNER;
      const holdRequestedByCli = devOpts.hold === true;
      const holdRequested = planHold === true || holdRequestedByCli;
      const holdOwner = holdOwnerValue === '1';
      const shouldHoldOwner = r.kind === 'elanous-tui' && planHold === true && holdOwner;
      // ⛔⭐⭐ **정정(2026-09-12 라이브)** — 종전 이 자리는 `holdRequested && !shouldHoldOwner` 하나로
      //   울렸고, 그래서 ***성공 경로인 「런처」까지 결함처럼 말했다***. 런처는 `ELANOUS_HOLD_OWNER` 없이
      //   돌면서 **소유자를 spawn 하는 것이 자기 역할**이라 여기서 안 붙드는 것이 «정상»이다.
      //   📏 실측: held TUI 한 번에 `hold-owner-not-entered` 1건 · 전부 런처 것(`holdOwner=missing`).
      //   ⇒ 두 상태를 **다른 이름**으로 가른다. 「소유자인데 안 붙들었다」만 이상이다.
      if (holdRequested && !shouldHoldOwner) {
        const fields = {
          kind: r.kind,
          planHold: planHold ?? 'missing',
          holdOwner: holdOwnerValue ?? 'missing',
          holdRequestedByCli,
        };
        // ⛔ 「런처가 위임했다」는 **정상**이다 — 결함 신호로 읽히지 않게 이름을 나눈다.
        debug.log('dev-pipeline', holdOwner ? 'hold-owner-not-entered' : 'hold-delegated-to-owner', { ...fields, runId: devRunId });
      }
      if (shouldHoldOwner) {
        if (startHoldOwnerPollerForTesting) startHoldOwnerPollerForTesting();
        else {
          const { startPtyControlPoller } = await import('./pty-shell/registry.js');
          startPtyControlPoller();
        }
        if (waitForHoldOwnerForTesting) await waitForHoldOwnerForTesting();
        else {
          const ptyId = process.env.ELANOUS_HOLD_PTY_ID;
          if (!ptyId) throw new Error('hold owner is missing ELANOUS_HOLD_PTY_ID');
          const childExitCode = await waitForHoldOwnerChild(ptyId);
          if (childExitCode !== null) r.result.exitCode = childExitCode;
        }
      }
      if (r.kind === 'shell-drive' || r.kind === 'elanous-tui') {
        // ⛔ 프로세스 경계는 숫자를 요구하지만 `?? 0` 은 금지다 — 0 은 '정상 완료' 로 읽힌다.
        //    죽었는데 코드를 모르면 그것은 실패이고, 왜 그 값이 나갔는지 사람이 볼 수 있어야 한다.
        if (r.result.exitCode === null) {
          console.error('❌ dev: 자식이 종료 코드 없이 끝났다 — 실패로 보고(exit 1)');
          completionGuard.conclude();
          process.exit(1);
        }
        completionGuard.conclude();
        process.exit(r.result.exitCode);
      }
      completionGuard.conclude();
      process.exit(ok ? 0 : 2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // ⚠️ 관측은 결론을 막지 않는다(리뷰 should-fix 5R) — 여기서 로거가 던지면 아래 `console.error` 와
      //    의도한 `exit(1)` 까지 통째로 우회해, 사용자는 이유도 모른 채 다른 종료코드를 받는다.
      try {
        // mint 자체가 실패했으면 devRunId 가 빈 문자열이다 — 빈 값으로 남기면 조회에서 **다른 실행과
        // 구분이 안 된다**(리뷰 should-fix). 식별 불가임을 값으로 드러내 오인을 막는다.
        debug.log('dev-pipeline', e instanceof DevPipelineError ? 'rejected' : 'error', { runId: devRunId || '(unminted)', msg }, { level: 'error' });
      } catch { /* fail-soft */ }
      if (opts.json) {
        await writeStdoutJson(JSON.stringify({
          ok: false,
          error: msg,
          ...(preparedWorktree ? { autoWorktree: preparedWorktree } : {}),
        }, null, 2) + '\n');
      } else {
        console.error(`❌ ${msg}`);
      }
      completionGuard.conclude();
      process.exit(1);
    }
  });

const DEV_PRIMARY_HELP_OPTIONS = [
  '--ask', '--say', '--file', '--backend', '--target',
  '--plan', '--implement', '--elanous', '--attach', '--json', '--help-all', '-h', '--help',
] as const;
foldCommandHelpBehindHelpAll(selfDevCmd, DEV_PRIMARY_HELP_OPTIONS, '[text...]', '모든 dev 옵션 표시');

// ── keys (keybinding help) ──
program
  .command('keys [context]')
  .description('Print all keybindings + slash commands. Optional context filter.')
  .option('--audit', 'Print context-aware duplicate/chord audit')
  .action((context?: string, opts?: { audit?: boolean }) => {
    if (context) {
      const known = Object.keys(CONTEXT_LABELS);
      if (!known.includes(context)) {
        ui.error(`unknown context "${context}". Known: ${known.join(', ')}`);
        process.exit(1);
      }
    }
    ui.header('elanous keybindings');
    console.log(renderKeyHelp({ context: context as KeyContext | undefined }));
    if (opts?.audit) {
      console.log('');
      ui.header('keymap audit');
      console.log(renderKeymapAudit(auditKeybindings()));
    }
    console.log('');
    console.log('Tip: filter a context, e.g. `elanous keys browser`, `elanous keys log`.');
  });

// ── finance — 네이티브 도메인 로직 CLI (SSOT·skill thin-client 진입점·2026-07-22) ──
//   "elanous is ALL": 네이티브 로직을 standalone CLI 로 노출 → skill 이 자기 python/Conatus
//   스크립트 대신 `elanous finance <x> --json` 호출. 데몬 불필요(one-shot).
const financeCmd = program.command('finance')
  .description('Native finance/investment logic (SSOT) — skill thin-client 진입점');
financeCmd
  .command('sector-flow')
  .description('KR 섹터 자금흐름(모멘텀·폭·z-score) — 로컬 screener.db (Conatus sector_flow.py 대체·rolling·z-score 우월)')
  .option('--window <w>', 'daily|weekly|monthly', 'daily')
  .option('--granularity <g>', 'category|subchain', 'category')
  .option('--json', 'JSON 출력')
  .action(async (opts: { window?: string; granularity?: string; json?: boolean }) => {
    const { computeSectorFlow, renderSectorFlow } = await import('./domains/finance-cli.js');
    const window = (['daily', 'weekly', 'monthly'].includes(opts.window ?? '') ? opts.window : 'daily') as 'daily' | 'weekly' | 'monthly';
    const granularity = (opts.granularity === 'subchain' ? 'subchain' : 'category') as 'category' | 'subchain';
    const r = computeSectorFlow({ window, granularity });
    console.log(opts.json ? JSON.stringify(r) : renderSectorFlow(r));
  });

// ── config (scriptable user-config edits) ──
function redactConfigDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigDisplay);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      redactSecretText(key), redactConfigDisplay(child),
    ]));
  }
  return typeof value === 'string' ? redactSecretText(value) : value;
}

const configCmd = program.command('config').description('Inspect and edit ~/.config/elanous/config.json');

configCmd
  .command('path')
  .description('Print the active config path')
  .action(() => {
    console.log(userConfigPath());
  });

configCmd
  .command('get [path]')
  .description('Print all config or one dotted path, e.g. llm.provider (secrets redacted by default)')
  .option('--reveal', 'Print unredacted output and record the reveal')
  .action(async (path: string | undefined, opts: { reveal?: boolean }) => {
    const cfg = getUserConfig() as unknown as Record<string, unknown>;
    const value = path ? getConfigPath(cfg, path) : cfg;
    if (value === undefined) {
      ui.error(`config path not found: ${path}`);
      process.exit(1);
    }

    if (opts.reveal) {
      const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
      const auditReady = await registerStandaloneLogSink('config-cli');
      if (!auditReady) {
        ui.error('config reveal blocked: persistent audit sink unavailable');
        process.exit(1);
      }
      debug.log('config.get', 'reveal', { path: redactSecretText(path ?? '<all>') });
      debug.flush();
    }

    const displayKey = path?.split('.').filter(Boolean).at(-1);
    const displayValue = opts.reveal
      ? value
      : displayKey
        ? redactConfigDisplay(redactSecrets({ [displayKey]: value })[displayKey])
        : redactConfigDisplay(redactSecrets(value));
    console.log(typeof displayValue === 'string' ? displayValue : JSON.stringify(displayValue, null, 2));
  });

configCmd
  .command('set <path> <value>')
  .description('Set a dotted config path. Value is parsed as JSON when possible.')
  .option('--no-backup', "Don't write config.json.bak before saving")
  .action((path: string, value: string, opts: { backup?: boolean }) => {
    const parsed = parseConfigValue(value);
    const cfg = getUserConfig() as unknown as Record<string, unknown>;
    const previousProvider = getConfigPath(cfg, 'llm.provider');
    const nextProvider = path === 'llm.provider' && typeof parsed === 'string' ? parsed : undefined;
    if (nextProvider !== undefined && nextProvider === previousProvider) {
      ui.info(`set ${path} = ${JSON.stringify(parsed)} (no-op)`);
      return;
    }
    const credential = nextProvider !== undefined
      ? resolveProviderCredential({
        provider: nextProvider,
        rotation: getConfigPath(cfg, 'llm.rotation') as RotationEntry[] | undefined,
        baseApiKey: getConfigPath(cfg, 'llm.apiKey') as string | undefined,
        baseProvider: previousProvider as string | undefined,
      })
      : undefined;

    if (opts.backup !== false) backupUserConfig(userConfigPath());
    setConfigPath(cfg, path, parsed);
    if (credential?.apiKey && (credential.source === 'rotation' || credential.source === 'env')) {
      setConfigPath(cfg, 'llm.apiKey', credential.apiKey);
    }
    saveUserConfig(cfg as unknown as ReturnType<typeof getUserConfig>);
    reloadUserConfig();
    // ★ no-op 가드(2026-07-15) — 저장 후 재읽기해 값이 실제로 박혔는지 검증. 직렬화 드롭이면 조용한
    //   성공 금지(nextFluent.enabled 가 no-op 이던 사건). raw 미러(setConfigPath)로 이제 미지 키도 생존.
    const after = getConfigPath(getUserConfig() as unknown as Record<string, unknown>, path);
    if (JSON.stringify(after) !== JSON.stringify(parsed)) {
      console.error(`⚠️ set ${path} — 저장 후 값 미반영(직렬화 드롭). 읽힌값=${JSON.stringify(after)}`);
      process.exit(1);
    }
    if (credential?.apiKey && (credential.source === 'rotation' || credential.source === 'env')) {
      ui.info(`provider credential updated: ${parsed} via ${credential.source} (${credential.apiKey.length} chars)`);
    } else if (credential?.source === 'none' && !isKeylessProvider(nextProvider)) {
      ui.warn(`provider credential unavailable: ${parsed}; keeping existing llm.apiKey (subscription or OAuth may be normal)`);
    }
    ui.info(`set ${path} = ${JSON.stringify(parsed)}`);
  });

configCmd
  .command('unset <path>')
  .description('Remove a dotted config path (set 의 역 · 배열 인덱스 지원). 이미 없으면 no-op.')
  .option('--no-backup', "Don't write config.json.bak before saving")
  .action((path: string, opts: { backup?: boolean }) => {
    const cfg = getUserConfig() as unknown as Record<string, unknown>;
    if (getConfigPath(cfg, path) === undefined) {
      ui.info(`unset ${path} — 이미 없음 (no-op)`);
      return;
    }
    if (opts.backup !== false) backupUserConfig(userConfigPath());
    unsetConfigPath(cfg, path);
    saveUserConfig(cfg as unknown as ReturnType<typeof getUserConfig>);
    reloadUserConfig();
    // set 과 대칭 — 삭제 후 재읽기해 실제로 사라졌는지 검증(직렬화가 되살리면 조용한 실패 금지).
    const after = getConfigPath(getUserConfig() as unknown as Record<string, unknown>, path);
    if (after !== undefined) {
      console.error(`⚠️ unset ${path} — 삭제 후에도 값 잔존. 남은값=${JSON.stringify(after)}`);
      process.exit(1);
    }
    ui.info(`unset ${path}`);
  });

// ── config 격리 sync (ISO-1 · 2026-07-13) — 운영→테스트 물질화 동기화 ──
// 격리 테스트 인스턴스는 운영 config 를 공유하지 않는다(overlay 은퇴 방향).
configCmd
  .command('sync-test')
  .description('운영 config 를 test-safe 변환해 격리 루트로 물질화 (+부속 복사 · 기본 <repo>/.elanous-test)')
  .option('--repo <path>', '레포 루트 (기본: cwd 상위 .git 탐색)')
  .option('--state-dir <dir>', '격리 루트 직접 지정 (telegram-test 의 ~/.elanous/telegram-test 등)')
  .option('--json')
  .action(async (o: { repo?: string; stateDir?: string; json?: boolean }) => {
    const { runConfigSyncTest } = await import('./cli/config-test-sync.js');
    process.exit(runConfigSyncTest(o));
  });

configCmd
  .command('promote <path...>')
  .description('테스트 config 의 필드(들)를 운영에 전파 (필드 단위 raw patch · 다중 경로 · 기본 dry-run · --yes 적용)')
  .option('--repo <path>', '레포 루트 (기본: cwd 상위 .git 탐색)')
  .option('--yes', 'diff 확인 없이 적용')
  .action(async (path: string[], o: { repo?: string; yes?: boolean }) => {
    const { runConfigPromote } = await import('./cli/config-test-sync.js');
    process.exit(runConfigPromote(path, o));
  });

// ── elanous config mission · iPhone Showroom P1-2 (2026-05-14) ──
//
// Thin wrapper around `elanous config set llm.missionRouting.…` so users
// don't memorise dotted paths. Pure work lives in src/cli/mission-config.ts;
// the wiring here handles read → outcome → save round-trip.
const missionCmd = configCmd
  .command('mission')
  .description('Inspect or edit llm.missionRouting (mission → provider table)');

function persistMissionOutcome(outcome: ReturnType<typeof describeMissionRouting>): void {
  for (const line of outcome.lines) console.log(line);
  if (outcome.next === undefined) {
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
    return;
  }
  const cfg = getUserConfig();
  backupUserConfig(userConfigPath());
  cfg.llm.missionRouting = outcome.next.missions === undefined && outcome.next.mode === undefined
    ? undefined
    : outcome.next;
  saveUserConfig(cfg);
  reloadUserConfig();
  if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
}

missionCmd
  .command('get [mission]')
  .description('Show current routing (all missions or one)')
  .action((mission?: string) => {
    const cfg = getUserConfig();
    persistMissionOutcome(describeMissionRouting(cfg.llm.missionRouting, mission));
  });

missionCmd
  .command('set <mission> <provider> [model]')
  .description('Override one mission. Example: elanous config mission set plan claude claude-opus-4-7')
  .action((mission: string, provider: string, model?: string) => {
    const cfg = getUserConfig();
    persistMissionOutcome(setMissionEntry(cfg.llm.missionRouting, mission, provider, model));
  });

missionCmd
  .command('reset [mission]')
  .description('Reset one mission (or all when omitted) back to built-in defaults')
  .action((mission?: string) => {
    const cfg = getUserConfig();
    persistMissionOutcome(resetMissionEntry(cfg.llm.missionRouting, mission));
  });

missionCmd
  .command('mode <mode>')
  .description("Set routing mode: 'auto' (predictor decides) or 'manual' (chip selection wins)")
  .action((mode: string) => {
    const cfg = getUserConfig();
    persistMissionOutcome(setMissionMode(cfg.llm.missionRouting, mode));
  });

registerTasksCommands(program);
registerLabelsCommands(program);
registerMsgCommands(program);

// ── ask alias (script-friendly one-shot query) ──
program
  .command('ask <text...>')
  .description('Alias for `elanous chat --new`: send one query and print the reply')
  .option('--reuse', 'Reuse the active CLI session instead of creating a new one')
  .option('--session <id>', 'Continue an explicit session (id or unique prefix). Overrides --reuse and active session.')
  .option('--json', 'Emit a single JSON line {sessionId, provider, model, reply, logPath, budget} instead of streaming text + ui.info trailer. Stable shape for LLM self-spawn.')
  .option('--bare', 'Send only this text to the model: no Elanous preamble, project tree, memory, tools or session')
  .action(async (parts: string[], opts: { reuse?: boolean; session?: string; json?: boolean; bare?: boolean }) => {
    if (opts.bare) {
      try {
        const { askBare } = await import('./cli/ask-bare.js');
        const llm = await import('./llm.js');
        const { getUserConfig } = await import('./user-config.js');
        const { trimToBudget } = await import('./tokens.js');
        const result = await askBare({ text: parts.join(' '), deps: {
          getUserConfig, decideProviderForConfig: llm.decideProviderForConfig, getProviderForConfig: llm.getProviderForConfig,
          streamLLM: llm.streamLLM, trimToBudget,
        } });
        if (opts.json) process.stdout.write(JSON.stringify({ sessionId: null, ...result, logPath: null, budget: null, bare: true }) + '\n');
        else process.stdout.write(result.reply.endsWith('\n') ? result.reply : `${result.reply}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) process.stdout.write(JSON.stringify({ error: message, bare: true }) + '\n');
        else console.error(`ask --bare failed: ${message}`);
        process.exitCode = 1;
      }
      return;
    }
    const cfg = reloadUserConfig();
    await runChatTurnCli({
      cfg,
      userText: parts.join(' '),
      explicitSessionId: opts.session,
      reuseActive: opts.reuse === true,
      forceNew: false,
      json: opts.json === true,
    });
  });

function walkDottedPath(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split('.').filter(Boolean)) {
    // Arrays are traversable too: a numeric part indexes the element
    // (`arr["0"]`), so `telegram.channels.0.botUsername` resolves instead
    // of bailing at the array (2026-07-22 모순 수복 — GET/verify 대칭).
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// FU1 (PLAN-config-unification-elanous-root-2026-05-10 closing follow-up):
//   typed UserConfig 의 sub-schema 가 모든 사용자 nested key 를 정의하지
//   않는다 (예: voice.stt.language). buildUserConfig 가 그것을 cfg.raw
//   에 보존하므로, dotted-path resolver 가 typed walk 후 undefined 면
//   raw 로 폴백한다.
function getConfigPath(root: Record<string, unknown>, path: string): unknown {
  const direct = walkDottedPath(root, path);
  if (direct !== undefined) return direct;
  const raw = (root as { raw?: unknown }).raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return walkDottedPath(raw, path);
  }
  return undefined;
}

function setConfigPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('config path must be non-empty');
  const isIndex = (s: string): boolean => /^\d+$/.test(s);
  const writeInto = (target: Record<string, unknown>): void => {
    let current = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = current[part];
      // Preserve existing containers (objects AND arrays) so array-index
      // paths like `telegram.channels.0.botUsername` descend into the array
      // instead of clobbering it into `{}` (2026-07-22 모순 수복). Only
      // (re)create when the node is missing or a primitive; pick the
      // container type by peeking at the next key (numeric ⇒ array).
      if (next === null || next === undefined || typeof next !== 'object') {
        current[part] = isIndex(parts[i + 1]!) ? [] : {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]!] = value;
  };
  writeInto(root);
  // ★ raw 미러(2026-07-15) — saveUserConfig 직렬화기는 열거 typed 섹션 + raw 패스스루(rawRest)만 기록한다.
  //   미지 root 키(nextFluent 등)를 typed 에만 쓰면 드롭돼 no-op(실증). raw 에도 써서 rawRest 로 생존시킴
  //   (열거 키는 typed 직렬화가 우선하므로 무해). GET 의 raw 폴백(getConfigPath)과 대칭.
  const raw = (root as { raw?: unknown }).raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) writeInto(raw as Record<string, unknown>);
}

/** Remove a dotted config path — the inverse of setConfigPath (2026-07-22).
 *  Fills the set/unset asymmetry so accumulated keys can be tidied. Array
 *  indices splice (no holes); object keys delete. No-op when the path is
 *  already absent. Mirrors the deletion onto `raw` for round-trip symmetry. */
function unsetConfigPath(root: Record<string, unknown>, path: string): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('config path must be non-empty');
  const isIndex = (s: string): boolean => /^\d+$/.test(s);
  const deleteFrom = (target: Record<string, unknown>): void => {
    let current: unknown = target;
    for (const part of parts.slice(0, -1)) {
      if (current === null || current === undefined || typeof current !== 'object') return; // path absent
      current = (current as Record<string, unknown>)[part];
    }
    if (current === null || current === undefined || typeof current !== 'object') return;
    const leaf = parts[parts.length - 1]!;
    if (Array.isArray(current) && isIndex(leaf)) current.splice(Number(leaf), 1);
    else delete (current as Record<string, unknown>)[leaf];
  };
  deleteFrom(root);
  const raw = (root as { raw?: unknown }).raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) deleteFrom(raw as Record<string, unknown>);
}

function parseConfigValue(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return value; }
}

function writeSetupFailure(message: string): void {
  process.stderr.write(`setup: ${message}\n`);
  process.exitCode = 1;
}

async function runInteractiveSetup(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다.')) {
      writeSetupFailure(error.message);
      return;
    }
    throw error;
  }
}

// ── onboarding wizard ──
program
  .command('onboarding [step]')
  .description('Run the first-run wizard. Pass a step name (llm|skills|obsidian|telegram|discord|voice-ai) to run only that step.')
  .option('--config <path>', 'Load answers from a JSON answer file (overrides interactive prompts)')
  .option('--non-interactive', 'Run without prompts — resolve all answers from --config + env vars')
  .action(async (step: string | undefined, opts: { config?: string; nonInteractive?: boolean }) => {
    // C-4e (cleanup ROADMAP 2026-05-08) restricted `elanous setup <step>`
    // to llm/skills/obsidian. Telegram/Discord setup migrated to NEXUS
    // — `elanous channel-setup --platform telegram|discord` (Track Q).
    // Control plane (askControlPlane wizard step) was deleted in A-1
    // — NEXUS is in-process so no separate control-plane setup exists.
    const stepIds: OnboardingStepId[] = ['llm', 'skills', 'obsidian', 'telegram', 'discord', 'voice-ai'];
    if (step && !stepIds.includes(step as OnboardingStepId)) {
      console.error(`Unknown step "${step}". Valid: ${stepIds.join(', ')}.`);
      process.exit(2);
    }
    if (opts.nonInteractive) {
      try {
        await runOnboardingNonInteractive({ answerFilePath: opts.config });
      } catch (error) {
        if (opts.config && error instanceof Error && /^Failed to (?:read|parse) answer file /.test(error.message)) {
          let cause: unknown = error;
          while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          writeSetupFailure(`답변 파일을 읽을 수 없다 — ${opts.config}\n${message.split(/\r?\n/, 1)[0]}`);
          return;
        }
        throw error;
      }
      return;
    }
    if (step) {
      await runInteractiveSetup(() => runOnboardingStep(step as OnboardingStepId, { path: undefined }));
      return;
    }
    if (opts.config) {
      // --config without --non-interactive: pre-load the answer file as
      // initial values, but still prompt for any unset fields.
      const { loadAnswerFile } = await import('./expression/config/index.js');
      const ans = loadAnswerFile(opts.config);
      const { buildUserConfig: bld, userConfigPath: ucp } = await import('./user-config.js');
      const base = bld(ucp());
      // Shallow-merge top-level fields; nested objects merge recursively.
      const initial = { ...base, ...ans } as typeof base;
      await runInteractiveSetup(() => runOnboarding({ initial }));
      return;
    }
    await runInteractiveSetup(() => runOnboarding());
  });

// ── login (provider OAuth) ──
export function codexLoginSuccessMessage(mirrorResult?: CodexMirrorResult): string {
  const prefix = `Signed in. Tokens at ${authStorePath()}.`;
  if (mirrorResult === 'written') return `${prefix} Mirrored to ~/.codex/auth.json.`;
  if (mirrorResult === 'skipped-different-account') {
    return `${prefix} Your Codex CLI login (~/.codex/auth.json) belongs to a different account — left unchanged. To switch it, run \`elanous login openai-codex --replace-codex-cli-login\`.`;
  }
  if (mirrorResult === 'skipped-unknown-account') return `${prefix} Codex CLI login left unchanged.`;
  if (mirrorResult === 'not-created-missing-cli-fields') {
    return `${prefix} Codex CLI mirror was not created because this login response lacked its required fields; run \`codex login\` once to initialize ~/.codex/auth.json.`;
  }
  if (mirrorResult === 'write-failed') return `${prefix} Codex CLI mirror could not be written; run \`codex login\` once to initialize ~/.codex/auth.json.`;
  return prefix;
}

const loginCmd = program.command('login').description('Authenticate to an LLM provider via OAuth');

loginCmd
  .command('openai-codex')
  .description('Sign in to OpenAI Codex via the ChatGPT device-code flow')
  .option('--replace-codex-cli-login', 'if the Codex CLI (~/.codex/auth.json) is signed in to a different account, replace it with this login')
  .action(async (opts: { replaceCodexCliLogin?: boolean }) => {
    ui.header('OpenAI Codex — device-code sign-in');
    try {
      const state = await loginWithCodex({
        onProgress: (p) => {
          if (p.type === 'user_code' && p.userCode) {
            console.log('');
            console.log(`  1) Open in any browser:   ${p.loginUrl}`);
            console.log(`  2) Enter this code:       ${p.userCode}`);
            console.log('');
            console.log('  Waiting for sign-in… (Ctrl+C to cancel)');
          }
          if (p.type === 'polling' && p.pollAttempt === 1) {
            process.stdout.write('  .');
          } else if (p.type === 'polling') {
            process.stdout.write('.');
          }
          if (p.type === 'exchanging') {
            console.log('\n  Code received — exchanging for tokens…');
          }
          if (p.type === 'saved') {
            console.log('  Tokens saved.');
          }
        },
      });
      // AUTH1 — another account's Codex CLI login is left alone unless the user says to replace it.
      let mirrorResult = state.codexMirrorResult;
      if (mirrorResult === 'skipped-different-account') {
        let replace = opts.replaceCodexCliLogin === true;
        if (!replace && process.stdin.isTTY && process.stdout.isTTY) {
          const { createInterface } = await import('node:readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await rl.question('  Your Codex CLI (~/.codex/auth.json) is signed in to a different account. Replace it with this login? [y/N] ');
            replace = /^y(es)?$/i.test(answer.trim());
          } finally { rl.close(); }
        }
        if (replace) mirrorResult = saveTokens('openai-codex', state.tokens, { replaceDifferentCodexAccount: true }).codexMirrorResult;
      }
      ui.info(codexLoginSuccessMessage(mirrorResult));
      ui.info(`Expires in ~${state.tokens.expiresAt ? Math.round((state.tokens.expiresAt - Date.now()) / 60000) : '?'}min; auto-refresh on next use.`);
    } catch (err: any) {
      ui.error(`login failed: ${err?.message ?? err}`);
      console.log(`If the browser didn't open, navigate manually to ${CODEX_DEVICE_LOGIN_URL}.`);
      process.exit(1);
    }
  });

loginCmd
  .command('status')
  .description('List providers that have OAuth tokens on file')
  .action(() => {
    const names = listAuthProviders();
    if (names.length === 0) {
      ui.info('No OAuth tokens stored. Try `elanous login openai-codex`.');
      return;
    }
    ui.header('OAuth providers');
    for (const name of names) {
      const state = loadTokens(name)!;
      const exp = state.tokens.expiresAt;
      const when = exp
        ? (Date.now() > exp ? 'EXPIRED' : `~${Math.round((exp - Date.now()) / 60000)}min left`)
        : 'no expiry';
      console.log(`  ${name.padEnd(14)} ${state.authMode ?? '-'}  refreshed ${state.lastRefresh}  (${when})`);
    }
  });

loginCmd
  .command('logout <provider>')
  .description('Forget OAuth tokens for a provider')
  .action((provider: string) => {
    const ok = deleteTokens(provider);
    ui.info(ok ? `forgot ${provider}` : `no tokens on file for ${provider}`);
  });

// ── session management ──
async function writeSessionListJson(value: unknown): Promise<void> {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
}

const sessionCmd = program.command('session').description('Manage conversation sessions');

sessionCmd
  .command('list')
  .description('List recent sessions (empty 0msg sessions hidden by default — active kept)')
  .option('-n, --limit <n>', 'Max sessions to show', '20')
  .option('--source <src>', 'Filter TO a source: cli | telegram | discord | pwa | tui | voice | unknown')
  .option('--exclude-source <list>', 'Exclude source(s), comma-separated (e.g. cli)')
  .option('--instance <name>', 'Filter by creating instance: prod | test:<repo>')
  .option('--min-msg <n>', 'Only sessions with at least N messages')
  .option('--all', 'Include empty (0msg) sessions — missions·"(new session)"·scratch (hidden by default)')
  .option('--all-instances', 'Federate sessions across ALL registered elanous instances (fleet · read-only union · §10)')
  .option('--include-test', 'Include isolated test instances in --all-instances federation (excluded by default)')
  .option('--json', 'Output the session array as machine-readable JSON')
  .option('--no-preview', 'Hide the last-message snippet under each session')
  // ⛔ `-r` 은 값을 받지 않는다 — default 북마크만. 이름은 `--remote <name>` 으로만 준다.
  .option('-r', 'list sessions on the default remote bookmark (does not take a value)')
  .option('--remote <name>', 'list sessions on a named remote bookmark via GET /v1/sessions/store')
  .option('--timeout <ms>', 'Remote GET /v1/sessions/store deadline in milliseconds (default 20000)')
  .action(async (opts) => {
    const { resolveSessionListRemoteFlag, runSessionListRemote } = await import('./cli/session-list-remote.js');
    const remoteFlag = resolveSessionListRemoteFlag(opts);
    if (remoteFlag !== undefined) {
      const timeoutRaw = opts.timeout !== undefined ? Number.parseInt(String(opts.timeout), 10) : undefined;
      const result = await runSessionListRemote({
        remote: remoteFlag,
        allInstances: opts.allInstances === true,
        json: opts.json === true,
        ...(timeoutRaw !== undefined ? { timeoutMs: timeoutRaw } : {}),
      });
      // Natural return lets stdout/stderr drain; process.exit() can truncate a large remote list.
      process.exitCode = result.exitCode;
      return;
    }
    const limit = parseInt(opts.limit, 10);
    if (opts.source !== undefined && !isSessionSource(opts.source)) {
      throw new Error(`invalid session source "${opts.source}"; expected cli | telegram | discord | pwa | tui | voice | unknown`);
    }
    const source = opts.source;
    const originInstance = opts.instance as string | undefined;
    // fleet 연합 — 등록 인스턴스 전체 세션 union(§10). 단일 인스턴스 조회와 분기.
    if (opts.allInstances) {
      const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
      const mm = opts.minMsg != null ? parseInt(opts.minMsg, 10) : undefined;
      const r = await dispatchSessionQuery({
        action: 'list', allInstances: true,
        ...(source ? { source } : {}),
        ...(mm != null ? { minMessages: mm } : {}),
        ...(opts.all ? { all: true } : {}),
        ...(opts.includeTest ? { includeTest: true } : {}),
        limit: parseInt(opts.limit, 10),
      }) as { sessions: Array<Record<string, unknown>>; instances?: string[]; count: number; note?: string };
      if (opts.json) { await writeSessionListJson(r.sessions); return; }
      if (!r.sessions.length) { ui.info(r.note ?? '연합 세션 없음'); return; }
      ui.header(`Fleet sessions (${r.count} · ${(r.instances ?? []).length} instances: ${(r.instances ?? []).join(', ')})`);
      for (const s of r.sessions) {
        const when = String(s.updatedAt).replace('T', ' ').replace(/:\d{2}\.\d+Z$/, '');
        console.log(`  ${String(s.id).slice(0, 8)}  ${when}  ${String(s.instance ?? '?').padEnd(20)} ${String(s.messageCount ?? 0).padStart(3)}msg  ${s.title ?? ''}`);
      }
      ui.info(ui.dim(r.note ?? ''));
      return;
    }
    const excludeSources = typeof opts.excludeSource === 'string'
      ? opts.excludeSource.split(',').map((s: string) => s.trim()).filter(isSessionSource)
      : undefined;
    const minMessages = opts.minMsg != null ? parseInt(opts.minMsg, 10) : undefined;
    const active = getActiveSessionId();
    // 전체(필터 적용·미숨김·미제한)로 뽑아 숨김 개수 산출 후 표시분 slice.
    const base = listSessions({
      ...(source ? { source } : {}),
      ...(originInstance ? { originInstance } : {}),
      ...(excludeSources ? { excludeSources } : {}),
      ...(minMessages != null ? { minMessages } : {}),
      // 운영 크론 실행(sourceKind:'scheduled')은 기본 숨김 — 사용자 대화 목록 오염 방지.
      // --all 로 포함(빈 세션 표시와 동일 토글).
      ...(opts.all ? {} : { excludeSourceKinds: ['scheduled'] as const }),
    });
    // 기본: 빈(0msg) 세션 전부 숨김(내용 없음) · 활성 세션은 예외로 유지 · --all 로 전체.
    const visible = opts.all
      ? base
      : base.filter((m) => m.messageCount > 0 || m.id === active);
    const hidden = base.length - visible.length;
    const rows = visible.slice(0, limit);
    if (opts.json) { await writeSessionListJson(rows); return; }
    if (rows.length === 0) {
      ui.info(hidden > 0
        ? `표시할 세션 없음 (빈 세션 ${hidden}건 숨김 · --all 로 표시).`
        : 'No sessions yet. Start one with `elanous session new` or run the dashboard.');
      return;
    }
    ui.header(`Sessions (${rows.length}${rows.length < visible.length ? `/${visible.length}` : ''})`);
    for (const s of rows) {
      const flag = s.id === active ? '*' : ' ';
      const when = s.updatedAt.replace('T', ' ').replace(/:\d{2}\.\d+Z$/, '');
      const inst = s.originInstance && s.originInstance !== 'prod' ? ` [${s.originInstance}]` : '';
      console.log(`${flag} ${s.id.slice(0, 8)}  ${when}  ${s.source.padEnd(8)} ${s.messageCount.toString().padStart(3)}msg  ${s.title}${inst}`);
      // 마지막 대화 1줄 스니펫(기본 on · 빈 세션은 없음).
      if (opts.preview && s.messageCount > 0) {
        const last = lastConversationMessage(s.id);
        if (last) {
          const text = last.content.replace(/\s+/g, ' ').trim().slice(0, 96);
          console.log(ui.dim(`             ↳ ${last.role}: ${text}${last.content.length > 96 ? '…' : ''}`));
        }
      }
    }
    if (hidden > 0) ui.info(ui.dim(`+ ${hidden} empty session(s) hidden · --all 로 표시`));
  });

sessionCmd
  .command('new')
  .description('Create a fresh session and mark it active')
  .action(() => {
    const cfg = getUserConfig();
    const s = ensureCliSession(cfg);
    setActiveSessionId(s.id);
    ui.info(`Created session ${s.id.slice(0, 8)} (marked active).`);
  });

sessionCmd
  .command('resume <prefix>')
  .description('Load a session by full id or unique id prefix and mark it active')
  .action((prefix: string) => {
    const id = resolveSessionId(prefix);
    if (!id) {
      ui.error(`no session matching "${prefix}"`);
      process.exit(1);
    }
    setActiveSessionId(id);
    const loaded = loadSession(id)!;
    ui.info(`Active: ${id.slice(0, 8)}  ${loaded.meta.messageCount} messages  ${loaded.meta.title}`);
  });

sessionCmd
  .command('show [prefix]')
  .description('Print the messages of a session (default: active)')
  .option('--include-tools', 'Include tool-call telemetry (role:tool · 실제 호출 도구·args·result 추적)')
  .action((prefix: string | undefined, opts: { includeTools?: boolean }) => {
    const id = prefix ? resolveSessionId(prefix) : getActiveSessionId();
    if (!id) { ui.error('no session'); process.exit(1); }
    const loaded = loadSession(id);
    if (!loaded) { ui.error(`not found: ${id}`); process.exit(1); }
    ui.header(`${loaded.meta.title}  (${loaded.meta.id})`);
    console.log(`${sessionBudget(id)}  ${loaded.meta.messageCount} messages`);
    console.log('');
    const asStr = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v);
    for (const m of loaded.messages) {
      // tool = 도구 텔레메트리(추적성) — 기본 제외(노이즈)·--include-tools 로 표시.
      if (m.role === 'tool' && !opts.includeTools) continue;
      console.log(`── ${m.role} @ ${m.ts} ──`);
      if (m.role === 'tool') {
        console.log(`⚙️ ${m.toolName ?? '(tool)'}`);
        if (m.toolArgs !== undefined) console.log(`  args: ${asStr(m.toolArgs)}`);
        if (m.toolResult !== undefined) console.log(`  result: ${asStr(m.toolResult)}`);
      } else {
        console.log(m.content);
      }
      console.log('');
    }
  });

sessionCmd
  .command('compact [prefix]')
  .description('Force-compact a session history NOW — bypasses the auto token-ratio gate and runs the full pipeline incl. Layer3 LLM summarize. External on-demand trigger (default: active session · forced by default).')
  .option('--force', 'Compact unconditionally, bypassing the token-ratio gate (this is the default for this command)')
  .option('--auto', 'Respect the auto token-ratio gate instead of forcing (no-op below threshold)')
  .option('--test', '격리 테스트 스토어를 대상으로 (ELANOUS_STATE_DIR)')
  .action(async (prefix: string | undefined, opts: { force?: boolean; auto?: boolean; test?: boolean }) => {
    if (opts.test && !process.env.ELANOUS_STATE_DIR) {
      const { DEFAULT_TELEGRAM_TEST_STATE_DIR } = await import('./telegram-test-runner.js');
      process.env.ELANOUS_STATE_DIR = DEFAULT_TELEGRAM_TEST_STATE_DIR;
    }
    const id = prefix ? resolveSessionId(prefix) : getActiveSessionId();
    if (!id) { ui.error('no session'); process.exit(1); }
    const loaded = loadSession(id);
    if (!loaded) { ui.error(`not found: ${id}`); process.exit(1); }
    const { compactSessionHistory } = await import('./session/compact-session.js');
    const { getUserConfig } = await import('./user-config.js');
    const cfg = getUserConfig();
    ui.header(`Compact ${id}  (${loaded.messages.length} messages · mode: ${opts.auto ? 'auto' : 'force'})`);
    const r = await compactSessionHistory(id, {
      config: cfg.chat.autoCompact,
      ...(cfg.llm.model ? { modelId: cfg.llm.model } : {}),
      force: !opts.auto,
    });
    if (r.fired) {
      console.log(`✓ compacted: ${r.before} → ${r.after} messages · Layer3=${r.layer3Applied} · ratio was ${r.ratio.toFixed(2)} · overflow-retries=${r.overflowRetries}`);
    } else {
      console.log(`· no-op: ${r.reason} · ${r.before} messages · ratio ${r.ratio.toFixed(2)}`);
    }
  });

sessionCmd
  .command('watch [prefix]')
  .description('Live-tail a session — 새 메시지를 실시간 렌더 (default: 가장 최근 활성 세션)')
  .option('--debug', '툴콜(role:tool · ⚙️ toolName·args·result)까지 표시 — 진행 중 도구 호출을 라이브로')
  .option('--from-start', '기존 전사 전체를 먼저 출력 (기본: 최근 몇 개만 보여주고 팔로우)')
  .option('--tail <n>', '팔로우 전에 보여줄 최근 메시지 수 (기본 5)', (v: string) => parseInt(v, 10))
  .option('--test', `테스트 봇 격리 스토어를 본다 (ELANOUS_STATE_DIR → ~/.elanous/telegram-test). \`elanous telegram-test\`가 쓰는 세션`)
  .action(async (prefix: string | undefined, opts: { debug?: boolean; fromStart?: boolean; tail?: number; test?: boolean }) => {
    // --test: point ALL store resolution at the test bot's isolated state
    // BEFORE any session is resolved. Path fns read the env lazily, so
    // setting it here is sufficient (same store `elanous telegram-test` writes).
    if (opts.test && !process.env.ELANOUS_STATE_DIR) {
      const { DEFAULT_TELEGRAM_TEST_STATE_DIR } = await import('./telegram-test-runner.js');
      process.env.ELANOUS_STATE_DIR = DEFAULT_TELEGRAM_TEST_STATE_DIR;
    }
    let id: string | null = null;
    if (prefix) {
      try { id = resolveSessionId(prefix); }
      catch { ui.error(`ambiguous or unknown prefix "${prefix}"`); process.exit(1); }
    } else {
      // No prefix → the session that's live RIGHT NOW = the most-recently
      // updated one. The index is bubbled-to-front on every append, so
      // listSessions()[0] is whatever was written last. (Preferred over
      // getActiveSessionId, which tracks TUI focus and can be stale vs.
      // a telegram/autopilot session actively being written.)
      //
      // Under --test the active-session pointer is NOT state-dir-scoped (it
      // tracks the prod TUI), so borrowing it would leak a prod id into the
      // isolated store. Restrict to listSessions of the redirected store.
      id = listSessions({ limit: 1 })[0]?.id ?? (opts.test ? null : (getActiveSessionId() ?? null));
      if (!id && opts.test) {
        ui.error('테스트 스토어에 세션이 없습니다 — 테스트 봇에 메시지를 먼저 보내세요.');
        process.exit(1);
      }
    }
    if (!id) { ui.error('no session to watch'); process.exit(1); }
    const { watchSession } = await import('./session/watch.js');
    await watchSession(id, { debug: opts.debug, fromStart: opts.fromStart, tail: opts.tail });
  });

sessionCmd
  .command('delete <prefix>')
  .description('Delete a session (by id or prefix)')
  .action((prefix: string) => {
    const id = resolveSessionId(prefix);
    if (!id) { ui.error(`no session matching "${prefix}"`); process.exit(1); }
    const ok = deleteSession(id);
    ui.info(ok ? `deleted ${id.slice(0, 8)}` : 'nothing to delete');
  });

// Bulk cleanup of polluted / cruft sessions (e.g. leaked test fixtures from the
// 2026-07-09 isolation break — OH1). DRY-RUN by default; --apply to delete.
// Requires at least one narrowing filter and never touches the active session.
sessionCmd
  .command('purge')
  .description('Bulk-delete sessions by filter (DRY-RUN by default · --apply to delete · 파괴적·복구불가)')
  .option('--titles <list>', 'Exact-title matches, comma-separated (e.g. "err-test,stream-test,old")')
  .option('--title-contains <s>', 'Substring title match (case-insensitive)')
  .option('--empty', 'Only 0-message sessions ("(new session)" spawns 등)')
  .option('--before <iso>', 'Only sessions with updatedAt < this ISO date')
  .option('--max-messages <n>', 'Only sessions with messageCount <= n')
  .option('--source <src>', 'Scope: cli | telegram')
  .option('--instance <name>', 'Scope by originInstance (prod | test:<repo>)')
  .option('--origin <origin>', 'Scope by surface origin (cli|pwa|tg|dc|acp)')
  .option('--apply', 'Actually delete (default is dry-run)')
  .option('--json', 'Emit JSON')
  .action(async (opts: { titles?: string; titleContains?: string; empty?: boolean; before?: string; maxMessages?: string; source?: string; instance?: string; origin?: string; apply?: boolean; json?: boolean }) => {
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const res = await dispatchSessionQuery({
      action: 'purge',
      ...(opts.titles ? { titles: opts.titles } : {}),
      ...(opts.titleContains ? { titleContains: opts.titleContains } : {}),
      ...(opts.empty ? { empty: true } : {}),
      ...(opts.before ? { before: opts.before } : {}),
      ...(opts.maxMessages !== undefined ? { maxMessages: Number(opts.maxMessages) } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.instance ? { instance: opts.instance } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.apply ? { apply: true } : {}),
    }) as { error?: string; dryRun?: boolean; matched?: number; purged?: number; byTitle?: Array<{ title: string; count: number }>; note?: string };
    if (opts.json) { await writeStdoutJson(JSON.stringify(res, null, 2) + '\n'); return; }
    if (res.error) { ui.error(res.error); process.exit(1); }
    if (res.byTitle && res.byTitle.length) {
      ui.header(res.dryRun ? 'purge (DRY-RUN) — 삭제 예정' : 'purge — 삭제됨');
      for (const { title, count } of res.byTitle) console.log(`  ${String(count).padStart(5)}  ${title}`);
    }
    ui.info(res.note ?? '');
    if (res.dryRun) ui.info('→ 확정: 같은 명령에 --apply 추가(파괴적·복구불가).');
  });

// 대화 전사 내보내기 — TUI /export 와 같은 exportSessionTranscript 순수함수 공유
// (PLAN 1-D · 단일 창구). 기본 ~/temp/elanous-transcript-<stamp>.md · 홈 밖 거부.
sessionCmd
  .command('export [prefix]')
  .description('Export a session transcript to a markdown file (default: active · ~/temp/elanous-transcript-<stamp>.md)')
  .option('--to <path>', 'Target file or directory (~ expanded · must be inside home)')
  .option('--json', 'Emit JSON')
  .action(async (prefix: string | undefined, opts: { to?: string; json?: boolean }) => {
    const { exportSessionTranscript } = await import('./session/export-transcript.js');
    try {
      const r = exportSessionTranscript({
        ...(prefix ? { sessionId: prefix } : {}),
        ...(opts.to ? { to: opts.to } : {}),
      });
      if (opts.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
      ui.info(`전사 내보냄 → ${r.path}  (${r.messages} 메시지 · ${r.lines} 줄)`);
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

// S2 (2026-07-12) — 세션 패브릭: fork with lineage. 서피스 명령(tg /fork ·
// dc !fork)과 같은 forkSessionById 헬퍼를 CLI에서도 노출 — 외부 도구
// (claude code/codex)가 세션을 갈라 병렬 탐색할 때의 진입점.
sessionCmd
  .command('fork <prefix>')
  .description('Fork a session (copies history · records forkedFromId lineage)')
  .option('--before-user <n>', 'Time-travel: truncate the copy to just BEFORE the Nth user message (codex ForkSnapshot)')
  .option('--resume', 'Set the fork as the active TUI session after forking')
  .action(async (prefix: string, opts: { beforeUser?: string; resume?: boolean }) => {
    const { forkSessionById, setActiveSessionId } = await import('./session/index.js');
    const id = resolveSessionId(prefix);
    if (!id) { ui.error(`no session matching "${prefix}"`); process.exit(1); }
    const beforeUser = opts.beforeUser !== undefined ? Number(opts.beforeUser) : undefined;
    if (beforeUser !== undefined && (!Number.isInteger(beforeUser) || beforeUser < 1)) {
      ui.error('--before-user must be a positive integer (1-based user-turn index)');
      process.exit(1);
    }
    const fork = forkSessionById(id, beforeUser !== undefined ? { beforeUser } : {});
    if (!fork) { ui.error(`session unreadable: ${id}`); process.exit(1); }
    ui.info(`⑂ forked ${id.slice(0, 8)} → ${fork.meta.id.slice(0, 8)} (${fork.messages.length} turns copied${beforeUser !== undefined ? ` · before user #${beforeUser}` : ''})`);
    if (opts.resume) {
      setActiveSessionId(fork.meta.id);
      ui.info(`active session → ${fork.meta.id.slice(0, 8)}`);
    }
  });

// Content search across session transcripts — the piece the existing
// session manager lacked. Shares dispatchSessionQuery with the
// `session_manage` core tool, so CLI (external codex/claude code shell-out)
// and in-chat tool return identical results. READ-ONLY.
sessionCmd
  .command('search <query>')
  .description('Search conversation CONTENT across sessions (source / instance / telegram filters)')
  .option('--source <src>', 'Filter by source: cli | telegram')
  .option('--instance <name>', 'Filter by creating instance: prod | test:<repo>')
  .option('--origin <origin>', 'Filter by surface origin: cli | pwa | tg | dc')
  .option('--rank', 'Sort by trigram FTS relevance (BM25 · Korean CJK · min 3 chars) instead of newest-first')
  .option('--chat <id>', 'Filter to a telegram chatId')
  .option('--thread <id>', 'Telegram forum thread id (with --chat)')
  .option('-n, --limit <n>', 'Max sessions to return (default 20)')
  .option('--json', 'Emit JSON (for programmatic / external-agent consumption)')
  .action(async (query: string, opts: { source?: string; instance?: string; origin?: string; rank?: boolean; chat?: string; thread?: string; limit?: string; json?: boolean }) => {
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const result = await dispatchSessionQuery({
      action: 'search', query,
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.instance ? { instance: opts.instance } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.rank ? { rank: true } : {}),
      ...(opts.chat ? { tgChatId: Number(opts.chat) } : {}),
      ...(opts.thread ? { tgThreadId: Number(opts.thread) } : {}),
      ...(opts.limit ? { limit: Number(opts.limit) } : {}),
    }) as { error?: string; query?: string; count?: number; ranked?: boolean; hits?: Array<{ sessionId: string; title: string; source: string; originInstance?: string; tgChatId?: number; matchCount: number; snippets: Array<{ role: string; text: string }> }> };
    if (opts.json) { await writeStdoutJson(JSON.stringify(result, null, 2) + '\n'); process.exit(result.error ? 1 : 0); }
    if (result.error) { ui.error(result.error); process.exit(1); }
    ui.header(`"${result.query}" — ${result.count} session(s)${result.ranked ? ' · 관련도순' : ''}`);
    for (const h of result.hits ?? []) {
      const tg = h.tgChatId != null ? ` tg:${h.tgChatId}` : '';
      const inst = h.originInstance && h.originInstance !== 'prod' ? `·${h.originInstance}` : '';
      console.log(`  ${h.sessionId.slice(0, 8)}  [${h.source}${tg}${inst}·${h.matchCount} match]  ${h.title}`);
      const s0 = h.snippets[0];
      if (s0) console.log(`            ${s0.role}: ${s0.text.slice(0, 120)}`);
    }
    if ((result.count ?? 0) === 0) ui.info('No sessions contain that text. Try `elanous session list` to browse.');
  });

// P2 (2026-07-16) — 동시 구독 + presence. 세션 패브릭 구독 관리를 CLI 로 노출(session_manage
// 공유 디스패처 — LLM 툴/PWA 와 동일 경로). 외부 도구가 "이 세션 나도 구독"·"누가 보고 있나".
//
// CLI 관측 배선(2026-07-16): bare CLI 프로세스는 데몬 StoreSink 를 상속 안 해 session.*
// 관측이 logs.db 에 안 닿았다(실측). 세션을 변이하는 CLI(subscribe/unsubscribe)는 데몬과
// 같은 logs.db 싱크를 붙여, 외부 codex/claude code 의 세션 조작도 `elanous logs --category
// session.*` 로 관측되게 한다(제1원칙 — 관측 없는 세션 변이 = 미완).
let _sessionCliSinkReady = false;
async function ensureSessionCliObservability(): Promise<void> {
  if (_sessionCliSinkReady) return;
  _sessionCliSinkReady = true;
  try {
    const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
    await registerStandaloneLogSink('session-cli');
  } catch { /* fail-open — 파일 트레일이 진실원 */ }
}

sessionCmd.hook('preAction', ensureSessionCliObservability);

sessionCmd
  .command('subscribe <prefix>')
  .description('Subscribe a surface to a session (concurrent multi-surface viewing)')
  .requiredOption('--surface <s>', 'cli | telegram | discord | pwa | acp | voice')
  .option('--endpoint <e>', 'surface endpoint (tg chatId · dc channelId · pwa peerId · default local)', 'local')
  .option('--ro', 'read-only (관전 · 기본 rw)')
  .action(async (prefix: string, opts: { surface: string; endpoint: string; ro?: boolean }) => {
    await ensureSessionCliObservability();   // session.* 관측이 logs.db 에 닿게
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const res = await dispatchSessionQuery({ action: 'subscribe', sessionId: prefix, surface: opts.surface, endpoint: opts.endpoint, role: opts.ro ? 'ro' : 'rw' }) as { error?: string; note?: string };
    if (res.error) { ui.error(res.error); process.exit(1); }
    ui.info(res.note ?? 'subscribed');
  });

sessionCmd
  .command('unsubscribe <prefix>')
  .description('Leave a session (removes only this subscriber · other subscribers stay)')
  .requiredOption('--surface <s>', 'cli | telegram | discord | pwa | acp | voice')
  .option('--endpoint <e>', 'surface endpoint (default local)', 'local')
  .action(async (prefix: string, opts: { surface: string; endpoint: string }) => {
    await ensureSessionCliObservability();
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const res = await dispatchSessionQuery({ action: 'unsubscribe', sessionId: prefix, surface: opts.surface, endpoint: opts.endpoint }) as { error?: string; note?: string };
    if (res.error) { ui.error(res.error); process.exit(1); }
    ui.info(res.note ?? 'unsubscribed');
  });

sessionCmd
  .command('subscribers <prefix>')
  .description('List who is currently subscribed to a session (presence)')
  .option('--json', 'Emit JSON')
  .action(async (prefix: string, opts: { json?: boolean }) => {
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const res = await dispatchSessionQuery({ action: 'subscribers', sessionId: prefix }) as { error?: string; count?: number; subscribers?: Array<{ key: string; role: string; presence: string; lastSeenAt: string }> };
    if (opts.json) { await writeStdoutJson(JSON.stringify(res, null, 2) + '\n'); process.exit(res.error ? 1 : 0); }
    if (res.error) { ui.error(res.error); process.exit(1); }
    ui.header(`Subscribers (${res.count ?? 0})`);
    for (const s of res.subscribers ?? []) console.log(`  ${s.key.padEnd(24)} [${s.role}·${s.presence}]  last ${s.lastSeenAt.slice(11, 19)}`);
    if ((res.count ?? 0) === 0) ui.info('No active subscribers.');
  });

function resolveSessionTurnPrefix(prefix: string): string {
  const id = resolveSessionId(prefix);
  if (!id) {
    ui.error(`no session matching "${prefix}"`);
    process.exit(1);
  }
  return id;
}

function formatSessionTurnQueue(queue: string[]): string {
  return queue.length === 0 ? 'empty' : queue.join(', ');
}

sessionCmd
  .command('turn <prefix>')
  .description('Show current session turn holder and FIFO wait queue (full id or unique prefix)')
  .action(async (prefix: string) => {
    const id = resolveSessionTurnPrefix(prefix);
    try {
      const result = await requestSessionTurnControl(id, 'turn');
      if (!result.holder) {
        ui.info(`Session turn is free. Queue: ${formatSessionTurnQueue(result.queue)}.`);
        return;
      }
      ui.info(`Session turn holder: ${result.holder}. Queue: ${formatSessionTurnQueue(result.queue)}.`);
    } catch (error) {
      ui.error(`session turn: ${(error as Error).message}`);
      process.exit(1);
    }
  });

async function turnOwnerKey(opts: { surface?: string; endpoint?: string }): Promise<string> {
  const { resolveSubscriberKeyInput } = await import('./domains/session-query-tool.js');
  const result = resolveSubscriberKeyInput(opts.surface, opts.endpoint);
  if ('error' in result) throw new Error(result.error);
  return result.key;
}

sessionCmd
  .command('takeover <prefix>')
  .description('Request human write ownership through the session turn arbiter (full id or unique prefix)')
  .option('--surface <s>', 'owner surface (default cli)', 'cli')
  .option('--endpoint <e>', 'owner endpoint (default local)', 'local')
  .action(async (prefix: string, opts: { surface?: string; endpoint?: string }) => {
    const id = resolveSessionTurnPrefix(prefix);
    try {
      const key = await turnOwnerKey(opts);
      const result = await requestSessionTurnControl(id, 'takeover', key);
      if (result.granted) {
        ui.info(`Session turn acquired: ${key}.`);
        return;
      }
      ui.info(`Session turn held by ${result.holder}; ${key} is waiting at position ${result.position}.`);
    } catch (error) {
      ui.error(`session takeover: ${(error as Error).message}`);
      process.exit(1);
    }
  });

sessionCmd
  .command('release <prefix>')
  .description('Return CLI-owned session turn control to the next waiter or free state (full id or unique prefix)')
  .option('--surface <s>', 'owner surface (default cli)', 'cli')
  .option('--endpoint <e>', 'owner endpoint (default local)', 'local')
  .action(async (prefix: string, opts: { surface?: string; endpoint?: string }) => {
    const id = resolveSessionTurnPrefix(prefix);
    try {
      const key = await turnOwnerKey(opts);
      const result = await requestSessionTurnControl(id, 'release', key);
      if (!result.released) {
        ui.info(`Session turn is held by ${result.holder ?? 'no one'}; ${key} has no held turn to release.`);
        return;
      }
      if (result.nextHolder) {
        ui.info(`Session turn released; promoted ${result.nextHolder}.`);
        return;
      }
      ui.info('Session turn released; it is now free.');
    } catch (error) {
      ui.error(`session release: ${(error as Error).message}`);
      process.exit(1);
    }
  });

sessionCmd
  .command('context <prefix>')
  .description('Deterministic self-cognition context — who is watching / where reachable (grounded)')
  .action(async (prefix: string) => {
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const res = await dispatchSessionQuery({ action: 'context', sessionId: prefix }) as { error?: string; formatted?: string };
    if (res.error) { ui.error(res.error); process.exit(1); }
    console.log(res.formatted ?? '(no context)');
  });

// P6 (2026-07-16) — @session:<id> 딥링크. 한 서피스가 링크 방출 → 다른 서피스가 open.
sessionCmd
  .command('link <prefix>')
  .description('Emit a shareable @session:<id> deep link for cross-surface reference')
  .action(async (prefix: string) => {
    const { resolveSessionId } = await import('./session/index.js');
    const { formatSessionDeepLink } = await import('./session/session-deeplink.js');
    const id = resolveSessionId(prefix);
    if (!id) { ui.error(`no session matching "${prefix}"`); process.exit(1); }
    console.log(formatSessionDeepLink(id));
  });

sessionCmd
  .command('open <token>')
  .description('Open an @session:<id> deep link — resolves + shows who is watching (grounded)')
  .action(async (token: string) => {
    const { dispatchSessionQuery } = await import('./domains/session-query-tool.js');
    const res = await dispatchSessionQuery({ action: 'deeplink', token }) as { found?: boolean; formatted?: string; note?: string };
    if (!res.found) { ui.error(res.note ?? 'deep link not resolved'); process.exit(1); }
    console.log(res.formatted ?? '(no context)');
  });

async function runFirstSetupForCli(cfg: ReturnType<typeof getUserConfig>, announceFallback = false): Promise<boolean> {
  if (cfg.onboarding.webFirst === true) {
    const { runWebFirstSetup } = await import('./onboarding/web-first.js');
    if (await runWebFirstSetup({ config: cfg }) === 'link-shown') return false;
    if (announceFallback) ui.info('No config yet — launching setup wizard first.');
  }
  return runOnboardingForCli();
}

async function runOnboardingForCli(): Promise<boolean> {
  try {
    await runOnboarding();
    return true;
  } catch (error) {
    if (handleOnboardingRefusal(error, 'other')) return false;
    throw error;
  }
}

function announceChatToolsCompatibility(): void {
  process.stderr.write('`chat --tools` is a compatibility entrypoint; use `elanous agent` for tool-loop calls.\n');
  debug.log('chat.tools-compatibility', 'invoked', { toolLoopEnabled: true });
  debug.flush();
}

// ── chat (single-turn helper, non-TUI) ──
program
  .command('chat <text...>')
  .description('Send one message in the active session (or a new one) and print the reply')
  .option('--new', 'Force a new session instead of using the active one')
  .option('--session <id>', 'Continue an explicit session (id or unique prefix). Overrides --new and active session.')
  .option('--json', 'Emit a single JSON line {sessionId, provider, model, reply, logPath, budget} instead of streaming text + ui.info trailer. Stable shape for LLM self-spawn.')
  .option('--tools', 'Enable the tool-loop path (Read/Grep/Glob/ListDir/Edit/Write + Bash). Default off — chat is text-only by default for backward compatibility. `elanous agent` is a thin wrapper that flips this on.')
  .option('--goal-loop', 'Arm the across-turn goal loop (runGoalLoop): wrap the tool-loop so the model keeps iterating until the goal is complete (GOAL-COMPLETE evidence gate) or maxIterations. Requires --tools. Same engine as ACP/dashboard (재발명 없음). Config `llm.goalLoop.enabled` also arms it.')
  .option('--implement', 'Bypass the harness goal-loop guard for the legacy implementation child entrypoint')
  .action(async (parts: string[], opts: { new?: boolean; session?: string; json?: boolean; tools?: boolean; goalLoop?: boolean; implement?: boolean }) => {
    if (getHarnessSpace() && opts.tools && opts.goalLoop && !opts.implement) {
      process.stderr.write('Harness chat goal-loop requires `dev --implement`; use that implementation entrypoint instead.\n');
      process.exitCode = 1;
      return;
    }
    if (opts.tools) announceChatToolsCompatibility();
    const cfg = getUserConfig();
    if (needsOnboarding(cfg)) {
      if (cfg.onboarding.webFirst !== true) ui.info('No config yet — launching setup wizard first.');
      if (!await runFirstSetupForCli(cfg, true)) return;
    }
    const refreshed = reloadUserConfig();
    // ★ 관측갭 수리(2026-07-21·제1원칙·트랙A) — self-implement 자식 goal-loop(`chat --goal-loop`)은 데몬과
    //   별개 독립 프로세스라 nexus StoreSink 를 상속 안 한다. 부모 `self implement`(위 self 커맨드)는 sink 를
    //   붙이지만 이 자식 프로세스는 자기 sink 를 등록해야 runGoalLoop 의 debug.log('goal.loop',…)
    //   (iteration/stopReason/context-pressure)가 logs.db 에 도달 → `elanous logs --category goal.loop` 로 조회 가능
    //   = elanous 가 "내 루프가 왜 멈췄나"를 스스로 관측. 부모가 심은 ELANOUS_HARNESS_SPACE_ID 를 상속한 하니스-공간
    //   자식일 때만 공간 surface(harness:<kind>)로 등록(일반 대화형 `elanous chat` 은 env 미설정 → 무영향·무회귀).
    //   line ~1022 self-implement 부모 패턴을 그대로 미러링(재발명 0·fail-open). getHarnessSpace() 는 kind 마커
    //   (ELANOUS_HARNESS_SPACE)로 판정하므로 게이트도 그 마커로(SPACE_ID 는 빈 값 가능 → id 없는 공간을 놓침).
    if (process.env.ELANOUS_HARNESS_SPACE) {
      try {
        const { getHarnessSpace, harnessSpaceSurface } = await import('./harness/harness-space.js');
        const _space = getHarnessSpace();
        if (_space) {
          await (await import('./domains/standalone-log-sink.js')).registerStandaloneLogSink(harnessSpaceSurface(_space));
        }
      } catch { /* fail-open — 관측 배선 실패가 턴을 깨지 않는다 */ }
    }
    // ★ U4b 재라우팅 — chat 턴 실행을 runDevPipeline interactive dispatch 로 통일(seam=chat-cli). chat 엔진
    //   단일 턴 엔진(runChatTurnCli)은 cfg-바인딩 클로저로 주입(순환 회피). opts→DevChatOpts 매핑은 seam.
    const { runChatCliCommand } = await import('./chat/chat-cli.js');
    await runChatCliCommand(parts.join(' '), opts, {
      runChatTurn: (text, chat) => runChatTurnCli({
        cfg: refreshed,
        userText: text,
        explicitSessionId: chat.session,
        reuseActive: !chat.forceNew,
        forceNew: chat.forceNew === true,
        json: chat.json === true,
        enableTools: chat.enableTools,
        goalLoop: chat.goalLoop,
      }),
    });
  });

// ── repl (sticky multi-turn REPL) ──
program
  .command('repl')
  .description('Sticky multi-turn REPL — same session across turns, no per-turn process boot. Drives chat / agent / scenario from one shell. Uses --new for a fresh session, --session <id> to resume, --scenario <yaml> for a scripted run, JSONL on stdin for piped automation.')
  .option('--new', 'Force a new session at boot instead of resuming the active one')
  .option('--session <id>', 'Resume an explicit session (id or unique prefix)')
  .option('--scenario <path>', 'Run a YAML multi-turn scenario before handing back to interactive (or exit)')
  .option('--replay <session-id>', 'Re-execute the user prompts from a previous session in a fresh REPL run. User prompts are extracted in order and fed through the same dispatcher as --scenario; assistant/tool messages and attachments are dropped. Mutually exclusive with --scenario.')
  .option('--exit-after-scenario', 'Exit after the scenario / replay completes (default true when stdin is not a TTY)')
  .option('--no-exit-after-scenario', 'Stay in the interactive prompt after the scenario / replay completes (TTY default)')
  .option('--json', 'Emit one JSON line per turn (sessionId/provider/model/reply/...) instead of streaming text')
  .option('--no-tools', 'Disable the tool loop and run a text-only chat REPL (parity with telegram/discord callers)')
  .option('--stdin-jsonl', 'Force JSONL-on-stdin mode even when stdin is a TTY (useful for testing automation paths)')
  .action(async (opts: {
    new?: boolean;
    session?: string;
    scenario?: string;
    replay?: string;
    exitAfterScenario?: boolean;
    json?: boolean;
    tools?: boolean;
    stdinJsonl?: boolean;
  }) => {
    if (opts.scenario && opts.replay) {
      ui.error('--scenario and --replay are mutually exclusive');
      process.exit(2);
    }
    const cfg = getUserConfig();
    if (needsOnboarding(cfg)) {
      if (cfg.onboarding.webFirst !== true) ui.info('No config yet — launching setup wizard first.');
      if (!await runFirstSetupForCli(cfg, true)) return;
    }
    const refreshed = reloadUserConfig();
    const { runRepl } = await import('./repl/index.js');
    const isTty = process.stdin.isTTY === true;
    const exitDefault = !isTty || opts.scenario !== undefined || opts.replay !== undefined;
    const exitAfterScenario = opts.exitAfterScenario === undefined ? exitDefault : opts.exitAfterScenario;
    const code = await runRepl({
      cfg: refreshed,
      initialSessionId: opts.session,
      forceNew: opts.new === true,
      enableTools: opts.tools !== false,
      scenarioPath: opts.scenario,
      replaySessionId: opts.replay,
      scriptedFromStdin: opts.stdinJsonl === true,
      jsonOutput: opts.json === true,
      exitAfterScenario,
    });
    if (code !== 0) process.exit(code);
  });

registerAgentCommands(program);

// ── Local LLM (OpenAI-compatible endpoint: LM Studio / llama.cpp / ollama) ──
//
// Distinct from `elanous provider:set local` — those manipulate user-config.
// This group is the day-to-day driver: ping the endpoint, list models,
// run the full compatibility matrix, and shortcut to `set + test` as
// a single setup command. Every subcommand reads the live endpoint
// rather than the stored config so the user can diagnose before saving.

const localCmd = program
  .command('local')
  .description('Local OpenAI-compatible LLM — ping, list, test, setup')
  .addHelpText('after', [
    '',
    'Examples:',
    '  elanous local ping  --url http://192.168.0.50:1234',
    '  elanous local models --url http://192.168.0.50:1234',
    '  elanous local test  --url http://192.168.0.50:1234 --model mlx-community/gemma-4-26b-a4b-it',
    '  elanous local setup --url http://192.168.0.50:1234 --model mlx-community/gemma-4-26b-a4b-it',
    '',
    'When --url is omitted these commands fall back to the LOCAL_LLM_URL env var,',
    'then to `llm.baseUrl` in ~/.config/elanous/config.json (set by `elanous local setup`).',
  ].join('\n'));

localCmd.hook('preAction', async () => {
  try {
    await (await import('./domains/standalone-log-sink.js')).registerStandaloneLogSink('local');
  } catch { /* fail-open — observation wiring must not block local commands */ }
});

/** Resolve the effective endpoint+model for a `local` subcommand.
 *  Priority: flag → env → user-config → error. Centralized so every
 *  subcommand surfaces the same error message on "nothing configured". */
function resolveLocalArgs(opts: { url?: string; model?: string }): { url: string; model: string } {
  const cfg = getUserConfig();
  const url = opts.url
    ?? process.env.LOCAL_LLM_URL
    ?? cfg.llm.baseUrl
    ?? '';
  const model = opts.model
    ?? process.env.LOCAL_LLM_MODEL
    ?? cfg.llm.model
    ?? '';
  if (!url) {
    ui.error('No endpoint configured. Pass --url, set LOCAL_LLM_URL, or run `elanous local setup`.');
    process.exit(2);
  }
  if (!model) {
    ui.error('No model configured. Pass --model, set LOCAL_LLM_MODEL, or run `elanous local setup`.');
    process.exit(2);
  }
  return { url, model };
}

localCmd
  .command('ping')
  .description('Check endpoint reachability (GET /v1/models)')
  .option('--url <url>', 'Base URL (e.g. http://host:1234)')
  .action(async (opts: { url?: string }) => {
    const cfg = getUserConfig();
    const url = opts.url ?? process.env.LOCAL_LLM_URL ?? cfg.llm.baseUrl;
    if (!url) {
      ui.error('No endpoint configured. Pass --url, set LOCAL_LLM_URL, or run `elanous local setup`.');
      process.exit(2);
    }
    const { resolveLocalEndpoints } = await import('./local-llm-test.js');
    const { models } = resolveLocalEndpoints(url);
    const t0 = Date.now();
    try {
      const res = await fetch(models, { signal: AbortSignal.timeout(10_000) });
      const ms = Date.now() - t0;
      if (!res.ok) {
        ui.error(`✗ ${models} → HTTP ${res.status} (${ms}ms)`);
        process.exit(1);
      }
      const body = await res.json() as { data?: Array<{ id: string }> };
      const n = Array.isArray(body.data) ? body.data.length : 0;
      ui.info(`✓ ${models} → ${n} model(s), ${ms}ms`);
    } catch (err: any) {
      ui.error(`✗ ${models}: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

localCmd
  .command('models')
  .description('List models served by the endpoint (GET /v1/models)')
  .option('--url <url>', 'Base URL')
  .action(async (opts: { url?: string }) => {
    const cfg = getUserConfig();
    const url = opts.url ?? process.env.LOCAL_LLM_URL ?? cfg.llm.baseUrl;
    if (!url) {
      ui.error('No endpoint configured. Pass --url, set LOCAL_LLM_URL, or run `elanous local setup`.');
      process.exit(2);
    }
    const { resolveLocalEndpoints } = await import('./local-llm-test.js');
    const { models } = resolveLocalEndpoints(url);
    try {
      const res = await fetch(models, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        ui.error(`HTTP ${res.status} from ${models}`);
        process.exit(1);
      }
      const body = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
      const list = Array.isArray(body.data) ? body.data : [];
      ui.header(`${list.length} model(s) @ ${models}`);
      for (const m of list) {
        console.log(`  ${m.id}${m.owned_by ? `   [${m.owned_by}]` : ''}`);
      }
    } catch (err: any) {
      ui.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

localCmd
  .command('pick')
  .description('fleet 정책 auto-pick — MLX 우선·Q4·스피드·노드 RAM 예산으로 로컬 모델 선택(관측·미션 재사용)')
  .option('--refresh', '캐시 무시하고 새로 프로브')
  .option('--json', 'JSON 출력')
  .action(async (opts: { refresh?: boolean; json?: boolean }) => {
    const { getInventory, refreshInventory } = await import('./llm/local-manager/manager.js');
    const { pickLocalModel, scoreLocalModel, DEFAULT_LOCAL_FLEET_POLICY } = await import('./llm/local-manager/pick-model.js');
    // config localFleet.nodeBudgetBytes 오버레이(raw fallback·M5 Max ≤30GB 등). 미설정=기본(무예산).
    let policy = DEFAULT_LOCAL_FLEET_POLICY;
    try {
      const c = getUserConfig() as unknown as { localFleet?: { nodeBudgetBytes?: Record<string, number>; defaultNodeBudgetBytes?: number }; raw?: { localFleet?: { nodeBudgetBytes?: Record<string, number>; defaultNodeBudgetBytes?: number } } };
      const lf = c.localFleet ?? c.raw?.localFleet;
      if (lf) policy = { ...DEFAULT_LOCAL_FLEET_POLICY, ...(lf.nodeBudgetBytes ? { nodeBudgetBytes: lf.nodeBudgetBytes } : {}), ...(lf.defaultNodeBudgetBytes ? { defaultNodeBudgetBytes: lf.defaultNodeBudgetBytes } : {}) };
    } catch { /* fail-soft */ }
    const inv = await (opts.refresh ? refreshInventory({}) : getInventory({}));
    const pick = pickLocalModel(inv, { policy });
    if (opts.json) { await writeStdoutJson(JSON.stringify({ pick, score: pick ? scoreLocalModel(pick, policy) : null }, null, 2) + '\n'); return; }
    if (!pick) { ui.info('로컬 auto-pick 후보 없음(reachable·예산 적합·비임베딩 모델 부재)'); return; }
    ui.info(`🎯 auto-pick: ${pick.id} [${pick.runtime}${pick.format ? `·${pick.format}` : ''}] @${pick.nodeId}${pick.loaded ? ' (loaded)' : ''} · score ${scoreLocalModel(pick, policy)}`);
    ui.info(`   정책: MLX 우선·Q4·스피드(MoE)${policy.nodeBudgetBytes ? ` · 노드예산 ${JSON.stringify(policy.nodeBudgetBytes)}` : ''}`);
  });
localCmd
  .command('bench [models...]')
  .description('로컬 모델 벤치마크 — 100점 루브릭(코딩50·추론30·RAG10·형식10) · 실제 Python 실행 채점 · temp0 순차. 동시성 캡 2(머신당 1로드).')
  .option('--url <base>', '단일 엔드포인트 강제(예: http://node-b:1234) — 지정 시 모든 모델을 이 엔드포인트로')
  .option('--node <id>', '특정 노드로 제한(기본: 모델을 보유한 reachable lmstudio 노드 자동)')
  .option('--loaded', '모델 인자 없이, 현재 로드된 모델 전부 벤치')
  .option('--concurrency <n>', '동시 머신 수(1~2·기본 2)', (v) => Number.parseInt(v, 10))
  .option('--max-tokens <n>', '응답 토큰 상한(기본 16384·thinking 모델 여유)', (v) => Number.parseInt(v, 10))
  .option('--repeat <n>', 'N회 반복 후 총점 중앙값 채택(런간 변동 완화·기본 1·권장 3)', (v) => Number.parseInt(v, 10))
  .option('--no-think', 'thinking off — 프롬프트에 `/no_think` 프리픽스(qwen-family·ornith·−36% wall·튜닝 스윕)')
  .option('--prompt-prefix <s>', '모든 문항 프롬프트에 프리픽스(고급 튜닝·--no-think 대체)')
  .option('--download <repo>', '없는 모델을 먼저 설치(installer HITL) 후 벤치 — --node 필수')
  .option('--runtime <rt>', '--download 런타임(lmstudio|ollama·기본 lmstudio)')
  .option('--json', 'JSONL 레코드 출력')
  .action(async (models: string[], opts: { url?: string; node?: string; loaded?: boolean; concurrency?: number; maxTokens?: number; repeat?: number; think?: boolean; promptPrefix?: string; download?: string; runtime?: string; json?: boolean }) => {
    const { getInventory, refreshInventory } = await import('./llm/local-manager/manager.js');
    const bench = await import('./llm/local-manager/benchmark/index.js');
    // 튜닝 프리픽스: --prompt-prefix 우선, 아니면 --no-think 이면 `/no_think\n`(qwen-family thinking off).
    const promptPrefix = opts.promptPrefix ?? (opts.think === false ? '/no_think\n' : undefined);
    const stripV1 = (u: string): string => u.replace(/\/v1\/?$/, '');

    // 1) --download: 없는 모델을 installer(HITL·디스크체크·lms get/ollama pull over SSH) 로 설치 후 벤치 목록에 추가.
    if (opts.download) {
      if (!opts.node) { ui.error('--download 에는 --node <id> 필수(어느 노드에 받을지).'); process.exit(2); }
      const { requestInstall } = await import('./llm/local-manager/installer.js');
      ui.info(`⬇️  ${opts.download} 설치 시도 → ${opts.node} (${opts.runtime ?? 'lmstudio'})…`);
      const r = await requestInstall({ nodeId: opts.node, runtime: (opts.runtime as any) ?? 'lmstudio', modelName: opts.download });
      if (!r.ok) { ui.error(`설치 실패(${r.reason}): ${r.message}`); process.exit(1); }
      ui.info(`✓ 설치 완료(${(r.elapsedMs / 1000).toFixed(0)}s) — 벤치 목록에 추가`);
      models = [...models, opts.download];
    }

    let inv = await getInventory({});
    if (opts.download) inv = await refreshInventory({}).catch(() => inv);

    // 2) 엔드포인트 소스: --url 강제 or 인벤토리 노드(reachable lmstudio) → {node, base}.
    const nodeEndpoints: { node: string; endpoint: string }[] = opts.url
      ? [{ node: 'custom', endpoint: stripV1(opts.url) }]
      : inv.nodes
          .filter((n) => n.reachable && n.lmstudioBaseUrl && (!opts.node || n.id === opts.node))
          .map((n) => ({ node: n.id, endpoint: stripV1(n.lmstudioBaseUrl!) }));
    if (!nodeEndpoints.length) { ui.error('벤치 대상 엔드포인트 없음(reachable lmstudio 노드/--url 확인).'); process.exit(2); }

    // 3) 모델 목록: 인자 · --loaded(로드된 모델) · 없으면 에러.
    if (!models.length && opts.loaded) {
      const loaded = new Set<string>();
      for (const m of inv.models) {
        if (!m.loaded) continue;
        if (opts.node && m.nodeId !== opts.node) continue;
        if (/embed|nomic|bge|e5-|gte-/i.test(m.id)) continue;
        loaded.add(m.id);
      }
      models = [...loaded];
    }
    if (!models.length) { ui.error('벤치할 모델을 지정하라(예: elanous local bench gemma-4-26b-a4b-it) 또는 --loaded.'); process.exit(2); }

    // 4) target 배정 — 각 모델을 그 모델을 보유한 노드에 배정(없으면 --url/첫 엔드포인트). 라운드로빈 분산.
    const servedBy = (model: string): string[] => {
      if (opts.url) return [nodeEndpoints[0]!.endpoint];
      const nodes = new Set(inv.models.filter((m) => m.id === model).map((m) => m.nodeId));
      const eps = nodeEndpoints.filter((e) => nodes.has(e.node)).map((e) => e.endpoint);
      return eps.length ? eps : nodeEndpoints.map((e) => e.endpoint);
    };
    const epCursor = new Map<string, number>();
    const targets = models.map((model) => {
      const eps = servedBy(model);
      const k = eps.join('|');
      const idx = (epCursor.get(k) ?? 0) % eps.length;
      epCursor.set(k, idx + 1);
      const endpoint = eps[idx]!;
      const node = nodeEndpoints.find((e) => e.endpoint === endpoint)?.node ?? 'custom';
      return { node, model, endpoint };
    });

    const repeat = Math.max(1, opts.repeat ?? 1);
    ui.header(`🧪 로컬 LLM 벤치 (${targets.length}종 · 100점 · 동시성 ${Math.min(2, opts.concurrency ?? 2)}${repeat > 1 ? ` · ${repeat}회 중앙값` : ''})`);
    for (const t of targets) ui.info(`  • ${t.node}:${t.model}`);

    // 4b) fleet 실행 — repeat>1 이면 N회 반복해 총점 중앙값 채택(런간 변동 완화·제1원칙: 변동성 관측).
    const runFleet = () => bench.benchmarkFleet(targets, {
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      chatTimeoutMs: 240_000,
      maxTokens: opts.maxTokens ?? 16384,
      ...(promptPrefix !== undefined ? { promptPrefix } : {}),
      onProgress: (e) => { if (e.phase === 'done') ui.info(`  [done] ${e.target.node}:${e.target.model}${e.scorecard ? ` = ${e.scorecard.total}/100${e.scorecard.saturated ? ' ⚠️포화' : ''}` : ' (실패)'}`); },
    });

    const cardsByKey = new Map<string, any[]>();
    for (let r = 0; r < repeat; r++) {
      if (repeat > 1) ui.info(`  ── run ${r + 1}/${repeat} ──`);
      const runCards = await runFleet();
      for (const c of runCards) {
        const k = bench.targetKey(c.target);
        (cardsByKey.get(k) ?? cardsByKey.set(k, []).get(k)!).push(c);
      }
    }

    // 중앙값 선택(단일 런이면 그 카드) + spread 관측. 순서는 targets 입력 순.
    const seen = new Set<string>();
    const chosen: Array<{ card: any; runs: number; spread: [number, number] }> = [];
    for (const t of targets) {
      const k = bench.targetKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      const cs = cardsByKey.get(k);
      if (!cs || !cs.length) continue;
      const { median, spread, runs } = bench.pickMedianCard(cs);
      chosen.push({ card: median, runs, spread });
    }
    const cards = chosen.map((c) => c.card);

    // 5) 영속: ~/.elanous/llm-bench.jsonl 에 레코드 append(회귀추적·미션 소비). repeat 시 runs/spread 태깅.
    try {
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { elanousStateRoot } = await import('./autopilot/state-paths.js');
      const root = elanousStateRoot();
      const path = join(root, 'llm-bench.jsonl');
      mkdirSync(root, { recursive: true });
      const at = new Date().toISOString();
      for (const c of chosen) {
        const rec = bench.scorecardToRecord(c.card, at);
        if (c.runs > 1) { rec.runs = c.runs; rec.spreadMin = c.spread[0]; rec.spreadMax = c.spread[1]; }
        appendFileSync(path, JSON.stringify(rec) + '\n');
      }
    } catch { /* fail-soft */ }

    if (opts.json) {
      for (const c of chosen) {
        const rec = bench.scorecardToRecord(c.card, new Date().toISOString());
        if (c.runs > 1) { rec.runs = c.runs; rec.spreadMin = c.spread[0]; rec.spreadMax = c.spread[1]; }
        await writeStdoutJson(JSON.stringify(rec) + '\n');
      }
      return;
    }
    console.log('\n' + cards.map(bench.formatScorecard).join('\n\n'));
    if (repeat > 1) {
      console.log('\n📈 런간 변동(spread) — 중앙값 채택:');
      for (const c of chosen) {
        const [lo, hi] = c.spread;
        console.log(`  ${c.card.target.node}:${c.card.target.model} — 중앙 ${c.card.total} · 범위 ${lo}~${hi}${hi - lo >= 10 ? ' ⚠️변동큼' : ''} (${c.runs}회)`);
      }
    }
    console.log('\n' + bench.formatRanking(cards));
  });

localCmd
  .command('scores')
  .aliases(['map', 'leaderboard'])
  .description('통합 맵 — 벤치 스코어(속도 tok/s × 용도 100점 × RAM × 노드 × tier)를 한 표로. ~/.elanous/llm-bench.jsonl 읽어 inventory RAM 조인. fleet 라우팅 근거.')
  .option('--sort <key>', '정렬: speed|coding|total|ram (기본 total)', 'total')
  .option('--best', '모델×노드별 최고 total (기본: 최근 벤치)')
  .option('--node <id>', '특정 노드로 제한')
  .option('--purpose <p>', 'best-purpose 필터: coding|reasoning|rag|format')
  .option('--budget <gb>', 'RAM 예산(GB) 초과 모델에 ! 마크(기본: config localFleet)', (v) => Number.parseFloat(v))
  .option('--refresh', 'inventory 라이브 재프로브(기본: 5분 캐시·SSH 프로브 안 함)')
  .option('--json', 'JSON 출력(프로그래매틱 소비)')
  .action(async (opts: { sort?: string; best?: boolean; node?: string; purpose?: string; budget?: number; refresh?: boolean; json?: boolean }) => {
    const { debug } = await import('./debug/log.js');
    const bench = await import('./llm/local-manager/benchmark/index.js');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { elanousStateRoot } = await import('./autopilot/state-paths.js');

    // 1) 영속 스코어 read (bench CLI 가 append 하는 JSONL) — 없으면 안내.
    const path = join(elanousStateRoot(), 'llm-bench.jsonl');
    let text = '';
    try { text = readFileSync(path, 'utf8'); }
    catch { ui.info(`스코어 파일 없음(${path}). \`elanous local bench <model>\` 로 벤치를 먼저 돌려라.`); return; }
    const split = bench.splitBenchRecords(text);
    let records = split.records;
    if (split.mismatches.length > 0) {
      // 세부 점수 합과 total 이 어긋난 레코드는 집계에서 빼고 보인다(채점 정합).
      debug.log('llm.bench.scores', 'score-total-mismatch', { count: split.mismatches.length, samples: split.mismatches.slice(0, 5) });
      ui.warn(`세부 점수 합과 total 이 어긋난 스코어 ${split.mismatches.length}건을 집계에서 뺐다 — 예: ${split.mismatches.slice(0, 3).map((m) => `${m.model}@${m.node} total ${m.total} ≠ 합 ${m.categorySum}`).join(' · ')}`);
    }
    if (opts.node) records = records.filter((r) => r.node === opts.node);
    records = bench.aggregateRecords(records, opts.best ? 'best' : 'latest');
    if (!records.length) { ui.info('집계할 스코어 없음(필터 확인).'); return; }

    // 2) inventory 조인(RAM/quant/format/loaded) — fail-soft(로컬 도달 불가여도 추정 폴백으로 진행).
    const invByModel = new Map<string, InventoryMeta>();
    try {
      const { getInventory, refreshInventory } = await import('./llm/local-manager/manager.js');
      const inv = await (opts.refresh ? refreshInventory({}) : getInventory({}));
      for (const m of inv.models) {
        const meta: InventoryMeta = {
          ...(m.sizeBytes !== undefined ? { sizeBytes: m.sizeBytes } : {}),
          ...(m.quantization !== undefined ? { quantization: m.quantization } : {}),
          ...(m.format !== undefined ? { format: m.format } : {}),
          ...(m.loaded !== undefined ? { loaded: m.loaded } : {}),
        };
        invByModel.set(m.id, meta);          // model-only 키
        invByModel.set(`${m.nodeId}:${m.id}`, meta); // node:model 키(동명 다노드 대비)
      }
    } catch (err: any) { debug.log('llm.bench.scores', 'inventory-skip', { reason: err?.message ?? String(err) }); }

    // 3) 조인 → 필터 → 정렬.
    let rows = bench.buildScoreRows(records, invByModel);
    if (opts.purpose) rows = rows.filter((r) => r.bestPurpose === opts.purpose);
    const sortKey = (['speed', 'coding', 'total', 'ram'].includes(opts.sort ?? '') ? opts.sort : 'total') as SortKey;
    rows = bench.sortRows(rows, sortKey);

    // 4) 예산: --budget > config localFleet.defaultNodeBudgetBytes(GiB→GB) > 없음.
    let budgetGb = opts.budget;
    if (budgetGb === undefined) {
      try {
        const c = getUserConfig() as unknown as { localFleet?: { defaultNodeBudgetBytes?: number }; raw?: { localFleet?: { defaultNodeBudgetBytes?: number } } };
        const b = c.localFleet?.defaultNodeBudgetBytes ?? c.raw?.localFleet?.defaultNodeBudgetBytes;
        if (b) budgetGb = b / (1024 ** 3);
      } catch { /* fail-soft */ }
    }

    debug.log('llm.bench.scores', 'map', { rows: rows.length, sort: sortKey, best: !!opts.best, node: opts.node ?? null });
    if (opts.json) { await writeStdoutJson(JSON.stringify(rows.map(bench.scoreRowToJson), null, 2) + '\n'); return; }
    console.log(bench.formatScoreMap(rows, { sort: sortKey, now: Date.now(), ...(budgetGb !== undefined ? { budgetGb } : {}) }));
  });

localCmd
  .command('inventory')
  .aliases(['inv', 'ls'])
  .description('전 노드(local + SSH 플릿) LLM 자원 자동 발견 — quad-probe(lmstudio/ollama/mlx/docker). 매니저 인벤토리를 CLI로 노출.')
  .option('--refresh', '캐시 무시하고 새로 프로브(기본: 5분 캐시)')
  .option('--json', 'JSON 출력(프로그래매틱 소비)')
  .action(async (opts: { refresh?: boolean; json?: boolean }) => {
    const { getInventory, refreshInventory } = await import('./llm/local-manager/manager.js');
    try {
      const inv = await (opts.refresh ? refreshInventory({}) : getInventory({}));
      if (opts.json) { await writeStdoutJson(JSON.stringify(inv, null, 2) + '\n'); return; }
      ui.header(`LLM 인벤토리 — ${inv.nodes.length} 노드 · ${inv.models.length} 모델${inv.cached ? ' (캐시·--refresh 로 갱신)' : ''}`);
      for (const n of inv.nodes) {
        const reach = n.reachable ? '🟢' : (n.reachable === false ? '🔴' : '⚪');
        const rts = n.runtimes.length ? n.runtimes.join(',') : '-';
        const where = n.isLocal ? 'local' : (n.sshHost ?? n.id);
        console.log(`\n${reach} ${n.label} (${where}) · ${rts}${n.description ? ` · ${n.description}` : ''}`);
        const nodeModels = inv.models.filter((m) => m.nodeId === n.id);
        if (!nodeModels.length) { console.log('    (모델 없음)'); continue; }
        for (const m of nodeModels) console.log(`    ${m.loaded ? '●' : '○'} ${m.label}   [${m.runtime}]`);
      }
      if (inv.warnings.length) {
        console.log(`\n⚠️  ${inv.warnings.length} warning(s):`);
        for (const w of inv.warnings.slice(0, 8)) console.log(`    ${w}`);
      }
    } catch (err: any) {
      ui.error(err?.message ?? String(err));
      process.exit(1);
    }
  });

localCmd
  .command('test')
  .description('Run the compatibility matrix against the endpoint')
  .option('--url <url>', 'Base URL (e.g. http://host:1234)')
  .option('--model <id>', 'Model id to probe')
  .option('--timeout <ms>', 'Per-probe timeout (default 60000)', (v) => Number(v))
  .option('--skip-vision', 'Skip the vision probe (faster when model is text-only)')
  .action(async (opts: { url?: string; model?: string; timeout?: number; skipVision?: boolean }) => {
    const { url, model } = resolveLocalArgs(opts);
    const { runLocalLLMCompat, renderCompatMatrix } = await import('./local-llm-test.js');
    ui.header(`local LLM compat — ${url}`);
    console.log(`model: ${model}`);
    console.log('');
    const summary = await runLocalLLMCompat({
      baseUrl: url,
      model,
      timeoutMs: opts.timeout ?? 60_000,
      skip: opts.skipVision ? { vision: true } : undefined,
      onProgress: (r) => {
        const status = r.status === 'pass' ? '\u2713'
                     : r.status === 'fail' ? '\u2717'
                     : '\u2027';
        const ms = r.ms > 0 ? `${r.ms}ms`.padStart(6) : '      ';
        console.log(`  ${status} ${r.label.padEnd(24)}  ${ms}  ${r.detail ?? ''}`);
      },
    });
    console.log('');
    console.log(`total: ${summary.results.length}   pass=${summary.counts.pass}  fail=${summary.counts.fail}  skip=${summary.counts.skip}  (${summary.totalMs}ms)`);
    process.exit(summary.counts.fail > 0 ? 1 : 0);
  });

localCmd
  .command('chat <prompt...>')
  .description('One-shot chat through the full elanous provider stack (integration smoke)')
  .option('--url <url>', 'Override base URL for this call')
  .option('--model <id>', 'Override model id for this call')
  .action(async (prompt: string[], opts: { url?: string; model?: string }) => {
    const { url, model } = resolveLocalArgs(opts);
    // Build a one-shot provider using the SAME path as dashboard/chat:
    // user-config → getProviderForConfig → streamChat. This is the
    // integration-smoke part of the CLI — if this prints text, the
    // whole provider stack (config schema, route, wire format, SSE
    // parse) is working for 'local'.
    const { buildUserConfig } = await import('./user-config.js');
    const { resolveLocalEndpoints: _rle } = await import('./local-llm-test.js');
    const cfg = buildUserConfig('/tmp/__elanous-local-test-cfg.nonexistent');  // defaults
    // Normalize `http://host:1234` → `http://host:1234/v1` so the
    // provider's `${baseUrl}/chat/completions` concatenation lands on
    // the right path. LM Studio + llama.cpp serve at /v1 by default.
    cfg.llm = { provider: 'local', model, baseUrl: _rle(url).base };
    const { getProviderForConfig } = await import('./llm.js');
    const provider = getProviderForConfig(cfg);
    ui.header(`${provider.name} @ ${url}  /  ${model}`);
    const text = prompt.join(' ');
    console.log(`> ${text}`);
    console.log('');
    let out = '';
    for await (const delta of provider.chat(
      [{ role: 'user', content: text }],
      { temperature: 0, maxTokens: 256 },
    )) {
      process.stdout.write(delta);
      out += delta;
    }
    console.log('');
    if (!out.trim()) {
      ui.error('(empty response)');
      process.exit(1);
    }
  });

localCmd
  .command('setup')
  .description('Save endpoint + model to ~/.config/elanous/config.json (provider=local)')
  .option('--url <url>', 'Base URL (e.g. http://192.168.0.50:1234)')
  .option('--model <id>', 'Model id (e.g. mlx-community/gemma-4-26b-a4b-it)')
  .option('--api-key <key>', 'Optional bearer token for the endpoint')
  .option('--no-activate', 'Save fields but do not switch provider to local')
  .option('--rotate-label <label>', 'Also add as rotation entry with this label')
  .action(async (opts: { url?: string; model?: string; apiKey?: string; activate?: boolean; rotateLabel?: string }) => {
    const url = opts.url ?? process.env.LOCAL_LLM_URL;
    const model = opts.model ?? process.env.LOCAL_LLM_MODEL;
    if (!url || !model) {
      ui.error('Both --url and --model are required (or LOCAL_LLM_URL + LOCAL_LLM_MODEL env vars).');
      process.exit(2);
    }
    const cfg = getUserConfig();
    const bakPath = backupConfigPath();
    const backedUp = backupUserConfig();
    // Normalize once at save time so every downstream consumer
    // (dashboard, telegram, skill-runner) gets `/v1`-normalized URLs
    // without repeating the resolve-on-read dance.
    const { resolveLocalEndpoints: _rle2 } = await import('./local-llm-test.js');
    const normUrl = _rle2(url).base;
    if (opts.activate !== false) {
      cfg.llm.provider = 'local';
      cfg.llm.baseUrl = normUrl;
      cfg.llm.model = model;
      if (opts.apiKey) cfg.llm.apiKey = opts.apiKey;
    }
    if (opts.rotateLabel) {
      const next = addRotationEntry(cfg, {
        provider: 'local', baseUrl: normUrl, model,
        apiKey: opts.apiKey, label: opts.rotateLabel,
      });
      Object.assign(cfg, next);
    }
    saveUserConfig(cfg);
    reloadUserConfig();
    ui.info(`✓ saved to ${userConfigPath()}`);
    ui.info(`  provider = ${cfg.llm.provider}`);
    ui.info(`  baseUrl  = ${url}`);
    ui.info(`  model    = ${model}`);
    if (opts.rotateLabel) ui.info(`  rotation += ${opts.rotateLabel}`);
    if (backedUp) ui.info(`  backup   = ${bakPath}  (restore via \`elanous provider:restore\`)`);
    console.log('');
    ui.info(`Next: \`elanous local ping\` to verify, then \`elanous local test\` for the full matrix.`);
  });

function emitSchedulerRetirementNotice(family: 'scheduler'): void {
  ui.error(`[elanous ${family}] retired in scheduler-retirement ROADMAP §R1.`);
  ui.info('Use `elanous wf` for workflow management (workflow-runtime DAG · supersedes scheduler v2).');
  process.exit(1);
}

// ── Scheduler CLI · retired (scheduler retirement ROADMAP §R1) ──
//
// `elanous scheduler` / `elanous sched` family retired. Scheduling becomes
// a workflow-runtime Schedule Trigger node (R2 daemon v2 wires real
// cron tick). For now, route users to `elanous wf`.
program
  .command('scheduler [args...]')
  .alias('sched')
  .description('Retired — scheduling is now a workflow-runtime Schedule Trigger node (`elanous wf`)')
  .allowUnknownOption(true)
  .action(() => emitSchedulerRetirementNotice('scheduler'));

// ── elanous attach — minimal ACP client for daemon smoke + scripting (MVP M1.3) ──
//
// Connects to a running `elanous serve` daemon and runs a single
// prompt round-trip. Useful for:
//   - Smoke testing a freshly-started daemon
//   - Shell scripts / cron one-shot prompts
//   - Verifying the TUI/Daemon split actually works end-to-end
//     before dashboard-side attach mode lands (M1.5)
//
// Full dashboard attach (the eventual `monad-agent --attach` default
// behaviour) requires moving message history + tool dispatch into the
// daemon — tracked under M1.5 / U6 in PLAN-tui-daemon-process-split-mvp.md.
program
  .command('attach')
  .description(
    'ACP client for the running elanous daemon. Three modes: handshake-only (default), one-shot (--message), interactive REPL (--interactive). Local (unix socket) or remote (--host / --url) over Tailscale.',
  )
  .option('--socket <path>', 'Override the unix socket path (default: ~/.elanous/elanous.sock)')
  .option('--host <hostport>', 'Remote daemon host:port (e.g. laptop.tailnet:31415). Coerced to ws://<hostport>/v1/acp.')
  .option('--url <wsurl>', 'Remote daemon WS URL (e.g. ws://host:31415/v1/acp). Overrides --host.')
  .option('-r, --remote [name]', 'Bookmark name (`-r` alone = default). Fills host/token-file; explicit --url/--host/--token/--token-file win.')
  .option('--token <token>', 'Bearer token for remote auth. Overrides --token-file and ELANOUS_TOKEN.')
  .option('--token-file <path>', 'Read bearer token from this file (e.g. ~/.elanous/acp-token scp\'d from the daemon).')
  .option('--no-auth', 'Skip token handshake (Tailscale-only mode; daemon must run with --no-http-auth).')
  .option('--label <name>', 'Best-effort client label sent in the auth handshake (debug log only).')
  .option('--session <id>', 'M2.3 — attach to an EXISTING session id (loaded via ACP session/load) instead of minting a new one. Daemon must know the id (use /list on a prior session to discover).')
  .option('--message <text>', 'Send this user message and print the streamed response')
  .option('--assert-text-contains <text...>', 'Assert: final assistant text MUST include this substring (repeatable; one-shot only)')
  .option('--assert-tool-min <spec...>', 'Assert: daemon tool fired ≥N times. Format: ToolName=N (one-shot only)')
  .option('--assert-tool-max <spec...>', 'Assert: daemon tool fired ≤N times. Format: ToolName=N (one-shot only)')
  .option('-i, --interactive', 'Start an interactive REPL — type messages, get streamed responses (slash commands: /quit /new /list /help)')
  .option('--cwd <path>', 'Working directory reported in newSession()', process.cwd())
  .action(async (opts: {
    socket?: string;
    host?: string;
    url?: string;
    token?: string;
    tokenFile?: string;
    auth?: boolean;     // commander sets `auth: false` when --no-auth supplied
    /** `-r, --remote [name]` — commander gives `true` for a bare `-r`
     *  (⇒ default bookmark) and the name string when one is supplied. */
    remote?: string | boolean;
    label?: string;
    session?: string;
    message?: string;
    assertTextContains?: string[];
    assertToolMin?: string[];
    assertToolMax?: string[];
    interactive?: boolean;
    cwd: string;
  }) => {
    const hasAssertions = Boolean(
      opts.assertTextContains?.length || opts.assertToolMin?.length || opts.assertToolMax?.length,
    );
    if (hasAssertions && (!opts.message || opts.interactive)) {
      throw new Error('--assert-* options require --message and cannot be used with --interactive');
    }
    const assertToolMin = parseToolCountSpec(opts.assertToolMin, '--assert-tool-min');
    const assertToolMax = parseToolCountSpec(opts.assertToolMax, '--assert-tool-max');

    const { DashboardSession } = await import('./tui-client/dashboard-session.js');
    const { resolveRemoteTarget } = await import('./tui-client/remote-target.js');

    // ⭐ `attach -r <name>` — 이 명령 «자신»이 북마크를 편다.
    //    ⛔ 전역 선처리는 «루트 선행 플래그»만 본다(remote-resolve.ts) — 안 그러면
    //       `autopilot link … -r friend` 같은 다른 명령의 `-r` 을 «탈취»한다(실측).
    //       그래서 서브커맨드 자리의 `-r` 은 여기서 처리해야 한다.
    let bookmarkHost: string | undefined;
    let bookmarkTokenFile: string | undefined;
    if (opts.remote !== undefined) {
      const { RemotesStore } = await import('./cli/remotes.js');
      const { bookmarkAttachDefaults } = await import('./cli/remote-resolve.js');
      const store = new RemotesStore();
      const named = typeof opts.remote === 'string' && opts.remote.length > 0 ? opts.remote : undefined;
      const entry = named ? store.getRemote(named) : store.getDefaultRemote();
      if (!entry) {
        throw new Error(named
          ? `--remote ${named}: unknown bookmark. Run \`elanous nexus list\` to see available remotes.`
          : 'no default remote bookmark. Run `elanous nexus connect <host> --default` to set one.');
      }
      const defaults = bookmarkAttachDefaults(entry);
      bookmarkHost = defaults.host;
      bookmarkTokenFile = defaults.tokenFile;
    }

    // Resolve transport — remote (ws) takes precedence when --host /
    // --url / ELANOUS_REMOTE is provided; otherwise fall back to local
    // unix socket (existing behavior, preserved for backward compat).
    // ⭐ 명시 인자가 북마크를 «이긴다» — 아래 순서가 그것을 보장한다.
    const remote = await resolveRemoteTarget({
      ...(bookmarkHost ? { host: bookmarkHost } : {}),
      ...(bookmarkTokenFile ? { tokenFile: bookmarkTokenFile } : {}),
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.tokenFile ? { tokenFile: opts.tokenFile } : {}),
      noAuth: opts.auth === false,
      ...(opts.label ? { label: opts.label } : {}),
    });

    // M2.3 — when `--session <id>` is set, both branches issue ACP
    // session/load instead of session/new so the conversation
    // continues a prior one. Without it, the default session/new
    // path runs (current behavior preserved).
    let openSession: () => ReturnType<typeof DashboardSession.attach>;
    let attachLabel: string;

    if (remote) {
      const { connectWebSocketClient } = await import(
        './tui-client/acp-transport-ws-client.js'
      );
      attachLabel = remote.url;
      openSession = async () => {
        const conn = await connectWebSocketClient(remote);
        if (opts.session) {
          return DashboardSession.attachExisting({
            sessionId: opts.session,
            conn,
            cwd: opts.cwd,
          });
        }
        return DashboardSession.attach({ conn, cwd: opts.cwd });
      };
    } else {
      const { elanousDaemonSocketPath } = await import('./elanous-daemon.js');
      const { connectUnixSocket, isUnixSocketAlive } = await import(
        './tui-client/acp-transport-unix-client.js'
      );
      const socketPath = opts.socket ?? elanousDaemonSocketPath();
      if (!(await isUnixSocketAlive(socketPath))) {
        ui.error(`No listening or usable Unix socket found at ${socketPath}; only the local Unix-socket transport was checked.`);
        ui.info('A daemon may be listening on TCP only; attach with `elanous attach --host <host>:<port>`.');
        ui.info('Start NEXUS with `elanous nexus` (foreground) or `elanous nexus --bg`.');
        ui.info('For a remote daemon, pass --host <tailnet>:<port> or set ELANOUS_REMOTE.');
        process.exit(1);
      }
      attachLabel = socketPath;
      openSession = async () => {
        const conn = await connectUnixSocket({ path: socketPath });
        if (opts.session) {
          return DashboardSession.attachExisting({
            sessionId: opts.session,
            conn,
            cwd: opts.cwd,
          });
        }
        return DashboardSession.attach({ conn, cwd: opts.cwd });
      };
    }

    // ⛔⭐ 원격 분기엔 로컬 분기의 «진단»이 없었다 — 서버가 핸드셰이크에 답하지 않으면
    //    이 자리에서 «영원히» 매달렸고 산출도 종료 코드도 없었다(2026-08-31 실측: 100초 상한까지).
    //    ⇒ 이제 전송층이 상한을 걸고 «어느 단계»인지 이름을 대므로, 그것을 사람 문면으로 옮긴다.
    //    ⛔ 스택 트레이스로 흘리지 않는다 — 로컬 분기가 이미 세운 문면 품질에 맞춘다.
    // ⛔⭐ 원격 분기«에만» 건다 — 로컬(unix) 분기의 실패 경로는 이 판에서 «안 바꾼다»(선언한 경계).
    //    로컬은 이미 소켓 생존 확인 ⊕ 진단 4줄 ⊕ exit(1) 을 «위에서» 하고 있다.
    let session: Awaited<ReturnType<typeof DashboardSession.attach>>;
    if (!remote) {
      session = await openSession();
    } else {
      try {
        session = await openSession();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ui.error(`attach failed: ${reason}`);
        ui.info(`Remote target: ${attachLabel}`);
        ui.info('Check the daemon is reachable: curl -sS -o /dev/null -w "%{http_code}\\n" <http-origin>/v1/nexus/connect-info');
        ui.info('If the socket opens but the handshake is unanswered, the daemon accepted the upgrade without an ACP agent behind it — check the daemon\'s logs (elanous logs --category acp).');
        ui.info('Token: --token-file ~/.elanous/acp-token from the daemon host, or --no-auth when the daemon runs with --no-http-auth.');
        process.exit(1);
      }
    }
    ui.header(`attached to ${attachLabel}${opts.session ? ` (loaded session: ${opts.session})` : ''}`);
    console.log(`session: ${session.id}`);

    // C14 — interactive REPL mode. Wraps repeated session.send()
    // calls with a readline loop. Slash commands let the user reset
    // the session or list daemon-side sessions without leaving.
    if (opts.interactive) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '› ',
      });
      console.log('Interactive mode. Type a message, or use /help for commands.');
      rl.prompt();

      let inFlight = false;
      rl.on('line', async (raw) => {
        const text = raw.trim();
        if (text === '') { rl.prompt(); return; }

        // Slash commands.
        if (text.startsWith('/')) {
          const [cmd, ...rest] = text.slice(1).split(/\s+/);
          if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
            rl.close();
            return;
          }
          if (cmd === 'new') {
            try { await session.close(); } catch { /* ignore */ }
            session = await openSession();
            console.log(`session: ${session.id}`);
            rl.prompt();
            return;
          }
          if (cmd === 'list') {
            // Probe /v1/sessions: for remote attach derive host:port
            // from the WS URL; for local attach read the daemon's
            // runtime sidecar (only set when --http-port was passed).
            try {
              let httpUrl: string | null = null;
              const headers: Record<string, string> = {};
              if (remote) {
                const u = new URL(remote.url);
                httpUrl = `http://${u.host}/v1/sessions`;
                if (remote.token) headers['authorization'] = `Bearer ${remote.token}`;
              } else {
                const { readElanousDaemonRuntime } = await import('./elanous-daemon.js');
                const rt = readElanousDaemonRuntime();
                if (rt?.httpPort) {
                  const host = rt.httpHost === '0.0.0.0' ? '127.0.0.1' : (rt.httpHost ?? '127.0.0.1');
                  httpUrl = `http://${host}:${rt.httpPort}/v1/sessions`;
                }
              }
              if (!httpUrl) {
                console.log('(daemon has no --http-port — cannot list sessions)');
              } else {
                const fetchRes = await fetch(httpUrl, { headers });
                if (fetchRes.ok) {
                  const body = await fetchRes.json() as {
                    sessions: Array<{ id: string; msgCount: number; lastTurnAt: string }>;
                  };
                  if (body.sessions.length === 0) {
                    console.log('(no sessions)');
                  } else {
                    for (const s of body.sessions) {
                      console.log(`  ${s.id.slice(0, 16)}…  ${s.msgCount} msg  ${s.lastTurnAt}`);
                    }
                  }
                } else {
                  console.log(`(/v1/sessions returned ${fetchRes.status})`);
                }
              }
            } catch (e) {
              console.log(`(list failed: ${(e as Error).message})`);
            }
            rl.prompt();
            return;
          }
          if (cmd === 'help' || cmd === 'h') {
            console.log('  /quit      — exit');
            console.log('  /new       — close + open a fresh session');
            console.log('  /list      — list active daemon sessions (needs --http-port on daemon)');
            console.log('  /help      — this');
            rl.prompt();
            return;
          }
          console.log(`unknown command: /${cmd}${rest.length ? ' ' + rest.join(' ') : ''} (try /help)`);
          rl.prompt();
          return;
        }

        if (inFlight) {
          console.log('(busy — wait for the previous turn)');
          rl.prompt();
          return;
        }
        inFlight = true;
        try {
          const result = await session.send({
            userText: text,
            onText: (delta: string) => process.stdout.write(delta),
          });
          process.stdout.write('\n');
          if (result.stopReason && result.stopReason !== 'end_turn') {
            console.log(`(stop: ${result.stopReason})`);
          }
        } catch (e) {
          console.log(`error: ${(e as Error).message}`);
        } finally {
          inFlight = false;
          rl.prompt();
        }
      });

      rl.on('close', async () => {
        try { await session.close(); } catch { /* ignore */ }
        process.stdout.write('\n');
        process.exit(0);
      });
      // SIGINT in readline closes the interface naturally.
      return;
    }

    if (!opts.message) {
      ui.info('No --message or --interactive supplied — handshake done. Closing.');
      await session.close();
      return;
    }

    try {
      const { evaluateAssertions } = await import('./eval-prompt-cli.js');
      const toolBreakdown: Record<string, number> = {};
      let buf = '';
      const result = await session.send({
        userText: opts.message,
        onText: (delta) => {
          buf += delta;
          process.stdout.write(delta);
        },
        onToolCall: (call) => {
          toolBreakdown[call.name] = (toolBreakdown[call.name] ?? 0) + 1;
        },
      });
      if (!buf.endsWith('\n')) process.stdout.write('\n');
      ui.info(`stopReason: ${result.stopReason}`);
      const failures = evaluateAssertions({
        prompt: opts.message,
        assertTextContains: opts.assertTextContains,
        assertToolMin,
        assertToolMax,
      }, buf, toolBreakdown, {});
      if (failures.length > 0) {
        for (const failure of failures) {
          ui.error(`Assertion failed [${failure.rule}]: ${failure.message}`);
        }
        process.exitCode = 1;
      }
    } finally {
      await session.close();
    }
  });

// Archon-port T3 (2026-05-08) — `elanous wf` CLI sub-commands.
//
// `wf` is the namespace for the workflow-runtime DAG runtime:
// prompt|bash|skill|cft|approval nodes authored as YAML in
// ~/.elanous/workflows/ · <cwd>/.elanous/workflows/ · samples/workflows/.
//
// Singular `elanous workflow` is an additional alias alongside the plural
// `elanous workflows` so the natural-language form works the same as
// `elanous wf run ...` (history: scheduler-retirement R4 · 2026-05-11).
const wfCmd = program
  .command('wf')
  .alias('workflows')
  .alias('workflow')
  .description(`Run YAML DAG workflows (workflow-runtime · ${WORKFLOW_NODE_VARIANT_KEYS.join('|')} nodes). Aliases: \`workflows\` (plural) · \`workflow\` (singular).`);

wfCmd
  .command('list')
  .description('List all discovered workflows (project + global + builtin)')
  .action(async () => {
    const { workflowList } = await import('./cli/workflow.js');
    workflowList();
    process.exit(0);
  });

wfCmd
  .command('show <name>')
  .description('Print a workflow YAML to stdout')
  .action(async (name: string) => {
    const { workflowShow } = await import('./cli/workflow.js');
    process.exit(workflowShow(name));
  });

wfCmd
  .command('validate <target>')
  .description('Validate a workflow by name or by file path (.yaml / .yml)')
  .action(async (target: string) => {
    const { workflowValidate } = await import('./cli/workflow.js');
    process.exit(workflowValidate(target));
  });

wfCmd
  .command('run <name> [args...]')
  .description('Run a workflow with positional args joined as $ARGUMENTS')
  .action(async (name: string, args: string[]) => {
    const { workflowRun } = await import('./cli/workflow.js');
    const joined = args && args.length > 0 ? args.join(' ') : '';
    process.exit(await workflowRun(name, joined));
  });

// M4-5 (2026-05-12 · Phase 4 N5-5) — `elanous wf node {list,spec,search}`
// node catalog reference. Source = src/workflow-runtime/node-catalog.ts
// (single truth · F6 default · co-located with types.ts).
const wfNodeCmd = wfCmd.command('node').description('Workflow node catalog reference — kinds, specs, and search.');

wfNodeCmd
  .command('list')
  .description('List all workflow node kinds grouped by category')
  .option('--category <name>', 'Filter to a single category (core|hitl|branch|iteration|transform|integration|trigger)')
  .action(async (opts: { category?: string }) => {
    const { wfNodeList } = await import('./cli/wf-node.js');
    process.exit(wfNodeList({ ...(opts.category ? { category: opts.category } : {}) }));
  });

wfNodeCmd
  .command('spec <kind>')
  .description('Print the markdown spec for a single workflow node kind')
  .action(async (kind: string) => {
    const { wfNodeSpec } = await import('./cli/wf-node.js');
    process.exit(wfNodeSpec(kind));
  });

wfNodeCmd
  .command('search <query>')
  .description('Search workflow node kinds by free-text query (matches kind / summary / related)')
  .option('--category <name>', 'Restrict matches to a single category')
  .option('--limit <n>', 'Max results (default 10)', (v) => Number.parseInt(v, 10))
  .action(async (query: string, opts: { category?: string; limit?: number }) => {
    const { wfNodeSearch } = await import('./cli/wf-node.js');
    process.exit(wfNodeSearch(query, {
      ...(opts.category ? { category: opts.category } : {}),
      ...(typeof opts.limit === 'number' ? { limit: opts.limit } : {}),
    }));
  });

// M4-1 (2026-05-12 · Phase 4 N5-1) — `elanous wf suggest-next <workflow>`.
// LLM-driven recommendation for the next node to add. F3 default:
// invoked on demand · no auto-fire.
wfCmd
  .command('suggest-next <workflow>')
  .description('Suggest the next node(s) to add to a workflow (LLM-driven · Phase 4 N5-1)')
  .option('--intent <text>', 'Optional description of what the next node should accomplish')
  .option('--position <pos>', 'Insertion position — after:<id> / before:<id> / parallel / append (default append)')
  .option('--count <n>', 'Number of suggestions (1-5 · default 3)', (v) => Number.parseInt(v, 10))
  .action(async (workflowName: string, opts: { intent?: string; position?: string; count?: number }) => {
    const { wfSuggestNext } = await import('./cli/wf-suggest.js');
    const passed: Parameters<typeof wfSuggestNext>[1] = {};
    if (opts.intent) passed.intent = opts.intent;
    if (opts.position) passed.position = opts.position;
    if (typeof opts.count === 'number') passed.count = opts.count;
    process.exit(await wfSuggestNext(workflowName, passed));
  });

// Scheduler-retirement R3 — `elanous wf synth <intent>` LLM synthesis.
wfCmd
  .command('synth <intent...>')
  .description('Synthesize a workflow YAML from a natural-language intent (LLM-driven · scheduler-retirement R3)')
  .option('--preview', 'Print the synthesized YAML without saving')
  .option('--save-project', 'Save under `<cwd>/.elanous/workflows/` instead of `~/.elanous/workflows/`')
  .action(async (parts: string[], opts: { preview?: boolean; saveProject?: boolean }) => {
    const { workflowSynth } = await import('./cli/workflow.js');
    const intent = parts.join(' ');
    if (!intent.trim()) {
      ui.error('synth: intent is required');
      process.exit(1);
    }
    const synthOpts: Parameters<typeof workflowSynth>[1] = {};
    if (opts.preview) synthOpts.preview = true;
    if (opts.saveProject) synthOpts.saveProject = true;
    process.exit(await workflowSynth(intent, synthOpts));
  });

const nexusCmd = program.command('nexus').description('NEXUS — unified TUI shell + supervisor + meta-api (Phase N-1, opt-in)');
registerIngestTokenCommands(nexusCmd);

// `elanous nexus run` — simplified surface (2026-05-11 refactor).
//
// Single user-facing entrypoint. Defaults to PWA-ready daemon with
// auto-detected lifecycle:
//   - TTY (interactive terminal)   → fork+detach + PWA orchestration
//                                     (share, registry, banner)
//   - no-TTY (launchd / systemd /  → inline blocking · headless
//     Docker / nohup)               (service manager handles lifecycle)
//
// 3 visible flags: --hmr · --https · --port.
// Hidden: --legacy-tui (in-process TUI · closes-terminal-kills-PWA caveat).
// Backwards-compat silent aliases: --headless / --foreground / --bg /
// --tui / --http-port / --http-host / --tools / --tool-cwd / --history-dir.
// Discoverability moves to AGENTS.md + MANUAL-pwa-start-vs-test.md.
const nexusRunCmd = nexusCmd
  .command('run', { isDefault: true })
  .description('Boot the NEXUS daemon. Default = headless + PWA-ready. Lifecycle auto-detected from TTY (fork+detach when interactive, inline blocking under launchd / systemd / Docker / nohup). Stop with `nexus pwa stop`.')
  // Visible flags
  .option('--hmr', 'Run apps/pwa via Next.js dev server proxy (live reload · PWA UI iteration). Implies fork+detach.')
  .option('--https', 'Mount Tailscale Serve tls-tcp on the picked port (sudo required · iPad voice/camera needs HTTPS). User-config `global.nexus.pwa.shareTailnet=enabled` auto-fires this even without the flag.')
  .option('--port <n>', 'HTTP API port override. Default = user-config `global.nexus.pwa.port` ?? 31415. Env: ELANOUS_NEXUS_HTTP_PORT.', (v) => Number.parseInt(v, 10))
  .option('--test', 'Project-local isolated mode — state dir = `<repo>/.elanous-test/` (gitignored, disposable). Auto port fallback (31415 → 31420 → ...). Daily driver at `~/.elanous/nexus/` untouched. Combine with --hmr / --https / --port / --rebuild / --fresh / --stop / --status.')
  .option('--fresh', 'Prune `<repo>/.elanous-test/{workflows,tasks,backups}/` before starting (--test only). Default off — preserves in-progress test artifacts across runs.')
  .option('--rebuild', 'Force a fresh `apps/pwa` build before start (skips the staleness check). Independent of --test.')
  .option('--auto-build', 'Static-mode: build apps/pwa/out before start when it is stale. Default on for `nexus run`, off for `--test`.')
  .option('--no-auto-build', 'Disable the static-mode auto-build (canonical entry default-on).')
  .option('--auto-install', 'Run `bun install` in apps/pwa when node_modules is missing (fresh clone / pulled lockfile). Default on for `nexus run`, off for `--test`.')
  .option('--no-auto-install', 'Disable the auto bun-install — surface the missing-deps diagnostic instead.')
  .option('--auto-restart', 'Same-tree port collision auto-stops the holder and retries. Default on for `nexus run`, off for `--test`.')
  .option('--no-auto-restart', 'Disable the same-tree auto-restart; revert to the 4-option hint.')
  .option('--watch', 'Static-mode: fs.watch loop inside daemon — source edits auto-rebuild apps/pwa. Default on for `nexus run` (no args), off for `--test`.')
  .option('--no-watch', 'Disable the static-mode fs.watch loop (canonical entry default-on).')
  .option('--no-mcp', 'Skip the entire MCP-client boot wire (every `mcp.servers[]` in user-config). Use when a misbehaving server (e.g. xcrun mcpbridge tools/list hang) drags every startup through its 8s timeout.')
  .option('--no-auth', 'Explicitly disable Nexus HTTP and ACP websocket bearer authentication (unsafe).')
  .option('--dispatch', '§5-③ — enable the autonomous idle-continuation scheduler for this run (drives an active auto-mode goal on idle). Same as user-config `dispatch.enabled`. Default off — ignites self-firing turns, so opt-in.')
  .option('--force', 'Take the lock even if another nexus instance is recorded as running.')
  .option('--status', 'Alias for `elanous nexus status` (or test-mode status when combined with --test).')
  .option('--stop', 'Alias for `elanous nexus stop` (or test-mode cascade stop when combined with --test).')
  // Hidden: developer + backwards-compat. Suppressed from `--help` so
  // the 3-flag user surface stays clean.
  //
  // PLAN-tui-redundancy-cleanup T3 (2026-05-16) — `--legacy-tui` / `--tui`
  // flag 제거. NEXUS TUI shell (src/nexus/shell/*) 가 opt-in deprecated 였고,
  // 전략 전환 (TUI-BEST → iOS/iPadOS-first) 으로 본 cascade 에서 정리.
  // 사용자 daemon-only mode (`elanous nexus run`) 그대로 사용.
  .addOption(new Option('--headless', 'Backwards-compat: lifecycle now auto-detects from TTY. Flag silently accepted.').hideHelp())
  .addOption(new Option('--foreground', 'Backwards-compat: lifecycle now auto-detects from TTY. Flag silently accepted.').hideHelp())
  .addOption(new Option('--bg', 'Backwards-compat: lifecycle now auto-detects from TTY. Flag silently accepted.').hideHelp())
  .addOption(new Option('--http-port <n>', 'Backwards-compat alias for `--port`. Env: ELANOUS_NEXUS_HTTP_PORT.').argParser((v) => Number.parseInt(v, 10)).hideHelp())
  .addOption(new Option('--http-host <host>', 'HTTP bind hostname (advanced · Tailscale deployments pin to a specific IP).').hideHelp())
  .addOption(new Option('--tools <kind>', 'In-process daemon tool surface — "none" / "readonly" / "chat" / "webterm". Default = "webterm" (everything: Read · Grep · WebSearch · Plan · MarkStepDone · Edit · Bash · WebTerminal* triple). Opt down to "chat" (drops WebTerminal*) for lightweight chat-only backends, or "readonly" (drops Edit + Bash too) for safety.').hideHelp())
  // ⛔ hideHelp() 를 «걷었다»(2026-09-06) — 격리 인스턴스에서 이 플래그는 «선택»이 아니라 «필수»다.
  //    숨겨져 있으면 `nexus run --test` 가 부팅 중 throw 하고 죽는데, 런처는 이미 성공 화면(포트·URL)을
  //    찍은 뒤라 «떴다»로 보인다. 실제로 그렇게 한 번 잃었다: 리스너 0인데 status 는 URL 을 말했고,
  //    원인은 로그 파일을 열어야만 보였다. ⇒ 필수 조건은 `--help` 에 «있어야» 한다.
  .addOption(new Option('--tool-cwd <path>', 'Working directory for Read/Grep tool dispatch. REQUIRED in isolated mode (--test): boot fails without it (or ELANOUS_TOOL_CWD) so the daemon cannot silently edit a live checkout.'))
  .addOption(new Option('--history-dir <path>', 'Disk-backed jsonl-per-session history dir.').hideHelp())
  .action(async (opts: {
    // visible
    hmr?: boolean;
    https?: boolean;
    port?: number;
    test?: boolean;
    rebuild?: boolean;
    autoBuild?: boolean;
    autoInstall?: boolean;
    autoRestart?: boolean;
    watch?: boolean;
    mcp?: boolean;
    auth?: boolean;
    fresh?: boolean;
    force?: boolean;
    dispatch?: boolean;
    status?: boolean;
    stop?: boolean;
    // hidden / compat
    // legacyTui · tui 제거됨 (T3 · PLAN-tui-redundancy-cleanup 2026-05-16)
    tui?: boolean;
    headless?: boolean;
    foreground?: boolean;
    bg?: boolean;
    httpPort?: number;
    httpHost?: string;
    tools?: string;
    toolCwd?: string;
    historyDir?: string;
  }) => {
    // 0. --test mode: route to project-local isolated daemon. Test mode
    //    is interactive-only by design (you're verifying changes from a
    //    TTY); no auto-detect needed.
    // 운영 우주는 설치본 또는 명시 운영 루트로 실행한 경우에만 접수한다.
    // `--test` 격리 우주는 통과하고 게이트 예외는 데몬 기동을 막지 않는다.
    {
      const { evaluateNexusRunRefusal } = await import('./instance/nexus-run-refusal.js');
      const refusal = evaluateNexusRunRefusal();
      if (refusal) { console.error(refusal); process.exit(1); }
    }
    if (opts.test) {
      const { runPwaTest } = await import('./cli/pwa-test.js');
      const r = await runPwaTest({
        ...(opts.hmr ? { hmr: true } : {}),
        ...(opts.https ? { https: true } : {}),
        ...(opts.port !== undefined ? { port: opts.port } : {}),
        ...(opts.rebuild ? { rebuild: true } : {}),
        // For test mode, the new gates stay opt-in: the user has to
        // pass --watch / --auto-build / --auto-restart explicitly. The
        // CLI's `--no-*` flips on `nexus run` only fire when the user
        // also opted in here, so we forward the user-visible bool as-is.
        ...(opts.watch === true ? { watch: true } : {}),
        ...(opts.autoBuild === true ? { autoBuild: true } : {}),
        ...(opts.autoInstall === true ? { autoInstall: true } : {}),
        ...(opts.autoRestart === true ? { autoRestart: true } : {}),
        ...(opts.fresh ? { fresh: true } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.toolCwd !== undefined ? { toolCwd: opts.toolCwd } : {}),
        ...(opts.stop ? { stop: true } : {}),
        ...(opts.status ? { status: true } : {}),
      });
      process.exit(r.exitCode);
    }

    // 1. Short-circuit aliases for the dedicated subcommands.
    if (opts.status) {
      const { runNexus } = await import('./nexus/index.js');
      await runNexus({ status: true });
      return;
    }
    if (opts.stop) {
      const { runNexus } = await import('./nexus/index.js');
      await runNexus({ stop: true });
      return;
    }

    // 2. Validate --tools (one-shot · same coercion runNexus does).
    const toolsKind = (opts.tools as 'none' | 'readonly' | 'chat' | 'webterm' | undefined);
    if (toolsKind
      && toolsKind !== 'none'
      && toolsKind !== 'readonly'
      && toolsKind !== 'chat'
      && toolsKind !== 'webterm'
    ) {
      console.error(`elanous nexus --tools must be 'none' | 'readonly' | 'chat' | 'webterm' (got: ${opts.tools})`);
      process.exit(1);
    }

    // 3. Resolve --port (canonical) ← --http-port (compat) ← env.
    const envPortRaw = process.env.ELANOUS_NEXUS_HTTP_PORT?.trim();
    const envPort = envPortRaw ? Number.parseInt(envPortRaw, 10) : NaN;
    let resolvedPort = opts.port
      ?? opts.httpPort
      ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : undefined);
    const resolvedHttpHost = opts.httpHost ?? process.env.ELANOUS_NEXUS_HTTP_HOST?.trim() ?? undefined;
    // Inline non-TTY daemons do not pass through runPwaStart. Reserve before
    // runNexus so the test universe never falls through to the prod port.
    if (resolvedPort === undefined && !opts.hmr && process.env.ELANOUS_NEXUS_BG_PARENT !== '1' && !process.stdin.isTTY
      && (await import('./instance/current.js')).resolveCurrentInstance().kind === 'test') {
      const { leaseTestPort, releaseTestPort } = await import('./cli/port-lease-local.js');
      const lease = await leaseTestPort({ owner: process.cwd() });
      if ('error' in lease) {
        console.error('시험 대역에 빈 포트가 없습니다 (31450..31499).');
        process.exitCode = 1;
        return;
      }
      resolvedPort = lease.port;
      console.log(`시험 대역에서 :${lease.port} 임대`);
      process.once('exit', () => releaseTestPort(lease.port, lease.pid));
    }

    // 4. Legacy TUI mode 제거됨 (T3 · PLAN-tui-redundancy-cleanup
    //    2026-05-16). `--legacy-tui` / `--tui` flag 가 NEXUS TUI shell
    //    (src/nexus/shell/*) mount 의 유일 entry 였고, 전략 전환으로
    //    daemon-only mode 만 남긴다.

    // 5. Auto-detect lifecycle. TTY → fork+detach + orch; !TTY → inline.
    //
    // ELANOUS_NEXUS_BG_PARENT=1 is set by bg-launch on the child it forks,
    // so the child detects "I am the bg-launched daemon, run inline"
    // even though some TTY-providing harness might still report isTTY.
    const bgChild = process.env.ELANOUS_NEXUS_BG_PARENT === '1';
    const isTty = (process.stdin.isTTY ?? false) && !bgChild;

    if (!isTty) {
      // !TTY = two distinct populations:
      //
      //   A. Service-manager launches (launchd / systemd / Docker / nohup):
      //      inline daemon, headless mode — manager owns the lifecycle.
      //
      //   B. Non-interactive callers that still want a daemon (claude-code
      //      `!` prefix · non-TTY ssh · CI smoke): they expect the same
      //      "fork+detach + come back to the prompt" behavior a real
      //      terminal gets, just without a controlling tty.
      //
      // The only feature that hard-requires fork+detach is `--hmr` (dev
      // BG + admin POST orchestrator only exists in the runPwaStart
      // path). bg-launch itself is TTY-independent (spawn detached +
      // stdio:'ignore', see src/cli/bg-launch.ts:107-110), so we route
      // `--hmr` to runPwaStart regardless of TTY. Static-mode launches
      // stay inline so service managers can supervise them directly.
      //
      // Share auto-mount: bg-launch child re-execs have their parent
      // (runPwaStart.bringShareUp) own the mount, so pass false. Pure
      // headless launches (launchd / Docker / etc.) own it themselves —
      // let runNexus mount based on `global.nexus.pwa.shareTailnet=enabled`.
      // `elanous nexus run` (no args) defaults to static + watch — the
      // "calm auto-reload" mode. Explicit --no-watch / --hmr disables.
      // `--rebuild` / `--no-auto-build` / `--no-auto-restart` are pass-
      // through to runPwaStart for both TTY and !TTY HMR branches.
      const startMode: 'hmr' | 'static' = opts.hmr ? 'hmr' : 'static';
      const watchOn = opts.watch !== false && startMode === 'static';
      if (opts.hmr && !bgChild) {
        const { runPwaStart } = await import('./cli/pwa-start.js');
        const result = await runPwaStart({
          mode: 'hmr',
          autoBuild: opts.autoBuild !== false, // CLI default on; --no-auto-build flips off
          autoInstall: opts.autoInstall !== false,
          autoRestart: opts.autoRestart !== false,
          preflightStaleServe: true,
          verifyListen: true,
          ...(opts.mcp === false ? { mcpEnabled: false } : {}),
          ...(opts.auth === false ? { noAuth: true } : {}),
          ...(opts.https ? { https: true } : {}),
          ...(resolvedPort !== undefined ? { httpPort: resolvedPort } : {}),
          ...(opts.force ? { force: true } : {}),
          ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
          ...(opts.historyDir ? { historyDir: opts.historyDir } : {}),
          ...(resolvedHttpHost ? { httpHost: resolvedHttpHost } : {}),
          ...(opts.rebuild ? { rebuild: true } : {}),
        });
        process.exit(result.exitCode);
      }
      if (bgChild && resolvedPort !== undefined) {
        // The detached child owns the lease after its launcher exits. Release
        // only its own PID on orderly shutdown; SIGKILL is reclaimed on next lease.
        const { releaseTestPort } = await import('./cli/port-lease-local.js');
        process.once('exit', () => releaseTestPort(resolvedPort, process.pid));
      }
      const { runNexus } = await import('./nexus/index.js');
      await runNexus({
        headless: true,
        tools: toolsKind ?? 'webterm',
        autoMountShare: !bgChild,
        // bg-launch child reads `--watch` from forwardArgs (set by
        // runPwaStart). External !TTY launches (launchd / Docker /
        // nohup) get watch only when the user explicitly didn't disable
        // it — service-manager production posture stays watch-off.
        ...((bgChild ? opts.watch === true : watchOn) ? { pwaWatch: true } : {}),
        ...(opts.mcp === false ? { mcpEnabled: false } : {}),
        ...(opts.auth === false ? { noAuth: true } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.dispatch ? { dispatch: true } : {}),
        ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
        ...(opts.historyDir ? { historyDir: opts.historyDir } : {}),
        ...(resolvedHttpHost ? { httpHost: resolvedHttpHost } : {}),
        ...(resolvedPort !== undefined ? { httpStartPort: resolvedPort } : {}),
      });
      return;
    }

    // 6. TTY mode: full PWA orchestration via runPwaStart (fork+detach,
    //    share, registry, banner with /app URL).
    const startModeTty: 'hmr' | 'static' = opts.hmr ? 'hmr' : 'static';
    const watchOnTty = opts.watch !== false && startModeTty === 'static';
    const { runPwaStart } = await import('./cli/pwa-start.js');
    const result = await runPwaStart({
      mode: startModeTty,
      autoBuild: opts.autoBuild !== false, // CLI default on; --no-auto-build flips off
      autoInstall: opts.autoInstall !== false,
      autoRestart: opts.autoRestart !== false,
      preflightStaleServe: true,
      verifyListen: true,
      ...(opts.https ? { https: true } : {}),
      ...(resolvedPort !== undefined ? { httpPort: resolvedPort } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
      ...(opts.historyDir ? { historyDir: opts.historyDir } : {}),
      ...(resolvedHttpHost ? { httpHost: resolvedHttpHost } : {}),
      ...(opts.rebuild ? { rebuild: true } : {}),
      ...(watchOnTty ? { watch: true } : {}),
      ...(opts.mcp === false ? { mcpEnabled: false } : {}),
      ...(opts.auth === false ? { noAuth: true } : {}),
    });
    process.exit(result.exitCode);
  });

nexusRunCmd.addHelpText('after', () => {
  const hiddenOptions = nexusRunCmd.options.filter((option) => option.hidden);
  return `\nHidden options (${hiddenOptions.length}): ${hiddenOptions.map((option) => option.long).join(', ')}\n`;
});

nexusCmd
  .command('status')
  .description('Print NEXUS lock + runtime sidecar state. Same as `elanous nexus --status`.')
  .action(async () => {
    const { runNexus } = await import('./nexus/index.js');
    await runNexus({ status: true });
  });

nexusCmd
  .command('stop')
  .description('Send SIGINT to the local NEXUS lock holder. Same as `elanous nexus --stop`.')
  .action(async () => {
    const { runNexus } = await import('./nexus/index.js');
    await runNexus({ stop: true });
  });

// `elanous nexus ios-bind` (L2 helper · 2026-05-13) — iOS Stage A simulator dogfood 의
// entry friction 제거. daemon 의 현재 host/port (runtime sidecar 에서 추출) +
// ~/.elanous/acp-token 을 `xcrun simctl spawn booted defaults write
// com.elanvitalai.elanous.ios <key> ...` 3 회로 시뮬레이터 booted device 의
// UserDefaults 에 자동 inject. iOS app 의 NexusEndpoint L1 (Settings) + L3
// (auto-discovery) 와 동일 효과 · 사용자 0 입력으로 첫 connect 가능.
nexusCmd
  .command('ios-bind')
  .description('Inject NEXUS host/port + bearer token to the booted iOS simulator (L2 helper).')
  .option('--bundle-id <id>', 'iOS app bundle id (default: com.elanvitalai.elanous.ios)')
  .option('--host <host>', 'Override host (skip runtime sidecar · for test mode or stale state)')
  .option('--port <port>', 'Override port (e.g. 31432 for test mode)', (v) => parseInt(v, 10))
  .option('--no-token', 'Skip bearer token inject (host/port only)')
  .option('--ascii', 'Inject `asciiKeyboard=true` UserDefault — ChatView 가 .keyboardType(.asciiCapable) 강제 · Korean/IME bypass for `idb ui text` headless automation.')
  .option('--no-ascii', 'Inject `asciiKeyboard=false` UserDefault — 사용자 IME 복원 (script trap cleanup 또는 수동 reset).')
  .option('--prompt <text>', 'Inject `seedPrompt` UserDefault — ChatView onAppear 시 input 자동 채움 (one-shot · IME 우회 · Korean/emoji/multiline 자유).')
  .option('--dry-run', 'Print xcrun commands without executing')
  .action(async (cliOpts) => {
    const { runNexusIosBind } = await import('./cli/nexus-ios-bind.js');
    // 3-state: --ascii (true), --no-ascii (false), neither (undefined/skip).
    const asciiKeyboard: boolean | undefined =
      cliOpts.ascii === true ? true : cliOpts.ascii === false ? false : undefined;
    const result = runNexusIosBind({
      ...(cliOpts.bundleId ? { bundleId: cliOpts.bundleId as string } : {}),
      ...(cliOpts.host ? { hostOverride: cliOpts.host as string } : {}),
      ...(typeof cliOpts.port === 'number' ? { portOverride: cliOpts.port } : {}),
      noToken: cliOpts.token === false,
      ...(asciiKeyboard !== undefined ? { asciiKeyboard } : {}),
      ...(typeof cliOpts.prompt === 'string' ? { seedPrompt: cliOpts.prompt } : {}),
      dryRun: Boolean(cliOpts.dryRun),
    });
    console.log(result.message);
    if (!result.ok && !result.message.includes('--dry-run')) {
      process.exit(1);
    }
  });

// P-2B.β — `elanous nexus config <list|get|set|unset>` generic CLI for
// every UserConfig knob (env vars are not used; everything routes
// through ~/.elanous/config.json). Sibling of `nexus pwa` / `nexus
// channel-bot`. Path shape: `global.<...>` or `tabs.<id>.<...>`.
const nexusConfigCmd = nexusCmd
  .command('config')
  .description('Read/write the UserConfig at ~/.elanous/config.json.');

nexusConfigCmd
  .command('list', { isDefault: true })
  .description('Dump the entire UserConfig (default subcommand).')
  .action(async () => {
    const { nexusConfigList } = await import('./cli/nexus-config.js');
    const r = nexusConfigList();
    process.exit(r.exitCode);
  });

nexusConfigCmd
  .command('get <path>')
  .description('Print the value at <path> (e.g. global.pwa.devProxyUpstream).')
  .action(async (path: string) => {
    const { nexusConfigGet } = await import('./cli/nexus-config.js');
    const r = nexusConfigGet(path);
    process.exit(r.exitCode);
  });

nexusConfigCmd
  .command('set <path> <value>')
  .description('Set <path> to <value>. JSON parse first; falls back to plain string.')
  .action(async (path: string, value: string) => {
    const { nexusConfigSet } = await import('./cli/nexus-config.js');
    const r = nexusConfigSet(path, value);
    process.exit(r.exitCode);
  });

nexusConfigCmd
  .command('unset <path>')
  .description('Remove the value at <path>. No-op if missing.')
  .action(async (path: string) => {
    const { nexusConfigUnset } = await import('./cli/nexus-config.js');
    const r = nexusConfigUnset(path);
    process.exit(r.exitCode);
  });

// `elanous nexus build` — PWA static export build (top-level verb · 2026-05-11
// refactor). Was `elanous nexus pwa build`; the `pwa` namespace now holds
// only operational helpers (stop/show/global/share/restart/dev).
// `nexus pwa build` stays as a deprecation forward (see below).
nexusCmd
  .command('build')
  .description('Build the PWA static export at apps/pwa/out (one-time · ~30s). Required before `nexus run` (static mode).')
  .option('--cwd <path>', 'Override the apps/pwa working directory (default = repo apps/pwa).')
  .action(async (opts: { cwd?: string }) => {
    const { runPwaBuild } = await import('./cli/pwa-build.js');
    const result = await runPwaBuild({
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
	    process.exit(result.exitCode);
	  });

	// `elanous nexus dist <subcommand>` group — Stage B remote-install over
// Tailscale (2026-05-18). `publish` ingests an Ad Hoc IPA into
// ~/.elanous/dist; `link` prints the itms-services:// install URL for
// iPad Safari. The daemon's `/v1/dist/*` endpoints serve manifest +
// IPA without bearer auth (the Tailscale tailnet is the access gate).
const nexusDistCmd = nexusCmd
  .command('dist')
  .description('Stage B remote-install — publish ad-hoc IPA so iPad Safari can install it over Tailscale.');

nexusDistCmd
  .command('publish <ipa>')
  .description('Copy an Ad Hoc IPA into ~/.elanous/dist + write dist.json. Prints the Safari install link.')
  .option('--title <title>', 'Override CFBundleDisplayName for the install confirmation.')
  .option('--version <version>', 'Override CFBundleShortVersionString.')
  .option('--build <build>', 'Override CFBundleVersion (build number).')
  .option('--display-image-url <url>', 'Optional 512x512 PNG URL Safari shows during install.')
  .option('--full-size-image-url <url>', 'Optional 1024x1024 PNG URL Safari shows post-install.')
  .action(async (ipa: string, opts: {
    title?: string;
    version?: string;
    build?: string;
    displayImageUrl?: string;
    fullSizeImageUrl?: string;
  }) => {
    const { runDistPublish } = await import('./cli/nexus-dist.js');
    const r = await runDistPublish({
      ipa,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.build ? { build: opts.build } : {}),
      ...(opts.displayImageUrl ? { displayImageUrl: opts.displayImageUrl } : {}),
      ...(opts.fullSizeImageUrl ? { fullSizeImageUrl: opts.fullSizeImageUrl } : {}),
    });
    process.exit(r.exitCode);
  });

nexusDistCmd
  .command('link')
  .description('Print the Safari install link (itms-services://...) for the currently-published IPA.')
  .action(async () => {
    const { runDistLink } = await import('./cli/nexus-dist.js');
    const r = await runDistLink();
    process.exit(r.exitCode);
  });

// `elanous nexus pwa <subcommand>` group — operational helpers only after
// the 2026-05-11 simplification. `start` / `test` / `build` are
// deprecation forwards; the new canonical entries are `nexus run`,
// `nexus run --test`, and `nexus build` respectively.
const nexusPwaCmd = nexusCmd
  .command('pwa')
  .description('PWA operational helpers — stop / show / global / share / restart / dev. (start/test/build are deprecated → use `nexus run` / `nexus run --test` / `nexus build`.)');

// Deprecation forward: `nexus pwa build` → `nexus build`.
nexusPwaCmd
  .command('build')
  .description('DEPRECATED — forwards to `elanous nexus build`.')
  .option('--cwd <path>', 'Override the apps/pwa working directory.')
  .addHelpText('after', '\nNote: `elanous nexus pwa build` is deprecated. Use `elanous nexus build` (same behavior).\n')
  .action(async (opts: { cwd?: string }) => {
    console.error('elanous nexus pwa build: deprecated — forwarding to `elanous nexus build`.');
    const { runPwaBuild } = await import('./cli/pwa-build.js');
    const result = await runPwaBuild({
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    process.exit(result.exitCode);
  });

// `elanous nexus pwa start` — deprecation shim (2026-05-11).
//
// The user-facing PWA daemon entry consolidated into `elanous nexus run`,
// which auto-detects lifecycle (TTY → fork+detach + orch; !TTY →
// inline). This shim forwards the same call with the same flags so
// scripts / muscle memory / pre-existing automation keeps working
// while the help banner steers users to the new shape.
//
// .addHelpText('after', ...) prints the deprecation banner after the
// rendered help so it's seen by anyone exploring the surface.
nexusPwaCmd
  .command('start')
  .description('DEPRECATED — forwards to `elanous nexus run`. Same flags · same behavior.')
  .option('--static', 'Default mode (serve apps/pwa/out static export).')
  .option('--hmr', 'Forward to `elanous nexus run --hmr`.')
  .option('--dev-port <n>', 'Next.js dev server port (--hmr only · default 3210).', (v) => Number.parseInt(v, 10))
  .option('--loopback', 'Bind nexus + next-dev to 127.0.0.1.')
  .option('--force', 'Take over an existing lock.')
  .option('--tool-cwd <path>', 'Working directory for Read/Grep tool dispatch.')
  .option('--history-dir <path>', 'Disk-backed jsonl-per-session history dir.')
  .option('--http-host <host>', 'HTTP bind hostname.')
  .option('--http-port <n>', 'HTTP API start port.', (v) => Number.parseInt(v, 10))
  .option('--https', 'Forward to `elanous nexus run --https`.')
  .addHelpText('after', '\nNote: `elanous nexus pwa start` is deprecated. Use `elanous nexus run` (same behavior · auto-detects TTY lifecycle).\n')
  .action(async (opts: {
    static?: boolean;
    hmr?: boolean;
    devPort?: number;
    loopback?: boolean;
    force?: boolean;
    toolCwd?: string;
    historyDir?: string;
    httpHost?: string;
    httpPort?: number;
    https?: boolean;
  }) => {
    if (opts.static && opts.hmr) {
      console.error('error: --static and --hmr are mutually exclusive');
      process.exit(2);
    }
    console.error('elanous nexus pwa start: deprecated — forwarding to `elanous nexus run` (same behavior).');
    const { runPwaStart } = await import('./cli/pwa-start.js');
    const result = await runPwaStart({
      mode: opts.hmr ? 'hmr' : 'static',
      ...(opts.devPort !== undefined ? { devPort: opts.devPort } : {}),
      ...(opts.loopback ? { loopback: true } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
      ...(opts.historyDir ? { historyDir: opts.historyDir } : {}),
      ...(opts.httpHost ? { httpHost: opts.httpHost } : {}),
      ...(opts.httpPort !== undefined ? { httpPort: opts.httpPort } : {}),
      ...(opts.https ? { https: true } : {}),
    });
    process.exit(result.exitCode);
  });

// P-2D.3' — `elanous nexus pwa stop` cascades: stops the BG dev server
// (DELETE admin endpoint via dev BG's own cleanup) + then the nexus
// daemon. Sibling of `pwa start` so the user never has to remember
// which mode is active.
nexusPwaCmd
  .command('stop')
  .description('Stop the PWA dev server (if running) and the NEXUS daemon. Cascade.')
  .action(async () => {
    const { runPwaStop } = await import('./cli/pwa-stop.js');
    const r = await runPwaStop();
    process.exit(r.exitCode);
  });

// `elanous nexus pwa test` was deprecated 2026-05-11 in favor of
// `elanous nexus run --test` (same runPwaTest under the hood). Removed
// 2026-05-13 — the forward + duplicated option surface had been
// drifting out of sync with the canonical entry every time we added a
// new flag (rebuild / watch / auto-build). The internal helper
// `runPwaTest` stays; only the user-facing subcommand goes away.

// `elanous nexus pwa restart` — one-shot stop + start. Default follows the
// running service: a live PWA dev lock means HMR is up, so we restart
// into HMR; no live dev lock means the static-export path. Explicit
// --static / --hmr forces a mode (used to switch modes via restart).
// --rebuild bundles a `pwa build` ahead of stop/start for the static
// path (after editing source).
nexusPwaCmd
  .command('restart')
  .description('Restart the PWA service. Default follows the running mode; --static / --hmr forces a switch. No rebuild by default.')
  .option('--static', 'Force restart into static-export mode (apps/pwa/out).')
  .option('--hmr', 'Force restart into HMR mode (next-dev + admin hot-swap).')
  .option('--rebuild', 'Run `elanous nexus pwa build` before restart (static export refresh).')
  .option('--cwd <path>', 'apps/pwa cwd for --rebuild (default = repo apps/pwa).')
  .option('--dev-port <n>', 'Next.js dev server port (--hmr only). Default 3210.', (v) => Number.parseInt(v, 10))
  .option('--loopback', 'Bind nexus and next-dev to 127.0.0.1 instead of 0.0.0.0.')
  .option('--force', 'Take over an existing lock if a holder is recorded as running.')
  .option('--tool-cwd <path>', 'Working directory for Read/Grep tool dispatch.')
  .option('--history-dir <path>', 'Disk-backed jsonl-per-session history dir.')
  .option('--http-host <host>', 'HTTP bind hostname for the restarted daemon.')
  .option('--http-port <n>', 'HTTP API start port for the restarted daemon.', (v) => Number.parseInt(v, 10))
  .action(async (opts: {
    static?: boolean;
    hmr?: boolean;
    rebuild?: boolean;
    cwd?: string;
    devPort?: number;
    loopback?: boolean;
    force?: boolean;
    toolCwd?: string;
    historyDir?: string;
    httpHost?: string;
    httpPort?: number;
  }) => {
    if (opts.static && opts.hmr) {
      console.error('error: --static and --hmr are mutually exclusive');
      process.exit(2);
    }
    const mode: 'auto' | 'static' | 'hmr' = opts.static ? 'static' : opts.hmr ? 'hmr' : 'auto';
    const { runPwaRestart } = await import('./cli/pwa-restart.js');
    const result = await runPwaRestart({
      mode,
      ...(opts.rebuild ? { rebuild: true } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.devPort !== undefined ? { devPort: opts.devPort } : {}),
      ...(opts.loopback ? { loopback: true } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.toolCwd ? { toolCwd: opts.toolCwd } : {}),
      ...(opts.historyDir ? { historyDir: opts.historyDir } : {}),
      ...(opts.httpHost ? { httpHost: opts.httpHost } : {}),
      ...(opts.httpPort !== undefined ? { httpPort: opts.httpPort } : {}),
    });
    process.exit(result.exitCode);
  });

// P-2A · γ · D.1 · D.2 — `elanous nexus pwa dev` runs the apps/pwa
// Next.js dev server with HMR. `--bg` self-detaches; `--stop` /
// `--status` manage the BG child. The foreground process POSTs to
// `/v1/nexus/admin/pwa-dev-proxy` on start and DELETEs on exit so
// nexus hot-swaps to reverse-proxy mode without a restart.
nexusPwaCmd
  .command('dev')
  .description('Run apps/pwa dev server (HMR). --bg = detach · --stop / --status manage the BG child.')
  .option('--cwd <path>', 'Override the apps/pwa working directory (default = repo apps/pwa).')
  .option('--port <n>', 'Dev server port (default 3210).', (v) => Number.parseInt(v, 10))
  .option('--host <host>', 'Bind interface for next-dev (default 0.0.0.0 — all interfaces).')
  .option('--no-auto-config', 'Skip the admin endpoint POST/DELETE — leave nexus untouched.')
  .option('--bg', 'Detach into background. Logs to ~/.elanous/nexus/logs/pwa-dev-<stamp>.log.')
  .option('--stop', 'Signal the BG child to stop + clear the lock.')
  .option('--status', 'Report whether the BG child is running.')
  .action(async (opts: {
    cwd?: string;
    port?: number;
    host?: string;
    autoConfig?: boolean;
    bg?: boolean;
    stop?: boolean;
    status?: boolean;
  }) => {
    if (opts.stop) {
      const { runPwaDevStop } = await import('./cli/pwa-dev-bg.js');
      const r = await runPwaDevStop();
      process.exit(r.exitCode);
    }
    if (opts.status) {
      const { runPwaDevStatus } = await import('./cli/pwa-dev-bg.js');
      const r = runPwaDevStatus();
      process.exit(r.exitCode);
    }
    if (opts.bg) {
      const { runPwaDevBgLaunch } = await import('./cli/pwa-dev-bg.js');
      const r = await runPwaDevBgLaunch({
        ...(opts.port !== undefined ? { port: opts.port } : {}),
        ...(opts.host ? { host: opts.host } : {}),
      });
      process.exit(r.exitCode);
    }
    const { runPwaDev } = await import('./cli/pwa-dev.js');
    const result = await runPwaDev({
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.autoConfig === false ? { autoConfig: false } : {}),
    });
    process.exit(result.exitCode);
  });

// P.4 — `elanous nexus pwa share enable|disable|status`. Mind-change knob
// for the first-boot wizard's outcome.
const nexusPwaShareCmd = nexusPwaCmd
  .command('share', { isDefault: false })
  .description('Tailscale share controls — enable / disable / status (mind-change knob).');

nexusPwaShareCmd
  .command('status', { isDefault: true })
  .description('Show current share switch + Tailscale state. Default subcommand so `elanous nexus pwa share` 도 동일.')
  .option('--json', 'Emit JSON (script-friendly).')
  .action(async (opts: { json?: boolean }) => {
    const { pwaShareStatus } = await import('./cli/pwa-share.js');
    const result = await pwaShareStatus({}, opts.json ? 'json' : 'human');
    process.exit(result.exitCode);
  });

nexusPwaShareCmd
  .command('enable')
  .description('Enable Tailscale serve forward + flip switch (idempotent).')
  .option('--port <n>', 'HTTP port to forward (default 31415).', (v) => Number.parseInt(v, 10))
  .action(async (opts: { port?: number }) => {
    const { pwaShareEnable } = await import('./cli/pwa-share.js');
    const result = await pwaShareEnable({ ...(opts.port !== undefined ? { port: opts.port } : {}) });
    process.exit(result.exitCode);
  });

nexusPwaShareCmd
  .command('disable')
  .description('Disable Tailscale serve forward + flip switch (idempotent).')
  .action(async () => {
    const { pwaShareDisable } = await import('./cli/pwa-share.js');
    const result = await pwaShareDisable({});
    process.exit(result.exitCode);
  });

// `elanous nexus show` (2026-05-13) — consolidated daemon overview.
// Superset of `pwa show` (kept as a sibling): adds REST API + SSE
// event URLs alongside PWA UI URLs so the user gets every link in
// one shot.
nexusCmd
  .command('show')
  .description('Show this project\'s daemon — alive flag · ports · PWA UI / REST API / SSE links (loopback + tailnet).')
  .option('--json', 'Emit JSON (script-friendly).')
  .action(async (opts: { json?: boolean }) => {
    const { runNexusShow } = await import('./cli/nexus-show.js');
    const result = await runNexusShow({ format: opts.json ? 'json' : 'human' });
    process.exit(result.exitCode);
  });
// R0 — `elanous nexus restart-needed`: classify the daemon-sha..HEAD path diff.
// Read-only. Exit: none 0 · build 10 · restart 11 · unknown 2.
nexusCmd
  .command('restart-needed')
  .description('Say whether the running daemon needs a restart, a PWA build, or nothing, from the path diff between its commit and --to (default HEAD). Read-only.')
  .option('--to <commit>', 'Commit the new code would land at. Default: current checkout HEAD.')
  .option('--json', 'Emit JSON (script-friendly).')
  .action(async (opts: { to?: string; json?: boolean }) => {
    const { decideRestartNeeded } = await import('./cli/nexus-restart-needed.js');
    const result = await decideRestartNeeded({
      // Present, including whitespace-only. Omitting the flag is the only
      // path that means HEAD — a blank value is not "flag absent".
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      format: opts.json ? 'json' : 'human',
    });
    process.exit(result.exitCode);
  });

// P5 (2026-05-10) — `elanous nexus pwa show` — current project's daemon
// view (cwd-matched). Sibling of `pwa global status` (host-wide).
// Surfaces: alive · ports · loopback URL · tailnet URL when
// shareMounted. User asked: "현재 서빙된 상태를 표시 + 현재 프로젝트
// 서빙 시 주소값을 알려줌".
nexusPwaCmd
  .command('show')
  .description('Show this project\'s PWA daemon — alive flag · ports · loopback + tailnet URLs. (For the consolidated link view incl. REST/SSE, use `elanous nexus show`.)')
  .option('--json', 'Emit JSON (script-friendly).')
  .action(async (opts: { json?: boolean }) => {
    const { runPwaShow } = await import('./cli/pwa-show.js');
    const result = await runPwaShow({ format: opts.json ? 'json' : 'human' });
    process.exit(result.exitCode);
  });

nexusPwaCmd
  .command('verify [marker]')
  .description('Read-only verification of static freshness, artifact bytes, and HTTP-served bytes. Does not inspect browser requests.')
  .option('--json', 'Emit JSON (script-friendly).')
  .option('--cwd <path>', 'Override the apps/pwa working directory.')
  .action(async (marker: string | undefined, opts: { json?: boolean; cwd?: string }) => {
    const { runPwaVerify } = await import('./cli/pwa-verify.js');
    const result = await runPwaVerify({
      ...(marker !== undefined ? { marker } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      format: opts.json ? 'json' : 'human',
    });
    process.exit(result.exitCode);
  });

// P5 (2026-05-10) — `elanous nexus pwa global <status|clean>` — registry-
// driven view across all PWA daemons on this host (multi-folder /
// multi-project) + cleanup orchestrator. Uses the P4 registry from
// `~/.elanous/pwa-registry.json`.
const nexusPwaGlobalCmd = nexusPwaCmd
  .command('global', { isDefault: false })
  .description('Cross-instance PWA daemon view (registry from `~/.elanous/pwa-registry.json`).');

nexusPwaGlobalCmd
  .command('status', { isDefault: true })
  .description('List every PWA daemon registered on this host (auto-prunes stale entries).')
  .option('--json', 'Emit JSON (script-friendly).')
  .action(async (opts: { json?: boolean }) => {
    const { runPwaGlobalStatus } = await import('./cli/pwa-global.js');
    const result = await runPwaGlobalStatus({ format: opts.json ? 'json' : 'human' });
    process.exit(result.exitCode);
  });

nexusPwaGlobalCmd
  .command('clean')
  .description('SIGINT all live PWA daemons + unmount their Tailscale Serve ports + clear registry.')
  .option('--dry-run', 'Preview only — no kills, no unmounts, no registry wipe.')
  .option('--stale-only', 'Skip live instances; only prune dead-pid entries.')
  .action(async (opts: { dryRun?: boolean; staleOnly?: boolean }) => {
    const { runPwaGlobalClean } = await import('./cli/pwa-global.js');
    const result = await runPwaGlobalClean({
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.staleOnly ? { staleOnly: true } : {}),
    });
    process.exit(result.exitCode);
  });

const nexusChannelBotCmd = nexusCmd
  .command('channel-bot')
  .description('NEXUS-native channel bot setup helpers.');

nexusChannelBotCmd
  .command('setup <platform>')
  .description('Store the Telegram or Discord bot token in the NEXUS secret store.')
  .action(async (platform: string) => {
    if (platform !== 'telegram' && platform !== 'discord') {
      console.error('elanous nexus channel-bot setup: platform must be telegram or discord.');
      process.exit(1);
    }
    const { runChannelBotSetup } = await import('./cli/channel-bot-setup.js');
    const result = await runChannelBotSetup({ platform });
    process.exit(result.exitCode);
  });

// FU A6-real P5 (2026-05-11) — interactive Firecrawl setup.
// Walks the user through CLI detection + API key entry + persist to
// `registry.discovery.firecrawl.apiKey`. `--api-key <value>` skips
// the prompt for scripted / CI use.
nexusCmd
  .command('setup-firecrawl')
  .description('Configure Firecrawl-backed model discovery (CLI detection + API key entry).')
  .option('--api-key <value>', 'Skip the interactive prompt and persist this key directly.')
  .action(async (opts: { apiKey?: string }) => {
    const { runFirecrawlSetup } = await import('./cli/firecrawl-setup.js');
    const result = await runFirecrawlSetup({
      apiKeyInline: opts.apiKey,
    });
    process.exit(result.exitCode);
  });

// T4.B — Remote bookmark CLI. ~/.elanous/remotes.json + ~/.elanous/remotes/<name>.token
nexusCmd
  .command('connect <host>')
  .description('Bookmark a remote NEXUS host so `elanous` (no-arg) auto-attaches. Pulls metadata from /v1/nexus/connect-info.')
  .option('--name <name>', 'Bookmark name (default = slug of host).')
  .option('--port <port>', 'HTTP port (default 31415; --host can also embed :port).', (v) => Number.parseInt(v, 10))
  .option('--token <token>', 'Bearer token (use --token-file to load from disk instead).')
  .option('--token-file <path>', 'Read bearer token from this file.')
  .option('--default', 'Set as the default remote (`elanous` no-arg routes here).')
  .option('--no-default', 'Don\'t modify the existing default remote on add.')
  .option('--no-ping', 'Skip /v1/health probe (useful when the remote is offline).')
  .action(async (host: string, opts: {
    name?: string;
    port?: number;
    token?: string;
    tokenFile?: string;
    default?: boolean;
    ping?: boolean;
  }) => {
    const { connectRemote } = await import('./cli/remotes-cli.js');
    const code = await connectRemote({
      host,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.port ? { port: opts.port } : {}),
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.tokenFile ? { tokenFile: opts.tokenFile } : {}),
      ...(opts.default !== undefined ? { setDefault: opts.default } : {}),
      ...(opts.ping !== undefined ? { ping: opts.ping } : {}),
    });
    if (code !== 0) process.exit(code);
  });

nexusCmd
  .command('list')
  .alias('ls')
  .description('List bookmarked remotes. Shows default + addedAt + (optional) health ping.')
  .option('--no-ping', 'Skip /v1/health probe.')
  .option('--json', 'Emit JSON instead of human-readable lines.')
  .action(async (opts: { ping?: boolean; json?: boolean }) => {
    const { listRemotesCmd } = await import('./cli/remotes-cli.js');
    const code = await listRemotesCmd({
      ...(opts.ping !== undefined ? { ping: opts.ping } : {}),
      ...(opts.json ? { json: true } : {}),
    });
    if (code !== 0) process.exit(code);
  });

nexusCmd
  .command('switch <name>')
  .description('Set <name> as the default remote (used by `elanous` no-arg).')
  .action(async (name: string) => {
    const { switchRemote } = await import('./cli/remotes-cli.js');
    const code = await switchRemote({ name });
    if (code !== 0) process.exit(code);
  });

nexusCmd
  .command('remove <name>')
  .alias('rm')
  .description('Remove a bookmark + delete its token file. Does not stop the remote NEXUS.')
  .action(async (name: string) => {
    const { removeRemoteCmd } = await import('./cli/remotes-cli.js');
    const code = await removeRemoteCmd({ name });
    if (code !== 0) process.exit(code);
  });

// PR ψ + ω — `elanous nexus install --launchd|--systemd-user`. Cross-platform
// dispatcher; the macOS plist + Linux service unit live in dedicated modules.
nexusCmd
  .command('install')
  .description('Install nexus as an OS-supervised service (launchd / systemd)')
  .option('--launchd', 'macOS LaunchAgent install (~/Library/LaunchAgents/com.elanous.nexus.plist)')
  .option('--systemd-user', 'Linux systemd --user install (~/.config/systemd/user/elanous-nexus.service)')
  .option('--no-start', 'Write the unit file but skip launchctl bootstrap / systemctl enable+start')
  .action(async (opts: { launchd?: boolean; systemdUser?: boolean; start?: boolean }) => {
    const wantsLaunchd = opts.launchd === true;
    const wantsSystemd = opts.systemdUser === true;
    if (!wantsLaunchd && !wantsSystemd) {
      console.error('elanous nexus install: pass --launchd (macOS) or --systemd-user (Linux).');
      process.exit(1);
    }
    if (wantsLaunchd && wantsSystemd) {
      console.error('elanous nexus install: pass exactly one of --launchd / --systemd-user.');
      process.exit(1);
    }
    const noStart = opts.start === false;
    if (wantsLaunchd) {
      const { installLaunchd, renderAuxiliaryAiEnvNotice } = await import('./nexus/install/launchd.js');
      const res = await installLaunchd({ noStart });
      if (res.outcome === 'installed') {
        console.log(`launchd: plist written ${res.plistPath}`);
        console.log(res.bootstrapped ? '         bootstrapped (gui/<uid>) — nexus is starting.' : '         --no-start — bootstrap skipped.');
        if (res.auxiliaryAiEnvNotice) {
          for (const line of renderAuxiliaryAiEnvNotice(res.auxiliaryAiEnvNotice)) console.log(line);
        }
        if (res.keyCache?.written.length) console.log(`         provider keys → key cache (~/.cache, 600): ${res.keyCache.written.join(', ')} — not written into the plist`);
        if (res.keyCache?.differs.length) console.log(`         ⚠ key cache differs from this shell for: ${res.keyCache.differs.join(', ')} — the daemon uses the cache; update it with scripts/add-api-key.sh if the shell value is the new one`);
      } else if (res.outcome === 'not-supported') {
        console.error(`launchd: ${res.reason}`);
        process.exit(1);
      } else {
        console.error(`launchd: install failed: ${res.reason}`);
        process.exit(1);
      }
      return;
    }
    // wantsSystemd
    const { installSystemd } = await import('./nexus/install/systemd.js');
    const res = await installSystemd({ noStart });
    if (res.outcome === 'installed') {
      console.log(`systemd: unit written ${res.unitPath}`);
      if (res.keyCache?.written.length) console.log(`         provider keys → key cache (~/.cache, 600): ${res.keyCache.written.join(', ')} — not written into the unit`);
      if (res.keyCache?.differs.length) console.log(`         ⚠ key cache differs from this shell for: ${res.keyCache.differs.join(', ')} — the daemon uses the cache`);
      console.log(res.enabled && res.started
        ? '         enabled + started (--user) — nexus is running.'
        : '         --no-start — enable/start skipped (daemon-reload still ran).');
      if (res.linger) console.log(res.linger.ok
        ? '         linger enabled — the service starts at boot without a login.'
        : `         ⚠ linger not enabled — after a reboot nexus starts only when you log in: ${res.linger.detail}`);
    } else if (res.outcome === 'not-supported') {
      console.error(`systemd: ${res.reason}`);
      process.exit(1);
    } else {
      console.error(`systemd: install failed: ${res.reason}`);
      process.exit(1);
    }
  });

nexusCmd
  .command('uninstall')
  .description('Remove the launchd LaunchAgent / systemd-user unit installed by `nexus install`')
  .option('--launchd', 'macOS LaunchAgent uninstall')
  .option('--systemd-user', 'Linux systemd --user uninstall')
  .action(async (opts: { launchd?: boolean; systemdUser?: boolean }) => {
    const wantsLaunchd = opts.launchd === true;
    const wantsSystemd = opts.systemdUser === true;
    if (!wantsLaunchd && !wantsSystemd) {
      console.error('elanous nexus uninstall: pass --launchd or --systemd-user.');
      process.exit(1);
    }
    if (wantsLaunchd) {
      const { uninstallLaunchd } = await import('./nexus/install/launchd.js');
      const res = await uninstallLaunchd();
      if (res.outcome === 'uninstalled') {
        console.log(`launchd: ${res.bootedOut ? 'booted out' : 'not loaded'}, plist ${res.removedFile ? 'removed' : 'absent'}.`);
      } else if (res.outcome === 'not-installed') {
        console.log('launchd: not installed.');
      } else if (res.outcome === 'not-supported') {
        console.error(`launchd: ${res.reason}`);
        process.exit(1);
      } else {
        console.error(`launchd: uninstall failed: ${res.reason}`);
        process.exit(1);
      }
      return;
    }
    // wantsSystemd
    const { uninstallSystemd } = await import('./nexus/install/systemd.js');
    const res = await uninstallSystemd();
    if (res.outcome === 'uninstalled') {
      console.log(`systemd: ${res.stopped ? 'stopped' : 'not running'}, ${res.disabled ? 'disabled' : 'not enabled'}, unit ${res.removedFile ? 'removed' : 'absent'}.`);
    } else if (res.outcome === 'not-installed') {
      console.log('systemd: not installed.');
    } else if (res.outcome === 'not-supported') {
      console.error(`systemd: ${res.reason}`);
      process.exit(1);
    } else {
      console.error(`systemd: uninstall failed: ${res.reason}`);
      process.exit(1);
    }
  });

// 휴대폰 앱 온보딩 — 링크 하나(⊕ QR)로 이 Mac 의 넥서스에 붙인다(대표 2026-09-30 · 아이폰 첫 화면 단순화).
program
  .command('phone')
  .description('Connect the phone app to this Mac')
  .command('link')
  .description('Print a one-tap connect link (and a QR code) for the Elanous phone app')
  .option('--simulator', 'Use the loopback address (the simulator on this Mac) instead of the tailnet address — `--local` is taken by the global remote flag')
  .option('--android [serial]', 'Hand the link straight to a USB-connected Android phone (adb reverse + am start · the token is never printed)')
  .option('--temp', 'Use a short-lived token instead of the owner token')
  .option('--ttl <duration>', 'Lifetime for --temp (max 24h)', '24h')
  .option('--no-qr', 'Do not print a QR code')
  .action(async (opts: { simulator?: boolean; android?: boolean | string; temp?: boolean; ttl: string; qr: boolean }) => {
    const { runPhoneLink } = await import('./cli/phone-link.js');
    process.exitCode = await runPhoneLink({ local: opts.simulator, android: opts.android, temp: opts.temp, ttl: opts.ttl, qr: opts.qr });
  });

// ── ACP — Agent Client Protocol (claude-code, codex, ...) ──
const tokenCmd = program
  .command('token')
  .description('Manage the ACP admin token');

// 단기 소유자 토큰 — 검증·시연·다른 기기에 영구 토큰을 건네지 않으려고(해시만 저장 · 기본 15분 · 최대 24시간).
tokenCmd
  .command('issue')
  .description('Issue a short-lived owner token (default 15m · max 24h) — stored as a hash only')
  .option('--ttl <duration>', 'Lifetime: 90s · 15m · 2h · 1d', '15m')
  .option('--label <label>', 'Name shown in `token list`', 'temp')
  .option('--out <file>', 'Write the raw token to this file (0600) instead of stdout')
  .action(async (opts: { ttl: string; label: string; out?: string }) => {
    const { issueTempToken, parseTtl } = await import('./auth/temp-tokens.js');
    const issued = issueTempToken({ ttlMs: parseTtl(opts.ttl), label: opts.label });
    if (opts.out) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(opts.out, `${issued.token}\n`, { mode: 0o600 });
      console.log(`issued id=${issued.id} label=${issued.label} expires=${issued.expiresAt} → ${opts.out}`);
      return;
    }
    console.error(`issued id=${issued.id} label=${issued.label} expires=${issued.expiresAt} — revoke: elanous token revoke ${issued.id}`);
    console.log(issued.token);
  });

tokenCmd
  .command('list')
  .description('List short-lived owner tokens (values are never shown)')
  .action(async () => {
    const { listTempTokens } = await import('./auth/temp-tokens.js');
    const rows = listTempTokens();
    if (rows.length === 0) { console.log('(no short-lived tokens)'); return; }
    for (const r of rows) console.log(`${r.id}\t${r.label}\t${r.createdAt}\t${r.expiresAt}${r.expired ? '\texpired' : ''}`);
  });

tokenCmd
  .command('revoke [id]')
  .description('Revoke a short-lived owner token (or --all)')
  .option('--all', 'Revoke every short-lived token')
  .action(async (id: string | undefined, opts: { all?: boolean }) => {
    if (!id && !opts.all) throw new Error('give a token id or --all');
    const { revokeTempTokens } = await import('./auth/temp-tokens.js');
    const n = revokeTempTokens(opts.all ? { all: true } : { id });
    console.log(`revoked ${n}`);
    if (n === 0 && id) process.exitCode = 1;
  });

tokenCmd
  .command('rotate')
  .description('Rotate the ACP admin token')
  .option('--grace-ms <ms>', 'Previous-token grace period in milliseconds', (value: string) => Number(value))
  .option('--show-token', 'Print the complete new token')
  .action(async (opts: { graceMs?: number; showToken?: boolean }) => {
    if (opts.graceMs !== undefined && (!Number.isFinite(opts.graceMs) || opts.graceMs < 0)) {
      throw new Error('--grace-ms must be a non-negative finite number');
    }
    const [{ rotateAdminToken }, { getElanousConfigDir }] = await Promise.all([
      import('./auth/token-store.js'),
      import('./elanous-config-dir.js'),
    ]);
    const result = rotateAdminToken({
      configDir: getElanousConfigDir(),
      ...(opts.graceMs !== undefined ? { gracePeriodMs: opts.graceMs } : {}),
    });
    if (opts.showToken) {
      console.log(result.newActive);
      return;
    }
    console.log(`ACP admin token rotated: length=${result.newActive.length} prefix=${result.newActive.slice(0, 4)}`);
  });

const acpCmd = program.command('acp').description('Agent Client Protocol — spawn ACP agents (claude-code, codex, gemini)');

// ACP CLI is a standalone process, so its debug logs need the same fail-open store sink
// used by other command groups before any ACP subcommand action executes.
acpCmd.hook('preAction', async () => {
  try {
    const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
    await registerStandaloneLogSink('acp');
  } catch { /* fail-open — observation wiring must not block ACP */ }
});

// `elanous acp login <backend>` — 구독 OAuth 로그인 «구동» 표면.
//
// ⛔ 이 명령이 존재하는 이유: 로그인 spawn 함수를 만들어 두고 «아무 데도 안
// 꽂으면» 그건 없는 것과 같다(F38 · codex 의 `spawnCodexLogin` 이 실제로
// 소비처 0건이었다). 턴 도중 자동 spawn 은 침습적이라 안 하고, 대신 사용자가
// 명시로 부르는 이 자리를 소유자로 둔다. ACP prompt 경로는 힌트로 여기를 가리킨다.
acpCmd
  .command('login')
  .description('구독 OAuth 로그인을 구동한다 (grok=SuperGrok/X Premium · codex=ChatGPT). 브라우저가 열리며, 원격/헤드리스는 --device-auth')
  .argument('<backend>', 'grok | codex')
  .option('--device-auth', '디바이스 코드 방식 (SSH·원격·헤드리스). 생략하면 환경으로 자동 판정')
  .option('--timeout <ms>', '상한 (기본: grok 11분 · codex 5분)', (v: string) => Number.parseInt(v, 10))
  .action(async (backendArg: string, opts: { deviceAuth?: boolean; timeout?: number }) => {
    const backend = backendArg.trim().toLowerCase();
    const timeoutMs = Number.isFinite(opts.timeout) ? opts.timeout : undefined;
    const log = (line: string): void => { console.log(line); };

    if (backend === 'grok') {
      const { spawnGrokLogin, readGrokTokenFreshness } = await import('./acp/grok-auth.js');
      const before = readGrokTokenFreshness();
      console.log(`[acp login] 관측: credential=${before.present ? 'present' : 'absent'} · access_token=${before.fresh === true ? 'fresh' : before.fresh === false ? 'expired' : 'unknown'} · expires_at=${before.expiresAt ?? '미상'}`);
      if (before.present && before.fresh === true) {
        console.log('이미 로그인돼 있다. 다시 로그인하려면 `grok logout` 후 재실행.');
        return;
      }
      // ⚠️ access_token 만료 ≠ 재로그인 «필요». refresh_token 이 살아 있으면
      // grok 바이너리가 조용히 갱신한다(바이너리가 refresh 의 소유자다).
      // 그래서 여기서 자동 중단하지 않고 «사용자가 명시로 불렀으니» 진행하되,
      // 그 사실을 알려 준다 — 안 그러면 필요 없는 로그인을 시킨 것이 된다.
      if (before.present && before.fresh === false) {
        console.log('⚠️ access_token 은 만료됐지만 refresh_token 이 유효하면 grok 이 스스로 갱신한다. 재로그인이 꼭 필요한 게 아닐 수 있다 (중단: Ctrl-C).');
      }
      const r = await spawnGrokLogin({
        ...(opts.deviceAuth ? { deviceAuth: true } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        log,
      });
      const after = readGrokTokenFreshness();
      // ⛔ 종료 코드만 믿지 않는다 — 크레덴셜이 실제로 갱신됐는지 같이 본다.
      const landed = after.present && after.fresh !== false;
      console.log(`[acp login] grok ${r.ok && landed ? 'ok' : 'FAILED'} mode=${r.mode} exit=${r.exitCode ?? 'null'} credential=${landed ? 'present' : 'absent'}`);
      if (!(r.ok && landed)) process.exitCode = 1;
      return;
    }

    if (backend === 'codex') {
      const { spawnCodexLogin } = await import('./acp/codex-auth.js');
      const r = await spawnCodexLogin({
        ...(opts.deviceAuth ? { deviceAuth: true } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        log,
      });
      console.log(`[acp login] codex ${r.ok ? 'ok' : 'FAILED'} mode=${r.mode} exit=${r.exitCode ?? 'null'}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }

    console.error(`지원하지 않는 백엔드: ${backendArg} — grok | codex 중 하나여야 한다.`);
    process.exitCode = 1;
  });

// `elanous acp usage grok` — 구독 사용량. ⛔ 조회기를 만들어 두고 안 꽂으면 F38 이다.
acpCmd
  .command('usage')
  .description('구독 사용량을 조회한다 (현재 grok 만 — 구독 OAuth 자격이 있어야 한다)')
  .argument('[backend]', 'grok', 'grok')
  .option('--json', '구조화 출력')
  .action(async (backendArg: string, opts: { json?: boolean }) => {
    const backend = backendArg.trim().toLowerCase();
    if (backend !== 'grok') {
      console.error(`지원하지 않는 백엔드: ${backendArg} — 현재 grok 만.`);
      process.exitCode = 1;
      return;
    }
    const { fetchGrokUsage, describeGrokUsage } = await import('./grok/usage.js');
    const result = await fetchGrokUsage();
    if (opts.json) {
      await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
    } else {
      console.log(describeGrokUsage(result));
    }
    // ⛔ 「모른다」와 「정상」을 종료 코드로도 가른다.
    if (result.status !== 'ok') process.exitCode = 1;
  });

acpCmd
  .command('test')
  .description('One-shot ACP smoke test: spawn a backend, send one prompt, print the streamed response')
  .option('--backend <id>', 'Backend id (claude, codex, ...)', 'claude')
  .option('--prompt <text>', 'User text to send', 'Say hi in one short sentence.')
  .option('--file <path>', 'Attach a local file (repeatable)', (value, previous: string[] = []) => [...previous, value], [])
  .option('--cwd <path>', 'Working directory for the agent', process.cwd())
  .option('--auto-approve-permissions', 'Automatically approve ACP tool permissions for this test run')
  .action(async (opts: { backend: string; prompt: string; file: string[]; cwd: string; autoApprovePermissions?: boolean }) => {
    const { globalAcpAgentManager } = await import('./acp/agent-manager.js');
    const { canonicalizeBackendId, getAcpBackend } = await import('./acp/backend-registry.js');
    const { localFileToResourceLink, localImageToBlock, textBlock } = await import('./acp/content-blocks.js');
    const { debug } = await import('./debug/log.js');
    const requestedBackend = opts.backend;
    const backend = canonicalizeBackendId(requestedBackend);
    const transport = getAcpBackend(backend).transport ?? 'acp';
    const permissionApprover: AcpPermissionApprover = async () => true;
    const manager = globalAcpAgentManager();
    debug.log('acp-test', 'start', {
      requestedBackend,
      backend,
      transport,
      autoApprovePermissions: opts.autoApprovePermissions ?? false,
    });
    const agent = await manager.getAgent(backend, {
      cwd: opts.cwd,
      log: (m) => process.stderr.write(`[acp] ${m}\n`),
      ...(opts.autoApprovePermissions ? { permissionApprover } : {}),
    });
    try {
      ui.header(`acp test — backend=${opts.backend}`);
      if (opts.autoApprovePermissions) ui.header('ACP test permission auto-approval enabled');
      const sessionId = await agent.newSession();
      const capabilities = agent.getCapabilities?.()?.prompt;
      const blocks = [textBlock(opts.prompt)];
      const requested: Record<string, number> = { image: 0, resource_link: 0 };
      const sent: Record<string, number> = { text: 1, image: 0, resource_link: 0 };
      const skipped: string[] = [];
      for (const path of opts.file) {
        const isImage = /\.(?:avif|gif|jpe?g|png|webp)$/i.test(path);
        const type = isImage ? 'image' : 'resource_link';
        requested[type] += 1;
        if ((isImage && !capabilities?.image) || (!isImage && !capabilities?.resourceLink)) {
          const capability = isImage ? 'image' : 'resource_link';
          skipped.push(`${path} (${capability} unsupported by peer)`);
          continue;
        }
        try {
          blocks.push(isImage ? localImageToBlock(path) : localFileToResourceLink(path));
          sent[type] += 1;
        } catch (err: any) {
          skipped.push(`${path} (could not read: ${err?.message ?? err})`);
        }
      }
      debug.log('acp.client', 'attachment-summary', {
        sessionId,
        requested,
        sent,
        advertised: capabilities ?? null,
        skipped,
      });
      console.log(`session: ${sessionId}`);
      for (const message of skipped) console.warn(`attachment skipped: ${message}`);
      console.log(`prompt blocks: ${Object.entries(sent).filter(([, count]) => count > 0).map(([type, count]) => `${type}=${count}`).join(', ')}`);
      console.log('---');
      const result = await agent.prompt(
        sessionId,
        blocks,
        (update) => {
          // Print agent_message_chunks as they arrive so the user
          // sees streaming. Other update kinds (tool_call, plan,
          // ...) get a one-line summary.
          if (update.sessionUpdate === 'agent_message_chunk') {
            const c = update.content;
            if (c.type === 'text') process.stdout.write(c.text);
          } else if (update.sessionUpdate === 'tool_call') {
            process.stderr.write(`\n[tool: ${update.title ?? update.kind ?? '?'}]\n`);
          } else if (update.sessionUpdate === 'tool_call_update') {
            process.stderr.write(`[tool update: ${update.status ?? '?'}]\n`);
          } else {
            process.stderr.write(`[update: ${update.sessionUpdate}]\n`);
          }
        },
      );
      console.log('\n---');
      console.log(`stop: ${result.stopReason}`);
    } catch (err: any) {
      ui.error(`acp test failed: ${err?.message ?? err}`);
      process.exit(1);
    } finally {
      await agent.stop();
    }
  });

acpCmd
  .command('list')
  .description('List the ACP backends this build knows about')
  .action(async () => {
    const { listAcpBackends } = await import('./acp/backend-registry.js');
    ui.header('ACP backends');
    for (const b of listAcpBackends()) {
      const unsupported = b.unsupportedReason ? ` (unsupported: ${b.unsupportedReason})` : '';
      console.log(`  ${b.id.padEnd(10)} ${b.label}${unsupported}`);
      console.log(`             ${b.npmPackage}@${b.npmVersion}`);
    }
  });

// ── Sync flow (shared between dashboard and sync command) ──
// ⛔ 비-TTY 거부는 «읽히는 실패»로 낸다 — 스택 트레이스에 묻으면 옳은 말이 안 읽힌다.
//    같은 계약의 선례 = `writeSetupFailure`(#18720). 여기서도 rc 는 1 로 남긴다.
function writeSyncFailure(message: string): void {
  process.stderr.write(`sync: ${message}\n`);
  process.exitCode = 1;
}

async function runSyncFlow(fromDashboard: boolean): Promise<void> {
  let result: Awaited<ReturnType<typeof showSyncSelector>>;
  try {
    result = await showSyncSelector(fromDashboard);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('elanous sync 선택기는 stdin TTY가 있는 자리에서만')) {
      writeSyncFailure(error.message);
      return;
    }
    throw error;
  }
  if (result.cancelled) {
    if (!fromDashboard) closeTui();
    return;
  }

  // Run sync with progress in TUI
  await showSyncProgress(result, executeSync);

  // After sync, return to dashboard if we came from there
  if (fromDashboard) return;
  closeTui();
}

// ── voice command group (M1-4 · friction-free model selection) ──
//
// `elanous voice status` prints the resolved STT tier + model + projected
// monthly cost (PLAN-friction-free-model-selection-ux-2026-05-12 §4a.3).
// Future entries — `voice select` (ElevenLabs voice id picker · M2-2b) and
// `voice set-voice` (per-context mapping · M2-2c) — hang off this group.

const voiceCmd = program.command('voice').description('Voice tier + identity helpers (STT slider · TTS voice id · cost preview)');

voiceCmd
  .command('status')
  .description('Show active STT tier, model, and projected monthly cost')
  .action(async () => {
    const { runVoiceStatusCommand } = await import('./cli/voice-status.js');
    runVoiceStatusCommand();
  });

// M2-4 (Phase 2) + M2-4 v2 (Phase 3) — preset suggester. Heuristic by
// default · `--llm --model <id>` graduates to an LLM call so novel
// phrases ("I'm prepping a deposition next Tuesday") classify even
// without keyword hits. Both modes fall back to the heuristic on
// failure so the command never crashes a user's shell.
voiceCmd
  .command('suggest <text...>')
  .description('Suggest a use-case preset for the given text (heuristic by default · pass --llm for an LLM classifier)')
  .option('--llm', 'Route the snippet through an LLM (requires --model)', false)
  .option('--model <id>', 'Model id for the --llm path (LM Studio / OpenAI-compatible host)')
  .option('--endpoint <url>', 'OpenAI-compatible base URL (default http://localhost:1234/v1)')
  .option('--timeout-ms <ms>', 'Hard wall-clock cap before falling back to heuristic (default 5000)')
  .action(async (
    textParts: string[],
    opts: { llm?: boolean; model?: string; endpoint?: string; timeoutMs?: string },
  ) => {
    const { runVoiceSuggestCommand } = await import('./cli/voice-suggest.js');
    const text = textParts.join(' ');
    const result = await runVoiceSuggestCommand({
      text,
      ...(opts.llm ? { useLlm: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.timeoutMs ? { timeoutMs: Number.parseInt(opts.timeoutMs, 10) } : {}),
    });
    for (const line of result.output) console.log(line);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });

// M3-3 (Phase 3) — `elanous voice nl-switch <text>` CLI. Detect-only by
// default · pass `--apply --session <id>` to install a session-scoped
// override that the tier-resolver respects until TTL expiry. Used
// before the full chat surface integration lands.
voiceCmd
  .command('nl-switch <text...>')
  .description('Detect (and optionally apply) a tier switch from a natural-language phrase')
  .option('--model <id>', 'LM Studio / OpenAI-compatible model id (required)')
  .option('--endpoint <url>', 'OpenAI-compatible base URL (default http://localhost:1234/v1)')
  .option('--apply', 'Install a session-scoped override (requires --session)', false)
  .option('--session <id>', 'Session id to attach the override to')
  .option('--timeout-ms <ms>', 'Wall-clock cap before falling back to intent=none')
  .action(async (
    textParts: string[],
    opts: { model?: string; endpoint?: string; apply?: boolean; session?: string; timeoutMs?: string },
  ) => {
    const { runVoiceNlSwitchCommand } = await import('./cli/voice-nl-switch.js');
    const r = await runVoiceNlSwitchCommand({
      text: textParts.join(' '),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.apply ? { apply: true } : {}),
      ...(opts.session ? { sessionId: opts.session } : {}),
      ...(opts.timeoutMs ? { timeoutMs: Number.parseInt(opts.timeoutMs, 10) } : {}),
    });
    for (const line of r.output) console.log(line);
    if (r.exitCode !== 0) process.exit(r.exitCode);
  });

// ── Default: Dashboard (no subcommand) ──
const DASHBOARD_FLAGS = new Set(['--debug', '--chat-only', '--chat', '--yolo', '--benchmark']);

export function filterDashboardArgs(rawArgs: readonly string[], resumeFlagIdx?: number): string[] {
  const rootResumeFlagIdx = resumeFlagIdx ?? rawArgs.findIndex((arg, index) =>
    // ⛔ `-r` 은 «더 이상» resume 의 별칭이 아니다 — 원격 북마크(`--remote`)의 단축형이다.
    //    📏 뗀 근거(2026-09-01): 이 별칭은 commander option 으로 «선언된 적이 없고»
    //       `--help` 에도 안 나왔으며 docs/scripts/test/.rules 사용이 «0건»이었다.
    //       반면 `--resume`(긴 형태)은 58개 파일이 쓴다 — 그쪽은 그대로다.
    //    🩹 옛 손버릇은 `readRemoteFlag` 쪽 오류 문면이 «갈 곳을 말해» 받는다.
    arg === '--resume' && rawArgs.slice(0, index).every((prior) => prior.startsWith('-')),
  );
  const leadsWithSubcommand = rawArgs.length > 0 && !rawArgs[0]!.startsWith('-');
  return rawArgs.filter((a, i) => {
    if (!leadsWithSubcommand && (DASHBOARD_FLAGS.has(a) || a === '--rich')) return false;
    if (!leadsWithSubcommand && i === rootResumeFlagIdx) return false;
    if (!leadsWithSubcommand && rootResumeFlagIdx >= 0 && i === rootResumeFlagIdx + 1) return false;
    return true;
  });
}

async function main(): Promise<void> {
  // WD1 — seed the session working directory from the launch cwd.
  // Every later-phase subsystem reads via getSessionCwd() instead of
  // process.cwd(). Subcommand dispatch (program.parseAsync) runs
  // after this point, so every command body sees a valid SWD too.
  initSessionWorkingDir(process.cwd());

  // ★ #4 격리 누출 봉쇄(2026-07-25·내부 문서 §2) — 하니스 공간
  //   자식(self-implement/dev-harness/solve-mission)은 격리 worktree 안에서 부팅한다(cwd=worktree,
  //   ELANOUS_HARNESS_SPACE 상속). getHarnessSpace() 로 "나는 격리됐다"를 자기인지한 위에 쓰기 경계를
  //   worktree 로 활성화 → 정본 트리 절대경로 오염을 봉쇄(가드 인프라는 완비됐으나 활성화 호출이 0건이었다).
  //   코디네이터(self implement CLI)는 boot 시점엔 아직 space 마커 미설정 → 미활성(cwd=정본 트리라 정상).
  //   fail-open(경계 활성 실패가 부팅을 막지 않는다). 관측=harness.boundary.
  try {
    const { activateHarnessWriteBoundary } = await import('./harness/harness-write-boundary.js');
    activateHarnessWriteBoundary();
  } catch (e) {
    // fail-open(부팅 불침몰)이되 보안 경계 활성 실패는 **침묵 금지**(리뷰 must-fix) — error 레벨로 관측을
    //   남긴다. (b)가 실패해도 (c) 방어심화(apply.ts·process.cwd 앵커·boot 활성 무관)가 2차 봉쇄로 남는다.
    try {
      const { debug } = await import('./debug/log.js');
      debug.log('harness.boundary', 'activate.error', { error: String((e as { message?: string })?.message ?? e).slice(0, 200) }, { level: 'error' });
    } catch { /* 최후 폴백 — 로깅조차 실패해도 부팅은 계속 */ }
  }

  // Instance-identity footgun (backlog #1) — prod 인스턴스를 nested 인터랙티브로
  // 수동 spawn한 경우(--test/ELANOUS_STATE_DIR 없이) prod 스토어 오염 위험을 부팅에서
  // 시끄럽게 surfacing. warn-only(부팅 불침몰). 데몬은 nested/TTY 아니라 자연 제외.
  // (assertInstanceRootCoherence 의 형제 축 — 그건 config-dir≠state-dir '어긋남',
  //  이건 '격리를 아예 안 건 것'. divergence 가드는 nexus 데몬 부팅에서만 호출되므로
  //  이 수동 인터랙티브 경로가 지금까지 무방비였다.)
  try {
    const { warnProdSpawnFootgun } = await import('./instance-root-coherence.js');
    warnProdSpawnFootgun({ emit: 'stderr' }); // 초반 stderr surfacing만 — debug.log 는 sink 등록 後 재발행(P3·아래)
  } catch { /* 관측 경고 실패가 부팅을 막지 않는다 */ }

  let rawArgs = process.argv.slice(2);

  rawArgs = rewriteBareNexusToStatus({ rawArgs });

  // A leading --rich was a dashboard launch flag. The dashboard no longer
  // supports rich mode; reject it before remote resolution, help or TUI boot.
  if (rawArgs[0]?.startsWith('-') && rawArgs.includes('--rich')) {
    console.error('elanous: --rich is no longer supported by the dashboard');
    process.exitCode = 1;
    return;
  }

  // MT5 — ACP server mode. When present, swap the whole startup path
  // for the ACP JSON-RPC server loop. The dashboard never draws in
  // this mode; parent program drives the agent through ACP.
  //
  // U4b Step 3 — flag-based transport selection:
  //   elanous --acp-server                                   # stdio (default)
  //   elanous --acp-server --transport=unix-socket           # ~/.elanous/elanous.sock
  //   elanous --acp-server --transport=unix-socket --socket-path=/tmp/x.sock
  //   elanous --acp-server --transport=websocket --port=31415
  //   elanous --acp-server --transport=websocket --no-auth   # skip token check
  if (rawArgs.includes('--acp-server')) {
    const { bootAcpServer, parseAcpBootArgs } = await import('./boot/acp-server.js');
    const { createDaemonRuntime } = await import('./boot/daemon-runtime.js');
    const { killNonDetached: killNonDetachedPty } = await import('./pty-shell/registry.js');
    const bootOpts = parseAcpBootArgs(rawArgs);
    const acpConfig = getUserConfig();
    const agentBrand = acpConfig.llm.provider;
    const agentModel = acpConfig.llm.model;
    // MT5b — wire the same daemon runtime that `elanous serve` uses
    // (index.ts:2593+2714) so `--acp-server` answers real LLM prompts
    // instead of falling through to the pre-MVP echo skeleton in
    // `acp/server.ts`. `createDaemonRuntime()` reads ELANOUS_HISTORY_DIR /
    // ELANOUS_TOOLS / ELANOUS_TOOL_CWD env vars, so disk-backed history +
    // readonly tool surface (Read · Grep · WebSearch · M1.5 A.1/A.2)
    // are opt-in without further CLI surface area. `hasSession`
    // mirrors `elanous serve` so loadSession can validate ids minted by
    // this same process across reconnect (M2.3).
    const { runTurn, history, tools, toolCwd } = createDaemonRuntime({
      acpSessionCwd: true,
      killNonDetachedPty,
      ...(bootOpts.toolCwd !== undefined ? { toolCwd: bootOpts.toolCwd } : {}),
    });
    const hasSession = (id: string): boolean => history.has(id);
    // MT5b polish — surface env-var resolution in the startup banner
    // (boot/acp-server.ts writeRuntimeBanner). Without this, stdio
    // mode printed 0 bytes and users couldn't tell whether
    // ELANOUS_HISTORY_DIR / ELANOUS_TOOLS stuck.
    const runtimeStatus = {
      ...(history.persistencePath ? { historyDir: history.persistencePath } : {}),
      tools,
      ...(toolCwd ? { toolCwd } : {}),
    };
    await bootAcpServer(bootOpts, {
      runTurn,
      hasSession,
      runtimeStatus,
      ...(agentBrand === 'anthropic' || agentBrand === 'openai' || agentBrand === 'openai-codex'
        || agentBrand === 'grok' || agentBrand === 'gemini' || agentBrand === 'local' || agentBrand === 'openrouter'
        ? { agentBrand, ...(agentModel ? { agentModel } : {}) }
        : {}),
    });
    return;
  }

  // Root-level launch flags for the dashboard. Stripped before
  // commander sees them so `elanous --debug` alone falls through to
  // showDashboard instead of being misread as a missing subcommand.
  //   --debug       mirror ON + file ON + chat-only (tablet friendly)
  //   --chat-only   chat-only layout only (log fills the viewport)
  //   --yolo        code-edit policy = unsupervised from boot (no
  //                 approval modals, apply-as-we-go). Pairs well with
  //                 --debug for trust-by-inspection sessions.
  //   --benchmark   benchmark-friendly chat boot: chat-only layout +
  //                 input focus from frame 1. Intended for scripted
  //                 Q&A benchmark loops (`bun run dev --benchmark`).
  // T4.C — `elanous` no-arg default remote bookmark resolve. Order:
  //   --local > --remote <name> > ELANOUS_REMOTE > remotes.json default > local.
  // When a bookmark resolves, we synthesize ELANOUS_REMOTE / ELANOUS_TOKEN
  // env so the existing resolveRemoteTarget path picks it up unchanged.
  // `--local` / `--remote <name>` are stripped from rawArgs so commander
  // doesn't see them.
  const { resolveRemoteAttach, stripRemoteFlags, bookmarkToElanousRemote } =
    await import('./cli/remote-resolve.js');
  let resolutionForReporting: ReturnType<typeof resolveRemoteAttach> | null = null;
  try {
    resolutionForReporting = resolveRemoteAttach({ rawArgs });
  } catch (err) {
    console.error(`elanous: ${(err as Error).message}`);
    process.exit(1);
  }
  if (resolutionForReporting?.kind === 'remote') {
    const { entry, token, name, reason } = resolutionForReporting;
    // 🩸 이 블록은 원래 위 try «밖»에 있었다 — 그래서 손상된 remotes.json 이
    //    사람에게 `elanous: <이유>` 대신 ***스택 트레이스***로 나왔다.
    //    📏 통합 시험이 그것을 잡았다(2026-09-01). 같은 가드 안으로 들인다.
    //    ⛔ 「해석은 지키고 «사용»은 안 지키는」 반쪽 가드를 남기지 않는다.
    try {
      process.env.ELANOUS_REMOTE = bookmarkToElanousRemote(entry);
    } catch (err) {
      console.error(`elanous: ${(err as Error).message}`);
      process.exit(1);
    }
    if (token) process.env.ELANOUS_TOKEN = token;
    if (reason === 'default-bookmark') {
      console.log(`[elanous] attaching to default remote: ${name} (${entry.label ?? entry.host})`);
    } else {
      console.log(`[elanous] attaching to remote: ${name}`);
    }
  }
  // ⭐ readRemoteFlag 와 «같은» 규칙으로 걷어낸다 — 갈리면 한쪽이 값을 먹고
  //    다른 쪽이 굶어서 서브커맨드가 사라진다(실측으로 그 상태를 밟았다).
  //    ⇒ 이제 규칙이 «문법»뿐이라(북마크 스토어를 안 본다) 인자도 없다.
  rawArgs = stripRemoteFlags(rawArgs);

  // M2.4 — remote-daemon path. `ELANOUS_REMOTE=mbp.tailnet:31415` (or
  // a full ws:// URL) makes the dashboard attach to a remote daemon
  // instead of booting an in-process ACP pair. Token + no-auth
  // mirror the `elanous attach` flag set so users can drive both the
  // REPL and the dashboard from a single shell config.
  const remoteEnv = process.env.ELANOUS_REMOTE?.trim();
  let remote: { url: string; token?: string; label?: string } | undefined;
  if (remoteEnv) {
    const { resolveRemoteTarget } = await import('./tui-client/remote-target.js');
    const resolved = await resolveRemoteTarget({});
    if (resolved) remote = resolved;
  }

  // Root dashboard resume accepts `--resume`. Only a
  // leading launch flag is owned here: a subcommand's `-r` stays
  // with that subcommand until Commander parses it.
  const resumeFlagIdx = rawArgs.findIndex((arg, index) =>
    // ⛔ `-r` 은 «더 이상» resume 의 별칭이 아니다 — 원격 북마크(`--remote`)의 단축형이다.
    //    📏 뗀 근거(2026-09-01): 이 별칭은 commander option 으로 «선언된 적이 없고»
    //       `--help` 에도 안 나왔으며 docs/scripts/test/.rules 사용이 «0건»이었다.
    //       반면 `--resume`(긴 형태)은 58개 파일이 쓴다 — 그쪽은 그대로다.
    //    🩹 옛 손버릇은 `readRemoteFlag` 쪽 오류 문면이 «갈 곳을 말해» 받는다.
    arg === '--resume' && rawArgs.slice(0, index).every((prior) => prior.startsWith('-')),
  );
  const resumeFromFlag = resumeFlagIdx >= 0 ? rawArgs[resumeFlagIdx + 1] : undefined;
  // Step 5 PR γ — env read routes through readDeprecatedEnv so the
  // user gets a one-shot deprecation warning when the env override
  // drives the resume path. CLI flag wins outright (no warning).
  const { readDeprecatedEnv: readDeprecatedEnvForResume } = await import('./control-client/env-resolver.js');
  const resumeFromEnv = readDeprecatedEnvForResume('ELANOUS_RESUME_SESSION').value;
  const resumeSessionId = (resumeFromFlag ?? resumeFromEnv ?? '').trim() || undefined;

  // user-config can opt into benchmark mode persistently
  // (`dashboard.benchmark: true`) so callers don't have to retype the
  // flag every run. CLI `--benchmark` still forces it on regardless.
  const benchmarkConfigured = getUserConfig().dashboard.benchmark === true;
  const benchmark = rawArgs.includes('--benchmark') || benchmarkConfigured;
  const dashboardOpts = {
    debug: rawArgs.includes('--debug'),
    chatOnly:
      rawArgs.includes('--chat-only') ||
      rawArgs.includes('--chat') ||
      rawArgs.includes('--debug') ||
      benchmark,
    yolo: rawArgs.includes('--yolo'),
    benchmark,
    ...(remote ? { remote } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
  // Strip root `--resume <id>` before Commander parses.
  // The dashboard-only two-token form must not become a subcommand
  // selector; subcommand-owned `-r` is preserved by filterDashboardArgs.
  // DASHBOARD_FLAGS are dashboard LAUNCH flags — only strip them in the
  // dashboard path (no leading subcommand). When a real subcommand leads
  // (e.g. `session watch --debug`), stripping them here would silently
  // eat that subcommand's own option before commander ever sees it.
  const args = filterDashboardArgs(rawArgs, resumeFlagIdx);

  // Bare `elanous` (no subcommand) → the dashboard, always. The former
  // `global.entry.defaultMode` switch (which could route here to the
  // headless NEXUS daemon) was removed 2026-07-24: T3/T4 deleted the
  // NEXUS interactive TUI, so every non-dashboard route was a dead-end
  // and the daemon has its own canonical entry (`elanous nexus run`).
  // We stay quiet on the common path, but if a NEXUS daemon is live on
  // this host emit one hint so the user knows the dashboard + daemon
  // coexist. See 내부 문서 `REPORT-tui-observation-methodology-2026-07-24` §12.
  if (args.length === 0) {
    const { isNexusDaemonLive, nexusDaemonLiveHint } = await import('./cli/nexus-daemon-hint.js');
    if (isNexusDaemonLive()) console.log(nexusDaemonLiveHint());
  }

  if (args.length > 0) {
    // C-4e (cleanup ROADMAP 2026-05-08): FROZEN_ROOTS gate removed.
    // The 17 entrypoints (elanous ctl/telegram/discord + serve) were
    // physically deleted in C-4a-d, so unknown commands now fall through
    // to commander's default "unknown command" handling.
    // ★ 소유권 감사 훅 — `ELANOUS_TEST_FLAG_AUDIT=1` 이면 실 Commander 트리의 미포함 경로를
    //   JSON 으로 뱉고 종료한다. 테스트가 이걸 spawn 해 **CI 에서 차단**한다(경고 fail-open 만으로는
    //   테이블 누락이 조용히 통과하므로). 일반 실행 경로에는 영향 0.
    if (process.env.ELANOUS_TEST_FLAG_AUDIT === '1') {
      const missing = uncoveredTestFlagPaths(program as never);
      const stale = staleTestFlagPaths(program as never);
      await writeStdoutJson(JSON.stringify({
        uncovered: missing.map((p) => p.join(' ')),
        stale: stale.map((p) => p.join(' ')),
      }) + '\n');
      process.exit(missing.length === 0 && stale.length === 0 ? 0 : 1);
    }
    // 런타임 관측(거부 없음) — 수복은 하지 않는다(위 감사가 CI 에서 막는다).
    try { observeTestFlagOwnership(program as never); } catch { /* fail-open */ }
    const firstCommand = args[0];
    if (
      firstCommand !== undefined
      && !firstCommand.startsWith('-')
      && args.some((arg) => arg === '--help' || arg === '-h')
      // Commander implicitly registers its `help [command]` command outside
      // program.commands, so preserve its native help dispatch.
      && firstCommand !== 'help'
      && !program.commands.some((command) => command.name() === firstCommand || command.aliases().includes(firstCommand))
    ) {
      program.error(`error: unknown command '${firstCommand}'`);
      return;
    }
    await program.parseAsync(['node', 'elanous', ...args]);
    return;
  }

  // First-run: trigger the onboarding wizard before dropping into the
  // dashboard so we don't need to handle half-configured state in the
  // TUI chrome. Subsequent launches skip straight to the dashboard.
  // (Bare `elanous` always lands on the dashboard now, so the wizard just
  // gates on config completeness — no entry-mode branch.)
  const cfg = getUserConfig();
  if (needsOnboarding(cfg)) {
    if (!await runFirstSetupForCli(cfg)) return;
  }

  // Active-provider banner so users know WHICH model/auth is about to
  // answer their first prompt. Printed above the dashboard altscreen
  // so it stays visible on quit (scrolls back into the terminal).
  console.log(`[elanous] ${oneLineProvider()}`);
  if (remote) {
    const authNote = remote.token ? 'token' : 'no-auth';
    console.log(`[elanous] remote daemon: ${remote.url} (${authNote})`);
    if (resumeSessionId) {
      console.log(`[elanous] resuming daemon session: ${resumeSessionId}`);
    }
  }

  // Tier 1 Phase 3 양방향 sync — when a daemon is reachable on the
  // local host, mirror TUI session/message events to it via
  // POST /v1/sessions/external. Probes once + silently disables on
  // failure so standalone TUI runs aren't penalized. Activation is
  // best-effort and never blocks the dashboard.
  void (async () => {
    try {
      const { activateDaemonMirrorIfReachable } = await import('./session/daemon-mirror.js');
      await activateDaemonMirrorIfReachable({
        log: (m) => { if (process.env.ELANOUS_DAEMON_MIRROR_VERBOSE) console.log(`[elanous] ${m}`); },
      });
    } catch { /* mirror is opportunistic — never break dashboard boot */ }
  })();

  // 독립 TUI 프로세스 — 데몬과 동형으로 logs.db StoreSink 를 등록해 `debug.log(...)`
  // (특히 agent.source 소스수집 관측 · #4631)가 logs.db 에 닿고 `elanous logs` 로 조회되게
  // 한다. 인터랙티브 TUI 는 데몬 sink 를 상속 안 하므로 안 붙이면 debug.log 가 no-op
  // (제1원칙 관측 갭 · tui-sim 드라이브에서 agent.source 0건으로 실측 2026-07-19).
  // PR#4622(self utterance CLI)·session-cli 미러. fail-open·비블로킹.
  try { await (await import('./domains/standalone-log-sink.js')).registerStandaloneLogSink('tui'); } catch { /* fail-open */ }
  // P3(대표 2026-07-26) — footgun 관측을 logs.db 에 도달시킨다. 초반(arg 파싱 前) warnProdSpawnFootgun 은
  //   StoreSink 등록 前이라 debug.log 가 logs.db 미도달이었다(순서 갭). sink 등록 직후 관측만 재발행(stderr 중복 X).
  try { (await import('./instance-root-coherence.js')).warnProdSpawnFootgun({ emit: 'log' }); } catch { /* fail-open */ }

  // Self-observation (PLAN P1b · S1) — the interactive TUI self-reports
  // its rendered frames to the ChannelBus + cross-process pty-manifest,
  // so `elanous self screen` / `/v1/terminals` / (P2) PWA can see the
  // dashboard the user is actually looking at. Off unless this boots
  // (no producer in headless/daemon paths). fail-soft·비블로킹.
  try { (await import('./capture/tui-self-report.js')).startTuiSelfReport(); } catch { /* fail-soft */ }

  // Dashboard handles sync inline — only returns on quit
  // ⛔ stdin 이 TTY 가 아니면 «뜨지 않는다» — 뜨면 readKey 가 엔터를 지어내 초당 수백 프레임을
  //   다시 그린다(엔터 폭풍 · 2026-09-17 실측). 기전·수치는 dashboard/tty-required.ts 머리말.
  {
    const { dashboardCanUseTty, dashboardTtyRefusalMessage } = await import('./dashboard/tty-required.js');
    if (!dashboardCanUseTty()) {
      console.error(dashboardTtyRefusalMessage());
      process.exitCode = 1;
      return;
    }
  }
  await showDashboard(dashboardOpts);
  closeTui();
  // Force exit: the dashboard starts background timers (clipboard
  // poller, shimmer/blink animations) that keep the Bun event loop
  // alive even after the TUI tears down. Without this hard exit,
  // `q` / Ctrl+Q would leave the user staring at a wedged terminal
  // until they sent SIGINT.
  process.exit(0);
}

/**
 * CLI 진입 — **엔트리가 명시적으로 부른다.**
 *
 * ⛔ `if (import.meta.main)` 만으로 감싸지 말 것(#6701 회귀 · GIT-T13).
 *   배포 엔트리는 `bin/elanous.mjs` 이고 그것이 이 모듈을 **import** 하므로
 *   여기의 `import.meta.main` 은 **항상 false** 다. 그 가드 하나로 `elanous` 전
 *   명령이 출력 0바이트·exit 0 의 조용한 no-op 이 됐다(테스트 3 pass 통과).
 *   가드의 원래 목적(테스트가 `program` 을 import 해도 main 이 안 돌 것)은
 *   유지하되, 실행은 **엔트리의 명시 호출**로 되돌린다.
 *   - `bun bin/elanous.mjs …`  → bin 이 `runCli()` 를 부른다
 *   - `bun run src/index.ts …`(package.json `dev`) → 아래 import.meta.main 분기
 *   - `import { program } from './index.js'`(테스트) → 둘 다 안 걸려 조용하다
 * 회귀 방어 = `src/cli-entry.test.ts`(실물 `bin/elanous.mjs` 를 spawn 한다).
 */
export function runCli(): void {
  main().catch((err) => {
    closeTui();
    if (isCliUserError(err)) {
      console.error(formatCliUserError(err));
      process.exit(1);
    }
    throw err;
  });
}

if (import.meta.main) runCli();
