import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveUnit, runGraph } from '../../../src/graph-runner/runner';
import { parseGraphTemplateYaml } from '../../../src/self-implement/graph-yaml';

const unitPath = join(import.meta.dir, 'reflect.yaml');
// The release Pod source image may be a depth-1 checkout. Keep the ancestry
// fixture self-contained instead of requiring the checkout's HEAD^.
const source = mkdtempSync(join(tmpdir(), 'reflect-source-'));
const fixtureGitEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const fixtureGit = (...args: string[]) => execFileSync('git', args, {
  cwd: source,
  encoding: 'utf8',
  env: fixtureGitEnv,
}).trim();
execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: source, env: fixtureGitEnv });
const fixtureCommit = (message: string, date: string) => execFileSync('git', [
  '-c', 'user.name=Reflect Test',
  '-c', 'user.email=reflect-test@example.invalid',
  '-c', 'commit.gpgsign=false',
  'commit', '--allow-empty', '-m', message,
], {
  cwd: source,
  encoding: 'utf8',
  env: { ...fixtureGitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
});
fixtureCommit('reflect fixture base', '2000-01-01T00:00:00Z');
const priorCommit = fixtureGit('rev-parse', 'HEAD');
fixtureCommit('reflect fixture landed', '2000-01-02T00:00:00Z');
const commit = fixtureGit('rev-parse', 'HEAD');
afterAll(() => rmSync(source, { recursive: true, force: true }));

test('reflect@1 parses and resolves with the ask/context/prior envelope and bounded exits', () => {
  expect(parseGraphTemplateYaml(readFileSync(unitPath, 'utf8'), unitPath).errors).toEqual([]);
  const unit = resolveUnit('reflect@1', join(import.meta.dir, '..', '..', 'journey', 'ta-journey.yaml'));
  expect(unit.path).toBe(unitPath);
  expect(unit.template.unit).toEqual({ inputs: ['ask', 'context', 'prior'], outputs: ['result', 'evidence'], exits: ['done', 'wait', 'needs-human'] });
});

async function live(landedSha: string, imageCommit: string, attempts = 0, maxAttempts = 2,
  options: { installedCommit?: string; driftedLink?: boolean; spoofedPin?: string; forgedRootRecord?: boolean; escapedEntry?: boolean; priorResult?: { attempts: number } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reflect-unit-'));
  const installRoot = join(root, 'install');
  mkdirSync(installRoot);
  const versionDir = `versions/0.2.33-${(options.installedCommit ?? commit).slice(0, 12)}`;
  const target = join(installRoot, versionDir);
  mkdirSync(join(target, 'node_modules', 'elanous', 'bin'), { recursive: true });
  if (options.escapedEntry) {
    const escaped = join(root, 'stale-entry.mjs');
    writeFileSync(escaped, '// stale installed entry\n');
    symlinkSync(escaped, join(target, 'node_modules', 'elanous', 'bin', 'elanous.mjs'));
  } else {
    writeFileSync(join(target, 'node_modules', 'elanous', 'bin', 'elanous.mjs'), '// fake installed entry\n');
  }
  symlinkSync(options.driftedLink ? 'versions/elsewhere' : versionDir, join(installRoot, 'current'));
  if (options.driftedLink) mkdirSync(join(installRoot, 'versions', 'elsewhere'));
  writeFileSync(join(installRoot, 'install.json'), JSON.stringify({ versionDir, source, commit: options.forgedRootRecord ? commit : options.installedCommit ?? commit }));
  writeFileSync(join(target, 'install.json'), JSON.stringify({ versionDir, source, commit: options.installedCommit ?? commit }));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ harness: { imageCommit } }));
  try {
    const run = await runGraph(unitPath, { input: { ask: 'reflect landed change', context: { landedSha, installRoot, sourceRoot: source, configPath, imageCommit: options.spoofedPin, maxAttempts }, prior: { attempts, result: options.priorResult } }, deps: { root: join(root, 'graph-state') } });
    const row = run.nodes.find(n => n.nodeId === 'reflect');
    return { run, output: row?.output ? JSON.parse(row.output) : { debug: run, error: row?.error } };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('reflect live graph returns done only when installed current and image pin contain landing', async () => {
  const { run, output } = await live(commit, commit);
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['reflect', 'done']);
  expect(output).toMatchObject({ outcome: 'done', result: { reflected: true }, evidence: { landedSha: commit, installedCommit: commit, harnessImageCommit: commit } });
});

test('reflect verifies abbreviated config pin, ignoring a conflicting pin in graph input', async () => {
  const { run, output } = await live(commit, commit.slice(0, 12), 0, 2, { spoofedPin: priorCommit });
  expect(run.path).toEqual(['reflect', 'done']);
  expect(output).toMatchObject({ outcome: 'done', evidence: { harnessImageCommit: commit.slice(0, 12), pinCommit: commit } });
});

test('reflect waits and escalates when installed current is behind the landing', async () => {
  const first = await live(commit, commit, 0, 2, { installedCommit: priorCommit });
  expect(first.run.path).toEqual(['reflect', 'wait']);
  expect(first.output).toMatchObject({ result: { reason: 'not-installed-yet' } });
  const last = await live(commit, commit, 1, 2, { installedCommit: priorCommit });
  expect(last.run.path).toEqual(['reflect', 'needs-human']);
  expect(last.output).toMatchObject({ result: { reason: 'landed-sha-not-in-installed-current' } });
});

test('reflect refuses a forged root record over an older installed entry', async () => {
  const { run, output } = await live(commit, commit, 0, 2, { installedCommit: priorCommit, forgedRootRecord: true });
  expect(run.path).toEqual(['reflect', 'needs-human']);
  expect(output).toMatchObject({ outcome: 'needs-human', evidence: { failClosed: true } });
  expect(output.result.reason).toContain('installed version name does not match recorded commit');
});

test('reflect refuses an installed entry symlink escaping current', async () => {
  const { run, output } = await live(commit, commit, 0, 2, { escapedEntry: true });
  expect(run.path).toEqual(['reflect', 'needs-human']);
  expect(output).toMatchObject({ outcome: 'needs-human', evidence: { failClosed: true } });
  expect(output.result.reason).toContain('entry missing or points outside current');
});

test('reflect refuses a current symlink that disagrees with the install record', async () => {
  const { run, output } = await live(commit, commit, 0, 2, { driftedLink: true });
  expect(run.path).toEqual(['reflect', 'needs-human']);
  expect(output).toMatchObject({ outcome: 'needs-human', evidence: { failClosed: true } });
});

test('reflect retries finitely and then routes unconfirmed image pin to needs-human', async () => {
  const first = await live(commit, priorCommit, 0, 2);
  expect(first.run.path).toEqual(['reflect', 'wait']);
  expect(first.output).toMatchObject({ outcome: 'wait', result: { attempts: 1 }, evidence: { attempts: 1, maxAttempts: 2 } });
  // The next call carries the previous node result, not evidence; stale
  // top-level prior.attempts must not reset the bounded retry counter.
  const last = await live(commit, priorCommit, 0, 2, { priorResult: first.output.result });
  expect(last.run.path).toEqual(['reflect', 'needs-human']);
  expect(last.output).toMatchObject({ outcome: 'needs-human', result: { attempts: 2, reason: 'landed-sha-not-in-harness-image-pin' }, evidence: { attempts: 2 } });
});
