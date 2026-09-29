import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Keybinding, SlashCommand } from './types.js';
import type { PromptKind, PromptScope, PromptTargetSlot } from '../../prompt-bank/types.js';
import type {
  MissionDefinition,
  MissionKeepPolicy,
} from '../../plugin-missions/types.js';
import { MISSION_DEFAULTS } from '../../plugin-missions/types.js';
import type {
  SkillWorkflow,
  SkillWorkflowStep,
  WorkflowStepKind,
  WorkflowStepOnError,
} from '../../plugin-workflows/types.js';
import { WORKFLOW_DEFAULTS } from '../../plugin-workflows/types.js';

export type PluginSource = 'builtin' | 'user' | 'workspace' | 'installed';

export type PluginCapability =
  | { kind: 'process:spawn'; commands?: string[] }
  | { kind: 'process:exec'; command?: string; commands?: string[]; args?: string[] }
  | { kind: 'fs:read'; roots?: string[] }
  | { kind: 'fs:write'; roots?: string[] }
  | { kind: 'network'; hosts?: string[] }
  | { kind: 'network:fetch'; host?: string; hosts?: string[]; path?: string[] }
  | { kind: 'clipboard' }
  | { kind: 'clipboard:read' }
  | { kind: 'clipboard:write' }
  | { kind: 'display:surface' }
  | { kind: 'display:agent-surface' }
  | { kind: 'display:attention' }
  | { kind: string; [key: string]: unknown };

export interface PluginManifestContributes {
  commands?: Array<Pick<SlashCommand, 'name' | 'description' | 'aliases' | 'hidden'>>;
  keybindings?: Keybinding[];
  widgets?: PluginWidgetContribution[];
  panes?: PluginPaneContribution[];
  views?: PluginViewContribution[];
  modals?: PluginModalContribution[];
  themes?: Array<{ id: string; label?: string; path: string }>;
  tasks?: PluginTaskContribution[];
  aiTools?: PluginAIToolContribution[];
  prompts?: PluginPromptContribution[];
  /** PX-1: agent definitions. Resolved at startup by the agent-team
   *  loader into AgentDefinition objects (plugin-builtin layer). */
  agents?: PluginAgentContribution[];
  /** PX-3: turn-level hooks (Turn / Message / ToolCall / SubagentSpawn
   *  / StateRestore). This manifest entry carries SHELL-command hooks
   *  only; in-process hooks register through ctx.hooks.register at
   *  activate time. See src/plugin-hooks/ and 내부 문서 `PLUGIN-HOOKS`. */
  hooks?: PluginHookContribution[];
  /** PX-4: declarative missions — goal + evaluator (shell command
   *  "done yet?"). Runtime wires each entry as a Turn hook so
   *  evaluation rides the normal LLM turn loop. See
   *  src/plugin-missions/ and 내부 문서 `PLUGIN-MISSIONS-WORKFLOWS`. */
  missions?: MissionDefinition[];
  /** PX-5: keyword → skill/agent/workflow/mission routing. Advisory —
   *  the Turn hook injects a banner; LLM decides whether to act. See
   *  src/plugin-routes/ and 내부 문서 `PLUGIN-ROUTES`. */
  routes?: PluginRouteContribution[];
  /** PX-4: declarative skill workflows — linear step pipeline. NOTE
   *  name collides with src/scheduler/workflow-*; the PX-4 surface
   *  lives under src/plugin-workflows/ with SkillWorkflow* types to
   *  stay distinct. */
  workflows?: SkillWorkflow[];
  /** Portable skill contributions (classifier bucket). */
  skills?: PluginNamedContribution[];
  /** Portable tool contributions (classifier bucket). Distinct from
   *  `aiTools`, which stays a rich/host-specific schema. */
  tools?: PluginNamedContribution[];
  /** Portable MCP server contributions (classifier bucket). */
  mcpServers?: PluginNamedContribution[];
  /** Portable provider contributions (classifier bucket). */
  providers?: PluginNamedContribution[];
  /** Declarative node definitions, relative to the plugin root. */
  nodes?: string[];
  /** Agent Plugins extension assets; paths remain relative to the plugin root. */
  graphs?: string[];
  vocab?: string[];
  connectors?: PluginConnectorContribution[];
}

