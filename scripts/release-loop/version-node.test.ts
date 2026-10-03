import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nextDevVersion } from './version-node';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VERSION_NODE_TEST_ROOT;
const stateFile = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), 'git ' + args.join(' ') + '\\n');
if (args[0] === 'show' && args[1] === 'origin/main:package.json') console.log(JSON.stringify({name:'fixture',version:state.version}));
else if (args[0] === 'rev-parse' && args[1] === 'origin/main') console.log(state.sha);
else if (args[0] === 'show' && args[1] === (state.cutSha || 'cut-sha') + ':release/next.md') {
  if (state.cutNextMd === undefined) { console.error('fatal: path not in cut'); process.exit(128); }
  process.stdout.write(state.cutNextMd);
}
else if (args[0] === 'worktree' && args[1] === 'add') {
  const tree = args[4];
  fs.mkdirSync(tree, {recursive:true});
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({name:'fixture',version:state.version}, null, 2) + '\\n');
  fs.writeFileSync(path.join(tree, 'bun.lock'), JSON.stringify({workspaces:{'':{name:'fixture',version:state.version,dependencies:{}}}}));
  if (state.nextMd !== undefined) {
    fs.mkdirSync(path.join(tree, 'release'), {recursive:true});
    fs.writeFileSync(path.join(tree, 'release', 'next.md'), state.nextMd);
  }
} else if (args[0] === 'worktree' && args[1] === 'remove') {
  fs.rmSync(args[3], {recursive:true,force:true});
} else if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main') {
  state.fetches = (state.fetches || 0) + 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (state.fetches <= (state.fetchFailures || 0)) {
    console.error(state.fetchError || 'fatal: cannot lock ref refs/remotes/origin/main');
    process.exit(1);
  }
} else if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') console.log(state.remoteUrl || 'git@example.com:repo.git');
else { console.error('unexpected fake git ' + args.join(' ')); process.exit(2); }
`;
const fakeBun = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VERSION_NODE_TEST_ROOT;
const stateFile = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), 'bun ' + args.join(' ') + '\\n');
if (args[0] === 'install' && args[1] === '--frozen-lockfile') {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'bun.lock'), 'utf8'));
  if (state.install === 'fail' || lock.workspaces[''].version !== pkg.version) { console.error('frozen lockfile mismatch'); process.exit(1); }
  console.log('installed');
} else if (args[0] === 'bin/elanous.mjs' && args[1] === 'pr' && args[2] === 'land') {
  const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  const nextPath = path.join(process.cwd(), 'release', 'next.md');
  state.landedNextMd = fs.existsSync(nextPath) ? fs.readFileSync(nextPath, 'utf8') : null;
  if (state.land === 'fail') { console.error('merge rejected'); process.exit(1); }
  if (state.land === 'no-marker') { console.log('nothing merged'); process.exit(0); }
  if (state.land !== 'no-advance') {
    state.version = version;
    state.sha = 'merged-sha';
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  console.log('✓ merge: squash https://github.com/example/repo/pull/42 → origin/main');
} else { console.error('unexpected fake bun ' + args.join(' ')); process.exit(2); }
`;

function fixture(version: string, land = 'ok', install = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'version-node-test-'));
  scratch.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, source] of [['git', fakeGit], ['bun', fakeBun]]) {
    const path = join(bin, name!);
    writeFileSync(path, source!);
    chmodSync(path, 0o755);
  }
  writeFileSync(join(root, 'state.json'), JSON.stringify({ version, sha: 'base-sha', land, install }));
  writeFileSync(join(root, 'calls'), '');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, 'version-node.ts'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERSION_NODE_TEST_ROOT: root },
    });
    return { status: result.status, output: JSON.parse(result.stdout.trim().split('\n').at(-1)!), calls: readFileSync(join(root, 'calls'), 'utf8'), stderr: result.stderr };
  };
  return { root, run };
}

test('nextDevVersion increments patch without changing major/minor', () => {
  expect(nextDevVersion('0.2.3')).toBe('0.2.4-dev.0');
  expect(nextDevVersion('1.9.99')).toBe('1.9.100-dev.0');
  expect(() => nextDevVersion('0.2.3-dev.0')).toThrow();
});

test('release lands once from -dev.N, installs first, and returns the merged commit and PR', () => {
  const { root, run } = fixture('0.2.4-dev.0');
  const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
  expect(status).toBe(0);
  expect(output).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.2.4', commit: 'merged-sha', pr: 42,
    verdict: 'pass', summary: 'release 0.2.4 · merged-sha' });
  expect(calls).toContain('bun bin/elanous.mjs pr land --commit-message release: 0.2.4 --title release: 0.2.4 --body');
  expect(calls.indexOf('bun install --frozen-lockfile')).toBeLessThan(calls.indexOf('bun bin/elanous.mjs pr land'));
  expect(calls).toContain('git fetch origin main');
  expect(readFileSync(join(root, 'state.json'), 'utf8')).toContain('"version":"0.2.4"');
  expect(calls).toContain('git worktree remove --force');
  const tree = /^git worktree add -b \S+ (\S+) origin\/main$/m.exec(calls)?.[1];
  expect(tree).toBeString();
  expect(existsSync(tree!)).toBe(false);
});

