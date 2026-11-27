// kit/case-ledger — DETECT-TO-ACTION (대표 11-27 «보기만 하고 액션이 없으면 완료가 안 되니 그런 일이 없도록 체계를» · «1. 본다
// 2. 문제가 있을 경우 정상화를 한다»): every thing a supervisor detects is a CASE with an owner and an SLA. Reconcile-style:
// the detector declares the NORMAL state and an ordered ladder of NORMALIZE actions; each normalize attempt is an `acting`
// row; the case is `resolved` only when the normal state is OBSERVED again; `escalated` (one card to the owner) is the last
// resort — the ladder is exhausted, the case is out of policy, or the SLA passed. A case never stays «seen». First user:
// run-doctor's loop lane (LOOP-EXCEPTION-WATCH · src/loop-agent/bodies/loop-exceptions.ts); the general version (a case
// ledger every agent writes through · lint «every detection rule declares an action or an escalation path») is cell
// DETECT-TO-ACTION — it grows this kit, it does not replace it.
//
// 세 얼굴: 관측 = `<stateRoot>/cases/<domain>.jsonl` (one append-only row per transition · kit/audit-ledger writes it) ⊕
// `openCases` / `overdueCases` (the «미조치 사건» number the guardian KPI and the OP world card show) / 판단 근거 = the
// transition table below (no other move is written) ⊕ the case's own slaMin / 수복과 인계 = the caller acts (retry ·
// card) and records the move; a write that fails returns null (fail-soft — the detection still happened, the next tick
// writes it again because the case is still not in the ledger).
import { join } from 'node:path';
import { appendAuditSafe, readAuditTail } from '../audit-ledger/index.js';

export type CaseState = 'detected' | 'acting' | 'resolved' | 'escalated';
export const CASE_SCHEMA = 'case-ledger/1';
/** Allowed moves — anything else is refused (never written). A closed case reopens only through a new detection. */
const MOVES: Readonly<Record<CaseState, readonly CaseState[]>> = {
  detected: ['acting', 'resolved', 'escalated'],
  acting: ['resolved', 'escalated'],
  resolved: ['detected'],
  escalated: ['resolved', 'detected'],
};
export const isOpen = (s: CaseState): boolean => s === 'detected' || s === 'acting';

export interface CaseRow {
  readonly schema?: string; readonly ts?: string;
  readonly id: string; readonly domain: string; readonly state: CaseState; readonly at: string; readonly by: string; readonly why: string;
  readonly subject?: string; readonly owner?: string; readonly slaMin?: number; readonly refs?: readonly string[];
}
export interface Case {
  readonly id: string; readonly domain: string; readonly subject: string; readonly owner: string; readonly slaMin: number;
  readonly state: CaseState; readonly detectedAt: string; readonly updatedAt: string;
  readonly history: ReadonlyArray<{ state: CaseState; at: string; by: string; why: string }>;
}

const DOMAIN_RE = /^[a-z][a-z0-9-]{0,62}$/u;
export function casePath(stateRoot: string, domain: string): string {
  if (!DOMAIN_RE.test(domain)) throw new Error(`case domain ${JSON.stringify(domain)} is not a slug`);
  return join(stateRoot, 'cases', `${domain}.jsonl`);
}

/** Fold the ledger rows into the latest case per id (the last `detected` row carries subject · owner · SLA). */
export function foldCases(rows: readonly CaseRow[]): Case[] {
  const by = new Map<string, Case>();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !r.state) continue;
    const prev = by.get(r.id);
    if (r.state === 'detected') {
      by.set(r.id, { id: r.id, domain: r.domain, subject: r.subject ?? prev?.subject ?? r.id, owner: r.owner ?? prev?.owner ?? '?', slaMin: r.slaMin ?? prev?.slaMin ?? 60,
        state: 'detected', detectedAt: r.at, updatedAt: r.at, history: [...(prev?.history ?? []), { state: r.state, at: r.at, by: r.by, why: r.why }] });
    } else if (prev) {
      by.set(r.id, { ...prev, state: r.state, updatedAt: r.at, history: [...prev.history, { state: r.state, at: r.at, by: r.by, why: r.why }] });
    }
  }
  return [...by.values()];
}

