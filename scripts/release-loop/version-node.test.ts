import { setDefaultTimeout, afterAll, afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { cutReleaseBranchForRun, main as versionNodeMain, nextDevVersion } from './version-node';
import { createTempGitRemote } from '../../src/ux-sim/temp-git-remote';
import { runGraph } from '../../src/graph-runner/runner';
import { parseOptions } from './gate-node';
import { runPrepare } from './prepare-node';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
let devBumpSourceRemote: string | undefined;
let devBumpSourceRoot: string | undefined;
afterAll(() => {
  if (devBumpSourceRoot) rmSync(devBumpSourceRoot, { recursive: true, force: true });
});

test('cut-branch prebuilds the cut-commit image for the same graph run before returning', () => {
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  const runId = 'gate-image-cut-run';
  const commit = 'c'.repeat(40);
  const calls: unknown[] = [];
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ runId, input: { version: '0.3.6', gateExecutor: 'pod',
    gateImagePin: 'cut-commit', gatePodPool: 'pool-a@aws1:1' }, outputs: {} });
  try {
    const output = versionNodeMain(['cut-branch', '--version', '0.3.6', '--base', 'a'.repeat(40), '--pick', 'b'.repeat(40)], process.cwd(), {
      cutBranch: () => ({ branch: 'release/0.3.6', commit, dryRun: false }),
      prebuildGateImage: (input) => {
        calls.push(input);
        return { outcome: 'built', digest: `sha256:${'d'.repeat(64)}`, eligiblePools: ['pool-a'] };
      },
    });
    expect(calls).toEqual([{ root: expect.any(String), repo: process.cwd(), runId, version: '0.3.6', commit, pool: 'pool-a@aws1:1' }]);
    expect(output).toMatchObject({ outcome: 'ok', commit, gateImagePrebuild: { outcome: 'built', eligiblePools: ['pool-a'] } });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VERSION_NODE_TEST_ROOT || process.cwd();
const stateFile = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
const fetchRefspec = String(args[2] || '').replace(/^\\+/, '');
const [fetchSource, fetchDestination] = fetchRefspec.split(':');
const fetchDestinationValid = !fetchDestination || fetchDestination === fetchSource.replace(/^refs\\/heads\\//, 'refs/remotes/origin/');
fs.appendFileSync(path.join(root, 'calls'), 'git ' + args.join(' ') + '\\n');
if (args[0] === 'show' && args[1] === 'origin/main:package.json') console.log(JSON.stringify({name:'fixture',version:state.version}));
else if (args[0] === 'show' && args[1] === (state.chosen || 'chosen-sha') + ':package.json') console.log(JSON.stringify({name:'fixture',version:state.chosenVersion || state.version}));
else if (args[0] === 'show' && String(args[1]).endsWith(':package.json')) console.log(JSON.stringify({name:'fixture',version:state.version}));
else if (args[0] === 'fetch' && args[1] === 'origin' && fetchSource.startsWith('refs/heads/release/') && fetchDestinationValid) { state.branchFetched = true; fs.writeFileSync(stateFile, JSON.stringify(state)); }
else if (args[0] === 'rev-parse' && args[1] === '--verify') {
  if (state.chosenMissing && !state.branchFetched) { console.error('unknown revision'); process.exit(128); }
  const ref = String(args[2] || '');
  if (state.revParse && ref in state.revParse) console.log(state.revParse[ref]);
  else console.log(state.chosen || 'chosen-sha');
}
else if (args[0] === 'merge-base') {
  const key = args.slice(1).join(' ');
  if (key === 'origin/main ' + state.branchTip) { console.log('base-sha'); process.exit(0); }
  if (state.mergeBaseOutput && key in state.mergeBaseOutput) console.log(state.mergeBaseOutput[key]);
  if (state.ancestor && key in state.ancestor) process.exit(state.ancestor[key] ? 0 : 1);
  process.exit(state.onMain === false ? 1 : 0);
}
else if (args[0] === 'log' && args.includes('--grep=^Cut from main ')) console.log(state.recordedCutBase ? (state.cutCommit || 'e'.repeat(40)) + '\x1fCut from main ' + state.recordedCutBase + '.' : '');
else if (args[0] === 'log') process.stdout.write(state.branchOwner ? 'Elanous-Release-Run: ' + state.branchOwner + '\\nElanous-Release-Attempt: 0\\n' : '');
else if (args[0] === 'rev-list' && args[1] === '--parents') {
  const sha = args.at(-1);
  const parents = (state.parents || {})[sha] || [];
  console.log([sha].concat(parents).join(' '));
}
else if (args[0] === 'cherry-pick') {
  if (state.cherryPickFails) { console.error(state.cherryPickError || 'simulated cherry-pick failure'); process.exit(1); }
  process.exit(0);
}
else if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === '--diff-filter=U') {
  for (const path of state.unmergedFiles || []) console.log(path);
}
else if (args[0] === 'show-ref') process.exit(state.localBranch ? 0 : 1);
else if (args[0] === 'ls-remote' && args[1] === '--tags') {
  const published = state.publishedVersions || (state.publishedTag ? [state.publishedVersion || '0.2.27'] : []);
  const requested = args.at(-1);
  for (const version of published) if (requested === 'refs/tags/v*' || requested === 'refs/tags/v' + version) console.log((state.publishedTag || 'b'.repeat(40)) + '\\trefs/tags/v' + version);
}
else if (args[0] === 'ls-remote') console.log(state.branchTip ? state.branchTip + '\\trefs/heads/release/0.2.4' : '');
else if (args[0] === 'rev-parse' && args[1] === 'origin/main') console.log(state.sha);
else if (args[0] === 'show' && args[1] === (state.cutSha || 'cut-sha') + ':release/next.md') {
  if (state.cutNextMd === undefined) { console.error('fatal: path not in cut'); process.exit(128); }
  process.stdout.write(state.cutNextMd);
}
else if (args[0] === 'worktree' && args[1] === 'add') {
  const tree = args[2] === '--detach' ? args[3] : args[4];
  fs.mkdirSync(tree, {recursive:true});
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({name:'fixture',version:state.version}, null, 2) + '\\n');
  fs.writeFileSync(path.join(tree, 'bun.lock'), JSON.stringify({workspaces:{'':{name:'fixture',version:state.version,dependencies:{}}}}));
  if (state.serverJson !== undefined) fs.writeFileSync(path.join(tree, 'server.json'), JSON.stringify(state.serverJson, null, 2) + '\\n');
  if (state.agentJson !== undefined) {
    const agentDir = path.join(tree, 'integrations', 'acp-registry', 'elanous');
    fs.mkdirSync(agentDir, {recursive:true});
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify(state.agentJson, null, 2) + '\\n');
  }
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
else if (args[0] === 'add') { /* staged in the caller's worktree */ }
else if (args[0] === 'commit') console.log('[cut ' + (state.cutHead || 'cut-head-sha') + ']');
else if (args[0] === 'rev-parse' && args[1] === 'HEAD') console.log(state.prHead || state.cutHead || 'cut-head-sha');
else if (args[0] === 'push') console.log('*\\t' + args[4] + '\\t[new branch]');
else { console.error('unexpected fake git ' + args.join(' ')); process.exit(2); }
`;
const fakeBun = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.VERSION_NODE_TEST_ROOT;
const stateFile = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), 'bun ' + args.join(' ') + '\\n');
const gh = (...argv) => {
  const result = spawnSync('gh', argv, { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
};
if (args[0] === 'install' && args[1] === '--frozen-lockfile') {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'bun.lock'), 'utf8'));
  if (state.install === 'fail' || lock.workspaces[''].version !== pkg.version) { console.error('frozen lockfile mismatch'); process.exit(1); }
  console.log('installed');
} else if (args[0] === 'bin/elanous.mjs' && args[1] === 'pr' && args[2] === 'land') {
  const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  const nextPath = path.join(process.cwd(), 'release', 'next.md');
  state.landedNextMd = fs.existsSync(nextPath) ? fs.readFileSync(nextPath, 'utf8') : null;
  const serverPath = path.join(process.cwd(), 'server.json');
  if (fs.existsSync(serverPath)) state.landedServerJson = JSON.parse(fs.readFileSync(serverPath, 'utf8'));
  const agentPath = path.join(process.cwd(), 'integrations', 'acp-registry', 'elanous', 'agent.json');
  state.landedAgentJson = fs.existsSync(agentPath) ? JSON.parse(fs.readFileSync(agentPath, 'utf8')) : null;
  state.landedAgentText = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf8') : null;
  if (args.includes('--hold')) {
    state.prHead = 'c'.repeat(40);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    gh('pr', 'create', '--draft', '--head', state.prHead);
    console.log('✓ upsert-ready: https://github.com/example/repo/pull/42');
    console.log('✓ hold: https://github.com/example/repo/pull/42');
    process.exit(0);
  }
  if (args.includes('--pr')) {
    const expectedHead = args[args.indexOf('--expected-head') + 1];
    gh('pr', 'merge', '42', '--squash', '--match-head-commit', expectedHead);
    Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    if (state.land === 'no-marker') process.exit(0);
  } else if (state.land === 'fail') { console.error('merge rejected'); process.exit(1); }
  else if (state.land === 'no-marker') { console.log('nothing merged'); process.exit(0); }
  if (state.land !== 'no-advance') {
    state.version = version;
    state.sha = 'merged-sha';
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  console.log('✓ merge: squash https://github.com/example/repo/pull/42 → origin/main');
} else if (args[0] === 'bin/elanous.mjs' && args[1] === 'gh' && args[2] === 'pr' && args[3] === 'ready') {
  gh('pr', 'ready', args[4]);
} else { console.error('unexpected fake bun ' + args.join(' ')); process.exit(2); }
`;

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VERSION_NODE_TEST_ROOT;
const stateFile = path.join(root, 'state.json');
const callsFile = path.join(root, 'gh-calls');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(callsFile, JSON.stringify(args) + '\\n');
if (args[0] !== 'pr') { console.error('unsupported fake gh command'); process.exit(2); }
if (args[1] === 'create' && args.includes('--draft')) {
  if (state.land === 'hold-fail') { console.error('draft PR create failed'); process.exit(1); }
  if (args[args.indexOf('--head') + 1] !== state.prHead) { console.error('draft head mismatch'); process.exit(1); }
  state.draft = true;
  state.sequence = [...(state.sequence || []), 'draft'];
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log('https://github.com/example/repo/pull/42');
} else if (args[1] === 'ready') {
  if (state.ready === 'fail') { console.error('ready refused'); process.exit(1); }
  if (!state.draft) { console.error('PR was not draft'); process.exit(1); }
  state.draft = false;
  if (state.ready === 'head-drift') state.remotePrHead = 'd'.repeat(40);
  state.sequence = [...(state.sequence || []), 'ready'];
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log('✓ ready: https://github.com/example/repo/pull/' + args[2]);
} else if (args[1] === 'merge') {
  const headIndex = args.indexOf('--match-head-commit');
  if (state.draft) { console.error('PR is draft'); process.exit(1); }
  if (headIndex < 0 || args[headIndex + 1] !== (state.remotePrHead || state.prHead)) { console.error('expected head mismatch'); process.exit(1); }
  if (state.land === 'fail') { console.error('pinned merge rejected'); process.exit(1); }
  if (state.land === 'no-marker') { console.error('merge marker missing from train'); console.log('nothing merged'); process.exit(0); }
  state.sequence = [...(state.sequence || []), 'merge'];
  state.mergedPrHead = state.prHead;
  state.prHead = null;
  fs.writeFileSync(stateFile, JSON.stringify(state));
} else { console.error('unexpected fake gh ' + args.join(' ')); process.exit(2); }
`;

function fixture(version: string, land = 'ok', install = 'ok', ready = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'version-node-test-'));
  scratch.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, source] of [['git', fakeGit], ['bun', fakeBun], ['gh', fakeGh]]) {
    const path = join(bin, name!);
    writeFileSync(path, source!);
    chmodSync(path, 0o755);
  }
  writeFileSync(join(root, 'state.json'), JSON.stringify({ version, sha: 'base-sha', land, install, ready }));
  writeFileSync(join(root, 'calls'), '');
  writeFileSync(join(root, 'gh-calls'), '');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, 'version-node.ts'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERSION_NODE_TEST_ROOT: root },
    });
    return { status: result.status, output: JSON.parse(result.stdout.trim().split('\n').at(-1)!), calls: readFileSync(join(root, 'calls'), 'utf8'), stderr: result.stderr, stdout: result.stdout };
  };
  return { root, run, ghCalls: () => readFileSync(join(root, 'gh-calls'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

test('nextDevVersion increments patch without changing major/minor', () => {
  expect(nextDevVersion('0.2.3')).toBe('0.2.4-dev.0');
  expect(nextDevVersion('1.9.99')).toBe('1.9.100-dev.0');
  expect(() => nextDevVersion('0.2.3-dev.0')).toThrow();
});

test('incident 0306: a new run adopts a verified stable cut from a failed gate run', () => {
  const { root } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const cut = 'a'.repeat(40);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, branchTip: cut, branchOwner: 'prior-cut-run', chosen: cut,
    chosenVersion: '0.2.4', onMain: false }));
  const priorRun = join(root, 'graph-runs', 'release-loop', 'prior-cut-run.json');
  mkdirSync(dirname(priorRun), { recursive: true });
  writeFileSync(priorRun, JSON.stringify({ graphId: 'release-loop', runId: 'prior-cut-run', status: 'failed',
    input: { version: '0.2.4', branchCut: true }, nodes: [{ nodeId: 'version-release', ok: true,
      output: JSON.stringify({ outcome: 'ok', version: '0.2.4', commit: cut, branch: 'release/0.2.4' }) }] }));

  const previousPath = process.env.PATH;
  const previousRoot = process.env.VERSION_NODE_TEST_ROOT;
  process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
  process.env.VERSION_NODE_TEST_ROOT = root;
  try {
    expect(cutReleaseBranchForRun(root, '0.2.4', { runId: 'new-run-after-gate-failure', root, freeze: () => null }))
      .toMatchObject({ outcome: 'ok', version: '0.2.4', commit: cut, branch: 'release/0.2.4', existing: true });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousRoot === undefined) delete process.env.VERSION_NODE_TEST_ROOT; else process.env.VERSION_NODE_TEST_ROOT = previousRoot;
  }
});

test('incident 0306: a live foreign run does not lend its cut to a replacement run', () => {
  const { root } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const cut = 'b'.repeat(40);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, branchTip: cut, branchOwner: 'live-cut-run',
    chosen: cut, chosenVersion: '0.2.4', onMain: false }));
  const liveRun = join(root, 'graph-runs', 'release-loop', 'live-cut-run.json');
  mkdirSync(dirname(liveRun), { recursive: true });
  writeFileSync(liveRun, JSON.stringify({ graphId: 'release-loop', runId: 'live-cut-run', status: 'running',
    input: { version: '0.2.4', branchCut: true }, nodes: [{ nodeId: 'version-release', ok: true,
      output: JSON.stringify({ outcome: 'ok', version: '0.2.4', commit: cut, branch: 'release/0.2.4' }) }] }));
  const previousPath = process.env.PATH;
  const previousRoot = process.env.VERSION_NODE_TEST_ROOT;
  process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
  process.env.VERSION_NODE_TEST_ROOT = root;
  try {
    expect(() => cutReleaseBranchForRun(root, '0.2.4', { runId: 'replacement-run', root, freeze: () => null }))
      .toThrow('refusing to replace a foreign release branch');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousRoot === undefined) delete process.env.VERSION_NODE_TEST_ROOT; else process.env.VERSION_NODE_TEST_ROOT = previousRoot;
  }
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
  expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).landedServerJson).toBeUndefined();
  expect(calls).toContain('git worktree remove --force');
  const tree = /^git worktree add -b \S+ (\S+) origin\/main$/m.exec(calls)?.[1];
  expect(tree).toBeString();
  expect(existsSync(tree!)).toBe(false);
});

test('version landing passes a reasoned freeze override only when graph input.forceFreeze is true', () => {
  for (const kind of ['release', 'dev-bump'] as const) for (const forceFreeze of [false, true]) {
    const { run } = fixture(kind === 'release' ? '0.2.4-dev.0' : '0.2.4');
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', forceFreeze } });
    try {
      const result = run(kind, '--json');
      expect(result.status).toBe(0);
      const landing = result.calls.split('\n').find((line) => line.startsWith('bun bin/elanous.mjs pr land ')
        && (kind === 'release' || line.includes('--pr ')));
      expect(landing).toBeDefined();
      if (forceFreeze) expect(landing).toContain(`--force-freeze release run version bump ${kind === 'release' ? '0.2.4' : '0.2.5-dev.0'}`);
      else expect(landing).not.toContain('--force-freeze');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
      else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    }
  }
});

test('release and dev-bump keep package.json and both server.json versions aligned when server.json exists', () => {
  for (const [kind, current, target] of [
    ['release', '0.2.4-dev.0', '0.2.4'],
    ['dev-bump', '0.2.4', '0.2.5-dev.0'],
  ]) {
    const { root, run } = fixture(current);
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, serverJson: {
      name: 'io.github.ElanvitalAI/elanous', version: current,
      packages: [{ registryType: 'npm', identifier: 'elanous', version: current, transport: { type: 'stdio' } }],
    } }));
    const { status, output } = run(kind, '--version', '0.2.4', '--json');
    expect(status).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', version: target });
    const landed = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    expect(landed.version).toBe(target);
    expect(landed.landedServerJson.version).toBe(landed.version);
    expect(landed.landedServerJson.packages[0].version).toBe(landed.version);
    expect(landed.landedServerJson.packages[0]).toMatchObject({ registryType: 'npm', identifier: 'elanous', transport: { type: 'stdio' } });
  }
});

test('release and dev-bump align package.json, server.json and ACP agent.json while preserving registry fields and tolerating a missing agent', () => {
  for (const [kind, current, target] of [
    ['release', '0.2.4-dev.0', '0.2.4'],
    ['dev-bump', '0.2.4', '0.2.5-dev.0'],
  ] as const) {
    for (const withAgent of [true, false]) {
      const { root, run } = fixture(current);
      const agent = {
        id: 'elanous', name: 'Elanous', icon: 'icon.svg', version: current,
        description: 'ACP integration', distribution: { npx: { package: `elanous@${current}`, args: ['--acp-server'] } },
      };
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state,
        serverJson: { name: 'elanous', version: current, packages: [{ version: current, identifier: 'elanous' }] },
        ...(withAgent ? { agentJson: agent } : {}),
      }));
      const { status, output } = run(kind, '--version', '0.2.4', '--json');
      expect(status).toBe(0);
      expect(output).toMatchObject({ outcome: 'ok', version: target,
        files: withAgent ? ['package.json', 'server.json', 'agent.json'] : ['package.json', 'server.json'] });
      const landed = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
      expect(landed.version).toBe(target);
      expect(landed.landedServerJson.version).toBe(target);
      expect(landed.landedServerJson.packages[0].version).toBe(target);
      if (withAgent) {
        expect(landed.landedAgentJson).toEqual({ ...agent, version: target,
          distribution: { npx: { ...agent.distribution.npx, package: `elanous@${target}` } } });
        expect(landed.landedAgentText).toBe(`${JSON.stringify(landed.landedAgentJson, null, 2)}\n`);
      } else {
        expect(landed.landedAgentJson).toBeNull();
      }
    }
  }
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

test('graph cutCommit selects the supplied main ancestor or release branch tip, without landing', () => {
  for (const onMain of [true, false]) {
    const { root, run } = fixture('0.2.5');
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, chosen: 'a'.repeat(40), chosenVersion: '0.2.4', onMain, branchTip: onMain ? '' : 'a'.repeat(40) }));
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', cutCommit: 'a'.repeat(40) } });
    try {
      const { status, output, calls } = run('release', '--json');
      expect(status).toBe(0);
      expect(output).toMatchObject({ outcome: 'ok', commit: 'a'.repeat(40), pr: null });
      expect(calls).not.toContain('worktree add');
      expect(calls).not.toContain('pr land');
    } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
  }
});

test('branch cut uses the CLI-verified main SHA when origin/main advances before version-release', () => {
  const pinned = 'a'.repeat(40);
  const advancedMain = 'b'.repeat(40);
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, sha: advancedMain,
    revParse: { [`${pinned}^{commit}`]: pinned, [`${advancedMain}^{commit}`]: advancedMain } }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', branchCut: true, branchCutBaseCommit: pinned } });
  try {
    const { status, output, calls } = run('release', '--json');
    expect(status).toBe(0);
    expect(output.outcome).toBe('ok');
    const worktreeAdd = calls.split('\n').find((line) => line.startsWith('git worktree add --detach '));
    expect(worktreeAdd).toEndWith(` ${pinned}`);
    expect(worktreeAdd).not.toEndWith(` ${advancedMain}`);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('an existing release branch remains reusable after its release commit reaches main', () => {
  const recordedBase = 'a'.repeat(40);
  const verifiedMain = 'b'.repeat(40);
  const tip = 'c'.repeat(40);
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, sha: verifiedMain, chosen: tip, chosenVersion: '0.2.4', branchTip: tip,
    recordedCutBase: recordedBase,
    cutCommit: 'e'.repeat(40),
    revParse: { [`refs/remotes/origin/release/0.2.4^{commit}`]: tip, [`${recordedBase}^{commit}`]: recordedBase, [`${'e'.repeat(40)}^`]: recordedBase },
    mergeBaseOutput: { [`origin/main ${tip}`]: tip },
    ancestor: { [`--is-ancestor ${recordedBase} ${verifiedMain}`]: true } }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', branchCut: true, branchCutBaseCommit: verifiedMain } });
  try {
    const { status, output } = run('release', '--json');
    expect(status).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', existing: true, commit: tip });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('an existing release branch remains reusable when main advances independently of its cut', () => {
  const recordedBase = 'a'.repeat(40);
  const verifiedMain = 'b'.repeat(40);
  const tip = 'c'.repeat(40);
  const cutCommit = 'e'.repeat(40);
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, sha: verifiedMain, chosen: tip, chosenVersion: '0.2.4', branchTip: tip,
    recordedCutBase: recordedBase, cutCommit,
    revParse: { [`refs/remotes/origin/release/0.2.4^{commit}`]: tip, [`${recordedBase}^{commit}`]: recordedBase, [`${cutCommit}^`]: recordedBase },
    mergeBaseOutput: { [`origin/main ${tip}`]: recordedBase },
    ancestor: { [`--is-ancestor ${recordedBase} ${verifiedMain}`]: true } }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', branchCut: true, branchCutBaseCommit: verifiedMain } });
  try {
    const { status, output } = run('release', '--json');
    expect(status).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', existing: true, commit: tip });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('an existing release branch refuses a cut record whose commit parent differs from its recorded SHA', () => {
  const recordedBase = 'a'.repeat(40);
  const actualFork = 'd'.repeat(40);
  const verifiedMain = 'b'.repeat(40);
  const tip = 'c'.repeat(40);
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, sha: verifiedMain, chosen: tip, chosenVersion: '0.2.4', branchTip: tip,
    recordedCutBase: recordedBase,
    cutCommit: 'e'.repeat(40),
    revParse: { [`refs/remotes/origin/release/0.2.4^{commit}`]: tip, [`${recordedBase}^{commit}`]: recordedBase, [`${'e'.repeat(40)}^`]: actualFork },
    mergeBaseOutput: { [`origin/main ${tip}`]: actualFork },
    ancestor: { [`--is-ancestor ${recordedBase} ${verifiedMain}`]: true } }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', branchCut: true, branchCutBaseCommit: verifiedMain } });
  try {
    const { status, output, calls } = run('release', '--json');
    expect(status).toBe(1);
    expect(output.error).toContain('parent');
    expect(calls).not.toContain('git push');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('an existing release branch refuses when its recorded base is not in the verified main history', () => {
  const recordedBase = 'a'.repeat(40);
  const verifiedMain = 'b'.repeat(40);
  const tip = 'c'.repeat(40);
  const cutCommit = 'e'.repeat(40);
  const { root, run } = fixture('0.2.4-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, sha: verifiedMain, chosen: tip, chosenVersion: '0.2.4', branchTip: tip,
    recordedCutBase: recordedBase, cutCommit,
    revParse: { [`refs/remotes/origin/release/0.2.4^{commit}`]: tip, [`${recordedBase}^{commit}`]: recordedBase, [`${cutCommit}^`]: recordedBase },
    mergeBaseOutput: { [`origin/main ${tip}`]: tip },
    ancestor: { [`--is-ancestor ${recordedBase} ${verifiedMain}`]: false } }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', branchCut: true, branchCutBaseCommit: verifiedMain } });
  try {
    const { status, output, calls } = run('release', '--json');
    expect(status).toBe(1);
    expect(output.error).toContain('is not an ancestor of the CLI-verified main commit');
    expect(calls).not.toContain('git push');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('release branch tip absent locally is fetched before selecting its commit', () => {
  const { root, run } = fixture('0.2.5');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, chosen: 'a'.repeat(40), chosenVersion: '0.2.4', chosenMissing: true, onMain: false, branchTip: 'a'.repeat(40) }));
  const { status, output, calls } = run('release', '--version', '0.2.4', '--cut-commit', 'a'.repeat(40), '--json');
  expect(status).toBe(0);
  expect(output.commit).toBe('a'.repeat(40));
  expect(calls).toContain('git fetch origin refs/heads/release/0.2.4');
});

test('chosen commit from version-release reaches cutoff, gate and prepare contexts', async () => {
  const { root, run } = fixture('0.2.5');
  const chosen = 'a'.repeat(40);
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, chosen, chosenVersion: '0.2.4' }));
  const released = run('release', '--version', '0.2.4', '--cut-commit', chosen, '--json');
  expect(released.output.commit).toBe(chosen);
  const seen: Record<string, string> = {};
  const graph = resolve(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const result = await runGraph(graph, { input: { version: '0.2.4', previousVersion: '0.2.3', cutCommit: chosen },
    deps: { root, runBash: async (body, opts) => {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: { cutCommit: string }; outputs: Record<string, { commit?: string }> };
      const node = body.includes('version-node.ts release') ? 'version-release' : body.includes('node-verdict.ts cutoff') ? 'cutoff'
        : body.includes('gate-node.ts') ? 'gate' : body.includes('prepare-node.ts') ? 'prepare' : 'other';
      if (node === 'version-release') seen.input = context.input.cutCommit;
      if (node === 'cutoff') seen.cutoff = context.outputs['version-release']?.commit ?? '';
      if (node === 'gate' || node === 'prepare') seen[node] = context.outputs['version-release']?.commit ?? '';
      return { exitCode: node === 'prepare' ? 1 : 0, stdout: JSON.stringify({ outcome: node === 'prepare' ? 'fail' : 'ok', verdict: node === 'prepare' ? 'fail' : 'pass', ...(node === 'version-release' ? { commit: released.output.commit } : {}) }) + '\n', stderr: '' };
    } } });
  expect(result.status).toBe('failed');
  expect(seen.input).toBe(chosen);
  expect(seen.cutoff).toBe(chosen);
  expect(seen.gate).toBe(chosen);
  expect(seen.prepare).toBe(chosen);
});

test('cutoff --cutoff, gate commit and prepare --source consume the chosen release output', () => {
  const sha = 'a'.repeat(40);
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', previousVersion: '0.2.3', cutCommit: 'b'.repeat(40) },
    outputs: { 'version-release': { outcome: 'ok', commit: sha }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' } } });
  try {
    const gate = parseOptions(['--json'], process.env);
    expect(gate).toMatchObject({ commit: sha });
    const commands: string[] = [];
    const prepared = runPrepare((command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      return command === 'git' ? { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
        : { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.4', sourceCommit: sha, distDir: join(args[args.indexOf('--out') + 1]!, 'dist') } }), stderr: '' };
    });
    expect(prepared.commit).toBe(sha);
    expect(commands[1]).toContain(`--source ${sha}`);
    const root = mkdtempSync(join(tmpdir(), 'release-cutoff-runner-'));
    scratch.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'bun');
    writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(fake, 0o755);
    const cutoff = spawnSync(process.execPath, [resolve(import.meta.dir, 'node-verdict.ts'), 'cutoff'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(cutoff.status).toBe(2);
    expect(JSON.parse(readFileSync(join(root, 'args.json'), 'utf8'))).toEqual(expect.arrayContaining(['--cutoff', sha]));
  } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
});

test('cutCommit rejects wrong package version and unrelated SHA with outcome error', () => {
  for (const stateOverride of [{ chosenVersion: '0.2.5', onMain: true }, { chosenVersion: '0.2.4', onMain: false }]) {
    const { root, run } = fixture('0.2.5');
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, chosen: 'a'.repeat(40), ...stateOverride }));
    const { status, output, calls } = run('release', '--version', '0.2.4', '--cut-commit', 'a'.repeat(40), '--json');
    expect(status).toBe(1);
    expect(output).toMatchObject({ outcome: 'error', commit: null, verdict: 'fail' });
    expect(output.error).toContain(stateOverride.onMain ? 'package.json version' : 'neither an ancestor');
    expect(calls).not.toContain('worktree add');
  }
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

test('chosen 0.2.4 cut survives the graph dev-bump after main has advanced to stable 0.2.5', () => {
  const { root, run } = fixture('0.2.5');
  const chosen = 'a'.repeat(40);
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, chosen, chosenVersion: '0.2.4' }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4', cutCommit: chosen } });
    const release = run('release', '--json');
    expect(release.status).toBe(0);
    expect(release.output).toMatchObject({ outcome: 'ok', commit: chosen, version: '0.2.4' });
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4' }, outputs: { 'version-release': { commit: chosen } } });
    const bump = run('dev-bump', '--json');
    expect(bump.status).toBe(0);
    expect(bump.output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.5', commit: 'base-sha', pr: null });
    expect(bump.calls).not.toContain('pr land');
    expect(bump.calls).not.toContain('worktree add');
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).toMatchObject({ version: '0.2.5', sha: 'base-sha' });
  } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
});

test('the chosen cut completes the fake release graph through dev-bump while advanced main stays unchanged', async () => {
  const { root, run } = fixture('0.2.5');
  const chosen = 'a'.repeat(40);
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, chosen, chosenVersion: '0.2.4' }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  const bumps: Array<{ output: { outcome: string; version: string; commit: string }; calls: string }> = [];
  try {
    const graph = resolve(import.meta.dir, '../../graphs/release/release-loop.yaml');
    const result = await runGraph(graph, { input: { version: '0.2.4', previousVersion: '0.2.3', cutCommit: chosen },
      deps: { root, runBash: async (body, opts) => {
        process.env.ELANOUS_GRAPH_CONTEXT = readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8');
        if (body.includes('version-node.ts release')) {
          const released = run('release', '--json');
          return { exitCode: released.status!, stdout: JSON.stringify(released.output) + '\n', stderr: released.stderr };
        }
        if (body.includes('version-node.ts dev-bump')) {
          const bump = run('dev-bump', '--json');
          bumps.push(bump);
          return { exitCode: bump.status!, stdout: JSON.stringify(bump.output) + '\n', stderr: bump.stderr };
        }
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'fake' }) + '\n', stderr: '' };
      } } });
    expect(result.status).toBe('done');
    expect(result.fanOuts?.['traffic-npm-published:ok']?.branches['version-dev-bump']?.status).toBe('done');
    expect(result.nodes.find((node) => node.nodeId === 'version-release')?.output).toContain(chosen);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]!.output).toMatchObject({ outcome: 'ok', version: '0.2.5', commit: 'base-sha' });
    expect(bumps[0]!.calls).not.toContain('pr land');
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).toMatchObject({ version: '0.2.5', sha: 'base-sha' });
  } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
});

test('dev-bump preserves a later stable main but rejects an older stable main', () => {
  for (const version of ['0.2.6', '0.3.0', '1.0.0']) {
    const { root, run } = fixture(version);
    const result = run('dev-bump', '--version', '0.2.4', '--json');
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ outcome: 'ok', version, commit: 'base-sha', pr: null });
    expect(result.calls).not.toContain('pr land');
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).version).toBe(version);
  }
  const older = fixture('0.2.3');
  const result = older.run('dev-bump', '--version', '0.2.4', '--json');
  expect(result.status).toBe(1);
  expect(result.output.error).toContain('origin/main version 0.2.3 is not 0.2.4');
  expect(result.calls).not.toContain('worktree add');
});

test('dev-bump rejects a source other than the released version', () => {
  const { run } = fixture('0.2.5-dev.1');
  const { status, output, calls } = run('dev-bump', '--version', '0.2.4', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', version: '0.2.5-dev.0', commit: null });
  expect(calls).not.toContain('pr land');
});

test('branch-cut dev-bump accepts main still on the released -dev line when release output names its branch', () => {
  const { run } = fixture('0.2.38-dev.0');
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.38' },
    outputs: { 'version-release': { outcome: 'ok', commit: 'cut-sha', branch: 'release/0.2.38' } } });
  try {
    const result = run('dev-bump', '--json');
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.39-dev.0', commit: 'merged-sha' });
    expect(result.calls).toContain('bun bin/elanous.mjs pr land --commit-message version: 0.2.39-dev.0');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('dev-bump does not infer branch-cut mode from a missing or unrelated release branch', () => {
  for (const output of [
    { commit: 'cut-sha' },
    { outcome: 'ok', commit: 'cut-sha', branch: 'release/0.2.37' },
    { outcome: 'error', commit: 'cut-sha', branch: 'release/0.2.38' },
  ]) {
    const { run } = fixture('0.2.38-dev.0');
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.38' },
      outputs: { 'version-release': output } });
    try {
      const result = run('dev-bump', '--json');
      expect(result.status).toBe(1);
      expect(result.output.error).toContain('origin/main version 0.2.38-dev.0 is not 0.2.38');
      expect(result.calls).not.toContain('pr land');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
      else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    }
  }
});

test('dev-bump preserves explicit branchCut input when main is still on the released -dev line', () => {
  const { run } = fixture('0.2.38-dev.0');
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.38', branchCut: true } });
  try {
    const result = run('dev-bump', '--json');
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.39-dev.0', commit: 'merged-sha' });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
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

test('dev-bump transitions draft PR through ready before pinned merge of the same head', () => {
  const { root, run, ghCalls } = fixture('0.2.4');
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4' } });
  try {
    const result = run('dev-bump', '--json');
    expect(result.output.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.5-dev.0', pr: 42 });
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    expect(state.sequence).toEqual(['draft', 'ready', 'merge']);
    expect(state.draft).toBe(false);
    expect(ghCalls()).toEqual([
      ['pr', 'create', '--draft', '--head', 'c'.repeat(40)],
      ['pr', 'ready', '42'],
      ['pr', 'merge', '42', '--squash', '--match-head-commit', 'c'.repeat(40)],
    ]);
    const calls = result.calls.split('\n');
    const draftAt = calls.findIndex((line) => line.includes('pr land --commit-message version: 0.2.5-dev.0') && line.includes('--hold'));
    const readyAt = calls.findIndex((line) => line.includes('gh pr ready 42'));
    const mergeAt = calls.findIndex((line) => line.includes('pr land --pr 42 --expected-head'));
    expect(draftAt).toBeGreaterThanOrEqual(0);
    expect(readyAt).toBeGreaterThan(draftAt);
    expect(mergeAt).toBeGreaterThan(readyAt);
    expect(calls[mergeAt]).toContain('c'.repeat(40));
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

function cloneDevBumpSourceSnapshot(sourceRoot: string, snapshotSource: string, sourceRemote: string, env: NodeJS.ProcessEnv = process.env): string {
  const snapshot = spawnSync('git', ['clone', '--bare', snapshotSource, sourceRemote], {
    cwd: sourceRoot, env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
  });
  if (snapshot.status !== 0 || snapshot.error) {
    rmSync(sourceRoot, { recursive: true, force: true });
    throw new Error(`could not cache dev-bump simulation source: ${snapshot.stderr}`);
  }
  return sourceRemote;
}

function cacheDevBumpSourceSnapshot(
  sourceRoot: string,
  snapshotSource: string,
  sourceRemote: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const cachedSourceRemote = cloneDevBumpSourceSnapshot(sourceRoot, snapshotSource, sourceRemote, env);
  devBumpSourceRoot = sourceRoot;
  devBumpSourceRemote = cachedSourceRemote;
}

function prepareTrackedCheckoutSnapshotIndex(project: string, indexPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runGit = (args: string[], env = baseEnv, input?: string): string => {
    const result = spawnSync('git', args, { cwd: project, env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error}`);
    return result.stdout.trim();
  };
  const runGitPaths = (args: string[], env = baseEnv): string[] => {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error}`);
    return result.stdout.split('\0').filter(Boolean);
  };
  const sourceHead = runGit(['rev-parse', 'HEAD']);
  const snapshotEnv = { ...baseEnv, GIT_INDEX_FILE: indexPath };
  runGit(['read-tree', sourceHead], snapshotEnv);
  // Reapply exactly the currently tracked checkout delta (staged plus unstaged) onto HEAD.
  // Disable rename detection so staged rename source and destination both reconcile the index.
  const trackedPaths = new Set(runGitPaths(['ls-files', '-z']));
  const assumeUnchangedPaths = runGitPaths(['ls-files', '-v', '-z'])
    .filter((entry) => /^[a-z] /.test(entry))
    .map((entry) => entry.slice(2));
  const changedPaths = new Set([
    ...runGitPaths(['diff', '--no-renames', '--cached', '--name-only', '-z', 'HEAD', '--']),
    ...runGitPaths(['diff-files', '--no-renames', '--name-only', '-z', '--']),
    // Check only assume-unchanged entries against our clean index; the caller's index hides their edits.
    ...(assumeUnchangedPaths.length
      ? runGitPaths(['diff-files', '--no-renames', '--name-only', '-z', '--', ...assumeUnchangedPaths.map((path) => `:(literal)${path}`)], snapshotEnv)
      : []),
  ]);
  const addPaths: string[] = [];
  const removePaths: string[] = [];
  for (const file of changedPaths) {
    const path = join(project, file);
    let pathExists = false;
    try { lstatSync(path); pathExists = true; } catch { /* a tracked deletion */ }
    if (trackedPaths.has(file) && pathExists) addPaths.push(`:(literal)${file}`);
    else removePaths.push(`:(literal)${file}`);
  }
  if (removePaths.length) runGit(['rm', '--cached', '--ignore-unmatch', '--', ...removePaths], snapshotEnv);
  if (addPaths.length) runGit(['add', '-f', '--', ...addPaths], snapshotEnv);
  return snapshotEnv;
}

test('source snapshot tree preserves staged and unstaged tracked changes, renames, deletions, and dangling links', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-bump-source-tree-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const run = (args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): string => {
    const result = spawnSync('git', args, { cwd: repo, env, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error}`);
    return result.stdout.trim();
  };
  run(['init', '-q']);
  run(['config', 'user.name', 'CENSUS test']);
  run(['config', 'user.email', 'census@example.invalid']);
  for (const [file, content] of Object.entries({
    'staged.txt': 'before staged\n',
    'unstaged.txt': 'before unstaged\n',
    'deleted.txt': 'remove me\n',
    'rename-from.txt': 'renamed content\n',
    'assume-unchanged.txt': 'before assume\n',
    'replace-me': 'file before directory replacement\n',
    ':(exclude)special.txt': 'before special\n',
    '.gitignore': 'ignored-new.txt\n',
  })) writeFileSync(join(repo, file), content);
  run(['add', '.']);
  run(['commit', '-qm', 'base']);

  run(['update-index', '--assume-unchanged', 'assume-unchanged.txt']);
  writeFileSync(join(repo, 'assume-unchanged.txt'), 'after assume\n');
  writeFileSync(join(repo, 'staged.txt'), 'after staged\n');
  run(['add', 'staged.txt']);
  writeFileSync(join(repo, 'unstaged.txt'), 'after unstaged\n');
  run(['rm', '-q', 'deleted.txt']);
  run(['mv', 'rename-from.txt', 'rename-to.txt']);
  run(['rm', '-q', 'replace-me']);
  mkdirSync(join(repo, 'replace-me'));
  writeFileSync(join(repo, 'replace-me', 'child.txt'), 'directory replacement\n');
  run(['add', '--all', '--', 'replace-me']);
  symlinkSync('missing-target', join(repo, 'dangling-link'));
  run(['add', 'dangling-link']);
  writeFileSync(join(repo, ':(exclude)special.txt'), 'after special\n');
  writeFileSync(join(repo, 'ignored-new.txt'), 'force tracked\n');
  run(['add', '-f', '--', 'ignored-new.txt']);

  const snapshotEnv = prepareTrackedCheckoutSnapshotIndex(repo, join(root, 'snapshot.index'), process.env);
  const tree = run(['write-tree'], undefined, snapshotEnv);
  expect(run(['show', `${tree}:assume-unchanged.txt`])).toBe('after assume');
  expect(run(['show', `${tree}:staged.txt`])).toBe('after staged');
  expect(run(['show', `${tree}:unstaged.txt`])).toBe('after unstaged');
  expect(spawnSync('git', ['cat-file', '-e', `${tree}:deleted.txt`], { cwd: repo }).status).not.toBe(0);
  expect(spawnSync('git', ['cat-file', '-e', `${tree}:rename-from.txt`], { cwd: repo }).status).not.toBe(0);
  expect(run(['ls-tree', tree, 'replace-me'])).toMatch(/^040000 tree /);
  expect(run(['show', `${tree}:replace-me/child.txt`])).toBe('directory replacement');
  expect(run(['show', `${tree}:rename-to.txt`])).toBe('renamed content');
  expect(run(['ls-tree', tree, 'dangling-link'])).toMatch(/^120000 blob /);
  expect(run(['show', `${tree}:dangling-link`])).toBe('missing-target');
  expect(run(['show', `${tree}::(exclude)special.txt`])).toBe('after special');
  expect(run(['show', `${tree}:ignored-new.txt`])).toBe('force tracked');
});