export interface PluginConnectorContribution {
  id: string;
  fields?: Array<{ name: string; secret?: boolean; [key: string]: unknown }>;
  userConfig?: Array<{ key: string; label?: string; secret?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Generic named contribution used by portable classifier buckets. */
export interface PluginNamedContribution {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** PX-5. One entry of `contributes.routes[]`. */
export interface PluginRouteContribution {
  id: string;
  aliases?: string[];
  target: { kind: 'agent' | 'skill' | 'workflow' | 'mission'; id: string };
  precedence?: number;
  caseInsensitive?: boolean;
  description?: string;
}

/** PX-3. One entry of `contributes.hooks[]`. Shell-only; exposes the
 *  command the host should spawn, plus event + priority + optional
 *  matcher. See src/plugin-hooks/shell-hook.ts for I/O contract. */
export interface PluginHookContribution {
  id: string;
  event: string;
  priority?: number;
  timeoutMs?: number;
  matcher?: string | string[];
  command: string;
  cwd?: string;
}

/** PX-1 Phase 4. One entry of `contributes.agents[]`. Either
 *  `systemPrompt` (inline body) or `bodyPath` (relative md file)
 *  supplies the prompt body. Other fields mirror AgentDefinition
 *  frontmatter — see src/agent-team/agent-definition.ts. */
export interface PluginAgentContribution {
  id?: string;
  name?: string;
  description?: string;
  role?: string;
  goal?: string;
  backstory?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  disallowedTools?: string[];
  /** Deprecated external compatibility input. */
  omitClaudeMd?: boolean;
  omitInheritedContext?: boolean;
  maxTurns?: number;
  isolation?: 'worktree' | 'cwd';
  background?: boolean;
  color?: string;
  systemPrompt?: string;
  bodyPath?: string;
}

export interface PluginPromptContribution {
  id: string;
  name?: string;
  scope?: PromptScope;
  kind?: PromptKind;
  targetSlot?: PromptTargetSlot;
  path?: string;
  content?: string;
  description?: string;
  tags?: string[];
  triggers?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}

export interface PluginAIToolContribution {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  schema?: string;
  handler?: string;
}

export interface PluginWidgetContribution {
  type: string;
  entry?: string;
  description?: string;
  title?: string;
  defaultCharacter?: string;
  canFocus?: boolean;
}

export interface PluginPaneContribution {
  id: string;
  widget: string;
  title?: string;
  config?: Record<string, unknown>;
  canFocus?: boolean;
}

export type PluginViewContribution = Record<string, unknown> & { id: string };

export interface PluginModalContribution {
  id: string;
  widget: string;
  title?: string;
  size?: { width: number; height: number };
  position?: 'center' | { row: number; col: number };
  config?: Record<string, unknown>;
}

export interface PluginTaskContribution {
  id: string;
  label?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  kind?: 'pty' | 'batch' | 'background';
  reveal?: 'always' | 'silent' | 'never';
  hide?: 'always' | 'never' | 'onSuccess';
  placement?: 'preview' | 'scratch' | 'modal' | 'split';
  allowConcurrentRuns?: boolean;
  reevaluateContext?: boolean;
  requiresTrust?: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  main: string;
  activationEvents: string[];
  contributes: PluginManifestContributes;
  capabilities: PluginCapability[];
  dependencies?: {
    widgets?: string[];
    plugins?: string[];
  };
  source?: PluginSource;
  /** PX-6: opt-in multi-active flag. When true, plugin-host lets
   *  this plugin coexist with other allowMultiActive peers. Default
   *  false → legacy single-active mode (preserves existing
   *  sync / consensus-trader behaviour). */
  allowMultiActive?: boolean;
  /** PX-6: coexistence allow/deny lists evaluated at activate. A
   *  peer plugin id in `deny` blocks activation; when `allow` is
   *  non-empty it acts as an allowlist (peers outside it are
   *  blocked). */
  activePeerCompat?: {
    allow?: string[];
    deny?: string[];
  };
  /** PX-6: per-plugin advisory counters. Host tracks usage +
   *  surfaces toast on cap breach; the plugin itself must respect
   *  the limit — hard enforcement lives in a later sandbox sprint
   *  (DD-PX-14). */
  resourceQuota?: PluginResourceQuota;
}

export interface PluginResourceQuota {
  ptySpawns?: number;
  concurrentSubagents?: number;
  tokensPerTurn?: number;
}

export interface PluginManifestLoadResult {
  manifest: PluginManifest;
  path: string | null;
  inferred: boolean;
}

const MANIFEST_FILES = ['plugin.json', join('.elanous-plugin', 'plugin.json'), join('.codex-plugin', 'plugin.json')];

export function loadPluginManifestFromDir(
  pluginDir: string,
  fallback: { id: string; name?: string; version?: string; description?: string; main?: string },
): PluginManifestLoadResult {
  for (const rel of MANIFEST_FILES) {
    const path = join(pluginDir, rel);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`${rel}: invalid JSON: ${err?.message || err}`);
    }
    return {
      manifest: parsePluginManifest(json, {
        fallbackId: fallback.id,
        fallbackMain: fallback.main ?? './plugin.ts',
        agentPlugin: rel === join('.codex-plugin', 'plugin.json'),
      }),
      path,
      inferred: false,
    };
  }

  const id = normalizeId(fallback.id, 'id');
  return {
    manifest: {
      id,
      name: fallback.name ?? id,
      version: fallback.version ?? '0.0.0',
      description: fallback.description,
      main: fallback.main ?? './plugin.ts',
      activationEvents: ['onCommand'],
      contributes: {},
      capabilities: [],
    },
    path: null,
    inferred: true,
  };
}

export function parsePluginManifest(
  value: unknown,
  opts: { fallbackId?: string; fallbackMain?: string; agentPlugin?: boolean } = {},
): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin manifest must be an object');
  }
  const raw = value as Record<string, unknown>;
  const agentPlugin = opts.agentPlugin === true
    || (typeof raw.$schema === 'string' && raw.$schema.startsWith('https://agentplugins.dev/'));
  const id = normalizeId(stringOr(raw.id, (agentPlugin || opts.fallbackId === undefined)
    && typeof raw.name === 'string' && raw.name.trim() ? raw.name : opts.fallbackId), 'id');
  const name = stringOr(raw.name, id);
  const version = stringOr(raw.version, '0.0.0');
  const main = normalizeMain(stringOr(raw.main, opts.fallbackMain ?? './plugin.ts'));
  const activationEvents = stringArrayOr(raw.activationEvents, ['onCommand']);
  const extension = parseElanousExtension(raw.extensions);
  const contributes = parseContributes({ ...extension.contributes, ...objectOrEmpty(raw.contributes, 'contributes') });
  const capabilities = parseCapabilities(raw.capabilities === undefined
    ? extension.capabilities
    : extension.capabilities === undefined
      ? raw.capabilities
      : [...parseCapabilities(raw.capabilities), ...parseCapabilities(extension.capabilities)]);
  const dependencies = parseDependencies(raw.dependencies);
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const allowMultiActive = typeof raw.allowMultiActive === 'boolean' ? raw.allowMultiActive : undefined;
  const activePeerCompat = parseActivePeerCompat(raw.activePeerCompat);
  const resourceQuota = parseResourceQuota(raw.resourceQuota);
  return {
    id,
    name,
    version,
    ...(description ? { description } : {}),
    main,
    activationEvents,
    contributes,
    capabilities,
    ...(dependencies ? { dependencies } : {}),
    ...(allowMultiActive !== undefined ? { allowMultiActive } : {}),
    ...(activePeerCompat ? { activePeerCompat } : {}),
    ...(resourceQuota ? { resourceQuota } : {}),
  };
}

