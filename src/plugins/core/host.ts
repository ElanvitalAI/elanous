// ── Plugin host — discovery, lifecycle, slash contribution ──
// Loads plugins from `<repo>/plugins/<name>/plugin.ts` (built-in) and
// `~/.claude/plugins/<name>/plugin.ts` (user). User-scope plugins with
// the same name as a built-in override the built-in (with a warning).
//
// `~/.claude/plugins` overlaps Claude's own package-management directory
// (cache/, data/, marketplaces/, installed_plugins.json, …). PluginHost
// only searches that directory's immediate children for the Elanous
// `<name>/plugin.ts` convention and currently finds no Claude-managed
// packages there. Claude package metadata is read by
// `src/plugins/adapters/claude-package.ts` (`readClaudePackageLedger`);
// this host does not invent a second reader.
//
// Phase 2 scope: discover + activate/deactivate + contributed slash
// commands. Full key-routing and LLM tool dispatch land in Phase 4.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { listInstalledPlugins } from '../install/plugin-install.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { homedir } from 'os';
import type {
  ElanousPlugin, PluginContext, SlashCommand, PaneSlot, KeyEvent, Action, LLMToolDef,
  DashboardPaneState,
  PluginLayoutCtx,
} from './types.js';
import type { PaneFocus } from '../../workspace-types.js';
import type { DisplayDisposable, DisplayHandle } from '../../display/types.js';
import type { DisplayEventBus } from '../../display/events.js';
import type { FocusManager } from '../../primitives/focus-manager/index.js';
import type { ExecutionSurfaceHandle, ExecutionSurfaceSpec } from '../../display/index.js';
import type { ExecutionHistoryRecord } from '../../execution-history.js';
import type { ThemeTokenInput, ThemeTokens } from '../../theme/tokens.js';
import type { Layout } from '../../layout/types.js';
import { closeModal, emptyLayout, openModal } from '../../layout/host.js';
import type { WidgetHost } from '../../widgets/host.js';
import { debug } from '../../debug/log.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { CommandRegistry, type CommandDisposable, type RegisteredCommand } from '../../command-registry.js';
import { PluginCapabilityPolicy, assertCapability } from './capability-policy.js';
import { PluginTrustStore } from './trust-store.js';
import { PluginTaskService } from './task-service.js';
import { readClipboardText, writeClipboard } from '../../clipboard/index.js';
import {
  loadPluginManifestFromDir,
  manifestRequiredWidgets,
  type PluginManifest,
  type PluginPromptContribution,
  type PluginSource,
  type PluginViewContribution,
} from './manifest.js';
import { buildPromptInjection, getPromptBankStore } from '../../prompt-bank/index.js';
import { getGlobalElementRegistry, publishElementEvent } from '../../element-registry/index.js';
import { mintPluginUri } from '../../mss/uri/builder.js';
import type { PluginUri } from '../../mss/uri/brand.js';
import { loadPluginNodes } from '../../graph-kinds/plugin-nodes.js';
import { getNodeKindRegistration, listNodeKinds, unregisterPluginNodeKind, type NodeKindEntry } from '../../graph-kinds/registry.js';

/** Clamp a tool handler's return value to something short enough for
 *  the debug log. Preserves the shape for JSON.stringify so small
 *  payloads stay structured. */
function previewResult(r: unknown): unknown {
  if (r == null || typeof r !== 'object') return r;
  try {
    const s = JSON.stringify(r);
    if (s.length <= 600) return r;
    return { _preview: s.slice(0, 600) + '…', _length: s.length };
  } catch {
    return { _opaque: true };
  }
}

export interface PluginEntry {
  plugin: ElanousPlugin;
  manifest: PluginManifest;
  manifestPath: string | null;
  manifestInferred: boolean;
  source: PluginSource;
  path: string;                   // plugin directory
}

export interface ActiveDashboardPaneContribution {
  pluginId: string;
  paneId: PaneFocus;
  widgetInstanceId: string;
  widgetType: string;
  title: string;
  canFocus: boolean;
}

export interface ActiveThemeContribution {
  pluginId: string;
  id: string;
  localId: string;
  label: string;
  path: string;
}

export interface ActivePlugin {
  name: string;
  plugin: ElanousPlugin;
  state: unknown;
  ownedSlots: Set<PaneSlot>;
  /** Layout produced by plugin.buildLayout, if any. Consumed by the
   *  dashboard draw loop — null means "no override". */
  layout: Layout | null;
  /** Widget instance ids spawned inside buildLayout. Disposed on
   *  deactivate so plugin lifecycle leaves no orphans. */
  ownedWidgets: string[];
  /** Display focus/key registrations made through PluginContext. */
  ownedDisplayDisposables: DisplayDisposable[];
  /** Commands registered for this activation. */
  ownedCommandDisposables: CommandDisposable[];
  /** Task registrations for this activation. */
  ownedTaskDisposables: Array<{ dispose(): void }>;
  /** PX-3: hook registrations (from manifest.contributes.hooks[] +
   *  ctx.hooks.register calls). Disposed on deactivate. */
  ownedHookDisposers: Array<() => void>;
  /** PX-4: mission registrations (one per contributes.missions[] entry).
   *  Disposers tear down globalMissionRegistry entries on deactivate. */
  ownedMissionDisposers: Array<() => void>;
  /** PX-5: route registrations (one per contributes.routes[] entry).
   *  Disposers remove routes from globalRouteRegistry on deactivate. */
  ownedRouteDisposers: Array<() => void>;
  /** PX-4: workflow definition registrations (one per
   *  contributes.workflows[] entry). The actual runner is the
   *  singleton globalWorkflowRunner — this list only tracks the
   *  definition registry so the host can forget them on deactivate. */
  ownedWorkflowDisposers: Array<() => void>;
  /** Widget types loaded from this plugin's manifest contributions. */
  ownedWidgetTypes: string[];
  /** Dashboard panes contributed by the plugin manifest. */
  dashboardPanes: ActiveDashboardPaneContribution[];
  /** Dashboard views contributed by the plugin manifest, with pane ids
   *  resolved to their runtime `plugin:<plugin>.<pane>` names. */
  dashboardViews: PluginViewContribution[];
  /** Theme files contributed by the active plugin manifest. */
  themeContributions: ActiveThemeContribution[];
  /** Runtime AI tools after manifest metadata/schema merge. */
  aiTools: LLMToolDef[];
  /** Prompt Bank fragment ids synchronized from manifest prompts. */
  promptFragmentIds: string[];
  /** MSS M1.2: per-activation branded URI. The plugin manifest's slug
   *  `name` stays a plain string at the wire boundary; this URI is
   *  scoped to a single activation cycle so MSS bridges (M3 signal
   *  sender narrow · M4 memory participant) can attribute events to a
   *  specific activation rather than the plugin definition. */
  pluginUri: PluginUri;
}

export interface HostHooks {
  /** Append a line to the log pane. */
  log(line: string): void;
  /** Set / clear a HUD segment. */
  hudSet(key: string, value: string, priority?: number): void;
  /** Request a re-render of one or all panes. */
  requestRender(pane?: PaneSlot): void;
  /** Optional scoped display handle for plugin-originated surface
   *  commands. Kept optional so existing tests and hosts can wire it
   *  incrementally. */
  display?: DisplayHandle;
  displayEvents?: DisplayEventBus;
  /** F-3b (2026-04-21) — direct FocusManager primitive handle. When
   *  provided, `ctx.focus.{set,cycle,current}` plugin APIs bypass the
   *  DisplayHandle wrappers and call the primitive directly. Falls
   *  back to `display` when omitted so existing tests / hosts that
   *  don't wire focusManager keep working. Dashboard passes
   *  `coord.focusManagerAPI()` at plugin-host construction site
   *  (src/dashboard.ts). Part of the F-3 caller-migration arc
   *  (내부 문서 `PLAN-f3-caller-migration` §2.2). */
  focusManager?: FocusManager;
  theme?: () => ThemeTokens;
  themeControl?: {
    getState(): unknown;
    setActive(id: string): unknown;
  };
  /** Optional execution-surface factory. Plugins use this instead of
   *  constructing terminal panes or writing to scratch/log directly. */
  execution?: {
    spawn(spec: ExecutionSurfaceSpec): ExecutionSurfaceHandle | Promise<ExecutionSurfaceHandle>;
  };
  /** Dashboard pane control surface. Optional so non-dashboard tests
   *  and alternate hosts can omit it; plugins feature-detect via
   *  ctx.panes. */
  panes?: {
    state(): DashboardPaneState;
    close(pane: string): boolean;
    open(pane: string): boolean;
    openModal(pane: string): boolean;
    setOmitOrder?(panes: string[]): DashboardPaneState;
  };
  /** Transfer focus (no-op if the slot is not plugin-owned). */
  focusPane(pane: PaneSlot): void;
  /** Run an async slash command from within routeKey. Set by dashboard
   *  when it wires its dispatchSlash stack — falls back to the host's
   *  own plugin-contributed dispatchSlash. */
  runSlash?(command: string, args: string[]): Promise<void> | void;
  /** Synthetic text submit — used by Action<'submit'>. Optional; host
   *  logs a warning if a plugin emits submit without this hook. */
  submitText?(text: string): Promise<void> | void;
}

