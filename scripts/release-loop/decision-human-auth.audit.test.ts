import { test, expect } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';
import { isHumanTerminal } from '../../src/cli/decisions-cli.js';
import { approvalRef, approvalState, runCritpath, type CritpathDeps } from './critpath.js';

test('AUDIT: direct JSONL append must not authorize release publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-human-audit-'));
  try {
    const notes = join(root, 'notes.md');
    writeFileSync(notes, 'Public notes.\n');
    const version = '9.9.9';
    const cutSha = 'a'.repeat(40);
    const notesSha256 = createHash('sha256').update(readFileSync(notes)).digest('hex');
    const binding = { version, cutSha, notesSha256 };
    const ref = approvalRef(binding);
    const ledger = new DecisionLedger({ stateDir: root, now: () => new Date('2026-11-22T00:00:00Z'), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
    const card = ledger.raise({ title: 'Publish?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'release-critpath' }, refs: [ref] });
    // Seat/noninteractive CLI is refused, and delegated decisions remain kind:auto.
    expect(isHumanTerminal({ ELANOUS_SEAT: 'TC-H-CX-14' }, false)).toBe(false);
    expect(isHumanTerminal({ ELANOUS_SEAT: 'TC-H-CX-99' }, true)).toBe(false);
    expect(isHumanTerminal({}, true)).toBe(true);
    const auto = ledger.raise({ title: 'Auto?', category: 'publish', scqa: { s: 'Ready.', c: 'Irreversible.' },
      options: [{ key: 'a', label: 'Publish', consequence: 'Public.' }, { key: 'b', label: 'Hold', consequence: 'Wait.' }],
      recommendation: { skipped: true, reason: 'Person required.' }, raisedBy: { agent: 'seat' }, refs: ['auto-ref'] });
    ledger.decide(auto.id, 'a', { kind: 'auto', agent: 'seat', delegation: 'test' });
    expect(approvalState(ledger.list({ status: 'all' }), { version, cutSha, notesSha256: 'b'.repeat(64) }).state).toBe('none');
    // No API writer is involved: an automation process with the same filesystem user appends this event.
    appendFileSync(ledger.path, JSON.stringify({ type: 'decided', id: card.id, at: '2026-11-22T00:01:00.000Z',
      by: { kind: 'human', via: 'telegram', platformUserId: 'owner' }, choice: 'a' }) + '\n');
    const observed = new DecisionLedger({ stateDir: root }).list({ status: 'all' });
    const calls: string[] = [];
    const deps: CritpathDeps = {
      readPrepared: () => ({ dir: root, version, tag: 'v9.9.9', publicRepo: 'example/test', sourceRef: cutSha,
        sourceCommit: cutSha, publicCommit: 'c'.repeat(40), tgz: join(root, 'archive.tgz'), tgzSha1: 'd'.repeat(40), e2eOk: true, checksumsOk: true }),
      resolveBranch: () => cutSha, prepare: async () => { throw new Error('unexpected prepare'); },
      githubReleaseExists: () => false, publish: async ({ yes }) => { if (yes) calls.push('publish'); },
      npmRegistry: async () => ({ visible: false }), npmDryRun: () => ({ ok: true, detail: 'ok' }),
      npmPublish: async () => { calls.push('npm'); return { ok: true, npm: 'staged-not-visible', summary: 'staged' }; },
      verify: async () => { calls.push('verify'); return { ok: true, summary: 'ok' }; },
      approvalRecords: () => new DecisionLedger({ stateDir: root }).list({ status: 'all' }),
      requestApproval: () => { throw new Error('unexpected card'); }, log: () => {},
    };
    const result = await runCritpath({ version, notesFile: notes, cutCommit: cutSha, out: join(root, 'prepared'), ledgerPath: join(root, 'critpath.json') }, deps);
    console.log(JSON.stringify({ sha: process.env.AUDIT_SHA, ledgerPath: ledger.path, mode: (statSync(ledger.path).mode & 0o777).toString(8), autoKind: ledger.show(auto.id).decidedBy?.kind,
      forgedKind: observed.find(x => x.id === card.id)?.decidedBy?.kind, approval: approvalState(observed, binding).state, calls, result: result.status }));
    expect(approvalState(observed, binding).state).toBe('unverified');
    expect(calls).toEqual([]);
    expect(result.status).toBe('waiting-approval');
    expect(result.exitCode).toBe(75);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
