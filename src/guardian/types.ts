// Arc B — Guardian hook types.
//
// `GuardianSpec` is what a `NativeToolCatalogEntry` declares to opt
// into pre-call permission checks. `GuardianVerdict` is the data the
// hook returns — never an exception. LLM consumers read `ok:false`
// from the dispatch result and self-recover on the next turn.
//
// Scope-cut (coding-first lane): 3 active policy kinds (`plugin-
// capability`, `trust-store`, `shell-argv`). 2 forward-compat slots
// (`hitl-delivery`, `mutating-default`) are declared in the union but
// currently short-circuit to `allow` — vision-ready lane adds the
// builtins.
//
// PLAN: 내부 문서 `PLAN-harness-arc-b-guardian`
// Track: harness-engineering meta · Phase 4 (coding-first lane)

import type { PluginCapability, PluginSource } from '../plugins/core/manifest.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';

/** Dispatch context the guardian receives, including dashboard calls. */
export type GuardianSurface = ToolRuntimeContext['surface'];

/** Declarative policy tag attached to a `NativeToolCatalogEntry`.
 *  Union is closed so adding a policy is a typed change across the
 *  codebase, not a string lookup. */
export type GuardianSpec =
  /** Wraps `src/plugins/core/capability-policy.ts` — checks the
   *  catalog-declared capability against the plugin ctx. Requires
   *  `ctx.plugin` to be populated; native tools without a plugin
   *  context short-circuit to `allow`. */
  | { kind: 'plugin-capability'; require: 'read' | 'write' | 'network' | 'process' | 'clipboard' }
  /** Wraps `src/plugins/core/trust-store.ts` — checks the plugin
   *  source is trusted. Only meaningful when `ctx.plugin` is set. */
  | { kind: 'trust-store' }
  /** TC #92362 — wraps `src/security/shell-argv-policy.ts`, the same
   *  argv-exact classifier the seat approval flow uses. Reads
   *  `ctx.shellCommand` (raw, untruncated). Vocabulary maps 1:1:
   *  allow→allow · deny→deny · ask-op→needs-approval (demoted to deny
   *  while the HITL slot is unmanned). Missing/unparseable command →
   *  deny (fail-closed). */
  | { kind: 'shell-argv' }
  /** Forward-compat slot (vision-ready). Currently short-circuits to
   *  `allow` with a debug-log warning; HITL 4-channel race builtin
   *  lands in the vision-ready lane. */
  | { kind: 'hitl-delivery'; channels?: string[] }
  /** Forward-compat slot (vision-ready). Currently short-circuits to
   *  `allow`. Landing this slot implements Bash/Edit/Write default
   *  deny-by-default for the mutating coding tools. */
  | { kind: 'mutating-default' };

export type GuardianDecision = 'allow' | 'deny' | 'needs-approval';

export interface GuardianVerdict {
  decision: GuardianDecision;
  /** Human-readable reasons — included in the tool-result error when
   *  decision is `deny`, and in the audit payload always. */
  reasons: string[];
  /** Minimal, truncated audit record. Sink decides whether to
   *  persist; contents are safe to stringify. */
  auditPayload?: Record<string, unknown>;
  /** APPROVAL-REQUEST-PLAINTEXT-TARGET — needs-approval 판정의 승인 요청 문면:
   *  명령 이름 · 대상(경로·가지 이름) 평문 · 비밀 가린 명령 · 보조 sha256.
   *  감사 싱크에는 싣지 않는다(감사 = 해시·이름만). */
  approvalRequest?: string;
}

export interface GuardianContext {
  toolId: string;
  surface: GuardianSurface;
  /** When present, plugin-capability + trust-store policies can
   *  evaluate against the owner plugin. Native tools (bash/edit/write)
   *  leave this undefined and the plugin-aware policies short-circuit
   *  to `allow` — the mutating-default slot is the place for native
   *  tool defaults (forward-compat). */
  plugin?: {
    pluginId: string;
    source: PluginSource;
    workspaceTrusted?: boolean;
    userTrusted?: boolean;
    capabilities: PluginCapability[];
  };
  /** Arbitrary extra fields a policy may inspect (e.g. the file path
   *  being written). Loose shape — each policy reads what it needs. */
  argsSummary?: Record<string, unknown>;
  /** Raw, UNTRUNCATED shell command string (Bash `args.command`) for
   *  the shell-argv policy. Deliberately separate from `argsSummary` —
   *  its 200-char truncation would break classifyShellArgv's command/
   *  argv consistency re-parse (long commands would mis-deny) and
   *  skew the audit sha. */
  shellCommand?: string;
}
