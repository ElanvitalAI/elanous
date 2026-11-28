// KIT mail-route · notice — «does this mail wait on a reply?» from structured fields (SILENCE-NOTICE-NOT-REQUEST · 0.3.39).
//
// S: 189 of silence-watch's 511 open «requests» (live census 11-28) were work-block notices stored as intent=request ⊕
//    needsAck — the KPI unanswered_mail_past_sla could not move for 27 h.
// C: «is it a notice» was decided per producer (each passed its own intent) and per reader (silence-watch kept its own kind
//    list) — two answers to one question.
// A: one shared reader of ONE policy file (notice-policy.yaml next to this file): the post path's needsAck default
//    (msg-store) and silence-watch's SLA both call `isNoticeMail`. Kind ⊕ refs only — the body is never read.
//    세 얼굴: 관측 = the envelope's kind/refs · 판단 근거 = notice-policy.yaml · 수복과 인계 = an unreadable policy reads as
//    «no notices» (everything waits on a reply, the pre-policy behaviour) — never as «everything is a notice».
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { MSG_POST_KIND_ALIASES, canonicalPostKind } from '../../msg/post-discipline.js';

export interface NoticeShape { readonly kind: string; readonly refPrefix: string; readonly why: string }
export interface NoticePolicy { readonly passiveKinds: readonly string[]; readonly shapes: readonly NoticeShape[]; readonly keepOpenFor: readonly string[] }
/** What the post path and the SLA read of one mail (structured fields only). */
export interface NoticeProbe { readonly kind?: string | null; readonly refs?: readonly string[] | null }

export const NOTICE_POLICY_FILE = join(import.meta.dir, 'notice-policy.yaml');
const EMPTY: NoticePolicy = { passiveKinds: [], shapes: [], keepOpenFor: [] };
const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Parse the policy object; anything malformed is dropped (fail toward «not a notice»). Pure. */
export function noticePolicyFrom(raw: unknown): NoticePolicy {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const passiveKinds = Array.isArray(o.passiveKinds) ? o.passiveKinds.map(lower).filter(Boolean) : [];
  const shapes = Array.isArray(o.shapes) ? o.shapes.flatMap((s): NoticeShape[] => {
    const r = s && typeof s === 'object' ? s as Record<string, unknown> : {};
    const kind = lower(r.kind); const refPrefix = typeof r.refPrefix === 'string' ? r.refPrefix.trim() : '';
    return kind && refPrefix ? [{ kind, refPrefix, why: typeof r.why === 'string' ? r.why : '' }] : [];
  }) : [];
  const keepOpenFor = Array.isArray(o.keepOpenFor) ? o.keepOpenFor.filter((a): a is string => typeof a === 'string').map(a => a.trim().toUpperCase()).filter(Boolean) : [];
  return { passiveKinds, shapes, keepOpenFor };
}

const cache = new Map<string, { mtimeMs: number; policy: NoticePolicy }>();
/** The policy in force (re-read when the file changes). Unreadable → no notices. */
export function readNoticePolicy(file: string = NOTICE_POLICY_FILE): NoticePolicy {
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { cache.delete(file); return EMPTY; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.policy;
  let policy = EMPTY;
  try { policy = noticePolicyFrom(parse(readFileSync(file, 'utf8'))); } catch { /* invalid YAML = no notices */ }
  cache.set(file, { mtimeMs, policy });
  return policy;
}

/** Stored kinds that are passive: the canonical passive kinds ⊕ every alias of one (SQL pre-filter · lower-case). */
export function passiveStoredKinds(policy: NoticePolicy = readNoticePolicy()): string[] {
  const out = new Set(policy.passiveKinds);
  for (const [alias, canonical] of Object.entries(MSG_POST_KIND_ALIASES)) if (out.has(canonical)) out.add(alias);
  return [...out];
}

/** Why this mail is a notice (null = it may wait on a reply). */
export function noticeReason(m: NoticeProbe, policy: NoticePolicy = readNoticePolicy()): string | null {
  const kind = lower(m.kind);
  if (!kind) return null;
  const cls = canonicalPostKind(kind);
  if (policy.passiveKinds.includes(kind) || (cls !== null && policy.passiveKinds.includes(cls))) return `kind:${kind}`;
  const shape = policy.shapes.find(s => s.kind === kind && (m.refs ?? []).some(r => r.startsWith(s.refPrefix)));
  return shape ? `${shape.kind}+${shape.refPrefix}` : null;
}

/** May an agent close a notice on this address's behalf (false = a person's inbox · keepOpenFor)? */
export function mayCloseNoticeFor(address: string, policy: NoticePolicy = readNoticePolicy()): boolean {
  return !policy.keepOpenFor.includes(address.trim().toUpperCase());
}

export function isNoticeMail(m: NoticeProbe, policy?: NoticePolicy): boolean {
  return noticeReason(m, policy) !== null;
}

/** The post path's needsAck default: a decision always waits on its ack (a ✋ answer · `reply` ⊕ intent decision); a
 *  request waits unless the notice policy says it informs; info · alert never do (SEAT-INBOX-PROTOCOL B1-A). */
export function defaultNeedsAck(intent: string | null | undefined, m: NoticeProbe, policy?: NoticePolicy): boolean {
  if (intent === 'decision') return true;
  return intent === 'request' && !isNoticeMail(m, policy);
}
