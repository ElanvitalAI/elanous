// kit/release-preauth — policy · ref · window · conditions · single use · revoke · list. Expected values are literals (rule 11).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conditionsSha12, defaultWindow, evaluateConditions, listPreAuth, loadPreAuthPolicy, parsePreAuthPolicy, parsePreAuthRef, preAuthCard, preAuthGate, preAuthRef,
  preAuthUseLine, readPreAuthRevocations, readPreAuthUses, recordPreAuthUse, resolvePreAuth, revokePreAuth, type PreAuthFacts, type PreAuthUse,
} from './index.js';
import { proofWanted } from '../../decisions/approval-signer.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'kit-preauth-')); made.push(d); return d; };
const policy = loadPreAuthPolicy();
const CUT = '9126baa991f0'.padEnd(40, '1');
const NOTES = 'a'.repeat(64);
const facts = (over: Partial<PreAuthFacts> = {}): PreAuthFacts => ({
  binding: { version: '0.3.39', cutSha: CUT, notesSha256: NOTES }, reds: [], openHolds: [],
  dryRunPass: { cutSha: CUT, notesSha256: NOTES, at: '2026-11-28T20:30:00.000Z' }, notesBytes: 120, preparedCommit: CUT, branchHead: CUT, ...over,
});
const at = new Date('2026-11-28T21:00:00.000Z');

describe('policy (graphs/policies/release-proof.yaml preauth:)', () => {
  test('the repo pack parses to the documented defaults', () => {
    expect(policy).toEqual({ aroundSlotMin: 120, slotsKst: ['06:00', '18:00'], maxSpanMin: 1440, dryRunMaxAgeMin: 360, criticalPriorities: ['P0'], // 출처: #40665 graphs/policies/release-proof.yaml preauth (shipped values · RELEASE-PRESIGNED-AUTO)
      modes: { auto: ['red-0', 'dry-run-exact-cut', 'open-hold-0', 'notes-present', 'cut-head-prepared'],
        surgery: ['critical-red-0', 'noncritical-red-waived', 'dry-run-exact-cut', 'open-hold-0', 'notes-present', 'cut-head-prepared'] } });
  });
  test('an unknown condition id or a missing block refuses the whole policy', () => {
    const base = 'version: 1\npreauth:\n  window: { around_slot_minutes: 120, slots_kst: ["06:00"], max_span_minutes: 1440 }\n  dry_run_max_age_minutes: 360\n  critical_priorities: [P0]\n';
    expect(() => parsePreAuthPolicy(`${base}  modes: { auto: [red-0, trust-me], surgery: [critical-red-0] }\n`)).toThrow('preauth.modes.auto: unknown condition trust-me');
    expect(() => parsePreAuthPolicy('version: 1\n')).toThrow('preauth block missing');
    expect(() => parsePreAuthPolicy(`${base}  modes: { auto: [red-0] }\n`)).toThrow('preauth.modes.surgery must be a nonempty list');
  });
  test('the condition digest changes when the list changes', () => {
    const other = { ...policy, modes: { ...policy.modes, auto: ['red-0' as const] } };
    expect(conditionsSha12(policy, 'auto')).toMatch(/^[0-9a-f]{12}$/);
    expect(conditionsSha12(other, 'auto')).not.toBe(conditionsSha12(policy, 'auto'));
    expect(conditionsSha12(policy, 'surgery')).not.toBe(conditionsSha12(policy, 'auto'));
  });
});

