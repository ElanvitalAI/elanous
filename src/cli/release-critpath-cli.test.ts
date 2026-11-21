import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { validateDecisionRaise } from '../decisions/decision-ledger.js';
import { APPROVE_OPTION, CRITPATH_WAITING_EXIT, approvalRef, type ApprovalBinding, type CritpathDeps } from '../../scripts/release-loop/critpath.js';
import { critpathApprovalCard, registerReleaseCritpathCommand } from './release-critpath-cli.js';

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
});
