// ── Control tools: tool exposure and prompt hints ──

import type { LLMToolSpec } from '../../llm.js';
import { nativeToolCatalog } from '../../native-tool-catalog.js';
import { appendPromptHint, clearPromptHints, listPromptHints, type HintScope } from '../../prompt/hint-store.js';
import { publishElementEvent } from '../../element-registry/index.js';
import { recordControlAudit } from '../../control-audit-log.js';

// ── Tool specs ─────────────────────────────────────────────────────

export function buildControlTools(): LLMToolSpec[] {
  return [
    {
      name: 'ControlToolToggle',
      description:
        'Turn a native tool on/off for the current session. Pass the tool id (e.g. "bash", "context_workspace") and enabled flag. Purely in-memory — resets on dashboard restart.',
      parameters: {
        type: 'object',
        properties: {
          toolId: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['toolId', 'enabled'],
        additionalProperties: false,
      },
    },
    {
      name: 'ControlPromptAppend',
      description:
        'Append a short instruction to the system prompt. scope="turn" applies once (next turn only); scope="session" applies every turn until cleared. Use sparingly — every hint costs tokens.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          scope: { type: 'string', enum: ['turn', 'session'] },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'ControlPromptClear',
      description:
        'Drop pending prompt hints. scope omitted clears all; scope="session" clears only persistent hints.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['turn', 'session'] },
        },
        additionalProperties: false,
      },
    },
  ];
}

// ── Helpers ────────────────────────────────────────────────────────

/** Emit an update event on the ElementEventBus so ContextEventsTail
 *  can replay control actions, AND append to the persistent control
 *  audit log (Phase F). Both calls are best-effort: a control action
 *  must never fail because observability is broken. */
function publishControlEvent(
  id: string,
  payload: Record<string, unknown>,
): void {
  try { publishElementEvent('tool', id, 'update', payload); } catch { /* swallow */ }
  try {
    recordControlAudit({
      ts: new Date().toISOString(),
      action: String(payload.action ?? 'unknown'),
      subject: `tool:${id}`,
      ok: payload.ok !== false,
      detail: payload,
    });
  } catch { /* swallow */ }
}

/** Audit-only helper for actions that don't address a bus-tracked
 *  element (prompt hints). */
function auditAction(action: string, ok: boolean, detail?: Record<string, unknown>): void {
  try {
    recordControlAudit({ ts: new Date().toISOString(), action, ok, detail });
  } catch { /* swallow */ }
}

// ── Dispatchers ───────────────────────────────────────────────────

export async function dispatchControlToolToggle(
  args: Record<string, unknown>,
): Promise<{ output: string; ok: boolean }> {
  const toolId = String(args.toolId ?? '');
  const enabled = args.enabled === true;
  const entry = nativeToolCatalog.find(t => t.id === toolId || t.aliases.includes(toolId));
  if (!entry) return { output: `unknown tool: ${toolId}`, ok: false };
  entry.defaultEnabled = enabled;
  publishControlEvent(entry.id, { action: 'toggle', enabled });
  return { output: `tool ${entry.id} ${enabled ? 'enabled' : 'disabled'}`, ok: true };
}

export async function dispatchControlPromptAppend(
  args: Record<string, unknown>,
): Promise<{ output: string; ok: boolean }> {
  const text = String(args.text ?? '').trim();
  if (!text) return { output: 'empty text', ok: false };
  const scope: HintScope = args.scope === 'session' ? 'session' : 'turn';
  appendPromptHint({ text, scope, origin: 'control_prompt_append' });
  auditAction('prompt_append', true, { scope, length: text.length });
  return { output: `hint stored (scope=${scope}, len=${text.length})`, ok: true };
}

export async function dispatchControlPromptClear(
  args: Record<string, unknown>,
): Promise<{ output: string; ok: boolean; remaining: number }> {
  const scope = args.scope === 'turn' || args.scope === 'session' ? args.scope : undefined;
  const before = listPromptHints().length;
  clearPromptHints(scope);
  const after = listPromptHints().length;
  auditAction('prompt_clear', true, { scope: scope ?? 'all', removed: before - after });
  return {
    output: `cleared ${before - after} hint(s)${scope ? ` (scope=${scope})` : ''}; ${after} remaining`,
    ok: true,
    remaining: after,
  };
}
