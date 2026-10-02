// NEXUS · HTTP API server (Phase N-1 PR δ — read-only)
//
// Bun.serve mounting:
//   GET /v1/health                — liveness probe (loopback-only ok)
//   GET /v1/nexus                 — full state snapshot (version, phase,
//                                   startedAt, template, tabs[])
//   GET /v1/nexus/tabs            — tab list (kind filter via ?kind=)
//   GET /v1/nexus/tabs/:id        — single tab + recent events
//   GET /v1/events?topics=p1,p2   — SSE stream filtered by topic prefix
//
// Mutation endpoints (POST/PATCH/DELETE) land in N-3 with the
// SwitchRegistry + Edit-in-PWA work. PR δ is read-mostly so PWA / external
// monitors can already inspect.
//
// Port policy (N1-2 decision): auto-pick from 31415 upward. Actual port
// is recorded in runtime.json + printed in boot banner.

import { setInProcessOutbound } from '../../domains/outbound-alert.js';
import { getUserConfig } from '../../user-config.js';
import type { TelegramEvent } from '../../workflow-runtime/triggers/telegram-source.js';
import { spawnSync } from 'node:child_process';
import { compareTokenConstTime } from '../../acp/transport/auth.js';
import { ensureAuthToken } from '../../auth/acp-token.js';
import type { NexusState } from '../state/state.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../default-port.js';
export { DEFAULT_NEXUS_HTTP_PORT } from '../default-port.js';
import type { TabRegistry } from '../state/tab-registry.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import type { Supervisor } from '../supervisor/index.js';
import { debug } from '../../debug/log.js';
import { NexusEventBus } from './event-bus.js';
import { tryHandleAdminMcpReload, type McpReloadOutcome } from './admin-mcp-reload.js';
import {
  createDevProxyRuntimeRef,
  tryHandleAdminDevProxy,
  type DevProxyRuntimeRef,
} from './admin-dev-proxy.js';
import { handleDevProxyHttpRequest, pathMatchesDevProxy } from './dev-proxy.js';
import { OPENAI_RELAY_PATH, tryHandleOpenAiRelay } from './openai-relay.js';
import { handleHealth, type HealthSetupContext } from './health.js';
import { handleTabsList, handleTabDetail, handleNexusSnapshot } from './tabs.js';
import { handleSseEvents } from './events.js';
import { dispatchIntentPredictionRoute } from './intent-prediction.js';
import { handleNotificationAction } from './notification-action.js';
import { handleUserIntentEmit, handleUserIntentBatch } from './user-intents.js';
import { handleDebugLogsBatch } from './debug-logs.js';
import { handleOutboundTokens, type OutboundTokenRouteOpts } from './outbound-tokens.js';
// Cascade-zyu W9 / W9b / W9c endpoint dispatch — added by W9d-FU (2026-05-12).
// Each handler does its own method check internally; the dispatch block
// only verifies the pathname pattern + opts.<field> presence (returns
// 503 when the NEXUS boot didn't wire the DI'd dependencies).
import {
  handleApprovalShowroom,
  parseApprovalShowroomPath,
  type ApprovalShowroomRouteOpts,
} from './approval-showroom.js';
import {
  handleWorkflowDesign,
  parseWorkflowDesignPath,
  type WorkflowDesignRouteOpts,
} from './workflow-design.js';
import {
  handleMissionShowroom,
  parseMissionShowroomPath,
  type MissionShowroomRouteOpts,
} from './mission-showroom.js';
import {
  handleDevices,
  handleTemplateCapabilityPreview,
  isDevicesPath,
  isTemplateCapabilityPreviewPath,
  type DevicesRouteOpts,
} from './devices.js';
import {
  handleMissionsTest,
  isMissionsTestPath,
  type MissionsTestRouteOpts,
} from './missions-emit.js';
import {
  handleConversationStats,
  isConversationStatsPath,
} from './agent-cli-conversation-stats.js';
import {
  handleNextFluentPreview,
  handleNextFluentDispatch,
  isNextFluentPreviewPath,
  isNextFluentDispatchPath,
  type NextFluentRouteOpts,
} from './next-fluent.js';
import {
  handleMorningShowroom,
  isMorningShowroomPath,
  type MorningShowroomRouteOpts,
} from './morning-showroom.js';
import {
  handleIdleNudge,
  isIdleNudgePath,
  type IdleNudgeRouteOpts,
} from './idle-nudge.js';
import {
  handleNotesFromImage,
  type NotesFromImageOpts,
} from './notes-from-image.js';
import {
  handleNotesFromImages,
  type NotesFromImagesOpts,
} from './notes-from-images.js';
import {
  handleNotesSave,
  type NotesSaveOpts,
} from './notes-save.js';
import {
  handleImageGenerate,
  handleImageEdit,
  type ImageGenerateOpts,
} from './image-generate.js';
import {
  handleNotesMetricsSnapshot,
  handleNotesMetricsEvent,
  type NotesMetricsRouteOpts,
} from './metrics-notes.js';
import {
  handleSessionsActive,
  type SessionsActiveOpts,
} from './sessions-active.js';
import {
  handleSessionsDecision,
  parseSessionDecisionPath,
  type SessionsDecisionOpts,
} from './sessions-decision.js';
import {
  handleReflection,
  parseReflectionPath,
  type ReflectionRouteOpts,
} from './reflection.js';
import { handleSignalBoard } from './signal-board-api.js';
import {
  handleDashboard,
  handleDashboardRefreshLive,
  parseDashboardPath,
  type DashboardRouteOpts,
} from './dashboard.js';
import {
  handleTriagePreview,
  handleAutopilotGet,
  handleMissionAction,
  parseAutopilotPath,
} from './autopilot-api.js';
import {
  handleVaultGet,
  handleVaultFilePut,
  handleTemplateExpand,
  parseVaultPath,
} from './vault-api.js';
import { handleBuildsGet, parseBuildsPath } from './builds-api.js';
import { handleHarnessAskPost, handleHarnessAskStatusGet, handleHarnessRunEventsGet, handleHarnessRunScreenGet, handleHarnessRunsGet, handleHarnessStopPost } from './harness-api.js';
import { dispatchPersonaRoute } from './personas.js';
import { handleRoleJudge } from './role-judge.js';
import { handleAudioStt } from './audio-stt.js';
import { handleLlmModels } from './llm-models.js';
import { handleLlmHostsConfig } from './llm-hosts-config.js';
import { handleLlmRotationGet, handleLlmRotationNext } from './llm-rotation.js';
import {
  handleLlmProvidersList,
  handleLlmProviderSet,
} from './setup-llm-provider.js';
import { handleObsidianSkillsGet, handleObsidianSet, handleSkillsSet } from './setup-obsidian-skills.js';
import { handleChildLlmGet, handleChildLlmSet } from './setup-child-llm.js';
import { handleAnswerPriorityGet, handleAnswerPrioritySet } from './setup-answer-priority.js';
import { handleChannelBotsGet, handleChannelBotSet } from './setup-channel-bot.js';
import { handleLlmRoutePredict } from './llm-route-predict.js';
import type { MissionRouter } from '../../llm/mission-router.js';
import { handleContextFetchUrl } from './context-url.js';
import type { IntentPredictionService } from '../../intent-prediction/index.js';
import type { NotificationActionLoopback } from '../../web-push/notification-action-loopback.js';
import { handlePlatforms } from './platforms.js';
import { handleRegistryCatalog } from './registry-catalog.js';
import {
  handleRegistryResolved,
  handleRegistryProviderDisable,
  handleRegistryEvents,
} from './registry-resolved.js';
import {
  handleDiscoveryGet,
  handleDiscoveryRun,
} from './registry-discovery.js';
import { handleWorktrees, handleWorktreeDispose } from './worktrees.js';
import { handleBotCommands } from './bot-commands.js';
import { handleDesignCheck, handleDesignDirectionPost } from './design-check.js';
import { handleDesignPreviews } from './design-previews-route.js';
import { handleDesignSystemCreate } from './design-system-create-route.js';
import { handleHitlAuditRecent, handleHitlTestPushcut } from './hitl-pushcut-settings.js';
import { handleWorkflowRoute } from './workflow-router.js';
import { handleSkillRoute } from './skill-router.js';
import { dispatchMutation } from './tabs-mutations.js';
import { handleTemplatesList, handleTemplateGet, handleTemplateSave } from './templates.js';
import { handleMcpHttpPost } from './mcp-http.js';
import { handleMcpResourceGet, MCP_RESOURCE_ROUTE_PATH } from './mcp-resource-route.js';
// ⛔ 라우트 상수를 «디스패처»가 안 쓰고 문자열로 베끼고 있었다(16차 실측) — 잎에서 읽는다.
import { APPROVALS_MERGES_PATH, DESIGN_DIRECTION_PATH, DESIGN_PREVIEW_PATH_PREFIX, DESIGN_PREVIEWS_PATH, DESIGN_SYSTEM_PATH, IPA_PATH_PREFIX, MANIFEST_PATH } from './rest-route-paths.js';
import { handleMergeApprovals } from './merge-approvals.js';
import { GRAPH_APPROVALS_PATH, handleGraphApprovals } from './graph-approvals.js';
import { handleExecRequests } from './exec-requests.js';
import { handleSeatRequests, SEAT_REQUESTS_PATH, type SeatRequestsDeps } from './seat-requests.js';
import { handleConsultRequests, CONSULT_REQUESTS_PATH, type ConsultRequestsDeps } from './consult-requests.js';
import { ExecRequestRunner } from '../../exec-requests/runner.js';
import { FIELD_SERVER_MAX_BODY_BYTES, FIELD_UPLOADS_PATH, FIELD_REEL_PATH, FIELD_REEL_FILE_PATH, handleFieldUploads } from './field-uploads.js';
import { handleLiveDetail, LIVE_DETAIL_PATH } from './live-detail.js';
import { handleLiveShipped, LIVE_SHIPPED_PATH } from './live-shipped.js';
import { handleMcpWidgetCall, MCP_WIDGET_CALL_ROUTE_PATH, persistWidgetTurnToSessionStore } from './mcp-widget-call-route.js';
import type { McpClientsHandle } from '../boot/register-mcp-clients.js';
import { mcpUnauthorizedResponse, oauthRegistrationRejected } from './mcp-oauth-hint.js';
import { handleTabLogs } from './logs.js';
import {
  handleConfigGet,
  handleSwitchesList,
  handleSwitchGet,
  handleSwitchPut,
  handleSecretPost,
  handleSecretDelete,
  handleSecretsList,
  type ConfigCtx,
} from './config.js';
import {
  handleBindingsList,
  handleBindingGet,
  handleBindingPost,
  handleBindingPatch,
  handleBindingDelete,
  parseBindingPath,
} from './registry.js';
import {
  handleEditInPwaPost,
  handleEditInPwaConsume,
  type EditInPwaCtx,
} from './edit-in-pwa.js';
import {
  handleErrorDismiss,
  handleErrorGet,
  handleErrorsForTab,
  handleErrorsList,
  parseErrorsPath,
} from './errors.js';
import { handleChatBackendDetection } from './chat-backend-detection.js';
import { handleChatFastPathConfig } from './chat-fast-path-config.js';
import { connectInfoTokenAllowed, handleConnectInfoGet, handleConnectTokenMint, type ConnectInfoCtx } from './connect-info.js';
import { handleStaticAppRequest, pathMatchesStaticPrefix } from './static-app.js';
import {
  createWsBridge,
  type WsBridgeOpts,
  type WsHandlers,
  type BunServerLike,
} from '../../boot/ws-bridge.js';
import {
  handleAttachmentGet,
  handleMediaGet,
  handleAuthTraceGet,
  handleAttachmentUpload,
  handleControlSignalsEmit,
  handleControlSignalsList,
  handleHitlCallback,
  handleLastScreenshotGet,
  handleListPushSubscriptions,
  handleRecordingGet,
  handleIntakeIdRoute,
  handleIntakeListGet,
  handleIntakePost,
} from './meta-api.js';
import { handleIntakePipelinePreviewPost } from './intake-pipeline-preview.js';
import { handleIntakePipelineCommitPost } from './intake-pipeline-commit.js';
import { handleIntakeRoutePost } from './intake-route.js';
import { corsPreflight, jsonResponse } from './json-response.js';
import { isPublicRoute } from './public-routes.js';
import { handleSchedulesActionPost } from './schedules-action.js';
import { handleSchedulesList, handleScheduleDetail, handleScheduleRuns } from './schedules-read.js';
import { handleIntakeRunsList } from './intake-runs.js';
import { handleMissionsList, handleMissionDetail } from './missions.js';
import { handleSessionsStoreList, handleSessionsStoreGet, handleSessionsStoreFork, handleSessionsStoreDelete } from './sessions-store.js';
import { handleLogsQuery, handleLogsStream, handleLogsLevelGet, handleLogsLevelPost, handleLogsFacets, handleLogsHistogram, handleLogsInstances } from './log-fabric.js';
import { handleTrace, handleTraceEvidence } from './trace.js';
import { handleDispatchRunsList } from './dispatch-runs.js';
import {
  handleWorkflowLifecycleGet,
  handleWorkflowLifecyclePut,
} from './workflow-lifecycle.js';
import {
  handleWorkflowPinsList,
  handleWorkflowPinGet,
  handleWorkflowPinPut,
  handleWorkflowPinDelete,
} from './workflow-pins.js';
import {
  handleAgentStatusPost,
  handleHudSegmentPost,
  handleChatEventsGet,
  handlePromptPost,
  handlePromptStreamPost,
  handleSessionDelete,
  handleSessionGet,
  handleSessionRegister,
  handleSessionsList,
  handleSimulationsList,
  handleSubscribePush,
  handleTestPush,
  handleToolsList,
  handleRuntimeToolsList,
  handleRuntimeToolCall,
  parseRuntimeToolCallPath,
  handleUnsubscribePush,
  handleVapidPublicKey,
  handleVoiceCost,
  handleVoiceTranscribe,
  checkAuth,
  bearerCredential,
  registerAuthPeerAddress,
  type MetaApiOpts,
} from './meta-api.js';
// Surface-unification v2.2 V2.2-6 v2 (2026-05-11) — scheduler list /
// detail endpoint pair retired together with the dashboard scheduler
// view. Tasks-only handlers remain in `tasks-scheduler.ts` (rename to
// `tasks.ts` deferred to a follow-up).
import {
  handleTasksList,
  handleTaskDetail,
} from './tasks-scheduler.js';
import { handleTaskCardsGet } from './task-cards-api.js';
import { handleTaskCreatePost, handleTaskApprovePost } from './tasks-create.js';
import { matchIngestAuthorization } from './ingest-token.js';
import {
  handleWorkflowApprovalApprove,
  handleWorkflowApprovalReject,
  handleWorkflowApprovalsPending,
  handleWorkflowDelete,
  handleWorkflowGet,
  handleWorkflowPut,
  handleWorkflowRunGet,
  handleWorkflowRunsList,
  handleWorkflowRunStart,
  handleWorkflowValidate,
  handleWorkflowGenerate,
  handleWorkflowSynth,
} from './workflows.js';
import { handleTriggersSnapshot } from './triggers.js';
import { handleWorkflowTemplatesList } from './workflow-templates.js';
import { handleGraphsGet, handleGraphsMutation } from './graphs-api.js';
import { handleGraphKindsGet, handleGraphsValidatePost } from './graph-kinds.js';
import { syncInstalledPluginNodes } from '../../graph-kinds/installed-plugin-nodes.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { handlePluginsIndexGet, handlePluginsGet, handlePluginsMarketRefresh, handlePluginsInstall, handlePluginsRemove } from './plugins-market.js';
import { handlePluginsCredentialsGet, handlePluginsCredentialsPut } from './plugins-credentials-api.js';
import {
  handleWorkflowsList,
} from './workflows.js';
import { handleWorkflowsEvents } from './workflow-events.js';
import {
  handleTerminalScrollback,
  handleTerminalControl,
  handleTerminalRename,
  handleTerminalsPrune,
  handleTerminalTerminate,
  handleTerminalFrame,
  handleTerminalPng,
  handleTerminalLineage,
  handleTerminalRunGoal,
  handleTerminalRunParticipants,
  handleTerminalsList,
  handleTerminalsView,
  parseTerminalLineagePath,
  parseTerminalRunGoalPath,
  parseTerminalRunParticipantsPath,
  parseTerminalControlPath,
  parseTerminalRenamePath,
  parseTerminalsPrunePath,
  parseTerminalTerminatePath,
  parseScrollbackPath, parseTerminalStreamPath, handleTerminalStream,
  parseFramePath,
  parsePngPath,
} from './terminals.js';
import {
  handleAgentCliCancel,
  handleAgentCliCloseSession,
  handleAgentCliCreateSession,
  handleAgentCliPromptStream,
  parseAgentCliSessionPath,
} from './agent-cli.js';
import { handleSessionTurnControl, SESSION_TURN_CONTROL_PATH } from '../../session/session-turn-control.js';
import { authenticatePodCredential, handlePodGrokCredential, handlePodGithubCredential, POD_CREDENTIAL_GROK_PATH, POD_CREDENTIAL_GITHUB_PATH } from './pod-credential-api.js';
import { handleOutboundReport } from './outbound-report.js';
import { handleErrorReportIngest } from './error-reports.js';
import { routeOutboundInProcess } from './outbound-report.js';
import { handleSelfEvent } from './self-event.js';
/** 매매 «실행»은 애드온이다(대표 09-20 결정 ③ · 별도 상용 저장소 · release/trading-export.yaml) — 공개 코어엔 없다.
 *  있으면 그 경로를 켜고, 없으면 501. 경로를 변수로 둬 공개본 타입 검사가 «모듈 없음»으로 막히지 않게 한다. */