test('fetch retries two transient failures then lands after the third attempt', () => {
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, fetchFailures: 2, fetchError: 'fatal: cannot lock ref refs/remotes/origin/main' }));
  const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
  expect(status).toBe(0);
  expect(output).toMatchObject({ outcome: 'ok', commit: 'merged-sha', pr: 42 });
  expect(calls.match(/^git fetch origin main$/gm)).toHaveLength(4); // three before land, one after
  expect(calls).toContain('git worktree remove --force');
});

test('exhausted fetch reports final stderr and safe remote/auth diagnostics without landing', () => {
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, fetchFailures: 3,
    fetchError: 'fatal: Authentication failed for remote', remoteUrl: 'https://secret@example.com/private' }));
  const previous = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/secret/socket/path';
  try {
    const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
    expect(status).toBe(1);
    expect(output.error).toContain('failed after 3 attempt(s)');
    expect(output.error).toContain('fatal: Authentication failed for remote');
    expect(output.error).toContain('remote URL kind: https; SSH_AUTH_SOCK present: true');
    expect(JSON.stringify(output)).not.toContain('/secret/socket/path');
    expect(JSON.stringify(output)).not.toContain('secret@example.com');
    expect(calls.match(/^git fetch origin main$/gm)).toHaveLength(3);
    expect(calls).toContain('git remote get-url origin');
    expect(calls).not.toContain('worktree add');
    expect(calls).not.toContain('pr land');
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
});

test('frozen install failure prevents landing and retains the worktree', () => {
  const { run } = fixture('0.2.4-dev.0', 'ok', 'fail');
  const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', commit: null, pr: null });
  expect(output.error).toContain('frozen lockfile mismatch');
  expect(existsSync(output.worktree)).toBe(true);
  scratch.push(dirname(output.worktree));
  expect(calls).not.toContain('pr land');
  expect(calls).not.toContain('worktree remove');
});

test('actual repository lockfile accepts bumped manifest with frozen install', () => {
  mkdirSync(resolve(import.meta.dir, '../../.elanous-test/scratch'), { recursive: true });
  const root = mkdtempSync(join(import.meta.dir, '../../.elanous-test/scratch/version-node-real-'));
  scratch.push(root);
  for (const name of ['package.json', 'bun.lock', 'bunfig.toml']) {
    copyFileSync(resolve(import.meta.dir, '../..', name), join(root, name));
  }
  const path = join(root, 'package.json');
  const text = readFileSync(path, 'utf8');
  const current = JSON.parse(text).version as string;
  writeFileSync(path, text.replace(`"version": "${current}"`, `"version": "${nextDevVersion(current.replace(/-dev\.\d+$/, ''))}"`));
  const installed = spawnSync(process.execPath, ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
  });
  expect(installed.status).toBe(0);
  expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toBe(readFileSync(resolve(import.meta.dir, '../../bun.lock'), 'utf8'));
}, 30_000);

test('already released version returns origin/main commit without landing', () => {
  const { run } = fixture('0.2.4');
  const { output, calls } = run('release', '--version', '0.2.4', '--json');
  expect(output).toMatchObject({ outcome: 'ok', commit: 'base-sha', pr: null });
  expect(calls).not.toContain('pr land');
  expect(calls).not.toContain('worktree add');
});

test('mismatched release source errors without opening a PR', () => {
  const { run } = fixture('0.2.5-dev.0');
  const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', kind: 'release', version: '0.2.4' });
  expect(calls).not.toContain('pr land');
  expect(calls).not.toContain('worktree add');
});

test('invalid dev-bump version still emits the final error JSON line', () => {
  const { run } = fixture('0.2.4');
  const { status, output, calls } = run('dev-bump', '--version', '01.2.3', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', kind: 'dev-bump', version: '01.2.3', commit: null });
  expect(calls).not.toContain('pr land');
});

test('dev-bump rejects a source other than the released version', () => {
  const { run } = fixture('0.2.5-dev.1');
  const { status, output, calls } = run('dev-bump', '--version', '0.2.4', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', version: '0.2.5-dev.0', commit: null });
  expect(calls).not.toContain('pr land');
});

test('dev-bump computes next patch from graph context, lands, then becomes idempotent', () => {
  const { root, run } = fixture('0.2.4');
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4' } });
  try {
    const first = run('dev-bump', '--json');
    expect(first.output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.5-dev.0', commit: 'merged-sha', pr: 42 });
    expect(first.calls).toContain('pr land --commit-message version: 0.2.5-dev.0');
    writeFileSync(join(root, 'calls'), '');
    const second = run('dev-bump', '--json');
    expect(second.output).toMatchObject({ outcome: 'ok', commit: 'merged-sha', pr: null });
    expect(second.calls).not.toContain('pr land');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('dev-bump removes released lines but keeps Target: later and the next.md skeleton in the landing', () => {
  const { root, run } = fixture('0.2.4');
  const nextMd = '# Next\n\nDescription of upcoming changes.\n\n## Feat\n\n- shipped. Documentation: none. Target: next.\n- future. Documentation: none. Target: later.\n\n## Fix\n\n- fixed. Documentation: none. Target: next.\n\nDocumentation: none.\n';
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, nextMd, cutNextMd: nextMd }));
  const { status } = run('dev-bump', '--version', '0.2.4', '--cut', 'cut-sha', '--json');
  expect(status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd)
    .toBe('# Next\n\nDescription of upcoming changes.\n\n## Feat\n\n- future. Documentation: none. Target: later.\n\n## Fix\n\n\nDocumentation: none.\n');
});

test('dev-bump keeps section prose and ### subheadings; only shipped list items (and their continuation lines) go', () => {
  const { root, run } = fixture('0.2.4');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state,
    nextMd: '# Next\n\nTop description.\n\n## Feat\n\nOld section prose.\n### Old subsection\n- shipped. Target: next.\n  continued shipped detail.\n- future. Target: later.\n  continued later detail.\n',
    cutNextMd: '# Next\n\n## Feat\n\n- shipped. Target: next.\n',
  }));
  expect(run('dev-bump', '--version', '0.2.4', '--cut', 'cut-sha', '--json').status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd)
    .toBe('# Next\n\nTop description.\n\n## Feat\n\nOld section prose.\n### Old subsection\n- future. Target: later.\n  continued later detail.\n');
});

