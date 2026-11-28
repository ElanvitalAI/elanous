// kit/release-preauth — RELEASE-PRESIGNED-AUTO (대표 11-28 14:4x «자기 전에 미리 서명 · 그 서명으로 자동 발행·서저리 발행»).
// Design: seat-state/OP/evidence/20261128/DESIGN-PRESIGNED-RELEASE.md.
// S: the release approval proof (#40665 · elanous-approval/v2) binds the cut sha, which exists only ~2h before publish.
// C: the CEO cannot approve a night release before sleeping; the on-green config switch is not a human proof.
// Q: how does a signature made before the cut authorize the publish of that cut — and only that night, only on green?
// A: a pre-authorization card. Its ref `release-preauth/<v>/<mode>/<fromZ>/<toZ>/<condSha12>` is what the same nexus
//    signer signs (owner tap · two-step confirm); the cut sha is recorded at use time. At publish, the card counts iff the
//    proof verifies · the version matches · now ∈ window · not revoked · not used for another cut · the mode's condition
//    list still hashes to condSha12 · every listed condition holds. All knobs live in graphs/policies/release-proof.yaml.
//
// 세 얼굴: 관측 = debug.log('release.preauth', …) ⊕ <state>/release/preauth/{uses,revocations}.jsonl ·
//          판단 근거 = the signed ref ⊕ the measured condition snapshot ·
//          수복과 인계 = a failed condition leaves the normal publish card for the CEO · revoke any time · the window closes itself.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { debug } from '../../debug/log.js';
import { checkHumanApprovalProof, type DecisionTrustRoot, type HumanProof, type HumanProofFailure, type RaiseInput } from '../../decisions/decision-ledger.js';
import { acquireLockSync } from '../../storage/file-lock.js';

export type PreAuthMode = 'auto' | 'surgery';
export const PREAUTH_MODES: readonly PreAuthMode[] = ['auto', 'surgery'];
/** The signer signs refs with this prefix (approval-signer proofWanted) — a protocol prefix, not a knob. */
export const PREAUTH_REF_PREFIX = 'release-preauth/';
export const PREAUTH_APPROVE = 'a';
/** Every condition a policy may list. An unknown id in the YAML makes the policy invalid (fail closed). */
export const CONDITION_IDS = ['red-0', 'critical-red-0', 'noncritical-red-waived', 'dry-run-exact-cut', 'open-hold-0', 'notes-present', 'cut-head-prepared'] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

export interface PreAuthPolicy {
  aroundSlotMin: number;
  slotsKst: string[];
  maxSpanMin: number;
  dryRunMaxAgeMin: number;
  criticalPriorities: string[];
  modes: Record<PreAuthMode, ConditionId[]>;
}

/** graphs/policies/release-proof.yaml — the repo copy next to this kit. */
export function preAuthPolicyPath(root = resolve(import.meta.dir, '../../..')): string { return join(root, 'graphs', 'policies', 'release-proof.yaml'); }

/** Parse the `preauth:` block. Throws on anything missing or unknown — a broken pack authorizes nothing. */
export function parsePreAuthPolicy(text: string): PreAuthPolicy {
  const y = (parse(text) ?? {}) as { version?: unknown; preauth?: Record<string, unknown> };
  if (y.version !== 1) throw new Error('release-proof policy: version must be 1');
  const p = y.preauth;
  if (!p || typeof p !== 'object') throw new Error('release-proof policy: preauth block missing');
  const pos = (v: unknown, key: string): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`release-proof policy: preauth.${key} must be a positive integer`); return v; };
  const w = (p.window ?? {}) as Record<string, unknown>;
  const slots = w.slots_kst;
  if (!Array.isArray(slots) || !slots.length || slots.some(s => typeof s !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))) throw new Error('release-proof policy: preauth.window.slots_kst must be HH:MM strings');
  const crit = p.critical_priorities;
  if (!Array.isArray(crit) || !crit.length || crit.some(c => typeof c !== 'string' || !c.trim())) throw new Error('release-proof policy: preauth.critical_priorities must be a nonempty list');
  const m = (p.modes ?? {}) as Record<string, unknown>;
  const modes = {} as Record<PreAuthMode, ConditionId[]>;
  for (const mode of PREAUTH_MODES) {
    const list = m[mode];
    if (!Array.isArray(list) || !list.length) throw new Error(`release-proof policy: preauth.modes.${mode} must be a nonempty list`);
    for (const id of list) if (!(CONDITION_IDS as readonly string[]).includes(id as string)) throw new Error(`release-proof policy: preauth.modes.${mode}: unknown condition ${String(id)}`);
    modes[mode] = list as ConditionId[];
  }
  return { aroundSlotMin: pos(w.around_slot_minutes, 'window.around_slot_minutes'), slotsKst: slots as string[], maxSpanMin: pos(w.max_span_minutes, 'window.max_span_minutes'),
    dryRunMaxAgeMin: pos(p.dry_run_max_age_minutes, 'dry_run_max_age_minutes'), criticalPriorities: crit as string[], modes };
}