export interface PluginHostOptions {
  trustStore?: PluginTrustStore;
  /** PX-2 P4: optional plugin-state persistence backend. When omitted,
   *  ctx.persistentState is undefined (older callers see no change). */
  statePersistence?: import('../../plugin-state/persistence.js').PluginStatePersistence;
  /** Optional user plugin directory, primarily for isolated host instances. */
  userDir?: string;
  /** Optional pack directory for isolated discovery tests. */
  packsDir?: string;
}

// Parse a Keybinding.key string ('C-S-p', 'tab', 'escape') into its
// parts. Modifier letters: C=ctrl, S=shift, A=alt.
function parseKey(spec: string): { name: string; ctrl: boolean; shift: boolean; alt: boolean } {
  const parts = spec.split('-');
  const name = parts.pop() ?? '';
  const mods = new Set(parts);
  return { name: name.toLowerCase(), ctrl: mods.has('C'), shift: mods.has('S'), alt: mods.has('A') };
}

export function matchesKey(spec: string, ev: KeyEvent): boolean {
  const p = parseKey(spec);
  if ((ev.name ?? '').toLowerCase() !== p.name) return false;
  if (!!ev.ctrl !== p.ctrl) return false;
  if (!!ev.shift !== p.shift) return false;
  if (!!ev.alt !== p.alt) return false;
  return true;
}

export const BUILTIN_DIR = resolve(import.meta.dir, '..', '..', '..', 'plugins');
export const PACKS_DIR = resolve(import.meta.dir, '..', '..', '..', 'packs');
export const USER_DIR = join(homedir(), '.claude', 'plugins');

/** 코드 없이 스킬·그래프만 싣는 팩인가 — 진입점이 기본값(`./plugin.ts`)이고 파일이 없으며, 스킬·그래프를 선언하거나 `skills/` 폴더가 있다. */
export function isSkillOnlyPack(pluginDir: string, manifest: { main: string; contributes?: { skills?: unknown[]; graphs?: unknown[] } }, hasLegacyEntry: boolean): boolean {
  if (hasLegacyEntry) return false;
  if (manifest.main !== './plugin.ts') return false; // 명시한 진입점이 없으면 그건 결함이다 — 경고를 유지한다.
  const declares = (manifest.contributes?.skills?.length ?? 0) > 0 || (manifest.contributes?.graphs?.length ?? 0) > 0;
  return declares || existsSync(join(pluginDir, 'skills'));
}

export class PluginHost {
  private available = new Map<string, PluginEntry>();
  private discoveredNodeKinds = new Map<string, NodeKindEntry>();
  private activeEntry: ActivePlugin | null = null;
  private hooks: HostHooks;
  /** Optional widget host. When set, plugin-host calls buildLayout on
   *  activation and auto-disposes widgets on deactivate. */
  private widgetHost: WidgetHost | null;
  /** Host-level LLM tools that are always available (e.g. layout
   *  controls). Merged with the active plugin's llmTools in
   *  contributedLLMTools(). */
  private hostTools: LLMToolDef[] = [];
  private commands = new CommandRegistry();
  private capabilityPolicy = new PluginCapabilityPolicy();
  private trustStore: PluginTrustStore;
  private userDir: string;
  private packsDir: string;
  private tasks = new PluginTaskService();
  private themeCache = new Map<string, { mtimeMs: number; tokens: ThemeTokenInput }>();
  /** PX-2 P4: plugin-state persistence backend (optional). */
  private statePersistence: import('../../plugin-state/persistence.js').PluginStatePersistence | null = null;
  /** PX-2 P4: shared in-memory session-state map across every active
   *  plugin this session. Cleared when the host is torn down. Keys
   *  are `<pluginId>:<key>` so plugins stay namespaced. */
  private sessionStateMap: Map<string, { value: unknown; subs: Set<(v: unknown) => void> }> = new Map();
  /** Cached PluginStateApi per pluginId — built on first access,
   *  disposed on deactivate so the next activation gets a fresh
   *  handle (and session entries for the old pluginId are cleared). */
  private pluginStateApi: Map<string, import('../../plugin-state/api.js').PluginStateApi> = new Map();

  constructor(hooks: HostHooks, widgetHost: WidgetHost | null = null, opts: PluginHostOptions = {}) {
    this.hooks = hooks;
    this.widgetHost = widgetHost;
    this.trustStore = opts.trustStore ?? new PluginTrustStore();
    this.userDir = opts.userDir ?? USER_DIR;
    this.packsDir = opts.packsDir ?? PACKS_DIR;
    this.statePersistence = opts.statePersistence ?? null;
    this.registerExecutionHistoryTools();
    this.registerThemeTools();
  }

  /** PX-3 P5: dispatch the StateRestore hook for the plugin we just
   *  activated. Pulls the plugin's persisted '__session__' key from
   *  its own state api (if any) and hands it to registered handlers.
   *  Non-fatal on errors — caller logs a warning. */
  private async dispatchStateRestore(pluginId: string): Promise<void> {
    const { globalHookDispatcher } = await import('../../plugin-hooks/dispatcher.js');
    if (globalHookDispatcher.list('StateRestore').length === 0) return;
    let restoredState: unknown = null;
    if (this.statePersistence) {
      try {
        restoredState = this.statePersistence.read(pluginId, 'session', 'user');
      } catch { /* optional */ }
    }
    await globalHookDispatcher.dispatch('StateRestore', {
      sessionId: 'default',
      pluginId,
      restoredState,
    });
  }

  /** PX-4 P5: register all manifest-declared missions into
   *  globalMissionRegistry. Each registration tracks a disposer on the
   *  active entry so deactivate() tears them down. autostart missions
   *  flip to 'running' inside register() via the registry's own logic. */
  private registerManifestMissions(entry: PluginEntry): void {
    if (!this.activeEntry) return;
    const specs = entry.manifest.contributes.missions ?? [];
    if (specs.length === 0) return;
    const { globalMissionRegistry } = require('../../plugin-missions/registry.js');
    const stateApi = this.buildPersistentStateContext();
    for (const def of specs) {
      try {
        const dispose = globalMissionRegistry.register({
          pluginId: entry.manifest.id,
          pluginDir: entry.path,
          def,
          ...(stateApi ? { stateApi } : {}),
        });
        this.activeEntry.ownedMissionDisposers.push(dispose);
      } catch (err: any) {
        this.hooks.log(`⚠ plugin "${entry.manifest.id}" mission "${def.id}" failed to register: ${err?.message ?? err}`);
      }
    }
  }

  /** PX-5 P2: register all manifest-declared routes into
   *  globalRouteRegistry. Disposers clean up on deactivate. Persists
   *  the compiled snapshot to .elanous/routes.json after each batch so
   *  external tooling (LLM tools, editors) can read it. */
  private registerManifestRoutes(entry: PluginEntry): void {
    if (!this.activeEntry) return;
    const specs = entry.manifest.contributes.routes ?? [];
    if (specs.length === 0) return;
    const { globalRouteRegistry } = require('../../plugin-routes/registry.js');
    const isBuiltin = entry.source === 'builtin';
    for (const def of specs) {
      try {
        const dispose = globalRouteRegistry.register(entry.manifest.id, def, isBuiltin);
        this.activeEntry.ownedRouteDisposers.push(dispose);
      } catch (err: any) {
        this.hooks.log(`⚠ plugin "${entry.manifest.id}" route "${def.id}" failed to register: ${err?.message ?? err}`);
      }
    }
    // Fire-and-forget persist — the snapshot is advisory cache, not
    // authoritative, so a failure here doesn't block activation.
    void globalRouteRegistry.persist();
  }

  /** PX-4 P5: register all manifest-declared workflows into the
   *  in-memory definition registry so WorkflowList/WorkflowRun can
   *  reach them. Actual execution flows through globalWorkflowRunner
   *  (its dispatchers must be wired by the host at bootstrap). */
  private registerManifestWorkflows(entry: PluginEntry): void {
    if (!this.activeEntry) return;
    const specs = entry.manifest.contributes.workflows ?? [];
    if (specs.length === 0) return;
    const { registerWorkflowDefinition } = require('../../plugin-workflows/llm-tools.js');
    for (const def of specs) {
      try {
        const dispose = registerWorkflowDefinition(entry.manifest.id, def);
        this.activeEntry.ownedWorkflowDisposers.push(dispose);
      } catch (err: any) {
        this.hooks.log(`⚠ plugin "${entry.manifest.id}" workflow "${def.id}" failed to register: ${err?.message ?? err}`);
      }
    }
  }

  /** PX-3 P4: register all manifest-declared shell hooks for the
   *  plugin we're activating. Disposers are tracked on the active
   *  entry so deactivate() unregisters them. In-process hooks go
   *  through ctx.hooks.register inside onActivate (see buildContext). */
  private registerManifestHooks(entry: PluginEntry): void {
    if (!this.activeEntry) return;
    const specs = entry.manifest.contributes.hooks ?? [];
    if (specs.length === 0) return;
    // Lazy imports so headless tests that don't exercise hooks never
    // pull in the dispatcher stack.
    const { globalHookDispatcher } = require('../../plugin-hooks/dispatcher.js');
    const { createShellHookHandler } = require('../../plugin-hooks/shell-hook.js');
    for (const spec of specs) {
      const handler = createShellHookHandler({
        id: `${entry.manifest.id}:${spec.id}`,
        event: spec.event as any,
        priority: spec.priority ?? 100,
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        command: spec.command,
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
      });
      try {
        const dispose = globalHookDispatcher.register(handler);
        this.activeEntry.ownedHookDisposers.push(dispose);
      } catch (err: any) {
        this.hooks.log(`⚠ plugin "${entry.manifest.id}" hook "${spec.id}" failed to register: ${err?.message ?? err}`);
      }
    }
  }