const TRADE_PROPOSAL_MODULE: string = './trade-proposal.js';
import {
  handleShowroomLayoutDelete,
  handleShowroomLayoutGet,
  handleShowroomLayoutPut,
  handleShowroomLayoutsEvents,
  handleShowroomLayoutsList,
  parseShowroomLayoutPath,
} from './showroom-layouts.js';

export const NEXUS_HTTP_PORT_RANGE = 16;     // try 31415..31430
/** Short timeout for the pre-bind localhost occupancy probe. */
export const NEXUS_PORT_PROBE_TIMEOUT_MS = 400;

export type NexusPortProbeVerdict = 'occupied' | 'available';
/** Injectable pre-bind probe. Failures and timeouts fail-open as available.
 *  The scan stays synchronous, so probes must return a verdict directly. */
export type NexusPortProbe = (port: number) => NexusPortProbeVerdict;

export function nexusPortProbeUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1/health`;
}

function readProbeVerdict(result: unknown): NexusPortProbeVerdict {
  return result === 'occupied' ? 'occupied' : 'available';
}

/** Default occupancy probe used by `startNexusHttpServer`: a short-timeout
 *  GET of `/v1/health` on loopback. Any HTTP response means occupied —
 *  including 3xx. `redirect: 'manual'` judges the first hop so an
 *  unreachable Location cannot flip the verdict to available, and the
 *  local probe cannot follow off-box. Network errors and timeouts are
 *  available.
 *
 *  Runs in a subprocess so a peer daemon's event loop can answer while this
 *  scan stays synchronous. Same-process occupants cannot reply while the
 *  thread is blocked — that is not the production collision (two PIDs). */
export function probeNexusHttpPort(
  port: number,
  timeoutMs: number = NEXUS_PORT_PROBE_TIMEOUT_MS,
): NexusPortProbeVerdict {
  const url = JSON.stringify(nexusPortProbeUrl(port));
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : NEXUS_PORT_PROBE_TIMEOUT_MS;
  try {
    const result = spawnSync(
      process.execPath,
      ['-e', `await fetch(${url}, { signal: AbortSignal.timeout(${timeout}), redirect: 'manual' }); process.stdout.write('occupied');`],
      { encoding: 'utf8', timeout: timeout + 500 },
    );
    return (result.stdout ?? '').trim() === 'occupied' ? 'occupied' : 'available';
  } catch {
    return 'available';
  }
}

/** Subset of WsBridgeOpts that the caller supplies — hostname/port are
 *  filled in by the http-server itself once the bind succeeds. */
export type NexusWsBridgeInit = Omit<WsBridgeOpts, 'hostname' | 'port'>;

export interface NexusHttpServerOpts {
  /** Optional installer state root for isolated API consumers and tests. */
  pluginStateRoot?: string;
  execRequests?: ExecRequestRunner;
  seatRequests?: SeatRequestsDeps;
  consultRequests?: ConsultRequestsDeps;
  state: NexusState;
  registry: TabRegistry;
  eventBus: NexusEventBus;
  /** Supervisor handle — required for the write API (PR ι). When omitted
   *  (skipSupervisor mode), mutation routes return 503. */
  supervisor?: Supervisor;
  /** Hot-applicable switch handler — invoked when PUT /v1/config/switches/:id
   *  changes a switch with `hotApplicable=true`. Default is a no-op so
   *  the toggle persists in UserConfig but no in-process effect is
   *  attempted (e.g., debug.enabled flip happens via supervisor or
   *  another module that inspects UserConfig directly). */
  hotApplyHandler?: (switchId: string, value: unknown) => void;
  /** Edit-in-PWA mint/consume context (PR β'). When omitted the routes
   *  return 503 — server still boots so existing /v1/config callers
   *  keep working. */
  editInPwa?: EditInPwaCtx;
  /** NEXUS N-1.5 PR c · ACP/voice WS bridge. When provided, NEXUS mounts
   *  `/v1/acp` and `/v1/voice/ws` on its own port (decision #18 v6 hard
   *  landing — daemon-public WS is freeze-deprecated). When omitted,
   *  both paths return 404 — boot wiring without ACP runtime stays
   *  HTTP-only. */
  wsBridge?: NexusWsBridgeInit;
  /** NEXUS N-1.5 PR d · voice / push / attachments meta-API. When
   *  omitted, every meta-API path returns 503 (handlers wired but no
   *  caller). PR i / PR j boot rewire flips this on. */
  metaApi?: MetaApiOpts;
  /** Resolves the asynchronously booted configured MCP clients on each resource request. */
  getMcpClients?: () => McpClientsHandle | undefined;
  /** 대표 2026-09-10 — `POST /v1/nexus/admin/mcp-reload` 의 실행부.
   *  프로덕션 부팅만 넘긴다. 없으면 그 라우트는 503 으로 fail-closed 하고,
   *  「기능이 없다」가 아니라 「이 데몬이 그 배선 없이 떴다」를 말한다. */
  reloadMcpClients?: () => Promise<McpReloadOutcome>;
  /** Trusted server-side widget-to-MCP-server binding; request bodies never select this server. */
  getMcpWidgetServerId?: (req: Request) => string | undefined;
  /** iPhone Showroom Phase 1 P1-4 (2026-05-14) — mission router DI
   *  seam. Production boot passes `globalMissionRouter()`; tests pass
   *  a fake. When omitted `POST /v1/llm/route/predict` returns 503. */
  missionRouter?: MissionRouter;
  /** Override starting port for tests. Defaults to 31415. */
  startPort?: number;
  /** Override range (max attempts). Defaults to 16. */
  portRange?: number;
  /** Hostname to bind. Defaults to '127.0.0.1' (loopback). */
  hostname?: string;
  /** 넥서스 기동 때 한 번 정한 셋업 상태. `/v1/health` 가 요청마다 다시 읽지 않고 이 값을 싣는다. */
  setup?: HealthSetupContext;
  /** Optional occupancy probe asked before each bind. Default is a short
   *  localhost GET of `/v1/health`. Occupied ports are skipped; probe
   *  failures and timeouts fail open as available. */
  portProbe?: NexusPortProbe;
  /** T5.A — directory served at /app/* (PWA static export). When omitted,
   *  /app/* returns 404 — boot wiring without the PWA build keeps working. */
  staticDir?: string;
  /** P-2D.2 — runtime mutable ref for the dev-proxy upstream.
   *  Replaced the static `devProxy: {upstream}` option so admin
   *  HTTP calls (`POST /v1/nexus/admin/pwa-dev-proxy`) can flip the
   *  state live without a nexus restart. When omitted, http-server
   *  creates its own ref starting at `null` (production behaviour
   *  unchanged — static export wins). When provided (tests, advanced
   *  callers), the host can read `.get()` to inspect or
   *  pre-populate the upstream. */
  devProxyRef?: DevProxyRuntimeRef;
  /** T4.A — server label / version surfaced via /v1/nexus/connect-info.
   *  Optional; falls back to a synthesized label. */
  connectInfo?: {
    nexusVersion: string;
    serverLabel?: string;
    /** Test seam — override the acp-token file path. */
    acpTokenPath?: string;
    /** Test seam — bypass file read entirely. */
    acpTokenOverride?: string | null;
  };
  /** Phase 0.5 (2026-05-08) intent-prediction service. When omitted,
   *  /v1/intent-prediction/* returns 404 — the rest of the server
   *  keeps booting. PR 6 wires this through runNexus when
   *  `skipIntentPrediction` is false. */
  intentPrediction?: IntentPredictionService;
  /** R-OCR.1 (2026-05-09) — POST /v1/notes/from-image dependencies.
   *  When omitted the endpoint returns 503 (registry-not-wired); when
   *  the registry is wired but `polish` is omitted, polishMode='enrich'
   *  silently degrades to 'minimal'. runNexus wires `registry` from
   *  `bootDefaultOcrProviders()`; the LLM polish callable is wired
   *  later (R-OCR.1.4) when the polish prompt + provider are picked. */
  notesFromImage?: NotesFromImageOpts;
  /** R-OCR follow-up (2026-05-09) — batch sibling. Same shape as
   *  `notesFromImage` (registry · polish · metrics) plus a per-batch
   *  cap. When omitted the endpoint returns 503. */
  notesFromImages?: NotesFromImagesOpts;
  /** R-OCR.3 (2026-05-09) — POST /v1/notes/save dependencies.
   *  When omitted the endpoint returns 503 (vault-not-wired).
   *  runNexus wires `vault` from `discoverObsidianVault()` so the
   *  PWA review-modal Confirm action persists into Obsidian (or the
   *  simulated `.elanous/research` fallback when no Obsidian is
   *  installed). Bundled with notesFromImage as the R-OCR.2/3
   *  dogfood unit. */
  notesSave?: NotesSaveOpts;
  /** PR Y2 (PLAN §5 popup synergy follow-up · 2026-05-17) — POST
   *  /v1/image/generate dependencies (vault + OpenAI key). When omitted
   *  the endpoint returns 503. Wired at runNexus boot — vault shared
   *  with notesSave, OPENAI_API_KEY env reader. */
  imageGenerate?: ImageGenerateOpts;
  /** R-OCR.4 (2026-05-09) — shared metric collector for the camera
   *  → notes pipeline. Same collector is also wired into
   *  `notesFromImage.metrics` and `notesSave.metrics` at runNexus
   *  boot so all three endpoints feed the same snapshot. When
   *  omitted, the GET endpoint serves an empty snapshot (graceful
   *  degradation for the PWA card) and the POST event endpoint
   *  returns 503. */
  notesMetrics?: NotesMetricsRouteOpts;
  /** W7 Z11.a-1 — device token register endpoint backing the
   *  OutboundRouter (`POST/DELETE/GET /v1/devices/tokens`). When omitted
   *  the endpoint returns 503; runNexus wires a singleton
   *  InMemoryDeviceTokenStore at boot. */
  outboundTokens?: OutboundTokenRouteOpts;
  /** W9 Z4 (#2428) — `GET /v1/runs/:runId/approval-showroom` deps.
   *  When omitted the endpoint returns 503; runNexus wires the lane
   *  callable + run resolver when the workflow-runtime daemon is
   *  available. */
  approvalShowroom?: ApprovalShowroomRouteOpts;
  /** W9 Z6 (#2429) — `POST /v1/workflows/:name/design` deps. When
   *  omitted the endpoint returns 503. */
  workflowDesign?: WorkflowDesignRouteOpts;
  /** W9b Z2 (#2439) — Mission Deliberation Room endpoints
   *  (`GET /v1/missions/:id/showroom` + `POST .../deliberate` + `POST
   *  .../decision` + `POST .../archive`). Wires the mission resolver
   *  + persona loader + room store. */
  missionShowroom?: MissionShowroomRouteOpts;
  /** W9c Z13-d (#2445) — `GET /v1/devices` + `POST /v1/templates/
   *  capability-preview` deps. Wires the device fleet source
   *  (`~/.elanous/devices.json` reader); when omitted both endpoints
   *  return 503. */
  devices?: DevicesRouteOpts;
  /** cascade-zyu W8-A 옵션 A (2026-05-14) — `POST /v1/missions/test`
   *  mock emitter for the iOS Companion shell's "Test Mission" button.
   *  Emits a 5-step progress mission.update envelope chain over ~30s so
   *  the Dynamic Island Live Activity can be dogfooded without a real
   *  mission orchestrator. Wired in runNexus from
   *  `getActiveAcpFeedbackBroadcaster()`. When omitted (no ACP peer up)
   *  the endpoint returns 503. */
  missionsTest?: MissionsTestRouteOpts;
  /** W9c Z13-a (#2447) — `POST /v1/next-fluent/preview` deps. Wires
   *  the lane callable + next-action source. When omitted returns 503. */
  nextFluent?: NextFluentRouteOpts;
  /** W9c Z13-c (#2448) — `POST /v1/morning-digest/showroom` deps.
   *  Wires the morning-showroom adapter (lane callable + persona
   *  binding). When omitted returns 503. */
  morningShowroom?: MorningShowroomRouteOpts;
  /** W9c Z13-c (#2448) — `POST /v1/idle-nudge/preview` deps. Wires
   *  the auto-relay listener (lane callable + history store + policy).
   *  When omitted returns 503. */
  idleNudge?: IdleNudgeRouteOpts;
  /** R5.0 (2026-05-09) — `/v1/sessions/active` snapshot for the PWA
   *  card deck. When omitted the endpoint returns 503; runNexus
   *  wires `history` from the same source `/v1/sessions` consumes. */
  sessionsActive?: SessionsActiveOpts;
  /** R5.4 (2026-05-09) — POST /v1/sessions/:id/decision opts.
   *  When omitted the endpoint still accepts requests but the
   *  event bus fan-out skips. Tests pass undefined; runNexus wires
   *  `eventBus` from the global bus so SSE subscribers can react. */
  sessionsDecision?: SessionsDecisionOpts;
  /** R6.2 (2026-05-09) — daily reflection (`/v1/reflection/today`
   *  and `/v1/reflection/:date`). When omitted the endpoints still
   *  serve a zero-counter snapshot so the PWA renders gracefully. */
  reflection?: ReflectionRouteOpts;
  /** R4 (2026-07-07) — finance dashboard read API
   *  (`/v1/dashboard/{summary|timeline|heatmap|digs}`). 캐시/SQLite
   *  read-only 라 opts 는 auth seam 만 — 생략 시에도 fail-soft 섹션. */
  dashboard?: DashboardRouteOpts;
  /** R3 v2 (2026-05-09) — fire-and-forget ACP loopback for the
   *  `/v1/notification-action` endpoint. When omitted the endpoint
   *  collapses to R3 v1 (records intent feedback only · agent does
   *  not run until the user opens the PWA). runNexus wires this from
   *  the same `runTurn` the ACP server uses; tests pass undefined. */
  notificationActionLoopback?: NotificationActionLoopback;
  /** Scheduler-retirement R2 (2026-05-11) — workflow-runtime daemon
   *  webhook bridge. When provided, NEXUS forwards any inbound
   *  `/v1/workflows/webhooks/<path>` request through the daemon's
   *  webhook router. When omitted the route returns 503 — daemon
   *  hosting is optional (CLI run-once flow doesn't need it). */
  workflowDaemon?: {
    dispatchWebhook: (req: {
      method: string;
      path: string;
      headers: Record<string, string | undefined>;
      body: string;
    }) => Promise<{ status: number; body: string; headers?: Record<string, string> } | null>;
    /** Surface-unification v2 — chat trigger dispatch. POST under
     *  `/v1/workflows/chat<path>` reaches the daemon's chat router,
     *  which matches by `chatTrigger.path` and runs the workflow.
     *  v2.1 — `stream` field set when the trigger opts into streaming;
     *  the caller serves text/event-stream instead of application/json. */
    dispatchChat?: (req: {
      path: string;
      authorization?: string;
      body: { message?: string; sessionId?: string };
    }) => Promise<{
      status: number;
      body: Record<string, unknown>;
      stream?: AsyncIterable<{ event: string; data: string }>;
    } | null>;
    /** 넥서스 밖 텔레그램 폴러(`elanous telegram run`)가 받은 업데이트를 워크플로 트리거로 넘긴다
     *  — `POST /v1/workflows/telegram-dispatch` (bearer 필수). 폴러가 core 밖으로 나가도 트리거가 산다. */
    dispatchTelegram?: (event: TelegramEvent) => Promise<Array<{ workflowName: string; nodeId: string; ok: boolean; error?: string }>>;
    /** V2.2-2 (2026-05-12) — hosted chat config lookup. The PWA
     *  hosted chat page calls `GET /v1/workflows/<name>/chat-config`
     *  on load to discover the chat trigger's POST path + streaming
     *  flag + auth posture. Tokens stay server-side; the PWA reads
     *  the bearer from its `?token=` URL param. */
    chatConfig?: (workflowName: string) => {
      workflowName: string;
      nodeId: string;
      path: string;
      streaming: boolean;
      sessionMode: 'stateless' | 'per-session';
      hostedUi: { enabled: boolean; requiresBearer: boolean };
    } | null;
  };
}

export interface NexusHttpServer {
  port: number;
  hostname: string;
  url: string;
  stop(): void;
}

/** Boot the HTTP API + (optionally) ACP/voice WS bridge. Returns the
 *  resolved port + a stop() thunk. Throws when the entire port range
 *  is exhausted. */
export function startNexusHttpServer(opts: NexusHttpServerOpts): NexusHttpServer {
  const startPort = opts.startPort ?? DEFAULT_NEXUS_HTTP_PORT;
  const range = opts.portRange ?? NEXUS_HTTP_PORT_RANGE;
  const hostname = opts.hostname ?? '127.0.0.1';
  const portProbe = opts.portProbe ?? probeNexusHttpPort;
  // P-2D.2 — every request reads from this ref. Admin endpoint
  // mutates it. When the caller didn't pass one we own the lifecycle.
  const devProxyRef: DevProxyRuntimeRef = opts.devProxyRef ?? createDevProxyRuntimeRef();

  let server: ReturnType<typeof Bun.serve> | null = null;
  let resolvedPort = -1;

  for (let i = 0; i < range; i += 1) {
    const port = startPort + i;
    let occupied = false;
    try {
      occupied = readProbeVerdict(portProbe(port)) === 'occupied';
    } catch {
      occupied = false;
    }
    if (occupied) {
      debug.log('nexus.http', 'port-occupied-skip', {
        port,
        reason: 'already answering',
      });
      continue;
    }
    try {
      // PR c — bind WS bridge first so peerId / trace lines record the
      // actual port we landed on (vs. startPort which may be busy).
      // P-2B.2 — wsBridge reads `devProxyUpstream` from the same ref so
      // HMR upgrades follow the live admin state, not a frozen-at-boot
      // snapshot. wsBridge polls `devProxyUpstreamFn` on each upgrade.
      const wsBridgeInit = opts.wsBridge
        ? {
            ...opts.wsBridge,
            devProxyUpstreamFn: () => devProxyRef.get()?.upstream,
          }
        : null;
      const bridge = wsBridgeInit
        ? createWsBridge({ ...wsBridgeInit, hostname, port })
        : null;
      const websocketHandler: WsHandlers | undefined = bridge?.websocket;
      // Bun's typed `Bun.serve` overloads disagree on the shape of
      // `websocket` (the WebSocket-enabled overload expects a richer
      // handler with `data`/`message`/`ping`/etc. typed against the
      // `data` generic). The runtime contract is the one in WsHandlers
      // — keep the type-erased `unknown` cast scoped to the call site.
      //
      // 2026-05-09 — `idleTimeout: 255` (Bun's max · seconds). Default
      // is 10s, which kills any request that takes longer to receive
      // a response — including Upstage Document AI OCR (15-60s for
      // typical photos), `/v1/notes/from-image` polish (LLM Vision
      // round-trip), `/v1/audio/stt` (Whisper transcription), large
      // `/v1/attachments` uploads, and long-running ACP turn replies.
      // Discovered when R-OCR.1 dogfood saw `Bun.serve: request timed
      // out after 10 seconds` in the test daemon log right after
      // every camera capture failed silently. Loopback / Tailnet
      // serve posture means no public exposure to slowloris-style
      // misuse — the trade-off favors finishing real work over a
      // strict idle-timeout default.
      const fetchOpts = {
        port,
        hostname,
        idleTimeout: 255,
        // Bun 기본 128 MB 로는 현장 업로드(파일 200 MB · 요청 500 MB · JSON base64)가 못 들어온다.
        maxRequestBodySize: FIELD_SERVER_MAX_BODY_BYTES,
        fetch: async (req: Request, srv: unknown) =>
          (await routeRequest(req, opts, srv as BunServerLike, bridge, devProxyRef, { hostname, port })) ??
          new Response(null, { status: 101 }),
        ...(websocketHandler ? { websocket: websocketHandler } : {}),
      } as unknown as Parameters<typeof Bun.serve>[0];
      server = Bun.serve(fetchOpts);
      // OB8 — this process now answers /v1/outbound itself; its own sendOutbound calls must not curl it.
      setInProcessOutbound(routeOutboundInProcess);
      // 데몬이 «실제로» 떴을 때만 재시작 복구(맡긴 일) — 주입된 러너(시험)는 건드리지 않는다.
      if (!opts.execRequests) { try { execRequestRunner().reconcileInterrupted(); } catch { /* 복구 실패가 서버 기동을 막지 않는다 */ } }
      resolvedPort = port;
      break;
    } catch (err) {
      // Bun.serve throws synchronously on EADDRINUSE — try next port.
      if (isPortBusy(err)) continue;
      throw err;
    }
  }

  if (!server || resolvedPort < 0) {
    throw new Error(
      `nexus http: no free port in range ${startPort}..${startPort + range - 1}`,
    );
  }

  const url = `http://${hostname}:${resolvedPort}`;
  return {
    port: resolvedPort,
    hostname,
    url,
    stop() {
      try { server!.stop(true); } catch { /* idempotent */ }
      setInProcessOutbound(null);
    },
  };
}

