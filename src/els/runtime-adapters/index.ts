// ELS-RUNTIME-ADAPTERS — the registry: the adapter for a pane is picked by the runtime els already records for it (the
// foreground kind in `els ls`: eln · codex · claude · grok · shell · other); anything else → the shell fallback.
// Design note: 내부 문서 `ELS-RUNTIME-ADAPTERS`.

import { claudeAdapter, CLAUDE_PROMPT_HEAD } from './claude.js';
import { codexAdapter } from './codex.js';
import { promptRow, WORKING_HINT } from './common.js';
import { ELN_BUSY_SCREEN, ELN_PROMPT_HEAD, ELN_TOOL_ROW, elnAdapter } from './eln.js';
import { grokAdapter } from './grok.js';
import { shellAdapter } from './shell.js';
import type { RuntimeAdapter, RuntimeId, ScreenRules } from './types.js';

export type { AgentStatus, InputOp, PaneRef, RuntimeAdapter, RuntimeCapabilities, RuntimeId, ScreenRules } from './types.js';
export { executableOf, lastPromptText, promptRow, quotePath, shellQuote, statusFromScreen } from './common.js';

/** Detection order: the agents first, the shell last (a fallback, never a guess past the executable). */
export const ADAPTERS: readonly RuntimeAdapter[] = [elnAdapter, claudeAdapter, codexAdapter, grokAdapter, shellAdapter];
const BY_ID: Readonly<Record<string, RuntimeAdapter>> = Object.fromEntries(ADAPTERS.map((one) => [one.id, one]));

/** The adapter for a recorded pane kind (undefined/unknown/«other» → the shell fallback). */
export function adapterFor(kind: string | undefined): RuntimeAdapter {
  return (kind && Object.hasOwn(BY_ID, kind) ? BY_ID[kind] : undefined) ?? shellAdapter;
}

/** The adapter whose runtime this command line runs, or undefined (not an agent and not a shell = «other»). */
export function detectRuntime(pane: { readonly cmdline?: readonly string[]; readonly title?: string; readonly screen?: string }): RuntimeId | undefined {
  return ADAPTERS.find((one) => one.detect(pane))?.id;
}

/** Screen rules when the runtime is not known: every agent's busy hints, the eln and Claude Code prompt heads, eln's
 *  tool row — exactly what `els status` read before adapters existed. */
export const ANY_SCREEN: ScreenRules & { readonly prompt: RegExp } = {
  busy: [WORKING_HINT, ELN_BUSY_SCREEN],
  promptHead: `${ELN_PROMPT_HEAD}|${CLAUDE_PROMPT_HEAD}`,
  tool: ELN_TOOL_ROW,
  prompt: promptRow([ELN_PROMPT_HEAD, CLAUDE_PROMPT_HEAD]),
};

/** The screen rules for a pane kind (unknown → ANY_SCREEN), with the prompt row built. */
export function screenRulesFor(kind: string | undefined): ScreenRules & { readonly prompt?: RegExp } {
  if (!kind || !Object.hasOwn(BY_ID, kind) || kind === 'shell') return ANY_SCREEN;
  const rules = BY_ID[kind]!.screen;
  return { ...rules, ...(rules.promptHead ? { prompt: promptRow([rules.promptHead]) } : {}) };
}