function runRealDevBumpCliScenario(failReady = false) {
  const project = resolve(import.meta.dir, '../..');
  const previousAuthorDate = process.env.GIT_AUTHOR_DATE;
  const previousCommitterDate = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
  process.env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
  const fixtureRemote = createTempGitRemote();
  if (previousAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
  else process.env.GIT_AUTHOR_DATE = previousAuthorDate;
  if (previousCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
  else process.env.GIT_COMMITTER_DATE = previousCommitterDate;
  scratch.push(fixtureRemote.root);
  const { checkout, remote, git, gitEnv } = fixtureRemote;
  const statePath = join(fixtureRemote.root, 'fake-gh-state.json');
  const callsPath = join(fixtureRemote.root, 'fake-gh-calls.jsonl');
  const fakeBin = join(fixtureRemote.root, 'fake-bin');
  mkdirSync(fakeBin);
  const fakeBunPath = join(fakeBin, 'bun');
  writeFileSync(fakeBunPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
// Reuse the preinstalled project dependencies; package installation is outside this CLI lifecycle contract.
if (args[0] === "install" && args.includes("--frozen-lockfile")) {
  const modules = path.join(process.cwd(), "node_modules");
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(${JSON.stringify(project)}, "node_modules"), modules, "dir");
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(process.execPath)}, args, { cwd: process.cwd(), stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  chmodSync(fakeBunPath, 0o755);
  const fakeSshPath = join(fakeBin, 'ssh-local-git-transport');
  writeFileSync(fakeSshPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const request = process.argv.at(-1) || '';
const remote = ${JSON.stringify(remote)};
const match = /^(git-upload-pack|git-receive-pack)\\s+['\"]?[^'\"]+['\"]?$/.exec(request);
if (!match) { console.error('unsupported local SSH transport request'); process.exit(2); }
const result = spawnSync(match[1], [remote], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  chmodSync(fakeSshPath, 0o755);
  const fakeGhPath = join(fakeBin, 'gh');
  writeFileSync(fakeGhPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const statePath = process.env.DEV_BUMP_FAKE_GH_STATE;
const callsPath = process.env.DEV_BUMP_FAKE_GH_CALLS;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const cwdHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim();
fs.appendFileSync(callsPath, JSON.stringify({ args, cwdHead }) + '\\n');
if (args[0] !== 'pr') process.exit(2);
if (args[1] === 'list') {
  if (args.includes('--jq')) console.log(state.head ? 'https://github.com/example/repo/pull/42' : '');
  else console.log(state.head ? JSON.stringify([{ url: 'https://github.com/example/repo/pull/42' }]) : '[]');
  process.exit(0);
}
if (args[1] === 'create') {
  state.head = cwdHead; state.number = 42; state.branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim();
  state.isDraft = args.includes('--draft'); state.state = 'OPEN';
  fs.writeFileSync(statePath, JSON.stringify(state)); console.log('https://github.com/example/repo/pull/42'); process.exit(0);
}
if (args[1] === 'ready') {
  if (state.failReady) { console.error('ready refused'); process.exit(1); }
  if (state.head !== cwdHead || !state.isDraft) { console.error('ready head/draft mismatch'); process.exit(1); }
  state.isDraft = false; fs.writeFileSync(statePath, JSON.stringify(state));
  console.log('https://github.com/example/repo/pull/42'); process.exit(0);
}
if (args[1] === 'view') {
  const jsonAt = args.indexOf('--json');
  const fields = jsonAt >= 0 ? args[jsonAt + 1].split(',') : [];
  const result = { headRefOid: state.head, state: state.state, isDraft: state.isDraft, headRefName: state.branch || 'version-dev-bump',
    baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: 'https://github.com/example/repo/pull/42', labels: [],
    headRepository: { nameWithOwner: 'example/repo' }, mergeCommit: state.state === 'MERGED' ? { oid: state.head } : null };
  if (args.includes('--jq')) {
    const expr = args[args.indexOf('--jq') + 1];
    if (expr === '.baseRefName') console.log(result.baseRefName);
    else if (expr === '.mergeable') console.log(result.mergeable);
    else if (expr.includes('mergeStateStatus')) console.log('MERGEABLE CLEAN');
    else console.log('');
  } else console.log(JSON.stringify(Object.fromEntries(fields.map((field) => [field, result[field]]))));
  process.exit(0);
}
if (args[1] === 'merge') {
  const pinned = args[args.indexOf('--match-head-commit') + 1];
  if (!state.head || state.head !== pinned || cwdHead !== pinned || state.isDraft) {
    console.error('pinned head mismatch'); process.exit(1);
  }
  const update = spawnSync('git', ['--git-dir', process.env.DEV_BUMP_FAKE_GH_REMOTE, 'update-ref', 'refs/heads/main', pinned], { encoding: 'utf8' });
  if (update.status !== 0) { process.stderr.write(update.stderr); process.exit(1); }
  state.state = 'MERGED'; fs.writeFileSync(statePath, JSON.stringify(state));
  console.log('✓ merged'); process.exit(0);
}
if (args[0] === 'api') process.exit(0);
console.error('unsupported fake gh: ' + args.join(' ')); process.exit(2);
`);
  chmodSync(fakeGhPath, 0o755);

  // Both real-CLI scenarios share one immutable source snapshot. Build its release-version
  // commit from the existing Git tree so retry setup does not copy ~27k files and run git add -A.
  if (!devBumpSourceRemote) {
    const runGit = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): string => {
      const result = spawnSync('git', args, { cwd: project, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error}`);
      return result.stdout.trim();
    };
    const snapshotIndex = join(fixtureRemote.root, 'source-snapshot.index');
    const snapshotEnv = prepareTrackedCheckoutSnapshotIndex(project, snapshotIndex, { ...process.env, ...gitEnv });
    const packageJson = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { version: string };
    packageJson.version = '0.2.4';
    const packageBlob = runGit(['hash-object', '-w', '--stdin'], snapshotEnv, `${JSON.stringify(packageJson, null, 2)}\n`);
    runGit(['update-index', '--cacheinfo', `100644,${packageBlob},package.json`], snapshotEnv);
    const publicExport = [
      'include:',
      '  - package.json',
      '  - server.json',
      '  - integrations/acp-registry/elanous/agent.json',
      'exclude: []',
      'replace: {}',
      '',
    ].join('\n');
    const exportBlob = runGit(['hash-object', '-w', '--stdin'], snapshotEnv, publicExport);
    runGit(['update-index', '--add', '--cacheinfo', `100644,${exportBlob},release/public-export.yaml`], snapshotEnv);
    const snapshotTree = runGit(['write-tree'], snapshotEnv);
    const snapshotCommit = runGit(['commit-tree', snapshotTree], {
      ...snapshotEnv,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    }, 'simulation source fixture\n');
    runGit(['push', remote, `${snapshotCommit}:refs/heads/census-source`], snapshotEnv);
    runGit(['--git-dir', remote, 'update-ref', 'refs/heads/main', snapshotCommit], snapshotEnv);
    const sourceRoot = mkdtempSync(join(tmpdir(), 'dev-bump-source-'));
    const sourceRemote = join(sourceRoot, 'source.git');
    cacheDevBumpSourceSnapshot(sourceRoot, remote, sourceRemote, { ...process.env, ...gitEnv });
  } else {
    const imported = spawnSync('git', ['--git-dir', remote, 'fetch', devBumpSourceRemote, '+refs/heads/main:refs/heads/main'], {
      cwd: fixtureRemote.root, env: { ...process.env, ...gitEnv }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
    });
    if (imported.status !== 0 || imported.error) throw new Error(`could not reuse dev-bump simulation source: ${imported.stderr}`);
  }
  git(checkout, ['remote', 'set-url', 'origin', 'git@github.com:example/repo.git']);
  gitEnv.GIT_SSH_COMMAND = fakeSshPath;
  gitEnv.GIT_ALLOW_PROTOCOL = 'file:ssh';
  git(checkout, ['config', 'core.sshCommand', fakeSshPath]);
  git(checkout, ['fetch', 'origin']);
  git(checkout, ['config', 'user.email', 'test@example.com']);
  git(checkout, ['config', 'user.name', 'Test User']);

  writeFileSync(statePath, JSON.stringify({ head: null, state: 'OPEN', isDraft: false, failReady }));
  writeFileSync(callsPath, '');
  const priorEnv = { ...process.env };
  const stateRoot = join(fixtureRemote.root, 'state');
  mkdirSync(stateRoot);
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  process.env.ELANOUS_STATE_DIR = stateRoot;
  process.env.ELANOUS_CONFIG_DIR = stateRoot;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4' } });
  process.env.DEV_BUMP_FAKE_GH_STATE = statePath;
  process.env.DEV_BUMP_FAKE_GH_CALLS = callsPath;
  process.env.DEV_BUMP_FAKE_GH_REMOTE = remote;
  for (const [key, value] of Object.entries(gitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.GIT_SSH;
  try {
    const ghPath = spawnSync('which', ['gh'], { encoding: 'utf8', env: process.env });
    if (ghPath.status !== 0 || ghPath.stdout.trim() !== fakeGhPath)
      throw new Error(`PATH resolved gh to ${ghPath.stdout.trim() || '(missing)'}, expected test fake ${fakeGhPath}`);
    const ghProbe = spawnSync('gh', ['pr', 'list', '--head', 'simulation-probe', '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'], {
      cwd: checkout, encoding: 'utf8', env: process.env,
    });
    if (ghProbe.status !== 0 || ghProbe.error) throw new Error(`fake-gh probe failed: ${ghProbe.stderr || ghProbe.error} (PATH=${process.env.PATH})`);
    const run = spawnSync(process.execPath, [resolve(import.meta.dir, 'version-node.ts'), 'dev-bump', '--json'], {
      cwd: checkout, encoding: 'utf8', env: process.env, timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
    });
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { outcome?: string; kind?: string; version?: string; pr?: number | null; error?: string; worktree?: string };
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; cwdHead: string });
    if (output.worktree) scratch.push(dirname(output.worktree));
    return { status: run.status, stderr: run.stderr, output, calls, state: JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown> & { head?: string }, mainPackage: git(checkout, ['show', 'origin/main:package.json']) };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
  }
}

test('source snapshot clone failure leaves the next real CLI scenario able to retry', () => {
  const savedSourceRoot = devBumpSourceRoot;
  const savedSourceRemote = devBumpSourceRemote;
  devBumpSourceRoot = undefined;
  devBumpSourceRemote = undefined;
  let failedSourceRoot = '';
  try {
    failedSourceRoot = mkdtempSync(join(tmpdir(), 'dev-bump-source-failure-'));
    expect(() => cacheDevBumpSourceSnapshot(
      failedSourceRoot, join(failedSourceRoot, 'missing-source.git'), join(failedSourceRoot, 'source.git'),
    )).toThrow('could not cache dev-bump simulation source:');
    expect(existsSync(failedSourceRoot)).toBe(false);
    expect(devBumpSourceRoot).toBeUndefined();
    expect(devBumpSourceRemote).toBeUndefined();
    const retry = runRealDevBumpCliScenario();
    if (retry.status !== 0) throw new Error(`dev-bump retry failed: ${JSON.stringify({ output: retry.output, stderr: retry.stderr })}`);
    expect(retry.status).toBe(0);
    expect(retry.output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.5-dev.0', pr: 42 });
  } finally {
    if (devBumpSourceRoot && devBumpSourceRoot !== savedSourceRoot) rmSync(devBumpSourceRoot, { recursive: true, force: true });
    devBumpSourceRoot = savedSourceRoot;
    devBumpSourceRemote = savedSourceRemote;
  }
}, 180_000);

test('dev-bump runs the real CLI draft, ready, and pinned merge path against only a fake GitHub boundary', () => {
  const { status, output, calls, state, mainPackage } = runRealDevBumpCliScenario();
  expect(status).toBe(0);
  expect(output).toMatchObject({ outcome: 'ok', kind: 'dev-bump', version: '0.2.5-dev.0', pr: 42 });
  const create = calls.find(({ args }) => args[1] === 'create');
  const ready = calls.find(({ args }) => args[1] === 'ready');
  const merge = calls.find(({ args }) => args[1] === 'merge');
  expect(create?.args).toContain('--draft');
  expect(ready?.args).toEqual(['pr', 'ready', '42']);
  expect(merge?.args.slice(0, 4)).toEqual(['pr', 'merge', '42', '--squash']);
  const pin = merge?.args[merge.args.indexOf('--match-head-commit') + 1];
  expect(pin).toMatch(/^[a-f0-9]{40}$/);
  expect(create?.cwdHead).toBe(pin);
  expect(ready?.cwdHead).toBe(pin);
  expect(merge?.cwdHead).toBe(pin);
  expect(state).toMatchObject({ head: pin, state: 'MERGED', isDraft: false });
  expect(mainPackage).toContain('0.2.5-dev.0');
}, 180_000);

test('dev-bump records a real CLI ready-stage refusal with rc and stderr from fake-gh', () => {
  const { status, output, calls, state } = runRealDevBumpCliScenario(true);
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', kind: 'dev-bump', pr: null });
  expect(output.error).toContain('dev-bump gh pr ready #42 failed (rc=1');
  expect(output.error).toContain('stderr tail «ready refused\n[gh] pr ready FAILED rc=1»');
  const create = calls.find(({ args }) => args[1] === 'create');
  const ready = calls.find(({ args }) => args[1] === 'ready');
  expect(create?.args).toContain('--draft');
  expect(ready?.args).toEqual(['pr', 'ready', '42']);
  expect(ready?.cwdHead).toBe(state.head);
  expect(calls.some(({ args }) => args[1] === 'merge')).toBe(false);
}, 180_000);

test('dev-bump stage errors name the failed draft, ready, or pinned land step with rc and stderr tail', () => {
  const draft = fixture('0.2.4', 'hold-fail');
  const draftResult = draft.run('dev-bump', '--version', '0.2.4', '--json');
  expect(draftResult.status).toBe(1);
  expect(draftResult.output.error).toContain('dev-bump pr land --hold failed (rc=1');
  expect(draftResult.output.error).toContain('stderr tail «draft PR create failed»');
  expect(draftResult.calls).not.toContain('gh pr ready 42');
  expect(draftResult.output.worktree).toBeString();
  expect(existsSync(draftResult.output.worktree!)).toBe(true);
  scratch.push(dirname(draftResult.output.worktree!));

  const ready = fixture('0.2.4', 'ok', 'ok', 'fail');
  const readyResult = ready.run('dev-bump', '--version', '0.2.4', '--json');
  expect(readyResult.status).toBe(1);
  expect(readyResult.output.error).toContain('dev-bump gh pr ready #42 failed (rc=1');
  expect(readyResult.output.error).toContain('stderr tail «ready refused»');
  expect(readyResult.calls).not.toContain('pr land --pr 42 --expected-head');
  expect(readyResult.output.worktree).toBeString();
  expect(existsSync(readyResult.output.worktree!)).toBe(true);
  scratch.push(dirname(readyResult.output.worktree!));

  const staleHead = fixture('0.2.4', 'ok', 'ok', 'head-drift');
  const staleHeadResult = staleHead.run('dev-bump', '--version', '0.2.4', '--json');
  expect(staleHeadResult.status).toBe(1);
  expect(staleHeadResult.output.error).toContain('dev-bump pinned pr land failed (rc=1');
  expect(staleHeadResult.output.error).toContain('stderr tail «expected head mismatch»');
  expect(staleHead.ghCalls().at(-1)).toEqual(['pr', 'merge', '42', '--squash', '--match-head-commit', 'c'.repeat(40)]);
  expect(staleHeadResult.output.worktree).toBeString();
  expect(existsSync(staleHeadResult.output.worktree!)).toBe(true);
  scratch.push(dirname(staleHeadResult.output.worktree!));

  const merge = fixture('0.2.4', 'fail');
  const mergeResult = merge.run('dev-bump', '--version', '0.2.4', '--json');
  expect(mergeResult.status).toBe(1);
  expect(mergeResult.output.error).toContain('dev-bump pinned pr land failed (rc=1');
  expect(mergeResult.output.error).toContain('stderr tail «pinned merge rejected»');
  expect(mergeResult.output.worktree).toBeString();
  expect(existsSync(mergeResult.output.worktree!)).toBe(true);
  scratch.push(dirname(mergeResult.output.worktree!));

  const noMarker = fixture('0.2.4', 'no-marker');
  const noMarkerResult = noMarker.run('dev-bump', '--version', '0.2.4', '--json');
  expect(noMarkerResult.status).toBe(1);
  expect(noMarkerResult.output.error).toContain('dev-bump pinned pr land failed (rc=0; merge marker missing');
  expect(noMarkerResult.output.error).toContain('output tail «nothing merged»');
  expect(noMarkerResult.output.worktree).toBeString();
  expect(existsSync(noMarkerResult.output.worktree!)).toBe(true);
  scratch.push(dirname(noMarkerResult.output.worktree!));
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

test('RELEASE-DEVBUMP-ALWAYS: main on the published previous line self-heals the stranded dev bump, then cuts', () => {
  for (const current of ['0.2.27-dev.0', '0.2.27']) {
    const { root, run } = fixture(current);
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, publishedTag: 'b'.repeat(40), publishedVersion: '0.2.27' }));
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.28', branchCut: true } });
    try {
      const result = run('release', '--json');
      expect(result.status).toBe(0);
      expect(result.output).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.2.28', commit: 'cut-head-sha', pr: null, branch: 'release/0.2.28' });
      // the stranded 0.2.27 dev bump landed first (main → 0.2.28-dev.0), then the release branch was cut from it
      expect(result.calls).toContain('git ls-remote --tags origin refs/tags/v0.2.27');
      expect(result.calls).toContain('pr land --commit-message version: 0.2.28-dev.0');
      expect(result.calls).toContain('git commit -m release: 0.2.28 -m Cut from main merged-sha.');
      expect(result.calls).toContain('git push --porcelain --force-with-lease=refs/heads/release/0.2.28: origin cut-head-sha:refs/heads/release/0.2.28');
      expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).toMatchObject({ version: '0.2.28-dev.0', sha: 'merged-sha' });
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
      else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    }
  }
});

test('RELEASE-DEVBUMP-ALWAYS: a published previous minor self-heals into the new minor dev line', () => {
  for (const current of ['0.2.29-dev.2', '0.2.29']) {
    const { root, run } = fixture(current);
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, publishedTag: 'b'.repeat(40), publishedVersion: '0.2.29' }));
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.3.0', branchCut: true } });
    try {
      const result = run('release', '--json');
      expect(result.status).toBe(0);
      expect(result.output).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.3.0', branch: 'release/0.3.0' });
      expect(result.calls).toContain('git ls-remote --tags origin refs/tags/v0.2.29');
      expect(result.calls).toContain('pr land --commit-message version: 0.3.0-dev.0');
      expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).toMatchObject({ version: '0.3.0-dev.0', sha: 'merged-sha' });
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
      else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    }
  }
});