function isPortBusy(err: unknown): boolean {
  if (!err) return false;
  // Bun.serve errors expose `.code === 'EADDRINUSE'` (Node-compatible)
  // alongside an SDK-side `.errno`. Fall back to message-string match
  // for runtimes that only stringify.
  const e = err as { code?: string; errno?: number; message?: string };
  if (e.code === 'EADDRINUSE') return true;
  if (e.errno === -48 || e.errno === -98) return true;     // darwin / linux
  const msg = e.message ?? String(err);
  return /EADDRINUSE|address already in use/i.test(msg);
}

let execRequestRunnerInstance: ExecRequestRunner | undefined;
/** 게으른 한 벌 — import 만으로는 만들지 않는다(재시작 복구가 import 에 묶이지 않게). */
function execRequestRunner(): ExecRequestRunner {
  execRequestRunnerInstance ??= new ExecRequestRunner();
  return execRequestRunnerInstance;
}

export async function routeRequest(
  req: Request,
  opts: NexusHttpServerOpts,
  server: BunServerLike,
  bridge: ReturnType<typeof createWsBridge> | null,
  devProxyRef: DevProxyRuntimeRef,
  bind: { hostname: string; port: number } = {
    hostname: opts.hostname ?? '127.0.0.1',
    port: opts.startPort ?? DEFAULT_NEXUS_HTTP_PORT,
  },
): Promise<Response | undefined> {
  // Register peer context before any HTTP handler reaches checkAuth. Missing
  // requestIP is explicitly unknown so same-origin headers fail closed.
  registerAuthPeerAddress(req, (server as BunServerLike & {
    requestIP?: (request: Request) => { address: string } | null;
  }).requestIP?.(req)?.address);

  // PR c — try WS upgrade before HTTP routing. On undefined return the
  // bridge has accepted the upgrade (Bun completes the handshake) and
  // no Response is sent here. On a Response, the path matched a WS
  // endpoint but couldn't upgrade (e.g., adapter unavailable → 404).
  if (bridge) {
    const wsRes = bridge.tryUpgrade(req, server);
    if (wsRes !== undefined) return wsRes;
    // wsRes === undefined here covers both "upgraded successfully"
    // (path matched, Bun owns the response) and "path didn't match"
    // (continue HTTP routing). The path-match-but-upgraded case is
    // distinguished by Bun consuming the request — when upgrade()
    // returns true, the fetch handler's return is ignored. We pass
    // through to HTTP routing for the "path didn't match" case.
    const url = new URL(req.url);
    if (url.pathname === '/v1/acp' || url.pathname === '/v1/voice/ws') {
      // Path matched + bridge accepted → return undefined so Bun keeps
      // the upgraded socket. (Bun.serve's fetch handler is allowed to
      // return undefined when the socket has already been upgraded.)
      return undefined;
    }
  }
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // Default-deny for every `/v1/` path that is not on PUBLIC_ROUTES.
  // Reuses checkAuth (same-origin exemption + constant-time bearer).
  // setupMode is not implemented on this server (P24b) — pass false.
  // Per-route checkAuth calls below stay in place.
  // OPTIONS is a CORS preflight and cannot carry Authorization; existing
  // handlers answer it themselves, so the gate does not swallow it.
  // Without metaApi, only the owner bearer may reach these runtime-less
  // meta-API stubs. All other private paths remain default-denied.
  const runtimeLessMetaRoute = !opts.metaApi && (
    (method !== 'GET' && method !== 'OPTIONS'
      && (pathname === '/v1/nexus/tabs' || pathname.startsWith('/v1/nexus/tabs/')))
    || (method === 'GET' && (
      ['/v1/simulations', '/v1/tools', '/v1/intake', '/v1/sessions', '/v1/control-signals', '/v1/turns/last/screenshot'].includes(pathname)
      || pathname.startsWith('/v1/recordings/')
    ))
    || (method === 'POST' && (
      ['/v1/intake', '/v1/sessions/external', '/v1/control-signals', '/v1/prompt'].includes(pathname)
      || pathname.startsWith('/v1/hitl/callback/')
    ))
  );
  if (
    method !== 'OPTIONS'
    && pathname.startsWith('/v1/')
    && !isPublicRoute(method, pathname, { setupMode: false })
  ) {
    const fallbackToken = runtimeLessMetaRoute ? ensureAuthToken().token : undefined;
    const offered = req.headers.get('authorization');
    const fallbackAuthorized = fallbackToken !== undefined && offered?.startsWith('Bearer ') === true
      && compareTokenConstTime(offered.slice('Bearer '.length).trim(), fallbackToken);
    if (!(opts.metaApi ? checkAuth(req, opts.metaApi) : fallbackAuthorized)) {
      const name = method === 'POST' && (pathname === '/v1/tasks' || pathname === '/v1/reports/ingest') && opts.metaApi
        ? matchIngestAuthorization(req)?.name
        : undefined;
      if (name === undefined) {
        debug.log('nexus.auth', 'default-deny', { method, pathname });
        // MCP 클라이언트(Claude Code)에게는 «할 일»을 말한다 — 안 그러면 OAuth 로 가서 /register 405 를 만난다.
        if (pathname === '/v1/mcp') return mcpUnauthorizedResponse(new URL(req.url).origin);
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      debug.log('nexus.auth', 'ingest-token', { name, pathname });
    }
  }
  // OAuth 동적 클라이언트 등록(RFC 7591) — Elanous 는 OAuth 를 쓰지 않는다. 405 대신 «이렇게 등록하라»를 돌려준다.
  if (method === 'POST' && pathname === '/register') {
    debug.log('nexus.auth', 'oauth-register-rejected', { pathname });
    return oauthRegistrationRejected(new URL(req.url).origin);
  }

  // FU2 (2026-05-12) — root-level browser conveniences. The PWA serves
  // its assets under `/app/*`, but browsers still probe the origin root
  // for `/favicon.ico` and bookmark `/`. Without these two handlers the
  // network panel always carries a noisy 404 on every fresh load, and
  // typing the bare origin in the URL bar lands on a "not-found" JSON.
  //
  //   GET /favicon.ico       → 204 No Content (silences the probe;
  //                            the PWA's own icon is wired via manifest
  //                            for the installed app surface)
  //   GET /                  → 302 → /app/  (one-hop to the SPA entry)
  if (method === 'GET') {
    if (pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }
    if (pathname === '/' || pathname === '') {
      return new Response(null, { status: 302, headers: { location: '/app/' } });
    }
    // ★ 미션 e4f97b(external-markdown) — 게시된 정적 HTML 서빙. POST /v1/publish/markdown 의 게시→열람
    //   왕복 완성. 공개 서빙(게시물은 공개가 목적·dist OTA 처럼 tailscale 경계가 접근제어). 404/410 매핑.
    if (pathname.startsWith('/d/')) {
      const id = pathname.slice(3).split('/')[0] ?? '';
      const { handleMarkdownServe, getDefaultMarkdownPublishService } = await import('./markdown-publish.js');
      return handleMarkdownServe(id, getDefaultMarkdownPublishService());
    }
    // Stage B remote-install (2026-05-18) — ad-hoc IPA + manifest.plist
    // OTA distribution. iOS Safari can't attach a bearer header to the
    // itms-services:// manifest fetch, so these endpoints sit outside
    // the auth gate; the Tailscale tailnet boundary is the access
    // control surface. See src/nexus/api/dist.ts for the full why.
    if (pathname === MANIFEST_PATH) {
      const { handleDistManifest } = await import('./dist.js');
      return handleDistManifest(req);
    }
    if (pathname === `${IPA_PATH_PREFIX}install` || pathname === IPA_PATH_PREFIX) {
      const { handleDistInstallPage } = await import('./dist.js');
      return handleDistInstallPage(req);
    }
    if (pathname.startsWith(IPA_PATH_PREFIX) && pathname.endsWith('.ipa')) {
      const filename = decodeURIComponent(pathname.slice(IPA_PATH_PREFIX.length));
      const { handleDistIpa } = await import('./dist.js');
      return handleDistIpa(req, filename);
    }
  }

  if (pathname === LIVE_SHIPPED_PATH) {
    return handleLiveShipped(req, { authorize: (request) => !!opts.metaApi && checkAuth(request, opts.metaApi) });
  }
  if (pathname === LIVE_DETAIL_PATH) {
    return handleLiveDetail(req, {
      authorize: (request) => !!opts.metaApi && checkAuth(request, opts.metaApi),
    });
  }

  if (pathname === SEAT_REQUESTS_PATH) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleSeatRequests(req, opts.seatRequests);
  }

  if (pathname === CONSULT_REQUESTS_PATH) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleConsultRequests(req, opts.consultRequests);
  }

  if (pathname === '/v1/exec-requests' || pathname.startsWith('/v1/exec-requests/')) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    if (/^\/v1\/exec-requests\/[^/]+\/files\//.test(pathname)) {
      const credential = bearerCredential(req, opts.metaApi);
      if (credential !== 'bearer-match' && credential !== 'temp-token') return jsonResponse({ error: 'unauthorized' }, 401);
    }
    return handleExecRequests(req, opts.execRequests ?? execRequestRunner());
  }

  if (pathname === GRAPH_APPROVALS_PATH || pathname.startsWith(`${GRAPH_APPROVALS_PATH}/`)) {
    return handleGraphApprovals(req, {
      authorize: (request) => !!opts.metaApi && checkAuth(request, opts.metaApi),
      authReason: (request) => (opts.metaApi ? bearerCredential(request, opts.metaApi) : undefined),
    });
  }
  // 현장 업로드(owner 전용) — GET 목록 · POST 저장. 저장 규칙 정본 = src/field/field-media.ts.
  if ((pathname === FIELD_UPLOADS_PATH && (method === 'GET' || method === 'POST'))
    || ((pathname === FIELD_REEL_PATH || pathname === FIELD_REEL_FILE_PATH) && method === 'GET')) {
    return handleFieldUploads(req, {
      authorize: (request) => !!opts.metaApi && checkAuth(request, opts.metaApi),
      configuredEvent: () => { try { return getUserConfig().telegram?.fieldDefaultEvent; } catch { return undefined; } },
    });
  }
  if (pathname === APPROVALS_MERGES_PATH || pathname.startsWith(`${APPROVALS_MERGES_PATH}/`)) {
    return handleMergeApprovals(req, {
      authorize: (request) => !!opts.metaApi && checkAuth(request, opts.metaApi),
    });
  }

  if (pathname === MCP_RESOURCE_ROUTE_PATH && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'mcp-resource-route-not-wired' }, 503);
    return handleMcpResourceGet(req, {
      authorize: (request) => checkAuth(request, opts.metaApi!),
      getClients: () => opts.getMcpClients?.(),
    });
  }

  if (pathname === MCP_WIDGET_CALL_ROUTE_PATH && method === 'POST') {
    if (!opts.metaApi) return jsonResponse({ error: 'mcp-widget-call-route-not-wired' }, 503);
    return handleMcpWidgetCall(req, {
      authorize: (request) => checkAuth(request, opts.metaApi!),
      // Production boot supplies getMcpClients. A lone ready configured server
      // is the only trusted binding this route can infer without accepting a
      // request-provided server id; multiple servers fail closed until a caller
      // supplies an explicit trusted widget binding.
      getTrustedServerId: opts.getMcpWidgetServerId ?? (() => {
        const handle = opts.getMcpClients?.();
        if (!handle) return undefined;
        const readyServerIds = Object.entries(handle.perServer)
          .filter(([, server]) => server.status === 'ready')
          .map(([serverId]) => serverId);
        return readyServerIds.length === 1 ? readyServerIds[0] : undefined;
      }),
      getFeedbackEmitter: (sessionId) => {
        const { getActiveAcpFeedbackBroadcaster } = require('../../acp/server.js') as
          typeof import('../../acp/server.js');
        return createFeedbackEmitter(opts.eventBus, sessionId, getActiveAcpFeedbackBroadcaster() ?? undefined);
      },
      // ⛔⭐ 슬래시 명령으로 «시작한» 세션이 저장소에 안 생기던 자리(OBS-T521).
      //   클라이언트는 슬래시를 만나면 `/v1/prompt/stream` 을 건너뛰고 이 라우트로 곧장 온다 —
      //   그 경로엔 저장소로 가는 다리가 «없었다**. 📏 실기기 실측: `/video` 로 연 세션 둘 다
      //   `/v1/sessions/store/<id>` 404 ⊕ 목록에도 없음 ⇒ 앱을 다시 열면 대화가 사라졌다.
      persistTurn: persistWidgetTurnToSessionStore,
    });
  }

  // P-2D.2 — admin endpoint for hot-swapping the dev-proxy upstream.
  // GET / POST / DELETE all handled here (out of the GET-only block
  // because POST/DELETE need to dispatch ahead of the `if (method !==
  // 'GET')` mutation pass below). Loopback-only; same auth posture as
  // the rest of /v1/*.
  // MCP 전용 재장전 (대표 2026-09-10). GET-only 블록 «밖»이라 POST 가
  // 아래 mutation 관문보다 먼저 잡히며, 다른 privileged mutation처럼 bearer 인증을 요구한다.
  if (pathname === '/v1/nexus/admin/mcp-reload') {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    const mcpReloadRes = await tryHandleAdminMcpReload(req, url, {
      ...(opts.reloadMcpClients ? { reload: opts.reloadMcpClients } : {}),
    });
    if (mcpReloadRes) return mcpReloadRes;
  }

  if (pathname === '/v1/nexus/admin/pwa-dev-proxy') {
    return tryHandleAdminDevProxy(req, url, { ref: devProxyRef }).then((res) =>
      res ?? jsonResponse({ error: 'not-found' }, 404),
    );
  }

  if (pathname === OPENAI_RELAY_PATH && method === 'POST') {
    return tryHandleOpenAiRelay(req, url);
  }

  // Scheduler-retirement R2 (2026-05-11) — workflow-runtime daemon
  // webhook bridge. Catch-all `/v1/workflows/webhooks/<path>` for ALL
  // methods (the webhook trigger schema allows GET/POST/PUT/PATCH/
  // DELETE) so the route must dispatch before the GET-only block and
  // the `method !== 'GET'` mutation block both. Loopback bind +
  // workflow-level `auth` field enforces auth posture.
  // Surface-unification v2 (2026-05-11) — chat trigger dispatch.
  // V2.2-2 (2026-05-12) — hosted chat config lookup. GET-only.
  // `/v1/workflows/<name>/chat-config` returns the workflow's chat
  // trigger metadata so the PWA hosted page knows the POST path +
  // streaming + auth posture. Returns 404 when the workflow has no
  // chat trigger or hostedUi is off (the page renders an explanatory
  // message). No auth on this endpoint — it only leaks metadata that
  // a workflow author has opted into surfacing via `hostedUi.enabled`.
  {
    const match = /^\/v1\/workflows\/([^/]+)\/chat-config\/?$/.exec(pathname);
    if (match && method === 'GET') {
      const name = decodeURIComponent(match[1]!);
      const daemon = opts.workflowDaemon;
      if (!daemon?.chatConfig) return jsonResponse({ error: 'workflow-daemon-not-wired' }, 503);
      const cfg = daemon.chatConfig(name);
      if (!cfg) return jsonResponse({ error: 'not_found', workflow: name }, 404);
      return jsonResponse(cfg, 200);
    }
  }
  // M4-6 (2026-05-12) — workflow publish/draft lifecycle. Sibling
  // route to chat-config. GET reads current status (defaults 'active'),
  // PUT writes 'draft' | 'active'. Both methods handled before the
  // method!=='GET' mutation block so the PUT path doesn't fall
  // through to the 405 catch-all.
  {
    const match = /^\/v1\/workflows\/([^/]+)\/lifecycle\/?$/.exec(pathname);
    if (match && (method === 'GET' || method === 'PUT')) {
      const name = decodeURIComponent(match[1]!);
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      if (method === 'GET') {
        return handleWorkflowLifecycleGet(req, name, opts.metaApi);
      }
      return handleWorkflowLifecyclePut(req, name, opts.metaApi);
    }
  }
  // M4-4 (2026-05-12) — workflow pin data (fake node output for
  // debugging). Two route shapes: with + without nodeId. Handled
  // before method!=='GET' so PUT/DELETE don't fall through.
  {
    const listMatch = /^\/v1\/workflows\/([^/]+)\/pins\/?$/.exec(pathname);
    if (listMatch && (method === 'GET' || method === 'DELETE')) {
      const name = decodeURIComponent(listMatch[1]!);
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      if (method === 'GET') return handleWorkflowPinsList(req, name, opts.metaApi);
      return handleWorkflowPinDelete(req, name, undefined, opts.metaApi);
    }
    const itemMatch = /^\/v1\/workflows\/([^/]+)\/pins\/([^/]+)\/?$/.exec(pathname);
    if (itemMatch && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const name = decodeURIComponent(itemMatch[1]!);
      const nodeId = decodeURIComponent(itemMatch[2]!);
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      if (method === 'GET') return handleWorkflowPinGet(req, name, nodeId, opts.metaApi);
      if (method === 'PUT') return handleWorkflowPinPut(req, name, nodeId, opts.metaApi);
      return handleWorkflowPinDelete(req, name, nodeId, opts.metaApi);
    }
  }
  // `POST /v1/workflows/chat<path>` → daemon's chat router (matches by
  // chatTrigger.path). Caught BEFORE the webhook catch-all because the
  // chat router has its own auth + body contract. POST-only.
  if (pathname.startsWith('/v1/workflows/chat/') && method === 'POST') {
    const chatPath = pathname.slice('/v1/workflows/chat'.length); // leading '/'
    const daemon = opts.workflowDaemon;
    if (!daemon?.dispatchChat) {
      return jsonResponse({ error: 'workflow-daemon-not-wired' }, 503);
    }
    return req.json().then(async (body: unknown) => {
      const authorization = req.headers.get('authorization') ?? undefined;
      const res = await daemon.dispatchChat!({
        path: chatPath,
        ...(authorization ? { authorization } : {}),
        body: (body && typeof body === 'object' ? (body as { message?: string; sessionId?: string }) : {}),
      });
      if (!res) return jsonResponse({ error: 'workflow-daemon-not-started' }, 503);
      // Surface-unification v2.1 (2026-05-11) — SSE response when the
      // chat router returned a stream. Encode each frame as `event:
      // <name>\ndata: <body>\n\n` per the SSE wire spec.
      if (res.stream) {
        const encoder = new TextEncoder();
        // V2.2-1 (2026-05-12) — token frames carry raw chunks that may
        // contain `\n`. SSE wire requires each line to start with a
        // field name (`data:` etc.), so split multi-line data into one
        // `data:` line per source line — the receiving EventSource joins
        // them back with `\n` per the spec.
        const encodeFrame = (event: string, data: string): string => {
          const dataLines = data.split('\n').map(line => `data: ${line}`).join('\n');
          return `event: ${event}\n${dataLines}\n\n`;
        };
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const frame of res.stream!) {
                controller.enqueue(encoder.encode(encodeFrame(frame.event, frame.data)));
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              controller.enqueue(encoder.encode(encodeFrame('error', JSON.stringify({ error: msg }))));
            } finally {
              controller.close();
            }
          },
        });
        return new Response(body, {
          status: res.status,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }
      return jsonResponse(res.body, res.status);
    }).catch(() => jsonResponse({ error: 'bad_request', reason: 'JSON body required' }, 400));
  }

  if (pathname === '/v1/workflows/telegram-dispatch' && method === 'POST') {
    // 봇 프로세스가 부른다 — 웹훅과 달리 bearer 로 막는다(텔레그램 업데이트를 위조해 트리거를 쏘지 못하게).
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    const daemon = opts.workflowDaemon;
    if (!daemon?.dispatchTelegram) return jsonResponse({ error: 'workflow-daemon-not-wired' }, 503);
    return req.json().then(async (body: unknown) => {
      const event = parseTelegramDispatchEvent(body);
      if (!event) return jsonResponse({ error: 'bad_request', reason: 'event {kind, chat, user, body} required' }, 400);
      const results = await daemon.dispatchTelegram!(event);
      return jsonResponse({ results });
    }).catch(() => jsonResponse({ error: 'bad_request', reason: 'JSON body required' }, 400));
  }

  if (pathname.startsWith('/v1/workflows/webhooks/')) {
    const wfPath = pathname.slice('/v1/workflows/webhooks'.length); // includes leading '/'
    const daemon = opts.workflowDaemon;
    if (!daemon) {
      return jsonResponse({ error: 'workflow-daemon-not-wired' }, 503);
    }
    return req.text().then(async (body) => {
      const headersIn: Record<string, string | undefined> = {};
      req.headers.forEach((v, k) => { headersIn[k.toLowerCase()] = v; });
      const res = await daemon.dispatchWebhook({
        method,
        path: wfPath,
        headers: headersIn,
        body,
      });
      if (!res) {
        return jsonResponse({ error: 'workflow-daemon-not-started' }, 503);
      }
      return new Response(res.body, {
        status: res.status,
        headers: res.headers ?? { 'content-type': 'text/plain' },
      });
    });
  }

  // W9c Z13-d (#2445) — Device fleet is GET-only, so it must dispatch
  // before the mutation-only block below.
  if (isDevicesPath(pathname)) {
    if (!opts.devices) return jsonResponse({ error: 'devices-not-wired' }, 503);
    return handleDevices(req, opts.devices);
  }

  if (pathname === '/v1/harness/runs' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleHarnessRunsGet(req, opts.metaApi);
  }

  if (pathname === '/v1/harness/ask-status' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleHarnessAskStatusGet(req, opts.metaApi);
  }

  if (pathname === '/v1/harness/run-screen' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleHarnessRunScreenGet(req, opts.metaApi);
  }

  if (pathname === '/v1/harness/run-events' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleHarnessRunEventsGet(req, opts.metaApi);
  }

  // Design direction is a write: check owner auth before the handler reads the body.
  // Keep this POST ahead of the mutation fallback, and never make it a public route.
  if (method === 'POST' && pathname === DESIGN_DIRECTION_PATH) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleDesignDirectionPost(req);
  }
  // Custom system create is a write that launches an extract. Auth before the body.
  // The default-deny gate above already refuses anonymous /v1 writes; this check
  // stays so a future gate change cannot reach the extractor without an owner.
  if (method === 'POST' && pathname === DESIGN_SYSTEM_PATH) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    // Same-origin exemption is enough for a direction pick. An extract writes a
    // library and launches Chrome, so it also requires the owner bearer.
    const owner = opts.metaApi.bearerToken;
    const offered = (req.headers.get('authorization') ?? '').startsWith('Bearer ')
      ? (req.headers.get('authorization') ?? '').slice('Bearer '.length).trim()
      : '';
    if (!owner || offered.length !== owner.length) return jsonResponse({ error: 'unauthorized' }, 401);
    let bearerDiff = 0;
    for (let i = 0; i < offered.length; i += 1) bearerDiff |= offered.charCodeAt(i) ^ owner.charCodeAt(i);
    if (bearerDiff !== 0) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleDesignSystemCreate(req);
  }

  if (method === 'POST' && pathname === '/v1/graphs/validate') {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleGraphsValidatePost(req, opts.metaApi);
  }

  if (pathname === '/v1/config/chat-fast-path' && (method === 'GET' || method === 'PUT')) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleChatFastPathConfig(req);
  }

  // Mutation routes (PR ι) — POST/PATCH/DELETE on /v1/nexus/tabs[/:id[/action]].
  // Templates POST handled here too (PR κ).
  // Config / secrets PUT/POST/DELETE here too (PR μ).
  if (method !== 'GET') {
    if (method === 'POST' && pathname === '/v1/plugins/install') {
      if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
      return handlePluginsInstall(req, opts.metaApi, opts.pluginStateRoot);
    }
    const marketRefresh = /^\/v1\/plugins\/markets\/([^/]+)\/refresh$/.exec(pathname);
    if (method === 'POST' && marketRefresh) {
      if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
      return handlePluginsMarketRefresh(req, marketRefresh[1]!, opts.metaApi, { root: opts.pluginStateRoot });
    }
    const pluginCredentials = /^\/v1\/plugins\/([^/]+)\/credentials$/.exec(pathname);
    if (method === 'PUT' && pluginCredentials) {
      if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
      return handlePluginsCredentialsPut(req, pluginCredentials[1]!, opts.metaApi, opts.pluginStateRoot, opts.reloadMcpClients);
    }
    const pluginRemove = /^\/v1\/plugins\/([^/]+)$/.exec(pathname);
    if (method === 'DELETE' && pluginRemove) {
      if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
      return handlePluginsRemove(req, pluginRemove[1]!, opts.metaApi, opts.pluginStateRoot);
    }
    if ((method === 'PUT' || method === 'POST') && pathname.startsWith('/v1/graphs/')) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const mutated = await handleGraphsMutation(pathname, req);
      if (mutated) return mutated;
    }
    if (method === 'POST' && pathname === '/v1/tasks') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      return handleTaskCreatePost(req, opts.metaApi);
    }
    // ER2 — error reports forwarded by the bot VM (ingest token · same as /v1/tasks).
    if (method === 'POST' && pathname === '/v1/reports/ingest') return handleErrorReportIngest(req);
    if (method === 'POST' && pathname.startsWith('/v1/tasks/') && pathname.endsWith('/approve')) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      let taskId: string;
      try { taskId = decodeURIComponent(pathname.slice('/v1/tasks/'.length, -'/approve'.length)); }
      catch { return jsonResponse({ error: 'bad_request', reason: 'invalid taskId' }, 400); }
      if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
        return jsonResponse({ error: 'bad_request', reason: 'invalid taskId' }, 400);
      }
      return handleTaskApprovePost(req, taskId, opts.metaApi);
    }
    // Pod grok access 재발급. 넥서스 bearer 가 아니라 llm-credential 토큰을 본문 파싱 전에 검증한다.
    if (pathname === POD_CREDENTIAL_GROK_PATH && method === 'POST') {
      const gate = await authenticatePodCredential(req);
      if (!gate.ok) return gate.response;
      return handlePodGrokCredential(req);
    }
    if (pathname === POD_CREDENTIAL_GITHUB_PATH && method === 'POST') {
      const gate = await authenticatePodCredential(req, {}, 'gh-credential');
      if (!gate.ok) return gate.response;
      return handlePodGithubCredential(req);
    }
    if (pathname === '/v1/harness/ask' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleHarnessAskPost(req, opts.metaApi, {
        createFeedbackEmitter: (acceptanceId) => createFeedbackEmitter(opts.eventBus, acceptanceId, undefined),
      });
    }
    if (pathname === '/v1/harness/stop' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      if (!checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleHarnessStopPost(req, opts.metaApi);
    }
    {
      const controlId = parseTerminalControlPath(pathname);
      if (controlId !== null && method === 'POST') {
        if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
        return handleTerminalControl(req, opts.metaApi, controlId);
      }
    }
    {
      const renameId = parseTerminalRenamePath(pathname);
      if (renameId !== null && method === 'POST') {
        if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
        return handleTerminalRename(req, opts.metaApi, renameId);
      }
    }
    if (parseTerminalsPrunePath(pathname) && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalsPrune(req, opts.metaApi);
    }
    {
      const terminateId = parseTerminalTerminatePath(pathname);
      if (terminateId !== null && method === 'POST') {
        if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
        return handleTerminalTerminate(req, opts.metaApi, terminateId);
      }
    }
    if (pathname === SESSION_TURN_CONTROL_PATH && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleSessionTurnControl(req);
    }
    if (pathname === '/v1/nexus/templates' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleTemplateSave(req, opts.registry);
    }
    // ROADMAP-ipad-companion-autopilot-priority §D2.0 — autopilot SSE
    // entry. iOS / PWA POST a mission + budget envelope and consume the
    // envelope/update/result stream. Placed inside the `method !== 'GET'`
    // block per memory `feedback_post_route_must_be_in_method_block`.
    if (pathname === '/v1/autopilot/run' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const { handleAutopilotRun } = await import('./autopilot-handler.js');
      return handleAutopilotRun(req);
    }
    // ★ 미션 e4f97b(external-markdown publishing) 배선 마무리 — orphan 이던 MarkdownPublisher +
    //   createGlobalRequestLimiter 를 POST 라우트로 소비. limiter(rate/concurrency) 통과 후 게시.
    //   method!=='GET' 블록 내(feedback_post_route_must_be_in_method_block).
    if (pathname === '/v1/publish/markdown' && method === 'POST') {
      // ★ 보안(SECURITY-external-publishing-tailscale-s3) — 게시는 mutation·인증 필수(무인증 시 DoS/악성콘텐츠).
      //   GET /d/:id(프리뷰)는 tailnet 경계라 open 유지하되, POST 게시는 bearer 게이트.
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const { handleMarkdownPublish, getDefaultMarkdownPublishService } = await import('./markdown-publish.js');
      return req.text().then((b) => handleMarkdownPublish(b, getDefaultMarkdownPublishService()));
    }
    // PLAN-autopilot-terminal-driving-2026-05-20 v2 Phase B (2026-05-20) —
    // mid-mission user instruction injection. Active-run registry lives
    // in autopilot-handler module-level Map. Path = /v1/autopilot/<runId>/inject.
    // Placed inside the `method !== 'GET'` block per memory
    // `feedback_post_route_must_be_in_method_block`.
    {
      const injectMatch = /^\/v1\/autopilot\/([^/]+)\/inject$/.exec(pathname);
      if (injectMatch && method === 'POST') {
        const runId = injectMatch[1]!;
        const { handleAutopilotInject } = await import('./autopilot-handler.js');
        return handleAutopilotInject(req, runId);
      }
    }
    // Stage B debug bundle (2026-05-18) — POST symptom + iOS app log;
    // daemon stitches in its own ~/.elanous/log/debug-*.log tail, uploads
    // markdown bundle to S3 under `debug-bundle/`, returns public URL
    // + paste-ready prompt. Placed inside the `method !== 'GET'` block
    // per memory `feedback_post_route_must_be_in_method_block`.
    if (pathname === '/v1/debug-bundle' && method === 'POST') {
      const { handleDebugBundlePost } = await import('./debug-bundle.js');
      return handleDebugBundlePost(req);
    }
    // B 트랙 closure piece (RFC #2474) — MCP Streamable HTTP transport.
    // External MCP clients (Claude Code · Cursor · Codex) register elanous
    // via `claude mcp add --transport http elanous http://localhost:31415/v1/mcp --header "Authorization: Bearer <acp-token>"`
    // (토큰 없이 붙이면 401 → Claude Code 가 OAuth 를 시도한다 — mcp-oauth-hint.ts)
    // and reach the NEXUS daemon's ToolRuntime registry directly — no
    // child process spawn (cf. `elanous mcp serve` stdio · #2485), every
    // call flows through the PFC capture seam. Placed inside the
    // `method !== 'GET'` block per memory
    // `feedback_post_route_must_be_in_method_block`.
    if (pathname === '/v1/mcp' && method === 'POST') {
      const peer = (server as BunServerLike & {
        requestIP?: (request: Request) => { address: string } | null;
      }).requestIP?.(req);
      return handleMcpHttpPost(req, {
        ...(peer ? { peerAddress: peer.address } : {}),
        binding: bind,
      });
    }
    // B 트랙 Post-Closure (2026-05-13) — REST shim for the ToolRuntime
    // registry. Sibling to `/v1/mcp` JSON-RPC but invocable from
    // non-MCP callers (iOS Shortcuts · shell / Makefile · n8n /
    // Zapier · webhook receivers) without an envelope dance. Must
    // live inside the `method !== 'GET'` block per memory
    // `feedback_post_route_must_be_in_method_block`. Sibling GET
    // listing route lives further down in the GET block.
    {
      const restToolId = parseRuntimeToolCallPath(pathname);
      if (restToolId !== null && method === 'POST') {
        if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
        return handleRuntimeToolCall(req, opts.metaApi, restToolId);
      }
    }
    // ⛔ 설정 쓰기 여섯(스위치·모델 티어·LLM provider·LLM 호스트·회전·미션 제어)은 인증 없이 핸들러에 닿았다
    //   (2026-09-26 🅢 비파괴 탐침: 무인증 PUT → 404/400 · 같은 조건 /v1/config/secrets → 401). PWA 는 same-origin 으로 통과.
    if (pathname.startsWith('/v1/config/switches/') && method === 'PUT') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const switchId = pathname.slice('/v1/config/switches/'.length);
      return handleSwitchPut(req, makeConfigCtx(opts), switchId);
    }
    if (pathname === '/v1/config/secrets' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleSecretPost(req);
    }
    // M1-2b — friction-free model selection root-level sub-tree
    // (`modelTier` / `budget` / `smartDefaults`). PUT merges supplied
    // sub-trees into UserConfig (Path A). Validation lives in the
    // handler so invalid tier strings can't pollute the file.
    if (pathname === '/v1/config/model-tier' && method === 'PUT') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const { handleModelTierPut } = await import('./config-model-tier.js');
      return handleModelTierPut(req);
    }
    // M3-3 (Phase 3) — NL chat tier intent. Detect-only by default ·
    // applies a session-scoped override when `apply: true`. Session
    // overrides auto-revert on TTL (default 8h) or explicit clear.
    if (pathname === '/v1/chat/tier-intent' && method === 'POST') {
      const { handleChatTierIntentPost } = await import('./chat-tier-intent.js');
      return handleChatTierIntentPost(req);
    }
    if (pathname === '/v1/nexus/edit-in-pwa' && method === 'POST') {
      if (!opts.editInPwa) return jsonResponse({ error: 'edit-in-pwa-disabled' }, 503);
      return handleEditInPwaPost(req, opts.editInPwa);
    }
    if (pathname === '/v1/nexus/edit-in-pwa/consume' && method === 'POST') {
      if (!opts.editInPwa) return jsonResponse({ error: 'edit-in-pwa-disabled' }, 503);
      return handleEditInPwaConsume(req, opts.editInPwa);
    }
    // R6 Task 5 · §6.1 (2026-05-09) — LLM-judge hybrid classifier.
    // POST + OPTIONS preflight (PWA dev mode is cross-origin).
    if (pathname === '/v1/showroom/role-judge' && (method === 'POST' || method === 'OPTIONS')) {
      return handleRoleJudge(req);
    }
    // R6 FU.2 · §6.3 audio bridge (2026-05-09) — multipart audio →
    // OpenAI Whisper transcript (TUI cloud reuse).
    // POST + OPTIONS preflight (PWA dev mode is cross-origin).
    if (pathname === '/v1/audio/stt' && (method === 'POST' || method === 'OPTIONS')) {
      return handleAudioStt(req);
    }
    // micro.3 (2026-05-09) — LLM model list proxy (LM Studio /v1/
    // models). OPTIONS handled here so the PWA dropdown can preflight
    // a cross-origin GET (the actual GET sits in the GET-only block).
    if (pathname === '/v1/llm/models' && method === 'OPTIONS') {
      return handleLlmModels(req);
    }
    // FU.A3 (2026-05-09) — multi-host config hot-reload. OPTIONS +
    // PUT + DELETE in the mutation block; GET sits in the GET-only
    // block alongside /v1/llm/models.
    if (pathname === '/v1/llm/hosts' && (method === 'OPTIONS' || method === 'PUT' || method === 'DELETE')) {
      if (method !== 'OPTIONS') { if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401); }
      return handleLlmHostsConfig(req);
    }
    // iOS Phase 1.5 (2026-05-13) — provider rotation advance. POST
    // here in the mutation block (memory `feedback_post_route_must_be_in_method_block`),
    // GET sibling in the GET block below.
    if (pathname === '/v1/llm/rotation/next' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'POST') { if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401); }
      return handleLlmRotationNext(req);
    }
    if (pathname === '/v1/llm/rotation' && method === 'OPTIONS') {
      return handleLlmRotationGet(req);
    }
    // PWA `/setup` wizard Phase 1 (2026-05-19) — LLM provider 첫 셋업.
    // POST 는 mutation 블록 안에서 등록 (memory `feedback_post_route_must_be_in_method_block`).
    // GET sibling 은 아래 GET-only 블록에 등록.
    if (pathname === '/v1/setup/llm-provider' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'POST') { if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401); }
      return handleLlmProviderSet(req);
    }
    if (pathname === '/v1/setup/llm-providers' && method === 'OPTIONS') {
      return handleLlmProvidersList(req);
    }
    if (pathname === '/v1/setup/obsidian' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') return corsPreflight('POST, OPTIONS');
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleObsidianSet(req);
    }
    if (pathname === '/v1/setup/skills' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') return corsPreflight('POST, OPTIONS');
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleSkillsSet(req);
    }
    if (pathname === '/v1/setup/obsidian-skills' && method === 'OPTIONS') return corsPreflight('GET, OPTIONS');
    if (pathname === '/v1/setup/channel-bot' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') return corsPreflight('POST, OPTIONS');
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleChannelBotSet(req);
    }
    if (pathname === '/v1/setup/channel-bots' && method === 'OPTIONS') return corsPreflight('GET, OPTIONS');
    if ((pathname === '/v1/setup/child-llm' || pathname === '/v1/setup/answer-priority')
      && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') return corsPreflight('GET, POST, OPTIONS');
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return pathname === '/v1/setup/child-llm' ? handleChildLlmSet(req) : handleAnswerPrioritySet(req);
    }
    // PWA `/settings` Phase 3 (2026-05-19) — persona description PATCH.
    // dispatchPersonaRoute 가 PATCH 분기를 자체 처리. GET sibling 은
    // 아래 GET-only 블록의 기존 /v1/personas 핸들러.
    if (pathname.startsWith('/v1/personas/') && method === 'PATCH') {
      const result = await dispatchPersonaRoute(req, pathname);
      if (result) return result;
    }
    // P1-4 (2026-05-14) — mission router prediction. POST lives in the
    // mutation block (memory `feedback_post_route_must_be_in_method_block`).
    // FU1 (2026-05-14) — match path-only here so GET/PUT/DELETE/PATCH
    // reach the handler and get a proper 405 (with Allow semantics)
    // instead of falling through to the catch-all 404. The handler
    // itself rejects non-POST/OPTIONS — same surface as `/v1/llm/rotation`
    // siblings.
    if (pathname === '/v1/llm/route/predict') {
      return handleLlmRoutePredict(req, { missionRouter: opts.missionRouter });
    }
    // T4.D — mint a copy-friendly bearer for paste-on-other-device.
    // connect-info.ts promises this route is already-authenticated only;
    // the gate lives here (same pattern as SESSION_TURN_CONTROL_PATH /
    // /v1/publish/markdown). handleConnectTokenMint itself does not check.
    if (pathname === '/v1/nexus/connect-info/mint-token' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const ci = opts.connectInfo;
      const ctx: ConnectInfoCtx = {
        hostname: bind.hostname,
        port: bind.port,
        nexusVersion: ci?.nexusVersion ?? opts.state.nexusVersion ?? '0.0.0',
        ...(ci?.serverLabel !== undefined ? { serverLabel: ci.serverLabel } : {}),
        ...(ci?.acpTokenPath !== undefined ? { acpTokenPath: ci.acpTokenPath } : {}),
        ...(ci?.acpTokenOverride !== undefined ? { acpTokenOverride: ci.acpTokenOverride } : {}),
      };
      return handleConnectTokenMint(ctx);
    }
    if (pathname.startsWith('/v1/nexus/errors') && method === 'DELETE') {
      const parsed = parseErrorsPath(pathname);
      if (parsed?.tabId && parsed.ts) return handleErrorDismiss(parsed.tabId, parsed.ts);
      return jsonResponse({ error: 'tab-id-and-ts-required' }, 400);
    }
    if (pathname.startsWith('/v1/config/secrets/') && method === 'DELETE') {
      const id = pathname.slice('/v1/config/secrets/'.length);
      return handleSecretDelete(id);
    }
    // RFC #2161 Phase 6 — POST trigger for an on-demand discovery run.
    if (pathname === '/v1/registry/discovery' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      // ⭐ 요청의 abort 신호를 «실제로» 잇는다. 이게 없으면 취소 전파는 시험에서만
      //    도는 배관이고, 클라이언트가 끊어도 서버는 상한을 다 기다린다.
      return handleDiscoveryRun({ discovery: { signal: req.signal } });
    }
    // RFC #2161 Phase 5 — manual disable / enable per-provider.
    if (pathname.startsWith('/v1/registry/resolved/') && method === 'PUT') {
      const tail = pathname.slice('/v1/registry/resolved/'.length);
      const sep = tail.indexOf('/');
      if (sep > 0 && tail.slice(sep) === '/disable') {
        const providerId = decodeURIComponent(tail.slice(0, sep));
        return handleRegistryProviderDisable(req, providerId);
      }
    }
    // PR τ — /v1/registry/bindings/:channel/:key {POST|PATCH|DELETE}
    if (pathname.startsWith('/v1/registry/bindings')) {
      const parsed = parseBindingPath(pathname);
      if (parsed?.channel && parsed?.key) {
        if (method === 'POST') return handleBindingPost(req, parsed.channel, parsed.key);
        if (method === 'PATCH') return handleBindingPatch(req, parsed.channel, parsed.key);
        if (method === 'DELETE') return handleBindingDelete(parsed.channel, parsed.key);
      }
    }
    // PR d · meta-API mutations (push subscribe / unsubscribe / test ·
    // voice transcribe · attachment upload). Returns 503 when the boot
    // orchestrator hasn't wired `metaApi` opts yet.
    if (opts.metaApi) {
      if (pathname === '/v1/push/subscribe' && method === 'POST') {
        return handleSubscribePush(req, opts.metaApi);
      }
      if (pathname.startsWith('/v1/push/subscribe/') && method === 'DELETE') {
        const id = pathname.slice('/v1/push/subscribe/'.length);
        return handleUnsubscribePush(req, id, opts.metaApi);
      }
      if (pathname === '/v1/push/test' && method === 'POST') {
        return handleTestPush(req, opts.metaApi);
      }
      if (pathname === '/v1/voice/transcribe' && method === 'POST') {
        return handleVoiceTranscribe(req, opts.metaApi);
      }
      if (pathname === '/v1/attachments' && method === 'POST') {
        return handleAttachmentUpload(req, opts.metaApi);
      }
      // IPC followup (2026-05-13) — universal agent.status push seam.
      if (pathname === '/v1/agent-status' && method === 'POST') {
        return handleAgentStatusPost(req, opts.metaApi);
      }
      // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — universal
      // hud.segment push seam (dashboard mirror · sidecar tools etc).
      if (pathname === '/v1/hud-segment' && method === 'POST') {
        return handleHudSegmentPost(req, opts.metaApi);
      }
    } else if (
      pathname === '/v1/push/subscribe'
      || pathname.startsWith('/v1/push/subscribe/')
      || pathname === '/v1/push/test'
      || pathname === '/v1/voice/transcribe'
      || pathname === '/v1/attachments'
      || pathname === '/v1/agent-status'
      || pathname === '/v1/hud-segment'
    ) {
      return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    }
    // R3 v1 fix (2026-05-09 dogfood) — POST /v1/notification-action.
    // The original PR placed this route after the `method !== 'GET'`
    // block ended, so POST requests fell through to the 405 catch-
    // all. The unit test calls `handleNotificationAction` directly
    // and bypassed the http-server routing — only end-to-end
    // dogfood (curl POST hitting the daemon) surfaced the regression.
    if (pathname === '/v1/notification-action' && method === 'POST' && opts.intentPrediction) {
      return handleNotificationAction(req, {
        service: opts.intentPrediction,
        ...(opts.notificationActionLoopback ? { loopback: opts.notificationActionLoopback } : {}),
      });
    }
    // R-OCR.1.2 (2026-05-09) — POST /v1/notes/from-image (camera →
    // OCR → markdown). Lives inside the method!=='GET' block per
    // feedback_post_route_must_be_in_method_block lesson (#2123 R3 +
    // #2047 intent-feedback both placed POST routes outside this
    // guard and silently 405'd until end-to-end curl surfaced it).
    // OPTIONS handled in the handler itself for PWA dev-mode cross-
    // origin preflight (matches /v1/showroom/role-judge sibling).
    if (pathname === '/v1/notes/from-image' && (method === 'POST' || method === 'OPTIONS')) {
      if (!opts.notesFromImage) return jsonResponse({ error: 'notes-from-image-not-wired' }, 503);
      return handleNotesFromImage(req, opts.notesFromImage);
    }
    // R-OCR follow-up — POST /v1/notes/from-images (plural · batch).
    // Same multipart shape, repeated `image` + `filename` fields per
    // entry. Sibling registration to /v1/notes/from-image so audits
    // see the cluster + same `method !== 'GET'` guard placement.
    if (pathname === '/v1/notes/from-images' && (method === 'POST' || method === 'OPTIONS')) {
      if (!opts.notesFromImages) return jsonResponse({ error: 'notes-from-images-not-wired' }, 503);
      return handleNotesFromImages(req, opts.notesFromImages);
    }
    // R-OCR.3.2 (2026-05-09) — POST /v1/notes/save (review modal
    // Confirm → vault write). Same `method !== 'GET'` placement as
    // /v1/notes/from-image · companion endpoint registered next to
    // it so audits see the cluster.
    if (pathname === '/v1/notes/save' && (method === 'POST' || method === 'OPTIONS')) {
      if (!opts.notesSave) return jsonResponse({ error: 'notes-save-not-wired' }, 503);
      return handleNotesSave(req, opts.notesSave);
    }
    // PR Y2 (PLAN §5 popup synergy follow-up · 2026-05-17) — POST
    // /v1/image/generate (iPad CodeMirror editor "+AI Image" toolbar).
    // gpt-image-2 wrapper + vault attachments PNG write. Same cluster
    // as notes-save so audits see the vault-write endpoints together.
    if (pathname === '/v1/image/generate' && (method === 'POST' || method === 'OPTIONS')) {
      if (!opts.imageGenerate) return jsonResponse({ error: 'image-generate-not-wired' }, 503);
      return handleImageGenerate(req, opts.imageGenerate);
    }
    // B3 / Y2 follow-up (2026-05-17) — POST /v1/image/edit (iPad
    // image regenerate button). OpenAI Images Edits endpoint. Reuses
    // the imageGenerate opts (vault + OPENAI_API_KEY + fetchFn) so no
    // separate wire surface needed.
    if (pathname === '/v1/image/edit' && (method === 'POST' || method === 'OPTIONS')) {
      if (!opts.imageGenerate) return jsonResponse({ error: 'image-generate-not-wired' }, 503);
      return handleImageEdit(req, opts.imageGenerate);
    }
    // R-OCR.4.2 (2026-05-09) — POST /v1/metrics/notes-event for PWA
    // -side events (cancel/edit/discard). Same `method !== 'GET'`
    // placement as the rest of the camera-notes cluster. The GET
    // snapshot endpoint sits in the GET-only block further down.
    if (pathname === '/v1/metrics/notes-event' && (method === 'POST' || method === 'OPTIONS')) {
      return handleNotesMetricsEvent(req, opts.notesMetrics ?? {});
    }
    // R5.4 (2026-05-09) — POST /v1/sessions/:id/decision (PWA
    // card deck swipe). Sibling to /v1/sessions/active (GET).
    {
      const sessId = parseSessionDecisionPath(pathname);
      if (sessId !== null && (method === 'POST' || method === 'OPTIONS')) {
        return handleSessionsDecision(req, sessId, opts.sessionsDecision ?? {});
      }
    }
    // Cascade-zyu W1 U0 (2026-05-12) — POST /v1/user-intents/emit.
    // PWA / iOS / Watch / AirPods bridges forward UserIntentEventInput
    // here; in-process surfaces (TUI / Discord / Telegram) call
    // `userIntentLogger().emit(...)` directly. Lives inside the
    // method!=='GET' block per the lesson from R3 + intent-feedback
    // (POST routes outside this guard silently 405).
    if (pathname === '/v1/user-intents/emit' && (method === 'POST' || method === 'OPTIONS')) {
      return handleUserIntentEmit(req);
    }
    // PR D (2026-05-15 iOS cascade) — POST /v1/user-intents/batch.
    // iOS UserIntentForwarder 의 50 ms coalesce flush 대상. 단일 emit 의
    // batched variant · 같은 logger.emit() path → 같은 JSONL line.
    if (pathname === '/v1/user-intents/batch' && (method === 'POST' || method === 'OPTIONS')) {
      return handleUserIntentBatch(req);
    }
    // PR D-2 (2026-05-15 iOS cascade) — POST /v1/debug-logs/batch.
    // iOS DebugLogForwarder 의 50 ms coalesce flush 대상 · LogRecord JSONL
    // 을 `~/.elanous/debug-tap/<date>.jsonl` 에 append.
    if (pathname === '/v1/debug-logs/batch' && (method === 'POST' || method === 'OPTIONS')) {
      return handleDebugLogsBatch(req);
    }
    // W7 Z11.a-1 — outbound device token registry. GET allowed for the
    // counts debug surface; POST/DELETE for mutation. Wired only when
    // opts.outboundTokens carries a tokenStore (runNexus boot).
    if (pathname === '/v1/devices/tokens') {
      if (!opts.outboundTokens) return jsonResponse({ error: 'outbound-tokens-not-wired' }, 503);
      return handleOutboundTokens(req, opts.outboundTokens);
    }
    // ── Cascade-zyu W9 / W9b / W9c endpoint dispatch (W9d-FU 2026-05-12) ──
    //
    // Each block: pathname-match → 503 when opts.<field> is undefined →
    // handler invocation. Handlers do their own method check internally
    // so the dispatch is method-agnostic here.

    // W9 Z4 (#2428) — Approval Showroom (GET).
    const approvalRunId = parseApprovalShowroomPath(pathname);
    if (approvalRunId !== null) {
      if (!opts.approvalShowroom) return jsonResponse({ error: 'approval-showroom-not-wired' }, 503);
      return handleApprovalShowroom(req, approvalRunId, opts.approvalShowroom);
    }
    // W9 Z6 (#2429) — Workflow Design Studio (POST).
    const workflowDesignName = parseWorkflowDesignPath(pathname);
    if (workflowDesignName !== null) {
      if (!opts.workflowDesign) return jsonResponse({ error: 'workflow-design-not-wired' }, 503);
      return handleWorkflowDesign(req, workflowDesignName, opts.workflowDesign);
    }
    // W9b Z2 (#2439) — Mission Deliberation Room (4 sub-routes).
    const missionShowroomRoute = parseMissionShowroomPath(pathname);
    if (missionShowroomRoute !== null) {
      if (!opts.missionShowroom) return jsonResponse({ error: 'mission-showroom-not-wired' }, 503);
      return handleMissionShowroom(req, missionShowroomRoute, opts.missionShowroom);
    }
    // W9c Z13-d (#2445) — Template capability preview.
    // cascade-zyu W8-A 옵션 A — POST /v1/missions/test mock emitter.
    if (isMissionsTestPath(pathname)) {
      if (!opts.missionsTest) return jsonResponse({ error: 'missions-test-not-wired' }, 503);
      return handleMissionsTest(req, opts.missionsTest);
    }
    // W8-A 후속 #5 (2026-05-14) — GET /v1/agent-cli/conversation-stats?chatId=
    // per-backend usage count for iOS picker hint. 사용자 prior pattern visibility.
    if (isConversationStatsPath(pathname)) {
      return handleConversationStats(req);
    }
    if (isTemplateCapabilityPreviewPath(pathname)) {
      if (!opts.devices) return jsonResponse({ error: 'devices-not-wired' }, 503);
      return handleTemplateCapabilityPreview(req, opts.devices);
    }
    // W9c Z13-a (#2447) — Next-Scenario Fluent preview (POST).
    if (isNextFluentPreviewPath(pathname)) {
      if (!opts.nextFluent) return jsonResponse({ error: 'next-fluent-not-wired' }, 503);
      return handleNextFluentPreview(req, opts.nextFluent);
    }
    // 2026-07-15 — Next-Fluent 칩 1-클릭 액션 실행(POST {refId, action}).
    if (isNextFluentDispatchPath(pathname)) {
      if (!opts.nextFluent) return jsonResponse({ error: 'next-fluent-not-wired' }, 503);
      return handleNextFluentDispatch(req, opts.nextFluent);
    }
    // W9c Z13-c (#2448) — Morning Showroom + Idle Nudge (POST each).
    if (isMorningShowroomPath(pathname)) {
      if (!opts.morningShowroom) return jsonResponse({ error: 'morning-showroom-not-wired' }, 503);
      return handleMorningShowroom(req, opts.morningShowroom);
    }
    if (isIdleNudgePath(pathname)) {
      if (!opts.idleNudge) return jsonResponse({ error: 'idle-nudge-not-wired' }, 503);
      return handleIdleNudge(req, opts.idleNudge);
    }
    // SAME bug, older surface — the existing
    // `/v1/intent-prediction/:sessionId/feedback` POST route
    // (PR #2047 · landed 2026-05-08) was placed in the GET-only
    // region too. GET snapshot + GET sse worked because GETs skip
    // the method!=='GET' block entirely; the POST feedback path
    // never had an end-to-end test (the unit test calls the handler
    // directly · skipHttpServer=true on the runNexus integration
    // test). The 2026-05-09 dogfood that caught the R3 routing bug
    // surfaced this one immediately after — same pattern, same
    // root cause. Re-dispatch here for POST so the existing
    // dispatch's method-check returns 200 instead of the catch-all
    // 405.
    if (pathname.startsWith('/v1/intent-prediction/') && opts.intentPrediction) {
      const result = await dispatchIntentPredictionRoute(req, url, {
        service: opts.intentPrediction,
      });
      if (result) return result;
    }
    // PR e/k · intake / sessions / control-signals mutations. When
    // `metaApi` opts include the relevant runtime field (intakeStore /
    // history) the dispatcher fires; otherwise 503 not-wired so PWA
    // cutover (PR a) sees a stable error rather than 404.
    if (pathname === '/v1/intake' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleIntakePost(req, opts.metaApi);
    }
    // FU3 (2026-05-12) — Phase 1 pipeline wire smoke. Runs decompose →
    // enrich → categorize → goal_align → multi_spec end-to-end through
    // skeleton fallbacks so the PWA can call it without LLM/plugin
    // provisioning first. `register: true` writes Mission + Task rows
    // into an in-memory store and returns the ids (user's TOX
    // untouched). Real LLM/plugins land in a follow-up PR.
    if (pathname === '/v1/intake/pipeline-preview' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleIntakePipelinePreviewPost(req, opts.metaApi);
    }
    // FU-I7c (2026-05-12) — sibling of pipeline-preview that writes to
    // the user's real TaskStore (`~/.elanous/tasks/tasks.db`) + persists
    // workflow YAMLs to `~/.elanous/workflows/`. PWA register flow flips
    // to this path once the user has confirmed the preview cards.
    if (pathname === '/v1/intake/pipeline-commit' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleIntakePipelineCommitPost(req, opts.metaApi);
    }
    // I1 — 판정만. `/v1/intake/` 세션 id 캐치올보다 앞에 둔다(pipeline-preview 와 같은 자리).
    if (pathname === '/v1/intake/route' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') return corsPreflight('POST, OPTIONS');
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleIntakeRoutePost(req);
    }
    if (pathname.startsWith('/v1/intake/')) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      const suffix = pathname.slice('/v1/intake/'.length);
      return handleIntakeIdRoute(req, suffix, opts.metaApi);
    }
    if (pathname === '/v1/sessions/external' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleSessionRegister(req, opts.metaApi);
    }
    // 통합 로그 패브릭 (LF1) — 레벨 런타임 변경 (즉시 적용 + config write-through).
    if (pathname === '/v1/logs/level' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleLogsLevelPost(req, opts.metaApi);
    }
    // 라이브 세션 관리 — POST /v1/sessions/store/:id/fork (히스토리 복사 새 세션).
    if (pathname.startsWith('/v1/sessions/store/') && pathname.endsWith('/fork') && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      const id = decodeURIComponent(pathname.slice('/v1/sessions/store/'.length, -'/fork'.length));
      return handleSessionsStoreFork(req, id, opts.metaApi);
    }
    // on-disk 세션 삭제(파괴적) — 라이브 세션 관리. /store/:id (fork/transcript 와 구분).
    if (pathname.startsWith('/v1/sessions/store/') && !pathname.endsWith('/fork') && method === 'DELETE') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      const id = decodeURIComponent(pathname.slice('/v1/sessions/store/'.length));
      return handleSessionsStoreDelete(req, id, opts.metaApi);
    }
    if (pathname.startsWith('/v1/sessions/') && method === 'DELETE') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      const id = decodeURIComponent(pathname.slice('/v1/sessions/'.length));
      return handleSessionDelete(req, id, opts.metaApi);
    }
    if (pathname === '/v1/control-signals' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleControlSignalsEmit(req, opts.metaApi);
    }
    // PR f/k · `/v1/prompt` — daemon-http-server 의 마지막 활성 endpoint
    // 가 NEXUS 로 통합. metaApi.history 가 wired 되면 dispatcher 로
    // 진입; 미wired 면 503 not-wired.
    if (pathname === '/v1/prompt' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handlePromptPost(req, opts.metaApi);
    }
    // Phase B-1 (PWA chat streaming · 2026-05-06) — SSE variant of
    // /v1/prompt. Same auth + body shape; emits text-delta + turn-end
    // events instead of a single JSON body. PWA `chat-runtime`
    // streaming consumer is the only caller.
    if (pathname === '/v1/prompt/stream' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handlePromptStreamPost(req, opts.metaApi);
    }
    // PR h/k · hitl callback-server NEXUS-host. Pushcut Shortcut posts
    // here after the user taps Yes/No. metaApi.hitlPending wired →
    // resolveAnswer → 200; 미wired → 503. unknown requestId → 404.
    if (pathname.startsWith('/v1/hitl/callback/') && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      const requestId = decodeURIComponent(pathname.slice('/v1/hitl/callback/'.length));
      return handleHitlCallback(req, requestId, opts.metaApi);
    }
    // Round 3 PR1 (β-3 · 2026-05-08) — PWA Settings Pushcut card POST
    // stub-notification trigger. The matching GET (`/v1/hitl/audit/
    // recent`) lives in the GET-only block further down — placing it
    // here was a dead-code bug surfaced by FU.4 envelope audit
    // (2026-05-09) since `method !== 'GET'` outer guards it out.
    if (pathname === '/v1/hitl/test-pushcut' && method === 'POST') {
      return handleHitlTestPushcut(req);
    }
    // P8c — daemon-integrated HITL 매매 제안. verify 게이트 → Pushcut(아이폰)
    // 2단계 승인(requestConfirmation이 pending 등록 → 콜백 resolve). executor
    // 미배선이라 승인해도 집행 없음.
    if (pathname === '/v1/trade/propose' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      let trading: { handleTradeProposal(req: Request, metaApi: NonNullable<typeof opts.metaApi>): Promise<Response> };
      try {
        trading = await import(TRADE_PROPOSAL_MODULE) as typeof trading;
      } catch {
        return jsonResponse({ error: 'trading-addon-not-installed', detail: '매매 실행은 애드온이다 — 공개 코어엔 없다' }, 501);
      }
      return trading.handleTradeProposal(req, opts.metaApi);
    }
    // Archon-port T2.3 — workflow mutation surface. POST /validate +
    // POST /:name/run + PUT /:name + DELETE /:name. The matching GET
    // routes (list / detail / run-status) sit in the GET-only block
    // below.
    if (pathname === '/v1/workflows/validate' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      return handleWorkflowValidate(req, opts.metaApi);
    }
    // ROADMAP Tier 1 W1 (2026-05-11) — POST /v1/workflows/generate.
    // Natural-language → workflow YAML via LLM. Returns YAML + warnings.
    if (pathname === '/v1/workflows/generate' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      return handleWorkflowGenerate(req, opts.metaApi);
    }
    // Surface-unification §C1 (2026-05-11) — POST /v1/workflows/synth.
    // R3 native skill `workflow.synth_from_intent`. Trigger-aware LLM
    // synth → YAML + workflowName + triggerSummary. Returns 200 (ok)
    // or 422 (LLM produced invalid YAML even after self-repair).
    if (pathname === '/v1/workflows/synth' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      return handleWorkflowSynth(req, opts.metaApi);
    }
    // BACKLOG #7 production wiring — LLM-based workflow router.
    // Caller posts userMessage → discovers workflows → builds router
    // prompt → calls LLM → returns picked name (or null + error).
    if (pathname === '/v1/workflows/route' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      return handleWorkflowRoute(req, opts.metaApi);
    }
    // HANDOFF §4.2 follow-up — skill-side mirror of the workflow
    // router. Same regex → LLM cascade, applied to the skill index.
    // SK2 (PWA) — skills the index could not read: list ⊕ confirmed repair.
    if (pathname === '/v1/skills/problems' || pathname === '/v1/skills/problems/repair') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      const { handleSkillProblems } = await import('./skill-problems.js');
      return handleSkillProblems(req, opts.metaApi);
    }
    // SC1 (PWA · beta) — «공유용 캡처»: masked screen PNG in, metadata chunks stripped, stored under <configDir>/captures.
    if (pathname === '/v1/captures' || pathname.startsWith('/v1/captures/')) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      const { handleShareCaptures } = await import('./share-captures.js');
      return handleShareCaptures(req, opts.metaApi);
    }
    if (pathname === '/v1/skills/route' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      return handleSkillRoute(req, opts.metaApi);
    }
    // HANDOFF §4.2 follow-up — GUI-driven worktree cleanup.
    // POST `/v1/worktrees/dispose` body `{path, force?}` runs
    // `git worktree remove` (or just clears an orphan session JSON
    // when the worktree dir already vanished).
    if (pathname === '/v1/worktrees/dispose' && method === 'POST') {
      return handleWorktreeDispose(req);
    }
    if (pathname.startsWith('/v1/workflows/')) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
      const tail = pathname.slice('/v1/workflows/'.length);
      const segments = tail.split('/');
      // §5.1 approval — POST /runs/<runId>/{approve,reject}. Match
      // these BEFORE the workflow-name branch so `runs` doesn't get
      // misread as a workflow name.
      if (
        segments[0] === 'runs'
        && segments.length === 3
        && method === 'POST'
        && (segments[2] === 'approve' || segments[2] === 'reject')
      ) {
        const runId = decodeURIComponent(segments[1] ?? '');
        if (!runId || runId.includes('/') || runId.includes('..')) {
          return jsonResponse({ error: 'bad_request', reason: 'invalid runId' }, 400);
        }
        return segments[2] === 'approve'
          ? handleWorkflowApprovalApprove(req, runId, opts.metaApi)
          : handleWorkflowApprovalReject(req, runId, opts.metaApi);
      }
      const wfName = decodeURIComponent(segments[0] ?? '');
      if (!wfName || wfName.includes('\\') || wfName.includes('..')) {
        return jsonResponse({ error: 'bad_request', reason: 'invalid workflow name' }, 400);
      }
      if (segments.length === 1) {
        if (method === 'PUT') return handleWorkflowPut(req, wfName, opts.metaApi);
        if (method === 'DELETE') return handleWorkflowDelete(req, wfName, opts.metaApi);
      }
      if (segments.length === 2 && segments[1] === 'run' && method === 'POST') {
        return handleWorkflowRunStart(req, wfName, opts.metaApi);
      }
    }
    // CV-3 P5.x — agent CLI REST surface (real codex/claude/gemini
    // sub-process spawn via globalDualRoleManager).
    if (pathname === '/v1/agent-cli/sessions' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleAgentCliCreateSession(req, opts.metaApi);
    }
    if (pathname === '/v1/agent-cli/prompt' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleAgentCliPromptStream(req, opts.metaApi);
    }
    if (pathname === '/v1/agent-cli/cancel' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleAgentCliCancel(req, opts.metaApi);
    }
    // R4 v1.2 (2026-07-07) — 대시보드 refresh 버튼의 온디맨드 라이브 재수집.
    // POST 라 mutation 블록 안(memory `feedback_post_route_must_be_in_method_block`).
    if (pathname === '/v1/dashboard/refresh-live' && method === 'POST') {
      return handleDashboardRefreshLive(req, opts.dashboard ?? {});
    }
    // P2 (2026-07-08) — /scheduler 쓰기 액션(adopt/release/enable/disable/delete/
    // update/create). CLI·schedule_manage 와 동일 dispatchScheduleManage 백엔드 재사용.
    // POST 라 mutation 블록 안(memory `feedback_post_route_must_be_in_method_block`).
    if (pathname === '/v1/schedules/action' && method === 'POST') {
      return handleSchedulesActionPost(req);
    }
    // Autopilot Phase B1 (2026-07-09) — 골 → 실행모델 triage 미리보기(휴리스틱·무LLM).
    // POST 라 mutation 블록 안(memory `feedback_post_route_must_be_in_method_block`).
    if (pathname === '/v1/autopilot/triage-preview' && method === 'POST') {
      return handleTriagePreview(req);
    }
    if (pathname === '/v1/autopilot/mission-action' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleMissionAction(req);
    }
    // 흡수 원장 입구(RFC-pwa-intake-front-door A3 absorb) — 넣기·추적 둘 다 인증(PWA 칸은 user-private).
    if (pathname === '/v1/intake-ledger/items' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      const { handleIntakeLedgerPost } = await import('./intake-ledger-api.js');
      return handleIntakeLedgerPost(req);
    }
    if (pathname === '/v1/vault/file' && (method === 'PUT' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') return corsPreflight('PUT, OPTIONS');
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleVaultFilePut(req);
    }
    {
      const vaultSeg = parseVaultPath(pathname);
      if (vaultSeg !== null && method === 'OPTIONS') return corsPreflight('GET, OPTIONS');
    }
    // Obsidian Vault PWA 이식 OP0 (2026-07-09) — 템플릿 전개(POST). GET reads 는 아래.
    if (pathname === '/v1/vault/template-expand' && method === 'POST') {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleTemplateExpand(req);
    }
    // B outbound — unified send: openclaw reports + Conatus alerts POST here
    // instead of hitting Telegram directly, so all outbound fans out through
    // elanous's report channel.
    if (pathname === '/v1/outbound' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleOutboundReport(req, opts.metaApi);
    }
    if (pathname === '/v1/self-event' && method === 'POST') {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleSelfEvent(req, opts.metaApi);
    }
    {
      const agentCliSid = parseAgentCliSessionPath(pathname);
      if (agentCliSid !== null && method === 'DELETE') {
        if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
        return handleAgentCliCloseSession(req, opts.metaApi, agentCliSid);
      }
    }
    // CV-3 FP-B — Showroom layout daemon-side store (cross-device sync ·
    // ~/.elanous/showroom-layouts.json).
    {
      const layoutName = parseShowroomLayoutPath(pathname);
      if (layoutName !== null) {
        // micro.1 (2026-05-09) — CORS preflight for cross-origin PWA
        // dev. PUT/DELETE both ship JSON bodies + bearer auth, which
        // forces a browser preflight even when the response is
        // identical to the same-origin path.
        if (method === 'OPTIONS') return corsPreflight();
        if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
        if (method === 'PUT') return handleShowroomLayoutPut(req, opts.metaApi, layoutName);
        if (method === 'DELETE') return handleShowroomLayoutDelete(req, opts.metaApi, layoutName);
      }
    }
    const mutation = dispatchMutation(req, {
      state: opts.state,
      registry: opts.registry,
      authorize: opts.metaApi
        ? (request: Request) => (
          checkAuth(request, opts.metaApi!) ? undefined : jsonResponse({ error: 'unauthorized' }, 401)
        )
        : () => jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503),
      ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    });
    if (mutation.matched) return mutation.response!;
    return jsonResponse({ error: 'method-not-allowed', method }, 405);
  }

  // P-2B.1 — devProxy wins over staticDir + matches the wider /_next/*
  // and /__nextjs_* surface so HMR-adjacent requests reach the dev
  // upstream. When devProxy isn't wired we fall through to the static
  // handler (production).
  // P-2D.2 — read live ref every request so admin POST/DELETE flips
  // take effect on the next dispatch.
  const liveDevProxy = devProxyRef.get();
  if (liveDevProxy && pathMatchesDevProxy(pathname)) {
    return handleDevProxyHttpRequest(req, url, { upstream: liveDevProxy.upstream });
  }

  // T5.A — /app/* static (PWA export). When staticDir is omitted, falls
  // through to the 404 below.
  if (pathMatchesStaticPrefix(pathname)) {
    if (opts.staticDir) {
      return handleStaticAppRequest(url, { staticDir: opts.staticDir });
    }
    return jsonResponse({ error: 'static-not-wired' }, 404);
  }
  if (pathname === '/v1/health') {
    return handleHealth(opts.state, opts.registry, {
      bindHost: bind.hostname,
      ...(opts.setup ? { setup: opts.setup } : {}),
    });
  }
  if (pathname === '/v1/nexus') return handleNexusSnapshot(opts.state, opts.registry);
  if (pathname === '/v1/nexus/tabs') return handleTabsList(opts.registry, url);
  if (pathname === '/v1/nexus/templates') return handleTemplatesList();
  // PR d · meta-API GET routes. VAPID public key is unauthed (PWA fetches
  // before pasting bearer); voice cost + attachment download are gated.
  if (pathname === '/v1/push/vapid-public-key') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleVapidPublicKey();
  }
  // T5.D — GET /v1/push/subscriptions list (PWA Notifications 카드 사용).
  if (pathname === '/v1/push/subscriptions') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleListPushSubscriptions(req, opts.metaApi);
  }
  if (pathname === '/v1/voice/cost') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleVoiceCost(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/attachments/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    const id = pathname.slice('/v1/attachments/'.length);
    return handleAttachmentGet(req, id, opts.metaApi);
  }
  // ⭐ 로컬에 보관한 생성물(`OBS-T526`) — 복원이 상대 CDN 수명(30일)에 안 걸리게 한다.
  if (pathname.startsWith('/v1/media/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    const id = decodeURIComponent(pathname.slice('/v1/media/'.length));
    return handleMediaGet(req, id, opts.metaApi);
  }
  // PR e/k · read-only meta-API GET routes. When the matching runtime
  // field is present on `metaApi`, dispatchers fire. Routes without a
  // runtime backing yet (last-screenshot · recordings) keep returning
  // 503 — PR k delivers intake / sessions / control-signals / tools /
  // simulations runtime; the screenshot / recording runtime is a
  // post-T3 follow-up.
  if (pathname === '/v1/simulations') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleSimulationsList(req, opts.metaApi);
  }
  if (pathname === '/v1/tools') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleToolsList(req, opts.metaApi);
  }
  // B 트랙 Post-Closure (2026-05-13) — full ToolRuntime registry list
  // (sibling REST `POST /v1/tools/<id>/call` lives in the
  // method!=='GET' block above). The pre-existing `/v1/tools`
  // exposes the daemon-side bounded LLM surface (read by PWA
  // Settings); this route exposes EVERY registered runtime so
  // external curl callers can discover proxy MCP tools too.
  if (pathname === '/v1/tools/runtime') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleRuntimeToolsList(req, opts.metaApi, url);
  }
  // CV-3 P4.2 — daemon-side terminal scrollback for Showroom auto-fetch
  // (replaces client paste · RFC v4 D14). Reads from pty-shell/registry
  // 直接 (process-wide singleton — no MetaApiOpts runtime needed beyond
  // auth gate).
  // ★ PTY 관측소(2026-07-23) — 헤드리스 셸 라이브 뷰(HTML·same-origin·인증 shell 불필요·데이터 fetch 는 gated).
  if (pathname === '/v1/terminals/view') {
    return handleTerminalsView();
  }
  if (pathname === '/v1/terminals') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleTerminalsList(req, opts.metaApi);
  }
  if (parseTerminalLineagePath(pathname)) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleTerminalLineage(req, opts.metaApi);
  }
  {
    const runId = parseTerminalRunGoalPath(pathname);
    if (runId !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalRunGoal(req, opts.metaApi, runId);
    }
  }
  {
    const runId = parseTerminalRunParticipantsPath(pathname);
    if (runId !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalRunParticipants(req, opts.metaApi, runId);
    }
  }
  {
    const streamId = parseTerminalStreamPath(pathname);
    if (streamId !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalStream(req, opts.metaApi, streamId);
    }
  }
  {
    const scrollbackId = parseScrollbackPath(pathname);
    if (scrollbackId !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalScrollback(req, opts.metaApi, scrollbackId, url);
    }
  }
  // ⭐P2 — 렌더 프레임 서빙(픽커/모달 포함·S2). scrollback(원시 ANSI)과 별도 라우트.
  {
    const frameId = parseFramePath(pathname);
    if (frameId !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalFrame(req, opts.metaApi, frameId, url);
    }
  }
  // ⭐P4 §4-1 — 렌더 프레임의 온디맨드 PNG(text→SVG→sharp·크로스-프로세스·상시비용 0).
  {
    const pngId = parsePngPath(pathname);
    if (pngId !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleTerminalPng(req, opts.metaApi, pngId);
    }
  }
  // CV-3 P5.x — note: agent CLI POST/DELETE endpoints are mounted in
  // the `if (method !== 'GET')` block above (this block is GET-only).
  // See lines ~360 for the actual mounts.
  // R6 FU.4 (2026-05-09) — moved here from the `method !== 'GET'`
  // block so the GET request actually reaches the handler. PWA
  // Settings Pushcut card reads the audit log tail.
  if (pathname === '/v1/hitl/audit/recent') {
    return handleHitlAuditRecent(req);
  }
  // micro.3 (2026-05-09) — LLM model list proxy. PWA Showroom
  // header dropdown reads this to enumerate deployed models.
  if (pathname === '/v1/llm/models') {
    return handleLlmModels(req);
  }
  // R-OCR.4.2 (2026-05-09) — snapshot of the camera-notes metric
  // collector. PWA Settings card polls this. Returns an empty
  // snapshot (wired:false) when the collector isn't wired so the
  // card can render gracefully even pre-runNexus-rewire.
  if (pathname === '/v1/metrics/notes-from-image') {
    return handleNotesMetricsSnapshot(req, opts.notesMetrics ?? {});
  }
  // R5.0 (2026-05-09) — active sessions snapshot for the PWA card
  // deck. Sibling to /v1/sessions; this one filters to recent +
  // adds a status pill (active / idle / stale).
  if (pathname === '/v1/sessions/active') {
    return handleSessionsActive(req, opts.sessionsActive ?? {});
  }
  // 통합 로그 패브릭 (LF1 · 2026-07-13) — 조회/스트림/레벨. logs.db(LF0) 위의
  // adb logcat 서버 반쪽. 설계: PLAN-unified-log-fabric-2026-07-13 §LF1.
  if (pathname === '/v1/logs' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLogsQuery(req, opts.metaApi);
  }
  // Trace (v6 T1 · 2026-09-28) — 판단 사슬 L0–L3 ⊕ 증거 한 줄. 읽기만 한다.
  if (pathname === '/v1/trace' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleTrace(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/trace/evidence/') && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleTraceEvidence(req, opts.metaApi, pathname.slice('/v1/trace/evidence/'.length));
  }
  if (pathname === '/v1/logs/stream' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLogsStream(req, opts.metaApi);
  }
  if (pathname === '/v1/logs/level' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLogsLevelGet(req, opts.metaApi);
  }
  if (pathname === '/v1/logs/facets' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLogsFacets(req, opts.metaApi);
  }
  if (pathname === '/v1/logs/histogram' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLogsHistogram(req, opts.metaApi);
  }
  // LF7-d — 연합 뷰: 인스턴스 목록(셀렉터 데이터). 조회/스트림/집계는
  // `?store=<name>` 파라미터로 타 인스턴스 read-only 조회.
  if (pathname === '/v1/logs/instances' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLogsInstances(req, opts.metaApi);
  }
  // 라이브 세션 관리 — on-disk 세션(CLI+텔레그램 실화) 목록/내용.
  if (pathname === '/v1/sessions/store' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleSessionsStoreList(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/sessions/store/') && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    const id = decodeURIComponent(pathname.slice('/v1/sessions/store/'.length));
    return handleSessionsStoreGet(req, id, opts.metaApi);
  }
  // R6.2 (2026-05-09) — daily reflection. /v1/reflection/today +
  // /v1/reflection/:date both go through the same handler with a
  // path-segment that the parser narrows.
  {
    const seg = parseReflectionPath(pathname);
    if (seg !== null) {
      return handleReflection(req, seg, opts.reflection ?? {});
    }
  }
  // 통합 시그널 보드(2026-07-10) — 4소스(버즈·디깅/타임라인·국면·회고) recency 감지 피드.
  if (pathname === '/v1/signals/board') {
    return handleSignalBoard(req);
  }
  // R4 (2026-07-07) — finance dashboard read API (organic-signal-engine).
  // /v1/dashboard/{summary|timeline|heatmap|digs} — 캐시/SQLite read-only.
  {
    const seg = parseDashboardPath(pathname);
    if (seg !== null) {
      return handleDashboard(req, seg, opts.dashboard ?? {});
    }
  }
  // Autopilot Phase B1 (2026-07-09) — /v1/autopilot/{repo-watch|autonomy|arming} read.
  {
    const seg = parseAutopilotPath(pathname);
    if (seg !== null) {
      return handleAutopilotGet(req, seg);
    }
  }
  // Obsidian Vault PWA 이식 OP0 (2026-07-09) — /v1/vault/{info|list|read|search|notes|
  // backlinks|tags|templates|poll-changes|orphans|graph} read(기존 obsidian 헬퍼 wrap).
  {
    const seg = parseVaultPath(pathname);
    if (seg !== null) {
      if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleVaultGet(req, seg);
    }
  }
  // SE 격리 빌드 관측 (2026-07-13·PLAN B4) — /v1/builds[/<id>[/stream]]. list/snapshot=json,
  // stream=SSE(원격/PWA 가 빌드 안 로그를 라이브 follow·adb logcat 스타일). READ-ONLY.
  {
    const route = parseBuildsPath(pathname);
    if (route !== null) {
      const r = await handleBuildsGet(req);
      if (r) return r;
    }
  }
  // FU.A3 (2026-05-09) — multi-host config GET. Returns the
  // effective host config + source label ('override' | 'env' |
  // 'legacy') with apiKey fields redacted.
  if (pathname === '/v1/llm/hosts') {
    return handleLlmHostsConfig(req);
  }
  // iOS Phase 1.5 (2026-05-13) — provider rotation list + active.
  // POST sibling lives in the mutation block above.
  if (pathname === '/v1/llm/rotation') {
    return handleLlmRotationGet(req);
  }
  // PWA `/setup` wizard Phase 1 (2026-05-19) — provider catalog 표시.
  // POST sibling (`/v1/setup/llm-provider`) 는 위 mutation 블록.
  if (pathname === '/v1/setup/llm-providers') {
    return handleLlmProvidersList(req);
  }
  if (pathname === '/v1/setup/obsidian-skills') {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleObsidianSkillsGet();
  }
  if (pathname === '/v1/setup/channel-bots') {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleChannelBotsGet();
  }
  if (pathname === '/v1/setup/child-llm' || pathname === '/v1/setup/answer-priority') {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return pathname === '/v1/setup/child-llm' ? handleChildLlmGet() : handleAnswerPriorityGet();
  }
  // P1-FU1 (2026-05-14) — mission router prediction is POST-only.
  // GET reaches here AFTER the mutation block (which only fires when
  // `method !== 'GET'`); routing the path here lets the handler
  // return its 405 fallback (with `error: 'method-not-allowed'`)
  // instead of falling through to the catch-all 404.
  if (pathname === '/v1/llm/route/predict') {
    return handleLlmRoutePredict(req, { missionRouter: opts.missionRouter });
  }
  // CV-3 FP-B — Showroom layout cross-device store (GET routes).
  if (pathname === '/v1/showroom/layouts') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleShowroomLayoutsList(req, opts.metaApi);
  }
  // R6 FU.3 (2026-05-09) — SSE for sidebar widget refresh. Must
  // match BEFORE the `:name` regex so the literal "events" segment
  // isn't misread as a layout id (cf. §6.4 SSE precedence pattern).
  if (pathname === '/v1/showroom/layouts/events') {
    return handleShowroomLayoutsEvents(req);
  }
  {
    const layoutName = parseShowroomLayoutPath(pathname);
    if (layoutName !== null) {
      if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
      return handleShowroomLayoutGet(req, opts.metaApi, layoutName);
    }
  }
  if (pathname === '/v1/diag/auth-trace') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleAuthTraceGet(req, opts.metaApi);
  }
  if (pathname === '/v1/intake') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleIntakeListGet(req, url, opts.metaApi);
  }
  // 흡수 원장 추적 — 인증 필수(PWA 칸은 user-private · 넣기는 위 method!=='GET' 블록).
  if (pathname.startsWith('/v1/intake-ledger/items/')) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    const { handleIntakeLedgerGet } = await import('./intake-ledger-api.js');
    return handleIntakeLedgerGet(decodeURIComponent(pathname.slice('/v1/intake-ledger/items/'.length)));
  }
  // I10 (2026-05-12) — dogfood retrospective. Reads recent rows from
  // ~/.elanous/intake/pipeline-runs.jsonl + aggregates across the full
  // file. Sibling to the POST emitters (pipeline-preview / commit ·
  // dispatched in the method!=='GET' block above). Must dispatch
  // before the `/v1/intake/` catch-all so it doesn't get swallowed
  // as an intake id.
  if (pathname === '/v1/intake/runs') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleIntakeRunsList(req, opts.metaApi);
  }
  // M4-3 (2026-05-12) — Mission ↔ workflow folder surface. Reads
  // ~/.elanous/tasks/tasks.db (TOX_SCHEMA_VERSION=2 · tox_missions
  // table) + joins per-mission task summaries. Sibling to /v1/tasks.
  if (pathname === '/v1/missions') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleMissionsList(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/missions/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    const missionId = pathname.slice('/v1/missions/'.length);
    if (!missionId) return jsonResponse({ error: 'missing_mission_id' }, 400);
    return handleMissionDetail(req, missionId, opts.metaApi);
  }
  // D8 (2026-05-12) — Phase 2 dispatch dogfood retrospective. Sibling
  // to /v1/intake/runs (I10). Reads ~/.elanous/dispatch/runs.jsonl +
  // aggregates per-axis success rates / top reject reasons.
  if (pathname === '/v1/dispatch/runs') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleDispatchRunsList(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/intake/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    const suffix = pathname.slice('/v1/intake/'.length);
    return handleIntakeIdRoute(req, suffix, opts.metaApi);
  }
  if (pathname === '/v1/sessions') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleSessionsList(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/sessions/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    const id = decodeURIComponent(pathname.slice('/v1/sessions/'.length));
    return handleSessionGet(req, id, opts.metaApi);
  }
  if (pathname === '/v1/control-signals') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleControlSignalsList(req, url, opts.metaApi);
  }
  // T5.C — last-screenshot + recordings 흡수 (daemon-public-server lift).
  if (pathname === '/v1/turns/last/screenshot' || pathname === '/last-screenshot') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleLastScreenshotGet(req, url, opts.metaApi);
  }
  if (pathname.startsWith('/v1/recordings/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleRecordingGet(req, pathname, opts.metaApi);
  }
  // T5.G — task / scheduler board APIs lift (daemon-public-server →
  // NEXUS). PWA `/tasks` · `/scheduler` 가 SSoT NEXUS baseUrl 로 바로
  // 접근. 둘 다 process-singleton store (TaskStore · getSchedulerStore)
  // 라 zero-migration. metaApi 미wired 환경에서는 503 — daemon-public
  // grace-window 가 닫힌 후에도 PWA 가 stable error 만 보도록.
  if (pathname === '/v1/schedules' && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleSchedulesList(req, opts.metaApi);
  }
  const scheduleRunsMatch = /^\/v1\/schedules\/([^/]+)\/runs$/.exec(pathname);
  if (scheduleRunsMatch && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
    let id: string;
    try { id = decodeURIComponent(scheduleRunsMatch[1]!); }
    catch { return jsonResponse({ error: 'bad_request' }, 400); }
    return handleScheduleRuns(req, id, opts.metaApi);
  }
  if (pathname.startsWith('/v1/schedules/') && method === 'GET') {
    if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
    let id: string;
    try { id = decodeURIComponent(pathname.slice('/v1/schedules/'.length)); }
    catch { return jsonResponse({ error: 'bad_request' }, 400); }
    return handleScheduleDetail(req, id, opts.metaApi);
  }
  if (pathname === '/v1/task-cards' || /^\/v1\/task-cards\/[^/]+$/.test(pathname)) {
    return handleTaskCardsGet(pathname);
  }
  if (pathname === '/v1/tasks') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleTasksList(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/tasks/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    const taskId = decodeURIComponent(pathname.slice('/v1/tasks/'.length));
    if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
      return jsonResponse({ error: 'bad_request', reason: 'invalid taskId' }, 400);
    }
    return handleTaskDetail(req, taskId, opts.metaApi);
  }
  // Surface-unification v2.2 V2.2-6 v2 (2026-05-11) — `/v1/scheduler` +
  // `/v1/scheduler/:taskId` routes retired (scheduler view 폐기). Workflows
  // surface (`/v1/workflows` · `~/.elanous/workflows-runs/`) covers the same
  // user need.

  const pluginCredentialsGet = /^\/v1\/plugins\/([^/]+)\/credentials$/.exec(pathname);
  if (method === 'GET' && pluginCredentialsGet) {
    if (!opts.metaApi) return jsonResponse({ error: 'unauthorized' }, 401);
    return handlePluginsCredentialsGet(req, pluginCredentialsGet[1]!, opts.metaApi, opts.pluginStateRoot);
  }
  if (method === 'GET' && (pathname === '/v1/plugins/index' || pathname === '/v1/plugins')) {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    return pathname === '/v1/plugins/index' ? handlePluginsIndexGet(req, opts.metaApi, opts.pluginStateRoot) : handlePluginsGet(req, opts.metaApi, opts.pluginStateRoot);
  }
  if (method === 'GET' && pathname === '/v1/graph/kinds') {
    if (!opts.metaApi || !checkAuth(req, opts.metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
    try { syncInstalledPluginNodes(opts.pluginStateRoot ?? elanousStateRoot()); }
    catch (error) { debug.log('graph.kinds', 'installed-sync-failed', { reason: String(error) }); }
    return handleGraphKindsGet(req, opts.metaApi);
  }
  // F-M1 read + P-F1 raw YAML. Writes live in the mutation block and never touch core graphs/.
  if (method === 'GET' && (pathname === '/v1/graphs' || /^\/v1\/graphs\/[^/]+$/.test(pathname) || /^\/v1\/graphs\/[^/]+\/yaml$/.test(pathname))) {
    return handleGraphsGet(pathname);
  }
  // Archon-port T2.3 (2026-05-08) — workflow GET surface.
  // (POST /validate · POST /:name/run · PUT/DELETE /:name landed
  // inside the mutation block above.)
  if (pathname === '/v1/workflows') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleWorkflowsList(req, opts.metaApi);
  }
  // Surface-unification §E1 (2026-05-11) — trigger snapshot. Flat list
  // of every trigger node (Schedule · Webhook · Discord · Telegram ·
  // Manual · Chat) across the discovered workflows. Drives the PWA
  // "Active triggers" panel (E2). SSE event stream is v2.
  if (pathname === '/v1/triggers') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleTriggersSnapshot(req, opts.metaApi);
  }
  // Surface-unification §F2 (2026-05-11) — starter workflow templates
  // for the PWA "+ New" picker. Returns metadata + raw YAML so the
  // client can render a card grid + copy into the user's project on
  // Apply (via existing PUT /v1/workflows/<name>).
  if (pathname === '/v1/workflows/templates') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleWorkflowTemplatesList(req, opts.metaApi);
  }
  // D4 · §6.4 SSE — workflow yaml fs.watch stream. Client side
  // subscribes via `useWorkflows` to drop the cross-client refresh
  // latency from 30s polling to <500ms.
  if (pathname === '/v1/workflows/events') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    const metaApi = opts.metaApi;
    return handleWorkflowsEvents(req, {
      checkAuth: (r) => checkAuth(r, metaApi),
    });
  }
  // Caveat #2 follow-up — disk-backed run history list.
  if (pathname === '/v1/workflows/runs') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleWorkflowRunsList(req, opts.metaApi);
  }
  // §5.1 — pending-approvals discovery. Matched BEFORE the runs/<id>
  // branch so 'pending' isn't read as a runId.
  if (pathname === '/v1/workflows/runs/pending') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    return handleWorkflowApprovalsPending(req, opts.metaApi);
  }
  if (pathname.startsWith('/v1/workflows/runs/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    const runId = decodeURIComponent(pathname.slice('/v1/workflows/runs/'.length));
    if (!runId || runId.includes('/')) {
      return jsonResponse({ error: 'bad_request', reason: 'invalid runId' }, 400);
    }
    return handleWorkflowRunGet(req, runId, opts.metaApi);
  }
  if (pathname.startsWith('/v1/workflows/')) {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-not-wired' }, 503);
    const wfName = decodeURIComponent(pathname.slice('/v1/workflows/'.length));
    if (!wfName || wfName.includes('/') || wfName.includes('\\') || wfName.includes('..')) {
      return jsonResponse({ error: 'bad_request', reason: 'invalid workflow name' }, 400);
    }
    return handleWorkflowGet(req, wfName, opts.metaApi);
  }
  if (pathname.startsWith('/v1/nexus/templates/')) {
    const name = pathname.slice('/v1/nexus/templates/'.length);
    return handleTemplateGet(name);
  }
  if (pathname.startsWith('/v1/nexus/tabs/')) {
    const tail = pathname.slice('/v1/nexus/tabs/'.length);
    const segments = tail.split('/');
    const id = segments[0] ?? '';
    const action = segments[1];
    if (action === 'logs') {
      return handleTabLogs(opts.registry, id, url);
    }
    return handleTabDetail(opts.registry, opts.state, id || tail);
  }
  if (pathname.startsWith('/v1/nexus/errors')) {
    const parsed = parseErrorsPath(pathname);
    if (parsed) {
      if (parsed.tabId && parsed.ts) return handleErrorGet(parsed.tabId, parsed.ts);
      if (parsed.tabId) return handleErrorsForTab(parsed.tabId);
      return handleErrorsList(url);
    }
  }
  // PWA mirror track PR 1 — chat-backend Quick Setup snapshot. Wraps
  // `buildQuickSetupSnapshot()` so the PWA SettingsPanel (PR 2-3)
  // can render the same card the TUI Settings tab does.
  if (pathname === '/v1/nexus/chat-backend-detection') {
    return handleChatBackendDetection();
  }
  // T4.A — connect-info metadata endpoint. `elanous nexus connect <host>`
  // (T4.B) 가 처음 fetch · PWA Generate Token card (T4.D) 가 함께 사용.
  if (pathname === '/v1/nexus/connect-info') {
    const ci = opts.connectInfo;
    const requestHost = req.headers.get('host') || new URL(req.url).host;
    const ctx: ConnectInfoCtx = {
      hostname: bind.hostname,
      port: bind.port,
      nexusVersion: ci?.nexusVersion ?? opts.state.nexusVersion ?? '0.0.0',
      ...(ci?.serverLabel !== undefined ? { serverLabel: ci.serverLabel } : {}),
      ...(ci?.acpTokenPath !== undefined ? { acpTokenPath: ci.acpTokenPath } : {}),
      ...(ci?.acpTokenOverride !== undefined ? { acpTokenOverride: ci.acpTokenOverride } : {}),
      ...(requestHost ? { requestHost } : {}),
      allowAutoToken: connectInfoTokenAllowed(req.headers.get('origin'), requestHost || null),
    };
    return handleConnectInfoGet(ctx);
  }
  if (pathname === '/v1/events') return handleSseEvents(opts.eventBus, url);
  // Phase 0.5 (2026-05-08) — intent-prediction REST + SSE.
  // /v1/intent-prediction/:sessionId{,/sse,/feedback}
  if (pathname.startsWith('/v1/intent-prediction/') && opts.intentPrediction) {
    const result = await dispatchIntentPredictionRoute(req, url, {
      service: opts.intentPrediction,
    });
    if (result) return result;
  }
  // R3 (BACKLOG-pwa-mobile-readiness #5 · 2026-05-09) —
  // POST /v1/notification-action lives in the method!=='GET' block
  // above (around line 445) where the other POST routes are.
  // §6.4 (2026-05-09) — personas REST (read-only · global registry).
  // /v1/personas[/:personaId]
  if (pathname === '/v1/personas' || pathname.startsWith('/v1/personas/')) {
    const result = await dispatchPersonaRoute(req, pathname);
    if (result) return result;
  }
  // §6.3 (2026-05-09) — context URL fetch (showroom).
  // POST /v1/context/fetch-url
  if (pathname === '/v1/context/fetch-url') {
    return handleContextFetchUrl(req);
  }
  // R6 Task 5 · §6.1 — POST handler lives inside the method !== 'GET'
  // block above (this stub keeps the surface searchable; non-POST
  // requests fall through and surface the canonical 405 below).
  // Phase B-4 (PWA chat streaming · 2026-05-06) — observer SSE for
  // chat turn events. Long-lived; subscriber filters by sessionId.
  // Foundation for multi-tab `/chat` consistency.
  if (pathname === '/v1/chat/events') {
    if (!opts.metaApi) return jsonResponse({ error: 'meta-api-runtime-not-wired' }, 503);
    return handleChatEventsGet(req, url, opts.metaApi);
  }
  if (pathname === '/v1/config') return handleConfigGet();
  // M1-2b — friction-free model selection GET. Returns only the
  // typed sub-trees (modelTier/budget/smartDefaults) so the PWA can
  // hydrate the slider without parsing the full UserConfig.
  if (pathname === '/v1/config/model-tier') {
    const { handleModelTierGet } = await import('./config-model-tier.js');
    return handleModelTierGet();
  }
  // M3-1 (Phase 3) — BudgetGuard evaluation. Joins the live voice cost
  // tracker month-so-far with the user-config `budget` sub-tree so the
  // PWA threshold modal can decide whether to nag. Applying the
  // recommended fallback goes through the existing `PUT /v1/config/
  // model-tier` route — this endpoint is read-only.
  if (pathname === '/v1/budget/status') {
    const { handleBudgetStatusGet } = await import('./budget-status.js');
    return handleBudgetStatusGet();
  }
  // M2-2b-v2 — ElevenLabs voice library proxy (10-min TTL cache · API
  // key never crosses to the browser). Returns { voices, configured,
  // fromCache, cacheTtlMs }.
  if (pathname === '/v1/elevenlabs/voices') {
    const { handleElevenLabsVoicesGet } = await import('./elevenlabs-voices.js');
    return handleElevenLabsVoicesGet();
  }
  if (pathname === '/v1/config/switches') return handleSwitchesList(opts.registry);
  if (pathname.startsWith('/v1/config/switches/')) {
    const switchId = pathname.slice('/v1/config/switches/'.length);
    return handleSwitchGet(switchId, opts.registry);
  }
  if (pathname === '/v1/config/secrets') return handleSecretsList();
  // BACKLOG #2 — platform connection summary (Discord/Telegram/
  // Pushcut/ACP/Tailscale share). Read-only · no secret values.
  if (pathname === '/v1/platforms') return handlePlatforms();
  // BACKLOG #1 / RFC #2161 retirement (2026-05-11) — the legacy
  // `/v1/providers` snapshot was absorbed by `/v1/registry/catalog`
  // (RFC #2161 Phase 3) + the LlmCatalogCard matrix view (#2198 FU A4).
  // No remaining production consumers — endpoint removed in PR for
  // PR #2198 FU.
  // BACKLOG #5 — active worktree visualization. Aggregates `git
  // worktree list` + `~/.elanous/worktrees/*.json` session records.
  if (pathname === '/v1/worktrees') return handleWorktrees();
  // Read-only bot command catalog. Returns `botCommandCatalog()` as-is
  // (no execution, no extra fields). Same auth posture as `/v1/worktrees`.
  if (pathname === '/v1/bots/commands') return handleBotCommands();
  // B4 — the `elanous repo design-check` verdict over the wire, so the PWA
  // renders the SAME resolution the CLI prints instead of re-deriving it.
  if (pathname === '/v1/design-check') return handleDesignCheck();
  // RFC design loop §A2 — HTML previews under the same repository as design-check.
  if (pathname === DESIGN_PREVIEWS_PATH || pathname.startsWith(DESIGN_PREVIEW_PATH_PREFIX)) {
    return handleDesignPreviews(pathname);
  }
  // RFC #2161 Phase 3 — Layer A static catalog snapshot. Read-only ·
  // refreshed on demand by the PWA Showroom dropdown + future
  // LlmCatalogCard. Phase 5 adds /v1/registry/resolved for live
  // (apiKey + health) state.
  if (pathname === '/v1/registry/catalog') return handleRegistryCatalog();
  // RFC #2161 Phase 5 — Layer A ⊕ Layer B (live state). Phase 6 layers
  // health-probe + rate-limit data on top.
  if (pathname === '/v1/registry/resolved') return handleRegistryResolved();
  if (pathname === '/v1/registry/events') return handleRegistryEvents();
  // RFC #2161 Phase 6 — Layer D auto-discovery snapshot. GET returns
  // the cached snapshot · POST triggers a fresh run (PWA refresh
  // button + future cron tick).
  if (pathname === '/v1/registry/discovery') return handleDiscoveryGet();
  if (pathname.startsWith('/v1/registry/bindings')) {
    const parsed = parseBindingPath(pathname);
    if (parsed && !parsed.channel && !parsed.key) {
      return handleBindingsList(url);
    }
    if (parsed?.channel && parsed?.key) {
      return handleBindingGet(parsed.channel, parsed.key);
    }
    if (parsed?.channel && !parsed.key) {
      // List bindings for this channel via path form (vs query string).
      const u = new URL(`x://x?channel=${encodeURIComponent(parsed.channel)}`);
      return handleBindingsList(u);
    }
  }

  return jsonResponse({ error: 'not-found', path: pathname }, 404);
}

