import type { SelfDevJobResult } from './run-types.js';

/** Error codes whose message is the only place the Pod failure reason survives — the harness Pod exit
 *  classifier (src/harness/harness-cli-command.ts) reads it back from this line (POD-EXIT-REASON-SHOWN). */
const MESSAGE_CODES = new Set(['pod-job-failed', 'pod-child-failed']);

/** One human summary line per job printed by `elanous self orchestrate` (src/index.ts). */
export function formatOrchestrateResultLine(r: Pick<SelfDevJobResult, 'status' | 'feature' | 'merged' | 'prUrl' | 'stage' | 'error'>): string {
  const icon = r.status === 'done' ? '✅' : r.status === 'cancelled' ? '⛔' : '❌';
  const disp = r.merged ? ` → merged ${r.prUrl}` : r.prUrl ? ` → PR ${r.prUrl}` : r.stage ? ` [${r.stage}]` : '';
  const error = r.error ? ` — ${r.error.code}${MESSAGE_CODES.has(r.error.code) ? `: ${r.error.message}` : ''}` : '';
  return `  ${icon} ${r.status} · ${r.feature.slice(0, 56)}${disp}${error}`;
}