function objectOrEmpty(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseElanousExtension(value: unknown): { contributes: Record<string, unknown>; capabilities?: unknown } {
  const extensions = objectOrEmpty(value, 'extensions');
  const extension = objectOrEmpty(extensions['ai.elanous'], 'extensions["ai.elanous"]');
  const contributes = objectOrEmpty(extension.contributes, 'extensions["ai.elanous"].contributes');
  return {
    contributes: {
      ...contributes,
      ...Object.fromEntries(['nodes', 'graphs', 'vocab', 'connectors'].filter(key => extension[key] !== undefined)
        .map(key => [key, extension[key]])),
    },
    capabilities: extension.capabilities,
  };
}

function parseActivePeerCompat(value: unknown): PluginManifest['activePeerCompat'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('activePeerCompat must be an object with allow and/or deny arrays');
  }
  const raw = value as Record<string, unknown>;
  const allow = Array.isArray(raw.allow)
    ? raw.allow.filter((v): v is string => typeof v === 'string')
    : undefined;
  const deny = Array.isArray(raw.deny)
    ? raw.deny.filter((v): v is string => typeof v === 'string')
    : undefined;
  const out = {
    ...(allow && allow.length > 0 ? { allow } : {}),
    ...(deny && deny.length > 0 ? { deny } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseResourceQuota(value: unknown): PluginManifest['resourceQuota'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('resourceQuota must be an object');
  }
  const raw = value as Record<string, unknown>;
  const result: PluginResourceQuota = {};
  for (const axis of ['ptySpawns', 'concurrentSubagents', 'tokensPerTurn'] as const) {
    const v = raw[axis];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`resourceQuota.${axis} must be a non-negative number`);
    }
    result[axis] = Math.floor(v);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function manifestRequiredWidgets(manifest: PluginManifest): string[] {
  return [...new Set([...(manifest.dependencies?.widgets ?? [])].filter(Boolean))];
}

function parseContributes(value: unknown): PluginManifestContributes {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('contributes must be an object');
  }
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.commands !== undefined ? { commands: parseCommands(raw.commands) } : {}),
    ...(raw.keybindings !== undefined ? { keybindings: parseKeybindings(raw.keybindings) } : {}),
    ...(raw.widgets !== undefined ? { widgets: parseWidgets(raw.widgets) } : {}),
    ...(raw.panes !== undefined ? { panes: parsePanes(raw.panes) } : {}),
    ...(raw.views !== undefined ? { views: parseViews(raw.views) } : {}),
    ...(raw.modals !== undefined ? { modals: parseModals(raw.modals) } : {}),
    ...(raw.themes !== undefined ? { themes: parseThemes(raw.themes) } : {}),
    ...(raw.tasks !== undefined ? { tasks: parseTasks(raw.tasks) } : {}),
    ...(raw.aiTools !== undefined ? { aiTools: parseAiTools(raw.aiTools) } : {}),
    ...(raw.prompts !== undefined ? { prompts: parsePrompts(raw.prompts) } : {}),
    ...(raw.agents !== undefined ? { agents: parseAgents(raw.agents) } : {}),
    ...(raw.hooks !== undefined ? { hooks: parseHooks(raw.hooks) } : {}),
    ...(raw.missions !== undefined ? { missions: parseMissions(raw.missions) } : {}),
    ...(raw.routes !== undefined ? { routes: parseRoutes(raw.routes) } : {}),
    ...(raw.workflows !== undefined ? { workflows: parseWorkflows(raw.workflows) } : {}),
    ...(raw.skills !== undefined ? { skills: parseNamedContributions(raw.skills, 'contributes.skills') } : {}),
    ...(raw.tools !== undefined ? { tools: parseNamedContributions(raw.tools, 'contributes.tools') } : {}),
    ...(raw.mcpServers !== undefined ? { mcpServers: parseNamedContributions(raw.mcpServers, 'contributes.mcpServers') } : {}),
    ...(raw.providers !== undefined ? { providers: parseNamedContributions(raw.providers, 'contributes.providers') } : {}),
    ...(raw.nodes !== undefined ? { nodes: parseNodePaths(raw.nodes) } : {}),
    ...(raw.graphs !== undefined ? { graphs: parseAssetPaths(raw.graphs, 'contributes.graphs') } : {}),
    ...(raw.vocab !== undefined ? { vocab: parseAssetPaths(raw.vocab, 'contributes.vocab') } : {}),
    ...(raw.connectors !== undefined ? { connectors: parseConnectors(raw.connectors) } : {}),
  };
}

