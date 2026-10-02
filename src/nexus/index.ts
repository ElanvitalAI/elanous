// NEXUS · entry (Phase N-1 PR α — opt-in skeleton)
//
// `elanous nexus` enters here. PR α delivers the minimum control surface:
//   1. Acquire `~/.elanous/nexus/.lock` (single instance per host)
//   2. Write `~/.elanous/nexus/runtime.json` (pid · startedAt · phase)
//   3. Print boot banner (paths · phase · what's available)
//   4. Wait for SIGINT/SIGTERM, then release + exit cleanly
//
// PR β adds the SidebarTabSurface mount + chat/webterm kinds.
// PR γ wires the always-on mini-terminal footer.
// PR δ stands up the HTTP API + SSE on auto-picked port.
//
// Default flip (`elanous` no-arg → NEXUS) lands in PR β alongside
// the chat kind so the no-arg path always boots into a usable tab.
// In PR α `elanous nexus` is opt-in only; `elanous` continues to launch
// the legacy dashboard.

import { hostname } from 'node:os';
import { resolveToolCwd } from '../boot/tool-cwd.js';
import { acquireNexusLock, NexusLockError, readNexusLock, findNexusLifecycleState } from './supervisor/lock.js';
import { classifyNexusStatus, type NexusHttpHealth } from './status-line.js';
import {
  deleteNexusRuntime,
  readNexusRuntime,
  writeNexusRuntime,
  type NexusRuntimeMeta,
} from './runtime.js';
import { nexusLockPath, nexusRuntimePath, nexusRootDir } from './paths.js';
import { createPwaRegistration, type PwaRegistrationDeps } from './pwa-registration.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { startPortLeaseHeartbeat } from '../control-plane/port-lease-heartbeat.js';
import { PORT_BANDS } from '../control-plane/ports.js';
import { DEFAULT_NEXUS_HTTP_PORT } from './default-port.js';
import { createNexusState } from './state/state.js';
import { TabRegistry } from './state/tab-registry.js';
import { createChatTabSpec } from './kinds/chat.js';
import { createWebtermTabSpec } from './kinds/webterm.js';
import {
  tryRegisterDaemon,
  tryAutoStartDaemon,
} from './boot/register-daemon.js';
// C-2a: re-export so test/nexus-daemon-tab-default-off.test.ts (which
// imports from `../src/nexus/index.js`) keeps working without churn.
export { shouldRegisterDaemon } from './boot/register-daemon.js';
import {
  tryRegisterPwaHost,
  tryAutoStartPwaHost,
} from './boot/register-pwa-host.js';
import type { ChannelBotPlatform } from './kinds/channel-bot.js';
import {
  tryRegisterChannelBots,
  tryAutoStartChannelBots,
  type RegisteredChannelBot,
} from './boot/register-channel-bots.js';
import { loadTemplate } from './templates/loader.js';
import { applyTemplate } from './templates/apply.js';
import { loadAllBuiltins } from './config/builtins/index.js';
import { readUserConfig, readSwitchValue, patchUserConfig, writeSwitchValue } from './config/user-config.js';
import { buildOutboundSubstrate, type OutboundSubstrate } from '../notifications/outbound-boot.js';
// ⑨ 런컨텍스트 — 자율빌드/측정/시뮬 컨텍스트면 outward 서피스(telegram/discord) autostart 억제(운영 409·노이즈 방지).
import { isAutonomousRunContext } from '../agent/run-context.js';
import {
  wireIntentPredictionToRouter,
  type IntentPredictionRouterBridgeHandle,
} from '../intent-prediction/router-bridge.js';
import { buildPatcherSubstrate, stopPatcherSubstrate, type PatcherSubstrate } from '../background-reasoning/patcher-boot.js';
import { resolvePatcherLlmCallables } from '../background-reasoning/patcher-llm-resolver.js';
import { buildDevicesSubstrate, stopDevicesSubstrate, type DevicesSubstrate } from '../mission-templates/devices-boot.js';
import { migrateLegacyEnvToConfig } from './config/env-migrate.js';
import { selectBackendFromConfig } from './config/secrets/index.js';
import { registerAllCloudBackends } from './config/secrets/register-cloud.js';
// PLAN-tui-redundancy-cleanup T4 (2026-05-16) — NEXUS TUI shell 정리.
// PLAN-nexus-shell-followup U1+U2 (2026-05-16) — mini-terminal{,-backend}
// → nexus/webterm/pty.ts 통합. `MiniTerminal` class + `createMiniTermSpawn`
// 은 TUI-only 였고 T4 이후 dead → 정리. `PtyBackend` + `createWebtermSpawn`
// 만 살아남아 iOS/PWA webterm 의 PTY substrate 로 사용.
import { type PtyBackend, createWebtermSpawn, resolveWebtermCwd } from './webterm/pty.js';
import { SettingsTabController } from './config/settings-controller.js';
import { tryRegisterSettings } from './boot/register-settings.js';
import { registerMcpClients, type McpClientsHandle } from './boot/register-mcp-clients.js';
import { syncInstalledPluginNodes } from '../graph-kinds/installed-plugin-nodes.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import type { McpReloadOutcome, McpReloadServerResult } from './api/admin-mcp-reload.js';
import { loadOrCreateSigningKey, NonceStore } from './api/edit-in-pwa-core.js';
import { subscribeErrorSnapshotWriter } from './supervisor/error-snapshot.js';
import { NexusEventBus } from './api/event-bus.js';
import type { SessionSurface } from '../session/index.js';
import { wireWorkflowApprovalEvents } from './api/workflow-event-bridge.js';
import { wireAgentStatusEvents } from './api/agent-status-event-bridge.js';
import { wireHudSegmentEvents } from './api/hud-event-bridge.js';
import { wireSessionStoreEvents } from './api/session-store-events.js';
import { wireSessionDirWatch } from './api/session-dir-watch.js';
import { wireSessionS3Backup } from '../session/s3-backup.js';
import { wireDaemonHistoryToStore, makeSessionStoreReadThrough } from './api/session-history-mirror.js';
import { HudStore } from './state/hud-store.js';
import { AgentStatusStore } from '../agent-status/store.js';
import { setAcpAgentStatusStore } from '../acp/turn-runner.js';
import { setWorkflowRunEventBus } from './api/workflow-run-event-bridge.js';
import {
  publishTriggerFired,
  publishTriggerSubscribed,
  publishTriggerUnsubscribed,
  setTriggerEventBus,
} from './api/trigger-event-bridge.js';
import {
  createWorkflowRuntimeDaemon,
  type WorkflowRuntimeDaemon,
} from '../workflow-runtime/daemon.js';
import { discoverWorkflows as discoverWorkflowsForDaemon } from '../workflow-runtime/discovery.js';
import { buildDefaultWorkflowDeps as buildWorkflowDaemonDeps } from './api/workflows.js';
import { startNexusHttpServer, type NexusHttpServer, type NexusWsBridgeInit } from './api/http-server.js';
import { startControlServer } from '../control-plane/server.js';
import { nexusMemberMachine, startMemberHeartbeat } from '../control-plane/member.js';
import { resolvePrimary } from '../control-plane/primary.js';
import { cleanGhostTailscaleServe } from '../cli/tailscale-serve.js';
import { buildNextFluentRouteOpts } from './api/next-fluent-wiring.js';
import { bootDefaultOcrProviders, type OcrRegistry } from '../ocr/index.js';
import {
  startDiscoveryCron,
  type DiscoveryCronHandle,
} from '../registry/discovery/cron.js';
import { discoverObsidianVault } from '../auto-research/obsidian-bridge.js';
import { createNotesMetricsCollector } from '../notes/metrics.js';
import { createDayBucketStore } from '../notes/day-bucket-store.js';
import { createNotesPolishCallable, isVisionPolishAvailable } from '../notes/polish-callable.js';
import {
  createDailyReflectionPolishCallable,
  isDailyReflectionPolishAvailable,
} from '../notes/daily-reflection-polish.js';
import {
  startDailyReflectionScheduler,
  type DailyReflectionSchedulerHandle,
} from '../notes/daily-reflection-scheduler.js';
import { type ScheduleRunnerHandle } from '../domains/schedule-runner.js';
import { resolvePwaStaticDir } from './static-dir-resolve.js';
import {
  createHitlPendingCallbacks,
  type HitlPendingCallbacks,
} from './api/hitl-runtime.js';
import {
  createPushcutConfirmChannel,
  registerDefaultConfirmChannels,
  type ConfirmChannel,
} from '../hitl/confirm.js';
import {
  installFileAuditHook,
  registerHitlAuditHook,
} from '../hitl/audit-log.js';
import { createPwaConfirmChannel, createPwaQuestionChannel } from './api/hitl-pwa-channel.js';
import { registerDefaultQuestionChannels, requestQuestion } from '../hitl/question.js';
import {
  getAskUserQuestionResolver,
  setAskUserQuestionResolver,
  type AskUserQuestionResolver,
} from '../ask-user-question/index.js';
import {
  createNexusTelegramHitlHandle,
  readNexusTelegramHitlOptsFromEnv,
  type NexusTelegramHitlHandle,
  type NexusTelegramHitlOpts,
} from './api/hitl-telegram-channel.js';
import {
  createNexusDiscordHitlHandle,
  readNexusDiscordHitlOptsFromEnv,
  type NexusDiscordHitlHandle,
  type NexusDiscordHitlOpts,
} from './api/hitl-discord-channel.js';
import {
  createNexusDiscordTriggerBot,
  type NexusDiscordTriggerBotHandle,
} from './api/discord-trigger-bot.js';
import {
  createNexusTelegramTriggerBot,
  type NexusTelegramTriggerBotHandle,
  type NexusTelegramTriggerBotOpts,
} from './api/telegram-trigger-bot.js';
import {
  createNexusTerminalHitlChannel,
  type NexusTerminalHitlOpts,
} from './api/hitl-terminal-channel.js';
import {
  createIntentPredictionService,
  createFeedbackStore,
  type IntentContext,
  type IntentPredictionService,
} from '../intent-prediction/index.js';
import { createTurnTracker, type TurnTracker } from '../intent-prediction/turn-tracker.js';
import { getPushcutClient } from '../pushcut/client.js';
import {
  NexusChatSession,
  type NexusChatSessionRegistry,
} from './chat/session.js';
import { readChatTabBackend } from './kinds/chat.js';
import { detectChatBackend } from './chat/auto-detect.js';
import {
  NexusWebtermSession,
  type NexusWebtermSessionRegistry,
} from './webterm/session.js';
import { pushEvent } from './state/state.js';
import { createSupervisor, type Supervisor } from './supervisor/index.js';
import {
  DaemonSessionHistory,
  isDaemonSessionOrigin,
  type DaemonSessionOrigin as _DaemonSessionOrigin,
} from '../boot/daemon-runtime.js';
import { createDaemonMultiLlmRunTurn } from '../boot/daemon-multi-llm-runtime.js';
import { toolSurface } from '../boot/daemon-tools/index.js';
import type { DaemonToolSurfaceKind } from '../boot/daemon-tools/types.js';
import {
  getActiveAcpFeedbackBroadcaster,
  runAcpServer,
  type AcpServerOptions,
} from '../acp/server.js';
import { globalAcpAgentManager } from '../acp/agent-manager.js';
import { fetchCodexPlugins } from '../acp/codex-plugins.js';
import { globalAgentCliConversationStore } from './api/agent-cli-conversation-store.js';
import { globalMissionRouter } from '../llm/mission-router.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { debug } from '../debug/log.js';
import { createNotificationActionLoopback } from '../web-push/notification-action-loopback.js';
import {
  startSessionDecisionForward,
  type SessionDecisionForwardHandle,
} from './api/session-decision-forward.js';
import type {
  AcpConnectionHandler,
  AcpTransportServer,
} from '../acp/transport/types.js';
import { createAuthVerifier, type AcpAuthTokenRecord, type AcpAuthVerifier } from '../acp/transport/auth.js';
import { matchTempToken } from '../auth/temp-tokens.js';
import { loadEnvelope, type TokenStoreEnvelope, type TokenStorePaths } from '../auth/token-store.js';
import {
  createVoiceRestHandler,
  getDaemonSttProvider,
} from '../voice/voice-rest-handler.js';
import {
  createStubPwaVoiceAdapter,
  type PwaVoiceAdapter,
} from '../voice/channel-adapters/pwa-voice-adapter.js';
import { getIntakeStore } from '../intake-plane/runtime.js';
import { join as joinPath } from 'node:path';
import { ensureAuthToken } from '../auth/acp-token.js';
import type { SupervisorSpawnBackend } from './supervisor/spawn.js';
import type { HealthProbeBackend } from './supervisor/health.js';
import { gracefulExit, cleanExit } from './supervisor/graceful-exit.js';
import { restoreFromPending } from './supervisor/restore-state.js';
import { resolveHeadlessMode } from './headless-mode.js';
import { checkSetupStatus, readNexusSetupMode, renderSetupStatus, setupBootMode, setupModeBootPlan } from './setup-status.js';
import { probeTailscale } from './onboarding/tailscale-probe.js';
import {
  runPwaSharePrompt,
  defaultServe as defaultTailscaleServe,
  type ShareTailnetValue,
} from './onboarding/pwa-share-prompt.js';
import { runFirstBootWizard } from './onboarding/first-boot-wizard.js';
// Phase 2 of RESEARCH-tox-surface-agnostic-boot-2026-05-13 — surface-
// agnostic TOX bootstrap + subagent surface bridge to globalAgentRegistry.
import { wireTox, type ToxBootHandle } from '../task-orchestrator/boot.js';
import { createExternalExecAdapter } from '../task-orchestrator/surfaces/external-exec.js';
import { dispatchSelfImplement } from '../boot/daemon-tools/self-implement.js';
import { TaskStore, hydrateGraph } from '../task-orchestrator/store.js';
import { createGlobalSubagentCallable } from '../agent/subagent-callable.js';
import { setAgentHopCap } from '../agent/registry.js';
import type { SidebarTabSurface } from '../ui/widgets/sidebar-tab-surface.js';
import { defaultIO, runOnboardingStep, type WizardIO } from '../onboarding.js';
import { packageVersion } from '../version/code-revision.js';

// 데몬 배너·`nexus status`·연결 라벨이 보이는 판 = 제품 판(`package.json`) — 옛 내부 상수 `0.17.0` 이 0.2.x 제품 옆에 떴다(🅞 M5 · M5c).
export const NEXUS_VERSION = packageVersion();
export const NEXUS_PHASE = 'N-5 PR χ (graceful exit + restart pending)';

type TelegramAgentRunTurnFactory = typeof import('../telegram-agent.js').makeTelegramAgentRunTurn;
type TelegramChannelResolver = typeof import('../domains/telegram-channels.js').resolveTelegramChannels;
type TelegramInteractivePollerSelector = typeof import('../domains/telegram-channels.js').interactivePollerTokens;

export interface NexusTelegramQaPollerWireDeps {
  makeTelegramAgentRunTurn: TelegramAgentRunTurnFactory;
  resolveTelegramChannels: TelegramChannelResolver;
  interactivePollerTokens: TelegramInteractivePollerSelector;
  createTriggerBot: (opts: NexusTelegramTriggerBotOpts) => NexusTelegramTriggerBotHandle | null;
  /** 토큰별 프로세스 사이 잠금(`src/telegram-poll-lock.ts`). 없으면 잠그지 않는다(종전 동작). */
  pollLock?: {
    tryAcquire: (token: string) => { ok: true; release: () => void } | { ok: false };
    acquire: (token: string) => Promise<{ ok: true; release: () => void } | { ok: false }>;
  };
  /** 잠금이 잡혀 있어 뒤로 미룬 폴러가 늦게 뜰 때 핸들을 넘긴다(종료 때 함께 멈추도록). */
  onLateStart?: (wired: NexusTelegramQaPollerWireHandle) => void;
}

export interface NexusTelegramQaPollerWireHandle {
  channel: ReturnType<TelegramChannelResolver>[number];
  handle: NexusTelegramTriggerBotHandle;
}

export function wireNexusTelegramQaPollers(
  cfg: UserConfig,
  workflowDaemon: Pick<WorkflowRuntimeDaemon, 'dispatchTelegram'>,
  deps: NexusTelegramQaPollerWireDeps,
): NexusTelegramQaPollerWireHandle[] {
  const handles: NexusTelegramQaPollerWireHandle[] = [];
  const mainToken = resolveChannelBotToken('telegram', cfg)?.token;
  const pollers = deps.interactivePollerTokens(deps.resolveTelegramChannels({ ...cfg.telegram, botToken: mainToken }));
  for (const channelConfig of pollers) {
    const channelScopedConfig = { ...cfg, telegram: { ...cfg.telegram, botToken: channelConfig.botToken } };
    const start = (release?: () => void): NexusTelegramQaPollerWireHandle | null => {
      const handle = deps.createTriggerBot({
        token: channelConfig.botToken,
        allowedUsers: [...cfg.telegram.allowedUsers],
        dispatch: (event) => workflowDaemon.dispatchTelegram(event),
        userConfig: channelScopedConfig,
        runTurnImpl: deps.makeTelegramAgentRunTurn(channelScopedConfig),
      });
      if (!handle) { release?.(); return null; }
      if (!release) return { channel: channelConfig, handle };
      return {
        channel: channelConfig,
        handle: { ...handle, stop: async (opts) => { try { await handle.stop(opts); } finally { release(); } } },
      };
    };
    if (!deps.pollLock) {
      const wired = start();
      if (wired) handles.push(wired);
      continue;
    }
    const first = deps.pollLock.tryAcquire(channelConfig.botToken);
    if (first.ok) {
      const wired = start(first.release);
      if (wired) handles.push(wired);
      continue;
    }
    // 다른 프로세스가 이 토큰을 폴링 중이다(재시작 겹침일 수 있다) — 이 토큰만 뒤로 미룬다.
    debug.log('telegram.poll-lock', 'poller-deferred', { channel: channelConfig.name, botId: channelConfig.botToken.split(':')[0] });
    void deps.pollLock.acquire(channelConfig.botToken).then((late) => {
      if (!late.ok) {
        console.warn(`[telegram] 채널 '${channelConfig.name}' 폴러를 띄우지 않았다 — 같은 토큰을 다른 프로세스가 폴링 중 (elanous logs --category telegram.poll-lock)`);
        return;
      }
      const wired = start(late.release);
      if (wired) deps.onLateStart?.(wired);
    }).catch((err: unknown) => {
      debug.log('telegram.poll-lock', 'poller-deferred-failed', { channel: channelConfig.name, error: err instanceof Error ? err.message : String(err) });
    });
  }
  return handles;
}

export const CONTINUATION_LOOP_TTL_MINUTES = 24 * 60;

/** Source-aware lifecycle identity: queue attempts need their queue ID, while auto-mode has only its goal slug. */
export function continuationLoopId(goal: { source?: 'auto-mode' | 'file-queue'; goalSlug: string; id?: string }): string | undefined {
  if (goal.source === 'auto-mode') return `continuation:auto-mode:${goal.goalSlug}`;
  if (goal.source === 'file-queue' && goal.id) return `continuation:file-queue:${goal.id}`;
  return undefined;
}

export interface RunNexusOptions {
  /** --status: print runtime + lock state, exit. No daemon mode. */
  status?: boolean;
  /** --stop: send SIGTERM to the lock holder (if any), exit. */
  stop?: boolean;
  /** --force: take lock even when an apparently-alive holder exists. */
  force?: boolean;
  /** --dispatch: enable the §5-③ autonomous idle-continuation scheduler
   *  for this run (same effect as user-config `dispatch.enabled`).
   *  Default off — ignites self-firing turns, so it's opt-in. */
  dispatch?: boolean;
  /** Bypass the wait loop (tests). When true, runNexus returns the
   *  release callback after writing runtime.json instead of blocking. */
  detachForTesting?: boolean;
  /** Test-only observation of the live continuation scheduler created by runNexus. */
  onContinuationSchedulerStarted?: (scheduler: import('../dispatch/continuation-scheduler.js').ContinuationScheduler) => void;
  /** Test-only PWA registry dependency seam. Production uses the registry defaults. */
  pwaRegistrationDeps?: PwaRegistrationDeps;
  /** Test-only runtime-sidecar observation emitted after each write. */
  onRuntimeSidecarWrite?: (runtime: NexusRuntimeMeta) => void;
  /** Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) —
   *  optional AgentStatusStore wire. When provided, every
   *  store.set(...) transition fans out as an `agent.status`
   *  NexusEvent on the `/v1/events` SSE bus so PWA chat hydrates
   *  `<StatusChip>` via `subscribeAgentStatusEvents`. Default:
   *  undefined — daemon-only mode has no agents to track. Dashboard
   *  callers pass their existing store (`src/dashboard/index.ts:
   *  agentStatusStore`) when running nexus in-process. */
  agentStatusStore?: AgentStatusStore;
  /** PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — optional
   *  HudStore. Default undefined → runNexus creates a fresh store so
   *  the IPC seam + dashboard mirror always have a canonical sink.
   *  Tests inject their own to assert deterministic transitions
   *  without the dashboard process. */
  hudStore?: HudStore;
  /** N-1 cleanup PR d — webterm tab PTY backend factory. When
   *  provided, every registered webterm-kind tab gets a
   *  NexusWebtermSession with this backend so the detail view
   *  renders live PTY output and the TUI key dispatcher forwards
   *  keystrokes to the child. Tests pass a mock; production wires
   *  the node-pty factory in PR e (mini-terminal-backend.ts). When
   *  omitted the webterm tabs render the placeholder view (the
   *  registry stays empty so the dispatcher's webterm interception
   *  is a no-op). */
  webtermSpawn?: (spec: { id: string; cwd?: string }) => PtyBackend;
  /** Explicitly disable HTTP and ACP websocket token auth for this run. */
  noAuth?: boolean;
  /** Skip the HTTP API server boot. Default: true in tests via
   *  detachForTesting; production runs always start the server. Tests
   *  that DO want the server can pass false explicitly. */
  skipHttpServer?: boolean;
  /** Override starting port for the HTTP server. Defaults to 31415. */
  httpStartPort?: number;
  /** Control-plane port; passing 0 also enables an isolated listener in detached tests. */
  controlPort?: number;
  /** Override host for the HTTP server. Defaults to '127.0.0.1'. */
  httpHost?: string;
  /** Test seam for the best-effort stale Tailscale Serve cleanup before bind. */
  cleanGhostTailscaleServeFn?: (port: number) => Promise<unknown>;
  /** Inject a supervisor spawn backend (tests use the in-memory variant). */
  supervisorSpawnBackend?: SupervisorSpawnBackend;
  /** Inject health probe backend (tests use a mock). */
  supervisorProbes?: HealthProbeBackend;
  /** Skip supervisor wiring entirely (tests that only exercise N-1 wires). */
  skipSupervisor?: boolean;
  /** Register the default daemon tab (HANDOFF D-5: daemon is the only
   *  kind auto-enabled at boot). Defaults to `!detachForTesting` so the
   *  test path stays single-purpose unless a test opts in explicitly. */
  registerDaemonTab?: boolean;
  /** When true (default in production · false in tests), call
   *  supervisor.startTab on the daemon tab right after detection skips
   *  external. */
  autoStartDaemonTab?: boolean;
  /** Register the pwa-host tab. Default OFF (HANDOFF OQ1: only daemon
   *  is auto-enabled). Pass `true` (or `--pwa` from the CLI) to opt in. */
  enablePwaHostTab?: boolean;
  /** When pwa-host is registered, also call supervisor.startTab. Default
   *  matches !detachForTesting so opt-in tests can register without spawning. */
  autoStartPwaHostTab?: boolean;
  /** Register channel-bot tabs for telegram / discord. Default OFF.
   *  When the relevant `ELANOUS_*_BOT_TOKEN` env is missing the spec is
   *  still registered (so the sidebar shows guidance) but auto-spawn
   *  is suppressed. */
  enableChannelBots?: ChannelBotPlatform[];
  /** Auto-spawn after register · default !detachForTesting AND token present. */
  autoStartChannelBots?: boolean;
  /** Boot from a named template instead of the default chat+webterm[+daemon]
   *  registration. When the template name is unknown, runNexus throws.
   *  User templates (~/.elanous/nexus/templates/<name>.json) override builtins
   *  of the same name. */
  template?: string;
  /** Skip the boot-time ELANOUS_* env auto-migration (PR μ). Tests that
   *  want to inspect raw env behavior pass `true`. Default false. */
  skipEnvMigration?: boolean;
  /** Skip the boot-time restart-state.json restore (PR χ). Default false
   *  in production; tests opt out so default-tab autostarts stay isolated
   *  unless they explicitly seed a restart-state file. */
  skipRestoreFromPending?: boolean;
  /** Register the default settings tab (cleanup PR α'). Defaults to
   *  `!detachForTesting` so production boots with a settings entry but
   *  the test harness stays single-purpose. */
  registerSettingsTab?: boolean;
  // ── PR k · in-process runtime wire-up ─────────────────────────
  /** Active LLM tool surface kind for the in-process runtime
   *  (powers `/v1/tools` + `/v1/prompt` + ACP runTurn). 'none'
   *  default keeps the daemon as text-only chat; 'readonly' enables
   *  Read + Grep + WebSearch; 'webterm' adds web-terminal tools.
   *  Reads `ELANOUS_TOOLS` env when omitted. */
  tools?: DaemonToolSurfaceKind;
  /** CWD for fs-bound tool dispatch (Read · Grep). Defaults to
   *  `ELANOUS_TOOL_CWD` env then `process.cwd()`. */
  toolCwd?: string;
  /** Disk-backed history dir. Defaults to `ELANOUS_HISTORY_DIR` env
   *  (omit for in-memory). */
  historyDir?: string;
  /** System preamble injected at the head of every `/v1/prompt` and
   *  ACP runTurn. */
  systemPrompt?: string;
  /** PWA voice adapter — defaults to a stub adapter so `/v1/voice/ws`
   *  upgrade succeeds (browser can connect; no STT). Pass a production
   *  adapter built via `createPwaVoiceAdapter({ sttProvider })` to
   *  enable real-time STT. */
  voiceAdapter?: PwaVoiceAdapter;
  /** Skip the in-process ACP runtime construction (`runAcpServer` +
   *  history + tool surface). Tests that only exercise the http
   *  routing path pass `true` to keep the harness single-purpose.
   *  Production boots default to `false`. */
  skipRuntimeApi?: boolean;
  /** Skip the Pushcut HITL confirm channel wire-up. Default is
   *  `false` (production registers the channel so requestConfirmation()
   *  reaches iPhone via Pushcut + NEXUS `/v1/hitl/callback/:id`). Tests
   *  that don't want global registerDefaultConfirmChannels mutation pass
   *  `true`. Honored only when skipRuntimeApi is also false (channel
   *  needs the runtime hitlPending awaitCallback delegate). */
  skipPushcutChannel?: boolean;
  /** Pushcut notification name override. Defaults to env
   *  `ELANOUS_HITL_NOTIFY` then `'monad-confirm'` — same convention the
   *  legacy dashboard hitl runtime uses. */
  pushcutNotificationName?: string;
  /** Skip the PWA in-app banner HITL confirm channel wire-up
   *  (β-1a · 2026-05-08). Default `false` — production registers the
   *  channel so `requestConfirmation()` publishes `hitl.banner.show`
   *  events to PWA Showroom subscribers. Tests that don't want global
   *  registerDefaultConfirmChannels mutation pass `true`. Honored only
   *  when skipRuntimeApi is also false (channel needs the runtime
   *  hitlPending awaitCallback delegate). */
  skipPwaChannel?: boolean;
  /** Skip the Telegram HITL channel wire-up (β-1b · 2026-05-08).
   *  Default `false` — production reads `ELANOUS_TELEGRAM_HITL_BOT_TOKEN`
   *  + `ELANOUS_TELEGRAM_HITL_CHAT_ID` from the env; when both are set,
   *  a poll-loop bot starts and the channel registers. When env is
   *  missing the channel is silently absent (no token → nothing to
   *  do; not an error). Tests pass `true` to skip even when the env
   *  is set. */
  skipTelegramChannel?: boolean;
  /** Override the Telegram HITL opts read from env. Tests inject a
   *  pre-built bot via `opts.bot` so they don't actually call out to
   *  api.telegram.org. Production normally leaves this undefined and
   *  lets the env-based reader resolve. */
  telegramHitlOpts?: NexusTelegramHitlOpts;
  /** Skip the Discord HITL channel wire-up (β-1c · 2026-05-08).
   *  Default `false` — production reads `ELANOUS_DISCORD_HITL_BOT_TOKEN`
   *  + `ELANOUS_DISCORD_HITL_CHANNEL_ID`. When env is missing the
   *  channel is silently absent. Tests pass `true` to skip. */
  skipDiscordChannel?: boolean;
  /** Override the Discord HITL opts read from env (test seam). */
  discordHitlOpts?: NexusDiscordHitlOpts;
  /** Skip the terminal HITL channel wire-up (β-1d · 2026-05-08).
   *  Default `false` — production registers when running headless
   *  (no TUI consuming stdin) AND process.stdin.isTTY. TUI-mode
   *  boots automatically skip even without this flag. Tests pass
   *  `true` for an explicit skip. */
  skipTerminalChannel?: boolean;
  /** Override the terminal HITL opts (stdin/stdout for tests, or
   *  `forceEnable` to bypass the isTTY gate in unit harness). */
  terminalHitlOpts?: NexusTerminalHitlOpts;
  /** Skip the intent-prediction service wire-up (Phase 0.5 ·
   *  iOS Companion track preparation · 2026-05-08). Default
   *  `false` — production constructs the service so PWA Intent
   *  panel can subscribe via /v1/intent-prediction/:id/sse. Tests
   *  that don't need the wire (e.g. unrelated REST routes) pass
   *  `true` to keep the test harness lean. */
  skipIntentPrediction?: boolean;
  /** Override the intent-prediction context provider. Production
   *  passes a function that synthesizes IntentContext from daemon
   *  session history + ACP turn metadata; Phase 0.5 default returns
   *  a baseline empty context for any sessionId so the PWA Intent
   *  panel can dogfood the UX flow + feedback loop without the
   *  full context plumbing. */
  intentContextProvider?: (sessionId: string) => Omit<IntentContext, 'recentTaps'> | null | undefined;
  /** Override the intent-prediction tick interval (ms). Tests pass
   *  a small value with an injected setTimeout for deterministic
   *  timing. Production uses the 5000ms default. */
  intentTickIntervalMs?: number;
  /** P.1.5 — boot in headless mode (no TUI render loop). When true,
   *  `runNexusTui` is skipped and the boot blocks on SIGINT / SIGTERM
   *  instead of the TUI's `done` promise. The HTTP API + supervisor +
   *  meta-API stay live so PWA + remote attach keep working — only the
   *  developer-side TUI is suppressed. Set via `--headless` flag or
   *  `ELANOUS_NEXUS_HEADLESS=1` env (resolved in `resolveHeadlessMode`).
   *  Required for launchd / systemd-user / nohup / Docker — any
   *  environment without an interactive tty. */
  headless?: boolean;
  /** When true (default for headless launches), call mountShareIfEnabled
   *  right after the HTTP listener is up so `tailscale serve` re-mounts
   *  whenever `global.nexus.pwa.shareTailnet=enabled`. Caller should pass
   *  `false` when a TTY parent already owns the mount (bg-launch child
   *  re-execs) to avoid duplicate `tailscale serve` calls. Ignored in TTY
   *  mode — TTY entry goes through runPwaStart.bringShareUp instead. */
  autoMountShare?: boolean;
  /** Test-only replacement for the headless Tailscale Serve call. */
  mountShareIfEnabledFn?: (opts: { httpPort: number }) => Promise<import('../cli/share-auto-mount.js').ShareMountResult>;
  /** Test-only replacement for the headless Tailscale Serve unmount on shutdown. */
  pwaShareDisableFn?: typeof import('../cli/pwa-share.js').pwaShareDisable;
  /** Test-only share reconciliation cadence; production checks every 60 seconds. */
  shareCoordinatorIntervalMsForTesting?: number;
  /** Test-only completion signal that lets the real headless branch exit without a process signal. */
  headlessDoneForTesting?: Promise<void>;
  /** Skip the interactive setup prerequisite only while exercising the real headless branch in tests. */
  skipHeadlessSetupCheckForTesting?: boolean;
  /** Spawn an fs.watch loop on apps/pwa/{src,public,...} after boot so
   *  source edits auto-rebuild without restarting the daemon. Forwarded
   *  by `runPwaStart` when the user passes `--watch` (or runs `elanous
   *  nexus run` with no args — watch is the no-arg default for static
   *  mode). HMR mode never sets this. */
  pwaWatch?: boolean;
  /** Master MCP-client boot switch. When `false`, every `mcp.servers[]`
   *  in user-config is skipped at boot — daemon starts faster (no 8s
   *  per-server handshake budget) and external MCP tools (xcrun
   *  mcpbridge · xcodebuildmcp · …) are simply unavailable. Default
   *  `true`. CLI `--no-mcp` flips it off; user-config `mcp.enabled:
   *  false` is persistent. CLI wins. */
  mcpEnabled?: boolean;
  /** Test seams for observing the MCP reload callback through the real NEXUS server wiring. */
  startNexusHttpServerFn?: typeof startNexusHttpServer;
  registerMcpClientsFn?: typeof registerMcpClients;
  getMcpUserConfigForTesting?: typeof getUserConfig;
  reloadUserConfigForTesting?: typeof import('../user-config.js').reloadUserConfig;
}

