// ── Dashboard ──
// Working-dir workspace only (Session 10). V1..V4 views share a common
// browser/preview/scratch/log grid; plugins such as sync swap the active
// layout via the plugin host.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { createStaleInstallCheck, readCurrentInstalledCommit, readDashboardBootCommit, STALE_INSTALL_CHECK_INTERVAL_MS, versionedDashboardInstallDir } from './stale-install-check.js';
import { spawn, spawnSync } from 'node:child_process';
import { $ } from 'bun';
import { LOCAL_SKILLS_DIR, SERVICE_NAMES, DATA_DIR, OBSIDIAN_VAULT } from '../config.js';
import { dispatchDashboardSessionRuntimeTool } from './session-runtime-dispatch.js';
import { buildAdRunSetup } from '../ad-pipeline/ad-run-setup.js';
import { nextChatScrollOffset } from '../chat/log-scroll-key.js';
import type { CommandRunner } from '../ad-pipeline/higgsfield-backend.js';
import type { ShootRunOptions } from '../ad-pipeline/shoot-run.js';
import type { QcThresholds } from '../ad-pipeline/qc.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { suggestProjectForFolder } from '../project/project-store.js';
import { createProjectSuggester } from '../project/project-suggestion.js';

const dashboardDefaultShootRunOptions: Required<Pick<ShootRunOptions, 'pollIntervalMs' | 'maxPollsPerJob' | 'submitStaggerMs'>> = {
  pollIntervalMs: 3_000,
  // 2026-09-12 seedance_2_0 measured 330–400s; 174 polls = 522s, leaving 402s after six 20s staggers.
  maxPollsPerJob: 174,
  submitStaggerMs: 20_000,
};

/**
 * ⛔ `src/ad-pipeline/ad-run-setup.ts` 의 `optionalProductionInputs` «사본»이다 — 그 목록은 export 가 아니다.
 * 여기서 다시 세는 이유: 이 파일이 `buildAdRunSetup` «뒤»에 `assemblyMaterials` 를 덧붙이므로,
 * 그 함수가 «입력» 기준으로 낸 목록은 최종 `production` 과 어긋난다(`#17880`).
 * ⚠️ 사본이라 «늙는다» — `src/dashboard/index.test.ts` 가 권위 목록과 같은지 단언한다.
 */
export const dashboardOptionalProductionInputs = [
  'assembly',
  'assemblyMaterials',
  'captionFontPath',
  'musicBedPath',
  'qcThresholds',
  'voiceover',
  'soundtrack',
  'referenceAssets',
  'shootRunOptions',
  'ground',
  'invariants',
] as const;

export interface DashboardAdAssetPreset {
  readonly captionFontPath?: string;
  readonly musicBedPath?: string;
  readonly referenceAssets?: Readonly<Record<string, string[]>>;
  readonly shootRunOptions?: ShootRunOptions;
  readonly qcThresholds?: QcThresholds;
}

/** Operator-owned, instance-scoped optional asset preset; never a repository asset path. */
export function dashboardAdAssetPresetPath(stateRoot = elanousStateRoot()): string {
  return join(stateRoot, 'ad-assets.json');
}

/** Reads optional operator-owned asset paths without inventing local defaults. */
export function loadDashboardAdAssetPreset(path: string): DashboardAdAssetPreset {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`dashboard ad asset preset unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: expected an object`);
  }

  const preset = parsed as Record<string, unknown>;
  for (const key of ['captionFontPath', 'musicBedPath'] as const) {
    if (preset[key] !== undefined && typeof preset[key] !== 'string') {
      throw new Error(`dashboard ad asset preset malformed at ${path}: ${key} must be a string`);
    }
  }
  if (preset.referenceAssets !== undefined && (
    preset.referenceAssets === null
    || typeof preset.referenceAssets !== 'object'
    || Array.isArray(preset.referenceAssets)
    || Object.values(preset.referenceAssets).some((value) => !Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: referenceAssets must be a record of string arrays`);
  }
  if (preset.shootRunOptions !== undefined && (
    preset.shootRunOptions === null
    || typeof preset.shootRunOptions !== 'object'
    || Array.isArray(preset.shootRunOptions)
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: shootRunOptions must be an object`);
  }
  const shootRunOptions = preset.shootRunOptions as Record<string, unknown> | undefined;
  for (const key of ['pollIntervalMs', 'maxPollsPerJob', 'maxPollElapsedMs', 'submitStaggerMs', 'submitRetries'] as const) {
    if (shootRunOptions?.[key] !== undefined && (typeof shootRunOptions[key] !== 'number' || !Number.isFinite(shootRunOptions[key]))) {
      throw new Error(`dashboard ad asset preset malformed at ${path}: shootRunOptions.${key} must be a finite number`);
    }
  }
  if (preset.qcThresholds !== undefined && (
    preset.qcThresholds === null
    || typeof preset.qcThresholds !== 'object'
    || Array.isArray(preset.qcThresholds)
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds must be an object`);
  }
  const qcThresholds = preset.qcThresholds as Record<string, unknown> | undefined;
  for (const key of ['dialogueLufsTolerance', 'colorDistance', 'frameDiffVariance'] as const) {
    if (qcThresholds?.[key] !== undefined && (typeof qcThresholds[key] !== 'number' || !Number.isFinite(qcThresholds[key]))) {
      throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.${key} must be a finite number`);
    }
  }
  if (qcThresholds?.durationRanges !== undefined && (
    qcThresholds.durationRanges === null
    || typeof qcThresholds.durationRanges !== 'object'
    || Array.isArray(qcThresholds.durationRanges)
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges must be an object`);
  }
  const durationRanges = qcThresholds?.durationRanges as Record<string, unknown> | undefined;
  for (const scope of ['cut', 'master'] as const) {
    if (durationRanges?.[scope] !== undefined && (
      durationRanges[scope] === null
      || typeof durationRanges[scope] !== 'object'
      || Array.isArray(durationRanges[scope])
    )) {
      throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope} must be an object`);
    }
    const range = durationRanges?.[scope] as Record<string, unknown> | undefined;
    if (range !== undefined) {
      const minimumSeconds = range.minimumSeconds;
      const maximumSeconds = range.maximumSeconds;
      if (typeof minimumSeconds !== 'number' || !Number.isFinite(minimumSeconds)) {
        throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope}.minimumSeconds must be a finite number`);
      }
      if (typeof maximumSeconds !== 'number' || !Number.isFinite(maximumSeconds)) {
        throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope}.maximumSeconds must be a finite number`);
      }
      if (minimumSeconds > maximumSeconds) {
        throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope}.minimumSeconds must be less than or equal to maximumSeconds`);
      }
    }
  }
  return {
    ...(typeof preset.captionFontPath === 'string' ? { captionFontPath: preset.captionFontPath } : {}),
    ...(typeof preset.musicBedPath === 'string' ? { musicBedPath: preset.musicBedPath } : {}),
    ...(preset.referenceAssets === undefined ? {} : { referenceAssets: preset.referenceAssets as Record<string, string[]> }),
    ...(shootRunOptions === undefined ? {} : { shootRunOptions: shootRunOptions as ShootRunOptions }),
    ...(qcThresholds === undefined ? {} : { qcThresholds: qcThresholds as QcThresholds }),
  };
}

export const dashboardAdCommandRunner: CommandRunner = {
  async run(argv, options) {
    const process = Bun.spawn([...argv], {
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    const [raw, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).bytes(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout: new TextDecoder().decode(raw), stderr, exitCode, raw };
  },
};

export function createDashboardAdRunSetupFactory(input: {
  readonly home: string;
  readonly date: string;
  readonly contractsJson: string;
  readonly runner: CommandRunner;
  readonly assetPresetPath?: string;
}): (allowSpend: boolean) => ReturnType<typeof buildAdRunSetup> {
  let runSequence = 0;
  let activeRunSlug: string | undefined;

  return (allowSpend) => {
    if (!allowSpend) {
      const runStart = new Date();
      const time = [runStart.getHours(), runStart.getMinutes(), runStart.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join('');
      activeRunSlug = `dashboard-ad-${time}-${++runSequence}`;
    }
    const slug = activeRunSlug ?? (() => {
      const runStart = new Date();
      const time = [runStart.getHours(), runStart.getMinutes(), runStart.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join('');
      return `dashboard-ad-${time}-${++runSequence}`;
    })();
    const assetPreset = input.assetPresetPath === undefined ? {} : loadDashboardAdAssetPreset(input.assetPresetPath);
    let setup = buildAdRunSetup({
      home: input.home,
      slug,
      date: input.date,
      version: 1,
      aspect: '9x16',
      contractsJson: input.contractsJson,
      runner: input.runner,
      ...assetPreset,
      referenceAssets: assetPreset.referenceAssets ?? {},
      shootRunOptions: { ...dashboardDefaultShootRunOptions, ...assetPreset.shootRunOptions },
      soundtrack: input.runner,
      voiceover: { runner: input.runner, lines: [] },
      allowSpend,
    });
    if (!('error' in setup) && setup.production) {
      const production = {
        ...setup.production,
        assemblyMaterials: { options: { workDir: setup.workDir, outputName: setup.outputName } },
      };
      setup = {
        ...setup,
        production,
        missingProductionInputs: dashboardOptionalProductionInputs.filter((key) => production[key] === undefined),
      };
    }
    return setup;
  };
}

/** Builds the /ad runtime bindings used by showDashboard for each invocation's spend intent. */
export function createDashboardAdRunSetupBindings(
  buildDashboardAdRunSetup: ReturnType<typeof createDashboardAdRunSetupFactory>,
) {
  let adRunSetup: ReturnType<typeof buildAdRunSetup> | undefined;
  let outputSetupError: string | undefined;
  try {
    adRunSetup = buildDashboardAdRunSetup(false);
    outputSetupError = 'error' in adRunSetup ? adRunSetup.error : undefined;
  } catch (error) {
    outputSetupError = error instanceof Error ? error.message : String(error);
  }

  return {
    production: adRunSetup && !('error' in adRunSetup) ? adRunSetup.production : undefined,
    productionForSpend: (allowSpend: boolean) => {
      try {
        const setup = buildDashboardAdRunSetup(allowSpend);
        if ('error' in setup) {
          outputSetupError = setup.error;
          return undefined;
        }
        return setup.production;
      } catch (error) {
        outputSetupError = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    },
    missingProductionInputs: adRunSetup && !('error' in adRunSetup) ? adRunSetup.missingProductionInputs : undefined,
    get outputSetupError() {
      return outputSetupError;
    },
  };
}

/** Connects the dashboard's setup state to the actual /ad runtime. */
export function createDashboardAdSlashRuntime(
  input: Omit<DashboardAdSlashRuntimeDeps, 'production' | 'productionForSpend' | 'missingProductionInputs' | 'outputSetupError'> & {
    readonly adRunSetupBindings?: ReturnType<typeof createDashboardAdRunSetupBindings>;
    readonly adRunSetupError?: string;
  },
): DashboardAdSlashRuntime {
  const { adRunSetupBindings, adRunSetupError, ...deps } = input;
  return createAdSlashRuntime({
    ...deps,
    production: adRunSetupBindings?.production,
    productionForSpend: adRunSetupBindings?.productionForSpend,
    missingProductionInputs: adRunSetupBindings?.missingProductionInputs,
    get outputSetupError() {
      return adRunSetupBindings?.outputSetupError ?? adRunSetupError;
    },
  });
}

export interface DashboardGlobalKeyRegistration {
  id: string;
  key: string;
  chordPrefix?: string;
  scope: 'global';
  handler: () => void;
  when?: () => boolean;
}

export interface RegisterDashboardGlobalKeysDeps {
  enableSupplementalGlobalKeys: boolean;
  register: (binding: DashboardGlobalKeyRegistration) => void;
  openSurfaceCatalog: () => void;
  surfaceCatalogWhen?: () => boolean;
}

/** Registers optional dashboard controls. */
export function registerDashboardGlobalKeys(deps: RegisterDashboardGlobalKeysDeps): void {
  if (deps.enableSupplementalGlobalKeys) {
    deps.register({
      id: 'dashboard:open-surface-catalog',
      key: 'C-g',
      scope: 'global',
      handler: deps.openSurfaceCatalog,
      when: deps.surfaceCatalogWhen,
    });
  }
}

export type ForkableSessionTurn = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

/** Existing session-history flatten used by fork + C-t dump. */
export function flattenForkableSessionHistory(
  source: ReadonlyArray<{ role: string; content: unknown }>,
): ForkableSessionTurn[] {
  const flatten = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const chunks: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) continue;
      const typed = block as { type?: unknown; text?: unknown; content?: unknown };
      if (typed.type === 'text' && typeof typed.text === 'string') chunks.push(typed.text);
      else if (typed.type === 'tool_result' && typeof typed.content === 'string') chunks.push(typed.content);
    }
    return chunks.join('\n').trim();
  };
  const history: ForkableSessionTurn[] = [];
  for (const msg of source) {
    if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') continue;
    const content = flatten(msg.content);
    if (!content.trim()) continue;
    history.push({ role: msg.role, content });
  }
  return history;
}

export interface RegisterDashboardFinderAndHistoryKeysDeps {
  register: (binding: DashboardGlobalKeyRegistration) => void;
  openFinderPicker: () => void | Promise<void>;
  onFinderFailed?: (message: string) => void;
  getSessionHistory: () => ReadonlyArray<{ role: string; content: unknown }>;
  pushChatLine: (line: string) => void;
  draw?: () => void;
  when?: () => boolean;
}

/** C-p opens the finder; C-t dumps flattened session history into the chat log. */
export function registerDashboardFinderAndHistoryKeys(
  deps: RegisterDashboardFinderAndHistoryKeysDeps,
): void {
  deps.register({
    id: 'dashboard:open-finder-picker',
    key: 'C-p',
    scope: 'global',
    handler: () => {
      void Promise.resolve(deps.openFinderPicker()).catch((err) => {
        deps.onFinderFailed?.(err instanceof Error ? err.message : String(err));
        deps.draw?.();
      });
    },
    when: deps.when,
  });
  deps.register({
    id: 'dashboard:show-full-history',
    key: 'C-t',
    scope: 'global',
    handler: () => {
      const history = flattenForkableSessionHistory(deps.getSessionHistory());
      deps.pushChatLine(`── full history (${history.length}) ──`);
      if (history.length === 0) {
        deps.pushChatLine('  (empty)');
      } else {
        for (const msg of history) {
          deps.pushChatLine(`${msg.role}:`);
          for (const line of msg.content.split('\n')) {
            deps.pushChatLine(line);
          }
        }
      }
      deps.draw?.();
    },
    when: deps.when,
  });
}

// ── Last selection persistence ──
const LAST_SEL_PATH = join(DATA_DIR, 'last-selection.json');
interface LastSelection { skills: string[]; servers: string[]; services: string[]; mode: string; ts: string; }

function saveLastSelection(sel: LastSelection): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LAST_SEL_PATH, JSON.stringify(sel, null, 2));
  } catch { /* ok */ }
}

function loadLastSelection(): LastSelection | null {
  try {
    if (!existsSync(LAST_SEL_PATH)) return null;
    return JSON.parse(readFileSync(LAST_SEL_PATH, 'utf-8'));
  } catch { return null; }
}
import { getLocalSkills, executeSync } from '../sync.js';
import { computeDiff } from '../smart.js';
import { analyzeDiff, summarizeDiff, isAnalyzerAvailable } from '../grok.js';
import { C, ICONS, ansi, initTui, closeTui, setExitNotice, readKey, setKeyTracer, render, resetRenderCache, termSize, pad, stripAnsi, timeSince, hLine, showHelp, invalidateRenderCacheRow, wrapAnsiByWidth, injectKey } from '../tui.js';
import { paintCursor, type CursorState } from '../display/cursor-state.js';
import type { CursorDecision } from '../display/cursor-owner.js';
import type { Key, RenderOptions } from '../tui.js';
import {
  createTurnTypeaheadState,
  applyTurnTypeaheadKey,
  renderTurnTypeaheadQueueRow,
  drainTurnTypeaheadOnce,
  renderTurnTypeaheadEcho,
} from '../chat/turn-typeahead.js';
import { dispatchStreamingTurnTypeaheadSubmission } from './input/streaming-turn-typeahead.js';
import { composeVertical, type LayoutZone } from '../layout/composer.js';
import type { CoreTurnDispatchTool } from '../core-turn/index.js';
// streamGrok kept as back-compat shim in chat.ts — not imported here
// directly anymore. Dashboard runs every turn through the in-process
// ACP pair (see `bootDashboardAcpSession`), which internally routes
// to streamLLMWithTools via runCoreTurn.
import {
  startSpinner,
  createChatState,
  buildContext,
  formatResponse,
  onEscAbort,
  attachStreamingKeys,
  SLASH_COMMANDS,
  type InputResult,
  type TextInputExternalSubmitRequest,
} from '../chat/index.js';
import type { TextInputGlobalAction } from '../chat/index.js';
import { matchTextInputGlobalAction } from '../chat/global-actions.js';
import {
  setTokenGaugeSegment,
  setVariantBadgeSegment,
} from '../chat/hud-segments-wire.js';
import { PreviewTerminal } from '../preview/terminal.js';
import { startThinking, startPinnedThinking, type ThinkingHandle } from '../thinking-line.js';
import { debug, getAmbientSessionId } from '../debug/log.js';
import { startEventLoopStallMonitor, thinkingVerbFromFooter } from './event-loop-stall-monitor.js';
import { getPushcutClient } from '../pushcut/client.js';
// P2-3 + P4 + P5 — input-core wiring. Aliased on import to dodge the
// many existing `resolveInputEvent`-ish names elsewhere in this file.
import {
  bootstrapInputCore,
  buildMouseInputEventFromDisplay as inputCoreBuildMouseEventFromDisplay,
  createDragEscInterceptor,
  createInterceptorRegistry,
  derivePolicyForViewMode as inputCoreDerivePolicyForViewMode,
  getAction as getInputCoreAction,
  keyEvent as inputCoreKeyEvent,
  publishMouseTargetToContextKeys as inputCorePublishMouseTargetToContextKeys,
  resolveInputEvent as resolveInputCoreEvent,
  routeInputEvent as inputCoreRouteInputEvent,
  routeInputEventAsync as inputCoreRouteInputEventAsync,
  setMode as inputCoreSetMode,
  activeMode as inputCoreActiveMode,
  registerAction as inputCoreRegisterAction,
  addDefaultBinding as inputCoreAddDefaultBinding,
  initUserBindings as initInputCoreUserBindings,
  readAuditTail,
  isInputAuditEntry,
  formatAuditEntry,
  parseDuration as parseAuditDuration,
  runRebindCommand,
  type DispatchContext as InputCoreDispatchContext,
  type MouseInputEvent as InputCoreMouseInputEvent,
  type RouteCallbacks as InputCoreRouteCallbacks,
} from '../input-core/index.js';
import { initPaneSubstrate } from '../pane-substrate-boot.js';
import { registerCaptureRuntimes } from '../tool-runtime/capture-runtimes.js';
import { applyChalkLevelAdapt } from '../panes/chalk-level-adapt.js';
import {
  buildDamageFromDirtyEntries,
  invalidateRowsForDamage,
} from '../primitives/damage-region/index.js';
import {
  createArtifactStore,
  createLegacyTimelineProvider,
} from '../artifact/index.js';
import { defaultTimelineBaseDir } from '../tool-runtime/recording-runtimes-paths.js';
import { createVisualStateStore } from '../panes/visual-state.js';
import { composeIdentityHooks } from '../display/modal-identity-wiring.js';
import { composeWorkspaceHostHooks } from '../display/workspace-host-wiring.js';
import {
  getSurfaceRegistry,
} from '../surface/index.js';
import { wireAutoModeContextBridge } from '../auto-research/auto-mode/context-keys-bridge.js';
import { wireAndonContextBridge } from '../cft/andon-context-bridge.js';
import { wireBudgetContextBridge } from '../intelligence-map/budget-context-bridge.js';
import { wirePlanModeContextBridge } from '../plan-mode/context-bridge.js';
import { wireInputModeContextBridge } from '../input-core/mode-context-bridge.js';
import { getDashboardContextKeyService } from './context/keys.js';
import {
  getDashboardContextMenuRegistry,
  handleForPill,
} from './context-menu/registry.js';
import { createTransientOverlayHost } from '../display/transient-overlay-host.js';
import { configureThemeIconsGetter } from '../theme/icons.js';
import { configureModalAdapterTheme } from '../ui/modal-adapter.js';
import {
  CHAT_LOG_BUFFER_SOFT_LIMIT,
  DEBUG_LOG_BUFFER_SOFT_LIMIT,
  trimLogBuffer,
} from '../log-pane/buffer-policy.js';
import { publishFocusContextKeysFromService } from './context/focus-bridge.js';
import {
  modalBlocksBackground,
  modalParticipatesInViewMode,
  renderModalStack,
  topBlockingForegroundModalSurface,
  topModalSurface,
  topWorkspaceSurface,
} from '../display/modal-stack.js';
import {
  isWorkspaceInteractionSurface,
  ownsForegroundModalKeyRoute,
} from '../display/surface-interaction-policy.js';
import { shouldFreezeDashboardBottomArea } from '../display/bottom-area-freeze.js';
import { computeCompanionPopupBounds } from '../window/companion-popup-layout.js';
import {
  buildDebugWorkbenchColumns,
  debugWorkbenchIndexForTarget,
  getDebugCompanionSpec,
  listDebugCompanionKeys,
  resolveDebugCompanionTargets,
  type DebugWorkbenchPane,
} from '../window/debug-window-consumers.js';
import {
  planTabletCompanionSlot,
  resolveTabletConversationLayoutMode,
  resolveTabletWorkspacePolicy,
} from '../window/tablet-workspace-policy.js';
import {
  type PromptFrame,
  bottomFixedRowsForPromptFrame,
  resolvePromptFrame,
} from '../display/prompt-frame.js';
import { resolveBottomSlotBounds } from '../display/bottom-slot.js';
import {
  computePromptFrameLogEndRow,
  computePromptFrameGridHeight,
  computePromptFrameLogViewportBounds,
  computePromptFrameLogViewportHeight,
} from '../display/prompt-frame-layout.js';
import {
  buildDashboardLogProjection,
  buildDashboardRenderSnapshot,
  resolveDashboardFocusedInstanceId,
} from './render/renderer.js';
import { buildPromptFrameDividerRows } from '../display/prompt-frame-paint.js';
import {
  drawTurnTypeaheadPromptRows,
  paintTurnTypeaheadEchoRow,
  resolveEssentialFrameCursorDecision,
  type EssentialFrameCursorDecision,
  type TurnTypeaheadPromptPaintSink,
  type TurnTypeaheadPromptRowsInput,
} from './input/turn-typeahead-prompt.js';
import { DashboardStateStore } from './runtime/state-store.js';
import { perf } from '../perf-counters.js';
import { createSearchModal, type SearchModalHandle, type SearchItem } from '../chat/search/modal.js';
import { toDashboardKeyEvent } from './input/key-types.js';
import { composeDashboardKeyHandlers, dispatchDashboardKey } from './input/key-dispatcher.js';
import { runDashboardChatMainEntry } from './input/chat-main-entry-runtime.js';
import { createMirrorDrawThrottle } from './mirror-draw-throttle.js';
import { runDashboardChatMainPlainTurn } from './input/chat-main-plain-turn-runtime.js';
import {
  createDashboardChatMainTurnSubmit,
  runDashboardChatMainSubmitIntent,
} from './input/chat-main-submit-intent-runtime.js';
import { buildDefaultDashboardToolBuilders } from './input/dashboard-default-tool-builders.js';
import { resolveDashboardChatMainEntryPrelude } from './input/chat-main-entry-prelude.js';
import { CHAT_MAIN_AUTO_ENTRY_KEY_NAME } from './input/entry-mode.js';
import { resolveDashboardChatMainPostTurn } from './input/chat-main-post-turn.js';
import { resolveDashboardChatMainSubmitIntent } from './input/chat-main-submit-route.js';
import { maybeEmitDashboardSubmitQuickPass } from './input/chat-main-submit-control.js';
import { attachDashboardQuickPassConsumers } from './input/control-signal-consumers.js';
import { resolveDashboardChatMainSlashCommand } from './input/chat-main-slash-command.js';
import { TuiChatPersonaSelection, tuiChatPersonaMessages } from './slash-runtime/chat-persona.js';
import { awaitGlobalPersonaLoad } from '../persona/global-registry.js';
import { resolveDashboardChatMainCacheCommand } from './input/chat-main-cache-command.js';
import {
  dashboardDeltaHelpLines,
  resolveDashboardChatMainDeltaCommand,
} from './input/chat-main-delta-command.js';
import {
  DASHBOARD_SETUP_STEPS,
  dashboardSetupHelpLines,
  resolveDashboardChatMainSetupCommand,
} from './input/chat-main-setup-command.js';
import { createDashboardInlineSetupFlow } from './setup-inline.js';
import { resolveDashboardChatMainThemeCommand } from './input/chat-main-theme-command.js';
import { resolveDashboardChatMainLogCommand } from './input/chat-main-log-command.js';
import { noProviderReply } from './input/no-provider-reply.js';
import {
  dashboardLogHelpLines,
  resolveDashboardLogFilterAction,
  resolveDashboardLogSearchAction,
  resolveDashboardLogSizeAction,
  resolveDashboardLogTurnAction,
} from './input/chat-main-log-actions.js';
import type { LogTurnSeparatorMode } from './log-turn-separator-mode.js';
import { createDashboardChatMainInteractionOpts } from './input/chat-main-interaction-opts.js';
import { createDashboardChatMainCompletionOpts } from './input/chat-main-completion-opts.js';
import { createDashboardChatMainAttachmentOpts } from './input/chat-main-attachment-opts.js';
import { createDashboardChatMainAtCandidateOpts } from './input/chat-main-at-candidate-opts.js';
import { dispatchDashboardChatMainAcpSend } from './input/chat-main-acp-dispatch.js';
import {
  createDashboardChatMainGlobalActionRuntime,
} from './input/chat-main-global-action-runtime.js';
import {
  resolveBellSubmitAction,
  runBellSubmitAction,
} from './input/bell-actions.js';
import {
  matchDashboardChordAction,
} from './input/dashboard-chord-actions.js';
import { createDashboardChordRuntime } from './input/dashboard-chord-runtime.js';
import { handleDashboardDisplayKeyRoute } from './input/dashboard-display-key-route.js';
import { routeDashboardPriorityKey } from './input/dashboard-priority-key-route.js';
import { shouldPassthroughDashboardHostOwnedInputCoreAction } from './input/input-core-host-action.js';
import { routePaneCommonKey } from './input/pane-common-key-route.js';
import { handlePreviewTerminalKey } from './input/preview-terminal-key-route.js';
// Surface-unification v2.2 V2.2-5 Part 2 — `routeSchedulerScratchKey` import
// retired (scheduler view 폐기 · scratch key router file 자체도 삭제).
import { matchDashboardViewShortcut } from './input/dashboard-view-shortcuts.js';
import {
  cycleSessionSidebarCursor,
  focusSessionSidebarCursor,
  revealSessionInSidebar,
} from './input/session-sidebar-actions.js';
import {
  runWidgetCursorBridge,
} from './input/widget-cursor-bridge.js';
import { runListPaneCursorBridge } from './input/list-pane-cursor-bridge.js';
import { runScrollPaneBridge } from './input/scroll-pane-bridge.js';
import {
  resolveLogZoneMouseActionPlan,
  resolvePaneBodyMouseActionPlan,
  resolvePaneNavMouseActionPlan,
  runDashboardMouseSurfaceActionPlan,
} from './input/mouse-surface-actions.js';
import { resolveLogPaneCopyAction } from './input/log-pane-copy-action.js';
import {
  resolveDashboardSubmitAction,
  runDashboardSubmitAction,
} from './input/submit-actions.js';
import { runDashboardAction } from './runtime/action-effects.js';
import { runDashboardWidgetAction } from './runtime/widget-action-effects.js';
import {
  createChatMainInputVisibilityState,
  isChatMainInputForegroundActive,
  shouldAutoEnterChatMainInput,
} from './input/chat-main-visibility.js';
import { createDashboardVoiceRuntime } from './voice-runtime.js';
import { setDaemonInputHost } from '../voice/daemon-input-host-singleton.js';
import { defaultControlSignalBus } from '../input/control-signal.js';
import { defaultControlSignalObserver } from '../input/control-signal-observer.js';
import {
  bootDashboardVoiceHost,
  reportDashboardVoiceBootError,
} from './voice-host-boot.js';
import {
  bootDashboardAutoTts,
  handleAutoTtsSlash,
} from './auto-tts/auto-tts-host-boot.js';
import {
  bootDashboardVoiceChat,
  handleVoiceChatSlash,
  toggleVoiceChatRealtime,
} from './voice-chat/voice-chat-host-boot.js';
import { describeVoiceChatPhase } from './voice-chat/voice-chat-mode-controller.js';
import { hasOverlayInputOwner } from './input/overlay-input.js';
import { deriveInputOwnershipSnapshot } from './input/input-owner.js';
import { createDashboardInputPrefixState } from './input/input-prefix-state.js';
import {
  cleanupDashboardInputLoopExit,
  restoreDashboardInputExit,
} from './input-exit-runtime.js';
import {
  resolveLegacyForegroundModalFocusPlan,
  resolveLegacyForegroundModalDemotionTransition,
  resolveLegacyForegroundModalFallbackPane,
} from './input/foreground-modal-focus.js';
import {
  resolveDashboardInitialWorkingFocus,
  resolveFocusToInputTransition,
  resolveFocusToPaneTransition,
  resolvePaneEnterInputTransition,
} from './input/focus-transition.js';
import {
  applyFocusToInputTransition as applyFocusToInputTransitionState,
  applyFocusToPaneTransition as applyFocusToPaneTransitionState,
} from './input/focus-transition-apply.js';
import { createDashboardFocusTransitionState } from './input/focus-transition-state.js';
import { addHint, listHints, removeHint, resetScope } from '../tool-hints/registry.js';
import { resetGateCache } from '../tool-hints/gate.js';
import { collectSignals, signalsSummary } from '../tool-hints/signals.js';
import { resetProbes } from '../tool-hints/probe.js';
import {
  addAllowed,
  hostOf,
  listAllowed,
  rateLimitStatus,
  removeAllowed,
} from '../tool-hints/api-allowlist.js';
import type { HintScope } from '../tool-hints/types.js';
import { listSkillNames, describeSkill } from '../skills/runner.js';
import { globalAgentRegistry, type AgentToolCallEvent } from '../agent/registry.js';
import { SELF_IMPLEMENT_TOOL_NAMES } from '../boot/daemon-tools/self-implement-names.js';
import { FOLD_LIMITS, type FoldMode } from '../log-entry.js';
import { renderToolCallEvent, renderToolResultVariants } from '../chat/tool-render/index.js';
import { FoldStack } from '../fold-stack.js';
import { getSkillIndex, reloadSkillIndex, applySkillFilter, skillIndexProblems } from '../skills/index.js';
import { skillRepairNotice } from '../skills/repair.js';
import type { DetectResult } from '../skills/router.js';
import { detectUrlRoute } from '../skills/url-router.js';
import {
  observeDevRequestRouteFailSoft,
  type DevRequestRoutingConfig,
} from '../skills/dev-request-router.js';
import { urlStagePlan } from '../skills/url-route-exec.js';

/**
 * Dashboard's pre-LLM observation seam. It intentionally returns no routing
 * result, so its caller always continues through the existing chat path.
 */
export function observeDashboardDevRequestRoute(
  text: string,
  cfg: DevRequestRoutingConfig,
): void {
  observeDevRequestRouteFailSoft(text, cfg, { surface: 'dashboard' });
}

export interface EscAbortToolState {
  activeToolNamesByCallId: Map<string, string>;
}

export function createEscAbortToolState(): EscAbortToolState {
  return { activeToolNamesByCallId: new Map() };
}

export function trackEscAbortToolCall(toolState: EscAbortToolState, call: Pick<DashboardTurnStreamCall, 'id' | 'name'>): void {
  toolState.activeToolNamesByCallId.set(call.id, call.name);
}

export function settleEscAbortToolCall(toolState: EscAbortToolState, call: Pick<DashboardTurnStreamCall, 'id'>): void {
  toolState.activeToolNamesByCallId.delete(call.id);
}

export function clearEscAbortToolState(toolState: EscAbortToolState): void {
  toolState.activeToolNamesByCallId.clear();
}

export function activeEscHarnessSpace(
  toolState: EscAbortToolState,
  spacesByCallId: ReadonlyMap<string, string>,
): string | null {
  const active = [...toolState.activeToolNamesByCallId].filter(([, name]) =>
    (SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(name));
  return active.length === 1 ? spacesByCallId.get(active[0]![0]) ?? null : null;
}

/** Reset per-turn ESC tool tracking before a new stream runtime begins. */
export function createDashboardTurnStreamRuntimeEscBoundary(toolState: EscAbortToolState): void {
  clearEscAbortToolState(toolState);
}

export function getEscAbortWaitingToolNames(toolState: EscAbortToolState): string[] {
  try {
    return [...new Set([...toolState.activeToolNamesByCallId.values()])].sort();
  } catch {
    return ['unknown running work'];
  }
}

export function formatEscAbortWaitingTargets(targets: readonly string[]): string {
  if (targets.length === 0) return '응답';
  if (targets.length <= 3) return targets.join(', ');
  return `${targets.slice(0, 3).join(', ')} +${targets.length - 3} more`;
}

export function settleEscAbortPendingLines(lines: string[], fromIndex: number): void {
  let settled = false;
  for (let index = fromIndex; index < lines.length;) {
    const line = lines[index]!;
    const isAbortPending = line.startsWith('  ⏳ 중단 요청됨 — ');
    const isAbortRepeat = /^  ⏳ ESC 재시도 \d+회 — /.test(line);
    if (!isAbortPending && !isAbortRepeat) {
      index += 1;
      continue;
    }

    if (settled) lines.splice(index, 1);
    else {
      lines[index] = '  ⏹ 중단됨';
      settled = true;
      index += 1;
    }
  }
}

export type DashboardToolDispatchSignalSource = 'parent-turn' | 'fallback';

export interface DashboardToolDispatchSignalObservation {
  toolName: string;
  turnIndex: number | null;
  signalSource: DashboardToolDispatchSignalSource;
  hasParentTurnAbortSignal: boolean;
  signalAlreadyAborted: boolean;
}

export function observeDashboardToolDispatchSignal(observation: DashboardToolDispatchSignalObservation): void {
  try {
    debug.log('dashboard.tool-dispatch-signal', 'selected', observation);
  } catch {
    // Observability must not prevent dashboard tool dispatch.
  }
}

export function resumeInProcessDashboardSession(
  resumeSessionId: string,
  deps: {
    resolveSessionId: (prefix: string) => string | null;
    historyFromSession: (sessionId: string) => { history: ChatMessage[] } | null;
    chatHistory: ChatMessage[];
    setAttachedSessionId: (sessionId: string) => void;
    setActiveSessionId: (sessionId: string) => void;
  },
): { resumed: true; sessionId: string; turns: number } | { resumed: false; reason: string } {
  const resolvedId = deps.resolveSessionId(resumeSessionId);
  const loaded = resolvedId ? deps.historyFromSession(resolvedId) : null;
  if (!resolvedId || !loaded) return { resumed: false, reason: resumeSessionId };

  const sysFromDash = deps.chatHistory.find((message) => message.role === 'system');
  deps.chatHistory.length = 0;
  if (sysFromDash) deps.chatHistory.push(sysFromDash);
  for (const message of loaded.history) {
    if (message.role === 'system' && sysFromDash && message.content === sysFromDash.content) continue;
    deps.chatHistory.push(message);
  }
  deps.setAttachedSessionId(resolvedId);
  try { deps.setActiveSessionId(resolvedId); } catch { /* best-effort */ }
  return { resumed: true, sessionId: resolvedId, turns: loaded.history.length };
}

/**
 * The ESC callback evaluates dashboard tool state and registered agents at
 * keypress time. Self-implementation children are intentionally counted from
 * the dashboard stream that invoked them rather than from PTY manifests.
 */
export function getEscAbortRunningCount(
  toolState: EscAbortToolState,
  registeredRunning = globalAgentRegistry.list().filter((agent) => agent.state === 'running').length,
): number {
  try {
    const dashboardToolRunning = [...toolState.activeToolNamesByCallId.values()]
      .filter((toolName) => (SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(toolName))
      .length;
    return registeredRunning + dashboardToolRunning;
  } catch {
    return Math.max(1, registeredRunning);
  }
}
import { resetOnboardingMarker } from '../onboarding.js';
import {
  getUserConfig, reloadUserConfig, saveUserConfig,
  rotateNextProvider, jumpToRotationEntry, rotationEntryLabel, applyRotationEntry,
  currentRotationIndex, resolveAcpHopCapFromConfig,
  VOICE_HARDCODED_DEFAULTS,
} from '../user-config.js';
import { listProviders, streamLLM, anyProviderAvailable, getProviderForConfig, REASONING_CYCLE, nextReasoningLevel, reasoningLevelLabel, effectiveReasoningLevel, modelSupportsReasoning, type LLMMessage, type LLMToolSpec } from '../llm.js';
import { resolveRouteDecision, recordCurrentRouteDecision, currentRouteDecision, formatRouteDecisionSummary } from '../llm/route-decision.js';
import type { ReasoningLevel } from '../user-config.js';
import { getModelFamily, getModelTier } from '../models/prompts.js';
import { buildPromptInjection, getPromptBankStore } from '../prompt-bank/index.js';
import { getInputHistoryStore, inputHistoryDbPath, inputHistoryJsonPath } from '../input-history.js';
import { inspectActiveProvider } from '../provider-summary.js';
import { activeCodexAccountView } from '../oauth/codex-account-store.js';
import { buildDashboardStatusLines } from './dashboard-status-lines.js';
import { readSlashContextNow, seatsNowLine } from '../context-bus/context-now-surfaces.js';
import { buildFirstScreenBand } from './first-screen-band.js';
import { runNexusShow, type NexusShowResult } from '../cli/nexus-show.js';
import {
  workingDirSegment, sessionCwdSegment, modelSegment, gitSegment,
  ctxBarSegment, costSegment, speedSegment, elapsedSegment, cacheSegment,
  ptyShellCountSegment,
  voiceCostSegment,
  type GitSegmentState,
} from '../status/bar.js';
// PR-S1V.5 — voice month-to-date USD pill on the secondary status row.
// The tracker is process-wide so the same singleton is read here and
// updated by `voice-input-bridge.transcribe` (TUI path) + daemon REST
// handler (PWA path).
import { globalVoiceCostTracker } from '../voice/cost-tracker.js';
import { createDashboardMouseWiring } from './input/mouse-wiring.js';
import { createMouseConversationPopupRuntime } from './input/mouse-conversation-popup-runtime.js';
import { createMouseModalHitRuntime } from './input/mouse-modal-hit-runtime.js';
import { createMouseModalSurfaceRuntime } from './input/mouse-modal-surface-runtime.js';
import { createMouseModeSwitchRuntime } from './input/mouse-mode-switch-runtime.js';
import { createMousePaneHitRuntime } from './input/mouse-pane-hit-runtime.js';
import { createMousePickerRuntime } from './input/mouse-picker-runtime.js';
import { createMouseShellRollupRuntime } from './input/mouse-shell-rollup-runtime.js';
import { createDashboardPluginBaseRuntime } from './plugin-base-runtime.js';
import { createDashboardPluginExecutionRuntime } from './plugin-execution-runtime.js';
import { createDashboardPluginPaneRuntime } from './plugin-pane-runtime.js';
import { createDashboardPluginThemeControl } from './plugin-theme-control.js';
import { registerDashboardPaneArtifactRuntimes } from './pane-artifact-runtime-registration.js';
import { handleDashboardAttachmentPopupAction } from './attachment-popup-actions.js';
import { renderDashboardAttachmentSummary } from './attachment-summary.js';
import { openDashboardFolderAttachModal } from './folder-attach-modal-runtime.js';
import { createDashboardLogClickDeps } from './log-click-runtime.js';
import { runDashboardSidebarSessionJoin } from './sidebar-session-join-runtime.js';
import {
  runDashboardAutoRouteCountdown,
  runDashboardTabConfirmRoute,
} from './skill-route-prompt.js';
import {
  formatDashboardSkillHint,
  resolveDashboardSkillRouteDecision,
} from './skill-route-runtime.js';
import { detectDashboardSkillRoute, runAbortableDashboardSkillRoute } from './skill-detection-runtime.js';
import { buildDashboardTurnPromptRuntime } from './turn-prompt-runtime.js';
import { buildDashboardTurnMessage } from './turn-message-runtime.js';
import { runDashboardAutoCompact } from './auto-compact-runtime.js';
import { beginDashboardCodeEditTurn } from './code-edit-turn-runtime.js';
import { runDashboardCodeEditPostTurn } from './code-edit-post-turn-runtime.js';
import { buildDashboardOptionalToolSpecs } from './optional-tool-spec-runtime.js';
import { createDashboardRenderedToolRuntime } from './rendered-tool-runtime.js';
import { runDashboardHandoffMirror } from './handoff-mirror-runtime.js';
import {
  applyDashboardActionBlock,
  parseDashboardActionBlock,
} from './action-block-runtime.js';
import { runDashboardActionBlockEffects } from './action-block-effect-runtime.js';
import { createRunDiffInline } from './run-diff-inline.js';
import { finalizeDashboardTurn } from './turn-finalize-runtime.js';
import {
  recordDashboardTurnMetrics,
  runDashboardTurnUsageRuntime,
} from './turn-metrics-runtime.js';
import {
  createDashboardTurnStreamRuntime,
  type DashboardTurnStreamCall,
} from './turn-stream-runtime.js';
import {
  armDashboardAcpTurnRef,
  createDashboardAcpTurnRef,
  finalizeDashboardStreamLifecycle,
  resetDashboardAcpTurnRef,
} from './turn-lifecycle-runtime.js';
import { runDashboardTurnPrelude } from './turn-prelude-runtime.js';
import { askSeat, deliverSeatAnswers, getTuiSeatAskClientId, parseSeatAsk } from '../seat-dispatch/seat-ask.js';
import { ceoTaskDeps } from '../seat-dispatch/ceo-intent.js';
import {
  commitDashboardAssistantRenderState,
  runDashboardTurnTailAutoCopy,
} from './turn-tail-runtime.js';
import {
  handleDashboardSidebarAttachFile,
  handleDashboardSidebarAttachFolder,
} from './sidebar-attachment-insert.js';
import { createDashboardSidebarSubmitRuntime } from './sidebar-submit-runtime.js';
import { handleDashboardSidebarWorkingDirChange } from './sidebar-working-dir-change.js';
import { runDashboardSkillByName } from './skill-runtime.js';
import { createDashboardClipboardActions } from './clipboard-actions.js';
import {
  buildDashboardEditorOpenPayload,
} from './clipboard-message-runtime.js';
import { createDashboardCopyRuntime } from './copy-runtime.js';
import { createDashboardMediaRuntime } from './media-runtime.js';
import { openDashboardMediaPreviewInSurface } from './media-preview-surface-runtime.js';
import { appendDashboardAssistantSampleOutput } from './assistant-sample-runtime.js';
import { createDashboardChordFeedbackRuntime } from './chord-feedback-runtime.js';
import { createDashboardContextMenuFeedbackRuntime } from './context-menu-feedback-runtime.js';
import { createDashboardStatusFeedbackRuntime } from './status-feedback-runtime.js';
import { createDashboardTransferFeedbackRuntime } from './transfer-feedback-runtime.js';
import { createDashboardFinderFeedbackRuntime } from './finder-feedback-runtime.js';
import { createDashboardTermSlashRuntime } from './term-slash-runtime.js';
import { createDashboardShellSlashRuntime } from './shell-slash-runtime.js';
import { createDashboardRunSkillSlashRuntime } from './run-skill-slash-runtime.js';
import { createDashboardSkillTriggersSlashRuntime } from './skill-triggers-slash-runtime.js';
import { createDashboardProviderSlashRuntime } from './provider-slash-runtime.js';
import { createDashboardPreviewSlashRuntime } from './preview-slash-runtime.js';
import { createDashboardCompanionSlashRuntime } from './companion-messages-runtime.js';
import { createDashboardAgentsSlashRuntime } from './agents-slash-runtime.js';
import { createDashboardControlSignalSlashRuntime } from './control-signal-slash-runtime.js';
import { createDashboardBrowserCdpSlashRuntime } from './browser-cdp-slash-runtime.js';
import { collectGroundingFactsViaCdp } from '../product-grounding/cdp-collect.js';
import { createDashboardSimSlashRuntime } from './sim-slash-runtime.js';
import {
  createDashboardAdSlashRuntime as createAdSlashRuntime,
  type DashboardAdSlashRuntime,
  type DashboardAdSlashRuntimeDeps,
} from './ad-slash-runtime.js';
import { openDashboardLocalSimulationWebCockpit } from './sim-web-cockpit-runtime.js';
import { createDashboardCompanionFeedbackRuntime } from './companion-feedback-runtime.js';
import { resolveDashboardMediaSlash } from './media-slash-runtime.js';
import { createDashboardMemoCompanionRuntime } from './memo-companion-runtime.js';
import { createDashboardDetailViewerRuntime } from './detail-viewer-runtime.js';
import { createDashboardCompanionWidgetRuntime } from './companion-widget-runtime.js';
import { createDashboardClipboardHistoryRuntime } from './clipboard-history-runtime.js';
import { createDashboardClipboardCompanionRuntime } from './clipboard-companion-runtime.js';
import { createDashboardMemoWidgetRuntime } from './memo-widget-runtime.js';
import { createDashboardLogWidgetRuntime } from './log-widget-runtime.js';
import { createDashboardLogRenderRuntime } from './log-render-runtime.js';
import { createDashboardBrowserWidgetRuntime } from './browser-widget-runtime.js';
import { createDashboardSkillWidgetRuntime } from './skill-widget-runtime.js';
import { createAgentRosterEventPump, createDashboardAgentRosterRuntime, type DashboardAgentUpdateEvent } from './agent-roster-runtime.js';
import { createAgentProgressRuntime } from './agent-progress-runtime.js';
import { createBackgroundPillRuntime } from './background-pill-runtime.js';
import { openWidgetModalPopup } from './widget-modal-popup.js';
import { createDashboardAgentWidgetRuntime } from './agent-widget-runtime.js';
import { createDashboardDebugWidgetRuntime } from './debug-widget-runtime.js';
import { createDashboardPreviewWidgetRuntime } from './preview-widget-runtime.js';
import { createDashboardDebugEventRuntime } from './debug-event-runtime.js';
import { createDashboardDebugSurfaceRuntime } from './debug-surface-runtime.js';
import { createDashboardPreviewSurfaceRuntime } from './preview-surface-runtime.js';
import { createTerminalMouseIntentRuntime } from './terminal-mouse-intent-runtime.js';
import { createDefaultConsumers } from './terminal-intent-consumers/index.js';
import type { RangeSelectSpec } from './terminal-intent-consumers/range-select.consumer.js';
import { createDashboardPfcFeedbackRuntime } from './pfc-feedback-runtime.js';
import {
  createCaretContextStore,
  type CaretContextStore,
} from './terminal/caret-context-store.js';
import { createPfcMouseActionRuntime, type PfcMouseActionRuntime } from './terminal/pfc-mouse-action-runtime.js';
import { createPfcVoiceRuntime, type PfcVoiceRuntime } from './auto-tts/pfc-voice-runtime.js';
import { createPfcScreenshotAttacher, type PfcScreenshotAttacher } from '../conductor/pfc-screenshot-attachment.js';
import { createStatusShellPostureRuntime } from './status-shell-posture-runtime.js';
import { createTerminalHostFacade } from '../shell-runner/terminal-host-facade.js';
import {
  buildTerminalMouseIntentEvent,
  interpretTerminalSurfaceIntent,
} from './terminal-surface-intent.js';
import {
  classifyTerminalSessionExposure,
  describeTerminalPosture,
  interactiveTerminalExposure,
  type TerminalExposureSnapshot,
  type TerminalInteractionPolicy,
} from './terminal-exposure.js';
// Surface-unification v2.2 V2.2-5 Part 2 — `createDashboardSchedulerWidgetRuntime`
// import + 호출 site 폐기. scheduler-widget-runtime.ts file 자체도 삭제.
import { createDashboardBrowserMirrorRuntime } from './browser-mirror-runtime.js';
import {
  reportDashboardBrowserOpenAction,
  reportDashboardBrowserRevealResult,
  runDashboardScratchClearAction,
  runDashboardScratchCopyAllAction,
  runDashboardScratchExportAction,
} from './context-menu-action-runtime.js';
import { createDashboardTerminalPopupRuntime } from './terminal-popup-runtime.js';
import { toggleDashboardAssistantRenderState } from './assistant-render-state-runtime.js';
import { bootDashboardAcpBgSweep } from './acp-bg-sweep-boot.js';
import { bootDashboardConfigTools } from './config-tools-boot.js';
import { bootDashboardConversationPopupRuntime } from './conversation-popup-boot.js';
import { bootDashboardTerminalRuntime } from './terminal-runtime-boot.js';
import { bootDashboardInputCore } from './input-core-boot.js';
import { bootDashboardApproverRuntimes } from './approver-runtime-boot.js';
import { bootDashboardCaptureSourceProviders } from './capture-source-provider-boot.js';
import { bootDashboardContextMenuProviders } from './context-menu-provider-boot.js';
import { bootDashboardContextMenuRegistry } from './context-menu-registry-boot.js';
import { buildPillMenu } from '../ui/context-menu-registry.js';
import { createActionPickerRecipe } from '../mouse-action-recipes.js';
import type { PopupPlacement } from '../ui/chrome/picker-popup-placement.js';
import { deriveSubmenuPopupRoleTheme } from '../ui/submenu-popup-theme.js';
import { bootDashboardContextRuntime } from './context-runtime-boot.js';
import { bootDashboardContextWindowRuntime } from './context-window-runtime-boot.js';
import { bootDashboardEagerTools } from './eager-tool-boot.js';
import { bootDashboardEmbodiedTools } from './embodied-tools-boot.js';
import { bootDashboardHitl } from './hitl-boot.js';
import { attachDashboardFilePathToken } from './file-path-attachment.js';
import { bootDashboardSlashExecutor } from './slash-executor-boot.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from './slash-runtime/index.js';
import { unknownSlashReply } from './slash-runtime/unknown-slash-reply.js';
import { resolveSurfaceUx } from '../agent/surface-ux/build.js';
import type { SurfaceUx } from '../agent/surface-ux/types.js';
import { getDefaultQuestionChannels, type QuestionChannel } from '../hitl/question.js';
import { getDefaultCompactProvider, scheduleArchiveRetentionOnce } from '../compact/index.js';
import { attachDashboardWorkingDirSelection } from './working-dir-selection-attachment.js';
import { createBrowserHelpRuntime } from './browser-help-runtime.js';
import { createBrowserChordRuntime } from './browser-chord-runtime.js';
import { summarizeFileWithLLM } from './browser-llm-summary.js';
import { resolveDashboardHostChromePolicy } from './host-chrome-policy.js';
import {
  bootDashboardPlanModeRuntime,
  cleanupDashboardWorktreeSessions,
  createDashboardPlanModeHandoff,
} from './plan-mode-runtime-boot.js';
import { bootDashboardShellRunner } from './shell-runner-boot.js';
import { bootDashboardWidgetInspector } from './widget-inspector-boot.js';
import { bootDashboardWidgetTools } from './widget-tools-boot.js';
import { bootDashboardViewTools } from './view-tools-boot.js';
import { bootDashboardYoloPolicy } from './yolo-policy-boot.js';
import { registerDashboardLayoutDisplayRuntimes } from './layout-display-runtime-registration.js';
import {
  loadDashboardScenarioCatalog,
  registerDashboardScenarioRuntimes,
} from './scenario-runtime-boot.js';
import { wireDashboardSurfaceRegistry } from './surface-registry-wiring.js';
import { bootDashboardWidgetHost } from './widget-host-boot.js';
import { registerDashboardWidgetRuntimes } from './widget-runtime-registration.js';
import { createDashboardWidgetHostRuntime } from './widget-host-runtime.js';
import { dragDispatch } from '../display/drag-dispatch.js';
import { wireDragSessionToDashboard } from '../drag-session-dashboard-wire.js';
// CMX-2 (2026-04-22) — context-menu primitive wiring. 3 modules:
//   - MenuProviderRegistry (HitKey → Menu lookup)
//   - wireContextMenuToDashboard (composer: resolve → show → onPick)
//   - registerBrowserContextMenus (first production consumer)
import { wireContextMenuToDashboard } from '../context-menu-dashboard-wire.js';
import {
  type BrowserBodyMenuPayload,
} from '../browser-context-menu.js';
import {
  type ScratchMenuPayload,
} from '../scratch-context-menu.js';
import {
  type DashboardPaneTitleMenuPayload,
} from '../dashboard-pane-context-menu.js';
// writeClipboard imported below with other clipboard helpers (line ~185).
import {
  renderPaneNav, paneAtColumn, paneNavLabel,
  type PaneNavHitArea,
} from './panes/nav.js';
import { getSessionCwd, setSessionCwd, subscribeSessionCwd, pickSwdTargetFromBrowser } from '../session/working-dir.js';
import {
  getGitStatusView,
  subscribeGitChanges,
  refreshDirty as refreshGitDirty,
} from '../git-fs/index.js';
import { getPty, listPty, requestPtyTakeover } from '../pty-shell/registry.js';
import { listPtyManifestRowsAt } from '../pty-shell/pty-manifest.js';
import { ptyManifestTargets } from '../domains/fleet.js';
import { runPtySnapshot, type PtyTakeoverCommandDeps } from '../cli/pty-takeover-cli.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { formatPtyCallLine, formatPtyResultLine } from '../pty-activity-log.js';
import { getSessionMetrics } from '../status/metrics.js';
import {
  createContextRegistry, tokenizeInput, pruneUnreferenced,
  addAttachment as ctxAdd,
  addAttachmentEx as ctxAddEx,
  clearAll as ctxClearAll, clearLarge as ctxClearLarge,
  dropAttachment as ctxDrop, listAttachments as ctxList,
  totalContextBytes as ctxTotalBytes,
  DEFAULT_LARGE_THRESHOLD_BYTES,
  type Attachment,
} from '../context.js';
import { loadAllAttachments } from '../extractors.js';
import { grabClipboardImage, pruneOldPastes, isClipboardSupported, writeClipboard, writeClipboardDetailed, hasClipboardImage } from '../clipboard/index.js';
import { startClipboardHistory, type ClipboardHistory } from '../clipboard/history.js';
import { renderImagePreview } from '../image/preview.js';
import { isKgpTerminal } from '../kgp/capabilities.js';
import { renderImageKGP } from '../kgp/pipeline.js';
import { _internal as previewRouterInternal } from '../preview/router.js';
import { showPreviewModal } from './modals/preview.js';
import { terminalModalRouter } from './input/terminal-modal-router.js';
import {
  computeDashboardViewMode,
  syncDashboardViewModeToContextKeys,
  type DashboardViewModeSignals,
} from './runtime/view-mode.js';
import { IDLE_VIEW_MODE, type ViewMode } from '../input-core/view-mode.js';
import { createInteractiveTerminalModal } from '../interactive-terminal-modal.js';
import { showToast } from './render/toast.js';
import {
  browserWidgetInstanceIdForView,
  shortcutFor,
} from './modals/pane.js';
import { showTransientTerminalModal, currentTransientTerminalModal } from './modals/transient.js';
import { showPaneMultiModal, showLivePaneMultiModal, currentPaneMultiModal, type PaneMultiModalHandle } from './modals/pane-multi.js';
import {
  resolveCompanionPopupChrome,
  resolveCompanionPopupTitleControls,
  resolveWindowScopedCompanionPopupChrome,
} from './modals/companion-popup-chrome.js';
import {
  resolveDebugPaneMultiChrome,
  resolveDebugWorkbenchStatus,
  resolveDebugWindowStatus,
} from './modals/debug-pane-chrome.js';
import {
  openBrowserPreviewModalHost,
  resolveBrowserPreviewModalLiveMode,
} from './modals/browser-preview-modal-seams.js';
import { initDashboardTerminalSessions } from './terminal/session.js';
import {
  initTerminalMatrix,
  TerminalRegistry,
  BroadcastBus,
  PreviewSlotAdapter,
  getChannelBus,
  type TerminalPlacement,
} from '../terminal-matrix/index.js';
import { resolveTerminalMoveDestination } from '../terminal-matrix/mobility.js';
import { initElementObservability } from '../element-registry/index.js';
import {
  armSessionQuickControl,
  createSearchPlannerState,
  buildSessionRuntimeToolSpecs,
  buildSessionDashboardStatusLines,
  buildSessionSurfaceStatusLines,
  consumeSessionQuickControl,
  createSessionPostureState,
  enterSessionControlMode,
  exitSessionControlMode,
  isSessionControlActive,
  parseSessionControlSlash,
  parseSessionSurfaceSlash,
  resolveSessionInputModeFromChatMode,
  resolveSessionModeSnapshot,
  resolveSessionSurfaceStatus,
  setSessionPreferredSurface,
  toggleSessionControlMode,
  type SearchPlannerState,
} from '../session-runtime/index.js';
import {
  initDashboardApprovers,
  createInjectApprover,
  createConfigSetApprover,
  createAcpPermissionApprover,
  openGenericApproval,
} from './runtime/approvers.js';
import {
  bootDashboardAcpSession,
  deriveDaemonHttpBase,
  fetchDaemonSessionHistory,
  fetchDaemonSessionList,
} from './acp-boot.js';
import { renderReplayPreviewLines } from './replay-preview.js';
import {
  buildDashboardTurnPreamble,
} from './turn-preamble.js';
import type { DashboardSession } from '../tui-client/dashboard-session.js';
import type { SessionTurnProfile } from '../session-runtime/index.js';
import { createCompanionSurfaceHostRegistry } from './companion-surface-host-registry.js';
import { companionSurfaceId } from './companion-surface-address.js';
import type { DashboardCompanionSurfaceKey } from './compact-surface-dispatch.js';
import { createDashboardCompactSurfaceAssembly } from './compact-surface-assembly.js';
import { openCompactSurfaceCatalogPopup } from './compact-surface-popup.js';
import { approvalModalRouter, type ApprovalModalRouter } from '../approval-modal.js';
import { routeApprovalModalKey } from './input/approval-key-router.js';

export function routeStreamingApprovalModalKey(
  key: Parameters<typeof routeApprovalModalKey>[0],
  router: ApprovalModalRouter = approvalModalRouter,
): boolean {
  if (router.current() === null) return false;
  try {
    routeApprovalModalKey(key, router);
  } catch {
    // An active modal remains the exclusive owner even if its handler fails.
  }
  return true;
}
import {
  attachSurfaceToWorkspace,
  DASHBOARD_MAIN_WORKSPACE_ID,
} from '../display/workspace-affinity.js';
import { initDashboardHitl, stopDashboardHitl } from './runtime/hitl.js';
import { openDashboardShellRollupPopup } from './shell-rollup-popup.js';
import { expandPromptReferences } from '../prompt/references.js';
import { spawnCodingAgent, CodingAgentBinaryMissing } from '../terminal/coding-agent.js';
import type { TerminalSession } from '../terminal/session-registry.js';
import { createSessionPickerModal } from '../session/picker-modal.js';
import { listSessions as listChatSessionsForResume } from '../session/index.js';
// TUI 부활 S-b — 타임트래블 포크 엔진 (codex ForkSnapshot 동형 · 2026-07-09
// 이식 후 호출처 0 이던 방치 자산 회수). 순수 히스토리 절단 로직만 소비;
// 영속은 세션 스토어(forkSessionFromHistory)가 담당한다.
import { userMessagePositions, truncateBeforeNthUser } from '../acp/session-fork.js';
import { resolveEscEscRewind } from '../chat/esc-esc-rewind.js';
import { wirePersistence, loadPersistedSessions } from '../terminal/session-persistence.js';
import { renderMarkdown as renderMarkdownGlow } from '../markdown-preview.js';
import { basename, dirname } from 'path';
import { statSync } from 'fs';
import {
  FIGURES, applyColor, toolHeader, toolResult, toolBlock,
  renderTable, renderMarkdown, successLine, errorLine, warningLine,
  sectionHeader, progressIndicator, renderTaskStatus,
  type StatusColor, type TaskStatus,
} from '../render.js';
import type { SyncMode } from '../types.js';
import type { ChatMessage } from '../chat/index.js';
import type { PlainTurnSubmit } from '../input/turn-submit.js';
// U-4.2 · `renderLogPane` no longer called from dashboard directly —
// wd-log widget owns log rendering via renderLogViaWidget. Only
// `findBlock` still used here (chat-input block navigation).
import { findBlock } from '../panes/log-pane.js';
import { createQuitConfirmationState, gracefulQuit, type QuitConfirmationState } from './graceful-quit.js';
import { enqueuePendingUserInput } from '../session/pending-input.js';
import { createAttachmentRowMap } from '../log-pane/attachment-row-map.js';
import { createAttachmentPopup, type AttachmentPopupAction } from '../log-pane/attachment-popup.js';
import { findLogMatches, type LogSearchResult } from '../log-pane/search.js';
import { createLogSearchModal, type LogSearchModalOpts } from '../log-pane/search-modal.js';
// U-4.3 · direct imports of tryAttachmentHitAtBodyRow /
// tryHandleLogAreaClick are gone · wd-log.onMouse owns the hit-test.
// LogClickDispatchDeps type still needed for buildLogClickDeps +
// syncLogWidgetState (which injects the bag into wd-log state).
import type { LogClickDispatchDeps } from '../log-pane/click-dispatch.js';
import {
  type LogSurfaceStateContract,
} from '../widgets/contracts/log-surface.js';
import { fileColor, fileIcon, sizeStr, dirColor } from '../panes/file-icons.js';
import { canPreview } from '../panes/preview-pane.js';
import { colorLine } from '../panes/syntax-color.js';
import { createHud, setSegment, clearSegment } from '../panes/hud.js';
import {
  paneHeightBeforeTargetRow,
  paneHeightForTargetRows,
  previewPaneWidthFor,
} from '../panes/pane-sizing.js';
import {
  renderAgentActivitySegment,
  AGENT_ACTIVITY_SEGMENT_KEY,
  PULSE_HALF_PERIOD_MS,
} from '../agent-activity-hud.js';
import { DASHBOARD_CLARIFICATION_REQUEST, consumeStreamingTopModalEscape, createEscAbortGate, createHarnessEscHint, routeStreamingEscapeKey } from '../esc-abort-gate.js';
import { enqueueSoftStop, readSoftStopRequestStatus } from '../harness/control-inbox.js';
import { setSelfImplementSoftStopSpaceObserver } from '../self-implement/self-implement-runtime.js';
import { createViEditor, type ViEditorHandle } from '../vi-editor.js';
import { launchEditor, canLaunchEditor } from '../editor-launcher.js';
import { createSshPickerModal } from '../ssh/ssh-picker-modal.js';
import {
  refreshRemoteWorkingDir,
  refreshRemoteWorkingDirPreview,
  startRemoteMode,
  endRemoteMode,
  enterRemoteDirectory,
  remoteBadge,
} from '../ssh/remote-browser.js';
import { editRemoteFile } from '../ssh/remote-edit.js';
import { scanFinder, relativizeResults } from '../finder/finder-scan.js';
import { scanRemoteFinder, relativizeRemoteResults } from '../finder/finder-scan-remote.js';
import { createFinderModal, createFolderPickerModal, type FinderItem } from '../finder/finder-modal.js';
import { homedir, hostname } from 'node:os';
import { listTransferTargets, type TransferTarget } from '../transfer/transfer-targets.js';
import { createTransferPickerModal } from '../transfer/transfer-picker-modal.js';
import { sshTransfer, type SshTransferProgress } from '../transfer/ssh-transfer.js';
import { iphoneTransfer } from '../transfer/iphone-transfer.js';
import { DashboardAcpChat, displayBackendName, parseAcpSlash, type AcpBackendId } from './chat/acp-chat.js';
import { attachmentsToNormalized, type NormalizedAttachment } from '../acp/content-blocks.js';
import {
  initDashboardSlashExecutor,
  ALLOWED_SLASHES,
} from '../skills/tools/dashboard-slash.js';
import { executeImmediateDashboardSlash } from './input/slash-executor.js';
import {
  initDashboardConfigTools,
} from '../skills/tools/dashboard-config.js';
import {
  initDashboardWidgetTools,
  type WidgetInfo,
} from '../skills/tools/dashboard-widget.js';
import { initWidgetInspectorTools } from '../skills/tools/widget-inspector.js';
import {
  initDashboardViewTools,
} from '../skills/tools/dashboard-view.js';
import {
  findLiveSessionById,
  findLiveSessionByPaneId,
  listLiveEmbodiedSessions,
} from '../agent/spawn-embodied-agent-in-vw.js';
import { findSessionObserver } from '../agent/observer-registry.js';
import {
  conversationHoverHudLabel,
  conversationModalTitle,
  conversationModalWidgetId,
  findConversationSessionEntry,
} from '../conv-dash/conversation-widget-open.js';
import {
  applyConversationWidgetConfig,
  buildConversationWidgetConfig,
} from '../conv-dash/conversation-widget-model.js';
import {
  claudeChannelHook,
  codexChannelHook,
  defaultChannelRouter,
  geminiChannelHook,
  registerDefaultPatterns,
} from '../agent/channel-router.js';
import { initTtySnapshotTools } from '../skills/tools/tty-snapshot.js';
import { initAgentHandoffTool } from '../skills/tools/agent-handoff.js';
import { touchSshHost } from '../ssh/ssh-hosts.js';
import { DisplayCoordinator } from '../display/coordinator.js';
import {
  createLivePlaygroundHarness,
  createPlaygroundCommandHandler,
  DEFAULT_SCENARIOS,
  getDefaultScenarioRegistry,
  parseScenarioYaml,
  runScenario,
  serializeScenarioToYaml,
  type Scenario,
} from '../playground-scenario/index.js';
import {
  buildShowcaseEntries,
  buildPresetOptionEntries,
  buildScenarioLoadFeedback,
  buildScenarioPaletteEntries,
  buildScenarioRunFeedback,
  buildScenarioSaveFeedback,
  buildThemeOptionEntries,
  resolveEditableScenarioSource,
  type PlaygroundScenarioPaletteEntry,
  type PlaygroundPresetOptionEntry,
  type PlaygroundThemeOptionEntry,
} from '../playground/lab.js';
import { computeWorkingFocusSync } from '../display/working-focus-sync.js';
import { dispatchPaneClick } from '../display/pane-click-dispatch.js';
import { installResizeListener } from '../display/resize-listener.js';
import { isPtyForwardMouseEventType, type KeyEvent as DisplayKeyEvent } from '../display/types.js';
import { createDisplayEventBus } from '../display/events.js';
import { agentBatchScratchTitle, renderAgentBatchScratch } from '../display/agent-batch.js';
import { createExecutionSurface, type ExecutionSurfaceHandle } from '../display/index.js';
import { AgentSurfaceStore, renderAgentDetail, renderAgentRoster, type AgentSurfaceState } from '../display/agent-surface.js';
import { globalAgentFlash } from '../display/agent-flash.js';
import { renderDebugEventDetail, renderDebugEventRows, renderDebugStack, renderPromptInjectionDebug } from '../display/debug-surface.js';
import { buildDebugCallStack } from '../debug/call-stack.js';
import { buildAstGrepHostTool } from '../skills/tools/ast-grep.js';
import { buildLspHostTool } from '../skills/tools/lsp/index.js';
import { PluginHost } from '../plugins/core/host.js';
import { registerDashboardPaneHostTools } from './panes/host-tools.js';
import { DEFAULT_THEME_TOKENS, mergeThemeTokens, resolveThemeTokens, type ThemeTokenInput, type ThemeTokens } from '../theme/tokens.js';
import { resolveActiveTheme, setActivePresetInConfig } from './render/theme-resolver.js';
import { getTheme, listThemes } from '../themes/index.js';
import type { PaneFocus, PreviewSource, WorkingDirView } from '../workspace-types.js';
import type { DisplayMouseEvent } from '../display/types.js';
import type { Key as TuiKey } from '../tui.js';
import { nextSortMode } from '../workspace-types.js';
import {
  type BrowserPaneModel,
  createWorkingDirState,
  refreshWorkingDir,
  enterDirectory,
  toggleSelection,
  toggleSelectAll,
  attachTargets,
  focusedEntry,
  readDirEntries,
  sortEntries,
  splitAtPrefix,
  dirname as wdDirname,
  type WorkingDirState,
  type FsEntry,
} from '../working-dir/index.js';
import { BrowserPaneRegistry } from '../browser-pane/registry.js';
import {
  encodeBrowserScopedSubmitText,
  resolveBrowserActionContextFromHit,
} from '../browser-pane/actions.js';
import { resolveBrowserTransferCapability } from '../browser-pane/capabilities.js';
import { openBrowserPaneModal } from '../browser-pane/mount.js';
import { openPreviewPaneModal } from '../preview-pane/mount.js';
import {
  cyclePreviewSourceForView,
  formatPreviewSourceLabel,
  normalizePreviewSourceForView,
  resolveEffectivePreviewBrowser,
  resolvePreviewBindingMode,
  setPreviewBindingMode,
  setPreviewSourceForView,
  shouldAutoRefreshPreview,
} from '../preview-pane/model.js';
import { PreviewPaneRegistry } from '../preview-pane/registry.js';
import { FileIndexCache, absolutize } from '../file-index.js';
import { firstPaneOfView, paneSetForView } from '../working-dir/focus.js';
import { applyVisibleFocusRepair } from './focus-repair.js';
import {
  nextVisiblePaneFocus,
  repairFocusForVisiblePanes,
  visiblePanesForView,
  compactLevelForViewport,
  type PaneViewport,
} from '../views/pane-policy.js';
import {
  autoTabletModeForViewport,
  orderDashboardViewsForCompactMode,
  effectiveChatOnlyModeForViewport,
  orderSurfaceCatalogForCompactMode,
  pruneDashboardViewsForCompactMode,
  pruneSurfaceCatalogForCompactMode,
  productCompactModeForViewport,
} from '../views/product-compact-mode.js';
import { readScopedRenderLogs, resolveRenderSuppressed, readScopedDebugLevel, resolveStartupDebugLevel, hotPathGateOpen } from '../mss/logging/scoped-level.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { createPushLog } from '../push-log.js';
import {
  buildDashboardViewRegistry,
  compileDashboardViewLayout,
  describeDashboardViewsForPrompt,
  findDashboardView,
  nextDashboardView,
  panesForDashboardView,
  serializeDashboardViewsConfig,
  validateDashboardViewsConfig,
  type DashboardViewDef,
  type DashboardViewRegistry,
  type RawDashboardViewsConfig,
  resolveDashboardViewAfterReload,
} from '../views/config.js';
import {
  createObsidianDirState,
  refreshObsidianDir,
  enterObsidianDirectory,
  obsidianToggleSelection,
  obsidianToggleSelectAll,
  obsidianAttachTargets,
  obsidianFocusedEntry,
  type ObsidianDirState,
} from '../obsidian-dir.js';
import { createChord, armChord, disarmChord, isChordArmed, type ChordState } from '../chord.js';
import {
  createSkillViewState,
  refreshSkills,
  refreshSkillFiles,
  skillToggleSelection,
  skillToggleSelectAll,
  skillAttachTargets,
  skillFocusedFile,
  skillFocusedSkill,
  type SkillViewState,
} from '../skills/view.js';

// Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — scheduler view
// imports retired. dashboard 의 scheduler view (lane widgets · board ·
// inspector · form · scratch) 전체 폐기. 사용자 facing scheduler 단어
// dashboard 에서 모두 제거.

export type DashboardAction = 'quit';

// ── Focus state ──
// `focus` is the outer-level pane tracker used by the plugin host (as
// a PaneSlot fallback) and the sync plugin's mouse handlers. The
// working-dir workspace uses its own `workingDir.focus` — this one
// stays on 'input' in normal operation and only shifts while a plugin
// is active.
type Pane = 'input' | 'skills' | 'files' | 'preview' | 'log';

// File-icon / syntax-color / preview helpers moved to panes/*.ts

// SYNC_MODES + SyncPane moved to plugins/sync/types.ts
import { SYNC_MODES, type SyncPane } from '../../plugins/sync/types.js';
import { WidgetHost } from '../widgets/host.js';
import { createPaneKeyRouter, dispatchKeyToWidget } from '../widget-routing/index.js';
import playgroundWidget, { type PlaygroundWidgetState } from '../playground/widget.js';
import { setWidgetHostForCatalog } from '../playground/catalog.js';
import sessionsSidebarWidget from '../session/sidebar-widget.js';
import type { SessionsSidebarState } from '../session/sidebar-widget.js';
import { listSessionCards } from '../session/card.js';
// AXON P6.3 — dual-role manager hands the sidebar a flattened view of
// every registered ACP session (client + server). The helper lives
// on the manager singleton so production code shares one registry
// instance across the dispatcher, the sidebar, and LLM tools.
import { globalDualRoleManager, setAcpHopCapResolver } from '../acp/dual-role-manager.js';
// PR-S1V.4-wiring (sprint 21-Parallel-Voice · 2026-04-29) — voice input.
// Boot the STTProvider lazily (gated on OPENAI_API_KEY) and wire the
// voice-input host into the priority key route + status bar. PLAN
// canonical: PLAN-voice-wiring-s1v4w-2026-04-29.md.
import { globalAcpEventRouter } from '../acp/event-router.js';
import { createSTTProvider } from '../voice/stt-provider.js';
import {
  createVoiceInputHost,
  type VoiceInputHost,
} from './voice-input-host.js';
import {
  createSpaceLongPressDetector,
  isDictationHoldKey,
  isPlainSpaceHoldKey,
  type SpaceLongPressDetector,
} from './input/space-longpress-detector.js';
import { isAllowlistedDictationSurface } from './input/dictation-surface-allowlist.js';
// H3 #6 follow-up #3 — background sessions render as a distinct sidebar
// kind with live state badge + tap-to-Join. Dashboard pulls BG records
// through backgroundToStub + maps state via bgStateToSessionStatus,
// and subscribes to onStateChange for live redraws.
import {
  backgroundToStub,
  bgStateToSessionStatus,
  globalBackgroundManager,
  TERMINAL_BACKGROUND_STATES,
  withBgApprovalSignals,
} from '../acp/background-manager.js';
import { dispatchAcpSessionJoin } from '../skills/tools/acp-session.js';
import {
  listDashboardSimulationScenarios,
  runDashboardSimulationScenario,
} from './sim-shell-runtime.js';
import { preservesHostChromeInput } from '../display/host-chrome-profile.js';
// H3 #6 follow-up #1 — auto-persist on turn-end. Subscribes DRM +
// BG managers to the H2 #5 persistence primitive so
// `AcpSessionList` returns real records instead of empty arrays.
// Mode is always 'auto' (the ELANOUS_ACP_PERSIST_MODE off-switch was graduated 2026-09-26).
import { wireAutoPersist } from '../acp/auto-persist.js';
import { globalAcpSessionPersistence } from '../acp/session-persistence.js';
import { AgentStatusStore } from '../agent-status/store.js';
import { createConversationWidgetLiveBridge } from '../conv-dash/conversation-widget-live.js';
import { createClaudeCodeParser } from '../agent-status/claude-code.js';
import { createCodexParser } from '../agent-status/codex.js';
import { BlockStore } from '../block/store.js';
import { BlockAttachState } from '../block/attach.js';
import { NotificationStore } from '../notifications/store.js';
import { createPersistence } from '../notifications/persistence.js';
import {
  attentionToNotification,
  blockToNotification,
  exitToNotification,
  oscToNotification,
  statusToNotification,
} from '../notifications/adapters.js';
import bellModalWidget, {
  rebuildBellEvents,
  type BellModalState,
  type NotificationFilter,
} from '../notifications/bell-modal.js';
import { createLayout } from '../layout/host.js';
import { renderLayout, renderModalOverlay, hitTestLayoutCell } from '../layout/render.js';
import { createLayoutTools } from '../layout/tools.js';
import { routeLayoutModalKey } from '../layout/modal-router.js';
import type { Layout, ModalPlacement } from '../layout/types.js';
import type { WidgetInstance } from '../widgets/types.js';
import type { ListWidgetState } from '../../widgets/list/widget.js';
import type { SyncPluginState } from '../../plugins/sync/plugin.js';
import { SYNC_WIDGET_IDS } from '../../plugins/sync/plugin.js';
import { getGlobalAcpHandle } from '../web-terminal/handle-singleton.js';
import { registerPreviewTerminalForWebTap } from '../web-terminal/preview-tap-registry.js';

// B2 transitional: `syncing` is retained in the union only so
// existing control-flow-narrowing holds during the split refactor.
// The runtime only ever assigns `browse` or `sync` now — long-running
// input blocking moved to the plugin's busy flag. Step F1 deletes this
// union entirely.
// Mode is derived, not stored. `pluginHost.isActive('sync')` replaces
// the former DashboardMode enum — any new plugin is its own mode now.
const isSyncMode = (host: { isActive(n: string): boolean }): boolean => host.isActive('sync');
const isBrowseMode = (host: { active(): unknown | null; activeLayout?: () => unknown | null }): boolean =>
  host.active() === null || host.activeLayout?.() === null;

// isBusy — ask the active plugin whether it's in a long-running op. The
// former `mode === 'syncing'` check queried a dashboard-scoped global;
// this queries the plugin's own state so long-running lifetime is owned
// by whoever actually runs the work.
const isPluginBusy = (host: { active(): { plugin: { isBusy?: (s: any) => boolean }; state: any } | null }): boolean => {
  const a = host.active();
  return !!a?.plugin.isBusy?.(a.state);
};

// ── Main dashboard ──

export interface ShowDashboardOptions {
  /** Force debug sinks on at launch (file + mirror). Equivalent to
   *  typing `/debug on` immediately after startup. Paired with
   *  chatOnly=true by the `elanous --debug` CLI flag so every traced
   *  event shows up in a visible log pane on narrow screens/tablets. */
  debug?: boolean;
  /** Start in chat-only layout (log pane fills everything above the
   *  input). Useful on tablets where the 3-pane grid is too narrow
   *  to read. Toggle at runtime with /chat or the chord in the HUD. */
  chatOnly?: boolean;
  /** Flip code-edit policy to unsupervised at boot — every Edit/Write
   *  from the LLM applies without an approval modal. Equivalent to
   *  typing `/code-edit policy unsupervised` right after launch.
   *  Wired by `elanous --yolo`. */
  yolo?: boolean;
  /** Benchmark-friendly boot. Starts straight in chat layout, keeps
   *  focus in the input row, and pairs naturally with per-turn Q&A
   *  clipboard mirroring when the config enables it. */
  benchmark?: boolean;
  /** M2.4 — remote daemon target. When set, the dashboard's ACP
   *  session attaches to a remote daemon over WebSocket instead of
   *  booting an in-process server. Driven by `ELANOUS_REMOTE` env var
   *  (resolved in `main()`). Tool dispatch + history live on the
   *  daemon side; the local TUI is a thin client. */
  remote?: { url: string; token?: string; label?: string };
  /** Tier 1 daemon-resume — when set together with `remote`,
   *  the dashboard attaches to this existing
   *  daemon-side sessionId instead of minting a new one. The boot
   *  also fetches the session's prior turns via REST (when an HTTP
   *  endpoint is reachable, derived from `remote.url`) and replays
   *  them into `chat.history` so the user sees their conversation
   *  resume. Driven by `--resume <id>` CLI flag or
   *  `ELANOUS_RESUME_SESSION` env (resolved in `main()`). Has no
   *  effect in in-process mode (use TUI's `/session load` for that
   *  path). */
  resumeSessionId?: string;
}

// FileIndex cache keyed by absolute cwd. A single elanous session can
// switch cwd via `/wd` or session-working-dir — each distinct root
// gets its own snapshot so paths stay relative to the active root
// without tearing down on every swap. Lives at module scope so
// re-entering showDashboard() (e.g. after a nested prompt) keeps the
// warm cache and the 5s floor + git-index mtime watch still work.
const fileIndexByCwd = new Map<string, FileIndexCache>();
function getFileIndexCache(cwd: string): FileIndexCache {
  let cache = fileIndexByCwd.get(cwd);
  if (!cache) {
    cache = new FileIndexCache({ cwd });
    fileIndexByCwd.set(cwd, cache);
  }
  return cache;
}

// Phase B-1.a · Slash command registry (declarative; no closure state).
// Handlers receive a DashboardSlashContext built per-call inside
// showDashboard so live closure refs (chatLines, attachmentRowMap, …)
// thread through without the registry capturing them. Cases migrate
// out of the inline switch one by one — see AUDIT-dashboard-phase-b-
// 2026-05-04 §8 for the planned tiering.
const dashboardSlashRegistry = buildDashboardSlashRegistry();

/** Existing TUI question channels become slash-authoring capability only when present. */
export function resolveDashboardSlashSurfaceUx(
  questionChannels: readonly QuestionChannel[] = getDefaultQuestionChannels(),
): Pick<SurfaceUx, 'question'> | undefined {
  return questionChannels.length > 0
    ? resolveSurfaceUx({ surface: 'tui', surfaceQuestionChannels: [...questionChannels] })
    : undefined;
}

/** Dashboard draw entry for the input-prompt zone. Streaming redraws reach
 * this production binding through the zone renderer below. */
export function drawDashboardTurnTypeaheadPromptRows(
  input: TurnTypeaheadPromptRowsInput,
  sink?: TurnTypeaheadPromptPaintSink,
): string[] {
  return drawTurnTypeaheadPromptRows(input, sink);
}

/** Essential frames own the fallback prompt caret; Z-axis state only wins
 * when a modal has made a visible claim. */
export function buildDashboardTurnTypeaheadPromptZone(input: TurnTypeaheadPromptRowsInput & {
  suppressPromptArea: boolean;
}): LayoutZone {
  return {
    id: 'input-prompt',
    height: input.frame.inputHeight,
    render: (height, width) => {
      if (input.suppressPromptArea) return Array.from({ length: height }, () => ' '.repeat(width));
      return drawDashboardTurnTypeaheadPromptRows({ ...input, height, width });
    },
  };
}

/** 프롬프트 zone 에 관측만 덧입힌다 — 렌더 산출은 `inner` 가 소유한다.
 *
 *  ⭐ **왜 뽑았나**(무인 리뷰 must-fix · 2026-08-01): 종전엔 이 래퍼가 `zones.push({...})` 안에
 *  인라인이라, 테스트가 `inner`(=`buildDashboardTurnTypeaheadPromptZone`)만 불러도 통과했다.
 *  ⇒ ***래퍼가 `inner.render` 를 부르는 것을 끊어도 검사가 침묵***했다. 이제 그 결선이 검사된다.
 *
 *  ⛔⚠️ **여전히 검사 밖인 한 겹**: 이 함수의 반환이 실제로 `zones` 배열에 **push 되는지**는
 *  `showDashboard` 안의 지역 조립부라 단위 검사가 닿지 않는다. ***무한 후퇴이므로 여기서 경계를 긋는다*** —
 *  그 한 겹은 **라이브 검증**(`dev --elanous --hold` ⊕ `pty snapshot`)이 맡는다. */
export function observeDashboardTurnTypeaheadPromptZone(
  inner: LayoutZone,
  deps: {
    promptBottomRow: number;
    state: { buffer: string; queuedSubmissions: string[] };
    isDebugEnabled?: () => boolean;
    log?: (category: string, event: string, data: Record<string, unknown>) => void;
  },
): LayoutZone {
  return {
    ...inner,
    render: (height, width) => {
      const rows = inner.render(height, width);
      const enabled = deps.isDebugEnabled ? deps.isDebugEnabled() : debug.enabled;
      if (deps.state.buffer && enabled) {
        (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('dashboard.turn-typeahead-prompt', 'dashboard-draw-prompt', {
          row: deps.promptBottomRow,
          text: rows.at(-1) ?? '',
          bufferLength: deps.state.buffer.length,
          queuedSubmissionCount: deps.state.queuedSubmissions.length,
        });
      }
      return rows;
    },
  };
}

type DashboardFrameRenderer = (lines: string[], options: RenderOptions) => void;

/** Compose coordinator-owned modal surfaces into the dashboard's single frame overlay. */
export function renderDashboardCoordinatorModalOverlay(display: Pick<DisplayCoordinator, 'snapshot'>): string {
  const snapshot = display.snapshot();
  return renderModalStack({
    surfaces: snapshot.surfaces,
    focusStack: snapshot.focus.stack,
  });
}

/** 대시보드 draw 경로의 **단일 프레임 flush**. 커서는 행 캐시 밖에 있고 같은 write 안에서
 *  모든 overlay 뒤에 온다.
 *
 *  ⭐⭐⭐ **essential 은 커서 값을 Z축에 묻지 않는다**(2026-08-02 · RFC essential-z-axis-off).
 *  입력 루프가 끝나면 `setCursor(null)` 로 소유가 비므로 물어보면 빈손이고, 그래서 턴이 도는
 *  동안 커서가 사라졌다(라이브 14 표본 전부 `visible false`). ⇒ 모달이 **실제로 claim** 했으면
 *  그 값을 쓰고, 아니면 **프롬프트 caret** 을 쓴다. 프롬프트가 감춰졌으면 숨긴다. */
export interface DashboardFrameInput {
  overlay: string;
  force: boolean;
  /** ⭐ Z축이 **실제로 누구에게** 커서를 준 결정. essential 은 `modal`·`terminal` 일 때만
   *  그 값에 양보한다 — `coordinator` fallback 은 소유자가 없다는 뜻이지 claim 이 아니다. */
  cursorOwner: CursorDecision['owner'];
  claimedCursor: CursorState | null;
  /** essential 결정이 커서를 안 낼 때(null)의 폴백 — 조율자가 emit 하던 값(종전 동작 보존). */
  coordinatorCursor?: CursorState | null;
  promptCaret: CursorState | null;
  suppressPromptArea: boolean;
  onEssentialFrameCursorDecision?: (observation: EssentialFrameCursorObservation) => void;
}

export interface EssentialFrameCursorObservation {
  caret: CursorState | null;
  cursorOwner: CursorDecision['owner'];
  reason: EssentialFrameCursorDecision['reason'];
  source: EssentialFrameCursorDecision['source'];
  suppressPromptArea: boolean;
}

export interface DashboardEssentialCursorObserverDeps {
  isDebugEnabled: () => boolean;
  log: (category: string, event: string, data: EssentialFrameCursorObservation) => void;
}

export function createDashboardEssentialCursorObserver(deps: DashboardEssentialCursorObserverDeps): (
  observation: EssentialFrameCursorObservation,
) => void {
  let lastKey = '';
  return (observation) => {
    if (!deps.isDebugEnabled()) return;
    const key = JSON.stringify(observation);
    if (key === lastKey) return;
    lastKey = key;
    try {
      deps.log('cursor.final-decision', 'resolved', observation);
    } catch { /* cursor observation must not affect frame rendering */ }
  };
}

export function renderDashboardFrame(
  lines: string[],
  input: DashboardFrameInput,
  renderFrame: DashboardFrameRenderer = render,
): void {
  const cursorDecisionExists = input.cursorOwner !== 'none';
  const essentialDecision = resolveEssentialFrameCursorDecision({
    claimedCursor: cursorDecisionExists ? input.claimedCursor : null,
    promptCaret: input.promptCaret,
    suppressPromptArea: input.suppressPromptArea,
  });
  renderFrame(lines, {
    overlay: input.overlay,
    force: input.force,
    cursor: paintCursor(essentialDecision.cursor ?? input.coordinatorCursor ?? null),
  });
  input.onEssentialFrameCursorDecision?.({
    caret: essentialDecision.cursor,
    cursorOwner: input.cursorOwner,
    reason: essentialDecision.reason,
    source: essentialDecision.source,
    suppressPromptArea: input.suppressPromptArea,
  });
}

/** Production frame input: append coordinator modals after every dashboard-owned overlay. */
export function composeDashboardFrameWithCoordinatorModal(
  display: Pick<DisplayCoordinator, 'snapshot'>,
  input: DashboardFrameInput,
): DashboardFrameInput {
  return {
    ...input,
    overlay: input.overlay + renderDashboardCoordinatorModalOverlay(display),
  };
}

export interface DashboardChildScreenListDeps {
  manifestTargets(opts: { includeTest?: boolean }): readonly { dbPath: string }[];
  listManifestRowsAt(dbPath: string): readonly { id: string; kind: string; runId: string; alive: boolean }[];
}

export function listDashboardChildScreens(deps: DashboardChildScreenListDeps = {
  manifestTargets: ptyManifestTargets,
  listManifestRowsAt: listPtyManifestRowsAt,
}): readonly { id: string; kind: string; runId: string; alive: boolean; manifestDbPath: string }[] {
  return deps.manifestTargets({ includeTest: true }).flatMap((target) => {
    try {
      return deps.listManifestRowsAt(target.dbPath).map((row) => ({
        id: row.id,
        kind: row.kind,
        runId: row.runId,
        alive: row.alive,
        manifestDbPath: target.dbPath,
      }));
    } catch {
      return [];
    }
  });
}

/**
 * ⭐⭐⭐ 종료의 «한 자리» (2026-08-19 · 대표 지시 · 로드맵 `N1`).
 *
 * 📏 실측: 나가는 길이 ***일곱***이었고 하는 일이 제각각이었다 —
 *   자식 정리는 «어디에도 없었고», `Ctrl+C`·`SIGINT` 는 세션 안내조차 못 받았다.
 * ⛔ 그리고 종전 안내 문면 `resume with /session load <id>` 는 ***TUI «안» 명령***이라
 *   그 줄을 읽는 사람(그때 셸에 있다)이 «칠 수 없는» 명령이었다.
 * ⇒ 🎯 이제 이 함수는 `gracefulQuit` 에 위임한다: 자식 정리 → closeTui → «셸에서 칠 수 있는» 안내.
 */
export function closeDashboardForExit(deps: {
  closeTui: () => void;
  getSessionId?: () => string | undefined;
  write?: (message: string) => unknown;
  /** 종료 경로가 소유하는 반복 확인 상태. */
  confirmationState?: QuitConfirmationState;
  /** 비상 경로면 확인을 건너뛴다. */
  forceQuit?: boolean;
  /** 나가도 계속 도는(=알려야 할) 하니스 자식 수. 미주입이면 0. */
  harnessChildren?: number;
}): void {
  gracefulQuit({
    closeTui: deps.closeTui,
    // ⚠️ `getAmbientSessionId` 는 `null` 을 낼 수 있다 — `undefined` 로 맞춘다(계약 정합).
    getSessionId: deps.getSessionId ?? ((): string | undefined => getAmbientSessionId() ?? undefined),
    ...(deps.write ? { write: deps.write } : {}),
    ...(deps.confirmationState ? { confirmationState: deps.confirmationState } : {}),
    ...(deps.forceQuit ? { forceQuit: true } : {}),
    ...(deps.harnessChildren !== undefined ? { harnessChildren: deps.harnessChildren } : {}),
  });
}

type LogZoneClickOutcome = 'consumed' | 'passthrough' | 'out-of-zone';

interface LogZoneClickMouse {
  row: number;
  col: number;
  type: string;
}

export interface LogZoneClickWidgetHost {
  defFor(id: string): {
    onMouse?: (
      ev: {
        type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release';
        row: number;
        col: number;
      },
      state: never,
      ctx: never,
    ) => unknown;
  } | null;
  get(id: string): { state: unknown } | null;
  buildContext(id: string): unknown;
}

interface LogZoneClickDispatchDeps {
  logZoneStart: number | null;
  logZoneHeight: number | null;
  widgetHost: LogZoneClickWidgetHost;
}

/** Same log-zone click dispatcher the dashboard nested closure runs.
 *  Exported so tests can invoke the live branch+LogStore path without
 *  booting `showDashboard`. */
export function dispatchLogZoneClick(
  m: LogZoneClickMouse,
  deps: LogZoneClickDispatchDeps,
): LogZoneClickOutcome {
  const { logZoneStart, logZoneHeight, widgetHost } = deps;
  // Unconditional reach records. Category `log.mouse`.
  // Distinct events: zone-unresolved · out-of-zone ·
  // missing-widget-definition · missing-widget-instance ·
  // context-build-failed · handler-threw · handler-invoked.
  // Not gated on `debug.enabled` — a silent gate would look like
  // "did not happen". Coordinate/index detail may sit behind the
  // gate; arrival itself must always remain.
  // `buildContext` is evaluated before `handler-invoked`: argument
  // evaluation is not a handler call, so a context throw must not
  // look like the widget handler ran.
  if (logZoneStart === null || logZoneHeight === null) {
    debug.log('log.mouse', 'zone-unresolved', {
      logZoneStart,
      logZoneHeight,
    });
    return 'out-of-zone';
  }
  if (m.row < logZoneStart || m.row >= logZoneStart + logZoneHeight) {
    debug.log('log.mouse', 'out-of-zone', {
      row: m.row,
      logZoneStart,
      logZoneHeight,
      rangeEnd: logZoneStart + logZoneHeight,
    });
    return 'out-of-zone';
  }
  const localRow = m.row - logZoneStart;
  const localCol = m.col;
  const def = widgetHost.defFor('wd-log');
  const inst = widgetHost.get('wd-log');
  if (!def?.onMouse || !inst) {
    // Same early-return as before. Distinct events so definition
    // absence is never collapsed into instance absence — including
    // the both-missing case, which records both (definition first).
    if (!def?.onMouse) {
      debug.log('log.mouse', 'missing-widget-definition', {
        hasDefinition: Boolean(def),
        hasOnMouse: false,
        hasInstance: Boolean(inst),
      });
    }
    if (!inst) {
      debug.log('log.mouse', 'missing-widget-instance', {
        hasDefinition: Boolean(def),
        hasOnMouse: Boolean(def?.onMouse),
        hasInstance: false,
      });
    }
    return 'passthrough';
  }
  let ctx: unknown;
  try {
    ctx = widgetHost.buildContext('wd-log');
  } catch (err) {
    debug.log('log.mouse', 'context-build-failed', {
      error: err instanceof Error ? err.message : String(err),
      localRow,
      localCol,
      row: m.row,
    });
    return 'passthrough';
  }
  try {
    debug.log('log.mouse', 'handler-invoked', {
      localRow,
      localCol,
      row: m.row,
    });
    def.onMouse(
      { type: m.type as 'click' | 'double-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release', row: localRow, col: localCol },
      inst.state as never,
      ctx as never,
    );
  } catch (err) {
    debug.log('log.mouse', 'handler-threw', {
      error: err instanceof Error ? err.message : String(err),
      localRow,
      localCol,
      row: m.row,
    });
    return 'passthrough';
  }
  return 'consumed';
}

const runLogZoneClickDispatch = dispatchLogZoneClick;

export async function dispatchDashboardAdSlash(
  runtime: DashboardAdSlashRuntime,
  args: string[],
  afterRun: () => void,
): Promise<void> {
  await runtime.run(args);
  afterRun();
}

export function createDashboardLogSearchOpener(deps: {
  display: () => DisplayCoordinator;
  linesGetter: LogSearchModalOpts['linesGetter'];
  initialQuery: () => string;
  termSize: () => { cols: number; rows: number };
  computePaneH: (rows: number) => number;
  currentThemeTokens: () => ThemeTokens;
  currentWorkspaceOwnerId: () => string;
  draw: () => void;
  onJump: LogSearchModalOpts['onJump'];
  onCancel: NonNullable<LogSearchModalOpts['onCancel']>;
}): () => void {
  return () => {
    let modalHandle: { dispose(): void } | null = null;
    const closeLogSearchModal = (): void => { modalHandle?.dispose(); modalHandle = null; };
    const { cols: tc, rows: tr } = deps.termSize();
    const anchorRow = Math.max(1, deps.computePaneH(tr) + 2);
    const anchorCol = Math.max(2, Math.floor(tc / 4));
    const popup = createLogSearchModal({
      linesGetter: deps.linesGetter,
      initialQuery: deps.initialQuery(),
      termCols: tc,
      termRows: tr,
      anchorRow,
      anchorCol,
      theme: deps.currentThemeTokens(),
      onJump: (result, query) => {
        closeLogSearchModal();
        deps.onJump(result, query);
      },
      onCancel: query => {
        closeLogSearchModal();
        deps.onCancel(query);
      },
    });
    attachSurfaceToWorkspace(popup.surface, deps.currentWorkspaceOwnerId());
    modalHandle = deps.display().pushModal(popup.surface);
    deps.draw();
  };
}

export function renderDashboardFirstScreenBand(input: {
  readonly history: ReadonlyArray<{ role: string }>;
  readonly lines: string[];
  readonly width: number;
  readonly draw: () => void;
  readonly observe: (data: { daemon: boolean; hasPwa: boolean; hasTailnet: boolean }) => void;
  readonly show?: () => Promise<Pick<NexusShowResult, 'status' | 'urls'>>;
}): Promise<void> {
  if (input.history.some((message) => message.role !== 'system')) return Promise.resolve();
  const band = buildFirstScreenBand({ width: input.width, daemon: false });
  input.lines.unshift(...band);
  const show = input.show ?? (() => runNexusShow({ format: 'json', out: { log: () => {}, error: () => {} } }));
  const observe = (data: { daemon: boolean; hasPwa: boolean; hasTailnet: boolean }): void => {
    try { input.observe(data); } catch { /* observation cannot interrupt the transcript */ }
  };
  return Promise.resolve().then(show).then((result) => {
    const daemon = result.status !== 'absent';
    const pwa = result.urls?.pwa;
    const hasPwa = !!pwa;
    const hasTailnet = !!pwa?.tailnet;
    observe({ daemon, hasPwa, hasTailnet });
    if (input.lines[1] !== band[1]) return;
    input.lines[1] = buildFirstScreenBand({ width: input.width, daemon, pwa })[1]!;
    try { input.draw(); } catch { /* screen may have closed */ }
  }).catch(() => {
    observe({ daemon: false, hasPwa: false, hasTailnet: false });
  });
}

export async function showDashboard(opts: ShowDashboardOptions = {}): Promise<DashboardAction> {
  await awaitGlobalPersonaLoad().catch(() => {});
  const dashboardQuitConfirmationState = createQuitConfirmationState();
  const signalQuitConfirmationState = createQuitConfirmationState();
  let disposeDashboardEventLoopMonitor = (): void => {};
  const closeDashboardTui = (): void => {
    disposeDashboardEventLoopMonitor();
    closeTui();
  };
  const exitDashboardTui = (): void => {
    closeDashboardForExit({ closeTui: closeDashboardTui, confirmationState: dashboardQuitConfirmationState });
  };
  // ⭐⭐⭐ `N1` — 신호 경로(`SIGINT`/`SIGTERM`)와 저수준 `Ctrl+C` 도 같은 종료를 타게 «등록»한다.
  //   ⛔ 종전엔 그 둘만 세션 안내를 «못 받았다»(일곱 경로 중 다섯만 받았다).
  //   ⚠️ 그 경로에서는 `cleanup()` 이 이미 화면을 복원하므로 `closeTui` 를 «다시» 부르지 않는다.
  setExitNotice(() => {
    closeDashboardForExit({
      closeTui: () => { /* 신호 경로: cleanup() 이 이미 복원했다 */ },
      confirmationState: signalQuitConfirmationState,
      forceQuit: true,
    });
  });
  // E3 (§7.4 TS baseline reduction · 2026-05-17) — forward declarations
  // for handler functions that get assigned later via destructure from
  // createDashboardCopyRuntime / createDashboardMediaRuntime (lines
  // ~14124-14146). Earlier callsites at L3000 / L5789 / L5793 / L5797
  // live inside arrow-function callbacks that fire only after the
  // assignment lands; TS static lookup can't see that runtime ordering
  // and was emitting TS2304. Forward-typed `let` declarations make the
  // binding lookup succeed without changing runtime semantics.
  let openLastAssistantMediaPreview: () => Promise<void> = async () => {};
  let copyLastAssistantTurnToClipboard: () => Promise<void> = async () => {};
  let copyLastAssistantCodeToClipboard: () => Promise<void> = async () => {};
  // E3 — activeWidgetPopupHandles tracks transient widget popup
  // lifecycles (plan board · background tasks · etc) so the cleanup
  // hooks at L13382/13389 and the open/close pair at L17639/17641 can
  // address them by modal-type key. Was referenced 4× but never
  // declared; pre-existing runtime relied on global ambient state.
  const activeWidgetPopupHandles = new Map<string, { dispose: () => void }>();
  // Chalk colour-level adaptation for VS Code / tmux / iTerm2 edge
  // cases. Must run before any chalk-based render so the first frame
  // already reflects the adjusted level. Idempotent; see
  // src/panes/chalk-level-adapt.ts for rationale.
  try { applyChalkLevelAdapt(); } catch { /* never break boot */ }

  // P2-3 — seed the input-core action registry with the reserved
  // placeholders. Idempotent: re-entering showDashboard (test path,
  // --no-exit scenarios) bails out on the internal flag.
  bootstrapInputCore();

  // VW-term-infra W1 wiring — eager-init the Pane substrate factory so
  // Capture arc / widget-inspector / LLM tool dispatchers that call
  // getDefaultPaneFactory() observe a shared session-scoped singleton.
  // Additive; no existing render path changes. See pane-substrate-boot.ts.
  // B1 (Phase 7) — overlay the user-config binding layer from
  // ~/.elanous/input-bindings.json + watch for changes so edits apply
  // without restart. Missing file is a no-op; validation violations
  // (reserved keys / malformed entries) are reported to the chat log
  // so the user has a pointer to their mistake. Dashboard lifecycle
  // handles dispose on teardown via process exit — no explicit
  // cleanup path yet because showDashboard runs for the whole CLI
  // session.
  {
    const bindingBoot = bootDashboardInputCore({
      initPaneSubstrate,
      registerCaptureRuntimes,
      wireAutoModeContextBridge,
      wireAndonContextBridge,
      wireBudgetContextBridge,
      wirePlanModeContextBridge,
      wireInputModeContextBridge,
      initInputCoreUserBindings,
      // E2 / TS18046 (2026-05-17) — `ev: unknown` in the upstream
      // callback signature (input-core-boot.ts) forces every access
      // below to error. The actual runtime shape is a discriminated
      // union, but typing it here would require importing the
      // private InputBindingsEvent type from input-core. `any` cast
      // matches the historical behavior (these accesses were
      // working at runtime before TS strict came up; the union
      // refactor is a separate arc).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      report: (ev: any) => {
        if (ev.kind === 'loaded' || ev.kind === 'reloaded') {
          const { loaded, skipped, conflicts, settings } = ev.report;
          const anythingInteresting =
            loaded > 0 || skipped.length > 0 || conflicts.length > 0
            || Object.keys(settings.applied).length > 0
            || settings.rejected.length > 0;
          if (anythingInteresting) {
            const conflictSummary = conflicts.length > 0
              ? ` (${conflicts.length} override default)` : '';
            chatLines.push(C.muted(
              `  [input-bindings] ${ev.kind} — ${loaded} applied, ${skipped.length} skipped${conflictSummary}`,
            ));
            for (const s of skipped) {
              chatLines.push(C.warning(
                `    ✗ ${String((s.entry as { matcher?: string }).matcher) ?? '?'} → `
                + `${String((s.entry as { actionId?: string }).actionId) ?? '?'}: ${s.reason}`,
              ));
            }
            // R5 — surface conflicts so the user knows their override
            // is shadowing a default they might not remember setting.
            for (const c of conflicts) {
              chatLines.push(C.warning(
                `    ⚠ ${c.matcher}: user-config overrides default `
                + `(${c.defaultActionId} → ${c.newActionId})`,
              ));
            }
            // R6 — settings visibility.
            for (const [field, value] of Object.entries(settings.applied)) {
              chatLines.push(C.muted(`    ◈ settings.${field} = ${String(value)}`));
            }
            for (const r of settings.rejected) {
              chatLines.push(C.warning(
                `    ✗ settings.${r.field} = ${String(r.value)}: ${r.reason}`,
              ));
            }
            chatScrollOffset = -1;
          }
        } else if (ev.kind === 'malformed') {
          chatLines.push(C.error(
            `  [input-bindings] malformed ${ev.path}: ${ev.error}`,
          ));
          chatScrollOffset = -1;
        } else if (ev.kind === 'version-mismatch') {
          // R8 — unsupported schema version. Keep the prior overlay
          // intact and point the user at the expected version so
          // they know what to migrate to.
          chatLines.push(C.error(
            `  [input-bindings] version mismatch: got ${String(ev.got)}, `
            + `expected ${ev.expected}. Edit ${ev.path} or revert.`,
          ));
          chatScrollOffset = -1;
        }
        // 'missing' is silent — no config file is the default state.
      },
    });
    const initial = bindingBoot?.initial;
    const _bindingsDispose = bindingBoot?.dispose;
    void initial;  // report already consumed the result
    void _bindingsDispose;  // watcher runs for process lifetime
    if (!bindingBoot && debug.enabled) {
      debug.log('input-core', 'user-bindings-init-failed', { error: 'boot returned null' }, { level: 'error' });
    }
  }

  // `focus` is the outer pane tracker retained for sync/plugin routing.
  // Working-dir navigation lives in workingDir.focus below; this one
  // stays 'input' unless a plugin actively cycles it.
  let focus: Pane = 'input';

  // ── Sync mode state ──
  // Sync facade — W4.3 moved sync state onto plugin + widget state.
  // Every read/write here proxies to the live sources so existing
  // dashboard references (sync.selected[0], sync.cursors[focus], etc.)
  // keep working without pervasive refactoring. Returns safe defaults
  // when the sync plugin is inactive (keeps mouse + LLM-action paths
  // from crashing before activate).
  const syncPluginState = (): SyncPluginState | null => {
    const active = pluginHost.active();
    return active && active.name === 'sync' ? (active.state as SyncPluginState) : null;
  };
  const syncListWidget = (i: 0 | 1 | 2): WidgetInstance<ListWidgetState> | null =>
    (widgetHost.get(SYNC_WIDGET_IDS[i]) as WidgetInstance<ListWidgetState> | null) ?? null;

  const arrayFacade = <T>(getter: (i: number) => T, setter: (i: number, v: T) => void) =>
    new Proxy({} as Record<number, T>, {
      get: (_, prop) => getter(Number(prop)),
      set: (_, prop, value) => { setter(Number(prop), value as T); return true; },
    });

  const sync = {
    get focus(): 0 | 1 | 2 { return syncPluginState()?.focus ?? 0; },
    set focus(v: 0 | 1 | 2) { const s = syncPluginState(); if (s) s.focus = v; },
    get modeIdx(): number { return syncPluginState()?.modeIdx ?? 2; },
    set modeIdx(v: number) { const s = syncPluginState(); if (s) s.modeIdx = v; },
    get busy(): boolean { return syncPluginState()?.busy ?? false; },
    set busy(v: boolean) { const s = syncPluginState(); if (s) s.busy = v; },
    get allSkillNames(): string[] { return syncPluginState()?.allSkillNames ?? []; },
    set allSkillNames(v: string[]) { const s = syncPluginState(); if (s) s.allSkillNames = v; },
    cursors: arrayFacade<number>(
      i => syncListWidget(i as 0 | 1 | 2)?.state.cursor ?? 0,
      (i, v) => { const w = syncListWidget(i as 0 | 1 | 2); if (w) w.state.cursor = v; },
    ),
    offsets: arrayFacade<number>(
      i => syncListWidget(i as 0 | 1 | 2)?.state.offset ?? 0,
      (i, v) => { const w = syncListWidget(i as 0 | 1 | 2); if (w) w.state.offset = v; },
    ),
    selected: arrayFacade<Set<string>>(
      i => syncListWidget(i as 0 | 1 | 2)?.state.selected ?? new Set<string>(),
      (_i, _v) => { /* intentional: assigning a new Set is not supported; mutate via .add/.clear */ },
    ),
    lists: arrayFacade<string[]>(
      i => syncListWidget(i as 0 | 1 | 2)?.state.items ?? [],
      (i, v) => { const w = syncListWidget(i as 0 | 1 | 2); if (w) w.state.items = v; },
    ),
  };

  // Chat state
  // Input mode history (persists across input sessions within this dashboard)
  const inputHistoryStore = getInputHistoryStore();
  const inputHistory: string[] = [...inputHistoryStore.list(100)].reverse().map(entry => entry.text);
  const refreshInputHistory = () => {
    inputHistory.length = 0;
    inputHistory.push(...[...inputHistoryStore.list(100)].reverse().map(entry => entry.text));
  };

  // Session-scoped attachment registry (Phase 6). Paste-to-token paths and
  // their extracted text live here for the lifetime of the dashboard.
  const contextRegistry = createContextRegistry();
  let dispatchDashboardSubmitText: ((text: string) => void) | null = null;

  // Best-effort cleanup of stale clipboard paste files from prior runs.
  // Silent — failure here is non-critical (Phase 10 / M3).
  try { pruneOldPastes(); } catch { /* ignore */ }

  // ── Display helpers for /context and attachment summaries ──
  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  };

  /** One log line per tokenize result entry. Fresh registrations get
   *  the full `[Tag #N] filename (size)` line; dedup hits collapse to
   *  a shorter `[Tag #N] (already attached)` so the user can tell the
   *  same file isn't re-loading twice. Repeats inside the same call
   *  (same id appearing twice in `added`) are also collapsed.
   *
   *  Image attachments stay in the chat log without a scratch preview. */
  const renderAttachmentSummary = (added: { attachment: Attachment; isNew: boolean }[]): void => {
    renderDashboardAttachmentSummary(added, {
      formatNewLine: (attachment) =>
        C.muted(`  \u251c\u2500 ${attachment.token} `) + C.subtext(`${attachment.filename} (${fmtBytes(attachment.sizeBytes)})`),
      formatExistingLine: (attachment) =>
        C.muted(`  \u251c\u2500 ${attachment.token} `) + C.subtext('(already attached)'),
      pushLine: (line) => {
        chatLines.push(line);
        return chatLines.length - 1;
      },
      trackRow: (row, attachmentId) => { attachmentRowMap.track(row, attachmentId); },
    });
  };

  // Log-pane area click dispatch — logic lives in
  // `src/log-pane/click-dispatch.ts` (U-4.1 · PLAN L-1). Five call
  // sites (attachChatStreamingKeys · mx-mouse non-embedded fallback ·
  // mx-mouse wd-log embedded hit · textInput.onMouse wd-log hit ·
  // textInput.onMouse non-embedded) all pass the same
  // `buildLogClickDeps()` bag so the dashboard's live closures
  // (termSize / chatScrollOffset / handleAttachmentPopupAction / …)
  // remain the source of truth without coupling the module to
  // dashboard internals.
  // B-3b (2026-04-21) — attachment popup migrated from dashboard-
  // level handle tracking to `coord.modalLifecycleAPI().push(
  // 'attachment-popup', { idempotencyKey: 'log-attachment-popup' },
  // surface)`. The primitive's `replace` policy handles idempotency
  // (prior handle auto-disposes when a new push with the same key
  // arrives) and coord's `modalLifecycle.on('disposed')` reverse-
  // wiring (B-3b Part 2) drives `closeSurface` so paint invalidation
  // + focus cleanup run without dashboard-side plumbing.
  //
  // The VSH returned by createAttachmentPopup still self-disposes
  // on user action (attachment-popup.ts onSubmit/onCancel). We chain
  // that to the primitive handle here so submit/cancel triggers the
  // full coord teardown cascade, not just drag/ctx-key cleanup. This
  // replaces the previous pattern where `display.pushModal(surface)`
  // routed through the mirror type and dashboard held the only
  // reference to the VSH for the re-open dispose.
  //
  // See TECH-DEBT-modal-lifecycle-and-paint §1-1 / §1-2 for the
  // pile-up + paint-residue incidents this pattern historically
  // guarded against.
  // Wave C — pill click cascade. Forward-declared so the
  // buildLogClickDeps closure (built before backgroundPillRuntime is
  // created ~12k lines later) can reference these via late binding.
  // The actual values are wired right after createBackgroundPillRuntime.
  let pillRowGetterForClick: (() => number | null) | null = null;
  let onPillClickForClick: (() => void) | null = null;

  const buildLogClickDeps = (): LogClickDispatchDeps => createDashboardLogClickDeps({
    termSize,
    computePaneH,
    computeLogH,
    chatLinesLength: () => chatLines.length,
    chatScrollOffset: () => chatScrollOffset,
    logFrozenTailIndex: () => logFrozenTailIndex,
    chatFooterLine: () => chatFooterLine.current,
    attachmentRowMap,
    contextRegistry,
    ownerWorkspaceId: currentWorkspaceOwnerId(),
    setWorkingFocus,
    pushTypedModal: (typeName, opts, surface) => display.modalLifecycleAPI().push(typeName, opts, surface),
    onPushRejected: (surfaceId) => {
      if (debug.enabled) {
        debug.log('log-pane.popup.push.rejected', surfaceId, {
          typeName: 'attachment-popup',
        });
      }
    },
    onPushAccepted: (surfaceId, generation) => {
      if (debug.enabled) {
        debug.log('log-pane.popup.push.typed', surfaceId, { generation });
      }
    },
    onAttachmentAction: (action, attachment) => {
      handleAttachmentPopupAction(action, attachment);
      // Popup disposes itself after this callback returns
      // (attachment-popup.ts onSubmit pattern). We don't null the
      // tracking var here — the next push will see
      // `isDisposed() === true` and skip the redundant dispose.
    },
    draw,
    debug,
    // Wave C — pill cascade is enabled when both wires are populated
    // (set after createBackgroundPillRuntime below). Until then the
    // attachment-only legacy path runs.
    pillRowGetter: () => pillRowGetterForClick?.() ?? null,
    onPillClick: () => onPillClickForClick?.(),
    foldStack,
  });

  // Dispatcher for attachment-popup actions (log-pane click → popup
  // → user pick). Kept inline so it can use the chatLines / HUD /
  // registry closures the rest of dashboard already has.
  const handleAttachmentPopupAction = (
    action: AttachmentPopupAction,
    attachment: Attachment,
  ): void => {
    handleDashboardAttachmentPopupAction(action, attachment, {
      dropContextById: (id) => ctxDrop(contextRegistry, id),
      forgetAttachmentRowById: (id) => { attachmentRowMap.forgetById(id); },
      onDropResult: (ok, nextAttachment) => {
        pushDebugLine(
          ok
            ? C.muted(`  📎 dropped ${nextAttachment.token} ${nextAttachment.filename}`)
            : C.warning(`  attachment ${nextAttachment.token} already gone`),
        );
      },
      writeClipboardDetailed,
      onCopied: (label, result) => {
        setSegment(hud, 'copied', C.success(
          result.ok ? `copied ${label}${result.via === 'osc52' ? ' via OSC 52' : ''}` : 'copy failed',
        ), 5);
        draw();
        setTimeout(() => { clearSegment(hud, 'copied'); draw(); }, 1500);
      },
    });
  };

  // Single skill-execution helper — reused by the `/run-skill` slash
  // command and by the Phase 2 skill-router auto-route path. Returns
  // true when the skill actually ran (manifest found), false when the
  // name was unknown (caller's choice whether to surface a hint).
  const runSkillByName = async (skillArg: string, skillArgs: string): Promise<boolean> =>
    runDashboardSkillByName(skillArg, skillArgs, {
      chatHistory: chat.history,
      chatLines,
      contextRegistry,
      foldStack,
      draw,
      pinChatTail,
      pushDebugBlank,
      pushDebugLine,
      attachStreamingKeys: attachChatStreamingKeys,
      formatSkillResponse: (full) => {
        const { cols: rCols } = termSize();
        return formatResponse(full, rCols - 6, getUserConfig().chat.rendering.wrap).map(C.text);
      },
      skillContextLabel: `Dashboard context: mode=${pluginHost.active()?.name ?? 'browse'}`,
      allowAgentsScratch: workingDir.view !== 4 && !agentsViewDismissed,
      showAgentsScratch: () => {
        setCompanionPopupOpen('agents', true);
      },
      publishAgentBatchScratch: (skillName, info, expanded) => {
        dashboardDisplay.publish({
          type: 'setScratch',
          source: `agent-batch:${skillName}`,
          mode: 'agents',
          title: agentBatchScratchTitle(skillName, info),
          lines: renderAgentBatchScratch(info, { expanded }),
        });
      },
      foldMode: logFoldMode,
      expandHint: false,
    });

  // Session-scoped skill decline memory (session 21). When the user
  // dismisses an auto-route countdown or lets a Tab-confirm window
  // expire, remember the skill so we don't pester them again with the
  // same suggestion later in the same dashboard session. Cleared when
  // the process exits — not persisted to disk (stale declines across
  // skill edits are worse than occasional false repeats).
  const declinedSkills = new Set<string>();

  // Warn the user about an attachment budget that's growing large enough to
  // eat noticeable tokens on every submit. 10MB is Claude Code's informal
  // ceiling (PLAN §6 Phase 9).
  const CTX_WARN_BYTES = 10 * 1024 * 1024;

  // Short labels for the /context table's `kind` column — keeps the line
  // under ~80 cols even with a long filename.
  const KIND_DISPLAY: Record<Attachment['kind'], string> = {
    image: 'image', text: 'text', md: 'md',
    pdf: 'pdf',     docx: 'docx', xlsx: 'xlsx',
  };

  /** Truncate `s` to `max` cols, keeping the tail so filenames with distinct
   *  prefixes stay legible ("…reallylong/name.pdf"). */
  const ellipsize = (s: string, max: number): string =>
    s.length <= max ? s : '\u2026' + s.slice(-(max - 1));

  /**
   * Grab an image off the macOS clipboard, register it in the session
   * registry, and render a summary line. Shared between the `/paste` slash
   * command and the Ctrl+Shift+V chord on the input. Returns the token
   * string (e.g. `[Image #3] `) for the caller to splice into its buffer,
   * or null on failure.
   */
  const attachClipboardImage = async (): Promise<string | null> => {
    if (!isClipboardSupported()) {
      pushDebugLine(C.warning('  Clipboard paste is only supported on macOS.'));
      return null;
    }
    try {
      const savedPath = await grabClipboardImage();
      if (!savedPath) {
        pushDebugLine(C.warning('  No image on clipboard.'));
        pushDebugLine(C.muted('  Take a screenshot (Cmd+Shift+4, Ctrl held) to copy to clipboard.'));
        return null;
      }
      const st = statSync(savedPath);
      const { attachment: att, isNew } = ctxAddEx(contextRegistry, {
        kind: 'image',
        sourcePath: savedPath,
        filename: basename(savedPath),
        sizeBytes: st.size,
        mtime: Math.floor(st.mtimeMs),
      });
      if (isNew) {
        pushDebugLine(C.muted(`  \u251c\u2500 `) + C.text(att.token) + ' ' + C.subtext(`${att.filename} (${fmtBytes(att.sizeBytes)})`));
      } else {
        pushDebugLine(C.muted(`  \u251c\u2500 `) + C.text(att.token) + ' ' + C.subtext('(already attached)'));
      }
      clearSegment(hud, 'clipimg');
      // The attachment summary confirms the paste without a scratch preview or modal.
      return `${att.token} `;
    } catch (err: any) {
      // grabClipboardImage now throws with the osascript diagnostic
      // ("no-image: tried …" / "write-error: …") — surface it so the
      // user can tell whether the clipboard truly has an image or
      // whether it's a format we couldn't coerce.
      const msg = err?.message || String(err);
      if (msg.startsWith('no-image')) {
        pushDebugLine(C.warning('  Clipboard has no recognisable image (tried PNG, TIFF, JPEG).'));
      } else {
        pushDebugLine(C.error(`  Paste failed: ${msg}`));
      }
      return null;
    }
  };

  const renderContextList = (): string[] => {
    const items = ctxList(contextRegistry);
    const lines: string[] = [];
    const output = (line: string): void => { pushDebugLine(line); lines.push(line); };
    pushDebugBlank();
    output(C.accent('\u276f /context'));
    if (!items.length) {
      output(C.muted('  (empty)'));
      return lines;
    }
    const totalBytes = ctxTotalBytes(contextRegistry);
    const total = fmtBytes(totalBytes);
    output(C.muted(`  ${items.length} items, ${total} total`));
    if (totalBytes > CTX_WARN_BYTES) {
      output(C.warning(`  ⚠ ${total} exceeds 10MB — consider /context clear big`));
    }

    // Table columns: ✓  id   kind   filename(trunc)   size   [source-tail]
    // Widths chosen to fit a typical 80-col terminal with the dashboard's
    // left indent; filename gets the slack column so long paths just clip.
    const { cols } = termSize();
    const filenameMax = Math.max(18, cols - 36);
    output(C.muted(
      `  ${'  '}${'id'.padEnd(4)}${'kind'.padEnd(7)}${'file'.padEnd(filenameMax)}${'size'.padStart(8)}`
    ));
    for (const a of items) {
      const mark = a.loaded ? C.success('\u2713') : C.muted('\u00B7');
      const idCol   = `#${a.id}`.padEnd(4);
      const kindCol = (KIND_DISPLAY[a.kind] ?? a.kind).padEnd(7);
      const file    = ellipsize(a.filename, filenameMax).padEnd(filenameMax);
      const size    = fmtBytes(a.sizeBytes).padStart(8);
      output(`  ${mark} ${C.muted(idCol)}${C.muted(kindCol)}${C.text(file)}${C.subtext(size)}`);
    }
    return lines;
  };

  const chat = createChatState(
    `You are ElanousAgent's in-terminal assistant.
Answer in the user's language. Be concise.
When a user's request matches an installed skill (they will see a "hint: /run-skill X" line above their message), you may suggest they run it. Otherwise respond with plain text.
Mode- and sync-specific instructions are injected per-turn when relevant — do not assume sync/diff context unless the current turn's Context: block explicitly mentions them.`,
  );
  let chatLines: string[] = []; // chat log — increasingly reserved for transcript / LLM speech
  const tuiSeatAskClientId = getTuiSeatAskClientId();
  const tuiSeatAskDeps = {
    channel: 'tui' as const, clientId: tuiSeatAskClientId,
    send: async (_origin: import('../seat-dispatch/seat-ask.js').AskOrigin, answer: string) => {
      chatLines.push(C.info(answer));
      chatScrollOffset = -1;
      draw();
    },
  };
  const pollTuiSeatAnswers = (): void => {
    void deliverSeatAnswers(tuiSeatAskDeps).catch((error) => debug.log('seat.ask', 'delivery-failed', { via: 'tui', error: String(error) }, { level: 'warn' }));
  };
  let tuiSeatAskTimer: ReturnType<typeof setInterval> | undefined;
  let debugLines: string[] = [
    C.muted('Dashboard ready. Press / for slash, Ctrl+L for plain input.'),
    C.muted('Debug window ready. Use /debug window open.'),
  ];
  let chatScrollOffset = -1; // -1 = auto-follow tail
  let debugScrollOffset = -1; // -1 = auto-follow tail
  let debugLogFilterQuery: string = '';
  const pushChatLine = (line: string): void => {
    chatLines.push(line);
    const dropCount = trimLogBuffer(chatLines, CHAT_LOG_BUFFER_SOFT_LIMIT);
    if (dropCount > 0 && debug.enabled) {
      debug.log('log.buffer.trim', `drop=${dropCount}`, {
        kind: 'chat',
        limit: CHAT_LOG_BUFFER_SOFT_LIMIT,
        after: chatLines.length,
      });
    }
    chatScrollOffset = -1;
  };
  const liveTypeaheadEchoes: { at: number; lines: string[] }[] = [];
  const restoreLiveTypeaheadEchoes = (): void => {
    let after = 0;
    for (const echo of liveTypeaheadEchoes) {
      let found = -1;
      for (let i = after; i <= chatLines.length - echo.lines.length; i++) {
        if (echo.lines.every((line, offset) => chatLines[i + offset] === line)) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        found = Math.max(after, Math.min(echo.at, chatLines.length));
        chatLines.splice(found, 0, ...echo.lines);
      }
      echo.at = found;
      after = found + echo.lines.length;
    }
  };
  const echoSubmittedUserText = (text: string, opts?: { live?: boolean }): void => {
    const echoStart = chatLines.length;
    chatLines.push('');
    if (opts?.live) chatLines.push(C.muted('  ↳ 이어서'));
    const echoWrapCols = Math.max(20, termSize().cols - 6);
    const echoRows = wrapAnsiByWidth(`❯ ${text}`, echoWrapCols);
    if (echoRows.length === 0) {
      chatLines.push(C.accent('❯ '));
    } else {
      echoRows.forEach((row, i) => {
        chatLines.push(C.accent(i === 0 ? row : `  ${row}`));
      });
    }
    if (opts?.live) liveTypeaheadEchoes.push({ at: echoStart, lines: chatLines.slice(echoStart) });
    chatScrollOffset = -1;
  };
  const pushDebugLine = (line: string): void => {
    debugLines.push(line);
    const dropCount = trimLogBuffer(debugLines, DEBUG_LOG_BUFFER_SOFT_LIMIT);
    if (dropCount > 0 && debug.enabled) {
      debug.log('log.buffer.trim', `drop=${dropCount}`, {
        kind: 'debug',
        limit: DEBUG_LOG_BUFFER_SOFT_LIMIT,
        after: debugLines.length,
      });
    }
    debugScrollOffset = -1;
  };
  const pushDebugLines = (lines: string[]): void => {
    if (lines.length === 0) return;
    debugLines.push(...lines);
    const dropCount = trimLogBuffer(debugLines, DEBUG_LOG_BUFFER_SOFT_LIMIT);
    if (dropCount > 0 && debug.enabled) {
      debug.log('log.buffer.trim', `drop=${dropCount}`, {
        kind: 'debug',
        limit: DEBUG_LOG_BUFFER_SOFT_LIMIT,
        after: debugLines.length,
      });
    }
    debugScrollOffset = -1;
  };
  const pushDebugBlank = (): void => {
    pushDebugLine('');
  };
  const clearDebugLogFilter = (): void => {
    debugLogFilterQuery = '';
  };
  const applyDebugLogFilter = (query: string): void => {
    debugLogFilterQuery = query.trim();
    if (debug.enabled) {
      debug.log('debug-log.filter.apply', `q="${debugLogFilterQuery}"`, {
        active: debugLogFilterQuery.length > 0,
      });
    }
  };
  // Scroll-freeze — when the user scrolls up from tail, snapshot the
  // current chatLines length here. The log-pane renderer clips its
  // visible slice to [0, logFrozenTailIndex) so new output stops
  // piling up under the user. Cleared when the user returns to tail
  // (explicit G / scroll-to-bottom), or any time scrolling lands at
  // maxScr (the existing `next >= maxScr ? -1` branch in
  // handleLogPaneKey). See MANUAL-log-pane.md §scroll-freeze.
  let logFrozenTailIndex: number | null = null;
  // ELANOUS_LOG_PAUSE_ON_SCROLL=0 disables the feature (legacy behavior
  // where new lines appear under the scrolled-up user). Default on.
  const logFreezeEnabled = (process.env['ELANOUS_LOG_PAUSE_ON_SCROLL'] ?? '1') !== '0';
  // Attachment row metadata — maps chatLines absolute index to the
  // attachment id whose `├─ [Kind #N] filename (size)` summary row
  // lives there. Populated in renderAttachmentSummary, cleared on
  // log wipe, and consulted by the log-pane mouse-click handler to
  // detect hits and open the attachment popup. See
  // 내부 문서 `MANUAL-log-pane` §clicking-attachments.
  const attachmentRowMap = createAttachmentRowMap();
  // Turn-separator mode — inserts a thin rule / timestamp line
  // between user turns so long sessions are skimmable. `off` keeps
  // the legacy behaviour (no added lines). Configurable at runtime
  // via `/log turn <mode>` or boot-time via `ELANOUS_LOG_TURN_SEPARATOR`
  // env (rule | time | both | off).
  let logTurnSeparatorMode: LogTurnSeparatorMode = (() => {
    const raw = (process.env['ELANOUS_LOG_TURN_SEPARATOR'] ?? '').toLowerCase().trim();
    if (raw === 'rule' || raw === 'time' || raw === 'both' || raw === 'off') return raw;
    return 'off';
  })();
  let logFoldMode: FoldMode = getUserConfig().dashboard.foldMode ?? 'task-unit';
  // In-pane search state. While active: renderer highlights matches
  // + shows a `🔍 "q" N/M — n/N · Esc clear` title badge; n/N on log
  // focus cycle through `logSearchResults`; Esc on log focus clears
  // everything. Modal landing (createLogSearchModal) populates this
  // on Enter; `/log search <query>` can also set it directly.
  let logSearchQuery: string = '';
  let logSearchResults: LogSearchResult[] = [];
  let logSearchCursor: number = 0;  // index into logSearchResults
  let logFilterQuery: string = '';
  const clearLogSearch = (): void => {
    logSearchQuery = '';
    logSearchResults = [];
    logSearchCursor = 0;
  };
  const clearLogFilter = (): void => {
    logFilterQuery = '';
  };
  const applyLogFilter = (query: string): void => {
    logFilterQuery = query.trim();
    if (debug.enabled) {
      debug.log('log-pane.filter.apply', `q="${logFilterQuery}"`, {
        active: logFilterQuery.length > 0,
      });
    }
  };
  const applyLogSearch = (query: string): void => {
    logSearchQuery = query.trim();
    logSearchResults = logSearchQuery
      ? findLogMatches(chatLines, logSearchQuery)
      : [];
    logSearchCursor = 0;
    if (debug.enabled) {
      debug.log('log-pane.search.apply', `q="${logSearchQuery}"`, {
        matches: logSearchResults.length,
      });
    }
  };
  /** Center the viewport on a search-result line. Sets chatScrollOffset
   *  so the match row lands mid-pane when possible; clamps at bounds. */
  const scrollToSearchResult = (result: LogSearchResult): void => {
    const { rows: tr } = termSize();
    const sH = computeLogH(tr);
    const bodyH = Math.max(0, sH - 1);
    const hasFooter = chatFooterLine.current != null && chatFooterLine.current !== '';
    const contentH = Math.max(0, bodyH - (hasFooter ? 2 : 0));
    const target = Math.max(0, result.lineIdx - Math.floor(contentH / 2));
    const maxScroll = Math.max(0, chatLines.length - contentH);
    chatScrollOffset = target >= maxScroll ? -1 : target;
    // Entering a scrolled state may set the freeze — the
    // handleLogPaneKey transition only fires for user keystrokes, so
    // we mirror the snapshot here so the freeze badge stays honest.
    if (logFreezeEnabled && chatScrollOffset >= 0 && logFrozenTailIndex === null) {
      logFrozenTailIndex = chatLines.length;
    }
  };
  const gotoNextMatch = (dir: 1 | -1): void => {
    if (logSearchResults.length === 0) return;
    logSearchCursor = (logSearchCursor + dir + logSearchResults.length) % logSearchResults.length;
    const target = logSearchResults[logSearchCursor]!;
    scrollToSearchResult(target);
  };
  const openLogSearchModal = createDashboardLogSearchOpener({
    display: () => display,
    linesGetter: () => chatLines,
    initialQuery: () => logSearchQuery,
    termSize,
    computePaneH: rows => computePaneH(rows),
    currentThemeTokens: () => currentThemeTokens(),
    currentWorkspaceOwnerId: () => currentWorkspaceOwnerId(),
    draw: () => draw(),
    onJump: (result, query) => {
      applyLogSearch(query);
      // Position cursor on the picked result. applyLogSearch reset
      // it to 0; advance it to the result the user actually picked.
      const idx = logSearchResults.findIndex(r => r.lineIdx === result.lineIdx);
      logSearchCursor = idx >= 0 ? idx : 0;
      scrollToSearchResult(result);
      draw();
    },
    onCancel: query => {
      // Keep the query so n/N still works after cancel — tmux convention.
      if (query.trim()) applyLogSearch(query);
      draw();
    },
  });

  // TUI 부활 S-a — /resume 세션 픽커 (codex 패리티). chat 세션 스토어를
  // 필터형 모달로 띄우고, 선택 시 기존 `/session load <id>` slash 를
  // 합성 submit 으로 재사용한다 — 히스토리 replay·daemon swap 등 검증된
  // 파이프라인을 복제하지 않는다. 명령이 입력창에 echo 되므로 무슨 일이
  // 일어났는지도 투명하다.
  let sessionResumeModalHandle: { dispose: () => void } | null = null;
  let sessionResumeModal: SearchModalHandle | null = null;
  const closeSessionResumePicker = (): void => {
    if (sessionResumeModalHandle) { try { sessionResumeModalHandle.dispose(); } catch { /* ignore */ } sessionResumeModalHandle = null; }
    sessionResumeModal = null;
    draw();
    try { promptCtl.repaint(); } catch { /* ignore */ } // C-d-1 — 하단 슬롯 반납 후 composer 복원.
  };
  const openSessionResumePicker = (): void => {
    if (sessionResumeModal) return;
    const rows = listChatSessionsForResume({ limit: 30 });
    if (rows.length === 0) {
      chatLines.push(C.muted('  (no sessions yet — /session new 로 시작)'));
      chatScrollOffset = -1;
      draw();
      return;
    }
    // Pickers share the composer bottom slot.
    const placement = resolveDecisionPickerPlacement({ height: 16 });
    const modalWidth = placement.width;
    const fmtRow = (m: (typeof rows)[number]): string => {
      const marker = m.id === attachedSessionId ? '▸ ' : '  ';
      const ts = m.updatedAt.slice(5, 16).replace('T', ' ');
      const binds: string[] = [];
      if (m.bindings?.cli) binds.push('cli');
      if (m.bindings?.telegram) binds.push('tg');
      if (m.bindings?.discord) binds.push('dc');
      const bindStr = binds.length > 0 ? `[${binds.join(',')}]` : '';
      const title = (m.title || '(no title)').slice(0, 42);
      return `${marker}${m.id.slice(0, 8)}  ${ts}  ${String(m.messageCount).padStart(3)}t ${bindStr.padEnd(9)} ${title}`;
    };
    const handle = createSearchModal({
      id: `session-resume:${Date.now().toString(36)}`,
      bounds: placement.bounds,
      ...(placement.slot ? { slot: placement.slot } : {}),
      title: 'Resume session',
      width: modalWidth,
      maxVisible: 10,
      primaryActionLabel: 'resume',
      cancelActionLabel: 'cancel',
      filterable: rows.length > 3,
      onQuery: (q) => {
        const needle = q.trim().toLowerCase();
        return rows
          .filter((m) => !needle
            || m.id.toLowerCase().includes(needle)
            || (m.title ?? '').toLowerCase().includes(needle))
          .map((m): SearchItem => ({ label: fmtRow(m), payload: m.id }));
      },
      onAccept: (item) => {
        const id = String(item.payload);
        closeSessionResumePicker();
        if (promptCtl.submit) {
          promptCtl.submit(`/session load ${id}`);
        } else {
          // 입력 루프 비활성 등으로 합성 submit 불가 — 수동 안내 폴백.
          chatLines.push(C.muted(`  /session load ${id.slice(0, 8)} 를 입력해 재개하세요`));
          chatScrollOffset = -1;
          draw();
        }
      },
      onCancel: () => closeSessionResumePicker(),
      theme: currentThemeTokens(),
    });
    sessionResumeModal = handle;
    attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
    sessionResumeModalHandle = display.pushModal(handle.surface);
    draw();
  };

  const openSourceDeltaBrowserPopup = async (
    mode: 'latest' | 'recent' = 'recent',
    limit?: number,
    browserMode?: 'all' | 'files' | 'turns',
  ): Promise<boolean> => {
    const diffCfg = getUserConfig().chat.rendering.diff;
    const { getSourceDeltaManager, createSourceDeltaBrowserPopup } = await import('../code-edit/index.js');
    const turns = mode === 'latest'
      ? getSourceDeltaManager().recentTurns(1)
      : getSourceDeltaManager().recentTurns(limit ?? diffCfg.turnBrowserHistory);
    if (turns.length === 0) {
      pushDebugLine(C.muted('  /delta: no source delta available yet'));
      chatScrollOffset = -1;
      draw();
      return false;
    }
    const { cols: tc, rows: tr } = termSize();
    const popup = createSourceDeltaBrowserPopup({
      turns,
      mode: browserMode ?? diffCfg.turnBrowserMode,
      termCols: tc,
      termRows: tr,
      theme: currentThemeTokens(),
      onCancel: () => draw(),
    });
    if (!popup) {
      pushDebugLine(C.muted('  /delta: nothing to show'));
      chatScrollOffset = -1;
      draw();
      return false;
    }
    let modalHandle: { dispose(): void } | null = null;
    const prevOnKey = popup.surface.onKey;
    popup.surface.onKey = async (ev) => {
      const name = (ev.name ?? '').toLowerCase();
      const nextMode = !ev.ctrl && !ev.alt && !ev.shift
        ? (name === 'a'
          ? 'all'
          : name === 'f'
            ? 'files'
            : name === 't'
              ? 'turns'
              : null)
        : null;
      if (nextMode && nextMode !== (browserMode ?? diffCfg.turnBrowserMode)) {
        try { popup.dispose(); } catch { /* ignore */ }
        try { modalHandle?.dispose(); } catch { /* ignore */ }
        await openSourceDeltaBrowserPopup(mode, limit, nextMode);
        draw();
        return 'consumed';
      }
      return prevOnKey?.(ev) ?? 'passthrough';
    };
    attachSurfaceToWorkspace(popup.surface, currentWorkspaceOwnerId());
    modalHandle = display.pushModal(popup.surface);
    draw();
    return true;
  };

  const pushTurnSeparator = (): void => {
    if (logTurnSeparatorMode === 'off') return;
    // Width comes from the last draw — use a forgiving default
    // until we know better. Renderer will happily show shorter
    // rules when the pane shrinks.
    const { cols: tc } = termSize();
    const ruleW = Math.max(20, Math.min(tc - 4, 80));
    if (logTurnSeparatorMode === 'time') {
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      chatLines.push(C.dim(`──── ${hh}:${mm}:${ss} ────`));
      return;
    }
    const rule = '─'.repeat(ruleW);
    if (logTurnSeparatorMode === 'rule') {
      chatLines.push(C.dim(rule));
      return;
    }
    // both — rule line with inline timestamp centered
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const label = ` ${hh}:${mm}:${ss} `;
    const sideW = Math.max(4, Math.floor((ruleW - label.length) / 2));
    const side = '─'.repeat(sideW);
    chatLines.push(C.dim(side + label + side));
  };

  // T6-K1 — conversation-mode state. Flipped by /control + /default
  // slashes. When control mode is active, the LLM turn gets a replaced
  // system prompt (T6-K2 Dashboard Control Manual) so it treats
  // every user sentence as a command to move widgets, spawn windows,
  // execute slashes, etc.
  const chatModeState = createSessionPostureState();

  // T3-C2 — vi-editor mounted in the preview pane. Set by the
  // browser pane's `e` key on a file; cleared on :q / :q!. When
  // non-null it overrides the preview pane's normal render path.
  let viEditor: ViEditorHandle | null = null;
  const VI_EDITOR_MAX_BYTES = 1_000_000;

  const openPreviewViEditor = (absPath: string): void => {
    try {
      const stat = statSync(absPath);
      if (stat.size > VI_EDITOR_MAX_BYTES) {
      pushDebugLine(C.error(`  File too large (${fmtBytes(stat.size)}) — 1 MB max for the vi editor.`));
      return;
      }
      const text = readFileSync(absPath, 'utf-8');
      viEditor = createViEditor({ filePath: absPath, initialText: text });
      setWorkingFocus('preview', 'vi-editor-open');
      pushDebugLine(C.muted(`  Opened ${basename(buildDashboardEditorOpenPayload(absPath))} in vi-editor. i=insert, Esc=normal, :w=save, :q=quit.`));
    } catch (err) {
      pushDebugLine(C.error(`  Open editor failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  const closePreviewViEditor = (): void => {
    viEditor = null;
    setWorkingFocus('browser', 'vi-editor-close');
    try { refreshWorkingDirPreview(); } catch { /* may not be defined yet */ }
  };

  const handleViEditorKey = (key: import('../tui.js').Key): boolean => {
    if (!viEditor) return false;
    viEditor.onKey(toDashboardKeyEvent(key));
    const s = viEditor.getState();
    if (s.savedRequested) {
      try {
        writeFileSync(s.filePath, viEditor.getText(), 'utf-8');
        s.savedRequested = false;
        s.dirty = false;
        s.message = `"${s.filePath}" written`;
        pushDebugLine(C.success(`  wrote ${basename(s.filePath)}`));
      } catch (err) {
        s.savedRequested = false;
        s.message = `write failed: ${err instanceof Error ? err.message : String(err)}`;
        pushDebugLine(C.error(`  ${s.message}`));
      }
    }
    if (s.quitRequested) {
      closePreviewViEditor();
    }
    return true;
  };

  // T2-P7 — compact-level-aware log pusher. New sites prefer pushLog
  // over chatLines.push so tabletMini / tabletTwo viewports drop
  // low-severity noise automatically. getCompactLevel reads termSize
  // each call so runtime resizes adapt without a re-wire.
  const pushLog = createPushLog({
    chatLines: debugLines,
    getCompactLevel: () => {
      const { cols, rows } = termSize();
      return compactLevelForViewport({ cols, rows });
    },
  });
  // While a streaming turn is in flight AND the user has manually
  // scrolled up (j/k/PgUp), chunk callbacks must NOT slam the log back
  // to tail. Reset at the end of each streaming window by the same
  // helper that attaches the streaming-keys listener.
  let userScrolledDuringStream = false;
  // Flipped ON inside attachChatStreamingKeys (enter) and OFF on its
  // cleanup. Pure diagnostic signal — `key.press` events include the
  // current value so log analysis can filter "what keys fired while
  // a turn was in flight".
  let streamingInFlight = false;
  const resolveTmuxStatusLabel = (): string | null => {
    if (!process.env['TMUX']) return null;
    const fallback = process.env['TMUX_PANE'] ?? 'tmux';
    try {
      const r = spawnSync('tmux', ['display-message', '-p', '#S'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 300,
      });
      const label = typeof r.stdout === 'string' ? r.stdout.trim() : '';
      return label || fallback;
    } catch {
      return fallback;
    }
  };
  const tmuxStatusLabel = resolveTmuxStatusLabel();
  const resolveSshStatusLabel = (): string | null => {
    if (tmuxStatusLabel) return null;
    const sshTty = process.env['SSH_TTY'];
    const hasLiveSshTty = !!sshTty && existsSync(sshTty);
    const hasSshEnv = !!process.env['SSH_CONNECTION'] || !!process.env['SSH_CLIENT'];
    return (hasLiveSshTty || (!sshTty && hasSshEnv)) ? 'ssh' : null;
  };
  const sshStatusLabel = resolveSshStatusLabel();
  // TUI ↔ Telegram handoff binding. When set, every completed chat
  // turn (user + assistant pair) is also appended to the session's
  // on-disk JSONL so a mobile-side Telegram reply can pick up where
  // the laptop left off. `/telegram attach` creates this, `/telegram
  // detach` clears it. Lives for the dashboard lifetime.
  let attachedSessionId: string | null = null;
  const chatPersonaSelection = new TuiChatPersonaSelection();
  let chatPersonaConversationId = crypto.randomUUID();
  const currentChatPersonaSessionId = () => attachedSessionId ?? chatPersonaConversationId;
  let attachedChatId: number | null = null;
  const forkableSessionHistory = (source: ChatMessage[] = chat.history): ForkableSessionTurn[] =>
    flattenForkableSessionHistory(source);
  const forkAttachedSessionFromChatHistory = async (): Promise<void> => {
    const { forkSessionFromHistory, setActiveSessionId: _setActive } = await import('../session/index.js');
    const provider = inspectActiveProvider();
    const forked = forkSessionFromHistory({
      provider: provider.provider,
      model: provider.model,
      forkedFromId: attachedSessionId ?? undefined,
      messages: forkableSessionHistory(),
    });
    const prev = attachedSessionId;
    const selectedPersona = chatPersonaSelection.get(currentChatPersonaSessionId());
    attachedSessionId = forked.meta.id;
    if (selectedPersona) chatPersonaSelection.set(forked.meta.id, selectedPersona);
    try { _setActive(forked.meta.id); } catch { /* best-effort */ }
    chatLines.push('');
    chatLines.push(prev
      ? C.success(`  ✓ forked session ${forked.meta.id.slice(0, 8)} from ${prev.slice(0, 8)}`)
      : C.success(`  ✓ forked current history into session ${forked.meta.id.slice(0, 8)}`));
    chatLines.push(C.muted(`    ${forked.meta.messageCount} turn${forked.meta.messageCount === 1 ? '' : 's'} copied. Next turn continues on the new session.`));
  };
  // TUI 부활 S-b — 타임트래블 포크 (codex ForkSnapshot 동형). 방치 엔진
  // acp/session-fork.ts 의 위치/절단 로직을 소비해 n번째(1-based) user
  // 턴 직전으로 절단한 히스토리를 새 세션으로 fork(lineage=forkedFromId)
  // 하고 attach 를 전환한다. in-memory chat.history 도 같은 경계로 절단
  // — 다음 턴이 새 세션 문맥으로 이어진다. 잘려나간 n번째 user 메시지
  // 텍스트를 반환해 호출측(/fork 핸들러)이 입력창에 prefill — "그
  // 시점으로 돌아가 고쳐 다시 보내기"(claude-code Esc-Esc backtrack ·
  // codex fork 픽커) UX. n 은 범위 밖이면 클램프.
  const forkTimetravelFromChatHistory = async (
    n: number,
  ): Promise<{ forkedId: string; turn: number; removedUserText: string } | null> => {
    type ForkMsgs = Parameters<typeof userMessagePositions>[0];
    const positions = userMessagePositions(chat.history as unknown as ForkMsgs);
    if (positions.length === 0) {
      chatLines.push(C.warning('  /rewind: no user turns in this session yet'));
      chatScrollOffset = -1;
      return null;
    }
    const turn = Math.max(1, Math.min(Math.floor(n), positions.length));
    const { boundary } = truncateBeforeNthUser(chat.history as unknown as ForkMsgs, turn);
    const removedMsg = chat.history[boundary];
    const truncatedChat = chat.history.slice(0, boundary);
    const { forkSessionFromHistory, setActiveSessionId: setActiveForTimetravel } = await import('../session/index.js');
    const provider = inspectActiveProvider();
    const forked = forkSessionFromHistory({
      provider: provider.provider,
      model: provider.model,
      forkedFromId: attachedSessionId ?? undefined,
      title: `fork@u${turn}`,
      messages: forkableSessionHistory(truncatedChat),
    });
    const prev = attachedSessionId;
    const selectedPersona = chatPersonaSelection.get(currentChatPersonaSessionId());
    attachedSessionId = forked.meta.id;
    if (selectedPersona) chatPersonaSelection.set(forked.meta.id, selectedPersona);
    try { setActiveForTimetravel(forked.meta.id); } catch { /* best-effort */ }
    // in-memory 히스토리도 동일 경계로 절단 — 스토어와 문맥 일치 보장.
    chat.history.length = 0;
    chat.history.push(...truncatedChat);
    const removedUserText = removedMsg ? (forkableSessionHistory([removedMsg])[0]?.content ?? '') : '';
    chatLines.push('');
    chatLines.push(C.success(
      `  ✓ time-travel fork ${forked.meta.id.slice(0, 8)}${prev ? ` from ${prev.slice(0, 8)}` : ''} — user turn #${turn} 직전으로`,
    ));
    chatLines.push(C.muted(
      `    ${forked.meta.messageCount} turn${forked.meta.messageCount === 1 ? '' : 's'} kept · 위 로그에서 turn #${turn} 이후 내용은 새 세션에 없음`,
    ));
    chatScrollOffset = -1;
    return { forkedId: forked.meta.id, turn, removedUserText };
  };

  // TUI 부활 S-b(+컨셉 정렬 2026-07-12) — /rewind 픽커. user 턴(최신
  // 먼저)을 필터형 모달로 나열하고 선택 시 `/rewind <n>` 합성 submit.
  // codex backtrack(Esc-Esc)·claude-code rewind 계보 — 시각 선택이 기본
  // UX, 숫자 입력은 요구하지 않는다. full-copy 분기는 별도 /fork
  // (codex ForkCurrentSession 동형).
  let forkPickerModal: SearchModalHandle | null = null;
  let forkPickerHandle: { dispose: () => void } | null = null;
  // Esc·Esc → /rewind 제스처 상태 (resolveEscEscRewind 와 짝).
  let rewindEscPrimedAt = 0;
  let rewindEscHintShown = false;
  const closeForkTimetravelPicker = (): void => {
    if (forkPickerHandle) { try { forkPickerHandle.dispose(); } catch { /* ignore */ } forkPickerHandle = null; }
    forkPickerModal = null;
    draw();
    try { promptCtl.repaint(); } catch { /* ignore */ } // C-d-1 — 하단 슬롯 반납 후 composer 복원.
  };
  const openForkTimetravelPicker = (): void => {
    if (forkPickerModal) return;
    type ForkMsgs = Parameters<typeof userMessagePositions>[0];
    const positions = userMessagePositions(chat.history as unknown as ForkMsgs);
    if (positions.length === 0) {
      chatLines.push(C.warning('  /rewind: no user turns in this session yet'));
      chatScrollOffset = -1;
      draw();
      return;
    }
    const turnItems = positions
      .map((idx, i): SearchItem => {
        const msg = chat.history[idx];
        const preview = (msg ? (forkableSessionHistory([msg])[0]?.content ?? '') : '')
          .replace(/\s+/g, ' ')
          .slice(0, 56) || '(non-text turn)';
        return { label: `#${String(i + 1).padStart(2)}  ${preview}`, payload: String(i + 1) };
      })
      .reverse(); // 최신 턴 먼저
    const items: SearchItem[] = turnItems;
    // Pickers share the composer bottom slot.
    const placement = resolveDecisionPickerPlacement({ height: 16 });
    const modalWidth = placement.width;
    const handle = createSearchModal({
      id: `rewind-timetravel:${Date.now().toString(36)}`,
      bounds: placement.bounds,
      ...(placement.slot ? { slot: placement.slot } : {}),
      title: 'Rewind — 과거 user 턴으로 (원본 세션은 보존 · 새 세션 분기)',
      width: modalWidth,
      maxVisible: 10,
      primaryActionLabel: 'rewind',
      cancelActionLabel: 'cancel',
      filterable: items.length > 4,
      onQuery: (q) => {
        const needle = q.trim().toLowerCase();
        return items.filter((it) => !needle || String(it.label).toLowerCase().includes(needle));
      },
      onAccept: (item) => {
        const payload = String(item.payload);
        closeForkTimetravelPicker();
        const cmd = `/rewind ${payload}`;
        if (promptCtl.submit) {
          promptCtl.submit(cmd);
        } else {
          chatLines.push(C.muted(`  ${cmd} 를 입력해 되감으세요`));
          chatScrollOffset = -1;
          draw();
        }
      },
      onCancel: () => closeForkTimetravelPicker(),
      theme: currentThemeTokens(),
    });
    forkPickerModal = handle;
    attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
    forkPickerHandle = display.pushModal(handle.surface);
    draw();
  };

  // TUI 부활 C-b-2 PR① — /mission new 준비(ready) 워처 + 인라인 HITL 픽커.
  // 텔레그램 미션 UX(등록→준비완료 버튼 3행→해소)의 TUI flavor. 실행/알림은
  // detached prepare 그대로 두고, TUI 는 store 폴링(mission-tui-watch 순수 판정)
  // 으로 전이 시에만 chat line 을 낸다. 준비완료 → 페이즈 보드 인라인 + 픽커
  // (승인/보류=dispatchAutopilotMissions via:'tui' · 정정=spawnMissionPrepare 재분해).
  const missionReadyWatchTimers = new Map<string, ReturnType<typeof setInterval>>();
  const stopMissionReadyWatch = (missionId: string): void => {
    const t = missionReadyWatchTimers.get(missionId);
    if (t) { clearInterval(t); missionReadyWatchTimers.delete(missionId); }
  };
  let missionHitlModal: SearchModalHandle | null = null;
  let missionHitlModalHandle: { dispose: () => void } | null = null;
  const closeMissionHitlPicker = (): void => {
    if (missionHitlModalHandle) { try { missionHitlModalHandle.dispose(); } catch { /* ignore */ } missionHitlModalHandle = null; }
    missionHitlModal = null;
    draw();
    try { promptCtl.repaint(); } catch { /* ignore */ } // C-d-1 — 하단 슬롯 반납 후 composer 복원.
  };
  const openMissionHitlPicker = (missionId: string, goal: string): void => {
    if (missionHitlModal) return;
    void (async () => {
      const { HITL_REVISE_PRESETS } = await import('../autopilot/mission-notify.js');
      const items: SearchItem[] = [
        { label: '✅ 승인 — 실행 시작', payload: 'approve' },
        { label: '⏸️ 보류 — 기록 유지·실행 안 함', payload: 'hold' },
        ...HITL_REVISE_PRESETS.map((p): SearchItem => ({ label: `${p.label} — 재분해`, payload: `preset:${p.action}` })),
        { label: '✏️ 직접입력 — 정정 코멘트 작성', payload: 'custom' },
      ];
      // Pickers share the composer bottom slot.
      const placement = resolveDecisionPickerPlacement({ height: 14 });
      const modalWidth = placement.width;
      const handle = createSearchModal({
        id: `mission-hitl:${Date.now().toString(36)}`,
        bounds: placement.bounds,
        ...(placement.slot ? { slot: placement.slot } : {}),
        title: `미션 승인 — ${goal.slice(0, 48)}`,
        width: modalWidth,
        maxVisible: 8,
        primaryActionLabel: 'select',
        cancelActionLabel: 'later',
        filterable: false,
        onQuery: () => items,
        onAccept: (item) => {
          const pick = String(item.payload);
          closeMissionHitlPicker();
          void (async () => {
            if (pick === 'approve' || pick === 'hold') {
              const { dispatchAutopilotMissions } = await import('../autopilot/mission-tool.js');
              const r = await dispatchAutopilotMissions(
                pick === 'approve'
                  ? { action: 'approve', id: missionId, via: 'tui' }
                  : { action: 'cancel', id: missionId, via: 'tui', defer: true },
              ) as { error?: string; note?: string; scheduledCron?: string };
              chatLines.push('');
              if (r.error) chatLines.push(C.error(`  ✗ ${r.error}`));
              else if (pick === 'approve') {
                chatLines.push(C.success(`  ✅ 승인 — ${r.note ?? '실행 시작'} (${missionId})`));
                // PR ② — 즉시 집행(비예약)이면 실행 워처: 페이즈 전이·진행바·종결 리포트.
                if (!r.scheduledCron) startMissionRunWatch(missionId);
              } else chatLines.push(C.warning(`  ⏸️ 보류 — ${r.note ?? '기록 유지'} (${missionId})`));
            } else if (pick.startsWith('preset:')) {
              const { HITL_REVISE_PRESETS: presets } = await import('../autopilot/mission-notify.js');
              const preset = presets.find((p) => `preset:${p.action}` === pick);
              if (preset) {
                const { spawnMissionPrepare } = await import('../autopilot/mission-prepare-spawn.js');
                try { spawnMissionPrepare(missionId, { comment: preset.comment }); } catch { /* fail-soft */ }
                chatLines.push('');
                chatLines.push(C.info(`  🔧 정정 반영 중: ${preset.label} — 재분해 후 새 보드를 보여드립니다`));
                startMissionReadyWatch(missionId);
              }
            } else {
              // 직접입력 — 다음 입력 프롬프트에 /mission revise 를 prefill(고쳐서 Enter).
              inputPrefixState.set(`/mission revise ${missionId} `);
              chatLines.push('');
              chatLines.push(C.muted('  ✏️ 정정 코멘트를 입력창에 이어 쓰고 Enter — /mission revise 로 재분해'));
            }
            chatScrollOffset = -1;
            draw();
          })();
        },
        onCancel: () => {
          closeMissionHitlPicker();
          chatLines.push(C.muted(`  (나중에 — 승인: /mission approve ${missionId} · 보류: /mission hold · 정정: /mission revise)`));
          chatScrollOffset = -1;
          draw();
        },
        theme: currentThemeTokens(),
      });
      missionHitlModal = handle;
      attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
      missionHitlModalHandle = display.pushModal(handle.surface);
      draw();
    })();
  };
  // P4 (2026-07-13) — 페이즈 실패 힐 픽커. 텔레그램 3층 탈출구 버튼([🔧 재구현][✂️ 분할]
  // [✏️ 골 정정][⏭️ 건너뛰기] + (권장) 강조)의 TUI flavor — 저장 진단(diagnosis.heal)이
  // 권장을 강조하고, 실행은 P2 의 dispatch 액션(단일 창구·via:'tui'). Esc=나중에(슬래시 안내).
  const openMissionHealPicker = (
    missionId: string,
    phase: { index: number; title: string; diagnosis?: { heal: string; rootCause: string; confidence: string } },
  ): void => {
    if (missionHitlModal) return; // 하단 슬롯 단일 소유자 — 이미 결정 뷰가 떠 있으면 양보(슬래시로 가능).
    void (async () => {
      const rec = phase.diagnosis?.heal;
      const mark = (kind: string, label: string): string => (rec === kind ? `${label} (권장)` : label);
      const items: SearchItem[] = [
        { label: mark('rebuild', '🔧 재구현 — 이 페이즈부터 재시도'), payload: 'rebuild' },
        { label: mark('split', '✂️ 분할 — 단일책임 서브페이즈로 재분해'), payload: 'split' },
        { label: mark('revise', '✏️ 골 정정 — 목표 축소·재분해(코멘트 입력)'), payload: 'revise' },
        { label: mark('skip', '⏭️ 건너뛰기 — 기능 제외·부분 완주'), payload: 'skip' },
      ];
      // 권장 항목을 맨 위로(텔레그램 (권장) 강조 동형 · 픽커는 순서가 곧 강조).
      items.sort((a, b) => Number(String(b.payload) === rec) - Number(String(a.payload) === rec));
      const placement = resolveDecisionPickerPlacement({ height: 10 });
      const handle = createSearchModal({
        id: `mission-heal:${Date.now().toString(36)}`,
        bounds: placement.bounds,
        ...(placement.slot ? { slot: placement.slot } : {}),
        title: `페이즈 실패 — ${phase.index}. ${phase.title.slice(0, 40)}`,
        width: placement.width,
        maxVisible: 5,
        primaryActionLabel: 'select',
        cancelActionLabel: 'later',
        filterable: false,
        onQuery: () => items,
        onAccept: (item) => {
          const pick = String(item.payload);
          closeMissionHitlPicker();
          void (async () => {
            if (pick === 'revise') {
              // 정정 코멘트는 사람 입력 — prefill 후 Enter(기존 HITL 직접입력 경로 동형).
              inputPrefixState.set(`/mission revise ${missionId} `);
              chatLines.push('');
              chatLines.push(C.muted('  ✏️ 정정 코멘트를 입력창에 이어 쓰고 Enter — 실패 컨텍스트는 자동 첨부됩니다'));
            } else {
              const { dispatchAutopilotMissions } = await import('../autopilot/mission-tool.js');
              const r = await dispatchAutopilotMissions({
                action: pick, id: missionId, phase: String(phase.index), via: 'tui',
              }) as { error?: string; note?: string };
              chatLines.push('');
              if (r.error) chatLines.push(C.error(`  ✗ ${r.error}`));
              else {
                chatLines.push(C.success(`  ${r.note ?? `${pick} 시작`}`));
                startMissionRunWatch(missionId); // 힐 후 순회 재개를 계속 관찰.
              }
            }
            chatScrollOffset = -1;
            draw();
          })();
        },
        onCancel: () => {
          closeMissionHitlPicker();
          chatLines.push(C.muted(`  (나중에 — /mission rebuild|split|skip ${missionId} ${phase.index} · 골 정정: /mission revise ${missionId} <코멘트>)`));
          chatScrollOffset = -1;
          draw();
        },
        theme: currentThemeTokens(),
      });
      missionHitlModal = handle;
      attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
      missionHitlModalHandle = display.pushModal(handle.surface);
      draw();
    })();
  };
  const startMissionReadyWatch = (missionId: string): void => {
    if (missionReadyWatchTimers.has(missionId)) return;
    void (async () => {
      const watch = await import('../autopilot/mission-tui-watch.js');
      const baseline = watch.takeMissionReadySnapshot(missionId);
      let state = watch.createMissionWatchState(baseline, Date.now());
      const timer = setInterval(() => {
        const cur = watch.takeMissionReadySnapshot(missionId);
        const r = watch.advanceMissionWatch(state, cur, Date.now());
        state = r.state;
        let readyGoal: string | null = null;
        for (const ev of r.events) {
          if (ev.kind === 'phases') {
            chatLines.push(C.muted(`  🧩 분해 진행 — ${ev.count} 페이즈 (${missionId})`));
          } else if (ev.kind === 'ready') {
            const snap = ev.snapshot;
            readyGoal = snap.goal;
            chatLines.push('');
            chatLines.push(C.accent(`❯ 미션 준비 완료 — ${snap.goal.slice(0, 64)}`));
            // 승인 예고 — 승인하면 무엇이 일어나는지(사람의 승인 판단 근거·dogfood 지적).
            const tierLabel = snap.tier === 'heavy' ? '무거움' : '가벼움';
            const approveEffect = snap.executionModel === 'scheduler'
              ? '승인 시 cron 예약(즉시 실행 아님)'
              : '승인 시 backlog 페이즈 즉시 집행(detached)';
            chatLines.push(C.subtext(`  · 실행모델 ${snap.executionModel || '?'} (${tierLabel}) — ${approveEffect}`));
            for (const line of watch.missionDescriptionDigest(snap.description)) {
              chatLines.push(line.startsWith('  ') ? C.muted(`  ${line}`) : C.subtext(`  · ${line}`));
            }
            for (const line of watch.renderMissionPhaseBoardLines(snap.phases, { goal: snap.goal })) {
              chatLines.push(C.text(`  ${line}`));
            }
            chatLines.push(C.muted(`  검토 후 선택 — 승인 / 보류 / 정정 (Esc=나중에 · 전문: /mission trace ${missionId})`));
          } else if (ev.kind === 'resolved-elsewhere') {
            chatLines.push(C.muted(`  ✔ 미션 ${missionId} 은 다른 서피스에서 이미 해소됨 (status=${ev.status})`));
          } else if (ev.kind === 'gone') {
            chatLines.push(C.muted(`  ✔ 미션 ${missionId} 이 삭제되어 준비 워처를 종료합니다`));
          } else if (ev.kind === 'timeout') {
            chatLines.push(C.warning(`  ⏰ 미션 준비 워처 타임아웃 — /mission trace ${missionId} 로 확인하세요`));
          }
        }
        if (r.events.length > 0) {
          chatScrollOffset = -1;
          draw();
        }
        if (r.done) {
          stopMissionReadyWatch(missionId);
          if (readyGoal !== null) openMissionHitlPicker(missionId, readyGoal);
        }
      }, watch.MISSION_WATCH_INTERVAL_MS);
      missionReadyWatchTimers.set(missionId, timer);
    })();
  };
  // PR ② — approve 후 실행 워처. 페이즈 전이 chat line(텔레그램 notifyPhaseResult
  // 동형) + chatFooter 진행바 + 종결 리포트. 실행은 detached run-mission 그대로 —
  // tox_tasks status 폴링(5s)만. footer 는 MISSION_FOOTER_PREFIX 소유권 판별로
  // thinking 인디케이터와 공존(우리 것일 때만 갱신/해제).
  const missionRunWatchTimers = new Map<string, ReturnType<typeof setInterval>>();
  const stopMissionRunWatch = (missionId: string): void => {
    const t = missionRunWatchTimers.get(missionId);
    if (t) { clearInterval(t); missionRunWatchTimers.delete(missionId); }
  };
  const startMissionRunWatch = (missionId: string): void => {
    if (missionRunWatchTimers.has(missionId)) return;
    void (async () => {
      const watch = await import('../autopilot/mission-tui-watch.js');
      const baseline = watch.takeMissionRunSnapshot(missionId);
      let state = watch.createMissionRunWatchState(baseline, Date.now());
      const setFooter = (text: string | null): void => {
        const cur = chatFooterLine.current;
        if (cur === null || cur.startsWith(watch.MISSION_FOOTER_PREFIX)) chatFooterLine.current = text;
      };
      const timer = setInterval(() => {
        const cur = watch.takeMissionRunSnapshot(missionId);
        const r = watch.advanceMissionRunWatch(state, cur, Date.now());
        state = r.state;
        for (const ev of r.events) {
          if (ev.kind === 'phase') {
            const line = watch.renderMissionRunPhaseLine(ev);
            chatLines.push(ev.phase.status === 'failed' ? C.error(`  ${line}`) : C.text(`  ${line}`));
            // P4 — 실패 즉시 저장 진단 카드(🧭 왜 실패 + 💡 권장 힐·텔레그램 동형) + 힐 픽커.
            if (ev.phase.status === 'failed') {
              for (const dl of watch.renderMissionPhaseDiagnosisLines(ev.phase)) {
                chatLines.push(C.subtext(`     ${dl}`));
              }
              openMissionHealPicker(missionId, ev.phase);
            }
          } else if (ev.kind === 'progress') {
            // 페이즈 내부 변곡점(#3919 미러) — 재시도·예산 상향·opus 폴백 국면을 1줄로.
            chatLines.push(C.muted(`  ⏳ ${ev.phase.index + 1}/${ev.total} ${ev.note.slice(0, 96)}`));
          } else if (ev.kind === 'finished') {
            chatLines.push('');
            chatLines.push(C.accent(`❯ 미션 종결 — ${ev.snapshot.goal.slice(0, 64)}`));
            for (const line of watch.renderMissionRunReportLines(ev.snapshot)) {
              chatLines.push(line.startsWith('❌') ? C.warning(`  ${line}`) : C.text(`  ${line}`));
            }
            chatLines.push(C.muted(`  상세: /mission trace ${missionId}`));
          } else if (ev.kind === 'gone') {
            chatLines.push(C.muted(`  ✔ 미션 ${missionId} 이 삭제되어 실행 워처를 종료합니다`));
          } else if (ev.kind === 'timeout') {
            chatLines.push(C.warning(`  ⏰ 미션 실행 워처 타임아웃(4h) — /mission trace ${missionId} 로 확인하세요`));
          }
        }
        if (r.events.length > 0) {
          setFooter(r.done || !cur ? null : watch.renderMissionRunFooter(cur));
          chatScrollOffset = -1;
          draw();
        }
        if (r.done) {
          setFooter(null);
          stopMissionRunWatch(missionId);
        }
      }, watch.MISSION_RUN_WATCH_INTERVAL_MS);
      missionRunWatchTimers.set(missionId, timer);
      const first = baseline ? watch.renderMissionRunFooter(baseline) : null;
      if (first) { setFooter(first); draw(); }
    })();
  };

  // C-d-3' (2026-07-13) — 턴 중 타이핑 보존 상태 + 에코 페인터 (essential 전용).
  // 스트리밍 사다리가 printable/BS/Enter 를 이 버퍼로 소유하고 composer zone 에
  // 즉시 에코 · 턴 종료 시 loop-head 핸드오프가 prefill/자동제출로 넘긴다.
  // (외곽 스코프 선언 — 스트리밍 디스패처와 메인 키 루프 양쪽에서 참조.)
  const turnTypeaheadRef = { state: createTurnTypeaheadState() };
  // ⭐ `B3` — 큐를 «도는 턴»에 넣으려면 그 턴이 도는 ***ACP 세션 id*** 가 필요하다.
  //   ⛔ `attachedSessionId`(대화 세션)와 «다른 축»이다 — 루프는 ACP 세션으로 스코프를 연다.
  //   ⚠️ 세션은 이 함수 «뒤»에서 만들어지므로 참조로 둔다(호출 시점엔 채워져 있다).
  const acpSessionIdRef: { current: string | null } = { current: null };
  const activeSessionIdForTypeahead = (): string | null => acpSessionIdRef.current;
  const paintTurnTypeaheadEcho = (): void => {
    const { rows: tr, cols: tc } = termSize();
    const pf = currentPromptFrame(tr);
    const row = pf.promptBottomRow;
    if (row < 1) return;
    invalidateRenderCacheRow(row);
    const paint = paintTurnTypeaheadEchoRow({
      frame: pf,
      state: turnTypeaheadRef.state,
      width: tc,
      prompt: C.accent('❯ '),
    });
    if (debug.enabled) {
      debug.log('dashboard.turn-typeahead-prompt', 'typeahead-echo', {
        row,
        text: renderTurnTypeaheadEcho(turnTypeaheadRef.state, Math.max(16, tc - 4)),
        bufferLength: turnTypeaheadRef.state.buffer.length,
        queuedSubmissionCount: turnTypeaheadRef.state.queuedSubmissions.length,
      });
    }
    try { process.stdout.write(paint); } catch { /* fail-soft */ }
  };

  // Use this instead of bare `chatScrollOffset = -1` inside streaming
  // chunk callbacks so a manual scroll during streaming survives the
  // next chunk. Non-streaming code paths keep using `= -1` directly.
  const pinChatTail = () => {
    if (!userScrolledDuringStream) chatScrollOffset = -1;
  };
  // Pinned footer line for the log pane — shows the thinking/streaming
  // indicator below the scrolling log body. Mutated by startPinnedThinking
  // via this ref. `null` = no footer, body uses full log height.
  const chatFooterLine: { current: string | null } = { current: null };
  const disposeEventLoopStallMonitor = startEventLoopStallMonitor({
    getContext: () => ({
      streamingInFlight,
      thinkingMessage: thinkingVerbFromFooter(chatFooterLine.current),
    }),
    log: (category, event, data) => debug.log(category, event, data),
  });
  const disposeEventLoopStallMonitorOnBeforeExit = (): void => disposeDashboardEventLoopMonitor();
  disposeDashboardEventLoopMonitor = (): void => {
    disposeEventLoopStallMonitor();
    process.removeListener('beforeExit', disposeEventLoopStallMonitorOnBeforeExit);
  };
  process.once('beforeExit', disposeEventLoopStallMonitorOnBeforeExit);
  // ── Unified fold controller ────────────────────────────────────
  // One stack manages every fold affordance in the log pane: live
  // batch status during skill execution, plus static folds already
  // committed to chatLines. The runtime helper owns registration;
  // `f` just toggles the most recent target.
  const foldStack = new FoldStack({
    chatLines,
    onAfterToggle: () => {
      // Pin back to tail if the user hadn't scrolled away — expanding
      // a batch tree adds rows, and losing the bottom anchor is
      // disorienting when `f` was supposed to reveal more content.
      chatScrollOffset = -1;
    },
  });
  // The most recent streamed assistant response — kept in both raw and
  // formatted form so Ctrl+Y can copy clean markdown and `r` in log
  // focus can toggle how that turn is rendered. `range` is the slice of
  // chatLines currently occupied by the turn; updated when we re-render.
  let lastAssistantRaw: string | null = null;
  let lastAssistantRange: { start: number; end: number } | null = null;
  let lastAssistantMode: 'rendered' | 'raw' = 'rendered';
  // Log-pane resize remains available when chatOnlyMode is toggled off.
  let logHeightBias = 0;
  // Chat-only mode: 3-pane grid collapses, log pane owns all space above
  // the input. Toggled by /chat or /dashboard. Input loop stays alive
  // across Escape while this is true — feels like a dedicated LLM REPL.
  // Essential layout starts chat-only; /chat and /dashboard still toggle it.
  let chatOnlyMode = true;

  // Debug log — auto-start forensic file capture so every run has a
  // tail-able JSONL trail without the user thinking about it. Default
  // ON; users opt out via `config.debug.file = false` or runtime
  // `/debug file off`. Mirror (chat-inline feed) stays OFF by default
  // to keep the log pane clean — `/debug mirror on` when needed.
  {
    const dbgCfg = getUserConfig().debug;
    // ELANOUS_DEBUG_LEVEL env wins over user-config so a one-shot
    // `ELANOUS_DEBUG_LEVEL=keytrace bun run dev` doesn't require
    // editing config.json + reverting after the dogfood run.
    const envLevel = process.env.ELANOUS_DEBUG_LEVEL?.trim().toLowerCase();
    // ⚠️ 드리프트 수리(2026-07-27) — 여기는 **인스턴스 스코프 파일을 안 읽고 있었다**.
    //   `elanous logs level <lvl>` 이 그 파일에 영속하므로, 데몬(nexus)은 재기동 후 레벨이
    //   유지되는데 **L2 대시보드만 config 로 되돌아갔다**. 같은 리졸버를 쓰게 통일한다.
    //   ⊕ 테스트 우주 바닥도 함께 적용 — 격리로 띄운 L2 TUI 의 관측 해상도가 확보된다.
    const resolved = resolveStartupDebugLevel({
      envLevel,
      scopedLevel: readScopedDebugLevel(),
      configLevel: dbgCfg.level,
      isTestInstance: resolveCurrentInstance().kind === 'test',   // 리졸버 SSOT(리뷰 must-fix)
    });
    const startLevel = resolved.level;
    debug.setLevel(startLevel);
    debug.log('logging.level', 'startup-resolved', {
      level: startLevel, source: resolved.source,
      gateOpen: hotPathGateOpen(startLevel), surface: 'dashboard',
    });
    debug.setFileEnabled(dbgCfg.file);
    // OH9 — 렌더 로그 무음 시드(레벨과 직교). 우선순위:
    //   level.json.render(명시) > config.debug.renderLogs(true=override) >
    //   essential 기본 억제. 부팅 시 렌더 노이즈를 자동으로
    //   끄고, 대표가 diag 로 올려도 진단은 그대로 흐른다.
    debug.setRenderSuppressed(resolveRenderSuppressed({
      scopedRender: readScopedRenderLogs(),
      configRenderLogs: dbgCfg.renderLogs,
      defaultSuppressed: true,
    }));
    // Announce the path so the user knows where to tail. Prefixed
    // with (muted) so it doesn't compete with real chat output.
    if (dbgCfg.file) {
      debugLines.push(C.muted(`[debug] level=${debug.level()} file: ${debug.path()}`));
    } else {
      debugLines.push(C.muted(`[debug] level=${debug.level()} file capture: OFF (config.debug.file=false)`));
    }
  }
  // ⛔⭐⭐ 이 훅이 «그리기»를 부르고, 그리기는 flush 때 `debug.log('dashboard.draw', …)` 를 낸다
  //    ⇒ 「로그 → 그리기 → 로그」 되먹임이 된다. 📏 실측: 8초에 화면 출력 50MB · 키가 안 먹는다.
  //    ⛔ 동기 재진입 가드로는 못 막는다(draw 가 queueMicrotask 로 미루고 바로 돌아온다 — 실측 45MB).
  //    ✅ 그래서 「로그 → 그리기」 방향만 «시간»으로 묶는다 — 상세는 ./mirror-draw-throttle.ts.
  const mirrorDrawThrottle = createMirrorDrawThrottle({
    draw: () => draw(),
    // ⚠️ 이 관측은 «미러를 우회하지 않는다» — 되먹임의 입구와 «같은» debug.log 를 탄다.
    //    ⇒ 그것을 안전하게 만드는 것은 «경로»가 아니라 ***문턱(20건) ⊕ 냉각(5초)***이다:
    //      평상시엔 한 줄도 안 나오고, 폭주 때만 5초에 한 번 나온다 ⇒ 그 한 줄이 다시 부르는 그리기도
    //      스로틀이 다시 묶는다. 📏 이 줄이 보이면 그것이 곧 되먹임 폭주의 이름이다.
    observe: (payload) => { try { debug.log('dashboard.draw', 'mirror-draw-throttled', payload); } catch { /* noop */ } },
  });
  debug.setMirrorHook((line) => {
    debugLines.push(C.muted('[debug] ' + line));
    debugScrollOffset = -1;
    mirrorDrawThrottle.request();
  });
  // --debug launch flag: force both sinks ON and announce it in the log pane.
  if (opts.debug) {
    debug.setFileEnabled(true);
    debug.enable();
    debugLines.push(C.success('[debug] mirror ON (from --debug launch flag)'));
    debugLines.push(C.muted(`[debug] file: ${debug.path()}`));
    debugLines.push(C.muted('[debug] /debug off to silence · Ctrl+Shift+L copies this pane'));
  }
  /**
   * Single source of truth for the vertical split. Called by draw() and
   * every mouse/input handler that needs pane geometry — guarantees they
   * all see the same numbers even when logHeightBias changes.
   *
   * Base split comes from the active dashboard view's row ratios; we
   * only apply `logHeightBias` on top so manual +/− tweaks preserve the
   * actual view model instead of drifting toward an old 60/40 guess.
   */
  const dashboardState = new DashboardStateStore();
  const getFallbackPromptFrame = (termRows: number) =>
    dashboardState.getFallbackPromptFrame(termRows);
  const getLayoutPromptFrame = (termRows: number): PromptFrame =>
    dashboardState.getLayoutPromptFrame(termRows);
  const currentPromptFrame = (termRows = termSize().rows): PromptFrame =>
    dashboardState.getCurrentPromptFrame(termRows);

  /** Rows taken up by everything BELOW the log zone (hud excluded — it
   *  sits between grid and log, and is reserved separately when the
   *  grid is present). Used to compute paneH below and to size the
   *  embedded grid when logEmbedded=true. Must match the number of
   *  rows pushed by zones 'input-divider-upper' through 'dock'. */
  const bottomFixedRows = (inputHeight: number) =>
    bottomFixedRowsForPromptFrame(inputHeight);

  /** Compute paneH (height reserved for the top pane/grid in
   *  non-chat-only, non-embedded modes) given termRows. Factored out
   *  so layoutTools.getCurrentLayout can reuse the same math. */
  const computePaneH = (termRows: number): number => {
    if (effectiveChatOnlyMode()) return 0;
    const promptFrame = getLayoutPromptFrame(termRows);
    const visiblePanes = activeVisiblePaneSet();
    const totalRows = Math.max(8, computePromptFrameLogEndRow(termRows, promptFrame) - 1);
    const basePane = activeBasePaneHeight(totalRows, visiblePanes);
    const baseLog = activeBaseLogHeight(totalRows, visiblePanes, basePane);
    const maxBias = baseLog + basePane - 5 - 3;
    const minBias = -(baseLog - 3);
    const bias = Math.max(minBias, Math.min(maxBias, logHeightBias));
    logHeightBias = bias;
    return basePane - bias;
  };

  /** Mirror of what the composer will allocate to the `log` grow zone.
   *  Used by handleLogPaneKey for scroll step sizing (j/k/^d/^u/pgup/
   *  pgdown). Chat-only and logEmbedded modes don't have a separate
   *  log zone, but the log widget is still sized by the grid — return
   *  a reasonable approximation in those cases. */
  const computeLogH = (termRows: number): number => {
    const promptFrame = getLayoutPromptFrame(termRows);
    if (effectiveChatOnlyMode()) return computePromptFrameGridHeight(termRows, promptFrame);
    const paneH = computePaneH(termRows);
    return computePromptFrameLogViewportHeight(termRows, paneH, promptFrame);
  };
  // ── Plugin host (Phase 2) ──
  const hud = createHud();

  // Reasoning HUD segment — provider-agnostic emoji + label that
  // sits in the top transient HUD row (next to voice / streaming
  // indicators), NOT the bottom status bar. Capability-driven: pill
  // auto-shows for reasoning-capable models (gpt-5 family + claude-4
  // / 3.7) at the model's effective level. Models that don't support
  // reasoning clear the segment so the row stays uncluttered.
  // /reasoning slash + (future) HUD click cycle the level on the
  // same effective state.
  const refreshReasoningHudSegment = (): void => {
    const cfg = getUserConfig();
    if (!modelSupportsReasoning(cfg.llm.provider, cfg.llm.model)) {
      clearSegment(hud, 'reasoning');
      return;
    }
    const level = effectiveReasoningLevel(cfg.llm, cfg.llm.provider, cfg.llm.model);
    setSegment(hud, 'reasoning', C.muted(`reasoning · ${reasoningLevelLabel(level)}`), 4);
  };
  refreshReasoningHudSegment();
  // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M5 — token-gauge +
  // variant HUD segments. Idempotent via panes/hud.ts setSegment dedupe;
  // safe to call on every redraw. Pulls from the same data sources the
  // chat header line uses (inspectActiveProvider · getSessionMetrics ·
  // chat.systemPrompt · chat.rendering.hud).
  const refreshChatHudSegments = (): void => {
    try {
      const cfg = getUserConfig();
      const provider = inspectActiveProvider();
      const metrics = getSessionMetrics();
      const used = metrics.lastContextUsed;
      const max = metrics.lastContextMax;
      setTokenGaugeSegment(hud, used, max, cfg.chat.rendering.hud);
      setVariantBadgeSegment(hud, {
        providerInfo: provider,
        systemPrompt: cfg.chat.systemPrompt,
        // Width hint for compact-vs-full variant text — pick a
        // generous default so PWA always receives the rich variant.
        width: 120,
      });
    } catch { /* swallow — chat HUD segments are best-effort */ }
  };
  refreshChatHudSegments();

  /** Cycle through 'off' → 'low' → 'medium' → 'high' (wrap). Shared
   *  by /reasoning slash command and Alt+R chord. Same semantics:
   *  clears advanced codexReasoning override so the cross-provider
   *  level wins from the next turn. Returns nothing — chatLines + HUD
   *  refresh + draw are side effects. */
  const cycleReasoningLevel = (): void => {
    const curCfg = getUserConfig();
    if (!modelSupportsReasoning(curCfg.llm.provider, curCfg.llm.model)) {
      chatLines.push(C.muted('reasoning: 현재 모델은 reasoning 미지원 (gpt-5 family / claude-4|3.7 만 지원)'));
      chatScrollOffset = -1;
      draw();
      return;
    }
    const cur = effectiveReasoningLevel(curCfg.llm, curCfg.llm.provider, curCfg.llm.model);
    const next = nextReasoningLevel(cur);
    const hadOverride = curCfg.llm.codexReasoning !== undefined;
    const nextLLM = { ...curCfg.llm, reasoningLevel: next, codexReasoning: undefined };
    saveUserConfig({ ...curCfg, llm: nextLLM });
    reloadUserConfig();
    refreshReasoningHudSegment();
    refreshChatHudSegments();
    chatLines.push(`reasoning: ${reasoningLevelLabel(cur)} → ${reasoningLevelLabel(next)}`);
    if (hadOverride) {
      chatLines.push(C.muted('  └─ cleared advanced codexReasoning override'));
    }
    chatScrollOffset = -1;
    draw();
  };
  const setChatOnlyLayout = (next: boolean, opts: { announce?: boolean } = {}): void => {
    chatOnlyMode = next;
    if (chatOnlyMode) setSegment(hud, 'mode', C.info('mode: chat'), 10);
    else clearSegment(hud, 'mode');
    computePaneH(termSize().rows);
    if (!opts.announce) return;
    chatLines.push(chatOnlyMode
      ? C.muted('-- LLM chat mode (/chat or /dashboard to exit) --')
      : C.muted('-- back to dashboard --'));
    chatScrollOffset = -1;
  };
  const toggleChatOnlyLayout = (opts: { announce?: boolean } = {}): void => {
    setChatOnlyLayout(!chatOnlyMode, opts);
  };
  // Mirror chatOnly launch flag into the HUD pill (same style /chat
  // toggle uses) so the user sees "mode: chat" from the first frame.
  if (chatOnlyMode) setSegment(hud, 'mode', C.info('mode: chat'), 10);

  // ── Claude-Code-style status pills (Phase 21) ──
  // Rendered as the BOTTOM-most line of the dashboard, directly above
  // the input prompt — matches Claude Code's layout (see screenshot).
  // We build the string here; draw() writes it to row `termRows - 1`
  // via a direct ansi.moveTo so it doesn't eat into the grid/log
  // layout math (which already reserves inputH rows at the bottom).
  //
  // SP-B — latest BackgroundSurface rollup. Written by the shell-runner
  // boot block via bgSurface.onUpdate; read on every status redraw.
  // Null until the first handle is tracked so we don't render an empty
  // pill on a fresh session.
  let latestShellRollup: { running: number; backgrounded: number } | null = null;
  // The ACP bridge is created later during dashboard boot. Keep status renders
  // safe before then, and bind this reader once the bridge exists.
  let activeAcpRuntimeModel = (): string | undefined => undefined;
  /** Primary pill row — wd · git · provider/model · elapsed.
   *  MX11b — delegates to mouseWiring.buildStatusLine so pill column
   *  bounds are captured as a side effect; the return string is
   *  identical to the pre-MX11b behaviour. */
  const buildStatusLine = (): string => {
    try {
      if (shouldSuppressDashboardBottomArea()) return '';
      const theme = currentThemeTokens();
      const swd = getSessionCwd();
      const gitView = getGitStatusView(swd);
      const gitState: GitSegmentState = gitView.head
        ? {
            branch: gitView.head.branch,
            detachedSha: gitView.head.detached ? gitView.head.sha : null,
            dirtyTotal: gitView.dirty?.total ?? 0,
            ahead: gitView.aheadBehind?.ahead ?? 0,
            behind: gitView.aheadBehind?.behind ?? 0,
          }
        : {};
      const liveShells = listPty().filter(h => h.isAlive()).length;
      pruneConversationPopupHost();
      const conversationSnapshot = conversationPopupHost.snapshot();
      const metrics = getSessionMetrics();
      const hostLabel = workingDir.remote?.host.name ?? hostname();
      return mouseWiring.buildStatusLine({
        swd,
        gitState,
        providerInfo: inspectActiveProvider(undefined, activeAcpRuntimeModel()),
        contextUsedTokens: metrics.lastContextUsed,
        tmuxLabel: tmuxStatusLabel,
        sshLabel: sshStatusLabel,
        host: hostLabel,
        runningAgents: globalAgentRegistry.list().filter((agent) => agent.state === 'running').length,
        controller: process.env.ELANOUS_CONTROLLER?.trim() || undefined,
        shellCount: liveShells,
        shellRollup: latestShellRollup ?? undefined,
        vw: null,
        conversationPopups: {
          liveCount: conversationSnapshot.live.length,
          minimizedCount: conversationSnapshot.minimized.length,
          layoutMode: conversationSnapshot.layoutMode,
        },
        mode: inputCoreActiveMode(),   // A1 — ◆ mode pill (sync/control)
        // experiment/voice-chat-realtime-rebind — voice / dictation /
        // voice-chat indicators are unified into the HUD `voice-state`
        // segment (see hud.setSegment calls in onIndicatorChange and
        // dashboardVoiceChat.onPhaseChange). The status-bar pill is
        // intentionally null so we don't render the same state twice.
        voiceLabel: null,
        theme,
      });
    } catch { return ''; }
  };

  /** Secondary metrics row — CTX bar · total cost · t/s · cache hit %.
   *  Reads from the session-metrics singleton populated by runTurn +
   *  dashboard streaming paths, plus the prompt-cache metrics
   *  singleton populated by onUsage. Renders an all-zero row when no
   *  turns have completed yet (matches Claude Code's "0k/N.Nk"
   *  placeholder). */
  const buildSecondaryStatusLine = (): string => {
    try {
      const m = getSessionMetrics();
      const theme = currentThemeTokens();
      // Prompt-cache summary is ambient — import synchronously from a
      // side-effect-free module; no fetch, no state beyond the session
      // singleton that was already populated by onUsage events.
      const { getSessionSummary } = require('../prompt-cache/metrics.js') as
        typeof import('../prompt-cache/metrics.js');
      const cachePct = getSessionSummary().hitRatePct;
      // PR-S1V.5 — voice cost month-to-date pill. Reads the
      // process-wide tracker that voice-input-bridge.transcribe and
      // the daemon's /v1/voice/transcribe REST handler both write to,
      // so the pill is the canonical view across surfaces. Empty
      // string when nothing was spent this month.
      const voiceMonthly = globalVoiceCostTracker().getMonthSummary().totalUsd;
      const parts = [
        ctxBarSegment(m.lastContextUsed, m.lastContextMax, 24),
        costSegment(m.totalCostUsd, { theme }, m.unpricedTurns),
        voiceCostSegment(voiceMonthly, { theme }),
        speedSegment(m.lastTokensPerSec, { theme }),
        cacheSegment(cachePct, { theme }),
      ];
      return parts.filter(Boolean).join('  ');
    } catch { return ''; }
  };

  let draw: (opts?: { force?: boolean }) => void = () => {};
  let drawNow: (opts?: { force?: boolean }) => void = () => {};
  let drawQueued = false;
  let queuedDrawForce = false;
  let lastDrawDebugAt = 0;
  let repaintPromptAfterRender: (opts?: { force?: boolean }) => void = () => {};
  const displayEvents = createDisplayEventBus();
  const recentTerminalMouseIntents: Array<{
    surfaceId: string;
    paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
    mouseType: DisplayMouseEvent['type'];
    hostInterpretation: 'caret-focus' | 'word-select' | 'context-menu' | 'viewport-scroll' | 'range-select-update' | 'range-select-end' | 'hover';
    row: number;
    col: number;
    transport: 'pty-forward' | 'host-only';
    exposure: TerminalExposureSnapshot;
    interactionPolicy: TerminalInteractionPolicy;
  }> = [];
  const terminalMouseIntentRuntime = createTerminalMouseIntentRuntime({
    isDebugEnabled: () => debug.enabled,
    isKeyTraceEnabled: () => debug.isKeyTraceEnabled(),
    logDebug: (category, event, data) => { debug.log(category, event, data); },
  });
  // PR-2 of multi-platform substrate ROADMAP — register canonical
  // placeholder consumers (caret-focus / word-select / viewport-scroll /
  // context-menu / range-select). Per G2 (single subscriber this arc)
  // the dashboard is the only host that wires the runtime; ACP /
  // Discord / PWA attach via the facade in PR-3, not here. Per G6 each
  // consumer guards on its own capability boolean — gate failures log
  // under terminal.intent.gate-blocked instead of being swallowed.
  //
  // T2 + X1 (Phase 1) — production deps (clipboard write · chat
  // notify · buffer extract · caret context) flow into the consumer
  // hooks via the lazy `pfcMouseActionRuntime` ref. The runtime
  // itself is constructed AFTER clipboardActions exists (line ~3700
  // region); consumers below close over `pfcMouseActionRuntimeRef`
  // and read the live binding at intent-dispatch time.
  const pfcCaretContextStore: CaretContextStore = createCaretContextStore();
  const pfcMouseActionRuntimeRef: { current: PfcMouseActionRuntime | null } = { current: null };
  for (const consumer of createDefaultConsumers({
    caretFocus: {
      logDebug: (category, event, data) => debug.log(category, event, data),
      onCaretFocus: (intent) => pfcMouseActionRuntimeRef.current?.onCaretFocus(intent),
    },
    wordSelect: {
      logDebug: (category, event, data) => debug.log(category, event, data),
      onWordSelect: (intent) => pfcMouseActionRuntimeRef.current?.onWordSelect(intent),
    },
    viewportScroll: {
      logDebug: (category, event, data) => debug.log(category, event, data),
      onViewportScroll: (intent) => pfcMouseActionRuntimeRef.current?.onViewportScroll(intent),
    },
    contextMenu: {
      logDebug: (category, event, data) => debug.log(category, event, data),
      onContextMenu: (intent) => pfcMouseActionRuntimeRef.current?.onContextMenu(intent),
    },
    rangeSelect: {
      logDebug: (category, event, data) => debug.log(category, event, data),
      onRangeSelect: (spec: RangeSelectSpec) => pfcMouseActionRuntimeRef.current?.onRangeSelect(spec),
    },
  })) {
    terminalMouseIntentRuntime.registerConsumer(consumer);
  }
  // PR-3 of multi-platform substrate ROADMAP — terminal host facade
  // owns the canonical publish path. Per G2 (single subscriber this
  // arc) only the dashboard wires through it; ACP / Discord / PWA
  // gateways will attach via facade.subscribePublish in a future arc.
  const terminalHostFacade = createTerminalHostFacade({
    displayEvents,
    isDebugEnabled: () => debug.enabled,
    logDebug: (category, event, data) => debug.log(category, event, data),
  });
  const emitTerminalMouseIntent = (event: {
    surfaceId: string;
    paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
    mouseType: DisplayMouseEvent['type'];
    row: number;
    col: number;
    exposure: TerminalExposureSnapshot;
    interactionPolicy?: TerminalInteractionPolicy;
  }): void => {
    terminalHostFacade.publishMouseIntent(event);
  };
  displayEvents.subscribe('terminal:mouse-intent', (event) => {
    if (event.type !== 'terminal:mouse-intent') return;
    recentTerminalMouseIntents.push({
      surfaceId: event.surfaceId,
      paneKind: event.paneKind,
      mouseType: event.mouseType,
      hostInterpretation: interpretTerminalSurfaceIntent(event),
      row: event.row,
      col: event.col,
      transport: event.transport,
      exposure: event.exposure,
      interactionPolicy: event.interactionPolicy,
    });
    if (recentTerminalMouseIntents.length > 8) recentTerminalMouseIntents.shift();
    terminalMouseIntentRuntime.onDisplayEvent(event);
  });
  // ── T1 (Phase 1) — PFC reverse-feedback runtime ──
  // Subscribes to ShellRegistry posture transitions; when a shell dies
  // with a non-zero exit + recognizable error pattern, surfaces a
  // muted chat-line summary. Per HANDOFF §4.6 backout, gated behind
  // `ELANOUS_PFC_REVERSE_FEEDBACK=0` for emergency disable.
  const pfcReverseFeedbackEnabled = process.env.ELANOUS_PFC_REVERSE_FEEDBACK !== '0';
  const { getShellRegistry: pfcGetShellRegistry } = await import(
    '../shell-runner/registry.js'
  );
  // V1 + X4 (Bundle 2) — late-bound voice + screenshot attachment.
  // Both runtimes depend on resources (auto-tts controller +
  // dispatchScreenshot import) that come up later in boot. The PFC
  // feedback runtime forwards `onNotification` to these refs so V1
  // / X4 attach without re-plumbing the T1 boot order.
  const pfcVoiceRuntimeRef: { current: PfcVoiceRuntime | null } = { current: null };
  const pfcScreenshotAttacherRef: { current: PfcScreenshotAttacher | null } = { current: null };
  const pfcFeedbackRuntime = createDashboardPfcFeedbackRuntime({
    registry: pfcGetShellRegistry(),
    pushChatLine: (line) => { pushChatLine(C.muted(line)); },
    enabled: pfcReverseFeedbackEnabled,
    logDebug: (category, event, data) => debug.log(category, event, data),
    onNotification: (notification) => {
      // X4 attaches first (async screenshot capture inside its own
      // budget), then V1 fires voice on the augmented notification.
      const attacher = pfcScreenshotAttacherRef.current;
      const voice = pfcVoiceRuntimeRef.current;
      if (!attacher && !voice) return;
      const finalize = (final: typeof notification): void => {
        try { voice?.onNotification(final); } catch { /* isolate */ }
      };
      if (attacher) {
        void attacher.attach(notification).then(finalize, () => finalize(notification));
      } else {
        finalize(notification);
      }
    },
  });
  if (debug.enabled) {
    debug.log('pfc.reverse-feedback.boot', 'ready', {
      enabled: pfcFeedbackRuntime.enabled,
    });
  }
  // ── T3 (Phase 2 Bundle 1) — 상태바 라이브 posture 인지 ──
  // Subscribes to ShellRegistry posture stream; HUD shows
  // "🐚 3v 1h" style live counts.  No env gate — always-on lightweight
  // visualization. Disable via runtime.stop() when needed.
  const statusShellPostureRuntime = createStatusShellPostureRuntime({
    registry: pfcGetShellRegistry(),
    setSegment: (key, value, priority) => setSegment(hud, key, value, priority),
    clearSegment: (key) => clearSegment(hud, key),
    debounceMs: 250,
    redraw: () => { try { draw(); } catch { /* noop */ } },
    logDebug: (category, event, data) => debug.log(category, event, data),
  });
  if (debug.enabled) {
    debug.log('status.shell-posture.boot', 'ready', statusShellPostureRuntime.current());
  }
  const blankRows = (height: number, width: number): string[] => (
    Array.from({ length: Math.max(0, height) }, () => ' '.repeat(Math.max(0, width)))
  );
  // IUL Phase M (Bundle 1) → Phase S·a (Bundle 2) → Bundle 3 wiring.
  // Wraps the existing afterRender hook with composeIdentityHooks so
  // every modal-kind surface mount/dispose gets a stable ModalIdentity
  // and fires onPush/onPop. The modal-surface-adapter (registered
  // below after widgetHost discovery) fans those into the global
  // SurfaceRegistry. Existing pushModal callsites unchanged.
  const identityHooks = composeIdentityHooks({
    afterRender: (request) => {
      try { repaintPromptAfterRender({ force: request.force }); } catch { /* noop */ }
    },
  });
  // U4 Bundle B — layer the workspace host wiring on top of modal
  // identity wiring so popup/dialog/terminal modal mounts
  // automatically project into a host-managed workspace set. This is
  // the first real dashboard adoption seam for the workspace
  // substrate; later phases will consume `workspaceHostAPI()` for
  // layout/minimize/dock instead of rebuilding popup registries.
  const workspaceHooks = composeWorkspaceHostHooks(identityHooks);
  const display = new DisplayCoordinator({
    // V3 — propagate request.force through the render chain so a
    // surface-lifecycle forceNext (e.g. from popModal / closeSurface)
    // actually reaches tui.ts::render. Before V3 the lambda dropped
    // the request argument and draw() recomputed force from its own
    // layout-modal key, missing coordinator-owned modal closes.
    onRender: (request) => {
      try { drawNow({ force: request.force }); } catch { /* TUI may have torn down */ }
    },
    hooks: workspaceHooks,
    eventBus: displayEvents,
    // V3 — real termSize + row invalidator so the coordinator can
    // forget rows in the frame cache when a modal surface mounts /
    // unmounts. Without these the V2 wiring is a no-op outside tests.
    termSize: () => termSize(),
    invalidateRow: (row0) => invalidateRenderCacheRow(row0),
    // P2.2.c — coordinator emits cursor escapes to stdout. textInput
    // hands its caret position via opts.cursorSink → display.setCursor;
    // coordinator emits a single ANSI sequence per change after the
    // frame's onRender + afterRender hooks, so the cursor lands ON
    // TOP of the freshly painted rows instead of being clobbered.
    writeCursor: (s) => { try { process.stdout.write(s); } catch { /* TUI torn down */ } },
    // P2.3.a — modal-stack overlay. Pickers (P2.3.b/c) and the
    // agent-roster search modal (P4.1) paint via this path. Lands
    // BEFORE writeCursor so the caret sits on top of the modal.
    writeOverlay: (s) => { try { process.stdout.write(s); } catch { /* TUI torn down */ } },
  });
  const dashboardDisplay = display.handle('dashboard');
  display.renderCoordinatorAPI().on('before-flush', (ev) => {
    const damage = buildDamageFromDirtyEntries(ev.entries, display.layerTreeAPI());
    invalidateRowsForDamage(damage, (row0) => invalidateRenderCacheRow(row0));
  });

  // I.2 (PR #374) · shared KeyInterceptor registry. Every
  // `routeInputEvent` / `routeInputEventAsync` call site in this file
  // spreads this `dispatchInterceptors` into its `DispatchContext`
  // (7 sites: streaming sync / async / pane-ESC async · mx-mouse ·
  // textInput.onMouse · pane idle ESC · textInput.onKey). The
  // DragEscInterceptor (A-8 migration) registers here once · future
  // global policies (Ctrl+Q hard quit · plugin veto) plug in at
  // lower priorities without any dispatch-site edits. See
  // PLAN-compositor-i2-interceptor-registry.md §2 Phase I.2.2.
  const dispatchInterceptors = createInterceptorRegistry();
  dispatchInterceptors.register(createDragEscInterceptor(display.dragManagerAPI()));
  // P8/P9 — shared session registry. Holds every interactive
  // terminal modal (incl. /claude & /codex sessions) so they can
  // be backgrounded, reattached, listed, etc. across the session.
  // Wire the cross-kind event bus → state-store (Phase B). One-time;
  // the helper is idempotent so re-entry during hot-reload is safe.
  const {
    sessionRegistry,
    terminalMatrix,
    broadcastBus,
    channelBus,
  } = bootDashboardTerminalRuntime({
    display,
    displayEvents,
    initElementObservability,
    initDashboardTerminalSessions,
    createTerminalRegistry: (deps) => new TerminalRegistry(deps),
    initTerminalMatrix,
    createBroadcastBus: (registry) => new BroadcastBus(registry),
    getChannelBus,
    wirePersistence,
    initDashboardApprovers,
    termSize,
    getTheme: () => currentThemeTokens(),
  });
  // CE3 — code-edit result subscription. Every successful Edit/Write
  // publishes an EditResult; we render it as a coloured diff block
  // straight into chatLines so the user sees the change as the LLM
  // applies it.
  // WF2 + Wave P3a (presentation) · A4-1 — update_plan board.
  //
  // Wave P3a evolves the WF2 chatLines.push fallback into an
  // in-place splice runtime so repeated update_plan calls REPLACE
  // the previous board instead of pushing duplicates that scroll
  // the chat off-screen. Empty plan → block removed (ephemeral).
  // The companion `src/widgets/plan-board.ts` WidgetDef is the
  // asset for follow-up sidebar/pane wiring.
  {
    const { createPlanBoardRuntime, wirePlanBoardRuntime } =
      await import('./plan-board-runtime.js');
    const planBoardRuntime = createPlanBoardRuntime({
      chatLines,
      pinChatTail,
      draw,
    });
    wirePlanBoardRuntime(planBoardRuntime);
  }
  {
    const { subscribeSourceDelta, renderEditBlockAsync } = await import('../code-edit/index.js');
    subscribeSourceDelta((event) => {
      const diffRendering = getUserConfig().chat.rendering.diff;
      // Async render so CE6 syntax highlighting gets a chance; if
      // shiki isn't installed or the language is unknown the fn
      // silently falls back to the plain path.
      renderEditBlockAsync(event.result, {
        cols: termSize().cols,
        syntax: true,
        colorTier: diffRendering.colorTier,
        headerStyle: diffRendering.headerStyle,
      })
        .then((rows) => {
          for (const row of rows) chatLines.push(row);
          chatScrollOffset = -1;
          try { draw(); } catch { /* TUI torn down */ }
        })
        .catch(() => { /* never let renderer bugs break the tool loop */ });
      // GT2 — forced dirty refresh after a successful Edit/Write.
      // The 5s poll would eventually catch the change; forcing here
      // makes the "*N" suffix tick up within the same frame so the
      // user sees feedback for their own action immediately.
      try {
        refreshGitDirty(getSessionCwd(), { force: true });
      } catch { /* noop */ }
    });
  }
  // WD2 — session working directory subscription. Status bar pills
  // re-render only when draw() is called, so flip a draw() whenever
  // the SWD changes (user Ctrl+W, /wd, or SetWorkingDir tool). The
  // chat-log line is posted by the caller that did the flip; this
  // subscription's only job is to get the pill re-painted.
  subscribeSessionCwd(() => {
    try { draw(); } catch { /* TUI torn down */ }
    // Re-wire the git watcher to the new SWD. The old subscription
    // lives in `gitUnsub` below, which we swap atomically.
    try { wireGitForSwd(); } catch { /* swallow */ }
  });

  // GT2 — live git status for the SWD. Three moving parts:
  //   1. Branch changes (fs.watch on .git/HEAD) → redraw.
  //   2. Dirty probe — async subprocess; throttled by git-fs to 2s.
  //      We schedule an initial probe on wiring + re-probe after
  //      each dashboard redraw completes but throttle swallows the
  //      extras.
  //   3. SWD flip → dispose + re-wire (fresh repo root).
  let gitUnsub: (() => void) | null = null;
  const wireGitForSwd = (): void => {
    if (gitUnsub) { try { gitUnsub(); } catch {} gitUnsub = null; }
    const swd = getSessionCwd();
    gitUnsub = subscribeGitChanges(swd, () => {
      try { draw(); } catch { /* noop */ }
    });
    // Kick off the first dirty probe in the background so the
    // "*N" suffix appears on the first meaningful redraw. Throttle
    // handles repeated calls; we just fire-and-forget.
    try {
      refreshGitDirty(swd, { force: true });
      try { draw(); } catch { /* noop */ }
    } catch { /* noop */ }
  };
  wireGitForSwd();

  // AU7 — seed the prompt bank with the three default fragments
  // (ambiguous / destructive / multi-file). Idempotent: re-boot
  // refreshes content in place, doesn't duplicate. Silent on a
  // clean run; one muted chat line when something was created /
  // updated so the user knows their prompt bank gained shipped
  // fragments.
  try {
    const { seedAu7Fragments } = await import('../prompt-bank/index.js');
    const seedRes = seedAu7Fragments(getPromptBankStore());
    if (seedRes.created > 0 || seedRes.updated > 0) {
      const parts: string[] = [];
      if (seedRes.created > 0) parts.push(`${seedRes.created} created`);
      if (seedRes.updated > 0) parts.push(`${seedRes.updated} updated`);
      chatLines.push(C.muted(`  [prompt-bank] AU7 fragments: ${parts.join(', ')}`));
      chatScrollOffset = -1;
    }
  } catch { /* non-fatal — prompt bank may be disabled / locked */ }

  // Periodic dirty refresh — every 5s the pill picks up any
  // out-of-process modifications (external editor, another PTY,
  // etc.). Throttle inside git-fs prevents back-to-back subprocess
  // spawns when this and a post-Edit refresh overlap.
  const gitDirtyTimer: ReturnType<typeof setInterval> = setInterval(() => {
    try {
      const before = getGitStatusView(getSessionCwd());
      refreshGitDirty(getSessionCwd(), { minIntervalMs: 4_000 });
      const after = getGitStatusView(getSessionCwd());
      if (
        (before.dirty?.total ?? -1) !== (after.dirty?.total ?? -1) ||
        (before.aheadBehind?.ahead ?? -1) !== (after.aheadBehind?.ahead ?? -1)
      ) {
        try { draw(); } catch { /* noop */ }
      }
    } catch { /* noop */ }
  }, 5_000);
  (gitDirtyTimer as unknown as { unref?: () => void }).unref?.();
  // The running module's installed version, not the user's working directory, is the baseline.
  const dashboardCodeRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const versionDir = versionedDashboardInstallDir(dashboardCodeRoot);
  const staleInstallCheck = createStaleInstallCheck({
    codeRoot: dashboardCodeRoot,
    bootCommit: versionDir ? readDashboardBootCommit(versionDir) : undefined,
    readInstalledCommit: readCurrentInstalledCommit,
    now: Date.now,
  });
  if (versionDir) {
    const checkInstall = (): void => {
      const result = staleInstallCheck.check();
      debug.log('dashboard.version', 'install-check', {
        state: result.state, bootCommit: result.bootCommit, installedCommit: result.installedCommit,
      });
      if (staleInstallCheck.shouldNotify(result)) {
        chatLines.push(C.warning(`elanous 가 새 판으로 바뀌었다 (${result.bootCommit!.slice(0, 7)} → ${result.installedCommit!.slice(0, 7)}) · TUI 를 다시 띄워라`));
        chatScrollOffset = -1;
        try { draw(); } catch { /* TUI torn down */ }
      }
    };
    checkInstall();
    const installCheckTimer = setInterval(checkInstall, STALE_INSTALL_CHECK_INTERVAL_MS);
    installCheckTimer.unref?.();
  } else {
    const result = staleInstallCheck.check();
    debug.log('dashboard.version', 'install-check', {
      state: result.state, bootCommit: result.bootCommit, installedCommit: result.installedCommit,
    });
  }
  // Phase T1 — unified terminal matrix. Wraps sessionRegistry during
  // the migration window: spawns flow through `matrix.spawn()` so we
  // get a single `term:<N>` id space, character/transport fields,
  // broadcast-group membership, and a placement-aware list. Existing
  // sessionRegistry.spawn() call sites keep working — the matrix's
  // event subscription adopts sessions spawned via the legacy API.
  // Phase T4 — broadcast bus. Lives alongside the matrix so UI code
  // (per-VW input bar, /term group slashes, LLM TerminalBroadcast*
  // tools) has one place to fan keys + clipboard across groups.
  // Phase T5 — terminal IPC channel bus. Fetched via getChannelBus()
  // here so the /term channel slashes can publish / list.
  // P16 — mirror session metadata to
  // ~/.config/monad-agent/terminal-sessions.json on each lifecycle
  // change (debounced 250ms). /term resume later re-spawns from this.
  // T1-P2 — approval modal wiring. initDashboardApprovers gives
  // createInjectApprover / createPaneInjectApprover / createBroadcastApprover
  // access to the coordinator + termSize so they can pop the shared
  // Yes/No modal for any mutating LLM tool. Keys route through
  // approvalModalRouter (checked above the VW navigation chord in
  // the readKey loop so an approval always wins over chord keys).
  // ToolRuntime migration: wire runtime deps that the dashboard owns.
  //   • TerminalModalInject approver → same dashboard modal as the
  //     direct-dispatch path.
  //   • Bash runtime deps → cwd pulled lazily from getSessionCwd()
  //     at each dispatch (WD5) so Ctrl+W retargets subsequent Bash
  //     calls without re-wiring.
  //   • Shell-primitive approver → createShellApprover() maps the
  //     Yes/No modal to allow-session/deny-once decisions. Every
  //     approval (cache hit, approver answer, fail-closed) lands in
  //     ~/.monad-agent/audit/shell-*.ndjson.
  try {
    const {
      setTerminalInjectApprover, setBashRuntimeDeps,
      setTerminalMouseIntentsGetter,
      setTerminalSessionsGetter,
    } = await import('../tool-runtime/index.js');
    setTerminalInjectApprover(createInjectApprover());
    // WD5 — no explicit cwd pin; bash-runtime pulls SWD at each
    // dispatch so browser Ctrl+W / /wd retargets Bash immediately.
    setBashRuntimeDeps({});

    // ShellRunner registry tracks handles; file capture runs inline/bg commands.
    {
      const { initShellRegistry } = await import('../shell-runner/registry.js');
      const { createFileCaptureEngine } = await import('../shell-runner/file-engine.js');
      const { setShellRunnerDeps } = await import('../shell-runner/dispatch.js');
      const { createBackgroundSurface } = await import('../shell-runner/background-surface.js');
      // The boot seam types the registry as the opaque `ShellRegistryLike`
      // stub (decoupling), while the real `wireShellRunnerSurface` takes a
      // concrete `ShellRegistry`. At runtime `initShellRegistry` returns the
      // real registry, so the stub → concrete bridge is sound; the cast just
      // reconciles the deliberately-opaque DI boundary.
      let wireShellRunnerSurface:
        | ((deps: { shellRegistry: unknown }) => void)
        | undefined;
      try {
        const shellWiringMod = await import('../surface/adapters/shell-runner-wiring.js');
        wireShellRunnerSurface = shellWiringMod.wireShellRunnerSurface as (
          deps: { shellRegistry: unknown },
        ) => void;
      } catch { /* never break boot */ }
      bootDashboardShellRunner({
        createBackgroundSurface,
        initShellRegistry,
        wireShellRunnerSurface,
        createFileCaptureEngine,
        setShellRunnerDeps,
        setLatestShellRollup: (rollup) => { latestShellRollup = rollup; },
      });
    }
    const { setShellApprover } = await import('../shell-primitive/index.js');
    const { createShellApprover, createCodeEditApprover } = await import('./runtime/approvers.js');
    // CE4 — code-edit approver. policy defaults to ask-edit so Edit /
    // Write prompts the user on every call until they switch modes
    // via /code-edit policy unsupervised (or trusted-dirs + seeded
    // list). Without this wiring, Edit would refuse with
    // ApproverMissing under the default policy.
    const { setCodeEditApprover, setPolicy } = await import('../code-edit/index.js');
    // WF1 — AskUserQuestion deps. The tool opens a TUI modal via the
    // shared approvalModalRouter singleton, so one active modal at a
    // time. Surfaces only on dashboard (no skill-run surface).
    const { setAskUserQuestionDeps } = await import('../ask-user-question/index.js');
    // GT4 — worktree runtime deps. Session id keys the
    // ~/.elanous/worktrees/<sid>.json file so two concurrent elanous
    // instances don't step on each other's worktree session state.
    // process.pid is unique per process and stable for the dashboard
    // lifetime — good enough.
    const { setWorktreeRuntimeDeps } = await import('../tool-runtime/index.js');
    bootDashboardApproverRuntimes({
      setShellApprover,
      createShellApprover,
      setCodeEditApprover,
      createCodeEditApprover,
      setAskUserQuestionDeps,
      setWorktreeRuntimeDeps,
      coordinator: display,
      termSize,
      sessionId: () => String(process.pid),
    });
    // self-implement P2 (2026-07-19) — PR open HITL 게이트를 배선. requestConfirmation
    // 이 대표의 wired 채널(Telegram/Discord/Pushcut/terminal)을 레이스 → 첫 응답으로 결정.
    // ★fail-closed: 미주입/타임아웃 기본 reject(PR 은 outward-facing, money 경로처럼 failOpen 금지).
    const { setSelfImplementApprover, setSelfImplementRuntimeDeps } = await import('../tool-runtime/index.js');
    const { requestConfirmation: requestSelfImplementConfirm } = await import('../hitl/confirm.js');
    const { resolvePrApprovalDelivery, buildPrApprovalRequest } = await import('../hitl/pr-approval-delivery.js');
    // ⭐ 승인 카드를 어느 표면으로 보낼지 — 기본 'terminal'(그 런을 시작한 표면).
    //   ⚠️ 부팅 시 한 번 읽는다: 승인 시점마다 디스크를 때리지 않기 위함이고,
    //   바꾸려면 TUI 를 다시 띄운다(이 값은 세션 수명 동안 고정이라는 계약).
    const selfImplPrDelivery = resolvePrApprovalDelivery(() => getUserConfig());
    setSelfImplementApprover(async (summary) => {
      // ⭐ 요청 조립을 순수 함수에 맡긴다(3R 리뷰 must-fix) — `delivery` 가 빠지면
      //   `requestConfirmation` 이 wired 채널 전부를 레이스하고, 그것이 대표 아이폰에
      //   카드가 뜬 경로다. 그 계약을 테스트가 **같은 함수로** 지킨다.
      const res = await requestSelfImplementConfirm(buildPrApprovalRequest({
        branch: summary.branch,
        implSummary: summary.implSummary,
        ...(summary.gateLog ? { gateLog: summary.gateLog } : {}),
        delivery: selfImplPrDelivery,
      }));
      return res.answer;
    });
    // self-implement 중첩 자식 격리 배선 (2026-07-26) — 현재 인스턴스의 config-dir/state-dir 를
    // 자식 헤드리스 elanous 에 전파한다. 미배선이면 TUI 자연어 SelfImplement 경로가 부모 격리를
    // 물려받지 못해 자식이 prod ~/.elanous 로 뜬다(격리 테스트 중 중첩이 운영 스토어 오염). CLI 경로
    // (dev-pipeline)는 이미 부모 값을 미러링하므로 이 배선이 TUI 자연어 경로의 대칭 구멍을 닫는다.
    const { childInstanceScope } = await import('../instance/child-scope.js');
    setSelfImplementRuntimeDeps(childInstanceScope());
    // GT6 — drop session files whose pid is no longer alive. Files
    // from crashed sessions are harmless (never re-referenced) but
    // accumulate over time; cleaning at boot keeps the dir small.
    // Silent on a clean run; surfaces a single muted line when it
    // actually reclaims something.
    try {
      const { cleanupStaleWorktreeSessions } = await import('../git-fs/worktree.js');
      cleanupDashboardWorktreeSessions({
        cleanupStaleWorktreeSessions,
        onRemoved: (removed) => {
          pushDebugLine(C.muted(`  [git] cleaned ${removed} stale worktree session file${removed === 1 ? '' : 's'}`));
          chatScrollOffset = -1;
        },
      });
    } catch { /* non-fatal */ }
    // WF4/WF6 — ExitPlanMode TUI deps + /compact handoff hook. On
    // "Save + new session" the hook compacts the conversation,
    // appends the summary to MEMORY.md, clears chat.history (keeping
    // the system message), and seeds the next turn with the plan
    // body so the fresh session hits the ground running.
    const { setExitPlanModeDeps } = await import('../plan-mode/index.js');
    const onPlanModeHandoff = createDashboardPlanModeHandoff({
      compactConversation: async (history, opts) => {
        const { compactConversation } = await import('../compact/index.js');
        return compactConversation(history, opts).catch(() => null);
      },
      appendCompactToMemory: async (summary) => {
        const { appendCompactToMemory } = await import('../compact/index.js');
        return appendCompactToMemory(summary);
      },
      chatHistory: chat.history as unknown as LLMMessage[],
      resetChatLines: () => { chatLines.length = 0; },
      clearAttachmentRows: () => { attachmentRowMap.clear(); },
      clearLogSearch,
      pushSuccessLine: (message) => { pushDebugLine(C.success(message)); },
      pushWarningLine: (message) => { pushDebugLine(C.warning(message)); },
      setChatScrollBottom: () => { chatScrollOffset = -1; },
      draw: () => { draw(); },
    });
    bootDashboardPlanModeRuntime({
      setExitPlanModeDeps,
      coordinator: display,
      termSize,
      onHandoff: onPlanModeHandoff,
    });
    // --yolo CLI flag — trust-by-inspection mode. Caller asserted "I
    // will eyeball every diff in the log pane and recover via git if
    // it goes wrong." Announce loudly so the state isn't silent.
    bootDashboardYoloPolicy({
      enabled: !!opts.yolo,
      setPolicy,
      pushWarningLine: (message) => { pushDebugLine(C.warning(message)); },
      pushMutedLine: (message) => { pushDebugLine(C.muted(message)); },
    });
    // State snapshot: wire sessionRegistry so GetDashboardState sees
    // coding-agent modals and /term shells alongside windows + PTYs.
    setTerminalSessionsGetter(() => {
      try {
        return sessionRegistry.list().map(s => ({
          id: s.id,
          title: s.title,
          state: s.state,
          exposure: classifyTerminalSessionExposure(s.state),
        }));
      } catch { return []; }
    });
    setTerminalMouseIntentsGetter(() => [...recentTerminalMouseIntents]);
    // Phase C — wire context.* tools without virtual-window state.
    const { setContextRuntimeDeps } = await import('../tool-runtime/index.js');
    // Surface-unification v2.2 V2.2-5 (2026-05-11) — scheduler store
    // wire retired together with `context.jobs.list` LLM tool.
    bootDashboardContextRuntime({
      setContextRuntimeDeps,
      // WD7 — context runtime cwd follows SWD.
      cwd: getSessionCwd(),
      listTerminalSessions: () => sessionRegistry.list(),
      mapTerminalSession: (s) => ({ id: s.id, title: s.title, state: s.state }),
    });
  } catch { /* non-fatal — runtimes surface their own errors on dispatch */ }
  // T1-P3 — HITL callback listener. Starts an HTTP listener on
  // 127.0.0.1:$ELANOUS_HITL_PORT (default 17645) so the iOS Shortcut
  // `monad-confirm-{yes,no}` can POST the user's answer back. Also
  // registers the Pushcut ConfirmChannel as a default so
  // requestConfirmation() / HitlConfirm tool reaches the iPhone.
  // Fire-and-forget: a listener start failure warns but doesn't
  // block dashboard init (HITL degrades to terminal-only / no-op).
  bootDashboardHitl({
    enabled: process.env['ELANOUS_HITL_DISABLE'] !== '1',
    initDashboardHitl,
    stopDashboardHitl,
    debugLog: (scope, message) => { debug.log(scope, message); },
    isPushcutConfigured: () => {
      try { return getPushcutClient().configured; } catch { return false; }
    },
    pushWarningLine: (message) => { chatLines.push(C.warning(message)); },
    draw: () => { draw(); },
    registerBeforeExit: (cb) => { process.once('beforeExit', cb); },
    warnConsole: (message) => { console.warn(message); },
  });
  await bootDashboardEagerTools({
    initializers: [
      // H6 P1 · multi-agent budget tracker. Registers four fetchers
      // (codex · claude · gemini · local-llm) into the module-level
      // UsageStore singleton so `BudgetStatus` / `/budget` have a populated
      // provider list from the first call. No network here — fetchers run
      // lazily when the user (or an LLM tool) requests `refresh: true`.
      {
        label: 'budget',
        run: async () => {
          const { initBudgetStore } = await import('../budget/init.js');
          initBudgetStore();
        },
      },
      // H6 P3 · Budget-aware policy router (Bundle 1 · recommend-only).
      // Wires the module-level PolicyRouter singleton to the UsageStore +
      // OverrideStore so `RouteToModel` / `RouteExplain` / `/route` can
      // answer decide() calls immediately.
      {
        label: 'policy',
        run: async () => {
          const { initPolicyRouter } = await import('../policy/init.js');
          initPolicyRouter();
        },
      },
      // H6 P4 · agent-room bootstrap (eager-touch so the default registry
      // singleton is alive before the first slash or LLM tool call).
      {
        label: 'agent-room',
        run: async () => {
          const { initAgentRoomTools } = await import('../skills/tools/agent-room.js');
          initAgentRoomTools();
        },
      },
      // H6 P5 · agent-reply bootstrap (no-op · lazy dispatch).
      {
        label: 'agent-reply',
        run: async () => {
          const { initAgentReplyTools } = await import('../skills/tools/agent-reply.js');
          initAgentReplyTools();
        },
      },
      // H6 P6 · capture source registry bootstrap.
      {
        label: 'capture-source',
        run: async () => {
          const { initCaptureSourceTools } = await import('../skills/tools/capture-source.js');
          initCaptureSourceTools();
        },
      },
      // H6 P7 · capture inject bootstrap.
      {
        label: 'capture-inject',
        run: async () => {
          const { initCaptureInjectTools } = await import('../skills/tools/capture-inject.js');
          initCaptureInjectTools();
        },
      },
      // H6 P2 Bundle 1 · local-llm Manager bootstrap.
      {
        label: 'llm-manager',
        run: async () => {
          const { initLlmManagerTools } = await import('../skills/tools/llm-manager.js');
          initLlmManagerTools();
        },
      },
    ],
    debugLog: (scope, area, details) => {
      debug.log(scope, area, details);
    },
  });
  // PaneVisualStateStore serves dashboard pane tools.
  const paneVisualStateStore = createVisualStateStore();
  let browserPaneRegistry!: BrowserPaneRegistry;
  let previewPaneRegistry!: PreviewPaneRegistry;

  // Browser-pane help (`~`) uses the transient modal primitive.
  const browserHelpRuntime = createBrowserHelpRuntime({
    termSize,
    keyLabel: (key, desc) => `  ${C.key(pad(key, 14))} ${C.text(desc)}`,
    sectionLabel: (title) => C.bold(title),
    muted: (text) => C.muted(text),
    showHelpModal: ({ title, lines, termCols, termRows, ttlMs, group }) => {
      showTransientTerminalModal({
        title,
        lines,
        coordinator: display,
        termCols,
        termRows,
        ttlMs,
        group,
      });
    },
  });
  // Refresh context runtime deps after the dashboard session registry is ready.
  try {
    const { setContextRuntimeDeps } = await import('../tool-runtime/index.js');
    bootDashboardContextWindowRuntime({
      setContextRuntimeDeps,
      // WD7 — context runtime cwd follows SWD.
      cwd: getSessionCwd(),
      getTerminalSessions: () => sessionRegistry.list().map((s) => ({
        id: s.id,
        title: s.title,
        state: s.state,
      })),
    });
  } catch { /* non-fatal */ }

  // TR-P3: capture a pane's currently-rendered output so it can be
  // popped as a transient modal body. Best-effort — unknown panes
  // yield a placeholder so the modal still opens.
  const captureDeferredPane = (pane: PaneFocus): string => {
    switch (pane) {
      case 'log':
        return chatLines.slice(-200).join('\n');
      case 'scratch':
        return scratchLines.length > 0 ? scratchLines.join('\n') : '(scratch empty)';
      case 'preview':
        return dockedPreview.previewLines.length > 0
          ? dockedPreview.previewLines.join('\n')
          : '(preview empty)';
      case 'obsidian':
        return obsidianDir.entries.slice(0, 50).map(e => (e.isDir ? '📁 ' : '  ') + e.name).join('\n');
      case 'browser':
        return workingDir.entries.slice(0, 50).map(e => (e.isDir ? '📁 ' : '  ') + e.name).join('\n');
      default:
        return `[${pane}] — pane modal capture not wired for this kind yet`;
    }
  };
  let pluginHost: PluginHost;
  let lastThemeLoadError = '';
  let iulThemePreviewOverride: string | null = null;
  let lastHostChromePolicyDebugKey = '';
  const observeEssentialFrameCursor = createDashboardEssentialCursorObserver({
    isDebugEnabled: () => debug.enabled,
    log: (category, event, data) => { debug.log(category, event, data); },
  });
  // FU G (IDX-6 Phase 3/4) — theme resolution delegates to
  // resolveActiveTheme, which adds preset-registry lookup ahead of
  // the plugin path. `/theme switch <preset>` thus becomes effective
  // the next time this function runs, no restart required.
  const currentThemeTokens = () => {
    const raw = iulThemePreviewOverride
      ? { ...(getUserConfig().dashboard.theme as object ?? {}), active: iulThemePreviewOverride }
      : getUserConfig().dashboard.theme;
    return resolveActiveTheme({
      raw,
      loadPlugin: (id) => pluginHost?.loadThemeTokens(id) ?? null,
      onPluginError: (message) => {
        if (lastThemeLoadError !== message) {
          lastThemeLoadError = message;
          chatLines.push(C.warning(message));
          chatScrollOffset = -1;
        }
      },
    });
  };
  // IDX-6 Phase 6 — route theme-icons() through the dashboard's live
  // theme getter. Any module that imports `icon('error')` etc. now
  // picks up the active preset + respects ELANOUS_ASCII_ICONS. Safe to
  // call multiple times; replaces the getter each time.
  configureThemeIconsGetter(() => currentThemeTokens());
  // IDX-F8b — route mountViewAsModalSurface's backdrop resolver
  // through the same live theme getter so every dialog / popup / menu
  // / tooltip mounted in the session picks up the pastel backdrop
  // without individual builders having to thread `theme` into their
  // spec. `vw` and `execution` tiers still skip via BACKDROP_SKIP_TIERS.
  configureModalAdapterTheme(() => currentThemeTokens());
  const transientOverlayHost = createTransientOverlayHost();
  const requestDashboardRender = (pane?: string) => {
    dashboardDisplay.requestRender({
      region: pane ? `pane:${pane}` : 'all',
    });
  };
  let refreshDashboardViewsFromPlugins: () => void = () => {};
  const pluginExecutionRuntime = createDashboardPluginExecutionRuntime({
    computePreviewTerminalDims: () => computePreviewTerminalDims(),
    display: display.handle('plugin:host'),
    focusManager: display.focusManagerAPI(),
    displayEvents,
    requestDashboardRender,
    pushChatLine: (line) => { chatLines.push(line); },
    clearChatScroll: () => { chatScrollOffset = -1; },
    onExecutionSurfaceExit: (id) => {
      if (activeExecutionSurfaceId === id) activeExecutionSurfaceId = null;
      executionSurfaces.delete(id);
    },
    registerExecutionSurface: (handle) => {
      executionSurfaces.set(handle.id, handle);
    },
    setActiveExecutionSurfaceId: (id) => { activeExecutionSurfaceId = id; },
    setPreviewTerminalDims: (dims) => { previewTerminalDims = dims; },
    setWorkingFocusPreview: () => { setWorkingFocus('preview', 'execution-surface-start'); },
    formatExecutionExitLine: (id, code) => C.muted(`Execution ${id} exited (${code}).`),
  });
  const pluginThemeControl = createDashboardPluginThemeControl({
    getDashboardThemeConfig: () => getUserConfig().dashboard.theme,
    setDashboardThemeActive: (id) => {
      const cfg = getUserConfig();
      cfg.dashboard.theme = { ...(cfg.dashboard.theme as object ?? {}), active: id } as never;
      saveUserConfig(cfg);
    },
    currentThemeTokens,
    getThemeContributions: () => pluginHost?.activeThemeContributions() ?? [],
    requestDashboardRender: () => { requestDashboardRender(); },
  });
  const pluginPaneRuntime = createDashboardPluginPaneRuntime({
    paneStateSnapshot: () => paneStateSnapshot(),
    activePaneIds: () => panesForDashboardView(activeViewDef()),
    closeDashboardPane: (pane) => closeDashboardPane(pane),
    openDashboardPane: (pane) => openDashboardPane(pane),
    openDashboardPaneModal: (pane) => openDashboardPaneModal(pane),
    setDashboardPaneOmitOrder: (panes) => setDashboardPaneOmitOrder(panes),
  });
  const pluginBaseRuntime = createDashboardPluginBaseRuntime({
    pushChatLine: (line) => { chatLines.push(line); },
    clearChatScroll: () => { chatScrollOffset = -1; },
    setHudSegment: (key, value, priority) => { setSegment(hud, key, value, priority); },
    clearHudSegment: (key) => { clearSegment(hud, key); },
    requestDashboardRender,
    submitDashboardText: (text) => { dispatchDashboardSubmitText?.(text); },
  });

  pluginHost = new PluginHost({
    ...pluginBaseRuntime,
    display: display.handle('plugin:host'),
    displayEvents,
    // F-3b (2026-04-21) — wire the FocusManager primitive so plugin
    // context `focus.{set,cycle,current}` bypasses the DisplayHandle
    // wrappers and hits the primitive directly. See
    // 내부 문서 `PLAN-f3-caller-migration` §2.2 Phase F-3b.
    focusManager: display.focusManagerAPI(),
    theme: currentThemeTokens,
    themeControl: pluginThemeControl,
    execution: pluginExecutionRuntime,
    panes: pluginPaneRuntime,
    focusPane: () => { /* plugin-owned pane focus wiring lands in Phase 4 */ },
  });
  try {
    await pluginHost.discover();
  } catch (err: any) {
    pushDebugLine(C.warning(`plugin discovery failed: ${err?.message || err}`));
  }

  // ── Widget host (Phase W3) ──
  // Four inline widget types wrap the existing browse-mode render
  // closures. This lets the grid render go through renderLayout
  // without migrating skills/files/preview away from their current
  // state-closure shape — W4 takes the next step.
  //
  // Arc F — animation frame tickler. `framePending` dedups concurrent
  // scheduleFrame calls (a burst of tween() calls during a single
  // render only queues one setTimeout). The tail recursion inside the
  // timeout re-arms the loop while animations stay active and stops
  // once `anyActiveAnimation()` flips false.
  let widgetHost: WidgetHost;
  const widgetHostRuntime = createDashboardWidgetHostRuntime({
    pushDebugLine,
    clearChatScroll: () => { chatScrollOffset = -1; },
    requestDashboardRender: () => { requestDashboardRender(); },
    display: display.handle('tool:widget-host'),
    getWidgetHost: () => widgetHost,
    getWidgetSurfaceDescriptor: (id) => getSurfaceRegistry().get({
      kind: 'widget', widgetId: id,
    }),
  });
  widgetHost = new WidgetHost(widgetHostRuntime);
  await bootDashboardWidgetHost({
    widgetHost,
    pluginHost,
    pushDebugLine,
  });

  // IUL Bundle 3 — wire SurfaceRegistry adapters against the global
  // registry. modal-surface-adapter consumes the Phase M onPush/onPop
  // events that composeIdentityHooks above produces. widget-surface-
  // adapter consumes WidgetHost.onMount/onDispose. Both are idempotent
  // — re-entering showDashboard (test path) will re-wire fresh
  // disposers; the previous ones are GC'd along with the prior
  // coordinator. SurfaceRegistry persists across re-entries so a
  // long-lived debug session still sees the latest surface set.
  try {
    const surfaceRegistry = getSurfaceRegistry();
    wireDashboardSurfaceRegistry({
      surfaceRegistry,
      widgetHost,
    });
  } catch { /* never break boot */ }

  // IUL Bundle 4T (terminal-team) — Phase L subset (read-only LLM tools).
  // GetUIState / DescribeSurface / ObserveSurface read the live
  // SurfaceRegistry that the wiring above populates. widget-host is
  // passed READ-ONLY for DescribeSurface(widget) — the runtime only
  // calls existing get/defFor/listInstanceIds methods.
  try {
    registerDashboardWidgetRuntimes({
      widgetHost,
      paneVisualStateStore,
      getProvider: () => getProviderForConfig(getUserConfig()),
    });
  } catch { /* never break boot */ }

  // Presentation P5c-a (widget-team) — load the `scenarios/*.yaml`
  // catalog once at boot + register the 4 scenario LLM tools
  // (ListScenarios / RunScenario / GetScenarioSchema /
  // ValidateScenarioYaml). `onMount` spawns each top-level WidgetSpec
  // into the widget-host — nested `children` are not spawned here
  // (WidgetHost.spawn is flat; container-style children decoded by
  // P3 but live composite mounting is deferred to a future bundle).
  // `last-wins` duplicate policy matches the default in catalog.ts ·
  // plugins may override a built-in scenario of the same id.
  const scenarioCatalog = await loadDashboardScenarioCatalog(
    join(process.cwd(), 'scenarios'),
  );
  try {
    registerDashboardScenarioRuntimes({
      scenarioCatalog,
      spawnWidget: (spec) => widgetHost.spawn(spec),
      disposeWidget: (id) => { widgetHost.dispose(id); },
      getDashboardModals: () => dashboardModals,
      setDashboardModals: (modals) => { dashboardModals = [...modals]; },
      getPluginLayout: () => pluginHost.activeLayout(),
      setPluginLayout: (layout) => {
        const active = pluginHost.active();
        if (active) active.layout = layout;
      },
    });
  } catch { /* never break boot */ }

  // VW-term-infra Bundle B-2 — Phase 6 ArtifactStore foundation.
  // Unified artifact persistence (`~/.elanous/artifacts/<kind>/`) with
  // ListArtifacts LLM tool. Consumer migration (Bundle B-3) threads
  // this singleton through recording-runtimes; future bundles add
  // layout persistence / BlockStore / captures.
  // Chord hint `^B a` reserved for the eventual artifact browser.
  //
  // Bundle B-4 (P6-3) · legacy providers — pre-migration recordings
  // (Bundle 8T `rec-*.cast` · widget-team 8W `widget-timeline-*.cast`)
  // under `~/.elanous/timelines/` are surfaced in `ListArtifacts` with
  // synthesized meta · LLM sees one unified view across old + new paths.
  const artifactStore = createArtifactStore({
    legacyProviders: [
      createLegacyTimelineProvider({ dir: defaultTimelineBaseDir() }),
    ],
  });
  try {
    registerDashboardPaneArtifactRuntimes({
      artifactStore,
      widgetHost,
      paneVisualStateStore,
    });
  } catch { /* never break boot */ }
  const clipboardActions = createDashboardClipboardActions({
    getChatLines: () => chatLines,
    findBlock,
    pushDebugLine,
    pushChatLine: (line) => { chatLines.push(line); },
    clearChatScroll: () => { chatScrollOffset = -1; },
    hud: {
      setCopied: (text) => { setSegment(hud, 'copied', text, 5); },
      clearCopied: () => { clearSegment(hud, 'copied'); },
    },
    draw: () => { draw(); },
  });

  // Copy a block (or the whole log) to the clipboard with HUD feedback.
  const { copyLogBlock, copyRootPathToLog } = clipboardActions;

  // Copy a browser pane's cursor-entry absolute path (file → file
  // path, directory → directory path) with a persistent log line and
  // a HUD flash. Shared across all browser panes' `c` / `ㅊ` binding
  // so behavior + messaging stays consistent whether the source is
  // Working / Obsidian / Skill / Skill-File.

  // ── SyncActions bridge ──
  // Plugin slash handlers call these back into dashboard for the parts
  // they can't own (actually running sync/diff + log feedback). Plugin
  // state.actions is wired in enterSyncMode below.
  const syncActions = {
    confirm: async (skills: string[], servers: string[], services: string[], modeId: string) => {
      if (modeId === 'diff') await runDiffInline(skills, servers, services);
      else await runSyncInline(skills, servers, services, modeId);
    },
    exit: () => { exitSyncMode(); },
    notify: (msg: string) => {
      pushDebugLine(C.warning(`${ICONS.warning} ${msg}`));
    },
    markListsDirty: () => {
      const state = syncPluginState();
      if (!state) return;
      state.allSkillNames = getLocalSkills();
      const skillsW = syncListWidget(0);
      if (skillsW) skillsW.state.items = ['* ALL', ...state.allSkillNames];
    },
  };

  // Sync mode = "the sync plugin is active". enter activates the
  // plugin (buildLayout spawns widgets); after activate, dashboard
  // populates plugin state with allSkillNames + actions bridge and
  // pre-selects every service (matches pre-W4.3 behavior).
  //
  // Returns a promise so callers can `await` activation — e.g.
  // `/plugin activate sync` needs to know activation is complete
  // before exiting the input loop.
  const enterSyncMode = async (): Promise<void> => {
    try {
      await pluginHost.activate('sync');
      refreshDashboardViewsFromPlugins();
      const state = syncPluginState();
      if (!state) return;
      state.allSkillNames = getLocalSkills();
      state.actions = syncActions;
      const skillsW = syncListWidget(0);
      if (skillsW) skillsW.state.items = ['* ALL', ...state.allSkillNames];
      const serversW = syncListWidget(1);
      if (serversW) serversW.state.items = ['* ALL', ...serversW.state.items.filter(n => n !== '* ALL')];
      const servicesW = syncListWidget(2);
      if (servicesW) {
        const realServices = servicesW.state.items.filter(n => n !== '* ALL');
        servicesW.state.items = ['* ALL', ...realServices];
        for (const s of realServices) servicesW.state.selected.add(s);
      }
      // Arc A — sync was retired from ModeManager; the PluginHost
      // activate() above is the source of truth. No ModeManager
      // transition is required here.
    } catch (err: any) {
      pushDebugLine(C.warning(`sync activate failed: ${err?.message || err}`));
      chatScrollOffset = -1;
    }
  };
  const exitSyncMode = async (): Promise<void> => {
    try { await pluginHost.deactivate(); } catch { /* ok */ }
    refreshDashboardViewsFromPlugins();
    // Arc A — exiting sync is now a pluginHost.deactivate() no-op for
    // ModeManager (sync was never a ModeManager mode after Arc A).
  };

  // P5 — register the mode-enter actions + default chord bindings so
  // `Ctrl+B s` from input focus enters sync, `Ctrl+B c` enters
  // control, `Ctrl+B g` returns to general. The `allowOverwrite`
  // flag is critical because this closure may re-run on hot-reload
  // scenarios (tests, plugin reinit) — the registry should be idempotent.
  // A2 — forward-declared toast hook. mouseWiring is initialized
  // later in this closure (~line 5690); action handlers invoke this
  // at CALL time (after user presses the chord), by which point the
  // sink is wired. Default no-op keeps test harnesses that exercise
  // registerAction without constructing the full dashboard safe.
  let pushModeToast: (text: string, kind?: 'success' | 'info' | 'warning') => void = () => {};
  inputCoreRegisterAction({
    id: 'mode.enter.sync',
    description: 'Enter sync mode.',
    handler: () => { void enterSyncMode(); pushModeToast('→ sync mode', 'success'); },
    allowOverwrite: true,
  });
  inputCoreRegisterAction({
    id: 'mode.enter.control',
    description: 'Enter control mode.',
    handler: () => {
      enterSessionControlMode(chatModeState);
      void inputCoreSetMode(resolveSessionInputModeFromChatMode({ chatModeState }));
      chatLines.push(C.error('-- CONTROL MODE —') + C.text(' (via ^B c chord)'));
      chatScrollOffset = -1;
      draw();
      pushModeToast('→ control mode', 'success');
    },
    allowOverwrite: true,
  });
  inputCoreRegisterAction({
    id: 'mode.enter.general',
    description: 'Return to general mode (exit sync / control if active).',
    handler: () => {
      if (isSessionControlActive(chatModeState)) {
        exitSessionControlMode(chatModeState);
        chatLines.push(C.muted('-- back to general mode --'));
        chatScrollOffset = -1;
        draw();
      }
      if (pluginHost.active()?.name === 'sync') {
        void exitSyncMode();
      }
      void inputCoreSetMode(resolveSessionInputModeFromChatMode({ chatModeState }));
      pushModeToast('→ general mode', 'info');
    },
    allowOverwrite: true,
  });
  inputCoreAddDefaultBinding({ matcher: 'ctrl+x s', actionId: 'mode.enter.sync' });
  inputCoreAddDefaultBinding({ matcher: 'ctrl+x c', actionId: 'mode.enter.control' });
  inputCoreAddDefaultBinding({ matcher: 'ctrl+x g', actionId: 'mode.enter.general' });

  initTui(true);

  // ── Working-dir browser glyphs (shared between the list widget and
  //    the preview pane so a folder looks identical in both). The
  //    list widget colors the icon per row in iconForEntry; the
  //    preview re-uses these literals when rendering folder listings.
  const FOLDER_ICON = '\u{F024B}'; // nf-md-folder
  const PARENT_ICON = '\u{F0259}'; // nf-md-folder_upload (left arrow)

  // ── Phase 4a-v3: working-dir preview auto-refresh (colorized) ──
  // Mirrors the skill-workspace preview-pane look: header line with
  // file/folder icon + colored name, blank, then either a syntax-
  // colored body (files) or a colored child listing (folders). All
  // lines are ANSI-tinted; the markdown widget renders them with
  // preformatted=true so colors survive.
  // Which browser drives the preview right now. The rule is view-
  // aware: Obsidian is only meaningful in V2, Skill in V3; `smart`
  // tracks the last-focused browser and falls back to Working when
  // no browser has been visited yet. Fixed sources that don't apply
  // to the current view get coerced to `working` so the pane never
  // renders from an invalid source.
  const effectivePreviewBrowser = (): 'working' | 'obsidian' | 'skill' => {
    return resolveEffectivePreviewBrowser(
      dockedPreview.sourceMode,
      workingDir.view,
      dockedPreview.lastBrowserFocus,
    );
  };

  // Preview refresh sequence — every call bumps this so in-flight
  // async renders (glow markdown, KGP image) can detect they're
  // stale and skip the state write. Keeps fast cursor movement from
  // race-flashing old content into the pane after the user has moved on.
  let previewSeq = 0;

  // KGP preview pane bookkeeping — when the pane displays an image
  // via the Kitty Graphics Protocol, we keep its image id + cleanup
  // APC around so cursor moves onto a different entry can erase the
  // previous image from the terminal cache before the new preview
  // paints. Cleared to null when the new preview is text/dir.
  let currentPreviewImageId: number | null = null;
  let currentPreviewCleanup: string | null = null;
  const emitPreviewCleanup = (): void => {
    if (currentPreviewCleanup !== null) {
      try { process.stdout.write(currentPreviewCleanup); } catch { /* TTY closed */ }
    }
    currentPreviewImageId = null;
    currentPreviewCleanup = null;
  };

  // P3.2: browser widget state caching — syncWorkingDirWidgetState
  // runs every draw; without these the O(N) entries.map(fmtEntryColored)
  // + selection scan burned per frame even when nothing changed.
  // readonly — fed only to browserWidgetRuntime.shouldRefresh / assigned
  // from its cache, both of which expose `readonly FsEntry[]`.
  let _lastBrowserEntries: readonly FsEntry[] | null = null;
  let _lastBrowserSelSize = -1;
  let _lastBrowserCursor  = -1;
  let _lastBrowserOffset  = -1;

  const refreshWorkingDirPreview = (opts: { force?: boolean } = {}): void => {
    if (!opts.force && !shouldAutoRefreshPreview(dockedPreview)) {
      return;
    }
    previewSeq += 1;
    const mySeq = previewSeq;
    // Erase any prior KGP image before we repaint — Kitty would still
    // show the old image behind the new entry's header otherwise.
    emitPreviewCleanup();
    const src = effectivePreviewBrowser();
    // Skill-file entries don't carry the `isDir` flag, so we project
    // them into the shared FsEntry-ish shape the body below expects.
    const e = (() => {
      if (src === 'obsidian') return obsidianFocusedEntry(obsidianDir);
      if (src === 'skill') {
        const f = skillFocusedFile(skillView);
        if (!f) return null;
        return {
          name: f.name,
          absPath: f.absPath,
          isDir: false,
          size: f.size,
          mtime: f.mtime,
          ext: f.ext,
        };
      }
      return focusedEntry(workingDir);
    })();
    dockedPreview.previewOffset = 0;
    if (!e || e.name === '..') {
      dockedPreview.previewPath = null;
      dockedPreview.previewLines = [];
      return;
    }
    dockedPreview.previewPath = e.absPath;

    if (e.isDir) {
      // Header (icon + accent name) then a child listing in cwd's sort
      // / hidden flags so the user sees what the browser will show
      // after cd'ing in. Each row is colored individually.
      const lines: string[] = [];
      lines.push(`${C.accent(FOLDER_ICON)} ${dirColor(e.name)}`);
      lines.push(C.muted(e.absPath));
      lines.push('');
      // Use the active source's sort/hidden flags so the child
      // listing matches the browser the preview is mirroring.
      const showHidden = src === 'obsidian' ? obsidianDir.showHidden : workingDir.showHidden;
      const sortMode   = src === 'obsidian' ? obsidianDir.sortMode   : workingDir.sortMode;
      try {
        const { folders, files } = readDirEntries(e.absPath, showHidden);
        const sortedDirs = sortEntries(folders, sortMode);
        const sortedFiles = sortEntries(files, sortMode);
        for (const f of sortedDirs) {
          lines.push(`  ${C.accent(FOLDER_ICON)} ${dirColor(f.name)}`);
        }
        for (const f of sortedFiles) {
          const ic = fileColor(f.name)(fileIcon(f.name));
          const nm = fileColor(f.name)(f.name);
          lines.push(`  ${ic} ${nm}  ${C.muted(sizeStr(f.size))}`);
        }
        if (sortedDirs.length + sortedFiles.length === 0) {
          lines.push(C.muted('  (empty)'));
        }
      } catch {
        lines.push(C.muted('  (unreadable)'));
      }
      dockedPreview.previewLines = lines;
      return;
    }

    // File preview — header + line-numbered + syntax-colored body.
    const lines: string[] = [];
    const ext = e.ext ? `.${e.ext}` : '';
    lines.push(`${fileColor(e.name)(fileIcon(e.name))} ${fileColor(e.name)(e.name)}`);
    lines.push(C.muted(e.absPath));
    lines.push('');

    // Image preview — route through KGP on Ghostty/Kitty for native
    // pixel-accurate render; fall back to chafa block-art on other
    // terminals. Runs async so initial header paints synchronously
    // and the user doesn't feel the decode latency on a fast j/k.
    const extDot = e.ext ? `.${e.ext.toLowerCase()}` : '';
    if (previewRouterInternal.IMAGE_EXTS.has(extDot) || previewRouterInternal.MAGICK_EXTS.has(extDot)) {
      lines.push(C.muted('  (loading image…)'));
      dockedPreview.previewLines = lines;
      const targetPath = e.absPath;
      const headerLines = lines.slice(0, 3);
      const { cols: termCols, rows: termRows } = termSize();
      const paneCols = activePreviewPaneWidth(termCols);
      const paneH = computePaneH(termRows);
      const paneRows = Math.max(4, paneH - 4); // leave room for header + borders
      const useKgp = isKgpTerminal();
      void (async () => {
        try {
          if (useKgp) {
            const r = await renderImageKGP(targetPath, { cols: paneCols, rows: paneRows });
            if (r && r.placeholderLines.length > 0) {
              if (mySeq !== previewSeq) return;
              if (dockedPreview.previewPath !== targetPath) return;
              try { process.stdout.write(r.uploadBytes); } catch { /* TTY closed */ }
              currentPreviewImageId = r.imageId;
              currentPreviewCleanup = r.cleanupSeq;
              dockedPreview.previewLines = [...headerLines, ...r.placeholderLines];
              try { draw(); } catch { /* TUI torn down */ }
              return;
            }
          }
          // Chafa fallback — also used when KGP decode fails.
          const fallback = await renderImagePreview(targetPath, { cols: paneCols, rows: paneRows });
          if (mySeq !== previewSeq) return;
          if (dockedPreview.previewPath !== targetPath) return;
          if (fallback && fallback.length > 0) {
            dockedPreview.previewLines = [...headerLines, ...fallback];
          } else {
            dockedPreview.previewLines = [...headerLines, C.muted('  (image render failed — install chafa or check terminal KGP support)')];
          }
          try { draw(); } catch { /* TUI torn down */ }
        } catch {
          if (mySeq !== previewSeq) return;
          dockedPreview.previewLines = [...headerLines, C.muted('  (image decode error)')];
          try { draw(); } catch { /* TUI torn down */ }
        }
      })();
      return;
    }

    // Skip preview body for known-binary extensions; canPreview gates
    // on a whitelist so unfamiliar text formats fall through too.
    if (!canPreview(e.absPath)) {
      lines.push(C.muted('  (binary or non-text — no preview)'));
      dockedPreview.previewLines = lines;
      return;
    }

    try {
      const raw = readFileSync(e.absPath, 'utf-8');
      const bodyLines = raw.split('\n').slice(0, 1000);   // hard cap so huge files don't kill render
      for (let i = 0; i < bodyLines.length; i++) {
        const ln = C.muted(String(i + 1).padStart(4) + ' \u2502 ');
        lines.push(`${ln}${colorLine(bodyLines[i]!, ext)}`);
      }
      const total = raw.split('\n').length;
      if (total > bodyLines.length) {
        lines.push(C.muted(`  ... +${total - bodyLines.length} more lines`));
      }
    } catch {
      lines.push(C.muted('  (unable to read)'));
    }
    dockedPreview.previewLines = lines;
    // Async glow upgrade for markdown. The plain colorLine preview is
    // already painted above so the user sees content immediately. If
    // glow is on PATH, its richer render replaces it once available —
    // but only when the seq id still matches, so rapid cursor moves
    // don't flash stale content back into the pane.
    if (e.ext === 'md' || e.ext === 'markdown') {
      const targetPath = e.absPath;
      const headerLines = lines.slice(0, 3); // icon/name + path + blank
      // Pane width is whatever the preview cell ends up with after the
      // Use the active view's actual row pane ratios so glow tracks the
      // same row spec that the dashboard layout compiler uses.
      const { cols: termCols } = termSize();
      const estWidth = activePreviewPaneWidth(termCols);
      void (async () => {
        const rendered = await renderMarkdownGlow(targetPath, { width: estWidth });
        if (rendered == null) return;
        if (mySeq !== previewSeq) return; // stale — cursor moved
        if (dockedPreview.previewPath !== targetPath) return;
        dockedPreview.previewLines = [...headerLines, ...rendered];
        try { draw(); } catch { /* TUI may have torn down */ }
        try { promptCtl.repaint(); } catch { /* noop */ }
      })();
    }
  };
  const setDockedPreviewSource = (source: PreviewSource): void => {
    setPreviewSourceForView(dockedPreview, source, workingDir.view);
    refreshWorkingDirPreview({ force: true });
  };
  const setDockedPreviewBinding = (mode: 'follow' | 'pinned'): void => {
    setPreviewBindingMode(dockedPreview, mode);
    if (mode === 'follow') {
      refreshWorkingDirPreview({ force: true });
    }
  };

  // Text queued by the file-pane attach action — injected into the next
  // input-mode entry as initialText so the tokenized paths land in the
  // buffer ahead of whatever the user types. Cleared once consumed.
  const inputPrefixState = createDashboardInputPrefixState();
  const focusTransitionState = createDashboardFocusTransitionState();

  // T6-K3 — wire the DashboardSlashExecute native tool. Read-only
  // slashes with extracted helpers may execute immediately; everything
  // else queues into pendingInputPrefix so the user confirms with Enter.
  // T6-K4 — wire DashboardConfigGet / DashboardConfigSet. Getters
  // read from live dashboard state; setters write through and
  // persist via saveUserConfig when the key lives on disk.
  bootDashboardConfigTools({
    initDashboardConfigTools,
    approver: createConfigSetApprover(),
    getChatOnlyMode: () => chatOnlyMode,
    applyChatOnlyMode: (enabled) => {
      chatOnlyMode = enabled;
      if (chatOnlyMode) setSegment(hud, 'mode', C.info('mode: chat'), 10);
      else clearSegment(hud, 'mode');
      draw();
    },
    getUserConfig: () => getUserConfig() as Record<string, any>,
    saveUserConfig: (cfg) => saveUserConfig(cfg as never),
    getPreviewSource: () => dockedPreview.sourceMode,
    applyPreviewSource: (source) => {
      setDockedPreviewSource(source);
      draw();
    },
    getWorkingDirShowHidden: () => workingDir.showHidden,
    applyWorkingDirShowHidden: (enabled) => {
      workingDir.showHidden = enabled;
      refreshWorkingDir(workingDir);
      refreshWorkingDirPreview({ force: true });
      draw();
    },
    getWorkingDirSortMode: () => workingDir.sortMode,
    applyWorkingDirSortMode: (mode) => {
      workingDir.sortMode = mode as typeof workingDir.sortMode;
      refreshWorkingDir(workingDir);
      refreshWorkingDirPreview({ force: true });
      draw();
    },
    afterThemeActiveSaved: draw,
  });

  // H5 P2 bootstrap — register the default channel router patterns
  // + codex-pty adapter hook, then bind the TTY snapshot LLM tools
  // to the live embodied-session registry. Without this wiring:
  //   - `defaultChannelRouter.classify(...)` always returns 'raw'
  //   - `SnapshotPtyState` / `ListPtySnapshots` / `ComparePtySnapshots`
  //     all throw "not wired" errors when an LLM tries them
  bootDashboardEmbodiedTools({
    registerDefaultPatterns,
    router: defaultChannelRouter,
    codexChannelHook,
    claudeChannelHook,
    geminiChannelHook,
    initTtySnapshotTools,
    // H5 P3 · wire the AgentHandoff LLM tool to the live session
    // registry. Observer lookup is deliberately omitted here — the
    // session registry doesn't yet track attached observers. Future
    // follow-on (§T5 of HANDOFF docs) wires that bridge so
    // contextChannels-filtered handoff works with the per-channel
    // buffers instead of raw PTY snapshots.
    initAgentHandoffTool,
    findSessionById: findLiveSessionById,
    findSessionByPaneId: findLiveSessionByPaneId,
  });
  const {
    conversationPopupHost,
    pruneConversationPopupHost,
    ensureConversationWidgetMounted,
    conversationPopupRuntime,
  } = bootDashboardConversationPopupRuntime({
    listLiveSessions: listLiveEmbodiedSessions,
    findSessionEntry: findConversationSessionEntry,
    getSession: (entry) => entry.session,
    getWidgetId: (entry) => conversationModalWidgetId(entry.session.id),
    getModalTitle: (entry) => conversationModalTitle(entry.session),
    getStatusRecord: (sessionId) => agentStatusStore.getRecord(sessionId),
    findObserver: (sessionId) => findSessionObserver(sessionId),
    buildWidgetConfig: buildConversationWidgetConfig,
    getWidget: (widgetId) => widgetHost.get(widgetId) as
      | import('../widgets/types.js').WidgetInstance<import('../conv-dash/conversation-widget-model.js').ConversationWidgetStateLike>
      | null
      | undefined,
    spawnWidget: (opts) => { widgetHost.spawn(opts); },
    applyWidgetConfig: (
      state: import('../conv-dash/conversation-widget-model.js').ConversationWidgetStateLike,
      config,
    ) => applyConversationWidgetConfig(state, config),
    disposeWidget: (widgetId) => { widgetHost.dispose(widgetId); },
    termSize,
    workspaceHost: display.workspaceHostAPI(),
    resolveLayoutMode: resolveTabletConversationLayoutMode,
    showModal: ({ id, title, widgetId, cols, rows, bounds, onDispose }) => showLivePaneMultiModal({
      id,
      title,
      columns: [{ title: 'conversation', widgetInstanceId: widgetId, weight: 1 }],
      widgetHost,
      coordinator: display,
      termCols: cols,
      termRows: rows,
      bounds,
      ttlMs: 0,
      group: `conversation-widget:${String(id).replace('conversation-modal:', '')}`,
      interactionClass: 'embedded-overlay',
      windowRole: 'companion',
      onDispose,
    }),
    draw: () => { draw(); },
  });

  // ── PR-S1V.4-wiring · Voice input host (2026-04-29) ────────────────
  //
  // Lazy boot: only construct the STTProvider + host when the user has
  // an OpenAI key set. Without one the host stays `null` and the
  // priority-route deps below short-circuit so voice paths are entirely
  // inactive (no kitty toggles, no key swallowing). Production users
  // opt in by exporting OPENAI_API_KEY before launching elanous. Status
  // bar segment also stays empty because `voiceIndicatorLabel` never
  // transitions away from null.
  //
  // PLAN §4.5 — resolveSession is alias-normalized via BRAND_ALIASES so
  // "claude" voice prefix matches a "claude-code" launch brand. Focused
  // fallback uses (a) conversationPopupHost.snapshot().focusedSessionId
  // and (c) the focused VW pane → findLiveSessionByPaneId chain. When
  // both miss the resolveSession returns null and the bridge drops the
  // transcript with reason='no-stream'.
  //
  // PLAN §4.5 — submitToSession is transport-aware: embodied PTY
  // sessions go through `entry.session.send` with the reply.ts:150
  // newline append pattern. ACP live sessions echo via
  // `globalAcpEventRouter().noteUserSubmit` then `clientSessionSend`
  // (matching the chat input submit pattern in vw-live-bridge.ts:325).
  let voiceInputHost: VoiceInputHost | null = null;
  let voiceIndicatorLabel: string | null = null;
  let voiceUnsubscribeIndicator: (() => void) | null = null;
  // PR-S1V.D4 (2026-04-29) — long-press Space dictation detector. Runs
  // alongside the voice host but mutually exclusive (one sox subprocess
  // at a time, enforced by `host.startDictation` returning false when
  // voice mode is active). The detector reconstructs hold/release from
  // the OS key-repeat stream so a long Space hold becomes dictation
  // without depending on kitty `>3u` release events at idle. resolveSession
  // / submitToSession / dictateTranscript live in `createDashboardVoiceRuntime`
  // (extracted from this file in the dashboard refactor); the detector
  // wires the host startDictation/stopDictation pair only.
  let voiceLongPressDetector: SpaceLongPressDetector | null = null;
  // TEMP DEBUG TRIAL (2026-04-29 · fix/voice-runtime-tdz-2) — toggle-mode
  // dictation chord. Bypasses the long-press detector entirely for the
  // trial chord (Ctrl+Shift+D). First press starts dictation, second
  // press stops. Debounce ignores OS auto-repeat keystrokes from
  // pile-up-toggling within ~300 ms. Plain Space (Branch 2) keeps the
  // detector path so we can A/B compare both UX patterns in dogfood.
  let lastDictationToggleAt = 0;
  const DICTATION_TOGGLE_DEBOUNCE_MS = 300;
  function toggleDictationFromChord(source: string, keyName: string | undefined): boolean {
    if (!voiceInputHost) {
      if (debug.enabled) debug.log('voice.toggle.skip', 'no-host', { source, keyName });
      return false;
    }
    if (voiceInputHost.getState().kind !== 'idle') {
      if (debug.enabled) {
        debug.log('voice.toggle.skip', 'voice-mode-active', {
          source, keyName, voiceState: voiceInputHost.getState().kind,
        });
      }
      return false;
    }
    const nowMs = Date.now();
    const sinceLast = nowMs - lastDictationToggleAt;
    if (sinceLast < DICTATION_TOGGLE_DEBOUNCE_MS) {
      if (debug.enabled) {
        debug.log('voice.toggle.debounced', 'os-repeat', {
          source, keyName, sinceLast, debounceMs: DICTATION_TOGGLE_DEBOUNCE_MS,
        });
      }
      return false;
    }
    lastDictationToggleAt = nowMs;
    const dictState = voiceInputHost.getDictationState();
    if (dictState === 'idle') {
      const ok = voiceInputHost.startDictation();
      if (debug.enabled) debug.log('voice.toggle.start', source, { keyName, ok });
    } else if (dictState === 'recording') {
      void voiceInputHost.stopDictation();
      if (debug.enabled) debug.log('voice.toggle.stop', source, { keyName, dictState });
    } else {
      if (debug.enabled) {
        debug.log('voice.toggle.skip', 'processing', { source, keyName, dictState });
      }
    }
    return true;
  }
  const voiceRuntime = createDashboardVoiceRuntime({
    listLiveSessions: listLiveEmbodiedSessions,
    findLiveSessionById,
    findLiveSessionByPaneId,
    getFocusedConversationSessionId: () => conversationPopupHost.snapshot().focusedSessionId,
    getFocusedVirtualWindowPane: () => ({ vwId: null, paneId: null, paneKind: null }),
    noteUserSubmit: (sessionId, text) => globalAcpEventRouter().noteUserSubmit(sessionId, text),
    clientSessionSend: (opts) => globalDualRoleManager().clientSessionSend(opts),
    getWorkingFocus: () => workingDir.focus,
    getChatMainInputVisibilityState: () => chatMainInputVisibilityState(),
    chatMainPromptLive: () => typeof promptCtl.insertAtCursor === 'function',
    insertIntoChatMainPrompt: (text) => {
      promptCtl.insertAtCursor?.(text);
    },
    appendInputPrefixInline: (text) => inputPrefixState.appendInline(text),
    // Lazy wrappers — `applyFocusToInputTransition` is `const`-declared
    // further down (~line 6896), so a shorthand reference here triggers
    // a TDZ ReferenceError when `createDashboardVoiceRuntime` evaluates
    // its deps object during boot. The arrow defers the name lookup
    // until dictation actually runs — by that time the dashboard scope
    // is fully initialized. `draw` is a `let` placeholder at line 2475
    // that's later reassigned (~10665); the shorthand would otherwise
    // capture the placeholder no-op so dictation-driven redraws never
    // ran. Same lazy lookup fixes both.
    applyFocusToInputTransition: (transition) => applyFocusToInputTransition(transition),
    setPendingInputEntryModePlain: () => focusTransitionState.setPendingInputEntryMode('plain'),
    draw: () => draw(),
  });
  // 2026-04-30 — expose dictateTranscript for the PWA voice
  // `tui-bridge` dispatch mode. When the daemon and dashboard share a
  // process (e.g. `elanous start --http-port`), users with
  // `voice.pwa.dispatch: 'tui-bridge'` will see their phone transcripts
  // injected into the focused dashboard input via this hook. The
  // singleton stays unset in dashboard-less daemons (`elanous serve`),
  // and the dispatcher short-circuits gracefully there.
  setDaemonInputHost({
    dictateTranscript: (text: string) => voiceRuntime.dictateTranscript(text),
  });
  // Phase 2 auto-TTS — config priority: user-config > env > default.
  // Provider is created lazily on first sentence so a missing
  // OPENAI_API_KEY (or absence of any TTS dep) doesn't crash the
  // dashboard for users who never opt in.
  const dashboardAutoTts = (() => {
    const voiceCfg = getUserConfig().voice;
    return bootDashboardAutoTts({
      ...(voiceCfg.tts.provider ? { providerId: voiceCfg.tts.provider } : {}),
      ...(typeof voiceCfg.tts.auto === 'boolean' ? { initiallyEnabled: voiceCfg.tts.auto } : {}),
      ...(typeof voiceCfg.tts.maxSentenceChars === 'number'
        ? { maxSentenceChars: voiceCfg.tts.maxSentenceChars }
        : {}),
    });
  })();
  // ── V1 (Bundle 2) — PFC voice TTS report ──
  // Wires the PFC notification sink to the auto-tts controller. Opt-in
  // via `ELANOUS_PFC_VOICE_REPORT=1` so first dogfood doesn't surprise.
  pfcVoiceRuntimeRef.current = createPfcVoiceRuntime({
    getController: () => dashboardAutoTts.controller,
    initiallyEnabled: process.env.ELANOUS_PFC_VOICE_REPORT === '1',
    logDebug: (category, event, data) => debug.log(category, event, data),
  });
  // ── X4 (Bundle 2) — PFC auto-Screenshot attachment ──
  // Async PNG capture for screenshot-capable surfaces; result attached
  // to the PfcReverseFeedbackNotification before downstream sinks
  // (voice + future vision LLM proposers in Bundle 3 X7) consume it.
  // Opt-in via `ELANOUS_PFC_AUTO_SCREENSHOT=1`.
  if (process.env.ELANOUS_PFC_AUTO_SCREENSHOT === '1') {
    const { dispatchScreenshot: pfcDispatchScreenshot } = await import(
      '../capture/capture-tools.js'
    );
    pfcScreenshotAttacherRef.current = createPfcScreenshotAttacher({
      resolveScreenshotTarget: () => null,
      dispatchScreenshot: async (args) => {
        const out = await pfcDispatchScreenshot(args);
        return {
          ...(out.bodyBase64 !== undefined ? { bodyBase64: out.bodyBase64 } : {}),
          ...(out.bytes !== undefined ? { bytes: out.bytes } : {}),
          ...(out.note !== undefined ? { note: out.note } : {}),
        };
      },
      logDebug: (category, event, data) => debug.log(category, event, data),
    });
  }
  if (debug.enabled) {
    debug.log('pfc.bundle2.boot', 'ready', {
      voiceReport: pfcVoiceRuntimeRef.current.isEnabled(),
      autoScreenshot: pfcScreenshotAttacherRef.current !== null,
    });
  }
  const dashboardControlSignals = defaultControlSignalBus();
  // Phase 4 voice-chat — late-bound submit closure. The actual
  // dispatch helper (dispatchAcpSend) is defined inside the input
  // loop, so we hold a mutable reference and bind it on every iter.
  let voiceChatSubmitImpl: ((text: string) => void) | null = null;
  // Voice-chat error display — three surfaces fire in concert:
  //   1. HUD `voice-error` segment (3s banner) — distinct emoji + color
  //      so the user can tell at a glance the system is in error state,
  //      not normal idle/listening.
  //   2. chatLines warning — permanent record (user can scroll back).
  //   3. Toast popup (bottom-right transient, 5s) — separate surface
  //      so the user notices even if their attention isn't on the HUD.
  // The `voice-error` segment uses 🔴 + "ERROR" prefix so it is
  // unmistakably an error state (not the same accent ⚠ as the
  // chord-toggle mutex warning, which is a softer "rejected" message).
  let voiceErrorTimer: ReturnType<typeof setTimeout> | null = null;
  const showVoiceError = (err: Error): void => {
    const summary = err.message.length > 120
      ? err.message.slice(0, 117) + '…'
      : err.message;
    // 1. chatLines — permanent record.
    chatLines.push('');
    chatLines.push(C.error(`🔴 [voice-chat ERROR] ${summary}`));
    chatScrollOffset = -1;
    // 2. HUD — error state distinct from any normal phase color.
    setSegment(hud, 'voice-error', C.error(`🔴 voice ERROR · ${summary}`), 7);
    if (voiceErrorTimer) clearTimeout(voiceErrorTimer);
    voiceErrorTimer = setTimeout(() => {
      clearSegment(hud, 'voice-error');
      voiceErrorTimer = null;
      requestDashboardRender();
    }, 3000);
    // 3. Toast popup — bottom-right, 5s. Separate group so it doesn't
    // collide with regular toast notifications. Lines wrapped at ~52
    // cells (toast max is 56). Long messages split across lines.
    try {
      const { cols: tc, rows: tr } = termSize();
      const wrapAt = 52;
      const lines: string[] = [];
      let remaining = summary;
      while (remaining.length > wrapAt) {
        lines.push(remaining.slice(0, wrapAt));
        remaining = remaining.slice(wrapAt);
      }
      if (remaining) lines.push(remaining);
      lines.push('');
      lines.push('ESC to dismiss');
      showToast({
        title: '🔴 voice-chat ERROR',
        lines,
        coordinator: display,
        termCols: tc,
        termRows: tr,
        ttlMs: 5000,
        group: 'voice-error',
      });
    } catch (showErr) {
      if (debug.enabled)
        debug.log('voice.chat.error', 'toast.exception', {
          err: showErr instanceof Error ? showErr.message : String(showErr),
        }, { level: 'error' });
    }
    requestDashboardRender();
  };
  attachDashboardQuickPassConsumers({
    signalBus: dashboardControlSignals,
    cancelOutput: () => dashboardAutoTts.hooks.cancel(),
    onConsumed: ({ kind, urgency, surface }) => {
      if (debug.enabled) {
        debug.log('input.control', 'quick-pass.consume', {
          signalKind: kind,
          urgency,
          surface,
        });
      }
    },
    onError: ({ kind }, err) => {
      if (debug.enabled) {
        debug.log('input.control', 'quick-pass.consume.error', {
          signalKind: kind,
          error: err instanceof Error ? err.message : String(err),
        }, { level: 'error' });
      }
    },
  });
  function emitVoiceChatStopQuickPass(reason: 'esc' | 'alt-s' | 'barge-in'): void {
    dashboardControlSignals.emit({
      kind: 'voice-chat-stop',
      urgency: 'quick-pass',
      source: 'system',
      mayPreempt: true,
      scope: { surface: 'voice-chat', channel: 'dashboard' },
      payload: {
        reason,
        phase: dashboardVoiceChat.controller.getPhase(),
      },
    });
  }
  // Voice user-config snapshot at boot. Each field is sparse —
  // only present when the user explicitly set it in config.json.
  // host-boot sees `undefined` and falls back to env (backward
  // compat) → hardcoded default.
  const voiceCfgAtBoot = getUserConfig().voice;
  const dashboardVoiceChat = bootDashboardVoiceChat({
    ...(voiceCfgAtBoot.stt.provider ? { providerId: voiceCfgAtBoot.stt.provider } : {}),
    ...(voiceCfgAtBoot.vad.mode ? { vadMode: voiceCfgAtBoot.vad.mode } : {}),
    ...(typeof voiceCfgAtBoot.chat.multiTurn === 'boolean'
      ? { multiTurn: voiceCfgAtBoot.chat.multiTurn }
      : {}),
    ...((typeof voiceCfgAtBoot.vad.threshold === 'number'
        || typeof voiceCfgAtBoot.vad.silenceMs === 'number'
        || typeof voiceCfgAtBoot.vad.minSpeechMs === 'number')
      ? {
          vadOpts: {
            ...(typeof voiceCfgAtBoot.vad.threshold === 'number'
              ? { threshold: voiceCfgAtBoot.vad.threshold } : {}),
            ...(typeof voiceCfgAtBoot.vad.silenceMs === 'number'
              ? { silenceMs: voiceCfgAtBoot.vad.silenceMs } : {}),
            ...(typeof voiceCfgAtBoot.vad.minSpeechMs === 'number'
              ? { minSpeechMs: voiceCfgAtBoot.vad.minSpeechMs } : {}),
          },
        }
      : {}),
    submitTranscript: (text) => {
      // 2026-04-30 — UX revision: route the transcript through D5
      // PTT's `dictateTranscript` so the user SEES their words in
      // the chat input, but DON'T auto-submit in single-turn mode.
      // User feedback: "열심히 받아 적은 보이스 텍스트가 ctrl+l 다시
      // 인풋 모드 들어가자 마자 클리어 되버렸어요." — the previous
      // double-action (inject + submit) raced with the input pane's
      // ESC handler and made the text disappear when the user tried
      // to exit.
      //
      // Phase transition policy (post-2026-04-30 host-boot change):
      //   - single-turn OFF → dictate to the input buffer, then
      //     controller.exit so the user owns submit timing.
      //   - multi-turn ON → delegate to `voiceChatSubmitImpl`. That
      //     closure decides between (a) sticky-armed auto-submit
      //     (transition → speaking) vs (b) sticky-less plain
      //     auto-submit via the textInput host's external submit
      //     hook.
      //   - multi-turn OFF (single-turn default) → controller.exit
      //     so HUD clears; user reads transcript + presses Enter
      //     for a normal LLM turn.
      if (dashboardVoiceChat.multiTurn && voiceChatSubmitImpl) {
        voiceChatSubmitImpl(text);
        return;
      }
      try { voiceRuntime.dictateTranscript(text); } catch { /* ignore */ }
      // Single-turn (or multi-turn pre-init) — voice-chat ends here;
      // the user owns submit timing via the chat input.
      try { dashboardVoiceChat.controller.exit('user-cancel'); } catch { /* ignore */ }
    },
    onPartialTranscript: (text) => {
      if (debug.enabled)
        debug.log('voice.chat.partial', 'tick', { snip: text.slice(0, 60) });
    },
    onBargeIn: () => {
      emitVoiceChatStopQuickPass('barge-in');
    },
    onError: showVoiceError,
    onPhaseChange: (next, prev) => {
      // experiment/voice-chat-realtime-rebind — phase indicator goes
      // to the HUD status bar segment ONLY (NOT chatLines). The chat
      // log shows just start + end events (pushed by the chord/ESC
      // handlers) so it stays uncluttered; the HUD carries the
      // moment-to-moment phase. Each phase has a distinct emoji +
      // color in the HUD.
      //
      //   inactive   → segment cleared (no indicator)
      //   listening  → 🎙 voice · 듣는 중 (accent · prominent)
      //   processing → 💭 voice · 생각 중 (info)
      //   speaking   → 🗣  voice · 말하는 중 (success · green)
      //   stopping   → ⏹ voice · 정리 (muted · fading)
      //
      // priority 6 puts it above the agent-activity segment (3) but
      // below the copied/toast segments (10) so it never hides the
      // higher-priority transient banners.
      if (next === 'inactive') {
        // Don't wipe a fresh dictation indicator if D5 voice mode is
        // also active mid-transition (mutex normally prevents this,
        // but the race window is real during exit cleanup).
        if (voiceIndicatorLabel === null) {
          clearSegment(hud, 'voice-state');
        }
        // 2026-04-30 — sync pipeline lifecycle with controller.
        //
        // Several controller.exit call sites (single-turn submitTranscript
        // dictate-only, voiceChatSubmitImpl dictate-fallback, error
        // recovery in onFinalTranscript catch) used to flip the
        // controller to `inactive` WITHOUT calling pipeline.cancel().
        // That left `pipeline.listening = true` + the STT WebSocket
        // session + the sox capture subprocess alive as residue.
        // Next `Alt+R` enter then hit pipeline.startListening's guard
        // (`if (listening) return false`) and the toggle reported
        // "voice-chat: failed to start listening — check audio device
        // + STT provider" with no real cause.
        //
        // Rather than patch every exit call site, we hook the
        // pipeline cleanup to the controller's terminal phase: the
        // controller is the source of truth for "voice-chat is over",
        // and pipeline.cancel() is idempotent (its own guard at
        // line 264 returns early when nothing is live), so this
        // wire is safe even when an explicit cancel already ran
        // (handleEsc / toggleVoiceChatRealtime exit path).
        try {
          void dashboardVoiceChat.pipeline.cancel();
        } catch (err) {
          if (debug.enabled)
            debug.log('voice.chat.error', 'inactive.pipeline.cancel.exception', {
              err: err instanceof Error ? err.message : String(err),
            }, { level: 'error' });
        }
      } else {
        type Spec = { emoji: string; label: string; color: (s: string) => string };
        const specs: Record<Exclude<typeof next, 'inactive'>, Spec> = {
          listening:  { emoji: '🎙', label: '듣는 중',     color: C.accent },
          processing: { emoji: '💭', label: '생각 중',     color: C.info },
          speaking:   { emoji: '🗣',  label: '말하는 중',   color: C.success },
          stopping:   { emoji: '⏹',  label: '정리',         color: C.muted },
        };
        const spec = specs[next];
        setSegment(hud, 'voice-state', spec.color(`${spec.emoji} voice · ${spec.label}`), 6);
      }
      requestDashboardRender();
      // Phase transition trail. Always-on (gated by debug.enabled) so
      // a freeze report can be diagnosed from log/latest alone.
      if (debug.enabled) {
        debug.log('voice.chat.phase', next, {
          prev,
          desc: describeVoiceChatPhase(next) || null,
          ts: new Date().toISOString(),
        });
      }
    },
  });
  // Boot snapshot — env vars governing voice-chat behavior. One log
  // line per dashboard boot so support sessions can compare expected
  // vs actual without grepping multiple categories.
  if (debug.enabled) {
    debug.log('voice.chat.boot', 'env', {
      vad: process.env.ELANOUS_VOICE_VAD || '(default:server)',
      multiTurn: process.env.ELANOUS_VOICE_CHAT_MULTI_TURN || '(default:off)',
      autoTts: process.env.ELANOUS_AUTO_TTS || '(default:off)',
      sttProvider: process.env.STREAMING_STT_PROVIDER || '(default:openai-realtime-stt)',
      ttsProvider: process.env.TTS_PROVIDER || '(default:openai-tts)',
      providerId: dashboardVoiceChat.providerId,
      hasOpenaiKey: !!process.env.OPENAI_API_KEY,
    });
  }
  if (process.env.OPENAI_API_KEY) {
    void (async () => {
      try {
        const booted = await bootDashboardVoiceHost({
          voiceRuntime,
          createSttProvider: () => createSTTProvider({ id: 'openai-whisper' }),
          createVoiceInputHost: (deps) => createVoiceInputHost(deps),
          createLongPressDetector: (deps) => createSpaceLongPressDetector(deps),
          onIndicatorChange: (label) => {
            voiceIndicatorLabel = label;
            // experiment/voice-chat-realtime-rebind — D5 voice/dictation
            // state now flows into the same HUD segment as voice-chat
            // continuous mode. Single source of truth for "what is
            // elanous doing with audio right now".
            //
            //   label === null         → segment cleared
            //   label like "🎤 hold…"  → dictation pending
            //   label like "🎙 0.8s"   → recording in progress
            //   label like "💭 STT"    → processing
            //
            // The voice-chat-mode-controller writes to the same key
            // (priority 6) when Alt+R is active. Mutex between D5 voice
            // and voice-chat is enforced upstream so the two sources
            // never overlap; whichever is active owns the segment.
            if (label) {
              setSegment(hud, 'voice-state', C.accent(`${label}  ·  dictation`), 6);
            } else {
              // Only clear when voice-chat is also inactive — a race
              // between D5 voice exit and voice-chat enter could
              // otherwise wipe the chat phase indicator.
              if (!dashboardVoiceChat.controller.isActive()) {
                clearSegment(hud, 'voice-state');
              }
            }
          },
          requestRender: () => { requestDashboardRender(); },
          onLongReleasePreShiftFocus: () => {
            // PR-S1V.D5+ smoothness — focus shift is dashboard-scope so
            // the boot module just calls this closure on detector
            // release, before STT runs. Skipped when chord toggle was
            // used from inside chat-main (focus already in input).
            if (workingDir.focus === 'input') return;
            applyFocusToInputTransition(resolveFocusToInputTransition({
              sourcePane: workingDir.focus,
              rememberPane: true,
              mode: 'plain',
              reason: 'voice-dictation-pre-shift',
            }));
          },
        });
        voiceInputHost = booted.host;
        voiceUnsubscribeIndicator = booted.unsubscribeIndicator;
        voiceLongPressDetector = booted.detector;
      } catch (err) {
        chatLines.push(C.warning(reportDashboardVoiceBootError(err)));
        chatScrollOffset = -1;
      }
    })();
  } else if (debug.enabled) {
    debug.log('voice.host', 'boot.skip', { reason: 'no-openai-key' });
  }
  /** PR-S1V.4-wiring · Ctrl+Shift+V chord — fires from anywhere
   *  (popup terminal · VW terminal · bell modal · dashboard) so the
   *  user always has a single entry chord. Korean shifted ㅍ (V on
   *  2-bul) accepts ctrl-only because the shift bit may be implicit
   *  in the codepoint. Mirrors the isForceQuitChord pattern below. */
  const matchesVoiceEnterChord = (
    routeKey: import('../tui.js').Key,
  ): boolean => {
    if (!routeKey.ctrl) return false;
    if (routeKey.shift && (routeKey.name === 'v' || routeKey.name === 'V' || routeKey.name === 'ㅍ')) return true;
    if (routeKey.name === 'ㅍ' && routeKey.ctrl) return true;
    return false;
  };
  /** experiment/voice-chat-realtime-rebind (2026-04-30) — Alt+R toggles
   *  continuous voice-chat mode (Phase 4-5). Switched off Ctrl+Shift+R
   *  to avoid colliding with Ctrl+R (chat input reverse-history search).
   *  Korean ㄱ (R on 2-bul layout) is also accepted so the chord works
   *  with the IME engaged. macOS users may need to set their terminal
   *  to "Option as Meta/Alt" so Option+R reaches elanous as `alt+r` (the
   *  default Terminal.app sends ® instead). */
  const matchesVoiceChatRealtimeChord = (
    routeKey: import('../tui.js').Key,
  ): boolean => {
    // 2026-05-03 — Alt+R was reassigned to reasoning cycle (which
    // mnemonically owns 'R'). Streaming voice-chat moves to Alt+S
    // (S = Streaming). Korean ㄴ (S on 2-bul layout) accepted so the
    // chord works with the IME engaged. macOS users may need to set
    // their terminal to "Option as Meta/Alt" so Option+S reaches
    // elanous as `alt+s`.
    const isCandidate =
      routeKey.name === 's' || routeKey.name === 'S'
      || routeKey.name === 'ㄴ' /* 한글 s on 2-bul */;
    if (debug.enabled && isCandidate) {
      debug.log('voice.chat.matcher', 'eval', {
        keyName: routeKey.name,
        alt: !!routeKey.alt,
        ctrl: !!routeKey.ctrl,
        shift: !!routeKey.shift,
        meta: !!(routeKey as { meta?: boolean }).meta,
        kind: (routeKey as { kind?: string }).kind ?? 'press',
      });
    }
    if (!routeKey.alt) return false;
    if (routeKey.ctrl) return false; // Ctrl+Alt+S is a different chord by convention
    return isCandidate;
  };

  /** Alt+R reasoning cycle matcher — V/D/R mnemonic with V=voice
   *  control (Ctrl+Shift+V), D=batch dictation (Space-longpress),
   *  R=reasoning. Korean ㄱ (R on 2-bul) accepted with IME. */
  const matchesReasoningCycleChord = (
    routeKey: import('../tui.js').Key,
  ): boolean => {
    if (!routeKey.alt) return false;
    if (routeKey.ctrl) return false;
    return routeKey.name === 'r' || routeKey.name === 'R'
      || routeKey.name === 'ㄱ' || routeKey.name === 'ㅛ';
  };
  type CompanionPopupKey = 'scratch' | 'agents' | 'clipboard' | 'memo' | 'detail' | DebugWorkbenchPane;
  const allCompanionPopupKeys: readonly CompanionPopupKey[] = ['scratch', 'agents', 'clipboard', 'memo', 'detail', ...listDebugCompanionKeys()];
  const companionSurfaceHosts = createCompanionSurfaceHostRegistry<CompanionPopupKey>();
  const companionPopupHost = companionSurfaceHosts.ensure('dashboard-main', allCompanionPopupKeys);
  let suppressCompanionPopupDispose = false;
  const topBlockingForegroundModal = (): import('../display/modal-stack.js').ModalSurface | null => {
    return topBlockingForegroundModalSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
  };
  // C-d-1 — 하단 슬롯 결정 뷰(slot:'bottom')가 활성인가. 활성 동안 composer
  // 페인트를 멈춰 하단 영역의 단일 소유자를 보장(codex mod.rs:1674 · CC
  // REPL.tsx:4894 동형). 키는 기존 blocking-modal 라우팅 그대로 뷰가 소비.
  const bottomSlotModalActive = (): boolean => topBlockingForegroundModal()?.slot === 'bottom';
  // Pickers occupy the composer bottom slot.
  const resolveDecisionPickerPlacement = (desired: { height: number }): {
    bounds: { row: number; col: number; width: number; height: number };
    slot?: 'bottom';
    width: number;
  } => {
    const { cols: tc, rows: tr } = termSize();
    const bounds = resolveBottomSlotBounds({
      termCols: tc, termRows: tr,
      promptFrame: currentPromptFrame(tr),
      height: desired.height,
    });
    return { bounds, slot: 'bottom', width: bounds.width };
  };
  const topBottomAreaFreezeModal = (
    termRows = termSize().rows,
  ): import('../display/modal-stack.js').ModalSurface | null => {
    const modal = topModalSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
    if (!modal) return null;
    const promptFrame = currentPromptFrame(termRows);
    return shouldFreezeDashboardBottomArea(modal, promptFrame, termRows)
      ? modal
      : null;
  };
  let lastHostChromeVisibilityTrace = '';
  const shouldSuppressDashboardBottomArea = (termRows = termSize().rows): boolean => {
    const foregroundSurface = topWorkspaceSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
    const blockingForegroundModal = topBlockingForegroundModal();
    const bottomAreaFreezeModal = topBottomAreaFreezeModal(termRows);
    const policy = resolveDashboardHostChromePolicy({
      foregroundSurface,
      blockingForegroundModal,
      bottomAreaFreezeModal,
    });
    if (debug.isKeyTraceEnabled()) {
      const nextTrace = JSON.stringify({
        foregroundSurfaceId: foregroundSurface?.id ?? null,
        foregroundSurfaceKind: foregroundSurface?.kind ?? null,
        blockingForegroundModalId: blockingForegroundModal?.id ?? null,
        bottomAreaFreezeModalId: bottomAreaFreezeModal?.id ?? null,
        suppressPromptArea: policy.suppressPromptArea,
        suppressStatusArea: policy.suppressStatusArea,
        suppressDockArea: policy.suppressDockArea,
        suppressDashboardBackground: policy.suppressDashboardBackground,
      });
      if (nextTrace !== lastHostChromeVisibilityTrace) {
        lastHostChromeVisibilityTrace = nextTrace;
        try {
          debug.log('dashboard.host-chrome.visibility', 'change', JSON.parse(nextTrace));
        } catch {
          debug.log('dashboard.host-chrome.visibility', 'change', nextTrace);
        }
      }
    }
    return policy.suppressPromptArea || policy.suppressStatusArea;
  };
  const companionPopupSpec = (
    key: CompanionPopupKey,
  ): {
    title: string;
    status: string;
    columns: Array<{
      title: string;
      widgetInstanceId: string;
      weight: number;
      onAfterKey?: (action: any, ev: { name?: string }) => void;
      onAfterMouse?: (action: any, ev: unknown) => void;
    }>;
    titleControls?: readonly { id: string; label: string }[];
  } => {
    switch (key) {
      case 'debug-events':
      case 'debug-detail':
      case 'debug-stack':
      case 'debug-prompts': {
        const spec = getDebugCompanionSpec(key);
        return {
          title: spec.title,
          status: spec.status,
          columns: [{ title: spec.title.toLowerCase(), widgetInstanceId: spec.widgetInstanceId, weight: 1 }],
        };
      }
      case 'agents':
        return {
          title: 'Agents',
          status: 'companion · agent roster',
          columns: [
            { title: 'agents', widgetInstanceId: 'wd-agent-roster', weight: 2 },
            { title: 'detail', widgetInstanceId: 'wd-agent-detail', weight: 3 },
            { title: 'log', widgetInstanceId: 'wd-agent-log', weight: 3 },
          ],
        };
      case 'clipboard':
        return {
          title: 'Clipboard',
          status: 'companion · clipboard history',
          columns: [{
            title: 'clipboard',
            widgetInstanceId: 'wd-clipboard',
            weight: 1,
            onAfterKey: (action, ev) => {
              syncClipboardCursorFromWidget();
              if (action?.type === 'submit' || ev.name === 'enter' || ev.name === 'y' || ev.name === 'ㅛ') {
                void copyClipboardHistoryEntryAt(clipCursor).then(() => draw());
                return;
              }
              if (ev.name === 'c') {
                clipHistory.clear();
                clipCursor = 0;
                statusFeedbackRuntime.onClipboardHistoryCleared();
                draw();
                return;
              }
              if (ev.name === 'escape' || ev.name === 'l' || ev.name === 'right') {
                closeClipboardCompanion();
                draw();
              }
            },
            onAfterMouse: (action) => {
              syncClipboardCursorFromWidget();
              if (action?.type === 'submit') {
                void copyClipboardHistoryEntryAt(clipCursor).then(() => draw());
              }
            },
          }],
          titleControls: resolveCompanionPopupTitleControls('no-promote'),
        };
      case 'memo':
        return {
          title: 'Memo',
          status: 'companion · note editor',
          columns: [{
            title: 'memo',
            widgetInstanceId: 'wd-memo',
            weight: 1,
            onAfterKey: (_action, ev) => {
              if (ev.name === 'escape') {
                cancelMemoCompanion();
                draw();
                return;
              }
              if ((ev as { ctrl?: boolean }).ctrl && (ev.name === 's' || ev.name === 'ㄴ')) {
                commitMemoCompanion();
                draw();
                return;
              }
              if ((ev as { ctrl?: boolean }).ctrl && ev.name === 'a') {
                const memo = widgetHost.get('wd-memo') as any;
                if (memo?.state) memo.state.memoColIdx = 0;
                requestDashboardRender('memo');
                return;
              }
              if ((ev as { ctrl?: boolean }).ctrl && ev.name === 'e') {
                const memo = widgetHost.get('wd-memo') as any;
                if (memo?.state) {
                  const lineIdx = memo.state.memoLineIdx ?? 0;
                  const line = memo.state.memoLines?.[lineIdx] ?? '';
                  memo.state.memoColIdx = line.length;
                }
                requestDashboardRender('memo');
              }
            },
          }],
          titleControls: resolveCompanionPopupTitleControls('no-promote'),
        };
      case 'detail':
        return {
          title: 'Detail',
          status: 'companion · read-only viewer',
          columns: [{ title: 'detail', widgetInstanceId: 'wd-detail', weight: 1 }],
          titleControls: resolveCompanionPopupTitleControls('no-promote'),
        };
      case 'scratch':
        return {
          title: 'Scratch',
          status: 'companion · scratch canvas',
          columns: [{ title: 'scratch', widgetInstanceId: 'wd-scratch', weight: 1 }],
        };
    }
  };
  const syncCompanionPopups = (): void => {
    const { cols, rows } = termSize();
    const workspaceHost = display.workspaceHostAPI();
    const ownerId = companionPopupHost.ownerId;
    const keys = companionPopupHost.listOpen();
    const blockingForeground = topBlockingForegroundModal();
    const workspacePolicy = resolveTabletWorkspacePolicy({
      termCols: cols,
      termRows: rows,
      hasBlockingForeground: !!blockingForeground,
      companionCount: keys.length,
    });
    workspaceHost.setLayoutMode(ownerId, workspacePolicy.workspaceLayoutMode);
    suppressCompanionPopupDispose = true;
    try {
      companionPopupHost.disposeHandles();
    } finally {
      suppressCompanionPopupDispose = false;
    }
    for (const key of allCompanionPopupKeys) {
      if (!companionPopupHost.isActive(key)) {
        workspaceHost.removeMember(ownerId, companionSurfaceId(ownerId, key));
      }
    }
    keys.forEach((key, index) => {
      const spec = companionPopupSpec(key);
      if (spec.columns.some(column => !widgetHost.get(column.widgetInstanceId))) return;
      const surfaceId = companionSurfaceId(ownerId, key);
      workspaceHost.upsertMember(ownerId, {
        surfaceId,
        kind: 'popup',
        label: spec.title,
        order: 280 + index,
      });
      const slotPlan = planTabletCompanionSlot({
        termCols: cols,
        termRows: rows,
        slotIndex: index,
        totalCount: keys.length,
        hasBlockingForeground: !!blockingForeground,
      });
      if (!slotPlan.visible || !slotPlan.bounds) {
        workspaceHost.minimizeMember(ownerId, surfaceId, { docked: true });
        return;
      }
      workspaceHost.restoreMember(ownerId, surfaceId);
      const bounds = computeCompanionPopupBounds({
        termCols: cols,
        termRows: rows,
        slotIndex: index,
        totalCount: keys.length,
        hasBlockingForeground: !!blockingForeground,
      });
      const handle = showLivePaneMultiModal({
        id: surfaceId,
        title: spec.title,
        columns: spec.columns,
        widgetHost,
        coordinator: display,
        termCols: cols,
        termRows: rows,
        bounds,
        ttlMs: 0,
        group: surfaceId,
        interactionClass: 'embedded-overlay',
        windowRole: 'companion',
        chrome: resolveCompanionPopupChrome({
          theme: currentThemeTokens(),
          titleControls: spec.titleControls,
          bottomStatus: spec.status,
        }),
        onChromeAction: (action) => {
          if (action.controlId === 'minimize') {
            companionPopupHost.markDocked(key);
            workspaceHost.minimizeMember(ownerId, surfaceId, { docked: true });
            syncCompanionPopups();
            draw();
            return;
          }
          if (action.controlId === 'promote') {
            companionPopupHost.close(key);
            promoteCompanionPopup(key);
            return;
          }
          if (action.controlId === 'close') {
            if (key === 'agents') agentsViewDismissed = true;
            companionPopupHost.close(key);
            workspaceHost.removeMember(ownerId, surfaceId);
            syncCompanionPopups();
            draw();
          }
        },
        onDispose: () => {
          if (suppressCompanionPopupDispose) return;
          if (companionPopupHost.isDocked(key)) {
            workspaceHost.minimizeMember(ownerId, surfaceId, { docked: true });
            draw();
            return;
          }
          if (key === 'agents') agentsViewDismissed = true;
          companionPopupHost.close(key);
          workspaceHost.removeMember(ownerId, surfaceId);
          syncCompanionPopups();
          draw();
        },
      });
      companionPopupHost.setHandle(key, handle);
    });
  };
  const setCompanionPopupOpen = (key: CompanionPopupKey, next: boolean): void => {
    companionPopupHost.setOpen(key, next);
    syncCompanionPopups();
  };
  const toggleCompanionPopup = (key: CompanionPopupKey): boolean => {
    const next = companionPopupHost.toggleOpen(key);
    syncCompanionPopups();
    return next;
  };
  const {
    syncConversationPopupModals,
    setConversationPopupLayoutMode,
    openConversationModal,
    focusConversationPopup,
  } = conversationPopupRuntime;
  // H6 P6 · register the 3 built-in capture source providers. Each
  // provider is isolated (D10) — a failure here logs but doesn't
  // abort boot. The agent-session provider's `findObserver` hook
  // binds to H6 P5's `observer-registry` once it lands on main;
  // until then the provider falls back to raw session.snapshot()
  // with an 'observer-missing' warning (per PLAN §D4 / §R6).
  try {
    const [
      { defaultCaptureSourceRegistry },
      { createVwPaneProvider },
      { createAgentSessionProvider },
      { createBrowserCdpProvider },
    ] = await Promise.all([
      import('../capture/source-registry.js'),
      import('../capture/providers/vw-pane-provider.js'),
      import('../capture/providers/agent-session-provider.js'),
      import('../capture/providers/browser-cdp-provider.js'),
    ]);
    bootDashboardCaptureSourceProviders({
      defaultCaptureSourceRegistry,
      createVwPaneProvider,
      createAgentSessionProvider,
      createBrowserCdpProvider,
      registerProvider: (registry, provider) => { registry.registerProvider(provider); },
      getWindows: () => [],
      listSessions: () => listLiveEmbodiedSessions(),
      // H6 P5 observer-registry landed · threading through enables
      // the channel-aware snapshot path (falls back to raw snapshot
      // + 'observer-missing' warning when no observer is attached).
      findObserver: findSessionObserver,
    });
  } catch (err) {
    debug.log('capture-source.providers.fail', 'dashboard-boot', {
      message: err instanceof Error ? err.message : String(err),
    }, { level: 'error' });
  }
  // PLAN-tui-redundancy-cleanup T1 (2026-05-16) — vw-join-bridge /
  // vw-live-bridge boot init 제거. ACP resident window 자체 미사용 ·
  // VW promote (`/AcpSessionJoin promoteToVW`) 도 같이 deprecated.
  // ACP follow-up #7 — per-brand HOP_CAP config. Wire the
  // user-config resolver so per-brand `acp.hopCap.{claude,codex,
  // gemini,default}` values flow into DRM chain-depth checks.
  // Unset brands fall back to DEFAULT_HOP_CAP=3 (unchanged behaviour).
  setAcpHopCapResolver((brandId) => resolveAcpHopCapFromConfig(brandId));

  // ACP follow-up #1 — auto-persist on turn-end. DRM end_turn
  // transitions + BG terminal states flow into the H2 #5 persistence
  // primitive automatically (always on — off-switch graduated 2026-09-26).
  wireAutoPersist({
    drm: globalDualRoleManager(),
    bg: globalBackgroundManager(),
    persistence: globalAcpSessionPersistence(),
  });

  // ACP follow-up #6 — periodic sweep of terminal BG records. Keeps
  // the in-memory BackgroundManager bounded for long-running elanous
  // processes. Auto-persist (#1) already flushed the terminal record
  // to disk, so sweeping doesn't lose history · only the live stub.
  // Always on (ELANOUS_ACP_BG_SWEEP_MODE off-switch graduated 2026-09-26). Defaults: 24h TTL ·
  // 1h tick (matches Warp cloud-agent "stale after a day" heuristic).
  bootDashboardAcpBgSweep({
    enabled: true,
    backgroundManager: globalBackgroundManager(),
  });

  // T6-K5 — wire widget + pane control tools. Widgets are reported
  // from widgetHost; pane focus piggybacks on workingDir.focus. The
  // pane name list mirrors the PaneFocus type so the LLM sees valid
  // targets up-front.
  const VALID_PANES: readonly string[] = ['browser', 'preview', 'log', 'scratch', 'obsidian', 'input'];
  bootDashboardWidgetTools({
    initDashboardWidgetTools,
    listWidgetInstanceIds: () => widgetHost.listInstanceIds(),
    getWidget: (id) => widgetHost.get(id) as
      | { type?: string; state?: { focused?: boolean } }
      | null
      | undefined,
    validPanes: VALID_PANES,
    onFocusPane: (name) => {
      setWorkingFocus(name as PaneFocus, 'llm-tool-focusPane');
      draw();
      return true;
    },
    afterToggleFocus: () => { draw(); },
  });

  // Phase 4a (2026-04-20) — widget inspector tools. Snapshot /
  // Describe / Call surface. Wired with the same widgetHost reference
  // so every live instance is inspectable. afterCall triggers draw()
  // so cursor / scroll changes become visible to the LLM on the next
  // Snapshot / Describe round-trip.
  bootDashboardWidgetInspector({
    initWidgetInspectorTools,
    host: widgetHost,
    draw,
  });

  // HT1/HT2 — view switch + widget key-event injection for LLMs.
  bootDashboardViewTools({
    initDashboardViewTools,
    listViews: () => viewRegistry.views.map(v => ({
      id: v.id,
      label: v.label,
      shortcut: v.shortcut,
      active: v.id === activeViewId,
    })),
    switchViewByNeedle: (needle: string) => {
      const def = findDashboardView(viewRegistry, needle);
      if (!def) return null;
      setActiveDashboardView(def);
      return def.id;
    },
    getWidget: (id) => widgetHost.get(id) as { type: string; state: unknown } | null,
    getWidgetDef: (id) => widgetHost.defFor(id),
    buildWidgetContext: (id) => widgetHost.buildContext(id),
    draw,
  });

  let daemonAttached = false;
  const getDashboardStatusLines = () => {
    const cfg = getUserConfig();
    const active = inspectActiveProvider(cfg);
    const reasoningProvider = (['openai-codex', 'openai', 'anthropic', 'gemini', 'grok', 'local', 'openrouter'] as const)
      .find(provider => active.provider === provider || active.provider === `auto:${provider}`);
    let seatsNow: string | null = null;
    try {
      seatsNow = seatsNowLine(readSlashContextNow([]), Date.now());
    } catch (error) {
      debug.log('dashboard.status', 'seats-unreadable', { error: String(error) });
    }
    return buildDashboardStatusLines({
      seatsNow,
      provider: active.provider,
      model: active.model,
      reasoning: reasoningProvider
        ? modelSupportsReasoning(reasoningProvider, active.model)
          ? reasoningLevelLabel(effectiveReasoningLevel(cfg.llm, reasoningProvider, active.model))
          : '미지원'
        : undefined,
      daemonAddress: opts.remote?.url,
      daemonConnected: daemonAttached,
      accountName: active.provider === 'openai-codex' || active.provider === 'auto:openai-codex'
        ? activeCodexAccountView().name : undefined,
      sessionSurfaceLines: buildSessionDashboardStatusLines(resolveSessionSurfaceStatus({ chatModeState })),
      view: String(workingDir.view),
      focus: workingDir.focus,
      cwd: workingDir.cwd,
      preview: dockedPreview.sourceMode,
      starterClosed: closedStarterPanes().length ? closedStarterPanes().map((pane) => paneLabel(pane)).join(', ') : 'none',
      chatOnly: `${effectiveChatOnlyMode() ? 'on' : 'off'}${chatOnlyMode ? ' (manual)' : ''}`,
      acp: dashboardAcpChat.isBusy() ? 'busy' : 'idle',
    });
  };

  bootDashboardSlashExecutor({
    initDashboardSlashExecutor,
    allowedSlashes: ALLOWED_SLASHES,
    executeImmediateDashboardSlash,
    immediateDeps: {
      getStatusLines: getDashboardStatusLines,
      openPaneModal: (pane) => openDashboardPaneModal(pane),
      openBrowserPreviewModal: () => openBrowserPreviewModal(),
      openSurfaceCatalog: () => {
        openSurfaceCatalogPopup();
        return true;
      },
      openSurfaceInVw: () => false,
      openCompanionSurface: (surface, target) => {
        if (target === 'vw') return false;
        setCompanionPopupOpen(surface, true);
        return true;
      },
    },
    appendInputPrefix: (text) => { inputPrefixState.appendInline(text); },
    pushMutedLine: (line) => { pushDebugLine(C.muted(line)); },
    pushMutedLines: (lines) => { pushDebugLines(lines.map(line => C.muted(line))); },
    draw,
  });

  // Register attachments for the given absolute paths via tokenizeInput,
  // then append the resulting tokens to pendingInputPrefix so the next
  // input-mode entry shows them pre-filled. The log gets a summary so
  // the user sees what was attached even before opening input.
  const attachWorkingDirSelection = (paths: string[]): void => {
    attachDashboardWorkingDirSelection(paths, {
      tokenizeInput: (text) => tokenizeInput(text, contextRegistry),
      onWarning: (warning) => {
        const reason = warning.reason === 'not-a-file' ? 'not a regular file' : 'not found';
        pushDebugLine(C.warning(`  ⚠ ${warning.raw} — ${reason}`));
      },
      // Bridge the minimal duck-typed entry shape to the concrete
      // renderAttachmentSummary contract (same pattern as the other two
      // call sites in this file).
      renderAttachmentSummary: (added) => renderAttachmentSummary(added as never),
      appendInputPrefix: (text) => { inputPrefixState.appendInline(text); },
    });
  };

  // Shared log-pane key handler. Called from both skill-workspace
  // (focus === 'log') and working-dir workspace (workingDir.focus ===
  // 'log') so scroll / copy / resize / raw-toggle behave identically
  // across workspaces.
  //
  // Phase 7 Batch A (2026-04-20) — scroll keys (j/k/g/G/Home/End/
  // PgUp/PgDn/Ctrl+d/u) now delegate to the log widget's Scrollable
  // behavior via dispatchKeyToWidget. chatScrollOffset stays the
  // dashboard-local source of truth (300+ call sites); the pane
  // handler syncs scroll <-> scrollOffset around the dispatch. When
  // the post-dispatch scroll is at the tail, we snap back to -1 to
  // re-engage auto-follow; this preserves the existing tail-sticky
  // UX while the keymap itself lives in the reusable behavior.
  const handleLogPaneKey = async (key: import('../tui.js').Key): Promise<void> => {
    const { rows: tr } = termSize();
    const sH = computeLogH(tr);
    const halfSH = Math.max(1, Math.floor(sH / 2));
    const maxScr = Math.max(0, chatLines.length - sH);
    // Scroll keys → Scrollable behavior on wd-log. Sync pre/post.
    const SCROLL_KEYS = new Set([
      'j', 'k', 'down', 'up',
      'g', 'G', 'home', 'end',
      'pageup', 'pagedown',
    ]);
    const isCtrlHalfPage = key.ctrl && (key.name === 'd' || key.name === 'u');
    if (SCROLL_KEYS.has(key.name) || isCtrlHalfPage) {
      // Phase 7 Batch A bridge — scroll field mirrors chatScrollOffset
      // during dispatch; the LogWidgetState contract lives in
      // widgets/log/widget.ts (cross-dir rootDir restriction is why
      // this uses an inline shape instead of importing the type).
      const logInst = widgetHost.get('wd-log') as {
        state: {
          scroll: number;
          maxScroll?: number;
          pageSize?: number;
          halfPageSize?: number;
        };
      } | null;
      if (logInst) {
        logInst.state.scroll = chatScrollOffset < 0 ? maxScr : chatScrollOffset;
        logInst.state.maxScroll = maxScr;
        logInst.state.pageSize = sH;
        logInst.state.halfPageSize = halfSH;
        if (debug.enabled) {
          debug.log('log-pane.scroll.pre-dispatch', key.name || '(empty)', {
            chatScrollOffset, scroll: logInst.state.scroll, maxScr,
          });
        }
        dispatchKeyToWidget(widgetHost, 'wd-log', key);
        const next = logInst.state.scroll;
        const wasAtTail = chatScrollOffset === -1;
        chatScrollOffset = next >= maxScr ? -1 : Math.max(0, next);
        // Scroll-freeze transitions. Tail → scrolled: snapshot current
        // chatLines length so new output stops appearing under the
        // user. Scrolled → tail: release the freeze so the user sees
        // the full backlog again (the existing maxScr branch handles
        // "scrolled all the way down" too).
        if (logFreezeEnabled) {
          if (wasAtTail && chatScrollOffset >= 0 && logFrozenTailIndex === null) {
            logFrozenTailIndex = chatLines.length;
            if (debug.enabled) {
              debug.log('log-pane.freeze.set', `idx=${logFrozenTailIndex}`);
            }
          } else if (chatScrollOffset === -1 && logFrozenTailIndex !== null) {
            if (debug.enabled) {
              debug.log('log-pane.freeze.clear', `queued=${chatLines.length - logFrozenTailIndex}`);
            }
            logFrozenTailIndex = null;
          }
        }
        if (debug.enabled) {
          debug.log('log-pane.scroll.post-dispatch', key.name || '(empty)', {
            scrollAfter: next, chatScrollOffsetAfter: chatScrollOffset, maxScr,
            frozenTailIndex: logFrozenTailIndex,
          });
        }
      }
      return;
    }
    switch (key.name) {
      case '+': case '=':
        logHeightBias += 1; computePaneH(termSize().rows); break;
      case '-': case '_':
        logHeightBias -= 1; computePaneH(termSize().rows); break;
      case '0':
        logHeightBias = 0; break;
      case 'l':
        if (key.ctrl) {
          chatLines.length = 0;
          attachmentRowMap.clear();
          clearLogSearch();
          clearLogFilter();
          pushDebugLine(C.muted('Log cleared.'));
          chatScrollOffset = -1;
        }
        break;
      case 's':
        // In-pane search — opens the modal. Keep the key simple
        // rather than hijacking `/` (which is the global input
        // trigger) so muscle memory stays clean.
        if (!key.ctrl && !key.shift && !key.meta) {
          openLogSearchModal();
        }
        break;
      case 'n':
        // vim-like: `n` = next match, `N` = previous (same key
        // + shift). key.name stays 'n' in both cases; shift bit
        // distinguishes direction.
        if (!key.ctrl && !key.meta) {
          gotoNextMatch(key.shift ? -1 : 1);
          draw();
        }
        break;
      case 'escape':
        if (logSearchQuery || logSearchResults.length > 0) {
          clearLogSearch();
          draw();
        }
        break;
      case 'f':
        // Unified fold toggle — walks the FoldStack and flips the
        // topmost target (live footer during a batch, or the most
        // recent static fold after a run). Extend fold coverage by
        // registering more runtime-emitted targets with FoldStack.
        if (!foldStack.toggleTop()) {
          pushDebugLine(C.muted('(nothing to fold/unfold)'));
          chatScrollOffset = -1;
        }
        break;
      case 'F':
        // Bulk toggle — expand ALL static folds, or collapse all if
        // ≥ half were already expanded. Live footer (if any) is
        // untouched; use plain `f` to toggle that separately.
        {
          const changed = foldStack.toggleAll();
          if (changed === 0) {
            pushDebugLine(C.muted('(nothing to fold/unfold)'));
            chatScrollOffset = -1;
          }
        }
        break;
      case 'r': case '\u3131':
        {
          const toggled = toggleDashboardAssistantRenderState({
            state: {
              lastAssistantRaw,
              lastAssistantRange,
              lastAssistantMode,
            },
            termCols: termSize().cols,
            wrapOpts: getUserConfig().chat.rendering.wrap,
            chatLines,
            formatResponse,
            text: (line) => C.text(line),
          });
          if (toggled.applied) {
            ({
              lastAssistantRaw,
              lastAssistantRange,
              lastAssistantMode,
            } = toggled.nextState);
            chatScrollOffset = -1;
          } else {
            pushDebugLine(C.muted('(no LLM response to toggle yet)'));
            chatScrollOffset = -1;
          }
        }
        break;
    }
    if (await handleLogPaneCopyAction(key)) return;
  };

  /**
   * Attach a streaming-window key listener that keeps the log pane
   * responsive while streamLLM() is blocking the main readKey loop.
   *
   * Allowed keys (all route through `handleLogPaneKey` so behavior
   * matches the focused log pane exactly):
   *   j/k/↓/↑        scroll 1 line
   *   Ctrl+D/Ctrl+U  half-page
   *   PgDn/PgUp      full page
   *   g/G/Home/End   top / bottom
   *   f              fold/unfold topmost fold target (live footer
   *                  during a batch, else most-recent batch-launch
   *                  tree committed to the transcript)
   *   F              bulk toggle: expand all static folds (or
   *                  collapse all if ≥ half already expanded)
   *   Esc            abort (falls through to controller.abort())
   *
   * Sets `userScrolledDuringStream = true` on any scroll key so
   * chunk callbacks (which call `pinChatTail()`) stop slamming the
   * log back to tail. The flag resets when the cleanup returned by
   * this function is invoked.
   */
  const escAbortToolState = createEscAbortToolState();
  const escHarnessSpacesByCallId = new Map<string, string>();
  setSelfImplementSoftStopSpaceObserver((callId, spaceId) => {
    const toolName = escAbortToolState.activeToolNamesByCallId.get(callId);
    if (toolName && (SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(toolName)) {
      escHarnessSpacesByCallId.set(callId, spaceId);
    }
  });
  let clarificationModalId: string | null = null;

  const attachChatStreamingKeys = (abortCtrl: AbortController): () => void => {
    const chatLinesStartIndex = chatLines.length;
    userScrolledDuringStream = false;
    streamingInFlight = true;
    const SCROLL_KEYS = new Set(['j', 'k', 'down', 'up', 'pageup', 'pagedown', 'home', 'end', 'g', 'G']);
    // T3-B2: ESC abort gate. When the user hits Esc AND sub-agent
    // work is running, pop a confirmation modal before tearing down
    // the stream — the running count is visible in the HUD (T3-B1)
    // so the user can make an informed call.
    let abortGateModalId: string | null = null;
    const showHarnessEscHint = createHarnessEscHint((line) => pushChatLine(line));
    let stoppedHarnessSpace: string | null = null;
    const activeHarnessSpace = (): string | null => activeEscHarnessSpace(escAbortToolState, escHarnessSpacesByCallId);
    const escGate = createEscAbortGate({
      abortCtrl,
      getRunningCount: () => getEscAbortRunningCount(escAbortToolState),
      mountModal: (surface) => {
        attachSurfaceToWorkspace(surface, currentWorkspaceOwnerId());
        abortGateModalId = surface.id;
        const h = display.pushModal(surface);
        return () => { abortGateModalId = null; try { h.dispose(); } catch { /* ignore */ } };
      },
      getViewport: () => termSize(),
      requestRedraw: () => draw(),
      getTheme: () => currentThemeTokens(),
      getWaitingTargetNames: () => getEscAbortWaitingToolNames(escAbortToolState),
      shouldAbortImmediately: () => activeHarnessSpace() !== null,
      onAbortPending: ({ targets }) => {
        const spaceId = activeHarnessSpace();
        if (spaceId) {
          try {
            enqueueSoftStop(spaceId);
            if (readSoftStopRequestStatus(spaceId).status !== 'present') throw new Error('soft-stop marker not persisted');
            stoppedHarnessSpace = spaceId;
            pushChatLine('  ⏹ 멈췄다 — 해당 하니스 런에 중단 요청을 보냈습니다.');
          } catch {
            pushChatLine('  ⚠ 하니스 런 중단 요청을 보내지 못했습니다. /harness runs 에서 확인해 주세요.');
          }
        } else if (!showHarnessEscHint(targets)) {
          pushChatLine(`  ⏳ 중단 요청됨 — ${formatEscAbortWaitingTargets(targets)} 종료를 기다리는 중입니다.`);
        }
        chatScrollOffset = -1;
      },
      onAbortRepeat: ({ repeat, targets }) => {
        if (!stoppedHarnessSpace && !showHarnessEscHint(targets)) {
          pushChatLine(`  ⏳ ESC 재시도 ${repeat}회 — ${formatEscAbortWaitingTargets(targets)} 종료를 기다리는 중입니다.`);
        }
        chatScrollOffset = -1;
      },
      // ⭐⭐⭐ 턴을 멈추기 «전»에 살아남을 자식을 백그라운드 라우팅으로 넘긴다(`R4a` · 2026-08-19).
      //   ⛔ 없으면 `R1` 이후 자식이 «고아»가 된다 — 살아 있는데 완료를 실어 나를 채널이 없다
      //     (`task-notification` 은 background 만 본다 · 부모 툴 루프는 턴과 함께 사라졌다).
      //   ⭐ 묻지 않는다. 넘기고 «값으로» 남긴다 — 이것이 대표 「최소 HITL」의 형태다.
      handoffSurvivingChildren: () => {
        try {
          const moved = globalAgentRegistry.markBackgroundAllRunning();
          if (moved.length > 0) {
            debug.log('agent.task-routing', 'handoff-to-background-on-turn-abort', {
              count: moved.length, taskIds: moved.slice(0, 6), reason: 'turn-aborted-children-survive',
            });
            pushChatLine(`  ⏳ 자식 ${moved.length}개는 백그라운드에서 계속됩니다 — 끝나면 알려 드립니다.`);
          }
        } catch { /* 관측·핸드오프가 중단을 막지 않는다 */ }
      },
    });

    // Scroll the log pane by ±N rows from whatever the current tail-
    // relative offset resolves to. Shared by keyboard and mouse-wheel
    // paths so they behave identically. `delta` positive = scroll down,
    // negative = scroll up.
    const scrollLogBy = (delta: number): void => {
      const { rows: tr } = termSize();
      const sH = computeLogH(tr);
      const maxScr = Math.max(0, chatLines.length - sH);
      const cur = chatScrollOffset < 0 ? maxScr : chatScrollOffset;
      let next = Math.max(0, Math.min(cur + delta, maxScr));
      if (delta > 0 && next >= maxScr) next = -1; // re-pin tail
      if (debug.enabled) {
        debug.log('log.wheel', 'scrollLogBy', {
          delta,
          rows: tr,
          logHeight: sH,
          maxScr,
          before: chatScrollOffset,
          resolvedBefore: cur,
          next,
          focus: workingDir.focus,
          viewMode: currentViewMode.kind,
        });
      }
      chatScrollOffset = next;
      userScrolledDuringStream = true;
    };

    // ── Streaming-mode mouse dispatch (A-5 migration · A-6 cleanup) ──
    //
    // `runStreamingMouseUnifiedDispatch` is the only streaming-mouse
    // path (A-6 removed the legacy fallback).
    // routeInputEvent with `ViewMode={kind:'streaming'}` + route
    // callbacks wraps `mouseWiring.handleMouse` / pane-nav hit /
    // `dispatchLogZoneClick` / wheel `scrollLogBy`.
    //
    // Scope note — A-5 migrated ONLY the MOUSE sub-block of the
    // streaming handler. The KEY portion (ESC gate · Ctrl+Q hard-
    // quit · scroll keys · Tab/Ctrl+T/G · `/` reopen · log-and-drop)
    // stays inline in the handler because much of it has async
    // `await handleLogPaneKey(key)` which doesn't round-trip cleanly
    // through the current sync RouteCallbacks contract, and the
    // pre-dispatch gates (escGate / hard-quit) must run BEFORE any
    // dispatcher viewMode switch so routeInputEvent would have to
    // re-expose them as callbacks anyway.
    //
    // Helper is defined inside the streaming-setup closure so it
    // shares the same `abortCtrl` / `workingDir` / `chatScrollOffset`
    // / `paneNavRow` / `paneNavHitAreas` / `scrollLogBy` /
    // `setWorkingFocus` / `dispatchLogZoneClick` / `firstPaneOfView`
    // / `currentViewMode` / `termSize` / `computePaneH` / `debug`
    // references the attachStreamingKeys arrow captures.
    const runStreamingMouseUnifiedDispatch = (k: TuiKey): void => {
      const m = k.mouse;
      if (!m) return;                                     // should never happen · caller gates
      const displayMouse = { ...m, shift: k.shift, ctrl: k.ctrl, alt: k.alt };
      mouseWiring.preflightHitTarget(m);
      const ev: InputCoreMouseInputEvent = inputCoreBuildMouseEventFromDisplay(m, {
        shift: k.shift, ctrl: k.ctrl,
      });
      const streamingViewMode: ViewMode = { kind: 'streaming' };
      const routes: InputCoreRouteCallbacks = {
        routeMouseWiring: () => {
          const consumed = mouseWiring.handleMouse(displayMouse);
          // DS-3a · source-side drag evaluation AFTER hit classification
          // (mouseWiring attaches `ev.hitTarget` during handleMouse).
          // Must not swallow the consumed flag — dragWire doesn't
          // consume events, only begins sessions.
          dragWire.onMouse(displayMouse);
          return consumed ? 'consumed' : 'passthrough';
        },
        routePaneNavClick: () => {
          if (m.type !== 'click') return 'passthrough';
          if (paneNavRow === null || m.row !== paneNavRow) return 'passthrough';
          const target = paneAtColumn(paneNavHitAreas, m.col - 1);
          if (target === null) return 'passthrough';
          setWorkingFocus(target, 'pane-nav-click');
          return 'consumed';
        },
        // Wheel + click routing to log zone. Mirror the legacy body's
        // scroll-wheel branch (scrollLogBy) + click branch (dispatchLogZoneClick
        // with streaming focus-follow + out-of-zone upper-half
        // fallback).
        routeLogZoneClick: (_ev, allowFocusSteal) => {
          debug.log('log.mouse', 'streaming-route-reached', { type: m.type });
          if (m.type === 'scroll-up') {
            scrollLogBy(-3);
            return 'consumed';
          }
          if (m.type === 'scroll-down') {
            scrollLogBy(3);
            return 'consumed';
          }
          if (m.type === 'click') {
            const { rows: tr } = termSize();
            const pH = computePaneH(tr);
            const logOutcome = dispatchLogZoneClick(m);
            if (logOutcome === 'consumed') {
              if (allowFocusSteal && workingDir.focus !== 'log') {
                applyFocusToPaneTransition(resolveFocusToPaneTransition({
                  targetPane: 'log',
                  reason: 'log-area-click (streaming)',
                }));
              }
              return 'consumed';
            }
            if (logOutcome === 'out-of-zone' && m.row <= pH) {
              if (allowFocusSteal) {
                setWorkingFocus(firstPaneOfView(workingDir.view), 'pane-area-click');
              }
              return 'consumed';
            }
          }
          return 'passthrough';
        },
      };
      const ctx: InputCoreDispatchContext = {
        viewMode: streamingViewMode,
        policy: inputCoreDerivePolicyForViewMode(streamingViewMode),
        routes,
        dragManager: display.dragManagerAPI(),
        interceptors: dispatchInterceptors,
      };
      const outcome = inputCoreRouteInputEvent(ev, ctx);
      if (outcome === 'consumed') {
        draw();
        return;
      }
      // Passthrough: log-and-drop parity with legacy's else-debug branch.
      if (debug.enabled) {
        debug.log('key.dropped', 'mouse', {
          type: m.type,
          streaming: true,
          viewMode: currentViewMode.kind,
          unified: true,
        });
      }
    };

    const isStreamingImmediateSlash = (text: string): boolean => {
      const { cmdLower } = resolveDashboardChatMainSlashCommand(text);
      return dashboardSlashRegistry.isImmediateDuringStream(cmdLower);
    };
    const dispatchStreamingImmediateSlash = async (text: string): Promise<boolean> => {
      const { cmdLower, args } = resolveDashboardChatMainSlashCommand(text);
      try {
        const outcome = await dashboardSlashRegistry.dispatch(cmdLower, args, {
          chatLines,
          setChatScrollOffset: (offset: number) => { chatScrollOffset = offset; },
          warning: C.warning,
          childScreen: {
            runId: () => getHarnessRunId(process.env),
            list: listDashboardChildScreens,
            snapshot: (id: string, manifestDbPath: string) => runPtySnapshot(id, {
              getPty,
              requestPtyTakeover,
              requestRemote: (ptyId, action, payload, options) => requestRemotePtyControl(ptyId, action, payload, { ...options, manifestDbPath }),
              listRefs: () => [{ id, kind: 'self', source: 'remote', alive: true }],
              log: () => {},
            }),
            show: ({ title, lines }: { title: string; lines: readonly string[] }) => {
              const { cols, rows } = termSize();
              showTransientTerminalModal({ title, lines: [...lines], coordinator: display, termCols: cols, termRows: rows, ttlMs: 5000, group: 'harness-child-screen' });
            },
          },
        } as unknown as DashboardSlashContext);
        draw();
        return outcome.kind !== 'unregistered';
      } catch (error) {
        chatLines.push(C.error(`  /${cmdLower} failed: ${error instanceof Error ? error.message : String(error)}`));
        chatScrollOffset = -1;
        draw();
        return false;
      }
    };

    // ── Streaming key ladder · A-5b.1 migration ────────────────
    //
    // Runs keys (non-pre-dispatch-gate) through `routeInputEventAsync`
    // with `ViewMode={kind:'streaming'}` and `routeStreamingKeyAsync`
    // wrapping the full key ladder (scroll · fold · Tab / Ctrl+T ·
    // Ctrl+G · `/` reopen). Preserves:
    //   - escGate · Ctrl+Q · mouse handoff as **pre-dispatch gates**
    //     (upstream of dispatcher · dispatcher never sees them).
    //   - A-8 ESC guard fires when drag is active (the direct-cancel
    //     at the ESC gate is a belt-and-suspenders safety net · A-5b.3
    //     will remove it once A-8 activation is dog-fooded).
    //   - `await handleLogPaneKey` semantics intact (async callback).
    const runStreamingKeyUnifiedDispatch = async (key: TuiKey): Promise<void> => {
      const ev = inputCoreKeyEvent(key);
      const streamingViewMode: ViewMode = { kind: 'streaming' };
      const routes: InputCoreRouteCallbacks = {
        routeStreamingKeyAsync: async (kev) => {
          const k = kev.key;
          // ⛔⭐⭐⭐ **「스트리밍 리스너에 키가 «오나»」를 값으로**(2026-08-19 · `OBS-T127`).
          //   🚨 `dashboard.turn-typeahead` 가 0인데 사다리는 걸린다(`OBS-T124`).
          //     남은 갈림: ⓐ 키가 여기 «안 온다» ⓑ 와서 typeahead 가 «소유를 못 한다»
          //   ⇒ 이 한 줄이 그 둘을 «값으로» 가른다. 오면 ⓑ, 안 오면 ⓐ.
          //   ⛔ 행동을 안 바꾼다. 키 «이름»만 남긴다(내용 유출 방지).
          try {
            debug.log('dashboard.streaming-key', 'arrived', {
              key: k.name, ctrl: !!k.ctrl, alt: !!k.alt, kind: k.kind ?? null,
            });
          } catch { /* fail-soft */ }
          // ── C-d-3' · 턴 중 타이핑 보존 (essential 전용 · CC/codex 동형) ──
          // printable/backspace/enter 를 typeahead 버퍼가 소유 + 즉시 에코.
          // j/k/f 등 문자키는 streaming 입력으로 보존하고 스크롤은 PgUp/방향키/휠이 담당한다.
          // ⭐⭐⭐ `R4a` 명시 승격(2026-08-19 · 대표 ⑤⑦ · 대표 지시로 `Ctrl+B` 를 코드 리더에서 «비웠다»).
          //   claude-code `task:background`(ctrl+b)와 동형 — ***도는 자식을 백그라운드로 옮긴다.***
          //   ⛔ 턴은 «안» 멈춘다 — 멈추는 것은 ESC 다. 이 키는 「보고 있지 않겠다」는 뜻이다.
          //   ⭐ 넘어가면 완료가 `task-notification` 으로 부모 이력에 돌아온다(재발명 0).
          if (k.ctrl && (k.name === 'b' || k.name === 'ㅠ')) {
            try {
              const moved = globalAgentRegistry.markBackgroundAllRunning();
              debug.log('agent.task-routing', 'handoff-to-background-by-key', {
                count: moved.length, taskIds: moved.slice(0, 6), key: 'ctrl+b',
              });
              pushChatLine(moved.length > 0
                ? `  ⏳ 자식 ${moved.length}개를 백그라운드로 옮겼습니다 — 끝나면 알려 드립니다.`
                : '  (지금 백그라운드로 옮길 자식이 없습니다)');
              draw();
            } catch { /* 승격 실패가 스트리밍을 막지 않는다 */ }
            return 'consumed';
          }
          const r = applyTurnTypeaheadKey(turnTypeaheadRef.state, k, isStreamingImmediateSlash);
          if (r.consumed) {
            turnTypeaheadRef.state = r.state;
            if (r.submissionDisposition) {
              debug.log('dashboard.turn-typeahead', 'submission-classified', {
                length: (r.immediateSubmission ?? turnTypeaheadRef.state.queuedSubmissions.at(-1))?.length ?? 0,
                disposition: r.submissionDisposition,
              });
              // ⭐⭐⭐ `B3`(2026-08-19 · 대표 지시 ②) — FIFO 로 «턴 종료 후» 나가던 것을,
              //   ***도는 턴 «안»(루프 경계)***으로도 보낸다.
              //   ⛔ 중복 전송 방지가 계약이다: 레지스트리가 배수되면 `onDrained` 가
              //     ***여기 큐도 같이 비운다*** — 안 그러면 같은 발화가 턴 끝에 «또» 나간다.
              //   ⚠️ `immediate`(슬래시 등)는 지금 실행되므로 «넣지 않는다».
              if (r.submissionDisposition === 'fifo' && !r.immediateSubmission) {
                const queuedText = turnTypeaheadRef.state.queuedSubmissions.at(-1);
                const sid = activeSessionIdForTypeahead();
                if (queuedText && sid) {
                  const queuedHistoryEntry = inputHistoryStore.record({
                    text: queuedText,
                    cwd: workingDir.cwd,
                    activeView: activeViewId,
                    focusedPane: String(workingDir.focus),
                    metadata: {
                      chatOnlyMode: effectiveChatOnlyMode(),
                      provider: inspectActiveProvider().provider,
                    },
                  });
                  if (queuedHistoryEntry) refreshInputHistory();
                  enqueuePendingUserInput(sid, queuedText, (drained) => {
                    // 배수된 만큼을 앞에서부터 떨어낸다(FIFO · 순서 보존).
                    const remaining = turnTypeaheadRef.state.queuedSubmissions.slice(drained.length);
                    turnTypeaheadRef.state = { ...turnTypeaheadRef.state, queuedSubmissions: remaining };
                    for (const text of drained) {
                      echoSubmittedUserText(text, { live: true });
                      debug.log('dashboard.turn-typeahead', 'echoed', { path: 'live', length: text.length });
                    }
                    if (drained.length > 0) draw();
                    debug.log('dashboard.turn-typeahead', 'drained-into-live-turn', {
                      drained: drained.length, remaining: remaining.length,
                    });
                  });
                }
              }
            }
            if (r.immediateSubmission) {
              turnTypeaheadRef.state = await dispatchStreamingTurnTypeaheadSubmission(
                turnTypeaheadRef.state,
                r.immediateSubmission,
                dispatchStreamingImmediateSlash,
              );
            }
            if (r.changed) paintTurnTypeaheadEcho();
            return 'consumed';
          }
          // ── Keyboard scroll keys ────────────────────────────────
          const isScroll = SCROLL_KEYS.has(k.name)
            || (k.ctrl && (k.name === 'd' || k.name === 'u'));
          if (isScroll) {
            userScrolledDuringStream = true;
            // Focus-aware routing — when the user is looking at the
            // sub-agent roster, j/k/g/G should navigate the roster.
            const agentsFocused = workingDir.focus === 'agent-roster';
            if (agentsFocused) {
              const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
              const n = roster.length;
              if (n > 0) {
                switch (k.name) {
                  case 'j': case 'down':
                    agentRosterCursor = Math.min(agentRosterCursor + 1, n - 1); break;
                  case 'k': case 'up':
                    agentRosterCursor = Math.max(0, agentRosterCursor - 1); break;
                  case 'g': case 'home':
                    agentRosterCursor = 0; break;
                  case 'G': case 'end':
                    agentRosterCursor = n - 1; break;
                  default:
                    await handleLogPaneKey(k);
                }
                agentCursorManual = true;
                const cur = roster[agentRosterCursor];
                if (cur) agentCursorLockedId = cur.id;
              }
            } else {
              await handleLogPaneKey(k);
            }
            draw();
            return 'consumed';
          }

          // ── Live Agent-batch fold toggle ────────────────────────
          if (k.name === 'f' && !k.ctrl && !k.shift) {
            await handleLogPaneKey(k);
            draw();
            return 'consumed';
          }

          // ── Pane-focus keys (Phase 6) · Tab / Ctrl+T / Ctrl+G / `/`
          if (k.name === 'tab') {
            setWorkingFocus(tabNext(workingDir.focus, k.shift ? -1 : 1), 'tab-cycle-streaming');
            draw();
            return 'consumed';
          }
          if (k.ctrl && (k.name === 't' || k.name === 'ㅅ')) {
            setWorkingFocus(
              workingDir.focus === 'input'
                ? firstPaneOfView(workingDir.view)
                : tabNext(workingDir.focus, 1),
              'ctrl-t-streaming',
            );
            draw();
            return 'consumed';
          }
          if (k.ctrl && (k.name === 'g' || k.name === 'ㅎ')) {
            applyFocusToPaneTransition(resolveFocusToPaneTransition({
              targetPane: 'log',
              reason: 'ctrl-g-streaming',
            }));
            draw();
            return 'consumed';
          }
          if (k.ctrl && (k.name === 'l' || k.name === 'L' || k.name === 'ㅣ')) {
            // Ctrl+L = 화면 클리어+리페인트(입력 재진입 폐기 · 2026-07-12).
            // 스트리밍 중에도 안전 — draw 는 어차피 청크마다 돌고 있다.
            // (runChatMainGlobalAction 은 이 스코프 밖 — 레시피 인라인.)
            try { process.stdout.write(ansi.clear); } catch { /* ignore */ }
            draw({ force: true });
            return 'consumed';
          }
          if (k.name === '/' && workingDir.focus !== 'input') {
            // `/` in agent-roster pane opens a search modal (P4.1).
            const inAgentRoster = workingDir.focus === 'agent-roster';
            if (inAgentRoster && !agentSearchModal) {
              openAgentRosterSearch();
              draw();
              return 'consumed';
            }
            // Flip focus to input · next main-loop iteration sees
            // focus=input-auto-entry path (wdAutoInput).
            applyFocusToInputTransition(resolveFocusToInputTransition({
              sourcePane: workingDir.focus,
              rememberPane: true,
              mode: 'slash',
              reason: 'slash-reopen-input-streaming',
            }));
            draw();
            return 'consumed';
          }
          return 'passthrough';
        },
      };
      const ctx: InputCoreDispatchContext = {
        viewMode: streamingViewMode,
        policy: inputCoreDerivePolicyForViewMode(streamingViewMode),
        routes,
        dragManager: display.dragManagerAPI(),
        interceptors: dispatchInterceptors,
      };
      const outcome = await inputCoreRouteInputEventAsync(ev, ctx);
      if (outcome === 'consumed') return;
      // ── Log-and-drop (dispatcher passthrough) ──────────────
      // Remaining keys don't have a clear streaming-time semantic.
      // The listener STILL consumes the stdin byte (can't put it
      // back), so log so future "my key didn't work" reports land in
      // seconds instead of hours.
      if (debug.enabled) {
        debug.log('key.dropped', `${key.ctrl ? 'C-' : ''}${key.shift ? 'S-' : ''}${key.name}`, {
          streaming: true,
          focus: workingDir.focus,
          scratchMode,
          unifiedAsync: true,
        });
      }
    };

    const cleanup = attachStreamingKeys(async (key) => {
      // ── Pre-dispatch gates ────────────────────────────────────
      //
      // These run BEFORE `routeInputEventAsync` because:
      //   - escGate owns its own modal state machine — ESC must reach
      //     `escGate.handleKey` when the gate is open.
      //   - Ctrl+Q calls `process.exit(0)` · cannot proceed to the
      //     dispatcher anyway.
      //   - The mouse handoff (`key.mouse` existence check) hands
      //     off to `runStreamingMouseUnifiedDispatch` which owns the
      //     mouse dispatch path.
      //
      // A-5b.3 replaced the streaming-ESC direct drag-cancel with a
      // dispatcher-first route: ESC goes through `routeInputEventAsync`
      // whose A-8 guard consumes drag-active ESC · non-consumed ESC
      // falls through to `escGate.handleEscape()`. Dispatcher is the
      // single source of truth for drag-ESC cancel in streaming mode.

      // A live abort modal owns every key. Otherwise, Escape first gives
      // the drag interceptor a chance to consume and only then reaches the
      // existing gate, which preserves its confirmation/abort contract.
      const streamingEscapeConsumed = await routeStreamingEscapeKey(
        key,
        escGate,
        toDashboardKeyEvent(key),
        async () => {
          if (key.name !== 'escape') return false;
          const ev = inputCoreKeyEvent(key);
          const streamingViewMode: ViewMode = { kind: 'streaming' };
          const ctx: InputCoreDispatchContext = {
            viewMode: streamingViewMode,
            policy: inputCoreDerivePolicyForViewMode(streamingViewMode),
            routes: {},
            dragManager: display.dragManagerAPI(),
            interceptors: dispatchInterceptors,
          };
          return (await inputCoreRouteInputEventAsync(ev, ctx)) === 'consumed';
        },
        () => {
          const modal = topModalSurface({ focusStack: display.modalStack(), surfaceAt: id => display.surface(id) });
          if (modal?.windowRole === 'companion') return false;
          const askHandle = approvalModalRouter.currentKind() === 'askUser' ? approvalModalRouter.current() : null;
          const topModalId = () => topModalSurface({ focusStack: display.modalStack(), surfaceAt: id => display.surface(id) })?.id ?? null;
          return consumeStreamingTopModalEscape({
            modal,
            abortGateModalId,
            event: toDashboardKeyEvent(key),
            question: askHandle ? {
              id: askHandle.surface.id,
              dispose: (cancelled) => askHandle.dispose(cancelled),
              isClarification: askHandle.surface.id === clarificationModalId,
            } : undefined,
            onClarificationClosed: () => {
              pushChatLine('되묻기 창을 닫았다 — 답 없이 진행한다');
              chatScrollOffset = -1;
            },
            topModalId,
            redraw: draw,
          });
        },
      );
      if (streamingEscapeConsumed) return;
      if (routeStreamingApprovalModalKey(key)) return;
      // ── Hard quit (Ctrl+Q) ────────────────────────────────────
      // A runaway streaming turn must always have a safe exit short
      // of SIGINT from another terminal.
      if (key.ctrl && (key.name === 'q' || key.name === 'ㅂ')) {
        abortCtrl.abort();
        exitDashboardTui();
        setTimeout(() => process.exit(0), 0);
        return;
      }

      // ── Mouse wheel scroll + click focus ──────────────────────
      // Streaming-mode mouse dispatch (A-5 · A-6 cleanup removed the
      // legacy fallback). All mouse events during streaming flow
      // through `runStreamingMouseUnifiedDispatch` which uses
      // `routeInputEvent` with `ViewMode={kind:'streaming'}` + route
      // callbacks wrapping mouseWiring / pane-nav / dispatchLogZone-
      // Click + streaming-specific focus-follow rules. See the helper
      // docblock above `scrollLogBy` for the 3 streaming-specific
      // semantics (wheel bypass · log focus-follow · out-of-zone
      // upper-half first-pane fallback).
      if (key.name === 'mouse' && key.mouse) {
        runStreamingMouseUnifiedDispatch(key);
        return;
      }

      // ── Unified key dispatch (A-5b.1) ─────────────────────────
      // Route the remaining key events through `routeInputEventAsync`
      // so the A-8 ESC guard + (future) context-key publish + widget
      // focus key arms become production-active. See
      // `runStreamingKeyUnifiedDispatch` above for the route body.
      await runStreamingKeyUnifiedDispatch(key);
    });
    return () => {
      cleanup();
      escGate.dispose();
      if (!stoppedHarnessSpace) settleEscAbortPendingLines(chatLines, chatLinesStartIndex);
      userScrolledDuringStream = false;
      streamingInFlight = false;
    };
  };

  // ── Working-directory workspace widgets (Phase 3a) ──
  // Reuse the generic list + markdown widgets for folder / file /
  // preview content. Spawned once at startup — dashboard pushes
  // WorkingDirState into them each draw via syncWorkingDirWidgetState.
  const workingDir: WorkingDirState = createWorkingDirState(process.cwd());
  try { refreshWorkingDir(workingDir); } catch { /* empty cwd is fine */ }
  previewPaneRegistry = new PreviewPaneRegistry();
  const dockedPreview = previewPaneRegistry.ensure('wd-preview', { mode: 'docked' });
  // ── T2 + X1 (Phase 1) — wire production deps into the surface-intent
  // consumer chain now that clipboardActions + previewPaneRegistry are
  // both live. The placeholder consumers were registered earlier with
  // closures that read `pfcMouseActionRuntimeRef.current`; this is
  // where the binding becomes non-null.
  pfcMouseActionRuntimeRef.current = createPfcMouseActionRuntime({
    resolveBuffer: (surfaceId) => {
      const model = previewPaneRegistry.get(surfaceId);
      return model ? model.previewLines : null;
    },
    writeClipboard: async (text) => {
      try { return await writeClipboard(text); } catch { return false; }
    },
    pushChatLine: (line) => { pushChatLine(C.muted(line)); },
    caretStore: pfcCaretContextStore,
    logDebug: (category, event, data) => debug.log(category, event, data),
  });
  if (debug.enabled) {
    debug.log('terminal.intent.production-deps', 'wired', {
      hasClipboard: true,
      hasPreviewBuffer: true,
    });
  }
  const refreshRemotePreviewBridge = async (): Promise<void> => {
    await refreshRemoteWorkingDirPreview(workingDir, {}, dockedPreview);
  };
  const startRemoteModeBridge = (host: import('../ssh/ssh-hosts.js').SshHost, cwd: string = '.'): void => {
    startRemoteMode(workingDir, host, cwd, dockedPreview);
  };
  const endRemoteModeBridge = (): void => {
    endRemoteMode(workingDir, dockedPreview);
  };
  // Per-instance browser state directory. The default browser
  // (View 1's `wd-browser` and View 3's `wd-working-browser`) keeps
  // pointing at the singleton above — registering both ids surfaces
  // it to clone consumers (foreground modal browsers etc.) regardless
  // of which view spawned the modal. See `working-dir/registry.ts`.
  browserPaneRegistry = new BrowserPaneRegistry();
  browserPaneRegistry.register('wd-browser', workingDir as BrowserPaneModel);
  browserPaneRegistry.register('wd-working-browser', workingDir as BrowserPaneModel);
  const resolveBrowserStateById = (browserId?: string | null): BrowserPaneModel | null => {
    if (!browserId) return null;
    return browserPaneRegistry.get(browserId);
  };
  const activeBrowserWidgetId = (): string => browserWidgetInstanceIdForView(workingDir.view);
  const activeBrowserState = (): BrowserPaneModel => (
    resolveBrowserStateById(activeBrowserWidgetId()) ?? (workingDir as BrowserPaneModel)
  );
  // T7-N1 — ACP chat bridge. Speaks JSON-RPC to claude-code-acp /
  // codex-acp / gemini via the real client in src/acp/*. Subprocess
  // spawn is lazy — no cost until the user runs /acp.
  const dashboardAcpChat = new DashboardAcpChat({
    cwd: () => workingDir.cwd,
    log: (msg) => pushLog('debug', `  [acp] ${msg}`),
    // Follow-up #9 — wrap the modal approver so BG records flip to
    // `waiting_for_confirmation` even when the peer (codex-acp /
    // gemini-cli) doesn't emit the `tool_call_update.status` field.
    // Co-exists with the existing wire-status path · idempotent.
    permissionApprover: withBgApprovalSignals(
      createAcpPermissionApprover(),
      globalBackgroundManager(),
    ),
  });
  activeAcpRuntimeModel = () => dashboardAcpChat.activeRuntimeModel();

  // Obsidian vault browser (Phase O3). Shares the FsEntry shape and
  // sort/hidden helpers with the working-dir browser but stays clamped
  // to the vault root — `..` only surfaces below root. `available=false`
  // keeps the pane rendering a graceful placeholder when the vault
  // isn't set up on this machine.
  const obsidianDir: ObsidianDirState = createObsidianDirState(OBSIDIAN_VAULT);
  try { refreshObsidianDir(obsidianDir); } catch { /* missing vault handled via available */ }

  // Skill view state (Phase S3). Feeds the skill browser + flattened
  // skill-file panes in V3. Both lists rebuild from disk at startup
  // and after each user-initiated skill cursor change.
  const skillView: SkillViewState = createSkillViewState(LOCAL_SKILLS_DIR);
  try { refreshSkills(skillView); refreshSkillFiles(skillView); } catch { /* missing root fine */ }
  // SK2 — a skill the index could not read is a one-line notice with the repair command, never a crash.
  try {
    getSkillIndex();
    const problems = skillIndexProblems();
    const notice = skillRepairNotice(problems);
    if (notice) chatLines.push(C.info(notice));
    // ER1 — tell operations too (consented · scrubbed · async); a kept unsent report is retried once a day.
    void import('../error-report/report.js').then(async ({ reportError, retryPendingErrorReport }) => {
      await retryPendingErrorReport();
      for (const p of problems.slice(0, 3)) {
        const outcome = await reportError({ code: 'skill-index', message: `${p.name}: ${p.code ?? ''} ${p.error}`.trim(), surface: 'tui' });
        if (outcome.sent && outcome.reportId) { chatLines.push(C.muted(`  운영팀에 알렸습니다 (보고 번호 ${outcome.reportId})`)); }
      }
    }).catch(() => { /* reporting never breaks the dashboard */ });
  } catch { /* the notice is advisory */ }

  // Scratch visibility (Phase S5). When closed, the workingDir
  // layouts drop the scratch cell so the remaining panes expand
  // to fill the reclaimed columns — useful on narrow terminals.
  // Reopen via the ^B ^S chord.
  let scratchClosed = false;
  const dashboardViewRegistryOptions = () => ({
    extraPanes: pluginHost.activeDashboardPanes().map(p => p.paneId),
    contributedViews: pluginHost.activeDashboardViews(),
  });
  let viewRegistry: DashboardViewRegistry = buildDashboardViewRegistry(
    getUserConfig().dashboard.views as any,
    dashboardViewRegistryOptions(),
  );
  let activeViewId = viewRegistry.activeId;
  const activeViewDef = (): DashboardViewDef =>
    viewRegistry.views.find(v => v.id === activeViewId) ?? viewRegistry.views[0]!;
  const syncWorkingViewFromActive = (): void => {
    const def = activeViewDef();
    if (workingDir.view !== def.baseView) workingDir.view = def.baseView;
  };
  syncWorkingViewFromActive();
  const setActiveDashboardView = (def: DashboardViewDef): void => {
    const previous = activeViewId;
    activeViewId = def.id;
    workingDir.view = def.baseView;
    const viewPanes = panesForDashboardView(def);
    setWorkingFocus(
      workingDir.focus === 'input'
        ? 'input'
        : viewPanes.includes(workingDir.focus)
          ? workingDir.focus
          : def.primary,
      'view-switch',
    );
    dockedPreview.sourceMode = normalizePreviewSourceForView(
      dockedPreview.sourceMode,
      def.baseView,
    );
    refreshWorkingDirPreview({ force: true });
    if (previous !== def.id) {
      displayEvents.emit({ type: 'view:change', previous, next: def.id, label: def.label });
    }
  };
  const applyDashboardViewsRuntime = (raw: RawDashboardViewsConfig | null): void => {
    const issues = validateDashboardViewsConfig(raw, dashboardViewRegistryOptions());
    if (issues.length > 0) throw new Error(`invalid dashboard view config:\n${issues.join('\n')}`);
    const previous = activeViewDef();
    viewRegistry = buildDashboardViewRegistry(raw, dashboardViewRegistryOptions());
    const next = resolveDashboardViewAfterReload(viewRegistry, previous);
    setActiveDashboardView(next);
  };
  refreshDashboardViewsFromPlugins = () => {
    applyDashboardViewsRuntime(getUserConfig().dashboard.views as any);
  };
  let lastInputVisibilityTrace = '';
  const chatMainInputVisibilityState = (): import('./input/chat-main-visibility.js').ChatMainInputVisibilityState =>
    (() => {
      const blockingForegroundModalOpen = (() => {
        const blockingForegroundModal = topBlockingForegroundModal();
        return blockingForegroundModal !== null;
      })();
      const foregroundWorkspace = topWorkspaceSurface({
        focusStack: display.modalStack(),
        surfaceAt: (id) => display.surface(id),
      });
      // Ownership rule: chat-main belongs to the dashboard-main
      // workspace only. A foreground VW may still preserve host
      // chrome rows (input/status/dock), but that does not mean the
      // main workspace's chat composer remains an active input owner.
      const chatMainAvailable = foregroundWorkspace === null;
      const vwLocalComposerActive = false;
      const overlayInputActive = hasOverlayInputOwner({
        focusStack: display.modalStack(),
        surfaceAt: (id) => display.surface(id),
      });
      const state = createChatMainInputVisibilityState({
        workingFocus: workingDir.focus,
        blockingForegroundModalOpen,
        chatMainAvailable,
        pluginActive: !!pluginHost.active(),
        chordArmed: isChordArmed(chord),
        voiceModeActive: !!voiceInputHost && voiceInputHost.getState().kind !== 'idle',
        vwLocalComposerActive,
        overlayInputActive,
        questionActive: approvalModalRouter.currentKind() === 'askUser',
        inputOwnership: deriveInputOwnershipSnapshot({
          chatMainFocused: workingDir.focus === 'input' && !blockingForegroundModalOpen,
          chatMainAvailable,
          vwLocalComposerActive,
          overlayInputActive,
          questionActive: approvalModalRouter.currentKind() === 'askUser',
        }),
      });
      if (debug.isKeyTraceEnabled()) {
        const nextTrace = JSON.stringify({
          workingFocus: workingDir.focus,
          blockingForegroundModalOpen,
          chatMainAvailable,
          pluginActive: !!pluginHost.active(),
          chordArmed: isChordArmed(chord),
          voiceModeActive: !!voiceInputHost && voiceInputHost.getState().kind !== 'idle',
          vwLocalComposerActive,
          overlayInputActive,
          owner: state.inputOwnership?.owner ?? 'none',
          chatMainSuppressed: state.inputOwnership?.chatMainSuppressed ?? false,
          vwLocalComposerSuppressed: state.inputOwnership?.vwLocalComposerSuppressed ?? false,
        });
        if (nextTrace !== lastInputVisibilityTrace) {
          lastInputVisibilityTrace = nextTrace;
          try {
            debug.log('dashboard.input.visibility', 'change', JSON.parse(nextTrace));
          } catch {
            debug.log('dashboard.input.visibility', 'change', nextTrace);
          }
        }
      }
      return state;
    })();
  const saveDashboardViewsConfig = (raw: RawDashboardViewsConfig | null = serializeDashboardViewsConfig(viewRegistry)): void => {
    const issues = validateDashboardViewsConfig(raw, dashboardViewRegistryOptions());
    if (issues.length > 0) throw new Error(`invalid dashboard view config:\n${issues.join('\n')}`);
    const next = getUserConfig();
    const dashboard = { ...(next.dashboard ?? {}) };
    if (raw) dashboard.views = raw as Record<string, unknown>;
    else delete dashboard.views;
    saveUserConfig({ ...next, dashboard });
    reloadUserConfig();
    applyDashboardViewsRuntime(raw);
  };
  const resetDashboardViewsConfig = (): void => {
    saveDashboardViewsConfig(null);
  };
  const setActiveDashboardViewByBase = (baseView: WorkingDirView): void => {
    const def = viewRegistry.views.find(v => v.baseView === baseView && v.id === String(baseView))
      ?? viewRegistry.views.find(v => v.baseView === baseView)
      ?? viewRegistry.views[0]!;
    setActiveDashboardView(def);
  };
  const reloadDashboardViews = (): void => {
    applyDashboardViewsRuntime(getUserConfig().dashboard.views as any);
  };
  const userClosedPanes = new Set<PaneFocus>();
  const closedPaneSet = (): ReadonlySet<PaneFocus> => {
    const closed = new Set(userClosedPanes);
    if (scratchClosed) closed.add('scratch');
    return closed;
  };
  const paneViewport = (): PaneViewport => {
    const { cols, rows } = termSize();
    const promptFrame = getLayoutPromptFrame(rows);
    const gridRows = computePromptFrameGridHeight(rows, promptFrame);
    return { cols: Math.max(1, cols - 1), rows: gridRows };
  };

  // Tab / pane-nav wrapper that respects explicit pane closes and the
  // responsive omission policy for small terminals.
  const tabNext = (current: import('../workspace-types.js').PaneFocus, dir: 1 | -1): import('../workspace-types.js').PaneFocus => {
    const def = activeViewDef();
    return nextVisiblePaneFocus(current, def.baseView, dir, paneViewport(), {
      closed: closedPaneSet(),
      panes: panesForDashboardView(def),
      omitOrder: def.omitOrder,
      primary: def.primary,
      tabletMode: effectiveTabletMode(),
    });
  };
  const repairVisibleFocus = (): void => {
    const blockingForegroundModal = topBlockingForegroundModalSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
    if (blockingForegroundModal) return;
    const activeModal = topModalSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
    if (activeModal && !modalParticipatesInViewMode(activeModal)) return;
    const def = activeViewDef();
    const foregroundWorkspace = topWorkspaceSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
    const currentFocus =
      workingDir.focus === 'input'
      && foregroundWorkspace !== null
      && !preservesHostChromeInput(foregroundWorkspace.hostChromeProfile)
        ? def.primary
        : workingDir.focus;
    applyVisibleFocusRepair(
      workingDir.focus,
      repairFocusForVisiblePanes(currentFocus, def.baseView, paneViewport(), {
        closed: closedPaneSet(),
        panes: panesForDashboardView(def),
        omitOrder: def.omitOrder,
        primary: def.primary,
        tabletMode: effectiveTabletMode(),
      }),
      setWorkingFocus,
    );
  };

  // Prefix chord (Phase O6). tmux-style Ctrl+B arms the chord; the
  // next key within the timeout window triggers a bound action
  // (Ctrl+W / Ctrl+O for browser focus). HUD segment `chord` shows
  // `[^B]` while armed so the user knows the terminal is waiting.
  const chord: ChordState = createChord();
  const disarmChordHud = (): void => {
    disarmChord(chord);
    clearSegment(hud, 'chord');
  };

  // U-0 · ViewMode closure. `dashboardViewModeSignals` exposes the
  // live mode-flag bag as zero-arg getters so the derivation stays
  // pure (no captures). `currentViewMode` caches the last computed
  // mode for O(1) reads in debug snapshots and the CKS short-circuit.
  // `recomputeViewMode()` derives + syncs CKS.viewModeKind + updates
  // the cache; callers invoke it at state-change junctions (top of
  // draw, streaming start/end, chord arm/disarm). Additive for U-0 —
  // does not replace flag-driven branches; U-2 migrates dispatch
  // branches to this source.
  const dashboardViewModeSignals: DashboardViewModeSignals = {
    terminalModalId: () => terminalModalRouter.current()?.id ?? null,
    modalTopId: () => {
      const stack = display.modalStack();
      for (let i = stack.length - 1; i >= 0; i--) {
        const id = stack[i]!;
        const s = display.surface(id);
        if (!s || s.kind !== 'modal') continue;
        if (modalParticipatesInViewMode(s as import('../display/modal-stack.js').ModalSurface)) {
          return id;
        }
      }
      return null;
    },
    pluginActive: () => {
      const active = pluginHost.active();
      if (!active) return null;
      return { id: active.name };
    },
    // Chord state today has no `leader` field (ChordState is
    // armed/timer only). Placeholder `'chord'` · future chord work
    // can thread a real leader identifier through if needed.
    chordLeader: () => (isChordArmed(chord) ? 'chord' : null),
    streaming: () => streamingInFlight,
    inputFocused: () => isChatMainInputForegroundActive(chatMainInputVisibilityState()),
  };
  let currentViewMode: ViewMode = IDLE_VIEW_MODE;
  const recomputeViewMode = (): void => {
    currentViewMode = syncDashboardViewModeToContextKeys(
      dashboardViewModeSignals,
      currentViewMode,
    );
  };

  // Phase T — preview-pane embedded terminal. Created lazily when the
  // user presses `t` on the focused preview pane; destroyed on
  // Ctrl+Shift+T / Ctrl+G / dashboard exit. At most one alive at a
  // time. While alive, the preview widget's state.text is fed from
  // previewTerminal.render() and every key (except the intercept
  // list) bypasses the normal preview-pane dispatch and writes to
  // the PTY via key.raw.
  let previewTerminal: PreviewTerminal | null = null;
  // Phase T2b — adapter exposes previewTerminal to the matrix so
  // `matrix.move(id, {kind: 'preview'})` installs the instance's
  // PTY here (and the inverse extracts it back to a modal). Needs
  // to be initialised after `matrix` + `sessionRegistry` below;
  // see initialisation block next to the matrix constructor.
  let previewSlotAdapter: PreviewSlotAdapter | null = null;
  const executionSurfaces = new Map<string, ExecutionSurfaceHandle>();
  let activeExecutionSurfaceId: string | null = null;
  // Last (cols, rows) we handed to the session — compare on each
  // draw so we only call resize() when the preview zone actually
  // changed dimensions. Avoids a needless ioctl + emulator reflow
  // on every 5 Hz thinking tick.
  let previewTerminalDims: { cols: number; rows: number } | null = null;
  // Phase T7 — when true, the preview widget swells to the full
  // top-row width, hiding browser / scratch / obsidian / skill
  // siblings. Toggled by `^B e` / `^B ㄷ` (global chord) and by `e`
  // on the focused preview pane (muscle memory). Auto-clears when
  // the terminal session exits.
  let terminalExpanded = false;

  // Phase T-1 — tablet mode.
  //   null  → auto (tabletMode active iff product compact mode is
  //            `compact-tight`)
  //   true  → manually forced ON even on wide viewports (`/tablet on`)
  //   false → manually forced OFF even on compact-tight (`/tablet off`)
  // When active, pane policy promotes `log` to primary and collapses
  // the other panes to modal-deferred; they remain reachable via
  // `Ctrl+M <pane>`. Input prompt is always visible (panel-independent).
  let tabletModeManual: boolean | null = null;
  const effectiveTabletMode = (): boolean => {
    if (tabletModeManual !== null) return tabletModeManual;
    return autoTabletModeForViewport(paneViewport());
  };
  const effectiveChatOnlyMode = (): boolean =>
    effectiveChatOnlyModeForViewport(paneViewport(), chatOnlyMode);

  // Approximate the current preview-pane inner dimensions. The layout
  // composer is the authoritative source, but calling it outside
  // draw() risks drifting from the composed frame; as a practical
  // heuristic (which matches the paneW calculations the layout-host
  // uses in createLayout above), the preview slot gets ~40% of the
  // width in V1 / 50% in V2 / flex in V3. Rows come from the pane
  // height minus 2 for title + 1-row divider. The embedded emulator
  // tolerates slight mismatches — bash/zsh re-read winsize after each
  // resize() call.
  // Safety: guarantee the embedded shell is reaped on every path out
  // of the dashboard. Wired into the main exit handlers below and
  // also registered as a process-exit listener so an unhandled throw
  // doesn't leave a zombie zsh tied to a dangling PTY.
  const cleanupPreviewTerminal = (): void => {
    if (previewTerminal) {
      try { previewTerminal.stop(); } catch { /* ignore */ }
    }
    for (const execution of executionSurfaces.values()) {
      try { execution.dispose(); } catch { /* ignore */ }
    }
    executionSurfaces.clear();
    activeExecutionSurfaceId = null;
    previewTerminal = null;
    previewTerminalDims = null;
    terminalExpanded = false;
    previewSlotAdapter?.forgetBinding();
  };
  process.on('exit', cleanupPreviewTerminal);

  // T2b — install the preview-slot adapter so `matrix.move(id, {kind:'preview'})`
  // routes the PTY into this scope's `previewTerminal` variable (and the
  // inverse extracts it back for modal re-wrap). Binding uses get/set
  // closures so the adapter never touches the variable directly.
  previewSlotAdapter = new PreviewSlotAdapter({
    matrix: terminalMatrix,
    sessionRegistry,
    termSize,
    binding: {
      get: () => previewTerminal,
      set: (pty) => {
        previewTerminal = pty;
        if (pty) {
          // Re-sync dim cache so the next draw() resizes to pane
          // dimensions without a stale compare.
          previewTerminalDims = null;
        }
      },
      onChange: () => {
        try { refreshWorkingDirPreview(); } catch { /* ignore */ }
        try { draw(); } catch { /* ignore */ }
      },
    },
  });
  previewSlotAdapter.install();

  // S3: reap PTY shells spawned from this dashboard session. `detach:
  // true` handles persist across exits intentionally; everything else
  // gets SIGTERM'd before the process dies. Guarded by ptyAvailable()
  // so absence of node-pty is a no-op.
  process.once('beforeExit', async () => {
    try {
      const { ptyAvailable } = await import('../pty-shell/registry.js');
      if (!ptyAvailable()) return;
      const { killNonDetached } = await import('../pty-shell/registry.js');
      killNonDetached();
    } catch { /* best effort — never block shutdown */ }
  });

  // V5 watchdog: stall detection + completion notification. Subscribes
  // to the V4 PTY event bus. Completion events land as chatLines +
  // toast; stall events also surface as chatLines. The watchdog's
  // interval is unref'd so it never blocks shutdown.
  try {
    const { startPtyWatchdog, onPtyCompletion, formatPtyCompletion } =
      await import('../pty-shell/watchdog.js');
    const { onPtyEvent } = await import('../pty-shell/registry.js');
    const stopWatchdog = startPtyWatchdog();
    const unsubDone = onPtyCompletion((info) => {
      try {
        chatLines.push(C.muted(formatPtyCompletion(info)));
        chatScrollOffset = -1;
        draw();
      } catch { /* noop */ }
    });
    const unsubBus = onPtyEvent((ev) => {
      try {
        if (ev.type === 'spawned') {
          chatLines.push(C.muted(`▶ ${ev.id} spawned`));
        } else if (ev.type === 'stalled') {
          const sec = Math.round(ev.silentMs / 1000);
          chatLines.push(C.warning(`⚡ ${ev.id} stalled (${sec}s silent)`));
        } else {
          return;
        }
        chatScrollOffset = -1;
        draw();
      } catch { /* noop */ }
    });
    process.once('beforeExit', () => {
      try { stopWatchdog(); } catch { /* noop */ }
      try { unsubDone(); } catch { /* noop */ }
      try { unsubBus(); } catch { /* noop */ }
    });
  } catch { /* PTY module unavailable — skip watchdog */ }

  const computePreviewTerminalDims = (): { cols: number; rows: number } => {
    // Preferred path: ask the wd-preview widget what geometry it got
    // on the last render pass. That's the exact cellW / (height - 1
    // title row) from the layout composer — no fractions, no fudge
    // factors. Empty on the very first frame before any render has
    // happened; fall through to a layout-aware estimate in that case.
    const preview = widgetHost.get('wd-preview') as any;
    const liveW = preview?.state?.lastRenderedWidth as number | undefined;
    const liveH = preview?.state?.lastBodyHeight as number | undefined;
    if (typeof liveW === 'number' && liveW > 0 && typeof liveH === 'number' && liveH > 0) {
      // Emulator uses the FULL widget width (the markdown widget pads
      // shorter lines; longer lines would spill, so we cap at widget
      // width). Height matches the widget's body region (title row
      // consumed by paneTitle).
      return { cols: Math.max(20, liveW), rows: Math.max(4, liveH) };
    }
    // Fallback estimate (first frame only). Mirror the layout
    // computation done in workingDirLayoutForView so the emulator
    // starts at something close to the real geometry instead of a
    // 40 % fraction — cut over to `liveW` / `liveH` on the next draw.
    const { cols: totalCols, rows: totalRows } = termSize();
    const paneH = computePaneH(totalRows);
    const rows = Math.max(6, paneH - 1);
    if (terminalExpanded) {
      return { cols: Math.max(20, totalCols - 2), rows };
    }
    const cols = activePreviewPaneWidth(totalCols);
    return { cols, rows };
  };

  /** Shared helper for both the pane-level `t` key AND the global
   *  `Ctrl+B t` chord. Idempotent — calling while a session is
   *  already alive just re-focuses the preview pane. Handles:
   *    - view 4 (chat-only) → bounce to view 1 so wd-preview is visible
   *    - wiring onUpdate / onExit callbacks with cleanup
   *    - announcing keybindings + errors in the log pane */
  const openPreviewTerminal = (): void => {
    if (previewTerminal?.isAlive) {
      setWorkingFocus('preview', 'preview-terminal-refocus');
      return;
    }
    // Chat-only view has no wd-preview — bounce to V1 so the
    // terminal is actually visible. Saves the user from hunting
    // for the right view after firing a chord.
    if (workingDir.view === 4 || effectiveChatOnlyMode()) {
      setActiveDashboardViewByBase(1);
      chatOnlyMode = false;
    }
    const dims = computePreviewTerminalDims();
    try {
      previewTerminal = new PreviewTerminal({
        cols: dims.cols,
        rows: dims.rows,
        cwd: workingDir.cwd,
        // Let the user opt into a richer terminfo (e.g. xterm-ghostty)
        // via env. Default stays universal (xterm-256color) so fresh
        // installs never hit "terminfo missing".
        termName: process.env.ELANOUS_TERM || 'xterm-256color',
        onUpdate: () => { try { draw(); } catch { /* TUI torn down */ } },
        onExit: () => {
          previewTerminal = null;
          previewTerminalDims = null;
          terminalExpanded = false;
          previewSlotAdapter?.forgetBinding();
          try { refreshWorkingDirPreview(); } catch { /* ignore */ }
          try { draw(); } catch { /* ignore */ }
        },
      });
      previewTerminal.start();
      previewTerminalDims = dims;
      // WT-S-1.5 \u2014 fan raw stdout to ACP `terminalOutput` envelope so
      // PWA `/term` peers see the same grid. Best-effort: handle is
      // null when the daemon-public-server hasn't bound an ACP
      // connection yet (e.g. TUI-only mode); skip silently.
      try {
        const handle = getGlobalAcpHandle();
        if (handle) {
          const sids = handle.sessionIds();
          const sid = sids[0];
          if (sid) {
            registerPreviewTerminalForWebTap(previewTerminal, sid, 'preview-1', handle);
          }
        }
      } catch { /* swallow \u2014 web-terminal fan-out is best-effort */ }
      setWorkingFocus('preview', 'preview-terminal-open');
      pushDebugLine(C.muted(`Terminal opened in preview pane (${dims.cols}\u00D7${dims.rows}). ` +
        `Ctrl+Shift+T to exit, Ctrl+G to escape to log, Ctrl+Q to quit.`));
      chatScrollOffset = -1;
    } catch (e: any) {
      pushDebugLine(C.error(`Failed to open terminal: ${e?.message || e}`));
      chatScrollOffset = -1;
      previewTerminal = null;
    }
  };
  // Which browser was focused most recently. `smart` previews this
  // one; the fixed modes ignore it. Starts on `browser` so the first
  // render shows working-dir content when smart is active.
  // Skip past the `..` sentinel on first entry so the cursor lands on
  // a real entry (and the preview pane has something to show). User
  // can `k` back up to `..` if they want to navigate to the parent.
  if (workingDir.entries[0]?.name === '..' && workingDir.entries.length > 1) {
    workingDir.cursor = 1;
  }
  const surfaceIdForWorkingFocus = (pane: PaneFocus, view: WorkingDirView): string | null => {
    if (pane.startsWith('plugin:')) {
      return pluginHost.activeDashboardPanes().find(p => p.paneId === pane)?.widgetInstanceId ?? null;
    }
    switch (pane) {
      case 'input': return 'pane:input';
      case 'browser': return view === 3 ? 'wd-working-browser' : 'wd-browser';
      case 'obsidian': return 'wd-obsidian';
      case 'preview': return 'wd-preview';
      case 'scratch': return 'wd-scratch';
      case 'log': return 'wd-log';
      case 'skill-browser': return 'wd-skill-browser';
      case 'skill-file': return 'wd-skill-file';
      // Surface-unification v2.2 V2.2-5 Part 2 — scheduler-* widget id
      // mappings retired (scheduler view 폐기).
      case 'agent-roster': return 'wd-agent-roster';
      case 'agent-detail': return 'wd-agent-detail';
      case 'agent-log': return 'wd-agent-log';
      case 'debug-events': return 'wd-debug-events';
      case 'debug-detail': return 'wd-debug-detail';
      case 'debug-stack': return 'wd-debug-stack';
      case 'debug-prompts': return 'wd-debug-prompts';
      // VP1 — Widget Playground surface. Placeholder markdown widget
      // until VP2 ships the real playground widget implementation.
      case 'playground': return 'wd-playground';
      case 'sessions-sidebar': return 'wd-sessions-sidebar';
    }
    return null;
  };

  // F-3c (2026-04-22) — primitive-direct focus-node registration.
  // Debug panes were the only external caller of
  // `DisplayHandle.registerFocus` in dashboard.ts; migrating them
  // off the wrapper lets the primitive be the sole registry for
  // these ids. The coord wrapper (kept for backward compat) was
  // doing two writes (coord.focusNodes.set + primitive.register).
  // Here we call the primitive directly; coord.focusNodes gets a
  // mirror entry via the F-2 `mounted` listener path if any modal
  // mechanics later touch this id. `order` maps to primitive
  // `priority` (same as F-2's mirror mapping).
  //
  // Ordering invariant: this block must run BEFORE
  // `setWorkingFocus('initial-boot')` below — otherwise the
  // defensive-fallback path in `setWorkingFocus` synthesizes an
  // `_ensureRegistered` entry with `priority: 0`, which then
  // collides with this forEach's `priority: order` (primitive
  // throws on duplicate register).
  [
    'pane:input',
    'wd-browser',
    'wd-obsidian',
    'wd-skill-browser',
    'wd-skill-file',
    'wd-working-browser',
    'wd-preview',
    'wd-scratch',
    'wd-log',
    // Surface-unification v2.2 V2.2-5 Part 2 — wd-scheduler-* widget id
    // entries retired (scheduler view 폐기).
    'wd-agent-roster',
    'wd-agent-detail',
    'wd-agent-log',
    'wd-debug-events',
    'wd-debug-detail',
    'wd-debug-stack',
    'wd-debug-prompts',
  ].forEach((id, order) => {
    display.focusManagerAPI().register({
      id,
      scope: 'dashboard',
      focusable: true,
      priority: order,
      owner: 'dashboard',
    });
  });

  // IDX-F3.5a — single entry point for mutating `workingDir.focus`.
  // Assigns the new pane and eagerly projects the corresponding
  // coordinator surface id via display.syncExternalFocus, honoring
  // the same invariants the per-frame projection block enforces:
  // skip projection when a modal owns focus, preserve execution
  // surface focus. Callers should prefer this wrapper over direct
  // assignment so that once F3.5c deletes the projection block the
  // focus model continues to propagate correctly.
  const setWorkingFocus = (
    next: PaneFocus,
    reason: string = 'dashboard-pane-focus',
  ): void => {
    const prev = workingDir.focus;
    workingDir.focus = next;
    const blockingForegroundModal = topBlockingForegroundModal();
    const decision = computeWorkingFocusSync({
      surfaceId: surfaceIdForWorkingFocus(next, workingDir.view),
      currentFocus: display.currentFocus(),
      blockingForegroundModalOpen:
        blockingForegroundModal !== null,
    });
    if (debug.enabled) {
      // U-0 · migration site #3 · setWorkingFocus telemetry carries
      // the derived viewMode so post-hoc triage can tell whether a
      // focus shift happened during streaming / chord-armed / modal
      // without combining flags. `currentViewMode` reflects the
      // state *before* this focus mutation — the shift may flip
      // `input`↔`idle` on the next recomputeViewMode().
      debug.log(
        `dashboard.setWorkingFocus.${decision.action}`,
        next,
        decision.action === 'sync'
          ? { prev, reason, target: decision.target, view: workingDir.view, viewMode: currentViewMode.kind }
          : { prev, reason, skipReason: decision.reason, view: workingDir.view, viewMode: currentViewMode.kind },
      );
    }
    if (decision.action === 'sync') {
      // F-3c (2026-04-22) — primitive-direct focus write. Bypasses the
      // `syncExternalFocus` wrapper (kept for backward-compat callers);
      // this dashboard path talks to the primitive itself. `null`
      // target → clear · non-null → setFocus with the caller's reason
      // unmediated. Targets here are known pane ids registered by
      // the focus-node forEach just above so `focusManager.setFocus`
      // resolves cleanly; a defensive fallback via
      // `syncExternalFocus` catches ever-rare unregistered ids.
      const fm = display.focusManagerAPI();
      if (decision.target === null) {
        fm.clear(reason);
      } else if (fm.isRegistered(decision.target)) {
        fm.setFocus(decision.target, reason);
      } else {
        // Defensive fallback: coord's `syncExternalFocus` synthesizes
        // missing focus nodes via `_ensureRegistered`. We reuse that
        // path only for the rare unregistered case so the migration
        // doesn't introduce a silent no-op for legacy callers.
        display.syncExternalFocus(decision.target, reason);
      }
    }
  };

  // First-entry contract: launch directly into the chat input so the
  // first keystroke lands in the prompt without an extra reopen key.
  // Routed through the canonical focus setter so focus-manager +
  // coordinator state agree from frame 1.
  const initialBootFocus: PaneFocus = resolveDashboardInitialWorkingFocus();
  setWorkingFocus(initialBootFocus, opts.benchmark === true ? 'benchmark-boot' : 'initial-boot');

  // U-0 · seed ViewMode + CKS.viewModeKind immediately after boot
  // focus is set. Subsequent recomputeViewMode() calls at each key
  // event + draw loop keep the state in sync with flag mutations.
  recomputeViewMode();

  // P0-1 — inverse of surfaceIdForWorkingFocus. Used by the mouse
  // dispatch so clicking anywhere inside a pane's cell (title row,
  // body, footer) focuses that pane, mirroring the pane-nav strip.
  const paneFocusForWidgetInstanceId = (
    wid: string,
  ): import('../workspace-types.js').PaneFocus | null => {
    const pluginPane = pluginHost.activeDashboardPanes().find(p => p.widgetInstanceId === wid);
    if (pluginPane) return pluginPane.paneId as import('../workspace-types.js').PaneFocus;
    // Surface-unification v2.2 V2.2-5 Part 2 — scheduler-* PaneFocus
    // entries retired (scheduler view 폐기).
    const STATIC_PANES: import('../workspace-types.js').PaneFocus[] = [
      'input', 'browser', 'obsidian', 'preview', 'scratch', 'log',
      'skill-browser', 'skill-file',
      'agent-roster', 'agent-detail', 'agent-log',
      'debug-events', 'debug-detail', 'debug-stack', 'debug-prompts',
      'playground', 'sessions-sidebar',
    ];
    for (const p of STATIC_PANES) {
      if (surfaceIdForWorkingFocus(p, workingDir.view) === wid) return p;
    }
    return null;
  };

  // Last working-dir pane focus before the user dropped into input.
  // Ctrl+T from the input restores focus to this pane so a quick
  // chord round-trip doesn't lose your spot. Falls back to first
  // pane of the current view when null (first-time entry, etc.).
  const focusTransitionApplyHost = focusTransitionState.applyHost((next, reason) => setWorkingFocus(next, reason));
  const applyFocusToInputTransition = (
    transition: import('./input/focus-transition.js').FocusToInputTransition,
  ): void => {
    applyFocusToInputTransitionState(focusTransitionApplyHost, transition);
  };
  const applyFocusToPaneTransition = (
    transition: import('./input/focus-transition.js').FocusToPaneTransition,
  ): void => {
    applyFocusToPaneTransitionState(focusTransitionApplyHost, transition);
  };

  const normalizedLogPaneKeyChord = (key: Key): string => [
    key.ctrl ? 'Ctrl' : null,
    key.alt ? 'Alt' : null,
    key.meta ? 'Meta' : null,
    key.shift ? 'Shift' : null,
    key.name,
  ].filter((part): part is string => part !== null).join('+');

  const handleLogPaneCopyAction = async (key: Key): Promise<boolean> => {
    const action = resolveLogPaneCopyAction(key);
    if (!action) return false;

    const sourceFocus = workingDir.focus;
    const chord = normalizedLogPaneKeyChord(key);
    if (action === 'return-to-input') {
      if (sourceFocus !== 'input') {
        applyFocusToInputTransition(resolveFocusToInputTransition({
          sourcePane: sourceFocus,
          rememberPane: true,
          reason: 'log-pane-copy-return-to-input',
        }));
      }
      if (debug.enabled) {
        debug.log('dashboard.log-pane.key-action', action, {
          chord,
          action,
          sourceFocus,
          destination: 'input',
          changed: sourceFocus !== 'input',
        });
      }
      return true;
    }

    if (action === 'last-message') await copyLastAssistantTurnToClipboard();
    else if (action === 'last-code') await copyLastAssistantCodeToClipboard();
    else if (action === 'last-media') await openLastAssistantMediaPreview();
    else if (action === 'block') await copyLogBlock(chatLines.length - 1, 'block');
    else await copyLogBlock(-1, 'all');

    if (debug.enabled) {
      debug.log('dashboard.log-pane.key-action', action, {
        chord,
        action,
        sourceFocus,
        copyTarget: action,
      });
    }
    return true;
  };

  // IDX-5 Phase 3 본편 — build the deps bundle that both the pane-
  // focus-mode mx-mouse branch and the input-mode textInput.onMouse
  // path feed into dispatchPaneClick. Captures the live refs for
  // lastEffectiveLayout / gridZone* (which mutate per-frame) and the
  // widget-host adapter. Called per-event so the layout snapshot is
  // never stale.
  const buildPaneClickDeps = (): import('../display/pane-click-dispatch.js').PaneClickDispatchDeps => ({
    layout: lastEffectiveLayout,
    gridZoneStart,
    gridZoneHeight,
    termCols: termSize().cols,
    paneFocusForWidgetInstanceId,
    invokeWidgetMouse: (wid, type, localRow, localCol) => {
      const def = widgetHost.defFor(wid);
      const inst = widgetHost.get(wid);
      if (!def?.onMouse || !inst) return { kind: 'no-handler' };
      const ctx = widgetHost.buildContext(wid) as never;
      try {
        const act = def.onMouse(
          { type, row: localRow, col: localCol },
          inst.state as never,
          ctx,
        );
        if (act && act.type === 'submit') return { kind: 'submit', text: act.text };
        return { kind: 'none' };
      } catch {
        return { kind: 'none' };  // isolate widget error
      }
    },
  });

  // U-4.3 · dispatch log-zone clicks to wd-log.onMouse · replaces the
  // 3 non-embedded `tryHandleLogAreaClick` call sites in
  // attachChatStreamingKeys / mx-mouse no-hit fallback /
  // textInput.onMouse log-zone. The widget.onMouse handler runs the
  // attachment hit-test + popup mount via `state.clickDeps` (synced
  // each frame by syncLogWidgetState). Returns:
  //   - 'consumed'   · click landed in the log zone · widget ran.
  //   - 'passthrough' · click in zone but widget didn't consume · the
  //                      caller may apply focusOnMiss policy (e.g.
  //                      setWorkingFocus('log')) before redraw.
  //   - 'out-of-zone' · click row is outside the log zone · caller
  //                      routes through its normal non-log path.
  // This helper treats the widget's returned `{type: 'none'}` as
  // passthrough — the widget mounts its own popup as a side effect
  // when it resolves an attachment, and signals "did-something" via
  // that side effect rather than through the Action return (popup
  // mount covers >99% of the signal; false positives get a harmless
  // focus shift via the caller's policy).
  const dispatchLogZoneClick = (
    m: { row: number; col: number; type: string },
  ): 'consumed' | 'passthrough' | 'out-of-zone' =>
    runLogZoneClickDispatch(m, { logZoneStart, logZoneHeight, widgetHost });

  // ── mx-mouse handler (A-3 migration · A-6 cleanup) ──
  //
  // `runMxMouseUnifiedDispatch` is the only mx-mouse dispatch path
  // (A-6 removed the legacy fallback). Wraps the
  // 4 existing helpers (mouseWiring.handleMouse · pane-nav hit-test ·
  // dispatchPaneClick · dispatchLogZoneClick) as RouteCallbacks,
  // builds a DispatchContext from `currentViewMode`, and defers to
  // `routeInputEvent`. Focus-steal gated through the policy flag —
  // transparent under mx-mouse's idle/browse scope (allowFocusSteal
  // defaults to true), important for the A-4 textInput.onMouse
  // delegation (which passes the SAME callbacks but derives
  // allowFocusSteal=false from viewMode='input').
  //
  // Kept at the module-closure scope so the body shares the outer
  // helpers (mouseWiring · paneNavRow · paneNavHitAreas · setWorkingFocus
  // · dispatchPaneClick · buildPaneClickDeps · dispatchLogZoneClick ·
  // dispatchSidebarSubmit · workingDir · currentViewMode). Defining
  // inside the readKey while-loop would re-allocate every keystroke.
  const runMxMouseUnifiedDispatch = (
    k: TuiKey,
    m: DisplayMouseEvent,
  ): 'consumed' | 'passthrough' => {
    const displayMouse = { ...m, shift: k.shift, ctrl: k.ctrl, alt: k.alt };
    updateDebugWindowHoverState(displayMouse);
    mouseWiring.preflightHitTarget(m);
    const ev: InputCoreMouseInputEvent = inputCoreBuildMouseEventFromDisplay(m, {
      shift: k.shift, ctrl: k.ctrl,
    });
    // mx-mouse is the idle / browse-mode dispatcher. `currentViewMode`
    // is normally 'idle' here but can be 'streaming' / 'modal' /
    // 'terminal-modal' etc. depending on the frame's global state.
    // routeInputEvent honours the viewMode arm ordering — e.g. if a
    // modal is mounted the event routes through routeToModal first,
    // short-circuiting the idle mouse fallback chain.
    const routes: InputCoreRouteCallbacks = {
      routeToModal: () => {
        const activeModal = topModalSurface({
          focusStack: display.modalStack(),
          surfaceAt: id => display.surface(id),
        });
        if (debug.enabled) {
          debug.log('mouse.route.dashboard', 'modal-attempt', {
            modalId: activeModal?.id ?? null,
            type: displayMouse.type,
            row: displayMouse.row,
            col: displayMouse.col,
          });
        }
        if (activeModal && display.routeMouseToSurface(activeModal, displayMouse)) {
          if (debug.enabled) {
            debug.log('mouse.route.dashboard', 'modal-consumed', {
              modalId: activeModal.id,
              type: displayMouse.type,
            });
          }
          dragWire.onMouse(displayMouse);
          return 'consumed';
        }
        if (debug.enabled) {
          debug.log('mouse.route.dashboard', 'modal-fellthrough', {
            modalId: activeModal?.id ?? null,
            type: displayMouse.type,
          });
        }
        const consumed = mouseWiring.handleMouse(displayMouse);
        dragWire.onMouse(displayMouse);
        return consumed ? 'consumed' : 'passthrough';
      },
      // DS-3a-follow (Finding A · 2026-04-21) — dragWire.onMouse 가
      // streaming route 에만 wired 됐던 gap 해결. Idle mode 도
      // dragWire 를 호출해 browser → chat drag 가 rest 상태에서
      // 작동하도록. See PR #334 Session A/B post-merge reviews.
      routeMouseWiring: () => {
        const consumed = mouseWiring.handleMouse(displayMouse);
        dragWire.onMouse(displayMouse);
        return consumed ? 'consumed' : 'passthrough';
      },
      routePaneNavClick: () => {
        return runDashboardMouseSurfaceActionPlan(
          resolvePaneNavMouseActionPlan(m, {
            paneNavRow,
            paneAtColumn: col0 => paneAtColumn(paneNavHitAreas, col0),
          }),
          {
            setWorkingFocus,
            focusReason: 'mx-mouse-pane-nav',
            dispatchSubmitText: dispatchSidebarSubmit,
          },
        );
      },
      routePaneClick: (_ev, allowFocusSteal) => {
        return runDashboardMouseSurfaceActionPlan(
          resolvePaneBodyMouseActionPlan(
            m,
            dispatchPaneClick(m, buildPaneClickDeps()),
            {
              allowFocusSteal,
              currentFocus: workingDir.focus,
            },
          ),
          {
            setWorkingFocus,
            focusReason: 'mx-mouse-pane-click',
            dispatchSubmitText: dispatchSidebarSubmit,
          },
        );
      },
      routeLogZoneClick: (_ev, allowFocusSteal) => {
        debug.log('log.mouse', 'mx-mouse-route-reached', { type: m.type });
        if (m.type !== 'click' && m.type !== 'double-click') return 'passthrough';
        return runDashboardMouseSurfaceActionPlan(
          resolveLogZoneMouseActionPlan(
            m,
            dispatchLogZoneClick(m),
            {
              allowFocusSteal,
              currentFocus: workingDir.focus,
            },
          ),
          {
            setWorkingFocus,
            focusReason: 'log-area-click',
            dispatchSubmitText: dispatchSidebarSubmit,
          },
        );
      },
      // Key / terminal-modal / modal / plugin / chord / streaming-key
      // arms are A-4/A-5 scope — left undefined so routeInputEvent
      // returns 'passthrough' for them (preserves outer handler chain).
    };
    const ctx: InputCoreDispatchContext = {
      viewMode: currentViewMode,
      policy: inputCoreDerivePolicyForViewMode(currentViewMode),
      routes,
      dragManager: display.dragManagerAPI(),
      interceptors: dispatchInterceptors,
    };
    return inputCoreRouteInputEvent(ev, ctx);
  };

  // ── textInput.onMouse handler (A-4 migration · A-6 cleanup) ──
  //
  // `runTextInputOnMouseUnifiedDispatch` is the only textInput mouse
  // dispatch path (A-6 removed the legacy
  // fallback). A-3 mx-mouse 와 pattern 동일 하지만 3가지 차이:
  //
  //   1. **Focus-steal 정책**: input-core 의 기본 input policy 는
  //      `allowFocusSteal=false` 이지만, dashboard textInput.onMouse 는
  //      pane-body click 만큼은 명시적으로 override 해서 포커스를 넘긴다.
  //      사용자가 입력 중이라도 pane 을 클릭하면 그 pane 이 활성화되어야
  //      한다는 현재 UX 결정을 반영한다. pane-NAV 클릭은 기존처럼 focus
  //      이동.
  //
  //   2. **Log-zone gate**: textInput 은 attachment 가 현재 화면에 있을
  //      때만 log-zone 클릭 처리 (attachmentRowMap.size() > 0). 없으면
  //      passthrough 해서 꼬리 scroll block 이 처리. 이 gate 가 mx-mouse
  //      와 다르므로 routeLogZoneClick 이 textInput 전용 body 사용.
  //
  //   3. **Tail scroll block**: scroll-up/down 이 pane/log 에서 consume
  //      안 되면 textInput 이 직접 `chatScrollOffset` 조작. routeInputEvent
  //      가 'passthrough' 반환 후 fall-through.
  //
  // 또 textInput 의 onMouse 는 `void` 리턴 + 내부에서 `draw()` 호출 —
  // A-3 (mx-mouse) 가 'consumed'/'passthrough' 리턴하는 것과 contract 다름.
  const runTextInputOnMouseUnifiedDispatch = (m: DisplayMouseEvent): void => {
    const displayMouse = { ...m };
    updateDebugWindowHoverState(displayMouse);
    const blockingForeground = topBlockingForegroundModal();
    if (blockingForeground) {
      const consumed = mouseWiring.handleMouse(displayMouse);
      dragWire.onMouse(displayMouse);
      if (debug.enabled) {
        debug.log('input.onMouse.foreground-modal-guard', m.type, {
          modalId: blockingForeground.id,
          consumed,
        });
      }
      return;
    }
    // No shift/ctrl here — textInput onMouse callback receives
    // DisplayMouseEvent only (no enclosing Key). Modifier-bearing
    // bindings go through the dispatchDashboardKey chain instead.
    mouseWiring.preflightHitTarget(m);
    const ev: InputCoreMouseInputEvent = inputCoreBuildMouseEventFromDisplay(m, {});

    const routes: InputCoreRouteCallbacks = {
      // DS-3a-follow (Finding A · 2026-04-21) — input mode route 도
      // dragWire.onMouse 호출. 사용자가 textInput 에 타이핑 중
      // browser 파일 drag 가 가능해짐. streaming/idle 과 parity.
      routeMouseWiring: () => {
        const consumed = mouseWiring.handleMouse(displayMouse);
        dragWire.onMouse(displayMouse);
        return consumed ? 'consumed' : 'passthrough';
      },

      routePaneNavClick: () => {
        return runDashboardMouseSurfaceActionPlan(
          resolvePaneNavMouseActionPlan(m, {
            paneNavRow,
            paneAtColumn: col0 => paneAtColumn(paneNavHitAreas, col0),
          }),
          {
            setWorkingFocus,
            focusReason: 'input-onMouse-pane-nav',
            dispatchSubmitText: dispatchSidebarSubmit,
          },
        );
      },

      routePaneClick: (_ev, _allowFocusSteal) => {
        return runDashboardMouseSurfaceActionPlan(
          resolvePaneBodyMouseActionPlan(
            m,
            dispatchPaneClick(m, buildPaneClickDeps()),
            {
              allowFocusSteal: true,
              currentFocus: workingDir.focus,
            },
          ),
          {
            setWorkingFocus,
            focusReason: 'input-onMouse-pane-click',
            dispatchSubmitText: dispatchSidebarSubmit,
          },
        );
      },

      routeLogZoneClick: (_ev, _allowFocusSteal) => {
        debug.log('log.mouse', 'text-input-route-reached', { type: m.type });
        // textInput-specific gate: only process log-zone click when
        // attachments are currently rendered. Otherwise fall through
        // to the tail scroll block (which adjusts chatScrollOffset for
        // wheel-over-log).
        if (m.type !== 'click') return 'passthrough';
        if (attachmentRowMap.size() === 0) {
          const logOutcome = dispatchLogZoneClick(m);
          debug.log('log.mouse', 'text-input-attachment-gate-blocked', { type: m.type, logOutcome });
          if (logOutcome === 'consumed') return 'consumed';
          return 'passthrough';
        }
        return runDashboardMouseSurfaceActionPlan(
          resolveLogZoneMouseActionPlan(
            m,
            dispatchLogZoneClick(m),
            {
              allowFocusSteal: false,
              currentFocus: workingDir.focus,
              focusOnConsume: false,
            },
          ),
          {
            setWorkingFocus,
            focusReason: 'input-onMouse-log',
            dispatchSubmitText: dispatchSidebarSubmit,
          },
        );
      },
    };

    const ctx: InputCoreDispatchContext = {
      viewMode: currentViewMode,
      policy: inputCoreDerivePolicyForViewMode(currentViewMode),
      routes,
      dragManager: display.dragManagerAPI(),
      interceptors: dispatchInterceptors,
    };
    const outcome = inputCoreRouteInputEvent(ev, ctx);
    if (outcome === 'consumed') {
      const topModalId = display.modalStack().at(-1) ?? null;
      const topModal = topModalId ? display.surface(topModalId) : null;
      if (!topModal || !isWorkspaceInteractionSurface(topModal)) {
        draw();
      }
      return;
    }

    // Tail: scroll-over-log chatScrollOffset direct mutation (legacy
    // body's final block). Reached only when the dispatch chain
    // returned 'passthrough' (no pane/log hit consumed the event).
    if (m.type !== 'scroll-up' && m.type !== 'scroll-down') return;
    const { rows: tr } = termSize();
    const pH = computePaneH(tr);
    const promptFrame = getLayoutPromptFrame(tr);
    const logViewport = computePromptFrameLogViewportBounds(tr, pH, promptFrame);
    if (debug.enabled) {
      debug.log('log.wheel', 'tail-scroll-check', {
        type: m.type,
        row: m.row,
        col: m.col,
        focus: workingDir.focus,
        viewMode: currentViewMode.kind,
        logViewport,
        paneHeight: pH,
      });
    }
    if (m.row <= logViewport.startRow || m.row > logViewport.endRow) {
      if (debug.enabled) {
        debug.log('log.wheel', 'tail-scroll-out-of-zone', {
          type: m.type,
          row: m.row,
          col: m.col,
          logViewport,
        });
      }
      return;
    }
    const maxScr = Math.max(0, chatLines.length - logViewport.height);
    const delta = m.type === 'scroll-up' ? -3 : 3;
    const before = chatScrollOffset;
    chatScrollOffset = Math.max(0, Math.min(
      (chatScrollOffset < 0 ? maxScr : chatScrollOffset) + delta,
      maxScr,
    ));
    if (delta > 0 && chatScrollOffset >= maxScr) chatScrollOffset = -1;
    if (debug.enabled) {
      debug.log('log.wheel', 'tail-scroll-apply', {
        type: m.type,
        row: m.row,
        col: m.col,
        delta,
        before,
        after: chatScrollOffset,
        maxScr,
        logViewport,
      });
    }
    draw();
  };

  widgetHost.spawn({ type: 'list',     id: 'wd-browser',         character: 'Browser',       config: { items: [] } });
  widgetHost.spawn({ type: 'list',     id: 'wd-obsidian',        character: 'Obsidian',      config: { items: [] } });
  widgetHost.spawn({ type: 'list',     id: 'wd-skill-browser',   character: 'Skills',        config: { items: [] } });
  widgetHost.spawn({ type: 'list',     id: 'wd-skill-file',      character: 'Skill Files',   config: { items: [] } });
  widgetHost.spawn({ type: 'list',     id: 'wd-working-browser', character: 'Working',       config: { items: [] } });
  widgetHost.spawn({ type: 'markdown', id: 'wd-preview',         character: 'Preview',       config: { text: '' } });
  // Arc Z — `wd-scratch` graduates from the markdown widget to the
  // dedicated `scratch` type. The dashboard still owns the source-of-
  // truth state (scratchLines / scratchMode)
  // and pushes it into the widget via `syncScratchFromDashboard()` on
  // every draw. Key dispatch stays dashboard-owned for now — the
  // widget's onKey branch is available for future layout plugins that
  // embed `type: 'scratch'` directly.
  widgetHost.spawn({ type: 'scratch',  id: 'wd-scratch',         character: 'Scratch',       config: { mode: 'preview' } });
  widgetHost.spawn({ type: 'scratch',  id: 'wd-clipboard',       character: 'Clipboard',     config: { mode: 'clipboard' } });
  widgetHost.spawn({ type: 'scratch',  id: 'wd-memo',            character: 'Memo',          config: { mode: 'memo', memoLines: [''] } });
  widgetHost.spawn({ type: 'scratch',  id: 'wd-detail',          character: 'Detail',        config: { mode: 'preview' } });
  widgetHost.spawn({ type: 'log',      id: 'wd-log',             character: 'ChatLog' });
  widgetHost.spawn({ type: 'log',      id: 'wd-debug-log',       character: 'Debug Log' });
  // Surface-unification v2.2 V2.2-5 Part 2 — wd-scheduler-* widget spawn
  // calls retired (scheduler view 폐기 · scheduler-task-list widget kind
  // 자체도 widget-host 측 catalog 에서 떨어짐 · V2.2-8 의 src/scheduler/**
  // 17 파일 삭제 cascade 시 함께 정리).
  widgetHost.spawn({ type: 'agent-list', id: 'wd-agent-roster', character: 'Agents', config: { agents: [], emptyLabel: 'No active agents' } });
  widgetHost.spawn({ type: 'agent-detail', id: 'wd-agent-detail', character: 'Agent Detail', config: { agent: null } });
  widgetHost.spawn({ type: 'markdown', id: 'wd-agent-log', character: 'Agent Log', config: { text: '' } });
  widgetHost.spawn({ type: 'list', id: 'wd-debug-events', character: 'Debug Events', config: { items: [] } });
  widgetHost.spawn({ type: 'markdown', id: 'wd-debug-detail', character: 'Debug Detail', config: { text: '' } });
  widgetHost.spawn({ type: 'markdown', id: 'wd-debug-stack', character: 'Debug Stack', config: { text: '' } });
  widgetHost.spawn({ type: 'markdown', id: 'wd-debug-prompts', character: 'Prompt Bank', config: { text: '' } });
  // VP2 — Widget Playground.
  //
  // The 'playground' WidgetDef is defined inline in src/ so it stays
  // inside the TS rootDir (the plugin-style widgets/<name>/widget.ts
  // files are cross-boundary and counted in the TS rootDir baseline).
  // We register() before spawn() so the playground type is known when
  // V7 binds `wd-playground` to it.
  widgetHost.register(playgroundWidget, 'builtin', 'src/playground-widget.ts');
  // VP6 — hand the widget-host to the playground catalog so the
  // built-in widget group can enumerate defs without crossing the TS
  // rootDir with direct `../widgets/*` imports. Safe to call every
  // boot; subsequent calls just invalidate the cached catalog.
  setWidgetHostForCatalog(widgetHost);
  widgetHost.spawn({
    type: 'playground',
    id: 'wd-playground',
    character: 'Widget Playground',
    config: { initialSize: 'medium' },
  });
  // ST3 — Sessions sidebar (leadColumn-ready). Register explicitly in
  // addition to discover() so the widget is guaranteed present even
  // before the first disk scan resolves; discover() replaces it with
  // the same entry when it runs.
  widgetHost.register(sessionsSidebarWidget, 'builtin', 'src/sessions-sidebar-widget.ts');
  widgetHost.spawn({
    type: 'sessions-sidebar',
    id: 'wd-sessions-sidebar',
    character: 'Sessions',
    config: { cards: [] },
  });
  // Wave P3a (presentation) · A4-1 — plan-board widget asset.
  // Registered (not spawned) so future waves can drop the widget
  // into a sidebar tab / pane surface without re-defining it. The
  // immediate user-visible plan board comes from the chatLines
  // splice runtime (createPlanBoardRuntime, see WF2 site above).
  {
    const { default: planBoardWidget } = await import('../widgets/plan-board.js');
    widgetHost.register(planBoardWidget, 'builtin', 'src/widgets/plan-board.ts');
  }
  // NT4 — notification bell modal widget. Registered + spawned here
  // so Ctrl+B b (NT5) can toggle without spawn latency. The bellOpen
  // flag + helpers live further down (after notificationStore is
  // created) because refreshBellInto reads from the store.
  widgetHost.register(bellModalWidget, 'builtin', 'src/notification-bell-modal.ts');
  widgetHost.spawn({
    type: 'notification-bell',
    id: 'wd-notification-bell',
    character: 'Notifications',
    config: { events: [], filter: 'a' },
  });
  // US1 — shared status store populated by the claude-code JSONL
  // parser and the codex heuristic parser. SessionCard.status flows
  // from here into the sidebar via listSessionCards' status lookup.
  const agentStatusStore = new AgentStatusStore();
  // BL1 — block store. parsers (BL2/BL3) write to this; the toolbelt
  // `[Attach]` handler (BL4) + chat submit (BL5) read from it.
  const blockStore = new BlockStore();
  const claudeStatusParser = createClaudeCodeParser({ store: agentStatusStore, blockStore });
  const codexStatusParser = createCodexParser({ store: agentStatusStore, blockStore });
  // BL4/BL5 — pending context state for the next chat submit.
  // Toolbelt [Attach] sets via state.attach(), chat submit consumes
  // via state.consume(). Banner + detach helpers live on the state.
  const blockAttach = new BlockAttachState();
  // NT1 — notification history per session. NT2 feeds AgentStatus
  // transitions, BlockStore commits, and matrix lifecycle events
  // into this store; NT3 renders unread badges on the sidebar and
  // NT4's bell modal exposes the full list.
  // NT-E2 — persistence adapter writes every event to a per-session
  // jsonl under ~/.elanous/notifications. replay() seeds the bell
  // modal with recent history on the next launch. Opt-out via
  // ELANOUS_NOTIFICATION_DISABLE_PERSIST=1.
  const persistence = process.env['ELANOUS_NOTIFICATION_DISABLE_PERSIST']
    ? createPersistence({ dir: null })
    : createPersistence();
  const notificationStore = new NotificationStore({ persistence });
  try { notificationStore.replay(); } catch { /* tolerate corrupt log */ }
  // NT5 — bell modal open flag + helpers. refreshBellInto pulls the
  // full NotificationStore list through rebuildBellEvents (filter-
  // aware) into the widget state. toggleBell flips visibility.
  let bellOpen = false;
  const refreshBellInto = (): void => {
    const inst = widgetHost.get('wd-notification-bell');
    if (!inst) return;
    const state = inst.state as BellModalState;
    inst.state = {
      ...state,
      events: rebuildBellEvents(notificationStore, state.filter),
    };
  };
  const toggleBell = (): void => {
    bellOpen = !bellOpen;
    if (bellOpen) refreshBellInto();
  };
  const refreshSessionCardsInto = (): void => {
    const inst = widgetHost.get('wd-sessions-sidebar');
    if (!inst) return;
    const cards = listSessionCards({
      listTerminals: () => terminalMatrix.listUserVisible(),
      // AXON P6.3 — flatten every ACP session (client + server) from
      // the dual-role registry into sidebar rows. Follow-up #3 folds
      // BackgroundManager records in here too (kind='background')
      // so long-running cloud-agent parity sessions are first-class.
      listAcpSessions: () => [
        ...globalDualRoleManager().listAsSidebarStubs(),
        ...globalBackgroundManager().list().map(backgroundToStub),
      ],
      status: {
        get: (id) => {
          const s = agentStatusStore.get(id);
          if (s) return s;
          if (id.startsWith('acp-bg:')) {
            const rec = globalBackgroundManager().status(id);
            if (rec) return bgStateToSessionStatus(rec.state);
          }
          return undefined;
        },
      },
      notifications: { unreadCount: (id) => notificationStore.unreadCount(id) },
    });
    const prev = inst.state as SessionsSidebarState;
    inst.state = {
      ...prev,
      cards,
      cursor: Math.min(prev.cursor ?? 0, Math.max(0, cards.length - 1)),
    };
  };
  // H3 #6 follow-up #3 — redraw sidebar on every BG state transition
  // so the state badge (working / awaiting / done / err) stays live.
  // Process-lifetime subscription · no explicit teardown (dashboard
  // owns the process; test harnesses reset the BG singleton instead).
  globalBackgroundManager().onStateChange(() => {
    refreshSessionCardsInto();
  });
  // US2/US3 — attach parsers when an agent-typed PTY spawns, detach
  // on exit. PreviewTerminal.addRawOutputTap hands us every stdout
  // chunk before xterm-headless eats it.
  terminalMatrix.subscribe((ev) => {
    if (ev.type === 'spawned') {
      const kind = ev.instance.metadata?.['agentKind'];
      const tapFn = (ev.instance.pty as unknown as { addRawOutputTap?: (cb: (chunk: string) => void) => () => void })
        .addRawOutputTap;
      if (tapFn) {
        if (kind === 'claude-code') {
          tapFn((chunk) => claudeStatusParser.feed(ev.instance.id, chunk));
        } else if (kind === 'codex' || kind === 'gemini-cli' || kind === 'aider') {
          tapFn((chunk) => codexStatusParser.feed(ev.instance.id, chunk));
        }
      }
      // NT-E1 — runtime OSC tap. Complements the registry's
      // construction-time onOscNotify (which raises attention on
      // the session card); this additional tap funnels the OSC
      // into NotificationStore so the bell modal records the event
      // with the same level of detail as status/block/exit.
      const oscTapFn = (ev.instance.pty as unknown as {
        addRawOscTap?: (cb: (ev: import('../preview/terminal.js').OscNotifyEvent) => void) => () => void;
      }).addRawOscTap;
      if (oscTapFn) {
        oscTapFn((oscEv) => {
          notificationStore.push(oscToNotification(ev.instance.id, oscEv));
        });
      }
    } else if (ev.type === 'exited') {
      // NT2 — PTY lifecycle events become sticky notifications so
      // the user can tell afterward which sessions completed vs.
      // errored. Cleanup still happens immediately for in-memory
      // parser state.
      notificationStore.push(exitToNotification(ev.instance.id, ev.code));
      agentStatusStore.clear(ev.instance.id);
      claudeStatusParser.reset(ev.instance.id);
      codexStatusParser.reset(ev.instance.id);
    } else if (ev.type === 'killed') {
      notificationStore.push(exitToNotification(ev.instance.id, null));
      agentStatusStore.clear(ev.instance.id);
      claudeStatusParser.reset(ev.instance.id);
      codexStatusParser.reset(ev.instance.id);
    } else if (ev.type === 'attention') {
      notificationStore.push(attentionToNotification(ev.instance.id, ev.level));
    }
    refreshSessionCardsInto();
  });
  // NT2 — AgentStatus transitions become notifications so the bell
  // modal shows a unified audit trail alongside OSC / exit events.
  agentStatusStore.subscribe((id, rec) => {
    notificationStore.push(statusToNotification(id, rec));
    refreshSessionCardsInto();
  });
  // IPC followup (2026-05-13) — TUI's local AgentStatusStore mirrors
  // to daemon's canonical store via `POST /v1/agent-status` so PWA
  // `<StatusChip>` hydrates from claude-code / codex transitions
  // wherever chat is open. Probe-once + fire-and-forget POST per
  // transition (best-effort observer; failures silently log + skip
  // — never breaks the TUI's primary path). When the daemon isn't
  // running, the mirror stays inactive and incurs zero overhead.
  void (async () => {
    try {
      const { activateAgentStatusMirrorIfReachable } = await import('../agent-status/daemon-mirror.js');
      const handle = await activateAgentStatusMirrorIfReachable({
        store: agentStatusStore,
        log: (m) => { try { debug.log('agent-status.mirror', m); } catch { /* swallow */ } },
      });
      if (handle.active) {
        process.once('beforeExit', () => {
          try { handle.deactivate(); } catch { /* ignore */ }
        });
      }
    } catch (err) {
      try { debug.log('agent-status.mirror.activate-failed', String(err), { level: 'error' }); } catch { /* swallow */ }
    }
  })();
  const disposeConversationWidgetLiveBridge = createConversationWidgetLiveBridge({
    widgetHost,
    listSessions: () => listLiveEmbodiedSessions().map((entry) => ({
      session: entry.session,
      paneId: entry.paneId,
      windowId: entry.windowId,
    })),
    agentStatusStore,
    findObserver: findSessionObserver,
    requestRender: () => draw(),
  });
  process.once('beforeExit', () => {
    try { disposeConversationWidgetLiveBridge(); } catch { /* ignore */ }
  });
  // NT2 — BlockStore commits raise 'block' events (body previews
  // first line via adapter).
  blockStore.subscribe((block) => {
    notificationStore.push(blockToNotification(block));
    refreshSessionCardsInto();
  });
  // sidebar re-render on any NotificationStore push so unread badges
  // stay current. Agent-status/block subscribers already trigger
  // refreshSessionCardsInto, but direct notificationStore.push
  // (OSC, HITL future) needs the same behavior. Bell modal pulls
  // too so an open view stays live.
  notificationStore.subscribe(() => {
    refreshSessionCardsInto();
    if (bellOpen) refreshBellInto();
  });
  refreshSessionCardsInto();
  // UB3 — translate sidebar `submit` actions into concrete dashboard
  // side-effects. Format:
  //   session:<id>            → (future) focus that session
  //   toolbelt:attach:<id>    → "coming soon" toast (BL track in session L)
  //   toolbelt:review:<id>    → "coming soon" toast
  //   toolbelt:status:<id>    → print the session's last status event
  //                             into the log pane.
  // Arc C · v2 — attach a single absolute file path through the
  // existing tokenizer + context registry, return the token string
  // that should land in the input buffer. Shared between the
  // wd-browser dblclick-on-folder path (folder modal → file pick →
  // attach) and the @ picker Ctrl+I-on-folder path (same flow). Also
  // re-usable from @ picker Ctrl+I-on-file (direct attach, no modal).
  //
  // Mirrors the existing `onAtPick` body but exported into this
  // closure so multiple call sites can reuse it. Warnings land in
  // chatLines just like onAtPick; an empty result means the path
  // didn't tokenize to anything (broken symlink, etc.) and callers
  // should treat it as cancelled.
  const attachFilePathToken = async (absPath: string): Promise<string> => {
    return await attachDashboardFilePathToken(absPath, {
      tokenizeInput: (text) => tokenizeInput(text, contextRegistry),
      onWarning: (warning) => {
        const reason = warning.reason === 'not-a-file' ? 'not a regular file' : 'not found';
        chatLines.push(C.warning(`  ⚠ ${warning.raw} — ${reason}`));
      },
      renderAttachmentSummary: (added) => renderAttachmentSummary(added as never),
      markChanged: () => {
        chatScrollOffset = -1;
        draw();
      },
    });
  };

  // Arc C · v2 — open the folder picker modal over a folder and
  // attach whichever file the user selects. The callback receives the
  // resulting token string (or '' if the user cancelled) so callers
  // can splice it into the input buffer. Used by:
  //   1. dispatchSidebarSubmit('folder-attach:<abs>') — wd-browser
  //      dblclick on folder. Token goes into the live input via
  //      promptCtl.insertAtCursor when input mode is active.
  //   2. textInput onAtFolderAttach — @ picker Ctrl+I on folder.
  //      Token is returned via the resolved promise so picker-state
  //      splices it in place of `@<prefix>`.
  const openFolderAttachModal = (folderAbsPath: string, onToken: (token: string) => void): void => {
    openDashboardFolderAttachModal(folderAbsPath, onToken, {
      termSize,
      createFolderPickerModal,
      attachFilePathToken,
      pushModal: (surface) => display.pushModal(surface),
      getTheme: currentThemeTokens,
      draw,
    });
  };

  const dispatchSidebarSubmit = (text: string): void => {
    runDashboardSubmitAction(resolveDashboardSubmitAction(text), createDashboardSidebarSubmitRuntime({
      onChangeWorkingDir: (absPath, browserId) => {
        handleDashboardSidebarWorkingDirChange(absPath, browserId, {
          workingDir,
          resolveTargetBrowser: (id) => (resolveBrowserStateById(id) ?? workingDir) as WorkingDirState,
          enterRemoteDirectory,
          refreshRemoteWorkingDir: async () => {
            await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
          },
          refreshRemotePreviewBridge,
          enterDirectory,
          refreshWorkingDir,
          refreshWorkingDirPreview,
          onLogLine: (line) => { pushDebugLine(C.muted(line)); },
          onAfterChange: () => {
            chatScrollOffset = -1;
            draw();
          },
        });
      },
      onAttachFile: (absPath) => {
        handleDashboardSidebarAttachFile(absPath, {
          attachFilePathToken,
          openFolderAttachModal,
          insertAtCursor: (token) => { promptCtl.insertAtCursor?.(token); },
        });
      },
      onAttachFolder: (absPath) => {
        handleDashboardSidebarAttachFolder(absPath, {
          attachFilePathToken,
          openFolderAttachModal,
          insertAtCursor: (token) => { promptCtl.insertAtCursor?.(token); },
        });
      },
      getStatusRecord: (sessionId) => agentStatusStore.getRecord(sessionId),
      attachBlock: (sessionId) => {
        const result = blockAttach.attach(sessionId, blockStore);
        if (result.kind === 'no-block') return { kind: 'no-block' };
        return {
          kind: 'attached',
          attachmentId: result.attachment.block.id,
          lines: result.lines,
          bytes: result.bytes,
          total: result.total,
        };
      },
      markSessionRead: (sessionId) => { notificationStore.markRead(sessionId); },
      refreshSessionCards: refreshSessionCardsInto,
      getBackgroundSessionState: (sessionId) => globalBackgroundManager().status(sessionId)?.state,
      terminalBackgroundStates: TERMINAL_BACKGROUND_STATES,
      runSessionJoin: (sessionId, promoteToVW) => {
        runDashboardSidebarSessionJoin(sessionId, promoteToVW, {
          dispatchJoin: dispatchAcpSessionJoin,
          pushInfo: (message) => { chatLines.push(C.info(message)); },
          pushError: (message) => { chatLines.push(C.error(message)); },
          afterSettle: () => { chatScrollOffset = -1; },
        });
      },
      pushMutedLine: (line) => {
        chatLines.push(C.muted(line));
        chatScrollOffset = -1;
      },
      pushInfoLine: (line) => {
        chatLines.push(C.info(line));
        chatScrollOffset = -1;
      },
      pushLogText: (line) => {
        chatLines.push(line);
        chatScrollOffset = -1;
      },
    }));
  };
  dispatchDashboardSubmitText = dispatchSidebarSubmit;
  let browserContextMenuCursorResolver: (() => number | null) | null = null;
  let browserPreviewModalCloseRequest: (() => void) | null = null;
  // VP5 — observed playground reload timestamp. Per-redraw we poll
  // the wd-playground state; if its `reloadRequestedAt` advances past
  // this value the dashboard re-discovers widgets + re-registers the
  // inline playground type (discover() clears the registry so the
  // inline def needs to be re-added).
  let lastPlaygroundReloadAt = 0;
  let playgroundReloadInFlight = false;
  let lastPlaygroundLabPaletteKey = '';
  let lastPlaygroundThemeKey = '';
  let lastPlaygroundPresetKey = '';
  let lastPlaygroundShowcaseKey = '';
  let lastPlaygroundRunAt = 0;
  let lastPlaygroundSaveAt = 0;
  let lastPlaygroundLoadAt = 0;
  let lastPlaygroundShowcaseLaunchAt = 0;
  let playgroundRunInFlight = false;
  const ensureDefaultPlaygroundScenarioRegistry = () => {
    const reg = getDefaultScenarioRegistry();
    if (reg.list().length === 0) reg.registerAll(DEFAULT_SCENARIOS);
    return reg;
  };
  const currentPlaygroundPalette = (): PlaygroundScenarioPaletteEntry[] =>
    buildScenarioPaletteEntries(ensureDefaultPlaygroundScenarioRegistry().list());
  const currentPlaygroundThemes = (): PlaygroundThemeOptionEntry[] =>
    buildThemeOptionEntries();
  const currentPlaygroundPresets = (): PlaygroundPresetOptionEntry[] =>
    buildPresetOptionEntries();
  const currentPlaygroundShowcases = () =>
    buildShowcaseEntries();
  const replayPlaygroundState = (patch: (state: PlaygroundWidgetState) => PlaygroundWidgetState): boolean => {
    const inst = widgetHost.get('wd-playground') as { state?: PlaygroundWidgetState } | null;
    if (!inst?.state) return false;
    widgetHost.replayState('wd-playground', patch(inst.state));
    return true;
  };
  const maybeTriggerPlaygroundReload = (): void => {
    const inst = widgetHost.get('wd-playground');
    if (!inst) return;
    const ts = (inst.state as { reloadRequestedAt?: number } | null)?.reloadRequestedAt ?? 0;
    if (ts <= lastPlaygroundReloadAt) return;
    if (playgroundReloadInFlight) return;
    lastPlaygroundReloadAt = ts;
    playgroundReloadInFlight = true;
    statusFeedbackRuntime.onWidgetHostReloadStarted();
    void widgetHost.discover()
      .then(() => widgetHost.register(playgroundWidget, 'builtin', 'src/playground-widget.ts'))
      .then(() => { setWidgetHostForCatalog(widgetHost); })
      .then(() => statusFeedbackRuntime.onWidgetHostReloadCompleted())
      .catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        statusFeedbackRuntime.onWidgetHostReloadFailed(m);
      })
      .finally(() => { playgroundReloadInFlight = false; draw(); });
  };
  const openPlaygroundScenarioEditor = (scenario: Scenario): boolean => {
    const view = findDashboardView(viewRegistry, 'playground');
    if (view) setActiveDashboardView(view);
    const inst = widgetHost.get('wd-playground') as { state?: PlaygroundWidgetState } | null;
    if (!inst?.state) return false;
    const prevState = inst.state;
    const source = serializeScenarioToYaml(scenario);
    const palette = currentPlaygroundPalette();
    const themes = currentPlaygroundThemes();
    const presets = currentPlaygroundPresets();
    const showcases = currentPlaygroundShowcases();
    const prevPresetId = prevState.presetOptions[prevState.presetCursor]?.id;
    const prevShowcaseId = prevState.showcaseOptions[prevState.showcaseCursor]?.id;
    const nextState: PlaygroundWidgetState = {
      ...prevState,
      mode: 'edit',
      editSource: source,
      editCursor: 0,
      editScrollTop: 0,
      editResult: parseScenarioYaml(source),
      editScenarioId: scenario.id,
      scenarioPalette: palette,
      scenarioPaletteCursor: Math.max(0, palette.findIndex((entry) => entry.id === scenario.id)),
      themeOptions: themes,
      themeCursor: Math.max(0, themes.findIndex((entry) => entry.name === currentThemeTokens().name)),
      presetOptions: presets,
      presetCursor: Math.max(0, prevPresetId
        ? presets.findIndex((entry) => entry.id === prevPresetId)
        : 0),
      showcaseOptions: showcases,
      showcaseCursor: Math.max(0, prevShowcaseId
        ? showcases.findIndex((entry) => entry.id === prevShowcaseId)
        : 0),
      activeShowcasePluginId: pluginHost.active()?.name ?? undefined,
    };
    widgetHost.replayState('wd-playground', nextState);
    draw();
    return true;
  };
  const maybeSyncPlaygroundLabPalette = (): void => {
    const inst = widgetHost.get('wd-playground') as { state?: PlaygroundWidgetState } | null;
    if (!inst?.state) return;
    const palette = currentPlaygroundPalette();
    const paletteKey = palette.map((entry) => `${entry.id}:${entry.stepCount}`).join('|');
    if (paletteKey === lastPlaygroundLabPaletteKey && inst.state.scenarioPalette.length === palette.length) return;
    lastPlaygroundLabPaletteKey = paletteKey;
    const preferredCursorId = inst.state.scenarioPalette[inst.state.scenarioPaletteCursor]?.id
      ?? inst.state.editScenarioId
      ?? palette[0]?.id
      ?? null;
    const nextCursor = preferredCursorId
      ? Math.max(0, palette.findIndex((entry) => entry.id === preferredCursorId))
      : 0;
    widgetHost.replayState('wd-playground', {
      ...inst.state,
      scenarioPalette: palette,
      scenarioPaletteCursor: nextCursor,
    });
  };
  const maybeSyncPlaygroundVisualConsole = (): void => {
    const inst = widgetHost.get('wd-playground') as { state?: PlaygroundWidgetState } | null;
    if (!inst?.state) return;
    const themes = currentPlaygroundThemes();
    const presets = currentPlaygroundPresets();
    const showcases = currentPlaygroundShowcases();
    const themeKey = themes.map((entry) => entry.name).join('|');
    const presetKey = presets.map((entry) => entry.id).join('|');
    const showcaseKey = showcases.map((entry) => entry.id).join('|');
    if (
      themeKey === lastPlaygroundThemeKey &&
      presetKey === lastPlaygroundPresetKey &&
      showcaseKey === lastPlaygroundShowcaseKey &&
      inst.state.themeOptions.length === themes.length &&
      inst.state.presetOptions.length === presets.length &&
      inst.state.showcaseOptions.length === showcases.length &&
      inst.state.activeShowcasePluginId === (pluginHost.active()?.name ?? undefined)
    ) {
      return;
    }
    lastPlaygroundThemeKey = themeKey;
    lastPlaygroundPresetKey = presetKey;
    lastPlaygroundShowcaseKey = showcaseKey;
    const activeThemeName = currentThemeTokens().name;
    const preferredThemeName = inst.state.themeOptions[inst.state.themeCursor]?.name ?? activeThemeName;
    const preferredPresetId = inst.state.presetOptions[inst.state.presetCursor]?.id ?? presets[0]?.id ?? null;
    const preferredShowcaseId = inst.state.showcaseOptions[inst.state.showcaseCursor]?.id ?? showcases[0]?.id ?? null;
    widgetHost.replayState('wd-playground', {
      ...inst.state,
      themeOptions: themes,
      themeCursor: Math.max(0, themes.findIndex((entry) => entry.name === preferredThemeName || entry.name === activeThemeName)),
      presetOptions: presets,
      presetCursor: preferredPresetId
        ? Math.max(0, presets.findIndex((entry) => entry.id === preferredPresetId))
        : 0,
      showcaseOptions: showcases,
      showcaseCursor: preferredShowcaseId
        ? Math.max(0, showcases.findIndex((entry) => entry.id === preferredShowcaseId))
        : 0,
      activeShowcasePluginId: pluginHost.active()?.name ?? undefined,
    });
  };
  const maybeApplyPlaygroundThemeSelection = (): void => {
    const inst = widgetHost.get('wd-playground') as { state?: PlaygroundWidgetState } | null;
    const state = inst?.state;
    if (!state || state.mode !== 'edit') return;
    const desiredTheme = state.themeOptions[state.themeCursor]?.name;
    if (!desiredTheme || desiredTheme === currentThemeTokens().name) return;
    const cfg = getUserConfig();
    cfg.dashboard.theme = { ...(cfg.dashboard.theme as object ?? {}), active: desiredTheme } as never;
    saveUserConfig(cfg);
    replayPlaygroundState((prev) => ({
      ...prev,
      labFeedback: {
        level: 'info',
        title: 'Theme applied',
        at: Date.now(),
        lines: [`dashboard theme switched to ${desiredTheme}`],
      },
    }));
    draw();
  };
  const maybeHandlePlaygroundLabActions = (): void => {
    const inst = widgetHost.get('wd-playground') as { state?: PlaygroundWidgetState } | null;
    const state = inst?.state;
    if (!state || state.mode !== 'edit') return;
    const reg = ensureDefaultPlaygroundScenarioRegistry();
    if ((state.launchShowcaseRequestedAt ?? 0) > lastPlaygroundShowcaseLaunchAt) {
      lastPlaygroundShowcaseLaunchAt = state.launchShowcaseRequestedAt ?? 0;
      const showcase = state.showcaseOptions[state.showcaseCursor];
      if (!showcase) {
        replayPlaygroundState((prev) => ({
          ...prev,
          labFeedback: {
            level: 'error',
            title: 'Launch blocked',
            at: Date.now(),
            lines: ['no showcase lane is selected'],
          },
        }));
      } else {
        void pluginHost.activate(showcase.pluginId)
          .then(() => {
            replayPlaygroundState((prev) => ({
              ...prev,
              activeShowcasePluginId: showcase.pluginId,
              labFeedback: {
                level: 'success',
                title: 'Showcase launched',
                at: Date.now(),
                lines: [`${showcase.label} opened via plugin ${showcase.pluginId}`],
              },
            }));
            draw();
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            replayPlaygroundState((prev) => ({
              ...prev,
              labFeedback: {
                level: 'error',
                title: 'Showcase launch failed',
                at: Date.now(),
                lines: [message],
              },
            }));
            draw();
          });
      }
    }
    if ((state.loadRequestedAt ?? 0) > lastPlaygroundLoadAt) {
      lastPlaygroundLoadAt = state.loadRequestedAt ?? 0;
      const entry = state.scenarioPalette[state.scenarioPaletteCursor];
      if (!entry) {
        replayPlaygroundState((prev) => ({
          ...prev,
          labFeedback: {
            level: 'error',
            title: 'Load blocked',
            at: Date.now(),
            lines: ['no scenario is selected in the palette'],
          },
        }));
      } else {
        const scenario = reg.get(entry.id);
        if (!scenario) {
          replayPlaygroundState((prev) => ({
            ...prev,
            labFeedback: {
              level: 'error',
              title: 'Load blocked',
              at: Date.now(),
              scenarioId: entry.id,
              lines: [`${entry.id} is no longer registered`],
            },
          }));
        } else if (openPlaygroundScenarioEditor(scenario)) {
          replayPlaygroundState((prev) => ({
            ...prev,
            labFeedback: buildScenarioLoadFeedback(entry),
          }));
        }
      }
    }
    if ((state.saveRequestedAt ?? 0) > lastPlaygroundSaveAt) {
      lastPlaygroundSaveAt = state.saveRequestedAt ?? 0;
      const parsed = parseScenarioYaml(state.editSource);
      const resolution = resolveEditableScenarioSource(state.editSource, state.editScenarioId);
      if (!resolution.ok || !resolution.scenario) {
        replayPlaygroundState((prev) => ({ ...prev, labFeedback: resolution.feedback }));
      } else {
        reg.register(resolution.scenario);
        replayPlaygroundState((prev) => ({
          ...prev,
          editScenarioId: resolution.scenario!.id,
          scenarioPalette: currentPlaygroundPalette(),
          labFeedback: buildScenarioSaveFeedback(resolution.scenario!, parsed.warnings.length),
        }));
      }
    }
    if ((state.runRequestedAt ?? 0) > lastPlaygroundRunAt && !playgroundRunInFlight) {
      lastPlaygroundRunAt = state.runRequestedAt ?? 0;
      const resolution = resolveEditableScenarioSource(state.editSource, state.editScenarioId);
      if (!resolution.ok || !resolution.scenario) {
        replayPlaygroundState((prev) => ({ ...prev, labFeedback: resolution.feedback }));
      } else {
        playgroundRunInFlight = true;
        replayPlaygroundState((prev) => ({
          ...prev,
          labFeedback: {
            level: 'info',
            title: 'Run in progress',
            at: Date.now(),
            scenarioId: resolution.scenario!.id,
            lines: [`executing ${resolution.scenario!.id} against the live playground harness`],
          },
        }));
        void (async () => {
          const harness = createLivePlaygroundHarness({
            coordinator: display,
            contextKeys: getDashboardContextKeyService(),
            termSize: () => termSize(),
          });
          try {
            const result = await runScenario(resolution.scenario!, harness);
            replayPlaygroundState((prev) => ({
              ...prev,
              editScenarioId: resolution.scenario!.id,
              labFeedback: buildScenarioRunFeedback(result),
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            replayPlaygroundState((prev) => ({
              ...prev,
              labFeedback: {
                level: 'error',
                title: 'Run failed',
                at: Date.now(),
                scenarioId: resolution.scenario!.id,
                lines: [message],
              },
            }));
          } finally {
            playgroundRunInFlight = false;
            draw();
          }
        })();
      }
    }
  };
  let debugEventCursor = 0;
  let debugEventManual = false;
  let dashboardModals: ModalPlacement[] = [];
  const paneLabel = (pane: PaneFocus): string => {
    if (pane.startsWith('plugin:')) {
      return pluginHost.activeDashboardPanes().find(p => p.paneId === pane)?.title ?? pane;
    }
    switch (pane) {
      case 'browser': return workingDir.view === 3 ? 'Working Browser' : 'Browser';
      case 'obsidian': return 'Obsidian';
      case 'preview': return 'Preview';
      case 'scratch': return 'Scratch';
      case 'log': return 'Log';
      case 'skill-browser': return 'Skill Browser';
      case 'skill-file': return 'Skill File';
      // Surface-unification v2.2 V2.2-5 Part 2 — scheduler-* PaneFocus
      // title mappings retired.
      case 'agent-roster': return 'Agent Roster';
      case 'agent-detail': return 'Agent Detail';
      case 'agent-log': return 'Agent Log';
      case 'debug-events': return 'Debug Events';
      case 'debug-detail': return 'Debug Detail';
      case 'debug-stack': return 'Debug Stack';
      case 'debug-prompts': return 'Prompt Bank';
      case 'playground': return 'Widget Playground';
      default: return 'Pane';
    }
  };
  const modalTextForPane = (pane: PaneFocus): string => {
    const id = surfaceIdForWorkingFocus(pane, workingDir.view);
    const inst = id ? widgetHost.get(id) as any : null;
    if (!inst) return `${paneLabel(pane)} is not available in this view.`;
    if (inst.type === 'markdown') return String(inst.state?.text ?? '');
    if (inst.type === 'log') return (inst.state?.lines ?? []).slice(-240).join('\n');
    if (inst.type === 'agent-list') return renderAgentRoster(inst.state?.agents ?? [], inst.state?.cursor ?? 0, { theme: currentThemeTokens() }).join('\n');
    if (inst.type === 'agent-detail') return inst.state?.agent ? renderAgentDetail(inst.state.agent, { theme: currentThemeTokens() }) : '(no agent selected)';
    if (inst.type === 'list') {
      const rows = inst.state?.items ?? [];
      return rows.length > 0 ? rows.join('\n') : '(empty)';
    }
    if (inst.type === 'table') {
      const rows = inst.state?.rows ?? [];
      return rows.length > 0 ? rows.map((r: unknown) => Array.isArray(r) ? r.join('  ') : String(r)).join('\n') : '(empty)';
    }
    return `${paneLabel(pane)} is rendered by widget "${inst.type}".`;
  };
  const openDashboardPaneModal = (pane: PaneFocus): void => {
    if (pane === 'input') return;
    const id = `dashboard-pane-modal:${pane}`;
    try { widgetHost.dispose(id); } catch { /* absent */ }
    if (pane === 'agent-detail') {
      const detail = widgetHost.get('wd-agent-detail') as { state?: { agent?: AgentSurfaceState | null } } | null;
      widgetHost.spawn({
        type: 'agent-modal',
        id,
        character: 'Agent Modal',
        config: {
          agent: detail?.state?.agent ?? null,
          footer: 'j/k scroll  Esc close',
        },
      });
    } else {
      widgetHost.spawn({
        type: 'markdown',
        id,
        character: `${paneLabel(pane)} Modal`,
        config: { text: modalTextForPane(pane) },
      });
    }
    const { cols, rows } = termSize();
    dashboardModals = [{
      id: 'dashboard-pane-modal',
      widgetInstanceId: id,
      position: 'center',
      size: {
        width: Math.max(40, Math.min(110, cols - 8)),
        height: Math.max(10, Math.min(32, rows - 6)),
      },
    }];
    displayEvents.emit({ type: 'modal:open', id: 'dashboard-pane-modal', widgetInstanceId: id });
  };
  const leadColumnPanesFor = (def: DashboardViewDef): PaneFocus[] => {
    const out: PaneFocus[] = [];
    for (const row of def.rows) {
      if (row.leadColumn && !out.includes(row.leadColumn.pane)) out.push(row.leadColumn.pane);
    }
    return out;
  };
  const activePaneVisibility = () => {
    const def = activeViewDef();
    return visiblePanesForView(def.baseView, paneViewport(), {
      closed: closedPaneSet(),
      keepFocus: workingDir.focus,
      panes: panesForDashboardView(def),
      omitOrder: def.omitOrder,
      primary: def.primary,
      secondary: def.secondary,
      leadColumnPanes: leadColumnPanesFor(def),
      tabletMode: effectiveTabletMode(),
    });
  };
  const activeTopRowPanes = () => activeViewDef().rows[0]?.panes ?? [];
  const activeVisiblePaneSet = (): ReadonlySet<string> =>
    new Set(activePaneVisibility().visible);
  const activePreviewPaneWidth = (totalCols: number): number =>
    previewPaneWidthFor(totalCols, activeTopRowPanes(), activeVisiblePaneSet());
  const activeBasePaneHeight = (totalRows: number, visiblePanes: ReadonlySet<string>): number => {
    const paneHeight = paneHeightBeforeTargetRow(totalRows, activeViewDef().rows, 'log', visiblePanes);
    return Math.max(5, paneHeight > 0 ? paneHeight : totalRows);
  };
  const activeBaseLogHeight = (totalRows: number, visiblePanes: ReadonlySet<string>, paneHeight: number): number => {
    const logHeight = paneHeightForTargetRows(totalRows, activeViewDef().rows, 'log', visiblePanes);
    return Math.max(3, logHeight > 0 ? logHeight : Math.max(3, totalRows - paneHeight));
  };
  const lastPaneVisibility = new Map<PaneFocus, string>();
  const emitPaneVisibilityEvents = (): void => {
    const visibility = activePaneVisibility();
    const visible = new Set(visibility.visible);
    const omitted = new Map(visibility.omitted.map(o => [o.pane, o.reason]));
    const currentPanes = new Set(panesForDashboardView(activeViewDef()));
    for (const pane of currentPanes) {
      const isVisible = visible.has(pane);
      const reason = omitted.get(pane);
      const sig = `${isVisible ? '1' : '0'}:${reason ?? ''}`;
      if (lastPaneVisibility.get(pane) !== sig) {
        displayEvents.emit({
          type: 'pane:visibility',
          pane,
          visible: isVisible,
          ...(reason ? { reason } : {}),
        });
        lastPaneVisibility.set(pane, sig);
      }
    }
    for (const pane of [...lastPaneVisibility.keys()]) {
      if (currentPanes.has(pane)) continue;
      displayEvents.emit({ type: 'pane:visibility', pane, visible: false, reason: 'view-change' });
      lastPaneVisibility.delete(pane);
    }
  };
  const canCloseActivePane = (pane: PaneFocus): boolean => {
    const def = activeViewDef();
    return pane !== 'input'
      && pane !== def.primary
      && panesForDashboardView(def).includes(pane);
  };
  const closeDashboardPane = (pane: PaneFocus): boolean => {
    if (!canCloseActivePane(pane)) return false;
    if (pane === 'scratch') scratchClosed = true;
    userClosedPanes.add(pane);
    repairVisibleFocus();
    return true;
  };
  const openDashboardPane = (pane: PaneFocus): boolean => {
    if (pane === 'input') return false;
    if (!panesForDashboardView(activeViewDef()).includes(pane)) return false;
    if (pane === 'scratch') scratchClosed = false;
    userClosedPanes.delete(pane);
    return true;
  };
  const restoreAllClosedDashboardPanes = (): void => {
    userClosedPanes.clear();
    scratchClosed = false;
    repairVisibleFocus();
  };
  const paneStateSnapshot = () => {
    const def = activeViewDef();
    const visibility = activePaneVisibility();
    const visible = new Set(visibility.visible);
    const omitted = new Map(visibility.omitted.map(o => [o.pane, o.reason]));
    return {
      activeViewId,
      viewLabel: def.label,
      baseView: def.baseView,
      focused: workingDir.focus,
      compactLevel: visibility.compactLevel,
      primary: def.primary,
      panes: panesForDashboardView(def).map(pane => ({
        pane,
        visible: visible.has(pane),
        closed: closedPaneSet().has(pane),
        closeable: canCloseActivePane(pane),
        omittedReason: omitted.get(pane) ?? null,
      })),
    };
  };
  const closedStarterPanes = (): PaneFocus[] => (
    paneStateSnapshot().panes
      .filter((pane) => pane.closed)
      .map((pane) => pane.pane)
  );
  const describeViewStarterPackage = (view: DashboardViewDef): string => {
    const panes = panesForDashboardView(view);
    const labels = panes.slice(0, 3).map((pane) => paneLabel(pane));
    const extra = panes.length - labels.length;
    const starter = labels.join(' + ');
    const suffix = extra > 0 ? ` +${extra}` : '';
    const activeClosed = view.id === activeViewId ? closedStarterPanes().length : 0;
    const closed = activeClosed > 0 ? ` · closed ${activeClosed}` : '';
    return `Starter: ${starter}${suffix}${closed}`;
  };
  const setDashboardPaneOmitOrder = (rawPanes: readonly string[]) => {
    const def = activeViewDef();
    const activePanes = panesForDashboardView(def);
    const seen = new Set<PaneFocus>();
    const next: PaneFocus[] = [];
    for (const raw of rawPanes) {
      if (typeof raw !== 'string') continue;
      const pane = raw as PaneFocus;
      if (!activePanes.includes(pane)) throw new Error(`pane "${raw}" is not part of the active view`);
      if (!seen.has(pane)) {
        seen.add(pane);
        next.push(pane);
      }
    }
    if (next.length === 0) throw new Error('omitOrder must include at least one pane from the active view');
    for (const pane of activePanes) {
      if (!seen.has(pane)) next.push(pane);
    }
    def.omitOrder = next;
    requestDashboardRender();
    return paneStateSnapshot();
  };
  const promptRuntimeState = (intents: string[] = []) => {
    const paneState = paneStateSnapshot();
    const activePlugin = pluginHost.active()?.name;
    const provider = inspectActiveProvider();
    return {
      activeView: activeViewId,
      focusedPane: String(workingDir.focus),
      visiblePanes: paneState.panes.filter(p => p.visible).map(p => p.pane),
      activePlugins: activePlugin ? [activePlugin] : [],
      loadedSkills: [],
      loadedWorkflows: [],
      onlineResources: [],
      intents,
      debugLevel: debug.level(),
      modelFamily: getModelFamily(provider.model),
      tags: [],
    };
  };
  const setPromptBankRuntimeConfig = (patch: Record<string, unknown>) => {
    const cfg = getUserConfig();
    const current = cfg.dashboard.promptBank;
    const next = {
      ...current,
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch.dashboardTurns === 'boolean' ? { dashboardTurns: patch.dashboardTurns } : {}),
      ...(typeof patch.skillRuns === 'boolean' ? { skillRuns: patch.skillRuns } : {}),
      ...(typeof patch.record === 'boolean' ? { record: patch.record } : {}),
      ...(typeof patch.budgetTokens === 'number' && Number.isFinite(patch.budgetTokens)
        ? { budgetTokens: Math.max(100, Math.min(20000, Math.floor(patch.budgetTokens))) }
        : {}),
      ...(typeof patch.limit === 'number' && Number.isFinite(patch.limit)
        ? { limit: Math.max(1, Math.min(100, Math.floor(patch.limit))) }
        : {}),
    };
    saveUserConfig({
      ...cfg,
      dashboard: {
        ...cfg.dashboard,
        promptBank: next,
      },
    });
    return next;
  };
  const describePromptBankRuntimeConfig = (): string => {
    const cfg = getUserConfig().dashboard.promptBank;
    return [
      `enabled=${cfg.enabled ? 'on' : 'off'}`,
      `dashboardTurns=${cfg.dashboardTurns ? 'on' : 'off'}`,
      `skillRuns=${cfg.skillRuns ? 'on' : 'off'}`,
      `record=${cfg.record ? 'on' : 'off'}`,
      `budgetTokens=${cfg.budgetTokens}`,
      `limit=${cfg.limit}`,
    ].join('  ');
  };
  const parseOnOffArg = (raw: string | undefined, current: boolean): boolean | null => {
    const v = (raw ?? '').toLowerCase();
    if (v === 'on' || v === 'true' || v === '1' || v === 'enable' || v === 'enabled') return true;
    if (v === 'off' || v === 'false' || v === '0' || v === 'disable' || v === 'disabled') return false;
    if (v === 'toggle') return !current;
    return null;
  };
  const debugAgentSnapshot = () => {
    const agents = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
    return {
      counts: {
        total: agents.length,
        running: agents.filter(agent => agent.status === 'running').length,
        done: agents.filter(agent => agent.status === 'done').length,
        error: agents.filter(agent => agent.status === 'error').length,
        cancelled: agents.filter(agent => agent.status === 'cancelled').length,
        queued: agents.filter(agent => agent.status === 'queued').length,
      },
      selected: agents[agentRosterCursor] ?? agents.find(agent => agent.status === 'running') ?? agents[0] ?? null,
      agents,
    };
  };
  const debugLastLlmSignals = () => {
    const events = debug.events(200);
    const latest = (predicate: (event: (typeof events)[number]) => boolean) => [...events].reverse().find(predicate) ?? null;
    return {
      request: latest(event => event.category === 'llm.request'),
      response: latest(event =>
        event.category === 'llm.response.complete'
        || event.category === 'llm.response.error'
        || event.category === 'llm.response.status'
        || event.category === 'llm.response.aborted'
      ),
      toolLoop: latest(event => event.category === 'llm.router' && event.event.startsWith('tool-loop.')),
    };
  };
  const debugCallStackSnapshot = (limit = 24) => {
    const agents = debugAgentSnapshot().agents;
    const lastLlm = debugLastLlmSignals();
    return buildDebugCallStack({
      events: debug.events(200),
      agents,
      lastLlm,
      limit,
    });
  };
  const describePaneStateForPrompt = (): string => {
    const state = paneStateSnapshot();
    const rows = state.panes.map(p => {
      const bits = [
        p.visible ? 'visible' : 'hidden',
        p.closed ? 'closed' : '',
        p.closeable ? 'closeable' : 'primary',
        p.omittedReason ? `omitted=${p.omittedReason}` : '',
      ].filter(Boolean).join(', ');
      return `- ${p.pane}: ${bits}`;
    });
    return [
      '## Dashboard Pane State',
      '',
      `Active view: ${state.activeViewId} "${state.viewLabel}" (baseView=${state.baseView}, compact=${state.compactLevel}, focus=${state.focused})`,
      ...rows,
    ].join('\n');
  };
  // Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — schedulerView
  // state · openSchedulerForm · activeSchedulerFormValue /
  // setActiveSchedulerFormValue · submitSchedulerForm 모두 폐기.
  // scheduler view 전체 retire (workflow scheduleTrigger 가 흡수).

  // Browser / scratchpad width helpers — see src/panes/pane-sizing.ts
  // for the 1:3:1 ratio + cap rationale. Imported at the top of this
  // file so they're available to both the layout loop and the glow
  // width estimate (src/dashboard.ts:2942 area).

  // View layouts are rebuilt per draw because the browser-pane cap
  // depends on the current terminal width. Four views — switched by
  // Ctrl+1..4. All views embed the log widget inline so the bottom
  // log area is suppressed when in working-dir workspace (see draw()
  // below).
  //   V1: Normal    — browser + preview + scratch, log   (default)
  //   V2: Obsidian  — Working | Preview | Obsidian / Log | Scratch
  //   V3: Skill     — Skill Browser | Skill File | Preview / Log | Scratch | Working
  //   V4: Scheduler — status lanes / board + inspector / log + scratch
  const workingDirLayoutForView = (totalW: number, gridHeight: number = 30): Layout => {
    const def = activeViewDef();
    const visibility = visiblePanesForView(
      def.baseView,
      { cols: totalW, rows: gridHeight },
      {
        closed: closedPaneSet(),
        keepFocus: workingDir.focus,
        panes: panesForDashboardView(def),
        omitOrder: def.omitOrder,
        primary: def.primary,
        secondary: def.secondary,
        leadColumnPanes: leadColumnPanesFor(def),
        tabletMode: effectiveTabletMode(),
      },
    );
    // Terminal-expand reuses the active view's ratio-derived top/log
    // split so its fallback geometry matches the normal dashboard.
    const visiblePanes = new Set(visibility.visible);
    const baseTopH = activeBasePaneHeight(gridHeight, visiblePanes);
    const maxTopH = Math.max(3, gridHeight - 3);
    const topH = Math.min(maxTopH, Math.max(3, baseTopH - logHeightBias));

    // Phase T7 — "terminal expand" mode: hide every other top-row
    // widget (browser, scratch, obsidian, skill-*) and give the full
    // top-row width to wd-preview so the embedded shell has room for
    // wider commands (btop, neovim, tmux splits). Only kicks in when
    // the session is actually alive — otherwise we'd leave the user
    // staring at an empty full-width preview. Restored on toggle.
    if (terminalExpanded && previewTerminal?.isAlive) {
      return createLayout([
        { height: topH, cells: [{ widgetInstanceId: 'wd-preview', width: 'flex' }] },
        { height: 'flex', cells: [{ widgetInstanceId: 'wd-log', width: 'flex' }] },
      ]);
    }
    return compileDashboardViewLayout(
      def,
      new Set(visibility.visible),
      surfaceIdForWorkingFocus,
    );
  };

  // Plain row label used as the list widget's identity (selection
  // matching, cursor display string). Kept ANSI-free so visibleWidth
  // and the selected-set string lookup work correctly.
  const fmtEntry = (e: FsEntry): string => e.isDir ? `${e.name}/` : e.name;

  // Colored variant for the list widget's `items` array — yazi-style
  // accent for folders, per-extension fileColor for files. The list
  // widget renders these straight through when preserveAnsi is true.
  const fmtEntryColored = (e: FsEntry): string => {
    if (e.name === '..') return C.muted('..');
    if (e.isDir) return dirColor(e.name);
    return fileColor(e.name)(e.name);
  };

  // Per-row icon shown right after the selection mark. Folders pick a
  // single shared glyph so the user can scan directory structure at a
  // glance; files pick from fileIcon's extension table. Constants
  // FOLDER_ICON / PARENT_ICON are hoisted above so the preview helper
  // can reuse the same glyphs.
  const iconForEntry = (e: FsEntry): string => {
    if (e.name === '..') return C.muted(PARENT_ICON);
    if (e.isDir) return C.accent(FOLDER_ICON);
    return fileColor(e.name)(fileIcon(e.name));
  };

  // U-4.2 · always-current wd-log state. Extracted from the full
  // `syncWorkingDirWidgetState` below so branches that don't run the
  // full sync (renderChatOnly, plugin layout) still push fresh chat
  // content into the widget before render. Keeping this idempotent +
  // side-effect-free so it's safe to call twice per frame (the full
  // sync also triggers this · duplicate write just reassigns the
  // same refs).
  const syncLogWidgetState = (): void => {
    const log = widgetHost.get('wd-log') as { state: LogSurfaceStateContract } | null;
    if (debug.enabled) {
      debug.log('dashboard.chat.stream', 'syncLogWidgetState', {
        chatLinesLen: chatLines.length,
        scrollOffset: chatScrollOffset,
        footerLine: chatFooterLine.current === null ? null : chatFooterLine.current.length,
        logFrozenTailIndex,
        widgetExists: log !== null,
      });
    }
    logWidgetRuntime.syncMain(log?.state ?? null, {
      lines: chatLines,
      scrollOffset: chatScrollOffset,
      focused: workingDir.focus === 'log',
      footerLine: chatFooterLine.current,
      // ⭐⭐ `B1`·`B2`(2026-08-19 · 대표 지시) — 큐를 «스트리밍 프롬프트 영역»에 그린다.
      //   ⛔ 종전엔 컴포저 행에 그렸고, 그것도 «다음 키 입력 때»만 그려졌다
      //     (`paintTurnTypeaheadEcho` 가 키 핸들러 «한 곳»에서만 불렸다).
      //   ⭐ 여기 두면 «시점»(B2) 문제가 «공짜로» 풀린다 — 이 자리는 스트리밍 중 매 프레임
      //     다시 그려지므로 큐가 바뀌는 «순간» 화면이 따라온다.
      //     「누가 다시 그려 주나」를 사람이 세지 않아도 된다.
      queueRow: renderTurnTypeaheadQueueRow(turnTypeaheadRef.state, Math.max(20, termSize().cols - 6)),
      logFrozenTailIndex,
      logSearchCursor,
      logSearchResultsLength: logSearchResults.length,
      logFilterQuery,
      logSearchQuery,
      foldMode: logFoldMode,
      clickDeps: buildLogClickDeps(),
    });
  };

  const syncDebugLogWidgetState = (): void => {
    const debugLog = widgetHost.get('wd-debug-log') as { state: LogSurfaceStateContract } | null;
    logWidgetRuntime.syncDebug(debugLog?.state ?? null, {
      lines: debugLines,
      scrollOffset: debugScrollOffset,
      filterQuery: debugLogFilterQuery,
    });
  };

  // U-4.2 · render the log via the wd-log widget wrapped in a single-
  // row layout. Replaces the direct `renderLogPane(...)` call in the
  // chat-only and default branches of the zone composer so every log
  // render reaches `wd-log.render()` — U-4.3's `wd-log.onMouse` can
  // then absorb every log-area click without the dashboard branching
  // on "is the log inside the grid or below it". Grid-layout geometry
  // (logEmbedded flag, paneH sizing) stays unchanged; this helper
  // only unifies the renderer.
  const renderLogViaWidget = (h: number, c: number, topRow: number): string[] => {
    return logRenderRuntime.render(h, c, topRow, workingDir.focus === 'log');
  };

  const syncWorkingDirWidgetState = (): void => {
    repairVisibleFocus();
    emitPaneVisibilityEvents();
    // Preview-source bookkeeping: whenever focus lands on one of the
    // two browsers, remember which — smart mode mirrors whichever
    // browser was last active. Changing the tracked browser auto-
    // refreshes the preview so smart mode feels responsive.
    if (workingDir.focus === 'browser' && dockedPreview.lastBrowserFocus !== 'browser') {
      dockedPreview.lastBrowserFocus = 'browser';
      if (dockedPreview.sourceMode === 'smart') refreshWorkingDirPreview();
    } else if (workingDir.focus === 'obsidian' && dockedPreview.lastBrowserFocus !== 'obsidian') {
      dockedPreview.lastBrowserFocus = 'obsidian';
      if (dockedPreview.sourceMode === 'smart') refreshWorkingDirPreview();
    } else if (workingDir.focus === 'skill-file' && dockedPreview.lastBrowserFocus !== 'skill-file') {
      dockedPreview.lastBrowserFocus = 'skill-file';
      if (dockedPreview.sourceMode === 'smart') refreshWorkingDirPreview();
    }
    const browser = widgetHost.get('wd-browser') as any;
    if (browser) {
      // P3.2: skip the O(N) entry map + selection scan when the
      // underlying set hasn't changed. working-dir mutators
      // (refresh / sortMode flip / toggle hidden / selection toggle)
      // replace the entries ARRAY reference, so identity comparison
      // cheaply detects any structural change. We also re-render on
      // cursor/offset/selection-size/focus-flag moves since those
      // affect what the widget draws without replacing entries.
      const changed = browserWidgetRuntime.shouldRefresh({
        entries: _lastBrowserEntries,
        selectedSize: _lastBrowserSelSize,
        cursor: _lastBrowserCursor,
        offset: _lastBrowserOffset,
      }, workingDir);
      if (changed) {
        Object.assign(browser.state, browserWidgetRuntime.buildProjection(workingDir));
        const nextCache = browserWidgetRuntime.nextCache(workingDir);
        _lastBrowserEntries = nextCache.entries;
        _lastBrowserSelSize = nextCache.selectedSize;
        _lastBrowserCursor = nextCache.cursor;
        _lastBrowserOffset = nextCache.offset;
      }
      // Focus flag changes cheaply — always sync it so a pure focus
      // switch (no entry mutation) still lights the browser color.
      browser.state.focused = workingDir.focus === 'browser';
    }
    // ── Sub-agent roster polling (hoisted before preview so
    // wd-preview can mirror the cursor-selected agent) ──
    // Build a fresh snapshot from globalAgentRegistry each draw.
    // Cheap (a handful of tasks). Auto-promotes scratch to 'agents'
    // mode on first spawn since the last "fully empty" state.
    //
    // P3.1: the full syncTasksWithChanges + emit path is only useful
    // when somebody actually consumes 'agent:update' events. When no
    // subscribers are registered (common — the event was being emitted
    // every draw with no listener), fall back to the cheaper
    // syncTasks() which skips signature bookkeeping and event payload
    // construction. The roster state itself is still consumed by the
    // wd-preview mirror + status bar below, so we can't skip the
    // sync — only the emit pipeline.
    const agentEventSubscribed = displayEvents.hasSubscribers('agent:update');
    const agentRoster = agentRosterRuntime.sync(globalAgentRegistry.list(), agentEventSubscribed);
    if (agentRoster.length === 0) {
      // Full drain → reset both the dismissed flag and the manual-
      // cursor lock so the next batch gets a fresh auto-follow.
      if (agentsViewDismissed) agentsViewDismissed = false;
      agentCursorManual = false;
      agentCursorLockedId = '';
      if (companionPopupHost.isActive('agents')) {
        companionPopupHost.close('agents');
        syncCompanionPopups();
      }
    } else if (!agentsViewDismissed && !companionPopupHost.isActive('agents')) {
      setCompanionPopupOpen('agents', true);
    }
    // Cursor placement policy:
    // - When the user has grabbed the cursor manually (j/k since last
    //   drain), keep it locked on the task they picked; find that task
    //   in the current roster and update the cursor index.
    // - Otherwise auto-follow: prefer the FIRST 'running' task
    //   (lowest startedAt, so the "one the LLM spawned earliest and
    //   is still working on"). If nothing is running, fall back to
    //   the LAST task overall (most recently finished / spawned).
    if (agentRoster.length > 0) {
      if (agentCursorManual && agentCursorLockedId) {
        const idx = agentRoster.findIndex(t => t.id === agentCursorLockedId);
        agentRosterCursor = idx >= 0 ? idx : Math.min(agentRosterCursor, agentRoster.length - 1);
      } else {
        const firstRunning = agentRoster.findIndex(t => t.status === 'running');
        agentRosterCursor = firstRunning >= 0 ? firstRunning : agentRoster.length - 1;
        agentCursorLockedId = agentRoster[agentRosterCursor]!.id;
      }
    } else {
      agentRosterCursor = 0;
    }
    // P4.1: apply roster filter + sort to what the widget sees. The
    // underlying `agentRoster` array is preserved for cursor locks
    // and wd-preview mirror (which still uses startedAt order). The
    // widget gets a TRANSFORMED view; cursor is clamped to the view.
    let rosterView = agentRoster;
    if (agentRosterFilter !== 'all') {
      rosterView = rosterView.filter(a =>
        agentRosterFilter === 'running'
          ? a.status === 'running'
          : a.status === 'error',
      );
    }
    if (agentRosterSort !== 'default') {
      rosterView = [...rosterView].sort((a, b) => {
        switch (agentRosterSort) {
          case 'elapsed':  return b.elapsedMs - a.elapsedMs;
          case 'tools':    return b.toolCount - a.toolCount;
          case 'name':     return a.name.localeCompare(b.name);
          case 'status':   return a.status.localeCompare(b.status);
          default:         return 0;
        }
      });
    }
    const selectedAgentSurface = rosterView.length > 0
      ? rosterView[Math.max(0, Math.min(agentRosterCursor, rosterView.length - 1))]
      : null;
    const agentRosterWidget = widgetHost.get('wd-agent-roster') as any;
    agentWidgetRuntime.projectRoster(agentRosterWidget, {
      agents: rosterView,
      cursor: agentRosterCursor,
      focused: workingDir.focus === 'agent-roster',
      showHelp: agentRosterHelp && workingDir.focus === 'agent-roster',
      filter: agentRosterFilter,
      sort: agentRosterSort,
      flashCount: globalAgentFlash.pending().length,
    });
    const agentDetailWidget = widgetHost.get('wd-agent-detail') as any;
    agentWidgetRuntime.projectDetail(agentDetailWidget, {
      agent: selectedAgentSurface,
      focused: workingDir.focus === 'agent-detail',
    });
    const agentLogWidget = widgetHost.get('wd-agent-log') as any;
    if (agentLogWidget) {
      // P5.3: when debug level is 'detail' AND this agent has
      // captured timeline entries, replace the simple log trail
      // with a proper timeline view. Each call is shown with its
      // wall-clock time, tool name, duration (on result phase),
      // and arg/result preview. Non-detail level keeps the legacy
      // compact log.
      let detailTimeline: string | null = null;
      if (selectedAgentSurface && debug.isDetailEnabled()) {
        const buf = agentToolCallBuffer.get(selectedAgentSurface.id);
        if (buf && buf.length > 0) {
          detailTimeline = renderAgentToolTimeline(buf);
        }
      }
      agentWidgetRuntime.projectLog(agentLogWidget, {
        agent: selectedAgentSurface,
        focused: workingDir.focus === 'agent-log',
        detailTimeline,
      });
    }

    const debugEventSnapshot = debugEventRuntime.snapshot(
      debug.events(200),
      debugEventCursor,
      debugEventManual,
    );
    const debugEventsOldest = debugEventSnapshot.oldest;
    const debugEventsNewest = debugEventSnapshot.newest;
    debugEventCursor = debugEventSnapshot.cursor;
    const selectedDebugEvent = debugEventSnapshot.selected;
    const debugStatus = debug.status();
    const debugEventsWidget = widgetHost.get('wd-debug-events') as any;
    debugWidgetRuntime.projectEvents(debugEventsWidget, {
      items: renderDebugEventRows(debugEventsNewest, { theme: currentThemeTokens() }),
      cursor: debugEventCursor,
      focused: workingDir.focus === 'debug-events',
      level: debugStatus.level,
    });
    const debugDetailWidget = widgetHost.get('wd-debug-detail') as any;
    debugWidgetRuntime.projectDetail(debugDetailWidget, {
      text: renderDebugEventDetail(selectedDebugEvent, debugStatus),
      focused: workingDir.focus === 'debug-detail',
      selectedEvent: selectedDebugEvent,
    });
    const debugStackWidget = widgetHost.get('wd-debug-stack') as any;
    debugWidgetRuntime.projectStack(debugStackWidget, {
      text: debugSurfaceRuntime.buildStackText({
        oldestEvents: debugEventsOldest,
        debugStatus,
        callStack: debugCallStackSnapshot(28),
        executionHistory: pluginHost.executionHistory(8),
        theme: currentThemeTokens(),
      }),
      focused: workingDir.focus === 'debug-stack',
      runningAgents: debugSurfaceRuntime.runningAgentCount(agentRoster),
      level: debugStatus.level,
    });
    const debugPromptsWidget = widgetHost.get('wd-debug-prompts') as any;
    const promptLogs = getPromptBankStore().listInjectionLogs(25);
    debugWidgetRuntime.projectPrompts(debugPromptsWidget, {
      text: debugSurfaceRuntime.buildPromptText(promptLogs),
      focused: workingDir.focus === 'debug-prompts',
      count: promptLogs.length,
    });
    const debugLogWidget = widgetHost.get('wd-debug-log') as any;
    if (debugLogWidget) {
      syncDebugLogWidgetState();
      debugWidgetRuntime.projectLogTitle(debugLogWidget, {
        mirrorEnabled: debug.isMirrorEnabled(),
        level: debug.level(),
      });
    }
    const preview = widgetHost.get('wd-preview') as any;
    if (preview) {
      // Phase T: embedded terminal takes precedence over every other
      // preview source. Snapshot the emulator grid to ANSI; widget
      // renders it preformatted so SGR / cursor-column alignment
      // survive the pass-through.
      const activeExecution = activeExecutionSurfaceId
        ? executionSurfaces.get(activeExecutionSurfaceId) ?? null
        : null;
      const executionActive = activeExecution?.terminal.isAlive ?? false;
      const terminalActive = executionActive || (previewTerminal?.isAlive ?? false);
      if (terminalActive) {
        const focused = workingDir.focus === 'preview' || display.currentFocus() === activeExecution?.id;
        let text: string;
        let title: string;
        if (executionActive && activeExecution) {
          const dims = computePreviewTerminalDims();
          text = activeExecution.render({
            width: dims.cols,
            height: dims.rows,
            focused,
          }).join('\n');
          title = `Execution \u00B7 ${activeExecution.id} \u00B7 ${dims.cols}\u00D7${dims.rows}`;
        } else {
          text = previewTerminal!.render(focused);
          const pid = previewTerminal!.pid;
          const scrollTag = previewTerminal!.isScrolledBack
            ? ` \u00B7 \u21E7 ${previewTerminal!.scrollbackOffset}`  // ⇧ N
            : '';
          title = `Terminal \u00B7 pid ${pid} \u00B7 ${previewTerminal!.cols}\u00D7${previewTerminal!.rows}${scrollTag}`;
        }
        previewWidgetRuntime.projectTerminal(preview, { text, focused, title });
      }
      if (terminalActive) {
        // already populated above
      } else if (viEditor) {
        // T3-C2 — vi-editor owns the preview pane. Render the
        // editor's current frame (body + status) into the widget.
        const vts = termSize();
        const previewRowsEst = Math.max(4, Math.floor(vts.rows * 0.55));
        const previewColsEst = Math.max(20, Math.floor((vts.cols - 1) * 0.4));
        const state = viEditor.getState();
        const rows = viEditor.render({
          cols: previewColsEst,
          rows: previewRowsEst,
          topLine: Math.max(1, state.row - Math.floor(previewRowsEst / 2)),
          showStatus: true,
        });
        const ms = state.mode === 'insert' ? 'INS' : state.mode === 'command' ? 'CMD' : 'NOR';
        previewWidgetRuntime.projectVi(preview, {
          text: rows.join('\n'),
          focused: workingDir.focus === 'preview',
          title: `vi ${ms} \u00B7 ${basename(state.filePath)}${state.dirty ? ' [+]' : ''}`,
        });
      } else {
        previewWidgetRuntime.projectPlain(preview, {
          text: dockedPreview.previewLines.join('\n'),
          scroll: dockedPreview.previewOffset,
          focused: workingDir.focus === 'preview',
          title: previewSurfaceRuntime.buildPlainTitle(
            dockedPreview.sourceMode,
            workingDir.view,
            dockedPreview.lastBrowserFocus,
            resolvePreviewBindingMode(dockedPreview),
          ),
        });
      }
    }
    const clipboardWidget = widgetHost.get('wd-clipboard') as any;
    companionWidgetRuntime.projectClipboardWidget(
      clipboardWidget,
      clipboardHistoryRuntime.mapEntries(clipHistory.entries),
      clipCursor,
    );
    const memoWidget = widgetHost.get('wd-memo') as any;
    companionWidgetRuntime.projectMemoWidget(memoWidget);
    const detailWidget = widgetHost.get('wd-detail') as any;
    companionWidgetRuntime.projectDetailWidget(detailWidget, detailViewerRuntime.snapshot());
    // U-4.3 · delegate to the shared `syncLogWidgetState` helper
    // (was duplicated inline pre-U-4.3). Same call runs from
    // `renderLogViaWidget` for the non-embedded branches; here we
    // cover the logEmbedded path (views 1-4) where the log is
    // rendered as a cell inside the grid layout. Sync now also
    // injects `clickDeps` so wd-log.onMouse can run attachment
    // hit-tests uniformly across modes.
    syncLogWidgetState();
    // Surface-unification v2.2 V2.2-5 (2026-05-11) — scheduler-widget
    // projection retired (scheduler view 폐기). 잔존 wd-scheduler-*
    // widget ids + schedulerView state + syncSchedulerSelection +
    // schedulerTaskCards/Rows/Inspector 는 Part 2 BACKLOG (dashboard
    // god-object surgery) 에서 마저 cleanup.
    // Skill view panes (V3). Skill Browser shows the top-level skills
    // under LOCAL_SKILLS_DIR; Skill File shows the manifest-first
    // flattened file listing for the currently selected skill. File
    // rows display `relPath` so nested files stay legible.
    const skillBrowserW = widgetHost.get('wd-skill-browser') as any;
    skillWidgetRuntime.projectBrowser(
      skillBrowserW,
      skillView.skills,
      skillView.skillsRoot,
      skillView.skillCursor,
      skillView.skillOffset,
      workingDir.focus === 'skill-browser',
      C.muted,
      C.accent,
    );
    const skillFileW = widgetHost.get('wd-skill-file') as any;
    skillWidgetRuntime.projectFiles(
      skillFileW,
      skillView,
      workingDir.focus === 'skill-file',
      C.muted,
      (file) => file.isManifest ? C.bold(fileColor(file.name)(file.relPath)) : fileColor(file.name)(file.relPath),
      (file) => fileColor(file.name)(fileIcon(file.name)),
    );
    // Secondary Working Browser mirror for Skill view bottom row —
    // shares workingDir state with the main `wd-browser` widget but
    // carries its own focus flag and title. Acts as the attach/preview
    // source when the user wants to pull a path from the project
    // into a skill iteration.
    const workingBrowserBottom = widgetHost.get('wd-working-browser') as any;
    browserMirrorRuntime.projectWorkingBrowser(
      workingBrowserBottom,
      workingDir.entries,
      workingDir.cursor,
      workingDir.offset,
      workingDir.selected,
      workingDir.focus === 'browser' && workingDir.view === 3,
      fmtEntryColored,
      iconForEntry,
    );

    // Obsidian vault browser (V2). Mirrors the working-dir browser
    // row shape so fmtEntryColored + iconForEntry work as-is. When
    // the vault is unavailable we paint a single muted line pointing
    // at the env var so the user knows how to configure it.
    const obsidian = widgetHost.get('wd-obsidian') as any;
    browserMirrorRuntime.projectObsidian(
      obsidian,
      obsidianDir,
      workingDir.focus === 'obsidian',
      fmtEntryColored,
      iconForEntry,
      C.warning,
      C.muted,
    );
  };

  // ── Workspace context builder ──
  // Emitted once per chat turn (prepended to the user message) so the
  // LLM knows what widgets are currently on screen and how to write
  // to them via layout_setWidgetState / layout_addWidget without
  // having to probe layout_getState first. Kept compact — iteration
  // order matches visual layout (top-to-bottom, left-to-right).
  //
  // Writable surfaces:
  //   wd-scratch  — primary canvas for notes / reports. Persists
  //                 until the user clears or switches to memo mode.
  //   wd-preview  — secondary canvas. Persists until the user
  //                 navigates to a different file in the browser
  //                 (file nav overwrites, which is by design).
  //
  // Reserved (LLM writes rejected with a helpful error):
  //   wd-browser, wd-log — dashboard re-renders these every frame
  //                        from its own buffers (file list, chat
  //                        transcript). Use layout_addWidget to
  //                        spawn a fresh widget the dashboard will
  //                        NOT touch.
  const buildWorkspaceContext = (): string => {
    try {
      const pluginLayout = pluginHost.activeLayout();
      let layoutForCtx: Layout;
      if (pluginLayout) {
        layoutForCtx = pluginLayout;
      } else {
        const { cols, rows: tr } = termSize();
        const promptFrame = getLayoutPromptFrame(tr);
        const topHeight = computePromptFrameGridHeight(tr, promptFrame);
        layoutForCtx = workingDirLayoutForView(cols - 1, topHeight);
      }
      const visibleWidgets: Array<{ id: string; type: string; title?: string }> = [];
      for (const row of layoutForCtx.rows) {
        for (const cell of row.cells) {
          if (!cell.widgetInstanceId) continue;
          const inst = widgetHost.get(cell.widgetInstanceId);
          if (!inst) continue;
          visibleWidgets.push({
            id: inst.id,
            type: inst.type,
            title: inst.character || undefined,
          });
        }
      }
      if (visibleWidgets.length === 0) return '';
      const rows = visibleWidgets.map(w => {
        const tag =
            w.id === 'wd-scratch'  ? '  ← writable canvas; persistent'
          : w.id === 'wd-preview'  ? '  ← writable canvas; overwritten on file-nav'
          : w.id === 'wd-browser'  ? '  ← READ-ONLY (dashboard-managed file list)'
          : w.id === 'wd-log'      ? '  ← READ-ONLY (chat transcript)'
          : w.id.startsWith('wd-debug-') ? '  ← READ-ONLY (debug event surface; use debug_* tools)'
          :                          '  ← persistent (spawned by LLM)';
        const label = w.title ? ` "${w.title}"` : '';
        return `- ${w.id} (${w.type})${label}${tag}`;
      }).join('\n');
      return [
        '## Current dashboard workspace',
        '',
        'The following widgets are visible right now. You have three host-level tools to mutate the layout:',
        '- `layout_getState` — refresh view of the grid.',
        '- `layout_setWidgetState({id, patch})` — merge a patch into a widget\'s state. For markdown widgets patch `{text: "..."}`.',
        '- `layout_addWidget({type, row, col, character, config})` — spawn a new widget; dashboard will NOT re-render its state.',
        '',
        rows,
        '',
        'Writing rules:',
        '- To SHOW the user multi-line output (notes, analyses, lists, reports), write to `wd-scratch` via `layout_setWidgetState({id:"wd-scratch", patch:{text:"<content>"}})`. The dashboard auto-reopens that pane if the user had it closed.',
        '- For a secondary canvas (e.g. side-by-side comparison), write to `wd-preview` the same way.',
        '- DO NOT write to `wd-browser` or `wd-log` — the dashboard rejects those patches with an error.',
        '- DO NOT write to `wd-debug-*`; use `debug_getState`, `debug_getCallStack`, `debug_setLevel`, `debug_openView`, and `debug_selectEvent`.',
        '- For your own persistent widget (won\'t be overwritten by anything), spawn with `layout_addWidget` and pick your own id.',
        '',
        describeDashboardViewsForPrompt(viewRegistry),
        '',
        describePaneStateForPrompt(),
      ].join('\n');
    } catch {
      // Workspace snapshot is best-effort — a failure here must not
      // break the chat turn. Return empty so the user message flows
      // through unchanged.
      return '';
    }
  };

  // ── LLM layout tools (W5) ──
  // Host-level tools that let the chat LLM reshape the dashboard.
  // When a plugin is active the tools edit its layout directly; when
  // idle they return a fresh working-dir view snapshot so `get_layout`
  // still answers. `setCurrentLayout` without an active plugin is a
  // no-op — the working-dir layout is rebuilt per draw.
  const layoutTools = createLayoutTools({
    getCurrentLayout: () => {
      const plugin = pluginHost.activeLayout();
      if (plugin) return plugin;
      const { cols, rows: tr } = termSize();
      // Grid covers everything above the fixed bottom zone and the hud.
      // When logEmbedded, log is rendered inside the grid so we give
      // grid the full (termRows - hud - bottomFixed) height; otherwise
      // just paneH. Note: getCurrentLayout is called by tool handlers
      // (not inside draw), so we approximate rather than query the
      // composer — close enough for layout-tool callers.
      const promptFrame = getLayoutPromptFrame(tr);
      const topHeight = computePromptFrameGridHeight(tr, promptFrame);
      return workingDirLayoutForView(cols - 1, topHeight);
    },
    setCurrentLayout: (next) => {
      const active = pluginHost.active();
      if (active) active.layout = next;
    },
    widgetHost,
    notify: (msg) => { chatLines.push(C.muted(msg)); chatScrollOffset = -1; },
    // Sync scratchLines when the LLM patches wd-scratch.state.text —
    // otherwise the next draw() overwrites the patch from scratchLines
    // (the dashboard's own source of truth for the scratchpad). The
    // grok-4.20 log/debug-20260415155043.log showed this silently
    // losing a multi-line text write ("조선 왕조 왕 리스트 ...") that
    // tool_result reported as successfully "patched".
    onWidgetStatePatched: (id, patch) => {
      // Mirror LLM writes into the dashboard buffer that draw() will
      // re-sync from on the next frame. Without this, a successful
      // layout_setWidgetState call gets clobbered 1 frame later. We
      // mirror two surfaces:
      //   wd-scratch  — primary writable canvas (notes, reports).
      //                 Persists until the user clears / switches mode.
      //   wd-preview  — secondary writable canvas. Persists until the
      //                 user navigates to a different file in the
      //                 browser (file nav overwrites, by design).
      const text = typeof (patch as any).text === 'string' ? String((patch as any).text) : null;
      if (text === null) return;
      if (id === 'wd-scratch') {
        scratchLines.length = 0;
        scratchLines.push(...text.split('\n'));
        scratchOffset = 0;
        scratchMode = 'preview';
        scratchClosed = false;
        userClosedPanes.delete('scratch');
        dashboardDisplay.publish({
          type: 'setScratch',
          source: 'tool:layout',
          mode: 'preview',
          title: scratchTitle || 'Scratch',
          lines: scratchLines,
        });
      } else if (id === 'wd-preview') {
        dockedPreview.previewLines = text.split('\n');
        dockedPreview.previewOffset = 0;
      }
    },
    // Widgets the dashboard re-renders from its OWN internal buffers
    // every frame AND that don't have a mirror hook above — LLM writes
    // there would silently disappear. Reject with a helpful error
    // redirecting to wd-scratch / wd-preview / layout_addWidget.
    // wd-scratch and wd-preview are INTENTIONALLY absent from this
    // set: their mirrors in onWidgetStatePatched let LLM writes
    // survive the next draw.
    reservedWidgetIds: new Set(['wd-browser', 'wd-log', 'wd-debug-log', 'wd-debug-events', 'wd-debug-detail', 'wd-debug-stack', 'wd-debug-prompts']),
  });
  for (const tool of layoutTools) pluginHost.registerHostTool(tool);
  pluginHost.registerHostTool(buildAstGrepHostTool());
  // ★ L2 코어 앱 도구(P3 · 2026-07-13) — 텔레그램/데몬챗/CLI 가 무조건 싣는 core-tools
  //   (ops_status·autopilot_missions·self_recall·memory_recall·session_manage·schedule_manage·
  //   fact_check)를 TUI 채팅에도 host tool 로 상속. 노출 게이트는 session-runtime 의 'self-ops'
  //   family(전 surface 기본) — 이로써 TUI 에서도 "P2 왜 실패?" 를 엘라누스가 툴로 상황판단한다.
  //   fail-soft: 코어 도구 로드 실패가 대시보드 부팅을 막지 않는다.
  try {
    const coreMod = require('../domains/core-tools.js') as typeof import('../domains/core-tools.js');
    const core = coreMod.buildCoreTools();
    for (const spec of core.specs) {
      pluginHost.registerHostTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        handler: async (args) => core.dispatch(spec.name, args as Record<string, unknown>),
      });
    }
  } catch { /* fail-soft */ }
  // LSP (Phase L3 of 내부 문서 `ROADMAP-lsp-integration`) — structural /
  // symbol-level source queries via typescript-language-server. Pool
  // kept alive per cwd; reaped on 10-min idle. See
  // 내부 문서 `CAPABILITIES-lsp` for the op surface.
  pluginHost.registerHostTool(buildLspHostTool());
  pluginHost.registerHostTool({
    name: 'view_getConfig',
    description: 'Return dashboard view configuration: native and custom views, order, enabled state, shortcuts, baseView, pane rows, ratios, primary pane, and active view.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => ({
      activeId: activeViewId,
      views: serializeDashboardViewsConfig(viewRegistry),
      promptSummary: describeDashboardViewsForPrompt(viewRegistry),
    }),
  });
  pluginHost.registerHostTool({
    name: 'view_setActive',
    description: 'Switch the active dashboard view by id, label, or shortcut. Use view_getConfig first when unsure.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'View id, label, or shortcut' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const def = findDashboardView(viewRegistry, id);
      if (!def) throw new Error(`view "${id}" not found or disabled`);
      setActiveDashboardView(def);
      return { activeId: def.id, label: def.label, baseView: def.baseView };
    },
  });
  pluginHost.registerHostTool({
    name: 'view_applyRuntimeConfig',
    description: 'Apply a dashboard.views JSON object at runtime. Shape: {order?: string[], views: [{id,label,enabled,shortcut,baseView,primary,omitOrder,rows:[{ratio,panes:[{pane,ratio}]}]}]}. This does not write config.json; ask the user before persisting.',
    parameters: {
      type: 'object',
      properties: {
        views: { type: 'object', description: 'dashboard.views JSON object' },
      },
      required: ['views'],
    },
    handler: async (args) => {
      if (!args.views || typeof args.views !== 'object') throw new Error('views must be a dashboard.views object');
      applyDashboardViewsRuntime(args.views as any);
      return { activeId: activeViewId, views: serializeDashboardViewsConfig(viewRegistry) };
    },
  });
  pluginHost.registerHostTool({
    name: 'view_saveConfig',
    description: 'Persist dashboard view configuration to ~/.config/elanous/config.json. If views is omitted, saves the current runtime registry. If views is provided, applies and saves it.',
    parameters: {
      type: 'object',
      properties: {
        views: { type: 'object', description: 'Optional dashboard.views JSON object to apply and persist' },
      },
      required: [],
    },
    handler: async (args) => {
      const raw = args.views && typeof args.views === 'object'
        ? args.views as RawDashboardViewsConfig
        : serializeDashboardViewsConfig(viewRegistry);
      saveDashboardViewsConfig(raw);
      return { saved: true, activeId: activeViewId, views: serializeDashboardViewsConfig(viewRegistry) };
    },
  });
  pluginHost.registerHostTool({
    name: 'view_resetConfig',
    description: 'Reset dashboard views to built-in defaults and remove dashboard.views from config.json.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      resetDashboardViewsConfig();
      return { reset: true, activeId: activeViewId, views: serializeDashboardViewsConfig(viewRegistry) };
    },
  });
  registerDashboardPaneHostTools(pluginHost, {
    state: () => paneStateSnapshot(),
    activePaneIds: () => panesForDashboardView(activeViewDef()),
    close: (pane) => closeDashboardPane(pane as PaneFocus),
    open: (pane) => openDashboardPane(pane as PaneFocus),
    openModal: (pane) => openDashboardPaneModal(pane as PaneFocus),
    modals: () => dashboardModals,
    setOmitOrder: (panes) => setDashboardPaneOmitOrder(panes),
  });
  pluginHost.registerHostTool({
    name: 'prompt_search',
    description: 'Search Prompt Bank fragments by text, tags, scope, owner, kind, targetSlot, and enabled state.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string' },
        owner: { type: 'string' },
        kind: { type: 'string' },
        targetSlot: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        enabled: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: [],
    },
    handler: async (args) => getPromptBankStore().search({
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      ...(typeof args.scope === 'string' ? { scope: args.scope as any } : {}),
      ...(typeof args.owner === 'string' ? { owner: args.owner } : {}),
      ...(typeof args.kind === 'string' ? { kind: args.kind as any } : {}),
      ...(typeof args.targetSlot === 'string' ? { targetSlot: args.targetSlot as any } : {}),
      ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
      ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
      limit: Math.max(1, Math.min(100, Number.parseInt(String(args.limit ?? '50'), 10) || 50)),
    }),
  });
  pluginHost.registerHostTool({
    name: 'prompt_get',
    description: 'Return one Prompt Bank fragment by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const fragment = getPromptBankStore().get(id);
      if (!fragment) throw new Error(`prompt fragment "${id}" not found`);
      return fragment;
    },
  });
  pluginHost.registerHostTool({
    name: 'prompt_create',
    description: 'Create a Prompt Bank fragment. LLM-created fragments default to session scope and disabled until explicitly enabled.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        scope: { type: 'string' },
        owner: { type: 'string' },
        kind: { type: 'string' },
        targetSlot: { type: 'string' },
        content: { type: 'string' },
        priority: { type: 'number' },
        enabled: { type: 'boolean' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        triggers: { type: 'object' },
        constraints: { type: 'object' },
        metadata: { type: 'object' },
      },
      required: ['name', 'content'],
    },
    handler: async (args) => {
      if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('name is required');
      if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('content is required');
      return getPromptBankStore().create({
        ...(typeof args.id === 'string' ? { id: args.id } : {}),
        name: args.name,
        scope: (typeof args.scope === 'string' ? args.scope : 'session') as any,
        owner: typeof args.owner === 'string' ? args.owner : 'llm',
        kind: (typeof args.kind === 'string' ? args.kind : 'instruction') as any,
        targetSlot: (typeof args.targetSlot === 'string' ? args.targetSlot : 'context') as any,
        content: args.content,
        ...(typeof args.priority === 'number' ? { priority: args.priority } : {}),
        enabled: typeof args.enabled === 'boolean' ? args.enabled : false,
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
        ...(args.triggers && typeof args.triggers === 'object' && !Array.isArray(args.triggers) ? { triggers: args.triggers as Record<string, unknown> } : {}),
        ...(args.constraints && typeof args.constraints === 'object' && !Array.isArray(args.constraints) ? { constraints: args.constraints as Record<string, unknown> } : {}),
        ...(args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata) ? { metadata: args.metadata as Record<string, unknown> } : {}),
      });
    },
  });
  pluginHost.registerHostTool({
    name: 'prompt_update',
    description: 'Patch an existing Prompt Bank fragment by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object' },
      },
      required: ['id', 'patch'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const patch = args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch as any : null;
      if (!patch) throw new Error('patch object is required');
      return getPromptBankStore().update(id, patch);
    },
  });
  pluginHost.registerHostTool({
    name: 'prompt_enable',
    description: 'Enable or disable a Prompt Bank fragment.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
    },
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      if (typeof args.enabled !== 'boolean') throw new Error('enabled boolean is required');
      return getPromptBankStore().setEnabled(id, args.enabled);
    },
  });
  pluginHost.registerHostTool({
    name: 'prompt_getRuntimeConfig',
    description: 'Return Prompt Bank live injection runtime config for dashboard turns and skill runs.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => getUserConfig().dashboard.promptBank,
  });
  pluginHost.registerHostTool({
    name: 'prompt_setRuntimeConfig',
    description: 'Patch Prompt Bank live injection runtime config. Use this to enable/disable dashboard turn injection, skill-run injection, recording, token budget, or fragment limit.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        dashboardTurns: { type: 'boolean' },
        skillRuns: { type: 'boolean' },
        record: { type: 'boolean' },
        budgetTokens: { type: 'number' },
        limit: { type: 'number' },
      },
      required: [],
    },
    handler: async (args) => setPromptBankRuntimeConfig(args),
  });
  pluginHost.registerHostTool({
    name: 'prompt_selectForState',
    description: 'Dry-run Prompt Bank selection for the current dashboard state plus optional intents/state overrides.',
    parameters: {
      type: 'object',
      properties: {
        intents: { type: 'array', items: { type: 'string' } },
        state: { type: 'object' },
        budgetTokens: { type: 'number' },
        limit: { type: 'number' },
      },
      required: [],
    },
    handler: async (args) => {
      const intents = Array.isArray(args.intents) ? args.intents.map(String) : [];
      const stateOverride = args.state && typeof args.state === 'object' && !Array.isArray(args.state) ? args.state as Record<string, unknown> : {};
      const injection = buildPromptInjection({
        store: getPromptBankStore(),
        state: { ...promptRuntimeState(intents), ...stateOverride },
        options: {
          budgetTokens: typeof args.budgetTokens === 'number' ? args.budgetTokens : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          record: false,
        },
      });
      return {
        selected: injection.selection.selected,
        rejected: injection.selection.rejected,
        tokenEstimate: injection.tokenEstimate,
        slots: Object.fromEntries(Object.entries(injection.slots).map(([slot, text]) => [slot, { tokens: Math.ceil(String(text).length / 4), chars: String(text).length }])),
      };
    },
  });
  pluginHost.registerHostTool({
    name: 'prompt_injectOnce',
    description: 'Build and record a Prompt Bank injection for the current state. Returns composed slot text for the caller to include in its next prompt.',
    parameters: {
      type: 'object',
      properties: {
        intents: { type: 'array', items: { type: 'string' } },
        budgetTokens: { type: 'number' },
        limit: { type: 'number' },
        includeHeaders: { type: 'boolean' },
        sessionId: { type: 'string' },
        turnId: { type: 'string' },
      },
      required: [],
    },
    handler: async (args) => {
      const provider = inspectActiveProvider();
      return buildPromptInjection({
        store: getPromptBankStore(),
        state: promptRuntimeState(Array.isArray(args.intents) ? args.intents.map(String) : []),
        options: {
          model: provider.model,
          activePlugin: pluginHost.active()?.name,
          budgetTokens: typeof args.budgetTokens === 'number' ? args.budgetTokens : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          includeHeaders: typeof args.includeHeaders === 'boolean' ? args.includeHeaders : true,
          sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
          turnId: typeof args.turnId === 'string' ? args.turnId : undefined,
        },
      });
    },
  });
  pluginHost.registerHostTool({
    name: 'prompt_explainInjection',
    description: 'Return a prompt injection audit log by id, or the latest log when id is omitted.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: [],
    },
    handler: async (args) => {
      const store = getPromptBankStore();
      if (typeof args.id === 'string' && args.id.trim()) {
        const log = store.getInjectionLog(args.id);
        if (!log) throw new Error(`prompt injection log "${args.id}" not found`);
        return log;
      }
      return store.listInjectionLogs(1)[0] ?? null;
    },
  });
  pluginHost.registerHostTool({
    name: 'debug_getState',
    description: 'Return runtime debug state plus recent structured events. Use this before inspecting agent, LLM, skill, plugin, tool, or execution activity.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Recent event count, default 50, max 200' },
      },
      required: [],
    },
    handler: async (args) => {
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(args.limit ?? '50'), 10) || 50));
      return {
        status: debug.status(),
        events: debug.events(limit),
        agents: debugAgentSnapshot(),
        callStack: debugCallStackSnapshot(Math.min(40, limit)),
        lastLlm: debugLastLlmSignals(),
        panes: paneStateSnapshot(),
      };
    },
  });
  pluginHost.registerHostTool({
    name: 'debug_getCallStack',
    description: 'Return the structured agent activity and runtime call stack. This is the preferred API for inspecting active Agent, LLM, tool, plugin, skill, prompt, and execution flow.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Frame count, default 24, max 80' },
      },
      required: [],
    },
    handler: async (args) => {
      const limit = Math.max(1, Math.min(80, Number.parseInt(String(args.limit ?? '24'), 10) || 24));
      return debugCallStackSnapshot(limit);
    },
  });
  pluginHost.registerHostTool({
    name: 'debug_getAgentState',
    description: 'Return native agent debug surface state: roster, selected agent, counts, tool trail, prompt/result/error summaries.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => debugAgentSnapshot(),
  });
  pluginHost.registerHostTool({
    name: 'debug_getLastLlm',
    description: 'Return the latest LLM request/response/tool-loop debug events captured by the runtime tracer.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => debugLastLlmSignals(),
  });
  pluginHost.registerHostTool({
    name: 'input_history_search',
    description: 'Search the user input history captured from the TUI prompt. Use this to recover prior slash commands, chat prompts, and recurring intent patterns.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['slash', 'chat'] },
        limit: { type: 'number' },
      },
      required: [],
    },
    handler: async (args) => inputHistoryStore.search({
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      ...(args.kind === 'slash' || args.kind === 'chat' ? { kind: args.kind } : {}),
      limit: Math.max(1, Math.min(100, Number.parseInt(String(args.limit ?? '30'), 10) || 30)),
    }),
  });
  pluginHost.registerHostTool({
    name: 'input_history_list',
    description: 'List recent user input history entries, newest first.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
      required: [],
    },
    handler: async (args) => inputHistoryStore.list(
      Math.max(1, Math.min(100, Number.parseInt(String(args.limit ?? '30'), 10) || 30)),
    ),
  });
  pluginHost.registerHostTool({
    name: 'debug_setLevel',
    description: 'Set debug capture level. off = all sinks closed. trail = file ON + compact. normal = file + mirror. detail (legacy: verbose) = file + mirror + full raw payloads.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['off', 'trail', 'normal', 'detail', 'verbose'] },
      },
      required: ['level'],
    },
    handler: async (args) => {
      const level = args.level;
      if (level !== 'off' && level !== 'trail' && level !== 'normal' && level !== 'detail' && level !== 'verbose') {
        throw new Error('level must be off, trail, normal, detail, or verbose');
      }
      debug.setLevel(level);
      return debug.status();
    },
  });
  pluginHost.registerHostTool({
    name: 'debug_openView',
    description: 'Open the native Debug dashboard view. It renders debug events, event detail, call/activity stack, preview, and log panes.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const def = findDashboardView(viewRegistry, 'debug');
      if (!def) throw new Error('debug view is disabled');
      setActiveDashboardView(def);
      setWorkingFocus('debug-events', 'tool-debug-openView');
      return paneStateSnapshot();
    },
  });
  pluginHost.registerHostTool({
    name: 'debug_selectEvent',
    description: 'Select an event index in the Debug Events pane. Index 0 is the newest event.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Newest-first event index' },
      },
      required: ['index'],
    },
    handler: async (args) => {
      const events = debug.events(200);
      const max = Math.max(0, events.length - 1);
      const index = Math.max(0, Math.min(max, Number.parseInt(String(args.index ?? '0'), 10) || 0));
      debugEventCursor = index;
      debugEventManual = true;
      return {
        selected: index,
        event: [...events].reverse()[index] ?? null,
      };
    },
  });

  let lastModalKey = '';

  // MX9b — pane-nav row state. Populated each frame by the pane-nav
  // zone's render; consumed by the mouse chokepoint for click-to-focus.
  let paneNavHitAreas: PaneNavHitArea[] = [];
  let paneNavRow: number | null = null;
  // Grid zone bounds — used by the widget-content mouse dispatcher
  // (click on a file row inside Browser → widget.onMouse).
  let gridZoneStart: number | null = null;
  let gridZoneHeight: number | null = null;
  // U-4.3 · log-zone bounds (absolute terminal rows) for the chat-only
  // and plugin-default branches where the log lives in its own zone
  // below the grid. Used by `dispatchLogZoneClick` to route clicks to
  // `wd-log.onMouse` even though dispatchPaneClick (grid-only) misses
  // them. `null` when the current layout has the log inside the grid
  // (logEmbedded branch) — that case is served by dispatchPaneClick.
  let logZoneStart: number | null = null;
  let logZoneHeight: number | null = null;
  // Last computed effectiveLayout — published at end of draw() so the
  // mouse handler can hit-test it without rerunning layout solving.
  let lastEffectiveLayout: import('../layout/types.js').Layout | null = null;
  // Intentional log — paneNavLabel gets re-exported below; keep a
  // reference so future call-sites that want to override labels can
  // see one spot.
  void paneNavLabel;

  // MX11b — mouse-driven status-bar pill popups + ToastStack.
  // `wdHistory` is a session-local LRU of cwds the user has visited;
  // seeded with the current session cwd and $HOME. The wd-pill popup
  // reads it; setSessionCwd (inside the popup's onSwitch) also pushes
  // the new path on top.
  const wdHistory: string[] = [];
  const rememberWd = (p: string): void => {
    const idx = wdHistory.indexOf(p);
    if (idx >= 0) wdHistory.splice(idx, 1);
    wdHistory.unshift(p);
    if (wdHistory.length > 20) wdHistory.length = 20;
  };
  try {
    rememberWd(getSessionCwd());
    const home = process.env.HOME;
    if (home && !wdHistory.includes(home)) rememberWd(home);
  } catch { /* ignore */ }

  // DS-3a (2026-04-21) — drag-session dashboard wire. Composes
  // working-dir drag source + chat-input DropTarget + drop-zone
  // popover observer into one object. Dashboard touches are limited
  // to this init + 3 mouse route `onMouse` calls + mouseWiring dep
  // `getInputHitTarget`. See src/drag-session-dashboard-wire.ts.
  const dragWire = wireDragSessionToDashboard({
    manager: display.dragManagerAPI(),
    workingDirState: workingDir,
    // 2026-04-22b · drop-zone overlay sprites register with the
    // LayerTree / RenderCoordinator so self-erase + future W4
    // DamageRegion bridge wire automatically.
    tree: display.layerTreeAPI(),
    rc: display.renderCoordinatorAPI(),
    overlayHost: transientOverlayHost,
    requestDraw: () => draw(),
    attachFilePath: attachFilePathToken,
    getInputPromptRow: () => currentPromptFrame(termSize().rows).promptBottomRow,
    getTermSize: () => termSize(),
    // DS-4a (2026-04-21) — scratch pane append handler. Drop on the
    // scratch pane appends `→ <absPath>` lines. No bounds getter yet
    // (wire falls back to 1×1 rect for popover highlight); DropTarget
    // match still works via paneId. Future refinement can supply
    // live scratch rect from lastEffectiveLayout.
    appendToScratch: (paths) => {
      for (const p of paths) {
        scratchLines.push(`→ ${p}`);
      }
      draw();
    },
    // DS-4c (2026-04-21) — drag-reactive LLM context banner. Appears
    // above the composer during every drag, disappears on release.
    // MVP ingest reuses `attachFilePathToken` (same path as DS-3a
    // chat-input drop); UX differentiator is the banner's drag-gated
    // visibility, not a separate ingest pipeline. Future phase may
    // split into a dedicated context-block queue with header prefix.
    getLlmContextBannerRow: () => {
      const promptFrame = currentPromptFrame(termSize().rows);
      return promptFrame.topDividerRow > 0 ? promptFrame.topDividerRow : 0;
    },
    onIngestLlmContext: async (paths) => {
      for (const p of paths) {
        try { await attachFilePathToken(p); }
        catch { /* attachFilePathToken surfaces its own errors via chat log */ }
      }
    },
  });

  // CMX-2 (2026-04-22) — context-menu primitive wiring. Pill right-
  // click keeps its legacy direct path (dashboard-context-menu-registry
  // singleton); this wire serves non-pill hits (pane-body / pane-title
  // / input / VW) via MenuProviderRegistry. Browser pane is the first
  // production consumer — registers pane-body:browser (Attach / Copy
  // path / Open / Reveal) and pane-title:browser (Split — conservative
  // conservative, primary pane so Close/Rename/Detach off).
  const ctxMenuProviders = bootDashboardContextMenuProviders({
    workingDirState: workingDir,
    resolveBrowserStateCursor: (browserId) => (
      resolveBrowserStateById(browserId ?? 'wd-browser')?.cursor
      ?? browserContextMenuCursorResolver?.()
      ?? workingDir.cursor
    ),
    resolveBrowserActionContext: (hit) => resolveBrowserActionContextFromHit({
      registry: browserPaneRegistry,
      hit,
      fallbackBrowserId: ('paneId' in hit && hit.paneId === 'wd-working-browser') ? 'wd-working-browser' : 'wd-browser',
    }),
    getScratchLineCount: () => scratchLines.length,
    getScratchTotalBytes: () => scratchLines.reduce((n, l) => n + l.length, 0),
    isCompanionOpen: (key) => companionPopupHost.isActive(key as CompanionPopupKey),
    hasClosedPanes: () => paneStateSnapshot().panes.some((pane) => pane.closed),
    getDebugPath: () => debug.path(),
    getDebugLevel: () => debug.level(),
  });
  const ctxMenuWire = wireContextMenuToDashboard({
    registry: getDashboardContextMenuRegistry(),
    providers: ctxMenuProviders,
    // CMX-3 · live eval context. Dashboard recomputes on every
    // right-click so predicate-based `disabled` fields see the
    // latest app state. Consumers (scratch, future chat-input)
    // add keys here as needed.
    buildContext: () => ({
      scratchLineCount: scratchLines.length,
    }),
    ownerWorkspaceIdForEvent: () => (
      topWorkspaceSurface({
        focusStack: display.modalStack(),
        surfaceAt: (id) => display.surface(id),
      })?.id ?? 'dashboard-main'
    ),
    onPick: async (_ev, result) => {
      if (result.reason !== 'selected') return;
      const fromBrowserPreviewModal =
        _ev.hitTarget?.kind === 'pane-body'
        && typeof _ev.hitTarget.widgetInstanceId === 'string'
        && _ev.hitTarget.widgetInstanceId.endsWith('::pane-multi-modal');
      switch (result.value) {
        case 'debug.copy-path': {
          const payload = result.payload as { path?: unknown } | undefined;
          const rawPath = typeof payload?.path === 'string' ? payload.path : debug.path();
          try {
            const copied = await writeClipboardDetailed(rawPath);
            pushDebugLine(
              copied.ok
                ? C.info(`  copied debug path${copied.via === 'osc52' ? ' via OSC 52' : ''}: ${rawPath}`)
                : C.warning('  clipboard write failed (no compatible backend)'),
            );
            chatScrollOffset = -1;
            draw();
          } catch { /* silent */ }
          return;
        }
        case 'debug.mode.on':
        case 'debug.mode.diag':
        case 'debug.mode.file': {
          const nextLevel =
            result.value === 'debug.mode.on' ? 'normal'
            : result.value === 'debug.mode.diag' ? 'diag'
            : 'trail';
          debug.setLevel(nextLevel);
          ensureToolCallSubscription();
          pushDebugLine(
            result.value === 'debug.mode.on'
              ? C.success(`  debug mode: ON — mirror + file (${debug.level()})`)
              : result.value === 'debug.mode.diag'
                ? C.warning(`  debug mode: DIAG — mirror OFF, file ON, diag ON`)
                : C.muted(`  debug mode: FILE — mirror OFF, file ON, diag OFF`),
          );
          pushDebugLine(C.muted(`  file: ${debug.path()}`));
          chatScrollOffset = -1;
          draw();
          return;
        }
        case 'browser.attach': {
          const payload = result.payload as BrowserBodyMenuPayload | undefined;
          if (!payload) return;
          if (payload.isDir) {
            dispatchSidebarSubmit(
              encodeBrowserScopedSubmitText('folder-attach', payload.browserId, payload.absPath),
            );
          } else {
            dispatchSidebarSubmit(
              encodeBrowserScopedSubmitText('file-attach', payload.browserId, payload.absPath),
            );
          }
          if (fromBrowserPreviewModal) {
            try { browserPreviewModalCloseRequest?.(); } catch { /* ignore */ }
          }
          return;
        }
        case 'browser.copy-path': {
          const payload = result.payload as BrowserBodyMenuPayload | undefined;
          if (!payload) return;
          try {
            const ok = await writeClipboard(payload.absPath);
            chatLines.push(
              ok
                ? C.info(`  copied: ${payload.absPath}`)
                : C.warning(`  clipboard write failed (no compatible backend)`),
            );
            chatScrollOffset = -1;
            draw();
          } catch { /* silent */ }
          return;
        }
        case 'browser.open': {
          // MVP stub — logs intent. Real navigation (enter dir) + file
          // preview wiring is CMX-2 polish / CMX-5 follow-up. Kept here
          // so the action surfaces in the menu today and handler exists.
          const payload = result.payload as BrowserBodyMenuPayload | undefined;
          if (!payload) return;
          reportDashboardBrowserOpenAction({
            info: C.info,
            warning: C.warning,
            pushChatLine: (line) => { chatLines.push(line); },
            setChatScrollBottom: () => { chatScrollOffset = -1; },
            draw,
          }, payload);
          return;
        }
        case 'browser.reveal': {
          const payload = result.payload as BrowserBodyMenuPayload | undefined;
          if (!payload) return;
          try {
            const { spawn } = await import('node:child_process');
            spawn('open', ['-R', payload.absPath], {
              detached: true,
              stdio: 'ignore',
            }).unref();
            reportDashboardBrowserRevealResult({
              info: C.info,
              warning: C.warning,
              pushChatLine: (line) => { chatLines.push(line); },
              setChatScrollBottom: () => { chatScrollOffset = -1; },
              draw,
            }, payload, true);
          } catch {
            reportDashboardBrowserRevealResult({
              info: C.info,
              warning: C.warning,
              pushChatLine: (line) => { chatLines.push(line); },
              setChatScrollBottom: () => { chatScrollOffset = -1; },
              draw,
            }, payload, false);
          }
          return;
        }
        // ── CMX-5.1 · scratch actions ─────────────────────────────
        case 'scratch.clear': {
          const p = result.payload as ScratchMenuPayload | undefined;
          scratchLines = runDashboardScratchClearAction({
            info: C.info,
            warning: C.warning,
            pushChatLine: (line) => { chatLines.push(line); },
            setChatScrollBottom: () => { chatScrollOffset = -1; },
            draw,
          }, p, scratchLines.length);
          return;
        }
        case 'scratch.copy-all': {
          const p = result.payload as ScratchMenuPayload | undefined;
          await runDashboardScratchCopyAllAction({
            info: C.info,
            warning: C.warning,
            pushChatLine: (line) => { chatLines.push(line); },
            setChatScrollBottom: () => { chatScrollOffset = -1; },
            draw,
          }, p, scratchLines, writeClipboard);
          return;
        }
        case 'scratch.export': {
          await runDashboardScratchExportAction({
            info: C.info,
            warning: C.warning,
            pushChatLine: (line) => { chatLines.push(line); },
            setChatScrollBottom: () => { chatScrollOffset = -1; },
            draw,
          }, scratchLines, async (text) => {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const os = await import('node:os');
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const dest = path.join(os.tmpdir(), `elanous-scratch-${ts}.txt`);
            await fs.writeFile(dest, text, 'utf8');
            return dest;
          });
          return;
        }
        case 'dashboard-pane.open-popup': {
          const payload = result.payload as DashboardPaneTitleMenuPayload | undefined;
          if (!payload) return;
          openDashboardPaneModal(payload.pane);
          return;
        }
        case 'dashboard-pane.clipboard-companion': {
          const opened = toggleCompanionPopup('clipboard');
          contextMenuFeedbackRuntime.onDashboardCompanionToggled('clipboard', opened);
          return;
        }
        case 'dashboard-pane.memo-companion': {
          const opened = toggleCompanionPopup('memo');
          contextMenuFeedbackRuntime.onDashboardCompanionToggled('memo', opened);
          return;
        }
        case 'dashboard-pane.detail-companion': {
          const opened = toggleCompanionPopup('detail');
          contextMenuFeedbackRuntime.onDashboardCompanionToggled('detail', opened);
          return;
        }
        case 'dashboard-pane.restore-view-panes': {
          restoreAllClosedDashboardPanes();
          contextMenuFeedbackRuntime.onStarterPanesRestored();
          return;
        }
        default:
          return;
      }
    },
  });

  const {
    effects: compactSurfaceEffects,
    runtime: compactSurfaceRuntime,
    host: compactSurfaceHost,
  } = createDashboardCompactSurfaceAssembly({
    setChatModeHud: (enabled) => {
      if (enabled) setSegment(hud, 'mode', C.info('mode: chat'), 10);
      else clearSegment(hud, 'mode');
    },
    pushDebugLine,
    resetChatScroll: () => { chatScrollOffset = -1; },
    restoreStarterPanes: () => {
      restoreAllClosedDashboardPanes();
    },
    resetDashboardViewsConfig: () => {
      resetDashboardViewsConfig();
    },
    muted: C.muted,
    success: C.success,
    getClosedPanes: () =>
      paneStateSnapshot().panes
        .filter((pane) => pane.closed)
        .map((pane) => ({
          pane: pane.pane,
          label: paneLabel(pane.pane),
        })),
    getActiveViewLabel: () => activeViewDef().label,
    getCompactMode: () => productCompactModeForViewport(paneViewport()),
    openDashboardPane: (pane) => openDashboardPane(pane),
    focusPane: (pane) => setWorkingFocus(pane, 'surface-catalog-reopen-pane'),
    openBrowserPreviewModal: () => openBrowserPreviewModal(),
    openDashboardPaneModal: (pane) => openDashboardPaneModal(pane),
    openCompanionPopup: (key) => setCompanionPopupOpen(key as DashboardCompanionSurfaceKey, true),
    onWarning: (message) => {
      pushDebugLine(C.warning(`  ${message}`));
      chatScrollOffset = -1;
    },
    setChatOnlyMode: (next) => { chatOnlyMode = next; },
    getChatOnlyMode: () => chatOnlyMode,
    describeViewStarterPackage: (view) => describeViewStarterPackage(view),
    getViews: () => viewRegistry.views,
    getActiveViewId: () => activeViewId,
    getClosedStarterCount: () => closedStarterPanes().length,
    activateView: (view) => {
      setActiveDashboardView(view);
    },
  });
  const contextMenuFeedbackRuntime = createDashboardContextMenuFeedbackRuntime({
    pushMutedLine: (line) => { chatLines.push(C.muted(line)); },
    setChatScrollBottom: () => { chatScrollOffset = -1; },
    draw,
  });
  const statusFeedbackRuntime = createDashboardStatusFeedbackRuntime({
    muted: C.muted,
    success: C.success,
    error: C.error,
    pushChatLine: (line) => { chatLines.push(line); },
    setChatScrollBottom: () => { chatScrollOffset = -1; },
  });
  const transferFeedbackRuntime = createDashboardTransferFeedbackRuntime({
    muted: C.muted,
    warning: C.warning,
    success: C.success,
    error: C.error,
    pushChatLine: (line) => { chatLines.push(line); },
    setChatScrollBottom: () => { chatScrollOffset = -1; },
    draw,
    basename,
  });
  const finderFeedbackRuntime = createDashboardFinderFeedbackRuntime({
    muted: C.muted,
    success: C.success,
    error: C.error,
    warning: C.warning,
    // OBS-T311/T314 — this dep is named pushChatLine and every message it
    // carries is an answer to something the human just did ("no files found
    // in the current tree." · "finder failed: …" · "ssh <name> failed: …").
    // It used to route to pushDebugLine, which lands in `debugLines` — a
    // buffer the default (essential) layout never renders. Measured live
    // 2026-08-25: debugLines' two boot banners show 0 rows on screen while a
    // chatLines push shows 1, same frame. So the finder's failures were
    // invisible and read as "it hung". Route to the chat buffer, matching the
    // sibling runtime two blocks above.
    pushChatLine: (line) => { chatLines.push(line); },
    setChatScrollBottom: () => { chatScrollOffset = -1; },
  });
  const termSlashRuntime = createDashboardTermSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    warning: C.warning,
    error: C.error,
    text: C.text,
  });
  const shellSlashRuntime = createDashboardShellSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    bold: C.bold,
    warning: C.warning,
    error: C.error,
  });
  const runSkillSlashRuntime = createDashboardRunSkillSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    text: C.text,
    subtext: C.subtext,
  });
  const skillTriggersSlashRuntime = createDashboardSkillTriggersSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    error: C.error,
  });
  const providerSlashRuntime = createDashboardProviderSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    success: C.success,
    warning: C.warning,
    text: C.text,
    subtext: C.subtext,
  });
  const previewSlashRuntime = createDashboardPreviewSlashRuntime({
    muted: C.muted,
    warning: C.warning,
  });
  const companionSlashRuntime = createDashboardCompanionSlashRuntime({
    muted: C.muted,
    warning: C.warning,
  });
  const agentsSlashRuntime = createDashboardAgentsSlashRuntime({
    muted: C.muted,
    warning: C.warning,
  });
  const controlSignalSlashRuntime = createDashboardControlSignalSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    warning: C.warning,
    observer: defaultControlSignalObserver(),
    signalBus: dashboardControlSignals,
  });
  const browserCdpSlashRuntime = createDashboardBrowserCdpSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    warning: C.warning,
    signalBus: dashboardControlSignals,
  });
  const simSlashRuntime = createDashboardSimSlashRuntime({
    accent: C.accent,
    muted: C.muted,
    warning: C.warning,
  });
  let adRunSetupBindings: ReturnType<typeof createDashboardAdRunSetupBindings> | undefined;
  let adRunSetupError: string | undefined;
  try {
    adRunSetupBindings = createDashboardAdRunSetupBindings(createDashboardAdRunSetupFactory({
      home: getSessionCwd(),
      date: new Date().toISOString().slice(0, 10),
      contractsJson: readFileSync(new URL('../../docs/ad-presets/higgsfield-measured-contracts.json', import.meta.url), 'utf8'),
      runner: dashboardAdCommandRunner,
      assetPresetPath: dashboardAdAssetPresetPath(),
    }));
  } catch (error) {
    adRunSetupError = error instanceof Error ? error.message : String(error);
  }
  const adSlashRuntime = createDashboardAdSlashRuntime({
    adRunSetupBindings,
    adRunSetupError,
    collectGroundingFacts: collectGroundingFactsViaCdp,
    approve: (gate, plan, context) => openGenericApproval({
      title: 'Approve advertising gate?',
      prompt: gate,
      detail: [
        `input: ${plan.intake.kind}`,
        context?.candidateId ? `candidate: ${context.candidateId}` : '',
        context?.candidateLabel ? `label: ${context.candidateLabel}` : '',
        context?.candidateReason ? `reason: ${context.candidateReason}` : '',
      ].filter(Boolean).join('\n'),
    }),
    report: pushChatLine,
    muted: C.muted,
    warning: C.warning,
  });
  const companionFeedbackRuntime = createDashboardCompanionFeedbackRuntime({
    muted: C.muted,
    warning: C.warning,
  });
  const mousePickerRuntime = createMousePickerRuntime({
    getRotation: () => getUserConfig().llm.rotation ?? [],
    getCurrentModelEntry: () => {
      const llm = getUserConfig().llm;
      if (!llm.provider || llm.provider === 'auto') return null;
      return {
        provider: llm.provider,
        ...(llm.model !== undefined ? { model: llm.model } : {}),
      };
    },
    applyActiveModel: (entry) => {
      const nextCfg = applyRotationEntry(getUserConfig(), entry);
      saveUserConfig(nextCfg);
      reloadUserConfig();
    },
    getRecentWds: () => [...wdHistory],
    applySessionWd: (path) => {
      setSessionCwd(path, 'user');
      rememberWd(path);
    },
    reportModelSwitchError: (message) => {
      chatLines.push(C.error(`  model switch failed: ${message}`));
      chatScrollOffset = -1;
    },
    reportWdSwitchError: (message) => {
      chatLines.push(C.error(`  cwd switch failed: ${message}`));
      chatScrollOffset = -1;
    },
  });
  const mouseShellRollupRuntime = createMouseShellRollupRuntime({
    resolveVwIdByLabel: () => null,
    switchToVirtualWindow: () => { throw new Error('Virtual windows are unavailable in the essential dashboard'); },
    onWarning: (message) => {
      chatLines.push(C.warning(`  ${message}`));
      chatScrollOffset = -1;
    },
  });
  const mouseConversationPopupRuntime = createMouseConversationPopupRuntime({
    conversationPopupHost,
    ensureConversationWidgetMounted,
    syncConversationPopupModals,
    redraw: () => { draw(); },
  });
  const mouseModeSwitchRuntime = createMouseModeSwitchRuntime({
    getActiveMode: () => inputCoreActiveMode(),
    getModeAction: (actionId) => getInputCoreAction(actionId),
    setMode: (next) => inputCoreSetMode(next),
  });
  const mouseModalHitRuntime = createMouseModalHitRuntime({
    getTopSurface: () => {
      const stack = display.modalStack();
      const topId = stack[stack.length - 1];
      if (!topId) return null;
      return display.surface(topId) as import('../display/modal-stack.js').ModalSurface | null;
    },
  });
  const mouseModalSurfaceRuntime = createMouseModalSurfaceRuntime({
    getFocusStack: () => display.modalStack(),
    surfaceAt: (id) =>
      display.surface(id) as import('../display/modal-stack.js').ModalSurface | null | undefined,
    getTopBlockingModalSurface: topBlockingForegroundModal,
    routeModalMouse: (surface, ev) => display.routeMouseToSurface(surface, ev),
  });
  const mousePaneHitRuntime = createMousePaneHitRuntime({
    getPaneNavRow: () => paneNavRow,
    paneAtColumn: (col0) => {
      const target = paneAtColumn(paneNavHitAreas, col0);
      return target !== null ? String(target) : null;
    },
    getCurrentFocusPaneId: () => String(workingDir.focus),
    getGridMetrics: () => ({
      hasLayout: lastEffectiveLayout !== null,
      gridZoneStart,
      gridZoneHeight,
      termCols: termSize().cols,
    }),
    hitTestLayoutCell: (row, col) => {
      if (!lastEffectiveLayout || gridZoneHeight === null || gridZoneStart === null) return null;
      return hitTestLayoutCell(
        lastEffectiveLayout,
        { width: termSize().cols, height: gridZoneHeight, topRow: gridZoneStart },
        row,
        col,
      );
    },
    describeHitFor: (widgetInstanceId, localRow, localCol) =>
      widgetHost.describeHitFor(widgetInstanceId, localRow, localCol),
  });

  const mouseWiring = createDashboardMouseWiring({
    termSize: () => termSize(),
    hoverPopupsEnabled: () => false,
    getRotation: mousePickerRuntime.getRotation,
    getCurrentModelEntry: mousePickerRuntime.getCurrentModelEntry,
    setActiveModel: mousePickerRuntime.setActiveModel,
    getRecentWds: mousePickerRuntime.getRecentWds,
    setSessionWd: mousePickerRuntime.setSessionWd,
    onExitProgram: async () => {
      exitDashboardTui();
      setTimeout(() => process.exit(0), 0);
    },
    pushModalSurface: surface => display.pushModal(surface),
    // DS-2b (2026-04-21) — drag-session routing hook. Adapter lives
    // in src/display/drag-dispatch.ts (PR #319); this single line is
    // its only wiring in the dashboard. When no session is active,
    // the adapter returns false and mouse-wiring falls through to
    // the existing chain (0 overhead path). See PLAN-drag-session-
    // primitive.md §3.3 and PR #319 for the contract.
    dragDispatch: (ev) => dragDispatch(ev, display.dragManagerAPI()),
    // CMX-2 (2026-04-22) — non-pill right-click dispatch. This hook
    // serves pane-body / pane-title / input / VW right-clicks via
    // MenuProviderRegistry. Unconsumed
    // (no provider matches) falls through to modal forwarding.
    contextMenuDispatch: (ev) => ctxMenuWire.onMouse(ev),
    // DS-3a (2026-04-21) — chat input hit classifier. Routes clicks
    // on the inputPromptRow to the `{kind:'input', inputId}` branch
    // before pane classification so the chat composer becomes a
    // valid DropTarget. Strictly a row check — `col` ignored.
    getInputHitTarget: dragWire.getInputHitTarget,
    // CMX-3f (2026-04-22) — modal hit preflight. Classifies a cursor
    // inside the top modal surface's bounds as modal-body so
    // contextMenuDispatch (and any future consumer) sees the modal
    // HitTarget before the pane classifier shadows it with the
    // underlying pane. Fixes CMX-1 modal-body/modal-button providers
    // being unreachable in the dispatcher. Button-level refinement
    // (modal-button) stays in the modal-adapter's MX6 F5c path —
    // not duplicated here.
    getModalHitTarget: mouseModalHitRuntime.getModalHitTarget,
    updateModalBounds: (id, bounds) => display.updateModalBounds(id, bounds),
    redraw: () => { draw(); },
    requestRender: () => { requestDashboardRender(); },
    conversationPopupHost,
    onConversationPopupPick: mouseConversationPopupRuntime.onConversationPopupPick,
    // SRF-4 — shell rollup pill click → popup listing live handles.
    // Handles are fetched at click time so the popup always reflects
    // the current ShellRegistry state (not a frozen snapshot).
    getShellRollupEntries: mouseShellRollupRuntime.getShellRollupEntries,
    onShellRollupPick: mouseShellRollupRuntime.onShellRollupPick,
    // VW-U3 — expose the foreground modal so mouse clicks inside
    // its bounds dispatch through surface.onMouse (VW focus pane).
    getTopModalSurface: mouseModalSurfaceRuntime.getTopModalSurface,
    getTopBlockingModalSurface: mouseModalSurfaceRuntime.getTopBlockingModalSurface,
    routeModalMouse: mouseModalSurfaceRuntime.routeModalMouse,
    // Q6 mouse-wiring (Phase 4 · 2026-05-03) — left-click on a
    // backgrounded popup-tier modal raises it within tier + transfers
    // focus. coord owns the policy (paintStack walk · tier check ·
    // raiseInTier · setFocus). mouseWiring just calls this on click
    // events before its own dispatch logic.
    tryRaiseModalAtPoint: (row, col) => display.tryRaiseModalAtPoint(row, col),
    getActiveMode: mouseModeSwitchRuntime.getActiveMode,
    onModeSwitch: mouseModeSwitchRuntime.onModeSwitch,
    // IDX-5 Phase 1 — hover wiring. Pass the dashboard singleton so
    // hover-stable updates hoverTargetKind / hoverTooltip, enabling
    // when-clauses to gate on "is the pointer on a pill?" and the
    // Tooltip widget to auto-show over status-bar pills.
    ctx: getDashboardContextKeyService(),
    // IDX-6 round-2 — live theme for the auto-mounted Tooltip surface.
    getTheme: () => currentThemeTokens(),
    suppressHoverHints: true,
    workspaceHost: display.workspaceHostAPI(),
    // IDX-5 Phase 3 B-4 — classify clicks outside the status-bar pill
    // row into broader pane regions so lastClickHitKind can carry
    // 'pane-nav' / 'pane-title' / 'pane-body' values (previously only
    // 'status-bar-pill' | null). Uses the live layout + gridZone +
    // pane-nav row refs captured by closure. Returns null for clicks
    // in whitespace / divider / hud regions.
    getPaneRegionKind: mousePaneHitRuntime.getPaneRegionKind,
    // IDX-F5b — structured HitTarget variant of getPaneRegionKind.
    // Returns the full discriminated HitTarget (pane-nav-tab /
    // pane-title / pane-body with paneId + widgetInstanceId) so
    // `DisplayMouseEvent.hitTarget` carries enough detail for
    // `modal.onMouse` handlers + F6 SendMouseEvent. The legacy
    // getPaneRegionKind above stays for the string-typed
    // `lastClickHitKind` contract; both callbacks share the same
    // pane-nav row + grid hit-test paths.
    getPaneHitTarget: mousePaneHitRuntime.getPaneHitTarget,
  });

  // IDX-5 Phase 2 — wire the context-menu registry presenter. Must
  // happen AFTER mouseWiring is constructed because the presenter
  // uses display.pushModal (same as pill popups) and we want the
  // redraw fn to drive frames.
  bootDashboardContextMenuRegistry({
    termSize: () => termSize(),
    pushSurface: surface => display.pushModal(surface),
    redraw: () => { draw(); },
    // IDX-6 Phase 5 adoption — context menu gets a drop-shadow using
    // the live theme. Obeys ELANOUS_MODAL_SHADOW=off for users who
    // prefer the flatter look.
    getTheme: () => currentThemeTokens(),
  });

  // F6 / S1.D — display-control runtime registration needs late-boot mouse/context-menu state.
  try {
    registerDashboardLayoutDisplayRuntimes({
      coordinator: display,
      mouseDispatch: (ev) => mouseWiring.handleMouse(ev),
      menuProviderRegistry: ctxMenuProviders,
      contextMenuRegistry: getDashboardContextMenuRegistry(),
      tooltipResolver: (target) => mouseWiring.getTooltipFor(target),
    });
  } catch { /* never break boot */ }

  // A2 — now that mouseWiring is built, wire the mode-toast sink so
  // the earlier-registered mode.enter.* action handlers can surface
  // transition feedback via the ToastStack. Short 1.2s default matches
  // other transient confirmations.
  pushModeToast = (text, kind = 'success') => {
    try { mouseWiring.toasts().push({ text, kind, ttlMs: 1200 }); } catch { /* ignore */ }
  };

  drawNow = ({ force: forceFromCoordinator = false } = {}) => {
    const { rows: termRows, cols } = termSize();
    const totalW = cols - 1;

    // IDX-2c Phase 2 — publish focusMode + activePaneId context keys
    // from the current workingDir.focus + modal state. The underlying
    // ContextKeyService equality-gates, so repeat calls with unchanged
    // values are cheap no-ops (one field comparison per key).
    publishFocusContextKeysFromService(workingDir.focus);


    // T3-B1: agent-activity HUD segment. Pulsing glyph + running
    // count drives awareness that sub-agent work is in flight —
    // relevant because ESC aborts cascade to running agents
    // (T3-B2 gates that with a confirm). Segment hides when no
    // agents are active.
    {
      const running = globalAgentRegistry.list().filter(a => a.state === 'running').length;
      const seg = renderAgentActivitySegment(running);
      if (seg) setSegment(hud, AGENT_ACTIVITY_SEGMENT_KEY, seg, 3);
      else clearSegment(hud, AGENT_ACTIVITY_SEGMENT_KEY);
    }

    // T4-E3/E4: SSH remote-mode badge. When workingDir.remote is
    // set we paint "@host:/path" so the user sees at a glance that
    // the browser pane is looking at a remote file system.
    {
      const badge = remoteBadge(workingDir);
      if (badge) setSegment(hud, 'ssh-remote', C.info(badge), 2);
      else clearSegment(hud, 'ssh-remote');
    }

    if (effectiveChatOnlyMode()) setSegment(hud, 'mode', C.info('mode: chat'), 10);
    else clearSegment(hud, 'mode');

    // Primary provider/model/context metadata now lives in the bottom
    // status area. Keeping the old HUD token gauge + variant badge
    // created a duplicate row directly above the input, so dashboard
    // clears those segments and leaves HUD for mode/remote/transient
    // signals only.
    clearSegment(hud, 'chat-token-gauge');
    clearSegment(hud, 'chat-variant');

    // T6-K1: control-mode badge — distinct from the
    // layout 'mode: chat' badge so both can coexist. Red glyph
    // signals "every word is a command, not conversation".
    // 2026-07-24 — 종전엔 `resolveSessionSurfaceStatus()` 를 불렀는데, 그 안의
    // `resolveSessionTurnProfile` 이 `userText` 없이 서피스를 **매 프레임 재해석**했다.
    // 그래서 관측된 `llm.tool-exposure/surface.resolve` 34건이 전부
    // `userTextChars:0 · reason:"fallback-default"` — 정보를 하나도 생산하지 않으면서
    // 프레임마다 로그만 찍었다. 게다가 draw 가 쓰는 건 `.mode` 뿐이고 나머지
    // (currentSurfaceId 등)는 그대로 버려졌다. 서피스는 턴 경로가 결정한다
    // (session-runtime/index.ts:1530, 턴당 2회) — 렌더는 모드만 읽으면 된다.
    const modeSnapshot = resolveSessionModeSnapshot(chatModeState);
    if (modeSnapshot.isControlActive) {
      const suffix = modeSnapshot.hudLabel.replace(/^CONTROL/, '');
      setSegment(hud, 'chat-mode', C.error('● CONTROL') + C.muted(suffix), 1);
    } else if (modeSnapshot.surfaceSelectionMode === 'fixed') {
      const suffix = modeSnapshot.hudLabel.replace(/^GENERAL · /, '');
      setSegment(hud, 'chat-mode', C.info(`◌ ${suffix}`), 1);
    } else {
      clearSegment(hud, 'chat-mode');
    }

    // ── Mode flags ──
    const pluginLayout = pluginHost.activeLayout();

    // Current visible input line count, clamped to maxLines=8 so the
    // composer never reserves more than a sane window for multi-line.
    const promptFrame = getLayoutPromptFrame(termRows);

    // Pane height for the default (non-embedded, non-chat-only) case.
    // logHeightBias tweak (+/-/0 chord) is applied inside computePaneH.
      const paneH = effectiveChatOnlyMode() ? 0 : computePaneH(termRows);
      const renderSnapshot = buildDashboardRenderSnapshot({
        termRows,
        hasPluginLayout: !!pluginLayout,
        workingDirView: workingDir.view,
        chatOnlyMode: effectiveChatOnlyMode(),
        paneHeight: paneH,
        promptFrame,
      });
    const { renderChatOnly, logEmbedded, gridLayoutHeight } = renderSnapshot;
    const baseLayout = pluginLayout
      ?? (gridLayoutHeight > 0 ? workingDirLayoutForView(totalW, gridLayoutHeight) : null);
    // NT5 — when the bell modal is open, append its placement so
    // renderModalOverlay paints it as a centered full-frame modal.
    const bellModals = bellOpen
      ? [{
          id: 'nt-bell',
          widgetInstanceId: 'wd-notification-bell',
          position: 'center' as const,
          size: { width: Math.max(40, Math.floor(totalW * 0.8)), height: Math.max(8, Math.floor(termRows * 0.6)) },
        }]
      : [];
    const extraModals = [...dashboardModals, ...bellModals];
    const effectiveLayout = baseLayout && extraModals.length > 0
      ? createLayout(baseLayout.rows, [...baseLayout.modals, ...extraModals])
      : baseLayout;

    // Focused widget id for renderLayout (drives active/inactive
    // pane-title colors + cursor dimming).
    let workingFocusedId: string | null = null;
    if (!renderChatOnly && !pluginLayout) {
      syncWorkingDirWidgetState();
      workingFocusedId = surfaceIdForWorkingFocus(workingDir.focus, workingDir.view);
    } else if (renderChatOnly && !pluginLayout) {
      agentRosterEventPump();
    }
    const focusedId = resolveDashboardFocusedInstanceId({
      renderChatOnly,
      hasPluginLayout: !!pluginLayout,
      pluginFocusedInstanceId: SYNC_WIDGET_IDS[sync.focus] ?? null,
      workingFocusedInstanceId: workingFocusedId,
    });
    // VP5 — observe playground reload request (per-redraw poll).
    maybeTriggerPlaygroundReload();
    maybeSyncPlaygroundLabPalette();
    maybeSyncPlaygroundVisualConsole();
    maybeApplyPlaygroundThemeSelection();
    maybeHandlePlaygroundLabActions();
    // IDX-F3.5c — the per-frame dashboard-projection block used to live
    // here; every workingDir.focus mutation now flows through
    // setWorkingFocus, which issues display.syncExternalFocus at the
    // assignment site. Coordinator focus is the single source of truth.

    // ── Footer hint (mode-specific keybinding prompts) ──
    const foregroundSurface = topWorkspaceSurface({
      focusStack: display.modalStack(),
      surfaceAt: id => display.surface(id),
    });
    const blockingForegroundModal = topBlockingForegroundModal();
    const bottomAreaFreezeModal = topBottomAreaFreezeModal(termRows);
    const hostChromePolicy = resolveDashboardHostChromePolicy({
      foregroundSurface,
      blockingForegroundModal,
      bottomAreaFreezeModal,
    });
    if (debug.enabled) {
      const key = JSON.stringify(hostChromePolicy);
      if (key !== lastHostChromePolicyDebugKey) {
        lastHostChromePolicyDebugKey = key;
        debug.log('dashboard.host-chrome.policy', 'resolve', hostChromePolicy);
      }
    }
    const suppressPromptArea = hostChromePolicy.suppressPromptArea;
    const suppressStatusArea = hostChromePolicy.suppressStatusArea;
    const suppressDashboardBackground = hostChromePolicy.suppressDashboardBackground;
    if (suppressPromptArea) display.setCursor(null);
    // ── Zone list (top-to-bottom) ──
    // Replaces the old inline `termRows - N` arithmetic and hand-rolled
    // `lines.push(...)` loop with a declarative composition. composer
    // allocates rows (fixed first, grow zones split leftover), renders
    // each zone, and returns both the flat lines array + a zoneRows
    // map so textInput can read its target row by name instead of
    // computing it with magic constants.
    const zones: LayoutZone[] = [];

    // Top section — grid + log. Three shapes:
    //   - chat-only (view 4 / chatOnlyMode):   log fills the whole area.
    //   - logEmbedded (views 1/2/3/4):         grid grows, log widget is inside it.
    //   - default (skill workspace / sync):    grid fixed paneH, log grows.
    // Effective freeze — only surface the frozen slice when the user is
    // actually scrolled up. If something else (streaming, slash reply)
    // pulls the offset back to -1 (tail), the freeze is no-op'd so the
    // user sees full content at tail regardless of stale index state.
    const logProjection = buildDashboardLogProjection({
      chatScrollOffset,
      logFrozenTailIndex,
      logSearchCursor,
      logSearchResultsLength: logSearchResults.length,
    });
    if (renderChatOnly) {
      // U-4.2 · chat-only renders via wd-log widget · syncLogWidgetState
      // pushes freeze/search into widget state so the output matches
      // the pre-U-4.2 direct renderLogPane call.
      zones.push({
        id: 'log',
        height: 'grow',
        render: (h, c) => renderLogViaWidget(h, c, 1),
      });
    } else if (logEmbedded) {
      zones.push({
        id: 'grid',
        height: 'grow',
        render: (h, c) => {
          if (!effectiveLayout) return [];
          return renderLayout(effectiveLayout, widgetHost, {
            width: c, height: h, topRow: 1, focusedInstanceId: focusedId, theme: currentThemeTokens(),
          });
        },
      });
    } else {
      zones.push({
        id: 'grid',
        height: paneH,
        render: (h, c) => {
          if (!effectiveLayout) return [];
          return renderLayout(effectiveLayout, widgetHost, {
            width: c, height: h, topRow: 1, focusedInstanceId: focusedId, theme: currentThemeTokens(),
          });
        },
      });
      // U-4.2 · default branch (plugin layout / sync / skill) also
      // routes through wd-log widget instead of direct renderLogPane.
      // Widget state was synced in the same function before this
      // render callback ran (syncWorkingDirWidgetState / explicit
      // renderLogViaWidget->syncLogWidgetState). `topRow: paneH + 1`
      // matches the zone's absolute start so hit-test coord math
      // (when it switches to the widget in U-4.3) lines up.
      zones.push({
        id: 'log',
        height: 'grow',
        render: (h, c) => renderLogViaWidget(h, c, paneH + 1),
      });
    }

    // Essential chrome uses only the status line, not a HUD row.

    // Input block.
    let promptCaret: CursorState | null = null;
    zones.push({
      id: 'input-divider-upper',
      height: 1,
      render: (_h, c) => [suppressPromptArea ? ' '.repeat(c) : hLine(c)],
    });
    const inputPromptZone = buildDashboardTurnTypeaheadPromptZone({
      frame: promptFrame,
      height: promptFrame.inputHeight,
      placeholder: C.muted('\u276f '),
      ...(streamingInFlight ? { hint: C.muted('입력하면 이 응답 뒤에 이어서 보냅니다') } : {}),
      prompt: C.accent('❯ '),
      state: turnTypeaheadRef.state,
      width: totalW,
      suppressPromptArea,
      onPaint: paint => { promptCaret = paint.caret; },
    });
    zones.push(observeDashboardTurnTypeaheadPromptZone(inputPromptZone, {
      promptBottomRow: promptFrame.promptBottomRow,
      state: turnTypeaheadRef.state,
    }));
    zones.push({
      id: 'input-divider-lower',
      height: 1,
      render: (_h, c) => [suppressPromptArea ? ' '.repeat(c) : hLine(c)],
    });

    // Essential bottom area: status line only; no dock row.
    zones.push({ id: 'status-gap-top', height: 1, render: () => [''] });
    zones.push({
      id: 'status',
      height: 1,
      render: () => [suppressStatusArea ? '' : buildStatusLine()],
    });

    // Compose.
    const composed = composeVertical(zones, { rows: termRows, cols: totalW });
    const baseLines = composed.lines.slice();
    if (blockingForegroundModal) {
      const blockingBounds = blockingForegroundModal.visualBounds
        ?? blockingForegroundModal.interactiveBounds
        ?? blockingForegroundModal.bounds;
      const startRow = Math.max(1, blockingBounds.row);
      const endRow = Math.min(termRows, blockingBounds.row + blockingBounds.height - 1);
      for (let row = startRow; row <= endRow; row++) {
        baseLines[row - 1] = ''.padEnd(totalW, ' ');
      }
      if (debug.isKeyTraceEnabled()) {
        debug.log('dashboard.blocking-modal-mask', 'apply', {
          modalId: blockingForegroundModal.id,
          interactionClass: blockingForegroundModal.interactionClass ?? null,
          tier: blockingForegroundModal.tier ?? null,
          startRow,
          endRow,
          width: totalW,
          sourceBounds: {
            row: blockingBounds.row,
            col: blockingBounds.col,
            width: blockingBounds.width,
            height: blockingBounds.height,
          },
        });
      }
    }
    if (suppressDashboardBackground && foregroundSurface) {
      const startRow = Math.max(1, foregroundSurface.bounds.row);
      const endRow = Math.min(termRows, foregroundSurface.bounds.row + foregroundSurface.bounds.height - 1);
      for (let row = startRow; row <= endRow; row++) {
        baseLines[row - 1] = ''.padEnd(totalW, ' ');
      }
      if (debug.isKeyTraceEnabled()) {
        debug.log('dashboard.workspace-mask', 'apply', {
          surfaceId: foregroundSurface.id,
          interactionClass: foregroundSurface.interactionClass ?? null,
          startRow,
          endRow,
          width: totalW,
          bounds: {
            row: foregroundSurface.bounds.row,
            col: foregroundSurface.bounds.col,
            width: foregroundSurface.bounds.width,
            height: foregroundSurface.bounds.height,
          },
        });
      }
    }

    // Modal overlay on top of everything else. Render it into the same
    // stdout write as the base frame; splitting base and overlay writes
    // is one of the easiest ways to see a flash under tmux.
    let modalFrame = '';
    let modalKey = '';
    if (effectiveLayout && effectiveLayout.modals.length > 0) {
      const m = effectiveLayout.modals[0]!;
      modalKey = `${m.id}:${m.widgetInstanceId}:${JSON.stringify(m.position)}:${m.size?.width ?? ''}x${m.size?.height ?? ''}`;
      modalFrame = renderModalOverlay(effectiveLayout, widgetHost, {
        termRows, termCols: cols, theme: currentThemeTokens(),
      });
    }
    if (debug.isKeyTraceEnabled() && blockingForegroundModal) {
      debug.log('dashboard.frame-compose', 'blocking-modal', {
        modalId: blockingForegroundModal.id,
        baseLineCount: baseLines.length,
        overlayLen: modalFrame.length,
        hasForegroundWorkspaceFrame: false,
      });
    }
    try {
      const overlayCleanup = transientOverlayHost.prepareFrame();
      if (overlayCleanup.length > 0) process.stdout.write(overlayCleanup);
    } catch { /* overlay cleanup must not crash main draw */ }

    // V3 — either the local layout-modal key flipped OR the coordinator
    // propagated request.force (e.g. popModal / closeSurface on a
    // coordinator-owned modal). Before V3 only the layout-modal signal
    // was honored, so coordinator modal closes left residual pixels.
    // ⭐ Single flush: resolve the prompt caret after overlays.
    const frameCursorDecision = display.cursorDecision();
    renderDashboardFrame(baseLines, composeDashboardFrameWithCoordinatorModal(display, {
      overlay: modalFrame,
      force: forceFromCoordinator || modalKey !== lastModalKey,
      cursorOwner: frameCursorDecision.owner,
      claimedCursor: frameCursorDecision.cursor,
      coordinatorCursor: display.getCursor(),
      promptCaret,
      suppressPromptArea,
      onEssentialFrameCursorDecision: observeEssentialFrameCursor,
    }));
    lastModalKey = modalKey;

    // Phase T: resize the embedded terminal if the preview zone shifted
    // (tmux zoom, pane resize, terminal window resize). Cheap diff — no
    // ioctl when dims unchanged.
    if (previewTerminal?.isAlive) {
      const want = computePreviewTerminalDims();
      if (!previewTerminalDims
          || previewTerminalDims.cols !== want.cols
          || previewTerminalDims.rows !== want.rows) {
        try { previewTerminal.resize(want.cols, want.rows); } catch { /* ignore */ }
        previewTerminalDims = want;
      }
    }
    const activeExecution = activeExecutionSurfaceId
      ? executionSurfaces.get(activeExecutionSurfaceId) ?? null
      : null;
    if (activeExecution?.terminal.isAlive) {
      const want = computePreviewTerminalDims();
      if (!previewTerminalDims
          || previewTerminalDims.cols !== want.cols
          || previewTerminalDims.rows !== want.rows) {
        try { activeExecution.resize(want.cols, want.rows); } catch { /* ignore */ }
        previewTerminalDims = want;
      }
    }

    // Publish the input-prompt's BOTTOM row so textInput's moveTo can
    // find it without recomputing `termRows - N` itself.
    dashboardState.setComposedPromptFrame(
      termRows,
      resolvePromptFrame(termRows, dashboardState.getInputLines(), composed.zoneRows),
    );

    // MX11b — record the status area row so pill clicks route
    // correctly. Fire-and-forget: a missing zone just disables pill
    // dispatch for the next frame.
    const dockZone = composed.zoneRows.get('dock');
    mouseWiring.setDockRow(dockZone && dockZone.height > 0 ? dockZone.start : null);
    const statusZone = composed.zoneRows.get('status');
    mouseWiring.setStatusRow(statusZone && statusZone.height > 0 ? statusZone.start : null);

    // MX9b — record the pane-nav row so click-to-focus works.
    const paneNavZone = composed.zoneRows.get('pane-nav');
    paneNavRow = paneNavZone && paneNavZone.height > 0 ? paneNavZone.start : null;

    // MX-widget-mouse — record grid zone bounds so pane-content
    // clicks can be hit-tested against the widget cells.
    const gridZone = composed.zoneRows.get('grid');
    if (gridZone && gridZone.height > 0) {
      gridZoneStart = gridZone.start;
      gridZoneHeight = gridZone.height;
    } else {
      gridZoneStart = null;
      gridZoneHeight = null;
    }
    // U-4.3 · log zone bounds for `dispatchLogZoneClick`. Present
    // only when the zone composer emitted a separate 'log' zone
    // (chat-only + plugin-default branches); logEmbedded path has
    // the log inside the grid and dispatchPaneClick owns those
    // clicks, so logZone* stays null there.
    const logZone = composed.zoneRows.get('log');
    if (logZone && logZone.height > 0) {
      logZoneStart = logZone.start;
      logZoneHeight = logZone.height;
    } else {
      logZoneStart = null;
      logZoneHeight = null;
    }
    lastEffectiveLayout = effectiveLayout;

    // R1.1 / R1.2 — non-modal transient overlays now flush through a
    // shared host in two phases: cleanup before the main frame, fresh
    // stamp after it. Drag ghost/highlight/banner are the first
    // production adopters; future non-modal overlay painters should
    // register there instead of asking dashboard for bespoke stdout
    // writes.
    try {
      const overlay = transientOverlayHost.paint();
      if (overlay.length > 0) process.stdout.write(overlay);
    } catch { /* overlay must not crash main draw */ }
  };
  draw = (opts = {}) => {
    if (debug.enabled) {
      const now = Date.now();
      const deltaMs = lastDrawDebugAt === 0 ? null : now - lastDrawDebugAt;
      lastDrawDebugAt = now;
      // 2026-07-24 — `caller` 스택 캡처는 keytrace 로 강등. `new Error().stack` 은
      // 예외 경로에서나 하는 비싼 연산인데 여기선 **정상 렌더 프레임마다** 돌았다
      // (diag 만 켜도 발화 · 관측 노이즈 중 단가가 가장 높은 항목). 프레임 카운트와
      // deltaMs 는 diag 에서 그대로 남으므로 "몇 번 그렸나"는 계속 보인다 — 스택이
      // 필요한 "누가 그렸나"만 keytrace 로 올린다.
      debug.log('dashboard.draw', 'request', {
        force: opts.force === true,
        queued: drawQueued,
        deltaMs,
        ...(debug.isKeyTraceEnabled()
          ? { caller: new Error().stack?.split('\n').slice(2, 6).map((line) => line.trim()) ?? [] }
          : {}),
      });
    }
    if (opts.force) {
      drawQueued = false;
      queuedDrawForce = false;
      drawNow(opts);
      return;
    }
    if (drawQueued) return;
    drawQueued = true;
    queueMicrotask(() => {
      const force = queuedDrawForce;
      drawQueued = false;
      queuedDrawForce = false;
      if (debug.enabled) {
        debug.log('dashboard.draw', 'flush-microtask', {
          force,
          promptRepainted: true,
        });
      }
      drawNow({ force });
      try { repaintPromptAfterRender({ force }); } catch { /* noop */ }
    });
  };

  // ── Scratchpad pane (transient ANSI buffer) ──
  // The third column in working-dir View 2. Holds short-lived content
  // the user wants visible without it bloating the log: image
  // previews on @-pick / Ctrl+V, ephemeral debug dumps, etc. State is
  // ANSI-tinted lines plus an optional title + scroll offset. Single
  // slot — last write wins, matching "show me what I just grabbed".
  let scratchTitle = '';
  let scratchLines: string[] = [];
  let scratchOffset = 0;
  // Scratch pane is now a stable writable canvas / preview surface.
  type ScratchMode = 'preview';
  let scratchMode: ScratchMode = 'preview';
  let clipCursor = 0;
  const agentSurfaceStore = new AgentSurfaceStore();
  // Cursor inside the dedicated agent roster surfaces.
  let agentRosterCursor = 0;
  // PFC-S2 P3: `?` toggles the cheatsheet overlay below the roster.
  // State is dashboard-local (not persisted) — help closes on app
  // restart, matching other ephemeral UI toggles (e.g. debug detail).
  let agentRosterHelp = false;
  // Auto-follow the most recently spawned / still-running agent until
  // the user manually moves the cursor with j/k. Reset when the roster
  // fully drains. This matches the user's expectation: "the running
  // sub-agent should get focus automatically".
  let agentCursorManual = false;
  // P4.1 — agent-roster search modal. When `/` is pressed while
  // workingDir.focus === 'agent-roster', a
  // small modal opens with a query line + filtered candidate list.
  // Enter jumps the cursor; Esc dismisses. While active, the
  // dashboard's main key handler routes EVERY key into the modal
  // until it disposes. Mutually exclusive with normal roster keys.
  let agentSearchModal: SearchModalHandle | null = null;
  let agentSearchHandle: { dispose: () => void } | null = null;

  /** Open the agent-roster search modal. Reads the current roster
   *  from agentSurfaceStore + globalAgentRegistry. Items: each
   *  entry's name + last 8 chars of id. Enter sets cursor; Esc
   *  dismisses. */
  function openAgentRosterSearch(): void {
    if (agentSearchModal) return;
    const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
    const cols = termSize().cols;
    const modalWidth = Math.min(60, cols - 4);
    const modalRow = 3;       // top-anchored over the roster pane
    const modalCol = Math.max(2, Math.floor((cols - modalWidth) / 2));
    const filterable = roster.length > 3;
    const handle = createSearchModal({
      id: `agent-roster-search:${Date.now().toString(36)}`,
      bounds: { row: modalRow, col: modalCol, width: modalWidth, height: 12 },
      title: 'Search agents',
      width: modalWidth,
      maxVisible: 8,
      primaryActionLabel: 'jump',
      cancelActionLabel: 'cancel',
      filterable,
      actionButtons: true,
      chromeSpec: {
        titleAlign: 'center',
      },
      onQuery: (q) => {
        const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
        const needle = q.trim().toLowerCase();
        const match = (t: typeof roster[number]) => {
          if (!needle) return true;
          return t.name.toLowerCase().includes(needle)
              || t.definitionName.toLowerCase().includes(needle)
              || (t.summary ?? '').toLowerCase().includes(needle)
              || t.id.toLowerCase().includes(needle);
        };
        return roster.filter(match).map((t): SearchItem => ({
          label: `${t.name}  ${t.definitionName}  ${t.id.slice(0, 8)}`,
          payload: t.id,
        }));
      },
      onAccept: (item) => {
        const roster = agentSurfaceStore.syncTasks(globalAgentRegistry.list());
        const idx = roster.findIndex(t => t.id === item.payload);
        if (idx >= 0) {
          agentRosterCursor = idx;
          agentCursorLockedId = roster[idx]!.id;
          agentCursorManual = true;
        }
        closeAgentRosterSearch();
      },
      onCancel: () => closeAgentRosterSearch(),
      theme: currentThemeTokens(),
    });
    attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
    agentSearchModal = handle;
    agentSearchHandle = display.pushModal(handle.surface);
  }

  function closeAgentRosterSearch(): void {
    if (agentSearchHandle) { agentSearchHandle.dispose(); agentSearchHandle = null; }
    agentSearchModal = null;
    draw();
  }

  /** T5-J5 — open the transfer picker. Files arg = local paths to
   *  ship; destination comes from the picker. Handles both ssh and
   *  iphone target kinds. Remote-mode browser isn't supported here
   *  yet — the user is transferring LOCAL files (focused entry +
   *  selected set) to a remote destination. Transferring REMOTE→X
   *  is a separate flow (not this phase). */
  function openTransferPicker(
    files: Array<{ localPath: string; size?: number }>,
    browserId: string = activeBrowserWidgetId(),
  ): void {
    const targetBrowser = resolveBrowserStateById(browserId) ?? (workingDir as BrowserPaneModel);
    if (files.length === 0) {
      transferFeedbackRuntime.onNoFilesToTransfer();
      return;
    }
    const capability = resolveBrowserTransferCapability(
      targetBrowser,
      listTransferTargets(),
    );
    if (!capability.enabled) {
      transferFeedbackRuntime.onTransferDisabled(capability.reason);
      return;
    }
    const targets = capability.targets;
    if (targets.length === 0) {
      transferFeedbackRuntime.onNoTransferTargets();
      return;
    }
    const totalBytes = files.reduce((a, f) => a + (f.size ?? 0), 0);
    const summary = `${files.length} file${files.length === 1 ? '' : 's'}${
      totalBytes > 0 ? ` (${fmtBytes(totalBytes)})` : ''
    }`;

    const { cols, rows } = termSize();
    const width = Math.min(74, Math.max(46, cols - 6));
    const visibleRows = Math.min(10, targets.length);
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    const picker = createTransferPickerModal({
      targets,
      bounds,
      width,
      maxVisible: visibleRows,
      summary,
      theme: currentThemeTokens(),
      onAccept: (target) => {
        agentSearchModal = null;
        handle?.dispose();
        void runTransfer(target, files);
        draw();
      },
      onCancel: () => {
        agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    agentSearchModal = picker;
    draw();
  }

  async function runTransfer(
    target: TransferTarget,
    files: Array<{ localPath: string; size?: number }>,
  ): Promise<void> {
    transferFeedbackRuntime.onTransferStarted(target, files.length);
    try {
      if (target.kind === 'ssh') {
        const r = await sshTransfer({
          host: target.host,
          remoteDir: target.remoteDir,
          files,
          continueOnError: true,
          onProgress: (evt: SshTransferProgress) => {
            transferFeedbackRuntime.onSshProgress(evt);
          },
        });
        transferFeedbackRuntime.onSshTransferCompleted(target, r);
      } else {
        const r = await iphoneTransfer({ target, files });
        transferFeedbackRuntime.onIphoneTransferCompleted(target, r);
      }
    } catch (err) {
      transferFeedbackRuntime.onTransferCrashed(err);
    }
  }

  /** T4-F2 / T4-F3 — open the Ctrl+T finder modal. Scans the
   *  current working dir (local only at MVP; remote scan is a
   *  follow-up). On accept, cd's the browser pane to the file's
   *  parent dir, focuses the file in the listing, and switches
   *  pane focus to browser so the user can e/enter next. */
  async function openFinderPicker(): Promise<void> {
    const targetBrowserId = activeBrowserWidgetId();
    const targetBrowser = resolveBrowserStateById(targetBrowserId) ?? (workingDir as BrowserPaneModel);
    // T5-I2 — branch on remote vs local. Both paths produce the
    // same {absPath, relPath} finder items so the modal + onAccept
    // handler stay unified.
    let finderItems: FinderItem[] = [];
    let backend = 'fd';
    let truncated = false;
    let scanDurationMs = 0;

    if (workingDir.remote) {
      const host = workingDir.remote.host;
      const remoteRoot = workingDir.remote.cwd;
      finderFeedbackRuntime.onFinderScanStarted(`${host.name}:${remoteRoot}`);
      draw();
      const scan = await scanRemoteFinder({ host, root: remoteRoot });
      const rels = relativizeRemoteResults(scan.paths, remoteRoot);
      finderItems = scan.paths.map((absPath, i) => ({
        absPath, relPath: rels[i] ?? absPath,
      }));
      backend = `${scan.backend}@${scan.host}`;
      truncated = scan.truncated;
      scanDurationMs = scan.durationMs;
    } else {
      // 2026-05-03 — scan from the Session Working Directory (the
      // "project root"), NOT the browser pane's current navigation
      // cursor. SWD is mutable only via Ctrl+W / /wd / SetWorkingDir
      // tool — exactly the user's intent for "project root". Browser
      // pane's cwd is purely UI navigation and should not narrow
      // Ctrl+T's search scope (matches working-dir.ts:5-8 contract).
      const scanRoot = getSessionCwd();
      finderFeedbackRuntime.onFinderScanStarted(scanRoot);
      draw();
      const scan = await scanFinder({ root: scanRoot });
      const rels = relativizeResults(scan.paths, scanRoot);
      finderItems = scan.paths.map((absPath, i) => ({
        absPath, relPath: rels[i] ?? absPath,
      }));
      backend = scan.backend;
      truncated = scan.truncated;
      scanDurationMs = scan.durationMs;
    }
    if (finderItems.length === 0) {
      finderFeedbackRuntime.onFinderScanEmpty();
      draw();
      return;
    }
    finderFeedbackRuntime.onFinderScanCompleted({
      count: finderItems.length,
      backend,
      truncated,
      durationMs: scanDurationMs,
    });

    const { cols, rows } = termSize();
    const width = Math.min(90, Math.max(50, cols - 6));
    const visibleRows = Math.min(15, Math.max(6, rows - 8));
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    // Title reflects the actual scan root — SWD for local (project
     // root), remote cwd for remote mode. Browser pane's nav cursor
     // is intentionally NOT shown because the scan ignores it.
    const titleRoot = workingDir.remote
      ? `${workingDir.remote.host.name}:${workingDir.remote.cwd}`
      : getSessionCwd().replace(homedir(), '~');
    // 2026-05-03 — preview modes (yazi/fzf-style, on-demand).
    //
    // Default mode is OFF — the picker opens cleanly with NO preview
    // so it's never annoying on tablet / narrow terminals. The user
    // toggles preview behaviour with `Ctrl+/` (matches zshrc
    // `--bind 'ctrl-/:toggle-preview'`):
    //
    //   off    →  hover  →  2pane  →  off  (cycle)
    //
    //   • off   — no preview, ever. The cursor moves freely.
    //   • hover — popup appears after the cursor stays still for
    //             1 second (HOVER_DELAY_MS). Popup auto-dismisses
    //             after 4s. Centered, the same width as legacy
    //             behaviour but on-demand.
    //   • 2pane — browser-preview style: persistent preview popup
    //             docked to the right of the picker. Updates
    //             instantly as the cursor moves. Falls back to
    //             hover if the terminal is too narrow (<140 cols).
    //
    // showPreviewModal supports remote-skip by itself (preview
    // handlers read local fs), so we simply guard with workingDir
    // .remote before scheduling.
    type PreviewMode = 'off' | 'hover' | '2pane';
    const HOVER_DELAY_MS = 1000;
    const TWO_PANE_MIN_COLS = 140;
    const TWO_PANE_GROUP = 'finder-2pane-preview';

    let previewMode: PreviewMode = 'off';
    let lastSelected: FinderItem | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPreviewHandle: { dispose(): void } | null = null;

    const clearHoverTimer = () => {
      if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
    };
    const disposeActivePreview = () => {
      if (lastPreviewHandle) {
        try { lastPreviewHandle.dispose(); } catch { /* ignore */ }
        lastPreviewHandle = null;
      }
    };

    /** Compute the docked-preview bounds for 2-pane mode. Picker
     *  centred at width≈90; preview takes the right gutter. Returns
     *  null when there isn't enough room (caller falls back to
     *  hover). */
    const computeDockedPreviewBounds = (): {
      row: number; col: number; width: number; height: number;
    } | null => {
      const { cols: tc, rows: tr } = termSize();
      if (tc < TWO_PANE_MIN_COLS) return null;
      const pickerWidth = Math.min(90, Math.max(50, tc - 6));
      const pickerCol = Math.max(1, Math.floor((tc - pickerWidth) / 2));
      const previewCol = pickerCol + pickerWidth + 2;
      const previewWidth = Math.max(40, tc - previewCol - 2);
      if (previewWidth < 40) return null;
      const previewHeight = Math.max(8, Math.min(tr - 6, 28));
      const previewRow = Math.max(1, Math.floor((tr - previewHeight) / 2));
      return { row: previewRow, col: previewCol, width: previewWidth, height: previewHeight };
    };

    const paintPreviewFor = (item: FinderItem) => {
      if (workingDir.remote) return;   // remote previews unsupported
      const { rows: tr, cols: tc } = termSize();
      const docked = previewMode === '2pane' ? computeDockedPreviewBounds() : null;
      void showPreviewModal(item.absPath, {
        coordinator: display,
        termCols: tc,
        termRows: tr,
        title: item.relPath,
        ttlMs: previewMode === '2pane' ? 0 : 4000,
        bounds: docked ?? undefined,
        group: previewMode === '2pane' ? TWO_PANE_GROUP : 'image-preview',
      }).then((r) => {
        lastPreviewHandle = r?.handle ?? null;
      }).catch(() => { /* preview failure is non-fatal */ });
    };

    const scheduleHoverPreview = (item: FinderItem | null) => {
      lastSelected = item;
      clearHoverTimer();
      if (previewMode === 'off') return;
      if (!item || workingDir.remote) {
        // Off-screen / remote — kill any straggling popup so the
        // user doesn't see a preview that no longer matches the
        // selection.
        disposeActivePreview();
        return;
      }
      if (previewMode === '2pane') {
        // Instant update — no debounce. Persistent popup replaces
        // itself via group dedup.
        paintPreviewFor(item);
        return;
      }
      // HOVER mode. Selection just changed → the popup currently on
      // screen (if any) is stale. Drop it immediately so the user
      // doesn't keep seeing the previous file's preview while their
      // cursor is on a new file. The next paint waits HOVER_DELAY_MS
      // of stillness before re-appearing.
      disposeActivePreview();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        paintPreviewFor(item);
      }, HOVER_DELAY_MS);
    };

    /** Cycle off → hover → 2pane → off. Surfaces a status line so
     *  the user knows which mode they're in (Ctrl+/ has no chrome
     *  feedback otherwise). 2pane on a narrow terminal degrades
     *  to hover with a warning. */
    const cyclePreviewMode = (): void => {
      const next: PreviewMode = previewMode === 'off' ? 'hover'
                              : previewMode === 'hover' ? '2pane'
                              : 'off';
      previewMode = next;
      clearHoverTimer();
      // Drop the active popup whenever the mode changes. The new
      // mode (if any) re-paints below.
      disposeActivePreview();

      if (next === 'off') {
        chatLines.push(C.muted('  finder preview: OFF (Ctrl+/ to cycle modes)'));
      } else if (next === 'hover') {
        chatLines.push(C.muted('  finder preview: HOVER (popup after 1 s · Ctrl+/ next)'));
      } else {
        // 2pane — refuse if the terminal is too narrow; degrade to
        // hover so the user gets *some* preview without overlap.
        const docked = computeDockedPreviewBounds();
        if (!docked) {
          previewMode = 'hover';
          chatLines.push(C.warning(`  finder preview: 2-pane needs ≥${TWO_PANE_MIN_COLS} cols — falling back to HOVER`));
        } else {
          chatLines.push(C.muted('  finder preview: 2-PANE (docked right · Ctrl+/ to disable)'));
          if (lastSelected) paintPreviewFor(lastSelected);
        }
      }
      chatScrollOffset = -1;
      draw();
    };

    // Declared up here so `onAccept`/`onCancel` closures below can
    // reference both; assigned right after the picker mounts.
    let previewToggleDisposable: { dispose(): void } | null = null;
    let previewDismissDisposable: { dispose(): void } | null = null;
    const picker = createFinderModal({
      items: finderItems,
      bounds, width, maxVisible: visibleRows,
      truncated,
      title: `Find file in ${titleRoot}`,
      theme: currentThemeTokens(),
      onHover: scheduleHoverPreview,
      onAccept: (item) => {
        clearHoverTimer();
        disposeActivePreview();
        previewToggleDisposable?.dispose();
        previewDismissDisposable?.dispose();
        agentSearchModal = null;
        handle?.dispose();
        const parentDir = item.absPath.slice(0, item.absPath.lastIndexOf('/')) || '/';
        const basename = item.absPath.slice(item.absPath.lastIndexOf('/') + 1);
        if (workingDir.remote) {
          // T5-I2 — remote cd + focus-by-basename.
          enterRemoteDirectory(workingDir, parentDir);
          (async () => {
            await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
            const idx = workingDir.entries.findIndex(e => e.name === basename);
            if (idx >= 0) {
              workingDir.cursor = idx;
              workingDir.offset = Math.max(0, idx - 3);
            }
            await refreshRemotePreviewBridge();
            pushDebugLine(C.muted(`  ${workingDir.remote?.host.name}:${item.relPath}`));
            chatScrollOffset = -1;
            draw();
          })().catch(() => {});
        } else {
          enterDirectory(targetBrowser as WorkingDirState, parentDir);
          refreshWorkingDir(targetBrowser as WorkingDirState);
          const idx = targetBrowser.entries.findIndex(e => e.name === basename);
          if (idx >= 0) {
            targetBrowser.cursor = idx;
            targetBrowser.offset = Math.max(0, idx - 3);
          }
          refreshWorkingDirPreview();
          pushDebugLine(C.muted(`  ${item.relPath}`));
          chatScrollOffset = -1;
        }
        setWorkingFocus('browser', 'agent-roster-search-pick');
        draw();
      },
      onCancel: () => {
        clearHoverTimer();
        disposeActivePreview();
        previewToggleDisposable?.dispose();
        previewDismissDisposable?.dispose();
        agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    // Ctrl+/ (and Ctrl+_ which some terminals send for the same
    // physical chord) cycles preview modes. Active for the lifetime
    // of THIS picker only — disposed in both onAccept and onCancel
    // above. Q4 (substrate Occam): no per-binding pipe alias, register
    // each variant separately. (Korean IME aliases unnecessary — Ctrl+/
    // has no jamo mapping on the 2-set layout.)
    const togglePreviewMode = (): void => { cyclePreviewMode(); };
    const previewSlash = display.registerKeyBinding({
      id: `dashboard:finder-picker-preview-toggle-slash:${Date.now().toString(36)}`,
      key: 'C-/',
      scope: 'global',
      when: () => agentSearchModal === picker,
      handler: togglePreviewMode,
    });
    const previewUnder = display.registerKeyBinding({
      id: `dashboard:finder-picker-preview-toggle-under:${Date.now().toString(36)}`,
      key: 'C-_',
      scope: 'global',
      when: () => agentSearchModal === picker,
      handler: togglePreviewMode,
    });
    previewToggleDisposable = {
      dispose: () => { previewSlash.dispose(); previewUnder.dispose(); },
    };
    // Ctrl+] — instantly dismiss the active preview popup WITHOUT
    // closing the picker or changing the mode. Esc would be more
    // intuitive but the picker captures Esc internally to cancel
    // itself. Ctrl+\ is unsafe because it raises SIGQUIT in many
    // terminal drivers. Ctrl+] (historically "telnet escape" =
    // "exit this context") is universally safe + semantically right.
    // Active only while a preview is currently visible — otherwise
    // the binding silently no-ops (no flicker, no log spam).
    // Mode stays as set; if user is in HOVER mode, the next
    // cursor stillness re-triggers the popup. To stop the popup
    // from re-appearing entirely, cycle Ctrl+/ back to OFF.
    previewDismissDisposable = display.registerKeyBinding({
      id: `dashboard:finder-picker-preview-dismiss:${Date.now().toString(36)}`,
      key: 'C-]',
      scope: 'global',
      when: () => agentSearchModal === picker && lastPreviewHandle !== null,
      handler: () => {
        clearHoverTimer();
        disposeActivePreview();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    agentSearchModal = picker;
    draw();
  }

  /** Yazi-style Alt+C — directory finder. Symmetric with openFinder
   *  Picker but enumerates directories only (`scanFinder kind:'dir'`)
   *  and on accept cd's the browser pane to the chosen directory.
   *  Remote-mode is currently unsupported (surfaces a warning) — the
   *  remote finder would need a parallel kind-aware backend. */
  async function openDirectoryPicker(): Promise<void> {
    if (workingDir.remote) {
      chatLines.push(C.warning('  Alt+C: directory finder is local-only — Esc remote first.'));
      chatScrollOffset = -1;
      draw();
      return;
    }
    const targetBrowserId = activeBrowserWidgetId();
    const targetBrowser = resolveBrowserStateById(targetBrowserId) ?? (workingDir as BrowserPaneModel);
    // Symmetric with openFinderPicker — scan from SWD (project root),
    // not the browser pane's nav cursor. The accept handler still
    // mutates targetBrowser to navigate into the chosen dir.
    const scanRoot = getSessionCwd();
    finderFeedbackRuntime.onFinderScanStarted(`${scanRoot} (dirs)`);
    draw();
    const scan = await scanFinder({ root: scanRoot, kind: 'dir' });
    const rels = relativizeResults(scan.paths, scanRoot);
    const dirItems: FinderItem[] = scan.paths.map((absPath, i) => ({
      absPath, relPath: rels[i] ?? absPath,
    }));
    if (dirItems.length === 0) {
      finderFeedbackRuntime.onFinderScanEmpty();
      draw();
      return;
    }
    finderFeedbackRuntime.onFinderScanCompleted({
      count: dirItems.length,
      backend: scan.backend,
      truncated: scan.truncated,
      durationMs: scan.durationMs,
    });

    const { cols, rows } = termSize();
    const width = Math.min(90, Math.max(50, cols - 6));
    const visibleRows = Math.min(15, Math.max(6, rows - 8));
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    const titleRoot = scanRoot.replace(homedir(), '~');
    const picker = createFinderModal({
      items: dirItems,
      bounds, width, maxVisible: visibleRows,
      truncated: scan.truncated,
      title: `Find directory in ${titleRoot}`,
      theme: currentThemeTokens(),
      onAccept: (item) => {
        agentSearchModal = null;
        handle?.dispose();
        enterDirectory(targetBrowser as WorkingDirState, item.absPath);
        refreshWorkingDir(targetBrowser as WorkingDirState);
        refreshWorkingDirPreview();
        pushDebugLine(C.muted(`  cd ${item.relPath}`));
        chatScrollOffset = -1;
        setWorkingFocus('browser', 'alt-c-dir-pick');
        draw();
      },
      onCancel: () => {
        agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    agentSearchModal = picker;
    draw();
  }

  /** T4-E4 — open the SSH host picker (Ctrl+K). Accept connects
   *  the browser pane to the remote host; Esc cancels silently.
   *  Routes keys through agentSearchModal (shared pattern with
   *  window + session pickers). */
  function openSshPicker(): void {
    const { cols, rows } = termSize();
    const width = Math.min(72, Math.max(44, cols - 6));
    const visibleRows = 8;
    const height = visibleRows + 3;
    const bounds = {
      row: Math.max(1, Math.floor((rows - height) / 2)),
      col: Math.max(1, Math.floor((cols - width) / 2)),
      width,
      height,
    };
    let handle: ReturnType<typeof display.pushModal> | null = null;
    const picker = createSshPickerModal({
      bounds, width, maxVisible: visibleRows,
      activeHostName: workingDir.remote?.host.name ?? null,
      theme: currentThemeTokens(),
      onAccept: async (host) => {
        agentSearchModal = null;
        handle?.dispose();
        touchSshHost(host.name);
        startRemoteModeBridge(host, '.');
        finderFeedbackRuntime.onSshConnectStarted({ name: host.name, host: host.host });
        draw();
        try {
          await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
          await refreshRemotePreviewBridge();
          finderFeedbackRuntime.onSshConnectSucceeded(host.name);
        } catch (err) {
          finderFeedbackRuntime.onSshConnectFailed(
            host.name,
            err instanceof Error ? err.message : String(err),
          );
        }
        draw();
      },
      onCancel: () => {
        agentSearchModal = null;
        handle?.dispose();
        draw();
      },
    });
    attachSurfaceToWorkspace(picker.surface, currentWorkspaceOwnerId());
    handle = display.pushModal(picker.surface);
    agentSearchModal = picker;
    draw();
  }

  // FU-1 — register ssh-picker / finder-picker openers as display
  // key bindings. Moves the dashboard hard branches onto the same
  // coordinator dispatch path the rest of the modals / bindings use.
  // Q4 (substrate Occam, 2026-05-03): Korean IME jamo aliases are
  // resolved by the central KEY_ALIAS_TABLE (input-core/key-alias-
  // table.ts) at lookup time — bindings declare latin only.
  display.registerKeyBinding({
    id: 'dashboard:open-ssh-picker',
    key: 'C-k',
    scope: 'global',
    handler: () => openSshPicker(),
    when: () => agentSearchModal === null,
  });
  // Ctrl+P remains the finder opener. Ctrl+T used to alias this
  // (zsh fzf muscle memory) and now dumps unfolded session history
  // into the chat log instead.
  registerDashboardFinderAndHistoryKeys({
    register: (binding) => { display.registerKeyBinding(binding); },
    openFinderPicker,
    onFinderFailed: (message) => finderFeedbackRuntime.onFinderFailed(message),
    getSessionHistory: () => chat.history,
    pushChatLine,
    draw,
    when: () => agentSearchModal === null,
  });
  // Yazi-style Alt+C — directory finder. Mirrors the user's zshrc
  // FZF_ALT_C_COMMAND="fd --type=d --hidden --strip-cwd-prefix
  // --exclude .git". Reuses scanFinder with kind:'dir'; on accept
  // cd's the browser pane to the picked directory.
  display.registerKeyBinding({
    id: 'dashboard:open-directory-picker',
    key: 'M-c',
    scope: 'global',
    handler: () => {
      void openDirectoryPicker().catch((err) => {
        finderFeedbackRuntime.onFinderFailed(err instanceof Error ? err.message : String(err));
        draw();
      });
    },
    when: () => agentSearchModal === null,
  });
  // 2026-05-05 — Alt+M cycles the active LLM provider through the
  // user's rotation pool. Mnemonic: "M = Model". Same path as
  // `/provider next` slash but bound to a key so quick A/B between
  // (e.g.) qwen3.6 local + claude haiku cloud is one keystroke.
  // Empty-pool case shows a hint via toast directing the user to the
  // setup wizard. Fires `draw()` after activation so the dashboard
  // status surfaces the new active provider immediately.
  //
  // The handler body is hoisted into a named helper so both this
  // global keybinding (active from the dashboard input loop) AND
  // the chat-input global-action seam (active while textInput owns
  // the readKey loop · TextInputGlobalAction kind:'provider-rotate-next')
  // dispatch the same logic. Without the chat-input bridge the
  // hotkey silently no-ops while the user is typing — caught by the
  // 한글 IME forensic trace 2026-05-05 · `chat.input.readKey ㅡ` with
  // no follow-up `key.route` event.
  const rotateProviderHotkey = (): void => {
    const { cols: tc, rows: tr } = termSize();
    const cur = getUserConfig();
    const { cfg: next, entry } = rotateNextProvider(cur);
    if (!entry) {
      showToast({
        title: 'provider rotation',
        lines: [
          'rotation pool is empty.',
          'Run /setup → Detect all from env, or',
          '/setup → Local LLM to add models to the pool.',
        ],
        coordinator: display,
        termCols: tc,
        termRows: tr,
        ttlMs: 2500,
      });
      return;
    }
    saveUserConfig(next);
    reloadUserConfig();
    const detail = entry.model
      ? `${entry.provider} / ${entry.model}`
      : entry.provider;
    showToast({
      title: 'provider rotated',
      lines: [`▸ ${rotationEntryLabel(entry)}`, detail],
      coordinator: display,
      termCols: tc,
      termRows: tr,
      ttlMs: 1800,
    });
    draw();
  };
  display.registerKeyBinding({
    id: 'dashboard:provider-rotate-next',
    key: 'M-m',
    scope: 'global',
    handler: rotateProviderHotkey,
    when: () => agentSearchModal === null,
  });
  // Ctrl+n conventionally moves the cursor to the next line, but this TUI does not implement that family of input-line editing keys — confirmed 2026-08-24 in an isolated TUI where Ctrl+k did not cut the line.
  display.registerKeyBinding({
    id: 'dashboard:provider-rotate-next-ctrl-n',
    key: 'C-n',
    scope: 'global',
    handler: rotateProviderHotkey,
    when: () => agentSearchModal === null,
  });
  // Plan-Mode UX P1.4 (2026-05-05) — Shift+Tab toggles plan mode.
  // Read-only planning posture entry (or already-active hint). The
  // actual exit modal still goes through the LLM-invoked
  // ExitPlanMode tool (3-way modal needs the exit-modal deps that
  // aren't trivially reachable from a flat key handler). Behaviour:
  //   - inactive → dispatchEnterPlanMode + chat hint
  //   - active   → "/plan exit" hint
  // Pane context's existing Shift+Tab (backward cycle in
  // pane-common-key-route.ts:54-57) STILL fires for users focused
  // on a pane — coordinator routes global bindings first, but the
  // pane fallback preserves muscle memory for power users until
  // a P1.4b scope-widening PR can redirect it.
  display.registerKeyBinding({
    id: 'dashboard:plan-mode-toggle',
    key: 'S-tab',
    scope: 'global',
    handler: () => {
      void (async () => {
        const { togglePlanModeAction } = await import('./plan-mode-toggle-action.js');
        const r = await togglePlanModeAction();
        for (const line of r.lines) {
          chatLines.push(C.muted(line));
        }
        chatScrollOffset = -1;
        draw();
      })();
    },
    when: () => agentSearchModal === null,
  });

  let debugWorkbenchHandle: PaneMultiModalHandle | null = null;
  let debugWindowHandle: PaneMultiModalHandle | null = null;
  let debugWindowHoverActive = false;
  const setDebugCompanionTargets = (
    targets: readonly DebugWorkbenchPane[],
    next: boolean,
  ): void => {
    for (const target of targets) {
      companionPopupHost.setOpen(target, next);
    }
    syncCompanionPopups();
  };
  const toggleDebugCompanionTargets = (
    targets: readonly DebugWorkbenchPane[],
  ): boolean => {
    const next = targets.some((target) => !companionPopupHost.isOpen(target));
    setDebugCompanionTargets(targets, next);
    return next;
  };
  const demoteLegacyInputFocusForForegroundModal = (
    reason: string,
    preferred: PaneFocus | null = null,
  ): void => {
    const transition = resolveLegacyForegroundModalDemotionTransition({
      workingFocus: workingDir.focus,
      preferred,
      lastWorkingDirPane: focusTransitionState.getLastWorkingDirPane(),
      fallbackPane: firstPaneOfView(workingDir.view),
      reason,
    });
    if (!transition) return;
    setWorkingFocus(transition.nextFocus, transition.reason);
  };
  const openDebugWorkbenchModal = (target?: DebugWorkbenchPane): void => {
    const { rows: tr, cols: tc } = termSize();
    display.workspaceHostAPI().upsertMember('dashboard-main', {
      surfaceId: 'debug-workbench',
      kind: 'popup',
      label: 'Debug Workbench',
      order: 240,
    });
    display.workspaceHostAPI().restoreMember('dashboard-main', 'debug-workbench');
    const preFocus: PaneFocus = workingDir.focus;
    demoteLegacyInputFocusForForegroundModal('debug-workbench-open', preFocus);
    const onDispose = (): void => {
      debugWorkbenchHandle = null;
      syncCompanionPopups();
      draw();
    };
    debugWorkbenchHandle = showLivePaneMultiModal({
      title: 'Debug Workbench',
      layoutMode: '2x2',
      columns: [...buildDebugWorkbenchColumns()],
      initialFocus: target ? debugWorkbenchIndexForTarget(target) : 0,
      widgetHost,
      coordinator: display,
      termCols: tc,
      termRows: tr,
      ttlMs: 0,
      group: 'debug-workbench-modal',
      onDispose,
      chrome: resolveDebugPaneMultiChrome(
        currentThemeTokens(),
        resolveDebugWorkbenchStatus(),
      ),
      onChromeAction: (action) => {
        if (action.controlId === 'minimize') {
          display.workspaceHostAPI().minimizeMember('dashboard-main', 'debug-workbench', { docked: true });
          debugWorkbenchHandle?.dispose();
          draw();
          return;
        }
        if (action.controlId === 'close') {
          display.workspaceHostAPI().removeMember('dashboard-main', 'debug-workbench');
          debugWorkbenchHandle?.dispose();
          draw();
        }
      },
    });
  };
  const openDebugWindow = (): void => {
    const { rows: tr, cols: tc } = termSize();
    display.workspaceHostAPI().upsertMember('dashboard-main', {
      surfaceId: 'debug-window',
      kind: 'popup',
      label: 'Debug Window',
      order: 241,
    });
    display.workspaceHostAPI().restoreMember('dashboard-main', 'debug-window');
    syncDebugLogWidgetState();
    if (debugWindowHandle) {
      debugWindowHandle.dispose();
      debugWindowHandle = null;
    }
    const companionBounds = computeCompanionPopupBounds({
      termCols: tc,
      termRows: tr,
      slotIndex: 0,
      totalCount: 1,
      hasBlockingForeground: !!topBlockingForegroundModal(),
    });
    const width = Math.max(
      companionBounds.width,
      Math.min(Math.max(48, Math.floor(tc * 0.62)), Math.max(48, tc - 8)),
    );
    const height = Math.max(
      companionBounds.height,
      Math.min(Math.max(14, Math.floor(tr * 0.38)), Math.max(14, tr - 6)),
    );
    const bounds = {
      row: Math.max(2, Math.min(companionBounds.row, tr - height - 1)),
      col: Math.max(2, tc - width - 1),
      width,
      height,
    };
    debugWindowHandle = showLivePaneMultiModal({
      id: 'debug-window',
      title: 'Debug Window',
      columns: [{ title: 'debug log', widgetInstanceId: 'wd-debug-log', weight: 1 }],
      widgetHost,
      coordinator: display,
      termCols: tc,
      termRows: tr,
      bounds,
      ttlMs: 0,
      group: 'debug-window',
      interactionClass: 'embedded-overlay',
      windowRole: 'companion',
      chrome: resolveDebugPaneMultiChrome(
        currentThemeTokens(),
        resolveDebugWindowStatus(debug.isMirrorEnabled()),
      ),
      onChromeAction: (action) => {
        if (action.controlId === 'minimize') {
          display.workspaceHostAPI().minimizeMember('dashboard-main', 'debug-window', { docked: true });
          debugWindowHandle?.dispose();
          debugWindowHandle = null;
          debugWindowHoverActive = false;
          draw();
          return;
        }
        if (action.controlId === 'close') {
          display.workspaceHostAPI().removeMember('dashboard-main', 'debug-window');
          debugWindowHandle?.dispose();
          debugWindowHandle = null;
          debugWindowHoverActive = false;
          draw();
        }
      },
      onDispose: () => {
        debugWindowHandle = null;
        debugWindowHoverActive = false;
        draw();
      },
    });
  };
  const toggleDebugWindow = (): boolean => {
    if (debugWindowHandle) {
      display.workspaceHostAPI().removeMember('dashboard-main', 'debug-window');
      debugWindowHandle.dispose();
      debugWindowHandle = null;
      debugWindowHoverActive = false;
      draw();
      return false;
    }
    openDebugWindow();
    draw();
    return true;
  };
  const updateDebugWindowHoverState = (m: DisplayMouseEvent): void => {
    const handle = debugWindowHandle;
    const active = !!handle
      && m.row >= handle.bounds.row
      && m.row < handle.bounds.row + handle.bounds.height
      && m.col >= handle.bounds.col
      && m.col < handle.bounds.col + handle.bounds.width;
    if (active === debugWindowHoverActive) return;
    debugWindowHoverActive = active;
    if (debug.enabled) {
      debug.log('debug-window.hover', active ? 'enter' : 'leave', {
        row: m.row,
        col: m.col,
      });
    }
    draw();
  };
  const toggleDebugWorkbenchModal = (): boolean => {
    if (debugWorkbenchHandle) {
      debugWorkbenchHandle.dispose();
      debugWorkbenchHandle = null;
      draw();
      return false;
    }
    openDebugWorkbenchModal();
    draw();
    return true;
  };
  const promoteCompanionPopup = (key: CompanionPopupKey): void => {
    if (key === 'scratch') {
      setCompanionPopupOpen('scratch', false);
      scratchClosed = false;
      userClosedPanes.delete('scratch');
      setWorkingFocus('scratch', 'companion-promote');
      draw();
      return;
    }
    if (key === 'agents') {
      setCompanionPopupOpen('agents', false);
      const agentsView = viewRegistry.views.find(view => view.id === 'agents');
      if (agentsView) setActiveDashboardView(agentsView);
      else setWorkingFocus('agent-roster', 'companion-promote');
      draw();
      return;
    }
    if (key === 'clipboard') {
      draw();
      return;
    }
    if (key === 'memo') {
      draw();
      return;
    }
    if (key === 'detail') {
      draw();
      return;
    }
    setDebugCompanionTargets(listDebugCompanionKeys(), false);
    openDebugWorkbenchModal(key);
    draw();
  };
  const openBrowserPreviewModal = (): void => {
    const { cols: tc, rows: tr } = termSize();
    const preFocus: PaneFocus = workingDir.focus;
    const focusPlan = resolveLegacyForegroundModalFocusPlan({
      workingFocus: workingDir.focus,
      preferred: preFocus,
      lastWorkingDirPane: focusTransitionState.getLastWorkingDirPane(),
      fallbackPane: firstPaneOfView(workingDir.view),
      reason: 'tablet-modal-open',
    });
    const preModalPaneFocus = focusPlan.anchorPane;
    if (focusPlan.demotionTransition) {
      setWorkingFocus(
        focusPlan.demotionTransition.nextFocus,
        focusPlan.demotionTransition.reason,
      );
    }
    const browserWidgetInstanceId = browserWidgetInstanceIdForView(workingDir.view);
    const liveMode = resolveBrowserPreviewModalLiveMode(process.env.ELANOUS_PANE_MODAL_LIVE);
    const openWindowLocalModelPicker = async (
      action: import('./modals/pane-multi.js').PaneMultiModalChromeAction,
    ): Promise<(() => void) | null> => {
      const entries = getUserConfig().llm.rotation ?? [];
      if (entries.length === 0) {
        chatLines.push(C.warning('  no model rotation configured'));
        chatScrollOffset = -1;
        draw();
        return null;
      }
      const { createModelPickerRecipe } = await import('../mouse-action-recipes.js');
      const handle = createModelPickerRecipe({
        entries,
        placement: {
          anchorStartCol: action.anchorStartCol - 1,
          anchorEndCol: action.anchorEndCol - 1,
          statusRow: action.anchorRow,
          termCols: tc,
          termRows: tr,
        },
        onSwitch: async (entry) => {
          try {
            const label = rotationEntryLabel(entry);
            const { cfg: nextCfg } = jumpToRotationEntry(getUserConfig(), label);
            saveUserConfig(nextCfg);
            reloadUserConfig();
          } catch (e) {
            chatLines.push(C.error(`  model switch failed: ${e instanceof Error ? e.message : String(e)}`));
            chatScrollOffset = -1;
          }
          draw();
        },
        onCancel: () => {
          draw();
        },
        theme: currentThemeTokens(),
        shadow: process.env.ELANOUS_MODAL_SHADOW === 'off'
          ? undefined
          : { theme: currentThemeTokens() },
      });
      handle.surface.onKey = (ev) => handle.handleKey(ev);
      attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
      const modal = display.pushModal(handle.surface);
      return () => {
        try { handle.dispose(); } catch { /* ignore */ }
        try { modal.dispose(); } catch { /* ignore */ }
      };
    };
    void openBrowserPreviewModalHost({
      termCols: tc,
      termRows: tr,
      preFocus,
      preModalPaneFocus,
      tabletMode: effectiveTabletMode(),
      browserWidgetInstanceId,
      liveMode,
      workingDirFocus: workingDir.focus,
      widgetHost,
      workingDirRegistry: browserPaneRegistry,
      previewRegistry: previewPaneRegistry,
      display,
      draw,
      debug,
      currentThemeTokens,
      dispatchSubmit: dispatchSidebarSubmit,
      setWorkingFocus: (nextFocus) => { setWorkingFocus(nextFocus as PaneFocus, 'tablet-modal-close'); },
      setContextMenuCursorResolver: (resolver) => { browserContextMenuCursorResolver = resolver; },
      setCloseRequest: (handler) => { browserPreviewModalCloseRequest = handler; },
      openModelPicker: (action) => openWindowLocalModelPicker(action),
      captureDeferredPane: (pane) => captureDeferredPane(pane),
      fmtEntryColored,
      iconForEntry,
      onContextMenuMouse: (ev) => ctxMenuWire.onMouse(ev),
    });
  };
  const openBrowserOnlyModal = (): void => {
    const { cols: tc, rows: tr } = termSize();
    const liveMode = resolveBrowserPreviewModalLiveMode(process.env.ELANOUS_PANE_MODAL_LIVE);
    void openBrowserPaneModal({
      browserWidgetInstanceId: browserWidgetInstanceIdForView(workingDir.view),
      liveMode,
      browserPaneRegistry,
      widgetHost,
      coordinator: display,
      termCols: tc,
      termRows: tr,
      captureSnapshot: () => captureDeferredPane('browser'),
      theme: currentThemeTokens(),
      fmtEntryColored,
      iconForEntry,
      onSubmit: dispatchSidebarSubmit,
      onDispose: () => { draw(); },
      onCancel: () => { draw(); },
    });
  };
  const openPreviewOnlyModal = (): void => {
    const { cols: tc, rows: tr } = termSize();
    const liveMode = (process.env.ELANOUS_PANE_MODAL_LIVE ?? 'on').toLowerCase() !== 'off';
    void openPreviewPaneModal({
      preview: dockedPreview,
      previewWidgetInstanceId: 'wd-preview',
      liveMode,
      widgetHost,
      coordinator: display,
      termCols: tc,
      termRows: tr,
      captureSnapshot: () => captureDeferredPane('preview'),
      theme: currentThemeTokens(),
      onDispose: () => { draw(); },
      onCancel: () => { draw(); },
    });
  };
  registerDashboardGlobalKeys({
    enableSupplementalGlobalKeys: getUserConfig().dashboard.enableSupplementalGlobalKeys,
    register: (binding) => { display.registerKeyBinding(binding); },
    openSurfaceCatalog: () => openSurfaceCatalogPopup(),
    surfaceCatalogWhen: () => agentSearchModal === null,
  });

  function currentWorkspaceOwnerId(): string {
    return DASHBOARD_MAIN_WORKSPACE_ID;
  }

  function openSurfaceCatalogPopup(): void {
    void openCompactSurfaceCatalogPopup({
      getTargets: () => compactSurfaceRuntime.buildTargets(),
      openTarget: (surfaceId) => compactSurfaceRuntime.openTarget(surfaceId),
      ownerWorkspaceId: DASHBOARD_MAIN_WORKSPACE_ID,
      termSize,
      getTheme: () => currentThemeTokens(),
      pushModalSurface: (surface) => display.pushModal(surface),
      onEmptyTargets: () => {
        pushDebugLine(C.muted('  no surface targets available'));
        chatScrollOffset = -1;
      },
      redraw: draw,
    }).catch(() => {});
  }

  /** N2 — open the shell-runner rollup popup centered on the viewport.
   *  Shared entry point for `/shell rollup` slash + `^B S` chord so
   *  keyboard users can access the same UI mouse users get by clicking
   *  the 🐚 status-bar pill. Anchored-to-pill placement stays in
   *  dashboard-mouse-wiring; this path is explicitly center-placed so
   *  it works with status row unknown. */
  let shellRollupDispose: (() => void) | null = null;
  async function openShellRollupPopup(): Promise<void> {
    const { getShellRegistry } = await import('../shell-runner/registry.js');
    await openDashboardShellRollupPopup({
      getShellRegistry,
      getCurrentDispose: () => shellRollupDispose,
      setCurrentDispose: (dispose) => {
        shellRollupDispose = dispose;
      },
      resolveVwIdByLabel: () => null,
      switchVirtualWindow: () => { throw new Error('Virtual windows are unavailable in the essential dashboard'); },
      ownerWorkspaceId: DASHBOARD_MAIN_WORKSPACE_ID,
      termSize,
      getTheme: () => currentThemeTokens(),
      pushModalSurface: (surface) => display.pushModal(surface),
      onEmpty: () => {
      pushDebugLine(C.muted('  (no shell-runner handles — RunShell(mode:"vw") spawns one)'));
      chatScrollOffset = -1;
      },
      onWarning: (message) => {
        pushDebugLine(C.warning(`  ${message}`));
        chatScrollOffset = -1;
      },
      redraw: draw,
    });
  }

  // Track which task ID the cursor is currently LOCKED onto across
  // draws — prevents the cursor from visually sliding when the roster
  // gets re-sorted with a new entry. Empty string = no lock.
  let agentCursorLockedId = '';
  // "User dismissed the agents companion" — while true, new agent
  // batches do not auto-open the popup. Cleared when the registry
  // drains fully so a fresh batch can reopen it.
  let agentsViewDismissed = false;
  // P4.1: roster filter + sort state. Flat enum (not a Set) so
  // cycling is predictable. 'default' sort preserves startedAt order
  // that syncTasks returns.
  type AgentRosterFilter = 'all' | 'running' | 'errored';
  type AgentRosterSort = 'default' | 'elapsed' | 'tools' | 'name' | 'status';
  let agentRosterFilter: AgentRosterFilter = 'all';
  let agentRosterSort: AgentRosterSort = 'default';
  // P5.2/P5.3: per-agent tool-call timeline. Populated by a subscriber
  // wired to globalAgentRegistry.onToolCall — only active when debug
  // level is 'detail'. Each agent's buffer is capped at 50 entries
  // (start+result pairs) so a long-running agent doesn't retain MB
  // of tool output. Cleared when the registry prunes that agent.
  const TOOLCALL_BUFFER_CAP = 50;
  const agentToolCallBuffer = new Map<string, AgentToolCallEvent[]>();
  let agentToolCallSub: { dispose(): void } | null = null;
  /** P5.3: render a compact timeline view from the per-agent tool-
   *  call ring buffer. Pairs start + result events by callIdx so
   *  each logical call gets one row with duration + arg preview.
   *  Rendered as preformatted text (consumed by the wd-agent-log
   *  widget when detail level is on). */
  const renderAgentToolTimeline = (events: AgentToolCallEvent[]): string => {
    // Build a map of callIdx → { start, result } pairs. Start phase
    // lands first (chronological); result phase replaces a field
    // when it arrives. Entries missing result are still rendered so
    // in-flight tool calls are visible.
    const byIdx = new Map<number, { start?: AgentToolCallEvent; result?: AgentToolCallEvent }>();
    for (const ev of events) {
      const entry = byIdx.get(ev.callIdx) ?? {};
      if (ev.phase === 'start') entry.start = ev;
      else entry.result = ev;
      byIdx.set(ev.callIdx, entry);
    }
    const idxs = [...byIdx.keys()].sort((a, b) => a - b);
    const rows: string[] = [];
    for (const idx of idxs) {
      const pair = byIdx.get(idx)!;
      const head = pair.start ?? pair.result;
      if (!head) continue;
      const when = new Date(head.ts);
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      const ss = String(when.getSeconds()).padStart(2, '0');
      const dur = pair.result?.durationMs !== undefined
        ? `${pair.result.durationMs}ms`
        : pair.start ? '…' : '?';
      // One-line arg preview. JSON-ish; truncate hard so a 1MB
      // body doesn't wreck layout.
      let argsPreview: string;
      try {
        argsPreview = JSON.stringify(head.args);
      } catch {
        argsPreview = '(unserializable)';
      }
      if (argsPreview.length > 80) argsPreview = argsPreview.slice(0, 80) + '…';
      rows.push(`[${hh}:${mm}:${ss}]  ${head.tool.padEnd(9)} ${dur.padStart(7)}  ${argsPreview}`);
      if (pair.result && pair.result.result) {
        const r = pair.result.result.replace(/\n/g, ' ⏎ ');
        const clipped = r.length > 140 ? r.slice(0, 140) + '…' : r;
        rows.push(`            \u21B3 ${clipped}`);
      }
    }
    return rows.join('\n');
  };

  const ensureToolCallSubscription = (): void => {
    if (debug.isDetailEnabled()) {
      if (!agentToolCallSub) {
        agentToolCallSub = globalAgentRegistry.onToolCall((ev) => {
          const buf = agentToolCallBuffer.get(ev.agentId) ?? [];
          buf.push(ev);
          if (buf.length > TOOLCALL_BUFFER_CAP) buf.splice(0, buf.length - TOOLCALL_BUFFER_CAP);
          agentToolCallBuffer.set(ev.agentId, buf);
        });
      }
    } else if (agentToolCallSub) {
      agentToolCallSub.dispose();
      agentToolCallSub = null;
      agentToolCallBuffer.clear();
    }
  };
  ensureToolCallSubscription();
  // In-process clipboard history poller. No-op stub on non-macOS,
  // ticks every ~1.5s on Darwin and stores up to 50 unique text
  // snapshots. Stopped during dashboard teardown to avoid leaking
  // intervals if the host re-enters showDashboard.
  const clipHistory: ClipboardHistory = startClipboardHistory({});
  process.once('beforeExit', () => { clipHistory.stop(); });
  // Re-render whenever the poller picks up a new entry — only when
  // we're actually showing the history viewer, otherwise the side-
  // effect of every clipboard change blowing away an in-flight
  // image/file preview would be jarring.
  clipHistory.onChange(() => {
    if (companionPopupHost.isActive('clipboard')) {
      requestDashboardRender('clipboard');
    }
  });
  const openClipboardCompanion = async (): Promise<void> => {
    await clipboardCompanionRuntime.open();
  };
  const closeClipboardCompanion = (): void => {
    clipboardCompanionRuntime.close();
  };
  const copyClipboardHistoryEntryAt = async (idx: number): Promise<void> => {
    await clipboardCompanionRuntime.copyEntryAt(clipHistory.entries, idx);
    chatScrollOffset = -1;
  };
  const syncClipboardCursorFromWidget = (): void => {
    const inst = widgetHost.get('wd-clipboard') as { state?: { clipCursor?: number } } | null;
    const next = clipboardHistoryRuntime.normalizeCursor(inst?.state?.clipCursor);
    if (next != null) clipCursor = next;
  };
  const seedMemoWidget = (lines: string[] = ['']): void => {
    memoWidgetRuntime.seed(widgetHost.get('wd-memo') as any, lines);
  };
  const openMemoCompanion = (): void => {
    seedMemoWidget(['']);
    setCompanionPopupOpen('memo', true);
  };
  const closeMemoCompanion = (): void => {
    setCompanionPopupOpen('memo', false);
  };
  const readMemoWidgetLines = (): string[] => {
    return memoWidgetRuntime.readLines(widgetHost.get('wd-memo') as any);
  };
  const publishMemoLines = (lines: string[]): void => {
    scratchTitle = 'Memo';
    scratchLines = [...lines];
    scratchOffset = 0;
    publishScratchSurface('dashboard:memo', 'preview', scratchTitle, scratchLines);
  };
  const memoCompanionRuntime = createDashboardMemoCompanionRuntime({
    readLines: readMemoWidgetLines,
    resetEditor: () => { seedMemoWidget(['']); },
    close: closeMemoCompanion,
    publishSaved: publishMemoLines,
    pushSavedLine: (lineCount) => { chatLines.push(companionFeedbackRuntime.memoSavedLine(lineCount)); },
    pushDiscardedLine: () => { chatLines.push(companionFeedbackRuntime.memoDiscardedLine()); },
    pushCancelledLine: () => { chatLines.push(companionFeedbackRuntime.memoCancelledLine()); },
  });
  const commitMemoCompanion = (): void => {
    memoCompanionRuntime.commit();
    chatScrollOffset = -1;
  };
  const cancelMemoCompanion = (): void => {
    memoCompanionRuntime.cancel();
    chatScrollOffset = -1;
  };
  // Repaint hook the active textInput populates so external draws
  // (scratchpad refresh, async chafa render finishing) can ask the
  // prompt to re-paint itself afterwards. While input is idle this
  // stays as a no-op so calls during pane mode are harmless.
  const promptCtl: {
    repaint: () => void;
    insertAtCursor?: (text: string) => void;
    submit?: (request?: string | TextInputExternalSubmitRequest) => void;
  } = { repaint: () => {} };
  repaintPromptAfterRender = () => {
    if (shouldSuppressDashboardBottomArea()) {
      display.setCursor(null);
      return;
    }
    promptCtl.repaint();
  };
  // V3 note: repaintPromptAfterRender receives {force} from the
  // coordinator hook but promptCtl.repaint() has no diff state of its
  // own — the main render's force=true already did eraseDown before
  // this runs, so prompt rows are clean. Forwarding force is a no-op
  // today but the signature is there for future direct-paint callers.

  // Terminal resize wiring — CAPABILITIES-display.md §1.3 defines the
  // coordinator entry triplet as "readKey / mouse / resize" but the
  // resize hook was missing, so a bare window resize produced a stale
  // paint (ghost input row, dead zone below). Forward every stdout
  // resize to a forced dashboard redraw plus the prompt repaint hook;
  // the hook is a no-op while input is idle so the call is always
  // safe. Dispose on process exit to keep the listener set clean.
  const disposeResizeListener = installResizeListener({ draw: (opts) => draw(opts), promptCtl });
  process.on('exit', disposeResizeListener);

  const publishScratchSurface = (
    source: string,
    mode: ScratchMode,
    title: string,
    lines: string[],
  ): void => {
    dashboardDisplay.publish({
      type: 'setScratch',
      source,
      mode,
      title,
      lines,
    });
  };
  const detailViewerRuntime = createDashboardDetailViewerRuntime({
    setOpen: (open) => { setCompanionPopupOpen('detail', open); },
    requestRender: () => { requestDashboardRender('detail'); },
  });
  const companionWidgetRuntime = createDashboardCompanionWidgetRuntime();
  const clipboardHistoryRuntime = createDashboardClipboardHistoryRuntime();
  const memoWidgetRuntime = createDashboardMemoWidgetRuntime();
  const logWidgetRuntime = createDashboardLogWidgetRuntime();
  const logRenderRuntime = createDashboardLogRenderRuntime({
    syncLogWidgetState,
    widgetHost,
    theme: () => currentThemeTokens(),
  });
  const agentRosterRuntime = createDashboardAgentRosterRuntime({
    syncTasks: (tasks) => agentSurfaceStore.syncTasks(tasks),
    syncTasksWithChanges: (tasks) => agentSurfaceStore.syncTasksWithChanges(tasks),
    emitChange: (event) => { displayEvents.emit(event); },
  });
  const agentRosterEventPump = createAgentRosterEventPump({
    runtime: agentRosterRuntime,
    listTasks: () => globalAgentRegistry.list(),
    hasSubscribers: () => displayEvents.hasSubscribers('agent:update'),
  });
  // Wave P2 (presentation) · A1-1 — inline agent progress block. The
  // roster widget already lives off `agent:update`; we attach a second
  // subscriber that mirrors the fleet into a chat-surface block so
  // operators see sub-agent activity without opening the widget.
  const agentProgressRuntime = createAgentProgressRuntime({
    chatLines,
    pinChatTail,
    draw,
    // Wave P4b-2 — theme tokens wire. The progress block uses the
    // active theme's muted/accent/success/error so different status
    // glyphs (●○ running / ✓ done / ✗ error) light up coherent with
    // the rest of the UI instead of bare ANSI defaults.
    colors: {
      muted: C.muted,
      running: C.accent,
      done: C.success,
      error: C.warning,
    },
  });
  displayEvents.subscribe('agent:update', (event) => {
    agentProgressRuntime.onAgentUpdate(event as DashboardAgentUpdateEvent);
  });
  // Wave P2 (presentation) · A3-1 — typed background pill. shell +
  // agent wire to lifecycle events for real-time refresh; workflow +
  // scheduler are polled at refresh time because their runners don't
  // expose a global lifecycle event yet (PLAN follow-up).
  const { getShellRegistry: getShellRegistryForPill } = await import('../shell-runner/registry.js');
  const { globalWorkflowRunner: globalWorkflowRunnerForPill } = await import('../plugin-workflows/global-runner.js');
  const shellRegistryForPill = getShellRegistryForPill();
  // Wave P4a-2 — eager-load attention aggregator + plan-mode/state
  // accessors so the pill's `options()` callback (sync) can compose
  // the AttentionFlags without any per-call dynamic import latency.
  const { computeBackgroundAttention: computeBackgroundAttentionForPill } =
    await import('./background-attention.js');
  const { getPlanModeState: getPlanModeStateForPill } =
    await import('../plan-mode/session.js');
  const { getPlanState: getPlanStateForPill } =
    await import('../code-edit/plan-tool.js');
  const backgroundPillRuntime = createBackgroundPillRuntime({
    chatLines,
    pinChatTail,
    draw,
    countShell: () => shellRegistryForPill.list({ status: 'running' }).length,
    countAgent: () => globalAgentRegistry.list().filter((a) => a.state === 'running').length,
    countWorkflow: () => globalWorkflowRunnerForPill().listRuns().filter((r) => r.status === 'running').length,
    options: () => {
      // Attention aggregator — driven by the same four sources plus
      // plan-mode state.
      // Wave P4c — askUserActive trigger now wired to the
      // approvalModalRouter singleton.
      // Wave E (presentation) — only the AskUserQuestion modal flips
      // needsInput now; the planExit modal is reflected by the
      // separate planReady signal (plan-mode active + stepCount > 0)
      // and the legacy 'approval' kind (terminal inject) leaves
      // attention untouched. Without this kind discrimination, the
      // pill flashed cyan for every open modal — even ExitPlanMode,
      // whose intent is yellow planReady.
      const flags = computeBackgroundAttentionForPill({
        agents: agentSurfaceStore.list(),
        shells: shellRegistryForPill.list().map((h) => ({
          status: h.status,
          exitCode: (h as { exitCode?: number | null }).exitCode ?? null,
        })),
        workflows: globalWorkflowRunnerForPill().listRuns(),
        planMode: {
          active: getPlanModeStateForPill().active,
          stepCount: getPlanStateForPill().steps.length,
        },
        askUserActive: approvalModalRouter.currentKind() === 'askUser',
      });
      // Wave P4b-2 + P4c — typed attention. Pass per-trigger booleans
      // so the pill picks the highest-priority color (error >
      // needsInput > planReady) instead of a single accent flag.
      return {
        attention: {
          needsInput: flags.needsInput,
          planReady: flags.planReady,
          hasError: flags.hasError,
        },
        colors: {
          muted: C.muted,
          accent: C.accent,
          needsInput: C.info,
          planReady: C.warning,
          hasError: C.error,
        },
      };
    },
  });
  // Wave C (presentation) — wire the pill row + click action into the
  // log-click runtime. The forward-declared refs at buildLogClickDeps
  // close over these so a click on the pill row opens the same /bg
  // popup the slash command produces.
  pillRowGetterForClick = () => backgroundPillRuntime.getPillRow();
  onPillClickForClick = () => {
    const term = termSize();
    const width = Math.min(100, Math.max(40, term.cols - 6));
    const height = Math.min(Math.max(14, term.rows - 4), term.rows - 2);
    const bounds = {
      row: Math.max(1, Math.floor((term.rows - height) / 2)),
      col: Math.max(1, Math.floor((term.cols - width) / 2)),
      width,
      height,
    };
    const opened = openWidgetModalPopup(widgetHost, {
      id: `background-tasks-popup:${Date.now().toString(36)}`,
      bounds,
      widgetInstanceId: 'wd-background-tasks',
      title: 'Background tasks',
    });
    if (!opened) return;
    const lifecycle = display.modalLifecycleAPI().push(
      'background-tasks-popup',
      { idempotencyKey: 'background-tasks-popup' },
      opened.surface,
    );
    if (!lifecycle) {
      try { opened.dispose(); } catch { /* ignore */ }
      return;
    }
    chatScrollOffset = -1;
    draw();
  };
  // Wave P4a-2 — manager-modal widget. The widget mirrors the same
  // four sources as a unified list, registered + spawned here.
  // Layout attachment is up to the caller (popup, sidebar tab, etc.)
  // so this PR stays disjoint from view-system shared files.
  const { default: backgroundTasksWidget } =
    await import('../widgets/background-tasks.js');
  widgetHost.register(backgroundTasksWidget, 'builtin', 'src/widgets/background-tasks.ts');
  // Wave P4a-3 — host dispatcher decoded from `${source}:${nativeId}`.
  // Each source already has a public abort/kill/pause; we route the
  // widget's keypress to the matching call.
  const dispatchBackgroundAction = async (
    rowId: string,
    action: 'abort',
    source: 'agent' | 'shell' | 'workflow',
  ): Promise<void> => {
    const native = rowId.slice(rowId.indexOf(':') + 1);
    try {
      // Surface-unification v2.2 V2.2-5 (2026-05-11) — 'scheduler'
      // source 와 'pause' action 모두 retire. agent/shell/workflow 만
      // 'abort' 액션 지원.
      if (source === 'shell') {
        // ShellRegistry has no top-level kill — find the handle and
        // call its instance method.
        const h = shellRegistryForPill.list().find((x) => x.id === native);
        h?.kill('SIGTERM');
      }
      else if (source === 'agent') globalAgentRegistry.abort(native);
      else if (source === 'workflow') globalWorkflowRunnerForPill().abort(native, 'user-cancelled');
    } catch {
      // Swallow — failed dispatch is logged by each source's own
      // path; UI stays usable.
    }
    // Force a refresh so the row drops out (no-op when the source
    // already emitted its lifecycle event).
    backgroundPillRuntime.refresh();
    refreshBackgroundTasksWidget();
  };
  widgetHost.spawn({
    type: 'background-tasks',
    id: 'wd-background-tasks',
    character: 'Background',
    config: {
      rows: [],
      onAction: (rowId: string, action: 'abort', source: 'agent' | 'shell' | 'workflow') => {
        void dispatchBackgroundAction(rowId, action, source);
      },
    },
  });
  // Re-poll the four sources and surface them as widget rows so the
  // manager modal can show whatever is live right now. Cheap reads.
  const refreshBackgroundTasksWidget = (): void => {
    const inst = widgetHost.get('wd-background-tasks');
    if (!inst) return;
    const rows: import('../widgets/background-tasks.js').BackgroundTaskRow[] = [];
    for (const a of agentSurfaceStore.list()) {
      if (a.status === 'done' || a.status === 'cancelled') continue;
      rows.push({
        id: `agent:${a.id}`,
        source: 'agent',
        label: a.name,
        status: a.status === 'queued' ? 'queued'
          : a.status === 'error' ? 'error'
          : 'running',
        elapsedMs: a.elapsedMs,
        abortable: a.status === 'running' || a.status === 'queued',
      });
    }
    for (const s of shellRegistryForPill.list({ status: 'running' })) {
      // ShellHandle exposes only id/mode/status/terminalId — there's
      // no command / startedAt slot at the handle layer. Show the
      // shell id as the label; elapsed left undefined (the row's
      // status glyph + source already convey 'currently running').
      rows.push({
        id: `shell:${s.id}`,
        source: 'shell',
        label: s.id,
        status: 'running',
        abortable: true,
      });
    }
    for (const w of globalWorkflowRunnerForPill().listRuns()) {
      if (w.status === 'done') continue;
      rows.push({
        id: `workflow:${w.runId}`,
        source: 'workflow',
        label: w.workflowId,
        status: w.status === 'aborted' ? 'aborted'
          : w.status === 'error' ? 'error'
          : 'running',
        detail: `step ${w.currentStep + 1}/${w.steps.length}`,
        elapsedMs: w.startedAt ? Date.now() - w.startedAt : undefined,
        abortable: w.status === 'running',
      });
    }
    // Surface-unification v2.2 V2.2-5 (2026-05-11) — scheduler row 추가
    // retire (scheduler view 폐기 · 동일 데이터는 workflow row 가 cover).
    inst.state = { ...(inst.state as { rows: unknown[]; cursor: number }), rows };
  };
  // Wave P4b-2 — ephemeral popup lifecycle. plan-board popup auto-
  // closes when the plan goes empty; bg-tasks popup auto-closes when
  // every source count reaches zero. Both subscribers also refresh
  // the chat surface so the user's view stays consistent.
  const closePlanBoardPopupIfIdle = (): void => {
    activeWidgetPopupHandles.get('plan-board-popup')?.dispose();
  };
  const closeBgTasksPopupIfIdle = (): void => {
    const totalActive = shellRegistryForPill.list({ status: 'running' }).length
      + globalAgentRegistry.list().filter((a) => a.state === 'running').length
      + globalWorkflowRunnerForPill().listRuns().filter((r) => r.status === 'running').length;
    if (totalActive === 0) {
      activeWidgetPopupHandles.get('background-tasks-popup')?.dispose();
    }
  };
  // Plan listener — close popup when steps drop to zero.
  {
    const { subscribePlanUpdate: subscribePlanForPopup } =
      await import('../code-edit/plan-tool.js');
    subscribePlanForPopup((state) => {
      if (state.steps.length === 0) closePlanBoardPopupIfIdle();
    });
  }
  shellRegistryForPill.subscribe(() => {
    backgroundPillRuntime.refresh();
    refreshBackgroundTasksWidget();
    closeBgTasksPopupIfIdle();
  });
  displayEvents.subscribe('agent:update', () => {
    backgroundPillRuntime.refresh();
    refreshBackgroundTasksWidget();
    closeBgTasksPopupIfIdle();
  });
  // Wave P4a-1 — workflow + scheduler real-time event bridge.
  // Workflow runner emits run-start / step-complete / run-end through
  // its `subscribe` API; we relay each event onto displayEvents and
  // also refresh the background pill so the active count reflects
  // the runner's actual state instead of a polled snapshot.
  globalWorkflowRunnerForPill().subscribe((event) => {
    const state = event.state;
    displayEvents.emit({
      type: 'workflow:update',
      runId: state.runId,
      workflowId: state.workflowId,
      status: state.status === 'aborted' ? 'aborted'
        : state.status === 'error' ? 'error'
        : state.status === 'done' ? 'done'
        : 'running',
      payload: { kind: event.type, currentStep: state.currentStep, steps: state.steps.length },
    });
    backgroundPillRuntime.refresh();
  });
  // Surface-unification v2.2 V2.2-5 (2026-05-11) — scheduler store
  // subscribe + scheduler:update display event bridge retired
  // (scheduler view 폐기 · workflow run subscriber 가 이미 동일 신호 fan).
  backgroundPillRuntime.refresh();
  const agentWidgetRuntime = createDashboardAgentWidgetRuntime();
  const debugWidgetRuntime = createDashboardDebugWidgetRuntime();
  const previewWidgetRuntime = createDashboardPreviewWidgetRuntime();
  const debugEventRuntime = createDashboardDebugEventRuntime();
  const debugSurfaceRuntime = createDashboardDebugSurfaceRuntime({
    renderStack: renderDebugStack,
    renderPromptInjectionDebug,
  });
  const previewSurfaceRuntime = createDashboardPreviewSurfaceRuntime({
    formatPreviewSourceLabel,
  });
  // Surface-unification v2.2 V2.2-5 Part 2 — scheduler widget runtime
  // 생성 폐기 (scheduler view 자체 retire).
  const browserMirrorRuntime = createDashboardBrowserMirrorRuntime();
  const browserWidgetRuntime = createDashboardBrowserWidgetRuntime({
    fmtEntryColored,
    iconForEntry,
    encodeSubmitText: (entry) => {
      if (entry.name === '..') return encodeBrowserScopedSubmitText('wd-cd', 'wd-browser', entry.absPath);
      return entry.isDir
        ? encodeBrowserScopedSubmitText('folder-attach', 'wd-browser', entry.absPath)
        : encodeBrowserScopedSubmitText('file-attach', 'wd-browser', entry.absPath);
    },
  });
  const skillWidgetRuntime = createDashboardSkillWidgetRuntime();
  const clipboardCompanionRuntime = createDashboardClipboardCompanionRuntime({
    resetCursor: () => { clipCursor = 0; },
    pokeNow: () => clipHistory.pokeNow(),
    setOpen: (open) => { setCompanionPopupOpen('clipboard', open); },
    writeClipboardText: (text) => writeClipboard(text),
    pushCopiedLine: (charCount) => { chatLines.push(companionFeedbackRuntime.clipboardCopiedLine(charCount)); },
    pushCopyFailedLine: () => { chatLines.push(companionFeedbackRuntime.clipboardWriteFailedLine()); },
  });
  const setDetailViewer = (title: string, lines: string[]): void => {
    detailViewerRuntime.set(title, lines);
  };
  const clearDetailViewer = (): void => {
    detailViewerRuntime.clear();
  };
  const closeDetailCompanion = (): void => {
    detailViewerRuntime.close();
  };

  /** Replace scratchpad contents and trigger a redraw through the
   *  display coordinator. The coordinator coalesces this with any
   *  plugin/widget updates and repaints the prompt after the frame. */
  const setScratch = (title: string, lines: string[]): void => {
    scratchTitle = title;
    scratchLines = [...lines];
    scratchOffset = 0;
    publishScratchSurface('dashboard:scratch', 'preview', title, scratchLines);
  };

  // ── Execute sync inline (output to log pane) ──
  const runSyncInline = async (
    sk: string[] = [...sync.selected[0]!],
    sv: string[] = [...sync.selected[1]!],
    vc: string[] = [...sync.selected[2]!],
    modeId: string = SYNC_MODES[sync.modeIdx]!.id,
  ) => {
    const syncMode = SYNC_MODES.find(m => m.id === modeId) ?? SYNC_MODES[2]!;
    saveLastSelection({ skills: sk, servers: sv, services: vc, mode: syncMode.id, ts: new Date().toISOString() });

    const syncActive = pluginHost.active();
    if (syncActive) (syncActive.state as any).busy = true;
    chatLines.push('');
    chatLines.push(toolHeader(
      'Sync',
      `${sk.length} skills ${FIGURES.PLAY} ${sv.length} servers \u00D7 ${vc.length} services`,
      'running',
    ) + '  ' + syncMode.color(`[${syncMode.label}]`));
    chatScrollOffset = -1;
    draw();

    // Capture console.log output into log pane
    const origLog = console.log;
    console.log = (...args: any[]) => {
      chatLines.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' ').replace(/^\s{2,}/, ' '));
      chatScrollOffset = -1;
      draw();
    };

    // 'diff' is diverted to runDiffInline before runSyncInline is called
    // (dashboard:4511), so it never reaches executeSync — this guard makes
    // that invariant explicit and narrows the id to SyncMode.
    if (syncMode.id === 'diff') return;
    try {
      const entries = await executeSync({
        servers: sv,
        services: vc,
        skills: sk,
        mode: syncMode.id,
      });

      const synced = entries.filter(e => e.status === 'synced').length;
      const failed = entries.filter(e => e.status === 'failed').length;
      const skipped = entries.filter(e => e.status === 'unchanged').length;

      // Claude Code-style result summary
      chatLines.push('');
      if (failed > 0) {
        chatLines.push(toolHeader('Sync', `${synced + failed + skipped} targets`, 'error'));
        chatLines.push(toolResult(
          errorLine(`${failed} failed`)
          + (synced ? '  ' + successLine(`${synced} synced`) : '')
          + (skipped ? '  ' + C.muted(`${skipped} unchanged`) : ''),
        ));
      } else {
        chatLines.push(toolHeader('Sync', `${synced + skipped} targets`, 'success'));
        chatLines.push(toolResult(
          successLine(`${synced} synced`)
          + (skipped ? '  ' + C.muted(`${skipped} unchanged`) : ''),
        ));
      }
    } catch (err: any) {
      chatLines.push(toolHeader('Sync', 'error', 'error'));
      chatLines.push(toolResult(errorLine(err.message || String(err))));
    } finally {
      console.log = origLog;
      if (syncActive) (syncActive.state as any).busy = false;
    }

    // Stay in sync mode after run — user can pick new targets. Esc/q to leave.
    // Plugin state.busy was set at entry + cleared in finally; D2 is now
    // guarded through the plugin's busy flag, not a dashboard enum.
    sync.selected[0]!.clear();
    sync.selected[1]!.clear();
    // Keep services pre-selected (matches plugin initialState).
    sync.cursors[0] = sync.cursors[1] = sync.cursors[2] = 0;
    sync.offsets[0] = sync.offsets[1] = sync.offsets[2] = 0;
    sync.focus = 0;
    syncActions.markListsDirty();  // keep plugin lists in sync with disk
    chatLines.push(C.muted('(sync mode — pick new targets, Esc/q to exit)'));
    chatScrollOffset = -1;
    draw();
  };

  // ── Diff mode: inspect differences without syncing ──
  const runDiffInline = createRunDiffInline({
    chatLines,
    sync,
    pluginHost,
    scrollChatToLatestAndDraw: () => {
      chatScrollOffset = -1;
      draw();
    },
    saveLastSelection,
    computeDiff,
    summarizeDiff,
    isAnalyzerAvailable,
  });

  try {
    // Populate the working-dir preview on first frame so View 2 doesn't
    // open with a blank right pane. cursor=0 → the `..` sentinel, which
    // refreshWorkingDirPreview deliberately leaves empty (no point
    // listing the parent), so this only kicks in once the user moves.
    // ⛔⭐ 「이 try 에 «들어오기는» 하나」 — 앞뒤 두 점으로 예외 위치를 가른다(`OBS-T127`).
    //   🚨 `setKeyTracer` 설치문이 이 try 안에 있는데 그 «직전» 관측이 0건이었다.
    //     ⇒ 「설치문이 안 돈다」와 「이 try 에 아예 안 들어온다」를 가를 자가 없었다.
    try { debug.log('dashboard.keytracer', 'try-entered', {}); } catch { /* fail-soft */ }
    refreshWorkingDirPreview();

    // ── Keystroke tracer (Phase 18) ─────────────────────────────
    // Every dispatched Key (main loop, streaming-window listener,
    // input-mode loop) is emitted to debug.log with a snapshot of the
    // context that would determine routing: focused pane, active view,
    // chord state, scratch mode, streaming flag, etc. Helps diagnose
    // "I pressed X but nothing happened" reports — the log makes
    // crystal clear whether the key was consumed, ignored, or simply
    // dropped between readKey calls. Cost is one debug.log per key;
    // gated by debug._fileEnabled || debug._mirrorEnabled, so turning
    // debug off via `/debug file off` eliminates overhead.
    // ⛔⭐⭐ **「설치 자리가 도는가」를 값으로**(2026-08-19 · `OBS-T125` 다음 칸).
    //   🚨 `key.press` 가 자식 TUI 에서 0건인데 다른 debug 로그는 «남는다». 그래서 후보가 둘이었다:
    //     ⓐ env 가 자식까지 안 간다   ⓑ ***이 설치 자리가 안 돈다***
    //   ⇒ 이 한 줄이 ⓑ 를 «값으로» 지운다. (⭐ `OBS-T124` 에서 쓴 것과 «같은 형태» — 그때도 둘을 갈랐다)
    // ⛔ 행동을 안 바꾼다. `keyTraceEnabled` 를 «같이» 실어 「설치됐는데 꺼져 있다」도 갈린다.
    try {
      debug.log('dashboard.keytracer', 'installed', {
        debugEnabled: debug.enabled,
        keyTraceEnabled: debug.isKeyTraceEnabled(),
        level: debug.level(),
      });
    } catch { /* fail-soft */ }
    setKeyTracer((key, source) => {
      // Early return when no sink is active so we don't allocate the
      // snapshot object 100+ times/sec during fast typing. debug.log
      // itself short-circuits too, but we build + stringify the
      // snapshot BEFORE log() — that's the cost we're dodging.
      if (!debug.enabled) return;
      // U-0 · migration site #2 · derived `viewMode` field joins the
      // flag-driven fields (streaming / chord / plugin). Debug consumers
      // that previously had to combine three flags to recognize
      // "streaming-but-chord-armed" now read `viewMode === 'chord-armed'`
      // and get the priority-resolved answer for free.
      const snapshot: Record<string, unknown> = {
        source,
        key: key.name,
        ctrl: key.ctrl,
        shift: key.shift,
        focus: workingDir.focus,
        view: workingDir.view,
        plugin: pluginHost.active()?.name ?? null,
        scratchMode,
        chatOnly: chatOnlyMode,
        scrollOff: chatScrollOffset,
        streaming: streamingInFlight,
        userScrolled: userScrolledDuringStream,
        inputLines: dashboardState.getInputLines(),
        chord: isChordArmed(chord),
        viewMode: currentViewMode.kind,
      };
      if (key.mouse) {
        // M1 — tracer payload must include row/col so post-hoc diff
        // against statusRow / pane bounds is possible. Without these,
        // the "clicked but nothing happened" reports are impossible
        // to triage from log/debug-*.log alone.
        snapshot['mouse'] = key.mouse.type;
        snapshot['mouseRow'] = key.mouse.row;
        snapshot['mouseCol'] = key.mouse.col;
      }
      if (debug.isDiagEnabled() && key.raw) {
        snapshot['rawHex'] = [...Buffer.from(key.raw)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      }
      const label = `${key.ctrl ? 'C-' : ''}${key.shift ? 'S-' : ''}${key.name || '(empty)'}`;
      debug.log('key.press', label, snapshot);
    });

    // P5.5: periodic prune of finished agents. globalAgentRegistry
    // held onto completed tasks indefinitely because nothing called
    // prune() — the registry's 5-minute default policy was dead
    // letter. A 30s timer with .unref() runs it in the background
    // without holding the event loop open. Guarded by a clean-up
    // handler so /quit doesn't leave a dangling interval.
    const agentPruneTimer = setInterval(() => {
      const removed = globalAgentRegistry.prune();
      if (removed > 0 && debug.enabled) {
        debug.log('agent.registry', 'prune', { removed });
      }
    }, 30_000);
    if (typeof (agentPruneTimer as { unref?: () => void }).unref === 'function') {
      (agentPruneTimer as unknown as { unref: () => void }).unref();
    }
    const clearAgentPruneTimer = (): void => { clearInterval(agentPruneTimer); };
    process.once('beforeExit', clearAgentPruneTimer);

    // T3-B1: pulse ticker. Fires draw() every 500ms so the
    // agent-activity HUD glyph alternates while sub-agents are
    // running — coordinator coalesces redundant draws so this is
    // cheap when nothing actually changed. No-op when no active
    // agents (segment is already hidden). .unref() so the ticker
    // doesn't keep the event loop alive past /quit.
    const pulseTicker = setInterval(() => {
      if (globalAgentRegistry.list().some(a => a.state === 'running')) {
        try { draw(); } catch { /* TUI torn down */ }
      }
    }, PULSE_HALF_PERIOD_MS);
    if (typeof (pulseTicker as { unref?: () => void }).unref === 'function') {
      (pulseTicker as unknown as { unref: () => void }).unref();
    }
    process.once('beforeExit', () => clearInterval(pulseTicker));
    // A task that finishes while the dashboard is idle has nobody to redraw
    // it: the pulse ticker above only draws while something is still running,
    // and the roster sync that emits `agent:update` (progress block, background
    // pill, status-line agents segment) runs inside draw(). Redraw once on every
    // terminal transition so the last completion is not left painted as running.
    const agentDoneRedraw = globalAgentRegistry.onTaskDone(() => {
      try { draw(); } catch { /* TUI torn down */ }
    });
    process.once('beforeExit', () => agentDoneRedraw.dispose());

    // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M5 — 1Hz ticker
    // that pushes the current token-gauge + variant values onto the
    // HUD. setSegment dedupes deep-equal writes so this is idle when
    // metrics haven't changed (no M3 mirror POST traffic). The ticker
    // fires regardless of agent activity so the PWA gauge keeps in
    // sync even on plain chat turns.
    const chatHudTicker = setInterval(() => {
      try { refreshChatHudSegments(); } catch { /* swallow */ }
    }, 1000);
    if (typeof (chatHudTicker as { unref?: () => void }).unref === 'function') {
      (chatHudTicker as unknown as { unref: () => void }).unref();
    }
    process.once('beforeExit', () => clearInterval(chatHudTicker));

    // ── Single entry point for "open an interactive terminal popup" ─
    //
    // Every popup terminal — plain shell from Ctrl+Shift+T, /claude,
    // /codex, future agents — is the SAME widget with the SAME
    // keybindings (Ctrl+G close, Alt+W close, typed exit close,
    // [─] minimize click, [✕] close click, ESC forward to PTY,
    // Korean IME variants for all). The only thing that legitimately
    // differs is the title text + which binary to launch + the
    // post-spawn toast wording. Per user feedback:
    //   "대부분의 위젯은 동일하고 특수한 키바인딩만 정의해야함.
    //    지금은 키바인딩 마저 거의 비슷하고 일부 타이틀 표현만 다름."
    //
    // This helper is the single surface for "open a popup terminal"
    // — caller passes a tagged-union request describing the spawn,
    // the helper owns spawn + lifecycle hooks + router wiring +
    // toast + chatline + error reporting. Each caller becomes a
    // single line.
    type TerminalPopupRequest =
      | { kind: 'shell'; cwd: string; command?: string; env?: Record<string, string> }
      | { kind: 'coding-agent'; brand: 'claude-code' | 'codex' | 'gemini'; cwd: string; extraArgs?: readonly string[] };

    const openInteractiveTerminalPopup = (req: TerminalPopupRequest): TerminalSession | null => {
      const { cols: tc, rows: tr } = termSize();
      let spawnedSessionId: string | null = null;
      const sessionLabel = req.kind === 'coding-agent' ? req.brand : 'shell';

      if (debug.enabled) {
        debug.log('window.popupTerminal.spawn.entry', sessionLabel, {
          kind: req.kind,
          cwd: req.cwd,
          existingRouter: terminalModalRouter.current()?.id ?? null,
        });
      }

      const handleExit = (s: TerminalSession): void => {
        if (terminalModalRouter.current()?.id === s.id) {
          terminalModalRouter.set(null);
        }
        try { s.modal?.dispose(); } catch { /* ignore */ }
        s.modal = null;
        chatLines.push(C.muted(`  terminal exited: ${s.id}`));
        chatScrollOffset = -1;
        try { draw(); } catch { /* TUI torn down */ }
      };

      const handleTitleAction = (action: 'copy' | 'minimize' | 'close'): void => {
        const sid = spawnedSessionId;
        if (!sid) return;
        if (debug.enabled) {
          debug.log('window.titleControl.action', `${sessionLabel}:${action}`, { sid });
        }
        if (action === 'copy') {
          // Snapshot current PTY grid → strip ANSI → write to macOS
          // clipboard via osascript wrap. Toast feedback so the
          // user knows the click landed even though nothing visible
          // changes in the modal itself.
          const session = sessionRegistry.get(sid);
          const handle = session?.modal;
          if (!handle) {
            chatLines.push(C.warning(`  copy failed: no modal for ${sid}`));
            chatScrollOffset = -1;
            draw();
            return;
          }
          let snapshot = '';
          try { snapshot = handle.snapshot(); } catch { /* ignore */ }
          const plain = stripAnsi(snapshot).replace(/\s+$/gm, '');
          void (async () => {
            const ok = isClipboardSupported() ? await writeClipboard(plain) : false;
            const tc = termSize().cols;
            const tr = termSize().rows;
            if (ok) {
              showToast({
                title: 'Copied to clipboard',
                lines: [`${plain.length} chars from ${session?.title ?? sid}`],
                coordinator: display,
                termCols: tc, termRows: tr,
              });
              chatLines.push(C.muted(`  copied ${plain.length} chars from ${session?.title ?? sid}`));
            } else {
              showToast({
                title: 'Copy failed',
                lines: [isClipboardSupported() ? 'osascript error' : 'clipboard not supported on this OS'],
                coordinator: display,
                termCols: tc, termRows: tr,
              });
              chatLines.push(C.warning(`  copy failed for ${session?.title ?? sid}`));
            }
            chatScrollOffset = -1;
            draw();
          })();
          return;
        }
        if (terminalModalRouter.current()?.id === sid) {
          terminalModalRouter.set(null);
        }
        try {
          if (action === 'minimize') sessionRegistry.detach(sid);
          else sessionRegistry.kill(sid);
        } catch { /* ignore */ }
        draw();
      };

      let session: TerminalSession;
      try {
        if (req.kind === 'shell') {
          session = sessionRegistry.spawn(
            {
              title: 'terminal',
              cwd: req.cwd,
              command: req.command,
              env: req.env,
              kind: 'shell',
              onExit: handleExit,
              onTitleAction: handleTitleAction,
            },
            { termCols: tc, termRows: tr },
          );
        } else {
          session = spawnCodingAgent(
            {
              brand: req.brand,
              cwd: req.cwd,
              extraArgs: req.extraArgs ? [...req.extraArgs] : undefined,
              onExit: handleExit,
              onTitleAction: handleTitleAction,
            },
            { registry: sessionRegistry, termCols: tc, termRows: tr },
          );
        }
      } catch (err) {
        if (req.kind === 'coding-agent' && err instanceof CodingAgentBinaryMissing) {
          chatLines.push(C.error(`  ${req.brand} binary not found in PATH.`));
          const installLabel =
            req.brand === 'claude-code' ? 'Claude Code'
            : req.brand === 'gemini' ? 'Gemini CLI (@google/gemini-cli)'
            : 'Codex CLI';
          chatLines.push(C.muted(
            `  Install ${installLabel} first, then try again.`,
          ));
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          chatLines.push(C.warning(`  ${sessionLabel} popup failed: ${msg}`));
        }
        chatScrollOffset = -1;
        if (debug.enabled) {
          debug.log('window.popupTerminal.spawn.error', sessionLabel, {
            error: err instanceof Error ? err.message : String(err),
          }, { level: 'error' });
        }
        draw();
        return null;
      }
      spawnedSessionId = session.id;

      if (session.modal) {
        terminalModalRouter.set(session.modal, {
          onClose: () => { sessionRegistry.detach(session.id); draw(); },
        });
        if (debug.enabled) {
          debug.log('window.terminalModalRouter.set', session.modal.id, {
            id: session.modal.id, kind: sessionLabel,
          });
        }
        // Per-kind toast — the only legitimate "title difference" the
        // user flagged. Everything else (lifecycle, click routing,
        // exit handling) is identical across kinds.
        if (req.kind === 'shell') {
          showToast({
            title: 'Terminal opened',
            lines: ['Ctrl+G or Alt+W to close', 'typing `exit` also closes'],
            coordinator: display, termCols: tc, termRows: tr,
          });
        } else {
          showToast({
            title: `${req.brand} opened`,
            lines: [`▶ ${session.title}`],
            coordinator: display, termCols: tc, termRows: tr,
          });
        }
      }
      chatLines.push(C.muted(`  new ${sessionLabel} popup: ${session.id}`));
      chatScrollOffset = -1;
      draw();
      return session;
    };

    // ── Chainable builder ─────────────────────────────────────────
    // Single creation surface: `TerminalPopup.shell()` /
    // `TerminalPopup.agent(brand)` returns a builder; chain
    // `.cwd(...)` / `.args(...)` / `.command(...)` / `.env(...)`
    // and finally `.open()`. The class encapsulates the popup
    // request shape so callers don't construct tagged unions
    // by hand. Keybindings and lifecycle are inherited from the
    // helper — only popup-specific spawn data goes through the
    // chain.
    const terminalPopupRuntime = createDashboardTerminalPopupRuntime({
      onMissingCwd: () => {
        chatLines.push(C.warning(`  popup terminal needs cwd — call .cwd(...) before .open()`));
        chatScrollOffset = -1;
      },
      openInteractiveTerminalPopup,
    });
    const TerminalPopup = terminalPopupRuntime;
    const spawnGlobalTerminalModal = (): void => {
      terminalPopupRuntime.spawnGlobalTerminalModal(workingDir.cwd);
    };

    // E3 (2026-05-17) — copyLastAssistantTurnToClipboard /
    // copyLastAssistantCodeToClipboard land into the outer-scoped
    // forward-let so earlier callbacks (chat-main slash runtime,
    // log-pane copy keymap) can refer to the same instances. The
    // helpers exclusive to this scope stay as plain consts.
    const _dashCopyRuntime = createDashboardCopyRuntime({
      chatLines,
      setChatScrollBottom: () => { chatScrollOffset = -1; },
      draw,
      muted: C.muted,
      warning: C.warning,
      getAssistantState: () => ({
        lastAssistantRaw,
        lastAssistantRange,
        lastAssistantMode,
      }),
      stripAnsi,
      writeClipboard,
      writeClipboardDetailed,
    });
    copyLastAssistantTurnToClipboard = _dashCopyRuntime.copyLastAssistantTurnToClipboard;
    copyLastAssistantCodeToClipboard = _dashCopyRuntime.copyLastAssistantCodeToClipboard;
    const {
      autoCopyTurnQaToClipboard,
      copyLogPaneToClipboard,
    } = _dashCopyRuntime;
    // E3 — same outer-let bridge for media runtime (one fn).
    ({ openLastAssistantMediaPreview } = createDashboardMediaRuntime({
      chatLines,
      setChatScrollBottom: () => { chatScrollOffset = -1; },
      draw,
      muted: C.muted,
      warning: C.warning,
      getAssistantState: () => ({
        lastAssistantRaw,
        lastAssistantRange,
        lastAssistantMode,
      }),
      openPreviewSurface: async (preview) => {
        const { rows: tr, cols: tc } = termSize();
        await openDashboardMediaPreviewInSurface(preview, {
          showPreviewModal: async (absPath, title) => {
            await showPreviewModal(absPath, {
              coordinator: display,
              termCols: tc,
              termRows: tr,
              title,
              ttlMs: 4000,
            });
          },
        });
        return true;
      },
      openTarget: async (url) => {
        spawn('open', [url], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      },
      controlSignalBus: dashboardControlSignals,
      controlSignalScope: { surface: 'dashboard-chat-main', channel: 'dashboard' },
    }));
    const runDashboardSimulationById = async (scenarioId: Parameters<typeof runDashboardSimulationScenario>[0]) => {
      return runDashboardSimulationScenario(scenarioId, {
        seedAssistantSample: (text) => {
          ({ lastAssistantRaw, lastAssistantRange, lastAssistantMode } = appendDashboardAssistantSampleOutput({
            chatLines,
            text,
            termCols: termSize().cols,
            wrapEnabled: getUserConfig().chat.rendering.wrap,
            formatResponse,
            renderTextLine: C.text,
          }));
          chatScrollOffset = -1;
          draw();
        },
        clearAssistantSample: () => {
          lastAssistantRaw = null;
          lastAssistantRange = null;
          lastAssistantMode = 'rendered';
          chatScrollOffset = -1;
          draw();
        },
        openLastAssistantMediaPreview: async () => {
          await openLastAssistantMediaPreview();
        },
        getBrowserStatusLines: () => browserCdpSlashRuntime.statusLines(),
        getBrowserSmokeLines: async () => browserCdpSlashRuntime.smokeLines(),
        getBrowserStopLines: () => browserCdpSlashRuntime.stopLines(),
        signalBus: dashboardControlSignals,
        signalScope: { surface: 'dashboard-chat-main', channel: 'dashboard' },
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
      });
    };
    const openDashboardSimulationWebCockpit = async () => {
      return openDashboardLocalSimulationWebCockpit({
        listScenarios: listDashboardSimulationScenarios,
        openTarget: async (urlOrPath) => {
          spawn('open', [urlOrPath], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        },
        getControlSignalObserver: () => defaultControlSignalObserver(),
      });
    };

    const runChatMainGlobalAction = createDashboardChatMainGlobalActionRuntime({
      nudgeLogHeightBias: (delta) => { logHeightBias += delta; },
      resetLogHeightBias: () => { logHeightBias = 0; },
      recomputePaneHeight: () => { computePaneH(termSize().rows); },
      focusLog: () => {
        applyFocusToPaneTransition(resolveFocusToPaneTransition({
          targetPane: 'log',
          reason: 'ctrl-g-global',
        }));
      },
      toggleLogZoom: () => { toggleChatOnlyLayout(); },
      copyLastBlock: copyLastAssistantTurnToClipboard,
      spawnTerminalModal: spawnGlobalTerminalModal,
      copyLogPane: copyLogPaneToClipboard,
      // Ctrl+L — 터미널 클리어 후 전체 강제 리페인트(resize 리스너와 동일 레시피).
      // 외부 출력/아티팩트로 더러워진 화면 복구용 · 대화(chatLines)는 보존.
      forceRedraw: () => {
        try { process.stdout.write(ansi.clear); } catch { /* ignore */ }
        draw({ force: true });
        try { promptCtl.repaint(); } catch { /* ignore */ }
      },
      rotateProviderNext: rotateProviderHotkey,
    });
    const chordFeedbackRuntime = createDashboardChordFeedbackRuntime({
      pushMutedLine: (line) => { chatLines.push(C.muted(line)); },
      setChatScrollBottom: () => { chatScrollOffset = -1; },
    });
    const runDashboardChordAction = createDashboardChordRuntime<PaneFocus>({
      focusBrowser: () => {
        setWorkingFocus('browser', 'chord-ctrl-b-w');
      },
      focusObsidian: () => {
        if (workingDir.view === 2) setWorkingFocus('obsidian', 'chord-ctrl-b-o');
      },
      reopenScratch: () => {
        if (scratchClosed && workingDir.view !== 4) {
          scratchClosed = false;
          userClosedPanes.delete('scratch');
          setWorkingFocus('scratch', 'chord-ctrl-b-s');
        }
      },
      toggleBell,
      refreshSessionCardsInto,
      focusSessionsSidebar: () => {
        setWorkingFocus('sessions-sidebar', 'chord-ctrl-b-S');
      },
      getSessionsSidebarState: () => {
        const sidebarInst = widgetHost.get('wd-sessions-sidebar');
        return sidebarInst?.state as SessionsSidebarState | undefined;
      },
      focusSessionSidebarCursor,
      cycleSessionSidebarCursor,
      markNotificationRead: (sessionId) => {
        notificationStore.markRead(sessionId);
      },
      closeFocusedPane: () => closeDashboardPane(workingDir.focus),
      focusedPaneLabel: () => paneLabel(workingDir.focus),
      onPaneClosed: chordFeedbackRuntime.onPaneClosed,
      reopenPanes: () => {
        restoreAllClosedDashboardPanes();
      },
      onPanesReopened: chordFeedbackRuntime.onPanesReopened,
      getOpenPaneModalTarget: () => (
        workingDir.focus === 'input'
          ? activePaneVisibility().visible[0] ?? activeViewDef().primary
          : workingDir.focus
      ),
      openPaneModal: (pane) => {
        openDashboardPaneModal(pane);
      },
      toggleLogZoom: () => runChatMainGlobalAction({ kind: 'toggle-log-zoom' }),
      openPreviewTerminal,
      getPreviewTerminal: () => previewTerminal as PreviewTerminal | null,
      getTerminalExpanded: () => terminalExpanded,
      setTerminalExpanded: (next) => { terminalExpanded = next; },
      resetPreviewTerminalDims: () => { previewTerminalDims = null; },
      focusPreviewAfterTerminalExpand: () => {
        setWorkingFocus('preview', 'chord-ctrl-b-e-expand');
      },
      onPreviewTerminalExpandChanged: chordFeedbackRuntime.onPreviewTerminalExpandChanged,
      onMissingPreviewTerminal: chordFeedbackRuntime.onMissingPreviewTerminal,
    });

    // ══════════════════════════════════════════════════════════════
    // ── Widget architecture refactor Phase 0 — PaneKeyRouter ──
    // Replaces the 28-branch `if (p === '<pane>') { ... continue; }`
    // chain that used to live inline below. Handlers are arrow-function
    // closures that capture dashboard-local state via lexical scope
    // (Option B · see 내부 문서 `ROADMAP-widget-arch-refactor` §4 Phase 0).
    // The dispatch call happens at the bottom of the pane-dispatch
    // block; behavior is preserved 1:1 with the old inline branches.
    // Phase 0b-1: log / playground / debug-events / scheduler-inspector.
    // Remaining batches land in later commits of the same PR.
    // ══════════════════════════════════════════════════════════════
    const paneKeyRouter = createPaneKeyRouter();

    paneKeyRouter.register('log', async (key) => {
      // h/l in log pane navigate panes too — the existing log
      // handler ignores h/l so they fall through here.
      // TR-P4: arrow pane-nav removed in the log pane; Tab
      // cycles focus, the log pane's j/k/etc are handled below.
      await handleLogPaneKey(key);
      return 'consumed' as const;
    });

    paneKeyRouter.register('playground', (key) => {
      // F-B5b pre-existing fix: prior to the router landing, keys on
      // `p === 'playground'` fell through the entire working-dir
      // dispatch block and dropped silently — the widget's `onKey` was
      // dead code. Delegate here so ↑↓/j/k, 1/2/3, tab, r, e (F-B5b
      // edit-mode toggle), Esc, etc. actually reach the playground
      // widget. 'none' result falls through so this fix never
      // regresses any key that was working before.
      //
      // Phase 1 (2026-04-19) — routes through dispatchKeyToWidget so
      // the widget's `behaviors` chain runs first. Playground declares
      // no behaviors yet; once Phase 3 adds them, this call site is
      // unchanged.
      const action = dispatchKeyToWidget(widgetHost, 'wd-playground', key);
      if (debug.enabled) {
        const inst = widgetHost.get('wd-playground') as { state?: { mode?: string } } | undefined;
        debug.log('playground.onKey', key.name || '(empty)', {
          result: (action as { type?: string } | null)?.type ?? 'null',
          ctrl: key.ctrl, shift: key.shift,
          mode: inst?.state?.mode,
        });
      }
      if (action && typeof action === 'object' && 'type' in action && action.type !== 'none') {
        draw();
      }
      return 'consumed' as const;
    });

    paneKeyRouter.register('debug-events', (key) => {
      const events = [...debug.events(200)].reverse();
      const max = events.length - 1;
      if (runWidgetCursorBridge(key, {
        itemCount: max + 1,
        currentCursor: debugEventCursor,
        widgetState: widgetHost.get('wd-debug-events') as {
          state: { cursor: number; items: string[] };
        } | null,
        setWidgetCursor: (inst, cursor) => { inst.state.cursor = cursor; },
        getWidgetCursor: inst => inst.state.cursor,
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-debug-events', key); },
        applyNextCursor: (nextCursor) => {
          debugEventCursor = nextCursor;
          debugEventManual = true;
        },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`debug-events.cursor.${phase}-dispatch`, key.name || '(empty)', payload)
          : undefined,
      })) {
        return 'consumed' as const;
      }
      switch (key.name) {
        case 'enter':
        case 'l':
          setWorkingFocus('debug-detail', 'debug-events-l'); break;
        case 'h':
          setWorkingFocus(tabNext('debug-events', -1), 'debug-events-h'); break;
        case 'a':
          debugEventManual = false;
          debugEventCursor = 0;
          break;
        case 'v':
          debug.setVerboseEnabled(!debug.isVerboseEnabled());
          chatLines.push(debug.isVerboseEnabled()
            ? C.warning('debug verbose: ON')
            : C.muted('debug verbose: OFF'));
          chatScrollOffset = -1;
          break;
        case 'c':
          debug.clear();
          debugEventCursor = 0;
          debugEventManual = false;
          break;
      }
      return 'consumed' as const;
    });

    // Surface-unification v2.2 V2.2-5 Part 2 — scheduler-inspector pane
    // key router retired (scheduler view 폐기).

    // Phase 0b-2: agent-roster / agent-detail / agent-log / debug-detail /
    // debug-stack / debug-prompts. Same-body panes use a factory to keep
    // the closure a single source of truth.

    paneKeyRouter.register('agent-roster', (key) => {
      const roster = agentSurfaceStore.list();
      const max = roster.length - 1;
      if (runWidgetCursorBridge(key, {
        itemCount: max + 1,
        currentCursor: agentRosterCursor,
        widgetState: widgetHost.get('wd-agent-roster') as {
          state: { cursor: number; agents: { id: string }[] };
        } | null,
        setWidgetCursor: (inst, cursor) => { inst.state.cursor = cursor; },
        getWidgetCursor: inst => inst.state.cursor,
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-agent-roster', key); },
        applyNextCursor: (nextCursor) => {
          agentRosterCursor = nextCursor;
          agentCursorManual = true;
          agentCursorLockedId = roster[nextCursor]?.id ?? agentCursorLockedId;
        },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`agent-roster.cursor.${phase}-dispatch`, key.name || '(empty)', {
            ...payload,
            ...(phase === 'post' ? { lockedId: roster[Math.max(0, Math.min(agentRosterCursor, max))]?.id ?? agentCursorLockedId } : {}),
          })
          : undefined,
      })) {
        return 'consumed' as const;
      }
      switch (key.name) {
        case 'enter':
        case 'l':
          applyFocusToPaneTransition(resolveFocusToPaneTransition({
            targetPane: 'agent-detail',
            reason: 'agent-roster-l',
          }));
          break;
        case 'h':
          applyFocusToPaneTransition(resolveFocusToPaneTransition({
            targetPane: 'log',
            reason: 'agent-roster-h',
          }));
          break;
        case 's': {
          // P4.1: cycle sort mode through default → elapsed →
          // tools → name → status → default.
          const order: AgentRosterSort[] = ['default', 'elapsed', 'tools', 'name', 'status'];
          const idx = order.indexOf(agentRosterSort);
          agentRosterSort = order[(idx + 1) % order.length]!;
          // Reset cursor to 0 because the visible order changed.
          agentRosterCursor = 0;
          agentCursorManual = true;
          break;
        }
        case 'F': {
          // P4.1: cycle filter through all → running → errored → all.
          const order: AgentRosterFilter[] = ['all', 'running', 'errored'];
          const idx = order.indexOf(agentRosterFilter);
          agentRosterFilter = order[(idx + 1) % order.length]!;
          agentRosterCursor = 0;
          agentCursorManual = true;
          break;
        }
        case 'x': {
          // PFC-S2 P1: abort the cursored task. Idempotent — registry
          // no-ops on already-terminal tasks. Stays on the same row so
          // the user sees the status flip to `aborted` right where
          // they pressed the key.
          const cur = roster[agentRosterCursor];
          if (cur) globalAgentRegistry.abort(cur.id);
          break;
        }
        case 'd': {
          // PFC-S2 P1: detach a foreground task to background routing.
          // After this, task completion lands via task-notification
          // XML on the parent's next turn instead of the foreground
          // channel. No-op on already-bg or terminal tasks.
          const cur = roster[agentRosterCursor];
          if (cur) globalAgentRegistry.markBackground(cur.id);
          break;
        }
        case 'a': {
          // PFC-S2 P1: attach a background task back to foreground —
          // the inverse of `d`. The task-notification queue will not
          // enqueue when this task reaches terminal state.
          const cur = roster[agentRosterCursor];
          if (cur) globalAgentRegistry.markForeground(cur.id);
          break;
        }
        case '?': {
          // PFC-S2 P3: toggle the roster cheatsheet overlay. The
          // search modal owns `/`; here `?` is safe because no
          // other roster action uses it.
          agentRosterHelp = !agentRosterHelp;
          break;
        }
      }
      return 'consumed' as const;
    });

    const makeAgentDetailOrLogHandler = (paneId: 'agent-detail' | 'agent-log') => (key: import('../tui.js').Key) => {
      const id = paneId === 'agent-detail' ? 'wd-agent-detail' : 'wd-agent-log';
      // Phase 3a: scroll keys (j/k/↑↓/g/G/Home/End/PgUp/PgDn/Ctrl+d/u)
      // delegate to the widget's `behaviors: [Scrollable]`. The closure
      // below only handles dashboard-local concerns — pane navigation
      // (h/l) and the y/e copy/export actions that read
      // agentRosterFilter/agentSurfaceStore. Those migrate to the
      // widget in Phase 7 after state cleanup.
      switch (key.name) {
        case 'h':
          applyFocusToPaneTransition(resolveFocusToPaneTransition({
            targetPane: 'agent-roster',
            reason: 'agent-detail-h',
          }));
          break;
        case 'l':
          applyFocusToPaneTransition(resolveFocusToPaneTransition({
            targetPane: paneId === 'agent-detail' ? 'preview' : 'log',
            reason: 'agent-detail-l',
          }));
          break;
        case 'j': case 'down':
        case 'k': case 'up':
        case 'pagedown':
        case 'pageup':
        case 'g': case 'home':
        case 'G': case 'end': {
          // All scroll keys — widget handles via Scrollable.
          dispatchKeyToWidget(widgetHost, id, key);
          break;
        }
        case 'y':
        case 'e': {
          // P4.2: derive the currently-selected agent fresh
          // from the store (selectedAgentSurface is a draw-loop
          // local and isn't reachable here). Apply the same
          // filter that the roster view uses so user intent
          // matches what they see.
          let view = agentSurfaceStore.list();
          if (agentRosterFilter !== 'all') {
            view = view.filter(a =>
              agentRosterFilter === 'running'
                ? a.status === 'running'
                : a.status === 'error',
            );
          }
          const sel = view[Math.max(0, Math.min(agentRosterCursor, view.length - 1))];
          if (!sel) {
            chatLines.push(C.warning(`  (no agent selected to ${key.name === 'y' ? 'copy' : 'export'})`));
            chatScrollOffset = -1;
            break;
          }
          if (key.name === 'y') {
            const plain = stripAnsi(renderAgentDetail(sel));
            writeClipboard(plain).then(ok => {
              chatLines.push(ok
                ? C.success(`  \u2713 copied agent "${sel.name}" detail (${plain.length} bytes)`)
                : C.warning('  (clipboard write failed)'));
              chatScrollOffset = -1;
            });
          } else {
            try {
              const task = globalAgentRegistry.get(sel.id);
              // WD7 — agent log dir lives under the active project.
              const logDir = join(getSessionCwd(), 'log');
              if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
              const fn = join(logDir, `agent-${sel.id.slice(0, 8)}.jsonl`);
              const rec = {
                id: sel.id,
                correlationId: sel.correlationId,
                name: sel.name,
                definitionName: sel.definitionName,
                status: sel.status,
                elapsedMs: sel.elapsedMs,
                toolCount: sel.toolCount,
                result: sel.result ?? null,
                error: sel.error ?? null,
                messages: task?.messages ?? [],
                exportedAt: new Date().toISOString(),
              };
              writeFileSync(fn, JSON.stringify(rec, null, 2));
              chatLines.push(C.success(`  \u2713 exported agent "${sel.name}" to ${fn}`));
            } catch (err: any) {
              chatLines.push(C.error(`  export failed: ${err?.message ?? err}`));
            }
            chatScrollOffset = -1;
          }
          break;
        }
      }
      return 'consumed' as const;
    };
    paneKeyRouter.register('agent-detail', makeAgentDetailOrLogHandler('agent-detail'));
    paneKeyRouter.register('agent-log', makeAgentDetailOrLogHandler('agent-log'));

    const makeDebugDetailHandler = (paneId: 'debug-detail' | 'debug-stack' | 'debug-prompts') => (key: import('../tui.js').Key) => {
      const id = paneId === 'debug-detail'
        ? 'wd-debug-detail'
        : paneId === 'debug-stack'
          ? 'wd-debug-stack'
          : 'wd-debug-prompts';
      // Phase 3b: scroll keys delegate to the markdown widget's
      // `behaviors: [Scrollable]`. Closure keeps only the pane-nav
      // (h/l) branches which call dashboard-local setWorkingFocus.
      switch (key.name) {
        case 'h':
          setWorkingFocus(
            paneId === 'debug-prompts' ? 'debug-stack' : 'debug-events',
            'debug-detail-h',
          );
          break;
        case 'l':
          setWorkingFocus(
            paneId === 'debug-detail' ? 'preview' : paneId === 'debug-stack' ? 'debug-prompts' : 'log',
            'debug-detail-l',
          );
          break;
        case 'j': case 'down':
        case 'k': case 'up':
        case 'pagedown':
        case 'pageup':
        case 'g': case 'home':
        case 'G': case 'end': {
          // Widget's Scrollable behavior handles all scroll keys.
          dispatchKeyToWidget(widgetHost, id, key);
          break;
        }
      }
      return 'consumed' as const;
    };
    paneKeyRouter.register('debug-detail', makeDebugDetailHandler('debug-detail'));
    paneKeyRouter.register('debug-stack', makeDebugDetailHandler('debug-stack'));
    paneKeyRouter.register('debug-prompts', makeDebugDetailHandler('debug-prompts'));

    // Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — scheduler-*
    // lane + scheduler-board pane key handlers retired (scheduler view
    // 폐기 · `makeSchedulerLaneHandler` 함수 + `paneKeyRouter.register`
    // 5 호출 모두 cleanup · `markSchedulerTaskDue` / `pauseSchedulerTask` /
    // `resumeSchedulerTask` 사용 site 도 함께 사라짐).

    // Phase 0b-3a: browser / obsidian — the two filesystem browsers.

    // Yazi-style comma-chord runtime — `,v` (vim) · `,s` (LLM summary)
    // · `,?` (help). Singleton scoped to the browser pane handler.
    // The runtime owns the chord state machine; this closure supplies
    // the actions (file edit / summarize / help).
    const browserChordRuntime = createBrowserChordRuntime({
      showChordHint: () => {
        const { cols: tc, rows: tr } = termSize();
        showTransientTerminalModal({
          title: 'Chord — , prefix',
          lines: [
            `  ${C.key('v')}  ${C.text('edit in $EDITOR (nvim)')}`,
            `  ${C.key('s')}  ${C.text('LLM summarize this file')}`,
            `  ${C.key('?')}  ${C.text('full browser help')}`,
            '',
            C.muted('  (700 ms — press the next key)'),
          ],
          coordinator: display,
          termCols: tc,
          termRows: tr,
          ttlMs: 800,
          group: 'browser-comma-hint',
        });
      },
      clearChordHint: () => {
        // showTransientTerminalModal's group-singleton means firing a
        // fresh modal in the same group disposes the prior one. We
        // emit a 1-frame transparent placeholder by skipping — the
        // 700 ms TTL on the hint itself handles cleanup. No-op here
        // is intentional and explicit.
      },
      onEditFocused: async () => {
        const browser = activeBrowserState() as WorkingDirState;
        const e = focusedEntry(browser);
        if (!e || e.isDir) {
          chatLines.push(C.muted('  ,v: cursor not on a file'));
          chatScrollOffset = -1;
          draw();
          return;
        }
        if (workingDir.remote) {
          // Mirror the `e` branch's remote roundtrip path.
          const host = workingDir.remote.host;
          const remotePath = e.absPath;
          try {
            const r = await editRemoteFile(host, remotePath, async (localPath) => {
              const res = await launchEditor(localPath);
              if (!res.ok) {
                chatLines.push(C.warning(`  ,v: ${res.message}`));
                chatScrollOffset = -1;
                return { ok: false, message: res.message };
              }
              return { ok: true };
            });
            if (r.ok) {
              chatLines.push(C.success(`  ✓ wrote ${host.name}:${remotePath} (${r.uploadedBytes} bytes)`));
            } else {
              chatLines.push(C.error(`  ,v remote: ${r.reason}: ${r.message}`));
            }
            chatScrollOffset = -1;
            await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
            await refreshRemotePreviewBridge();
            draw();
          } catch (err) {
            chatLines.push(C.error(`  ,v remote crashed: ${err instanceof Error ? err.message : String(err)}`));
            chatScrollOffset = -1;
            draw();
          }
          return;
        }
        if (!canLaunchEditor()) {
          chatLines.push(C.warning('  ,v: $EDITOR / $VISUAL unset — set one or use `e` for mini-vi.'));
          chatScrollOffset = -1;
          draw();
          return;
        }
        try {
          const r = await launchEditor(e.absPath);
          if (!r.ok) {
            chatLines.push(C.warning(`  ,v: ${r.message}`));
            chatScrollOffset = -1;
          }
          refreshWorkingDir(workingDir);
          refreshWorkingDirPreview();
          draw();
        } catch (err) {
          chatLines.push(C.error(`  ,v launch failed: ${err instanceof Error ? err.message : String(err)}`));
          chatScrollOffset = -1;
          draw();
        }
      },
      onSummarizeFocused: async () => {
        const browser = activeBrowserState() as WorkingDirState;
        const e = focusedEntry(browser);
        if (!e || e.isDir) {
          chatLines.push(C.muted('  ,s: cursor not on a file'));
          chatScrollOffset = -1;
          draw();
          return;
        }
        if (workingDir.remote) {
          chatLines.push(C.warning('  ,s: remote summary unsupported — Esc remote first.'));
          chatScrollOffset = -1;
          draw();
          return;
        }
        // Status line: cleared once the result modal renders.
        chatLines.push(C.muted(`  ,s: summarizing ${e.name}…`));
        chatScrollOffset = -1;
        draw();
        const res = await summarizeFileWithLLM(e.absPath);
        const { cols: tc, rows: tr } = termSize();
        if (!res.ok) {
          chatLines.push(C.warning(`  ,s: ${res.reason}`));
          chatScrollOffset = -1;
          draw();
          return;
        }
        // Wrap LLM text into a width-bounded line array. The modal's
        // bordered render adds 4 cols of chrome.
        const popupWidth = Math.min(96, Math.max(60, tc - 6));
        const wrapWidth = Math.max(40, popupWidth - 4);
        const lines: string[] = [];
        for (const para of res.summary.split(/\r?\n/)) {
          if (!para) { lines.push(''); continue; }
          for (const wrapped of wrapAnsiByWidth(para, wrapWidth)) {
            lines.push(wrapped);
          }
        }
        showTransientTerminalModal({
          title: `Summary · ${e.name}${res.truncated ? ' (truncated input)' : ''}`,
          lines,
          coordinator: display,
          termCols: tc,
          termRows: tr,
          ttlMs: 30_000,
          group: 'browser-llm-summary',
          width: popupWidth,
        });
      },
      onShowHelp: () => browserHelpRuntime.showHelp(),
      notice: (level, msg) => {
        chatLines.push(level === 'warning' ? C.warning(msg) : C.muted(msg));
        chatScrollOffset = -1;
        draw();
      },
    });

    paneKeyRouter.register('browser', async (key) => {
      // ── Browser pane (unified folders + files) ──
      // Enter on a folder (including `..`) cd's; Enter on a file
      // attaches it and drops focus back to input. h/l move to the
      // adjacent pane in the view's tab order — directory navigation
      // happens through Enter on the `..` sentinel or on a subdir.
      //
      // Yazi-style chord interception MUST run before the cursor
      // bridge + switch — once `,` arms the leader, the next key is
      // a continuation regardless of its single-key meaning. Korean
      // IME aliases handled inside browserChordRuntime.
      if (await browserChordRuntime.tryHandleKey(key)) {
        debug.log('browser.comma-chord.consumed', key.name || '(empty)', {});
        draw();
        return 'consumed';
      }
      // Yazi-style help (`~` toggles overlay). Single key, no modifier.
      if (!key.ctrl && !key.alt && (key.name === '~' || key.name === '?' && key.shift)) {
        browserHelpRuntime.showHelp();
        draw();
        return 'consumed';
      }
      //
      // WD3 — Ctrl+W promotes the current folder (or the folder
      // under the cursor) to the session working directory.
      // Matched above the `switch (key.name)` below because the
      // switch keys off name alone; modifier-gated combos need
      // an explicit branch. Semantics:
      //   • cursor on subfolder (non-`..`)  → that folder
      //   • cursor on `..` / file / empty    → workingDir.cwd
      // Remote mode is intentionally skipped — SWD is a local
      // filesystem concept.
      if (key.ctrl && (key.name === 'w' || key.name === 'ㅈ')) {
        if (workingDir.remote) {
          chatLines.push(C.warning('  Ctrl+W: session working dir is local-only — Esc remote first.'));
          chatScrollOffset = -1;
          draw();
          return 'consumed';
        }
        const target = pickSwdTargetFromBrowser(workingDir);
        try {
          setSessionCwd(target, 'user');
          chatLines.push(C.success(`  ✓ working dir → ${target}`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          chatLines.push(C.error(`  Ctrl+W: ${msg}`));
        }
        chatScrollOffset = -1;
        draw();
        return 'consumed';
      }
      // T4-E4: Esc ends remote mode and restores the local listing.
      if (key.name === 'escape' && workingDir.remote) {
        const hostName = workingDir.remote.host.name;
        endRemoteModeBridge();
        refreshWorkingDir(workingDir);
        refreshWorkingDirPreview();
        chatLines.push(C.muted(`  disconnected from ${hostName} (back to ${workingDir.cwd})`));
        chatScrollOffset = -1;
        draw();
        return 'consumed';
      }
      // Phase 7 Batch E — cursor scroll keys delegate to the list
      // widget's Cursorable behavior on wd-browser. workingDir.cursor
      // stays the dashboard-local source of truth; bridge pre/post.
      // Preview refresh is a side-effect triggered by the pane handler
      // (widget doesn't know about preview coupling).
      if (runListPaneCursorBridge({
        key,
        itemCount: workingDir.entries.length,
        currentCursor: workingDir.cursor,
        widgetState: widgetHost.get('wd-browser') as {
          state: { cursor: number; items: string[] };
        } | null,
        setWidgetCursor: (inst, cursor) => { inst.state.cursor = cursor; },
        getWidgetCursor: inst => inst.state.cursor,
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-browser', key); },
        setCursor: (nextCursor) => { workingDir.cursor = nextCursor; },
        resetOffsetToHome: () => { workingDir.offset = 0; },
        onCursorChanged: () => { refreshWorkingDirPreview(); },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`browser.cursor.${phase}-dispatch`, key.name || '(empty)', payload)
          : undefined,
      })) {
        draw();
        return 'consumed';
      }
      switch (key.name) {
        case 'space':
          // No-op on folders / `..`; only files toggle selection.
          toggleSelection(workingDir); break;
        case 'A':
          toggleSelectAll(workingDir); break;
        case 'a': {
          // Attach selected (or cursor file) without leaving pane.
          const browser = activeBrowserState() as WorkingDirState;
          const targets = attachTargets(browser);
          if (targets.length > 0) {
            attachWorkingDirSelection(targets);
            browser.selected.clear();
          }
          break;
        }
        case 'c': {
          // Copy the cursor entry's absolute path (file → file
          // path, directory → directory path) with a persistent
          // log entry. `ㅊ` on the same physical key is handled by
          // parseKey's jamo→en remap so no separate case needed.
          const e = focusedEntry(activeBrowserState() as WorkingDirState);
          const label = e?.isDir ? 'dir' : 'file';
          await copyRootPathToLog(e?.absPath, label);
          break;
        }
        case '<': {
          // Jump to the parent directory. No clamp — this is the
          // "unbounded" file browser, symmetric with typing `..`
          // + Enter but without the extra keystrokes.
          const browser = activeBrowserState() as WorkingDirState;
          const parent = dirname(browser.cwd);
          if (parent !== browser.cwd) {
            enterDirectory(browser, parent);
            refreshWorkingDir(browser);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`cd ${browser.cwd}`));
            chatScrollOffset = -1;
          }
          break;
        }
        case 'enter': {
          const browser = activeBrowserState() as WorkingDirState;
          const e = focusedEntry(browser);
          if (!e) break;
          // T4-E4: remote mode branches to remote-browser helpers.
          if (workingDir.remote) {
            if (e.isDir) {
              enterRemoteDirectory(workingDir, e.absPath);
              (async () => {
                await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
                await refreshRemotePreviewBridge();
                draw();
              })().catch(() => {});
              pushDebugLine(C.muted(`cd ${workingDir.remote.host.name}:${e.absPath}`));
              chatScrollOffset = -1;
            } else {
              chatLines.push(C.muted(`  (remote file — press e to edit)`));
              chatScrollOffset = -1;
            }
            break;
          }
          if (e.isDir) {
            // Folder (or `..`) → cd. Same pane re-lists.
            enterDirectory(browser, e.absPath);
            refreshWorkingDir(browser);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`cd ${browser.cwd}`));
            chatScrollOffset = -1;
          } else {
            // File → attach + drop into input so the user can type.
            const targets = attachTargets(browser);
            if (targets.length > 0) {
              attachWorkingDirSelection(targets);
              browser.selected.clear();
              applyFocusToInputTransition(resolveFocusToInputTransition({
                sourcePane: 'browser',
                rememberPane: true,
                reason: 'browser-attach-file',
              }));
            }
          }
          break;
        }
        // T5-J5 — `t` opens the transfer modal with the
        // focused file (or selected set when non-empty) as
        // the payload. Destinations come from transfer-
        // targets.json (defaults to every SSH host +
        // iPhone). Remote-mode browser bypasses `t` until
        // remote→X transfers are implemented — the handler
        // surfaces a warning instead.
        case 't': case 'ㅅ': {
          if (workingDir.remote) {
            chatLines.push(C.warning('  transfer from remote isn\'t supported yet — Esc first.'));
            chatScrollOffset = -1;
            break;
          }
          const browser = activeBrowserState();
          const selected = [...browser.selected];
          const files: Array<{ localPath: string; size?: number }> = [];
          if (selected.length > 0) {
            for (const abs of selected) {
              const entry = browser.entries.find(e => e.absPath === abs && !e.isDir);
              if (entry) files.push({ localPath: abs, size: entry.size });
            }
          } else {
            const focused = focusedEntry(browser as WorkingDirState);
            if (focused && !focused.isDir) {
              files.push({ localPath: focused.absPath, size: focused.size });
            }
          }
          openTransferPicker(files, activeBrowserWidgetId());
          break;
        }
        // T3-C2 + T4-D2 — `e` on a regular file opens the
        // file for editing. Two paths:
        //   • Primary: shell out to $EDITOR (yazi-style) — the
        //     user's real vim/nvim/helix/etc. gets the full
        //     screen. Works unless $EDITOR is unset.
        //   • Fallback: pane-embedded mini-vi editor (T3-C1).
        //     Explicit opt-in via ELANOUS_USE_MINI_VI=1 or auto
        //     when no $EDITOR is available.
        case 'e': case 'ㄷ': {
          const browser = activeBrowserState() as WorkingDirState;
          const e = focusedEntry(browser);
          if (!e || e.isDir) break;
          // T4-E5 — remote file: scp down → edit → scp up.
          // Drift check before upload, force-via prompt omitted
          // for MVP (edit-forbidden is surfaced in the log).
          if (workingDir.remote) {
            const host = workingDir.remote.host;
            const remotePath = e.absPath;
            (async () => {
              const r = await editRemoteFile(host, remotePath, async (localPath) => {
                const res = await launchEditor(localPath);
                if (!res.ok) {
                  chatLines.push(C.warning(`  editor: ${res.message}`));
                  chatScrollOffset = -1;
                  return { ok: false, message: res.message };
                }
                return { ok: true };
              });
              if (r.ok) {
                chatLines.push(C.success(`  ✓ wrote ${host.name}:${remotePath} (${r.uploadedBytes} bytes)`));
              } else {
                chatLines.push(C.error(`  remote edit failed — ${r.reason}: ${r.message}`));
              }
              chatScrollOffset = -1;
              await refreshRemoteWorkingDir(workingDir, {}, dockedPreview);
              await refreshRemotePreviewBridge();
              draw();
            })().catch((err) => {
              chatLines.push(C.error(`  remote edit crashed: ${err instanceof Error ? err.message : String(err)}`));
              chatScrollOffset = -1;
              draw();
            });
            break;
          }
          const useMini = process.env['ELANOUS_USE_MINI_VI'] === '1';
          if (!useMini && canLaunchEditor()) {
            // Fire-and-forget — launchEditor suspends the TUI,
            // runs $EDITOR blocking, then resumes. During that
            // window the readKey loop is paused via initTui
            // teardown. On return, refresh the browser pane
            // so any file-size/mtime changes show up.
            (async () => {
              const r = await launchEditor(e.absPath);
              if (!r.ok) {
                chatLines.push(C.warning(`  editor: ${r.message}`));
                chatScrollOffset = -1;
              }
              refreshWorkingDir(workingDir);
              refreshWorkingDirPreview();
              draw();
            })().catch((err) => {
              chatLines.push(C.error(`  editor launch failed: ${err instanceof Error ? err.message : String(err)}`));
              chatScrollOffset = -1;
              draw();
            });
          } else {
            openPreviewViEditor(e.absPath);
          }
          break;
        }
        case 'left': {
          // TR-P5: browser pane ← = parent dir (symmetric with `<`).
          const browser = activeBrowserState() as WorkingDirState;
          const parent = dirname(browser.cwd);
          if (parent !== browser.cwd) {
            enterDirectory(browser, parent);
            refreshWorkingDir(browser);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`cd ${browser.cwd}`));
            chatScrollOffset = -1;
          }
          break;
        }
        case 'right': {
          // TR-P5: browser pane → = enter directory at cursor (if any).
          const browser = activeBrowserState() as WorkingDirState;
          const e = focusedEntry(browser);
          if (e?.isDir) {
            enterDirectory(browser, e.absPath);
            refreshWorkingDir(browser);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`cd ${browser.cwd}`));
            chatScrollOffset = -1;
          }
          break;
        }
        case '.':
          workingDir.showHidden = !workingDir.showHidden;
          refreshWorkingDir(workingDir);
          refreshWorkingDirPreview();
          break;
        case 's':
          workingDir.sortMode = nextSortMode(workingDir.sortMode);
          refreshWorkingDir(workingDir);
          refreshWorkingDirPreview();
          break;
      }
      return 'consumed' as const;
    });

    paneKeyRouter.register('obsidian', async (key) => {
      // ── Obsidian vault browser pane (V1) ──
      // Mirrors the Working browser keymap but scoped to the vault
      // state (cwd clamped at OBSIDIAN_VAULT root). Enter on a file
      // attaches the path into input the same way the Working
      // browser does — the attach token is just an absolute path,
      // so downstream consumers don't care which pane produced it.
      if (!obsidianDir.available) {
        // TR-P4: arrows used to cycle panes; now only Escape /
        // Tab do that, both handled higher up. No-op everything
        // else so muscle memory doesn't surprise-eject.
        return 'consumed';
      }
      // Phase 7 Batch F — cursor scroll keys delegate to the list
      // widget's Cursorable behavior on wd-obsidian. obsidianDir.cursor
      // stays the dashboard-local source of truth; bridge pre/post.
      if (runListPaneCursorBridge({
        key,
        itemCount: obsidianDir.entries.length,
        currentCursor: obsidianDir.cursor,
        widgetState: widgetHost.get('wd-obsidian') as {
          state: { cursor: number; items: string[] };
        } | null,
        setWidgetCursor: (inst, cursor) => { inst.state.cursor = cursor; },
        getWidgetCursor: inst => inst.state.cursor,
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-obsidian', key); },
        setCursor: (nextCursor) => { obsidianDir.cursor = nextCursor; },
        resetOffsetToHome: () => { obsidianDir.offset = 0; },
        onCursorChanged: () => { refreshWorkingDirPreview(); },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`obsidian.cursor.${phase}-dispatch`, key.name || '(empty)', payload)
          : undefined,
      })) {
        return 'consumed' as const;
      }
      switch (key.name) {
        case 'space':
          obsidianToggleSelection(obsidianDir); break;
        case 'A':
          obsidianToggleSelectAll(obsidianDir); break;
        case 'a': {
          const targets = obsidianAttachTargets(obsidianDir);
          if (targets.length > 0) {
            attachWorkingDirSelection(targets);
            obsidianDir.selected.clear();
          }
          break;
        }
        case 'c': {
          // Copy the cursor entry's absolute path (file → file
          // path, directory → directory path). `ㅊ` remaps to `c`
          // via parseKey's jamo→en mapper.
          const e = obsidianFocusedEntry(obsidianDir);
          const label = e?.isDir ? 'obsidian dir' : 'obsidian file';
          await copyRootPathToLog(e?.absPath, label);
          break;
        }
        case '<': {
          // Parent dir — enterObsidianDirectory already clamps at
          // vault root (silently no-ops on escape), so we just
          // skip the refresh/log when we're already at the top.
          if (obsidianDir.cwd !== obsidianDir.root) {
            enterObsidianDirectory(obsidianDir, dirname(obsidianDir.cwd));
            refreshObsidianDir(obsidianDir);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`obsidian cd ${obsidianDir.cwd}`));
            chatScrollOffset = -1;
          }
          break;
        }
        case 'enter': {
          const e = obsidianFocusedEntry(obsidianDir);
          if (!e) break;
          if (e.isDir) {
            enterObsidianDirectory(obsidianDir, e.absPath);
            refreshObsidianDir(obsidianDir);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`obsidian cd ${obsidianDir.cwd}`));
            chatScrollOffset = -1;
          } else {
            const targets = obsidianAttachTargets(obsidianDir);
            if (targets.length > 0) {
              attachWorkingDirSelection(targets);
              obsidianDir.selected.clear();
              applyFocusToInputTransition(resolveFocusToInputTransition({
                sourcePane: 'obsidian',
                rememberPane: true,
                reason: 'obsidian-attach-file',
              }));
            }
          }
          break;
        }
        case 'left': {
          // TR-P5: obsidian ← = parent vault dir.
          if (!obsidianDir.cwd) break;
          const parent = dirname(obsidianDir.cwd);
          if (parent && parent !== obsidianDir.cwd) {
            enterObsidianDirectory(obsidianDir, parent);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`obsidian cd ${obsidianDir.cwd}`));
            chatScrollOffset = -1;
          }
          break;
        }
        case 'right': {
          // TR-P5: obsidian → = descend into cursor dir.
          const e = obsidianDir.entries[obsidianDir.cursor];
          if (e?.isDir) {
            enterObsidianDirectory(obsidianDir, e.absPath);
            refreshWorkingDirPreview();
            pushDebugLine(C.muted(`obsidian cd ${obsidianDir.cwd}`));
            chatScrollOffset = -1;
          }
          break;
        }
        case '.':
          obsidianDir.showHidden = !obsidianDir.showHidden;
          refreshObsidianDir(obsidianDir);
          refreshWorkingDirPreview();
          break;
        case 's':
          obsidianDir.sortMode = nextSortMode(obsidianDir.sortMode);
          refreshObsidianDir(obsidianDir);
          refreshWorkingDirPreview();
          break;
      }
      return 'consumed' as const;
    });

    // Phase 0b-3b: skill-browser / skill-file / preview (file) / scratch
    // (late). Completes the 28-branch extract for Phase 0.

    paneKeyRouter.register('skill-browser', async (key) => {
      // ── Skill Browser pane (V3) ──
      // Picks which skill the Skill File pane reflects. Cursor
      // movement auto-refreshes the file list + preview so scanning
      // skills feels immediate.
      //
      // Phase 7 Batch F — cursor scroll keys delegate to the list
      // widget's Cursorable behavior on wd-skill-browser.
      // skillView.skillCursor stays the dashboard-local source of
      // truth; bridge pre/post. Side-effect refreshSkillFiles +
      // refreshWorkingDirPreview fire when cursor moves (widget
      // doesn't know about inter-pane coupling).
      if (runListPaneCursorBridge({
        key,
        itemCount: skillView.skills.length,
        currentCursor: skillView.skillCursor,
        widgetState: widgetHost.get('wd-skill-browser') as {
          state: { cursor: number; items: string[] };
        } | null,
        setWidgetCursor: (inst, cursor) => { inst.state.cursor = cursor; },
        getWidgetCursor: inst => inst.state.cursor,
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-skill-browser', key); },
        setCursor: (nextCursor) => { skillView.skillCursor = nextCursor; },
        resetOffsetToHome: () => { skillView.skillOffset = 0; },
        onCursorChanged: () => {
          refreshSkillFiles(skillView);
          refreshWorkingDirPreview();
        },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`skill-browser.cursor.${phase}-dispatch`, key.name || '(empty)', payload)
          : undefined,
      })) {
        return 'consumed' as const;
      }
      switch (key.name) {
        case 'enter': {
          // Commit-style selection now drops into the input prompt
          // prefilled with `/run-skill <name> ` so the user can
          // type the argument and press Enter again to dispatch.
          // Previously Enter just shifted focus to the file pane
          // (SKILL.md viewer), which meant you had to hop out of
          // the browser, type `/run-skill foo` manually, and
          // remember exact spelling — extra friction for what is
          // the hottest path on this pane.
          const s = skillFocusedSkill(skillView);
          if (s) {
            inputPrefixState.set(`/run-skill ${s.name} `);
            applyFocusToInputTransition(resolveFocusToInputTransition({
              sourcePane: 'skill-browser',
              rememberPane: true,
              reason: 'skill-run-prefill',
            }));
          }
          break;
        }
        case 'c': {
          // Copy the cursor skill's NAME (not its dir). The name
          // is what the user pastes into `/skill <name>`, pair
          // wizards, and cross-machine conversations; the dir is
          // only useful on this host. `ㅊ` remaps to `c` via
          // parseKey's jamo→en mapper.
          const s = skillFocusedSkill(skillView);
          await copyRootPathToLog(s?.name, 'skill name');
          break;
        }
        // TR-P4: arrow pane-nav removed; Tab is the sole path.
      }
      return 'consumed' as const;
    });

    paneKeyRouter.register('skill-file', async (key) => {
      // ── Skill File pane (V3) ──
      // The flattened file listing of the currently selected skill.
      // Enter on the manifest focuses preview (read-only), Enter on
      // a code file attaches it to input like any other pane.
      //
      // Phase 7 Batch F — cursor scroll keys delegate to the list
      // widget's Cursorable behavior on wd-skill-file.
      // skillView.fileCursor stays the dashboard-local source of
      // truth; bridge pre/post. Preview refresh on cursor move.
      if (runListPaneCursorBridge({
        key,
        itemCount: skillView.files.length,
        currentCursor: skillView.fileCursor,
        widgetState: widgetHost.get('wd-skill-file') as {
          state: { cursor: number; items: string[] };
        } | null,
        setWidgetCursor: (inst, cursor) => { inst.state.cursor = cursor; },
        getWidgetCursor: inst => inst.state.cursor,
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-skill-file', key); },
        setCursor: (nextCursor) => { skillView.fileCursor = nextCursor; },
        resetOffsetToHome: () => { skillView.fileOffset = 0; },
        onCursorChanged: () => { refreshWorkingDirPreview(); },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`skill-file.cursor.${phase}-dispatch`, key.name || '(empty)', payload)
          : undefined,
      })) {
        return 'consumed' as const;
      }
      switch (key.name) {
        case 'space':
          skillToggleSelection(skillView); break;
        case 'A':
          skillToggleSelectAll(skillView); break;
        case 'a': {
          const targets = skillAttachTargets(skillView);
          if (targets.length > 0) {
            attachWorkingDirSelection(targets);
            skillView.selected.clear();
          }
          break;
        }
        case 'c': {
          // Copy the cursor file's absolute path with a persistent
          // log line. `ㅊ` remaps to `c` via parseKey's jamo→en
          // mapper. The manifest row is also a file so no dir
          // branch needed here.
          const e = skillFocusedFile(skillView);
          await copyRootPathToLog(e?.absPath, 'file');
          break;
        }
        case 'enter': {
          const e = skillFocusedFile(skillView);
          if (!e) break;
          if (e.isManifest) {
            setWorkingFocus('preview', 'skill-file-manifest-preview');
            refreshWorkingDirPreview();
          } else {
            const targets = skillAttachTargets(skillView);
            if (targets.length > 0) {
              attachWorkingDirSelection(targets);
              skillView.selected.clear();
              applyFocusToInputTransition(resolveFocusToInputTransition({
                sourcePane: 'skill-file',
                rememberPane: true,
                reason: 'skill-file-attach',
              }));
            }
          }
          break;
        }
        // TR-P4: arrow pane-nav removed; Tab is the sole path.
      }
      return 'consumed' as const;
    });

    paneKeyRouter.register('preview', (key) => {
      // ── Preview pane ──
      // T3-C2 — when the vi editor is mounted, it owns every
      // keystroke except Tab (pane nav) and the top-level
      // chords already handled above. save/quit lifecycle is
      // driven from handleViEditorKey.
      if (viEditor && key.name !== 'tab') {
        handleViEditorKey(key);
        draw();
        return 'consumed';
      }
      const { rows: tr } = termSize();
      const listH = Math.max(1, Math.floor(tr * 0.6) - 2);
      const halfPage = Math.max(1, Math.floor(listH / 2));
      const maxOff = Math.max(0, dockedPreview.previewLines.length - listH);
      if (runScrollPaneBridge({
        key,
        widgetState: widgetHost.get('wd-preview') as {
          state: {
            scroll: number;
            maxScroll?: number;
            pageSize?: number;
            halfPageSize?: number;
          };
        } | null,
        currentScroll: dockedPreview.previewOffset,
        maxScroll: maxOff,
        pageSize: listH,
        halfPageSize: halfPage,
        acceptsHalfPageCtrl: true,
        setWidgetScroll: (inst, scroll) => { inst.state.scroll = scroll; },
        getWidgetScroll: inst => inst.state.scroll,
        configureWidget: (inst) => {
          inst.state.maxScroll = maxOff;
          inst.state.pageSize = listH;
          inst.state.halfPageSize = halfPage;
        },
        dispatchKey: () => { dispatchKeyToWidget(widgetHost, 'wd-preview', key); },
        applyNextScroll: (nextScroll) => {
          dockedPreview.previewOffset = nextScroll;
        },
        debugLog: debug.enabled
          ? (phase, payload) => debug.log(`preview.scroll.${phase}-dispatch`, key.name || '(empty)', payload)
          : undefined,
      })) {
        return 'consumed' as const;
      }
      switch (key.name) {
        // TR-P4: arrows no longer move focus; Tab does.
        case 'enter':
          {
            applyFocusToInputTransition(resolveFocusToInputTransition({
              sourcePane: 'preview',
              rememberPane: true,
              reason: 'preview-enter',
            }));
            break;
          }
        // Preview source. `m` cycles through the values that
        // make sense for the current view (Obsidian / Skill only
        // surface in V2 / V3 respectively). Direct keys: w =
        // working, o = obsidian, k = skill, s = smart.
        case 'm': {
          setDockedPreviewSource(cyclePreviewSourceForView(workingDir.view, dockedPreview.sourceMode));
          break;
        }
        case 'w': setDockedPreviewSource('working'); break;
        case 'o':
          if (workingDir.view === 2) setDockedPreviewSource('obsidian');
          else refreshWorkingDirPreview({ force: true });
          break;
        case 'k':
          if (workingDir.view === 3) setDockedPreviewSource('skill');
          else refreshWorkingDirPreview({ force: true });
          break;
        case 's': setDockedPreviewSource('smart'); break;
        case 'p':
          setDockedPreviewBinding(dockedPreview.pinned ? 'follow' : 'pinned');
          pushDebugLine(C.muted(`preview binding: ${resolvePreviewBindingMode(dockedPreview)}`));
          chatScrollOffset = -1;
          break;
        case 'f':
          setDockedPreviewBinding('follow');
          pushDebugLine(C.muted('preview binding: follow'));
          chatScrollOffset = -1;
          break;
        // Phase T: spawn an embedded terminal in this pane. Same
        // code path as the `Ctrl+B t` global chord.
        case 't': case 'ㅅ':
          openPreviewTerminal();
          break;
      }
      return 'consumed' as const;
    });

    paneKeyRouter.register('scratch', async (key) => {
      // Ctrl+N opens the dedicated memo companion.
      if (key.ctrl && (key.name === 'n' || key.name === 'ㅜ')) {
        openMemoCompanion();
        return 'consumed';
      }

      // Ctrl+W (no chord armed — chord would have consumed the
      // key earlier) closes the scratch pane. Reopen via the ^B ^S chord.
      if (key.ctrl && (key.name === 'w' || key.name === 'ㅈ')) {
        scratchClosed = true;
        userClosedPanes.add('scratch');
        applyFocusToPaneTransition(resolveFocusToPaneTransition({
          targetPane: 'log',
          reason: 'scratch-ctrl-w-close',
        }));
        return 'consumed';
      }

      // Preview mode — default.
      const { rows: tr } = termSize();
      const listH = Math.max(1, Math.floor(tr * 0.45) - 2);
      const halfPage = Math.max(1, Math.floor(listH / 2));
      const maxOff = Math.max(0, scratchLines.length - listH);
      switch (key.name) {
        case 'j': case 'down':
          scratchOffset = Math.min(scratchOffset + 1, maxOff); break;
        case 'k': case 'up':
          scratchOffset = Math.max(0, scratchOffset - 1); break;
        case 'd':
          if (key.ctrl) scratchOffset = Math.min(scratchOffset + halfPage, maxOff);
          break;
        case 'u':
          if (key.ctrl) scratchOffset = Math.max(scratchOffset - halfPage, 0);
          break;
        case 'g': case 'home': scratchOffset = 0; break;
        case 'G': case 'end': scratchOffset = maxOff; break;
        case 'pagedown':
          scratchOffset = Math.min(scratchOffset + listH, maxOff); break;
        case 'pageup':
          scratchOffset = Math.max(0, scratchOffset - listH); break;
        case 'c':
          // Clear the scratchpad — keeps the title row blank too
          // so the pane visibly resets without a stale label.
          setScratch('', []); break;
        case 'l':
          void openClipboardCompanion().then(() => draw());
          break;
        // TR-P4: arrows no longer move focus; Tab does.
        case 'enter':
          {
            applyFocusToInputTransition(resolveFocusToInputTransition({
              sourcePane: 'scratch',
              rememberPane: true,
              reason: 'scratch-preview-enter',
            }));
            break;
          }
      }
      return 'consumed' as const;
    });

    // U3c — boot the dashboard's ACP client surface. Phase 5c-2
    // (2026-04-25) retired the legacy `streamLLMWithTools` direct
    // path so every turn routes through this in-process ACP server +
    // client pair. Getters follow RESEARCH-u3c-dashboard-turn-event-
    // fanout.md §5.1 (injection over closure capture) so autoCompact
    // history rewrites + per-turn runtime mutations always reach the
    // bridge fresh. The round-trip test covers the server-side half
    // of the event fanout.
    //
    // `acpTurnRef` carries per-turn mutables (abortCtrl / surface
    // profile / search-planner / optional tool specs) so the getters
    // + dispatcher can stay at boot scope without closing over stale
    // state; the turn loop populates + resets this ref on each send.
    const acpTurnRef = createDashboardAcpTurnRef();
    // Phase 5a — pre-resolve the async imports the dispatch path
    // uses so the dispatcher closure itself can be sync + typed.
    // These land eagerly at boot so Phase 5b's flag-ON branch doesn't
    // pay the dynamic-import cost on the hot send() path. If any
    // import fails the dispatcher short-circuits (same no-behavior-
    // change contract as Phase 2's noop wiring).
    let acpToolRuntime: typeof import('../tool-runtime/index.js') | null = null;
    let acpPersistToolOutputPreview:
      | typeof import('../tool-runtime/truncation-store.js').persistToolOutputPreview
      | null = null;
    let acpPtyAvailable: (() => boolean) | null = null;
    // ⭐ The most recently assembled catalog + a self-reference to the dispatcher.
    //  Both exist for one reason: the Agent family's runtime path needs
    //  `ctx.agentHostTools` / `ctx.agentDispatchTool` so a sub-agent inherits the
    //  parent's tools. `agent.ts` strips `Agent` from the child set ("one level of
    //  nesting only"), so the self-reference cannot recurse without bound.
    //
    //  ⚠️ Named "last assembled", NOT "this turn": the scope is the session, and
    //     nothing here scopes it per turn. Today the dashboard runs one ACP turn at
    //     a time so last-assembled == current-turn, but if concurrent or re-entrant
    //     turns ever land, a sub-agent could inherit another turn's catalog. Whoever
    //     adds turn concurrency must key this by turn (or session+turn) first.
    let acpTurnToolSpecs: LLMToolSpec[] = [];
    let acpDispatchToolSelf: CoreTurnDispatchTool | null = null;
    const trMod = await import('../tool-runtime/index.js');
    trMod.registerAllDefaultToolRuntimes();
    acpToolRuntime = trMod;
    acpPersistToolOutputPreview = (
      await import('../tool-runtime/truncation-store.js')
    ).persistToolOutputPreview;
    acpPtyAvailable = (await import('../pty-shell/registry.js')).ptyAvailable;
    const dashboardAcpBootResult = await bootDashboardAcpSession({
        ...(opts.remote ? {
          remote: opts.remote,
          onRemoteDisconnect: () => {
            daemonAttached = false;
            pushChatLine(C.warning('  ⚠ 데몬 연결이 끊겼다 · 입력 중인 글은 그대로다 · 다시 붙으려면 TUI 를 다시 띄워라'));
            draw();
          },
        } : {}),
        ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
        getCwd: () => getSessionCwd(),
        getChatHistory: () => chat.history,
        // Wave 4 (2026-05-04) — extract tool resolution so the
        // preamble builder can read enabledTools and emit session-
        // specific guidance. ACP boot calls getPreamble/getTools as
        // separate callbacks per turn; without sharing the resolution
        // they'd diverge or session-guidance would always run empty.
        // Two calls per turn is OK — buildSessionRuntimeToolSpecs is
        // pure assembly over already-loaded specs.
        getPreamble: ({ sessionId, userText }) => {
          const runtime = acpToolRuntime;
          const tools = runtime
            ? buildSessionRuntimeToolSpecs({
                userText,
                hostTools: pluginHost.hostLLMTools(),
                runtimeTools: runtime.listToolRuntimes('tui'),
                pluginTools: pluginHost.activePluginLLMTools(),
                optionalTools: acpTurnRef.optionalSpecs,
                surface: acpTurnRef.turnProfile?.surface,
                rich: false,
              })
            : [];
          return [
            ...tuiChatPersonaMessages(currentChatPersonaSessionId(), chatPersonaSelection),
            ...buildDashboardTurnPreamble({
              userText,
              sessionId,
              cwd: getSessionCwd(),
              turnProfile: acpTurnRef.turnProfile,
              userConfig: getUserConfig(),
              // Resolved per-turn so a mid-session model switch (codex →
              // claude or vice-versa) takes effect immediately. Drives the
              // codex-only behavioral addendum (fix L-1) inside the
              // universal preamble.
              modelFamily: getModelFamily(inspectActiveProvider().model),
              rich: false,
              enabledTools: tools.map(t => t.name),
            }),
          ];
        },
        getTools: ({ userText }) => {
          const runtime = acpToolRuntime;
          if (!runtime) return [];
          const tools = buildSessionRuntimeToolSpecs({
            userText,
            hostTools: pluginHost.hostLLMTools(),
            runtimeTools: runtime.listToolRuntimes('tui'),
            pluginTools: pluginHost.activePluginLLMTools(),
            optionalTools: acpTurnRef.optionalSpecs,
            surface: acpTurnRef.turnProfile?.surface,
            rich: false,
          });
          // ⭐ Remember this turn's catalog so a spawned sub-agent can inherit it.
          //
          //  `dispatchAgent` computes `childTools = (hostTools ?? []).filter(...)`,
          //  so WITHOUT this the sub-agent starts with ZERO tools — it cannot read
          //  or edit anything, which is the whole point of delegating code work.
          //  Exposing `Agent` without this wiring is worse than not exposing it:
          //  the model picks a delegate that provably cannot act.
          acpTurnToolSpecs = tools;
          return tools;
        },
        // R2 essential TUI execution boundary: ACP receives the same
        // Codex-first decision as every other surface. The core bridge now
        // supplies userText to resolveModel, preserving explicit pins and
        // making this the actual model override rather than a display hint.
        getActiveModel: ({ userText }) => {
          const cfg = getUserConfig();
          const decision = resolveRouteDecision({
            provider: cfg.llm.provider,
            configuredModel: inspectActiveProvider().model,
            text: userText,
            routePolicy: cfg.llm.routePolicy,
          });
          // Badge truthfulness(2026-07-19 goal-exec) — resolveRouteDecision 의 codex
          // tier-policy 브랜치는 curated effort(예: balanced=low)를 찍지만, codex provider 는
          // 그 값을 wire 로 보내지 않는다: 실제 effort 는 effectiveReasoningLevel(cfg)(config
          // 주도, reasoningLevel 미설정 시 model-default high). 그대로 두면 완료 뱃지가
          // "terra(low)" 로 떠 사용자가 모델이 약하게 돈다고 오해한다(실제 high). 실제 wire
          // effort 로 덮어써 뱃지를 진실하게. decision.effort 는 표시 전용이라 라우팅 무영향.
          const trueEffort = effectiveReasoningLevel(cfg.llm, decision.provider, decision.model);
          const badgedDecision = trueEffort && trueEffort !== 'off'
            ? { ...decision, effort: trueEffort }
            : decision;
          recordCurrentRouteDecision('dashboard', badgedDecision);
          if (debug.enabled) debug.log('llm.route-decision', 'dashboard-acp', {
            provider: decision.provider, model: decision.model, mission: decision.mission, source: decision.source,
          });
          return decision.model || null;
        },
        // ⭐ The assignment is deliberate, not a typo: it captures a reference to
        //  this very dispatcher so `agentDispatchTool` below can route a
        //  sub-agent's tool calls back through it. A plain named const would need
        //  the closure hoisted out of this literal; this keeps the diff local.
        dispatchTool: acpDispatchToolSelf = async (name, args, ctx) => {
          const runtime = acpToolRuntime;
          const persist = acpPersistToolOutputPreview;
          if (!runtime || !persist) {
            return { error: 'acp dispatch unavailable (tool-runtime not loaded)' };
          }
          const uc = getUserConfig();
          const provider = inspectActiveProvider();
          const contextUserText = ctx?.userText;
          const turnRefUserText = acpTurnRef.userText;
          const hasParentTurnAbortSignal = acpTurnRef.abortCtrl?.signal !== undefined;
          observeDashboardToolDispatchSignal({
            toolName: name,
            turnIndex: ctx?.turnIndex ?? null,
            signalSource: hasParentTurnAbortSignal ? 'parent-turn' : 'fallback',
            hasParentTurnAbortSignal,
            signalAlreadyAborted: (acpTurnRef.abortCtrl?.signal ?? new AbortController().signal).aborted,
          });
          const result = await dispatchDashboardSessionRuntimeTool(name, args, {
            contextUserText,
            turnRefUserText,
            muted: C.muted,
            pushChatLine,
            draw,
            signal: acpTurnRef.abortCtrl?.signal ?? new AbortController().signal,
            toolCallId: ctx?.callId,
            // ⛔⭐ 폴백은 `''` 가 아니라 `undefined` 다 — 「안 넘김」과 「말했는데 어휘가 없음」은 «다른 값»이다.
            //   harnessMentionState(session-runtime 소비처)는 `undefined → 'absent'` · `'' → 'not-matched'` 로
            //   가른다. `?? ''` 로 접으면 그 둘이 같은 값이 되고, 그것이 2026-08-06 에 「TUI 가 하니스에게
            //   «사용자가 아무 말도 안 했다»고 말한다」로 나타났다(#7380 이 고친 결함 · OBS-T46 사슬 ①).
            //   ⛔⭐ 소스는 «둘 다» 본다 — 2026-08-06 라이브 실측이 `ctx?.userText` 단독을 반증했다.
            //   `#7385` 가 소스를 `acpTurnRef.userText` → `ctx?.userText` 로 옮겼고 나(`#7388`)는 그것을
            //   「개선」이라 «단정»하고 지켰다. ⛔ 안 쟀다. 그런데 이 ACP 경로에서 `ctx.userText` 는
            //   «안 온다» — 사용자가 분명히 친 턴인데 하니스 프론트도어에 `harnessMention='absent'` 가 찍혔다
            //   (20:57 실측 · pty_d279c8ec). 반면 `acpTurnRef.userText` 는 턴 시작에서 채워지는 자리다
            //   (turn-lifecycle-runtime.ts `ref.userText = deps.userText`).
            //   ⇒ 있는 쪽을 쓴다. 둘 다 없을 때만 `undefined`(=진짜 「안 넘김」).
            modelFamily: getModelFamily(provider.model),
            searchPlannerState:
              acpTurnRef.searchPlannerState
              ?? createSearchPlannerState({ maxAutoNarrowCandidates: 2 }),
            // CC (2026-04-25) — forward the LLM router's turn index so
            // the planner can allow same-turn parallel fan-out.
            turnIndex: ctx?.turnIndex,
            ptyDashboardOn:
              uc.shell.allowDashboardPty === true && (acpPtyAvailable?.() ?? false),
            getToolRuntime: (toolName) => runtime.getToolRuntime(toolName),
            dispatchToolRuntime: (toolName, input, toolCallId) =>
              runtime.dispatchToolByName(toolName, input, {
                surface: 'tui',
                toolCallId,
                signal: acpTurnRef.abortCtrl?.signal,
                // ⭐ Agent-family context. Without these two the sub-agent runs
                //  text-only (see getTools above). `agentDispatchTool` routes the
                //  child's calls back through THIS dispatcher so the child gets the
                //  same policy/truncation treatment as the parent — not a second,
                //  laxer path.
                agentHostTools: acpTurnToolSpecs,
                // ⛔ Forward the parent's `ctx` — without it `turnIndex` is lost and
                //    the child's output is attributed to the wrong turn by the
                //    truncation/persist path (and the search planner loses its
                //    same-turn parallel signal).
                agentDispatchTool: (childName, childArgs) =>
                  acpDispatchToolSelf
                    ? acpDispatchToolSelf(childName, childArgs, ctx)
                    : Promise.resolve({ error: 'parent dispatcher unavailable' }),
              }),
            dispatchPluginTool: (toolName, input) =>
              pluginHost.dispatchTool(toolName, input),
          });
          // Mirror the direct-path truncation wrapper at
          // dashboard/index.ts L19917-19932 so large tool outputs
          // land in the preview store + the LLM sees the short
          // preview rather than the raw blob.
          if (typeof result === 'string') {
            const persisted = await persist(result, {
              sessionId: String(process.pid),
              toolName: name,
              config: uc.chat.toolOutput,
              allowAgentReference: false,
            });
            return persisted.output;
          }
          if (result && typeof (result as { output?: unknown }).output === 'string') {
            const persisted = await persist(
              (result as { output: string }).output,
              {
                sessionId: String(process.pid),
                toolName: name,
                config: uc.chat.toolOutput,
                allowAgentReference: false,
              },
            );
            return {
              ...(result as Record<string, unknown>),
              output: persisted.output,
            };
          }
          return result;
        },
        pushTurnToolHistory: (msgs) => {
          for (const m of msgs) chat.history.push(m as ChatMessage);
        },
        // F1 — Phase 3 · ACP `requestPermission` gateway. Routes
        // every inbound permission request to the dashboard's shared
        // approval modal so the UX matches direct-dispatch approvers
        // (Edit/Write/RunShell/TerminalModalInject etc.). Phase 4
        // swaps tool-specific gateways per site; this generic
        // fallback keeps the bridge functional until then.
        approvalGateway: async ({ toolName, toolArgs }) => {
          const argsPreview = JSON.stringify(toolArgs).slice(0, 120);
          return openGenericApproval({
            title: 'Approve tool via ACP?',
            prompt: toolName || '(unnamed tool)',
            detail: argsPreview ? `args: ${argsPreview}` : undefined,
          });
        },
    });
    const dashboardAcpSession: DashboardSession = dashboardAcpBootResult.session;
    daemonAttached = !!opts.remote && dashboardAcpBootResult.mode !== 'in-process';
    // ⭐ `B3` — 턴 중 발화를 «도는 턴»에 넣을 때 쓰는 키.
    try { acpSessionIdRef.current = dashboardAcpSession.currentSessionId ?? null; } catch { /* 없으면 넣지 않는다 */ }
    pushDebugLine(C.muted('[acp-boot] dashboard ACP session ready'));
    // User-visible mode indicator. Without this, a user who set
    // ELANOUS_REMOTE has no way to tell whether the
    // attach actually succeeded — the attached daemon mode is useful
    // chat transcript context, but the local in-process fallback is
    // runtime plumbing and belongs in the debug log instead.
    if (opts.remote) {
      const authNote = opts.remote.token ? 'token' : 'no-auth';
      const labelNote = opts.remote.label ? ` · ${opts.remote.label}` : '';
      chatLines.push(C.success(`  ✓ attached to remote daemon: ${opts.remote.url} (${authNote})${labelNote}`));
    } else {
      pushDebugLine(C.muted('  in-process ACP (no daemon attach · set ELANOUS_REMOTE to attach)'));
    }
    // Tier 1 daemon-resume status. Three branches:
    //   - resumed: attachExisting succeeded · the daemon's prior
    //     turns are now bound to this dashboard. Replay history via
    //     REST (when an HTTP base is derivable) so the user sees the
    //     past conversation in chat.history.
    //   - new (with fallback reason): the resume id was bad / unknown
    //     — the boot fell back to a fresh session. Surface the reason
    //     so the user knows they're on a different session than asked.
    //   - new (no resume requested): nothing extra to render.
    if (dashboardAcpBootResult.mode === 'resumed' && dashboardAcpBootResult.sessionId) {
      const sid = dashboardAcpBootResult.sessionId;
      chatLines.push(C.success(`  ✓ resumed daemon session: ${sid}`));
      // Best-effort REST history replay over the remote HTTP/WS endpoint.
      if (opts.remote) {
        const httpBase = deriveDaemonHttpBase(opts.remote.url);
        if (httpBase) {
          const past = await fetchDaemonSessionHistory(
            httpBase,
            sid,
            opts.remote.token,
          );
          if (past && past.length > 0) {
            // Replace chat.history (preserve the dashboard's system
            // prompt — same shape as /session load at L18458).
            const sysFromDash = chat.history.find((m) => m.role === 'system');
            chat.history.length = 0;
            if (sysFromDash) chat.history.push(sysFromDash);
            for (const m of past) {
              if (m.role === 'system' && sysFromDash && m.content === sysFromDash.content) continue;
              chat.history.push(m as ChatMessage);
            }
            const turns = past.length;
            chatLines.push(C.muted(`    ${turns} turn${turns === 1 ? '' : 's'} restored. Preview of last 5:`));
            // BACKLOG #1 — markdown-aware preview rendering. Replaces
            // the previous one-line `slice(0, 100)` snippet so tables
            // / bold / lists in replayed turns look the same as when
            // they were originally streamed (`formatResponse` path).
            const previewWidth = Math.max(40, termSize().cols - 8);
            const previewWrap = getUserConfig().chat.rendering.wrap;
            const previewLines = renderReplayPreviewLines(past, {
              maxWidth: previewWidth,
              wrapOpts: previewWrap,
            });
            for (const line of previewLines) chatLines.push(line);
          } else {
            chatLines.push(C.muted(`    no prior turns found for ${sid}.`));
          }
        }
      }
    } else if (dashboardAcpBootResult.mode === 'new' && dashboardAcpBootResult.resumeFallbackReason) {
      // The user asked to resume but the daemon rejected the id —
      // we transparently started a fresh session so nothing's broken,
      // but surface the reason so they don't think the resume "just
      // worked silently".
      const reason = dashboardAcpBootResult.resumeFallbackReason;
      const newId = dashboardAcpBootResult.sessionId ?? '(unknown)';
      chatLines.push(C.warning(`  ⚠ resume failed (${reason}); started new session: ${newId}`));
    } else if (opts.resumeSessionId && !opts.remote) {
      // Match `/session load <prefix>` for in-process boot: resolve the
      // local prefix, preserve the stock system prompt, and attach the
      // restored session for subsequent persistence.
      const { historyFromSession, resolveSessionId, setActiveSessionId } = await import('../session/index.js');
      const resume = resumeInProcessDashboardSession(opts.resumeSessionId, {
        resolveSessionId,
        historyFromSession,
        chatHistory: chat.history,
        setAttachedSessionId: (sessionId) => { attachedSessionId = sessionId; },
        setActiveSessionId,
      });
      if (!resume.resumed) {
        chatLines.push(C.warning(`  ⚠ resume failed (${resume.reason}); started new session`));
      } else {
        chatLines.push(C.success(`  ✓ resumed local session: ${resume.sessionId}`));
        chatLines.push(C.muted(`    ${resume.turns} turns restored. Next turn continues this conversation.`));
      }
    }
    // 제안은 세션 작업 폴더 기준 — 시작 폴더 한 번이 아니라 폴더가 바뀔 때마다 다시 계산한다(IA1 리뷰 must-fix).
    const nextProjectSuggestion = createProjectSuggester(suggestProjectForFolder);
    const pushProjectSuggestion = (folder: string): void => {
      const project = nextProjectSuggestion(folder);
      if (project) chatLines.push(C.muted(`  Project suggestion: ${project.name} (${project.id})`));
    };
    if (dashboardAcpBootResult.mode !== 'resumed' && !chat.history.some((message) => message.role !== 'system')) {
      pushProjectSuggestion(getSessionCwd());
    }
    subscribeSessionCwd((state) => { pushProjectSuggestion(state.cwd); });
    chatScrollOffset = -1;
    void renderDashboardFirstScreenBand({
      history: chat.history,
      lines: chatLines,
      width: Math.max(0, termSize().cols - 4),
      draw: () => draw(),
      observe: (data) => { try { debug.log('dashboard.first-screen-band', 'resolved', data); } catch { /* observation is best-effort */ } },
    });

    tuiSeatAskTimer = setInterval(pollTuiSeatAnswers, 10_000);
    tuiSeatAskTimer.unref();
    pollTuiSeatAnswers();
    while (true) {
      draw();
      let wdInputExited = false;   // set true when the input-mode loop exits this iter

      // ── Phase 4a/4b: auto-enter input when focus = 'input' ──
      // Working-dir treats input as the default focus: the user doesn't
      // press `/` to open the prompt. We synthesize an entry SENTINEL
      // key so the existing input-entry prelude handles both user-
      // initiated and auto-entered input with identical behavior.
      // ★ 2026-07-12 — 합성 키가 `Ctrl+L` 이던 시절의 잔재 제거: Ctrl+L 이
      // force-redraw 로 재정의되자 합성키가 redraw 로 소비돼 입력 진입에
      // 영원히 실패하는 busy-loop(무한 깜빡임·키 불능)이 됐다. 센티널은
      // 어떤 라우터/글로벌 액션과도 충돌하지 않는다. Suppressed when
      // a plugin is active so sync/etc can drive their own key flow,
      // and when the chord is waiting so the prefix completes correctly.
      const chatMainVisibility = chatMainInputVisibilityState();
      const wdAutoInput = shouldAutoEnterChatMainInput(chatMainVisibility);

      const key: import('../tui.js').Key = wdAutoInput
        ? { name: CHAT_MAIN_AUTO_ENTRY_KEY_NAME, ctrl: false, shift: false }
        : await readKey();
      const helpModal = currentTransientTerminalModal('dashboard-help');
      if (key.name === 'escape' && helpModal) {
        helpModal.dispose();
        draw();
        continue;
      }

      // U-0 · recompute ViewMode at the top of every key dispatch
      // loop iteration. This is the one natural "mode re-evaluation"
      // point — any flag that changed between the previous iteration
      // (streaming start, chord arm, plugin activate, modal push)
      // now reflects in `currentViewMode` + `CKS.viewModeKind` before
      // the event is dispatched. syncDashboardViewModeToContextKeys
      // short-circuits on same-kind so this is essentially free when
      // no mutation happened.
      recomputeViewMode();

      // PR-S1V.D4-γ (2026-04-29 · review-revised) — outside-chat-main
      // dictation chord routing. PR #1115 review pinpointed that plain
      // `Space` hold globally collides with too many existing Space-
      // binding surfaces (browser/obsidian/skill-file selection,
      // scheduler form input, preview pager, popup/VW terminal, modals
      // /pickers). The reviewer's recommended split:
      //
      //   - **`Ctrl+Shift+Space`** = global dictation chord. Modifier-
      //     only carries no char-input role; safe across browse/pane/
      //     popup/terminal because surface Space bindings live on
      //     plain `Space`. Wired here as the always-on outer hook —
      //     chat-main onPreKey already owns it inside input focus
      //     (D4-β), so the two paths are mutually exclusive at the
      //     dispatch level (chat textInput's own readKey loop never
      //     reaches this outer hook).
      //
      //   - **plain `Space`** = scoped allowlist only. Default deny;
      //     point-of-truth `isAllowlistedDictationSurface()` will
      //     return `true` only for surfaces explicitly verified to
      //     have no native Space semantics. Initial allowlist is
      //     intentionally empty — every existing PaneFocus value is
      //     a known consumer (selection toggle / pager next-page /
      //     form input / log scroll / etc.). The seam stays so we
      //     can opt specific surfaces in after they're cleared by
      //     dogfood; until then the plain-Space branch is inert.
      //
      // Both branches share the same skip rules: voice host must be
      // booted + idle, chat-main must not own the working focus
      // (D4-β scope), and PTY/terminal panes still defer the *plain*
      // Space path entirely (Ctrl+Shift+Space stays alive there per
      // the reviewer's note "충돌 보이면 그때 예외 surface 추가").
      // TEMP DEBUG (2026-04-29 · fix/voice-runtime-tdz-2 branch) — log
      // the gate evaluation so dogfood logs show *why* the chord did or
      // didn't fire instead of just "no dictation event". Remove with
      // the chord-trial revert.
      if (debug.enabled && !key.mouse && key.ctrl && key.shift) {
        const hostStateKind = voiceInputHost ? voiceInputHost.getState().kind : null;
        debug.log('voice.outer-hook.gate', 'eval', {
          keyName: key.name,
          ctrl: !!key.ctrl,
          shift: !!key.shift,
          alt: !!key.alt,
          hasVoiceHost: !!voiceInputHost,
          hasDetector: !!voiceLongPressDetector,
          hostState: hostStateKind,
          focus: workingDir.focus,
          willEnter:
            !!voiceInputHost
            && !!voiceLongPressDetector
            && hostStateKind === 'idle'
            && workingDir.focus !== 'input',
        });
      }
      // These two vars are assigned only inside the async boot IIFE
      // (a closure) and reset to null at the bottom of this `while(true)`
      // loop, so TS's loop-carried flow analysis collapses them to
      // `never` here (a false positive — the runtime value is the booted
      // host). Assert the true declared type so the guards below narrow.
      const voiceHostFlow = voiceInputHost as VoiceInputHost | null;
      const voiceDetectorFlow = voiceLongPressDetector as SpaceLongPressDetector | null;
      if (
        voiceHostFlow
        && voiceDetectorFlow
        && voiceHostFlow.getState().kind === 'idle'
        && workingDir.focus !== 'input'
      ) {
        const focusedTerminalPane = false;

        // Branch 1 — Ctrl+Shift+D trial chord. TEMP DEBUG (2026-04-29):
        // toggle pattern instead of long-press detector. First press
        // starts dictation, second press stops. Debounce in
        // toggleDictationFromChord swallows OS auto-repeat duplicates.
        // Restore detector wiring once chord question is settled.
        if (isDictationHoldKey(key)) {
          if (debug.enabled) {
            debug.log('voice.outer-hook.dictation.hit', 'branch-1-chord-toggle', {
              keyName: key.name,
              kind: key.kind ?? 'press',
              dictState: voiceHostFlow.getDictationState(),
            });
          }
          // Release events are ignored under toggle — only press toggles.
          if (key.kind !== 'release') {
            toggleDictationFromChord('outer-hook', key.name);
          }
          // Always consume — chord is a deliberate user signal, not
          // ordinary input.
          continue;
        }

        // Branch 2 — plain Space (scoped allowlist). Currently the
        // allowlist is empty so every plain Space passes through to
        // the priority route untouched, matching the "global plain
        // Space 비추천" finding from the PR review. As surfaces are
        // verified safe via dogfood, add their PaneFocus values to
        // `isAllowlistedDictationSurface` below.
        if (isPlainSpaceHoldKey(key)) {
          // TEMP DEBUG (2026-04-29 · fix/voice-runtime-tdz-2 trial) —
          // log Branch 2 decision so dogfood can prove plain Space hits
          // the allowlist + non-terminal-pane gate.
          const allowlistHit = isAllowlistedDictationSurface(workingDir.focus);
          if (debug.enabled) {
            debug.log('voice.outer-hook.branch2', 'eval', {
              keyName: key.name,
              kind: key.kind ?? 'press',
              focus: workingDir.focus,
              focusedTerminalPane,
              allowlistHit,
              willEnter: !focusedTerminalPane && allowlistHit,
            });
          }
          if (!focusedTerminalPane && allowlistHit) {
            if (debug.enabled) {
              debug.log('voice.outer-hook.dictation.hit', 'branch-2-plain-space', {
                focus: workingDir.focus,
                kind: key.kind ?? 'press',
                detectorState: voiceDetectorFlow.getState(),
              });
            }
            if (key.kind === 'release') {
              voiceDetectorFlow.noteRelease();
            } else {
              voiceDetectorFlow.noteSpaceKey();
            }
            continue;
          }
        }

        // Cancel-by-other-key — same race-fix pattern as the chat-
        // main onPreKey wire (PR #1109 review fix #1). Only await
        // when we're actually terminating an in-flight dictation.
        if (voiceDetectorFlow.getState() !== 'idle') {
          const preState = voiceDetectorFlow.getState();
          voiceDetectorFlow.noteOtherKey();
          if (preState === 'fired') {
            while (voiceHostFlow.getDictationState() !== 'idle') {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
          }
          // The terminator key still flows through the priority route
          // below — only the ordering shifts so the transcript inserts
          // before the terminator is dispatched.
        }

        // TEMP DEBUG TRIAL — ESC stops a toggle-mode dictation. Without
        // this the user could get stuck in `recording` if they forgot
        // the chord. Detector path above handles long-press cancel; this
        // covers the toggle path which doesn't use the detector.
        if (
          key.name === 'escape'
          && !key.ctrl && !key.shift && !key.alt
          && voiceHostFlow.getDictationState() === 'recording'
        ) {
          if (debug.enabled) debug.log('voice.toggle.stop', 'esc-cancel', {});
          void voiceHostFlow.stopDictation();
          while (voiceHostFlow.getDictationState() !== 'idle') {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          // Continue dispatch — ESC still flows through (modal close,
          // input clear, etc.) so we don't `continue` here.
        }
      }

      // PR-S1V.D5 — kitty `>3u` release/repeat event guard. The voice
      // outer-hook block above is the only path that legitimately needs
      // non-press events (chord toggle skips them, plain-Space detector
      // explicitly handles `kind === 'release'` for explicit release
      // timing). Everything below — priority route, widget routing,
      // chat-input dispatcher — was written when `>1u` was the only
      // mode and treats every key as a press. So a kitty release event
      // would otherwise re-fire the press handler and double-dispatch
      // (e.g., ESC press → input-exit-restore-pane, ESC release →
      // pane-escape — observed in dogfood log/debug-20260429195640).
      // Per `tui.ts:158` comment: "Dispatchers that only care about
      // presses should ignore non-press events". Mouse events use
      // `key.action` ('press'/'release'/'drag'/'click'/'double-click')
      // not `key.kind`, so this guard doesn't touch the mouse path.
      if (key.kind && key.kind !== 'press') {
        if (debug.enabled) {
          debug.log('dashboard.dispatch.skip', 'non-press-event', {
            kind: key.kind,
            keyName: key.name,
            ctrl: !!key.ctrl,
            shift: !!key.shift,
            alt: !!key.alt,
          });
        }
        continue;
      }

      const priorityRoute = await routeDashboardPriorityKey(key, {
        inputOwner: chatMainVisibility.inputOwnership?.owner,
        routeBellKey: async (routeKey) => {
          if (!bellOpen || routeKey.mouse) return false;
          const inst = widgetHost.get('wd-notification-bell');
          const def = widgetHost.defFor('wd-notification-bell');
          if (!inst || !def?.onKey) return false;
          const ctx = widgetHost.buildContext('wd-notification-bell') as never;
          const state = inst.state as BellModalState;
          const action = def.onKey(routeKey as never, state, ctx);
          await runDashboardWidgetAction(action, {
            requestRender: requestDashboardRender,
            setWorkingFocus,
            deactivatePlugin: () => pluginHost.deactivate(),
            refreshViewsAfterDeactivate: refreshDashboardViewsFromPlugins,
            submitText: dispatchSidebarSubmit,
            focusReason: 'bell-widget-action',
            handleScopedSubmitText: (text) => {
              const bellAction = resolveBellSubmitAction(text);
              if (!bellAction) return false;
              runBellSubmitAction(bellAction, {
                closeBell: () => {
                  bellOpen = false;
                },
                setFilter: (filter) => {
                  state.filter = filter as NotificationFilter;
                  state.cursor = 0;
                  state.offset = 0;
                  refreshBellInto();
                },
                focusSession: (sid) => {
                  notificationStore.markRead(sid);
                  bellOpen = false;
                  refreshSessionCardsInto();
                  const sidebarInst = widgetHost.get('wd-sessions-sidebar');
                  if (sidebarInst) {
                    const s = sidebarInst.state as SessionsSidebarState;
                    revealSessionInSidebar(s, sid);
                  }
                  setWorkingFocus('sessions-sidebar', 'bell-jump-to-session');
                },
              });
              return true;
            },
          });
          draw();
          return true;
        },
        dispatchPreKey: (routeKey, targetHandlerName) => {
          const questionViewHandler = {
            name: 'question-view',
            handle: (dispatchKey: Key) =>
              routeStreamingApprovalModalKey(dispatchKey) ? 'consumed' as const : 'passthrough' as const,
          };
          const keyDispatch = dispatchDashboardKey(routeKey, composeDashboardKeyHandlers(
            chatMainVisibility.inputOwnership?.owner,
            questionViewHandler,
            [
              {
              name: 'input-core',
              handle: (dispatchKey) => {
                const ev: import('../input-core/event.js').InputEvent = dispatchKey.mouse
                  ? (() => {
                      mouseWiring.preflightHitTarget(dispatchKey.mouse);
                      return inputCoreBuildMouseEventFromDisplay(dispatchKey.mouse, {
                        shift: dispatchKey.shift, ctrl: dispatchKey.ctrl,
                      });
                    })()
                  : inputCoreKeyEvent(dispatchKey);
                if (ev.kind === 'mouse') {
                  inputCorePublishMouseTargetToContextKeys(ev, getDashboardContextKeyService());
                }
                const r = resolveInputCoreEvent(ev);
                if (!r) return 'passthrough';
                if (shouldPassthroughDashboardHostOwnedInputCoreAction(r.actionId)) {
                  if (debug.enabled) {
                    debug.log('input-core', 'host-owned-passthrough', {
                      actionId: r.actionId,
                      matcher: r.matcher,
                    });
                  }
                  return 'passthrough';
                }
                const action = getInputCoreAction(r.actionId);
                if (!action) return 'passthrough';
                try { void action.handler(); }
                catch (e) {
                  if (debug.enabled) {
                    debug.log('input-core', 'handler-error', {
                      actionId: r.actionId, matcher: r.matcher, error: String(e),
                    }, { level: 'error' });
                  }
                }
                return 'consumed';
              },
            },
              {
                name: 'mx-mouse',
                handle: (dispatchKey) => {
                  if (!dispatchKey.mouse) return 'passthrough';
                  return runMxMouseUnifiedDispatch(dispatchKey, dispatchKey.mouse);
                },
              },
            ],
          ), targetHandlerName);
          if (keyDispatch.type !== 'consumed') return false;
          draw();
          return true;
        },
        routeExclusiveTerminalModalKey: (routeKey) => {
          if (terminalModalRouter.current() === null) return false;
          const ev = toDashboardKeyEvent(routeKey);
          const result = terminalModalRouter.handleKey(ev);
          if (result === 'closed') draw();
          return true;
        },
        routeArmedChordKey: async (routeKey) => {
          if (!isChordArmed(chord)) return false;
          disarmChordHud();
          if (routeKey.name === 'escape') return true;
          const chordAction = matchDashboardChordAction(routeKey);
          if (!chordAction) return false;
          await runDashboardChordAction(chordAction);
          return true;
        },
        armPrefixChord: (routeKey) => {
          // ⭐ 2026-08-19 — 코드 리더를 `Ctrl+B` → `Ctrl+X` 로 옮겼다(대표 지시).
          if (!(routeKey.ctrl && (routeKey.name === 'x' || routeKey.name === 'ㅌ'))) return false;
          armChord(chord, () => {
            clearSegment(hud, 'chord');
            try { draw(); } catch { /* TUI torn down */ }
          });
          setSegment(hud, 'chord', C.warning('[^X]'), 1);
          return true;
        },
        // Step 0 force-quit — fires from anywhere (bell modal, popup
        // terminal, drag, dashboard). Escape-hatch aliases:
        //   - Ctrl+Shift+Q
        //   - Ctrl+\
        // The second alias is for terminal/VW-heavy contexts where
        // Shift-modified control chords may get normalized away by the
        // terminal emulator. Plain Ctrl+Q is still *not* the true
        // force-quit because terminal-resident apps use it.
        // Korean shifted ㅃ (Shift+ㅂ on 2-bul) accepts ctrl-only
        // because the shift bit may be implicit in the codepoint.
        isForceQuitChord: (routeKey) => {
          if (debug.isKeyTraceEnabled()) {
            const rawHex = (routeKey as { raw?: string }).raw
              ? Array.from((routeKey as { raw: string }).raw, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
              : '(none)';
            debug.log('dashboard.force-quit.candidate', routeKey.name || '(empty)', {
              name: routeKey.name,
              ctrl: !!routeKey.ctrl,
              shift: !!routeKey.shift,
              alt: !!routeKey.alt,
              rawHex,
            });
          }
          if (!routeKey.ctrl) return false;
          if (routeKey.name === '\\' || routeKey.name === 'backslash') return true;
          if (routeKey.shift && (routeKey.name === 'q' || routeKey.name === 'Q' || routeKey.name === 'ㅂ')) return true;
          if (routeKey.name === 'ㅃ') return true;
          return false;
        },
        // PR-S1V.4-wiring · Step 0x — voice mode entry chord.
        // Fires only when voice mode is currently `idle`; once active
        // the next step (routeVoiceModeKey) takes over. Skipping when
        // voiceInputHost is null keeps the chord inert until the
        // STTProvider has finished booting (or stays inert forever
        // when OPENAI_API_KEY is absent).
        routeVoiceEnterChord: (routeKey) => {
          if (!voiceInputHost) return false;
          if (voiceInputHost.getState().kind !== 'idle') return false;
          if (!matchesVoiceEnterChord(routeKey)) return false;
          if (debug.enabled) debug.log('voice.host', 'enter.chord', {});
          voiceInputHost.requestEnter();
          return true;
        },
        // PR-S1V.4-wiring · Step 0c — voice mode active dispatch.
        // Modal A invariant: while the host is non-idle, every key
        // flows through `maybeHandleKey` which terminates the dispatch
        // (escape exits, space drives the recording lifecycle, every
        // other key is swallowed no-op). Idle state returns false so
        // legacy dispatchers stay reachable.
        routeVoiceModeKey: (routeKey) => {
          if (!voiceInputHost) return false;
          if (voiceInputHost.getState().kind === 'idle') return false;
          return voiceInputHost.maybeHandleKey(routeKey);
        },
        // experiment/voice-chat-realtime-rebind · Step 0r —
        // Ctrl+Shift+R chord (continuous voice-chat toggle). Same
        // outer-hook tier as routeVoiceEnterChord so it reaches
        // anywhere (popup terminal / VW terminal / bell modal). The
        // mutex check + state machine transition + chatLines status
        // line live in the same handler to keep the wire 1-place.
        // experiment/voice-chat-realtime-rebind · Step 0s — modal-A
        // swallow while voice-chat is active. Returns true when the
        // controller is non-idle so any key not already claimed above
        // (force-quit · Alt+W · chord toggle) is consumed
        // — typing doesn't leak into chat input, Space doesn't toggle
        // pickers, etc. ESC explicitly exits. Idle controller returns
        // false so legacy dispatch is reachable.
        routeVoiceChatActiveKey: async (routeKey) => {
          if (!dashboardVoiceChat.controller.isActive()) return false;
          // ESC: exit voice-chat (mode-level cancel), do not pass to
          // dispatch chain so no other surface acts on the ESC.
          if (routeKey.name === 'escape') {
            try {
              await dashboardVoiceChat.handleEsc();
            } catch (err) {
              if (debug.enabled) {
                debug.log('voice.chat.error', 'esc.handle.exception', { err: String(err) }, { level: 'error' });
              }
            }
            emitVoiceChatStopQuickPass('esc');
            chatLines.push('');
            chatLines.push(C.accent('🎙 [voice-chat] stopped (ESC)'));
            chatScrollOffset = -1;
            if (debug.enabled) {
              debug.log('voice.chat.phase', 'esc.exit', {
                phase: dashboardVoiceChat.controller.getPhase(),
              });
            }
            draw();
            return true;
          }
          // Everything else: swallow.
          if (debug.enabled) {
            debug.log('voice.chat.swallow', routeKey.name || '(anon)', {
              ctrl: !!routeKey.ctrl,
              shift: !!routeKey.shift,
              alt: !!routeKey.alt,
              phase: dashboardVoiceChat.controller.getPhase(),
            });
          }
          return true;
        },
        routeVoiceChatRealtimeChord: (routeKey) => {
          // Alt+R reasoning cycle — handled here at the same outer
          // tier as voice-chat so it claims the key before any other
          // surface (chat input, modal, etc) interprets it. Returns
          // true ⇒ key consumed, no further dispatch.
          if (matchesReasoningCycleChord(routeKey)) {
            cycleReasoningLevel();
            return true;
          }
          if (!matchesVoiceChatRealtimeChord(routeKey)) return false;
          if (debug.enabled) {
            debug.log('voice.chat.chord', 'press', {
              keyName: routeKey.name,
              alt: !!routeKey.alt,
              shift: !!routeKey.shift,
              ctrl: !!routeKey.ctrl,
              kind: (routeKey as { kind?: string }).kind ?? 'press',
              wasActive: dashboardVoiceChat.controller.isActive(),
              priorPhase: dashboardVoiceChat.controller.getPhase(),
            });
          }
          // Defer to async runtime — outer-hook tier expects sync
          // boolean, so we kick off the toggle and claim the key.
          void (async () => {
            const startedAt = Date.now();
            if (debug.enabled) {
              debug.log('voice.chat.toggle.begin', 'await', {
                wasActive: dashboardVoiceChat.controller.isActive(),
                d5State: voiceInputHost?.getState().kind ?? null,
              });
            }
            try {
              const result = await toggleVoiceChatRealtime(dashboardVoiceChat, {
                // NOTE: a `|| getState().kind === 'committing'` clause was
                // removed here — 'committing' is not a VoiceModeState.kind
                // ('idle'|'active'|'recording'|'processing'), so the check
                // was always false (dead). Behavior is unchanged.
                d5VoiceActive: () =>
                  voiceInputHost?.getState().kind === 'recording',
              });
              if (debug.enabled) {
                debug.log('voice.chat.toggle.resolve', result.action, {
                  status: result.status,
                  phase: dashboardVoiceChat.controller.getPhase(),
                  elapsedMs: Date.now() - startedAt,
                });
              }
              // 2026-04-30 — HUD `voice-state` segment is the single
              // source of truth for entry/exit status. Chord toggle
              // no longer pushes lines into chatLines (per user
              // request: "다시 챗로그에 나타나네요"). Only mutex
              // (D5 voice ↔ voice-chat conflict) is exceptional and
              // worth a chatLines warning so the user knows the
              // chord was REJECTED, not silently no-op'd.
              if (result.action === 'mutex') {
                chatLines.push('');
                chatLines.push(C.warning(`🎙 [voice-chat] ${result.status}`));
                chatScrollOffset = -1;
              } else if (result.action === 'exit' && result.status === 'voice-chat exited') {
                emitVoiceChatStopQuickPass('alt-s');
              }
              draw();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              chatLines.push(C.warning(`🎙 [voice-chat] toggle failed: ${msg}`));
              chatScrollOffset = -1;
              if (debug.enabled) {
                debug.log('voice.chat.error', 'toggle.exception', {
                  err: msg,
                  elapsedMs: Date.now() - startedAt,
                }, { level: 'error' });
              }
              draw();
            }
          })();
          return true;
        },
        // Step 6 hard-quit — only reached when no popup terminal is
        // active. Plain Ctrl+Q stays as the dashboard-mode shortcut
        // so muscle memory survives outside the popup. Inside the
        // popup, Ctrl+Q forwards to the child PTY (use Ctrl+Shift+Q
        // to force-quit instead).
        isHardQuitKey: (routeKey) => routeKey.ctrl && !routeKey.shift && (routeKey.name === 'q' || routeKey.name === 'ㅂ'),
        matchGlobalAction: (routeKey) => matchTextInputGlobalAction(routeKey, {
          allowSpawnTerminalModal: false,
          allowToggleLogZoom: false,
        }),
        runGlobalAction: async (action) => {
          await runChatMainGlobalAction(action);
        },
        routeLayoutModalKey: async (routeKey) => {
          if (dashboardModals.length > 0) {
            const modalLayout = createLayout([{ height: 'flex', cells: [{ widgetInstanceId: null, width: 'flex' }] }], dashboardModals);
            const modalRoute = routeLayoutModalKey(modalLayout, widgetHost, routeKey);
            if (modalRoute.type !== 'passthrough') {
              dashboardModals = modalRoute.layout.modals;
              if (modalRoute.type === 'closed') {
                displayEvents.emit({ type: 'modal:close', id: 'dashboard-pane-modal' });
                requestDashboardRender();
              } else if (modalRoute.action.type === 'refresh') {
                requestDashboardRender(modalRoute.action.pane);
              }
              return true;
            }
          }
          const active = pluginHost.active();
          if (active?.layout && active.layout.modals.length > 0) {
            const modalRoute = routeLayoutModalKey(active.layout, widgetHost, routeKey);
            if (modalRoute.type !== 'passthrough') {
              active.layout = modalRoute.layout;
              if (modalRoute.type === 'closed') {
                requestDashboardRender();
              } else {
                await runDashboardAction(modalRoute.action, {
                  requestRender: requestDashboardRender,
                  setWorkingFocus,
                  deactivatePlugin: () => pluginHost.deactivate(),
                  refreshViewsAfterDeactivate: refreshDashboardViewsFromPlugins,
                  submitText: dispatchSidebarSubmit,
                  focusReason: 'modal-route-focus-action',
                });
              }
              return true;
            }
          }
          return false;
        },
      });
      if (priorityRoute.type === 'quit') {
        // PR-S1V.4-wiring — dispose the voice host before closeTui so
        // the kitty `>1u` restore + onIndicator listeners run while
        // stdout is still open.
        // Same loop-carried `never` false positive as the dictation
        // block above — assert the true declared types before dispose.
        const voiceUnsubForQuit = voiceUnsubscribeIndicator as (() => void) | null;
        const voiceHostForQuit = voiceInputHost as VoiceInputHost | null;
        const voiceDetectorForQuit = voiceLongPressDetector as SpaceLongPressDetector | null;
        try { voiceUnsubForQuit?.(); } catch { /* best-effort */ }
        try { voiceHostForQuit?.dispose(); } catch { /* best-effort */ }
        try { voiceDetectorForQuit?.dispose(); } catch { /* best-effort */ }
        voiceInputHost = null;
        voiceLongPressDetector = null;
        closeDashboardTui();
        return 'quit';
      }
      if (priorityRoute.type === 'handled') {
        continue;
      }

      // ── Coordinator key route bridge ──
      // New plugin/display keymaps flow through DisplayCoordinator.
      // Keep hard globals above this block; everything else can be
      // claimed by modal/execution/focused-surface/keymap routing.
      const displayRoute = await handleDashboardDisplayKeyRoute(display.routeKey(key), {
        invokeHandler: (invoke) => {
          try { invoke(); }
          catch (err) {
            chatLines.push(C.error(`  key handler failed: ${err instanceof Error ? err.message : String(err)}`));
            chatScrollOffset = -1;
          }
        },
        runCommand: async (command) => {
          const parts = command.trim().split(/\s+/).filter(Boolean);
          const cmd = parts.shift();
          if (!cmd) return;
          const handled = pluginHost.active()
            ? await pluginHost.dispatchSlash(cmd, parts)
            : false;
          if (!handled) {
            chatLines.push(C.warning(`Display command not handled: ${command}`));
            chatScrollOffset = -1;
          }
        },
        runAction: async (action) => {
          await runDashboardAction(action, {
            requestRender: requestDashboardRender,
            setWorkingFocus,
            deactivatePlugin: () => pluginHost.deactivate(),
            refreshViewsAfterDeactivate: refreshDashboardViewsFromPlugins,
            submitText: dispatchSidebarSubmit,
            focusReason: 'display-route-focus-action',
          });
        },
        redraw: draw,
      });
      if (displayRoute.type === 'handled') {
        continue;
      }

      // ── Terminal mouse handling (T8 scrollback + T9 passthrough) ─
      // Priority:
      //   1. If the pointer is over the preview pane AND the child
      //      turned on mouse tracking (DECSET 1000/1002/1003) →
      //      forward the event to the PTY as SGR 1006 bytes so
      //      tmux / htop / neovim / fzf see it.
      //   2. Otherwise, wheel over the preview → scrollback.
      //   3. Otherwise, fall through to the log-pane / sync-mode
      //      mouse dispatch below.
      {
        const tterm = previewTerminal as PreviewTerminal | null;
        if (key.name === 'mouse' && key.mouse && tterm !== null && tterm.isAlive) {
          const prevWidget: any = widgetHost.get('wd-preview');
          const pst = prevWidget?.state;
          const originRow = pst?.lastOriginRow as number | undefined;
          const originCol = pst?.lastOriginCol as number | undefined;
          const body = pst?.lastBodyHeight as number | undefined;
          const width = pst?.lastRenderedWidth as number | undefined;
          const mr = key.mouse.row;
          const mc = key.mouse.col;
          const overPreview =
            typeof originRow === 'number' && typeof originCol === 'number'
            && typeof body === 'number' && typeof width === 'number'
            && mr >= originRow && mr < originRow + body
            && mc >= originCol && mc < originCol + width;

          if (overPreview && tterm.wantsMouse) {
            emitTerminalMouseIntent({
              surfaceId: 'wd-preview',
              paneKind: 'preview-terminal',
              mouseType: key.mouse.type,
              row: mr,
              col: mc,
              ...describeTerminalPosture(interactiveTerminalExposure()),
            });
            // MD5 — our synthetic `double-click` has no SGR
            // representation; terminal apps expect native press /
            // release pairs. Drop it. IDX-F5d — same for pure
            // 'motion' (no SGR 1006 representation unless anyEvent
            // mode 1003 is active; skip for simplicity).
            if (!isPtyForwardMouseEventType(key.mouse.type)) { continue; }
            // Translate absolute terminal coord → pane-local 1-based
            // cell coord that the child expects (SGR 1006).
            const col = mc - originCol + 1;
            const row = mr - originRow! + 1;
            tterm.forwardMouse({
              type: key.mouse.type,
              col,
              row,
              shift: key.shift,
            });
            continue;
          }
          // Mouse tracking not enabled — fall back to T8 scrollback
          // for wheel events in the preview area.
          if (overPreview) {
            if (key.mouse.type === 'scroll-up')      { tterm.scrollUp(3);   draw(); continue; }
            if (key.mouse.type === 'scroll-down')    { tterm.scrollDown(3); draw(); continue; }
          }
        }
      }

      // ── Working-dir view switch (Ctrl+digit) ──
      // Ctrl+2 goes through parseKey normalization; other digits
      // require modified-key protocols. Plain xterm / tmux can
      // collapse Ctrl+7 onto the same bytes as Ctrl+/, so the matcher
      // absorbs that fallback and still routes to V7.
      const viewShortcut = matchDashboardViewShortcut(key);
      if (viewShortcut) {
        const def = findDashboardView(viewRegistry, viewShortcut);
        if (def && activeViewId !== def.id) {
          setActiveDashboardView(def);
        }
        continue;
      }

      if (debugWindowHoverActive && workingDir.focus !== 'input' && !pluginHost.activeLayout() && !key.mouse) {
        const debugWindowSurface = display.surface('debug-window');
        if (debugWindowSurface) {
          const hoverRoute = display.routeKeyToSurface(debugWindowSurface, key);
          if (hoverRoute.type === 'action') {
            await runDashboardAction(hoverRoute.action, {
              requestRender: requestDashboardRender,
              setWorkingFocus,
              deactivatePlugin: () => pluginHost.deactivate(),
              refreshViewsAfterDeactivate: refreshDashboardViewsFromPlugins,
              submitText: dispatchSidebarSubmit,
              focusReason: 'debug-window-hover-focus-action',
            });
            continue;
          }
          if (hoverRoute.type === 'consumed') {
            draw();
            continue;
          }
        }
      }

      if (!key.mouse && await handleLogPaneCopyAction(key)) {
        draw();
        continue;
      }

      // ── Phase 4a: Working-dir pane key dispatch ──
      // Route key events to pane-specific handlers when focus is off
      // the input. `focus === 'input'` is handled by the synthesized-`/`
      // path above, which drops into the existing input-mode body.
      // Mouse events fall through to the general mouse handler below.
      if (workingDir.focus !== 'input'
          && !pluginHost.activeLayout()
          && !key.mouse) {
        const p = workingDir.focus;

        // Ctrl+Shift+T handled globally above (spawnGlobalTerminalModal).
        // The preview-terminal "exit terminal mode" case still
        // intercepts below when focus === 'preview' + term.isAlive.

        // ── Phase T: preview-pane terminal passthrough ──────────────
        // When the embedded terminal is alive AND the user is focused
        // on the preview pane, (almost) all keys flow straight to the
        // PTY so zsh/p10k/tmux/vim behave normally. Only two global
        // shortcuts survive (matches the VSCode commandsToSkipShell
        // default philosophy — minimal intercept list):
        //   Ctrl+Q        → hard quit the app
        //   Ctrl+G / Ctrl+ㅎ → kill terminal + focus log
        // Ctrl+Shift+T is intentionally forwarded to the child PTY
        // so shell-level Shift-variants of fzf-style finders / tmux
        // prefixes don't get stolen by the wrapper. Escape is also
        // NOT intercepted — vim / readline need it.
        {
          const term = previewTerminal as PreviewTerminal | null;
          if (p === 'preview' && term !== null && term.isAlive) {
            const previewRoute = handlePreviewTerminalKey(key, {
              term,
              closeTerminalForQuit: () => {
                try { term.stop(); } catch { /* ignore */ }
                previewTerminal = null;
                previewTerminalDims = null;
                terminalExpanded = false;
              },
              closeTerminalAndFocusLog: () => {
                try { term.stop(); } catch { /* ignore */ }
                previewTerminal = null;
                previewTerminalDims = null;
                terminalExpanded = false;
                applyFocusToPaneTransition(resolveFocusToPaneTransition({
                  targetPane: 'log',
                  reason: 'preview-term-ctrl-g',
                }));
                refreshWorkingDirPreview();
              },
              toggleExpand: () => {
                terminalExpanded = !terminalExpanded;
                previewTerminalDims = null;
                chatLines.push(C.muted(terminalExpanded
                  ? 'Terminal expanded. Ctrl+Shift+E or ^B e to restore.'
                  : 'Terminal collapsed to preview slot.'));
                chatScrollOffset = -1;
              },
              redraw: draw,
              quitApp: closeTui,
            });
            if (previewRoute?.type === 'quit') {
              return 'quit';
            }
            if (previewRoute?.type === 'handled') {
              continue;
            }
          }
        }

        // Surface-unification v2.2 V2.2-5 Part 2 — scheduler scratch key
        // route 폐기 (workingDir.view=4 scheduler view 자체 retire).

        const paneCommonRoute = await routePaneCommonKey(key, {
          pane: p,
          tryConsumeEscape: async () => {
            if (key.name !== 'escape') return false;
            const ev = inputCoreKeyEvent(key);
            const idleViewMode: ViewMode = { kind: 'idle' };
            const ctx: InputCoreDispatchContext = {
              viewMode: idleViewMode,
              policy: inputCoreDerivePolicyForViewMode(idleViewMode),
              routes: {},
              dragManager: display.dragManagerAPI(),
              interceptors: dispatchInterceptors,
            };
            const outcome = await inputCoreRouteInputEventAsync(ev, ctx);
            return outcome === 'consumed';
          },
          enterInput: ({ mode, reason }) => {
            applyFocusToInputTransition(resolvePaneEnterInputTransition(p, { mode, reason }));
          },
          openAgentRosterSearch: () => {
            if (p !== 'agent-roster' || !!agentSearchModal) return false;
            openAgentRosterSearch();
            return true;
          },
          cyclePaneFocus: (delta) => {
            setWorkingFocus(tabNext(p, delta), 'pane-tab-cycle');
          },
          toggleLogFocus: () => {
            applyFocusToPaneTransition(resolveFocusToPaneTransition({
              targetPane: p === 'log' ? firstPaneOfView(workingDir.view) : 'log',
              reason: 'pane-backtick-toggle-log',
            }));
          },
          hardExit: () => {
            closeDashboardTui();
            process.exit(130);
          },
          quit: () => {
            closeDashboardTui();
          },
        });
        if (paneCommonRoute.type === 'quit') return 'quit';
        if (paneCommonRoute.type === 'handled') continue;

        // `agent-roster` moved to paneKeyRouter — see registration at
        // the top of the outer function body.

        // `agent-detail`, `agent-log` moved to paneKeyRouter — see
        // registrations at the top of the outer function body.

        // `debug-events` moved to paneKeyRouter — see registration at
        // the top of the outer function body.

        // `debug-detail`, `debug-stack`, `debug-prompts` moved to
        // paneKeyRouter — see registrations at the top of the outer
        // function body.

        // `scheduler-draft/ready/active/paused` and `scheduler-board`
        // moved to paneKeyRouter — see registrations at the top of the
        // outer function body.

        // `scheduler-inspector` moved to paneKeyRouter — see registration
        // at the top of the outer function body.

        // `browser`, `obsidian` moved to paneKeyRouter — see registrations
        // at the top of the outer function body.

        // `skill-browser`, `skill-file`, `preview` (file), `scratch` (late)
        // moved to paneKeyRouter — see registrations at the top of the
        // outer function body.

        // `log` and `playground` moved to paneKeyRouter — see
        // registrations at the top of the outer function body.

        // ── Widget architecture refactor Phase 0 — dispatch tail ──
        // Any pane handler registered with paneKeyRouter runs here.
        // Handlers return 'consumed' (normal) or 'quit' (app exit);
        // 'passthrough' is treated like 'consumed' because the outer
        // block ends with `continue` anyway — unregistered panes were
        // already dropped silently by the previous inline chain.
        {
          const routed = await paneKeyRouter.dispatch(p, key);
          if (routed === 'quit') return 'quit';
        }

        continue;
      }

      // ── Plugin key routing ──
      // When a plugin is active, try its keybinding table first. This
      // also handles the busy guard (route returns 'consumed' when busy
      // so input is swallowed until the long-running op finishes).
      if (pluginHost.active()) {
        // PaneSlot doesn't carry the 'input' value — fall back to
        // 'skills' there so plugins without their own input concept
        // don't get a surprise enum.
        const slotForPlugin = focus === 'input' ? 'skills' : focus;
        const routed = await pluginHost.routeKey(key, slotForPlugin);
        if (routed === 'consumed') {
          // Plugin took the key — reset dashboard focus off 'log' so
          // the log pane doesn't stay highlighted after the user
          // returns to navigating the plugin's own widgets.
          if (focus === 'log') focus = 'skills';
          continue;
        }
        // Ctrl+C must still tear down the TUI even inside a plugin mode.
        // ⭐ `N1`(2026-08-19) — Ctrl+C 도 자식 정리 ⊕ 세션 안내를 받는다(종전엔 «못 받았다»).
        if (key.name === 'c' && key.ctrl) { exitDashboardTui(); process.exit(130); }
      }

      // ══════════════════════════════════════════════
      // ── SYNC MODE — mouse only (keys live in sync plugin now) ──
      // ══════════════════════════════════════════════
      if (isSyncMode(pluginHost)) {
        // Global keys that should still work even inside sync mode:
        //   `/`            → quick slash input
        //   `Ctrl+L`       → plain chat input
        //   backtick (`)   → focus log pane
        // routeKey already returned 'passthrough' for these since sync
        // keybindings don't cover them. Fall through to browse handler
        // for those specific cases; swallow everything else so sync
        // stays in its widget grid.
        if (key.name === '/') {
          // Let browse-mode input-entry handler take over. (Ctrl+L 은 입력
          // 재진입이 아니라 force-redraw — 2026-07-12 · global-actions.ts.)
        } else if (key.name === '`') {
          focus = 'log';
          continue;
        } else if (key.mouse) {
          const { rows: tr, cols: tc } = termSize();
          const pH = computePaneH(tr);
          const promptFrame = getLayoutPromptFrame(tr);
          const logViewport = computePromptFrameLogViewportBounds(tr, pH, promptFrame);
          const lW = Math.max(20, Math.floor((tc - 1) * 0.22));
          const mW = Math.max(24, Math.floor((tc - 1) * 0.33));
          const mr = key.mouse.row;
          const mc = key.mouse.col;

          if (key.mouse.type === 'click') {
            if (mr <= pH) {
              if (mc <= lW) sync.focus = 0;
              else if (mc <= lW + mW + 1) sync.focus = 1;
              else sync.focus = 2;
              focus = 'skills';  // keep browse-side focus on grid so `log` state resets
            } else if (mr > logViewport.startRow && mr <= logViewport.endRow) {
              focus = 'log';
            }
          } else if (key.mouse.type === 'scroll-up' || key.mouse.type === 'scroll-down') {
            const delta = key.mouse.type === 'scroll-up' ? -3 : 3;
            if (mr <= pH) {
              sync.cursors[sync.focus] = Math.max(0, Math.min(sync.cursors[sync.focus]! + delta, sync.lists[sync.focus]!.length - 1));
            } else if (mr > logViewport.startRow && mr <= logViewport.endRow) {
              // Scroll the log pane
              const maxScr = Math.max(0, chatLines.length - logViewport.height);
              chatScrollOffset = Math.max(0, Math.min((chatScrollOffset < 0 ? maxScr : chatScrollOffset) + delta, maxScr));
              if (delta > 0 && chatScrollOffset >= maxScr) chatScrollOffset = -1;
            }
          }
          continue;
        } else {
          continue; // sync mode handled, swallow the key
        }
      }

      // ══════════════════════════════════════════════
      // ── Input + global slash dispatch ──
      // ══════════════════════════════════════════════
      // The working-dir pane dispatch above handles every pane key.
      // What's left is the synthesized auto-entry key (and any
      // unhandled sync passthrough) which falls into the input-mode
      // loop below.
      const inputEntry = resolveDashboardChatMainEntryPrelude(key, {
        focusTransitionState,
        inputPrefixState,
      });
      if (
        debug.isKeyTraceEnabled()
        && key.ctrl
        && (key.name === 'l' || key.name === 'L' || key.name === 'ㅣ')
      ) {
        debug.log('dashboard.ctrl-l', 'prelude', {
          inputEntryMode: inputEntry?.mode ?? null,
          slashQuickMode: inputEntry?.slashQuickMode ?? null,
          initialText: inputEntry?.initialText ?? null,
          visibility: chatMainInputVisibilityState(),
          topBlockingForegroundModal: topBlockingForegroundModal()?.id ?? null,
          currentVwId: null,
          currentVwHostChromeProfile: null,
        });
      }
      if (inputEntry) {
          // 2026-05-05 — 입력 진입 키는 ALWAYS working focus 를 'input' 으로
          // 복원하고 입력 루프에 들어간다 (포렌식: log 클릭 후 진입 시
          // chatMainSuppressed 가 남아 키가 버퍼에 안 닿던 사고). 2026-07-12
          // Ctrl+L 재진입 폐기 후 진입 키는 `/` 뿐이지만 규칙은 동일 유지.
          if (workingDir.focus !== 'input') {
            setWorkingFocus('input', 'input-entry-restore-focus');
          }
          const slashQuickMode = inputEntry.slashQuickMode;
          // `/` → open input pre-filled with `/` (quick slash mode)
          // `Ctrl+L` → open plain input for free typing
          // Phase 4a: when file-pane `Enter`/`a` queued attachments, splice
          // those tokens into the initial buffer so the user can just type
          // their question next to the pre-filled [PDF #N] tokens.
          let nextInitial: string | undefined = inputEntry.initialText;
          let exitInputLoop = false;
          let lastTurnFinalStatus: 'completed' | 'interrupted' | 'failed' | undefined;

          // ── Input mode loop: stays in input until Escape or mode-changing command ──
          while (!exitInputLoop) {
          if (
            debug.isKeyTraceEnabled()
            && key.ctrl
            && (key.name === 'l' || key.name === 'L' || key.name === 'ㅣ')
          ) {
            debug.log('dashboard.ctrl-l', 'input-loop-enter', {
              slashQuickMode,
              nextInitial: nextInitial ?? null,
              shouldPaint: !shouldSuppressDashboardBottomArea(),
              visibility: chatMainInputVisibilityState(),
            });
          }
          // C-d-3' — 턴 종료 핸드오프: FIFO의 다음 제출 하나를 다음 프롬프트로 넘긴다.
          // 다음 inner-loop 반복이 남은 항목도 같은 순서로 제출한다.
          // ⭐ 드레인 순서 자체는 `chat/turn-typeahead.ts` 가 소유한다 — 여기서 베끼면
          //    테스트가 그 순서를 다시 베껴야 하고, 베낀 테스트는 배선 회귀를 못 잡는다.
          const interrupted = lastTurnFinalStatus === 'interrupted';
          const queuedBeforeDrain = turnTypeaheadRef.state.queuedSubmissions.length;
          const drained = drainTurnTypeaheadOnce(turnTypeaheadRef.state, nextInitial, { interrupted });
          lastTurnFinalStatus = undefined;
          turnTypeaheadRef.state = drained.state;
          nextInitial = drained.nextInitial;
          const queuedTurnEndText = drained.injectEnter ? drained.nextInitial : undefined;
          if (interrupted && queuedBeforeDrain > 0) {
            debug.log('dashboard.turn-typeahead', 'restored-after-interrupt', { count: queuedBeforeDrain });
          }
          if (drained.injectEnter) injectKey({ name: 'enter', ctrl: false, shift: false });
          draw();
          const { cols: inputCols } = termSize();
          // Row is published by draw() via the `input-prompt` zone's
          // resolved geometry — no `termRows - N` math here anymore.
          // The composer is the single source of truth; if the layout
          // shape changes (e.g. new zones added, inputDecoH tweaks),
          // textInput picks up the right row automatically.
          let input: InputResult;
          input = await runDashboardChatMainEntry({
            promptFrame: currentPromptFrame(termSize().rows),
            getPromptFrame: () => currentPromptFrame(termSize().rows),
            inputCols,
            surfaceRegistry: getSurfaceRegistry(),
            invalidateRenderCacheRow,
            buildPromptFrameDividerRows,
            // C-d-1 — 하단 슬롯 결정 뷰 활성 시 composer 페인트 정지(단일 소유자).
            shouldPaint: () => !shouldSuppressDashboardBottomArea() && !bottomSlotModalActive(),
            promptCtl,
            setInputLines: (n) => dashboardState.setInputLines(n),
            redraw: draw,
            dispatchGlobalAction: runChatMainGlobalAction,
            initialText: nextInitial,
            paintFrameNow: () => drawNow(),
            preferHistoryArrowKeys: slashQuickMode,
            history: inputHistory,
            placeholder: anyProviderAvailable()
              ? '말 한 줄로 시작 — 질문하거나 «하니스로 구현 …» · /command · /path/to.pdf 첨부'
              : '/quit /clear (run `elanous setup` — no LLM provider available)',
            debugLog: debug.enabled ? (event, label, payload) => debug.log(event, label, payload) : undefined,
            textInputOpts: {
              onScrollKey: (name) => {
                const { rows } = termSize();
                const viewport = computePromptFrameLogViewportBounds(
                  rows, computePaneH(rows), getLayoutPromptFrame(rows),
                );
                chatScrollOffset = nextChatScrollOffset(
                  chatScrollOffset, name, Math.max(1, viewport.height),
                  Math.max(0, chatLines.length - viewport.height),
                );
                draw();
              },
              // TUI 부활 후속 — Esc·Esc = /rewind 픽커 (codex backtrack
              // 제스처 · resolveEscEscRewind 순수 판정). 빈 버퍼에서만
              // prime · 1.5s 창. 힌트는 세션 1회.
              onEscape: (bufferText) => {
                const decision = resolveEscEscRewind({
                  bufferText: bufferText ?? '',
                  nowMs: Date.now(),
                  primedAtMs: rewindEscPrimedAt,
                });
                rewindEscPrimedAt = decision.nextPrimedAt;
                if (decision.action === 'open') {
                  openForkTimetravelPicker();
                  return true; // consumed — 입력 루프 유지, 픽커가 전면
                }
                if (decision.action === 'prime' && !rewindEscHintShown) {
                  rewindEscHintShown = true;
                  chatLines.push(C.muted('  (Esc 한 번 더 = 과거 턴으로 되감기 · /rewind)'));
                  chatScrollOffset = -1;
                }
                return false; // 기본 Esc 동작 (chat-only 는 루프 재진입)
              },
              ...createDashboardChatMainInteractionOpts({
                cursorSink: display,
                modalSink: display,
                canClaimCursor: () =>
                  chatMainInputVisibilityState().inputOwnership?.owner === 'chat-main',
                shouldSyncPickers: () =>
                  chatMainInputVisibilityState().inputOwnership?.owner === 'chat-main',
                onPasteImage: attachClipboardImage,
                routeVoiceKey: async (routeKey) => {
                // 2026-04-30 — voice-chat ESC: when the controller is
                // active and the user hits ESC inside chat-main, take
                // it as a "exit voice mode" gesture and DO NOT let
                // the chat input pane's default ESC handler fire
                // (which would clear the freshly-injected transcript
                // buffer). User feedback: "프롬프트에 발화를 소중히
                // 다뤄야 함. … ESC 를 눌러도 보이스 모드가 종료되는
                // 것이지 인풋 모드 클리어를 의미하는 것이 아님."
                if (
                  routeKey.name === 'escape'
                  && dashboardVoiceChat.controller.isActive()
                ) {
                  if (debug.isKeyTraceEnabled()) {
                    debug.log('key.trace.dispatch', 'chat-main.routeVoiceKey.esc-exit', {
                      name: routeKey.name,
                      claimed: 'voice-chat-exit',
                      phase: dashboardVoiceChat.controller.getPhase(),
                    });
                  }
                  try { await dashboardVoiceChat.handleEsc(); } catch { /* swallow */ }
                  emitVoiceChatStopQuickPass('esc');
                  // 2026-04-30 — Unified `🎙 [voice-chat] stopped
                  // (ESC)` line so the chat log lifecycle stays
                  // coherent regardless of which dispatch path
                  // (chat-main vs outer-tier) claimed the ESC.
                  chatLines.push('');
                  chatLines.push(C.accent('🎙 [voice-chat] stopped (ESC)'));
                  chatScrollOffset = -1;
                  return 'consumed';
                }
                // experiment/voice-chat-realtime-rebind — Alt+R chord
                // is routed BEFORE the D5 voice path so chat-input
                // doesn't swallow it. priority-key-route also handles
                // Alt+R (step 0r) but only fires when the input loop
                // is NOT the active reader; from inside chat-main
                // textInput.readKey, this is the only place that runs
                // first. Mirror dashboard outer-hook behavior: log,
                // claim, kick off async toggle.
                //
                // Alt+R reasoning cycle — same chat-main inner tier so
                // it claims the chord before voice-chat. Mnemonic
                // V/D/R: V=voice control, D=batch dictation,
                // R=reasoning.
                if (matchesReasoningCycleChord(routeKey)) {
                  cycleReasoningLevel();
                  // Chord handled — claim it ('consumed'); the route
                  // contract is 'consumed' | 'passthrough', not boolean.
                  return 'consumed';
                }
                if (matchesVoiceChatRealtimeChord(routeKey)) {
                  if (debug.isKeyTraceEnabled()) {
                    debug.log('key.trace.dispatch', 'chat-main.routeVoiceKey.realtime', {
                      name: routeKey.name,
                      alt: !!routeKey.alt,
                      ctrl: !!routeKey.ctrl,
                      shift: !!routeKey.shift,
                      claimed: 'realtime',
                    });
                  }
                  if (debug.enabled) {
                    debug.log('voice.chat.chord', 'press.chat-main', {
                      keyName: routeKey.name,
                      alt: !!routeKey.alt,
                      ctrl: !!routeKey.ctrl,
                      shift: !!routeKey.shift,
                      kind: (routeKey as { kind?: string }).kind ?? 'press',
                      wasActive: dashboardVoiceChat.controller.isActive(),
                    });
                  }
                  void (async () => {
                    const startedAt = Date.now();
                    if (debug.enabled)
                      debug.log('voice.chat.toggle.begin', 'chat-main.await', {
                        d5State: voiceInputHost?.getState().kind ?? null,
                      });
                    try {
                      const result = await toggleVoiceChatRealtime(dashboardVoiceChat, {
                        // NOTE: dead `=== 'committing'` clause removed (not a
                        // VoiceModeState.kind → always false). Unchanged behavior.
                        d5VoiceActive: () =>
                          voiceInputHost?.getState().kind === 'recording',
                      });
                      if (debug.enabled)
                        debug.log('voice.chat.toggle.resolve', result.action, {
                          status: result.status,
                          phase: dashboardVoiceChat.controller.getPhase(),
                          elapsedMs: Date.now() - startedAt,
                          source: 'chat-main',
                        });
                      // 2026-04-30 — Unified format: `🎙 [voice-chat]
                      // <verb> (<trigger>)`. Same emoji + tag + accent
                      // color across start/stop so the chat log reads
                      // as a coherent voice-chat lifecycle stream.
                      // Mutex/failed-start fall through to warning
                      // color but keep the same prefix.
                      chatLines.push('');
                      if (result.action === 'mutex') {
                        chatLines.push(C.warning(`🎙 [voice-chat] ${result.status}`));
                      } else if (result.action === 'enter') {
                        chatLines.push(C.accent(
                          `🎙 [voice-chat] started (provider: ${dashboardVoiceChat.providerId}) — Alt+S or ESC to exit`,
                        ));
                      } else if (result.status === 'voice-chat exited') {
                        emitVoiceChatStopQuickPass('alt-s');
                        chatLines.push(C.accent('🎙 [voice-chat] stopped (Alt+S)'));
                      } else {
                        // 'exit' action with diagnostic status
                        // (e.g. failed-to-start guard).
                        chatLines.push(C.warning(`🎙 [voice-chat] ${result.status}`));
                      }
                      chatScrollOffset = -1;
                      draw();
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      chatLines.push(C.warning(`🎙 [voice-chat] toggle failed: ${msg}`));
                      chatScrollOffset = -1;
                      if (debug.enabled)
                        debug.log('voice.chat.error', 'chat-main.toggle.exception', {
                          err: msg,
                          elapsedMs: Date.now() - startedAt,
                        }, { level: 'error' });
                      draw();
                    }
                  })();
                  return 'consumed';
                }
                if (!voiceInputHost) return 'passthrough';
                if (voiceInputHost.getState().kind !== 'idle') {
                  return voiceInputHost.maybeHandleKey(routeKey) ? 'consumed' : 'passthrough';
                }
                if (!matchesVoiceEnterChord(routeKey)) return 'passthrough';
                if (debug.enabled) debug.log('voice.host', 'enter.chord.chat-main', {});
                voiceInputHost.requestEnter();
                return 'consumed';
              },
              // PR-S1V.D4 — Long-press Space dictation pre-key. The
              // detector lives at dashboard scope (see line ~4585) and
              // gets fed every keystroke routed here. The first Space
              // press is `passthrough` so the OS char lands in the chat
              // input buffer; once the threshold fires (`onLongPress`
              // → host.startDictation), subsequent OS repeats are
              // swallowed (`consumed`) so they don't pile " " chars on
              // top of the dictated transcript. Final release (or
              // cancel-by-other-key) flushes via host.stopDictation.
                routeLongPressDictation: async (routeKey) => {
                // TEMP DEBUG (2026-04-29 · fix/voice-runtime-tdz-2) —
                // mirror of the outer-hook gate log at the chat-input
                // route. Same chord-trial reasons as detector.
                if (debug.enabled && !routeKey.mouse && routeKey.ctrl && routeKey.shift) {
                  debug.log('voice.chat-input-route.gate', 'eval', {
                    keyName: routeKey.name,
                    kind: routeKey.kind ?? 'press',
                    hasVoiceHost: !!voiceInputHost,
                    hasDetector: !!voiceLongPressDetector,
                    hostState: voiceInputHost ? voiceInputHost.getState().kind : null,
                  });
                }
                if (!voiceLongPressDetector || !voiceInputHost) return 'passthrough';
                // Voice mode active → defer to its own modal; long-press
                // detector stays out so press/release events serve the
                // recording lifecycle there.
                if (voiceInputHost.getState().kind !== 'idle') return 'passthrough';

                if (isDictationHoldKey(routeKey)) {
                  if (debug.enabled) {
                    debug.log('voice.chat-input-route.dictation.hit', 'chord-match-toggle', {
                      keyName: routeKey.name,
                      kind: routeKey.kind ?? 'press',
                      dictState: voiceInputHost.getDictationState(),
                    });
                  }
                  // TEMP DEBUG TRIAL (2026-04-29) — toggle pattern via
                  // shared dashboard helper. Release events ignored
                  // under toggle; only press toggles. Restore detector
                  // wiring once chord question is settled.
                  if (routeKey.kind !== 'release') {
                    toggleDictationFromChord('chat-input-route', routeKey.name);
                  }
                  return 'consumed';
                }

                // TEMP DEBUG TRIAL — ESC stops a toggle-mode dictation
                // from inside chat-main input. Mirror of the outer-hook
                // ESC-cancel; the detector path below covers long-press
                // mode but not toggle.
                if (
                  routeKey.name === 'escape'
                  && !routeKey.ctrl && !routeKey.shift && !routeKey.alt
                  && voiceInputHost.getDictationState() === 'recording'
                ) {
                  if (debug.enabled) {
                    debug.log('voice.toggle.stop', 'esc-cancel-chat-input', {});
                  }
                  void voiceInputHost.stopDictation();
                  while (voiceInputHost.getDictationState() !== 'idle') {
                    await new Promise<void>((resolve) => setTimeout(resolve, 10));
                  }
                  return 'passthrough';
                }

                // Cancel-by-other-key path — the user pressed something
                // other than Space while a long-press was pending or a
                // dictation was active. PR #1109 review fix: when this
                // terminates an in-flight dictation we MUST await
                // `stopDictation()` before returning, otherwise the
                // terminator key races ahead of the transcript insert
                // and the chat-main buffer ends up with "a<transcript>"
                // instead of "<transcript>a". Sentinel: capture the
                // pre-call state so we can decide whether to await.
                const preState = voiceLongPressDetector.getState();
                if (preState === 'idle') return 'passthrough';

                voiceLongPressDetector.noteOtherKey();
                if (preState === 'fired') {
                  // `noteOtherKey` already kicked the host's
                  // stopDictation via the onLongRelease callback (the
                  // detector calls it synchronously). Await the host's
                  // dictation pipeline so the chat input handler that
                  // runs after us sees the transcript already inserted.
                  // We still return 'passthrough' so the terminator key
                  // itself is delivered to the chat input as the user
                  // intended — only the *ordering* shifts.
                  while (voiceInputHost.getDictationState() !== 'idle') {
                    await new Promise<void>((resolve) => setTimeout(resolve, 10));
                  }
                }
                return 'passthrough';
              },
              routeInputKey: async (key) => {
                if (await handleLogPaneCopyAction(key)) return 'consumed';
                // A-5b.2 · dispatcher-level key hook (routeInputEventAsync
                // · ViewMode='input'). Runs AFTER onPreKey and BEFORE
                // textInput-owned specialized handlers. A-8 ESC guard fires
                // here when a drag session is active · A-5b.3 이후
                // **structural authority** 로 자리잡음 (DS-3a-follow Finding B
                // direct-cancel 제거). Empty routes · dispatcher in input
                // viewMode falls through to `routeFocusedWidgetKey[Async]` /
                // `routeGlobalBindings[Async]` which are unwired here · so
                // A-8 guard is the only active branch. Non-ESC keys always
                // return 'passthrough' · textInput handles them as before.
                const ev = inputCoreKeyEvent(key);
                const inputViewMode: ViewMode = { kind: 'input' };
                const ctx: InputCoreDispatchContext = {
                  viewMode: inputViewMode,
                  policy: inputCoreDerivePolicyForViewMode(inputViewMode),
                  routes: {},
                  dragManager: display.dragManagerAPI(),
                  interceptors: dispatchInterceptors,
                };
                const outcome = await inputCoreRouteInputEventAsync(ev, ctx);
                return outcome === 'consumed' ? 'consumed' : 'passthrough';
              },
              shouldRouteInputDispatcherKey: (key) => {
                const topModalId = display.modalStack().at(-1) ?? null;
                const topModal = topModalId ? display.surface(topModalId) : null;
                const topModalSurface =
                  topModal && topModal.kind === 'modal'
                    ? topModal
                    : null;
                const route = ownsForegroundModalKeyRoute(topModalSurface);
                if (debug.isKeyTraceEnabled() && !route && topModalSurface) {
                  debug.log('dashboard.input-dispatch', 'skip-workspace-modal-route', {
                    key: key.name ?? '(empty)',
                    ctrl: !!key.ctrl,
                    shift: !!key.shift,
                    alt: !!key.meta,
                    topModalId,
                    interactionClass: topModalSurface?.interactionClass ?? '(inferred-workspace)',
                  });
                }
                return route;
              },
              hasActiveStatusPopup: () => mouseWiring.hasActivePopup(),
              hasTerminalModal: () => terminalModalRouter.current() !== null,
              shouldRouteForegroundModalKey: (key) => {
                if (key.name === 'escape' && currentTransientTerminalModal('dashboard-help')) return true;
                const topModalId = display.modalStack().at(-1) ?? null;
                const topModal = topModalId ? display.surface(topModalId) : null;
                const topModalSurface =
                  topModal && topModal.kind === 'modal'
                    ? topModal
                    : null;
                const isCtrlL = !!key.ctrl && (key.name === 'l' || key.name === 'L' || key.name === 'ㅣ');
                const route = ownsForegroundModalKeyRoute(topModalSurface);
                if (debug.isKeyTraceEnabled() && !route && topModalSurface) {
                  debug.log(
                    isCtrlL ? 'dashboard.ctrl-l' : 'dashboard.workspace-key-bypass',
                    'skip-workspace-modal-route',
                    {
                    topModalId,
                    interactionClass: topModalSurface?.interactionClass ?? '(inferred-workspace)',
                    key: key.name ?? '(empty)',
                    ctrl: !!key.ctrl,
                    shift: !!key.shift,
                    alt: !!key.meta,
                  });
                }
                return route;
              },
              toKeyEvent: toDashboardKeyEvent,
              routeStatusPopupKey: key => mouseWiring.routeKey(key as never),
              handleTerminalModalKey: keyEvent => terminalModalRouter.handleKey(keyEvent),
              tryRouteForegroundModalKey: async keyEvent => {
                if (keyEvent.name === 'escape') {
                  const helpModal = currentTransientTerminalModal('dashboard-help');
                  if (helpModal) {
                    helpModal.dispose();
                    draw();
                    return 'consumed';
                  }
                }
                return display.tryRouteKeyToTopModalAsync(keyEvent);
              },
              redraw: draw,
              dispatchMouse: runTextInputOnMouseUnifiedDispatch,
            }),
            ...createDashboardChatMainAttachmentOpts({
              tokenizeInput: (text) => tokenizeInput(text, contextRegistry),
              attachClipboardImage,
              isClipboardSupported,
              onWarning: (warning) => {
                const reason = warning.reason === 'not-a-file' ? 'not a regular file' : 'not found';
                chatLines.push(C.warning(`  ⚠ ${warning.raw} — ${reason}`));
                chatScrollOffset = -1;
              },
              renderAttachmentSummary: (added) => renderAttachmentSummary(added as never),
              clearClipboardImageIndicator: () => { clearSegment(hud, 'clipimg'); },
              markChatDirty: () => {
                chatScrollOffset = -1;
                draw();
              },
              attachFilePathToken,
              openFolderAttachModal,
              dropContextById: (id) => { ctxDrop(contextRegistry, id); },
              sweepAttachmentSummaryLines: (token) => {
                const needle = `\u251c\u2500 ${token}`;
                let removed = 0;
                for (let i = chatLines.length - 1; i >= 0; i--) {
                  if (stripAnsi(chatLines[i]!).includes(needle)) {
                    chatLines.splice(i, 1);
                    removed++;
                  }
                }
                return removed;
              },
            }),
            ...createDashboardChatMainCompletionOpts({
              getVisibleSkills: () => {
                const skillsCfg = getUserConfig().skills;
                return applySkillFilter(getSkillIndex(), {
                  allow: skillsCfg.allow,
                  deny: skillsCfg.deny,
                });
              },
              listPlugins: () => pluginHost.list(),
              listContextDrops: () => ctxList(contextRegistry),
            }),
            ...createDashboardChatMainAtCandidateOpts({
              baseCwd: () => workingDir.cwd,
              readRootEntries: (cwd) => {
                const entries = readDirEntries(cwd, false);
                return sortEntries([
                  ...entries.folders,
                  ...entries.files,
                ], 'mtime');
              },
              listDirEntries: (dir, showHidden) => {
                const entries = readDirEntries(dir, showHidden);
                return [...sortEntries(entries.folders, 'name'), ...sortEntries(entries.files, 'name')];
              },
              splitAtPrefix,
              searchIndex: (cwd, prefix, limit) => {
                const cache = getFileIndexCache(cwd);
                cache.maybeRefresh();
                return cache.search(prefix, limit);
              },
              absolutize,
              formatEntry: (entry, label) => ({
                label,
                absPath: entry.absPath,
                isDir: entry.isDir,
                icon: entry.isDir
                  ? C.accent(FOLDER_ICON)
                  : fileColor(entry.name)(fileIcon(entry.name)),
                hint: entry.isDir ? '' : sizeStr(entry.size),
              }),
              formatSearchResult: (result, cwd) => {
                const absPath = absolutize(result.path, cwd);
                const name = result.path.slice(result.path.lastIndexOf('/') + 1) || result.path;
                return {
                  label: result.path,
                  absPath,
                  isDir: false,
                  icon: fileColor(name)(fileIcon(name)),
                  hint: '',
                };
                },
              }),
            },
          });

          const postTurn = resolveDashboardChatMainPostTurn(input, {
            inputLines: dashboardState.getInputLines(),
            isChatOnlyMode: effectiveChatOnlyMode(),
            hasActiveSessionControl: isSessionControlActive(chatModeState),
            lastHistoryEntry: inputHistory[inputHistory.length - 1],
            cwd: workingDir.cwd,
            activeViewId,
            focusedPane: String(workingDir.focus),
            provider: inspectActiveProvider().provider,
          });
          if (postTurn.shouldResetInputLines) {
            dashboardState.resetInputLines();
          }
          nextInitial = postTurn.nextInitialText;
          const inputLoopControl = postTurn.loopControl;

          if (inputLoopControl.kind === 'view-switch') {
            // Ctrl+<digit> inside input — flip to the view whose
            // `shortcut` field matches the digit, keeping focus in
            // input. Looking up by shortcut (not by baseView) lets
            // Ctrl+4/5 land on Agents/Debug whose baseView is 1.
            const def = findDashboardView(viewRegistry, inputLoopControl.viewSwitch);
            if (def && def.id !== activeViewId) setActiveDashboardView(def);
            continue; // re-enter textInput on next iter
          }
          if (inputLoopControl.kind === 'goto-pane') {
            // Ctrl+M inside input — always exit, even in chat-only
            // mode, so the user can pivot to a pane via the chord
            // without first toggling out of chat mode.
            exitInputLoop = true; break;
          }
          if (inputLoopControl.kind === 'cancel-session-control') {
            // Escape inside session-control mode exits that sub-mode
            // but keeps the chat input loop alive.
            exitSessionControlMode(chatModeState);
            void inputCoreSetMode(resolveSessionInputModeFromChatMode({ chatModeState }));  // P4 — keep resolver context in sync
            pushDebugLine(C.muted('-- Esc: back to default chat mode --'));
            chatScrollOffset = -1;
            draw();
            continue;
          }
          if (inputLoopControl.kind === 'continue-chat-only') {
            continue;
          }
          if (inputLoopControl.kind === 'exit-input') {
            exitInputLoop = true; break;
          }

          // Save to durable input history. Up/down reads the in-memory
          // tail, while slash/LLM tools can search the full store.
          if (postTurn.historyRecord) {
            inputHistoryStore.record(postTurn.historyRecord);
            refreshInputHistory();
          }

          // Turn separator — inserted once per submit so the log
          // reads like `[rule]\n❯ input\n...response...\n[rule]\n...`.
          // No-op when logTurnSeparatorMode === 'off' (default).
          pushTurnSeparator();

          // ── ACP send helper (shared between /acp send and sticky route) ──
          // Streams a turn into the chat pane with the same line/chunk
          // shape used by the legacy `case 'acp':` send branch. Hoisted
          // so the sticky multi-turn passthrough below can reuse it.
          const dispatchAcpSend = (
            backend: AcpBackendId,
            msg: string,
            attachments: NormalizedAttachment[],
          ): void => {
            dispatchDashboardChatMainAcpSend({
              dashboardAcpChat,
              backend,
              message: msg,
              attachments,
              debugEnabled: debug.enabled,
              chatLines,
              setChatScrollToTail: () => { chatScrollOffset = -1; },
              redraw: draw,
              formatAssistantLines: (text) => {
                const { cols } = termSize();
                const wrapWidth = Math.max(40, cols - 8);
                return formatResponse(
                  text,
                  wrapWidth - 2,
                  getUserConfig().chat.rendering.wrap,
                );
              },
              formatUserLine: (display, message) => C.info(`  acp:${display} > ${message}`),
              formatMutedLine: (line) => C.muted(line),
              formatToolLine: (tool) => C.subtext(`    ${tool}`),
              formatDebugLine: (display, reason, chars) => C.muted(`  -- acp:${display} ${reason} (${chars} chars) --`),
              formatErrorLine: (display, message) => C.error(`  acp:${display} error: ${message}`),
              formatAssistantPrefix: (display) => C.accent(`  [${display}]`),
              autoTtsHooks: {
                pushChunk: dashboardAutoTts.hooks.pushChunk,
                commit: () => dashboardAutoTts.hooks.commit(),
                cancel: () => dashboardAutoTts.hooks.cancel(),
              },
              // 2026-04-30 — voice-chat controller's notifyResponseDone
              // used to live inside `autoTtsHooks.commit/cancel` wrappers,
              // which meant ELANOUS_AUTO_TTS=off (the default) skipped the
              // call entirely → speaking phase stuck → ESC needed → ESC
              // close triggered "WebSocket closed unexpectedly" warning.
              // Wiring through `onTurnDone` (auto-TTS-independent) makes
              // the speaking → inactive transition unconditional.
              onTurnDone: () => {
                dashboardVoiceChat.notifyResponseDone();
              },
              signalBus: dashboardControlSignals,
              drainCooldownMs: getUserConfig().voice.tts.drainCooldownMs
                ?? VOICE_HARDCODED_DEFAULTS.ttsDrainCooldownMs,
            });
          };

          // Phase 4 voice-chat — bind the late submit closure now that
          // `dispatchAcpSend` is in scope. The boot helper holds a
          // mutable reference (set above with the `submitTranscript`
          // hook) so the controller can invoke this on final transcripts.
          //
          // 2026-04-30 — auto-submit destination is now decided by the
          // SAME state the chat-input router uses (sticky ACP backend).
          // Previously this closure unconditionally fell back to
          // `'claude'` when sticky was null, which sent multi-turn
          // voice transcripts to the claude-code ACP binary even when
          // the user never armed it — surfacing as `[-32603] Internal
          // error` because no claude-code session existed.
          //
          //   sticky armed (`/acp codex --multi` etc.)
          //     → dispatchAcpSend(sticky, text, [])
          //     → external ACP backend, voice multi-turn fully hands-free
          //
          //   sticky null
          //     → replace the live chat-main buffer via the textInput
          //       host's external submit hook and inject Enter
          //     → main chat's normal `'plain'` dispatch path handles
          //       in-process ACP / elanous LLM
          //     → multi-turn's auto-relisten still kicks in via
          //       notifyResponseDone after that turn ends
          //
          // This keeps the routed plain path canonical while avoiding
          // the old dictate-then-submit two-step, which left transcript
          // residue in the live prompt buffer.
          voiceChatSubmitImpl = (text) => {
            const sticky = dashboardAcpChat.getSticky();
            if (sticky) {
              // sticky armed — auto-submit is real, response stream
              // expected. Transition to `speaking` so the HUD's
              // voice-state segment reflects the assistant's turn
              // (prev: `processing`).
              dispatchAcpSend(sticky, text, []);
              try { dashboardVoiceChat.controller.transition('speaking'); }
              catch { /* swallow — controller may have raced into stopping */ }
              return;
            }
            // 2026-04-30 — sticky null but multi-turn ON. Route the
            // transcript through textInput's external submit hook with
            // the transcript payload itself. textInput replaces the
            // live buffer, injects a synthetic Enter, and the main
            // readKey loop returns through the normal `'plain'`
            // dispatch path (in-process ACP / elanous LLM). Auto-TTS
            // hooks fire there, and notifyResponseDone re-listens on
            // multi-turn.
            //
            // Phase: stay in `processing` until plain dispatch's
            // `onText` first chunk transitions to `speaking` — that
            // matches the user's intent ("실제 보이스 나오기 시작
            // 하면 표시").
            if (debug.enabled)
              debug.log('voice.chat.submit', 'plain.auto-submit', {
                chars: text.length,
                hasPromptCtl: typeof promptCtl.submit === 'function',
              });
            if (typeof promptCtl.submit === 'function') {
              promptCtl.submit({
                text,
                source: {
                  kind: 'voice',
                  surface: 'dashboard-chat-main',
                  mode: 'multi-turn',
                  transcriptSource: 'voice',
                  channel: 'dashboard',
                },
              });
              return;
            }
            // textInput is not currently live (boot race / pane
            // mode) — we can't auto-submit. Fall back to dictate-only
            // and exit voice-chat so the HUD doesn't lock at
            // `processing`.
            try { voiceRuntime.dictateTranscript(text); } catch { /* ignore */ }
            chatLines.push(C.muted(
              '  ℹ [voice-chat] 입력창이 활성화 안 됨 — transcript 가 채워짐, Enter 로 submit',
            ));
            chatScrollOffset = -1;
            try { dashboardVoiceChat.controller.exit('user-cancel'); }
            catch { /* swallow */ }
          };

          // ── Sticky multi-turn passthrough ──
          // When /acp ... --multi armed sticky mode, every plain
          // (non-slash) submit goes straight to that backend. Slash
          // input still drops into the normal switch below — the user
          // can call /acp exit, /clear, /quit, etc. without leaving
          // sticky implicitly. Attachments registered in the chat
          // input's contextRegistry are normalized into ACP image /
          // resource_link blocks so dropped screenshots and PDFs flow
          // naturally to the agent. debug.log gates the snapshot so
          // off-state stays zero-cost.
          const submitIntent = resolveDashboardChatMainSubmitIntent(input.text, {
            stickyBackend: dashboardAcpChat.getSticky(),
            source: input.externalSubmitSource,
          });
          const cmdText = submitIntent.kind === 'control-turn'
            ? (submitIntent.commandText ?? '')
            : submitIntent.text;
          if (submitIntent.kind === 'submit-turn' && parseSeatAsk(submitIntent.text)) {
            try {
              const receipt = await askSeat(submitIntent.text, { channel: 'tui', clientId: tuiSeatAskClientId },
                ceoTaskDeps(getUserConfig(), null), tuiSeatAskDeps);
              chatLines.push(C.info(receipt));
            } catch (error) {
              chatLines.push(C.error(`CTO 질문 전송 실패: ${String(error)}`));
            }
            chatScrollOffset = -1;
            draw();
            continue;
          }
          if (submitIntent.kind === 'submit-turn' && submitIntent.route === 'sticky-acp') {
            await runDashboardChatMainSubmitIntent({
              submit: createDashboardChatMainTurnSubmit(submitIntent),
              beforeExecute: (submit) => {
                maybeEmitDashboardSubmitQuickPass({
                  submit,
                  isOutputSpeaking: dashboardAutoTts.controller.isSpeaking(),
                  signalBus: dashboardControlSignals,
                });
              },
              runStickyAcpDispatch: ({ target, text }) => {
                const attachments = attachmentsToNormalized(ctxList(contextRegistry));
                if (debug.enabled) {
                  debug.log('acp.sticky.dispatch', target.backend, {
                    msgLen: text.length,
                    attachments: attachments.length,
                  });
                }
                dispatchAcpSend(target.backend as AcpBackendId, text, attachments);
              },
              runPlainTurn: async () => {},
            });
            continue;
          }

          // ── Slash commands — processed before Grok ──
          if (submitIntent.kind === 'control-turn' && submitIntent.command === 'slash-command') {
            if (slashQuickMode) exitInputLoop = true;
            const { cmdLower, args } = resolveDashboardChatMainSlashCommand(cmdText);
            // Phase B-1 · Try the registry first; fall through to the
            // legacy switch if the case hasn't migrated yet. Handlers
            // may continue the input loop (default · void return), exit
            // it via setExitInputLoop, or exit showDashboard via
            // { return: DashboardAction }.
            const dashboardSlashSurfaceUx = resolveDashboardSlashSurfaceUx();
            const clarificationSurfaceUx = dashboardSlashSurfaceUx ? {
              question: (request: Parameters<typeof dashboardSlashSurfaceUx.question>[0]) => {
                const pending = dashboardSlashSurfaceUx.question(request);
                if ((request as typeof request & { [DASHBOARD_CLARIFICATION_REQUEST]?: boolean })[DASHBOARD_CLARIFICATION_REQUEST]) {
                  const handle = approvalModalRouter.current();
                  if (approvalModalRouter.currentKind() === 'askUser' && handle) {
                    clarificationModalId = handle.surface.id;
                    void handle.promise.finally(() => {
                      if (clarificationModalId === handle.surface.id) clarificationModalId = null;
                    });
                  }
                }
                return pending;
              },
            } : undefined;
            const slashCtx: DashboardSlashContext = {
              ad: { run: (args) => dispatchDashboardAdSlash(adSlashRuntime, [...args], () => { draw(); }) },
              chatLines,
              getStatusLines: getDashboardStatusLines,
              ...(clarificationSurfaceUx ? { surfaceUx: clarificationSurfaceUx } : {}),
              attachmentRowMap,
              pushDebugLine,
              pushChatLine: (line) => { chatLines.push(line); },
              setChatScrollOffset: (n) => { chatScrollOffset = n; },
              setExitInputLoop: (v) => { exitInputLoop = v; },
              muted: C.muted,
              accent: C.accent,
              highlight: C.highlight,
              text: C.text,
              error: C.error,
              success: C.success,
              warning: C.warning,
              info: C.info,
              subtext: C.subtext,
              iconsSync: ICONS.sync,
              closeTui,
              exitTui: exitDashboardTui,
              showHelp,
              showHelpModal: ({ title, lines }) => {
                const { cols, rows } = termSize();
                showTransientTerminalModal({ title, lines: [...lines], coordinator: display, termCols: cols, termRows: rows, ttlMs: 0, group: 'dashboard-help' });
              },
              clearLogSearch,
              clearLogFilter,
              forkAttachedSessionFromChatHistory,
              toggleSessionControlMode: (state) =>
                toggleSessionControlMode(state as Parameters<typeof toggleSessionControlMode>[0]),
              resolveSessionInputModeFromChatMode: (opts) =>
                resolveSessionInputModeFromChatMode(opts as Parameters<typeof resolveSessionInputModeFromChatMode>[0]),
              inputCoreSetMode: (mode) =>
                inputCoreSetMode(mode as Parameters<typeof inputCoreSetMode>[0]),
              chatModeStateRef: { value: chatModeState },
              getChatOnlyMode: () => chatOnlyMode,
              setChatOnlyLayout: (next, opts) => { setChatOnlyLayout(next, opts); },
              enterSyncMode: () => { void enterSyncMode(); },
              handleVoiceChatSlash: (state, args2) =>
                handleVoiceChatSlash(state as Parameters<typeof handleVoiceChatSlash>[0], args2),
              voiceChatStateRef: { value: dashboardVoiceChat },
              reloadSkillIndex,
              blockStore,
              blockAttach,
              draw,
              autoTtsRef: dashboardAutoTts,
              controlSignalSlashRuntime,
              browserCdpSlashRuntime,
              widgetHost,
              backgroundTasksTextOnly: true,
              widgetModalPopup: {
                open: (s) => {
                  // Wave P4b-1 — bridge slash → widget-modal-popup.
                  // Wave P4b-2 — return a disposer + track the
                  // active handle so the host can enforce ephemeral
                  // lifecycle from outside the slash flow.
                  const term = termSize();
                  const width = Math.min(100, Math.max(40, term.cols - 6));
                  const height = Math.min(Math.max(14, term.rows - 4), term.rows - 2);
                  const bounds = {
                    row: Math.max(1, Math.floor((term.rows - height) / 2)),
                    col: Math.max(1, Math.floor((term.cols - width) / 2)),
                    width,
                    height,
                  };
                  const opened = openWidgetModalPopup(widgetHost, {
                    id: `${s.modalType}:${Date.now().toString(36)}`,
                    bounds,
                    widgetInstanceId: s.widgetInstanceId,
                    title: s.title,
                  });
                  if (!opened) return null;
                  const lifecycle = display.modalLifecycleAPI().push(
                    s.modalType as Parameters<ReturnType<typeof display.modalLifecycleAPI>['push']>[0],
                    { idempotencyKey: s.modalType },
                    opened.surface,
                  );
                  let disposed = false;
                  const dispose = (): void => {
                    if (disposed) return;
                    disposed = true;
                    try { lifecycle?.dispose?.(); } catch { /* ignore */ }
                    try { opened.dispose(); } catch { /* ignore */ }
                    activeWidgetPopupHandles.delete(s.modalType);
                  };
                  activeWidgetPopupHandles.set(s.modalType, { dispose });
                  return { dispose };
                },
              },
              preview: {
                slashRuntime: previewSlashRuntime,
                setDockedSource: (source) => { setDockedPreviewSource(source as Parameters<typeof setDockedPreviewSource>[0]); },
                setDockedBinding: (binding) => { setDockedPreviewBinding(binding as Parameters<typeof setDockedPreviewBinding>[0]); },
                refreshWorkingDirPreview,
                resolveBindingMode: (snap) => resolvePreviewBindingMode(snap as Parameters<typeof resolvePreviewBindingMode>[0]),
                dockedSnapshotRef: { value: dockedPreview as unknown as { sourceMode: unknown } & Record<string, unknown> },
              },
              contextSlash: {
                renderContextList,
                contextRegistry,
              },
              pasteSlash: {
                startThinking: (opts) => startThinking(opts as Parameters<typeof startThinking>[0]),
                attachClipboardImage,
                setNextInitial: (token) => { nextInitial = token; },
              },
              sessionResume: {
                openPicker: () => { openSessionResumePicker(); },
              },
              sessionFork: {
                openPicker: () => { openForkTimetravelPicker(); },
                timetravel: (n) => forkTimetravelFromChatHistory(n),
              },
              missionTui: {
                startReadyWatch: (missionId) => { startMissionReadyWatch(missionId); },
                startRunWatch: (missionId) => { startMissionRunWatch(missionId); },
              },
              refreshReasoningHudSegment,
              inputSeed: {
                appendBlock: (seed) => { inputPrefixState.appendBlock(seed); },
                setPendingPlainInput: () => { focusTransitionState.setPendingInputEntryMode('plain'); },
              },
              inputHistory: {
                store: inputHistoryStore as unknown as DashboardSlashContext['inputHistory']['store'],
                refresh: refreshInputHistory,
                openDetailViewer: (title, lines) => { setDetailViewer(title, lines); },
              },
              undo: {
                refreshGitDirty: () => { refreshGitDirty(getSessionCwd(), { force: true }); },
                bold: C.bold,
              },
              delta: {
                openBrowserPopup: (scope, limit, browserMode) =>
                  openSourceDeltaBrowserPopup(scope, limit, browserMode),
              },
              agentLauncher: {
                open: (brand, agentArgs) => {
                  TerminalPopup
                    .agent(brand)
                    .cwd(getSessionCwd())
                    .args([...agentArgs])
                    .open();
                },
              },
              theme: {
                pluginContributions: () => pluginHost?.activeThemeContributions() ?? [],
                currentTokens: () => currentThemeTokens(),
                requestRender: () => { requestDashboardRender(); },
              },
              provider: {
                slashRuntime: providerSlashRuntime,
                // 2026-05-05 — `/provider pick` slash opens the visual
                // model picker. Reuses the exact open-popup path the
                // status-bar pill click ONCE used (now a direct cycle).
                // Returns false when rotation is empty so the caller
                // can show the standard "rotation empty" line instead
                // of a popup with nothing in it.
                openPicker: () => {
                  const ring = getUserConfig().llm.rotation ?? [];
                  if (ring.length === 0) return false;
                  const { cols: tc, rows: tr } = termSize();
                  // Centred placement above the status row — slash
                  // commands have no pill anchor to honour, so we put
                  // the popup roughly mid-screen and let the recipe
                  // size itself.
                  const anchorMid = Math.floor(tc / 2);
                  const placement = {
                    anchorStartCol: Math.max(0, anchorMid - 16),
                    anchorEndCol: Math.min(tc, anchorMid + 16),
                    statusRow: tr - 1,
                    termCols: tc,
                    termRows: tr,
                  };
                  void (async () => {
                    const { createModelPickerRecipe } = await import('../mouse-action-recipes.js');
                    const handle = createModelPickerRecipe({
                      entries: ring,
                      placement,
                      theme: currentThemeTokens(),
                      shadow: process.env.ELANOUS_MODAL_SHADOW === 'off'
                        ? undefined
                        : { theme: currentThemeTokens() },
                      onSwitch: async (entry) => {
                        try {
                          const label = rotationEntryLabel(entry);
                          const { cfg: nextCfg } = jumpToRotationEntry(getUserConfig(), label);
                          saveUserConfig(nextCfg);
                          reloadUserConfig();
                        } catch (e) {
                          chatLines.push(C.error(`  model switch failed: ${e instanceof Error ? e.message : String(e)}`));
                          chatScrollOffset = -1;
                        }
                        draw();
                      },
                      onCancel: () => { draw(); },
                    });
                    handle.surface.onKey = (ev) => handle.handleKey(ev);
                    attachSurfaceToWorkspace(handle.surface, currentWorkspaceOwnerId());
                    display.pushModal(handle.surface);
                  })();
                  return true;
                },
              },
              compact: {
                getHistory: () => chat.history as unknown as { role: string; [k: string]: unknown }[],
              },
              skill: {
                triggersSlashRuntime: skillTriggersSlashRuntime,
                runSlashRuntime: runSkillSlashRuntime,
                runByName: (name, skillArgs) => runSkillByName(name, skillArgs),
              },
              setup: {
                launchPopup: (cmd) => {
                  const session = TerminalPopup.shell()
                    .cwd(workingDir.cwd)
                    .command(cmd)
                    .open();
                  return !!session;
                },
                openInlineFlow: (target) => {
                  const flow = createDashboardInlineSetupFlow({
                    termSize,
                    getUserConfig,
                    saveUserConfig,
                    reloadUserConfig,
                    pushModal: (surface) => display.pushModal(surface),
                    getTheme: () => currentThemeTokens(),
                    draw,
                    launchPopupWizard: (step) => {
                      const cmd = step ? `elanous setup ${step}` : 'elanous setup';
                      const s = TerminalPopup.shell()
                        .cwd(workingDir.cwd)
                        .command(cmd)
                        .open();
                      if (!s) {
                        chatLines.push(C.warning(`  ! popup spawn failed — fall back to: ${cmd}`));
                        chatScrollOffset = -1;
                      }
                    },
                    notifyInfo: (text) => {
                      chatLines.push(C.info(`  ${text}`));
                      chatScrollOffset = -1;
                    },
                    notifySuccess: (text) => {
                      chatLines.push(C.success(`  ${text}`));
                      chatScrollOffset = -1;
                    },
                    notifyWarning: (text) => {
                      chatLines.push(C.warning(`  ${text}`));
                      chatScrollOffset = -1;
                    },
                    notifyError: (text) => {
                      chatLines.push(C.error(`  ${text}`));
                      chatScrollOffset = -1;
                    },
                  });
                  flow.open(target as Parameters<typeof flow.open>[0]);
                },
              },
              plugin: {
                host: pluginHost as unknown as DashboardSlashContext['plugin']['host'],
                onAfterActivate: () => {
                  refreshDashboardViewsFromPlugins();
                  // Wire a minimal actions bridge for plugins that
                  // expose one (e.g. consensus-trader uses
                  // `state.actions.exit()` to let its `q`/`esc`
                  // keybinding deactivate the plugin, and `notify()`
                  // to push a log line). Sync plugin wires its own
                  // richer bridge via enterSyncMode.
                  const active = pluginHost.active();
                  const s = active?.state as { actions?: Record<string, unknown> } | undefined;
                  if (s && typeof s === 'object' && 'actions' in s) {
                    s.actions = {
                      exit: async () => {
                        await pluginHost.deactivate();
                        draw();
                      },
                      notify: (m: string) => {
                        chatLines.push(C.muted(m));
                        chatScrollOffset = -1;
                        draw();
                      },
                    };
                  }
                },
                enterSyncMode: () => enterSyncMode(),
                exitSyncMode: () => exitSyncMode(),
                bold: C.bold,
              },
              conv: {
                listLiveSessions: () => listLiveEmbodiedSessions() as unknown as ReturnType<DashboardSlashContext['conv']['listLiveSessions']>,
                setLayoutMode: (mode) => { setConversationPopupLayoutMode(mode); },
                focusPopup: (direction) => focusConversationPopup(direction),
                openModal: (sessionId) => openConversationModal(sessionId),
              },
              sim: {
                slashRuntime: simSlashRuntime,
                openWebCockpit: () => openDashboardSimulationWebCockpit(),
                listScenarios: () => listDashboardSimulationScenarios(),
                runById: (scenarioId) => runDashboardSimulationById(scenarioId as Parameters<typeof runDashboardSimulationById>[0]),
                resolveScenarioId: (raw) => {
                  const target = raw.trim().toLowerCase();
                  if (!target) return null;
                  const aliases = new Map<string, Parameters<typeof runDashboardSimulationScenario>[0]>([
                    ['picture', 'media-picture-smoke'],
                    ['image', 'media-picture-smoke'],
                    ['media-picture-smoke', 'media-picture-smoke'],
                    ['video-stop', 'media-video-stop-gate'],
                    ['video', 'media-video-stop-gate'],
                    ['media-video-stop-gate', 'media-video-stop-gate'],
                    ['cdp-status', 'browser-cdp-status'],
                    ['browser-cdp-status', 'browser-cdp-status'],
                    ['cdp-smoke', 'browser-cdp-smoke'],
                    ['browser-cdp-smoke', 'browser-cdp-smoke'],
                    ['cdp-stop', 'browser-cdp-stop'],
                    ['browser-cdp-stop', 'browser-cdp-stop'],
                  ]);
                  return aliases.get(target) ?? null;
                },
              },
              intake: {
                runSlash: async (intakeArgs) => {
                  try {
                    const { resolveIntakeSlash } = await import('../intake-plane/slash.js');
                    const {
                      openDashboardIntakeSessionPicker,
                      openDashboardIntakeReviewModal,
                      shouldOpenDashboardIntakeSessionPicker,
                      shouldOpenDashboardIntakeReviewModal,
                    } = await import('./intake-review-runtime.js');
                    const intakeUiDeps = {
                      store: (await import('../intake-plane/runtime.js')).getIntakeStore(),
                      ownerWorkspaceId: currentWorkspaceOwnerId(),
                      termSize,
                      getTheme: () => currentThemeTokens(),
                      pushModalSurface: (surface: import('../display/modal-stack.js').ModalSurface) => display.pushModal(surface),
                      redraw: draw,
                      onStatus: (line: string) => {
                        chatLines.push(C.muted(`  ${line}`));
                        chatScrollOffset = -1;
                      },
                      onError: (message: string) => {
                        chatLines.push(C.error(`  /intake review failed: ${message}`));
                        chatScrollOffset = -1;
                      },
                    };
                    const r = await resolveIntakeSlash([...intakeArgs], {
                      getScratchSnapshot: () => {
                        const snapshot = display.scratchState();
                        return snapshot && snapshot.mode !== 'agents'
                          ? { title: snapshot.title, lines: [...snapshot.lines] }
                          : { title: scratchTitle, lines: [...scratchLines] };
                      },
                    });
                    if (shouldOpenDashboardIntakeSessionPicker([...intakeArgs], r)) {
                      openDashboardIntakeSessionPicker(r.sessions, intakeUiDeps);
                    } else if (shouldOpenDashboardIntakeReviewModal([...intakeArgs], r)) {
                      await openDashboardIntakeReviewModal(r.session, intakeUiDeps);
                    } else {
                      const prefix = r.action === 'refresh' ? C.muted : C.warning;
                      for (const line of r.output.split('\n')) {
                        chatLines.push(prefix(`  ${line}`));
                      }
                    }
                  } catch (err) {
                    chatLines.push(C.error(`  /intake failed: ${err instanceof Error ? err.message : String(err)}`));
                  }
                  chatScrollOffset = -1;
                  draw();
                },
              },
              agents: {
                slashRuntime: agentsSlashRuntime,
                openView: () => {
                  const def = viewRegistry.views.find(view => view.id === 'agents');
                  if (def) {
                    setActiveDashboardView(def);
                    return true;
                  }
                  return false;
                },
                setDismissed: (value) => { agentsViewDismissed = value; },
                popup: {
                  open: () => { setCompanionPopupOpen('agents', true); },
                  close: () => {
                    companionPopupHost.close('agents');
                    setCompanionPopupOpen('agents', false);
                  },
                  toggle: () => {
                    const opened = toggleCompanionPopup('agents');
                    if (!opened) companionPopupHost.close('agents');
                    return opened;
                  },
                  promote: () => { promoteCompanionPopup('agents'); },
                },
              },
              tablet: {
                getState: () => ({
                  manual: tabletModeManual,
                  effective: effectiveTabletMode(),
                  level: compactLevelForViewport(paneViewport()),
                  compactMode: productCompactModeForViewport(paneViewport()),
                }),
                setManual: (value) => { tabletModeManual = value; },
                requestRender: () => { requestDashboardRender(); },
                openBrowserPreviewModal: () => { openBrowserPreviewModal(); },
              },
              childScreen: {
                runId: () => getHarnessRunId(process.env),
                list: listDashboardChildScreens,
                snapshot: (id, manifestDbPath) => {
                  const deps: PtyTakeoverCommandDeps = {
                    getPty,
                    requestPtyTakeover,
                    requestRemote: (ptyId, action, payload, options) => requestRemotePtyControl(ptyId, action, payload, { ...options, manifestDbPath }),
                    listRefs: () => [{ id, kind: 'self', source: 'remote', alive: true }],
                    log: () => {},
                  };
                  return runPtySnapshot(id, deps);
                },
                show: ({ title, lines }) => {
                  const { cols, rows } = termSize();
                  showTransientTerminalModal({
                    title,
                    lines: [...lines],
                    coordinator: display,
                    termCols: cols,
                    termRows: rows,
                    ttlMs: 5000,
                    group: 'harness-child-screen',
                  });
                },
              },
              playground: {
                runCommand: async (args2) => {
                  const reg = ensureDefaultPlaygroundScenarioRegistry();
                  const lines: string[] = [];
                  const handler = createPlaygroundCommandHandler({
                    registry: reg,
                    makeHarness: () => createLivePlaygroundHarness({
                      coordinator: display,
                      contextKeys: getDashboardContextKeyService(),
                      termSize: () => termSize(),
                      setTheme: (name) => {
                        // Best-effort theme switch — follow-up can wire
                        // the real ThemeService. For F-B2 we log the
                        // intent so scenarios that assert theme switches
                        // still show up in the command output.
                        lines.push(`    (theme-switch requested: ${name})`);
                      },
                    }),
                    write: (l) => lines.push(l),
                    onEditScenario: async (scenario) => {
                      if (!openPlaygroundScenarioEditor(scenario)) {
                        throw new Error('playground widget instance unavailable');
                      }
                    },
                  });
                  await handler([...args2]);
                  return lines;
                },
              },
              substrateStats: {
                paintCacheStats: () => display.paintCacheStats(),
                overlayWriteStats: () => display.overlayWriteStats(),
                generationStats: () => display.generationStats(),
                f8ShadowStats: () => display.f8ShadowStats(),
              },
              companion: {
                popupHost: {
                  isOpen: (key) => companionPopupHost.isOpen(key),
                },
                setPopupOpen: (key, next) => { setCompanionPopupOpen(key, next); },
                openClipboard: () => openClipboardCompanion(),
                closeClipboard: () => { closeClipboardCompanion(); },
                openMemo: () => { openMemoCompanion(); },
                cancelMemo: () => { cancelMemoCompanion(); },
                commitMemo: () => { commitMemoCompanion(); },
                closeDetail: () => { closeDetailCompanion(); },
                clearDetailViewer: () => { clearDetailViewer(); },
                clearClipHistory: () => { clipHistory.clear(); clipCursor = 0; },
                notifyClipboardCleared: () => { statusFeedbackRuntime.onClipboardHistoryCleared(); },
                notifyClipboardToggled: (open) => { statusFeedbackRuntime.onClipboardCompanionPopupToggled(open); },
                slashRuntime: companionSlashRuntime,
              },
              compactSlash: {
                chatHistory: chat.history as ChatMessage[],
                activeModelId: () => inspectActiveProvider().model ?? undefined,
                sessionId: () => attachedSessionId ?? undefined,
                getProvider: () => getDefaultCompactProvider(),
              },
              logSlash: {
                pushDebugBlank,
                getLogHeightBias: () => logHeightBias,
                setLogHeightBias: (v) => { logHeightBias = v; },
                recomputePaneHeight: () => { computePaneH(termSize().rows); },
                getLogFilterQuery: () => logFilterQuery,
                applyLogFilter: (q) => { applyLogFilter(q); },
                getLogSearchResultsCount: () => logSearchResults.length,
                firstSearchResultLineIdx: () => (logSearchResults.length > 0 ? logSearchResults[0]!.lineIdx : null),
                applyLogSearch: (q) => { applyLogSearch(q); },
                scrollToSearchLineIdx: (lineIdx) => {
                  const target = logSearchResults.find(r => r.lineIdx === lineIdx);
                  if (target) scrollToSearchResult(target);
                },
                openLogSearchModal: () => { openLogSearchModal(); },
                isLogFreezeEnabled: () => logFreezeEnabled,
                getLogFrozenTailIndex: () => logFrozenTailIndex,
                chatLinesLength: () => chatLines.length,
                getLogTurnSeparatorMode: () => logTurnSeparatorMode,
                setLogTurnSeparatorMode: (mode) => { logTurnSeparatorMode = mode; },
                pushTurnSeparator: () => { pushTurnSeparator(); },
                getLogFoldMode: () => logFoldMode,
                setLogFoldMode: (mode) => { logFoldMode = mode; },
                copyEntireLog: async () => { await copyLogBlock(-1, 'all'); },
                returnFocusToInput: () => {
                  const sourceFocus = workingDir.focus;
                  if (sourceFocus !== 'input') {
                    applyFocusToInputTransition(resolveFocusToInputTransition({
                      sourcePane: sourceFocus,
                      rememberPane: true,
                      reason: 'log-slash-return-to-input',
                    }));
                  }
                },
                toggleSolo: () => {
                  // TUI 부활 T2 — setChatOnlyLayout 단일 경로로 수렴
                  // (종전엔 pill 만 직접 조작 · computePaneH 재계산 누락).
                  const prev = chatOnlyMode;
                  toggleChatOnlyLayout();
                  if (debug.enabled) {
                    debug.log('slash.log.toggleSolo', chatOnlyMode ? 'on' : 'off', {
                      prevChatOnlyMode: prev,
                      newChatOnlyMode: chatOnlyMode,
                      hudSegmentAction: chatOnlyMode ? 'set:mode:chat' : 'clear:mode',
                    });
                  }
                  return chatOnlyMode;
                },
              },
              debugSlash: {
                getDebugLines: () => debugLines,
                setDebugScrollOffset: (v) => { debugScrollOffset = v; },
                getDebugLogFilterQuery: () => debugLogFilterQuery,
                applyDebugLogFilter: (q) => { applyDebugLogFilter(q); },
                clearDebugLogFilter: () => { clearDebugLogFilter(); },
                ensureToolCallSubscription: () => { ensureToolCallSubscription(); },
                openDebugView: () => {
                  const def = findDashboardView(viewRegistry, 'debug');
                  if (def) {
                    setActiveDashboardView(def);
                    setWorkingFocus('debug-events', 'slash-debug-view');
                    return true;
                  }
                  return false;
                },
                openDebugWindow: () => { openDebugWindow(); },
                closeDebugWindow: () => {
                  if (debugWindowHandle) {
                    debugWindowHandle.dispose();
                    debugWindowHandle = null;
                  }
                  draw();
                },
                toggleDebugWindow: () => toggleDebugWindow(),
                openDebugWorkbenchModal: () => { openDebugWorkbenchModal(); },
                closeDebugWorkbenchModal: () => {
                  if (debugWorkbenchHandle) {
                    debugWorkbenchHandle.dispose();
                    debugWorkbenchHandle = null;
                  }
                  draw();
                },
                toggleDebugWorkbenchModal: () => toggleDebugWorkbenchModal(),
                setCompanionTargetsOpen: (targets, next) => {
                  setDebugCompanionTargets(targets as DebugWorkbenchPane[], next);
                },
                toggleCompanionTargets: (targets) => toggleDebugCompanionTargets(targets as DebugWorkbenchPane[]),
                promoteCompanion: (target) => { promoteCompanionPopup(target as DebugWorkbenchPane); },
              },
              promptSlash: {
                runtimeState: (intents) => promptRuntimeState(intents),
                setRuntimeConfig: (patch) => setPromptBankRuntimeConfig(patch),
                describeRuntimeConfig: () => describePromptBankRuntimeConfig(),
                parseOnOffArg: (raw, current) => parseOnOffArg(raw, current),
                activePluginName: () => pluginHost.active()?.name,
                openDetailViewer: (title, lines) => { setDetailViewer(title, lines); },
              },
              getAttachedSessionId: () => attachedSessionId,
              setAttachedSessionId: (id) => { attachedSessionId = id; },
              chatPersona: {
                sessionId: currentChatPersonaSessionId,
                selection: chatPersonaSelection,
                newConversation: () => { chatPersonaConversationId = crypto.randomUUID(); },
              },
              getAttachedChatId: () => attachedChatId,
              setAttachedChatId: (id) => { attachedChatId = id; },
              sessionSlash: {
                remoteDaemon: () => opts.remote
                  ? { url: opts.remote.url, token: opts.remote.token }
                  : null,
                acpSwapTo: (sessionId, cwd) => dashboardAcpSession.swapTo(sessionId, cwd),
              },
              shellSlash: {
                slashRuntime: shellSlashRuntime,
                openRollupPopup: () => openShellRollupPopup(),
                virtualWindowsSwitchTo: () => { throw new Error('Virtual windows are unavailable in the essential dashboard'); },
                resolveVwIdByLabel: () => null,
              },
              termSlash: {
                slashRuntime: termSlashRuntime,
                sessionRegistry: sessionRegistry as unknown as DashboardSlashContext['termSlash']['sessionRegistry'],
                terminalMatrix: terminalMatrix as unknown as DashboardSlashContext['termSlash']['terminalMatrix'],
                vwRegistry: {
                  current: () => null,
                  get: () => null,
                },
                broadcastBus: broadcastBus as unknown as DashboardSlashContext['termSlash']['broadcastBus'],
                channelBus: channelBus as unknown as DashboardSlashContext['termSlash']['channelBus'],
                openSessionPicker: () => {
                  // /term switch wraps createSessionPickerModal +
                  // attachSurfaceToWorkspace + display.pushModal + the
                  // agentSearchModal/Handle mutation pair (the dashboard
                  // input loop reads agentSearchModal to route keys to
                  // the picker while alive).
                  const cols = termSize().cols;
                  const modalWidth = Math.min(78, cols - 4);
                  const modalCol = Math.max(2, Math.floor((cols - modalWidth) / 2));
                  const pickerHandle = createSessionPickerModal({
                    registry: sessionRegistry,
                    bounds: { row: 3, col: modalCol, width: modalWidth, height: 12 },
                    width: modalWidth,
                    maxVisible: 8,
                    theme: currentThemeTokens(),
                    onAccept: (session) => {
                      pushModalDispose?.dispose();
                      const { cols: tc, rows: tr } = termSize();
                      const attached = sessionRegistry.attach(session.id, { termCols: tc, termRows: tr });
                      if (attached?.modal) {
                        terminalModalRouter.set(attached.modal, {
                          onClose: () => { sessionRegistry.detach(attached.id); draw(); },
                        });
                        draw();
                      }
                    },
                    onCancel: () => { pushModalDispose?.dispose(); draw(); },
                  });
                  attachSurfaceToWorkspace(pickerHandle.surface, currentWorkspaceOwnerId());
                  const pushModalDispose = display.pushModal(pickerHandle.surface);
                  agentSearchModal = pickerHandle;
                  agentSearchHandle = pushModalDispose;
                  draw();
                },
                openSession: (session) => {
                  if (!session.modal) return;
                  terminalModalRouter.set(session.modal as Parameters<typeof terminalModalRouter.set>[0], {
                    onClose: () => { sessionRegistry.detach(session.id); draw(); },
                  });
                  draw();
                },
                setWorkingFocusPreview: () => { setWorkingFocus('preview', 'slash-term-move-preview'); },
                nextTerminalVwSlotId: (terminalId) => `term-slot:${terminalId}`,
              },
            };
            const slashOutcome = await dashboardSlashRegistry.dispatch(cmdLower, args, slashCtx);
            if (debug.enabled) {
              debug.log('dashboard.slash.dispatch', cmdLower, {
                argsCount: args.length,
                args0: args[0] ?? null,
                outcomeKind: slashOutcome.kind,
                exitInputLoop,
                chatOnlyMode,
              });
            }
            if (slashOutcome.kind === 'return') return slashOutcome.value;
            if (slashOutcome.kind === 'continue') {
              if (exitInputLoop) break;
              continue;
            }
            switch (cmdLower) {
              // B-3.a migrated: /log → registry handler.
              // B-2.i migrated: /delta /diffs → registry handler.
              // B-2.r migrated: /theme → registry handler.
              // B-2.a migrated: /audit → registry handler.
              // B-2.j migrated: /playground → registry handler.
              // B-2.a migrated: /substrate-stats /sst → registry handler.
              case 'hint': {
                // P6: tool-selection hints. The registry at
                // src/tool-hints/registry.ts holds four scopes (turn,
                // session, project, global); project+global persist
                // to ~/.config/monad-agent/hints.json.
                //
                // Subcommands:
                //   /hint prefer <tool> [scope]  — boost +2
                //   /hint avoid  <tool> [scope]  — boost -1
                //   /hint enable <tool> [scope]  — add to enabled set
                //   /hint disable <tool> [scope] — remove from enabled set
                //   /hint list [scope]           — print current hints
                //   /hint show                   — dump state + active signals
                //   /hint reset [scope|all]      — clear
                const sub = (args[0] || 'show').toLowerCase();
                const kinds = new Set(['prefer', 'avoid', 'enable', 'disable']);
                if (kinds.has(sub)) {
                  const tool = args[1];
                  if (!tool) {
                    pushDebugLine(C.warning(`  usage: /hint ${sub} <tool> [turn|session|project|global]`));
                  } else {
                    const scopeArg = (args[2] || 'turn').toLowerCase() as HintScope;
                    const validScopes: HintScope[] = ['turn', 'session', 'project', 'global'];
                    if (!validScopes.includes(scopeArg)) {
                      pushDebugLine(C.warning(`  invalid scope '${scopeArg}' — use turn|session|project|global`));
                    } else {
                      const h = addHint({
                        kind: sub as 'prefer' | 'avoid' | 'enable' | 'disable',
                        tool,
                        scope: scopeArg,
                        sourceSignal: 'slash',
                      });
                      resetGateCache();
                      pushDebugLine(C.success(`  hint ${sub} ${tool} (scope=${scopeArg}, id=${h.id})`));
                    }
                  }
                } else if (sub === 'list') {
                  const scopeFilter = args[1]?.toLowerCase() as HintScope | undefined;
                  const hints = scopeFilter ? listHints(scopeFilter) : listHints();
                  if (hints.length === 0) {
                    pushDebugLine(C.muted('  no active hints'));
                  } else {
                    for (const h of hints) {
                      const usesLeft = h.usesLeft !== undefined ? ` uses=${h.usesLeft}` : '';
                      const ttl = h.expiresAt ? ` ttl=${Math.max(0, Math.round((h.expiresAt - Date.now()) / 1000))}s` : '';
                      const reason = h.reason ? ` "${h.reason}"` : '';
                      pushDebugLine(C.muted(`  ${h.scope.padEnd(7)} ${h.kind.padEnd(14)} ${h.tool.padEnd(16)} id=${h.id}${usesLeft}${ttl}${reason}`));
                    }
                  }
                } else if (sub === 'show') {
                  const hints = listHints();
                  const signals = collectSignals({});
                  pushDebugLine(C.muted(`  signals: ${signalsSummary(signals)}`));
                  pushDebugLine(C.muted(`  hints: ${hints.length} active`));
                  for (const h of hints.slice(0, 20)) {
                    pushDebugLine(C.muted(`    ${h.scope}:${h.kind} ${h.tool} (${h.id})`));
                  }
                  if (hints.length > 20) pushDebugLine(C.muted(`    ... +${hints.length - 20} more (use /hint list)`));
                } else if (sub === 'reset') {
                  const target = (args[1] || 'turn').toLowerCase();
                  const valid = new Set(['turn', 'session', 'project', 'global', 'all', 'probes']);
                  if (!valid.has(target)) {
                    pushDebugLine(C.warning(`  usage: /hint reset turn|session|project|global|all|probes`));
                  } else if (target === 'probes') {
                    resetProbes();
                    resetGateCache();
                    pushDebugLine(C.success('  probes reset — next draw re-runs capability checks'));
                  } else {
                    const removed = resetScope(target as HintScope | 'all');
                    resetGateCache();
                    pushDebugLine(C.success(`  reset ${target} — removed ${removed} hint${removed === 1 ? '' : 's'}`));
                  }
                } else if (sub === 'remove' || sub === 'rm') {
                  const id = args[1];
                  if (!id) {
                    pushDebugLine(C.warning('  usage: /hint remove <id>'));
                  } else {
                    const ok = removeHint(id);
                    resetGateCache();
                    pushDebugLine(ok ? C.success(`  removed hint ${id}`) : C.warning(`  no hint with id ${id}`));
                  }
                } else {
                  pushDebugLine(C.warning('  usage: /hint prefer|avoid|enable|disable|list|show|reset|remove'));
                }
                chatScrollOffset = -1;
                continue;
              }
              // B-2.h migrated: /pty-pane /pty-view → registry handler.
              // B-2.d migrated: /api-allow /api → registry handler.
              // B-3.a migrated: /debug → registry handler.
              // B-2.t migrated: /compact → registry handler.
              // B-2.a migrated: /wd → registry handler.
              // B-2.k migrated: /tablet → registry handler.
              // B-2.n migrated: /turn-slider /turnslider /tslider → registry handler.
              // B-1.e migrated: /pause → registry handler (turn-checkpoint dynamic import).
              // B-2.c migrated: /resume → registry handler.
              // B-2.c migrated: /research → registry handler.
              // B-2.c migrated: /branch → registry handler.
              // B-2.u migrated: /git → registry handler.
              // B-2.b migrated: /plan → registry handler.
              // B-2.b migrated: /code-edit /ce → registry handler.
              // B-3.a migrated: /prompt /prompts → registry handler.
              // B-2.e migrated: /history /hist /inputs → registry handler.
              // B-1.e migrated: /chat (toggle layout) and /qc (arm quick-control)
              // — both moved to the registry. The /control · /dm · /default
              // case below stays inline in B-1.e (medium tier · B-1.f or B-2).
              // Phase α1 — persistent control-mode toggle. /ctoggle
              // flips between default ↔ control without
              // requiring /control + /default as separate slashes.
              // B-1.h migrated: /control /dm /default · /surface → registry handlers.
              // T7-N2 / T7-Q — /acp: real ACP JSON-RPC chat surface.
              // Slash parsing is delegated to parseAcpSlash
              // (dashboard-acp-chat.ts) so the routing logic is
              // testable without a dashboard. Side effects (chat
              // line append, streaming callbacks) stay here.
              case 'acp': {
                const sub = (args[0] ?? '').toLowerCase();
                const subArgs = args.slice(1);
                const outcome = parseAcpSlash(sub, subArgs, dashboardAcpChat);
                if (outcome.kind === 'help' || outcome.kind === 'message') {
                  const accent = outcome.kind === 'help' ? C.accent : C.muted;
                  chatLines.push(accent(outcome.lines[0]!));
                  for (const l of outcome.lines.slice(1)) chatLines.push(C.muted(l));
                  chatScrollOffset = -1;
                  continue;
                }
                if (outcome.kind === 'cancel') {
                  void dashboardAcpChat.cancel().then((ok) => {
                    chatLines.push(ok ? C.warning('  /acp cancelled') : C.muted('  /acp: nothing in flight'));
                    chatScrollOffset = -1;
                    draw();
                  });
                  continue;
                }
                if (outcome.kind === 'status') {
                  const live = dashboardAcpChat.list();
                  if (live.length === 0) {
                    chatLines.push(C.muted('  /acp: no active sessions'));
                  } else {
                    for (const s of live) {
                      chatLines.push(C.muted(`  • ${displayBackendName(s.backendId)} — session ${s.sessionId.slice(0, 12)}${s.inFlight ? ' (in-flight)' : ''}`));
                    }
                  }
                  chatScrollOffset = -1;
                  continue;
                }
                if (outcome.kind === 'drop') {
                  dashboardAcpChat.dropSession(outcome.backend);
                  chatLines.push(C.muted(`  /acp: dropped ${displayBackendName(outcome.backend)} session`));
                  chatScrollOffset = -1;
                  continue;
                }
                if (outcome.kind === 'send') {
                  // Slash one-shot path keeps the no-attachment shape;
                  // sticky is the only entry that pulls contextRegistry.
                  dispatchAcpSend(outcome.backend, outcome.message, []);
                }
                if (outcome.kind === 'enter-sticky') {
                  dashboardAcpChat.setSticky(outcome.backend);
                  chatLines.push(
                    C.accent(`  ⟳ ACP sticky · ${displayBackendName(outcome.backend)}`) +
                    C.muted('  · /acp exit to leave (--drop also evicts session)'),
                  );
                  chatScrollOffset = -1;
                  if (outcome.firstMessage) {
                    const attachments = attachmentsToNormalized(ctxList(contextRegistry));
                    dispatchAcpSend(outcome.backend, outcome.firstMessage, attachments);
                  } else {
                    draw();
                  }
                  continue;
                }
                if (outcome.kind === 'exit-sticky') {
                  const wasSticky = dashboardAcpChat.getSticky();
                  if (!wasSticky) {
                    chatLines.push(C.muted('  /acp: not in sticky mode'));
                  } else {
                    dashboardAcpChat.clearSticky({ drop: outcome.drop });
                    // Sprint 5C — header uses accent (parity with the
                    // sticky-on `⟳` line). The trailing `· session
                    // kept/dropped` keeps its severity-graded color so
                    // a destructive drop still pops while a routine
                    // keep stays calm.
                    chatLines.push(
                      C.accent(`  ⊘ ACP sticky off · ${displayBackendName(wasSticky)}`) +
                      (outcome.drop ? C.warning('  · session dropped') : C.muted('  · session kept')),
                    );
                  }
                  chatScrollOffset = -1;
                  continue;
                }
                continue;
              }
              // B-2.w migrated: /conv → registry handler.
              // H5 P3 · /handoff <fromId> <toBrand> [--channels reasoning,plan]
              //         Cross-agent snapshot-based context transfer.
              // B-1.i migrated: /handoff → registry handler.
              // B-1.d migrated: budget/b · route · agent-room · showroom ·
              // lane · relay · reply · capture · inject · llm — all share
              // the deferred skill-tool slash shape via
              // `runDeferredSkillToolSlash` (see slash-runtime/dashboard-handlers).
              // B-2.p migrated: /view /v → registry handler.
              // B-1.h migrated: /preview /pv → registry handler.
              // B-2.l migrated: /agents /agent /ag → registry handler.
              // B-1.f migrated: /clipboard /clip /cb · /memo /note /me ·
              // /detail /report /dv → registry handlers (companion ctx field).
              // B-2.o migrated: /intake → registry handler.
              // B-1.g migrated: /signals /signal → registry handler (controlSignalSlashRuntime ctx field).
              case 'media':
              case 'mv': {
                const result = resolveDashboardMediaSlash(args, {
                  lastAssistantRaw,
                  lastAssistantRange,
                  lastAssistantMode,
                });
                chatLines.push('');
                chatLines.push(C.accent(`❯ /media ${args.join(' ').trim() || 'status'}`));
                for (const line of result.lines) chatLines.push(C.muted(line));
                if (result.action.kind === 'seed-sample') {
                  ({ lastAssistantRaw, lastAssistantRange, lastAssistantMode } = appendDashboardAssistantSampleOutput({
                    chatLines,
                    text: result.action.text,
                    termCols: termSize().cols,
                    wrapEnabled: getUserConfig().chat.rendering.wrap,
                    formatResponse,
                    renderTextLine: C.text,
                  }));
                } else if (result.action.kind === 'clear') {
                  lastAssistantRaw = null;
                  lastAssistantRange = null;
                  lastAssistantMode = 'rendered';
                } else if (result.action.kind === 'open') {
                  await openLastAssistantMediaPreview();
                }
                chatScrollOffset = -1;
                continue;
              }
              // B-1.g migrated: /browser-cdp /bcdp → registry handler.
              // B-2.q migrated: /sim /simulator → registry handler.
              // B-1.e migrated: /auto-tts /autotts /tts — moved to the registry
              // (autoTtsRef threaded through DashboardSlashContext).
              // B-1.g migrated: /widget /widgets /w → registry handler.
              // B-2.y migrated: /plugin /plugins \u2192 registry handler.
              // (/p alias dropped \u2014 collided with /provider's /p which
              // claimed it via earlier registry registration in B-2.s.)
              // B-1.h migrated: /context /ctx \u00b7 /paste \u2192 registry handlers
              // (`/paste`'s `v` alias was dead in this switch \u2014 `/view`'s
              // `v` matched first \u2014 and was dropped during migration).
              // B-1.i migrated: /reasoning /r /think → registry handler.
              // B-2.s migrated: /provider /p → registry handler.
              // B-3.b migrated: /session /sess → registry handler.
              // B-3.c.1 migrated: /local /ll → registry handler.
              // B-3.b migrated: /telegram /tg → registry handler.
              // B-2.x migrated: /skill-triggers /triggers · /run-skill /rs /run → registry handlers.
              // B-3.c.1 migrated: /shell /sh → registry handler.
              // B-3.c.2 migrated: /term /terminal → registry handler.
              // B-2.m migrated: /claude /codex /gemini → registry handlers.
              // B-3.d migrated: /workspace /ws /window /win → registry handler.
              // /ad 는 registry handler 로 migrated — dashboard-handlers.ts 의 registry.register('ad').
              case 'research': case 'rsh': {
                const { executeResearchSlash, parseResearchArgs } = await import('../auto-research/slash-execute.js');
                const { dispatchToolByName } = await import('../tool-runtime/index.js');
                const parsed = parseResearchArgs({ tokens: args });
                if ('error' in parsed) {
                  chatLines.push(C.warning(parsed.error));
                  chatScrollOffset = -1;
                  continue;
                }
                const res = await executeResearchSlash(
                  parsed,
                  (name, input) => dispatchToolByName(name, input, { surface: 'tui' }),
                );
                for (const line of res.lines) {
                  chatLines.push(res.success ? C.muted(line) : C.warning(line));
                }
                chatScrollOffset = -1;
                continue;
              }
              // /goal starts a persistent cross-turn objective. Its
              // active state arms the chat-loop hook, which alone decides
              // whether each completed assistant turn continues or stops.
              case 'goal': case 'g': {
                const { executeGoalSlash, renderGoalSlashOutcomeLines } = await import('../goals/slash.js');
                const { getUserConfig } = await import('../user-config.js');
                const cfg = getUserConfig();
                const subcommand = args[0] ?? '';
                const rest = args.slice(1);
                const outcome = executeGoalSlash({
                  subcommand,
                  rest,
                  defaultMode: cfg.goals.modeDefault,
                  config: cfg.goals,
                });
                const isErr = outcome.kind === 'error';
                for (const line of renderGoalSlashOutcomeLines(outcome)) {
                  chatLines.push(isErr ? C.warning(line) : C.muted(line));
                }
                chatScrollOffset = -1;
                continue;
              }
              case 'plan': {
                // Slash alias for EnterPlanMode. The model usually
                // calls EnterPlanMode itself when it judges plan mode
                // appropriate; this slash is a discoverable manual
                // entry point. The Shift+Tab hotkey is P1.4.
                const sub = (args[0] ?? '').toLowerCase();
                if (sub === 'status') {
                  const { getPlanModeState } = await import('../plan-mode/index.js');
                  const s = getPlanModeState();
                  if (!s.active) chatLines.push(C.muted('  Plan mode: inactive.'));
                  else chatLines.push(C.muted(`  Plan mode: active · phase=${s.phase} · session=${s.sessionId}`));
                  chatScrollOffset = -1;
                  continue;
                }
                if (sub === 'exit') {
                  const { isPlanModeActive } = await import('../plan-mode/index.js');
                  if (!isPlanModeActive()) {
                    chatLines.push(C.warning('  /plan exit — plan mode is not active.'));
                  } else {
                    chatLines.push(C.muted('  /plan exit — invoke ExitPlanMode tool to surface the 3-way modal.'));
                  }
                  chatScrollOffset = -1;
                  continue;
                }
                // 'enter' (default) — instruct the user to either type
                // an EnterPlanMode-triggering ask, or wait for the
                // P1.4 Shift+Tab dispatcher. Not auto-invoking
                // EnterPlanMode here keeps this PR file-disjoint.
                chatLines.push(C.muted(
                  '  /plan — Plan mode toggle hotkey (Shift+Tab) lands in P1.4 follow-up.'
                ));
                chatLines.push(C.muted(
                  '  For now: ask "Help me plan ..." and the model will invoke EnterPlanMode automatically.'
                ));
                chatScrollOffset = -1;
                continue;
              }
              default: {
                // Fall through to the active plugin's slash-command
                // table so plugin-contributed `/ct-set-query`, etc.
                // work from the chat input without dashboard needing
                // to know about them. dispatchSlash returns false if
                // the name doesn't match; we surface the usual hint.
                if (pluginHost.active()) {
                  const handled = await pluginHost.dispatchSlash(cmdLower, args);
                  if (handled) { chatScrollOffset = -1; continue; }
                }
                const replyLines = unknownSlashReply(cmdLower, dashboardSlashRegistry.names());
                for (const [index, line] of replyLines.entries()) {
                  chatLines.push(index === 0 ? C.warning(line) : C.muted(line));
                }
                chatScrollOffset = -1;
                continue; // stay in input mode
              }
            }
            if (exitInputLoop) break; // exit while loop if a command set this
            continue; // stay in input mode after slash command
          }

          // ── Q&A chat — requires at least one LLM provider ──
          if (!anyProviderAvailable()) {
            const reply = noProviderReply(input.text);
            for (const line of reply.lines) {
              chatLines.push(line.tone === 'warning' ? C.warning(line.text) : C.muted(line.text));
            }
            inputPrefixState.set(reply.prefill);
            nextInitial = inputPrefixState.consumeInitialText('plain');
            continue; // stay in input mode
          }

          // ── Phase 6: tokenize paths → register attachments → prune stale ──
          const tok = tokenizeInput(input.text, contextRegistry);
          pruneUnreferenced(contextRegistry, tok.text);

          // Phase 10: surface paths that looked attachable but failed to
          // resolve, so a typo doesn't silently ride into the prompt.
          for (const w of tok.warnings) {
            const reason = w.reason === 'not-a-file' ? 'not a regular file' : 'not found';
            chatLines.push(C.warning(`  ⚠ ${w.raw} — ${reason}`));
          }

          // Phase 9: budget warning so the user notices when their context
          // is getting big enough to meaningfully inflate every subsequent
          // request. Fires only once per submit, not on every turn.
          const ctxBytes = ctxTotalBytes(contextRegistry);
          if (ctxBytes > CTX_WARN_BYTES) {
            chatLines.push(C.warning(
              `  ⚠ context ${fmtBytes(ctxBytes)} — /context clear big drops attachments over 100KB`
            ));
          }

          // Build rich context — full dashboard state (system prompt addendum)
          // Strip ANSI from recent status lines for context
          const recentStatus = chatLines.slice(-30).map(l => stripAnsi(l)).filter(Boolean);
          // Only pass sync-specific state (selections, last-selection, DSL)
          // when the sync plugin is actually active. Otherwise the LLM
          // is instructed as a sync helper even for unrelated questions.
          const activeModeName = pluginHost.active()?.name ?? 'browse';
          const inSyncMode = activeModeName === 'sync' || activeModeName === 'syncing';
          const ctx = buildContext({
            mode: activeModeName,
            syncMode: inSyncMode ? SYNC_MODES[sync.modeIdx]?.label : undefined,
            selectedSkills: inSyncMode && sync.selected[0]!.size ? [...sync.selected[0]!] : undefined,
            selectedServers: inSyncMode && sync.selected[1]!.size ? [...sync.selected[1]!] : undefined,
            selectedServices: inSyncMode && sync.selected[2]!.size ? [...sync.selected[2]!] : undefined,
            recentStatus: recentStatus.length > 1 ? recentStatus : undefined,
            lastSelection: inSyncMode ? loadLastSelection() : null,
            includeSyncDSL: inSyncMode,
          });

          // Auto-injection of workspace snapshot + dashboard-state hint
          // was removed 2026-04-18 (see 내부 문서 `PLAN-remove-auto-context-injection`).
          // Every-turn injection distorted normal chat — e.g. reading a
          // HANDOFF doc caused the LLM to dump the body into wd-scratch
          // instead of preparing for implementation. Context is now
          // supplied on-demand: context.* pull tools for state,
          // prompt-hint-store for per-scenario injection.

          // Echo user input + attachment summary BEFORE any async work.
          // Paint immediately so the user sees their message the instant
          // they hit Enter — matches Claude Code's submit-then-render
          // pattern. Without this draw(), the echo sits in the chatLines
          // array but doesn't paint until after the skill router's
          // classifier LLM call returns (~1-2s of visual silence).
          echoSubmittedUserText(tok.text);
          if (queuedTurnEndText !== undefined && input.text === queuedTurnEndText) {
            debug.log('dashboard.turn-typeahead', 'echoed', { path: 'turn-end', length: queuedTurnEndText.length });
          }
          renderAttachmentSummary(tok.added);
          draw();

          // Start the animated thinking indicator BEFORE the router so
          // the user sees continuous feedback while the classifier
          // runs. The same handle is reused through the chat flow —
          // just .update()'d as phases progress (Routing → Thinking →
          // Streaming). Stopped when we hand off to a skill; re-armed
          // if autoroute is cancelled and we fall through to chat.
          const turnStartedAt = Date.now();
          // Pinned footer indicator — writes to chatFooterLine ref,
          // renderLogPane paints it as the last row. Streamed content
          // scrolls up past it; on stop() we commit the final marker
          // as a chatLines entry (history) and null out the ref so the
          // log pane reclaims its full height.
          let thinking: ThinkingHandle = startPinnedThinking({
            target: chatFooterLine,
            onFrame: () => { pinChatTail(); draw(); },
            message: 'Routing',
            metrics: { startedAt: turnStartedAt, hint: 'esc 중단' },
          });

          // ── Development-request routing observation (pre-LLM, no hand-off) ──
          // Measure conservative detector behavior before any routing transition.
          // This decision is intentionally discarded: the existing message path remains intact.
          observeDashboardDevRequestRoute(tok.text, getUserConfig().skills.devRequestRouting);

          // ── URL→skill auto-route (PLAN-url-triage-routing P3) ──
          // Deterministic pre-LLM seam: a pasted URL with no guard keyword
          // fires the mapped digest/absorb skill (two-stage quick→detailed)
          // — mirrors the telegram path (the two main interactive channels).
          // The TUI keeps the Esc-cancellable countdown as the coding-surface
          // safety valve. detectUrlRoute returns null when disabled / no URL /
          // guard keyword present (code-reference etc.), so we fall straight
          // through to keyword routing in those cases.
          {
            const urlDec = detectUrlRoute(tok.text, getUserConfig().skills.urlRouting);
            if (urlDec) {
              debug.log('skill.router', 'url-route', {
                kind: urlDec.kind, skill: urlDec.skill, absorb: urlDec.absorb,
                twoStage: urlDec.twoStage, url: urlDec.url,
              });
              thinking.stop({ status: 'completed', finalText: C.muted(`  → ${urlDec.skill} (${urlDec.kind}${urlDec.absorb ? ' · absorb' : ''})`) });
              if (chatFooterLine.current) chatLines.push(chatFooterLine.current);
              chatFooterLine.current = null;
              chatLines.push('');
              draw();
              const proceed = await runDashboardAutoRouteCountdown(urlDec.skill, getUserConfig().skillRouter.autoRouteCountdownMs, {
                chatLines, pushDebugLine, draw, onEscAbort,
              });
              if (proceed) {
                for (const stage of urlStagePlan(urlDec)) {
                  await runSkillByName(urlDec.skill, stage.args);
                }
                continue; // skill(s) handled the turn — skip normal chat flow
              }
              // Cancelled — re-arm the indicator and fall through to chat.
              thinking = startPinnedThinking({
                target: chatFooterLine,
                onFrame: () => { pinChatTail(); draw(); },
                message: 'Thinking',
                metrics: { startedAt: Date.now(), hint: 'esc 중단' },
              });
            }
          }

          // Phase 2 skill router — keyword router always runs; optional
          // LLM classifier disambiguates when llmFallback is enabled;
          // optional auto-route fires when autoRoute is enabled AND the
          // skill opted in via autoTrigger in its frontmatter.
          {
            const userCfg = getUserConfig().skillRouter;
            // Apply the user's allow/deny list (session 21) so routing
            // only considers skills the user has scoped into this
            // project. The raw index cache stays shared across callers —
            // this filter is applied on read.
            const skillsCfg = getUserConfig().skills;
            const visibleIndex = applySkillFilter(getSkillIndex(), {
              allow: skillsCfg.allow, deny: skillsCfg.deny,
            });
            let detection: DetectResult = { candidates: [], top: null, unambiguous: false };
            try {
              // Tier-aware full-menu routing (2026-07-20): pass the active
              // model tier so a T1 frontier model can route the whole skill
              // menu when keyword matching is weak/empty (Korean prompts).
              const detectTier = getModelTier(getUserConfig().llm.provider, getUserConfig().llm.model);
              const routeStartedAt = Date.now();
              const route = await runAbortableDashboardSkillRoute({
                attachKeys: attachChatStreamingKeys,
                detect: (signal) => detectDashboardSkillRoute(tok.text, visibleIndex, {
                  llmFallback: userCfg.llmFallback,
                  keywordScoreThreshold: userCfg.keywordScoreThreshold,
                  llmConfidenceThreshold: userCfg.llmConfidenceThreshold,
                  streamLLM,
                  signal,
                  ...(detectTier ? { activeTier: detectTier } : {}),
                  ...(userCfg.fullMenuTier ? { fullMenuTier: userCfg.fullMenuTier } : {}),
                  ...(userCfg.fullMenuConfidenceThreshold != null ? { fullMenuConfidenceThreshold: userCfg.fullMenuConfidenceThreshold } : {}),
                }),
              });
              if (route.aborted) {
                debug.log('skill.router', 'route-aborted-by-esc', { elapsedMs: Date.now() - routeStartedAt });
                thinking.stop({ status: 'interrupted' });
                draw();
                continue;
              }
              detection = route.detection;
              // Observability (2026-07-20) — the routing DECISION had no
              // debug category (only surfaced as a UI hint). Emit it so
              // `elanous logs --category skill.router` shows trigger/triage
              // decisions per active model (제1원칙: 계측 없으면 조회 불가).
              debug.log('skill.router', 'decision', {
                text: tok.text.slice(0, 80),
                tier: detectTier,
                llmFallback: userCfg.llmFallback,
                top: detection.top?.name ?? null,
                score: detection.top?.score ?? 0,
                candidates: detection.candidates.length,
                unambiguous: detection.unambiguous,
              });
            } catch (err) {
              debug.log('skill.router', 'decision-error', { text: tok.text.slice(0, 80), error: (err as any)?.message ?? String(err) }, { level: 'error' });
              /* router must never block chat */
            }

            // Session 21 — session-scoped decline short-circuit. If the
            // user already dismissed this skill once this session, don't
            // display the hint, don't run countdown, don't offer Tab.
            // Everything below becomes a no-op; normal chat flow runs.
            const declinedTop = !!detection.top && declinedSkills.has(detection.top.name);
            if (detection.top && !declinedTop) {
              const hint = formatDashboardSkillHint(detection);
              if (hint) pushDebugLine(C.muted(hint));
            }

            // Phase 2 auto-route: suppress the normal LLM chat flow and
            // fire /run-skill directly when the config + skill metadata
            // agree. Esc during countdown cancels.
            // Session 21 — derive active-model tier from the live LLM
            // config and pass it into the gate so T1-only skills don't
            // silently fire on a weaker local model.
            const activeLLM = getUserConfig().llm;
            const activeTier = getModelTier(activeLLM.provider, activeLLM.model);
            const routeDecision = resolveDashboardSkillRouteDecision(detection, {
              autoRouteEnabled: userCfg.autoRoute,
              autoRouteMinScore: userCfg.autoRouteMinScore,
              requireAutoTrigger: userCfg.autoRouteRequireAutoTrigger,
              activeTier,
              declinedTop,
            });
            if (routeDecision.kind === 'auto') {
              const target = routeDecision.target;
              // Stop the routing indicator — the skill runner owns the
              // UI from here (or the user aborts during countdown).
              // Commit the marker into chatLines history before clearing
              // the footer so the log keeps a record that routing fired.
              thinking.stop({ status: 'completed', finalText: C.muted(`  \u2192 /run-skill ${target}`) });
              if (chatFooterLine.current) chatLines.push(chatFooterLine.current);
              chatFooterLine.current = null;
              chatLines.push('');
              draw();
              const proceed = await runDashboardAutoRouteCountdown(target, userCfg.autoRouteCountdownMs, {
                chatLines,
                pushDebugLine,
                draw,
                onEscAbort,
              });
              if (!proceed) {
                declinedSkills.add(target);
                chatLines.push(C.muted(`  auto-route cancelled — falling through to chat (skill muted this session)`));
                chatScrollOffset = -1;
                // Re-arm the indicator — the cancelled one was already
                // frozen with `.stop()`, so we need a fresh handle for
                // the chat flow below.
                thinking = startPinnedThinking({
                  target: chatFooterLine,
                  onFrame: () => { pinChatTail(); draw(); },
                  message: 'Thinking',
                  metrics: { startedAt: Date.now(), hint: 'esc 중단' },
                });
              } else {
                await runSkillByName(target, tok.text);
                continue; // skip the normal chat flow — the skill handled it
              }
            } else if (routeDecision.kind === 'confirm') {
              const target = routeDecision.target;
              const confirmed = await runDashboardTabConfirmRoute(target, userCfg.autoRouteCountdownMs, {
                chatLines,
                pushDebugLine,
                draw,
              });
              if (confirmed) {
                thinking.stop({ status: 'completed', finalText: C.muted(`  \u2192 /run-skill ${target}`) });
                if (chatFooterLine.current) chatLines.push(chatFooterLine.current);
                chatFooterLine.current = null;
                await runSkillByName(target, tok.text);
                continue;
              } else {
                // Timeout or unrelated key — user didn't take the bait.
                // Mute future hints for this skill so we don't pester.
                declinedSkills.add(target);
              }
            }
          }

          // Router done — transition the already-running indicator from
          // 'Routing' to 'Thinking'. When autoroute was cancelled and
          // we re-armed above, `thinking` already points to the fresh
          // handle already showing 'Thinking'.
          thinking.update('Thinking');

          let latestTurnUsage: import('../prompt-cache/types.js').LLMUsage | undefined;
          const runPlainSubmitTurn = (submit: PlainTurnSubmit) => runDashboardChatMainPlainTurn({
            // ⛔⭐ 관측 심을 «실제로» 넘긴다 — 타입만 선택적으로 넓히면 조용히 안 온다(`F12`).
            debugLog: (category, event, payload) => { try { debug.log(category, event, payload); } catch { /* fail-soft */ } },
            userText: tok.text,
            intent: submit.intent,
            contextText: ctx,
            turnStartedAt,
            thinking,
            benchmarkMode: opts.benchmark === true,
            attachedSessionId,
            chat,
            chatLines,
            contextRegistry,
            loadAttachments: (reg) => loadAllAttachments(reg as Parameters<typeof loadAllAttachments>[0]),
            sessionRegistry,
            sync,
            chatFooterLine,
            routeFooter: () => {
              const decision = currentRouteDecision('dashboard');
              return decision ? C.muted(`— route ${formatRouteDecisionSummary(decision)}`) : null;
            },
            acpTurnRef,
            blockAttach,
            pushChatLine: (line) => { chatLines.push(line); },
            pushDebugLine,
            setChatScrollBottom: () => { chatScrollOffset = -1; },
            draw,
            pinChatTail,
            termCols: () => termSize().cols,
            getSessionCwd,
            getUserConfig,
            inspectActiveProvider,
            getActivePluginName: () => pluginHost.active()?.name,
            buildTurnPromptRuntime: (userText, turnId, inputSource) => buildDashboardTurnPromptRuntime(
              userText,
              turnId,
              {
                promptBankConfig: getUserConfig().dashboard.promptBank,
                chatModeState,
                buildPromptRuntimeState: promptRuntimeState,
                getPromptBankStore,
                inspectActiveProvider,
                getActivePluginName: () => pluginHost.active()?.name,
              },
              inputSource,
            ),
            buildTurnMessage: (args) => buildDashboardTurnMessage({
              userText: args.userText,
              promptBankContext: args.promptBankContext,
              contextText: args.contextText,
              contextRegistry: args.contextRegistry as typeof contextRegistry,
              terminalRegistry: args.terminalRegistry as typeof sessionRegistry,
              blockAttach: args.blockAttach,
              pushChatLine: args.pushChatLine,
            }),
            beginCodeEditTurn: async (userContent) => {
              await beginDashboardCodeEditTurn(userContent, {
                importCodeEdit: () => import('../code-edit/index.js'),
              });
            },
            buildTurnPreamble: (args) => {
              // Wave 5 (2026-05-04) — plain-chat path enabledTools
              // propagation. Wave 4 wired the ACP path (line ~15107)
              // by inlining buildSessionRuntimeToolSpecs inside the
              // getPreamble callback. plain-chat goes through this
              // callback (deps.buildTurnPreamble at chat-main-plain-
              // turn-runtime.ts:180) instead — same closure scope, so
              // we mirror the same tool resolution + enabledTools
              // pass-through here.
              const runtime = acpToolRuntime;
              const tools = runtime
                ? buildSessionRuntimeToolSpecs({
                    userText: args.userText,
                    hostTools: pluginHost.hostLLMTools(),
                    runtimeTools: runtime.listToolRuntimes('tui'),
                    pluginTools: pluginHost.activePluginLLMTools(),
                    optionalTools: acpTurnRef.optionalSpecs,
                    surface: acpTurnRef.turnProfile?.surface,
                    rich: false,
                  })
                : [];
              return [
                ...tuiChatPersonaMessages(currentChatPersonaSessionId(), chatPersonaSelection),
                ...buildDashboardTurnPreamble({
                  userText: args.userText,
                  cwd: args.cwd,
                  turnProfile: args.turnProfile as SessionTurnProfile,
                  userConfig: args.userConfig,
                  rich: false,
                  enabledTools: tools.map(t => t.name),
                }),
              ];
            },
            runAutoCompact: async ({ preamble, chatHistory, userMsg }) => {
              const compactMod = await import('../compact/index.js');
              const { shouldAutoCompact, compactConversationPartial, compactConversation, runCompactPipeline, setVerifyProbeEnabled } = compactMod;
              const { renderCompactBoundary } = await import('../chat/compact-boundary.js');
              const userConfig = getUserConfig();
              // PR2 §5.2 — schedule archive retention once per process
              // (idempotent guard inside the helper). Both knobs `0`
              // ⇒ no-op so users with archiveEnabled:false are unaffected.
              if (userConfig.chat.compact.archiveEnabled) {
                scheduleArchiveRetentionOnce({
                  maxAgeDays: userConfig.chat.compact.archiveRetentionDays,
                  maxTotalMb: userConfig.chat.compact.archiveRetentionMb,
                });
              }
              await runDashboardAutoCompact({
                preamble: preamble as LLMMessage[],
                chatHistory: chatHistory as ChatMessage[],
                userMsg: userMsg as ChatMessage,
                model: inspectActiveProvider().model,
                autoCompactConfig: userConfig.chat.autoCompact,
                shouldAutoCompact,
                compactConversation: async (history) => compactConversation(history),
                compactConversationPartial: async (history, opts) => compactConversationPartial(history, opts),
                renderCompactBoundary,
                pushChatLine,
                pushDebugLine,
                muted: C.muted,
                debugLog: (event, action, data) => { debug.log(event, action, data); },
                chatCompactConfig: userConfig.chat.compact,
                runCompactPipeline: async (messages, opts) =>
                  runCompactPipeline(messages, {
                    sessionId: opts.sessionId,
                    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
                    ...(opts.activeModelId !== undefined ? { activeModelId: opts.activeModelId } : {}),
                    policy: { archiveEnabled: userConfig.chat.compact.archiveEnabled },
                  }),
                getCompactProvider: () => getDefaultCompactProvider(),
                setVerifyProbeEnabled,
                sessionId: attachedSessionId ?? undefined,
              });
            },
            attachChatStreamingKeys,
            createOptionalSpecs: async () => {
              const uc = (await import('../user-config.js')).getUserConfig();
              const toolRuntime = await import('../tool-runtime/index.js');
              return buildDashboardOptionalToolSpecs({
                userConfig: uc,
                termSize,
                registerAllDefaultToolRuntimes: () => { toolRuntime.registerAllDefaultToolRuntimes(); },
                setTerminalModalRuntimeDeps: (deps) => { toolRuntime.setTerminalModalRuntimeDeps(deps); },
                ...buildDefaultDashboardToolBuilders(),
              }) as unknown[];
            },
            createTurnStreamRuntime: (initialAssistantStart) => {
              latestTurnUsage = undefined;
              createDashboardTurnStreamRuntimeEscBoundary(escAbortToolState);
              escHarnessSpacesByCallId.clear();
              liveTypeaheadEchoes.length = 0;
              const toolRendering = {
                ...getUserConfig().chat.rendering.tool,
                expandHint: false,
              };
              const renderedToolRuntime = createDashboardRenderedToolRuntime({
                chatLines,
                foldStack,
                pinChatTail,
                draw,
                // Wave P1 (A2-1) — cap the expanded fold variant so a
                // 1MB Read or a 1000-line Bash output doesn't blow up
                // chat. 200 rows is large enough that ordinary
                // 50-200 line tool results are unaffected.
                maxExpandedRows: 200,
                termCols: () => termSize().cols,
              });
              const turnStreamRuntime = createDashboardTurnStreamRuntime({
                initialAssistantStart,
                chatLines,
                thinking,
                draw,
                withPassiveRenderFocus: (render) => display.focusManagerAPI().withPassiveRenderFocus(render),
                pinChatTail,
                termCols: () => termSize().cols,
                wrapOpts: getUserConfig().chat.rendering.wrap,
                formatResponse,
                text: (line) => C.text(line),
                muted: C.muted,
                ptyCallLine: formatPtyCallLine,
                ptyResultLine: formatPtyResultLine,
                renderToolCallEvent,
                renderToolResultVariants,
                toolRendering,
                foldMode: logFoldMode,
                renderedToolRuntime,
                brainIcon: ICONS.brain,
              });
              return {
                ...turnStreamRuntime,
                onText: (chunk, accumulated) => {
                  turnStreamRuntime.onText(chunk, accumulated);
                  restoreLiveTypeaheadEchoes();
                  draw();
                },
                onToolCall: (call) => {
                  const toolCall = call as DashboardTurnStreamCall;
                  trackEscAbortToolCall(escAbortToolState, toolCall);
                  turnStreamRuntime.onToolCall(toolCall);
                },
                onToolResult: (call) => {
                  const toolCall = call as DashboardTurnStreamCall;
                  turnStreamRuntime.onToolResult(toolCall);
                  settleEscAbortToolCall(escAbortToolState, toolCall);
                  escHarnessSpacesByCallId.delete(toolCall.id);
                },
              };
            },
            runTurnUsageRuntime: (usage) => {
              latestTurnUsage = usage as import('../prompt-cache/types.js').LLMUsage;
              runDashboardTurnUsageRuntime({
                // The plain-turn pipeline threads usage as `unknown` for
                // decoupling; at this consumer it is the concrete LLM usage
                // payload the ACP session emitted.
                usage: latestTurnUsage,
                importPromptCache: () => import('../prompt-cache/index.js'),
                pushDebugLine,
                muted: C.muted,
                draw,
              });
            },
            runTurnPrelude: (userText) => runDashboardTurnPrelude({
              userText,
              startUndoTurn: (label) => {
                const { startTurn } = require('../undo-turn/index.js') as typeof import('../undo-turn/index.js');
                startTurn(label);
              },
            }),
            armAcpTurnRef: ({ abortCtrl, userText, turnProfile, searchPlannerState, optionalSpecs }) => {
              armDashboardAcpTurnRef(acpTurnRef, {
                abortCtrl,
                userText,
                turnProfile: turnProfile as SessionTurnProfile,
                searchPlannerState,
                optionalSpecs: optionalSpecs as LLMToolSpec[],
              });
            },
            resetAcpTurnRef: () => resetDashboardAcpTurnRef(acpTurnRef),
            acpSession: dashboardAcpSession,
            control: {
              signalBus: dashboardControlSignals,
            },
            autoTts: {
              pushChunk: (chunk) => dashboardAutoTts.hooks.pushChunk(chunk),
              commit: () => dashboardAutoTts.hooks.commit(),
              cancel: () => dashboardAutoTts.hooks.cancel(),
            },
            voiceChat: {
              getPhase: () => dashboardVoiceChat.controller.getPhase(),
              transitionToSpeaking: () => { dashboardVoiceChat.controller.transition('speaking'); },
              notifyResponseDone: () => dashboardVoiceChat.notifyResponseDone(),
            },
            finalizeStreamLifecycle: (cleanupEsc, aborted, currentStatus) =>
              finalizeDashboardStreamLifecycle(cleanupEsc, aborted, currentStatus),
            recordTurnMetrics: async (fullResponse) => {
              await recordDashboardTurnMetrics({
                chatHistory: chat.history as ChatMessage[],
                model: inspectActiveProvider().model,
                fullResponse,
                turnStartedAt,
                usage: latestTurnUsage,
                importStatusMetrics: () => import('../status/metrics.js'),
              });
            },
            commitAssistantRenderState: (fullResponse, assistantStart, nextLine) =>
              commitDashboardAssistantRenderState(fullResponse, assistantStart, nextLine),
            applyAssistantRenderState: (state) => {
              ({ lastAssistantRaw, lastAssistantRange, lastAssistantMode } = state);
            },
            runTailAutoCopy: async (userText, fullResponse) => {
              await runDashboardTurnTailAutoCopy({
                enabled: opts.benchmark === true || getUserConfig().chat.autoCopyQaToClipboard,
                userText,
                fullResponse,
                autoCopyTurnQaToClipboard,
                onWarning: (message) => {
                  chatLines.push(C.warning(message));
                  chatScrollOffset = -1;
                },
              });
            },
            runCodeEditPostTurn: async () => {
              await runDashboardCodeEditPostTurn({
                pushChatLine: (line) => { chatLines.push(line); },
                setChatScrollBottom: () => { chatScrollOffset = -1; },
                importCodeEdit: () => import('../code-edit/index.js'),
                importUndoTurn: () => import('../undo-turn/index.js'),
              });
            },
            runHandoffMirror: async (userContent, assistantContent) => {
              const { appendMessage } = await import('../session/index.js');
              runDashboardHandoffMirror({
                attachedSessionId,
                userContent,
                assistantContent,
                appendMessage,
                onWarning: (message) => { chatLines.push(C.warning(message)); },
              });
            },
            parseActionBlock: (fullResponse) => parseDashboardActionBlock(fullResponse),
            isBrowseMode: () => isBrowseMode(pluginHost),
            enterSyncMode,
            applyActionBlock: (action, syncState) => applyDashboardActionBlock(action as any, syncState as typeof sync),
            runActionEffects: async (outcome) => {
              await runDashboardActionBlockEffects({
                outcome: outcome as any,
                info: C.info,
                highlight: C.highlight,
                brainIcon: ICONS.brain,
                syncIcon: ICONS.sync,
                diffIcon: ICONS.diff,
                pushChatLine: (line) => { chatLines.push(line); },
                setChatScrollBottom: () => { chatScrollOffset = -1; },
                draw,
                runSyncInline,
                runDiffInline,
              });
            },
            warningLine: (message) => C.warning(`${ICONS.warning} ${message}`),
            pushErrorLine: (message) => { chatLines.push(C.error(`Error: ${message}`)); },
            finalizeTurn: (finalStatus, finalError) => {
              lastTurnFinalStatus = finalStatus;
              clearEscAbortToolState(escAbortToolState);
              finalizeDashboardTurn({
                thinking,
                finalStatus,
                finalError,
                chatFooterLine,
                pushChatLine: (line) => { chatLines.push(line); },
                setChatScrollBottom: () => { chatScrollOffset = -1; },
                consumeQuickControl: () => consumeSessionQuickControl(chatModeState),
                muted: C.muted,
                draw,
              });
            },
          });

          // Goal-loop FU-1 (2026-05-05) — wrap submit-intent in a
          // do-while so an active /goal can drive auto-continuation
          // after each LLM turn. First iteration uses tok.text (the
          // user's actual input); subsequent iterations use the
          // continuation prompt synthesized by the bridge from the
          // last assistant turn + judge verdict.
          //
          // Preempt model: Esc-during-streaming aborts the LLM call
          // (existing chat-streaming-keys gate). The bridge sees the
          // abort flag and returns 'stop paused', breaking this loop.
          // A paused goal re-enters only for an explicit correction/resume
          // message. Unrelated requests remain ordinary chat turns, while a
          // correction cannot silently leave the interrupted goal abandoned.
          const { resumeGoalFromUserFollowUp } = await import('../goals/chat-loop-bridge.js');
          const { hydrateGoalFromSnapshot } = await import('../goals/registry.js');
          hydrateGoalFromSnapshot();
          const followUpAction = tok.text.startsWith('/goal')
            ? { kind: 'no-loop' as const }
            : resumeGoalFromUserFollowUp(tok.text);
          let goalLoopUserText: string | null = followUpAction.kind === 'continue'
            ? followUpAction.nextUserText
            : null; // null = use tok.text (first turn)
          if (followUpAction.kind === 'continue') {
            for (const line of followUpAction.headerLines) chatLines.push(C.muted(line));
          }
          let goalLoopBudget = 100; // hard safety cap independent of /goal budget
          let lastTurnAborted = false;
          do {
            const turnText = goalLoopUserText ?? tok.text;
            await runDashboardChatMainSubmitIntent({
              submit: createDashboardChatMainTurnSubmit(
                submitIntent.kind === 'submit-turn' && submitIntent.route === 'plain' && goalLoopUserText === null
                ? submitIntent
                : {
                  kind: 'submit-turn',
                  source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
                  text: turnText,
                  route: goalLoopUserText === null ? 'plain' : 'plain',
                },
              ),
              beforeExecute: (submit) => {
                maybeEmitDashboardSubmitQuickPass({
                  submit,
                  isOutputSpeaking: dashboardAutoTts.controller.isSpeaking(),
                  signalBus: dashboardControlSignals,
                });
              },
              runStickyAcpDispatch: async () => {},
              runPlainTurn: runPlainSubmitTurn,
            });

            // Goal-loop hook: judge → action. no-op when no /goal active.
            const { runGoalLoopHook } = await import('../goals/chat-loop-bridge.js');
            const goalAction = await runGoalLoopHook({
              history: chat.history,
              wasAborted: lastTurnAborted,
            });
            if (goalAction.kind === 'no-loop') {
              goalLoopUserText = null;
              break;
            }
            if (goalAction.kind === 'stop') {
              for (const line of goalAction.toastLines) {
                chatLines.push(C.muted(line));
              }
              chatScrollOffset = -1;
              draw();
              goalLoopUserText = null;
              break;
            }
            // 'continue' — push header lines + loop with continuation
            for (const line of goalAction.headerLines) {
              chatLines.push(C.muted(line));
            }
            chatScrollOffset = -1;
            draw();
            goalLoopUserText = goalAction.nextUserText;
            goalLoopBudget -= 1;
            if (goalLoopBudget <= 0) {
              chatLines.push(C.warning(
                '  ⚠ Goal-loop hard safety cap reached (100 iterations). Forcing pause.',
              ));
              // Defensive — should never trigger before /goal budget kicks
              // in, but a wrong-config infinite loop is worse than a stop.
              const { setStatus: _setStatus } = await import('../goals/index.js');
              _setStatus('paused', 'hard-safety-cap');
              break;
            }
          } while (goalLoopUserText !== null);

          continue; // stay in input mode after chat
          } // end while (input mode loop)
          // Disarm the prompt-repaint hook: textInput's drawAll
          // closure is gone now, calling it would paint a stale frame.
          cleanupDashboardInputLoopExit({
            clearPromptRepaint: () => { promptCtl.repaint = () => {}; },
            // Arc C · v2 — also detach the insertAtCursor hook so stale
            // modal callbacks (e.g. a folder-picker accept resolving
            // after textInput exited) can't splice into a gone buffer.
            detachInsertAtCursor: () => { promptCtl.insertAtCursor = undefined; },
            // 2026-04-30 — same rationale for the auto-submit hook:
            // a stale `submit` would inject Enter into a torn-down
            // textInput closure.
            detachSubmit: () => { promptCtl.submit = undefined; },
            // P0-3 — clear the coordinator's cursor state when input
            // exits. Without this, flushCursor keeps painting the cursor
            // at textInput's last caret position (typically the right
            // edge of the last input line), producing the ghost cursor
            // the user sees blinking in the "input mode" area even when
            // no input is active.
            clearDisplayCursor: () => { display.setCursor(null); },
            // Mark this iteration as just-exited from input so the
            // post-loop transition can restore the prior working-dir
            // pane. Distinct from `wdAutoInput` because user-initiated
            // `/` from a pane also needs the restore.
            markInputExited: () => { wdInputExited = true; },
          });
      }

      // ── Phase 4a-v3: input exited → restore prior pane ──
      // Whenever a working-dir input session ends with the user back
      // outside the prompt (Escape on empty buffer, Ctrl+M chord,
      // gotoPane signal), drop them on the pane they came from. Falls
      // back to the first pane of the current view if no last-pane
      // memory exists yet (e.g. an auto-input was the very first
      // event of the session).
      if (debug.isKeyTraceEnabled()) {
        debug.log('dashboard.input.restore', 'evaluate', {
          inputOwner: chatMainVisibility.inputOwnership?.owner ?? 'none',
          pluginActive: chatMainVisibility.pluginActive,
          autoInputArmed: wdAutoInput,
          inputExited: wdInputExited,
          lastWorkingDirPane: focusTransitionState.getLastWorkingDirPane(),
          fallbackPane: firstPaneOfView(workingDir.view),
          workingFocus: workingDir.focus,
        });
      }
      const restoredInputExit = restoreDashboardInputExit({
        inputOwner: chatMainVisibility.inputOwnership?.owner ?? 'none',
        pluginActive: chatMainVisibility.pluginActive,
        autoInputArmed: wdAutoInput,
        inputExited: wdInputExited,
        lastWorkingDirPane: focusTransitionState.getLastWorkingDirPane(),
        fallbackPane: firstPaneOfView(workingDir.view),
        applyTransition: (nextFocus, reason) => {
          setWorkingFocus(nextFocus, reason);
        },
        clearLastWorkingDirPane: () => {
          focusTransitionState.setLastWorkingDirPane(null);
        },
      });
      if (debug.isKeyTraceEnabled()) {
        debug.log('dashboard.input.restore', restoredInputExit ? 'applied' : 'skipped', {
          inputOwner: chatMainVisibility.inputOwnership?.owner ?? 'none',
          pluginActive: chatMainVisibility.pluginActive,
          autoInputArmed: wdAutoInput,
          inputExited: wdInputExited,
          lastWorkingDirPane: focusTransitionState.getLastWorkingDirPane(),
          fallbackPane: firstPaneOfView(workingDir.view),
          workingFocus: workingDir.focus,
        });
      }
    }
  } catch (err) {
    closeDashboardTui();
    throw err;
  } finally {
    setSelfImplementSoftStopSpaceObserver(null);
    if (tuiSeatAskTimer) clearInterval(tuiSeatAskTimer);
  }
}