const ROUTE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROUTE_TARGET_KINDS = new Set(['agent', 'skill', 'workflow', 'mission']);

function parseRoutes(value: unknown): PluginRouteContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.routes must be an array');
  const seenIds = new Set<string>();
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`contributes.routes[${idx}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const label = `contributes.routes[${idx}]`;
    if (typeof raw.id !== 'string' || !ROUTE_ID_RE.test(raw.id)) {
      throw new Error(`${label}.id must match ${ROUTE_ID_RE} (got ${JSON.stringify(raw.id)})`);
    }
    if (seenIds.has(raw.id)) {
      throw new Error(`${label}.id '${raw.id}' is duplicated`);
    }
    seenIds.add(raw.id);
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter((a): a is string => typeof a === 'string')
      : undefined;
    if (aliases) {
      for (const a of aliases) {
        if (!ROUTE_ID_RE.test(a)) {
          throw new Error(`${label}.aliases entry '${a}' must match ${ROUTE_ID_RE}`);
        }
      }
    }
    const target = raw.target as { kind?: unknown; id?: unknown } | undefined;
    if (!target || typeof target !== 'object') {
      throw new Error(`${label}.target is required (object with kind + id)`);
    }
    if (typeof target.kind !== 'string' || !ROUTE_TARGET_KINDS.has(target.kind)) {
      throw new Error(`${label}.target.kind must be one of ${[...ROUTE_TARGET_KINDS].join(' | ')}`);
    }
    if (typeof target.id !== 'string' || !target.id.trim()) {
      throw new Error(`${label}.target.id is required (non-empty string)`);
    }
    const precedence = typeof raw.precedence === 'number' && Number.isFinite(raw.precedence)
      ? raw.precedence
      : undefined;
    if (precedence !== undefined && (precedence < 0 || precedence > 999)) {
      throw new Error(`${label}.precedence must be in [0, 999]`);
    }
    return {
      id: raw.id,
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
      target: {
        kind: target.kind as 'agent' | 'skill' | 'workflow' | 'mission',
        id: target.id.trim(),
      },
      ...(precedence !== undefined ? { precedence } : {}),
      ...(typeof raw.caseInsensitive === 'boolean' ? { caseInsensitive: raw.caseInsensitive } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    };
  });
}

const HOOK_EVENT_NAMES = new Set(['Turn', 'Message', 'ToolCall', 'SubagentSpawn', 'StateRestore']);

function parseHooks(value: unknown): PluginHookContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.hooks must be an array');
  const seenIds = new Set<string>();
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`contributes.hooks[${idx}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new Error(`contributes.hooks[${idx}] requires a non-empty 'id'`);
    }
    const id = raw.id.trim();
    if (seenIds.has(id)) {
      throw new Error(`contributes.hooks[${idx}].id '${id}' is duplicated`);
    }
    seenIds.add(id);
    if (typeof raw.event !== 'string' || !HOOK_EVENT_NAMES.has(raw.event)) {
      throw new Error(
        `contributes.hooks[${idx}].event must be one of ${[...HOOK_EVENT_NAMES].join(' | ')}`,
      );
    }
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      throw new Error(`contributes.hooks[${idx}].command is required (this release only supports shell hooks)`);
    }
    const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority)
      ? raw.priority : undefined;
    const timeoutMs = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? raw.timeoutMs : undefined;
    let matcher: string | string[] | undefined;
    if (typeof raw.matcher === 'string') matcher = raw.matcher;
    else if (Array.isArray(raw.matcher)) matcher = raw.matcher.filter((m): m is string => typeof m === 'string');
    return {
      id,
      event: raw.event,
      ...(priority !== undefined ? { priority } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(matcher !== undefined ? { matcher } : {}),
      command: raw.command.trim(),
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    };
  });
}

// ── PX-4 P2: missions + workflows parsers ──────────────────────────────

const MISSION_KEEP_POLICIES = new Set<MissionKeepPolicy>([
  'pass_only', 'score_improvement', 'never',
]);

const MISSION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Reject manifest-relative paths that escape the plugin root via
 *  `..` segments or absolute form. The plugin-host later resolves
 *  these relative to the plugin dir; this guard just prevents
 *  obvious traversal attempts at manifest-parse time. */
function validatePluginRelativePath(raw: string, fieldLabel: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`${fieldLabel} must be a non-empty string`);
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`${fieldLabel} must be relative to the plugin dir (got "${raw}")`);
  }
  const segments = raw.split(/[\\/]/);
  if (segments.some(s => s === '..')) {
    throw new Error(`${fieldLabel} must not contain '..' segments (got "${raw}")`);
  }
  return raw;
}