function makeConfigCtx(opts: NexusHttpServerOpts): ConfigCtx {
  return {
    state: opts.state,
    registry: opts.registry,
    ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    ...(opts.hotApplyHandler ? { hotApplyHandler: opts.hotApplyHandler } : {}),
  };
}

type AcpFeedbackBroadcaster = (sessionId: string, env: FeedbackEnvelope) => unknown;

/** Delivers every feedback envelope to SSE and, when present, the ACP peer. */
export function createFeedbackEmitter(
  eventBus: NexusEventBus,
  sessionId: string,
  broadcast: AcpFeedbackBroadcaster | undefined,
): (env: FeedbackEnvelope) => void {
  return (env) => {
    eventBus.publish({ ts: Date.now(), kind: 'media.feedback', detail: env as unknown as Record<string, unknown> });
    if (broadcast) void broadcast(sessionId, env);
  };
}

/** `{ event: TelegramEvent }` 만 받는다 — 모르는 kind·빈 칸은 400. */
export function parseTelegramDispatchEvent(body: unknown): TelegramEvent | null {
  if (!body || typeof body !== 'object') return null;
  const e = (body as { event?: unknown }).event;
  if (!e || typeof e !== 'object') return null;
  const r = e as Record<string, unknown>;
  if (r.kind !== 'message' && r.kind !== 'command' && r.kind !== 'callback_query') return null;
  if (typeof r.chat !== 'string' || typeof r.user !== 'string' || typeof r.body !== 'string') return null;
  if (r.command !== undefined && typeof r.command !== 'string') return null;
  return {
    kind: r.kind,
    chat: r.chat,
    user: r.user,
    body: r.body,
    ...(typeof r.command === 'string' ? { command: r.command } : {}),
    ...(r.raw !== undefined ? { raw: r.raw } : {}),
  };
}

export { corsPreflight, jsonResponse } from './json-response.js';
