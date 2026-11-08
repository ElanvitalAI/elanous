import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── PX-5 P4: 4 LLM tools — RouteList / Resolve / Suggest / AgentsMdRead ──
//
// All read-only. The Turn hook (turn-hook.ts) already surfaces routes
// passively; these tools let the LLM query explicitly when it wants
// to inspect the state mid-turn.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { globalRouteRegistry, type RouteRegistry, tokenize } from './registry.js';
import { getSessionCwd } from '../session/working-dir.js';
import type { RouteTargetKind } from './types.js';

export interface RouteListArgs {
  kind?: RouteTargetKind;
}

export interface RouteListResult extends Record<string, unknown> {
  output: string;
  routes: Array<{
    pluginId: string;
    id: string;
    aliases: string[];
    target: { kind: RouteTargetKind; id: string };
    precedence: number;
    description?: string;
  }>;
}

export function buildRouteListTool(): LLMToolSpec {
  return {
    name: 'RouteList',
    description:
      'List all registered keyword routes. Pass {kind: "agent"} etc. to filter. ' +
      'Read-only. Use to discover what $name invocations and keyword matches are ' +
      'available this session before constructing an Agent() or skill call.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['agent', 'skill', 'workflow', 'mission'],
          description: 'Filter by target kind.',
        },
      },
      additionalProperties: false,
    },
  };
}

export function dispatchRouteList(
  args: Record<string, unknown>,
  opts: { registry?: RouteRegistry } = {},
): RouteListResult {
  const reg = opts.registry ?? globalRouteRegistry;
  const kind = typeof args.kind === 'string' ? args.kind as RouteTargetKind : undefined;
  const routes = reg.list(kind ? { kind } : undefined).map(r => ({
    pluginId: r.pluginId,
    id: r.id,
    aliases: [...(r.aliases ?? [])],
    target: r.target,
    precedence: r.precedence,
    ...(r.description ? { description: r.description } : {}),
  }));
  const output = routes.length === 0
    ? 'No routes registered.'
    : routes.map(r =>
        `- $${r.id} [${r.target.kind}:${r.target.id}] (prec ${r.precedence}, plugin ${r.pluginId})`
      ).join('\n');
  return { output, routes };
}

// ── RouteResolve ───────────────────────────────────────────────────────

export interface RouteResolveArgs {
  text: string;
}

export interface RouteResolveResult extends Record<string, unknown> {
  output: string;
  explicit: { routeId: string; target?: { kind: RouteTargetKind; id: string } } | null;
  matches: Array<{ id: string; pluginId: string; target: { kind: RouteTargetKind; id: string }; precedence: number }>;
}

export function buildRouteResolveTool(): LLMToolSpec {
  return {
    name: 'RouteResolve',
    description:
      'Scan a string for route keyword matches + $name explicit invocation. Returns the ' +
      'same data the Turn hook uses for its banner — useful for debugging why a given ' +
      'user message did or did not suggest a route.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to scan.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };
}

export function dispatchRouteResolve(
  args: Record<string, unknown>,
  opts: { registry?: RouteRegistry } = {},
): RouteResolveResult {
  const reg = opts.registry ?? globalRouteRegistry;
  const text = typeof args.text === 'string' ? args.text : '';
  const { parseExplicitInvocation, detectKeywords } = require('./detector.js');
  const explicitRaw = parseExplicitInvocation(text);
  let explicit: RouteResolveResult['explicit'] = null;
  if (explicitRaw) {
    const r = reg.resolveExplicit(explicitRaw.routeId);
    explicit = {
      routeId: explicitRaw.routeId,
      ...(r ? { target: r.target } : {}),
    };
  }
  const matches = detectKeywords(text, { registry: reg }).map((r: any) => ({
    id: r.id,
    pluginId: r.pluginId,
    target: r.target,
    precedence: r.precedence,
  }));
  const lines: string[] = [];
  if (explicit) lines.push(`explicit: $${explicit.routeId} → ${explicit.target ? `${explicit.target.kind}:${explicit.target.id}` : '(no match)'}`);
  if (matches.length > 0) lines.push(`${matches.length} keyword match(es): ${matches.map((m: any) => m.id).join(', ')}`);
  if (lines.length === 0) lines.push('no route match.');
  return { output: lines.join('\n'), explicit, matches };
}

// ── RouteSuggest — lightweight fuzzy overlap ───────────────────────────

export interface RouteSuggestArgs {
  intent: string;
  limit?: number;
}

export interface RouteSuggestResult extends Record<string, unknown> {
  output: string;
  candidates: Array<{ id: string; score: number; target: { kind: RouteTargetKind; id: string } }>;
}

export function buildRouteSuggestTool(): LLMToolSpec {
  return {
    name: 'RouteSuggest',
    description:
      'Suggest routes whose keywords/description overlap with the given natural-language ' +
      'intent. Scores by word-token overlap (simple Jaccard-style, no embeddings). Use ' +
      'when the user intent does not contain the exact keyword but is semantically ' +
      'close ("I want to look at the code" → explore).',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Natural-language intent.' },
        limit: { type: 'number', description: 'Max suggestions (default 5).' },
      },
      required: ['intent'],
      additionalProperties: false,
    },
  };
}

export function dispatchRouteSuggest(
  args: Record<string, unknown>,
  opts: { registry?: RouteRegistry } = {},
): RouteSuggestResult {
  const reg = opts.registry ?? globalRouteRegistry;
  const intent = typeof args.intent === 'string' ? args.intent : '';
  const limit = typeof args.limit === 'number' ? args.limit : 5;
  const intentTokens = new Set(tokenize(intent).map(t => t.toLowerCase()));
  const candidates = reg.list().map(r => {
    const haystack = new Set<string>(r.keywords);
    if (r.description) {
      for (const t of tokenize(r.description).map(t => t.toLowerCase())) haystack.add(t);
    }
    let overlap = 0;
    for (const t of intentTokens) if (haystack.has(t)) overlap++;
    return {
      id: r.id,
      target: r.target,
      score: intentTokens.size === 0 ? 0 : overlap / intentTokens.size,
    };
  })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const output = candidates.length === 0
    ? 'No routes overlap the intent.'
    : candidates.map(c => `- $${c.id} [${c.target.kind}:${c.target.id}] (score ${c.score.toFixed(2)})`).join('\n');
  return { output, candidates };
}

// ── AgentsMdRead ───────────────────────────────────────────────────────

export interface AgentsMdReadResult extends Record<string, unknown> {
  output: string;
  path: string;
  exists: boolean;
  content?: string;
}

export function buildAgentsMdReadTool(): LLMToolSpec {
  return {
    name: 'AgentsMdRead',
    description:
      'Return the project root AGENTS.md content. The file is automatically prepended to ' +
      'the system prompt on every turn; this tool exists for explicit inspection / citation.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export function dispatchAgentsMdRead(
  _args: Record<string, unknown>,
  opts: { cwd?: () => string } = {},
): AgentsMdReadResult {
  const cwd = opts.cwd ?? getSessionCwd;
  const path = join(cwd(), 'AGENTS.md');
  if (!existsSync(path)) {
    return { output: 'AGENTS.md not found.', path, exists: false };
  }
  const content = readFileSync(path, 'utf-8');
  return {
    output: `AGENTS.md (${content.length} chars): ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`,
    path,
    exists: true,
    content,
  };
}
