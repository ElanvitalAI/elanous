// Launch-time application of the overload gate. Kept out of dev-cli.ts so a
// unit test can import it without the dev-cli module graph (yaml, typescript).

import type { ChildLlmSelection } from '../agent/run-context.js';
import { debug } from '../debug/log.js';
import { resolveGrokCredential } from '../grok/credential.js';
import {
  applyOverloadFailoverToChild,
  readLlmCallOutcomes,
  type OverloadFailoverLaunchDecision,
} from './overload-failover.js';

const CODEX_NAMES = new Set(['codex', 'openai-codex']);

export function codexProviderNamed(provider: string | undefined): boolean {
  if (!provider?.trim()) return false;
  return CODEX_NAMES.has(provider.trim().toLowerCase());
}

let launchOverloadOutcomesForTesting: (() => ReturnType<typeof readLlmCallOutcomes>) | undefined;

/** Test seam. `undefined` restores the real log store. */
export function setLaunchOverloadOutcomesForTesting(
  reader: (() => ReturnType<typeof readLlmCallOutcomes>) | undefined,
): void {
  launchOverloadOutcomesForTesting = reader;
}

export interface LaunchOverloadFlags {
  provider?: string;
  model?: string;
  /** Pinned childLlm config naming codex. A flag is handled via `provider`. */
  codexPinned?: boolean;
  /** Test seam. Default: a grok credential resolves on this host. */
  grokAvailable?: boolean;
}

/** Explicit codex stays. Otherwise k `llm.call`/`outcome` overload rows move
 *  the unpinned child to grok before spawn. */
export function applyLaunchOverloadFailover(
  selection: ChildLlmSelection | undefined,
  flags: LaunchOverloadFlags = {},
  readOutcomes?: () => ReturnType<typeof readLlmCallOutcomes>,
  env: NodeJS.ProcessEnv = process.env,
): ChildLlmSelection | undefined {
  // Test processes never read this machine's operational logs.db — results must not depend on the host's history.
  const inTest = env.NODE_ENV === 'test' || Boolean(env.ELANOUS_TEST_HOME);
  const reader = launchOverloadOutcomesForTesting ?? readOutcomes ?? (inTest ? () => [] : () => readLlmCallOutcomes());
  let outcomes: ReturnType<typeof readLlmCallOutcomes> = [];
  try { outcomes = reader(); } catch { outcomes = []; }
  const explicit = codexProviderNamed(flags.provider) || flags.codexPinned === true;
  let grokAvailable = flags.grokAvailable;
  if (grokAvailable === undefined && outcomes.length > 0 && !inTest) {
    // Only resolve when a switch is possible — a host without grok credentials must stay on codex. Tests inject it.
    try { grokAvailable = resolveGrokCredential() !== null; } catch { grokAvailable = false; }
  }
  const { selection: next, decision } = applyOverloadFailoverToChild(selection, {
    codexExplicit: explicit,
    outcomes,
    ...(grokAvailable !== undefined ? { grokAvailable } : {}),
    defaultProvider: selection?.provider ?? 'openai-codex',
  });
  if (decision.switched && next?.provider === 'grok' && next.model) {
    debug.log('self-dev', 'overload-failover', {
      from: selection?.provider ?? 'openai-codex',
      to: next.provider,
      model: next.model,
      why: decision.why,
    }, { level: 'warn' });
    return { provider: next.provider, model: next.model, source: 'config' };
  }
  return selection;
}

export type { OverloadFailoverLaunchDecision };
