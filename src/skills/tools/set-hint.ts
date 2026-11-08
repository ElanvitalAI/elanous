import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: set_tool_hint
//
// Let the LLM (mid-run) register a hint that steers subsequent tool
// selection. The gate picks the hint up on the next discipline-prompt
// build. Scope is capped to 'turn' or 'session' — persistence beyond
// the session (project/global) is user-only via /hint to prevent a
// confused model from poisoning the project's long-term tool policy.
//
// Available only on T1+T2 models (minTier: 'T2' in catalog) — weaker
// models don't benefit enough from this meta-tool to justify the
// per-prompt token cost.

import { addHint } from '../../tool-hints/registry.js';
import type { Hint, HintKind, HintScope } from '../../tool-hints/types.js';


export function buildSetToolHintTool(): LLMToolSpec {
  return {
    name: 'SetToolHint',
    description:
      'Register a turn- or session-scoped hint that steers subsequent native-tool selection. ' +
      'The gate picks up the hint on the next prompt build — no effect on the current tool call. ' +
      'Use this when you want to prefer/avoid a tool for the next few steps, or pre-supply ' +
      'default args (param-default kind). Persistence beyond the session requires the user to ' +
      'run the /hint slash command — do not request project/global scope from this tool.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['prefer', 'avoid', 'enable', 'disable', 'boost', 'param-default'],
          description:
            'prefer/boost raise a tool\'s priority; avoid lowers it; enable/disable toggle ' +
            'availability; param-default supplies default args consumed on the next dispatch.',
        },
        tool: {
          type: 'string',
          description: 'Catalog id, display name, or alias of the target tool. Use "*" to apply to every tool.',
        },
        scope: {
          type: 'string',
          enum: ['turn', 'session'],
          description:
            'turn (default) — cleared at the end of the current turn. session — cleared when ' +
            'the skill run returns. Wider scopes (project/global) require the user.',
        },
        reason: {
          type: 'string',
          description: 'One-line human-facing rationale. Surfaces in the next discipline prompt via "Active hints: ..."',
        },
        uses_left: {
          type: 'integer',
          description: 'Positive integer. When supplied, the hint is removed after this many dispatches consume it.',
        },
        ttl_seconds: {
          type: 'number',
          description: 'Positive seconds; hint auto-expires after this wall-clock interval.',
        },
        args: {
          type: 'object',
          description: 'For kind="param-default": default arg object merged into the next dispatch of `tool`.',
        },
      },
      required: ['kind', 'tool'],
      additionalProperties: false,
    },
  };
}

export interface SetToolHintArgs {
  kind: HintKind;
  tool: string;
  scope?: 'turn' | 'session';     // 'project' + 'global' rejected
  reason?: string;
  uses_left?: number;
  ttl_seconds?: number;
  args?: Record<string, unknown>;  // for kind: 'param-default'
}

const VALID_KINDS: readonly HintKind[] = ['prefer', 'avoid', 'enable', 'disable', 'boost', 'param-default'] as const;
const ALLOWED_SCOPES: readonly HintScope[] = ['turn', 'session'] as const;

export interface SetToolHintResult {
  output: string;
}

export async function dispatchSetToolHint(rawArgs: Record<string, unknown>): Promise<SetToolHintResult> {
  const args = validate(rawArgs);

  const expiresAt = typeof args.ttl_seconds === 'number' && args.ttl_seconds > 0
    ? Date.now() + args.ttl_seconds * 1000
    : undefined;

  const payload = args.kind === 'param-default' && args.args
    ? { args: args.args }
    : undefined;

  const hint: Hint = addHint({
    kind: args.kind,
    tool: args.tool,
    scope: args.scope ?? 'turn',
    reason: args.reason,
    expiresAt,
    usesLeft: args.uses_left,
    sourceSignal: 'llm',
    payload,
  });

  const parts = [
    `hint set: ${hint.kind} ${hint.tool}`,
    `scope=${hint.scope}`,
    `id=${hint.id}`,
  ];
  if (hint.expiresAt) parts.push(`ttl=${Math.round((hint.expiresAt - Date.now()) / 1000)}s`);
  if (hint.usesLeft !== undefined) parts.push(`uses=${hint.usesLeft}`);
  if (hint.reason) parts.push(`reason="${hint.reason}"`);

  return { output: parts.join(' ') };
}

function validate(raw: Record<string, unknown>): SetToolHintArgs {
  const kind = raw.kind;
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as HintKind)) {
    throw new Error(`invalid 'kind'; expected one of ${VALID_KINDS.join('|')}`);
  }
  const tool = raw.tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new Error(`'tool' is required`);
  }
  const scope = raw.scope ?? 'turn';
  if (typeof scope !== 'string' || !ALLOWED_SCOPES.includes(scope as HintScope)) {
    throw new Error(`'scope' must be 'turn' or 'session' (project/global require user /hint)`);
  }
  const reason = raw.reason;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error(`'reason' must be a string if provided`);
  }
  const usesLeft = raw.uses_left;
  if (usesLeft !== undefined) {
    if (typeof usesLeft !== 'number' || usesLeft <= 0 || !Number.isInteger(usesLeft)) {
      throw new Error(`'uses_left' must be a positive integer`);
    }
  }
  const ttlSeconds = raw.ttl_seconds;
  if (ttlSeconds !== undefined) {
    if (typeof ttlSeconds !== 'number' || ttlSeconds <= 0) {
      throw new Error(`'ttl_seconds' must be a positive number`);
    }
  }
  const argsField = raw.args;
  if (argsField !== undefined && (typeof argsField !== 'object' || argsField === null || Array.isArray(argsField))) {
    throw new Error(`'args' must be an object if provided`);
  }
  if (kind === 'param-default' && (!argsField || Object.keys(argsField).length === 0)) {
    throw new Error(`'param-default' kind requires non-empty 'args'`);
  }
  return {
    kind: kind as HintKind,
    tool,
    scope: scope as 'turn' | 'session',
    reason,
    uses_left: usesLeft as number | undefined,
    ttl_seconds: ttlSeconds as number | undefined,
    args: argsField as Record<string, unknown> | undefined,
  };
}
