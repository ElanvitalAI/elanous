import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tickLand } from '../land-graph/land-graph.js';
import { defaultLandDeps, ghInvocation, landToolPath, repoSlugFromUrl, resolveLandRepo } from './land-graph-cli.js';
import { invalidateOpenPrSnapshot } from '../kit/gh-governor/open-pr-snapshot.js';

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
    // GH-BUDGET-GOVERNOR: the list comes from the shared snapshot's one refresh — every page (limit 1000), no files field.
    expect(readFileSync(log, 'utf8')).toContain('pr list --state open --limit 1000 --json');
    expect(readFileSync(log, 'utf8')).not.toContain(',files,');
  });
});

test('same-head label change from gh re-judges a refused PR on the next tick', async () => {
  const json = join(nonRepo, 'pr.json');
  const fake = join(nonRepo, 'gh.sh');
  const org = join(nonRepo, 'org.yaml');
  writeFileSync(org, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
  const pr = { number: 40001, headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', title: 't', author: { login: 'tc' }, files: [{ path: 'src/x.ts' }], body: 'same body', labels: [] as Array<{ name: string }> };
  writeFileSync(fake, `#!/bin/sh\ncase "$*" in *labels*) ;; *) exit 2;; esac\ncase "$2" in list) printf '['; cat '${json}'; printf ']';; view) cat '${json}';; esac\n`);
  chmodSync(fake, 0o755);
  process.env.LAND_GRAPH_GH = fake;
  process.env.GH_REPO = 'acme/widget';
  writeFileSync(json, JSON.stringify(pr));
  let guards = 0;
  const d = defaultLandDeps({ stateRoot: nonRepo, mode: 'live', org: { path: org },
    receipt: () => ({ dir: '/receipt', head: pr.headRefOid, host: 'test', focused: ['x'], rawDir: '/raw' }),
    olderReceiptHead: () => null, focused: () => ({ pass: 1, fail: 0 }), security: () => [],
    judHold: () => null, staleRevert: () => { guards++; return { ok: false, why: 'test refusal' }; },
    post: () => {}, record: () => {},
  });
  await tickLand(d);
  await tickLand(d);
  expect(guards).toBe(1);
  pr.labels = [{ name: 'reviewed' }];
  writeFileSync(json, JSON.stringify(pr));
  invalidateOpenPrSnapshot(nonRepo, { slug: 'acme/widget' }); // the shared snapshot's TTL (60 s) has passed
  const result = await tickLand(d);
  expect(guards).toBe(2);
  expect(result.decisions[0]?.why).toContain('re-judge: context changed');
});

describe('land command PATH (11-26: launchd python3 = system 3.9 → land-name-diff-check TypeError → every live land STOP)', () => {
  test('existing package-manager bin dirs go first, no duplicates, the rest keeps its order', () => {
    const exists = (d: string) => d === '/opt/homebrew/bin';
    expect(landToolPath('/usr/bin:/bin:/opt/homebrew/bin', exists)).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(landToolPath(undefined, () => false)).toBe('');
    expect(landToolPath('/usr/bin', () => true)).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin');
    expect(landToolPath('/usr/bin::/bin', () => false)).toBe('/usr/bin::/bin'); // no package-manager dir → PATH untouched
    expect(landToolPath(':/usr/bin', exists)).toBe('/opt/homebrew/bin::/usr/bin'); // the empty (cwd) segment survives
  });
});