export function loadPreAuthPolicy(path = preAuthPolicyPath()): PreAuthPolicy {
  if (!existsSync(path)) throw new Error(`release-proof policy missing: ${path}`);
  return parsePreAuthPolicy(readFileSync(path, 'utf8'));
}

/** The 12-hex digest of a mode's condition list — signed inside the ref, so a changed list needs a new signature. */
export function conditionsSha12(policy: PreAuthPolicy, mode: PreAuthMode): string {
  return createHash('sha256').update(JSON.stringify({ mode, conditions: policy.modes[mode] })).digest('hex').slice(0, 12);
}

export interface PreAuthRef { version: string; mode: PreAuthMode; from: string; to: string; cond: string }
const stamp = (iso: string): string => { const d = new Date(iso); if (!Number.isFinite(d.getTime())) throw new Error(`bad time: ${iso}`); return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
const unstamp = (s: string): string | null => {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`);
  return Number.isFinite(d.getTime()) && stamp(d.toISOString()) === s ? d.toISOString() : null;
};
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** `release-preauth/<v>/<mode>/<fromZ>/<toZ>/<condSha12>` — compact UTC stamps (no «.» runs the ledger redactor could eat). */
export function preAuthRef(r: PreAuthRef): string {
  if (!VERSION_RE.test(r.version)) throw new Error(`not a release version: ${r.version}`);
  if (!PREAUTH_MODES.includes(r.mode)) throw new Error(`unknown pre-auth mode: ${r.mode}`);
  if (!/^[0-9a-f]{12}$/.test(r.cond)) throw new Error('condition digest must be 12 hex');
  return `${PREAUTH_REF_PREFIX}${r.version}/${r.mode}/${stamp(r.from)}/${stamp(r.to)}/${r.cond}`;
}
export function parsePreAuthRef(ref: string): PreAuthRef | null {
  if (!ref.startsWith(PREAUTH_REF_PREFIX)) return null;
  const parts = ref.slice(PREAUTH_REF_PREFIX.length).split('/');
  if (parts.length !== 5) return null;
  const [version, mode, f, t, cond] = parts as [string, string, string, string, string];
  const from = unstamp(f); const to = unstamp(t);
  if (!VERSION_RE.test(version) || !PREAUTH_MODES.includes(mode as PreAuthMode) || !from || !to || !/^[0-9a-f]{12}$/.test(cond) || Date.parse(to) <= Date.parse(from)) return null;
  return { version, mode: mode as PreAuthMode, from, to, cond };
}

/** The next publish slot ± aroundSlotMin: the schedule's publishAt when it is still ahead, else the next KST slot. */
export function defaultWindow(policy: PreAuthPolicy, now: Date, publishAt?: string | null): { from: string; to: string; slot: string } {
  const around = policy.aroundSlotMin * 60_000;
  let slot = publishAt && Number.isFinite(Date.parse(publishAt)) && Date.parse(publishAt) + around > now.getTime() ? Date.parse(publishAt) : NaN;
  if (!Number.isFinite(slot)) {
    const kstOffset = 9 * 3_600_000; // not-policy: Asia/Seoul is UTC+9 with no DST
    const kstMidnight = Math.floor((now.getTime() + kstOffset) / 86_400_000) * 86_400_000 - kstOffset;
    const candidates = [0, 1].flatMap(day => policy.slotsKst.map(s => kstMidnight + day * 86_400_000 + (Number(s.slice(0, 2)) * 60 + Number(s.slice(3))) * 60_000));
    slot = candidates.filter(c => c + around > now.getTime()).sort((a, b) => a - b)[0]!;
  }
  return { from: new Date(slot - around).toISOString(), to: new Date(slot + around).toISOString(), slot: new Date(slot).toISOString() };
}

/** `2026-11-29 04:00` (KST) — no «. » runs: SCQA fields count sentences by periods. */
const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '); // not-policy: Asia/Seoul is UTC+9

/** The decision card the CEO signs ahead (category publish → the irreversible two-step confirm on TG/PWA). */
export function preAuthCard(r: PreAuthRef, policy: PreAuthPolicy, raisedBy = 'release-preauth'): RaiseInput {
  if (Date.parse(r.to) - Date.parse(r.from) > policy.maxSpanMin * 60_000) throw new Error(`pre-auth window wider than ${policy.maxSpanMin} min`);
  const ref = preAuthRef(r);
  const conds = policy.modes[r.mode].join(' · ');
  return {
    title: `Pre-authorize elanous v${r.version} ${r.mode} publish ${kst(r.from)}–${kst(r.to)} KST`,
    category: 'publish',
    scqa: {
      s: `Publish v${r.version} in ${r.mode} mode without waking you, only between ${kst(r.from)} and ${kst(r.to)} KST.`,
      c: `It counts only if ${conds} hold on the actual cut; any failure raises the normal publish card instead.`.slice(0, 240),
    },
    options: [
      { key: PREAUTH_APPROVE, label: `Pre-authorize v${r.version} (${r.mode})`, consequence: 'One publish of this version inside the window, on these conditions; revoke any time with /preauth 취소.' },
      { key: 'b', label: 'Not now', consequence: 'Nothing is pre-authorized; the publish card waits for you as before.' },
    ],
    recommendation: { skipped: true, reason: 'A pre-signed irreversible publication needs a human decision; it cannot be undone once used.' },
    raisedBy: { agent: raisedBy },
    refs: [ref],
  };
}

// ───────────────────────────── conditions ─────────────────────────────

export interface ChecklistRed { id: string; priority?: string; knownIssue?: string }
/** What the caller measured for this exact cut. An Error = could not read → that condition fails. */
export interface PreAuthFacts {
  binding: { version: string; cutSha: string; notesSha256: string };
  reds: ChecklistRed[] | Error;
  openHolds: string[] | Error;
  dryRunPass?: { cutSha: string; notesSha256: string; at: string };
  notesBytes: number | Error;
  preparedCommit: string;
  branchHead: string | Error;
  /** critpath --waive-reason (public text) — the surgery fallback reason for a non-critical red without its own. */
  waiveReason?: string;
}
export interface ConditionResult { ok: boolean; failures: string[]; snapshot: Record<string, string>; waivers: Array<{ id: string; reason: string }> }

const errText = (e: Error) => e.message.replace(/[\r\n]+/g, ' ').slice(0, 120);

export function evaluateConditions(mode: PreAuthMode, policy: PreAuthPolicy, f: PreAuthFacts, now: Date): ConditionResult {
  const failures: string[] = []; const snapshot: Record<string, string> = {}; const waivers: Array<{ id: string; reason: string }> = [];
  const critical = (r: ChecklistRed) => !r.priority || policy.criticalPriorities.includes(r.priority);
  for (const id of policy.modes[mode]) {
    if (id === 'red-0' || id === 'critical-red-0' || id === 'noncritical-red-waived') {
      if (f.reds instanceof Error) { failures.push(`${id}: checklist unreadable: ${errText(f.reds)}`); snapshot[id] = 'unreadable'; continue; }
      if (id === 'red-0') {
        if (f.reds.length) failures.push(`red-0: 🔴 ${f.reds.length} (${f.reds.map(r => r.id).join(', ')})`);
        snapshot[id] = `🔴 ${f.reds.length}`;
      } else if (id === 'critical-red-0') {
        const crit = f.reds.filter(critical);
        if (crit.length) failures.push(`critical-red-0: critical 🔴 ${crit.length} (${crit.map(r => r.id).join(', ')})`);
        snapshot[id] = `critical 🔴 ${crit.length}`;
      } else {
        const soft = f.reds.filter(r => !critical(r));
        const bare: string[] = [];
        for (const r of soft) {
          const reason = r.knownIssue?.trim() || f.waiveReason?.trim();
          if (reason) waivers.push({ id: r.id, reason: reason.replace(/[\r\n]+/g, ' ').slice(0, 240) }); else bare.push(r.id);
        }
        if (bare.length) failures.push(`noncritical-red-waived: no waiver reason for ${bare.join(', ')}`);
        snapshot[id] = `non-critical 🔴 ${soft.length} waived ${soft.length - bare.length}`;
      }
    } else if (id === 'dry-run-exact-cut') {
      const d = f.dryRunPass;
      if (!d) { failures.push('dry-run-exact-cut: no green dry run recorded'); snapshot[id] = 'dry-run none'; continue; }
      if (d.cutSha !== f.binding.cutSha || d.notesSha256 !== f.binding.notesSha256) { failures.push(`dry-run-exact-cut: dry run was for cut ${d.cutSha.slice(0, 12)} notes ${d.notesSha256.slice(0, 12)}`); snapshot[id] = 'dry-run other cut'; continue; }
      const age = now.getTime() - Date.parse(d.at);
      if (!(age >= 0 && age <= policy.dryRunMaxAgeMin * 60_000)) { failures.push(`dry-run-exact-cut: dry run stale (${d.at} · max ${policy.dryRunMaxAgeMin} min)`); snapshot[id] = 'dry-run stale'; continue; }
      snapshot[id] = `dry-run ✓ ${d.at}`;
    } else if (id === 'open-hold-0') {
      if (f.openHolds instanceof Error) { failures.push(`open-hold-0: decisions unreadable: ${errText(f.openHolds)}`); snapshot[id] = 'unreadable'; continue; }
      if (f.openHolds.length) failures.push(`open-hold-0: open HOLD ${f.openHolds.join(', ')}`);
      snapshot[id] = `HOLD ${f.openHolds.length}`;
    } else if (id === 'notes-present') {
      if (f.notesBytes instanceof Error) { failures.push(`notes-present: notes unreadable: ${errText(f.notesBytes)}`); snapshot[id] = 'unreadable'; continue; }
      if (f.notesBytes <= 0) failures.push('notes-present: notes empty');
      snapshot[id] = f.notesBytes > 0 ? `notes ✓ ${f.binding.notesSha256.slice(0, 12)}` : 'notes empty';
    } else {
      if (f.branchHead instanceof Error) { failures.push(`cut-head-prepared: branch-read-failed: ${errText(f.branchHead)}`); snapshot[id] = 'unreadable'; continue; }
      if (f.branchHead !== f.preparedCommit) failures.push(`cut-head-prepared: release/${f.binding.version} ${f.branchHead.slice(0, 12)} ≠ prepared ${f.preparedCommit.slice(0, 12)}`);
      snapshot[id] = f.branchHead === f.preparedCommit ? `cut head = prepared ${f.preparedCommit.slice(0, 12)}` : 'cut head moved';
    }
  }
  return { ok: failures.length === 0, failures, snapshot, waivers };
}

// ───────────────────────────── store: uses · revocations ─────────────────────────────

export interface PreAuthUse {
  preAuthId: string; version: string; mode: PreAuthMode; keyId: string; ref: string;
  cutSha: string; notesSha256: string; conditions: Record<string, string>; waivers: Array<{ id: string; reason: string }>; at: string;
  /** critpath | release-graph:go */
  by: string;
}
export interface PreAuthRevocation { preAuthId: string; by: string; reason: string; at: string }

export function preAuthPaths(stateDir: string) {
  const dir = join(stateDir, 'release', 'preauth');
  return { dir, uses: join(dir, 'uses.jsonl'), revocations: join(dir, 'revocations.jsonl'), lock: join(dir, '.lock') };
}
/** Fail closed (Terra r1): an unparseable row could be a lost revocation or use — refuse to judge rather than skip it. */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line) as T); }
    catch { throw new Error(`preauth store corrupt: ${path} line ${i + 1} — check it, then move the file aside (a pre-auth stays unusable until then)`); }
  });
  return rows;
}
/** Append one JSON row; a torn previous row (no trailing newline) is closed first so this row stays parseable on its own. */
function appendRow(path: string, row: unknown): void {
  let lead = '';
  try { if (existsSync(path)) { const text = readFileSync(path, 'utf8'); if (text.length && !text.endsWith('\n')) lead = '\n'; } } catch { lead = '\n'; }
  appendFileSync(path, `${lead}${JSON.stringify(row)}\n`, { mode: 0o600 });
}
export function readPreAuthUses(stateDir: string): PreAuthUse[] { return readJsonl<PreAuthUse>(preAuthPaths(stateDir).uses); }
export function readPreAuthRevocations(stateDir: string): PreAuthRevocation[] { return readJsonl<PreAuthRevocation>(preAuthPaths(stateDir).revocations); }

/** Revoking only removes authority — no proof needed. Idempotent: an already revoked id is reported, not appended. */
export function revokePreAuth(stateDir: string, preAuthId: string, by: string, reason: string, now: Date): { revoked: boolean; already: boolean } {
  if (!/^D-[0-9A-Za-z-]+$/.test(preAuthId)) throw new Error(`not a decision id: ${preAuthId}`);
  const p = preAuthPaths(stateDir);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const release = acquireLockSync(p.lock);
  try {
    // A corrupt store still takes the revocation (it only removes authority); reads stay closed until it is repaired.
    let prior: PreAuthRevocation[] = [];
    try { prior = readPreAuthRevocations(stateDir); } catch { prior = []; }
    if (prior.some(r => r.preAuthId === preAuthId)) return { revoked: true, already: true };
    const row: PreAuthRevocation = { preAuthId, by: by.slice(0, 80), reason: reason.replace(/[\r\n]+/g, ' ').slice(0, 240), at: now.toISOString() };
    appendRow(p.revocations, row);
    debug.log('release.preauth', 'revoked', { preAuthId, by: row.by });
    return { revoked: true, already: false };
  } finally { release(); }
}

/**
 * Single use per version, under the lock: another binding (cut ⊕ notes) already used for this version → refused;
 * the same binding again (a rerun after npm 202, a graph tick then critpath) → ok, not fresh (no second row, no second line).
 */
export function recordPreAuthUse(stateDir: string, use: PreAuthUse): { ok: true; fresh: boolean } | { ok: false; reason: string } {
  const p = preAuthPaths(stateDir);
  try {
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const release = acquireLockSync(p.lock);
    try {
      // Same lock as revokePreAuth (Terra r1): a revocation that landed after the judge is seen here, before the use is written.
      if (readPreAuthRevocations(stateDir).some(r => r.preAuthId === use.preAuthId)) return { ok: false, reason: 'revoked' };
      const prior = readPreAuthUses(stateDir).filter(u => u.version === use.version);
      const other = prior.find(u => u.cutSha !== use.cutSha || u.notesSha256 !== use.notesSha256);
      if (other) return { ok: false, reason: `already-used:${other.cutSha.slice(0, 12)}` };
      if (prior.length) return { ok: true, fresh: false };
      appendRow(p.uses, use);
      debug.log('release.preauth', 'used', { preAuthId: use.preAuthId, version: use.version, mode: use.mode, cut: use.cutSha, by: use.by });
      return { ok: true, fresh: true };
    } finally { release(); }
  } catch (e) { return { ok: false, reason: `use-record-failed: ${e instanceof Error ? errText(e) : 'unknown'}` }; }
}

// ───────────────────────────── resolve ─────────────────────────────

/** The slice of a decision-ledger entry this kit reads. */
export interface PreAuthRecord {
  id: string; refs?: string[]; status: string; raisedAt?: string; decidedAt?: string; choice?: string;
  /** What the CEO read on the card — must be exactly what this kit renders for the signed ref (no misleading text over a wide ref). */
  title?: string; category?: string; scqa?: { s: string; c: string };
  decidedBy?: { kind: string; via?: string; platformUserId?: string }; proof?: HumanProof;
}
export type PreAuthRefusal = `unverified:${HumanProofFailure}` | 'open' | 'declined' | 'window-not-open' | 'window-passed' | 'revoked' | 'conditions-changed' | `already-used:${string}` | `conditions: ${string}`;
export interface PreAuthHit { id: string; mode: PreAuthMode; keyId: string; ref: string; window: { from: string; to: string }; result: ConditionResult }
export interface PreAuthResolution { hit?: PreAuthHit; tried: Array<{ id: string; mode?: PreAuthMode; reason: PreAuthRefusal | string }> }

/** All pre-auth cards of this version, newest first; the first one that passes every check wins. Pure over its inputs. */
export function resolvePreAuth(input: {
  version: string; records: readonly PreAuthRecord[]; trustRoots: readonly DecisionTrustRoot[] | undefined; now: Date; policy: PreAuthPolicy;
  uses: readonly PreAuthUse[]; revocations: readonly PreAuthRevocation[]; facts: PreAuthFacts; modes?: readonly PreAuthMode[];
}): PreAuthResolution {
  const tried: PreAuthResolution['tried'] = [];
  const now = input.now.getTime();
  const cards = input.records
    .map(r => ({ r, ref: r.refs?.find(x => x.startsWith(`${PREAUTH_REF_PREFIX}${input.version}/`)) }))
    .filter((x): x is { r: PreAuthRecord; ref: string } => Boolean(x.ref))
    .sort((a, b) => (b.r.decidedAt ?? b.r.raisedAt ?? '').localeCompare(a.r.decidedAt ?? a.r.raisedAt ?? ''));
  for (const { r, ref } of cards) {
    const parsed = parsePreAuthRef(ref);
    if (!parsed || parsed.version !== input.version) { tried.push({ id: r.id, reason: 'bad-ref' }); continue; }
    const t = (reason: PreAuthRefusal | string) => tried.push({ id: r.id, mode: parsed.mode, reason });
    if (input.modes && !input.modes.includes(parsed.mode)) { t(`mode ${parsed.mode} not accepted here`); continue; }
    // The signature covers the ref, not the card text: a card raised outside raisePreAuth (a wider window, another mode
    // than its title says) must not count. Re-render the card for the signed ref and compare what the CEO read.
    let expected: RaiseInput | null = null;
    try { expected = preAuthCard(parsed, input.policy); } catch { t('window-too-wide'); continue; }
    if (r.category !== 'publish' || r.title !== expected.title || r.scqa?.s !== expected.scqa.s || r.scqa?.c !== expected.scqa.c) { t('card-mismatch'); continue; }
    if (r.status === 'open') { t('open'); continue; }
    if (r.status !== 'decided' || r.choice !== PREAUTH_APPROVE) { t('declined'); continue; }
    const proof = checkHumanApprovalProof(r, ref, input.trustRoots);
    if (!proof.ok) { t(`unverified:${proof.reason}`); continue; }
    if (now < Date.parse(parsed.from)) { t('window-not-open'); continue; }
    if (now > Date.parse(parsed.to)) { t('window-passed'); continue; }
    if (input.revocations.some(x => x.preAuthId === r.id)) { t('revoked'); continue; }
    const other = input.uses.find(u => u.version === input.version && (u.cutSha !== input.facts.binding.cutSha || u.notesSha256 !== input.facts.binding.notesSha256));
    if (other) { t(`already-used:${other.cutSha.slice(0, 12)}`); continue; }
    if (conditionsSha12(input.policy, parsed.mode) !== parsed.cond) { t('conditions-changed'); continue; }
    const result = evaluateConditions(parsed.mode, input.policy, input.facts, input.now);
    if (!result.ok) { t(`conditions: ${result.failures.join('; ')}`); continue; }
    return { hit: { id: r.id, mode: parsed.mode, keyId: proof.keyId, ref, window: { from: parsed.from, to: parsed.to }, result }, tried };
  }
  return { tried };
}

/** One line for the CEO channel and OP mail (also the critpath ledger detail). */
export function preAuthUseLine(use: Pick<PreAuthUse, 'preAuthId' | 'version' | 'mode' | 'cutSha' | 'conditions' | 'waivers'>): string {
  const waived = use.waivers.length ? ` · 면제 ${use.waivers.map(w => `${w.id}(${w.reason.slice(0, 60)})`).join(', ')}` : '';
  return `사전 승인 ${use.preAuthId} 로 v${use.version} 발행 (${use.mode}, cut ${use.cutSha.slice(0, 12)}, 조건 ${Object.values(use.conditions).join(' · ')}${waived})`;
}

/** The I/O a gate needs; the CLI wires the real ledger/checklist/telegram, sims wire their universe. */
export interface PreAuthGateIo {
  stateDir: string;
  records(): readonly PreAuthRecord[];
  trustRoots(): readonly DecisionTrustRoot[];
  policy(): PreAuthPolicy;
  reds(version: string): ChecklistRed[] | Promise<ChecklistRed[]>;
  openHolds(version: string): string[] | Promise<string[]>;
  /** CEO channel ⊕ OP mail · failure never blocks (after-the-fact report). */
  notify(line: string, key: string): void | Promise<void>;
  now?: () => Date;
}
export interface PreAuthGateInput {
  binding: { version: string; cutSha: string; notesSha256: string };
  preparedCommit: string; branchHead: string | Error; notesFile: string;
  dryRunPass?: { cutSha: string; notesSha256: string; at: string }; waiveReason?: string;
  modes?: readonly PreAuthMode[];
}
export type PreAuthGateOutcome = { ok: true; use: PreAuthUse; fresh: boolean; hit: PreAuthHit } | { ok: false; reasons: string[] };

const attempt = async <T>(f: () => T | Promise<T>): Promise<T | Error> => { try { return await f(); } catch (e) { return e instanceof Error ? e : new Error(String(e)); } };

/**
 * Resolve ⊕ (record) ⊕ notify for one binding. `record: false` judges only (dry run · shadow graph).
 * Fail closed everywhere: a policy error, an unreadable fact or a failed use record = no pre-authorization.
 */
export async function preAuthGate(io: PreAuthGateIo, input: PreAuthGateInput, opts: { record: boolean; by: string }): Promise<PreAuthGateOutcome> {
  const now = (io.now ?? (() => new Date()))();
  const policy = await attempt(() => io.policy());
  if (policy instanceof Error) return { ok: false, reasons: [`policy: ${errText(policy)}`] };
  const records = await attempt(() => io.records());
  if (records instanceof Error) return { ok: false, reasons: [`decisions unreadable: ${errText(records)}`] };
  if (!records.some(r => r.refs?.some(x => x.startsWith(`${PREAUTH_REF_PREFIX}${input.binding.version}/`)))) return { ok: false, reasons: [] };
  const v = input.binding.version;
  const notesBytes = await attempt(() => readFileSync(input.notesFile).toString('utf8').trim().length);
  const facts: PreAuthFacts = {
    binding: input.binding, reds: await attempt(() => io.reds(v)), openHolds: await attempt(() => io.openHolds(v)), dryRunPass: input.dryRunPass,
    notesBytes, preparedCommit: input.preparedCommit, branchHead: input.branchHead, ...(input.waiveReason ? { waiveReason: input.waiveReason } : {}),
  };
  const uses = await attempt(() => readPreAuthUses(io.stateDir));
  const revocations = await attempt(() => readPreAuthRevocations(io.stateDir));
  if (uses instanceof Error || revocations instanceof Error) return { ok: false, reasons: [`store: ${errText(uses instanceof Error ? uses : revocations as Error)}`] };
  const r = resolvePreAuth({ version: v, records, trustRoots: await attempt(() => io.trustRoots()).then(x => x instanceof Error ? [] : x), now, policy,
    uses, revocations, facts, ...(input.modes ? { modes: input.modes } : {}) });
  const reasons = r.tried.map(x => `${x.id}${x.mode ? `(${x.mode})` : ''}: ${x.reason}`);
  if (!r.hit) { debug.log('release.preauth', 'skipped', { version: v, cut: input.binding.cutSha, reasons }); return { ok: false, reasons }; }
  const use: PreAuthUse = { preAuthId: r.hit.id, version: v, mode: r.hit.mode, keyId: r.hit.keyId, ref: r.hit.ref, cutSha: input.binding.cutSha,
    notesSha256: input.binding.notesSha256, conditions: r.hit.result.snapshot, waivers: r.hit.result.waivers, at: now.toISOString(), by: opts.by };
  if (!opts.record) return { ok: true, use, fresh: false, hit: r.hit };
  const rec = recordPreAuthUse(io.stateDir, use);
  if (!rec.ok) { debug.log('release.preauth', 'skipped', { version: v, cut: input.binding.cutSha, reasons: [rec.reason] }); return { ok: false, reasons: [`${r.hit.id}(${r.hit.mode}): ${rec.reason}`] }; }
  if (rec.fresh) {
    try { await io.notify(preAuthUseLine(use), `release-preauth:${use.preAuthId}:${use.cutSha}`); }
    catch (e) { debug.log('release.preauth', 'notify-failed', { preAuthId: use.preAuthId, reason: e instanceof Error ? errText(e) : 'unknown' }, { level: 'warn' }); }
  }
  return { ok: true, use, fresh: rec.fresh, hit: r.hit };
}

// ───────────────────────────── raise · list (CLI ⊕ TG share these) ─────────────────────────────

/** Raise (or return the same) pre-auth card. No window → the next publish slot ± policy minutes. */
export function raisePreAuth(ledger: { raiseOnce(input: RaiseInput, ref: string): { id: string; refs?: string[]; status: string } }, policy: PreAuthPolicy,
  input: { version: string; mode: PreAuthMode; from?: string; to?: string; publishAt?: string | null; now: Date; raisedBy?: string }): { id: string; ref: string; from: string; to: string; status: string } {
  if (!PREAUTH_MODES.includes(input.mode)) throw new Error(`mode must be auto or surgery: ${String(input.mode)}`);
  if (Boolean(input.from) !== Boolean(input.to)) throw new Error('give both --from and --to, or neither');
  const w = input.from && input.to ? { from: new Date(input.from).toISOString(), to: new Date(input.to).toISOString() } : defaultWindow(policy, input.now, input.publishAt);
  if (!(Date.parse(w.to) > Date.parse(w.from))) throw new Error('window end must be after its start');
  if (Date.parse(w.to) <= input.now.getTime()) throw new Error(`window already passed (${w.to})`);
  const r: PreAuthRef = { version: input.version, mode: input.mode, from: w.from, to: w.to, cond: conditionsSha12(policy, input.mode) };
  const card = preAuthCard(r, policy, input.raisedBy);
  const ref = preAuthRef(r);
  const entry = ledger.raiseOnce(card, ref);
  debug.log('release.preauth', 'raised', { id: entry.id, version: r.version, mode: r.mode, from: w.from, to: w.to });
  return { id: entry.id, ref, from: parsePreAuthRef(ref)!.from, to: parsePreAuthRef(ref)!.to, status: entry.status };
}

export type PreAuthListState = 'awaiting-signature' | 'declined' | 'unsigned' | 'scheduled' | 'active' | 'expired' | 'revoked' | 'used';
export interface PreAuthListRow { id: string; version: string; mode: PreAuthMode; from: string; to: string; state: PreAuthListState; detail?: string }

/** Every pre-auth card with its state now (no condition measurement — that happens at publish time). */
export function listPreAuth(input: { records: readonly PreAuthRecord[]; trustRoots: readonly DecisionTrustRoot[] | undefined; uses: readonly PreAuthUse[];
  revocations: readonly PreAuthRevocation[]; now: Date; version?: string }): PreAuthListRow[] {
  const rows: PreAuthListRow[] = [];
  for (const r of input.records) {
    const ref = r.refs?.find(x => x.startsWith(PREAUTH_REF_PREFIX));
    const p = ref ? parsePreAuthRef(ref) : null;
    if (!ref || !p || (input.version && p.version !== input.version)) continue;
    const base = { id: r.id, version: p.version, mode: p.mode, from: p.from, to: p.to };
    const used = input.uses.find(u => u.preAuthId === r.id);
    let state: PreAuthListState; let detail: string | undefined;
    if (r.status === 'open') state = 'awaiting-signature';
    else if (r.status !== 'decided' || r.choice !== PREAUTH_APPROVE) state = 'declined';
    else {
      const proof = checkHumanApprovalProof(r, ref, input.trustRoots);
      if (!proof.ok) { state = 'unsigned'; detail = proof.reason; }
      else if (input.revocations.some(x => x.preAuthId === r.id)) state = 'revoked';
      else if (used) { state = 'used'; detail = `cut ${used.cutSha.slice(0, 12)} · ${used.at}`; }
      else if (input.now.getTime() > Date.parse(p.to)) state = 'expired';
      else if (input.now.getTime() < Date.parse(p.from)) state = 'scheduled';
      else state = 'active';
    }
    rows.push({ ...base, state, ...(detail ? { detail } : {}) });
  }
  return rows;
}

export function formatPreAuthRow(r: PreAuthListRow): string {
  return `${r.id} · v${r.version} ${r.mode} · ${kst(r.from)}–${kst(r.to)} KST · ${r.state}${r.detail ? ` (${r.detail})` : ''}`;
}
