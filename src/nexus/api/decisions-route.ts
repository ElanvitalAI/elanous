import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { debug } from '../../debug/log.js';
import { DecisionLedger, type ApprovalProofBinding, type DecisionEntry, type HumanProof } from '../../decisions/decision-ledger.js';
import { isIrreversible } from '../../decisions/decision-cards.js';
import { proofWanted, signApprovalProof, type SignOutcome } from '../../decisions/approval-signer.js';
import { jsonResponse } from './json-response.js';

export const DECISIONS_PATH = '/v1/decisions';
/** The id the PWA records as the platform user — the owner credential carries no per-user id. */
export const PWA_OWNER_USER_ID = 'pwa-owner';

/** graphs/policies/release-proof.yaml `pwa_confirm` — a missing or malformed pack throws (loud, never a silent default). */
export function releaseProofPolicyPath(root = resolve(import.meta.dir, '../../..')): string { return join(root, 'graphs', 'policies', 'release-proof.yaml'); }
let confirmPolicy: { ttlMs: number; maxPending: number } | null = null;
export function parseReleaseProofPolicy(text: string): { ttlMs: number; maxPending: number } {
  const y = (parse(text) ?? {}) as { version?: unknown; pwa_confirm?: { ttl_ms?: unknown; max_pending?: unknown } };
  const num = (v: unknown, key: string): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`release-proof policy: pwa_confirm.${key} must be a positive integer`); return v; };
  if (y.version !== 1) throw new Error('release-proof policy: version must be 1');
  return { ttlMs: num(y.pwa_confirm?.ttl_ms, 'ttl_ms'), maxPending: num(y.pwa_confirm?.max_pending, 'max_pending') };
}
function loadConfirmPolicy(): { ttlMs: number; maxPending: number } {
  if (confirmPolicy) return confirmPolicy;
  const path = releaseProofPolicyPath();
  if (!existsSync(path)) throw new Error(`release-proof policy missing: ${path}`);
  confirmPolicy = parseReleaseProofPolicy(readFileSync(path, 'utf8'));
  return confirmPolicy;
}

export interface DecisionsRouteDeps {
  authorize?: (request: Request) => boolean;
  ledger?: Pick<DecisionLedger, 'list' | 'decide'>;
  /** RELEASE-HUMAN-PROOF-TRUST-ROOT — true only for the owner credential (bearer · short owner token · same-origin PWA). */
  ownerProof?: (request: Request) => boolean;
  /** Default: the ledger state's signer when the ledger is a DecisionLedger; null = never sign. */
  signer?: ((binding: ApprovalProofBinding) => SignOutcome) | null;
  now?: () => number;
}

/** Irreversible two-step confirm (same rule as the Telegram card): one-use token bound to id ⊕ choice, five minutes. */
const confirms = new Map<string, { id: string; choice: string; expiresAt: number }>();
function issueConfirm(id: string, choice: string, now: number): { token: string; expiresAt: number } {
  const policy = loadConfirmPolicy();
  for (const [token, row] of confirms) if (row.expiresAt <= now) confirms.delete(token);
  // Bounded: the oldest pending confirm gives way (a fresh first POST re-asks).
  while (confirms.size >= policy.maxPending) confirms.delete(confirms.keys().next().value!);
  const token = randomBytes(16).toString('hex');
  const expiresAt = now + policy.ttlMs;
  confirms.set(token, { id, choice, expiresAt });
  return { token, expiresAt };
}
function takeConfirm(token: string, id: string, choice: string, now: number): boolean {
  const row = confirms.get(token);
  if (!row) return false;
  confirms.delete(token);
  return row.id === id && row.choice === choice && row.expiresAt > now;
}

function defaultSigner(ledger: DecisionsRouteDeps['ledger']): DecisionsRouteDeps['signer'] {
  if (!(ledger instanceof DecisionLedger)) return null;
  const stateDir = dirname(dirname(ledger.path));
  return (binding) => signApprovalProof(binding, { stateDir });
}