test('dev-bump preserves a standalone Target: later line', () => {
  const { root, run } = fixture('0.2.4');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, nextMd: '# Next\n\n## Feat\nTarget: later\n- shipped. Target: next.\n', cutNextMd: '- shipped. Target: next.\n' }));
  expect(run('dev-bump', '--version', '0.2.4', '--cut', 'cut-sha', '--json').status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd).toBe('# Next\n\n## Feat\nTarget: later\n');
});

test('dev-bump with no next.md lands without creating the file', () => {
  const { root, run } = fixture('0.2.4');
  const { status } = run('dev-bump', '--version', '0.2.4', '--json');
  expect(status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd).toBeNull();
});

test('release does not reset next.md', () => {
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const nextMd = '# Next\n\n## Feat\n\n- shipped. Target: next.\n';
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, nextMd }));
  expect(run('release', '--version', '0.2.4', '--json').status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd).toBe(nextMd);
});

test('merge marker without an advanced origin/main is an error and retains the worktree', () => {
  const { run } = fixture('0.2.4-dev.0', 'no-advance');
  const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', commit: null, pr: null });
  expect(output.error).toContain('origin/main did not advance');
  expect(existsSync(output.worktree)).toBe(true);
  scratch.push(dirname(output.worktree));
  expect(calls).not.toContain('worktree remove');
});

for (const land of ['fail', 'no-marker']) {
  test(`pr land ${land} retains worktree and reports its path as error`, () => {
    const { run } = fixture('0.2.4-dev.0', land);
    const { status, output, calls } = run('release', '--version', '0.2.4', '--json');
    expect(status).toBe(1);
    expect(output).toMatchObject({ outcome: 'error', kind: 'release', version: '0.2.4', commit: null });
    expect(output.worktree).toBeString();
    expect(existsSync(output.worktree)).toBe(true);
    scratch.push(dirname(output.worktree));
    expect(calls).toContain('bun bin/elanous.mjs pr land --commit-message release: 0.2.4');
    expect(calls).not.toContain('worktree remove');
    if (land === 'no-marker') {
      expect(output.error).toContain('merge marker missing');
      expect(calls.match(/git fetch origin main/g)).toHaveLength(1);
    }
  });
}

test('dev-bump keeps next.md lines that landed after the cut (OP 10-02 must-fix) and removes only lines the cut carried', () => {
  const { root, run } = fixture('0.2.4');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state,
    cutNextMd: '# Next\n\n## Feat\n\n- shipped in the cut. Target: next.\n',
    nextMd: '# Next\n\n## Feat\n\n- shipped in the cut. Target: next.\n- landed after the cut. Target: next.\n',
  }));
  expect(run('dev-bump', '--version', '0.2.4', '--cut', 'cut-sha', '--json').status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd)
    .toBe('# Next\n\n## Feat\n\n- landed after the cut. Target: next.\n');
});

test('dev-bump without a known cut removes nothing from next.md and warns', () => {
  const { root, run } = fixture('0.2.4');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const nextMd = '# Next\n\n## Feat\n\n- shipped. Target: next.\n';
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, nextMd, cutNextMd: nextMd }));
  const result = run('dev-bump', '--version', '0.2.4', '--json');
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('next.md 비우기 건너뜀(cut-unknown)');
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd).toBe(nextMd);
});

test('dev-bump with a cut whose next.md cannot be read removes nothing and warns', () => {
  const { root, run } = fixture('0.2.4');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const nextMd = '# Next\n\n## Feat\n\n- shipped. Target: next.\n';
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, nextMd }));
  const result = run('dev-bump', '--version', '0.2.4', '--cut', 'cut-sha', '--json');
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('next.md 비우기 건너뜀(cut-next-md-unreadable)');
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedNextMd).toBe(nextMd);
});
