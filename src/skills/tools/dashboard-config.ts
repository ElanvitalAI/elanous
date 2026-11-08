import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tools: DashboardConfigGet + DashboardConfigSet — T6-K4.
//
// Read and (with approval) write a curated subset of dashboard
// config keys from control mode. The allow-list is
// intentionally narrow: only user-facing UI toggles that are safe
// to change mid-session without requiring a restart.
//
// Sensitive knobs (api keys, provider credentials, plugin roots,
// memory paths) are NOT in the allow-list. The LLM should ask the
// user to run `elanous configure` or edit the config file directly.
//
// Schema:
//
//   DashboardConfigGet({ key }) → { value, meta }
//   DashboardConfigSet({ key, value }) → { ok, oldValue, newValue }
//     • Set requires an approver (reuses T1-P2 approval modal
//       pattern) — fail-closed when no approver is wired.



export type ConfigKey =
  | 'dashboard.chatOnlyMode'
  | 'dashboard.promptBank.budgetTokens'
  | 'dashboard.promptBank.dashboardTurns'
  | 'dashboard.promptBank.enabled'
  | 'dashboard.promptBank.limit'
  | 'dashboard.promptBank.record'
  | 'dashboard.promptBank.skillRuns'
  | 'dashboard.theme.active'
  | 'input.maxLines'
  | 'preview.source'
  | 'workingDir.showHidden'
  | 'workingDir.sortMode';

export const CONFIG_KEYS: readonly ConfigKey[] = Object.freeze([
  'dashboard.chatOnlyMode',
  'dashboard.promptBank.budgetTokens',
  'dashboard.promptBank.dashboardTurns',
  'dashboard.promptBank.enabled',
  'dashboard.promptBank.limit',
  'dashboard.promptBank.record',
  'dashboard.promptBank.skillRuns',
  'dashboard.theme.active',
  'input.maxLines',
  'preview.source',
  'workingDir.showHidden',
  'workingDir.sortMode',
]);

export interface ConfigKeyMeta {
  type: 'boolean' | 'string' | 'integer' | 'enum';
  enumValues?: readonly string[];
  description: string;
  /** Per-key limits applied before write (tests bypass by
   *  passing them in explicitly). */
  min?: number;
  max?: number;
}

export const CONFIG_META: Record<ConfigKey, ConfigKeyMeta> = {
  'dashboard.chatOnlyMode': {
    type: 'boolean',
    description: 'Hide the 3-pane grid and make chat take the full viewport.',
  },
  'dashboard.promptBank.enabled': {
    type: 'boolean',
    description: 'Enable Prompt Bank live injection for configured dashboard and skill turns.',
  },
  'dashboard.promptBank.dashboardTurns': {
    type: 'boolean',
    description: 'Inject Prompt Bank matches into dashboard chat turns when Prompt Bank is enabled.',
  },
  'dashboard.promptBank.skillRuns': {
    type: 'boolean',
    description: 'Inject Prompt Bank matches into skill-run prompts when Prompt Bank is enabled.',
  },
  'dashboard.promptBank.budgetTokens': {
    type: 'integer',
    min: 100,
    max: 20000,
    description: 'Approximate token budget for Prompt Bank live injection.',
  },
  'dashboard.promptBank.limit': {
    type: 'integer',
    min: 1,
    max: 100,
    description: 'Maximum number of Prompt Bank entries injected into one prompt.',
  },
  'dashboard.promptBank.record': {
    type: 'boolean',
    description: 'Record eligible prompts into the Prompt Bank for later reuse.',
  },
  'dashboard.theme.active': {
    type: 'string',
    description: 'Active theme name. Must match a registered theme token set.',
  },
  'input.maxLines': {
    type: 'integer',
    min: 1,
    max: 16,
    description: 'Max rows the input prompt can grow to. 1 = single-line forever.',
  },
  'preview.source': {
    type: 'enum',
    enumValues: ['smart', 'wd', 'obsidian', 'skill'],
    description: 'Which browser the preview pane mirrors.',
  },
  'workingDir.showHidden': {
    type: 'boolean',
    description: 'Show dot-files in the browser pane listing.',
  },
  'workingDir.sortMode': {
    type: 'enum',
    enumValues: ['name', 'mtime', 'size'],
    description: 'Browser pane sort order for the file list.',
  },
};

export type ConfigGetter = (key: ConfigKey) => unknown;
export type ConfigSetter = (key: ConfigKey, value: unknown) => Promise<void>;
export type ConfigSetApprover = (req: {
  key: ConfigKey; oldValue: unknown; newValue: unknown;
}) => Promise<boolean>;

let _getter: ConfigGetter | null = null;
let _setter: ConfigSetter | null = null;
let _approver: ConfigSetApprover | null = null;