export interface RunNexusHandle {
  release: () => void;
  state: ReturnType<typeof createNexusState>;
  registry: TabRegistry;
  runtime: NexusRuntimeMeta;
  /** Sidebar shell View built from the current registry. T4 + U1+U2
   *  trim 후 TUI mount 자체 dead — shell field 는 RunNexusHandle interface
   *  호환을 위해 보존 (null stub). */
  shell: SidebarTabSurface;
  /** HTTP API server — undefined when skipHttpServer was true (tests
   *  / detached mode). */
  httpServer?: NexusHttpServer;
  /** Live event bus — always present so callers (PR β.+ shell mount)
   *  can subscribe regardless of whether the HTTP layer is up. */
  eventBus: NexusEventBus;
  /** Supervisor handle — undefined when skipSupervisor was true. */
  supervisor?: Supervisor;
  /** Settings tab data controller — present when registerSettingsTab
   *  was on. Cleanup PR.+ TUI render loop reads its snapshot to paint. */
  settingsController?: SettingsTabController;
  /** PR k — daemon session history (in-memory or disk-backed when
   *  historyDir was supplied). Used by `/v1/prompt` + ACP runTurn +
   *  `/v1/sessions[/...]`. Undefined when skipRuntimeApi was true. */
  history?: DaemonSessionHistory;
  /** Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) —
   *  the daemon-native AgentStatusStore. Always present after
   *  runNexus boot (either the caller-supplied store or a freshly
   *  created one). Callers can subscribe directly for in-process
   *  observers OR rely on the `/v1/events?topics=agent.status` bus
   *  fanout that the wire automatically activates. */
  agentStatusStore: AgentStatusStore;
  /** PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — the
   *  daemon-native HudStore. Always present after runNexus boot.
   *  Callers subscribe directly (in-process dashboard mirror) OR rely
   *  on the `/v1/events?topics=hud.segment` SSE fanout. */
  hudStore: HudStore;
  /** PR k — HITL Pushcut callback pending-store. Channel HITL bus
   *  consumers register via `awaitCallback`; the http-server resolves
   *  via `resolveAnswer` when Pushcut posts. Undefined when
   *  skipRuntimeApi was true. */
  hitlPending?: HitlPendingCallbacks;
  /** Intent-prediction service (Phase 0.5 · 2026-05-08). REST/SSE
   *  handlers (`src/nexus/api/intent-prediction.ts`) consume this.
   *  Undefined when `skipIntentPrediction` was true OR when
   *  skipRuntimeApi short-circuits the runtime block. */
  intentPrediction?: IntentPredictionService;
  /** N-1 cleanup PR c — per-tab chat session registry. Each registered
   *  chat-kind tab gets its own NexusChatSession (compose buffer,
   *  message log, lazy ACP attach). Empty Map when skipRuntimeApi was
   *  true or no chat tabs were registered. */
  chatSessions?: NexusChatSessionRegistry;
  /** N-1 cleanup PR d — per-tab webterm session registry. Each
   *  registered webterm-kind tab gets its own NexusWebtermSession.
   *  Status is 'inert' (no backend) when webtermSpawn was omitted +
   *  'running' when a backend was supplied at boot. The TUI key
   *  dispatcher reads this map on every webterm-tab keypress to
   *  forward keystrokes into the child PTY. */
  webtermSessions?: NexusWebtermSessionRegistry;
}

/** ACP WS auth gate for the NEXUS HTTP bridge.
 *  Same shape as `src/boot/acp-server.ts` websocket auth: pass
 *  `createAuthVerifier` only when a bearer token is configured;
 *  explicit no-auth opt-out omits the verifier.
 *  ⛔ `noAuth` was declared on WsBridgeOpts but the bridge NEVER read it
 *  (0 executable references) while this file assigned it — a value that
 *  flowed in and died. We removed the field rather than leave a knob that
 *  looks live; verifier presence is the ACP gate (choice ⓑ).
 *  📏 전수 확인(추적 파일 · 2026-09-01): ws-bridge 옵션에 `noAuth` 를 «대입»하는
 *     자리 0곳. 남은 `noAuth` 는 `MetaApiOpts` 의 «다른» 필드이고 그건 살아 있다
 *     (meta-api.ts:245 가 읽는다). 회귀 방어 = src/nexus/index.test.ts:19,22. */
/** The set `/v1/acp` accepts **right now** — read per handshake, not at boot.
 *
 *  ⭐ 왜 봉투를 «매번» 읽나: `elanous token rotate` 가 봉투에 새 `active` 를 쓰고 옛 값을
 *  `prev` + `prevExpiresAt`(유예)로 남긴다. 부팅 때 잡은 문자열 하나를 들고 있으면
 *  ⑴ 회전이 «재기동 없이» 안 먹고 ⑵ 아직 옛 토큰을 든 원격이 «유예 없이» 끊긴다.
 *
 *  ⛔ `resolveToken()` 을 부르지 않는다 — 그것은 `===` 로 판정해 상수시간 비교를 잃는다.
 *  여기서는 «집합»만 만들고, 비교는 `createAuthVerifier` 의 `compareTokenConstTime` 이 한다.
 *
 *  📏 비용(2026-09-01 실측): 봉투 152 bytes · 읽기 «회당 10.2µs». 초당 1,000 핸드셰이크여도
 *  이벤트 루프의 약 1%다 — 「회전이 즉시 먹는다」와 맞바꿀 만하다고 «재서» 판단했다.
 *
 *  ⚠️ 잔여 위험(이 판의 «밖»): `loadEnvelope` 은 손상 JSON 에도, 읽기 권한이 없어도 «던지지 않고»
 *  평문 `acp-token` 으로 폴백한다(둘 다 실측). ⇒ 아래 catch 는 ***오늘 도달 불가***이고 방어로만 둔다.
 *  그 폴백 자체를 fail-closed 로 바꾸는 것은 `src/auth/token-store.ts` 축이고 MCP 경로에도 닿는다. */
export function acceptedAcpTokens(
  bearerToken: string | undefined,
  paths?: TokenStorePaths,
  now: number = Date.now(),
): readonly AcpAuthTokenRecord[] {
  const bootRecord = bearerToken ? [{ token: bearerToken, issuedAt: now, label: 'default' }] : [];
  let envelope: TokenStoreEnvelope | null = null;
  try {
    envelope = loadEnvelope(paths);
  } catch {
    // ⛔ 오늘은 안 온다(위 주석) — 그래도 「모른다」를 「허용」으로 바꾸지 않는다.
    //    여기서 부팅 토큰으로 폴백하면
    //    ***유예가 «끝난» 옛 토큰이 되살아난다***(부팅 토큰이 바로 그 옛 값일 수 있다).
    //    ⇒ 인증은 fail-closed 다. 「모른다」를 「허용」으로 바꾸지 않는다.
    return [];
  }
  // ⭐ 봉투가 «아예 없다» = 첫 부팅(fresh install). 이건 손상과 «다른 값»이라 부팅 토큰을 쓴다.
  if (!envelope) return bootRecord;

  const accepted: AcpAuthTokenRecord[] = [{ token: envelope.active, issuedAt: now, label: 'active' }];
  if (envelope.prev && envelope.prevExpiresAt) {
    const expiresAt = Date.parse(envelope.prevExpiresAt);
    // ⛔ 파싱 실패(NaN)는 「만료 안 됨」이 아니라 「모른다」다 — 받지 않는다.
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      accepted.push({ token: envelope.prev, issuedAt: now, label: 'prev-within-grace' });
    }
  }
  return accepted;
}

export function buildNexusWsBridgeAuth(
  bearerToken: string | undefined,
  paths?: TokenStorePaths,
): Pick<NexusWsBridgeInit, 'wsAuthVerifier'> {
  // Explicit opt-out supplies no boot token, so the bridge has no verifier.
  if (!bearerToken) return {};
  return {
    // ⭐ 배열이 아니라 «공급자» — 매 핸드셰이크마다 봉투를 다시 읽는다.
    wsAuthVerifier: withTempTokens(createAuthVerifier(() => acceptedAcpTokens(bearerToken, paths)), paths?.configDir),
  };
}

/** 단기 소유자 토큰(`elanous token issue`)도 ACP 웹소켓에서 받는다 — 기존 검증이 거부할 때만 해시·만료로 한 번 더 본다. */
function withTempTokens(base: AcpAuthVerifier, dir?: string): AcpAuthVerifier {
  return {
    verify(raw) {
      const first = base.verify(raw);
      if (first.ok) return first;
      const token = (raw as { token?: unknown } | null)?.token;
      return typeof token === 'string' && matchTempToken(token, dir ? { dir } : {}) ? { ok: true } : first;
    },
  };
}

/**
 * 관제부가 준 포트 임대(`ELANOUS_TEST_COORDINATOR_LEASE_PORT`)로 뜨는 자식이 «그 포트로만» 뜨는지 Nexus 락을 잡기 «전»에 확인한다.
 * 임대가 없으면 undefined, 있으면 그 포트를 돌려준다 — 조건이 하나라도 어긋나면 throw.
 */
export function checkLauncherLeaseBoot(
  opts: Pick<RunNexusOptions, 'httpStartPort' | 'skipHttpServer' | 'detachForTesting'>,
  env: NodeJS.ProcessEnv,
  instanceKind: () => string,
): number | undefined {
  const launcherLease = env.ELANOUS_TEST_COORDINATOR_LEASE_PORT;
  if (launcherLease === undefined) return undefined;
  const leasePort = Number(launcherLease);
  if (!env.ELANOUS_TEST_COORDINATOR_LEASE_ID?.trim()) throw new Error('missing coordinator lease id');
  if (instanceKind() !== 'test' ||
      !Number.isInteger(leasePort) ||
      leasePort < PORT_BANDS.test.start || leasePort > PORT_BANDS.test.end ||
      opts.httpStartPort !== leasePort ||
      (opts.skipHttpServer ?? !!opts.detachForTesting)) {
    throw new Error('coordinator port lease boot mismatch');
  }
  return leasePort;
}

