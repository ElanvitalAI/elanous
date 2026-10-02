import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

test('standalone cutoff reads first-parent git landings and writes an isolated manifest with JSON-only stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cutoff-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'release/public/docs'), { recursive: true });
  mkdirSync(state);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'release/public/docs/cli.md'), '## `elanous a`\n\n## `elanous b`\n');
  const baseline = commit(repo, 'baseline');
  mkdirSync(join(repo, 'docs/goals'), { recursive: true });
  writeFileSync(join(repo, 'docs/goals/x.md'), '---\nrelease-target: later\n---\n# Goal\n');
  const laterSha = commit(repo, 'deferred goal (#123)');
  mkdirSync(join(repo, 'src/cli'), { recursive: true });
  writeFileSync(join(repo, 'src/cli/foo.ts'), 'export const foo = true;\n');
  writeFileSync(join(repo, 'docs/goals/ready.md'), '---\nrelease-target: next\n---\n# Goal\n');
  writeFileSync(join(repo, 'release/public/docs/cli.md'), '## `elanous a`\n');
  const nextSha = commit(repo, 'ready goal');
  const script = resolve(import.meta.dir, 'cutoff.ts');
  const result = spawnSync('bun', [script, '--version', '9.9.9', '--baseline', baseline, '--cutoff', 'HEAD', '--json'], {
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_NEXUS_DIR: state },
  });
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json.baselineSource).toBe('flag');
  expect(json.baseline).toEqual({ ref: baseline, sha: baseline });
  expect(json.cutoff).toEqual({ sha: nextSha });
  expect(json.deferred).toContainEqual({ sha: laterSha, reason: 'release-target-later' });
  expect(result.stderr).toContain('조각 있음 0 / 착지 2');
  expect(json.in).toContainEqual({ sha: nextSha, title: 'ready goal', docs: 'present', line: 'ready goal', kind: 'unknown', note: 'missing' });
  expect(json.escalate).toEqual([{ kind: 'command-removed', command: 'elanous b' }]);
  expect(JSON.parse(readFileSync(join(state, 'release/9.9.9/manifest.json'), 'utf8'))).toEqual(json);

  git(repo, 'tag', 'v9.9.8', baseline);
  git(repo, 'tag', 'v9.9.7', baseline);
  git(repo, 'update-ref', 'refs/remotes/origin/main', nextSha);
  const defaultResult = spawnSync('bun', [script, '--version', '9.9.9', '--json'], {
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_NEXUS_DIR: state },
  });
  expect(defaultResult.status).toBe(0);
  const tagged = JSON.parse(defaultResult.stdout);
  expect(tagged.baselineSource).toBe('tag');
  expect(tagged.baseline).toEqual({ ref: 'v9.9.8', sha: baseline });
  expect(tagged.cutoff).toEqual({ sha: nextSha });
  expect(JSON.parse(readFileSync(join(state, 'release/9.9.9/manifest.json'), 'utf8'))).toEqual(tagged);
}, 30_000);

test('cutoff consumes the instance-root notes ledger for a PR-numbered landing', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cutoff-note-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'release/public/docs'), { recursive: true });
  mkdirSync(join(state, 'release/notes'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'release/public/docs/cli.md'), '## `elanous a`\n');
  const baseline = commit(repo, 'baseline');
  writeFileSync(join(repo, 'feature.txt'), 'feature');
  const sha = commit(repo, 'feature (#456)');
  writeFileSync(join(state, 'release/notes/456.json'), JSON.stringify({
    pr: 456, line: 'Ready for users', kind: 'feat', docs: { path: 'release/public/docs/cli.md' }, target: 'next', source: 'pr-body',
  }));
  const result = spawnSync('bun', [resolve(import.meta.dir, 'cutoff.ts'), '--version', '9.9.9', '--baseline', baseline, '--cutoff', 'HEAD', '--json'], {
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_NEXUS_DIR: state },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('조각 있음 1 / 착지 1');
  const json = JSON.parse(result.stdout);
  expect(json.in).toEqual([{ sha, title: 'feature', prNumber: 456, docs: 'present', line: 'Ready for users', kind: 'feat' }]);
  expect(JSON.parse(readFileSync(join(state, 'release/9.9.9/manifest.json'), 'utf8'))).toEqual(json);
}, 30_000);

