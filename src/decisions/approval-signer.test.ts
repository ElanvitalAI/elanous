// RELEASE-HUMAN-PROOF-TRUST-ROOT — the signer's own edges (the end-to-end scenes S1~S9 live in
// src/ux-sim/sim-world/supervisors/release-proof.ts). Expectations are literals, not rendered from the product.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { approvalProofPayload, checkHumanApprovalProof, DecisionLedger, readDecisionTrustRoots } from './decision-ledger.js';
import { ensureApprovalSigner, proofWanted, revokeApprovalSigner, rotateApprovalSigner, signApprovalProof, signerPaths, signerStatus } from './approval-signer.js';
import { readCredentialOwner, recordCredentialMirror, registerCredentialOwner } from '../nexus/config/secrets/cred-owner.js';
import { registerDecisionsCommands } from '../cli/decisions-cli.js';
import { DecisionCardService } from './decision-cards.js';
import { attachTelegramDecisionCards } from './telegram-decision-cards.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function universe() {
  const root = mkdtempSync(join(tmpdir(), 'approval-signer-')); dirs.push(root);
  const ownerLedgerPath = join(root, 'credential-owner-ledger.json');
  const alerts: Array<{ line: string; key: string }> = [];
  const opts = { stateDir: root, ownerLedgerPath, host: 'mshq', now: () => new Date('2026-11-28T05:00:00.000Z'), notify: (line: string, key: string) => { alerts.push({ line, key }); } };
  return { root, ownerLedgerPath, alerts, opts };
}
const binding = { ref: 'release-critpath/0.3.39/' + 'a'.repeat(40) + '/' + 'b'.repeat(64), cardId: 'D-20261128-01', raisedAt: '2026-11-28T04:00:00.000Z', choice: 'a', via: 'telegram', platformUserId: '5550001111' };

test('v2 payload is the literal pipe line; a field with «|» or a newline is refused', () => {
  expect(approvalProofPayload(binding)).toBe(`elanous-approval/v2|release-critpath/0.3.39/${'a'.repeat(40)}/${'b'.repeat(64)}|D-20261128-01|2026-11-28T04:00:00.000Z|a|telegram|5550001111`);
  expect(() => approvalProofPayload({ ...binding, platformUserId: '1|2' })).toThrow('every field must be one nonempty line');
  expect(() => approvalProofPayload({ ...binding, via: '' })).toThrow('every field must be one nonempty line');
});

test('TOFU once: generated → ready; the key never appears in the trust root, the alert or the audit', () => {
  const u = universe();
  expect(signerStatus(u.opts)).toEqual({ state: 'no-signer', roots: 0 });
  expect(ensureApprovalSigner(u.opts)).toEqual({ state: 'generated', keyId: 'nexus-mshq-20261128', roots: 1, ownerHost: 'mshq' });
  expect(ensureApprovalSigner(u.opts)).toEqual({ state: 'ready', keyId: 'nexus-mshq-20261128', roots: 1, ownerHost: 'mshq' });
  const p = signerPaths(u.root);
  for (const text of [readFileSync(p.trustRoot, 'utf8'), readFileSync(p.audit, 'utf8'), JSON.stringify(u.alerts)]) expect(text).not.toContain('PRIVATE KEY');
  expect(readFileSync(p.key, 'utf8')).toContain('BEGIN PRIVATE KEY');
  expect(u.alerts.map(a => a.key)).toEqual(['release-proof:generated:nexus-mshq-20261128']);
  expect(readCredentialOwner('release-approval-signer', u.ownerLedgerPath)).toEqual({ slot: 'release-approval-signer', ownerHost: 'mshq', mirrors: [] });
});