describe('ref · window · card', () => {
  test('ref round-trips with compact UTC stamps and the signer wants it', () => {
    const ref = preAuthRef({ version: '0.3.39', mode: 'auto', from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', cond: 'abcdef012345' });
    expect(ref).toBe('release-preauth/0.3.39/auto/20261128T190000Z/20261128T230000Z/abcdef012345');
    expect(parsePreAuthRef(ref)).toEqual({ version: '0.3.39', mode: 'auto', from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', cond: 'abcdef012345' });
    expect(proofWanted({ refs: [ref] }, 'a')).toBe(ref);
    expect(proofWanted({ refs: [ref] }, 'b')).toBeNull();
    expect(parsePreAuthRef('release-preauth/0.3.39/yolo/20261128T190000Z/20261128T230000Z/abcdef012345')).toBeNull();
    expect(parsePreAuthRef('release-preauth/0.3.39/auto/20261128T230000Z/20261128T190000Z/abcdef012345')).toBeNull();
  });
  test('default window = schedule publishAt ±120 min; without a schedule the next KST slot (06:00 → 21:00Z)', () => {
    expect(defaultWindow(policy, new Date('2026-11-28T13:30:00.000Z'), '2026-11-28T21:00:00.000Z')).toEqual({ from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', slot: '2026-11-28T21:00:00.000Z' });
    // 22:30 KST, no schedule → next slot 06:00 KST
    expect(defaultWindow(policy, new Date('2026-11-28T13:30:00.000Z'), null).slot).toBe('2026-11-28T21:00:00.000Z');
    // 10:00 KST → 18:00 KST the same day
    expect(defaultWindow(policy, new Date('2026-11-29T01:00:00.000Z'), null).slot).toBe('2026-11-29T09:00:00.000Z');
  });
  test('card = publish category (two-step confirm) · window wider than max span refused', () => {
    const r = { version: '0.3.39', mode: 'surgery' as const, from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', cond: conditionsSha12(policy, 'surgery') };
    const card = preAuthCard(r, policy);
    expect(card.category).toBe('publish');
    expect(card.title).toBe('Pre-authorize elanous v0.3.39 surgery publish 2026-11-29 04:00–2026-11-29 08:00 KST');
    expect(card.options.map(o => o.key)).toEqual(['a', 'b']);
    expect(() => preAuthCard({ ...r, to: '2026-11-30T19:00:01.000Z' }, policy)).toThrow('pre-auth window wider than 1440 min');
  });
});

describe('evaluateConditions', () => {
  test('auto: all green → snapshot literal', () => {
    expect(evaluateConditions('auto', policy, facts(), at)).toEqual({ ok: true, failures: [], waivers: [], snapshot: {
      'red-0': '🔴 0', 'dry-run-exact-cut': 'dry-run ✓ 2026-11-28T20:30:00.000Z', 'open-hold-0': 'HOLD 0', 'notes-present': 'notes ✓ aaaaaaaaaaaa', 'cut-head-prepared': 'cut head = prepared 9126baa991f0' } });
  });
  test('auto: any red, a HOLD, a stale or other-cut dry run, empty notes, a moved head — each is a named failure', () => {
    const r = evaluateConditions('auto', policy, facts({ reds: [{ id: 'X', priority: 'P2' }], openHolds: ['D-20261128-07'], dryRunPass: { cutSha: CUT, notesSha256: NOTES, at: '2026-11-28T14:59:59.000Z' },
      notesBytes: 0, branchHead: 'f'.repeat(40) }), at);
    expect(r.failures).toEqual(['red-0: 🔴 1 (X)', 'dry-run-exact-cut: dry run stale (2026-11-28T14:59:59.000Z · max 360 min)', 'open-hold-0: open HOLD D-20261128-07', 'notes-present: notes empty',
      'cut-head-prepared: release/0.3.39 ffffffffffff ≠ prepared 9126baa991f0']);
    expect(evaluateConditions('auto', policy, facts({ dryRunPass: { cutSha: 'e'.repeat(40), notesSha256: NOTES, at: '2026-11-28T20:30:00.000Z' } }), at).failures)
      .toEqual(['dry-run-exact-cut: dry run was for cut eeeeeeeeeeee notes aaaaaaaaaaaa']);
  });
  test('unreadable facts fail closed', () => {
    expect(evaluateConditions('auto', policy, facts({ reds: new Error('remote down'), openHolds: new Error('ledger locked') }), at).failures)
      .toEqual(['red-0: checklist unreadable: remote down', 'open-hold-0: decisions unreadable: ledger locked']);
  });
  test('surgery: P0 or unprioritized red is critical · P1 red needs its known-issue line, else --waive-reason', () => {
    expect(evaluateConditions('surgery', policy, facts({ reds: [{ id: 'A' }, { id: 'B', priority: 'P0' }] }), at).failures).toEqual(['critical-red-0: critical 🔴 2 (A, B)']);
    expect(evaluateConditions('surgery', policy, facts({ reds: [{ id: 'C', priority: 'P1' }] }), at).failures).toEqual(['noncritical-red-waived: no waiver reason for C']);
    const ok = evaluateConditions('surgery', policy, facts({ reds: [{ id: 'C', priority: 'P1', knownIssue: 'Old theme until reload.' }, { id: 'D', priority: 'P2' }], waiveReason: 'Two minor display issues remain.' }), at);
    expect(ok.ok).toBe(true);
    expect(ok.waivers).toEqual([{ id: 'C', reason: 'Old theme until reload.' }, { id: 'D', reason: 'Two minor display issues remain.' }]);
    expect(ok.snapshot['noncritical-red-waived']).toBe('non-critical 🔴 2 waived 2');
  });
});

describe('store · single use · revoke', () => {
  const use = (over: Partial<PreAuthUse> = {}): PreAuthUse => ({ preAuthId: 'D-20261128-03', version: '0.3.39', mode: 'auto', keyId: 'nexus-mshq-20261128', ref: 'r', cutSha: CUT, notesSha256: NOTES,
    conditions: { 'red-0': '🔴 0' }, waivers: [], at: '2026-11-28T21:00:00.000Z', by: 'critpath', ...over });
  test('first use fresh · same binding again not fresh · another cut refused', () => {
    const dir = tmp();
    expect(recordPreAuthUse(dir, use())).toEqual({ ok: true, fresh: true });
    expect(recordPreAuthUse(dir, use({ by: 'release-graph:0.3.39:go' }))).toEqual({ ok: true, fresh: false });
    expect(recordPreAuthUse(dir, use({ cutSha: 'b'.repeat(40) }))).toEqual({ ok: false, reason: 'already-used:9126baa991f0' });
    expect(recordPreAuthUse(dir, use({ version: '0.3.40', cutSha: 'b'.repeat(40) }))).toEqual({ ok: true, fresh: true });
    expect(readPreAuthUses(dir).length).toBe(2);
  });
  test('an unwritable store refuses the use (fail closed)', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'release'), 'a file where the folder should be');
    const r = recordPreAuthUse(dir, use());
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toStartWith('use-record-failed: ');
  });
  test('revoke is idempotent and rejects a non-decision id', () => {
    const dir = tmp();
    const now = new Date('2026-11-28T14:00:00.000Z');
    expect(revokePreAuth(dir, 'D-20261128-03', 'telegram:1', 'sleeping in', now)).toEqual({ revoked: true, already: false });
    expect(revokePreAuth(dir, 'D-20261128-03', 'cli', 'again', now)).toEqual({ revoked: true, already: true });
    expect(() => revokePreAuth(dir, '../etc', 'cli', 'x', now)).toThrow('not a decision id: ../etc');
  });
  test('Terra r1: a revocation that lands after the judge is seen under the lock · a torn store fails closed but still takes a revocation', () => {
    const dir = tmp();
    const now = new Date('2026-11-28T21:00:00.000Z');
    revokePreAuth(dir, 'D-20261128-03', 'telegram:1', 'changed my mind', now);
    expect(recordPreAuthUse(dir, use())).toEqual({ ok: false, reason: 'revoked' });
    const torn = tmp();
    mkdirSync(join(torn, 'release', 'preauth'), { recursive: true });
    writeFileSync(join(torn, 'release', 'preauth', 'revocations.jsonl'), '{"preAuthId":"D-20261128-09","by":"cli"');
    expect(() => readPreAuthRevocations(torn)).toThrow('preauth store corrupt:');
    const r = recordPreAuthUse(torn, use());
    expect(r.ok ? '' : r.reason).toStartWith('use-record-failed: preauth store corrupt:');
    expect(revokePreAuth(torn, 'D-20261128-03', 'cli', 'still revocable', now)).toEqual({ revoked: true, already: false });
    expect(readFileSync(join(torn, 'release', 'preauth', 'revocations.jsonl'), 'utf8').split('\n')[1]).toStartWith('{"preAuthId":"D-20261128-03"');
  });
  test('use line', () => {
    expect(preAuthUseLine({ preAuthId: 'D-20261128-03', version: '0.3.39', mode: 'surgery', cutSha: CUT, conditions: { 'critical-red-0': 'critical 🔴 0', 'notes-present': 'notes ✓ aaaaaaaaaaaa' },
      waivers: [{ id: 'C', reason: 'Old theme until reload.' }] }))
      .toBe('사전 승인 D-20261128-03 로 v0.3.39 발행 (surgery, cut 9126baa991f0, 조건 critical 🔴 0 · notes ✓ aaaaaaaaaaaa · 면제 C(Old theme until reload.))');
  });
});

describe('resolve · list', () => {
  const ref = preAuthRef({ version: '0.3.39', mode: 'auto', from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', cond: conditionsSha12(policy, 'auto') });
  // Input fixture: the card raisePreAuth would write for this ref (what the CEO read).
  const shown = preAuthCard(parsePreAuthRef(ref)!, policy);
  const base = { id: 'D-20261128-03', refs: [ref], status: 'decided', raisedAt: '2026-11-28T13:30:00.000Z', choice: 'a', decidedBy: { kind: 'human', via: 'telegram', platformUserId: '1' },
    title: shown.title, category: 'publish', scqa: { s: shown.scqa.s, c: shown.scqa.c } };
  test('no trust root → unverified:no-roots; a human row without proof → unverified:no-proof; open → open; b → declined', () => {
    const run = (records: Parameters<typeof resolvePreAuth>[0]['records'], roots: { keyId: string; publicKey: string }[] = []) =>
      resolvePreAuth({ version: '0.3.39', records, trustRoots: roots, now: at, policy, uses: [], revocations: [], facts: facts() }).tried.map(t => t.reason);
    expect(run([{ ...base, proof: { keyId: 'k', sig: '00' } }])).toEqual(['unverified:no-roots']);
    expect(run([base], [{ keyId: 'k', publicKey: '-----BEGIN PUBLIC KEY-----' }])).toEqual(['unverified:no-proof']);
    expect(run([{ ...base, status: 'open' }])).toEqual(['open']);
    expect(run([{ ...base, choice: 'b' }])).toEqual(['declined']);
    expect(run([{ ...base, refs: [ref.replace('0.3.39', '0.3.40')] }])).toEqual([]);
    // a card raised outside the kit: text that is not the signed ref's, or a ref wider than max span
    expect(run([{ ...base, title: 'Pre-authorize elanous v0.3.39 auto publish tonight' }])).toEqual(['card-mismatch']);
    expect(run([{ ...base, category: 'other' }])).toEqual(['card-mismatch']);
    const wide = preAuthRef({ version: '0.3.39', mode: 'auto', from: '2026-11-28T19:00:00.000Z', to: '2026-12-28T19:00:00.000Z', cond: conditionsSha12(policy, 'auto') });
    expect(run([{ ...base, refs: [wide] }])).toEqual(['window-too-wide']);
  });
  test('list states without a proof → unsigned (detail = reason)', () => {
    expect(listPreAuth({ records: [base, { ...base, id: 'D-20261128-04', status: 'open' }], trustRoots: [], uses: [], revocations: [], now: at }))
      .toEqual([{ id: 'D-20261128-03', version: '0.3.39', mode: 'auto', from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', state: 'unsigned', detail: 'no-proof' },
        { id: 'D-20261128-04', version: '0.3.39', mode: 'auto', from: '2026-11-28T19:00:00.000Z', to: '2026-11-28T23:00:00.000Z', state: 'awaiting-signature' }]);
  });
  test('gate: no card for the version = no reasons (silent) · a broken policy = one policy reason', async () => {
    const dir = tmp();
    const notes = join(dir, 'n.md'); writeFileSync(notes, 'notes');
    const io = { stateDir: dir, records: () => [], trustRoots: () => [], policy: () => policy, reds: () => [], openHolds: () => [], notify: () => undefined, now: () => at };
    const input = { binding: { version: '0.3.39', cutSha: CUT, notesSha256: NOTES }, preparedCommit: CUT, branchHead: CUT, notesFile: notes };
    expect(await preAuthGate(io, input, { record: true, by: 'critpath' })).toEqual({ ok: false, reasons: [] });
    expect(await preAuthGate({ ...io, policy: () => { throw new Error('preauth block missing'); } }, input, { record: true, by: 'critpath' })).toEqual({ ok: false, reasons: ['policy: preauth block missing'] });
  });
});