function parseMissions(value: unknown): MissionDefinition[] {
  if (!Array.isArray(value)) throw new Error('contributes.missions must be an array');
  const seenIds = new Set<string>();
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`contributes.missions[${idx}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const label = `contributes.missions[${idx}]`;
    if (typeof raw.id !== 'string' || !MISSION_ID_RE.test(raw.id)) {
      throw new Error(`${label}.id must match ${MISSION_ID_RE} (got ${JSON.stringify(raw.id)})`);
    }
    if (seenIds.has(raw.id)) {
      throw new Error(`${label}.id '${raw.id}' is duplicated`);
    }
    seenIds.add(raw.id);
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error(`${label}.name is required (non-empty string)`);
    }
    const goalPath = validatePluginRelativePath(
      String(raw.goalPath),
      `${label}.goalPath`,
    );
    const sandboxPath = validatePluginRelativePath(
      String(raw.sandboxPath),
      `${label}.sandboxPath`,
    );
    const evaluator = parseMissionEvaluator(raw.evaluator, `${label}.evaluator`);
    const keepPolicy = raw.keepPolicy as MissionKeepPolicy;
    if (!MISSION_KEEP_POLICIES.has(keepPolicy)) {
      throw new Error(
        `${label}.keepPolicy must be one of ${[...MISSION_KEEP_POLICIES].join(' | ')}`,
      );
    }
    const maxIterationsRaw = typeof raw.maxIterations === 'number'
      ? raw.maxIterations
      : MISSION_DEFAULTS.maxIterations;
    if (!Number.isFinite(maxIterationsRaw) || maxIterationsRaw < 1) {
      throw new Error(`${label}.maxIterations must be a positive integer`);
    }
    const maxIterations = Math.min(
      Math.floor(maxIterationsRaw),
      MISSION_DEFAULTS.maxIterationsMax,
    );
    const cadence = parseMissionCadence(raw.cadence, `${label}.cadence`);
    return {
      id: raw.id,
      name: raw.name.trim(),
      goalPath,
      sandboxPath,
      evaluator,
      keepPolicy,
      maxIterations,
      ...(cadence ? { cadence } : {}),
      ...(typeof raw.autostart === 'boolean' ? { autostart: raw.autostart } : {}),
      ...(typeof raw.onKeepRun === 'string' && raw.onKeepRun.trim()
        ? { onKeepRun: raw.onKeepRun.trim() }
        : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    };
  });
}

function parseMissionEvaluator(
  value: unknown,
  label: string,
): MissionDefinition['evaluator'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.command !== 'string' || !raw.command.trim()) {
    throw new Error(`${label}.command is required (non-empty string)`);
  }
  if (raw.format !== 'json') {
    throw new Error(`${label}.format must be 'json' (v1 only supports JSON evaluators)`);
  }
  let timeoutMs = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
    ? raw.timeoutMs
    : MISSION_DEFAULTS.evaluatorTimeoutMs;
  timeoutMs = Math.max(
    MISSION_DEFAULTS.evaluatorTimeoutMinMs,
    Math.min(timeoutMs, MISSION_DEFAULTS.evaluatorTimeoutMaxMs),
  );
  return {
    command: raw.command.trim(),
    format: 'json',
    timeoutMs,
    ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
  };
}

function parseMissionCadence(
  value: unknown,
  label: string,
): MissionDefinition['cadence'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object or omitted`);
  }
  const raw = value as Record<string, unknown>;
  const everyNTurnRaw = typeof raw.everyNTurn === 'number' ? raw.everyNTurn : undefined;
  if (everyNTurnRaw !== undefined) {
    if (!Number.isFinite(everyNTurnRaw) || everyNTurnRaw < 1) {
      throw new Error(`${label}.everyNTurn must be a positive integer`);
    }
    return { everyNTurn: Math.floor(everyNTurnRaw) };
  }
  return undefined;
}

const WORKFLOW_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const WORKFLOW_STEP_KINDS = new Set<WorkflowStepKind>([
  'agent', 'skill', 'tool', 'askUser',
]);

const WORKFLOW_ON_ERROR = new Set<WorkflowStepOnError>([
  'retry', 'skip', 'abort', 'ask',
]);

