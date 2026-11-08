import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── Input-policy LLM tools — Phase 6 of the unified-input plan ──
//
// Three tools:
//
//   SetInputMode       — switch the operating mode (general / control).
//                        Thin wrapper around input-core's setMode.
//   GetInputPolicy     — introspect the active mode + every binding
//                        + reserved keys + action catalog.
//   SetInputBinding    — add or replace a runtime binding. Reserved
//                        keys / action ids are rejected. Writes to
//                        control-audit-log.
//
// Reserved guard is layered: input-core's validateRebind() refuses
// at the binding layer, and this tool surfaces the violation to the
// LLM as a structured error so the model can reason about why its
// rebind was rejected without having to parse prose.


import {
  setMode,
  activeMode,
  listModes,
  listAllBindings,
  setRuntimeBinding,
  clearRuntimeBindingForAction,
  listActions,
  currentContext,
  RESERVED_KEYS,
  RESERVED_ACTION_IDS,
  type ModeId,
  type Binding,
  type ContextTag,
} from '../../input-core/index.js';
import { recordControlAudit } from '../../control-audit-log.js';

// ── SetInputMode ──────────────────────────────────────────────

export function buildSetInputModeTool(): LLMToolSpec {
  return {
    name: 'SetInputMode',
    description:
      'Switch the monad-agent operating mode: "general" (default chat + dev) or "control" (dashboard automation where every message routes through tools). Sync is owned by the PluginHost (`pluginHost.activate("sync")`), not by ModeManager — use the `/sync` slash for sync sessions. The transition fires the mode\'s onEnter/onExit; the resolver\'s context-stack tag updates so mode-scoped keybindings light up. Same-mode calls are a no-op. Failures (e.g. mode module threw) leave the prior mode active.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['general', 'control'] },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  };
}

export interface SetInputModeResult extends Record<string, unknown> {
  output: string;
  previousMode: ModeId;
  activeMode: ModeId;
}

export async function dispatchSetInputMode(
  raw: Record<string, unknown>,
): Promise<SetInputModeResult> {
  const mode = raw.mode as ModeId;
  if (mode !== 'general' && mode !== 'control') {
    return {
      output: `SetInputMode failed: unknown mode "${String(mode)}" (expected general|control).`,
      previousMode: activeMode(),
      activeMode: activeMode(),
    };
  }
  const previousMode = activeMode();
  const after = await setMode(mode);
  recordControlAudit({
    ts: new Date().toISOString(),
    action: 'input_set_mode',
    subject: mode,
    ok: after === mode,
    detail: { previousMode },
  });
  if (after !== mode) {
    return {
      output: `SetInputMode("${mode}") did NOT apply — stayed in "${after}". Check onEnter error in stderr.`,
      previousMode,
      activeMode: after,
    };
  }
  return {
    output: `SetInputMode: ${previousMode} → ${mode}.`,
    previousMode,
    activeMode: after,
  };
}

// ── GetInputPolicy ────────────────────────────────────────────

export function buildGetInputPolicyTool(): LLMToolSpec {
  return {
    name: 'GetInputPolicy',
    description:
      'Return the current monad-agent input policy: active mode, full binding table (default + user-config + runtime layers), context stack, reserved keys / action IDs, and the action catalog. Read-only; no approval needed. Use before calling SetInputBinding to pick a non-conflicting target, or to introspect when the user asks "what does Ctrl+B do here?".',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export interface GetInputPolicyResult extends Record<string, unknown> {
  output: string;
  mode: { id: ModeId; title: string }[];
  activeMode: ModeId;
  contextStack: readonly ContextTag[];
  bindings: Binding[];
  actions: { id: string; description?: string; reserved?: boolean }[];
  reservedKeys: string[];
  reservedActionIds: string[];
}

export async function dispatchGetInputPolicy(
  _raw: Record<string, unknown>,
): Promise<GetInputPolicyResult> {
  const modes = listModes().map(m => ({ id: m.id, title: m.title }));
  const bindings = listAllBindings();
  const actions = listActions().map(a => ({
    id: a.id,
    description: a.description,
    reserved: a.reserved,
  }));
  const ctx = currentContext();
  const active = activeMode();
  const summary =
    `mode=${active} · bindings=${bindings.length} · actions=${actions.length} `
    + `· context=[${ctx.join(',')}] · reserved-keys=${RESERVED_KEYS.size} `
    + `· reserved-actions=${RESERVED_ACTION_IDS.size}`;
  return {
    output: summary,
    mode: modes,
    activeMode: active,
    contextStack: ctx,
    bindings,
    actions,
    reservedKeys: [...RESERVED_KEYS],
    reservedActionIds: [...RESERVED_ACTION_IDS],
  };
}

// ── SetInputBinding ───────────────────────────────────────────

export function buildSetInputBindingTool(): LLMToolSpec {
  return {
    name: 'SetInputBinding',
    description:
      'Add or replace a runtime keybinding that maps one or more matchers to an action. Matchers use elanous\'s canonical form: "ctrl+p" for Ctrl+P, "ctrl+x s" for the Ctrl+X chord followed by s, "click:pill.model" for clicking the model pill. Runtime bindings override user-config and defaults for the same matcher. Pass an empty `keys` array to REMOVE the runtime binding for that action. Rebinding a reserved key (ctrl+c, escape, enter, ctrl+q, ctrl+d) or a reserved action id (app.interrupt, app.quit, modal.cancel, modal.submit) is rejected. Pass `context` to scope the binding to a specific mode ("control-mode", "plan-mode", etc.) — omit for global. Audit trail written to ~/.monad-agent/audit/control-*.ndjson.',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical matcher strings. Empty array removes the runtime override for this action.',
        },
        context: {
          type: 'string',
          description: 'Optional ContextTag the binding is scoped to. Omit for a global binding.',
        },
      },
      required: ['actionId', 'keys'],
      additionalProperties: false,
    },
  };
}