export async function runNexus(opts: RunNexusOptions = {}): Promise<RunNexusHandle | undefined> {
  if (opts.status) {
    await printStatus();
    return undefined;
  }
  if (opts.stop) {
    stopExisting();
    return undefined;
  }

  const leasePortFromLauncher = checkLauncherLeaseBoot(opts, process.env, () => resolveCurrentInstance().kind);
  const noAuth = opts.noAuth === true || process.env.ELANOUS_NEXUS_NO_AUTH === '1';
  // Resolve before acquiring the daemon lock or binding HTTP. A broken token
  // store must fail closed without leaving a half-booted Nexus behind.
  const httpBootEnabled = !(opts.skipHttpServer ?? !!opts.detachForTesting);
  const needsToken = httpBootEnabled && !(opts.skipRuntimeApi ?? !!opts.detachForTesting) && !noAuth;
  const bearerToken = needsToken ? ensureAuthToken().token : undefined;
  if (needsToken && !bearerToken) throw new Error('Nexus auth token is empty');

  // 설치본 전환 RFC 0b — 키는 launchd plist 가 아니라 키 캐시에서(캐시 우선 · 자식도 물려받는다). 값은 안 찍고 «이름만».
  if (!opts.detachForTesting) {
    const { hydrateEnvFromKeyCache } = await import('../config.js');
    const filled = hydrateEnvFromKeyCache();
    debug.log('nexus.boot', 'env-keys-from-cache', { filled });
  }

  const headless = resolveHeadlessMode({ ...(opts.headless !== undefined ? { headless: opts.headless } : {}) });
  if (headless && !opts.detachForTesting && !opts.skipHeadlessSetupCheckForTesting) {
    const setup = checkSetupStatus({ argvBin: process.argv[1] ?? '' });
    const boot = setupBootMode(setup);
    if (boot.mode === 'refuse') {
      console.error('✗ elanous nexus --headless: setup incomplete');
      renderSetupStatus(setup, console);
      console.log('');
      console.log('  Run `elanous nexus` (interactive) once to walk through the wizard.');
      process.exit(1);
    }
    if (boot.mode === 'setup') {
      process.env.ELANOUS_NEXUS_SETUP_MODE = '1';
      const host = opts.httpHost ?? '127.0.0.1';
      const port = opts.httpStartPort ?? DEFAULT_NEXUS_HTTP_PORT;
      console.log(`셋업 모드로 떴습니다 — 브라우저로 셋업: http://${host}:${port}/app/setup/ (빠진 것: ${boot.missing.join(', ')})`);
    }
  }

  // 기동 때 한 번. 요청마다 다시 읽지 않고 이 값을 탭·크론·health 에 넘긴다.
  // 셋업이 채워진 뒤 정상 모드로 넘어가는 것은 재시작 한 번이다 — 자동 전환은 짓지 않는다.
  const nexusSetup = readNexusSetupMode(process.env);
  const setupPlan = setupModeBootPlan(nexusSetup.setupMode);
  debug.log('nexus.boot', 'setup-mode-plan', {
    setupMode: nexusSetup.setupMode,
    setupMissing: nexusSetup.setupMissing,
    skipTabKinds: setupPlan.skipTabKinds,
    skipCrons: setupPlan.skipCrons,
  });
  if (nexusSetup.setupMode) {
    console.log('셋업 모드 — 채널 봇·크론은 셋업 뒤 재시작 때 켜진다');
  }

  // #24 — 이벤트루프 stall watchdog(2026-07-21). 데몬 메인스레드가 무한루프로 굶으면(telegram 폴링
  //   정지=무응답) 별도 워커가 그걸 감지해 stall+마지막 activity 를 <logDir>/watchdog-stall.log 에 능동
  //   기록한다(bun JIT라 sample 심볼화 불가 → 관측으로 근본 특정). fail-soft(워커 실패해도 데몬 정상).
  try {
    const { startEventLoopWatchdog } = await import('../debug/event-loop-watchdog.js');
    const { debugLogDir } = await import('../debug/log.js');
    const { join: joinPath } = await import('node:path');
    const wdDir = debugLogDir();
    startEventLoopWatchdog({
      heartbeatFile: joinPath(wdDir, 'watchdog-heartbeat.json'),
      stallLogFile: joinPath(wdDir, 'watchdog-stall.log'),
    });
  } catch { /* fail-soft — watchdog 없이도 데몬 부팅 진행 */ }

  // W9d-FU U5 — Patcher daemon handle captured at function-level scope
  // so the shutdown closure (`wrappedRelease`) can see it even though
  // the boot block lives in an inner try/catch. Assigned by the inner
  // boot block; left undefined when the boot path is never reached.
  let patcherSubstrateHandle: PatcherSubstrate | undefined;
  // W9d-FU Z15.b — Devices fleet cron handle. Same scope rationale as
  // `patcherSubstrateHandle`.
  let devicesSubstrateHandle: DevicesSubstrate | undefined;
  // B 트랙 Phase 2 (RFC #2474) — External MCP client substrate handle.
  // Captured at function scope so `wrappedRelease` can dispose every
  // spawned child process (xcrun mcpbridge · xcodebuildmcp · …) on
  // daemon shutdown.
  let mcpClientsHandle: McpClientsHandle | undefined;
  // PR2 (C · 2026-05-13) — MCP boot is now fire-and-forget. The
  // promise resolves to the same handle that `mcpClientsHandle` will
  // hold; `wrappedRelease` awaits it (with a small grace window) so a
  // user-initiated shutdown that lands while MCP boot is still in
  // flight doesn't orphan child processes.
  let mcpClientsBootPromise: Promise<McpClientsHandle | undefined> | undefined;
  // 대표 2026-09-10 — MCP «전용» 재장전. 위 두 값은 기동 시 «한 번» 채워지므로
  // config 에 서버를 더하거나 `elanous mcp login` 으로 자격증명을 새로 받아도 이미
  // 뜬 데몬은 그것을 모른다. 그 상태의 유일한 처방이 데몬 재부팅이었고, 재부팅은
  // MCP 와 무관한 것들(도는 미션·PTY·스케줄러·PWA 업스트림 등록)을 같이 끊는다.
  // ⇒ 이 심은 폭발 반경을 «MCP 클라이언트»로 좁힌다.
  //
  // ⛔ 직렬화한다 — 두 요청이 겹치면 앞 핸들을 shutdown 한 뒤 뒤 요청이 그것을 또
  //    shutdown 하고, 등록 레지스트리에 «반쯤 살아 있는» 프록시가 남는다.
  let mcpReloadInFlight: Promise<McpReloadOutcome> | undefined;
  const reloadMcpClients = (): Promise<McpReloadOutcome> => {
    if (mcpReloadInFlight) return mcpReloadInFlight;
    const run = (async (): Promise<McpReloadOutcome> => {
      // 기동 중 부팅이 아직 날고 있으면 먼저 착지시킨다 — 안 그러면 우리가 세운
      // 새 핸들을 그 부팅이 뒤늦게 덮어쓴다.
      if (mcpClientsBootPromise) {
        try { await mcpClientsBootPromise; } catch { /* 부팅 실패는 여기서 삼킨다 — 재장전이 그것을 대체한다 */ }
      }
      const reloadUserConfig = opts.reloadUserConfigForTesting
        ?? (await import('../user-config.js')).reloadUserConfig;
      const fresh = reloadUserConfig();
      const previous = mcpClientsHandle;
      mcpClientsHandle = undefined;
      mcpClientsBootPromise = undefined;
      if (previous) {
        try { await previous.shutdown(); } catch { /* 옛 자식 정리 실패가 새 등록을 막지 않는다 */ }
      }
      if (fresh.mcp?.enabled === false) {
        return { reloaded: false, registered: 0, perServer: {}, skippedReason: 'mcp-disabled' };
      }
      const register = opts.registerMcpClientsFn ?? registerMcpClients;
      const handle = await register({
        servers: fresh.mcp?.servers ?? [],
        handshakeTimeoutMs: fresh.mcp?.handshakeTimeoutMs,
      });
      mcpClientsHandle = handle;
      mcpClientsBootPromise = Promise.resolve(handle);
      const perServer: Record<string, McpReloadServerResult> = {};
      for (const [serverId, result] of Object.entries(handle.perServer)) {
        perServer[serverId] = {
          status: result.status,
          toolCount: result.toolCount,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        };
      }
      return { reloaded: true, registered: handle.registered, perServer };
    })();
    mcpReloadInFlight = run;
    void run.finally(() => { mcpReloadInFlight = undefined; });
    return run;
  };

  let stopCoordinatorLease: (() => Promise<void>) | undefined;
  let leaseReleasePending: Promise<void> | undefined;

  let release: () => void;
  try {
    release = acquireNexusLock({ label: 'nexus', ...(opts.force ? { force: true } : {}) });
  } catch (err) {
    if (err instanceof NexusLockError) {
      // Test-mode boots must NEVER process.exit — that silently
      // truncates the whole `bun test` run mid-suite (2026-07-12: a
      // stale-isolated nexus test reached the PRODUCTION lock here and
      // killed every alphabetically-later test file). Throw so the
      // test fails loudly instead.
      if (opts.detachForTesting) throw err;
      console.error('elanous nexus already running:');
      console.error(`  pid       ${err.existing.pid}`);
      console.error(`  host      ${err.existing.host}`);
      console.error(`  startedAt ${err.existing.startedAt}`);
      console.error(`  lock      ${err.lockPath}`);
      console.error('');
      console.error('Use `elanous nexus --status` to inspect, `--stop` to terminate, or `--force` to take over.');
      process.exit(1);
    }
    throw err;
  }

  if (leasePortFromLauncher !== undefined) {
    try {
      stopCoordinatorLease = await startPortLeaseHeartbeat(leasePortFromLauncher, process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID!, {
        ...(process.env.ELANOUS_TEST_COORDINATOR_LEASE_TOKEN ? { token: process.env.ELANOUS_TEST_COORDINATOR_LEASE_TOKEN } : {}),
        onError: error => debug.log('control.port-lease', 'renew-failed', { port: leasePortFromLauncher, reason: error.message }, { level: 'warn' }),
        onLeaseLost: error => {
          try { debug.log('control.port-lease', 'lease-lost', { port: leasePortFromLauncher, reason: error.message }, { level: 'error' }); }
          finally { process.exit(1); }
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  const startedAt = new Date().toISOString();
  const runtime: NexusRuntimeMeta = {
    pid: process.pid,
    startedAt,
    nexusVersion: NEXUS_VERSION,
    phase: NEXUS_PHASE,
  };
  writeNexusRuntime(runtime);
  opts.onRuntimeSidecarWrite?.(runtime);
  const pwaRegistration = createPwaRegistration(opts.pwaRegistrationDeps);

  // Apply user-config debug level + file flag in nexus mode. Mirror of
  // the `elanous serve` and dashboard boot paths (src/index.ts:3720,
  // src/dashboard/index.ts:2186) — without this, `_keyTraceEnabled`
  // stays false and every `if (debug.enabled) debug.log(...)` hot-path
  // gate skips, leaving `log/debug-*.log` empty even when
  // `~/.config/elanous/config.json` has `debug.level: "keytrace"`.
  // ELANOUS_DEBUG_LEVEL env override matches the dashboard precedence.
  // (Phase E follow-up · 2026-05-07 — fix for cross-surface ACP
  //  fan-out diagnostics not firing in nexus mode.)
  {
    const dbgMod = await import('../debug/log.js');
    const userConfigMod = await import('../user-config.js');
    const dbgCfg = userConfigMod.getUserConfig().debug;
    const envLevel = process.env.ELANOUS_DEBUG_LEVEL?.trim().toLowerCase();
    // LF7-c — 레벨 우선순위: env > 인스턴스 스코프 파일(logs/level.json) >
    // config debug.level(기본값 강등). `elanous logs level` 영속이 인스턴스
    // 파일로 가므로 재기동 유지가 여기서 성립한다.
    const scopedMod = await import('../mss/logging/scoped-level.js');
    const scopedLevel = scopedMod.readScopedDebugLevel();
    // ⭐ 테스트 우주 바닥(2026-07-27) — 격리 인스턴스는 자기 config 만 보므로 운영의 diag/detail
    //   을 모른다. 게이트가 닫히는 레벨이면 diag 로 올려 자식 PTY·L2 관측 해상도를 확보한다.
    const resolvedLevel = scopedMod.resolveStartupDebugLevel({
      envLevel,
      scopedLevel,
      configLevel: dbgCfg.level,
      // ⚠️ 리졸버 SSOT 로 판정한다 — "루트가 ~/.elanous 가 아니면 테스트" 같은 자체 비교는
      //   별도 운영 인스턴스·커스텀 루트를 test 로 오판한다(리뷰 must-fix).
      isTestInstance: (await import('../instance/current.js')).resolveCurrentInstance().kind === 'test',
    });
    const startLevel = resolvedLevel.level;
    dbgMod.debug.setLevel(startLevel);
    if (httpBootEnabled && noAuth) {
      dbgMod.debug.log('nexus.auth', 'explicit-opt-out', {
        source: opts.noAuth === true ? '--no-auth' : 'ELANOUS_NEXUS_NO_AUTH',
      }, { level: 'warn' });
    }
    dbgMod.debug.log('logging.level', 'startup-resolved', {
      level: startLevel, source: resolvedLevel.source,
      gateOpen: scopedMod.hotPathGateOpen(startLevel), surface: 'nexus',
    });
    dbgMod.debug.setFileEnabled(dbgCfg.file);
    // OH9 — 렌더 무음 시드(레벨 직교). 데몬은 기본 비억제 — level.json.render 명시 또는
    // config.debug.renderLogs 만 억제/override 를 결정한다.
    dbgMod.debug.setRenderSuppressed(scopedMod.resolveRenderSuppressed({
      scopedRender: scopedMod.readScopedRenderLogs(),
      configRenderLogs: dbgCfg.renderLogs,
    }));
    if (dbgCfg.file) {
      console.log(`debug: level=${dbgMod.debug.level()} file: ${dbgMod.debug.path()}`);
    } else {
      console.log(`debug: level=${dbgMod.debug.level()} file capture: OFF`);
    }
    // 통합 로그 패브릭 LF0 (2026-07-13) — 크로스서피스 조회 스토어(logs.db)에
    // 데몬 로그를 적재. 파일 트레일과 병행(조회면 추가일 뿐 — 실패 fail-soft).
    // 설계: 내부 문서 `PLAN-unified-log-fabric-2026-07-13` §LF0.
    try {
      const storeMod = await import('../mss/logging/log-store.js');
      const logsCfg = userConfigMod.getUserConfig().logs;
      // LF7-a — 인스턴스 identity: config 오버라이드가 있으면 주입, 없으면
      // ELANOUS_STATE_DIR 기반 자동 유도(prod / test:<repo>). 스토어 생성 전 1회.
      storeMod.setLogInstanceName(logsCfg.instanceName);
      const off = storeMod.registerLogStoreSink(
        (s) => dbgMod.debug.registerSink(s),
        'nexus',
        logsCfg.retention,
      );
      if (off) console.log(`logs: store ${storeMod.logsDbPath()} (surface=nexus · instance=${storeMod.resolveLogInstanceName()})`);
      // Phase D2-핵심 — 부팅 시 config-dir↔state-dir 정합 가드(warn-first). 부분 격리
      // (한 축만 설정)로 스토어가 갈라지면 시끄럽게(관측+stderr). 부팅은 안 막는다.
      try {
        const { assertInstanceRootCoherence } = await import('../instance-root-coherence.js');
        assertInstanceRootCoherence();
      } catch { /* 가드 자체 실패가 부팅을 막지 않는다 */ }
      // LF7-b — 인스턴스 레지스트리 등록(발견용 메타데이터 · prod 홈 고정).
      // test 데몬도 여기 등록해야 `elanous logs --all`/PWA 연합 뷰가 발견한다.
      const registryMod = await import('../mss/logging/instance-registry.js');
      const pathMod = await import('node:path');
      const stateDirEnv = process.env.ELANOUS_STATE_DIR?.trim();
      const stateDir = stateDirEnv && stateDirEnv.length > 0
        ? stateDirEnv
        : pathMod.join((await import('node:os')).homedir(), '.elanous');
      const name = storeMod.resolveLogInstanceName();
      const isTest = registryMod.isTestInstance({ name, stateDir });
      const { getElanousConfigDir } = await import('../elanous-config-dir.js');
      const { resolveHostId } = await import('../platform/host-id.js');
      registryMod.registerLogInstance({
        hostId: resolveHostId(),
        hostname: hostname(),
        name,
        stateDir,
        kind: isTest ? 'test' : 'prod',
        configDir: getElanousConfigDir(),
        ...(isTest ? { repoPath: pathMod.dirname(stateDir) } : {}),
        pid: process.pid,
        startedAt,
      });
    } catch { /* fail-soft — 파일 트레일이 진실원 */ }
    // LF5 essential (2026-07-13) — 로그 안전망: 데몬의 console.error/warn 을
    // 트레일에 병행 기록 + 크래시(uncaught/unhandledRejection) 포렌식 캡처.
    // 데몬 상주 프로세스 전용(CLI one-shot 설치 금지).
    try {
      const { installLogSafetyNet } = await import('../mss/logging/log-safety-net.js');
      installLogSafetyNet();
    } catch { /* fail-soft */ }
  }

  const eventBus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: NEXUS_VERSION, phase: NEXUS_PHASE });
  state.bus = eventBus;
  // BACKLOG #9 — fan workflow approval lifecycle into `/v1/events` SSE
  // so the PWA modal opens on push (~200ms) instead of waiting for
  // the next 1s pendingApprovals poll cycle.
  wireWorkflowApprovalEvents(eventBus);
  // Rich-dev-feedback opportunistic followup §6.2 #3 — daemon-native
  // AgentStatusStore + always-on bus bridge. Caller may pass a
  // pre-existing store via opts (cross-process IPC bridge follow-up
  // can plumb the dashboard store here); otherwise we create a
  // fresh one so ACP turn-runner / future writers always have a
  // canonical sink. The PWA `<StatusChip>` hydrates the moment any
  // writer touches the store.
  const agentStatusStore = opts.agentStatusStore ?? new AgentStatusStore();
  state.agentStatusStore = agentStatusStore;
  wireAgentStatusEvents(eventBus, agentStatusStore);
  // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — daemon-native
  // HudStore + always-on SSE bridge. The dashboard mirror (M3) and any
  // external writer (sidecar tools · MCP rate gauge) push set/clear
  // via POST /v1/hud-segment; the bridge fans transitions onto the
  // /v1/events bus so PWA `<ChatHud>` (M4) hydrates live.
  const hudStore = opts.hudStore ?? new HudStore();
  state.hudStore = hudStore;
  wireHudSegmentEvents(eventBus, hudStore);
  // Wire ACP turn-runner → store. Module-level setter mirrors the
  // workflow-run-event-bus pattern: one global hook per process,
  // toggleable for tests. Every runAcpTurn now publishes
  // working/done/err transitions automatically — no per-call-site
  // plumbing needed.
  setAcpAgentStatusStore(agentStatusStore);
  // §15.8(b) — same idea for the run-execution lifecycle. The
  // workflow REST handler calls `publishWorkflowRunEvent(...)` for
  // each yielded WorkflowEvent; this wire makes those calls land on
  // `eventBus.publish` (no-op when the bus is unwired in tests).
  setWorkflowRunEventBus(eventBus);
  // Surface-unification v2 (2026-05-11) — trigger lifecycle (subscribed
  // / unsubscribed / fired) fan-out for the PWA ActiveTriggersPanel.
  setTriggerEventBus(eventBus);
  // 라이브 세션 관리(2026-07-09 · S3a) — on-disk 세션 생성/갱신을 /v1/events 로
  // 발행해 PWA /sessions 가 즉시 갱신(polling → push). 텔레그램 턴이 데몬 내에서
  // 돌므로 onMessageAppended 가 여기서 발화 → session.updated 발행.
  wireSessionStoreEvents(eventBus);
  // S3b (2026-07-10) — cross-process 보강. in-process 리스너는 데몬 안 세션만 잡으므로
  // 별 프로세스(CLI elanous·agent-cli)가 디스크에 쓴 세션 갱신은 fs.watch 로 SSE 발행.
  wireSessionDirWatch(eventBus);
  // 세션 object-storage 백업(2026-07-10) — 변경된 세션을 디바운스 후 S3 로 durable 백업.
  // S3 미가용이면 no-op(로컬only). 복원은 restoreSessionFile / session-s3 CLI.
  wireSessionS3Backup();
  const registry = new TabRegistry(state);

  // PR μ — load SwitchRegistry built-ins so subsequent code
  // (registerDaemon / channel-bot / migrate) sees the schema.
  loadAllBuiltins();
  // PR υ — register cloud backends (Keychain · AWS · GCP · 1Password).
  // Each backend reads its config from UserConfig at construction; SDKs
  // are lazy-imported on first use, so unused backends cost 0.
  try { registerAllCloudBackends(); } catch { /* missing peer SDKs OK */ }
  // PR σ — pick the secret backend declared in UserConfig (default 'file').
  // Falls back to 'file' silently if the configured backend is missing.
  try { selectBackendFromConfig(); } catch { /* keep default 'file' */ }

  // PR β — register the default tab set so the sidebar is non-empty
  // on first boot. Order matches buildNexusSidebarItems' ordering
  // (chat first → focused on first frame).
  // PR κ — when --template is supplied, replace the default registration
  // with the template's tab list. We register synchronously here (no
  // spawn yet) so the sidebar shell sees the entries on first frame; the
  // supervisor.startTab loop runs later once `supervisor` exists.
  let templateApplied = false;
  let templateTabs: import('./templates/loader.js').TemplateTabEntry[] = [];
  if (opts.template !== undefined) {
    const t = loadTemplate(opts.template);
    if (!t) throw new Error(`unknown template: ${opts.template}`);
    state.template = t.name;
    runtime.template = t.name;
    templateApplied = true;
    templateTabs = t.tabs;
    // Synchronous register pass — applyTemplate(autoStart=false) just
    // registers without calling startTab.
    void applyTemplate(t, { registry, autoStart: false });
  } else {
    registry.register(createChatTabSpec({ id: 'chat:1', label: 'chat#1' }));
    // PWA mirror prep — webterm 탭은 default-OFF. NEXUS TUI 의 webterm
    // surface 는 ANSI parser 미연결 + Ctrl-arrow 정책 충돌 + multi-session
    // picker 미존재로 사람이 직접 인터랙션하기엔 placeholder 수준. LLM
    // tool surface (`--tools webterm`) 는 본 register 와 무관 — flag 가
    // 켜지면 PTY 도구를 LLM 만 driving + 탭은 안 뜸. switch on (또는
    // env `ELANOUS_REGISTER_WEBTERM=1`) 으로 디버그 / PWA mirror 시 노출.
    if (shouldRegisterWebterm()) {
      registry.register(createWebtermTabSpec({ id: 'webterm:1', label: 'webterm#1' }));
    }
  }

  // C-2a (cleanup ROADMAP 2026-05-08): daemon kind register block extracted
  // to `boot/register-daemon.ts`. Same logic, same ordering — just relocated.
  const registerDaemon = tryRegisterDaemon({
    registry,
    templateApplied,
    opts: {
      ...(opts.registerDaemonTab !== undefined ? { registerDaemonTab: opts.registerDaemonTab } : {}),
      ...(opts.detachForTesting !== undefined ? { detachForTesting: opts.detachForTesting } : {}),
    },
  });

  // C-2b (cleanup ROADMAP 2026-05-08): pwa-host register block extracted
  // to `boot/register-pwa-host.ts`. Same opt-in semantics, same template
  // suppression.
  const registerPwaHost = tryRegisterPwaHost({
    registry,
    templateApplied,
    opts: {
      ...(opts.enablePwaHostTab !== undefined ? { enablePwaHostTab: opts.enablePwaHostTab } : {}),
    },
  });

  // C-2c (cleanup ROADMAP 2026-05-08): settings register block extracted
  // to `boot/register-settings.ts`. Controller instance still created
  // inline below (captures local `state`/`registry`).
  const registerSettings = tryRegisterSettings({
    registry,
    templateApplied,
    opts: {
      ...(opts.registerSettingsTab !== undefined ? { registerSettingsTab: opts.registerSettingsTab } : {}),
      ...(opts.detachForTesting !== undefined ? { detachForTesting: opts.detachForTesting } : {}),
    },
  });

  // C-2d (cleanup ROADMAP 2026-05-08): channel-bot register block extracted
  // to `boot/register-channel-bots.ts`.
  const registeredChannelBotIds: RegisteredChannelBot[] = tryRegisterChannelBots({
    registry,
    templateApplied,
    opts: {
      ...(opts.enableChannelBots !== undefined ? { enableChannelBots: opts.enableChannelBots } : {}),
    },
  });

  // PR α' — bind a SettingsTabController so the sidebar dispatch
  // (sidebar-items.viewForTab) can hand it to the settings view factory.
  // N-2 cleanup PR a — created BEFORE the shell so the first frame paints
  // live snapshot data + so the TUI render loop can intercept settings
  // keystrokes against the same controller instance.
  const settingsController = registerSettings
    ? new SettingsTabController({ state, registry })
    : undefined;

  // N-1 cleanup PR e — production node-pty backend factory wired by
  // default for the live `elanous nexus` boot. Tests (detachForTesting)
  // skip the auto-inject so the harness keeps its mock-only behavior;
  // they pass an explicit factory when a fixture wants a real PTY.
  // PLAN-nexus-shell-followup U1+U2 (2026-05-16) — MiniTerminal class
  // (always-on TUI mini-term footer) trim. T4 이후 TUI render path 자체
  // dead 였고 본 spawn 호출 site 도 같이 정리.
  // PR e — symmetric production factory for webterm tabs. The boot
  // wire (registerWebtermSessions below) checks effectiveWebtermSpawn
  // before constructing each NexusWebtermSession; when omitted (test
  // path) sessions stay inert.
  const effectiveWebtermSpawn = opts.webtermSpawn
    ?? (opts.detachForTesting ? undefined : createWebtermSpawn());

  const skipHttp = opts.skipHttpServer ?? !!opts.detachForTesting;
  let httpServer: NexusHttpServer | undefined;
  let stopMemberHeartbeat: (() => void) | undefined;
  // ⛔ 관제부는 운영 넥서스와 «별도 프로세스»다(RFC 관제 평면 A2 · P0 골 경계) — 넥서스는 기본으로 띄우지 않는다.
  //   🩸 2026-09-27: 넥서스 부팅이 31413 을 늘 잡고 실패하면 throw 해서, 운영이 31413 을 쥔 뒤엔 모든 격리 데몬(`nexus run --test`)이
  //   부팅에서 죽을 뻔했다. 명시(`controlPort`)일 때만 띄우고, 실패해도 넥서스 부팅은 막지 않는다(관측만).
  let controlServer: ReturnType<typeof startControlServer> | undefined;
  if (opts.controlPort !== undefined) {
    try {
      controlServer = startControlServer({ port: opts.controlPort });
    } catch (err) {
      debug.log('control.server', 'start-failed-in-nexus', { port: opts.controlPort, reason: (err as Error).message }, { level: 'warn' });
    }
  }
  // Surface-unification v2.1 FU-3 (2026-05-11) — workflow-runtime
  // daemon. Owns trigger source lifecycle (schedule/webhook/discord/
  // telegram/chat). Schedule + webhook + chat fire from in-process
  // sources; discord/telegram need an external IPC tap (channel-bot
  // subprocess → daemon) that's still BACKLOG.
  let workflowDaemon: WorkflowRuntimeDaemon | undefined;
  // Phase 2 (2026-05-13) — surface-agnostic TOX bootstrap. Activates the
  // LLM-orchestrator layer (TaskGraph + TaskDispatcher + TaskFeedbackLoop
  // + 8 LLM tools) and exposes one process-wide handle for every surface
  // (PWA Intake, iPhone, ACP, MCP, future). Disposed in the shutdown
  // hook below.
  let toxHandle: ToxBootHandle | undefined;
  let toxStore: TaskStore | undefined;
  // §5-③ — autonomous idle-continuation scheduler. Only constructed when
  // `dispatch.enabled` is set (default off); stopped in the shutdown hook.
  let continuationScheduler: import('../dispatch/continuation-scheduler.js').ContinuationScheduler | undefined;
  // R5 — dig-goal armer poller. Only started when BOTH `dispatch.enabled`
  // AND `finance.dig.autoGoal.enabled` are true (double gate · default off);
  // cleared in the shutdown hook.
  let digArmerHandle: ReturnType<typeof setInterval> | undefined;
  // M4 — replay(새벽 수면) armer handle. Double-gated (dispatch.enabled AND
  // finance.replay.autoGoal.enabled · default off); cleared in shutdown hook.
  let replayArmerHandle: ReturnType<typeof setInterval> | undefined;
  // §P2 배선 — 세션 presence grace TTL 스위퍼 handle(무조건·세션 패브릭 코어).
  // 60s 틱마다 grace 유예 초과 구독자를 left 로 이탈 확정(reconcileSessionPresence).
  // cleared in shutdown hook.
  let presenceSweepHandle: ReturnType<typeof setInterval> | undefined;
  // ★ UR4d — 조율자 저지연 push watcher(logs.db tail edge-trigger). opt-in·기본 OFF.
  // cleared in shutdown hook(내부 타이머는 unref 이나 명시 정지).
  let coordinatorPushWatcher: { stop(): void } | undefined;
  // V2.2-3 (2026-05-12) — NEXUS-hosted Discord workflow trigger bot.
  // Wired below once the workflow daemon is constructed.
  let workflowDiscordBot: NexusDiscordTriggerBotHandle | undefined;
  // V2.2-4 (2026-05-12) — NEXUS-hosted Telegram workflow trigger bot.
  let workflowTelegramBot: NexusTelegramTriggerBotHandle | undefined;
  /** R1 — 토큰마다 뜬 Q&A 폴러 «전부»(재시작 때 함께 비운다 · `workflowTelegramBot` 은 주 토큰 하나뿐). */
  const telegramPollerHandles: NexusTelegramTriggerBotHandle[] = [];

  // ── PR k · in-process runtime construction ────────────────────
  // Skipped for unit tests that only exercise routing (skipRuntimeApi)
  // or for the detach-for-test harness (which never boots http anyway).
  // Production boots construct the full runtime so `/v1/prompt`, the
  // ACP WS bridge, intake/sessions etc. all dispatch in-process.
  const skipRuntime = opts.skipRuntimeApi ?? !!opts.detachForTesting;
  let runtimeHistory: DaemonSessionHistory | undefined;
  let runtimeHitlPending: HitlPendingCallbacks | undefined;
  // Identity of the AskUserQuestion resolver this boot installed (or null
  // when a prior resolver already owned the hook). release() clears only
  // this identity so an inherited resolver is not wiped.
  let installedDefaultAskResolver: AskUserQuestionResolver | null = null;
  let runtimeTelegramHitl: NexusTelegramHitlHandle | undefined;
  let runtimeDiscordHitl: NexusDiscordHitlHandle | undefined;
  let runtimeIntentPrediction: IntentPredictionService | undefined;
  // G2 (2026-05-12) — IntentPrediction tick → OutboundRouter bridge.
  // Created when both `runtimeIntentPrediction` and
  // `outboundSubstrate.router` exist. Holds the unsubscribe handle so
  // shutdown can drop the listener cleanly (otherwise the disposed
  // service would still hold the bridge callback in its listener set
  // briefly until GC, mostly harmless but lint-friendlier this way).
  let intentPredictionRouterBridge: IntentPredictionRouterBridgeHandle | undefined;
  // R3 v2 (2026-05-09) — hoisted out of `if (!skipRuntime)` so the
  // notification-action loopback wired into startNexusHttpServer below
  // shares the SAME runTurn instance the ACP server is using. Without
  // hoisting, the loopback could only see a stale closure or rebuild a
  // second runTurn (drifting tool surface + history reference).
  let runtimeRunTurn: NonNullable<AcpServerOptions['runTurn']> | undefined;
  let runtimeToolCwd: string | undefined;
  // R6 v2 (2026-05-09) — hoisted handle so the cleanup path can stop
  // the daily-reflection scheduler regardless of which branch booted
  // it. Tests with detachForTesting set leave this undefined.
  let dailyReflectionScheduler: DailyReflectionSchedulerHandle | undefined;
  // RFC #2161 FU A8 (2026-05-11) — discovery cron via NEXUS. Dormant
  // by default (opt-in via `ELANOUS_DISCOVERY_CRON_INTERVAL_MS`); when
  // configured, fires runDiscovery every interval and pushes the
  // resulting snapshot through the S3 mirror wired in FU A7.
  let discoveryCron: DiscoveryCronHandle | undefined;
  // 스케줄 러너(S2 · 2026-07-07) — run_via='elanous' 잡을 데몬이 실제 발화.
  // opt-in(adopt)만 실행 · crontab 중복 스킵 · reconcile로 adopt/release 반영.
  let scheduleRunner: ScheduleRunnerHandle | undefined;
  // R5 follow-up (2026-05-09) — session-decision → ACP forward
  // adapter handle. Subscribes to the event bus + maps approve/expand
  // decisions onto a synthetic ACP loopback so card-deck swipes
  // actually move the agent forward (v1 was record-only).
  let sessionDecisionForward: SessionDecisionForwardHandle | undefined;
  // Per-session turn activity tracker — fed by ACP's onPromptReceived
  // hook (wired into runAcpServer below) and read by the intent
  // ranker's contextProvider so the PWA IntentPanel's ranking evolves
  // as turns/idle accumulate. Always allocated even when intent
  // prediction is disabled — cheap (one Map · zero work without
  // recordPrompt calls) and lets test seams override the live wire.
  const intentTurnTracker: TurnTracker = createTurnTracker();
  let acpShutdown: AbortController | undefined;
  let acpHandlerRef: { current: AcpConnectionHandler | null } | undefined;
  // ⭐P2 (capture substrate) — manifest→ACP terminalFrame poller stop thunk.
  //   Started right after runAcpServer (broadcaster resolves lazily per tick).
  let stopTuiFrameBroadcaster: (() => void) | undefined;
  // ⭐P5 (capture substrate) — frame→episodic-memory poller stop thunk.
  let stopFrameMemoryPoller: (() => void) | undefined;
  // FU-2 webterm wire — pwaTtsBridge holder. Declared at runNexus
  // outer scope so both the runtime block (`if (!skipRuntime)` · ACP
  // server pushChunk/flush wrapper · ~675 area) and the http block
  // (`if (!skipHttp)` · voice adapter init · ~1006 area) reach the
  // same per-process holder. Hoisted on 2026-05-09 — previously the
  // declaration lived inside `if (!skipRuntime)` and `if (!skipHttp)`
  // referenced an out-of-scope binding (`pwaTtsBridgeHolder is not
  // defined` ReferenceError swallowed into the voice-init catch
  // block, falling back to the stub adapter and silently disabling
  // server-side TTS streaming on every NEXUS boot).
  const pwaTtsBridgeHolder: {
    current: import('../voice/voice-pwa-tts-bridge.js').PwaTtsBridge | undefined;
  } = { current: undefined };
  // iOS session-list track (2026-05-14) — holder for the ACP server's
  // out-of-protocol session cancel function. Populated below via
  // `runAcpServer({ onAbortHandle })` once the internal sessions Map
  // is allocated. Read at DELETE /v1/sessions/:id time through
  // `metaApiOpts.abortSession`. Initial no-op so a DELETE arriving
  // before ACP finishes its boot races returns `aborted:false`
  // gracefully instead of throwing.
  const acpAbortHolder: { current: (sessionId: string) => boolean } = {
    current: () => false,
  };

  // Installed graph kinds do not depend on the runtime API or MCP server configuration.
  try { syncInstalledPluginNodes(elanousStateRoot()); }
  catch (error) { debug.log('graph.kinds', 'installed-sync-failed', { reason: String(error) }); }

  if (!skipRuntime) {
    // Tool surface — flag · env · UserConfig switch · switch default.
    // See resolveToolsKind() jsdoc for resolution order.
    const toolsKind = resolveToolsKind(opts);
    const toolCwd = resolveToolCwd({ tools: toolsKind, toolCwd: opts.toolCwd });
    runtimeToolCwd = toolCwd;

    // History — disk-backed when historyDir / ELANOUS_HISTORY_DIR is set,
    // in-memory otherwise. Same defaulting as createDaemonRuntime.
    const diskDir = opts.historyDir ?? process.env.ELANOUS_HISTORY_DIR?.trim();
    // 완전 무결 세션 공유(R5) — read-through(on-disk SessionStore lazy 로드)로 PWA
    // 챗이 텔레그램/CLI/이전 세션을 열면 그 context 로 이어감.
    runtimeHistory = new DaemonSessionHistory({
      ...(diskDir ? { diskDir } : {}),
      readThrough: makeSessionStoreReadThrough(),
    });
    // R3 write-through — DaemonSessionHistory.onAppend → on-disk SessionStore
    // (~/.elanous/sessions) 미러 → 목록/복원/공유 일원화. onAppend seam·미러 실패 무해.
    wireDaemonHistoryToStore(runtimeHistory);

    // §P1 shadow fan-out(config gate·기본 OFF) — 세션 응답(assistant)을 subscribeSession
    // 구독자에게 **추가 미러**(기존 telegram/ACP 배달 위 additive). 바인딩된 endpoint 는
    // 제외(중복방지). shadowFanout=false 면 리스너 미등록 = 완전 무영향. fail-soft.
    try {
      const sf = getUserConfig().sessionFabric;
      // 드라이버 게이트 — shadow OR **아무 서피스든 primary** 면 fan-out 리스너를 배선(primary
      // 단독 flip 도 발화). 전부 부재면 리스너 미등록 = 완전 무영향.
      const fabricActive = sf?.shadowFanout === true
        || sf?.primary?.telegram === true || sf?.primary?.discord === true || sf?.primary?.pwaMsg === true
        || sf?.streaming?.acp === true; // C5d — ACP 흡수도 fabric 배선 트리거
      if (fabricActive) {
        // §C5d (2026-07-16) — ACP 스트리밍 sink. ACP broadcast 를 통합 fan-out sink 로 흡수 →
        // tg/dc 턴이 'acp' 구독자(subscriber bridge·server.ts)를 통해 ACP peer 로도 스트리밍.
        // broadcaster 는 lazy(부팅 순서 무관·runAcpServer 가 늦게 세팅해도 호출 시점 resolve).
        if (sf?.streaming?.acp === true) {
          const { registerStreamingSink } = await import('../session/session-fanout.js');
          const { createAcpStreamSink } = await import('../session/streaming/acp-stream-sink.js');
          const { getActiveAcpBroadcaster } = await import('../acp/server.js');
          registerStreamingSink('acp', createAcpStreamSink(
            async (sid, update) => (await getActiveAcpBroadcaster()?.(sid, update)) ?? { delivered: 0 },
          ));
          console.warn('[nexus] session fan-out: acp STREAMING sink registered (C5d flip)');
        }
        // §C4 (2026-07-16) — PWA 메시지레벨 sink. fan-out 배달마다 session.output 을 /v1/events
        // 로 발행 → PWA 알림/뱃지 면이 role/text 담긴 메시지레벨 갱신 수신(content-less
        // session.updated 보완). 순수 additive(옛 메시지레벨 경로 없음·스트리밍은 C5) → suppression
        // 불필요. shadow OR primary.pwaMsg 시 등록. ctx.sessionId 로 이벤트 태깅(endpoint 무관).
        if (sf?.shadowFanout === true || sf?.primary?.pwaMsg === true) {
          const { registerSurfaceSink } = await import('../session/session-fanout.js');
          registerSurfaceSink('pwa', {
            deliver: async (_endpoint, ev, ctx) => {
              if (!ev.text) return;
              eventBus.publish({
                ts: Date.now(),
                kind: 'session.output',
                detail: { sessionId: ctx.sessionId, role: ev.role ?? 'assistant', text: ev.text },
              });
            },
          });
          console.warn(`[nexus] session fan-out: pwa surface sink registered (${sf?.primary?.pwaMsg ? 'primary' : 'shadow'})`);
        }
        const { fanOutSessionOutput, shadowExcludeKeys } = await import('../session/session-fanout.js');
        const { loadSession, subscriberKey, listSubscribers } = await import('../session/index.js');
        const { recordFanoutParity, oldPathRecipientKeys } = await import('../session/session-fanout-parity.js');
        const { debug: dbg } = await import('../debug/log.js');
        runtimeHistory.onAppend((sessionId, msgs) => {
          try {
            // assistant 텍스트 추출 — content 는 string 또는 ContentBlock[](text 블록).
            const text = msgs
              .filter((m) => m.role === 'assistant')
              .map((m) => typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                  ? m.content.filter((b) => b && (b as { type?: string }).type === 'text').map((b) => (b as { text: string }).text).join('')
                  : '')
              .join('\n').trim();
            dbg.log('session.shadow', 'append', { sessionId, msgs: msgs.length, textLen: text.length });
            // 배달 이벤트(assistant 응답)만 parity/fan-out 대상. user-append(turn 시작)는 스킵.
            if (!msgs.some((m) => m.role === 'assistant')) return;
            const meta = loadSession(sessionId)?.meta;
            if (!meta) return;
            // 옛 경로 배달 대상(바인딩/tgChatId) — shadow excludeKeys(중복방지) + parity oldRecipients 공용.
            const oldRecipients = oldPathRecipientKeys(meta);
            // §C0 parity — 옛 대상 vs 새 fan-out 이 flip 시 도달할 **전체 구독자셋**(exclude 무관) 대조.
            // green(유실 없음+내용 정상) = 그 서피스 flip 안전. 배달 무변경·관측만.
            const newRecipients = listSubscribers(sessionId)
              .filter((s) => s.presence !== 'left')
              .map((s) => subscriberKey(s.surface, s.endpoint));
            recordFanoutParity({
              sessionId, newRecipients, oldRecipients,
              contentLen: text.length, degraded: text.length === 0,
            });
            if (!text) return;
            // §C2/C3 배달 — primary 로 승격된 서피스는 **fan-out 이 실배달**하므로 excludeKeys 에서
            // 뺀다(shadowExcludeKeys). shadow 서피스는 그대로 제외(옛 경로가 배달·중복방지).
            // ⚠️ primary 서피스는 옛 배달 경로가 suppression 돼야 이중배달이 없다 — telegram 은
            // 스트리밍 UX(placeholder+streamer) 결합이라 그 suppression 은 대표 dogfood 결정(잔여).
            const primarySurfaces: SessionSurface[] = [];
            if (sf?.primary?.telegram) primarySurfaces.push('telegram');
            if (sf?.primary?.discord) primarySurfaces.push('discord');
            const excludeKeys = shadowExcludeKeys(oldRecipients, primarySurfaces);
            void fanOutSessionOutput(sessionId, { kind: 'message', role: 'assistant', text }, { excludeKeys });
          } catch (e) { dbg.log('session.shadow', 'error', { err: String(e) }); }
        });
        console.warn('[nexus] session fabric fan-out listener wired (shadowFanout/primary)');
      }
    } catch (err) { console.warn(`[nexus] session fabric fan-out wiring failed: ${(err as Error).message}`); }

    // ACP runTurn closure — multi-LLM-aware composer.
    // - When the inbound `session/prompt` carries
    //   `_meta.elanous.multiLlm.targets`, dispatch via the multi-LLM
    //   bridge (parallel `runCoreTurn` per target · per-chunk
    //   `_meta.elanous.modelId` annotation so Showroom demultiplexes
    //   per panel · DM stage 3 FU tool_call propagation rides this).
    // - When the hint is absent, the composer falls through to the
    //   legacy single-LLM bridge so vanilla ACP clients (chat tab ·
    //   webterm peer) keep their current behaviour.
    //
    // Replaced the legacy `createDaemonRunTurn` direct wire (which
    // ignored the hint) on 2026-05-09 — Showroom multi-LLM dispatch +
    // DM stage 3 FU were dead-code without this composer.
    // ⛔ #14191 이 심은 가드(`createDaemonRunTurn requires killNonDetachedPty when the
    //    selected tool surface exposes PtyShell`)는 이 경로에도 걸린다 — 데몬의 도구 표면이
    //    PtyShell 을 노출하면 중단 시 비-detached PTY 를 걷어야 하기 때문이다.
    //    `src/index.ts` 의 `--acp-server` 경로는 같은 의존을 이미 넘긴다. 여기만 빠져 있었고
    //    그래서 nexus 진입이 «던졌다»(2026-08-30 · nexus-write-api 35/35 fail).
    const { killNonDetached: killNonDetachedPty } = await import('../pty-shell/registry.js');
    const innerRunTurn = createDaemonMultiLlmRunTurn(runtimeHistory, {
      tools: toolsKind,
      killNonDetachedPty,
      ...(toolCwd ? { toolCwd } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    });

    // R1 IntentContext extension (2026-05-09) — wrap the inner runTurn
    // so the ranker sees three more signals:
    //   - lastErr        — captured from any throw inside runTurn
    //   - fileEditCount  — captured by intercepting ctx.pushToolCall
    //                       for Edit/Write/MultiEdit tool names
    //   - progressPct    — derived from turn count inside the tracker
    //                       (no wire here · recordPrompt increments it)
    // The wrap mutates `ctx.pushToolCall` in-place — fresh ctx per
    // prompt, single-threaded within a turn, so no aliasing concerns.
    const runTurn: typeof innerRunTurn = async (ctx) => {
      const originalPushToolCall = ctx.pushToolCall;
      ctx.pushToolCall = (call) => {
        intentTurnTracker.recordToolUse(ctx.sessionId, call.name);
        return originalPushToolCall.call(ctx, call);
      };
      try {
        await innerRunTurn(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        intentTurnTracker.recordError(ctx.sessionId, msg);
        throw err;
      }
    };
    runtimeRunTurn = runTurn;

    // ACP server — deferred transport so wsBridge can drive each new
    // WS connection through the same shared `ctx` (sessions, dualRole,
    // runTurn). The transportFactory captures the per-connection
    // handler; wsBridge.acpOnConnection forwards to it.
    acpHandlerRef = { current: null };
    acpShutdown = new AbortController();
    const transportFactory = async (
      onConnection: AcpConnectionHandler,
    ): Promise<AcpTransportServer> => {
      acpHandlerRef!.current = onConnection;
      return {
        kind: 'in-process',
        address: 'nexus:ws-bridge',
        close: async () => { if (acpHandlerRef) acpHandlerRef.current = null; },
      };
    };
    // T5.E follow-up — daemon-public-server freeze 시 ACP-side 의 3개
    // callback (runAgentTurn / abortAgentTurn / recordLiveCameraFrame)
    // 이 NEXUS path 로 옮겨오지 않아 `elanous nexus pwa start` 로 띄운
    // 사용자에게서 `:agent <prompt>` 가 `daemon not wired with
    // runAgentTurn` 으로 실패. 같은 wire 가 abort + live-camera 도
    // 끊었음. daemon-public 의 wire (src/index.ts:4083-4114) 를
    // 그대로 미러링.
    const { createAgentTurnRunner, abortAgentTurn: abortAgentTurnFn } =
      await import('../repl/agent-turn.js');
    const { toolSurface } = await import('../boot/daemon-tools/index.js');
    const { recordLiveCameraFrame: recordLiveCameraFrameFn } =
      await import('../web-terminal/live-camera-registry.js');
    // `:agent` (통합 모드 webterm dock) toolsKind — distinct from the
    // standalone-chat `toolsKind` above. user-config (`global.tools` /
    // `ELANOUS_TOOLS`) is intentionally bypassed here: WebTerminal* tools
    // are the integrated-dock's reason for existing, so a config-
    // narrowed boot still gives the dock its full surface. CLI
    // `--tools` is honored for developer debugging.
    const agentTurnToolsKind = resolveAgentTurnToolsKind(opts);
    const runAgentTurnFn = createAgentTurnRunner({
      history: runtimeHistory,
      ...(agentTurnToolsKind !== 'none' && toolCwd
        ? { toolSurface: toolSurface(agentTurnToolsKind), toolCwd }
        : {}),
    });

    // FU-2 webterm wire (PLAN-pwa-webterm-voice-control v1.2 §15 ·
    // 2026-05-07) — pwaTtsBridgeHolder is declared at runNexus outer
    // scope (above) so the voice-init branch in `if (!skipHttp)` can
    // assign `current = pwaTtsBridge` without a cross-block reference
    // error. ACP server is booted before voice init runs (transport
    // factory deferred), so the wrapper's pushChunk/flush dereference
    // the holder at call time — by then voice init has either set
    // `current` or left it undefined (no TTS provider). When
    // undefined, the wrapper is a pure no-op and ACP falls back to
    // broadcast-only (legacy).

    void runAcpServer({
      runTurn,
      hasSession: (id) => runtimeHistory!.has(id),
      shutdownSignal: acpShutdown.signal,
      transportFactory,
      // AskUserQuestion cross-surface bridge (2026-05-13 · M2). When the
      // ACP server hands us the per-connection handle, build the bridge
      // and register it as the global AskUserQuestionResolver. The
      // dispatcher's 4-tier priority falls back to TUI deps / readline
      // resolver / 구조화 error when no cap-able peer is attached, so
      // this registration is safe even on dashboard-only deployments.
      onAbortHandle: (cancel) => {
        // Captured during runAcpServer setup once `sessions` Map is
        // alive. The metaApi DELETE handler dereferences the holder
        // at call time (via the closure threaded into metaApiOpts
        // below) so a boot race that lands a DELETE before ACP
        // finishes still returns aborted:false instead of crashing.
        acpAbortHolder.current = cancel;
      },
      onHandle: async (handle) => {
        const { AskQuestionBridge } = await import('../acp/ask-question-bridge.js');
        const { setAskUserQuestionResolver } = await import('../ask-user-question/index.js');
        const bridge = new AskQuestionBridge({ handle });
        setAskUserQuestionResolver(bridge.resolve);
      },
      // Live IntentContext signal for the PWA IntentPanel — every
      // inbound ACP prompt updates the per-session tracker. Returning
      // void (not 'consume') keeps the prompt flowing through the
      // default echo / runTurn path; we just sniff the (sessionId,
      // userText) pair as it goes by.
      onPromptReceived: (ctx) => {
        intentTurnTracker.recordPrompt(ctx.sessionId, ctx.userText);
        // GN (2026-07-18) — 네이티브 iOS 앱이 ACP `_meta.elanous.origin.surface='native'`
        // 를 보내면 세션 origin 을 태깅 → session-history-mirror(getOrigin)가 S1 세션에
        // origin='native' 로 전파 → `elanous session --origin native` 가시화 + taste 귀속.
        // 종전엔 mirror 가 ACP 세션을 무조건 'pwa' 로 오라벨. Android(agent-cli)는 별경로.
        try {
          const elanousMeta = ctx.promptMeta?.elanous as Record<string, unknown> | undefined;
          const originMeta = elanousMeta?.origin as Record<string, unknown> | undefined;
          const surface = originMeta?.surface;
          if (typeof surface === 'string' && isDaemonSessionOrigin(surface)) {
            // tagOrigin(setOrigin 아님) — 첫 append 前이라 세션이 아직 byId 에 없음.
            runtimeHistory!.tagOrigin(ctx.sessionId, surface);
          }
        } catch { /* fail-soft — origin 태깅 실패가 턴을 깨지 않음 */ }
      },
      runAgentTurn: runAgentTurnFn,
      abortAgentTurn: (input: { sessionId: string; terminalId: string }): boolean =>
        abortAgentTurnFn(input.sessionId, input.terminalId),
      recordLiveCameraFrame: (input: {
        sessionId: string;
        terminalId?: string;
        attachmentId: string;
        ts?: number;
      }) => {
        const entry = recordLiveCameraFrameFn(input);
        return { frameIndex: entry.frameIndex };
      },
      pwaTtsBridge: {
        pushChunk: (sessionId, delta) => {
          pwaTtsBridgeHolder.current?.pushChunk(sessionId, delta);
        },
        flush: (sessionId) => {
          const b = pwaTtsBridgeHolder.current;
          return b ? b.flush(sessionId) : undefined;
        },
      },
      // W8-A 후속 #1 (2026-05-14) — NEXUS-wide conversation aggregator.
      // elanous-builtin ACP turn (user prompt + agent response) 을 같은
      // store 로 push → agent-cli `historyMode='rebuild'` 호출 시 elanous-
      // builtin turn 도 prefix 에 포함. 진정한 양방향 (elanous-builtin ↔
      // agent-cli) cross-backend conversation 통합.
      conversationAggregator: globalAgentCliConversationStore(),
      // PLAN-codex-app-server-hermes-parity §5 Phase H2·1 wire
      // (2026-05-16) — bridge `elanous/codex/plugins` ACP method to the
      // first running codex agent's JSON-RPC client. Codex plugins are
      // user-global (cwd-independent), so any active codex agent's
      // client gives the canonical `plugin/list` response. Empty list
      // when no codex agent is attached — UI hides sub-chips without
      // surfacing an error. fetchCodexPlugins caches per-client for
      // 5 min, so this hot path is essentially a Map lookup most of
      // the time.
      fetchCodexPlugins: async () => {
        const client = globalAcpAgentManager().getActiveCodexClient();
        return fetchCodexPlugins(client);
      },
    }).catch(() => { /* swallow — shutdown signal triggers normal return */ });

    // HITL pending-store. Channel HITL bus consumers can reach this
    // via the returned RunNexusHandle.hitlPending; the http-server
    // resolveAnswer dispatcher is wired below via metaApi.
    runtimeHitlPending = createHitlPendingCallbacks();

    // 2026-05-08 · NEXUS HITL producer wire-up (multi-channel).
    // Five sibling channels share `runtimeHitlPending` — whichever
    // device POSTs `/v1/hitl/callback/:requestId` first wins, the
    // others dismiss via channel.cancel(). Channel order doesn't
    // matter for correctness (race semantics are commutative) but a
    // stable order keeps logs predictable across runs.
    //
    //   1. Pushcut    — #2009                 (iPhone/iPad fleet)
    //   2. PWA banner — β-1a · #2027          (in-Showroom modal)
    //   3. Telegram   — β-1b · #2028          (env-gated bot)
    //   4. Discord    — β-1c · #2030          (env-gated bot)
    //   5. Terminal   — β-1d · this PR        (headless + isTTY only)
    //
    // Each channel honors a `skip*Channel` opt for tests + opts.*
    // overrides for fakes. Telegram/Discord/Terminal also auto-skip
    // when their config (env vars / TTY gate) is missing.
    const channels: ConfirmChannel[] = [];
    if (!opts.skipPushcutChannel) {
      const pushcutClient = getPushcutClient();
      const notificationName = opts.pushcutNotificationName
        ?? process.env['ELANOUS_HITL_NOTIFY']
        ?? 'monad-confirm';
      channels.push(createPushcutConfirmChannel({
        client: pushcutClient,
        notificationName,
        awaitCallback: (requestId) => runtimeHitlPending!.awaitCallback(requestId),
      }));
    }
    if (!opts.skipPwaChannel) {
      channels.push(createPwaConfirmChannel({
        bus: eventBus,
        awaitCallback: (requestId) => runtimeHitlPending!.awaitCallback(requestId),
      }));
    }
    if (!opts.skipTelegramChannel) {
      const tgOpts = opts.telegramHitlOpts ?? readNexusTelegramHitlOptsFromEnv();
      if (tgOpts) {
        const handle = createNexusTelegramHitlHandle(tgOpts);
        if (handle) {
          runtimeTelegramHitl = handle;
          channels.push(handle.channel);
        }
      }
    }
    if (!opts.skipDiscordChannel) {
      const dcOpts = opts.discordHitlOpts ?? readNexusDiscordHitlOptsFromEnv();
      if (dcOpts) {
        const handle = createNexusDiscordHitlHandle(dcOpts);
        if (handle) {
          runtimeDiscordHitl = handle;
          channels.push(handle.channel);
        }
      }
    }
    if (!opts.skipTerminalChannel) {
      // β-1d · terminal channel registers only in headless mode
      // (TUI mode owns stdin via raw-mode + alt-screen). Tests can
      // bypass via terminalHitlOpts.forceEnable + injected streams.
      const allowTerminalGate = headless || Boolean(opts.terminalHitlOpts?.forceEnable);
      if (allowTerminalGate) {
        const terminalChannel = createNexusTerminalHitlChannel(opts.terminalHitlOpts);
        if (terminalChannel) channels.push(terminalChannel);
      }
    }
    if (channels.length > 0) {
      registerDefaultConfirmChannels(channels);
    }
    // Structured AskUserQuestion SSE fallback. ACP remains first via
    // AskQuestionBridge; this channel is the next-tier resolver when
    // that bridge throws AskBridgeUnavailable. Binary confirm stays on
    // createPwaConfirmChannel — options are enclosed, not folded.
    if (!opts.skipPwaChannel) {
      registerDefaultQuestionChannels([
        createPwaQuestionChannel({
          bus: eventBus,
          awaitCallback: (requestId) => runtimeHitlPending!.awaitQuestionCallback(requestId),
        }),
      ]);
    }
    // ACP-independent AskUserQuestion resolver. The tool dispatcher only
    // sees the resolver hook — without this, a daemon that never gets an
    // ACP onHandle rejects with "no TUI deps + no resolver hook" even
    // though the PWA SSE channel above is registered. Delegates to
    // requestQuestion so we do not add a second channel implementation.
    // Installed only when the hook is empty; onHandle may still replace
    // it with AskQuestionBridge.resolve. Always races the registered
    // channels — requestQuestion already returns the structured
    // { answers: {}, cancelled: true } fallback when nobody answers.
    if (getAskUserQuestionResolver() === null) {
      const defaultAskResolver: AskUserQuestionResolver = async (req) => {
        const raced = await requestQuestion({ request: req });
        return raced.result;
      };
      setAskUserQuestionResolver(defaultAskResolver);
      installedDefaultAskResolver = defaultAskResolver;
    }
    // cv-3 β-4 audit log (Round 2 · 2026-05-08). Every confirm
    // round-trip lands in $ELANOUS_DIR/hitl-log.jsonl as line-delimited
    // JSON. The hook is fire-and-forget — confirm.ts never awaits it,
    // so a slow/broken writer cannot stall the race winner. 100 MB
    // rotation keeps disk usage bounded across long-running daemons.
    try { installFileAuditHook(); }
    catch { /* swallow — audit failure must not break HITL */ }

    // 2026-05-08 · intent-prediction service (Phase 0.5 PWA-only).
    // Composes the heuristic ranker + feedback store + 5s tick
    // scheduler into a single handle the REST/SSE wire consumes.
    // The Phase 0.5 minimum context provider returns a baseline
    // empty context for any sessionId so the PWA Intent panel can
    // dogfood the UX flow + feedback loop without the full context
    // plumbing (real context wiring lands as a follow-up once the
    // PWA reveals which signals matter most).
    if (!opts.skipIntentPrediction) {
      // Live-context provider — reads from the per-session turn
      // tracker that's updated by ACP `onPromptReceived` (wired
      // below in runAcpServer call). Before this lift (2026-05-09)
      // the fallback returned all-zeros which made the ranker
      // produce identical rankings every tick → SSE never emitted →
      // the PWA IntentPanel sat frozen. lastErr / progressPct /
      // fileEditCount stay 0 in v0 (deeper instrumentation pending);
      // the live idleMs + lastTurnSummary alone give the panel a
      // visibly evolving ranking as time passes (오토파일럿 / 승인
      // weights respond).
      const liveContext: (id: string) => Omit<IntentContext, 'recentTaps'> = (id) => {
        const t = intentTurnTracker.read(id);
        return {
          sessionId: id,
          lastTurnSummary: t?.lastTurnSummary ?? '',
          // Empty string from the tracker → ranker `lastErr.trim().length`
          // gate stays cold. Mapped to null only when the session is
          // unknown to keep the type contract unchanged.
          lastErr: t ? (t.lastErr || null) : null,
          progressPct: t?.progressPct ?? 0,
          fileEditCount: t?.fileEditCount ?? 0,
          idleMs: t?.idleMs ?? 0,
        };
      };
      const provider = opts.intentContextProvider ?? liveContext;
      runtimeIntentPrediction = createIntentPredictionService({
        contextProvider: provider,
        ...(opts.intentTickIntervalMs ? { intervalMs: opts.intentTickIntervalMs } : {}),
        feedbackStore: createFeedbackStore({}),
      });
      // 2026-05-09 dogfood fix — fan ranker output into the global
      // /v1/events bus so the PWA IntentPanel (which subscribes via
      // `subscribeEvents({topics: ['intent-prediction.']})`) actually
      // receives ranking frames. Without this wire the panel sat at
      // ranking=null forever even though the per-session SSE
      // (/v1/intent-prediction/:id/sse) was working correctly —
      // documented in
      // `내부 문서 `ROADMAP-pwa-pre-ios-gap-2026-05-09`` R1 후속.
      runtimeIntentPrediction.onRanking((ranking) => {
        eventBus.publish({
          ts: ranking.generatedAt,
          kind: 'intent-prediction.ranking',
          detail: ranking as unknown as Record<string, unknown>,
        });
      });
    }
  }
  // PR ε — supervisor wiring. View-only kinds (chat) are no-op; future
  // PR ζ/η/θ kinds register specs that the supervisor auto-spawns. The
  // reaper runs once at boot per HANDOFF D-3.
  // (Created BEFORE HTTP server so the mutation API can hand the
  //  supervisor handle to the routing layer in a single place.)
  // N-2 cleanup PR c — supervisor is also created before the shell so
  // the daemon / pwa-host detail views can wire `s` (stop) and `r`
  // (restart) keys against the live handle.
  let supervisor: Supervisor | undefined;
  if (!opts.skipSupervisor) {
    supervisor = createSupervisor({
      state,
      registry,
      ...(opts.supervisorSpawnBackend ? { spawnBackend: opts.supervisorSpawnBackend } : {}),
      ...(opts.supervisorProbes ? { probes: opts.supervisorProbes } : {}),
    });
    // ⭐P2 (capture substrate · PLAN §5) — start the manifest→ACP
    // terminalFrame poller. Reads the shared pty-manifest for live `tui`
    // frames (the separate-process dashboard TUI self-reports there · S1)
    // and fans them to term-frame-capable PWA/iOS peers so they can
    // live-mirror the human's screen (picker/modal 포함). Broadcaster is
    // resolved lazily each tick (boot-order agnostic · unref'd interval ·
    // cheap early-out when no peers). Stopped in the SIGINT/SIGTERM cleanup.
    try {
      const { startTuiFrameBroadcaster } = await import('../capture/tui-frame-broadcaster.js');
      const { getActiveAcpAllSessionsTermFrameBroadcaster } = await import('../acp/server.js');
      stopTuiFrameBroadcaster = startTuiFrameBroadcaster({
        getBroadcaster: () => getActiveAcpAllSessionsTermFrameBroadcaster(),
      });
    } catch (err) {
      console.warn('[nexus] tui-frame-broadcaster start skipped:', err instanceof Error ? err.message : err);
    }
    // ⭐P5 (capture substrate · PLAN §5) — start the frame→episodic-memory
    // poller. Polls the shared pty-manifest for framed tui/pty surfaces
    // (dashboard TUI + forwarded self-implement children · cross-process)
    // and records SALIENT screen changes (dedup + rate-limited) into
    // surface_events so `elanous self recall` can retrieve "what elanous was
    // doing / seeing". Summary + refs pointers only (no frame blob · §9).
    try {
      const { startFrameMemoryPoller } = await import('../capture/frame-memory.js');
      const { openSurfaceEventsDb } = await import('../domains/surface-events.js');
      const { recordSelfEvent } = await import('../domains/self-awareness.js');
      const memDb = openSurfaceEventsDb();
      try {
        const stopPoll = startFrameMemoryPoller({
          record: (input) => { try { recordSelfEvent(memDb, input); } catch { /* fail-soft */ } },
        });
        // Tie the db handle's lifetime to the poller: close it on stop so the
        // daemon's surface_events handle isn't left open past shutdown.
        stopFrameMemoryPoller = () => { try { stopPoll(); } finally { try { memDb.close(); } catch { /* already closed */ } } };
      } catch (startErr) {
        try { memDb.close(); } catch { /* already closed */ }  // don't leak the db if start throws
        throw startErr;
      }
    } catch (err) {
      console.warn('[nexus] frame-memory poller start skipped:', err instanceof Error ? err.message : err);
    }
    supervisor.reclaim();
  }

  // N-1 cleanup PR c — bootstrap one NexusChatSession per registered
  // chat-kind tab. Sessions are constructed *before* the shell so the
  // sidebar item factory's first paint already sees them — otherwise
  // the chat tab would briefly render the placeholder until the next
  // event-bus invalidate kicks in.
  //
  // Sessions are skipped for the runtime opt-out path (skipRuntimeApi)
  // because their lazy ACP attach reaches into the dashboard ACP agent
  // manager — the same surface that the runtime opt-out exists to
  // sidestep in unit tests.
  // N-1 cleanup PR g.1 — boot-time chat backend auto-detection.
  // After the PR g.1 hard-default flip ('claude-code' → 'none'), a
  // clean-machine new user would otherwise see the placeholder until
  // they manually pick a backend in Settings. Auto-detect probes for
  // an OAuth token (codex) or one of the 3 supported API-key envs
  // (OPENAI / ANTHROPIC / GEMINI) and wires the first match. When
  // the resolved spec backend is non-'none' (user / per-tab override
  // already chose), we honor that and skip detection.
  const chatBackendDetection = detectChatBackend();
  // Banner only on the production live path — detachForTesting harness
  // boots without a TTY so the echo would just clutter test stderr +
  // leak the developer's host secret state into CI logs.
  if (chatBackendDetection.backend !== 'none' && !opts.detachForTesting) {
    console.log(`[nexus] chat backend auto-detected · ${chatBackendDetection.source} → ${chatBackendDetection.backend}`);
  }

  const chatSessions: NexusChatSessionRegistry = new Map();
  if (!skipRuntime) {
    for (const tab of registry.listByKind('chat')) {
      let backend = readChatTabBackend(tab.spec);
      // PR g.1 — apply auto-detection only when the spec resolved to
      // 'none' (i.e., user hasn't explicitly pinned a backend on this
      // tab or globally). Explicit pins always win.
      if (backend === 'none' && chatBackendDetection.backend !== 'none') {
        backend = chatBackendDetection.backend;
      }
      const session = new NexusChatSession({
        backend,
        ...(opts.toolCwd ? { cwd: opts.toolCwd } : {}),
      });
      chatSessions.set(tab.spec.id, session);
    }
  }

  // N-1 cleanup PR d — bootstrap one NexusWebtermSession per
  // registered webterm-kind tab. Same lifecycle reasoning as
  // chatSessions: constructed before the shell so the first paint
  // sees them. When `webtermSpawn` was omitted the session is
  // constructed in inert mode (no backend) — the view still renders
  // the live header + placeholder hint, and the tui-render webterm
  // interception is a no-op until a backend is attached. Production
  // wires `webtermSpawn` via the node-pty factory in PR e
  // (mini-terminal-backend.ts).
  const webtermSessions: NexusWebtermSessionRegistry = new Map();
  const bootstrapWebtermSession = (tabId: string): void => {
    if (webtermSessions.has(tabId)) return;
    const tab = registry.get(tabId);
    if (!tab || tab.spec.kind !== 'webterm') return;
    const cwdMeta = (tab.spec.meta as { cwd?: string } | undefined)?.cwd;
    const backendFactory = effectiveWebtermSpawn
      ? () => {
          const decided = resolveWebtermCwd({
            ...(cwdMeta ? { tabCwd: cwdMeta } : {}),
            ...(runtimeToolCwd ? { toolCwd: runtimeToolCwd } : {}),
            instance: resolveCurrentInstance(),
            processCwd: process.cwd(),
          });
          debug.log('nexus.webterm', 'spawn-cwd', { tabId: tab.spec.id, cwd: decided.cwd, source: decided.source });
          return effectiveWebtermSpawn({ id: tab.spec.id, cwd: decided.cwd });
        }
      : undefined;
    const session = new NexusWebtermSession({
      ...(backendFactory ? { spawn: backendFactory } : {}),
    });
    if (session.getStatus() === 'error') {
      try { session.destroy(); } catch { /* swallow */ }
      console.warn(`[nexus] webterm session bootstrap failed: ${tabId}`);
      return;
    }
    webtermSessions.set(tabId, session);
  };
  const unsubscribeWebtermTabLifecycle = eventBus.subscribe((event) => {
    if (event.kind === 'tab.created' && event.tabId) {
      bootstrapWebtermSession(event.tabId);
    } else if (event.kind === 'tab.down' && event.tabId) {
      // A stopped view-only tab remains registered; only unregister removes
      // its daemon-owned PTY session. TabRegistry.unregister deletes before
      // emitting tab.down, so registry absence is the lifecycle boundary.
      if (registry.has(event.tabId)) return;
      const session = webtermSessions.get(event.tabId);
      if (!session) return;
      webtermSessions.delete(event.tabId);
      try { session.destroy(); } catch { /* swallow */ }
    }
  }, ['tab.']);
  for (const tab of registry.listByKind('webterm')) {
    bootstrapWebtermSession(tab.spec.id);
  }

  // N-2 cleanup PR c — shell creation deferred until after supervisor so
  // daemon / pwa-host detail views get wired with stop/restart action.
  // N-2 cleanup PR e — also wire the production fs error snapshot reader
  // PLAN-tui-redundancy-cleanup T4 (2026-05-16) — createNexusShellView
  // mount 제거. 사용자 daemon-only (headless) mode 만 사용 · shell view
  // 자체가 dead code 였다 (`--legacy-tui` flag 가 T3 에서 제거됨).
  const shell = null as unknown as import('../ui/widgets/sidebar-tab-surface.js').SidebarTabSurface;

  // PR β' — Edit-in-PWA signing key + nonce store. The key persists at
  // ~/.elanous/nexus/edit-in-pwa.key (0o600); the nonce store is in-memory
  // (acceptable since 5-min TTL means nexus restart drops at most a 5m
  // window of consumed nonces — replay is bounded by token expiration
  // anyway).
  const editInPwaSigningKey = loadOrCreateSigningKey();
  const editInPwaNonceStore = new NonceStore();

  // P.1 — outer-scope so the boot banner can report PWA URL state.
  let pwaStaticDir: string | undefined;

  if (!skipHttp) {
    const httpHost = opts.httpHost ?? '127.0.0.1';
    const httpStartPort = opts.httpStartPort ?? DEFAULT_NEXUS_HTTP_PORT;
    const editInPwaCtx = {
      signingKey: editInPwaSigningKey,
      nonceStore: editInPwaNonceStore,
      audience: `${httpHost}:${httpStartPort}`,
      nexusOrigin: `http://${httpHost}:${httpStartPort}`,
    };

    // PR k — assemble wsBridge + metaApi opts only when the runtime is
    // wired (skipRuntime=false). Tests that exercise pure routing skip
    // both so the previously-503 stub contract is preserved end-to-end.
    let wsBridgeOpts: import('./api/http-server.js').NexusWsBridgeInit | undefined;
    let metaApiOpts: import('./api/meta-api.js').MetaApiOpts | undefined;

    if (!skipRuntime && runtimeHistory) {
      // Voice REST + adapter. createVoiceRestHandler is stateless;
      // the STT provider singleton (getDaemonSttProvider) returns
      // null until `initDaemonSttProvider()` is called — fine, the
      // handler returns 503 stt-unavailable in that case.
      const voiceRest = createVoiceRestHandler({
        getSttProvider: () => getDaemonSttProvider(),
      });

      // Phase 5b (PWA voice 일원화 server-side TTS · 2026-05-07) —
      // when caller didn't override `opts.voiceAdapter`, try to
      // construct the real adapter + TTS bridge in NEXUS itself.
      // Mirrors the legacy `elanous serve` boot pattern (src/index.ts:
      // 3957-4001) but inside the NEXUS runtime so chat REST `/v1/
      // prompt/stream` can dispatch text-deltas through the bridge
      // (metaApiOpts.pwaTtsBridge wire). When STT/TTS providers
      // aren't configured (no OPENAI_API_KEY etc.) we fall through
      // to the stub adapter — voice WS upgrade still succeeds but
      // STT is no-op + bridge is undefined (chat REST handler skips
      // the push silently · Phase 5 Web Speech API client fallback
      // remains the only audio path).
      let pwaTtsBridge: import('../voice/voice-pwa-tts-bridge.js').PwaTtsBridge | undefined;
      let realPwaAdapter: PwaVoiceAdapter | undefined;
      if (!opts.voiceAdapter) {
        try {
          const { initDaemonStreamingSttProvider, getDaemonStreamingSttProvider } =
            await import('../voice/voice-streaming-stt-singleton.js');
          const { initDaemonTtsProvider, getDaemonTtsProvider } =
            await import('../voice/voice-tts-singleton.js');
          await Promise.all([
            initDaemonStreamingSttProvider(),
            initDaemonTtsProvider(),
          ]);
          const streamingStt = getDaemonStreamingSttProvider();
          const ttsProvider = getDaemonTtsProvider();
          if (streamingStt) {
            const { createPwaVoiceAdapter } =
              await import('../voice/channel-adapters/pwa-voice-adapter.js');
            if (ttsProvider) {
              const { createPwaTtsBridge } =
                await import('../voice/voice-pwa-tts-bridge.js');
              pwaTtsBridge = createPwaTtsBridge({ ttsProvider });
              // FU-2 webterm wire — same instance the ACP server
              // dereferences via the holder wrapper (line ~547).
              // chat REST path uses local var below; both reach
              // the same per-session bridge.
              pwaTtsBridgeHolder.current = pwaTtsBridge;
            }
            const bridge = pwaTtsBridge;
            realPwaAdapter = createPwaVoiceAdapter({
              sttProvider: streamingStt,
              onSessionOpen: (session) => {
                if (bridge && session.sessionId && session.emitDownstream) {
                  const emit = session.emitDownstream.bind(session);
                  bridge.attach(session.sessionId, (frame) => emit(frame));
                }
              },
              onSessionClose: (session) => {
                if (bridge && session.sessionId) bridge.detach(session.sessionId);
              },
            });
            console.log(`voice: NEXUS PWA WS adapter functional (streaming STT wired · TTS bridge ${bridge ? 'wired' : 'absent (no TTS provider)'})`);
          } else {
            console.log('voice: NEXUS streaming STT inactive (set OPENAI_API_KEY for openai-realtime-stt) — voice WS will use stub adapter');
          }
        } catch (err) {
          console.log(`voice: NEXUS adapter init failed — ${err instanceof Error ? err.message : String(err)} — falling back to stub`);
        }
      }
      const voiceAdapter = realPwaAdapter ?? opts.voiceAdapter ?? createStubPwaVoiceAdapter();

      // Active tool surface — re-derive so we can pass it through opts.
      // Same resolution as the in-process branch above (resolveToolsKind).
      const toolsKind = resolveToolsKind(opts);
      const surfaceForOpts = toolSurface(toolsKind);
      const toolCwdForOpts = resolveToolCwd({ tools: toolsKind, toolCwd: opts.toolCwd });

      // ACP websocket and REST share the same boot token; explicit
      // opt-out omits the websocket verifier as well.
      wsBridgeOpts = {
        ...(acpHandlerRef ? {
          acpOnConnection: async (conn) => {
            const handler = acpHandlerRef!.current;
            if (handler) await handler(conn);
            else { try { await conn.close(); } catch { /* swallow */ } }
          },
        } : {}),
        voiceAdapter,
        ...buildNexusWsBridgeAuth(bearerToken),
      };

      metaApiOpts = {
        voiceRest,
        ...(bearerToken ? { bearerToken } : {}),
        noAuth,
        history: runtimeHistory,
        intakeStore: getIntakeStore(),
        toolSurface: surfaceForOpts,
        ...(toolCwdForOpts ? { toolCwd: toolCwdForOpts } : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        ...(runtimeHitlPending ? { hitlPending: runtimeHitlPending } : {}),
        eventBus,
      ...(runtimeIntentPrediction ? { intentPrediction: runtimeIntentPrediction } : {}),
        // Phase 5b — chat REST handler 가 같은 sessionId 의 active
        // voice WS 가 있으면 text-delta 를 bridge.pushChunk 로 흘림.
        // bridge 가 위에서 STT/TTS 둘 다 ready 일 때만 wired.
        ...(pwaTtsBridge ? { pwaTtsBridge } : {}),
        // IPC followup (2026-05-13) — wire the daemon-native
        // AgentStatusStore so external processes (dashboard PTY
        // parsers, future sidecars) can POST transitions via
        // `/v1/agent-status`.
        agentStatusStore,
        // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — same
        // pattern for the HUD strip. `/v1/hud-segment` POST writes
        // here; the SSE bridge fans set/clear onto the events bus.
        hudStore,
        // iOS session-list track (2026-05-14) — DELETE /v1/sessions/:id
        // fires the ACP per-session abort flag before dropping
        // history. Closure dereferences the holder at call time so a
        // DELETE arriving before ACP boot finishes still degrades
        // gracefully (initial no-op returns false).
        abortSession: (sessionId: string) => acpAbortHolder.current(sessionId),
      };
    }

    // P.1 — PWA static export auto-detect. T5.A 의 /app/* handler 가
    // staticDir wired 되면 NEXUS HTTP 가 `/app/*` 로 PWA UI 서빙. 미wired
    // 면 404 + P.2 banner hint 가 build 안내. `ELANOUS_PWA_STATIC_DIR` env
    // 로 override 가능 (test fixture / packaged path 후보 강제).
    pwaStaticDir = process.env.ELANOUS_PWA_STATIC_DIR?.trim()
      || resolvePwaStaticDir();

    // P-2D.2 — dev-proxy upstream is no longer persisted in UserConfig.
    // http-server creates its own DevProxyRuntimeRef; admin endpoint
    // (`POST /v1/nexus/admin/pwa-dev-proxy`) flips it live. Boot
    // default is null → static export. `elanous nexus pwa dev` posts
    // to the admin endpoint on start + deletes on stop, so dev mode
    // is per-session ephemeral state — exactly what user feedback
    // 2026-05-07 ("거의 개발 간 default 이면 컨픽으로 할 필요 없음")
    // asked for.
    //
    // R-OCR.1.3 — boot the default OCR provider registry (idempotent ·
    // Upstage only at this phase). Wired explicitly into startNexusHttpServer
    // opts.notesFromImage rather than relying on a module singleton that
    // the handler reaches into — keeps the dep-injection seam honest
    // (feedback_dep_inject_seam_must_be_wired) so missing wire surfaces
    // as 503 not-wired instead of silently fallback to an empty registry.
    const ocrRegistry: OcrRegistry = bootDefaultOcrProviders();
    // R-OCR.3 (2026-05-09) — discover the Obsidian vault once at boot
    // so the /v1/notes/save endpoint can knowledgeWrite() without re-
    // probing the filesystem on every request. discoverObsidianVault
    // 의 3-tier cascade (env override → ~/Obsidian/.../AutoResearch →
    // ~/Documents/Obsidian/AutoResearch → simulated `.elanous/research`)
    // 가 처리하므로 사용자 설정 없이도 항상 destination 이 결정된다.
    // simulated fallback 경우 vaultLabel 이 PWA 응답에 surfaced 돼서
    // 사용자가 "Obsidian 미설치 → simulated 저장" 상황을 인지 가능.
    const notesVault = discoverObsidianVault();
    // R-OCR.4 (2026-05-09) — single in-memory collector shared by
    // notes-from-image, notes-save, and the metrics endpoints. Reset
    // semantics = daemon restart (no persistence at this phase; v2
    // adds durable rollups when the KGS taxonomy lands).
    // R6 v2 FU (2026-05-09) — day-bucket persistence so daemon
    // restart no longer zeroes today's count and reflection queries
    // for past dates return real data. The store is opt-in via env
    // (ELANOUS_S3_DISABLED / no aws creds → local-only mode); see
    // `src/storage/s3.ts` for the canonical S3 path layout.
    const notesDayBucket = createDayBucketStore();
    const notesMetrics = createNotesMetricsCollector({ dayBucket: notesDayBucket });

    // Phase 2 (2026-05-13) — wire TOX before the workflow daemon so
    // schedule-trigger nodes that register a TOX task on fire have a
    // live graph + dispatcher to land in. The `subagent` surface bridges
    // to `globalAgentRegistry` so `Agent`-tool spawns and TOX-driven
    // subagent tasks share a single live registry. External llm-direct
    // tasks are triaged to current self-implement or the same subagent callable.
    // Other surface callables stay unwired here.
    try {
      // Wave 5 E3 — pick up `tools.agentSpawn.hopCap` from user-config
      // before any spawn can fire (the global registry reads the cap
      // at spawn time). Best-effort: a corrupted config falls back to
      // the registry default (5).
      try {
        const { getUserConfig } = await import('../user-config.js');
        const cap = getUserConfig().tools?.agentSpawn?.hopCap;
        if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 0) {
          setAgentHopCap(cap);
        }
      } catch { /* keep default cap */ }
      const agentToolSurface = toolSurface(resolveToolsKind(opts));
      const agentToolCwd = runtimeToolCwd ?? resolveToolCwd({ tools: 'chat', toolCwd: opts.toolCwd });
      const subagent = createGlobalSubagentCallable({
        hostTools: agentToolSurface.specs,
        ...(agentToolCwd ? {
          dispatchTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => agentToolSurface.dispatch(name, args, {
            cwd: agentToolCwd, signal: signal ?? new AbortController().signal, entry: 'elanous-apparatus',
          }),
          cwd: agentToolCwd,
        } : {}),
      });
      toxStore = new TaskStore();
      toxHandle = wireTox({
        graph: hydrateGraph(toxStore), store: toxStore,
        getWorkflowDaemon: () => workflowDaemon ?? null,
        surfaces: {
          subagent,
          externalExec: createExternalExecAdapter({
            dispatch: dispatchSelfImplement,
            cwd: runtimeToolCwd ?? resolveToolCwd({ tools: 'chat', toolCwd: opts.toolCwd })!, subagent,
            gh: async (args) => {
              const proc = Bun.spawn(['bun', joinPath(import.meta.dir, '../../bin/elanous.mjs'), 'gh', ...args], {
                cwd: runtimeToolCwd ?? resolveToolCwd({ tools: 'chat', toolCwd: opts.toolCwd })!,
                stdout: 'pipe', stderr: 'pipe',
              });
              const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
              ]);
              if (exitCode !== 0) throw new Error(stderr.trim() || `gh exited ${exitCode}`);
              return stdout;
            },
          }),
        },
        log: (line) => console.debug('[nexus]', line),
      });
    } catch (err) {
      toxStore?.close();
      toxStore = undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] wireTox failed: ${msg}`);
    }

    // §5-③ — autonomous idle-continuation. DEFAULT OFF: this ignites
    // self-firing turns, so it's gated on user-config `dispatch.enabled`.
    // When on, drives an active auto-mode goal on idle via the
    // ContinuationDriver (completion-audit prompt → turn → termination →
    // no-progress andon). Everything below is skipped when off, so the
    // default daemon boot path is unchanged.
    try {
      const { getUserConfig } = await import('../user-config.js');
      const dispatchCfg = getUserConfig();
      // Read the typed field if the parser populated it, else fall back
      // to the `raw` config.json passthrough — robust either way.
      const dispatchOn = opts.dispatch === true
        || dispatchCfg.dispatch?.enabled === true
        || ((dispatchCfg.raw?.dispatch as { enabled?: boolean } | undefined)?.enabled === true);
      if (dispatchOn) {
        const [
          { ContinuationScheduler, SCHEDULER_LOG_CATEGORY },
          { debug: schedulerDebug },
          { ContinuationDriver },
          { buildContinuationDriverDeps },
          { makeContinuationRunTurn },
          { getAutoModeState },
          { createActiveGoalReader, readNextAuthoredGoal, readAuthoredGoalQueue, completeAuthoredGoal, isAuthoredGoalTerminalOutcome, readAuthoredGoalDocument },
          { daemonIdleDetector },
          { registerLoopAgentSafe, endLoopAgentSafe },
        ] = await Promise.all([
          import('../dispatch/continuation-scheduler.js'),
          import('../debug/log.js'),
          import('../dispatch/continuation-driver.js'),
          import('../dispatch/continuation-bridge.js'),
          import('../dispatch/continuation-turn-runner.js'),
          import('../auto-research/auto-mode/session.js'),
          import('../dispatch/authored-goal-queue.js'),
          import('../dispatch/idle-detector.js'),
          import('../domains/loop-agent-registry.js'),
        ]);
        // §5-③ Phase D — share the process-wide idle detector so the
        // daemon input path (notifyDaemonActivity) resets the window.
        const idle = daemonIdleDetector;
        const runContinuationTurn = makeContinuationRunTurn(dispatchCfg);
        // 완료가 실패한 큐 항목 — 다음 틱에 다시 시도한다(영구 정지 방지).
        // ⛔ 큐 항목의 `docs/goals/…` 는 **저장소 상대 경로**라 해석할 뿌리가 필요하다. `process.cwd()`
        //   를 쓰면 데몬을 다른 디렉터리에서 띄웠을 때 **골이 안 읽혀 큐에서 사라진다**(라이브 폐루프
        //   실측 2026-08-01: 격리 인스턴스에서 `queue-entry-quarantined … (missing)`).
        //   ⚠️ 운영은 launchd 가 `WorkingDirectory` 를 저장소로 잡아 우연히 일치할 뿐이다.
        //   ⇒ **명시적으로 준 tool cwd** 를 뿌리로 쓴다(없으면 종전 동작).
        const authoredGoalRepositoryRoot = runtimeToolCwd ?? process.cwd();
        const pendingCompletions = new Set<string>();
        continuationScheduler = new ContinuationScheduler({
          isIdle: () => idle.isIdle(),
          // ⛔ 이 콜백의 거부는 `void this.tick()` 을 타고 **타이머의 미처리 rejection** 이 된다(리뷰 must-fix).
          //   큐 잠금 시간초과·파일 오류는 관측에 남기고 **골 없음(null)** 으로 fail-closed — 다음 틱에 다시 본다.
          // ⛔ 인라인 클로저였을 때 드레인이 auto-mode 확인 **앞**에 있었고, 그래서 auto-mode 가
          //   살아 있어도 큐를 잠그고 바꿨다(7차 리뷰 must-fix). 팩토리로 빼서 그 계약을 테스트가 본다.
          getActiveGoal: createActiveGoalReader({
            getAutoModeState,
            readNextAuthoredGoal: () => readNextAuthoredGoal(undefined, authoredGoalRepositoryRoot),
            completeAuthoredGoal,
            pendingCompletions,
            onError: (error) => schedulerDebug.log(SCHEDULER_LOG_CATEGORY, 'queue-read-failed', { reason: error instanceof Error ? error.message : String(error) }),
          }),
          makeDriver: (goal) => {
            const s = getAutoModeState();
            const queued = goal.source === 'file-queue' ? readAuthoredGoalQueue().pending[0] ?? null : null;
            const isAutoMode = goal.source === 'auto-mode' && s.active && s.goalSlug === goal.goalSlug;
            const isQueued = goal.source === 'file-queue' && queued?.id === goal.id;
            const terminationRule = isAutoMode ? s.terminationRule : isQueued && queued ? queued.terminationRule : undefined;
            // One day is the registry's documented upper ephemeral TTL. It is longer than
            // the bounded continuation scheduler's ordinary single-run lifetime, while still
            // allowing detectZombieLoops to recover an abandoned daemon on the next day.
            const loopId = continuationLoopId(goal);
            if (loopId) registerLoopAgentSafe({
              loopId,
              name: `Continuation: ${goal.goalSlug}`,
              summary: `Harness goal continuation from ${goal.source}`,
              loopKind: 'autonomous',
              lifecycle: 'ephemeral',
              ttlMin: CONTINUATION_LOOP_TTL_MINUTES,
            });
            return new ContinuationDriver(buildContinuationDriverDeps({
              goalSlug: goal.goalSlug,
              terminationRule: terminationRule ?? { kind: 'custom', command: 'false', timeoutMs: 5000 },
              ...(isQueued && queued ? { authoredGoalDocument: readAuthoredGoalDocument(queued, authoredGoalRepositoryRoot) } : {}),
              isActive: () => {
                const current = getAutoModeState();
                if (goal.source === 'auto-mode') return current.active && current.goalSlug === goal.goalSlug;
                return !current.active && readAuthoredGoalQueue().pending[0]?.id === goal.id;
              },
              runTurn: runContinuationTurn,
              onAndon: (reason) => console.warn(`[nexus] continuation andon (${goal.goalSlug}): ${reason}`),
              ...(loopId ? { onHalt: () => endLoopAgentSafe(loopId) } : {}),
            }));
          },
          // ⛔ 완료가 잠금 시간초과·I/O 로 실패하면 (a) 타이머에 미처리 rejection 이 나고 (b) 이미 halt 된
          //   드라이버는 다시 완료를 시도하지 않아 **큐 선두가 영구 정지**한다(리뷰 must-fix).
          //   ⇒ 실패를 관측에 남기고 **재시도 목록**에 넣는다. 다음 틱의 getActiveGoal 이 먼저 흘려보낸다.
          onOutcome: (goal, result) => {
            if (goal.source === 'file-queue' && goal.id && isAuthoredGoalTerminalOutcome(result.outcome)) {
              const id = goal.id;
              return completeAuthoredGoal(id).then(() => undefined).catch((error) => {
                pendingCompletions.add(id);
                schedulerDebug.log(SCHEDULER_LOG_CATEGORY, 'queue-complete-failed', { id, reason: error instanceof Error ? error.message : String(error) });
              });
            }
          },
        });
        continuationScheduler.start();
        opts.onContinuationSchedulerStarted?.(continuationScheduler);
        // ⛔ `console.debug` 는 run.log 에만 남고 **logs.db 에 안 닿는다** ⇒ `elanous logs` 로 조회되지
        //   않아 "관측한 것이 아니다"(제1원칙). 상주 루프의 **기동**은 그 루프를 진단할 때 가장 먼저
        //   찾는 사실이라 다른 스케줄러 사건과 **같은 카테고리**에 남긴다(RFC P0/L1 잔여분).
        // ⚠️ 틱 주기는 여기서 넘기지 않아 스케줄러의 기본값이 쓰인다 — **모르는 값을 필드로 만들지
        //   않는다**(부재와 미지가 같은 값이 되면 거짓을 생산한다). 필요해지면 그때 계약으로 뺀다.
        schedulerDebug.log(SCHEDULER_LOG_CATEGORY, 'scheduler-started', { source: 'dispatch.enabled' });

        // R5 (ROADMAP-organic-signal-engine) — dig-goal armer: DigTrigger →
        // auto-mode goal 자동 셋업. 두 번째 게이트(finance.dig.autoGoal.enabled
        // strict-true)까지 통과할 때만 폴러가 뜬다. 10분 틱 — arming은
        // 싱글턴+일일캡+시간당캡으로 스스로 드물어서 틱 주기는 정산 지연만 결정.
        const digCfg = dispatchCfg.finance?.dig?.autoGoal;
        if (digCfg?.enabled === true) {
          const { digGoalArmerTick } = await import('../dispatch/dig-goal-armer.js');
          digArmerHandle = setInterval(() => {
            digGoalArmerTick(dispatchCfg).then(r => {
              if (r.action === 'armed') console.debug(`[nexus] dig goal armed: ${r.goalSlug}`);
            }).catch(err => console.warn(`[nexus] dig armer tick failed: ${(err as Error).message}`));
          }, 10 * 60 * 1000);
          console.debug('[nexus] dig goal armer started (finance.dig.autoGoal.enabled)');
        }

        // M4 (PLAN-regime-synthesis §5.1) — replay(새벽 수면) armer: idle-driven
        // 세 번째 자율 루프. 이중 게이트(finance.replay.autoGoal.enabled strict-true)
        // 통과 시에만 폴러가 뜬다. 5분 틱 — 발화는 시간창(06-07)+일일1회+싱글턴으로
        // 스스로 드물어서 틱 주기는 정산/창 진입 지연만 결정.
        const replayCfg = dispatchCfg.finance?.replay?.autoGoal;
        if (replayCfg?.enabled === true) {
          const { replayGoalArmerTick } = await import('../dispatch/replay-goal-armer.js');
          replayArmerHandle = setInterval(() => {
            replayGoalArmerTick(dispatchCfg).then(r => {
              if (r.action === 'armed') console.debug(`[nexus] replay goal armed: ${r.goalSlug}`);
            }).catch(err => console.warn(`[nexus] replay armer tick failed: ${(err as Error).message}`));
          }, 5 * 60 * 1000);
          console.debug('[nexus] replay goal armer started (finance.replay.autoGoal.enabled)');
        }
      }
    } catch (err) {
      console.warn(`[nexus] continuation scheduler wire failed: ${(err as Error).message}`);
    }

    // Surface-unification v2.1 FU-3 (2026-05-11) — workflow-runtime
    // daemon boot. Discovers workflows, builds shared deps, fans
    // trigger lifecycle into the SSE event bus, and exposes
    // dispatchWebhook/dispatchChat through the HTTP server.
    try {
      const discoveredWorkflows = discoverWorkflowsForDaemon();
      if (discoveredWorkflows.length > 0) {
        const daemonDeps = buildWorkflowDaemonDeps({ runId: 'daemon-shared' });
        // Mission Fabric 통합 U3b — Schedule Trigger 이관잡 관측성 브릿지.
        // 이관된 예약잡(Task+Schedule Trigger)의 workflow-run 결과를
        // schedule_registry 로 되먹여 scheduleHealth·PWA /scheduler 유지.
        // schedule-derived('tox-task-*')가 아닌 workflow 는 no-op(prefix 체크만).
        const { openSchedulesDb } = await import('../domains/schedule-registry.js');
        const { recordTriggerRunToSchedule } = await import('../domains/schedule-trigger-bridge.js');
        const { TaskStore: BridgeTaskStore } = await import('../task-orchestrator/store.js');
        const bridgeScheduleDb = openSchedulesDb();
        const bridgeTaskStore = new BridgeTaskStore();
        workflowDaemon = createWorkflowRuntimeDaemon({
          workflows: discoveredWorkflows,
          deps: daemonDeps,
          onEmit: ({ workflowName, result }) => {
            try {
              recordTriggerRunToSchedule(
                { scheduleDb: bridgeScheduleDb, getTask: (id) => bridgeTaskStore.getTask(id) },
                { workflowName, result: { ok: result.ok, error: result.ok ? undefined : result.error } },
              );
            } catch { /* best-effort: 되먹임 실패가 workflow run 을 막지 않음 */ }
          },
          onLifecycle: (info) => {
            if (info.phase === 'subscribed') {
              publishTriggerSubscribed({
                workflowName: info.workflowName,
                nodeId: info.nodeId,
                variant: info.variant,
              });
            } else if (info.phase === 'unsubscribed') {
              publishTriggerUnsubscribed({
                workflowName: info.workflowName,
                nodeId: info.nodeId,
                variant: info.variant,
              });
            } else if (info.phase === 'fired') {
              publishTriggerFired({
                workflowName: info.workflowName,
                nodeId: info.nodeId,
                variant: info.variant,
                result: info.result,
              });
            }
          },
        });
        // Mission Fabric 통합 U3c — 부팅 재등록. discoverWorkflows 는 YAML 만
        // 스캔하므로 in-memory tox-task(Schedule Trigger 로 이관된 예약잡)를 모른다.
        // TaskStore 의 scheduleText 달린 비-terminal task 를 start() 전에 데몬 entries
        // 로 등록해, 이관잡이 데몬 재시작 후에도 발화하게 한다. best-effort.
        try {
          const { registerScheduledToxTasks, scheduledRunViaById } = await import('../domains/schedule-migrate.js');
          const { listSchedules } = await import('../domains/schedule-registry.js');
          // 레지스트리의 enabled trigger 만 등록한다(release 뒤 고아·수동 비활성 task 의 발화 방지).
          const runViaById = scheduledRunViaById(listSchedules(bridgeScheduleDb));
          const rr = registerScheduledToxTasks(bridgeTaskStore, (e) => workflowDaemon!.registerWorkflow(e), (jobId) => runViaById.get(jobId) ?? null);
          if (rr.registered > 0) {
            console.log(`[nexus] re-registered ${rr.registered} scheduled TOX task(s) as Schedule Triggers`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[nexus] scheduled TOX task re-registration failed: ${msg}`);
        }
        // Mission Fabric 통합 U4b — 이관잡(run_via='trigger') catch-up 자기회복.
        // workflow Schedule Trigger(node-cron)는 놓친 발화를 복구하지 않으므로,
        // schedule-runner 가 elanous 잡에 주던 catch-up(랩탑 슬립·데몬 다운으로 놓친
        // 일간 잡 복구)을 이관잡에도 보존. 부팅 1회 + 5분 주기(wake) sweep.
        // 복구는 command 직접 spawn·markResult(via='catchup')·매매 제외.
        try {
          const { catchUpTriggerJobs } = await import('../domains/schedule-migrate.js');
          const { defaultSpawnJob } = await import('../domains/schedule-runner.js');
          const runCatchUp = () => catchUpTriggerJobs(bridgeScheduleDb, { spawn: defaultSpawnJob })
            .then((cu) => {
              if (cu.recovered.length > 0) {
                console.log(`[nexus] catch-up recovered ${cu.recovered.length} missed trigger job(s)`);
              }
            })
            .catch(() => { /* best-effort */ });
          // 부팅 catch-up 은 비블로킹 지연(30s) — 부팅을 막지 않고 데몬이 안정된 뒤 실행.
          // (부팅 중 동기 spawn 하면 빠른 연속 재시작 때 자식이 SIGKILL 돼 false error.)
          const bootCuTimer = setTimeout(() => { void runCatchUp(); }, 30_000);
          if (typeof (bootCuTimer as { unref?: () => void }).unref === 'function') {
            (bootCuTimer as { unref: () => void }).unref();
          }
          // 주기 sweep(데몬 wake-from-sleep 복구) — 5분마다.
          const cuTimer = setInterval(() => { void runCatchUp(); }, 5 * 60_000);
          if (typeof (cuTimer as { unref?: () => void }).unref === 'function') {
            (cuTimer as { unref: () => void }).unref();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[nexus] trigger catch-up wiring failed: ${msg}`);
        }
        // Start in background — workflows with schedule cron / webhook
        // / chat trigger nodes become live as soon as the HTTP server
        // accepts traffic. Stop is called from the runNexus shutdown
        // hook below.
        void workflowDaemon.start().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[nexus] workflow daemon start failed: ${msg}`);
        });

        // §P2 배선 — 세션 presence grace TTL 스위퍼(무조건·60s 틱). 연결 드롭으로
        // grace 유예된 구독자가 재연결 없이 TTL 초과하면 left 로 이탈 확정(reconcile 관측).
        // grace 구독자 없으면 세션당 비용 0(no-op). fail-soft — 틱 실패가 데몬 안 죽인다.
        try {
          const { sweepSessionPresence } = await import('../session/index.js');
          presenceSweepHandle = setInterval(() => {
            try {
              const evicted = sweepSessionPresence();
              if (evicted > 0) console.debug(`[nexus] presence sweep: ${evicted} grace subscriber(s) evicted`);
            } catch (err) { console.warn(`[nexus] presence sweep tick failed: ${(err as Error).message}`); }
          }, 60_000);
          if (typeof (presenceSweepHandle as { unref?: () => void }).unref === 'function') {
            (presenceSweepHandle as { unref: () => void }).unref();
          }
        } catch (err) {
          console.warn(`[nexus] presence sweeper wiring failed: ${(err as Error).message}`);
        }

        // ★ UR4b 조율자 상주 thread-awareness sweep (opt-in·autopilot.threadRegistry·기본 OFF·2026-07-19)
        //   — 데몬 상주 루프가 활성 미션 thread 를 주기적으로 인지: 스톨(replan/escalate)·pending goto·고아
        //   감지 → 관측(mission.registry). 데몬이 thread 를 관장(Option B)하는 상주 인지 심장박동. read-only·
        //   fail-soft(틱 실패가 데몬 안 죽인다)·.unref(무차단). 게이트 OFF 면 타이머 미설치(회귀 0).
        try {
          const { getUserConfig } = await import('../user-config.js');
          const ap = getUserConfig().raw?.autopilot as { threadRegistry?: unknown; coordinatorGovern?: unknown; coordinatorPush?: unknown } | undefined;
          const threadRegistryOn = ap?.threadRegistry === true;
          // ★ UR4c 능동 관장 게이트(opt-in·기본 OFF) — ON 이면 sweep 이 감지한 stuck/pending-goto 를 데몬이
          //   능동 수복(run-mission 재spawn·run-lock 가드). OFF 면 observe-only sweep(UR4b). threadRegistry 전제.
          const governOn = threadRegistryOn && ap?.coordinatorGovern === true;
          // ★ UR4d 저지연 push 게이트(opt-in·기본 OFF) — ON 이면 logs.db worker 활동을 edge-trigger 로 감지해
          //   sweep/govern 을 즉시(coalesced) 깨운다. interval 은 안전망(truth)으로 유지. threadRegistry 전제.
          const pushOn = threadRegistryOn && ap?.coordinatorPush === true;
          if (threadRegistryOn) {
            const { sweepMissionThreads, governMissionThreads } = await import('../autopilot/pipeline/mission-thread-registry.js');
            const { defaultSpawnRunMission } = await import('../autopilot/mission-engine.js');
            // interval(안전망)·push(edge) 둘 다 부르는 단일 틱 — trigger 만 다르다.
            const runThreadTick = (trigger: 'interval' | 'push'): void => {
              try {
                const s = governOn
                  ? governMissionThreads({ spawnRun: defaultSpawnRunMission })  // 능동: stuck/goto → 재spawn(수복)
                  : sweepMissionThreads();                                        // 관측만
                const resumed = (s as { resumed?: string[] }).resumed?.length ?? 0;
                if (s.stuckCount > 0 || s.stalledCount > 0 || s.pendingCursorCount > 0 || resumed > 0) {
                  console.debug(`[nexus] thread ${governOn ? 'govern' : 'sweep'} (${trigger}): ${s.activeCount} active · ${s.stuckCount} stuck/dead · ${s.stalledCount} stalled · ${s.pendingCursorCount} pending-goto${governOn ? ` · ${resumed} resumed` : ''}`);
                }
              } catch (err) { console.warn(`[nexus] thread registry ${governOn ? 'govern' : 'sweep'} tick failed: ${(err as Error).message}`); }
            };
            const threadSweepHandle = setInterval(() => runThreadTick('interval'), 180_000);
            if (typeof (threadSweepHandle as { unref?: () => void }).unref === 'function') {
              (threadSweepHandle as { unref: () => void }).unref();
            }
            console.log(`[nexus] 조율자 상주 thread ${governOn ? '능동 관장(govern·stuck/goto 재spawn)' : 'awareness sweep'} 활성(autopilot.${governOn ? 'coordinatorGovern' : 'threadRegistry'}·3분)`);
            // ★ UR4d — 저지연 push watcher 부착(edge-trigger → 같은 틱). interval 은 안전망으로 남는다.
            if (pushOn) {
              const { watchMissionActivity } = await import('../autopilot/pipeline/mission-thread-push.js');
              coordinatorPushWatcher = watchMissionActivity({ onWake: () => runThreadTick('push') });
              console.log(`[nexus] 조율자 저지연 push 레이어 활성(autopilot.coordinatorPush·logs.db tail edge-trigger·폴링 truth 유지)`);
            }
          }
        } catch (err) {
          console.warn(`[nexus] thread registry sweeper wiring failed: ${(err as Error).message}`);
        }

        // V2.2-3 (2026-05-12) — wire a NEXUS-hosted Discord bot that
        // forwards inbound messages to `workflowDaemon.dispatchDiscord`
        // so `discordTrigger` nodes fire from real traffic. Skipped
        // when `cfg.discord.enabled` is false or the bot token isn't
        // set. The HITL Discord bot (token = ELANOUS_DISCORD_HITL_*) is
        // a separate Discord application; the trigger bot resolves the
        // main credential via tokenRef, env, then legacy plaintext.
        try {
          const userConfigMod = await import('../user-config.js');
          const cfg = userConfigMod.getUserConfig();
          const discordToken = resolveChannelBotToken('discord', cfg)?.token;
          if (cfg.discord.enabled && discordToken && !isAutonomousRunContext()) {
            // M4b (2026-07-12) — the production discord bot answers DMs
            // with the elanous self turn + /cc·/cdx·/gem interweaving
            // (텔레그램 동형·대표 확정: 기본 self·명시 위임). The
            // DM-only gate keeps guild traffic out; the isolated
            // `elanous discord-test` runner owns discord.testChannel.
            const { makeDiscordAgentRunTurn } = await import('../discord-agent.js');
            const { buildDiscordSelfOnMessage } = await import('../discord-self-message.js');
            const { buildDiscordVoiceWire } = await import('../discord-voice-wire.js');
            const getBotRef: { current: import('../discord.js').DiscordBot | null } = { current: null };
            const runTurnImpl = makeDiscordAgentRunTurn(cfg);
            // C1 (2026-07-12) — 위임 턴 QUESTION을 버튼으로 표면화.
            const { createDiscordQuestionRuntime } = await import('../discord-question-channel.js');
            const questionRuntime = createDiscordQuestionRuntime({ getBot: () => getBotRef.current });
            const selfOnMessage = buildDiscordSelfOnMessage({
              userConfig: cfg,
              runTurnImpl,
              getBot: () => getBotRef.current,
              questionChannelFor: (ch) => questionRuntime.channelFor(ch),
            });
            // M4c — voice channel wire. Inert (voiceTap null + /voice-*
            // replies explain the gate) unless ELANOUS_DISCORD_VOICE_CHANNEL
            // / voice.discord.voiceChannel.enabled is on. Shares the SAME
            // runTurnImpl as the DM text path.
            const voiceWire = buildDiscordVoiceWire({
              userConfig: cfg,
              runTurnImpl,
              getBot: () => getBotRef.current,
            });
            // DEC-TG(대표 10-02) — decision cards in the owner's Discord DM. Filled once the bot exists (below).
            let decisionWire: import('../decisions/discord-decision-cards.js').DiscordDecisionWire | null = null;
            const composedOnMessage = async (
              ctx: import('../discord.js').DcIncoming,
              streamer?: import('../discord.js').DcMessageStreamer,
            ): Promise<string | void> => {
              if (decisionWire && ctx.text.trim() === '/decisions') {
                const { discordDecisionsCommand } = await import('../decisions/discord-decision-cards.js');
                return discordDecisionsCommand(decisionWire.service, ctx);
              }
              const voiceReply = await voiceWire.dispatchVoiceCommand(ctx);
              if (voiceReply !== null) return voiceReply;
              return selfOnMessage(ctx, streamer as never);
            };
            // C3 (2026-07-12) — 네이티브 슬래시: /cc·/fork·/voice-join
            // 자동완성. 인터랙션을 텍스트 명령으로 합성해 같은 파이프라인.
            const { buildDiscordSlashWire } = await import('../discord-slash-wire.js');
            const slashWire = buildDiscordSlashWire({
              userConfig: cfg,
              handleMessage: composedOnMessage,
              getBot: () => getBotRef.current,
              allowedUsers: [...cfg.discord.allowedUsers],
            });
            const chatChannels = cfg.discord.chatChannels ?? [];
            debug.log('nexus.discord', 'chat-channels', { count: chatChannels.length });
            const handle = createNexusDiscordTriggerBot({
              token: discordToken,
              allowedUsers: [...cfg.discord.allowedUsers],
              ...(chatChannels.length ? { guildTextChannels: chatChannels } : {}),
              dispatch: (event) => workflowDaemon!.dispatchDiscord(event),
              onMessage: composedOnMessage,
              onInteraction: async (raw) => {
                // DEC-TG 결정 카드(dec:/decmemo:) → C1 버튼 탭(elanous-q: 소비) → 아니면 C3 슬래시.
                if (decisionWire && await decisionWire.onInteraction(raw)) return;
                if (await questionRuntime.handleComponentInteraction(raw)) return;
                await slashWire.onInteraction(raw);
              },
              ...(voiceWire.voiceTap ? { voiceTap: voiceWire.voiceTap } : {}),
            });
            if (handle) {
              getBotRef.current = handle.bot;
              workflowDiscordBot = handle;
              if ((cfg.raw?.decisions as { cards?: unknown } | undefined)?.cards !== false) {
                try {
                  const { attachDiscordDecisionCards } = await import('../decisions/discord-decision-cards.js');
                  decisionWire = attachDiscordDecisionCards(handle.bot, cfg);
                } catch (err) {
                  console.warn(`[nexus] decision cards (discord) not attached: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              void slashWire.registerCommands().catch((err: unknown) => {
                console.warn(`[nexus] slash registration failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }
          // V2.2-4 (2026-05-12) — parallel Telegram wire. Uses the
          // resolved main token alongside the existing allowedUsers.
          // 2026-07-05 — unified inbound: pass `userConfig` so the ONE
          // nexus telegram bot answers Q&A (onMessage → runTurn) on top
          // of firing workflow triggers. A separate Q&A poller would 409
          // against this one (single getUpdates consumer per token).
          const telegramToken = resolveChannelBotToken('telegram', cfg)?.token;
          if (cfg.telegram.enabled && telegramToken && !isAutonomousRunContext()) {
            // T1 (2026-07-05) — give the Q&A bot the full agent tool surface;
            // A0 folds in the finance analyst orientation only when
            // cfg.finance.enabled (optional domain pack).
            //
            // ★ 멀티 채널(2026-07-09 대표 지시): resolveTelegramChannels 로 채널 목록을
            //   얻고, interactivePollerTokens 로 **봇 토큰당 폴러 1개**만 띄운다(토큰별
            //   dedup → 409 자기충돌 원천차단). 각 폴러엔 채널 토큰을 명시로
            //   넘겨 **올바른 토큰을 폴링**하게 한다(오늘 토큰 버그 정타).
            //   interactive:false(noti-only) 채널은 폴러 없이 발송 전용.
            const { makeTelegramAgentRunTurn } = await import('../telegram-agent.js');
            const { resolveTelegramChannels, interactivePollerTokens } = await import('../domains/telegram-channels.js');
            const { tryAcquireTelegramPollLock, acquireTelegramPollLock } = await import('../telegram-poll-lock.js');
            const adopt = ({ channel, handle }: NexusTelegramQaPollerWireHandle): void => {
              telegramPollerHandles.push(handle);
              if (channel.botToken === telegramToken) workflowTelegramBot = handle;
              console.log(`[nexus] telegram 채널 '${channel.name}' Q&A 폴러 활성 (roles ${channel.roles.join('/')})`);
            };
            if (cfg.telegram.poller === 'standalone') {
              // 폴링은 `elanous telegram run` 이 맡는다 — 넥서스는 보내기만 한다. 배달 싱크는 «프로세스 안» 등록이라
              // 여기서도 폴링 없는 봇으로 세워 둔다(없으면 core 에서 시작한 턴이 텔레그램 구독자에게 못 간다).
              debug.log('nexus.telegram', 'poller-skipped', { reason: 'telegram.poller=standalone' });
              const sendOnly = wireNexusTelegramQaPollers(cfg, workflowDaemon!, {
                makeTelegramAgentRunTurn,
                resolveTelegramChannels,
                interactivePollerTokens,
                createTriggerBot: (opts) => createNexusTelegramTriggerBot({ ...opts, poll: false }),
              });
              for (const { channel, handle } of sendOnly) {
                telegramPollerHandles.push(handle);
                if (channel.botToken === telegramToken) workflowTelegramBot = handle;
              }
              console.log(`[nexus] telegram Q&A 폴러를 띄우지 않는다 (telegram.poller=standalone — elanous telegram run 이 폴링) · 보내기 전용 싱크 ${sendOnly.length}개`);
            } else {
              const handles = wireNexusTelegramQaPollers(cfg, workflowDaemon!, {
                makeTelegramAgentRunTurn,
                resolveTelegramChannels,
                interactivePollerTokens,
                createTriggerBot: createNexusTelegramTriggerBot,
                pollLock: {
                  tryAcquire: (token) => tryAcquireTelegramPollLock(token, 'nexus'),
                  acquire: (token) => acquireTelegramPollLock(token, 'nexus'),
                },
                onLateStart: adopt,
              });
              for (const wired of handles) adopt(wired);
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[nexus] trigger bot boot skipped: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] workflow daemon boot skipped: ${msg}`);
    }

    // W7-후속 (2026-05-12) — Outbound substrate boot. Builds the
    // OutboundRouter + iOS push channel + token store from user-config
    // `notifications.apns.*`. The token store is passed to the http
    // server so `/v1/devices/tokens` POST/DELETE/GET goes live (PWA +
    // future iOS app register their push tokens through that endpoint).
    // The router + channels stay in scope here — future intent-prediction
    // push + showroom outbound dispatch will route through them. Errors
    // (missing .p8 / unreadable PEM) surface as `apnsBootSkippedReason`
    // and never crash boot — the channel still registers with no
    // transport, so attempted sends return `transport-not-configured`.
    let outboundSubstrate: OutboundSubstrate | undefined;
    try {
      const userConfigMod = await import('../user-config.js');
      const cfg = userConfigMod.getUserConfig();
      outboundSubstrate = buildOutboundSubstrate({
        ...(cfg.notifications?.apns ? { apnsConfig: cfg.notifications.apns } : {}),
      });
      if (outboundSubstrate.apnsBootSkippedReason) {
        // Surface to console at startup so a misconfigured APNs setup
        // isn't silently absorbed. Not fatal.
        console.warn(`[nexus] apns transport skipped: ${outboundSubstrate.apnsBootSkippedReason}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] outbound substrate boot skipped: ${msg}`);
    }

    // B 트랙 Phase 2 (RFC-elanous-mcp-client-2026-05-12 · #2474) —
    // Spawn each configured external MCP server (xcrun mcpbridge ·
    // xcodebuildmcp · …) and register its tools as proxy ToolRuntimes
    // under `<server-id>.<tool-name>`. Sparse — empty `mcp.servers[]`
    // is a no-op. Per-server failures never block NEXUS boot.
    // Master switch precedence (PR1 #2532 · 2026-05-13):
    //   CLI flag (`--no-mcp` → opts.mcpEnabled === false)
    //   > user-config (`mcp.enabled: false`)
    //   > default true
    //
    // PR2 (C · #2533 · 2026-05-13) — when enabled, MCP boot is
    // fire-and-forget. Daemon listen (`startNexusHttpServer`,
    // line ~1601) used to wait for every MCP `start()` +
    // `listTools()` (8s timeout each, see #2527). Now we detach:
    // the handle resolves in the background, tools register into
    // `tool-runtime/registry` as they arrive, and the HTTP server
    // is bound long before the user finishes their first /v1/health
    // probe. wrappedRelease awaits the promise (with a small grace
    // window in case the boot is still in flight at SIGINT time) so
    // child processes don't orphan.
    try {
      const getMcpUserConfig = opts.getMcpUserConfigForTesting
        ?? (await import('../user-config.js')).getUserConfig;
      const cfg = getMcpUserConfig();
      const cliOff = opts.mcpEnabled === false;
      const cfgOff = cfg.mcp?.enabled === false;
      if (cliOff || cfgOff) {
        console.log(`[nexus] mcp-clients disabled by ${cliOff ? '--no-mcp' : 'user-config mcp.enabled:false'} — no external servers spawned`);
      } else {
        const servers = cfg.mcp?.servers ?? [];
        mcpClientsBootPromise = (async () => {
          try {
            const register = opts.registerMcpClientsFn ?? registerMcpClients;
            const handle = await register({
              servers,
              handshakeTimeoutMs: cfg.mcp?.handshakeTimeoutMs,
            });
            mcpClientsHandle = handle;
            return handle;
          } catch (innerErr: unknown) {
            const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
            console.warn(`[nexus] mcp-clients boot failed (background): ${innerMsg}`);
            return undefined;
          }
        })();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] mcp-clients boot skipped: ${msg}`);
    }

    // W9d-FU U5 — Patcher daemon boot. Reads
    // `~/.elanous/background-reasoning/patcher.yaml` · disabled by default
    // so a fresh install does not auto-fire LLM calls. When user flips
    // `enabled: true`, the LLM callable wire (entityExtractor +
    // embeddingGenerator) is still required — without it the substrate
    // logs `patcher-llm-deps-missing` and stays inactive. Real callable
    // wire is a follow-up keyed off the user-config model registry.
    try {
      // W9e-FU U5 — resolve LLM callables from user-config
      // `background-reasoning.llm.*`. When the user has not configured a
      // model endpoint, this returns undefined and `buildPatcherSubstrate`
      // surfaces `patcher-llm-deps-missing` (dormant daemon). When set,
      // the fetch-based callables run against the OpenAI-compatible
      // endpoint (LM-Studio / Ollama / cloud).
      const userConfigMod = await import('../user-config.js');
      const cfg = userConfigMod.getUserConfig();
      const patcherLlm = resolvePatcherLlmCallables(cfg.backgroundReasoning?.llm);
      patcherSubstrateHandle = buildPatcherSubstrate({
        ...(patcherLlm ? {
          entityExtractorCallable: patcherLlm.entityExtractorCallable,
          embeddingCallable: patcherLlm.embeddingCallable,
        } : {}),
      });
      if (patcherSubstrateHandle.skipReason) {
        console.warn(`[nexus] patcher daemon skipped (${patcherSubstrateHandle.skipReason}): ${patcherSubstrateHandle.detail ?? ''}`);
      } else {
        console.info('[nexus] patcher daemon started · self-improving loop active');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] patcher substrate boot skipped: ${msg}`);
    }

    // W9d-FU Z15.b — Devices fleet cron. Reads `~/.elanous/devices.json`
    // periodically, runs the upgrade watcher, and (when the outbound
    // router is wired) emits an `OutboundEvent` per significant change.
    // No user-config gate yet — defaults to enabled so a freshly
    // installed iOS Companion's first sync auto-surfaces. A future
    // `devices.cron.enabled = false` user-config flag will gate this
    // off; today the only flag is the source's missing-file path
    // (returns empty fleet → no-change tick → no router call).
    try {
      if (setupPlan.skipCrons.includes('devices')) {
        debug.log('nexus.boot', 'setup-mode-skip-cron', { cron: 'devices' });
      } else {
        devicesSubstrateHandle = buildDevicesSubstrate({
          ...(outboundSubstrate?.router ? { router: outboundSubstrate.router } : {}),
        });
        if (devicesSubstrateHandle.skipReason) {
          console.warn(`[nexus] devices cron skipped (${devicesSubstrateHandle.skipReason}): ${devicesSubstrateHandle.detail ?? ''}`);
        } else {
          console.info('[nexus] devices fleet cron started');
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] devices substrate boot skipped: ${msg}`);
    }

    // G2 (2026-05-12) — intent-prediction tick → router.route bridge.
    // Wires when BOTH `runtimeIntentPrediction` (line ~681) and
    // `outboundSubstrate.router` exist. The bridge subscribes to
    // `service.onRanking(...)`, converts each ranking via F1's
    // `buildOutboundEventFromRanking`, and routes via `router.route()`.
    // Fire-and-forget — router failures are silently absorbed (the
    // tick scheduler keeps emitting so subsequent rankings get
    // another shot). γ-light dogfood: with no APNs cert + iOS app,
    // the router falls through ios-push (no tokens · unavailable)
    // and lands on web-push (PWA subscribers).
    if (runtimeIntentPrediction && outboundSubstrate?.router) {
      try {
        intentPredictionRouterBridge = wireIntentPredictionToRouter({
          service: runtimeIntentPrediction,
          router: outboundSubstrate.router,
          onError: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            // Bridge errors only surface here when the F1 builder
            // throws (malformed IntentRanking) or the router promise
            // rejects unexpectedly. Router-internal channel failures
            // are absorbed by the router itself (see OutboundRouter.send).
            console.warn(`[nexus] intent-prediction.router-bridge.error: ${msg}`);
          },
        });
        console.info('[nexus] intent-prediction → outbound router bridge wired');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[nexus] intent-prediction router bridge skipped: ${msg}`);
      }
    }

    try {
      const cleanGhost = opts.cleanGhostTailscaleServeFn
        ?? ((port: number) => cleanGhostTailscaleServe({ port }));
      await cleanGhost(httpStartPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nexus] tailscale serve ghost cleanup skipped: ${msg}`);
    }

    const startHttpServer = opts.startNexusHttpServerFn ?? startNexusHttpServer;
    const mcpUserConfig = (opts.getMcpUserConfigForTesting ?? getUserConfig)();
    const configuredWidgetServerId = mcpUserConfig.mcp?.widgetServerId;
    const knownMcpServerIds = new Set((mcpUserConfig.mcp?.servers ?? []).map((server) => server.id));
    let getMcpWidgetServerId: ((req: Request) => string | undefined) | undefined;
    if (configuredWidgetServerId) {
      if (knownMcpServerIds.has(configuredWidgetServerId)) {
        getMcpWidgetServerId = () => configuredWidgetServerId;
      } else {
        debug.log('mcp.widget', 'unknown-widget-server-id', {
          serverId: configuredWidgetServerId,
          knownIds: [...knownMcpServerIds],
        });
      }
    }
    const readyServerIds = mcpClientsHandle
      ? Object.entries(mcpClientsHandle.perServer)
          .filter(([, server]) => server.status === 'ready')
          .map(([serverId]) => serverId)
      : [];
    const readyCount = readyServerIds.length;
    debug.log('mcp.widget', 'server-binding', {
      source: getMcpWidgetServerId ? 'config' : readyCount === 1 ? 'sole-ready' : 'none',
      serverId: getMcpWidgetServerId
        ? configuredWidgetServerId
        : readyCount === 1 ? readyServerIds[0] : undefined,
      readyCount,
    });
    // TERM1 ④ — the first web-terminal spawn used to pay the login-shell env capture (spawnSync · ~3 s with the
    // daemon frozen) and the terminal module import (~0.9 s). Warm both off the event loop shortly after boot.
    if (!opts.startNexusHttpServerFn) {
      const warm = setTimeout(() => {
        void import('../shell-env-bootstrap.js').then(({ warmCapturedEnv }) => warmCapturedEnv()).catch(() => undefined);
        void import('../web-terminal/preview-tap-registry.js').then(() => import('../preview/terminal.js')).catch(() => undefined);
      }, 1_500);
      (warm as { unref?: () => void }).unref?.();
    }
    httpServer = startHttpServer({
      state,
      registry,
      eventBus,
      setup: { mode: nexusSetup.setupMode, missing: nexusSetup.setupMissing },
      ...(supervisor ? { supervisor } : {}),
      ...(outboundSubstrate ? { outboundTokens: { tokenStore: outboundSubstrate.tokenStore } } : {}),
      ...(opts.httpStartPort !== undefined ? { startPort: opts.httpStartPort } : {}),
      ...(leasePortFromLauncher !== undefined ? { portRange: 1 } : {}),
      ...(opts.httpHost !== undefined ? { hostname: opts.httpHost } : {}),
      editInPwa: editInPwaCtx,
      ...(wsBridgeOpts ? { wsBridge: wsBridgeOpts } : {}),
      ...(metaApiOpts ? { metaApi: metaApiOpts } : {}),
      getMcpClients: () => mcpClientsHandle,
      reloadMcpClients,
      ...(getMcpWidgetServerId ? { getMcpWidgetServerId } : {}),
      ...(pwaStaticDir ? { staticDir: pwaStaticDir } : {}),
      ...(runtimeIntentPrediction ? { intentPrediction: runtimeIntentPrediction } : {}),
      // next-fluent(태스크 완료 → 다음 액션 1-클릭 칩·2026-07-15) — mission-fabric-aware source +
      // 항상 켜진 라우트(기본 ON). personas 만 선택 사항이며, route 는 503(not-wired) 안 냄.
      nextFluent: buildNextFluentRouteOpts(),
      // iPhone Showroom Phase 1 P1-4 (2026-05-14) + FU1 (2026-05-14) —
      // mission router DI seam. Pass a configProvider thunk so user
      // config edits (`elanous config mission set …`) take effect on
      // the next predict() without a daemon restart. The thunk uses
      // Path A's `getUserConfig()` (mtime-cached read) so the per-
      // call overhead is just an object lookup, not a file IO.
      missionRouter: globalMissionRouter(() => getUserConfig().llm.missionRouting),
      // R-OCR.1.4 follow-up — wire the production polish callable when
      // a vision-capable LLM is available. Missing capability →
      // notesFromImage runs with `polish` undefined and the handler
      // silently degrades enrich requests to minimal raw OCR
      // (usedLlmPolish:false, surfaced in the PWA modal's truth-in-
      // metadata banner).
      notesFromImage: {
        registry: ocrRegistry,
        metrics: notesMetrics,
        ...(isVisionPolishAvailable() ? { polish: createNotesPolishCallable() } : {}),
      },
      // R-OCR follow-up (2026-05-09) — batch sibling shares the same
      // registry + polish + metrics so per-image counts contribute to
      // the same NotesMetricsCard snapshot. Cap kept at the default 8
      // (handler fallback) — a future Settings flag can override.
      notesFromImages: {
        registry: ocrRegistry,
        metrics: notesMetrics,
        ...(isVisionPolishAvailable() ? { polish: createNotesPolishCallable() } : {}),
      },
      notesSave: { vault: notesVault, metrics: notesMetrics },
      // PR Y2 (PLAN §5 popup synergy follow-up · 2026-05-17) — wire
      // image-generate with same vault + OPENAI_API_KEY env reader.
      // openaiApiKey returns nil when env missing → endpoint returns
      // 503 with `openai_key_missing` reason so iOS surfaces a clear
      // "set OPENAI_API_KEY" banner.
      imageGenerate: {
        vault: notesVault,
        openaiApiKey: () => process.env.OPENAI_API_KEY,
      },
      notesMetrics: { metrics: notesMetrics },
      // W9e-FU Z13-d (2026-05-12) — devices fleet source forward. When
      // the devices boot composer (#2458) ran successfully it exposes
      // a `DeviceFleetSource` that reads `~/.elanous/devices.json` (or
      // returns `[]` on missing file). Passing it to opts.devices means
      // `/v1/devices` and `/v1/templates/capability-preview` serve the
      // live fleet snapshot instead of the 503 `devices-not-wired`
      // envelope. Cron-disabled boot (`cronEnabled: false`) still
      // populates `source` so the http endpoints stay live.
      ...(devicesSubstrateHandle ? { devices: { fleetSource: devicesSubstrateHandle.source } } : {}),
      // cascade-zyu W8-A 옵션 A (2026-05-14) — POST /v1/missions/test
      // mock emitter for the iOS Companion shell "Test Mission" button.
      // Broadcaster is resolved lazily per-request via
      // `getActiveAcpFeedbackBroadcaster()` so the wire reflects the
      // currently-active ACP peer (multi-connection daemon). Returns 503
      // when no ACP peer is up (broadcaster=null).
      missionsTest: {
        get broadcastToSession() {
          return getActiveAcpFeedbackBroadcaster();
        },
      },
      // R5.0 — share the same `history` instance the rest of the
      // session API consumes. When skipRuntime is true (no metaApi)
      // the field stays undefined and the endpoint returns 503.
      ...(runtimeHistory ? { sessionsActive: { history: runtimeHistory } } : {}),
      // R5.4 — fan card-deck decisions through the global bus so SSE
      // subscribers + future ACP forward adapter react without polling.
      sessionsDecision: { eventBus },
      // R6.2 — daily reflection shares the same notesMetrics + history
      // singletons; the snapshot is built on demand from the live
      // collectors so no separate persistence is needed in v1.
      reflection: {
        metrics: notesMetrics,
        ...(runtimeHistory ? { history: runtimeHistory } : {}),
      },
      // R3 v2 (2026-05-09) — push notification action click → ACP
      // loopback. Reuses the same `runTurn` instance the ACP server is
      // bound to (single source of truth for history persistence + tool
      // surface). The handler fires it fire-and-forget after recording
      // the intent feedback; the agent's response surfaces via
      // notifyAgentTurnEnd's web-push fan-out, not via the dropped
      // synthetic AcpTurnContext push callbacks.
      ...(runtimeRunTurn
        ? {
            notificationActionLoopback: createNotificationActionLoopback({
              runTurn: runtimeRunTurn,
              ...(runtimeToolCwd ? { cwd: runtimeToolCwd } : {}),
            }),
          }
        : {}),
      ...(workflowDaemon
        ? {
            workflowDaemon: {
              dispatchWebhook: (req) => workflowDaemon!.dispatchWebhook(req),
              dispatchChat: (req) => workflowDaemon!.dispatchChat(req),
              dispatchTelegram: (event) => workflowDaemon!.dispatchTelegram(event),
              chatConfig: (name) => workflowDaemon!.chatConfig(name),
            },
          }
        : {}),
    });

    // R5 follow-up (2026-05-09) — wire the session-decision → ACP
    // forward subscriber. Reuses the same NotificationActionLoopback
    // factory the R3 v2 handler uses (synthetic AcpTurnContext + the
    // production runTurn) so behaviour is uniform across action click
    // and card-deck swipe. Only forwards approve/expand; reject/pause
    // stay record-only on the bus.
    if (runtimeRunTurn) {
      sessionDecisionForward = startSessionDecisionForward({
        bus: eventBus,
        loopback: createNotificationActionLoopback({
          runTurn: runtimeRunTurn,
          ...(runtimeToolCwd ? { cwd: runtimeToolCwd } : {}),
        }),
      });
    }
    // Patch audience + origin to the actual resolved port (auto-pick may
    // have moved us off startPort).
    editInPwaCtx.audience = `${httpServer.hostname}:${httpServer.port}`;
    editInPwaCtx.nexusOrigin = httpServer.url;
    if (leasePortFromLauncher !== undefined && httpServer.port !== leasePortFromLauncher) {
      httpServer.stop();
      await stopCoordinatorLease?.();
      release();
      throw new Error('coordinator port lease boot mismatch');
    }
    runtime.httpPort = httpServer.port;
    runtime.httpHost = httpServer.hostname;
    runtime.httpAuth = metaApiOpts && !metaApiOpts.noAuth ? 'on' : 'off';
    // The actual bound port (not the requested port or registry entry) is the member endpoint.
    try {
      const configured = (getUserConfig().raw?.nexus as { primary?: unknown } | undefined)?.primary;
      const { url: coordinatorUrl, token } = resolvePrimary({
        role: 'member',
        ...(configured === undefined || configured === '' ? {} : { config: { url: configured as string } }),
      });
      if (!token) {
        try { debug.log('control.member', 'start-skipped', { reason: 'member-token-missing' }); } catch { /* fail-soft */ }
      } else {
        const machine = nexusMemberMachine();
        stopMemberHeartbeat = startMemberHeartbeat({
          coordinatorUrl, token,
          machine,
          instance: {
            id: `instance:${machine.name}:${effectiveInstanceRoot()}`, name: 'nexus',
            endpoint: httpServer.url,
            attrs: { port: httpServer.port, pid: process.pid },
          },
        });
        try { debug.log('control.member', 'started', { machine: machine.id, coordinatorUrl }); } catch { /* fail-soft */ }
      }
    } catch {
      try { debug.log('control.member', 'start-skipped', { reason: 'member-configuration-invalid' }); } catch { /* fail-soft */ }
    }
    pwaRegistration.register({
      pid: process.pid,
      port: httpServer.port,
      mode: 'static',
      kind: resolveCurrentInstance().kind === 'test' ? 'test' : 'production',
      cwd: process.cwd(),
      daemonDir: nexusRootDir(),
      shareMounted: false,
      https: false,
      startedAt,
    });
    writeNexusRuntime(runtime);
    opts.onRuntimeSidecarWrite?.(runtime);

    // R6 v2 (2026-05-09) — daily reflection scheduler. Boots once per
    // daemon when the runtime is wired (skipRuntime=false leaves this
    // off so detached tests don't accrue background timers). Hour /
    // minute configurable via env (`ELANOUS_REFLECTION_HOUR` /
    // `_MINUTE`), default 21:00 local. The Hansei polish callable
    // gates on isDailyReflectionPolishAvailable — when no LLM
    // provider is reachable (fresh install · no API key), the
    // scheduler still fires the push with a deterministic counts-
    // only fallback body.
    if (!skipRuntime) {
      const envHour = Number.parseInt(process.env.ELANOUS_REFLECTION_HOUR ?? '', 10);
      const envMin = Number.parseInt(process.env.ELANOUS_REFLECTION_MINUTE ?? '', 10);
      dailyReflectionScheduler = startDailyReflectionScheduler({
        ...(Number.isFinite(envHour) ? { hour: envHour } : {}),
        ...(Number.isFinite(envMin) ? { minute: envMin } : {}),
        metrics: notesMetrics,
        ...(runtimeHistory ? { history: runtimeHistory } : {}),
        ...(isDailyReflectionPolishAvailable()
          ? { polish: createDailyReflectionPolishCallable() }
          : {}),
      });
      // FU A8 — boot the discovery cron alongside the reflection
      // scheduler. Dormant when env unset (zero CPU/network cost on
      // a fresh install).
      if (setupPlan.skipCrons.includes('discovery')) {
        debug.log('nexus.boot', 'setup-mode-skip-cron', { cron: 'discovery' });
      } else {
        discoveryCron = startDiscoveryCron();
      }
      // Mission Fabric 통합 U4d (2026-07-09) — schedule-runner 은퇴(B안 완성).
      // 모든 예약잡이 fabric Schedule Trigger(run_via='trigger')로 이관됨 →
      // 정시 발화=workflow 데몬, 놓친발화 복구=catchUpTriggerJobs(위 U4b). run_via=
      // 'elanous'(schedule-runner 발화)는 더 이상 생성 안 함(adopt→migrate 리다이렉트).
      // startScheduleRunner 은퇴(호출 안 함). defaultSpawnJob 는 catch-up 이 재사용.
      // (레거시 run_via='elanous' 잔재가 있으면 schedule list 에 보이나 미발화 →
      //  schedule migrate 로 이관.) 롤백: 아래 한 줄 복원.
      // try { scheduleRunner = startScheduleRunner(); } catch { /* fail-soft */ }
      void scheduleRunner; // 은퇴(undefined 유지)
    }
  }

  // PR γ' — error snapshot writer subscribes to tab.halt events. Snapshots
  // land at ~/.elanous/nexus/errors/<tabId>/<ts>.json and surface via
  // GET /v1/nexus/errors. Returns an unsubscribe used at shutdown.
  const unsubscribeErrorSnapshots = subscribeErrorSnapshotWriter({ state, registry, eventBus });

  pushEvent(state, { kind: 'nexus.boot', detail: { phase: NEXUS_PHASE, ...(httpServer ? { httpUrl: httpServer.url } : {}) } });

  if (supervisor) {
    // PR μ — env auto-migration: scan ELANOUS_* env, persist into UserConfig
    // / secrets, surface deprecation. Runs AFTER all default tabs are
    // registered so tab-scope migrations (channel-bot tokens) find the
    // matching tab ids.
    if (!opts.skipEnvMigration) {
      try {
        migrateLegacyEnvToConfig({ state, tabs: registry.list() });
      } catch { /* swallow — migration is best-effort */ }
    }

    // PR χ — restore-pending: if the previous nexus exited gracefully
    // (SIGTERM → exit 75), it left a snapshot of active tab ids. Re-spawn
    // them BEFORE the default-kind autostarts run so that subsequent
    // detection / managed.has guards converge on a single child per tab.
    // detachForTesting defaults skipRestoreFromPending=true to keep the
    // unit-test harness from depending on user-dir state.
    const skipRestore = opts.skipRestoreFromPending ?? !!opts.detachForTesting;
    if (!skipRestore) {
      try {
        await restoreFromPending({ state, registry, supervisor });
      } catch { /* swallow — boot continues without restore */ }
    }

    // C-2a (cleanup ROADMAP 2026-05-08): daemon auto-start block extracted
    // to `boot/register-daemon.ts`. Same external-lock check + supervisor
    // wiring, same ordering relative to restoreFromPending.
    tryAutoStartDaemon({
      state,
      registry,
      supervisor,
      registered: registerDaemon,
      opts: {
        ...(opts.autoStartDaemonTab !== undefined ? { autoStartDaemonTab: opts.autoStartDaemonTab } : {}),
        ...(opts.detachForTesting !== undefined ? { detachForTesting: opts.detachForTesting } : {}),
        ...(setupPlan.skipTabKinds.includes('daemon') ? { autoStartDaemonTab: false } : {}),
      },
    });

    // C-2b (cleanup ROADMAP 2026-05-08): pwa-host auto-start block extracted
    // to `boot/register-pwa-host.ts`.
    tryAutoStartPwaHost({
      supervisor,
      registered: registerPwaHost,
      opts: {
        ...(opts.autoStartPwaHostTab !== undefined ? { autoStartPwaHostTab: opts.autoStartPwaHostTab } : {}),
        ...(opts.detachForTesting !== undefined ? { detachForTesting: opts.detachForTesting } : {}),
      },
    });

    // C-2d (cleanup ROADMAP 2026-05-08): channel-bot auto-start block
    // extracted to `boot/register-channel-bots.ts`.
    tryAutoStartChannelBots({
      state,
      registry,
      supervisor,
      registered: registeredChannelBotIds,
      opts: {
        ...(opts.autoStartChannelBots !== undefined ? { autoStartChannelBots: opts.autoStartChannelBots } : {}),
        ...(opts.detachForTesting !== undefined ? { detachForTesting: opts.detachForTesting } : {}),
        ...(setupPlan.skipTabKinds.includes('channel-bot') ? { autoStartChannelBots: false } : {}),
      },
    });

    // PR κ — template-driven startTab pass for spawn-able kinds. autoStart
    // defaults to !detachForTesting so production fires up the template's
    // daemon/pwa/bot entries, while tests register-only by default.
    if (templateApplied && templateTabs.length > 0) {
      const autoStart = !opts.detachForTesting;
      const sup = supervisor;
      void (async () => {
        for (const entry of templateTabs) {
          if (entry.start === false) continue;
          if (entry.kind !== 'daemon' && entry.kind !== 'pwa-host' && entry.kind !== 'channel-bot') continue;
          if (setupPlan.skipTabKinds.includes(entry.kind)) continue;
          if (!autoStart) continue;
          const id = entry.id ?? '';
          if (!id || !registry.has(id)) continue;
          try { await sup.startTab(id); } catch { /* swallow */ }
        }
      })();
    }
  }

  let shareCoordinatorTimer: ReturnType<typeof setInterval> | undefined;
  let shareCoordinatorStopped = false;
  let shareCoordinatorPending: Promise<void> | undefined;
  const wrappedRelease = (): void => {
    shareCoordinatorStopped = true;
    if (shareCoordinatorTimer) { clearInterval(shareCoordinatorTimer); shareCoordinatorTimer = undefined; }
    pushEvent(state, { kind: 'nexus.shutdown' });
    pwaRegistration.unregister();
    try { unsubscribeWebtermTabLifecycle(); } catch { /* swallow */ }
    try { unsubscribeErrorSnapshots(); } catch { /* swallow */ }
    if (supervisor) {
      void supervisor.shutdown({ graceMs: 0 });
    }
    // PLAN-nexus-shell-followup U1+U2 — miniTerm.destroy() 제거 (class trim).
    // PR k — drop pending HITL awaiters + signal ACP server shutdown so
    // its serve loop returns. ACP transport.close() is a no-op for the
    // deferred-transport adapter; the real cleanup is the
    // shutdownSignal abort which ends `runAcpServer`'s wait loop.
    runtimeHitlPending?.shutdown();
    // 2026-05-08 · stop the intent-prediction tick scheduler so
    // the daemon doesn't keep ranking after shutdown. Idempotent.
    // G2 (2026-05-12) · stop the router bridge BEFORE disposing the
    // service so the unsubscribe hits a live listener set (dispose()
    // clears all listeners anyway — order is defensive).
    if (intentPredictionRouterBridge) {
      try { intentPredictionRouterBridge.stop(); } catch { /* swallow */ }
    }
    if (runtimeIntentPrediction) {
      try { runtimeIntentPrediction.dispose(); } catch { /* swallow */ }
    }
    // R6 v2 (2026-05-09) · stop the daily-reflection scheduler so
    // the daemon doesn't keep firing the daily push after shutdown.
    // Idempotent — handle.stop() guards on already-stopped state.
    if (dailyReflectionScheduler) {
      try { dailyReflectionScheduler.stop(); } catch { /* swallow */ }
    }
    // FU A8 · stop the discovery cron so its setInterval handle
    // doesn't keep the event loop alive past graceful shutdown.
    if (discoveryCron) {
      try { discoveryCron.stop(); } catch { /* swallow */ }
    }
    // S2 (2026-07-07) · stop the schedule runner so its node-cron tasks +
    // reconcile interval don't keep firing/holding the loop past shutdown.
    if (scheduleRunner) {
      try { scheduleRunner.stop(); } catch { /* swallow */ }
    }
    // R5 follow-up (2026-05-09) · stop the session-decision forward
    // subscriber so the bus doesn't accrue dead listeners on restart.
    if (sessionDecisionForward) {
      try { sessionDecisionForward.stop(); } catch { /* swallow */ }
    }
    // β-1b · stop the Telegram HITL poll loop so the bot doesn't
    // keep hammering /getUpdates after shutdown. Idempotent — safe
    // when no token was configured (handle is undefined).
    if (runtimeTelegramHitl) {
      void runtimeTelegramHitl.stop().catch(() => { /* swallow */ });
    }
    // β-1c · stop the Discord gateway connection. Idempotent.
    if (runtimeDiscordHitl) {
      void runtimeDiscordHitl.stop().catch(() => { /* swallow */ });
    }
    // Surface-unification v2.1 FU-3 (2026-05-11) — stop the workflow
    // daemon. Idempotent · drains schedule cron timers, webhook router,
    // and chat router cleanly so reboot starts fresh.
    if (workflowDaemon) {
      void workflowDaemon.stop().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[nexus] workflow daemon stop failed: ${msg}`);
      });
    }
    // §5-③ — stop the continuation scheduler (idempotent · no-op when
    // dispatch was disabled and it was never constructed).
    if (continuationScheduler) {
      try { continuationScheduler.stop(); } catch (err) {
        console.warn(`[nexus] continuation scheduler stop failed: ${(err as Error).message}`);
      }
    }
    // R5 — stop the dig-goal armer poller (no-op when never armed).
    if (digArmerHandle) { clearInterval(digArmerHandle); digArmerHandle = undefined; }
    if (replayArmerHandle) { clearInterval(replayArmerHandle); replayArmerHandle = undefined; }
    // §P2 — stop the session presence grace sweeper.
    if (presenceSweepHandle) { clearInterval(presenceSweepHandle); presenceSweepHandle = undefined; }
    // ★ UR4d — stop the coordinator low-latency push watcher(logs.db tail + debounce).
    if (coordinatorPushWatcher) { try { coordinatorPushWatcher.stop(); } catch { /* ignore */ } coordinatorPushWatcher = undefined; }
    // Phase 2 (2026-05-13) — dispose the TOX boot handle. dispose()
    // stops the feedback loop + retry policy, tears down andon, and
    // resets runtime-deps so a subsequent NEXUS boot starts fresh.
    if (toxHandle) {
      try { toxHandle.dispose(); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[nexus] tox dispose failed: ${msg}`);
      }
    }
    if (toxStore) { try { toxStore.close(); } catch { /* shutdown best effort */ } toxStore = undefined; }
    // V2.2-3 (2026-05-12) — stop the workflow Discord trigger bot.
    if (workflowDiscordBot) {
      void workflowDiscordBot.stop().catch(() => { /* swallow */ });
    }
    // V2.2-4 (2026-05-12) — stop the workflow Telegram trigger bot.
    if (workflowTelegramBot) {
      void workflowTelegramBot.stop().catch(() => { /* swallow */ });
    }
    // 2026-05-08 follow-up · clear default confirm channels we
    // registered at boot so a subsequent runNexus (or test re-spawn)
    // starts from an empty registry instead of inheriting our channel.
    if (!opts.skipPushcutChannel) {
      try { registerDefaultConfirmChannels([]); } catch { /* swallow */ }
      // cv-3 β-4 — also tear down the audit hook so a fresh daemon
      // restart can re-install it (tests rely on this).
      try { registerHitlAuditHook(null); } catch { /* swallow */ }
    }
    try { registerDefaultQuestionChannels([]); } catch { /* swallow */ }
    if (
      installedDefaultAskResolver !== null
      && getAskUserQuestionResolver() === installedDefaultAskResolver
    ) {
      try { setAskUserQuestionResolver(null); } catch { /* swallow */ }
    }
    acpShutdown?.abort();
    // PR c — cancel any in-flight chat turns. Best-effort; ACP agent
    // teardown happens via the shutdownSignal abort above.
    for (const sess of chatSessions.values()) {
      void sess.cancel().catch(() => { /* swallow */ });
    }
    // PR d — destroy webterm sessions so each tab's PTY child + node-pty
    // FD are released before the lock drops.
    for (const sess of webtermSessions.values()) {
      try { sess.destroy(); } catch { /* swallow */ }
    }
    // ⭐P2 (capture substrate) — stop the manifest→ACP terminalFrame poller.
    try { stopTuiFrameBroadcaster?.(); } catch { /* swallow */ }
    try { stopFrameMemoryPoller?.(); } catch { /* swallow */ }
    // W9d-FU U5 — graceful shutdown of the Patcher daemon (removes
    // the bridge sink + clears the interval). Idempotent on null handle.
    stopPatcherSubstrate(patcherSubstrateHandle);
    // W9d-FU Z15.b — graceful shutdown of the devices fleet cron.
    stopDevicesSubstrate(devicesSubstrateHandle);
    // B 트랙 Phase 2 (#2474) — SIGTERM → grace → SIGKILL for every
    // spawned MCP-client child. Best-effort: a stuck dispose() does
    // not block the lock release.
    // PR2 (C · 2026-05-13) — MCP boot may still be in flight (fire-
    // and-forget). Settle the promise so we don't orphan the spawned
    // child(ren). 2s grace is plenty in practice — by the time the
    // user reaches SIGINT, MCP boot has either completed or hit one
    // of its per-server 8s timeouts (PR #2527). If the promise still
    // hasn't settled, we accept the orphan trade-off so the lock
    // release isn't stuck.
    const disposeMcp = async (): Promise<void> => {
      if (mcpClientsBootPromise) {
        const settled = await Promise.race([
          mcpClientsBootPromise.catch(() => undefined),
          new Promise<undefined>((resolve) => {
            const t = setTimeout(() => resolve(undefined), 2000);
            (t as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
        // Fall through whether settled (handle now assigned) or
        // timed-out (orphan trade-off accepted).
        if (settled === undefined && !mcpClientsHandle) return;
      }
      if (mcpClientsHandle) {
        try { await mcpClientsHandle.shutdown(); } catch { /* swallow */ }
      }
    };
    void disposeMcp().catch(() => { /* swallow */ });
    try { stopMemberHeartbeat?.(); } catch { /* best-effort shutdown */ }
    if (stopCoordinatorLease) {
      const stopLease = stopCoordinatorLease;
      stopCoordinatorLease = undefined;
      leaseReleasePending = stopLease().catch(error => debug.log('control.port-lease', 'release-failed', { port: leasePortFromLauncher, reason: String(error) }, { level: 'warn' }));
    }
    controlServer?.stop();
    httpServer?.stop();
    try { deleteNexusRuntime(); } catch { /* best-effort */ }
    release();
  };

  let autoMountedSharePort: number | undefined;
  const unmountAutoMountedShare = async (): Promise<void> => {
    const port = autoMountedSharePort;
    if (port === undefined) return;
    autoMountedSharePort = undefined;
    try {
      const pwaShareDisable = opts.pwaShareDisableFn
        ?? (await import('../cli/pwa-share.js')).pwaShareDisable;
      await pwaShareDisable({
        port,
        // Walk this daemon's Serve entry only — do not persist shareTailnet=disabled.
        saveSwitch: () => {},
        out: {
          log: () => {},
          error: (s) => console.error(`  share        ERR  ${s}`),
        },
      });
    } catch (err) {
      console.error(`  share        ERR  ${(err as Error).message}`);
    }
  };
  /** R1 — 텔레그램 트리거 봇의 대기 턴을 비운 «뒤» 다음 일을 한다. 상한은 봇 핸들이 지킨다
   *  (`TELEGRAM_TRIGGER_DRAIN_TIMEOUT_MS`) · 실패해도 종료는 계속된다. 관측 = `nexus.telegram.shutdown drained|drain-timeout`. */
  const drainTelegramThen = async (next: () => Promise<void>): Promise<void> => {
    const handles = new Set<NexusTelegramTriggerBotHandle>(telegramPollerHandles);
    if (workflowTelegramBot) handles.add(workflowTelegramBot);
    await Promise.all([...handles].map(async (handle) => {
      try { await handle.stop(); } catch { /* 종료는 계속 */ }
    }));
    await next();
  };

  const releaseWithShareUnmount = async (): Promise<void> => {
    shareCoordinatorStopped = true;
    if (shareCoordinatorTimer) { clearInterval(shareCoordinatorTimer); shareCoordinatorTimer = undefined; }
    await shareCoordinatorPending;
    try { await unmountAutoMountedShare(); }
    finally {
      wrappedRelease();
      await leaseReleasePending;
    }
  };

  const recordShareMount = (result: Awaited<ReturnType<NonNullable<RunNexusOptions['mountShareIfEnabledFn']>>>): void => {
    if (result.outcome === 'serving' && isCompleteTailnetUrl(result.url)) {
      runtime.tailnetUrl = result.url;
      runtime.tailnetRecordedAt = new Date().toISOString();
    } else {
      delete runtime.tailnetUrl;
      delete runtime.tailnetRecordedAt;
    }
    writeNexusRuntime(runtime);
    opts.onRuntimeSidecarWrite?.(runtime);
  };

  if (opts.detachForTesting) {
    return {
      release: wrappedRelease,
      state,
      registry,
      runtime,
      shell,
      eventBus,
      agentStatusStore,
      hudStore,
      ...(httpServer ? { httpServer } : {}),
      ...(supervisor ? { supervisor } : {}),
      ...(settingsController ? { settingsController } : {}),
      ...(runtimeHistory ? { history: runtimeHistory } : {}),
      ...(runtimeHitlPending ? { hitlPending: runtimeHitlPending } : {}),
      ...(runtimeIntentPrediction ? { intentPrediction: runtimeIntentPrediction } : {}),

      chatSessions,
      webtermSessions,
    };
  }

  printBootBanner(runtime, pwaStaticDir);
  if (runtime.httpPort && noAuth) {
    console.warn('  ⚠ NEXUS AUTH DISABLED (--no-auth / ELANOUS_NEXUS_NO_AUTH=1) — HTTP API and ACP websocket are unprotected.');
  }

  // P.3 — first-boot PWA share wizard. Only runs in interactive TUI mode
  // when the switch is still 'ask'. Headless / non-TTY boots skip it (the
  // user can still flip via `elanous nexus pwa share enable|disable` once
  // P.4 lands). detachForTesting boots return earlier so test fixtures
  // never hit this path.
  if (!opts.headless) {
    const setupStatus = checkSetupStatus({ argvBin: process.argv[1] ?? '' });
    const io = defaultIO();
    // Phase 4 (2026-05-19) — tailscale probe 결과 + PWA build 상태 + port
    // 를 first-boot wizard 에 전달해서 banner 가 PWA URL 을 표시하도록.
    const httpPort = httpServer?.port;
    const pwaBuilt = Boolean(pwaStaticDir);
    const tailscale = httpPort !== undefined ? await probeTailscale().catch(() => undefined) : undefined;
    try {
      await runFirstBootWizard({
        io,
        setupStatus,
        shouldRunTailscale: httpPort !== undefined && shouldAskPwaShareSwitch(),
        ...(httpPort !== undefined ? { httpPort } : {}),
        pwaBuilt,
        ...(tailscale ? { tailscale } : {}),
        runLlmStep: async (wizardIo) => {
          await runOnboardingStep('llm', { io: wizardIo });
        },
        runTailscaleWizard: async (wizardIo) => {
          if (httpPort === undefined) return;
          await runPwaShareWizardIfAsk({
            port: httpPort,
            pwaBuilt,
            argvBin: process.argv[1] ?? '',
            io: wizardIo,
          });
        },
      });
    } finally {
      io.close();
    }
  }

  // PWA share auto-mount — re-mounts `tailscale serve` against the live
  // HTTP port whenever the user has opted in via
  // `global.nexus.pwa.shareTailnet=enabled`. Headless daemons (launchd /
  // systemd / Docker / nohup) bypass runPwaStart.bringShareUp, so this
  // hook is the only mount path in those launch contexts. The deprecated
  // TUI fallback waits on the same signals and must record the port so
  // `releaseWithShareUnmount` can walk it. Caller can pass
  // `autoMountShare:false` to skip (bg-launch child re-execs do).
  let shareMounted = false;
  if (opts.autoMountShare !== false && runtime.httpPort) {
    const httpPort = runtime.httpPort;
    try {
      const mountShareIfEnabled = opts.mountShareIfEnabledFn
        ?? (await import('../cli/share-auto-mount.js')).mountShareIfEnabled;
      const reconcileShare = (): Promise<void> => {
        if (shareCoordinatorStopped || shareCoordinatorPending) return shareCoordinatorPending ?? Promise.resolve();
        const pending = (async (): Promise<void> => {
          try {
            const r = await mountShareIfEnabled({ httpPort });
            if (r.outcome === 'serving') {
              shareMounted = true;
              autoMountedSharePort = httpPort;
              recordShareMount(r);
              console.log(`  share        ON   ${r.url ?? '(tailnet host unknown)'}   (Tailscale Serve · auto-managed)`);
            } else if (r.outcome === 'failed') {
              console.log(`  share        ERR  serve exit ${r.serveExitCode ?? '?'} (likely sudo cache empty in bg-launch child)`);
              console.log('               recover with EITHER:');
              console.log('                 a) `sudo -v` once in a TTY, then `elanous nexus stop && elanous nexus run`');
              console.log('                 b) `elanous nexus pwa share enable` (parent-side mount · independent of daemon)');
            } else if (r.reason === 'tailscale-missing') {
              console.log('  share        OFF  Tailscale not installed — https://tailscale.com/download');
            } else if (r.reason === 'tailscale-down') {
              console.log('  share        OFF  Tailscale not active — start Tailscale, then `pwa share enable`');
            }
          } catch (err) {
            console.error(`  share        ERR  ${(err as Error).message}`);
          }
        })();
        shareCoordinatorPending = pending;
        void pending.then(() => { if (shareCoordinatorPending === pending) shareCoordinatorPending = undefined; });
        return pending;
      };
      await reconcileShare();
      shareCoordinatorTimer = setInterval(() => { void reconcileShare(); }, opts.shareCoordinatorIntervalMsForTesting ?? 60_000);
      shareCoordinatorTimer.unref?.();
    } catch (err) {
      console.error(`  share        ERR  ${(err as Error).message}`);
    }
  }
  if (shareMounted) {
    pwaRegistration.register({
      pid: process.pid,
      port: runtime.httpPort,
      mode: 'static',
      kind: resolveCurrentInstance().kind === 'test' ? 'test' : 'production',
      cwd: process.cwd(),
      daemonDir: nexusRootDir(),
      shareMounted: true,
      https: false,
      startedAt,
    });
  }

  // P.1.5 — headless branch. When `--headless` / `ELANOUS_NEXUS_HEADLESS=1`
  // is set, skip the TUI render loop entirely and block on SIGINT instead
  // of `tui.done`. The HTTP API + supervisor + meta-API stay live (they
  // were wired above the banner), so PWA + remote attach keep working —
  // only the developer-side TUI is suppressed. Required for launchd /
  // systemd-user / nohup / Docker (no controlling tty available).
  if (headless) {
    // PWA file-watch — when `runPwaStart` (or the user) requested
    // runtime auto-rebuild for static mode, spawn an fs.watch loop now.
    // The watcher closes on daemon shutdown via the watchHandle ref
    // captured in the SIGINT/SIGTERM cleanup below.
    let pwaWatchHandle: { stop: () => void } | null = null;
    if (opts.pwaWatch) {
      try {
        const { resolvePwaCwd } = await import('../cli/pwa-build.js');
        const pwaCwd = resolvePwaCwd(process.argv[1] ?? '');
        if (pwaCwd) {
          const { startPwaWatch } = await import('../cli/pwa-watch.js');
          pwaWatchHandle = startPwaWatch({ pwaCwd });
        } else {
          console.log('  watch: apps/pwa not found — file watch disabled.');
        }
      } catch (err) {
        console.error(`  watch: failed to start — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log('  elanous nexus: headless mode (TUI suppressed) — Ctrl-C / SIGTERM to exit.\n');
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => { resolveDone = r; });
    let sigtermExit: Promise<void> | undefined;
    const onSigterm = (): void => {
      console.error('\nelanous nexus: received SIGTERM, graceful restart pending (exit 75)...');
      if (pwaWatchHandle) { try { pwaWatchHandle.stop(); } catch { /* */ } }
      // R1(재시작 최소화 RFC) — 이미 텔레그램에 «확인»된 턴이 재시작으로 말없이 사라지지 않게,
      //   SIGTERM 을 받은 «지금부터» 상한 안에서 봇의 대기 턴을 비운 뒤 나간다(부팅 시각 기준이 아니다).
      sigtermExit = drainTelegramThen(() => gracefulExit({
        state,
        registry,
        ...(supervisor ? { supervisor } : {}),
        release: releaseWithShareUnmount,
      }));
      resolveDone();
    };
    const onSigint = (): void => {
      console.error('\nelanous nexus: received SIGINT, shutting down...');
      if (pwaWatchHandle) { try { pwaWatchHandle.stop(); } catch { /* */ } }
      resolveDone();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    await (opts.headlessDoneForTesting ? Promise.race([done, opts.headlessDoneForTesting]) : done);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);

    if (sigtermExit) await sigtermExit;
    else await cleanExit({
      state,
      registry,
      ...(supervisor ? { supervisor } : {}),
      release: releaseWithShareUnmount,
      exit: () => { /* return through to caller; index.ts top-level handles exit */ },
    });
    return {
      release: wrappedRelease,
      state,
      registry,
      runtime,
      shell,
      eventBus,
      agentStatusStore,
      hudStore,
      ...(httpServer ? { httpServer } : {}),
      ...(supervisor ? { supervisor } : {}),
      ...(settingsController ? { settingsController } : {}),
      ...(runtimeHistory ? { history: runtimeHistory } : {}),
      ...(runtimeHitlPending ? { hitlPending: runtimeHitlPending } : {}),
      ...(runtimeIntentPrediction ? { intentPrediction: runtimeIntentPrediction } : {}),

      chatSessions,
      webtermSessions,
    };
  }

  // PLAN-tui-redundancy-cleanup T4 (2026-05-16) — TUI render loop
  // (runNexusTui) 제거. `--legacy-tui` flag 가 T3 에서 제거되어 본 branch
  // 가 dead 였다. `elanous nexus run` 의 default 경로는 위 `headless` branch
  // (L2175-) 또는 `runPwaStart` 가 처리. 본 위치 도달 시는 caller 가 명시
  // `headless:false` 를 주면서 호출한 비정상 path — SIGINT/SIGTERM 대기
  // 후 cleanExit 으로 fallback.
  console.log('  elanous nexus: TUI mount path deprecated (T4) — Ctrl-C / SIGTERM to exit.\n');
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  let sigtermExit: Promise<void> | undefined;
  const onSigterm = (): void => {
    console.error('\nelanous nexus: received SIGTERM, graceful restart pending (exit 75)...');
    sigtermExit = drainTelegramThen(() => gracefulExit({
      state,
      registry,
      ...(supervisor ? { supervisor } : {}),
      release: releaseWithShareUnmount,
    }));
    resolveDone();
  };
  const onSigint = (): void => {
    console.error('\nelanous nexus: received SIGINT, shutting down...');
    resolveDone();
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  await done;
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);

  // SIGTERM completes its graceful exit; SIGINT clears restart-state.
  if (sigtermExit) await sigtermExit;
  else await cleanExit({
    state,
    registry,
    ...(supervisor ? { supervisor } : {}),
    release: releaseWithShareUnmount,
    exit: () => { /* return through to caller; index.ts top-level handles exit */ },
  });
  return {
    release: wrappedRelease,
    state,
    registry,
    runtime,
    shell,
    eventBus,
    agentStatusStore,
    hudStore,
    ...(httpServer ? { httpServer } : {}),
    ...(supervisor ? { supervisor } : {}),
    ...(settingsController ? { settingsController } : {}),
    ...(runtimeHistory ? { history: runtimeHistory } : {}),
    ...(runtimeHitlPending ? { hitlPending: runtimeHitlPending } : {}),
    chatSessions,
    webtermSessions,
  };
}

/** P.3 — first-boot PWA share wizard wiring. Reads the switch, calls
 *  the prompt module, persists the answer. Errors are swallowed so a
 *  borked wizard never blocks boot — worst case the next interactive
 *  boot re-asks. */
async function runPwaShareWizardIfAsk(params: {
  port: number;
  pwaBuilt: boolean;
  argvBin: string;
  io?: WizardIO;
}): Promise<void> {
  const ownIo = params.io === undefined;
  const io = params.io ?? defaultIO();
  try {
    const readSwitch = (): ShareTailnetValue => {
      try {
        const v = readSwitchValue(readUserConfig(), 'global.nexus.pwa.shareTailnet');
        if (v === 'enabled' || v === 'disabled') return v;
      } catch { /* swallow — fall through to 'ask' */ }
      return 'ask';
    };
    const saveSwitch = (v: ShareTailnetValue): void => {
      try {
        patchUserConfig((cfg) => writeSwitchValue(cfg, 'global.nexus.pwa.shareTailnet', v));
      } catch { /* swallow */ }
    };
    await runPwaSharePrompt({
      probeFn: () => probeTailscale(),
      buildFn: async () => {
        const { runPwaBuild } = await import('../cli/pwa-build.js');
        const r = await runPwaBuild({ argvBin: params.argvBin });
        return { exitCode: r.exitCode };
      },
      serveFn: defaultTailscaleServe,
      readSwitch,
      saveSwitch,
      io,
      pwaBuilt: params.pwaBuilt,
      port: params.port,
    });
  } catch { /* swallow — wizard must never block boot */ }
  finally {
    if (ownIo) io.close();
  }
}

function isCompleteTailnetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/app/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function shouldAskPwaShareSwitch(): boolean {
  try {
    const v = readSwitchValue(readUserConfig(), 'global.nexus.pwa.shareTailnet');
    return v !== 'enabled' && v !== 'disabled';
  } catch {
    return true;
  }
}

function printBootBanner(runtime: NexusRuntimeMeta, pwaStaticDir?: string): void {
  const lines = [
    '',
    `  elanous NEXUS · ${runtime.nexusVersion}`,
    '  ──────────────────────────────────────────────────────',
    `  pid       ${runtime.pid}`,
    `  host      ${hostname()}`,
    `  root      ${nexusRootDir()}`,
    `  lock      ${nexusLockPath()}`,
    `  runtime   ${nexusRuntimePath()}`,
  ];
  if (runtime.httpPort) {
    const httpUrl = `http://${runtime.httpHost ?? '127.0.0.1'}:${runtime.httpPort}`;
    lines.push(`  http      ${httpUrl}/v1/{health,nexus,events}`);
    // P.1 — PWA UI URL when staticDir wired (T5.A static handler 활성).
    if (pwaStaticDir) {
      lines.push(`  pwa       ${httpUrl}/app/  (static export · ${pwaStaticDir})`);
    } else {
      // P.2 — banner hint points at `elanous nexus pwa build` so users
      // don't need to remember the cd / build pair.
      lines.push(`  pwa       (not built)`);
      lines.push(`  ⚠ run \`elanous nexus pwa build\` (one-time · ~30s) to enable web UI`);
    }
  }
  lines.push(
    '',
    '  Read-only routes:  GET /v1/{health,nexus,nexus/tabs,events}',
    '  Toggle keys: Ctrl-` (primary) · Ctrl-\\ (Korean IME / SSH friendly).',
    '  Install service: elanous nexus install --launchd (macOS) or --systemd-user (Linux).',
    '',
    '  Ctrl-C to release lock and exit.',
    '',
  );
  console.log(lines.join('\n'));
}

const NEXUS_STATUS_HEALTH_TIMEOUT_MS = 800; // Keep a status check responsive while allowing a local listener one short round-trip.

async function probeNexusStatusHealth(runtime: NexusRuntimeMeta | null): Promise<NexusHttpHealth> {
  // No runtime address means there was no listener to probe, preserving ordinary stopped status.
  if (!runtime?.httpPort || !Number.isInteger(runtime.httpPort) || runtime.httpPort < 1 || runtime.httpPort > 65535) return 'silent';
  const host = runtime.httpHost ?? '127.0.0.1';
  if (!host.trim()) return 'silent';
  try {
    const healthUrl = new URL('http://localhost/v1/health');
    healthUrl.hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    healthUrl.port = String(runtime.httpPort);
    const response = await fetch(healthUrl.href, {
      signal: AbortSignal.timeout(NEXUS_STATUS_HEALTH_TIMEOUT_MS),
    });
    return response.ok ? 'responsive' : 'silent';
  } catch {
    // The request could not complete, so retain unknown rather than infer listener silence.
    return 'unknown';
  }
}

async function printStatus(): Promise<void> {
  const lifecycle = findNexusLifecycleState();
  const root = lifecycle?.root ?? nexusRootDir();
  const lock = lifecycle?.lock ?? null;
  const runtime = lifecycle?.runtime ?? readNexusRuntime();
  const health = await probeNexusStatusHealth(runtime);
  const status = classifyNexusStatus({ lockAlive: lock !== null, health });
  console.log(`  elanous NEXUS · ${NEXUS_VERSION} · ${NEXUS_PHASE}`);
  console.log('  ──────────────────────────────────────────────────────');
  console.log(`  root      ${root}`);
  console.log(`  lock      ${joinPath(root, '.lock')}`);
  console.log(`  runtime   ${joinPath(root, 'runtime.json')}`);
  console.log('');
  if (lock) {
    console.log(`  status    ${status} (pid=${lock.pid} host=${lock.host} since=${lock.startedAt})`);
  } else {
    console.log(`  status    ${status}`);
  }
  if (runtime) {
    console.log(`  version   ${runtime.nexusVersion} (phase: ${runtime.phase})`);
    if (runtime.template) console.log(`  template  ${runtime.template}`);
    if (runtime.httpPort) console.log(`  http      http://${runtime.httpHost ?? '127.0.0.1'}:${runtime.httpPort}`);
  }
  console.log('');
}

function stopExisting(): void {
  const lifecycle = findNexusLifecycleState();
  const lock = lifecycle?.lock ?? null;
  if (!lock) {
    console.log('elanous nexus: not running');
    return;
  }
  if (lock.host !== hostname()) {
    console.error(`elanous nexus: lock held by remote host ${lock.host}; cannot stop from here`);
    process.exit(1);
  }
  try {
    // PR χ — `--stop` sends SIGINT, not SIGTERM. SIGTERM is reserved for
    // the OS supervisor's graceful-restart channel (exit 75); SIGINT is
    // the explicit user-stop channel (exit 0, clears restart-state).
    process.kill(lock.pid, 'SIGINT');
    console.log(`elanous nexus: SIGINT sent to pid ${lock.pid}`);
  } catch (err) {
    console.error(`elanous nexus: failed to signal pid ${lock.pid}: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** Resolve whether the `webterm:1` tab should be auto-registered at boot.
 *  Resolution order:
 *
 *    1. UserConfig switch `global.tabs.registerWebterm` (true/false)
 *    2. env `ELANOUS_REGISTER_WEBTERM` truthy (`1` / `true` / `yes` / `on`)
 *    3. switch default = false
 *
 *  switch read is wrapped in try/catch — a malformed config file must
 *  not block boot; we fall back to env / default. */
function shouldRegisterWebterm(): boolean {
  try {
    const cfg = readUserConfig();
    const v = readSwitchValue(cfg, 'global.tabs.registerWebterm');
    if (v === true) return true;
    if (v === false) return false;
  } catch { /* swallow — boot must not fail on a bad config */ }
  const env = process.env.ELANOUS_REGISTER_WEBTERM?.trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes' || env === 'on') return true;
  return false;
}

// C-2a (cleanup ROADMAP 2026-05-08): `shouldRegisterDaemon` moved to
// `boot/register-daemon.ts` and re-exported above (line 32) so existing
// test imports (`from '../src/nexus/index.js'`) keep working.

/** Resolve the active daemon tool surface kind for runNexus.
 *
 *  Resolution order (parity with `deriveChildEnv` for daemon tab spawn —
 *  the same switch fed into a daemon child env should govern the in-
 *  process path too):
 *
 *    1. CLI flag (`opts.tools`)                                     ← 1회 boot
 *    2. `ELANOUS_TOOLS` env                                           ← shell session
 *    3. UserConfig switch `global.tools` (PWA Settings 토글이 여기) ← 영구
 *    4. switch default = `'webterm'` (`builtins/global.ts:12`)       ← fallback
 *
 *  Pre-fix the in-process branch fell back to `'none'` while
 *  `deriveChildEnv` fell back to the switch default `'webterm'`. That
 *  meant a clean-machine `elanous nexus` (no flag/env) gave the in-process
 *  LLM call an empty tool catalog while a separately-launched
 *  `elanous serve` daemon honored the switch default's full surface —
 *  surprising divergence the user had no way to discover.
 *
 *  `'all'` is in the switch enum but has no `toolSurface()` impl yet;
 *  fall back to `'webterm'` (the most-capable wired surface). */
const daemonToolSurfaceKinds: Record<DaemonToolSurfaceKind, true> = {
  none: true,
  readonly: true,
  chat: true,
  webterm: true,
};

function resolveKnownToolsKind(raw: string): DaemonToolSurfaceKind | undefined {
  return Object.hasOwn(daemonToolSurfaceKinds, raw)
    ? raw as DaemonToolSurfaceKind
    : undefined;
}

export function resolveToolsKind(opts: { tools?: string }): DaemonToolSurfaceKind {
  let raw: string | undefined = opts.tools;
  if (!raw) raw = process.env.ELANOUS_TOOLS?.trim();
  if (!raw) {
    try {
      const cfg = readUserConfig();
      const v = readSwitchValue(cfg, 'global.tools');
      if (typeof v === 'string') raw = v;
    } catch { /* swallow — boot must not fail on a malformed config */ }
  }
  if (!raw) raw = 'webterm';
  return resolveKnownToolsKind(raw) ?? 'webterm';
}

/** Resolve the `:agent` (통합 모드 webterm dock) tool surface kind.
 *
 *  Distinct from {@link resolveToolsKind} because the integrated
 *  webterm-dock chat is **defined by** its PTY surface — WebTerminal*
 *  tools (Snapshot · Input · Screenshot) are what make `:agent`
 *  meaningful next to a live terminal. If the user has narrowed their
 *  user-config (`global.tools chat` / `readonly`) to keep the
 *  standalone `/chat` lighter, that preference must NOT bleed into the
 *  integrated dock — otherwise the `:agent` LLM loses access to the
 *  very terminal it's supposed to drive.
 *
 *  Resolution order:
 *    1. CLI flag (`opts.tools`)         ← explicit operator intent wins
 *    2. **`'webterm'`** (hardcoded)     ← env + global.tools intentionally
 *                                         skipped vs. resolveToolsKind
 *
 *  CLI flag is honored so a developer debugging tool selection
 *  (`elanous nexus run --tools readonly`) still sees a readonly `:agent`;
 *  but a clean-machine boot or a config-narrowed boot always gets
 *  webterm for the integrated dock. */
export function resolveAgentTurnToolsKind(opts: { tools?: string }): DaemonToolSurfaceKind {
  const raw = opts.tools?.trim();
  if (!raw) return 'webterm';
  // 'all' (or any unrecognized string) → webterm fallback, same as
  // resolveToolsKind so the two resolvers stay consistent for valid
  // CLI input.
  return resolveKnownToolsKind(raw) ?? 'webterm';
}