test('defers an in-flight goal from another worktree or a relative path absent from the checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cutoff-running-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  const other = join(root, 'other');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'release/public/docs'), { recursive: true });
  mkdirSync(state);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'release/public/docs/cli.md'), '## `elanous a`\n');
  const baseline = commit(repo, 'baseline');
  mkdirSync(join(repo, 'docs/goals'), { recursive: true });
  writeFileSync(join(repo, 'docs/goals/x.md'), '---\nrelease-target: next\n---\n# Goal\n');
  const landingSha = commit(repo, 'active goal');
  git(repo, 'worktree', 'add', '-q', '-b', 'other-worktree', other);
  const runId = 'run-12345678-1234-1234-1234-123456789abc';
  mkdirSync(join(root, '.elanous/run-ledger'), { recursive: true });
  writeFileSync(join(root, '.elanous/run-ledger', `${runId}.jsonl`), JSON.stringify({
    runId, event: 'start', timestamp: new Date().toISOString(),
    data: { goalFile: join(other, 'docs/goals/x.md') },
  }) + '\n');
  const result = spawnSync('bun', [resolve(import.meta.dir, 'cutoff.ts'), '--version', '9.9.9', '--baseline', baseline, '--cutoff', 'HEAD', '--json'], {
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_NEXUS_DIR: state },
  });
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json.deferred).toContainEqual({ sha: landingSha, reason: 'run-in-flight' });
  expect(json.in).toEqual([]);
  expect(JSON.parse(readFileSync(join(state, 'release/9.9.9/manifest.json'), 'utf8'))).toEqual(json);

  writeFileSync(join(root, '.elanous/run-ledger', `${runId}.jsonl`), JSON.stringify({
    runId, event: 'start', timestamp: new Date().toISOString(),
    data: { goalFile: './docs/goals/../goals/x.md' },
  }) + '\n');
  git(repo, 'checkout', '--detach', '-q', baseline);
  expect(() => readFileSync(join(repo, 'docs/goals/x.md'))).toThrow();
  const relativeResult = spawnSync('bun', [resolve(import.meta.dir, 'cutoff.ts'), '--version', '9.9.9', '--baseline', baseline, '--cutoff', landingSha, '--json'], {
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_NEXUS_DIR: state },
  });
  expect(relativeResult.status).toBe(0);
  const relativeManifest = JSON.parse(relativeResult.stdout);
  expect(relativeManifest.cutoff).toEqual({ sha: landingSha });
  expect(relativeManifest.deferred).toContainEqual({ sha: landingSha, reason: 'run-in-flight' });
  expect(relativeManifest.in).toEqual([]);
  expect(JSON.parse(readFileSync(join(state, 'release/9.9.9/manifest.json'), 'utf8'))).toEqual(relativeManifest);
}, 30_000);

test('next.md lines added in range become IN lines tied to their landing; feat commits with no line fail as notes-empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cutoff-nextmd-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(join(repo, 'release/public/docs'), { recursive: true });
  mkdirSync(state);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'release/public/docs/cli.md'), '## `elanous a`\n');
  writeFileSync(join(repo, 'release/next.md'), '# Next\n\n## Feat\n\n## Fix\n');
  const baseline = commit(repo, 'baseline');
  writeFileSync(join(repo, 'release/next.md'), '# Next\n\n## Feat\n\n- feat — Setup offers Tailscale. Documentation: none. Target: next.\n\n## Fix\n');
  const first = commit(repo, 'setup (#10)');
  writeFileSync(join(repo, 'release/next.md'), '# Next\n\n## Feat\n\n- feat — Setup offers Tailscale. Documentation: none. Target: next.\n\n## Fix\n\n- No browser over SSH. Documentation: none. Target: next.\n');
  const second = commit(repo, 'ssh (#11)');
  const env = { ...process.env, HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_NEXUS_DIR: state };
  const run = (cutoff: string) => spawnSync('bun', [resolve(import.meta.dir, 'cutoff.ts'), '--version', '9.9.9', '--baseline', baseline, '--cutoff', cutoff, '--json'], { cwd: repo, encoding: 'utf8', timeout: 60_000, env });
  const result = run('HEAD');
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json.in.map((entry: { sha: string; kind: string; line: string }) => [entry.sha, entry.kind, entry.line])).toEqual([[first, 'feat', 'Setup offers Tailscale.'], [second, 'fix', 'No browser over SSH.']]);
  expect(json.fragments).toEqual({ byPr: 0, byNextMd: 2, unlinked: 0, unknown: 0 });
  expect(json.escalate).toEqual([]);

  writeFileSync(join(repo, 'release/next.md'), '# Next\n\n## Feat\n\n## Fix\n');
  commit(repo, 'reset notes');
  writeFileSync(join(repo, 'x.txt'), 'x');
  commit(repo, 'feat: something without a note');
  const empty = run('HEAD');
  expect(JSON.parse(empty.stdout).escalate).toContainEqual({ kind: 'notes-empty', featFixLandings: 1, nextMdLines: 0 });
}, 60_000);
