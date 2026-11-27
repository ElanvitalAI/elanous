// CODEX-CREDIT-ACCOUNTS — which codex accounts may spend paid credits once their subscription window is full.
// S: CEO 11-27 15:1x «team·third 는 구독 100% 까지 쓰고 유료 크레딧 직전에 막고, default 는 크레딧으로 넘어갈 때까지 써라».
// C: credits were one global switch (`llm.codexQuotaPolicy=credits`) — every credit chooser picked the account with the
//    largest balance (third first), so «credits for default only» could not be said.
// Q: where does the per-account allow list come from, and who applies it?
// A: one list per provider — resource facts `creditAccounts.openai-codex` (guardian-owned policy file) first, then
//    `llm.codexCreditAccounts` (config), else absent = old behavior (any account with a measured balance).
//    Every credit chooser (rotation · credit-step collector · explicit account · Pod plan · budget gate) asks
//    `codexCreditAccountAllowed` — an account outside the list is subscription-only and stops at its window.
//    Faces: observe = `source` says which layer answered (`provider codex status`); judge = the rotation keeps a
//    not-allowed current account «dry» (moves to an allowed one or reports no-candidate); heal = one policy/config edit.
import { resourceFacts } from '../kit/resource-facts/index.js';
import { decidedCreditAccounts } from '../kit/resource-facts/llm-decide.js';

export { codexCreditAccountAllowed } from './codex-account-rotation.js';

export const CODEX_CREDIT_PROVIDER = 'openai-codex';

export interface CodexCreditAccounts {
  /** undefined = unrestricted (old behavior). `[]` = no account may spend credits. */
  readonly names: readonly string[] | undefined;
  /** `read-error` = nothing readable and a read failed → fail-closed `[]` (credits are money). */
  readonly source: 'policy-pack' | 'resource-facts' | 'config' | 'absent' | 'read-error';
}

/** A list of non-empty account names, or undefined when the value is not a string list. */
export function normalizeCreditAccountList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) return undefined;
  return (raw as string[]).map((v) => v.trim()).filter(Boolean);
}

/** Pure: resource facts list first, then config, else absent — or `[]` (read-error) when nothing answered and a read failed. */
export function resolveCodexCreditAccounts(
  llm: { readonly codexCreditAccounts?: unknown } | undefined,
  factsList?: unknown,
  readFailed = false,
): CodexCreditAccounts {
  const facts = normalizeCreditAccountList(factsList);
  if (facts) return { names: facts, source: 'resource-facts' };
  const cfg = normalizeCreditAccountList(llm?.codexCreditAccounts);
  if (cfg) return { names: cfg, source: 'config' };
  // ⛔ Money: a failed read must not turn into «unrestricted» — only a clean «nothing set» keeps the old behavior.
  if (readFailed) return { names: [], source: 'read-error' };
  return { names: undefined, source: 'absent' };
}

/** Live read (never throws). Facts and config are read independently — a config read that throws still honors the
 *  facts list; if neither answers and either read failed, no account may spend credits. */
export function readCodexCreditAccounts(
  readLlm: () => { readonly codexCreditAccounts?: unknown } | undefined,
  readFacts: () => unknown = () => resourceFacts().creditAccounts[CODEX_CREDIT_PROVIDER],
  readPack: () => readonly string[] | undefined = () => decidedCreditAccounts(CODEX_CREDIT_PROVIDER),
): CodexCreditAccounts {
  // LLM-ACCOUNT-POLICY-YAML — the pack decision (pack ⊕ phase/levels ⊕ overrides) is the one source; resource facts and
  // config below are the fallbacks for a missing/invalid pack.
  try { const p = readPack(); if (p) return { names: [...p], source: 'policy-pack' }; } catch { /* fall through */ }
  let readFailed = false;
  let factsList: unknown;
  try { factsList = readFacts(); } catch { readFailed = true; }
  let llm: { readonly codexCreditAccounts?: unknown } | undefined;
  try { llm = readLlm(); } catch { readFailed = true; }
  return resolveCodexCreditAccounts(llm, factsList, readFailed);
}
