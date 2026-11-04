import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileClassicSidetabCandidatePatches, sidetabCandidateProtocolPrompt } from './classic-sidetab-mission-reconcile.js';

const roots: string[] = [];
function fixture(): { cwd: string; baseSha: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'sidetab-patch-reconcile-test-'));
  roots.push(cwd);
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', cwd, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(cwd, 'one.txt'), 'one\n');
  writeFileSync(join(cwd, 'two.txt'), 'two\n');
  execFileSync('git', ['-C', cwd, 'add', 'one.txt', 'two.txt']);
  execFileSync('git', ['-C', cwd, 'commit', '--quiet', '-m', 'base']);
  const baseSha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { cwd, baseSha };
}
function candidate(baseSha: string, agent: 'codex' | 'claude', file: string, before: string, after: string): string {
  return `${agent} proposal\n<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n` +
    '</SIDETAB-CANDIDATE-V1>';
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('pair candidate protocol pins the base and forbids shared-checkout edits', () => {
  const sha = 'a'.repeat(40);
  const prompt = sidetabCandidateProtocolPrompt('change one thing', sha);
  expect(prompt).toContain(`base ${sha}`);
  expect(prompt).toContain('<SIDETAB-CANDIDATE-V1 base-sha=');
  expect(prompt).toContain('do not modify, stage, or commit files in the shared checkout');
  expect(sidetabCandidateProtocolPrompt('ordinary mission')).toBe('ordinary mission');
});

test('independent candidate files merge in a private index and leave the shared checkout untouched', () => {
  const { cwd, baseSha } = fixture();
  const before = [readFileSync(join(cwd, 'one.txt'), 'utf8'), readFileSync(join(cwd, 'two.txt'), 'utf8')];
  const result = reconcileClassicSidetabCandidatePatches({
    cwd,
    baseSha,
    codex: candidate(baseSha, 'codex', 'one.txt', 'one', 'codex-one'),
    claude: candidate(baseSha, 'claude', 'two.txt', 'two', 'claude-two'),
  });
  expect(result.status).toBe('merged');
  expect(result.patch).toContain('codex-one');
  expect(result.patch).toContain('claude-two');
  expect([readFileSync(join(cwd, 'one.txt'), 'utf8'), readFileSync(join(cwd, 'two.txt'), 'utf8')]).toEqual(before);
  expect(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
});

test('overlapping valid hunks remain unresolved with both original candidates intact in inputs', () => {
  const { cwd, baseSha } = fixture();
  const codex = candidate(baseSha, 'codex', 'one.txt', 'one', 'codex-choice');
  const claude = candidate(baseSha, 'claude', 'one.txt', 'one', 'claude-choice');
  const result = reconcileClassicSidetabCandidatePatches({ cwd, baseSha, codex, claude });
  expect(result.status).toBe('conflict');
  expect(result.conflictingPatchOrder).toEqual(['codex', 'claude']);
  expect(result.reason).toBeTruthy();
  expect(codex).toContain('codex-choice');
  expect(claude).toContain('claude-choice');
  expect(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
});

test('same-position insertions are conflicts even when sequential git apply could accept both', () => {
  const { cwd, baseSha } = fixture();
  const insertion = (agent: string, line: string) =>
    `${agent} proposal\n<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1,2 @@\n+${line}\n one\n` +
    '</SIDETAB-CANDIDATE-V1>';
  const result = reconcileClassicSidetabCandidatePatches({
    cwd, baseSha,
    codex: insertion('codex', 'codex inserted'),
    claude: insertion('claude', 'claude inserted'),
  });
  expect(result.status).toBe('conflict');
  expect(result.reason).toContain('overlap base changes');
  expect(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
});

test('subdirectory callers still produce repo-root-relative candidate patch paths', () => {
  const { cwd, baseSha } = fixture();
  const subdir = join(cwd, 'nested', 'child');
  mkdirSync(subdir, { recursive: true });
  const result = reconcileClassicSidetabCandidatePatches({
    cwd: subdir,
    baseSha,
    codex: candidate(baseSha, 'codex', 'one.txt', 'one', 'codex-one'),
    claude: candidate(baseSha, 'claude', 'two.txt', 'two', 'claude-two'),
  });
  expect(result.status).toBe('merged');
  expect(result.patch).toContain('diff --git a/one.txt b/one.txt');
  expect(result.patch).toContain('diff --git a/two.txt b/two.txt');
  expect(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
});

test('repository and object paths retain trailing spaces', () => {
  const { cwd: originalCwd, baseSha } = fixture();
  const cwd = `${originalCwd} `;
  renameSync(originalCwd, cwd);
  roots[roots.indexOf(originalCwd)] = cwd;
  const result = reconcileClassicSidetabCandidatePatches({
    cwd,
    baseSha,
    codex: candidate(baseSha, 'codex', 'one.txt', 'one', 'codex-one'),
    claude: candidate(baseSha, 'claude', 'two.txt', 'two', 'claude-two'),
  });
  expect(result.status).toBe('merged');
  expect(result.patch).toContain('codex-one');
  expect(result.patch).toContain('claude-two');
});

test('wrong base or malformed candidate fails closed', () => {
  const { cwd, baseSha } = fixture();
  const result = reconcileClassicSidetabCandidatePatches({
    cwd,
    baseSha,
    codex: candidate('b'.repeat(40), 'codex', 'one.txt', 'one', 'changed'),
    claude: 'no patch provided',
  });
  expect(result.status).toBe('unavailable');
  expect(result.reason).toContain('base SHA does not match');
  expect(result.reason).toContain('expected one SIDETAB-CANDIDATE-V1 block');
});
