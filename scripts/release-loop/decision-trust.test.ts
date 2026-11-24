import { test, expect } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { DecisionLedger, readDecisionTrustRoots } from '../../src/decisions/decision-ledger.js';
import { approvalRef, approvalState, runCritpath, type ApprovalBinding, type CritpathDeps } from './critpath.js';

// DECISION-LEDGER-HUMAN-AUTH 0.3.34 — essential completion line:
// out-of-band trusted-human proof + hash chain + 3 forgery rejections + verification path.

const version = '9.9.9';
const cutSha = 'a'.repeat(40);

function ledger(root: string, at = '2026-11-24T00:00:00Z'): DecisionLedger {
  return new DecisionLedger({ stateDir: root, now: () => new Date(at), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
}

test('chain: appends carry chainPrev/chainSha and verifyChain passes on a clean ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-trust-'));
  try {
    const led = ledger(root);
    const ref = `release-critpath/${version}/${cutSha}/${'0'.repeat(64)}`;
    const card = led.raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
    led.decide(card.id, 'b', { kind: 'auto', agent: 'seat', delegation: 'test' });
    const followup = led.raise({ title: 'Withdraw?', category: 'other', scqa: { s: 's', c: 'c' },
      options: [{ key: 'a', label: 'One', consequence: 'one' }, { key: 'b', label: 'Two', consequence: 'two' }],
      recommendation: { skipped: true, reason: 'test' }, raisedBy: { agent: 'test' }, refs: ['second-ref'] });
    led.withdraw(followup.id, 'done testing');
    const lines = readFileSync(led.path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(typeof line.chainSha).toBe('string');
      expect(line.chainSha).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(lines[0].chainPrev).toBe('GENESIS');
    expect(lines[1]!.chainPrev).toBe(lines[0]!.chainSha);
    expect(lines[2]!.chainPrev).toBe(lines[1]!.chainSha);
    expect(lines[3]!.chainPrev).toBe(lines[2]!.chainSha);
    const verify = led.verifyChain();
    expect(verify.ok).toBe(true);
    expect(verify.problems).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('forgery (a): a rewritten payload row is detected by chainSha mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-trust-'));
  try {
    const led = ledger(root);
    const ref = `release-critpath/${version}/${cutSha}/${'0'.repeat(64)}`;
    const a = led.raise({ title: 'A?', category: 'other', scqa: { s: 's', c: 'c' },
      options: [{ key: 'a', label: 'One', consequence: 'one' }, { key: 'b', label: 'Two', consequence: 'two' }],
      recommendation: { skipped: true, reason: 'test' }, raisedBy: { agent: 'test' }, refs: ['a-ref'] });
    const b = led.raise({ title: 'B?', category: 'other', scqa: { s: 's', c: 'c' },
      options: [{ key: 'a', label: 'One', consequence: 'one' }, { key: 'b', label: 'Two', consequence: 'two' }],
      recommendation: { skipped: true, reason: 'test' }, raisedBy: { agent: 'test' }, refs: ['b-ref'] });
    led.decide(a.id, 'b', { kind: 'auto', agent: 'test', delegation: 'test' });
    // Forger rewrites the decided row's note without recomputing the chain.
    const raw = readFileSync(led.path, 'utf8').split('\n').filter(Boolean);
    const decidedLine = raw.findIndex(l => JSON.parse(l).type === 'decided');
    const forged = JSON.parse(raw[decidedLine]!);
    forged.note = 'forged by same filesystem user';
    raw[decidedLine] = JSON.stringify(forged);
    writeFileSync(led.path, raw.join('\n') + '\n');
    const verify = ledger(root).verifyChain();
    expect(verify.ok).toBe(false);
    expect(verify.problems.some(p => p.includes('chainSha'))).toBe(true);
    expect(b.id).toBeTruthy();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('forgery (b): a removed or reordered row breaks chainPrev continuity', () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-trust-'));
  try {
    const led = ledger(root);
    const ref = `release-critpath/${version}/${cutSha}/${'0'.repeat(64)}`;
    const a = led.raise({ title: 'A?', category: 'other', scqa: { s: 's', c: 'c' },
      options: [{ key: 'a', label: 'One', consequence: 'one' }, { key: 'b', label: 'Two', consequence: 'two' }],
      recommendation: { skipped: true, reason: 'test' }, raisedBy: { agent: 'test' }, refs: ['a-ref'] });
    led.raise({ title: 'B?', category: 'other', scqa: { s: 's', c: 'c' },
      options: [{ key: 'a', label: 'One', consequence: 'one' }, { key: 'b', label: 'Two', consequence: 'two' }],
      recommendation: { skipped: true, reason: 'test' }, raisedBy: { agent: 'test' }, refs: ['b-ref'] });
    led.decide(a.id, 'b', { kind: 'auto', agent: 'test', delegation: 'test' });
    // Forger deletes the middle raised row and splices the chain.
    const raw = readFileSync(led.path, 'utf8').split('\n').filter(Boolean);
    const shortened = raw.filter(l => JSON.parse(l).type !== 'raised' || JSON.parse(l).entry.title !== 'B?');
    writeFileSync(led.path, shortened.join('\n') + '\n');
    const verify = ledger(root).verifyChain();
    expect(verify.ok).toBe(false);
    expect(verify.problems.some(p => p.includes('chainPrev'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('forgery (c): a chain-valid forged human approval without out-of-band proof stays unverified and blocks publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-trust-'));
  try {
    const notes = join(root, 'notes.md');
    writeFileSync(notes, 'Public notes.\n');
    const notesSha256 = createHash('sha256').update(readFileSync(notes)).digest('hex');
    const binding: ApprovalBinding = { version, cutSha, notesSha256 };
    const ref = approvalRef(binding);
    const led = ledger(root);
    const card = led.raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
    // Same-filesystem-user forger appends a chain-consistent human approval WITHOUT proof.
    const last = readFileSync(led.path, 'utf8').split('\n').filter(Boolean).at(-1)!;
    const prev = JSON.parse(last).chainSha as string;
    const event = { type: 'decided', id: card.id, at: '2026-11-24T00:01:00.000Z', by: { kind: 'human', via: 'telegram', platformUserId: 'owner' }, choice: 'a' };
    const sha = createHash('sha256').update(`${prev}\n${JSON.stringify(event)}`).digest('hex');
    appendFileSync(led.path, JSON.stringify({ ...event, chainPrev: prev, chainSha: sha }) + '\n');
    const observed = ledger(root, '2026-11-24T00:02:00Z').list({ status: 'all' });
    expect(ledger(root).verifyChain().ok).toBe(true); // the chain itself is intact — the forgery is the CLAIM, not the bytes
    expect(approvalState(observed, binding).state).toBe('unverified');
    expect(approvalState(observed, binding, readDecisionTrustRoots(root)).state).toBe('unverified');
    const calls: string[] = [];
    const deps: CritpathDeps = {
      readPrepared: () => ({ dir: root, version, tag: 'v9.9.9', publicRepo: 'example/test', sourceRef: cutSha,
        sourceCommit: cutSha, publicCommit: 'c'.repeat(40), tgz: join(root, 'archive.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true }),
      resolveBranch: () => cutSha, prepare: async () => { throw new Error('unexpected prepare'); },
      githubReleaseExists: () => false, publish: async () => { calls.push('publish'); },
      npmRegistry: async () => ({ visible: false }), npmDryRun: () => ({ ok: true, detail: 'ok' }),
      npmPublish: async () => { calls.push('npm'); return { ok: true, npm: 'staged-not-visible', summary: 'staged' }; },
      verify: async () => { calls.push('verify'); return { ok: true, summary: 'ok' }; },
      approvalRecords: () => ledger(root).list({ status: 'all' }),
      requestApproval: () => { throw new Error('unexpected card'); },
      trustRoots: () => readDecisionTrustRoots(root),
      log: () => {}, now: () => new Date('2026-11-24T00:02:00Z'),
    };
    const result = await runCritpath({ version, notesFile: notes, cutCommit: cutSha, out: join(root, 'prepared'), ledgerPath: join(root, 'critpath.json') }, deps);
    expect(result.status).toBe('waiting-approval');
    expect(result.exitCode).toBe(75);
    expect(calls).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('trusted path: a human decision with a valid out-of-band ed25519 proof approves and publication proceeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-trust-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = 'test-root-1';
    const trustRoot = join(root, 'release', 'trust-root.json');
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(trustRoot, JSON.stringify({ keys: [{ keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }, null, 2) + '\n');
    expect(existsSync(trustRoot)).toBe(true);
    expect(readDecisionTrustRoots(root)).toEqual([{ keyId, publicKey: expect.stringContaining('BEGIN PUBLIC KEY') }]);

    const notes = join(root, 'notes.md');
    writeFileSync(notes, 'Public notes.\n');
    const notesSha256 = createHash('sha256').update(readFileSync(notes)).digest('hex');
    const binding: ApprovalBinding = { version, cutSha, notesSha256 };
    const ref = approvalRef(binding);
    const led = ledger(root);
    const card = led.raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
    // The human signs the exact binding out of band (their key device), then the decision records the proof.
    const sig = cryptoSign(null, Buffer.from(ref, 'utf8'), privateKey).toString('hex');
    led.decide(card.id, 'a', { kind: 'human', via: 'telegram', platformUserId: 'owner' }, 'signed out of band', undefined, { keyId, sig });
    const observed = ledger(root, '2026-11-24T00:02:00Z').list({ status: 'all' });
    expect(approvalState(observed, binding, readDecisionTrustRoots(root)).state).toBe('approved');
    // No trust roots wired → still unverified (defense in depth: the proof only counts with the root).
    expect(approvalState(observed, binding).state).toBe('unverified');
    // A tampered proof (flipped hex) never approves.
    const tampered = observed.map(r => ({ ...r, proof: r.proof ? { ...r.proof, sig: (parseInt(r.proof.sig.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + r.proof.sig.slice(2) } : undefined }));
    expect(approvalState(tampered, binding, readDecisionTrustRoots(root)).state).toBe('unverified');
    const calls: string[] = [];
    const deps: CritpathDeps = {
      readPrepared: () => ({ dir: root, version, tag: 'v9.9.9', publicRepo: 'example/test', sourceRef: cutSha,
        sourceCommit: cutSha, publicCommit: 'c'.repeat(40), tgz: join(root, 'archive.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true }),
      resolveBranch: () => cutSha, prepare: async () => { throw new Error('unexpected prepare'); },
      githubReleaseExists: () => false, publish: async () => { calls.push('publish'); },
      npmRegistry: async () => ({ visible: false }), npmDryRun: () => ({ ok: true, detail: 'ok' }),
      npmPublish: async () => { calls.push('npm'); return { ok: true, npm: 'staged-not-visible', summary: 'staged' }; },
      verify: async () => { calls.push('verify'); return { ok: true, summary: 'ok' }; },
      approvalRecords: () => ledger(root).list({ status: 'all' }),
      requestApproval: () => { throw new Error('unexpected card'); },
      trustRoots: () => readDecisionTrustRoots(root),
      log: () => {}, now: () => new Date('2026-11-24T00:02:00Z'),
    };
    const result = await runCritpath({ version, notesFile: notes, cutCommit: cutSha, out: join(root, 'prepared'), ledgerPath: join(root, 'critpath.json') }, deps);
    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['publish', 'npm', 'verify']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verification path: verifyChain reports legacy rows as legacy, not broken', () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-trust-'));
  try {
    const led = ledger(root);
    const ref = `release-critpath/${version}/${cutSha}/${'0'.repeat(64)}`;
    led.raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
    // A pre-chain ledger row (no chainSha) stays readable and verifyChain flags it legacy only.
    const raw = readFileSync(led.path, 'utf8').split('\n').filter(Boolean);
    const legacy = JSON.parse(raw[0]!);
    delete legacy.chainSha;
    delete legacy.chainPrev;
    writeFileSync(led.path, JSON.stringify(legacy) + '\n' + raw.slice(1).join('\n') + '\n');
    const verify = ledger(root).verifyChain();
    expect(verify.ok).toBe(true);
    expect(verify.problems).toEqual([]);
    expect(verify.legacy).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});