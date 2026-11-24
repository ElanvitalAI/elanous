import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { DecisionLedger, readDecisionTrustRoots, validateDecisionRaise } from '../decisions/decision-ledger.js';
import { APPROVE_OPTION, CRITPATH_WAITING_EXIT, approvalRef, runCritpath, type ApprovalBinding, type CritpathDeps, type PreparedRelease } from '../../scripts/release-loop/critpath.js';
import { critpathApprovalCard, defaultCritpathDeps, registerReleaseCritpathCommand } from './release-critpath-cli.js';

const binding = { version: '9.9.9', cutSha: 'a'.repeat(40), notesSha256: 'b'.repeat(64) };
const savedExit = process.exitCode;
const savedState = process.env.ELANOUS_STATE_DIR;
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = savedExit ?? 0;
  if (savedState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedState;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('release critpath CLI', () => {
  test('the publish card passes decision-ledger validation and is bound to version · cut · notes', () => {
    for (const waiver of [undefined, 'Some installer paths remain unverified in this release.']) {
      const card = validateDecisionRaise(critpathApprovalCard(binding, waiver));
      expect(card.category).toBe('publish');
      expect(card.refs).toEqual([approvalRef(binding)]);
      expect(card.options.map((o) => o.key)).toContain(APPROVE_OPTION);
    }
  });

  test('waiting for approval exits with the distinct waiting code and never calls publish', async () => {
    const root = mkdtempSync(join(tmpdir(), 'critpath-cli-'));
    dirs.push(root);
    process.env.ELANOUS_STATE_DIR = root;
    const notes = join(root, 'notes.md');
    writeFileSync(notes, 'Public notes.\n');
    const calls: string[] = [];
    const cards: ApprovalBinding[] = [];
    const deps: CritpathDeps = {
      readPrepared: () => null,
      resolveBranch: () => { calls.push('resolve'); return binding.cutSha; },
      prepare: async ({ out }) => { calls.push('prepare'); return { dir: out, version: '9.9.9', tag: 'v9.9.9', publicRepo: 'Example/elanous', sourceRef: 'origin/release/9.9.9', sourceCommit: binding.cutSha, publicCommit: 'c'.repeat(40), tgz: join(out, 'elanous.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true }; },
      githubReleaseExists: () => false,
      publish: async () => { calls.push('publish'); },
      npmRegistry: async () => ({ visible: false }),
      npmDryRun: () => ({ ok: true, detail: '' }),
      npmPublish: async () => { calls.push('npm'); return { ok: true, summary: '' }; },
      verify: async () => { calls.push('verify'); return { ok: true, summary: '' }; },
      approvalRecords: () => [],
      requestApproval: (b) => { calls.push('card'); cards.push(b); return { id: 'D-1' }; },
      log: () => {},
    };
    const program = new Command();
    registerReleaseCritpathCommand(program.command('release'), async () => deps);
    await program.parseAsync(['node', 'elanous', 'release', 'critpath', '--version', '9.9.9', '--notes-file', notes, '--branch', 'release/9.9.9']);
    expect(process.exitCode).toBe(CRITPATH_WAITING_EXIT);
    expect(calls).toEqual(['resolve', 'prepare', 'card']);
    expect(cards.map((c) => c.cutSha)).toEqual([binding.cutSha]);
    // The actual CLI dispatch must not accept a forged human marker on the next run.
    deps.approvalRecords = () => [{ id: 'D-1', refs: [approvalRef(cards[0]!)], status: 'decided', choice: 'a', decidedBy: { kind: 'human' } }];
    process.exitCode = 0;
    await program.parseAsync(['node', 'elanous', 'release', 'critpath', '--version', '9.9.9', '--notes-file', notes, '--branch', 'release/9.9.9']);
    expect(process.exitCode).toBe(CRITPATH_WAITING_EXIT);
    expect(calls).toEqual(['resolve', 'prepare', 'card', 'resolve', 'prepare']);
  });

  // JUD-B #139625 (PR #39854 HOLD): the default CLI path is verified directly — not via injected roots.
  const ledgerAt = (root: string, at: string) => new DecisionLedger({ stateDir: root, now: () => new Date(at),
    resolveVersion: () => ({ released: null, dev: null, codename: null }) });
  const prepared = (root: string): PreparedRelease => ({ dir: root, version: '9.9.9', tag: 'v9.9.9', publicRepo: 'Example/elanous',
    sourceRef: binding.cutSha, sourceCommit: binding.cutSha, publicCommit: 'c'.repeat(40), tgz: join(root, 'elanous.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true });
  const drivenDeps = (deps: CritpathDeps, root: string, calls: string[]): CritpathDeps => ({ ...deps,
    readPrepared: () => prepared(root), githubReleaseExists: () => false, npmRegistry: async () => ({ visible: false }),
    publish: async () => { calls.push('publish'); },
    npmPublish: async () => { calls.push('npm'); return { ok: true, npm: 'staged-not-visible', summary: 'staged' }; },
    verify: async () => { calls.push('verify'); return { ok: true, summary: 'ok' }; } });

  test('default deps wire the ledger state-dir trust roots — a valid out-of-band ed25519 proof approves and publication proceeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'critpath-cli-trust-'));
    dirs.push(root);
    process.env.ELANOUS_STATE_DIR = root;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    mkdirSync(join(root, 'release'), { recursive: true });
    // Trust roots are public keys only — a junk entry is never a root (readDecisionTrustRoots filters).
    writeFileSync(join(root, 'release', 'trust-root.json'), JSON.stringify({ keys: [
      { keyId: 'human-release-1', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      { keyId: 'not-a-pem', publicKey: 'not a PEM public key' },
    ] }, null, 2) + '\n');
    const notes = join(root, 'notes.md');
    writeFileSync(notes, 'Public notes.\n');
    const b: ApprovalBinding = { version: '9.9.9', cutSha: binding.cutSha, notesSha256: createHash('sha256').update(readFileSync(notes)).digest('hex') };
    const ref = approvalRef(b);
    const card = ledgerAt(root, '2026-11-24T00:00:00Z').raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
    const sig = cryptoSign(null, Buffer.from(ref, 'utf8'), privateKey).toString('hex');
    ledgerAt(root, '2026-11-24T00:00:10Z').decide(card.id, 'a', { kind: 'human', via: 'telegram', platformUserId: 'owner' }, 'signed out of band', undefined, { keyId: 'human-release-1', sig });

    // The actual default CLI path (deps defaults — nothing injected). The #139625 defect was exactly here:
    // trustRoots was absent, approvalState received undefined and this valid proof stayed 'unverified'.
    const deps = await defaultCritpathDeps(() => {});
    expect(typeof deps.trustRoots).toBe('function');
    expect(deps.trustRoots!()).toEqual([{ keyId: 'human-release-1', publicKey: expect.stringContaining('BEGIN PUBLIC KEY') }]);
    // readDecisionTrustRoots returns DecisionTrustRoot[] (mutable); deps.trustRoots() returns readonly DecisionTrustRoot[].
    // Spreading the expected side keeps it assignable to toEqual's actual-inferred element type (#39854 r3 changed-tsc TS2769).
    expect(readDecisionTrustRoots(root)).toEqual([...deps.trustRoots!()]); // same single source as the ledger state dir
    expect(deps.approvalRecords().some((r) => r.id === card.id && r.refs?.includes(ref))).toBe(true);

    const calls: string[] = [];
    const result = await runCritpath({ version: '9.9.9', notesFile: notes, cutCommit: binding.cutSha,
      out: join(root, 'critpath-prepared'), ledgerPath: join(root, 'critpath.json') }, drivenDeps(deps, root, calls));
    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['publish', 'npm', 'verify']);
  });

  test('default deps: a missing or wrong-key proof stays unverified — automatic publication blocks (exit 75)', async () => {
    for (const wrong of [null, 'attacker'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'critpath-cli-unverified-'));
      dirs.push(root);
      process.env.ELANOUS_STATE_DIR = root;
      const rootKey = generateKeyPairSync('ed25519');
      const attacker = generateKeyPairSync('ed25519');
      mkdirSync(join(root, 'release'), { recursive: true });
      writeFileSync(join(root, 'release', 'trust-root.json'), JSON.stringify({ keys: [
        { keyId: 'human-release-1', publicKey: rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }, null, 2) + '\n');
      const notes = join(root, 'notes.md');
      writeFileSync(notes, 'Public notes.\n');
      const b: ApprovalBinding = { version: '9.9.9', cutSha: binding.cutSha, notesSha256: createHash('sha256').update(readFileSync(notes)).digest('hex') };
      const ref = approvalRef(b);
      const card = ledgerAt(root, '2026-11-24T00:00:00Z').raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
        options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
        recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
      // The decided human marker claims out-of-band approval; the signer is the trusted root holder or an attacker key.
      const signer = wrong === null ? rootKey.privateKey : attacker.privateKey;
      const sig = cryptoSign(null, Buffer.from(ref, 'utf8'), signer).toString('hex');
      ledgerAt(root, '2026-11-24T00:00:10Z').decide(card.id, 'a', { kind: 'human', via: 'telegram', platformUserId: 'owner' }, 'claimed out of band', undefined,
        wrong === null ? undefined : { keyId: 'human-release-1', sig });
      const deps = await defaultCritpathDeps(() => {});
      expect(deps.trustRoots!().map((k) => k.keyId)).toEqual(['human-release-1']); // roots ARE wired — the claim still fails
      const calls: string[] = [];
      const result = await runCritpath({ version: '9.9.9', notesFile: notes, cutCommit: binding.cutSha,
        out: join(root, 'critpath-prepared'), ledgerPath: join(root, 'critpath.json') }, drivenDeps(deps, root, calls));
      expect(result.status).toBe('waiting-approval');
      expect(result.exitCode).toBe(CRITPATH_WAITING_EXIT); // 75 — healthy run, waiting for a trusted human decision
      expect(result.approval).toEqual({ state: 'unverified', id: card.id });
      expect(calls).toEqual([]); // publish/npm/verify never run
    }
  });
});