function parseWorkflows(value: unknown): SkillWorkflow[] {
  if (!Array.isArray(value)) throw new Error('contributes.workflows must be an array');
  const seenIds = new Set<string>();
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`contributes.workflows[${idx}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const label = `contributes.workflows[${idx}]`;
    if (typeof raw.id !== 'string' || !WORKFLOW_ID_RE.test(raw.id)) {
      throw new Error(`${label}.id must match ${WORKFLOW_ID_RE} (got ${JSON.stringify(raw.id)})`);
    }
    if (seenIds.has(raw.id)) {
      throw new Error(`${label}.id '${raw.id}' is duplicated`);
    }
    seenIds.add(raw.id);
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error(`${label}.name is required (non-empty string)`);
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      throw new Error(`${label}.steps must be a non-empty array`);
    }
    if (raw.steps.length > WORKFLOW_DEFAULTS.maxStepsPerWorkflow) {
      throw new Error(
        `${label}.steps length ${raw.steps.length} exceeds cap ${WORKFLOW_DEFAULTS.maxStepsPerWorkflow}`,
      );
    }
    const steps = raw.steps.map((s, sidx) => parseWorkflowStep(s, `${label}.steps[${sidx}]`));
    const triggers = raw.triggers === undefined
      ? undefined
      : stringArrayOr(raw.triggers, []);
    return {
      id: raw.id,
      name: raw.name.trim(),
      ...(triggers ? { triggers } : {}),
      ...(typeof raw.argumentHint === 'string' ? { argumentHint: raw.argumentHint } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      steps,
    };
  });
}

function parseWorkflowStep(value: unknown, label: string): SkillWorkflowStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind as WorkflowStepKind;
  if (!WORKFLOW_STEP_KINDS.has(kind)) {
    throw new Error(`${label}.kind must be one of ${[...WORKFLOW_STEP_KINDS].join(' | ')}`);
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new Error(`${label}.id is required (non-empty string)`);
  }
  const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)
    ? raw.args as Record<string, unknown>
    : undefined;
  const onError = typeof raw.onError === 'string' && WORKFLOW_ON_ERROR.has(raw.onError as WorkflowStepOnError)
    ? raw.onError as WorkflowStepOnError
    : undefined;
  const maxRetriesRaw = typeof raw.maxRetries === 'number' ? raw.maxRetries : undefined;
  let maxRetries: number | undefined;
  if (maxRetriesRaw !== undefined) {
    if (!Number.isFinite(maxRetriesRaw) || maxRetriesRaw < 0) {
      throw new Error(`${label}.maxRetries must be a non-negative integer`);
    }
    maxRetries = Math.min(Math.floor(maxRetriesRaw), WORKFLOW_DEFAULTS.maxRetriesCeiling);
  }
  const handoff = parseWorkflowHandoff(raw.handoff, `${label}.handoff`);
  return {
    kind,
    id: raw.id.trim(),
    ...(args ? { args } : {}),
    ...(handoff ? { handoff } : {}),
    ...(onError ? { onError } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
}

function parseWorkflowHandoff(
  value: unknown,
  label: string,
): SkillWorkflowStep['handoff'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object or omitted`);
  }
  const raw = value as Record<string, unknown>;
  const outputPath = typeof raw.outputPath === 'string' && raw.outputPath.trim()
    ? raw.outputPath.trim()
    : undefined;
  if (outputPath && (outputPath.startsWith('/') || outputPath.includes('..'))) {
    throw new Error(`${label}.outputPath must be a plain relative filename (no '..', no absolute)`);
  }
  const passToNext = Array.isArray(raw.passToNext)
    ? raw.passToNext.filter((k): k is string => typeof k === 'string')
    : undefined;
  if (!outputPath && (!passToNext || passToNext.length === 0)) {
    return undefined;   // empty handoff block — treat as omitted
  }
  return {
    ...(outputPath ? { outputPath } : {}),
    ...(passToNext && passToNext.length > 0 ? { passToNext } : {}),
  };
}