  /** PX-2 P4: build (and cache) the PluginStateApi for the active
   *  plugin. Returns undefined when no persistence backend is wired
   *  or no plugin is active — callers feature-detect via optional
   *  chaining on ctx.persistentState. */
  private buildPersistentStateContext(): import('../../plugin-state/api.js').PluginStateApi | undefined {
    const active = this.activeEntry;
    if (!active || !this.statePersistence) return undefined;
    const existing = this.pluginStateApi.get(active.name);
    if (existing) return existing;
    // Lazy import to avoid pulling the plugin-state module into hosts
    // that never use it (keeps boot time minimal for headless tests).
    const { createPluginStateApi } = require('../../plugin-state/api.js');
    const api = createPluginStateApi(active.name, this.statePersistence, this.sessionStateMap);
    this.pluginStateApi.set(active.name, api);
    return api;
  }

  /** PX-2 P4: drop every session-state entry for one plugin +
   *  disposed API handle. Called from deactivate() so a reactivation
   *  of the same plugin gets a fresh session map scope (persistent
   *  state in ~/.elanous/state survives deactivation — that's the point). */
  private clearPluginStateScope(pluginId: string): void {
    this.pluginStateApi.delete(pluginId);
    const prefix = `${pluginId}:`;
    for (const k of Array.from(this.sessionStateMap.keys())) {
      if (k.startsWith(prefix)) this.sessionStateMap.delete(k);
    }
  }

  /** Register a host-level LLM tool (not tied to any plugin). Useful
   *  for dashboard-provided capabilities like layout control that
   *  should always be accessible to the chat model. */
  registerHostTool(tool: LLMToolDef): void {
    this.hostTools.push(tool);
  }

  private registerExecutionHistoryTools(): void {
    this.registerHostTool({
      name: 'execution_list',
      description: 'List recent plugin task executions.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async (args) => this.tasks.executionList(typeof args.limit === 'number' ? args.limit : 20),
    });
    this.registerHostTool({
      name: 'execution_get',
      description: 'Get one execution history record by id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args) => this.tasks.executionGet(String(args.id ?? '')),
    });
    this.registerHostTool({
      name: 'execution_cancel',
      description: 'Cancel an active plugin task execution by id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args) => this.tasks.executionCancel(String(args.id ?? '')),
    });
    this.registerHostTool({
      name: 'execution_rerun',
      description: 'Rerun a plugin task execution by id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: (args) => this.tasks.executionRerun(String(args.id ?? '')),
    });
  }