test('RELEASE-DEVBUMP-ALWAYS: RC cuts heal to the stable dev line, not an rc dev version', () => {
  const { root, run } = fixture('0.2.27-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, publishedTag: 'b'.repeat(40), publishedVersion: '0.2.27' }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.28-rc.1', branchCut: true } });
  try {
    const result = run('release', '--json');
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.2.28-rc.1', branch: 'release/0.2.28-rc.1' });
    expect(result.calls).toContain('pr land --commit-message version: 0.2.28-dev.0');
    expect(result.calls).not.toContain('0.2.28-rc.1-dev.0');
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).version).toBe('0.2.28-dev.0');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('RELEASE-DEVBUMP-ALWAYS: an intervening published tag blocks cross-minor healing', () => {
  const { root, run } = fixture('0.2.27-dev.0');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, publishedVersions: ['0.2.27', '0.2.29'] }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.3.0', branchCut: true } });
  try {
    const result = run('release', '--json');
    expect(result.status).toBe(1);
    expect(result.output.error).toContain('origin/main version 0.2.27-dev.0 is not 0.3.0-dev.N');
    expect(result.calls).toContain('git ls-remote --tags --refs origin refs/tags/v*');
    expect(result.calls).not.toContain('pr land');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('RELEASE-DEVBUMP-ALWAYS: an unpublished previous line does not self-heal and the cut still fails', () => {
  const { root, run } = fixture('0.2.27-dev.0');
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.28', branchCut: true } });
  try {
    const result = run('release', '--json');
    expect(result.status).toBe(1);
    expect(result.output).toMatchObject({ outcome: 'error', kind: 'release', version: '0.2.28' });
    expect(result.output.error).toContain('origin/main version 0.2.27-dev.0 is not 0.2.28-dev.N');
    expect(result.calls).not.toContain('pr land');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
});

test('RELEASE-DEVBUMP-ALWAYS: a published tag alone does not heal a non-adjacent main version', () => {
  for (const current of ['0.2.26-dev.0', '0.2.29-dev.0']) {
    const { root, run } = fixture(current);
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, publishedTag: 'b'.repeat(40), publishedVersion: '0.2.27' }));
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.28', branchCut: true } });
    try {
      const result = run('release', '--json');
      expect(result.status).toBe(1);
      expect(result.output.error).toContain(`origin/main version ${current} is not 0.2.28-dev.N`);
      expect(result.calls).not.toContain('pr land');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
      else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    }
  }
});