export function initDashboardConfigTools(
  getter: ConfigGetter,
  setter: ConfigSetter,
  approver?: ConfigSetApprover,
): void {
  _getter = getter;
  _setter = setter;
  _approver = approver ?? null;
}

export function _resetDashboardConfigToolsForTesting(): void {
  _getter = null;
  _setter = null;
  _approver = null;
}

export function buildDashboardConfigGetTool(): LLMToolSpec {
  return {
    name: 'DashboardConfigGet',
    description:
      'Read a dashboard config key (control mode). Allow-list: ' +
      CONFIG_KEYS.join(', ') + '. Returns the current value + metadata (type, range, enum choices).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: [...CONFIG_KEYS] },
      },
      required: ['key'],
      additionalProperties: false,
    },
  };
}

export function buildDashboardConfigSetTool(): LLMToolSpec {
  return {
    name: 'DashboardConfigSet',
    description:
      'Write a dashboard config key (control mode, T2+, requires approval). Allow-list: ' +
      CONFIG_KEYS.join(', ') + '. Validates type/range/enum before prompting the user.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: [...CONFIG_KEYS] },
        value: {
          description: 'Target value. Must match the key\'s expected type.',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  };
}

function assertKey(raw: unknown): ConfigKey {
  if (typeof raw !== 'string') throw new Error(`'key' must be a string`);
  if (!(CONFIG_KEYS as readonly string[]).includes(raw)) {
    throw new Error(`'key' must be one of: ${CONFIG_KEYS.join(', ')}. Got "${raw}".`);
  }
  return raw as ConfigKey;
}

function validateValue(key: ConfigKey, value: unknown): void {
  const meta = CONFIG_META[key];
  if (meta.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`'${key}' expects boolean; got ${typeof value}`);
  }
  if (meta.type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`'${key}' expects integer; got ${typeof value}`);
    const n = value as number;
    if (meta.min !== undefined && n < meta.min) throw new Error(`'${key}' must be ≥ ${meta.min}`);
    if (meta.max !== undefined && n > meta.max) throw new Error(`'${key}' must be ≤ ${meta.max}`);
  }
  if (meta.type === 'string' && typeof value !== 'string') {
    throw new Error(`'${key}' expects string; got ${typeof value}`);
  }
  if (meta.type === 'enum') {
    if (typeof value !== 'string' || !meta.enumValues?.includes(value)) {
      throw new Error(`'${key}' must be one of: ${meta.enumValues?.join(', ')}`);
    }
  }
}

export async function dispatchDashboardConfigGet(
  rawArgs: Record<string, unknown>,
  deps: { getter?: ConfigGetter } = {},
): Promise<{ output: string }> {
  const getter = deps.getter ?? _getter;
  if (!getter) throw new Error('DashboardConfigGet not wired — initDashboardConfigTools first.');
  const key = assertKey(rawArgs.key);
  const meta = CONFIG_META[key];
  const value = getter(key);
  const lines = [
    `DashboardConfigGet ${key}`,
    `  value: ${JSON.stringify(value)}`,
    `  type: ${meta.type}${meta.enumValues ? ' · choices: ' + meta.enumValues.join(', ') : ''}${meta.min !== undefined ? ' · min: ' + meta.min : ''}${meta.max !== undefined ? ' · max: ' + meta.max : ''}`,
    `  description: ${meta.description}`,
  ];
  return { output: lines.join('\n') };
}

export async function dispatchDashboardConfigSet(
  rawArgs: Record<string, unknown>,
  deps: {
    getter?: ConfigGetter;
    setter?: ConfigSetter;
    approver?: ConfigSetApprover;
  } = {},
): Promise<{ output: string }> {
  const getter = deps.getter ?? _getter;
  const setter = deps.setter ?? _setter;
  const approver = deps.approver ?? _approver;
  if (!getter || !setter) {
    throw new Error('DashboardConfigSet not wired — initDashboardConfigTools first.');
  }
  if (!approver) {
    throw new Error(
      'DashboardConfigSet refused — no approver is wired. This tool ' +
      'requires explicit user approval; the dashboard provides it at runtime.',
    );
  }
  const key = assertKey(rawArgs.key);
  validateValue(key, rawArgs.value);
  const oldValue = getter(key);
  const newValue = rawArgs.value;
  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
    return { output: `DashboardConfigSet ${key} — value already ${JSON.stringify(newValue)} (no-op)` };
  }
  const approved = await approver({ key, oldValue, newValue });
  if (!approved) throw new Error(`DashboardConfigSet ${key} rejected by user`);
  await setter(key, newValue);
  return {
    output: `DashboardConfigSet ${key}: ${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)}`,
  };
}