  private registerThemeTools(): void {
    this.registerHostTool({
      name: 'theme_getState',
      description: 'Return the active semantic dashboard theme state.',
      parameters: { type: 'object', properties: {} },
      handler: async () => this.hooks.themeControl?.getState() ?? {
        active: null,
        tokens: this.hooks.theme?.() ?? null,
        contributions: this.activeThemeContributions(),
      },
    });
    this.registerHostTool({
      name: 'theme_setActive',
      description: 'Set the active dashboard theme id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args) => {
        if (!this.hooks.themeControl) throw new Error('theme control is not available');
        return this.hooks.themeControl.setActive(String(args.id ?? ''));
      },
    });
  }

  /** Attach (or replace) the widget host after construction — lets the
   *  dashboard wire up its own widget registry without making
   *  plugin-host creation depend on it. */
  setWidgetHost(widgetHost: WidgetHost | null): void {
    this.widgetHost = widgetHost;
  }

  /** Scan built-in and user directories, then ledger-listed installations and declared nodes from plugins and packs. */
  async discover(): Promise<void> {
    for (const owner of this.discoveredNodeKinds.values()) {
      if (owner.plugin) unregisterPluginNodeKind(owner.graph, owner.kind, owner.plugin, owner);
    }
    this.discoveredNodeKinds.clear();
    this.available.clear();
    await this.scanDir(BUILTIN_DIR, 'builtin');
    await this.scanDir(this.userDir, 'user');
    try {
      const root = elanousStateRoot();
      const ledgerPath = join(root, 'plugins', 'installed.json');
      if (existsSync(ledgerPath)) {
        const ledger: unknown = JSON.parse(readFileSync(ledgerPath, 'utf8'));
        if (!Array.isArray(ledger) || !ledger.every(row => row && typeof row === 'object'
          && typeof row.name === 'string' && typeof row.version === 'string' && typeof row.market === 'string')) throw new Error('invalid plugin ledger');
        const registered = new Set(ledger.map(row => `${row.market}/${row.name}/${row.version}`));
        for (const installed of listInstalledPlugins(root)) {
          if (!registered.has(`${installed.market}/${installed.name}/${installed.version}`)) continue;
          await this.scanDir(dirname(installed.path), 'installed', basename(installed.path), installed.name);
        }
      }
    } catch {
      this.hooks.log('⚠ plugin installed.json is invalid; skipping installed plugins');
      debug.log('plugin.discovery', 'error', { reason: 'invalid installed plugin ledger' }, { level: 'warn' });
    }
    for (const entry of this.available.values()) {
      this.loadDiscoveredNodes(entry.path, entry.manifest);
    }
    this.scanPackNodes();
    debug.log('plugin.discovery', 'complete', { count: this.available.size });
  }

  private loadDiscoveredNodes(pluginDir: string, manifest: PluginManifest): void {
    const before = new Set(listNodeKinds().map((entry) => `${entry.graph}:${entry.kind}`));
    try {
      const result = loadPluginNodes(pluginDir, manifest);
      for (const error of result.errors) {
        this.hooks.log(`⚠ plugin "${manifest.id}" node skipped: ${error}`);
        debug.log('plugin.discovery', 'error', { plugin: manifest.id, reason: String(error) }, { level: 'error' });
      }
    } catch (err: any) {
      const reason = err?.message || String(err);
      this.hooks.log(`⚠ plugin "${manifest.id}" nodes failed to load: ${reason}`);
      debug.log('plugin.discovery', 'error', { plugin: manifest.id, reason }, { level: 'error' });
    } finally {
      for (const entry of listNodeKinds()) {
        const key = `${entry.graph}:${entry.kind}`;
        if (!before.has(key) && entry.plugin === manifest.id) {
          const registered = getNodeKindRegistration(entry.graph, entry.kind);
          if (registered) this.discoveredNodeKinds.set(key, registered);
        }
      }
    }
  }

  private scanPackNodes(): void {
    if (!existsSync(this.packsDir)) return;
    let names: string[];
    try {
      names = readdirSync(this.packsDir);
    } catch (err: any) {
      debug.log('plugin.discovery', 'error', { plugin: null, reason: err?.message || String(err) }, { level: 'error' });
      return;
    }
    for (const name of names) {
      const packDir = join(this.packsDir, name);
      try {
        if (!statSync(packDir).isDirectory() || !existsSync(join(packDir, 'plugin.json'))) continue;
        const { manifest } = loadPluginManifestFromDir(packDir, { id: name, main: './plugin.ts' });
        this.loadDiscoveredNodes(packDir, manifest);
      } catch (err: any) {
        const reason = err?.message || String(err);
        this.hooks.log(`⚠ failed to load pack manifest ${name}: ${reason}`);
        debug.log('plugin.discovery', 'error', { plugin: name, reason }, { level: 'error' });
      }
    }
  }

  private async scanDir(dir: string, source: PluginSource, onlyEntry?: string, expectedId?: string): Promise<void> {
    const exists = existsSync(dir);
    if (!exists) {
      debug.log('plugin.discovery', 'scan', { dir, source, exists, count: 0 });
      return;
    }
    let entries: string[] = [];
    try {
      entries = onlyEntry ? [onlyEntry] : readdirSync(dir);
    } catch (err: any) {
      debug.log('plugin.discovery', 'scan', { dir, source, exists, count: 0 });
      debug.log('plugin.discovery', 'error', {
        plugin: null,
        reason: err?.message || String(err),
      }, { level: 'error' });
      return;
    }
    let count = 0;
    for (const name of entries) {
      const pluginDir = join(dir, name);
      let isDir = false;
      try { isDir = statSync(pluginDir).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      // Portable graph bundles are installer inputs, not legacy repository plugins.
      if (source === 'builtin' && existsSync(join(pluginDir, 'plugin.json'))) {
        try {
          const raw = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
          if (raw?.extensions?.['ai.elanous'] && !raw.main) continue;
        } catch { /* manifest loader below reports malformed files */ }
      }
      const hasLegacyEntry = existsSync(join(pluginDir, 'plugin.ts'));
      let manifestLoad: ReturnType<typeof loadPluginManifestFromDir>;
      try {
        manifestLoad = loadPluginManifestFromDir(pluginDir, { id: name, main: './plugin.ts' });
      } catch (err: any) {
        const reason = err?.message || String(err);
        this.hooks.log(`⚠ failed to load plugin manifest ${name}: ${reason}`);
        debug.log('plugin.discovery', 'error', { plugin: name, reason }, { level: 'error' });
        continue;
      }
      if (expectedId && manifestLoad.manifest.id !== expectedId) continue;
      if (source === 'installed' && this.available.has(manifestLoad.manifest.id)) continue;
      const entry = join(pluginDir, manifestLoad.manifest.main);
      if (!existsSync(entry)) {
        // Only warn when the directory *looks like* a plugin — i.e. it
        // has a legacy plugin.ts or an explicit manifest. Directories
        // with neither (library-only folders like plugins/iul-shared,
        // category folders like plugins/examples, Claude Code's
        // ~/.claude/plugins/{cache,data,marketplaces} internal state)
        // are silently skipped: they never intended to be plugins.
        const looksLikePlugin = hasLegacyEntry || !manifestLoad.inferred;
        // 스킬·그래프만 싣는 팩(공식 `elanous-basics` 등)은 코드 진입점이 없다 — 매니페스트가 `main` 을
        // 적지 않아 기본값 `./plugin.ts` 가 들어온 것뿐이다. 부팅마다 «main not found» 경고를 내지 않는다.
        if (looksLikePlugin && isSkillOnlyPack(pluginDir, manifestLoad.manifest, hasLegacyEntry)) {
          debug.log('plugin.discovery', 'skill-only', { plugin: manifestLoad.manifest.id });
          continue;
        }
        if (looksLikePlugin) {
          this.hooks.log(`⚠ plugin "${manifestLoad.manifest.id}" main not found: ${manifestLoad.manifest.main}`);
          debug.log('plugin.discovery', 'error', {
            plugin: manifestLoad.manifest.id,
            reason: `main not found: ${manifestLoad.manifest.main}`,
          }, { level: 'error' });
        }
        continue;
      }
      try {
        // Cache-bust via query string so /plugin reload works.
        const mod = await import(`${entry}?t=${Date.now()}`);
        const loaded: Partial<ElanousPlugin> | undefined = mod.default ?? mod.plugin;
        const plugin = loaded ? normalizePluginExport(loaded, manifestLoad.manifest) : undefined;
        if (!plugin || !plugin.name) {
          const reason = 'no default export';
          this.hooks.log(`⚠ plugin at ${entry} has ${reason}`);
          debug.log('plugin.discovery', 'error', {
            plugin: manifestLoad.manifest.id,
            reason,
          }, { level: 'error' });
          continue;
        }
        const existing = this.available.get(manifestLoad.manifest.id);
        if (existing && existing.source === 'builtin' && source === 'user') {
          this.hooks.log(`⚠ user plugin "${manifestLoad.manifest.id}" overrides built-in`);
        }
        this.available.set(manifestLoad.manifest.id, {
          plugin,
          manifest: manifestLoad.manifest,
          manifestPath: manifestLoad.path,
          manifestInferred: manifestLoad.inferred,
          source,
          path: pluginDir,
        });
        count++;
      } catch (err: any) {
        const reason = err?.message || String(err);
        this.hooks.log(`⚠ failed to load plugin ${name}: ${reason}`);
        debug.log('plugin.discovery', 'error', { plugin: name, reason }, { level: 'error' });
      }
    }
    debug.log('plugin.discovery', 'scan', { dir, source, exists, count });
  }

  list(): PluginEntry[] {
    return [...this.available.values()].sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
  }

  active(): ActivePlugin | null {
    return this.activeEntry;
  }

  isActive(name: string): boolean {
    return this.activeEntry?.name === name || this.activeEntry?.plugin.name === name;
  }

  async activate(name: string): Promise<void> {
    const entry = this.resolveEntry(name);
    if (!entry) throw new Error(`plugin "${name}" not found — try /plugin list`);
    if (this.activeEntry?.name === entry.manifest.id) return;
    if (this.activeEntry) await this.deactivate();

    const plugin = entry.plugin;
    const loadedWidgetTypes: string[] = [];
    try {
      loadedWidgetTypes.push(...await this.loadManifestWidgets(entry));
    } catch (err) {
      for (const type of loadedWidgetTypes) this.widgetHost?.unregisterType(type);
      throw err;
    }

    // Phase 5 — programmatic widget contributions declared on the
    // plugin object itself (vs. the manifest-based `contributes.widgets`
    // path handled above). Registered with source='plugin' so deactivate
    // cleanup (shared with the manifest path) owner-scopes the unregister.
    if (plugin.widgets && plugin.widgets.length > 0) {
      if (!this.widgetHost) {
        // No registry — nothing to roll back. Manifest path runs first
        // and would have failed on its own pre-check when widgets are
        // present, so loadedWidgetTypes is empty here.
        throw new Error(`plugin "${name}" declares widgets but host has no widget registry`);
      }
      try {
        for (const def of plugin.widgets) {
          if (!def || !def.type) continue;
          this.widgetHost.register(def, 'plugin', entry.path);
          loadedWidgetTypes.push(def.type);
        }
      } catch (err) {
        for (const type of loadedWidgetTypes) this.widgetHost?.unregisterType(type);
        throw err;
      }
    }

    // Verify widget deps before any state changes
    const requiredWidgets = [
      ...(plugin.requiredWidgets ?? []),
      ...manifestRequiredWidgets(entry.manifest),
    ].filter((value, index, all) => all.indexOf(value) === index);
    if (requiredWidgets.length > 0) {
      if (!this.widgetHost) {
        throw new Error(`plugin "${name}" declares requiredWidgets but host has no widget registry`);
      }
      const missing = requiredWidgets.filter(t => !this.widgetHost!.hasType(t));
      if (missing.length > 0) {
        for (const type of loadedWidgetTypes) this.widgetHost?.unregisterType(type);
        throw new Error(`plugin "${name}" requires widget type(s) not installed: ${missing.join(', ')}`);
      }
    }

    let aiTools: LLMToolDef[];
    try {
      aiTools = await this.resolveAITools(entry, plugin.llmTools ?? []);
    } catch (err) {
      for (const type of loadedWidgetTypes) this.widgetHost?.unregisterType(type);
      throw err;
    }

    let state: unknown;
    try {
      state = plugin.initialState();
    } catch (err) {
      for (const type of loadedWidgetTypes) this.widgetHost?.unregisterType(type);
      throw err;
    }
    const ownedSlots = new Set<PaneSlot>(Object.keys(plugin.panes) as PaneSlot[]);

    getGlobalElementRegistry().register('plugin', entry.manifest.id, {
      kind: 'plugin', id: entry.manifest.id,
    });
    publishElementEvent('plugin', entry.manifest.id, 'create');
    this.activeEntry = {
      name: entry.manifest.id,
      plugin,
      state,
      ownedSlots,
      layout: null,
      ownedWidgets: [],
      ownedDisplayDisposables: [],
      ownedCommandDisposables: [],
      ownedTaskDisposables: [],
      ownedHookDisposers: [],
      ownedMissionDisposers: [],
      ownedRouteDisposers: [],
      ownedWorkflowDisposers: [],
      ownedWidgetTypes: loadedWidgetTypes,
      dashboardPanes: [],
      dashboardViews: [],
      themeContributions: [],
      aiTools,
      promptFragmentIds: [],
      // MSS M1.2: brand this activation. Reactivating the same plugin
      // mints a fresh URI — that's the point (each cycle is a new
      // observable identity for downstream MSS bridges).
      pluginUri: mintPluginUri(),
    };
    this.activeEntry.ownedCommandDisposables.push(this.commands.registerPluginCommands({
      pluginId: entry.manifest.id,
      manifest: entry.manifest,
      slashCommands: plugin.slashCommands ?? [],
      context: () => this.buildContext(),
    }));
    this.activeEntry.ownedTaskDisposables.push(this.tasks.registerPluginTasks(entry.manifest.contributes.tasks ?? [], {
      pluginId: entry.manifest.id,
      pluginDir: entry.path,
      // WD7 — plugin workspaceDir follows the active project.
      workspaceDir: getSessionCwd(),
      execution: this.buildExecutionContext(),
    }));
    this.loadManifestDashboardContributions(entry);
    this.loadManifestPromptContributions(entry);
    // PX-3: register manifest-declared shell hooks BEFORE onActivate
    // so the plugin can assume its own hooks are already wired when
    // it boots.
    this.registerManifestHooks(entry);
    // PX-4: missions + workflows register here too so onActivate sees
    // them in globalMissionRegistry / workflow definition registry.
    this.registerManifestMissions(entry);
    this.registerManifestWorkflows(entry);
    // PX-5: routes register at activate so the keyword detector +
    // Turn hook see them immediately.
    this.registerManifestRoutes(entry);
    // PX-3 P5: StateRestore hook — fires ONCE per plugin activation,
    // delivering the plugin's persisted state blob. Fire-and-forget;
    // return value ignored. Zero cost when no handlers registered.
    try {
      await this.dispatchStateRestore(entry.manifest.id);
    } catch (err: any) {
      this.hooks.log(`⚠ plugin "${entry.manifest.id}" StateRestore failed: ${err?.message ?? err}`);
    }
    const ctx = this.buildContext();
    try {
      await plugin.onActivate?.(ctx);
      // Resolve layout after onActivate so the plugin can initialize
      // state first (e.g. fetch remote rows). buildLayout can spawn
      // widgets via the tracked helper — we record ids for dispose.
      if (plugin.buildLayout && this.widgetHost) {
        const layoutCtx = this.buildLayoutCtx();
        const layout = plugin.buildLayout(layoutCtx);
        if (layout) this.activeEntry.layout = layout;
      }
      this.hooks.hudSet('mode', `mode: ${name}`, 10);
    } catch (err: any) {
      this.hooks.log(`⚠ plugin "${name}" activation failed: ${err?.message || err}`);
      // Best-effort cleanup — dispose any widgets that made it
      const reg = getGlobalElementRegistry();
      reg.unregister('plugin', entry.manifest.id);
      publishElementEvent('plugin', entry.manifest.id, 'delete');
      if (this.widgetHost && this.activeEntry) {
        for (const id of this.activeEntry.ownedWidgets) {
          this.widgetHost.dispose(id);
          reg.unregister('widget', id);
          publishElementEvent('widget', id, 'delete');
        }
      }
      if (this.activeEntry) {
        for (const d of this.activeEntry.ownedDisplayDisposables) d.dispose();
        for (const d of this.activeEntry.ownedCommandDisposables) d.dispose();
        for (const d of this.activeEntry.ownedTaskDisposables) d.dispose();
        for (const d of this.activeEntry.ownedHookDisposers) d();
        for (const d of this.activeEntry.ownedMissionDisposers) d();
        for (const d of this.activeEntry.ownedRouteDisposers) d();
        for (const d of this.activeEntry.ownedWorkflowDisposers) d();
        for (const type of this.activeEntry.ownedWidgetTypes) this.widgetHost?.unregisterType(type);
      }
      this.activeEntry = null;
      this.hooks.hudSet('mode', '', 10);
      throw err;
    }
  }

  async deactivate(): Promise<void> {
    if (!this.activeEntry) return;
    const ctx = this.buildContext();
    try {
      await this.activeEntry.plugin.onDeactivate?.(ctx);
    } catch (err: any) {
      this.hooks.log(`⚠ plugin "${this.activeEntry.name}" onDeactivate failed: ${err?.message || err}`);
    }
    const reg = getGlobalElementRegistry();
    // Dispose every widget this plugin spawned through PluginLayoutCtx
    if (this.widgetHost) {
      for (const id of this.activeEntry.ownedWidgets) {
        this.widgetHost.dispose(id);
        reg.unregister('widget', id);
        publishElementEvent('widget', id, 'delete');
      }
    }
    for (const d of this.activeEntry.ownedDisplayDisposables) d.dispose();
    for (const d of this.activeEntry.ownedCommandDisposables) d.dispose();
    for (const d of this.activeEntry.ownedTaskDisposables) d.dispose();
    const promptStore = getPromptBankStore();
    for (const id of this.activeEntry.promptFragmentIds) promptStore.delete(id);
    // PX-3: dispose hook registrations for this plugin.
    for (const d of this.activeEntry.ownedHookDisposers) {
      try { d(); } catch { /* best-effort */ }
    }
    // PX-4: dispose mission + workflow registrations.
    for (const d of this.activeEntry.ownedMissionDisposers) {
      try { d(); } catch { /* best-effort */ }
    }
    for (const d of this.activeEntry.ownedWorkflowDisposers) {
      try { d(); } catch { /* best-effort */ }
    }
    // PX-5: dispose route registrations + re-persist.
    for (const d of this.activeEntry.ownedRouteDisposers) {
      try { d(); } catch { /* best-effort */ }
    }
    if (this.activeEntry.ownedRouteDisposers.length > 0) {
      try {
        const { globalRouteRegistry } = require('../../plugin-routes/registry.js');
        void globalRouteRegistry.persist();
      } catch { /* best-effort */ }
    }
    for (const type of this.activeEntry.ownedWidgetTypes) this.widgetHost?.unregisterType(type);
    // PX-2 P4: drop session-state entries + cached api handle for
    // this plugin. Persistent state in ~/.elanous/state survives.
    this.clearPluginStateScope(this.activeEntry.name);
    reg.unregister('plugin', this.activeEntry.name);
    publishElementEvent('plugin', this.activeEntry.name, 'delete');
    this.activeEntry = null;
    this.hooks.hudSet('mode', '', 10);
  }

  /** Layout produced by the active plugin's buildLayout, or null when
   *  no plugin is active or it returned no layout. */
  activeLayout(): Layout | null {
    return this.activeEntry?.layout ?? null;
  }

  activeDashboardPanes(): ActiveDashboardPaneContribution[] {
    return [...(this.activeEntry?.dashboardPanes ?? [])];
  }

  activeDashboardViews(): PluginViewContribution[] {
    return [...(this.activeEntry?.dashboardViews ?? [])];
  }

  activeThemeContributions(): ActiveThemeContribution[] {
    return [...(this.activeEntry?.themeContributions ?? [])];
  }

  loadThemeTokens(id: string): ThemeTokenInput | null {
    const active = this.activeEntry;
    if (!active) return null;
    const contribution = active.themeContributions.find(theme =>
      theme.id === id
      || theme.localId === id
      || `${theme.pluginId}.${theme.localId}` === id
    );
    if (!contribution) return null;
    const stat = statSync(contribution.path);
    const cached = this.themeCache.get(contribution.path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.tokens;
    const raw = JSON.parse(readFileSync(contribution.path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`plugin theme "${id}" must be a JSON object`);
    }
    const tokens = raw as ThemeTokenInput;
    this.themeCache.set(contribution.path, { mtimeMs: stat.mtimeMs, tokens });
    return tokens;
  }

  /** Reload a specific plugin's module (dev helper). */
  async reload(name: string): Promise<void> {
    const entry = this.resolveEntry(name);
    const wasActive = this.activeEntry?.name === entry?.manifest.id;
    if (wasActive) await this.deactivate();
    if (!entry) throw new Error(`plugin "${name}" not found`);
    await this.scanDir(join(entry.path, '..'), entry.source);
    if (wasActive) await this.activate(entry.manifest.id);
  }

  /** Route a keystroke through the active plugin's handler stack.
   *  Priority: busy guard → keybindings → focused pane.onKey → plugin.onKey.
   *  Returns 'consumed' when the plugin handled it (caller must `continue`)
   *  or 'passthrough' when the dashboard should fall back to its own
   *  browse-mode key logic. */
  async routeKey(ev: KeyEvent, focus: PaneSlot): Promise<'consumed' | 'passthrough'> {
    const active = this.activeEntry;
    if (!active) return 'passthrough';

    // Busy guard — plugin owns long-running input blocking. Caller still
    // gets 'consumed' so the dashboard main loop swallows the key.
    if (active.plugin.isBusy?.(active.state as any)) return 'consumed';

    // 1. Static keybindings lookup
    const bindings = active.plugin.keybindings ?? [];
    const binding = bindings.find(kb => matchesKey(kb.key, ev));
    if (binding) {
      const [cmd, ...args] = binding.command.split(/\s+/);
      if (!cmd) return 'consumed';
      if (this.hooks.runSlash) {
        await this.hooks.runSlash(cmd, args);
      } else {
        await this.dispatchCommand(cmd, args, { surface: 'keybinding' });
      }
      return 'consumed';
    }

    // 2. Focused pane.onKey — only if plugin owns the slot
    if (active.ownedSlots.has(focus)) {
      const pane = active.plugin.panes[focus];
      if (pane?.onKey) {
        const action = pane.onKey(ev, active.state as any);
        if (action.type !== 'none') {
          await this.applyAction(action);
          return 'consumed';
        }
      }
    }

    // 3. Plugin-global onKey
    if (active.plugin.onKey) {
      const action = active.plugin.onKey(ev, active.state as any, this.buildContext());
      if (action.type !== 'none') {
        await this.applyAction(action);
        return 'consumed';
      }
    }

    return 'passthrough';
  }

  /** Apply an Action returned by a pane or plugin handler. */
  private async applyAction(action: Action): Promise<void> {
    switch (action.type) {
      case 'none': return;
      case 'refresh': this.hooks.requestRender(action.pane); return;
      case 'focus': this.hooks.focusPane(action.pane); return;
      case 'deactivate': await this.deactivate(); return;
      case 'submit':
        if (this.hooks.submitText) await this.hooks.submitText(action.text);
        else this.hooks.log(`⚠ plugin emitted submit but host has no submitText hook: "${action.text}"`);
        return;
    }
  }

  /** Slash commands contributed by the active plugin. */
  contributedSlashCommands(): SlashCommand[] {
    const active = this.activeEntry;
    if (!active) return [];
    return this.commands.list({ pluginId: active.name }).map(command => commandToSlashMetadata(command, (args) => this.dispatchCommand(command.id, args)));
  }

  /** Active plugin command catalog. Includes hidden/internal commands
   *  when requested. Handlers stay private to dispatchCommand. */
  contributedCommands(opts: { includeHidden?: boolean } = {}): RegisteredCommand[] {
    const active = this.activeEntry;
    if (!active) return [];
    return this.commands.list({ pluginId: active.name, includeHidden: opts.includeHidden });
  }

  hostLLMTools(): LLMToolDef[] {
    return [...this.hostTools];
  }

  activePluginLLMTools(): LLMToolDef[] {
    return [...(this.activeEntry?.aiTools ?? [])];
  }

  /** LLM tool defs contributed by the active plugin + any host-level
   *  tools (registerHostTool). The chat loop merges these into the
   *  provider request so the model can invoke both layers directly. */
  contributedLLMTools(): LLMToolDef[] {
    return [...this.hostLLMTools(), ...this.activePluginLLMTools()];
  }

  executionHistory(limit = 20): ExecutionHistoryRecord[] {
    return this.tasks.executionList(limit);
  }

  /** Resolve a tool_call by name and invoke its handler.
   *  Returns either `{ ok: true, result }` (to be fed back to the model
   *  as tool_result) or `{ ok: false, error }` with a string description.
   *  Tool errors are structured values — they do NOT throw so the chat
   *  loop can append the error as tool_result and let the model recover.
   *  Host-level tools are dispatched even when no plugin is active. */
  async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const tool = this.contributedLLMTools().find(t => t.name === name);
    if (!tool) {
      debug.log('plugin.tool.miss', `unknown tool "${name}"`, { args });
      return { ok: false, error: `unknown tool "${name}"` };
    }
    const started = Date.now();
    debug.log('plugin.tool', name, { args, plugin: this.activeEntry?.name ?? null });
    try {
      // Host tools can run outside any plugin context — buildContext
      // falls back to a minimal stub when activeEntry is null.
      const ctx = this.activeEntry ? this.buildContext() : this.buildHostContext();
      const result = await tool.handler(args, ctx);
      debug.log('plugin.tool.done', name, {
        durationMs: Date.now() - started,
        result: previewResult(result),
      });
      return { ok: true, result };
    } catch (err: any) {
      debug.log('plugin.tool.error', name, {
        message: err?.message || String(err),
        durationMs: Date.now() - started,
      }, { level: 'error' });
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** Minimal PluginContext stand-in for host-tool invocations when no
   *  plugin is active. Logs + hudSet still flow to the dashboard; the
   *  state-related fields return safe defaults. */
  private buildHostContext(): PluginContext {
    const host = this;
    return {
      pluginName: '',
      state: {},
      display: host.hooks.display,
      focus: {
        current: () =>
          host.hooks.focusManager?.active()?.id
          ?? host.hooks.display?.currentFocus()
          ?? null,
        set: (target) => {
          if (host.hooks.focusManager) {
            host.hooks.focusManager.setFocus(target, 'plugin:set');
          } else {
            host.hooks.display?.focus(target);
          }
        },
        cycle: (scope, dir) => {
          if (host.hooks.focusManager) {
            return host.hooks.focusManager.cycle(
              (scope ?? 'dashboard') as Parameters<FocusManager['cycle']>[0],
              dir ?? 1,
              'plugin:cycle',
            );
          }
          return host.hooks.display?.cycleFocus(scope, dir) ?? null;
        },
      },
      keymap: {
        register: (binding) => host.hooks.display?.registerKey(binding) ?? { dispose: () => {} },
      },
      events: host.hooks.displayEvents ? {
        subscribe: (type, listener) => host.hooks.displayEvents!.subscribe(type, listener),
      } : undefined,
      theme: host.hooks.theme ? {
        current: () => host.hooks.theme!(),
      } : undefined,
      execution: host.hooks.execution,
      capabilities: undefined,
      tasks: undefined,
      modals: undefined,
      panes: host.buildPanesContext(),
      setState: () => {},
      log: (line) => host.hooks.log(line),
      hudSet: (k, v, p) => host.hooks.hudSet(k, v, p),
      requestRender: (pane) => host.hooks.requestRender(pane),
      focusPane: (pane) => host.hooks.focusPane(pane),
      getWidget: (id) => host.widgetHost?.get(id) ?? null,
      setLayout: () => {},
    };
  }

  /** Resolve + dispatch a slash command by name. Returns true if handled. */
  async dispatchSlash(name: string, args: string[]): Promise<boolean> {
    return this.dispatchCommand(name, args, { surface: 'slash' });
  }

  /** Resolve + dispatch a plugin command by id or alias. Returns true
   *  if a registered handler ran. */
  async dispatchCommand(
    name: string,
    args: string[],
    opts: { surface?: 'slash' | 'keybinding' | 'command' } = {},
  ): Promise<boolean> {
    const command = this.commands.get(name);
    if (!command?.handler) {
      debug.log('plugin.command.miss', `no handler for ${name}`, {
        args,
        plugin: this.activeEntry?.name ?? null,
        surface: opts.surface ?? 'command',
      });
      return false;
    }
    const started = Date.now();
    debug.log('plugin.command', name, {
      args,
      plugin: this.activeEntry?.name ?? null,
      surface: opts.surface ?? 'command',
    });
    try {
      await this.commands.dispatch(name, args);
    } catch (err: any) {
      debug.log('plugin.command.error', `${name} threw`, {
        message: err?.message || String(err),
        durationMs: Date.now() - started,
      }, { level: 'error' });
      throw err;
    }
    debug.log('plugin.command.done', name, { durationMs: Date.now() - started });
    return true;
  }

  /** Build a PluginLayoutCtx for buildLayout. Spawns through the tracked
   *  helper so we know which widgets belong to this plugin. */
  private buildLayoutCtx<S>(): PluginLayoutCtx<S> {
    const host = this;
    const pluginCtx = this.buildContext();
    return {
      plugin: pluginCtx,
      get state() { return (host.activeEntry?.state ?? {}) as S; },
      spawnWidget(opts) {
        if (!host.widgetHost) throw new Error('no widget host attached');
        const inst = host.widgetHost.spawn(opts);
        if (host.activeEntry) host.activeEntry.ownedWidgets.push(inst.id);
        getGlobalElementRegistry().register('widget', inst.id, { kind: 'widget', id: inst.id });
        publishElementEvent('widget', inst.id, 'create');
        return inst;
      },
      setState(patch) { pluginCtx.setState(patch as Record<string, unknown>); },
    };
  }

  private buildContext(): PluginContext {
    const host = this;
    return {
      get pluginName() { return host.activeEntry?.name ?? ''; },
      get state() { return host.activeEntry?.state ?? {}; },
      get display() { return host.hooks.display; },
      focus: {
        // F-3b — prefer primitive `focusManager` when wired; fall back
        // to the display handle wrappers for hosts that haven't wired
        // the primitive yet. Mirrors buildHostContext above.
        current: () =>
          host.hooks.focusManager?.active()?.id
          ?? host.hooks.display?.currentFocus()
          ?? null,
        set: (target) => {
          if (host.hooks.focusManager) {
            host.hooks.focusManager.setFocus(target, 'plugin:set');
          } else {
            host.hooks.display?.focus(target);
          }
        },
        cycle: (scope, dir) => {
          if (host.hooks.focusManager) {
            return host.hooks.focusManager.cycle(
              (scope ?? 'dashboard') as Parameters<FocusManager['cycle']>[0],
              dir ?? 1,
              'plugin:cycle',
            );
          }
          return host.hooks.display?.cycleFocus(scope, dir) ?? null;
        },
      },
      keymap: {
        register: (binding) => {
          const disposable = host.hooks.display?.registerKey(binding) ?? { dispose: () => {} };
          host.activeEntry?.ownedDisplayDisposables.push(disposable);
          return disposable;
        },
      },
      events: host.hooks.displayEvents ? {
        subscribe: (type, listener) => {
          const disposable = host.hooks.displayEvents!.subscribe(type, listener);
          host.activeEntry?.ownedDisplayDisposables.push(disposable);
          return disposable;
        },
      } : undefined,
      theme: host.hooks.theme ? {
        current: () => host.hooks.theme!(),
      } : undefined,
      execution: host.buildExecutionContext(),
      capabilities: host.buildCapabilitiesContext(),
      tasks: host.buildTasksContext(),
      prompts: host.buildPromptsContext(),
      modals: host.buildModalsContext(),
      panes: host.buildPanesContext(),
      setState(patch) {
        if (!host.activeEntry) return;
        host.activeEntry.state = { ...(host.activeEntry.state as object), ...patch };
        host.hooks.requestRender();
      },
      log: (line) => host.hooks.log(line),
      hudSet: (k, v, p) => host.hooks.hudSet(k, v, p),
      requestRender: (pane) => host.hooks.requestRender(pane),
      focusPane: (pane) => host.hooks.focusPane(pane),
      getWidget: (id) => host.widgetHost?.get(id) ?? null,
      setLayout: (layout) => {
        if (!host.activeEntry) return;
        host.activeEntry.layout = layout;
        host.hooks.requestRender();
      },
      spawnWidget: (opts) => {
        if (!host.widgetHost) throw new Error('no widget host attached');
        const inst = host.widgetHost.spawn(opts);
        if (host.activeEntry) host.activeEntry.ownedWidgets.push(inst.id);
        getGlobalElementRegistry().register('widget', inst.id, { kind: 'widget', id: inst.id });
        publishElementEvent('widget', inst.id, 'create');
        return inst;
      },
      // PC-INTRO (Bundle 3) — undefined when no widget-host is wired
      // so older host shells keep working untouched. Returns the live
      // registry snapshot, including builtins, user-installed, and
      // plugin-contributed (ElanousPlugin.widgets) types.
      ...(host.widgetHost ? {
        listWidgetTypes: () => host.widgetHost!.listTypes(),
      } : {}),
      // Bundle 8W (2026-04-20) — expose the widget-host's recorder-relevant
      // slice so plugins can drive `createWidgetRecorder` without direct
      // dashboard coupling. Structural subtype of WidgetRecorderHost;
      // undefined when no widget-host is attached (plugin handles
      // fallback).
      ...(host.widgetHost ? {
        widgetRecorderHost: {
          onInstanceStateChange: (cb) => host.widgetHost!.onInstanceStateChange(cb),
          snapshotHashFor: (id) => host.widgetHost!.snapshotHashFor(id),
          get: (id) => host.widgetHost!.get(id),
        },
      } : {}),
      // PX-2 P4: plugin-scoped persistent + session state. Built
      // lazily per-call so a host without statePersistence wired
      // returns undefined (older plugins keep working). The active
      // entry caches the api so repeated property reads return the
      // same object reference.
      get persistentState() {
        return host.buildPersistentStateContext();
      },
    };
  }

  private buildPanesContext(): PluginContext['panes'] {
    if (!this.hooks.panes) return undefined;
    return {
      state: () => this.hooks.panes!.state(),
      visible: () => this.hooks.panes!.state().panes.filter(pane => pane.visible).map(pane => pane.pane),
      close: (pane) => this.hooks.panes!.close(pane),
      open: (pane) => this.hooks.panes!.open(pane),
      openModal: (pane) => this.hooks.panes!.openModal(pane),
      setOmitOrder: this.hooks.panes.setOmitOrder
        ? (panes) => this.hooks.panes!.setOmitOrder!(panes)
        : undefined,
    };
  }

  private buildExecutionContext(): PluginContext['execution'] {
    if (!this.hooks.execution) return undefined;
    return {
      spawn: (spec) => {
        const active = this.activeEntry;
        if (!active) throw new Error('no active plugin for execution spawn');
        assertCapability(this.capabilityPolicy.canSpawnProcess(this.capabilityContext(active), spec));
        return this.hooks.execution!.spawn(spec);
      },
    };
  }

  private buildCapabilitiesContext(): PluginContext['capabilities'] {
    const active = this.activeEntry;
    if (!active) return undefined;
    const host = this;
    return {
      canReadFile(path) {
        return host.capabilityPolicy.canReadFile(host.capabilityContext(active), path).ok;
      },
      canWriteFile(path) {
        return host.capabilityPolicy.canWriteFile(host.capabilityContext(active), path).ok;
      },
      canNetwork(url) {
        return host.capabilityPolicy.canNetwork(host.capabilityContext(active), url).ok;
      },
      canClipboard(mode) {
        return host.capabilityPolicy.canClipboard(host.capabilityContext(active), mode).ok;
      },
      readTextFile(path) {
        assertCapability(host.capabilityPolicy.canReadFile(host.capabilityContext(active), path));
        return readFileSync(path, 'utf-8');
      },
      writeTextFile(path, content) {
        assertCapability(host.capabilityPolicy.canWriteFile(host.capabilityContext(active), path));
        writeFileSync(path, content, 'utf-8');
      },
      async fetch(input, init) {
        const url = input instanceof URL ? input.toString() : input;
        assertCapability(host.capabilityPolicy.canNetwork(host.capabilityContext(active), url));
        return fetch(input, init);
      },
      clipboard: {
        async readText() {
          assertCapability(host.capabilityPolicy.canClipboard(host.capabilityContext(active), 'read'));
          return readClipboardText();
        },
        async writeText(text) {
          assertCapability(host.capabilityPolicy.canClipboard(host.capabilityContext(active), 'write'));
          return writeClipboard(text);
        },
      },
    };
  }

  private capabilityContext(active: ActivePlugin) {
    const entry = this.resolveEntry(active.name);
    const source = entry?.source ?? 'user';
    const trust = this.trustStore.list();
    const userRecord = trust.find(record => record.pluginId === active.name && record.scope === 'user');
    const workspaceRecord = trust.find(record => record.pluginId === active.name && record.scope === 'workspace');
    return {
      pluginId: active.name,
      source,
      capabilities: entry?.manifest.capabilities ?? [],
      ...(userRecord ? { userTrusted: userRecord.trusted } : {}),
      ...(workspaceRecord ? { workspaceTrusted: workspaceRecord.trusted } : {}),
    };
  }

  private buildTasksContext(): PluginContext['tasks'] {
    const active = this.activeEntry;
    if (!active) return undefined;
    return {
      list: () => this.tasks.list(active.name),
      run: (id, opts) => this.tasks.run(id, opts, active.name),
    };
  }

  private buildModalsContext(): PluginContext['modals'] {
    const active = this.activeEntry;
    if (!active || !this.widgetHost) return undefined;
    return {
      open: (id, opts = {}) => {
        const entry = this.resolveEntry(active.name);
        const spec = entry?.manifest.contributes.modals?.find(m => m.id === id);
        if (!spec) throw new Error(`plugin modal not found: ${id}`);
        const widget = this.widgetHost!.spawn({
          type: spec.widget,
          id: `${active.name}:${spec.id}`,
          character: opts.character ?? spec.title ?? spec.id,
          config: { ...(spec.config ?? {}), ...(opts.config ?? {}) },
        });
        active.ownedWidgets.push(widget.id);
        getGlobalElementRegistry().register('widget', widget.id, { kind: 'widget', id: widget.id });
        publishElementEvent('widget', widget.id, 'create');
        const modal = {
          id: spec.id,
          widgetInstanceId: widget.id,
          position: spec.position ?? ('center' as const),
          ...(spec.size ? { size: spec.size } : {}),
        };
        active.layout = openModal(active.layout ?? emptyLayout(), modal);
        this.hooks.requestRender();
        return modal;
      },
      close: (id) => {
        const current = active.layout;
        if (!current || current.modals.length === 0) return false;
        const targetId = id ?? current.modals[0]!.id;
        const modal = current.modals.find(m => m.id === targetId);
        if (!modal) return false;
        this.widgetHost!.dispose(modal.widgetInstanceId);
        active.layout = closeModal(current, targetId);
        this.hooks.requestRender();
        return true;
      },
    };
  }

  private buildPromptsContext(): PluginContext['prompts'] {
    const active = this.activeEntry;
    if (!active) return undefined;
    const pluginId = active.name;
    const store = getPromptBankStore();
    return {
      register: (input) => {
        const localId = input.id ?? `runtime_${Date.now()}`;
        const id = pluginPromptFragmentId(pluginId, localId);
        const fragmentInput = {
          ...input,
          id,
          scope: input.scope ?? 'plugin',
          owner: `plugin:${pluginId}`,
          triggers: { ...(input.triggers ?? {}), pluginActive: pluginId },
          metadata: {
            ...(input.metadata ?? {}),
            pluginId,
            runtime: true,
            contributionId: localId,
          },
        };
        const fragment = store.get(id)
          ? store.update(id, fragmentInput)
          : store.create(fragmentInput);
        if (!active.promptFragmentIds.includes(id)) active.promptFragmentIds.push(id);
        return fragment;
      },
      search: (query) => store.search({
        ...query,
        owner: query.owner ?? `plugin:${pluginId}`,
      }),
      injectOnce: (options = {}) => buildPromptInjection({
        store,
        state: {
          activePlugins: [pluginId],
          ...(options.state ?? {}),
          intents: options.intents ?? options.state?.intents ?? [],
        },
        options: {
          budgetTokens: options.budgetTokens,
          limit: options.limit,
          includeHeaders: options.includeHeaders,
          record: options.record ?? false,
          activePlugin: pluginId,
          metadata: { pluginId, source: 'plugin.ctx.prompts.injectOnce' },
        },
      }),
      describeForLLM: () => {
        const fragments = store.search({ owner: `plugin:${pluginId}`, enabled: true, limit: 20 });
        if (fragments.length === 0) return `Plugin ${pluginId} has no active Prompt Bank fragments.`;
        return [
          `Plugin ${pluginId} Prompt Bank fragments:`,
          ...fragments.map(fragment => `- ${fragment.id}: slot=${fragment.targetSlot}, kind=${fragment.kind}, tags=${fragment.tags.join(',') || '-'}`),
        ].join('\n');
      },
    };
  }

  private async loadManifestWidgets(entry: PluginEntry): Promise<string[]> {
    const widgets = entry.manifest.contributes.widgets ?? [];
    if (widgets.length === 0) return [];
    if (!this.widgetHost) throw new Error(`plugin "${entry.manifest.id}" contributes widgets but host has no widget registry`);
    const loaded: string[] = [];
    try {
      for (const widget of widgets) {
        if (!widget.entry) continue;
        const def = await this.widgetHost.registerFromFile(join(entry.path, widget.entry), 'plugin', entry.path);
        loaded.push(def.type);
      }
      return loaded;
    } catch (err) {
      for (const type of loaded) this.widgetHost.unregisterType(type);
      throw err;
    }
  }

  private loadManifestDashboardContributions(entry: PluginEntry): void {
    const active = this.activeEntry;
    if (!active) return;
    const paneSpecs = entry.manifest.contributes.panes ?? [];
    if (paneSpecs.length > 0 && !this.widgetHost) {
      throw new Error(`plugin "${entry.manifest.id}" contributes dashboard panes but host has no widget registry`);
    }
    const paneByLocalId = new Map<string, PaneFocus>();
    for (const spec of paneSpecs) {
      const paneId = pluginPaneId(entry.manifest.id, spec.id);
      paneByLocalId.set(spec.id, paneId);
      paneByLocalId.set(paneId, paneId);
      const widget = this.widgetHost!.spawn({
        type: spec.widget,
        id: `plugin-pane:${paneId}`,
        character: spec.title ?? spec.id,
        config: spec.config ?? {},
      });
      active.ownedWidgets.push(widget.id);
      getGlobalElementRegistry().register('widget', widget.id, { kind: 'widget', id: widget.id });
      active.dashboardPanes.push({
        pluginId: entry.manifest.id,
        paneId,
        widgetInstanceId: widget.id,
        widgetType: spec.widget,
        title: spec.title ?? spec.id,
        canFocus: spec.canFocus !== false,
      });
    }
    active.dashboardViews = (entry.manifest.contributes.views ?? [])
      .map(view => namespacePluginView(entry.manifest.id, view, paneByLocalId));
    active.themeContributions = (entry.manifest.contributes.themes ?? []).map(theme => ({
      pluginId: entry.manifest.id,
      id: pluginThemeId(entry.manifest.id, theme.id),
      localId: theme.id,
      label: theme.label ?? theme.id,
      path: resolve(entry.path, theme.path),
    }));
  }

  private loadManifestPromptContributions(entry: PluginEntry): void {
    const active = this.activeEntry;
    if (!active) return;
    const prompts = entry.manifest.contributes.prompts ?? [];
    if (prompts.length === 0) return;
    const store = getPromptBankStore();
    for (const prompt of prompts) {
      try {
        const content = readPromptContributionContent(entry, prompt);
        const id = pluginPromptFragmentId(entry.manifest.id, prompt.id);
        const input = {
          id,
          name: prompt.name ?? prompt.id,
          scope: prompt.scope ?? 'plugin',
          owner: `plugin:${entry.manifest.id}`,
          kind: prompt.kind ?? 'instruction',
          targetSlot: prompt.targetSlot ?? 'context',
          content,
          priority: prompt.priority ?? 100,
          enabled: prompt.enabled ?? true,
          description: prompt.description,
          tags: prompt.tags ?? [],
          triggers: { ...(prompt.triggers ?? {}), pluginActive: entry.manifest.id },
          constraints: prompt.constraints ?? {},
          metadata: {
            ...(prompt.metadata ?? {}),
            pluginId: entry.manifest.id,
            contributionId: prompt.id,
            ...(prompt.path ? { path: prompt.path } : {}),
          },
        };
        if (store.get(id)) store.update(id, input);
        else store.create(input);
        active.promptFragmentIds.push(id);
      } catch (err: any) {
        this.hooks.log(`⚠ plugin "${entry.manifest.id}" prompt "${prompt.id}" skipped: ${err?.message || err}`);
      }
    }
  }

  private async resolveAITools(entry: PluginEntry, runtimeTools: LLMToolDef[]): Promise<LLMToolDef[]> {
    const manifestByName = new Map((entry.manifest.contributes.aiTools ?? []).map(tool => [tool.name, tool]));
    const resolved = runtimeTools.map(tool => {
      const manifest = manifestByName.get(tool.name);
      if (!manifest) return tool;
      return {
        ...tool,
        description: manifest.description || tool.description,
        parameters: manifest.parameters ?? (manifest.schema ? this.loadAIToolSchema(entry, manifest.schema) : tool.parameters),
      };
    });
    const runtimeNames = new Set(runtimeTools.map(tool => tool.name));
    for (const manifest of entry.manifest.contributes.aiTools ?? []) {
      if (runtimeNames.has(manifest.name) || !manifest.handler) continue;
      resolved.push({
        name: manifest.name,
        description: manifest.description,
        parameters: manifest.parameters ?? (manifest.schema ? this.loadAIToolSchema(entry, manifest.schema) : { type: 'object', properties: {} }),
        handler: await this.loadAIToolHandler(entry, manifest.handler, manifest.name),
      });
    }
    return resolved;
  }

  private loadAIToolSchema(entry: PluginEntry, schemaPath: string): Record<string, unknown> {
    const path = join(entry.path, schemaPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err: any) {
      throw new Error(`plugin "${entry.manifest.id}" failed to load AI tool schema ${schemaPath}: ${err?.message || err}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`plugin "${entry.manifest.id}" AI tool schema ${schemaPath} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }

  private async loadAIToolHandler(
    entry: PluginEntry,
    handlerPath: string,
    toolName: string,
  ): Promise<LLMToolDef['handler']> {
    const path = join(entry.path, handlerPath);
    const mod = await import(`${path}?t=${Date.now()}`);
    const candidate = mod.default ?? mod.handler ?? mod.tool;
    if (typeof candidate === 'function') return candidate;
    if (candidate?.handler && typeof candidate.handler === 'function') return candidate.handler;
    throw new Error(`plugin "${entry.manifest.id}" AI tool "${toolName}" handler has no function export`);
  }

  private resolveEntry(name: string): PluginEntry | undefined {
    return this.available.get(name)
      ?? [...this.available.values()].find(entry => entry.plugin.name === name || entry.manifest.name === name);
  }
}

function commandToSlashMetadata(command: RegisteredCommand, dispatch: (args: string[]) => Promise<boolean>): SlashCommand {
  return {
    name: command.id,
    aliases: command.aliases,
    description: command.description,
    hidden: command.hidden,
    handler: async (args) => {
      await dispatch(args);
    },
  };
}

function pluginPaneId(pluginId: string, paneId: string): PaneFocus {
  if (paneId.startsWith('plugin:')) return paneId as PaneFocus;
  return `plugin:${pluginId}.${paneId}` as PaneFocus;
}

function pluginThemeId(pluginId: string, localId: string): string {
  if (localId.startsWith('plugin:')) return localId;
  return `plugin:${pluginId}.${localId}`;
}

function pluginPromptFragmentId(pluginId: string, localId: string): string {
  if (localId.startsWith('plugin:')) return localId;
  return `plugin:${pluginId}.${localId}`;
}

function readPromptContributionContent(entry: PluginEntry, contribution: PluginPromptContribution): string {
  if (contribution.content !== undefined) return contribution.content;
  if (!contribution.path) throw new Error('path or content is required');
  return readFileSync(join(entry.path, contribution.path), 'utf8');
}

function namespacePluginView(
  pluginId: string,
  view: PluginViewContribution,
  paneByLocalId: Map<string, PaneFocus>,
): PluginViewContribution {
  const mapPane = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    return paneByLocalId.get(value) ?? value;
  };
  const out: Record<string, unknown> = {
    ...view,
    id: view.id.startsWith('plugin:') ? view.id : `plugin:${pluginId}.${view.id}`,
  };
  if (typeof out.primary === 'string') out.primary = mapPane(out.primary);
  if (Array.isArray(out.omitOrder)) out.omitOrder = out.omitOrder.map(mapPane);
  if (Array.isArray(out.rows)) {
    out.rows = out.rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const raw = row as Record<string, unknown>;
      if (!Array.isArray(raw.panes)) return row;
      return {
        ...raw,
        panes: raw.panes.map(pane => {
          if (typeof pane === 'string') return mapPane(pane);
          if (!pane || typeof pane !== 'object' || Array.isArray(pane)) return pane;
          const rawPane = pane as Record<string, unknown>;
          return { ...rawPane, pane: mapPane(rawPane.pane) };
        }),
      };
    });
  }
  return out as PluginViewContribution;
}

function normalizePluginExport(plugin: Partial<ElanousPlugin>, manifest: PluginManifest): ElanousPlugin {
  return {
    name: plugin.name ?? manifest.name,
    version: plugin.version ?? manifest.version,
    description: plugin.description ?? manifest.description ?? '',
    initialState: plugin.initialState ?? (() => ({})),
    panes: plugin.panes ?? {},
    ...(plugin.slashCommands ? { slashCommands: plugin.slashCommands } : {}),
    ...(plugin.keybindings ? { keybindings: plugin.keybindings } : {}),
    ...(plugin.llmTools ? { llmTools: plugin.llmTools } : {}),
    ...(plugin.onActivate ? { onActivate: plugin.onActivate } : {}),
    ...(plugin.onDeactivate ? { onDeactivate: plugin.onDeactivate } : {}),
    ...(plugin.isBusy ? { isBusy: plugin.isBusy } : {}),
    ...(plugin.onKey ? { onKey: plugin.onKey } : {}),
    ...(plugin.requiredWidgets ? { requiredWidgets: plugin.requiredWidgets } : {}),
    ...(plugin.widgets ? { widgets: plugin.widgets } : {}),
    ...(plugin.buildLayout ? { buildLayout: plugin.buildLayout } : {}),
  };
}