const cutSha = 'c'.repeat(40);
const mainSha = 'b'.repeat(40);
const pickSha = 'd'.repeat(40);

/** RELEASE-APPEND-BASE-AUTO: stage the fake git so release/0.2.4 exists at cutSha whose first parent is mainSha. */
function cutBranchState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    branchTip: cutSha,
    revParse: { [`refs/remotes/origin/release/0.2.4^{commit}`]: cutSha, [`${cutSha}^{commit}`]: cutSha, [`${pickSha}^{commit}`]: pickSha },
    parents: { [cutSha]: [mainSha], [pickSha]: ['e'.repeat(40)] },
    ancestor: {
      [`--is-ancestor ${mainSha} origin/main`]: true,
      [`--is-ancestor ${pickSha} origin/main`]: true,
      [`--is-ancestor ${pickSha} ${mainSha}`]: false,
      [`--is-ancestor ${pickSha} ${cutSha}`]: false,
    },
    ...extra,
  };
}

test('RELEASE-APPEND-BASE-AUTO: cut-branch --append with base omitted resolves the main cut from the ledger record', () => {
  const { root, run } = fixture('0.2.4');
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, ...cutBranchState() }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4' }, outputs: { 'version-release': { commit: cutSha, branch: 'release/0.2.4' } } });
  try {
    const { status, output, calls, stdout } = run('cut-branch', '--append', '--pick', pickSha, '--dry-run', '--json');
    expect(status).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.2.4', commit: null, pr: null, branch: 'release/0.2.4' });
    expect(stdout).toContain(`release/0.2.4: ${cutSha} + ${pickSha} (append) (dry-run) · base ${mainSha}`);
    expect(calls).toContain(`git rev-list --parents -n 1 ${cutSha}`);
    expect(calls).toContain(`git cherry-pick ${pickSha}`);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
}, 60_000);