export function readCases(stateRoot: string, domain: string, limit = 5000): Case[] {
  return foldCases(readAuditTail<CaseRow>(casePath(stateRoot, domain), limit));
}

function write(stateRoot: string, row: CaseRow): boolean {
  return appendAuditSafe(casePath(stateRoot, row.domain), CASE_SCHEMA, row as unknown as Record<string, unknown>);
}

/** Open (or re-open) a case on detection. Idempotent: a case that is not resolved yet (detected · acting · escalated) is
 *  returned as is — nothing written; only a resolved case reopens on a new detection. */
export function openCase(stateRoot: string, c: { domain: string; id: string; subject: string; owner: string; slaMin: number; by: string; why: string; refs?: readonly string[] }, now: Date): Case | null {
  const cur = readCases(stateRoot, c.domain).find(x => x.id === c.id);
  if (cur && cur.state !== 'resolved') return cur;
  const row: CaseRow = { id: c.id, domain: c.domain, state: 'detected', at: now.toISOString(), by: c.by, why: c.why, subject: c.subject, owner: c.owner, slaMin: c.slaMin, ...(c.refs?.length ? { refs: c.refs } : {}) };
  if (!write(stateRoot, row)) return null;
  return readCases(stateRoot, c.domain).find(x => x.id === c.id) ?? null;
}

/** Move a case (only along MOVES). The same state twice writes nothing — except `acting`, which records one more normalize
 *  attempt each time. Returns the case after the move, or null (unknown · refused · write failed). */
export function moveCase(stateRoot: string, domain: string, id: string, to: CaseState, m: { by: string; why: string; refs?: readonly string[] }, now: Date): Case | null {
  const cur = readCases(stateRoot, domain).find(x => x.id === id);
  if (!cur) return null;
  if (cur.state === to && to !== 'acting') return cur;
  if (cur.state !== to && !MOVES[cur.state].includes(to)) return null;
  if (!write(stateRoot, { id, domain, state: to, at: now.toISOString(), by: m.by, why: m.why, ...(m.refs?.length ? { refs: m.refs } : {}) })) return null;
  return readCases(stateRoot, domain).find(x => x.id === id) ?? null;
}

export const openCases = (cases: readonly Case[]): Case[] => cases.filter(c => isOpen(c.state));
/** Not normal yet — open or escalated (an escalated case is the owner's now, but it is not normalized). */
export const unresolvedCases = (cases: readonly Case[]): Case[] => cases.filter(c => c.state !== 'resolved');
/** Normalize attempts made on the case since it was (last) detected. */
export const attemptsOf = (c: Case): number => { let n = 0; for (const h of c.history) { if (h.state === 'detected') n = 0; else if (h.state === 'acting') n += 1; } return n; };
/** Open cases past their SLA (since detection) — the caller escalates these; none may stay «seen». */
export const overdueCases = (cases: readonly Case[], now: Date): Case[] =>
  openCases(cases).filter(c => now.getTime() - Date.parse(c.detectedAt) > c.slaMin * 60_000);

/** «미정상화 사건» (every case not resolved — open or escalated) across every domain under `<stateRoot>/cases/` (the guardian
 *  KPI · OP world card · target 0) · `overdue` = open past SLA (the caller must escalate) · null = unreadable. */
export function unnormalizedCases(stateRoot: string, now: Date = new Date()): { open: number; overdue: number; ids: string[] } | null {
  try {
    const { existsSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const dir = join(stateRoot, 'cases');
    if (!existsSync(dir)) return { open: 0, overdue: 0, ids: [] };
    const all = readdirSync(dir).filter(f => /^[a-z][a-z0-9-]{0,62}\.jsonl$/u.test(f)).flatMap(f => readCases(stateRoot, f.slice(0, -'.jsonl'.length)));
    const open = unresolvedCases(all);
    return { open: open.length, overdue: overdueCases(all, now).length, ids: open.map(c => c.id).sort() };
  } catch { return null; }
}