export async function handleDecisions(req: Request, deps: DecisionsRouteDeps = {}): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  if (pathname !== DECISIONS_PATH && !/^\/v1\/decisions\/[^/]+\/decide$/.test(pathname)) return jsonResponse({ error: 'not-found' }, 404);
  if (!deps.authorize?.(req)) {
    debug.log('decisions.api', 'rejected', { reason: 'unauthorized' });
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const ledger = deps.ledger ?? new DecisionLedger();
  if (pathname === DECISIONS_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    if (new URL(req.url).searchParams.get('status') !== 'open') {
      debug.log('decisions.api', 'rejected', { reason: 'invalid-status' });
      return jsonResponse({ error: 'bad_request' }, 400);
    }
    const decided = ledger.list({ status: 'decided' });
    const decisions = ledger.list({ status: 'open' }).map(entry => {
      const precedent = decided
        .filter(other => other.id !== entry.id && other.category === entry.category && other.choice)
        .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0];
      return {
        id: entry.id,
        title: entry.title,
        situation: entry.scqa.s.slice(0, 200),
        options: entry.options.map(option => ({ id: option.key, label: option.label, consequence: option.consequence })),
        recommendation: entry.recommendation,
        raisedAt: entry.raisedAt,
        dueAt: entry.dueAt,
        scqa: entry.scqa,
        category: entry.category,
        irreversible: isIrreversible(entry),
        raisedBy: { agent: entry.raisedBy.agent, ...(entry.raisedBy.track ? { track: entry.raisedBy.track } : {}) },
        alternative: entry.alternative,
        dissent: entry.dissent,
        crossCheck: entry.crossCheck,
        crossCheckSkipped: entry.crossCheckSkipped,
        pendingQuestion: entry.pendingQuestion,
        history: entry.history.map(event => ({
          type: event.type,
          ...(event.at ? { at: event.at } : {}),
          by: event.by,
          ...(event.choice ? { choice: event.choice } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        })),
        precedent: precedent ? {
          id: precedent.id,
          title: precedent.title,
          choice: precedent.options.find(option => option.key === precedent.choice)?.label ?? precedent.choice ?? '',
          ...(precedent.decidedAt ? { decidedAt: precedent.decidedAt } : {}),
          ...(precedent.decidedBy ? { decidedBy: precedent.decidedBy.kind } : {}),
        } : null,
      };
    });
    debug.log('decisions.api', 'listed', { count: decisions.length });
    return jsonResponse({ decisions });
  }
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  let id: string;
  try { id = decodeURIComponent(pathname.slice(DECISIONS_PATH.length + 1, -'/decide'.length)); }
  catch {
    debug.log('decisions.api', 'rejected', { reason: 'invalid-id' });
    return jsonResponse({ error: 'not-found' }, 404);
  }
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !('choice' in body) || typeof body.choice !== 'string' || !body.choice
    || ('note' in body && body.note !== undefined && typeof body.note !== 'string')
    || ('confirmToken' in body && body.confirmToken !== undefined && typeof body.confirmToken !== 'string')) {
    debug.log('decisions.api', 'rejected', { id, reason: 'invalid-body' });
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  const { choice, note, confirmToken } = body as { choice: string; note?: string; confirmToken?: string };
  const now = deps.now?.() ?? Date.now();
  const open = ledger.list({ status: 'open' }).find(entry => entry.id === id);
  let confirmed = false;
  if (open && isIrreversible(open) && open.options.some(option => option.key === choice)) {
    if (!confirmToken) {
      const issued = issueConfirm(id, choice, now);
      debug.log('decisions.api', 'confirm-asked', { id, choice });
      return jsonResponse({ error: 'confirm-required', confirmToken: issued.token, expiresAt: new Date(issued.expiresAt).toISOString(),
        message: `${choice.toUpperCase()}) ${open.options.find(option => option.key === choice)?.label ?? ''} — this cannot be undone. Decide this?` }, 428);
    }
    if (!takeConfirm(confirmToken, id, choice, now)) {
      debug.log('decisions.api', 'rejected', { id, reason: 'confirm-invalid' });
      return jsonResponse({ error: 'confirm-invalid' }, 409);
    }
    confirmed = true;
  }
  // RELEASE-HUMAN-PROOF-TRUST-ROOT ③-3: owner credential ⊕ open ⊕ irreversible confirmed ⊕ critpath ref ⊕ approve → proof.
  let proof: HumanProof | undefined;
  const ref = open ? proofWanted(open, choice) : null;
  const signer = deps.signer !== undefined ? deps.signer : defaultSigner(ledger);
  if (open && ref && signer) {
    if (!confirmed || !open.raisedAt || !deps.ownerProof?.(req)) {
      debug.log('release.proof', 'sign-skipped', { platform: 'pwa', card: id, reason: !confirmed ? 'not-confirmed' : !open.raisedAt ? 'no-raised-at' : 'not-owner-credential' }, { level: 'warn' });
    } else {
      const signed = signer({ ref, cardId: id, raisedAt: open.raisedAt, choice, via: 'pwa', platformUserId: PWA_OWNER_USER_ID });
      if (signed.ok) proof = signed.proof;
    }
  }
  try {
    const entry: DecisionEntry = ledger.decide(id, choice, { kind: 'human', via: 'pwa', platformUserId: PWA_OWNER_USER_ID }, note, undefined, proof);
    debug.log('decisions.api', 'decided', { id, proof: proof ? proof.keyId : null });
    return jsonResponse(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.startsWith('decision not found:') ? 404
      : message.startsWith('decision already closed:') ? 409
      : message.startsWith('option not found:') || message.startsWith('note ') ? 400 : 0;
    if (!status) throw error;
    const reason = status === 404 ? 'not-found' : status === 409 ? 'already-decided' : 'bad_request';
    debug.log('decisions.api', 'rejected', { id, reason });
    return jsonResponse({ error: reason }, status);
  }
}
