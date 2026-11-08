// NEXUS · config + SwitchRegistry shared types (Phase N-3 PR μ)
//
// SwitchRegistry is the single source of truth for every user-tunable
// knob in NEXUS. The registry declares schema; UserConfig stores values;
// env-derive computes child env at spawn time; apply dispatches hot vs
// restart on change.

import type { TabKind } from '../kinds/types.js';

export type SwitchScope = 'global' | 'tab' | 'session';

export type SwitchKind =
  | 'bool'
  | 'enum'
  | 'string'
  | 'number'
  | 'secret-ref'
  | 'multiline'
  | 'path';

export interface SwitchEnumOption {
  value: string;
  label: string;
  description?: string;
}

export interface SwitchSpec {
  /** Dot-separated id. Examples:
   *    'global.tools'                    (scope='global')
   *    'tabs.<id>.httpPort'              (scope='tab', literal id slot is wildcard '<id>')
   *    'session.workspaceId'             (scope='session') */
  id: string;
  scope: SwitchScope;
  /** Narrows where a tab-scope switch is valid. */
  appliesTo?: TabKind[];
  kind: SwitchKind;
  label: string;
  description: string;
  /** Stringified default surfaced in /v1/config/switches. The actual
   *  typed value is parsed by the per-kind reader. */
  default: unknown;
  enumValues?: SwitchEnumOption[];
  /** Returns null for valid input or an error message string. */
  validate?: (v: unknown) => string | null;
  hotApplicable: boolean;
  /** When hotApplicable=false, which tabs (by id pattern · `<id>` literal
   *  is replaced with the matching tab id) need restart. Pass `[]` for
   *  switches that don't trigger any restart even when not hot. */
  restartTabs?: string[];
  /** Render hint for TUI: complex inputs (long secrets, multiline) are
   *  better filled in PWA via Edit-in-PWA hand-off. */
  pwaPreferred?: boolean;
  /** Mark for redaction in /v1/config + log lines. Always true for
   *  kind='secret-ref'. */
  redactInLogs?: boolean;
  /** Child-env name to inject at spawn time. Switches without envName
   *  are state-only (e.g., debug.enabled toggles in-process). */
  envName?: string;
  /** Optional `ELANOUS_*` env to migrate from on boot (deprecation A path). */
  legacyEnvName?: string;
}

// ---------------------------------------------------------------------------
// UserConfig — persistent state on disk
// ---------------------------------------------------------------------------

export const USER_CONFIG_VERSION = 1;
export const SECRETS_VERSION = 1;

export interface GlobalConfig {
  /** Daemon tool surface (in-process LLM tools the daemon exposes per
   *  turn). 2026-05-13 spec:
   *    - `none`     → empty surface (text-only chat backend)
   *    - `readonly` → Read · Grep · WebSearch · Plan · MarkStepDone
   *    - `chat`     → readonly + Edit + Bash (no PTY dependency · for
   *                    PWA · iOS · Discord chat clients that don't
   *                    drive a web terminal)
   *    - `webterm`  → chat + WebTerminal* triple (default · sticky
   *                    PWA workflow: chat reads WebTerminalSnapshot of
   *                    an open PTY pane)
   *    - `all`      → legacy alias for `webterm`
   *  Override via `elanous config set global.tools <kind>` or pass
   *  `--tools <kind>` to a single `elanous nexus run` invocation. The
   *  `ELANOUS_TOOLS` env var was removed 2026-05-13 — user-config is the
   *  single persistent surface. */
  tools?: 'none' | 'readonly' | 'chat' | 'webterm' | 'all';
  historyDir?: string;
  daemonDir?: string;
  shellPath?: string;
  debug?: {
    enabled?: boolean;
    daemonMirrorVerbose?: boolean;
    keymap?: boolean;
    callStack?: boolean;
  };
  nexus?: {
    autoRestartOnConfigChange?: boolean;
    template?: string;
    // N-1 cleanup PR g.3 — first-boot welcome card dismiss flag.
    // Set to true the first time the user dismisses the chat-tab
    // welcome card. Subsequent boots skip the card.
    firstBootGuideShown?: boolean;
  };
  // (`entry.defaultMode` — the `elanous` no-arg entry-mode switch — was
  // removed 2026-07-24 along with its type. It was never materialized
  // to any config on disk: 'auto' was the default, so unset == default,
  // and no config/backup ever carried the key. Bare `elanous` now always
  // launches the dashboard; the daemon's entry is `elanous nexus run`.
  // See 내부 문서 `REPORT-tui-observation-methodology-2026-07-24` §12.)
}

export type TabUserConfig = Record<string, unknown> & {
  enabled?: boolean;
  label?: string;
};

export interface UserConfig {
  version: typeof USER_CONFIG_VERSION;
  global: GlobalConfig;
  tabs: Record<string, TabUserConfig>;
  // PLAN-config-unification-elanous-root §3-A "top-level merge" — Path A
  // (`src/user-config.ts`) writes 16 additional top-level keys
  // (acp · chat · controlPlane · dashboard · debug · discord · llm ·
  // lsp · obsidian · onboarding · shell · skillRouter · skills ·
  // telegram · voice · vw) into the same `~/.elanous/config.json`. NEXUS
  // doesn't type-check those keys — that's Path A's job — but it MUST
  // preserve them through every read → patch → write round, otherwise
  // patchUserConfig() wipes the user's LLM / Obsidian / Discord / …
  // settings on every NEXUS state change. The index signature opens
  // the type so readUserConfig can spread unknown keys back into the
  // returned object without `as unknown as` casts. (Critical fix
  // 2026-05-13 — the missing piece of PLAN closure #2173-#2179.)
  [k: string]: unknown;
}

export interface SecretsFile {
  version: typeof SECRETS_VERSION;
  /** id (e.g., 'tg_token') → secret value (plain text). */
  secrets: Record<string, string>;
  /** One-way receipts for crash-safe credential registration commits. */
  credentialRegistrationReceipts?: Record<string, string>;
}

export const SECRET_REF_PREFIX = 'ref:secret:';

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_REF_PREFIX);
}

export function secretIdFromRef(ref: string): string | null {
  if (!isSecretRef(ref)) return null;
  return ref.slice(SECRET_REF_PREFIX.length);
}

export function makeSecretRef(id: string): string {
  return `${SECRET_REF_PREFIX}${id}`;
}