test('a signed v2 proof verifies; every other field change is bad-sig', () => {
  const u = universe();
  ensureApprovalSigner(u.opts);
  const signed = signApprovalProof(binding, { stateDir: u.root, ownerLedgerPath: u.ownerLedgerPath, host: 'mshq' });
  if (!signed.ok) throw new Error(`sign failed: ${signed.reason}`);
  const roots = readDecisionTrustRoots(u.root);
  const entry = { id: binding.cardId, raisedAt: binding.raisedAt, choice: 'a', decidedBy: { kind: 'human', via: 'telegram', platformUserId: '5550001111' }, proof: signed.proof };
  expect(checkHumanApprovalProof(entry, binding.ref, roots)).toEqual({ ok: true, keyId: 'nexus-mshq-20261128' });
  for (const changed of [{ id: 'D-20261128-02' }, { raisedAt: '2026-11-28T04:00:01.000Z' }, { decidedBy: { kind: 'human', via: 'pwa', platformUserId: '5550001111' } }, { decidedBy: { kind: 'human', via: 'telegram', platformUserId: '5550002222' } }]) {
    expect(checkHumanApprovalProof({ ...entry, ...changed }, binding.ref, roots)).toEqual({ ok: false, reason: 'bad-sig', keyId: 'nexus-mshq-20261128' });
  }
  expect(checkHumanApprovalProof({ ...entry, decidedBy: { kind: 'human' } }, binding.ref, roots)).toEqual({ ok: false, reason: 'incomplete-binding', keyId: 'nexus-mshq-20261128' });
  expect(checkHumanApprovalProof({ ...entry, proof: undefined }, binding.ref, roots)).toEqual({ ok: false, reason: 'no-proof' });
  expect(checkHumanApprovalProof(entry, binding.ref, [])).toEqual({ ok: false, reason: 'no-roots', keyId: 'nexus-mshq-20261128' });
});

test('lax key mode → unsafe-perms (no signing) · another owner host → foreign-owner (no generation)', () => {
  const u = universe();
  ensureApprovalSigner(u.opts);
  chmodSync(signerPaths(u.root).key, 0o644);
  expect(signApprovalProof(binding, { stateDir: u.root, ownerLedgerPath: u.ownerLedgerPath, host: 'mshq' })).toEqual({ ok: false, reason: 'unsafe-perms' });
  const v = universe();
  registerCredentialOwner({ slot: 'release-approval-signer', ownerHost: 'node-b' }, v.ownerLedgerPath);
  expect(ensureApprovalSigner(v.opts)).toEqual({ state: 'foreign-owner', roots: 0, ownerHost: 'node-b', detail: 'signer slot owned by node-b' });
  expect(existsSync(signerPaths(v.root).key)).toBe(false);
});

test('the signer slot can never record a mirror', () => {
  const u = universe();
  registerCredentialOwner({ slot: 'release-approval-signer', ownerHost: 'mshq' }, u.ownerLedgerPath);
  expect(() => recordCredentialMirror({ slot: 'release-approval-signer', ownerHost: 'mshq', mirrorHost: 'node-b' }, u.ownerLedgerPath)).toThrow('CREDENTIAL_OWNER_SLOT_NO_MIRROR');
  expect(() => registerCredentialOwner({ slot: 'release-approval-signer', ownerHost: 'node-b' }, u.ownerLedgerPath)).toThrow('credential slot already has another owner host');
});

test('only a critpath card with the approve choice wants a proof', () => {
  expect(proofWanted({ refs: ['origin:ceo', binding.ref] }, 'a')).toBe(binding.ref);
  expect(proofWanted({ refs: [binding.ref] }, 'b')).toBeNull();
  expect(proofWanted({ refs: ['release-notes/0.3.39'] }, 'a')).toBeNull();
});

test('CLI: verify <id> prints the reason · signer status never prints the key · rotate refuses outside a person\'s terminal', async () => {
  const u = universe();
  ensureApprovalSigner(u.opts);
  const ledger = new DecisionLedger({ stateDir: u.root, now: () => new Date('2026-11-28T05:00:00.000Z'), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
  const card = ledger.raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
    options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
    recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [binding.ref] });
  ledger.decide(card.id, 'a', { kind: 'human', via: 'telegram', platformUserId: '5550001111' });
  const lines: string[] = [];
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    registerDecisionsCommands(program, { stateDir: u.root, resolveVersion: () => ({ released: null, dev: null, codename: null }),
      signer: { terminal: () => ({ ok: false, line: 'eln decisions signer rotate: refused — this terminal runs inside claude (pid 4242); open your own terminal' }), ownerLedgerPath: u.ownerLedgerPath, host: 'mshq' } },
      { log: (line: string) => { lines.push(line); } });
    await program.parseAsync(['node', 'eln', 'decisions', ...args]);
  };
  const before = process.exitCode;
  try {
    await run('verify', card.id);
    expect(lines.at(-1)!.split('\n').at(-1)).toBe(`human 결정 ${card.id}: 증명 미확인(reason=no-proof)`);
    await run('signer', 'status');
    expect(lines.at(-1)).toBe('서명자 ready · nexus-mshq-20261128 · 신뢰 뿌리 1개 · 주인 mshq · 권한 700/600');
    await run('signer', 'rotate');
    expect(lines.at(-1)).toBe('eln decisions signer rotate: refused — this terminal runs inside claude (pid 4242); open your own terminal');
    expect(readDecisionTrustRoots(u.root).map(k => k.keyId)).toEqual(['nexus-mshq-20261128']);
  } finally { process.exitCode = before ?? 0; }
  expect(lines.join('\n')).not.toContain('PRIVATE KEY');
});

