import type { LLMToolSpec } from '../llm/tool-spec.js';
// PLAN-codex-app-server-hermes-parity §5 Phase H1·5c (2026-05-16) —
// `elanous_obsidian_info` MCP tool. Surfaces whether an Obsidian vault
// is resolvable + its absolute path + the resolution source (config /
// env / backup / default / discovery / none). Session-agnostic mirror
// of the ACP method `elanous/obsidian/info` (src/acp/server.ts:2119).
//
// Codex turn uses this to gate other elanous_obsidian_* calls — if
// `available: false`, no point firing a vault search. Cheaper than
// letting the search itself fail.

import { resolveObsidianRoot } from '../acp/fs-roots.js';

import type { ToolRuntime } from './types.js';

export interface ElanousObsidianInfoResult extends Record<string, unknown> {
  /** LLM-facing one-line summary. */
  output: string;
  available: boolean;
  /** Absolute vault path when `available: true`; omitted otherwise. */
  root?: string;
  /** Which step of the resolver chain produced the answer:
   *  `'config' | 'env' | 'backup' | 'default' | 'discovery' | 'none'`. */
  source: string;
}

export function buildElanousObsidianInfoTool(): LLMToolSpec {
  return {
    name: 'elanous_obsidian_info',
    description:
      'Report Obsidian vault availability + absolute path + resolution source. Use to gate other elanous_obsidian_* calls. Codex app-server callback via the elanous-tools MCP server. Read-only · no args.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

/** `opts.resolver` lets tests inject a fake resolution. Production
 *  callers just pass `{}` (default = real fs-roots.resolveObsidianRoot). */
export function dispatchElanousObsidianInfo(
  opts: { resolver?: () => { root: string; available: boolean; source: string } } = {},
): ElanousObsidianInfoResult {
  const resolver = opts.resolver ?? resolveObsidianRoot;
  const r = resolver();
  if (r.available) {
    return {
      output: `vault available at ${r.root} (source=${r.source})`,
      available: true,
      root: r.root,
      source: r.source,
    };
  }
  return {
    output: `vault unavailable (source=${r.source})`,
    available: false,
    source: r.source,
  };
}

export const elanousObsidianInfoRuntime: ToolRuntime<
  Record<string, unknown>,
  ElanousObsidianInfoResult
> = {
  id: 'elanous_obsidian_info',
  spec: buildElanousObsidianInfoTool(),
  async run() {
    return dispatchElanousObsidianInfo();
  },
};