test('RELEASE-APPEND-BASE-AUTO: cut-branch --append with a cut commit --base corrects to its first parent with a notice', () => {
  const f = fixture('0.2.4');
  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(f.root, 'state.json'), 'utf8')), ...cutBranchState({
    ancestor: {
      [`--is-ancestor ${mainSha} origin/main`]: true,
      [`--is-ancestor ${pickSha} origin/main`]: true,
      [`--is-ancestor ${pickSha} ${mainSha}`]: false,
      [`--is-ancestor ${pickSha} ${cutSha}`]: false,
      [`--is-ancestor ${cutSha} origin/main`]: false,
    },
  }) }));
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.4' }, outputs: { 'version-release': { commit: cutSha, branch: 'release/0.2.4' } } });
  try {
    const { status, output, calls, stdout } = f.run('cut-branch', '--append', '--base', cutSha, '--pick', pickSha, '--dry-run', '--json');
    expect(status).toBe(0);
    expect(output).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.2.4', branch: 'release/0.2.4' });
    expect(stdout).toContain(`그 부모 ${mainSha} 를 쓰라`);
    expect(stdout).toContain(`· base ${mainSha}`);
    expect(calls).toContain(`git rev-list --parents -n 1 ${cutSha}`);
    expect(calls).toContain(`git cherry-pick ${pickSha}`);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
  }
}, 60_000);