export interface SetInputBindingResult extends Record<string, unknown> {
  output: string;
  ok: boolean;
  violation?: { kind: string; value: string; message: string };
}

export async function dispatchSetInputBinding(
  raw: Record<string, unknown>,
): Promise<SetInputBindingResult> {
  const actionId = typeof raw.actionId === 'string' ? raw.actionId : '';
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((k): k is string => typeof k === 'string') : [];
  const context = typeof raw.context === 'string' ? (raw.context as ContextTag) : undefined;
  if (!actionId) {
    return {
      output: 'SetInputBinding failed: actionId is required.',
      ok: false,
    };
  }
  if (keys.length === 0) {
    clearRuntimeBindingForAction(actionId);
    recordControlAudit({
      ts: new Date().toISOString(),
      action: 'input_clear_binding',
      subject: actionId,
      ok: true,
    });
    return {
      output: `SetInputBinding: cleared runtime bindings for "${actionId}".`,
      ok: true,
    };
  }
  const violation = setRuntimeBinding(actionId, keys, context);
  if (violation) {
    recordControlAudit({
      ts: new Date().toISOString(),
      action: 'input_set_binding',
      subject: actionId,
      ok: false,
      detail: { keys, context, violation: { kind: violation.kind, value: violation.value } },
    });
    return {
      output: `SetInputBinding rejected: ${violation.message}`,
      ok: false,
      violation: {
        kind: violation.kind,
        value: violation.value,
        message: violation.message,
      },
    };
  }
  recordControlAudit({
    ts: new Date().toISOString(),
    action: 'input_set_binding',
    subject: actionId,
    ok: true,
    detail: { keys, context },
  });
  return {
    output:
      `SetInputBinding: "${actionId}" → [${keys.join(', ')}]`
      + (context ? ` (context=${context})` : ' (global)')
      + '.',
    ok: true,
  };
}