test('revoking the last key never reopens TOFU: the next boot is signer-missing, not a fresh key (Terra r1)', () => {
  const u = universe();
  const first = ensureApprovalSigner(u.opts);
  expect(revokeApprovalSigner(first.keyId!, { stateDir: u.root })).toEqual({ revoked: true, deletedPrivateKey: true });
  expect(ensureApprovalSigner(u.opts)).toEqual({ state: 'signer-missing', roots: 0, ownerHost: 'mshq' });
  expect(existsSync(signerPaths(u.root).key)).toBe(false);
});

test('a failed first generation leaves no orphan private key; the next boot generates cleanly (Terra r1)', () => {
  const u = universe();
  const p = signerPaths(u.root);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(dirname(p.trustRoot), 0o500); // the key lands in signer/, the trust-root write in release/ is refused
  try {
    expect(ensureApprovalSigner(u.opts).state).toBe('error');
    expect(existsSync(p.key)).toBe(false);
    expect(existsSync(p.trustRoot)).toBe(false);
  } finally { chmodSync(dirname(p.trustRoot), 0o700); }
  expect(ensureApprovalSigner(u.opts)).toEqual({ state: 'generated', keyId: 'nexus-mshq-20261128', roots: 1, ownerHost: 'mshq' });
});

test('the proof keyId always names the key that signed it, even right after a rotate (Terra r1)', () => {
  const u = universe();
  ensureApprovalSigner(u.opts);
  rotateApprovalSigner({ ...u.opts, now: () => new Date('2026-11-28T06:00:00.000Z') });
  const signed = signApprovalProof(binding, { stateDir: u.root, ownerLedgerPath: u.ownerLedgerPath, host: 'mshq' });
  if (!signed.ok) throw new Error(`sign failed: ${signed.reason}`);
  expect(signed.proof.keyId).toBe('nexus-mshq-20261128-2');
  const entry = { id: binding.cardId, raisedAt: binding.raisedAt, choice: 'a', decidedBy: { kind: 'human', via: 'telegram', platformUserId: '5550001111' }, proof: signed.proof };
  expect(checkHumanApprovalProof(entry, binding.ref, readDecisionTrustRoots(u.root))).toEqual({ ok: true, keyId: 'nexus-mshq-20261128-2' });
});

test('Telegram attach readies the signer BEFORE the tap callback exists (Terra r1)', () => {
  const order: string[] = [];
  const bot = {
    onCallbackQuery: () => { order.push('callback'); return () => undefined; },
    answerCallbackQuery: async () => undefined, sendMessage: async () => null, sendInlineKeyboard: async () => null,
    editMessageWithKeyboard: async () => undefined, captureNextText: () => () => undefined, isPolling: () => false,
  } as never;
  const stop = attachTelegramDecisionCards(bot, { telegram: { allowedUsers: [111] }, raw: { decisions: { cards: true } } } as never,
    { service: new DecisionCardService({ transport: { platform: 'telegram', ownerChats: async () => [], send: async () => null, edit: async () => undefined, notify: async () => undefined },
        ownerIds: ['111'], ledger: new DecisionLedger({ stateDir: universe().root, resolveVersion: () => ({ released: null, dev: null, codename: null }) }) }),
      ensureSigner: () => { order.push('signer'); }, tickMs: 3_600_000 }); // 출처: #40665 ticker never fires in this test (one hour)
  try { expect(order.slice(0, 2)).toEqual(['signer', 'callback']); } finally { stop(); }
});

test('an unreadable trust root counts as used: no TOFU over it', () => {
  const u = universe();
  const p = signerPaths(u.root);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  writeFileSync(p.trustRoot, '{not json');
  expect(ensureApprovalSigner(u.opts).state).toBe('signer-missing');
  expect(existsSync(p.key)).toBe(false);
});

test('a key on a host that does not own the signer slot never signs (mirror · Terra r2)', () => {
  const u = universe();
  ensureApprovalSigner(u.opts);
  expect(signApprovalProof(binding, { stateDir: u.root, ownerLedgerPath: u.ownerLedgerPath, host: 'node-b' })).toEqual({ ok: false, reason: 'foreign-owner' });
  expect(readFileSync(signerPaths(u.root).audit, 'utf8')).toContain('"reason":"foreign-owner"');
});
