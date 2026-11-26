import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickLand } from '../land-graph/land-graph.js';
import { defaultLandDeps, ghInvocation, repoSlugFromUrl, resolveLandRepo } from './land-graph-cli.js';

// The land-graph trigger runs `land graph tick` with cwd = the installed package dir (not a git repo);
// a bare `gh pr list` there fails with «fatal: not a git repository». gh must never depend on the cwd.
const saved = { cwd: process.cwd(), gh: process.env.LAND_GRAPH_GH, repo: process.env.GH_REPO };
let nonRepo = '';
beforeEach(() => { nonRepo = realpathSync(mkdtempSync(join(tmpdir(), 'lg-nonrepo-'))); });
afterEach(() => {
  process.chdir(saved.cwd);
  for (const [k, v] of [['LAND_GRAPH_GH', saved.gh], ['GH_REPO', saved.repo]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('land graph gh target', () => {
  test('origin URL → owner/name (https · scp · .git)', () => {
    expect(repoSlugFromUrl('https://github.com/acme/widget.git\n')).toBe('acme/widget');
    expect(repoSlugFromUrl('git@github.com:acme/widget.git')).toBe('acme/widget');
    expect(repoSlugFromUrl('https://github.com/acme/widget')).toBe('acme/widget');
    expect(repoSlugFromUrl('/local/path')).toBeNull();
  });

  test('GH_REPO wins; else the repo root origin; else nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'lg-root-'));
    spawnSync('git', ['init', '-q', root]);
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git']);
    expect(resolveLandRepo({ env: { GH_REPO: 'o/n' }, defaultRoot: root })).toEqual({ root, slug: 'o/n' });
    expect(resolveLandRepo({ env: {}, cfgRepo: join(root, 'missing'), defaultRoot: root })).toEqual({ root, slug: 'acme/widget' });
    expect(resolveLandRepo({ env: {}, defaultRoot: join(root, 'missing') })).toEqual({ root: null, slug: null });
    expect(ghInvocation(['pr', 'list'], { root, slug: 'acme/widget' })).toEqual({ args: ['pr', 'list', '--repo', 'acme/widget'], cwd: root });
  });

  test('tick from a non-repo cwd passes --repo to every gh call', async () => {
    const log = join(nonRepo, 'gh.log');
    const fake = join(nonRepo, 'fake-gh.sh');
    // Fake gh: fails exactly like the real one when no --repo is given, else records argv and lists no PRs.
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\ncase " $* " in *" --repo acme/widget "*) echo '[]';; *) echo 'failed to run git: fatal: not a git repository' >&2; exit 1;; esac\n`);
    chmodSync(fake, 0o755);
    process.env.LAND_GRAPH_GH = fake;
    process.env.GH_REPO = 'acme/widget';
    process.chdir(nonRepo);
    const state = mkdtempSync(join(tmpdir(), 'lg-state-'));
    const r = await tickLand(defaultLandDeps({ stateRoot: state, mode: 'shadow', post: () => {}, record: () => {} }));
    expect(r.error).toBeUndefined();
    expect(r.decisions).toEqual([]);
    expect(readFileSync(log, 'utf8')).toContain('pr list --state open --limit 100 --json');
  });
});
