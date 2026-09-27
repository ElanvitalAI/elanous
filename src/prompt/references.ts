// Chat prompt reference expander. Only terminal session tokens are expanded;
// other tokens pass through unchanged for the model to see.

import { expandTerminalReferences } from './term-reference.js';
import type { TerminalSessionRegistry } from '../terminal/session-registry.js';

export interface PromptReferenceDeps {
  /** TerminalSessionRegistry — powers @term:<id>. Omitted = skip. */
  terminalRegistry?: TerminalSessionRegistry;
}

/** Expand every @<kind>:<id> token in `input` into its structured
 *  payload. Tokens with unknown ids (or kinds not wired up) pass
 *  through untouched so the LLM + user can see what was meant. */
export function expandPromptReferences(
  input: string,
  deps: PromptReferenceDeps,
): string {
  if (!input.includes('@')) return input;
  if (deps.terminalRegistry) {
    return expandTerminalReferences(input, deps.terminalRegistry);
  }
  return input;
}