test('RELEASE-APPEND-BASE-AUTO: cut-branch --append with no ledger and no resolvable parent keeps the verbatim refusal', () => {
  const f = fixture('0.2.4');
  const orphan = '9'.repeat(40);
  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(f.root, 'state.json'), 'utf8')), ...cutBranchState({
    branchTip: 'f'.repeat(40),
    revParse: { [`refs/remotes/origin/release/0.2.4^{commit}`]: 'f'.repeat(40) },
    parents: { ['f'.repeat(40)]: [orphan] },
    ancestor: { [`--is-ancestor ${orphan} origin/main`]: false },
  }) }));
  const { status, output } = f.run('cut-branch', '--append', '--version', '0.2.4', '--pick', pickSha, '--dry-run', '--json');
  expect(status).toBe(1);
  expect(output).toMatchObject({ outcome: 'error', kind: 'release', version: '0.2.4' });
  expect(output.error).toContain(`base ${orphan} is not an ancestor of origin/main`);
}, 60_000);

test('RELEASE-APPEND-BASE-AUTO: cut-branch without --append still requires --base', () => {
  const f = fixture('0.2.4');
  const { status, output } = f.run('cut-branch', '--version', '0.2.4', '--pick', pickSha, '--dry-run', '--json');
  expect(status).toBe(1);
  expect(output.error).toContain('--base is required without --append');
}, 60_000);