function parseAgents(value: unknown): PluginAgentContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.agents must be an array');
  const seen = new Set<string>();
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`contributes.agents[${idx}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const hasInline = typeof raw.systemPrompt === 'string';
    const hasBodyPath = typeof raw.bodyPath === 'string';
    if (hasInline && hasBodyPath) {
      throw new Error(`contributes.agents[${idx}] cannot define both systemPrompt and bodyPath`);
    }
    if (!hasInline && !hasBodyPath) {
      throw new Error(`contributes.agents[${idx}] requires systemPrompt or bodyPath`);
    }
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    if (id) {
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        throw new Error(`contributes.agents[${idx}].id must match [a-z][a-z0-9-]*`);
      }
      if (seen.has(id)) throw new Error(`contributes.agents[${idx}].id '${id}' is duplicated`);
      seen.add(id);
    } else if (hasInline) {
      throw new Error(`contributes.agents[${idx}] inline entry requires id`);
    }

    const tools = raw.tools !== undefined ? stringArrayOr(raw.tools, []) : undefined;
    const disallowed = raw.disallowedTools !== undefined ? stringArrayOr(raw.disallowedTools, []) : undefined;

    return {
      ...(id ? { id } : {}),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.role === 'string' ? { role: raw.role } : {}),
      ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
      ...(typeof raw.backstory === 'string' ? { backstory: raw.backstory } : {}),
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      ...(typeof raw.permissionMode === 'string' ? { permissionMode: raw.permissionMode } : {}),
      ...(tools ? { tools } : {}),
      ...(disallowed ? { disallowedTools: disallowed } : {}),
      ...(typeof raw.omitInheritedContext === 'boolean'
        ? { omitInheritedContext: raw.omitInheritedContext }
        : typeof raw.omitClaudeMd === 'boolean'
          ? { omitInheritedContext: raw.omitClaudeMd }
          : {}),
      ...(typeof raw.maxTurns === 'number' ? { maxTurns: raw.maxTurns } : {}),
      ...(raw.isolation === 'worktree' || raw.isolation === 'cwd' ? { isolation: raw.isolation } : {}),
      ...(typeof raw.background === 'boolean' ? { background: raw.background } : {}),
      ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
      ...(hasInline ? { systemPrompt: String(raw.systemPrompt) } : {}),
      ...(hasBodyPath ? { bodyPath: String(raw.bodyPath) } : {}),
    };
  });
}

function parseCommands(value: unknown): PluginManifestContributes['commands'] {
  if (!Array.isArray(value)) throw new Error('contributes.commands must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.commands[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    const name = normalizeId(stringOr(raw.name), `contributes.commands[${idx}].name`);
    const description = stringOr(raw.description, '');
    const aliases = raw.aliases === undefined ? undefined : stringArrayOr(raw.aliases, []);
    const hidden = typeof raw.hidden === 'boolean' ? raw.hidden : undefined;
    return {
      name,
      description,
      ...(aliases ? { aliases } : {}),
      ...(hidden !== undefined ? { hidden } : {}),
    };
  });
}

function parseKeybindings(value: unknown): Keybinding[] {
  if (!Array.isArray(value)) throw new Error('contributes.keybindings must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.keybindings[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    const key = stringOr(raw.key);
    const command = stringOr(raw.command);
    const whenRaw = raw.when;
    const when = whenRaw === 'global' || whenRaw === 'focused' ? whenRaw : undefined;
    return { key, command, ...(when ? { when } : {}) };
  });
}

function parseWidgets(value: unknown): PluginWidgetContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.widgets must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.widgets[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    const type = normalizeId(stringOr(raw.type), `contributes.widgets[${idx}].type`);
    const entry = typeof raw.entry === 'string' ? normalizeMain(raw.entry) : undefined;
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    return {
      type,
      ...(entry ? { entry } : {}),
      ...(description ? { description } : {}),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.defaultCharacter === 'string' ? { defaultCharacter: raw.defaultCharacter } : {}),
      ...(typeof raw.canFocus === 'boolean' ? { canFocus: raw.canFocus } : {}),
    };
  });
}

function parsePanes(value: unknown): PluginPaneContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.panes must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.panes[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    return {
      id: normalizeId(stringOr(raw.id), `contributes.panes[${idx}].id`),
      widget: normalizeId(stringOr(raw.widget), `contributes.panes[${idx}].widget`),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? { config: raw.config as Record<string, unknown> } : {}),
      ...(typeof raw.canFocus === 'boolean' ? { canFocus: raw.canFocus } : {}),
    };
  });
}

function parseViews(value: unknown): PluginViewContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.views must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.views[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    return {
      ...raw,
      id: normalizeId(stringOr(raw.id), `contributes.views[${idx}].id`),
    } as PluginViewContribution;
  });
}

function parseModals(value: unknown): PluginModalContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.modals must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.modals[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    return {
      id: normalizeId(stringOr(raw.id), `contributes.modals[${idx}].id`),
      widget: normalizeId(stringOr(raw.widget), `contributes.modals[${idx}].widget`),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(raw.size !== undefined ? { size: parseSize(raw.size, `contributes.modals[${idx}].size`) } : {}),
      ...(raw.position !== undefined ? { position: parseModalPosition(raw.position, `contributes.modals[${idx}].position`) } : {}),
      ...(raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? { config: raw.config as Record<string, unknown> } : {}),
    };
  });
}

function parseThemes(value: unknown): NonNullable<PluginManifestContributes['themes']> {
  if (!Array.isArray(value)) throw new Error('contributes.themes must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.themes[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    return {
      id: normalizeId(stringOr(raw.id), `contributes.themes[${idx}].id`),
      path: stringOr(raw.path),
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    };
  });
}

function parseNodePaths(value: unknown): string[] {
  const label = 'contributes.nodes';
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, idx) => {
    const field = `${label}[${idx}]`;
    if (typeof item !== 'string' || !item.startsWith('./') || item.length <= 2 || item.includes('\0')) {
      throw new Error(`${field} must be a path starting with ./ inside the plugin dir`);
    }
    return validatePluginRelativePath(item, field);
  });
}

function parseAssetPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, idx) => {
    if (typeof item !== 'string') throw new Error(`${label}[${idx}] must be a path`);
    return validatePluginRelativePath(item, `${label}[${idx}]`);
  });
}

function parseConnectors(value: unknown): PluginConnectorContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.connectors must be an array');
  const seen = new Set<string>();
  return value.map((item, idx) => {
    const label = `contributes.connectors[${idx}]`;
    const raw = objectOrEmpty(item, label);
    const id = normalizeId(stringOr(raw.id), `${label}.id`);
    if (seen.has(id)) throw new Error(`${label}.id '${id}' is duplicated`);
    seen.add(id);
    const fields = raw.fields === undefined ? undefined : parseConnectorFields(raw.fields, `${label}.fields`, 'name');
    const userConfig = raw.userConfig === undefined ? undefined : parseConnectorFields(raw.userConfig, `${label}.userConfig`, 'key');
    return { ...raw, id, ...(fields ? { fields } : {}), ...(userConfig ? { userConfig } : {}) } as PluginConnectorContribution;
  });
}

function parseConnectorFields(value: unknown, label: string, key: 'name' | 'key') {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, idx) => {
    const raw = objectOrEmpty(item, `${label}[${idx}]`);
    const field = stringOr(raw[key]);
    if (raw.secret !== undefined && typeof raw.secret !== 'boolean') throw new Error(`${label}[${idx}].secret must be a boolean`);
    if (key === 'key' && raw.label !== undefined && typeof raw.label !== 'string') {
      throw new Error(`${label}[${idx}].label must be a string`);
    }
    return { ...raw, [key]: field };
  });
}

function parseNamedContributions(value: unknown, label: string): PluginNamedContribution[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, idx) => {
    if (typeof item === 'string') {
      const name = item.trim();
      if (!name) throw new Error(`${label}[${idx}] must be a non-empty string`);
      return { name };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${idx}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined;
    return {
      ...raw,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
    };
  });
}

function parseAiTools(value: unknown): PluginAIToolContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.aiTools must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.aiTools[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    const parameters = (raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters))
      ? raw.parameters as Record<string, unknown>
      : undefined;
    const schema = typeof raw.schema === 'string' ? normalizeMain(raw.schema) : undefined;
    if (parameters && schema) throw new Error(`contributes.aiTools[${idx}] cannot define both parameters and schema`);
    return {
      name: normalizeId(stringOr(raw.name), `contributes.aiTools[${idx}].name`),
      description: stringOr(raw.description, ''),
      ...(parameters ? { parameters } : {}),
      ...(schema ? { schema } : {}),
      ...(typeof raw.handler === 'string' ? { handler: normalizeMain(raw.handler) } : {}),
    };
  });
}

function parsePrompts(value: unknown): PluginPromptContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.prompts must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.prompts[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    const path = typeof raw.path === 'string' ? normalizeMain(raw.path) : undefined;
    const content = typeof raw.content === 'string' ? raw.content : undefined;
    if (!path && !content) throw new Error(`contributes.prompts[${idx}] requires path or content`);
    return {
      id: normalizeId(stringOr(raw.id), `contributes.prompts[${idx}].id`),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.scope === 'string' ? { scope: raw.scope as PromptScope } : {}),
      ...(typeof raw.kind === 'string' ? { kind: raw.kind as PromptKind } : {}),
      ...(typeof raw.targetSlot === 'string' ? { targetSlot: raw.targetSlot as PromptTargetSlot } : {}),
      ...(path ? { path } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(raw.tags !== undefined ? { tags: stringArrayOr(raw.tags, []) } : {}),
      ...(raw.triggers && typeof raw.triggers === 'object' && !Array.isArray(raw.triggers) ? { triggers: raw.triggers as Record<string, unknown> } : {}),
      ...(raw.constraints && typeof raw.constraints === 'object' && !Array.isArray(raw.constraints) ? { constraints: raw.constraints as Record<string, unknown> } : {}),
      ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? { metadata: raw.metadata as Record<string, unknown> } : {}),
      ...(typeof raw.priority === 'number' ? { priority: raw.priority } : {}),
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    };
  });
}

function parseTasks(value: unknown): PluginTaskContribution[] {
  if (!Array.isArray(value)) throw new Error('contributes.tasks must be an array');
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`contributes.tasks[${idx}] must be an object`);
    const raw = item as Record<string, unknown>;
    const kind = oneOf(raw.kind, ['pty', 'batch', 'background'] as const, undefined);
    const reveal = oneOf(raw.reveal, ['always', 'silent', 'never'] as const, undefined);
    const hide = oneOf(raw.hide, ['always', 'never', 'onSuccess'] as const, undefined);
    const placement = oneOf(raw.placement, ['preview', 'scratch', 'modal', 'split'] as const, undefined);
    return {
      id: normalizeId(stringOr(raw.id), `contributes.tasks[${idx}].id`),
      command: stringOr(raw.command),
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      ...(raw.args !== undefined ? { args: stringArrayOr(raw.args, []) } : {}),
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
      ...(raw.env !== undefined ? { env: parseStringRecord(raw.env, `contributes.tasks[${idx}].env`) } : {}),
      ...(kind ? { kind } : {}),
      ...(reveal ? { reveal } : {}),
      ...(hide ? { hide } : {}),
      ...(placement ? { placement } : {}),
      ...(typeof raw.allowConcurrentRuns === 'boolean' ? { allowConcurrentRuns: raw.allowConcurrentRuns } : {}),
      ...(typeof raw.reevaluateContext === 'boolean' ? { reevaluateContext: raw.reevaluateContext } : {}),
      ...(typeof raw.requiresTrust === 'boolean' ? { requiresTrust: raw.requiresTrust } : {}),
    };
  });
}

function parseCapabilities(value: unknown): PluginCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('capabilities must be an array');
  return value.map((item, idx) => {
    if (typeof item === 'string') return { kind: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`capabilities[${idx}] must be a string or object`);
    const raw = item as Record<string, unknown>;
    return { ...raw, kind: stringOr(raw.kind) } as PluginCapability;
  });
}

function parseDependencies(value: unknown): PluginManifest['dependencies'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dependencies must be an object');
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.widgets !== undefined ? { widgets: stringArrayOr(raw.widgets, []) } : {}),
    ...(raw.plugins !== undefined ? { plugins: stringArrayOr(raw.plugins, []) } : {}),
  };
}

function stringOr(value: unknown, fallback?: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (fallback !== undefined && fallback.trim() !== '') return fallback.trim();
  throw new Error('expected non-empty string');
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error('expected string array');
  return value.map((item, idx) => {
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`expected non-empty string at index ${idx}`);
    return item.trim();
  });
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

function parseSize(value: unknown, label: string): { width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.width !== 'number' || typeof raw.height !== 'number') throw new Error(`${label}.width and ${label}.height must be numbers`);
  return { width: raw.width, height: raw.height };
}

function parseModalPosition(value: unknown, label: string): 'center' | { row: number; col: number } {
  if (value === 'center') return 'center';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be "center" or an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.row !== 'number' || typeof raw.col !== 'number') throw new Error(`${label}.row and ${label}.col must be numbers`);
  return { row: raw.row, col: raw.col };
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number] | undefined): T[number] | undefined {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`expected one of: ${allowed.join(', ')}`);
}

function normalizeId(value: string, label: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) {
    throw new Error(`${label}: invalid id "${value}"`);
  }
  return id;
}

function normalizeMain(value: string): string {
  if (value.includes('\0') || value.startsWith('/') || value.includes('..')) {
    throw new Error(`main: unsafe path "${value}"`);
  }
  return value.startsWith('./') ? value : `./${value}`;
}
